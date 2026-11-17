// FRC parts library. Every part is procedural: a build() function returns a
// THREE.Group plus the electrical ports and mate connectors it exposes.
// Units are inches, +Z is up, and (unless noted) the origin is the centre of
// the mounting face so parts drop straight onto plates and tubes.
import * as THREE from 'three';

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...o });
export const MAT = {
  alu: std(0xc9ced6, { metalness: 0.85, roughness: 0.38 }),
  steel: std(0x8c9096, { metalness: 0.9, roughness: 0.3 }),
  black: std(0x1b1c1f, { roughness: 0.6 }),
  dark: std(0x33363b, { roughness: 0.6 }),
  grey: std(0x8a8f96),
  light: std(0xdcdee2, { roughness: 0.5 }),
  white: std(0xf4f4f4),
  orange: std(0xf26a21),
  red: std(0xd92b2b),
  green: std(0x3aa64a),
  lime: std(0x86d12c),
  blue: std(0x2a6fdb),
  yellow: std(0xf2c230),
  gold: std(0xc9a13b, { metalness: 0.7, roughness: 0.35 }),
  rubber: std(0x222326, { roughness: 0.95 }),
  copper: std(0xc77b3a, { metalness: 0.8, roughness: 0.35 }),
  rsl: std(0xff8a1f, { emissive: 0xff6a00, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 }),
  pc: new THREE.MeshPhysicalMaterial({
    color: 0xbfe0ff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32,
    depthWrite: false, side: THREE.DoubleSide,
  }),
};

export const box = (w, d, h, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z);
  return m;
};
export const cyl = (r, h, mat, x = 0, y = 0, z = 0, axis = 'z', seg = 32) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
};
const group = (...ms) => { const g = new THREE.Group(); g.add(...ms); return g; };
const port = (id, type, role, p, d, name) => ({ id, type, role, p, d, name: name || id });
const BOTTOM = [{ p: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] }];

// ---- shapes ----------------------------------------------------------------
const HEX_R = 0.25 / Math.cos(Math.PI / 6);
function hexPath(r = HEX_R) {
  const p = new THREE.Path();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
  }
  p.closePath();
  return p;
}
function toothed(teeth, rOut, rRoot, width, mat, tip = 0.3) {
  const s = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2, st = (Math.PI * 2) / teeth;
    const pts = [[a, rRoot], [a + st * (0.5 - tip) / 2, rOut], [a + st * (0.5 + tip) / 2, rOut], [a + st * 0.5, rRoot]];
    for (const [an, r] of pts) s[i || an !== a ? 'lineTo' : 'moveTo'](Math.cos(an) * r, Math.sin(an) * r);
  }
  s.closePath();
  s.holes.push(hexPath());
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -width / 2);
  return new THREE.Mesh(g, mat);
}
function disc(r, width, mat, bore = HEX_R) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2);
  if (bore) s.holes.push(hexPath(bore));
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, -width / 2);
  return new THREE.Mesh(g, mat);
}
const faces = (w) => [
  { p: [0, 0, w / 2], z: [0, 0, 1], x: [1, 0, 0] },
  { p: [0, 0, -w / 2], z: [0, 0, -1], x: [1, 0, 0] },
];

// ---- builders --------------------------------------------------------------
function motor({ r, len, body, cap, shaftR = 0.16, shaftLen = 1, integrated, mass }) {
  const g = group(
    cyl(r, len - 0.5, body, 0, 0, -(len - 0.5) / 2),
    cyl(r * 0.97, 0.5, cap, 0, 0, -len + 0.25),
    cyl(r * 0.35, 0.12, MAT.alu, 0, 0, 0.06),
    cyl(shaftR, shaftLen, MAT.steel, 0, 0, shaftLen / 2, 'z', 12),
  );
  const z = -len + 0.45;
  const ports = integrated
    ? [port('PWR', 'pwr', 'in', [r, 0, z], [1, 0, 0], 'Power'),
      port('CANA', 'can', 'io', [0, r, z], [0, 1, 0], 'CAN A'),
      port('CANB', 'can', 'io', [0, -r, z], [0, -1, 0], 'CAN B')]
    : [port('PHASE', 'phase', 'in', [r, 0, z], [1, 0, 0], 'Motor leads')];
  return { obj: g, ports, connectors: [{ p: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }], mass };
}

