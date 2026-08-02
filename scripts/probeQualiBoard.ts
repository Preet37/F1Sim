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
import {
  qualifyingBoardOrder, rankSegment, resolveSegment, resultGapCell,
} from '../src/race/Classification';
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

// ===========================================================================
// The car that crashes after setting the fastest lap of the session
// ===========================================================================
//
// REPORTED FROM A REAL SESSION. The player set the fastest lap of Q1 at
// Bahrain — a 1:49.758, drawn purple on the tower — and put the car in the
// barrier at Turn 4. The game showed them "RETIRED", "CLASSIFIED: P20 — DNF"
// and a button reading END SESSION.
//
// Every part of that is wrong. Qualifying is not a race and has no DNF in it.
// Art. B2.4.3a orders classified drivers by the best time each of them set;
// Art. B2.4.3b's three routes out of the classification are the 107% rule, no
// time in Q1, and disqualification, and an accident is none of them. So this
// drives the whole chain — Q1, the knockout, Q2, the grid — and asserts where
// that driver actually ends up.
//
// What the accident DOES cost is Art. B4.3.2: a car that stops away from the
// pit lane and receives physical assistance "will not be permitted to take any
// further part in that session". Q1, Q2 and Q3 are three periods of ONE session
// (Art. B2.4.2 — "the session will resume"), so the driver is out for all of
// it, is entered in Q2 without being able to run, sets no time, and is ranked
// among the no-time cars by Art. B2.4.3a.v(C) — "any driver who failed to leave
// the pits during the period".

console.log('\nA CAR THAT CRASHES AFTER TOPPING Q1');

