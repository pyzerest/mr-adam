// DOM chrome: Onshape-style toolbar, instance tree, parts library, property
// dialogs, quick-add palette, context menu, BOM and toasts.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { app, fmt, setTool, toast, select, selParts, isSel } from './app.js';
import {
  partById, info, syncPart, commit, undo, redo, canUndo, canRedo, loadDoc, emptyDoc, applyMate, removeMates, beginMove,
} from './doc.js';
import { LIB, CATS, PLATE_PRESETS, TUBE_PROFILES } from './parts/library.js';
import { buildPart, newTube, newPlate, MATERIALS, THICKNESSES, tubeHoleXs } from './parts/parts.js';
import { deleteSelection, duplicateSelection, frameSelection, detachSelection, setGizmoMode } from './tools.js';
import { sketchTool, HOLE_SIZES, lastPlate } from './sketch.js';
import { autowire } from './wiring/autowire.js';
import {
  rt, KINDS, PORT_COLORS, wireLabel, totalWireLength, conflictCount, removeWires, rerouteOne, usedPorts, portKey,
} from './wiring/wires.js';
import { loadSample } from './sample.js';

const $ = (s) => document.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el[k] = v;
  }
  for (const k of kids.flat(3)) if (k != null && k !== false) el.append(k);
  return el;
};
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d.split('|').map((p) => `<path d="${p}"/>`).join('')}${extra}</svg>`;
const IC = {
  undo: svg('M9 14 4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3'),
  redo: svg('m15 14 5-5-5-5|M20 9H10a6 6 0 0 0 0 12h3'),
  select: svg('M5 3l14 8-6 2-2 6z'),
  tube: svg('M3 15l12-7 6 3-12 7z|M3 15v-4l12-7 6 3v4|M15 4v4', '<circle cx="9" cy="13.2" r=".7"/><circle cx="12.5" cy="11.2" r=".7"/><circle cx="16" cy="9.2" r=".7"/>'),
  plate: svg('M3 14l9-5 9 5-9 5z|M3 14v2l9 5 9-5v-2', '<circle cx="12" cy="14" r="1.6"/>'),
  mate: svg('M4 8h6v8H4z|M14 8h6v8h-6z|M10 12h4'),
  wire: svg('M4 18c0-8 4-4 8-6s8-2 8-6', '<circle cx="4" cy="18" r="1.8"/><circle cx="20" cy="6" r="1.8"/>'),
  bolt: svg('M13 2 4 14h7l-1 8 9-12h-7z'),
  eye: svg('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', '<circle cx="12" cy="12" r="3"/>'),
  move: svg('M12 3v18|M3 12h18|m9 6 3-3 3 3|m9 18 3 3 3-3|m6 9-3 3 3 3|m18 9 3 3-3 3'),
  rotate: svg('M20 12a8 8 0 1 1-3-6.2|M20 4v5h-5'),
  list: svg('M8 6h12|M8 12h12|M8 18h12|M4 6h.01|M4 12h.01|M4 18h.01'),
  file: svg('M6 3h8l4 4v14H6z|M14 3v4h4'),
  down: svg('M12 4v11|m7 11 5 5 5-5|M5 20h14'),
  up: svg('M12 16V5|m7 9 5-5 5 5|M5 20h14'),
  robot: svg('M5 9h14v10H5z|M12 5v4|M9 14h.01|M15 14h.01|M2 13v3|M22 13v3', '<circle cx="12" cy="4" r="1"/>'),
  help: svg('M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7|M12 17h.01', '<circle cx="12" cy="12" r="9"/>'),
  check: svg('m5 12 5 5 9-10'),
  x: svg('M6 6l12 12|M18 6 6 18'),
  line: svg('M5 19 19 5', '<circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>'),
  rect: svg('M4 6h16v12H4z'),
  circle: svg('', '<circle cx="12" cy="12" r="8"/>'),
  hole: svg('', '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>'),
  frame: svg('M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5'),
  ortho: svg('M4 8l8-4 8 4v8l-8 4-8-4z|M4 8l8 4 8-4|M12 12v8'),
  trash: svg('M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13'),
};

// ---- toolbar ---------------------------------------------------------------
function tb(icon, label, title, onclick, cls = '') {
  return h('button', { class: 'tb ' + cls, title, onclick, html: IC[icon] + `<span>${label}</span>` });
}
const sep = () => h('div', { class: 'sep' });
let inSketch = false;

function renderToolbar() {
  const bar = $('#toolbar');
  bar.replaceChildren();
  if (inSketch) {
    const sub = sketchTool.sub;
    const st = (name, icon, label, key) => tb(icon, label, `${label} (${key})`, () => sketchTool.setSub(name), sub === name ? 'on' : '');
    const holes = h('select', { class: 'tb-select', title: 'Hole size', onchange: (e) => sketchTool.setSub('hole', +e.target.value) },
      HOLE_SIZES.map(([n, d]) => h('option', { value: d, selected: Math.abs(d - sketchTool.holeD) < 1e-6 }, `Hole: ${n}`)));
    bar.append(
      tb('check', 'Extrude', 'Finish sketch and extrude the plate (Enter)', () => sketchTool.finish(), 'ok'),
      tb('x', 'Cancel', 'Discard sketch (Esc)', () => setTool('select'), 'bad'),
      sep(), st('select', 'select', 'Select', 'V'), st('line', 'line', 'Line', 'L'), st('rect', 'rect', 'Rectangle', 'R'),
      st('circle', 'circle', 'Circle', 'C'), st('hole', 'hole', 'Hole', 'H'), holes,
    );
    return;
  }
  const t = app.toolName;
  const tool = (name, icon, label, key) => tb(icon, label, `${label} (${key})`, () => setTool(name), t === name ? 'on' : '');
  const u = tb('undo', 'Undo', 'Undo (Ctrl+Z)', undo); u.disabled = !canUndo();
  const r = tb('redo', 'Redo', 'Redo (Ctrl+Shift+Z)', redo); r.disabled = !canRedo();
  const profile = h('select', { class: 'tb-select', title: 'Extrusion profile', onchange: (e) => setTool('tube', { profile: e.target.value }) },
    Object.entries(TUBE_PROFILES).map(([id, p]) => h('option', { value: id, selected: id === app.tools.tube.profile }, p.name)));
  bar.append(
    u, r, sep(),
    tool('select', 'select', 'Select', 'Esc'),
    tool('tube', 'tube', 'Extrusion', 'T'), profile,
    tool('sketch', 'plate', 'Plate', 'P'),
    tool('mate', 'mate', 'Mate', 'M'),
    sep(),
    tool('wire', 'wire', 'Wire', 'W'),
    tb('bolt', 'Auto-wire', 'Generate the whole wiring harness and route it', runAutowire, 'primary'),
    tb('eye', 'Wires', 'Show / hide wiring', () => { app.showWires = !app.showWires; app.emit('wires-vis'); renderToolbar(); }, app.showWires ? 'on' : ''),
    sep(),
    tb('list', 'BOM', 'Bill of materials, weight and wire lengths', showBOM),
    tb('robot', 'Sample', 'Load the sample swerve robot', () => { if (confirm('Replace the current design with the sample robot?')) loadSample(); }),
    tb('file', 'New', 'Start an empty design', () => { if (confirm('Start a new empty design?')) loadDoc(emptyDoc()); }),
    tb('down', 'Export', 'Save the design as a .json file', exportDoc),
    tb('up', 'Import', 'Open a design .json file', importDoc),
    tb('help', 'Help', 'Controls and shortcuts', showHelp),
  );
}

export function runAutowire() {
  const { made, warnings } = autowire();
  commit();
  toast(made ? `Wired ${made} connection${made === 1 ? '' : 's'} — routing…` + (warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'}, see the Wiring list)` : '')
    : (warnings[0] || 'Nothing to wire yet — add electronics from the library.'), made ? '' : 'warn');
}

