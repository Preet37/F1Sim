import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loft, section, setFlatUV, setPanelUV, strut, tube, wingElement, type Section } from './Loft';
import {
  buildLivery, disposeLiveryCache, swatchUV, PANEL,
  type PanelName, type SwatchName,
} from './Livery';
import { buildDriverParts } from './DriverMesh';
import {
  wheelMaterial, wheelSwatchUV, disposeTyreCache, TYRE_BAND,
  buildSidewallBands, sidewallMaterial, tyreProfile,
  type WheelSwatch,
} from './TyreTexture';
import type { CompoundId } from '../data/tires';
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
  /**
   * The rear hubs, which do not steer but do collapse.
   *
   * They are here for the same reason the fronts are: a broken suspension
   * corner drops the wheel and throws it out of camber, and that has to be
   * applied to the group the wheel hangs from rather than to the spinning
   * wheel itself, or the camber rotates away as the wheel turns.
   */
  rearLeftSteer: THREE.Object3D;
  rearRightSteer: THREE.Object3D;
  frontLeftSpin: THREE.Object3D;
  frontRightSpin: THREE.Object3D;
  rearLeftSpin: THREE.Object3D;
  rearRightSpin: THREE.Object3D;
  drsFlap: THREE.Object3D;
  brakeGlow: THREE.Mesh[];
  /** The bodywork that can be knocked off, by name. */
  bodyParts: Record<BodyPartId, BodyPart>;
  /** Rolling radius, so the renderer knows the wheel's resting height. */
  tyreRadiusM: number;
  /** Knocks a piece of bodywork off, or puts it back after a repair. */
  setPartAttached(id: BodyPartId, attached: boolean): void;
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
   * Chooses a geometry tier for this car from its distance to the camera.
   *
   * The high tier costs about five times what the low one does, and past the
   * threshold below a car is barely a hundred pixels wide — none of the
   * tessellation that makes a wing endplate read as a moulded part at three
   * metres survives at all. On a full grid that is most of the field for most
   * of a lap.
   *
   * Both tiers are the SHARED cached geometry, so a swap is one pointer
   * assignment per mesh: no extra memory, no extra draw call, and no per-car
   * geometry — the cache stays exactly as shared as it was.
   *
   * A no-op on a session already running the low tier: there is nothing
   * cheaper to fall back to.
   */
  updateDetail(distance: number): void;
  /**
   * Shows or hides the cockpit interior.
   *
   * Hiding the driver's head is NOT done here, because the two are not the same
   * decision: the cockpit interior belongs to whichever car is being watched
   * from inside, whereas the head has to disappear only for the car the camera
   * is actually inside. The renderer owns that, via `driverHead`.
   */
  setCockpitVisible(v: boolean): void;
  /**
   * Swaps the tyres to a compound.
   *
   * Two things change, and both are material swaps: the wheel material, which
   * carries the compound stripe painted into the tyre texture, and the raised
   * sidewall band's material. Nothing is tinted at draw time and no geometry is
   * rebuilt. Materials are shared across the field by compound, so the whole
   * grid on softs costs one of each.
   *
   * Cheap and idempotent — it returns immediately if the compound has not
   * changed — so the renderer can simply call it every frame with
   * `car.compound` rather than needing the race engine to notify it when a pit
   * stop fits a new set. Nothing in the pit-stop path knows the render layer
   * exists, and it should stay that way.
   */
  setCompound(id: CompoundId): void;
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
  /** Compound to fit at build time. Changed later via `setCompound`. */
  compound?: CompoundId;
}

// --- Principal dimensions, in metres, from the current technical regulations --
const HALF_WIDTH = 1.0;
const FRONT_AXLE_Z = 1.72;
const REAR_AXLE_Z = -1.68;

/**
 * Geometry detail tier.
 *
 * Not the same thing as the renderer's quality setting, though it shares its
 * names: the renderer picks ONE quality for the session and then this is chosen
 * per car per frame by distance, so a car two hundred metres away is drawn from
 * the cheap set even in a high-quality session. See `CarVisual.updateDetail`.
 */
export type CarTier = 'low' | 'high';

/**
 * Distance at which a car drops to the cheap geometry, and the one at which it
 * comes back.
 *
 * Two thresholds, not one: with a single threshold a car running exactly
 * alongside at that distance swaps tier every few frames, and the swap is
 * visible as the wing endplates and the tyre silhouette twitching.
 *
 * Where the numbers come from: at a 42-degree vertical field of view the frame is
 * 2*d*tan(21) metres tall at distance d, so at 45m a car five metres long spans
 * about 115 pixels of a 1280-wide frame and stands about 20 high. The body
 * loft's 110mm ring spacing is a quarter of a pixel at that size and the tyre's
 * thirty-two segments resolve to three. Nothing above the cheap tier survives.
 */
const LOD_FAR_M = 45;
const LOD_NEAR_M = 34;

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
  /** Vertices around a ring on the main body lofts. */
  body: number;
  /** Vertices around a ring on small lofts: endplates, fins, ducts. */
  detail: number;
  /**
   * Ring SPACING along the body lofts, in metres.
   *
   * This matters more than the count around the ring and it was the thing that
   * was missing. Sections are authored at 200-400mm stations and a loft skins
   * flat between them, so the body was a fan of facets a foot wide with a
   * crease across the car at every station. See `resample` in Loft.ts.
   */
  bodyStep: number;
  /** Ring spacing along small lofts, in metres. */
  detailStep: number;
  /** Radial segments around a tyre. */
  wheel: number;
  /** Profile rings across a tyre, shoulder to shoulder. */
  tyreRings: number;
  /** Spokes and their radial resolution. */
  spoke: number;
  /** Segments along the halo tube, and around it. */
  halo: number;
  haloRadial: number;
  /** Radial segments on a suspension member. */
  strut: number;
  /** Aerofoil profile resolution on a wing element. */
  wing: number;
  /** Livery texture edge, in pixels. */
  texture: number;
}

/**
 * `high` is what a still frame is judged on and `low` is what a phone runs, and
 * the gap between them is deliberately large. Nothing on the low tier is any
 * coarser than it used to be; everything on the high tier is finer, and the
 * distance LOD below means the extra triangles are only ever paid for by the
 * two or three cars close enough to see them.
 */
