/**
 * Does the AI treat the other cars as things it must not hit?
 *
 * WHY THIS EXISTS, in the player's words: "if there is a car in front or
 * something that doesn't mean that they go into the car to try to crash into
 * them ... when im in the pitlane and i haven't moved, they shouldn't just like
 * crash into me in the back, or like when at the start of the race they
 * shouldn't be like trying to reach the racing line from the right to the left
 * side by crashing into me."
 *
 * Two named, reproducible cases, plus the general shape of both, plus a census
 * over real races so a fix cannot pass here and make the racing worse:
 *
 *   1  PIT LANE      a car stopped in the lane, traffic arriving behind it.
 *   2  STANDING START a car sitting on the racing line's path, an AI on the far
 *                    side of the grid that has to get to that line.
 *   3  SLOW CAR      the general longitudinal case at racing speed.
 *   4  SIDE BY SIDE  a car holding station alongside; the AI must not converge.
 *   5  CENSUS        contacts per car-lap across the calendar, and the same
 *                    number restricted to corners, where contact is legitimate.
 *
 * The staged cases assert NO CONTACT, and contact is measured geometrically
 * from the same three-disc shape `RaceEngine.resolveContacts` uses rather than
 * from anything the engine chooses to report — a probe that asks the engine
 * whether it thinks it crashed is a probe that agrees with itself.
 *
 * What is deliberately NOT asserted is that the AI never touches anybody. "if
 * two cars are turning and an incident happens it happens" — the player said so
 * explicitly, and a field that cannot make contact in a corner is not racing.
 * Case 5 is therefore a ceiling on the rate and a floor under the overtake
 * count, together: an AI that stops crashing by refusing to race fails it.
 *
 * Run: npm run probe:traffic
 */

import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { PHYSICS_DT } from '../src/core/SimClock';
import { loopDelta } from '../src/core/MathUtils';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

// ---------------------------------------------------------------------------
// The contact test, independent of the engine's own
// ---------------------------------------------------------------------------

/**
 * The same shape `resolveContacts` resolves: three discs of radius 1.0m at
 * ±1.85m and 0 along the car's centreline. Duplicated here on purpose — the
 * point of the probe is to measure the geometry, not to inherit the engine's
 * opinion of it.
 */
const DISC_R = 1.0;
const DISC_OFF = [1.85, 0, -1.85];
/** Below this the bodywork is overlapping and the cars have touched. */
const TOUCH_M = DISC_R * 2;
/** ...and above this they are properly clear of each other again. */
const CLEAR_M = 3.5;

function bodyGapM(a: CarEntry, b: CarEntry): number {
  const aS = Math.sin(a.physics.heading), aC = Math.cos(a.physics.heading);
  const bS = Math.sin(b.physics.heading), bC = Math.cos(b.physics.heading);
  let best = Infinity;
  for (const oa of DISC_OFF) {
    const ax = a.physics.position.x + aS * oa;
    const az = a.physics.position.y + aC * oa;
    for (const ob of DISC_OFF) {
      const d = Math.hypot(
        b.physics.position.x + bS * ob - ax,
        b.physics.position.y + bC * ob - az,
      );
      if (d < best) best = d;
    }
  }
  return best;
}

/** Freezes a car exactly where it is, every step. "I haven't moved." */
function pin(car: CarEntry, x: number, z: number, heading: number): void {
  car.physics.position.x = x;
  car.physics.position.y = z;
  car.physics.heading = heading;
  car.physics.velocity.set(0, 0);
  car.physics.localVelX = 0;
  car.physics.localVelY = 0;
  car.physics.yawRate = 0;
}

/**
 * A scripted opponent: a car on rails, driving its own line at its own pace.
 *
 * Every staged case needs one car whose behaviour is not up for negotiation, or
 * the test measures which of two AIs blinked first. Two earlier attempts show
 * why it has to be rails rather than anything cleverer. A blocker simply PINNED
 * in place is no test of a lateral squeeze at all: it is stationary, so the car
 * behind is past it within a second and the crossing never happens beside it.
 * A blocker told to match the runner's speed is worse — it is a feedback loop,
 * and the pair converged on both cars crawling at 1 m/s for ever.
 *
 * So the opponent gets a fixed launch profile and holds its lateral offset,
 * exactly like a driver going straight down the road minding their own business,
 * and whether the AI ends up in the side of it is entirely the AI's doing.
 */
