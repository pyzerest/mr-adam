// Voxel-grid wire router. Pure JS (no three.js) so it can be tested headless.
//
// The robot volume is cut into small cells. Parts mark cells solid, wires claim
// the cells they pass through. Each wire is routed with A* over the 6-connected
// grid, so two wires that own disjoint cells can never cross each other.
// Cells that touch a part are cheaper than open air, which makes wires hug the
// structure the way real harnesses are zip-tied to it.

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const COST_AIR = 1;
const COST_SURFACE = 0.55;
const COST_UNDER = 2.2;
const COST_TURN = 0.45;
const COST_WIRE = 30; // crossing someone else's cell: last resort
const COST_SOLID = 220; // tunnelling through a part: absolute last resort
const H_WEIGHT = 0.8;
const MAX_CELLS = 2_000_000;

export class Grid {
  constructor(min, max, cell = 0.5) {
    let nx, ny, nz;
    for (;;) {
      nx = Math.max(2, Math.ceil((max[0] - min[0]) / cell));
      ny = Math.max(2, Math.ceil((max[1] - min[1]) / cell));
      nz = Math.max(2, Math.ceil((max[2] - min[2]) / cell));
      if (nx * ny * nz <= MAX_CELLS) break;
      cell *= 1.25;
    }
    Object.assign(this, { min, cell, nx, ny, nz, n: nx * ny * nz });
    this.solid = new Uint8Array(this.n);
    this.near = new Uint8Array(this.n);
    this.occ = new Int32Array(this.n);
    this.g = new Float32Array(this.n);
    this.from = new Int32Array(this.n);
    this.stamp = new Uint32Array(this.n);
    this.gen = 0;
  }

  idx(i, j, k) { return i + this.nx * (j + this.ny * k); }
  ijk(c) {
    const i = c % this.nx, r = (c - i) / this.nx, j = r % this.ny;
    return [i, j, (r - j) / this.ny];
  }
  cellOf(p) {
    const f = (v, a, n) => Math.min(n - 1, Math.max(0, Math.floor((v - this.min[a]) / this.cell)));
    return this.idx(f(p[0], 0, this.nx), f(p[1], 1, this.ny), f(p[2], 2, this.nz));
  }
  center(c) {
    const [i, j, k] = this.ijk(c), s = this.cell;
    return [this.min[0] + (i + 0.5) * s, this.min[1] + (j + 0.5) * s, this.min[2] + (k + 0.5) * s];
  }
  snap(p) { return this.center(this.cellOf(p)); }

  // Mark an oriented box solid. inv = world->local matrix (column-major, 16
  // numbers), lmin/lmax = local box, wmin/wmax = world AABB of that box.
  // inside(x, y, z) optionally refines the test in local coordinates.
  addBox(inv, lmin, lmax, wmin, wmax, inside) {
    const s = this.cell, pad = s * 0.5;
    const lo = (v, a) => Math.max(0, Math.floor((v - pad - this.min[a]) / s));
    const hi = (v, a, n) => Math.min(n - 1, Math.floor((v + pad - this.min[a]) / s));
    const i0 = lo(wmin[0], 0), i1 = hi(wmax[0], 0, this.nx);
    const j0 = lo(wmin[1], 1), j1 = hi(wmax[1], 1, this.ny);
    const k0 = lo(wmin[2], 2), k1 = hi(wmax[2], 2, this.nz);
    for (let k = k0; k <= k1; k++) {
      const z = this.min[2] + (k + 0.5) * s;
      for (let j = j0; j <= j1; j++) {
        const y = this.min[1] + (j + 0.5) * s;
        for (let i = i0; i <= i1; i++) {
          const x = this.min[0] + (i + 0.5) * s;
          const lx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
          const ly = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
          const lz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
          if (lx < lmin[0] - pad || lx > lmax[0] + pad) continue;
          if (ly < lmin[1] - pad || ly > lmax[1] + pad) continue;
          if (lz < lmin[2] - pad || lz > lmax[2] + pad) continue;
          if (inside && !inside(lx, ly, lz)) continue;
          this.solid[this.idx(i, j, k)] = 1;
        }
      }
    }
  }

