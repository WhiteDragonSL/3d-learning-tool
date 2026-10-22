import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { bus } from './events.js';
import {
  signedVolume, rotatePts, roundCorners, splinePoints, polygonArea, coilGeometry, latheSolid, chamferBoxGeometry, cylinderOutline,
} from './geometry.js';

// ---------------------------------------------------------------------------
// Body kinds and their editable parameters (all sizes in millimetres).
// Every body's geometry is built so that its local origin is the centre of its
// base: "Position Y = 0" means the body sits on the ground grid.
// ---------------------------------------------------------------------------
export const KIND_LABEL = {
  box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', cone: 'Cone', torus: 'Torus', coil: 'Coil', extrude: 'Extrude', revolve: 'Revolve', mesh: 'Body',
};

export const PROFILE_LABEL = {
  rect: 'Rectangle', circle: 'Circle', ngon: 'Polygon', poly: 'Line profile', ellipse: 'Ellipse', slot: 'Slot', spline: 'Spline', path: 'Open path',
};

// Open paths (lines/arcs/splines that don't close) can't be extruded, but they
// can guide Sweep, Pipe, Rib and Pattern on Path.
export const isClosedProfile = (p) => p.type !== 'path';

// ---------------------------------------------------------------------------
// Planes. A "frame" places a 2D sketch in 3D: origin `o` and rotation `q`.
// In frame-local space the plane is X/Z and the plane normal is +Y, exactly
// like the ground grid, so all 2D code works the same on every plane.
// ---------------------------------------------------------------------------
export const IDENTITY_FRAME = { o: [0, 0, 0], q: [0, 0, 0, 1] };

export const ORIGIN_PLANES = {
  XZ: { label: 'XZ plane (ground)', normal: [0, 1, 0], color: 0x2f9e44 },
  XY: { label: 'XY plane (front)', normal: [0, 0, 1], color: 0x1c6fd1 },
  YZ: { label: 'YZ plane (side)', normal: [1, 0, 0], color: 0xd9363e },
};

// Builds a frame for a plane with normal `n` passing through `point`.
// The in-plane X axis is kept horizontal where possible so grids line up with the world.
export function frameFromNormal(n, point = new THREE.Vector3()) {
  const N = new THREE.Vector3(...(n.isVector3 ? n.toArray() : n)).normalize();
  const X = Math.abs(N.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(N).normalize();
  const Z = X.clone().cross(N).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, N, Z));
  const o = N.clone().multiplyScalar(N.dot(point));
  return { o: o.toArray(), q: q.toArray() };
}

export function frameMatrix(frame) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...frame.o), new THREE.Quaternion(...frame.q), new THREE.Vector3(1, 1, 1));
}
export function frameNormal(frame) {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...frame.q));
}

// Name of the world axis a direction points along, e.g. "+X", or null.
export function axisName(v) {
  const a = [['X', v.x], ['Y', v.y], ['Z', v.z]].find(([, c]) => Math.abs(Math.abs(c) - 1) < 1e-3);
  return a ? (a[1] > 0 ? '+' : '−') + a[0] : null;
}

export const DEFAULT_PARAMS = {
  box: { width: 20, height: 20, depth: 20, fillet: 0, chamfer: 0 },
  cylinder: { radius: 10, height: 20, fillet: 0, chamfer: 0 },
  sphere: { radius: 10 },
  cone: { radius: 10, topRadius: 0, height: 20 },
  torus: { radius: 12, tube: 3 },
  coil: { diameter: 30, pitch: 8, turns: 4, section: 4 },
};

const num = (key, label, min = 0.1) => ({ key, label, type: 'number', min, step: 1 });

export function paramDefs(kind, params = {}) {
  switch (kind) {
    case 'box': return [num('width', 'Width (X)'), num('height', 'Height (Y)'), num('depth', 'Depth (Z)'), num('fillet', 'Fillet radius', 0), num('chamfer', 'Chamfer distance', 0)];
    case 'cylinder': return [num('radius', 'Radius'), num('height', 'Height'), num('fillet', 'Edge fillet', 0), num('chamfer', 'Edge chamfer', 0)];
    case 'sphere': return [num('radius', 'Radius')];
    case 'cone': return [num('radius', 'Base radius'), num('topRadius', 'Top radius', 0), num('height', 'Height')];
    case 'torus': return [num('radius', 'Ring radius'), num('tube', 'Tube radius')];
    case 'coil': return [num('diameter', 'Diameter'), num('pitch', 'Pitch'), { key: 'turns', label: 'Revolutions', type: 'number', min: 0.25, max: 60, step: 0.5 }, num('section', 'Section size')];
    case 'extrude': {
      const defs = profileDefs(params.profile || {}, 'profile.');
      defs.push(num('height', 'Extrude distance'), { key: 'taper', label: 'Taper angle (°)', type: 'number', min: -40, max: 40, step: 1 });
      return defs;
    }
    case 'revolve':
      return [...profileDefs(params.profile || {}, 'profile.'), { key: 'angle', label: 'Angle (°)', type: 'number', min: 1, max: 360, step: 15 }];
    default: return [];
  }
}

