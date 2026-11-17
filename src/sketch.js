// Plate workflow, Onshape style: pick a plane or a flat face, sketch closed
// profiles (rectangles, lines, circles, holes) with editable dimensions, hit
// the green check and the sketch is extruded into a polycarb/aluminium plate.
import * as THREE from 'three';
import { app, V, round, fmt, setTool, hint, toast, select } from './app.js';
import { partById, syncPart, addPart, commit, frameMatrix } from './doc.js';
import { entLoop, sketchRegions, regionShapes, newPlate } from './parts/parts.js';
import { setLabels } from './labels.js';

const Z = new THREE.Vector3(0, 0, 1);
const PLANES = [
  { name: 'Top', f: { p: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, color: 0x4a90e2 },
  { name: 'Front', f: { p: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, color: 0x4a90e2 },
  { name: 'Right', f: { p: [0, 0, 0], z: [1, 0, 0], x: [0, 1, 0] }, color: 0x4a90e2 },
];
const lineMat = (c) => new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true });
const LM = { ent: lineMat(0x9fd0ff), sel: lineMat(0xffa347), cur: lineMat(0xffffff) };
export const HOLE_SIZES = [
  ['#10 clearance', 0.196], ['1/4" clearance', 0.257], ['3/8" hex shaft', 0.386],
  ['1/2" hex shaft', 0.515], ['Bearing 1.125"', 1.125],
];
export const lastPlate = { thickness: 0.125, material: 'alu' };

let vp;
const S = { stage: null };