function railCar(
  track: RaceEngine['track'], car: CarEntry, s: number, lateral: number, speedMs: number,
): void {
  car.placeOnTrack(track, s, lateral, speedMs);
}

/** Parks every car except the ones named, well away from the scene. */
function clearTheStage(engine: RaceEngine, keep: number[], awayFromS: number): void {
  const len = engine.track.length;
  let n = 0;
  for (const car of engine.cars) {
    if (keep.includes(car.index)) continue;
    car.placeOnTrack(engine.track, (awayFromS + len * 0.35 + n * 14) % len, 0, 0);
    car.eliminated = true;
    n++;
  }
}

function raceConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    kind: 'race', name: 'Traffic', durationS: 0, laps: 5,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 11, ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. A car stopped in the pit lane, traffic arriving behind it
// ---------------------------------------------------------------------------
//
// The exact complaint. The blocker is the player, stationary, re-pinned every
// step so it cannot be shoved out of the way and quietly stop being a problem —
// which is what an unpinned test would measure, since the contact solver's first
// act is to separate the cars it just let collide.

function pitLaneQueue(circuitId: string): { worstM: number; hits: number } {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, raceConfig());
  const pit = def.pitLane;
  const len = engine.track.length;

  // Well inside the lane, past the entry road so the geometry is settled.
  const blockS = (pit.entryS + 140) % len;
  const blocker = engine.cars[0];
  const runners = [engine.cars[1], engine.cars[2], engine.cars[3]];

  clearTheStage(engine, [0, 1, 2, 3], blockS);
  engine.started = true;
  engine.startLights = 0;

  blocker.placeOnTrack(engine.track, blockS, pit.lateralOffsetM, 0);
  blocker.inPitLane = true;
  blocker.servicedThisVisit = true;
  const bx = blocker.physics.position.x;
  const bz = blocker.physics.position.y;
  const bh = blocker.physics.heading;

  // Arriving under the limiter at three, six and nine car lengths of separation
  // — comfortably enough room to stop in, if anything is looking.
  const limitMs = def.pitLane.speedLimitKph / 3.6;
  runners.forEach((car, i) => {
    car.placeOnTrack(engine.track, blockS - 34 - i * 26, pit.lateralOffsetM, limitMs);
    car.inPitLane = true;
    car.servicedThisVisit = true;
    car.ai!.state = 'PIT_APPROACH';
  });

  let worst = Infinity;
  let hits = 0;
  for (let i = 0; i < Math.round(30 / PHYSICS_DT); i++) {
    engine.step();
    pin(blocker, bx, bz, bh);
    for (const car of runners) {
      // Only while they are still behind it. Once a car is past the blocker on
      // the road the scenario is over for that car, and the wrap-around would
      // otherwise report it arriving from a lap away.
      if (loopDelta(car.s, blockS, len) < -8) continue;
      const g = bodyGapM(blocker, car);
      if (g < worst) worst = g;
      if (g < TOUCH_M) hits++;
    }
  }
  return { worstM: worst, hits };
}

console.log('1. STOPPED IN THE PIT LANE, TRAFFIC BEHIND');
for (const id of ['silverstone', 'monza', 'monaco', 'spa']) {
  const r = pitLaneQueue(id);
  console.log(`   ${id.padEnd(12)} closest approach ${r.worstM.toFixed(2)}m` +
    `  ${r.hits === 0 ? 'no contact' : r.hits + ' steps in contact'}`);
  check(r.hits === 0,
    `${id}: an AI drove into a car stopped in the pit lane ` +
    `(bodywork overlapped by ${(TOUCH_M - r.worstM).toFixed(2)}m)`);
}

