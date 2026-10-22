import { icon } from '../icons.js';
import { bus } from '../events.js';
import { shortcutOf } from '../commands.js';
import { showMenu, closeMenus } from './toolbar.js';
import { toast } from './dialog.js';

// ---------------------------------------------------------------------------
// Navigation bar (bottom centre of the viewport), like Fusion's.
// ---------------------------------------------------------------------------
export function buildNavBar(app, C) {
  const el = document.getElementById('navbar');
  const btn = (id, title, ic, extra = '') => `<button class="nb-btn" data-nb="${id}" title="${title}" ${extra}>${icon(ic)}</button>`;
  el.innerHTML = `
    ${btn('orbit', 'Orbit (left-drag rotates the view)', 'orbit')}
    ${btn('pan', 'Pan (left-drag slides the view)', 'pan')}
    ${btn('zoom', 'Zoom (left-drag zooms)', 'zoom')}
    ${btn('fit', 'Fit (F6)', 'fit')}
    ${btn('lookat', 'Look At (square-on to the selected sketch)', 'lookat')}
    <span class="nb-sep"></span>
    ${btn('display', 'Display Settings', 'display', 'data-menu-btn')}
    ${btn('grid', 'Layout grid on/off', 'grid')}`;
  const run = { orbit: C.orbit, pan: C.pan, zoom: C.zoom, fit: C.fit, lookat: C.lookat, grid: C.grid };
  for (const b of el.querySelectorAll('[data-nb]')) {
    const id = b.dataset.nb;
    b.onclick = (e) => {
      if (id === 'display') return showMenu(e.currentTarget, ['display-shaded', 'display-edges', 'wire'], C);
      run[id].run();
    };
  }
  const refresh = () => {
    const nav = app.navMode || 'orbit';
    for (const id of ['orbit', 'pan', 'zoom']) el.querySelector(`[data-nb=${id}]`).classList.toggle('active', nav === id);
    el.querySelector('[data-nb=grid]').classList.toggle('active', app.vp.grid.visible);
  };
  bus.on('tool:changed', refresh);
  refresh();
}

// ---------------------------------------------------------------------------
// Sketch Palette: options shown on the right while a sketch is open.
// ---------------------------------------------------------------------------
export function buildSketchPalette(app, C) {
  const el = document.getElementById('sketch-palette');
  const render = () => {
    const sk = app.sketch;
    el.classList.toggle('hidden', !sk.active);
    if (!sk.active) return;
    el.innerHTML = `
      <div class="sp-head">SKETCH PALETTE</div>
      <div class="sp-body">
        <div class="sp-title">Options</div>
        <button class="btn small" data-sp="lookat">${icon('lookat')} Look At</button>
        <label><input type="checkbox" data-sp="grid" ${sk.showGrid ? 'checked' : ''}> Sketch grid</label>
        <label><input type="checkbox" data-sp="snap" ${app.snap ? 'checked' : ''}> Snap</label>
        <label><input type="checkbox" data-sp="dims" ${sk.showDims ? 'checked' : ''}> Show dimensions</label>
        <label>Polygon sides <input type="number" min="3" max="32" data-sp="sides" value="${sk.sides}"></label>
        <div class="sp-title">Profiles</div>
        <div class="sp-info">${sk.sketch.shapes.length} in ${sk.sketch.name}</div>
        <button class="btn small primary finish" data-sp="finish">${icon('finish')} Finish Sketch</button>
      </div>`;
    el.querySelector('[data-sp=lookat]').onclick = () => C.lookat.run();
    el.querySelector('[data-sp=finish]').onclick = () => C['finish-sketch'].run();
    el.querySelector('[data-sp=grid]').onchange = (e) => { sk.showGrid = e.target.checked; sk.grid.visible = sk.showGrid; };
    el.querySelector('[data-sp=dims]').onchange = (e) => { sk.showDims = e.target.checked; sk.refreshDims(); };
    el.querySelector('[data-sp=snap]').onchange = (e) => {
      app.snap = e.target.checked;
      document.getElementById('opt-snap').checked = app.snap;
      app.applySnap();
    };
    const sides = el.querySelector('[data-sp=sides]');
    sides.onchange = () => { sk.sides = Math.min(32, Math.max(3, Math.round(+sides.value) || 6)); sides.value = sk.sides; bus.emit('sketch:sides', { sides: sk.sides }); };
    sides.onkeydown = (e) => e.stopPropagation();
  };
  for (const t of ['sketch:begin', 'sketch:finish', 'sketch:changed']) bus.on(t, render);
  render();
}

