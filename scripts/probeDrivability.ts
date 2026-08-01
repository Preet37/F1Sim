/**
 * DRIVABILITY PROBE — does a human being enjoy driving this car?
 *
 * Every other harness in this repo measures whether the car is FAST or whether
 * it is PHYSICALLY PLAUSIBLE. `validate:physics` checks peak lateral g and
 * braking distance. `validate:race` checks lap times and finisher counts.
 * `probe:handling` runs a steady-state skidpad. All three can pass on a car that
 * is horrible to drive, and all three have.
 *
 * The reason is that none of them measure a TRANSIENT. What makes a car drivable
 * is what it does in the few hundred milliseconds after the driver moves his
 * hands, and what it does at the moment the rear axle lets go:
 *
 *   - Does the car respond promptly to a steering input, or does it wash wide
 *     first? (turn-in delay — "gliding")
 *   - Once it responds, does it settle, ring, or diverge? (yaw damping — a
 *     ringing or divergent yaw mode IS "it randomly starts oversteering")
 *   - Is there any margin between "at the limit" and "gone"? (departure warning)
 *   - Once it has gone, can a human with a 250ms reaction time catch it?
 *     (catchability — if this is near zero, every mistake becomes a donut)
 *   - All of the above WITH the brake or the throttle applied, because that is
 *     when cars actually spin and it is where every previous test was blind.
 *
 * `probe:handling` in particular tested a steady-state skidpad with no
 * longitudinal force at all and pronounced a car "front-limited and stable"
 * while that same car was snap-spinning under braking and taking 17 of 20 cars
 * out of a race. Steady state is not the problem. Do not trust steady state.
 *
 * A NOTE ON METHOD, because the first version of this probe got it wrong and the
 * wrong version produced confident nonsense. There is no such thing as a
 * steady-state braking test. A car braking at 1.5g from 90km/h is stopped in a
 * second and three quarters, so a "3.5 second constant-speed brake case" measures
 * a stationary car and reports 0.09g of cornering and a car that "never departs".
 * Every combined-load test here is therefore explicitly a TRANSIENT with a stated
 * window, entered from a settled corner the way a real one is entered: you are
 * already turning, and then you add the pedal. Where a load case cannot be
 * sustained at a given speed for long enough to measure anything, it is skipped
 * and says so, rather than reporting a number that means nothing.
 *
 * WHAT THIS PROBE CANNOT TELL YOU. It drives open-loop manoeuvres. It cannot say
 * whether a person closing the loop around this car, lap after lap, stays on the
 * road — for that you have to actually drive it, with a controller handicapped to
 * human bandwidth, in the real engine. That was done: a scripted driver with a
 * 250ms reaction delay and hands limited to 4 input units per second, installed
 * on `RaceEngine.step` at 120Hz rather than on the render loop (under software GL
 * the page runs at four frames a second and a frame-sampled controller is a 5Hz
 * bang-bang loop that spins the car by itself and manufactures its own evidence).
 * Same driver, same gains, same circuit, same seed:
 *
 *     Red Bull Ring   baseline  3 spins in 52.9s     this car  1 spin in 45.3s
 *     Monaco          baseline  RETIRED into a       this car  still running at
 *                               barrier at 16.4s               35.3s, no retirement
 *     Silverstone     this car, reaction delay set to zero as a control:
 *                     0 spins, 4.2 deg peak sideslip, 0.38 deg mean
 *
 * Read those honestly. The car is clearly better under the same driver, and the
 * zero-delay control shows it is composed when the loop is closed promptly. It is
 * NOT a clean-lap result: the Monaco run still spun eight times, and no run
 * completed a full timed lap, because under software GL the page renders at a few
 * frames a second and a Silverstone lap is nearly two minutes of simulated time —
 * it does not fit in the wall-clock budget. The residual spinning is at least
 * partly the harness: a proportional controller with a quarter second of pure
 * dead time and no internal model has poor phase margin on any plant, which is
 * exactly why the zero-delay control run exists and why it is clean.
 *
 * Run: npm run probe:drivability
 */

import {
  VehiclePhysics,
  steerRackLimit,
  type VehicleControls,
  type EnvironmentState,
} from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';
import { clamp } from '../src/core/MathUtils';

const RAD = 180 / Math.PI;

const ENV: EnvironmentState = {
  trackTempC: 38,
  airTempC: 25,
  wetness: 0,
  airDensityRatio: 1,
  abrasion: 1,
};

/**
 * Human reaction time to a rear-end departure, seconds.
 *
 * Simple-reaction latency to a visual cue is ~200ms; a correction that has to be
 * chosen (which way, how much) is slower. 250ms is generous to the car — a
 * distracted club driver is nearer 400ms — and it is deliberately the number the
 * whole catchability sweep hangs on, because a car that is only catchable inside
 * 100ms is not catchable by a person.
 */
const REACTION_S = 0.25;

/**
 * Steering rate available to a human, in input units per second.
 *
 * An F1 driver's hands move at roughly 1000 deg/s at the rim through a ~10:1
 * rack, so ~100 deg/s at the road wheels. Full lock here is 24 degrees, hence
 * about 4 input units per second. Nothing in this file is allowed to move the
 * steering faster than this — an instantaneous step is a signal no driver can
 * generate, and testing with one measures a transient that never happens.
 */
const STEER_RATE = 4.0;

/** Rear slip angle, degrees, past which we call the car gone. */
const SPIN_SLIP_DEG = 35;
/** Chassis sideslip, degrees, past which we call the car gone. */
const SPIN_BETA_DEG = 45;

/** Pedal levels for the combined-load cases. */
const BRAKE_LEVEL = 0.25;
const POWER_LEVEL = 0.70;

/**
 * Chassis sideslip above the settled value, degrees, that counts as the moment
 * the car told the driver something was happening.
 *
 * The first version of this file used "the rear tyre is past its peak slip
 * angle", 8.85 degrees, as the cue. That is far too late and it made every
 * warning time look catastrophic. A driver does not wait for the tyre to reach
 * its peak: two degrees of the car pointing somewhere other than where it is
 * going is plainly visible out of the windscreen, plainly felt through the seat,
 * and is the point at which a real driver's hands start to move. Measured on the
 * low-speed power-oversteer case, the rear crosses its peak slip angle at 480ms
 * and the car is gone at 590 — a "110ms warning" — but the chassis had already
 * been visibly rotating since 350ms. The cue is now whichever of the two comes
 * first, which is nearly always this one.
 */
const CUE_BETA_DEG = 2.0;

/**
 * Speeds below which a braking transient cannot be measured, km/h.
 *
 * At 1.5g a car sheds 15m/s a second. Below this, a braking window long enough
 * to contain a steering transient has also brought the car to a standstill, and
 * whatever the probe prints is a number about a parked car.
 */
const MIN_BRAKE_KPH = 150;

function controls(over: Partial<VehicleControls> = {}): VehicleControls {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    drsRequested: false,
    ersMode: 'balanced',
    gearRequest: 0,
    pitLimiter: false,
    reverse: false,
    ...over,
  };
}