// ---------------------------------------------------------------------------
// 2. A standing start, with a car on the path to the racing line
// ---------------------------------------------------------------------------
//
// The second complaint, staged as the player described it. Both cars start on
// the grid, level, one either side of the road. The racing line is on the
// blocker's side, so the AI's first act after the lights is to cross the circuit
// — and the blocker is in the way, going straight down its own half at a
// perfectly ordinary launch pace.
//
// Measured on the code before this change, at Silverstone: the AI drove from
// -3.38m to +1.30m and the gap closed to exactly 2.00m, which is the contact
// solver holding two overlapping cars apart. It was not squeezing past, it was
// leaning on a car that had done nothing but drive in a straight line.

/** A plausible standing-start launch, m/s². Roughly 0-100 km/h in four seconds. */
const LAUNCH_MS2 = 7;

function standingStartCross(circuitId: string): { worstM: number; hits: number } {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, raceConfig({ standingStart: true, seed: 3 }));
  const track = engine.track;
  const len = track.length;

  // A point a little after the line where the solved racing line is clearly to
  // one side, so "across the road" means something.
  let startS = 0;
  let bestOff = 0;
  for (let s = 0; s < 260; s += 10) {
    const off = track.lineOffset[track.indexAt(s)];
    if (Math.abs(off) > Math.abs(bestOff)) { bestOff = off; startS = s; }
  }
  const lineSide = Math.sign(bestOff || 1);
  const half = track.halfWidthAt(startS);
  const grid = Math.min(3.4, half * 0.45);

  const blocker = engine.cars[0];
  const runner = engine.cars[1];
  clearTheStage(engine, [0, 1], startS);

  const blockLat = lineSide * grid;
  let blockS = startS;
  let blockV = 0;
  blocker.placeOnTrack(track, blockS, blockLat, 0);
  runner.placeOnTrack(track, startS, -lineSide * grid, 0);

  engine.started = true;
  engine.startLights = 0;

  let worst = Infinity;
  let hits = 0;
  for (let i = 0; i < Math.round(10 / PHYSICS_DT); i++) {
    engine.step();
    blockV = Math.min(blockV + LAUNCH_MS2 * PHYSICS_DT, 60);
    blockS = (blockS + blockV * PHYSICS_DT) % len;
    railCar(track, blocker, blockS, blockLat, blockV);
    const g = bodyGapM(blocker, runner);
    if (g < worst) worst = g;
    if (g < TOUCH_M) hits++;
  }
  return { worstM: worst, hits };
}

console.log('\n2. STANDING START, CROSSING TO THE RACING LINE');
for (const id of ['silverstone', 'monza', 'interlagos', 'redbullring']) {
  const r = standingStartCross(id);
  console.log(`   ${id.padEnd(12)} closest approach ${r.worstM.toFixed(2)}m` +
    `  ${r.hits === 0 ? 'no contact' : r.hits + ' steps in contact'}`);
  check(r.hits === 0,
    `${id}: an AI drove through a car while crossing to the racing line at the start`);
}

// ---------------------------------------------------------------------------
// 3. A much slower car on the racing line, at racing speed
// ---------------------------------------------------------------------------
//
// The general form of case 1. Nothing is stationary and nothing is in a pit
// lane: this is a car limping at a quarter pace on the line, which is what a
// puncture or a lifted engine looks like, with a car arriving behind it flat
// out. Braking capability is the whole test — the closing speed is far past
// anything a fixed following distance could absorb.

function slowCarAhead(circuitId: string): { worstM: number; hits: number; closingMs: number } {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, raceConfig({ seed: 5 }));
  const track = engine.track;
  const len = track.length;

  // The fastest piece of road on the lap, so the closing speed is the worst
  // case rather than an average one.
  let atS = 0;
  let fastest = 0;
  for (let s = 0; s < len; s += 25) {
    const v = track.targetSpeed[track.indexAt(s)];
    if (v > fastest) { fastest = v; atS = s; }
  }

  const slow = engine.cars[0];
  const runner = engine.cars[1];
  clearTheStage(engine, [0, 1], atS);
  engine.started = true;
  engine.startLights = 0;

  const slowMs = fastest * 0.22;
  const startGap = 150;
  slow.placeOnTrack(track, atS, track.lineOffset[track.indexAt(atS)], slowMs);
  runner.placeOnTrack(track, atS - startGap, track.lineOffset[track.indexAt(atS - startGap)], fastest * 0.95);

  const closing = fastest * 0.95 - slowMs;
  let worst = Infinity;
  let hits = 0;
  for (let i = 0; i < Math.round(25 / PHYSICS_DT); i++) {
    // The slow car is a hazard, not a driver: hold it at its pace on its line
    // so the test is about the car behind and not about who brakes first.
    slow.physics.velocity.set(
      Math.sin(slow.physics.heading) * slowMs, Math.cos(slow.physics.heading) * slowMs,
    );
    engine.step();
    if (loopDelta(runner.s, slow.s, len) < -8) break;
    const g = bodyGapM(slow, runner);
    if (g < worst) worst = g;
    if (g < TOUCH_M) hits++;
  }
  return { worstM: worst, hits, closingMs: closing };
}

