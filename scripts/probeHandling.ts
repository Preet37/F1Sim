/**
 * Handling balance probe.
 *
 * The performance harness (`validate:physics`) answers "is this car fast?".
 * This one answers "does it drive?" — which is a different question and the one
 * players actually feel.
 *
 *   1. TURN-IN RESPONSE. Time from a step steer input to 90% of the steady-state
 *      yaw rate. A real F1 car is on the order of 0.15-0.25s. Much slower and
 *      the car feels like it "will not turn"; much faster and it is twitchy.
 *
 *   2. LIMIT BALANCE. Which axle saturates first when you keep adding lock. If
 *      the rear runs out before the front, the car snaps into oversteer and the
 *      player reports "it drifts a lot". If the front runs out a long way
 *      before the rear, the car washes out and the player reports "it is hard
 *      to turn". A road-going race car wants the front marginally first.
 *
 *   3. STABILITY. Hold a corner at the limit, then lift off. A stable car
 *      settles; an unstable one diverges into a spin.
 *
 *   4. WHAT ONE KEY PRESS DOES. (new)
 *   5. WHETHER A KEYBOARD DRIVER CAN HOLD A LANE AT ALL. (new)
 *
 * The peak of the magic formula is at alpha = 1.978 / B (where B is the axle's
 * cornering stiffness), so the two stiffness numbers set BOTH the linear balance
 * and the limit balance and cannot be chosen independently. That coupling is why
 * this probe exists: it is the only way to see what a given pair actually does.
 *
 * TWO THINGS WERE WRONG WITH THIS FILE AND BOTH ARE FIXED HERE — see issue #46.
 *
 * (a) IT HAD NO ASSERTIONS. It printed three tables and exited 0 no matter what
 *     they said, which meant "probe:handling passes" was worth nothing at all
 *     while the player could see the car swerving. PROJECT.md §3.2 is explicit
 *     that a probe a broken feature passes is worse than no probe, and this was
 *     that probe. Every table now carries the check the prose beside it already
 *     implied.
 *
 * (b) IT NEVER TOUCHED THE PLAYER'S INPUT PATH. Like `probe:drivability`, it
 *     built a `VehicleControls` literal and handed it to the solver, so it could
 *     only ever find bugs in the solver — which is why neither of them could
 *     have caught issue #45, and why neither of them has anything to say about a
 *     complaint that is about how the car responds to a KEY. Sections 4 and 5
 *     drive `KeyboardEvent -> InputController -> playerControls ->
 *     VehiclePhysics`, the way `probe:gearbox` does.
 *
 * Run: npm run probe:handling
 */

import { VehiclePhysics, type VehicleControls, type EnvironmentState } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';
import { driveLane, radiusForG, tapOnce, type Lane } from './lib/keyboardRig';

// ===========================================================================
// Reporting
// ===========================================================================

let checks = 0;
let failures = 0;

function ok(pass: boolean, label: string, detail: string): void {
  checks++;
  if (!pass) failures++;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`         ${detail}`);
}

const ENV: EnvironmentState = {
  trackTempC: 38, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
};

function controls(over: Partial<VehicleControls> = {}): VehicleControls {
  return {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false, speedLimitMs: 0,
    reverse: false,
    ...over,
  };
}

function makeCar(downforceDemand = 0.55, fuelL = 60) {
  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(downforceDemand, fuelL));
  const car = new VehiclePhysics(spec, 'medium');
  car.fuelL = fuelL;
  car.frontTires.tempC = 105;
  car.rearTires.tempC = 108;
  car.frontTires.lapsOnSet = 2;
  car.rearTires.lapsOnSet = 2;
  return car;
}

