import * as THREE from 'three';
import { bus } from '../events.js';
import { frameFromNormal, makePlaneMesh, ORIGIN_PLANES, Sketch, profilePoints, isClosedProfile } from '../model.js';
import { arcPoints, circleFrom3, splinePoints } from '../geometry.js';

const GREEN = 0x2f9e44;
export const SKETCH_TOOLS = {
  line: { label: 'Line', key: 'L', hint: 'Line: click points to draw connected lines. Click the first point (or double-click / Enter) to close the profile.' },
  pline: { label: 'Open Line', hint: 'Open Line: click points, then press Enter (or double-click) to finish an open path for Sweep, Pipe, Rib or Pattern on Path. Clicking the first point closes it into a profile.' },
  rect: { label: '2-Point Rectangle', key: 'R', hint: 'Rectangle: click one corner, then the opposite corner (or drag). Type a size: 40 Tab 20 Enter.' },
  crect: { label: 'Center Rectangle', hint: 'Center Rectangle: click the centre, then a corner (or drag). Type a size: 40 Tab 20 Enter.' },
  rect3: { label: '3-Point Rectangle', hint: '3-Point Rectangle: click two points for one (possibly angled) side, then a third point for the width.' },
  circle: { label: 'Center Diameter Circle', key: 'C', hint: 'Circle: click the centre, then drag out the size. Type a diameter and press Enter.' },
  circle2: { label: '2-Point Circle', hint: '2-Point Circle: click both ends of a diameter. Type a diameter and press Enter.' },
  circle3: { label: '3-Point Circle', hint: '3-Point Circle: click three points on the circle.' },
  arc: { label: '3-Point Arc', hint: '3-Point Arc: click the start, the end, then a point the arc passes through. Arcs are open paths (for Sweep, Pipe, Rib).' },
  poly: { label: 'Polygon', key: 'P', hint: 'Polygon: click the centre, then drag out the size. Set the number of sides in the Sketch Palette.' },
  ellipse: { label: 'Ellipse', hint: 'Ellipse: click the centre, then the end of the long axis, then a point for the short axis.' },
  slot: { label: 'Center to Center Slot', hint: 'Slot: click the two arc centres, then a point for the width.' },
  spline: { label: 'Fit Point Spline', hint: 'Spline: click points for a smooth curve. Click the first point to close it into a profile, or press Enter (double-click) for an open path.' },
};

const TWO_POINT = ['rect', 'crect', 'circle', 'circle2', 'poly'];
const THREE_POINT = ['rect3', 'circle3', 'arc', 'ellipse', 'slot'];
const POINT_LIST = ['line', 'pline', 'spline'];

// Fusion-style sketching.
//  1. Create Sketch -> pickPlane(): click an origin plane, a construction plane or a flat face.
//  2. begin(): the sketch environment opens on that plane (grid, Look At, SKETCH tab).
//  3. Draw closed profiles (and open paths) with the sketch tools. While drawing, type
//     numbers to set exact sizes (Tab switches field, Enter confirms).
//  4. finish(): Finish Sketch commits the sketch to the timeline.
export class SketchTool {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.preview = new THREE.Group(); // follows the sketch plane
    this.preview.visible = false;
    this.vp.scene.add(this.preview);
    this.draw = new THREE.Group();
    this.draw.position.y = 0.09;
    this.preview.add(this.draw);
    this.setTheme(false);
    this.hoverMark = makePlaneMesh(0xf28c28, 36);
    this.hoverMark.visible = false;
    this.hoverMark.children[0].material.opacity = 0.35;
    this.vp.scene.add(this.hoverMark);

    this.sketch = null;
    this.tool = null;
    this.picking = false;
    this.sides = 6;
    this.showGrid = true;
    this.showDims = true;
    this.typed = null;
    this.pts = [];
    this.clicks = [];
    this.dims = [];

    this.label = document.createElement('div');
    this.label.className = 'mlabel sketch hidden';
    document.getElementById('labels').appendChild(this.label);
    this.labelPos = null;