/**
 * A representative race car: medium downforce, half a tank, tyres in their
 * window. Deliberately NOT the qualifying-trim car `validate:physics` uses — the
 * complaint is about driving the thing in a race, and a heavier car with less
 * wing is the harder and more honest case.
 */
function makeCar(downforceDemand = 0.6, fuelL = 60): VehiclePhysics {
  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(downforceDemand, fuelL));
  const car = new VehiclePhysics(spec, 'medium');
  car.fuelL = fuelL;
  car.frontTires.tempC = 102;
  car.rearTires.tempC = 104;
  car.frontTires.lapsOnSet = 3;
  car.rearTires.lapsOnSet = 3;
  return car;
}

/** Chassis sideslip angle, degrees. */
function betaDeg(car: VehiclePhysics): number {
  return Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 0.5)) * RAD;
}

function rearSlipDeg(car: VehiclePhysics): number {
  return car.rearTires.slipAngle * RAD;
}

function frontSlipDeg(car: VehiclePhysics): number {
  return car.frontTires.slipAngle * RAD;
}

function isGone(car: VehiclePhysics): boolean {
  return (
    rearSlipDeg(car) > SPIN_SLIP_DEG ||
    Math.abs(betaDeg(car)) > SPIN_BETA_DEG ||
    !Number.isFinite(car.yawRate)
  );
}

/** Moves `cur` toward `want` no faster than a human can turn the wheel. */
function slew(cur: number, want: number, dt: number): number {
  const maxStep = STEER_RATE * dt;
  return cur + clamp(want - cur, -maxStep, maxStep);
}

type LoadCase = 'coast' | 'brake' | 'power';
const LOAD_CASES: LoadCase[] = ['coast', 'brake', 'power'];

/**
 * Fraction of the steady-state LATERAL G to settle at before a combined-load
 * test — not a fraction of the steering input, which is a different and much
 * less meaningful number.
 *
 * This distinction wrecked two iterations of the probe. The g-against-lock curve
 * is strongly nonlinear: at 90km/h half of full lock already produces 98% of the
 * peak lateral g, because the last half of the rack is spent pushing the front
 * tyre past its peak slip angle for no gain. So "settle at 72% of the limit
 * steering" put the car at 98% of the limit CORNERING, the pedal then took it
 * straight over the friction circle, and the probe reported a car that departs
 * on the throttle at three quarters of its grip when in fact it departs at the
 * edge of it, like every car.
 *
 * Coasting, 90% of the limit is a fair place to ask "does a bump spin it". With
 * a pedal down it is not, and getting this wrong made the probe useless for two
 * iterations. A car cornering at 90% of its lateral limit has 44% of its grip
 * budget left for anything longitudinal; a quarter of the brake pedal is worth
 * more than that. So the car departed, correctly, with NO disturbance at all —
 * and the probe reported the disturbance test as a divergence at every speed,
 * which told us only that the friction circle works.
 *
 * The informative question is whether the car is stable when the driver is
 * INSIDE the circle, because that is where he spends the lap. 72% lateral with a
 * quarter of brake pedal is a real, comfortably-inside-the-circle trail-brake.
 */
const CORNER_FRACTION: Record<LoadCase, number> = { coast: 0.90, brake: 0.72, power: 0.72 };

/**
 * A car sitting in a settled corner at `speedMs`, holding `steer`, with the
 * speed-holding throttle already found. Every transient test starts here.
 */
interface Cornering {
  car: VehiclePhysics;
  hold: number;
  steer: number;
}

/** Runs straight at `speedMs` until the powertrain settles; returns hold throttle. */
function trim(car: VehiclePhysics, speedMs: number): number {
  car.placeAt(0, 0, 0, speedMs);
  const c = controls();
  let hold = 0.3;
  for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
    hold = clamp(hold + (speedMs - car.speedMs) * 0.02, 0, 1);
    c.throttle = hold;
    car.step(PHYSICS_DT, c, ENV);
  }
  return hold;
}

/** Settles the car into a steady corner at constant speed. */
function settleCorner(speedMs: number, steer: number, seconds = 2.5): Cornering {
  const car = makeCar();
  const hold = trim(car, speedMs);
  const c = controls();
  let s = 0;
  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) {
    s = slew(s, steer, PHYSICS_DT);
    c.steer = s;
    c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1);
    car.step(PHYSICS_DT, c, ENV);
    if (isGone(car)) break;
  }
  return { car, hold, steer: s };
}

// ===========================================================================
// Steady-state reference: where is the limit?
// ===========================================================================

interface SteadyPoint {
  steer: number;
  latG: number;
  yawRate: number;
  frontSlipDeg: number;
  rearSlipDeg: number;
  steerAngleRad: number;
  speedMs: number;
  spun: boolean;
}

/** Holds a steering input at constant speed and reports what it settled at. */
function steadyState(speedMs: number, steer: number): SteadyPoint {
  const car = makeCar();
  const hold = trim(car, speedMs);
  const c = controls();
  let s = 0;
  let spun = false;

  const steps = Math.round(3.5 / PHYSICS_DT);
  const tail = Math.round(0.8 / PHYSICS_DT);
  let sumLat = 0, sumYaw = 0, sumFront = 0, sumRear = 0, n = 0;

  for (let i = 0; i < steps; i++) {
    s = slew(s, steer, PHYSICS_DT);
    c.steer = s;
    c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1);
    car.step(PHYSICS_DT, c, ENV);
    if (isGone(car)) { spun = true; break; }
    if (i > steps - tail) {
      sumLat += Math.abs(car.lateralG);
      sumYaw += Math.abs(car.yawRate);
      sumFront += frontSlipDeg(car);
      sumRear += rearSlipDeg(car);
      n++;
    }
  }

  return {
    steer,
    latG: n ? sumLat / n : 0,
    yawRate: n ? sumYaw / n : 0,
    frontSlipDeg: n ? sumFront / n : 0,
    rearSlipDeg: n ? sumRear / n : 0,
    steerAngleRad: Math.abs(steer * car.spec.maxSteerRad * steerRackLimit(speedMs)),
    speedMs: car.speedMs,
    spun,
  };
}

/** The steering input that produces peak steady-state lateral g at this speed. */
interface LimitInfo {
  steerAtPeak: number;
  peakLatG: number;
  rearAtPeakDeg: number;
  frontAtPeakDeg: number;
  /** Lateral g at FULL LOCK as a percentage of peak. */
  gAtFullLockPct: number;
  frontAtFullLockDeg: number;
  rearAtFullLockDeg: number;
  /** Extra steering input available beyond the peak before full lock. */
  plateauWidth: number;
  /** The whole sweep, so a test can ask for a given fraction of the limit g. */
  sweep: SteadyPoint[];
}