/** Holds a constant steer at a constant speed and reports the settled state. */
function stepSteer(speedKph: number, steer: number, holdS = 4) {
  const car = makeCar();
  car.placeAt(0, 0, 0, speedKph / 3.6);
  const ctl = controls();

  // Settle straight-line first so load transfer and rpm are stable.
  for (let i = 0; i < 60; i++) {
    ctl.throttle = holdThrottle(car, speedKph);
    car.step(PHYSICS_DT, ctl, ENV);
  }

  ctl.steer = steer;
  const steady: number[] = [];
  let t = 0;
  let t90 = 0;
  let peakYaw = 0;
  let spun = false;

  const steps = Math.round(holdS / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    ctl.throttle = holdThrottle(car, speedKph);
    car.step(PHYSICS_DT, ctl, ENV);
    t += PHYSICS_DT;
    const yaw = Math.abs(car.yawRate);
    if (yaw > peakYaw) peakYaw = yaw;
    // A slip angle past 35 degrees is not a car cornering, it is a car spinning.
    if (Math.abs(Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 1))) > 0.61) spun = true;
    if (t > holdS * 0.6) steady.push(yaw);
  }

  const settledYaw = steady.reduce((a, b) => a + b, 0) / Math.max(steady.length, 1);

  // Second pass for the rise time, now that the settled value is known.
  {
    const c2 = makeCar();
    c2.placeAt(0, 0, 0, speedKph / 3.6);
    const k = controls();
    for (let i = 0; i < 60; i++) { k.throttle = holdThrottle(c2, speedKph); c2.step(PHYSICS_DT, k, ENV); }
    k.steer = steer;
    let tt = 0;
    for (let i = 0; i < steps; i++) {
      k.throttle = holdThrottle(c2, speedKph);
      c2.step(PHYSICS_DT, k, ENV);
      tt += PHYSICS_DT;
      if (!t90 && Math.abs(c2.yawRate) >= settledYaw * 0.9) { t90 = tt; break; }
    }
  }

  return {
    yawRate: settledYaw,
    peakYaw,
    lateralG: Math.abs(car.lateralG),
    balance: car.balance,
    alphaFrontDeg: (car.frontTires.slipAngle * 180) / Math.PI,
    alphaRearDeg: (car.rearTires.slipAngle * 180) / Math.PI,
    frontUse: car.frontLateralN / Math.max(car.capFrontN, 1),
    rearUse: car.rearLateralN / Math.max(car.capRearN, 1),
    t90,
    spun,
  };
}

/** Throttle needed to hold roughly constant speed, so drag does not decay it. */
function holdThrottle(car: VehiclePhysics, targetKph: number): number {
  const err = targetKph - car.speedKph;
  return Math.max(0, Math.min(0.55, 0.18 + err * 0.05));
}

const F = (n: number, w = 6, d = 2) => n.toFixed(d).padStart(w);

/**
 * Turn-in slower than this reads as "on ice for the first part of the corner",
 * which is the gliding complaint stated precisely. Shared with
 * `probe:drivability`, which uses the same number for the same reason.
 */
const T90_BAR_S = 0.35;
/** Sideslip past this after a lift is a car that had to be caught. */
const LIFT_SLIP_BAR_DEG = 14;

console.log('\n1. STEP-STEER RESPONSE (constant speed, steady throttle)');
console.log('  SPEED  STEER   YAW/s   LAT g   T90    aF°    aR°   Fuse   Ruse  BAL   SPUN');
console.log('  ' + '-'.repeat(74));
let spins = 0;
let worstT90 = 0;
let worstT90At = '';
for (const kph of [90, 150, 220, 300]) {
  for (const steer of [0.25, 0.5, 1.0]) {
    const r = stepSteer(kph, steer);
    if (r.spun) spins++;
    if (r.t90 > worstT90) { worstT90 = r.t90; worstT90At = `${kph} km/h at ${steer.toFixed(2)} of lock`; }
    console.log(
      '  ' + String(kph).padStart(5) + F(steer, 6) + F(r.yawRate, 8) + F(r.lateralG, 8) +
      F(r.t90, 7, 3) + F(r.alphaFrontDeg, 7, 1) + F(r.alphaRearDeg, 7, 1) +
      F(r.frontUse, 7) + F(r.rearUse, 7) + F(r.balance, 6) + (r.spun ? '   SPIN' : '   -'),
    );
  }
}
console.log('');
ok(spins === 0, 'no steady steering input spins the car',
  `${spins} of 12 (speed, lock) points ended past 35 degrees of sideslip`);
ok(worstT90 <= T90_BAR_S, `turn-in reaches 90% of settled yaw inside ${T90_BAR_S}s`,
  `worst ${worstT90.toFixed(3)}s, ${worstT90At || 'nowhere'}`);

