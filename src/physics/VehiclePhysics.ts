import { Vec2, clamp, clamp01, damp, MS_TO_KPH, wrapAngle } from '../core/MathUtils';
import { TireState } from './TireModel';
import type { CompoundId } from '../data/tires';
import type { VehicleSpec } from './VehicleSpec';

/**
 * Vehicle dynamics.
 *
 * A two-axle (bicycle) model solved in the car's local frame, with lateral
 * forces from slip angle through a magic-formula curve, longitudinal force from
 * an engine torque curve through a gearbox, and load transfer coupling the two.
 * There are no per-wheel colliders and no rigid-body solver — for a car on a
 * known road surface, the axle-level model captures everything that matters
 * (understeer, oversteer, lock-ups, traction limits, the friction circle) at a
 * fraction of the cost, which is what makes twenty cars at 120Hz viable on a
 * phone.
 *
 * The properties that make it feel like a real car rather than an arcade one:
 *
 *  - Grip is load-sensitive and load comes from downforce, so the car is planted
 *    at speed and nervous when slow. Braking from 300km/h decelerates at ~5g and
 *    the last 100km/h is where it runs out of grip.
 *  - Longitudinal load transfer means braking loads the front (helping it turn
 *    in) and throttle loads the rear (helping traction, hurting rotation).
 *  - Front and rear slip angles are independent, so understeer and oversteer are
 *    emergent states rather than flags.
 *  - The friction circle is enforced per axle: you cannot brake at the limit and
 *    turn at the limit simultaneously.
 *
 * ALLOCATION POLICY: nothing in `step()` allocates. Every vector is a
 * pre-allocated field. This runs 120 times a second for every car on track.
 */

/** Driver/AI control inputs for one physics step. */
export interface VehicleControls {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /**
   * Steering, -1 full LEFT .. +1 full RIGHT.
   *
   * Worth stating explicitly because the underlying frame is a trap. Three.js is
   * right-handed with +Y up, and a car whose nose points along +Z has its
   * driver's right toward -X, NOT +X. The internal lateral axis in this file is
   * (cos h, -sin h), which is +X at zero heading — that is the driver's LEFT. So
   * the steer input is negated where it becomes an angle, and positive steer
   * really does turn right.
   */
  steer: number;
  /** Requests DRS. Only honoured if `drsAvailable` and in a zone. */
  drsRequested: boolean;
  /** ERS deployment mode. */
  ersMode: ErsMode;
  /** Manual gear request, or 0 for automatic. */
  gearRequest: number;
  /** Pit limiter, engaged in the pit lane. */
  pitLimiter: boolean;
  /**
   * Requests reverse. Only engages once the car is nearly stopped, exactly like
   * a real gearbox — you cannot select reverse at 200 km/h.
   */
  reverse: boolean;
}

export type ErsMode = 'harvest' | 'balanced' | 'push' | 'overtake';

/** Deployment power fraction and harvest bias per mode. */
const ERS_MODES: Record<ErsMode, { deploy: number; harvest: number }> = {
  harvest: { deploy: 0.0, harvest: 1.4 },
  balanced: { deploy: 0.55, harvest: 1.0 },
  push: { deploy: 0.85, harvest: 0.8 },
  overtake: { deploy: 1.0, harvest: 0.6 },
};

/** Environmental state the physics reads but does not own. */
export interface EnvironmentState {
  /** Track surface temperature, °C. */
  trackTempC: number;
  airTempC: number;
  /** 0 dry .. 1 standing water. */
  wetness: number;
  /** Air density ratio vs sea level; altitude affects power and drag. */
  airDensityRatio: number;
  /** Circuit surface abrasion multiplier. */
  abrasion: number;
}

/** Surface the car is currently on. Set by the race sim from track projection. */
export type SurfaceType = 'track' | 'curb' | 'runoff' | 'grass' | 'gravel' | 'pitlane';

/** Grip multiplier and rolling drag per surface. */
const SURFACE_GRIP: Record<SurfaceType, number> = {
  track: 1.0,
  // A kerb takes about 15% of lateral grip and unsettles the platform.
  curb: 0.85,
  runoff: 0.82,
  grass: 0.42,
  gravel: 0.35,
  pitlane: 0.97,
};

const SURFACE_ROLL_DRAG: Record<SurfaceType, number> = {
  track: 1.0, curb: 1.6, runoff: 1.9, grass: 5.5, gravel: 9.0, pitlane: 1.0,
};

const G = 9.81;

export class VehiclePhysics {
  spec: VehicleSpec;
  /** The undamaged spec, so damage is applied to a stable baseline. */
  readonly baseSpec: VehicleSpec;

