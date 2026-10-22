import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Pure geometry helpers (no app state): 2D point lists for sketch profiles and
// generators for swept, lofted and lathed solids. 2D points are [x, z] pairs
// in sketch space unless noted otherwise.
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

export function signedVolume(g) {
  const pos = g.attributes.position, idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}

// Welds vertices, turns every triangle outwards and adds creased normals.
export function finishSolid(g, creaseDeg = 30) {
  for (const n of Object.keys(g.attributes)) if (n !== 'position') g.deleteAttribute(n);
  g = mergeVertices(g, 1e-4);
  if (signedVolume(g) < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  return toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
}

// ---------- 2D point lists ----------
export function rotatePts(pts, rad) {
  if (!rad) return pts.map((p) => [...p]);
  const c = Math.cos(rad), s = Math.sin(rad);
  return pts.map(([x, z]) => [x * c - z * s, x * s + z * c]);
}

export function polygonArea(pts) {
  let a = 0;
  pts.forEach(([x1, z1], k) => { const [x2, z2] = pts[(k + 1) % pts.length]; a += x1 * z2 - x2 * z1; });
  return a / 2;
}

// Smooth curve through the points (centripetal Catmull-Rom, like a fit-point spline).
export function splinePoints(pts, closed, perSpan = 14) {
  if (pts.length < 2) return pts.map((p) => [...p]);
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'centripetal');
  const out = curve.getPoints(Math.max(8, pts.length * perSpan)).map((v) => [v.x, v.z]);
  if (closed) out.pop();
  return out;
}

// Arc through three points (open), sampled.
export function arcPoints(a, b, c, segs = 40) {
  const circ = circleFrom3(a, b, c);
  if (!circ) return [a, c].map((p) => [...p]);
  const [cx, cz] = circ.c;
  const ang = (p) => Math.atan2(p[1] - cz, p[0] - cx);
  const a0 = ang(a), a1 = ang(b), a2 = ang(c);
  const norm = (x) => ((x % TAU) + TAU) % TAU;
  // go from a to c through b
  let sweep = norm(a2 - a0);
  if (norm(a1 - a0) > sweep) sweep -= TAU;
  return Array.from({ length: segs + 1 }, (_, i) => {
    const t = a0 + (sweep * i) / segs;
    return [cx + Math.cos(t) * circ.r, cz + Math.sin(t) * circ.r];
  });
}

export function circleFrom3([ax, az], [bx, bz], [cx, cz]) {
  const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + az * az, b2 = bx * bx + bz * bz, c2 = cx * cx + cz * cz;
  const ux = (a2 * (bz - cz) + b2 * (cz - az) + c2 * (az - bz)) / d;
  const uz = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [ux, uz], r: Math.hypot(ax - ux, az - uz) };
}

// Rounds every corner of a closed polygon with radius r (clamped so arcs fit).
export function roundCorners(pts, r, segs = 8) {
  if (!(r > 0) || pts.length < 3) return pts.map((p) => [...p]);
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const l1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push([...p1]); continue; }
    const v1 = [(p0[0] - p1[0]) / l1, (p0[1] - p1[1]) / l1], v2 = [(p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2];
    const theta = Math.acos(Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1])));
    if (theta < 1e-3 || theta > Math.PI - 1e-3) { out.push([...p1]); continue; }
    let t = r / Math.tan(theta / 2);
    t = Math.min(t, l1 / 2, l2 / 2);
    const rr = t * Math.tan(theta / 2);
    const bis = [v1[0] + v2[0], v1[1] + v2[1]];
    const bl = Math.hypot(...bis);
    const h = rr / Math.sin(theta / 2);
    const c = [p1[0] + (bis[0] / bl) * h, p1[1] + (bis[1] / bl) * h];
    const A = [p1[0] + v1[0] * t, p1[1] + v1[1] * t], B = [p1[0] + v2[0] * t, p1[1] + v2[1] * t];
    let a0 = Math.atan2(A[1] - c[1], A[0] - c[0]), a1 = Math.atan2(B[1] - c[1], B[0] - c[0]);
    let d = a1 - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    for (let k = 0; k <= segs; k++) { const a = a0 + (d * k) / segs; out.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]); }
  }
  return out;
}

// Offsets a closed polygon by d (positive = outwards) with mitred corners.
export function offsetPolygon(pts, d) {
  const n = pts.length;
  const sign = polygonArea(pts) > 0 ? 1 : -1;
  const normal = (a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return [(sign * dz) / l, (-sign * dx) / l];
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[(i + n - 1) % n], p), n2 = normal(p, pts[(i + 1) % n]);
    return miter(p, n1, n2, d);
  });
}

