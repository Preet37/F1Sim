import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loft, section, setFlatUV, setPanelUV, strut, tube, wingElement, type Section } from './Loft';
import {
  buildLivery, disposeLiveryCache, swatchUV, PANEL,
  type PanelName, type SwatchName,
} from './Livery';
import { buildDriverParts } from './DriverMesh';
import {
  buildCockpit, MIRROR_X, MIRROR_Y, MIRROR_Z, MIRROR_GLASS_Z,
  type CockpitVisual,
} from './CockpitMesh';

/**
 * A current-generation Formula 1 car, built procedurally.
 *
 * Three rewrites in, the lesson is that a car does not read as an F1 car because
 * of polygon count or shader quality. It reads because of a specific, short list
 * of shapes that a viewer checks for without knowing they are checking:
 *
 *  - a NARROW HIGH NOSE that drops onto a full-width, multi-element front wing
 *    with tall swept endplates. This is the single strongest identifier. Get the
 *    nose-to-wing transition wrong and nothing else rescues it;
 *  - SIDEPODS with a real inlet — a dark letterbox in a coloured surround — that
 *    undercut hard and ramp downward toward the rear. A smooth flank is a
 *    sports-prototype, not an F1 car;
 *  - an ENGINE COVER that necks down behind the airbox into a shark fin, and a
 *    ROLL HOOP with an intake above the driver's head;
 *  - a REAR WING that is much narrower than the car, sitting on a swan-neck, with
 *    a separate DRS flap above the main plane and a beam wing under it;
 *  - a FLOOR wider than the bodywork with visible edges, ending in a diffuser
 *    with strakes;
 *  - SUSPENSION. Wishbones, pushrods and track rods fill the enormous void
 *    between the bodywork and the wheels. Without them the wheels look glued on;
 *  - a DRIVER, with a helmet and shoulders and arms. See DriverMesh.ts.
 *
 * There are two separate driver-side modules, and the split is deliberate:
 * DriverMesh.ts is the figure as seen from OUTSIDE — helmet, shoulders, HANS
 * collar, arms — merged into the shared shell so every one of the twenty cars
 * has a person in it for free. CockpitMesh.ts is the view from INSIDE — rim
 * bolsters, dash, mirrors, the live-dash steering wheel and gloved hands — and
 * is built only for the car the cockpit camera can occupy, and only shown while
 * that camera is selected.
 *
 * PERFORMANCE. Twenty cars are on track. All of the geometry is built once and
 * shared: there is exactly one shell geometry for the entire field, and per-car
 * identity comes from the livery texture bound to its material, not from a
 * duplicated mesh. That is the whole reason the bodywork is UV-mapped rather than
 * vertex-coloured — vertex colour would force one geometry per team.
 *
 * DRAW CALLS. Everything static, driver and wheels included, shares one material,
 * because every flat-coloured part pins its UVs to a swatch in the same atlas.
 * Twelve calls per car: shell, head, four wheels, four brake discs, the DRS flap
 * and the contact shadow.
 */

export interface CarVisual {
  root: THREE.Group;
  /**
   * Front wheels are a STEER group containing a SPIN group.
   *
   * They cannot be the same object. With Euler XYZ order, applying steer about Y
   * to an object that has already accumulated spin about X means the steering
   * axis is no longer vertical, so the wheels visibly tilt and wobble instead of
   * turning. Nesting keeps the two rotations independent.
   */
  frontLeftSteer: THREE.Object3D;
  frontRightSteer: THREE.Object3D;
  frontLeftSpin: THREE.Object3D;
  frontRightSpin: THREE.Object3D;
  rearLeftSpin: THREE.Object3D;
  rearRightSpin: THREE.Object3D;
  drsFlap: THREE.Object3D;
  brakeGlow: THREE.Mesh[];
  /**
   * The driver's helmet, and the coarse steering wheel and gloves.
   *
   * All of it is hidden for the car the cockpit camera is inside. The helmet
   * has to go because the camera is inside it and would otherwise render the
   * inside of a shell; the wheel and gloves go because CockpitMesh draws a
   * detailed pair in the same place for that one view.
   */
  driverHead: THREE.Object3D;
  /** Contact shadow under the car, scaled with speed for a little squash. */
  shadow: THREE.Mesh;
  /**
   * Cockpit furniture, or null if this car was not built for the inside view.
   * Only ever non-null for the car the cockpit camera can sit in.
   */
  cockpit: CockpitVisual | null;
  /**
   * Shows or hides the cockpit interior.
   *
   * Hiding the driver's head is NOT done here, because the two are not the same
   * decision: the cockpit interior belongs to whichever car is being watched
   * from inside, whereas the head has to disappear only for the car the camera
   * is actually inside. The renderer owns that, via `driverHead`.
   */
  setCockpitVisible(v: boolean): void;
  dispose(): void;
}

