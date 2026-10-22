import { bus } from './events.js';
import { toast } from './ui/dialog.js';

// ---------------------------------------------------------------------------
// Check helpers. A step is complete when its check(event, app) returns true.
// `event` is { type, ...data } for every action announced on the event bus.
// ---------------------------------------------------------------------------
const on = (type, pred = () => true) => (e, app) => e.type === type && pred(e, app);
const state = (pred) => (e, app) => e.type !== 'tut' && pred(app);
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const ofKind = (app, kind) => app.doc.bodies.filter((b) => b.kind === kind);
const hl = (tool) => `[data-tool="${tool}"]`;

export const LESSONS = [
  {
    id: 'navigate',
    title: '1. Getting around',
    summary: 'Orbit, zoom, pan, the ViewCube and the navigation bar.',
    concept: 'In CAD you move the <b>camera</b>, not the model. Orbiting, panning and zooming let you check a design from every side before you build it.',
    steps: [
      { text: 'Hold the <b>left mouse button</b> on empty space in the viewport and drag to <b>orbit</b> around the design.', hint: 'Start the drag on the grey background, not on the ViewCube.', check: on('camera', (e) => e.kind === 'orbit') },
      { text: 'Scroll the <b>mouse wheel</b> to <b>zoom</b> in and out.', hint: 'Zoom goes towards the centre of the view.', check: on('camera', (e) => e.kind === 'zoom') },
      { text: 'Hold the <b>right</b> (or middle) <b>mouse button</b> and drag to <b>pan</b> sideways.', hint: 'A right-click without dragging opens the marking menu instead - that comes later.', check: on('camera', (e) => e.kind === 'pan') },
      { text: 'Click the <b>TOP</b> face of the <b>ViewCube</b> (top-right corner) to look straight down.', highlight: '#viewcube canvas', check: on('view', (e) => e.view === 'top') },
      { text: 'Click a <b>corner</b> of the ViewCube to get an angled 3D view.', hint: 'Corners are where three faces meet. Edges also work.', highlight: '#viewcube canvas', check: on('view', (e) => e.view === 'corner') },
      { text: 'Click the <b>Home</b> button (house icon beside the ViewCube) to go back to the start view.', highlight: hl('view-home'), check: on('view', (e) => e.view === 'home') },
      { text: 'The <b>navigation bar</b> at the bottom of the viewport has Orbit, Pan, Zoom, <b>Fit</b> and display options. Click <b>Display Settings</b> and choose <b>Wireframe</b>, then switch back.', highlight: '#navbar', check: on('display', (e) => e.mode === 'wire') },
    ],
  },
  {
    id: 'first-body',
    title: '2. Your first body',
    summary: 'Create a box, select it and edit its size.',
    concept: 'A <b>body</b> is a solid 3D object. Primitive bodies such as boxes and cylinders are defined by a few <b>parameters</b> (width, height, radius…), measured here in <b>millimetres</b>. Hover over any toolbar icon to see its name.',
    steps: [
      { text: 'In the <b>CREATE</b> group of the toolbar, click the <b>Box</b> icon.', hint: 'It is the cube icon. Hover over the icons to read their names, or open the CREATE ▾ menu.', highlight: hl('box'), check: on('tool', (e) => e.tool === 'box') },
      { text: 'The Box dialog shows a live preview. Set <b>Width (X)</b> to <b>40</b> and click <b>OK</b>.', hint: 'Type 40 in the Width field, then press Enter or click OK.', highlight: '.dialog', check: on('body:create', (e) => e.kind === 'box' && near(e.params.width, 40, 0.01)) },
      { text: 'Click empty space to clear the selection, then click the box to <b>select</b> it. Selected bodies turn blue.', check: on('select', (e) => e.bodies.length === 1) },
      { text: 'In <b>Properties</b> (left), change <b>Height (Y)</b> to <b>10</b> and press Enter.', highlight: '#props-panel', check: on('props', (e) => e.body?.kind === 'box' && e.field === 'param:height' && near(e.value, 10, 0.01)) },
      { text: 'Made a mistake? <b>Undo</b> with <kbd>Ctrl</kbd>+<kbd>Z</kbd> or the ↶ button in the top bar.', highlight: hl('undo'), check: on('undo') },
      { text: '<b>Redo</b> with <kbd>Ctrl</kbd>+<kbd>Y</kbd> (or ↷) to bring the change back.', highlight: hl('redo'), check: on('redo') },
    ],
  },
  {
    id: 'transform',
    title: '3. Move/Copy',
    summary: 'Move, rotate and scale bodies.',
    concept: 'Every body has a <b>position</b> (X, Y, Z), a <b>rotation</b> and a <b>scale</b>. X is <span style="color:#d9363e">red</span>, Y (up) is <span style="color:#2f9e44">green</span> and Z is <span style="color:#1c6fd1">blue</span>, the same colours as the gizmo arrows.',
    steps: [
      { text: 'Select a body, then click <b>Move/Copy</b> in MODIFY (or press <kbd>M</kbd>). Drag one of the coloured arrows.', hint: 'No bodies yet? Create a Box first. The squares between arrows move along two axes at once.', highlight: hl('translate'), check: on('transform', (e) => e.mode === 'translate') },
      { text: 'In the Move/Copy dialog set <b>Move type</b> to <b>Rotate</b> and drag a ring. With Snap on, it turns in 15° steps.', highlight: '.dialog', check: on('transform', (e) => e.mode === 'rotate') },
      { text: 'Set <b>Move type</b> to <b>Scale</b> and drag a handle. Then click <b>OK</b>.', highlight: '.dialog', check: on('transform', (e) => e.mode === 'scale') },
      { text: 'For exact placement, type values. In Properties set <b>Position X</b> to <b>50</b>.', highlight: '#props-panel', check: on('props', (e) => e.field === 'pos0' && near(e.value, 50, 0.01)) },
      { text: 'Set <b>Position Y</b> above 0 so the body floats, then use <b>MODIFY ▾ ▸ Drop to Ground</b> (or the button in Properties).', highlight: hl('ground'), check: on('ground') },
    ],
  },
  {
    id: 'shapes',
    title: '4. Shapes & appearance',
    summary: 'More primitives, colours and materials.',
    concept: 'Many real objects can be built from simple <b>primitives</b>. Appearance (colour and material) only changes how a body <i>looks</i>, not its shape or size. Every toolbar group has a <b>▾ menu</b> with all its commands.',
    steps: [
      { text: 'Create a <b>Cylinder</b>.', highlight: hl('cylinder'), check: on('body:create', (e) => e.kind === 'cylinder') },
      { text: 'Create a <b>Sphere</b>. New bodies are placed beside existing ones so they don\'t overlap.', highlight: hl('sphere'), check: on('body:create', (e) => e.kind === 'sphere') },
      { text: 'Open the <b>CREATE ▾</b> menu and choose <b>Torus</b> or <b>Cone</b>.', highlight: hl('torus'), check: on('body:create', (e) => e.kind === 'cone' || e.kind === 'torus') },
      { text: 'Select a body and press <kbd>A</kbd> (Appearance). Pick a new <b>Colour</b> and click OK.', highlight: hl('appearance'), check: on('appearance', (e) => !!e.color) },
      { text: 'Give a body the <b>Metal</b> material (Appearance dialog, or Properties).', check: on('appearance', (e) => e.material === 'metal') },
    ],
  },
  {
    id: 'sketch',
    title: '5. Sketching',
    summary: 'Create Sketch on a plane and draw exact 2D profiles.',
    concept: 'Most parts in Fusion 360 start as a <b>sketch</b>: flat 2D shapes drawn on a <b>plane</b>. A closed shape is a <b>profile</b> (shown shaded). While you sketch, the toolbar switches to the <b>SKETCH</b> tab; <b>FINISH SKETCH</b> takes you back.',
    steps: [
      { text: 'Click <b>Create Sketch</b> (first icon in CREATE).', highlight: hl('sketch'), check: on('tool', (e) => e.tool === 'sketch') },
      { text: 'Three orange <b>origin planes</b> appear. Click the one lying flat on the grid: the <b>XZ</b> (ground) plane.', hint: 'The view turns to look straight at the plane you pick. XY stands upright facing you, YZ is the side wall.', check: on('sketch:plane', (e) => e.plane === 'XZ') },
      { text: 'Click <b>2-Point Rectangle</b> (or press <kbd>R</kbd>) and click two opposite corners.', highlight: hl('rect'), check: on('sketch:done', (e) => e.profileType === 'rect') },
      { text: 'Exact size: click one corner of a new rectangle, then <b>type 40</b>, press <kbd>Tab</kbd>, <b>type 20</b>, press <kbd>Enter</kbd>.', hint: 'The green label shows the field you are typing in. Tab switches between width and height.', highlight: hl('rect'), check: on('sketch:done', (e) => e.profileType === 'rect' && e.typed) },
      { text: 'Draw a <b>Center Diameter Circle</b> (<kbd>C</kbd>): click the centre, then click again for the size (or type a diameter + Enter).', highlight: hl('circle'), check: on('sketch:done', (e) => e.profileType === 'circle') },
      { text: 'Draw a <b>Polygon</b> (<kbd>P</kbd>). Change its number of <b>sides</b> in the Sketch Palette on the right first if you like.', highlight: hl('poly'), check: on('sketch:done', (e) => e.profileType === 'ngon') },
      { text: 'Use <b>Line</b> (<kbd>L</kbd>): click 3 or more points, then click the <b>first point</b> again to close the shape.', hint: 'Double-click or Enter also closes it. Backspace removes the last point.', highlight: hl('line'), check: on('sketch:done', (e) => e.profileType === 'poly') },
      { text: 'Click <b>FINISH SKETCH</b> (green tick on the right of the toolbar).', highlight: hl('finish-sketch'), check: on('sketch:finish') },
      { text: 'Click a shaded <b>rectangle profile</b> to select it, and in Properties set its <b>Width</b> to <b>50</b>.', highlight: '#props-panel', check: on('props', (e) => e.sketch && e.field === 'param:w' && near(e.value, 50, 0.01)) },
    ],
  },
  {
    id: 'extrude',
    title: '6. Extrude',
    summary: 'Turn profiles into solids, cut holes, sketch on faces.',
    concept: '<b>Extrude</b> pulls a profile straight out of its sketch plane. It can make a <b>New Body</b>, <b>Join</b> onto bodies, or <b>Cut</b> material away. You can sketch on any <b>flat face</b> of a body, which is how holes and bosses are usually made.',
    steps: [
      { text: 'Select a profile and click <b>Extrude</b> (or press <kbd>E</kbd>).', hint: 'No sketch? Do lesson 5 first, or Create Sketch and draw a rectangle.', highlight: hl('extrude'), check: on('extrude:open') },
      { text: 'Drag the <b>blue arrow</b> in the viewport, or type <b>Distance 15</b>. Click <b>OK</b>. The sketch hides after it is used.', highlight: '.dialog', check: on('extrude', (e) => e.op === 'new' && near(e.height, 15, 0.01)) },
      { text: 'Sketch on a face: click <b>Create Sketch</b> and then click the <b>top face</b> of your block.', hint: 'Flat faces turn orange when you hover over them. Curved faces cannot be sketched on.', highlight: hl('sketch'), check: on('sketch:plane', (e) => e.kind === 'face') },
      { text: 'Draw a circle on the face, <b>Finish Sketch</b>, then <b>Extrude</b> it with Distance <b>-10</b> (into the block) and Operation <b>Cut</b>.', hint: 'A negative distance goes the other way. The red preview shows the material that will be removed.', highlight: hl('extrude'), check: on('extrude', (e) => e.op === 'cut' && e.affected > 0) },
      { text: 'Extrude a profile with Direction <b>Symmetric</b> (it grows both ways from the sketch).', check: on('extrude', (e) => e.direction === 'sym') },
      { text: 'Extrude a profile with a <b>Taper angle</b> of <b>10°</b> to make sloped sides.', check: on('extrude', (e) => Math.abs(e.taper) >= 1) },
    ],
  },
  {
    id: 'revolve',
    title: '7. Revolve & construction planes',
    summary: 'Spin profiles into round parts; make your own planes.',
    concept: '<b>Revolve</b> spins a profile around an axis, like a potter\'s wheel: rings, vases, wheels. <b>Construction planes</b> are reference planes you can sketch on anywhere, for example 30 mm above the ground.',
    steps: [
      { text: 'Create Sketch on the <b>XY</b> plane (the upright plane facing the front).', hint: 'Click a part of the XY plane with no body behind it - or open <b>Origin</b> in the Browser and click <b>XY</b>.', highlight: hl('sketch'), check: on('sketch:plane', (e) => e.plane === 'XY') },
      { text: 'Draw a rectangle to the <b>right</b> of the green vertical axis (it must not cross it), then <b>Finish Sketch</b>.', hint: 'E.g. from X = 30 to X = 40, height 20.', check: on('sketch:finish', (e) => e.sketch?.planeName === 'XY' && e.sketch.shapes.length > 0) },
      { text: 'Select the profile, click <b>Revolve</b>, keep the <b>vertical axis</b> and click <b>OK</b>. You made a ring!', highlight: hl('revolve'), check: on('revolve') },
      { text: 'Try a half revolve: Revolve a profile with an <b>Angle</b> of <b>180°</b>.', hint: 'Show the used sketch again with its eye icon in the Browser, select the profile, Revolve.', check: on('revolve', (e) => e.angle < 360) },
      { text: '<b>CONSTRUCT ▸ Offset Plane</b>: make a plane parallel to <b>XZ</b>, <b>30 mm</b> up.', highlight: hl('offset-plane'), check: on('plane:create', (e) => near(e.plane.offset, 30, 0.01)) },
      { text: 'Create Sketch on your new plane (click the orange square), draw a circle and Extrude it.', highlight: hl('sketch'), check: on('sketch:plane', (e) => e.kind === 'plane') },
    ],
  },
  {
    id: 'combine',
    title: '8. Combine: join, cut & intersect',
    summary: 'Boolean operations between bodies.',
    concept: '<b>Boolean</b> operations combine solids. <b>Join</b> merges them, <b>Cut</b> subtracts the tool from the target, and <b>Intersect</b> keeps only the volume they share. The <b>first</b> body you select is the target.',
    steps: [
      { text: 'Create a <b>Box</b> 40 × 20 × 40 (Width × Height × Depth).', highlight: hl('box'), check: on('body:create', (e) => e.kind === 'box' && near(e.params.width, 40, 0.01) && near(e.params.height, 20, 0.01) && near(e.params.depth, 40, 0.01)) },
      { text: 'Create a <b>Cylinder</b> (radius 8, height 40) and move it so it pokes through the box. Overlapping bodies turn <b style="color:#d9363e">red</b>.', hint: 'Use Move/Copy (M) or set the cylinder\'s Position X/Z to match the box in Properties.', check: state((app) => app.overlaps.some((p) => p.some((b) => b.kind === 'cylinder'))) },
      { text: 'Click the <b>box</b>, then <kbd>Shift</kbd>+click the <b>cylinder</b>. Click <b>Combine</b>, choose <b>Cut</b> and press OK.', hint: 'Order matters: the box (target) first, then the cylinder (tool). You can also Shift+click names in the Browser.', highlight: hl('combine'), check: on('combine', (e) => e.op === 'cut') },
      { text: 'Overlap two bodies again and <b>Join</b> them into one body.', highlight: hl('combine'), check: on('combine', (e) => e.op === 'join') },
      { text: 'Try <b>Intersect</b> with a box and a sphere that overlap. Only the shared part is kept.', highlight: hl('combine'), check: on('combine', (e) => e.op === 'intersect') },
    ],
  },
  {
    id: 'patterns',
    title: '9. Fillet, shell & patterns',
    summary: 'Round edges, hollow parts and repeat geometry.',
    concept: '<b>Fillets</b> round sharp edges. <b>Shell</b> hollows a solid (cups, boxes, enclosures). <b>Mirror</b> and <b>Patterns</b> copy geometry so you only model a feature once.',
    steps: [
      { text: 'Select a <b>Box</b> and click <b>Fillet</b> (<kbd>F</kbd>). Set a radius such as <b>3</b> and press OK.', highlight: hl('fillet'), check: on('fillet', (e) => e.radius > 0) },
      { text: 'Select a <b>Cylinder</b> and click <b>Shell</b>. Keep <b>Open top</b> ticked: you get a cup.', highlight: hl('shell'), check: on('shell') },
      { text: 'Select a body and use <b>CREATE ▾ ▸ Rectangular Pattern</b> to make <b>3 or more</b> copies.', highlight: hl('pattern'), check: on('pattern', (e) => e.kind === 'rect' && e.count >= 3) },
      { text: 'Move a small body to <b>Position X = 40</b>, then use <b>CREATE ▾ ▸ Circular Pattern</b> with Quantity 8.', highlight: hl('circpattern'), check: on('pattern', (e) => e.kind === 'circular') },
      { text: '<b>Mirror</b> a body across the <b>YZ</b> plane (CREATE ▾ ▸ Mirror).', highlight: hl('mirror'), check: on('mirror') },
    ],
  },
  {
    id: 'inspect',
    title: '10. Inspect, organise & export',
    summary: 'Measure, interference, section view, browser and STL.',
    concept: 'Before a part is made, engineers check its <b>dimensions</b>, <b>volume</b> and any <b>interference</b> (overlap) between parts, and look inside with a <b>section</b>. <b>STL</b> is the standard file format for 3D printing.',
    steps: [
      { text: 'Click <b>Measure</b> (<kbd>I</kbd>), then click two points (for example two corners). Corners snap with an orange dot.', highlight: hl('measure'), check: on('measure') },
      { text: 'Click <b>Interference</b> (INSPECT) to list any overlapping bodies.', highlight: hl('interference'), check: on('interference') },
      { text: 'Click <b>Section Analysis</b>, choose a plane and click OK to see inside your bodies.', hint: 'Remove it again from the Browser (Analysis folder, ✕).', highlight: hl('section'), check: on('section') },
      { text: 'In the <b>Browser</b>, double-click a body\'s name and <b>rename</b> it.', highlight: '#browser-panel', check: on('props', (e) => e.body && e.field === 'name') },
      { text: '<b>Hide</b> a body with the 👁 eye icon in the Browser.', highlight: '#browser-panel', check: on('visibility', (e) => e.body && !e.visible) },
      { text: '<b>Save</b> your design (disk icon in the top bar, or <kbd>Ctrl</kbd>+<kbd>S</kbd>).', highlight: hl('save'), check: on('save') },
      { text: '<b>File ▾ ▸ Export STL</b> to get a file you could send to a 3D printer.', highlight: hl('export'), check: on('export') },
    ],
  },
  {
    id: 'speed',
    title: '11. Work faster',
    summary: 'Marking menu, command search and the timeline.',
    concept: 'Fusion 360 users rarely hunt through the toolbar. They <b>right-click</b> for the marking menu, press <kbd>S</kbd> to search for a command, and use the <b>timeline</b> to step back through the design history.',
    steps: [
      { text: '<b>Right-click</b> (without dragging) on empty space in the viewport to open the <b>marking menu</b>.', check: on('marking') },
      { text: 'Choose any command from it - for example <b>Create Sketch</b> or <b>Box</b>.', check: on('tool') },
      { text: 'Press <kbd>S</kbd>, type <b>fillet</b> (or any command name) and press <kbd>Enter</kbd>.', highlight: hl('search'), check: on('search:run') },
      { text: 'In the <b>timeline</b> at the bottom, click an earlier icon to roll the design back in time.', highlight: '#timeline', check: on('timeline') },
      { text: 'Click the <b>last</b> button (▶|) in the timeline to go forward to the end again.', highlight: '#timeline', check: on('timeline', (e, app) => e.index === app.doc.history.length - 1) },
    ],
  },
  {
    id: 'table',
    challenge: true,
    title: '★ Challenge: build a table',
    summary: 'Use everything so far to model a small table.',
    concept: 'Challenges give you a goal, not exact clicks. Plan the parts first: <b>1 top + 4 legs</b>. Tip: start a <b>New Design</b> (File ▾) so old bodies don\'t get in the way.',
    steps: [
      {
        text: 'Table top: a <b>Box 120 × 5 × 60</b> raised to <b>Position Y = 40</b>.',
        hint: 'Create the box with Width 120, Height 5, Depth 60 and Position Y 40 straight in the Box dialog.',
        check: state((app) => !!tableTop(app)),
      },
      {
        text: 'One leg: a <b>Cylinder</b> with radius <b>3</b> and height <b>40</b>, standing on the ground under a corner of the top.',
        hint: 'Put it near a corner, for example X = 50, Z = 20 (the top spans X −60…60, Z −30…30).',
        check: state((app) => legs(app).length >= 1),
      },
      {
        text: 'Get <b>4 legs</b>, one under each corner, using <b>Rectangular Pattern</b>, <b>Mirror</b> or <b>Copy</b>.',
        hint: 'Rectangular Pattern with Quantity X 2 (spacing 100) and Quantity Z 2 (spacing 40) makes all four at once.',
        check: state((app) => new Set(legs(app).map(([b, top]) => `${Math.sign(b.mesh.position.x - top.mesh.position.x)}${Math.sign(b.mesh.position.z - top.mesh.position.z)}`)).size >= 4),
      },
      { text: 'Check there is <b>no interference</b> (the legs should just touch the top), then <b>Join</b> all 5 bodies with Combine.', hint: 'Select the top first, then Shift+click each leg. Touching bodies can be joined.', check: on('combine', (e) => e.op === 'join') },
    ],
  },
  {
    id: 'mug',
    challenge: true,
    title: '★ Challenge: model a mug',
    summary: 'A hollow cylinder with a handle.',
    concept: 'A mug is a <b>cylinder</b>, <b>hollowed</b> with Shell (or a Cut), plus a <b>torus</b> handle that is <b>joined</b> on. This is how real CAD models are built: simple shapes plus a few features.',
    steps: [
      { text: 'Create a <b>Cylinder</b> with radius <b>20</b> and height <b>45</b>.', check: on('body:create', (e) => e.kind === 'cylinder' && near(e.params.radius, 20, 0.01) && near(e.params.height, 45, 0.01)) },
      { text: 'Hollow it with <b>Shell</b> (thickness 3, open top) - or cut a smaller cylinder out with Combine.', check: (e) => (e.type === 'shell') || (e.type === 'combine' && e.op === 'cut') },
      { text: 'Handle: create a <b>Torus</b> (ring 12, tube 3), rotate it <b>90°</b> about X in Properties and move it so it overlaps the side of the mug.', hint: 'Rotation X = 90. Then set Position X to about 20 (the mug\'s radius) and Y to about 10.', check: state((app) => app.overlaps.some((p) => p.some((b) => b.kind === 'torus'))) },
      { text: '<b>Join</b> the handle to the mug, then <b>Export STL</b>. Your mug is ready to print!', check: on('export', (e, app) => app.doc.bodies.length >= 1) },
    ],
  },
];