function miter(p, n1, n2, d) {
  let m = [n1[0] + n2[0], n1[1] + n2[1]];
  const ml = Math.hypot(...m);
  if (ml < 1e-6) m = n1; else m = [m[0] / ml, m[1] / ml];
  const k = Math.min(4, 1 / Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]));
  return [p[0] + m[0] * d * k, p[1] + m[1] * d * k];
}

// Closed outline of an open polyline thickened to width t (used by Rib/Web).
export function thickenPolyline(pts, t) {
  const h = t / 2;
  const n = pts.length;
  const segN = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const n1 = i > 0 ? segN(pts[i - 1], pts[i]) : segN(pts[0], pts[1]);
    const n2 = i < n - 1 ? segN(pts[i], pts[i + 1]) : n1;
    left.push(miter(pts[i], n1, n2, h));
    right.push(miter(pts[i], n1, n2, -h));
  }
  return [...left, ...right.reverse()];
}

// ---------- 3D helpers ----------
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

function triangulate2D(pts2) {
  const contour = pts2.map(([x, y]) => new THREE.Vector2(x, y));
  return THREE.ShapeUtils.triangulateShape(contour, []);
}

// Newell normal of a closed 3D loop.
export function loopNormal(loop) {
  const n = new THREE.Vector3();
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

function loopCenter(loop) { return loop.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(loop.length); }

// Cap triangles for a (roughly planar) 3D loop: index triples into the loop.
function capTriangles(loop) {
  const n = loopNormal(loop);
  const u = Math.abs(n.y) < 0.9 ? v3(0, 1, 0).cross(n).normalize() : v3(1, 0, 0).cross(n).normalize();
  const w = n.clone().cross(u);
  return triangulate2D(loop.map((p) => [p.dot(u), p.dot(w)]));
}

// Evenly spaced points (by arc length) around a closed 3D loop.
export function resampleLoop(loop, m) {
  const n = loop.length;
  const seg = loop.map((p, i) => p.distanceTo(loop[(i + 1) % n]));
  const total = seg.reduce((a, b) => a + b, 0);
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < m; k++) {
    const target = (total * k) / m;
    while (i < n - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] > 0 ? (target - acc) / seg[i] : 0;
    out.push(loop[i].clone().lerp(loop[(i + 1) % n], t));
  }
  return out;
}

// Evenly spaced points along an open 3D polyline, plus the tangent at each.
export function samplePath(path, count) {
  const seg = path.slice(1).map((p, i) => p.distanceTo(path[i]));
  const total = seg.reduce((a, b) => a + b, 0);
  const out = [];
  for (let k = 0; k < count; k++) {
    const target = count === 1 ? 0 : (total * k) / (count - 1);
    let i = 0, acc = 0;
    while (i < seg.length - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const t = seg[i] > 0 ? Math.min(1, (target - acc) / seg[i]) : 0;
    out.push({ p: path[i].clone().lerp(path[i + 1], t), t: path[i + 1].clone().sub(path[i]).normalize() });
  }
  return { points: out, length: total };
}

// Loft: ruled surface through closed 3D loops (in order), capped at both ends.
export function loftGeometry(loops, m = 96) {
  const rings = loops.map((l) => resampleLoop(l, m));
  const n0 = loopNormal(rings[0]);
  for (let r = 1; r < rings.length; r++) {
    if (loopNormal(rings[r]).dot(n0) < 0) rings[r].reverse();
    // line the start points up so the surface doesn't twist
    const a = rings[r - 1], b = rings[r];
    const ca = loopCenter(a), cb = loopCenter(b);
    let best = 0, bestD = Infinity;
    for (let k = 0; k < m; k++) {
      let d = 0;
      for (let j = 0; j < m; j += 4) d += a[j].clone().sub(ca).distanceToSquared(b[(j + k) % m].clone().sub(cb));
      if (d < bestD) { bestD = d; best = k; }
    }
    rings[r] = [...b.slice(best), ...b.slice(0, best)];
  }
  const pos = [];
  const index = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < m; j++) {
      const a = r * m + j, b = r * m + ((j + 1) % m), c = (r + 1) * m + ((j + 1) % m), d = (r + 1) * m + j;
      index.push(a, b, c, a, c, d);
    }
  }
  for (const t of capTriangles(rings[0])) index.push(t[0], t[2], t[1]);
  const last = (rings.length - 1) * m;
  for (const t of capTriangles(rings[rings.length - 1])) index.push(last + t[0], last + t[1], last + t[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return finishSolid(g);
}

// Parallel-transport frames along a path (N, B perpendicular to the tangent).
function pathFrames(path, closed) {
  const n = path.length;
  const T = path.map((p, i) => {
    const a = closed ? path[(i + n - 1) % n] : path[Math.max(0, i - 1)];
    const b = closed ? path[(i + 1) % n] : path[Math.min(n - 1, i + 1)];
    return b.clone().sub(a).normalize();
  });
  const up = Math.abs(T[0].y) < 0.95 ? v3(0, 1, 0) : v3(1, 0, 0);
  const N = [up.clone().cross(T[0]).normalize()];
  for (let i = 1; i < n; i++) {
    const q = new THREE.Quaternion().setFromUnitVectors(T[i - 1], T[i]);
    N.push(N[i - 1].clone().applyQuaternion(q).normalize());
  }
  if (closed) {
    // spread the leftover twist so the seam joins up
    const back = N[n - 1].clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(T[n - 1], T[0]));
    const ang = Math.atan2(back.clone().cross(N[0]).dot(T[0]), back.dot(N[0]));
    for (let i = 0; i < n; i++) N[i].applyAxisAngle(T[i], (ang * i) / n);
  }
  return path.map((_, i) => ({ T: T[i], N: N[i], B: T[i].clone().cross(N[i]).normalize() }));
}

