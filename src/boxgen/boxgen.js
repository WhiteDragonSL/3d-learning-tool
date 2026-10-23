import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CATEGORIES, LIBRARY, categoryOf, customComponent } from './library.js';
import {
  buildBase, buildLid, printReady, footprint, rotXZ, cutoutPlacements, pillarCenters, lipHeight, PILLAR_RADIUS,
} from './enclosure.js';
import { layoutParts } from './layout.js';
import { featureEdges } from '../model.js';
import { meshBody } from '../ops.js';
import { icon } from '../icons.js';
import { toast } from '../ui/dialog.js';
import { bus } from '../events.js';

// ---------------------------------------------------------------------------
// IoT BoxGen workspace: pick components from a library, arrange them on the
// floor of a virtual enclosure, and generate a 3D-printable Base + Lid with
// PCB standoffs, corner screw pillars, port cutouts and vent slots.
// ---------------------------------------------------------------------------
const STORE_KEY = 'minicad-boxgen';
const PORT_COLOR = 0xff8a1f;
// settings that re-run the automatic layout
const RELAYOUT = new Set(['wiringGap', 'headroom', 'padding', 'standoffHeight', 'lid']);

export const defaultState = () => ({
  name: 'IoT Enclosure',
  inner: { width: 90, depth: 70, height: 35 },
  padding: 5, wall: 2, radius: 3, tolerance: 0.2, standoffHeight: 5, clearance: 0.5, lipHeight: 4,
  wiringGap: 10, headroom: 10, cableHole: 8,
  lid: 'screw', vents: true, lidVents: true,
  shell: true, // false: no base / lid, the components alone are the model
  emptyBox: false, // show the box at its set size before any component is ticked
  layoutManual: false, // true once parts were moved by hand
  parts: [], custom: [],
});

// What the saved project contains, for the start screen (null if nothing placed).
export function peekBoxgen() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return s?.parts?.length ? { name: s.name || 'IoT Enclosure', parts: s.parts.length, inner: s.inner } : null;
  } catch { return null; }
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;
let uidCounter = 1;
const newUid = () => `p${Date.now().toString(36)}${uidCounter++}`;

export class BoxGen {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.active = false;
    this.state = this.#load();
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.selected = null;
    this.view = { mode: 'assembled', components: true, xray: true, wire: false, labels: true };
    this.search = '';
    this.warnings = [];
    this.status = '';
    this.worker = null; // geometry worker (false = build on the main thread)
    this.reqId = 0;
    this.busy = false;
    this.dirty = false;

