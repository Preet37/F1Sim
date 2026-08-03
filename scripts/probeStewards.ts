/**
 * Do the stewards reach the right verdict?
 *
 * You cannot wait for a racing incident to happen and then check the decision:
 * the incident you want may not occur for twenty races, and when it does you
 * have no independent account of what it was. So every judgement here is staged.
 * Two cars are put on rails through a real corner on a real circuit at
 * prescribed offsets, the contact is reported through the same entry point the
 * engine's contact solver uses, and the race is then stepped for as long as the
 * bench takes to decide. Nothing about the stewards is stubbed.
 *
 * The cases are the ones the player described, in their words:
 *
 *   1  BOXED OUT      "I had no room to make a turn because the other car kinda
 *                     boxed me out"  — Appendix L Ch. IV Art. 2(b)
 *   2  MINE AT THE    "I was at the apex first and by the rules they weren't and
 *      APEX           therefore that corner should've been mine"  — DSG A and B
 *   3  BACK IN FRONT  a car that leaves the road and re-joins ahead
 *                     — Art. B1.8.6, DSG Point F
 *   4  THE PENALTY    "if there is a penalty, they have to serve it in the pit
 *                     lane, otherwise ... it gets added to their final time"
 *                     — Art. B1.9.5a and B1.9.5c
 *   5  THE CALENDAR   how many incidents, how many penalties, and against whom,
 *                     over a season of real races with nothing staged at all.
 *
 * Case 5 is the one that decides whether this can ship. A steward that hands out
 * penalties for incidents the AI caused is worse than no steward, and the only
 * way to know is to count them across a season.
 *
 * Run: npm run probe:stewards
 */

import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { PHYSICS_DT } from '../src/core/SimClock';
import { loopDelta } from '../src/core/MathUtils';
import { AIVehicleController } from '../src/ai/AIVehicleController';
import { CAR_HALF_WIDTH_M as RC_HALF_WIDTH } from '../src/race/RaceControlManager';
import {
  CAR_HALF_WIDTH_M, CAR_WIDTH_M, MIRROR_AHEAD_OF_ORIGIN_M,
  insideRoomMarginM, outsideRoomMarginM, racingRoomM, tariffSeconds,
} from '../src/race/DrivingStandards';
import { buildCornerTable, cornerAt, type CornerFrame } from '../src/race/Stewards';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

function raceConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    kind: 'race', name: 'Stewards', durationS: 0, laps: 30,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 31, ...over,
  };
}

/**
 * Everyone who is not in the scene, taken out of it entirely.
 *
 * Retired, and with the recovery already complete, which is the one state that
 * makes a car invisible to everything a staged scene cares about: race control
 * signals a retirement from `recovery.signal` and a finished recovery signals
 * nothing, so no yellow is raised and no safety car is deployed — and the
 * stewards decline to judge anything under a neutralisation, which would make
 * every case here come out the same way for the wrong reason.
 *
 * `cleared` matters as much. `RaceEngine.resolveContacts` still collides with a
 * retired car while it is a solid wreck, and a scene that has to run for a lap
 * and a half — the give-a-place-back window is a lap — puts the two cars on
 * rails round the whole circuit and straight through wherever the extras were
 * left. That is exactly what happened: the excursion case produced a verdict
 * about car 0 hitting car 2 forty seconds later, instead of the one it staged.
 */
function parkTheRest(engine: RaceEngine, keep: number[], awayFromS: number): void {
  const len = engine.track.length;
  let n = 0;
  for (const car of engine.cars) {
    if (keep.includes(car.index)) continue;
    car.placeOnTrack(engine.track, (awayFromS + len * 0.4 + n * 16) % len, 0, 0);
    car.retired = true;
    car.cleared = true;
    car.recovery.done = true;
    n++;
  }
}

