import * as THREE from 'three';
import { apertureEdge, limb, loft, section, setFlatUV, type OpenTop } from './Loft';
import { swatchUV, type SwatchName } from './Livery';
import {
  buildHandParts, mirroredX, ARM_SHOULDER, ARM_ELBOW, ARM_WRIST,
  UPPER_ARM_R, FOREARM_R, GRIP_X, HAND_X, HAND_Y,
  WHEEL_TILT, WHEEL_Y, WHEEL_Z,
} from './CockpitMesh';

/**
 * The driver, and the cockpit he sits in.
 *
 * The car used to have a sphere where the driver should be. That single detail
 * did more damage than any amount of bodywork imprecision, because a person is
 * the one object in the scene every viewer has an exact internal model of: a
 * head-sized ball reads as "placeholder" instantly, and once one thing in a
 * render is obviously a placeholder the eye starts looking for others.
 *
 * What actually has to be there for a figure to read as a driver at chase-camera
 * distance is a short list, and it is mostly not the face:
 *
 *  - a HELMET with a visor band and a crown fin, not a sphere — the silhouette of
 *    a modern helmet is a rounded wedge with a squared chin bar, and the visor
 *    aperture is what tells you which way it is pointing;
 *  - SHOULDERS, wider than the head and lower than the cockpit rim, so the head
 *    has something to sit on;
 *  - the HANS collar, a dark ring at the base of the neck, which is the single
 *    most recognisable piece of racing safety equipment there is;
 *  - ARMS, running forward and down out of sight into the tub, ending on a
 *    steering wheel. Arms are what make the figure look like it is *driving*
 *    rather than being carried.
 *
 * The head is kept as a separate object because the player's own cockpit camera
 * sits inside it. Rendering the inside of your own helmet is a black screen; the
 * fix is to hide the head for that one car in that one view, which is why
 * `DriverParts.head` is not merged into the rest.
 *
 * The wheel and the gloves on it are separated for the same reason, one step
 * further on. From outside, a coarse wheel is all anyone can see through the
 * cockpit opening and it costs almost nothing. From the seat it is forty
 * centimetres from the camera, and CockpitMesh draws a proper one there — with
 * a live dash, paddles and articulated hands — in exactly the same place. Both
 * at once is a wheel inside a wheel, so the coarse pair rides in the same
 * bucket as the head and is hidden by the same switch.
 */

export interface DriverParts {
  /**
   * Everything from the neck down, plus the cockpit interior. These get merged
   * into the car's single shell geometry — they never move relative to it.
   */
  body: THREE.BufferGeometry[];
  /** Helmet, visor and fin. Hidden for the player's own cockpit view. */
  head: THREE.BufferGeometry[];
  /**
   * Coarse steering wheel and gloves. Hidden alongside the head, and replaced
   * by the detailed cockpit wheel; see the note above.
   */
  grip: THREE.BufferGeometry[];
  /**
   * The arms, shoulder to wrist. Hidden with the grip, and for the same reason.
   *
   * These used to ride in `body` and be merged into the shell, which was safe
   * for exactly as long as nothing could get close to them. The driver's-eye
   * camera ended that: it puts the player's own upper arms 0.3m from the lens,
   * across the bottom of every frame, where a pair of straight untapered tubes
   * that CANNOT MOVE reads as "blue lego blocks connected to nothing" — the
   * hands turn with the rim and the arms do not follow, which is the whole
   * complaint. CockpitMesh draws an articulated pair in the same place for that
   * one car, so these come out for it exactly the way the coarse wheel does.
   *
   * Nineteen other cars still get them, still for free, still merged.
   */
  arms: THREE.BufferGeometry[];
}

