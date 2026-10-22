// IoT BoxGen component library. All sizes in millimetres.
//
// Each component is a box in its own local frame: width along X, depth along Z,
// height up Y, centred on X/Z with its bottom at y = 0. "front" is the +Z edge,
// "back" -Z, "right" +X, "left" -X, "top" the upper face.
//
//   mount: 'standoff' - PCB sits on screw bosses (standoffs) at the given holes
//          'floor'    - screwed straight down through the enclosure floor
//          'none'     - glued / strapped / held by its cutout
//   standoffs: [{ x, z, holeDiameter }] hole centres relative to the component centre
//   cutouts:   [{ side, shape: 'rect'|'circle', width, height, offset, offsetY }]
//     side      front|back|left|right|top (local). A wall cutout is cut into the enclosure
//               wall that side ends up facing, when the component sits near that wall.
//     width     rect width (or circle diameter) along the edge
//     height    rect height (circles use width)
//     offset    position along the edge from its centre (top cutouts: x offset)
//     offsetY   centre height above the component's bottom (top cutouts: z offset)
//
// Port positions and hole patterns follow the boards' published drawings where
// available and are rounded; check them against your own parts before printing.

export const CATEGORIES = [
  { id: 'mcu', label: 'Microcontrollers', color: '#2f9e44' },
  { id: 'sensor', label: 'Sensors & Actuators', color: '#1c7ed6' },
  { id: 'power', label: 'Power', color: '#e8590c' },
  { id: 'custom', label: 'Custom', color: '#7c3aed' },
];

export const LIBRARY = [
  {
    id: 'esp32-devkit-v1', name: 'ESP32 DevKit V1', category: 'mcu',
    dimensions: { width: 55, depth: 28, height: 13 },
    mount: 'standoff',
    standoffs: [
      { x: -25, z: -11.5, holeDiameter: 3 }, { x: 25, z: -11.5, holeDiameter: 3 },
      { x: -25, z: 11.5, holeDiameter: 3 }, { x: 25, z: 11.5, holeDiameter: 3 },
    ],
    cutouts: [{ side: 'left', shape: 'rect', width: 8, height: 3.5, offset: 0, offsetY: 3.4, label: 'Micro-USB' }],
  },
  {
    id: 'arduino-uno', name: 'Arduino Uno R3', category: 'mcu',
    dimensions: { width: 68.6, depth: 53.4, height: 15 },
    mount: 'standoff',
    standoffs: [
      { x: -20.3, z: -24.2, holeDiameter: 3.2 }, { x: -19.0, z: 24.0, holeDiameter: 3.2 },
      { x: 31.8, z: -19.1, holeDiameter: 3.2 }, { x: 31.8, z: 8.8, holeDiameter: 3.2 },
    ],
    cutouts: [
      { side: 'left', shape: 'rect', width: 12, height: 10.9, offset: 11.4, offsetY: 7.1, label: 'USB-B' },
      { side: 'left', shape: 'rect', width: 9, height: 11, offset: -19.1, offsetY: 7.1, label: 'Barrel jack' },
    ],
  },
  {
    id: 'ir-obstacle', name: 'IR Obstacle Sensor', category: 'sensor',
    dimensions: { width: 32, depth: 14, height: 7 },
    mount: 'standoff',
    standoffs: [{ x: -11, z: 0, holeDiameter: 3 }],
    cutouts: [
      { side: 'right', shape: 'circle', width: 5.2, offset: -3.3, offsetY: 3.5, label: 'IR emitter' },
      { side: 'right', shape: 'circle', width: 5.2, offset: 3.3, offsetY: 3.5, label: 'IR receiver' },
    ],
  },
  {
    id: 'hc-sr04', name: 'Ultrasonic HC-SR04 (upright)', category: 'sensor',
    dimensions: { width: 45, depth: 15, height: 20 },
    mount: 'none',
    standoffs: [],
    cutouts: [
      { side: 'front', shape: 'circle', width: 16.5, offset: -13, offsetY: 10, label: 'Transmitter' },
      { side: 'front', shape: 'circle', width: 16.5, offset: 13, offsetY: 10, label: 'Receiver' },
    ],
  },
  {
    id: 'sg90', name: 'SG90 Micro Servo', category: 'sensor',
    dimensions: { width: 22.2, depth: 11.8, height: 31 },
    mount: 'none',
    standoffs: [],
    cutouts: [{ side: 'top', shape: 'circle', width: 7, offset: 5.2, offsetY: 0, label: 'Output shaft' }],
  },
  {
    id: '18650-holder', name: '18650 Battery Holder (1×)', category: 'power',
    dimensions: { width: 77, depth: 21, height: 21 },
    mount: 'floor',
    standoffs: [{ x: -19, z: 0, holeDiameter: 3.2 }, { x: 19, z: 0, holeDiameter: 3.2 }],
    cutouts: [],
  },
  {
    id: '9v-snap', name: '9V Battery + Snap', category: 'power',
    dimensions: { width: 55, depth: 26, height: 17.5 },
    mount: 'none',
    standoffs: [],
    cutouts: [],
  },
];

export const categoryOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

// A custom part from the "Create custom component" form.
export function customComponent({ name, width, depth, height, mount, port, portWidth, portHeight }) {
  const w = +width, d = +depth;
  const inset = 3.5;
  const standoffs = mount === 'none' ? [] : [
    { x: -(w / 2 - inset), z: -(d / 2 - inset), holeDiameter: 3 }, { x: w / 2 - inset, z: -(d / 2 - inset), holeDiameter: 3 },
    { x: -(w / 2 - inset), z: d / 2 - inset, holeDiameter: 3 }, { x: w / 2 - inset, z: d / 2 - inset, holeDiameter: 3 },
  ].filter((s) => w > 2 * inset + 1 && d > 2 * inset + 1);
  const cutouts = port && port !== 'none' ? [{
    side: port === 'top' ? 'top' : port,
    shape: 'rect', width: +portWidth || 8, height: +portHeight || 4, offset: 0,
    offsetY: port === 'top' ? 0 : Math.min(+height / 2, (+portHeight || 4) / 2 + 1.6), label: 'Port',
  }] : [];
  return {
    id: 'custom-' + Date.now().toString(36), name: name || 'Custom part', category: 'custom',
    dimensions: { width: w, depth: d, height: +height }, mount, standoffs, cutouts,
  };
}
