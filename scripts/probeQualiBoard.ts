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
import { Vec2 } from '../src/core/MathUtils';
import {
  qualifyingBoardOrder, rankSegment, resolveSegment, resultGapCell,
} from '../src/race/Classification';
import { pitLaneGeometry } from '../src/track/PitGeometry';
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
  //
  //    "In the garage" used to be spelled `inPitLane`, and that stopped being
  //    the right question in #74: a car standing in a garage is not in the pit
  //    lane, and while it claimed to be, the player counted twenty cars in a
  //    fifteen-car lane. The engine's own record of whether the car went out is
  //    `leftThePits`, which is what Art. B4.3.2 is actually about, and where it
  //    is standing is a question for the lane's geometry. Both are asserted, so
  //    this is stricter than the flag it replaces rather than looser.
  check(heroQ2.bestLapTime === 0,
    `${circuitId} Q2: a driver barred from the session set a lap time in it`);
  check(!heroQ2.leftThePits && heroQ2.lap === 0,
    `${circuitId} Q2: a driver barred from the session left the pit lane ` +
    `(leftThePits=${heroQ2.leftThePits}, lap=${heroQ2.lap})`);
  {
    const g = pitLaneGeometry(def, e2.track.length);
    check(Math.abs(heroQ2.lateral) > g.garageFace,
      `${circuitId} Q2: a driver barred from the session is standing in the pit lane, ` +
      `${(Math.abs(heroQ2.lateral) - g.centre).toFixed(1)}m outboard of the fast lane`);
  }

  // 7b. THE SEGMENT ACTUALLY RAN. Everyone else left the garage and set a lap.
  //
  //     This is the "in Q2 no car scored any time" half of the report, and it
  //     is not a coincidence that it arrived alongside the invisible car. The
  //     garages are numbered from the pit exit backwards, so the car in box 0
  //     is at the head of the queue — and a car that is entered but cannot run
  //     is parked in box 0 whenever it was quickest in the previous period,
  //     which is exactly the case this scenario builds. It never moves. Every
  //     car behind it used to take it as the car in front and hold station on
  //     it, so not one of the other fourteen got out of the pit lane in twelve
  //     minutes and the segment was classified with nobody having set a time.
  //
  //     The player was then shown "P1 of 15 in Q2" with no lap, which is what
  //     Art. B2.4.3a.v produces from a field where nobody left the pits — a
  //     correct ranking of a session that never happened.
  const ran = e2.participants.filter((c) => !c.sittingOut);
  const left = ran.filter((c) => c.leftThePits).length;
  const timed = ran.filter((c) => c.bestLapTime > 0).length;
  check(left === ran.length,
    `${circuitId} Q2: only ${left} of ${ran.length} runners left the pit lane — a car ` +
    `that takes no part in the session is blocking the queue behind it`);
  check(timed === ran.length,
    `${circuitId} Q2: only ${timed} of ${ran.length} runners set a lap time`);

  // 8. Classified BELOW EVERYONE WHO SET A TIME and above nobody who ran.
  //    Art. B2.4.3a.v(C).
  //
  //    Not simply "last of the fifteen". A Q1 can recover more than one car —
  //    Silverstone's does — and then there are several drivers entered in Q2
  //    who never leave the pits. They are all in group (C), so Art. B2.4.3a.v's
  //    final clause orders them "in accordance with the order they were
  //    classified in the previous period of Qualifying", and a driver who
  //    topped Q1 is therefore the FIRST of them, not the last. Asserting a
  //    fixed row would be asserting that only one car can ever be recovered.
  const board2 = qualifyingBoardOrder(e2.participants, e2.standings, Q2_ADVANCING);
  const rowQ2 = board2.runners.indexOf(heroQ2) + 1;
  const barredInQ2 = board2.runners.filter((c) => c.withdrawn);
  check(rowQ2 === ran.length + 1,
    `${circuitId} Q2: the withdrawn driver is on row ${rowQ2}; ${ran.length} cars ran the ` +
    `segment, so a driver who set no time belongs on row ${ran.length + 1}`);
  check(barredInQ2[0] === heroQ2,
    `${circuitId} Q2: the driver who topped Q1 is not the highest-classified of the ` +
    `${barredInQ2.length} drivers barred from running it (Art. B2.4.3a.v, final clause)`);

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
  // Twenty cars, fifteen through Q1, ten through Q2. Q2 hands out slots 11 to
  // 15 and the five Q1 casualties hold 16 to 20, so a driver who got through Q1
  // and could not run Q2 starts wherever Q2 classified them — and that is the
  // whole value of the distinction between `withdrawn` and `eliminated`. It is
  // the difference between P15 and P20 and it is worth a race.
  check(slot === rowQ2,
    `${circuitId}: the driver starts P${slot} but was classified row ${rowQ2} of Q2`);
  check(slot > Q2_ADVANCING && slot <= Q1_ADVANCING,
    `${circuitId}: the driver starts P${slot}; a car knocked out of Q2 takes one of ` +
    `slots ${Q2_ADVANCING + 1}-${Q1_ADVANCING} of ${FIELD}`);
  check(slot !== FIELD,
    `${circuitId}: the driver was sent to the back of the whole field`);

  console.log(`${circuitId.padEnd(12)} topped Q1 on ${heroLap.toFixed(3)}s, crashed, ` +
    `Q1 P${hero.position} (${cell}), through to Q2, row ${rowQ2}/${board2.runners.length} ` +
    `there with no time, starts P${slot} of ${FIELD}`);
}

