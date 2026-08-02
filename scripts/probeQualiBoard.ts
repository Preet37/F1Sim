/**
 * Does the qualifying board tell the truth about the grid?
 *
 * WHY THIS EXISTS. The classification screen used to print `engine.standings`
 * for every session type, and for a knockout segment that is the wrong order.
 * `standings` ranks every car on its best lap of the WEEKEND, so a car knocked
 * out in Q1 keeps its Q1 time — routinely quicker than a survivor's first run
 * in Q2 — and the two interleave. The board then shows an eliminated car above
 * a car that is still in the fight, with a cut line drawn in the wrong place,
 * which is the screen being confidently wrong about the one thing it is for.
 *
 * So the board's order comes from `qualifyingBoardOrder`, and the GRID comes
 * from `rankSegment` — the same function, in the same module. This drives real
 * qualifying segments through the real engine and asserts the two agree: every
 * car the board draws above the cut is a car the grid resolution let through,
 * and every car below it is one it did not.
 *
 * Run: npm run probe:qualiboard
 */

import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import { qualifyingBoardOrder, rankSegment } from '../src/race/Classification';
import type { CarEntry } from '../src/race/CarEntry';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

/** The three segments of a real weekend, in order, with their cut sizes. */
const SEGMENTS: [1 | 2 | 3, number, number | undefined][] = [
  // phase, cars running, how many advance
  [1, 20, 15],
  [2, 15, 10],
  [3, 10, undefined],
];

for (const circuitId of ['silverstone', 'monaco', 'spa']) {
  const def = getCircuit(circuitId);
  let survivors: number[] | undefined;

  for (const [phase, expectRunners, advancing] of SEGMENTS) {
    const config: SessionConfig = {
      kind: 'qualifying',
      name: 'Q' + phase,
      durationS: 720,
      laps: 0,
      playerIndex: -1,
      standingStart: false,
      pitLaneStart: false,
      seed: 1000 + phase,
      qualifyingPhase: phase,
      advancing,
      ...(survivors ? { participants: survivors } : {}),
    };
    const engine = new RaceEngine(def, config);
    for (let i = 0; i < Math.round(720 / PHYSICS_DT) && !engine.over; i++) engine.step();

    check(engine.participants.length === expectRunners,
      `${circuitId} Q${phase}: ${engine.participants.length} runners, expected ${expectRunners}`);

    const board = qualifyingBoardOrder(engine.participants, engine.standings, advancing);

    // 1. The board's runners ARE the segment's ranking. Same function, so this
    //    is really asserting that nothing re-sorts on the way to the screen.
    const grid = rankSegment(engine.participants);
    check(board.runners.length === grid.length,
      `${circuitId} Q${phase}: board shows ${board.runners.length} runners, grid ranks ${grid.length}`);
    for (let i = 0; i < grid.length; i++) {
      check(board.runners[i] === grid[i],
        `${circuitId} Q${phase}: board row ${i + 1} is not the car the grid ranks there`);
    }

    // 2. The order is genuinely by lap time, with no-lap cars at the back.
    let previous = -1;
    let seenNoLap = false;
    for (const [i, car] of board.runners.entries()) {
      const t = car.bestLapTime > 0 ? car.bestLapTime : Infinity;
      if (t === Infinity) seenNoLap = true;
      else check(!seenNoLap, `${circuitId} Q${phase}: a car with a lap sits below one without at row ${i + 1}`);
      check(t >= previous, `${circuitId} Q${phase}: row ${i + 1} is quicker than the row above it`);
      previous = t;
    }

    // 3. Nobody already eliminated appears among the runners, and everybody
    //    eliminated appears below them.
    for (const car of board.runners) {
      check(!car.eliminated, `${circuitId} Q${phase}: ${car.driver.code} is eliminated and drawn as a runner`);
    }
    for (const car of board.alreadyOut) {
      check(car.eliminated, `${circuitId} Q${phase}: ${car.driver.code} is drawn as out but is still running`);
      check(!board.runners.includes(car),
        `${circuitId} Q${phase}: ${car.driver.code} appears twice on the board`);
    }
    check(board.runners.length + board.alreadyOut.length === engine.cars.length,
      `${circuitId} Q${phase}: the board shows ${board.runners.length + board.alreadyOut.length} of ${engine.cars.length} cars`);

    // 4. The cut falls exactly where the knockout does — or nowhere, in Q3.
    if (advancing === undefined) {
      check(board.cutAfter === -1, `${circuitId} Q${phase}: a cut line was drawn in a segment with no knockout`);
    } else {
      check(board.cutAfter === advancing,
        `${circuitId} Q${phase}: cut drawn after ${board.cutAfter}, ${advancing} advance`);
      const through = board.runners.slice(0, advancing);
      const knocked = board.runners.slice(advancing);
      check(through.length === advancing, `${circuitId} Q${phase}: wrong number above the cut`);
      check(knocked.length === expectRunners - advancing,
        `${circuitId} Q${phase}: wrong number below the cut`);
      // The slowest car above the cut must be quicker than the quickest below
      // it, or the cut is not a cut.
      const last = through[through.length - 1];
      const first = knocked[0];
      if (last && first && last.bestLapTime > 0 && first.bestLapTime > 0) {
        check(last.bestLapTime <= first.bestLapTime,
          `${circuitId} Q${phase}: the last car through is slower than the first car out`);
      }
      survivors = through.map((c: CarEntry) => c.index);
    }

    const noLap = board.runners.filter((c) => c.bestLapTime <= 0).length;
    console.log(`${circuitId.padEnd(12)} Q${phase}  ${String(board.runners.length).padStart(2)} runners  ` +
      `cut after ${String(board.cutAfter).padStart(2)}  ${board.alreadyOut.length} already out  ` +
      `${noLap} without a lap`);
  }
}

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  ' + f);
  if (failures.length > 25) console.log(`  … and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nQualifying board OK');
}
