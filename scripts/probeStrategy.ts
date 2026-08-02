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
  applyPlanToCar, pitLossS, planFor, plannedStrategy, startingCompound, stintLife,
  strategyOptions, strategySummary,
} from '../src/race/Strategy';
import { plannedStopCue } from '../src/ui/Hud';
import { getCompound } from '../src/data/tires';

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
//
// The stop is asserted over the FIELD, not over this one car, and that is a
// stronger test rather than a softer one. A single named car can be taken out
// by somebody else's accident on lap 4 — which is exactly what happened when
// the automatic kerb radius moved from 400m to 250m: the cars behave
// differently, different cars crash, and car 3 at seed 7 became one of them.
// The old assertion read that as "the strategy system is broken", which it was
// not: twelve of the thirteen cars still running had made their stops.
//
// So the narrative half — a chosen plan reaches the car and the driver is told
// about it — stays pinned to one car, because that is a story about one car.
// The behavioural half asks the question that actually matters: of every car
// that got far enough to be due a stop and was still running to make it, how
// many did? A retirement is excluded from the denominator and reported, so a
// race that wipes out the field cannot quietly pass by having nobody left to
// fail.
// "Did it stop at all" is NOT the question, and asking it is how this test
// fooled me. With the planned-stop branch of `shouldPit` deliberately disabled,
// twelve of fourteen cars still pitted — for worn tyres and for the mandatory
// second compound, both of which force a stop eventually no matter what the
// strategist wanted. A test that a broken feature passes is worse than no test.
//
// What distinguishes a plan being followed from a car merely running out of
// tyre is WHEN the stop happens. So record the lap each car first pits on and
// compare it against the lap its own plan named.
// A car is judged on its plan only when it was FREE TO FOLLOW IT.
//
// The engine keeps four paths that override the strategist and must: a genuinely
// dead tyre, a wet-weather crossover, a compound the rule requires, and a
// penalty that has to be served. A driver switching to wets in the rain has not
// disobeyed their plan, they have done the only sensible thing with it, and a
// measurement that scores them as disobedient cannot tell the difference between
// a strategist being ignored and a strategist being overruled by the weather.
//
// So the override is recorded AT THE MOMENT THE CALL IS MADE — not at the stop,
// which is several corners later and by then the rain may have stopped — and the
// two populations are reported separately. Both numbers are printed on every run
// so neither can hide behind the other.
const plannedLap = engine.cars.map((c) => c.targetPitLap);
const firstStopLap = engine.cars.map(() => -1);
const overruled = engine.cars.map(() => false);
const seenCall = engine.cars.map(() => false);
const totalRaceLaps = config.laps;

function emergencyInForce(c: (typeof engine.cars)[number]): string | null {
  if (c.pendingServePenalty() !== null) return 'penalty';
  const onSlicks = !getCompound(c.compound).isWetWeather;
  if (engine.weather.wetness > 0.4 && onSlicks) return 'rain';
  if (engine.weather.wetness < 0.12 && !onSlicks && c.physics.rearTires.lapsOnSet > 2) return 'drying';
  if (c.physics.rearTires.wear < 0.24) return 'tyres gone';
  if (!engine.weather.hasRained && totalRaceLaps - c.lap <= 4) {
    const dryUsed = new Set(c.usedCompounds.filter((x) => !getCompound(x).isWetWeather));
    if (dryUsed.size < 2) return 'second compound';
  }
  return null;
}

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
  for (let c = 0; c < engine.cars.length; c++) {
    const entry = engine.cars[c];
    if (!seenCall[c] && !entry.isPlayer && entry.perception.pitThisLap) {
      seenCall[c] = true;
      overruled[c] = emergencyInForce(entry) !== null;
    }
    if (firstStopLap[c] < 0 && entry.pitStops >= 1) firstStopLap[c] = entry.lap;
  }
  if (car.pitStops > stops) stops = car.pitStops;
}

