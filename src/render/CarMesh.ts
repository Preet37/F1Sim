import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  apertureEdge, loft, section, setFlatUV, setPanelUV, strut, aeroStrut, tube,
  wingElement, riseSpanwise, type OpenTop, type Section,
} from './Loft';
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
import { carbonWeaveMap, disposeDetailMaps } from './DetailMaps';
import { chamferBox } from './ChamferKit';

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
 *
 * ===========================================================================
 * REFERENCE: the 2022+ regulations, in this file's own coordinates
 * ===========================================================================
 *
 * Written down because it has been re-derived from photographs three times and
 * got a different answer each time. All of it is from the FIA Formula 1
 * Technical Regulations (2025 Issue 3 unless noted); Appendix 1 "Regulation
 * Volumes" defines every aero envelope as explicit polygons in millimetres and
 * is the authority for most of what follows.
 *
 * THE FIA'S AXES ARE NOT OURS. Theirs: X positive REARWARD from the front axle,
 * Y lateral, Z up from the REFERENCE PLANE — the flat underside of the sprung
 * mass, above the plank. Ours: z positive FORWARD, y up from the ROAD, x
 * lateral. So an FIA figure converts as
 *
 *      our z = FRONT_AXLE_Z - X_fia/1000        our y = Z_fia/1000 + 0.035
 *
 * where 0.035m is where the reference plane sits above the road: the wheel
 * centre is at TYRE_R = 0.360 and the regulations put it at Z = 310..340 above
 * the reference plane in the legality attitude, so the plane is 0.325 under the
 * axle. Every "above the road" number below has that offset already in it.
 *
 * PRINCIPAL DIMENSIONS
 *   Overall width, bodywork      2000mm  (Y = +-1000)          -> HALF_WIDTH 1.0
 *   Wheelbase, maximum           3600mm                         -> +-1.80 in z
 *   Overall length, envelope     5630mm  (1350 front overhang +
 *                                        3600 + 680 rear)
 *   Max bodywork height           970mm above reference plane   -> y = 1.005
 *   Roll structure must exist at  968mm                         -> y = 1.003
 *   Minimum mass with driver      798kg (2022-24), 800kg (2025)
 *   Plank thickness                10mm, 9mm wear limit
 *   Reference plane above road     20-50mm front, 60-160mm rear
 *   Rake, 2022+ era               0.7-1.5deg (NOT the 2017-21 wedge)
 *   Front track, maximum         1605mm    -> FRONT_HUB_X 0.800
 *   Rear track, maximum          1525mm    -> the front track is the WIDER of
 *                                            the two, by about 80mm, which is
 *                                            the opposite of most road cars
 *
 * FRONT WING AND NOSE
 *   Front overhang               1350mm ahead of the axle      -> z = 3.15
 *   Nose tip must reach          1150mm ahead                  -> z = 2.95
 *   Nose tip height              110-235mm above ref plane     -> y 0.145-0.270
 *   Wing span                    1950mm (+-975)                -> +-0.975
 *   Elements                     MAINPLANE + AT MOST 3 FLAPS. Four sections
 *                                total in any Y-plane, never five or six
 *   Slot gaps                    5-15mm
 *   Endplate                     Y = 900..975, max height Z 475 -> y 0.510.
 *                                Near-flat and near-vertical: no tangent may
 *                                subtend more than 10deg to the X axis. The
 *                                elaborate outwash endplate died in 2022
 *   Bargeboards                  DELETED in 2022. Nothing between the front
 *                                wheel and the sidepod but floor and fences
 *
 * SIDEPOD, COKE BOTTLE, ENGINE COVER
 *   Sidepod half-width, max       775mm  -> x 0.775
 *   Sidepod height, max           600mm  -> y 0.635
 *   Coke bottle starts at        XF 1300 -> z 0.50, and must taper
 *                                CONTINUOUSLY inward from there: no
 *                                rearward-facing surface behind XR -300
 *   Engine cover / airbox crown   970mm  -> y 1.005
 *   Shark fin                     50mm maximum thickness
 *   Roll hoop, above Z 935        convex only, radius >= 20mm. This is what
 *                                outlawed the pointed blade hoop
 *
 * FLOOR
 *   Widest at Y 800 between XF 1290 and XF 2000
 *   Diffuser exit                 730mm wide, roof at Z 200    -> y 0.235
 *   Diffuser ramp                 900mm long, rising 130mm
 *   Floor fences                  FOUR per side maximum, ~8mm thick
 *   Floor edge wing               90mm tall (75mm in 2022), 5mm thick
 *
 * REAR WING
 *   Elements                      EXACTLY TWO in any Y-plane: main plane and
 *                                 one flap, the flap of smaller chord
 *   Profile envelope              XR 140..555 -> z -1.94..-2.355
 *                                 Z 670..910  -> y 0.705..0.945
 *   Span                          Y <= 480, so 960mm overall
 *   Slot gap, closed              10-15mm; DRS opens it to 85mm maximum
 *   Endplate body                 Z 325..660 -> y 0.360..0.695, leaning
 *                                 outboard as it rises
 *   Rolled tip                    Z 660..910 -> y 0.695..0.945. The mandated
 *                                 curl is the most recognisable 2022 feature
 *                                 after the wheel covers
 *   Beam wing                     XR 270..550, Z 325..500 -> y 0.360..0.535,
 *                                 at most two elements
 *   Pylons                        <= 25mm thick, 5000mm2 total section
 *   Rain light                    centre Z 295..305 -> y 0.330..0.340, on the
 *                                 centreline, at least 750mm behind the diff
 *
 * WHEELS, TYRES, BRAKES
 *   Rim                           18in, bead seat 457.2mm, outer LIP diameter
 *                                 490.6mm. Magnesium, single supplier
 *   Rim mounting width            335.3mm front, 429.3mm rear
 *   Tyre outside diameter         720mm FRONT AND REAR. Only the width differs
 *   Tread width                   305mm front, 405mm rear (Pirelli). The FIA
 *                                 quotes SECTION width, 345-375 / 440-470,
 *                                 which is the sidewall bulge, not the tread
 *   Visible rubber above the lip  (720-490.6)/2 = 114.7mm. That is the whole
 *                                 sidewall, and it is why this generation's
 *                                 wheel reads as machined rather than balloon
 *   Dry tyres                     SLICKS. No pattern, no sipes, no wear holes
 *   Compound band                 a ring on the SIDEWALL between the rim lip
 *                                 and the tread shoulder, roughly the outer
 *                                 third of the 114.7mm. White hard, yellow
 *                                 medium, red soft, green inter, blue wet
 *   Wheel covers                  MANDATED standard parts, prescribed
 *                                 geometry, near-flat. With the drum and its
 *                                 360deg seal fitted, essentially none of the
 *                                 brake is visible from outside the car
 *   Brake discs                   325-330mm front, 275-280mm rear, 32mm thick,
 *                                 carbon-carbon, ~1000 cooling holes
 *   Calipers                      aluminium, six pistons, one per wheel
 *
 * SUSPENSION
 *   Members                       SIX per corner, no redundant members. Front:
 *                                 two wishbones (2 legs each), trackrod, and
 *                                 the push or pull rod
 *   Front outboard joints         must be inside the drum and no lower than
 *                                 ZW -40, i.e. 40mm BELOW THE WHEEL CENTRE.
 *                                 The upright connection is between ZW 155 and
 *                                 230. So the lower wishbone is very nearly at
 *                                 hub height and the kingpin span is short
 *   Front inboard pickups         above Z 250, the two pairs separated by at
 *                                 least 300mm in X
 *   Anti-dive                     explicitly legal, and universal: in side
 *                                 view the legs rake nose-up going rearward,
 *                                 the front leg's chassis pickup being higher
 *   Member fairings               100mm CHORD MAXIMUM, aspect ratio at most
 *                                 3.5:1, so at least 28.6mm thick. These are
 *                                 FAT blunt sections, not thin aerofoils, and
 *                                 constant along their whole length
 *   Fairing incidence             0 to 10deg nose-DOWN at the front
 *   Layout                        pushrod front / pullrod rear was the common
 *                                 arrangement; Red Bull and McLaren ran
 *                                 pullrod front from 2022, Ferrari from 2025
 *   Travel                        not published, but small: the 2026 rules
 *                                 express the camber limit "per 10mm of
 *                                 travel", and most wheel compliance is in the
 *                                 tyre. Anything that visibly moves is wrong
 *   Steering lock                 23deg/21deg must be ACHIEVABLE; the raced
 *                                 lock is about 14deg, 20deg at Monaco
 *   Springs                       torsion bars inside the monocoque. Nothing
 *                                 of the inboard suspension is visible
 *
 * MATERIALS
 *   Painted bodywork is a dielectric: metalness 0, roughness 0.10-0.20 gloss
 *   or 0.35-0.50 for the matte liveries several teams run to save the 1.3kg a
 *   full paint job costs. Exposed clear-coated carbon 0.15-0.25; bare carbon
 *   0.45-0.60. Rubber 0.85-0.95 and NEVER glossy. The brake disc is matte
 *   sooty grey. The genuinely metallic parts are the halo (titanium), the
 *   wheel nut and flange, the caliper and the exhaust (Inconel, heat-tinted,
 *   never chrome). Under direct sun a real highlight clips SMALL — the sun
 *   subtends half a degree — so a broad blown region is a rendering error.
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
  /** The rear wing's DRS flap, on a pivot at its leading edge. */
  drsFlap: THREE.Object3D;
  /**
   * The two upper front-wing elements, on their X/Z-mode hinge.
   *
   * Driven from the same signal as `drsFlap`, and deliberately so: the point of
   * active aero is that the whole car goes low-drag at once, and a front wing
   * that flattened on a different trigger from the rear flap would read as a
   * bug rather than as a system.
   */
  frontFlaps: THREE.Object3D;
  brakeGlow: THREE.Mesh[];
  /** The bodywork that can be knocked off, by name. */
  bodyParts: Record<BodyPartId, BodyPart>;
  /** Rolling radius, so the renderer knows the wheel's resting height. */
  tyreRadiusM: number;
  /** Knocks a piece of bodywork off, or puts it back after a repair. */
  setPartAttached(id: BodyPartId, attached: boolean): void;
  /**
   * The coarse steering wheel and gloves, and the roll-hoop camera pod.
   *
   * Hidden for the car the cockpit camera is inside, and nothing else is. The
   * wheel and gloves go because CockpitMesh draws a detailed pair in the same
   * place for that one view; the pod goes because the pod IS that camera, and
   * a 68mm housing 300mm in front of the lens is a dark dome across the middle
   * of the frame.
   *
   * The HELMET is deliberately not in here any more. The camera sits behind and
   * above the crown rather than inside the shell, so the helmet is part of the
   * shot — see EYE_Y in CockpitMesh.
   */
  onboardHidden: THREE.Object3D;
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
   * Hiding the pod and the coarse wheel is NOT done here, because the two are
   * not the same decision: the cockpit interior belongs to whichever car is
   * being watched from inside, whereas those have to disappear only for the car
   * the camera is actually inside. The renderer owns that, via `onboardHidden`.
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
//
// These four numbers set the car's whole stance, and the previous set had the
// wheelbase 200mm short. A short wheelbase on a full-width car is exactly the
// proportion an early-2000s car had, and it is most of why this model read as
// the wrong generation next to the reference: the wheels sat too close together
// inside a body that was too wide, so the tyres looked small and the flanks
// looked fat. 3.6m between the axles on a 2.0m track is the current article.
//
// HALF_WIDTH is the regulation limit, not a part of any shape: nothing on the
// car may pass it, and the widest things that come near it are the front wing
// endplates and the rear tyres. See `checkWidth`.
const HALF_WIDTH = 1.0;
const FRONT_AXLE_Z = 1.80;
const REAR_AXLE_Z = -1.80;

// ===========================================================================
// The halo
// ===========================================================================

/**
 * The halo's centreline, car-local, left mount round to right mount.
 *
 * EXPORTED, and that is the point of it being up here instead of inline where
 * it is built. The halo is the single most complained-about object in the
 * project and every previous attempt at it was judged by eye off a screenshot,
 * which is how a hoop that is dimensionally correct ends up framed as two
 * diagonal pipes and nobody can say by how much. `probe:framing` projects THESE
 * numbers through the real camera rig and reports where the hoop lands in the
 * frame, in the same units the reference footage is measured in. If the
 * geometry and the measurement read the same array, they cannot disagree.
 *
 * See the assembly site for what the shape is and why. In short: the rails run
 * from the tub sides at 0.612, hug the coaming through the middle, and crown at
 * 0.812 — a touch below the helmet's 0.828.
 */
export const HALO_PATH: readonly [number, number, number][] = [
  [-0.345, 0.612, -0.30],
  [-0.375, 0.660, -0.05],
  [-0.370, 0.712, 0.30],
  [-0.250, 0.780, 0.62],
  [0.000, 0.812, 0.755],
  [0.250, 0.780, 0.62],
  [0.370, 0.712, 0.30],
  [0.375, 0.660, -0.05],
  [0.345, 0.612, -0.30],
];

/** Half-width of the hoop's section at the mounts, metres. */
export const HALO_R = 0.021;
/** 1.0 at both mounts, 0.72 over the crown: 42mm wide down to 30mm. */
export function haloRadiusAt(u: number): number {
  return 0.72 + 0.28 * Math.abs(u * 2 - 1);
}
/**
 * How much shallower the section is than it is wide. A blade, not a pipe.
 *
 * 0.78, up from 0.58, and this is a correction toward the real part rather than
 * away from it. The rails run near-HORIZONTALLY over the crown, so the
 * dimension a driver sees there is the section's HEIGHT — and at 0.58 on a 26mm
 * crown that was 15mm, which `probe:framing` measures at nine tenths of one per
 * cent of frame width. A real halo's crown is around 30mm across and about as
 * deep; ours was reading as a wire because the squash was taking its depth out
 * of exactly the axis that shows. At 30mm by 0.78 the crown is 23mm tall and
 * still visibly a blade from outside, which is what the squash was for.
 */
export const HALO_SQUASH = 0.78;

/** The forward pillar, bottom to top. */
export const HALO_PILLAR: readonly [number, number, number][] = [
  [0, 0.520, 0.778],
  [0, 0.806, 0.752],
];
export const HALO_PILLAR_R = 0.023;
/** 12mm across the driver's sightline, 46mm front to back. */
export const HALO_PILLAR_SQUASH = 0.26;

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

/**
 * Wheels and tyres: 305/720-R18 front, 405/720-R18 rear.
 *
 * The 720mm outside diameter and the 18-inch (457mm) rim are the whole reason a
 * current car looks different from the one before it: the sidewall is only
 * 131mm tall, so the tyre reads as a machined wheel with a rubber band round it
 * rather than as a balloon. RIM_R is the bead seat; FACE_R is the mandated
 * aerodynamic wheel COVER, which is what is actually seen and which sits a
 * little outside the bead.
 *
 * INTERPENETRATION. Everything below that clears the wheels is derived from
 * these: the inboard face of a rear tyre sits at REAR_HUB_X - REAR_TYRE_W / 2,
 * and no bodywork may cross that line anywhere between REAR_AXLE_Z ± TYRE_R.
 * See `WHEEL_CLEARANCE` below, which the floor and sidepod are checked against.
 */
const TYRE_R = 0.36;
const FRONT_TYRE_W = 0.325;
const REAR_TYRE_W = 0.425;
const RIM_R = 0.229;
/** Outer radius of the wheel cover — the dark disc that closes the wheel face. */
const FACE_R = 0.248;