export const sketchTool = {
  enter(o) {
    vp = app.vp;
    S.view = vp.getView();
    S.group = new THREE.Group();
    vp.overlay.add(S.group);
    S.sub = 'rect'; S.holeD = S.holeD || 0.196; S.cur = null; S.sel = -1; S.partId = null;
    const part = o.partId && partById(o.partId);
    if (part) {
      S.partId = part.id;
      app.objs.get(part.id).visible = false;
      this.begin(app.objs.get(part.id).matrixWorld.clone(), JSON.parse(JSON.stringify(part.sketch)));
      S.sub = 'select';
      app.emit('sketch', true);
    } else this.pickPlane();
  },
  exit() {
    S.group?.removeFromParent();
    S.group?.traverse((m) => m.geometry?.dispose());
    setLabels('sk'); setLabels('skcur');
    if (S.partId && app.objs.get(S.partId)) app.objs.get(S.partId).visible = true;
    if (S.stage === 'draw') vp.restoreView(S.view);
    S.stage = null;
    app.emit('sketch', false);
  },

  // ---- stage 1: choose where to sketch ------------------------------------
  pickPlane() {
    S.stage = 'plane';
    S.quads = PLANES.map((pl) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(44, 44),
        new THREE.MeshBasicMaterial({ color: pl.color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      m.matrixAutoUpdate = false;
      m.matrix.copy(frameMatrix(pl.f));
      m.userData.plane = pl;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), lineMat(0x9fd0ff));
      m.add(edge);
      S.group.add(m);
      return m;
    });
    S.group.updateMatrixWorld(true);
    setLabels('sk', PLANES.map((pl) => ({
      pos: V(pl.name === 'Top' ? [19, -19, 0] : pl.name === 'Front' ? [-19, 0, 19] : [0, 19, 19]), text: pl.name, cls: 'tip',
    })));
    hint('New plate: click the Top / Front / Right plane, or any flat face of a part, to sketch on it.');
  },
  planeAt(e) {
    const q = vp.hit(e, S.quads)[0];
    let face = null;
    for (const h of vp.hit(e, [vp.parts])) {
      if (!h.face) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.dot(vp.raycaster.ray.direction) > 0) n.negate();
      face = { h, n };
      break;
    }
    if (face && (!q || face.h.distance < q.distance)) {
      const n = face.n;
      for (const a of ['x', 'y', 'z']) if (Math.abs(Math.abs(n[a]) - 1) < 0.01) { const s = Math.sign(n[a]); n.set(0, 0, 0); n[a] = s; }
      const p = face.h.point;
      const x = Math.abs(n.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(Z, n).normalize();
      // keep the sketch origin on the world grid so dimensions stay round
      const o = new THREE.Vector3(round(p.x, 1), round(p.y, 1), round(p.z, 1));
      o.addScaledVector(n, -o.clone().sub(p).dot(n));
      return { f: { p: o.toArray(), z: n.toArray(), x: x.toArray() }, quad: null };
    }
    if (!q) return null;
    const quad = q.object.userData.plane ? q.object : q.object.parent;
    return { f: quad.userData.plane.f, quad };
  },

  // ---- stage 2: draw -------------------------------------------------------
  begin(M, ents) {
    S.stage = 'draw';
    S.M = M; S.Minv = M.clone().invert();
    S.ents = ents;
    S.group.clear();
    S.geo = new THREE.Group();
    S.geo.matrixAutoUpdate = false;
    S.geo.matrix.copy(M);
    S.group.add(S.geo);
    S.origin = new THREE.Vector3().setFromMatrixPosition(M);
    S.normal = new THREE.Vector3().setFromMatrixColumn(M, 2).normalize();
    // reference points: holes and connectors of nearby parts, projected
    S.refs = [];
    const seen = new Set();
    for (const [id, obj] of app.objs) {
      if (id === S.partId) continue;
      for (const c of obj.userData.info.connectors) {
        const p = V(c.p).applyMatrix4(obj.matrixWorld).applyMatrix4(S.Minv);
        if (Math.abs(p.z) > 3) continue;
        const k = fmt(p.x, 2) + ',' + fmt(p.y, 2);
        if (!seen.has(k)) { seen.add(k); S.refs.push([p.x, p.y]); }
      }
    }
    const n = S.normal;
    const phi = Math.acos(Math.max(-1, Math.min(1, n.z)));
    const theta = Math.abs(n.z) > 0.999 ? -Math.PI / 2 : Math.atan2(n.y, n.x);
    let target = S.origin.clone(), radius = Math.max(vp.radius * 0.6, 30);
    const regions = sketchRegions(ents);
    if (regions.length) {
      const box = new THREE.Box3();
      for (const r of regions) for (const p of r.pts) box.expandByPoint(new THREE.Vector3(p[0], p[1], 0).applyMatrix4(M));
      target = box.getCenter(new THREE.Vector3());
      radius = Math.max(8, box.getSize(new THREE.Vector3()).length() * 1.4);
    }
    vp.setView(theta, phi, true, { target, radius });
    app.emit('sketch', true);
    this.setSub(S.sub);
    this.redraw();
  },
  setSub(name, holeD) {
    S.sub = name; S.cur = null;
    if (holeD) S.holeD = holeD;
    setLabels('skcur');
    hint({
      rect: 'Rectangle: click two corners (or drag). Click a dimension to type an exact value.',
      line: 'Line: click points; click the first point (or press Enter) to close the shape. Snaps horizontal/vertical.',
      circle: 'Circle: click the centre, then the edge.',
      hole: 'Hole: click to drop holes. White dots are holes of neighbouring parts — click one to match it.',
      select: 'Select: click a shape to select it, drag to move it, Delete to remove it. Click a dimension to edit it.',
    }[name] + '   ✓ extrudes the plate.');
    app.emit('sketch-sub', name);
    this.redraw();
  },
  get sub() { return S.sub; },
  get holeD() { return S.holeD; },
  get active() { return S.stage === 'draw'; },

  uv(e, snap = true) {
    const p = vp.rayPlane(e, S.origin, S.normal).applyMatrix4(S.Minv);
    let x = p.x, y = p.y;
    if (!snap || e.ctrlKey) return [x, y];
    const tol = vp.pixelSize(S.origin) * 10;
    let best = null, bd = tol;
    const tryPt = (q) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = q; } };
    S.refs.forEach(tryPt);
    S.ents.forEach((en, i) => {
      if (i === S.dragIdx) return;
      if (en.t === 'rect') [[en.x, en.y], [en.x + en.w, en.y], [en.x + en.w, en.y + en.h], [en.x, en.y + en.h]].forEach(tryPt);
      else if (en.t === 'circle') tryPt([en.x, en.y]);
      else en.pts.forEach(tryPt);
    });
    if (S.cur?.t === 'poly' && S.cur.pts.length > 2) tryPt(S.cur.pts[0]);
    return best ? [best[0], best[1]] : [round(x, 0.125), round(y, 0.125)];
  },
  hitEnt(u, tol) {
    let best = -1, bd = tol;
    S.ents.forEach((en, i) => {
      const pts = entLoop(en) || en.pts;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((u[0] - a[0]) * dx + (u[1] - a[1]) * dy) / l2));
        const d = Math.hypot(u[0] - a[0] - dx * t, u[1] - a[1] - dy * t);
        if (d < bd) { bd = d; best = i; }
      }
    });
    return best;
  },

  down(e) {
    if (S.stage === 'plane') {
      const pl = this.planeAt(e);
      if (pl) this.begin(frameMatrix(pl.f), []);
      return;
    }
    const u = this.uv(e);
    S.downAt = { x: e.clientX, y: e.clientY };
    const c = S.cur;
    if (S.sub === 'rect' || S.sub === 'circle') {
      if (!c) S.cur = { t: S.sub, a: u, b: u };
      else { c.b = u; this.finishCur(); }
    } else if (S.sub === 'hole') {
      S.ents.push({ t: 'circle', x: u[0], y: u[1], d: S.holeD });
    } else if (S.sub === 'line') {
      if (!c) S.cur = { t: 'poly', pts: [u], tip: u };
      else {
        const q = this.lineSnap(u);
        const f = c.pts[0];
        if (c.pts.length > 2 && Math.hypot(q[0] - f[0], q[1] - f[1]) < 1e-6) this.finishCur();
        else c.pts.push(q);
      }
    } else if (S.sub === 'select') {
      S.sel = this.hitEnt(this.uv(e, false), vp.pixelSize(S.origin) * 8);
      if (S.sel >= 0) { S.dragIdx = S.sel; S.dragFrom = this.uv(e, false); S.dragOrig = JSON.stringify(S.ents[S.sel]); }
    }
    this.redraw();
  },
  lineSnap(u) {
    const p = S.cur.pts[S.cur.pts.length - 1], tol = 0.2;
    const q = [u[0], u[1]];
    if (Math.abs(q[0] - p[0]) < tol) q[0] = p[0];
    if (Math.abs(q[1] - p[1]) < tol) q[1] = p[1];
    return q;
  },
  move(e) {
    if (S.stage === 'plane') {
      const pl = this.planeAt(e);
      for (const q of S.quads) q.material.opacity = pl?.quad === q ? 0.4 : 0.16;
      vp.dom.style.cursor = pl ? 'pointer' : '';
      return;
    }
    const c = S.cur;
    if (S.sub === 'select') {
      if (S.dragIdx >= 0 && e.buttons & 1) {
        const u = this.uv(e, false), en = S.ents[S.dragIdx], o = JSON.parse(S.dragOrig);
        const dx = round(u[0] - S.dragFrom[0], 0.125), dy = round(u[1] - S.dragFrom[1], 0.125);
        if (en.t === 'poly') en.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy]);
        else { en.x = o.x + dx; en.y = o.y + dy; }
        this.redraw();
      }
      return;
    }
    if (document.activeElement?.closest?.('.label')) return; // typing a dimension
    const u = this.uv(e);
    if (c?.t === 'poly') c.tip = this.lineSnap(u);
    else if (c) c.b = u;
    S.tip = u;
    if (c || S.sub === 'hole') this.redraw();
  },
  up(e) {
    S.dragIdx = -1;
    const c = S.cur;
    if (c && c.t !== 'poly' && S.downAt && Math.hypot(e.clientX - S.downAt.x, e.clientY - S.downAt.y) > 6) {
      c.b = this.uv(e);
      this.finishCur();
      this.redraw();
    }
  },
  finishCur() {
    const c = S.cur;
    S.cur = null;
    setLabels('skcur');
    if (!c) return;
    if (c.t === 'rect') {
      const w = Math.abs(c.b[0] - c.a[0]), h = Math.abs(c.b[1] - c.a[1]);
      if (w > 1e-3 && h > 1e-3) S.ents.push({ t: 'rect', x: Math.min(c.a[0], c.b[0]), y: Math.min(c.a[1], c.b[1]), w, h });
    } else if (c.t === 'circle') {
      const d = round(2 * Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]), 0.0625);
      if (d > 1e-3) S.ents.push({ t: 'circle', x: c.a[0], y: c.a[1], d });
    } else if (c.pts.length >= 3) S.ents.push({ t: 'poly', pts: c.pts, closed: true });
  },
  key(e) {
    if (S.stage !== 'draw') return false;
    const k = e.key.toLowerCase();
    if (e.key === 'Enter') {
      if (S.cur) { this.finishCur(); this.redraw(); } else this.finish();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel >= 0) { S.ents.splice(S.sel, 1); S.sel = -1; this.redraw(); return true; }
    const sub = { l: 'line', r: 'rect', c: 'circle', h: 'hole', v: 'select' }[k];
    if (sub && !e.ctrlKey && !e.metaKey) { this.setSub(sub); return true; }
    return false;
  },
  cancel() {
    if (S.stage === 'draw') {
      if (S.cur) { S.cur = null; setLabels('skcur'); this.redraw(); return true; }
      if (S.sub !== 'select') { this.setSub('select'); return true; }
    }
    setTool('select');
    return true;
  },

  // Green check: the sketch becomes (or updates) a plate.
  finish() {
    if (S.stage !== 'draw') return;
    if (S.cur) this.finishCur();
    if (!sketchRegions(S.ents).length) return toast('Draw at least one closed shape (rectangle, circle or closed line loop) first.', 'warn');
    let part = S.partId && partById(S.partId);
    if (part) { part.sketch = S.ents; syncPart(part); } else {
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      S.M.decompose(pos, quat, new THREE.Vector3());
      part = addPart(newPlate(S.ents, { ...lastPlate, pos: pos.toArray(), quat: quat.toArray() }));
    }
    S.partId = null;
    commit();
    app.emit('doc'); app.emit('wires-dirty');
    setTool('select');
    select({ t: 'part', id: part.id });
    toast('Plate extruded — set depth and material in the Extrude panel.');
  },

  // ---- drawing -------------------------------------------------------------
  redraw() {
    if (S.stage !== 'draw') return;
    const g = S.geo;
    g.traverse((m) => m.geometry?.dispose());
    g.clear();
    const add = (o, order = 10) => { o.renderOrder = order; g.add(o); return o; };
    const P = (p) => new THREE.Vector3(p[0], p[1], 0);
    add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: 0x4a90e2, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide })), 5);
    const regions = sketchRegions(S.ents);
    if (regions.length) {
      add(new THREE.Mesh(new THREE.ShapeGeometry(regionShapes(regions), 8), new THREE.MeshBasicMaterial({ color: 0x6fb1ff, transparent: true, opacity: 0.22, depthTest: false, side: THREE.DoubleSide })), 6);
    }
    S.ents.forEach((en, i) => {
      const pts = entLoop(en) || en.pts;
      add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(P)), i === S.sel ? LM.sel : LM.ent));
    });
    if (S.refs.length) {
      add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(S.refs.map(P)),
        new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.8 })), 9);
    }
    add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([P([-1.5, 0]), P([1.5, 0]), P([0, -1.5]), P([0, 1.5])]), lineMat(0xff7a59)), 9);
    // in-progress shape + live dimension
    const c = S.cur, W = (p) => P(p).applyMatrix4(S.M);
    const cur = [];
    if (c?.t === 'rect') {
      add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([P(c.a), P([c.b[0], c.a[1]]), P(c.b), P([c.a[0], c.b[1]])]), LM.cur), 11);
      cur.push({ pos: W([(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]), text: `${fmt(Math.abs(c.b[0] - c.a[0]))} × ${fmt(Math.abs(c.b[1] - c.a[1]))}`, cls: 'dim' });
    } else if (c?.t === 'circle') {
      const r = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
      add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(entLoop({ t: 'circle', x: c.a[0], y: c.a[1], d: 2 * r }).map(P)), LM.cur), 11);
      cur.push({ pos: W(c.b), text: `⌀ ${fmt(round(2 * r, 0.0625))}`, cls: 'dim' });
    } else if (c?.t === 'poly') {
      add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...c.pts, c.tip].map(P)), LM.cur), 11);
      const a = c.pts[c.pts.length - 1];
      cur.push({ pos: W([(a[0] + c.tip[0]) / 2, (a[1] + c.tip[1]) / 2]), text: fmt(Math.hypot(c.tip[0] - a[0], c.tip[1] - a[1])), cls: 'dim' });
    } else if (S.sub === 'hole' && S.tip) {
      add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(entLoop({ t: 'circle', x: S.tip[0], y: S.tip[1], d: S.holeD }).map(P)), LM.cur), 11);
    }
    setLabels('skcur', cur);
    // editable dimensions
    const labels = [];
    const re = () => this.redraw();
    S.ents.forEach((en, i) => {
      if (en.t === 'rect') {
        labels.push({ pos: W([en.x + en.w / 2, en.y]), text: fmt(en.w), cls: 'dim', edit: (v) => { en.w = v; re(); } });
        labels.push({ pos: W([en.x + en.w, en.y + en.h / 2]), text: fmt(en.h), cls: 'dim', edit: (v) => { en.h = v; re(); } });
      } else if (en.t === 'circle') {
        if (en.d > 0.3 || i === S.sel) labels.push({ pos: W([en.x, en.y + en.d / 2]), text: '⌀ ' + fmt(en.d), cls: 'dim', edit: (v) => { en.d = v; re(); } });
      } else if (en.pts.length <= 12 || i === S.sel) {
        en.pts.forEach((a, k) => {
          const b = en.pts[(k + 1) % en.pts.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const edit = k === en.pts.length - 1 ? null : (v) => {
            const dx = ((b[0] - a[0]) / len) * (v - len), dy = ((b[1] - a[1]) / len) * (v - len);
            for (let j = k + 1; j < en.pts.length; j++) en.pts[j] = [en.pts[j][0] + dx, en.pts[j][1] + dy];
            re();
          };
          labels.push({ pos: W([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), text: fmt(len), cls: 'dim', edit });
        });
      }
    });
    setLabels('sk', labels);
  },
};