/** Seated position: eye point is a little forward of the roll hoop, low down. */
const HEAD_Y = 0.672;
const HEAD_Z = 0.02;
/**
 * The shoulder line, 22mm higher than it was.
 *
 * It sat at 0.505 under a coaming at 0.575, which is 70mm of daylight between
 * the top of the driver and the top of the tub — and it did not matter, because
 * the deck was closed and none of him was visible anyway. Now that there is a
 * hole to look through, 70mm down is a figure sunk out of sight in a dark box.
 * Every reference frame has the shoulders and the HANS collar level with or
 * barely under the rim: that is the proportion that makes a cockpit look
 * OCCUPIED rather than empty, and it is why the shoulders are the first thing
 * this file's own preamble lists.
 */
const SHOULDER_Y = 0.527;

/**
 * Tessellation, per tier.
 *
 * A person is the object in the scene every viewer has an exact internal model
 * of, so faceting shows on a figure long before it shows on bodywork — a
 * five-sided HANS collar and a six-sided neck are read as "low-poly model", not
 * as "safety equipment". Everything here used to be a hard-coded literal that
 * ignored the tier entirely; only four of about fourteen segment counts ever
 * saw it. Raising the high numbers costs the low tier nothing.
 */
interface DriverTier {
  /** Rings around a lofted body part. */
  seg: number;
  /** Ring spacing along a lofted body part, metres; 0 to skip resampling. */
  step: number;
  /** Helmet shell, width and height segments. */
  shellW: number;
  shellH: number;
  /** Height segments across the visor band and its surround. */
  visorH: number;
  /** Radial segments on an arm, a neck, a glove. */
  limb: number;
  /** HANS collar: segments around the tube, then around the ring. */
  hansR: number;
  hansT: number;
}

const DETAIL: Record<'low' | 'high', DriverTier> = {
  high: { seg: 26, step: 0.05, shellW: 30, shellH: 20, visorH: 8, limb: 14, hansR: 14, hansT: 30 },
  low: { seg: 10, step: 0, shellW: 10, shellH: 7, visorH: 4, limb: 6, hansR: 5, hansT: 12 },
};

function tag(geo: THREE.BufferGeometry, name: SwatchName): THREE.BufferGeometry {
  const [u, v] = swatchUV(name);
  return setFlatUV(geo, u, v);
}

/**
 * Scales a geometry and corrects its normals for the scale.
 *
 * `BufferGeometry.scale` transforms positions and leaves the normal attribute
 * alone, so a sphere squashed into an egg keeps a sphere's normals and lights
 * as if it were still round. The correct transform for a normal under a
 * diagonal scale is the inverse — divide, do not multiply — and it has to be
 * done here rather than by recomputing, because recomputing on a sphere would
 * average across its UV seam and draw a line down the back of the helmet.
 */
function scaled(
  geo: THREE.BufferGeometry, sx: number, sy: number, sz: number,
): THREE.BufferGeometry {
  geo.scale(sx, sy, sz);
  const n = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!n) return geo;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i) / sx, y = n.getY(i) / sy, z = n.getZ(i) / sz;
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / len, y / len, z / len);
  }
  n.needsUpdate = true;
  return geo;
}

/**
 * The seat, and the padded headrest around the driver's shoulders.
 *
 * WHAT CHANGED AND WHY. This used to build a whole tub — a dark closed loft
 * from y 0.370 up to a roof at 0.560 — because the monocoque's "cockpit
 * opening" was a comment and the cockpit needed SOMETHING behind it or the
 * opening looked straight through to the underside of the far bodywork.
 *
 * The monocoque now carries a real aperture: the deck stops at the coaming and
 * the bodywork itself descends into a trough that IS the survival cell, lined
 * in the dark matte swatch. So the tub is not needed and could not stay anyway
 * — its walls ran where the trough's walls now run, and its roof at 0.560 was a
 * lid over a driver whose chest reaches 0.552.
 *
 * What is left is the two things the shell cannot provide: a seat pan under the
 * driver, and the headrest, which is the one piece of cockpit furniture that
 * stands PROUD of the coaming on a real car and is therefore the piece that
 * says from a hundred metres away that there is somebody in there.
 */
const HEADREST_APERTURE: OpenTop = { edge: apertureEdge(0.45, 0.80), share: 0.42, roll: 0.22 };

