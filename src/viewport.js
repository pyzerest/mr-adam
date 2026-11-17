// Blender-style 3D viewport: Z-up turntable orbit, MMB navigation, numpad
// views with auto-ortho, floor grid with coloured axes, and a nav gizmo.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const FOV = 40;
const EPS = 0.0005;

export class Viewport {
  constructor(el, gizmoCanvas) {
    this.el = el;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(r.domElement);
    this.dom = r.domElement;

    const s = (this.scene = new THREE.Scene());
    s.background = new THREE.Color(0x3b3b3b);
    const pm = new THREE.PMREMGenerator(r);
    s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.75;
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(30, -40, 80);
    s.add(sun, new THREE.HemisphereLight(0xffffff, 0x444444, 0.5));

    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.5, 6000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 12000);
    this.persp.up.set(0, 0, 1); this.ortho.up.set(0, 0, 1);
    this.isOrtho = false; this.autoOrtho = false;
    this.target = new THREE.Vector3(0, 0, 6);
    this.radius = 95; this.theta = -1.05; this.phi = 1.05;

    this.parts = new THREE.Group();
    this.wires = new THREE.Group();
    this.overlay = new THREE.Group();
    s.add(this.grid(), this.parts, this.wires, this.overlay);

    this.raycaster = new THREE.Raycaster();
    this.frameHooks = [];
    this.gizmo = gizmoCanvas;
    this.initGizmo();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  get camera() { return this.isOrtho ? this.ortho : this.persp; }

