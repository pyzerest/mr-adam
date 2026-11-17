// Turns a document part ({kind, ...params}) into a THREE object plus the
// derived info the rest of the app needs (ports, mate connectors, mass, bbox).
import * as THREE from 'three';
import { LIB, MAT, TUBE_PROFILES, PLATE_PRESETS } from './library.js';

export const HOLE_D = 0.196; // #10 clearance
const RHO = { alu: 0.0975, pc: 0.0433, steel: 0.283 };
export const MATERIALS = { alu: 'Aluminum 6061', pc: 'Polycarbonate' };
export const THICKNESSES = [0.0625, 0.09, 0.125, 0.1875, 0.25];

// ---- tubes -----------------------------------------------------------------
// Local frame: length along +X starting at the origin, section centred on X.
export function tubeHoleXs(len, pitch) {
  const xs = [];
  for (let x = pitch / 2; x < len - 0.05; x += pitch) xs.push(x);
  return xs;
}
const rows = (span) => (span >= 2 ? [-0.5, 0.5] : [0]);

function wall(len, span, t, xs, ys) {
  const s = new THREE.Shape();
  s.moveTo(0, -span / 2); s.lineTo(len, -span / 2); s.lineTo(len, span / 2); s.lineTo(0, span / 2); s.closePath();
  for (const x of xs) for (const y of ys) {
    const h = new THREE.Path();
    h.absarc(x, y, HOLE_D / 2, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  return new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 5 });
}

function buildTube(part) {
  const pr = TUBE_PROFILES[part.profile] || TUBE_PROFILES['2x1'];
  const { w, h } = pr, L = part.length, t = part.wall || 0.125;
  const g = new THREE.Group();
  const connectors = [
    { p: [0, 0, 0], z: [-1, 0, 0], x: [0, 1, 0] },
    { p: [L, 0, 0], z: [1, 0, 0], x: [0, 1, 0] },
  ];
  if (pr.solid) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 / Math.cos(Math.PI / 6), w / 2 / Math.cos(Math.PI / 6), L, 6), MAT.steel);
    m.rotation.z = Math.PI / 2; m.position.x = L / 2;
    g.add(m);
    return { obj: g, ports: [], connectors, mass: 0.866 * w * w * L * RHO.steel };
  }
  const xs = part.holes ? tubeHoleXs(L, part.holes) : [];
  const add = (geo) => g.add(new THREE.Mesh(geo, MAT.alu));
  add(wall(L, w, t, xs, rows(w)).translate(0, 0, h / 2 - t));
  add(wall(L, w, t, xs, rows(w)).translate(0, 0, -h / 2));
  const side = () => wall(L, h - 2 * t, t, xs, rows(h)).rotateX(Math.PI / 2);
  add(side().translate(0, w / 2, 0));
  add(side().translate(0, -w / 2 + t, 0));
  // Mate connectors sit on the 1/2" grid whether or not holes are drilled.
  for (const x of tubeHoleXs(L, 0.5)) {
    for (const y of rows(w)) {
      connectors.push({ p: [x, y, h / 2], z: [0, 0, 1], x: [1, 0, 0] }, { p: [x, y, -h / 2], z: [0, 0, -1], x: [1, 0, 0] });
    }
    for (const z of rows(h)) {
      connectors.push({ p: [x, w / 2, z], z: [0, 1, 0], x: [1, 0, 0] }, { p: [x, -w / 2, z], z: [0, -1, 0], x: [1, 0, 0] });
    }
  }
  const area = w * h - (w - 2 * t) * (h - 2 * t);
  return { obj: g, ports: [], connectors, mass: area * L * RHO.alu, holeCount: xs.length };
}