function exportDoc() {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(app.doc)], { type: 'application/json' })), download: (app.doc.name || 'robot').replace(/[^\w\- ]+/g, '') + '.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importDoc() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    try {
      const d = JSON.parse(await inp.files[0].text());
      if (!Array.isArray(d.parts)) throw new Error('bad file');
      loadDoc(d);
      frameSelection(true);
    } catch { toast('That file is not a Mr. Adam design.', 'warn'); }
  };
  inp.click();
}

// ---- left: instance tree ---------------------------------------------------
function renderTree() {
  const d = app.doc, el = $('#left');
  const top = el.scrollTop;
  const row = (t, id, name, lead, meta) => h('div', {
    class: 'row' + (isSel(t, id) ? ' sel' : ''),
    onclick: (e) => { if (app.toolName !== 'select') setTool('select'); select({ t, id }, e.shiftKey || e.ctrlKey || e.metaKey); },
    ondblclick: () => t === 'part' && frameSelection(false),
  }, lead, h('span', { class: 'nm', title: name }, name), meta && h('span', { class: 'meta' }, meta));
  const sec = (title, count, kids, empty) => h('div', { class: 'sec' },
    h('h3', {}, title, h('span', {}, count)), kids.length ? kids : h('div', { class: 'empty' }, empty));
  el.replaceChildren(
    sec('Parts', String(d.parts.length), d.parts.map((p) => row('part', p.id, p.name, h('span', { class: 'sq' }), p.kind === 'tube' ? `${fmt(p.length)}"` : '')),
      'Nothing here yet. Draw an extrusion (T), sketch a plate (P), or drag parts in from the library on the right.'),
    sec('Mates', String(d.mates.length), d.mates.map((m) => row('mate', m.id, `${m.name}`, h('span', { class: 'sq', style: 'background:#52a36b' }), `${partById(m.a)?.name?.split(' ')[0] ?? ''}`)),
      'Drag a part onto another and it mates by itself, or use the Mate tool (M).'),
    sec('Wiring', d.wires.length ? `${fmt(totalWireLength() / 12, 1)} ft` : '0', [
      ...app.warnings.map((w) => h('div', { class: 'warnrow' }, '⚠', h('span', {}, w))),
      ...d.wires.map((w) => {
        const dot = h('span', { class: 'dot' });
        dot.style.background = '#' + PORT_COLORS[w.kind].toString(16).padStart(6, '0');
        return row('wire', w.id, wireLabel(w), dot, rt.get(w.id)?.len ? `${fmt(rt.get(w.id).len, 0)}"` : '');
      }),
    ], 'Press Auto-wire to generate the harness, or use the Wire tool (W) to connect two ports by hand.'),
  );
  el.scrollTop = top;
}

