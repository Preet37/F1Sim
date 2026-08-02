import * as THREE from 'three';
import { buildCarbonTexture } from './Livery';
import { creased, loft, section, setPanelUV, tube } from './Loft';
import { gloveNomexMap } from './DetailMaps';

/**
 * Everything a driver actually sees from inside the car.
 *
 * A cockpit camera that is only a viewpoint is not a cockpit view. What makes an
 * onboard shot read as an onboard shot is the stuff that never moves relative to
 * your head: the halo arcing overhead, the wheel turning in your hands, the
 * mirrors twitching at the edge of vision, and the chassis framing the bottom of
 * the frame. Without them the "cockpit" is indistinguishable from a very low
 * bumper cam.
 *
 * All of this geometry is CAR-LOCAL — it is parented to the car root, so it
 * inherits the chassis' position, heading, roll and pitch for free — and it is
 * only ever attached to the player's car, and only made visible while the
 * cockpit camera is selected. Twenty cars' worth of steering wheels and gloves
 * would be a lot of triangles nobody can see.
 *
 * Coordinates: +x right, +y up, +z toward the nose. The origin is the contact
 * patch plane at the centre of the car.
 *
 * NOT to be confused with DriverMesh.ts, which is the other half of the same
 * problem: the driver's BODY as seen from outside — helmet, shoulders, HANS
 * collar, arms — merged into the shared shell so all twenty cars have someone
 * in them. This module is the reverse view, of one car, from one seat. The two
 * meet at the steering wheel, which both place, and which is why the wheel's
 * position, rake and grip points are defined here and imported there.
 */

/**
 * Where the cockpit camera sits, car-local. The camera is put exactly here.
 *
 * NOT INSIDE THE DRIVER'S HELMET, and that was settled two passes ago: the
 * halo's forward pillar is already a 20mm blade — the real article — and from
 * an eye 0.7m behind it that is still 1.7 degrees of solid black straight down
 * the middle of the picture, which no honest pillar is thin enough to avoid.
 * The reference onboards show the crown of the driver's OWN helmet in the
 * bottom of the frame, which is a thing no eye inside that helmet can ever see.
 * It is the standard onboard: a pod on the roll hoop, behind and above the
 * head. Two things had to move out of its way and neither is reachable from
 * here — the roll hoop's camera pod, which IS this camera, and the airbox's
 * front lip, which hid the helmet from any eye behind it. Both are in CarMesh;
 * see `Parts.onboardHidden` and the airbox comment.
 *
 * FIFTH PASS ON THE HEIGHT AND DISTANCE, and this one was measured rather than
 * eyeballed.
 *
 * "The halo is cooking me bro its ass." "Why is the halo still ugly and shit?"
 * "I think this is due to the halo, the halo sticks out." "You also never fixed
 * the halo?" Four reports, four passes, and every one of them was judged from a
 * screenshot in words — so none of them produced a number, none could be
 * compared with the next, and twice a change made the framing worse in a way
 * nobody could name. `npm run probe:framing` now projects the halo's own
 * centreline through the real camera rig on all eleven circuits and says where
 * it lands. What it said about this eye point was:
 *
 *   horizon at 29-33 per cent of frame height  (reference: 42)
 *
 * That single number is the whole complaint. A camera pitched 7.8 degrees down
 * is looking at the floor: the sky is a strip along the top, two thirds of the
 * picture is your own car and the tarmac immediately in front of it, and the
 * halo — which is fixed to the car — is dragged up into the middle of what is
 * left. It is also exactly the "cockpit view is half blocked" report, and the
 * two are the same fault seen twice.
 *
 * The pitch alone cannot be fixed: flattening it to 3 degrees and leaving the
 * eye where it was pushes the crown of the hoop from 55 to 69 per cent, which
 * lays the hoop across the middle of the frame instead. Both had to move
 * together, and the pair below is the solution of three constraints taken off
 * the reference onboards — horizon at 42 per cent, hoop crown around 60, the
 * driver's own helmet crown around 80 — with the eye's DISTANCE from the helmet
 * held near 0.66m so the helmet keeps the size it has in the reference frames.
 * 0.98m up and 0.58m back, and the resulting numbers, on all eleven circuits:
 *
 *   horizon 41%, hoop crown 61%, helmet crown 81%, mirrors at 78% of frame
 *   width and 83% of frame height, wheel rim top at 74%.
 *
 * The eye is now on the front of the roll-hoop fairing rather than a foot
 * behind it, which is also where the reference game's camera plainly is: its
 * mirrors sit at two thirds of the frame width, and ours could not reach that
 * from 0.78m back at any field of view.
 */
export const EYE_X = 0;
export const EYE_Y = 0.98;
export const EYE_Z = -0.58;

/**
 * Downward tilt of the cockpit camera, radians.
 *
 * 3.04 degrees, and it is a measurement: `probe:framing` reports the horizon at
 * 41 per cent of frame height with it, which is where the reference onboards
 * carry it. It used to be 7.8, which put the horizon at 30 — see EYE_Y for what
 * that does to the picture and why the eye had to move with it.
 */
export const EYE_PITCH = 0.053;

/**
 * Centre of the steering wheel, car-local, and its rake.
 *
 * Exported because DriverMesh puts the coarse wheel and the driver's hands in
 * the same place: the two have to agree exactly, or the detailed wheel drawn
 * for the onboard view sits somewhere other than the one every other camera
 * sees, and the driver's arms reach for empty air.
 */
/**
 * Height is set by the DRIVER, not by the framing, and it changed when the
 * camera moved onto the roll hoop.
 *
 * The old height was chosen against an eye inside the helmet, where the rule
 * was "keep the rim below the sightline so the road stays continuous". From
 * behind the helmet the rule is the opposite one and it is a measurement: the
 * reference onboards show the top third of the rim standing ABOVE the crown of
 * the helmet, about three degrees of it, because a real wheel top is roughly
 * 130mm below a real helmet crown and 550mm in front of it. Ours was 190mm
 * below, which put the rim within half a degree of the crown — so the helmet
 * covered it completely and the shot had no steering wheel in it at all.
 *
 * At 0.613 the top of the rim is 0.708, the crown is 0.828, and the rim clears
 * the helmet by the three degrees the reference has. The centre also now sits
 * just above the coaming at 0.578 and well clear of the dash lip at 0.574,
 * which is where a real car carries it.
 *
 * Reach is unchanged and still an arm's length: 0.575 in z, with the elbow
 * inside the tub (see DriverMesh, which takes the grip point from here).
 */
