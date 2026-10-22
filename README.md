# MiniCAD Learn

A browser-based 3D modelling learning tool that follows the layout and workflow of Fusion 360, with built-in interactive tutorials.
Final year project prototype: *A Web-Based Interactive 3D Modelling Learning Tool

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. `npm run build` makes a static build in `dist/`.

## Fusion 360-style workspace

| Area | What it does |
| --- | --- |
| **Application bar** | File ▾ menu (New, Open, Save, Export STL, Insert Mesh), Save, Undo/Redo, document name, command search, Home (start screen), Tutorials, help |
| **Toolbar** | DESIGN workspace, SOLID tab, and tool groups whose **▾ menus** list every command: CREATE, MODIFY, CONSTRUCT, INSPECT, INSERT. While sketching, a contextual **SKETCH** tab with **FINISH SKETCH** |
| **Browser** | Tree with Document Settings, Named Views, Origin (XY/XZ/YZ planes), Analysis, Construction, Sketches (with their profiles) and Bodies. Eye icons, rename, double-click a sketch to edit it |
| **Timeline** | Playback controls (\|◀ ◀ ▶ ▶\|) and one icon per step. Click any step to roll the design back or forward |
| **Navigation bar** | Orbit, Pan, Zoom, Fit, Look At, display style (shaded / edges / wireframe), grid |
| **Marking menu** | Right-click (no drag) for a radial menu (Repeat, Undo, Press Pull, Delete, Create Sketch, Move/Copy, Redo, Fillet) plus context commands |
| **Command search** | Press `S` and type a command name |

## Modelling features

The toolbar icons are kept to a short beginner set; every other command is in the group's **▾ menu** (and in command search, `S`).

- **Create Sketch** on an origin plane, a construction plane, or any **flat face** of a body. Sketch tools: **Line**, **Open Line** (open path), **2-Point / Center / 3-Point Rectangle**, **Center Diameter / 2-Point / 3-Point Circle**, **3-Point Arc**, **Polygon**, **Ellipse**, **Center to Center Slot**, **Fit Point Spline** (closed profile or open path). While drawing, **type exact sizes** (e.g. `40` Tab `20` Enter); the line label shows length and angle. Sketch Palette with Look At, grid, snap, dimension labels and polygon sides.
- **Sketch modify:** Sketch Fillet, Offset, Sketch Mirror, Sketch Rectangular / Circular Pattern, Sketch Move/Copy, Sketch Scale, **Sketch Dimension** (`D`) and **Sketch Constraints** (concentric, horizontal, vertical, equal, symmetric, parallel; applied once rather than kept by a solver).
- **Extrude** (drag the arrow or type a distance; One Side / Symmetric, start offset, taper; New Body / Join / Cut / Intersect), **Revolve** (around the sketch axes or a construction axis), **Sweep** (profile along a path, twist, end scale), **Loft** (2-3 profiles), **Rib / Web**, **Hole** (`H`; simple, counterbore, countersink, through all, drill point), **Thread** (modelled, on cylinders).
- Primitives: Box, Cylinder, Sphere, Torus, Cone, **Coil**, **Pipe** (solid or hollow, along a path).
- **Modify:** Fillet and **Chamfer** (box edges, cylinder top/bottom edges), **Shell**, **Draft**, **Offset Face**, **Split Body**, Combine (join/cut/intersect), **Align**, Move/Copy (translate/rotate/scale gizmo), **Physical Material** (density → mass), Appearance, Copy, Drop to Ground, Delete.
- **Patterns:** Mirror, Rectangular Pattern, Circular Pattern (origin or construction axis), **Pattern on Path**.
- **Construct:** Offset Plane, Plane at Angle, Tangent Plane, Midplane, Plane Through Three Points, Plane Along Path; Axis Through Cylinder/Cone/Torus, Axis Through Two Points, Axis Perpendicular to Face; Point at Vertex/on Face, Point at Centre.
- **Inspect:** Measure (with corner snapping), **Interference** (precise BVH check: touching is allowed), **Section Analysis**, **Zebra**, **Draft** and **Curvature Map** analysis, **Centre of Mass** (with mass, volume and area); size, volume and mass in Properties.
- **Insert Mesh** (STL), Export STL, Save/Open `.minicad.json`, automatic session restore.

