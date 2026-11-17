// Wiring runtime: builds the routing grid from the parts, routes every wire,
// and turns the routes into cable meshes and drag handles.
import * as THREE from 'three';
import { app, uid, V } from '../app.js';
import { partById, info } from '../doc.js';
import { Grid, simplify, fillet } from './router.js';

// How each cable kind is drawn: strands = [colour, radius, sideways offset].
export const KINDS = {
  batt: { name: 'Battery cable (6 AWG)', strands: [[0xd92b2b, 0.13, 0.135], [0x18181a, 0.13, -0.135]], order: 0 },
  pwr: { name: 'Power (12–18 AWG)', strands: [[0xd92b2b, 0.055, 0.058], [0x18181a, 0.055, -0.058]], order: 2 },
  comp: { name: 'Compressor power', strands: [[0xd92b2b, 0.055, 0.058], [0x18181a, 0.055, -0.058]], order: 2 },
  phase: { name: 'Motor leads', strands: [[0x6f747c, 0.1, 0]], order: 1 },
  can: { name: 'CAN bus', strands: [[0xf2c230, 0.038, 0.04], [0x35b34a, 0.038, -0.04]], order: 3 },
  eth: { name: 'Ethernet', strands: [[0x2a7de1, 0.07, 0]], order: 4 },
  sig: { name: 'Signal', strands: [[0xf08a24, 0.045, 0]], order: 5 },
};
export const PORT_COLORS = { batt: 0xff5a4a, pwr: 0xff5a4a, comp: 0xff9a7a, phase: 0xaab0b8, can: 0xf2c230, eth: 0x4a9bff, sig: 0xf08a24 };

export const rt = new Map(); // wire id -> {tag, cells, pts, len, conflicts, group, legOf}
let grid = null;
const mats = new Map();
const mat = (color, hi) => {
  const k = color + (hi ? 'h' : '');
  if (!mats.has(k)) {
    mats.set(k, new THREE.MeshStandardMaterial({
      color, roughness: 0.5, metalness: 0.05,
      emissive: hi ? 0xff8a1f : 0x000000, emissiveIntensity: hi ? 0.55 : 0,
    }));
  }
  return mats.get(k);
};
const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

export function portWorld(partId, portId) {
  const obj = app.objs.get(partId);
  const port = obj?.userData.info.ports.find((p) => p.id === portId);
  if (!port) return null;
  return {
    port,
    p: V(port.p).applyMatrix4(obj.matrixWorld),
    d: V(port.d).transformDirection(obj.matrixWorld),
  };
}
export const portKey = (ref) => ref.part + ':' + ref.port;
export function usedPorts(skipWire) {
  const s = new Map();
  for (const w of app.doc.wires) {
    if (w === skipWire) continue;
    s.set(portKey(w.a), w); s.set(portKey(w.b), w);
  }
  return s;
}

function buildGrid() {
  const box = new THREE.Box3();
  const items = [];
  for (const [id, obj] of app.objs) {
    const inf = obj.userData.info;
    const wb = inf.bbox.clone().applyMatrix4(obj.matrixWorld);
    box.union(wb);
    items.push({ id, obj, inf, wb });
  }
  for (const w of app.doc.wires) for (const p of w.way || []) box.expandByPoint(V(p));
  if (box.isEmpty()) box.set(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 5));
  box.expandByScalar(2.5);
  const g = new Grid(box.min.toArray(), box.max.toArray(), 0.5);
  for (const it of items) {
    const inv = it.obj.matrixWorld.clone().invert().elements;
    const part = partById(it.id);
    const inside = part?.kind === 'plate' && it.inf.inside ? (x, y) => it.inf.inside(x, y) : null;
    g.addBox(inv, it.inf.bbox.min.toArray(), it.inf.bbox.max.toArray(), it.wb.min.toArray(), it.wb.max.toArray(), inside);
  }
  g.finalize();
  return g;
}