const TIERS: Record<CarTier, Tiers> = {
  high: {
    body: 32, detail: 20, bodyStep: 0.11, detailStep: 0.055,
    wheel: 32, tyreRings: 6, spoke: 6, halo: 44, haloRadial: 12,
    // 1024, not 512. This is the one non-geometric number in the table and it
    // belongs with them: the atlas carries the whole car — three unwrapped
    // panels and twelve swatches — so at 512 the sidepod's painted flank is
    // about 190 pixels long, sponsor type comes out as grey mush and the
    // diagonal edge of a colour flash resolves as a visible staircase from the
    // chase camera. That staircase reads as "blocky" exactly as a faceted
    // silhouette does, and no amount of extra tessellation under it helps. At
    // 1024 the flank gets 380 and the type is legible. Ten teams share ten maps
    // and one surface map, which a desktop GPU does not notice and a phone must
    // never be asked for; hence the tier split.
    strut: 9, wing: 14, texture: 1024,
  },
  low: {
    body: 14, detail: 8, bodyStep: 0, detailStep: 0,
    wheel: 12, tyreRings: 3, spoke: 4, halo: 14, haloRadial: 4,
    strut: 5, wing: 6, texture: 256,
  },
};

// ===========================================================================
// Part assembly
// ===========================================================================

/**
 * Collects the geometries that make up the shell, tagging each with the piece of
 * the livery atlas it should sample.
 *
 * Geometry goes into one of five BUCKETS. Four of them are the parts a car can
 * lose — both wings and both sidepods — and the fifth is everything that stays
 * bolted on. They are merged separately so each becomes a mesh the renderer can
 * switch off on its own, which is what lets a destroyed front wing actually be
 * missing from the car rather than merely recolored.
 *
 * The split costs four extra draw calls per car. That is the whole price of
 * visible damage, and it is worth it: a merged shell can only ever be all there
 * or all gone, and "all gone" is the bug this is fixing.
 */
class Parts {
  readonly core: THREE.BufferGeometry[] = [];
  readonly frontWing: THREE.BufferGeometry[] = [];
  readonly rearWing: THREE.BufferGeometry[] = [];
  readonly sidepodL: THREE.BufferGeometry[] = [];
  readonly sidepodR: THREE.BufferGeometry[] = [];

  private target: THREE.BufferGeometry[] = this.core;

  /** Directs everything added from here on into the named bucket. */
  into(bucket: 'core' | BodyPartId): void {
    this.target = this[bucket];
  }

  /** Adds a part that samples a single flat colour from the atlas. */
  flat(geo: THREE.BufferGeometry, swatch: SwatchName): void {
    const [u, v] = swatchUV(swatch);
    this.target.push(setFlatUV(geo, u, v));
  }

  /** Adds a lofted part that carries painted livery graphics. */
  painted(geo: THREE.BufferGeometry, panel: PanelName): void {
    const r = PANEL[panel];
    this.target.push(setPanelUV(geo, r.u0, r.v0, r.u1, r.v1));
  }
}

/**
 * The bodywork a car can lose in an accident.
 *
 * These four are the ones a viewer reads instantly from any camera: a car with
 * no front wing, a car with no rear wing, a car with the chassis exposed down
 * one flank. Everything else that gets damaged — floor, engine, gearbox — is
 * either invisible from outside or does not come off, and is expressed through
 * the handling instead.
 */
export type BodyPartId = 'frontWing' | 'rearWing' | 'sidepodL' | 'sidepodR';

export const BODY_PART_IDS: readonly BodyPartId[] = ['frontWing', 'rearWing', 'sidepodL', 'sidepodR'];

