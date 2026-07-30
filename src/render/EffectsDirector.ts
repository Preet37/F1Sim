import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem';
import { SkidMarks } from './SkidMarks';
import { clamp01 } from '../core/MathUtils';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';

/**
 * Turns simulation state into smoke, dust, sparks, spray and rubber.
 *
 * This is the only place that decides *when* an effect fires. Emitters own how
 * things look; this owns what they mean. Keeping that split means the trigger
 * conditions are all in one readable block and can be checked against the
 * physics rather than scattered through the renderer.
 *
 * Every trigger reads a quantity the physics already computes for its own
 * purposes — contact-patch slip speed, surface type, wheel lock, vertical load —
 * so the effects cannot drift out of agreement with the handling. When you see
 * the fronts smoking you have genuinely locked them, and the same number that
 * drew the smoke is the one costing you 8.8 metres of braking distance.
 *
 * Cost control matters as much as the look. Twenty cars each with four tyres,
 * emitting every frame, is 80 emitters. Two rules keep that affordable:
 *
 *  1. Emission is rate-based, not per-frame. An emitter accrues a fractional
 *     particle budget from dt and spawns when it exceeds one, so the particle
 *     count is identical at 30fps and 144fps. Per-frame spawning makes the
 *     effect density a function of the player's hardware, which is both a look
 *     bug and a performance trap — the faster the machine, the more it emits.
 *  2. Distant cars are culled and thinned. Beyond ~50m a car's smoke is a few
 *     pixels, so it emits at a fraction of the rate, and beyond ~140m not at
 *     all. The player's own car is never thinned.
 */

/** Slip speed, m/s, at which a tyre starts to visibly smoke. */
const SMOKE_SLIP_THRESHOLD = 3.2;
/** Slip speed at which smoke is at full density. */
const SMOKE_SLIP_FULL = 11;
/** Slip speed at which a tyre starts leaving a mark. */
const MARK_SLIP_THRESHOLD = 2.0;
/** Beyond this distance from the camera, a car emits nothing. */
const CULL_DISTANCE = 145;
/** Within this distance, a car emits at full rate. */
const FULL_RATE_DISTANCE = 45;

/** Per-car accumulators, so emission rates survive across frames. */
interface CarFx {
  smokeBudget: number;
  dustBudget: number;
  sprayBudget: number;
  sparkBudget: number;
  /** Previous gear, to catch downshifts for the exhaust flame. */
  lastGear: number;
  /** Low-passed vertical load, for detecting the floor grounding out. */
  compression: number;
}

export class EffectsDirector {
  readonly root = new THREE.Group();

  private readonly particles: ParticleSystem;
  private skids: SkidMarks | null = null;
  private readonly fx: CarFx[] = [];
  private readonly quality: 'low' | 'high';

  /** Set from the session's weather each load. */
  private wetness = 0;

  constructor(quality: 'low' | 'high') {
    this.quality = quality;
    this.particles = new ParticleSystem(quality);
    this.root.add(this.particles.root);
    this.root.matrixAutoUpdate = false;
  }

  loadSession(engine: RaceEngine): void {
    this.unload();
    this.wetness = engine.weather.wetness;

    this.skids = new SkidMarks(engine.cars.length * 4, this.quality);
    this.root.add(this.skids.mesh);

    this.fx.length = 0;
    for (let i = 0; i < engine.cars.length; i++) {
      this.fx.push({
        smokeBudget: 0, dustBudget: 0, sprayBudget: 0, sparkBudget: 0,
        lastGear: 1, compression: 0,
      });
    }
    this.particles.clear();
  }

  unload(): void {
    if (this.skids) {
      this.root.remove(this.skids.mesh);
      this.skids.dispose();
      this.skids = null;
    }
    this.particles.clear();
  }

  setProjection(fovDeg: number, viewportHeight: number): void {
    this.particles.setProjection(fovDeg, viewportHeight);
  }

  /** Contact between cars, or with a barrier. */
  reportImpact(x: number, y: number, z: number, severity: number): void {
    this.particles.emitImpact(x, y, z, severity);
  }

