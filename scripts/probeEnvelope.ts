/**
 * Does the car do what everything that predicts its behaviour says it will?
 *
 * There are four places in this project that answer the question "how fast can
 * this car get round that corner" without asking `VehiclePhysics`:
 *
 *   `TrackSpline.solveSpeedProfile`     the reference lap time the whole suite
 *                                       divides by
 *   `TrackSpline.corneringSpeedForCar`  the racing-line overlay's grip limit
 *   `TrackSpline.brakingDecelForCar`    the overlay's braking limit
 *   `AIVehicleController.corneringSpeedLimitMs`  what twenty cars drive to
 *
 * All four are the same closed form — `mu * (m*g + cl*v^2)` against `m*v^2/r` —
 * and all four take `mu` from `VehicleSpec.baseMu`. **`baseMu` is a magic-formula
 * coefficient, not an achievable lateral friction coefficient**, and nothing in
 * this project had ever measured the difference. It cannot be small: grip is
 * sub-linear in load, so an axle pair with load transferred across it delivers
 * less than `mu * N`, and the two ends do not peak at the same slip angle.
 *
 * The consequence, before this probe existed, was three separate defects that
 * looked unrelated:
 *
 *  - The racing-line overlay colours GREEN against `baseMu`, so it promises grip
 *    the car has not got. That is the user's *"if the racing line is green how
 *    did i go off the track?"* and `probe:racingline` section 3 (Monaco 1.042,
 *    Zandvoort 1.032, COTA 1.032).
 *  - `AI_TUNING.commitmentScale` is 0.90 and its comment says the value "is a
 *    property of the controller's tracking accuracy". Part of it is not: it is
 *    silently paying for an over-promising limit function.
 *  - Issue #1's "AI pace is 1.43x reference" is measured against a reference lap
 *    solved for a car with more grip than the simulation produces, so an unknown
 *    part of it was never the AI's to give back.
 *
 * WHAT THIS MEASURES. The real `VehiclePhysics`, stepped at the real
 * `PHYSICS_DT`, with no controller in the way:
 *
 *   LATERAL   the largest steady lateral g the car will hold at a given speed,
 *             swept over steering angle. Steady, not transient: the closed form
 *             it is compared against describes a car balanced in a corner.
 *   BRAKING   the largest deceleration, over both a locked pedal and a pedal
 *             modulated at `brakeLimitFraction`, because there is no ABS and
 *             flooring it is not the car's best.
 *
 * and compares each against what `capabilityOf` — THE SHIPPED FUNCTION, not a
 * copy of it — predicts for the same car at the same speed.
 *
 * It asserts that `ACHIEVABLE_GRIP_FRACTION` still describes the vehicle model.
 * That constant exists so the overlay can stop over-promising; a probe that let
 * it drift would be worse than no constant at all.
 *
 * Node-only and fully deterministic — no browser, no wall-clock deadline — so
 * it reports the same numbers under load (PROJECT.md §8).
 *
 * Run: npm run probe:envelope
 */
import { VehiclePhysics } from '../src/physics/VehiclePhysics';
import {
  specForTeam, applySetup, baselineSetupFor, ACHIEVABLE_GRIP_FRACTION,
} from '../src/physics/VehicleSpec';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { rawCapabilityOf } from '../src/render/RacingLine';
import { PHYSICS_DT } from '../src/core/SimClock';
import { TEAMS } from '../src/data/teams';
import type { CompoundId } from '../src/data/tires';

const G = 9.81;
const SPEEDS = [25, 35, 45, 55, 65];

interface Scenario { name: string; teamId: string; compound: CompoundId; fuelL: number; }
const SCENARIOS: Scenario[] = [
  { name: 'front-runner, medium, 60L', teamId: TEAMS[0].id, compound: 'medium', fuelL: 60 },
  { name: 'backmarker, hard, 100L', teamId: TEAMS[TEAMS.length - 1].id, compound: 'hard', fuelL: 100 },
];

const ENV = {
  trackTempC: 35, airTempC: 25, wetness: 0, surfaceGrip: 1,
  airDensityRatio: 1, abrasion: 1,
};

const ctl = () => ({
  throttle: 0, brake: 0, steer: 0, drsRequested: false,
  ersMode: 'push' as const, gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
});

function makeCar(demand: number, sc: Scenario): VehiclePhysics {
  const team = TEAMS.find((t) => t.id === sc.teamId) ?? TEAMS[0];
  const spec = applySetup(specForTeam(team.performance), baselineSetupFor(demand, sc.fuelL));
  const car = new VehiclePhysics(spec, sc.compound);
  car.fuelL = sc.fuelL;
  return car;
}

/**
 * The largest steady lateral g this car holds at `v0`.
 *
 * Swept rather than bisected: the response is not monotone in steering angle
 * (past the peak the front lets go and the number comes back down), so a
 * bisection would converge on an edge of the plateau rather than on the peak.
 */
function peakLateralG(demand: number, sc: Scenario, v0: number): number {
  let best = 0;
  for (let st = 0.05; st <= 1.0; st += 0.05) {
    const car = makeCar(demand, sc);
    car.placeAt(0, 0, 0, v0);
    const c = ctl();
    c.steer = st;
    let sum = 0;
    let n = 0;
    let ok = true;
    for (let i = 0; i < 120 * 3; i++) {
      // Trim the pedals to hold the entry speed. A corner taken while
      // decelerating is a different measurement from the one the closed form
      // describes, and mixing them is how a grip number becomes untraceable.
      const err = v0 - car.speedMs;
      c.throttle = err > 0 ? Math.min(1, err * 0.5) : 0;
      c.brake = err < -0.5 ? Math.min(0.3, -err * 0.1) : 0;
      car.step(PHYSICS_DT, c, ENV);
      if (Math.abs(car.yawRate) > 2.5 || car.speedMs < v0 * 0.75) { ok = false; break; }
      if (i > 120) {
        sum += Math.abs(car.frontLateralN + car.rearLateralN) / (car.totalMassKg * G);
        n++;
      }
    }
    if (ok && n && sum / n > best) best = sum / n;
  }
  return best;
}