console.log('\n2. LIMIT BALANCE (which axle gives up first as lock is added)');
console.log('  Positive balance = the REAR is closer to its limit (oversteer/drift).');
console.log('  SPEED   first-to-saturate   steer at saturation   balance there');
console.log('  ' + '-'.repeat(66));
const rearFirst: string[] = [];
for (const kph of [90, 150, 220, 300]) {
  let firstAxle = 'neither';
  let atSteer = 0;
  let bal = 0;
  for (let s = 0.1; s <= 1.001; s += 0.05) {
    const r = stepSteer(kph, s, 2.5);
    if (r.frontUse > 0.985 || r.rearUse > 0.985 || r.spun) {
      firstAxle = r.spun ? 'REAR (spin)' : r.frontUse >= r.rearUse ? 'front' : 'REAR';
      atSteer = s;
      bal = r.balance;
      break;
    }
  }
  if (firstAxle.startsWith('REAR')) rearFirst.push(`${kph} km/h (${firstAxle})`);
  console.log('  ' + String(kph).padStart(5) + '   ' + firstAxle.padEnd(18) +
    F(atSteer, 20) + F(bal, 16));
}
console.log('');
ok(rearFirst.length === 0, 'the FRONT axle saturates first at every speed',
  rearFirst.length === 0
    ? 'front-limited at 90, 150, 220 and 300 km/h — the car washes wide rather than snapping'
    : `rear ran out first at ${rearFirst.join(', ')} — this is the "goofy donuts" failure`);

console.log('\n3. LIFT-OFF STABILITY (at the limit, close the throttle, does it settle?)');
console.log('  SPEED   peak slip after lift   outcome');
console.log('  ' + '-'.repeat(50));
let worstLift = 0;
let worstLiftAt = 0;
for (const kph of [110, 180, 260]) {
  const car = makeCar();
  car.placeAt(0, 0, 0, kph / 3.6);
  const ctl = controls({ steer: 0.55 });
  for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
    ctl.throttle = holdThrottle(car, kph);
    car.step(PHYSICS_DT, ctl, ENV);
  }
  ctl.throttle = 0;
  let peakSlip = 0;
  for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
    car.step(PHYSICS_DT, ctl, ENV);
    const slip = Math.abs(Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 1)));
    if (slip > peakSlip) peakSlip = slip;
  }
  const deg = (peakSlip * 180) / Math.PI;
  if (deg > worstLift) { worstLift = deg; worstLiftAt = kph; }
  console.log('  ' + String(kph).padStart(5) + F(deg, 22, 1) + '°   ' +
    (deg > 35 ? 'SPUN' : deg > 14 ? 'sliding but caught' : 'settled'));
}
console.log('');
ok(worstLift <= LIFT_SLIP_BAR_DEG, 'closing the throttle at the limit does not send the rear away',
  `worst ${worstLift.toFixed(1)}° of sideslip at ${worstLiftAt} km/h (bar ${LIFT_SLIP_BAR_DEG}°)`);

// ===========================================================================
// 4. What one key press does
// ===========================================================================
//
// Everything above is open-loop and hands the solver a controls literal. This
// is the first thing in the file the PLAYER can actually do: one press of one
// key, from straight running, through the real InputController.
//
// It is model-free — no driver, no controller, no tuned constant — so what it
// reports is the plain transfer function from the smallest thing a human can
// physically do to the thing they see happen.

console.log('\n4. WHAT ONE KEY PRESS DOES  (KeyboardEvent -> InputController -> physics)');
console.log('   One press of `d` from straight running, at 60fps. lat@1s and lat@2s are');
console.log('   how far sideways the car has gone by then; a car is 2.0m wide and the');
console.log('   narrowest circuit on the calendar is about 15m across.');
console.log('');
console.log('   kph   press   lock   lat@1s   lat@2s   heading   peak latG   rear°');
console.log('   ' + '-'.repeat(70));

const TAP_SPEEDS = [100, 200, 300];
const TAP_MS = [30, 50, 80, 120, 200];
/** The shortest press the table calls a deliberate correction. */
const SHORT_TAP_MS = 30;

const tapLat = new Map<string, number>();
for (const kph of TAP_SPEEDS) {
  for (const ms of TAP_MS) {
    const r = tapOnce({ speedKph: kph, tapMs: ms });
    tapLat.set(`${kph}/${ms}`, r.lateral1sM);
    console.log(
      '   ' + String(kph).padStart(3) + String(ms).padStart(7) + 'ms' +
      F(r.peakSteer, 7, 3) + F(r.lateral1sM, 9, 2) + F(r.lateral2sM, 9, 2) +
      F(r.headingDeg, 9, 2) + '°' + F(r.peakLatG, 11, 2) + F(r.peakRearSlipDeg, 8, 2),
    );
  }
  console.log('');
}

// (a) Every press must reach the car. A press that produces literally nothing
//     is the frame-rate bug of PROJECT.md §6 in its purest form.
{
  const dead: string[] = [];
  for (const kph of TAP_SPEEDS) {
    for (const ms of TAP_MS) {
      if ((tapLat.get(`${kph}/${ms}`) ?? 0) < 1e-3) dead.push(`${ms}ms at ${kph} km/h`);
    }
  }
  ok(dead.length === 0, 'every press moves the car at 60fps',
    dead.length === 0 ? 'all 15 presses registered' : `discarded entirely: ${dead.join(', ')}`);
}

