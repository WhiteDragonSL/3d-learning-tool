import * as THREE from 'three';
import { bus } from '../events.js';
import { KIND_LABEL, PROFILE_LABEL, MATERIALS, PHYSICAL_MATERIALS, paramDefs, profileDefs, getParam } from '../model.js';
import { volumeOf } from '../ops.js';
import { round } from './dialog.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMass = (g) => (g >= 1000 ? `${round(g / 1000, 3)} kg` : `${round(g, 2)} g`);

// Properties of the current selection (a body, several bodies, or sketch profiles).
export function buildProps(app) {
  const el = document.getElementById('props');

  const wire = (handler) => {
    for (const input of el.querySelectorAll('[data-field]')) {
      input.addEventListener('change', () => handler(input.dataset.field, input));
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    }
  };
  const act = (a, fn) => { const b = el.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
  const num = (input) => { const v = parseFloat(input.value); return Number.isFinite(v) ? v : null; };

  const render = () => {
    const focusKey = el.contains(document.activeElement) ? document.activeElement.dataset.field : null;
    if (app.sketch.active) renderSketching();
    else if (app.profileSel.length) renderProfiles();
    else if (app.selection.length > 1) renderMany();
    else if (app.selection.length === 1) renderBody(app.selection[0]);
    else {
      el.innerHTML = `<div class="props-info">Nothing selected.<br><br>
        • Click a body or a sketch profile to select it.<br>• <kbd>Shift</kbd>+click to select more.<br>
        • Left-drag: orbit · Right-drag: pan · Wheel: zoom.<br>• <b>Right-click</b> for the marking menu, <kbd>S</kbd> to search commands.</div>`;
    }
    if (focusKey) el.querySelector(`[data-field="${focusKey}"]`)?.focus();
  };

  const renderSketching = () => {
    const s = app.sketch.sketch;
    el.innerHTML = `<div class="props-info"><b>Editing ${esc(s.name)}</b> on ${esc(s.planeName)}<br>${s.shapes.length} profile${s.shapes.length === 1 ? '' : 's'}.<br><br>
      Draw with the SKETCH tools. While drawing, type numbers for exact sizes (<kbd>Tab</kbd> switches width/height, <kbd>Enter</kbd> confirms).<br><br>
      <kbd>Ctrl</kbd>+<kbd>Z</kbd> removes the last profile. Click <b>FINISH SKETCH</b> when done.</div>`;
  };

  const renderMany = () => {
    const sel = app.selection;
    el.innerHTML = `<div class="props-info"><b>${sel.length} bodies selected</b><br>Target (first): ${esc(sel[0].name)}<br>
      Tools: ${sel.slice(1).map((b) => esc(b.name)).join(', ')}</div>
      <div class="props-actions">
        <button class="btn small" data-a="combine">Combine…</button>
        <button class="btn small" data-a="mirror">Mirror…</button>
        <button class="btn small" data-a="appearance">Appearance…</button>
        <button class="btn small" data-a="dup">Copy</button>
        <button class="btn small danger" data-a="del">Delete</button>
      </div>`;
    act('combine', () => app.combineDialog());
    act('mirror', () => app.mirrorDialog());
    act('appearance', () => app.appearanceDialog());
    act('dup', () => app.duplicate());
    act('del', () => app.deleteSelection());
  };

  const renderBody = (b) => {
    const m = b.mesh;
    const box = b.worldBox();
    const size = box.getSize(new THREE.Vector3());
    const vol = volumeOf(b);
    const defs = paramDefs(b.kind, b.params);
    const deg = (r) => round(THREE.MathUtils.radToDeg(r), 1);
    const xyz = (prefix, vals) => `<div class="xyz">${['x', 'y', 'z'].map((a, i) =>
      `<span class="${a}">${a.toUpperCase()}</span><input type="number" step="any" data-field="${prefix}${i}" value="${vals[i]}">`).join('')}</div>`;
    el.innerHTML = `
      <div class="props-section">
        <div class="field"><label>Name</label><input type="text" data-field="name" value="${esc(b.name)}"></div>
        <div class="stat"><span>Type</span><b>${KIND_LABEL[b.kind]}${b.kind === 'mesh' ? ' (no history)' : ''}</b></div>
      </div>
      ${defs.length ? `<div class="props-section"><h4>PARAMETERS (mm)</h4>
        ${defs.map((d) => `<div class="field"><label>${d.label}</label><input type="number" step="any" data-field="param:${d.key}" value="${round(getParam(b.params, d.key) ?? 0)}"></div>`).join('')}
      </div>` : `<div class="props-section"><h4>PARAMETERS</h4><div class="props-info" style="padding:0">This body came from a feature such as Combine, Shell, Loft, Sweep, Pipe, Hole, Draft or an inserted mesh, so it has no editable sizes. Use the timeline to go back and change the original bodies.</div></div>`}
      <div class="props-section"><h4>TRANSFORM</h4>
        <div class="props-row-label">Position (mm)</div>${xyz('pos', m.position.toArray().map((v) => round(v)))}
        <div class="props-row-label">Rotation (°)</div>${xyz('rot', [m.rotation.x, m.rotation.y, m.rotation.z].map(deg))}
        <div class="props-row-label">Scale</div>${xyz('scl', m.scale.toArray().map((v) => round(v, 3)))}
      </div>
      <div class="props-section"><h4>APPEARANCE</h4>
        <div class="field"><label>Colour</label><input type="color" data-field="color" value="${b.color}"></div>
        <div class="field"><label>Material</label><select data-field="material">${Object.entries(MATERIALS).map(([k, v]) => `<option value="${k}" ${k === b.material ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
        <div class="field"><label>Physical</label><select data-field="physical">${Object.entries(PHYSICAL_MATERIALS).map(([k, v]) => `<option value="${k}" ${k === b.physical ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      </div>
      <div class="props-section"><h4>INSPECT</h4>
        <div class="stat"><span>Size X × Y × Z</span><b>${round(size.x, 1)} × ${round(size.y, 1)} × ${round(size.z, 1)} mm</b></div>
        <div class="stat"><span>Volume</span><b>${Number.isFinite(vol) ? round(vol / 1000, 2) + ' cm³' : '-'}</b></div>
        <div class="stat"><span>Mass (${esc(PHYSICAL_MATERIALS[b.physical]?.label || 'Steel')})</span><b>${Number.isFinite(vol) ? fmtMass((vol / 1000) * (PHYSICAL_MATERIALS[b.physical]?.density ?? 7.85)) : '-'}</b></div>
        <div class="stat"><span>Lowest point (Y)</span><b>${round(box.min.y, 2)} mm</b></div>
        ${b.overlapping ? '<div class="stat" style="color:var(--danger)"><span>⚠ Overlaps another body</span></div>' : ''}
      </div>
      <div class="props-actions">
        <button class="btn small" data-a="move">Move/Copy</button>
        <button class="btn small" data-a="ground">Drop to ground</button>
        <button class="btn small" data-a="dup">Copy</button>
        <button class="btn small danger" data-a="del">Delete</button>
      </div>`;
    wire((f, input) => {
      if (f === 'name') app.setProp(b, 'name', input.value);
      else if (f === 'color') app.setAppearance(b, input.value, null);
      else if (f === 'material') app.setAppearance(b, null, input.value);
      else if (f === 'physical') { b.physical = input.value; app.doc.commit(`Physical Material ${b.name}`, 'physmat'); }
      else if (num(input) !== null) app.setProp(b, f, num(input));
      else render();
    });
    act('move', () => app.moveDialog());
    act('ground', () => app.dropToGround());
    act('dup', () => app.duplicate());
    act('del', () => app.deleteSelection());
  };

  const renderProfiles = () => {
    const { sketch: s, index } = app.profileSel[0];
    const many = app.profileSel.length > 1;
    const shape = s.shapes[index];
    const p = shape.profile;
    const [sx, sz] = s.shapeSize(index);
    el.innerHTML = `
      <div class="props-section">
        <div class="field"><label>Sketch</label><input type="text" data-field="name" value="${esc(s.name)}"></div>
        <div class="stat"><span>Plane</span><b>${esc(s.planeName)}</b></div>
        <div class="stat"><span>Selected</span><b>${many ? `${app.profileSel.length} profiles` : `Profile ${index + 1} · ${PROFILE_LABEL[p.type]}`}</b></div>
      </div>
      ${many ? '' : `<div class="props-section"><h4>PROFILE (mm)</h4>
        ${profileDefs(p).map((d) => `<div class="field"><label>${d.label}</label><input type="number" step="any" data-field="param:${d.key}" value="${round(getParam(p, d.key) ?? 0)}"></div>`).join('')}
        ${p.type === 'poly' ? `<div class="stat"><span>Points</span><b>${p.pts.length}</b></div>` : ''}
        <div class="props-row-label">Centre on the sketch plane (mm)</div>
        <div class="xyz"><span class="x">H</span><input type="number" step="any" data-field="pos0" value="${round(shape.c[0])}">
          <span class="z">V</span><input type="number" step="any" data-field="pos1" value="${round(shape.c[1])}"><span></span><span></span></div>
      </div>
      <div class="props-section"><h4>INSPECT</h4>
        <div class="stat"><span>Size</span><b>${round(sx, 1)} × ${round(sz, 1)} mm</b></div>
        <div class="stat"><span>Area</span><b>${round(s.shapeArea(index) / 100, 2)} cm²</b></div>
      </div>`}
      <div class="props-actions">
        <button class="btn small primary" data-a="extrude">Extrude…</button>
        <button class="btn small" data-a="revolve">Revolve…</button>
        <button class="btn small" data-a="edit">Edit Sketch</button>
        <button class="btn small danger" data-a="del">Delete</button>
      </div>
      <div class="props-info">A profile is a closed 2D area of a sketch. <b>Extrude</b> or <b>Revolve</b> turns it into 3D; the sketch then hides (show it again with its eye icon in the Browser).</div>`;
    wire((f, input) => {
      if (f === 'name') app.setProfileProp(s, index, 'name', input.value);
      else if (num(input) !== null) app.setProfileProp(s, index, f, num(input));
      else render();
    });
    act('extrude', () => app.extrude());
    act('revolve', () => app.revolve());
    act('edit', () => app.editSketch(s));
    act('del', () => app.deleteSelection());
  };

  for (const t of ['doc:changed', 'selection:changed', 'sketch:begin', 'sketch:finish', 'sketch:changed']) bus.on(t, render);
  render();
}