    // scene: enclosure root sits on the ground grid (floor underside at y = 0)
    this.root = new THREE.Group();
    this.root.visible = false;
    this.vp.scene.add(this.root);
    const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.baseMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat(0xc9d2de));
    this.lidMesh = new THREE.Mesh(new THREE.BufferGeometry(), mat(0xb7c4e8));
    for (const m of [this.baseMesh, this.lidMesh]) {
      m.add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.6 })));
      m.raycast = () => {};
      this.root.add(m);
    }
    this.partsGroup = new THREE.Group();
    this.root.add(this.partsGroup);
    this.partObjs = new Map(); // uid -> { group, box, edges, label }

    this.labelHost = document.getElementById('labels');
    this.#buildDom();
    this.#setupPointer();
    this.vp.onFrame(() => this.#updateLabels());
  }

  // ======================================================================
  // activation / persistence / history
  // ======================================================================
  setActive(on) {
    this.active = on;
    this.root.visible = on;
    this.viewbar.classList.toggle('hidden', !on);
    for (const o of this.partObjs.values()) o.label.classList.toggle('hidden', !on);
    if (on) {
      this.#syncParts();
      this.#renderLibrary();
      this.#renderParams();
      this.rebuild(true);
      this.app.setHint('<b>IoT BoxGen:</b> tick the components you need and how many, press <b>Generate enclosure</b>, then export the STL files. Drag parts to fine-tune (<kbd>R</kbd> rotates).');
      setTimeout(() => this.fit(), 50);
    }
  }

  #load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s?.inner) return { ...defaultState(), ...s, inner: { ...defaultState().inner, ...s.inner } };
    } catch { /* ignore */ }
    return defaultState();
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* full */ } }, 300);
  }

  // Start a fresh, empty enclosure project.
  reset() {
    this.state = defaultState();
    this.undoStack = []; this.redoStack = []; this.pending = null; this.selected = null;
    this.#save();
    if (this.active) { this.#syncParts(); this.#renderLibrary(); this.#renderParams(); this.rebuild(true); }
    bus.emit('boxgen:changed');
  }

  rename(name) { this.state.name = name.trim() || 'IoT Enclosure'; this.#save(); bus.emit('doc:renamed'); }

  // group a change for undo: begin() before mutating, end() after
  begin() { if (!this.pending) this.pending = JSON.stringify(this.state); }
  end({ rebuild = true, parts = true } = {}) {
    if (this.pending && this.pending !== JSON.stringify(this.state)) {
      this.undoStack.push(this.pending);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.pending = null;
    this.#save();
    if (parts) this.#syncParts();
    this.#renderParams();
    if (this.active) this.#renderLibrary();
    if (rebuild) this.rebuild();
    bus.emit('boxgen:changed');
  }
  change(fn, opts) { this.begin(); fn(); this.end(opts); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() { this.#restore(this.undoStack, this.redoStack); }
  redo() { this.#restore(this.redoStack, this.undoStack); }
  #restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(this.state));
    this.state = JSON.parse(from.pop());
    if (this.selected && !this.part(this.selected)) this.selected = null;
    this.#save();
    this.#syncParts();
    this.#renderParams();
    this.#renderLibrary();
    this.rebuild();
    bus.emit('boxgen:changed');
  }

  part(uid) { return this.state.parts.find((p) => p.uid === uid); }
  get selectedPart() { return this.part(this.selected); }

  // ======================================================================
  // parts
  // ======================================================================
  get library() { return [...LIBRARY, ...this.state.custom]; }

  // ---------- the checklist: how many of each component ----------
  count(defId) { return this.state.parts.filter((p) => p.def.id === defId).length; }

  // Set the quantity of a component. With the automatic layout on, the whole
  // enclosure is re-arranged around the new set; after manual moves, only the
  // added parts are placed (in free space, growing the box if needed).
  setQty(defId, n) {
    const s = this.state;
    const def = this.library.find((d) => d.id === defId);
    if (!def) return;
    n = Math.max(0, Math.min(20, Math.round(n)));
    const have = s.parts.filter((p) => p.def.id === defId);
    if (n === have.length) return;
    this.change(() => {
      if (n < have.length) {
        const drop = new Set(have.slice(n));
        s.parts = s.parts.filter((p) => !drop.has(p));
        if (this.selected && !this.part(this.selected)) this.selected = null;
      } else {
        for (let i = have.length; i < n; i++) {
          const part = { uid: newUid(), def: structuredClone(def), x: 0, z: 0, y: def.mount === 'standoff' ? s.standoffHeight : 0, rot: 0 };
          s.parts.push(part);
          if (s.layoutManual) this.#placeNew(part);
        }
      }
      if (!s.layoutManual) layoutParts(s);
    });
    this.#renderLibrary();
    bus.emit('boxgen:qty', { id: defId, qty: n });
  }

  // Combine every selected component into one enclosure (automatic layout).
  generate() {
    const s = this.state;
    if (!s.parts.length) { toast('Tick the components you need in the list first.', 'warn'); return; }
    this.change(() => { s.layoutManual = false; this.selected = null; layoutParts(s); });
    const i = s.inner;
    toast(`Enclosure generated for ${s.parts.length} component${s.parts.length > 1 ? 's' : ''}: inside ${r1(i.width)} × ${r1(i.depth)} × ${r1(i.height)} mm.`, 'ok', 3200);
    bus.emit('boxgen:generate', { count: s.parts.length });
    setTimeout(() => this.fit(), 60);
  }

  // a part added after manual moves: first free spot, else beside the others (box grows)
  #placeNew(part) {
    const s = this.state;
    const { w, d } = footprint(part);
    const spot = this.#freeSpot(w, d, part);
    if (spot) { part.x = spot[0]; part.z = spot[1]; return; }
    const others = s.parts.filter((p) => p !== part);
    const g = s.wiringGap;
    if (s.inner.width >= s.inner.depth) part.z = Math.max(...others.map((p) => p.z + footprint(p).d / 2), 0) + g + d / 2;
    else part.x = Math.max(...others.map((p) => p.x + footprint(p).w / 2), 0) + g + w / 2;
    this.#fit();
  }

  // first place on the floor where a w×d footprint fits, keeping the wiring gap to other parts
  #freeSpot(w, d, self) {
    const { width: W, depth: D } = this.state.inner;
    const m = 1.5, g = Math.max(m, this.state.wiringGap);
    const rects = this.state.parts.filter((p) => p !== self).map(rectOf);
    const pillars = pillarCenters(this.state);
    const ok = (x, z) => {
      const a = [x - w / 2, z - d / 2, x + w / 2, z + d / 2];
      if (a[0] < -W / 2 + m || a[2] > W / 2 - m || a[1] < -D / 2 + m || a[3] > D / 2 - m) return false;
      if (rects.some((b) => a[0] < b[2] + g && a[2] > b[0] - g && a[1] < b[3] + g && a[3] > b[1] - g)) return false;
      return !pillars.some(([px, pz]) => rectCircleDist(a, px, pz) < PILLAR_RADIUS + 0.5);
    };
    if (ok(0, 0)) return [0, 0];
    for (let r = 2; r < Math.max(W, D); r += 2) {
      for (let x = -r; x <= r; x += 2) for (const z of [-r, r]) if (ok(x, z)) return [x, z];
      for (let z = -r; z <= r; z += 2) for (const x of [-r, r]) if (ok(x, z)) return [x, z];
    }
    return null;
  }

  // ---------- fine-tuning single parts (switches the layout to manual) ----------
  #manual(fn) { this.change(() => { this.state.layoutManual = true; fn(); }); }

  removeSelected() {
    const p = this.selectedPart;
    if (!p) return;
    this.change(() => {
      this.state.parts = this.state.parts.filter((q) => q !== p);
      this.selected = null;
      if (!this.state.layoutManual) layoutParts(this.state);
    });
    this.#renderLibrary();
  }

  duplicateSelected() {
    const p = this.selectedPart;
    if (!p) return;
    this.setQty(p.def.id, this.count(p.def.id) + 1);
  }

  rotateSelected(delta = 90) {
    const p = this.selectedPart;
    if (!p) return;
    this.#manual(() => { p.rot = (((p.rot + delta) % 360) + 360) % 360; });
  }

  // move the part so the side with its first wall port touches the wall it faces
  snapToWall(p = this.selectedPart) {
    if (!p) return;
    const pl = cutoutPlacements(this.state).find((c) => c.part === p && c.wall !== 'lid');
    if (!pl) { toast('This component has no wall port to line up.', 'warn'); return; }
    this.#manual(() => {
      p.x += pl.n[0] * pl.gap; p.z += pl.n[1] * pl.gap;
      // slide along the wall (towards the middle) until the corner pillars are clear
      const axis = pl.n[0] ? 'z' : 'x';
      const hits = () => pillarCenters(this.state).some(([px, pz]) => rectCircleDist(rectOf(p), px, pz) < PILLAR_RADIUS + 0.3);
      for (let i = 0; i < 80 && hits() && Math.abs(p[axis]) > 0.5; i++) p[axis] = r1(p[axis] - Math.sign(p[axis]));
    });
    toast(`${esc(p.def.name)} moved against the ${pl.wall} wall - its ${esc(pl.cutout.label || 'port')} is cut through.`, 'ok', 2600);
  }

  setPartField(field, value) {
    const p = this.selectedPart;
    if (!p || !Number.isFinite(value)) return;
    this.#manual(() => { p[field] = field === 'y' ? Math.max(0, value) : value; });
  }

  nudgeSelected(dx, dz) {
    const p = this.selectedPart;
    if (p) this.#manual(() => { p.x = r1(p.x + dx); p.z = r1(p.z + dz); });
  }

  // ======================================================================
  // enclosure sizing
  // ======================================================================
  // smallest box around the parts where they are now (keeps a manual layout)
  autoFit() {
    if (!this.state.parts.length) { toast('Tick some components first - Auto-Fit sizes the box around them.', 'warn'); return; }
    this.change(() => this.#fit());
    const i = this.state.inner;
    toast(`Auto-Fit: inside ${r1(i.width)} × ${r1(i.depth)} × ${r1(i.height)} mm.`, 'ok');
    bus.emit('boxgen:autofit');
    setTimeout(() => this.fit(), 60);
  }

  // smallest box around all parts + padding, then centre the parts in it
  #fit() {
    const s = this.state, pad = s.padding;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
    for (const p of s.parts) {
      const f = footprint(p);
      x0 = Math.min(x0, p.x - f.w / 2); x1 = Math.max(x1, p.x + f.w / 2);
      z0 = Math.min(z0, p.z - f.d / 2); z1 = Math.max(z1, p.z + f.d / 2);
      top = Math.max(top, p.y + p.def.dimensions.height);
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (const p of s.parts) { p.x = r1(p.x - cx); p.z = r1(p.z - cz); }
    s.inner.width = r1(Math.max(20, x1 - x0 + 2 * pad));
    s.inner.depth = r1(Math.max(20, z1 - z0 + 2 * pad));
    s.inner.height = r1(Math.max(12, top + s.headroom, s.lipHeight + 6));
    // grow until the corner screw pillars clear every part
    for (let i = 0; i < 20 && this.#pillarClash(); i++) { s.inner.width += 2; s.inner.depth += 2; }
  }

  #pillarClash() {
    return pillarCenters(this.state).some(([px, pz]) => this.state.parts.some((p) => rectCircleDist(rectOf(p), px, pz) < PILLAR_RADIUS + 0.3));
  }

  // Enclosure settings. Spacing settings re-run the automatic layout while it is on.
  setParam(key, value, { live = false } = {}) {
    const s = this.state;
    this.begin();
    if (key.startsWith('inner.')) { s.inner[key.slice(6)] = value; if (s.parts.length) s.layoutManual = true; } else s[key] = value;
    if (!s.layoutManual && s.parts.length && RELAYOUT.has(key)) { layoutParts(s); this.#syncParts(); }
    if (live) { this.#renderReadouts(); this.rebuild(); return; }
    this.end({ parts: false });
  }

  // ======================================================================
  // validation
  // ======================================================================
  #validate() {
    const s = this.state, { width: W, depth: D, height: H } = s.inner;
    const lip = lipHeight(s);
    const warn = [];
    const bad = new Set();
    const pillars = pillarCenters(s);
    s.parts.forEach((p, i) => {
      const a = rectOf(p), h = p.def.dimensions.height;
      if (a[0] < -W / 2 - 0.01 || a[2] > W / 2 + 0.01 || a[1] < -D / 2 - 0.01 || a[3] > D / 2 + 0.01) { warn.push(['err', `${p.def.name} sticks out through a wall.`, p.uid]); bad.add(p.uid); }
      if (p.y + h > H - lip + 0.01) { warn.push(['err', `${p.def.name} is taller than the space under the lid (${r1(H - lip)} mm).`, p.uid]); bad.add(p.uid); }
      if (pillars.some(([px, pz]) => rectCircleDist(a, px, pz) < PILLAR_RADIUS)) { warn.push(['err', `${p.def.name} hits a corner screw pillar.`, p.uid]); bad.add(p.uid); }
      for (const q of s.parts.slice(i + 1)) {
        const b = rectOf(q);
        const overlapXZ = a[0] < b[2] - 0.05 && a[2] > b[0] + 0.05 && a[1] < b[3] - 0.05 && a[3] > b[1] + 0.05;
        const overlapY = p.y < q.y + q.def.dimensions.height - 0.05 && q.y < p.y + h - 0.05;
        if (overlapXZ && overlapY) { warn.push(['err', `${p.def.name} overlaps ${q.def.name}.`, p.uid]); bad.add(p.uid); bad.add(q.uid); }
      }
    });
    for (const pl of cutoutPlacements(s)) {
      if (pl.wall !== 'lid' && !pl.cut) warn.push(['info', `${pl.part.def.name}: ${pl.cutout.label || 'port'} faces the ${pl.wall} wall but is ${r1(pl.gap)} mm away - no hole is cut. Use “Snap to wall”.`, pl.part.uid]);
    }
    this.warnings = warn;
    this.bad = bad;
    return warn;
  }

  // ======================================================================
  // geometry
  // ======================================================================
  // Checks update at once; the Base/Lid geometry is generated in a worker (latest request wins).
  rebuild(now = false) {
    this.root.position.y = this.state.wall;
    this.#validate();
    this.#refreshPartLooks();
    this.#renderWarnings();
    clearTimeout(this.rebuildTimer);
    // case switched off, or no components ticked: show no enclosure (unless the empty box is switched on)
    if (!this.#hasShell()) {
      for (const m of [this.baseMesh, this.lidMesh]) {
        m.geometry.dispose(); m.geometry = new THREE.BufferGeometry();
        m.children[0].geometry.dispose(); m.children[0].geometry = new THREE.BufferGeometry();
      }
      this.#setStatus(this.state.shell ? 'Tick components to generate an enclosure.' : 'Case off - only the components are shown and exported.');
      return;
    }
    this.#setStatus('Generating…');
    if (now) this.#request(); else this.rebuildTimer = setTimeout(() => this.#request(), 60);
  }

  #hasShell() { return this.state.shell && (this.state.parts.length > 0 || this.state.emptyBox); }

  #request() {
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this.#onGenerated(e.data);
        this.worker.onerror = (e) => { console.error(e); this.worker = false; this.busy = false; this.#request(); };
      } catch { this.worker = false; }
    }
    if (this.worker === false) return this.#buildHere();
    if (this.busy) { this.dirty = true; return; }
    this.busy = true;
    this.dirty = false;
    this.worker.postMessage({ id: ++this.reqId, state: this.state });
  }

  #onGenerated(msg) {
    this.busy = false;
    if (!this.#hasShell()) {
      // the components were cleared while this was generating
    } else if (msg.error) {
      console.error(msg.error);
      this.#setStatus('⚠ Could not generate this shape - try a different size.');
    } else {
      const geo = (d) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
        return g;
      };
      this.#setGeometry(this.baseMesh, geo(msg.base));
      this.#setGeometry(this.lidMesh, geo(msg.lid));
      this.#setStatus(this.dirty ? 'Generating…' : `Generated in ${Math.round(msg.ms)} ms`);
      this.#applyView();
      bus.emit('boxgen:generated');
    }
    if (this.dirty) this.#request();
  }

  // fallback when workers are unavailable
  #buildHere() {
    const t0 = performance.now();
    try {
      this.#setGeometry(this.baseMesh, buildBase(this.state));
      this.#setGeometry(this.lidMesh, buildLid(this.state));
      this.#setStatus(`Generated in ${Math.round(performance.now() - t0)} ms`);
      bus.emit('boxgen:generated');
    } catch (err) {
      console.error(err);
      this.#setStatus('⚠ Could not generate this shape - try a different size.');
    }
    this.#applyView();
  }

  #setGeometry(mesh, geo) {
    mesh.geometry.dispose();
    mesh.geometry = geo;
    const e = mesh.children[0];
    e.geometry.dispose();
    e.geometry = featureEdges(geo, 30);
  }

  // the case (base + lid) on or off
  setShell(on) {
    this.setParam('shell', on);
    this.#renderViewbar();
    setTimeout(() => this.fit(), 30);
  }

  setView(key, value) {
    this.view[key] = value;
    this.#applyView();
    this.#renderViewbar();
  }

  #applyView() {
    const v = this.view, H = this.state.inner.height;
    const showBase = v.mode !== 'lid', showLid = v.mode !== 'base';
    this.baseMesh.visible = showBase;
    this.lidMesh.visible = showLid;
    this.lidMesh.position.set(0, v.mode === 'exploded' ? Math.max(25, H * 0.8) : 0, 0);
    this.partsGroup.visible = v.components && v.mode !== 'lid';
    for (const m of [this.baseMesh, this.lidMesh]) {
      const mat = m.material;
      mat.transparent = v.xray;
      mat.opacity = v.xray ? 0.28 : 1;
      mat.depthWrite = !v.xray;
      mat.wireframe = v.wire;
      m.children[0].visible = !v.wire;
    }
  }

  fit() {
    const box = new THREE.Box3();
    for (const m of [this.baseMesh, this.lidMesh]) if (m.visible && m.geometry.attributes.position) box.expandByObject(m);
    if (box.isEmpty() && this.partsGroup.visible && this.state.parts.length) box.expandByObject(this.partsGroup);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(80, 40, 60));
    this.vp.fit(box);
  }

  // ======================================================================
  // export
  // ======================================================================
  exportSTL(kind) {
    const mesh = kind === 'lid' ? this.lidMesh : this.baseMesh;
    if (!mesh.geometry.attributes.position?.count) { toast('Nothing to export yet.', 'warn'); return; }
    const scene = new THREE.Scene();
    // slicers use Z as "up": turn the print-ready (Y-up) part so it lies flat on the bed
    scene.add(new THREE.Mesh(printReady(mesh.geometry, kind).rotateX(Math.PI / 2)));
    const data = new STLExporter().parse(scene, { binary: true });
    const name = `${(this.state.name || 'enclosure').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'enclosure'}-${kind}.stl`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${name} (laid flat, ready to slice).`, 'ok');
    bus.emit('boxgen:export', { kind });
  }

  // All components merged into one model, sitting on the floor (y = 0) like they do in the case.
  #componentsGeometry() {
    if (!this.state.parts.length) return null;
    this.partsGroup.updateMatrixWorld(true);
    const inv = this.partsGroup.matrixWorld.clone().invert(), list = [];
    this.partsGroup.traverse((m) => {
      if (!m.isMesh) return;
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
      list.push(g.applyMatrix4(inv.clone().multiply(m.matrixWorld)));
    });
    return list.length ? mergeGeometries(list) : null;
  }

  exportComponents() {
    const geo = this.#componentsGeometry();
    if (!geo) { toast('Tick some components first.', 'warn'); return; }
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(printReady(geo, 'base').rotateX(Math.PI / 2)));
    const data = new STLExporter().parse(scene, { binary: true });
    const name = `${(this.state.name || 'enclosure').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'enclosure'}-components.stl`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${name} (all components as one model).`, 'ok');
    bus.emit('boxgen:export', { kind: 'components' });
  }

  // Bring Base + Lid into the Design workspace as bodies (to modify with the Fusion tools).
  sendToDesign() {
    if (!this.state.shell) {
      // case off: the components go across as one body
      const geo = this.#componentsGeometry();
      if (!geo) { toast('Nothing to send yet - tick some components first.', 'warn'); return; }
      this.app.setWorkspace('design');
      const body = this.app.doc.add(meshBody(geo, `${this.state.name} Components`, { color: '#8fb3e8' }));
      this.app.doc.commit(`Import ${this.state.name}`, 'insert');
      this.app.select([body]);
      this.app.fitAll();
      toast('Components added to the Design workspace as one body.', 'ok', 3000);
      return;
    }
    if (!this.baseMesh.geometry.attributes.position?.count) { toast('Nothing to send yet - tick some components first.', 'warn'); return; }
    const app = this.app;
    const t = this.state.wall;
    const look = (hex) => ({ color: hex });
    const base = this.baseMesh.geometry.clone().translate(0, t, 0);
    const lid = printReady(this.lidMesh.geometry, 'lid');
    const W = this.state.inner.width + 2 * t;
    lid.translate(W + 15, 0, 0);
    app.setWorkspace('design');
    const b1 = app.doc.add(meshBody(base, `${this.state.name} Base`, look('#c9d2de')));
    const b2 = app.doc.add(meshBody(lid, `${this.state.name} Lid`, look('#b7c4e8')));
    app.doc.commit(`Import ${this.state.name}`, 'insert');
    app.select([b1, b2]);
    app.fitAll();
    toast('Base and Lid added to the Design workspace as bodies.', 'ok', 3000);
  }

  // ======================================================================
  // 3D part objects
  // ======================================================================
  #syncParts() {
    const seen = new Set();
    for (const p of this.state.parts) {
      seen.add(p.uid);
      let o = this.partObjs.get(p.uid);
      const key = JSON.stringify(p.def);
      if (!o || o.key !== key) { if (o) this.#disposePart(p.uid); o = this.#makePart(p); o.key = key; this.partObjs.set(p.uid, o); }
      this.#placePart(p, o);
    }
    for (const uid of [...this.partObjs.keys()]) if (!seen.has(uid)) this.#disposePart(uid);
    // number repeated parts in their labels: 'IR Obstacle Sensor #2'
    const seenDef = {};
    for (const p of this.state.parts) {
      const n = this.count(p.def.id), k = (seenDef[p.def.id] = (seenDef[p.def.id] || 0) + 1);
      this.partObjs.get(p.uid).label.textContent = n > 1 ? p.def.name + ' #' + k : p.def.name;
    }
    this.#refreshPartLooks();
  }

  #makePart(p) {
    const { width: w, depth: d, height: h } = p.def.dimensions;
    const group = new THREE.Group();
    const color = new THREE.Color(categoryOf(p.def.category).color);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.6, transparent: true, opacity: 0.92 }));
    body.position.y = h / 2;
    body.userData.uid = p.uid;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.7 }));
    edges.raycast = () => {};
    body.add(edges);
    group.add(body);
    // orange markers where the ports / sensor windows are
    const portMat = new THREE.MeshBasicMaterial({ color: PORT_COLOR });
    for (const c of p.def.cutouts || []) {
      const ph = c.height || c.width;
      let m;
      if (c.side === 'top') {
        m = c.shape === 'circle' ? new THREE.Mesh(new THREE.CylinderGeometry(c.width / 2, c.width / 2, 0.8, 24), portMat) : new THREE.Mesh(new THREE.BoxGeometry(c.width, 0.8, ph), portMat);
        m.position.set(c.offset || 0, h + 0.4, c.offsetY || 0);
      } else {
        const ns = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] }[c.side];
        const half = ns[0] ? w / 2 : d / 2;
        m = c.shape === 'circle' ? new THREE.Mesh(new THREE.CylinderGeometry(c.width / 2, c.width / 2, 1.2, 24), portMat) : new THREE.Mesh(new THREE.BoxGeometry(c.width, ph, 1.2), portMat);
        // face the marker outwards: circles turn their axis to the side normal, rects their face
        if (c.shape === 'circle') { if (ns[0]) m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2; }
        else if (ns[0]) m.rotation.y = Math.PI / 2;
        const along = c.offset || 0;
        m.position.set(ns[0] * (half + 0.3) + (ns[0] ? 0 : along), c.offsetY || ph / 2, ns[1] * (half + 0.3) + (ns[1] ? 0 : along));
      }
      m.raycast = () => {};
      group.add(m);
    }
    this.partsGroup.add(group);
    const label = document.createElement('div');
    label.className = 'mlabel bg-label' + (this.active ? '' : ' hidden');
    label.textContent = p.def.name;
    this.labelHost.appendChild(label);
    return { group, body, edges, label };
  }

  #placePart(p, o) {
    o.group.position.set(p.x, p.y, p.z);
    o.group.rotation.y = THREE.MathUtils.degToRad(p.rot);
  }

  #disposePart(uid) {
    const o = this.partObjs.get(uid);
    if (!o) return;
    this.partsGroup.remove(o.group);
    o.group.traverse((x) => { x.geometry?.dispose(); x.material?.dispose?.(); });
    o.label.remove();
    this.partObjs.delete(uid);
  }

  #refreshPartLooks() {
    for (const p of this.state.parts) {
      const o = this.partObjs.get(p.uid);
      if (!o) continue;
      const sel = p.uid === this.selected, bad = this.bad?.has(p.uid);
      o.body.material.emissive.set(bad ? 0xd9363e : sel ? 0x2f6bff : 0x000000);
      o.body.material.emissiveIntensity = bad ? 0.6 : sel ? 0.45 : 0;
      o.edges.material.color.set(sel ? 0x2f6bff : 0x0f172a);
      o.edges.material.opacity = sel ? 1 : 0.7;
      o.label.classList.toggle('sel', sel);
      o.label.classList.toggle('bad', !!bad);
    }
  }

  #updateLabels() {
    if (!this.active) return;
    const show = this.view.labels && this.partsGroup.visible;
    for (const p of this.state.parts) {
      const o = this.partObjs.get(p.uid);
      if (!o) continue;
      o.label.classList.toggle('hidden', !show);
      if (!show) continue;
      const v = new THREE.Vector3(p.x, p.y + p.def.dimensions.height, p.z).add(this.root.position);
      const s = this.vp.toScreen(v);
      o.label.style.left = s.x + 'px';
      o.label.style.top = s.y + 'px';
    }
  }

  // ======================================================================
  // dragging parts on the floor
  // ======================================================================
  #setupPointer() {
    const el = this.vp.el, canvas = this.vp.canvas;
    let drag = null, down = null;
    const hitPart = (e) => {
      if (!this.partsGroup.visible) return null;
      const bodies = [...this.partObjs.values()].map((o) => o.body);
      return this.vp.raycast(e, bodies)[0] || null;
    };
    const floorPoint = (e, y) => {
      this.vp.setPointer(e);
      const p = new THREE.Vector3();
      return this.vp.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.root.position.y + y)), p) ? p : null;
    };

    // capture phase: decide before OrbitControls whether this press drags a part
    el.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0 || e.target !== canvas) return;
      down = { x: e.clientX, y: e.clientY };
      const hit = hitPart(e);
      if (!hit) return;
      const p = this.part(hit.object.userData.uid);
      if (!p) return;
      this.select(p.uid);
      const fp = floorPoint(e, p.y);
      if (!fp) return;
      this.vp.controls.enabled = false;
      drag = { p, dx: p.x - fp.x, dz: p.z - fp.z, moved: false, before: JSON.stringify(this.state) };
      canvas.setPointerCapture(e.pointerId);
    }, true);

    canvas.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      if (!drag) { canvas.style.cursor = hitPart(e) ? 'grab' : ''; return; }
      const fp = floorPoint(e, drag.p.y);
      if (!fp) return;
      let x = fp.x + drag.dx, z = fp.z + drag.dz;
      if (this.app.snap) { x = Math.round(x * 2) / 2; z = Math.round(z * 2) / 2; }
      const p = drag.p;
      p.x = x; p.z = z;
      // ports pull flush to a wall when they come close
      for (const pl of cutoutPlacements(this.state)) {
        if (pl.part === p && pl.wall !== 'lid' && Math.abs(pl.gap) < 3) { p.x += pl.n[0] * pl.gap; p.z += pl.n[1] * pl.gap; break; }
      }
      drag.moved = true;
      canvas.style.cursor = 'grabbing';
      this.#placePart(p, this.partObjs.get(p.uid));
      this.#validate();
      this.#refreshPartLooks();
      this.#renderInspectorValues();
    });

    const finish = (e) => {
      if (!this.active) return;
      if (drag) {
        this.vp.controls.enabled = true;
        canvas.releasePointerCapture?.(e.pointerId);
        if (drag.moved) {
          drag.p.x = r1(drag.p.x); drag.p.z = r1(drag.p.z);
          this.state.layoutManual = true;
          this.pending = drag.before;
          this.end();
          bus.emit('boxgen:move');
        }
        drag = null;
        canvas.style.cursor = '';
        return;
      }
      if (down && e.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && e.target === canvas) this.select(null);
      down = null;
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  select(uid) {
    if (this.selected === uid) return;
    this.selected = uid;
    this.#refreshPartLooks();
    this.#renderParams();
  }

  // keyboard while the BoxGen workspace is open; returns true when handled
  key(e) {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k.toLowerCase() === 'z' && !e.shiftKey) { this.undo(); return true; }
    if (ctrl && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) { this.redo(); return true; }
    if (ctrl && k.toLowerCase() === 'd') { this.duplicateSelected(); return true; }
    if (ctrl) return false;
    if (k === 'F6' || k.toLowerCase() === 'f') { this.fit(); return true; }
    if (k === 'Escape') { this.select(null); return true; }
    const p = this.selectedPart;
    if (!p) return false;
    if (k.toLowerCase() === 'r') { this.rotateSelected(e.shiftKey ? -90 : 90); return true; }
    if (k === 'Delete' || k === 'Backspace') { this.removeSelected(); return true; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[k]) { this.nudgeSelected(...arrows[k]); return true; }
    return false;
  }

  // ======================================================================
  // panels
  // ======================================================================
  #buildDom() {
    this.libEl = document.getElementById('bg-library');
    this.paramsEl = document.getElementById('bg-params');
    this.viewbar = document.createElement('div');
    this.viewbar.className = 'bg-viewbar hidden';
    document.getElementById('viewport').appendChild(this.viewbar);
    this.#renderViewbar();

    this.libEl.addEventListener('click', (e) => {
      const qty = e.target.closest('[data-qty]');
      if (qty) { const id = qty.dataset.qty; this.setQty(id, this.count(id) + +qty.dataset.d); return; }
      const del = e.target.closest('[data-del-custom]');
      if (del) {
        const id = del.dataset.delCustom;
        this.setQty(id, 0);
        this.change(() => { this.state.custom = this.state.custom.filter((d) => d.id !== id); }, { rebuild: false, parts: false });
        this.#renderLibrary();
        return;
      }
      if (e.target.closest('[data-a=create]')) return this.#createCustom();
      if (e.target.closest('[data-a=generate]')) return this.generate();
      if (e.target.closest('[data-a=clear-sel]')) return this.clearAll();
      if (e.target.closest('.bg-qty, details, input, select')) return;
      // clicking a row ticks it (1) or unticks it (0)
      const row = e.target.closest('[data-item]');
      if (row) this.setQty(row.dataset.item, this.count(row.dataset.item) ? 0 : 1);
    });
    this.libEl.addEventListener('change', (e) => {
      if (e.target.matches('[data-qty-input]')) this.setQty(e.target.dataset.qtyInput, parseInt(e.target.value, 10) || 0);
    });
    this.libEl.addEventListener('input', (e) => { if (e.target.matches('[data-a=search]')) { this.search = e.target.value; this.#renderLibrary(true); } });
    this.libEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const row = e.target.matches?.('[data-item]') ? e.target : null;
      if (row && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); this.setQty(row.dataset.item, this.count(row.dataset.item) ? 0 : 1); this.libEl.querySelector(`[data-item="${row.dataset.item}"]`)?.focus(); }
    });
    this.paramsEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur?.(); });
  }

  #renderViewbar() {
    const v = this.view;
    const seg = (mode, label) => `<button class="bg-seg ${v.mode === mode ? 'on' : ''}" data-mode="${mode}">${label}</button>`;
    const tog = (key, label, title) => `<button class="bg-tog ${v[key] ? 'on' : ''}" data-tog="${key}" title="${title}">${label}</button>`;
    this.viewbar.innerHTML = `
      <div class="bg-segs">${seg('assembled', 'Assembled')}${seg('exploded', 'Exploded')}${seg('base', 'Base only')}${seg('lid', 'Lid only')}</div>
      <div class="bg-togs"><button class="bg-tog ${this.state.shell ? 'on' : ''}" data-shell title="Case on / off: off leaves just the components as one model">Shell</button>${tog('components', 'Components', 'Show / hide the components')}${tog('xray', 'X-Ray', 'See-through enclosure')}${tog('wire', 'Wireframe', 'Wireframe enclosure')}${tog('labels', 'Labels', 'Component names')}</div>`;
    this.viewbar.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { this.setView('mode', b.dataset.mode); setTimeout(() => this.fit(), 30); }; });
    this.viewbar.querySelector('[data-shell]').onclick = () => this.setShell(!this.state.shell);
    this.viewbar.querySelectorAll('[data-tog]').forEach((b) => { b.onclick = () => this.setView(b.dataset.tog, !this.view[b.dataset.tog]); });
  }

  // The component checklist: tick a row (or use − / +) to choose how many of each.
  #renderLibrary(keepFocus = false) {
    const q = this.search.trim().toLowerCase();
    const items = this.library.filter((d) => !q || d.name.toLowerCase().includes(q) || categoryOf(d.category).label.toLowerCase().includes(q));
    const cats = CATEGORIES.map((c) => ({ c, list: items.filter((d) => categoryOf(d.category) === c) })).filter((g) => g.list.length);
    const dim = (d) => `${r1(d.dimensions.width)} × ${r1(d.dimensions.depth)} × ${r1(d.dimensions.height)} mm`;
    const badges = (d) => [
      d.mount === 'standoff' ? '<span class="bg-badge" title="Sits on PCB standoffs">standoffs</span>' : d.mount === 'floor' ? '<span class="bg-badge" title="Screwed through the floor">floor screws</span>' : '',
      (d.cutouts || []).length ? `<span class="bg-badge port" title="${esc(d.cutouts.map((c) => c.label || 'port').join(', '))}">${d.cutouts.length} cutout${d.cutouts.length > 1 ? 's' : ''}</span>` : '',
    ].join('');
    const total = this.state.parts.length;
    const types = new Set(this.state.parts.map((p) => p.def.id)).size;
    const html = `
      <div class="panel-head">COMPONENTS <small class="bg-head-hint">tick what you need</small></div>
      <div class="bg-search">${icon('search')}<input data-a="search" placeholder="Search components…" value="${esc(this.search)}"></div>
      <div class="panel-body bg-lib-body">
        ${cats.map(({ c, list }) => `
          <div class="bg-cat"><span class="dot" style="background:${c.color}"></span>${c.label}</div>
          ${list.map((d) => {
            const n = this.count(d.id);
            return `
            <div class="bg-item ${n ? 'on' : ''}" data-item="${d.id}" role="checkbox" aria-checked="${!!n}" tabindex="0" title="${n ? 'Click to remove' : 'Click to add'}">
              <span class="bg-check">${n ? '✓' : ''}</span>
              <div class="bg-item-text"><b>${esc(d.name)}</b><small>${dim(d)}</small><div class="bg-badges">${badges(d)}</div></div>
              ${d.category === 'custom' ? `<button class="icon-btn bg-x" data-del-custom="${d.id}" title="Remove from library">✕</button>` : ''}
              <div class="bg-qty ${n ? '' : 'off'}" title="How many">
                <button data-qty="${d.id}" data-d="-1" ${n ? '' : 'disabled'} aria-label="One less">−</button>
                <input data-qty-input="${d.id}" type="number" min="0" max="20" value="${n}" aria-label="Quantity">
                <button data-qty="${d.id}" data-d="1" aria-label="One more">+</button>
              </div>
            </div>`;
          }).join('')}`).join('') || '<div class="tree-empty">No component matches.</div>'}
        <details class="bg-custom">
          <summary>${icon('new')} Create custom component</summary>
          <div class="bg-form">
            <label>Name<input data-c="name" value="My module"></label>
            <div class="bg-row3"><label>Width<input data-c="width" type="number" value="40" min="1" step="0.5"></label><label>Depth<input data-c="depth" type="number" value="25" min="1" step="0.5"></label><label>Height<input data-c="height" type="number" value="10" min="1" step="0.5"></label></div>
            <label>Mounting<select data-c="mount"><option value="standoff">PCB standoffs (4 corners)</option><option value="floor">Floor screws</option><option value="none">None</option></select></label>
            <label>Port / opening<select data-c="port"><option value="none">None</option><option value="front">Front edge</option><option value="back">Back edge</option><option value="left">Left edge</option><option value="right">Right edge</option><option value="top">Top (through the lid)</option></select></label>
            <div class="bg-row3"><label>Port W<input data-c="portWidth" type="number" value="9" min="1" step="0.5"></label><label>Port H<input data-c="portHeight" type="number" value="4" min="1" step="0.5"></label><span></span></div>
            <button class="btn small primary" data-a="create">Add to the list</button>
          </div>
        </details>
      </div>
      <div class="bg-gen">
        <div class="bg-gen-sum"><span>${total ? `<b>${total}</b> component${total > 1 ? 's' : ''} · ${types} type${types > 1 ? 's' : ''}` : 'Nothing ticked yet'}</span>
          ${total ? '<button class="link" data-a="clear-sel">Clear</button>' : ''}</div>
        <button class="btn primary bg-gen-btn" data-a="generate" ${total ? '' : 'disabled'}>${icon('boxgen')} ${this.state.layoutManual ? 'Re-generate enclosure' : 'Generate enclosure'}</button>
        ${this.state.layoutManual && total ? '<div class="bg-gen-note">You moved parts by hand - re-generating arranges them automatically again.</div>' : ''}
      </div>`;
    const caret = keepFocus ? this.libEl.querySelector('[data-a=search]')?.selectionStart : null;
    const open = this.libEl.querySelector('.bg-custom')?.open;
    const scroll = this.libEl.querySelector('.bg-lib-body')?.scrollTop || 0;
    this.libEl.innerHTML = html;
    this.libEl.querySelector('.bg-lib-body').scrollTop = scroll;
    if (open) this.libEl.querySelector('.bg-custom').open = true;
    if (keepFocus) { const i = this.libEl.querySelector('[data-a=search]'); i.focus(); i.setSelectionRange(caret, caret); }
  }

  #createCustom() {
    const v = {};
    this.libEl.querySelectorAll('[data-c]').forEach((i) => { v[i.dataset.c] = i.value; });
    if (!(+v.width > 0 && +v.depth > 0 && +v.height > 0)) { toast('Give the component a width, depth and height.', 'warn'); return; }
    const def = customComponent(v);
    this.change(() => { this.state.custom.push(def); }, { rebuild: false, parts: false });
    this.setQty(def.id, 1);
    toast(`<b>${esc(def.name)}</b> added to the list and ticked.`, 'ok');
  }

  clearAll() {
    this.change(() => { this.state.parts = []; this.selected = null; this.state.layoutManual = false; });
    this.#renderLibrary();
  }

  #renderParams() {
    if (!this.active) return;
    const s = this.state, i = s.inner, t = s.wall;
    const p = this.selectedPart;
    const focus = this.paramsEl.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const slider = (k, label, min, max, step, unit = 'mm') => `
      <div class="bg-slider"><label>${label}<b data-out="${k}">${s[k]} ${unit}</b></label>
        <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}"></div>`;
    const placements = p ? cutoutPlacements(s).filter((pl) => pl.part === p) : [];
    this.paramsEl.innerHTML = `
      <div class="panel-head">ENCLOSURE</div>
      <div class="panel-body">
        <div class="props-section">
          <h4>WIRING & VENTILATION</h4>
          ${slider('wiringGap', 'Gap between parts (wiring)', 0, 30, 1)}
          ${slider('headroom', 'Space above parts (cables)', 0, 40, 1)}
          ${slider('padding', 'Clearance at the side walls', 0, 20, 0.5)}
          <div class="bg-switches">
            <label class="bg-switch"><input type="checkbox" data-k="vents" ${s.vents ? 'checked' : ''}><span></span>Vent slots in the side walls</label>
            <label class="bg-switch"><input type="checkbox" data-k="lidVents" ${s.lidVents ? 'checked' : ''}><span></span>Vent slots in the lid</label>
            <label class="bg-switch"><input type="checkbox" data-k="cable" ${s.cableHole > 0 ? 'checked' : ''}><span></span>Cable entry hole (Ø8, left wall)</label>
          </div>
          <div class="props-row-label">${s.layoutManual ? 'Layout: moved by hand (spacing applies when you re-generate)' : 'Layout: automatic - parts with ports face the walls'}</div>
        </div>
        <div class="props-section">
          <h4>INNER SIZE (MM)</h4>
          <div class="bg-row3 dims">
            <label>Width<input type="number" data-k="inner.width" value="${r1(i.width)}" min="10" step="1"></label>
            <label>Depth<input type="number" data-k="inner.depth" value="${r1(i.depth)}" min="10" step="1"></label>
            <label>Height<input type="number" data-k="inner.height" value="${r1(i.height)}" min="5" step="1"></label>
          </div>
          <div class="bg-fit">
            <button class="btn small" data-a="autofit" title="Smallest box around the components where they are now">${icon('fit')} Auto-Fit</button>
          </div>
          <div class="bg-switches"><label class="bg-switch"><input type="checkbox" data-k="emptyBox" ${s.emptyBox ? 'checked' : ''}><span></span>Show the box before components are ticked</label></div>
          <div class="stat"><span>Outside size</span><b data-out="outer">${r1(i.width + 2 * t)} × ${r1(i.depth + 2 * t)} × ${r1(i.height + 2 * t)} mm</b></div>
        </div>
        <div class="props-section">
          <h4>SHELL</h4>
          <div class="bg-switches" style="margin:0 0 10px"><label class="bg-switch"><input type="checkbox" data-k="shell" ${s.shell ? 'checked' : ''}><span></span>Case (base + lid) - off leaves just the components</label></div>
          ${slider('wall', 'Wall thickness', 1.5, 5, 0.1)}
          ${slider('radius', 'Corner radius', 0, 15, 0.5)}
          ${slider('tolerance', 'Lid lip tolerance', 0, 1, 0.05)}
          ${slider('standoffHeight', 'PCB standoff height', 2, 15, 0.5)}
          ${slider('clearance', 'Cutout clearance', 0, 2, 0.1)}
          <div class="bg-switches">
            <label class="bg-switch"><input type="checkbox" data-k="lidScrew" ${s.lid === 'screw' ? 'checked' : ''}><span></span>Screw lid (corner pillars)</label>
          </div>
        </div>
        <div class="props-section bg-inspector">
          <h4>COMPONENT INSPECTOR</h4>
          ${p ? `
            <div class="bg-insp-name"><span class="bg-swatch" style="background:${categoryOf(p.def.category).color}"></span><b>${esc(p.def.name)}</b></div>
            <div class="xyz"><span class="x">X</span><input type="number" step="0.5" data-pf="x" value="${r1(p.x)}"><span class="y">Y</span><input type="number" step="0.5" min="0" data-pf="y" value="${r1(p.y)}"><span class="z">Z</span><input type="number" step="0.5" data-pf="z" value="${r1(p.z)}"></div>
            <div class="props-row-label">Y = height above the floor${p.def.mount === 'standoff' ? ' (= standoff height)' : ''} · rotation ${p.rot}°</div>
            <div class="bg-actions">
              <button class="btn small" data-a="rotl" title="Rotate -90° (Shift+R)">⟲ 90°</button>
              <button class="btn small" data-a="rotr" title="Rotate +90° (R)">⟳ 90°</button>
              ${placements.some((pl) => pl.wall !== 'lid') ? '<button class="btn small" data-a="snap" title="Push the port side against the wall it faces">Snap to wall</button>' : ''}
              <button class="btn small" data-a="dup" title="Ctrl+D">Duplicate</button>
              <button class="btn small danger" data-a="del" title="Delete">Delete</button>
            </div>
            ${placements.length ? `<div class="bg-ports">${placements.map((pl) => `<div class="${pl.cut ? 'ok' : 'off'}">${pl.cut ? '●' : '○'} ${esc(pl.cutout.label || 'Port')} → ${pl.wall === 'lid' ? 'lid' : pl.wall + ' wall'}${pl.cut ? '' : ` (${r1(pl.gap)} mm away)`}</div>`).join('')}</div>` : ''}`
          : '<div class="props-info" style="padding:2px 0">Click a component in the 3D view to move, rotate or delete it. Drag it to move it on the floor.</div>'}
        </div>
        <div class="props-section"><h4>CHECKS</h4><div class="bg-warnings"></div></div>
        <div class="props-section bg-export">
          <h4>EXPORT</h4>
          ${s.shell ? `<button class="btn primary" data-a="exp-base">${icon('export')} Export Base (.STL)</button>
          <button class="btn primary" data-a="exp-lid">${icon('export')} Export Lid (.STL)</button>`
            : `<button class="btn primary" data-a="exp-parts">${icon('export')} Export components (.STL)</button>`}
          <button class="btn" data-a="design">${icon('insert')} Edit in Design workspace</button>
          <div class="bg-status" data-out="status">${esc(this.status)}</div>
        </div>
        <div class="props-actions"><button class="btn small" data-a="clear">Remove all components</button></div>
      </div>`;
    const P = this.paramsEl;
    P.querySelectorAll('input[type=range][data-k]').forEach((r) => {
      r.oninput = () => this.setParam(r.dataset.k, +r.value, { live: true });
      r.onchange = () => this.setParam(r.dataset.k, +r.value);
    });
    P.querySelectorAll('input[type=number][data-k]').forEach((n) => {
      n.onchange = () => { const v = parseFloat(n.value); if (Number.isFinite(v)) this.setParam(n.dataset.k, Math.max(+n.min || 0, v)); };
    });
    P.querySelector('[data-k=vents]').onchange = (e) => this.setParam('vents', e.target.checked);
    P.querySelector('[data-k=shell]').onchange = (e) => this.setShell(e.target.checked);
    P.querySelector('[data-k=emptyBox]').onchange = (e) => this.setParam('emptyBox', e.target.checked);
    P.querySelector('[data-k=lidVents]').onchange = (e) => this.setParam('lidVents', e.target.checked);
    P.querySelector('[data-k=cable]').onchange = (e) => this.setParam('cableHole', e.target.checked ? 8 : 0);
    P.querySelector('[data-k=lidScrew]').onchange = (e) => this.setParam('lid', e.target.checked ? 'screw' : 'friction');
    P.querySelectorAll('[data-pf]').forEach((n) => { n.onchange = () => this.setPartField(n.dataset.pf, parseFloat(n.value)); });
    const act = (a, fn) => { const b = P.querySelector(`[data-a=${a}]`); if (b) b.onclick = fn; };
    act('autofit', () => this.autoFit());
    act('rotl', () => this.rotateSelected(-90));
    act('rotr', () => this.rotateSelected(90));
    act('snap', () => this.snapToWall());
    act('dup', () => this.duplicateSelected());
    act('del', () => this.removeSelected());
    act('exp-base', () => this.exportSTL('base'));
    act('exp-lid', () => this.exportSTL('lid'));
    act('exp-parts', () => this.exportComponents());
    act('design', () => this.sendToDesign());
    act('clear', () => { if (this.state.parts.length && confirm('Remove all components from the enclosure?')) this.change(() => { this.state.parts = []; this.selected = null; }); });
    this.#renderWarnings();
    if (focus) P.querySelector(`[data-k="${focus}"]`)?.focus();
  }

  #renderReadouts() {
    const s = this.state, P = this.paramsEl;
    for (const k of ['wall', 'radius', 'tolerance', 'standoffHeight', 'clearance', 'wiringGap', 'headroom', 'padding']) { const o = P.querySelector(`[data-out=${k}]`); if (o) o.textContent = `${s[k]} mm`; }
    const o = P.querySelector('[data-out=outer]');
    if (o) o.textContent = `${r1(s.inner.width + 2 * s.wall)} × ${r1(s.inner.depth + 2 * s.wall)} × ${r1(s.inner.height + 2 * s.wall)} mm`;
  }

  #renderInspectorValues() {
    const p = this.selectedPart;
    if (!p) return;
    for (const k of ['x', 'z']) { const n = this.paramsEl.querySelector(`[data-pf=${k}]`); if (n) n.value = r1(p[k]); }
  }

  #renderWarnings() {
    const el = this.paramsEl.querySelector('.bg-warnings');
    if (!el) return;
    if (!this.state.parts.length) { el.innerHTML = '<div class="bg-warn info">Add components from the library on the left.</div>'; return; }
    el.innerHTML = this.warnings.length
      ? this.warnings.map(([kind, msg, uid]) => `<button class="bg-warn ${kind}" data-uid="${uid}">${kind === 'err' ? '⚠' : 'ℹ'} ${esc(msg)}</button>`).join('')
      : '<div class="bg-warn good">✓ Everything fits.</div>';
    el.querySelectorAll('[data-uid]').forEach((b) => { b.onclick = () => this.select(b.dataset.uid); });
  }

  #setStatus(text) {
    this.status = text;
    const o = this.paramsEl.querySelector('[data-out=status]');
    if (o) o.textContent = text;
  }
}

// part footprint rectangle [x0, z0, x1, z1]
function rectOf(p) { const f = footprint(p); return [p.x - f.w / 2, p.z - f.d / 2, p.x + f.w / 2, p.z + f.d / 2]; }

function rectCircleDist([x0, z0, x1, z1], cx, cz) {
  const dx = Math.max(x0 - cx, 0, cx - x1), dz = Math.max(z0 - cz, 0, cz - z1);
  return Math.hypot(dx, dz);
}

export { rotXZ };