// Editable sizes of a 2D profile (prefix "profile." when it sits inside body params).
export function profileDefs(p, prefix = '') {
  const spin = { key: prefix + 'spin', label: 'Rotation (°)', type: 'number', min: -360, max: 360, step: 5 };
  const fillet = num(prefix + 'fillet', 'Corner fillet', 0);
  switch (p.type) {
    case 'rect': return [num(prefix + 'w', 'Width'), num(prefix + 'd', 'Height'), fillet, spin];
    case 'circle': return [num(prefix + 'r', 'Radius')];
    case 'ngon': return [num(prefix + 'r', 'Radius'), { key: prefix + 'n', label: 'Sides', type: 'number', min: 3, max: 32, step: 1 }, fillet];
    case 'ellipse': return [num(prefix + 'rx', 'Major radius'), num(prefix + 'ry', 'Minor radius'), spin];
    case 'slot': return [num(prefix + 'len', 'Centre distance', 0), num(prefix + 'r', 'End radius'), spin];
    case 'poly': return [fillet, spin];
    case 'spline': case 'path': return [spin];
    default: return [];
  }
}

export function getParam(params, key) {
  return key.split('.').reduce((o, k) => (o ? o[k] : undefined), params);
}
export function setParam(params, key, value) {
  const keys = key.split('.');
  let o = params;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

export function profileShape(profile) {
  const shape = new THREE.Shape();
  // Sketches live on the ground (X/Z). Shape space is X/Y, so sketch Z maps to -Y.
  if (profile.type === 'circle') {
    shape.absarc(0, 0, profile.r, 0, Math.PI * 2, false);
  } else {
    profilePoints(profile).forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    shape.closePath();
  }
  return shape;
}

// Outline points of a profile, relative to its centre (sketch X/Z). Curves are
// sampled; corner fillets and the rotation (spin, degrees) are applied.
export function profilePoints(profile) {
  const ring = (n, fx, fz) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * fx, Math.sin(a) * fz]; });
  let pts;
  switch (profile.type) {
    case 'ngon': {
      const n = Math.max(3, Math.round(profile.n || 6)), a0 = profile.rot ?? -Math.PI / 2;
      pts = Array.from({ length: n }, (_, i) => {
        const a = a0 + (i / n) * Math.PI * 2;
        return [Math.cos(a) * profile.r, Math.sin(a) * profile.r];
      });
      break;
    }
    case 'rect': {
      const w = profile.w / 2, d = profile.d / 2;
      pts = [[-w, -d], [w, -d], [w, d], [-w, d]];
      break;
    }
    case 'circle': return ring(64, profile.r, profile.r);
    case 'ellipse': pts = ring(72, profile.rx, profile.ry); break;
    case 'slot': {
      const h = Math.max(0.01, profile.len || 0) / 2, r = profile.r;
      const half = (cx, a0) => Array.from({ length: 17 }, (_, i) => { const a = a0 + (i / 16) * Math.PI; return [cx + Math.cos(a) * r, Math.sin(a) * r]; });
      pts = [...half(h, -Math.PI / 2), ...half(-h, Math.PI / 2)];
      break;
    }
    case 'spline': pts = splinePoints(profile.pts, true); break;
    case 'path': pts = profile.curve === 'spline' ? splinePoints(profile.pts, false) : profile.pts.map((p) => [...p]); break;
    default: pts = profile.pts.map((p) => [...p]);
  }
  if (profile.fillet > 0 && ['rect', 'ngon', 'poly'].includes(profile.type)) pts = roundCorners(pts, profile.fillet);
  if (profile.spin) pts = rotatePts(pts, THREE.MathUtils.degToRad(profile.spin));
  return pts;
}

function taperGeometry(g, start, taperDeg) {
  if (!taperDeg) return;
  // Shrink (or grow) the profile linearly with height, like Fusion's taper angle.
  const t = Math.tan(THREE.MathUtils.degToRad(taperDeg));
  const pos = g.attributes.position;
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const halfSize = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 || 1;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) - start;
    const s = Math.max(0.02, 1 - (y * t) / halfSize);
    pos.setX(i, pos.getX(i) * s);
    pos.setZ(i, pos.getZ(i) * s);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
}

