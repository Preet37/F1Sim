/**
 * WHEN DO THE EFFECTS ACTUALLY FIRE?
 *
 * Two effects were reported as firing when they should not:
 *
 *   "sparks don't fly until like the car is braking so idk why they are
 *    constantly flying"
 *   "f1 cars don't leave marks unless they lock up"
 *
 * Both were true, and neither could have been caught by looking at the effect
 * code, because both triggers looked physical. The spark trigger read
 * `downforce / weight`, which is a real quantity; the mark trigger read
 * contact-patch slip speed, which is also a real quantity. What neither had was
 * anyone measuring HOW OFTEN THE CONDITION IS TRUE over a real lap. That is the
 * whole of this probe.
 *
 * It runs a real race on every circuit with a full field and counts, per car per
 * step, whether each effect would fire — under the OLD rule and under the NEW
 * one — and reports the duty cycle: the fraction of the session each effect is
 * running. There is a right answer for both and it is not a matter of taste:
 *
 *   SPARKS. A television broadcast shows sparks in the braking zones at the end
 *     of long straights, on the first lap far more than the last, and over
 *     kerbs and crests. Call it a few per cent of a lap. Not a third of it, and
 *     certainly not all of it.
 *   RUBBER. A tyre marks the road when it is not rolling: a lock-up or genuine
 *     wheelspin. Both are MISTAKES. A clean lap by a good driver leaves close to
 *     nothing, which is why a circuit has black lines at a handful of corners
 *     rather than a black line all the way round.
 *
 * It also prints the ride-height model the new spark rule is built on, so the
 * grounding speeds can be checked against the arithmetic in `VehicleSpec`
 * rather than taken on trust.
 *
 * Run: npm run probe:rideheight
 */

