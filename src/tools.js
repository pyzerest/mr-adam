// Interaction: input dispatch, selection + drag with auto-mating, Blender
// style modal G/R, the transform gizmo, tube drawing, library placement,
// the mate tool and the wire tool.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { app, V, round, fmt, setTool, hint, toast, select, selParts, isSel } from './app.js';
import {
  partById, info, syncPart, addPart, removeParts, duplicateParts, commit, undo, redo,
  frameMatrix, matrixFrame, mateTarget, groupOf, applyMate, bestAngle, addMate, removeMates, beginMove, mountFrame, contactMate,
} from './doc.js';
import { buildPart, newTube, newPlate, tubeHoleXs } from './parts/parts.js';
import { LIB, PLATE_PRESETS, TUBE_PROFILES } from './parts/library.js';
import { setLabels } from './labels.js';
import {
  rt, rerouteOne, rerouteAll, snapToGrid, addWire, removeWires, usedPorts, portKey, portWorld, PORT_COLORS,
} from './wiring/wires.js';

const Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
const I4 = new THREE.Matrix4();
let vp, handles, markers, tc, proxy;

// ---- picking ---------------------------------------------------------------
function pickPart(e, skip) {
  for (const h of vp.hit(e, [vp.parts])) {
    let o = h.object;
    while (o && !o.userData.partId) o = o.parent;
    if (!o || !o.visible || skip?.has(o.userData.partId)) continue;
    const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : Z.clone();
    if (normal.dot(vp.raycaster.ray.direction) > 0) normal.negate();
    return { id: o.userData.partId, obj: o, point: h.point, normal, distance: h.distance };
  }
  return null;
}
function surface(e, skip) {
  const h = pickPart(e, skip);
  if (h) return { point: h.point, normal: h.normal, partId: h.id };
  return { point: vp.rayPlane(e, new THREE.Vector3(), Z), normal: Z.clone(), partId: null };
}
function snapOnPlane(p, n, step = 0.25) {
  const s = new THREE.Vector3(round(p.x, step), round(p.y, step), round(p.z, step));
  return s.addScaledVector(n, -s.clone().sub(p).dot(n));
}
function tangent(n) {
  if (Math.abs(n.z) > 0.9) return X.clone();
  return new THREE.Vector3().crossVectors(Z, n).normalize();
}
// parameter along the line (P + t u) closest to the mouse ray
function lineParam(P, u, ray) {
  const w = P.clone().sub(ray.origin), b = u.dot(ray.direction);
  const d = u.dot(w), e = ray.direction.dot(w), den = 1 - b * b;
  return Math.abs(den) < 1e-6 ? 0 : (b * e - d) / den;
}
const worldConnectors = (id) => {
  const obj = app.objs.get(id);
  return obj.userData.info.connectors.map((f) => ({
    part: id, f, p: V(f.p).applyMatrix4(obj.matrixWorld), z: V(f.z).transformDirection(obj.matrixWorld),
  }));
};

// ---- highlight -------------------------------------------------------------
const variants = new Map();
function variant(base, mode) {
  const k = base.uuid + mode;
  if (!variants.has(k)) {
    const m = base.clone();
    m.emissive = new THREE.Color(mode === 'sel' ? 0xff7a00 : 0xffffff);
    m.emissiveIntensity = mode === 'sel' ? 0.42 : 0.1;
    variants.set(k, m);
  }
  return variants.get(k);
}
let hoverId = null;
function updateHighlights() {
  for (const [id, obj] of app.objs) {
    const mode = isSel('part', id) ? 'sel' : id === hoverId ? 'hov' : '';
    if (obj.userData.hl === mode) continue;
    obj.userData.hl = mode;
    obj.traverse((m) => {
      if (!m.isMesh) return;
      m.userData.base ||= m.material;
      m.material = mode ? variant(m.userData.base, mode) : m.userData.base;
    });
  }
}

