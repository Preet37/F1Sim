import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/MathUtils';
import {
  DRIVER_EYE_PITCH, DRIVER_EYE_X, DRIVER_EYE_Y, DRIVER_EYE_Z,
  EYE_PITCH, EYE_X, EYE_Y, EYE_Z,
} from './CockpitMesh';
import { bankedCarGroundY, roadPoseUnderCar } from './TrackMesh';
import { newSurfacePose } from './CarAttitude';
import { nominalBarrierOffset, OBSTACLE_HEIGHT_M } from '../track/WorldObstacles';
import type { CarEntry } from '../race/CarEntry';
import type { TrackSpline } from '../track/TrackSpline';
import type { WorldModel } from '../track/WorldObstacles';

/**
 * Camera work.
 *
 * A racing camera has one job that matters above framing: convey speed honestly.
 * Two things do that, and both are implemented here rather than being faked with
 * post-processing — the field of view widens with speed, and the camera lags
 * behind the car's motion instead of being welded to it. A camera rigidly parented
 * to the car makes 300km/h feel like 80.
 *
 * All smoothing is exponential and frame-rate independent, so the camera behaves
 * the same at 30fps on a phone and 120fps on a desktop.
 */

export type CameraMode =
  | 'chase'
  | 'driver'
  | 'cockpit'
  | 'onboard-t'
  | 'bumper'
  | 'tv'
  | 'drone'
  | 'trackside';

/**
 * Minimum camera height above the road surface, metres.
 *
 * Low enough that the cockpit and bumper cameras are unaffected in normal use,
 * high enough that the camera can never end up underneath the track.
 */
const MIN_CAMERA_HEIGHT_M = 0.35;

/**
 * Near plane, per mode.
 *
 * The cockpit still needs a closer plane than anything else — the airbox crown
 * passes about 300mm under the lens — but not the 0.08 it needed when the eye
 * was down in the tub with the steering wheel 400mm away. 0.12 clears the
 * nearest thing on the car by a factor of two and buys back the depth precision
 * a near plane that close spends.
 */
const NEAR_COCKPIT = 0.12;
const NEAR_DEFAULT = 0.35;
/**
 * The driver's-eye camera's near plane, and it is doing a JOB rather than
 * setting a limit.
 *
 * The eye sits 15mm in front of the visor, and the helmet is merged into the
 * shared car shell so it cannot be hidden for one car in one view — see
 * `DRIVER_EYE_Y` for why. Every part of that helmet is within 25mm of the eye
 * plane, so a near plane anywhere above about 0.03 clips the whole head and
 * nothing has to be hidden at all. 0.12 keeps it clipped through the full range
 * of head movement below and still clears the nearest thing the driver is meant
 * to SEE — the wheel rim, at 0.37m — by a factor of three.
 */
const NEAR_DRIVER = 0.12;

/**
 * Field of view, per mode: the resting angle and how much it opens at speed.
 *
 * THESE ARE VERTICAL ANGLES. three.js takes a vertical FOV, and that is the
 * thing this file had wrong: the old figures — 56 for the chase, 76 for the
 * bumper, plus fourteen degrees at speed — are perfectly sensible HORIZONTAL
 * numbers and were obviously picked as such. Used as vertical angles on a 16:9
 * display they come out at 102 and 121 degrees ACROSS. That is a fisheye, and it
 * is the whole reason the car was a speck in the middle of the chase shot, the
 * barriers bowed, and every mode felt like it was filmed through a door viewer.
 *
 * Widening with speed stays, because it is the most honest way to convey speed
 * and costs nothing. The swing is now a few degrees rather than fourteen; past
 * about eight the frame visibly breathes and it reads as a zoom effect rather
 * than as going faster.
 */
const FOV: Record<CameraMode, { base: number; gain: number }> = {
  // ~63 degrees across at 16:9, opening to ~71. A normal lens: the car keeps a
  // believable size and straight things stay straight.
  chase: { base: 39, gain: 6 },
  // Narrower than it was, and deliberately.
  //
  // A wide lens used to be the way to get road into the cockpit shot. From the
  // roll hoop it is the opposite: widening reaches back up over the halo and
  // pulls the arc into the middle of the frame, which was measured across six
  // candidate lenses. 40 to 45 degrees vertical — 66 to 73 across at 16:9 — is
  // where the horizon sits above centre, the halo hugs the bottom, and straight
  // things stay straight.
  // 38, not 40, and the two onboards are deliberately no longer the same lens.
  // The cockpit eye now sits 0.58m behind the helmet and the T-cam 0.80m; with
  // one focal length between them the two modes were the same photograph and
  // the second button did nothing. A slightly longer lens on the closer camera
  // is also what makes it the tighter, more enclosed of the pair.
  cockpit: { base: 38, gain: 5 },
  'onboard-t': { base: 43, gain: 6 },
  // The one lens in this file that is deliberately WIDE, and the one where wide
  // is not a mistake.
  //
  // Every other mode here is a camera, and the note above is about camera
  // lenses. This mode is an EYE. A human's attentive field is around ninety
  // degrees across and their useful one far more; a driver picks a rival up in
  // a mirror, reads a kerb at the edge of the road and looks through a corner
  // without moving their head, and none of that survives being shot through a
  // 63-degree broadcast lens. 62 vertical is 96 degrees across on 16:9 and 107
  // on a 2.17:1 phone, which is the widest this file goes. It is a rectilinear
  // projection, so straight things are still straight; what it costs is a
  // little apparent scale, and what it buys is the peripheral field that is the
  // entire difference between an eye and a lens.
  //
  // It is also load-bearing for the mirrors, which is a stronger constraint
  // than taste, and it is what set the number. The panes sit 39 degrees off
  // this eye's axis and their outboard corners 42.3; on 16:9 that corner is
  // outside the frame at anything under about 57 vertical and still touching
  // the edge at 60. `probe:framing` asserts it, in both frame shapes, on all
  // eleven circuits — a driver's view whose mirrors are off the side of the
  // screen answers the wrong half of the request. The 2.17:1 phone, which is
  // the shape the report came from, is not the binding case: it carries them at
  // 73 to 89 per cent of frame width.
  driver: { base: 62, gain: 4 },
  // Lowest camera, so the widest: at 0.44m the ground shear does the work and a
  // wide lens amplifies it.
  bumper: { base: 47, gain: 7 },
  // Broadcast follow. A long lens is what makes a TV shot read as a TV shot —
  // it compresses the background and makes the car the subject.
  tv: { base: 27, gain: 4 },
  drone: { base: 31, gain: 3 },
  // Unused: the trackside camera zooms to hold the car, below.
  trackside: { base: 24, gain: 0 },
};

/**
 * The driver's neck, and its budget.
 *
 * Head movement is the one thing in this file that can make a player ill, and
 * the failure mode is specific: a view that moves when the player did not ask
 * it to, at a rate the inner ear expects to feel and does not. So every number
 * here is bounded rather than merely damped, and the bounds are small enough
 * that the whole rig can be at full deflection in both axes at once and still
 * be inside what a real head does in a real car.
 *
 * WHAT THE LIMITS COME TO, together, at 5g of lateral load and 5g of braking:
 * 14 degrees of look-ahead yaw, 2.3 degrees of lean on top of 3.4 of chassis
 * roll, and 18mm of translation. The translation is the one worth stating in
 * angles, because that is how it is seen: 18mm at the steering wheel, 0.37m
 * away, is 2.8 degrees of apparent shift, and at the halo crown 0.59m away it
 * is 1.7. Both are under the 4-degree single-frame swing that `probe:reverse`
 * calls jitter — and they are reached over a quarter of a second rather than in
 * one frame, which is what `rate` is for.
 *
 * MEASURED, not asserted. `npm run probe:reverse` drives the real physics
 * backwards and forwards through a standstill while sawing at the wheel and
 * counts how often each camera reverses its yaw direction and how far it swings
 * in a frame; the driver's eye is in `CAMERA_MODES`, so it is held to the same
 * two-reversals-a-second and four-degrees-a-frame limits as everything else.
 * `npm run probe:framerate` covers the other half — every term below goes
 * through `damp`, so the head reaches the same place at 30fps and at 120.
 */
