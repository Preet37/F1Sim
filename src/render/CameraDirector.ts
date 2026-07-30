import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/MathUtils';
import { EYE_X, EYE_Y, EYE_Z } from './CockpitMesh';
import type { CarEntry } from '../race/CarEntry';
import type { TrackSpline } from '../track/TrackSpline';

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
 * The cockpit needs a much closer near plane than anything else: the steering
 * wheel sits about 400mm from the driver's eyes and the halo pillar about 600mm,
 * and the default 0.35m plane slices straight through both. Nothing else in the
 * game has geometry that close, so every other mode keeps the wider plane and
 * its better depth precision.
 */
const NEAR_COCKPIT = 0.08;
const NEAR_DEFAULT = 0.35;

export const CAMERA_MODES: readonly CameraMode[] = [
  'chase', 'cockpit', 'onboard-t', 'bumper', 'tv', 'drone', 'trackside',
];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  cockpit: 'Cockpit',
  'onboard-t': 'Onboard T-Cam',
  bumper: 'Bumper',
  tv: 'TV',
  drone: 'Drone',
  trackside: 'Trackside',
};

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
  private initialised = false;

  /** Smoothed speed, so FOV does not flicker on gear changes. */
  private smoothSpeed = 0;
  /** Cockpit rig: damped head turn into the corner, and chassis attitude. */
  private headYaw = 0;
  private rigRoll = 0;
  private rigPitch = 0;
  /** Trackside camera state: which anchor it is currently using. */
  private tracksideAnchorS = 0;
  private tracksideSide = 1;
  /** Drone orbit angle. Separate from the shake phase, which runs 250x faster. */
  private dronePhase = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.35, 4000);
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
    this.applyNearPlane();
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.initialised = false;
    this.applyNearPlane();
  }

  /** Cockpit sits inside its own bodywork and needs a much closer near plane. */
  private applyNearPlane(): void {
    const near = this.mode === 'cockpit' ? NEAR_COCKPIT : NEAR_DEFAULT;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Updates the camera for this frame.
   * @param dt real frame time, seconds
   */
  update(dt: number, car: CarEntry, track: TrackSpline): void {
    const p = car.physics;
    const speed = p.speedMs;
    this.smoothSpeed = damp(this.smoothSpeed, speed, 3, dt);

    const heading = p.heading;
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const carY = track.elevationAt(car.s);

    // Direction the car is actually travelling, which differs from where it is
    // pointing when it slides. Looking along the velocity rather than the nose is
    // what makes a slide legible.
    const travelHeading = speed > 3 ? Math.atan2(p.velocity.x, p.velocity.y) : heading;
    const slip = wrapAngle(travelHeading - heading);

    // The point every following camera is anchored to.
    this.anchor.set(p.position.x, carY, p.position.y);

    switch (this.mode) {
      case 'chase': {
        // Distance and height grow slightly with speed, which reads as the car
        // pulling away from the camera.
        //
        // The numbers are set so the car occupies the lower-middle third of the
        // frame with a clear view of the road beyond it: about a car and a half
        // back, a little over head height, aiming at a point just ahead of the
        // nose. Closer than this and the rear wing fills the screen; further
        // back and it stops being your car.
        const fast = clamp01(this.smoothSpeed / 90);
        const dist = lerp(8.2, 10.6, fast);
        const height = lerp(2.55, 3.05, fast);
        // Bias the camera toward the outside of a slide so the car's angle shows.
        const yaw = heading - slip * 0.55;
        this.desired.set(
          p.position.x - Math.sin(yaw) * dist,
          carY + height,
          p.position.y - Math.cos(yaw) * dist,
        );
        // Aim a short way ahead of the car. A distant look target pushes the car
        // to the bottom of the frame and points the camera at the horizon, which
        // loses both the car and the sense of the road rushing under it.
        this.lookTarget.set(
          p.position.x + sinH * 5.0,
          carY + 0.95,
          p.position.y + cosH * 5.0,
        );
        this.applySmoothed(dt, 9, 11, this.anchor);
        break;
      }

      case 'cockpit': {
        this.updateCockpit(dt, car, track, carY);
        break;
      }

      case 'onboard-t': {
        // The broadcast T-cam, sitting on the airbox directly above and just
        // behind the driver's head. The airbox crown is at 0.85m and the helmet
        // at 0.82m, so 1.12m clears both and still frames the halo and the
        // helmet in the bottom of the shot the way a real onboard does.
        this.desired.set(
          p.position.x - sinH * 0.34,
          carY + 1.12,
          p.position.y - cosH * 0.34,
        );
        // Aim at a point on the road well ahead, not at the horizon: the
        // shallow downward angle is what keeps the track in the frame.
        this.lookTarget.set(
          p.position.x + sinH * 34,
          carY + 0.35,
          p.position.y + cosH * 34,
        );
        this.applySmoothed(dt, 60, 20, this.anchor);
        break;
      }

      case 'bumper': {
        // Nose height, ahead of the front axle. The lowest, fastest-feeling
        // view — the front wing is inside the near plane so it never obstructs.
        this.desired.set(
          p.position.x + sinH * 2.35,
          carY + 0.44,
          p.position.y + cosH * 2.35,
        );
        this.lookTarget.set(
          p.position.x + sinH * 40,
          carY + 0.55,
          p.position.y + cosH * 40,
        );
        this.applySmoothed(dt, 60, 22, this.anchor);
        break;
      }

      case 'tv': {
        // A broadcast follow: high enough to show the line the car is taking
        // through a corner, close enough that the car is still the subject. It
        // trails lazily, so the car leads it into a turn rather than staying
        // welded to the centre of frame.
        const dist = lerp(11, 14, clamp01(this.smoothSpeed / 90));
        const yaw = heading - slip * 0.3;
        this.desired.set(
          p.position.x - Math.sin(yaw) * dist,
          carY + 4.6,
          p.position.y - Math.cos(yaw) * dist,
        );
        this.lookTarget.set(
          p.position.x + sinH * 2.5,
          carY + 0.55,
          p.position.y + cosH * 2.5,
        );
        this.applySmoothed(dt, 3.6, 6, this.anchor);
        break;
      }

      case 'drone': {
        // Orbits slowly while following: the "just look at it" view.
        //
        // The orbit uses its own phase. It used to share `shakePhase` with the
        // camera shake, which is advanced at 55 radians per second whenever the
        // car is vibrating — so hitting a kerb sent the drone whipping around
        // the car at several revolutions a second.
        this.dronePhase += dt * 0.2;
        const orbit = this.dronePhase;
        const dist = 17;
        this.desired.set(
          p.position.x + Math.sin(orbit) * dist,
          carY + 8.5 + Math.sin(orbit * 0.7) * 2.5,
          p.position.y + Math.cos(orbit) * dist,
        );
        this.lookTarget.set(p.position.x, carY + 0.7, p.position.y);
        this.applySmoothed(dt, 2.6, 5, this.anchor);
        break;
      }

      case 'trackside': {
        // Fixed cameras placed around the lap; hands over to the next one as the
        // car passes, like a real broadcast director.
        //
        // The hand-over point is chosen so a camera is picked up while the car
        // is still approaching it and dropped once the car is past, rather than
        // cutting to a camera the car has already gone by.
        const spacing = 340;
        const nextAnchor = Math.floor(car.s / spacing) * spacing;
        if (nextAnchor !== this.tracksideAnchorS) {
          this.tracksideAnchorS = nextAnchor;
          // Alternate sides so consecutive shots are not identical.
          this.tracksideSide = (Math.floor(nextAnchor / spacing) & 1) === 0 ? 1 : -1;
          this.initialised = false;
        }
        const i = track.indexAt(this.tracksideAnchorS + spacing * 0.55);
        const off = (track.width[i] * 0.5 + 16) * this.tracksideSide;
        this.desired.set(
          track.px[i] + track.nx[i] * off,
          track.elevation[i] + 6.5,
          track.pz[i] + track.nz[i] * off,
        );
        this.lookTarget.set(p.position.x, carY + 0.7, p.position.y);
        // The camera position is static; only the aim tracks the car.
        this.applySmoothed(dt, 100, 9);
        break;
      }
    }

    // --- Field of view ------------------------------------------------------
    // Widening the FOV with speed is the single most effective way to convey it:
    // peripheral detail rushes past faster than the centre of the frame, which is
    // exactly what happens to a driver's vision.
    let targetFov: number;
    if (this.mode === 'trackside') {
      // A real trackside camera zooms to hold the car at a usable size as it
      // approaches and goes past. A fixed focal length either loses the car in
      // the distance or has it fill the frame for a tenth of a second.
      const dx = this.camera.position.x - p.position.x;
      const dz = this.camera.position.z - p.position.y;
      const dist = Math.max(12, Math.hypot(dx, dz));
      targetFov = clamp((Math.atan(9 / dist) * 2 * 180) / Math.PI, 14, 42);
    } else {
      const baseFov =
        this.mode === 'cockpit' ? 70 :
        this.mode === 'bumper' ? 76 :
        this.mode === 'onboard-t' ? 66 :
        this.mode === 'drone' ? 46 :
        this.mode === 'tv' ? 44 : 56;
      targetFov = baseFov + clamp01(this.smoothSpeed / 95) * (this.mode === 'cockpit' ? 8 : 14);
    }
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
      this.camera.updateProjectionMatrix();
    }

    // --- Shake --------------------------------------------------------------
    // Driven by the physics' own vibration output, so it fires on kerbs and
    // lock-ups rather than being sprinkled on for effect.
    const targetShake = p.vibration * (this.mode === 'cockpit' || this.mode === 'bumper' ? 0.09 : 0.035);
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
    const roadY = track.elevationAt(car.s);
    const minY = roadY + MIN_CAMERA_HEIGHT_M;
    if (this.camera.position.y < minY) this.camera.position.y = minY;
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
    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);

    // Eye point, car-local to world. The car root carries the same transform,
    // so this lands exactly where the modelled driver's eyes are.
    this.camera.position.set(
      p.position.x + cosH * EYE_X + sinH * EYE_Z,
      carY + EYE_Y,
      p.position.y - sinH * EYE_X + cosH * EYE_Z,
    );

    // Drivers look at the apex, not at the nose. Take the heading of the track
    // a second or so ahead and turn part of the way toward it.
    const lookAheadM = clamp(25 + p.speedMs * 1.1, 30, 120);
    const aheadHeading = track.headingAt(car.s + lookAheadM);
    const target = clamp(wrapAngle(aheadHeading - p.heading) * 0.5, -0.42, 0.42);
    this.headYaw = damp(this.headYaw, target, 2.6, dt);

    // Chassis attitude, matching what the renderer applies to the car body so
    // the modelled cockpit and the view stay locked together.
    this.rigRoll = damp(this.rigRoll, clamp(-p.lateralG * 0.016, -0.06, 0.06), 8, dt);
    this.rigPitch = damp(this.rigPitch, clamp(p.longitudinalG * 0.012, -0.05, 0.05), 8, dt);

    // A three-degree nose-down bias: a driver's eyeline is on the road a hundred
    // metres away, not on the horizon.
    this.camera.rotation.set(
      this.rigPitch - 0.045,
      p.heading + this.headYaw + Math.PI,
      this.rigRoll,
      'YXZ',
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

  /** Approximate lateral g for the HUD's g-meter, read off the camera's target. */
  static shakeFor(vibration: number): number {
    return clamp(vibration, 0, 1);
  }
}
