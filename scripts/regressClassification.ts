/**
 * Regression: the result column on the classification screen.
 *
 * The bugs this locks down
 * -----------------------
 * 1. Every session type printed the word WINNER for whoever was first. In FP2
 *    and in Q1 there is no winner, and the column is headed "Best" — so the one
 *    car whose lap time the player most wanted was the only one whose lap time
 *    was replaced by a word. Observed at Bahrain: the FP1 classification read
 *    "1 Malik Okonkwo Apex WINNER".
 * 2. A lapped car's race gap was printed as raw seconds. "+92.418" and "+1 lap
 *    and change" are the same number of characters and completely different
 *    facts, and only one of them means the car is out of the race.
 *
 * Run: npm run regress:results
 */

import {
  liveGapCell, resultGapCell,
  type ClassifiedCar, type RunningCar,
} from '../src/race/Classification';

const failures: string[] = [];
function eq(actual: string, expected: string, what: string): void {
  const ok = actual === expected;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}: "${actual}"${ok ? '' : ` (expected "${expected}")`}`);
  if (!ok) failures.push(`${what}: got "${actual}", expected "${expected}"`);
}

const car = (o: Partial<ClassifiedCar>): ClassifiedCar => ({
  position: 5, retired: false, disqualified: false,
  bestLapTime: 0, gapToLeader: 0, lapsDown: 0, ...o,
});

console.log('\nPRACTICE AND QUALIFYING (no winner; the column is the deficit in pace)');
eq(resultGapCell(car({ position: 1, bestLapTime: 89.762 }), false), 'FASTEST',
  'the quickest car is the quickest, not the winner of free practice');
eq(resultGapCell(car({ position: 2, bestLapTime: 90.104, gapToLeader: 0.342 }), false), '+0.342',
  'the second car shows how far off the pace it is');
eq(resultGapCell(car({ position: 18, bestLapTime: 0 }), false), '--.---',
  'a car that set no lap has no gap to show');
eq(resultGapCell(car({ position: 1, bestLapTime: 0 }), false), '—',
  'a session in which nobody set a lap has no fastest car');
// THE BUG. A player set the fastest lap of Q1 at Bahrain — a 1:49.758, purple
// on the tower — and put the car in the barrier at Turn 4. They were shown
// "P20 — DNF". There is no DNF in qualifying: the 2026 regulations define a Lap
// Time Classified Session as one classified "based upon the time taken by a
// driver to complete a single lap" (Section B, Definitions), Art. B2.4.3a
// orders classified drivers by the best time each of them set, and Art. B2.4.3b
// gives the only three routes out of the classification — outside 107% having
// been eliminated in Q1, no time in Q1 at all, and disqualification. An
// accident is none of them, and for the fastest driver in the session it could
// not be: they ARE the 107% reference.
eq(resultGapCell(car({ position: 1, bestLapTime: 109.758, retired: true }), false), 'FASTEST',
  'the fastest lap of Q1 is still the fastest lap of Q1 after the car is in the barrier');
eq(resultGapCell(car({ position: 4, bestLapTime: 110.2, gapToLeader: 0.442, retired: true }), false),
  '+0.442',
  'a car that broke down in practice keeps the lap it set and the gap it shows');
eq(resultGapCell(car({ position: 20, bestLapTime: 0, retired: true }), false), '--.---',
  'a car that crashed before setting a lap has no time — but still no DNF');
eq(resultGapCell(car({ position: 20, bestLapTime: 109.9, disqualified: true, retired: true }), false),
  'DSQ',
  'disqualification IS an outcome of qualifying (Art. B2.4.3b.iii) and still shows');

console.log('\nRACE (the column is the deficit to the flag)');
eq(resultGapCell(car({ position: 1, gapToLeader: 0 }), true), 'WINNER',
  'the race winner is the winner');
eq(resultGapCell(car({ position: 2, gapToLeader: 3.4567 }), true), '+3.457',
  'a car on the lead lap shows a time gap');
eq(resultGapCell(car({ position: 15, gapToLeader: 92.418, lapsDown: 1 }), true), '+1 LAP',
  'a lapped car is reported as lapped, not as a time');
eq(resultGapCell(car({ position: 19, gapToLeader: 240.9, lapsDown: 3 }), true), '+3 LAPS',
  'three laps down reads as three laps');
eq(resultGapCell(car({ position: 20, retired: true }), true), 'DNF',
  'a retirement is a DNF');
eq(resultGapCell(car({ position: 20, disqualified: true, retired: true }), true), 'DSQ',
  'disqualification outranks retirement');

console.log('\nNOTHING PRINTS A NON-NUMBER');
eq(resultGapCell(car({ position: 4, gapToLeader: NaN }), true), '--.---',
  'a gap that never resolved does not print NaN');
eq(resultGapCell(car({ position: 4, gapToLeader: Infinity }), true), '--.---',
  'an infinite gap does not print Infinity');
eq(resultGapCell(car({ position: 4, bestLapTime: 90, gapToLeader: NaN }), false), '--.---',
  'a practice gap that never resolved does not print NaN');
eq(resultGapCell(car({ position: 4, bestLapTime: NaN, gapToLeader: 1 }), false), '--.---',
  'a lap time that never resolved does not print NaN');

// ===========================================================================
// The LIVE tower, which is a different code path and had the same bug
// ===========================================================================
//
// REPORTED: "there is no leader in qualifying... you show the leading time
// scorer and everyone behind them." Correct. The results board had already
// been taught this — that is the WINNER/FASTEST split above — but the in-race
// timing panel carried its own copy of the logic and printed LEADER against
// the quickest car in a qualifying segment, and DNF against a car in the
// barrier. Both are race language, and a Lap Time Classified Session has
// neither in it (Section B Definitions; Art. B2.4.3a-b).

console.log('\nTHE LIVE TOWER IN AN LTCS (a fastest lap, and deficits to it)');
const run = (o: Partial<RunningCar>): RunningCar => ({
  position: 5, retired: false, disqualified: false,
  bestLapTime: 0, interval: 0, gapToLeader: 0, lapsDown: 0, ...o,
});
const quickest = { bestLapTime: 89.762 };

eq(liveGapCell(run({ position: 1, bestLapTime: 89.762 }), null, quickest, false), 'FASTEST',
  'the car at the top of a qualifying segment set the fastest lap; it is not leading anything');
eq(liveGapCell(run({ position: 2, bestLapTime: 90.104 }), run({}), quickest, false), '+0.342',
  'everyone else is shown their deficit to it');
// NO TIME, in the reference board's own words — `reference/target/69.png` is
// eleven rows of it. This used to be an em dash, which is the typography of an
// empty cell rather than a statement about a car (#76).
eq(liveGapCell(run({ position: 12, bestLapTime: 0 }), run({}), quickest, false), 'NO TIME',
  'a car that has not set a lap yet says so');
eq(liveGapCell(run({ position: 1, bestLapTime: 0 }), null, { bestLapTime: 0 }, false), 'NO TIME',
  'early in a segment nobody has set a lap and nobody is fastest');
eq(liveGapCell(run({ position: 6, bestLapTime: 0, onOutLap: true }), run({}), quickest, false),
  'Out Lap',
  'a car circulating on an out-lap is not being timed, and the board says which');
eq(liveGapCell(run({ position: 4, bestLapTime: 90.9, retired: true }), run({}), quickest, false),
  '+1.138',
  'a car in the barrier keeps its lap and its deficit — there is no DNF in qualifying');
eq(liveGapCell(run({ position: 1, bestLapTime: 89.762, retired: true }), null, quickest, false),
  'FASTEST',
  'and if it was the quickest, it is still the quickest');
eq(liveGapCell(run({ position: 18, bestLapTime: 0, retired: true }), run({}), quickest, false),
  'OUT',
  'a car that crashed before setting a lap is out of the session, not out of the results');
eq(liveGapCell(run({ position: 9, bestLapTime: 91.2, disqualified: true }), run({}), quickest, false),
  'DSQ',
  'disqualification shows in an LTCS (Art. B2.4.3b.iii)');

console.log('\nTHE LIVE TOWER IN A RACE (every word of the race language is true)');
eq(liveGapCell(run({ position: 1 }), null, quickest, true), 'Leader',
  'a race has a leader, in the reference board\'s own word and case');
// TO THE LEADER, which is the column the user annotated in
// `reference/target/67.png`: "the time between each driver from the leader".
eq(liveGapCell(run({ position: 3, interval: 0.4, gapToLeader: 1.204 }), run({}), quickest, true),
  '+1.204',
  'and everyone else their gap to the leader, not to the car in front');
eq(liveGapCell(run({ position: 16, lapsDown: 1 }), run({ lapsDown: 0 }), quickest, true), '+1 LAP',
  'a lapped car is reported as lapped');
eq(liveGapCell(run({ position: 19, lapsDown: 3 }), run({ lapsDown: 0 }), quickest, true), '+3 LAPS',
  'three laps down reads as three laps');
eq(liveGapCell(run({ position: 16, lapsDown: 2, gapToLeader: 92.4 }), run({ lapsDown: 2 }),
  quickest, true), '+92.400',
  'two cars equally lapped are both shown against the leader');
eq(liveGapCell(run({ position: 20, retired: true }), run({}), quickest, true), 'DNF',
  'and a car that stopped did not cover the distance');
eq(liveGapCell(run({ position: 4, gapToLeader: NaN }), run({}), quickest, true), '--.---',
  'a gap that never resolved does not print NaN');

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('The classification says what it means in every session type.');