function renderStats() {
  let mass = 0;
  for (const p of app.doc.parts) mass += info(p.id)?.mass || 0;
  const x = conflictCount();
  $('#stats').replaceChildren(...[
    h('span', { html: `<b>${app.doc.parts.length}</b> parts` }),
    h('span', { html: `<b>${fmt(mass, 1)}</b> lb` }),
    h('span', { html: `<b>${fmt(totalWireLength() / 12, 1)}</b> ft wire` }),
    x ? h('span', { class: 'bad', title: 'Places where two wires had to share space — drag a wire handle to give them room', html: `<b>${x}</b> wire crossing${x === 1 ? '' : 's'}` }) : null,
  ].filter(Boolean));
}

// ---- right: parts library --------------------------------------------------
const thumbs = {};
function libraryItems() {
  const items = [];
  for (const [id, p] of Object.entries(TUBE_PROFILES)) items.push({ key: 'tube:' + id, name: p.name, cat: 'Structure', tags: 'tube extrusion box maxtube aluminum shaft', run: () => setTool('tube', { profile: id }), temp: { ...newTube(id, id === 'hex' ? 3 : 4) } });
  items.push({ key: 'plate', name: 'Custom Plate', cat: 'Structure', tags: 'sheet polycarb aluminum sketch belly pan', run: () => setTool('sketch'), temp: newPlate([{ t: 'rect', x: 0, y: 0, w: 5, h: 3.5 }, { t: 'circle', x: 3.5, y: 1.75, d: 1.4 }], { material: 'pc' }) });
  for (const [id, p] of Object.entries(PLATE_PRESETS)) items.push({ key: 'preset:' + id, name: p.name, cat: p.cat, tags: p.tags, place: { preset: id }, temp: newPlate(p.sketch) });
  for (const [id, p] of Object.entries(LIB)) items.push({ key: 'lib:' + id, name: p.name, cat: p.cat, tags: p.tags, place: { def: id }, temp: { kind: 'lib', def: id } });
  return items;
}
let ITEMS = [];