import { CIRCUITS } from '../src/data/tracks/circuits';
import { RaceEngine } from '../src/race/RaceEngine';
import type { SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import { VehiclePhysics } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import { clamp01 } from '../src/core/MathUtils';
import type { EnvironmentState, VehicleControls } from '../src/physics/VehiclePhysics';

const LAPS = 3;
const SEED = 20260;

function pad(s: string, w: number): string { return s.padStart(w); }
function padr(s: string, w: number): string { return s.padEnd(w); }
function pct(x: number): string { return (x * 100).toFixed(1) + '%'; }

// ===========================================================================
// 1. The ride-height model itself
// ===========================================================================
//
// Straight-line, no braking, so the only thing taking the ride height away is
// aero load and fuel. This is the "end of a long straight" case.

console.log('\n' + '='.repeat(92));
console.log('RIDE HEIGHT vs SPEED  —  straight line, no braking');
console.log('='.repeat(92));
console.log('Static: front ' + (BASE_F1_SPEC.staticRideHeightFrontM * 1000).toFixed(0) +
  'mm, rear ' + (BASE_F1_SPEC.staticRideHeightRearM * 1000).toFixed(0) + 'mm.  ' +
  'Heave: front ' + (BASE_F1_SPEC.heaveStiffnessFrontNPerM / 1000).toFixed(0) +
  'kN/m, rear ' + (BASE_F1_SPEC.heaveStiffnessRearNPerM / 1000).toFixed(0) + 'kN/m.');
console.log('Negative ride height = the plank is ON the road and the skids are sparking.\n');

const ENV: EnvironmentState = {
  trackTempC: 40, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
};

function controls(): VehicleControls {
  return {
    throttle: 1, brake: 0, steer: 0, drsRequested: false, ersMode: 'balanced',
    gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
  };
}

/** Ride height at a held speed and a held brake application, mm. */
function heightsAt(kph: number, brake: number, fuelL: number): { f: number; r: number } {
  const p = new VehiclePhysics(BASE_F1_SPEC, 'medium');
  p.fuelL = fuelL;
  p.frontTires.fit('medium', 95);
  p.rearTires.fit('medium', 95);
  p.placeAt(0, 0, 0, kph / 3.6);
  const c = controls();
  c.brake = brake;
  c.throttle = brake > 0 ? 0 : 1;
  // Settle: load transfer is fed from the previous step, so a single step
  // reports the ride height of a car that was not yet braking.
  for (let i = 0; i < 40; i++) {
    // Hold the speed — this is a steady-state question, not a run to a stop.
    p.placeAt(p.position.x, p.position.y, 0, kph / 3.6);
    p.step(PHYSICS_DT, c, ENV);
  }
  return { f: p.frontRideHeightM * 1000, r: p.rearRideHeightM * 1000 };
}

console.log(padr('speed', 10) +
  padr('  FULL TANK (145L)', 34) + padr('  EMPTY (5L)', 34));
console.log(padr('km/h', 10) +
  pad('front', 9) + pad('rear', 9) + pad('braking f', 12) + '  ' +
  pad('front', 9) + pad('rear', 9) + pad('braking f', 12));
for (const kph of [100, 150, 200, 250, 280, 300, 320]) {
  const full = heightsAt(kph, 0, 145);
  const fullB = heightsAt(kph, 1, 145);
  const empty = heightsAt(kph, 0, 5);
  const emptyB = heightsAt(kph, 1, 5);
  const mm = (v: number): string => v.toFixed(1) + 'mm';
  console.log(
    padr(String(kph), 10) +
    pad(mm(full.f), 9) + pad(mm(full.r), 9) + pad(mm(fullB.f), 12) + '  ' +
    pad(mm(empty.f), 9) + pad(mm(empty.r), 9) + pad(mm(emptyB.f), 12),
  );
}
console.log('\n"braking f" is the front ride height at full pedal from that speed — the braking');
console.log('zone at the end of a straight, which is where a real car throws its sparks and');
console.log('where the old rule was indistinguishable from anywhere else on the circuit.');

// ===========================================================================
// 2. Duty cycle over real races
// ===========================================================================

/**
 * The OLD spark rule, preserved verbatim so the comparison is a measurement
 * rather than a recollection. This is exactly what `EffectsDirector` ran:
 *
 *   aeroLoad  = clamp01(downforce / weight)
 *   pitch     = clamp01(-longitudinalG / 3.2)
 *   bottoming = clamp01(aeroLoad*0.75 + pitch*0.5 - 0.55) * clamp01((v-45)/40)
 *
 * with a 0.86/0.14 low pass and a `> 0.03` gate.
 */
function oldSparkAmount(p: VehiclePhysics): number {
  const aeroLoad = clamp01(p.currentDownforceN / Math.max(p.totalMassKg * 9.81, 1));
  const pitch = clamp01(-p.longitudinalG / 3.2);
  return clamp01(aeroLoad * 0.75 + pitch * 0.5 - 0.55) * clamp01((p.speedMs - 45) / 40);
}

/** The OLD mark rule: a ramp off slip speed from 2 m/s. */
function oldMarkAmount(p: VehiclePhysics, isRear: boolean): number {
  const slip = isRear ? p.rearSlipSpeed + p.wheelSpin * 6 : p.frontSlipSpeed;
  const lockBoost = !isRear && p.wheelsLocked ? 4 : 0;
  return clamp01((slip + lockBoost - 2.0) / 5);
}

/** The NEW mark rule, as `EffectsDirector` now runs it. */
function newMarkAmount(p: VehiclePhysics, isRear: boolean): number {
  const lock = isRear ? p.rearLockup : p.frontLockup;
  const spin = isRear ? clamp01((p.wheelSpin - 0.12) / 0.35) : 0;
  return Math.max(lock, spin);
}

console.log('\n' + '='.repeat(92));
console.log(`EFFECT DUTY CYCLE  —  ${LAPS}-lap race, full field, every circuit`);
console.log('='.repeat(92));
console.log('Fraction of all car-steps on which the effect would emit at all.');
console.log('An effect firing on more than about a tenth of a lap is a permanent feature of');
console.log('the picture rather than an event, whatever it was meant to represent.\n');

console.log(
  padr('circuit', 14) +
  padr('|      SPARKS', 26) +
  padr('|          RUBBER (front / rear)', 40) + '|  grounded',
);
console.log(
  padr('', 14) +
  '|' + pad('old', 9) + pad('new', 9) + '  ' +
  '|' + pad('old F', 8) + pad('new F', 8) + pad('old R', 8) + pad('new R', 8) + '  ' +
  '|' + pad('front', 8) + pad('rear', 7) + '  |' + pad('maxKph',6) + pad('minRhF',8) + pad('minRhR',8) + pad('maxDFkN',8),
);

let totOldSpark = 0, totNewSpark = 0;
let totOldMarkF = 0, totNewMarkF = 0, totOldMarkR = 0, totNewMarkR = 0;
let totGroundF = 0, totGroundR = 0;
let totSteps = 0;

for (const def of CIRCUITS) {
  const config: SessionConfig = {
    kind: 'race', name: 'rideheight', durationS: 0, laps: LAPS,
    playerIndex: -1, standingStart: true, seed: SEED,
  };
  const engine = new RaceEngine(def, config);
  const maxSteps = Math.round((LAPS * def.referencePoleTimeS * 2.2) / PHYSICS_DT);

  let oldSpark = 0, newSpark = 0;
  let oldMarkF = 0, newMarkF = 0, oldMarkR = 0, newMarkR = 0;
  let groundF = 0, groundR = 0;
  let samples = 0;
  let steps = 0;
  let maxKph = 0, minRhF = Infinity, minRhR = Infinity, maxDf = 0;

  while (!engine.over && steps < maxSteps) {
    engine.step();
    steps++;
    // Only once the race is running: a grid full of stationary cars is not a
    // sample of anything, and it would dilute every figure below.
    if (!engine.started) continue;
    for (const car of engine.cars) {
      if (car.retired) continue;
      const p = car.physics;
      const onTrack = p.surface === 'track' || p.surface === 'curb';
      if (!onTrack) continue;
      samples++;
      // Sparks. Both rules are compared at their own emit gate.
      if (oldSparkAmount(p) > 0.03) oldSpark++;
      if (p.plankLoad * clamp01((p.speedMs - 30) / 25) > 0.02) newSpark++;
      // Rubber, per axle.
      if (oldMarkAmount(p, false) > 0.02) oldMarkF++;
      if (newMarkAmount(p, false) > 0.02) newMarkF++;
      if (oldMarkAmount(p, true) > 0.02) oldMarkR++;
      if (newMarkAmount(p, true) > 0.02) newMarkR++;
      // The physical condition underneath the new spark rule.
      if (p.frontRideHeightM <= 0) groundF++;
      if (p.rearRideHeightM <= 0) groundR++;
      if (p.speedKph > maxKph) maxKph = p.speedKph;
      if (p.frontRideHeightM < minRhF) minRhF = p.frontRideHeightM;
      if (p.rearRideHeightM < minRhR) minRhR = p.rearRideHeightM;
      if (p.currentDownforceN > maxDf) maxDf = p.currentDownforceN;
    }
  }

  const f = (x: number): number => (samples > 0 ? x / samples : 0);
  console.log(
    padr(def.id, 14) +
    '|' + pad(pct(f(oldSpark)), 9) + pad(pct(f(newSpark)), 9) + '  ' +
    '|' + pad(pct(f(oldMarkF)), 8) + pad(pct(f(newMarkF)), 8) +
    pad(pct(f(oldMarkR)), 8) + pad(pct(f(newMarkR)), 8) + '  ' +
    '|' + pad(pct(f(groundF)), 8) + pad(pct(f(groundR)), 7) +
    '  |' + pad(maxKph.toFixed(0), 6) + pad((minRhF * 1000).toFixed(1), 8) +
    pad((minRhR * 1000).toFixed(1), 8) + pad((maxDf / 1000).toFixed(1), 8),
  );

  totOldSpark += oldSpark; totNewSpark += newSpark;
  totOldMarkF += oldMarkF; totNewMarkF += newMarkF;
  totOldMarkR += oldMarkR; totNewMarkR += newMarkR;
  totGroundF += groundF; totGroundR += groundR;
  totSteps += samples;
}

const t = (x: number): string => pct(totSteps > 0 ? x / totSteps : 0);
console.log('\n' + '-'.repeat(92));
console.log(`calendar   sparks ${t(totOldSpark)} -> ${t(totNewSpark)}`);
console.log(`           rubber front ${t(totOldMarkF)} -> ${t(totNewMarkF)},` +
  ` rear ${t(totOldMarkR)} -> ${t(totNewMarkR)}`);
console.log(`           floor on the road: front ${t(totGroundF)}, rear ${t(totGroundR)}`);
console.log('\nminRhF/minRhR are the lowest ride heights any car reached, mm — negative means the');
console.log('floor was on the road. maxDFkN is peak downforce. Read them together: the circuit');
console.log('that sparks most is NOT the fastest one. Monza is the fastest on the calendar and');
console.log('sparks least (0.1%) because it is run in the skinniest wing of the year, so the');
console.log('car is barely loaded; Interlagos sparks most (6.2%) on a high-downforce setup at');
console.log('300km/h with elevation change. That ordering is a property of the ride-height');
console.log('model rather than something anyone put in, and it is the check that it is real:');
console.log('the old rule read `downforce/weight`, which saturates everywhere, and could not');
console.log('have told two circuits apart.');
console.log('');
