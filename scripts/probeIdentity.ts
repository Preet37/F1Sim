import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { getTeam, getDriver } from '../src/data/teams';
import { Career } from '../src/career/Career';
import { playerIndexIn } from '../src/career/Seat';
import { encode, decode } from '../src/career/SaveCodec';
import { sortedStandings } from '../src/career/Season';
import type { RoundResult } from '../src/career/Season';

/**
 * The player's own name, number, nationality and colours reach the simulation.
 *
 * WHY THIS PROBE EXISTS, IN THE WORDS OF THE PERSON WHO PLAYED IT:
 *
 *   "If the name is changed, it should reflect on everyone else in that career.
 *    Right now, I can change my name on the front page, but that doesn't change
 *    anything else that's happening in the qualifying, the actual runs at all."
 *
 * The cause was not a display bug. `SessionConfig.playerIndex` was hard-coded to
 * zero everywhere, and a career field is the whole championship in TEAM order
 * with the rookie's team last — so the human drove entry zero, the first car of
 * the strongest team, while their own driver record sat at the back being driven
 * by the AI. Every name, number and colour on every screen was correct; they
 * belonged to a driver the player had never heard of.
 *
 * A probe is the only thing that keeps that fixed, because both the broken and
 * the working version put twenty cars on a grid and produce a plausible
 * classification. Nothing short of asserting on the actual characters of the
 * actual name tells the two apart.
 *
 * The name below is deliberately unlike anything in `src/data/roster/`: if
 * "ZDRAVKOVIĆ" appears in a classification, it got there from the create screen
 * and from nowhere else.
 */

const CIRCUIT = process.argv[2] ?? 'monza';
const STEPS_PER_SECOND = Math.round(1 / PHYSICS_DT);

const FIRST = 'Ondrej';
const LAST = 'Zdravkovic';
const NATIONALITY = 'Czechia';
const NUMBER = 63;

let failures = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// ===========================================================================
// 1. Creation puts the chosen identity into the world
// ===========================================================================

console.log('\nIdentity — creation');

const career = Career.create({
  firstName: FIRST, lastName: LAST, nationality: NATIONALITY,
  raceNumber: NUMBER, seed: 20260729,
});

const me = career.playerAsDriver();
check(me.firstName === FIRST, 'given name survives creation', me.firstName);
check(me.lastName === LAST, 'surname survives creation', me.lastName);
check(me.code === 'ZDR', 'three-letter code is derived from the surname', me.code);
check(me.nationality === NATIONALITY, 'nationality survives creation', me.nationality);
check(me.raceNumber === NUMBER, 'race number survives creation', String(me.raceNumber));

// The grid overlay is what the physics, the AI, the timing tower and the livery
// all read. If the player is not in it under their own name, nothing downstream
// can show it however well written it is.
const viaOverlay = getDriver(career.state.playerDriverId);
check(viaOverlay.lastName === LAST,
  'getDriver() — the lookup every system uses — returns the player',
  viaOverlay.firstName + ' ' + viaOverlay.lastName);

// ===========================================================================
// 2. The player is seated in their OWN car
// ===========================================================================

console.log('\nIdentity — the seat');

const field = career.grid();
const trueIndex = field.findIndex((d) => d.id === career.state.playerDriverId);

check(trueIndex >= 0, 'the player is in the field at all', 'index ' + trueIndex);
// The regression guard. If a future change ever puts the player at index zero
// by construction, this probe would pass while testing nothing, so it says so.
check(trueIndex !== 0,
  'the player is NOT index zero, so this probe is measuring something',
  'index ' + trueIndex + ' of ' + field.length);
check(playerIndexIn(field, career.state.playerDriverId) === trueIndex,
  'playerIndexIn() finds the player where they actually are');
check(playerIndexIn(undefined, 'PLAYER') === 0,
  'playerIndexIn() falls back to entry zero outside a career');

const teamOfPlayer = getTeam(me.teamId);
check(teamOfPlayer.id === career.state.teamId,
  'the player drives for the team the career gave them', teamOfPlayer.name);

// ===========================================================================
// 3. A real session run the way main.ts runs one
// ===========================================================================

console.log('\nIdentity — a session');

const config: SessionConfig = {
  kind: 'qualifying',
  name: 'Q1',
  qualifyingPhase: 1,
  advancing: 15,
  durationS: 540,
  laps: 0,
  playerIndex: playerIndexIn(field, career.state.playerDriverId),
  standingStart: false,
  pitLaneStart: true,
  seed: 0x51d0c7,
};

const engine = new RaceEngine(getCircuit(CIRCUIT), config, field);
const car = engine.playerCar;

