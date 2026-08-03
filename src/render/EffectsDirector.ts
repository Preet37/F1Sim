import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem';
import { SkidMarks } from './SkidMarks';
import { RainCurtain } from './Rain';
import { bankedCarGroundY } from './TrackMesh';
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
/**
 * Wheelspin fraction above which a rear tyre starts laying rubber.
 *
 * `wheelSpin` is how far throttle exceeds the traction limit, so a few per cent
 * is a driver feeding the power in properly and should leave nothing. 0.12 is
 * the point at which the rear is genuinely lit up.
 */
const WHEELSPIN_MARK_THRESHOLD = 0.12;
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

  /**
   * What is falling, and what is lying, refreshed EVERY FRAME.
   *
   * They used to be one latched field, set once in `loadSession`, and that
   * single line is why a race that started dry and rained on lap ten never
   * threw up a drop of spray for its whole duration. The spray code below was
   * written, correct and unreachable.
   *
   * The spray itself reads the water at each CAR's own position rather than
   * either of these — see `update` — because a car that has moved off the
   * rubbered line onto the wetter part of the road throws more of it.
   */
  /** What is falling, as opposed to what is lying. Drives the rain, not the spray. */
  private rainRate = 0;

  private rain: RainCurtain;

  /**
   * Spray particles the whole field may emit in one frame.
   *
   * A HARD CAP, and the reason it exists is on the record in this file's own
   * history: an effect whose per-car rate looked right for one car was set
   * without measuring what twenty-two of them did, and it filled the pool in
   * under a second and whited out the screen. Spray is the worst case for that
   * failure by a distance — every car emits it, continuously, for the entire
   * wet part of a race, rather than in the bursts smoke and sparks come in.
   *
   * 64 is measured against the pool rather than chosen: the soft pool holds
   * 2400 particles and spray lives 0.8–1.7s, so a steady 64 a frame at 60fps
   * is 3840 a second against a pool that can retire about 2000 a second. That
   * is deliberately oversubscribed by about two to one — the ring buffer
   * overwrites its oldest, so the practical effect is that spray's own lifetime
   * is clipped to roughly half a second under a full field at full rate, which
   * looks right and leaves smoke and dust their share. Raising it to 128
   * measured at 0.9ms of extra GPU time and starved tyre smoke at a standing
   * start in the wet; there is nothing to be gained above it.
   */
  private static readonly SPRAY_BUDGET_PER_FRAME = 64;
  private sprayThisFrame = 0;

  constructor(quality: 'low' | 'high') {
    this.quality = quality;
    this.particles = new ParticleSystem(quality);
    this.root.add(this.particles.root);
    this.rain = new RainCurtain(quality);
    this.root.add(this.rain.mesh);
    this.root.matrixAutoUpdate = false;
  }

  loadSession(engine: RaceEngine): void {
    this.unload();
    this.rainRate = engine.weather.rainRate;

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

    // Live, not latched. See the field's own comment.
    this.rainRate = engine.weather.rainRate;
    this.rain.update(dt, this.rainRate, cameraPos);
    this.sprayThisFrame = 0;

    const track = engine.track;
    const surface = engine.weather.surface;
    for (let i = 0; i < engine.cars.length; i++) {
      const car = engine.cars[i];
      const fx = this.fx[i];
      if (!fx) continue;
      if (car.retired && car.recovered) continue;

      // The DRAWN pose, not the solver's last step. Smoke leaves the contact
      // patch and rubber is laid under it, so an emitter reading the stepped
      // position puts both up to 0.7m from the tyre that is supposed to have
      // made them — and staggers them frame to frame in exactly the way
      // `Renderer.updateRenderPoses` exists to stop.
      const x = car.renderX;
      const z = car.renderZ;
      // The DRAWN road, not the bare elevation: smoke, spray and plank sparks
      // all leave from the contact patch, and the contact patch stands on the
      // asphalt mesh. See `carGroundY` — the cars themselves had the same
      // 20mm error and it put every tyre inside the tarmac.
      const y = bankedCarGroundY(track, car.s, car.lateral);

      const dist = Math.hypot(x - cameraPos.x, z - cameraPos.z);
      if (!car.isPlayer && dist > CULL_DISTANCE) continue;
      // Linear thinning between full rate and the cull distance.
      const lod = car.isPlayer ? 1 : clamp01((CULL_DISTANCE - dist) / (CULL_DISTANCE - FULL_RATE_DISTANCE));
      if (lod <= 0.001) continue;

      // The water THIS car is driving through, not the circuit's average. A
      // car that has moved off the rubbered line onto the wetter part of the
      // road throws more spray, which is both true and a useful signal to the
      // driver behind about where the water is.
      const localWet = surface.waterAt(track.indexAt(car.s), car.lateral);
      this.updateCar(dt, car, fx, x, y, z, lod, localWet);
    }

    this.particles.flush();
    this.skids?.flush();
  }

  private updateCar(
    dt: number, car: CarEntry, fx: CarFx,
    x: number, y: number, z: number, lod: number, localWet: number,
  ): void {
    const p = car.physics;
    const spec = p.spec;
    const speed = p.speedMs;

    // Car axes in world space. The physics stores heading as a yaw about the
    // vertical, so forward and right fall straight out of it.
    const cos = Math.cos(car.renderHeading);
    const sin = Math.sin(car.renderHeading);
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
    const axles: Array<{ slip: number; along: number; isRear: boolean; lock: number }> = [
      { slip: p.frontSlipSpeed, along: front, isRear: false, lock: p.frontLockup },
      { slip: p.rearSlipSpeed, along: -rear, isRear: true, lock: p.rearLockup },
    ];

    for (const axle of axles) {
      // Wheelspin counts as slip even when the car is barely moving, which is
      // what makes a standing start smoke.
      const spinBoost = axle.isRear ? p.wheelSpin * 6 : 0;
      const slip = axle.slip + spinBoost;

      // A locked wheel is a special case: it is not rotating at all, so it
      // smokes far harder than the slip number alone suggests.
      const lockBoost = axle.lock > 0 ? 4 * axle.lock : 0;
      const effective = slip + lockBoost;

      const smokeAmount = clamp01((effective - SMOKE_SLIP_THRESHOLD) / (SMOKE_SLIP_FULL - SMOKE_SLIP_THRESHOLD));

      // --- What actually lays rubber -----------------------------------------
      //
      // "F1 CARS DON'T LEAVE MARKS UNLESS THEY LOCK UP." Correct, and this used
      // to be `clamp01((slipSpeed - 2.0) / 5)` — a plain ramp off contact-patch
      // slip speed with a 2 m/s threshold. Every car exceeds 2 m/s of slip in
      // every corner of every lap; that is what a slip angle IS, and it is how
      // a tyre generates lateral force at all. So all twenty cars painted a
      // black line through all twenty corners, continuously, and the circuit
      // was solid rubber within a couple of laps.
      //
      // A tyre only leaves a visible mark when it is NOT ROLLING at the road's
      // speed. There are exactly two ways for that to happen and neither of
      // them is cornering:
      //
      //   LOCK-UP — the wheel has stopped and the contact patch is being ground
      //     along the road. The fronts do this under braking and it is the
      //     flat-spot everyone remembers. `frontLockup`/`rearLockup` are zero
      //     unless the axle is genuinely past its grip on the brakes.
      //   WHEELSPIN — the rear wheel is turning faster than the car is moving,
      //     out of a slow corner or off the line. `wheelSpin` is already the
      //     amount by which throttle exceeds the traction limit.
      //
      // An ordinary slide contributes NOTHING here now. Sliding scrubs rubber
      // off the tyre, but at four-wheel-drift slip angles it does not deposit a
      // line you can see from a helicopter — and the report is right that it
      // should not.
      const spinMark = axle.isRear ? clamp01((p.wheelSpin - WHEELSPIN_MARK_THRESHOLD) / 0.35) : 0;
      const markAmount = Math.max(axle.lock, spinMark);

      for (const side of [-1, 1]) {
        const wx = x + fwdX * axle.along + rightX * halfTrack * side;
        const wz = z + fwdZ * axle.along + rightZ * halfTrack * side;

        // --- Rubber ---
        // Only on a hard surface, and heavily suppressed in the wet: rubber
        // does not transfer through a film of water.
        const id = car.index * 4 + (axle.isRear ? 2 : 0) + (side > 0 ? 1 : 0);
        const markOpacity = markAmount > 0 && onTrack && p.surface !== 'pitlane'
          ? markAmount * (1 - localWet * 0.85) * clamp01(speed / 6)
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
    //
    // The rooster tail: water displaced by the contact patch, so it scales with
    // both depth and speed because both feed the volume being moved.
    //
    // FROM THE TWO REAR WHEELS, not from a point on the centreline. That is the
    // one change here that costs nothing and buys everything: a real car throws
    // two distinct plumes that merge a few metres back, and emitting the SAME
    // total number of particles from two places instead of one gives the plume
    // its width and its shape for no extra particles at all. Widening the
    // emitter was the tempting alternative and it would have cost per-particle
    // size, which is fill rate, which is the budget that matters.
    if (localWet > 0.08 && onTrack && speed > 8) {
      // A floating tyre is not gripping the road, it is displacing a wedge of
      // water in front of itself, and the wall of spray that comes off a car
      // aquaplaning is far bigger than the one off a car that is merely wet.
      // Reading it off the tyre model means the visual and the grip loss are
      // the same event.
      const float = Math.max(p.frontTires.aquaplaning, p.rearTires.aquaplaning);
      const intensity = localWet * clamp01(speed / 55) * (1 + float * 0.9);
      fx.sprayBudget += intensity * 42 * lod * dt;
      if (fx.sprayBudget >= 1) {
        const want = Math.min(6, Math.floor(fx.sprayBudget));
        // The global cap. Twenty-two cars in the wet is the case that has to be
        // right, and the per-car rate above is set for one car.
        const room = EffectsDirector.SPRAY_BUDGET_PER_FRAME - this.sprayThisFrame;
        const n = Math.max(0, Math.min(want, room));
        fx.sprayBudget -= want;
        if (n > 0) {
          this.sprayThisFrame += n;
          // Split across the two rear wheels, remainder to the left. An odd
          // count arriving all on one side reads as a car with a puncture.
          const perSide = n >> 1;
          const extra = n - perSide * 2;
          for (const side of [-1, 1]) {
            const count = perSide + (side < 0 ? extra : 0);
            if (count <= 0) continue;
            this.particles.emitSpray(
              x - fwdX * rear + rightX * halfTrack * side, y,
              z - fwdZ * rear + rightZ * halfTrack * side,
              vx, vz, speed, localWet, count,
            );
          }
        }
      }
    }

    // --- Sparks -------------------------------------------------------------
    //
    // "SPARKS DON'T FLY UNTIL LIKE THE CAR IS BRAKING SO IDK WHY THEY ARE
    // CONSTANTLY FLYING."
    //
    // They were constant, and the arithmetic says why. The trigger used to be
    //
    //   aeroLoad = clamp01(downforce / weight)
    //   bottoming = clamp01(aeroLoad*0.75 + pitch*0.5 - 0.55) * clamp01((v-45)/40)
    //
    // and `aeroLoad` is a ratio that passes 1 at about 150km/h and is CLAMPED
    // there, so from the first straight of the race onwards the first term was
    // permanently 0.75. 0.75 - 0.55 = 0.20, which is greater than the 0.03 gate,
    // for every car, on every straight, for the rest of the session — with or
    // without the brake. The braking term could only ever add to something that
    // was already firing, so braking made no visible difference and not braking
    // did not stop it. It was a speed effect wearing a physics costume.
    //
    // Now it is contact. `plankLoad` is zero unless the skid blocks in the
    // plank are actually on the road, and the ride-height model that decides
    // that has downforce, fuel load, braking load transfer and kerb strikes in
    // it — the four things that ground a real car. See `VehiclePhysics`.
    //
    // SPEED IS STILL REQUIRED, but as a separate and honest condition: sparks
    // are struck by metal grinding along the road, so a car resting its floor
    // on the ground in the pit lane does not make any. It is a plain ramp from
    // 30 m/s rather than a term that can fire on its own.
    const grinding = p.plankLoad * clamp01((speed - 30) / 25);
    // Lightly low-passed, so the shower has some persistence over a crest
    // rather than switching off between two steps. Much shorter than the old
    // 0.86/0.14 filter, which took 13 frames to decay and smeared every strike
    // into the next one.
    fx.compression = fx.compression * 0.72 + grinding * 0.28;

    if (fx.compression > 0.02 && onTrack) {
      fx.sparkBudget += fx.compression * 90 * lod * dt;
      if (fx.sparkBudget >= 1) {
        const n = Math.min(6, Math.floor(fx.sparkBudget));
        fx.sparkBudget -= n;
        // From the end that is actually down. A car on its front skids under
        // braking throws sparks from under the nose; one bottoming at speed
        // drags them from the back of the floor.
        const along = p.frontPlankLoad > p.rearPlankLoad ? front * 0.5 : -rear * 0.4;
        this.particles.emitSparks(
          x + fwdX * along, y, z + fwdZ * along,
          vx, vz, fx.compression, n,
        );
      }
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

  /** Rain drops currently drawn, for the perf probe. */
  get rainDrops(): number {
    return this.rain.activeDrops;
  }

  dispose(): void {
    this.unload();
    this.particles.dispose();
    this.root.remove(this.rain.mesh);
    this.rain.dispose();
  }
}