// A retirement is excluded from the denominator and reported, so a race that
// wipes out the field cannot quietly pass by having nobody left to fail.
// Drift is signed and cars that stopped EARLY are the point, so the filter must
// not require a car to have reached its planned lap — that is exactly the
// population that exposes the defect, and excluding it left two cars in the
// sample and a meaningless median.
const running = engine.cars.filter((c) => !c.retired);
const stopped = running.filter((c) => c.pitStops >= 1).length;
const judged = running.filter((c) => plannedLap[c.index] > 0 && firstStopLap[c.index] >= 0);
const drift = judged.map((c) => firstStopLap[c.index] - plannedLap[c.index]);
drift.sort((a, b) => a - b);
const medianDrift = drift.length ? drift[drift.length >> 1] : NaN;
const onPlan = drift.filter((d) => Math.abs(d) <= 1).length;

const free = judged.filter((c) => !overruled[c.index]);
const freeDrift = free.map((c) => firstStopLap[c.index] - plannedLap[c.index]);
freeDrift.sort((a, b) => a - b);
const freeMedian = freeDrift.length ? freeDrift[freeDrift.length >> 1] : NaN;
const freeWorst = freeDrift.reduce((a, b) => (Math.abs(a) >= Math.abs(b) ? a : b), 0);

console.log(`plan ${option.id}: ${strategySummary(option)}`);
console.log(`target stop lap ${target}, cue seen: ${sawCue ? cueText : 'never'}, ` +
  `car ${car.driver.code} ${car.retired ? 'retired: ' + car.retirementReason : 'stops ' + stops}`);
console.log(`field: ${running.length} running, ${stopped} pitted, ${judged.length} judged; ` +
  `first stop vs planned lap: median ${medianDrift >= 0 ? '+' : ''}${medianDrift} laps, ` +
  `${onPlan} of ${judged.length} within one lap`);
console.log(`  of those, ${free.length} were free to follow the plan ` +
  `(${judged.length - free.length} overruled by rain, a dead tyre, the compound rule or a penalty): ` +
  `median ${freeMedian >= 0 ? '+' : ''}${freeMedian}, worst ${freeWorst >= 0 ? '+' : ''}${freeWorst}`);

check(sawCue, 'the driver was never told about the stop the plan asks for');
check(cueText.includes(String(target)) || cueText.includes('THIS LAP'),
  `the cue "${cueText}" does not name the planned lap ${target}`);
check(stopped >= Math.ceil(running.length * 0.75),
  `only ${stopped} of ${running.length} running cars pitted at all`);

// The AI follows its plan, and the assertion now says so.
//
// It used to be a floor of ten laps with a KNOWN DEFECT note attached, because
// the field's first stops landed a median of six laps early against plans naming
// laps 16-22 and asserting the truth would have failed. That is fixed. What was
// throwing the plan away turned out to be neither of the two things the note
// blamed: on measurement the tyres were reading 0.96 of full life and the
// mandatory-compound rule does not bite until four laps from the flag. It was
// the CHEAP STOP under a neutralisation — a safety car on lap nine, a test that
// asked only for six laps on the set, and sixteen of twenty cars diving in on
// tyres that were barely scrubbed. See `RaceEngine.shouldPit`.
//
// Two bounds now, because there are two questions.
//
// The tight one is on the cars that were FREE to follow the plan, and it is the
// bound the note said should eventually be asserted: within a lap. Anything
// looser and the cheap-stop branch could quietly widen again without failing.
//
// The loose one is on the whole field including the overruled, and it stays
// loose on purpose rather than by concession. At this seed it rains at
// Silverstone from about lap fourteen and most of the field crosses over to wets
// — correctly, and against plans naming laps as late as 22. Weather is a real
// input to a real race and the number moves with it: measured over the same race
// at a dry seed the whole-field median is 0, and at a seed that rains on lap
// nine it is -7. A bound on this number is therefore a bound on how much rain a
// seed is allowed to have, which is not a property of the strategist. It is kept
// because a TOTAL breakdown would still blow through it.
check(Number.isFinite(freeMedian) && Math.abs(freeMedian) <= 1,
  `of the cars free to follow their plan, the median first stop lands ${freeMedian} ` +
  'laps from the lap the plan named — the strategist is being ignored');
check(Math.abs(freeWorst) <= 3,
  `a car free to follow its plan pitted ${freeWorst} laps from the lap it named — ` +
  'more than a strategist would ever pull a stop forward for a safety car');
check(free.length >= 5,
  `only ${free.length} cars were free to follow their plan — the sample is too small ` +
  'to say anything, so the overrides are firing on almost everybody');
