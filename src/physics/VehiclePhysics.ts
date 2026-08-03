import { Vec2, clamp, clamp01, damp, MS_TO_KPH, wrapAngle } from '../core/MathUtils';
import { TireState } from './TireModel';
import type { CompoundId } from '../data/tires';
import type { VehicleSpec } from './VehicleSpec';
import { PIT_LIMITER_MAX_DECEL_G } from './PitLimiter';

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
   * A speed cap from somewhere other than the pit lane, m/s. 0 for none.
   *
   * The same limiter, pointed at a different number. A neutralisation is a speed
   * limit the driver is required to obey exactly as the pit lane's is — "stay
   * above the minimum time set by the FIA ECU" (2025 Art. 55.7 and 56.5 / 2026
   * Art. B5.13.2b and B5.12.2b) — and the player's is applied for them for the
   * same reason the pit one is: a limit the game presses the button for is a
   * limit the game owes the driver an arrival at.
   *
   * Kept separate from `pitLimiter` rather than folded into it because the two
   * can be in force at once — a car serving a stop under a safety car is under
   * both — and the lower of them has to win. See `NeutralisedLimiter.ts`.
   */
  speedLimitMs: number;
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
  /**
   * 0 dry .. 1 standing water, AT THE POSITION THIS CAR OCCUPIES.
   *
   * Not a session-wide scalar any more. A wet track is wet unevenly — deeper
   * where it drains badly, shallower on the line the cars have been pumping
   * clear — and the whole reason wet running looks the way it does is that a
   * driver can move sideways and find a different number here. The race engine
   * writes this per car, per step, from `TrackSurface`.
   */
  wetness: number;
  /**
   * A direct multiplier on tyre grip from what the surface itself is made of,
   * as distinct from how much water is lying on it. 1.0 is clean asphalt.
   *
   * This is where laid-down rubber lives, and it is the reason the fast line on
   * a soaked track is not the dry line. Rubber under water is slick in a way
   * the wet-grip curve knows nothing about, because the wet-grip curve is a
   * property of the TYRE and this is a property of the ROAD. Off the line the
   * surface is abrasive and unrubbered — worse when dry, because it is dusty
   * and collects marbles, and better when flooded.
   */
  surfaceGrip: number;
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

// --- Barrier contact ------------------------------------------------------
/** Restitution for a pure graze, where the velocity is parallel to the wall. */
const BARRIER_RESTITUTION_GRAZE = 0.12;
/** Restitution for a square-on hit, before the plastic-deformation fade. */
const BARRIER_RESTITUTION_SQUARE = 0.55;
/**
 * How fast restitution falls with closing speed, per m/s.
 *
 * Barriers are energy absorbers, so a light knock is springy and a heavy one is
 * not. At 3 m/s a square hit gives back 47% of the closing speed; at 22 m/s,
 * only 24% — and by then the car is written off anyway.
 */
const BARRIER_PLASTIC_FADE = 0.06;
/** Closing speed, m/s, that counts as a full-severity impact. */
const BARRIER_WRITE_OFF_MS = 22;
/** Speed lost per second while scraping along a barrier: e^-0.5 is about 40%. */
const BARRIER_SCRAPE_RATE = 0.5;
/** Rotation damped per second while in contact with a barrier. */
const BARRIER_YAW_DAMP_RATE = 2.5;
/** Below this speed, m/s, a car held against a wall is simply stopped. */
const BARRIER_REST_MS = 0.4;

/**
 * Sideslip-damper rate, 1/s, and its growth with speed. See the block in
 * `step()` for what this damps and, more importantly, what it does not.
 *
 * Because the damper is now one-sided and referenced to the path rather than to
 * zero, this number no longer trades against cornering grip — it only sets how
 * quickly a slide is arrested. It can therefore be strong enough to keep the car
 * catchable without costing anything in a steady corner, which was not true of
 * the version that damped toward zero.
 */
const YAW_DAMP_BASE = 1.8;
const YAW_DAMP_PER_V = 0.032;