export const WHEEL_X = 0;
export const WHEEL_Y = 0.613;
export const WHEEL_Z = 0.575;
/** Rake of the wheel: the top is tipped back toward the driver. */
export const WHEEL_TILT = -0.45;

/** Where the hands grip the rim, in wheel-local x. */
export const GRIP_X = 0.122;

const WHEEL_HALF_W = 0.138;
const WHEEL_HALF_H = 0.100;

/**
 * Mirror mounts, car-local (right-hand side; the left is mirrored in x).
 *
 * Shared with CarMesh, which builds the stalk and the housing into the shell so
 * that all twenty cars have mirrors, and leaves the reflective pane to this
 * module because only one car is ever looked out of.
 */
/**
 * Further out and further forward than they were, and lower.
 *
 * A mirror 0.79m from the eye at 37 degrees off axis lands exactly on the edge
 * of the frame, where a 105mm pod subtends nearly eight degrees and reads as a
 * slab pushing into the picture. Carried forward to 0.79 in z and out to 0.505
 * it sits at 33 degrees and 0.87m — still comfortably inside a driver's useful
 * field, still where a real car mounts them, and a fifth smaller on screen.
 */
/**
 * DOWN 26mm ONTO THE COAMING, because the halo was sitting on top of it.
 *
 * Measured rather than noticed: projecting the halo's own centreline over the
 * pane from both onboard cameras and both frame shapes — the same arithmetic
 * `probe:framing` does — the rear leg of the hoop passes NEARER to the eye than
 * the mirror and directly across it, leaving only 36 per cent of the pane
 * visible from the cockpit. A mirror three fifths covered by a black tube is a
 * mirror that does not work however good the feed behind it is, and the first
 * blow-up of one showed exactly that: a bar across the pane with a sliver of
 * live picture below it.
 *
 * It cannot be made to clear entirely. The rear leg of a halo genuinely does
 * cross the mirror line on a real car, and the two onboards pull opposite ways
 * — lowering the pane clears it for the cockpit eye and worsens it for the
 * T-cam behind. 0.578 is the best of that trade at a height a real mirror is
 * actually mounted, just proud of the tub rim at 0.556: worst case 44 per cent
 * of the pane clear against 36, and 62 per cent from the cockpit.
 */
export const MIRROR_X = 0.505;
export const MIRROR_Y = 0.578;
export const MIRROR_Z = 0.790;
/** Front face of the housing, where the glass sits. */
export const MIRROR_GLASS_Z = 0.769;

/**
 * The point on the road each mirror is aimed at, car-local.
 *
 * A mirror is not aimed at your eye — a pane facing the driver square on is a
 * retroreflector and shows him himself, which is exactly what the first version
 * of the live feed did: the reflected sightline came straight back down the
 * line it arrived on and the mirror rendered the roll hoop.
 *
 * What sets a mirror's angle is the pair of directions it has to join. The
 * normal BISECTS the line to the eye and the line to whatever the mirror is
 * supposed to show, and that is the whole of mirror aiming. Twenty-five metres
 * back and three metres out is the piece of road a car appears from when it is
 * setting up a move, which is the question the mirrors exist to answer.
 */
const MIRROR_TARGET_X = 3.0;
const MIRROR_TARGET_Y = 0.85;
const MIRROR_TARGET_Z = -25;

export interface CockpitState {
  /** Road-wheel angle in radians. The rim turns by RACK_RATIO times this. */
  steerRad: number;
  gearLabel: string;
  speedKph: number;
  rpmFraction: number;
  drsOpen: boolean;
  ersPercent: number;
}

/**
 * Steering rack ratio.
 *
 * A real F1 rack is roughly 3:1 — a little under a full turn lock to lock for
 * about ±20 degrees of road wheel. Turning the rim by the road-wheel angle, as
 * a naive implementation does, makes the driver look like they are steering with
 * their fingertips.
 */
export const RACK_RATIO = 3;

export interface CockpitVisual {
  root: THREE.Group;
  setVisible(v: boolean): void;
  update(state: CockpitState): void;
  /**
   * Draws what is actually behind the car into the mirror panes.
   *
   * Called by the renderer, once per frame, BEFORE the main scene render and
   * only while the cockpit is on screen. Everything it needs — the renderer,
   * the scene and the eye it is being looked at from — is passed in rather than
   * held, because this module has no business owning any of them.
   *
   * Not calling it is a complete opt-out: the render targets are allocated on
   * the first call, so a session that never selects the cockpit, and the whole
   * low quality tier, pay nothing at all.
   */
  renderMirrors(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.Camera,
    stride: number,
  ): void;
  dispose(): void;
}

/**
 * Mirror feed resolution.
 *
 * The panes are 100mm by 38mm and sit 1.5m from the eye, which is about
 * twenty-five pixels across on a 1280-wide frame. 256 by 96 is already four
 * times more than that resolves; the point of the extra is that the mirror is
 * minified rather than magnified, so a car in it is filtered instead of
 * blocky. Two of them in half-float come to 384KB.
 */
const MIRROR_W = 256;
const MIRROR_H = 96;

/**
 * How many frames apart two consecutive mirror renders are.
 *
 * The panes alternate, so a stride of N refreshes each pane every 2N frames.
 * This is the entire cost control and it is a schedule rather than a switch,
 * because the previous arrangement — a switch, off below the high tier — is why
 * no phone has ever had a working mirror.
 *
 * MEASURED, on the software renderer the audit runs on, at Bahrain, which is
 * the heaviest thing available to measure against: a scene render into the
 * 256x96 feed costs about a fifth of a full 1280x589 frame. At stride 1 that is
 * one extra render per frame; at stride 3 it is one per three, so a third of a
 * fifth — under 7 per cent of a frame — and each pane still updates five times
 * a second at 30fps. Five updates a second is choppy to stare at and completely
 * adequate for the question the mirror answers, which is whether anybody is
 * there.
 */
const MIRROR_STRIDE_HIGH = 1;
const MIRROR_STRIDE_LOW = 3;
export { MIRROR_STRIDE_HIGH, MIRROR_STRIDE_LOW };