export interface CarOptions {
  /** Race number painted on the nose and engine cover. */
  number?: number;
  /** Driver's three-letter code. */
  code?: string;
  /** Renderer quality tier; drives segment counts and texture size. */
  quality?: 'low' | 'high';
  /**
   * Build the cockpit interior — wheel, dash, mirrors, hands — for this car.
   *
   * Worth doing only for the car the cockpit camera can be inside. Twenty
   * steering wheels and twenty pairs of gloves nobody will ever see is not a
   * good trade, and unlike the shell this geometry cannot be shared: the wheel
   * dash is a live canvas texture per car.
   */
  withCockpit?: boolean;
}

// --- Principal dimensions, in metres, from the current technical regulations --
const HALF_WIDTH = 1.0;
const FRONT_AXLE_Z = 1.72;
const REAR_AXLE_Z = -1.68;

/** 18-inch wheels: 0.36m rolling radius; fronts narrower than rears. */
const TYRE_R = 0.36;
const FRONT_TYRE_W = 0.31;
const REAR_TYRE_W = 0.405;
const RIM_R = 0.229;

const FRONT_HUB_X = HALF_WIDTH - FRONT_TYRE_W * 0.5 - 0.02;
const REAR_HUB_X = HALF_WIDTH - REAR_TYRE_W * 0.5 - 0.02;

/** Rear wing plane, and the pivot the DRS flap hinges about. */
const REAR_WING_Z = -2.40;
const DRS_PIVOT_Y = 0.905;
const DRS_PIVOT_Z = -2.325;

interface Tiers {
  /** Ring resolution for the main body lofts. */
  body: number;
  /** Ring resolution for small lofts: endplates, fins, ducts. */
  detail: number;
  /** Radial segments around a tyre. */
  wheel: number;
  /** Segments along the halo tube. */
  halo: number;
  /** Livery texture edge, in pixels. */
  texture: number;
}

const TIERS: Record<'low' | 'high', Tiers> = {
  high: { body: 20, detail: 10, wheel: 16, halo: 22, texture: 512 },
  low: { body: 14, detail: 8, wheel: 12, halo: 14, texture: 256 },
};

// ===========================================================================
// Part assembly
// ===========================================================================

/**
 * Collects the geometries that make up the shell, tagging each with the piece of
 * the livery atlas it should sample.
 */
class Parts {
  readonly list: THREE.BufferGeometry[] = [];

  /** Adds a part that samples a single flat colour from the atlas. */
  flat(geo: THREE.BufferGeometry, swatch: SwatchName): void {
    const [u, v] = swatchUV(swatch);
    this.list.push(setFlatUV(geo, u, v));
  }

  /** Adds a lofted part that carries painted livery graphics. */
  painted(geo: THREE.BufferGeometry, panel: PanelName): void {
    const r = PANEL[panel];
    this.list.push(setPanelUV(geo, r.u0, r.v0, r.u1, r.v1));
  }
}

/**
 * The monocoque, from the nose tip to the rear crash structure.
 *
 * These numbers are the shape of the car. A narrow tip barely wider than a
 * forearm; a fast rise and spread into the survival cell; the flat-topped
 * cockpit opening at the widest point; a shoulder over the fuel cell; then a
 * long, hard taper to a rear end narrow enough to see daylight around.
 */
function monocoque(): Section[] {
  return [
    // The tip is BLUNT. A modern nose is a stubby rectangular block, not a
    // spear; the long taper on the first attempt was a nineties car.
    section(2.32, 0.128, 0.212, 0.372, 0.42),
    section(2.12, 0.150, 0.198, 0.402, 0.40),
    section(1.90, 0.178, 0.180, 0.436, 0.38),
    section(1.56, 0.222, 0.148, 0.478, 0.34),
    section(1.16, 0.268, 0.112, 0.520, 0.30),
    section(0.78, 0.306, 0.090, 0.552, 0.28, { flatTop: 0.25 }),
    // Cockpit opening: the flat-topped, widest part of the survival cell.
    section(0.40, 0.328, 0.082, 0.572, 0.25, { flatTop: 0.55 }),
    section(0.00, 0.336, 0.080, 0.580, 0.25, { flatTop: 0.70 }),
    section(-0.38, 0.326, 0.082, 0.596, 0.30, { flatTop: 0.40 }),
    // Over the fuel cell and the power unit.
    section(-0.82, 0.288, 0.090, 0.612, 0.45),
    section(-1.30, 0.230, 0.105, 0.582, 0.55),
    section(-1.80, 0.163, 0.125, 0.500, 0.68),
    section(-2.24, 0.100, 0.155, 0.400, 0.85),
    section(-2.54, 0.058, 0.200, 0.322, 1.00),
  ];
}

/**
 * Sidepod: a blunt inlet face that undercuts hard and ramps down into the coke
 * bottle. Sections are centred on x = 0 and translated after lofting.
 */
