import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { computeMeshVolume } from 'three-bvh-csg';
import { MeshBVH } from 'three-mesh-bvh';
import { Body, buildGeometry } from './model.js';

export const OPS = { join: ADDITION, cut: SUBTRACTION, intersect: INTERSECTION };

function flipWinding(g) {
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.index.needsUpdate = true;
  } else {
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      for (let i = 0; i < a.count; i += 3) {
        for (let c = 0; c < a.itemSize; c++) {
          const t = a.array[(i + 1) * a.itemSize + c];
          a.array[(i + 1) * a.itemSize + c] = a.array[(i + 2) * a.itemSize + c];
          a.array[(i + 2) * a.itemSize + c] = t;
        }
      }
      a.needsUpdate = true;
    }
  }
}

// Copy of a body's geometry with its position/rotation/scale baked in.
export function worldGeometry(body, extraMatrix) {
  body.mesh.updateMatrixWorld(true);
  const m = body.mesh.matrixWorld.clone();
  if (extraMatrix) m.premultiply(extraMatrix);
  const g = body.geometry.clone();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  g.clearGroups();
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  return g;
}

// Moves geometry so its base-centre is at the origin; returns where that point was.
export function recenter(g) {
  g.computeBoundingBox();
  const b = g.boundingBox;
  const origin = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
  g.translate(-origin.x, -origin.y, -origin.z);
  return origin;
}

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

// Boolean operation. Returns a new 'mesh' body (not yet added to the doc).
export function combine(target, tools, opName, doc) {
  let result = new Brush(worldGeometry(target));
  result.updateMatrixWorld();
  for (const tool of tools) {
    const b = new Brush(worldGeometry(tool));
    b.updateMatrixWorld();
    result = evaluator.evaluate(result, b, OPS[opName]);
  }
  const geo = result.geometry;
  const posCount = geo.attributes.position?.count || 0;
  if (posCount === 0) return null;
  const origin = recenter(geo);
  return new Body({
    id: target.id, name: target.name, kind: 'mesh', geometry: geo, color: target.color, material: target.material, physical: target.physical,
    position: origin.toArray(),
  });
}

export function mirrorBody(body, plane, doc) {
  const s = { YZ: [-1, 1, 1], XY: [1, 1, -1], XZ: [1, -1, 1] }[plane];
  const m = new THREE.Matrix4().makeScale(...s);
  const geo = worldGeometry(body, m);
  const origin = recenter(geo);
  return new Body({
    name: doc.newName('mesh'), kind: 'mesh', geometry: geo, color: body.color, material: body.material, position: origin.toArray(),
  });
}

export function cloneBody(body, doc, offset = [0, 0, 0]) {
  const s = body.toState();
  delete s.id;
  s.name = doc.newName(body.kind);
  s.position = s.position.map((v, i) => v + offset[i]);
  if (body.kind === 'mesh') s.geometry = body.geometry; // geometry is never mutated, safe to share
  else delete s.geometry;
  return new Body(s);
}

// Copy of a body rotated by `angle` (radians) around a world axis through `pivot` (default: the origin).
export function rotatedClone(body, doc, axis, angle, pivot = new THREE.Vector3()) {
  const c = cloneBody(body, doc);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  c.mesh.position.sub(pivot).applyQuaternion(q).add(pivot);
  c.mesh.quaternion.premultiply(q);
  return c;
}

// New 'mesh' body from world-space geometry (resting point = base centre).
export function meshBody(geo, name, look = {}) {
  const origin = recenter(geo);
  return new Body({ name, kind: 'mesh', geometry: geo, color: look.color, material: look.material, physical: look.physical, position: origin.toArray() });
}

// Split Body: the parts of a body on each side of a plane (world normal n through point p).
export function splitBody(body, n, p, doc) {
  const size = body.worldBox().getSize(new THREE.Vector3()).length() * 4 + 100;
  const half = (sign) => {
    const g = new THREE.BoxGeometry(size, size, size);
    g.translate(0, (sign * size) / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().normalize());
    const tool = new Body({ kind: 'mesh', name: 'split-tool', geometry: g });
    tool.mesh.quaternion.copy(q);
    tool.mesh.position.copy(p);
    const r = combine(body, [tool], 'intersect');
    tool.dispose();
    return r;
  };
  const a = half(1), b = half(-1);
  if (!a || !b) return null;
  // the second half becomes a new body
  const s = b.toState();
  delete s.id;
  s.name = doc.newName('split');
  b.dispose();
  return [a, new Body(s)];
}