/**
 * Vertical field of view of a mirror, degrees.
 *
 * A real F1 mirror is narrow and a driver aims it at the piece of road a
 * passing car appears from. This is deliberately wider than the real article —
 * 42 vertical is about 78 across — because the pane on screen is small and a
 * narrow lens would show a passing car for a fraction of a second. The
 * question being answered is "is anybody there", and a wide answer is more
 * useful than a precise one.
 */
const MIRROR_FOV = 42;

/**
 * How far a mirror can see, metres.
 *
 * Short on purpose. This is a second view frustum over the whole scene and the
 * only thing that keeps it cheap is how little of the world falls inside it;
 * at 200m a car is a pixel in a 256-wide feed and nothing behind that is worth
 * a draw call.
 */
export const MIRROR_FAR = 200;

// ===========================================================================
// Small geometry helpers
// ===========================================================================

/**
 * Segment counts for everything in here.
 *
 * NOTHING else in the scene is viewed from this range. The wheel rim sits
 * 540mm from the eye and fills a third of the frame, so a 23mm grip at ten
 * segments is a visible decagon and an eight-sided steering column is a
 * visible octagon — counts that are entirely reasonable on a wishbone two
 * metres away are not reasonable here. These are deliberately the largest
 * numbers in the project, and they are affordable because exactly one car in
 * the field is ever built with a cockpit.
 */
const SEG = {
  /** Round sections: grips, the column, knobs, the wrist cuff. */
  round: 24,
  /** Curve resolution on the extruded wheel rim outline. */
  rimCurve: 20,
  /** Rings around a lofted bolster or dash. */
  loftRing: 24,
  /** Ring spacing along a lofted bolster, metres. */
  loftStep: 0.04,
};

/**
 * The onboard hand: the largest numbers in the project, deliberately.
 *
 * A finger is 10mm across and 500mm from the eye — about the same angular size
 * as a wing endplate at two metres, which gets fourteen — and it is curved
 * along its whole length, so the count ALONG the sweep matters as much as the
 * count around it. At twelve radial the section is a visible dodecagon in a
 * specular highlight; at twenty it is round. Two hands at this detail is about
 * five thousand triangles on the ONE car in the field that has a cockpit,
 * which is a fraction of a single tyre's.
 */
const COCKPIT_HAND: HandDetail = { ring: 26, along: 20, radial: 20 };

/** A capsule-ish strut between two car-local points. */
function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1 = r0,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, SEG.round, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/**
 * A block with every edge rounded — a grip flash, a shift paddle, a switch cap.
 *
 * These were `BoxGeometry`. A box has infinitely sharp edges and nothing at
 * this range does; the corner radius is what puts a curved highlight on the
 * part and tells the eye it is a moulded object of a particular size. `w` runs
 * x, `h` runs y, `d` runs z, and `r` is the corner radius.
 */
function roundedBlock(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const round = Math.max(0.1, Math.min(0.9, (r * 2) / Math.max(1e-4, Math.min(w, h))));
  // The two end caps are inset by the radius and blended in, so the ends are
  // rounded too rather than being flat discs on a rounded bar.
  const inset = Math.min(r, d * 0.4);
  return loft([
    section(-d / 2, w / 2 - inset * 0.7, -h / 2 + inset * 0.7, h / 2 - inset * 0.7, Math.min(1, round + 0.25)),
    section(-d / 2 + inset, w / 2, -h / 2, h / 2, round),
    section(d / 2 - inset, w / 2, -h / 2, h / 2, round),
    section(d / 2, w / 2 - inset * 0.7, -h / 2 + inset * 0.7, h / 2 - inset * 0.7, Math.min(1, round + 0.25)),
  ], SEG.loftRing);
}

function roundedRect(
  path: THREE.Shape | THREE.Path,
  x: number, y: number, w: number, h: number, r: number,
): void {
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
}

// ===========================================================================
// The driver's hands
// ===========================================================================

/**
 * "The hand still looks like a lego piece — what happened to actual fingers."
 *
 * The old hand was a squashed sphere with four identical straight capsules
 * poking out of it at a fixed angle, a fifth for a thumb, and a cylinder for a
 * cuff. Every one of those is a defensible primitive somewhere on this car and
 * not one of them is defensible HERE, because the hands sit about 500mm from
 * the cockpit camera and a human hand is — with the driver's helmet — one of
 * the two objects in the scene every viewer has a complete internal model of.
 * The specific tells were: fingers of constant diameter (a real one tapers by a
 * third from knuckle to tip), no joints (three of them, each a visible swelling),
 * no curl (a hand on a rim is wrapped nearly the whole way round it, not laid
 * against it), a thumb that was just a fifth finger, and hard-edged primitives
 * meeting at intersections instead of a continuous surface.
 *
 * WHAT IT IS NOW. Every finger is a single swept tube through an arc that wraps
 * the grip, so it is one continuous smoothly-shaded surface from knuckle to
 * fingertip rather than a stack of parts. The sweep's radius profile does three
 * jobs at once: it tapers the finger toward the tip, it swells at the three
 * joints, and it closes the tip over a radius. Segment counts are the highest
 * in the project, because so is the magnification.
 *
 * HANDEDNESS. One hand is built and the other is its MIRROR — not a copy, not a
 * rotation. A right hand rotated about the grip is still a right hand and reads
 * instantly as wrong, and this is the only place in the project where that
 * distinction exists.
 */

/** Radius of the rim upright the hands are wrapped around. */
const GRIP_R = 0.022;

/**
 * Where a hand sits relative to the wheel's centre, in wheel-local space.
 *
 * Exported so DriverMesh can put the same hands in the same place: the detailed
 * pair and the shared pair are the SAME geometry at two tessellations, and if
 * the two disagreed by a centimetre the swap between them would be visible
 * every time the camera changed.
 */
export const HAND_X = GRIP_X;
export const HAND_Y = -0.005;

/** How finely to build a hand. See `SEG` for why the cockpit's are so high. */
export interface HandDetail {
  /** Rings around the hand's own loft, and around a wrist or cuff. */
  ring: number;
  /** Segments along a finger's sweep. */
  along: number;
  /** Segments around a finger's section. */
  radial: number;
}

/** One piece of a hand, and whether it wants the cuff's accent colour. */
export interface HandPart {
  geo: THREE.BufferGeometry;
  accent: boolean;
}

/**
 * Bands of the glove map. Contract with `gloveNomex` in
 * scripts/generateTextures.mjs — if one moves, both move.
 */