function findLimit(speedMs: number): LimitInfo {
  let peak = 0;
  let best: SteadyPoint | null = null;
  let full: SteadyPoint | null = null;
  const sweep: SteadyPoint[] = [];
  for (let steer = 0.1; steer <= 1.0001; steer += 0.05) {
    const p = steadyState(speedMs, Math.round(steer * 100) / 100);
    if (p.spun) break;
    sweep.push(p);
    if (p.latG > peak) { peak = p.latG; best = p; }
    full = p;
  }
  return {
    sweep,
    steerAtPeak: best?.steer ?? 1,
    peakLatG: peak,
    rearAtPeakDeg: best?.rearSlipDeg ?? 0,
    frontAtPeakDeg: best?.frontSlipDeg ?? 0,
    gAtFullLockPct: peak > 1e-6 && full ? (full.latG / peak) * 100 : 0,
    frontAtFullLockDeg: full?.frontSlipDeg ?? 0,
    rearAtFullLockDeg: full?.rearSlipDeg ?? 0,
    plateauWidth: 1 - (best?.steer ?? 1),
  };
}

/**
 * The steering input that produces `frac` of the peak steady-state lateral g,
 * on the RISING side of the curve. Linear interpolation between sweep points.
 */
function steerForLatG(limit: LimitInfo, frac: number): number {
  const want = limit.peakLatG * frac;
  const s = limit.sweep;
  for (let i = 0; i < s.length; i++) {
    if (s[i].latG >= want) {
      if (i === 0) return s[0].steer;
      const a = s[i - 1], b = s[i];
      const t = (want - a.latG) / Math.max(b.latG - a.latG, 1e-6);
      return a.steer + (b.steer - a.steer) * t;
    }
  }
  return limit.steerAtPeak;
}

// ===========================================================================
// 1. TURN-IN RESPONSE
// ===========================================================================

interface TurnIn {
  t90: number;
  tPeak: number;
  overshootPct: number;
  zeta: number;
  oscillations: number;
  divergent: boolean;
  /** Settled path curvature, 1/m. */
  settledYaw: number;
  settledLatG: number;
  meanKph: number;
}

/**
 * Ramps a steering input in at human rate and watches the yaw-rate trace.
 *
 * `t90` is how long the car takes to do what it was asked. Above roughly 0.35s
 * the car feels like it is on ice for the first part of every corner, which is
 * the "gliding" complaint stated precisely. `overshootPct` is how far it goes
 * BEYOND the request before settling: a little (5-20%) reads as an eager, alive
 * car; a lot (>40%) reads as darty and is the first half of a snap. `zeta` is
 * whether the excess decays, and `oscillations` is whether it rings on the way.
 *
 * Under brake or power the car is entered from a settled corner and the pedal is
 * applied for 0.35s before the steering moves, so the load transfer is real and
 * established; the measurement window is then short, and `meanKph` says what
 * speed it actually happened at.
 *
 * The trace measured is PATH CURVATURE, yaw rate over speed, not yaw rate. They
 * are the same thing at constant speed and completely different under a pedal:
 * a car braking from 220km/h holding a fixed steering angle has a yaw rate that
 * RISES as it slows even though nothing about its cornering has changed, because
 * yaw rate is curvature times speed. Measured on raw yaw rate the braking rows
 * reported overshoots of 300-400% and negative damping ratios, which described
 * the deceleration and not the car. Curvature is what the driver is actually
 * commanding with the steering wheel and it settles.
 */
function turnInResponse(speedMs: number, steer: number, load: LoadCase): TurnIn | null {
  const bad: TurnIn = {
    t90: Infinity, tPeak: Infinity, overshootPct: Infinity, zeta: 0,
    oscillations: 0, divergent: true, settledYaw: 0, settledLatG: 0, meanKph: 0,
  };
  const car = makeCar();
  const hold = trim(car, speedMs);
  const c = controls();

  // Establish the load case in a straight line — you brake before you turn in.
  const preSteps = Math.round(0.35 / PHYSICS_DT);
  for (let i = 0; i < preSteps; i++) {
    if (load === 'coast') { c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1); c.brake = 0; }
    else if (load === 'brake') { c.throttle = 0; c.brake = BRAKE_LEVEL; }
    else { c.throttle = POWER_LEVEL; c.brake = 0; }
    car.step(PHYSICS_DT, c, ENV);
  }

  // Turn-in is a short-timescale property by definition. Under a pedal the
  // window has to be short too: a car braking for 1.4s has lost a third of its
  // speed, the speed-sensitive rack has quietly fed in more lock, and the
  // curvature is still climbing at the end — so the "settled" value read off the
  // tail was the largest in the trace and t90 came out at 1.05 seconds for a car
  // that had actually responded in a tenth of one.
  const dur = load === 'coast' ? 3.0 : 0.8;
  const steps = Math.round(dur / PHYSICS_DT);
  const tail = Math.round((load === 'coast' ? 0.6 : 0.15) / PHYSICS_DT);
  const yaw = new Float64Array(steps);
  let s = 0;
  let latSum = 0, latN = 0, kphSum = 0;

  for (let i = 0; i < steps; i++) {
    s = slew(s, steer, PHYSICS_DT);
    c.steer = s;
    if (load === 'coast') { c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1); c.brake = 0; }
    else if (load === 'brake') { c.throttle = 0; c.brake = BRAKE_LEVEL; }
    else { c.throttle = POWER_LEVEL; c.brake = 0; }
    car.step(PHYSICS_DT, c, ENV);
    // Path curvature, 1/m — speed-invariant, unlike yaw rate. See the note above.
    yaw[i] = Math.abs(car.yawRate) / Math.max(car.speedMs, 1);
    kphSum += car.speedKph;
    if (i > steps - tail) { latSum += Math.abs(car.lateralG); latN++; }
    if (isGone(car)) return bad;
    // A braking run that has stopped the car has nothing left to say.
    if (car.speedKph < 25) return null;
  }

  let settled = 0;
  for (let i = steps - tail; i < steps; i++) settled += yaw[i];
  settled /= tail;

  let t90 = Infinity;
  for (let i = 0; i < steps; i++) {
    if (yaw[i] >= settled * 0.9) { t90 = i * PHYSICS_DT; break; }
  }

  let peak = 0, tPeak = 0;
  for (let i = 0; i < steps; i++) {
    if (yaw[i] > peak) { peak = yaw[i]; tPeak = i * PHYSICS_DT; }
  }

  const overshootPct = settled > 1e-6 ? (peak / settled - 1) * 100 : 0;

  // Damping ratio from the first overshoot of a second-order step response:
  //   OS = exp(-pi*zeta/sqrt(1-zeta^2))
  let zeta: number;
  if (overshootPct <= 0.5) {
    zeta = 1.2; // no measurable overshoot: overdamped
  } else {
    const l = Math.log(overshootPct / 100);
    zeta = -l / Math.sqrt(Math.PI * Math.PI + l * l);
  }

  // Ringing: sign changes of (yaw - settled) after the first peak, and whether
  // successive excursions grow.
  let oscillations = 0;
  let divergent = false;
  let prevSign = 0, lastExcursion = 0, excursion = 0;
  for (let i = Math.round(tPeak / PHYSICS_DT); i < steps; i++) {
    const d = yaw[i] - settled;
    const sign = d > 1e-4 ? 1 : d < -1e-4 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      oscillations++;
      if (oscillations > 1 && excursion > lastExcursion * 1.05) divergent = true;
      lastExcursion = excursion;
      excursion = 0;
    }
    if (sign !== 0) prevSign = sign;
    excursion = Math.max(excursion, Math.abs(d));
  }

  return {
    t90, tPeak, overshootPct, zeta, oscillations, divergent,
    settledYaw: settled,
    settledLatG: latN ? latSum / latN : 0,
    meanKph: kphSum / steps,
  };
}