/** A detachable piece of bodywork, and where it sits in the car's own frame. */
export interface BodyPart {
  readonly id: BodyPartId;
  readonly mesh: THREE.Mesh;
  /** Centre of the part in car-local space, for throwing debris from. */
  readonly origin: THREE.Vector3;
  /** Bounding size in car-local space, so the debris is scaled to the part. */
  readonly size: THREE.Vector3;
  /** False once the part has been knocked off. */
  attached: boolean;
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

/**
 * A bar with rounded long edges: a splitter, a diffuser strake, a cooling slat.
 *
 * These were `BoxGeometry`, and a box is the one shape that never occurs on a
 * car — a moulded carbon part has a radius on every edge because it was laid up
 * in a tool, and that radius is what puts a highlight along the part and tells
 * you how big it is. Built as a two-station loft so it shares the superellipse
 * profile the rest of the bodywork uses: `r` sets the corner radius.
 */
function roundedBar(
  w: number, h: number, d: number, r: number, t: Tiers,
): THREE.BufferGeometry {
  const round = Math.max(0.08, Math.min(0.75, (r * 2) / Math.max(1e-4, Math.min(w, h))));
  const cols = Math.max(8, Math.round(t.detail * 0.7));
  return loft([
    section(-d / 2, w / 2, -h / 2, h / 2, round),
    section(d / 2, w / 2, -h / 2, h / 2, round),
  ], cols);
}

function buildShellParts(
  quality: CarTier,
  driverBody: readonly THREE.BufferGeometry[],
): Parts {
  const t = TIERS[quality];
  const p = new Parts();

  /** A body-scale lofted panel: fine around the ring AND along the car. */
  const big = (s: readonly Section[], cols = t.body) => loft(s, cols, true, t.bodyStep);
  /** A small lofted part — an endplate, a fin, a duct. */
  const small = (s: readonly Section[], cols = t.detail) => loft(s, cols, true, t.detailStep);

  // --- Monocoque ---------------------------------------------------------
  p.painted(big(monocoque()), 'body');

  // --- Nose-to-wing transition -------------------------------------------
  // The nose does not stop in mid-air; it drops onto the second wing element.
  // This little wedge is what makes the front of the car read as one piece.
  //
  // It belongs to the WING, not to the nose: it is the fairing over the wing
  // mounts, so when the wing is torn off this goes with it and the nose is left
  // as the blunt stub a real car is left with.
  p.into('frontWing');
  p.flat(small([
    section(2.34, 0.126, 0.210, 0.368, 0.42),
    section(2.58, 0.106, 0.192, 0.302, 0.40),
    section(2.76, 0.086, 0.170, 0.238, 0.40),
  ], t.body - 6), 'accent');
  p.into('core');

  // --- Sidepods -----------------------------------------------------------
  for (const side of [-1, 1] as const) {
    p.into(side < 0 ? 'sidepodL' : 'sidepodR');
    const g = big(sidepod(), t.body - 4);
    g.translate(side * POD_X, 0, 0);
    p.painted(g, 'pod');

    // Inlet: a dark duct standing proud of the pod face, so the mouth reads as a
    // hole in bodywork rather than as a painted-on rectangle. Nearly square
    // corners, because the current generation's inlets are letterboxes.
    const mouth = small([
      section(0.845, 0.168, 0.282, 0.508, 0.10),
      section(0.70, 0.140, 0.300, 0.478, 0.20),
      section(0.54, 0.100, 0.325, 0.442, 0.35),
    ]);
    mouth.translate(side * POD_X, 0, 0);
    p.flat(mouth, 'dark');

    // Splitter across the inlet. One bar is the difference between a duct and a
    // black rectangle.
    const splitter = roundedBar(0.320, 0.026, 0.055, 0.008, t);
    splitter.translate(side * POD_X, 0.396, 0.842);
    p.flat(splitter, 'body');
    p.into('core');
  }

  // --- Floor --------------------------------------------------------------
  // Wider than the bodywork, as the current floor is, so it shows in plan view.
  p.flat(big([
    section(1.95, 0.215, 0.045, 0.100, 0.25, { flatTop: 0.80 }),
    section(1.35, 0.330, 0.045, 0.105, 0.20, { flatTop: 0.85 }),
    section(0.78, 0.640, 0.045, 0.110, 0.15, { flatTop: 0.90 }),
    section(0.10, 0.782, 0.045, 0.115, 0.15, { flatTop: 0.90 }),
    section(-0.90, 0.782, 0.048, 0.120, 0.15, { flatTop: 0.90 }),
    section(-1.45, 0.740, 0.055, 0.145, 0.20, { flatTop: 0.85 }),
  ], t.body - 6), 'carbon');

  // Diffuser: the floor ramping up under the rear crash structure.
  p.flat(big([
    section(-1.45, 0.740, 0.055, 0.145, 0.20, { flatTop: 0.85 }),
    section(-1.85, 0.700, 0.090, 0.190, 0.25, { flatTop: 0.80 }),
    section(-2.15, 0.640, 0.150, 0.252, 0.30, { flatTop: 0.75 }),
    section(-2.42, 0.560, 0.225, 0.312, 0.35, { flatTop: 0.70 }),
    section(-2.58, 0.500, 0.256, 0.332, 0.40),
  ], t.body - 6), 'carbon');

  // Diffuser exit and strakes. The exit is a dark volume standing proud of the
  // diffuser's rear face; the strakes are the vertical fins across it.
  {
    const exit = small([
      section(-2.575, 0.486, 0.256, 0.326, 0.40),
      section(-2.28, 0.552, 0.196, 0.296, 0.35),
    ], t.body - 8);
    p.flat(exit, 'dark');
    // Strakes sit INSIDE the diffuser throat. Hung off the back they read as a
    // comb bolted to the tail, which is what the first attempt looked like.
    for (const x of [-0.35, -0.13, 0.13, 0.35]) {
      const fin = roundedBar(0.013, 0.080, 0.30, 0.004, t);
      fin.translate(x, 0.276, -2.42);
      p.flat(fin, 'carbon');
    }
  }

  // Floor edge: the thin vertical lip that runs the length of the floor. It is
  // what stops the car looking like a body floating over a plate.
  for (const side of [-1, 1] as const) {
    const edge = small([
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
    p.into('frontWing');
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
      const g = wingElement(1.92, chord, thick, -0.030, t.wing);
      // Positive rotation about X drops the leading edge and lifts the trailing
      // edge, which is the way round an inverted wing works.
      g.rotateX(angle);
      g.translate(0, y, z);
      p.flat(g, swatch);
    }

    // Endplates: tall, swept out and up, with the trailing edge rolled outward.
    //
    // The extra stations at the top and the bottom are not shape changes, they
    // are there so the resampler has something to work with at the ends — a
    // monotone spline through five points 180mm apart still has to be told where
    // the plate stops, and the rolled outer edge that the reference car has is a
    // property of the SECTION (round), not of the station list.
    for (const side of [-1, 1] as const) {
      const ep = small([
        section(3.02, 0.021, 0.038, 0.230, 0.22),
        section(2.84, 0.025, 0.042, 0.318, 0.20),
        section(2.64, 0.027, 0.058, 0.372, 0.20),
        section(2.44, 0.024, 0.090, 0.366, 0.22),
        section(2.32, 0.019, 0.140, 0.328, 0.28),
      ], t.body - 8);
      ep.translate(side * 0.965, 0, 0);
      p.flat(ep, 'accent');
    }
    p.into('core');
  }

  // --- Front brake ducts / wheel-wake fins --------------------------------
  for (const side of [-1, 1] as const) {
    const duct = small([
      section(FRONT_AXLE_Z + 0.30, 0.030, 0.160, 0.420, 0.30),
      section(FRONT_AXLE_Z + 0.02, 0.046, 0.130, 0.500, 0.25),
      section(FRONT_AXLE_Z - 0.28, 0.034, 0.150, 0.440, 0.30),
    ]);
    duct.translate(side * 0.645, 0, 0);
    p.flat(duct, 'carbon');
  }

  // --- Airbox and roll hoop -----------------------------------------------
  // BEHIND the driver's head, not on top of it. Put the front of the airbox at
  // the driver's z and the roll hoop eats him, which is precisely what the first
  // attempt did — the cockpit looked empty because the head was inside a duct.
  p.painted(big([
    section(-0.24, 0.128, 0.520, 0.905, 0.38),
    section(-0.44, 0.152, 0.528, 0.898, 0.44),
    section(-0.78, 0.148, 0.538, 0.822, 0.55),
    section(-1.15, 0.116, 0.545, 0.730, 0.65),
    section(-1.55, 0.076, 0.520, 0.648, 0.80),
  ], t.body - 6), 'airbox');

  // The intake itself. Dark, and proud of the airbox face, so it reads as a duct.
  p.flat(small([
    section(-0.215, 0.088, 0.664, 0.872, 0.45),
    section(-0.32, 0.076, 0.680, 0.850, 0.50),
    section(-0.46, 0.062, 0.696, 0.824, 0.60),
  ], t.body - 8), 'dark');

  // --- Shark fin ----------------------------------------------------------
  p.flat(small([
    section(-1.48, 0.014, 0.510, 0.648, 0.30),
    section(-1.85, 0.013, 0.450, 0.660, 0.30),
    section(-2.18, 0.012, 0.390, 0.652, 0.30),
    section(-2.42, 0.011, 0.330, 0.622, 0.30),
  ], t.detail), 'accent');

  // --- Rear wing ----------------------------------------------------------
  {
    p.into('rearWing');
    const main = wingElement(0.98, 0.255, 0.050, -0.050, t.wing);
    main.rotateX(0.20);
    main.translate(0, 0.790, REAR_WING_Z);
    p.flat(main, 'body');

    for (const side of [-1, 1] as const) {
      const ep = small([
        section(-2.20, 0.020, 0.640, 0.872, 0.22),
        section(-2.36, 0.023, 0.612, 0.930, 0.20),
        section(-2.52, 0.022, 0.600, 0.946, 0.20),
        section(-2.66, 0.018, 0.642, 0.920, 0.26),
      ], t.body - 8);
      ep.translate(side * 0.505, 0, 0);
      p.flat(ep, 'accent');
    }

    // Swan-neck pylon: mounts on top of the main plane, as every current car's
    // does, rather than hanging off its underside.
    p.flat(small([
      section(-2.10, 0.034, 0.395, 0.470, 0.35),
      section(-2.28, 0.029, 0.560, 0.645, 0.35),
      section(-2.38, 0.026, 0.735, 0.815, 0.35),
    ], t.detail), 'carbon');

    // Beam wing, two elements, bridging the crash structure to the endplates.
    const beamA = wingElement(0.88, 0.150, 0.032, -0.028, Math.max(5, t.wing - 3));
    beamA.translate(0, 0.352, -2.44);
    p.flat(beamA, 'carbon');
    const beamB = wingElement(0.86, 0.125, 0.028, -0.024, Math.max(5, t.wing - 3));
    beamB.translate(0, 0.442, -2.47);
    p.flat(beamB, 'carbon');

    // Rain light. Mounted on the crash structure rather than on the wing, so it
    // stays with the car when the wing goes — which is how a real one is, and it
    // means a wrecked car still shows a light in the spray.
    p.into('core');
    const light = roundedBar(0.075, 0.105, 0.030, 0.012, t);
    light.translate(0, 0.300, -2.585);
    p.flat(light, 'light');
  }

  // --- Halo ---------------------------------------------------------------
  // The halo is a titanium tube that passes within half a metre of the driver's
  // eyes, and it is the one piece of the car whose geometry is judged from
  // INSIDE rather than from outside. At five radial segments it was a
  // pentagonal bar; at the height and diameter it used to have it was worse
  // than that, and this is why.
  //
  // The old hoop crowned at y = 0.820 — level with the top of the helmet and
  // BELOW the airbox at 0.905, which no real car's does — and carried a
  // constant 46mm section all the way round. From the eye point at y ~ 0.70
  // that put the side rails only 57mm above the sightline, so instead of
  // arcing across the top of the frame they sat across the middle of it, and a
  // 46mm tube at the 0.45m they pass the head subtends nearly seven degrees.
  // The result was the "enormously thick black bar spanning the entire top of
  // the frame" — a bar because the rails were near-level with the eye, and
  // enormous because at that range nothing round is ever small.
  //
  // Two corrections, both of which move toward the real article rather than
  // away from it:
  //
  //  - the crown goes UP, to 0.882, which is where a real halo sits relative
  //    to the roll hoop, and the rails go OUTBOARD to 0.398. Together those
  //    lift the visible arc from six degrees above the sightline to sixteen,
  //    which is the difference between a bar through the middle of the picture
  //    and a line hugging the top edge of it;
  //  - the section TAPERS, thick at the two rear mounts where the structure's
  //    whole load goes into the survival cell and slim over the crown. That is
  //    how the part is actually made, and the crown is precisely the stretch
  //    that crosses the driver's view.
  {
    p.flat(tube([
      [-0.330, 0.648, -0.30],
      [-0.392, 0.726, -0.05],
      [-0.398, 0.818, 0.30],
      [-0.252, 0.868, 0.62],
      [0.000, 0.882, 0.735],
      [0.252, 0.868, 0.62],
      [0.398, 0.818, 0.30],
      [0.392, 0.726, -0.05],
      [0.330, 0.648, -0.30],
    ], 0.021, t.halo, t.haloRadial,
    // 1.0 at both mounts, 0.62 over the crown: 42mm down to 26mm.
    (u) => 0.62 + 0.38 * Math.abs(u * 2 - 1)), 'trim');

    // The forward strut: the only part of the halo a driver looks straight down.
    //
    // It was a 52mm round bar 0.65m from the eye, which is four and a half
    // degrees of solid black up the centre of the frame — the "fat central
    // pillar splitting the view in two". A real one is a blade about 20mm
    // across and three times that front to back, shaped exactly so that the
    // driver sees the edge and not the face. Built round it cannot be both
    // strong and thin; built as the blade it really is, it is both.
    p.flat(strut(0, 0.512, 0.782, 0, 0.876, 0.742, 0.030, t.haloRadial, false, 0.34), 'trim');
  }

  // --- Sidepod winglet and cooling louvres ---------------------------------
  // The little horizontal wing above the inlet, and the row of slats over the
  // radiator exit. Both are on every current car, and a sidepod without either
  // is a featureless blue blade from every angle.
  for (const side of [-1, 1] as const) {
    // Both are bolted to the pod, so they leave with it.
    p.into(side < 0 ? 'sidepodL' : 'sidepodR');
    const winglet = wingElement(0.245, 0.165, 0.020, -0.018, Math.max(4, t.wing - 5));
    winglet.rotateX(0.14);
    winglet.translate(side * 0.600, 0.602, 0.565);
    p.flat(winglet, 'carbon');

    for (const z of [-0.54, -0.70, -0.86]) {
      const slat = roundedBar(0.235, 0.010, 0.034, 0.004, t);
      slat.rotateX(0.30);
      slat.translate(side * POD_X, 0.548 + z * 0.086, z);
      p.flat(slat, 'dark');
    }
    p.into('core');
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
    p.flat(strut(side * 0.300, 0.548, MIRROR_Z, side * 0.430, MIRROR_Y - 0.008, MIRROR_Z, 0.010, t.strut), 'trim');
    // A moulded pod, not a brick: the housing tapers rearward and is rounded on
    // every edge, which is what it looks like on the reference car and what
    // makes the two of them read as aerodynamic parts rather than as luggage.
    //
    // Wider and flatter than it was, and in CARBON rather than in the team's
    // paint. Both changes are about the onboard view, where a mirror is 0.8m
    // from the eye and therefore large whatever its real size: a body-coloured
    // block that close reads as two bright slabs pushing in from the edges of
    // the frame, which is exactly the complaint. Every reference frame has dark
    // pods with only a slim lit top surface, so the eye files them with the
    // cockpit surround instead of treating them as objects.
    const housing = small([
      section(MIRROR_Z + 0.021, 0.0580, MIRROR_Y - 0.023, MIRROR_Y + 0.023, 0.42),
      section(MIRROR_Z + 0.004, 0.0585, MIRROR_Y - 0.024, MIRROR_Y + 0.024, 0.45),
      section(MIRROR_Z - 0.014, 0.0520, MIRROR_Y - 0.022, MIRROR_Y + 0.023, 0.55),
      section(MIRROR_Z - 0.026, 0.0360, MIRROR_Y - 0.017, MIRROR_Y + 0.019, 0.80),
    ], t.detail);
    housing.translate(side * MIRROR_X, 0, 0);
    p.flat(housing, 'carbon');
    // A flat dark pane, so the mirrors read from outside too. The player's own
    // car covers this with a reflective one; see CockpitMesh.
    const glass = new THREE.PlaneGeometry(0.096, 0.036);
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
    const sg = t.strut;
    for (const s of [-1, 1] as const) {
      const fh = s * (FRONT_HUB_X - 0.035);
      // Front upper wishbone.
      p.flat(strut(s * 0.290, 0.398, fz + 0.30, fh, 0.455, fz + 0.02, 0.022, sg), 'trim');
      p.flat(strut(s * 0.272, 0.402, fz - 0.26, fh, 0.455, fz + 0.02, 0.022, sg), 'trim');
      // Front lower wishbone.
      p.flat(strut(s * 0.278, 0.136, fz + 0.28, fh, 0.196, fz + 0.01, 0.026, sg), 'trim');
      p.flat(strut(s * 0.262, 0.142, fz - 0.28, fh, 0.196, fz + 0.01, 0.026, sg), 'trim');
      // Track rod and pushrod.
      p.flat(strut(s * 0.262, 0.300, fz - 0.33, fh, 0.300, fz - 0.13, 0.016, sg), 'trim');
      p.flat(strut(fh, 0.212, fz + 0.06, s * 0.262, 0.470, fz - 0.24, 0.019, sg), 'trim');
      // Upright.
      p.flat(strut(s * (FRONT_HUB_X - 0.030), 0.190, fz, s * (FRONT_HUB_X - 0.030), 0.470, fz, 0.036, sg), 'carbon');

      const rh = s * (REAR_HUB_X - 0.035);
      p.flat(strut(s * 0.242, 0.470, rz + 0.30, rh, 0.472, rz - 0.02, 0.024, sg), 'trim');
      p.flat(strut(s * 0.222, 0.470, rz - 0.26, rh, 0.472, rz - 0.02, 0.024, sg), 'trim');
      p.flat(strut(s * 0.238, 0.172, rz + 0.28, rh, 0.206, rz, 0.028, sg), 'trim');
      p.flat(strut(s * 0.218, 0.176, rz - 0.28, rh, 0.206, rz, 0.028, sg), 'trim');
      p.flat(strut(s * 0.222, 0.292, rz - 0.32, rh, 0.300, rz - 0.10, 0.016, sg), 'trim');
      p.flat(strut(s * 0.150, 0.248, rz, rh, 0.248, rz, 0.030, sg), 'carbon');
      p.flat(strut(s * (REAR_HUB_X - 0.030), 0.200, rz, s * (REAR_HUB_X - 0.030), 0.470, rz, 0.036, sg), 'carbon');
    }
  }

  // --- Driver and cockpit -------------------------------------------------
  // Already tagged with their own swatches by DriverMesh.
  p.core.push(...driverBody);

  return p;
}

// ===========================================================================
// Wheels
// ===========================================================================

/**
 * One wheel: a crowned tyre with a real sidewall, and a rim with a brake disc
 * and caliper visible behind it.
 *
 * This is the most-looked-at object on an open-wheel car. From almost every
 * camera angle the four tyres cover more of the frame than the bodywork does,
 * and until they carry a sidewall, a compound stripe and something behind the
 * spokes they are four black holes that no amount of work elsewhere makes up
 * for.
 *
 * The tyre carries a real parameterisation rather than a flat swatch UV: u runs
 * once around the circumference, v across the profile from the inboard bead to
 * the outboard one. That is what lets `TyreTexture` paint the compound band,
 * the repeating sidewall lettering and the tread striation, and it is why the
 * wheel is on its own material instead of sharing the livery atlas — the
 * compound changes at a pit stop, and the livery does not.
 *
 * The detailed face is on +X, and the left-hand wheels carry a half-turn about Y
 * on the mesh itself so that both sides of the car show their outboard face. The
 * rotation goes on the mesh rather than on the spin group, because the group's X
 * axis is the axis the renderer spins about.
 */
function buildWheel(width: number, t: Tiers, quality: CarTier): THREE.BufferGeometry {
  const radial = t.wheel;
  const parts: THREE.BufferGeometry[] = [];
  const push = (geo: THREE.BufferGeometry, swatch: WheelSwatch) => {
    const [u, v] = wheelSwatchUV(swatch);
    parts.push(setFlatUV(geo, u, v));
  };

  const half = width * 0.5;

  // --- Tyre ---------------------------------------------------------------
  // A surface of revolution: bead, sidewall, shoulder radius, crowned tread, and
  // back again. Each station carries the v it maps to, which is what puts the
  // compound stripe on the sidewall and not across the tread.
  //
  // The cross-section itself lives in TyreTexture, next to the paint that has to
  // land on it and next to the raised compound band that has to sit exactly on
  // top of it. Two copies of these numbers would drift the moment either was
  // tuned, and the failure mode is the band z-fighting through the carcass —
  // which reads as the tyre flickering, not as a mis-set constant.
  const profile = tyreProfile(width, TYRE_R, RIM_R, t.tyreRings);

  const rings = profile.length;
  // One extra column duplicating the seam, so u can reach 1.0 instead of
  // wrapping back to 0 across the last quad and smearing the whole texture
  // backwards along one strip.
  const cols = radial + 1;
  const positions = new Float32Array(rings * cols * 3);
  const uvs = new Float32Array(rings * cols * 2);
  for (let pi = 0; pi < rings; pi++) {
    const v = TYRE_BAND.v0 + profile[pi].v * (TYRE_BAND.v1 - TYRE_BAND.v0);
    for (let i = 0; i < cols; i++) {
      const a = (i / radial) * Math.PI * 2;
      const o = (pi * cols + i) * 3;
      // Wheel axis along X so a rotation about X spins it.
      positions[o] = profile[pi].x;
      positions[o + 1] = Math.sin(a) * profile[pi].r;
      positions[o + 2] = Math.cos(a) * profile[pi].r;
      const uo = (pi * cols + i) * 2;
      uvs[uo] = i / radial;
      uvs[uo + 1] = v;
    }
  }
  const idx: number[] = [];
  for (let pi = 0; pi < rings - 1; pi++) {
    const a = pi * cols;
    const b = (pi + 1) * cols;
    for (let i = 0; i < radial; i++) {
      idx.push(a + i, b + i, b + i + 1);
      idx.push(a + i, b + i + 1, a + i + 1);
    }
  }
  const tyre = new THREE.BufferGeometry();
  tyre.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tyre.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  tyre.setIndex(idx);
  tyre.computeVertexNormals();
  // The seam column duplicates a position, so its averaged normal only saw half
  // the surface and draws a visible crease down the tyre.
  {
    const n = tyre.attributes.normal as THREE.BufferAttribute;
    for (let pi = 0; pi < rings; pi++) {
      const a = pi * cols;
      const b = a + radial;
      const nx = n.getX(a) + n.getX(b);
      const ny = n.getY(a) + n.getY(b);
      const nz = n.getZ(a) + n.getZ(b);
      const len = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(a, nx / len, ny / len, nz / len);
      n.setXYZ(b, nx / len, ny / len, nz / len);
    }
    n.needsUpdate = true;
  }
  parts.push(tyre);

  // --- Rim ----------------------------------------------------------------
  // Barrel, plus a machined lip at each end. The lip is what gives the wheel a
  // bright ring against the tyre's black — the one genuinely metallic highlight
  // on the whole corner.
  const barrel = new THREE.CylinderGeometry(RIM_R * 0.96, RIM_R * 0.96, width * 0.92, radial, 1, true);
  barrel.rotateZ(Math.PI / 2);
  push(barrel, 'rimFace');

  const faceX = half * 0.86;
  for (const [x, r0, r1] of [[faceX, RIM_R * 0.955, RIM_R * 1.0]] as const) {
    const lip = new THREE.CylinderGeometry(r1, r0, 0.026, radial, 1, true);
    lip.rotateZ(Math.PI / 2);
    lip.translate(x - 0.013, 0, 0);
    push(lip, 'rimLip');
  }

  // --- Brake disc and caliper ---------------------------------------------
  // Set inboard of the wheel face so it is genuinely seen THROUGH the spokes,
  // which is the whole point of it. A disc drawn flush with the face just looks
  // like a differently-coloured hubcap.
  const discX = -half * 0.10;
  const discR = RIM_R * 0.80;
  const discSeg = quality === 'high' ? radial : Math.max(8, radial - 2);
  const discBody = new THREE.CylinderGeometry(discR, discR, 0.030, discSeg, 1, true);
  discBody.rotateZ(Math.PI / 2);
  discBody.translate(discX, 0, 0);
  push(discBody, 'disc');

  for (const sx of [-1, 1] as const) {
    const face = new THREE.RingGeometry(RIM_R * 0.30, discR, discSeg);
    face.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    face.translate(discX + sx * 0.016, 0, 0);
    push(face, 'discFace');
  }

  // Caliper: a block straddling the disc at the top rear of the wheel. Small,
  // but it is the difference between a disc floating in a void and a brake.
  const caliper = new THREE.BoxGeometry(0.062, 0.115, 0.052);
  caliper.translate(discX, discR * 0.86, -0.030);
  push(caliper, 'caliper');

  // --- Wheel face ----------------------------------------------------------
  // An outer ring, six machined spokes and a centre nut — an OPEN face, with the
  // brake disc above showing through the gaps.
  //
  // There is deliberately no backing disc behind the spokes. One would stop the
  // wheel reading as hollow, which is what it is for, but it would also mask the
  // disc and caliper completely and those are the whole reason the disc is set
  // inboard. The disc itself closes the void, and closes it with something worth
  // looking at.
  const ring = new THREE.RingGeometry(RIM_R * 0.84, RIM_R * 0.995, radial);
  ring.rotateY(Math.PI / 2);
  ring.translate(faceX + 0.004, 0, 0);
  push(ring, 'rimFace');

  // A machined spoke is wider at the rim than at the hub and has a radius on all
  // four of its long edges; as square-cut boxes they read as six matchsticks
  // glued to a disc, which is precisely what a stock rim never looks like. Built
  // as a three-station loft that tapers as it goes outward.
  for (let k = 0; k < 6; k++) {
    const spoke = loft([
      section(RIM_R * 0.26, 0.0155, -0.024, 0.024, 0.55),
      section(RIM_R * 0.60, 0.0175, -0.027, 0.027, 0.45),
      section(RIM_R * 0.88, 0.0135, -0.023, 0.023, 0.55),
    ], t.spoke * 2);
    // Lofted along its own +z; stand it up as a radial arm and swing it round.
    spoke.rotateX(-Math.PI / 2);
    spoke.rotateX((k * Math.PI) / 3);
    spoke.translate(faceX, 0, 0);
    push(spoke, 'rimSpoke');
  }

  // Centre lock nut.
  const hub = new THREE.CylinderGeometry(RIM_R * 0.26, RIM_R * 0.30, 0.030, t.spoke * 2);
  hub.rotateZ(Math.PI / 2);
  hub.translate(faceX + 0.014, 0, 0);
  push(hub, 'hub');

  // Inboard face: a plain disc closing the barrel. It faces the car and is
  // never really seen, but without it the wheel is visibly hollow from below.
  const inner = new THREE.CircleGeometry(RIM_R * 0.95, radial);
  inner.rotateY(-Math.PI / 2);
  inner.translate(-half * 0.90, 0, 0);
  push(inner, 'inner');

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
  /** Everything that stays bolted to the car whatever happens to it. */
  shell: THREE.BufferGeometry;
  /** The four pieces of bodywork an accident can take off. */
  bodyParts: Record<BodyPartId, THREE.BufferGeometry>;
  /** Helmet plus the coarse wheel and gloves: everything the onboard view hides. */
  head: THREE.BufferGeometry;
  frontWheel: THREE.BufferGeometry;
  rearWheel: THREE.BufferGeometry;
  /** Compound bands. Shared like everything else; only the material varies. */
  frontBand: THREE.BufferGeometry;
  rearBand: THREE.BufferGeometry;
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

function geometryFor(quality: CarTier): CachedGeometry {
  const hit = geometryCache.get(quality);
  if (hit) return hit;

  const t = TIERS[quality];
  // Closed, the DRS flap stands at a steep angle above the main plane; the
  // renderer rotates its pivot toward flat when the system is open.
  const flapGeo = wingElement(0.95, 0.185, 0.034, -0.030, t.wing);
  flapGeo.rotateX(0.62);
  const [fu, fv] = swatchUV('accent');
  setFlatUV(flapGeo, fu, fv);

  const shadow = new THREE.PlaneGeometry(1, 1);
  shadow.rotateX(-Math.PI / 2);

  // Built once and split three ways: the body goes into the shell, the helmet
  // and the coarse wheel into the mesh that the onboard view hides.
  const driver = buildDriverParts(quality);

  const parts = buildShellParts(quality, driver.body);

  const built: CachedGeometry = {
    shell: mergeParts(parts.core),
    bodyParts: {
      frontWing: mergeParts(parts.frontWing),
      rearWing: mergeParts(parts.rearWing),
      sidepodL: mergeParts(parts.sidepodL),
      sidepodR: mergeParts(parts.sidepodR),
    },
    head: mergeParts([...driver.head, ...driver.grip]),
    frontWheel: buildWheel(FRONT_TYRE_W, t, quality),
    rearWheel: buildWheel(REAR_TYRE_W, t, quality),
    // Built with the same tyre tessellation as the carcass they sit on, so the
    // 6mm lift still clears it at both tiers.
    frontBand: buildSidewallBands(FRONT_TYRE_W, TYRE_R, RIM_R, t.wheel, t.tyreRings),
    rearBand: buildSidewallBands(REAR_TYRE_W, TYRE_R, RIM_R, t.wheel, t.tyreRings),
    disc: (() => {
      // The glow ring. Sits just outboard of the real disc so it reads as heat
      // coming off it rather than as a separate object.
      const d = new THREE.CylinderGeometry(0.168, 0.168, 0.020, quality === 'high' ? 24 : 8, 1, true);
      d.rotateZ(Math.PI / 2);
      return d;
    })(),
    flap: flapGeo,
    shadow,
  };
  geometryCache.set(quality, built);
  return built;
}

let shadowTexture: THREE.CanvasTexture | null = null;

/**
 * The soft blob under the car.
 *
 * The shadow map handles the sharp, sun-cast shadow. What it cannot do at any
 * affordable resolution is the CONTACT shadow — the near-black band in the few
 * centimetres between the floor and the road, where almost no ambient light
 * reaches. That band is what tells the eye the car is resting on the ground
 * rather than hovering a hand's width above it, and it is the single cue whose
 * absence makes a rendered vehicle look pasted onto a photograph.
 *
 * Painted as a squared-off radial falloff rather than a plain ellipse: a car's
 * floor is a rectangle, so its contact shadow is a rectangle with soft edges,
 * and a pure ellipse leaves the corners of the floor visibly unsupported.
 */
function contactShadowTexture(): THREE.CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const v = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1;
      // A superellipse distance: |u|^4 + |v|^4 gives a rounded rectangle,
      // which is the shape of the shadow a floor actually casts.
      const d = Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4);
      // Opaque and tight in the middle, feathering to nothing at the boundary.
      const k = Math.max(0, 1 - Math.pow(Math.min(1, d), 0.55));
      const c = Math.round(Math.max(0, Math.min(1, k)) * 255);
      const o = (y * size + x) * 4;
      img.data[o] = c;
      img.data[o + 1] = c;
      img.data[o + 2] = c;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // An alpha mask is a coverage value, not a colour: no sRGB decode.
  tex.colorSpace = THREE.NoColorSpace;
  // Clamped: a repeating shadow would tile a grid of dark patches across the
  // circuit anywhere the UVs stray outside the quad.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  shadowTexture = tex;
  return tex;
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
    // Black at full strength in the middle, feathering to nothing at the edge.
    //
    // Carried on the ALPHA rather than as a multiply blend. Multiplying is the
    // physically apt operation, but this frame buffer is linear half-float and
    // is still carrying values well above 1.0 from the floodlights; multiplying
    // into it lands the result in territory the bloom threshold reads as an
    // emitter, and the shadow comes out as a bright quadrilateral on the road.
    // Alpha towards black is well behaved at any exposure.
    alphaMap: contactShadowTexture(),
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  }));

  const shell = new THREE.Mesh(geo.shell, shellMat);
  shell.castShadow = true;
  root.add(shell);

  // The bodywork that can come off. Same material and same group as the shell,
  // so an intact car looks exactly as it did when this was one merged mesh.
  const bodyParts = {} as Record<BodyPartId, BodyPart>;
  for (const id of BODY_PART_IDS) {
    const g = geo.bodyParts[id];
    if (!g.boundingBox) g.computeBoundingBox();
    const box = g.boundingBox!;
    const mesh = new THREE.Mesh(g, shellMat);
    mesh.castShadow = true;
    root.add(mesh);
    bodyParts[id] = {
      id,
      mesh,
      origin: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
      attached: true,
    };
  }

  const driverHead = new THREE.Mesh(geo.head, shellMat);
  driverHead.castShadow = true;
  root.add(driverHead);

  // Meshes whose geometry the distance LOD swaps, paired with the field of
  // CachedGeometry each one reads.
  /**
   * Meshes whose geometry is swapped when the LOD tier changes.
   *
   * `bodyParts` is excluded from the key type because it is a record of four
   * geometries rather than one, and the detachable bodywork carries its own
   * entry below that indexes into it.
   */
  type SwapKey = Exclude<keyof CachedGeometry, 'bodyParts'>;
  const swappable: { mesh: THREE.Mesh; key: SwapKey }[] = [
    { mesh: shell, key: 'shell' },
    { mesh: driverHead, key: 'head' },
  ];

  // Everything only the driver can see. Parented to the car root, so it inherits
  // the chassis' position, heading, roll and pitch for free.
  const cockpit = opts.withCockpit ? buildCockpit(accentColour) : null;
  if (cockpit) root.add(cockpit.root);

  // Contact shadow: a cheap dark ellipse that grounds the car even with real
  // shadows disabled on low-power devices.
  const shadow = new THREE.Mesh(geo.shadow, shadowMat);
  // Slightly wider than the floor and a little longer, because the penumbra
  // spreads past the object casting it.
  shadow.scale.set(2.5, 1, 5.6);
  // Above the road surface, not below it. Y_ROAD is 0.02 in TrackMesh, so the
  // old 0.012 put the whole thing inside the tarmac and left it to z-fighting
  // to decide whether any of it was visible.
  shadow.position.y = 0.026;
  shadow.renderOrder = -1;
  root.add(shadow);

  // DRS flap on a pivot at its leading edge.
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0, DRS_PIVOT_Y, DRS_PIVOT_Z);
  const flap = new THREE.Mesh(geo.flap, shellMat);
  flap.position.set(0, 0, -0.092);
  flapPivot.add(flap);
  root.add(flapPivot);
  swappable.push({ mesh: flap, key: 'flap' });

  const brakeGlow: THREE.Mesh[] = [];
  const wheels: THREE.Mesh[] = [];
  const bands: THREE.Mesh[] = [];
  /** Compound currently fitted; see `setCompound`. */
  let fittedCompound: CompoundId = opts.compound ?? 'medium';
  let wheelMat = wheelMaterial(fittedCompound, t.texture);

  /**
   * Builds a wheel as steer group -> spin group -> meshes.
   * The nesting is required; see the note on CarVisual.
   */
  const makeWheel = (x: number, z: number, rear: boolean): { steer: THREE.Group; spin: THREE.Group } => {
    const steer = new THREE.Group();
    steer.position.set(x, TYRE_R, z);

    const spin = new THREE.Group();
    steer.add(spin);

    const wheel = new THREE.Mesh(rear ? geo.rearWheel : geo.frontWheel, wheelMat);
    wheel.castShadow = true;
    // Turn the left-hand wheels around so their spoked face points outboard.
    if (x < 0) wheel.rotation.y = Math.PI;
    spin.add(wheel);
    wheels.push(wheel);
    swappable.push({ mesh: wheel, key: rear ? 'rearWheel' : 'frontWheel' });

    // Compound band. It MUST go on the spin group, not the steer group.
    //
    // The band is a surface of revolution, so spinning it changes nothing you
    // can see and hanging it off the steer group looks like a free saving. It is
    // not. Both the band and the tyre are prisms sampled at the same angles,
    // which is what makes a six-millimetre offset enough to keep one clear of
    // the other — but only while they stay in phase. Leave the band stationary
    // and the spinning carcass's vertices sweep past its flat facets and poke
    // through, and the solid ring becomes a ring of dashes that flickers as the
    // wheel turns.
    const band = new THREE.Mesh(rear ? geo.rearBand : geo.frontBand, sidewallMaterial(fittedCompound));
    spin.add(band);
    bands.push(band);
    // Swapped with the carcass, and for the same reason: the two have to be
    // built from the same section or the lift no longer clears it.
    swappable.push({ mesh: band, key: rear ? 'rearBand' : 'frontBand' });

    // Brake disc glows under load. Unlit so it reads at night.
    const discMat = new THREE.MeshBasicMaterial({
      color: 0x1a1210,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(geo.disc, discMat);
    disc.position.x = x > 0 ? -0.036 : 0.036;
    swappable.push({ mesh: disc, key: 'disc' });
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

  let detail: CarTier = quality;

  return {
    updateDetail(distance: number): void {
      // A session that asked for the cheap geometry does not want the expensive
      // set back when a car comes close.
      if (quality === 'low') return;
      const want: CarTier = detail === 'high'
        ? (distance > LOD_FAR_M ? 'low' : 'high')
        : (distance < LOD_NEAR_M ? 'high' : 'low');
      if (want === detail) return;
      detail = want;
      const set = geometryFor(want);
      for (const s of swappable) s.mesh.geometry = set[s.key];
      // The bodywork that can come off follows the same tier as the shell it
      // was cut out of, or a car would drop to low detail everywhere except its
      // wings.
      for (const id of BODY_PART_IDS) bodyParts[id].mesh.geometry = set.bodyParts[id];
    },
    root,
    frontLeftSteer: fl.steer,
    frontRightSteer: fr.steer,
    rearLeftSteer: rl.steer,
    rearRightSteer: rr.steer,
    frontLeftSpin: fl.spin,
    frontRightSpin: fr.spin,
    rearLeftSpin: rl.spin,
    rearRightSpin: rr.spin,
    drsFlap: flapPivot,
    brakeGlow,
    driverHead,
    shadow,
    cockpit,
    bodyParts,
    tyreRadiusM: TYRE_R,
    setPartAttached(id: BodyPartId, attached: boolean): void {
      const part = bodyParts[id];
      if (part.attached === attached) return;
      part.attached = attached;
      part.mesh.visible = attached;
      // The DRS flap hangs off the rear wing, so it leaves with it. Without this
      // a car that has lost its rear wing still carries a flap in mid-air.
      if (id === 'rearWing') flapPivot.visible = attached;
    },
    setCockpitVisible(v: boolean): void {
      cockpit?.setVisible(v);
    },
    setCompound(id: CompoundId): void {
      if (id === fittedCompound) return;
      fittedCompound = id;
      wheelMat = wheelMaterial(id, t.texture);
      for (const w of wheels) w.material = wheelMat;
      const bandMat = sidewallMaterial(id);
      for (const b of bands) b.material = bandMat;
    },
    dispose(): void {
      cockpit?.dispose();
      for (const d of brakeGlow) (d.material as THREE.Material).dispose();
      // The band materials are shared across the whole field and owned by
      // TyreTexture's cache, so they are emphatically NOT disposed here.
    },
  };
}

export function disposeCarGeometryCache(): void {
  for (const set of geometryCache.values()) {
    set.shell.dispose();
    for (const id of BODY_PART_IDS) set.bodyParts[id].dispose();
    set.head.dispose();
    set.frontWheel.dispose();
    set.rearWheel.dispose();
    set.frontBand.dispose();
    set.rearBand.dispose();
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
  disposeTyreCache();
  shadowTexture?.dispose();
  shadowTexture = null;
}
