/**
 * Does anybody except the winner take the chequered flag?
 *
 * WHY THIS EXISTS. `RaceEngine.checkSessionEnd` is meant to give backmarkers a
 * window to complete their final lap after the leader finishes:
 *
 *     if (!anyRunning || (raceControl.raceFinished && time > raceFinishedAt + 180)) {
 *       this.finishSession();
 *     }
 *     if (raceControl.raceFinished && raceFinishedAt === 0) {
 *       raceFinishedAt = this.time;          // <- the ONLY write, one line BELOW the read
 *     }
 *
 * `raceFinishedAt` starts at 0 and is written on the line after the guard that
 * reads it, so on the step the leader crosses the line the guard evaluates
 * `time > 0 + 180`. Every race in the game is minutes long, so it is true
 * immediately and `finishSession()` runs on that same step. `finishSession`
 * stamps `finished = true` and `finishTime = this.time` on EVERY car still
 * circulating — so the whole field is classified at the winner's timestamp, on
 * the lap it happened to be on.
 *
 * The player never crosses the line unless they win. Their race is cut off
 * wherever they happen to be, and the result sheet gives them the winner's time.
 *
 * WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: the field being classified at one
 * shared instant instead of as each car finishes. That is measured two ways —
 * the spread of finish times, and how many cars completed the full distance —
 * so a fix that staggers the timestamps without actually letting anybody finish
 * the lap still fails the second check.
 *
 * ===========================================================================
 * §4 — AND NOBODY RACES AFTER IT (issue #44)
 * ===========================================================================
 *
 * The other half of the same question, and it is the half `probe:fieldsize`
 * catches only by its symptom ("NOR completed 8 laps of a 6-lap race"). Sections
 * 1–3 above ask whether a car is allowed to FINISH its race. This one asks
 * whether it is made to STOP.
 *
 * Once the end-of-race signal is given the race is over — "the end-of-race
 * signal will be given at the Line as soon as the leading car has covered the
 * full race distance" (2025 Sporting Regs Art. 57.1 / 2026 Section B Art.
 * B5.14.1) — and every car takes that signal the next time it reaches the Line.
 * What it does afterwards is a slowing-down lap to parc fermé (Art. 43.3 /
 * B4.2.1): not a racing lap, not a timed lap, and not a lap of the race.
 *
 * None of that was modelled. `car.finished` was stamped and then read by nothing
 * in the step loop, so a car that had taken the chequered flag went on being
 * driven flat out, went on counting laps through `onCrossLine`, went on setting
 * lap times, and went on being eligible to retire — for up to the 180 seconds
 * `checkSessionEnd` holds the session open for the backmarkers. Four assertions,
 * because the four consequences are separately wrong and a fix could reach one
 * without reaching the others:
 *
 *   a. NO LAP IS COUNTED after a car takes the flag.
 *   b. NO LAP TIME is set after it, so the race's fastest lap cannot be set
 *      after the race has ended.
 *   c. NOBODY RETIRES after it. A classified finisher cannot become a DNF on
 *      the slowing-down lap — `checkStranded` already said so in a comment and
 *      `checkReliability`, the barrier impact and the damage model did not.
 *   d. EVERY CAR STILL RUNNING TAKES THE FLAG AT THE LINE, rather than being
 *      stamped `finished` in a batch when the 180-second window expires. A
 *      lapped car has not covered the distance and never satisfies
 *      `car.lap > laps`, so before this it could only ever be classified by
 *      that batch.
 *
 * Run: npm run probe:finish
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

const CIRCUITS = ['monza', 'bahrain', 'silverstone'];
const LAPS = 5;

/**
 * The scenarios §4 needs on top of the three §1–3 measures.
 *
 * §1–3 are quoted in PROJECT.md against three circuits at five laps and that
 * configuration is left exactly as it was. §4 needs something those three do not
 * contain: A CAR THAT IS A LAP DOWN. Five laps from a standing start laps
 * nobody, and a car that never satisfies `car.lap > laps` is the only kind that
 * can be batch-stamped by `finishSession` — so on the original three the batch
 * assertion has nothing to fire on.
 *
 * Monaco and Spa over six laps are `probe:fieldsize`'s own reproduction, the one
 * that produces "completed 8 laps of a 6-lap race", and at that distance the
 * field is spread over more than a lap. Twenty cars, the same seed, so the extra
 * cost is two short races.
 */