// ---- handles (tube ends, wire bends/pins) ----------------------------------
const hMat = (c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.95 });
const H = { tube: hMat(0xff9d2e), bend: hMat(0xffffff), pin: hMat(0x39d0ff), mid: hMat(0xbdbdbd) };
function rebuildHandles() {
  handles.clear();
  if (app.toolName !== 'select') return;
  const parts = selParts();
  if (app.sel.length === 1 && parts.length === 1) {
    const part = partById(parts[0]);
    if (part?.kind === 'tube') {
      const obj = app.objs.get(part.id);
      for (const end of [0, 1]) {
        const m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 16), H.tube);
        const dir = V([end ? 1 : -1, 0, 0]).transformDirection(obj.matrixWorld);
        m.position.copy(V([end ? part.length : 0, 0, 0]).applyMatrix4(obj.matrixWorld)).addScaledVector(dir, 0.9);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        m.userData = { h: 'tube', end, id: part.id, size: 16 };
        handles.add(m);
      }
    }
  }
  if (app.sel.length === 1 && app.sel[0].t === 'wire') {
    const w = app.doc.wires.find((x) => x.id === app.sel[0].id), r = rt.get(w?.id);
    if (!w || !r?.pts) return;
    const add = (pos, kind, data, size) => {
      const m = new THREE.Mesh(kind === 'pin' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.SphereGeometry(0.6, 12, 8), H[kind]);
      m.position.copy(pos);
      m.userData = { h: kind, wire: w.id, size, ...data };
      handles.add(m);
    };
    (w.way || []).forEach((p, i) => add(V(p), 'pin', { index: i }, 11));
    const near = (p) => (w.way || []).some((q) => V(q).distanceTo(p) < 0.4);
    for (let i = 2; i < r.pts.length - 2; i++) {
      const p = V(r.pts[i]);
      if (!near(p)) add(p, 'bend', { leg: r.legOf[i] }, 9);
      if (i < r.pts.length - 3) {
        const q = V(r.pts[i + 1]);
        if (p.distanceTo(q) > 2.5) add(p.clone().lerp(q, 0.5), 'mid', { leg: r.legOf[i + 1] }, 7);
      }
    }
  }
}
function scaleHandles() {
  for (const g of [handles, markers]) {
    for (const m of g.children) {
      if (m.userData.size) m.scale.setScalar(Math.max(0.05, vp.pixelSize(m.position) * m.userData.size));
    }
  }
}

function tubeEndDrag(ud, e0) {
  const part = partById(ud.id), obj = app.objs.get(ud.id);
  const O = obj.position.clone(), u = V([1, 0, 0]).transformDirection(obj.matrixWorld);
  const L0 = part.length, far = O.clone().addScaledVector(u, L0);
  const t0 = lineParam(O, u, vp.setRay(e0));
  return {
    move(e) {
      const dt = lineParam(O, u, vp.setRay(e)) - t0;
      const L = Math.max(0.5, round(ud.end ? L0 + dt : L0 - dt, 0.5));
      if (L === part.length) return;
      part.length = L;
      if (!ud.end) part.pos = far.clone().addScaledVector(u, -L).toArray();
      syncPart(part);
      rebuildHandles();
      tubeLabel(part);
    },
    end() { setLabels('tube'); commit(); app.emit('doc'); app.emit('wires-dirty'); app.emit('sel'); },
    cancel() { this.end(); },
  };
}
function tubeLabel(part) {
  const obj = app.objs.get(part.id);
  const n = part.holes ? tubeHoleXs(part.length, part.holes).length : 0;
  setLabels('tube', [{
    pos: V([part.length / 2, 0, 0]).applyMatrix4(obj.matrixWorld),
    text: `${fmt(part.length)}"` + (n ? ` · ${n} holes` : ''), cls: 'dim',
  }]);
}

function wireHandleDrag(ud) {
  const w = app.doc.wires.find((x) => x.id === ud.wire);
  let index = ud.index;
  if (ud.h !== 'pin') {
    index = Math.min(ud.leg, w.way.length);
    w.way.splice(index, 0, [0, 0, 0]);
  }
  const start = handles.children.find((m) => m.userData === ud).position.clone();
  w.way[index] = start.toArray();
  const n = vp.viewDir();
  // while dragging, show just the pin being moved
  handles.clear();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), H.pin);
  m.userData = { size: 11 };
  m.position.copy(start);
  handles.add(m);
  return {
    move(e) {
      const p = snapToGrid(vp.rayPlane(e, start, n));
      if (p.distanceTo(V(w.way[index])) < 1e-6) return;
      w.way[index] = p.toArray();
      m.position.copy(p);
      rerouteOne(w.id);
    },
    end() { rebuildHandles(); commit(); app.emit('wires'); },
    cancel() { this.end(); },
  };
}

