// Document model, scene sync, undo/redo, persistence, mates.
import * as THREE from 'three';
import { app, uid, select } from './app.js';
import { buildPart, defaultName } from './parts/parts.js';

const KEY = 'adamcad.doc.v1';
export const emptyDoc = () => ({ name: 'Untitled robot', parts: [], mates: [], wires: [], counters: {} });

export const partById = (id) => app.doc.parts.find((p) => p.id === id);
export const info = (id) => app.objs.get(id)?.userData.info;

// ---- scene sync ------------------------------------------------------------
export function syncPart(part) {
  const old = app.objs.get(part.id);
  if (old) disposeObj(old);
  const obj = buildPart(part);
  obj.position.fromArray(part.pos);
  obj.quaternion.fromArray(part.quat);
  obj.updateMatrixWorld(true);
  app.vp.parts.add(obj);
  app.objs.set(part.id, obj);
  return obj;
}
function disposeObj(obj) {
  obj.removeFromParent();
  obj.traverse((m) => m.geometry?.dispose());
}
export function syncAll() {
  for (const o of app.objs.values()) disposeObj(o);
  app.objs.clear();
  for (const p of app.doc.parts) syncPart(p);
  app.sel = app.sel.filter((s) => (s.t === 'part' ? partById(s.id) : s.t === 'mate'
    ? app.doc.mates.some((m) => m.id === s.id) : app.doc.wires.some((w) => w.id === s.id)));
  app.emit('doc'); app.emit('sel'); app.emit('wires-dirty');
}
export function writeTransform(id) {
  const o = app.objs.get(id), p = partById(id);
  p.pos = o.position.toArray();
  p.quat = o.quaternion.toArray();
}
export function setMatrix(id, m) {
  const o = app.objs.get(id);
  m.decompose(o.position, o.quaternion, o.scale);
  o.scale.set(1, 1, 1);
  o.updateMatrixWorld(true);
}

// ---- editing ---------------------------------------------------------------
export function addPart(part, { silent } = {}) {
  part.id = uid('p');
  const base = defaultName(part);
  const n = (app.doc.counters[base] = (app.doc.counters[base] || 0) + 1);
  part.name = `${base} ${n}`;
  part.pos ||= [0, 0, 0];
  part.quat ||= [0, 0, 0, 1];
  app.doc.parts.push(part);
  syncPart(part);
  if (!silent) app.emit('doc');
  return part;
}
export function removeParts(ids) {
  const d = app.doc, set = new Set(ids);
  d.parts = d.parts.filter((p) => !set.has(p.id));
  d.mates = d.mates.filter((m) => !set.has(m.a) && !set.has(m.b));
  d.wires = d.wires.filter((w) => !set.has(w.a.part) && !set.has(w.b.part));
  for (const id of ids) {
    const o = app.objs.get(id);
    if (o) disposeObj(o);
    app.objs.delete(id);
  }
  app.sel = app.sel.filter((s) => !(s.t === 'part' && set.has(s.id)));
  app.emit('doc'); app.emit('sel'); app.emit('wires-dirty');
}
export function duplicateParts(ids) {
  const map = new Map();
  for (const id of ids) {
    const src = partById(id);
    const copy = JSON.parse(JSON.stringify(src));
    addPart(copy, { silent: true });
    map.set(id, copy.id);
  }
  for (const m of [...app.doc.mates]) {
    if (map.has(m.a) && map.has(m.b)) app.doc.mates.push({ ...JSON.parse(JSON.stringify(m)), id: uid('m'), a: map.get(m.a), b: map.get(m.b) });
  }
  app.emit('doc');
  return [...map.values()];
}