// (b) The response must be monotone in how long the key was held. A player who
//     holds a key longer and gets LESS has no way to learn the control.
{
  const inversions: string[] = [];
  for (const kph of TAP_SPEEDS) {
    for (let i = 1; i < TAP_MS.length; i++) {
      const a = tapLat.get(`${kph}/${TAP_MS[i - 1]}`) ?? 0;
      const b = tapLat.get(`${kph}/${TAP_MS[i]}`) ?? 0;
      if (b < a - 1e-6) inversions.push(`${kph} km/h: ${TAP_MS[i]}ms moved less than ${TAP_MS[i - 1]}ms`);
    }
  }
  ok(inversions.length === 0, 'a longer press always moves the car further',
    inversions.length === 0 ? 'monotone at all three speeds' : inversions.join('; '));
}

// (c) FRAME-RATE INDEPENDENCE, measured as DISPLACEMENT rather than as peak
//     steering input.
//
//     `probe:framerate` measures the peak `controls.steer` a hold buys and
//     reports 9.3% across 15-144fps, which is the number PROJECT.md §6 records
//     for the keyboard fix. That is the right measurement of the ramp and it is
//     not the whole chain: the physics only ever sees the value the frame ENDED
//     on, so an input whose entire life falls inside one frame reaches the car
//     attenuated or not at all — and it is the metres, not the units of lock,
//     that the player sees.
console.log('   frame-rate spread of the same press, as lateral displacement at 1s');
console.log('   kph   press     15fps     30fps     60fps    144fps   spread');
console.log('   ' + '-'.repeat(64));
let worstSpread = 0;
let worstSpreadAt = '';
const deadAtRate: string[] = [];
for (const kph of TAP_SPEEDS) {
  for (const ms of [SHORT_TAP_MS, 80, 160]) {
    const vals = [15, 30, 60, 144].map(
      (fps) => tapOnce({ speedKph: kph, tapMs: ms, framePeriodMs: 1000 / fps }).lateral1sM,
    );
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (lo < 1e-3) deadAtRate.push(`${ms}ms at ${kph} km/h is worth nothing at some frame rate`);
    const spread = lo > 1e-3 ? ((hi - lo) / lo) * 100 : Infinity;
    if (spread > worstSpread) { worstSpread = spread; worstSpreadAt = `${ms}ms at ${kph} km/h`; }
    console.log(
      '   ' + String(kph).padStart(3) + String(ms).padStart(7) + 'ms' +
      vals.map((v) => F(v, 10, 3)).join('') +
      (Number.isFinite(spread) ? F(spread, 8, 1) + '%' : '      dead'),
    );
  }
}
console.log('');
/**
 * Bar for the spread.
 *
 * NOT loosened to fit: 15% is the number PROJECT.md §6 already implies is
 * acceptable, being a little above the 9.3% the peak-steer measurement reports
 * for the same fix. If this fails, the fix is incomplete rather than the bar
 * being wrong.
 */
const FRAME_SPREAD_BAR_PCT = 15;
ok(deadAtRate.length === 0, 'no press is silently deleted by the frame rate',
  deadAtRate.length === 0 ? 'every press reached the car at 15, 30, 60 and 144fps' : deadAtRate.join('; '));
ok(worstSpread <= FRAME_SPREAD_BAR_PCT,
  `the same press is worth the same distance at any frame rate (<=${FRAME_SPREAD_BAR_PCT}%)`,
  Number.isFinite(worstSpread)
    ? `worst spread ${worstSpread.toFixed(1)}% at ${worstSpreadAt}`
    : `a press was worth nothing at all at some frame rate (${worstSpreadAt})`);

// ===========================================================================
// 5. Can a keyboard driver hold a lane?
// ===========================================================================
//
// The complaint this probe exists to answer is not about a step input or a
// scripted slalom; it is about trying to hold a line and the car not staying
// there. That is a CLOSED-LOOP property and nothing in this repo measured it.
//
// Two arms, one driver, one car: the same pure-pursuit driver with the same
// 250ms reaction time flies the same lane twice, once through the keyboard and
// once with a continuous wheel. The difference between the arms belongs to the
// input path and to nothing else.

console.log('\n5. CAN A KEYBOARD DRIVER HOLD A LANE?  (closed loop, 250ms reaction)');
console.log('   swing is peak-to-peak wander over the measured window: what "swerving"');
console.log('   is, in metres. The analogue arm is the same driver with a wheel, so the');
console.log('   ratio between the columns is the price of the digital input path.');
console.log('');
console.log('   lane            kph    kb swing   kb rms   wheel swing   ratio   kb outcome');
console.log('   ' + '-'.repeat(78));

