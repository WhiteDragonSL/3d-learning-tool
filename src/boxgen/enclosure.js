import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { latheSolid } from '../geometry.js';

// ---------------------------------------------------------------------------
// Parametric enclosure geometry for IoT BoxGen.
// Enclosure coordinates: X = width, Z = depth (+Z = front wall), Y up, origin at
// the centre of the inner floor surface. The base floor spans y = -wall..0 and its
// walls rise to y = inner height H; the lid plate sits on top (y = H..H+wall) with
// an inset lip that drops inside the walls.
// ---------------------------------------------------------------------------
const PILLAR_R = 3.5;      // corner screw pillar radius (M3)
const PILOT_R = 1.25;      // self-tapping pilot hole in the pillar
const LID_HOLE_R = 1.7;    // M3 clearance hole in the lid
const SNAP_DIST = 10;      // a port this close to a wall gets a cutout
const LIP_T = 1.5;         // lid lip wall thickness

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

// ---------- small helpers ----------
export const rotXZ = (x, z, deg) => {
  const a = THREE.MathUtils.degToRad(deg), c = Math.round(Math.cos(a) * 1e6) / 1e6, s = Math.round(Math.sin(a) * 1e6) / 1e6;
  return [x * c + z * s, -x * s + z * c];
};

// width/depth of a part's footprint after its 90° rotation
export function footprint(part) {
  const { width, depth } = part.def.dimensions;
  return (part.rot / 90) % 2 ? { w: depth, d: width } : { w: width, d: depth };
}

function clean(g) {
  let out = g.index ? g.toNonIndexed() : g;
  for (const n of Object.keys(out.attributes)) if (n !== 'position' && n !== 'normal') out.deleteAttribute(n);
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

function roundedRect(w, d, r) {
  const x = w / 2, y = d / 2;
  r = Math.max(0.05, Math.min(r, x - 0.05, y - 0.05));
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y); s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r); s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y); s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r); s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// vertical prism of a shape between y0 and y1
function prism(shape, y0, y1) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return clean(g);
}

function cylinder(r, y0, y1, x, z, r2 = r, segs = 24) {
  const g = new THREE.CylinderGeometry(r2, r, y1 - y0, segs);
  g.translate(x, (y0 + y1) / 2, z);
  return clean(g);
}

function box(sx, sy, sz, cx, cy, cz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  return clean(g);
}

function csg(a, b, op) {
  const A = new Brush(a), B = new Brush(b);
  A.updateMatrixWorld(); B.updateMatrixWorld();
  return clean(evaluator.evaluate(A, B, op).geometry);
}
const merge = (list) => (list.length ? mergeGeometries(list.map(clean)) : null);

// ---------- layout facts shared by base, lid and the UI ----------
export function innerCornerRadius(s) { return Math.max(0.3, s.radius - s.wall); }
export function lipHeight(s) { return Math.min(s.lipHeight, s.inner.height * 0.4); }

// centres of the four corner screw pillars (tucked into the rounded inner corners)
export function pillarCenters(s) {
  if (s.lid !== 'screw') return [];
  const { width: W, depth: D } = s.inner;
  const ri = innerCornerRadius(s);
  const k = ri > PILLAR_R ? (ri - PILLAR_R + 0.5) / Math.SQRT2 : 0;
  const cx = ri > PILLAR_R ? W / 2 - ri + k : W / 2 - PILLAR_R + 0.5;
  const cz = ri > PILLAR_R ? D / 2 - ri + k : D / 2 - PILLAR_R + 0.5;
  return [[cx, cz], [-cx, cz], [cx, -cz], [-cx, -cz]];
}
export const PILLAR_RADIUS = PILLAR_R;

const SIDES = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] };

// Every cutout of every part with where it lands: which wall, how far away, and whether it is cut.
export function cutoutPlacements(s) {
  const out = [];
  for (const part of s.parts) {
    const { width, depth } = part.def.dimensions;
    for (const c of part.def.cutouts || []) {
      if (c.side === 'top') {
        const [ox, oz] = rotXZ(c.offset || 0, c.offsetY || 0, part.rot);
        out.push({ part, cutout: c, wall: 'lid', cut: true, x: part.x + ox, z: part.z + oz });
        continue;
      }
      const ln = SIDES[c.side];
      const half = c.side === 'front' || c.side === 'back' ? depth / 2 : width / 2;
      const lt = c.side === 'front' || c.side === 'back' ? [1, 0] : [0, 1];
      const lp = [ln[0] * half + lt[0] * (c.offset || 0), ln[1] * half + lt[1] * (c.offset || 0)];
      const [nx, nz] = rotXZ(ln[0], ln[1], part.rot).map(Math.round);
      const [tx, tz] = rotXZ(lt[0], lt[1], part.rot).map(Math.round);
      const [px, pz] = rotXZ(lp[0], lp[1], part.rot);
      const x = part.x + px, z = part.z + pz;
      const wall = nx === 1 ? 'right' : nx === -1 ? 'left' : nz === 1 ? 'front' : 'back';
      const wallPos = nx ? s.inner.width / 2 : s.inner.depth / 2;
      const edge = (nx ? part.x * nx : part.z * nz) + half;
      const gap = wallPos - edge;
      out.push({ part, cutout: c, wall, n: [nx, nz], t: [tx, tz], x, z, y: part.y + (c.offsetY || 0), edge, gap, cut: gap <= SNAP_DIST && gap > -half });
    }
  }
  return out;
}