/** A corner with room to stage two cars side by side, on this circuit. */
function pickCorner(engine: RaceEngine): CornerFrame {
  const corners = buildCornerTable(engine.track);
  let best = corners[0];
  let bestScore = -Infinity;
  for (const c of corners) {
    // Wide, and with a long enough approach that a corner-entry sample exists.
    const span = (c.exitS - c.entryS + engine.track.length) % engine.track.length;
    const score = engine.track.halfWidthAt(c.apexS) * 2 + Math.min(span, 160) * 0.05;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/**
 * One staged corner-priority case.
 *
 * `sOf` and `latOf` are called every step with the seconds elapsed since the
 * scene began; they return where each car is. The contact is reported at
 * `contactAt` seconds. Everything after that is the real bench.
 */
interface Stage {
  circuit: string;
  /** Seconds of run-up before the contact. */
  runIn: number;
  contactSeverity: number;
  aS(t: number, corner: CornerFrame, len: number, v: number): number;
  aLat(t: number, halfWidth: number, hand: number, runIn: number): number;
  bS(t: number, corner: CornerFrame, len: number, v: number): number;
  bLat(t: number, halfWidth: number, hand: number, runIn: number): number;
  /** Rail the cars for this long after the contact before letting them go. */
  holdAfter?: number;
}

interface StageResult {
  verdicts: { kind: string; offence: string | null; against: number; victim: number;
    because: string }[];
  engine: RaceEngine;
  a: CarEntry;
  b: CarEntry;
}

/**
 * The speed the corner is actually taken at.
 *
 * Staging two cars through a slow corner at 42 m/s would trip DSG Point A(ii)'s
 * "dived in" test on both of them and make every case come out the same way, for
 * a reason that has nothing to do with the case. The solver's own reference
 * speed for the apex node is the honest number.
 */
const SPEED_MS = 42;

function cornerSpeed(engine: RaceEngine, corner: CornerFrame): number {
  return engine.track.targetSpeed[engine.track.indexAt(corner.apexS)];
}

function runStage(stage: Stage): StageResult {
  const def = getCircuit(stage.circuit);
  const engine = new RaceEngine(def, raceConfig());
  engine.started = true;
  engine.startLights = 0;
  const track = engine.track;
  const len = track.length;
  const corner = pickCorner(engine);
  const hand = corner.hand;
  const halfWidth = track.halfWidthAt(corner.apexS);

  const a = engine.cars[0];
  const b = engine.cars[1];
  parkTheRest(engine, [0, 1], corner.apexS);

  const v = cornerSpeed(engine, corner);
  const hold = stage.runIn + (stage.holdAfter ?? 0.6);
  const steps = Math.round(140 / PHYSICS_DT);
  let reported = false;

  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    if (t <= hold) {
      a.placeOnTrack(track, stage.aS(t, corner, len, v),
        stage.aLat(t, halfWidth, hand, stage.runIn), v);
      b.placeOnTrack(track, stage.bS(t, corner, len, v),
        stage.bLat(t, halfWidth, hand, stage.runIn), v);
      parkTheRest(engine, [0, 1], corner.apexS);
    }
    engine.step();
    if (!reported && t >= stage.runIn) {
      reported = true;
      engine.raceControl.reportContact(a, b, stage.contactSeverity, engine.time);
    }
    const bench = engine.raceControl.stewards;
    if (bench && bench.verdicts.length > 0 && t > hold + 2) break;
  }

  const bench = engine.raceControl.stewards!;
  return {
    verdicts: bench.verdicts.map((v) => ({
      kind: v.kind, offence: v.offence, against: v.againstIndex, victim: v.victimIndex,
      because: v.because,
    })),
    engine, a, b,
  };
}

/**
 * A corner-priority scene, parameterised by the two things that decide it.
 *
 * `alongAtApex` is how far ahead of the defender the overtaking car's origin is
 * when the pair reaches the apex — the quantity DSG A(i) and B(i) test. `close`
 * is how far, and by whom, the gap is shut in the last moments: positive means
 * the DEFENDER moved onto the overtaker, negative means the overtaker moved onto
 * the defender.
 *
 * Car A is always the overtaking car, and always starts the corner behind.
 */
function priorityStage(opts: {
  circuit: string;
  overtakerInside: boolean;
  alongAtApex: number;
  close: number;
  /**
   * Which car the contact puts off the road, 'a' being the overtaking car.
   *
   * A collision that costs nobody anything is a rub, and the bench says so —
   * `Evidence.consequenceA`. Staging the contact without staging what it did
   * tests a case that does not arise: two cars touching at the apex and both
   * carrying on at unaltered speed, which really is no further action. So every
   * priority case puts somebody off, which is what the contact would do, and the
   * guard cases then have to reach no further action for their OWN reasons
   * rather than for want of a consequence.
   */
  victimOff: 'a' | 'b';
}): Stage {
  const runIn = 3.0;
  // Car A closes from 8m behind at the start of the run-in to `alongAtApex` at
  // the moment of contact, which is placed at the apex.
  const startGap = -8;
  // Half a car's width apart across the road, which is where two cars fighting
  // for a corner actually are.
  const SEPARATION_M = 1.1;
  /** How long after the contact the victim spends beyond the white line. */
  const OFF_S = 1.2;
  const offAt = (t: number, halfWidth: number, hand: number, mine: 'a' | 'b'): number | null => {
    if (mine !== opts.victimOff) return null;
    if (t <= runIn || t > runIn + OFF_S) return null;
    // Off on the side it was already on, so the excursion is the contact
    // pushing it wide rather than a teleport across the road.
    const side = (mine === 'a') === opts.overtakerInside ? -hand : hand;
    return side * (halfWidth + 1.8);
  };
  return {
    circuit: opts.circuit,
    runIn,
    holdAfter: 3.2,
    contactSeverity: 0.5,
    aS: (t, corner, len, v) => {
      const k = Math.min(1, t / runIn);
      const gap = startGap + (opts.alongAtApex - startGap) * k;
      return (corner.apexS - (runIn - t) * v + gap + len * 4) % len;
    },
    bS: (t, corner, len, v) => (corner.apexS - (runIn - t) * v + len * 4) % len,
    aLat: (t, halfWidth, hand, rI) => {
      const off = offAt(t, halfWidth, hand, 'a');
      if (off !== null) return off;
      // Inside is where `lateral * -hand` is greatest.
      const side = opts.overtakerInside ? -hand : hand;
      const base = side * SEPARATION_M;
      // The overtaker converges only when `close` is negative.
      const drift = opts.close < 0 ? -opts.close * Math.min(1, Math.max(0, t - (rI - 0.7)) / 0.7) : 0;
      return base + -side * drift;
    },
    bLat: (t, halfWidth, hand, rI) => {
      const off = offAt(t, halfWidth, hand, 'b');
      if (off !== null) return off;
      const side = opts.overtakerInside ? hand : -hand;
      const base = side * SEPARATION_M;
      const drift = opts.close > 0 ? opts.close * Math.min(1, Math.max(0, t - (rI - 0.7)) / 0.7) : 0;
      return base + -side * drift;
    },
  };
}

function only<T>(list: T[]): T | null {
  return list.length === 1 ? list[0] : null;
}

// ===========================================================================
// 0  The constants agree
// ===========================================================================

function checkConstants(): void {
  check(CAR_HALF_WIDTH_M === RC_HALF_WIDTH,
    `car half-width disagrees: DrivingStandards ${CAR_HALF_WIDTH_M} vs ` +
    `RaceControlManager ${RC_HALF_WIDTH}`);
  check(Math.abs(CAR_WIDTH_M - 1.99) < 1e-9, `one car width is ${CAR_WIDTH_M}, expected 1.99`);
  check(MIRROR_AHEAD_OF_ORIGIN_M > 0 && MIRROR_AHEAD_OF_ORIGIN_M < 1.98,
    'the mirrors must sit between the origin and the front axle');

  // The two guideline tests, checked against hand-worked numbers so a change to
  // the geometry constants cannot silently move the line.
  const shape = { cogToFrontM: 1.98, offTrack: false };
  const def = { s: 100, lateral: 0, ...shape };
  const level = { s: 100, lateral: -3, ...shape };
  check(Math.abs(insideRoomMarginM(level, def) - 1.01) < 1e-6,
    `a level inside car should clear the mirror by 1.01m, got ${insideRoomMarginM(level, def)}`);
  const nose = { s: 98.99, lateral: -3, ...shape };
  check(Math.abs(insideRoomMarginM(nose, def)) < 1e-6,
    'the inside test should sit exactly on zero 1.01m back');
  check(Math.abs(outsideRoomMarginM(level, def)) < 1e-6,
    'the outside test compares front axles, so level is zero');

  // Racing room: a car sitting on the centreline of a 12m-wide road leaves
  // 6 - 0.995 = 5.005m, which is plenty; one 4m off centre leaves 1.005m, which
  // is not a car's width.
  check(Math.abs(racingRoomM(0, 6, 1) - 5.005) < 1e-6, 'racing room from the centreline');
  check(racingRoomM(4, 6, 1) < CAR_WIDTH_M, 'a car 4m off centre on a 12m road denies room');
  check(racingRoomM(0, 6, 1) >= CAR_WIDTH_M, 'a car on the centreline denies nobody room');

  check(tariffSeconds('CAUSING A COLLISION', 0.4) === 5, 'a light collision is five seconds');
  check(tariffSeconds('CAUSING A COLLISION', 0.8) === 10, 'a heavy collision is ten');
  check(tariffSeconds('FORCING ANOTHER DRIVER OFF THE TRACK', 0) === 10, 'forcing off is ten');
  check(tariffSeconds('LEAVING THE TRACK AND GAINING AN ADVANTAGE', 0) === 5,
    'an advantage not given back is five');
}

// ===========================================================================
// 1  Every circuit has judgeable corners
// ===========================================================================

function checkCornerTables(): void {
  let totalCorners = 0;
  let noTable = 0;
  for (const def of CIRCUITS) {
    const engine = new RaceEngine(def, raceConfig({ laps: 1 }));
    const table = buildCornerTable(engine.track);
    const len = engine.track.length;
    if (table.length === 0) { noTable++; continue; }
    totalCorners += table.length;
    for (const c of table) {
      const before = (c.apexS - c.entryS + len) % len;
      const after = (c.exitS - c.apexS + len) % len;
      check(before >= 20 && before <= 240,
        `${def.id} ${c.name}: entry is ${before.toFixed(0)}m before the apex`);
      check(after >= 20 && after <= 240,
        `${def.id} ${c.name}: exit is ${after.toFixed(0)}m after the apex`);
      const found = cornerAt(table, c.apexS, len);
      check(found !== null, `${def.id} ${c.name}: its own apex is not inside any corner`);
    }
  }
  check(noTable === 0, `${noTable} circuits produced no corner table at all`);
  console.log(`  corner tables            ${CIRCUITS.length} circuits, ` +
    `${totalCorners} corners, ${(totalCorners / CIRCUITS.length).toFixed(1)} each`);
}

// ===========================================================================
// 2  "Boxed me out"
// ===========================================================================

function checkForcedOff(): void {
  const def = getCircuit('monza');
  const engine = new RaceEngine(def, raceConfig());
  engine.started = true;
  engine.startLights = 0;
  const track = engine.track;
  const len = track.length;
  const corner = pickCorner(engine);
  const halfWidth = track.halfWidthAt(corner.apexS);
  const hand = corner.hand;

  const squeezer = engine.cars[0];
  const victim = engine.cars[1];
  parkTheRest(engine, [0, 1], corner.apexS);
  const speed = cornerSpeed(engine, corner);

  // The victim runs alongside on the outside; the squeezer starts a metre and a
  // half inboard of the point at which it stops leaving a car's width, then
  // moves out onto it over a second. The victim ends up beyond the white line.
  const outSide = hand; // the outside of the corner, as a lateral sign
  const denyAt = (halfWidth - CAR_WIDTH_M - CAR_HALF_WIDTH_M) * outSide;
  const RUN = 2.4;
  const steps = Math.round(130 / PHYSICS_DT);

  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    if (t <= RUN + 0.8) {
      const k = Math.min(1, Math.max(0, (t - 0.6) / 1.2));
      const sqLat = denyAt * (0.55 + 0.75 * k);
      const s = (corner.apexS - (RUN - t) * speed + len * 4) % len;
      squeezer.placeOnTrack(track, s, sqLat, speed);
      // The victim is pushed out ahead of the squeezer's bodywork, and once the
      // room is gone it ends up over the edge.
      const vicLat = t < RUN
        ? outSide * (halfWidth - 1.4)
        : outSide * (halfWidth + 1.6);
      victim.placeOnTrack(track, s + 0.4, vicLat, speed);
      parkTheRest(engine, [0, 1], corner.apexS);
    }
    engine.step();
    const bench = engine.raceControl.stewards;
    if (bench && bench.verdicts.length > 0) break;
  }

  const all = engine.raceControl.stewards!.verdicts;
  const v = only(all);
  if (v === null) {
    fail(`boxed out: expected exactly one verdict, got ${all.length}` +
      (all.length > 0 ? ` [${all.map((x) => x.kind + ': ' + x.because).join('; ')}]` : ''));
    return;
  }
  check(v.kind === 'penalty', `boxed out: verdict was ${v.kind}, expected a penalty`);
  check(v.offence === 'FORCING ANOTHER DRIVER OFF THE TRACK',
    `boxed out: offence was ${v.offence}`);
  check(v.againstIndex === squeezer.index,
    `boxed out: penalty against car ${v.againstIndex}, expected the squeezer ` +
    `(${squeezer.index})`);
  check(v.victimIndex === victim.index, 'boxed out: the wrong car was named as the victim');
  check(squeezer.penaltySeconds === 10,
    `boxed out: the squeezer carries ${squeezer.penaltySeconds}s, expected 10`);
  check(victim.penaltySeconds === 0, 'boxed out: the victim was penalised');
  console.log(`  boxed out                ${v.offence} — ${squeezer.penaltySeconds}s ` +
    `against the car that moved over`);
}