  // --- Kinematic state -----------------------------------------------------
  /** World position on the ground plane. */
  readonly position = new Vec2();
  /** World velocity, m/s. */
  readonly velocity = new Vec2();
  /** Heading, radians. 0 means facing +Z. */
  heading = 0;
  /** Yaw rate, rad/s. */
  yawRate = 0;

  /** Local-frame velocity: x is longitudinal (forward), y is lateral (left). */
  localVelX = 0;
  localVelY = 0;

  // --- Powertrain ----------------------------------------------------------
  gear = 1;
  rpm = 4000;
  /** True while reverse is engaged. */
  inReverse = false;
  /** Litres in the tank. */
  fuelL = 100;
  /** Battery charge, Joules. */
  batteryJ = 4_000_000;
  /** Energy deployed this lap, Joules — the regulation per-lap limit. */
  deployedThisLapJ = 0;

  private shiftTimer = 0;
  /** True while the gearbox is between gears and torque is cut. */
  get isShifting(): boolean { return this.shiftTimer > 0; }

  // --- Tires ---------------------------------------------------------------
  readonly frontTires = new TireState();
  readonly rearTires = new TireState();

  // --- Aero / environment inputs, set by the race sim each step ------------
  /**
   * Downforce multiplier from following another car. 1.0 = clean air.
   * Dropping this is what makes dirty air cost cornering speed.
   */
  dirtyAirDownforceMult = 1;
  /** Drag multiplier from slipstreaming. Below 1.0 = tow on the straight. */
  slipstreamDragMult = 1;
  /** True when the car is within 1s at a detection point and in a DRS zone. */
  drsAvailable = false;
  drsOpen = false;

  surface: SurfaceType = 'track';
  /** Banking angle of the surface under the car, radians. */
  bankingRad = 0;
  /** Longitudinal grade, positive uphill. */
  gradeRatio = 0;

  // --- Telemetry outputs ---------------------------------------------------
  /** Current downforce, Newtons. */
  currentDownforceN = 0;
  /** Current drag, Newtons. */
  currentDragN = 0;
  /** Lateral acceleration, g. */
  lateralG = 0;
  /** Longitudinal acceleration, g. Negative under braking. */
  longitudinalG = 0;
  /** Engine + ERS power currently being delivered, W. */
  powerOutputW = 0;
  /** ERS deployment power right now, W. */
  ersDeployW = 0;
  /** ERS harvest power right now, W. */
  ersHarvestW = 0;
  /** True when a wheel has locked under braking. */
  wheelsLocked = false;
  /** Magnitude of high-frequency vibration, 0..1, for camera shake and haptics. */
  vibration = 0;
  /** Understeer (negative) to oversteer (positive) balance, roughly -1..1. */
  balance = 0;
  /** Grip budget per axle from the last step, N. Feeds the pedal limits. */
  capFrontN = 0;
  capRearN = 0;
  /** Lateral force each axle is currently using, N. */
  frontLateralN = 0;
  rearLateralN = 0;
  /**
   * Contact-patch slip speed per axle, m/s.
   *
   * Already computed for the tire thermal model; published here because it is
   * the correct trigger for everything the player hears and sees when a tire
   * gives up. Smoke density, squeal volume and skid-mark opacity are all
   * functions of how fast rubber is moving across asphalt, so driving them from
   * this number means the effects agree with the physics instead of guessing
   * from steering angle.
   */
  frontSlipSpeed = 0;
  rearSlipSpeed = 0;
  /** Rear-axle wheelspin, 0..1: throttle demand beyond the traction limit. */
  wheelSpin = 0;

  /**
   * Throttle fraction at which the rear axle starts to spin up.
   *
   * The mirror of `brakeLimitFraction`. Now that exceeding grip costs grip (a
   * spinning tire delivers ~78% of peak), holding full throttle off the line is
   * slower than feeding it in — which is correct, and is why an F1 start is run
   * by a clutch and torque map rather than by flooring it. The AI and the
   * optional traction assist read this; a player without the assist can still
   * light up the rears and lose two tenths.
   */
  get tractionLimitFraction(): number {
    const spec = this.spec;

    // Longitudinal force the rear axle has left AFTER what cornering is already
    // using — the friction circle applied to the pedal rather than only to the
    // resulting force. An AI that ignores this floors the throttle mid-corner,
    // spends the rear's whole budget on acceleration, and spins.
    const cap = this.capRearN;
    const lat = this.rearLateralN;
    const remainingSq = cap * cap - lat * lat;
    const maxForce = remainingSq > 0 ? Math.sqrt(remainingSq) : 0;

    // Force the drivetrain would actually deliver at full throttle right now,
    // computed with the SAME min(torque, power) expression step() uses.
    //
    // Using only the power term is wrong at low speed, where the gearbox is
    // torque-limited: at 3 m/s in first gear the power term says 210kN and the
    // torque term says 78kN. Overestimating available force by 2.7x makes the
    // permitted throttle 2.7x too small, and a "modulated" launch ends up slower
    // than simply flooring it — the opposite of the intended behaviour.
    const gearRatio = spec.gearRatios[this.gear - 1] ?? spec.gearRatios[0];
    const totalPower = spec.icePowerW * torqueCurve(this.rpm / spec.redlineRpm) + spec.ersPowerW;
    const fromTorque =
      (totalPower / Math.max(this.rpm * 0.10472, 1)) * gearRatio * spec.driveEfficiency / spec.tireRadiusM;
    const fromPower = (totalPower * spec.driveEfficiency) / Math.max(Math.abs(this.localVelX), 3);
    const atFullThrottle = Math.min(fromTorque, fromPower);

    if (atFullThrottle <= 1) return 1;
    return clamp(maxForce / atFullThrottle, 0.02, 1);
  }