function sidepod(): Section[] {
  return [
    // A blunt, tall inlet face. The pod has to present a real front to the
    // airflow, because that face is what the inlet is cut into.
    section(0.82, 0.212, 0.238, 0.560, 0.16, { undercut: 0.90 }),
    section(0.60, 0.234, 0.212, 0.574, 0.24, { undercut: 0.58 }),
    section(0.24, 0.240, 0.192, 0.572, 0.32, { undercut: 0.46 }),
    section(-0.20, 0.234, 0.180, 0.542, 0.36, { undercut: 0.42 }),
    section(-0.70, 0.210, 0.172, 0.472, 0.45, { undercut: 0.42 }),
    section(-1.20, 0.170, 0.166, 0.386, 0.55, { undercut: 0.48 }),
    section(-1.70, 0.110, 0.162, 0.294, 0.70, { undercut: 0.58 }),
    section(-2.05, 0.048, 0.160, 0.232, 0.90, { undercut: 0.75 }),
  ];
}

const POD_X = 0.505;

function buildShellParts(
  quality: 'low' | 'high',
  driverBody: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry[] {
  const t = TIERS[quality];
  const p = new Parts();

  // --- Monocoque ---------------------------------------------------------
  p.painted(loft(monocoque(), t.body), 'body');

  // --- Nose-to-wing transition -------------------------------------------
  // The nose does not stop in mid-air; it drops onto the second wing element.
  // This little wedge is what makes the front of the car read as one piece.
  p.flat(loft([
    section(2.34, 0.126, 0.210, 0.368, 0.42),
    section(2.58, 0.106, 0.192, 0.302, 0.40),
    section(2.76, 0.086, 0.170, 0.238, 0.40),
  ], t.detail), 'accent');

  // --- Sidepods -----------------------------------------------------------
  for (const side of [-1, 1] as const) {
    const g = loft(sidepod(), t.body - 4);
    g.translate(side * POD_X, 0, 0);
    p.painted(g, 'pod');

    // Inlet: a dark duct standing proud of the pod face, so the mouth reads as a
    // hole in bodywork rather than as a painted-on rectangle. Nearly square
    // corners, because the current generation's inlets are letterboxes.
    const mouth = loft([
      section(0.845, 0.168, 0.282, 0.508, 0.10),
      section(0.70, 0.140, 0.300, 0.478, 0.20),
      section(0.54, 0.100, 0.325, 0.442, 0.35),
    ], t.detail);
    mouth.translate(side * POD_X, 0, 0);
    p.flat(mouth, 'dark');

    // Splitter across the inlet. One bar is the difference between a duct and a
    // black rectangle.
    const splitter = new THREE.BoxGeometry(0.320, 0.026, 0.055);
    splitter.translate(side * POD_X, 0.396, 0.842);
    p.flat(splitter, 'body');
  }

  // --- Floor --------------------------------------------------------------
  // Wider than the bodywork, as the current floor is, so it shows in plan view.
  p.flat(loft([
    section(1.95, 0.215, 0.045, 0.100, 0.25, { flatTop: 0.80 }),
    section(1.35, 0.330, 0.045, 0.105, 0.20, { flatTop: 0.85 }),
    section(0.78, 0.640, 0.045, 0.110, 0.15, { flatTop: 0.90 }),
    section(0.10, 0.782, 0.045, 0.115, 0.15, { flatTop: 0.90 }),
    section(-0.90, 0.782, 0.048, 0.120, 0.15, { flatTop: 0.90 }),
    section(-1.45, 0.740, 0.055, 0.145, 0.20, { flatTop: 0.85 }),
  ], t.body - 6), 'carbon');

  // Diffuser: the floor ramping up under the rear crash structure.
  p.flat(loft([
    section(-1.45, 0.740, 0.055, 0.145, 0.20, { flatTop: 0.85 }),
    section(-1.85, 0.700, 0.090, 0.190, 0.25, { flatTop: 0.80 }),
    section(-2.15, 0.640, 0.150, 0.252, 0.30, { flatTop: 0.75 }),
    section(-2.42, 0.560, 0.225, 0.312, 0.35, { flatTop: 0.70 }),
    section(-2.58, 0.500, 0.256, 0.332, 0.40),
  ], t.body - 6), 'carbon');

  // Diffuser exit and strakes. The exit is a dark volume standing proud of the
  // diffuser's rear face; the strakes are the vertical fins across it.
  {
    const exit = loft([
      section(-2.575, 0.486, 0.256, 0.326, 0.40),
      section(-2.28, 0.552, 0.196, 0.296, 0.35),
    ], t.detail);
    p.flat(exit, 'dark');
    // Strakes sit INSIDE the diffuser throat. Hung off the back they read as a
    // comb bolted to the tail, which is what the first attempt looked like.
    for (const x of [-0.35, -0.13, 0.13, 0.35]) {
      const fin = new THREE.BoxGeometry(0.013, 0.080, 0.30);
      fin.translate(x, 0.276, -2.42);
      p.flat(fin, 'carbon');
    }
  }

  // Floor edge: the thin vertical lip that runs the length of the floor. It is
  // what stops the car looking like a body floating over a plate.
  for (const side of [-1, 1] as const) {
    const edge = loft([
      section(1.30, 0.018, 0.062, 0.150, 0.2),
      section(0.60, 0.020, 0.052, 0.178, 0.2),
      section(-0.40, 0.020, 0.050, 0.182, 0.2),
      section(-1.30, 0.018, 0.058, 0.162, 0.2),
    ], t.detail - 4);
    edge.translate(side * 0.788, 0, 0);
    p.flat(edge, 'carbon');
  }

  // --- Front wing ---------------------------------------------------------
  // Four elements of increasing incidence, stacked and staggered. Negative
  // camber: an F1 wing is an inverted aerofoil, and a wing that bulges upward
  // instead of downward looks wrong even to people who could not say why.
  {
    // Each element sits higher, further back and at more incidence than the one
    // in front of it. The staircase is the point: four aerofoils at the same
    // angle stacked close together fuse into one slab, which is what the first
    // attempt produced.
    const elements: [number, number, number, number, number, SwatchName][] = [
      // chord, thickness, y, z, incidence, colour
      [0.340, 0.056, 0.068, 2.905, 0.08, 'body'],
      [0.255, 0.046, 0.152, 2.762, 0.22, 'body'],
      [0.210, 0.039, 0.232, 2.672, 0.36, 'accent'],
      [0.175, 0.033, 0.306, 2.600, 0.48, 'accent'],
    ];
    for (const [chord, thick, y, z, angle, swatch] of elements) {
      const g = wingElement(1.92, chord, thick, -0.030, quality === 'high' ? 10 : 6);
      // Positive rotation about X drops the leading edge and lifts the trailing
      // edge, which is the way round an inverted wing works.
      g.rotateX(angle);
      g.translate(0, y, z);
      p.flat(g, swatch);
    }

    // Endplates: tall, swept out and up, with the trailing edge rolled outward.
    for (const side of [-1, 1] as const) {
      const ep = loft([
        section(3.02, 0.021, 0.038, 0.230, 0.20),
        section(2.84, 0.025, 0.042, 0.318, 0.18),
        section(2.64, 0.027, 0.058, 0.372, 0.18),
        section(2.44, 0.024, 0.090, 0.366, 0.20),
        section(2.32, 0.019, 0.140, 0.328, 0.25),
      ], t.detail);
      ep.translate(side * 0.965, 0, 0);
      p.flat(ep, 'accent');
    }
  }

  // --- Front brake ducts / wheel-wake fins --------------------------------
  for (const side of [-1, 1] as const) {
    const duct = loft([
      section(FRONT_AXLE_Z + 0.30, 0.030, 0.160, 0.420, 0.30),
      section(FRONT_AXLE_Z + 0.02, 0.046, 0.130, 0.500, 0.25),
      section(FRONT_AXLE_Z - 0.28, 0.034, 0.150, 0.440, 0.30),
    ], t.detail);
    duct.translate(side * 0.645, 0, 0);
    p.flat(duct, 'carbon');
  }

  // --- Airbox and roll hoop -----------------------------------------------
  // BEHIND the driver's head, not on top of it. Put the front of the airbox at
  // the driver's z and the roll hoop eats him, which is precisely what the first
  // attempt did — the cockpit looked empty because the head was inside a duct.
  p.painted(loft([
    section(-0.24, 0.128, 0.520, 0.905, 0.38),
    section(-0.44, 0.152, 0.528, 0.898, 0.44),
    section(-0.78, 0.148, 0.538, 0.822, 0.55),
    section(-1.15, 0.116, 0.545, 0.730, 0.65),
    section(-1.55, 0.076, 0.520, 0.648, 0.80),
  ], t.body - 6), 'airbox');

  // The intake itself. Dark, and proud of the airbox face, so it reads as a duct.
  p.flat(loft([
    section(-0.215, 0.088, 0.664, 0.872, 0.45),
    section(-0.32, 0.076, 0.680, 0.850, 0.50),
    section(-0.46, 0.062, 0.696, 0.824, 0.60),
  ], t.detail), 'dark');

  // --- Shark fin ----------------------------------------------------------
  p.flat(loft([
    section(-1.48, 0.014, 0.510, 0.648, 0.20),
    section(-1.85, 0.013, 0.450, 0.660, 0.20),
    section(-2.18, 0.012, 0.390, 0.652, 0.20),
    section(-2.42, 0.011, 0.330, 0.622, 0.20),
  ], t.detail - 4), 'accent');

  // --- Rear wing ----------------------------------------------------------
  {
    const main = wingElement(0.98, 0.255, 0.050, -0.050, quality === 'high' ? 12 : 7);
    main.rotateX(0.20);
    main.translate(0, 0.790, REAR_WING_Z);
    p.flat(main, 'body');

    for (const side of [-1, 1] as const) {
      const ep = loft([
        section(-2.20, 0.020, 0.640, 0.872, 0.20),
        section(-2.36, 0.023, 0.612, 0.930, 0.18),
        section(-2.52, 0.022, 0.600, 0.946, 0.18),
        section(-2.66, 0.018, 0.642, 0.920, 0.22),
      ], t.detail);
      ep.translate(side * 0.505, 0, 0);
      p.flat(ep, 'accent');
    }

    // Swan-neck pylon: mounts on top of the main plane, as every current car's
    // does, rather than hanging off its underside.
    p.flat(loft([
      section(-2.10, 0.034, 0.395, 0.470, 0.30),
      section(-2.28, 0.029, 0.560, 0.645, 0.30),
      section(-2.38, 0.026, 0.735, 0.815, 0.30),
    ], t.detail - 4), 'carbon');

    // Beam wing, two elements, bridging the crash structure to the endplates.
    const beamA = wingElement(0.88, 0.150, 0.032, -0.028, quality === 'high' ? 8 : 5);
    beamA.translate(0, 0.352, -2.44);
    p.flat(beamA, 'carbon');
    const beamB = wingElement(0.86, 0.125, 0.028, -0.024, quality === 'high' ? 8 : 5);
    beamB.translate(0, 0.442, -2.47);
    p.flat(beamB, 'carbon');

    // Rain light.
    const light = new THREE.BoxGeometry(0.075, 0.105, 0.030);
    light.translate(0, 0.300, -2.585);
    p.flat(light, 'light');
  }

  // --- Halo ---------------------------------------------------------------
  {
    p.flat(tube([
      [-0.325, 0.640, -0.30],
      [-0.375, 0.700, -0.05],
      [-0.370, 0.762, 0.30],
      [-0.235, 0.808, 0.62],
      [0.000, 0.820, 0.735],
      [0.235, 0.808, 0.62],
      [0.370, 0.762, 0.30],
      [0.375, 0.700, -0.05],
      [0.325, 0.640, -0.30],
    ], 0.023, t.halo, quality === 'high' ? 5 : 4), 'trim');

    // The forward strut, the only part of the halo a driver actually sees.
    p.flat(strut(0, 0.500, 0.770, 0, 0.815, 0.737, 0.026, 6), 'trim');
  }

  // --- Sidepod winglet and cooling louvres ---------------------------------
  // The little horizontal wing above the inlet, and the row of slats over the
  // radiator exit. Both are on every current car, and a sidepod without either
  // is a featureless blue blade from every angle.
  for (const side of [-1, 1] as const) {
    const winglet = wingElement(0.245, 0.165, 0.020, -0.018, quality === 'high' ? 6 : 4);
    winglet.rotateX(0.14);
    winglet.translate(side * 0.600, 0.602, 0.565);
    p.flat(winglet, 'carbon');

    for (const z of [-0.54, -0.70, -0.86]) {
      const slat = new THREE.BoxGeometry(0.235, 0.010, 0.034);
      slat.rotateX(0.30);
      slat.translate(side * POD_X, 0.548 + z * 0.086, z);
      p.flat(slat, 'dark');
    }
  }

  // --- Mirrors ------------------------------------------------------------
  // Above and outboard of the sidepod inlet, where a driver could actually see
  // out of them. Set any lower and they vanish inside the pod.
  //
  // The position is not free: it is shared with the cockpit view, which hangs a
  // genuinely reflective pane on the front of each housing. Mounted where the
  // sidepod inlet is, a mirror sits about 48 degrees off the driver's eye axis
  // and falls outside even a wide field of view, so the onboard shot loses them
  // entirely. Carried forward to the front of the cockpit opening — which is
  // where a real car mounts them, and for the same reason — they land inside
  // the frame.
  for (const side of [-1, 1] as const) {
    p.flat(strut(side * 0.300, 0.548, MIRROR_Z, side * 0.430, MIRROR_Y - 0.008, MIRROR_Z, 0.014, 5), 'trim');
    const housing = new THREE.BoxGeometry(0.105, 0.058, 0.040);
    housing.translate(side * MIRROR_X, MIRROR_Y, MIRROR_Z);
    p.flat(housing, 'body');
    // A flat dark pane, so the mirrors read from outside too. The player's own
    // car covers this with a reflective one; see CockpitMesh.
    const glass = new THREE.PlaneGeometry(0.088, 0.046);
    glass.rotateY(Math.PI);
    glass.translate(side * MIRROR_X, MIRROR_Y, MIRROR_GLASS_Z);
    p.flat(glass, 'glass');
  }

  // --- Suspension ---------------------------------------------------------
  // Double wishbones, a pushrod and a steering or toe link at each corner. The
  // A-shape of a wishbone matters: a single bar per corner reads as a strut, and
  // struts are what road cars have.
  {
    const fz = FRONT_AXLE_Z;
    const rz = REAR_AXLE_Z;
    for (const s of [-1, 1] as const) {
      const fh = s * (FRONT_HUB_X - 0.035);
      // Front upper wishbone.
      p.flat(strut(s * 0.290, 0.398, fz + 0.30, fh, 0.455, fz + 0.02, 0.022), 'trim');
      p.flat(strut(s * 0.272, 0.402, fz - 0.26, fh, 0.455, fz + 0.02, 0.022), 'trim');
      // Front lower wishbone.
      p.flat(strut(s * 0.278, 0.136, fz + 0.28, fh, 0.196, fz + 0.01, 0.026), 'trim');
      p.flat(strut(s * 0.262, 0.142, fz - 0.28, fh, 0.196, fz + 0.01, 0.026), 'trim');
      // Track rod and pushrod.
      p.flat(strut(s * 0.262, 0.300, fz - 0.33, fh, 0.300, fz - 0.13, 0.016), 'trim');
      p.flat(strut(fh, 0.212, fz + 0.06, s * 0.262, 0.470, fz - 0.24, 0.019), 'trim');
      // Upright.
      p.flat(strut(s * (FRONT_HUB_X - 0.030), 0.190, fz, s * (FRONT_HUB_X - 0.030), 0.470, fz, 0.036), 'carbon');

      const rh = s * (REAR_HUB_X - 0.035);
      p.flat(strut(s * 0.242, 0.470, rz + 0.30, rh, 0.472, rz - 0.02, 0.024), 'trim');
      p.flat(strut(s * 0.222, 0.470, rz - 0.26, rh, 0.472, rz - 0.02, 0.024), 'trim');
      p.flat(strut(s * 0.238, 0.172, rz + 0.28, rh, 0.206, rz, 0.028), 'trim');
      p.flat(strut(s * 0.218, 0.176, rz - 0.28, rh, 0.206, rz, 0.028), 'trim');
      p.flat(strut(s * 0.222, 0.292, rz - 0.32, rh, 0.300, rz - 0.10, 0.016), 'trim');
      p.flat(strut(s * 0.150, 0.248, rz, rh, 0.248, rz, 0.030), 'carbon');
      p.flat(strut(s * (REAR_HUB_X - 0.030), 0.200, rz, s * (REAR_HUB_X - 0.030), 0.470, rz, 0.036), 'carbon');
    }
  }

  // --- Driver and cockpit -------------------------------------------------
  // Already tagged with their own swatches by DriverMesh.
  p.list.push(...driverBody);

  return p.list;
}

// ===========================================================================
// Wheels
// ===========================================================================

/**
 * One wheel: a crowned tyre with bulging sidewalls, and a six-spoke rim inside
 * it.
 *
 * The rim is not decoration. An open-wheel car shows more wheel than bodywork
 * from most angles, and a plain black disc where the rim should be is the second
 * most obvious tell of a procedural car after boxy wings.
 *
 * The detailed face is on +X, and the left-hand wheels carry a half-turn about Y
 * on the mesh itself so that both sides of the car show their outboard face. The
 * rotation goes on the mesh rather than on the spin group, because the group's X
 * axis is the axis the renderer spins about.
 */
function buildWheel(width: number, radial: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const push = (geo: THREE.BufferGeometry, swatch: SwatchName) => {
    const [u, v] = swatchUV(swatch);
    parts.push(setFlatUV(geo, u, v));
  };

  // Tyre as a surface of revolution: crowned tread, bulging shoulders, sidewalls
  // that pull back in to the bead. A plain cylinder reads as a hockey puck.
  const half = width * 0.5;
  const profile: { r: number; x: number }[] = [
    { r: RIM_R + 0.004, x: -half },
    { r: TYRE_R * 0.895, x: -half * 1.015 },
    { r: TYRE_R * 0.995, x: -half * 0.74 },
    { r: TYRE_R * 1.002, x: 0 },
    { r: TYRE_R * 0.995, x: half * 0.74 },
    { r: TYRE_R * 0.895, x: half * 1.015 },
    { r: RIM_R + 0.004, x: half },
  ];

  const rings = profile.length;
  const positions = new Float32Array(rings * radial * 3);
  for (let pi = 0; pi < rings; pi++) {
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const o = (pi * radial + i) * 3;
      // Wheel axis along X so a rotation about X spins it.
      positions[o] = profile[pi].x;
      positions[o + 1] = Math.sin(a) * profile[pi].r;
      positions[o + 2] = Math.cos(a) * profile[pi].r;
    }
  }
  const idx: number[] = [];
  for (let pi = 0; pi < rings - 1; pi++) {
    const a = pi * radial;
    const b = (pi + 1) * radial;
    for (let i = 0; i < radial; i++) {
      const j = (i + 1) % radial;
      idx.push(a + i, b + i, b + j);
      idx.push(a + i, b + j, a + j);
    }
  }
  const tyre = new THREE.BufferGeometry();
  tyre.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tyre.setIndex(idx);
  tyre.computeVertexNormals();
  push(tyre, 'tyre');

  // Rim barrel.
  const barrel = new THREE.CylinderGeometry(RIM_R, RIM_R, width * 0.94, radial, 1, true);
  barrel.rotateZ(Math.PI / 2);
  push(barrel, 'trim');

  // Outboard face: dark backing, six spokes, an outer ring and a centre nut.
  const faceX = half * 0.86;
  const backing = new THREE.CircleGeometry(RIM_R * 0.97, radial);
  backing.rotateY(Math.PI / 2);
  backing.translate(faceX - 0.030, 0, 0);
  push(backing, 'dark');

  const ring = new THREE.RingGeometry(RIM_R * 0.84, RIM_R * 0.995, radial);
  ring.rotateY(Math.PI / 2);
  ring.translate(faceX + 0.004, 0, 0);
  push(ring, 'rim');

  for (let k = 0; k < 6; k++) {
    const spoke = new THREE.BoxGeometry(0.020, RIM_R * 0.62, 0.052);
    spoke.translate(0, RIM_R * 0.57, 0);
    spoke.rotateX((k * Math.PI) / 3);
    spoke.translate(faceX, 0, 0);
    push(spoke, 'rim');
  }

  const hub = new THREE.CylinderGeometry(RIM_R * 0.26, RIM_R * 0.30, 0.030, 6);
  hub.rotateZ(Math.PI / 2);
  hub.translate(faceX + 0.014, 0, 0);
  push(hub, 'carbon');

  // Inboard face: a plain disc. It faces the car and is never really seen.
  const inner = new THREE.CircleGeometry(RIM_R * 0.99, radial);
  inner.rotateY(-Math.PI / 2);
  inner.translate(-half * 0.90, 0, 0);
  push(inner, 'trim');

  return mergeParts(parts);
}

