import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/MathUtils';
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
  /** Trackside camera state: which anchor it is currently using. */
  private tracksideAnchorS = 0;
  private tracksideSide = 1;

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
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.initialised = false;
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
        const dist = lerp(6.6, 9.2, clamp01(this.smoothSpeed / 90));
        const height = lerp(2.1, 2.7, clamp01(this.smoothSpeed / 90));
        // Bias the camera toward the outside of a slide so the car's angle shows.
        const yaw = heading - slip * 0.55;
        this.desired.set(
          p.position.x - Math.sin(yaw) * dist,
          carY + height,
          p.position.y - Math.cos(yaw) * dist,
        );
        // Aim only a short way ahead of the car. A distant look target pushes the
        // car to the bottom of the frame and points the camera at the horizon,
        // which loses both the car and the sense of the road rushing under it.
        this.lookTarget.set(
          p.position.x + sinH * 3.5,
          carY + 1.15,
          p.position.y + cosH * 3.5,
        );
        this.applySmoothed(dt, 9, 11, this.anchor);
        break;
      }

      case 'cockpit': {
        // Driver's eye: behind the halo, low, looking where the car points.
        const eyeF = 0.35;
        const eyeH = 1.02;
        this.desired.set(
          p.position.x + sinH * eyeF,
          carY + eyeH,
          p.position.y + cosH * eyeF,
        );
        // Look far ahead down the track, with a small head-turn into the corner —
        // drivers look at the apex, not at the nose.
        const lookAheadS = car.s + 55;
        track.racingLineAt(lookAheadS, track.tmpA);
        this.lookTarget.set(track.tmpA.x, carY + 0.9, track.tmpA.y);
        // Rigid to the chassis: the cockpit should feel violent.
        this.applySmoothed(dt, 40, 12, this.anchor);
        break;
      }

      case 'onboard-t': {
        // The broadcast T-cam above the airbox.
        this.desired.set(
          p.position.x - sinH * 0.55,
          carY + 1.42,
          p.position.y - cosH * 0.55,
        );
        this.lookTarget.set(
          p.position.x + sinH * 30,
          carY + 1.1,
          p.position.y + cosH * 30,
        );
        this.applySmoothed(dt, 34, 16, this.anchor);
        break;
      }

      case 'bumper': {
        // Nose height. The lowest, fastest-feeling view.
        this.desired.set(
          p.position.x + sinH * 2.3,
          carY + 0.42,
          p.position.y + cosH * 2.3,
        );
        this.lookTarget.set(
          p.position.x + sinH * 34,
          carY + 0.6,
          p.position.y + cosH * 34,
        );
        this.applySmoothed(dt, 38, 18, this.anchor);
        break;
      }

      case 'tv': {
        // A high, slightly-behind broadcast follow.
        const dist = 16;
        this.desired.set(
          p.position.x - sinH * dist,
          carY + 7.5,
          p.position.y - cosH * dist,
        );
        this.lookTarget.set(p.position.x, carY + 0.6, p.position.y);
        this.applySmoothed(dt, 4.5, 7, this.anchor);
        break;
      }

      case 'drone': {
        // Orbits slowly while following: the slowroads.io "just look at it" view.
        this.shakePhase += dt * 0.22;
        const orbit = this.shakePhase;
        const dist = 24;
        this.desired.set(
          p.position.x + Math.sin(orbit) * dist,
          carY + 13 + Math.sin(orbit * 0.7) * 4,
          p.position.y + Math.cos(orbit) * dist,
        );
        this.lookTarget.set(p.position.x, carY + 0.8, p.position.y);
        this.applySmoothed(dt, 2.6, 5, this.anchor);
        break;
      }

      case 'trackside': {
        // Fixed cameras placed around the lap; hands over to the next one as the
        // car passes, like a real broadcast director.
        const spacing = 320;
        const nextAnchor = Math.floor(car.s / spacing) * spacing;
        if (nextAnchor !== this.tracksideAnchorS) {
          this.tracksideAnchorS = nextAnchor;
          // Alternate sides so consecutive shots are not identical.
          this.tracksideSide = (Math.floor(nextAnchor / spacing) & 1) === 0 ? 1 : -1;
          this.initialised = false;
        }
        const i = track.indexAt(this.tracksideAnchorS + 60);
        const off = (track.width[i] * 0.5 + 22) * this.tracksideSide;
        this.desired.set(
          track.px[i] + track.nx[i] * off,
          track.elevation[i] + 9,
          track.pz[i] + track.nz[i] * off,
        );
        this.lookTarget.set(p.position.x, carY + 0.7, p.position.y);
        // The camera position is static; only the aim tracks the car.
        this.applySmoothed(dt, 100, 8);
        break;
      }
    }

    // --- Field of view ------------------------------------------------------
    // Widening the FOV with speed is the single most effective way to convey it:
    // peripheral detail rushes past faster than the centre of the frame, which is
    // exactly what happens to a driver's vision.
    const baseFov =
      this.mode === 'cockpit' ? 72 :
      this.mode === 'bumper' ? 76 :
      this.mode === 'drone' ? 48 :
      this.mode === 'trackside' ? 34 : 58;
    const speedFov = clamp01(this.smoothSpeed / 95) * (this.mode === 'trackside' ? 4 : 14);
    const targetFov = baseFov + speedFov;
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
