import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { Viewport } from './viewport.js';
import { ViewCube } from './viewcube.js';
import {
  Doc, Body, Sketch, ConstructionPlane, DEFAULT_PARAMS, KIND_LABEL, PROFILE_LABEL, ORIGIN_PLANES, paramDefs, getParam, setParam,
  MATERIALS, makePlaneMesh, frameFromNormal, frameNormal, axisName, profileCrossesAxis, profileDefs,
} from './model.js';
import { combine, mirrorBody, cloneBody, rotatedClone, shellBody, SHELLABLE, meshBodyFromGeometry, findOverlaps, worldGeometry } from './ops.js';
import { SketchTool } from './tools/sketch.js';
import { BoxGen } from './boxgen/boxgen.js';
import { MeasureTool } from './tools/measure.js';
import { ArrowManipulator } from './tools/manipulator.js';
import { openDialog, closeDialog, dialogOpen, toast, round } from './ui/dialog.js';
import { bus } from './events.js';

const TRANSFORM_LABEL = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
const TRANSFORM_ICON = { translate: 'move', rotate: 'rotate', scale: 'scale' };
const OP_OPTIONS = [['new', 'New Body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];
const OP_COLOR = { cut: '#e5484d', intersect: '#a78bfa', join: '#4dabf7' };

export class App {
  constructor() {
    this.vp = new Viewport(document.getElementById('viewport'));
    this.doc = new Doc(this.vp.scene);
    this.selection = [];   // selected bodies
    this.profileSel = [];  // selected sketch profiles: { sketch, index }
    this.overlaps = [];
    this.snap = true;
    this.overlapCheck = true;
    this.blockOverlaps = false;
    this.transformMode = null;
    this.display = 'edges'; // shaded | edges | wire
    this.section = null;
    this.pendingFeature = null; // 'extrude' | 'revolve' waiting for a profile pick
    this.manipulating = false;

    this.#buildOriginPlanes();
    this.sketch = new SketchTool(this);
    this.measure = new MeasureTool(this);
    this.arrow = new ArrowManipulator(this);
    this.viewCube = new ViewCube(document.getElementById('viewcube'), this.vp, () => this.vp.setView('home'), () => this.fitAll());

    this.workspace = 'design';
    this.boxgen = new BoxGen(this);

    this.#setupSelection();
    this.#setupPicking();
    this.#setupTransform();
    this.#setupKeyboard();
    this.#setupStatusOptions();

    bus.on('doc:changed', () => {
      this.selection = this.selection.map((b) => this.doc.get(b.id)).filter(Boolean);
      this.profileSel = this.profileSel
        .map(({ sketch, index }) => ({ sketch: this.doc.getSketch(sketch.id), index }))
        .filter(({ sketch, index }) => sketch?.visible && index < sketch.shapes.length);
      this.#applyDisplay();
      this.#applySection();
      this.#applySelection(false);
      this.updateOverlaps();
    });
    bus.on('sketch:changed', () => bus.emit('selection:changed'));
  }

  // ======================================================================
  // helpers
  // ======================================================================
  setHint(text) { document.getElementById('status-hint').innerHTML = text; }

  get primary() { return this.selection[0]; }

  requireSelection(n = 1, what = 'a body') {
    if (this.selection.length >= n) return true;
    toast(n > 1 ? `Select at least ${n} bodies first (Shift+click to add).` : `Select ${what} first - click it in the viewport or the Browser.`, 'warn');
    return false;
  }

  cancelTools() {
    closeDialog(false);
    this.sketch.cancel();
    this.measure.stop();
    this.setTransformMode(null, true);
    this.pendingFeature = null;
    this.stopPicking();
    this.arrow.hide();
  }

  // ----- click-to-pick on bodies (Hole, Offset Face, construction geometry) -----
  // onPick({ body, point, normal, localNormal, cpoint }) is called for each click; return true to keep picking.
  startPicking(hint, onPick, { points = false, snap = false } = {}) {
    this.stopPicking();
    this.pickMode = { onPick, points, snap };
    this.vp.el.classList.add('picking');
    this.setHint(hint + ' Esc to cancel.');
  }

  stopPicking() {
    if (!this.pickMode) return;
    this.pickMode = null;
    this.vp.el.classList.remove('picking');
    this.pickMarker && (this.pickMarker.visible = false);
  }

  // what a pick click hits: a body face (with its normal) or a construction point
  pickSurface(e, { points = false, snap = false } = {}) {
    const targets = this.doc.bodies.filter((b) => b.visible).map((b) => b.mesh);
    if (points) targets.push(...this.doc.points.filter((p) => p.visible).map((p) => p.object));
    const hit = this.vp.raycast(e, targets)[0];
    if (!hit) return null;
    if (hit.object.userData.cpoint) return { cpoint: hit.object.userData.cpoint, point: hit.object.userData.cpoint.point, snapped: true };
    const body = hit.object.userData.body;
    const localNormal = hit.face.normal.clone();
    const normal = localNormal.clone().transformDirection(hit.object.matrixWorld).normalize();
    let point = hit.point.clone(), snapped = false;
    if (snap) {
      // snap to the nearest corner of the hit triangle when close on screen (like Measure)
      const pos = hit.object.geometry.attributes.position;
      let best = null, bestD = Infinity;
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
        const d = v.distanceTo(hit.point);
        if (d < bestD) { bestD = d; best = v; }
      }
      if (bestD < this.vp.worldPerPixel(hit.point) * 14) { point = best; snapped = true; }
    }
    return { body, point, normal, localNormal, snapped };
  }

  #setupPicking() {
    this.pickMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf28c28, depthTest: false }));
    this.pickMarker.renderOrder = 10;
    this.pickMarker.visible = false;
    this.vp.scene.add(this.pickMarker);
    const c = this.vp.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => { if (this.pickMode && e.button === 0) down = [e.clientX, e.clientY]; });
    c.addEventListener('pointermove', (e) => {
      if (!this.pickMode) return;
      const r = this.pickSurface(e, this.pickMode);
      this.pickMarker.visible = !!r;
      c.style.cursor = r ? 'pointer' : '';
      if (r) { this.pickMarker.position.copy(r.point); this.pickMarker.scale.setScalar(this.vp.worldPerPixel(r.point) * (r.snapped ? 5 : 3)); }
    });
    c.addEventListener('pointerup', (e) => {
      if (!this.pickMode || !down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 5) return;
      const r = this.pickSurface(e, this.pickMode);
      if (!r) return;
      const mode = this.pickMode;
      if (!mode.onPick(r)) { if (this.pickMode === mode) this.stopPicking(); c.style.cursor = ''; }
    });
  }

  // public hooks used by features.js
  refreshSelection(announce = false) { this.#applySelection(announce); }
  applyFeature(previews, op, refs, label, iconName) { return this.#applyFeature(previews, op, refs, label, iconName); }
  ghost(bodies, op) { this.#ghost(bodies, op); }

  // Finds a spot on the X axis where a new body doesn't overlap existing ones.
  placeFree(body) {
    const others = this.doc.bodies.filter((b) => b !== body && b.visible);
    if (!others.length) return;
    const size = body.worldBox().getSize(new THREE.Vector3());
    const y = body.mesh.position.y;
    for (let i = 0; i < 40; i++) {
      const x = i === 0 ? 0 : Math.ceil(i / 2) * (size.x + 10) * (i % 2 ? 1 : -1);
      body.mesh.position.set(x, y, 0);
      const box = body.worldBox().expandByScalar(-0.05);
      if (!others.some((o) => o.worldBox().intersectsBox(box))) return;
    }
  }

  // Workspaces: 'design' (Fusion-style modelling) or 'boxgen' (IoT enclosure generator).
  setWorkspace(ws) {
    if (ws === this.workspace) return;
    this.cancelTools();
    this.select([]);
    this.workspace = ws;
    const design = ws === 'design';
    for (const g of [this.doc.group, this.doc.sketchGroup, this.doc.planeGroup]) g.visible = design;
    this.originGroup.visible = design && this.originVisible;
    this.vp.transform.detach();
    document.body.dataset.workspace = ws;
    try { localStorage.setItem('minicad-workspace', ws); } catch { /* storage blocked */ }
    this.boxgen.setActive(!design);
    if (design) { this.setHint('Select a command from the toolbar, or right-click for the marking menu.'); this.fitAll(); }
    bus.emit('workspace', { workspace: ws });
    bus.emit('doc:renamed');
    bus.emit('tool:changed');
  }

  fitAll() {
    if (this.workspace === 'boxgen') return this.boxgen.fit();
    const box = new THREE.Box3();
    for (const b of this.doc.bodies) if (b.visible) box.union(b.worldBox());
    for (const s of this.doc.sketches) if (s.visible && s.shapes.length) box.union(new THREE.Box3().setFromObject(s.object));
    this.vp.fit(box);
  }

  updateOverlaps() {
    const pairs = this.overlapCheck ? findOverlaps(this.doc.bodies) : [];
    this.overlaps = pairs;
    const bad = new Set(pairs.flat());
    for (const b of this.doc.bodies) { b.overlapping = bad.has(b); b.refreshHighlight(); }
    const el = document.getElementById('status-overlap');
    if (!this.overlapCheck) { el.textContent = ''; el.className = ''; }
    else if (pairs.length) { el.textContent = `⚠ ${pairs.length} interference${pairs.length > 1 ? 's' : ''}: ${pairs.map(([a, b]) => `${a.name}/${b.name}`).join(', ')}`; el.className = 'bad'; }
    else if (this.doc.bodies.length > 1) { el.textContent = '✓ No overlaps'; el.className = 'good'; }
    else { el.textContent = ''; el.className = ''; }
    bus.emit('overlaps', { count: pairs.length });
  }

  // ======================================================================
  // origin planes (shown while choosing a sketch plane, or from the Browser)
  // ======================================================================
  #buildOriginPlanes() {
    this.originGroup = new THREE.Group();
    this.originPlanes = {};
    for (const [name, def] of Object.entries(ORIGIN_PLANES)) {
      const m = makePlaneMesh(0xf28c28, 100);
      const f = frameFromNormal(def.normal);
      m.quaternion.fromArray(f.q);
      m.position.copy(new THREE.Vector3(...def.normal).multiplyScalar(0.01));
      m.children[0].userData.originPlane = name;
      this.originPlanes[name] = m;
      this.originGroup.add(m);
    }
    this.originGroup.visible = false;
    this.originVisible = false;
    this.vp.scene.add(this.originGroup);
  }

  showOriginPlanes(forPicking) { this.originGroup.visible = forPicking || this.originVisible; }

  toggleOrigin() {
    this.originVisible = !this.originVisible;
    this.showOriginPlanes(false);
    bus.emit('selection:changed');
  }

  highlightOriginPlane(name) {
    for (const [n, m] of Object.entries(this.originPlanes)) m.children[0].material.opacity = n === name ? 0.38 : 0.12;
  }

  // ======================================================================
  // selection
  // ======================================================================
  #setupSelection() {
    const c = this.vp.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, gizmo: !!this.vp.transform.axis, button: e.button };
    });
    c.addEventListener('pointerup', (e) => {
      if (!down || down.button !== 0) return;
      const d = down; down = null;
      if (this.workspace !== 'design' || d.gizmo || this.manipulating || this.pickMode || this.sketch.active || this.sketch.picking || this.measure.active) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const hit = this.pickAt(e);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (hit?.profile) this.selectProfile(hit.profile.sketch, hit.profile.index, additive);
      else if (hit?.body) this.select([hit.body], additive);
      else if (!additive) this.select([]);
    });
  }

  // What is under the mouse: a body or a sketch profile.
  pickAt(e) {
    const meshes = this.doc.bodies.filter((b) => b.visible).map((b) => b.mesh);
    const fills = this.doc.sketches.filter((s) => s.visible).flatMap((s) => s.fills);
    const hit = this.vp.raycast(e, [...meshes, ...fills])[0];
    if (!hit) return null;
    if (hit.object.userData.sketch) return { profile: { sketch: hit.object.userData.sketch, index: hit.object.userData.index }, point: hit.point };
    return { body: hit.object.userData.body, point: hit.point };
  }

  selectProfile(sketch, index, additive = false) {
    this.selection = [];
    const has = this.profileSel.findIndex((p) => p.sketch === sketch && p.index === index);
    if (additive) {
      if (has >= 0) this.profileSel.splice(has, 1); else this.profileSel.push({ sketch, index });
    } else {
      this.profileSel = [{ sketch, index }];
    }
    this.#applySelection(false);
    bus.emit('sketch:select', { sketch, index });
    if (this.pendingFeature && this.profileSel.length) {
      const kind = this.pendingFeature;
      this.pendingFeature = null;
      if (typeof kind === 'function') kind([...this.profileSel]);
      else kind === 'extrude' ? this.extrudeDialog([...this.profileSel]) : this.revolveDialog([...this.profileSel]);
    }
  }

  // all profiles of a sketch (clicking the sketch in the Browser)
  selectSketch(sketch) {
    this.selection = [];
    this.profileSel = sketch.profileIndices.map((index) => ({ sketch, index }));
    this.#applySelection(false);
    bus.emit('sketch:select', { sketch, index: -1 });
  }

  select(bodies, additive = false) {
    this.profileSel = [];
    if (additive) {
      const sel = [...this.selection];
      for (const b of bodies) {
        const i = sel.indexOf(b);
        if (i >= 0) sel.splice(i, 1); else sel.push(b);
      }
      this.selection = sel;
    } else {
      this.selection = [...bodies];
    }
    this.#applySelection(true);
  }

  #applySelection(announce) {
    for (const b of this.doc.bodies) { b.selected = this.selection.includes(b); b.refreshHighlight(); }
    for (const s of this.doc.sketches) {
      s.selected = new Set(this.profileSel.filter((p) => p.sketch === s).map((p) => p.index));
      s.refreshHighlight();
    }
    const t = this.vp.transform;
    if (this.transformMode && this.primary) t.attach(this.primary.mesh);
    else t.detach();
    if (announce) bus.emit('select', { bodies: this.selection });
    bus.emit('selection:changed');
  }

  // ======================================================================
  // display + navigation
  // ======================================================================
  setDisplay(mode) {
    this.display = mode;
    this.#applyDisplay();
    bus.emit('display', { mode });
    bus.emit('tool:changed');
  }

  #applyDisplay() {
    for (const b of this.doc.bodies) {
      b.mesh.material.wireframe = this.display === 'wire';
      b.edges.visible = this.display !== 'shaded';
    }
  }

  setNavMode(mode) {
    this.navMode = mode;
    const M = THREE.MOUSE;
    this.vp.controls.mouseButtons.LEFT = mode === 'pan' ? M.PAN : mode === 'zoom' ? M.DOLLY : M.ROTATE;
    bus.emit('tool:changed');
  }

  // Look At: turn the camera square-on to the selected profile's sketch plane.
  lookAt() {
    const s = this.sketch.sketch || this.profileSel[0]?.sketch;
    if (s) {
      const n = s.normal;
      if (Math.abs(n.y) > 0.99) n.z += 0.0001;
      this.vp.setView('lookat', n);
    } else {
      toast('Look At: select a sketch profile first (or use the ViewCube).', 'warn');
    }
  }

  // ======================================================================
  // move / rotate / scale gizmo
  // ======================================================================
  #setupTransform() {
    const t = this.vp.transform;
    let start = null;
    t.addEventListener('mouseDown', () => {
      const m = t.object;
      start = m && { pos: m.position.clone(), quat: m.quaternion.clone(), scale: m.scale.clone() };
    });
    let pending = false;
    t.addEventListener('objectChange', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; this.updateOverlaps(); bus.emit('selection:changed'); });
    });
    t.addEventListener('mouseUp', () => {
      const m = t.object;
      if (!m || !start) return;
      const body = m.userData.body;
      const changed = !m.position.equals(start.pos) || !m.quaternion.equals(start.quat) || !m.scale.equals(start.scale);
      if (!changed) return;
      this.updateOverlaps();
      if (this.blockOverlaps && body.overlapping) {
        m.position.copy(start.pos); m.quaternion.copy(start.quat); m.scale.copy(start.scale);
        this.updateOverlaps();
        toast('That move would make bodies overlap, so it was undone (Block overlaps is on).', 'warn', 3500);
        return;
      }
      this.doc.commit(`${TRANSFORM_LABEL[this.transformMode]} ${body.name}`, TRANSFORM_ICON[this.transformMode]);
      bus.emit('transform', { mode: this.transformMode, body });
    });
    this.applySnap();
  }

  applySnap() {
    const t = this.vp.transform;
    t.setTranslationSnap(this.snap ? 1 : null);
    t.setRotationSnap(this.snap ? THREE.MathUtils.degToRad(15) : null);
    t.setScaleSnap(this.snap ? 0.05 : null);
  }

  setTransformMode(mode, silent = false) {
    if (mode && !this.requireSelection()) return false;
    if (mode) { closeDialog(false); this.sketch.cancel(); this.measure.stop(); }
    this.transformMode = mode;
    const t = this.vp.transform;
    if (mode) {
      t.setMode(mode);
      t.attach(this.primary.mesh);
      const hints = {
        translate: 'Move: drag an arrow (one axis) or a square (two axes). Snap: 1 mm.',
        rotate: 'Rotate: drag a coloured ring. Snap: 15°.',
        scale: 'Scale: drag a handle; the centre cube scales evenly.',
      };
      this.setHint(hints[mode] + ' Press OK (or Esc) in the Move/Copy dialog when done.');
      bus.emit('tool', { tool: mode });
    } else {
      t.detach();
      if (!silent) this.setHint('Select a command from the toolbar, or right-click for the marking menu.');
    }
    bus.emit('tool:changed');
    return true;
  }

  // MODIFY > Move/Copy: the gizmo plus a small dialog to switch move / rotate / scale.
  moveDialog(mode = 'translate') {
    if (!this.requireSelection()) return;
    this.cancelTools();
    const startIndex = this.doc.index;
    if (!this.setTransformMode(mode)) return;
    openDialog({
      title: 'Move/Copy', subtitle: this.selection.map((b) => b.name).join(', '),
      help: 'Drag the arrows, squares or rings in the viewport. Exact values can also be typed in Properties.',
      fields: [
        { key: 'mode', label: 'Move type', type: 'select', value: mode, options: [['translate', 'Translate'], ['rotate', 'Rotate'], ['scale', 'Scale']] },
        { key: 'copy', label: 'Create copy first', type: 'checkbox', value: false },
      ],
      onChange: (v) => {
        if (v.copy && !this._copied) {
          this._copied = true;
          const copies = this.selection.map((b) => this.doc.add(cloneBody(b, this.doc)));
          this.doc.commit(`Copy ${copies.map((c) => c.name).join(', ')}`, 'duplicate');
          this.select(copies);
          bus.emit('duplicate', { count: copies.length });
        }
        if (v.mode !== this.transformMode && this.primary) {
          this.transformMode = v.mode;
          this.vp.transform.setMode(v.mode);
          this.vp.transform.attach(this.primary.mesh);
          bus.emit('tool', { tool: v.mode });
          bus.emit('tool:changed');
        }
      },
      onOk: () => { this._copied = false; this.setTransformMode(null); },
      onCancel: (reason) => {
        this._copied = false;
        this.setTransformMode(null, true);
        if (reason === 'user' && this.doc.index > startIndex) this.doc.goto(startIndex);
      },
    });
  }

  // ======================================================================
  // CREATE: primitives
  // ======================================================================
  createPrimitive(kind) {
    this.cancelTools();
    bus.emit('tool', { tool: kind });
    const body = this.doc.add(new Body({ kind, name: this.doc.newName(kind), params: DEFAULT_PARAMS[kind] }));
    this.placeFree(body);
    this.updateOverlaps();
    const p = body.mesh.position;
    const defs = paramDefs(kind, body.params);
    // Until the user types a position, keep re-placing the body in free space as its size changes.
    let auto = { x: p.x, z: p.z };
    let dlg = null;
    dlg = openDialog({
      title: KIND_LABEL[kind], subtitle: 'CREATE',
      help: 'Edit the size and position. The preview updates live. Press <b>OK</b> (or Enter) to create it.',
      fields: [
        ...defs.map((d) => ({ ...d, value: getParam(body.params, d.key) })),
        { key: 'x', label: 'Position X', type: 'number', value: p.x, step: 1 },
        { key: 'y', label: 'Position Y', type: 'number', value: p.y, step: 1 },
        { key: 'z', label: 'Position Z', type: 'number', value: p.z, step: 1 },
      ],
      onChange: (v) => {
        for (const d of defs) setParam(body.params, d.key, v[d.key]);
        body.rebuild();
        if (auto && (Math.abs(v.x - auto.x) > 1e-6 || Math.abs(v.z - auto.z) > 1e-6)) auto = null;
        if (auto) {
          body.mesh.position.y = v.y;
          this.placeFree(body);
          auto = { x: body.mesh.position.x, z: body.mesh.position.z };
          dlg?.setSilent('x', auto.x);
          dlg?.setSilent('z', auto.z);
        } else {
          body.mesh.position.set(v.x, v.y, v.z);
        }
        this.updateOverlaps();
      },
      onOk: () => {
        this.doc.commit(`Create ${body.name}`, kind);
        this.select([body]);
        this.setHint(`${body.name} created. Use Move (M) to position it, or edit it in Properties.`);
        bus.emit('body:create', { body, kind, params: body.params });
      },
      onCancel: () => { this.doc.remove(body); this.updateOverlaps(); },
    });
    this.setHint(`Creating ${KIND_LABEL[kind]} - set its size in the dialog.`);
  }

  // ======================================================================
  // SKETCH
  // ======================================================================
  // CREATE > Create Sketch: choose a plane, then the sketch environment opens.
  createSketch(tool = null) {
    this.cancelTools();
    this.select([]);
    bus.emit('tool', { tool: 'sketch' });
    this.sketch.pickPlane((sk) => { if (tool) this.sketch.setTool(tool); return sk; });
  }

  // Sketch on an origin plane straight away (used by the start screen).
  sketchOnPlane(planeName = 'XZ', tool = 'rect') {
    this.cancelTools();
    this.select([]);
    const sk =this.doc.addSketch(new Sketch({ name: this.doc.newName('sketch'), frame: frameFromNormal(ORIGIN_PLANES[planeName].normal), planeName }));
    bus.emit('sketch:plane', { plane: planeName, kind: 'origin' });
    this.sketch.begin(sk, true, tool);
  }

  // A sketch tool button: inside a sketch it switches tool, outside it starts Create Sketch.
  sketchTool(tool) {
    if (this.sketch.active) this.sketch.setTool(tool);
    else this.createSketch(tool);
  }

  finishSketch() {
    if (!this.sketch.active && !this.sketch.picking) { toast('No sketch is open. Use CREATE ▸ Create Sketch.', 'warn'); return; }
    this.sketch.finish();
  }

  editSketch(sketch) {
    this.cancelTools();
    this.select([]);
    this.sketch.begin(sketch, false);
  }

  // ======================================================================
  // CREATE: Extrude / Revolve (features made from sketch profiles)
  // ======================================================================
  extrude() { this.#beginFeature('extrude'); }
  revolve() { this.#beginFeature('revolve'); }

  #beginFeature(kind) {
    if (this.sketch.active || this.sketch.picking) this.sketch.finish();
    closeDialog(false);
    this.measure.stop();
    this.setTransformMode(null, true);
    bus.emit('tool', { tool: kind });
    const sel = this.profileSel.filter((p) => p.sketch.visible);
    if (sel.length) return kind === 'extrude' ? this.extrudeDialog(sel) : this.revolveDialog(sel);
    const all = this.doc.sketches.filter((s) => s.visible).flatMap((s) => s.profileIndices.map((index) => ({ sketch: s, index })));
    if (!this.doc.sketches.length) {
      toast('There are no sketches yet. Use <b>CREATE ▸ Create Sketch</b>, draw a closed shape, then Finish Sketch.', 'warn', 4000);
      return;
    }
    if (!all.length) {
      toast('All sketches are hidden (they hide after a feature uses them). Show one with its eye icon in the Browser.', 'warn', 4500);
      return;
    }
    if (all.length === 1) return kind === 'extrude' ? this.extrudeDialog(all) : this.revolveDialog(all);
    this.select([]);
    this.pendingFeature = kind;
    this.setHint(`${kind === 'extrude' ? 'Extrude' : 'Revolve'}: click a <b>profile</b> (shaded sketch area). Shift+click before the command to use several. Esc to cancel.`);
  }

  #featureBody(kind, ref, params) {
    const { sketch, index } = ref;
    const shape = sketch.shapes[index];
    const q = new THREE.Quaternion(...sketch.frame.q);
    const position = kind === 'revolve' ? sketch.frame.o : sketch.toWorld(shape.c[0], shape.c[1]).toArray();
    const body = new Body({
      kind, name: this.doc.newName(kind), params: { profile: structuredClone(shape.profile), ...params(shape) },
      position, rotation: new THREE.Euler().setFromQuaternion(q).toArray().slice(0, 3),
    });
    return this.doc.add(body);
  }

  #ghost(bodies, op) {
    for (const b of bodies) {
      const m = b.mesh.material;
      const ghost = op !== 'new';
      m.transparent = ghost;
      m.opacity = ghost ? 0.45 : 1;
      m.depthWrite = !ghost;
      m.color.set(OP_COLOR[op] || b.color);
    }
  }

  // Applies New Body / Join / Cut / Intersect for preview bodies; returns the event info.
  #applyFeature(previews, op, refs, label, iconName) {
    this.#ghost(previews, 'new');
    for (const { sketch } of refs) sketch.setVisible(false); // consumed, like Fusion
    this.profileSel = [];
    if (op !== 'new') {
      const hits = previews.map((pv) => {
        const box = pv.worldBox().expandByScalar(-0.05);
        return this.doc.bodies.filter((b) => !previews.includes(b) && b.visible && b.worldBox().intersectsBox(box));
      });
      if (!hits.some((h) => h.length)) {
        toast(`Nothing to ${op} - the feature doesn't touch any body, so it was created as a new body.`, 'warn', 4000);
        op = 'new';
      } else {
        try {
          const results = [];
          let affected = 0;
          previews.forEach((pv, i) => {
            const targets = hits[i].filter((t) => this.doc.bodies.includes(t));
            if (!targets.length) { if (op === 'join') results.push(pv); else this.doc.remove(pv); return; }
            affected += targets.length;
            if (op === 'join') {
              const r = combine(targets[0], [pv, ...targets.slice(1)], 'join');
              for (const t of targets) this.doc.remove(t);
              if (r) results.push(this.doc.add(r));
            } else {
              for (const t of targets) {
                const r = combine(t, [pv], op);
                this.doc.remove(t);
                if (r) results.push(this.doc.add(r));
              }
            }
            this.doc.remove(pv);
          });
          this.doc.commit(`${label} (${op})`, iconName);
          this.select(results);
          return { op, affected };
        } catch (err) {
          console.error(err);
          for (const pv of previews) if (this.doc.bodies.includes(pv)) this.doc.remove(pv);
          this.updateOverlaps();
          toast('The boolean operation failed for this shape. Try a slightly different size.', 'err');
          return null;
        }
      }
    }
    this.doc.commit(label, iconName);
    this.select(previews);
    return { op: 'new', affected: 0 };
  }

  extrudeDialog(refs) {
    this.profileSel = refs;
    this.#applySelection(false);
    const first = refs[0];
    const normal = first.sketch.normal;
    const base = first.sketch.toWorld(first.sketch.shapes[first.index].c[0], first.sketch.shapes[first.index].c[1]);
    const profileType = first.sketch.shapes[first.index].profile.type;
    const previews = refs.map((r) => this.#featureBody('extrude', r, () => ({ height: 20, start: 0, taper: 0 })));
    bus.emit('extrude:open', { sketch: first.sketch });
    let dlg = null;
    const distOf = (v) => (v.dir === 'sym' ? Math.abs(v.distance) : v.distance);
    this.arrow.show(base, normal, 20, 0, (t) => dlg?.set('distance', t));
    dlg = openDialog({
      title: 'Extrude', subtitle: `${refs.length} profile${refs.length > 1 ? 's' : ''} · ${first.sketch.name}`,
      help: 'Drag the <b>blue arrow</b> or type a distance (negative = other side). <b>Join</b> adds to touching bodies, <b>Cut</b> removes material, <b>Intersect</b> keeps the overlap.',
      fields: [
        { key: 'dir', label: 'Direction', type: 'select', value: 'one', options: [['one', 'One Side'], ['sym', 'Symmetric']] },
        { key: 'distance', label: 'Distance (mm)', type: 'number', value: 20, step: 1 },
        { key: 'offset', label: 'Start offset (mm)', type: 'number', value: 0, step: 1 },
        { key: 'taper', label: 'Taper angle (°)', type: 'number', value: 0, min: -40, max: 40, step: 1 },
        { key: 'op', label: 'Operation', type: 'select', value: 'new', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        let d = v.distance;
        if (Math.abs(d) < 0.1) d = 0.1 * (Math.sign(d) || 1);
        let start, height;
        if (v.dir === 'sym') { start = v.offset - Math.abs(d); height = 2 * Math.abs(d); }
        else if (d >= 0) { start = v.offset; height = d; }
        else { start = v.offset + d; height = -d; }
        for (const b of previews) {
          Object.assign(b.params, { start, height, taper: v.taper });
          b.rebuild();
        }
        this.#ghost(previews, v.op);
        this.arrow.set(v.dir === 'sym' ? Math.abs(d) : d, v.offset);
        this.updateOverlaps();
      },
      onOk: (v) => {
        this.arrow.hide();
        const res = this.#applyFeature(previews, v.op, refs, 'Extrude', 'extrude');
        if (res) bus.emit('extrude', { ...res, height: Math.abs(distOf(v)), taper: v.taper, direction: v.dir, profileType });
      },
      onCancel: () => {
        this.arrow.hide();
        for (const b of previews) this.doc.remove(b);
        this.updateOverlaps();
      },
    });
    this.setHint('Extrude: drag the arrow or type a distance, choose an operation, then OK.');
  }

  revolveDialog(refs) {
    this.profileSel = refs;
    this.#applySelection(false);
    const sketch = refs[0].sketch;
    if (refs.some((r) => r.sketch !== sketch)) { toast('Revolve: pick profiles from one sketch.', 'warn'); return; }
    const q = new THREE.Quaternion(...sketch.frame.q);
    const o = new THREE.Vector3(...sketch.frame.o);
    const axisDir = (a) => (a === 'u' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).applyQuaternion(q);
    const axisLabel = (a) => `Sketch ${a === 'u' ? 'horizontal' : 'vertical'} axis${axisName(axisDir(a)) ? ` (${axisName(axisDir(a)).slice(1)})` : ''}`;
    // construction axes lying in the sketch plane can be used too
    const inv = q.clone().invert();
    const lines = {};
    for (const ax of this.doc.axes) {
      const lo = ax.origin.sub(o).applyQuaternion(inv), ld = ax.dir.applyQuaternion(inv);
      if (Math.abs(ld.y) > 1e-3 || Math.abs(lo.y) > 1e-3) continue;
      const l = Math.hypot(ld.x, ld.z);
      lines['ax:' + ax.id] = { ax, line: { o: [lo.x, lo.z], d: [ld.x / l, ld.z / l] } };
    }
    const axisParams = (a) => (lines[a] ? { axis: 'line', axisLine: lines[a].line } : { axis: a });
    const crosses = (a) => refs.some((r) => profileCrossesAxis(sketch.shapes[r.index].profile, sketch.shapes[r.index].c, axisParams(a).axis, lines[a]?.line));
    const firstAxis = !crosses('v') ? 'v' : 'u';
    const shapeOf = (r) => sketch.shapes[r.index];
    const previews = refs.map((r) => this.#featureBody('revolve', r, (s) => ({ c: [...s.c], axis: firstAxis, angle: 360 })));
    // axis line preview
    const axisLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xf28c28, dashSize: 4, gapSize: 3, depthTest: false }));
    axisLine.renderOrder = 10;
    this.vp.scene.add(axisLine);
    const drawAxis = (a) => {
      const c = lines[a] ? lines[a].ax.origin : o;
      const d = (lines[a] ? lines[a].ax.dir : axisDir(a)).multiplyScalar(200);
      axisLine.geometry.dispose();
      axisLine.geometry = new THREE.BufferGeometry().setFromPoints([c.clone().sub(d), c.clone().add(d)]);
      axisLine.computeLineDistances();
    };
    const cleanup = () => { this.vp.scene.remove(axisLine); axisLine.geometry.dispose(); };
    bus.emit('revolve:open', { sketch });
    openDialog({
      title: 'Revolve', subtitle: `${refs.length} profile${refs.length > 1 ? 's' : ''} · ${sketch.name}`,
      help: 'Spins the profile around an axis (orange dashed line) through the sketch origin. The profile must stay on one side of the axis.',
      fields: [
        { key: 'axis', label: 'Axis', type: 'select', value: firstAxis, options: [['v', axisLabel('v')], ['u', axisLabel('u')], ...Object.entries(lines).map(([k, l]) => [k, l.ax.name])] },
        { key: 'angle', label: 'Angle (°)', type: 'number', value: 360, min: 1, max: 360, step: 15 },
        { key: 'op', label: 'Operation', type: 'select', value: 'new', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        drawAxis(v.axis);
        const bad = crosses(v.axis);
        previews.forEach((b, i) => {
          b.mesh.visible = !bad;
          if (bad) return;
          Object.assign(b.params, { axisLine: undefined, ...axisParams(v.axis), angle: v.angle, c: [...shapeOf(refs[i]).c] });
          b.rebuild();
        });
        this.#ghost(previews, v.op);
        this.setHint(bad ? '⚠ The profile crosses this axis - choose the other axis or move the profile.' : 'Revolve: choose the axis and angle, then OK.');
        this.updateOverlaps();
      },
      onOk: (v) => {
        cleanup();
        if (crosses(v.axis)) {
          for (const b of previews) this.doc.remove(b);
          toast('Revolve failed: the profile crosses the axis.', 'err');
          return;
        }
        const res = this.#applyFeature(previews, v.op, refs, 'Revolve', 'revolve');
        if (res) bus.emit('revolve', { ...res, angle: v.angle, axis: axisParams(v.axis).axis });
      },
      onCancel: () => { cleanup(); for (const b of previews) this.doc.remove(b); this.updateOverlaps(); },
    });
  }

  // ======================================================================
  // CREATE: patterns + mirror
  // ======================================================================
  mirrorDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'mirror' });
    if (!this.requireSelection()) return;
    const sources = [...this.selection];
    let previews = [];
    const clear = () => { for (const p of previews) this.doc.remove(p); previews = []; };
    openDialog({
      title: 'Mirror', subtitle: `${sources.length} bod${sources.length > 1 ? 'ies' : 'y'}`,
      help: 'Creates a mirrored copy on the other side of an origin plane. YZ flips left/right (X), XY flips front/back (Z).',
      fields: [{ key: 'plane', label: 'Mirror plane', type: 'select', value: 'YZ', options: [['YZ', 'YZ plane (flip X)'], ['XY', 'XY plane (flip Z)'], ['XZ', 'XZ plane (flip Y)']] }],
      onChange: (v) => {
        clear();
        previews = sources.map((s) => this.doc.add(mirrorBody(s, v.plane, this.doc)));
        this.updateOverlaps();
      },
      onOk: () => {
        this.doc.commit('Mirror', 'mirror');
        this.select(previews);
        bus.emit('mirror', { count: previews.length });
      },
      onCancel: () => { clear(); this.updateOverlaps(); },
    });
  }

  patternDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'pattern' });
    if (!this.requireSelection()) return;
    const src = this.primary;
    const size = src.worldBox().getSize(new THREE.Vector3());
    let copies = [];
    const clear = () => { for (const c of copies) this.doc.remove(c); copies = []; };
    openDialog({
      title: 'Rectangular Pattern', subtitle: src.name,
      help: 'Repeats the body in rows (X) and columns (Z). Spacing is measured centre to centre.',
      fields: [
        { key: 'nx', label: 'Quantity X', type: 'number', value: 3, min: 1, max: 20, step: 1 },
        { key: 'sx', label: 'Spacing X (mm)', type: 'number', value: Math.round(size.x + 10), step: 1 },
        { key: 'nz', label: 'Quantity Z', type: 'number', value: 1, min: 1, max: 20, step: 1 },
        { key: 'sz', label: 'Spacing Z (mm)', type: 'number', value: Math.round(size.z + 10), step: 1 },
      ],
      onChange: (v) => {
        clear();
        for (let i = 0; i < Math.round(v.nx); i++) {
          for (let j = 0; j < Math.round(v.nz); j++) {
            if (i === 0 && j === 0) continue;
            copies.push(this.doc.add(cloneBody(src, this.doc, [i * v.sx, 0, j * v.sz])));
          }
        }
        this.updateOverlaps();
      },
      onOk: () => {
        if (!copies.length) return;
        this.doc.commit(`Pattern ${src.name} ×${copies.length + 1}`, 'pattern');
        bus.emit('pattern', { count: copies.length + 1, kind: 'rect' });
      },
      onCancel: () => { clear(); this.updateOverlaps(); },
    });
  }

  circularPatternDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'circpattern' });
    if (!this.requireSelection()) return;
    const src = this.primary;
    let copies = [];
    const clear = () => { for (const c of copies) this.doc.remove(c); copies = []; };
    const AXES = { Y: new THREE.Vector3(0, 1, 0), X: new THREE.Vector3(1, 0, 0), Z: new THREE.Vector3(0, 0, 1) };
    const pivots = {};
    for (const ax of this.doc.axes) { AXES['ax:' + ax.id] = ax.dir; pivots['ax:' + ax.id] = ax.origin; }
    openDialog({
      title: 'Circular Pattern', subtitle: src.name,
      help: 'Copies the body around an axis (an origin axis, or a construction axis from CONSTRUCT). Tip: move the body away from the axis first (e.g. X = 40).',
      fields: [
        { key: 'axis', label: 'Axis', type: 'select', value: 'Y', options: [['Y', 'Y axis (vertical)'], ['X', 'X axis'], ['Z', 'Z axis'], ...this.doc.axes.map((a) => ['ax:' + a.id, a.name])] },
        { key: 'n', label: 'Quantity', type: 'number', value: 6, min: 2, max: 36, step: 1 },
        { key: 'angle', label: 'Total angle (°)', type: 'number', value: 360, min: 1, max: 360, step: 15 },
      ],
      onChange: (v) => {
        clear();
        const n = Math.round(v.n);
        const full = v.angle >= 359.999;
        const step = THREE.MathUtils.degToRad(v.angle) / (full ? n : n - 1);
        for (let k = 1; k < n; k++) copies.push(this.doc.add(rotatedClone(src, this.doc, AXES[v.axis], step * k, pivots[v.axis])));
        this.updateOverlaps();
      },
      onOk: () => {
        this.doc.commit(`Circular Pattern ${src.name} ×${copies.length + 1}`, 'circpattern');
        bus.emit('pattern', { count: copies.length + 1, kind: 'circular' });
      },
      onCancel: () => { clear(); this.updateOverlaps(); },
    });
  }

  // ======================================================================
  // MODIFY
  // ======================================================================
  combineDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'combine' });
    if (!this.requireSelection(2)) return;
    const [target, ...tools] = this.selection;
    openDialog({
      title: 'Combine', subtitle: 'MODIFY',
      help: `Target body: <b>${target.name}</b><br>Tool bod${tools.length > 1 ? 'ies' : 'y'}: <b>${tools.map((t) => t.name).join(', ')}</b><br><small>The first body you selected is the target.</small>`,
      fields: [
        { key: 'op', label: 'Operation', type: 'select', value: 'join', options: [['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']] },
        { key: 'keep', label: 'Keep Tools', type: 'checkbox', value: false },
      ],
      onOk: (v) => {
        try {
          const result = combine(target, tools, v.op);
          if (!result) { toast('The result is empty - the bodies probably do not overlap.', 'warn', 3500); return; }
          this.doc.remove(target);
          if (!v.keep) for (const t of tools) this.doc.remove(t);
          this.doc.add(result);
          this.doc.commit(`Combine (${v.op})`, 'combine');
          this.select([result]);
          bus.emit('combine', { op: v.op, body: result });
        } catch (err) {
          console.error(err);
          toast('Combine failed for these bodies.', 'err');
        }
      },
    });
    this.setHint('Combine: choose an operation and press OK.');
  }

  filletDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'fillet' });
    this.#edgeDialog('fillet');
  }

  // Fillet / Chamfer: rounds or bevels the edges of a Box (all edges) or a Cylinder (top and bottom edges).
  chamferDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'chamfer' });
    this.#edgeDialog('chamfer');
  }

  #edgeDialog(kind) {
    const label = kind === 'fillet' ? 'Fillet' : 'Chamfer';
    if (!this.requireSelection(1, 'a Box or Cylinder body')) return;
    const body = this.primary;
    if (body.kind !== 'box' && body.kind !== 'cylinder') {
      toast(`In this simplified version ${label} works on <b>Box</b> and <b>Cylinder</b> bodies.`, 'warn', 3500);
      return;
    }
    const other = kind === 'fillet' ? 'chamfer' : 'fillet';
    const old = { fillet: body.params.fillet || 0, chamfer: body.params.chamfer || 0 };
    const p = body.params;
    const max = (body.kind === 'box' ? Math.min(p.width, p.height, p.depth) / 2 : Math.min(p.radius, p.height / 2)) - 0.1;
    openDialog({
      title: label, subtitle: body.name,
      help: `${kind === 'fillet' ? 'Rounds' : 'Bevels'} ${body.kind === 'box' ? 'every edge of the box' : 'the top and bottom edges of the cylinder'}. Maximum for this body: ${max.toFixed(1)} mm.`,
      fields: [{ key: 'r', label: kind === 'fillet' ? 'Radius (mm)' : 'Distance (mm)', type: 'number', value: old[kind] || Math.min(3, max), min: 0, max, step: 0.5 }],
      onChange: (v) => { p[kind] = v.r; p[other] = 0; body.rebuild(); },
      onOk: (v) => {
        this.doc.commit(`${label} ${body.name}`, kind === 'fillet' ? 'fillet' : 'chamfer');
        bus.emit(kind, { radius: v.r, body });
      },
      onCancel: () => { Object.assign(p, old); body.rebuild(); },
    });
  }

  shellDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'shell' });
    if (!this.requireSelection(1, 'a Box, Cylinder or Sphere')) return;
    const body = this.primary;
    if (!SHELLABLE.includes(body.kind)) {
      toast('In this simplified version Shell works on <b>Box</b>, <b>Cylinder</b> and <b>Sphere</b> bodies.', 'warn', 3500);
      return;
    }
    const p = body.params;
    const maxT = body.kind === 'box' ? Math.min(p.width, p.depth, p.height) / 2 - 0.2 : p.radius - 0.2;
    openDialog({
      title: 'Shell', subtitle: body.name,
      help: 'Hollows the body, leaving walls of the given thickness. "Open top" removes the top face (like a cup).',
      fields: [
        { key: 't', label: 'Inside thickness (mm)', type: 'number', value: Math.min(2, maxT), min: 0.2, max: maxT, step: 0.5 },
        { key: 'open', label: 'Open top', type: 'checkbox', value: body.kind !== 'sphere' },
      ],
      onOk: (v) => {
        try {
          const r = shellBody(body, v.t, v.open && body.kind !== 'sphere');
          if (!r) throw new Error('empty');
          this.doc.remove(body);
          this.doc.add(r);
          this.doc.commit(`Shell ${body.name}`, 'shell');
          this.select([r]);
          bus.emit('shell', { thickness: v.t, body: r });
        } catch (err) {
          console.error(err);
          toast('Shell failed - try a smaller thickness.', 'err');
        }
      },
    });
  }

  appearanceDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'appearance' });
    if (!this.requireSelection()) return;
    const bodies = [...this.selection];
    openDialog({
      title: 'Appearance', subtitle: bodies.map((b) => b.name).join(', '),
      fields: [
        { key: 'color', label: 'Colour', type: 'color', value: bodies[0].color },
        { key: 'material', label: 'Material', type: 'select', value: bodies[0].material, options: Object.entries(MATERIALS).map(([k, m]) => [k, m.label]) },
      ],
      onOk: (v) => {
        for (const b of bodies) b.setAppearance(v.color, v.material);
        this.doc.commit('Appearance', 'appearance');
        bus.emit('appearance', { body: bodies[0], color: v.color, material: v.material });
      },
    });
  }

  duplicate() {
    if (!this.requireSelection()) return;
    const copies = this.selection.map((b) => {
      const size = b.worldBox().getSize(new THREE.Vector3());
      return this.doc.add(cloneBody(b, this.doc, [size.x + 10, 0, 0]));
    });
    this.doc.commit(`Copy ${copies.map((c) => c.name).join(', ')}`, 'duplicate');
    this.select(copies);
    bus.emit('duplicate', { count: copies.length });
  }

  deleteSelection() {
    if (this.profileSel.length) {
      const bySketch = new Map();
      for (const { sketch, index } of this.profileSel) bySketch.set(sketch, [...(bySketch.get(sketch) || []), index]);
      for (const [sketch, idx] of bySketch) {
        for (const i of idx.sort((a, b) => b - a)) sketch.removeShape(i);
        if (!sketch.shapes.length) this.doc.removeSketch(sketch);
      }
      this.profileSel = [];
      this.doc.commit('Delete profile', 'trash');
      bus.emit('delete');
      return;
    }
    if (!this.requireSelection()) return;
    const names = this.selection.map((b) => b.name).join(', ');
    for (const b of this.selection) this.doc.remove(b);
    this.selection = [];
    this.setTransformMode(null, true);
    this.doc.commit(`Delete ${names}`, 'trash');
    bus.emit('delete');
  }

  deleteSketch(sketch) {
    this.cancelTools();
    this.profileSel = this.profileSel.filter((p) => p.sketch !== sketch);
    this.doc.removeSketch(sketch);
    this.doc.commit(`Delete ${sketch.name}`, 'trash');
    bus.emit('delete');
  }

  dropToGround() {
    if (!this.requireSelection()) return;
    for (const b of this.selection) b.mesh.position.y -= b.worldBox().min.y;
    this.doc.commit('Drop to ground', 'ground');
    bus.emit('ground');
  }

  // ======================================================================
  // CONSTRUCT
  // ======================================================================
  offsetPlaneDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'offset-plane' });
    const preview = makePlaneMesh(0xf28c28, 90);
    this.vp.scene.add(preview);
    this.showOriginPlanes(true);
    const frameFor = (v) => {
      const n = new THREE.Vector3(...ORIGIN_PLANES[v.base].normal);
      return frameFromNormal(n, n.clone().multiplyScalar(v.d));
    };
    const cleanup = () => { this.vp.scene.remove(preview); this.showOriginPlanes(false); };
    openDialog({
      title: 'Offset Plane', subtitle: 'CONSTRUCT',
      help: 'Creates a construction plane parallel to an origin plane. You can then sketch on it (Create Sketch ▸ click the orange plane).',
      fields: [
        { key: 'base', label: 'Parallel to', type: 'select', value: 'XZ', options: Object.entries(ORIGIN_PLANES).map(([k, p]) => [k, p.label]) },
        { key: 'd', label: 'Distance (mm)', type: 'number', value: 20, step: 1 },
      ],
      onChange: (v) => {
        const f = frameFor(v);
        preview.position.fromArray(f.o);
        preview.quaternion.fromArray(f.q);
      },
      onOk: (v) => {
        cleanup();
        const plane = this.doc.addPlane(new ConstructionPlane({ name: this.doc.newName('plane'), frame: frameFor(v), base: v.base, offset: v.d }));
        this.doc.commit(`Offset ${plane.name}`, 'plane');
        bus.emit('plane:create', { plane });
      },
      onCancel: cleanup,
    });
  }

  // planes, axes and points
  togglePlaneVisible(plane) {
    plane.setVisible(!plane.visible);
    this.doc.commit(`${plane.visible ? 'Show' : 'Hide'} ${plane.name}`, 'eye');
  }

  deletePlane(plane) {
    this.doc.removeConstruct(plane);
    this.doc.commit(`Delete ${plane.name}`, 'trash');
  }

  // ======================================================================
  // INSPECT
  // ======================================================================
  interference() {
    this.cancelTools();
    bus.emit('tool', { tool: 'interference' });
    const pairs = findOverlaps(this.doc.bodies);
    openDialog({
      title: 'Interference', subtitle: 'INSPECT',
      help: pairs.length
        ? `<b>${pairs.length}</b> interference${pairs.length > 1 ? 's' : ''} found (shown in red):<br>${pairs.map(([a, b]) => `• ${a.name} ↔ ${b.name}`).join('<br>')}<br><br>Fix them by moving the bodies apart, or Combine them.`
        : '✓ No interference: no visible bodies overlap.',
      okLabel: 'Close',
    });
    bus.emit('interference', { count: pairs.length });
  }

  sectionDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'section' });
    const old = this.section && { ...this.section };
    openDialog({
      title: 'Section Analysis', subtitle: 'INSPECT',
      help: 'Cuts the view open so you can see inside the bodies. It does not change the model. Remove it from the Browser (Analysis).',
      fields: [
        { key: 'plane', label: 'Plane', type: 'select', value: old?.plane || 'XY', options: Object.entries(ORIGIN_PLANES).map(([k, p]) => [k, p.label]) },
        { key: 'offset', label: 'Offset (mm)', type: 'number', value: old?.offset ?? 0, step: 1 },
        { key: 'flip', label: 'Flip side', type: 'checkbox', value: old?.flip || false },
      ],
      onChange: (v) => { this.section = { ...v, visible: true }; this.#applySection(); },
      onOk: () => { bus.emit('section', { ...this.section }); bus.emit('selection:changed'); },
      onCancel: () => { this.section = old; this.#applySection(); },
    });
  }

  toggleSection() { if (this.section) { this.section.visible = !this.section.visible; this.#applySection(); bus.emit('selection:changed'); } }
  removeSection() { this.section = null; this.#applySection(); bus.emit('selection:changed'); }

  #applySection() {
    const s = this.section;
    let planes = [];
    if (s?.visible) {
      const n = new THREE.Vector3(...ORIGIN_PLANES[s.plane].normal).multiplyScalar(s.flip ? 1 : -1);
      planes = [new THREE.Plane(n, s.flip ? -s.offset : s.offset)];
    }
    this.vp.renderer.localClippingEnabled = planes.length > 0;
    for (const b of this.doc.bodies) {
      for (const m of [b.mesh.material, b.edges.material]) { m.clippingPlanes = planes; m.needsUpdate = true; }
      b.mesh.material.side = planes.length ? THREE.DoubleSide : THREE.FrontSide;
    }
  }

  // ======================================================================
  // property edits (from the Properties panel / Browser)
  // ======================================================================
  setProp(body, field, value) {
    const m = body.mesh;
    if (field === 'name') {
      if (!value.trim()) return;
      body.name = value.trim();
    } else if (field.startsWith('param:')) {
      const key = field.slice(6);
      const def = paramDefs(body.kind, body.params).find((d) => d.key === key);
      if (def?.min !== undefined) value = Math.max(def.min, value);
      if (def?.max !== undefined) value = Math.min(def.max, value);
      setParam(body.params, key, value);
      body.rebuild();
    } else if (field.startsWith('pos')) {
      m.position['xyz'[+field.slice(3)]] = value;
    } else if (field.startsWith('rot')) {
      m.rotation['xyz'[+field.slice(3)]] = THREE.MathUtils.degToRad(value);
    } else if (field.startsWith('scl')) {
      m.scale['xyz'[+field.slice(3)]] = Math.max(0.01, value);
    }
    this.doc.commit(`Edit ${body.name}`, 'edit');
    bus.emit('props', { body, field, value });
  }

  // Sketch edits: sketch name, or one profile's size (param:<key>) / position (pos0 = u, pos1 = v).
  setProfileProp(sketch, index, field, value) {
    if (field === 'name') {
      if (!value.trim()) return;
      sketch.name = value.trim();
    } else {
      const shape = sketch.shapes[index];
      if (!shape) return;
      if (field.startsWith('param:')) {
        const key = field.slice(6);
        const def = profileDefs(shape.profile).find((d) => d.key === key);
        if (def?.min !== undefined) value = Math.max(def.min, value);
        if (def?.max !== undefined) value = Math.min(def.max, value);
        setParam(shape.profile, key, key === 'n' ? Math.max(3, Math.round(value)) : value);
      } else if (field === 'pos0') shape.c[0] = value;
      else if (field === 'pos1') shape.c[1] = value;
      sketch.rebuild();
    }
    this.doc.commit(`Edit ${sketch.name}`, 'edit');
    bus.emit('props', { sketch, index, field, value });
  }

  toggleSketchVisible(sketch) {
    sketch.setVisible(!sketch.visible);
    this.profileSel = this.profileSel.filter((p) => p.sketch.visible);
    this.doc.commit(`${sketch.visible ? 'Show' : 'Hide'} ${sketch.name}`, 'eye');
    bus.emit('visibility', { sketch, visible: sketch.visible });
  }

  setAppearance(body, color, material) {
    body.setAppearance(color, material);
    this.doc.commit(`Appearance ${body.name}`, 'appearance');
    bus.emit('appearance', { body, color, material });
  }

  toggleVisible(body) {
    body.setVisible(!body.visible);
    if (!body.visible && this.selection.includes(body)) this.select(this.selection.filter((b) => b !== body));
    this.doc.commit(`${body.visible ? 'Show' : 'Hide'} ${body.name}`, 'eye');
    bus.emit('visibility', { body, visible: body.visible });
  }

  // eye icon on a Browser folder: show/hide everything inside it
  toggleFolder(kind) {
    if (kind === 'origin') return this.toggleOrigin();
    const items = kind === 'bodies' ? this.doc.bodies : kind === 'sketches' ? this.doc.sketches : this.doc.construction;
    if (!items.length) return;
    const show = !items.some((i) => i.visible);
    for (const i of items) i.setVisible(show);
    if (!show) { this.selection = []; this.profileSel = []; }
    this.doc.commit(`${show ? 'Show' : 'Hide'} all ${kind}`, 'eye');
    bus.emit('visibility', { folder: kind, visible: show });
  }

  renameDocument(name) {
    this.doc.name = name.trim() || 'Untitled';
    this.doc.autosave();
    bus.emit('doc:renamed');
  }

  // ======================================================================
  // FILE
  // ======================================================================
  newDesign() {
    if (!this.doc.isEmpty && !confirm('Start a new design? Unsaved changes will be lost.')) return;
    this.cancelTools();
    this.selection = [];
    this.profileSel = [];
    this.section = null;
    this.doc.clear();
    this.vp.setView('home');
    bus.emit('new');
    bus.emit('doc:renamed');
  }

  #download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  #fileName(ext) { return `${(this.doc.name || 'design').replace(/[^\w\- ]+/g, '').trim() || 'design'}${ext}`; }

  saveFile() {
    const name = this.#fileName('.minicad.json');
    this.#download(new Blob([JSON.stringify(this.doc.toJSON())], { type: 'application/json' }), name);
    toast(`Design saved as ${name}`, 'ok');
    bus.emit('save');
  }

  #pickFile(accept, handler) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files[0];
      if (file) {
        try { await handler(file); } catch (err) { console.error(err); toast('Could not open that file: ' + err.message, 'err'); }
      }
    };
    input.click();
  }

  openFile() {
    this.#pickFile('.json,application/json', async (file) => {
      this.cancelTools();
      this.selection = [];
      this.profileSel = [];
      this.doc.load(JSON.parse(await file.text()));
      this.fitAll();
      toast(`Opened ${file.name}`, 'ok');
      bus.emit('open');
      bus.emit('doc:renamed');
    });
  }

  // INSERT > Insert Mesh: bring an STL file in as a body.
  insertMesh() {
    this.cancelTools();
    bus.emit('tool', { tool: 'insert-mesh' });
    this.#pickFile('.stl', async (file) => {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      const body = this.doc.add(meshBodyFromGeometry(geo, file.name.replace(/\.stl$/i, '') || this.doc.newName('mesh')));
      this.placeFree(body);
      this.doc.commit(`Insert ${body.name}`, 'insert');
      this.select([body]);
      this.fitAll();
      toast(`Inserted ${file.name}`, 'ok');
      bus.emit('insert', { body });
    });
  }

  exportSTL() {
    const visible = this.doc.bodies.filter((b) => b.visible);
    if (!visible.length) { toast('Nothing to export - create a body first.', 'warn'); return; }
    const scene = new THREE.Scene();
    // slicers use Z as "up", the viewport uses Y: turn the model so it sits upright on the bed
    for (const b of visible) scene.add(new THREE.Mesh(worldGeometry(b).rotateX(Math.PI / 2)));
    const data = new STLExporter().parse(scene, { binary: true });
    const name = this.#fileName('.stl');
    this.#download(new Blob([data], { type: 'model/stl' }), name);
    toast(`Exported ${visible.length} bod${visible.length > 1 ? 'ies' : 'y'} to ${name}`, 'ok');
    bus.emit('export');
  }

  // ======================================================================
  // keyboard + status bar options
  // ======================================================================
  #setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (document.querySelector('.modal-back')) return;
      if (this.workspace === 'boxgen') {
        if (e.key === 'Escape' && dialogOpen()) { closeDialog(false, 'user'); return; }
        if (this.boxgen.key(e)) e.preventDefault();
        return;
      }
      if (this.sketch.key(e) || this.measure.key(e)) { e.preventDefault(); return; }
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); this.cancelTools(); this.doc.undo(); return; }
      if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.cancelTools(); this.doc.redo(); return; }
      if (ctrl && k === 'd') { e.preventDefault(); this.duplicate(); return; }
      if (ctrl && k === 's') { e.preventDefault(); this.saveFile(); return; }
      if (ctrl || e.altKey) return;
      if (e.key === 'F6') { e.preventDefault(); this.fitAll(); return; }
      if (k === 'escape') {
        if (this.pickMode) { this.stopPicking(); this.vp.canvas.style.cursor = ''; if (dialogOpen()) closeDialog(false, 'user'); else this.setHint('Cancelled.'); }
        else if (dialogOpen()) closeDialog(false, 'user');
        else if (this.pendingFeature) { this.pendingFeature = null; this.setHint('Cancelled.'); }
        else if (this.transformMode) this.setTransformMode(null);
        else this.select([]);
        return;
      }
      if (dialogOpen()) return;
      const run = this.shortcuts?.[k];
      if (run) { e.preventDefault(); run(); }
    });
  }

  #setupStatusOptions() {
    const on = (id, fn) => document.getElementById(id).addEventListener('change', (e) => fn(e.target.checked));
    on('opt-snap', (v) => { this.snap = v; this.applySnap(); });
    on('opt-overlap', (v) => { this.overlapCheck = v; this.updateOverlaps(); });
    on('opt-block', (v) => { this.blockOverlaps = v; });
  }

  setGrid(v) {
    this.vp.grid.visible = v;
    this.sketch.showGrid = v;
    if (this.sketch.active) this.sketch.grid.visible = v;
    bus.emit('tool:changed');
  }
}

export { MATERIALS, round };