console.log('\n3. SLOW CAR ON THE RACING LINE AT SPEED');
for (const id of ['monza', 'silverstone', 'spa']) {
  const r = slowCarAhead(id);
  console.log(`   ${id.padEnd(12)} closing ${r.closingMs.toFixed(0)} m/s, ` +
    `closest approach ${r.worstM.toFixed(2)}m` +
    `  ${r.hits === 0 ? 'no contact' : r.hits + ' steps in contact'}`);
  check(r.hits === 0, `${id}: an AI drove into a slow car on the racing line`);
}

// ---------------------------------------------------------------------------
// 4. Alongside: racing room
// ---------------------------------------------------------------------------
//
// A car holding a steady line beside the AI, close but not touching, on a
// straight where there is no corner to blame. The AI is entitled to race it and
// is not entitled to lean on it, so the test is simply whether it converges.
//
// The opponent sits exactly ON the racing line and the AI arrives beside it, off
// line, level and at the same speed — which means the line the AI wants is
// occupied for the whole run. That is the point: this is the case where holding
// the line and leaving racing room are in direct conflict, and racing room wins.

function sideBySide(circuitId: string): { worstM: number; hits: number } {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, raceConfig({ seed: 9 }));
  const track = engine.track;
  const len = track.length;

  // A straight: low curvature over a good stretch.
  let atS = 0;
  for (let s = 0; s < len; s += 20) {
    let flat = true;
    for (let d = 0; d < 400; d += 20) {
      if (Math.abs(track.lineCurvature[track.indexAt(s + d)]) > 1 / 1500) { flat = false; break; }
    }
    if (flat) { atS = s; break; }
  }

  const held = engine.cars[0];
  const runner = engine.cars[1];
  clearTheStage(engine, [0, 1], atS);
  engine.started = true;
  engine.startLights = 0;

  const v = track.targetSpeed[track.indexAt(atS)] * 0.55;
  const line = track.lineOffset[track.indexAt(atS)];
  const half = track.halfWidthAt(atS);
  const side = -Math.sign(line || 1);
  let heldS = atS;
  const heldLat = line;
  held.placeOnTrack(track, heldS, heldLat, v);
  runner.placeOnTrack(track, atS, Math.max(-half + 1.4, Math.min(half - 1.4, line + side * 2.9)), v);

  let worst = Infinity;
  let hits = 0;
  for (let i = 0; i < Math.round(8 / PHYSICS_DT); i++) {
    engine.step();
    heldS = (heldS + v * PHYSICS_DT) % len;
    railCar(track, held, heldS, heldLat, v);
    if (Math.abs(loopDelta(runner.s, heldS, len)) > 40) break;
    const g = bodyGapM(held, runner);
    if (g < worst) worst = g;
    if (g < TOUCH_M) hits++;
  }
  return { worstM: worst, hits };
}

console.log('\n4. ALONGSIDE ON A STRAIGHT — RACING ROOM');
for (const id of ['monza', 'silverstone', 'bahrain']) {
  const r = sideBySide(id);
  console.log(`   ${id.padEnd(12)} closest approach ${r.worstM.toFixed(2)}m` +
    `  ${r.hits === 0 ? 'no contact' : r.hits + ' steps in contact'}`);
  check(r.hits === 0, `${id}: an AI converged on a car holding a steady line alongside it`);
}