function routeWire(w, r) {
  const A = portWorld(w.a.part, w.a.port), B = portWorld(w.b.part, w.b.port);
  if (!A || !B) return false;
  r.exitA ??= grid.exitCell(A.p.toArray(), A.d.toArray(), r.tag);
  r.exitB ??= grid.exitCell(B.p.toArray(), B.d.toArray(), r.tag);
  const stops = [r.exitA, ...(w.way || []).map((p) => grid.nearestFree(grid.cellOf(p), r.tag)), r.exitB];
  const cells = [], legOf = [];
  let conflicts = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const leg = grid.route(stops[i], stops[i + 1], r.tag);
    for (let k = i ? 1 : 0; k < leg.length; k++) { cells.push(leg[k]); legOf.push(i); }
  }
  const hit = new Set();
  for (const c of cells) if (grid.occ[c] !== 0 && grid.occ[c] !== r.tag) { conflicts++; hit.add(grid.occ[c]); }
  grid.claim(cells, r.tag);
  r.hit = hit;
  // world polyline: port, short straight lead-out, grid path, lead-in, port
  const lead = (P) => P.p.clone().addScaledVector(P.d, 0.3).toArray();
  const raw = [A.p.toArray(), lead(A), ...cells.map((c) => grid.center(c)), lead(B), B.p.toArray()];
  const legs = [0, 0, ...legOf, stops.length - 2, stops.length - 2];
  // simplify but remember which leg every kept point belongs to
  const pts = simplify(raw);
  const keptLeg = [];
  let j = 0;
  for (const p of pts) {
    while (raw[j] !== p) j++;
    keptLeg.push(legs[j]);
  }
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  Object.assign(r, { cells, pts, legOf: keptLeg, len, conflicts });
  return true;
}

export function rerouteAll() {
  grid = buildGrid();
  for (const r of rt.values()) r.group?.removeFromParent();
  const old = new Map(rt);
  rt.clear();
  const wires = app.doc.wires.filter((w) => portWorld(w.a.part, w.a.port) && portWorld(w.b.part, w.b.port));
  const dist = (w) => portWorld(w.a.part, w.a.port).p.distanceTo(portWorld(w.b.part, w.b.port).p);
  // pinned wires first (the user placed them), then fat cables, then short runs
  const order = wires.map((w) => ({ w, d: dist(w) })).sort((x, y) =>
    ((y.w.way?.length ? 1 : 0) - (x.w.way?.length ? 1 : 0))
    || (KINDS[x.w.kind].order - KINDS[y.w.kind].order) || (x.d - y.d));
  order.forEach(({ w }, i) => rt.set(w.id, { tag: i + 1 }));
  // reserve every port's exit cell before anything is routed
  for (const { w } of order) {
    const r = rt.get(w.id), A = portWorld(w.a.part, w.a.port), B = portWorld(w.b.part, w.b.port);
    r.exitA = grid.exitCell(A.p.toArray(), A.d.toArray(), r.tag); grid.claim([r.exitA], r.tag);
    r.exitB = grid.exitCell(B.p.toArray(), B.d.toArray(), r.tag); grid.claim([r.exitB], r.tag);
  }
  for (const { w } of order) routeWire(w, rt.get(w.id));
  // Rip-up and re-route: a wire that had to cross gets to go first, and the
  // wires it ran into find a new way around it.
  const byTag = new Map(order.map(({ w }) => [rt.get(w.id).tag, w]));
  const reserve = (w) => { const r = rt.get(w.id); grid.release(r.tag); grid.claim([r.exitA, r.exitB], r.tag); };
  for (let pass = 0; pass < 4; pass++) {
    const bad = order.filter(({ w }) => rt.get(w.id).conflicts);
    if (!bad.length) break;
    for (const { w } of bad) {
      const r = rt.get(w.id);
      if (!r.conflicts) continue;
      const victims = [...r.hit].map((t) => byTag.get(t)).filter(Boolean);
      for (const v of [w, ...victims]) reserve(v);
      for (const v of [w, ...victims]) routeWire(v, rt.get(v.id));
    }
  }
  for (const { w } of order) buildMesh(w);
  for (const r of old.values()) disposeGroup(r.group);
  app.emit('wires');
}