for (const circuitId of ['bahrain', 'silverstone']) {
  const def = getCircuit(circuitId);
  const FIELD = 20;
  const Q1_ADVANCING = 15;
  const Q2_ADVANCING = 10;

  // --- Q1 ------------------------------------------------------------------
  const q1: SessionConfig = {
    kind: 'qualifying', name: 'Q1', durationS: 720, laps: 0, playerIndex: -1,
    // From the garage, as every real qualifying segment starts — so that
    // "failed to leave the pits" below is the literal thing Art. B2.4.3a.v(C)
    // describes and not an approximation of it.
    standingStart: false, pitLaneStart: true, seed: 4001,
    qualifyingPhase: 1, advancing: Q1_ADVANCING,
  };
  const e1 = new RaceEngine(def, q1);
  for (let i = 0; i < Math.round(720 / PHYSICS_DT) && !e1.over; i++) e1.step();

  // Whoever actually topped Q1 on merit is the one we wreck, so the scenario is
  // the reported one and not a car that was going to be slow anyway.
  const ranked1 = rankSegment(e1.participants);
  const hero = ranked1[0];
  const heroLap = hero.bestLapTime;
  check(heroLap > 0, `${circuitId}: nobody set a lap in Q1, the scenario needs one`);

  // The accident, on the lap AFTER the one that counts — which is the whole
  // point. The time is already on the board.
  hero.retire('Accident', e1.time, 0.9);

  // 1. The lap is not deleted by the accident.
  check(hero.bestLapTime === heroLap,
    `${circuitId} Q1: the accident deleted the driver's lap time`);

  // 2. The engine's own live standings still have them first. This is the tower
  //    the player was looking at, and it used to drop them to P20 on the step
  //    they stopped.
  e1.step();
  check(hero.position === 1,
    `${circuitId} Q1: the fastest driver in the session is classified P${hero.position} ` +
    `after their accident — a Lap Time Classified Session is classified on the lap ` +
    `(Art. B2.4.3a), not on the wreck`);

  // 3. The result column says how far off the pace they were, not DNF.
  const cell = resultGapCell(hero, false);
  check(cell === 'FASTEST',
    `${circuitId} Q1: the result column reads "${cell}" for the fastest lap of the session`);

  // 4. The segment board still ranks them first.
  const board1 = qualifyingBoardOrder(e1.participants, e1.standings, Q1_ADVANCING);
  check(board1.runners[0] === hero,
    `${circuitId} Q1: the board does not draw the fastest car at the top after it crashed`);

  // 5. The knockout puts them through, at the head of the survivors.
  const r1 = resolveSegment(
    rankSegment(e1.participants).map((c) => ({ id: c.driver.id, retired: c.retired })),
    Q1_ADVANCING);
  check(r1.survivors[0] === hero.driver.id,
    `${circuitId} Q1: the fastest driver in the session did not advance at the head of Q2`);
  check(!r1.knockedOut.includes(hero.driver.id),
    `${circuitId} Q1: the fastest driver in the session was knocked out of qualifying`);
  // ...and the accident costs them the right to run again, and only that.
  check(r1.barred.includes(hero.driver.id),
    `${circuitId} Q1: a car the marshals recovered is not barred from the rest of the ` +
    `session (Art. B4.3.2)`);

  // --- Q2, which they are entered in and cannot run -------------------------
  const survivorIndices = r1.survivors
    .map((id) => e1.cars.find((c) => c.driver.id === id)!.index);
  const barredIndices = r1.barred
    .map((id) => e1.cars.find((c) => c.driver.id === id)!.index);

  const q2: SessionConfig = {
    kind: 'qualifying', name: 'Q2', durationS: 720, laps: 0, playerIndex: -1,
    standingStart: false, pitLaneStart: true, seed: 4002,
    qualifyingPhase: 2, advancing: Q2_ADVANCING,
    participants: survivorIndices, withdrawn: barredIndices,
  };
  const e2 = new RaceEngine(def, q2);
  for (let i = 0; i < Math.round(720 / PHYSICS_DT) && !e2.over; i++) e2.step();

  const heroQ2 = e2.cars.find((c) => c.driver.id === hero.driver.id)!;

  // 6. Entered, not eliminated. The distinction is the whole fix: an eliminated
  //    car holds a grid slot decided in an earlier segment, an entered one is
  //    classified in THIS one.
  check(e2.participants.includes(heroQ2),
    `${circuitId} Q2: the driver is not entered in the segment they qualified for`);
  check(!heroQ2.eliminated,
    `${circuitId} Q2: the driver was marked eliminated rather than withdrawn`);
  check(heroQ2.withdrawn,
    `${circuitId} Q2: the driver is not withdrawn, so Art. B4.3.2 is not being applied`);
  check(e2.participants.length === Q1_ADVANCING,
    `${circuitId} Q2: ${e2.participants.length} entered, expected ${Q1_ADVANCING}`);

  // 7. They never leave the garage, and set no time.
  check(heroQ2.bestLapTime === 0,
    `${circuitId} Q2: a driver barred from the session set a lap time in it`);
  check(heroQ2.inPitLane && heroQ2.lap === 0,
    `${circuitId} Q2: a driver barred from the session left the pit lane`);

  // 8. Classified LAST OF THE Q2 RUNNERS — not last of the field, and not
  //    absent. Art. B2.4.3a.v(C).
  const board2 = qualifyingBoardOrder(e2.participants, e2.standings, Q2_ADVANCING);
  const rowQ2 = board2.runners.indexOf(heroQ2) + 1;
  check(rowQ2 === board2.runners.length,
    `${circuitId} Q2: the withdrawn driver is on row ${rowQ2} of ${board2.runners.length}`);

  // --- The grid ------------------------------------------------------------
  // Built exactly as the app shell builds it: eliminated cars fill from the
  // back, fastest of them highest.
  const grid: string[] = [];
  const place = (res: { survivors: string[]; knockedOut: string[] }) => {
    for (let i = 0; i < res.knockedOut.length; i++) {
      grid[res.survivors.length + i] = res.knockedOut[i];
    }
  };
  place(r1);
  const r2 = resolveSegment(
    rankSegment(e2.participants).map((c) => ({ id: c.driver.id, retired: c.retired })),
    Q2_ADVANCING);
  place(r2);

  const slot = grid.indexOf(hero.driver.id) + 1;
  // Twenty cars, fifteen through Q1, ten through Q2. A driver who cannot run Q2
  // is the slowest of its fifteen, so they are the first car knocked out of Q2
  // and take grid slot 11... no: they are the LAST of the five knocked out, so
  // they take the last slot Q2 hands out, which is 15. The five Q1 casualties
  // hold 16-20 and the driver is ahead of all of them.
  check(slot === Q1_ADVANCING,
    `${circuitId}: the driver starts P${slot}; a car that topped Q1 and could not run ` +
    `Q2 is classified last of the Q2 runners, which is P${Q1_ADVANCING} of ${FIELD}`);
  check(slot !== FIELD,
    `${circuitId}: the driver was sent to the back of the whole field`);

  console.log(`${circuitId.padEnd(12)} topped Q1 on ${heroLap.toFixed(3)}s, crashed, ` +
    `Q1 P${hero.position} (${cell}), through to Q2, row ${rowQ2}/${board2.runners.length} ` +
    `there with no time, starts P${slot} of ${FIELD}`);
}

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  ' + f);
  if (failures.length > 25) console.log(`  … and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nQualifying board OK');
}
