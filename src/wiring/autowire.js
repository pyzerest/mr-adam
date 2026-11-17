// Auto-wiring: looks at which electrical parts are on the robot and generates
// the harness an FRC inspector expects to see. Routing happens afterwards.
import { app } from '../app.js';
import { info } from '../doc.js';
import { addWire, portWorld, portKey } from './wires.js';

export function autowire() {
  const doc = app.doc, warnings = [];
  // Keep hand-made wires, and auto wires the user has pinned; rebuild the rest.
  const before = doc.wires;
  doc.wires = before.filter((w) => !w.auto);
  const prior = new Map(before.filter((w) => w.auto).map((w) => [portKey(w.a) + '>' + portKey(w.b), w]));
  const used = new Set(doc.wires.flatMap((w) => [portKey(w.a), portKey(w.b)]));
  let made = 0;

  const ports = []; // every port on the robot, with world position
  for (const part of doc.parts) {
    for (const p of info(part.id)?.ports || []) {
      ports.push({ part, port: p, ref: { part: part.id, port: p.id }, pos: portWorld(part.id, p.id).p });
    }
  }
  const free = (x) => !used.has(portKey(x.ref));
  const of = (def) => doc.parts.filter((p) => p.def === def);
  const find = (part, id) => ports.find((x) => x.part === part && x.port.id === id);
  const link = (a, b, kind) => {
    if (!a || !b || !free(a) || !free(b)) return false;
    const key = portKey(a.ref) + '>' + portKey(b.ref);
    const old = prior.get(key);
    if (old) doc.wires.push(old); else addWire(a.ref, b.ref, kind, true);
    used.add(portKey(a.ref)); used.add(portKey(b.ref));
    made++;
    return true;
  };
  const nearest = (from, cands) => cands.filter(free).sort((a, b) => a.pos.distanceTo(from.pos) - b.pos.distanceTo(from.pos))[0];

  const battery = of('battery')[0], breaker = of('breaker')[0], pdh = of('pdh')[0], rio = of('roborio')[0], radio = of('radio')[0];

  // 1. Battery -> main breaker -> power distribution
  if (!battery) warnings.push('No battery on the robot.');
  if (!pdh) warnings.push('No Power Distribution Hub — nothing can be powered.');
  if (battery && pdh) {
    if (breaker) {
      link(find(battery, 'OUT'), find(breaker, 'BATT'), 'batt');
      link(find(breaker, 'LOAD'), find(pdh, 'IN'), 'batt');
    } else {
      warnings.push('No main breaker between the battery and the PDH.');
      link(find(battery, 'OUT'), find(pdh, 'IN'), 'batt');
    }
  }

  // 2. Motors without a built-in controller -> nearest free motor controller
  const outs = ports.filter((x) => x.port.type === 'phase' && x.port.role === 'out');
  for (const m of ports.filter((x) => x.port.type === 'phase' && x.port.role === 'in' && free(x))) {
    const c = nearest(m, outs);
    if (c) link(c, m, 'phase');
    else warnings.push(`${m.part.name} has no motor controller (add a SPARK MAX or Talon SRX).`);
  }

  // 3. Every power consumer -> nearest free PDH channel (closest devices first)
  if (pdh) {
    const chans = ports.filter((x) => x.part === pdh && x.port.type === 'pwr');
    const centre = find(pdh, 'IN').pos;
    const loads = ports.filter((x) => x.port.type === 'pwr' && x.port.role === 'in' && free(x))
      .sort((a, b) => a.pos.distanceTo(centre) - b.pos.distanceTo(centre));
    for (const l of loads) {
      const c = nearest(l, chans);
      if (c) link(c, l, 'pwr');
      else warnings.push(`PDH is out of channels — ${l.part.name} is unpowered.`);
    }
  }

  // 4. Compressor -> Pneumatic Hub
  const compOut = ports.filter((x) => x.port.type === 'comp' && x.port.role === 'out');
  for (const c of ports.filter((x) => x.port.type === 'comp' && x.port.role === 'in' && free(x))) {
    const h = nearest(c, compOut);
    if (h) link(h, c, 'comp'); else warnings.push(`${c.part.name} needs a Pneumatic Hub.`);
  }

  // 5. CAN bus: one daisy chain, roboRIO first, PDH (terminator) last,
  //    always hopping to the nearest device that is not on the bus yet.
  const canParts = doc.parts.filter((p) => p !== rio && p !== pdh
    && ports.some((x) => x.part === p && x.port.type === 'can' && free(x)));
  if (canParts.length || (rio && pdh)) {
    if (!rio) warnings.push('No roboRIO — the CAN bus has no controller.');
    let cur = rio ? find(rio, 'CAN') : null;
    const todo = new Set(canParts);
    if (!cur && todo.size) {
      const first = [...todo][0];
      todo.delete(first);
      cur = find(first, 'CANB');
    }
    while (cur && todo.size) {
      let best = null, bd = Infinity;
      for (const p of todo) {
        const cand = ports.filter((x) => x.part === p && x.port.type === 'can' && free(x));
        for (const c of cand) {
          const d = c.pos.distanceTo(cur.pos);
          if (d < bd) { bd = d; best = c; }
        }
      }
      if (!best) break;
      todo.delete(best.part);
      link(cur, best, 'can');
      cur = ports.find((x) => x.part === best.part && x.port.type === 'can' && free(x));
    }
    if (cur && pdh) link(cur, find(pdh, 'CAN'), 'can');
  }

  // 6. Ethernet: roboRIO and cameras into the radio
  if (radio) {
    if (rio) link(find(rio, 'ETH'), find(radio, 'RIO'), 'eth');
    const aux = ports.filter((x) => x.part === radio && x.port.type === 'eth');
    for (const e of ports.filter((x) => x.port.type === 'eth' && x.part !== radio && x.part !== rio && free(x))) {
      const a = nearest(e, aux);
      if (a) link(e, a, 'eth'); else warnings.push(`${e.part.name}: radio is out of Ethernet ports (add a switch).`);
    }
  } else if (rio) warnings.push('No radio on the robot.');

  // 7. Robot signal light
  const rsl = of('rsl')[0];
  if (rio && rsl) link(find(rio, 'RSL'), find(rsl, 'SIG'), 'sig');
  else if (rio && !rsl) warnings.push('No Robot Signal Light.');

  app.warnings = warnings;
  app.emit('doc'); app.emit('wires-dirty');
  return { made, warnings };
}
