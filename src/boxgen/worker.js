import { buildBase, buildLid } from './enclosure.js';

// Builds the enclosure Base + Lid off the main thread so the UI stays responsive
// while the boolean operations run.
self.onmessage = (e) => {
  const { id, state } = e.data;
  try {
    const t0 = performance.now();
    const pack = (g) => ({ position: g.attributes.position.array, normal: g.attributes.normal.array });
    const base = pack(buildBase(state)), lid = pack(buildLid(state));
    self.postMessage({ id, base, lid, ms: performance.now() - t0 }, [base.position.buffer, base.normal.buffer, lid.position.buffer, lid.normal.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