function cockpitInterior(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // Seat pan. Narrower than the torso at the shoulders, so it is buried there
  // and only emerges forward of the chest where it is the seat under the
  // driver's legs. Its top is below the chest surface deliberately: a seat the
  // driver sits ON reads as furniture, one he sits IN reads as a seat.
  parts.push(tag(loft([
    section(0.46, 0.146, 0.376, 0.428, 0.60),
    section(0.08, 0.180, 0.366, 0.450, 0.50),
    section(-0.24, 0.172, 0.372, 0.444, 0.55),
    section(-0.36, 0.132, 0.386, 0.424, 0.75),
  ], d.seg, true, d.step), 'dark'));

  // Headrest: the thick padded horseshoe behind and beside the helmet, topping
  // out at 0.626 against a coaming at 0.590. Open-topped, so it is a horseshoe
  // around the driver rather than a bolster he is buried under — which is what
  // a closed loft up here would be now that the deck is gone.
  //
  // ITS FLOOR IS AT HEAD HEIGHT, not shoulder height. It used to start at 0.470
  // — below the shoulder line — so its two walls ran through the widest part of
  // the driver and buried the shoulders in dark padding at exactly the angle
  // the cockpit is looked into from. A headrest is beside the HELMET.
  parts.push(tag(loft([
    section(0.02, 0.192, 0.524, 0.582, 0.45, { openDepth: 0.020, openWall: 0.026 }),
    section(-0.16, 0.202, 0.522, 0.626, 0.40, { openDepth: 0.110, openWall: 0.028 }),
    section(-0.31, 0.196, 0.520, 0.616, 0.50, { openDepth: 0.100, openWall: 0.028 }),
    section(-0.41, 0.158, 0.520, 0.576, 0.70, { openDepth: 0.024, openWall: 0.024 }),
  ], Math.round(d.seg * 1.3), true, d.step, HEADREST_APERTURE), 'trim'));

  return parts;
}

/**
 * Steering wheel and gloves: a squared-off rim with grips, angled back toward
 * the driver, with a hand on each grip.
 *
 * Position and rake come from CockpitMesh so the detailed onboard wheel lands
 * on top of this one rather than beside it.
 */
function wheelAndGloves(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // Boxes here were the tell that survived every other fix: this wheel is what
  // shows through the cockpit opening on all nineteen cars you are racing, and
  // a 28mm-thick slab with four razor edges reads as a plastic toy. Lofted, so
  // it has the moulded corners a carbon wheel has.
  const face = loft([
    section(-0.014, 0.0675, -0.055, 0.055, 0.42),
    section(0.014, 0.0675, -0.055, 0.055, 0.42),
  ], Math.max(10, d.seg - 8));
  face.rotateX(WHEEL_TILT);
  face.translate(0, WHEEL_Y, WHEEL_Z);
  parts.push(tag(face, 'dark'));

  // A lit display panel: a small bright rectangle reads as a wheel dash from the
  // cockpit camera and costs two triangles.
  const dash = new THREE.PlaneGeometry(0.10, 0.038);
  dash.rotateX(WHEEL_TILT);
  dash.translate(0, WHEEL_Y + 0.028, WHEEL_Z + 0.019);
  parts.push(tag(dash, 'glass'));

  for (const side of [-1, 1] as const) {
    const grip = loft([
      section(-0.0225, 0.0275, -0.0625, 0.0625, 0.75),
      section(0.0225, 0.0275, -0.0625, 0.0625, 0.75),
    ], Math.max(10, d.seg - 10));
    grip.rotateZ(side * 0.22);
    grip.rotateX(WHEEL_TILT);
    grip.translate(side * GRIP_X, WHEEL_Y - 0.005, WHEEL_Z + 0.004);
    parts.push(tag(grip, 'trim'));

    // THE SAME HANDS THE COCKPIT VIEW USES, at a tenth of the tessellation.
    //
    // These were two squashed spheres, and that was defensible for exactly as
    // long as the deck was closed: nothing outside the car could see them.
    // Cutting the cockpit open changed who is looking. The chase camera now
    // sees straight down into the tub on all twenty cars, so a pair of balls on
    // the rim is the "hand like a lego piece" complaint reproduced nineteen
    // more times — and it is very probably where the complaint came from, since
    // the onboard camera sits on the roll hoop and never sees the wheel at all.
    //
    // Same geometry, same place, built from the same function: the swap between
    // this pair and the onboard pair is a change of tessellation and nothing
    // else, so the hands do not jump when the camera changes.
    for (const part of buildHandParts({
      ring: Math.max(8, d.limb), along: Math.max(5, d.limb - 6), radial: Math.max(6, d.limb - 6),
    })) {
      const g = side > 0 ? part.geo.clone() : mirroredX(part.geo);
      // Wheel-local -> car-local, in the order the cockpit's own scene graph
      // applies it: hand offset, then the wheel's rake, then its centre.
      g.translate(side * HAND_X, HAND_Y, 0);
      g.rotateX(WHEEL_TILT);
      g.translate(0, WHEEL_Y, WHEEL_Z);
      parts.push(tag(g, part.accent ? 'accent' : 'glove'));
    }
  }
  return parts;
}