  /**
   * One frame of effects for the whole field.
   *
   * @param cameraPos used for distance culling, not for anything visual
   */
  update(dt: number, engine: RaceEngine, cameraPos: THREE.Vector3): void {
    this.particles.advance(dt);

    const track = engine.track;
    for (let i = 0; i < engine.cars.length; i++) {
      const car = engine.cars[i];
      const fx = this.fx[i];
      if (!fx) continue;
      if (car.retired && car.recovered) continue;

      const p = car.physics;
      const x = p.position.x;
      const z = p.position.y;
      const y = track.elevationAt(car.s);

      const dist = Math.hypot(x - cameraPos.x, z - cameraPos.z);
      if (!car.isPlayer && dist > CULL_DISTANCE) continue;
      // Linear thinning between full rate and the cull distance.
      const lod = car.isPlayer ? 1 : clamp01((CULL_DISTANCE - dist) / (CULL_DISTANCE - FULL_RATE_DISTANCE));
      if (lod <= 0.001) continue;

      this.updateCar(dt, car, fx, x, y, z, lod);
    }

    this.particles.flush();
    this.skids?.flush();
  }

  private updateCar(
    dt: number, car: CarEntry, fx: CarFx,
    x: number, y: number, z: number, lod: number,
  ): void {
    const p = car.physics;
    const spec = p.spec;
    const speed = p.speedMs;

    // Car axes in world space. The physics stores heading as a yaw about the
    // vertical, so forward and right fall straight out of it.
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);
    const fwdX = sin, fwdZ = cos;
    const rightX = cos, rightZ = -sin;

    const halfTrack = spec.trackWidthM * 0.5;
    const front = spec.cogToFrontM;
    const rear = spec.wheelbaseM - spec.cogToFrontM;

    // Velocity in world space, for throwing debris the right way. The physics
    // stores it as a 2D ground-plane vector, so its y is the world z here.
    const vx = p.velocity.x;
    const vz = p.velocity.y;

    const onTrack = p.surface === 'track' || p.surface === 'curb' || p.surface === 'pitlane';

    // --- Tyre smoke and marks ----------------------------------------------
    // Fronts and rears are handled separately because they fail for different
    // reasons: fronts lock under braking, rears light up on the throttle. Both
    // read their own slip speed from the physics.
    const axles: Array<{ slip: number; along: number; isRear: boolean }> = [
      { slip: p.frontSlipSpeed, along: front, isRear: false },
      { slip: p.rearSlipSpeed, along: -rear, isRear: true },
    ];

    for (const axle of axles) {
      // Wheelspin counts as slip even when the car is barely moving, which is
      // what makes a standing start smoke.
      const spinBoost = axle.isRear ? p.wheelSpin * 6 : 0;
      const slip = axle.slip + spinBoost;

      // A locked wheel is a special case: it is not rotating at all, so it
      // smokes far harder than the slip number alone suggests.
      const lockBoost = !axle.isRear && p.wheelsLocked ? 4 : 0;
      const effective = slip + lockBoost;

      const smokeAmount = clamp01((effective - SMOKE_SLIP_THRESHOLD) / (SMOKE_SLIP_FULL - SMOKE_SLIP_THRESHOLD));
      const markAmount = clamp01((effective - MARK_SLIP_THRESHOLD) / 5);

      for (const side of [-1, 1]) {
        const wx = x + fwdX * axle.along + rightX * halfTrack * side;
        const wz = z + fwdZ * axle.along + rightZ * halfTrack * side;

        // --- Rubber ---
        // Only on a hard surface, and heavily suppressed in the wet: rubber
        // does not transfer through a film of water.
        const id = car.index * 4 + (axle.isRear ? 2 : 0) + (side > 0 ? 1 : 0);
        const markOpacity = onTrack && p.surface !== 'pitlane'
          ? markAmount * (1 - this.wetness * 0.85) * clamp01(speed / 6)
          : 0;
        this.skids?.report(id, wx, wz, rightX, rightZ, spec.tireRadiusM * 0.62, markOpacity, y);

        // --- Smoke ---
        if (smokeAmount > 0.02 && onTrack && speed > 2) {
          // Rate scales with how hard the tyre is working, then with LOD.
          //
          // This number is per wheel per car. At a standing start every car on
          // the grid is spinning up at once, so the naive rate that looks right
          // for one car locking up alone is twenty times too much here and
          // fills the pool in under a second — which whites out the screen and
          // starves every other effect of particles.
          fx.smokeBudget += smokeAmount * 13 * lod * dt;
          if (fx.smokeBudget >= 1) {
            const n = Math.min(3, Math.floor(fx.smokeBudget));
            fx.smokeBudget -= n;
            this.particles.emitTyreSmoke(wx, y, wz, vx, vz, smokeAmount, n);
          }
        }
      }
    }