function controller(body, accent, mass) {
  const g = group(
    box(2.76, 1.38, 0.9, body, 0, 0, 0.45),
    box(1.4, 1.0, 0.06, accent, 0, 0, 0.93),
    box(0.3, 0.9, 0.3, MAT.dark, -1.5, 0, 0.45), box(0.3, 0.9, 0.3, MAT.dark, 1.5, 0, 0.45),
  );
  return {
    obj: g, mass, connectors: BOTTOM,
    ports: [
      port('PWR', 'pwr', 'in', [-1.65, -0.35, 0.45], [-1, 0, 0], 'Power in'),
      port('CANA', 'can', 'io', [-1.65, 0.35, 0.45], [-1, 0, 0], 'CAN A'),
      port('MOTOR', 'phase', 'out', [1.65, -0.35, 0.45], [1, 0, 0], 'Motor out'),
      port('CANB', 'can', 'io', [1.65, 0.35, 0.45], [1, 0, 0], 'CAN B'),
    ],
  };
}

function canSensor(size, h, body, accent, mass) {
  const s = size / 2;
  return {
    obj: group(box(size, size, h, body, 0, 0, h / 2), cyl(size * 0.28, 0.05, accent, 0, 0, h + 0.02)),
    mass, connectors: BOTTOM,
    ports: [
      port('PWR', 'pwr', 'in', [-s, 0, h / 2], [-1, 0, 0], 'Power'),
      port('CANA', 'can', 'io', [0, s, h / 2], [0, 1, 0], 'CAN A'),
      port('CANB', 'can', 'io', [0, -s, h / 2], [0, -1, 0], 'CAN B'),
    ],
  };
}

function wheel(r, w, hub, tread, mass, rollers = 0) {
  const t = new THREE.Mesh(new THREE.TorusGeometry(r - 0.2, 0.2, 10, 40), tread);
  t.scale.set(1, 1, w / 0.4);
  const g = group(disc(r - 0.25, w * 0.7, hub), t);
  for (let i = 0; i < rollers; i++) {
    const a = (i / rollers) * Math.PI * 2;
    const m = cyl(0.3, 0.7, MAT.rubber, Math.cos(a) * (r - 0.3), Math.sin(a) * (r - 0.3), 0, 'y', 10);
    m.rotation.z = a;
    g.add(m);
  }
  return { obj: g, ports: [], connectors: faces(w), mass };
}

function swerve() {
  const g = group(
    box(6, 6, 0.25, MAT.dark, 0, 0, 0.125),
    // wheel + fork, tucked inboard so it clears the frame rails
    box(2.4, 0.2, 2.6, MAT.alu, 1, 1.95, -1.1), box(2.4, 0.2, 2.6, MAT.alu, 1, 0.05, -1.1),
    cyl(2.2, 0.3, MAT.alu, 1, 1, -0.1),
    // motors (shaft down) + encoder
    cyl(1.18, 3.4, MAT.black, -1.5, 1.5, 1.95), cyl(1.18, 3.4, MAT.black, 1.5, -1.5, 1.95),
    cyl(1.2, 0.12, MAT.gold, -1.5, 1.5, 3.2), cyl(1.2, 0.12, MAT.gold, 1.5, -1.5, 3.2),
    box(1.5, 1.5, 0.6, MAT.dark, 1.3, 1.3, 0.55), cyl(0.4, 0.05, MAT.orange, 1.3, 1.3, 0.87),
  );
  const w = cyl(2, 1.5, MAT.rubber, 1, 1, -1.25, 'y');
  const hub = cyl(1.3, 1.52, MAT.alu, 1, 1, -1.25, 'y');
  g.add(w, hub);
  const connectors = [...BOTTOM];
  for (const x of [-2.5, 2.5]) for (const y of [-2.5, 2.5]) connectors.push({ p: [x, y, 0], z: [0, 0, -1], x: [1, 0, 0] });
  return {
    obj: g, mass: 7.6, connectors,
    ports: [
      port('DRV', 'pwr', 'in', [-1.5, 1.5, 3.65], [0, 0, 1], 'Drive power'),
      port('STR', 'pwr', 'in', [1.5, -1.5, 3.65], [0, 0, 1], 'Steer power'),
      port('CANA', 'can', 'io', [-2.68, 1.5, 3.1], [-1, 0, 0], 'CAN A'),
      port('CANB', 'can', 'io', [1.5, -2.68, 3.1], [0, -1, 0], 'CAN B'),
    ],
  };
}

