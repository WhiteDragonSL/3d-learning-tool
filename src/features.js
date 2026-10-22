import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { App } from './app.js';
import {
  Body, ConstructionPlane, ConstructionAxis, ConstructionPoint, ORIGIN_PLANES, PROFILE_LABEL, PHYSICAL_MATERIALS, KIND_LABEL,
  frameFromNormal, frameNormal, makePlaneMesh, profilePoints, profileDefs, getParam, setParam, isClosedProfile,
} from './model.js';
import { combine, cloneBody, meshBody, splitBody, worldGeometry } from './ops.js';
import {
  loftGeometry, sweepGeometry, circleSection, helix, latheSolid, thickenPolyline, offsetPolygon, massProperties, curvatureGeometry,
} from './geometry.js';
import { openDialog, closeDialog, toast, round } from './ui/dialog.js';
import { bus } from './events.js';

// ---------------------------------------------------------------------------
// Fusion 360 commands beyond the basics: Loft, Sweep, Pipe, Coil, Rib, Hole,
// Thread, Pattern on Path, Draft, Offset Face, Split Body, Align, Physical
// Material, construction planes/axes/points, Zebra/Draft/Curvature analysis,
// Centre of Mass, and the sketch MODIFY / CONSTRAINT tools.
// They are added to App so every command lives in one place.
// ---------------------------------------------------------------------------
const OP_OPTIONS = [['new', 'New Body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']];
const Y = new THREE.Vector3(0, 1, 0);
const rad = THREE.MathUtils.degToRad;

// "<sketchId>:<index>" options for every sketch shape matching `filter`
function shapeOptions(app, filter) {
  return app.doc.sketches.flatMap((s) => s.shapes
    .map((sh, i) => ({ s, i, sh }))
    .filter(({ sh }) => filter(sh.profile))
    .map(({ s, i, sh }) => [`${s.id}:${i}`, `${s.name} · ${i + 1} ${PROFILE_LABEL[sh.profile.type]}`]));
}
const refOf = (app, key) => { const [sid, i] = String(key).split(':').map(Number); return { sketch: app.doc.getSketch(sid), index: i }; };
const keyOf = (r) => `${r.sketch.id}:${r.index}`;

// a sketch shape as a world-space path; closed profiles come back as loops
function worldPath(ref) {
  const pts = ref.sketch.worldOutline(ref.index);
  return { pts, closed: isClosedProfile(ref.sketch.shapes[ref.index].profile) };
}

// point and tangent at arc length s along a polyline
function pointAtLength(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = pts[i].distanceTo(pts[i + 1]);
    if (acc + l >= s || i === pts.length - 2) {
      const t = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return { p: pts[i].clone().lerp(pts[i + 1], t), t: pts[i + 1].clone().sub(pts[i]).normalize() };
    }
    acc += l;
  }
  return { p: pts[0].clone(), t: new THREE.Vector3(1, 0, 0) };
}
const pathLength = (pts) => pts.slice(1).reduce((a, p, i) => a + p.distanceTo(pts[i]), 0);

// plane frame with its origin at a chosen point (so the plane shows up where it was made)
function frameAt(n, o) {
  const f = frameFromNormal(n, o);
  f.o = o.toArray();
  return f;
}

// origin planes + construction planes as { key, label, n, o }
function planeOptions(app) {
  const list = Object.entries(ORIGIN_PLANES).map(([k, p]) => ({ key: k, label: p.label, n: new THREE.Vector3(...p.normal), o: new THREE.Vector3() }));
  for (const p of app.doc.planes) list.push({ key: 'pl:' + p.id, label: p.name, n: frameNormal(p.frame), o: new THREE.Vector3(...p.frame.o) });
  return list;
}

// origin axes + construction axes as { key, label, o, d }
function axisOptions(app) {
  const list = [
    { key: 'X', label: 'X axis', o: new THREE.Vector3(), d: new THREE.Vector3(1, 0, 0) },
    { key: 'Y', label: 'Y axis (vertical)', o: new THREE.Vector3(), d: new THREE.Vector3(0, 1, 0) },
    { key: 'Z', label: 'Z axis', o: new THREE.Vector3(), d: new THREE.Vector3(0, 0, 1) },
  ];
  for (const a of app.doc.axes) list.push({ key: 'ax:' + a.id, label: a.name, o: a.origin, d: a.dir });
  return list;
}

// Live preview body for a dialog: rebuilt on every change, removed on cancel.
function livePreview(app) {
  let body = null;
  return {
    get body() { return body; },
    set(b, op = 'new') {
      if (body) app.doc.remove(body);
      body = b ? app.doc.add(b) : null;
      if (body) app.ghost([body], op);
      app.updateOverlaps();
      return body;
    },
    clear() { this.set(null); },
  };
}

// translucent preview mesh that is not part of the design
function toolGhost(app, body) {
  const m = body.mesh.material;
  m.transparent = true; m.opacity = 0.45; m.depthWrite = false; m.color.set('#e5484d');
  app.vp.scene.add(body.mesh);
  return () => { app.vp.scene.remove(body.mesh); body.dispose(); };
}

function newPlane(app, frame, label) {
  const plane = app.doc.addPlane(new ConstructionPlane({ name: app.doc.newName('plane'), frame, base: 'custom', offset: 0 }));
  app.doc.commit(`${label} ${plane.name}`, 'plane');
  bus.emit('plane:create', { plane });
  toast(`${plane.name} created. Use Create Sketch and click it to sketch on it.`, 'ok');
  return plane;
}

function newAxis(app, o, d, label) {
  if (d.lengthSq() < 1e-9) { toast('Those points are the same - pick two different points.', 'warn'); return null; }
  const axis = app.doc.addAxis(new ConstructionAxis({ name: app.doc.newName('axis'), o: o.toArray(), d: d.toArray() }));
  app.doc.commit(`${label} ${axis.name}`, 'axis');
  bus.emit('axis:create', { axis });
  toast(`${axis.name} created. Use it in Revolve, Circular Pattern or Plane at Angle.`, 'ok');
  return axis;
}

function newPoint(app, p, label) {
  const pt = app.doc.addPoint(new ConstructionPoint({ name: app.doc.newName('point'), p: p.toArray() }));
  app.doc.commit(`${label} ${pt.name}`, 'cpoint');
  bus.emit('point:create', { point: pt });
  return pt;
}

// small temporary dots shown while picking several points
function pickDots(app) {
  const group = new THREE.Group();
  app.vp.scene.add(group);
  return {
    add(p) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x7c3aed, depthTest: false }));
      d.renderOrder = 9; d.position.copy(p); d.scale.setScalar(app.vp.worldPerPixel(p) * 4);
      group.add(d);
    },
    clear() { app.vp.scene.remove(group); group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); },
  };
}

// ----- shape transforms used by the sketch MODIFY tools (sketch coords, degrees) -----
function spinShape(shape, deg) {
  const p = shape.profile;
  if (p.type === 'circle') return;
  if (p.type === 'ngon') p.rot = (p.rot ?? -Math.PI / 2) + rad(deg);
  else p.spin = (p.spin || 0) + deg;
}
function rotateShapeAbout(shape, deg, [pu, pv]) {
  const a = rad(deg), c = Math.cos(a), s = Math.sin(a);
  const du = shape.c[0] - pu, dv = shape.c[1] - pv;
  shape.c = [pu + du * c - dv * s, pv + du * s + dv * c];
  spinShape(shape, deg);
}
function mirrorShape(shape, axis /* 'v' flips H, 'u' flips V */) {
  const p = shape.profile;
  const i = axis === 'v' ? 0 : 1;
  shape.c[i] = -shape.c[i];
  if (p.type === 'ngon') p.rot = axis === 'v' ? Math.PI - (p.rot ?? -Math.PI / 2) : -(p.rot ?? -Math.PI / 2);
  if (p.spin) p.spin = -p.spin;
  if (p.pts) p.pts = p.pts.map((q) => (i === 0 ? [-q[0], q[1]] : [q[0], -q[1]]));
}
function scaleShape(shape, k) {
  const p = shape.profile;
  for (const key of ['w', 'd', 'r', 'rx', 'ry', 'len', 'fillet']) if (typeof p[key] === 'number') p[key] *= k;
  if (p.pts) p.pts = p.pts.map(([x, z]) => [x * k, z * k]);
}
function offsetShape(shape, d) {
  const p = shape.profile;
  switch (p.type) {
    case 'rect': p.w = Math.max(0.2, p.w + 2 * d); p.d = Math.max(0.2, p.d + 2 * d); if (p.fillet) p.fillet = Math.max(0, p.fillet + d); return true;
    case 'circle': p.r = Math.max(0.1, p.r + d); return true;
    case 'ellipse': p.rx = Math.max(0.1, p.rx + d); p.ry = Math.max(0.1, p.ry + d); return true;
    case 'slot': p.r = Math.max(0.1, p.r + d); return true;
    case 'ngon': p.r = Math.max(0.1, p.r + d / Math.cos(Math.PI / Math.max(3, p.n))); return true;
    case 'poly': case 'spline': p.pts = offsetPolygon(p.pts, d); return true;
    default: return false;
  }
}