const LAPPED_SCENARIOS: { cid: string; laps: number }[] = [
  { cid: 'monaco', laps: 6 },
  { cid: 'spa', laps: 6 },
];

const SCENARIOS: { cid: string; laps: number; full: boolean }[] = [
  ...CIRCUITS.map((cid) => ({ cid, laps: LAPS, full: true })),
  ...LAPPED_SCENARIOS.map((s) => ({ ...s, full: false })),
];

/** Totals for the §4 summary, gathered across the circuits. */
let totalLapsAfterFlag = 0;
let totalBestLapAfterFlag = 0;
let totalRetiredAfterFlag = 0;
let totalStampedInBatch = 0;

for (const scenario of SCENARIOS) {
  const cid = scenario.cid;
  const laps = scenario.laps;
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 99,
  };
  const engine = new RaceEngine(getCircuit(cid), config);

  let leaderCrossedAt = -1;
  // The state of each car AT THE MOMENT IT TOOK THE FLAG, sampled on the step
  // `finished` goes true. Everything §4 asserts is a difference between this
  // and the same quantity at the end of the session, which is why it has to be
  // captured live rather than reconstructed afterwards.
  const atFlag = new Map<number, { lap: number; best: number; time: number }>();
  /** Cars that retired on a step AFTER they had already taken the flag. */
  const retiredAfterFlag: string[] = [];

  const maxSteps = Math.round(3000 / PHYSICS_DT);
  let steps = 0;
  while (!engine.over && steps < maxSteps) {
    engine.step();
    steps++;
    if (leaderCrossedAt < 0 && engine.raceControl.raceFinished) leaderCrossedAt = engine.time;
    for (const car of engine.cars) {
      if (car.finished && !atFlag.has(car.index)) {
        atFlag.set(car.index, { lap: car.lap, best: car.bestLapTime, time: engine.time });
      }
      if (car.retired && atFlag.has(car.index) &&
          !retiredAfterFlag.includes(car.driver.code)) {
        retiredAfterFlag.push(car.driver.code);
      }
    }
  }

  check(engine.over, `${cid}: the race never ended in 3000s — this probe measured nothing`);
  if (!engine.over) continue;

  const finishers = engine.cars.filter((c) => c.finished && !c.retired);
  check(finishers.length >= 5,
    `${cid}: only ${finishers.length} classified finishers — too few to measure`);
  if (finishers.length < 5) continue;

  const times = finishers.map((c) => c.finishTime);
  const spread = Math.max(...times) - Math.min(...times);
  // `lap` is the lap the car is ON, so a car that has completed the distance
  // reads laps + 1.
  const wentTheDistance = finishers.filter((c) => c.lap > laps).length;
  const sharingWinnersTime = times.filter((t) => Math.abs(t - times[0]) < 1e-6).length;

  console.log(
    `${(cid + ' ' + laps + 'L').padEnd(14)} ${finishers.length} finishers  ` +
    `finish-time spread ${spread.toFixed(3)}s  ` +
    `completed the full ${laps} laps: ${wentTheDistance}/${finishers.length}  ` +
    `sharing the winner's exact time: ${sharingWinnersTime}/${finishers.length}  ` +
    `(race ended ${(engine.time - leaderCrossedAt).toFixed(2)}s after the leader crossed)`);

  if (scenario.full) {
    // 1. FINISH TIMES ARE NOT ALL THE SAME INSTANT. Cars finish one at a time.
    //    A whole field sharing one timestamp to the microsecond is not a close
    //    finish, it is a single assignment.
    check(sharingWinnersTime <= 2,
      `${cid}: ${sharingWinnersTime} of ${finishers.length} classified finishers carry the winner's ` +
      `EXACT finish time (${times[0].toFixed(3)}s) — the whole field was stamped in one step ` +
      'rather than each car being timed across the line');

    // 2. THE FIELD ACTUALLY COMPLETED THE RACE DISTANCE. The spread above could
    //    be satisfied by cars stopped at different moments; this cannot.
    //
    // NOT ASSERTED ON THE LAPPED SCENARIOS, and the reason is the regulation:
    // a car a lap down takes the chequered flag and is classified on it
    // (Art. 6.5 / B2.5.1 classifies anybody who covered 90% of the winner's
    // distance), so at six laps at Monaco a correct simulation has classified
    // finishers who did not complete the distance BY DESIGN. Asserting this
    // there would be asserting that lapping does not happen.
    check(wentTheDistance >= Math.ceil(finishers.length * 0.7),
      `${cid}: only ${wentTheDistance} of ${finishers.length} classified finishers actually ` +
      `completed ${laps} laps — the rest were classified as finishers mid-lap`);

    // 3. THE RACE DID NOT END ON THE STEP THE LEADER CROSSED. Backmarkers need a
    //    window; a gap of zero means there was none.
    check(engine.time - leaderCrossedAt > 1,
      `${cid}: the session ended ${(engine.time - leaderCrossedAt).toFixed(3)}s after the leader ` +
      'crossed the line — nobody behind was given any time to finish their lap');
  }

  // --- 4. AND NOBODY RACES AFTER IT (issue #44) ---------------------------
  //
  // Everything below is a difference between the state of a car when it took
  // the chequered flag and the state of the same car at the end of the session.
  // A car on a slowing-down lap changes none of them.
  const lapsAfterFlag: string[] = [];
  const bestAfterFlag: string[] = [];
  let stampedInBatch = 0;
  for (const car of engine.cars) {
    const f = atFlag.get(car.index);
    if (!f) continue;
    if (car.lap > f.lap) {
      lapsAfterFlag.push(`${car.driver.code} +${car.lap - f.lap}`);
      totalLapsAfterFlag += car.lap - f.lap;
    }
    // A lap time improved after the flag is a fastest lap of a race that was
    // already over — `RaceEngine.fastestLap` is what a career records.
    if (f.best > 0 ? car.bestLapTime < f.best - 1e-9 : car.bestLapTime > 0) {
      bestAfterFlag.push(car.driver.code);
      totalBestLapAfterFlag++;
    }
    // Stamped by `finishSession` rather than timed across the Line. The last
    // car across is allowed to share the session's end time, because the
    // session ends on the step it finishes.
    if (Math.abs(car.finishTime - engine.time) < 1e-9) stampedInBatch++;
  }
  totalRetiredAfterFlag += retiredAfterFlag.length;
  totalStampedInBatch += Math.max(0, stampedInBatch - 1);

  console.log(
    `${''.padEnd(14)} after the flag: ${lapsAfterFlag.length} cars counted more laps` +
    `, ${bestAfterFlag.length} improved a lap time` +
    `, ${retiredAfterFlag.length} retired` +
    `, ${stampedInBatch} share the session's end time`);

  // a. A lap of the race cannot be completed after the race has ended.
  check(lapsAfterFlag.length === 0,
    `${cid}: ${lapsAfterFlag.length} cars counted further laps AFTER taking the chequered ` +
    `flag (${lapsAfterFlag.join(', ')}) — the slowing-down lap is being scored as a racing lap ` +
    '(Art. 43.3 / B4.2.1)');

  // b. Nor a lap time. The fastest lap of the race is a result.
  check(bestAfterFlag.length === 0,
    `${cid}: ${bestAfterFlag.length} cars improved their best lap AFTER taking the chequered ` +
    `flag (${bestAfterFlag.join(', ')}) — a fastest lap set after the race ended`);

  // c. Nor a retirement. A classified finisher cannot become a DNF.
  check(retiredAfterFlag.length === 0,
    `${cid}: ${retiredAfterFlag.length} cars RETIRED after taking the chequered flag ` +
    `(${retiredAfterFlag.join(', ')}) — a classified finisher was turned into a DNF on the ` +
    'slowing-down lap');

  // d. Everybody still running takes the flag at the Line, one car at a time.
  check(stampedInBatch <= 1,
    `${cid}: ${stampedInBatch} classified finishers carry the session's own end time — they ` +
    'were stamped in a batch by `finishSession` rather than timed across the Line');
}

console.log('');
console.log(`§4 across ${SCENARIOS.length} races: ${totalLapsAfterFlag} laps counted after the ` +
  `flag, ${totalBestLapAfterFlag} lap times improved, ${totalRetiredAfterFlag} retirements, ` +
  `${totalStampedInBatch} batch-stamped finishers`);

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — the field is timed across the line one car at a time.');
}