interface LaneCase { label: string; lane: Lane; kph: number }
const LANE_CASES: LaneCase[] = [
  { label: 'straight', lane: { radiusM: Infinity }, kph: 120 },
  { label: 'straight', lane: { radiusM: Infinity }, kph: 200 },
  { label: 'straight', lane: { radiusM: Infinity }, kph: 280 },
  // Corner radii chosen at roughly two thirds of the peak lateral g section 1
  // measures at that speed, so the lane itself is comfortably inside the tyre.
  { label: 'corner 1.2g', lane: { radiusM: radiusForG(120, 1.2) }, kph: 120 },
  { label: 'corner 2.0g', lane: { radiusM: radiusForG(200, 2.0) }, kph: 200 },
  { label: 'corner 2.6g', lane: { radiusM: radiusForG(280, 2.6) }, kph: 280 },
];

/**
 * Peak-to-peak wander, metres, that counts as holding a line.
 *
 * A car is 2.0m wide and the drawn racing-line ribbon is 1.4m. A driver who is
 * ON the line and staying there does not move the width of the car underneath
 * himself. This is deliberately generous — it allows the car to occupy a full
 * car's width of road while nominally holding one line.
 */
const SWING_BAR_M = 2.0;
/**
 * Cross-track error past which the run is a departure rather than a wander.
 *
 * Wide, on purpose. The interesting quantity is the SETTLED wander, and a tight
 * band would end the run during the acquisition transient and report nothing.
 */
const DEPART_BAR_M = 20;
/**
 * Seconds of settling before anything is measured.
 *
 * Ten, because the acquisition transient is real but is not what the complaint
 * is about: dropped onto a 2g corner with the wheel straight, the keyboard arm
 * runs 17.7m wide before it has the lock wound on and the wheel arm runs 3.7m.
 * Both recover. Measuring from t=0 would let that one transient dominate every
 * number in the table.
 */
const SETTLE_S = 10;

const departed: string[] = [];
const growing: string[] = [];
const tooWide: string[] = [];
for (const c of LANE_CASES) {
  const common = {
    lane: c.lane, speedKph: c.kph, durationS: 26, framePeriodMs: 1000 / 60,
    startOffsetM: c.label === 'straight' ? 2 : 0,
    captureS: SETTLE_S, departM: DEPART_BAR_M,
  };
  const kb = driveLane({ ...common });
  const wheel = driveLane({ ...common, keyboard: false });
  const ratio = wheel.swingM > 1e-3 ? kb.swingM / wheel.swingM : Infinity;
  if (kb.departed) departed.push(`${c.label} at ${c.kph} km/h`);
  if (kb.growth > 1.5) growing.push(`${c.label} at ${c.kph} km/h (x${kb.growth.toFixed(2)})`);
  if (!kb.departed && kb.swingM > SWING_BAR_M) {
    tooWide.push(`${c.label} at ${c.kph} km/h: ${kb.swingM.toFixed(2)}m (wheel ${wheel.swingM.toFixed(2)}m)`);
  }
  console.log(
    '   ' + c.label.padEnd(14) + String(c.kph).padStart(4) +
    F(kb.swingM, 11, 2) + F(kb.rmsErrM, 9, 2) + F(wheel.swingM, 14, 2) +
    (Number.isFinite(ratio) ? F(ratio, 8, 1) : '      --') +
    '   ' + (kb.departed ? `LEFT THE LANE (>${DEPART_BAR_M}m)`
      : wheel.departed ? 'wheel arm also left' : 'held'),
  );
}
console.log('');
ok(departed.length === 0, 'a keyboard driver never leaves the road entirely',
  departed.length === 0
    ? `all six cases stayed inside ${DEPART_BAR_M}m`
    : `left: ${departed.join(', ')}`);
ok(tooWide.length === 0,
  `settled wander stays inside a car's width (${SWING_BAR_M.toFixed(1)}m peak-to-peak)`,
  tooWide.length === 0 ? 'every case held a line' : tooWide.join('; '));
ok(growing.length === 0, 'the wander does not grow across the run',
  growing.length === 0 ? 'last third no worse than the middle third anywhere'
    : `growing: ${growing.join(', ')}`);

// ===========================================================================

console.log('');
console.log('='.repeat(78));
console.log(`  ${checks - failures} ok, ${failures} failed`);
console.log('='.repeat(78));
console.log('');
if (failures > 0) process.exitCode = 1;