// ===========================================================================
// Merging and caching
// ===========================================================================

/**
 * Concatenates parts into one geometry.
 *
 * Everything is converted to non-indexed first: the parts come from a mix of
 * indexed lofts and non-indexed extrusions, and three.js will not merge a mixed
 * set. Triangle count is unaffected either way.
 */
function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const geo = part.index ? part.toNonIndexed() : part;
    if (geo !== part) part.dispose();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    // Merging requires an identical attribute set on every input.
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    geo.clearGroups();
    prepared.push(geo);
  }
  const merged = mergeGeometries(prepared, false);
  for (const g of prepared) g.dispose();
  const result = merged ?? new THREE.BoxGeometry(0.1, 0.1, 0.1);
  result.computeBoundingSphere();
  return result;
}

interface CachedGeometry {
  shell: THREE.BufferGeometry;
  /** Helmet plus the coarse wheel and gloves: everything the onboard view hides. */
  head: THREE.BufferGeometry;
  frontWheel: THREE.BufferGeometry;
  rearWheel: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
  shadow: THREE.BufferGeometry;
}

/**
 * One entry per quality tier, and that is the whole field.
 *
 * The livery lives in the texture, so twenty cars in ten colour schemes share a
 * single copy of every vertex on the car.
 */
const geometryCache = new Map<string, CachedGeometry>();

