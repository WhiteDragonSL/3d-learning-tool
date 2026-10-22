import { icon } from '../icons.js';
import { bus } from '../events.js';
import { shortcutOf } from '../commands.js';
import { toast } from './dialog.js';

// Fusion-style toolbar: workspace switcher, tabs, and tool groups whose name
// opens a dropdown with every command in the group. While a sketch is open
// the contextual SKETCH tab replaces the solid tools.
// The toolbar icons (`tools`) stay a short, beginner-friendly set; every other
// command lives in the group's ▾ menu, as in Fusion.
const SOLID_GROUPS = [
  { name: 'CREATE', cls: 'create', tools: ['sketch', 'extrude', 'revolve', 'box', 'cylinder', 'sphere'],
    menu: ['sketch', '-', 'extrude', 'revolve', 'sweep', 'loft', 'rib', '-', 'hole', 'thread', '-', 'box', 'cylinder', 'sphere', 'torus', 'cone', 'coil', 'pipe', '-',
      'pattern', 'circpattern', 'pathpattern', 'mirror'] },
  { name: 'MODIFY', cls: 'modify', tools: ['presspull', 'fillet', 'shell', 'combine', 'translate', 'appearance'],
    menu: ['presspull', 'fillet', 'chamfer', 'shell', 'draft', '-', 'offset-face', 'split-body', '-', 'combine', 'align', '-',
      'translate', 'rotate', 'scale', 'duplicate', 'ground', '-', 'physical-material', 'appearance', 'delete'] },
  { name: 'CONSTRUCT', cls: 'construct', tools: ['offset-plane'],
    menu: ['offset-plane', 'plane-angle', 'plane-tangent', 'midplane', 'plane-3pt', 'plane-path', '-', 'axis-cyl', 'axis-2pt', 'axis-perp', '-', 'point-pick', 'point-center'] },
  { name: 'INSPECT', cls: 'inspect', tools: ['measure', 'interference', 'section'],
    menu: ['measure', 'interference', 'section', '-', 'zebra', 'draft-analysis', 'curvature', '-', 'com'] },
  { name: 'INSERT', cls: 'insert', tools: ['insert-mesh'], menu: ['insert-mesh'] },
];
const SKETCH_GROUPS = [
  { name: 'CREATE', cls: 'sketch', tools: ['line', 'rect', 'circle', 'poly'],
    menu: ['line', 'pline', '-', 'rect', 'crect', 'rect3', '-', 'circle', 'circle2', 'circle3', '-', 'arc', 'poly', 'ellipse', 'slot', 'spline', '-',
      'sketch-fillet', 'sketch-offset', 'sketch-mirror', 'sketch-rectpattern', 'sketch-circpattern', 'sketch-move', 'sketch-scale', '-',
      'sketch-dimension', 'sketch-constraint'] },
  { name: 'INSPECT', cls: 'inspect', tools: ['measure'], menu: ['measure'] },
];
const TABS = ['SOLID', 'SURFACE'];
const FILE_MENU = ['new', 'open', 'save', '-', 'export', 'insert-mesh', '-', 'home'];

let openMenu = null;
export function closeMenus() { openMenu?.remove(); openMenu = null; }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('[data-menu-btn]')) closeMenus(); });

function tip(c) {
  const sc = shortcutOf(c);
  return `${c.label}${sc ? `  (${sc})` : ''}${c.desc ? `\n${c.desc}` : ''}`;
}