    const c = this.vp.canvas;
    let downAt = null;
    c.addEventListener('pointerdown', (e) => { if (e.button === 0) downAt = [e.clientX, e.clientY]; this.#down(e); });
    c.addEventListener('pointermove', (e) => this.#move(e));
    c.addEventListener('pointerup', (e) => {
      const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : 0;
      downAt = null;
      if (this.picking && e.button === 0 && moved < 5) this.#pickClick(e);
      else this.#up(e, moved);
    });
    c.addEventListener('dblclick', () => { if (POINT_LIST.includes(this.tool)) this.#finishPoints(this.tool === 'line'); });
    this.vp.onFrame(() => this.#updateLabel());
    bus.on('sketch:changed', () => this.refreshDims());
  }

  // sketch grid in the light or dark theme's colours
  setTheme(dark) {
    const visible = this.grid ? this.grid.visible : true;
    if (this.grid) { this.preview.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    this.grid = dark ? new THREE.GridHelper(300, 60, 0x3f5f80, 0x2b3a4f) : new THREE.GridHelper(300, 60, 0x8fb3cc, 0xc3d3df);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.material.depthWrite = false;
    this.grid.position.y = 0.03;
    this.grid.visible = visible;
    this.preview.add(this.grid);
  }

  get active() { return !!this.sketch; }
  get mode() { return this.tool; }
  get drawing() { return !!(this.a || this.pts.length || this.clicks.length); }

  // ------------------------------------------------------------------
  // 1. plane selection
  // ------------------------------------------------------------------
  pickPlane(then) {
    this.picking = true;
    this.afterPick = then;
    this.app.showOriginPlanes(true);
    this.vp.el.classList.add('picking');
    this.app.setHint('<b>Create Sketch:</b> select a plane (XY, XZ, YZ), a construction plane or a <b>flat face</b> of a body. Body faces are picked first; if one is in the way, choose the plane in <b>Browser ▸ Origin</b>. Esc to cancel.');
    bus.emit('tool:changed');
  }

  stopPicking() {
    this.picking = false;
    this.hoverMark.visible = false;
    this.vp.el.classList.remove('picking');
    this.app.showOriginPlanes(false);
    this.app.highlightOriginPlane(null);
  }

  #pickTarget(e) {
    const app = this.app;
    const targets = [
      ...Object.values(app.originPlanes).map((p) => p.children[0]),
      ...app.doc.planes.filter((p) => p.visible).map((p) => p.object.children[0]),
      ...app.doc.bodies.filter((b) => b.visible).map((b) => b.mesh),
    ];
    // Body faces and construction planes win over the big see-through origin planes,
    // so a face behind an origin plane can still be picked.
    const hits = this.vp.raycast(e, targets);
    hits.sort((a, b) => (!!a.object.userData.originPlane - !!b.object.userData.originPlane) || a.distance - b.distance);
    for (const hit of hits) {
      const o = hit.object;
      if (o.userData.originPlane) {
        const name = o.userData.originPlane;
        return { kind: 'origin', name, frame: frameFromNormal(ORIGIN_PLANES[name].normal), label: ORIGIN_PLANES[name].label };
      }
      if (o.userData.plane) return { kind: 'plane', name: o.userData.plane.name, frame: o.userData.plane.frame, label: o.userData.plane.name };
      const body = o.userData.body;
      if (body) {
        // only flat faces: all three vertex normals of the hit triangle must agree
        const nrm = o.geometry.attributes.normal;
        const ids = [hit.face.a, hit.face.b, hit.face.c];
        const ns = ids.map((i) => new THREE.Vector3().fromBufferAttribute(nrm, i));
        const flat = ns.every((n) => n.dot(ns[0]) > 0.999);
        if (!flat) return { kind: 'curved', label: `${body.name}: curved face (can't sketch here)` };
        const n = hit.face.normal.clone().transformDirection(o.matrixWorld).normalize();
        return { kind: 'face', name: `Face of ${body.name}`, frame: frameFromNormal(n, hit.point), label: `Face of ${body.name}`, point: hit.point, normal: n };
      }
    }
    return null;
  }

  #pickHover(e) {
    const t = this.#pickTarget(e);
    this.app.highlightOriginPlane(t?.kind === 'origin' ? t.name : null);
    this.hoverMark.visible = t?.kind === 'face';
    if (t?.kind === 'face') {
      this.hoverMark.position.copy(t.point).addScaledVector(t.normal, 0.1);
      this.hoverMark.quaternion.fromArray(t.frame.q);
    }
    this.vp.canvas.style.cursor = t && t.kind !== 'curved' ? 'pointer' : '';
    if (t) this.app.setHint(`Create Sketch: <b>${t.label}</b>${t.kind === 'curved' ? '' : ' - click to sketch here.'}`);
  }

  #pickClick(e) {
    const t = this.#pickTarget(e);
    if (!t || t.kind === 'curved') return;
    this.stopPicking();
    this.vp.canvas.style.cursor = '';
    const sketch = this.app.doc.addSketch(new Sketch({ name: this.app.doc.newName('sketch'), frame: t.frame, planeName: t.name }));
    bus.emit('sketch:plane', { plane: t.name, kind: t.kind });
    this.begin(sketch, true);
    this.afterPick?.(sketch);
  }

  // ------------------------------------------------------------------
  // 2. sketch environment
  // ------------------------------------------------------------------
  begin(sketch, isNew = false, tool = null) {
    this.sketch = sketch;
    this.isNew = isNew;
    this.added = [];
    this.changed = false;
    sketch.setVisible(true);
    this.preview.position.fromArray(sketch.frame.o);
    this.preview.quaternion.fromArray(sketch.frame.q);
    this.preview.visible = true;
    this.grid.visible = this.showGrid;
    this.lookAt();
    this.setTool(tool);
    this.refreshDims();
    bus.emit('sketch:begin', { sketch });
    bus.emit('tool:changed');
  }

  lookAt() {
    if (!this.sketch) return;
    const n = this.sketch.normal;
    if (Math.abs(n.y) > 0.99) n.z += 0.0001;
    this.vp.setView('sketch', n);
  }

  setTool(tool) {
    this.#resetShape();
    this.tool = tool;
    this.vp.controls.enableRotate = !tool;
    this.vp.el.classList.toggle('sketching', !!tool);
    if (tool) {
      this.app.setHint(SKETCH_TOOLS[tool].hint + ' Esc stops the tool.');
      bus.emit('tool', { tool });
    } else if (this.sketch) {
      this.app.setHint(`Sketching on <b>${this.sketch.planeName}</b>. Pick Line (L), Rectangle (R), Circle (C) or Polygon (P) - more tools are in CREATE ▾. <b>Finish Sketch</b> when done.`);
    }
    bus.emit('tool:changed');
  }

  // a sketch MODIFY command changed profiles (and maybe added some)
  markChanged(added = []) {
    this.added.push(...added);
    this.changed = true;
  }

  // Finish Sketch: leaves the environment and records the sketch in the timeline.
  finish() {
    if (this.picking) { this.stopPicking(); bus.emit('tool:changed'); return; }
    if (!this.sketch) return;
    const s = this.sketch, isNew = this.isNew, changed = this.added.length > 0 || this.changed;
    this.#end();
    if (!s.shapes.length && isNew) {
      this.app.doc.removeSketch(s);
      this.app.setHint('Empty sketch discarded.');
    } else {
      if (isNew || changed) this.app.doc.commit(isNew ? s.name : `Edit ${s.name}`, 'sketch');
      this.app.setHint('Sketch finished. Select a profile (shaded area) and use <b>Extrude</b> (E) or <b>Revolve</b>.');
    }
    bus.emit('sketch:finish', { sketch: s });
    bus.emit('tool:changed');
  }

  // Programmatic stop (another command started): same as Finish Sketch, like Fusion.
  cancel() { this.finish(); }

  #end() {
    this.#resetShape();
    this.sketch = null;
    this.tool = null;
    this.preview.visible = false;
    this.vp.controls.enableRotate = true;
    this.vp.el.classList.remove('sketching');
    this.refreshDims();
  }

  undoShape() {
    if (!this.added.length) return false;
    this.sketch.removeShape(this.added.pop());
    bus.emit('sketch:changed');
    return true;
  }

  key(e) {
    if (this.picking) {
      if (e.key === 'Escape') { this.stopPicking(); this.app.setHint('Create Sketch cancelled.'); bus.emit('tool:changed'); return true; }
      return false;
    }
    if (!this.sketch) return false;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      if (this.drawing) this.#resetShape(); else this.undoShape();
      return true;
    }
    if (e.ctrlKey || e.metaKey) return false;
    // typed dimensions while drawing
    if (this.a && TWO_POINT.includes(this.tool)) {
      if (/^[0-9.]$/.test(k)) {
        this.typed ||= { f: ['', ''], i: 0 };
        this.typed.f[this.typed.i] += k;
        this.#drawShape();
        return true;
      }
      if (k === 'Tab' && (this.tool === 'rect' || this.tool === 'crect')) { this.typed ||= { f: ['', ''], i: 0 }; this.typed.i = 1 - this.typed.i; this.#drawShape(); return true; }
      if (k === 'Backspace' && this.typed) { const t = this.typed; t.f[t.i] = t.f[t.i].slice(0, -1); this.#drawShape(); return true; }
      if (k === 'Enter') { this.#finishShape(); return true; }
    }
    if (k === 'Escape') {
      if (this.typed) { this.typed = null; this.#drawShape(); }
      else if (this.drawing) { this.#resetShape(); }
      else if (this.tool) this.setTool(null);
      else this.finish();
      return true;
    }
    if (k === 'Enter' && POINT_LIST.includes(this.tool)) { this.#finishPoints(this.tool === 'line'); return true; }
    if (k === 'Backspace' && POINT_LIST.includes(this.tool) && this.pts.length) { this.pts.pop(); this.#drawPoints(); return true; }
    if (k === 'Backspace' && this.clicks.length) { this.clicks.pop(); this.#draw3(); return true; }
    const toolKey = Object.entries(SKETCH_TOOLS).find(([, t]) => t.key === k.toUpperCase());
    if (toolKey && !e.altKey) { this.setTool(toolKey[0]); return true; }
    return false;
  }

  // ------------------------------------------------------------------
  // 3. drawing (all coordinates are sketch-local X/Z)
  // ------------------------------------------------------------------
  #resetShape() {
    this.a = null; this.b = null; this.pts = []; this.clicks = []; this.dragging = false; this.typed = null;
    this.#clearDraw();
    this.label.classList.add('hidden');
  }

  #clearDraw() { for (const o of [...this.draw.children]) { this.draw.remove(o); o.geometry.dispose(); } }

  #point(e) {
    const n = this.sketch.normal;
    const o = new THREE.Vector3(...this.sketch.frame.o);
    this.vp.setPointer(e);
    const p = new THREE.Vector3();
    if (!this.vp.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), p)) return null;
    const local = p.clone().sub(o).applyQuaternion(this.preview.quaternion.clone().invert());
    local.y = 0;
    if (this.app.snap) {
      const step = this.vp.worldPerPixel(p) > 0.35 ? 5 : 1;
      local.x = Math.round(local.x / step) * step;
      local.z = Math.round(local.z / step) * step;
    }
    return local;
  }

  #down(e) {
    if (!this.sketch || !this.tool || e.button !== 0) return;
    const p = this.#point(e);
    if (!p) return;
    if (POINT_LIST.includes(this.tool)) {
      if (this.pts.length >= 3 && this.#nearFirst(e)) return this.#finishPoints(true);
      this.pts.push(p);
      this.#drawPoints(p);
      return;
    }
    if (THREE_POINT.includes(this.tool)) {
      this.clicks.push(p);
      if (this.clicks.length === 3) this.#finish3();
      else this.#draw3(p);
      return;
    }
    if (!this.a) { this.a = p; this.b = p.clone(); this.dragging = true; }
    else { this.b = p; this.#finishShape(); }
  }

  #move(e) {
    if (this.picking) return this.#pickHover(e);
    if (!this.sketch || !this.tool) return;
    const p = this.#point(e);
    if (!p) return;
    if (POINT_LIST.includes(this.tool)) { if (this.pts.length) this.#drawPoints(p); return; }
    if (THREE_POINT.includes(this.tool)) { if (this.clicks.length) this.#draw3(p); return; }
    if (this.a) { this.b = p; this.#drawShape(); }
  }

  #up(e, moved) {
    if (!this.sketch || !TWO_POINT.includes(this.tool) || !this.a || !this.dragging || e.button !== 0) return;
    this.dragging = false;
    if (moved > 6) this.#finishShape();
  }

  #nearFirst(e) {
    const s0 = this.vp.toScreen(this.preview.localToWorld(this.pts[0].clone()));
    const r = this.vp.canvas.getBoundingClientRect();
    return Math.hypot(e.clientX - r.left - s0.x, e.clientY - r.top - s0.y) < 12;
  }

  #line(points, closed = true) {
    const geo = new THREE.BufferGeometry().setFromPoints(closed ? [...points, points[0]] : points);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: GREEN, depthTest: false }));
    l.renderOrder = 5;
    this.draw.add(l);
  }

  #dots(points) {
    const d = new THREE.Points(new THREE.BufferGeometry().setFromPoints(points), new THREE.PointsMaterial({ color: GREEN, size: 7, sizeAttenuation: false, depthTest: false }));
    d.renderOrder = 6;
    this.draw.add(d);
  }

  // current shape size, using typed values where given
  #dims() {
    const { a, b } = this;
    const t = this.typed?.f || ['', ''];
    const num = (s, fallback) => (s !== '' && Number.isFinite(parseFloat(s)) ? parseFloat(s) : fallback);
    if (this.tool === 'rect') {
      const sx = Math.sign(b.x - a.x) || 1, sz = Math.sign(b.z - a.z) || 1;
      const w = num(t[0], Math.abs(b.x - a.x)), d = num(t[1], Math.abs(b.z - a.z));
      return { w, d, c: [a.x + (sx * w) / 2, a.z + (sz * d) / 2], b: new THREE.Vector3(a.x + sx * w, 0, a.z + sz * d) };
    }
    if (this.tool === 'crect') {
      const w = num(t[0], 2 * Math.abs(b.x - a.x)), d = num(t[1], 2 * Math.abs(b.z - a.z));
      return { w, d, c: [a.x, a.z], b: new THREE.Vector3(a.x + w / 2, 0, a.z + d / 2) };
    }
    const dir = b.clone().sub(a);
    const angle = dir.lengthSq() > 1e-9 ? Math.atan2(dir.z, dir.x) : -Math.PI / 2;
    if (this.tool === 'circle') return { r: num(t[0], dir.length() * 2) / 2, angle, center: a };
    if (this.tool === 'circle2') {
      const D = num(t[0], dir.length());
      return { r: D / 2, angle, center: a.clone().add(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(D / 2)) };
    }
    return { r: num(t[0], dir.length()), angle, center: a };
  }

