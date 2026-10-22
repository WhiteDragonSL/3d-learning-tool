import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { bus } from './events.js';

export const VIEWS = {
  home: new THREE.Vector3(1, 0.85, 1.2),
  top: new THREE.Vector3(0, 1, 0.0001),
  bottom: new THREE.Vector3(0, -1, 0.0001),
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0),
};

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

export class Viewport {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.classList.add('main');
    this.renderer.domElement.tabIndex = 0;
    el.prepend(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.camera.position.copy(VIEWS.home).normalize().multiplyScalar(260);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.maxDistance = 3000;
    this.controls.minDistance = 5;

    this.#addLights();
    this.#addGrid();

    this.transform = new TransformControls(this.camera, this.canvas);
    this.transform.setSize(0.9);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.frameCallbacks = [];
    this.anim = null;

    this.#trackCameraGestures();

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  #addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8994a0, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(120, 220, 90);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-140, 60, -120);
    this.scene.add(fill);
  }

  #addGrid() {
    this.grid = new THREE.Group();
    this.#buildGridLines(false);
    const axis = (a, b, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      // transparent so it is sorted after (drawn on top of) the transparent grid
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthWrite: false, transparent: true }));
      line.renderOrder = 2;
      return line;
    };
    this.grid.add(axis(new THREE.Vector3(-200, 0.04, 0), new THREE.Vector3(200, 0.04, 0), 0xd9363e));
    this.grid.add(axis(new THREE.Vector3(0, 0.04, -200), new THREE.Vector3(0, 0.04, 200), 0x1c6fd1));
    this.grid.add(axis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 40, 0), 0x2f9e44));
    this.scene.add(this.grid);
  }

  // minor + major grid lines in the colours of the light or dark theme
  #buildGridLines(dark) {
    for (const g of this.gridLines || []) { this.grid.remove(g); g.geometry.dispose(); g.material.dispose(); }
    const minor = dark ? new THREE.GridHelper(400, 80, 0x2a3344, 0x232b3a) : new THREE.GridHelper(400, 80, 0xd3d9e3, 0xdfe4ec);
    const major = dark ? new THREE.GridHelper(400, 20, 0x3d4960, 0x3d4960) : new THREE.GridHelper(400, 20, 0xb4bdcb, 0xb4bdcb);
    major.position.y = 0.02;
    for (const g of [minor, major]) {
      g.material.transparent = true;
      g.material.opacity = g === minor ? 0.7 : 0.8;
      g.material.depthWrite = false;
      this.grid.add(g);
    }
    this.gridLines = [minor, major];
  }

  setTheme(dark) { this.#buildGridLines(dark); }

  // Detects orbit / zoom / pan gestures so the tutorials can react to them.
  #trackCameraGestures() {
    let start = null;
    const snap = () => ({
      dir: this.camera.position.clone().sub(this.controls.target).normalize(),
      dist: this.camera.position.distanceTo(this.controls.target),
      target: this.controls.target.clone(),
      done: {},
    });
    let lastChange = 0;
    // Wheel zoom sends a start event per tick, so a gesture only restarts after a short pause.
    this.controls.addEventListener('start', () => { if (!start || performance.now() - lastChange > 600) start = snap(); });
    this.controls.addEventListener('change', () => {
      lastChange = performance.now();
      if (!start || this.anim) return;
      const now = snap();
      const fire = (kind) => { if (!start.done[kind]) { start.done[kind] = true; bus.emit('camera', { kind }); } };
      if (now.dir.angleTo(start.dir) > 0.08) fire('orbit');
      if (Math.abs(now.dist / start.dist - 1) > 0.06) fire('zoom');
      if (now.target.distanceTo(start.target) > start.dist * 0.03) fire('pan');
    });
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  onFrame(fn) { this.frameCallbacks.push(fn); }

  #frame() {
    if (this.anim) this.#stepAnim();
    this.controls.update();
    for (const fn of this.frameCallbacks) fn();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- camera animation ----------
  #animateTo({ dir, dist, target }) {
    const curOffset = this.camera.position.clone().sub(this.controls.target);
    this.anim = {
      t0: performance.now(), dur: 450,
      fromDir: curOffset.clone().normalize(), toDir: dir.clone().normalize(),
      fromDist: curOffset.length(), toDist: dist ?? curOffset.length(),
      fromTarget: this.controls.target.clone(), toTarget: (target ?? this.controls.target).clone(),
    };
  }

  #stepAnim() {
    const a = this.anim;
    let t = Math.min(1, (performance.now() - a.t0) / a.dur);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    _q.setFromUnitVectors(a.fromDir, a.toDir);
    _qi.identity().slerp(_q, k);
    const dir = a.fromDir.clone().applyQuaternion(_qi);
    const dist = a.fromDist + (a.toDist - a.fromDist) * k;
    this.controls.target.lerpVectors(a.fromTarget, a.toTarget, k);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.camera.lookAt(this.controls.target);
    if (t >= 1) this.anim = null;
  }

  setView(name, dirOverride) {
    const dir = dirOverride || VIEWS[name];
    if (!dir) return;
    this.#animateTo({ dir });
    bus.emit('view', { view: name });
  }

  fit(box, dir) {
    const d = dir || this.camera.position.clone().sub(this.controls.target);
    if (!box || box.isEmpty()) {
      this.#animateTo({ dir: d, dist: 260, target: new THREE.Vector3() });
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15;
    this.#animateTo({ dir: d, dist, target: center });
  }

  // ---------- picking helpers ----------
  setPointer(ev) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  raycast(ev, objects, recursive = false) {
    this.setPointer(ev);
    this.scene.updateMatrixWorld(); // objects added since the last frame need fresh matrices
    return this.raycaster.intersectObjects(objects, recursive);
  }

  groundPoint(ev, y = 0) {
    this.setPointer(ev);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    return {
      x: (p.x * 0.5 + 0.5) * this.el.clientWidth,
      y: (-p.y * 0.5 + 0.5) * this.el.clientHeight,
      visible: p.z < 1,
    };
  }

  // world units per screen pixel at a point (used for snapping tolerances)
  worldPerPixel(at) {
    const dist = this.camera.position.distanceTo(at);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.el.clientHeight;
  }
}