// ===========================================================================
// 3  "That corner should've been mine"
// ===========================================================================

interface PriorityCase {
  name: string;
  overtakerInside: boolean;
  alongAtApex: number;
  close: number;
  expect: 'defender' | 'overtaker' | 'none';
  /** Car 'a' is always the overtaking car. */
  victimOff: 'a' | 'b';
}

const PRIORITY_CASES: PriorityCase[] = [
  {
    // DSG A(i) satisfied: front axle past the mirror. The defender turns in.
    name: 'inside car alongside the mirror, defender turns in', victimOff: 'a',
    overtakerInside: true, alongAtApex: 0, close: +0.8, expect: 'defender',
  },
  {
    // DSG A(i) failed by a mile — a nose stuck up the inside from a car length
    // back, which is what "dived in" means.
    name: 'inside car nowhere near the mirror, dives in', victimOff: 'b',
    overtakerInside: true, alongAtApex: -3.2, close: -0.8, expect: 'overtaker',
  },
  {
    // DSG B(i) satisfied: the car on the outside is ahead at the apex, and is
    // entitled to room "including at the exit".
    name: 'outside car ahead at the apex, squeezed by the inside car', victimOff: 'a',
    overtakerInside: false, alongAtApex: +1.6, close: +0.8, expect: 'defender',
  },
  {
    // DSG B(i) failed: not ahead at the apex, so no entitlement to the corner.
    // This is the player's own case, seen from the other seat.
    name: 'outside car not ahead at the apex, takes the corner anyway', victimOff: 'b',
    overtakerInside: false, alongAtApex: -2.0, close: -0.8, expect: 'overtaker',
  },
  {
    // Inside the band. Two cars level at the apex is a racing incident and the
    // guidelines do not pretend otherwise.
    name: 'level at the apex', victimOff: 'a',
    overtakerInside: true, alongAtApex: -1.0, close: +0.8, expect: 'none',
  },
  {
    // The guard that matters most: priority is clear, but NOBODY moved. A car
    // that held its line is not the cause of a collision with it.
    name: 'clear priority but neither car moved across', victimOff: 'a',
    overtakerInside: true, alongAtApex: 0, close: 0, expect: 'none',
  },
];