const GLOVE_PANEL = {
  /** Plain knit. Fingers, thumb, wrist. */
  field: [0.02, 0.44] as const,
  /** Knit plus padded pads with stitched borders. The hand itself. */
  palm: [0.48, 0.76] as const,
  /** Knit plus elastic ribbing and a double-stitched hem. */
  cuff: [0.80, 0.99] as const,
};

/**
 * A parabolic bump, 1 at `c` and 0 outside `c ± w`. Used for knuckles.
 *
 * Parabolic rather than Gaussian because it reaches zero at a known place: a
 * joint swelling has to stop, or the taper it is added to stops being a taper.
 */
function bump(t: number, c: number, w: number): number {
  const d = (t - c) / w;
  return Math.max(0, 1 - d * d);
}

/**
 * Maps a swept tube's UVs into a band of the glove map.
 *
 * `TubeGeometry` gives u along the sweep and v around the section, which is
 * already the right parameterisation — this only rescales it into the band and
 * repeats it along the part so the knit lands at a constant physical size
 * whether the part is a 20mm cuff or an 80mm finger.
 */
function setTubeUV(
  geo: THREE.BufferGeometry, band: readonly [number, number], repeat: number,
): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * repeat, band[0] + uv.getY(i) * (band[1] - band[0]));
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * The mirror image of a geometry across the car's centreline.
 *
 * `scale` runs the positions through `applyMatrix4`, which also transforms the
 * normals by the inverse transpose — so those come out right on their own. The
 * winding does NOT: a reflection reverses it, and left alone the entire left
 * hand renders inside out. Swapping two indices of every triangle is the whole
 * fix and it is easy to forget, which is why it is here rather than inline.
 */
export function mirroredX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    idx.needsUpdate = true;
  }
  return g;
}

/**
 * One finger, swept through an arc around the grip.
 *
 * ANGLE CONVENTION, in hand-local space with the grip's axis on y:
 * a = 0 is the far side of the rim, a = pi/2 outboard, a = pi the near side —
 * the side the driver looks at. A right hand's knuckles therefore sit at about
 * 2.3 radians, out where the back of the hand is, and the finger sweeps DOWN in
 * a, round the far side, until the tip comes back inboard.
 *
 * @param y0     height of the knuckle on the grip
 * @param a0     knuckle angle
 * @param length arc length of the finger, metres
 * @param r0     radius at the knuckle
 * @param drift  how far the tip drifts in y, so the fingers converge as a real
 *               hand's do rather than staying in four parallel planes
 */
function finger(
  y0: number, a0: number, length: number, r0: number, drift: number, d: HandDetail,
): THREE.BufferGeometry {
  // A swept tube is open at both ends. The tip is closed by the radius profile
  // below; the BASE is closed by burying it — the sweep starts a quarter radian
  // further round, inside the back of the hand, so the open end is never on the
  // outside of anything. Without it the knuckle end sits within a millimetre or
  // two of the hand's own surface and every finger has a hole in the end of it.
  const BURY = 0.34;
  const sweep = length / (GRIP_R + r0);
  const total = sweep + BURY;
  // Where along the swept curve the finger actually leaves the hand. Everything
  // shaped below is measured from THERE, so the joints stay put whatever the
  // burial costs.
  const v0 = BURY / total;
  const out = (t: number): number => Math.max(0, (t - v0) / (1 - v0));

  // Centreline radius: the grip plus the finger's own thickness, so the finger
  // rests ON the rim instead of inside it. It creeps outward toward the tip
  // because the tip does not close all the way onto the rim.
  const N = d.along;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = out(t);
    const a = a0 + BURY - total * t;
    const r = GRIP_R + r0 * (1.0 + 0.35 * u * u);
    pts.push([Math.sin(a) * r, y0 + drift * u * u, Math.cos(a) * r]);
  }
  // The radius profile: taper toward the tip, three joint swellings on the way,
  // and a closing radius at the very end so the finger has a fingertip rather
  // than a sawn-off cylinder.
  const taper = (t: number): number => {
    const u = out(t);
    const shape = 1 - 0.34 * u;
    const joints = 0.11 * bump(u, 0.05, 0.11)
      + 0.14 * bump(u, 0.40, 0.13)
      + 0.11 * bump(u, 0.72, 0.11);
    // Quarter-circle close over the last 8 per cent.
    const close = u > 0.92 ? Math.sqrt(Math.max(0, 1 - ((u - 0.92) / 0.08) ** 2)) : 1;
    return (shape + joints) * close;
  };
  return setTubeUV(tube(pts, r0, d.along, d.radial, taper), GLOVE_PANEL.field, 2);
}

/**
 * Everything of one hand, built for the RIGHT-hand grip. The left is this
 * mirrored; see `mirroredX`.
 *
 * Returns geometry tagged with which material it wants, because the cuff is the
 * team's accent and the rest is glove.
 */