// ===========================================================================
// A segment in which NOBODY sets a time
// ===========================================================================
//
// The player was shown "P1 of 15 in Q2" against "YOUR BEST LAP: No time set".
// First of fifteen with no time means no other car had one either, and the
// question that raises is whether the ordering behind it is a real ordering or
// an arbitrary one. It has to be a real one: Q2's order decides grid slots 11
// to 15 whether or not a wheel was turned.
//
// Art. B2.4.3a.v: "If more than one driver fails to set a lap time during Q2 or
// Q3 they will be arranged in the following order: (A) Any driver who attempted
// to set a lap time by starting a flying lap. (B) Any driver who failed to
// start a flying lap. (C) Any driver who failed to leave the pits during the
// period", and then "the relative classification of drivers in each of the
// categories... shall be determined in accordance with the order they were
// classified in the previous period of Qualifying".
//
// So a field of no-time cars has exactly one correct order, and `rankSegment`
// has to produce it from a stable sort over `participants` — which is why
// `RaceEngine.participants` hands its cars back in the previous period's order
// rather than in car-number order.

console.log('\nA SEGMENT NOBODY SETS A TIME IN');
{
  // Named for where the previous period classified them: p1 was quickest in Q1,
  // p8 was eighth. Handed to `rankSegment` in that order, as the engine does.
  const mk = (name: string, group: 'A' | 'B' | 'C') => ({
    name,
    bestLapTime: 0,
    startedFlyingLap: group === 'A',
    leftThePits: group !== 'C',
  });
  const field = [
    mk('p1', 'C'), // topped Q1 and was then recovered — Art. B4.3.2
    mk('p2', 'B'),
    mk('p3', 'A'),
    mk('p4', 'C'),
    mk('p5', 'A'),
    mk('p6', 'B'),
  ];
  const order = rankSegment(field).map((c) => c.name);
  check(order.join(' ') === 'p3 p5 p2 p6 p1 p4',
    `a field where nobody set a time ranked "${order.join(' ')}", expected ` +
    `"p3 p5 p2 p6 p1 p4" — flying laps first, then out of the pits, then the ` +
    `garage, and the previous period's order within each (Art. B2.4.3a.v)`);

  // The same field, shuffled. This must NOT change the groups — only the
  // within-group order, because that is the only thing the previous period's
  // classification can be. A sort that was unstable, or that fell back on
  // insertion order across group boundaries, would pass the test above and fail
  // this one.
  const shuffled = [field[4], field[0], field[5], field[2], field[3], field[1]];
  const groups = rankSegment(shuffled).map((c) => (c.startedFlyingLap ? 'A' : c.leftThePits ? 'B' : 'C'));
  check(groups.join('') === 'AABBCC',
    `a shuffled field of no-time cars grouped "${groups.join('')}", expected "AABBCC"`);

  console.log(`no-time ranking   ${order.join(' ')}   groups ${groups.join('')}`);
}