function checkPriority(): void {
  for (const c of PRIORITY_CASES) {
    const result = runStage(priorityStage({
      circuit: 'silverstone',
      overtakerInside: c.overtakerInside,
      alongAtApex: c.alongAtApex,
      close: c.close,
      victimOff: c.victimOff,
    }));
    const v = only(result.verdicts);
    if (v === null) {
      fail(`priority "${c.name}": expected one verdict, got ${result.verdicts.length}`);
      continue;
    }
    // Car A is always the overtaking car in `priorityStage`.
    const expectAgainst =
      c.expect === 'none' ? -1 : c.expect === 'overtaker' ? result.a.index : result.b.index;
    const expectKind = c.expect === 'none' ? 'no-further-action' : 'penalty';
    check(v.kind === expectKind,
      `priority "${c.name}": verdict ${v.kind}, expected ${expectKind}`);
    check(v.against === expectAgainst,
      `priority "${c.name}": against car ${v.against}, expected ${expectAgainst}`);
    if (c.expect !== 'none') {
      check(v.offence === 'CAUSING A COLLISION',
        `priority "${c.name}": offence ${v.offence}`);
    }
    const who = v.against < 0 ? ''
      : ' against ' + (v.against === result.a.index ? 'the overtaker' : 'the defender');
    console.log(`  ${c.name.padEnd(52)} ${v.kind}${who}  — ${v.because}`);
  }
}