// ===========================================================================
// 2. YAW STABILITY — impulse response with the hands held still
// ===========================================================================

interface YawStability {
  peakRearDeg: number;
  endDeg: number;
  decayRate: number;
  outcome: 'settles' | 'rings' | 'diverges' | 'baseline gone';
}

/**
 * Runs the SAME manoeuvre twice, once with a yaw impulse and once without, and
 * measures whether the difference between them grows or dies. The steering is
 * held still in both.
 *
 * This is the most diagnostic test in the file, and the differential form is
 * what makes it mean anything. Measuring the disturbed run on its own confuses
 * two completely different things: the car's response to the bump, and the drift
 * of the manoeuvre itself. Braking in a corner is inherently transient — the car
 * sheds 40km/h in a second, downforce falls with the square of speed, and the
 * speed-sensitive rack quietly feeds in more lock as it slows — so a "hands
 * still" braking run runs out of grip on its own with no disturbance at all.
 * Measured absolutely, every braking case at every speed read as a divergence,
 * which told us only that the car cannot brake at 1.7g while cornering forever.
 * Differencing against the undisturbed reference cancels all of that and leaves
 * exactly the question worth asking: does a bump grow into a spin, or wash out?
 *
 * A car with an open-loop stable yaw mode absorbs the disturbance with the
 * driver doing nothing. A car whose yaw mode is lightly damped needs the driver
 * correcting continuously just to hold a line, and any lapse — a distraction, a
 * bump at the wrong moment — becomes a spin that appears to come from nowhere.
 * That is exactly what "it randomly starts over steering" is.
 */
function yawStability(speedMs: number, steer: number, load: LoadCase, impulse: number): YawStability | null {
  // How long the manoeuvre can be held before it stops being the manoeuvre.
  //
  // Under braking the window has to be bounded by SPEED, not by the clock. A car
  // braking at 1.7g from 150km/h is doing 90km/h a second and a half later, and
  // at 90km/h the peak lateral is 1.96g where at 150 it was 2.93 — so 72% of the
  // ENTRY limit is 108% of the limit it now has, and the car leaves the road
  // having done nothing wrong. That is not instability, it is arithmetic, and
  // measuring it as instability is how a perfectly stable car reads as
  // divergent at every speed under braking.
  //
  // It must still be long enough to contain the whole transient. At a modest
  // cornering level the sideslip excursion after a bump peaks around 0.6s, so a
  // 0.45s window truncated it before its peak and every case read as monotonic
  // growth — the opposite error, and just as wrong. The differencing is what
  // makes the longer window safe: the common-mode loss of speed and downforce
  // appears in both runs and cancels, and a manoeuvre that is genuinely
  // unsustainable is reported separately as `baseline gone` rather than being
  // mistaken for instability.
  const decelG = load === 'brake' ? 1.7 : 0;
  const dur = load === 'coast'
    ? 2.5
    : decelG > 0
      ? clamp((0.35 * speedMs) / (decelG * 9.81), 0.8, 1.5)
      : 1.5;
  const steps = Math.round(dur / PHYSICS_DT);

  /** One run of the manoeuvre; returns the rear-slip trace, or null if it left. */
  const run = (imp: number): { trace: Float64Array; gone: boolean; short: boolean } | null => {
    const { car, hold } = settleCorner(speedMs, steer);
    if (isGone(car)) return null;
    const c = controls({ steer });
    const pedals = () => {
      c.steer = steer; // hands still
      if (load === 'coast') { c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1); c.brake = 0; }
      else if (load === 'brake') { c.throttle = 0; c.brake = BRAKE_LEVEL; }
      else { c.throttle = POWER_LEVEL; c.brake = 0; }
    };
    // Let the load transfer establish before the disturbance arrives.
    for (let i = 0; i < Math.round(0.35 / PHYSICS_DT); i++) {
      pedals();
      car.step(PHYSICS_DT, c, ENV);
      if (isGone(car)) return null;
    }
    car.yawRate += Math.sign(car.yawRate || 1) * imp;

    const trace = new Float64Array(steps);
    for (let i = 0; i < steps; i++) {
      pedals();
      car.step(PHYSICS_DT, c, ENV);
      trace[i] = rearSlipDeg(car);
      if (isGone(car)) {
        for (let j = i; j < steps; j++) trace[j] = SPIN_SLIP_DEG;
        return { trace, gone: true, short: false };
      }
      if (car.speedKph < 25) {
        for (let j = i; j < steps; j++) trace[j] = trace[i];
        return { trace, gone: false, short: true };
      }
    }
    return { trace, gone: false, short: false };
  };

  const ref = run(0);
  if (!ref) return null;
  // If the undisturbed manoeuvre itself leaves the road, the disturbance test
  // has nothing to say — that is a pedal-margin result, and 3b reports it.
  if (ref.gone) {
    return { peakRearDeg: SPIN_SLIP_DEG, endDeg: SPIN_SLIP_DEG, decayRate: -99, outcome: 'baseline gone' };
  }
  const dis = run(impulse);
  if (!dis) return null;
  if (dis.gone) {
    return { peakRearDeg: SPIN_SLIP_DEG, endDeg: SPIN_SLIP_DEG, decayRate: -99, outcome: 'diverges' };
  }

  const dev = new Float64Array(steps);
  for (let i = 0; i < steps; i++) dev[i] = Math.abs(dis.trace[i] - ref.trace[i]);

  // The peak is searched only in the first 70% of the window, so there is always
  // a span left to measure the decay over. Searching the whole window let the
  // peak land two samples from the end, leaving no span, and the guard against
  // dividing by nothing then reported a decay of exactly zero — i.e. "diverges"
  // — for traces that had visibly fallen from 3.8 degrees to 1.0.
  const searchEnd = Math.floor(steps * 0.7);
  let peak = 0, peakT = 0;
  for (let i = 0; i < searchEnd; i++) {
    if (dev[i] > peak) { peak = dev[i]; peakT = i * PHYSICS_DT; }
  }

  const end = dev[steps - 1];
  const span = (steps - 1) * PHYSICS_DT - peakT;
  // A disturbance too small to move the car cannot be said to decay or grow.
  if (peak < 0.15) {
    return {
      peakRearDeg: dis.trace[steps - 1], endDeg: dis.trace[steps - 1],
      decayRate: Infinity, outcome: 'settles',
    };
  }
  const decayRate = span > 0.2
    ? -Math.log(Math.max(end, 1e-4) / peak) / span
    : 0;

  // Ringing means the disturbance comes BACK, not that the trace wiggles in the
  // sixth decimal place. Only reversals that recover a tenth of the original
  // excursion count; without that floor a disturbance that decays cleanly to
  // zero was still labelled "rings" on numerical noise.
  let crossings = 0, prev = 0, trough = peak;
  for (let i = 1; i < steps; i++) {
    const slope = dev[i] - dev[i - 1];
    const sg = slope > 1e-6 ? 1 : slope < -1e-6 ? -1 : 0;
    if (sg === -1) trough = Math.min(trough, dev[i]);
    if (sg !== 0 && prev !== 0 && sg !== prev) {
      if (sg === 1 && dev[i] > trough + peak * 0.1) crossings++;
      else if (sg === -1) crossings++;
    }
    if (sg !== 0) prev = sg;
  }

  const outcome: YawStability['outcome'] =
    decayRate < 0.4 ? 'diverges' : crossings >= 3 ? 'rings' : 'settles';

  return { peakRearDeg: peak, endDeg: end, decayRate, outcome };
}