// Revolve: spins a profile around one of the sketch's in-plane axes, or around
// any line in the sketch plane (axis 'line', axisLine = { o: [u, v], d: [du, dv] }, e.g. a construction axis).
// p = { profile, c: [u, v] (profile centre in sketch coords), axis: 'u' | 'v' | 'line', angle }
// The geometry is built in sketch space (origin = sketch origin, plane = X/Z).
// Sketch point (u, v) as [distance from the axis, position along it].
function axisCoords(axis, line, u, v) {
  if (axis === 'line') {
    const du = u - line.o[0], dv = v - line.o[1], [a, b] = line.d;
    return [b * du - a * dv, a * du + b * dv];
  }
  return axis === 'v' ? [u, v] : [v, u];
}

export function profileCrossesAxis(profile, c, axis, axisLine) {
  const coord = profilePoints(profile).map(([x, z]) => axisCoords(axis, axisLine, x + c[0], z + c[1])[0]);
  return Math.min(...coord) < -1e-6 && Math.max(...coord) > 1e-6;
}

export function revolveGeometry(p) {
  const { profile, c, axis } = p;
  const angle = THREE.MathUtils.degToRad(Math.min(360, Math.max(1, p.angle ?? 360)));
  // (radius, height) outline; LatheGeometry spins it around its own Y axis
  let pts = profilePoints(profile).map(([x, z]) => axisCoords(axis, p.axisLine, x + c[0], z + c[1]));
  const side = Math.sign(pts.reduce((s, [r]) => s + r, 0)) || 1;
  pts = pts.map(([r, h]) => new THREE.Vector2(Math.abs(r), h));
  pts.push(pts[0].clone());
  const phi0 = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  const full = angle >= Math.PI * 2 - 1e-6;
  let g = new THREE.LatheGeometry(pts, 96, phi0, full ? Math.PI * 2 : angle);
  if (!full) {
    // close the open ends with flat caps so the result is a solid
    const shape = new THREE.Shape(pts.slice(0, -1));
    const capA = new THREE.ShapeGeometry(shape);
    capA.rotateY(phi0 - Math.PI / 2);
    const capB = new THREE.ShapeGeometry(shape);
    capB.rotateY(phi0 + angle - Math.PI / 2);
    g = mergeGeometries([g.toNonIndexed(), capA.toNonIndexed(), capB.toNonIndexed()]);
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  // orient so every triangle faces outwards (positive signed volume)
  if (signedVolume(g) < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  // lathe Y axis -> chosen sketch axis
  if (axis === 'u') g.rotateZ(-Math.PI / 2);
  else g.rotateX(Math.PI / 2);
  if (axis === 'line') {
    // x = distance from the axis, z = along it -> sketch space
    const [a, b] = p.axisLine.d;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(b, 0, -a), new THREE.Vector3(0, 1, 0), new THREE.Vector3(a, 0, b));
    m.setPosition(p.axisLine.o[0], 0, p.axisLine.o[1]);
    g.applyMatrix4(m);
  }
  // smooth curved surfaces, but keep sharp edges where caps and flat sides meet
  return toCreasedNormals(g, THREE.MathUtils.degToRad(30));
}

export function buildGeometry(kind, p) {
  let g;
  switch (kind) {
    case 'box': {
      const maxR = Math.min(p.width, p.height, p.depth) / 2 - 0.01;
      const r = Math.min(p.fillet || 0, maxR);
      const c = Math.min(p.chamfer || 0, maxR);
      if (r > 0.05) g = new RoundedBoxGeometry(p.width, p.height, p.depth, 5, r);
      else if (c > 0.05) return chamferBoxGeometry(p.width, p.height, p.depth, c);
      else g = new THREE.BoxGeometry(p.width, p.height, p.depth);
      g.translate(0, p.height / 2, 0);
      break;
    }
    case 'cylinder':
      if ((p.fillet || 0) > 0.05 || (p.chamfer || 0) > 0.05) return latheSolid(cylinderOutline(p.radius, p.height, p.fillet || 0, p.chamfer || 0));
      g = new THREE.CylinderGeometry(p.radius, p.radius, p.height, 64);
      g.translate(0, p.height / 2, 0);
      break;
    case 'coil':
      return coilGeometry(p);
    case 'cone':
      g = p.topRadius > 0.01
        ? new THREE.CylinderGeometry(p.topRadius, p.radius, p.height, 64)
        : new THREE.ConeGeometry(p.radius, p.height, 64);
      g.translate(0, p.height / 2, 0);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(p.radius, 64, 32);
      g.translate(0, p.radius, 0);
      break;
    case 'torus':
      g = new THREE.TorusGeometry(p.radius, p.tube, 24, 72);
      g.rotateX(Math.PI / 2);
      g.translate(0, p.tube, 0);
      break;
    case 'extrude':
      // local origin = profile centre on the sketch plane; extrusion runs along +Y from `start`
      g = new THREE.ExtrudeGeometry(profileShape(p.profile), { depth: p.height, bevelEnabled: false, curveSegments: 48 });
      g.rotateX(-Math.PI / 2);
      if (p.start) g.translate(0, p.start, 0);
      taperGeometry(g, p.start || 0, p.taper || 0);
      break;
    case 'revolve':
      g = revolveGeometry(p);
      break;
    default:
      throw new Error('Unknown kind ' + kind);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------
export const MATERIALS = {
  plastic: { label: 'Plastic', metalness: 0.0, roughness: 0.45 },
  metal: { label: 'Metal', metalness: 0.85, roughness: 0.3 },
  rubber: { label: 'Rubber', metalness: 0.0, roughness: 0.95 },
  glass: { label: 'Glass', metalness: 0.1, roughness: 0.05, opacity: 0.4 },
};
// MODIFY > Physical Material: density in g/cm³ (used for mass), plus a matching look.
export const PHYSICAL_MATERIALS = {
  steel: { label: 'Steel', density: 7.85, color: '#9aa3ad', look: 'metal' },
  stainless: { label: 'Stainless Steel', density: 8.0, color: '#c3c8ce', look: 'metal' },
  aluminium: { label: 'Aluminium', density: 2.7, color: '#d5d9de', look: 'metal' },
  brass: { label: 'Brass', density: 8.5, color: '#d4b45c', look: 'metal' },
  copper: { label: 'Copper', density: 8.96, color: '#c87f4f', look: 'metal' },
  titanium: { label: 'Titanium', density: 4.5, color: '#8f969c', look: 'metal' },
  abs: { label: 'ABS Plastic', density: 1.05, color: '#e8e4d8', look: 'plastic' },
  pla: { label: 'PLA', density: 1.24, color: '#7fb3e0', look: 'plastic' },
  nylon: { label: 'Nylon', density: 1.14, color: '#f2efe6', look: 'plastic' },
  acrylic: { label: 'Acrylic (clear)', density: 1.18, color: '#cfe8f5', look: 'glass' },
  glass: { label: 'Glass', density: 2.5, color: '#d8eef5', look: 'glass' },
  rubber: { label: 'Rubber', density: 1.1, color: '#3a3d42', look: 'rubber' },
  oak: { label: 'Wood (Oak)', density: 0.75, color: '#b98a55', look: 'plastic' },
  concrete: { label: 'Concrete', density: 2.4, color: '#a6a39b', look: 'rubber' },
};

const PALETTE = ['#b8c4d0', '#7fb3e0', '#f2b46b', '#9fd49b', '#e89aa5', '#c3a6e8', '#f2dc6b', '#86d0c8'];
let paletteIdx = 0;
export const nextColor = () => PALETTE[paletteIdx++ % PALETTE.length];

function makeMaterial(color, kind) {
  const m = MATERIALS[kind] || MATERIALS.plastic;
  return new THREE.MeshStandardMaterial({
    color, metalness: m.metalness, roughness: m.roughness,
    transparent: m.opacity !== undefined, opacity: m.opacity ?? 1,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    side: THREE.FrontSide,
  });
}

// Sharp-edge lines for the CAD look. Unlike THREE.EdgesGeometry this welds
// vertices by position and ignores edges with only one neighbouring face, so
// the T-junctions left by boolean operations don't show as stray lines.
function featureEdges(geo, angleDeg = 28) {
  const pos = geo.attributes.position;
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  const keyOf = (i) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  const vid = new Map();
  const ids = [];
  const verts = [];
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    if (!vid.has(k)) { vid.set(k, verts.length / 3); verts.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    ids.push(vid.get(k));
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edges = new Map();
  for (let t = 0; t < triCount; t++) {
    const v = [0, 1, 2].map((j) => ids[index ? index.getX(t * 3 + j) : t * 3 + j]);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    a.fromArray(verts, v[0] * 3); b.fromArray(verts, v[1] * 3); c.fromArray(verts, v[2] * 3);
    const n = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
    for (let j = 0; j < 3; j++) {
      const p = v[j], q = v[(j + 1) % 3];
      const k = p < q ? `${p}_${q}` : `${q}_${p}`;
      const e = edges.get(k);
      if (e) e.normals.push(n); else edges.set(k, { p, q, normals: [n] });
    }
  }
  const cos = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const out = [];
  for (const { p, q, normals } of edges.values()) {
    if (normals.length < 2) continue;
    if (normals[0].dot(normals[1]) < cos) out.push(...verts.slice(p * 3, p * 3 + 3), ...verts.slice(q * 3, q * 3 + 3));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

// ---------------------------------------------------------------------------
// Body: one solid in the design.
// ---------------------------------------------------------------------------
let nextId = 1;

export class Body {
  constructor({ id, name, kind, params, geometry, color, material = 'plastic', physical = 'steel', visible = true, position, rotation, scale }) {
    this.id = id ?? nextId++;
    nextId = Math.max(nextId, this.id + 1);
    this.name = name;
    this.kind = kind;
    this.params = params ? structuredClone(params) : {};
    this.color = color || nextColor();
    this.material = material;
    this.physical = physical; // PHYSICAL_MATERIALS key (density for mass)
    this.visible = visible;

    const geo = geometry || buildGeometry(kind, this.params);
    this.mesh = new THREE.Mesh(geo, makeMaterial(this.color, material));
    this.mesh.userData.body = this;
    this.edges = new THREE.LineSegments(featureEdges(geo), new THREE.LineBasicMaterial({ color: 0x2a2f36, transparent: true, opacity: 0.55 }));
    this.edges.raycast = () => {};
    this.mesh.add(this.edges);
    if (position) this.mesh.position.fromArray(position);
    if (rotation) this.mesh.rotation.fromArray(rotation);
    if (scale) this.mesh.scale.fromArray(scale);
    this.mesh.visible = visible;
    this.selected = false;
    this.overlapping = false;
  }

  get geometry() { return this.mesh.geometry; }

  setGeometry(geo) {
    this.mesh.geometry = geo;
    this.edges.geometry.dispose();
    this.edges.geometry = featureEdges(geo);
  }

  rebuild() {
    if (this.kind === 'mesh') return;
    this.setGeometry(buildGeometry(this.kind, this.params));
  }

  setAppearance(color, material) {
    if (color) this.color = color;
    if (material) this.material = material;
    this.mesh.material.dispose();
    this.mesh.material = makeMaterial(this.color, this.material);
    this.refreshHighlight();
  }

  setVisible(v) { this.visible = v; this.mesh.visible = v; }

  refreshHighlight() {
    const m = this.mesh.material;
    if (this.selected) m.emissive.set(0x1d4ed8), (m.emissiveIntensity = 0.4);
    else if (this.overlapping) m.emissive.set(0xd9363e), (m.emissiveIntensity = 0.55);
    else m.emissive.set(0x000000);
    this.edges.material.color.set(this.selected ? 0x2f6bff : 0x2a2f36);
    this.edges.material.opacity = this.selected ? 1 : 0.55;
  }

  worldBox() {
    this.mesh.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.mesh, true);
  }

  toState() {
    return {
      id: this.id, name: this.name, kind: this.kind, params: structuredClone(this.params), geometry: this.geometry,
      color: this.color, material: this.material, physical: this.physical, visible: this.visible,
      position: this.mesh.position.toArray(), rotation: this.mesh.rotation.toArray().slice(0, 3), scale: this.mesh.scale.toArray(),
    };
  }

  dispose() {
    this.mesh.material.dispose();
    this.edges.geometry.dispose();
    this.edges.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sketch: a set of closed 2D profiles lying on one plane (an origin plane, a
// construction plane or a flat face of a body). Each closed shape is a
// "profile" that can be extruded or revolved. Like Fusion 360, a sketch is
// hidden once one of its profiles has been used by a feature.
// ---------------------------------------------------------------------------
const SKETCH_GREEN = 0x2f9e44;
const SKETCH_BLUE = 0x2f6bff;
const SKETCH_LIFT = 0.06; // just above the plane so profiles don't flicker on faces

export class Sketch {
  constructor({ id, name, frame, planeName = 'XZ', shapes, visible = true, profile, center }) {
    this.id = id ?? nextId++;
    nextId = Math.max(nextId, this.id + 1);
    this.isSketch = true;
    this.name = name;
    this.frame = structuredClone(frame || IDENTITY_FRAME);
    this.planeName = planeName;
    // older files stored one profile + a ground position
    this.shapes = structuredClone(shapes || (profile ? [{ profile, c: [center[0], center[2]] }] : []));
    this.visible = visible;
    this.selected = new Set(); // indices of selected profiles
    this.object = new THREE.Group();
    this.object.position.fromArray(this.frame.o);
    this.object.quaternion.fromArray(this.frame.q);
    this.object.visible = visible;
    this.rebuild();
  }

  get normal() { return frameNormal(this.frame); }

  // sketch-local (u, v) -> world point
  toWorld(u, v, lift = 0) {
    return new THREE.Vector3(u, lift, v).applyQuaternion(this.object.quaternion).add(this.object.position);
  }

  rebuild() {
    for (const c of [...this.object.children]) {
      this.object.remove(c);
      c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.items = this.shapes.map((s, i) => {
      const g = new THREE.Group();
      g.position.set(s.c[0], SKETCH_LIFT, s.c[1]);
      if (!isClosedProfile(s.profile)) {
        // open path: just a line, nothing to click
        const pts = profilePoints(s.profile).map(([x, z]) => new THREE.Vector3(x, 0, z));
        const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: SKETCH_GREEN, transparent: true }));
        outline.renderOrder = 4;
        outline.raycast = () => {};
        g.add(outline);
        this.object.add(g);
        return { group: g, fill: null, outline };
      }
      const shape = profileShape(s.profile);
      const fillGeo = new THREE.ShapeGeometry(shape, 48);
      fillGeo.rotateX(-Math.PI / 2);
      const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
        color: SKETCH_GREEN, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false,
      }));
      fill.userData = { sketch: this, index: i };
      fill.renderOrder = 3;
      const pts = shape.getPoints(64).map((p) => new THREE.Vector3(p.x, 0, -p.y));
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: SKETCH_GREEN, transparent: true }));
      outline.renderOrder = 4;
      outline.raycast = () => {};
      g.add(fill, outline);
      this.object.add(g);
      return { group: g, fill, outline };
    });
    this.refreshHighlight();
  }

  addShape(profile, c) { this.shapes.push({ profile: structuredClone(profile), c: [...c] }); this.rebuild(); return this.shapes.length - 1; }
  removeShape(i) { this.shapes.splice(i, 1); this.selected.clear(); this.rebuild(); }
  get fills() { return this.items.map((it) => it.fill).filter(Boolean); }

  shapeSize(i) {
    const p = this.shapes[i].profile;
    if (p.type === 'rect' && !p.spin) return [p.w, p.d];
    if (p.type === 'circle') return [p.r * 2, p.r * 2];
    const pts = profilePoints(p), xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
    return [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)];
  }

  shapeArea(i) {
    const p = this.shapes[i].profile;
    if (!isClosedProfile(p)) return 0;
    if (p.type === 'circle') return Math.PI * p.r * p.r;
    return Math.abs(polygonArea(profilePoints(p)));
  }

  // indices of the closed profiles (open paths can't be extruded)
  get profileIndices() { return this.shapes.map((s, i) => (isClosedProfile(s.profile) ? i : -1)).filter((i) => i >= 0); }
  get pathIndices() { return this.shapes.map((s, i) => (isClosedProfile(s.profile) ? -1 : i)).filter((i) => i >= 0); }

  // a shape's outline in world space (closed loops leave out the repeated first point)
  worldOutline(i) {
    const s = this.shapes[i];
    return profilePoints(s.profile).map(([x, z]) => this.toWorld(x + s.c[0], z + s.c[1]));
  }

  setVisible(v) { this.visible = v; this.object.visible = v; if (!v) this.selected.clear(); }

  refreshHighlight() {
    this.items?.forEach((it, i) => {
      const sel = this.selected.has(i);
      const c = sel ? SKETCH_BLUE : SKETCH_GREEN;
      it.outline.material.color.set(c);
      if (!it.fill) return;
      it.fill.material.color.set(c);
      it.fill.material.opacity = sel ? 0.32 : 0.14;
    });
  }

  toState() {
    return { id: this.id, name: this.name, frame: structuredClone(this.frame), planeName: this.planeName, shapes: structuredClone(this.shapes), visible: this.visible };
  }

  dispose() {
    this.object.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }
}