// ===========================================================================
// 4  Leaving the track and coming back in front
// ===========================================================================

/**
 * Stages the excursion, then either hands the place back or does not.
 *
 * Returns the verdicts and the offending car so the caller can check the
 * remedy loop as well as the decision.
 */
function runExcursion(obey: boolean): { engine: RaceEngine; cheat: CarEntry; rival: CarEntry } {
  const def = getCircuit('spa');
  const engine = new RaceEngine(def, raceConfig());
  engine.started = true;
  engine.startLights = 0;
  const track = engine.track;
  const len = track.length;
  const corner = pickCorner(engine);
  const halfWidth = track.halfWidthAt(corner.apexS);

  const cheat = engine.cars[0];
  const rival = engine.cars[1];
  parkTheRest(engine, [0, 1], corner.apexS);

  // Ten seconds of run-up so both cars have a real `totalDistance`, then the
  // excursion: two seconds beyond the white line during which the offender goes
  // from eight metres behind to six metres ahead, and comes back at full speed.
  const OFF_FROM = 10;
  const OFF_TO = 12;
  // The place is handed back well AFTER the verdict, not before it. Handing it
  // back first is a different case entirely — the stewards find nothing left to
  // order and file no further action — and it was silently the case being tested
  // until the deliberation was timed against the concession. The bench takes
  // between `INVESTIGATION_MIN_S` and `INVESTIGATION_MAX_S` plus the six seconds
  // before it opens the investigation, so eighty seconds clears it on any draw.
  const OBEY_AT = OFF_TO + 80;
  const steps = Math.round(280 / PHYSICS_DT);
  let base = corner.entryS - 400;
  if (base < 0) base += len;


  // Both cars run at the circuit's own reference speed for wherever they are.
  // A fixed speed will not do: race control only counts an excursion as gaining
  // anything if the car came back at racing pace, and 42 m/s through Eau Rouge
  // is a car that lost four seconds.
  //
  // `totalDistance` IS SET EXPLICITLY, and it has to be. `placeOnTrack` moves
  // the car and resets the mark that `updateProjection` measures the next step's
  // progress from, so a car put on rails accrues distance at whatever speed it
  // is placed with and the teleport between one placement and the next never
  // counts. Both cars therefore advance identically however far apart in `s`
  // they are put — and race order is a `totalDistance` question, so the whole
  // point of the scene, that one car came back in front of the other, was
  // invisible to the stewards.
  let rivalS = base;
  let travelled = 0;
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS_DT;
    const v = track.targetSpeed[track.indexAt(rivalS)];
    rivalS = (rivalS + v * PHYSICS_DT) % len;
    travelled += v * PHYSICS_DT;
    rival.placeOnTrack(track, rivalS, 0, v);
    rival.totalDistance = travelled;

    let gap: number;
    if (t < OFF_FROM) gap = -8;
    else if (t < OFF_TO) gap = -8 + 14 * ((t - OFF_FROM) / (OFF_TO - OFF_FROM));
    else if (obey && t > OBEY_AT) gap = -8;
    else gap = 6;
    const lat = t >= OFF_FROM && t < OFF_TO ? halfWidth + 2.2 : 1.2;
    cheat.placeOnTrack(track, (rivalS + gap + len) % len, lat, v);
    cheat.totalDistance = travelled + gap;
    parkTheRest(engine, [0, 1], corner.apexS);
    engine.step();
  }
  return { engine, cheat, rival };
}