  /**
   * The brake pedal fraction at which the first axle starts to lock.
   *
   * There is no ABS in Formula 1 — the driver modulates the pedal, easing off as
   * downforce bleeds away so the fronts keep rotating. An AI that simply held
   * 100% brake would flat-spot its tires every corner and stop measurably later,
   * so the AI reads this and stays just underneath it. A human player can still
   * overdrive the pedal and lock up, which is the intended consequence.
   */
  get brakeLimitFraction(): number {
    const spec = this.spec;
    const front = spec.maxBrakeForceN * spec.brakeBalanceFront;
    const rear = spec.maxBrakeForceN * (1 - spec.brakeBalanceFront);
    if (front <= 1 || rear <= 1) return 1;
    // Same friction-circle reasoning as the traction limit: braking capacity is
    // what is left over from cornering, which is why you cannot brake at the
    // limit and turn at the limit at the same time.
    const fSq = this.capFrontN * this.capFrontN - this.frontLateralN * this.frontLateralN;
    const rSq = this.capRearN * this.capRearN - this.rearLateralN * this.rearLateralN;
    const fAvail = fSq > 0 ? Math.sqrt(fSq) : 0;
    const rAvail = rSq > 0 ? Math.sqrt(rSq) : 0;

    const limitFront = fAvail / front;
    const limitRear = rAvail / rear;
    return clamp(Math.min(limitFront, limitRear), 0.1, 1);
  }

  // --- Scratch (pre-allocated; step() must not allocate) -------------------
  private readonly fwd = new Vec2();
  private readonly right = new Vec2();
  private readonly accel = new Vec2();
  /** Per-axle friction-circle scales. One object each — they must not alias. */
  private readonly frontScale: CircleScale = { lon: 1, lat: 1 };
  private readonly rearScale: CircleScale = { lon: 1, lat: 1 };

  private vibrationPhase = 0;

  constructor(spec: VehicleSpec, startCompound: CompoundId = 'medium') {
    this.spec = spec;
    this.baseSpec = spec;
    this.fuelL = Math.min(spec.fuelCapacityL, 100);
    this.batteryJ = spec.batteryCapacityJ;
    this.frontTires.fit(startCompound, 80);
    this.rearTires.fit(startCompound, 80);
  }

  // =========================================================================
  // Derived quantities
  // =========================================================================

  /** Total mass including fuel, kg. The car gets faster as the tank empties. */
  get totalMassKg(): number {
    return this.spec.dryMassKg + this.fuelL * this.spec.fuelDensity;
  }

  /** Speed in m/s. */
  get speedMs(): number {
    // Explicit sqrt: Math.hypot allocates in V8's variadic path.
    const vx = this.velocity.x, vy = this.velocity.y;
    return Math.sqrt(vx * vx + vy * vy);
  }

  /** Speed in km/h — the number on the HUD. */
  get speedKph(): number {
    return this.speedMs * MS_TO_KPH;
  }

  /** Forward speed only; negative when rolling backwards. */
  get forwardSpeedMs(): number {
    return this.localVelX;
  }

  /** Combined tire grip as a percentage, for the HUD. */
  get tireGripPercentage(): number {
    return ((this.frontTires.grip + this.rearTires.grip) * 0.5) * 100;
  }

  /** Litres remaining. */
  get fuelRemaining(): number {
    return this.fuelL;
  }

  /** Battery state of charge, 0..1. */
  get ersChargePercent(): number {
    return clamp01(this.batteryJ / this.spec.batteryCapacityJ);
  }

  /** Fraction of redline, for the shift lights. */
  get rpmFraction(): number {
    return clamp01(this.rpm / this.spec.redlineRpm);
  }

  // =========================================================================
  // Placement
  // =========================================================================