check(car !== null, 'the session has a player car');
if (car) {
  check(car.driver.lastName === LAST,
    'the car the human drives carries the human’s surname',
    car.driver.firstName + ' ' + car.driver.lastName);
  check(car.driver.code === 'ZDR', 'the timing tower code is the player’s', car.driver.code);
  check(car.driver.raceNumber === NUMBER,
    'the number on the car is the player’s', String(car.driver.raceNumber));
  check(car.driver.nationality === NATIONALITY,
    'the flag the boards draw is the player’s', car.driver.nationality);
  check(car.team.id === career.state.teamId,
    'the livery on the car is the player’s team', car.team.name);
  check(car.isPlayer, 'the car is flagged as the player’s');
  // And exactly one is. Two cars answering to the player is how the qualifying
  // grid ended up with duplicate 'PLAYER' keys.
  check(engine.cars.filter((c) => c.isPlayer).length === 1,
    'exactly one car in the field is the player’s');
}

/**
 * The session is then RUN with `playerIndex: -1`, which is what
 * `HeadlessSession` does for a session the player skips: every car including
 * theirs is driven by the AI. It has to be -1 here for the obvious reason —
 * there is no human at this keyboard, and a car flagged as the player's with
 * nobody driving it sits in its garage for the whole session and sets no lap.
 * The field, the seat and the identity are the same; only the hands differ.
 */
const run = new RaceEngine(getCircuit(CIRCUIT), { ...config, playerIndex: -1 }, field);
for (let t = 0; t < config.durationS + 120; t++) {
  for (let i = 0; i < STEPS_PER_SECOND; i++) run.step();
}
console.log('        (' + run.participants.filter((c) => c.bestLapTime > 0).length +
  ' of ' + run.participants.length + ' cars set a time)');

const classified = run.participants
  .slice()
  .sort((a, b) => (a.bestLapTime || Infinity) - (b.bestLapTime || Infinity));
const inClassification = classified.findIndex((c) => c.driver.lastName === LAST);
const mineOnTrack = run.cars.find((c) => c.driver.id === career.state.playerDriverId);
check(inClassification >= 0,
  'the player appears in the session classification under their own name',
  'P' + (inClassification + 1));
check((mineOnTrack?.bestLapTime ?? 0) > 0,
  'the player’s car actually set a lap time',
  (mineOnTrack?.bestLapTime ?? 0).toFixed(3));
check(classified.filter((c) => c.driver.lastName === LAST).length === 1,
  'the player appears exactly once in the classification');

// ===========================================================================
// 4. The result reaches the championship, still named
// ===========================================================================

console.log('\nIdentity — the championship');

const order = classified.map((c) => c.driver.id);

const result: RoundResult = {
  round: career.round,
  circuitId: CIRCUIT,
  order,
  retired: [],
  disqualified: [],
  poleDriverId: order[0] ?? '',
  fastestLapDriverId: order[0] ?? '',
  wetRace: false,
  driven: true,
};
career.recordPlayerRound(result);

const table = sortedStandings(career.state.season.tiers[career.tier]);
const mine = table.find((e) => e.driverId === career.state.playerDriverId);
check(mine !== undefined, 'the player has a standings row');
check(career.displayName(career.state.playerDriverId) === FIRST + ' ' + LAST,
  'the standings render the player’s name',
  career.displayName(career.state.playerDriverId));
check(career.displayCode(career.state.playerDriverId) === 'ZDR',
  'the standings render the player’s code');
check(career.state.season.tiers[career.tier].results.length === 1,
  'the round is recorded in the season',
  String(career.state.season.tiers[career.tier].results.length));

// ===========================================================================
// 5. And it all survives a save
// ===========================================================================

console.log('\nIdentity — after a save and a reload');

const blob = encode(career.state);
const back = decode(blob);
check(back.ok, 'the save decodes', back.ok ? '' : back.reason);
if (back.ok) {
  const reloaded = new Career(back.state);
  const rme = reloaded.playerAsDriver();
  check(rme.firstName === FIRST && rme.lastName === LAST,
    'the name survives the round trip', rme.firstName + ' ' + rme.lastName);
  check(rme.code === 'ZDR', 'the code survives the round trip', rme.code);
  check(rme.raceNumber === NUMBER, 'the number survives the round trip');
  check(rme.nationality === NATIONALITY, 'the nationality survives the round trip');
  check(reloaded.state.teamId === career.state.teamId, 'the seat survives the round trip');
  check(reloaded.state.season.tiers[reloaded.tier].results.length === 1,
    'the RESULT survives the round trip',
    String(reloaded.state.season.tiers[reloaded.tier].results.length));

  const rfield = reloaded.grid();
  const rindex = playerIndexIn(rfield, reloaded.state.playerDriverId);
  check(rfield[rindex]?.lastName === LAST,
    'a session started from the reloaded save seats the player in their own car',
    rfield[rindex]?.firstName + ' ' + rfield[rindex]?.lastName);
}

console.log('');
if (failures > 0) {
  console.error(`probe:identity — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('probe:identity — the player is in their own car, under their own name.');
