import * as THREE from 'three';
import { bus } from '../events.js';

const PURPLE = 0x7c3aed;

// Click two points (on bodies or the ground) to measure the distance between them.
// Points snap to the nearest corner/vertex when the cursor is close to one.
export class MeasureTool {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.group = new THREE.Group();
    this.vp.scene.add(this.group);
    this.active = false;
    this.points = [];
    this.label = document.createElement('div');
    this.label.className = 'mlabel hidden';
    this.label.style.background = '#7c3aed';
    document.getElementById('labels').appendChild(this.label);

    this.snapMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf28c28, depthTest: false }));
    this.snapMarker.renderOrder = 10;
    this.snapMarker.visible = false;
    this.vp.scene.add(this.snapMarker);

    const c = this.vp.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => { if (this.active && e.button === 0) down = [e.clientX, e.clientY]; });
    c.addEventListener('pointerup', (e) => {
      if (!this.active || !down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved < 5) this.#click(e);
    });
    c.addEventListener('pointermove', (e) => { if (this.active) this.#hover(e); });
    this.vp.onFrame(() => this.#frame());
  }

  start() {
    this.stop();
    this.active = true;
    this.vp.el.classList.add('measuring');
    this.app.setHint('Measure: click the first point on a body or the grid. Corners snap (orange dot). Esc to finish.');
  }

  stop() {
    this.active = false;
    this.points = [];
    this.vp.el.classList.remove('measuring');
    this.snapMarker.visible = false;
    this.label.classList.add('hidden');
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry.dispose(); }
  }

  key(e) {
    if (this.active && e.key === 'Escape') { this.stop(); this.app.setHint('Measure finished.'); return true; }
    return false;
  }

  #pick(e) {
    const meshes = this.app.doc.bodies.filter((b) => b.visible).map((b) => b.mesh);
    const hit = this.vp.raycast(e, meshes)[0];
    if (hit) {
      // snap to the nearest vertex of the hit triangle if it is close on screen
      const g = hit.object.geometry, pos = g.attributes.position;
      const ids = [hit.face.a, hit.face.b, hit.face.c];
      let best = null, bestD = Infinity;
      for (const i of ids) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
        const d = v.distanceTo(hit.point);
        if (d < bestD) { bestD = d; best = v; }
      }
      const tol = this.vp.worldPerPixel(hit.point) * 14;
      if (bestD < tol) return { p: best, snapped: true };
      return { p: hit.point.clone(), snapped: false };
    }
    const g = this.vp.groundPoint(e);
    if (!g) return null;
    if (this.app.snap) { g.x = Math.round(g.x); g.z = Math.round(g.z); }
    return { p: g, snapped: false };
  }

  #hover(e) {
    const r = this.#pick(e);
    this.snapMarker.visible = !!r?.snapped;
    if (r?.snapped) {
      this.snapMarker.position.copy(r.p);
      this.snapMarker.scale.setScalar(this.vp.worldPerPixel(r.p) * 4);
    }
  }

  #click(e) {
    const r = this.#pick(e);
    if (!r) return;
    if (this.points.length >= 2) { this.points = []; for (const o of [...this.group.children]) this.group.remove(o); this.label.classList.add('hidden'); }
    this.points.push(r.p);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: PURPLE, depthTest: false }));
    dot.renderOrder = 9;
    dot.position.copy(r.p);
    dot.userData.dot = true;
    this.group.add(dot);

    if (this.points.length === 2) {
      const [a, b] = this.points;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: PURPLE, depthTest: false }));
      line.renderOrder = 9;
      this.group.add(line);
      const d = a.distanceTo(b);
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), dz = Math.abs(b.z - a.z);
      this.label.textContent = `${f(d)} mm`;
      this.label.classList.remove('hidden');
      this.app.setHint(`Distance ${f(d)} mm  ·  ΔX ${f(dx)}  ΔY ${f(dy)}  ΔZ ${f(dz)}  — click again to start a new measurement.`);
      bus.emit('measure', { distance: d });
    } else {
      this.app.setHint('Measure: now click the second point.');
    }
  }

  #frame() {
    for (const o of this.group.children) if (o.userData.dot) o.scale.setScalar(this.vp.worldPerPixel(o.position) * 4);
    if (this.points.length === 2 && this.active) {
      const mid = this.points[0].clone().lerp(this.points[1], 0.5);
      const s = this.vp.toScreen(mid);
      this.label.style.left = s.x + 'px';
      this.label.style.top = s.y + 'px';
    }
  }
}

const f = (v) => (Math.round(v * 100) / 100).toString();