// ===========================================================================
// The cars that are not in the session
// ===========================================================================
//
// REPORTED FROM A REAL SESSION, TWICE. "In Q2 I just got hit by an imaginary
// car. I tried it twice and I got hit at the same time for Bahrain. I got
// physically hit and knocked out by one of the other cars but it was imaginary
// because there was no car in front of me and I was the first car on track."
// The retirement card showed real contact damage — front wing 19%, front
// suspension 25%, both sidepods 10% — at Turn 4, Bahrain, Q2.
//
// It was deterministic because it was not a car. `placeGrid` placed the cars
// TAKING PART and nothing else, so the five cars knocked out of Q1 spent Q2
// exactly where `new CarEntry` leaves them: the world origin, with `s` still
// reading zero. They were neither `retired` nor `inPitBox`, which were the only
// two things `resolveContacts` skipped, so all five were a stack of collision
// discs standing on the road. And the renderer takes a car's height from
// `elevationAt(car.s)`, so with `s` at zero they were drawn about four metres
// below the surface of the circuit. Solid, and invisible.
//
// At Bahrain the origin is 5.0m from the centreline at s = 1948m, and the
// half-width there is 7.5m — on the racing surface, on the exit of Turn 4. At
// Silverstone it is 59m off the road, at Spa 104m, which is why only one
// circuit produced the report.
//
// The fix is `CarEntry.sittingOut`: one name for "takes no part in this
// period", tested by the step loop, by `resolveContacts`, by the AI's
// perception, and answered by parking the car in its garage so the renderer
// draws it where it really is. This asserts all four.

console.log('\nCARS THAT ARE NOT IN THE SESSION');

// The engine's own broad phase: two cars whose centres are further apart than
// this cannot be touching, whatever their headings. `RaceEngine` derives it as
// 2 * (1.85 + 1.0) from the disc layout it collides with.
const CONTACT_RANGE_M = 5.7;