// ---------------------------------------------------------------------------
// Marking menu: right-click (without dragging) in the viewport.
// ---------------------------------------------------------------------------
export function buildMarkingMenu(app, C) {
  const c = app.vp.canvas;
  let down = null;
  let menu = null;
  const close = () => { menu?.remove(); menu = null; };
  c.addEventListener('pointerdown', (e) => { close(); if (e.button === 2) down = [e.clientX, e.clientY]; });
  c.addEventListener('pointerup', (e) => {
    if (e.button !== 2 || !down) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved < 5) open(e);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) close(); }, true);

  function open(e) {
    if (app.sketch.picking || app.workspace !== 'design') return;
    closeMenus();
    let context = [];
    if (app.sketch.active) {
      context = ['line', 'rect', 'circle', 'poly', 'spline', '-', 'sketch-dimension', 'sketch-offset', 'sketch-fillet', '-', 'lookat', 'finish-sketch'];
    } else {
      const hit = app.pickAt(e);
      if (hit?.profile) {
        const already = app.profileSel.some((p) => p.sketch === hit.profile.sketch && p.index === hit.profile.index);
        if (!already) app.selectProfile(hit.profile.sketch, hit.profile.index);
        context = ['extrude', 'revolve', '-', 'lookat', 'delete'];
        context.editSketch = hit.profile.sketch;
      } else if (hit?.body) {
        if (!app.selection.includes(hit.body)) app.select([hit.body]);
        context = ['translate', 'appearance', 'physical-material', 'duplicate', 'ground', 'fillet', 'chamfer', 'shell', 'hole', ...(app.selection.length > 1 ? ['combine', 'align'] : []), '-', 'delete'];
        context.hideBody = hit.body;
      } else {
        context = ['sketch', 'box', 'cylinder', '-', 'fit', 'view-home', 'measure'];
      }
    }
    const last = app.lastCommand;
    // 8 radial slots, starting at the top and going clockwise
    const radial = [
      last ? { label: `Repeat ${last.label}`, icon: last.icon, run: last.run } : { ...C.fit, label: 'Fit' },
      C.undo, C.presspull, C.delete, C.sketch, C.translate, C.redo, C.fillet,
    ];
    menu = document.createElement('div');
    menu.className = 'marking';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = '<div class="mm-center"></div>';
    radial.forEach((cmd, i) => {
      const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
      const b = document.createElement('button');
      b.className = 'mm-item';
      b.style.left = Math.cos(a) * 92 + 'px';
      b.style.top = Math.sin(a) * 72 + 'px';
      b.innerHTML = `${icon(cmd.icon)}<span>${cmd.label}</span>`;
      b.onclick = () => { close(); cmd.run(); };
      menu.appendChild(b);
    });
    const list = document.createElement('div');
    list.className = 'mm-list';
    for (const id of context) {
      if (id === '-') { list.insertAdjacentHTML('beforeend', '<div class="dd-sep"></div>'); continue; }
      const cmd = C[id];
      list.appendChild(listItem(cmd.icon, cmd.label, shortcutOf(cmd), () => cmd.run()));
    }
    if (context.editSketch) list.appendChild(listItem('edit', 'Edit Sketch', '', () => app.editSketch(context.editSketch)));
    if (context.hideBody) list.appendChild(listItem('eye', 'Hide Body', '', () => app.toggleVisible(context.hideBody)));
    menu.appendChild(list);
    document.body.appendChild(menu);
    // keep the overflow list on screen
    const r = list.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) list.style.top = `${120 - (r.bottom - window.innerHeight + 8)}px`;
    bus.emit('marking', {});

    function listItem(ic, label, sc, fn) {
      const b = document.createElement('button');
      b.className = 'dd-item';
      b.innerHTML = `${icon(ic)}<span>${label}</span><kbd>${sc}</kbd>`;
      b.onclick = () => { close(); fn(); };
      return b;
    }
  }
}