function geometryFor(quality: 'low' | 'high'): CachedGeometry {
  const hit = geometryCache.get(quality);
  if (hit) return hit;

  const t = TIERS[quality];
  // Closed, the DRS flap stands at a steep angle above the main plane; the
  // renderer rotates its pivot toward flat when the system is open.
  const flapGeo = wingElement(0.95, 0.185, 0.034, -0.030, quality === 'high' ? 10 : 6);
  flapGeo.rotateX(0.62);
  const [fu, fv] = swatchUV('accent');
  setFlatUV(flapGeo, fu, fv);

  const shadow = new THREE.PlaneGeometry(1, 1);
  shadow.rotateX(-Math.PI / 2);

  // Built once and split three ways: the body goes into the shell, the helmet
  // and the coarse wheel into the mesh that the onboard view hides.
  const driver = buildDriverParts(quality);

  const built: CachedGeometry = {
    shell: mergeParts(buildShellParts(quality, driver.body)),
    head: mergeParts([...driver.head, ...driver.grip]),
    frontWheel: buildWheel(FRONT_TYRE_W, t.wheel),
    rearWheel: buildWheel(REAR_TYRE_W, t.wheel),
    disc: (() => {
      const d = new THREE.CylinderGeometry(0.165, 0.165, 0.028, quality === 'high' ? 12 : 8);
      d.rotateZ(Math.PI / 2);
      return d;
    })(),
    flap: flapGeo,
    shadow,
  };
  geometryCache.set(quality, built);
  return built;
}