// ===========================================================================
// 3. DEPARTURE WARNING — pedal margin from a settled corner
// ===========================================================================

interface PedalMargin {
  /** Pedal fraction at which the rear departs. 1 = it never did. */
  pedalAtDeparture: number;
  /** Rear slip when the pedal ramp started. */
  rearAtStartDeg: number;
  /** Rear slip at departure. */
  rearAtDepartureDeg: number;
  /** Seconds of warning: time between the rear passing its own peak slip angle
   *  and the car being gone. Under ~0.3s no human can act on it. */
  warningS: number;
  /** Lateral g remaining at departure as a % of the settled cornering g. */
  gAtDeparturePct: number;
  departed: boolean;
}

/**
 * From a settled corner at 85% of the limit, ramp a pedal in and see how much of
 * it the car accepts before the rear goes.
 *
 * This is the test that would have caught the disaster this repo has been
 * chasing. `aeroBalanceFront` at 0.435 accepted FOUR PERCENT of brake pedal at
 * 200km/h before the rear had no equilibrium left; nothing that measures a
 * steady-state skidpad can see that, because a skidpad has no pedal on it. The
 * quantity a driver actually experiences is "how much brake can I carry into
 * this corner", and it is a scalar, and here it is.
 *
 * `warningS` is the other half. A car can have a perfectly respectable pedal
 * margin and still be undrivable if the last 30% of it happens in 80
 * milliseconds. Time between "the rear is past its peak slip angle" and "the car
 * is gone" is how long the driver has to feel it and do something.
 */
function pedalMargin(speedMs: number, steer: number, pedal: 'brake' | 'power'): PedalMargin | null {
  const { car, hold } = settleCorner(speedMs, steer);
  if (isGone(car)) {
    return { pedalAtDeparture: 0, rearAtStartDeg: 99, rearAtDepartureDeg: 99, warningS: 0, gAtDeparturePct: 0, departed: true };
  }

  const c = controls({ steer });
  const rearAtStart = rearSlipDeg(car);
  const gAtStart = Math.abs(car.lateralG);
  const rearPeakSlipDeg = (1.978 / car.spec.corneringStiffnessRear) * RAD;
  const cueBeta = Math.abs(betaDeg(car)) + CUE_BETA_DEG;

  // 0.6 pedal units per second: brisk, but well inside what a foot does.
  const RAMP = 0.6;
  let p = 0;
  let tPastPeak = -1;
  let t = 0;
  const maxT = 1 / RAMP + 0.3;

  while (t < maxT) {
    p = Math.min(1, p + RAMP * PHYSICS_DT);
    c.steer = steer;
    if (pedal === 'brake') { c.brake = p; c.throttle = 0; }
    else { c.throttle = Math.max(hold, p); c.brake = 0; }
    car.step(PHYSICS_DT, c, ENV);
    t += PHYSICS_DT;

    const rear = rearSlipDeg(car);
    if (tPastPeak < 0 && (rear > rearPeakSlipDeg || Math.abs(betaDeg(car)) > cueBeta)) tPastPeak = t;
    // Departed: the rear is past anything a driver holds on a race track and
    // still climbing, or the car is simply gone.
    if (rear > 14 || isGone(car)) {
      return {
        pedalAtDeparture: p,
        rearAtStartDeg: rearAtStart,
        rearAtDepartureDeg: rear,
        warningS: tPastPeak >= 0 ? t - tPastPeak : 0,
        gAtDeparturePct: gAtStart > 1e-6 ? (Math.abs(car.lateralG) / gAtStart) * 100 : 0,
        departed: true,
      };
    }
    if (car.speedKph < 25) return null;
  }

  return {
    pedalAtDeparture: 1,
    rearAtStartDeg: rearAtStart,
    rearAtDepartureDeg: rearSlipDeg(car),
    warningS: Infinity,
    gAtDeparturePct: gAtStart > 1e-6 ? (Math.abs(car.lateralG) / gAtStart) * 100 : 0,
    departed: false,
  };
}

/**
 * The steering-only version: a quasi-static lock ramp at constant speed.
 *
 * Reported for completeness and because it is what the OTHER complaint is about.
 * A car that holds 99% of its peak lateral g all the way to full lock, with the
 * front tyre miles past its own peak slip angle and the rear barely working, is
 * a car that washes wide and never tells you why. That is "gliding".
 */
interface SteerRamp {
  steerAtPeak: number;
  peakLatG: number;
  frontAtPeakDeg: number;
  rearAtPeakDeg: number;
  gAtFullLockPct: number;
  frontAtFullLockDeg: number;
  rearAtFullLockDeg: number;
  departed: boolean;
}

function steerRamp(speedMs: number): SteerRamp {
  const car = makeCar();
  const hold = trim(car, speedMs);
  const c = controls();
  let s = 0;
  let peakG = 0, steerAtPeak = 0, frontAtPeak = 0, rearAtPeak = 0;
  let latSmooth = 0;
  let departed = false;

  const steps = Math.round(16 / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    s = Math.min(1, s + 0.08 * PHYSICS_DT);
    c.steer = s;
    c.throttle = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1);
    car.step(PHYSICS_DT, c, ENV);
    latSmooth += (Math.abs(car.lateralG) - latSmooth) * 0.02;
    if (i * PHYSICS_DT > 0.6 && latSmooth > peakG) {
      peakG = latSmooth;
      steerAtPeak = s;
      frontAtPeak = frontSlipDeg(car);
      rearAtPeak = rearSlipDeg(car);
    }
    if (rearSlipDeg(car) > 14 || isGone(car)) { departed = true; break; }
    if (s >= 1 && i * PHYSICS_DT > 13) break;
  }

  return {
    steerAtPeak,
    peakLatG: peakG,
    frontAtPeakDeg: frontAtPeak,
    rearAtPeakDeg: rearAtPeak,
    gAtFullLockPct: peakG > 1e-6 ? (latSmooth / peakG) * 100 : 0,
    frontAtFullLockDeg: frontSlipDeg(car),
    rearAtFullLockDeg: rearSlipDeg(car),
    departed,
  };
}