// ---- dragging parts: pick up, slide, snap, auto-mate -----------------------
function partDrag(hit) {
  const session = beginMove(selParts()), moving = new Set(session.ids);
  const A = hit.id, objA = app.objs.get(A), startA = session.start.get(A);
  const mine = objA.userData.info.connectors.map((f) => ({ f, p: V(f.p).applyMatrix4(startA), z: V(f.z).transformDirection(startA) }));
  const others = [];
  for (const id of app.objs.keys()) if (!moving.has(id)) others.push(...worldConnectors(id));
  const tryContact = partById(A).kind !== 'tube';
  let pending = null;
  const ring = marker(0x52e07a);
  return {
    move(e) {
      const p = vp.rayPlane(e, hit.point, Z), d = p.sub(hit.point);
      if (!e.ctrlKey) d.set(round(d.x, 0.125), round(d.y, 0.125), 0);
      const delta = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
      session.apply(delta);
      pending = null; ring.visible = false;
      if (e.ctrlKey) return;
      // 1. connector-to-connector (hole to hole) snapping
      let best = null, bd = 0.6;
      for (const c of mine) {
        const cx = c.p.x + d.x, cy = c.p.y + d.y, cz = c.p.z;
        for (const o of others) {
          const dx = o.p.x - cx, dy = o.p.y - cy, dz = o.p.z - cz;
          if (Math.abs(dx) > bd || Math.abs(dy) > bd || Math.abs(dz) > bd) continue;
          const dist = Math.hypot(dx, dy, dz);
          if (dist < bd && c.z.dot(o.z) < -0.8) { bd = dist; best = { c, o }; }
        }
      }
      if (best) pending = { a: A, b: best.o.part, fa: best.c.f, fb: best.o.f, at: best.o.p };
      // 2. resting on a face: stick to it wherever it is dropped
      else if (tryContact) pending = contactMate(A, moving, 0.85);
      if (pending) {
        const m = { ...pending, angle: 0, offset: 0, flip: false };
        m.angle = pending.angle = bestAngle(m);
        const target = mateTarget(m, app.objs.get(m.b).matrixWorld);
        session.apply(target.multiply(objA.matrixWorld.clone().invert()).multiply(delta));
        ring.visible = true;
        ring.position.copy(pending.at);
      }
    },
    end() {
      ring.removeFromParent();
      let mate = null;
      if (pending) { const { at, ...m } = pending; mate = m; }
      session.end(mate);
    },
    cancel() { ring.removeFromParent(); session.cancel(); },
  };
}
function marker(color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), hMat(color));
  m.userData = { size: 7 };
  m.visible = false;
  m.renderOrder = 20;
  markers.add(m);
  return m;
}

// ---- select tool -----------------------------------------------------------
const selectTool = {
  hint: 'Click to select · drag a part to move it (it snaps and mates on its own) · G move · R rotate · S quick add · MMB orbit',
  enter() { hint(this.hint); rebuildHandles(); },
  exit() { hoverId = null; this.drag = this.pending = null; handles.clear(); },
  down(e) {
    const hh = vp.hit(e, [handles])[0];
    if (hh) {
      const ud = hh.object.userData;
      this.drag = ud.h === 'tube' ? tubeEndDrag(ud, e) : wireHandleDrag(ud);
      return;
    }
    const wh = app.showWires ? vp.hit(e, [vp.wires]).find((h) => h.object.userData.wireId) : null;
    const ph = pickPart(e);
    this.empty = false;
    if (wh && (!ph || wh.distance < ph.distance)) select({ t: 'wire', id: wh.object.userData.wireId }, e.shiftKey);
    else if (ph) {
      if (e.shiftKey) select({ t: 'part', id: ph.id }, true);
      else if (!isSel('part', ph.id)) select({ t: 'part', id: ph.id });
      if (isSel('part', ph.id)) this.pending = { x: e.clientX, y: e.clientY, hit: ph };
    } else this.empty = true;
  },
  move(e) {
    if (this.drag) return this.drag.move(e);
    if (this.pending) {
      if (Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > 4) {
        this.drag = partDrag(this.pending.hit);
        this.pending = null;
        handles.clear();
      }
      return;
    }
    if (e.buttons === 0) hoverId = pickPart(e)?.id || null;
  },
  up(e) {
    if (this.drag) { this.drag.end(); this.drag = null; rebuildHandles(); } else if (this.empty && !e.shiftKey) select([]);
    this.pending = null; this.empty = false;
  },
  cancel() {
    if (this.drag) { this.drag.cancel(); this.drag = null; rebuildHandles(); return true; }
    if (app.sel.length) { select([]); return true; }
    return false;
  },
  dbl(e) {
    const hh = vp.hit(e, [handles])[0];
    if (hh?.object.userData.h === 'pin') {
      const w = app.doc.wires.find((x) => x.id === hh.object.userData.wire);
      w.way.splice(hh.object.userData.index, 1);
      rerouteOne(w.id); rebuildHandles(); commit(); app.emit('wires');
      return;
    }
    const ph = pickPart(e);
    if (ph && partById(ph.id).kind === 'plate') setTool('sketch', { partId: ph.id });
  },
};