/**
 * Tyre relaxation length, metres, per axle.
 *
 * A tyre does not develop a slip angle the instant the wheel is steered. The
 * carcass has to wind up, and it does so over a DISTANCE rolled rather than a
 * time elapsed — which is why the lag disappears at speed and dominates when the
 * car is slow. The standard first-order form is
 *
 *     d(alpha)/dt = (v / sigma) * (alpha_steady - alpha)
 *
 * with sigma the relaxation length: 0.4-0.8m for a racing tyre.
 *
 * This model had NO relaxation at all, and its absence is the single largest
 * reason the car felt twitchy. Without it every tyre force is an instantaneous
 * algebraic function of the current state, so a steering input, a kerb strike or
 * a friction-circle overload changes the lateral force COMPLETELY within one
 * 8ms step. Nothing on a real car does that. The consequences the probe
 * measured, all of which are gone with this in:
 *
 *   - Turn-in overshot the settled yaw rate by 17-31% and then rang, because
 *     there was nothing between the driver's hands and the yaw moment.
 *   - Yaw disturbances with the steering held still decayed at 0.16/s at 300km/h
 *     — over six seconds to die away — and the car rang the whole time.
 *   - A departure took 0.12-0.32s from "past the peak slip angle" to "gone",
 *     which is inside a human reaction time. There was no warning because there
 *     was no lag: the car arrived at the far side of the tyre curve immediately.
 *
 * The rear is given a slightly longer relaxation length than the front, which is
 * the usual measured ordering (bigger tyre, more carcass to wind up), and has the
 * side effect the driver wants: the front takes its bite fractionally before the
 * rear follows, so the car rotates into the corner rather than pushing.
 */
const RELAX_LENGTH_FRONT_M = 0.55;
const RELAX_LENGTH_REAR_M = 0.70;
/**
 * Floor on the relaxation RATE, 1/s.
 *
 * v/sigma goes to zero at a standstill, which would freeze the slip angle at
 * whatever it last held and leave a parked car generating cornering force
 * forever. The slip angles are already blended out below walking pace, so this
 * only has to stop the state from sticking.
 */
const RELAX_RATE_MIN = 3;

/**
 * How fast the power unit actually delivers what the throttle asked for, 1/s.
 *
 * A 1.6-litre turbocharged V6 does not make its boost instantly. Off-boost at
 * low crank speed the turbine has to be spun up, and even with an electric MGU-H
 * assisting it that takes a meaningful fraction of a second; near the limiter
 * the boost is already there and the response is essentially immediate. On top
 * of that sits driveline wind-up through the gearbox, driveshafts and the tyre's
 * own longitudinal carcass compliance, none of which are instant either.
 *
 * The model had none of this: `driveForce` was an algebraic function of the
 * throttle in the same step, so the rear axle's entire longitudinal demand
 * appeared in one 8ms tick. At 90km/h in a corner that is the difference between
 * a car that lights its rears up progressively and one that snaps into a spin
 * with no warning at all. Measured: 0.70 throttle at 90km/h at 90% of the
 * lateral limit took the rear from 4.9 to 8.9 degrees of slip in 100ms and to a
 * completed spin in under a second, and the catchability sweep recovered ZERO of
 * thirty-six cases. That is the "randomly starts over steering and makes some
 * goofy donuts" complaint, and it is not the driver's fault: the car gave him a
 * hundred milliseconds.
 *
 * Rate rather than time constant so it composes with `damp()`. 8/s near the
 * limiter is a 0.12s rise; 3.2/s off-boost is 0.31s, which is what a turbo
 * actually does. Steady-state output is unchanged, so top speed, the power
 * curve and the acceleration figures are all untouched — only the first third of
 * a second after a throttle movement is different.
 */
const BOOST_RATE_OFF = 4.5;
const BOOST_RATE_ON = 9.0;
/**
 * Closing the throttle is much quicker than opening it — there is no boost to
 * build, just a butterfly shutting. Asymmetric on purpose: a lift has to take
 * effect promptly or the car ignores the one input the driver reaches for when
 * it starts to go.
 */
const BOOST_RATE_CLOSING = 22.0;