const DRIVER_HEAD = {
  /** Fraction of the road's heading change the head takes up. */
  lookGain: 0.34,
  /** Hard cap on that, radians. 14 degrees. */
  lookMax: 0.245,
  /** How fast the head turns toward where it wants to look, per second. */
  lookRate: 2.4,
  /** Extra roll per g of lateral load, radians. */
  leanPerG: 0.008,
  /** Hard cap on the lean, radians. 2.3 degrees. */
  leanMax: 0.040,
  /** Eye translation per g, metres. */
  shiftPerG: 0.0045,
  /** Hard cap on the translation, metres. */
  shiftMax: 0.018,
  /** Damping rate for the lean and the translation, per second. */
  rate: 6,
} as const;

/**
 * Height of the frame the trackside camera tries to fill with the car, metres.
 *
 * A real trackside operator holds the car at a roughly constant size as it
 * approaches and goes past, which is what makes the shot feel operated rather
 * than mounted.
 */
const TRACKSIDE_FRAMED_M = 5.0;

/**
 * How far clear of a solid object a camera is pulled, metres.
 *
 * Enough that the near plane never ends up on the wrong side of a face — the
 * default near plane is 0.35m, and a wall a hand's width in front of the lens
 * fills the frame with an untextured slab whether or not the lens is technically
 * outside it.
 */
const SOLID_CLEARANCE_M = 0.45;
/**
 * How fast the camera is allowed to drift back out once the way is clear, in
 * exponential-decay units per second.
 *
 * The pull-in itself is NOT rate-limited, and that asymmetry is the whole
 * design. Going in has to be immediate, because the alternative to being
 * immediate is a frame of being inside a building. Coming out has to be slow,
 * because that is the half of it the eye can see: a camera that snaps back to
 * its resting distance the instant the pit wall ends reads as a cut. Going in
 * is invisible anyway — it happens continuously as the camera approaches, since
 * the object is treated as inflated by the clearance above and the depth grows
 * smoothly from zero as the lens crosses that inflated boundary.
 */
const SOLID_RELEASE_RATE = 2.2;
/** Closest to the car the camera may ever be dragged, as a fraction of the way. */
const SOLID_MAX_PULL = 0.9;

export const CAMERA_MODES: readonly CameraMode[] = [
  'chase', 'driver', 'cockpit', 'onboard-t', 'bumper', 'tv', 'drone', 'trackside',
];

/**
 * The modes whose camera is ON the car, looking out over the driver.
 *
 * Three of them are: the driver's eye sits behind the visor, the cockpit eye on
 * the front of the roll-hoop fairing and the T-cam on top of it. That makes
 * them the same case for three separate decisions that used to be written for
 * 'cockpit' alone, and the T-cam was wrong on all three — it drew the camera
 * pod it is itself mounted in, it had no cockpit interior so its mirrors were
 * dead swatches, and it used the far near-plane with the driver's helmet inside
 * it. Anything that asks "is the camera inside the car" asks this, and the
 * driver's eye needs all three answers as much as either of them: it is the
 * view with the most cockpit furniture in it and the one the mirrors are
 * nearest to.
 */
export function isOnboardMode(mode: CameraMode): boolean {
  return mode === 'driver' || mode === 'cockpit' || mode === 'onboard-t';
}

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  driver: 'Driver',
  cockpit: 'Cockpit',
  'onboard-t': 'Onboard T-Cam',
  bumper: 'Bumper',
  tv: 'TV',
  drone: 'Drone',
  trackside: 'Trackside',
};

/**
 * How far along `(dx, dz)` a point has to travel to leave an obstacle, in plan.
 *
 * Zero when the point is already outside it. The box is inflated by `margin`
 * first, which is what makes the answer a CONTINUOUS function of position — the
 * distance grows from zero as the point crosses the inflated boundary rather
 * than jumping to a finite value the moment it touches the real one. A camera
 * approaching a wall is therefore eased away from it over the last `margin` of
 * its approach, and nothing pops.
 *
 * The obstacle's frame is the one used everywhere else: `(cos, sin)` maps a
 * world vector into the box's local axes, local X across it and local Z along.
 */
