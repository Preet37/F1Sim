import * as THREE from 'three';
import { loft, section, setFlatUV, strut } from './Loft';
import { swatchUV, type SwatchName } from './Livery';
import { GRIP_X, WHEEL_TILT, WHEEL_Y, WHEEL_Z } from './CockpitMesh';

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
}

/** Seated position: eye point is a little forward of the roll hoop, low down. */
const HEAD_Y = 0.672;
const HEAD_Z = 0.02;
const SHOULDER_Y = 0.505;

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
 * Cockpit interior: the dark tub the driver sits in, and the padded headrest
 * around his shoulders.
 *
 * Without this the cockpit opening is a hole straight through to the underside of
 * the far bodywork, which is worse than a solid lid.
 */
function cockpitInterior(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // Tub floor and walls, sunk below the chassis rim.
  parts.push(tag(loft([
    section(0.66, 0.150, 0.400, 0.560, 0.55),
    section(0.42, 0.200, 0.375, 0.560, 0.45),
    section(0.10, 0.225, 0.370, 0.560, 0.40),
    section(-0.16, 0.215, 0.375, 0.560, 0.45),
    section(-0.34, 0.170, 0.395, 0.545, 0.60),
  ], d.seg, true, d.step), 'dark'));

  // Headrest: the thick padded horseshoe behind and beside the helmet. On a real
  // car it is the most visible thing in the cockpit after the driver.
  parts.push(tag(loft([
    section(0.04, 0.215, 0.470, 0.585, 0.45),
    section(-0.14, 0.230, 0.470, 0.625, 0.4),
    section(-0.30, 0.215, 0.470, 0.615, 0.5),
    section(-0.40, 0.170, 0.470, 0.575, 0.7),
  ], d.seg, true, d.step), 'trim'));

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

    const glove = scaled(
      new THREE.SphereGeometry(0.050, d.limb, Math.round(d.limb * 0.7)),
      1, 1.1, 1.25,
    );
    glove.translate(side * GRIP_X, WHEEL_Y - 0.008, WHEEL_Z - 0.035);
    parts.push(tag(glove, 'glove'));
  }
  return parts;
}

/** Torso, arms, gloves and the HANS collar. */
function figure(d: DriverTier): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // Torso. Reclined: the chest is buried in the tub and only the shoulder line
  // and the top of the chest clear the cockpit rim.
  parts.push(tag(loft([
    section(0.34, 0.115, 0.395, 0.470, 0.8),
    section(0.18, 0.150, 0.390, 0.500, 0.75),
    section(0.02, 0.185, 0.390, 0.522, 0.7),
    section(-0.10, 0.205, 0.390, 0.530, 0.6),
    section(-0.22, 0.180, 0.395, 0.512, 0.7),
    section(-0.32, 0.130, 0.400, 0.478, 0.85),
  ], d.seg, true, d.step), 'suit'));

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

  // Arms: shoulder to elbow to hand. Two tapered members each, which is enough
  // for the eye to read a bent arm reaching to a wheel.
  for (const side of [-1, 1] as const) {
    const sx = side * 0.163, sy = SHOULDER_Y - 0.005, sz = -0.045;
    const ex = side * 0.196, ey = SHOULDER_Y - 0.055, ez = 0.195;
    // The hand end is the grip point, so the arm still lands on the wheel when
    // the coarse glove is swapped for the detailed cockpit hand.
    const hx = side * GRIP_X, hy = WHEEL_Y - 0.008, hz = WHEEL_Z - 0.035;

    const upper = strut(sx, sy, sz, ex, ey, ez, 0.052, d.limb, true);
    parts.push(tag(upper, 'suit'));
    const fore = strut(ex, ey, ez, hx, hy, hz, 0.044, d.limb, true);
    parts.push(tag(fore, 'suit'));

    // Shoulder cap, so the arm does not meet the torso in a visible stump.
    const cap = new THREE.SphereGeometry(0.062, d.limb, Math.round(d.limb * 0.7));
    cap.translate(sx, sy, sz);
    parts.push(tag(cap, 'suit'));
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
  const visor = scaled(new THREE.SphereGeometry(
    R * 1.012, wSeg, d.visorH,
    Math.PI / 2 - 1.02, 2.04,
    1.06, 0.52,
  ), 1.0, 1.10, 1.16);
  visor.translate(0, HEAD_Y, HEAD_Z);
  parts.push(tag(visor, 'glass'));

  // Visor surround, a slightly larger dark shell behind the glass. Gives the
  // aperture an edge instead of letting it float on the paint.
  const surround = scaled(new THREE.SphereGeometry(
    R * 1.004, wSeg, d.visorH,
    Math.PI / 2 - 1.12, 2.24,
    0.99, 0.68,
  ), 1.0, 1.10, 1.16);
  surround.translate(0, HEAD_Y, HEAD_Z);
  parts.push(tag(surround, 'carbon'));

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
  };
}