// ===========================================================================
// 4. CATCHABILITY
// ===========================================================================

interface Catch {
  slipAtCorrectionDeg: number;
  recovered: boolean;
  peakDeg: number;
  speedKept: number;
}

/**
 * Puts the car in a corner, kicks the rear out, waits a HUMAN reaction time,
 * then applies a correction a human could actually apply, and asks whether the
 * car comes back.
 *
 * The correction is not a magic stabiliser. It is what a driver does: point the
 * front wheels where the car is actually going — which is what "opposite lock"
 * physically means, driving the front slip angle toward zero so the front tyres
 * roll and keep their steering authority — moved no faster than human hands, and
 * come off the pedal that caused it. Nothing here can save a car that the tyre
 * model has already decided is unrecoverable.
 *
 * WHEN the driver starts correcting is the part that has to be right, and the
 * first version of this got it wrong in a way that made the car look far worse
 * than it is. It applied the pedal, waited a fixed 350ms, applied the yaw
 * impulse, waited another 250ms, and only then corrected — so in the cases where
 * the PEDAL is itself the disturbance, the driver sat still for 600ms while the
 * car left the road. No human does that. A driver reacts 250ms after the car
 * gives him a CUE, and the cue is the rear going past its peak slip angle, which
 * is the point at which the back of the car starts to feel light. The reaction
 * clock therefore starts there, wherever there happens to fall.
 *
 * The sweep matters more than any single number. If the car is recoverable at 6
 * degrees and gone at 8, the driver has a two-degree window he cannot see and
 * cannot feel, and every mistake past it is a donut. A real car is recoverable
 * well past its peak slip angle — that is what a drift IS — so the honest target
 * is a recovery window extending a good way beyond the tyre's peak.
 */
function catchability(speedMs: number, steer: number, load: LoadCase, impulse: number): Catch | null {
  const { car, hold } = settleCorner(speedMs, steer);
  if (isGone(car)) return { slipAtCorrectionDeg: 99, recovered: false, peakDeg: 99, speedKept: 0 };

  const entrySpeed = car.speedMs;
  // What the driver actually feels first. See CUE_BETA_DEG.
  const cueRearDeg = (1.978 / car.spec.corneringStiffnessRear) * RAD;
  const cueBeta = Math.abs(betaDeg(car)) + CUE_BETA_DEG;
  const c = controls({ steer });
  let throttleNow = hold;
  let brakeNow = 0;

  const setPedals = () => {
    if (load === 'coast') { throttleNow = clamp(hold + (speedMs - car.speedMs) * 0.03, 0, 1); brakeNow = 0; }
    else if (load === 'brake') { throttleNow = 0; brakeNow = BRAKE_LEVEL; }
    else { throttleNow = POWER_LEVEL; brakeNow = 0; }
    c.throttle = throttleNow;
    c.brake = brakeNow;
  };

  // The pedal goes on and the disturbance arrives together — a bump taken on
  // the power, or a kerb clipped under braking.
  setPedals();
  car.yawRate += Math.sign(car.yawRate || 1) * impulse;

  let peak = 0;
  let s = steer;

  // --- Wait for the cue, then a human reaction time ------------------------
  let cued = false;
  let sinceCue = 0;
  for (let i = 0; i < Math.round(3.0 / PHYSICS_DT); i++) {
    c.steer = s;
    setPedals();
    car.step(PHYSICS_DT, c, ENV);
    peak = Math.max(peak, rearSlipDeg(car));
    if (isGone(car)) {
      return { slipAtCorrectionDeg: rearSlipDeg(car), recovered: false, peakDeg: peak, speedKept: 0 };
    }
    if (!cued && (rearSlipDeg(car) > cueRearDeg || Math.abs(betaDeg(car)) > cueBeta)) cued = true;
    if (cued) { sinceCue += PHYSICS_DT; if (sinceCue >= REACTION_S) break; }
    // Nothing ever went wrong: this disturbance simply did not depart.
    if (!cued && i * PHYSICS_DT > 1.2) break;
    if (car.speedKph < 25) return null;
  }
  const slipAtCorrection = rearSlipDeg(car);

  // --- Correction ----------------------------------------------------------
  const spec = car.spec;
  const steps = Math.round(4.0 / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    const rackLimit = steerRackLimit(car.speedMs);
    const vRef = Math.max(Math.abs(car.localVelX), 1.2);
    const frontVelAngle = Math.atan2(car.localVelY + car.yawRate * spec.cogToFrontM, vRef);
    const want = clamp(-frontVelAngle / Math.max(spec.maxSteerRad * rackLimit, 1e-3), -1, 1);
    s = slew(s, want, PHYSICS_DT);
    c.steer = s;

    // Off the pedal that caused it, over ~0.2s — a human foot, not a switch.
    throttleNow = Math.max(0, throttleNow - PHYSICS_DT / 0.2);
    brakeNow = Math.max(0, brakeNow - PHYSICS_DT / 0.2);
    c.throttle = throttleNow;
    c.brake = brakeNow;

    car.step(PHYSICS_DT, c, ENV);
    peak = Math.max(peak, rearSlipDeg(car));
    if (isGone(car)) {
      return { slipAtCorrectionDeg: slipAtCorrection, recovered: false, peakDeg: peak, speedKept: car.speedMs / entrySpeed };
    }
    if (car.speedKph < 15) break;
  }

  const recovered =
    rearSlipDeg(car) < 8 &&
    Math.abs(betaDeg(car)) < 12 &&
    car.speedMs > entrySpeed * 0.30;

  return { slipAtCorrectionDeg: slipAtCorrection, recovered, peakDeg: peak, speedKept: car.speedMs / entrySpeed };
}

function catchSweep(speedMs: number, steer: number, load: LoadCase): {
  maxCatchableDeg: number;
  firstLostDeg: number;
  recovered: number;
  total: number;
} {
  let maxCatchable = 0;
  let firstLost = Infinity;
  let recovered = 0;
  let total = 0;
  for (let imp = 0.05; imp <= 1.8001; imp += 0.05) {
    const r = catchability(speedMs, steer, load, imp);
    if (!r) continue;
    total++;
    if (r.recovered) { recovered++; maxCatchable = Math.max(maxCatchable, r.slipAtCorrectionDeg); }
    else if (r.slipAtCorrectionDeg < firstLost) firstLost = r.slipAtCorrectionDeg;
  }
  return { maxCatchableDeg: maxCatchable, firstLostDeg: firstLost, recovered, total };
}

// ===========================================================================
// 5. UNDERSTEER GRADIENT
// ===========================================================================