export function buildHandParts(d: HandDetail): HandPart[] {
  const out: HandPart[] = [];

  // --- The hand itself ----------------------------------------------------
  // A flattened slab wrapping the outboard-and-near quadrant of the grip, so
  // the driver sees the BACK of his hand and the fingers disappearing round the
  // far side of the rim. Lofted along z with the section's lateral and vertical
  // centres drifting, which is what carries it outward and downward toward the
  // wrist without it having to be a separate part.
  //
  // halfWidth is the hand's THICKNESS — 30mm through the knuckles — and height
  // is its BREADTH across the four fingers. Getting those two the wrong way
  // round is what makes a modelled hand look like a paddle.
  out.push({
    geo: setPanelUV(loft([
      section(-0.004, 0.0140, -0.038, 0.040, 0.62, { xc: 0.0225 }),
      section(-0.020, 0.0160, -0.040, 0.042, 0.52, { xc: 0.0270 }),
      section(-0.040, 0.0158, -0.046, 0.034, 0.55, { xc: 0.0315 }),
      section(-0.058, 0.0142, -0.050, 0.022, 0.70, { xc: 0.0340 }),
      section(-0.070, 0.0120, -0.048, 0.010, 0.85, { xc: 0.0350 }),
    ], d.ring, true, 0.008), 0, GLOVE_PANEL.palm[0], 1, GLOVE_PANEL.palm[1]),
    accent: false,
  });

  // --- Fingers ------------------------------------------------------------
  // Index at the top down to the little finger, each shorter and thinner than
  // the last but the middle finger longest, which is the proportion the eye
  // checks. They converge downward toward the middle of the grip as a closed
  // hand's do.
  const FINGERS: [number, number, number, number, number][] = [
    // y0,     a0,   length, r0,     drift
    [0.0325, 2.36, 0.077, 0.0104, -0.0055],
    [0.0115, 2.30, 0.083, 0.0107, -0.0020],
    [-0.0095, 2.28, 0.077, 0.0100, 0.0022],
    [-0.0290, 2.32, 0.062, 0.0088, 0.0058],
  ];
  for (const [y0, a0, len, r0, drift] of FINGERS) {
    out.push({ geo: finger(y0, a0, len, r0, drift, d), accent: false });
  }

  // --- Thumb --------------------------------------------------------------
  // A thumb is not a fifth finger and modelling it as one is half of why the
  // old hand read as a mitten. It comes off the SIDE of the hand at the base of
  // the index finger, has two phalanges rather than three, is appreciably
  // thicker, and on a wheel it lies UP the near face of the grip toward the
  // rim's centre rather than wrapping it.
  {
    const pts: [number, number, number][] = [
      [0.0300, 0.0180, -0.0250],
      [0.0268, 0.0292, -0.0298],
      [0.0192, 0.0400, -0.0316],
      [0.0090, 0.0476, -0.0300],
      [-0.0010, 0.0516, -0.0268],
    ];
    const taper = (t: number): number => {
      const shape = 1 - 0.30 * t;
      const joints = 0.12 * bump(t, 0.08, 0.14) + 0.13 * bump(t, 0.52, 0.16);
      const close = t > 0.90 ? Math.sqrt(Math.max(0, 1 - ((t - 0.90) / 0.10) ** 2)) : 1;
      return (shape + joints) * close;
    };
    out.push({
      geo: setTubeUV(
        tube(pts, 0.0128, d.along, d.radial, taper),
        GLOVE_PANEL.field, 2,
      ),
      accent: false,
    });
  }

  // --- Wrist and cuff -----------------------------------------------------
  // The forearm behind this is NOT built here: DriverMesh already runs a real
  // arm from the shoulder to this exact point for every car on the grid, and a
  // second one starting at the wrist reads as a third limb. What is here is the
  // last 40mm of it, so the hand does not end in a hole.
  {
    const pts: [number, number, number][] = [
      [0.0335, -0.0300, -0.0620],
      [0.0370, -0.0390, -0.0790],
      [0.0405, -0.0470, -0.0960],
      [0.0435, -0.0540, -0.1120],
    ];
    out.push({
      geo: setTubeUV(
        tube(pts, 0.0270, 4, d.ring, (t) => 1 - 0.06 * t),
        GLOVE_PANEL.field, 1,
      ),
      accent: false,
    });
    // The cuff proper: a ribbed elastic band bound over the end of the sleeve,
    // in the team's accent. Slightly proud of the wrist it sits on.
    out.push({
      geo: setTubeUV(
        tube([
          [0.0385, -0.0420, -0.0850],
          [0.0410, -0.0475, -0.0970],
          [0.0432, -0.0530, -0.1090],
        ], 0.0300, 4, d.ring, (t) => 1 + 0.05 * Math.sin(t * Math.PI)),
        GLOVE_PANEL.cuff, 1,
      ),
      accent: true,
    });
  }

  return out;
}

// ===========================================================================
// The wheel's own dash display
// ===========================================================================

/**
 * The little screen in the middle of the wheel.
 *
 * Drawn into a canvas rather than assembled from meshes: it is a screen, so a
 * texture is not a cheat, and fifteen individually-lit LED quads would cost more
 * than the whole rest of the cockpit. Redrawn only when a displayed value
 * actually changes, which at a steady speed is a handful of times a second.
 */