// ---------------------------------------------------------------------------
// Construction plane (CONSTRUCT > Offset Plane): a reference plane to sketch on.
// ---------------------------------------------------------------------------
export class ConstructionPlane {
  constructor({ id, name, frame, base = 'XZ', offset = 0, visible = true }) {
    this.id = id ?? nextId++;
    nextId = Math.max(nextId, this.id + 1);
    this.isPlane = true;
    this.name = name;
    this.frame = structuredClone(frame);
    this.base = base;
    this.offset = offset;
    this.visible = visible;
    this.object = makePlaneMesh(0xf28c28, 90);
    this.object.position.fromArray(frame.o);
    this.object.quaternion.fromArray(frame.q);
    this.object.visible = visible;
    this.object.children[0].userData.plane = this;
  }

  setVisible(v) { this.visible = v; this.object.visible = v; }
  toState() { return { id: this.id, name: this.name, frame: structuredClone(this.frame), base: this.base, offset: this.offset, visible: this.visible }; }
  dispose() { this.object.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
}

// Construction axis: an infinite line (shown 200 mm long) through `o` along `d`.
export class ConstructionAxis {
  constructor({ id, name, o, d, visible = true }) {
    this.id = id ?? nextId++;
    nextId = Math.max(nextId, this.id + 1);
    this.isAxis = true;
    this.name = name;
    this.o = [...o];
    this.d = new THREE.Vector3(...d).normalize().toArray();
    this.visible = visible;
    const O = new THREE.Vector3(...this.o), D = new THREE.Vector3(...this.d).multiplyScalar(100);
    this.object = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([O.clone().sub(D), O.clone().add(D)]),
      new THREE.LineDashedMaterial({ color: 0xf28c28, dashSize: 5, gapSize: 2.5, transparent: true }),
    );
    this.object.computeLineDistances();
    this.object.raycast = () => {};
    this.object.visible = visible;
  }