/** Torso, arms, gloves and the HANS collar. */
function figure(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // Torso. Reclined: the chest is buried in the tub and only the shoulder line
  // and the top of the chest clear the cockpit rim.
  //
  // NARROWER THAN IT WAS, by about 20mm a side. The figure used to be sealed
  // under a solid deck, so nothing it did could collide with anything; now the
  // survival cell has real walls at x 0.214 and a torso at 0.205 was fouling
  // them at the shoulders. 0.196 leaves a genuine gap, and 392mm across the
  // shoulders is still a person — a driver's shoulders fill the opening in the
  // reference frames, which is what this is now doing rather than passing
  // through it.
  parts.push(tag(loft([
    section(0.34, 0.112, 0.395, 0.492, 0.8),
    section(0.18, 0.146, 0.390, 0.522, 0.75),
    section(0.02, 0.178, 0.390, 0.544, 0.7),
    section(-0.10, 0.196, 0.390, 0.552, 0.6),
    section(-0.22, 0.174, 0.395, 0.534, 0.7),
    section(-0.32, 0.126, 0.400, 0.500, 0.85),
  ], d.seg, true, d.step), 'suit'));

  // Harness. Two shoulder belts over the chest, converging on a buckle at the
  // sternum, in the team's accent so they read at a glance.
  //
  // These are new, and they are new because there was nothing to see them
  // through. A six-point harness over a bright suit is one of the three or four
  // things a viewer's eye goes looking for in an open cockpit — it is right
  // there in every reference frame, it is what says "strapped in", and a driver
  // without one reads as sitting in the car rather than racing it. The belts
  // ride ON the chest: every station's y is set from the torso's own surface at
  // that x, plus 7mm for the webbing.
  for (const side of [-1, 1] as const) {
    parts.push(tag(loft([
      section(-0.150, 0.034, 0.548, 0.560, 0.55, { xc: side * 0.098 }),
      section(-0.060, 0.035, 0.549, 0.562, 0.50, { xc: side * 0.094 }),
      section(0.020, 0.035, 0.541, 0.554, 0.50, { xc: side * 0.076 }),
      section(0.085, 0.033, 0.527, 0.540, 0.55, { xc: side * 0.050 }),
      section(0.140, 0.030, 0.508, 0.521, 0.60, { xc: side * 0.026 }),
    ], Math.max(8, d.seg - 12), true, d.step), 'accent'));
  }
  // The buckle the two belts meet on.
  {
    const buckle = loft([
      section(0.128, 0.036, 0.500, 0.526, 0.35),
      section(0.152, 0.040, 0.496, 0.524, 0.30),
      section(0.172, 0.034, 0.494, 0.518, 0.45),
    ], Math.max(8, d.seg - 12), true, d.step);
    parts.push(tag(buckle, 'trim'));
  }

  // Neck.
  const neck = new THREE.CylinderGeometry(0.052, 0.062, 0.10, d.limb);
  neck.rotateX(0.24);
  neck.translate(0, SHOULDER_Y + 0.055, HEAD_Z - 0.045);
  parts.push(tag(neck, 'suit'));

  // HANS collar: a flattened ring sitting on the shoulders around the neck.
  const hans = scaled(new THREE.TorusGeometry(0.098, 0.030, d.hansR, d.hansT), 1, 0.72, 1);
  hans.rotateX(-Math.PI / 2 + 0.22);
  hans.translate(0, SHOULDER_Y + 0.030, HEAD_Z - 0.055);
  parts.push(tag(hans, 'carbon'));

  return parts;
}