  /** Places the car, zeroing its motion. Used for grid slots and resets. */
  placeAt(x: number, z: number, heading: number, speedMs = 0): void {
    this.position.set(x, z);
    this.heading = heading;
    this.velocity.set(Math.sin(heading) * speedMs, Math.cos(heading) * speedMs);
    this.localVelX = speedMs;
    this.localVelY = 0;
    this.yawRate = 0;
    this.gear = speedMs > 5 ? 3 : 1;
    this.shiftTimer = 0;
  }

  /** Refuels and fits fresh tires. Called on a pit stop. */
  serviceCar(compound: CompoundId, addFuelL: number, blanketTempC: number): void {
    this.fuelL = Math.min(this.spec.fuelCapacityL, this.fuelL + addFuelL);
    this.frontTires.fit(compound, blanketTempC);
    this.rearTires.fit(compound, blanketTempC);
  }

  /** Resets the per-lap ERS deployment allowance. */
  onLapComplete(): void {
    this.deployedThisLapJ = 0;
    this.frontTires.onLapComplete();
    this.rearTires.onLapComplete();
  }

  // =========================================================================
  // The physics step
  // =========================================================================

  /**
   * Advances one fixed timestep.
   * @param dt fixed physics timestep in seconds (see PHYSICS_DT)
   */
  step(dt: number, c: VehicleControls, env: EnvironmentState): void {
    const spec = this.spec;
    const mass = this.totalMassKg;

    // --- Frame vectors -----------------------------------------------------
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    this.fwd.set(sinH, cosH);
    // Right-hand normal of the forward vector.
    this.right.set(cosH, -sinH);

    // Project world velocity into the car frame.
    let vx = this.velocity.x * this.fwd.x + this.velocity.y * this.fwd.y;
    let vy = this.velocity.x * this.right.x + this.velocity.y * this.right.y;
    this.localVelX = vx;
    this.localVelY = vy;

    const speed = Math.sqrt(vx * vx + vy * vy);
    const absVx = Math.abs(vx);

    // --- Aerodynamics ------------------------------------------------------
    // Downforce and drag both scale with v^2. Dirty air cuts downforce hard and
    // drag a little, which is precisely why a following car corners worse but
    // reaches a higher top speed.
    const q = speed * speed * env.airDensityRatio;

    this.drsOpen = c.drsRequested && this.drsAvailable && c.brake < 0.05;
    const drsDragMult = this.drsOpen ? 1 - spec.drsDragReduction : 1;
    const drsDfMult = this.drsOpen ? 1 - spec.drsDownforceLoss : 1;

    const downforceN = spec.clBase * q * drsDfMult * this.dirtyAirDownforceMult;
    const dragN = spec.cdBase * q * drsDragMult * this.slipstreamDragMult;
    this.currentDownforceN = downforceN;
    this.currentDragN = dragN;

    // --- Vertical loads ----------------------------------------------------
    const weightN = mass * G;
    const staticFrontFrac = 1 - spec.cogToFrontM / spec.wheelbaseM;
    const staticFront = weightN * staticFrontFrac;
    const staticRear = weightN - staticFront;

    const aeroFront = downforceN * spec.aeroBalanceFront;
    const aeroRear = downforceN - aeroFront;

    // Longitudinal load transfer from the previous step's acceleration. Using
    // last frame's value avoids an implicit solve and is stable at 120Hz.
    const transferN = (this.longitudinalG * G * mass * spec.cogHeightM) / spec.wheelbaseM;

    let loadFront = staticFront + aeroFront - transferN;
    let loadRear = staticRear + aeroRear + transferN;
    // A wheel cannot pull down on the road.
    if (loadFront < 0) loadFront = 0;
    if (loadRear < 0) loadRear = 0;

    // --- Surface and tire grip --------------------------------------------
    const surfaceGrip = SURFACE_GRIP[this.surface];
    const muFront = spec.baseMu * this.frontTires.grip * surfaceGrip;
    const muRear = spec.baseMu * this.rearTires.grip * surfaceGrip;

    // --- Steering ---------------------------------------------------------
    // Speed-sensitive steering limit — the rack, not an assist.
    //
    // The number this has to respect is the slip angle at which the front tire
    // peaks: alpha = 1.978 / corneringStiffnessFront, about 9 degrees. Steering
    // past that does not turn the car harder, it turns it LESS, because the
    // magic formula is on its falling branch. A steer sweep (`npm run
    // probe:handling`) put peak lateral at 0.40 of full input at 150km/h and
    // 0.30 at 300km/h, and showed full lock at 300km/h throwing away 26% of the
    // available cornering force. That is precisely the "I'm at full lock and it
    // won't turn" complaint, and no amount of extra lock fixes it.
    //
    // So the rack is geared as a real speed-sensitive rack is — a hyperbola in
    // speed — sized so full stick lands roughly 40% PAST the peak-grip angle.
    // That leaves room to overdrive the front and to countersteer a slide, but
    // removes the range where more input means less cornering.
    //
    // Full lock is untouched below 50km/h. Monaco's Grand Hotel hairpin is an
    // 11m radius and needs atan(wheelbase/radius) = 18 degrees to geometrically
    // fit; taper any earlier and the car physically cannot make the corner.
    const steerLimit = 1 / (1 + Math.max(0, speed - 14) * 0.036);
    // Negated: see the note on VehicleControls.steer. The internal lateral axis
    // points to the driver's LEFT, so a right-hand steer input must produce a
    // negative steer angle. Without this, the arrow keys are inverted.
    const steerAngle = -c.steer * spec.maxSteerRad * steerLimit;

    // --- Slip angles -------------------------------------------------------
    // Below walking pace the atan2 formulation is ill-conditioned, so blend the
    // slip angles out and let the low-speed kinematic path take over.
    const slipBlend = clamp01((absVx - 0.6) / 2.4);
    const vRef = Math.max(absVx, 1.2);

    const alphaFront = (Math.atan2(vy + this.yawRate * spec.cogToFrontM, vRef) - steerAngle) * slipBlend;
    const rearArm = spec.wheelbaseM - spec.cogToFrontM;
    const alphaRear = Math.atan2(vy - this.yawRate * rearArm, vRef) * slipBlend;

    this.frontTires.slipAngle = Math.abs(alphaFront);
    this.rearTires.slipAngle = Math.abs(alphaRear);

    // --- Lateral forces ----------------------------------------------------
    // Magic-formula shape: rises steeply, peaks near the optimal slip angle,
    // then falls away. The falling side is what makes a slide recoverable only
    // by reducing steering angle, exactly as in a real car.
    const fyFront = -magicFormula(alphaFront, spec.corneringStiffnessFront) * muFront * loadFront;
    const fyRear = -magicFormula(alphaRear, spec.corneringStiffnessRear) * muRear * loadRear;

    // --- Longitudinal: engine ---------------------------------------------
    this.updateGearbox(dt, c, vx);

    let driveForce = 0;
    this.ersDeployW = 0;
    this.ersHarvestW = 0;
    this.powerOutputW = 0;

    const throttle = clamp01(c.throttle);

    // --- Reverse ----------------------------------------------------------
    // Engages only below walking pace, as a real gearbox does, and is
    // deliberately feeble: reverse exists to recover from a spin or a gravel
    // trap, not to be driven.
    this.inReverse = c.reverse && vx < 1.2 && vx > -8;
    if (this.inReverse) {
      const reverseForce = 5200 * clamp01(Math.max(throttle, c.brake));
      driveForce = -reverseForce;
      this.fuelL = Math.max(0, this.fuelL - 0.004 * dt);
      this.gear = -1;
    } else if (this.shiftTimer <= 0 && throttle > 0.001 && this.fuelL > 0.01) {
      const gearRatio = spec.gearRatios[this.gear - 1] ?? spec.gearRatios[0];
      const icePower = spec.icePowerW * torqueCurve(this.rpm / spec.redlineRpm) * throttle * env.airDensityRatio;

      // ERS deployment, limited by mode, charge, and the 4MJ-per-lap rule.
      const mode = ERS_MODES[c.ersMode] ?? ERS_MODES.balanced;
      let deployW = spec.ersPowerW * mode.deploy * throttle;
      if (this.batteryJ <= 0 || this.deployedThisLapJ >= spec.batteryCapacityJ) deployW = 0;
      // No point deploying at low speed where traction, not power, is the limit.
      if (speed < 12) deployW *= 0.35;

      const totalPower = icePower + deployW;
      this.powerOutputW = totalPower;
      this.ersDeployW = deployW;

      this.batteryJ = Math.max(0, this.batteryJ - deployW * dt);
      this.deployedThisLapJ += deployW * dt;

      // Force from power, capped by the torque the gearbox can actually put
      // down at this speed. The cap is what limits first-gear acceleration.
      const wheelForceFromTorque =
        (totalPower / Math.max(this.rpm * 0.10472, 1)) * gearRatio * spec.driveEfficiency / spec.tireRadiusM;
      const wheelForceFromPower = (totalPower * spec.driveEfficiency) / Math.max(absVx, 3);
      driveForce = Math.min(wheelForceFromTorque, wheelForceFromPower);

      const burn = spec.peakFuelBurnLps * throttle * (0.35 + 0.65 * this.rpmFraction);
      this.fuelL = Math.max(0, this.fuelL - burn * dt);
    }

    // --- Longitudinal: brakes ---------------------------------------------
    const brake = clamp01(c.brake);
    let brakeForceFront = 0;
    let brakeForceRear = 0;
    // While reversing, the brake pedal is what drives it (see above), so it must
    // not also be applied as a brake or the car would never move.
    if (!this.inReverse && brake > 0.001 && absVx > 0.15) {
      const total = spec.maxBrakeForceN * brake;
      brakeForceFront = total * spec.brakeBalanceFront;
      brakeForceRear = total * (1 - spec.brakeBalanceFront);

      // Harvest under braking. The MGU-K recovers from the rear axle, which is
      // why harvesting reduces the rear brake's mechanical share.
      const mode = ERS_MODES[c.ersMode] ?? ERS_MODES.balanced;
      const harvestW = Math.min(
        spec.maxHarvestW * mode.harvest * brake,
        (spec.batteryCapacityJ - this.batteryJ) / dt,
      );
      if (harvestW > 0) {
        this.ersHarvestW = harvestW;
        this.batteryJ = Math.min(spec.batteryCapacityJ, this.batteryJ + harvestW * dt);
      }
    }

    // Pit limiter: a hard speed cap, enforced as braking rather than as a
    // teleport, so overshooting the limit still triggers a penalty.
    if (c.pitLimiter) {
      const limitMs = 80 / 3.6;
      if (vx > limitMs) {
        driveForce = 0;
        brakeForceRear += (vx - limitMs) * mass * 2.2;
      }
    }

    // --- Friction circle ---------------------------------------------------
    // Each axle has one grip budget shared between turning and accelerating.
    // Enforcing it per axle is what produces understeer on throttle, oversteer
    // on trailing throttle, and the inability to brake and turn at full commit.
    const capFront = muFront * loadFront;
    const capRear = muRear * loadRear;

    let fxFront = -brakeForceFront;
    let fxRear = driveForce - brakeForceRear;

    frictionCircleScale(fxFront, fyFront, capFront, this.frontScale);
    frictionCircleScale(fxRear, fyRear, capRear, this.rearScale);

    const fyFrontFinal = fyFront * this.frontScale.lat;
    const fyRearFinal = fyRear * this.rearScale.lat;
    fxFront *= this.frontScale.lon;
    fxRear *= this.rearScale.lon;

    // --- Lock-up detection -------------------------------------------------
    // A wheel locks when brake demand exceeds what the tire can transmit. The
    // friction circle above has already capped the force, so this only records
    // the consequence: vibration, a flat spot, and lost stopping power.
    this.wheelsLocked = false;
    if (brake > 0.1 && absVx > 3) {
      const frontExcess = brakeForceFront / Math.max(capFront, 1) - 1;
      const rearExcess = brakeForceRear / Math.max(capRear, 1) - 1;
      if (frontExcess > 0.04) {
        this.wheelsLocked = true;
        this.frontTires.flatSpot(frontExcess, dt);
      }
      if (rearExcess > 0.04) {
        this.wheelsLocked = true;
        this.rearTires.flatSpot(rearExcess, dt);
      }
    }

    // Cached for the pedal limits, which the AI and the driving assists read.
    this.capFrontN = capFront;
    this.capRearN = capRear;
    this.frontLateralN = Math.abs(fyFrontFinal);
    this.rearLateralN = Math.abs(fyRearFinal);

    // --- Resistive forces --------------------------------------------------
    const rollDrag = 220 * SURFACE_ROLL_DRAG[this.surface] * Math.sign(vx || 1);
    // Gravity component along the slope. Uphill costs, downhill gains.
    const gradeForce = -weightN * this.gradeRatio;
    // Banking adds lateral support toward the inside of the corner.
    const bankForce = weightN * Math.sin(this.bankingRad);

    const totalFx = fxFront + fxRear - dragN * Math.sign(vx || 1) - rollDrag + gradeForce;
    const totalFy = fyFrontFinal + fyRearFinal + bankForce;

    // --- Integrate ---------------------------------------------------------
    // Specific force, i.e. what an accelerometer bolted to the chassis reads.
    const ax = totalFx / mass;
    const ay = totalFy / mass;

    // Body-frame equations of motion for a rotating rigid body:
    //
    //     m (vx_dot - r vy) = Fx
    //     m (vy_dot + r vx) = Fy
    //
    // The `r * v` terms are the coupling between yaw rate and body velocity.
    // Omitting them is a real error, not a simplification: without them the
    // velocity vector cannot rotate independently of the chassis, so the car is
    // incapable of sliding and steady-state cornering settles at zero lateral
    // force instead of the centripetal value.
    vx += (ax + this.yawRate * vy) * dt;
    vy += (ay - this.yawRate * vx) * dt;

    // Yaw: moment from the lateral forces about the CoG, over yaw inertia.
    const yawInertia = mass * 1.42; // approximated for an F1 mass distribution
    const yawMoment = fyFrontFinal * spec.cogToFrontM * Math.cos(steerAngle) - fyRearFinal * rearArm;
    this.yawRate += (yawMoment / yawInertia) * dt;

    // Yaw damping. Real cars have aero yaw stiffness that grows with speed;
    // without it the model oscillates at the integration frequency.
    //
    // The rate matters far more than it looks. This is a torque the tires have
    // to fight, and at the old 2.4 + 0.055v it reached 5.8/s at 220km/h — worth
    // about 4 rad/s^2 of yaw acceleration, which the FRONT axle alone had to
    // supply because the rear's contribution acts the other way. Measured with
    // `npm run probe:handling`, that pinned front utilisation at 0.96-1.00 from
    // barely a third of a turn of lock while the rear idled at 0.77: the car
    // understeered permanently, could not be made to rotate by adding steering,
    // and was slow everywhere. Halving it hands that grip back — peak lateral
    // rises about 3% and, more importantly, the two axles now work together
    // instead of the front fighting a torque nothing physical produces.
    //
    // It cannot go much lower. Below roughly 1.4 + 0.02v a power-on slide at
    // 90km/h becomes uncatchable even with correctly-timed countersteer, which
    // is the "it just spins" failure rather than a car that can be driven.
    const yawDampRate = 1.8 + speed * 0.032;
    this.yawRate = damp(this.yawRate, 0, yawDampRate, dt);

    // At a standstill, kill residual lateral velocity and yaw so the car settles
    // instead of creeping.
    if (speed < 0.35 && throttle < 0.02) {
      vx = damp(vx, 0, 8, dt);
      vy = damp(vy, 0, 12, dt);
      this.yawRate = damp(this.yawRate, 0, 12, dt);
    }

    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    // Body velocity back to world space using the new heading basis.
    const sinH2 = Math.sin(this.heading);
    const cosH2 = Math.cos(this.heading);
    this.velocity.set(vx * sinH2 + vy * cosH2, vx * cosH2 - vy * sinH2);

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;

    this.localVelX = vx;
    this.localVelY = vy;

    // --- Telemetry ---------------------------------------------------------
    this.longitudinalG = ax / G;
    this.lateralG = ay / G;
    this.accel.set(ax, ay);

    // Balance: which axle is closer to its limit. Positive = rear giving up.
    const frontUse = Math.abs(fyFront) / Math.max(capFront, 1);
    const rearUse = Math.abs(fyRear) / Math.max(capRear, 1);
    this.balance = clamp(rearUse - frontUse, -1.5, 1.5);

    // --- Tire thermal and wear update -------------------------------------
    // Slip speed at the contact patch drives both heating and wear.
    const frontSlipSpeed = Math.abs(alphaFront) * vRef + Math.abs(fxFront) / Math.max(capFront, 1) * 2.2;
    const rearSlipSpeed = Math.abs(alphaRear) * vRef + Math.abs(fxRear) / Math.max(capRear, 1) * 3.0;
    this.frontSlipSpeed = frontSlipSpeed;
    this.rearSlipSpeed = rearSlipSpeed;

    // Wheelspin: throttle asked for more than the rear axle can put down. The
    // traction limit is already derived from live grip and downforce, so this
    // lights up on corner exit and off the line, and not on a flat-out straight
    // where the same throttle is comfortably within budget.
    const tractionLimit = this.tractionLimitFraction;
    this.wheelSpin = c.throttle > tractionLimit
      ? clamp01((c.throttle - tractionLimit) / Math.max(1 - tractionLimit, 0.05))
      : 0;

    this.frontTires.update(dt, frontSlipSpeed, loadFront, staticFront, env.trackTempC, env.wetness, env.abrasion);
    this.rearTires.update(dt, rearSlipSpeed, loadRear, staticRear, env.trackTempC, env.wetness, env.abrasion);

    // --- Vibration ---------------------------------------------------------
    // Kerbs produce a high-frequency oscillation; lock-ups produce a lower one.
    let targetVib = 0;
    if (this.surface === 'curb') targetVib = 0.85;
    else if (this.surface === 'grass' || this.surface === 'gravel') targetVib = 0.55;
    else if (this.surface === 'runoff') targetVib = 0.3;
    if (this.wheelsLocked) targetVib = Math.max(targetVib, 0.65);
    targetVib *= clamp01(speed / 20);

    this.vibrationPhase += dt * (this.surface === 'curb' ? 62 : 24);
    this.vibration = damp(this.vibration, targetVib, 14, dt) * (0.65 + 0.35 * Math.sin(this.vibrationPhase));
  }