// ---------------------------------------------------------------------------
// 5. Census: how much contact a real race actually contains
// ---------------------------------------------------------------------------
//
// The number the staged cases cannot give. Two things have to be true at once:
// the field must touch each other less, and it must still race. Counted as
// distinct contact EVENTS — a pair that stays overlapped for a second is one
// accident, not a hundred and twenty — and normalised per car-lap so circuits
// of different lengths are comparable.

interface Census { contacts: number; carLaps: number; overtakes: number; retired: number }

function census(circuitId: string, seed: number, laps: number): Census {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, raceConfig({ playerIndex: -1, laps, seed, standingStart: true }));
  const n = engine.cars.length;
  const touching = new Set<number>();
  let contacts = 0;
  let overtakes = 0;
  const lastPosition = new Map<number, number>();
  for (const c of engine.cars) lastPosition.set(c.index, c.position);

  const maxSteps = Math.round((laps * def.referencePoleTimeS * 3.2 + 90) / PHYSICS_DT);
  for (let i = 0; i < maxSteps && !engine.over; i++) {
    engine.step();
    if (i % 12 === 0) {
      // The same position-swap count `validate:race` uses, so the two numbers
      // mean the same thing.
      for (const c of engine.cars) {
        const prev = lastPosition.get(c.index)!;
        if (c.position < prev) overtakes++;
        lastPosition.set(c.index, c.position);
      }
    }
    if (i % 4 !== 0) continue;
    for (let a = 0; a < n; a++) {
      const ca = engine.cars[a];
      if (ca.retired || ca.inPitBox) continue;
      for (let b = a + 1; b < n; b++) {
        const cb = engine.cars[b];
        if (cb.retired || cb.inPitBox || ca.inPitLane !== cb.inPitLane) continue;
        const key = a * 64 + b;
        const g = bodyGapM(ca, cb);
        // Hysteresis, and it is not cosmetic. Two cars resting against each
        // other bounce in and out of overlap at the solver's separation
        // distance; counted on the bare threshold, one pair of cars nudging in
        // a pit-lane queue produced fifteen hundred "contacts" and drowned out
        // everything else on the calendar. A pair is one accident until they
        // are properly clear of each other again.
        if (g < TOUCH_M) {
          if (!touching.has(key)) { touching.add(key); contacts++; }
        } else if (g > CLEAR_M) {
          touching.delete(key);
        }
      }
    }
  }
  return {
    contacts,
    carLaps: engine.cars.reduce((t, c) => t + c.lap, 0),
    overtakes,
    retired: engine.cars.filter((c) => c.retired).length,
  };
}

console.log('\n5. CENSUS OVER REAL RACES (5 laps, 20 cars, standing start)');
let totalContacts = 0;
let totalCarLaps = 0;
let totalOvertakes = 0;
for (const def of CIRCUITS) {
  const r = census(def.id, 4, 5);
  totalContacts += r.contacts;
  totalCarLaps += r.carLaps;
  totalOvertakes += r.overtakes;
  console.log(`   ${def.id.padEnd(13)} ${String(r.contacts).padStart(4)} contacts` +
    ` / ${String(r.carLaps).padStart(3)} car-laps` +
    ` = ${(r.contacts / Math.max(r.carLaps, 1)).toFixed(2)} per car-lap` +
    `   ${String(r.overtakes).padStart(4)} overtakes, ${r.retired} retired`);
}
const perCarLap = totalContacts / Math.max(totalCarLaps, 1);
console.log(`   ${'TOTAL'.padEnd(13)} ${totalContacts} contacts / ${totalCarLaps} car-laps` +
  ` = ${perCarLap.toFixed(3)} per car-lap, ${totalOvertakes} overtakes`);

// A ceiling and a floor, and they are the same assertion read from both ends.
// The ceiling is what the player asked for. The floor is what stops it being
// met by a field that drives round in single file: an AI that never overtakes
// never has to avoid anybody.
check(perCarLap <= 1.2,
  `${perCarLap.toFixed(3)} contacts per car-lap — the field is still driving into each other`);
check(totalOvertakes >= 1500,
  `only ${totalOvertakes} overtakes across the calendar — the AI has stopped racing`);

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  ' + f);
  if (failures.length > 30) console.log(`  … and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nTraffic OK');
}