/**
 * Half the front and rear TRACK — the lateral distance from the car's
 * centreline to a wheel centre.
 *
 * These were derived from HALF_WIDTH by subtracting half a tyre, which put both
 * axles as wide as the car is legally allowed to be: the front track came out at
 * 1665mm and the outer face of a front tyre landed at x = 0.995, a bare 5mm
 * inboard of the bodywork limit and OUTBOARD of the front wing endplates at
 * 0.950. So the widest thing on the front of the car was the tyres, the wing
 * hid behind them, and head-on the two front wheels read as the full width of
 * the car — which is exactly what was asked about, and it was right.
 *
 * The regulations set front track at 1600mm and overall width at 2000mm. With a
 * 305mm front tyre that puts the tyre's outer face at 800 + 152 = 952mm, and the
 * endplate — which is allowed the full 1000 — a clear 45mm outboard of it. That
 * gap is small, but it is the difference between a wing that disappears behind
 * the wheels and one that frames them, and it is visible in every head-on
 * photograph of a real car.
 *
 * The rear is the other way round on a real car: the rear tyres ARE essentially
 * the widest point at their station, so 1560mm of track on a 405mm tyre leaves
 * the outer face at 982mm and nothing outboard of it.
 */
const FRONT_HUB_X = 0.800;
const REAR_HUB_X = 0.780;

/**
 * The inboard face of each tyre: no bodywork may reach this far out where the
 * wheel is.
 *
 * The car in the screenshots had the floor edge at x = 0.788 and the sidepod
 * tail at 0.615, against a rear tyre whose inner wall is at 0.570 — so the
 * rear wheels were driven straight through both, and from three-quarters the
 * tyre visibly emerged out of the middle of the bodywork. Naming the limit is
 * how it stays fixed: every station below that lies within a wheel's z range
 * is authored against it.
 */
const REAR_TYRE_INNER_X = REAR_HUB_X - REAR_TYRE_W * 0.5;
const FRONT_TYRE_INNER_X = FRONT_HUB_X - FRONT_TYRE_W * 0.5;

/**
 * Warns if a piece of bodywork reaches into the space a wheel occupies.
 *
 * Authoring a section list against a written-down limit is not the same thing
 * as respecting it: the resampler interpolates between stations, `undercut`
 * and `flatTop` move the outline, and a floor whose widest station is legal
 * can still bulge past the limit halfway to the next one. That is exactly how
 * the rear tyres ended up passing through the floor and the sidepod without
 * anyone noticing — every individual number looked reasonable.
 *
 * So the check is made against the vertices that actually got built, once per
 * quality tier at startup. It costs one pass over a few thousand positions and
 * it is the difference between "the numbers say it clears" and "it clears".
 */
function checkWheelClearance(geo: THREE.BufferGeometry, label: string): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return geo;
  let worst = 0;
  let worstZ = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const limit = Math.abs(z - REAR_AXLE_Z) < TYRE_R ? REAR_TYRE_INNER_X
      : Math.abs(z - FRONT_AXLE_Z) < TYRE_R ? FRONT_TYRE_INNER_X
      : Infinity;
    const over = Math.abs(pos.getX(i)) - limit;
    if (over > worst) { worst = over; worstZ = z; }
  }
  // 3mm of slack: a surface that grazes the tyre's inner wall by less than the
  // thickness of a decal is not what anybody is looking at.
  if (worst > 0.003) {
    console.warn(
      `[CarMesh] ${label} intersects a wheel by ${(worst * 1000).toFixed(0)}mm at z=${worstZ.toFixed(2)}`,
    );
  }
  return geo;
}

/**
 * Warns if a part reaches outside the car's legal half-width.
 *
 * The same argument as `checkWheelClearance`: an endplate authored at x = 0.987
 * with a 13mm half-thickness is legal on paper and 0.999 in fact, and the loft's
 * superellipse can push a corner further out than either number. The endplates
 * are deliberately built to within a millimetre of the limit — they have to be,
 * because being the widest thing on the front of the car is their job — so the
 * margin for an authoring slip is nil and the check is worth its one pass.
 */
function checkWidth(geo: THREE.BufferGeometry, label: string): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return geo;
  let worst = 0;
  for (let i = 0; i < pos.count; i++) worst = Math.max(worst, Math.abs(pos.getX(i)));
  if (worst > HALF_WIDTH + 0.002) {
    console.warn(`[CarMesh] ${label} is ${((worst - HALF_WIDTH) * 1000).toFixed(0)}mm over the width limit`);
  }
  return geo;
}

/**
 * Rear wing plane, and the pivot the DRS flap hinges about.
 *
 * THE PIVOT IS AT THE FLAP'S TRAILING EDGE, and that is the whole mechanism.
 * It used to be at the leading edge, which cannot open a DRS slot at all: the
 * slot is the gap between the main plane's trailing edge and the flap's LEADING
 * edge, so hinging about the leading edge rotates the flap while leaving the
 * one dimension that matters exactly where it was. What the car did on DRS was
 * change the flap's angle and nothing else — the "opening" the user asked to
 * see was not there to see.
 *
 * Hinged at the trailing edge, the leading edge swings up and forward as the
 * flap lies down, and the slot goes from 14mm closed to about 140mm open. The
 * real regulation range is 10-85mm; this is deliberately past it, because the
 * whole point of the request — "the car wings and flaps open up ... that
 * concept has to be displayed here" — is that a spectator should be able to see
 * it happen from a chase camera thirty metres back.
 *
 * The numbers are derived, not chosen, and the derivation starts at the TOP.
 * The regulations cap the rear wing profiles at Z = 910 above the reference
 * plane, which is y = 0.945 above the road here, and the flap's trailing edge
 * is the highest point on the assembly. So: flap trailing edge at y = 0.935,
 * ten millimetres inside the limit. Working forward from there with a 170mm
 * flap chord at 45.8 degrees puts its leading edge at (0.813, -2.202); a 14mm
 * slot puts the main plane's trailing edge at (0.799, -2.192); and a 235mm main
 * plane chord at 8.9 degrees puts that element's centre at (0.781, -2.076).
 *
 * The whole assembly therefore came DOWN by 45mm from where it was, which had
 * the flap's trailing edge at 0.980 — 35mm over the height limit, and it looked
 * it: the wing stood proud of the airbox instead of sitting under it.
 */
const REAR_WING_Z = -2.076;
const REAR_WING_Y = 0.781;
const DRS_PIVOT_Y = 0.935;
const DRS_PIVOT_Z = -2.320;
/**
 * Top of the rear wing assembly, y. The regulation limit is 0.945; everything
 * up there is authored against this so the endplate, the tip roll and the flap
 * agree about where the ceiling is.
 */
const REAR_WING_TOP_Y = 0.942;
/**
 * Half-span of the rear wing. The regulations put the profiles inboard of
 * Y = 480, so 960mm overall — which is a little over HALF the car's width, and
 * the narrowness is a large part of what the silhouette reads as. It was
 * built at 1020mm.
 */
const REAR_WING_HALF_SPAN = 0.480;
/**
 * Incidence the flap is BUILT at, radians.
 *
 * Chosen against the renderer's open target of -0.85 rad so that the two sum to
 * very nearly zero: open, the flap lies flat, which is what a real one does.
 * Closed, 0.80 rad is 46 degrees, which is a high-downforce specification and
 * the right one to draw, because a steep closed flap is what makes the open
 * position read as a change.
 */
const DRS_CLOSED_RAD = 0.80;
/** Flap chord, metres. Shared by the geometry and by the pivot offset. */
const DRS_FLAP_CHORD = 0.170;

interface Tiers {
  /** Vertices around a ring on the main body lofts. */
  body: number;
  /**
   * Vertices around a ring on the MONOCOQUE specifically.
   *
   * The tub is the one body loft that carries a hole. Forty-four per cent of
   * its ring goes to the cockpit aperture (see `COCKPIT_APERTURE`), so at the
   * ordinary body count the flanks would come out a third coarser than every
   * other panel and the join to the sidepod shoulder would show it. This buys
   * the aperture its vertices without taking them off the bodywork.
   */
  tub: number;
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
    body: 32, tub: 46, detail: 20, bodyStep: 0.11, detailStep: 0.055,
    // 36 round a tyre, not 32.
    //
    // The silhouette was never the problem — 32 sides on a 720mm tyre is a 1.7mm
    // sagitta, which is invisible. What WAS visible, and what "the tyres show
    // visible faceting" is about, is the WHEEL FACE: a flat disc catching a
    // near-grazing highlight shows every one of its facets as a distinct wedge
    // of shading, and the eye reads a polygon there long before it reads one on
    // a curved black silhouette. The cover is built at this count too, so
    // raising it fixes the face and the outline together.
    wheel: 36, tyreRings: 6, spoke: 6, halo: 44, haloRadial: 12,
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
    body: 14, tub: 22, detail: 8, bodyStep: 0, detailStep: 0,
    // 14, not 12. A twelve-sided wheel has an 8.5mm sagitta, and the cheap tier
    // is what a phone runs for the WHOLE field including the car in front — the
    // one object a player looks at more than any other.
    wheel: 14, tyreRings: 3, spoke: 4, halo: 14, haloRadial: 4,
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
  /**
   * The two upper front-wing elements, which MOVE.
   *
   * A sixth bucket rather than a fifth body part: it is not something the car
   * can lose on its own — it leaves with the front wing, exactly as the rear
   * DRS flap leaves with the rear wing — but it does have to be its own mesh,
   * because it hangs on a pivot that rotates for X-mode. Its geometry is
   * authored about that pivot rather than about the car's origin.
   */
  readonly frontFlap: THREE.BufferGeometry[] = [];
  /**
   * Bodywork that must not be drawn for the car the onboard camera is inside.
   *
   * Exactly one thing qualifies, and it qualifies absolutely: the pod on top of
   * the roll hoop IS the onboard camera. Rendering it from its own lens is the
   * same mistake as rendering the inside of the driver's helmet, and it was a
   * much more expensive one — a 68mm housing 300mm in front of the eye is a
   * dark dome across the middle of the frame, which is precisely the "large
   * round mass filling the centre" the onboard view was reported for.
   *
   * It shares the mesh with the coarse wheel and gloves, which are hidden on
   * the same condition for the same reason (CockpitMesh draws better ones), so
   * the split costs no extra draw call.
   */
  readonly onboardHidden: THREE.BufferGeometry[] = [];

  private target: THREE.BufferGeometry[] = this.core;

  /** Directs everything added from here on into the named bucket. */
  into(bucket: 'core' | BodyPartId): void {
    this.target = this[bucket];
  }

  /** Directs everything added from here on into the movable front flaps. */
  intoFrontFlap(): void {
    this.target = this.frontFlap;
  }