function makeThumbs() {
  const S = 132;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(S, S);
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(3, -4, 8);
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
  cam.up.set(0, 0, 1);
  for (const it of ITEMS) {
    const obj = buildPart({ ...it.temp, id: '_t' });
    scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3());
    const rad = box.getSize(new THREE.Vector3()).length() / 2;
    cam.position.copy(c).add(new THREE.Vector3(0.9, -1.25, 0.85).normalize().multiplyScalar(rad / Math.sin((15 * Math.PI) / 180) * 1.02));
    cam.lookAt(c);
    r.render(scene, cam);
    thumbs[it.key] = r.domElement.toDataURL('image/png');
    scene.remove(obj);
    obj.traverse((m) => m.geometry?.dispose());
  }
  r.dispose();
  r.forceContextLoss?.();
}

function renderLibrary(filter = '') {
  const list = $('#liblist');
  const q = filter.trim().toLowerCase();
  const kids = [];
  for (const cat of CATS) {
    const items = ITEMS.filter((it) => it.cat === cat && (!q || (it.name + ' ' + it.tags + ' ' + cat).toLowerCase().includes(q)));
    if (!items.length) continue;
    kids.push(h('div', { class: 'cat' }, cat), h('div', { class: 'tiles' }, items.map((it) => {
      const tile = h('div', { class: 'tile', title: it.place ? `${it.name} — click, then click where it goes (or drag it into the view)` : it.name },
        h('img', { src: thumbs[it.key] || '', alt: '', draggable: false }), h('span', {}, it.name));
      tile.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (!it.place) return it.run();
        setTool('place', it.place);
        // drag straight into the viewport, or click and then click a face
        const start = { x: e.clientX, y: e.clientY };
        const up = (ev) => {
          window.removeEventListener('pointerup', up);
          const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8;
          const over = document.elementFromPoint(ev.clientX, ev.clientY) === app.vp.dom;
          if (moved && over && app.toolName === 'place') app.tools.place.place(ev);
          else if (moved && !over) setTool('select');
        };
        window.addEventListener('pointerup', up);
      });
      return tile;
    })));
  }
  list.replaceChildren(...(kids.length ? kids : [h('div', { class: 'empty' }, 'No parts match that search.')]));
}

// ---- property dialogs ------------------------------------------------------
const field = (label, control) => h('div', { class: 'f' }, h('label', {}, label), control);
const num = (value, onchange, o = {}) => h('input', { type: 'number', value: fmt(value), step: o.step ?? 0.125, min: o.min, max: o.max, onchange: (e) => { const v = parseFloat(e.target.value); if (isFinite(v)) onchange(v); } });
const sel = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, n]) => h('option', { value: v, selected: String(v) === String(value) }, n)));
const btn = (label, onclick, cls = '') => h('button', { class: 'btn ' + cls, onclick }, label);
function changed(part) { syncPart(part); commit(); app.emit('doc'); app.emit('wires-dirty'); app.emit('sel'); }

function transformFields(part) {
  const o = app.objs.get(part.id);
  const moveTo = (axis, v) => {
    const d = new THREE.Vector3();
    d[axis] = v - o.position[axis];
    const s = beginMove([part.id]);
    s.apply(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z));
    s.end();
  };
  const rot = (axis) => {
    const p = o.position.clone(), s = beginMove([part.id]);
    const a = new THREE.Vector3(); a[axis] = 1;
    s.apply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(a, Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)));
    s.end();
  };
  return [
    field('Position', h('div', { class: 'xyz' }, ['x', 'y', 'z'].map((a) => h('input', { type: 'number', step: 0.125, title: a.toUpperCase(), value: fmt(o.position[a]), onchange: (e) => moveTo(a, parseFloat(e.target.value) || 0) })))),
    field('Rotate 90°', h('div', { class: 'btns' }, btn('X', () => rot('x')), btn('Y', () => rot('y')), btn('Z', () => rot('z')))),
  ];
}