function checkExcursion(): void {
  // --- obeyed -------------------------------------------------------------
  {
    const { engine, cheat, rival } = runExcursion(true);
    const vs = engine.raceControl.stewards!.verdicts;
    const give = vs.filter((v) => v.kind === 'give-position-back');
    check(give.length === 1,
      `re-joined ahead: expected one give-back, got ${give.length} ` +
      `(verdicts: ${vs.map((v) => v.kind).join(', ') || 'none'})`);
    if (give.length === 1) {
      check(give[0].againstIndex === cheat.index, 're-joined ahead: the wrong car was ordered');
      check(give[0].victimIndex === rival.index, 're-joined ahead: the wrong beneficiary');
      check(give[0].offence === 'LEAVING THE TRACK AND GAINING AN ADVANTAGE',
        `re-joined ahead: offence ${give[0].offence}`);
    }
    check(cheat.cedePositionTo === -1, 'obeyed: the instruction was never cleared');
    check(cheat.penaltySeconds === 0,
      `obeyed: the driver gave the place back and was still penalised ` +
      `${cheat.penaltySeconds}s`);
    const gaveBack = engine.raceControl.messages.some(
      (m) => m.notice?.offence === 'POSITION GIVEN BACK');
    check(gaveBack, 'obeyed: race control never acknowledged the position being given back');
    console.log(`  re-joined ahead, obeyed  give the position back, then no further action`);
  }

  // --- ignored ------------------------------------------------------------
  {
    const { engine, cheat } = runExcursion(false);
    const vs = engine.raceControl.stewards!.verdicts;
    check(vs.some((v) => v.kind === 'give-position-back'),
      'ignored: no give-back was ever ordered');
    check(cheat.penaltySeconds === 5,
      `ignored: the driver kept the place and carries ${cheat.penaltySeconds}s, expected 5`);
    check(cheat.penalties.some((p) => p.reason.includes('FAILING TO GIVE THE POSITION BACK')),
      'ignored: the penalty does not name the offence');
    check(cheat.cedePositionTo === -1, 'ignored: the instruction is still outstanding');
    console.log(`  re-joined ahead, ignored give the position back, then a 5s penalty`);
  }
}

// ===========================================================================
// 5  An AI car obeys the same instruction
// ===========================================================================

function checkAiObeys(): void {
  const def = getCircuit('redbullring');
  const engine = new RaceEngine(def, raceConfig());
  engine.started = true;
  engine.startLights = 0;
  const track = engine.track;
  const len = track.length;

  const offender = engine.cars[0];
  const rival = engine.cars[1];
  parkTheRest(engine, [0, 1], 0);
  // Both racing normally, the offender six metres up the road.
  offender.placeOnTrack(track, 306, 0, SPEED_MS);
  rival.placeOnTrack(track, 300, 0, SPEED_MS);
  for (let i = 0; i < 240; i++) engine.step();

  const before = offender.totalDistance - rival.totalDistance;
  offender.cedePositionTo = rival.index;
  offender.cedeDeadline = engine.time + 60;

  let lifted = false;
  let swapped = false;
  const steps = Math.round(25 / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    engine.step();
    if (offender.appliedControls.throttle === 0 && offender.appliedControls.brake > 0) lifted = true;
    if (rival.totalDistance > offender.totalDistance) { swapped = true; break; }
    parkTheRest(engine, [0, 1], 0);
  }

  check(before > 0, 'AI obedience: the offender did not start ahead');
  check(lifted, 'AI obedience: the AI never lifted');
  check(swapped, 'AI obedience: the AI never actually gave the place back');
  check(offender.penaltySeconds === 0,
    `AI obedience: the AI complied and was penalised ${offender.penaltySeconds}s anyway`);
  console.log(`  AI obedience             lifted and conceded within ` +
    `${swapped ? 'the window' : 'never'}`);
  void len;
}

// ===========================================================================
// 6  Serving the penalty, and what it costs
// ===========================================================================