// Shell: hollows a Box, Cylinder or Sphere with walls of thickness t,
// optionally leaving the top open. Returns a new combined body, or null.
export const SHELLABLE = ['box', 'cylinder', 'sphere'];

export function shellBody(body, t, openTop) {
  const p = body.params;
  let inner;
  if (body.kind === 'box') {
    const h = openTop ? p.height - t + 1 : p.height - 2 * t;
    inner = buildGeometry('box', { width: p.width - 2 * t, height: h, depth: p.depth - 2 * t, fillet: Math.max(0, (p.fillet || 0) - t) });
  } else if (body.kind === 'cylinder') {
    inner = buildGeometry('cylinder', { radius: p.radius - t, height: openTop ? p.height - t + 1 : p.height - 2 * t });
  } else if (body.kind === 'sphere') {
    inner = buildGeometry('sphere', { radius: p.radius - t });
  } else return null;
  inner.translate(0, t, 0);
  const tool = new Body({ kind: 'mesh', name: 'shell-tool', geometry: inner });
  tool.mesh.position.copy(body.mesh.position);
  tool.mesh.quaternion.copy(body.mesh.quaternion);
  tool.mesh.scale.copy(body.mesh.scale);
  const result = combine(body, [tool], 'cut');
  tool.dispose();
  return result;
}

// Body from an STL file (already parsed geometry), resting on the ground.
export function meshBodyFromGeometry(geometry, name) {
  for (const n of Object.keys(geometry.attributes)) if (n !== 'position' && n !== 'normal') geometry.deleteAttribute(n);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  recenter(geometry);
  return new Body({ name, kind: 'mesh', geometry, position: [0, 0, 0] });
}

export function volumeOf(body) {
  body.mesh.updateMatrixWorld(true);
  try { return Math.abs(computeMeshVolume(body.mesh)); } catch { return NaN; }
}

// Pairs of visible bodies that really overlap (touching is allowed).
// Bounding boxes (Box3) are a fast first test; pairs that pass are checked
// precisely with a BVH: do their triangles cross, or is one inside the other?
export function findOverlaps(bodies) {
  const tol = 0.05;
  const list = bodies.filter((b) => b.visible).map((b) => ({ b, box: b.worldBox().expandByScalar(-tol) }));
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].box.intersectsBox(list[j].box) && preciseOverlap(list[i].b, list[j].b)) pairs.push([list[i].b, list[j].b]);
    }
  }
  return pairs;
}

// cached per geometry (geometries are never edited in place, a rebuild makes a new one)
const bvhCache = new WeakMap();
const bvhOf = (geo) => { let b = bvhCache.get(geo); if (!b) { b = new MeshBVH(geo); bvhCache.set(geo, b); } return b; };

// world matrix of a body, shrunk very slightly about its centre so faces that only touch don't count
function shrunkMatrix(body) {
  body.mesh.updateMatrixWorld(true);
  const box = body.worldBox();
  const c = box.getCenter(new THREE.Vector3());
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-3);
  const k = Math.max(0.5, 1 - 0.1 / size);
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
    .multiply(body.mesh.matrixWorld);
}

function pointInside(body, worldPoint) {
  const inv = body.mesh.matrixWorld.clone().invert();
  const ray = new THREE.Ray(worldPoint.clone().applyMatrix4(inv), new THREE.Vector3(0.5773, 0.5774, 0.5775).normalize());
  const hits = bvhOf(body.geometry).raycast(ray, THREE.DoubleSide).map((h) => h.distance).sort((a, b) => a - b);
  let n = 0, last = -1;
  for (const d of hits) { if (d - last > 1e-4) n++; last = d; } // merge duplicate hits on shared edges
  return n % 2 === 1;
}

function firstVertex(body, matrix) {
  return new THREE.Vector3().fromBufferAttribute(body.geometry.attributes.position, 0).applyMatrix4(matrix);
}

export function preciseOverlap(a, b) {
  try {
    const mA = shrunkMatrix(a), mB = shrunkMatrix(b);
    const aToB = b.mesh.matrixWorld.clone().invert().multiply(mA);
    if (bvhOf(b.geometry).intersectsGeometry(a.geometry, aToB)) return true;
    return pointInside(b, firstVertex(a, mA)) || pointInside(a, firstVertex(b, mB));
  } catch (err) {
    console.warn('precise overlap test failed, using bounding boxes', err);
    return true;
  }
}