function partProps(part) {
  const inf = info(part.id), body = [];
  let title = part.name;
  if (part.kind === 'tube') {
    const solid = TUBE_PROFILES[part.profile].solid;
    body.push(
      field('Profile', sel(part.profile, Object.entries(TUBE_PROFILES).map(([k, p]) => [k, p.name]), (v) => { part.profile = v; if (TUBE_PROFILES[v].solid) part.holes = 0; changed(part); })),
      field('Length', num(part.length, (v) => { part.length = Math.max(0.25, v); changed(part); }, { step: 0.5, min: 0.25 })),
    );
    if (!solid) {
      body.push(
        field('Wall', sel(part.wall, [[0.0625, '1/16"'], [0.125, '1/8"']], (v) => { part.wall = +v; changed(part); })),
        field('Holes', sel(part.holes, [[0, 'None (plain tube)'], [0.5, '#10 on ½" pitch'], [1, '#10 on 1" pitch']], (v) => { part.holes = +v; changed(part); })),
        h('div', { class: 'note' }, `${part.holes ? tubeHoleXs(part.length, part.holes).length + ' holes per row · ' : ''}${fmt(inf.mass, 2)} lb. Drag the orange arrows to change length — holes follow.`),
      );
    }
  } else if (part.kind === 'plate') {
    title = 'Extrude · ' + part.name;
    body.push(
      field('Depth', h('div', { class: 'chips' }, THICKNESSES.map((t) => h('button', { class: 'chip' + (Math.abs(part.thickness - t) < 1e-6 ? ' on' : ''), onclick: () => { part.thickness = lastPlate.thickness = t; changed(part); } }, ({ 0.0625: '1/16', 0.09: '.090', 0.125: '1/8', 0.1875: '3/16', 0.25: '1/4' })[t])))),
      field('Material', sel(part.material, Object.entries(MATERIALS), (v) => { part.material = lastPlate.material = v; changed(part); })),
      field('Flip side', h('input', { type: 'checkbox', checked: !!part.flip, onchange: (e) => { part.flip = e.target.checked; changed(part); } })),
      h('div', { class: 'btns' }, btn('Edit sketch', () => setTool('sketch', { partId: part.id }), 'go')),
      h('div', { class: 'note' }, `${fmt(inf.area, 1)} in² · ${fmt(inf.mass, 2)} lb. Double-click the plate to edit its sketch.`),
    );
  } else {
    const def = LIB[part.def];
    for (const [k, dv] of Object.entries(def.params || {})) {
      body.push(field(k[0].toUpperCase() + k.slice(1), num(part.params?.[k] ?? dv, (v) => { (part.params ||= {})[k] = Math.max(k === 'teeth' ? 8 : 1, Math.min(k === 'teeth' ? 120 : 4, Math.round(v))); changed(part); }, { step: 1 })));
    }
    if (inf.ports.length) {
      const used = usedPorts();
      const n = inf.ports.filter((p) => used.has(portKey({ part: part.id, port: p.id }))).length;
      body.push(h('div', { class: 'note' }, `${inf.ports.length} ports, ${n} wired · ${fmt(inf.mass, 2)} lb`));
    } else body.push(h('div', { class: 'note' }, `${fmt(inf.mass, 2)} lb`));
  }
  body.push(...transformFields(part));
  const mated = app.doc.mates.some((m) => m.a === part.id || m.b === part.id);
  body.push(h('div', { class: 'btns' }, btn('Duplicate', () => duplicateSelection(false)), mated && btn('Detach', detachSelection), btn('Delete', deleteSelection, 'danger')));
  return [title, body];
}