function tableTop(app) {
  return ofKind(app, 'box').find((b) => near(b.params.width, 120, 0.5) && near(b.params.height, 5, 0.5) && near(b.params.depth, 60, 0.5) && near(b.mesh.position.y, 40, 0.6));
}

function legs(app) {
  const top = tableTop(app);
  if (!top) return [];
  const tb = top.worldBox();
  return ofKind(app, 'cylinder')
    .filter((b) => near(b.params.radius, 3, 0.5) && near(b.params.height, 40, 0.6) && near(b.mesh.position.y, 0, 0.6))
    .filter((b) => { const p = b.mesh.position; return p.x > tb.min.x && p.x < tb.max.x && p.z > tb.min.z && p.z < tb.max.z; })
    .map((b) => [b, top]);
}

// ---------------------------------------------------------------------------
// Tutorial engine + panel
// ---------------------------------------------------------------------------
const STORE = 'minicad-progress';
const STEP_POINTS = 10;
const LESSON_BONUS = 25;

export class Tutorials {
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('learn-panel');
    this.el = document.getElementById('learn');
    this.lesson = null;
    this.step = 0;
    this.hintOpen = false;
    try { this.progress = JSON.parse(localStorage.getItem(STORE)) || null; } catch { this.progress = null; }
    this.progress ||= { done: {}, points: 0 };