// Dropdown menu under a button.
export function showMenu(anchor, ids, C) {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'dd-menu';
  for (const id of ids) {
    if (id === '-') { m.insertAdjacentHTML('beforeend', '<div class="dd-sep"></div>'); continue; }
    const c = C[id];
    const b = document.createElement('button');
    b.className = 'dd-item';
    b.dataset.tool = id;
    b.title = c.desc || '';
    b.innerHTML = `${icon(c.icon)}<span>${c.label}</span><kbd>${shortcutOf(c)}</kbd>`;
    b.onclick = () => { closeMenus(); c.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  // open below the button, or above it when there is more room there; long menus scroll
  const below = window.innerHeight - r.bottom - 10, above = r.top - 10;
  if (m.offsetHeight > below && above > below) {
    m.style.maxHeight = above + 'px';
    m.style.top = r.top - 2 - Math.min(m.offsetHeight, above) + 'px';
  } else {
    m.style.maxHeight = below + 'px';
    m.style.top = r.bottom + 2 + 'px';
  }
  openMenu = m;
}

export function buildToolbar(app, C) {
  const ribbon = document.getElementById('ribbon');

  const render = () => {
    closeMenus();
    const sketching = app.sketch.active;
    const groups = sketching ? SKETCH_GROUPS : SOLID_GROUPS;
    ribbon.innerHTML = `
      <div class="tb-tabs">
        <button class="ws-btn" data-menu-btn title="Workspace">DESIGN ▾</button>
        ${TABS.map((t) => `<button class="tb-tab ${t === 'SOLID' && !sketching ? 'active' : ''}" data-tab="${t}" ${t === 'SOLID' ? '' : 'disabled title="Not part of this learning version"'}>${t}</button>`).join('')}
        ${sketching ? '<button class="tb-tab active sketch-tab">SKETCH</button>' : ''}
      </div>
      <div class="tb-groups"></div>`;
    const row = ribbon.querySelector('.tb-groups');
    for (const g of groups) {
      const el = document.createElement('div');
      el.className = 'tb-group ' + g.cls;
      el.innerHTML = `<div class="tb-tools"></div><button class="tb-group-btn" data-menu-btn data-contains="${g.menu.filter((x) => x !== '-').join(' ')}">${g.name} ▾</button>`;
      const tools = el.querySelector('.tb-tools');
      for (const id of g.tools) {
        const c = C[id];
        const b = document.createElement('button');
        b.className = 'tool';
        b.dataset.tool = id;
        b.title = tip(c);
        b.innerHTML = icon(c.icon);
        b.onclick = () => c.run();
        tools.appendChild(b);
      }
      el.querySelector('.tb-group-btn').onclick = (e) => showMenu(e.currentTarget, g.menu, C);
      row.appendChild(el);
    }
    if (sketching) {
      const fin = document.createElement('div');
      fin.className = 'tb-group finish';
      fin.innerHTML = `<div class="tb-tools"><button class="tool finish-btn" data-tool="finish-sketch" title="Finish Sketch (Esc with no tool active)">${icon('finish')}</button></div><div class="tb-group-name">FINISH SKETCH</div>`;
      fin.querySelector('button').onclick = () => C['finish-sketch'].run();
      row.appendChild(fin);
    }
    ribbon.querySelector('.ws-btn').onclick = (e) => {
      showMenu(e.currentTarget, ['home', 'tutorials'], C);
      openMenu.insertAdjacentHTML('afterbegin', '<div class="dd-title">Workspace: <b>DESIGN</b> ✓</div><div class="dd-sep"></div>');
    };
    ribbon.querySelector('.tb-tab[data-tab=SOLID]').onclick = () => { if (app.sketch.active) app.finishSketch(); };
    refresh();
    bus.emit('toolbar:rendered');
  };

  const refresh = () => {
    for (const b of ribbon.querySelectorAll('.tool')) {
      const t = b.dataset.tool;
      const active = (t === 'translate' && app.transformMode) || t === app.sketch.mode || (t === 'measure' && app.measure.active)
        || (t === 'sketch' && app.sketch.picking);
      b.classList.toggle('active', !!active);
    }
  };

  let wasSketching = false;
  bus.on('tool:changed', () => {
    if (app.sketch.active !== wasSketching) { wasSketching = app.sketch.active; render(); }
    else refresh();
  });
  bus.on('*', (type) => { if (type === 'tool' || type === 'doc:changed') refresh(); });
  render();
}

// Application bar: File menu, Save, Undo/Redo, document name, search, home, tutorials, help.
export function buildAppBar(app, C, ui) {
  const left = document.getElementById('appbar-left');
  left.innerHTML = `
    <button class="ab-btn" id="btn-file" data-menu-btn data-contains="${FILE_MENU.filter((x) => x !== '-').join(' ')}">${icon('open')} File ▾</button>
    <button class="ab-icon" data-tool="save" title="Save (Ctrl+S)">${icon('save')}</button>
    <span class="ab-sep"></span>
    <button class="ab-icon" data-tool="undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
    <button class="ab-icon" data-tool="redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>`;
  left.querySelector('#btn-file').onclick = (e) => showMenu(e.currentTarget, FILE_MENU, C);
  left.querySelector('[data-tool=save]').onclick = () => C.save.run();
  left.querySelector('[data-tool=undo]').onclick = () => C.undo.run();
  left.querySelector('[data-tool=redo]').onclick = () => C.redo.run();

  const right = document.getElementById('appbar-right');
  right.innerHTML = `
    <button class="ab-search" data-tool="search" title="Command search (S)">${icon('search')}<span>Search commands…</span><kbd>S</kbd></button>
    <button id="btn-home" class="pill ghost" title="Start screen">⌂ Home</button>
    <button id="btn-learn" class="pill">🎓 Tutorials</button>
    <button class="ab-icon light theme-btn" data-tool="theme"></button>
    <button class="ab-icon light" data-tool="help" title="Keyboard & mouse help (?)">${icon('help')}</button>`;
  right.querySelector('[data-tool=search]').onclick = () => C.search.run();
  const themeBtn = right.querySelector('[data-tool=theme]');
  themeBtn.onclick = () => C.theme.run();
  const setThemeIcon = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
    themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };
  bus.on('theme', setThemeIcon);
  setThemeIcon();
  right.querySelector('[data-tool=help]').onclick = () => C.help.run();
  right.querySelector('#btn-home').onclick = () => ui.home();
  document.querySelector('.brand').onclick = () => ui.home();

  const title = document.getElementById('doc-title');
  const setTitle = () => { title.textContent = app.doc.name; document.title = `${app.doc.name} - MiniCAD Learn`; };
  title.parentElement.ondblclick = () => {
    const v = prompt('Design name:', app.doc.name);
    if (v !== null) { app.renameDocument(v); toast('Design renamed.', 'ok'); }
  };
  bus.on('doc:renamed', setTitle);
  bus.on('doc:changed', setTitle);
  setTitle();

  const updateUndo = () => {
    left.querySelector('[data-tool=undo]').disabled = app.doc.index <= 0;
    left.querySelector('[data-tool=redo]').disabled = app.doc.index >= app.doc.history.length - 1;
  };
  bus.on('doc:changed', updateUndo);
  updateUndo();
}