  // =========================================================================
  // Gearbox
  // =========================================================================

  private updateGearbox(dt: number, c: VehicleControls, vx: number): void {
    const spec = this.spec;

    if (this.inReverse) {
      this.rpm = clamp(Math.abs(vx) / spec.tireRadiusM * spec.reverseRatio * 9.5493,
        spec.idleRpm, spec.redlineRpm * 0.5);
      return;
    }

    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      return;
    }

    const gearRatio = spec.gearRatios[this.gear - 1] ?? spec.gearRatios[0];
    // Engine speed implied by road speed in the current gear.
    const wheelRadPerS = Math.abs(vx) / spec.tireRadiusM;
    this.rpm = clamp(wheelRadPerS * gearRatio * 9.5493, spec.idleRpm, spec.redlineRpm);

    if (c.gearRequest > 0) {
      const want = clamp(Math.round(c.gearRequest), 1, spec.gearRatios.length);
      if (want !== this.gear) this.shiftTo(want);
      return;
    }

    // Automatic shifting. Upshift near the limiter, downshift when the engine
    // would fall below the torque peak, with hysteresis so it cannot hunt.
    const frac = this.rpm / spec.redlineRpm;
    if (frac > 0.985 && this.gear < spec.gearRatios.length) {
      this.shiftTo(this.gear + 1);
    } else if (frac < 0.58 && this.gear > 1) {
      // Check the lower gear would not immediately hit the limiter.
      const lower = spec.gearRatios[this.gear - 2];
      const projected = wheelRadPerS * lower * 9.5493;
      if (projected < spec.redlineRpm * 0.96) this.shiftTo(this.gear - 1);
    }
  }

  private shiftTo(gear: number): void {
    this.gear = gear;
    // Seamless-shift gearboxes are quick but not instant.
    this.shiftTimer = 0.035;
  }
}