  get origin() { return new THREE.Vector3(...this.o); }
  get dir() { return new THREE.Vector3(...this.d); }
  setVisible(v) { this.visible = v; this.object.visible = v; }
  toState() { return { id: this.id, name: this.name, o: [...this.o], d: [...this.d], visible: this.visible }; }
  dispose() { this.object.geometry.dispose(); this.object.material.dispose(); }
}

// Construction point: a reference point (used for planes and axes through points).
export class ConstructionPoint {
  constructor({ id, name, p, visible = true }) {
    this.id = id ?? nextId++;
    nextId = Math.max(nextId, this.id + 1);
    this.isPoint = true;
    this.name = name;
    this.p = [...p];
    this.visible = visible;
    this.object = new THREE.Mesh(new THREE.OctahedronGeometry(1.4), new THREE.MeshBasicMaterial({ color: 0xf28c28, depthTest: false }));
    this.object.renderOrder = 8;
    this.object.position.fromArray(p);
    this.object.userData.cpoint = this;
    this.object.visible = visible;
  }

  get point() { return new THREE.Vector3(...this.p); }
  setVisible(v) { this.visible = v; this.object.visible = v; }
  toState() { return { id: this.id, name: this.name, p: [...this.p], visible: this.visible }; }
  dispose() { this.object.geometry.dispose(); this.object.material.dispose(); }
}

