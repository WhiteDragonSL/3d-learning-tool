import { icon } from '../icons.js';
import { bus } from '../events.js';
import { PROFILE_LABEL, ORIGIN_PLANES } from '../model.js';

const ANALYSIS_LABEL = { zebra: 'Zebra Analysis', draft: 'Draft Analysis', curvature: 'Curvature Map' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Fusion-style Browser: a tree with Document Settings, Named Views, Origin,
// Analysis, Construction, Sketches and Bodies. Folders expand/collapse and
// their eye icon shows or hides everything inside.
export function buildBrowser(app) {
  const el = document.getElementById('browser');
  const open = new Set(['root', 'sketches', 'bodies', 'construction', 'analysis']);

  const row = ({ depth, key, caret, eye, eyeOn, iconName, label, cls = '', extra = '', title = '' }) => `
    <div class="tree-row ${cls}" style="padding-left:${6 + depth * 14}px" ${key ? `data-key="${key}"` : ''} title="${esc(title)}">
      <span class="caret">${caret === undefined ? '' : caret ? '▾' : '▸'}</span>
      ${eye ? `<button class="eye" data-eye="${eye}" title="Show / hide">${eyeOn ? '👁' : '◌'}</button>` : '<span class="eye-gap"></span>'}
      <span class="t-icon">${typeof iconName === 'string' && iconName.startsWith('<') ? iconName : icon(iconName)}</span>
      <span class="name">${label}</span>${extra}
    </div>`;

  const render = () => {
    const { doc } = app;
    let h = '';
    const folder = (key, label, iconName, depth, eye, eyeOn, count) => {
      h += row({ depth, key: 'f:' + key, caret: open.has(key), eye, eyeOn, iconName, label: `${label}${count !== undefined ? ` <small>(${count})</small>` : ''}`, cls: 'folder' });
      return open.has(key);
    };

    if (folder('root', esc(doc.name), 'component', 0)) {
      if (folder('settings', 'Document Settings', 'settings', 1)) {
        h += row({ depth: 2, iconName: 'settings', label: 'Units: <b>Millimetre</b>' });
      }
      if (folder('views', 'Named Views', 'views', 1)) {
        for (const v of ['Top', 'Front', 'Right', 'Home']) h += row({ depth: 2, key: 'view:' + v.toLowerCase(), iconName: 'views', label: v, cls: 'clickable' });
      }
      if (folder('origin', 'Origin', 'origin', 1, 'origin', app.originVisible)) {
        h += row({ depth: 2, iconName: 'origin', label: 'O (origin point)' });
        for (const [n, p] of Object.entries(ORIGIN_PLANES)) {
          h += row({ depth: 2, key: 'oplane:' + n, iconName: 'plane', label: `${n} <small>${p.label.replace(/^\w+ plane /, '')}</small>`, cls: 'clickable', title: 'Click to sketch on this plane' });
        }
      }
      if ((app.section || app.analysis) && folder('analysis', 'Analysis', 'section', 1)) {
        if (app.section) h += row({ depth: 2, key: 'section', eye: 'section', eyeOn: app.section.visible, iconName: 'section', label: `Section (${app.section.plane})`, extra: '<button class="x" data-del="section" title="Remove">✕</button>' });
        if (app.analysis) {
          const a = app.analysis;
          h += row({ depth: 2, key: 'analysis', eye: 'analysis', eyeOn: a.visible, iconName: { zebra: 'zebra', draft: 'draftana', curvature: 'curvature' }[a.type], label: ANALYSIS_LABEL[a.type], extra: '<button class="x" data-del="analysis" title="Remove">✕</button>' });
        }
      }
      const cons = doc.construction;
      if (cons.length && folder('construction', 'Construction', 'folder', 1, 'f-planes', cons.some((p) => p.visible), cons.length)) {
        for (const p of cons) {
          h += row({ depth: 2, key: 'cons:' + p.id, eye: 'cons:' + p.id, eyeOn: p.visible, iconName: p.isPlane ? 'plane' : p.isAxis ? 'axis' : 'cpoint', label: esc(p.name), cls: p.visible ? '' : 'hidden-body', extra: `<button class="x" data-del="cons:${p.id}" title="Delete">✕</button>` });
        }
      }
      if (folder('sketches', 'Sketches', 'folder', 1, 'f-sketches', doc.sketches.some((s) => s.visible), doc.sketches.length)) {
        if (!doc.sketches.length) h += '<div class="tree-empty">CREATE ▸ Create Sketch</div>';
        for (const s of doc.sketches) {
          const key = 'sk:' + s.id;
          const editing = app.sketch.sketch === s;
          h += row({ depth: 2, key, caret: open.has(key), eye: key, eyeOn: s.visible, iconName: 'sketch', label: `${esc(s.name)} <small>on ${esc(s.planeName)}</small>${editing ? ' <span class="badge-edit">editing</span>' : ''}`, cls: (s.visible ? '' : 'hidden-body ') + (s.selected.size === s.profileIndices.length && s.selected.size ? 'selected' : ''), title: 'Click: select all profiles · Double-click: Edit Sketch' });
          if (open.has(key)) {
            s.shapes.forEach((sh, i) => {
              const t = sh.profile.type;
              const iconName = { poly: 'line', ngon: 'poly', path: sh.profile.curve === 'spline' ? 'spline' : 'pline' }[t] || t;
              h += t === 'path'
                ? row({ depth: 3, iconName, label: `Path ${i + 1} <small>${PROFILE_LABEL[t]}</small>`, title: 'An open curve: use it in Sweep, Pipe, Rib or Pattern on Path' })
                : row({ depth: 3, key: `pf:${s.id}:${i}`, iconName, label: `Profile ${i + 1} <small>${PROFILE_LABEL[t]}</small>`, cls: 'clickable ' + (s.selected.has(i) ? 'selected' : '') });
            });
          }
        }
      }
      if (folder('bodies', 'Bodies', 'folder', 1, 'f-bodies', doc.bodies.some((b) => b.visible), doc.bodies.length)) {
        if (!doc.bodies.length) h += '<div class="tree-empty">Extrude a sketch or CREATE a box</div>';
        for (const b of doc.bodies) {
          h += row({ depth: 2, key: 'body:' + b.id, eye: 'body:' + b.id, eyeOn: b.visible, iconName: `<span class="swatch" style="background:${b.color}"></span>`, label: esc(b.name), cls: (b.selected ? 'selected ' : '') + (b.visible ? '' : 'hidden-body'), extra: b.overlapping ? '<span class="warn" title="Overlaps another body">⚠</span>' : '', title: 'Click to select · Double-click to rename' });
        }
      }
    }
    el.innerHTML = h;
  };

  // one delegated handler for the whole tree
  el.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    const del = e.target.closest('[data-del]');
    const r = e.target.closest('.tree-row');
    if (eye) {
      const k = eye.dataset.eye;
      if (k === 'origin') app.toggleOrigin();
      else if (k === 'section') app.toggleSection();
      else if (k === 'analysis') app.toggleAnalysis();
      else if (k === 'f-planes') app.toggleFolder('planes');
      else if (k === 'f-sketches') app.toggleFolder('sketches');
      else if (k === 'f-bodies') app.toggleFolder('bodies');
      else if (k.startsWith('cons:')) app.togglePlaneVisible(app.doc.getConstruct(+k.slice(5)));
      else if (k.startsWith('sk:')) app.toggleSketchVisible(app.doc.getSketch(+k.slice(3)));
      else if (k.startsWith('body:')) app.toggleVisible(app.doc.get(+k.slice(5)));
      return;
    }
    if (del) {
      const k = del.dataset.del;
      if (k === 'section') app.removeSection();
      else if (k === 'analysis') app.removeAnalysis();
      else if (k.startsWith('cons:')) app.deletePlane(app.doc.getConstruct(+k.slice(5)));
      return;
    }
    if (!r?.dataset.key) return;
    const k = r.dataset.key;
    const additive = e.shiftKey || e.ctrlKey;
    if (k.startsWith('f:') || (k.startsWith('sk:') && e.target.closest('.caret'))) {
      const id = k.startsWith('f:') ? k.slice(2) : k;
      open.has(id) ? open.delete(id) : open.add(id);
      return render();
    }
    if (k.startsWith('view:')) return app.vp.setView(k.slice(5));
    if (k.startsWith('oplane:')) return app.sketchOnPlane(k.slice(7), null);
    if (k.startsWith('sk:')) { const s = app.doc.getSketch(+k.slice(3)); if (s.visible) app.selectSketch(s); return; }
    if (k.startsWith('pf:')) {
      const [, sid, i] = k.split(':');
      const s = app.doc.getSketch(+sid);
      if (s.visible) app.selectProfile(s, +i, additive);
      return;
    }
    if (k.startsWith('body:')) { const b = app.doc.get(+k.slice(5)); if (b.visible) app.select([b], additive); }
  });

  el.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.tree-row');
    const k = r?.dataset.key || '';
    if (k.startsWith('sk:')) return app.editSketch(app.doc.getSketch(+k.slice(3)));
    if (k === 'f:root') {
      const v = prompt('Design name:', app.doc.name);
      if (v !== null) app.renameDocument(v);
      return;
    }
    if (k.startsWith('body:')) {
      const b = app.doc.get(+k.slice(5));
      const name = r.querySelector('.name');
      const input = document.createElement('input');
      input.value = b.name;
      input.className = 'rename';
      name.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (ok && input.value.trim() && input.value !== b.name) app.setProp(b, 'name', input.value); else render();
      };
      input.onkeydown = (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); ev.stopPropagation(); };
      input.onblur = () => finish(true);
    }
  });

  for (const t of ['doc:changed', 'selection:changed', 'overlaps', 'sketch:changed', 'sketch:begin', 'sketch:finish', 'doc:renamed']) bus.on(t, render);
  render();
}
