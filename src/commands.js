import { bus } from './events.js';
import { toggleTheme } from './theme.js';

// Every command in one place: used by the toolbar, its dropdown menus, keyboard
// shortcuts, the right-click marking menu and the S command search.
export function buildCommands(app, ui) {
  const C = {};
  const add = (id, label, icon, run, opts = {}) => { C[id] = { id, label, icon, run, ...opts }; };

  // ---- sketch ----
  add('sketch', 'Create Sketch', 'sketch', () => app.createSketch(), { desc: 'Pick a plane or flat face, then draw 2D profiles.' });
  add('line', 'Line', 'line', () => app.sketchTool('line'), { key: 'L', desc: 'Connected lines; close them to make a profile.' });
  add('rect', '2-Point Rectangle', 'rect', () => app.sketchTool('rect'), { key: 'R', desc: 'Rectangle from two corners. Type 40 Tab 20 Enter for exact size.' });
  add('circle', 'Center Diameter Circle', 'circle', () => app.sketchTool('circle'), { key: 'C', desc: 'Circle from its centre. Type a diameter for an exact size.' });
  add('poly', 'Polygon', 'poly', () => app.sketchTool('poly'), { key: 'P', desc: 'Regular polygon. Set the number of sides in the Sketch Palette.' });
  add('pline', 'Open Line', 'pline', () => app.sketchTool('pline'), { desc: 'Lines that stay open (Enter to finish): a path for Sweep, Pipe, Rib, Pattern on Path.' });
  add('crect', 'Center Rectangle', 'crect', () => app.sketchTool('crect'), { desc: 'Rectangle from its centre and a corner.' });
  add('rect3', '3-Point Rectangle', 'rect3', () => app.sketchTool('rect3'), { desc: 'Rectangle at any angle: one side, then the width.' });
  add('circle2', '2-Point Circle', 'circle2', () => app.sketchTool('circle2'), { desc: 'Circle from the two ends of a diameter.' });
  add('circle3', '3-Point Circle', 'circle3', () => app.sketchTool('circle3'), { desc: 'Circle through three points.' });
  add('arc', '3-Point Arc', 'arc', () => app.sketchTool('arc'), { desc: 'Arc from start, end and a point on it (an open path).' });
  add('ellipse', 'Ellipse', 'ellipse', () => app.sketchTool('ellipse'), { desc: 'Ellipse from its centre, long axis and short axis.' });
  add('slot', 'Center to Center Slot', 'slot', () => app.sketchTool('slot'), { desc: 'Rounded slot between two centres.' });
  add('spline', 'Fit Point Spline', 'spline', () => app.sketchTool('spline'), { desc: 'Smooth curve through points: closed profile or open path.' });
  add('sketch-fillet', 'Sketch Fillet', 'sfillet', () => app.sketchFilletDialog(), { desc: 'Round the corners of a sketch profile.' });
  add('sketch-offset', 'Offset', 'offset', () => app.sketchOffsetDialog(), { desc: 'Bigger or smaller copy of a profile all round.' });
  add('sketch-mirror', 'Sketch Mirror', 'mirror', () => app.sketchMirrorDialog(), { desc: 'Mirrored copy of a profile across a sketch axis.' });
  add('sketch-rectpattern', 'Sketch Rectangular Pattern', 'pattern', () => app.sketchRectPatternDialog(), { desc: 'Copies of a profile in rows and columns.' });
  add('sketch-circpattern', 'Sketch Circular Pattern', 'circpattern', () => app.sketchCircPatternDialog(), { desc: 'Copies of a profile around a centre.' });
  add('sketch-move', 'Sketch Move/Copy', 'move', () => app.sketchMoveDialog(), { desc: 'Move or rotate a profile inside the sketch.' });
  add('sketch-scale', 'Sketch Scale', 'scale', () => app.sketchScaleDialog(), { desc: 'Resize a profile around its centre.' });
  add('sketch-dimension', 'Sketch Dimension', 'dimension', () => app.sketchDimensionDialog(), { key: 'D', desc: 'Type exact sizes and positions for a profile.' });
  add('sketch-constraint', 'Sketch Constraints', 'constraint', () => app.sketchConstraintDialog(), { desc: 'Concentric, horizontal, vertical, equal, symmetric, parallel.' });
  add('finish-sketch', 'Finish Sketch', 'finish', () => app.finishSketch(), { desc: 'Leave the sketch and go back to the 3D tools.' });
  add('lookat', 'Look At', 'lookat', () => app.lookAt(), { desc: 'Turn the view square-on to the sketch plane.' });

  // ---- create ----
  add('extrude', 'Extrude', 'extrude', () => app.extrude(), { key: 'E', desc: 'Pull a sketch profile into a 3D body, or cut with it.' });
  add('presspull', 'Press Pull', 'extrude', () => app.extrude(), { key: 'Q', desc: 'Same as Extrude in this version.' });
  add('revolve', 'Revolve', 'revolve', () => app.revolve(), { desc: 'Spin a profile around an axis (vases, wheels, rings).' });
  for (const k of ['box', 'cylinder', 'sphere', 'torus', 'cone']) {
    add(k, k[0].toUpperCase() + k.slice(1), k, () => app.createPrimitive(k), { desc: `Solid ${k} with typed dimensions.` });
  }
  add('coil', 'Coil', 'coil', () => app.createPrimitive('coil'), { desc: 'Spring / helix with typed diameter, pitch and turns.' });
  add('loft', 'Loft', 'loft', () => app.loftDialog(), { desc: 'Blend between two or three profiles on different planes.' });
  add('sweep', 'Sweep', 'sweep', () => app.sweepDialog(), { desc: 'Move a profile along a path.' });
  add('pipe', 'Pipe', 'pipe', () => app.pipeDialog(), { desc: 'Round (or hollow) tube along a sketch path.' });
  add('rib', 'Rib / Web', 'rib', () => app.ribDialog(), { desc: 'Thin wall from an open sketch line.' });
  add('hole', 'Hole', 'hole', () => app.holeDialog(), { key: 'H', desc: 'Simple, counterbore or countersink hole at a point on a face.' });
  add('thread', 'Thread', 'thread', () => app.threadDialog(), { desc: 'Modelled screw thread on a cylinder.' });
  add('mirror', 'Mirror', 'mirror', () => app.mirrorDialog(), { desc: 'Mirrored copy across an origin plane.' });
  add('pattern', 'Rectangular Pattern', 'pattern', () => app.patternDialog(), { desc: 'Copies in rows and columns.' });
  add('circpattern', 'Circular Pattern', 'circpattern', () => app.circularPatternDialog(), { desc: 'Copies around an axis.' });
  add('pathpattern', 'Pattern on Path', 'pathpattern', () => app.pathPatternDialog(), { desc: 'Copies along a sketch path.' });

  // ---- modify ----
  add('fillet', 'Fillet', 'fillet', () => app.filletDialog(), { key: 'F', desc: 'Round the edges of a box.' });
  add('chamfer', 'Chamfer', 'chamfer', () => app.chamferDialog(), { desc: 'Bevel the edges of a box or cylinder.' });
  add('shell', 'Shell', 'shell', () => app.shellDialog(), { desc: 'Hollow a box, cylinder or sphere.' });
  add('draft', 'Draft', 'draft', () => app.draftDialog(), { desc: 'Tilt the side faces so the part comes out of a mould.' });
  add('offset-face', 'Offset Face', 'offsetface', () => app.offsetFaceDialog(), { desc: 'Push or pull one flat face.' });
  add('split-body', 'Split Body', 'split', () => app.splitBodyDialog(), { desc: 'Cut a body in two along a plane.' });
  add('combine', 'Combine', 'combine', () => app.combineDialog(), { desc: 'Join, Cut or Intersect bodies (select the target first).' });
  add('align', 'Align', 'align', () => app.alignDialog(), { desc: 'Line one body up with another (select the moving body first).' });
  add('physical-material', 'Physical Material', 'physmat', () => app.physicalMaterialDialog(), { desc: 'What the body is made of (density, mass).' });
  add('translate', 'Move/Copy', 'move', () => app.moveDialog('translate'), { key: 'M', desc: 'Move, rotate or scale bodies with the gizmo.' });
  add('rotate', 'Rotate', 'rotate', () => app.moveDialog('rotate'), { desc: 'Move/Copy in rotate mode.' });
  add('scale', 'Scale', 'scale', () => app.moveDialog('scale'), { desc: 'Move/Copy in scale mode.' });
  add('appearance', 'Appearance', 'appearance', () => app.appearanceDialog(), { key: 'A', desc: 'Colour and material.' });
  add('duplicate', 'Copy', 'copy', () => app.duplicate(), { shortcut: 'Ctrl+D', desc: 'Duplicate the selected bodies.' });
  add('ground', 'Drop to Ground', 'ground', () => app.dropToGround(), { desc: 'Rest the selection on the ground plane.' });
  add('delete', 'Delete', 'trash', () => app.deleteSelection(), { shortcut: 'Del', desc: 'Delete the selected bodies or profiles.' });

  // ---- construct / inspect / insert ----
  add('offset-plane', 'Offset Plane', 'plane', () => app.offsetPlaneDialog(), { desc: 'Construction plane to sketch on.' });
  add('plane-angle', 'Plane at Angle', 'planeangle', () => app.planeAtAngleDialog(), { desc: 'Plane through an axis, turned by an angle.' });
  add('plane-tangent', 'Tangent Plane', 'planetangent', () => app.tangentPlane(), { desc: 'Plane touching a face at the point you click.' });
  add('midplane', 'Midplane', 'midplane', () => app.midplaneDialog(), { desc: 'Plane halfway between two planes.' });
  add('plane-3pt', 'Plane Through Three Points', 'plane3', () => app.planeThreePoints(), { desc: 'Plane through three clicked points.' });
  add('plane-path', 'Plane Along Path', 'planepath', () => app.planeAlongPathDialog(), { desc: 'Plane square to a sketch path.' });
  add('axis-cyl', 'Axis Through Cylinder/Cone/Torus', 'axis', () => app.axisThroughBody(), { desc: 'Axis down the middle of a round body.' });
  add('axis-2pt', 'Axis Through Two Points', 'axis', () => app.axisTwoPoints(), { desc: 'Axis through two clicked points.' });
  add('axis-perp', 'Axis Perpendicular to Face at Point', 'axis', () => app.axisPerpendicular(), { desc: 'Axis sticking straight out of a face.' });
  add('point-pick', 'Point at Vertex / on Face', 'cpoint', () => app.pointPick(), { desc: 'Construction point where you click.' });
  add('point-center', 'Point at Centre', 'cpoint', () => app.pointAtCenter(), { desc: 'Construction point at the centre of a body.' });
  add('measure', 'Measure', 'measure', () => { app.cancelTools(); bus.emit('tool', { tool: 'measure' }); app.measure.start(); bus.emit('tool:changed'); }, { key: 'I', desc: 'Distance between two points.' });
  add('interference', 'Interference', 'interference', () => app.interference(), { desc: 'List bodies that overlap.' });
  add('section', 'Section Analysis', 'section', () => app.sectionDialog(), { desc: 'Cut the view open to see inside.' });
  add('zebra', 'Zebra Analysis', 'zebra', () => app.analysisDialog('zebra'), { desc: 'Reflected stripes show how smooth surfaces are.' });
  add('draft-analysis', 'Draft Analysis', 'draftana', () => app.analysisDialog('draft'), { desc: 'Colour faces by draft angle (for moulding).' });
  add('curvature', 'Curvature Map Analysis', 'curvature', () => app.analysisDialog('curvature'), { desc: 'Colour surfaces by how much they curve.' });
  add('com', 'Centre of Mass', 'com', () => app.centerOfMass(), { desc: 'Balance point, mass, volume and area.' });
  add('insert-mesh', 'Insert Mesh', 'insert', () => app.insertMesh(), { desc: 'Bring in an STL file.' });

  // ---- view ----
  add('view-home', 'Home View', 'home', () => app.vp.setView('home'), { repeatable: false });
  add('view-top', 'Top View', 'box', () => app.vp.setView('top'), { repeatable: false });
  add('view-front', 'Front View', 'box', () => app.vp.setView('front'), { repeatable: false });
  add('view-right', 'Right View', 'box', () => app.vp.setView('right'), { repeatable: false });
  add('fit', 'Fit', 'fit', () => app.fitAll(), { shortcut: 'F6', repeatable: false });
  add('orbit', 'Orbit', 'orbit', () => app.setNavMode('orbit'), { repeatable: false });
  add('pan', 'Pan', 'pan', () => app.setNavMode('pan'), { repeatable: false });
  add('zoom', 'Zoom', 'zoom', () => app.setNavMode('zoom'), { repeatable: false });
  add('display-shaded', 'Shaded', 'display', () => app.setDisplay('shaded'), { repeatable: false });
  add('display-edges', 'Shaded with Visible Edges', 'display', () => app.setDisplay('edges'), { repeatable: false });
  add('wire', 'Wireframe', 'wire', () => app.setDisplay('wire'), { repeatable: false });
  add('grid', 'Layout Grid', 'grid', () => app.setGrid(!app.vp.grid.visible), { repeatable: false });
  add('theme', 'Dark / Light Theme', 'moon', () => toggleTheme(), { repeatable: false, desc: 'Switch between the dark and light look.' });

  // ---- file / app ----
  add('new', 'New Design', 'new', () => app.newDesign(), { repeatable: false });
  add('open', 'Open…', 'open', () => app.openFile(), { repeatable: false });
  add('save', 'Save', 'save', () => app.saveFile(), { shortcut: 'Ctrl+S', repeatable: false });
  add('export', 'Export STL', 'export', () => app.exportSTL(), { repeatable: false });
  add('undo', 'Undo', 'undo', () => { if (app.workspace === 'boxgen') return app.boxgen.undo(); app.cancelTools(); app.doc.undo(); }, { shortcut: 'Ctrl+Z', repeatable: false });
  add('redo', 'Redo', 'redo', () => { if (app.workspace === 'boxgen') return app.boxgen.redo(); app.cancelTools(); app.doc.redo(); }, { shortcut: 'Ctrl+Y', repeatable: false });
  add('ws-design', 'Design Workspace', 'component', () => app.setWorkspace('design'), { repeatable: false, desc: 'Fusion-style modelling with sketches and features.' });
  add('ws-boxgen', 'IoT BoxGen Workspace', 'boxgen', () => app.setWorkspace('boxgen'), { repeatable: false, desc: 'Generate a 3D-printable enclosure around electronic components.' });
  add('home', 'Start Screen', 'home', () => ui.home(), { repeatable: false });
  add('tutorials', 'Tutorials', 'help', () => ui.tutorials.toggle(true), { repeatable: false });
  add('search', 'Command Search', 'search', () => ui.search(), { key: 'S', repeatable: false });
  add('help', 'Keyboard & Mouse Help', 'help', () => ui.help(), { shortcut: '?', repeatable: false });

  for (const c of Object.values(C)) {
    const run = c.run;
    c.run = () => {
      if (c.repeatable !== false) app.lastCommand = c;
      run();
    };
  }

  // keyboard shortcuts (lower-case key -> run)
  app.shortcuts = {};
  for (const c of Object.values(C)) if (c.key) app.shortcuts[c.key.toLowerCase()] = c.run;
  app.shortcuts.delete = C.delete.run;
  app.shortcuts.backspace = C.delete.run;
  app.shortcuts['?'] = C.help.run;
  app.commands = C;
  return C;
}

export function shortcutOf(c) { return c.key || c.shortcut || ''; }