/**
 * Arms: shoulder to elbow to wrist, two tapered members each.
 *
 * WHAT WAS WRONG. They were two untapered tubes — 104mm across all the way from
 * the shoulder to the elbow, 88mm from the elbow to the glove — and the elbow
 * sat at z = 0.195, thirty millimetres in front of the driver's eye. From
 * outside the car that was invisible; from the driver's-eye camera it is two
 * blue cylinders across the bottom of the frame with a hard step where each
 * meets a glove half its diameter. Tapering them, and narrowing the wrist end
 * to 68mm so the glove is the widest thing at that joint, is most of the fix.
 *
 * The other half is that they have to MOVE, and geometry merged into a shared
 * shell cannot. See `DriverParts.arms`: these are hidden for the car the onboard
 * camera is inside, and CockpitMesh articulates a pair in the same place.
 *
 * The elbow used to swing out to x 0.196 with a 44mm arm on it — 240mm from the
 * centreline, through a survival cell wall that is at 214mm. 0.163 keeps the
 * forearm INSIDE the tub, which is both correct and the only way the arms read
 * as going down into the car rather than over the side of it.
 */
function arms(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const sh = [side * ARM_SHOULDER[0], ARM_SHOULDER[1], ARM_SHOULDER[2]] as const;
    const el = [side * ARM_ELBOW[0], ARM_ELBOW[1], ARM_ELBOW[2]] as const;
    const wr = [side * ARM_WRIST[0], ARM_WRIST[1], ARM_WRIST[2]] as const;
    parts.push(tag(limb(sh, el, UPPER_ARM_R[0], UPPER_ARM_R[1], d.limb), 'suit'));
    parts.push(tag(limb(el, wr, FOREARM_R[0], FOREARM_R[1], d.limb), 'suit'));
    // Elbow and shoulder, so the two segments do not meet in a visible mitre.
    const cap = new THREE.SphereGeometry(0.056, d.limb, Math.round(d.limb * 0.7));
    cap.translate(sh[0], sh[1], sh[2]);
    parts.push(tag(cap, 'suit'));
    const joint = new THREE.SphereGeometry(0.047, d.limb, Math.round(d.limb * 0.7));
    joint.translate(el[0], el[1], el[2]);
    parts.push(tag(joint, 'suit'));
  }
  return parts;
}