    document.getElementById('learn-close').onclick = () => this.toggle(false);
    // event name last, so a payload field called "type" can't overwrite it
    bus.on('*', (type, data) => this.#onEvent({ ...data, type }));
    bus.on('toolbar:rendered', () => this.refreshHighlight());
    this.render();
  }

  get isOpen() { return !this.panel.classList.contains('hidden'); }

  toggle(force) {
    const show = force ?? !this.isOpen;
    this.panel.classList.toggle('hidden', !show);
    this.app.vp.resize();
    if (!show) this.#highlight(null);
    else this.render();
  }

  #save() { try { localStorage.setItem(STORE, JSON.stringify(this.progress)); } catch { /* ignore */ } }

  doneSteps(id) { return this.progress.done[id] || []; }

  // first lesson that is not finished yet (or the first one if all are done)
  nextLesson() { return LESSONS.find((l) => !this.isLessonDone(l)) || LESSONS[0]; }

  summary() {
    const total = LESSONS.reduce((n, l) => n + l.steps.length, 0);
    const done = LESSONS.reduce((n, l) => n + this.doneSteps(l.id).length, 0);
    return { total, done, points: this.progress.points, lessons: LESSONS.length };
  }

  showList() { this.lesson = null; this.toggle(true); this.render(); }
  isLessonDone(l) { return this.doneSteps(l.id).length >= l.steps.length; }