    // --- Off-track dust -----------------------------------------------------
    if (!onTrack && speed > 4) {
      const surface = p.surface === 'grass' ? 'grass' : p.surface === 'gravel' ? 'gravel' : 'runoff';
      const intensity = clamp01(speed / 40);
      fx.dustBudget += intensity * 34 * lod * dt;
      if (fx.dustBudget >= 1) {
        const n = Math.min(4, Math.floor(fx.dustBudget));
        fx.dustBudget -= n;
        // From the rear axle, which is where the load and the mess are.
        this.particles.emitDust(
          x - fwdX * rear, y, z - fwdZ * rear,
          vx, vz, surface, intensity, n,
        );
      }
    }

    // --- Rain spray ---------------------------------------------------------
    // The rooster tail. Scales with both water depth and speed, because it is
    // water being displaced by the contact patch and both terms feed that.
    if (this.wetness > 0.08 && onTrack && speed > 8) {
      const intensity = this.wetness * clamp01(speed / 55);
      fx.sprayBudget += intensity * 42 * lod * dt;
      if (fx.sprayBudget >= 1) {
        const n = Math.min(5, Math.floor(fx.sprayBudget));
        fx.sprayBudget -= n;
        this.particles.emitSpray(
          x - fwdX * rear, y, z - fwdZ * rear,
          vx, vz, speed, this.wetness, n,
        );
      }
    }

    // --- Sparks -------------------------------------------------------------
    // The plank grounds out when the floor is pushed down onto the road: high
    // speed loads the car with downforce, and braking pitches it forward onto
    // the front skids. Both terms are real numbers from the physics rather than
    // a random sprinkle, which is why sparks show up in the right places — the
    // end of a long straight and the bottom of a compression.
    const aeroLoad = clamp01(p.currentDownforceN / Math.max(p.totalMassKg * 9.81, 1));
    const pitch = clamp01(-p.longitudinalG / 3.2);
    const bottoming = clamp01(aeroLoad * 0.75 + pitch * 0.5 - 0.55) * clamp01((speed - 45) / 40);
    fx.compression = fx.compression * 0.86 + bottoming * 0.14;

    if (fx.compression > 0.03 && onTrack) {
      fx.sparkBudget += fx.compression * 90 * lod * dt;
      if (fx.sparkBudget >= 1) {
        const n = Math.min(6, Math.floor(fx.sparkBudget));
        fx.sparkBudget -= n;
        this.particles.emitSparks(
          x - fwdX * rear * 0.4, y, z - fwdZ * rear * 0.4,
          vx, vz, fx.compression, n,
        );
      }
    }

    // Kerbs kick the floor into the road hard enough to strike regardless.
    if (p.surface === 'curb' && speed > 25 && Math.random() < dt * 14 * lod) {
      this.particles.emitSparks(x - fwdX * rear * 0.5, y, z - fwdZ * rear * 0.5, vx, vz, 0.6, 3);
    }

    // --- Exhaust flame ------------------------------------------------------
    // On a downshift with the throttle shut, unburnt fuel lights in the
    // exhaust. Same condition the audio uses for the overrun crackle, so the
    // flame and the bang happen on the same frame.
    if (p.gear < fx.lastGear && car.appliedControls.throttle < 0.15 && p.rpmFraction > 0.45) {
      this.particles.emitFlame(
        x - fwdX * (rear + 0.5), y + 0.42, z - fwdZ * (rear + 0.5),
        vx, vz, clamp01(p.rpmFraction),
      );
    }
    fx.lastGear = p.gear;
  }

  dispose(): void {
    this.unload();
    this.particles.dispose();
  }
}