for (const circuitId of ['bahrain', 'silverstone', 'monaco', 'spa']) {
  const def = getCircuit(circuitId);

  // --- Q1, so that Q2 has a real set of cars knocked out of it -------------
  const e1 = new RaceEngine(def, {
    kind: 'qualifying', name: 'Q1', durationS: 600, laps: 0, playerIndex: -1,
    standingStart: false, pitLaneStart: true, seed: 7101,
    qualifyingPhase: 1, advancing: 15,
  });
  for (let i = 0; i < Math.round(600 / PHYSICS_DT) && !e1.over; i++) e1.step();

  const r1 = resolveSegment(
    rankSegment(e1.participants).map((c) => ({ id: c.driver.id, retired: c.retired })), 15);
  const idx = (id: string) => e1.cars.find((c) => c.driver.id === id)!.index;

  // --- Q2, with the Q1 casualties eliminated and the Art. B4.3.2 cars ------
  //     withdrawn. Both are `sittingOut`; both used to be solid.
  const e2 = new RaceEngine(def, {
    kind: 'qualifying', name: 'Q2', durationS: 600, laps: 0, playerIndex: -1,
    standingStart: false, pitLaneStart: true, seed: 7102,
    qualifyingPhase: 2, advancing: 10,
    participants: r1.survivors.map(idx), withdrawn: r1.barred.map(idx),
  });

  const absent = e2.cars.filter((c) => c.sittingOut);
  check(absent.length > 0,
    `${circuitId} Q2: nobody is sitting the segment out, so this proves nothing`);

  // 1. WHERE THEY ARE. Not on the road, and not at the origin.
  for (const car of absent) {
    const halfWidth = e2.track.halfWidthAt(car.s);
    const onTheRoad = Math.abs(car.lateral) <= halfWidth;
    check(!onTheRoad,
      `${circuitId} Q2: ${car.driver.code} takes no part in the segment but is standing ` +
      `on the racing surface at s=${car.s.toFixed(0)}m, ${Math.abs(car.lateral).toFixed(1)}m ` +
      `from the centreline of a ${halfWidth.toFixed(1)}m half-width`);
    // IN THE GARAGE, WHICH IS NOT THE PIT LANE. This used to assert
    // `inPitLane && inPitBox` and print "all in their garages" underneath, and
    // both halves were false: `parkSittingOut` placed the car on
    // `pitLane.lateralOffsetM`, the fast lane's centreline, and the flags said
    // it was in the lane because it was. Issues #74 and #75 are that sentence.
    // Measured against the lane's own plan now — the garage frontage is
    // `garageFace` and a car in a garage is behind it.
    const g = pitLaneGeometry(def, e2.track.length);
    const outboard = Math.abs(car.lateral) - g.centre;
    check(Math.abs(car.lateral) > g.garageFace,
      `${circuitId} Q2: ${car.driver.code} takes no part in the segment but is standing in ` +
      `the pit lane, ${outboard.toFixed(1)}m outboard of the fast lane's centreline ` +
      `(the garage frontage is ${(g.garageFace - g.centre).toFixed(1)}m out)`);
    check(!car.inPitLane && !car.inPitBox,
      `${circuitId} Q2: ${car.driver.code} is in its garage but still claims to be in the ` +
      `pit lane (inPitLane=${car.inPitLane}, inPitBox=${car.inPitBox}) — every rule written ` +
      `on that flag, and every count of cars in the lane, will believe it`);
    check(Math.hypot(car.physics.position.x, car.physics.position.y) > 1,
      `${circuitId} Q2: ${car.driver.code} is sitting at the world origin, which is where ` +
      `an unplaced CarEntry sits`);
  }

  // 2. WHERE THEY ARE DRAWN. The renderer positions a car at its world x/z but
  //    takes the HEIGHT from `elevationAt(car.s)`, so a car whose `s` disagrees
  //    with its world position is drawn through the scenery — which is the
  //    whole of "there was no car in front of me". Asserting the two agree is
  //    asserting the renderer cannot draw it anywhere odd.
  const w = new Vec2();
  for (const car of absent) {
    e2.track.toWorld(car.s, car.lateral, w);
    const drift = Math.hypot(w.x - car.physics.position.x, w.y - car.physics.position.y);
    check(drift < 1.0,
      `${circuitId} Q2: ${car.driver.code} is at (${car.physics.position.x.toFixed(0)}, ` +
      `${car.physics.position.y.toFixed(0)}) but s=${car.s.toFixed(0)}m puts it ${drift.toFixed(0)}m ` +
      `away — the renderer would draw it at the elevation of somewhere else entirely`);
  }

  // 3. THEY ARE NOT SOLID. Drop one of them squarely in front of a runner,
  //    nose to nose, and step. A car in the session must pass straight through
  //    it: `sittingOut` is the rule, not "it happens to be parked out of the
  //    way", and a probe that only tested the parking would pass on a build
  //    where the collision solver still collided with them.
  {
    const ghost = absent[0];
    const runner = e2.participants.find((c) => !c.sittingOut)!;
    const s0 = e2.track.length * 0.5;
    runner.placeOnTrack(e2.track, s0, 0, 60);
    runner.inPitLane = false;
    runner.releaseTimer = 0;
    ghost.placeOnTrack(e2.track, s0 + 3, 0, 0);
    ghost.inPitLane = false;
    ghost.inPitBox = false;
    const vBefore = runner.physics.speedMs;
    const healthBefore = runner.damage.worst().health;
    e2.step();
    check(runner.physics.speedMs > vBefore - 5,
      `${circuitId} Q2: a runner placed 3m behind a car that is not in the session was ` +
      `slowed from ${vBefore.toFixed(1)} to ${runner.physics.speedMs.toFixed(1)} m/s by it`);
    check(runner.damage.worst().health >= healthBefore - 1e-6,
      `${circuitId} Q2: a runner took damage from a car that is not in the session`);
  }

  // Put the segment back where it was and run it for real.
  const e3 = new RaceEngine(def, {
    kind: 'qualifying', name: 'Q2', durationS: 600, laps: 0, playerIndex: -1,
    standingStart: false, pitLaneStart: true, seed: 7102,
    qualifyingPhase: 2, advancing: 10,
    participants: r1.survivors.map(idx), withdrawn: r1.barred.map(idx),
  });

  // 4. THE WHOLE SEGMENT. Every step, every runner against every car sitting
  //    the segment out. Nothing may come within touching distance, and the
  //    report names the car and its flags so a failure says what was hit
  //    rather than that something was.
  let closest = Infinity;
  let closestReport = '';
  let encounters = 0;
  const sitting = e3.cars.filter((c) => c.sittingOut);
  const steps = Math.round(600 / PHYSICS_DT);
  for (let i = 0; i < steps && !e3.over; i++) {
    e3.step();
    // Every fourth step. At 8ms a step a car covers half a metre, so a pass
    // this misses is not a pass that could have touched anything.
    if (i % 4 !== 0) continue;
    for (const car of e3.participants) {
      // EVERY runner, wherever it is, INCLUDING in the pit lane.
      //
      // This used to read `if (car.sittingOut || car.inPitLane) continue;` on
      // the stated grounds that "a car driving down the pit lane passes within
      // three metres of every garage on its way out ... the engine keeps those
      // apart with `inPitBox` and the pit-wall test". Neither did. `inPitBox`
      // takes the parked car OUT of `resolveContacts`, which is the opposite of
      // keeping two cars apart, and the pit-wall test only separates a car in
      // the lane from a car on the circuit — it does nothing for two cars both
      // in the lane. So the one place in the session where a runner and a car
      // that is not in it are ever near each other was the one place this
      // probe deliberately did not look, and issues #74 and #75 were both
      // living in it. Skipping the sitting-out cars themselves is kept: two
      // parked cars have nothing to resolve.
      if (car.sittingOut) continue;
      for (const g of sitting) {
        const d = Math.hypot(
          car.physics.position.x - g.physics.position.x,
          car.physics.position.y - g.physics.position.y);
        if (d >= closest) continue;
        closest = d;
        closestReport =
          `${car.driver.code} came within ${d.toFixed(1)}m of ${g.driver.code} ` +
          `(#${g.index}) at (${g.physics.position.x.toFixed(0)}, ` +
          `${g.physics.position.y.toFixed(0)}), s=${g.s.toFixed(0)}m, ` +
          `eliminated=${g.eliminated} withdrawn=${g.withdrawn} ` +
          `inPitLane=${g.inPitLane} retired=${g.retired}`;
        if (d < CONTACT_RANGE_M) encounters++;
      }
    }
  }
  check(encounters === 0,
    `${circuitId} Q2: ${encounters} samples inside touching distance of a car that is not ` +
    `in the segment — ${closestReport}`);

  // 5. ...and nobody was knocked out by one. Contact damage on a car that was
  //    never near another runner is the symptom the player actually reported.
  for (const car of e3.participants) {
    if (car.sittingOut) continue;
    check(!(car.retired && /accident|contact/i.test(car.retirementReason) && car.lap === 0),
      `${circuitId} Q2: ${car.driver.code} was taken out by contact before completing a lap`);
  }

  console.log(`${circuitId.padEnd(12)} Q2  ${sitting.length} cars sitting out, ` +
    `${sitting.filter((c) => !c.inPitLane).length} of them clear of the pit lane, ` +
    `closest approach by a runner ${closest.toFixed(0)}m`);
}

