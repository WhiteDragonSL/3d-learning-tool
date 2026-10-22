import { footprint, rotXZ, PILLAR_RADIUS } from './enclosure.js';

// ---------------------------------------------------------------------------
// Automatic layout for IoT BoxGen: combines every selected component into one
// enclosure with room for wiring.
//
//  - Parts with a wall port / sensor window are turned so that side faces an
//    outside wall and placed flush against it (so the hole lines up). Front and
//    back walls hold rows of them, left and right walls hold columns.
//  - Everything else is packed in rows in the middle.
//  - `wiringGap` mm is kept between all parts, rows and columns; `headroom` mm
//    is added above the tallest part for cables; `padding` mm at bare walls.
//  - Which wall each port part goes on is chosen by a small search that keeps
//    the box footprint small and close to square (sensors start at the front,
//    boards and power at the back).
// ---------------------------------------------------------------------------
const WALLS = ['front', 'back', 'left', 'right'];
const WALL_NORMAL = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] };
const LOCAL_NORMAL = { front: [0, 1], back: [0, -1], right: [1, 0], left: [-1, 0] };

const wallPort = (def) => (def.cutouts || []).find((c) => c.side !== 'top');

// rotation (0/90/180/270) that turns a local side to face a world wall
function rotationFacing(side, wall) {
  const [lx, lz] = LOCAL_NORMAL[side], [wx, wz] = WALL_NORMAL[wall];
  for (const r of [0, 90, 180, 270]) {
    const [x, z] = rotXZ(lx, lz, r).map(Math.round);
    if (x === wx && z === wz) return r;
  }
  return 0;
}

// footprint of a part facing a wall: length along the wall and thickness into the box
function sizeOn(p, wall) {
  const f = footprint({ def: p.def, rot: rotationFacing(wallPort(p.def).side, wall) });
  return wall === 'front' || wall === 'back' ? { len: f.w, thick: f.d } : { len: f.d, thick: f.w };
}

// shelf-pack the middle parts into rows of about `target` mm
function pack(middle, g, target) {
  let x = 0, z = 0, shelf = 0, w = 0;
  const pos = new Map();
  for (const p of middle) {
    const f = footprint(p);
    if (x > 0 && x + f.w > target + 0.01) { x = 0; z += shelf + g; shelf = 0; }
    pos.set(p, [x + f.w / 2, z + f.d / 2]);
    x += f.w + g;
    w = Math.max(w, x - g);
    shelf = Math.max(shelf, f.d);
  }
  return { pos, w, d: middle.length ? z + shelf : 0 };
}

// size of the box (and everything needed to place the parts) for one wall assignment
function measure(s, ports, assign, middle) {
  const g = s.wiringGap, pad = s.padding;
  const ends = s.lid === 'screw' ? Math.max(pad, 2 * PILLAR_RADIUS + 1.5) : pad; // corners hold the screw pillars
  const walls = {};
  for (const w of WALLS) {
    const list = ports.filter((p) => assign.get(p) === w);
    const sizes = list.map((p) => sizeOn(p, w));
    walls[w] = { list, len: sizes.reduce((t, z) => t + z.len, 0) + g * Math.max(0, list.length - 1), thick: Math.max(0, ...sizes.map((z) => z.thick)) };
  }
  const { front: F, back: B, left: Lw, right: R } = walls;
  const sideX = (Lw.thick ? Lw.thick + g : ends) + (R.thick ? R.thick + g : ends);
  const area = middle.reduce((t, p) => { const f = footprint(p); return t + (f.w + g) * (f.d + g); }, 0);
  const target = Math.max(Math.max(F.len, B.len) + 2 * ends - sideX, Math.sqrt(area) * 1.15, ...middle.map((p) => footprint(p).w), 10);
  const block = pack(middle, g, target);
  const band = Math.max(block.d, Lw.len, R.len);
  const W = Math.max(F.len + 2 * ends, B.len + 2 * ends, sideX + block.w, 20);
  const segs = [B.thick, band, F.thick].filter((v) => v > 0);
  const D = Math.max(20, segs.reduce((a, b) => a + b, 0) + g * Math.max(0, segs.length - 1) + (B.thick ? 0 : ends) + (F.thick ? 0 : ends));
  return { W, D, walls, block, band, ends, g };
}

const score = (m) => m.W * m.D * (1 + 0.25 * (Math.max(m.W, m.D) / Math.min(m.W, m.D) - 1));

export function layoutParts(s) {
  const parts = s.parts;
  const ports = [], middle = [];
  for (const p of parts) {
    p.y = p.def.mount === 'standoff' ? s.standoffHeight : 0;
    if (wallPort(p.def)) ports.push(p); else { p.rot = 0; middle.push(p); }
  }
  middle.sort((a, b) => footprint(b).d - footprint(a).d || footprint(b).w - footprint(a).w);

  // start: sensors at the front, boards and power at the back; then improve by moving one part at a time
  const assign = new Map(ports.map((p) => [p, p.def.category === 'sensor' ? 'front' : 'back']));
  let best = measure(s, ports, assign, middle);
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (const p of ports) {
      let keep = assign.get(p);
      for (const w of WALLS) {
        if (w === keep) continue;
        const prev = keep;
        assign.set(p, w);
        const m = measure(s, ports, assign, middle);
        if (score(m) < score(best) - 1e-6) { best = m; keep = w; improved = true; } else assign.set(p, prev);
      }
      assign.set(p, keep);
    }
    if (!improved) break;
  }
  best = measure(s, ports, assign, middle);

  // place everything
  const { W, D, walls, block, band, ends, g } = best;
  for (const w of ['front', 'back']) {
    const sign = w === 'front' ? 1 : -1;
    let x = -walls[w].len / 2;
    for (const p of walls[w].list) {
      p.rot = rotationFacing(wallPort(p.def).side, w);
      const f = footprint(p);
      p.x = x + f.w / 2;
      p.z = sign * (D / 2 - f.d / 2);
      x += f.w + g;
    }
  }
  const z0 = -D / 2 + (walls.back.thick ? walls.back.thick + g : ends);
  const bandMid = z0 + band / 2;
  for (const w of ['left', 'right']) {
    const sign = w === 'right' ? 1 : -1;
    let z = bandMid - walls[w].len / 2;
    for (const p of walls[w].list) {
      p.rot = rotationFacing(wallPort(p.def).side, w);
      const f = footprint(p);
      p.x = sign * (W / 2 - f.w / 2);
      p.z = z + f.d / 2;
      z += f.d + g;
    }
  }
  const x0 = -W / 2 + (walls.left.thick ? walls.left.thick + g : ends);
  const x1 = W / 2 - (walls.right.thick ? walls.right.thick + g : ends);
  const bx = (x0 + x1) / 2 - block.w / 2, bz = bandMid - block.d / 2;
  for (const p of middle) { const [x, z] = block.pos.get(p); p.x = bx + x; p.z = bz + z; }

  const top = Math.max(0, ...parts.map((p) => p.y + p.def.dimensions.height));
  // sizes round up (never inwards) so flush parts can't end up a hair outside the wall
  s.inner.width = roundUp(W);
  s.inner.depth = roundUp(D);
  s.inner.height = roundUp(Math.max(12, top + s.headroom, s.lipHeight + 6));
}

const roundUp = (v) => Math.ceil(v * 10 - 1e-6) / 10;