/**
 * How fast the rack gears down with speed, per m/s above walking pace.
 *
 * The number this has to respect is the slip angle at which the front tire
 * peaks: alpha = 1.978 / corneringStiffnessFront, about 9.1 degrees. Past that
 * the tire is on the falling branch and, much more importantly, it is over its
 * friction circle — where `frictionCircleScale` takes up to 22% away for
 * sliding. Steering beyond the peak therefore does not turn the car harder, it
 * turns it LESS.
 *
 * At the old 0.020 the taper was far too gentle to do its job. Full lock put the
 * front tire at 12.5 degrees of slip at 260km/h and 17.5 at 80km/h — up to
 * DOUBLE the peak — so the top half of the steering range was not merely wasted
 * but actively harmful: a steer sweep at 260km/h peaked at 4.07g around half
 * input and fell to 3.11g at full lock, throwing away a quarter of the car's
 * cornering ability, and yaw rate fell with it. That is exactly the "I'm at full
 * lock and it won't turn" complaint, and no amount of extra lock fixes it.
 *
 * 0.050 puts full lock at 8.7-10.4 degrees of front slip at racing speed, at or
 * just past the peak instead of double it. The same sweep now falls only 2-4%
 * from its peak to full lock, so more steering means more rotation all the way
 * to the grip limit and then plateaus, which is what a car does.
 *
 * This could not be raised before, and the reason is worth recording because it
 * was not a physics problem. The AI's steering rate limiter and its counter-steer
 * gain were both expressed in INPUT units, so tightening the rack silently
 * halved how fast the AI could turn the wheel and how much authority its slide
 * correction had — it ran wide everywhere and the change was reverted as a
 * failure. Both are now expressed as road-wheel ANGLES (see `slewSteer` in
 * AIVehicleController), which decouples the rack ratio from the driver's hands
 * and lets this be geared for the tire.
 *
 * Full lock is untouched below 50km/h. Monaco's Grand Hotel hairpin is an 11m
 * radius and needs atan(wheelbase/radius) = 18 degrees to geometrically fit;
 * taper any earlier and the car physically cannot make the corner. Measured
 * minimum radius is unchanged at 8.4m at 30km/h and 8.8m at 40km/h, and between
 * 60 and 100km/h the tighter rack makes the car turn TIGHTER, not wider, because
 * the front tire is no longer being pushed past its peak.
 *
 * 0.050 did not finish the job, and `probe:drivability` says where it stopped.
 * The quasi-static lock ramp reports the steering input at which lateral g
 * peaks, and at 0.050 that was 0.69 at 90km/h and 0.77 at 150 and 220. So the
 * last quarter to third of the rack produced NOTHING: the front tyre went from
 * 9.1 degrees of slip at peak g to 13.9 at full lock, and the car returned
 * 97-99% of its peak g the whole way. That is a driver hauling on more lock and
 * feeling the car do nothing, which is the other half of "it's literally gliding
 * when the user turns" — not a lack of grip, a third of the steering range that
 * is inert.
 *
 * 0.062 puts peak g at 0.74 of the rack at 90km/h and 0.82-0.89 from 150 to 300,
 * so nearly all of the stick travel changes the car and the last of it puts the
 * front tyre at its peak rather than half again past it. Peak lateral g is
 * unchanged to within 0.5%.
 *
 * The ceiling is set by the AI, not by the tyre, and this is the honest limit of
 * how far this can go without touching a controller this session does not own.
 * `AIVehicleController` converts its demanded road-wheel angle back to input
 * with `steerRad / (maxSteerRad * steerRackLimit(speed))` and then clamps to
 * +-1, so a tighter rack means it saturates sooner and runs wide. Measured over
 * `probe:racesweep`, 55 races across five seeds, changing ONLY this number:
 *
 *     0.050   mean lap 1.5127 of reference   16.00 finishers
 *     0.062   (chosen)
 *     0.072   mean lap 1.5377 of reference   15.60 finishers
 *
 * so the last third of that range costs the AI 1.7% of lap time for very little
 * extra rack. 0.062 takes the part of the win that is nearly free. Going further
 * wants the AI's guardrail and wander terms — which are written as fractions of
 * the UNTAPERED `maxSteerRad` and then divided by the tapered ratio — expressed
 * in road-wheel angles like the rest of that controller already is.
 */
const RACK_TAPER_PER_MS = 0.062;

/**
 * Fraction of full steering lock the rack allows at a given speed, as a real
 * speed-sensitive rack is geared — a hyperbola in speed.
 *
 * EXPORTED because the AI has to invert it. A controller that commands a path
 * curvature must divide by the rack limit to know what steering input produces
 * that curvature. Note that until recently nothing outside this file actually
 * called it: the AI divided by `maxSteerRad` alone, so every steering command it
 * issued above 50km/h arrived at the tires attenuated by this curve — 46% at
 * 260km/h. That is fixed, and this must stay the single source of truth.
 */