// ===========================================================================
// The player stops EARLY, and the other nineteen carry on
// ===========================================================================
//
//   "also like even tho I DNF doesn't mean that the rest weren't able to get a
//    time classification, just make the simulation up or something, ykwim"
//
// The scenario above wrecks the hero at the END of the segment, once everybody
// has run. This one wrecks them at t=90s of 720 — before a single car has a
// lap — which is what a real gravel trap looks like and what the reported
// screenshot showed (`YOUR BEST LAP: No time set`, `AS IT STANDS: P20 of 20`).
//
// WHAT THIS ASSERTION IS FOR. There are two ways the user's complaint could be
// true, and they live in different files. The engine could freeze the field
// behind a stopped car — which it demonstrably can, see the Q2 pit-lane
// deadlock above — or the app shell could publish the classification before the
// session had finished producing one. This pins the ENGINE half: whatever the
// player's car does, the other nineteen must still get out, run, and set times.
//
// IT PASSES ON `main` AS WRITTEN, and that is the finding rather than a reason
// not to write it. The defect was entirely in the shell: `Skip to the result`
// called `finishSession` on the spot and ranked a field that had not driven
// yet. The numbers below are the ones that established it — 0 of 20 with a lap
// at the moment of the accident, 19 of 20 once the segment is allowed to
// finish. `probe:qualiretire` holds the shell half in a browser; this holds the
// engine, cheaply, in the suite that already runs everywhere.

