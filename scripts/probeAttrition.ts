/**
 * Does the field survive the race?
 *
 * Why this exists
 * ---------------
 * Nothing in the existing harnesses asks the simplest question a spectator asks:
 * how many cars were still running at the end. `validate:race` counts finishers
 * but only fails on lap times and merit correlation, so a five-lap race that
 * ended with one car of twenty passed everything except the pace check.
 *
 * It found this: on the build of 2026-07-30, a five-lap race at Silverstone
 * retired seventeen cars of twenty, and thirty laps of Silverstone finished with
 * a single classified runner. Fifteen of the nineteen retirements happened
 * before the end of lap one. Spreading the field around the lap instead of
 * starting it on the grid changed almost nothing — fourteen of twenty still went
 * out — so it is not a first-corner pile-up. The cars simply cannot get round.
 *
 * Every retirement is logged with WHERE it happened, because the signature is
 * the diagnosis: at Spa, seven cars retired between t=35.2s and t=38.4s, all
 * within thirty metres of s=1100, all at a lateral offset of about -18.5m on a
 * road whose half-width is 7.0m. That is not twenty independent accidents. It is
 * one corner the AI cannot take, driven into by everyone in turn.
 *
 * The second section measures the load case that a trace of one of those
 * accidents points at, and which `probe:handling` — a steady-state skidpad test
 * — cannot see: the car with the brakes still on at turn-in. It is reported
 * rather than asserted. What a tyre model ought to do under combined load is a
 * judgement, and this harness has no business making it; how many cars are left
 * at the end of the race is not a judgement, so that is the only thing here that
 * fails the build.
 *
 * Run: npm run probe:attrition
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { VehiclePhysics, type VehicleControls } from '../src/physics/VehiclePhysics';
import { applySetup, baselineSetupFor, specForTeam } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';

const CIRCUIT_IDS = ['bahrain', 'silverstone', 'spa', 'monza', 'monaco'];
const LAPS = 5;

interface Retirement { code: string; t: number; s: number; lap: number; why: string; offRoadM: number; }

function race(id: string, standingStart: boolean) {
  const def = getCircuit(id);
  const engine = new RaceEngine(def, {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: LAPS,
    playerIndex: -1, standingStart, seed: 4,
  } as SessionConfig);

  const seen = new Set<number>();
  const outs: Retirement[] = [];
  let steps = 0;
  const MAX = Math.round((LAPS * def.referencePoleTimeS * 5 + 900) / PHYSICS_DT);
  while (!engine.over && steps < MAX) {
    engine.step(); steps++;
    for (const c of engine.cars) {
      if (!c.retired || seen.has(c.index)) continue;
      seen.add(c.index);
      outs.push({
        code: c.driver.code, t: engine.time, s: c.s, lap: c.lap, why: c.retirementReason,
        offRoadM: Math.abs(c.lateral) - engine.track.halfWidthAt(c.s),
      });
    }
  }
  const running = engine.cars.length - outs.length;
  return { engine, outs, running, def };
}

const failures: string[] = [];

console.log('\nHOW MANY CARS ARE STILL RUNNING AFTER ' + LAPS + ' LAPS?');
console.log('  Twenty AI cars, no player. Real Formula 1 loses two or three over a full');
console.log('  Grand Prix, so over five laps almost nobody should be out.\n');
console.log('  CIRCUIT       START      RUNNING   RETIRED   OUT ON LAP 1   MAIN CAUSE');
console.log('  ---------------------------------------------------------------------------');

let worstRunning = 20;
let worstCircuit = '';
for (const id of CIRCUIT_IDS) {
  for (const standing of [true, false]) {
    const { outs, running } = race(id, standing);
    const lap1 = outs.filter((o) => o.lap <= 1).length;
    const causes = new Map<string, number>();
    for (const o of outs) causes.set(o.why, (causes.get(o.why) ?? 0) + 1);
    const main = [...causes].sort((a, b) => b[1] - a[1])[0];
    console.log(
      `  ${id.padEnd(12)}  ${(standing ? 'grid' : 'spread').padEnd(9)}  ` +
      `${String(running).padStart(5)}/20   ${String(outs.length).padStart(7)}   ` +
      `${String(lap1).padStart(12)}   ${main ? `${main[0]} x${main[1]}` : '—'}`,
    );
    if (running < worstRunning) { worstRunning = running; worstCircuit = `${id} (${standing ? 'grid' : 'spread'} start)`; }
  }
}

// The signature: are the retirements independent, or is one corner eating the field?
console.log('\nWHERE THE CARS GO OUT (Spa, grid start)');
{
  const { outs, def } = race('spa', true);
  for (const o of outs.slice(0, 10)) {
    console.log(`  t=${o.t.toFixed(1).padStart(6)}s  ${o.code}  lap ${o.lap}  s=${o.s.toFixed(0).padStart(5)}m  ` +
      `${o.offRoadM > 0 ? o.offRoadM.toFixed(1) + 'm off the road' : 'on the road'}   "${o.why}"`);
  }
  // Cluster: how many went out within 100m of the most popular spot?
  let best = 0;
  let bestS = 0;
  for (const a of outs) {
    const n = outs.filter((b) => Math.abs(b.s - a.s) < 100).length;
    if (n > best) { best = n; bestS = a.s; }
  }
  console.log(`  ${best} of ${outs.length} retirements happened within 100m of s=${bestS.toFixed(0)} ` +
    `(${def.name} lap is ${def.lengthM}m)`);
  if (best >= 4) {
    console.log('  -> one corner is taking out the field, not twenty separate accidents');
  }
}

// ---------------------------------------------------------------------------
// Why: the load case probe:handling does not cover.
// ---------------------------------------------------------------------------
console.log('\nTHE CAR WITH THE BRAKES STILL ON AT TURN-IN  (reported, not asserted)');
console.log('  probe:handling measures a fixed steering angle at a fixed speed with no');
console.log('  longitudinal force, and reports this car as front-limited and stable. No');
console.log('  corner is ever entered in that state. Same speed, same lock, brakes on —');
console.log('  note that both axles saturate together, so this is not a front/rear balance');
console.log('  problem: it is how much sideslip the car develops once the brakes are in.\n');
{
  const env = { trackTempC: 30, airTempC: 28, wetness: 0, airDensityRatio: 1, abrasion: 1 };
  const team = {
    powerMult: 1, downforceMult: 1, dragMult: 1, mechanicalGripMult: 1,
    tireWearMult: 1, failureRate: 0, pitCrewTimeS: 2.4, ersMult: 1,
  };
  const entry = (speed: number, steer: number, brake: number) => {
    const car = new VehiclePhysics(
      applySetup(specForTeam(team), baselineSetupFor(0.5, 100)), 'medium');
    car.fuelL = 100;
    car.placeAt(0, 0, 0, speed / 3.6);
    const c: VehicleControls = {
      throttle: 0, brake, steer, drsRequested: false,
      ersMode: 'balanced', gearRequest: 0, pitLimiter: false, reverse: false,
    };
    let peakRear = 0;
    let peakFront = 0;
    for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
      car.step(PHYSICS_DT, c, env);
      if (i < 12) continue;
      if (car.rearSlipSpeed > peakRear) peakRear = car.rearSlipSpeed;
      if (car.frontSlipSpeed > peakFront) peakFront = car.frontSlipSpeed;
    }
    const sideslip = Math.abs(Math.atan2(car.localVelX, Math.abs(car.localVelY) + 0.001) * 180 / Math.PI);
    return { peakRear, peakFront, sideslip };
  };

  console.log('  SPEED  LOCK     COASTING rear/front      BRAKING 0.3 rear/front    SIDESLIP');
  console.log('  -------------------------------------------------------------------------');
  let ratioSum = 0, n = 0;
  for (const speed of [120, 150, 200]) {
    for (const steer of [0.25, 0.4]) {
      const off = entry(speed, steer, 0);
      const on = entry(speed, steer, 0.3);
      ratioSum += on.peakRear / Math.max(off.peakRear, 0.01); n++;
      console.log(
        `  ${String(speed).padStart(5)}  ${steer.toFixed(2)}     ` +
        `${off.peakRear.toFixed(1).padStart(5)} / ${off.peakFront.toFixed(1).padEnd(12)}` +
        `${on.peakRear.toFixed(1).padStart(5)} / ${on.peakFront.toFixed(1).padEnd(14)}` +
        `${on.sideslip.toFixed(0).padStart(4)}deg`,
      );
    }
  }
  console.log(`\n  braking multiplies peak rear slip by ${(ratioSum / n).toFixed(2)}x at the same speed and lock`);
}

// ---------------------------------------------------------------------------
// Verdict. Only the race-level number is asserted: it is the one that needs no
// judgement about what a tyre model ought to do, and it is what a player sees.
// ---------------------------------------------------------------------------
console.log('\nVERDICT');
console.log(`  fewest cars still running after ${LAPS} laps: ${worstRunning}/20 at ${worstCircuit}`);
if (worstRunning < 14) {
  failures.push(
    `only ${worstRunning} of 20 cars survived ${LAPS} laps at ${worstCircuit} — ` +
    'a Grand Prix distance would finish with nobody',
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('The field survives the race.');