/**
 * Normalised engine torque vs fraction of redline.
 *
 * A turbocharged V6 pulls hard from mid-range and holds close to peak up to the
 * limiter. Modelled as a skewed parabola peaking at ~72% of redline and never
 * falling below 0.62, which is why an F1 car can short-shift without losing much.
 */
function torqueCurve(rpmFrac: number): number {
  const f = clamp01(rpmFrac);
  // Below idle-ish the turbo has not spooled.
  if (f < 0.24) return 0.38 + (f / 0.24) * 0.34;
  const peak = 0.72;
  const d = (f - peak) / (f > peak ? 0.42 : 0.5);
  return clamp(1 - d * d * 0.38, 0.62, 1);
}

/**
 * Normalised lateral force vs slip angle.
 *
 * A Pacejka-style curve reduced to its essential shape: linear at small angles,
 * peaking around 0.14 rad (8 degrees), then falling to a lower plateau. The
 * falling branch is what makes a slide progressive instead of binary — beyond
 * the peak, adding steering angle *reduces* cornering force.
 */
function magicFormula(alpha: number, stiffness: number): number {
  // sin(C * atan(B * a)) with C just above 1 produces the peak-then-fall shape.
  const B = stiffness;
  const C = 1.42;
  const D = 1.0;
  return D * Math.sin(C * Math.atan(B * alpha));
}

