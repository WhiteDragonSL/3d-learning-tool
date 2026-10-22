import * as THREE from 'three';

// Fusion-style drag arrow: shown during Extrude so the distance can be set by
// dragging in the viewport. The value is the distance along `dir` from `origin`.
export class ArrowManipulator {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    const mat = new THREE.MeshBasicMaterial({ color: 0x0696d7, depthTest: false });
    this.matHover = new THREE.MeshBasicMaterial({ color: 0xf28c28, depthTest: false });
    this.mat = mat;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8).translate(0, 0.5, 0), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 16).translate(0, 1.25, 0), mat);
    const grab = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8).translate(0, 0.8, 0), new THREE.MeshBasicMaterial({ visible: false }));
    this.parts = [shaft, head];
    this.arrow = new THREE.Group();
    this.arrow.add(shaft, head, grab);
    this.arrow.renderOrder = 20;
    shaft.renderOrder = head.renderOrder = 20;
    this.grab = grab;
    this.arrow.visible = false;
    this.vp.scene.add(this.arrow);
    this.dragging = false;

    const c = this.vp.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.arrow.visible || e.button !== 0) return;
      if (!this.vp.raycast(e, [grab]).length) return;
      this.dragging = true;
      this.app.manipulating = true;
      this.vp.controls.enabled = false;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.arrow.visible) return;
      if (!this.dragging) {
        const over = this.vp.raycast(e, [grab]).length > 0;
        for (const p of this.parts) p.material = over ? this.matHover : this.mat;
        c.style.cursor = over ? 'grab' : '';
        return;
      }
      let t = this.#paramAlongLine(e) - this.offset;
      if (this.app.snap) t = Math.round(t);
      this.onDrag?.(t);
    });
    c.addEventListener('pointerup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.vp.controls.enabled = true;
      setTimeout(() => { this.app.manipulating = false; }, 0);
    });
    this.vp.onFrame(() => {
      if (!this.arrow.visible) return;
      this.arrow.scale.setScalar(this.vp.worldPerPixel(this.arrow.position) * 60);
    });
  }

  // origin + dir describe the line; the arrow sits at origin + dir * (offset + value)
  show(origin, dir, value, offset, onDrag) {
    this.origin = origin.clone();
    this.dir = dir.clone().normalize();
    this.offset = offset;
    this.onDrag = onDrag;
    this.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.dir);
    this.arrow.visible = true;
    this.set(value);
  }

  set(value, offset = this.offset) {
    this.offset = offset;
    this.arrow.position.copy(this.origin).addScaledVector(this.dir, offset + value);
  }

  hide() {
    this.arrow.visible = false;
    this.dragging = false;
    this.vp.canvas.style.cursor = '';
  }

  // closest point on the arrow's line to the mouse ray, as a distance from origin
  #paramAlongLine(e) {
    this.vp.setPointer(e);
    const ray = this.vp.raycaster.ray;
    const w0 = this.origin.clone().sub(ray.origin);
    const a = this.dir.dot(this.dir), b = this.dir.dot(ray.direction), c = ray.direction.dot(ray.direction);
    const d = this.dir.dot(w0), e2 = ray.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * e2 - c * d) / den;
  }
}