check(Number.isFinite(medianDrift) && Math.abs(medianDrift) <= 8,
  `the field's first stop lands ${medianDrift} laps from the lap its plan named — ` +
  'the strategy is not reaching the race at all');

// ---------------------------------------------------------------------------
// 4. The starting tyre is asked for ONCE, and the answer is what is on the grid
// ---------------------------------------------------------------------------
//
// "at the start screen I get this which is the tire options? so lets say I
//  choose mediums, then i get a tire strategy? why do I need to do it twice?"
//
// It was asked three times — the briefing chips, the setup sheet, and the first
// stint of a strategy card — and they were not wired together. `applyStrategy`
// wrote the plan's tyre and `applyPlayerSetup` ran afterwards and wrote the
// chips' tyre over it, so a player who picked the soft-start strategy and never
// touched the chips went to the grid on mediums with nothing saying so.
//
// The chips are gone for a race. `plannedStrategy` is the one answer, and this
// asserts that following it to the car really does put that tyre on it — for
// both of the team's cars, on every circuit.

for (const def of CIRCUITS.slice(0, 5)) {
  const laps = def.raceLaps;
  const cfg: SessionConfig = {
    kind: 'race', name: 'grid tyre', durationS: 0, laps,
    playerIndex: 0, standingStart: true, pitLaneStart: false, seed: 909,
  };
  const eng = new RaceEngine(def, cfg);
  const player = eng.cars[0];
  const mates = eng.cars.filter((c) => c.team.id === player.team.id);
  check(mates.length === 2, `${def.id}: the player's team has ${mates.length} cars`);

  // Nothing chosen: the strategist's own call, on both cars, and the tyre on
  // the grid is that plan's first stint.
  for (const entry of mates) {
    const option = plannedStrategy(entry.team, entry.driver, def, laps);
    check(option.label === 'RECOMMENDED',
      `${def.id}/${entry.driver.code}: with no choice made the plan is ${option.label}, not the recommendation`);
    applyPlanToCar(entry, option, 90);
    check(entry.compound === startingCompound(option),
      `${def.id}/${entry.driver.code}: plan starts on ${startingCompound(option)}, car is on ${entry.compound}`);
    check(entry.usedCompounds.length === 1 && entry.usedCompounds[0] === entry.compound,
      `${def.id}/${entry.driver.code}: the tyre log does not match the tyre`);
    check(entry.physics.frontTires.compound.id === entry.compound &&
      entry.physics.rearTires.compound.id === entry.compound,
      `${def.id}/${entry.driver.code}: the compound was recorded but not fitted`);
  }

  // And every option the player can actually pick reaches the grid. This is the
  // assertion the old code would have failed: the aggressive plan starts on the
  // soft, and the briefing chips defaulted to medium.
  for (const option of strategyOptions(player.team, player.driver, def, laps)) {
    const picked = plannedStrategy(player.team, player.driver, def, laps, option.id);
    check(picked.id === option.id,
      `${def.id}: choosing ${option.id} returned ${picked.id}`);
    applyPlanToCar(player, picked, 90);
    check(player.compound === startingCompound(option),
      `${def.id}: chose ${option.id} (starts ${startingCompound(option)}) and went to the grid on ${player.compound}`);
    check(player.plan.length === option.stints.length,
      `${def.id}: chose a ${option.stints.length}-stint plan and the car got ${player.plan.length}`);
    check(player.targetPitLap === option.stints[0].pitOnLap,
      `${def.id}: the car's first stop is lap ${player.targetPitLap}, the plan says ${option.stints[0].pitOnLap}`);
  }
}
console.log('grid tyre: one source, followed to the car on 5 circuits x 3 options x 2 drivers');

// An unknown id — a save from an older build, or a plan that no longer exists
// on this circuit — falls back to the recommendation rather than to nothing.
{
  const def = getCircuit('spa');
  const team = getTeam(DRIVERS[0].teamId);
  const fallback = plannedStrategy(team, DRIVERS[0], def, def.raceLaps, 'no-such-plan');
  check(fallback.label === 'RECOMMENDED',
    `an unknown plan id fell back to ${fallback.label}, not the recommendation`);
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  ' + f);
  if (failures.length > 30) console.log(`  … and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nStrategy OK');
}