// ---- plates ----------------------------------------------------------------
const CIRCLE_SEG = 28;
export function entLoop(e) {
  if (e.t === 'rect') return [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]];
  if (e.t === 'circle') {
    const pts = [];
    for (let i = 0; i < CIRCLE_SEG; i++) {
      const a = (i / CIRCLE_SEG) * Math.PI * 2;
      pts.push([e.x + Math.cos(a) * e.d / 2, e.y + Math.sin(a) * e.d / 2]);
    }
    return pts;
  }
  if (e.t === 'poly' && e.closed && e.pts.length >= 3) return e.pts;
  return null;
}
const loopArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
export function pointInLoop(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Closed sketch loops -> regions: outers with the holes nested inside them.
export function sketchRegions(ents) {
  const loops = [];
  for (const e of ents) {
    const pts = entLoop(e);
    if (pts) loops.push({ pts, area: Math.abs(loopArea(pts)) });
  }
  for (const l of loops) {
    l.parents = loops.filter((o) => o !== l && o.area > l.area && pointInLoop(l.pts[0][0], l.pts[0][1], o.pts));
  }
  const outers = loops.filter((l) => l.parents.length % 2 === 0);
  return outers.map((o) => ({
    pts: o.pts,
    area: o.area,
    holes: loops.filter((l) => l.parents.length === o.parents.length + 1 && l.parents.includes(o)),
  }));
}

export function regionShapes(regions) {
  const path = (pts, P) => {
    const s = new P();
    pts.forEach((p, i) => s[i ? 'lineTo' : 'moveTo'](p[0], p[1]));
    s.closePath();
    return s;
  };
  return regions.map((r) => {
    const s = path(r.pts, THREE.Shape);
    for (const h of r.holes) s.holes.push(path(h.pts, THREE.Path));
    return s;
  });
}

function buildPlate(part) {
  const regions = sketchRegions(part.sketch || []);
  const t = part.thickness || 0.125, z0 = part.flip ? -t : 0;
  const g = new THREE.Group();
  const connectors = [];
  let area = 0;
  if (regions.length) {
    const geo = new THREE.ExtrudeGeometry(regionShapes(regions), { depth: t, bevelEnabled: false, curveSegments: 8 });
    geo.translate(0, 0, z0);
    g.add(new THREE.Mesh(geo, part.material === 'pc' ? MAT.pc : MAT.alu));
  }
  const both = (x, y) => connectors.push(
    { p: [x, y, z0 + t], z: [0, 0, 1], x: [1, 0, 0] },
    { p: [x, y, z0], z: [0, 0, -1], x: [1, 0, 0] },
  );
  for (const r of regions) {
    area += r.area - r.holes.reduce((s, h) => s + h.area, 0);
    const xs = r.pts.map((p) => p[0]), ys = r.pts.map((p) => p[1]);
    both((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
  }
  for (const e of part.sketch || []) if (e.t === 'circle' && e.d <= 0.6) both(e.x, e.y);
  const inside = (x, y) => regions.some((r) => pointInLoop(x, y, r.pts));
  return { obj: g, ports: [], connectors, mass: area * t * RHO[part.material || 'alu'], inside, area };
}

// ---- dispatch --------------------------------------------------------------
export function buildPart(part) {
  let r;
  if (part.kind === 'tube') r = buildTube(part);
  else if (part.kind === 'plate') r = buildPlate(part);
  else {
    const def = LIB[part.def];
    r = def.build({ ...(def.params || {}), ...(part.params || {}) });
  }
  const obj = r.obj;
  obj.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(obj);
  if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-0.5, -0.5, -0.1), new THREE.Vector3(0.5, 0.5, 0.1));
  obj.userData.info = { ports: r.ports, connectors: r.connectors, mass: r.mass, bbox, inside: r.inside, holeCount: r.holeCount, area: r.area };
  obj.userData.partId = part.id;
  return obj;
}

export function defaultName(part) {
  if (part.kind === 'tube') return TUBE_PROFILES[part.profile]?.name || 'Tube';
  if (part.kind === 'plate') return part.preset ? PLATE_PRESETS[part.preset].name : 'Plate';
  return LIB[part.def].name;
}

export function newTube(profile = '2x1', length = 0.5) {
  return { kind: 'tube', profile, length, wall: 0.125, holes: profile === 'hex' ? 0 : 0.5 };
}
export function newPlate(sketch, o = {}) {
  return { kind: 'plate', sketch, thickness: 0.125, material: 'alu', flip: false, ...o };
}