## IoT BoxGen workspace

A second workspace (switch with the **DESIGN ▾ / IOT BOXGEN ▾** button, or pick **IoT Enclosure** on the start screen) that generates 3D-printable enclosures for electronics projects.

- **Component library:** ESP32 DevKit V1, Arduino Uno R3, IR obstacle sensor, HC-SR04 ultrasonic sensor, SG90 servo, 18650 holder, 9V battery, plus your own **custom components** (size, mounting, one port). Search box at the top.
- **Placement:** drag components on the enclosure floor, `R` / `Shift+R` rotates 90°, arrow keys nudge (Shift = 10 mm), `Del` deletes, `Ctrl+D` duplicates, `Ctrl+Z` / `Ctrl+Y` undo / redo. The inspector edits X / Y (height) / Z exactly. Ports snap flush to a wall when dragged close; **Snap to wall** does it for you.
- **Enclosure:** **Auto-Fit** (smallest box + padding), **Arrange** (packs the parts in rows, then fits), inner size, wall thickness, corner radius, lid lip tolerance, standoff height, cutout clearance, ventilation slots, screw or friction lid.
- **Generated geometry:** shell with rounded corners, PCB standoffs with pilot holes, floor screw holes, corner screw pillars, port and sensor cutouts in the walls (or the lid, for top openings), vent slots, and a lid with an inset lip and countersunk screw holes. Booleans run in a Web Worker so the page stays responsive.
- **Views:** Assembled, Exploded, Base only, Lid only, plus Components / X-Ray / Wireframe / Labels toggles. Live checks flag parts that stick out, overlap, hit a pillar or are too tall, and ports that don't reach a wall.
- **Export:** Base and Lid as binary **STL**, laid flat (Z up) and ready to slice; or **Edit in Design workspace** to keep modelling them with the Fusion tools.

Board dimensions, hole patterns and port positions are taken from published drawings and rounded; check them against your own parts before printing.

## Learning

A start screen asks whether to resume your last design or start something new, then offers **Tutorials**, **Sketch**, **3D Objects** or **IoT Enclosure**. There are 11 guided lessons and 2 challenges. Each step is checked automatically as you work, with hints, highlighted tools (including tools inside ▾ menus), points and saved progress.

## Code layout

- `src/app.js`: application commands (sketch, features, modify, inspect, file I/O)
- `src/commands.js`: command registry used by the toolbar, menus, shortcuts, marking menu and search
- `src/model.js`: bodies, sketches, construction planes, parametric geometry (extrude, revolve), document and undo history
- `src/ops.js`: boolean operations (three-bvh-csg), shell, split, patterns, mirror, precise interference (three-mesh-bvh)
- `src/geometry.js`: pure geometry: profile outlines (fillets, splines, offsets), sweep/loft/lathe/coil generators, chamfered box, mass properties, curvature
- `src/features.js`: the extra Fusion commands (Loft, Sweep, Pipe, Rib, Hole, Thread, Draft, Offset Face, Split, Align, construction geometry, analyses, sketch modify tools)
- `src/boxgen/`: IoT BoxGen workspace: `library.js` (component data), `enclosure.js` (parametric base/lid geometry), `worker.js` (builds it off the main thread), `boxgen.js` (scene, panels, placement, export)
- `src/tools/`: sketch tool, measure tool, extrude drag arrow
- `src/ui/`: toolbar/app bar, browser, properties, timeline, overlays (nav bar, sketch palette, marking menu, search, help), dialogs, start screen
- `src/tutorials.js`: lesson content and the tutorial engine

## Keyboard shortcuts

`L` line · `R` rectangle · `C` circle · `P` polygon · `D` sketch dimension · `H` hole · `E` extrude · `Q` press pull · `F` fillet · `M` move/copy · `A` appearance · `I` measure · `S` command search · `F6` fit · `Del` delete · `Ctrl+D` copy · `Ctrl+Z` / `Ctrl+Y` undo / redo · `Ctrl+S` save · `Esc` cancel / finish sketch · `?` help