// ---------------------------------------------------------------------------
// Command search (press S), like Fusion's toolbox.
// ---------------------------------------------------------------------------
export function openSearch(app, C) {
  document.querySelector('.search-pop')?.remove();
  if (app.workspace !== 'design') { toast('Command search is for the Design workspace. Switch with the workspace button (top left).', 'warn', 3500); return; }
  const pop = document.createElement('div');
  pop.className = 'search-pop';
  pop.innerHTML = `<div class="sp-input">${icon('search')}<input placeholder="Search commands… (e.g. extrude, fillet, plane)" /></div><div class="sp-list"></div>`;
  document.body.appendChild(pop);
  const input = pop.querySelector('input');
  const list = pop.querySelector('.sp-list');
  const skip = new Set(['search', 'orbit', 'pan', 'zoom']);
  let items = [], active = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = Object.values(C).filter((c) => !skip.has(c.id) && (!q || c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q)));
    active = Math.min(active, Math.max(0, items.length - 1));
    list.innerHTML = items.slice(0, 12).map((c, i) => `<button class="dd-item ${i === active ? 'active' : ''}" data-i="${i}">${icon(c.icon)}<span>${c.label}<small>${c.desc || ''}</small></span><kbd>${shortcutOf(c)}</kbd></button>`).join('')
      || '<div class="sp-none">No matching command</div>';
    for (const b of list.querySelectorAll('[data-i]')) b.onclick = () => runAt(+b.dataset.i);
  };
  const runAt = (i) => { const c = items[i]; pop.remove(); if (c) { c.run(); bus.emit('search:run', { id: c.id }); } };
  input.oninput = () => { active = 0; draw(); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') pop.remove();
    else if (e.key === 'Enter') runAt(active);
    else if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
  };
  input.onblur = () => setTimeout(() => pop.remove(), 150);
  draw();
  input.focus();
  bus.emit('search:open');
}

// ---------------------------------------------------------------------------
// Keyboard & mouse help
// ---------------------------------------------------------------------------
export function openHelp(C) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const keyed = Object.values(C).filter((c) => shortcutOf(c));
  back.innerHTML = `
    <div class="help-box">
      <header><h3>Keyboard & mouse</h3><button class="icon-btn" data-x>✕</button></header>
      <div class="help-cols">
        <div>
          <h4>Mouse</h4>
          <div class="kv"><span>Orbit</span><b>Left-drag empty space</b></div>
          <div class="kv"><span>Pan</span><b>Right-drag / middle-drag</b></div>
          <div class="kv"><span>Zoom</span><b>Mouse wheel</b></div>
          <div class="kv"><span>Select</span><b>Click · Shift+click adds</b></div>
          <div class="kv"><span>Marking menu</span><b>Right-click (no drag)</b></div>
          <h4>While sketching</h4>
          <div class="kv"><span>Exact size</span><b>type 40, Tab, 20, Enter</b></div>
          <div class="kv"><span>Stop tool / finish</span><b>Esc</b></div>
          <div class="kv"><span>Remove last profile</span><b>Ctrl+Z</b></div>
        </div>
        <div>
          <h4>Shortcuts</h4>
          ${keyed.map((c) => `<div class="kv"><span>${c.label}</span><kbd>${shortcutOf(c)}</kbd></div>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector('[data-x]').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  window.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); window.removeEventListener('keydown', k); } });
}