export function rerouteOne(id) {
  const w = app.doc.wires.find((x) => x.id === id), r = rt.get(id);
  if (!w || !r || !grid) return;
  grid.release(r.tag);
  grid.claim([r.exitA, r.exitB], r.tag);
  routeWire(w, r);
  buildMesh(w);
}

export function snapToGrid(p) { return grid ? V(grid.snap(p.toArray())) : p; }

// ---- meshes ----------------------------------------------------------------
function disposeGroup(g) {
  if (!g) return;
  g.removeFromParent();
  g.traverse((m) => m.geometry?.dispose());
}

function tubeGeometry(pts, frames, radius, offset, seg = 6) {
  const n = pts.length, pos = new Float32Array(n * seg * 3), nor = new Float32Array(n * seg * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const { N, B } = frames[i], p = pts[i];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const nx = N.x * c + B.x * sn, ny = N.y * c + B.y * sn, nz = N.z * c + B.z * sn;
      const o = (i * seg + s) * 3;
      pos[o] = p[0] + B.x * offset + nx * radius;
      pos[o + 1] = p[1] + B.y * offset + ny * radius;
      pos[o + 2] = p[2] + B.z * offset + nz * radius;
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
      if (i < n - 1) {
        const a0 = i * seg + s, a1 = i * seg + ((s + 1) % seg), b0 = a0 + seg, b1 = a1 + seg;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// Rotation-minimising frames so paired strands stay side by side.
function frames(pts) {
  const out = [];
  let N = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const T = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    if (!N) N = Math.abs(T.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    N = N.clone().addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-6) N = Math.abs(T.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    N.addScaledVector(T, -N.dot(T)).normalize();
    out.push({ N, B: new THREE.Vector3().crossVectors(T, N) });
  }
  return out;
}

export function buildMesh(w) {
  const r = rt.get(w.id);
  if (!r?.pts) return;
  disposeGroup(r.group);
  const g = (r.group = new THREE.Group());
  const hi = app.sel.some((s) => s.t === 'wire' && s.id === w.id);
  const pts = fillet(r.pts), fr = frames(pts);
  for (const [color, radius, off] of KINDS[w.kind].strands) {
    g.add(new THREE.Mesh(tubeGeometry(pts, fr, radius, off), mat(r.conflicts ? 0xff00ff : color, hi)));
  }
  const pick = new THREE.Mesh(tubeGeometry(pts, fr, 0.22, 0, 5), pickMat);
  pick.userData.wireId = w.id;
  g.add(pick);
  g.visible = app.showWires;
  app.vp.wires.add(g);
}

export function refreshWireHighlights() {
  for (const w of app.doc.wires) if (rt.has(w.id)) buildMesh(w);
}

export function addWire(a, b, kind, auto = false) {
  const w = { id: uid('w'), a, b, kind, way: [], auto };
  app.doc.wires.push(w);
  return w;
}
export function removeWires(ids) {
  app.doc.wires = app.doc.wires.filter((w) => !ids.includes(w.id));
  app.sel = app.sel.filter((s) => !(s.t === 'wire' && ids.includes(s.id)));
  app.emit('doc'); app.emit('sel'); app.emit('wires-dirty');
}
export const wireLabel = (w) => {
  const n = (ref) => `${partById(ref.part)?.name ?? '?'} · ${info(ref.part)?.ports.find((p) => p.id === ref.port)?.name ?? ref.port}`;
  return `${n(w.a)}  →  ${n(w.b)}`;
};
export const totalWireLength = () => [...rt.values()].reduce((s, r) => s + (r.len || 0), 0);
export const conflictCount = () => [...rt.values()].reduce((s, r) => s + (r.conflicts || 0), 0);
