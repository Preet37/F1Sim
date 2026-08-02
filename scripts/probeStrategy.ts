/**
 * Does the strategist tell the truth?
 *
 * WHY THIS EXISTS. A race-setup screen that recommends a plan the race then
 * contradicts is worse than no screen at all — it is a confident lie, and the
 * player has no way to check it. So the recommendation and the race are held
 * to one model (`src/race/Strategy.ts`), and this asserts three things about
 * it that a screenshot cannot:
 *
 *   1. Every option is RUNNABLE. Its stops land on laps that exist, in order,
 *      inside the distance, and the stint lengths add up to the race.
 *   2. The RECOMMENDED option is the one the model actually prefers — the
 *      cheapest plan that does not ask a tyre to go past its cliff — on every
 *      circuit and for every driver on the grid, not just the one in the
 *      screenshot.
 *   3. A chosen plan REACHES THE CAR. `strategyOptions` → `planFor` →
 *      `CarEntry.plan` → the engine's own `shouldPit`, and the driver is told
 *      about it by the same `plannedStopCue` the HUD draws.
 *
 * Run: npm run probe:strategy
 */

import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { DRIVERS, getTeam } from '../src/data/teams';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import {
  pitLossS, planFor, startingCompound, stintLife, strategyOptions, strategySummary,
} from '../src/race/Strategy';
import { plannedStopCue } from '../src/ui/Hud';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

// ---------------------------------------------------------------------------
// 1 + 2. Every circuit, every driver
// ---------------------------------------------------------------------------

let optionCount = 0;
let recommendedOneStop = 0;
let recommendedTwoStop = 0;

for (const def of CIRCUITS) {
  const laps = def.raceLaps;
  for (const driver of DRIVERS) {
    const team = getTeam(driver.teamId);
    const life = stintLife(team, driver, def);
    const loss = pitLossS(team, def);

    check(life.medium >= 12 && life.medium <= 46,
      `${def.id}/${driver.code}: medium life ${life.medium.toFixed(1)} is outside the model's clamp`);
    check(life.soft < life.medium && life.medium < life.hard,
      `${def.id}/${driver.code}: compounds are not ordered by life`);
    check(loss > 9 && loss < 15,
      `${def.id}/${driver.code}: a stop costs ${loss.toFixed(1)}s, which is not a pit stop`);

    const options = strategyOptions(team, driver, def, laps);
    check(options.length === 3, `${def.id}/${driver.code}: expected three options`);
    optionCount += options.length;

    for (const o of options) {
      // Runnable: stops in order, inside the distance, on laps that exist.
      let previous = 0;
      for (const stint of o.stints) {
        check(stint.laps >= 1, `${def.id}/${driver.code}/${o.id}: a stint of ${stint.laps} laps`);
        if (stint.pitOnLap > 0) {
          check(stint.pitOnLap > previous,
            `${def.id}/${driver.code}/${o.id}: stop on lap ${stint.pitOnLap} is not after ${previous}`);
          check(stint.pitOnLap < laps,
            `${def.id}/${driver.code}/${o.id}: stop on lap ${stint.pitOnLap} of a ${laps}-lap race`);
          previous = stint.pitOnLap;
        }
      }
      const total = o.stints.reduce((a, b) => a + b.laps, 0);
      check(total === laps,
        `${def.id}/${driver.code}/${o.id}: stints total ${total} laps, race is ${laps}`);

      // Two dry compounds, which the race then requires — see
      // `RaceControlManager.checkMandatoryCompounds`. A plan that cannot be
      // legal is not a plan.
      const dry = new Set(o.stints.map((st) => st.compound));
      check(dry.size >= 2,
        `${def.id}/${driver.code}/${o.id}: uses one compound and would be disqualified`);

      check(Math.abs(o.pitCostS - o.stops * loss) < 1e-6,
        `${def.id}/${driver.code}/${o.id}: pit cost does not equal stops times the pit loss`);
      check(strategySummary(o).includes('stop'),
        `${def.id}/${driver.code}/${o.id}: summary does not state the stop count`);
    }

    // The recommendation is the model's own preference, re-derived here from
    // the published fields rather than from the label.
    const recommended = options.filter((o) => o.label === 'RECOMMENDED');
    check(recommended.length === 1,
      `${def.id}/${driver.code}: ${recommended.length} options are labelled RECOMMENDED`);
    if (recommended.length === 1) {
      const within = options.filter((o) => o.strain <= 1);
      const want = within.length > 0
        ? within.reduce((a, b) => (a.pitCostS <= b.pitCostS ? a : b))
        : options.reduce((a, b) => (a.strain <= b.strain ? a : b));
      check(recommended[0].id === want.id,
        `${def.id}/${driver.code}: recommends ${recommended[0].id}, model prefers ${want.id}`);
      if (recommended[0].stops === 1) recommendedOneStop++; else recommendedTwoStop++;
    }
  }
}
console.log(`${CIRCUITS.length} circuits x ${DRIVERS.length} drivers: ${optionCount} options checked`);
console.log(`recommended: ${recommendedOneStop} one-stop, ${recommendedTwoStop} two-or-more`);
// If every circuit recommends the same thing the model is not reading the
// circuit, which is the failure mode this whole file exists to catch.
check(recommendedOneStop > 0 && recommendedTwoStop > 0,
  'every circuit and driver gets the same recommendation — the model is not reading its inputs');

// ---------------------------------------------------------------------------
// 3. A chosen plan reaches the car, and the driver is told
// ---------------------------------------------------------------------------

const config: SessionConfig = {
  kind: 'race',
  name: 'Grand Prix',
  durationS: 0,
  laps: 30,
  playerIndex: -1,
  standingStart: true,
  pitLaneStart: false,
  seed: 7,
};

const def = getCircuit('silverstone');
const engine = new RaceEngine(def, config);
const car = engine.cars[3];
const option = strategyOptions(car.team, car.driver, def, config.laps)
  .find((o) => o.id === 'two-stop')!;

// Exactly what `Main.applyStrategy` does.
car.plan = planFor(option);
car.targetPitLap = car.plan[0].pitOnLap;
const start = startingCompound(option);
car.compound = start;
car.usedCompounds.length = 0;
car.usedCompounds.push(start);
car.physics.frontTires.fit(start, engine.weather.trackTempC + 40);
car.physics.rearTires.fit(start, engine.weather.trackTempC + 40);

check(car.plan.length === option.stints.length, 'the plan written to the car is a different length');
check(car.compound === option.stints[0].compound, 'the car is not on the compound the plan starts with');

// Drive it, and watch for the cue and for the stop.
let sawCue = false;
let cueText = '';
let stops = 0;
const target = car.targetPitLap;
for (let i = 0; i < Math.round(2400 / PHYSICS_DT) && !engine.over; i++) {
  engine.step();
  if (i % 60 === 0) {
    const cue = plannedStopCue(engine, car);
    if (cue && !sawCue) { sawCue = true; cueText = cue; }
  }
  if (car.pitStops > stops) stops = car.pitStops;
}

console.log(`plan ${option.id}: ${strategySummary(option)}`);
console.log(`target stop lap ${target}, cue seen: ${sawCue ? cueText : 'never'}, stops made: ${stops}`);

check(sawCue, 'the driver was never told about the stop the plan asks for');
check(cueText.includes(String(target)) || cueText.includes('THIS LAP'),
  `the cue "${cueText}" does not name the planned lap ${target}`);
check(stops >= 1, 'the car ran the whole race without making the stop its plan asked for');

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  ' + f);
  if (failures.length > 30) console.log(`  … and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nStrategy OK');
}