// ---- Blender-style modal grab / rotate -------------------------------------
const modal = {
  start(kind) {
    const ids = selParts();
    if (!ids.length || !app.mouse) return;
    this.prev = app.toolName;
    setTool('modal', { kind, ids });
  },
  enter({ kind, ids }) {
    this.kind = kind; this.axis = null; this.num = '';
    this.session = beginMove(ids);
    const box = new THREE.Box3();
    for (const id of ids) box.expandByPoint(app.objs.get(id).position);
    this.pivot = box.getCenter(new THREE.Vector3());
    this.e0 = app.mouse;
    this.move(app.mouse);
  },
  exit() { setLabels('modal'); },
  axisDir() { return this.axis ? V({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[this.axis]) : null; },
  move(e) {
    this.last = e;
    const a = this.axisDir(), n = parseFloat(this.num), typed = this.num !== '' && isFinite(n);
    let delta, text;
    if (this.kind === 'g') {
      let d;
      if (a) {
        const t = typed ? n : lineParam(this.pivot, a, vp.setRay(e)) - lineParam(this.pivot, a, vp.setRay(this.e0));
        d = a.clone().multiplyScalar(typed || e.ctrlKey ? t : round(t, 0.125));
      } else if (typed) d = new THREE.Vector3(n, 0, 0);
      else {
        const vd = vp.viewDir();
        d = vp.rayPlane(e, this.pivot, vd).sub(vp.rayPlane(this.e0, this.pivot, vd));
        if (!e.ctrlKey) d.set(round(d.x, 0.125), round(d.y, 0.125), round(d.z, 0.125));
      }
      delta = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
      text = `Move  ΔX ${fmt(d.x)}  ΔY ${fmt(d.y)}  ΔZ ${fmt(d.z)} in`;
    } else {
      const axis = a || vp.viewDir().negate();
      const c = vp.toScreen(this.pivot), r = vp.dom.getBoundingClientRect();
      const ang = (ev) => Math.atan2(-(ev.clientY - r.top - c.y), ev.clientX - r.left - c.x);
      let deg = typed ? n : ((ang(e) - ang(this.e0)) * 180 / Math.PI) * (axis.dot(vp.viewDir()) < 0 ? 1 : -1);
      if (!typed && !e.ctrlKey) deg = round(deg, 5);
      delta = new THREE.Matrix4().makeTranslation(this.pivot.x, this.pivot.y, this.pivot.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(axis, (deg * Math.PI) / 180))
        .multiply(new THREE.Matrix4().makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z));
      text = `Rotate  ${fmt(deg, 1)}°`;
    }
    this.session.apply(delta);
    hint(`${text}   ${this.axis ? 'along ' + this.axis.toUpperCase() : ''}   [X / Y / Z lock axis · type a value · click or Enter to confirm · Esc cancels]`);
  },
  finish(ok) {
    if (ok) this.session.end(); else this.session.cancel();
    setTool(this.prev === 'modal' ? 'select' : this.prev || 'select');
  },
  down() { this.finish(true); },
  up() {},
  cancel() { this.finish(false); return true; },
  key(e) {
    const k = e.key.toLowerCase();
    if ('xyz'.includes(k) && k.length === 1) this.axis = this.axis === k ? null : k;
    else if (/^[0-9.\-]$/.test(e.key)) this.num += e.key;
    else if (e.key === 'Backspace') this.num = this.num.slice(0, -1);
    else if (e.key === 'Enter') return this.finish(true), true;
    else if (e.key === 'Escape') return this.finish(false), true;
    else return true; // swallow everything else while modal
    this.move(this.last);
    return true;
  },
};

