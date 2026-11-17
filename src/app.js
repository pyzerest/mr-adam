// Shared application state + tiny event bus.
import * as THREE from 'three';

export const app = {
  doc: null,
  vp: null,
  objs: new Map(), // part id -> THREE.Group
  sel: [], // [{t: 'part' | 'mate' | 'wire', id}]
  tool: null,
  tools: {},
  showWires: true,
  warnings: [],
  _l: {},
  on(e, f) { (this._l[e] ||= []).push(f); },
  emit(e, ...a) { (this._l[e] || []).forEach((f) => f(...a)); },
};

export const uid = (p) => p + Math.random().toString(36).slice(2, 8);
export const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
export const arr = (v) => [v.x, v.y, v.z];
export const round = (v, s) => Math.round(v / s) * s;
export const fmt = (v, d = 3) => String(+(+v).toFixed(d));

export function setTool(name, opts) {
  const next = app.tools[name];
  if (!next) return;
  app.tool?.exit?.();
  app.tool = next;
  app.toolName = name;
  next.enter?.(opts || {});
  app.emit('tool', name);
}

export function hint(text) { app.emit('hint', text); }
export function toast(text, kind = '') { app.emit('toast', text, kind); }

// ---- selection -------------------------------------------------------------
export function select(items, add = false) {
  items = [].concat(items || []);
  if (add) {
    for (const it of items) {
      const i = app.sel.findIndex((s) => s.t === it.t && s.id === it.id);
      if (i >= 0) app.sel.splice(i, 1); else app.sel.push(it);
    }
  } else app.sel = items;
  app.emit('sel');
}
export const selParts = () => app.sel.filter((s) => s.t === 'part').map((s) => s.id);
export const isSel = (t, id) => app.sel.some((s) => s.t === t && s.id === id);