/**
 * K = (delta - L/R) / ay, in degrees of steer per g.
 *
 * Positive is understeer (more lock needed as the corner loads up), negative is
 * oversteer. A road car sits around 2-5 deg/g; a racing car is deliberately
 * closer to neutral, 0.5-2 deg/g, because the driver wants response. But a value
 * near ZERO means the car has no directional stability margin of its own, and a
 * NEGATIVE one means it is directionally unstable and requires the driver to be
 * correcting continuously.
 *
 * Reported in the linear range (what turn-in feels like) and near the limit
 * (what it does when leaned on). Those two disagreeing is normal; the sign
 * flipping between them is a car that pushes on entry and snaps when loaded.
 */
function understeerGradient(speedMs: number, targetLatG: number, L: number): number | null {
  let lo: SteadyPoint | null = null;
  let hi: SteadyPoint | null = null;
  for (let steer = 0.05; steer <= 1.0001; steer += 0.05) {
    const p = steadyState(speedMs, Math.round(steer * 100) / 100);
    if (p.spun) break;
    if (p.latG <= targetLatG) lo = p;
    else { hi = p; break; }
  }
  const p = hi ?? lo;
  if (!p || p.yawRate < 1e-4 || p.latG < 0.05) return null;
  const R = p.speedMs / p.yawRate;
  return ((p.steerAngleRad - L / R) * RAD) / p.latG;
}

// ===========================================================================
// Report
// ===========================================================================

const SPEEDS = [90, 150, 220, 300];
const f = (v: number, d = 2, w = 6) =>
  (Number.isFinite(v) ? v.toFixed(d) : '  --').padStart(w);
const skip = (w: number) => 'n/a'.padStart(w);

const REF = makeCar();
const REAR_PEAK_DEG = (1.978 / REF.spec.corneringStiffnessRear) * RAD;
const FRONT_PEAK_DEG = (1.978 / REF.spec.corneringStiffnessFront) * RAD;

console.log('\n================================================================');
console.log(' DRIVABILITY PROBE');
console.log(' human reaction ' + (REACTION_S * 1000) + 'ms | steering rate ' +
            STEER_RATE.toFixed(1) + ' input/s (~100 deg/s at the road wheel)');
console.log(' tyre peaks: front ' + FRONT_PEAK_DEG.toFixed(2) + ' deg, rear ' +
            REAR_PEAK_DEG.toFixed(2) + ' deg of slip');
console.log(' brake case = ' + BRAKE_LEVEL.toFixed(2) + ' pedal, power case = ' +
            POWER_LEVEL.toFixed(2) + ' throttle, both entered from a settled corner');
console.log('================================================================');

// Reference limits per speed, used to place every test at a meaningful input.
const LIMITS = new Map<number, LimitInfo>();
for (const kph of SPEEDS) LIMITS.set(kph, findLimit(kph / 3.6));

const usable = (kph: number, load: LoadCase) => load !== 'brake' || kph >= MIN_BRAKE_KPH;

// ===========================================================================
console.log('\n1. TURN-IN RESPONSE  (steer ramped to 65% of the limit input)');
console.log('   t90    time to 90% of settled yaw rate. >0.35s reads as "gliding".');
console.log('   over%  yaw overshoot before settling. 5-20% alive, >40% darty.');
console.log('   zeta   damping ratio implied by that overshoot. <0.35 rings.');
console.log('   osc    yaw-rate reversals after the first peak. >2 is visible ringing.');
console.log('');
console.log('   speed  load    steer    t90   tPeak    over%   zeta  osc  curv_ss   latG  meanKph');
console.log('   -------------------------------------------------------------------------------');
const turnInWorst = { t90: 0, over: 0, zeta: 9 };
for (const kph of SPEEDS) {
  for (const load of LOAD_CASES) {
    if (!usable(kph, load)) {
      console.log(`   ${String(kph).padStart(5)}  ${load.padEnd(6)}  ${skip(46)}  (cannot brake at this speed for a measurable window)`);
      continue;
    }
    const target = Math.max(0.1, steerForLatG(LIMITS.get(kph)!, 0.65));
    const r = turnInResponse(kph / 3.6, target, load);
    if (!r) { console.log(`   ${String(kph).padStart(5)}  ${load.padEnd(6)}  ${skip(46)}`); continue; }
    if (Number.isFinite(r.t90)) turnInWorst.t90 = Math.max(turnInWorst.t90, r.t90);
    if (Number.isFinite(r.overshootPct)) turnInWorst.over = Math.max(turnInWorst.over, r.overshootPct);
    turnInWorst.zeta = Math.min(turnInWorst.zeta, r.zeta);
    console.log(
      `   ${String(kph).padStart(5)}  ${load.padEnd(6)}  ${f(target, 2, 5)}  ${f(r.t90, 3)}  ${f(r.tPeak, 3)}` +
      `  ${f(r.overshootPct, 1, 7)}  ${r.zeta > 1 ? '  >1  ' : f(r.zeta, 2)}  ${String(r.oscillations).padStart(3)}` +
      `  ${f(r.settledYaw, 4, 7)}  ${f(r.settledLatG, 2)}  ${f(r.meanKph, 0, 7)}` +
      (r.divergent ? '   DIVERGENT' : ''),
    );
  }
}

// ===========================================================================
console.log('\n2. YAW STABILITY  (yaw impulse, HANDS STILL, differenced against an');
console.log('   undisturbed reference run of the same manoeuvre)');
console.log('   Coasting cases sit at 90% of the limit; pedal cases at ' +
            (CORNER_FRACTION.brake * 100).toFixed(0) + '%, which is');
console.log('   inside the friction circle once the pedal is added.');
console.log('   peakDev/endDev  how far the disturbed run diverged from the reference.');
console.log('   decay  1/s at which that difference dies away, measured from its peak.');
console.log('          Below 0.4 the car is not recovering on its own and the driver');
console.log('          has to catch every bump. Above ~1.5 it settles like a real car.');
console.log('');
console.log('   speed  load    impulse    peakDev    endDev   decay   outcome');
console.log('   ---------------------------------------------------------------');
let stabWorst = Infinity;
let stabDiverged = 0;
let stabBaselineGone = 0;
for (const kph of SPEEDS) {
  for (const load of LOAD_CASES) {
    if (!usable(kph, load)) continue;
    const target = Math.max(0.1, steerForLatG(LIMITS.get(kph)!, CORNER_FRACTION[load]));
    for (const imp of [0.15, 0.35]) {
      const r = yawStability(kph / 3.6, target, load, imp);
      if (!r) continue;
      if (r.outcome === 'diverges') stabDiverged++;
      if (r.outcome === 'baseline gone') stabBaselineGone++;
      if (r.decayRate > -50 && Number.isFinite(r.decayRate)) stabWorst = Math.min(stabWorst, r.decayRate);
      console.log(
        `   ${String(kph).padStart(5)}  ${load.padEnd(6)}  ${f(imp, 2, 7)}  ${f(r.peakRearDeg, 2, 8)}deg` +
        `  ${f(r.endDeg, 2, 6)}deg  ${f(r.decayRate, 2)}   ${r.outcome}`,
      );
    }
  }
}