  #drawShape() {
    this.#clearDraw();
    if (!this.a) return;
    const t = this.typed;
    const fld = (i, v) => (t && t.i === i ? `[${t.f[i] || ''}▌]` : t && t.f[i] ? t.f[i] : fmt(v));
    if (this.tool === 'rect' || this.tool === 'crect') {
      const { w, d, c, b } = this.#dims();
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => new THREE.Vector3(c[0] + (sx * w) / 2, 0, c[1] + (sz * d) / 2));
      this.#line(pts);
      this.#dots(this.tool === 'crect' ? [...pts, this.a] : pts);
      this.#setLabel(`${fld(0, w)} × ${fld(1, d)} mm`, b);
    } else {
      const { r, angle, center } = this.#dims();
      const n = this.tool === 'poly' ? Math.max(3, this.sides) : 64;
      const pts = Array.from({ length: n }, (_, i) => {
        const ang = angle + (i / n) * Math.PI * 2;
        return new THREE.Vector3(center.x + Math.cos(ang) * r, 0, center.z + Math.sin(ang) * r);
      });
      this.#line(pts);
      if (this.tool === 'circle2') this.#line([this.a, this.b], false);
      else this.#line([center, new THREE.Vector3(center.x + Math.cos(angle) * r, 0, center.z + Math.sin(angle) * r)], false);
      this.#dots([center]);
      this.#setLabel(this.tool === 'poly' ? `R ${fld(0, r)} mm · ${n} sides` : `Ø ${fld(0, r * 2)} mm`, pts[0]);
    }
  }

  // Line / Open Line / Spline preview
  #drawPoints(cursor) {
    this.#clearDraw();
    if (!this.pts.length) return;
    const pts = cursor ? [...this.pts, cursor] : this.pts;
    if (this.tool === 'spline' && pts.length > 2) this.#line(splinePoints(pts.map((p) => [p.x, p.z]), false).map(([x, z]) => new THREE.Vector3(x, 0, z)), false);
    else this.#line(pts, false);
    this.#dots(this.pts);
    if (cursor) {
      const last = this.pts[this.pts.length - 1];
      const len = last.distanceTo(cursor);
      this.#setLabel(len > 1e-6 ? `${fmt(len)} mm · ${fmt(this.#screenAngle(last, cursor))}°` : `${fmt(len)} mm`, cursor);
    }
  }

  // Angle of a→b as the user sees it: 0° points right, counter-clockwise positive.
  // Measured on screen so it matches the view however the sketch plane is oriented.
  #screenAngle(a, b) {
    const sa = this.vp.toScreen(this.preview.localToWorld(a.clone()));
    const sb = this.vp.toScreen(this.preview.localToWorld(b.clone()));
    const deg = (Math.atan2(sa.y - sb.y, sb.x - sa.x) * 180) / Math.PI;
    const rounded = Math.round(((deg % 360) + 360) % 360 * 10) / 10;
    return rounded === 360 ? 0 : rounded;
  }

  // the three-click tools: their shape for clicks so far (+ the cursor as the next click)
  #shape3(cursor) {
    const [p1, p2 = cursor, p3 = this.clicks.length >= 2 ? cursor : null] = this.clicks;
    const v = (x, z) => new THREE.Vector3(x, 0, z);
    if (!p2 || p1.distanceTo(p2) < 1e-6) return null;
    const dir = p2.clone().sub(p1), L = dir.length(), ang = Math.atan2(dir.z, dir.x);
    const u = dir.clone().normalize(), n = v(-u.z, u.x);
    const deg = (ang * 180) / Math.PI;
    switch (this.tool) {
      case 'rect3': {
        if (!p3) return { outline: [p1, p2], closed: false, label: `${fmt(L)} mm · ${fmt(this.#screenAngle(p1, p2))}°`, at: p2 };
        const h = p3.clone().sub(p1).dot(n);
        const pts = [p1, p2, p2.clone().addScaledVector(n, h), p1.clone().addScaledVector(n, h)];
        const c = p1.clone().addScaledVector(u, L / 2).addScaledVector(n, h / 2);
        return { outline: pts, closed: true, label: `${fmt(L)} × ${fmt(Math.abs(h))} mm`, at: pts[2], profile: { type: 'rect', w: L, d: Math.abs(h), spin: deg }, c: [c.x, c.z], ok: Math.abs(h) > 0.25 };
      }
      case 'circle3': {
        if (!p3) return { outline: [p1, p2], closed: false, label: `${fmt(L)} mm`, at: p2 };
        const circ = circleFrom3([p1.x, p1.z], [p2.x, p2.z], [p3.x, p3.z]);
        if (!circ) return { outline: [p1, p2, p3], closed: false, label: 'points in a line', at: p3 };
        const pts = Array.from({ length: 64 }, (_, i) => { const a = (i / 64) * Math.PI * 2; return v(circ.c[0] + Math.cos(a) * circ.r, circ.c[1] + Math.sin(a) * circ.r); });
        return { outline: pts, closed: true, label: `Ø ${fmt(circ.r * 2)} mm`, at: p3, profile: { type: 'circle', r: circ.r }, c: circ.c, ok: circ.r > 0.25 };
      }
      case 'arc': {
        if (!p3) return { outline: [p1, p2], closed: false, label: `${fmt(L)} mm`, at: p2 };
        const arc = arcPoints([p1.x, p1.z], [p3.x, p3.z], [p2.x, p2.z]);
        const circ = circleFrom3([p1.x, p1.z], [p3.x, p3.z], [p2.x, p2.z]);
        return { outline: arc.map(([x, z]) => v(x, z)), closed: false, label: circ ? `R ${fmt(circ.r)} mm` : 'straight', at: p3, path: arc, ok: true };
      }
      case 'ellipse': {
        const ry = p3 ? Math.abs(p3.clone().sub(p1).dot(n)) : L / 2;
        const pts = Array.from({ length: 72 }, (_, i) => { const a = (i / 72) * Math.PI * 2; return p1.clone().addScaledVector(u, Math.cos(a) * L).addScaledVector(n, Math.sin(a) * ry); });
        return { outline: pts, closed: true, label: `${fmt(L * 2)} × ${fmt(ry * 2)} mm`, at: p3 || p2, profile: { type: 'ellipse', rx: L, ry, spin: deg }, c: [p1.x, p1.z], ok: ry > 0.25 };
      }
      case 'slot': {
        const r = p3 ? Math.abs(p3.clone().sub(p1).dot(n)) : Math.max(1, L / 6);
        const profile = { type: 'slot', len: L, r, spin: deg };
        const c = p1.clone().addScaledVector(u, L / 2);
        const pts = profilePoints(profile).map(([x, z]) => v(x + c.x, z + c.z));
        return { outline: pts, closed: true, label: `${fmt(L)} mm · R ${fmt(r)}`, at: p3 || p2, profile, c: [c.x, c.z], ok: r > 0.25 };
      }
      default: return null;
    }
  }

  #draw3(cursor) {
    this.#clearDraw();
    if (!this.clicks.length) { this.label.classList.add('hidden'); return; }
    const s = this.#shape3(cursor || this.clicks[this.clicks.length - 1]);
    this.#dots(this.clicks);
    if (!s) return;
    this.#line(s.outline, s.closed);
    this.#setLabel(s.label, s.at);
  }

  #finish3() {
    const s = this.#shape3(this.clicks[2]);
    if (!s?.ok) { this.#resetShape(); this.app.setHint('Too small (or the points are in a line) - try again.'); return; }
    if (s.path) {
      const xs = s.path.map((p) => p[0]), zs = s.path.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      this.#add({ type: 'path', curve: 'line', pts: s.path.map(([x, z]) => [x - cx, z - cz]) }, [cx, cz], false);
    } else {
      this.#add(s.profile, s.c, false);
    }
  }

  #setLabel(text, localPos) {
    this.label.textContent = text;
    this.label.classList.remove('hidden');
    this.labelPos = localPos.clone();
  }

  #updateLabel() {
    if (this.sketch && this.labelPos && !this.label.classList.contains('hidden')) {
      const s = this.vp.toScreen(this.preview.localToWorld(this.labelPos.clone()));
      this.label.style.left = s.x + 'px';
      this.label.style.top = s.y + 'px';
    }
    for (const d of this.dims) {
      const s = this.vp.toScreen(this.sketch.toWorld(d.u, d.v));
      d.el.style.left = s.x + 'px';
      d.el.style.top = s.y + 'px';
    }
  }

  // Dimension labels on every profile of the open sketch (Sketch Palette ▸ Show dimensions).
  refreshDims() {
    for (const d of this.dims) d.el.remove();
    this.dims = [];
    if (!this.sketch || !this.showDims) return;
    const host = document.getElementById('labels');
    this.sketch.shapes.forEach((s, i) => {
      const p = s.profile;
      const text = {
        rect: () => `${fmt(p.w)} × ${fmt(p.d)}`, circle: () => `Ø${fmt(p.r * 2)}`, ngon: () => `R${fmt(p.r)} · ${p.n}`,
        ellipse: () => `${fmt(p.rx * 2)} × ${fmt(p.ry * 2)}`, slot: () => `${fmt(p.len)} · R${fmt(p.r)}`,
      }[p.type]?.() ?? (isClosedProfile(p) ? `${fmt(this.sketch.shapeArea(i) / 100)} cm²` : `L ${fmt(pathLen(profilePoints(p)))}`);
      const el = document.createElement('div');
      el.className = 'mlabel dim';
      el.textContent = text;
      host.appendChild(el);
      this.dims.push({ el, u: s.c[0], v: s.c[1] });
    });
  }

  #finishShape() {
    const a = this.a;
    if (!a) return;
    const typed = !!this.typed;
    let profile, c;
    if (this.tool === 'rect' || this.tool === 'crect') {
      const { w, d, c: center } = this.#dims();
      if (w < 0.5 || d < 0.5) { this.#resetShape(); this.app.setHint('Rectangle too small - drag a bigger one.'); return; }
      profile = { type: 'rect', w, d };
      c = center;
    } else {
      const { r, angle, center } = this.#dims();
      if (r < 0.25) { this.#resetShape(); this.app.setHint('Too small - drag further from the centre.'); return; }
      profile = this.tool === 'poly' ? { type: 'ngon', r, n: Math.max(3, this.sides), rot: angle } : { type: 'circle', r };
      c = [center.x, center.z];
    }
    this.#add(profile, c, typed);
  }

  // Line, Open Line and Spline: closed = profile, otherwise an open path
  #finishPoints(closed) {
    const pts = this.pts.filter((p, i, all) => i === 0 || p.distanceTo(all[i - 1]) > 1e-6);
    if (closed && pts.length > 3 && pts[pts.length - 1].distanceTo(pts[0]) < 1e-6) pts.pop();
    if (closed && pts.length < 3) { this.app.setHint('A closed profile needs at least 3 points.'); return; }
    if (!closed && pts.length < 2) { this.app.setHint('An open path needs at least 2 points.'); return; }
    const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const rel = pts.map((p) => [p.x - cx, p.z - cz]);
    const profile = closed
      ? (this.tool === 'spline' ? { type: 'spline', pts: rel } : { type: 'poly', pts: rel })
      : { type: 'path', curve: this.tool === 'spline' ? 'spline' : 'line', pts: rel };
    this.#add(profile, [cx, cz], false);
  }

  #add(profile, c, typed) {
    this.#resetShape();
    this.added.push(this.sketch.addShape(profile, c));
    bus.emit('sketch:done', { profileType: profile.type, typed });
    bus.emit('sketch:changed');
    this.app.setHint(isClosedProfile(profile)
      ? `Profile added to ${this.sketch.name}. Draw more, or click <b>Finish Sketch</b>.`
      : `Open path added to ${this.sketch.name} - use it for <b>Sweep</b>, <b>Pipe</b>, <b>Rib</b> or <b>Pattern on Path</b>.`);
  }
}

const fmt = (v) => (Math.round(v * 10) / 10).toString();
const pathLen = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