function mateProps(m) {
  const upd = () => { applyMate(m); commit(); app.emit('sel'); };
  const a = partById(m.a)?.name, b = partById(m.b)?.name;
  const body = [
    h('div', { class: 'note' }, `${a} is attached to ${b}. Moving either one moves both.`),
    field('Type', sel(m.type, [['fastened', 'Fastened (rigid)'], ['revolute', 'Revolute (spins)'], ['slider', 'Slider (slides)']], (v) => { m.type = v; m.name = v[0].toUpperCase() + v.slice(1) + ' ' + m.name.split(' ').pop(); commit(); app.emit('doc'); app.emit('sel'); })),
  ];
  if (m.type === 'revolute') {
    body.push(field('Angle', h('input', { type: 'range', min: 0, max: 360, step: 1, value: m.angle, oninput: (e) => { m.angle = +e.target.value; applyMate(m); }, onchange: () => { commit(); } })));
  } else {
    body.push(field('Twist', h('div', { class: 'btns' }, btn('Rotate 90°', () => { m.angle = (m.angle + 90) % 360; upd(); }))));
  }
  body.push(
    field(m.type === 'slider' ? 'Travel' : 'Offset', num(m.offset, (v) => { m.offset = v; upd(); })),
    field('Flip', h('input', { type: 'checkbox', checked: m.flip, onchange: (e) => { m.flip = e.target.checked; upd(); } })),
    h('div', { class: 'btns' }, btn('Delete mate', () => { removeMates([m.id]); commit(); }, 'danger')),
  );
  return [m.name, body];
}

function wireProps(w) {
  const r = rt.get(w.id);
  return [KINDS[w.kind].name, [
    h('div', { class: 'note' }, wireLabel(w)),
    h('div', { class: 'note' }, `Length ${fmt(r?.len || 0, 1)}" · ${w.way.length} pin${w.way.length === 1 ? '' : 's'} · ${w.auto ? 'auto-generated' : 'hand-wired'}`),
    r?.conflicts ? h('div', { class: 'note warn' }, 'This wire could not avoid another wire. Drag one of its handles to give it room.') : null,
    h('div', { class: 'note' }, 'Drag any white handle to reroute through that point — it becomes a blue pin. Double-click a pin to remove it. Other wires are never crossed.'),
    h('div', { class: 'btns' },
      w.way.length ? btn('Clear pins', () => { w.way = []; rerouteOne(w.id); commit(); app.emit('wires'); app.emit('sel'); }) : null,
      btn('Delete wire', () => { removeWires([w.id]); commit(); }, 'danger')),
  ]];
}

function renderProps() {
  const el = $('#props');
  if (inSketch || app.toolName !== 'select' || !app.sel.length) { el.hidden = true; return; }
  let title, body;
  if (app.sel.length > 1) {
    title = `${app.sel.length} items selected`;
    body = [h('div', { class: 'note' }, 'Drag to move them together, G to grab, R to rotate.'),
      h('div', { class: 'btns' }, selParts().length ? btn('Duplicate', () => duplicateSelection(false)) : null, btn('Delete', deleteSelection, 'danger'))];
  } else {
    const s = app.sel[0];
    const it = s.t === 'part' ? partById(s.id) : s.t === 'mate' ? app.doc.mates.find((m) => m.id === s.id) : app.doc.wires.find((w) => w.id === s.id);
    if (!it || (s.t === 'part' && !app.objs.has(s.id))) { el.hidden = true; return; }
    [title, body] = s.t === 'part' ? partProps(it) : s.t === 'mate' ? mateProps(it) : wireProps(it);
  }
  el.hidden = false;
  el.replaceChildren(h('h4', {}, title, h('button', { title: 'Close', onclick: () => select([]) }, '×')), h('div', { class: 'pbody' }, body));
}

// ---- popups ----------------------------------------------------------------
let pop = null;
function closePop() { pop?.remove(); pop = null; }
function openPop(el, x, y) {
  closePop();
  pop = el;
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
}

function contextMenu(x, y) {
  const ids = selParts(), part = ids.length === 1 && partById(ids[0]);
  const item = (label, key, fn) => h('div', { onclick: () => { closePop(); fn(); } }, label, h('kbd', {}, key));
  openPop(h('div', { class: 'pop menu' },
    part?.kind === 'plate' ? item('Edit sketch', 'dbl-click', () => setTool('sketch', { partId: part.id })) : null,
    item('Move', 'G', () => app.tools.modal.start('g')),
    item('Rotate', 'R', () => app.tools.modal.start('r')),
    item('Duplicate', 'Shift+D', () => duplicateSelection(true)),
    item('Detach from mates', '', detachSelection),
    item('Zoom to', 'F', () => frameSelection(false)),
    h('hr'),
    item('Delete', 'Del', deleteSelection),
  ), x, y);
}