Object.assign(App.prototype, {
  // ====================================================================
  // CREATE
  // ====================================================================
  loftDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'loft' });
    const options = shapeOptions(this, isClosedProfile);
    if (options.length < 2) { toast('Loft needs at least two closed profiles, usually on different (e.g. offset) planes.', 'warn', 4000); return; }
    const sel = this.profileSel.map(keyOf);
    const pv = livePreview(this);
    const name = this.doc.newName('loft');
    const keys = (v) => [v.a, v.b, v.c].filter((k) => k && k !== 'none');
    openDialog({
      title: 'Loft', subtitle: 'CREATE',
      help: 'Blends between two or three profiles in order (e.g. a square on the ground and a circle on an Offset Plane above it).',
      fields: [
        { key: 'a', label: 'Profile 1', type: 'select', value: sel[0] || options[0][0], options },
        { key: 'b', label: 'Profile 2', type: 'select', value: sel[1] || options[1][0], options },
        { key: 'c', label: 'Profile 3', type: 'select', value: sel[2] || 'none', options: [['none', '(none)'], ...options] },
        { key: 'op', label: 'Operation', type: 'select', value: 'new', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        const ks = keys(v);
        if (new Set(ks).size !== ks.length) { pv.clear(); this.setHint('⚠ Pick different profiles.'); return; }
        try {
          const loops = ks.map((k) => worldPath(refOf(this, k)).pts);
          pv.set(meshBody(loftGeometry(loops), name), v.op);
          this.setHint('Loft: choose the profiles in order, then OK.');
        } catch (err) { console.error(err); pv.clear(); this.setHint('⚠ Loft failed for these profiles.'); }
      },
      onOk: (v) => {
        if (!pv.body) return;
        const refs = keys(v).map((k) => refOf(this, k));
        const res = this.applyFeature([pv.body], v.op, refs, 'Loft', 'loft');
        if (res) bus.emit('loft', res);
      },
      onCancel: () => pv.clear(),
    });
  },

  sweepDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'sweep' });
    const profiles = shapeOptions(this, isClosedProfile);
    const paths = shapeOptions(this, () => true);
    if (!profiles.length || paths.length < 2) {
      toast('Sweep needs a closed <b>profile</b> and a <b>path</b> in another sketch (draw one with Open Line, 3-Point Arc or Spline).', 'warn', 5000);
      return;
    }
    const sel = this.profileSel.map(keyOf);
    const firstPath = shapeOptions(this, (p) => !isClosedProfile(p))[0]?.[0] || paths.find(([k]) => k !== (sel[0] || profiles[0][0]))?.[0];
    const pv = livePreview(this);
    const name = this.doc.newName('sweep');
    openDialog({
      title: 'Sweep', subtitle: 'CREATE',
      help: 'Moves the profile along the path. The profile is centred on the start of the path and kept square to it.',
      fields: [
        { key: 'profile', label: 'Profile', type: 'select', value: sel[0] || profiles[0][0], options: profiles },
        { key: 'path', label: 'Path', type: 'select', value: firstPath, options: paths },
        { key: 'twist', label: 'Twist angle (°)', type: 'number', value: 0, step: 15 },
        { key: 'scale', label: 'End scale', type: 'number', value: 1, min: 0.05, max: 10, step: 0.1 },
        { key: 'op', label: 'Operation', type: 'select', value: 'new', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        if (v.profile === v.path) { pv.clear(); this.setHint('⚠ The path must be a different sketch curve.'); return; }
        try {
          const pr = refOf(this, v.profile);
          const section = profilePoints(pr.sketch.shapes[pr.index].profile);
          const { pts, closed } = worldPath(refOf(this, v.path));
          pv.set(meshBody(sweepGeometry(section, pts, { closed, twist: v.twist, scaleEnd: v.scale }), name), v.op);
          this.setHint('Sweep: pick the profile and the path, then OK.');
        } catch (err) { console.error(err); pv.clear(); this.setHint('⚠ Sweep failed for this profile/path.'); }
      },
      onOk: (v) => {
        if (!pv.body) return;
        const res = this.applyFeature([pv.body], v.op, [refOf(this, v.profile), refOf(this, v.path)], 'Sweep', 'sweep');
        if (res) bus.emit('sweep', res);
      },
      onCancel: () => pv.clear(),
    });
  },

  pipeDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'pipe' });
    const paths = shapeOptions(this, () => true);
    if (!paths.length) { toast('Pipe needs a path: draw an Open Line, 3-Point Arc or Spline in a sketch first.', 'warn', 4000); return; }
    const sel = this.profileSel.map(keyOf);
    const pv = livePreview(this);
    const name = this.doc.newName('pipe');
    const SECTIONS = { circle: (s) => circleSection(s / 2, 28), square: (s) => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]], triangle: (s) => [0, 1, 2].map((k) => [Math.cos(-Math.PI / 2 + (k * Math.PI * 2) / 3) * s / 2, Math.sin(-Math.PI / 2 + (k * Math.PI * 2) / 3) * s / 2]) };
    openDialog({
      title: 'Pipe', subtitle: 'CREATE',
      help: 'Sweeps a round (or square / triangular) section along a sketch path. <b>Hollow</b> makes a tube.',
      fields: [
        { key: 'path', label: 'Path', type: 'select', value: sel[0] || shapeOptions(this, (p) => !isClosedProfile(p))[0]?.[0] || paths[0][0], options: paths },
        { key: 'section', label: 'Section', type: 'select', value: 'circle', options: [['circle', 'Circular'], ['square', 'Square'], ['triangle', 'Triangular']] },
        { key: 'size', label: 'Section size (mm)', type: 'number', value: 6, min: 0.2, step: 0.5 },
        { key: 'hollow', label: 'Hollow', type: 'checkbox', value: false },
        { key: 'wall', label: 'Wall thickness (mm)', type: 'number', value: 1, min: 0.1, step: 0.25 },
        { key: 'op', label: 'Operation', type: 'select', value: 'new', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        try {
          const { pts, closed } = worldPath(refOf(this, v.path));
          let body = meshBody(sweepGeometry(SECTIONS[v.section](v.size), pts, { closed }), name);
          if (v.hollow && v.wall < v.size / 2) {
            // inner tube, a little longer so it cuts cleanly through the ends
            const inner = pts.map((p) => p.clone());
            if (!closed) {
              inner[0].addScaledVector(inner[0].clone().sub(inner[1]).normalize(), 1);
              const n = inner.length - 1;
              inner[n].addScaledVector(inner[n].clone().sub(inner[n - 1]).normalize(), 1);
            }
            const tool = meshBody(sweepGeometry(SECTIONS[v.section](v.size - 2 * v.wall), inner, { closed }), 'pipe-inner');
            const r = combine(body, [tool], 'cut');
            tool.dispose();
            if (r) { body.dispose(); body = r; }
          }
          pv.set(body, v.op);
        } catch (err) { console.error(err); pv.clear(); this.setHint('⚠ Pipe failed for this path.'); }
      },
      onOk: (v) => {
        if (!pv.body) return;
        const res = this.applyFeature([pv.body], v.op, [refOf(this, v.path)], 'Pipe', 'pipe');
        if (res) bus.emit('pipe', res);
      },
      onCancel: () => pv.clear(),
    });
  },

  ribDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'rib' });
    const paths = shapeOptions(this, (p) => !isClosedProfile(p));
    if (!paths.length) { toast('Rib/Web needs an <b>open</b> sketch line (Open Line, 3-Point Arc or Spline finished with Enter).', 'warn', 4500); return; }
    const pv = livePreview(this);
    const name = this.doc.newName('rib');
    openDialog({
      title: 'Rib / Web', subtitle: 'CREATE',
      help: 'Thickens an open sketch line into a wall, then extrudes it away from the sketch plane. Usually joined to an existing body.',
      fields: [
        { key: 'path', label: 'Curve', type: 'select', value: paths[0][0], options: paths },
        { key: 't', label: 'Thickness (mm)', type: 'number', value: 2, min: 0.1, step: 0.5 },
        { key: 'depth', label: 'Depth (mm)', type: 'number', value: 10, step: 1 },
        { key: 'dir', label: 'Direction', type: 'select', value: 'one', options: [['one', 'One Side'], ['sym', 'Symmetric']] },
        { key: 'op', label: 'Operation', type: 'select', value: 'join', options: OP_OPTIONS },
      ],
      onChange: (v) => {
        const ref = refOf(this, v.path);
        const sh = ref.sketch.shapes[ref.index];
        const pts = profilePoints(sh.profile).map(([x, z]) => [x + sh.c[0], z + sh.c[1]]);
        const outline = thickenPolyline(pts, v.t);
        const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const d = Math.abs(v.depth) < 0.1 ? 0.1 : v.depth;
        const start = v.dir === 'sym' ? -Math.abs(d) : Math.min(0, d), height = v.dir === 'sym' ? 2 * Math.abs(d) : Math.abs(d);
        const q = new THREE.Quaternion(...ref.sketch.frame.q);
        pv.set(new Body({
          kind: 'extrude', name, params: { profile: { type: 'poly', pts: outline.map(([x, z]) => [x - cx, z - cz]) }, height, start, taper: 0 },
          position: ref.sketch.toWorld(cx, cz).toArray(), rotation: new THREE.Euler().setFromQuaternion(q).toArray().slice(0, 3),
        }), v.op);
      },
      onOk: (v) => {
        if (!pv.body) return;
        const res = this.applyFeature([pv.body], v.op, [refOf(this, v.path)], 'Rib', 'rib');
        if (res) bus.emit('rib', res);
      },
      onCancel: () => pv.clear(),
    });
  },

  holeDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'hole' });
    if (!this.doc.bodies.some((b) => b.visible)) { toast('Hole: create a body first, then click a face of it.', 'warn'); return; }
    this.startPicking('<b>Hole:</b> click the point on a face where the hole goes.', (hit) => {
      const target = hit.body;
      const depthAll = target.worldBox().getSize(new THREE.Vector3()).length() * 2;
      let tool = null, cleanup = null;
      const build = (v) => {
        cleanup?.();
        const r = v.d / 2, e = 0.5;
        const D = v.through ? depthAll : Math.max(0.2, v.depth);
        const tip = v.tip ? r * Math.tan(rad(31)) : 0;
        let outline;
        if (v.type === 'cbore') {
          const R = Math.max(v.d2 / 2, r + 0.1), cd = Math.min(v.d2depth, D - 0.1);
          outline = [[0, e], [R, e], [R, -cd], [r, -cd], [r, -D], [0, -D - tip]];
        } else if (v.type === 'csink') {
          const R = Math.max(v.d2 / 2, r + 0.1), h = Math.min((R - r) / Math.tan(rad(Math.max(30, v.angle) / 2)), D - 0.1);
          outline = [[0, e], [R, e], [R, 0], [r, -h], [r, -D], [0, -D - tip]];
        } else outline = [[0, e], [r, e], [r, -D], [0, -D - tip]];
        tool = new Body({ kind: 'mesh', name: 'hole-tool', geometry: latheSolid(outline, 48) });
        tool.mesh.position.copy(hit.point);
        tool.mesh.quaternion.setFromUnitVectors(Y, hit.normal);
        cleanup = toolGhost(this, tool);
      };
      openDialog({
        title: 'Hole', subtitle: target.name,
        help: 'Drills into the face you clicked. <b>Counterbore</b> adds a wider step for a bolt head, <b>Countersink</b> a cone for a flat screw head.',
        fields: [
          { key: 'type', label: 'Hole type', type: 'select', value: 'simple', options: [['simple', 'Simple'], ['cbore', 'Counterbore'], ['csink', 'Countersink']] },
          { key: 'd', label: 'Diameter (mm)', type: 'number', value: 5, min: 0.2, step: 0.5 },
          { key: 'depth', label: 'Depth (mm)', type: 'number', value: 10, min: 0.2, step: 1 },
          { key: 'through', label: 'Through all', type: 'checkbox', value: false },
          { key: 'd2', label: 'Head diameter (mm)', type: 'number', value: 9, min: 0.5, step: 0.5 },
          { key: 'd2depth', label: 'Counterbore depth (mm)', type: 'number', value: 4, min: 0.1, step: 0.5 },
          { key: 'angle', label: 'Countersink angle (°)', type: 'number', value: 90, min: 30, max: 150, step: 1 },
          { key: 'tip', label: 'Drill point (118°)', type: 'checkbox', value: true },
        ],
        onChange: build,
        onOk: (v) => {
          try {
            const r = combine(target, [tool], 'cut');
            cleanup();
            if (!r) throw new Error('empty');
            this.doc.remove(target);
            this.doc.add(r);
            this.doc.commit(`Hole Ø${round(v.d)} in ${target.name}`, 'hole');
            this.select([r]);
            bus.emit('hole', { diameter: v.d, type: v.type, body: r });
          } catch (err) { console.error(err); cleanup(); toast('Hole failed here - try another face or size.', 'err'); }
        },
        onCancel: () => cleanup?.(),
      });
      return false;
    });
  },

  threadDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'thread' });
    if (!this.requireSelection(1, 'a Cylinder body')) return;
    const body = this.primary;
    if (body.kind !== 'cylinder') { toast('In this simplified version Thread works on <b>Cylinder</b> bodies (a modelled external thread).', 'warn', 4000); return; }
    const p = body.params;
    let tool = null, cleanup = null;
    openDialog({
      title: 'Thread', subtitle: body.name,
      help: 'Adds a modelled external thread (a helical ridge) around the cylinder, like a bolt.',
      fields: [
        { key: 'pitch', label: 'Pitch (mm)', type: 'number', value: Math.max(0.5, round(p.radius / 4, 1)), min: 0.3, step: 0.25 },
        { key: 'depth', label: 'Thread depth (mm)', type: 'number', value: Math.max(0.3, round(p.radius / 6, 1)), min: 0.1, step: 0.1 },
        { key: 'length', label: 'Length (mm)', type: 'number', value: p.height, min: 1, step: 1 },
        { key: 'offset', label: 'Start height (mm)', type: 'number', value: 0, min: 0, step: 1 },
      ],
      onChange: (v) => {
        cleanup?.();
        const w = v.pitch * 0.85, h = v.depth;
        const len = Math.max(v.pitch * 1.5, Math.min(v.length, p.height - v.offset));
        const { points, frames } = helix(p.radius, v.pitch, Math.max(0.25, (len - w) / v.pitch), v.offset + w / 2, 36);
        tool = new Body({ kind: 'mesh', name: 'thread-tool', geometry: sweepGeometry([[-0.25 * h, -w / 2], [h, 0], [-0.25 * h, w / 2]], points, { frames, crease: 60 }) });
        tool.mesh.position.copy(body.mesh.position);
        tool.mesh.quaternion.copy(body.mesh.quaternion);
        tool.mesh.scale.copy(body.mesh.scale);
        cleanup = toolGhost(this, tool);
      },
      onOk: (v) => {
        try {
          const r = combine(body, [tool], 'join');
          cleanup();
          if (!r) throw new Error('empty');
          this.doc.remove(body);
          this.doc.add(r);
          this.doc.commit(`Thread ${body.name}`, 'thread');
          this.select([r]);
          bus.emit('thread', { pitch: v.pitch, body: r });
        } catch (err) { console.error(err); cleanup(); toast('Thread failed - try a larger pitch.', 'err'); }
      },
      onCancel: () => cleanup?.(),
    });
  },

  pathPatternDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'pathpattern' });
    if (!this.requireSelection()) return;
    const paths = shapeOptions(this, () => true);
    if (!paths.length) { toast('Pattern on Path needs a sketch path (e.g. an Open Line, Arc or Spline).', 'warn', 4000); return; }
    const src = this.primary;
    let copies = [];
    const clear = () => { for (const c of copies) this.doc.remove(c); copies = []; };
    openDialog({
      title: 'Pattern on Path', subtitle: src.name,
      help: 'Copies the body along a sketch path. Copies are placed relative to the start of the path.',
      fields: [
        { key: 'path', label: 'Path', type: 'select', value: shapeOptions(this, (p) => !isClosedProfile(p))[0]?.[0] || paths[0][0], options: paths },
        { key: 'n', label: 'Quantity', type: 'number', value: 5, min: 2, max: 60, step: 1 },
        { key: 'mode', label: 'Distribution', type: 'select', value: 'extent', options: [['extent', 'Spread over the whole path'], ['spacing', 'Fixed spacing']] },
        { key: 'spacing', label: 'Spacing (mm)', type: 'number', value: 20, min: 0.1, step: 1 },
        { key: 'orient', label: 'Orientation', type: 'select', value: 'identical', options: [['identical', 'Identical'], ['path', 'Path direction']] },
      ],
      onChange: (v) => {
        clear();
        const { pts: raw, closed } = worldPath(refOf(this, v.path));
        const pts = closed ? [...raw, raw[0]] : raw;
        const L = pathLength(pts), n = Math.round(v.n);
        const start = pointAtLength(pts, 0);
        for (let k = 1; k < n; k++) {
          const s = v.mode === 'spacing' ? k * v.spacing : (L * k) / (closed ? n : n - 1);
          if (s > L + 1e-6) break;
          const at = pointAtLength(pts, s);
          const c = cloneBody(src, this.doc);
          if (v.orient === 'path') {
            const q = new THREE.Quaternion().setFromUnitVectors(start.t, at.t);
            c.mesh.position.sub(start.p).applyQuaternion(q).add(at.p);
            c.mesh.quaternion.premultiply(q);
          } else c.mesh.position.add(at.p.clone().sub(start.p));
          copies.push(this.doc.add(c));
        }
        this.updateOverlaps();
      },
      onOk: () => {
        if (!copies.length) return;
        this.doc.commit(`Pattern on Path ${src.name} ×${copies.length + 1}`, 'pathpattern');
        bus.emit('pattern', { count: copies.length + 1, kind: 'path' });
      },
      onCancel: () => { clear(); this.updateOverlaps(); },
    });
  },

  // ====================================================================
  // MODIFY
  // ====================================================================
  draftDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'draft' });
    if (!this.requireSelection()) return;
    const body = this.primary;
    const original = body.geometry;
    original.computeBoundingBox();
    const bb = original.boundingBox.clone();
    openDialog({
      title: 'Draft', subtitle: body.name,
      help: 'Tilts the side faces so the body gets narrower towards the top (positive angle), like a moulded part that must slide out of its mould.',
      fields: [{ key: 'angle', label: 'Draft angle (°)', type: 'number', value: 5, min: -30, max: 30, step: 1 }],
      onChange: (v) => {
        const g = original.clone();
        for (const n of Object.keys(g.attributes)) if (n !== 'position') g.deleteAttribute(n);
        const pos = g.attributes.position, t = Math.tan(rad(v.angle));
        const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
        const hx = (bb.max.x - bb.min.x) / 2 || 1, hz = (bb.max.z - bb.min.z) / 2 || 1;
        for (let i = 0; i < pos.count; i++) {
          const h = pos.getY(i) - bb.min.y;
          pos.setX(i, cx + (pos.getX(i) - cx) * Math.max(0.02, 1 - (h * t) / hx));
          pos.setZ(i, cz + (pos.getZ(i) - cz) * Math.max(0.02, 1 - (h * t) / hz));
        }
        body.setGeometry(toCreasedNormals(g, rad(30)));
        this.updateOverlaps();
      },
      onOk: (v) => {
        body.kind = 'mesh';
        body.params = {};
        this.doc.commit(`Draft ${body.name} ${v.angle}°`, 'draft');
        bus.emit('draft', { angle: v.angle, body });
      },
      onCancel: () => { body.setGeometry(original); this.updateOverlaps(); },
    });
  },

  offsetFaceDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'offset-face' });
    this.startPicking('<b>Offset Face:</b> click a flat face of a Box, Cylinder or Extrude body.', (hit) => {
      const body = hit.body, p = body.params, ln = hit.localNormal;
      const comps = [ln.x, ln.y, ln.z].map(Math.abs);
      const axis = comps.indexOf(Math.max(...comps));
      const sign = Math.sign([ln.x, ln.y, ln.z][axis]);
      let key = null, shiftAxis = null, shiftScale = 0;
      if (body.kind === 'box' && comps[axis] > 0.99) {
        key = ['width', 'height', 'depth'][axis];
        shiftAxis = axis;
        shiftScale = axis === 1 ? (sign < 0 ? -1 : 0) : sign / 2;
      } else if (body.kind === 'cylinder') {
        if (comps[1] > 0.99) { key = 'height'; shiftAxis = 1; shiftScale = sign < 0 ? -1 : 0; } else if (comps[1] < 0.2) key = 'radius';
      } else if (body.kind === 'extrude' && comps[1] > 0.99) {
        key = sign > 0 ? 'height' : 'start';
      }
      if (!key) { toast('Offset Face works on the flat faces of Box, Cylinder (top, bottom, side) and Extrude (top, bottom) bodies.', 'warn', 4000); return true; }
      const old = structuredClone(p), oldPos = body.mesh.position.clone();
      openDialog({
        title: 'Offset Face', subtitle: body.name,
        help: 'Pushes the face out (positive) or pulls it in (negative). The opposite face stays where it is.',
        fields: [{ key: 'd', label: 'Distance (mm)', type: 'number', value: 5, step: 1 }],
        onChange: (v) => {
          Object.assign(p, structuredClone(old));
          body.mesh.position.copy(oldPos);
          if (body.kind === 'extrude') {
            if (key === 'height') p.height = Math.max(0.1, old.height + v.d);
            else { const d = Math.min(v.d, old.height - 0.1); p.start = (old.start || 0) - d; p.height = old.height + d; }
          } else {
            p[key] = Math.max(0.2, old[key] + v.d);
            if (shiftAxis !== null) {
              const shift = new THREE.Vector3();
              shift.setComponent(shiftAxis, (p[key] - old[key]) * shiftScale);
              shift.multiply(body.mesh.scale).applyQuaternion(body.mesh.quaternion);
              body.mesh.position.add(shift);
            }
          }
          body.rebuild();
          this.updateOverlaps();
        },
        onOk: (v) => {
          this.doc.commit(`Offset Face ${body.name}`, 'offsetface');
          bus.emit('offset-face', { distance: v.d, body });
        },
        onCancel: () => { Object.assign(p, old); body.mesh.position.copy(oldPos); body.rebuild(); this.updateOverlaps(); },
      });
      return false;
    });
  },

  splitBodyDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'split-body' });
    if (!this.requireSelection()) return;
    const body = this.primary;
    const planes = planeOptions(this);
    const preview = makePlaneMesh(0xe5484d, 120);
    this.vp.scene.add(preview);
    const cleanup = () => this.vp.scene.remove(preview);
    const planeOf = (v) => {
      const pl = planes.find((p) => p.key === v.plane);
      return { n: pl.n.clone(), o: pl.o.clone().addScaledVector(pl.n, v.offset) };
    };
    openDialog({
      title: 'Split Body', subtitle: body.name,
      help: 'Cuts the body into two separate bodies along a plane (an origin plane or a construction plane, plus an offset).',
      fields: [
        { key: 'plane', label: 'Splitting tool', type: 'select', value: planes[0].key, options: planes.map((p) => [p.key, p.label]) },
        { key: 'offset', label: 'Offset (mm)', type: 'number', value: 0, step: 1 },
      ],
      onChange: (v) => {
        const { n, o } = planeOf(v);
        const f = frameAt(n, o);
        preview.position.fromArray(f.o);
        preview.quaternion.fromArray(f.q);
      },
      onOk: (v) => {
        cleanup();
        try {
          const { n, o } = planeOf(v);
          const parts = splitBody(body, n, o, this.doc);
          if (!parts) { toast('The plane does not cut through this body.', 'warn', 3500); return; }
          this.doc.remove(body);
          for (const part of parts) this.doc.add(part);
          this.doc.commit(`Split ${body.name}`, 'split');
          this.select(parts);
          bus.emit('split', { bodies: parts });
        } catch (err) { console.error(err); toast('Split failed for this body.', 'err'); }
      },
      onCancel: cleanup,
    });
  },

  alignDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'align' });
    if (!this.requireSelection(2)) return;
    const [moving, target] = this.selection;
    const start = moving.mesh.position.clone();
    const opt = [['none', 'Leave'], ['min', 'Min'], ['center', 'Centre'], ['max', 'Max']];
    openDialog({
      title: 'Align', subtitle: `${moving.name} → ${target.name}`,
      help: `Moves <b>${moving.name}</b> (selected first) so its sides or centre line up with <b>${target.name}</b>. Use Min on Y to sit both on the same floor.`,
      fields: [
        { key: 'x', label: 'X', type: 'select', value: 'center', options: opt },
        { key: 'y', label: 'Y', type: 'select', value: 'none', options: opt },
        { key: 'z', label: 'Z', type: 'select', value: 'center', options: opt },
      ],
      onChange: (v) => {
        moving.mesh.position.copy(start);
        const a = moving.worldBox(), b = target.worldBox();
        const at = (box, k, mode) => (mode === 'min' ? box.min[k] : mode === 'max' ? box.max[k] : (box.min[k] + box.max[k]) / 2);
        for (const k of ['x', 'y', 'z']) if (v[k] !== 'none') moving.mesh.position[k] += at(b, k, v[k]) - at(a, k, v[k]);
        this.updateOverlaps();
      },
      onOk: () => { this.doc.commit(`Align ${moving.name}`, 'align'); bus.emit('align', { body: moving }); },
      onCancel: () => { moving.mesh.position.copy(start); this.updateOverlaps(); },
    });
  },

  physicalMaterialDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'physical-material' });
    if (!this.requireSelection()) return;
    const bodies = [...this.selection];
    openDialog({
      title: 'Physical Material', subtitle: bodies.map((b) => b.name).join(', '),
      help: 'Sets what the body is made of. The density gives its <b>mass</b> (see Properties and Centre of Mass).',
      fields: [
        { key: 'm', label: 'Material', type: 'select', value: bodies[0].physical || 'steel', options: Object.entries(PHYSICAL_MATERIALS).map(([k, m]) => [k, `${m.label} (${m.density} g/cm³)`]) },
        { key: 'look', label: 'Also change appearance', type: 'checkbox', value: true },
      ],
      onOk: (v) => {
        const m = PHYSICAL_MATERIALS[v.m];
        for (const b of bodies) { b.physical = v.m; if (v.look) b.setAppearance(m.color, m.look); }
        this.doc.commit(`Physical Material ${m.label}`, 'physmat');
        bus.emit('physical-material', { material: v.m, bodies });
      },
    });
  },

  // ====================================================================
  // CONSTRUCT
  // ====================================================================
  _planeDialog(title, help, fields, frameOf, label) {
    const preview = makePlaneMesh(0xf28c28, 90);
    this.vp.scene.add(preview);
    const cleanup = () => this.vp.scene.remove(preview);
    openDialog({
      title, subtitle: 'CONSTRUCT', help, fields,
      onChange: (v) => {
        const f = frameOf(v);
        preview.visible = !!f;
        if (f) { preview.position.fromArray(f.o); preview.quaternion.fromArray(f.q); }
      },
      onOk: (v) => { cleanup(); const f = frameOf(v); if (f) newPlane(this, f, label); },
      onCancel: cleanup,
    });
  },

  planeAtAngleDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'plane-angle' });
    const axes = axisOptions(this);
    this._planeDialog('Plane at Angle', 'A construction plane that contains an axis and is turned around it by an angle.', [
      { key: 'axis', label: 'Axis', type: 'select', value: 'X', options: axes.map((a) => [a.key, a.label]) },
      { key: 'angle', label: 'Angle (°)', type: 'number', value: 45, step: 15 },
    ], (v) => {
      const ax = axes.find((a) => a.key === v.axis);
      const d = ax.d.clone().normalize();
      const ref = Math.abs(d.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const p0 = ref.sub(d.clone().multiplyScalar(ref.dot(d))).normalize();
      return frameAt(p0.applyAxisAngle(d, rad(v.angle)), ax.o);
    }, 'Plane at Angle');
  },

  midplaneDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'midplane' });
    const planes = planeOptions(this);
    this._planeDialog('Midplane', 'A plane halfway between two planes. Parallel planes give the plane in the middle; crossing planes give the plane that splits the angle.', [
      { key: 'a', label: 'First plane', type: 'select', value: planes[0].key, options: planes.map((p) => [p.key, p.label]) },
      { key: 'b', label: 'Second plane', type: 'select', value: planes[planes.length > 3 ? 3 : 1].key, options: planes.map((p) => [p.key, p.label]) },
    ], (v) => {
      const A = planes.find((p) => p.key === v.a), B = planes.find((p) => p.key === v.b);
      if (A === B) return null;
      let nB = B.n.clone(), dB = B.n.dot(B.o);
      if (A.n.dot(nB) < 0) { nB.negate(); dB = -dB; }
      const dA = A.n.dot(A.o);
      const parallel = A.n.dot(nB) > 0.9999;
      const n = parallel ? A.n.clone() : A.n.clone().sub(nB);
      const d = parallel ? (dA + dB) / 2 : dA - dB;
      const m = A.o.clone().add(B.o).multiplyScalar(0.5);
      const len2 = n.lengthSq();
      const o = m.clone().addScaledVector(n, (d - n.dot(m)) / len2);
      return frameAt(n.normalize(), o);
    }, 'Midplane');
  },

  tangentPlane() {
    this.cancelTools();
    bus.emit('tool', { tool: 'plane-tangent' });
    this.startPicking('<b>Tangent Plane:</b> click a point on any face (flat or curved).', (hit) => { newPlane(this, frameAt(hit.normal, hit.point), 'Tangent Plane'); return false; });
  },

  planeThreePoints() {
    this.cancelTools();
    bus.emit('tool', { tool: 'plane-3pt' });
    const pts = [];
    const dots = pickDots(this);
    this.startPicking('<b>Plane Through Three Points:</b> click 3 points (corners snap, construction points work too).', (hit) => {
      pts.push(hit.point.clone());
      dots.add(hit.point);
      if (pts.length < 3) { this.setHint(`Plane Through Three Points: point ${pts.length} of 3 picked. Esc to cancel.`); return true; }
      dots.clear();
      const n = pts[1].clone().sub(pts[0]).cross(pts[2].clone().sub(pts[0]));
      if (n.lengthSq() < 1e-6) { toast('Those points are in a line - pick three points that form a triangle.', 'warn', 3500); return false; }
      if (n.y < 0 || (Math.abs(n.y) < 1e-6 && n.z < 0)) n.negate();
      newPlane(this, frameAt(n.normalize(), pts[0].clone().add(pts[1]).add(pts[2]).divideScalar(3)), 'Three-Point');
      return false;
    }, { points: true, snap: true });
    const stop = this.stopPicking.bind(this);
    this.stopPicking = () => { dots.clear(); this.stopPicking = stop; stop(); };
  },

  planeAlongPathDialog() {
    this.cancelTools();
    bus.emit('tool', { tool: 'plane-path' });
    const paths = shapeOptions(this, () => true);
    if (!paths.length) { toast('Plane Along Path needs a sketch path (an Open Line, Arc, Spline or profile).', 'warn', 4000); return; }
    this._planeDialog('Plane Along Path', 'A plane square to a sketch path, at a distance along it (0 % = start, 100 % = end). Handy for Sweep and Loft sections.', [
      { key: 'path', label: 'Path', type: 'select', value: shapeOptions(this, (p) => !isClosedProfile(p))[0]?.[0] || paths[0][0], options: paths },
      { key: 't', label: 'Distance along (%)', type: 'number', value: 50, min: 0, max: 100, step: 5 },
    ], (v) => {
      const { pts: raw, closed } = worldPath(refOf(this, v.path));
      const pts = closed ? [...raw, raw[0]] : raw;
      const at = pointAtLength(pts, (pathLength(pts) * v.t) / 100);
      return frameAt(at.t, at.p);
    }, 'Plane Along Path');
  },

  axisThroughBody() {
    this.cancelTools();
    bus.emit('tool', { tool: 'axis-cyl' });
    this.startPicking('<b>Axis Through Cylinder/Cone/Torus:</b> click a round body.', (hit) => {
      const b = hit.body;
      b.mesh.updateMatrixWorld(true);
      const m = b.mesh.matrixWorld;
      let o = new THREE.Vector3(), d = new THREE.Vector3(0, 1, 0);
      if (b.kind === 'revolve') {
        const p = b.params;
        if (p.axis === 'line') { o.set(p.axisLine.o[0], 0, p.axisLine.o[1]); d.set(p.axisLine.d[0], 0, p.axisLine.d[1]); } else d.set(p.axis === 'u' ? 1 : 0, 0, p.axis === 'u' ? 0 : 1);
      } else if (!['cylinder', 'cone', 'torus', 'coil', 'sphere'].includes(b.kind)) {
        toast(`Pick a Cylinder, Cone, Torus, Coil, Sphere or Revolve body (${KIND_LABEL[b.kind]} has no central axis).`, 'warn', 4000);
        return true;
      }
      newAxis(this, o.applyMatrix4(m), d.transformDirection(m), 'Axis Through');
      return false;
    });
  },

  axisTwoPoints() {
    this.cancelTools();
    bus.emit('tool', { tool: 'axis-2pt' });
    const pts = [];
    const dots = pickDots(this);
    this.startPicking('<b>Axis Through Two Points:</b> click two points (corners snap).', (hit) => {
      pts.push(hit.point.clone());
      dots.add(hit.point);
      if (pts.length < 2) { this.setHint('Axis Through Two Points: now click the second point. Esc to cancel.'); return true; }
      dots.clear();
      newAxis(this, pts[0], pts[1].clone().sub(pts[0]), 'Axis Through Points');
      return false;
    }, { points: true, snap: true });
    const stop = this.stopPicking.bind(this);
    this.stopPicking = () => { dots.clear(); this.stopPicking = stop; stop(); };
  },

  axisPerpendicular() {
    this.cancelTools();
    bus.emit('tool', { tool: 'axis-perp' });
    this.startPicking('<b>Axis Perpendicular to Face at Point:</b> click a point on a face.', (hit) => { newAxis(this, hit.point, hit.normal, 'Axis Perpendicular'); return false; }, { snap: true });
  },

  pointPick() {
    this.cancelTools();
    bus.emit('tool', { tool: 'point-pick' });
    this.startPicking('<b>Point:</b> click a corner (snaps) or anywhere on a face.', (hit) => { newPoint(this, hit.point, 'Point'); return false; }, { snap: true });
  },

  pointAtCenter() {
    this.cancelTools();
    bus.emit('tool', { tool: 'point-center' });
    this.startPicking('<b>Point at Centre:</b> click a body (sphere, cylinder, torus…) to mark its centre.', (hit) => {
      const props = massProperties(worldGeometry(hit.body));
      newPoint(this, props.center, 'Centre Point');
      return false;
    });
  },

  // ====================================================================
  // INSPECT
  // ====================================================================
  analysisDialog(type) {
    this.cancelTools();
    bus.emit('tool', { tool: type });
    const old = this.analysis && { ...this.analysis };
    const TITLE = { zebra: 'Zebra Analysis', draft: 'Draft Analysis', curvature: 'Curvature Map Analysis' };
    const HELP = {
      zebra: 'Reflects stripes on the bodies. Smooth stripes = smooth surfaces; kinks or jumps show sharp or bumpy joins.',
      draft: 'Colours faces by their angle to the pull direction: <b style="color:#2f9e44">green</b> = enough draft, <b style="color:#d4a017">yellow</b> = nearly vertical (would stick in a mould), <b style="color:#d9363e">red</b> = faces the other way (negative draft).',
      curvature: 'Colours the surface by how tightly it curves: <b style="color:#1c6fd1">blue</b> = flat, <b style="color:#d9363e">red</b> = tight curves and sharp edges.',
    };
    const fields = {
      zebra: [{ key: 'stripes', label: 'Stripes', type: 'number', value: old?.stripes ?? 10, min: 2, max: 40, step: 1 }, { key: 'dir', label: 'Direction', type: 'select', value: old?.dir ?? 'y', options: [['y', 'Horizontal'], ['x', 'Vertical (X)'], ['z', 'Vertical (Z)']] }],
      draft: [{ key: 'pull', label: 'Pull direction', type: 'select', value: old?.pull ?? 'y', options: [['y', '+Y (up)'], ['x', '+X'], ['z', '+Z']] }, { key: 'angle', label: 'Draft angle (°)', type: 'number', value: old?.angle ?? 3, min: 0, max: 30, step: 0.5 }],
      curvature: [],
    }[type];
    openDialog({
      title: TITLE[type], subtitle: 'INSPECT', help: HELP[type] + '<br><small>Remove it from the Browser (Analysis) when done.</small>', fields,
      onChange: (v) => { this.analysis = { type, ...v, visible: true }; this.applyAnalysis(); },
      onOk: () => { bus.emit('analysis', { type }); bus.emit('selection:changed'); },
      onCancel: () => { this.analysis = old; this.applyAnalysis(); },
    });
  },

  toggleAnalysis() { if (this.analysis) { this.analysis.visible = !this.analysis.visible; this.applyAnalysis(); bus.emit('selection:changed'); } },
  removeAnalysis() { this.analysis = null; this.applyAnalysis(); bus.emit('selection:changed'); },

  applyAnalysis() {
    const a = this.analysis?.visible ? this.analysis : null;
    for (const b of this.doc.bodies) {
      for (const c of b.mesh.children.filter((o) => o.userData.analysis)) { b.mesh.remove(c); c.material.dispose(); }
      b.mesh.material.visible = !a;
      if (!a) continue;
      const geo = a.type === 'curvature' ? curvatureOf(b.geometry) : b.geometry;
      const ov = new THREE.Mesh(geo, analysisMaterial(a));
      ov.userData.analysis = true;
      ov.raycast = () => {};
      b.mesh.add(ov);
    }
  },

  centerOfMass() {
    this.cancelTools();
    bus.emit('tool', { tool: 'com' });
    const bodies = this.selection.length ? [...this.selection] : this.doc.bodies.filter((b) => b.visible);
    if (!bodies.length) { toast('Nothing to inspect - create a body first.', 'warn'); return; }
    let mass = 0, volume = 0, area = 0;
    const c = new THREE.Vector3();
    for (const b of bodies) {
      const mp = massProperties(worldGeometry(b));
      const m = (mp.volume / 1000) * (PHYSICAL_MATERIALS[b.physical]?.density ?? 7.85); // grams
      mass += m; volume += mp.volume; area += mp.area;
      c.addScaledVector(mp.center, m);
    }
    if (mass > 0) c.divideScalar(mass);
    const marker = new THREE.Group();
    const s = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false }));
    s.renderOrder = 11;
    marker.add(s);
    for (const [d, col] of [[[1, 0, 0], 0xd9363e], [[0, 1, 0], 0x2f9e44], [[0, 0, 1], 0x1c6fd1]]) {
      const v = new THREE.Vector3(...d).multiplyScalar(8);
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v.clone().negate(), v]), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
      l.renderOrder = 11;
      marker.add(l);
    }
    marker.position.copy(c);
    this.vp.scene.add(marker);
    const cleanup = () => { this.vp.scene.remove(marker); marker.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); };
    const fmtMass = mass >= 1000 ? `${round(mass / 1000, 3)} kg` : `${round(mass, 2)} g`;
    openDialog({
      title: 'Centre of Mass', subtitle: `${bodies.length} bod${bodies.length > 1 ? 'ies' : 'y'}`,
      help: `The black dot marks the balance point.<br><br>
        <b>X</b> ${round(c.x)} · <b>Y</b> ${round(c.y)} · <b>Z</b> ${round(c.z)} mm<br>
        Mass: <b>${fmtMass}</b><br>Volume: <b>${round(volume / 1000, 2)} cm³</b><br>Surface area: <b>${round(area / 100, 2)} cm²</b><br>
        <small>Mass uses each body's Physical Material (default Steel).</small>`,
      okLabel: 'Close',
      onOk: cleanup,
      onCancel: cleanup,
    });
    bus.emit('com', { center: c, mass });
  },

  // ====================================================================
  // SKETCH: MODIFY + CONSTRAINTS (work on the open sketch)
  // ====================================================================
  _sketchDialog({ title, help, fields = [], need = () => true, needMsg, apply, others = false }) {
    const sk = this.sketch.sketch;
    if (!sk) { toast(`${title}: open a sketch first (Create Sketch, or double-click a sketch in the Browser).`, 'warn', 4000); return; }
    const usable = sk.shapes.map((s, i) => i).filter((i) => need(sk.shapes[i].profile));
    if (!usable.length) { toast(needMsg || `${title}: draw a profile first.`, 'warn', 3500); return; }
    if (others && sk.shapes.length < 2 && others !== 'optional') { toast(`${title}: needs at least two profiles in the sketch.`, 'warn', 3500); return; }
    this.sketch.setTool(null);
    const label = (i) => `${i + 1} · ${PROFILE_LABEL[sk.shapes[i].profile.type]}`;
    const snapshot = structuredClone(sk.shapes);
    const pick = this.profileSel.find((p) => p.sketch === sk && usable.includes(p.index))?.index ?? usable[usable.length - 1];
    let added = [];
    const restore = () => { sk.shapes = structuredClone(snapshot); sk.selected.clear(); sk.rebuild(); bus.emit('sketch:changed'); };
    openDialog({
      title, subtitle: sk.name, help,
      fields: [{ key: 'i', label: 'Profile', type: 'select', value: String(pick), options: usable.map((i) => [String(i), label(i)]) }, ...fields(sk, label)],
      onChange: (v) => {
        sk.shapes = structuredClone(snapshot);
        const i = +v.i;
        added = apply(sk, i, v) || [];
        sk.selected = new Set([i]);
        sk.rebuild();
        bus.emit('sketch:changed');
      },
      onOk: () => {
        sk.selected.clear();
        sk.rebuild();
        this.sketch.markChanged(added);
        bus.emit('sketch:modify', { title });
      },
      onCancel: restore,
    });
  },

  sketchFilletDialog() {
    this._sketchDialog({
      title: 'Sketch Fillet', help: 'Rounds the corners of a rectangle, polygon or line profile.',
      need: (p) => ['rect', 'ngon', 'poly'].includes(p.type), needMsg: 'Sketch Fillet works on rectangles, polygons and line profiles.',
      fields: () => [{ key: 'r', label: 'Radius (mm)', type: 'number', value: 3, min: 0, step: 0.5 }],
      apply: (sk, i, v) => { sk.shapes[i].profile.fillet = v.r; },
    });
  },

  sketchOffsetDialog() {
    this._sketchDialog({
      title: 'Offset', help: 'Adds a copy of the profile that is bigger (positive) or smaller (negative) all round, like a wall outline.',
      need: isClosedProfile,
      fields: () => [{ key: 'd', label: 'Offset distance (mm)', type: 'number', value: 2, step: 0.5 }],
      apply: (sk, i, v) => {
        const copy = structuredClone(sk.shapes[i]);
        if (!offsetShape(copy, v.d)) return [];
        sk.shapes.push(copy);
        return [sk.shapes.length - 1];
      },
    });
  },

  sketchMirrorDialog() {
    this._sketchDialog({
      title: 'Sketch Mirror', help: 'Adds a mirrored copy of the profile on the other side of a sketch axis.',
      fields: () => [{ key: 'axis', label: 'Mirror line', type: 'select', value: 'v', options: [['v', 'Vertical axis (flip left/right)'], ['u', 'Horizontal axis (flip up/down)']] }],
      apply: (sk, i, v) => { const c = structuredClone(sk.shapes[i]); mirrorShape(c, v.axis); sk.shapes.push(c); return [sk.shapes.length - 1]; },
    });
  },

  sketchRectPatternDialog() {
    this._sketchDialog({
      title: 'Sketch Rectangular Pattern', help: 'Copies the profile in rows and columns inside the sketch.',
      fields: () => [
        { key: 'nx', label: 'Quantity (H)', type: 'number', value: 3, min: 1, max: 30, step: 1 },
        { key: 'sx', label: 'Spacing H (mm)', type: 'number', value: 20, step: 1 },
        { key: 'ny', label: 'Quantity (V)', type: 'number', value: 1, min: 1, max: 30, step: 1 },
        { key: 'sy', label: 'Spacing V (mm)', type: 'number', value: 20, step: 1 },
      ],
      apply: (sk, i, v) => {
        const out = [];
        for (let a = 0; a < Math.round(v.nx); a++) for (let b = 0; b < Math.round(v.ny); b++) {
          if (!a && !b) continue;
          const c = structuredClone(sk.shapes[i]);
          c.c = [c.c[0] + a * v.sx, c.c[1] + b * v.sy];
          sk.shapes.push(c); out.push(sk.shapes.length - 1);
        }
        return out;
      },
    });
  },

  sketchCircPatternDialog() {
    this._sketchDialog({
      title: 'Sketch Circular Pattern', help: 'Copies the profile around a centre point (the sketch origin or another profile’s centre), like bolt holes.',
      others: 'optional',
      fields: (sk, label) => [
        { key: 'n', label: 'Quantity', type: 'number', value: 6, min: 2, max: 60, step: 1 },
        { key: 'angle', label: 'Total angle (°)', type: 'number', value: 360, min: 1, max: 360, step: 15 },
        { key: 'center', label: 'Centre', type: 'select', value: 'origin', options: [['origin', 'Sketch origin'], ...sk.shapes.map((_, k) => [String(k), `Centre of ${label(k)}`])] },
      ],
      apply: (sk, i, v) => {
        const n = Math.round(v.n), full = v.angle >= 359.999, step = v.angle / (full ? n : n - 1);
        const ctr = v.center === 'origin' ? [0, 0] : [...sk.shapes[+v.center].c];
        const out = [];
        for (let k = 1; k < n; k++) { const c = structuredClone(sk.shapes[i]); rotateShapeAbout(c, step * k, ctr); sk.shapes.push(c); out.push(sk.shapes.length - 1); }
        return out;
      },
    });
  },

  sketchMoveDialog() {
    this._sketchDialog({
      title: 'Sketch Move/Copy', help: 'Moves or rotates a profile inside the sketch. Tick <b>Create copy</b> to keep the original.',
      fields: () => [
        { key: 'dx', label: 'Move H (mm)', type: 'number', value: 10, step: 1 },
        { key: 'dy', label: 'Move V (mm)', type: 'number', value: 0, step: 1 },
        { key: 'rot', label: 'Rotate (°)', type: 'number', value: 0, step: 15 },
        { key: 'copy', label: 'Create copy', type: 'checkbox', value: false },
      ],
      apply: (sk, i, v) => {
        const target = v.copy ? structuredClone(sk.shapes[i]) : sk.shapes[i];
        target.c = [target.c[0] + v.dx, target.c[1] + v.dy];
        if (v.rot) spinShape(target, v.rot);
        if (v.copy) { sk.shapes.push(target); return [sk.shapes.length - 1]; }
        return [];
      },
    });
  },

  sketchScaleDialog() {
    this._sketchDialog({
      title: 'Sketch Scale', help: 'Makes a profile bigger or smaller around its own centre (2 = double size).',
      fields: () => [{ key: 'k', label: 'Scale factor', type: 'number', value: 1.5, min: 0.05, max: 20, step: 0.1 }],
      apply: (sk, i, v) => { scaleShape(sk.shapes[i], v.k); },
    });
  },

  sketchDimensionDialog() {
    const sk = this.sketch.sketch;
    if (!sk) { toast('Sketch Dimension: open a sketch first.', 'warn'); return; }
    if (!sk.shapes.length) { toast('Sketch Dimension: draw a profile first.', 'warn'); return; }
    // one dialog per profile type, so the fields match the profile
    const pick = this.profileSel.find((p) => p.sketch === sk)?.index ?? sk.shapes.length - 1;
    const open = (idx) => (this.profileSel = [{ sketch: sk, index: idx }]) && this._sketchDialog({
      title: 'Sketch Dimension', help: 'Type exact sizes and the position of the profile centre from the sketch origin. Change the profile above to dimension another one.',
      fields: (s) => [
        ...profileDefs(s.shapes[idx].profile).map((d) => ({ ...d, value: round(getParam(s.shapes[idx].profile, d.key) ?? 0) })),
        { key: 'cu', label: 'Centre H (mm)', type: 'number', value: s.shapes[idx].c[0], step: 1 },
        { key: 'cv', label: 'Centre V (mm)', type: 'number', value: s.shapes[idx].c[1], step: 1 },
      ],
      apply: (s, i, v) => {
        if (i !== idx) { setTimeout(() => { closeDialog(false, 'user'); open(i); }, 0); return; }
        for (const d of profileDefs(s.shapes[i].profile)) if (v[d.key] !== undefined) setParam(s.shapes[i].profile, d.key, d.key === 'n' ? Math.max(3, Math.round(v[d.key])) : v[d.key]);
        s.shapes[i].c = [v.cu, v.cv];
      },
    });
    open(pick);
  },

  sketchConstraintDialog() {
    this._sketchDialog({
      title: 'Sketch Constraint', others: 'optional',
      help: 'Lines a profile up with another profile or the sketch origin. <small>In this learning version a constraint is applied once (it moves or resizes the profile) rather than being kept.</small>',
      fields: (sk, label) => [
        { key: 'type', label: 'Constraint', type: 'select', value: 'concentric', options: [
          ['concentric', 'Concentric / Coincident (same centre)'], ['horizontal', 'Horizontal (same height)'], ['vertical', 'Vertical (same H position)'],
          ['equal', 'Equal (same size)'], ['symmetric', 'Symmetric (about the vertical axis)'], ['parallel', 'Parallel (same rotation)'], ['fix-origin', 'Midpoint on origin'],
        ] },
        { key: 'other', label: 'Relative to', type: 'select', value: 'origin', options: [['origin', 'Sketch origin'], ...sk.shapes.map((_, k) => [String(k), label(k)])] },
      ],
      apply: (sk, i, v) => {
        const a = sk.shapes[i];
        const b = v.other === 'origin' ? { c: [0, 0], profile: null } : sk.shapes[+v.other];
        if (b === a) return;
        switch (v.type) {
          case 'concentric': a.c = [...b.c]; break;
          case 'fix-origin': a.c = [0, 0]; break;
          case 'horizontal': a.c[1] = b.c[1]; break;
          case 'vertical': a.c[0] = b.c[0]; break;
          case 'symmetric': a.c = [-b.c[0], b.c[1]]; if (b.profile && b.profile.type === a.profile.type) { a.profile = structuredClone(b.profile); mirrorShape({ c: [0, 0], profile: a.profile }, 'v'); } break;
          case 'equal':
            if (b.profile?.type === a.profile.type) for (const k of ['w', 'd', 'r', 'rx', 'ry', 'len', 'n']) { if (b.profile[k] !== undefined) a.profile[k] = b.profile[k]; }
            else this.setHint('⚠ Equal needs two profiles of the same type.');
            break;
          case 'parallel':
            if (b.profile) { a.profile.spin = b.profile.spin || 0; if (a.profile.type === 'ngon' && b.profile.type === 'ngon') a.profile.rot = b.profile.rot; } else a.profile.spin = 0;
            break;
        }
      },
    });
  },
});