class WheelDash {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private lastKey = '';

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 176;
    this.ctx = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw({
      steerRad: 0, gearLabel: 'N', speedKph: 0, rpmFraction: 0,
      drsOpen: false, ersPercent: 0,
    });
  }

  update(s: CockpitState): void {
    const lit = Math.round(clamp01((s.rpmFraction - 0.45) / 0.55) * 15);
    const key = s.gearLabel + '|' + Math.round(s.speedKph) + '|' + lit + '|' +
      (s.drsOpen ? '1' : '0') + '|' + Math.round(s.ersPercent * 10);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(s);
    this.texture.needsUpdate = true;
  }

  private draw(s: CockpitState): void {
    const c = this.ctx;
    const W = 320, H = 176;

    c.fillStyle = '#05070b';
    c.fillRect(0, 0, W, H);

    // Shift lights across the top: green, amber, red, flashing at the limiter.
    const frac = s.rpmFraction;
    const lit = Math.round(clamp01((frac - 0.45) / 0.55) * 15);
    const limiter = frac > 0.985;
    for (let i = 0; i < 15; i++) {
      const on = limiter ? true : i < lit;
      const band = i < 7 ? '#2ee36a' : i < 12 ? '#ffb02e' : '#ff3b3b';
      c.fillStyle = on ? (limiter ? '#ffffff' : band) : '#161a21';
      const x = 12 + i * 19.6;
      c.fillRect(x, 10, 15, 13);
    }

    // Gear, centre and enormous — the one thing read in peripheral vision.
    c.fillStyle = '#ffffff';
    c.font = '700 92px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(s.gearLabel, W * 0.5, 96);

    // Speed on the left, ERS store on the right.
    c.font = '700 34px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'left';
    c.fillStyle = '#dfe6f2';
    c.fillText(String(Math.round(s.speedKph)), 12, 92);
    c.font = '700 15px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#7d879a';
    c.fillText('KMH', 12, 116);

    c.textAlign = 'right';
    c.font = '700 30px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#ffd83d';
    c.fillText(Math.round(s.ersPercent * 100) + '%', W - 12, 92);
    c.font = '700 15px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#7d879a';
    c.fillText('ERS', W - 12, 116);

    // DRS bar along the bottom.
    c.fillStyle = s.drsOpen ? '#3ddc84' : '#141821';
    c.fillRect(12, 138, W - 24, 26);
    c.fillStyle = s.drsOpen ? '#06210f' : '#3c4655';
    c.font = '800 17px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('D R S', W * 0.5, 152);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ===========================================================================
// Assembly
// ===========================================================================

/**
 * Builds the cockpit furniture for one car.
 *
 * @param accentColour the team's accent, used for the glove cuffs and the wheel
 *                     grip flashes so the view is liveried like the car is.
 */
export function buildCockpit(accentColour: number): CockpitVisual {
  const root = new THREE.Group();
  root.name = 'cockpit';
  root.visible = false;
  // Never let the cockpit cast shadows onto the road: it is inches from the
  // camera and would produce a large, obviously wrong smear on the track.
  root.matrixAutoUpdate = true;

  const owned: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => { owned.push(g); return g; };
  const mat = <T extends THREE.Material>(m: T): T => { materials.push(m); return m; };

  // The cockpit surround, the wheel frame and the dash are all bare laminate,
  // and they are the surfaces closest to the camera in the view most of the
  // game is played from. A flat dark grey at half a metre reads as painted
  // board; the weave is what makes it read as a moulded composite tub.
  //
  // Metalness 0.05, not 0.35. Carbon is resin over black cloth. At a third
  // metallic it borrows the environment's colour and comes out looking like
  // sandblasted aluminium, which is exactly what the cockpit used to look like.
  const carbonWeave = buildCarbonTexture();
  // Box and cylinder UVs run 0..1 per face whatever the face's real size, so
  // the repeat is a compromise across parts from 50mm to 600mm across. Four
  // tiles of an eight-cell weave puts the cell somewhere between 1.5 and 20mm,
  // which reads correctly over the whole range at cockpit distance.
  carbonWeave.map.repeat.set(4, 4);
  carbonWeave.surface.repeat.set(4, 4);
  const carbon = mat(new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: carbonWeave.map,
    roughnessMap: carbonWeave.surface,
    metalnessMap: carbonWeave.surface,
    // Well under 1, because the cockpit is a hole. The environment probe is a
    // full sphere of unoccluded sky and floodlight, and a tub whose opening is
    // a slot between the halo and the rim sees almost none of it — applying the
    // probe at full strength put a blown white highlight across the dash and
    // the wheel that no real onboard shot has. Screen-space AO cannot correct
    // this: it darkens the diffuse result, not the specular lobe.
    metalness: 1, roughness: 1, envMapIntensity: 0.45,
  }));
  const rubberGrip = mat(new THREE.MeshStandardMaterial({
    color: 0x0a0b0e, metalness: 0.0, roughness: 0.88, envMapIntensity: 0.4,
  }));
  // Nomex. The map is the whole reason this is a separate material from the
  // rest of the dark furniture: at 500mm a flat surface at roughness 0.72 is
  // moulded rubber whatever colour it is, and cloth is the one thing the eye
  // identifies by its fine relief rather than by its shade. `normalScale` is
  // well under one because the map was authored with the pads and the ribbing
  // at full strength and the knit is a tenth of their depth.
  const gloveNormal = gloveNomexMap();
  const glove = mat(new THREE.MeshStandardMaterial({
    color: 0x1b1e26, metalness: 0.0, roughness: 0.82, envMapIntensity: 0.55,
    normalMap: gloveNormal,
    normalScale: new THREE.Vector2(0.85, 0.85),
  }));
  const accent = mat(new THREE.MeshStandardMaterial({
    color: accentColour, metalness: 0.2, roughness: 0.5, envMapIntensity: 0.9,
  }));
  // The cuff is the same cloth in the team's colour, so it takes the same map.
  const cuffAccent = mat(new THREE.MeshStandardMaterial({
    color: accentColour, metalness: 0.0, roughness: 0.78, envMapIntensity: 0.6,
    normalMap: gloveNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
  }));
  // A mirror is a mirror because it reflects: a fully metallic, near-zero
  // roughness surface picks up the environment map and reads instantly as glass,
  // where a flat grey quad reads as a sticker.
  const mirrorGlass = mat(new THREE.MeshStandardMaterial({
    color: 0xc8d2e0, metalness: 1.0, roughness: 0.045, envMapIntensity: 2.4,
  }));

  const add = (geo: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = root): THREE.Mesh => {
    const m = new THREE.Mesh(track(geo), material);
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  };

  // --- Cockpit rim padding ------------------------------------------------
  // The dark bolsters either side of the driver. They occupy the bottom corners
  // of the frame and are most of what makes the view feel enclosed.
  //
  // Padding is padding: it is upholstery over foam and it has no sharp edge
  // anywhere on it. As a box it occupied the bottom corners of the frame with
  // two dead-straight highlights, which is the first thing the eye reads in an
  // onboard shot. Lofted with a strongly rounded section, tapering forward, as
  // the coaming does.
  //
  // MOVED INBOARD, from x 0.30 to the real coaming. These were placed against a
  // monocoque whose "cockpit opening" was a solid deck, so they were free to
  // sit anywhere on it and were put where they framed the shot. The tub now has
  // an actual lip — `COCKPIT_APERTURE` in CarMesh puts it at 68 per cent of the
  // half-width, which is x 0.227..0.234 over this stretch — and padding that
  // does not sit on it is two bolsters floating out on the bodywork.
  for (const side of [-1, 1] as const) {
    const pad = loft([
      section(0.440, 0.0300, 0.5620, 0.6060, 0.80, { xc: side * 0.2245 }),
      section(0.240, 0.0340, 0.5680, 0.6120, 0.80, { xc: side * 0.2295 }),
      section(-0.020, 0.0340, 0.5740, 0.6180, 0.78, { xc: side * 0.2325 }),
      section(-0.180, 0.0275, 0.5820, 0.6230, 0.85, { xc: side * 0.2320 }),
    ], SEG.loftRing, true, SEG.loftStep);
    add(pad, carbon);
  }
  // Dash bulkhead ahead of the driver, where the column comes through. The tub
  // has necked down to a rim height of about 0.556 by here.
  {
    // Twelve millimetres lower at the lip than it was. The tub has necked down
    // to a rim height of about 0.556 here, so a bulkhead topping out at 0.574
    // still stands proud of it the way a real dash lip does — and every
    // millimetre taken off the top of it is a millimetre of road handed back at
    // the bottom of the frame, which is the whole exercise.
    const dash = loft([
      section(0.650, 0.250, 0.522, 0.574, 0.45),
      section(0.700, 0.250, 0.522, 0.574, 0.42),
      section(0.750, 0.238, 0.525, 0.571, 0.55),
    ], SEG.loftRing, true, SEG.loftStep);
    add(dash, carbon);
    // Steering column, running forward and down from the back of the wheel.
    add(strut(0, WHEEL_Y - 0.065, 0.607, 0, 0.556, 0.70, 0.026), carbon);
  }

  // --- Mirrors ------------------------------------------------------------
  // The stalk and the housing are part of the shell (see CarMesh) because every
  // car needs them. What only the driver needs is the reflection: a fully
  // metallic, near-zero-roughness pane picks up the environment map and reads
  // instantly as glass, where the shell's flat dark swatch reads as a sticker.
  // It is laid a couple of millimetres proud of the shell's pane so it wins the
  // depth test without z-fighting.
  const mirrorPanes: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    // The glass angle is SOLVED, not dialled in: see MIRROR_TARGET_*. A
    // hand-set yaw was right for an eye point inside the helmet and is wrong
    // for one up on the roll hoop 0.42m higher and 0.65m further back, and
    // pointing the pane at the eye instead — the obvious repair — makes it a
    // retroreflector. Bisecting keeps working wherever the eye goes next.
    // 112 by 42, up from 100 by 38 and still inside the housing the shell
    // builds around it (116 by 46). A real F1 mirror's reflective area is
    // nearer 150 by 50; ours was small even for the small one, and the pane is
    // between 47 and 86 pixels across in a 1280-wide frame with the halo over
    // part of it, so every millimetre of it is a millimetre of the only thing
    // in the shot that answers "is anybody behind me".
    const glass = new THREE.PlaneGeometry(0.112, 0.042);
    const g = add(glass, mirrorGlass);
    g.position.set(side * MIRROR_X, MIRROR_Y, MIRROR_GLASS_Z - 0.003);
    const toEye = new THREE.Vector3(
      EYE_X - side * MIRROR_X,
      EYE_Y - MIRROR_Y,
      EYE_Z - MIRROR_GLASS_Z,
    ).normalize();
    const toRoad = new THREE.Vector3(
      side * MIRROR_TARGET_X - side * MIRROR_X,
      MIRROR_TARGET_Y - MIRROR_Y,
      MIRROR_TARGET_Z - MIRROR_GLASS_Z,
    ).normalize();
    g.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      toEye.add(toRoad).normalize(),
    );
    mirrorPanes.push(g);
  }

  // --- Steering wheel -----------------------------------------------------
  // pivot holds the position and rake; spin is the only thing that rotates with
  // steering input, so the rake never contaminates the steering axis.
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(WHEEL_X, WHEEL_Y, WHEEL_Z);
  wheelPivot.rotation.x = WHEEL_TILT;
  root.add(wheelPivot);

  const wheelSpin = new THREE.Group();
  wheelPivot.add(wheelSpin);

  const dash = new WheelDash();

  {
    // A modern F1 wheel is a squared-off frame, not a circle: two vertical
    // grips, a broad centre column carrying the display, and flat top and
    // bottom bars. Two rounded-rect holes cut in a rounded-rect outline give
    // exactly that silhouette in one extrusion.
    const shape = new THREE.Shape();
    roundedRect(shape, -WHEEL_HALF_W, -WHEEL_HALF_H, WHEEL_HALF_W * 2, WHEEL_HALF_H * 2, 0.042);
    const holeL = new THREE.Path();
    roundedRect(holeL, -0.107, -0.055, 0.067, 0.110, 0.025);
    const holeR = new THREE.Path();
    roundedRect(holeR, 0.040, -0.055, 0.067, 0.110, 0.025);
    shape.holes.push(holeL, holeR);

    const rim = new THREE.ExtrudeGeometry(shape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.006,
      bevelSegments: 4,
      curveSegments: SEG.rimCurve,
    });
    rim.translate(0, 0, -0.015);
    // ExtrudeGeometry is non-indexed and normals it. Every rounded corner of
    // the outline and of the two cut-outs therefore came out as a fan of flat
    // facets: the wheel had a visibly polygonal edge from twenty inches away,
    // and adding curve segments alone would only have made it a finer polygon.
    // Angle-based smoothing averages across the corner radii and leaves the
    // 90-degree meeting of the face and the edge hard, which is exactly what a
    // smoothing group is for.
    add(creased(rim, 32), carbon, wheelSpin);

    // Rubber grips over the two uprights, with an accent flash at the top of
    // each — the same trick a real team uses to mark the straight-ahead point.
    for (const side of [-1, 1] as const) {
      const grip = new THREE.CylinderGeometry(0.022, 0.022, 0.112, SEG.round);
      grip.translate(side * GRIP_X, -0.004, 0);
      add(grip, rubberGrip, wheelSpin);
      const flash = roundedBlock(0.046, 0.013, 0.046, 0.005);
      flash.translate(side * GRIP_X, 0.059, 0);
      add(flash, accent, wheelSpin);
    }
    // Straight-ahead marker at 12 o'clock.
    {
      const mark = roundedBlock(0.021, 0.012, 0.032, 0.004);
      mark.translate(0, 0.093, -0.012);
      add(mark, accent, wheelSpin);
    }

    // Shift paddles, on the far side of the rim from the driver.
    for (const side of [-1, 1] as const) {
      const paddle = roundedBlock(0.015, 0.074, 0.052, 0.006);
      paddle.translate(side * 0.089, -0.005, 0.042);
      const p = add(paddle, carbon, wheelSpin);
      p.rotation.y = side * 0.22;
    }

    // The display, facing the driver (-z in wheel space).
    // Sits proud of the rim's bevelled face, or the extrusion swallows it.
    const dashPlane = new THREE.PlaneGeometry(0.078, 0.044);
    dashPlane.rotateY(Math.PI);
    dashPlane.translate(0, 0.019, -0.026);
    const dashMat = mat(new THREE.MeshBasicMaterial({ map: dash.texture, toneMapped: false }));
    add(dashPlane, dashMat, wheelSpin);

    // A row of rotary switches under the screen, because a bare panel looks
    // like a placeholder and these cost four triangles each.
    for (let i = 0; i < 3; i++) {
      const knob = new THREE.CylinderGeometry(0.011, 0.013, 0.014, SEG.round);
      knob.rotateX(Math.PI / 2);
      knob.translate(-0.029 + i * 0.029, -0.053, -0.021);
      add(knob, rubberGrip, wheelSpin);
    }
  }

  // --- Hands --------------------------------------------------------------
  // Parented to the spin group: a driver's hands do not slide around the rim in
  // the ninety degrees of lock an F1 car has, so they turn with it.
  //
  // Built once for the right and MIRRORED for the left. See `handParts`.
  {
    const right = buildHandParts(COCKPIT_HAND);
    for (const side of [-1, 1] as const) {
      const hand = new THREE.Group();
      hand.position.set(side * HAND_X, HAND_Y, 0);
      wheelSpin.add(hand);
      for (const part of right) {
        add(side > 0 ? part.geo : mirroredX(part.geo), part.accent ? cuffAccent : glove, hand);
      }
    }
  }

  // The halo, the roll hoop and the driver's own body are NOT built here. They
  // live on the shared shell (see CarMesh and DriverMesh), because they have to
  // be there for the outside views anyway, and two of anything in the same place
  // would z-fight. What the cockpit adds is only what nobody can see from
  // outside: a mirror that actually reflects, a wheel with a live dash, and the
  // hands on it.

  const dashRef = dash;

  // --- Live mirror feeds ---------------------------------------------------
  //
  // "The mirrors on the cars should actually be doing something. If a car is
  // behind you and is trying to pass you should be able to see it." An
  // environment-mapped pane cannot do that: the probe is a sky and a ground and
  // it has never heard of the other nineteen cars. The only thing that shows
  // traffic is a second render of the actual scene.
  //
  // Three things keep that affordable:
  //
  //  - ONE mirror per frame. They alternate, so each pane refreshes at half the
  //    frame rate. At 60fps that is 30Hz into a pane twenty-five pixels wide,
  //    which nobody can tell from 60, and the cost is one extra scene render
  //    per frame rather than two.
  //  - A SMALL, SHORT frustum. 256x96 is a thirty-seventh of the pixels of a
  //    1280x720 frame, and a 200m far plane frustum-culls most of the circuit
  //    before a draw call is issued.
  //  - NO SHADOW PASS. Shadow map regeneration is disabled around the mirror
  //    render, so it reuses the map the previous frame built. A shadow drawn
  //    one frame late, in a mirror, is not observable.
  //
  // Allocation is lazy, so the low tier and every session that never selects
  // the cockpit pay nothing.
  const mirrorTargets: THREE.WebGLRenderTarget[] = [];
  const mirrorCams: THREE.PerspectiveCamera[] = [];
  let mirrorFrame = 0;
  const mDir = new THREE.Vector3();
  const mNormal = new THREE.Vector3();
  const mPos = new THREE.Vector3();
  const mLook = new THREE.Vector3();

  const initMirrors = (): void => {
    for (let i = 0; i < mirrorPanes.length; i++) {
      const target = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H, {
        // Half float, so a floodlight or a brake disc in the mirror carries the
        // same radiance it does everywhere else and reaches the bloom pass as
        // something above white rather than clipped to it.
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      // A mirror reverses handedness, and a camera pointed backwards does not.
      // Flipping u is the whole of the difference between a mirror and a
      // reversing camera, and getting it wrong sends a car that is passing on
      // the left to the right of the pane.
      target.texture.wrapS = THREE.ClampToEdgeWrapping;
      target.texture.repeat.x = -1;
      target.texture.offset.x = 1;
      mirrorTargets.push(target);

      const cam = new THREE.PerspectiveCamera(MIRROR_FOV, MIRROR_W / MIRROR_H, 0.3, MIRROR_FAR);
      mirrorCams.push(cam);

      // The pane stops being a reflective swatch and becomes a screen. Basic,
      // not standard: the feed is already a fully lit render of the world and
      // lighting it a second time would be wrong twice over.
      const m = mat(new THREE.MeshBasicMaterial({ map: target.texture }));
      mirrorPanes[i].material = m;
    }
  };

  return {
    root,
    renderMirrors(renderer, scene, eye, stride): void {
      if (!root.visible) return;
      if (mirrorTargets.length === 0) initMirrors();

      // Skipped frames still leave the last feed on the pane, so a mirror that
      // is only redrawn every third frame shows a slightly stale car rather
      // than an empty one.
      const tick = mirrorFrame++;
      if (stride > 1 && tick % stride !== 0) return;
      const i = Math.floor(tick / Math.max(1, stride)) % mirrorPanes.length;
      const pane = mirrorPanes[i];
      pane.updateWorldMatrix(true, false);
      pane.getWorldPosition(mPos);
      // The pane's local +z was aimed at the eye when it was built, so its world
      // +z axis IS the mirror's normal — no separate bookkeeping to drift.
      pane.getWorldDirection(mNormal);

      // Reflect the eye's line of sight about the mirror plane. A car mirror is
      // not a portal: what it shows is where a ray from your eye goes after it
      // bounces, and that is a different direction from "backwards" by however
      // much the pane is toed in.
      mDir.copy(mPos).sub(eye.position).normalize();
      mDir.addScaledVector(mNormal, -2 * mDir.dot(mNormal));
      mLook.copy(mPos).add(mDir);

      const cam = mirrorCams[i];
      cam.position.copy(mPos);
      cam.up.set(0, 1, 0);
      cam.lookAt(mLook);
      cam.updateMatrixWorld();

      // Both panes come out, not just this one: the other is textured with a
      // render target of its own and sampling one while writing the other is
      // fine, but sampling THIS one while writing it is undefined.
      for (const p of mirrorPanes) p.visible = false;
      const prevTarget = renderer.getRenderTarget();
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(mirrorTargets[i]);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prevTarget);
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      for (const p of mirrorPanes) p.visible = true;
    },
    setVisible(v: boolean): void {
      if (root.visible !== v) root.visible = v;
    },
    update(state: CockpitState): void {
      if (!root.visible) return;
      // 3:1 rack, signed to match the road wheels.
      //
      // The road wheels take `rotation.y = -steer`, which points them at a
      // heading of (car heading - steer): a positive steer input is a RIGHT
      // turn. The wheel's own +z axis points at the nose, so the driver is
      // looking down it, and a positive rotation about it carries the rim's
      // twelve o'clock to the driver's right. Same sign, therefore, as the
      // steer input itself.
      wheelSpin.rotation.z = state.steerRad * RACK_RATIO;
      dashRef.update(state);
    },
    dispose(): void {
      for (const g of owned) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of mirrorTargets) t.dispose();
      mirrorTargets.length = 0;
      dashRef.dispose();
    },
  };
}