// Translucent square with a border, lying in local X/Z (normal +Y).
export function makePlaneMesh(color, size) {
  const g = new THREE.Group();
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  fill.renderOrder = 2;
  const h = size / 2;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(x, 0, z))),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  border.raycast = () => {};
  g.add(fill, border);
  return g;
}

// ---------------------------------------------------------------------------
// Document: bodies, sketches and construction planes, plus the timeline
// (undo history). Every finished action calls commit(), which stores a snapshot.
// ---------------------------------------------------------------------------
const AUTOSAVE_KEY = 'minicad-autosave';

export class Doc {
  constructor(scene) {
    this.group = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.planeGroup = new THREE.Group();
    scene.add(this.group, this.sketchGroup, this.planeGroup);
    this.name = 'Untitled';
    this.bodies = [];
    this.sketches = [];
    this.planes = [];
    this.axes = [];
    this.points = [];
    this.history = [];
    this.index = -1;
    this.counters = {};
    this.commit('Start', 'start');
    // don't overwrite the previous session's autosave with this empty start state
    clearTimeout(this._saveTimer);
  }

  newName(kind) {
    this.counters[kind] = (this.counters[kind] || 0) + 1;
    const label = {
      sketch: 'Sketch', plane: 'Plane', axis: 'Axis', point: 'Point', loft: 'Loft', sweep: 'Sweep', pipe: 'Pipe', rib: 'Rib', split: 'Split',
    }[kind] || KIND_LABEL[kind];
    return `${label}${this.counters[kind]}`;
  }