function checkPenaltyService(): void {
  const def = getCircuit('bahrain');

  // --- the crew stands back ----------------------------------------------
  {
    const engine = new RaceEngine(def, raceConfig());
    const car = engine.cars[3];
    engine.raceControl.issueTimePenalty(car, 5, 'CAUSING A COLLISION', 'TURN 1', 10);
    check(car.penaltySeconds === 5, 'issue: the seconds are not on the car');
    check(car.penaltyHoldS() === 5, 'issue: the crew is not being asked to stand back');
    check(car.pendingServePenalty() === null,
      'issue: a time penalty must not force the car to come to the pit lane');
    const decision = engine.raceControl.messages.find(
      (m) => m.notice?.status === '5 SECOND TIME PENALTY');
    check(decision !== undefined, 'issue: no decision was filed');
    check(decision !== undefined && decision.carIndex === car.index,
      'issue: the decision does not name a car, so the HUD cannot render it');

    const served = car.servePenaltyInBox();
    check(served === 5, 'service: the wrong duration was served');
    check(car.penaltySeconds === 0,
      `service: served in the box and still charged ${car.penaltySeconds}s at the flag`);
    check(car.penaltyHoldS() === 0, 'service: the hold did not clear');
    console.log(`  penalty served in the box 5s hold, then nothing added at the flag`);
  }

  // --- not served ---------------------------------------------------------
  {
    const engine = new RaceEngine(def, raceConfig());
    const car = engine.cars[3];
    engine.raceControl.issueTimePenalty(car, 10, 'FORCING ANOTHER DRIVER OFF THE TRACK', '', 10);
    car.finished = true;
    car.finishTime = 500;
    engine.raceControl.convertUnservedPenalties(engine.cars, 500);
    check(car.penaltySeconds === 10, 'unserved: the ten seconds went missing');
    check(car.classifiedTime() === 510, 'unserved: the time was not added to the race time');
  }

  // --- an unserved drive-through -----------------------------------------
  {
    const engine = new RaceEngine(def, raceConfig());
    const car = engine.cars[4];
    car.penalties.push({
      kind: 'drive-through', reason: 'Speeding in the pit lane',
      lap: 3, timeS: 0, served: false,
    });
    engine.raceControl.convertUnservedPenalties(engine.cars, 900);
    check(car.penaltySeconds === 20,
      `unserved drive-through: ${car.penaltySeconds}s added, Art. B1.9.5 says twenty`);
    const car2 = engine.cars[5];
    car2.penalties.push({
      kind: 'stop-go-10s', reason: 'Unsafe release', lap: 3, timeS: 0, served: false,
    });
    engine.raceControl.convertUnservedPenalties(engine.cars, 900);
    check(car2.penaltySeconds === 30,
      `unserved stop-go: ${car2.penaltySeconds}s added, Art. B1.9.5 says thirty`);
    console.log(`  unserved penalties        drive-through +20s, stop-go +30s`);
  }

  // --- the classification actually moves ----------------------------------
  //
  // The player's own worked example: "if I was position 3 but position 4 was
  // within 5 seconds of me and position 5 was not, I would drop to P4 and they
  // would go to P3."
  {
    const engine = new RaceEngine(def, raceConfig());
    for (const c of engine.cars) { c.retired = true; c.finished = false; }
    const p3 = engine.cars[0], p4 = engine.cars[1], p5 = engine.cars[2];
    const set = (c: CarEntry, time: number) => {
      c.retired = false; c.finished = true; c.finishTime = time; c.lap = 31;
    };
    set(p3, 100); set(p4, 103); set(p5, 110);
    engine.endNow();
    check(p3.position < p4.position && p4.position < p5.position,
      'classification: the unpenalised order is already wrong');
    const cleanOrder = [p3.position, p4.position, p5.position].join('-');

    const engine2 = new RaceEngine(def, raceConfig());
    for (const c of engine2.cars) { c.retired = true; c.finished = false; }
    const q3 = engine2.cars[0], q4 = engine2.cars[1], q5 = engine2.cars[2];
    const set2 = (c: CarEntry, time: number) => {
      c.retired = false; c.finished = true; c.finishTime = time; c.lap = 31;
    };
    set2(q3, 100); set2(q4, 103); set2(q5, 110);
    engine2.raceControl.issueTimePenalty(q3, 5, 'CAUSING A COLLISION', 'TURN 4', 99);
    engine2.endNow();
    check(q4.position < q3.position,
      `classification: a 5s penalty on a car 3s ahead did not cost it the place ` +
      `(${q3.position} vs ${q4.position})`);
    check(q3.position < q5.position,
      'classification: the penalty cost a place to a car seven seconds behind as well');
    console.log(`  classification            clean ${cleanOrder}, ` +
      `after +5s ${[q3.position, q4.position, q5.position].join('-')} — ` +
      `one place lost, not two`);
  }
}

// ===========================================================================
// 7  The calendar
// ===========================================================================

interface Tally {
  races: number;
  contactsSeen: number;
  noted: number;
  nfa: number;
  giveBack: number;
  penalties: number;
  penaltiesOnPlayer: number;
  notedOnPlayer: number;
  byOffence: Map<string, number>;
  againstCar: number[];
  playerFinished: number;
  /** Decisions arising on the opening lap, where a race's contacts pile up. */
  firstLapPenalties: number;
  racedLaps: number;
}

const PLAYER_INDEX = 7;

function sweepCalendar(laps: number, seeds: number[]): Tally {
  const tally: Tally = {
    races: 0, contactsSeen: 0, noted: 0, nfa: 0, giveBack: 0, penalties: 0,
    penaltiesOnPlayer: 0, notedOnPlayer: 0, byOffence: new Map(), againstCar: [],
    playerFinished: 0, firstLapPenalties: 0, racedLaps: 0,
  };

  for (const def of CIRCUITS) {
    for (const seed of seeds) {
      const config = raceConfig({
        laps, seed, standingStart: true, playerIndex: PLAYER_INDEX,
      });
      const engine = new RaceEngine(def, config);
      const player = engine.cars[PLAYER_INDEX];
      // A player who does not drive is not a player. The car is steered by an
      // AI of its own through `playerControls`, which is the same channel the
      // human uses — so it is subject to every rule the human is and to none of
      // the AI's engine-side compliance.
      const ghost = new AIVehicleController(player.driver, engine.track, seed ^ 0x5eed, 'hard');
      const MAX_STEPS = Math.round((laps * def.referencePoleTimeS * 3.4) / PHYSICS_DT);

      for (let i = 0; i < MAX_STEPS && !engine.over; i++) {
        if (engine.started) {
          const c = ghost.update(PHYSICS_DT, player.physics, player.s, player.lateral,
            player.perception);
          const pc = engine.playerControls;
          pc.throttle = c.throttle; pc.brake = c.brake; pc.steer = c.steer;
          pc.drsRequested = c.drsRequested; pc.ersMode = c.ersMode;
          pc.gearRequest = c.gearRequest;
        }
        engine.step();
      }

      const bench = engine.raceControl.stewards;
      tally.races++;
      tally.racedLaps += laps;
      if (!player.retired) tally.playerFinished++;
      if (!bench) continue;
      tally.noted += bench.noted;
      for (const v of bench.verdicts) {
        if (v.kind === 'no-further-action') tally.nfa++;
        else if (v.kind === 'give-position-back') tally.giveBack++;
        else {
          tally.penalties++;
          if (v.lap <= 1) tally.firstLapPenalties++;
          tally.byOffence.set(v.offence ?? '?', (tally.byOffence.get(v.offence ?? '?') ?? 0) + 1);
          while (tally.againstCar.length <= v.againstIndex) tally.againstCar.push(0);
          if (v.againstIndex >= 0) tally.againstCar[v.againstIndex]++;
          if (v.againstIndex === PLAYER_INDEX) tally.penaltiesOnPlayer++;
        }
      }
    }
  }
  return tally;
}