// ===========================================================================
console.log('\n3a. STEERING DEPARTURE  (quasi-static lock ramp, constant speed)');
console.log('    A car that holds ~100% of peak g all the way to full lock, with the');
console.log('    front tyre far past its own peak and the rear barely working, washes');
console.log('    wide and never says why. That is "gliding".');
console.log('');
console.log('   speed   peakG  steer@peak  front@peak  rear@peak   g@lock%  front@lock  rear@lock');
console.log('   ---------------------------------------------------------------------------------');
for (const kph of SPEEDS) {
  const r = steerRamp(kph / 3.6);
  console.log(
    `   ${String(kph).padStart(5)}  ${f(r.peakLatG, 2)}  ${f(r.steerAtPeak, 2, 10)}` +
    `  ${f(r.frontAtPeakDeg, 2, 8)}deg  ${f(r.rearAtPeakDeg, 2, 7)}deg  ${f(r.gAtFullLockPct, 1, 8)}` +
    `  ${f(r.frontAtFullLockDeg, 2, 8)}deg  ${f(r.rearAtFullLockDeg, 2, 7)}deg` +
    (r.departed ? '   DEPARTED' : ''),
  );
}

console.log('\n3b. PEDAL MARGIN  (settled at 85% of the limit, then ramp a pedal in)');
console.log('    pedal@gone  how much of the pedal the car accepts before the rear goes.');
console.log('                This is the number that matters: it is "how much brake can');
console.log('                I carry into this corner", and no skidpad can see it.');
console.log('    warning     seconds between the car first telling the driver (2 deg of extra');
console.log('                sideslip, or the rear past its peak slip angle) and being gone.');
console.log('                Under 0.3s no human can act on it.');
console.log('');
console.log('   speed  pedal   pedal@gone  rear@start  rear@gone  warning  g@gone%');
console.log('   ----------------------------------------------------------------------');
let worstBrakeMargin = Infinity;
let worstWarning = Infinity;
for (const kph of SPEEDS) {
  for (const pedal of ['brake', 'power'] as const) {
    const target = Math.max(0.1, steerForLatG(LIMITS.get(kph)!, 0.85));
    const r = pedalMargin(kph / 3.6, target, pedal);
    if (!r) { console.log(`   ${String(kph).padStart(5)}  ${pedal.padEnd(6)}  ${skip(10)}`); continue; }
    if (pedal === 'brake') worstBrakeMargin = Math.min(worstBrakeMargin, r.pedalAtDeparture);
    if (r.departed) worstWarning = Math.min(worstWarning, r.warningS);
    console.log(
      `   ${String(kph).padStart(5)}  ${pedal.padEnd(6)}  ${f(r.pedalAtDeparture, 2, 10)}` +
      `  ${f(r.rearAtStartDeg, 2, 8)}deg  ${f(r.rearAtDepartureDeg, 2, 7)}deg` +
      `  ${Number.isFinite(r.warningS) ? f(r.warningS, 2, 7) : '   --  '}  ${f(r.gAtDeparturePct, 0, 6)}` +
      (r.departed ? '' : '   (never departed)'),
    );
  }
}

// ===========================================================================
console.log('\n4. CATCHABILITY  (yaw impulse at 90% of the limit, 250ms delay, opposite lock)');
console.log('   maxCatch   the largest rear slip angle, at the moment the driver starts');
console.log('              correcting, from which the car still comes back.');
console.log('   firstLost  the smallest angle from which it does NOT. If firstLost sits');
console.log('              below maxCatch the recovery window has holes in it.');
console.log('');
console.log('   speed  load    maxCatch   firstLost   recovered');
console.log('   ------------------------------------------------------');
let catchWorstLost = Infinity;
let catchLostCases = 0;
for (const kph of SPEEDS) {
  for (const load of LOAD_CASES) {
    if (!usable(kph, load)) continue;
    const target = Math.max(0.1, steerForLatG(LIMITS.get(kph)!, CORNER_FRACTION[load]));
    const r = catchSweep(kph / 3.6, target, load);
    // The headline number is the SMALLEST angle from which the car could not be
    // saved, not the largest from which it could. `maxCatchable` is bounded by
    // how far the sweep managed to push the car, so a very stable case reports a
    // small maxCatchable simply because nothing ever got it sideways — reading
    // that as a failure is backwards.
    if (r.firstLostDeg < catchWorstLost) catchWorstLost = r.firstLostDeg;
    if (Number.isFinite(r.firstLostDeg)) catchLostCases++;
    console.log(
      `   ${String(kph).padStart(5)}  ${load.padEnd(6)}  ${f(r.maxCatchableDeg, 2, 8)}deg` +
      `  ${f(r.firstLostDeg, 2, 9)}deg   ${String(r.recovered).padStart(2)}/${r.total}`,
    );
  }
}

// ===========================================================================
console.log('\n5. UNDERSTEER GRADIENT  (deg of steer per g; + understeer, - oversteer)');
console.log('   Near zero means the car has no directional stability margin of its own.');
console.log('   Negative means it is unstable and needs continuous correction.');
console.log('');
console.log('   speed    K@1g   K@near-limit');
console.log('   -----------------------------');
for (const kph of SPEEDS) {
  const near = Math.max(1.2, LIMITS.get(kph)!.peakLatG * 0.9);
  const kLin = understeerGradient(kph / 3.6, 1.0, REF.spec.wheelbaseM);
  const kLim = understeerGradient(kph / 3.6, near, REF.spec.wheelbaseM);
  console.log(
    `   ${String(kph).padStart(5)}  ${kLin === null ? '   --' : f(kLin, 2)}` +
    `   ${kLim === null ? '   --' : f(kLim, 2)}`,
  );
}

// ===========================================================================
console.log('\nSUMMARY');
console.log('  worst turn-in t90                 ' + turnInWorst.t90.toFixed(3) + ' s   (want < 0.35)');
console.log('  worst turn-in overshoot           ' + turnInWorst.over.toFixed(1) + ' %   (want < 40)');
console.log('  worst yaw damping ratio           ' + turnInWorst.zeta.toFixed(2) + '     (want > 0.35)');
console.log('  worst free-yaw decay rate         ' + stabWorst.toFixed(2) + ' 1/s (want > 0.40)');
console.log('  hands-still divergences           ' + stabDiverged);
console.log('  cases where the pedal alone left  ' + stabBaselineGone + '   (see 3b)');
console.log('  worst brake pedal margin          ' + (Number.isFinite(worstBrakeMargin) ? worstBrakeMargin.toFixed(2) : 'n/a') + '     (want > 0.5)');
console.log('  shortest departure warning        ' + (Number.isFinite(worstWarning) ? worstWarning.toFixed(2) + ' s' : 'never departed') + '  (want > 0.30)');
console.log('  smallest UNCATCHABLE rear slip    ' +
            (Number.isFinite(catchWorstLost) ? catchWorstLost.toFixed(2) + ' deg' : 'nothing was lost') +
            ' (want > ' + REAR_PEAK_DEG.toFixed(1) + ', the tyre peak)');
console.log('  load cases with any loss          ' + catchLostCases);
console.log('');