export function steerRackLimit(speedMs: number): number {
  return 1 / (1 + Math.max(0, speedMs - 14) * RACK_TAPER_PER_MS);
}

export class VehiclePhysics {
  spec: VehicleSpec;
  /** The undamaged spec, so damage is applied to a stable baseline. */
  baseSpec: VehicleSpec;

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

  /**
   * The speed the pit limiter holds this car to, km/h.
   *
   * A property and not a constant because it is a property of the CIRCUIT, and
   * the circuits do not agree: Monaco's pit lane is 60 km/h and every other one
   * on the calendar is 80. This was hard-coded to 80, so at Monaco the limiter
   * held the car at 80.2 while race control penalised anything over 60.5 — the
   * simulation issued a drive-through for obeying itself, and there was nothing
   * the driver could do about it.
   *
   * Set by the race engine from `track.def.pitLane.speedLimitKph`. The default
   * is the calendar's usual value so a physics-only harness that never sets it
   * still behaves sensibly.
   */
  pitSpeedLimitKph = 80;

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
  /** Road-wheel steer angle actually applied this step, radians. Telemetry. */
  steerAngleRad = 0;

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

  /** Relaxed (lagged) slip angles, radians. See RELAX_LENGTH_*. */
  private alphaFrontLag = 0;
  private alphaRearLag = 0;
  /** Delivered fraction of commanded ICE power. See TURBO_LAG_*. */
  private boost = 0;

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
    this.alphaFrontLag = 0;
    this.alphaRearLag = 0;
    this.boost = 0;
  }

  /**
   * Rebuilds the car from a new specification — a setup change in the garage.
   *
   * Both the live spec and the undamaged baseline are replaced, because the
   * baseline is what the damage model rebuilds from: setting only `spec` would
   * mean the first scrape of the session silently reverted the player's setup.
   * Not to be called mid-lap; a car's specification changing under it would
   * invalidate the lap it is on.
   */
  setSpec(spec: VehicleSpec): void {
    this.spec = spec;
    this.baseSpec = spec;
  }

  /**
   * Brings the car to a complete stop where it stands.
   *
   * Used when the car is written off. A retirement that leaves `velocity`
   * populated leaves the speedometer reading 180km/h for a car wedged in a
   * barrier, which is the "it still shows speed when it shouldn't" bug: every
   * speed readout in the game derives from `velocity`, so the only way to read
   * as stopped is to actually be stopped.
   */
  stop(): void {
    this.velocity.set(0, 0);
    this.localVelX = 0;
    this.localVelY = 0;
    this.yawRate = 0;
    this.wheelSpin = 0;
    this.vibration = 0;
    this.alphaFrontLag = 0;
    this.alphaRearLag = 0;
    this.boost = 0;
  }

  /**
   * Recomputes the body-frame velocity from the world velocity.
   *
   * `step()` does this at the top of every step, so anything that reaches in
   * and edits `velocity` from outside — a barrier, a collision between cars —
   * must call this or leave `localVelX`/`localVelY` describing the motion the
   * car had BEFORE the impact. That stale pair is what the gearbox, the AI's
   * spin-recovery test and the reverse gate all read.
   */
  syncLocalVelocity(): void {
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    this.localVelX = this.velocity.x * sinH + this.velocity.y * cosH;
    this.localVelY = this.velocity.x * cosH - this.velocity.y * sinH;
  }

  /**
   * Resolves contact with a static barrier and returns the impact severity, 0..1.
   *
   * `(nx, nz)` is the wall's unit normal pointing OUT of the circuit, i.e. the
   * direction the car is travelling when it hits. The caller owns depenetration;
   * this owns the velocity response.
   *
   * The response is a real restitution rather than a perfect absorption, because
   * absorption is what made barrier contact feel broken. Taking the whole normal
   * component away means a car that touches a wall is instantly welded to it and
   * simply slides along, which is neither what a barrier does nor what anyone
   * expects to see. The coefficient scales with how SQUARE the hit is:
   *
   *   - A graze, where the velocity is nearly parallel to the wall, has almost
   *     no normal component to give back, and what little there is comes back at
   *     a low coefficient. The car slides along the barrier and keeps going,
   *     which is exactly what happens when a driver brushes the wall at Jeddah.
   *   - A square-on hit reverses a meaningful fraction of the closing speed and
   *     pushes the car back onto the circuit.
   *
   * Restitution also FALLS with closing speed. Barriers are energy absorbers —
   * TecPro and tyre walls are designed to deform plastically — so a light knock
   * is springy and a big one is not. Without that term a 200km/h impact would
   * fire the car back across the track like a pinball.
   *
   * Everything time-dependent below is a RATE, not a per-step multiplier. This
   * is called once per physics step at 120Hz, so a constant per-call factor of
   * 0.82 compounds to 1e-10 per second and a car that brushed a barrier was
   * stopped stone dead within two frames and could never drive away.
   */
  collideWithBarrier(nx: number, nz: number, dt: number): number {
    // Contact resists rotation. A rate, so the driver keeps enough yaw
    // authority to point the car away from the wall and leave.
    this.yawRate *= Math.exp(-BARRIER_YAW_DAMP_RATE * dt);

    const vIn = this.velocity.x * nx + this.velocity.y * nz;

    if (vIn <= 0) {
      // Already leaving, or sliding exactly along the wall. Scraping costs speed
      // continuously — about 40% per second in contact, enough to punish a long
      // scrape and slow enough that the car keeps rolling.
      this.velocity.scale(Math.exp(-BARRIER_SCRAPE_RATE * dt));
      this.syncLocalVelocity();
      return 0;
    }

    const speed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y);
    // sin of the impact angle: 0 is a parallel graze, 1 is square on.
    const squareness = clamp01(vIn / Math.max(speed, 0.5));
    const restitution =
      (BARRIER_RESTITUTION_GRAZE + (BARRIER_RESTITUTION_SQUARE - BARRIER_RESTITUTION_GRAZE) * squareness) /
      (1 + vIn * BARRIER_PLASTIC_FADE);

    const severity = clamp01(vIn / BARRIER_WRITE_OFF_MS);

    // Tangential component, taken before the normal one is touched.
    const tx = this.velocity.x - nx * vIn;
    const tz = this.velocity.y - nz * vIn;

    // A hard impact scrubs the slide along the wall as well as the closing
    // speed. Without this a car that hit a barrier square at 200km/h kept
    // scything down the wall at nearly 200km/h with its race already over —
    // wrecked, uncontrollable, and still reading a speed on the HUD.
    const keepTangential = Math.max(0, 1 - severity * severity * 1.2);

    // Restitution acts along -n, i.e. back toward the circuit.
    const rebound = -vIn * restitution;
    this.velocity.set(tx * keepTangential + nx * rebound, tz * keepTangential + nz * rebound);
    this.velocity.scale(Math.exp(-BARRIER_SCRAPE_RATE * dt));

    // Below walking pace there is nothing left to model, and a residual of a
    // few centimetres per second reads as a non-zero speed on the HUD for a car
    // that is visibly motionless against a wall.
    if (this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y < BARRIER_REST_MS * BARRIER_REST_MS) {
      this.velocity.set(0, 0);
    }

    this.syncLocalVelocity();
    return severity;
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
    // Two independent things multiplied: what the car is driving ON (asphalt,
    // kerb, grass) and what condition that surface is IN (rubbered, dusty,
    // rubbered-and-flooded). Keeping them separate is what lets a car run
    // wide onto a damp, unrubbered part of the road and find MORE grip than
    // the racing line has, which is the defining move of a wet Grand Prix.
    const surfaceGrip = SURFACE_GRIP[this.surface] * env.surfaceGrip;
    const muFront = spec.baseMu * this.frontTires.grip * surfaceGrip;
    const muRear = spec.baseMu * this.rearTires.grip * surfaceGrip;

    // --- Steering ---------------------------------------------------------
    // Speed-sensitive steering limit — the rack, not an assist. See
    // steerRackLimit for why the curve is shaped the way it is.
    const steerLimit = steerRackLimit(speed);
    // Negated: see the note on VehicleControls.steer. The internal lateral axis
    // points to the driver's LEFT, so a right-hand steer input must produce a
    // negative steer angle. Without this, the arrow keys are inverted.
    const tapered = spec.maxSteerRad * steerLimit;

    // Below walking pace the atan2 formulation is ill-conditioned, so blend the
    // slip angles out and let the low-speed kinematic path take over.
    const slipBlend = clamp01((absVx - 0.6) / 2.4);
    const vRef = Math.max(absVx, 1.2);

    // --- The rack taper must never limit OPPOSITE LOCK ----------------------
    //
    // `steerRackLimit` exists for one reason, stated where it is defined: to
    // stop the driver pushing the front tyre past its peak slip angle, where
    // more lock produces less cornering force. That is a good aim and it is
    // entirely about steering INTO a corner.
    //
    // Applied symmetrically it also caps counter-steer, and counter-steer is the
    // opposite manoeuvre in every sense — it REDUCES the front slip angle. The
    // consequence was measured and it is severe. At 90km/h the taper allows 15.5
    // degrees at the road wheels out of a physical 24. A car sliding at 28
    // degrees of sideslip therefore could not be pointed anywhere near where it
    // was travelling: the driver had opposite lock against the stop and the
    // front tyres were still at 12 degrees of slip, generating force in the
    // direction that continued the spin. Every one of the thirty-six low-speed
    // power-oversteer cases in the catchability sweep was unrecoverable, and it
    // was not the tyre model saying no, it was the steering aid.
    //
    // So: the rack is geared down as before, but the available lock in ONE
    // direction is extended to reach the angle that points the front wheels
    // along the direction the front axle is actually travelling — which is what
    // opposite lock physically IS — never beyond the car's real mechanical lock.
    // When the car is going where it is pointed that angle is nearly zero and
    // this changes nothing whatsoever; it only opens up once the car is
    // sideways, which is precisely when the driver needs it, and it opens only
    // on the side that unwinds the slide.
    //
    // Note it is the RANGE that is extended, not the mapping that is bypassed.
    // An earlier attempt applied the taper as a saturation rather than as a
    // gearing, so every input below the tapered limit arrived UNSCALED — at
    // 220km/h the same stick position produced twice the road-wheel angle, the
    // understeer gradient inverted at every speed, and the car got worse. The
    // input still maps linearly onto whatever lock is available.
    const frontVelAngle = Math.atan2(vy + this.yawRate * spec.cogToFrontM, vRef);
    const neutralising = clamp(frontVelAngle * slipBlend, -spec.maxSteerRad, spec.maxSteerRad);
    const lockPos = Math.max(tapered, neutralising);
    const lockNeg = Math.max(tapered, -neutralising);
    const steerAngle = c.steer >= 0 ? -c.steer * lockNeg : -c.steer * lockPos;
    this.steerAngleRad = steerAngle;

    // --- Slip angles -------------------------------------------------------

    const alphaFrontSS = (frontVelAngle - steerAngle) * slipBlend;
    const rearArm = spec.wheelbaseM - spec.cogToFrontM;
    const alphaRearSS = Math.atan2(vy - this.yawRate * rearArm, vRef) * slipBlend;

    // --- Tyre relaxation ---------------------------------------------------
    // The slip angle the tyre is ACTUALLY carrying lags the slip angle the
    // kinematics ask for, over a rolled distance rather than an elapsed time.
    // See RELAX_LENGTH_FRONT_M for why this matters more than its size suggests.
    const relaxRateFront = Math.max(absVx / RELAX_LENGTH_FRONT_M, RELAX_RATE_MIN);
    const relaxRateRear = Math.max(absVx / RELAX_LENGTH_REAR_M, RELAX_RATE_MIN);
    this.alphaFrontLag = damp(this.alphaFrontLag, alphaFrontSS, relaxRateFront, dt);
    this.alphaRearLag = damp(this.alphaRearLag, alphaRearSS, relaxRateRear, dt);
    const alphaFront = this.alphaFrontLag;
    const alphaRear = this.alphaRearLag;

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

    const throttleDemand = clamp01(c.throttle);

    // --- Boost / driveline lag ---------------------------------------------
    // What the power unit is DELIVERING, which is not what the pedal is asking
    // for until the turbo has caught up. See BOOST_RATE_OFF.
    const boostRate = throttleDemand < this.boost
      ? BOOST_RATE_CLOSING
      // Spool is faster the more exhaust the engine is already making, which is
      // a function of crank speed AND of the boost already built — a turbo that
      // is half spun up gets to full boost far quicker than one that is cold.
      // Without the second term a standing start, where the engine sits at idle
      // rpm on the clock but has in reality been held against the clutch on the
      // limiter for ten seconds, was penalised half a second to 100km/h for a
      // spool that had already happened.
      : BOOST_RATE_OFF + (BOOST_RATE_ON - BOOST_RATE_OFF) * Math.max(this.rpmFraction, this.boost);
    this.boost = damp(this.boost, throttleDemand, boostRate, dt);
    const throttle = this.boost;

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

    // The limiter: a hard speed cap, enforced as braking rather than as a
    // teleport, so overshooting the limit still triggers a penalty.
    //
    // TWO SOURCES, ONE MECHANISM. The pit lane is one (`pitLimiter`, holding
    // the circuit's own posted limit) and a neutralisation is the other
    // (`speedLimitMs`, holding the safety car or VSC pace). A car serving a
    // stop under a safety car is under both at once and the lower wins, which
    // is what makes that case work without a second copy of everything below.
    if (c.pitLimiter || c.speedLimitMs > 0) {
      // The circuit's own limit, not a constant. See `pitSpeedLimitKph`.
      let limitMs = c.pitLimiter ? this.pitSpeedLimitKph / 3.6 : Infinity;
      if (c.speedLimitMs > 0 && c.speedLimitMs < limitMs) limitMs = c.speedLimitMs;
      if (vx > limitMs) {
        driveForce = 0;
        // What a real pit limiter does is cut the engine. It has no brakes.
        //
        // This was `brakeForceRear += (vx - limit) * mass * 2.2`, which is
        // unbounded and REAR-ONLY: a car crossing the pit entry line at 250km/h
        // had a hundred and forty kilonewtons put through its rear axle alone in
        // a single step. The rears lock instantly, the back steps out, and the
        // car spins on the spot. "The moment I entered the pit lane I spun, idk
        // how" is exactly what that feels like, and it was not the driver.
        //
        // So: cut the drive, then shed the excess BALANCED across the axles on
        // the car's own brake balance, and let the friction circle below have
        // the final word — it is the thing that actually knows what the tires
        // can take, and a demand that passes through it cannot lock a wheel that
        // has grip to give.
        //
        // The bound is a full g rather than the half it was. Half a g needs four
        // hundred metres to bring a car from racing speed to 80 km/h and no
        // circuit has a pit lane that long, so the cap was quietly deciding that
        // a car which arrived hot simply sped the length of the lane. That is
        // not what the driver sees: they see LIMITER ON and a speedometer that
        // does not move. A g is still nothing like the 4-5g these brakes can do
        // — it will not lock a wheel, and it will not spin the car — while being
        // enough that the limiter visibly IS a limiter.
        //
        // It is still not a teleport. A car that arrives far enough over the
        // limit runs out of pit lane before it runs out of speed, and collects
        // the penalty it earned.
        const wanted = (vx - limitMs) * mass * 2.2;
        const applied = Math.min(wanted, mass * G * PIT_LIMITER_MAX_DECEL_G);
        brakeForceFront += applied * spec.brakeBalanceFront;
        brakeForceRear += applied * (1 - spec.brakeBalanceFront);
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

    // --- Yaw damping: a SIDESLIP damper, not a brake on rotation ------------
    //
    // The model needs a stabilising term here. A two-axle model integrated
    // explicitly has no tire relaxation length, no roll dynamics and no
    // compliance steer, and those are most of what stops a real car's sideslip
    // from running away. Without something in their place the car spins above
    // about 140km/h from a perfectly ordinary steering input.
    //
    // But what was here damped `yawRate` toward ZERO, and that is a different
    // thing entirely. Rotation is not an error to be corrected — a car in a
    // steady corner is rotating, continuously, and it is supposed to be. Pulling
    // it toward zero applies a torque that opposes cornering itself, and in
    // steady state that torque does not go away: it has to be paid for, every
    // frame, out of the tires. Measured at 1.8 + 0.032v it was 1.2-2.8 kNm.
    //
    // Which axle pays is the part that ruined the car. A steady turn needs the
    // front and rear moments to BALANCE — net yaw moment zero. Forcing a
    // permanent unbalanced moment of +2 kNm means the front axle must out-pull
    // the rear by that much, all the time, on top of its share of the cornering
    // load. That is roughly a 10% front overload, and it showed up exactly where
    // you would expect: `balance` was negative at every speed and every steering
    // angle in the sweep (-0.08 to -0.34), meaning the front was closer to its
    // limit than the rear everywhere. The car had terminal understeer built into
    // it, the rear axle's grip was never used, and the front hit its friction
    // circle early — so adding steering pushed it further past its cap and the
    // slide penalty took cornering force AWAY. That is the "no grip, gliding,
    // won't turn" the car was reported to have, and no amount of extra baseMu
    // fixes it because the grip was there all along and was being spent on a
    // torque nothing physical produces.
    //
    // What a stabiliser should actually oppose is SIDESLIP — the velocity vector
    // and the chassis pointing in different directions, and that mismatch
    // growing. So damp toward the rate at which the velocity vector is itself
    // turning. `ay / speed` is exactly that rate: from the body-frame equation
    // vy_dot = ay - r*vx, the world-frame rotation of the velocity vector is
    // r + beta_dot = ay / v. Damping toward it is damping beta_dot toward zero.
    //
    // In a settled corner the chassis already rotates at that rate, the term
    // vanishes, and the tires keep their grip. When the car starts to spin,
    // yawRate runs away from it and the term bites at full strength. The
    // stabilisation is kept; the permanent tax on the front axle is not.
    //
    // One-sided, via the clamp. Damping is applied only to rotation BEYOND what
    // the path is doing (oversteer, the direction that ends in a spin) and never
    // to a car that is rotating LESS than its path (understeer, which is already
    // self-correcting and needs no help). A two-sided version measured better on
    // the skidpad and was worse to drive: it feeds yaw INTO an understeering car,
    // which is a rotation source the tires did not produce.
    const yawDampRate = YAW_DAMP_BASE + speed * YAW_DAMP_PER_V;
    // Blended out at walking pace, where ay/speed is ill-conditioned.
    const pathYawRate = (ay / Math.max(speed, 6)) * clamp01((speed - 2) / 6);
    const yawTarget = clamp(this.yawRate, Math.min(0, pathYawRate), Math.max(0, pathYawRate));
    this.yawRate = damp(this.yawRate, yawTarget, yawDampRate, dt);

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

    this.frontTires.update(dt, frontSlipSpeed, loadFront, staticFront, env.trackTempC, env.wetness, env.abrasion, this.speedMs);
    this.rearTires.update(dt, rearSlipSpeed, loadRear, staticRear, env.trackTempC, env.wetness, env.abrasion, this.speedMs);

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
 * are scaled back — by the SAME factor, so the force that comes out points the
 * way the demand pointed and its magnitude is the budget. That sounds like a
 * detail and it is not; see below.
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

  // ONE factor for both components.
  //
  // This used to give longitudinal a boost under braking (`s * 1.12`) and take
  // it back out of lateral (`s * 0.9`), on the reasoning that a locking tire
  // keeps stopping and loses the ability to turn. The reasoning is right about
  // the FRONT axle and it is a disaster on the rear, because it does not cap the
  // axle at all: at 3% over budget the boost returns the full longitudinal
  // demand and pays for it by cutting cornering force 14%, so the axle delivers
  // MORE than the circle it is supposed to be enforcing and the surplus is taken
  // from precisely the force that keeps the car pointing forwards.
  //
  // On the rear axle that is a spin generator, and it was generating them. Under
  // combined braking and cornering the rear runs out first — it is the unloaded
  // end under braking and it carries 42% of the pedal — so the rear alone was
  // being asked to hand over its lateral grip in exchange for stopping power it
  // was not entitled to. Measured at 150 km/h into a 100m radius: brake 0.30
  // settles at 1.4 degrees of rear slip, brake 0.40 diverged to a spin, with
  // nothing in between. That cliff is what was eating the AI field — 17 of 20
  // cars out on lap one at Silverstone, 13 of 17 retirements at Spa inside a
  // hundred metres of one corner.
  //
  // Scaling both by `s` keeps the sliding-tire penalty (which is `slide`, and is
  // what makes lock-ups cost distance) and drops the part that was never a tire
  // model. Front lock-up still means going straight on at the corner: the front
  // axle's lateral force falls because its own budget is spent, which is the
  // real mechanism and does not need help.
  const s = achieved / demand;
  out.lon = s;
  out.lat = s;
}