function quickMenu() {
  const m = app.mouse, x = m ? m.clientX : innerWidth / 2, y = m ? m.clientY : innerHeight / 3;
  const cmds = [
    { name: 'Extrusion tool', cat: 'Tool · T', run: () => setTool('tube') },
    { name: 'Plate (sketch)', cat: 'Tool · P', run: () => setTool('sketch') },
    { name: 'Mate', cat: 'Tool · M', run: () => setTool('mate') },
    { name: 'Wire', cat: 'Tool · W', run: () => setTool('wire') },
    { name: 'Auto-wire robot', cat: 'Wiring', run: runAutowire },
    ...ITEMS.map((it) => ({ name: it.name, cat: it.cat, tags: it.tags, run: it.place ? () => setTool('place', { ...it.place, drag: true }) : it.run })),
  ];
  let idx = 0, shown = cmds;
  const list = h('div', { class: 'list' });
  const input = h('input', { placeholder: 'Add a part or run a tool…', spellcheck: false });
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = cmds.filter((c) => !q || (c.name + ' ' + (c.tags || '') + ' ' + c.cat).toLowerCase().includes(q)).slice(0, 40);
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((c, i) => h('div', { class: 'it' + (i === idx ? ' on' : ''), onclick: () => { closePop(); c.run(); } }, c.name, h('small', {}, c.cat))));
    list.children[idx]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { idx = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { const c = shown[idx]; closePop(); c?.run(); }
    else if (e.key === 'Escape') closePop();
  });
  openPop(h('div', { class: 'pop quick' }, input, list), x - 20, y - 16);
  draw();
  input.focus();
}

function modal(title, body) {
  const bg = h('div', { class: 'modal-bg', onpointerdown: (e) => { if (e.target === bg) bg.remove(); } },
    h('div', { class: 'modal' }, h('h2', {}, title, h('button', { onclick: () => bg.remove() }, '×')), h('div', { class: 'body' }, body)));
  document.body.append(bg);
}

function showBOM() {
  const groups = new Map();
  let total = 0;
  for (const p of app.doc.parts) {
    const m = info(p.id)?.mass || 0;
    total += m;
    const key = p.kind === 'tube' ? `${TUBE_PROFILES[p.profile].name} — ${fmt(p.length)}"${p.holes ? '' : ' (no holes)'}`
      : p.kind === 'plate' ? `Plate ${fmt(p.thickness)}" ${MATERIALS[p.material]} — ${fmt(info(p.id).area, 1)} in²` : LIB[p.def].name;
    const g = groups.get(key) || { n: 0, m: 0 };
    g.n++; g.m += m;
    groups.set(key, g);
  }
  const wires = new Map();
  for (const w of app.doc.wires) {
    const g = wires.get(w.kind) || { n: 0, len: 0 };
    g.n++; g.len += rt.get(w.id)?.len || 0;
    wires.set(w.kind, g);
  }
  const tr = (cells, tag = 'td') => h('tr', {}, cells.map((c, i) => h(tag, { class: i ? 'n' : '' }, c)));
  modal('Bill of materials', [
    h('table', {}, tr(['Part', 'Qty', 'Weight (lb)'], 'th'), [...groups].sort().map(([k, g]) => tr([k, g.n, fmt(g.m, 2)])), tr(['Total', app.doc.parts.length, fmt(total, 1)], 'th')),
    h('h5', {}, 'Wiring'),
    wires.size ? h('table', {}, tr(['Cable', 'Runs', 'Length (ft)'], 'th'), [...wires].map(([k, g]) => tr([KINDS[k].name, g.n, fmt(g.len / 12 * 1.1, 1)])))
      : h('div', { class: 'note' }, 'No wires yet.'),
    wires.size ? h('div', { class: 'note' }, 'Lengths include 10% slack. Battery weight counts toward the total here; FRC rules weigh the robot without it.') : null,
  ]);
}