// ---- undo / persistence ----------------------------------------------------
const hist = { stack: [], i: -1 };
export function commit() {
  const s = JSON.stringify(app.doc);
  if (hist.stack[hist.i] === s) return;
  hist.stack.length = hist.i + 1;
  hist.stack.push(s);
  if (hist.stack.length > 80) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  try { localStorage.setItem(KEY, s); } catch { /* storage unavailable */ }
  app.emit('history');
}
function restore(i) {
  if (i < 0 || i >= hist.stack.length) return;
  hist.i = i;
  app.doc = JSON.parse(hist.stack[i]);
  try { localStorage.setItem(KEY, hist.stack[i]); } catch { /* ignore */ }
  syncAll();
  app.emit('history');
}
export const undo = () => restore(hist.i - 1);
export const redo = () => restore(hist.i + 1);
export const canUndo = () => hist.i > 0;
export const canRedo = () => hist.i < hist.stack.length - 1;

export function loadDoc(doc) {
  app.doc = { ...emptyDoc(), ...doc };
  app.warnings = [];
  select([]);
  syncAll();
  commit();
}
export function loadSaved() {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s);
  } catch { /* ignore */ }
  return null;
}

// ---- mates -----------------------------------------------------------------
// A connector frame is {p, z, x}: origin, outward normal, in-plane reference.
export function frameMatrix(f) {
  const z = new THREE.Vector3().fromArray(f.z).normalize();
  const x = new THREE.Vector3().fromArray(f.x);
  x.addScaledVector(z, -x.dot(z));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(z, -z.x);
  if (x.lengthSq() < 1e-8) x.set(0, 1, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(f.p[0], f.p[1], f.p[2]);
}
export function matrixFrame(m) {
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  m.extractBasis(x, y, z);
  return { p: new THREE.Vector3().setFromMatrixPosition(m).toArray(), z: z.toArray(), x: x.toArray() };
}
const RX = new THREE.Matrix4().makeRotationX(Math.PI);

// World matrix part A must take for the mate to hold, given part B's matrix.
export function mateTarget(m, bWorld) {
  const t = bWorld.clone().multiply(frameMatrix(m.fb));
  if (!m.flip) t.multiply(RX);
  t.multiply(new THREE.Matrix4().makeRotationZ(((m.angle || 0) * Math.PI) / 180));
  t.multiply(new THREE.Matrix4().makeTranslation(0, 0, m.offset || 0));
  return t.multiply(frameMatrix(m.fa).invert());
}

// Everything rigidly reachable from a part through mates.
export function groupOf(id, skipMate) {
  const seen = new Set([id]), q = [id];
  while (q.length) {
    const c = q.pop();
    for (const m of app.doc.mates) {
      if (m === skipMate) continue;
      const o = m.a === c ? m.b : m.b === c ? m.a : null;
      if (o && !seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  return seen;
}
export function groupsOf(ids) {
  const all = new Set();
  for (const id of ids) for (const g of groupOf(id)) all.add(g);
  return [...all];
}

// Move the A side of a mate so the mate is satisfied.
export function applyMate(m) {
  const a = app.objs.get(m.a), b = app.objs.get(m.b);
  if (!a || !b) return;
  const delta = mateTarget(m, b.matrixWorld).multiply(a.matrixWorld.clone().invert());
  for (const id of groupOf(m.a, m)) {
    if (id === m.b) return; // closed loop: leave as is
  }
  for (const id of groupOf(m.a, m)) {
    setMatrix(id, delta.clone().multiply(app.objs.get(id).matrixWorld));
    writeTransform(id);
  }
  app.emit('wires-dirty');
}

// Pick the twist (multiple of 90deg) that needs the least rotation of A.
export function bestAngle(m) {
  const a = app.objs.get(m.a), b = app.objs.get(m.b);
  let best = 0, bestDot = -Infinity;
  const cur = new THREE.Quaternion().setFromRotationMatrix(a.matrixWorld);
  for (const ang of [0, 90, 180, 270]) {
    const q = new THREE.Quaternion().setFromRotationMatrix(mateTarget({ ...m, angle: ang }, b.matrixWorld));
    const d = Math.abs(q.dot(cur));
    if (d > bestDot) { bestDot = d; best = ang; }
  }
  return best;
}

export function addMate(m) {
  const mate = { id: uid('m'), type: 'fastened', angle: 0, offset: 0, flip: false, ...m };
  const n = (app.doc.counters.mate = (app.doc.counters.mate || 0) + 1);
  mate.name = `${mate.type[0].toUpperCase() + mate.type.slice(1)} ${n}`;
  app.doc.mates.push(mate);
  app.emit('doc');
  return mate;
}

// A fastened mate that simply freezes the current relative pose of two parts.
export function rigidMate(aId, bId) {
  const a = app.objs.get(aId), b = app.objs.get(bId);
  const fa = a.matrixWorld.clone().invert().multiply(b.matrixWorld).multiply(RX);
  return addMate({ a: aId, b: bId, fa: matrixFrame(fa), fb: { p: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } });
}

export function removeMates(ids) {
  app.doc.mates = app.doc.mates.filter((m) => !ids.includes(m.id));
  app.sel = app.sel.filter((s) => !(s.t === 'mate' && ids.includes(s.id)));
  app.emit('doc'); app.emit('sel');
}

// ---- moving parts ---------------------------------------------------------
// One rule everywhere (drag, G/R, gizmo, typed positions): moving a part takes
// along everything mounted on it and lifts it off whatever it was mounted to.
// If it ends up touching a face again, it is re-mated there automatically.
export const mountFrame = (inf) => inf.connectors.find((c) => c.z[2] < 0) || inf.connectors[0] || { p: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
const caster = new THREE.Raycaster();

// Is this part's mounting face sitting on (or within maxGap of) another part?
export function contactMate(id, moving, maxGap = 0.03) {
  const obj = app.objs.get(id), mount = mountFrame(obj.userData.info);
  const cp = new THREE.Vector3().fromArray(mount.p).applyMatrix4(obj.matrixWorld);
  const cz = new THREE.Vector3().fromArray(mount.z).transformDirection(obj.matrixWorld);
  caster.set(cp.clone().addScaledVector(cz, -0.75), cz);
  caster.far = 0.75 + maxGap;
  const statics = [...app.objs.entries()].filter(([k, o]) => !moving.has(k) && o.visible).map(([, o]) => o);
  const h = caster.intersectObjects(statics, true)[0];
  if (!h?.face || h.distance < 0.75 - Math.max(maxGap, 0.03)) return null;
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
  let o = h.object;
  while (o && !o.userData.partId) o = o.parent;
  if (!o || n.dot(cz) > -0.95) return null;
  const mx = new THREE.Vector3().fromArray(mount.x).transformDirection(obj.matrixWorld);
  const fw = frameMatrix({ p: h.point.toArray(), z: n.toArray(), x: mx.toArray() });
  return { a: id, b: o.userData.partId, fa: mount, fb: matrixFrame(o.matrixWorld.clone().invert().multiply(fw)), at: h.point };
}

export function beginMove(partIds) {
  const before = app.doc.mates;
  const detached = before.filter((m) => partIds.includes(m.a) && !partIds.includes(m.b));
  app.doc.mates = before.filter((m) => !detached.includes(m));
  const ids = groupsOf(partIds);
  const start = new Map(ids.map((id) => [id, app.objs.get(id).matrixWorld.clone()]));
  return {
    ids,
    start,
    apply(delta) { for (const id of ids) setMatrix(id, delta.clone().multiply(start.get(id))); },
    cancel() { for (const id of ids) setMatrix(id, start.get(id)); app.doc.mates = before; },
    // mate: an explicit new mate found while dragging (optional)
    end(mate) {
      for (const id of ids) writeTransform(id);
      if (mate) addMate(mate);
      const moving = new Set(ids), lost = [];
      for (const id of new Set(detached.map((m) => m.a))) {
        if (mate?.a === id) continue;
        const c = contactMate(id, moving);
        if (c) { const { at, ...m } = c; m.angle = bestAngle({ ...m, angle: 0 }); addMate(m); } else lost.push(partById(id).name);
      }
      if (lost.length) app.emit('toast', `${lost.join(', ')} lifted off ${lost.length > 1 ? 'their mounts' : 'its mount'} — drop it on a face or hole to re-attach (Ctrl+Z to undo).`, '');
      app.emit('doc'); app.emit('wires-dirty'); commit(); app.emit('moved');
    },
  };
}