  get(id) { return this.bodies.find((b) => b.id === id); }
  getSketch(id) { return this.sketches.find((s) => s.id === id); }
  getPlane(id) { return this.planes.find((p) => p.id === id); }

  add(body) {
    this.bodies.push(body);
    this.group.add(body.mesh);
    return body;
  }

  remove(body) {
    this.bodies = this.bodies.filter((b) => b !== body);
    this.group.remove(body.mesh);
    body.dispose();
  }

  addSketch(sketch) {
    this.sketches.push(sketch);
    this.sketchGroup.add(sketch.object);
    return sketch;
  }

  removeSketch(sketch) {
    this.sketches = this.sketches.filter((s) => s !== sketch);
    this.sketchGroup.remove(sketch.object);
    sketch.dispose();
  }

  addPlane(plane) {
    this.planes.push(plane);
    this.planeGroup.add(plane.object);
    return plane;
  }

  removePlane(plane) {
    this.planes = this.planes.filter((p) => p !== plane);
    this.planeGroup.remove(plane.object);
    plane.dispose();
  }

  addAxis(axis) { this.axes.push(axis); this.planeGroup.add(axis.object); return axis; }
  removeAxis(axis) { this.axes = this.axes.filter((a) => a !== axis); this.planeGroup.remove(axis.object); axis.dispose(); }
  addPoint(pt) { this.points.push(pt); this.planeGroup.add(pt.object); return pt; }
  removePoint(pt) { this.points = this.points.filter((p) => p !== pt); this.planeGroup.remove(pt.object); pt.dispose(); }