function showHelp() {
  const k = (rows) => h('div', { class: 'keys' }, rows.flatMap(([a, b]) => [h('kbd', {}, a), h('span', {}, b)]));
  modal('Controls', [
    h('h5', {}, 'Viewport (Blender)'),
    k([['MMB drag', 'Orbit (Alt+LMB or right-drag also work)'], ['Shift+MMB', 'Pan'], ['Wheel', 'Zoom'], ['1 / 3 / 7', 'Front / right / top view (Shift = opposite)'], ['5', 'Perspective ↔ orthographic'], ['F', 'Frame selection'], ['Home', 'Frame everything'], ['G / R', 'Grab / rotate, then X Y Z to lock an axis, type a number, Enter'], ['Shift+D', 'Duplicate'], ['X or Del', 'Delete']]),
    h('h5', {}, 'Building'),
    k([['T', 'Draw an extrusion: click, drag, click. Length snaps to ½" and holes follow'], ['P', 'Sketch a plate on a plane or face, then ✓ to extrude'], ['Drag a part', 'Slides it; it snaps hole-to-hole or onto faces and mates on its own'], ['M', 'Mate two connectors by hand'], ['S or Shift+A', 'Quick-add palette at the cursor']]),
    h('h5', {}, 'Wiring'),
    k([['Auto-wire', 'Generates battery, breaker, PDH, CAN chain, Ethernet and motor wiring'], ['W', 'Connect two ports by hand'], ['Click a wire', 'Shows handles; drag one to pin the route, double-click a pin to remove it']]),
  ]);
}

// ---- boot ------------------------------------------------------------------
export function initUI() {
  ITEMS = libraryItems();
  const search = h('input', { id: 'libsearch', placeholder: 'Search parts…  (S for quick add)', spellcheck: false, oninput: (e) => renderLibrary(e.target.value) });
  $('#right').append(search, h('div', { id: 'liblist' }));
  renderLibrary();
  setTimeout(() => { makeThumbs(); renderLibrary(search.value); }, 30);

  const vb = (icon, title, fn, id) => h('button', { class: 'vb', title, onclick: fn, html: IC[icon], id });
  const gizmoBtns = () => {
    $('#vb-move').classList.toggle('on', app.gizmoMode === 'translate');
    $('#vb-rot').classList.toggle('on', app.gizmoMode === 'rotate');
  };
  $('#viewbtns').append(
    vb('ortho', 'Perspective / orthographic (5)', () => app.vp.toggleOrtho()),
    vb('frame', 'Frame everything (Home)', () => frameSelection(true)),
    vb('move', 'Move gizmo (arrows on the selected part)', () => setGizmoMode(app.gizmoMode === 'translate' ? 'off' : 'translate'), 'vb-move'),
    vb('rotate', 'Rotate gizmo (rings on the selected part)', () => setGizmoMode(app.gizmoMode === 'rotate' ? 'off' : 'rotate'), 'vb-rot'),
  );
  app.on('gizmo', gizmoBtns);
  gizmoBtns();

  const name = $('#docname');
  name.addEventListener('change', () => { app.doc.name = name.value || 'Untitled robot'; commit(); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

  let dirty = true;
  const refresh = () => { dirty = true; };
  for (const ev of ['doc', 'sel', 'wires', 'history', 'moved']) app.on(ev, refresh);
  app.on('tool', () => { renderToolbar(); renderProps(); closePop(); });
  app.on('sketch', (on) => { inSketch = on; renderToolbar(); renderProps(); });
  app.on('sketch-sub', renderToolbar);
  app.on('hint', (t) => { $('#hint').textContent = t; });
  app.on('toast', (text, kind) => {
    const el = h('div', { class: 'toast ' + kind }, text);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 3800);
  });
  app.on('ctxmenu', contextMenu);
  app.on('quick', quickMenu);
  window.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);

  app.vp.frameHooks.push(() => {
    if (!dirty) return;
    dirty = false;
    if (document.activeElement !== name) name.value = app.doc.name;
    renderToolbar(); renderTree(); renderStats();
    // don't rebuild a dialog the user is typing in
    if (!$('#props').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') renderProps();
  });
}
