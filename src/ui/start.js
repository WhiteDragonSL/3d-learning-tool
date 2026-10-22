import { icon } from '../icons.js';
import { toast } from './dialog.js';
import { bus } from '../events.js';
import { peekBoxgen } from '../boxgen/boxgen.js';

// Start screen shown when the app opens (and from the Home button).
// Step 1 always asks: resume where you left off, or start something new.
// Step 2 (new): Tutorials, Sketch, 3D Objects (Design workspace) or IoT Enclosure (BoxGen).
let open = false;

export function showStart(app, tutorials, { firstLaunch = false } = {}) {
  if (open) return;
  open = true;
  app.cancelTools();

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dims = (i) => `${Math.round(i.width)} × ${Math.round(i.depth)} × ${Math.round(i.height)} mm`;

  // what "Resume" brings back: the last session on launch, the open workspace otherwise
  let lastWs = 'design';
  try { lastWs = localStorage.getItem('minicad-workspace') || 'design'; } catch { /* storage blocked */ }
  const saved = firstLaunch ? app.doc.peekAutosave() : null;
  const box = firstLaunch ? peekBoxgen() : null;
  const bg = app.boxgen.state;
  let resumable = null;
  if (firstLaunch) {
    if (lastWs === 'boxgen' && box) resumable = { kind: 'boxgen', name: box.name, detail: `IoT enclosure · ${count(box.parts, 'component', 'components')} · ${dims(box.inner)}` };
    else if (saved) resumable = { kind: 'design', name: saved.name, detail: `${count(saved.bodies, 'body', 'bodies')} · ${count(saved.sketches, 'sketch', 'sketches')}${saved.savedAt ? ` · saved ${ago(saved.savedAt)}` : ''}` };
    else if (box) resumable = { kind: 'boxgen', name: box.name, detail: `IoT enclosure · ${count(box.parts, 'component', 'components')} · ${dims(box.inner)}` };
  } else if (app.workspace === 'boxgen') {
    resumable = { kind: 'boxgen', name: bg.name, detail: `IoT enclosure · ${count(bg.parts.length, 'component', 'components')} · open now` };
  } else if (app.doc.bodies.length || app.doc.sketches.length) {
    resumable = { kind: 'design', name: app.doc.name, detail: `${count(app.doc.bodies.length, 'body', 'bodies')} · ${count(app.doc.sketches.length, 'sketch', 'sketches')} · open now` };
  }
  const p = tutorials.summary();
  const next = tutorials.nextLesson();

  const back = document.createElement('div');
  back.className = 'modal-back start-back';
  back.innerHTML = `
    <div class="start">
      <header>
        <div>
          <h2><span class="logo">◆</span> MiniCAD <b>Learn</b></h2>
          <p data-subtitle>Resume where you left off, or start something new?</p>
        </div>
        ${firstLaunch ? '' : '<button class="icon-btn start-close" data-a="close" title="Back to the workspace">✕</button>'}
      </header>

      <section data-step="doc">
        <div class="doc-choices">
          <button class="doc-choice resume" data-doc="resume" ${resumable ? '' : 'disabled'}>
            <span class="dc-icon">${icon(resumable?.kind === 'boxgen' ? 'boxgen' : 'resume')}</span>
            <span class="dc-text">
              <b>Resume designing</b>
              ${resumable ? `<span class="dc-name">${esc(resumable.name)}</span><small>${esc(resumable.detail)}</small>`
              : '<small>No saved design yet - start a new one.</small>'}
            </span>
            <span class="dc-go">→</span>
          </button>
          <button class="doc-choice new" data-doc="new">
            <span class="dc-icon">${icon('new')}</span>
            <span class="dc-text">
              <b>New design</b>
              <small>Start fresh: Tutorials, Sketch, 3D Objects or an IoT enclosure.</small>
            </span>
            <span class="dc-go">→</span>
          </button>
        </div>
        ${resumable?.kind === 'design' ? `<div class="doc-note">A new design replaces <b>${esc(resumable.name)}</b> · <button class="link" data-a="backup">${icon('save')} Save a copy first</button></div>` : ''}
        <footer>
          <span class="spacer"></span>
          <button class="btn small" data-a="openfile">${icon('open')} Open file…</button>
        </footer>
      </section>

      <section data-step="activity" class="hidden">
        <div class="start-cards four">
          <div class="start-card learn" data-a="learn" tabindex="0">
            <div class="big">🎓</div>
            <h3>Tutorials</h3>
            <p>Learn 3D modelling step by step. Each step checks itself as you work.</p>
            <div class="start-progress"><div style="width:${(p.done / p.total) * 100}%"></div></div>
            <small>${p.done} / ${p.total} steps · ${p.points} points</small>
            <div class="chips">
              <button class="btn primary small" data-a="lesson">${p.done ? 'Continue' : 'Start'}: ${next.title}</button>
              <button class="btn small" data-a="lessons">All lessons</button>
            </div>
          </div>

          <div class="start-card sketch" data-a="sketch" tabindex="0">
            <div class="big">${icon('sketch')}</div>
            <h3>Sketch</h3>
            <p>Draw 2D profiles on a plane, then Extrude or Revolve them into 3D.</p>
            <div class="chips">
              <button class="chip" data-sketch="line">${icon('line')}Line</button>
              <button class="chip" data-sketch="rect">${icon('rect')}Rectangle</button>
              <button class="chip" data-sketch="circle">${icon('circle')}Circle</button>
              <button class="chip" data-sketch="poly">${icon('poly')}Polygon</button>
            </div>
          </div>

          <div class="start-card object" data-a="object" tabindex="0">
            <div class="big">${icon('box')}</div>
            <h3>3D Objects</h3>
            <p>Place ready-made solid shapes, then move, combine and modify them.</p>
            <div class="chips">
              ${['box', 'cylinder', 'sphere', 'cone', 'torus'].map((k) => `<button class="chip" data-shape="${k}">${icon(k)}${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
            </div>
          </div>

          <div class="start-card iot" data-a="iot" tabindex="0">
            <div class="big">${icon('boxgen')}</div>
            <h3>IoT Enclosure</h3>
            <p>Pick boards and sensors, arrange them, and get a 3D-printable case with standoffs and port cutouts.</p>
            <div class="chips">
              <button class="chip" data-iot="esp32-devkit-v1">ESP32</button>
              <button class="chip" data-iot="arduino-uno">Arduino Uno</button>
              <button class="chip" data-iot="hc-sr04">HC-SR04</button>
            </div>
          </div>
        </div>
        <footer>
          <span class="muted">Choose how to start.</span>
          <span class="spacer"></span>
          <button class="btn small" data-a="empty">Just open an empty design</button>
        </footer>
      </section>

      <div class="start-tips">
        <span><b>Orbit</b> left-drag</span><span><b>Pan</b> right-drag</span><span><b>Zoom</b> scroll</span>
        <span><b>Undo</b> Ctrl+Z</span><span><b>Home screen</b> ◆ logo (top-left)</span>
      </div>
    </div>`;
  document.body.appendChild(back);

  const close = () => { back.remove(); open = false; };
  const on = (sel, fn) => back.querySelectorAll(sel).forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); fn(el); }));

  // a fresh, empty design in the Design workspace
  const newDesign = () => {
    close();
    app.setWorkspace('design');
    app.select([]);
    app.doc.clear();
    app.vp.setView('home');
    app.updateOverlaps();
    bus.emit('doc:renamed');
  };
  // a fresh, empty enclosure in the IoT BoxGen workspace
  const newEnclosure = (firstPart) => {
    close();
    tutorials.toggle(false);
    app.boxgen.reset();
    app.setWorkspace('boxgen');
    if (firstPart) {
      const def = app.boxgen.library.find((d) => d.id === firstPart);
      if (def) app.boxgen.addComponent(def);
    }
  };

  // ----- step 1: resume or new -----
  on('[data-doc=resume]', () => {
    if (firstLaunch && saved) { app.doc.restoreAutosave(); bus.emit('doc:renamed'); }
    app.setWorkspace(resumable.kind);
    if (resumable.kind === 'design') app.fitAll();
    app.updateOverlaps();
    tutorials.toggle(false);
    close();
    toast(`Resuming <b>${esc(resumable.name)}</b>.`, 'ok', 2500);
  });
  on('[data-doc=new]', () => {
    back.querySelector('[data-step=doc]').classList.add('hidden');
    back.querySelector('[data-step=activity]').classList.remove('hidden');
    back.querySelector('[data-subtitle]').textContent = 'Something new - what would you like to do?';
    back.querySelector('.start-card')?.focus();
  });
  on('[data-a=backup]', () => {
    if (!firstLaunch) app.saveFile();
    else {
      const blob = app.doc.autosaveBlob();
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(saved.name || 'design').replace(/[^\w\- ]+/g, '').trim() || 'design'}.minicad.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`Saved a copy of ${esc(saved.name)}.`, 'ok');
    }
  });
  on('[data-a=openfile]', () => { close(); app.setWorkspace('design'); app.openFile(); });
  on('[data-a=close]', close);

  // ----- step 2: how to start -----
  on('[data-a=lesson]', () => { newDesign(); tutorials.startLesson(next.id); });
  on('[data-a=lessons]', () => { newDesign(); tutorials.showList(); });
  on('[data-a=learn]', () => { newDesign(); tutorials.startLesson(next.id); });

  // a shape chip sketches on the ground (XZ) plane straight away
  on('[data-sketch]', (el) => { newDesign(); tutorials.toggle(false); app.sketchOnPlane('XZ', el.dataset.sketch); });
  on('[data-a=sketch]', () => {
    newDesign();
    tutorials.toggle(false);
    app.createSketch();
    toast('Create Sketch: click a plane (or a flat face). Then draw, click <b>FINISH SKETCH</b>, and use <b>Extrude</b>.', '', 5000);
  });

  on('[data-shape]', (el) => { newDesign(); tutorials.toggle(false); app.createPrimitive(el.dataset.shape); });
  on('[data-a=object]', () => {
    newDesign();
    tutorials.toggle(false);
    app.setHint('3D Objects: pick a shape in the <b>CREATE</b> group (Box, Cylinder, Sphere…), then use <b>MODIFY</b> tools on it.');
    flash('.tb-group.create');
  });

  on('[data-iot]', (el) => newEnclosure(el.dataset.iot));
  on('[data-a=iot]', () => newEnclosure(null));
  on('[data-a=empty]', () => { newDesign(); tutorials.toggle(false); });

  // keyboard: Enter on a focused card activates it
  back.querySelectorAll('.start-card').forEach((c) => c.addEventListener('keydown', (e) => { if (e.key === 'Enter') c.click(); }));
  back.querySelector(resumable ? '[data-doc=resume]' : '[data-doc=new]')?.focus();
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function flash(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.add('tut-highlight');
  setTimeout(() => el.classList.remove('tut-highlight'), 3500);
}