console.log('\nTHE PLAYER STOPS AT T=90s AND THE SEGMENT CARRIES ON');

for (const circuitId of ['bahrain', 'monaco']) {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'qualifying', name: 'Q1', durationS: 720, laps: 0, playerIndex: 0,
    standingStart: false, pitLaneStart: true, seed: 4001,
    qualifyingPhase: 1, advancing: 15,
  };
  const engine = new RaceEngine(def, config);
  const stepsFor = (s: number) => Math.round(s / PHYSICS_DT);

  for (let i = 0; i < stepsFor(90) && !engine.over; i++) engine.step();
  const stopped = engine.playerCar;
  check(stopped !== null, `${circuitId}: the scenario needs a player car`);
  if (!stopped) continue;
  stopped.retire('Beached in the gravel', engine.time, 0.85);

  // What a classification published at this instant would have contained. Not
  // an assertion — a measurement, printed, because it is the size of the bug.
  const timedAtStop = engine.participants.filter((c) => c.bestLapTime > 0).length;

  for (let i = 0; i < stepsFor(720) && !engine.over; i++) engine.step();

  const others = engine.participants.filter((c) => c !== stopped);
  const timed = others.filter((c) => c.bestLapTime > 0).length;
  check(timed === others.length,
    `${circuitId} Q1: the player stopped at 90s and only ${timed} of ${others.length} other ` +
    `cars set a lap time — a driver's own accident has no bearing on whether anybody ` +
    `else is classified`);

  const out = others.filter((c) => c.leftThePits).length;
  check(out === others.length,
    `${circuitId} Q1: only ${out} of ${others.length} other cars left the pit lane after ` +
    `the player stopped`);

  // And the stopped driver is classified, at the back of the no-time group,
  // rather than deleted. Art. B2.4.3a: classified on the lap set — there was
  // none — and Art. B2.4.3b's three routes out do not include an accident.
  const finalOrder = rankSegment(engine.participants);
  check(finalOrder.length === engine.participants.length,
    `${circuitId} Q1: the classification lost a car`);
  check(finalOrder.includes(stopped),
    `${circuitId} Q1: the driver who stopped is not in the classification at all`);
  check(finalOrder.indexOf(stopped) === finalOrder.length - 1,
    `${circuitId} Q1: the only driver without a time is classified ` +
    `P${finalOrder.indexOf(stopped) + 1}, not last`);

  console.log(`${circuitId.padEnd(12)} at the accident ${timedAtStop}/${engine.participants.length} ` +
    `had a lap; at the flag ${timed}/${others.length} of the others did, ` +
    `player classified P${finalOrder.indexOf(stopped) + 1}`);
}

