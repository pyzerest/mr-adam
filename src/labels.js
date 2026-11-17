// Small HTML labels pinned to 3D points (dimensions, port names, hints).
import { app } from './app.js';

const sets = new Map(); // key -> [{el, pos}]
let layer;

export function initLabels(el) {
  layer = el;
  app.vp.frameHooks.push(() => {
    for (const list of sets.values()) {
      for (const l of list) {
        const s = app.vp.toScreen(l.pos);
        l.el.style.display = s.visible ? '' : 'none';
        l.el.style.transform = `translate(-50%, -50%) translate(${s.x}px, ${s.y}px)`;
      }
    }
  });
}

// items: [{pos: Vector3, text, cls?, edit?: (number) => void}]
export function setLabels(key, items = []) {
  for (const l of sets.get(key) || []) l.el.remove();
  const list = items.map((it) => {
    const el = document.createElement('div');
    el.className = 'label ' + (it.cls || '') + (it.edit ? ' editable' : '');
    el.textContent = it.text;
    if (it.edit) {
      el.title = 'Click to type a value';
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        const inp = document.createElement('input');
        inp.value = it.text.replace(/[^0-9.\-]/g, '');
        el.textContent = ''; el.appendChild(inp);
        inp.focus(); inp.select();
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          const v = parseFloat(inp.value);
          if (ok && isFinite(v) && v > 0) it.edit(v); else el.textContent = it.text;
        };
        inp.addEventListener('keydown', (k) => {
          k.stopPropagation();
          if (k.key === 'Enter') finish(true);
          if (k.key === 'Escape') finish(false);
        });
        inp.addEventListener('blur', () => finish(true));
        inp.addEventListener('pointerdown', (p) => p.stopPropagation());
      });
    }
    layer.appendChild(el);
    return { el, pos: it.pos };
  });
  sets.set(key, list);
}