/**
 * Sweep a closed 2D section ([x, y] pairs) along a 3D path.
 * opts: closed (path is a loop), frames (custom [{N, B}]), twist (deg over the whole path), scaleEnd (taper).
 */
export function sweepGeometry(section, path, opts = {}) {
  const closed = !!opts.closed;
  const frames = opts.frames || pathFrames(path, closed);
  const n = path.length, m = section.length;
  const twist = THREE.MathUtils.degToRad(opts.twist || 0);
  const scaleEnd = opts.scaleEnd ?? 1;
  const pos = [];
  for (let i = 0; i < n; i++) {
    const f = i / Math.max(1, n - 1);
    const a = twist * f, c = Math.cos(a), s = Math.sin(a), k = 1 + (scaleEnd - 1) * f;
    const { N, B } = frames[i];
    // at a corner of the path, stretch the section across the bend (a mitre joint) so the wall keeps its thickness
    let bend = null, stretch = 1;
    const prev = closed ? path[(i + n - 1) % n] : i > 0 ? path[i - 1] : null;
    const next = closed ? path[(i + 1) % n] : i < n - 1 ? path[i + 1] : null;
    if (prev && next) {
      const t1 = path[i].clone().sub(prev).normalize(), t2 = next.clone().sub(path[i]).normalize();
      const cosHalf = t1.clone().add(t2).normalize().dot(t1);
      if (cosHalf < 0.9998 && cosHalf > 0.2) { bend = t2.clone().sub(t1).normalize(); stretch = 1 / cosHalf; }
    }
    for (const [x0, y0] of section) {
      const x = (x0 * c - y0 * s) * k, y = (x0 * s + y0 * c) * k;
      const off = N.clone().multiplyScalar(x).addScaledVector(B, y);
      if (bend) off.addScaledVector(bend, off.dot(bend) * (stretch - 1));
      const p = path[i].clone().add(off);
      pos.push(p.x, p.y, p.z);
    }
  }
  const index = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      index.push(i * m + j, i * m + j2, i2 * m + j2, i * m + j, i2 * m + j2, i2 * m + j);
    }
  }
  if (!closed) {
    const tris = triangulate2D(section);
    for (const t of tris) index.push(t[0], t[2], t[1]);
    const last = (n - 1) * m;
    for (const t of tris) index.push(last + t[0], last + t[1], last + t[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return finishSolid(g, opts.crease ?? 30);
}

export function circleSection(r, n = 24) {
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * TAU; return [Math.cos(a) * r, Math.sin(a) * r]; });
}

// Helix around +Y starting at height y0, with radial frames (N points outwards).
export function helix(radius, pitch, turns, y0 = 0, perTurn = 48) {
  const steps = Math.max(8, Math.round(turns * perTurn));
  const points = [], frames = [];
  const rise = pitch / TAU;
  for (let i = 0; i <= steps; i++) {
    const t = (turns * TAU * i) / steps;
    const c = Math.cos(t), s = Math.sin(t);
    points.push(v3(radius * c, y0 + rise * t, radius * s));
    const T = v3(-radius * s, rise, radius * c).normalize();
    const N = v3(c, 0, s);
    frames.push({ T, N, B: T.clone().cross(N).normalize() });
  }
  return { points, frames };
}

// Coil (spring): round wire swept along a helix, resting on the ground.
export function coilGeometry(p) {
  const section = Math.max(0.2, p.section);
  const pitch = Math.max(p.pitch, section * 1.05);
  const { points, frames } = helix(Math.max(section, p.diameter / 2), pitch, Math.max(0.25, p.turns), section / 2);
  return sweepGeometry(circleSection(section / 2, 20), points, { frames });
}

