import * as THREE from 'three';
import { icon } from './icons.js';

const FACES = ['right', 'left', 'top', 'bottom', 'front', 'back']; // BoxGeometry material order

function labelTexture(text, dark = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#1c2433' : '#ffffff';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = dark ? '#34405a' : '#d5dbe5';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 125, 125);
  g.fillStyle = dark ? '#c3cad8' : '#334155';
  g.font = '600 22px Inter, Segoe UI, Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Fusion-style navigation cube: clicking a face, edge or corner turns the camera.
export class ViewCube {
  constructor(host, viewport, onHome, onFit) {
    this.viewport = viewport;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(120, 120, false);
    host.appendChild(this.renderer.domElement);

    const home = document.createElement('button');
    home.className = 'home';
    home.title = 'Home view';
    home.dataset.tool = 'view-home';
    home.innerHTML = icon('home');
    home.onclick = onHome;
    host.appendChild(home);

    const fit = document.createElement('button');
    fit.className = 'home';
    fit.style.top = '34px';
    fit.title = 'Fit all (F)';
    fit.innerHTML = icon('fit');
    fit.onclick = onFit;
    host.appendChild(fit);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: labelTexture(f) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), this.materials);
    this.scene.add(this.cube);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x94a3b8 }));
    this.scene.add(this.edges);
    this.hoverColor = 0xc7d6ff;
    this.baseColor = 0xffffff;

    const raycaster = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const hit = (ev) => {
      const r = this.renderer.domElement.getBoundingClientRect();
      ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ptr, this.camera);
      return raycaster.intersectObject(this.cube)[0];
    };

    this.hover = -1;
    this.renderer.domElement.addEventListener('pointermove', (ev) => {
      const h = hit(ev);
      this.hover = h ? h.face.materialIndex : -1;
    });
    this.renderer.domElement.addEventListener('pointerleave', () => { this.hover = -1; });
    this.renderer.domElement.addEventListener('click', (ev) => {
      const h = hit(ev);
      if (!h) return;
      // Snap to face / edge / corner depending on where the cube was clicked.
      const p = h.point;
      const s = (v) => (Math.abs(v) > 0.55 ? Math.sign(v) : 0);
      const dir = new THREE.Vector3(s(p.x), s(p.y), s(p.z));
      const nonZero = [dir.x, dir.y, dir.z].filter((v) => v !== 0).length;
      if (nonZero <= 1) {
        viewport.setView(FACES[h.face.materialIndex]);
      } else {
        if (dir.x === 0 && dir.z === 0) dir.z = 0.0001;
        viewport.setView('corner', dir.normalize());
      }
    });

    viewport.onFrame(() => this.render());
  }

  render() {
    const vp = this.viewport;
    const dir = vp.camera.position.clone().sub(vp.controls.target).normalize();
    this.camera.position.copy(dir).multiplyScalar(6);
    this.camera.up.copy(vp.camera.up);
    this.camera.lookAt(0, 0, 0);
    this.materials.forEach((m, i) => m.color.set(i === this.hover ? this.hoverColor : this.baseColor));
    this.renderer.render(this.scene, this.camera);
  }

  setTheme(dark) {
    this.materials.forEach((m, i) => { m.map.dispose(); m.map = labelTexture(FACES[i], dark); m.needsUpdate = true; });
    this.edges.material.color.set(dark ? 0x4a5670 : 0x94a3b8);
    this.hoverColor = dark ? 0x7d9cff : 0xc7d6ff;
  }
}