/** Helmet, visor and crown fin. */
function helmet(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const wSeg = d.shellW;
  const R = 0.142;

  // Shell. Scaled taller than wide and longer than tall: a helmet is an egg, not
  // a ball, and the difference is most of what separates a driver from a lollipop.
  //
  // The scale goes through `scaled` so the normals are corrected for it. Left
  // alone, an egg lit with a sphere's normals is subtly but consistently wrong
  // at the crown, which is the part of the driver a chase camera looks straight
  // down onto.
  const shell = scaled(new THREE.SphereGeometry(R, wSeg, d.shellH), 1.0, 1.10, 1.16);
  shell.translate(0, HEAD_Y, HEAD_Z);
  parts.push(tag(shell, 'helmet'));

  // Jaw: the squared-off lower front that a modern helmet has and a sphere does
  // not. Lofted rather than boxed — a box here reads as a brick glued to a ball,
  // which is exactly how the first attempt looked from the chase camera.
  parts.push(tag(loft([
    section(HEAD_Z + 0.150, 0.056, HEAD_Y - 0.120, HEAD_Y - 0.032, 0.50),
    section(HEAD_Z + 0.100, 0.080, HEAD_Y - 0.142, HEAD_Y + 0.004, 0.40),
    section(HEAD_Z + 0.010, 0.094, HEAD_Y - 0.152, HEAD_Y + 0.020, 0.50),
    section(HEAD_Z - 0.070, 0.082, HEAD_Y - 0.132, HEAD_Y + 0.010, 0.70),
  ], wSeg - 4, true, d.step * 0.5), 'helmet'));

  // Visor aperture. A band of dark glass wrapped round the front of the shell,
  // slightly proud of it so it never z-fights.
  //
  // BIGGER, ON BOTH AXES, and this is most of the answer to "the driver's
  // helmet is a plain sphere". It is not that the shell was a sphere — it is an
  // egg with a jaw and a crown fin — it is that from any distance the only
  // thing distinguishing a helmet from a ball is the DARK BAND ACROSS ITS
  // FRONT, and ours covered 117 degrees of the circumference and 30 degrees of
  // the elevation. A real visor aperture runs to about 150 degrees around and
  // is half as deep again; at the old size the head read as a painted sphere
  // with a smudge on it in every shot where the car was more than four metres
  // away, which is every shot.
  const visor = scaled(new THREE.SphereGeometry(
    R * 1.012, wSeg, d.visorH,
    Math.PI / 2 - 1.32, 2.64,
    0.99, 0.62,
  ), 1.0, 1.10, 1.16);
  visor.translate(0, HEAD_Y, HEAD_Z);
  parts.push(tag(visor, 'glass'));

  // Visor surround, a slightly larger dark shell behind the glass. Gives the
  // aperture an edge instead of letting it float on the paint.
  const surround = scaled(new THREE.SphereGeometry(
    R * 1.004, wSeg, d.visorH,
    Math.PI / 2 - 1.42, 2.84,
    0.93, 0.78,
  ), 1.0, 1.10, 1.16);
  surround.translate(0, HEAD_Y, HEAD_Z);
  parts.push(tag(surround, 'carbon'));

  // The CHIN BAR intake: the dark slot under the visor that feeds the driver's
  // air. Small, and it is the second feature — after the visor band — that the
  // eye uses to tell which way a helmet is facing. Without it the lower front
  // of the shell is an unbroken curve of paint and the head loses its front.
  parts.push(tag(loft([
    section(HEAD_Z + 0.148, 0.036, HEAD_Y - 0.096, HEAD_Y - 0.054, 0.55),
    section(HEAD_Z + 0.116, 0.044, HEAD_Y - 0.110, HEAD_Y - 0.058, 0.45),
    section(HEAD_Z + 0.076, 0.038, HEAD_Y - 0.114, HEAD_Y - 0.066, 0.60),
  ], Math.max(6, wSeg - 10), true, d.step * 0.5), 'dark'));

  // Crown fin: the small aero blade along the top of every current helmet.
  parts.push(tag(loft([
    section(0.055, 0.010, HEAD_Y + 0.148, HEAD_Y + 0.156, 0.4),
    section(-0.030, 0.011, HEAD_Y + 0.146, HEAD_Y + 0.183, 0.35),
    section(-0.115, 0.010, HEAD_Y + 0.128, HEAD_Y + 0.176, 0.4),
  ], Math.max(8, wSeg - 12), true, d.step * 0.5), 'carbon'));

  return parts;
}

/**
 * Builds the driver. Geometry only: the caller merges it into the car's shell so
 * the whole figure costs no extra draw call, apart from the head.
 */
export function buildDriverParts(quality: 'low' | 'high'): DriverParts {
  const d = DETAIL[quality];
  return {
    body: [...cockpitInterior(d), ...figure(d)],
    head: helmet(d),
    grip: wheelAndGloves(d),
    arms: arms(d),
  };
}