function checkCalendar(): void {
  const LAPS = 5;
  const t = sweepCalendar(LAPS, [20260729]);
  const perRace = (n: number) => (n / Math.max(1, t.races)).toFixed(2);

  console.log('');
  console.log(`WHAT A SEASON LOOKS LIKE (${t.races} races of ${LAPS} laps, 20 cars)`);
  console.log(`  incidents noted                       ${t.noted}  (${perRace(t.noted)} a race)`);
  console.log(`  no further action                     ${t.nfa}  (${perRace(t.nfa)} a race)`);
  console.log(`  positions ordered back                ${t.giveBack}  (${perRace(t.giveBack)} a race)`);
  console.log(`  penalties                             ${t.penalties}  (${perRace(t.penalties)} a race)`);
  for (const [offence, n] of [...t.byOffence].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${offence.toLowerCase().padEnd(36)}${n}`);
  }
  console.log(`  against the player's car              ${t.penaltiesOnPlayer}` +
    ` of ${t.penalties}`);
  const share = t.penalties > 0 ? t.penaltiesOnPlayer / t.penalties : 0;
  console.log(`  the player's share                    ${(share * 100).toFixed(1)}%` +
    `  (one car in twenty is 5%)`);
  const spread = t.againstCar.filter((n) => n > 0).length;
  console.log(`  distinct cars penalised               ${spread}`);
  console.log(`  player reached the flag               ${t.playerFinished} of ${t.races}`);
  // A five-lap race is not a fifth of a Grand Prix as far as the stewards are
  // concerned: the opening lap is a fixed cost that a longer race does not pay
  // again. Splitting it is the only way to say what a real distance would do.
  const later = t.penalties - t.firstLapPenalties;
  const laterLaps = Math.max(1, t.racedLaps - t.races);
  const perLap = later / laterLaps;
  const gp = t.firstLapPenalties / t.races + perLap * 56;
  console.log(`  of those, on the opening lap          ${t.firstLapPenalties}`);
  console.log(`  after the opening lap                 ${later} over ${laterLaps} race-laps` +
    ` = ${perLap.toFixed(3)} a lap`);
  console.log(`  implied for a 57-lap Grand Prix       ${gp.toFixed(1)} penalties`);

  // The bounds. These are the claim, and they are the thing that has to keep
  // being true.
  check(t.noted > 0, 'a whole calendar produced no incidents at all — the bench is not wired in');
  const penPerRace = t.penalties / Math.max(1, t.races);
  check(penPerRace <= 1.5,
    `${penPerRace.toFixed(2)} penalties a race is more than a Grand Prix produces`);
  // The number that actually matters, because these are five-lap races and a
  // Grand Prix is not five laps. A real season runs at one to three driving
  // penalties a race; below half of one and the bench has stopped working.
  check(gp >= 0.5 && gp <= 6,
    `${gp.toFixed(1)} penalties implied for a full-distance race is outside one to three ` +
    `by enough to be wrong`);
  check(t.nfa + t.giveBack >= t.penalties * 2,
    'a majority of incidents should end without a penalty, and this one does not');
  if (t.penalties >= 8) {
    check(share <= 0.30,
      `${(share * 100).toFixed(0)}% of penalties fall on one car in twenty — the bench is ` +
      `biased toward the player`);
    check(spread >= 3, 'every penalty in a season fell on the same handful of cars');
  }
}

// ===========================================================================

/**
 * `STEWARDS_PROBE=staged` runs everything except the calendar sweep.
 *
 * The sweep is most of the runtime and none of the iteration: when a staged case
 * comes out wrong it is the staging or the rule that is wrong, and re-running
 * eleven full races to find that out again costs twenty minutes a try.
 */
const STAGED_ONLY = process.env.STEWARDS_PROBE === 'staged';

console.log('THE STEWARDS');
console.log('');
checkConstants();
checkCornerTables();
console.log('');
console.log('STAGED SCENARIOS');
checkForcedOff();
checkPriority();
checkExcursion();
checkAiObeys();
console.log('');
console.log('THE PENALTY');
checkPenaltyService();
if (!STAGED_ONLY) checkCalendar();
else console.log('\n(calendar sweep skipped — STEWARDS_PROBE=staged)');

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  ' + f);
  if (failures.length > 30) console.log(`  … and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nStewards OK');
}