  // all construction geometry (planes, axes, points)
  get construction() { return [...this.planes, ...this.axes, ...this.points]; }
  getConstruct(id) { return this.construction.find((c) => c.id === id); }
  removeConstruct(c) { if (c.isPlane) this.removePlane(c); else if (c.isAxis) this.removeAxis(c); else this.removePoint(c); }

  #removeAll() {
    for (const b of [...this.bodies]) this.remove(b);
    for (const s of [...this.sketches]) this.removeSketch(s);
    for (const c of this.construction) this.removeConstruct(c);
  }

  #addConstruction(entry) {
    for (const p of entry.planes || []) this.addPlane(new ConstructionPlane(p));
    for (const a of entry.axes || []) this.addAxis(new ConstructionAxis(a));
    for (const p of entry.points || []) this.addPoint(new ConstructionPoint(p));
  }

  #snapshot() {
    return {
      state: this.bodies.map((b) => b.toState()),
      sketches: this.sketches.map((s) => s.toState()),
      planes: this.planes.map((p) => p.toState()),
      axes: this.axes.map((a) => a.toState()),
      points: this.points.map((p) => p.toState()),
    };
  }

  commit(label, iconName = 'body') {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push({ label, icon: iconName, counters: { ...this.counters }, ...this.#snapshot() });
    this.index = this.history.length - 1;
    bus.emit('doc:changed', { label });
    this.autosave();
  }

  #restore(entry) {
    this.#removeAll();
    for (const s of entry.state) this.add(new Body(s));
    for (const s of entry.sketches || []) this.addSketch(new Sketch(s));
    this.#addConstruction(entry);
    this.counters = { ...entry.counters };
  }

  goto(i) {
    if (i < 0 || i >= this.history.length || i === this.index) return;
    this.index = i;
    this.#restore(this.history[i]);
    bus.emit('doc:changed', { restored: true });
    this.autosave();
  }

  undo() { if (this.index > 0) { this.goto(this.index - 1); bus.emit('undo'); } }
  redo() { if (this.index < this.history.length - 1) { this.goto(this.index + 1); bus.emit('redo'); } }

  clear() {
    this.#removeAll();
    this.name = 'Untitled';
    this.history = [];
    this.index = -1;
    this.counters = {};
    this.commit('Start', 'start');
  }

  get isEmpty() { return !this.bodies.length && !this.sketches.length && !this.construction.length; }

  // ---------- save / load ----------
  toJSON() {
    return {
      app: 'MiniCAD Learn', version: 3, name: this.name, counters: this.counters,
      bodies: this.bodies.map((b) => {
        const s = b.toState();
        s.geometry = b.kind === 'mesh' ? b.geometry.toJSON() : null;
        return s;
      }),
      sketches: this.sketches.map((s) => s.toState()),
      planes: this.planes.map((p) => p.toState()),
      axes: this.axes.map((a) => a.toState()),
      points: this.points.map((p) => p.toState()),
    };
  }

  load(json) {
    if (!json || !Array.isArray(json.bodies)) throw new Error('Not a MiniCAD file');
    const loader = new THREE.BufferGeometryLoader();
    this.#removeAll();
    for (const s of json.bodies) {
      this.add(new Body({ ...s, geometry: s.geometry ? loader.parse(s.geometry) : undefined }));
    }
    for (const s of json.sketches || []) this.addSketch(new Sketch(s));
    this.#addConstruction(json);
    this.name = json.name || 'Untitled';
    this.counters = json.counters || {};
    this.history = [];
    this.index = -1;
    this.commit('Open file', 'open');
  }

  autosave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...this.toJSON(), savedAt: Date.now() })); } catch { /* storage full or blocked */ }
    }, 400);
  }

  // What the last autosave contains, without loading it (null if nothing saved).
  peekAutosave() {
    try {
      const json = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
      const bodies = json?.bodies?.length || 0, sketches = json?.sketches?.length || 0;
      return bodies || sketches ? { bodies, sketches, name: json.name || 'Untitled', savedAt: json.savedAt || null } : null;
    } catch { return null; }
  }

  // the raw autosave (for "download a copy" before it is replaced)
  autosaveBlob() {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? new Blob([raw], { type: 'application/json' }) : null;
  }

  restoreAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return false;
      const json = JSON.parse(raw);
      if (!json.bodies?.length && !json.sketches?.length) return false;
      this.load(json);
      this.history[0].label = 'Restored session';
      return true;
    } catch { return false; }
  }
}