// ---- tube tool: click-drag to draw an extrusion ----------------------------
const tubeTool = {
  profile: '2x1',
  enter(o) {
    if (o.profile) this.profile = o.profile;
    this.part = null;
    hint(`${TUBE_PROFILES[this.profile].name}: click (or drag) to draw · length snaps to ½" and holes follow · Shift = straight up · Ctrl = free angle · Esc to finish`);
  },
  exit() { this.abort(); },
  abort() {
    if (this.part) removeParts([this.part.id]);
    this.part = null;
    setLabels('tube');
  },
  down(e) {
    if (this.part) return this.finish();
    const s = surface(e), pr = TUBE_PROFILES[this.profile];
    this.S = snapOnPlane(s.point, s.normal, 0.25).addScaledVector(s.normal, Math.abs(s.normal.z) > 0.7 ? pr.h / 2 : 0);
    this.at = { x: e.clientX, y: e.clientY };
    this.part = addPart({ ...newTube(this.profile, 0.5), pos: this.S.toArray() }, { silent: true });
    this.update(e);
  },
  move(e) { if (this.part) this.update(e); },
  up(e) { if (this.part && Math.hypot(e.clientX - this.at.x, e.clientY - this.at.y) > 6) this.finish(); },
  update(e) {
    let dir, len;
    if (e.shiftKey) {
      const t = lineParam(this.S, Z, vp.setRay(e));
      dir = new THREE.Vector3(0, 0, t < 0 ? -1 : 1); len = Math.abs(t);
    } else {
      const v = vp.rayPlane(e, this.S, Z).sub(this.S);
      len = v.length();
      let a = Math.atan2(v.y, v.x);
      if (!e.ctrlKey) a = round(a, Math.PI / 12);
      dir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    }
    const zr = Math.abs(dir.z) > 0.9 ? X : Z;
    const y = new THREE.Vector3().crossVectors(zr, dir).normalize(), z = new THREE.Vector3().crossVectors(dir, y);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, y, z));
    const p = this.part;
    p.length = Math.max(0.5, round(len, 0.5));
    p.quat = q.toArray();
    syncPart(p);
    tubeLabel(p);
  },
  finish() {
    const p = this.part;
    this.part = null;
    setLabels('tube');
    commit();
    app.emit('doc'); app.emit('wires-dirty');
    select({ t: 'part', id: p.id });
  },
  cancel() {
    if (this.part) { this.abort(); return true; }
    return false;
  },
};

// ---- place tool: drop a library part on any face ---------------------------
const placeTool = {
  enter(o) {
    this.rot = 0; this.hit = null;
    const preset = PLATE_PRESETS[o.preset];
    this.temp = preset ? newPlate(JSON.parse(JSON.stringify(preset.sketch)), { preset: o.preset }) : { kind: 'lib', def: o.def };
    this.ghost = buildPart({ ...this.temp, id: '_ghost' });
    this.ghost.visible = false;
    vp.overlay.add(this.ghost);
    this.mount = mountFrame(this.ghost.userData.info);
    hint(`Placing ${preset?.name || LIB[o.def].name}: click a face (or the floor) to drop it · R rotates 90° · Shift-click to place several · Esc cancels`);
    if (app.mouse && o.drag) this.move(app.mouse);
  },
  exit() { this.ghost?.removeFromParent(); this.ghost = null; },
  move(e) {
    const s = surface(e);
    const p = snapOnPlane(s.point, s.normal, 0.25);
    this.fs = { p: p.toArray(), z: s.normal.toArray(), x: tangent(s.normal).toArray() };
    this.hit = s;
    const m = mateTarget({ fa: this.mount, fb: this.fs, angle: this.rot }, I4);
    m.decompose(this.ghost.position, this.ghost.quaternion, this.ghost.scale);
    this.ghost.visible = true;
  },
  down(e) { this.place(e); },
  up() {},
  place(e) {
    this.move(e);
    const part = addPart({ ...JSON.parse(JSON.stringify(this.temp)), pos: this.ghost.position.toArray(), quat: this.ghost.quaternion.toArray() });
    if (this.hit.partId) {
      const b = app.objs.get(this.hit.partId);
      const fb = matrixFrame(b.matrixWorld.clone().invert().multiply(frameMatrix(this.fs)));
      addMate({ a: part.id, b: this.hit.partId, fa: this.mount, fb, angle: this.rot });
    }
    commit();
    app.emit('wires-dirty');
    if (!e.shiftKey) { setTool('select'); select({ t: 'part', id: part.id }); }
  },
  key(e) {
    if (e.key.toLowerCase() === 'r') { this.rot = (this.rot + 90) % 360; if (app.mouse) this.move(app.mouse); return true; }
    return false;
  },
  cancel() { setTool('select'); return true; },
};