// ---- catalogue -------------------------------------------------------------
export const CATS = ['Structure', 'Drivetrain', 'Motors', 'Control system', 'Sensors', 'Motion', 'Pneumatics'];

export const LIB = {
  swerve: { name: 'Swerve Module', cat: 'Drivetrain', tags: 'mk4i sds swerve x2 thrifty', build: swerve },
  wheel4: { name: 'Traction Wheel 4"', cat: 'Drivetrain', tags: 'colson hitech', build: () => wheel(2, 1, MAT.alu, MAT.rubber, 0.35) },
  wheel6: { name: 'Traction Wheel 6"', cat: 'Drivetrain', tags: 'kitbot', build: () => wheel(3, 1, MAT.white, MAT.rubber, 0.6) },
  omni4: { name: 'Omni Wheel 4"', cat: 'Drivetrain', tags: 'omni', build: () => wheel(2, 1, MAT.dark, MAT.grey, 0.4, 12) },
  compliant4: { name: 'Compliant Wheel 4"', cat: 'Drivetrain', tags: 'flex intake stealth', build: () => wheel(2, 1, MAT.light, MAT.green, 0.2) },

  kraken: { name: 'Kraken X60', cat: 'Motors', tags: 'wcp talon fx brushless', build: () => motor({ r: 1.18, len: 3.4, body: MAT.black, cap: MAT.gold, integrated: true, mass: 1.2 }) },
  falcon: { name: 'Falcon 500', cat: 'Motors', tags: 'ctre talon fx brushless', build: () => motor({ r: 1.18, len: 3.1, body: MAT.black, cap: MAT.lime, integrated: true, mass: 1.1 }) },
  neo: { name: 'NEO', cat: 'Motors', tags: 'rev brushless', build: () => motor({ r: 1.18, len: 2.3, body: MAT.black, cap: MAT.orange, mass: 0.94 }) },
  neo550: { name: 'NEO 550', cat: 'Motors', tags: 'rev brushless small', build: () => motor({ r: 0.69, len: 1.75, body: MAT.black, cap: MAT.orange, shaftR: 0.06, shaftLen: 0.5, mass: 0.31 }) },
  cim: { name: 'CIM', cat: 'Motors', tags: 'brushed', build: () => motor({ r: 1.25, len: 4.34, body: MAT.grey, cap: MAT.dark, mass: 2.8 }) },
  sparkmax: { name: 'SPARK MAX', cat: 'Motors', tags: 'rev motor controller', build: () => controller(MAT.black, MAT.orange, 0.25) },
  talonsrx: { name: 'Talon SRX', cat: 'Motors', tags: 'ctre motor controller', build: () => controller(MAT.dark, MAT.lime, 0.23) },

  roborio: {
    name: 'roboRIO 2', cat: 'Control system', tags: 'ni rio brain controller',
    build: () => ({
      obj: group(box(5.7, 5.6, 1.1, MAT.light, 0, 0, 0.55), box(4.6, 3.2, 0.1, MAT.dark, 0, 0.6, 1.15),
        box(5.2, 0.9, 0.35, MAT.black, 0, -2.1, 1.25)),
      mass: 0.76, connectors: BOTTOM,
      ports: [
        port('PWR', 'pwr', 'in', [-2.85, 1.8, 0.55], [-1, 0, 0], 'Power in'),
        port('CAN', 'can', 'io', [-2.85, 0.6, 0.55], [-1, 0, 0], 'CAN'),
        port('RSL', 'sig', 'out', [-2.85, -0.6, 0.55], [-1, 0, 0], 'RSL'),
        port('ETH', 'eth', 'io', [2.85, -1.5, 0.55], [1, 0, 0], 'Ethernet'),
      ],
    }),
  },
  pdh: {
    name: 'Power Distribution Hub', cat: 'Control system', tags: 'rev pdh pdp power',
    build: () => {
      const g = group(box(8.7, 4.4, 1.1, MAT.black, 0, 0, 0.55), box(8.0, 1.6, 0.12, MAT.orange, 0, 0, 1.15));
      const ports = [port('IN', 'batt', 'in', [-4.35, 0.8, 0.6], [-1, 0, 0], 'Battery in'),
        port('CAN', 'can', 'io', [-4.35, -0.8, 0.6], [-1, 0, 0], 'CAN')];
      for (let i = 0; i < 10; i++) {
        const x = -3.15 + i * 0.7;
        ports.push(port('CH' + i, 'pwr', 'out', [x, 2.2, 0.6], [0, 1, 0], 'Channel ' + i));
        ports.push(port('CH' + (i + 10), 'pwr', 'out', [x, -2.2, 0.6], [0, -1, 0], 'Channel ' + (i + 10)));
        g.add(box(0.4, 0.5, 0.5, MAT.dark, x, 1.9, 0.9), box(0.4, 0.5, 0.5, MAT.dark, x, -1.9, 0.9));
      }
      for (let i = 0; i < 4; i++) ports.push(port('CH' + (20 + i), 'pwr', 'out', [4.35, -1.2 + i * 0.8, 0.6], [1, 0, 0], 'Channel ' + (20 + i)));
      return { obj: g, ports, connectors: BOTTOM, mass: 1.1 };
    },
  },
  battery: {
    name: 'Battery 12V', cat: 'Control system', tags: 'sla power',
    build: () => ({
      obj: group(box(7.1, 3, 6.3, MAT.black, 0, 0, 3.15), box(7.1, 3, 0.3, MAT.dark, 0, 0, 6.45),
        box(7.12, 3.02, 1.6, MAT.yellow, 0, 0, 3.4), cyl(0.3, 0.3, MAT.red, 2.8, 0.6, 6.7), cyl(0.3, 0.3, MAT.dark, 2.8, -0.6, 6.7)),
      mass: 12.5, connectors: BOTTOM,
      ports: [port('OUT', 'batt', 'out', [2.8, 0, 6.8], [0, 0, 1], 'Terminals')],
    }),
  },
  breaker: {
    name: 'Main Breaker 120A', cat: 'Control system', tags: 'power switch',
    build: () => ({
      obj: group(box(3, 1.9, 1.3, MAT.black, 0, 0, 0.65), cyl(0.45, 0.4, MAT.red, 0, 0, 1.45),
        cyl(0.2, 0.3, MAT.copper, -1.1, 0, 1.4), cyl(0.2, 0.3, MAT.copper, 1.1, 0, 1.4)),
      mass: 0.3, connectors: BOTTOM,
      ports: [port('BATT', 'batt', 'in', [-1.5, 0, 0.8], [-1, 0, 0], 'Battery side'),
        port('LOAD', 'batt', 'out', [1.5, 0, 0.8], [1, 0, 0], 'Load side')],
    }),
  },
  radio: {
    name: 'Radio VH-109', cat: 'Control system', tags: 'vivid hosting wifi robot radio',
    build: () => ({
      obj: group(box(4.5, 3.2, 1.0, MAT.dark, 0, 0, 0.5), box(3.6, 2.2, 0.08, MAT.white, 0, 0, 1.03)),
      mass: 0.5, connectors: BOTTOM,
      ports: [
        port('PWR', 'pwr', 'in', [-2.25, 1.0, 0.5], [-1, 0, 0], '12V in'),
        port('RIO', 'eth', 'io', [-2.25, 0, 0.5], [-1, 0, 0], 'RIO port'),
        port('AUX1', 'eth', 'io', [-2.25, -1.0, 0.5], [-1, 0, 0], 'AUX 1'),
        port('AUX2', 'eth', 'io', [2.25, 0, 0.5], [1, 0, 0], 'AUX 2'),
      ],
    }),
  },
  rsl: {
    name: 'Robot Signal Light', cat: 'Control system', tags: 'rsl light',
    build: () => ({
      obj: group(cyl(1.2, 0.6, MAT.black, 0, 0, 0.3), cyl(1.05, 2, MAT.rsl, 0, 0, 1.6)),
      mass: 0.3, connectors: BOTTOM,
      ports: [port('SIG', 'sig', 'in', [1.2, 0, 0.3], [1, 0, 0], 'Signal')],
    }),
  },

  cancoder: { name: 'CANcoder', cat: 'Sensors', tags: 'ctre encoder absolute', build: () => canSensor(1.5, 0.6, MAT.dark, MAT.lime, 0.05) },
  pigeon: { name: 'Pigeon 2.0', cat: 'Sensors', tags: 'ctre gyro imu', build: () => canSensor(1.8, 0.6, MAT.black, MAT.lime, 0.06) },
  limelight: {
    name: 'Limelight', cat: 'Sensors', tags: 'camera vision apriltag',
    build: () => ({
      obj: group(box(3.8, 1.2, 2.2, MAT.lime, 0, 0, 1.1), cyl(0.5, 0.3, MAT.black, 0, -0.7, 1.1, 'y'),
        cyl(0.18, 0.1, MAT.white, -1.2, -0.62, 1.1, 'y'), cyl(0.18, 0.1, MAT.white, 1.2, -0.62, 1.1, 'y')),
      mass: 0.3, connectors: BOTTOM,
      ports: [port('PWR', 'pwr', 'in', [-0.9, 0.6, 1.1], [0, 1, 0], 'Power'),
        port('ETH', 'eth', 'io', [0.9, 0.6, 1.1], [0, 1, 0], 'Ethernet')],
    }),
  },

  gear: {
    name: 'Spur Gear (20 DP)', cat: 'Motion', tags: 'gear hex', params: { teeth: 40 },
    build: ({ teeth }) => ({ obj: group(toothed(teeth, teeth / 40 + 0.05, teeth / 40 - 0.06, 0.5, MAT.alu)), ports: [], connectors: faces(0.5), mass: 0.004 * teeth }),
  },
  sprocket: {
    name: 'Sprocket (#25)', cat: 'Motion', tags: 'chain hex', params: { teeth: 22 },
    build: ({ teeth }) => {
      const pr = 0.125 / Math.sin(Math.PI / teeth);
      return { obj: group(toothed(teeth, pr + 0.07, pr - 0.07, 0.11, MAT.steel, 0.1), disc(Math.min(0.6, pr - 0.15), 0.5, MAT.steel)), ports: [], connectors: faces(0.5), mass: 0.006 * teeth };
    },
  },
  pulley: {
    name: 'Timing Pulley (HTD 5mm)', cat: 'Motion', tags: 'belt hex', params: { teeth: 24 },
    build: ({ teeth }) => {
      const pr = (teeth * 5) / (2 * Math.PI) / 25.4;
      return {
        obj: group(toothed(teeth, pr, pr - 0.06, 0.6, MAT.alu, 0.45), disc(pr + 0.08, 0.06, MAT.alu).translateZ(0.33), disc(pr + 0.08, 0.06, MAT.alu).translateZ(-0.33)),
        ports: [], connectors: faces(0.72), mass: 0.004 * teeth,
      };
    },
  },
  bearing: {
    name: 'Hex Bearing 1/2"', cat: 'Motion', tags: 'flanged',
    build: () => ({ obj: group(disc(0.5625, 0.3125, MAT.steel), disc(0.68, 0.06, MAT.steel).translateZ(0.13)), ports: [], connectors: faces(0.3125), mass: 0.06 }),
  },
  planetary: {
    name: 'MAXPlanetary Gearbox', cat: 'Motion', tags: 'rev gearbox versaplanetary', params: { stages: 2 },
    build: ({ stages }) => {
      const len = 1.1 + 0.55 * stages;
      return {
        obj: group(box(1.9, 1.9, len, MAT.dark, 0, 0, -len / 2), box(1.95, 1.95, 0.25, MAT.orange, 0, 0, -len + 0.4),
          cyl(HEX_R, 1.2, MAT.steel, 0, 0, 0.6, 'z', 6)),
        ports: [], connectors: [{ p: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, { p: [0, 0, -len], z: [0, 0, -1], x: [1, 0, 0] }], mass: 0.5 + 0.3 * stages,
      };
    },
  },

  phub: {
    name: 'Pneumatic Hub', cat: 'Pneumatics', tags: 'rev ph pcm solenoid',
    build: () => ({
      obj: group(box(4.3, 3, 1.0, MAT.black, 0, 0, 0.5), box(3.4, 1.2, 0.1, MAT.orange, 0, 0, 1.05)),
      mass: 0.4, connectors: BOTTOM,
      ports: [
        port('PWR', 'pwr', 'in', [-2.15, 0.9, 0.5], [-1, 0, 0], 'Power in'),
        port('CANA', 'can', 'io', [-2.15, 0, 0.5], [-1, 0, 0], 'CAN A'),
        port('CANB', 'can', 'io', [-2.15, -0.9, 0.5], [-1, 0, 0], 'CAN B'),
        port('COMP', 'comp', 'out', [2.15, 0, 0.5], [1, 0, 0], 'Compressor out'),
      ],
    }),
  },
  compressor: {
    name: 'Compressor', cat: 'Pneumatics', tags: 'viair air',
    build: () => ({
      obj: group(box(2.2, 4.6, 0.4, MAT.dark, 0, 0, 0.2), cyl(1.0, 3.6, MAT.grey, 0, 0.3, 1.4, 'y'),
        box(1.6, 1.4, 2.4, MAT.dark, 0, -1.5, 1.6)),
      mass: 2.4, connectors: BOTTOM,
      ports: [port('PWR', 'comp', 'in', [0, -2.3, 1.4], [0, -1, 0], 'Power')],
    }),
  },
  tank: {
    name: 'Air Tank', cat: 'Pneumatics', tags: 'clippard reservoir',
    build: () => ({ obj: group(cyl(1.05, 6, MAT.white, 0, 0, 1.05, 'x'), cyl(0.2, 6.6, MAT.gold, 0, 0, 1.05, 'x')), ports: [], connectors: BOTTOM, mass: 0.5 }),
  },
  cylinder: {
    name: 'Pneumatic Cylinder', cat: 'Pneumatics', tags: 'piston actuator bimba',
    build: () => ({
      obj: group(cyl(0.55, 6, MAT.alu, 3, 0, 0, 'x'), cyl(0.16, 3, MAT.steel, 7.5, 0, 0, 'x', 12), box(0.5, 0.8, 0.8, MAT.dark, 0.25, 0, 0)),
      ports: [], connectors: [{ p: [0, 0, 0], z: [-1, 0, 0], x: [0, 1, 0] }, { p: [9, 0, 0], z: [1, 0, 0], x: [0, 1, 0] }], mass: 0.6,
    }),
  },
};

// Plates that ship in the library are ordinary editable sketches.
const hole = (x, y) => ({ t: 'circle', x, y, d: 0.196 });
export const PLATE_PRESETS = {
  gussetL: {
    name: 'L Gusset 90°', cat: 'Structure', tags: 'gusset corner bracket',
    sketch: [{ t: 'poly', closed: true, pts: [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]] },
      hole(0.5, 0.5), hole(1.5, 0.5), hole(2.5, 0.5), hole(0.5, 1.5), hole(0.5, 2.5)],
  },
  gussetT: {
    name: 'T Gusset', cat: 'Structure', tags: 'gusset tee bracket',
    sketch: [{ t: 'poly', closed: true, pts: [[0, 0], [4, 0], [4, 1], [2.5, 1], [2.5, 3], [1.5, 3], [1.5, 1], [0, 1]] },
      hole(0.5, 0.5), hole(1.5, 0.5), hole(2.5, 0.5), hole(3.5, 0.5), hole(2, 1.5), hole(2, 2.5)],
  },
  gussetTri: {
    name: 'Triangle Gusset', cat: 'Structure', tags: 'gusset brace',
    sketch: [{ t: 'poly', closed: true, pts: [[0, 0], [3.5, 0], [3.5, 0.5], [0.5, 3.5], [0, 3.5]] },
      hole(0.5, 0.5), hole(1.5, 0.5), hole(2.5, 0.5), hole(0.5, 1.5), hole(0.5, 2.5)],
  },
  bearingPlate: {
    name: 'Bearing Plate 3×3', cat: 'Structure', tags: 'plate bearing block',
    sketch: [{ t: 'rect', x: 0, y: 0, w: 3, h: 3 }, { t: 'circle', x: 1.5, y: 1.5, d: 1.125 },
      hole(0.5, 0.5), hole(2.5, 0.5), hole(0.5, 2.5), hole(2.5, 2.5)],
  },
};

export const TUBE_PROFILES = {
  '2x1': { name: 'Tube 2×1', w: 1, h: 2 },
  '1x1': { name: 'Tube 1×1', w: 1, h: 1 },
  '2x2': { name: 'Tube 2×2', w: 2, h: 2 },
  hex: { name: 'Hex Shaft 1/2"', w: 0.5, h: 0.5, solid: true },
};