  // Flag free cells that touch a solid cell ("surface" cells).
  finalize() {
    const { nx, ny, nz, solid, near } = this;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = this.idx(i, j, k);
      if (solid[c]) continue;
      // 1 = resting on / beside a part (cheap), 2 = hanging underneath one (avoid)
      if (k < nz - 1 && solid[c + nx * ny]) near[c] = 2;
      else {
        near[c] = (i > 0 && solid[c - 1]) || (i < nx - 1 && solid[c + 1])
          || (j > 0 && solid[c - nx]) || (j < ny - 1 && solid[c + nx])
          || (k > 0 && solid[c - nx * ny]) ? 1 : 0;
      }
    }
  }

  free(c, tag) { return !this.solid[c] && (this.occ[c] === 0 || this.occ[c] === tag); }

  // First free cell walking out of a port along its direction.
  exitCell(p, d, tag) {
    const step = this.cell * 0.5;
    let last = -1;
    for (let t = 0; t <= 14; t++) {
      const c = this.cellOf([p[0] + d[0] * step * t, p[1] + d[1] * step * t, p[2] + d[2] * step * t]);
      if (c === last) continue;
      last = c;
      if (this.free(c, tag)) return c;
    }
    return this.nearestFree(this.cellOf(p), tag);
  }

  nearestFree(c0, tag) {
    if (this.free(c0, tag)) return c0;
    const seen = new Set([c0]), q = [c0];
    for (let h = 0; h < q.length && h < 4000; h++) {
      const [i, j, k] = this.ijk(q[h]);
      for (const [dx, dy, dz] of DIRS) {
        const a = i + dx, b = j + dy, e = k + dz;
        if (a < 0 || b < 0 || e < 0 || a >= this.nx || b >= this.ny || e >= this.nz) continue;
        const c = this.idx(a, b, e);
        if (seen.has(c)) continue;
        if (this.free(c, tag)) return c;
        seen.add(c); q.push(c);
      }
    }
    return c0;
  }

  claim(cells, tag) { for (const c of cells) if (this.occ[c] === 0) this.occ[c] = tag; }
  release(tag) { const o = this.occ; for (let c = 0; c < o.length; c++) if (o[c] === tag) o[c] = 0; }

  // A* from cell a to cell b. Returns the list of cells (inclusive).
  route(a, b, tag) {
    if (a === b) return [a];
    const { nx, ny, nz, solid, near, occ, g, from, stamp } = this;
    const gen = ++this.gen, sxy = nx * ny;
    const [bi, bj, bk] = this.ijk(b);
    const offs = [1, -1, nx, -nx, sxy, -sxy];
    const heap = new Heap();
    g[a] = 0; from[a] = -1; stamp[a] = gen;
    heap.push(0, a);
    while (heap.size) {
      const c = heap.pop();
      if (c === b) break;
      const gc = g[c];
      const i = c % nx, r = (c - i) / nx, j = r % ny, k = (r - j) / ny;
      const pd = from[c] < 0 ? -1 : c - from[c];
      for (let d = 0; d < 6; d++) {
        if (d === 0 ? i === nx - 1 : d === 1 ? i === 0 : d === 2 ? j === ny - 1
          : d === 3 ? j === 0 : d === 4 ? k === nz - 1 : k === 0) continue;
        const o = offs[d], m = c + o;
        let w = near[m] === 1 ? COST_SURFACE : near[m] === 2 ? COST_UNDER : COST_AIR;
        if (m !== b) {
          if (solid[m]) w += COST_SOLID;
          else if (occ[m] !== 0 && occ[m] !== tag) w += COST_WIRE;
        }
        if (pd !== -1 && pd !== o) w += COST_TURN;
        const ng = gc + w;
        if (stamp[m] === gen && g[m] <= ng) continue;
        g[m] = ng; from[m] = c; stamp[m] = gen;
        const mi = i + DIRS[d][0], mj = j + DIRS[d][1], mk = k + DIRS[d][2];
        const h = (Math.abs(mi - bi) + Math.abs(mj - bj) + Math.abs(mk - bk)) * H_WEIGHT;
        heap.push(ng + h, m);
      }
    }
    if (stamp[b] !== gen) return [a, b];
    const out = [];
    for (let c = b; c !== -1; c = from[c]) out.push(c);
    return out.reverse();
  }
}

class Heap {
  constructor() { this.k = []; this.v = []; this.size = 0; this.lastKey = 0; }
  push(key, val) {
    const { k, v } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this, top = v[0];
    this.lastKey = k[0];
    const n = --this.size;
    if (n > 0) {
      const key = k[n], val = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    k.length = v.length = n;
    return top;
  }
}

// Drop the middle point of every straight run.
export function simplify(pts) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy + uz * vz;
    if (cx * cx + cy * cy + cz * cz > 1e-9 || dot <= 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Round every corner of a polyline with a small arc.
export function fillet(pts, r = 0.22, seg = 4) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], la = len(pts[i - 1], p), lb = len(p, pts[i + 1]);
    const ra = Math.min(r, la / 2), rb = Math.min(r, lb / 2);
    if (ra < 1e-4 || rb < 1e-4) { out.push(p); continue; }
    const s = lerp(p, pts[i - 1], ra / la), e = lerp(p, pts[i + 1], rb / lb);
    for (let k = 0; k <= seg; k++) {
      const t = k / seg, u = 1 - t;
      out.push([
        u * u * s[0] + 2 * u * t * p[0] + t * t * e[0],
        u * u * s[1] + 2 * u * t * p[1] + t * t * e[1],
        u * u * s[2] + 2 * u * t * p[2] + t * t * e[2],
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