/**
 * Result of clamping a force pair into the friction circle.
 * Written into a caller-owned object — returning a shared module-level scratch
 * would alias between the front and rear axle calls and silently give the front
 * axle the rear's scale factors.
 */
export interface CircleScale { lon: number; lat: number }

/**
 * Enforces the friction circle on one axle, writing into `out`.
 *
 * If the combined longitudinal and lateral demand exceeds the grip budget, both
 * are scaled back. Longitudinal is given slight priority under braking because
 * that is what a real tire does — you keep stopping and lose the ability to turn,
 * which is why locking the fronts means going straight on at the corner.
 */
function frictionCircleScale(fx: number, fy: number, cap: number, out: CircleScale): void {
  const demand = Math.sqrt(fx * fx + fy * fy);
  if (cap <= 1 || demand <= cap) {
    out.lon = 1;
    out.lat = 1;
    return;
  }

  // Past the limit the tire is sliding, and a sliding tire has LOWER friction
  // than one held at its optimal slip — roughly 78% of peak once fully locked.
  //
  // This is the single most important detail in the whole braking model. Without
  // it, exceeding the grip budget still delivers the full budget, so standing on
  // the brake pedal is mathematically optimal and modulation is worthless. With
  // it, over-braking genuinely costs stopping distance, which is why real drivers
  // ease off as downforce bleeds away and why locking up loses lap time.
  const excess = demand / cap - 1;
  const slide = 1 - Math.min(0.22, excess * 0.55);
  const achieved = cap * slide;

  const s = achieved / demand;
  const braking = fx < 0;
  out.lon = braking ? Math.min(1, s * 1.12) : s;
  out.lat = braking ? s * 0.9 : s;
}