// ===========================================================================
// The number beside the player's name, in a segment they survived
// ===========================================================================
//
//   "q2 it should've been 15 ... and the leaderboard showed me as 20th place"
//
// Issue #74, second half. A driver who came through Q1 cannot be twentieth in
// Q2, because there are only fifteen cars in Q2. The number on the live tower
// is `CarEntry.position`, written by `RaceEngine.updateStandings`, and
// `standings` is EVERY entered car — twenty of them, always, in every session
// type, because the same array is the race's classification. The only thing
// that could tell it five of the twenty were not in this segment is
// `classificationTier`, and until #74 it could not: an eliminated car is
// neither retired nor disqualified.
//
// So this drives a real Q2 with the player at the LAST index of the entry list,
// which is where a career rookie's entry sits — `Career.grid()` is in team
// order and a rookie starts at the weakest team — and watches the number from
// the first step, before anybody has set a lap. That is when the bug shows:
// with every car on `bestLapTime === 0` the sort has nothing to separate them
// and a stable sort leaves the field in construction order.
//
// It is asserted on the ENGINE's number rather than on the HUD's, deliberately.
// `Hud.standingsCells` prints `String(car.position)` and nothing else, so the
// engine's number IS the displayed one, and `src/ui/Hud.ts` belongs to the
// timing-tower work (#17/#35/#76). If the tower ever draws a different number
// from this, that is a display bug and it is theirs; this pins the simulation.

console.log("\nTHE NUMBER BESIDE THE PLAYER'S NAME");

for (const circuitId of ['bahrain', 'monaco']) {
  const def = getCircuit(circuitId);

  // Q1 first, so the knockout is real rather than declared.
  const e1 = new RaceEngine(def, {
    kind: 'qualifying', name: 'Q1', durationS: 600, laps: 0, playerIndex: 19,
    standingStart: false, pitLaneStart: true, seed: 7401,
    qualifyingPhase: 1, advancing: 15,
  });
  for (let i = 0; i < Math.round(600 / PHYSICS_DT) && !e1.over; i++) e1.step();

  const q1 = rankSegment(e1.participants);
  const player1 = e1.cars[19];
  const survivors = q1.slice(0, 15);
  // The probe is about a driver who GOT THROUGH. If the seed knocks them out,
  // put them in the last surviving slot rather than quietly measuring nothing.
  const through = survivors.includes(player1)
    ? survivors
    : [...survivors.slice(0, 14), player1];

  const e2 = new RaceEngine(def, {
    kind: 'qualifying', name: 'Q2', durationS: 480, laps: 0, playerIndex: 19,
    standingStart: false, pitLaneStart: true, seed: 7402,
    qualifyingPhase: 2, advancing: 10,
    participants: through.map((c: CarEntry) => c.index),
  });
  const player = e2.cars[19];
  const runners = e2.participants.filter((c) => !c.sittingOut).length;

  let worstPos = 0;
  let worstAtS = 0;
  let outOfRange = 0;
  let aheadOfARunner = 0;
  const steps = Math.round(480 / PHYSICS_DT);
  for (let i = 0; i < steps && !e2.over; i++) {
    e2.step();
    if (i % 60 !== 0) continue;
    if (player.position > worstPos) {
      worstPos = player.position;
      worstAtS = i * PHYSICS_DT;
    }
    if (player.position > runners) outOfRange++;
    // ...and the general rule the player's number is one case of: nobody who
    // is out of the segment may be classified above somebody who is in it.
    for (const car of e2.cars) {
      if (!car.sittingOut) continue;
      for (const other of e2.cars) {
        if (other.sittingOut) continue;
        if (car.position < other.position) aheadOfARunner++;
      }
    }
  }

  check(outOfRange === 0,
    `${circuitId} Q2: the player was shown P${worstPos} of a ${runners}-car segment ` +
    `(first at t=${worstAtS.toFixed(0)}s, on ${outOfRange} samples) — a driver who came ` +
    `through Q1 cannot be classified below the size of the field they are in`);
  check(aheadOfARunner === 0,
    `${circuitId} Q2: a car that takes no part in the segment was classified above one ` +
    `that does, on ${aheadOfARunner} car-samples`);

  console.log(`${circuitId.padEnd(12)} Q2  ${runners} runners, player's worst position ` +
    `P${worstPos}${worstPos > runners ? ' — OUTSIDE THE FIELD' : ''}`);
}

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 25)) console.log('  ' + f);
  if (failures.length > 25) console.log(`  … and ${failures.length - 25} more`);
  process.exitCode = 1;
} else {
  console.log('\nQualifying board OK');
}