/** The largest deceleration this car produces at each sampled speed. */
function peakBraking(demand: number, sc: Scenario): Map<number, number> {
  const out = new Map<number, number>();
  for (const mode of ['flat', 'modulated'] as const) {
    const car = makeCar(demand, sc);
    car.placeAt(0, 0, 0, 92);
    const c = ctl();
    let prev = car.speedMs;
    for (let i = 0; i < 120 * 40; i++) {
      c.brake = mode === 'flat' ? 1 : Math.min(1, car.brakeLimitFraction);
      car.step(PHYSICS_DT, c, ENV);
      const v = car.speedMs;
      const a = (prev - v) / PHYSICS_DT;
      prev = v;
      for (const sp of SPEEDS) {
        if (Math.abs(v - sp) < 1) {
          const b = out.get(sp) ?? -1e9;
          if (a > b) out.set(sp, a);
        }
      }
      if (v < 8) break;
    }
  }
  return out;
}

let ok = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  if (cond) ok++;
  else failures.push(msg);
}

console.log('');
console.log('PERFORMANCE ENVELOPE — the closed form against the vehicle model');
console.log('  ACHIEVABLE_GRIP_FRACTION = ' + ACHIEVABLE_GRIP_FRACTION.toFixed(3));
console.log('');

const latAll: number[] = [];
const brkAll: number[] = [];

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  for (const sc of SCENARIOS) {
    const car = makeCar(def.downforceDemand, sc);
    // `rawCapabilityOf` is deliberately the UNCORRECTED capability, so that the
    // ratio measured here is the thing the correction is derived from and not a
    // number that moves when the correction does. Everything else in this
    // project that asks what a car can do now goes through `capabilityOf`,
    // including `probe:racingline`, which until this branch carried its own
    // transcribed copy of the rule and could therefore not see a change to it.
    const cap = rawCapabilityOf(car, 103);
    const brk = peakBraking(def.downforceDemand, sc);

    const latRow: string[] = [];
    const brkRow: string[] = [];
    for (const v of SPEEDS) {
      const measuredLat = peakLateralG(def.downforceDemand, sc, v);
      const predictedLat = (cap.mu * (cap.massKg * G + cap.cl * v * v)) / cap.massKg / G;
      const rLat = measuredLat / predictedLat;
      latAll.push(rLat);
      latRow.push(rLat.toFixed(3));

      const measuredBrk = brk.get(v) ?? 0;
      const predictedBrk = track.brakingDecelForCar(v, cap);
      const rBrk = measuredBrk / predictedBrk;
      brkAll.push(rBrk);
      brkRow.push(rBrk.toFixed(3));
    }
    console.log('  ' + def.id.padEnd(12) + sc.name.padEnd(26) +
      'lat ' + latRow.join(' ') + '   brake ' + brkRow.join(' '));
  }
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const meanLat = mean(latAll);
const meanBrk = mean(brkAll);
const worstLat = Math.min(...latAll);
const bestLat = Math.max(...latAll);

console.log('');
console.log('  lateral   mean ' + meanLat.toFixed(4) + '   range ' +
  worstLat.toFixed(3) + '..' + bestLat.toFixed(3) + '   over ' + latAll.length + ' samples');
console.log('  braking   mean ' + meanBrk.toFixed(4) + '   range ' +
  Math.min(...brkAll).toFixed(3) + '..' + Math.max(...brkAll).toFixed(3));
console.log('');

// The assertion. The constant is what the overlay divides by, so it has to keep
// describing the vehicle model — if the tyre model, the load transfer or the
// aero balance moves and this does not, the overlay goes back to over-promising
// silently, which is the exact failure the constant was introduced to end.
check(
  Math.abs(meanLat - ACHIEVABLE_GRIP_FRACTION) < 0.03,
  'ACHIEVABLE_GRIP_FRACTION is ' + ACHIEVABLE_GRIP_FRACTION.toFixed(3) +
  ' but the vehicle model measures ' + meanLat.toFixed(4) +
  ' of the closed form. Do not move the constant without reading why it moved.',
);
// The spread matters as much as the mean: one factor is only defensible while
// the ratio is roughly flat in speed, downforce and tyre. If it stops being
// flat, a single number is the wrong shape and this says so.
check(
  bestLat - worstLat < 0.14,
  'the achievable fraction is not flat: ' + worstLat.toFixed(3) + '..' + bestLat.toFixed(3) +
  '. One constant is the wrong shape for it.',
);
// Braking is corrected by the same mu and is NOT claimed to be exact. This bound
// is deliberately looser and its job is to catch the correction being applied in
// the wrong direction, not to certify the number.
check(
  meanBrk > 0.72 && meanBrk < 1.15,
  'braking against the closed form is ' + meanBrk.toFixed(3) + ', outside 0.72..1.15',
);

console.log('  ' + ok + ' ok / ' + failures.length + ' failed');
for (const f of failures) console.log('  FAIL ' + f);
console.log('');
if (failures.length > 0) process.exitCode = 1;