// ---------- analysis materials ----------
const curvCache = new WeakMap();
function curvatureOf(geo) { let g = curvCache.get(geo); if (!g) { g = curvatureGeometry(geo); curvCache.set(geo, g); } return g; }

function analysisMaterial(a) {
  if (a.type === 'curvature') return new THREE.MeshLambertMaterial({ vertexColors: true });
  const vertex = `
    varying vec3 vN; varying vec3 vP;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vP = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  if (a.type === 'zebra') {
    return new THREE.ShaderMaterial({
      uniforms: { stripes: { value: a.stripes }, axis: { value: new THREE.Vector3(a.dir === 'x' ? 1 : 0, a.dir === 'y' ? 1 : 0, a.dir === 'z' ? 1 : 0) } },
      vertexShader: vertex,
      fragmentShader: `
        uniform float stripes; uniform vec3 axis; varying vec3 vN; varying vec3 vP;
        void main() {
          vec3 r = reflect(normalize(vP - cameraPosition), normalize(vN));
          float s = step(0.5, fract(dot(r, axis) * stripes * 0.5));
          gl_FragColor = vec4(vec3(0.08 + 0.85 * s), 1.0);
        }`,
    });
  }
  return new THREE.ShaderMaterial({
    uniforms: { pull: { value: new THREE.Vector3(a.pull === 'x' ? 1 : 0, a.pull === 'y' ? 1 : 0, a.pull === 'z' ? 1 : 0) }, limit: { value: Math.sin(rad(a.angle)) } },
    vertexShader: vertex,
    fragmentShader: `
      uniform vec3 pull; uniform float limit; varying vec3 vN; varying vec3 vP;
      void main() {
        vec3 n = normalize(vN);
        float d = dot(n, pull);
        vec3 c = d > limit + 1e-4 ? vec3(0.18, 0.62, 0.27) : (d < -limit - 1e-4 ? vec3(0.85, 0.21, 0.24) : vec3(0.95, 0.75, 0.1));
        float light = 0.55 + 0.45 * abs(dot(n, normalize(cameraPosition - vP)));
        gl_FragColor = vec4(c * light, 1.0);
      }`,
  });
}

// re-apply the analysis whenever bodies are rebuilt (undo, edits, new bodies)
export function installFeatureHooks(app) {
  bus.on('doc:changed', () => app.applyAnalysis());
}