// ---- mate tool -------------------------------------------------------------
const mateTool = {
  enter() {
    this.first = null; this.cand = null; this.dotsFor = null;
    this.dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x9fd0ff, size: 5, sizeAttenuation: false, depthTest: false }));
    this.dots.renderOrder = 15;
    markers.add(this.dots);
    this.ringA = marker(0x39d0ff); this.ringB = marker(0x52e07a);
    hint('Mate: click a connector point on the part you want to move, then the connector it should meet. Hole centres and faces light up as you hover.');
  },
  exit() { markers.clear(); setLabels('mate'); },
  move(e) {
    const h = pickPart(e);
    this.cand = null; this.ringB.visible = false;
    if (!h) { this.dots.visible = false; return; }
    const cs = worldConnectors(h.id);
    if (this.dotsFor !== h.id) {
      this.dotsFor = h.id;
      this.dots.geometry.dispose();
      this.dots.geometry = new THREE.BufferGeometry().setFromPoints(cs.map((c) => c.p));
      this.dots.visible = true;
    }
    let best = null, bd = Infinity;
    for (const c of cs) {
      const d = c.p.distanceTo(h.point) + (c.z.dot(h.normal) > 0.5 ? 0 : 100);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) { this.cand = best; this.ringB.visible = true; this.ringB.position.copy(best.p); }
  },
  down() {
    const c = this.cand;
    if (!c) return;
    if (!this.first) {
      this.first = c;
      this.ringA.visible = true; this.ringA.position.copy(c.p);
      hint('Mate: now click the connector on the other part.');
      return;
    }
    if (groupOf(this.first.part).has(c.part)) return toast('Those parts are already connected — delete the existing mate first.', 'warn');
    const m = { a: this.first.part, b: c.part, fa: this.first.f, fb: c.f, angle: 0, offset: 0, flip: false };
    m.angle = bestAngle(m);
    const mate = addMate(m);
    applyMate(mate);
    commit();
    this.first = null; this.ringA.visible = false;
    setTool('select');
    select({ t: 'mate', id: mate.id });
  },
  up() {},
  cancel() {
    if (this.first) { this.first = null; this.ringA.visible = false; return true; }
    return false;
  },
};

// ---- wire tool -------------------------------------------------------------
const wireTool = {
  enter() {
    this.first = null; this.hover = null;
    this.group = new THREE.Group();
    const used = usedPorts();
    for (const part of app.doc.parts) {
      for (const p of info(part.id)?.ports || []) {
        const ref = { part: part.id, port: p.id };
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), hMat(PORT_COLORS[p.type]));
        m.position.copy(portWorld(part.id, p.id).p);
        m.userData = { ref, port: p, part, size: used.has(portKey(ref)) ? 2.5 : 5, used: used.has(portKey(ref)) };
        m.renderOrder = 20;
        this.group.add(m);
      }
    }
    markers.add(this.group);
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.line.visible = false;
    markers.add(this.line);
    if (!this.group.children.length) toast('No electrical parts yet — add some from the library first.', 'warn');
    hint('Wire: click a port, then the port to connect it to. Small dots are ports already in use. The route is found automatically.');
  },
  exit() { markers.clear(); setLabels('port'); },
  scale() { for (const m of this.group.children) m.scale.setScalar(vp.pixelSize(m.position) * m.userData.size * (m === this.hover ? 1.5 : 1)); },
  move(e) {
    const h = vp.hit(e, [this.group])[0];
    this.hover = h?.object || null;
    if (this.hover) {
      const u = this.hover.userData;
      setLabels('port', [{ pos: this.hover.position, text: `${u.part.name} · ${u.port.name}${u.used ? ' (in use)' : ''}`, cls: 'tip' }]);
    } else setLabels('port');
    if (this.first) {
      const end = this.hover ? this.hover.position : vp.rayPlane(e, this.first.position, vp.viewDir());
      this.line.geometry.dispose();
      this.line.geometry = new THREE.BufferGeometry().setFromPoints([this.first.position, end]);
      this.line.visible = true;
    }
  },
  down() {
    const m = this.hover;
    if (!m) return;
    const u = m.userData;
    if (u.used) return toast('That port already has a wire. Delete the wire first to reuse it.', 'warn');
    if (!this.first) { this.first = m; return; }
    const a = this.first.userData;
    if (m === this.first) return;
    if (a.port.type !== u.port.type) return toast(`A ${a.port.name} port can't connect to ${u.port.name}.`, 'warn');
    const w = addWire(a.ref, u.ref, a.port.type, false);
    rerouteAll();
    commit();
    app.emit('doc');
    setTool('select');
    select({ t: 'wire', id: w.id });
  },
  up() {},
  cancel() {
    if (this.first) { this.first = null; this.line.visible = false; return true; }
    return false;
  },
};