// Solid of revolution around +Y from an outline of [r, y] points that starts and ends on the axis.
export function latheSolid(outline, segs = 64) {
  const g = new THREE.LatheGeometry(outline.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), segs);
  return finishSolid(g);
}

// Box with every edge chamfered by c (45° bevels; three bevels meet in a point at each
// corner). Every face looks along an axis or an edge direction, so each face is the set
// of vertices furthest in that direction.
export function chamferBoxGeometry(w, h, d, c) {
  const W = w / 2, H = h / 2, D = d / 2;
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    pts.push(
      v3(sx * W, sy * (H - c), sz * (D - c)), v3(sx * (W - c), sy * H, sz * (D - c)), v3(sx * (W - c), sy * (H - c), sz * D),
      v3(sx * (W - c / 2), sy * (H - c / 2), sz * (D - c / 2)),
    );
  }
  const pos = [];
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const e of [-1, 0, 1]) {
    if (!a && !b && !e) continue;
    const n = v3(a, b, e).normalize();
    const s = Math.max(...pts.map((p) => n.dot(p)));
    const face = pts.filter((p) => Math.abs(n.dot(p) - s) < 1e-6);
    if (face.length < 3) continue;
    const ctr = loopCenter(face);
    const u = face[0].clone().sub(ctr).normalize(), w2 = n.clone().cross(u);
    const ang = (p) => { const q = p.clone().sub(ctr); return Math.atan2(q.dot(w2), q.dot(u)); };
    face.sort((p, q) => ang(p) - ang(q)); // counter-clockwise seen from outside
    for (let i = 1; i < face.length - 1; i++) for (const p of [face[0], face[i], face[i + 1]]) pos.push(p.x, p.y, p.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return g;
}

// Outline for a cylinder with rounded (fillet) or bevelled (chamfer) top and bottom edges.
export function cylinderOutline(R, H, fillet = 0, chamfer = 0) {
  const out = [[0, 0]];
  if (fillet > 0) {
    const f = Math.min(fillet, R - 0.01, H / 2 - 0.01);
    for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + (k / 8) * (Math.PI / 2); out.push([R - f + Math.cos(a) * f, f + Math.sin(a) * f]); }
    for (let k = 0; k <= 8; k++) { const a = (k / 8) * (Math.PI / 2); out.push([R - f + Math.cos(a) * f, H - f + Math.sin(a) * f]); }
  } else {
    const c = Math.min(chamfer, R - 0.01, H / 2 - 0.01);
    out.push([R - c, 0], [R, c], [R, H - c], [R - c, H]);
  }
  out.push([0, H]);
  return out;
}

// Volume and centre of mass of a closed (world-space) geometry.
export function massProperties(g) {
  const pos = g.attributes.position, idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0, area = 0;
  const cm = new THREE.Vector3();
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    const v = a.dot(b.clone().cross(c)) / 6;
    vol += v;
    cm.addScaledVector(a.clone().add(b).add(c), v / 4);
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  if (Math.abs(vol) > 1e-9) cm.divideScalar(vol);
  return { volume: Math.abs(vol), center: cm, area };
}

// Copy of a geometry with a per-vertex colour showing how strongly the surface curves.
export function curvatureGeometry(geo) {
  let g = geo.clone();
  for (const n of Object.keys(g.attributes)) if (n !== 'position') g.deleteAttribute(n);
  g = mergeVertices(g, 1e-3);
  g.computeVertexNormals();
  const pos = g.attributes.position, nrm = g.attributes.normal, idx = g.index.array;
  const sum = new Float32Array(pos.count), cnt = new Float32Array(pos.count);
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), na = new THREE.Vector3(), nb = new THREE.Vector3();
  const edge = (i, j) => {
    pa.fromBufferAttribute(pos, i); pb.fromBufferAttribute(pos, j);
    na.fromBufferAttribute(nrm, i); nb.fromBufferAttribute(nrm, j);
    const len = pa.distanceTo(pb);
    if (len < 1e-6) return;
    const k = na.angleTo(nb) / len;
    sum[i] += k; cnt[i]++; sum[j] += k; cnt[j]++;
  };
  for (let t = 0; t < idx.length; t += 3) { edge(idx[t], idx[t + 1]); edge(idx[t + 1], idx[t + 2]); edge(idx[t + 2], idx[t]); }
  const k = Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : 0));
  const sorted = [...k].sort((x, y) => x - y);
  const hi = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  k.forEach((v, i) => {
    const t = Math.min(1, v / (hi || 1));
    c.setHSL(0.66 * (1 - t), 0.85, 0.5); // blue = flat, red = tight curve
    col.set([c.r, c.g, c.b], i * 3);
  });
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