// ---------- base ----------
export function buildBase(s) {
  const { width: W, depth: D, height: H } = s.inner;
  const t = s.wall, cl = s.clearance;
  const ri = innerCornerRadius(s);
  let base = csg(prism(roundedRect(W + 2 * t, D + 2 * t, s.radius), -t, H), prism(roundedRect(W, D, ri), 0, H + 1), SUBTRACTION);

  const adds = [], cuts = [];
  // corner screw pillars with pilot holes
  for (const [x, z] of pillarCenters(s)) {
    adds.push(cylinder(PILLAR_R, -0.5, H, x, z));
    cuts.push(cylinder(PILOT_R, Math.max(1, H - 12), H + 1, x, z, PILOT_R, 20));
  }
  for (const part of s.parts) {
    for (const so of part.def.standoffs || []) {
      const [ox, oz] = rotXZ(so.x, so.z, part.rot);
      const x = part.x + ox, z = part.z + oz, hole = so.holeDiameter || 3;
      if (part.def.mount === 'standoff' && part.y >= 0.8) {
        adds.push(cylinder(Math.max(hole / 2 + 1.6, 2.6), -0.5, part.y, x, z, undefined, 28));
        cuts.push(cylinder(hole * 0.85 / 2, 0.8, part.y + 1, x, z, undefined, 20));
      } else if (part.def.mount === 'floor') {
        cuts.push(cylinder(hole / 2, -t - 1, 0.5, x, z, undefined, 20));
      }
    }
  }
  // port and sensor cutouts in the walls
  for (const p of cutoutPlacements(s)) {
    if (p.wall === 'lid' || !p.cut) continue;
    const c = p.cutout;
    const L = p.gap + t + 3, along = p.edge - 1 + L / 2;
    const [nx, nz] = p.n;
    const cx = nx ? nx * along : p.x, cz = nz ? nz * along : p.z;
    if (c.shape === 'circle') {
      const g = new THREE.CylinderGeometry(c.width / 2 + cl, c.width / 2 + cl, L, 40);
      if (nx) g.rotateZ(Math.PI / 2); else g.rotateX(Math.PI / 2);
      g.translate(cx, p.y, cz);
      cuts.push(clean(g));
    } else {
      const wt = c.width + 2 * cl, ht = (c.height || c.width) + 2 * cl;
      cuts.push(box(nx ? L : wt, ht, nz ? L : wt, cx, p.y, cz));
    }
  }
  // ventilation slots in the left and right walls
  if (s.vents) {
    const lip = lipHeight(s);
    const vh = Math.min(25, (H - lip) * 0.55);
    if (vh >= 3) {
      const n = Math.max(1, Math.floor((D * 0.6) / 4.5));
      for (let i = 0; i < n; i++) {
        const z = (i - (n - 1) / 2) * 4.5;
        for (const side of [-1, 1]) cuts.push(box(t + 3, vh, 2, side * (W / 2 + t / 2), (H - lip) / 2, z));
      }
    }
  }
  if (adds.length) base = csg(base, merge(adds), ADDITION);
  if (cuts.length) base = csg(base, merge(cuts), SUBTRACTION);
  return base;
}

// ---------- lid ----------
export function buildLid(s) {
  const { width: W, depth: D, height: H } = s.inner;
  const t = s.wall, tol = s.tolerance, cl = s.clearance;
  const ri = innerCornerRadius(s);
  const lip = lipHeight(s);
  let lid = prism(roundedRect(W + 2 * t, D + 2 * t, s.radius), H, H + t);

  // inset lip that slides inside the walls (tolerance all round)
  const lt = Math.min(LIP_T, (Math.min(W, D) - 2 * tol) / 4);
  const ring = roundedRect(W - 2 * tol, D - 2 * tol, ri - tol);
  ring.holes.push(roundedRect(W - 2 * tol - 2 * lt, D - 2 * tol - 2 * lt, Math.max(0.3, ri - tol - lt)));
  lid = csg(lid, prism(ring, H - lip, H + 0.2), ADDITION);

  // Cutters that overlap each other make the boolean slow and messy, so the lip
  // clearance around the pillars goes first, then holes and openings.
  const pillars = pillarCenters(s);
  if (pillars.length) lid = csg(lid, merge(pillars.map(([x, z]) => cylinder(PILLAR_R + tol + 0.3, H - lip - 1, H - 0.05, x, z))), SUBTRACTION);
  const cuts = [];
  for (const [x, z] of pillars) {
    // screw hole + countersink as one solid of revolution
    const top = H + t + 0.6, cs = Math.min(1.6, t * 0.6);
    const g = latheSolid([[0, top], [3.3 + 0.6, top], [3.3, H + t], [LID_HOLE_R, H + t - cs], [LID_HOLE_R, H - 0.5], [0, H - 0.5]], 24);
    g.translate(x, 0, z);
    cuts.push(clean(g));
  }
  for (const p of cutoutPlacements(s)) {
    if (p.wall !== 'lid') continue;
    const c = p.cutout;
    if (c.shape === 'circle') cuts.push(cylinder(c.width / 2 + cl, H - lip - 1, H + t + 1, p.x, p.z, undefined, 40));
    else {
      const swap = (p.part.rot / 90) % 2;
      const a = c.width + 2 * cl, b = (c.height || c.width) + 2 * cl;
      cuts.push(box(swap ? b : a, lip + t + 2, swap ? a : b, p.x, H + (t - lip) / 2, p.z));
    }
  }
  if (cuts.length) lid = csg(lid, merge(cuts), SUBTRACTION);
  return lid;
}

// Copies laid flat for printing: base on its floor, lid upside down on its top face.
export function printReady(geo, kind) {
  const g = geo.clone();
  if (kind === 'lid') g.rotateX(Math.PI);
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  return g;
}