// ---- commands --------------------------------------------------------------
export function deleteSelection() {
  if (!app.sel.length) return;
  const by = (t) => app.sel.filter((s) => s.t === t).map((s) => s.id);
  const parts = by('part'), mates = by('mate'), wires = by('wire');
  if (mates.length) removeMates(mates);
  if (wires.length) removeWires(wires);
  if (parts.length) removeParts(parts);
  commit();
}
export function duplicateSelection(grab = true) {
  const ids = selParts();
  if (!ids.length) return;
  const copies = duplicateParts(ids);
  select(copies.map((id) => ({ t: 'part', id })));
  if (grab && app.mouse) modal.start('g'); else commit();
}
export function frameSelection(all) {
  const box = new THREE.Box3();
  const ids = all || !selParts().length ? [...app.objs.keys()] : selParts();
  for (const id of ids) box.expandByObject(app.objs.get(id));
  vp.frameBox(box);
}
export function detachSelection() {
  const ids = selParts();
  removeMates(app.doc.mates.filter((m) => ids.includes(m.a) || ids.includes(m.b)).map((m) => m.id));
  commit();
}
export const startModal = (k) => modal.start(k);
export function setGizmoMode(mode) {
  app.gizmoMode = mode;
  if (mode !== 'off') tc.setMode(mode);
  app.emit('gizmo');
}

// ---- wiring it all up ------------------------------------------------------
export function initTools() {
  vp = app.vp;
  handles = new THREE.Group(); markers = new THREE.Group();
  handles.renderOrder = 30;
  vp.overlay.add(handles, markers);
  Object.assign(app.tools, { select: selectTool, modal, tube: tubeTool, place: placeTool, mate: mateTool, wire: wireTool });

  // transform gizmo (Onshape's triad): drags move the whole rigid group
  proxy = new THREE.Object3D();
  vp.scene.add(proxy);
  tc = new TransformControls(vp.camera, vp.dom);
  tc.setSpace('local'); tc.setSize(0.6);
  tc.setTranslationSnap(0.125); tc.setRotationSnap(THREE.MathUtils.degToRad(5));
  vp.scene.add(tc.getHelper());
  app.gizmoMode = 'off';
  let session = null, inv0 = null;
  tc.addEventListener('dragging-changed', (ev) => {
    if (ev.value) {
      session = beginMove(selParts());
      proxy.updateMatrixWorld(true);
      inv0 = proxy.matrixWorld.clone().invert();
    } else if (session) { session.end(); session = null; rebuildHandles(); }
  });
  tc.addEventListener('objectChange', () => {
    if (!session) return;
    proxy.updateMatrixWorld(true);
    session.apply(proxy.matrixWorld.clone().multiply(inv0));
  });

  vp.frameHooks.push(() => {
    updateHighlights();
    scaleHandles();
    if (app.tool === wireTool) wireTool.scale();
    tc.camera = vp.camera;
    const ids = selParts();
    const show = app.toolName === 'select' && ids.length > 0 && app.gizmoMode !== 'off' && !selectTool.drag && app.objs.has(ids[0]);
    if (show && !tc.dragging) {
      const o = app.objs.get(ids[0]);
      proxy.position.copy(o.position); proxy.quaternion.copy(o.quaternion);
      proxy.updateMatrixWorld(true);
    }
    if (show && !tc.object) tc.attach(proxy);
    if (!show && tc.object) tc.detach();
  });

  for (const ev of ['sel', 'doc', 'wires', 'moved', 'tool']) app.on(ev, () => { if (!selectTool.drag) rebuildHandles(); });

  initInput();
}