  grid() {
    const g = new THREE.Group();
    const mk = (size, div, color, op) => {
      const h = new THREE.GridHelper(size, div, color, color);
      h.rotation.x = Math.PI / 2;
      h.material.transparent = true; h.material.opacity = op; h.material.depthWrite = false;
      return h;
    };
    g.add(mk(240, 240, 0x4a4a4a, 0.55), mk(240, 20, 0x5c5c5c, 0.9));
    const axis = (a, b, color) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      l.renderOrder = 1;
      return l;
    };
    g.add(axis(new THREE.Vector3(-120, 0, 0.002), new THREE.Vector3(120, 0, 0.002), 0xb5434f));
    g.add(axis(new THREE.Vector3(0, -120, 0.002), new THREE.Vector3(0, 120, 0.002), 0x6f9a2e));
    return g;
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h);
    this.updateCamera();
  }

  updateCamera() {
    this.phi = Math.min(Math.PI - EPS, Math.max(EPS, this.phi));
    const sp = Math.sin(this.phi);
    const dir = new THREE.Vector3(sp * Math.cos(this.theta), sp * Math.sin(this.theta), Math.cos(this.phi));
    const aspect = this.w / this.h;
    this.persp.aspect = aspect;
    this.persp.position.copy(this.target).addScaledVector(dir, this.radius);
    this.persp.near = Math.max(0.05, this.radius / 400); this.persp.far = this.radius * 60 + 2000;
    this.persp.lookAt(this.target);
    this.persp.updateProjectionMatrix();
    const hh = this.radius * Math.tan((FOV * Math.PI) / 360);
    Object.assign(this.ortho, { left: -hh * aspect, right: hh * aspect, top: hh, bottom: -hh });
    this.ortho.position.copy(this.target).addScaledVector(dir, 3000);
    this.ortho.lookAt(this.target);
    this.ortho.updateProjectionMatrix();
    this.persp.updateMatrixWorld(); this.ortho.updateMatrixWorld();
  }

  // ---- navigation ----------------------------------------------------------
  orbit(dx, dy) {
    if (this.autoOrtho) { this.isOrtho = false; this.autoOrtho = false; }
    this.anim = null;
    this.theta -= dx * 0.0055; this.phi -= dy * 0.0055;
    this.updateCamera();
  }
  pan(dx, dy) {
    const k = (2 * this.radius * Math.tan((FOV * Math.PI) / 360)) / this.h;
    const m = this.camera.matrixWorld;
    const right = new THREE.Vector3().setFromMatrixColumn(m, 0), up = new THREE.Vector3().setFromMatrixColumn(m, 1);
    this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    this.updateCamera();
  }
  zoom(f) { this.radius = Math.min(3000, Math.max(0.8, this.radius * f)); this.updateCamera(); }

  setView(theta, phi, ortho, o = {}) {
    // take the short way round
    let dt = theta - this.theta;
    dt = ((dt + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.anim = {
      t0: performance.now(), dur: 220,
      from: { th: this.theta, ph: this.phi, r: this.radius, tg: this.target.clone() },
      to: { th: this.theta + dt, ph: phi, r: o.radius ?? this.radius, tg: o.target ?? this.target.clone() },
    };
    if (ortho !== undefined) { this.isOrtho = ortho; this.autoOrtho = !!o.auto && ortho; }
  }
  axisView(name) {
    const H = Math.PI / 2;
    const v = { front: [-H, H], back: [H, H], right: [0, H], left: [Math.PI, H], top: [-H, EPS], bottom: [-H, Math.PI - EPS] }[name];
    this.setView(v[0], v[1], true, { auto: true });
  }
  toggleOrtho() { this.isOrtho = !this.isOrtho; this.autoOrtho = false; }
  frameBox(box) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    this.setView(this.theta, this.phi, undefined, { target: c, radius: Math.max(6, size * 1.45) });
  }
  getView() { return { th: this.theta, ph: this.phi, r: this.radius, tg: this.target.clone(), ortho: this.isOrtho }; }
  restoreView(v) { this.setView(v.th, v.ph, v.ortho, { target: v.tg, radius: v.r }); }

  tick() {
    if (this.anim) {
      const a = this.anim, t = Math.min(1, (performance.now() - a.t0) / a.dur), e = t * t * (3 - 2 * t);
      this.theta = a.from.th + (a.to.th - a.from.th) * e;
      this.phi = a.from.ph + (a.to.ph - a.from.ph) * e;
      this.radius = a.from.r + (a.to.r - a.from.r) * e;
      this.target.lerpVectors(a.from.tg, a.to.tg, e);
      if (t >= 1) this.anim = null;
      this.updateCamera();
    }
    for (const f of this.frameHooks) f();
    this.renderer.render(this.scene, this.camera);
    this.drawGizmo();
  }

  // ---- picking helpers -----------------------------------------------------
  setRay(e) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }
  hit(e, objects) {
    this.setRay(e);
    return this.raycaster.intersectObjects(objects, true);
  }
  rayPlane(e, point, normal) {
    const ray = this.setRay(e);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    const out = new THREE.Vector3();
    if (ray.intersectPlane(plane, out)) return out;
    // ray parallel or pointing away: fall back to the closest sensible point
    const d = plane.distanceToPoint(ray.origin);
    return ray.origin.clone().addScaledVector(normal, -d);
  }
  viewDir() { return this.camera.getWorldDirection(new THREE.Vector3()); }
  toScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, visible: p.z < 1 && p.z > -1 };
  }
  // world size of one screen pixel at a point
  pixelSize(at) {
    if (this.isOrtho) return (2 * this.radius * Math.tan((FOV * Math.PI) / 360)) / this.h;
    const d = at.distanceTo(this.persp.position);
    return (2 * d * Math.tan((FOV * Math.PI) / 360)) / this.h;
  }

  // ---- nav gizmo -----------------------------------------------------------
  initGizmo() {
    const c = this.gizmo;
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.moved || Math.hypot(dx, dy) > 3) {
        drag.moved = true; this.orbit(dx, dy); drag.x = e.clientX; drag.y = e.clientY;
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null;
        for (const b of this.gizmoBalls || []) {
          const d = Math.hypot(b.x - x, b.y - y);
          if (d < 13 && (!best || b.z > best.z)) best = b;
        }
        if (best) this.axisView(best.view);
      }
      drag = null;
    });
  }
  drawGizmo() {
    const c = this.gizmo, S = 96, dpr = Math.min(devicePixelRatio, 2);
    if (c.width !== S * dpr) { c.width = c.height = S * dpr; c.style.width = c.style.height = S + 'px'; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    const inv = new THREE.Matrix4().extractRotation(this.camera.matrixWorldInverse);
    const axes = [
      ['X', [1, 0, 0], '#e8475a', 'right', 'left'],
      ['Y', [0, 1, 0], '#8bc53f', 'back', 'front'],
      ['Z', [0, 0, 1], '#3f8fe8', 'top', 'bottom'],
    ];
    const balls = [];
    for (const [label, d, color, pos, neg] of axes) {
      const v = new THREE.Vector3(...d).applyMatrix4(inv);
      balls.push({ x: S / 2 + v.x * 34, y: S / 2 - v.y * 34, z: v.z, color, label, view: pos, main: true });
      balls.push({ x: S / 2 - v.x * 34, y: S / 2 + v.y * 34, z: -v.z, color, label: '', view: neg });
    }
    balls.sort((a, b) => a.z - b.z);
    for (const b of balls) {
      if (b.main) {
        g.strokeStyle = b.color; g.lineWidth = 2;
        g.beginPath(); g.moveTo(S / 2, S / 2); g.lineTo(b.x, b.y); g.stroke();
      }
      g.beginPath(); g.arc(b.x, b.y, b.main ? 9 : 6.5, 0, 7);
      g.fillStyle = b.main ? b.color : b.color + '55';
      g.fill();
      if (!b.main) { g.strokeStyle = b.color; g.lineWidth = 1.2; g.stroke(); }
      if (b.label) {
        g.fillStyle = '#111'; g.font = 'bold 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(b.label, b.x, b.y + 0.5);
      }
    }
    this.gizmoBalls = balls;
  }
}