  /** Directs everything added from here on into the onboard-hidden bucket. */
  intoOnboardHidden(): void {
    this.target = this.onboardHidden;
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
 * The cockpit aperture: where the deck stops and the survival cell opens.
 *
 * `edge` is quoted through `apertureEdge` rather than as a raw ring parameter
 * so the number in the source is one that can be held against a photograph: the
 * opening runs to 68% of the tub's half-width, which on a 680mm survival cell
 * is a 460mm hole — the width a driver's shoulders actually pass through, and
 * within a few millimetres of what the reference frames measure. Because the
 * fraction is applied to each station's OWN profile, the opening tapers with
 * the tub: 187mm half-width at the front bulkhead, 234mm at the shoulders.
 *
 * `share` is a vertex budget, not a shape. A tub section at `round` 0.18 spends
 * nine tenths of its ring on the flanks and corners, so the aperture band would
 * otherwise get three vertices out of thirty-two to build a lip, two walls and
 * a floor from. Forty-four per cent of the ring goes to the twelve per cent of
 * the profile that is now the most-looked-at part of the car — it is 500mm from
 * the cockpit camera and the driver sits in it.
 */
const COCKPIT_APERTURE: OpenTop = {
  edge: apertureEdge(0.22, 0.68),
  share: 0.44,
  roll: 0.15,
  wallExp: 4.6,
  // Dark inside, painted outside. The first version of the aperture was the
  // right hole in the right place and still did not read as one, because the
  // trough was in the team's colour to the floor and a body-coloured dish is a
  // dished PANEL — which is the same complaint the solid deck drew, in a new
  // shape. The dark interior under a lit coaming is what makes it a hole.
  //
  // `dark` and not `carbon`: the swatches carry roughness as well as colour,
  // and carbon is CLEAR-COATED laminate at 0.38 rough. A tub lined in it
  // mirrored the sky and came out glossy blue, which reads as a hole full of
  // water. `dark` is 0.90 and near black, which is what a survival cell is.
  interiorUV: swatchUV('dark'),
};

/**
 * The monocoque, from the nose tip to the rear crash structure.
 *
 * These numbers are the shape of the car. A narrow tip barely wider than a
 * forearm; a fast rise and spread into the survival cell; the cockpit opening
 * at the widest point; a shoulder over the fuel cell; then a long, hard taper
 * to a rear end narrow enough to see daylight around.
 *
 * THE COCKPIT OPENING IS NOW A HOLE. It used to be a comment. The stations
 * through the survival cell carried a `flatTop` schedule and nothing else, so
 * the deck ran unbroken at y 0.562-0.594 from the driver's knees to the roll
 * hoop: the tub interior and the headrest were sealed underneath it, the helmet
 * sat on top of it like a ball on a table, and from the driver's own camera it
 * was the flat expanse of paint filling the bottom half of the frame. What
 * makes it an opening is `openDepth` — see `OpenTop` in Loft.ts — and the
 * schedule below is the shape of the hole seen in side view: closed ahead of
 * the dash, dishing down through the scuttle, full depth from the driver's
 * knees to behind his shoulders, and closing again into the rear bulkhead
 * before the airbox picks the line up.
 *
 * THE FLANKS ARE RE-PROPORTIONED FOR IT. With the deck gone the tub is read
 * from its shoulder line rather than from its roof, and the old stations were
 * a touch narrow and a touch flat-sided for that: the survival cell now grows
 * to 680mm at the shoulders and carries a continuous crown from 0.540 at the
 * bulkhead to 0.608 over the fuel cell, so the coaming rises gently toward the
 * back the way the reference car's does instead of stepping.
 */
function monocoque(): Section[] {
  return [
    // A SLIM, HIGH nose. This is the single change that moves the car a
    // generation forward, and the previous version had it backwards: the tip
    // was 256mm across and its underside sat 128mm off the road, so the nose
    // was a wide wedge running down almost to the wing and the whole front of
    // the car read as one solid mass. The current article is a blade about
    // 190mm across whose underside stays a good 230mm up, with clear daylight
    // between it and the mainplane — that gap is what the eye reads as "modern
    // F1", and it is why the nose has to drop onto the SECOND element on two
    // pillars rather than merging into the wing.
    section(2.72, 0.076, 0.292, 0.462, 0.66),
    section(2.54, 0.090, 0.272, 0.470, 0.60),
    section(2.30, 0.112, 0.242, 0.480, 0.52),
    section(1.98, 0.150, 0.200, 0.494, 0.44),
    section(1.50, 0.208, 0.150, 0.514, 0.37),
    // Front bulkhead. The last closed station: the deck runs across here, which
    // is what the driver's feet are under and what the dash is bolted to.
    section(1.06, 0.282, 0.106, 0.540, 0.29, { flatTop: 0.22 }),
    // The scuttle. A shallow dish rather than a step — the deck ahead of a
    // driver's hands falls away into the tub over about 300mm, and cutting it
    // as a cliff is what would make the opening look punched rather than
    // moulded.
    section(0.90, 0.300, 0.102, 0.550, 0.26,
      { flatTop: 0.34, openDepth: 0.060, openWall: 0.020 }),
    section(0.66, 0.322, 0.094, 0.562, 0.22,
      { flatTop: 0.55, openDepth: 0.158, openWall: 0.020 }),
    // Full depth: the survival cell proper, floor at y 0.35, which is under the
    // driver's seat and 270mm below the coaming.
    section(0.34, 0.336, 0.086, 0.570, 0.19,
      { flatTop: 0.68, openDepth: 0.208, openWall: 0.020 }),
    section(0.10, 0.340, 0.080, 0.576, 0.18,
      { flatTop: 0.74, openDepth: 0.222, openWall: 0.020 }),
    section(-0.24, 0.336, 0.082, 0.590, 0.20,
      { flatTop: 0.66, openDepth: 0.214, openWall: 0.022 }),
    // Rear bulkhead, behind the headrest and ahead of the airbox throat.
    section(-0.44, 0.324, 0.086, 0.598, 0.24,
      { flatTop: 0.48, openDepth: 0.048, openWall: 0.024 }),
    section(-0.60, 0.308, 0.088, 0.604, 0.32, { flatTop: 0.22 }),
    // Over the fuel cell and the power unit, then a long hard taper. The tail
    // has to get genuinely thin — the reference car shows daylight between the
    // engine cover and both rear tyres — and it also has to be inboard of
    // REAR_TYRE_INNER_X (0.570) everywhere aft of z = -1.44.
    section(-0.80, 0.290, 0.090, 0.608, 0.42),
    section(-1.26, 0.216, 0.104, 0.578, 0.56),
    section(-1.70, 0.142, 0.124, 0.492, 0.72),
    section(-2.06, 0.080, 0.156, 0.390, 0.90),
    section(-2.28, 0.042, 0.196, 0.314, 1.00),
  ];
}

/**
 * Sidepod: a tall inlet that undercuts hard and then pulls IN as well as down
 * into the coke bottle.
 *
 * The pod carries its own centreline (`xc`) rather than being lofted about
 * x = 0 and translated. That is not tidiness — a pod at a constant offset has
 * its tail at the same x as its inlet, and its tail is where the rear tyre is.
 * The old one ran out to x = 0.615 at z = -1.70, straight through a tyre whose
 * inner wall is at 0.570, which is the interpenetration in the screenshots.
 *
 * Pulling the centreline from 0.505 at the inlet to 0.196 at the exit gives
 * both the fix and the shape: the empty channel between the pod and the rear
 * wheel is one of the half-dozen silhouettes that says "current F1 car", and
 * it cannot exist while the pod is a constant-offset extrusion.
 *
 * @param side -1 for the left-hand pod, +1 for the right.
 */
function sidepod(side: 1 | -1): Section[] {
  const s = side;
  return [
    // A tall inlet face. The pod has to present a real front to the airflow,
    // because that face is what the inlet is cut into. The current generation's
    // inlet sits HIGH with a deep scallop under it, so the top of the pod is
    // near the cockpit rim and the underside is 250mm up.
    // THE UNDERCUT HAS TO BE A REAL GAP. The old pod's underside ran at 176mm
    // over a floor whose upper surface is at 112mm, so the "undercut" was a
    // 60mm slot that no light and no shadow could get into — from three-quarters
    // the flank was one unbroken painted surface from the nose to the tail and
    // the sidepod did not exist as a separate object at all. Lifting the
    // underside to 300mm opens a channel deep enough to go properly dark, and
    // that dark band under a lit shoulder is the sidepod, as far as the eye is
    // concerned.
    //
    // The top surface also drops BELOW the cockpit rim (0.558 on the tub), which
    // it did not before — the two were within 2mm of each other, so there was no
    // shoulder line either.
    //
    // IT WAS 172mm TALL. That is the number behind "long tube sidepods, a
    // narrow flat-topped body, no undercut, no coke-bottle rear" and behind the
    // top-view render in which the sidepods simply are not visible as objects.
    // The regulations allow the pod 600mm above the reference plane — y 0.635
    // here — and 775mm of half width, and a real car uses very nearly all of
    // both. Ours used 172mm of the height and 748mm of the width, so the pod
    // was a low blister on the side of a fuselage rather than the largest
    // single volume on the car, which is what it is.
    //
    // The inlet face now runs 0.268 to 0.552, which is 284mm — two thirds
    // taller — and the top surface starts level with the cockpit coaming and
    // ramps DOWN and IN from there. That downwash ramp is the shape the whole
    // grid converged on by 2023, and it is the thing that makes the flank read
    // as a sidepod rather than as bodywork.
    //
    // THE COKE BOTTLE starts at XF = 1300, which is z = 0.50 here, and the
    // regulations forbid any rearward-facing surface behind XR = -300 — so the
    // taper from there back has to be continuous and hard. It now loses 60 per
    // cent of its width in the metre behind z = -0.08.
    section(0.98, 0.196, 0.268, 0.540, 0.13, { undercut: 0.74, xc: s * 0.548 }),
    section(0.76, 0.226, 0.262, 0.552, 0.17, { undercut: 0.50, xc: s * 0.552 }),
    section(0.50, 0.246, 0.256, 0.548, 0.21, { undercut: 0.38, xc: s * 0.542 }),
    section(0.12, 0.244, 0.248, 0.524, 0.26, { undercut: 0.32, xc: s * 0.524 }),
    section(-0.30, 0.226, 0.240, 0.478, 0.30, { undercut: 0.30, xc: s * 0.498 }),
    section(-0.72, 0.194, 0.232, 0.412, 0.36, { undercut: 0.30, xc: s * 0.452 }),
    section(-1.16, 0.146, 0.226, 0.340, 0.46, { undercut: 0.38, xc: s * 0.386 }),
    section(-1.56, 0.088, 0.216, 0.278, 0.62, { undercut: 0.52, xc: s * 0.296 }),
    section(-1.92, 0.034, 0.204, 0.232, 0.88, { undercut: 0.70, xc: s * 0.194 }),
  ];
}

/**
 * The sidepod's own centreline at the inlet face.
 *
 * Everything bolted to the front of the pod — the mouth, the splitter across
 * it, the side impact blade — is placed against this rather than against the
 * car's centreline, so that moving the pod moves its furniture with it. It
 * moved out by 42mm when the pod grew; see `sidepod`.
 */
const POD_X = 0.548;

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

// ===========================================================================
// Front wing
// ===========================================================================

/**
 * The front wing, and what was wrong with the one before it.
 *
 * This is the part of the car a viewer reads first and the part that dates it
 * hardest, and the previous version failed on all four of the things that make a
 * current wing look like one. It was FLAT ACROSS, so head-on it drew a straight
 * dark bar. Its four elements had DECREASING chord going up and back and they
 * overlapped each other by seventy per cent of their chord, so no daylight ever
 * appeared between them and the whole assembly fused into a single rolled slab.
 * Its endplates were 26mm-thick slivers that leaned INBOARD toward the rear, so
 * from any angle they were an edge rather than a panel. And the tyres were wider
 * than all of it. The result reads as a snowplough, which is what was reported.
 *
 * What a current front wing actually is, from the head-on garage photographs:
 *
 *  - FOUR THIN ELEMENTS, each only 13-15mm thick, of INCREASING chord and
 *    INCREASING incidence going up and back, with a real slot gap — 10 to 20mm
 *    of visible daylight — between each pair. The staircase and the gaps are the
 *    whole read: it is an assembly of four separate aerofoils, not one moulding.
 *  - THE SHALLOW W. The elements fall away either side of the nose to a low
 *    point near the middle of each semi-span and then climb out to the endplate.
 *    See `riseSpanwise`, which is where that curve is applied and why it is
 *    applied where it is.
 *  - A LARGE CURVED ENDPLATE, growing from about 145mm tall at the leading edge
 *    to 320mm at the rear and flaring OUTBOARD as it goes, with a footplate
 *    rolling out along the bottom and a flick over the top. It is the widest
 *    thing on the car at this station and it is what frames the front wheels.
 *  - CLEAR-COATED CARBON, everywhere. Not team paint.
 *
 * Element geometry is authored as LEADING and TRAILING EDGE POINTS rather than
 * as a centre and an angle. Chord and incidence are then derived. That is not a
 * style preference: the slot gaps are the thing being designed, a slot gap is
 * the distance between one element's trailing edge and the next one's lower
 * surface, and with a centre-and-angle parameterisation neither of those two
 * points is a number you typed — which is how the previous version ended up with
 * gaps that were negative.
 */

/**
 * The hinge the two upper elements rotate about for X-mode, at the third
 * element's leading edge.
 *
 * ACTIVE AERO ON THE FRONT WING. The 2026 rules move active aerodynamics to the
 * front wing as well as the rear: Z-mode is the high-downforce position the wing
 * is built in below, and X-mode rotates the upper elements flat for the
 * straights so the car sheds drag. Hinging both together at the third element's
 * leading edge is how the real mechanism is arranged and it keeps the pair
 * rigid relative to each other, which is what the reference plan view shows.
 */
const FRONT_FLAP_PIVOT_Y = 0.148;
const FRONT_FLAP_PIVOT_Z = 3.086;

/**
 * How far the upper front-wing elements rotate for X-mode, radians, negative
 * because flattening a wing means dropping its trailing edge.
 *
 * 0.20 rad is only 11 degrees, and it takes the top of the wing down by 76mm out
 * of 300 — a quarter of the assembly's height. It has to be that big to read at
 * racing distance and it cannot be much bigger: at 0.22 the third element's
 * lower surface starts to touch the second element's trailing edge.
 */
export const FRONT_X_MODE_RAD = -0.20;

/** Semi-span coordinate at which the elements reach their low point. */
const W_LOW_AT = 0.45;
/**
 * How far the elements fall below the root at that point, metres.
 *
 * Bounded from below by the road. The mainplane's lower surface sits 38mm up at
 * the root, so a 26mm dip — which is what this was first built with — puts the
 * middle of each semi-span 2mm UNDERGROUND, and the wing visibly ploughs into
 * the tarmac either side of the nose. 22mm leaves 16mm of clearance, which is
 * about what a real wing runs and is as close as it should get.
 */
const W_DIP = 0.022;
/**
 * How far above the root they finish, at the endplate.
 *
 * Bounded from above by the endplate, which has to contain the elements it is
 * bolted to: the top element's trailing edge climbs by 72 per cent of this and
 * has to stay under the plate's upper edge at the same station.
 */
const W_TIP_RISE = 0.062;

/**
 * The shallow W, as a function of |x| / halfSpan.
 *
 * `scale` trims the curve for the upper elements. Applying the identical rise to
 * all four would translate the whole stack bodily upward at the tips, and the
 * top element would finish 350mm off the road — outside the box the rules draw.
 * A real wing instead CLOSES UP outboard: the upper flaps are trimmed down
 * toward the mainplane as they approach the endplate, so the assembly is
 * shallower at the tip than at the root. Scaling the rise reproduces that with
 * no extra geometry.
 */
function wingW(scale: number): (a: number) => number {
  return (a) => {
    if (a <= W_LOW_AT) {
      // Root to low point: a half-cosine, so it leaves the centreline smoothly
      // instead of drawing a crease down either side of the nose.
      return -W_DIP * scale * (1 - Math.cos((a / W_LOW_AT) * Math.PI)) * 0.5;
    }
    // Low point to tip. Raised to a power rather than eased at both ends: the
    // real curve is still climbing where it meets the endplate, and easing it
    // flat there makes the tip look clipped off.
    const s = (a - W_LOW_AT) / (1 - W_LOW_AT);
    return (-W_DIP + (W_DIP + W_TIP_RISE) * Math.pow(s, 1.55)) * scale;
  };
}

/**
 * One element: span, leading edge, trailing edge, thickness, rise scale, and
 * whether it belongs to the movable upper pair.
 *
 * Spans grow slightly with each element because the endplate flares outboard as
 * it goes back, so the upper elements have further to reach before they meet it.
 */
const FRONT_WING_ELEMENTS: {
  span: number; leZ: number; leY: number; teZ: number; teY: number;
  thick: number; rise: number; movable: boolean;
}[] = [
  { span: 1.900, leZ: 3.248, leY: 0.052, teZ: 3.140, teY: 0.062, thick: 0.013, rise: 1.00, movable: false },
  { span: 1.918, leZ: 3.180, leY: 0.088, teZ: 3.026, teY: 0.122, thick: 0.013, rise: 0.93, movable: false },
  { span: 1.936, leZ: 3.086, leY: 0.148, teZ: 2.888, teY: 0.210, thick: 0.014, rise: 0.84, movable: true },
  { span: 1.954, leZ: 2.972, leY: 0.226, teZ: 2.720, teY: 0.314, thick: 0.015, rise: 0.72, movable: true },
];

function buildFrontWing(p: Parts, t: Tiers): void {
  p.into('frontWing');

  for (const e of FRONT_WING_ELEMENTS) {
    const dz = e.leZ - e.teZ;
    const dy = e.teY - e.leY;
    const chord = Math.hypot(dz, dy);
    // Positive rotation about X drops the leading edge and lifts the trailing
    // edge, which is the way round an inverted wing works.
    const angle = Math.atan2(dy, dz);
    // Camber proportional to chord, so all four are the same aerofoil at four
    // sizes rather than four differently-shaped ones. It also has to stay
    // modest: the camber line bows the section DOWNWARD by its full amount at
    // 40 per cent chord, and at the 28 per cent of chord a really aggressive
    // front wing runs it eats the slot gap above the element below it.
    const camber = -0.10 * chord;
    // Sixteen interior stations. The W below is a curve across the span and a
    // curve drawn through two stations is a straight line; at six it came out
    // as a visible chevron either side of the nose.
    const g = wingElement(e.span, chord, e.thick, camber, t.wing, 0.085, t.wing >= 10 ? 16 : 7);
    g.rotateX(angle);
    // The W is applied AFTER the incidence, in car-local Y. See `riseSpanwise`.
    riseSpanwise(g, e.span * 0.5, wingW(e.rise));
    if (e.movable) {
      // Authored about the hinge, so the pivot group can simply be placed at it.
      g.translate(0, (e.leY + e.teY) * 0.5 - FRONT_FLAP_PIVOT_Y, (e.leZ + e.teZ) * 0.5 - FRONT_FLAP_PIVOT_Z);
      p.intoFrontFlap();
      p.flat(g, 'carbon');
      p.into('frontWing');
    } else {
      g.translate(0, (e.leY + e.teY) * 0.5, (e.leZ + e.teZ) * 0.5);
      p.flat(g, 'carbon');
    }
  }

  const small = (s: readonly Section[], cols = t.detail) => loft(s, cols, true, t.detailStep);

  for (const side of [-1, 1] as const) {
    const s = side;

    // ENDPLATE. A large curved vertical panel that grows and wraps outboard and
    // rearward. The old one ran 0.944 -> 0.930 in x, so it leaned INBOARD going
    // back, which is backwards — every real endplate flares out to turn the
    // front tyre's wake around the outside of the wheel. This one runs 0.950 out
    // to 0.987, which with its 12mm half-thickness puts its outer skin at
    // x = 0.999: the widest thing on the car, as it should be, and 47mm outboard
    // of the front tyre.
    const ep = small([
      section(3.235, 0.010, 0.055, 0.215, 0.28, { xc: s * 0.950 }),
      section(3.080, 0.012, 0.038, 0.285, 0.24, { xc: s * 0.966 }),
      section(2.900, 0.013, 0.028, 0.345, 0.22, { xc: s * 0.978 }),
      section(2.720, 0.013, 0.026, 0.372, 0.22, { xc: s * 0.986 }),
      section(2.600, 0.011, 0.034, 0.350, 0.30, { xc: s * 0.987 }),
    ], t.body - 8);
    p.flat(checkWidth(ep, 'front wing endplate'), 'carbon');

    // FOOTPLATE: the outward curl along the bottom of the endplate. It sits at
    // ground level, it is the last thing to clear a kerb, and it is in every
    // head-on photograph as a bright horizontal line under the dark plate.
    const foot = small([
      section(3.20, 0.026, 0.022, 0.052, 0.60, { xc: s * 0.952 }),
      section(3.00, 0.032, 0.018, 0.050, 0.55, { xc: s * 0.962 }),
      section(2.80, 0.034, 0.020, 0.052, 0.55, { xc: s * 0.964 }),
      section(2.64, 0.026, 0.026, 0.056, 0.60, { xc: s * 0.968 }),
    ], Math.max(6, t.detail - 4));
    p.flat(checkWidth(foot, 'front wing footplate'), 'carbon');

    // UPPER FLICK: the small winglet folded over the top of the endplate's
    // trailing corner. It is what stops the endplate reading as a plain
    // rectangle in silhouette.
    const flick = small([
      section(2.94, 0.014, 0.322, 0.340, 0.70, { xc: s * 0.958 }),
      section(2.80, 0.024, 0.352, 0.376, 0.70, { xc: s * 0.948 }),
      section(2.66, 0.020, 0.344, 0.364, 0.70, { xc: s * 0.940 }),
    ], Math.max(6, t.detail - 4));
    p.flat(checkWidth(flick, 'front wing flick'), 'carbon');

    // DIVEPLANE on the endplate's outer face, and the one place the team's
    // colour belongs on an otherwise entirely carbon assembly.
    //
    // A LOFT, not a `wingElement`. An extruded aerofoil is symmetric about the
    // point it is translated to, so a 140mm-span element placed on an endplate
    // at x = 0.985 reaches out to 1.055 — 55mm outside the car's legal width and
    // hanging in mid-air past the end of the wing. That is what was there, and
    // it is the yellow blade sticking out past each wing tip in the head-on
    // screenshots. A diveplane is a small plate ON the outer skin; built as a
    // three-station loft it can be exactly that, and `checkWidth` proves it.
    const dive = small([
      section(2.980, 0.024, 0.208, 0.226, 0.60, { xc: s * 0.972 }),
      section(2.860, 0.028, 0.220, 0.240, 0.60, { xc: s * 0.970 }),
      section(2.760, 0.021, 0.228, 0.246, 0.60, { xc: s * 0.966 }),
    ], Math.max(6, t.detail - 4));
    p.flat(checkWidth(dive, 'front wing diveplane'), 'accent');
  }

  p.into('core');
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
  // The one loft in the project with an open top. Everything else here is a
  // closed body; this one has a cockpit in it.
  p.painted(
    loft(monocoque(), t.tub, true, t.bodyStep, COCKPIT_APERTURE),
    'body',
  );

  // --- Cockpit coaming ----------------------------------------------------
  // The dark padded rim round the opening, and the last thing the aperture
  // needed to read as one.
  //
  // A hole cut in a curved surface has no edge of its own: what the eye sees is
  // a gradient from lit paint into shadow, and at any distance that is a dark
  // PATCH rather than an opening. Every reference frame has a hard black line
  // all the way round the cockpit — a moulded surround with padding bonded over
  // it — and that line is what makes the shape legible. It also does the job
  // the geometry cannot: a 22mm rail catches a specular highlight along its
  // whole length, so the opening is drawn by a bright line rather than by an
  // absence.
  //
  // The stations follow the aperture's own coaming, which is not a free
  // parameter: `COCKPIT_APERTURE` puts the lip at 68 per cent of each station's
  // half-width, and these x and y are that point on the tub's profile, station
  // by station. Tapered to nothing at both ends so the rail runs out into the
  // bodywork instead of stopping in a blunt cap.
  for (const side of [-1, 1] as const) {
    const rail = (z: number, x: number, y: number, w: number) =>
      section(z, w, y - 0.009, y + 0.009, 0.85, { xc: side * x });
    p.flat(small([
      rail(1.045, 0.186, 0.538, 0.0035),
      rail(0.960, 0.194, 0.543, 0.0115),
      rail(0.780, 0.211, 0.554, 0.0130),
      rail(0.500, 0.227, 0.566, 0.0130),
      rail(0.180, 0.234, 0.574, 0.0130),
      rail(-0.120, 0.233, 0.584, 0.0130),
      rail(-0.340, 0.226, 0.593, 0.0125),
      rail(-0.440, 0.216, 0.596, 0.0040),
    ], t.detail), 'carbon');
  }

  // --- Nose-to-wing transition -------------------------------------------
  // The nose does not stop in mid-air; it drops onto the second wing element.
  // This little wedge is what makes the front of the car read as one piece.
  //
  // It belongs to the WING, not to the nose: it is the fairing over the wing
  // mounts, so when the wing is torn off this goes with it and the nose is left
  // as the blunt stub a real car is left with.
  //
  // IT HAS TO REACH THE WING. The old wedge stopped at y = 0.168, a clear 25mm
  // above the second element and 170mm short of the mainplane, so the nose ended
  // in mid-air and the wing was a separate slab underneath it. From behind and
  // above — where the wing itself is hidden by the tyres and the nose is not —
  // that is all you can see, and it reads as two unrelated objects. The
  // reference car has no gap and no step: the nose runs forward and DOWN as one
  // continuous form and merges into the wing's inner elements at the tip, and
  // the inner sections spring straight out of its flanks.
  //
  // So the last station is carried down to y = 0.046, which is BELOW the
  // mainplane's upper surface at that station. It interpenetrates deliberately:
  // both surfaces are the same near-black carbon, the intersection is 92mm wide
  // on the car's centreline, and a surface that stops exactly on another one
  // leaves a visible seam the moment either is resampled. Overlapping them is
  // what makes the junction read as a fillet instead of as a butt joint.
  //
  // It stays NARROW — 92mm across at the tip against 148mm at the top — so the
  // daylight either side of the nose and under the wing survives. That gap is
  // the thing the eye reads as "modern F1"; closing it would trade one wrong
  // silhouette for another.
  //
  // STATIONS RUN FRONT TO BACK, like every other loft in this file, and that is
  // not a style point. `loft` winds its quads in a fixed direction around the
  // ring, so reversing the station order reverses which way the surface faces.
  // Authored back-to-front, as this one was, the whole wedge comes out inside
  // out: the outer skin is back-facing and culled by the shell material, the
  // computed normals point inward, and what actually reaches the screen is the
  // dark interior of the far side. That is why the nose still ended in mid-air
  // above the wing from behind and above, long after the geometry above was
  // written to close exactly that gap — the geometry was there and simply not
  // being drawn.
  p.into('frontWing');
  p.flat(small([
    section(3.16, 0.046, 0.046, 0.152, 0.68),
    section(3.08, 0.052, 0.116, 0.238, 0.62),
    section(2.94, 0.062, 0.212, 0.348, 0.62),
    section(2.74, 0.074, 0.288, 0.458, 0.66),
  ], t.body - 6), 'carbon');
  p.into('core');

  // --- Sidepods -----------------------------------------------------------
  for (const side of [-1, 1] as const) {
    p.into(side < 0 ? 'sidepodL' : 'sidepodR');
    p.painted(checkWheelClearance(big(sidepod(side), t.body - 4), 'sidepod'), 'pod');

    // Inlet: a dark duct standing proud of the pod face, so the mouth reads as a
    // hole in bodywork rather than as a painted-on rectangle. Nearly square
    // corners, because the current generation's inlets are letterboxes.
    //
    // Grown with the pod behind it. A 120mm-tall mouth on a 172mm-tall pod was
    // proportionally right and absolutely tiny; on the 284mm face it now sits
    // in, the opening is 190mm tall and 340mm across, and at that size it is
    // the first thing the eye finds on the flank — which is what an inlet is
    // for.
    const mouth = small([
      section(0.995, 0.170, 0.302, 0.492, 0.10),
      section(0.86, 0.144, 0.316, 0.470, 0.20),
      section(0.66, 0.102, 0.338, 0.436, 0.35),
    ]);
    mouth.translate(side * POD_X, 0, 0);
    p.flat(mouth, 'dark');

    // Splitter across the inlet. One bar is the difference between a duct and a
    // black rectangle.
    const splitter = roundedBar(0.324, 0.024, 0.050, 0.008, t);
    splitter.translate(side * POD_X, 0.396, 0.992);
    p.flat(splitter, 'body');

    // Side impact structure: the horizontal blade that stands out of the pod
    // shoulder just under the inlet, and the single most-photographed edge on a
    // current car. It also casts the hard line along the top of the undercut,
    // which is what turns a curved flank into two surfaces.
    const sis = small([
      section(1.020, 0.090, 0.272, 0.308, 0.55),
      section(0.86, 0.108, 0.264, 0.306, 0.45),
      section(0.58, 0.098, 0.256, 0.296, 0.50),
    ], Math.max(6, t.detail - 4));
    sis.translate(side * (POD_X + 0.104), 0, 0);
    p.flat(sis, 'carbon');
    p.into('core');
  }

  // --- Floor --------------------------------------------------------------
  // Wider than the bodywork, as the current floor is, so it shows in plan view —
  // but it has to NARROW again before the rear axle. The regulation diffuser is
  // 1050mm across (half-width 0.525) precisely because it has to pass between
  // two 405mm rear tyres whose inner walls are 1140mm apart, and the old floor
  // held 0.740 all the way to z = -1.45 and simply intersected them.
  p.flat(checkWheelClearance(big([
    section(2.20, 0.150, 0.048, 0.096, 0.32, { flatTop: 0.78 }),
    section(1.56, 0.278, 0.046, 0.102, 0.25, { flatTop: 0.85 }),
    section(1.00, 0.556, 0.044, 0.106, 0.18, { flatTop: 0.90 }),
    section(0.40, 0.792, 0.042, 0.112, 0.14, { flatTop: 0.92 }),
    section(-0.60, 0.800, 0.044, 0.118, 0.14, { flatTop: 0.92 }),
    section(-1.06, 0.744, 0.048, 0.130, 0.16, { flatTop: 0.90 }),
    section(-1.42, 0.545, 0.052, 0.146, 0.20, { flatTop: 0.86 }),
    section(-1.70, 0.522, 0.056, 0.156, 0.22, { flatTop: 0.85 }),
  ], t.body - 6), 'floor'), 'carbon');

  // Diffuser: the floor ramping up under the rear crash structure, held inside
  // the 1050mm the rear tyres leave for it.
  p.flat(checkWheelClearance(big([
    section(-1.70, 0.522, 0.056, 0.156, 0.22, { flatTop: 0.85 }),
    section(-1.96, 0.522, 0.096, 0.198, 0.26, { flatTop: 0.80 }),
    section(-2.16, 0.514, 0.152, 0.254, 0.30, { flatTop: 0.76 }),
    section(-2.32, 0.480, 0.218, 0.308, 0.36, { flatTop: 0.70 }),
    section(-2.36, 0.432, 0.250, 0.326, 0.42),
  ], t.body - 6), 'diffuser'), 'carbon');

  // Diffuser exit and strakes. The exit is a dark volume standing proud of the
  // diffuser's rear face; the strakes are the vertical fins across it.
  {
    // Front to back, for the same reason the nose-to-wing fairing is: authored
    // the other way round the surface faces inward and is culled.
    const exit = small([
      section(-2.18, 0.492, 0.192, 0.292, 0.35),
      section(-2.355, 0.420, 0.250, 0.320, 0.42),
    ], t.body - 8);
    p.flat(exit, 'dark');
    // Strakes sit INSIDE the diffuser throat. Hung off the back they read as a
    // comb bolted to the tail, which is what the first attempt looked like.
    for (const x of [-0.33, -0.12, 0.12, 0.33]) {
      const fin = roundedBar(0.013, 0.082, 0.30, 0.004, t);
      fin.translate(x, 0.272, -2.26);
      p.flat(fin, 'carbon');
    }
  }

  // Floor edge: the thin vertical lip that runs the length of the floor, and
  // the leading-edge fences ahead of it.
  //
  // The edge now follows the floor's own plan outline via `xc` instead of
  // running dead straight at x = 0.788. Straight, it hung 200mm outboard of the
  // floor it is supposed to be the edge of once the floor started narrowing,
  // and it reached back to within touching distance of the rear tyre.
  for (const side of [-1, 1] as const) {
    const s = side;
    const edge = small([
      section(1.34, 0.019, 0.056, 0.140, 0.22, { xc: s * 0.680 }),
      section(0.60, 0.022, 0.048, 0.172, 0.20, { xc: s * 0.796 }),
      section(-0.40, 0.022, 0.046, 0.178, 0.20, { xc: s * 0.804 }),
      section(-1.02, 0.020, 0.052, 0.162, 0.22, { xc: s * 0.756 }),
      section(-1.36, 0.016, 0.058, 0.150, 0.30, { xc: s * 0.572 }),
    ], t.detail - 4);
    p.flat(edge, 'carbon');

    // Floor fences: the row of vertical vanes ahead of the floor's leading edge
    // that every current car carries, and the thing a viewer sees through the
    // gap between the nose and the front tyre.
    for (const [z, x, len] of [
      [1.42, 0.30, 0.34], [1.36, 0.42, 0.30], [1.28, 0.53, 0.26], [1.20, 0.62, 0.22],
    ] as const) {
      const fence = roundedBar(0.011, 0.088, len, 0.004, t);
      fence.rotateY(s * 0.13);
      fence.translate(s * x, 0.092, z);
      p.flat(fence, 'carbon');
    }
  }

  // --- Front wing ---------------------------------------------------------
  buildFrontWing(p, t);

  // --- Front brake ducts / wheel-wake fins --------------------------------
  // NOTE: the duct proper now lives on the STEER group so that it turns with the
  // wheel — see `uprightParts`. What stays here is the inboard wake fin, which
  // is bolted to the chassis and does not steer.
  for (const side of [-1, 1] as const) {
    const fin = small([
      section(FRONT_AXLE_Z + 0.34, 0.016, 0.150, 0.360, 0.30),
      section(FRONT_AXLE_Z + 0.06, 0.020, 0.126, 0.412, 0.25),
      section(FRONT_AXLE_Z - 0.24, 0.015, 0.144, 0.366, 0.30),
    ], Math.max(6, t.detail - 4));
    fin.translate(side * 0.480, 0, 0);
    p.flat(fin, 'carbon');
  }

  // --- Airbox and roll hoop -----------------------------------------------
  // BEHIND the driver's head, not on top of it. Put the front of the airbox at
  // the driver's z and the roll hoop eats him, which is precisely what the first
  // attempt did — the cockpit looked empty because the head was inside a duct.
  //
  // The FRONT LIP is not a free parameter either, and this is why it moved 80mm
  // back and 24mm down. The onboard camera sits above and behind the helmet, and
  // the only thing between it and the helmet is this lip. Everything below the
  // ray from the eye across that lip is airbox front face, so the lip alone
  // decides whether the driver's head is in the shot: with the crown at y=0.828
  // and z=0, a lip at (-0.22, 0.930) hides the helmet from ANY eye behind it
  // until the sightline is 24.9 degrees down, which is past the bottom of a
  // frame whose horizon sits where the reference frames put it. No camera
  // position fixes that — the lip has to come back and down, which is also where
  // a real roll hoop is relative to a real driver's head. At (-0.30, 0.880) the
  // helmet clears the lip by 91mm, the crown reads at four-fifths of frame
  // height exactly as it does in the Monoposto onboards, and the front face
  // itself is down to the bottom seven per cent of the frame instead of a slab
  // across the bottom fifth of it. The mouth sitting a little below the crown
  // of the hump behind it is what the photographs show anyway.
  //
  // The crown of the hump moves back with it, so the silhouette from outside is
  // the same airbox it was: it now peaks a little behind the mouth, which is
  // what the photographs show anyway.
  //
  // IT WAS A BOX, AND A SMALL ONE. "There is no airbox — above the driver's
  // head there is a small blade where a real car has a large roll hoop with the
  // engine air intake." That is exactly what the old stations built: 240mm
  // across at the front, square-shouldered at `round` 0.36, crowning at 0.926
  // and falling away immediately into a wedge. Rendered, it read as a cardboard
  // carton stood behind the helmet with a black rectangle glued to its face.
  //
  // WHAT A REAL ONE IS. The roll structure is a mandated single hoop that must
  // stand above the driver's helmet and take the car's weight inverted, so it
  // is a substantial, deep, rounded blade — not a fin. The airbox is the intake
  // wrapped round it: a mouth in its leading face feeding the plenum, and the
  // engine cover flowing back and down from its crown to the rear crash
  // structure. Three numbers set the whole silhouette:
  //
  //   - The CROWN, 0.992 above the road. This is not a stylistic choice: the
  //     regulations cap bodywork at Z = 970 above the reference plane and
  //     REQUIRE roll structure to exist at Z = 968, and with the reference
  //     plane 35mm off the road that is y = 1.003. Every car is built to it.
  //     The widely-quoted "950mm overall height" is a legacy figure; the
  //     current rule and the teams' own 2026 specification sheets both say 970.
  //     It is 164mm above the top of the helmet at 0.828, and the rules
  //     separately require the helmet to sit at least 75mm below the crown.
  //   - The MOUTH, roughly 210mm across by 175mm tall, its lower lip about
  //     170mm above the helmet's chin line. Airbox mouths are smaller than
  //     people remember — this is a naturally aspirated-looking opening on a
  //     turbo car and it is meant to look slightly mean.
  //   - The SECTION, round. `round` runs 0.62 at the front and climbs to 0.95
  //     down the cover, so the hoop is a dome in front view rather than a
  //     shoulder, which is the single change that stops it reading as a box.
  //
  // The cover behind it is now a genuine falling curve rather than a straight
  // taper: it holds its height to z = -0.9 the way a car with an engine under
  // it has to, then drops hard over the gearbox.
  //
  // THE FRONT LIP STAYS AT z = -0.30, and that is a hard constraint rather than
  // a shape decision — it is the onboard camera's sightline over the driver's
  // helmet. Everything below the ray from the eye across this lip is airbox
  // front face, so bringing it forward puts a wall across the bottom of the
  // onboard frame and takes the helmet out of shot. Raising the crown does not
  // affect that; moving the lip does. It was briefly at -0.255 and this is the
  // note that put it back.
  p.painted(big([
    // A small, low forward fairing so the hoop GROWS out of the deck behind the
    // headrest instead of starting as a wall. Without these two stations the
    // loft's first ring is a flat 240 x 360mm cap, and painted with the dark
    // mouth band over it that cap is the black carton the airbox was reported
    // as. The mouth proper begins at the third station.
    section(-0.196, 0.058, 0.586, 0.700, 0.90),
    section(-0.248, 0.092, 0.572, 0.822, 0.76),
    section(-0.300, 0.120, 0.560, 0.912, 0.62),
    section(-0.380, 0.150, 0.556, 0.968, 0.70),
    section(-0.500, 0.168, 0.552, 0.992, 0.74),
    section(-0.700, 0.170, 0.548, 0.972, 0.80),
    section(-0.960, 0.156, 0.552, 0.906, 0.86),
    section(-1.240, 0.126, 0.556, 0.816, 0.90),
    section(-1.520, 0.090, 0.548, 0.710, 0.95),
    section(-1.760, 0.056, 0.520, 0.616, 1.00),
  ], t.body - 6), 'airbox');

  // The intake. A recessed dark throat behind a lip, not a black rectangle
  // stuck on the front: the mouth's first station sits slightly PROUD of the
  // airbox skin so the lip catches light all the way round the opening, and the
  // two behind it fall away and shrink, so from anywhere off-axis you see into
  // a duct that gets darker rather than at a flat panel.
  p.flat(small([
    section(-0.292, 0.100, 0.716, 0.892, 0.72),
    section(-0.340, 0.092, 0.728, 0.882, 0.78),
    section(-0.460, 0.070, 0.744, 0.858, 0.88),
    section(-0.590, 0.046, 0.762, 0.832, 1.00),
  ], t.body - 8), 'dark');

  // The two secondary inlets either side of the main mouth, feeding the
  // radiators and the gearbox oil cooler. Small, dark, and on every current
  // car; without them the hoop is a single hole in a smooth dome and reads as
  // moulded rather than as engineered.
  for (const side of [-1, 1] as const) {
    p.flat(small([
      section(-0.306, 0.030, 0.648, 0.716, 0.55, { xc: side * 0.126 }),
      section(-0.380, 0.026, 0.656, 0.710, 0.65, { xc: side * 0.130 }),
      section(-0.470, 0.018, 0.666, 0.698, 0.85, { xc: side * 0.132 }),
    ], Math.max(6, t.detail - 6)), 'dark');
  }

  // Camera pod on top of the roll hoop. Small, and on every current car, and
  // its silhouette against the sky is one of the things the eye checks for.
  //
  // Into `onboardHidden`, not `core`: this pod is the onboard camera, and the
  // onboard camera cannot see itself. See `Parts.onboardHidden`.
  {
    p.intoOnboardHidden();
    // It sits ON the crown, so its stations move with the crown: the airbox now
    // peaks at 0.948 rather than 0.926, and left where it was the pod would be
    // half-buried in the hoop it is supposed to be bolted to.
    const pod = small([
      section(-0.36, 0.030, 0.980, 1.032, 0.85),
      section(-0.50, 0.034, 0.992, 1.052, 0.80),
      section(-0.64, 0.026, 0.960, 1.004, 0.90),
    ], Math.max(6, t.detail - 4));
    p.flat(pod, 'trim');
    p.into('core');
  }

  // --- Shark fin ----------------------------------------------------------
  // Carbon, not the accent colour. A metre-long coloured blade down the spine
  // is the loudest thing on the car from three-quarters, and it is not what the
  // reference shows: the fin there is the same near-black as the engine cover
  // with the livery running over it.
  // Restationed onto the taller engine cover: the fin has to LEAVE the cover's
  // upper surface, and with the crown raised to 0.948 the old stations started
  // 70mm inside it.
  // 25mm across, not 26: the regulations cap the fin at 50mm of total
  // thickness, and it is one of the parts where being fat is instantly wrong.
  p.flat(small([
    section(-1.40, 0.0125, 0.640, 0.780, 0.30),
    section(-1.74, 0.0120, 0.520, 0.716, 0.30),
    section(-2.00, 0.0115, 0.420, 0.678, 0.30),
    section(-2.20, 0.0110, 0.344, 0.636, 0.30),
  ], t.detail), 'carbon');

  // --- Rear wing ----------------------------------------------------------
  {
    p.into('rearWing');
    // Carbon, for the same reason the front wing is: the rear wing is the one
    // part of the car seen edge-on from the chase camera for the whole race, and
    // a body-coloured slab up there is what made the old car look like a
    // die-cast model. Colour goes on the endplates' outer faces instead, which
    // is where a real car carries its sponsor panel.
    //
    // THE MAIN PLANE WAS A SLAB. 250mm of chord at 42mm of thickness is a
    // 17-per-cent section, which is a wing; the problem was that it was the
    // ONLY thing up there. A 2022 rear wing is two elements — a main plane and
    // a single upper flap — separated by a slot you can see daylight through,
    // and that slot is most of what makes it read as a wing rather than as a
    // shelf. The flap is built separately, on the DRS pivot; see `geometryFor`.
    //
    // The plane also sits 30mm lower and carries less incidence than it did,
    // because with a flap above it the pair has to fit under the same height
    // limit the single slab was using all by itself.
    const main = wingElement(REAR_WING_HALF_SPAN * 2, 0.235, 0.036, -0.044, t.wing);
    main.rotateX(0.155);
    main.translate(0, REAR_WING_Y, REAR_WING_Z);
    p.flat(main, 'carbon');

    // Endplates.
    //
    // THEY WERE BILLBOARDS. The old stations ran from y 0.628 to 1.022 over a
    // 440mm chord with a `round` of 0.20 — a flat rectangular board a third of
    // a square metre in area, standing above the rear tyre. From the side it
    // filled the frame and hid the wing it was holding; from behind it was the
    // largest object on the car. That shape is a 2010 endplate, and even then
    // it was not square.
    //
    // A current one is much smaller and quite specifically shaped: it starts
    // low and short at the front, sweeps UP to meet the wing, and its top edge
    // ROLLS INBOARD over the last part of its length — the rolled tip is the
    // single detail that dates a rear wing to this generation. Below the wing
    // it necks in hard to a narrow foot on the beam wing. So the outline is a
    // tall thin comma, not a rectangle, and it is 40 per cent of the area.
    //
    // AND IT DID NOT REACH THE BEAM WING. Appendix 1 puts the endplate BODY
    // between Z = 325 and Z = 660 — y 0.360 to 0.695 here — and the rolled TIP
    // above it from 0.695 to 0.945. So a real endplate runs all the way down
    // past the beam wing to the height of the diffuser exit, alongside the rear
    // tyre; ours started at 0.628, which is above the beam wing entirely, and
    // left the whole lower half of the rear end open. Closing that gap is what
    // makes the back of the car read as one assembly instead of a wing floating
    // over a floor.
    for (const side of [-1, 1] as const) {
      const s = side;
      const xc = s * (REAR_WING_HALF_SPAN + 0.016);
      const ep = small([
        // Forward foot: low and short, ahead of and under the plane, level with
        // the beam wing it braces against.
        section(-1.88, 0.012, 0.372, 0.700, 0.30, { xc }),
        section(-2.00, 0.015, 0.366, 0.842, 0.22, { xc }),
        // Full height, where the main plane attaches.
        section(-2.12, 0.016, 0.362, REAR_WING_TOP_Y, 0.20, { xc }),
        // The rolled tip: over the last 150mm the top edge turns inboard, the
        // plate's centreline pulls in with it and the section rounds off. This
        // is RV-RW-TIP, and it is the single most recognisable piece of 2022
        // bodywork after the wheel covers.
        section(-2.24, 0.015, 0.368, REAR_WING_TOP_Y, 0.36, { xc: xc - s * 0.020 }),
        section(-2.34, 0.013, 0.392, REAR_WING_TOP_Y - 0.014, 0.60, { xc: xc - s * 0.048 }),
        section(-2.42, 0.010, 0.436, REAR_WING_TOP_Y - 0.042, 0.88, { xc: xc - s * 0.082 }),
      ], t.body - 8);
      // Carbon, like the plane it holds. In the accent colour these were two
      // half-metre coloured boards standing above the rear tyres, and from
      // behind — which is where this car is seen from for most of a race — they
      // were the biggest and brightest object in the frame.
      p.flat(ep, 'carbon');

      // The DRS actuator pod: the small fairing on the inboard face of the
      // endplate that houses the hydraulic ram. It is on every current car and
      // it is the thing that makes the flap above it read as a moving part
      // rather than as a second fixed wing.
      p.flat(small([
        section(-2.06, 0.019, 0.884, 0.926, 0.75, { xc: s * 0.442 }),
        section(-2.14, 0.023, 0.878, 0.932, 0.80, { xc: s * 0.442 }),
        section(-2.22, 0.017, 0.886, 0.922, 0.90, { xc: s * 0.442 }),
      ], Math.max(6, t.detail - 6)), 'trim');
    }

    // Swan-neck pylons: a PAIR, mounted on top of the main plane the way every
    // current car's are. One central pylon was the old arrangement and it reads
    // as a single stalk holding a shelf.
    // Restationed onto the main plane's new height: its underside is at 0.808
    // at z = -2.06, and the pylons used to climb to 0.898, which put their tops
    // 90mm THROUGH the wing they are holding up.
    // Restationed onto the main plane's new height. 25mm thick in x, which is
    // the regulation maximum for a pylon outside the exhaust volume.
    for (const side of [-1, 1] as const) {
      p.flat(small([
        section(-1.82, 0.024, 0.400, 0.474, 0.35, { xc: side * 0.146 }),
        section(-1.96, 0.022, 0.552, 0.630, 0.35, { xc: side * 0.146 }),
        section(-2.07, 0.019, 0.700, 0.780, 0.35, { xc: side * 0.146 }),
      ], t.detail), 'carbon');
    }

    // Beam wing, two elements, bridging the crash structure to the endplates.
    // It sits in the gap between the diffuser exit and the main plane, and its
    // job in the silhouette is to close that gap — a rear end with nothing
    // between the floor and the wing is a 2019 car. The regulation volume is
    // XR 270..550 by Z 325..500, which is z -2.07..-2.35 and y 0.360..0.535.
    const beamA = wingElement(0.94, 0.148, 0.028, -0.026, Math.max(5, t.wing - 3));
    beamA.rotateX(0.12);
    beamA.translate(0, 0.398, -2.16);
    p.flat(beamA, 'carbon');
    const beamB = wingElement(0.92, 0.122, 0.024, -0.022, Math.max(5, t.wing - 3));
    beamB.rotateX(0.16);
    beamB.translate(0, 0.492, -2.19);
    p.flat(beamB, 'carbon');

    // Rain light. Mounted on the crash structure rather than on the wing, so it
    // stays with the car when the wing goes — which is how a real one is, and it
    // means a wrecked car still shows a light in the spray.
    // Its height is regulated: the lens centre must sit between Z = 295 and
    // Z = 305 above the reference plane, which is y 0.330 to 0.340 here.
    p.into('core');
    const light = roundedBar(0.072, 0.100, 0.030, 0.012, t);
    light.translate(0, 0.335, -2.300);
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
  // That fix was aimed at the wrong problem, and the photographs say so.
  //
  // Raising the crown to 0.882 and pushing the rails out to 0.398 did get the
  // arc off the sightline, but it did it by standing the hoop off the car — and
  // that is precisely what the user objected to next: "notice how it's thicker
  // slightly but also fits into the car and is not outwards". Against the
  // reference photographs of the real part, three things were wrong:
  //
  //  - SECTION. A real halo is a flattened aerofoil lying on its side,
  //    appreciably wider than it is tall. Built as a round tube it has to carry
  //    its structural depth in both axes, so it is a pipe standing off the
  //    bodywork instead of a blade let into it.
  //  - LINE. The rails follow the cockpit coaming closely, rising gently from
  //    mounts on the TUB SIDES at about shoulder height. Ours climbed to 0.818
  //    at mid-length — 240mm clear of a coaming at 0.578 — and bowed outboard
  //    past the widest part of the tub, which is the shape of a roll bar bolted
  //    over a car rather than of a survival cell's own structure.
  //  - CROWN HEIGHT. Level with the top of the helmet, not 54mm above it.
  //
  // The rails now run from the tub sides at 0.612, hug the coaming through the
  // middle, and crown at 0.812 — a touch below the helmet's 0.828 — and the
  // section is squashed to 0.58 of its height, so the 42mm at the mounts is
  // 42 wide by 24 tall and the crown is 26 by 15.
  {
    p.flat(tube(
      HALO_PATH, HALO_R, t.halo, t.haloRadial, haloRadiusAt,
      // Wider than tall, which is the whole difference between a blade and a pipe.
      HALO_SQUASH,
    ), 'trim');

    // The forward strut: the only part of the halo a driver looks straight down.
    //
    // "That slit down the middle is exceptionally thin so that it is easy for
    // the drivers to see." It is, and it is the fourth time this has been
    // raised. A 20mm blade was already the real article's width and still read
    // as a bar, so this goes narrower than the real part rather than wider:
    // 12mm across and 46mm front to back, which at the 0.7m it passes an eye is
    // one degree. Everything structural about the section is in the depth,
    // where nobody is looking down it.
    p.flat(strut(
      HALO_PILLAR[0][0], HALO_PILLAR[0][1], HALO_PILLAR[0][2],
      HALO_PILLAR[1][0], HALO_PILLAR[1][1], HALO_PILLAR[1][2],
      HALO_PILLAR_R, t.haloRadial, false, HALO_PILLAR_SQUASH,
    ), 'trim');
  }

  // --- Sidepod winglet and cooling louvres ---------------------------------
  // The little horizontal wing above the inlet, and the row of slats over the
  // radiator exit. Both are on every current car, and a sidepod without either
  // is a featureless blue blade from every angle.
  for (const side of [-1, 1] as const) {
    // Both are bolted to the pod, so they leave with it.
    p.into(side < 0 ? 'sidepodL' : 'sidepodR');
    // Restationed onto the taller pod: the shoulder it stands on moved up by
    // 64mm and out by 36mm, and left where it was the winglet floated beside
    // the pod rather than sitting on it.
    const winglet = wingElement(0.250, 0.160, 0.018, -0.016, Math.max(4, t.wing - 5));
    winglet.rotateX(0.14);
    winglet.translate(side * 0.654, 0.584, 0.600);
    p.flat(winglet, 'carbon');

    // Cooling louvres over the radiator exit. Their x now follows the pod's own
    // centreline as it necks in, so they stay ON the ramp instead of hanging in
    // the air beside it. Appendix 1 puts the legal louvre zone on the engine
    // cover shoulders between Z = 400 and Z = 700, which is y 0.435 to 0.735;
    // these sit on the pod's ramp just under it.
    for (const [z, x, y] of [
      [-0.42, 0.492, 0.462], [-0.62, 0.470, 0.430], [-0.82, 0.446, 0.396],
      [-1.02, 0.420, 0.362],
    ] as const) {
      const slat = roundedBar(0.210, 0.009, 0.034, 0.004, t);
      slat.rotateX(0.30);
      slat.translate(side * x, y, z);
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
  //
  // Rebuilt from the mechanism outward, because what was here was a scatter of
  // eleven round bars per corner at angles that did not describe a linkage. The
  // rules it now follows, each of which was being broken:
  //
  //  1. A WISHBONE IS A TRIANGLE IN PLAN. Two legs, widely separated at the
  //     chassis, converging on ONE outboard ball joint. If the two legs do not
  //     meet at a single point the corner reads as four independent rods, and
  //     ours had the upper pair meeting 10mm apart and the lower pair 14mm
  //     apart — enough to see, and enough to lose the triangle.
  //
  //  2. EVERY MEMBER IS AN AEROFOIL BLADE, not a rod. 70mm of chord and 18mm of
  //     thickness on a wishbone leg; a little less on the trackrod and the
  //     pushrod. See `aeroStrut`. Round 42mm bars are what "a scatter of black
  //     rods" was describing, and no amount of repositioning fixes it.
  //
  //  3. THE FRONT UPPER WISHBONE SLOPES DOWN TOWARD THE WHEEL. Its chassis
  //     pickups sit high on the survival cell — that is the anti-dive geometry
  //     every current car runs, and in the reference frames the upper arm is
  //     unmistakably the higher of the two AT THE CHASSIS and drops across the
  //     span. Ours rose 70mm outboard, which is the opposite, and it is why the
  //     front of the car looked like it was kneeling.
  //
  //  4. NOTHING PASSES THROUGH BODYWORK. Every inboard pickup below is placed
  //     on or just outside the tub's own skin at that station; the survival
  //     cell is 208mm of half width at z = 1.50 and 150mm at z = 1.98, and the
  //     old front pickups at 156-172mm were inside it for part of their span.
  //
  //  5. TRAVEL IS TINY. Nothing here moves at all under normal running, and
  //     that is correct: an F1 car has 20-25mm of wheel travel, which at this
  //     scale is a third of a tyre's sidewall. A suspension that visibly works
  //     is a suspension that is wrong. Only a BROKEN corner moves, and the
  //     renderer does that by folding the whole steer group.
  //
  // WHAT MOVES WITH STEERING, AND WHAT DOES NOT. The outboard ball joints of
  // both front wishbones define the steering axis, so they are the two points
  // on the corner that do not move when the wheel is turned — which is why the
  // wishbones stay here, on the chassis, while the upright, the brake duct and
  // the steering arm hanging off them go into `frontUprightGeometry` and turn
  // with the wheel.
  {
    const fz = FRONT_AXLE_Z;
    const rz = REAR_AXLE_Z;
    const sg = t.strut;
    /**
     * Wishbone leg section: chord fore-aft, thickness vertical.
     *
     * 92mm by 28mm, which is a 3.3:1 lens. The regulations cap the fairing
     * chord at 100mm and the aspect ratio at 3.5:1, so the MINIMUM legal
     * thickness at full chord is 28.6mm — these are deliberately FAT, blunt
     * sections, not the thin aerofoils a modeller's instinct reaches for, and
     * the bluntness is a large part of why a real front suspension photographs
     * as substantial rather than spindly.
     */
    const LEG_C = 0.092, LEG_T = 0.028;
    /** Trackrod and the push/pull rods: shorter chord, near-round. */
    const ROD_C = 0.058, ROD_T = 0.028;

    for (const s of [-1, 1] as const) {
      // --- Front corner ----------------------------------------------------
      //
      // THE BALL JOINTS ARE MUCH HIGHER THAN THEY LOOK. This is the detail
      // almost every model of a current car gets wrong, and the previous
      // version here got it wrong by 130mm.
      //
      // Article 10.3.4 requires every outboard suspension point to be above
      // ZW = -40, that is NO MORE THAN 40mm BELOW THE WHEEL CENTRE, and inside
      // the brake drum. Article 3.13.2 then permits the front drum to be cut
      // for the upright only between ZW = 155 and ZW = 230. So the lower
      // wishbone meets the upright essentially AT HUB HEIGHT and the upper one
      // about 190mm above it: the kingpin span is barely 230mm, and both arms
      // live in the upper half of the wheel.
      //
      // Drawn the intuitive way — lower arm down by the rim's bottom edge,
      // upper arm level with the top of the tub — the front of the car gets a
      // tall splayed A of members across the whole face of the wheel, which is
      // a 1990s car. Drawn correctly the two arms are close together, high, and
      // nearly parallel, and the wheel hangs off the top of them.
      //
      // Wheel centre is at y = TYRE_R = 0.360, so: upper at +0.190, lower at
      // -0.035.
      const fUpX = s * 0.734, fUpY = 0.550;
      const fLoX = s * 0.752, fLoY = 0.325;
      // A little kingpin inclination: the upper ball joint is 18mm INBOARD of
      // the lower one, which is what tips the wheel's steering axis and is
      // clearly visible head-on in the reference.

      // Upper wishbone, from high on the survival cell — the inboard pickups
      // sit at Z 500-555, y 0.535-0.590 here.
      //
      // ANTI-DIVE. The FRONT leg's chassis pickup is 46mm HIGHER than the rear
      // leg's, so in side view the arm rakes nose-up going rearward. Every
      // current car runs it and it is the defining look of the era; Mercedes
      // published a 30mm move of exactly this pickup as their 2024 anti-dive
      // change. Ours had no rake at all.
      p.flat(aeroStrut(s * 0.216, 0.578, fz + 0.40, fUpX, fUpY, fz + 0.012, LEG_C, LEG_T, sg), 'trim');
      p.flat(aeroStrut(s * 0.196, 0.532, fz - 0.30, fUpX, fUpY, fz + 0.012, LEG_C, LEG_T, sg), 'trim');
      // Lower wishbone. Inboard pickups at the regulation floor of Z = 250,
      // y 0.285-0.302 here, rising slightly to the hub.
      p.flat(aeroStrut(s * 0.230, 0.302, fz + 0.38, fLoX, fLoY, fz + 0.008, LEG_C, LEG_T, sg), 'trim');
      p.flat(aeroStrut(s * 0.214, 0.286, fz - 0.32, fLoX, fLoY, fz + 0.008, LEG_C, LEG_T, sg), 'trim');

      // Trackrod, from the steering rack out to a ball joint ON the steering
      // axis, mid-way between the two wishbones.
      //
      // AN HONEST NOTE ABOUT WHAT THIS DOES AND DOES NOT MODEL. On the real car
      // the rod's outboard ball is on the steering ARM, offset behind the axis,
      // so it sweeps through an arc and the rod swings a few degrees about its
      // inboard pickup. Reproducing that needs the rod on a pivot of its own,
      // driven from the steer angle — two more objects and TWO MORE DRAW CALLS
      // PER CAR, forty across a full grid, on a renderer that is already short
      // of them. So the kinematics are inverted instead: the rod ends on the
      // axis, where nothing moves, and the steering ARM — which is on the steer
      // group — sweeps from that ball back to the upright. What you see from
      // outside is a rod running to a joint by the wheel and a short arm
      // articulating behind it, which is what a working linkage looks like; it
      // is exact at straight-ahead and the error at full 24-degree lock is the
      // arm's own swing, about 40mm, on a part 110mm long.
      //
      // At the LOWER WISHBONE'S HEIGHT, which is where the reference cars carry
      // it: with both ball joints now high, the trackrod sits just under the
      // lower arm and runs nearly horizontally out of the rack at the front
      // bulkhead. It used to sit half way up the kingpin, which was a
      // consequence of the kingpin being drawn far too tall.
      p.flat(aeroStrut(s * 0.190, 0.312, fz - 0.30, s * 0.744, 0.334, fz - 0.070, ROD_C, ROD_T, sg), 'trim');
      // Pushrod: from the lower wishbone's outboard end up and inboard to the
      // rocker inside the tub, at about 35 degrees — steeply raked, which is
      // what identifies it as a PUSHrod rather than a pullrod.
      p.flat(aeroStrut(s * 0.716, 0.318, fz + 0.020, s * 0.206, 0.556, fz - 0.276, ROD_C, ROD_T, sg), 'trim');

      // --- Rear corner -----------------------------------------------------
      const rUpX = s * 0.700, rUpY = 0.512;
      const rLoX = s * 0.716, rLoY = 0.318;
      // Upper wishbone, off the gearbox casing. DEEP-CHORDED, because between
      // 2022 and 2025 the regulations let a rear fairing that also shrouds the
      // driveshaft run to 150mm of chord instead of 100 — which is exactly why
      // the rear upper wishbones on cars of this era look so enormous next to
      // the front ones. This is the one member on the car allowed to be fat.
      p.flat(aeroStrut(s * 0.176, 0.522, rz + 0.40, rUpX, rUpY, rz - 0.008, 0.140, 0.042, sg), 'trim');
      p.flat(aeroStrut(s * 0.150, 0.500, rz - 0.32, rUpX, rUpY, rz - 0.008, 0.140, 0.042, sg), 'trim');
      // Lower wishbone.
      p.flat(aeroStrut(s * 0.192, 0.292, rz + 0.38, rLoX, rLoY, rz - 0.006, LEG_C, LEG_T, sg), 'trim');
      p.flat(aeroStrut(s * 0.164, 0.284, rz - 0.34, rLoX, rLoY, rz - 0.006, LEG_C, LEG_T, sg), 'trim');
      // Toe link: the rear's equivalent of a trackrod, behind the axle line.
      p.flat(aeroStrut(s * 0.158, 0.386, rz - 0.34, s * 0.700, 0.404, rz - 0.116, ROD_C, ROD_T, sg), 'trim');
      // PULLROD, not a pushrod: it runs from HIGH on the upright DOWN and
      // inboard to a rocker at the bottom of the gearbox. Pushrod front and
      // pullrod rear is what most of the current field runs, and the two being
      // raked opposite ways is one of the details that reads as a real car.
      // Shallower than the front rod — 25 degrees against 35 — which is also
      // what the reference shows.
      p.flat(aeroStrut(s * 0.686, 0.492, rz + 0.030, s * 0.170, 0.238, rz - 0.240, ROD_C, ROD_T, sg), 'trim');

      // Driveshaft: round, because it genuinely is — it is a shaft, the one
      // member on the car that turns. Steel, hollow, at wheel-centre height
      // between the gearbox output and the hub.
      p.flat(strut(s * 0.128, 0.360, rz, s * 0.640, 0.360, rz, 0.026, sg), 'carbon');
      // The rear upright, bridging the two ball joints.
      p.flat(aeroStrut(rLoX - s * 0.010, rLoY, rz - 0.004, rUpX, rUpY, rz - 0.006, 0.092, 0.052, sg), 'carbon');
      // Rear brake duct: the carbon drum inboard of the wheel, over the disc.
      const duct = small([
        section(rz + 0.28, 0.030, 0.196, 0.404, 0.34),
        section(rz + 0.02, 0.046, 0.166, 0.492, 0.26),
        section(rz - 0.26, 0.034, 0.188, 0.418, 0.34),
      ], Math.max(6, t.detail - 4));
      duct.translate(s * (REAR_HUB_X - 0.176), 0, 0);
      p.flat(duct, 'carbon');
    }
  }

  // --- Driver and cockpit -------------------------------------------------
  // Already tagged with their own swatches by DriverMesh.
  p.core.push(...driverBody);

  return p;
}

/**
 * The parts of a front corner that TURN WITH THE WHEEL, in hub-local space.
 *
 * On a real car the upright, the brake duct bolted to it, the caliper and the
 * steering arm all rotate about the steering axis together with the wheel;
 * only the inboard ends of the wishbones stay put. The old car had every one
 * of those merged into the static shell, so at lock the wheel rotated on its
 * own inside a cage that stayed square to the chassis — the duct in particular
 * visibly separated from the tyre it is supposed to be feeding.
 *
 * WHY THE WISHBONES ARE NOT HERE. Their outboard ball joints are what defines
 * the steering axis, so they are exactly the points that do not move. Leaving
 * them merged into the shell is not an approximation, it is the mechanism.
 *
 * COST. Two extra meshes per car, both drawn with the shell material and both
 * sharing one geometry across the whole field, so it is two draw calls and no
 * additional memory. Only the fronts get it; the rears do not steer.
 *
 * The geometry is authored with the wheel centre at the origin and the car's
 * own +x to the right, so it is built once per SIDE rather than once and
 * mirrored: the track rod is behind the axle on both corners of a real car, and
 * a half-turn about Y — the trick the wheel itself can use, being a solid of
 * revolution — would swing the left-hand steering arm round to the front.
 * Building from signed coordinates keeps the winding correct without a negative
 * scale, which three.js would render inside out.
 */
function frontUprightGeometry(t: Tiers, side: 1 | -1): THREE.BufferGeometry {
  const s = side;
  const parts: THREE.BufferGeometry[] = [];
  const flat = (geo: THREE.BufferGeometry, swatch: SwatchName) => {
    const [u, v] = swatchUV(swatch);
    parts.push(setFlatUV(geo, u, v));
  };

  // The upright itself: a carbon column between the two ball joints.
  //
  // The two ends have to land exactly on the points the wishbones converge on,
  // or the corner comes apart. In car space those are (0.734, 0.550) and
  // (0.752, 0.325) at the front axle; the wheel centre this geometry is
  // authored about is at (0.800, 0.360), so in hub-local coordinates they are
  // (-0.066, +0.190) and (-0.048, -0.035). Getting these wrong is invisible in
  // the source and glaring on screen, because the ball joints are the one place
  // on the car where five separate parts are supposed to meet at a point.
  //
  // 190mm above the hub and 35mm below it: those are the regulation limits, not
  // a judgement. See the note on the front corner in `buildShellParts`.
  flat(aeroStrut(s * -0.066, 0.190, 0, s * -0.048, -0.035, 0, 0.086, 0.048, t.strut), 'carbon');
  // Steering arm: the short lever between the trackrod's ball joint and the
  // upright. This is the part that makes the linkage read as a linkage, because
  // it is the one member that visibly swings through an arc as the wheel turns.
  // Its inboard end sits on the steering axis — see the note on the trackrod in
  // `buildShellParts` for why that way round.
  flat(aeroStrut(s * -0.056, -0.026, -0.070, s * -0.050, -0.030, -0.174, 0.040, 0.024, t.strut), 'trim');

  // THE OVER-WHEEL WINGLET, which was missing entirely.
  //
  // A small curved fin standing above each front tyre, part of the mandated
  // wheel-body assembly introduced with the 2022 rules and bolted to the drum,
  // so it turns with the steering and does not spin. Nothing else on the car
  // occupies that piece of sky, and its absence is one of the quiet reasons a
  // model reads as pre-2022 even when everything else is right: from any
  // three-quarter view the top of a current front wheel has a blade over it.
  //
  // Built as three sections arcing over the tyre's crown at 0.360 — it sits
  // 55mm clear of the rubber, and is deliberately narrow so it never fights
  // the wheel for attention.
  {
    const wing = loft([
      section(0.150, 0.052, 0.402, 0.418, 0.60, { xc: s * -0.052 }),
      section(0.010, 0.062, 0.414, 0.432, 0.55, { xc: s * -0.060 }),
      section(-0.150, 0.050, 0.400, 0.416, 0.60, { xc: s * -0.066 }),
    ], Math.max(6, t.detail - 6), true, t.detailStep);
    flat(wing, 'carbon');
  }
  // Brake duct: the carbon drum inboard of the wheel. Turns with the wheel,
  // because it is bolted to the upright. Deeper and taller than it was, so it
  // actually shrouds the disc now that the disc can be seen.
  const duct = loft([
    section(0.30, 0.030, -0.192, 0.048, 0.32, { xc: s * -0.146 }),
    section(0.02, 0.046, -0.226, 0.126, 0.24, { xc: s * -0.146 }),
    section(-0.26, 0.034, -0.204, 0.066, 0.32, { xc: s * -0.146 }),
  ], Math.max(6, t.detail - 4), true, t.detailStep);
  flat(duct, 'carbon');

  return mergeParts(parts);
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
      // u runs the OPPOSITE way round the tyre to the vertex order, for exactly
      // the reason `loft` does the same thing: it is what makes the (u, v) frame
      // right-handed against the outward normal. Running it with the vertex
      // order put every letter on both sidewalls of all four wheels back to
      // front — "OЯITOTOЯP" — which is legible enough in a screenshot to be
      // embarrassing and invisible enough in motion to survive a long time.
      uvs[uo] = 1 - i / radial;
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

  // --- Brake disc and caliper ---------------------------------------------
  //
  // A 2022-onward car carries a MANDATED AERODYNAMIC COVER over the outboard
  // face of every wheel, and that cover is opaque: from outside the car you
  // cannot see the brake at all, and any model that shows one through the
  // outboard face has drawn a pre-2022 wheel. What you CAN see, and what every
  // reference frame shows clearly, is the INBOARD side — the carbon duct drum,
  // the disc glowing inside it, and the caliper straddling the top of it. That
  // is also the side the chase camera and the cockpit camera look at all race.
  //
  // So the brake now lives where it can actually be seen: set INBOARD of the
  // wheel's centreline, inside an inboard rim face that is an open annulus
  // rather than the closed dish it used to be. Previously both faces were shut
  // and a disc, two drilled faces and a caliper — 700-odd triangles a wheel,
  // 2800 a car — were sealed inside a black box where no camera in the game
  // could ever reach them.
  //
  // NOTHING SEES DAYLIGHT THROUGH IT. The annulus stops at `hubR`, and the
  // disc's own faces run from well inside `hubR` out past it, so the hole is
  // covered by solid geometry from every angle. See the note on the closing cap
  // below, which is the belt to that pair of braces: the "wheels are hollow, you
  // can see the track through them" bug came from exactly this kind of opening
  // and is not being re-introduced.
  const discX = -half * 0.34;
  const discR = RIM_R * 0.82;
  /** Where the inboard face stops and the brake shows through. */
  const hubR = RIM_R * 0.56;
  const discSeg = quality === 'high' ? radial : Math.max(10, radial - 2);
  const discBody = new THREE.CylinderGeometry(discR, discR, 0.032, discSeg, 1, true);
  discBody.rotateZ(Math.PI / 2);
  discBody.translate(discX, 0, 0);
  push(discBody, 'disc');

  for (const sx of [-1, 1] as const) {
    // Inner radius well below `hubR`, so the drilled face closes the opening in
    // the rim rather than merely sitting behind it.
    const face = new THREE.RingGeometry(RIM_R * 0.20, discR, discSeg);
    face.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    face.translate(discX + sx * 0.017, 0, 0);
    push(face, 'discFace');
  }
  // The bell: the aluminium hat the carbon disc is bolted to, bridging the disc
  // to the hub. Without it the disc is an annulus floating on nothing, and the
  // gap it leaves is the one place a sightline could still get past.
  push(revolve([
    [0.0, discX + 0.030],
    [RIM_R * 0.20, discX + 0.028],
    [RIM_R * 0.21, discX + 0.006],
    [RIM_R * 0.21, discX - 0.018],
    [RIM_R * 0.20, discX - 0.028],
    [0.0, discX - 0.030],
  ], Math.max(10, discSeg - 8), true), 'hub');

  // Caliper: a body straddling the disc at the top rear of the wheel, in the
  // six-o'clock-to-two-o'clock arc a real one occupies. Built as three pieces
  // rather than one box — two half bodies either side of the disc and a bridge
  // over it — because a single block reads as a brick glued to the wheel and
  // the thing that makes a caliper legible is that the disc passes THROUGH it.
  for (const sx of [-1, 1] as const) {
    const half2 = chamferBox(0.030, 0.128, 0.058, 0.008);
    half2.translate(discX + sx * 0.030, discR * 0.80, -0.028);
    push(half2, 'caliper');
  }
  const bridge = chamferBox(0.070, 0.040, 0.050, 0.008);
  bridge.translate(discX, discR * 0.80 + 0.058, -0.028);
  push(bridge, 'caliper');

  // --- Wheel face ----------------------------------------------------------
  // The AERODYNAMIC WHEEL COVER, which is what a current car actually has and
  // is the single most obvious way this generation's wheel differs from the
  // last one's.
  //
  // What was here was a six-spoke open face in bright machined metal, with the
  // brake disc deliberately visible through the gaps. That is a beautiful
  // object and it is the wrong decade: open wheel faces were outlawed with the
  // move to 18-inch rims, and every reference frame shows instead a nearly
  // closed dark dish with a single bright centre. Six silver spokes are also
  // the brightest thing on an otherwise black corner, so they dominated the
  // wheel at every distance and made the tyre look like a toy hubcap.
  //
  // ONE SURFACE, from the centre of the cap out to the bead. It was four
  // separate primitives, and that is why the wheels were hollow.
  //
  // THE BUG, because it is worth writing down: three.js lays `RingGeometry` and
  // `CircleGeometry` out at (cos t, sin t) and `CylinderGeometry` at
  // (sin t, cos t). Those are a QUARTER TURN apart. The old cover abutted a ring
  // against a cone at exactly `coverR * 0.60`, the cone against a disc at
  // exactly `coverR * 0.17`, and the ring against the flange cone at exactly
  // `coverR` — three joints where two regular polygons of identical radius meet
  // out of phase, so they share no edge anywhere and the seam opens to the
  // polygon's sagitta. That is 1.2mm at the high tier's 32 sides and 8.5mm at
  // the low tier's 12, all the way round, three times over. Through those slots
  // you see the inside of the tyre and, past it, the road — which is exactly
  // what "the wheels seem to be hollow, you can see the track through it"
  // describes. It had been found and patched once before, at one tier, by adding
  // the flange; the flange closed one of the three joints and opened none.
  //
  // Abutting equal radii cannot be made safe by nudging the numbers, because the
  // failure is angular, not radial. So the cover is now generated as a single
  // surface of revolution with ONE vertex ring per station and the SAME angular
  // convention the tyre carcass uses. There are no joints left to open, at any
  // tessellation, and it is also closer to the reference: a real cover is one
  // moulding with a fine circumferential joint, not an assembly of discs.
  //
  // WHAT WAS STILL WRONG. Closing it as one surface fixed the holes and left a
  // FLAT DARK DISC — "the rim is a flat dark disc with no spokes, no aero cover
  // detail". Two stations 1.5mm apart at 78 per cent of the radius is not a
  // feature; it is a hairline nobody sees past two metres. A real cover has
  // real relief: a deep annular gutter around the nut, a raised structural ring
  // outboard of it, a set of shallow radial flutes moulded into the dish, and —
  // the part that actually reads at distance — a genuinely BRIGHT machined
  // flange between the cover's edge and the tyre bead. That flange is a
  // separate swatch now rather than sharing the cover's, which is why the wheel
  // finally has a highlight on it.
  const coverR = Math.min(FACE_R, RIM_R + 0.003);
  const beadX = half * 0.985;
  push(revolve([
    // radius, x. From the lip of the gutter around the nut, out across the
    // dish, to the shoulder where the flange takes over.
    [coverR * 0.17, faceX - 0.038],
    [coverR * 0.21, faceX - 0.030],
    // The gutter floor. 12mm deep rather than 4, so the nut sits in a well and
    // the well casts a shadow across itself — which is the single strongest
    // depth cue on an object that is otherwise a disc.
    [coverR * 0.30, faceX - 0.026],
    [coverR * 0.42, faceX - 0.024],
    // Up onto the dish proper.
    [coverR * 0.52, faceX - 0.014],
    [coverR * 0.64, faceX - 0.007],
    // The raised structural ring: a 3mm step, which is twenty times the old
    // hairline and is what the reference close-up actually shows.
    [coverR * 0.78, faceX - 0.004],
    [coverR * 0.80, faceX + 0.004],
    [coverR * 0.90, faceX + 0.005],
    [coverR * 0.955, faceX + 0.001],
    [coverR, faceX + 0.004],
  ], radial, true), 'rimFace');

  // The machined flange, from the cover's edge out over the rim lip to the
  // bead. Its own surface of revolution and its own swatch — a brushed metal
  // ring against a satin composite dish and black rubber. On the reference car
  // this ring is the brightest thing on the corner and the only part of the
  // wheel that moves a highlight as the car turns; ours had it painted the same
  // dark grey as the cover, which is most of why the wheel read as a hubcap.
  push(revolve([
    [coverR, faceX + 0.004],
    [coverR + 0.004, faceX + 0.010],
    [RIM_R + 0.006, half * 0.93],
    [RIM_R + 0.008, beadX],
  ], radial, true), 'rimLip');

  // NO RADIAL RIBS, AND THE ATTEMPT IS WORTH RECORDING.
  //
  // The obvious answer to "the rim is a flat dark disc with no spokes" is to put
  // some radial relief on it, and two versions of that were tried: eight short
  // bright bars, then ten longer ones in the cover's own colour. Both failed the
  // same way. Any set of radial features on a disc reads as a STAR — the eye
  // groups them into a single rotationally-symmetric graphic and files it as a
  // logo or a spinner, and it does so from further away than the relief itself
  // is visible. The second attempt was less garish than the first and still the
  // most conspicuous thing on the corner.
  //
  // The reference photographs settle it: a current wheel cover is genuinely a
  // near-featureless dark dish. It is a mandated standard part made to fixed
  // FIA geometry — teams may apply a livery to it and nothing else — and what
  // little relief it carries is CONCENTRIC, not radial: the gutter round the
  // nut, one structural step part way out, and the machined flange at the edge.
  // All three are in the profile above. The answer to "no aero cover detail" is
  // those, plus a flange bright enough to hold a highlight; it is not spokes,
  // because the real thing has none.

  // Centre-lock nut, in the gutter. A hexagon, not a smooth cylinder: a real
  // one is driven by a wheel gun and has flats on it, and at the low tier the
  // old twelve-sided cylinder was a visibly faceted circle anyway — so making
  // the facets deliberate costs nothing and stops reading as an artefact.
  const hub = new THREE.CylinderGeometry(coverR * 0.155, coverR * 0.175, 0.026, 6);
  hub.rotateZ(Math.PI / 2);
  hub.translate(faceX - 0.030, 0, 0);
  push(hub, 'hub');
  // The nut's own face, and the bright retaining pin in the middle of it.
  push(revolve([
    [0.0, faceX - 0.045],
    [coverR * 0.045, faceX - 0.046],
    [coverR * 0.060, faceX - 0.043],
    [coverR * 0.150, faceX - 0.043],
  ], Math.max(10, radial - 6), true), 'rimLip');

  // --- Inboard face --------------------------------------------------------
  //
  // OPEN, and that is a deliberate reversal. It used to be a closed dish, on
  // the argument that a closed dish cannot leak daylight — which is true, and
  // also sealed the brake assembly inside a box no camera could see into. On a
  // real car the inboard face of the rim is open and the brake is plainly
  // visible through it; from the chase camera, the cockpit camera and any
  // three-quarter shot, that opening with a disc glowing inside it is what
  // makes the corner read as a racing car's rather than a toy's.
  //
  // The opening stops at `hubR` and the brake's own faces run from 0.20 R —
  // well inside it — out to 0.82 R, so a sightline through the hole always
  // lands on the disc. The closing cap below is the third layer of that
  // argument, and it is there because "you can see the track through the
  // wheels" is a bug this file has already shipped once.
  push(revolve([
    [hubR, -half * 0.62],
    [hubR + 0.010, -half * 0.72],
    [RIM_R * 0.86, -half * 0.90],
    [RIM_R * 0.96, -half * 0.945],
    [RIM_R + 0.020, -half * 0.965],
  ], radial), 'inner');

  // The closing cap: a solid disc across the axis, inboard of the brake, in the
  // same near-black as the duct. Nothing on a real car corresponds to it — the
  // upright and the driveshaft are there instead — and it exists purely so that
  // no ray from any camera can pass through the wheel and out the other side,
  // whatever the tessellation and whatever angle the wheel is at.
  {
    const capIn = new THREE.CircleGeometry(hubR + 0.012, Math.max(10, radial - 6));
    capIn.rotateY(-Math.PI / 2);
    capIn.translate(discX - 0.036, 0, 0);
    push(capIn, 'inner');
  }

  return mergeParts(parts);
}

/**
 * A surface of revolution about the car's X axis, built with the same angular
 * convention as the tyre carcass: vertex i of every ring sits at
 * (sin, cos) of i / radial turns.
 *
 * That last clause is the entire point of this function existing rather than a
 * `LatheGeometry` call. Everything that has to meet the wheel — the tyre, the
 * rim barrel, the compound band — is generated at (sin, cos); three.js's own
 * lathe and ring primitives are at (cos, sin). Mixing the two is what put slots
 * through the wheel face. Anything built here is in phase with all of it by
 * construction.
 *
 * @param profile [radius, x] from the axis outward; a leading radius of 0 makes
 *                a closed cap rather than an open tube
 * @param flip    reverses the winding. The default faces -X (inboard), which is
 *                what the inboard dish wants; the outboard cover passes true.
 *                Getting this backwards costs nothing at build time and produces
 *                a wheel with no face at all, backface-culled into an open
 *                barrel — which looks exactly like the hollow wheel this whole
 *                function exists to fix, so it is worth being explicit about.
 */
function revolve(
  profile: readonly [number, number][],
  radial: number,
  flip = false,
): THREE.BufferGeometry {
  const rings = profile.length;
  const cols = radial + 1;
  const pos = new Float32Array(rings * cols * 3);
  for (let r = 0; r < rings; r++) {
    const [rad, x] = profile[r];
    for (let i = 0; i < cols; i++) {
      const a = (i / radial) * Math.PI * 2;
      const o = (r * cols + i) * 3;
      pos[o] = x;
      pos[o + 1] = Math.sin(a) * rad;
      pos[o + 2] = Math.cos(a) * rad;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * cols;
    const b = (r + 1) * cols;
    for (let i = 0; i < radial; i++) {
      if (flip) {
        idx.push(a + i, b + i + 1, b + i, a + i, a + i + 1, b + i + 1);
      } else {
        idx.push(a + i, b + i, b + i + 1, a + i, b + i + 1, a + i + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
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
  addDetailUV(result);
  result.computeBoundingSphere();
  return result;
}

/**
 * Edge of one tile of the shared surface-detail map, in metres.
 *
 * The map is sixteen carbon tows across, so a 75mm tile makes each tow a little
 * under five millimetres — which is the real thing, and small enough that at any
 * distance past a metre or two it stops being a pattern and becomes the slightly
 * broken specular that separates a moulded composite part from a smooth one.
 * At 100mm the crosshatch was still legible as a crosshatch in a close-up of a
 * painted flank, which is a diorama rather than a car.
 */
const DETAIL_TILE_M = 0.075;

/**
 * Gives a geometry a SECOND UV set, box-projected from object space.
 *
 * The car's first UV set is an atlas: every painted panel occupies a rectangle
 * of it and every flat-coloured part is pinned to a single texel of it. That is
 * exactly what a livery needs and exactly what surface detail cannot use — a
 * wishbone whose entire UV is one point has nowhere to put a weave, and the
 * atlas panels are stretched to fit their rectangles rather than to any
 * consistent physical scale.
 *
 * So detail gets its own parameterisation, derived from the position and the
 * normal: project each vertex onto whichever of the three axis planes its
 * normal faces most directly, and divide by a tile size in METRES. Two
 * consequences, both of them the point:
 *
 *  - the weave is the same physical size everywhere on the car, on a wishbone
 *    and on a floor alike;
 *  - it costs nothing per frame. This runs once, on the shared geometry, for
 *    the whole field.
 *
 * The seams where the dominant axis changes are invisible for a fine, roughly
 * isotropic pattern, which is what this map is and the only kind of map this
 * projection is suitable for.
 */
function addDetailUV(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!pos || !nrm) return;
  const uv = new Float32Array(pos.count * 2);
  const k = 1 / DETAIL_TILE_M;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u: number, v: number;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * k;
    uv[i * 2 + 1] = v * k;
  }
  geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv, 2));
}


interface CachedGeometry {
  /** Everything that stays bolted to the car whatever happens to it. */
  shell: THREE.BufferGeometry;
  /** The four pieces of bodywork an accident can take off. */
  bodyParts: Record<BodyPartId, THREE.BufferGeometry>;
  /**
   * The coarse wheel and gloves plus the roll-hoop camera pod: everything that
   * must not be drawn for the car the onboard camera is inside.
   */
  onboardHidden: THREE.BufferGeometry;
  frontWheel: THREE.BufferGeometry;
  rearWheel: THREE.BufferGeometry;
  /** Upright, steering arm and brake duct — the parts that steer with a wheel. */
  frontUprightL: THREE.BufferGeometry;
  frontUprightR: THREE.BufferGeometry;
  /** Compound bands. Shared like everything else; only the material varies. */
  frontBand: THREE.BufferGeometry;
  rearBand: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
  /** The movable upper front-wing elements, authored about their hinge. */
  frontFlap: THREE.BufferGeometry;
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
  //
  // Spanned to the same half-span as the main plane. The endplates' inboard
  // faces sit just outboard of it, so both elements bury their tips in the
  // plate — a rear wing whose flap stops short of its endplates is one you can
  // see daylight through in exactly the place there should be none.
  const flapGeo = wingElement(REAR_WING_HALF_SPAN * 2, DRS_FLAP_CHORD, 0.032, -0.036, t.wing);
  flapGeo.rotateX(DRS_CLOSED_RAD);
  const [fu, fv] = swatchUV('carbon');
  setFlatUV(flapGeo, fu, fv);
  // The flap is drawn with the shell material, so it needs the second uv set
  // that material's normal map samples through. Without it three.js compiles a
  // program expecting an attribute the geometry does not have.
  flapGeo.computeVertexNormals();
  addDetailUV(flapGeo);

  const shadow = new THREE.PlaneGeometry(1, 1);
  shadow.rotateX(-Math.PI / 2);

  // Built once and split two ways.
  //
  // The HELMET goes into the shell with the rest of the driver, and this is the
  // change that makes the onboard view read as an onboard view. It used to be
  // hidden along with the coarse wheel, because the camera used to be inside it
  // and rendering the inside of a shell is a black screen. The camera is not
  // inside it any more — it is behind and above the crown, where every onboard
  // reference frame puts it — so the helmet is now the single most recognisable
  // thing in the shot rather than something to get out of the way.
  //
  // Only the coarse wheel and gloves are hidden from the inside now, together
  // with the roll-hoop camera pod: see `Parts.onboardHidden`.
  const driver = buildDriverParts(quality);

  const parts = buildShellParts(quality, [...driver.body, ...driver.head]);

  const built: CachedGeometry = {
    shell: mergeParts(parts.core),
    bodyParts: {
      frontWing: mergeParts(parts.frontWing),
      rearWing: mergeParts(parts.rearWing),
      sidepodL: mergeParts(parts.sidepodL),
      sidepodR: mergeParts(parts.sidepodR),
    },
    onboardHidden: mergeParts([...driver.grip, ...parts.onboardHidden]),
    frontWheel: buildWheel(FRONT_TYRE_W, t, quality),
    rearWheel: buildWheel(REAR_TYRE_W, t, quality),
    frontUprightL: frontUprightGeometry(t, -1),
    frontUprightR: frontUprightGeometry(t, 1),
    // Built with the same tyre tessellation as the carcass they sit on, so the
    // 6mm lift still clears it at both tiers.
    frontBand: buildSidewallBands(FRONT_TYRE_W, TYRE_R, RIM_R, t.wheel, t.tyreRings),
    rearBand: buildSidewallBands(REAR_TYRE_W, TYRE_R, RIM_R, t.wheel, t.tyreRings),
    disc: (() => {
      // The glow ring: the rim of the brake disc, lit from within.
      //
      // Slightly LARGER than the carbon disc it wraps (0.82 R) rather than
      // smaller, so it shows as a hot edge round the disc instead of a patch in
      // the middle of it. It used to be 0.168 against a 0.183 disc, which put it
      // entirely behind the disc face — and both were inside a wheel that was
      // closed on both sides, so the whole thing was invisible in every camera
      // this game has. The wheel's inboard face is open now; see `buildWheel`.
      const d = new THREE.CylinderGeometry(RIM_R * 0.845, RIM_R * 0.845, 0.026, quality === 'high' ? 24 : 8, 1, true);
      d.rotateZ(Math.PI / 2);
      return d;
    })(),
    flap: flapGeo,
    frontFlap: mergeParts(parts.frontFlap),
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
  detail: boolean,
): THREE.Material {
  const key = `shell:${colour}:${accent}:${number}:${code}:${size}:${detail ? 'd' : ''}`;
  return material(key, () => {
    const livery = buildLivery({ colour, accent, number, code }, size);
    const mat = new THREE.MeshStandardMaterial({
      map: livery.map,
      roughnessMap: livery.surface,
      metalnessMap: livery.surface,
      roughness: 1,
      metalness: 1,
      // 0.92, not 1.15.
      //
      // This is a multiplier on everything the car takes from the environment
      // probe, and the probe is not a neutral studio: it carries a sun disc at
      // 220x the radiance of its sky specifically so that a gloss panel gets a
      // compact hot highlight (see EnvProbe). Multiplying that by 1.15 on top of
      // a scene exposure of 1.35 put the specular peak on a curved flank a long
      // way past the point ACES can roll off, so it clipped — flat white, no
      // gradient in it, no livery visible through it. Slightly UNDER unity is
      // the honest number anyway: a car is not in an open field, it is
      // surrounded by other cars, barriers and grandstands that occlude a good
      // part of the dome it is being handed.
      //
      // This is a CAR-LOCAL knob, deliberately. The scene's exposure and the
      // bloom threshold belong to the renderer and are somebody else's to tune;
      // what this file is entitled to say is how much of the sky its own paint
      // is allowed to reflect.
      envMapIntensity: 0.92,
    });
    // The carbon weave, through the box-projected second uv set.
    //
    // It is applied to the WHOLE car, painted panels included, and that is not
    // a shortcut. Formula 1 bodywork is paint over laid-up cloth, and in raking
    // light the weave reads straight through the lacquer — it is one of the
    // things that makes a photograph of a real car look like a photograph
    // rather than like a render. What it is really buying is that the specular
    // highlight stops being a clean geometric sweep across a mathematically
    // perfect surface, which is the single strongest tell of a procedural
    // model, and starts breaking up the way a real one does.
    //
    // The amplitude is small on purpose. Cranked up it becomes a pattern, and a
    // visible weave across a whole car is a diorama, not a race car.
    const weave = detail ? carbonWeaveMap() : null;
    if (weave) {
      mat.normalMap = weave;
      // uv1, not uv. See `addDetailUV`.
      mat.normalMap.channel = 1;
      mat.normalScale = new THREE.Vector2(0.24, 0.24);
    }
    return mat;
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

  // The low tier skips the detail normal map entirely: it is an extra sampler
  // and an extra texture fetch per fragment, on the devices that can least
  // afford either, for a surface break-up nobody sees on a phone screen.
  const shellMat = shellMaterial(
    bodyColour, accentColour, opts.number ?? 0, opts.code ?? '', t.texture,
    quality === 'high',
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

  const onboardHidden = new THREE.Mesh(geo.onboardHidden, shellMat);
  onboardHidden.castShadow = true;
  root.add(onboardHidden);

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
    { mesh: onboardHidden, key: 'onboardHidden' },
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
  // Offset so the flap's TRAILING EDGE lands on the pivot. The element is
  // centred by `wingElement`, so after `rotateX(DRS_CLOSED_RAD)` its trailing
  // edge — local (0, 0, -chord/2) — sits at (0, +c/2 sin, -c/2 cos), and this
  // is that vector negated. Hard-coding it as a magic -0.092 in z is what put
  // the hinge at the leading edge and cost the car its DRS slot.
  flap.position.set(
    0,
    -(DRS_FLAP_CHORD * 0.5) * Math.sin(DRS_CLOSED_RAD),
    (DRS_FLAP_CHORD * 0.5) * Math.cos(DRS_CLOSED_RAD),
  );
  flap.castShadow = true;
  flapPivot.add(flap);
  root.add(flapPivot);
  swappable.push({ mesh: flap, key: 'flap' });

  // The two upper front-wing elements, on their X/Z-mode hinge. Same
  // arrangement as the DRS flap: one pivot group, one mesh, and it disappears
  // with the front wing rather than being left hanging in the air.
  const frontFlapPivot = new THREE.Group();
  frontFlapPivot.position.set(0, FRONT_FLAP_PIVOT_Y, FRONT_FLAP_PIVOT_Z);
  const frontFlap = new THREE.Mesh(geo.frontFlap, shellMat);
  frontFlap.castShadow = true;
  frontFlapPivot.add(frontFlap);
  root.add(frontFlapPivot);
  swappable.push({ mesh: frontFlap, key: 'frontFlap' });

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
    // Turn the left-hand wheels around so their covered face points outboard.
    if (x < 0) wheel.rotation.y = Math.PI;
    spin.add(wheel);

    // The upright, steering arm and brake duct ride on the STEER group, not on
    // the spin group and not on the shell: they turn with the wheel and do not
    // rotate with it. Mirrored for the left-hand corner by a half turn about Y,
    // the same way the wheel is, so one shared geometry serves both sides.
    if (!rear) {
      const key: SwapKey = x < 0 ? 'frontUprightL' : 'frontUprightR';
      const upright = new THREE.Mesh(geo[key], shellMat);
      upright.castShadow = true;
      steer.add(upright);
      swappable.push({ mesh: upright, key });
    }
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
    // On the disc's own station, not a fixed offset. `buildWheel` puts the
    // brake at -0.34 of the wheel's half width, which is a different number
    // front and rear, and the left-hand wheels are turned about Y so their
    // inboard side is +x. A single hard-coded 36mm put the glow outboard of the
    // disc on the rears and inside the cover on the fronts.
    const inboard = -(rear ? REAR_TYRE_W : FRONT_TYRE_W) * 0.5 * 0.34;
    disc.position.x = x > 0 ? inboard : -inboard;
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
    frontFlaps: frontFlapPivot,
    brakeGlow,
    onboardHidden,
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
      // a car that has lost its rear wing still carries a flap in mid-air. The
      // movable front elements are in exactly the same position relative to the
      // front wing, and were exactly the same bug waiting to happen.
      if (id === 'rearWing') flapPivot.visible = attached;
      if (id === 'frontWing') frontFlapPivot.visible = attached;
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
    set.onboardHidden.dispose();
    set.frontWheel.dispose();
    set.rearWheel.dispose();
    set.frontUprightL.dispose();
    set.frontUprightR.dispose();
    set.frontBand.dispose();
    set.rearBand.dispose();
    set.disc.dispose();
    set.flap.dispose();
    set.frontFlap.dispose();
    set.shadow.dispose();
  }
  geometryCache.clear();
  for (const key of Object.keys(sharedMaterials)) {
    sharedMaterials[key].dispose();
    delete sharedMaterials[key];
  }
  disposeLiveryCache();
  disposeTyreCache();
  disposeDetailMaps();
  shadowTexture?.dispose();
  shadowTexture = null;
}