const sharedMaterials: Record<string, THREE.Material> = {};

function material(key: string, make: () => THREE.Material): THREE.Material {
  const existing = sharedMaterials[key];
  if (existing) return existing;
  const m = make();
  sharedMaterials[key] = m;
  return m;
}

/**
 * One material per livery, shared by every part of that car.
 *
 * Roughness and metalness come from a map rather than from constants, which is
 * what gives the car a satin engine cover against wet-looking flanks, matte
 * rubber, and a rim that actually looks like machined metal — all in one draw
 * call. The multipliers are left at 1 so the map is in sole charge.
 */
function shellMaterial(
  colour: number, accent: number, number: number, code: string, size: number,
): THREE.Material {
  const key = `shell:${colour}:${accent}:${number}:${code}:${size}`;
  return material(key, () => {
    const livery = buildLivery({ colour, accent, number, code }, size);
    return new THREE.MeshStandardMaterial({
      map: livery.map,
      roughnessMap: livery.surface,
      metalnessMap: livery.surface,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1.15,
    });
  });
}

// ===========================================================================
// Assembly
// ===========================================================================

export function buildCar(
  bodyColour: number,
  accentColour: number,
  opts: CarOptions = {},
): CarVisual {
  const quality = opts.quality ?? 'high';
  const t = TIERS[quality];
  const geo = geometryFor(quality);
  const root = new THREE.Group();

  const shellMat = shellMaterial(
    bodyColour, accentColour, opts.number ?? 0, opts.code ?? '', t.texture,
  );
  const shadowMat = material('shadow', () => new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  }));

  const shell = new THREE.Mesh(geo.shell, shellMat);
  shell.castShadow = true;
  root.add(shell);

  const driverHead = new THREE.Mesh(geo.head, shellMat);
  driverHead.castShadow = true;
  root.add(driverHead);

  // Everything only the driver can see. Parented to the car root, so it inherits
  // the chassis' position, heading, roll and pitch for free.
  const cockpit = opts.withCockpit ? buildCockpit(accentColour) : null;
  if (cockpit) root.add(cockpit.root);

  // Contact shadow: a cheap dark ellipse that grounds the car even with real
  // shadows disabled on low-power devices.
  const shadow = new THREE.Mesh(geo.shadow, shadowMat);
  shadow.scale.set(2.1, 1, 5.0);
  shadow.position.y = 0.012;
  shadow.renderOrder = -1;
  root.add(shadow);

  // DRS flap on a pivot at its leading edge.
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0, DRS_PIVOT_Y, DRS_PIVOT_Z);
  const flap = new THREE.Mesh(geo.flap, shellMat);
  flap.position.set(0, 0, -0.092);
  flapPivot.add(flap);
  root.add(flapPivot);

  const brakeGlow: THREE.Mesh[] = [];

  /**
   * Builds a wheel as steer group -> spin group -> meshes.
   * The nesting is required; see the note on CarVisual.
   */
  const makeWheel = (x: number, z: number, rear: boolean): { steer: THREE.Group; spin: THREE.Group } => {
    const steer = new THREE.Group();
    steer.position.set(x, TYRE_R, z);

    const spin = new THREE.Group();
    steer.add(spin);

    const wheel = new THREE.Mesh(rear ? geo.rearWheel : geo.frontWheel, shellMat);
    wheel.castShadow = true;
    // Turn the left-hand wheels around so their spoked face points outboard.
    if (x < 0) wheel.rotation.y = Math.PI;
    spin.add(wheel);

    // Brake disc glows under load. Unlit so it reads at night.
    const discMat = new THREE.MeshBasicMaterial({ color: 0x1a1210 });
    const disc = new THREE.Mesh(geo.disc, discMat);
    disc.position.x = x > 0 ? -0.055 : 0.055;
    // On the steer group, not the spin group: a brake disc does rotate with the
    // wheel, but the glow is what matters and a static disc avoids strobing.
    steer.add(disc);
    brakeGlow.push(disc);

    root.add(steer);
    return { steer, spin };
  };

  const fl = makeWheel(-FRONT_HUB_X, FRONT_AXLE_Z, false);
  const fr = makeWheel(FRONT_HUB_X, FRONT_AXLE_Z, false);
  const rl = makeWheel(-REAR_HUB_X, REAR_AXLE_Z, true);
  const rr = makeWheel(REAR_HUB_X, REAR_AXLE_Z, true);

  return {
    root,
    frontLeftSteer: fl.steer,
    frontRightSteer: fr.steer,
    frontLeftSpin: fl.spin,
    frontRightSpin: fr.spin,
    rearLeftSpin: rl.spin,
    rearRightSpin: rr.spin,
    drsFlap: flapPivot,
    brakeGlow,
    driverHead,
    shadow,
    cockpit,
    setCockpitVisible(v: boolean): void {
      cockpit?.setVisible(v);
    },
    dispose(): void {
      cockpit?.dispose();
      for (const d of brakeGlow) (d.material as THREE.Material).dispose();
    },
  };
}

export function disposeCarGeometryCache(): void {
  for (const set of geometryCache.values()) {
    set.shell.dispose();
    set.head.dispose();
    set.frontWheel.dispose();
    set.rearWheel.dispose();
    set.disc.dispose();
    set.flap.dispose();
    set.shadow.dispose();
  }
  geometryCache.clear();
  for (const key of Object.keys(sharedMaterials)) {
    sharedMaterials[key].dispose();
    delete sharedMaterials[key];
  }
  disposeLiveryCache();
}