  startLesson(id) {
    this.lesson = LESSONS.find((l) => l.id === id);
    const done = this.doneSteps(id);
    this.step = this.lesson.steps.findIndex((_, i) => !done.includes(i));
    if (this.step < 0) { this.progress.done[id] = []; this.step = 0; }
    this.hintOpen = false;
    this.toggle(true);
    this.render();
  }

  #onEvent(e) {
    if (!this.lesson || this.step >= this.lesson.steps.length) return;
    const s = this.lesson.steps[this.step];
    let ok = false;
    try { ok = s.check(e, this.app); } catch { ok = false; }
    if (ok) this.#complete(true);
  }

  #complete(earned) {
    const id = this.lesson.id;
    const done = (this.progress.done[id] ||= []);
    if (!done.includes(this.step)) {
      done.push(this.step);
      if (earned) this.progress.points += STEP_POINTS;
    }
    this.step++;
    this.hintOpen = false;
    if (this.step >= this.lesson.steps.length) {
      if (earned) this.progress.points += LESSON_BONUS;
      toast(`🎉 Lesson complete: <b>${this.lesson.title}</b> (+${LESSON_BONUS} bonus)`, 'ok', 4000);
    } else if (earned) {
      toast(`✓ Step done  +${STEP_POINTS}`, 'ok', 1600);
    }
    this.#save();
    this.render();
  }

  #highlight(selector) {
    this.highlightSel = selector;
    for (const el of document.querySelectorAll('.tut-highlight')) el.classList.remove('tut-highlight');
    if (!selector) return;
    const visible = [...document.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
    // a command inside a ▾ menu: highlight the menu button that contains it
    const tool = selector.match(/data-tool="([^"]+)"/)?.[1];
    const targets = visible.length || !tool ? visible : [...document.querySelectorAll(`[data-contains~="${tool}"]`)];
    for (const el of targets) el.classList.add('tut-highlight');
  }

  // the toolbar is re-drawn when entering/leaving a sketch, so re-apply the highlight
  refreshHighlight() { if (this.lesson) this.#highlight(this.highlightSel); }

  render() {
    const totalSteps = LESSONS.reduce((n, l) => n + l.steps.length, 0);
    const doneSteps = LESSONS.reduce((n, l) => n + this.doneSteps(l.id).length, 0);
    const score = `
      <div class="learn-score">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span><span class="pts">${this.progress.points}</span> points</span>
          <span style="color:var(--muted)">${doneSteps} / ${totalSteps} steps</span>
        </div>
        <div class="progress"><div style="width:${(doneSteps / totalSteps) * 100}%"></div></div>
      </div>`;

    if (!this.lesson) {
      this.#highlight(null);
      this.el.innerHTML = score + LESSONS.map((l) => {
        const n = this.doneSteps(l.id).length;
        const done = n >= l.steps.length;
        return `<div class="lesson-card ${done ? 'done' : ''} ${l.challenge ? 'challenge' : ''}" data-id="${l.id}">
          <span class="t">${l.title}</span><span class="badge">${done ? '✓ Done' : `${n}/${l.steps.length}`}</span>
          <span class="s">${l.summary}</span></div>`;
      }).join('') + `<div class="learn-foot"><button class="btn small" data-a="reset">Reset progress</button><button class="btn small" data-a="home">Start screen</button></div>`;
      for (const c of this.el.querySelectorAll('.lesson-card')) c.onclick = () => this.startLesson(c.dataset.id);
      this.el.querySelector('[data-a=reset]').onclick = () => {
        if (!confirm('Reset all tutorial progress and points?')) return;
        this.progress = { done: {}, points: 0 };
        this.#save();
        this.render();
      };
      this.el.querySelector('[data-a=home]').onclick = () => this.onHome?.();
      return;
    }

    const l = this.lesson;
    const finished = this.step >= l.steps.length;
    const idx = LESSONS.indexOf(l);
    const next = LESSONS[idx + 1];
    this.el.innerHTML = score + `
      <div class="lesson-head">
        <button class="btn small" data-a="back">← All lessons</button>
        <h3>${l.title}</h3><p>${l.summary}</p>
      </div>
      <div class="concept">💡 ${l.concept}</div>
      ${l.steps.map((s, i) => {
        const cls = i < this.step || this.doneSteps(l.id).includes(i) && i !== this.step ? 'done' : i === this.step ? 'current' : 'todo';
        return `<div class="step ${cls}">
          <span class="num">${cls === 'done' ? '✓' : i + 1}</span>
          <div class="txt">${s.text}
            ${i === this.step && this.hintOpen && s.hint ? `<div class="hint">💡 ${s.hint}</div>` : ''}
            ${i === this.step ? `<div class="acts">
              ${s.hint && !this.hintOpen ? '<button class="btn small" data-a="hint">Show hint</button>' : ''}
              <button class="btn small" data-a="skip" title="Skip without points">Skip step</button></div>` : ''}
          </div></div>`;
      }).join('')}
      ${finished ? `<div class="lesson-done"><b>Lesson complete! 🎉</b><br><br>
        ${next ? `<button class="btn primary" data-a="next">Next: ${next.title} →</button>` : '<b>You finished every lesson. Great work!</b>'}
        <br><br><button class="btn small" data-a="redo">Do this lesson again</button></div>` : ''}`;

    const act = (a, fn) => { const b = this.el.querySelector(`[data-a=${a}]`); if (b) b.onclick = fn; };
    act('back', () => { this.lesson = null; this.render(); });
    act('hint', () => { this.hintOpen = true; this.render(); });
    act('skip', () => this.#complete(false));
    act('next', () => this.startLesson(next.id));
    act('redo', () => { this.progress.done[l.id] = []; this.#save(); this.startLesson(l.id); });
    this.el.querySelector('.step.current')?.scrollIntoView({ block: 'nearest' });
    this.#highlight(finished ? null : l.steps[this.step].highlight);
  }
}