function exitDistance(
  o: { x: number; z: number; cos: number; sin: number; halfX: number; halfZ: number },
  x: number, z: number, dx: number, dz: number, margin: number,
): number {
  const rx = x - o.x;
  const rz = z - o.z;
  const pu = rx * o.cos - rz * o.sin;
  const pv = rx * o.sin + rz * o.cos;
  const hu = o.halfX + margin;
  const hv = o.halfZ + margin;
  if (Math.abs(pu) >= hu || Math.abs(pv) >= hv) return 0;   // already outside

  const du = dx * o.cos - dz * o.sin;
  const dv = dx * o.sin + dz * o.cos;
  // Time to the far face on each axis; leaving the box means leaving the
  // intersection of the two slabs, so the first face reached is the exit.
  const tu = Math.abs(du) < 1e-6 ? Infinity : ((du > 0 ? hu : -hu) - pu) / du;
  const tv = Math.abs(dv) < 1e-6 ? Infinity : ((dv > 0 ? hv : -hv) - pv) / dv;
  const t = Math.min(tu, tv);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';

  /** Vertical shake amplitude, driven by kerbs and lock-ups. */
  private shake = 0;
  private shakePhase = 0;

  private readonly desired = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly smoothedPos = new THREE.Vector3();
  private readonly smoothedLook = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** Offsets relative to the car, which is what actually gets smoothed. */
  private readonly desiredOffset = new THREE.Vector3();
  private readonly lookOffset = new THREE.Vector3();
  private readonly smoothedOffset = new THREE.Vector3();
  private readonly smoothedLookOffset = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  /** Scratch for the cockpit eye offset and the chassis attitude it rides on. */
  private readonly eye = new THREE.Vector3();
  private readonly carEuler = new THREE.Euler();
  /** Scratch for `aimFromCar`. */
  private readonly qCar = new THREE.Quaternion();
  private readonly qNeck = new THREE.Quaternion();
  private readonly neckEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private initialised = false;

  /** Smoothed speed, so FOV does not flicker on gear changes. */
  private smoothSpeed = 0;
  /** Cockpit rig: damped head turn into the corner, and chassis attitude. */
  private headYaw = 0;
  private rigRoll = 0;
  private rigPitch = 0;
  /**
   * The damped BODY LEAN alone, kept apart from the total in `rigRoll`.
   *
   * The chassis attitude is two things added together: the road's, which is
   * exact and undamped, and the body's on its suspension, which is damped at
   * 8/s. `rigRoll`/`rigPitch` carry the sum because that is what the eye rides
   * and what `probe:framing` has to project the halo through; these carry the
   * half that has an accumulator. Same split, same reasons, and the same
   * 8/s, as `Renderer.leanRoll`. Issue #71.
   */
  private leanRoll = 0;
  private leanPitch = 0;
  /** Scratch for the road's attitude under the car being followed. */
  private readonly surfacePose = newSurfacePose();
  /**
   * Driver's-eye rig: how far the head has fallen away from the chassis.
   *
   * A neck, in three numbers. `headLean` is a roll, `headShiftX` and
   * `headShiftZ` are the eye sliding in its socket under lateral and
   * longitudinal load. All three are damped, all three are tiny, and the
   * budget for all three together is in `DRIVER_HEAD` below.
   */
  private headLean = 0;
  private headShiftX = 0;
  private headShiftZ = 0;
  /** Chase camera bank, radians. See the chase case in `update`. */
  private bank = 0;
  /**
   * How far round the reverse view is, 0 (following) to 1 (facing back).
   * See `reverseTarget`.
   */
  private reverse = 0;
  private reverseLatch = false;
  /** Trackside camera state: which anchor it is currently using. */
  private tracksideAnchorS = 0;
  private tracksideSide = 1;
  /** Drone orbit angle. Separate from the shake phase, which runs 250x faster. */
  private dronePhase = 0;
  /**
   * How far the camera is currently drawn in toward the car to stay out of
   * solid geometry, as a fraction of the distance between the two.
   */
  private solidPull = 0;
  /** Scratch for the obstacle broadphase, reused so the frame allocates nothing. */
  private readonly solidHits: number[] = [];

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV.chase.base, aspect, NEAR_DEFAULT, 4000);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  cycleMode(delta = 1): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    const next = (i + delta + CAMERA_MODES.length) % CAMERA_MODES.length;
    this.mode = CAMERA_MODES[next];
    // Force a re-seat so the camera does not sweep across the circuit.
    this.initialised = false;
    this.solidPull = 0;
    this.applyNearPlane();
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.initialised = false;
    this.solidPull = 0;
    this.applyNearPlane();
  }

  /** An onboard camera sits inside its own bodywork and needs a closer near plane. */
  private applyNearPlane(): void {
    const near = this.mode === 'driver' ? NEAR_DRIVER
      : isOnboardMode(this.mode) ? NEAR_COCKPIT : NEAR_DEFAULT;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Updates the camera for this frame.
   * @param dt real frame time, seconds
   * @param world the solid world, so the camera can stay out of it. Optional
   *              only because a caller without one (the track preview) still has
   *              a camera; a caller in a session always has one and passes it.
   */
  update(dt: number, car: CarEntry, track: TrackSpline, world?: WorldModel): void {
    const p = car.physics;
    const speed = p.speedMs;
    this.smoothSpeed = damp(this.smoothSpeed, speed, 3, dt);

    const heading = car.renderHeading;
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);

    // Chassis attitude, every frame and in every mode.
    //
    // It used to be maintained only inside the cockpit rig, which was enough
    // for the camera — the other modes do not ride the car — but not enough for
    // anything that has to know how the CAR is lying, and `probe:framing` does.
    // A probe that projects the halo through a rolled camera onto a car it has
    // assumed is level measures up to 5.7 degrees of roll that is not in the
    // picture, and 5.7 degrees at the edge of a wide frame is several per cent
    // of frame width.
    //
    // TWO TERMS, and this used to be one. The road under the car is neither
    // flat nor level, and until issue #71 nothing here or in `Renderer.syncCars`
    // knew that: both took the whole attitude from the car's own accelerations,
    // so the driver's eye rode a car that was drawn horizontal on an 18.7 per
    // cent gradient. `roadPoseUnderCar` is the shared rule, called from the same
    // module by both, so that this file is no longer a line-for-line copy of
    // two expressions in another one — which is what the comment that used to
    // stand here was worried about, correctly.
    //
    // The ROAD's half is not damped. It is geometry and it does not lag; a
    // filtered surface drags the car through the asphalt at the foot of every
    // gradient for as long as it takes to catch up. Only the LEAN has an
    // accumulator, at the same 8/s `Renderer` uses.
    const surf = roadPoseUnderCar(
      track, car.renderS, car.renderLateral, heading, this.surfacePose,
    );
    this.leanRoll = damp(this.leanRoll, clamp(-p.lateralG * 0.016, -0.06, 0.06), 8, dt);
    this.leanPitch = damp(this.leanPitch, clamp(p.longitudinalG * 0.012, -0.05, 0.05), 8, dt);
    this.rigRoll = surf.roll + this.leanRoll;
    this.rigPitch = surf.pitch + this.leanPitch;

    // The car's own origin, which is the DRAWN road surface and not the bare
    // elevation the simulation carries — see `carGroundY`. Every camera below
    // is placed relative to this, and the onboard cameras in particular have to
    // ride the car exactly: 20mm of disagreement between the eye and the
    // chassis moves the halo three per cent of a frame height, which is what
    // `probe:framing` is there to notice. This branch was cut before
    // `carGroundY` existed and read the bare elevation; taking its attitude
    // work without this line would have put every eye 20mm into the car.
    // BANKED, not the centreline's height. On a banked corner the asphalt under
    // the car is tilted, so a car `lateral` metres off the centreline stands
    // `lateral * tan(bank)` above or below it — 1.63m at Zandvoort. The eye
    // rides the car, so the camera has to use the same surface the car does or
    // an onboard shot at Hugenholtz looks out from under the road.
    // THE DRAWN track-space pose, not the solver's last step — issue #54. `s`
    // and `lateral` are the only route to a height on a swept ribbon, so
    // reading the stepped pair here put a STAIRCASE under the viewpoint while
    // the car it is following glided: 2, 2, 3, 2, 3 steps of climb per frame at
    // 50fps. That is why the report was *"jittering happening for the track"* —
    // the plan error cancels in screen space for the car being followed and
    // this one does not, because it moves the eye. `probe:framerate`, section
    // WORLD SMOOTHNESS, measures exactly this line.
    // AND THE CURVATURE LIFT WITH IT — issue #71. `Renderer.syncCars` raises the
    // car root onto the plane its own contact patches span, so an eye that took
    // the bare `bankedCarGroundY` would sit tens of millimetres inside the tub
    // through every compression on the calendar. Same term, same call, same
    // reason as the line above.
    const carY = bankedCarGroundY(track, car.renderS, car.renderLateral) + surf.lift;

    // Reversing: the useful view is the one the car is going towards.
    //
    // Hysteresis on the forward speed component rather than on a control input,
    // because what matters is which way the car is actually moving. It latches
    // on below -1.2 m/s and off above -0.2, so nothing flickers as the car rocks
    // through a standstill, and the swing round the car is damped rather than
    // cut so it reads as the camera moving rather than as an edit.
    //
    // COMPUTED BEFORE THE SLIP ANGLE, which it did not use to be, and the order
    // is the fix. See below.
    const forwardMs = p.velocity.x * sinH + p.velocity.y * cosH;
    if (forwardMs < -1.2) this.reverseLatch = true;
    else if (forwardMs > -0.2) this.reverseLatch = false;
    this.reverse = damp(this.reverse, this.reverseLatch ? 1 : 0, 6, dt);
    // Half a turn when fully engaged. Applied to the camera's azimuth AND to
    // the aim, so the pair stays a follow shot with the car between the lens
    // and where it is going — just facing the other way.
    const reverseYaw = this.reverse * Math.PI;
    const viewHeading = heading + reverseYaw;
    const sinR = Math.sin(viewHeading);
    const cosR = Math.cos(viewHeading);

    // Direction the car is actually travelling, which differs from where it is
    // pointing when it slides. Looking along the velocity rather than the nose
    // is what makes a slide legible.
    //
    // "THE BACKUP CAMERA IS JITTERING WHEN I TRY TO BACK UP."
    //
    // Measured, on all eleven circuits, by `npm run probe:reverse`: while the
    // car was reversing the chase camera was swinging up to nine degrees in a
    // single frame — 540 a second — with nothing in the world moving to justify
    // it. The mechanism is exact and it was in the two lines this replaces.
    //
    // The slip angle used to be measured against the car's NOSE. A car
    // travelling backwards has a slip angle of almost exactly 180 degrees, so
    // `wrapAngle` returned something within a whisker of +pi or -pi and WHICH
    // ONE was decided by the sign of the lateral velocity — a quantity that
    // crosses zero constantly when a driver is sawing at the wheel to get out
    // of somewhere. The clamp to +-1.05 kept the magnitude and did nothing
    // about the sign, so every zero crossing swapped the bias from +1.05 to
    // -1.05 and lurched the desired azimuth by 66 degrees. The camera chased
    // that, at nine degrees a frame, back and forth, for as long as the driver
    // kept reversing. The previous pass added the clamp to fix "the camera goes
    // sideways when reversing" and could not have found this, because a clamp
    // is exactly the shape of fix that leaves a sign flip behind it.
    //
    // Measuring the slip against the direction the camera is actually LOOKING
    // removes it at the root rather than clamping it again. When the reverse
    // view is fully engaged, `viewHeading` is the direction of travel, so the
    // slip is near zero and there is no longer a large number to flip the sign
    // of; while the view is swinging round, both terms move together and it
    // stays continuous; and going forwards `reverseYaw` is zero and this is the
    // expression it always was.
    //
    // The speed gate is a RAMP for the same class of reason. At `speed > 3` the
    // slip snapped between zero and its full value as the car crept across 3
    // m/s, which is a 33-degree step in the desired azimuth sitting exactly in
    // the speed range a car being reversed lives in.
    const travelHeading = speed > 0.5 ? Math.atan2(p.velocity.x, p.velocity.y) : viewHeading;
    const slipWeight = clamp01((speed - 1.5) / 2.5);
    const slip = clamp(wrapAngle(travelHeading - viewHeading), -1.05, 1.05) * slipWeight;

    // The point every following camera is anchored to.
    this.anchor.set(car.renderX, carY, car.renderZ);

    switch (this.mode) {
      case 'chase': {
        // Distance and height grow slightly with speed, which reads as the car
        // pulling away from the camera.
        //
        // It sits LOWER and CLOSER than it used to. At 2.3-2.75m and up to 9m
        // back the camera was looking down on the roll hoop from well above head
        // height, which flattens the road into a plan view and throws the
        // horizon up near the top of the frame. Half a metre down and a metre in
        // puts it just above the airbox, where every broadcast chase camera
        // lives, and lets the road run away to a horizon in the upper third.
        // Closer and lower again, and this pass is about how the shot LOOKS
        // rather than about whether it is correct.
        //
        // The framing it had was already the broadcast one — car two thirds
        // down, horizon a third from the top — and it still read as flat. Two
        // reasons, both fixable without touching the field of view, which is
        // where the previous fisheye came from and is not going back:
        //
        //  - the car was small. At 6.9m on a 39-degree lens it occupies a
        //    quarter of the frame width, and a quarter of the frame is a
        //    subject you are watching rather than one you are behind. 6.1m puts
        //    it at nearly a third without the wide-angle distortion that
        //    getting there by opening the lens would cost;
        //  - the camera was above the car looking slightly down at it. At 1.92m
        //    the eye is a metre over the airbox, which flattens the road into a
        //    plan and hides the one surface that sells speed — the tarmac
        //    rushing under the floor. At 1.64m the camera is just above the
        //    rear wing, the road runs away underneath rather than out in front,
        //    and the car sits ON the picture instead of in the middle of it.
        const fast = clamp01(this.smoothSpeed / 90);
        let dist = lerp(5.2, 6.4, fast);
        const height = lerp(1.50, 1.76, fast);

        // Longitudinal g closes and opens the gap.
        //
        // Smoothing the OFFSET rather than the world position — see
        // `applySmoothed` — deliberately removed the lag that used to do this
        // for free, and with it went the sense of the car braking back INTO the
        // frame. Putting it back explicitly, driven by the actual acceleration,
        // is both more responsive and more controllable than the accident was.
        dist += clamp(p.longitudinalG * 0.20, -1.0, 0.7);

        // Bias the camera toward the outside of a slide so the car's angle shows.
        // `viewHeading` is `heading + reverseYaw`, and the slip is now measured
        // against it too — so this reads the same way going forwards and
        // backwards instead of being two terms that could disagree.
        const yaw = viewHeading - slip * 0.55;
        this.desired.set(
          car.renderX - Math.sin(yaw) * dist,
          carY + height,
          car.renderZ - Math.cos(yaw) * dist,
        );
        // Aim a short way ahead of the car, and low.
        //
        // Both numbers are framing controls and they pull opposite ways: aiming
        // FURTHER ahead or HIGHER tilts the camera up and pushes the car down
        // the frame — far enough and it disappears behind the dash readout along
        // the bottom edge. Aiming short and low lifts the car back up but buries
        // the horizon. This pair puts the car around two thirds down and the
        // horizon around a third from the top, which is the broadcast framing.
        this.lookTarget.set(
          car.renderX + sinR * 5.6,
          carY + 0.80,
          car.renderZ + cosR * 5.6,
        );
        this.applySmoothed(dt, 9, 11, this.anchor);
        // Bank into the corner.
        //
        // The one thing a fixed follow camera can do that a tripod cannot, and
        // the cheapest cinematic move available: roll the frame a couple of
        // degrees with the car's lateral load. A camera welded square to the
        // world tells you nothing about how hard the car is working; a camera
        // that leans with it turns every corner into something the shot is
        // participating in. Applied after `lookAt`, which resolves roll to zero
        // by construction, and deliberately small — past about four degrees it
        // stops reading as weight and starts reading as a tilted television.
        this.bank = damp(this.bank, clamp(-p.lateralG * 0.011, -0.055, 0.055), 5, dt);
        this.camera.rotateZ(this.bank);
        break;
      }

      case 'driver': {
        this.updateDriverEye(dt, car, track, carY);
        break;
      }

      case 'cockpit': {
        this.updateCockpit(dt, car, track, carY);
        break;
      }

      case 'onboard-t': {
        // The broadcast T-cam: the pod on top of the roll hoop, looking forward
        // over the driver's head.
        //
        // IT USED TO BE 0.40m BEHIND THE CAR'S CENTRE, WHICH IS IN FRONT OF THE
        // DRIVER, and that is the whole of the "two thick black tubes sweep
        // across the lower half of the frame in a wide shallow X" report.
        // `probe:framing` measured it on all eleven circuits and got the same
        // answer everywhere: the crown of the halo at 82 per cent of frame
        // height, the driver's helmet at 145 per cent — off the bottom
        // entirely — and the wheel at 103. A hoop whose crown is at 82 per cent
        // and whose rails leave through the bottom edge is not a hoop in the
        // picture at all; it is two diagonals lying in the bottom fifth of it,
        // with nothing above them and nothing below, which is exactly what a
        // pair of black pipes laid over the shot looks like.
        //
        // The cause is that a camera close in FRONT of the hoop sees it in
        // extreme perspective: the crown is only 1.15m away and 0.33m below, so
        // it subtends 16 degrees of depression and pins itself to the bottom of
        // the frame however wide the lens is. Standing back behind the hoop
        // instead — 0.80m back and 1.10m up, on the roll hoop where a T-cam
        // actually lives — halves the depression and the hoop rises into the
        // frame as an arc. Measured: crown 66 per cent, helmet crown 86, wheel
        // rim 79, mirrors at 69 per cent of frame width, horizon 42. Every one
        // of those is within a few points of the reference onboards, and the
        // helmet now subtends 23 per cent of frame width against the
        // reference's 21.
        this.desired.set(
          car.renderX - sinH * 0.80,
          carY + 1.10,
          car.renderZ - cosH * 0.80,
        );
        // Aim on the road twenty metres up, which is 3.4 degrees of nose-down
        // and puts the horizon at 42 per cent of frame height. Not further: the
        // aim point and the eye TOGETHER set the pitch, and a distant aim
        // flattens it until the shot is all sky and the hoop drops back out of
        // the bottom of the frame.
        this.lookTarget.set(
          car.renderX + sinH * 20,
          carY - 0.10,
          car.renderZ + cosH * 20,
        );
        this.applySmoothed(dt, 60, 20, this.anchor);
        break;
      }

      case 'bumper': {
        // Nose height, AHEAD OF THE WHOLE CAR. The lowest, fastest-feeling view.
        //
        // The front wing's foremost element reaches z = 3.075 and its endplates
        // z = 3.02, so anything behind about 3.1 has the wing in shot. It used
        // to sit at 2.35 on the theory that the wing was inside the near plane
        // and therefore invisible — but the near plane is 0.35m and the wing
        // runs from 2.5 to 3.08, so most of it is beyond that and duly filled
        // the bottom half of the frame with a yellow slab. 3.20 clears the lot.
        //
        // Being a metre ahead of the car's mass is not a defect here: it is why
        // a nose camera turns in early and feels quick.
        this.desired.set(
          car.renderX + sinH * 3.20,
          carY + 0.46,
          car.renderZ + cosH * 3.20,
        );
        this.lookTarget.set(
          car.renderX + sinH * 40,
          carY + 0.62,
          car.renderZ + cosH * 40,
        );
        this.applySmoothed(dt, 60, 22, this.anchor);
        break;
      }

      case 'tv': {
        // A broadcast follow: high enough to show the line the car is taking
        // through a corner, close enough that the car is still the subject. It
        // trails lazily, so the car leads it into a turn rather than staying
        // welded to the centre of frame.
        //
        // On a long lens the aim can no longer afford to be as lazy as it was:
        // a rate of 6 let the car drift a long way off centre, which was
        // invisible at the old 87-degree spread and would now put it out of
        // frame entirely.
        const dist = lerp(12, 15, clamp01(this.smoothSpeed / 90));
        const yaw = viewHeading - slip * 0.3;
        this.desired.set(
          car.renderX - Math.sin(yaw) * dist,
          carY + 3.4,
          car.renderZ - Math.cos(yaw) * dist,
        );
        this.lookTarget.set(
          car.renderX + sinR * 2.5,
          carY + 1.00,
          car.renderZ + cosR * 2.5,
        );
        this.applySmoothed(dt, 4.5, 9, this.anchor);
        break;
      }

      case 'drone': {
        // Orbits slowly while following: the "just look at it" view.
        //
        // The orbit uses its own phase. It used to share `shakePhase` with the
        // camera shake, which is advanced at 55 radians per second whenever the
        // car is vibrating — so hitting a kerb sent the drone whipping around
        // the car at several revolutions a second.
        //
        // Closer and lower than it was. At 13m out and 6.5m up on a 60-degree
        // vertical spread the car was a detail in a wide shot of empty tarmac;
        // the point of this camera is to look AT the car.
        this.dronePhase += dt * 0.2;
        const orbit = this.dronePhase;
        const dist = 10.5;
        this.desired.set(
          car.renderX + Math.sin(orbit) * dist,
          carY + 4.6 + Math.sin(orbit * 0.7) * 1.5,
          car.renderZ + Math.cos(orbit) * dist,
        );
        this.lookTarget.set(car.renderX, carY + 0.55, car.renderZ);
        this.applySmoothed(dt, 3.0, 8, this.anchor);
        break;
      }

      case 'trackside': {
        // Fixed cameras placed around the lap; hands over to the next one as the
        // car passes, like a real broadcast director.
        //
        // The hand-over point is chosen so a camera is picked up while the car
        // is still approaching it and dropped once the car is past, rather than
        // cutting to a camera the car has already gone by.
        // Cameras every 220m rather than every 340m.
        //
        // Spacing sets how far the car can get from whichever camera has it: at
        // 340 it was up to 190m away, and at that range on a circuit that turns,
        // the sightline leaves the road and crosses the debris fence further
        // round the lap — so the shot was through a fence even with the camera
        // itself standing inside the barrier. Halving the reach mostly removes
        // the geometry that causes it, and cutting every three seconds or so is
        // what a broadcast director does anyway.
        const spacing = 220;
        const nextAnchor = Math.floor(car.renderS / spacing) * spacing;
        if (nextAnchor !== this.tracksideAnchorS) {
          this.tracksideAnchorS = nextAnchor;
          // Alternate sides so consecutive shots are not identical.
          this.tracksideSide = (Math.floor(nextAnchor / spacing) & 1) === 0 ? 1 : -1;
          this.initialised = false;
        }
        const i = track.indexAt(this.tracksideAnchorS + spacing * 0.5);

        // INSIDE the barrier line, not outside it.
        //
        // This camera used to stand 16m beyond the track edge, which on a
        // permanent circuit is two metres past the armco — so every shot was
        // taken through the debris fence, and the fence runs from 1.5m to 5.4m
        // above the barrier. Climbing over it is not an option: from any
        // sensible offset the sightline to a car on the racing line would need
        // the camera twelve metres in the air. The answer is to stand in front
        // of the fence, where a real trackside operator stands.
        //
        // The offset is a fraction of wherever the armco actually is — read from
        // the same function that places it — rather than a constant, so a Monaco
        // camera is tucked into the barrier a metre off the road and a
        // Silverstone one stands well back. A constant cannot be both.
        const standoff = Math.min(7.0, nominalBarrierOffset(track) * 0.55);
        const off = (track.width[i] * 0.5 + standoff) * this.tracksideSide;
        this.desired.set(
          track.px[i] + track.nx[i] * off,
          // Head height plus a low platform, scaled with how far back it is.
          // Six and a half metres was a helicopter looking down on the roofs.
          track.elevation[i] + 2.1 + standoff * 0.22,
          track.pz[i] + track.nz[i] * off,
        );
        this.lookTarget.set(car.renderX, carY + 0.55, car.renderZ);
        // The camera position is static; only the aim tracks the car, and on a
        // long lens it has to track it briskly or the car leaves the frame.
        this.applySmoothed(dt, 100, 12);
        break;
      }
    }

    // --- Field of view ------------------------------------------------------
    // Widening the FOV with speed is the single most effective way to convey it:
    // peripheral detail rushes past faster than the centre of the frame, which is
    // exactly what happens to a driver's vision. See FOV above for what the
    // numbers mean and why they are not what they used to be.
    let targetFov: number;
    let fovRate = 4;
    if (this.mode === 'trackside') {
      // A real trackside camera zooms to hold the car at a usable size as it
      // approaches and goes past. A fixed focal length either loses the car in
      // the distance or has it fill the frame for a tenth of a second.
      const dx = this.camera.position.x - car.renderX;
      const dz = this.camera.position.z - car.renderZ;
      const dist = Math.max(10, Math.hypot(dx, dz));
      // The long end has to be genuinely long. An 8-degree floor was already
      // biting at ninety metres, which is well inside the range this camera
      // covers, so the car stopped growing and simply shrank away up the road.
      targetFov = clamp((Math.atan(TRACKSIDE_FRAMED_M / dist) * 2 * 180) / Math.PI, 5.5, 32);
      // A car covers ground far faster than a rate of 4 can follow, and the zoom
      // arriving a second late is worse than no zoom at all.
      fovRate = 9;
    } else {
      const f = FOV[this.mode];
      targetFov = f.base + clamp01(this.smoothSpeed / 95) * f.gain;
    }
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, fovRate, dt);
      this.camera.updateProjectionMatrix();
    }

    // --- Shake --------------------------------------------------------------
    // Driven by the physics' own vibration output, so it fires on kerbs and
    // lock-ups rather than being sprinkled on for effect.
    const targetShake = p.vibration
      * (isOnboardMode(this.mode) || this.mode === 'bumper' ? 0.09 : 0.035);
    this.shake = damp(this.shake, targetShake, 12, dt);
    if (this.shake > 0.0005) {
      this.shakePhase += dt * 55;
      this.camera.position.y += Math.sin(this.shakePhase) * this.shake;
      this.camera.position.x += Math.sin(this.shakePhase * 1.7) * this.shake * 0.5;
    }

    // Never let the camera drop below the road.
    //
    // The chase camera trails the car by a fixed offset, and on a crest or a
    // steep descent — or any time the car is pitched nose-down — that offset
    // can place it under the track surface. The result is a view up through the
    // underside of the tarmac at the barrier's back face, which reads as the
    // car having fallen through the world. Clamping to a minimum height above
    // the road at the CAR's position costs nothing and makes it impossible.
    //
    // AGAINST THE BANKED SURFACE, not the centreline's elevation — found by
    // `probe:framerate` while measuring issue #54, and it is the same mistake
    // issue #3 fixed in `carGroundY`: on a banked corner the asphalt under the
    // car is not at the centreline's height. At Zandvoort's Hugenholtz a car on
    // the low side of 18 degrees stands 0.48m BELOW the centreline, so a floor
    // written against the centreline sat 0.83m above the road and the driver's
    // eye — which rides 0.77m up — spent the corner pinned to it. Pinned, the
    // eye stops tracking the car and starts tracking `elevationAt(s)` alone,
    // and it pops off the clamp the moment the car moves back up the banking:
    // measured at 52mm of second difference in one frame at 50fps, four times
    // anything else on the calendar and the largest single judder left in the
    // scene after the interpolation fix. Against the surface the car is
    // actually standing on, the clamp does what its comment says — it stops the
    // chase camera going under the road — and stops lifting an onboard eye.
    const roadY = bankedCarGroundY(track, car.renderS, car.renderLateral);
    const minY = roadY + MIN_CAMERA_HEIGHT_M;
    if (this.camera.position.y < minY) this.camera.position.y = minY;

    if (world) this.keepOutOfSolids(dt, world, car.renderX, car.renderZ, roadY);
  }

  /**
   * Draws the camera in toward the car until it is out of anything solid.
   *
   * The framing code above places every camera by geometry alone — the drone
   * orbits at a fixed 10.5m radius, the bumper sits 3.2m ahead of the car's
   * centre, the trackside camera stands beside the road — and none of them ever
   * asked whether the place it chose is inside something. That was invisible
   * until the world became solid. Down a pit straight, 10.5m to the side of a
   * car is inside the pit wall and then inside the garages; 3.2m ahead of a car
   * clipping the pit-lane entry is inside the wall it is about to pass. The
   * objects are all exactly where they belong: it is the camera that is wrong.
   *
   * So the fix is here rather than in the geometry. `world.obstacles` is the
   * same broadphase the cars collide against and answers "what is at this
   * point" in microseconds; the camera asks it, and if the answer is "a
   * building" it slides along the line toward the car until the answer is
   * "nothing". Nothing else about the shot changes — the aim, the height, the
   * lens and the framing are all left alone, and the pull is zero whenever the
   * way is clear, so a camera with nothing in front of it behaves exactly as it
   * did before.
   *
   * Only the plan position moves. Height is deliberately untouched: lifting a
   * camera over a wall changes the shot far more than shortening it does, and
   * for a building there is no height that helps.
   */
  private keepOutOfSolids(
    dt: number, world: WorldModel, carX: number, carZ: number, roadY: number,
  ): void {
    const field = world.obstacles;
    const cam = this.camera.position;
    // An onboard camera is bolted to the car. It is inside the car, the car is
    // never inside anything solid, and moving it "toward the car" is a no-op
    // that would only risk perturbing a rig which must not be perturbed.
    const target = !isOnboardMode(this.mode) && !field.isEmpty;

    let want = 0;
    if (target) {
      let dirX = carX - cam.x;
      let dirZ = carZ - cam.z;
      const span = Math.hypot(dirX, dirZ);
      if (span > 0.05) {
        dirX /= span;
        dirZ /= span;
        // How high the camera is above the road under the car — the same datum
        // the height table is written against.
        const above = cam.y - roadY;

        // Up to a few rounds, because coming out of one box can put the camera
        // into the next: the pit wall and the garage frontage are two rows of
        // boxes a lane apart, and a lens between them is inside neither until
        // it is pushed. Converges immediately in the common case of one wall.
        let px = cam.x;
        let pz = cam.z;
        let travelled = 0;
        for (let round = 0; round < 4; round++) {
          field.query(px, pz, SOLID_CLEARANCE_M, this.solidHits);
          let step = 0;
          for (const i of this.solidHits) {
            const o = field.obstacles[i];
            // Over the top of it is not inside it. This is the whole reason
            // the heights exist: a drone 4.6m up crosses the barrier line
            // constantly and is looking over it every time.
            if (above > OBSTACLE_HEIGHT_M[o.kind]) continue;
            const exit = exitDistance(o, px, pz, dirX, dirZ, SOLID_CLEARANCE_M);
            if (exit > step) step = exit;
          }
          if (step <= 0) break;
          px += dirX * step;
          pz += dirZ * step;
          travelled += step;
          if (travelled >= span) break;
        }
        if (travelled > 0) want = Math.min(SOLID_MAX_PULL, travelled / span);
      }
    }

    // Attack instantly, release slowly. See SOLID_RELEASE_RATE.
    this.solidPull = Math.max(want, damp(this.solidPull, want, SOLID_RELEASE_RATE, dt));
    if (this.solidPull <= 1e-4) return;

    cam.x += (carX - cam.x) * this.solidPull;
    cam.z += (carZ - cam.z) * this.solidPull;
    // The aim has not changed, but the eye has, so it has to be re-resolved.
    // The cockpit builds its orientation from Euler angles and is excluded
    // above, so `smoothedLook` is always the right target here.
    this.camera.lookAt(this.smoothedLook);
    if (this.mode === 'chase') this.camera.rotateZ(this.bank);
  }

  /**
   * Aims an onboard camera, IN THE CAR'S OWN FRAME.
   *
   * THE BUG THIS REPLACES, and it is the reason the cockpit swam on every
   * gradient on the calendar. Both onboard rigs used to build one Euler:
   *
   *   camera.rotation.set(rigPitch - EYE_PITCH, heading + headYaw + PI, rigRoll, 'YXZ')
   *
   * The `+ PI` is there because a three.js camera looks along its own `-z` and
   * the car's nose is `+z`. In 'YXZ' the yaw is the OUTERMOST rotation, so the
   * pitch and the roll that follow it are taken about axes that the half turn
   * has already reversed — and a rotation of `+rigPitch` about a reversed x axis
   * is a rotation of `-rigPitch` about the car's. The camera therefore did not
   * ride the chassis: it rode its MIRROR IMAGE, and the disagreement between the
   * two is `2 x rigPitch`, not zero.
   *
   * Measured, on the composition alone with three.js doing the arithmetic
   * (`Euler(p, h, r)` for the car against `Euler(p, h + PI, r)` for the camera):
   *
   *   car pitch 11.5deg, roll 0    ->  camera off the car by pitch -22.92deg
   *   car pitch 0,  roll 11.5deg   ->  camera off the car by roll  -22.92deg
   *
   * and in the plainest form there is: at `rigPitch = 11.5deg` the car's nose
   * points at `y = -0.199` and the camera looks at `y = +0.199`. Nose down,
   * camera up.
   *
   * It was invisible for as long as the chassis attitude was the LOAD LEAN
   * alone, because that is 3.4deg of roll and 2.9deg of pitch and it is
   * symmetric about zero — a lean the wrong way still reads as a lean. Issue #71
   * put the ROAD into `rigPitch`/`rigRoll`, which took them to 11 degrees at
   * Monaco and 18 of roll at Zandvoort, and 22 degrees of camera-to-chassis
   * disagreement is the whole cockpit sliding out of the frame. It is what
   * `probe:framing` was reporting as `monaco phone cockpit: crown at 41% of
   * frame height` and `the wheel rim tops out at 57%` — the steering wheel is
   * bolted 0.44m in front of the driver's face and cannot move relative to it,
   * and a 22-point swim in where it lands is not a road, it is a sign error.
   *
   * So the orientation is composed the way the geometry is: the CAR's attitude
   * first, exactly as `Renderer.syncCars` puts it on the car root, and then the
   * neck — the half turn, the head's yaw about the driver's own spine, and the
   * fixed nose-down bias about the camera's own horizontal — applied INSIDE it.
   * With the car level the result is identical to the old expression, which is
   * why nothing on a flat circuit moves.
   *
   * @param heading   the car's yaw, world
   * @param pitch     the chassis pitch the CAR is drawn at (`rigPitch`)
   * @param roll      the chassis roll the CAR is drawn at, plus any head lean
   * @param headYaw   how far the head is turned into the corner, about the car's own up
   * @param nosePitch the fixed downward bias of this eye, radians, positive down
   */
  private aimFromCar(
    heading: number, pitch: number, roll: number, headYaw: number, nosePitch: number,
  ): void {
    this.carEuler.set(pitch, heading, roll, 'YXZ');
    this.qCar.setFromEuler(this.carEuler);
    this.neckEuler.set(-nosePitch, headYaw + Math.PI, 0);
    this.qNeck.setFromEuler(this.neckEuler);
    this.camera.quaternion.copy(this.qCar).multiply(this.qNeck);
  }

  /**
   * The driver's-eye rig.
   *
   * Same skeleton as `updateCockpit` — bolted to the chassis, oriented from
   * Euler angles rather than a look-at, no positional smoothing — because those
   * decisions are right for any camera that has the car's own furniture in
   * shot, and the reasons are written out there.
   *
   * What is different is the NECK. The cockpit camera is a pod bolted to a roll
   * hoop and it is honest for it to move exactly as the hoop does. This one is
   * somebody's head, and a head does three things a bracket does not: it turns
   * to look where the car is going, it falls toward the outside of a corner
   * under lateral load, and it is thrown about on its neck under braking. All
   * three are here and all three are deliberately SMALL. See `DRIVER_HEAD`.
   */
  private updateDriverEye(dt: number, car: CarEntry, track: TrackSpline, carY: number): void {
    const p = car.physics;

    // Chassis attitude is maintained in `update`; the eye rides on it.

    // The neck.
    //
    // SIGNS, established by measurement rather than by argument: driving the
    // real physics with a positive steer input turns the car RIGHT and reports
    // `lateralG` NEGATIVE, and `longitudinalG` is positive under power. So a
    // head thrown toward the outside of a corner moves along `+lateralG` — the
    // car's own +x is its LEFT — and a head thrown forward under braking moves
    // along `-longitudinalG`.
    //
    // The lean is ON TOP of the chassis roll and in the same direction, which
    // is what makes it read as the head continuing past the car rather than as
    // the horizon tilting on its own.
    this.headLean = damp(
      this.headLean,
      clamp(-p.lateralG * DRIVER_HEAD.leanPerG, -DRIVER_HEAD.leanMax, DRIVER_HEAD.leanMax),
      DRIVER_HEAD.rate, dt,
    );
    this.headShiftX = damp(
      this.headShiftX,
      clamp(p.lateralG * DRIVER_HEAD.shiftPerG, -DRIVER_HEAD.shiftMax, DRIVER_HEAD.shiftMax),
      DRIVER_HEAD.rate, dt,
    );
    this.headShiftZ = damp(
      this.headShiftZ,
      clamp(-p.longitudinalG * DRIVER_HEAD.shiftPerG, -DRIVER_HEAD.shiftMax, DRIVER_HEAD.shiftMax),
      DRIVER_HEAD.rate, dt,
    );

    // Eye point, car-local to world, riding the chassis attitude. The offset
    // has to be rotated as well as the camera — see `updateCockpit`, where the
    // same 42mm of unaccounted swing was the whole of the "everything swims"
    // report.
    this.eye.set(
      DRIVER_EYE_X + this.headShiftX,
      DRIVER_EYE_Y,
      DRIVER_EYE_Z + this.headShiftZ,
    );
    this.carEuler.set(this.rigPitch, car.renderHeading, this.rigRoll, 'YXZ');
    this.eye.applyEuler(this.carEuler);
    this.camera.position.set(
      car.renderX + this.eye.x,
      carY + this.eye.y,
      car.renderZ + this.eye.z,
    );

    // Looking into the corner.
    //
    // Off the TRACK's heading a second or so ahead, not off the steering input,
    // and that is the whole of "must not fight the player's steering". A head
    // driven by the wheel turns the moment the player turns and turns back the
    // moment they correct, so every stab of opposite lock swings the view — the
    // player is then steering the camera as well as the car and the two argue.
    // Driven by where the ROAD goes, the head is already pointing at the apex
    // before the car is, which is what a driver does, and it is unaffected by
    // anything the player does with their hands.
    //
    // Slightly more than the cockpit's eleven degrees, because this head is not
    // carrying the car's own furniture across the frame with it: from the
    // roll-hoop pod a head turn slides the halo, the rim and the mirrors bodily
    // sideways, and from inside the driver's own skull it does what turning
    // your head does. Fourteen degrees, damped at 2.4 per second so it leads
    // the car into the corner instead of snapping to it.
    const lookAheadM = clamp(25 + p.speedMs * 1.1, 30, 120);
    const aheadHeading = track.headingAt(car.renderS + lookAheadM);
    const target = clamp(
      wrapAngle(aheadHeading - car.renderHeading) * DRIVER_HEAD.lookGain,
      -DRIVER_HEAD.lookMax, DRIVER_HEAD.lookMax,
    );
    this.headYaw = damp(this.headYaw, target, DRIVER_HEAD.lookRate, dt);

    // Composed in the car's frame — see `aimFromCar`. The head's lean rides with
    // the chassis roll, in the same direction, which is what makes it read as
    // the head continuing past the car rather than as the horizon tilting.
    this.aimFromCar(
      car.renderHeading,
      this.rigPitch,
      this.rigRoll + this.headLean,
      this.headYaw,
      DRIVER_EYE_PITCH,
    );
    this.initialised = false;
  }

  /**
   * The cockpit rig.
   *
   * This is the one camera that is NOT a smoothed follow. It is bolted to the
   * driver's skull: the position is the eye point of the cockpit geometry,
   * exactly, with no lag at all, because any smoothing at all makes the steering
   * wheel and the halo swim relative to the view and instantly destroys the
   * illusion of sitting in the car. Everything that gives it life — the head
   * turning into the corner, the chassis rolling under you — is applied as
   * rotation, which is where a real driver's compliance actually is.
   *
   * Orientation is built from Euler angles rather than a look-at target. A
   * look-at aimed at a point on the racing line swings violently through a
   * chicane and rolls the horizon; composing yaw, pitch and roll keeps the
   * horizon level except for the deliberate chassis roll.
   */
  private updateCockpit(dt: number, car: CarEntry, track: TrackSpline, carY: number): void {
    const p = car.physics;

    // Chassis attitude — matching what the renderer applies to the car body, so
    // the modelled cockpit and the view stay locked together — is maintained in
    // `update` before this runs, because the eye point rides on it and because
    // every other mode needs to be able to report it too.

    // Eye point, car-local to world.
    //
    // The roll and pitch have to be applied to the OFFSET, not just to the
    // camera's orientation. The renderer rolls and pitches the whole car root
    // about the contact-patch plane, so the modelled eye socket 0.7m up swings
    // sideways by roll * 0.7 — about 42mm at full lock. Ignoring that left the
    // camera stationary while the cockpit moved underneath it, and 42mm at the
    // 0.44m the steering wheel sits from your face is five degrees of apparent
    // shift. That is the "swim" that made the rim and the halo look like they
    // were floating rather than bolted down; the rotation angles were already
    // right, it was the position that was wrong.
    this.eye.set(EYE_X, EYE_Y, EYE_Z);
    this.carEuler.set(this.rigPitch, car.renderHeading, this.rigRoll, 'YXZ');
    this.eye.applyEuler(this.carEuler);
    this.camera.position.set(
      car.renderX + this.eye.x,
      carY + this.eye.y,
      car.renderZ + this.eye.z,
    );

    // Drivers look at the apex, not at the nose. Take the heading of the track
    // a second or so ahead and turn part of the way toward it.
    //
    // A SMALL part of the way. Half the heading error, capped at 24 degrees, put
    // the view a quarter turn off the car's axis at the apex — and because the
    // cockpit is bolted to the car and the head is not, the halo, the wheel and
    // the mirrors all slid bodily across the frame while the tub stayed put. The
    // reference onboard footage does not do this at all: through every corner in
    // it the cockpit sits dead centre and symmetric. Eleven degrees is enough to
    // feel like a driver leaning into a corner and little enough that the car
    // still frames the shot.
    const lookAheadM = clamp(25 + p.speedMs * 1.1, 30, 120);
    const aheadHeading = track.headingAt(car.renderS + lookAheadM);
    const target = clamp(wrapAngle(aheadHeading - car.renderHeading) * 0.30, -0.20, 0.20);
    this.headYaw = damp(this.headYaw, target, 2.6, dt);

    // Nose-down bias. See EYE_PITCH: it is the other half of the roll-hoop
    // framing and belongs beside the eye point it goes with, not here.
    //
    // Composed in the CAR's frame — see `aimFromCar`. This pod is bolted to the
    // roll hoop and the wheel, the halo and the mirrors are bolted to the same
    // tub, so nothing car-local may move in this frame when the road pitches.
    this.aimFromCar(
      car.renderHeading, this.rigPitch, this.rigRoll, this.headYaw, EYE_PITCH,
    );
    this.initialised = false;
  }

  /**
   * Exponentially approaches the desired position and aim, smoothing the OFFSET
   * from the car rather than the absolute world position.
   *
   * This distinction is not cosmetic. Exponentially smoothing a world position
   * toward a target that is itself moving leaves a steady-state lag of
   * velocity/rate — at 57 m/s with a rate of 7 per second, the camera settles
   * eight metres further back than intended, so the car shrinks as it accelerates
   * and the framing changes with speed. Smoothing the offset removes the lag
   * entirely: the camera holds its distance at 60 km/h and at 340.
   *
   * Anchoring is skipped for the trackside camera, whose position is genuinely
   * fixed in the world.
   */
  private applySmoothed(dt: number, posRate: number, lookRate: number, anchor?: THREE.Vector3): void {
    if (anchor) {
      this.desiredOffset.subVectors(this.desired, anchor);
      this.lookOffset.subVectors(this.lookTarget, anchor);

      if (!this.initialised) {
        this.smoothedOffset.copy(this.desiredOffset);
        this.smoothedLookOffset.copy(this.lookOffset);
        this.initialised = true;
      } else {
        this.smoothedOffset.x = damp(this.smoothedOffset.x, this.desiredOffset.x, posRate, dt);
        this.smoothedOffset.y = damp(this.smoothedOffset.y, this.desiredOffset.y, posRate, dt);
        this.smoothedOffset.z = damp(this.smoothedOffset.z, this.desiredOffset.z, posRate, dt);
        this.smoothedLookOffset.x = damp(this.smoothedLookOffset.x, this.lookOffset.x, lookRate, dt);
        this.smoothedLookOffset.y = damp(this.smoothedLookOffset.y, this.lookOffset.y, lookRate, dt);
        this.smoothedLookOffset.z = damp(this.smoothedLookOffset.z, this.lookOffset.z, lookRate, dt);
      }

      this.smoothedPos.addVectors(anchor, this.smoothedOffset);
      this.smoothedLook.addVectors(anchor, this.smoothedLookOffset);
    } else if (!this.initialised) {
      this.smoothedPos.copy(this.desired);
      this.smoothedLook.copy(this.lookTarget);
      this.initialised = true;
    } else {
      this.smoothedPos.x = damp(this.smoothedPos.x, this.desired.x, posRate, dt);
      this.smoothedPos.y = damp(this.smoothedPos.y, this.desired.y, posRate, dt);
      this.smoothedPos.z = damp(this.smoothedPos.z, this.desired.z, posRate, dt);
      this.smoothedLook.x = damp(this.smoothedLook.x, this.lookTarget.x, lookRate, dt);
      this.smoothedLook.y = damp(this.smoothedLook.y, this.lookTarget.y, lookRate, dt);
      this.smoothedLook.z = damp(this.smoothedLook.z, this.lookTarget.z, lookRate, dt);
    }

    this.camera.position.copy(this.smoothedPos);
    this.tmp.copy(this.smoothedLook);
    this.camera.lookAt(this.tmp);
  }

  /** Frames the whole circuit, for the track-preview screen. */
  frameCircuit(track: TrackSpline): void {
    const b = track.bounds();
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    this.camera.position.set(cx, span * 0.85, cz + span * 0.55);
    this.camera.lookAt(cx, 0, cz);
    this.camera.fov = 45;
    this.camera.updateProjectionMatrix();
    this.initialised = false;
  }

  get modeLabel(): string {
    return CAMERA_LABELS[this.mode];
  }

  /**
   * How far round the reverse view is, 0 (following) to 1 (facing back).
   *
   * Exposed for `probe:reverse`, which has to tell a camera that is swinging
   * round the car on purpose from one that is oscillating — and the honest way
   * to do that is to ask the rig which it is doing rather than to guess from
   * the car's speed. Guessing was tried: a proxy built on the sign of the
   * forward velocity blanked the wrong second on a car that was sliding
   * sideways at 13 m/s with only 3 of it going backwards, and reported a
   * legitimate half-turn as a fault on three circuits.
   */
  get reverseBlend(): number {
    return this.reverse;
  }

  /**
   * How far the driver's head is turned into the corner, radians.
   *
   * Exposed for `probe:framing`, on the same principle as `reverseBlend`: a
   * framing target describes where things sit when the head is STRAIGHT, and a
   * probe that samples wherever on the lap the car happens to be would
   * otherwise measure a resting spec against a turned head and report a corner
   * as a fault. Turning the head deliberately swings the outside mirror to the
   * edge of the frame and eventually out of it, exactly as it does in a real
   * car; that is the feature, not the thing being checked.
   *
   * Zero in every mode that is not built from Euler angles, because those have
   * no head.
   */
  /**
   * The attitude the CAR is lying at: roll and pitch, radians.
   *
   * Exposed for `probe:framing`, which has to put the halo, the wheel and the
   * mirror panes where they actually are before it projects them. The same
   * numbers `Renderer.syncCars` puts on the car root, because since issue #71
   * both come out of one call to `CarAttitude.surfaceAttitude` plus one lean
   * damped at the same rate — rather than out of two copies of two expressions
   * in two files, which is how this pair could have drifted apart.
   *
   * THE ROAD IS IN HERE NOW. Up to 10.6 degrees of pitch at Spa and 18 of roll
   * at Zandvoort, against the 2.9 and 3.4 the load lean can reach. A consumer
   * that projects car-local geometry through these is projecting it onto a car
   * lying on the road, which is where the car is.
   */
  get chassisRoll(): number {
    return this.rigRoll;
  }

  get chassisPitch(): number {
    return this.rigPitch;
  }

  get headTurn(): number {
    return this.mode === 'driver' || this.mode === 'cockpit' ? this.headYaw : 0;
  }

  /** Approximate lateral g for the HUD's g-meter, read off the camera's target. */
  static shakeFor(vibration: number): number {
    return clamp(vibration, 0, 1);
  }
}