function initInput() {
  const dom = vp.dom;
  let nav = null, rmb = null, last = null;
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    app.mouse = e;
    document.activeElement?.blur?.();
    dom.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      nav = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit';
      e.preventDefault();
    } else if (e.button === 2) rmb = { x: e.clientX, y: e.clientY, moved: false, pan: e.ctrlKey || e.shiftKey };
    else if (e.button === 0) {
      if (tc.object && tc.axis) return; // the gizmo has it
      app.tool.down?.(e);
    }
  });
  dom.addEventListener('pointermove', (e) => {
    app.mouse = e;
    const dx = last ? e.clientX - last.x : 0, dy = last ? e.clientY - last.y : 0;
    last = { x: e.clientX, y: e.clientY };
    if (rmb && !rmb.moved && Math.hypot(e.clientX - rmb.x, e.clientY - rmb.y) > 4) { rmb.moved = true; nav = rmb.pan ? 'pan' : 'orbit'; }
    if (nav === 'orbit') vp.orbit(dx, dy);
    else if (nav === 'pan') vp.pan(dx, dy);
    else if (nav === 'zoom') vp.zoom(Math.exp(dy * 0.01));
    else if (!tc.dragging) app.tool.move?.(e);
  });
  dom.addEventListener('pointerup', (e) => {
    if (e.button === 2 && rmb) {
      // a right-click cancels whatever is in progress; otherwise it opens the menu
      const busy = app.toolName === 'select' ? !!selectTool.drag : true;
      if (!rmb.moved && !(busy && app.tool.cancel?.())) {
        const ph = pickPart(e);
        if (ph && app.toolName === 'select') {
          if (!isSel('part', ph.id)) select({ t: 'part', id: ph.id });
          app.emit('ctxmenu', e.clientX, e.clientY);
        }
      }
      rmb = null; nav = null;
      return;
    }
    if (nav) { nav = null; return; }
    if (e.button === 0) app.tool.up?.(e);
  });
  dom.addEventListener('dblclick', (e) => app.tool.dbl?.(e));
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    vp.zoom(Math.exp((e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY) * 0.0012));
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (app.tool.key?.(e)) { e.preventDefault(); return; }
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const done = () => e.preventDefault();
    if (e.key === 'Escape') { if (!app.tool.cancel?.()) setTool('select'); return done(); }
    if (mod && k === 'z') { e.shiftKey ? redo() : undo(); return done(); }
    if (mod && k === 'y') { redo(); return done(); }
    if ((mod || e.shiftKey) && k === 'd') { duplicateSelection(); return done(); }
    if (e.shiftKey && k === 'a') { app.emit('quick'); return done(); }
    if (mod) return;
    const view = { numpad1: 'front', numpad3: 'right', numpad7: 'top', digit1: 'front', digit3: 'right', digit7: 'top' }[e.code.toLowerCase()];
    const opposite = { front: 'back', right: 'left', top: 'bottom' };
    if (view) { vp.axisView(e.shiftKey ? opposite[view] : view); return done(); }
    if (e.code === 'Numpad9') { vp.setView(vp.theta + Math.PI, Math.PI - vp.phi); return done(); }
    if (e.code === 'Numpad5' || e.code === 'Digit5') { vp.toggleOrtho(); return done(); }
    if (e.code === 'NumpadDecimal' || k === 'f') { frameSelection(false); return done(); }
    if (e.key === 'Home') { frameSelection(true); return done(); }
    if (app.toolName === 'sketch') return;
    if (e.key === 'Delete' || e.key === 'Backspace' || k === 'x') { deleteSelection(); return done(); }
    if (k === 'g' || k === 'r') { modal.start(k); return done(); }
    if (k === 't') { setTool('tube'); return done(); }
    if (k === 'p') { setTool('sketch'); return done(); }
    if (k === 'm') { setTool('mate'); return done(); }
    if (k === 'w') { setTool('wire'); return done(); }
    if (k === 's') { app.emit('quick'); return done(); }
  });
}
