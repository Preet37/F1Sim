/**
 * What ONE race looks like from inside the player's car.
 *
 * WHY THIS EXISTS, in the player's words: "there are too many accidents
 * happening and way too many penalties being given out ... real f1 drivers
 * don't crash that much ... it seems like every driver there had a penalty."
 *
 * Every other probe in this repository disagreed with that, and all of them
 * were measuring something else:
 *
 *   `probe:traffic`   contacts PER CAR-LAP, over the whole field. A rate that
 *                     small still multiplies out to something a player sees:
 *                     0.13 a car-lap is 0.13 x 20 x 14 = thirty-six contacts in
 *                     the race they actually sat through.
 *   `probe:attrition` survivors after FIVE laps. A player's race is fourteen,
 *                     or fifty-seven, and reliability is a per-race hazard, so
 *                     five laps sees roughly a tenth of the mechanicals a race
 *                     does.
 *   `probe:stewards`  penalties from THE STEWARDS' BENCH only. The bench is one
 *                     of five things in this codebase that can put a penalty on
 *                     a car — track limits, the pit lane speed limit, the
 *                     safety car delta and the unserved-penalty conversion are
 *                     the others — and nothing counted those at all. The badge
 *                     the player was looking at does not care which one issued
 *                     it.
 *
 * And all three measure a field the player has never raced against.
 * `SessionConfig.aiDifficulty` is optional and falls back to
 * `CALIBRATION_DIFFICULTY` = 'hard' — deliberately, so that adding a difficulty
 * menu could not silently re-baseline every lap-time check in the suite. But the
 * level a new player is GIVEN is 'medium', and that is a different field, not a
 * slower one. Measured here on one circuit, one seed, the same twenty cars:
 * Bahrain over fourteen laps gave 6 contacts and one penalised car on hard, 2
 * and none on easy, 0 and none on medium. So this probe takes the level as an
 * argument and defaults to the one the player has, and every number below is
 * quoted with the level it was measured at.
 *
 * So this one counts the things a person sitting in the cockpit can actually
 * see, per race rather than per car-lap, in the car and the grid slot they
 * actually occupy:
 *
 *   RETIREMENTS   how many cars are shown `Out`, and what killed them.
 *   CONTACTS      how many times any two cars touched, measured geometrically.
 *   PENALTIES     every penalty on every car at the flag, BY SOURCE, plus how
 *                 many separate cars carry one — which is the quantity the
 *                 timing tower's badge column renders and the one the player
 *                 was describing.
 *   THE PLAYER    all three again, restricted to their own car.
 *
 * against what a Grand Prix really produces: one or two retirements, and a
 * handful of penalties across twenty cars with many races producing none.
 *
 * ===========================================================================
 * WHAT IT FOUND, AND WHY THE RACE LENGTH CHANGES THE ANSWER
 * ===========================================================================
 *
 * The cause of a retirement is not the same at both distances, and measuring
 * only one of them points at the wrong fix.
 *
 *   QUARTER (14 laps)   retirements were MECHANICAL, and they were a bug:
 *                       `failureRate` is a per-race-distance probability that
 *                       was being spread per second over the session's own
 *                       theoretical lap time, so a quarter-distance race
 *                       carried a whole Grand Prix's reliability risk. Fixed in
 *                       `RaceEngine.checkReliability`; Silverstone went from
 *                       1.67 retirements a race, every one of them mechanical,
 *                       to none.
 *
 *   FULL (52 laps)      the picture inverts. Silverstone, F3, P18, medium:
 *                       SIXTEEN of twenty cars retired, of which THIRTEEN were
 *                       'Beached in the gravel' and none were mechanical. The
 *                       driven car was one of them.
 *
 * The beaching is the open problem and it is not the same problem as running
 * wide: the same race recorded only 3 sanctionable track-limit excursions, and
 * an excursion is only sanctionable if the car GAINED time. Thirteen cars that
 * beached while three gained time means the field is spinning off slowly rather
 * than running wide quickly, which is a path-tracking failure and not a
 * track-limits one. README already names the tracking controller as the single
 * largest outstanding item; this is what it costs, per race, in the seat.
 *
 * Run: npm run probe:racelog
 *      RACELOG_LAPS=full RACELOG_SEEDS=1,2,3 npm run probe:racelog
 *      RACELOG_DIFFICULTY=hard npm run probe:racelog   (what the harness sees)
 */

import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { PHYSICS_DT } from '../src/core/SimClock';
import { clearGrid } from '../src/data/teams';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import { raceLapsFor, DEFAULT_WEEKEND_OPTIONS, type RaceDistanceId } from '../src/race/WeekendFormat';
import { DEFAULT_AI_DIFFICULTY, type AIDifficultyId } from '../src/ai/AIVehicleController';

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

// ---------------------------------------------------------------------------
// The contact test, independent of the engine's own
// ---------------------------------------------------------------------------

/**
 * The same three-disc shape `RaceEngine.resolveContacts` resolves, and the same
 * hysteresis `probe:traffic` counts with, so the two numbers are the same
 * measurement at different denominators and can be compared directly.
 */
const DISC_R = 1.0;
const DISC_OFF = [1.85, 0, -1.85];
const TOUCH_M = DISC_R * 2;
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

// ---------------------------------------------------------------------------
// Which machine issued a penalty
// ---------------------------------------------------------------------------

/**
 * The penalty's SOURCE, recovered from its reason string.
 *
 * `Penalty` records a `kind` (what the punishment is) and a `reason` (what it
 * was for) and nothing that says which subsystem filed it, so the classifier
 * has to read the reason. Fragile in principle; in practice every issuing site
 * in `RaceControlManager` writes a fixed prefix, and getting one wrong shows up
 * immediately as an `other` bucket with a count in it.
 */
type PenaltySource = 'track limits' | 'pit lane' | 'sc delta' | 'stewards' | 'tyre rule' | 'other';

function sourceOf(reason: string): PenaltySource {
  const r = reason.toLowerCase();
  if (r.includes('track limits')) return 'track limits';
  if (r.includes('pit lane') || r.includes('unsafe release')) return 'pit lane';
  if (r.includes('delta')) return 'sc delta';
  if (r.includes('compound')) return 'tyre rule';
  if (r.includes('causing') || r.includes('forcing') || r.includes('leaving the track') ||
      r.includes('rejoin') || r.includes('advantage') || r.includes('collision') ||
      r.includes('impeding') || r.includes('position')) return 'stewards';
  return 'other';
}

// ---------------------------------------------------------------------------
// One race, watched
// ---------------------------------------------------------------------------

interface RaceLog {
  laps: number;
  /** Cars retired at the flag. */
  retired: number;
  retiredBy: Map<string, number>;
  /** Cars retired during lap 1. */
  retiredLap1: number;
  /** Distinct car-pair touches over the race. */
  contacts: number;
  /** ...of which happened on the opening lap. */
  contactsLap1: number;
  /** Every penalty on every car at the flag. */
  penalties: number;
  penaltiesBySource: Map<PenaltySource, number>;
  /** Verbatim reasons, numbers stripped, so the shape of them shows. */
  penaltyReasons: Map<string, number>;
  /** How many separate cars carry at least one penalty badge at the flag. */
  carsWithPenalty: number;
  /**
   * Sanctionable track-limit excursions, over the whole field.
   *
   * The input to most of the penalty count, and the quantity nothing measured.
   * `validate:limits` asserts WHERE the boundary is and that the rule fires at
   * it; how often twenty cars actually cross it in a race is a different
   * question and it is the one that decides what the tower looks like.
   */
  strikes: number;
  /** Laps completed by the whole field, for a per-car-lap rate. */
  carLaps: number;
  /**
   * Where each contact happened, as a corner name.
   *
   * "Nineteen contacts a race at Spa" and "nineteen contacts a race, twelve of
   * them at the same corner" are different bug reports and the total cannot
   * tell them apart — the same reason `probe:attrition` clusters retirements by
   * lap distance rather than counting them.
   */
  contactWhere: Map<string, number>;
  /** The player's car. */
  playerRetired: string;
  playerContacts: number;
  playerPenalties: number;
  /** Position at the flag, 1-based. */
  playerPosition: number;
}

/**
 * The badge the timing tower actually renders, evaluated on a car.
 *
 * Deliberately a copy of `statusBadges`' penalty clause rather than a call into
 * it: `src/ui` is not this probe's to depend on, and the point is to assert
 * that the tower's rule and the engine's ledger agree.
 */
function wearsBadge(car: CarEntry): boolean {
  return car.penaltySeconds > 0 || car.penalties.some((p) => !p.served);
}

function runRace(
  circuitId: string, tier: TierId, gridSlot: number, laps: number, seed: number,
  difficulty: AIDifficultyId,
): RaceLog {
  const def = getCircuit(circuitId);
  const field = raceSeats(world, tier).map(toDriver);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    // THE LEVEL THE PLAYER IS ACTUALLY RACING AT, which is not the one anything
    // else in this repository measures. `SessionConfig.aiDifficulty` defaults to
    // `CALIBRATION_DIFFICULTY` — 'hard', every multiplier at 1 — precisely so
    // that adding a difficulty menu could not re-baseline the validation
    // harness. The consequence is that the harness measures a field a default
    // save has never met, and the gap is large in both directions. Same
    // circuit, same seed, same twenty cars at Bahrain: 6 contacts and one car
    // penalised on hard, 2 and none on easy, 0 and none on medium. The
    // aggression scale is why — an easier field attacks less, so it touches
    // less — and it means a bound calibrated on hard is a bound nobody's race
    // is held to.
    aiDifficulty: difficulty,
    // -1, not `gridSlot`: nobody is at the wheel in a headless run, and the
    // player's own car is driven by the same AI as everyone else. What makes it
    // the player's race is the CAR — the tier's machinery, in the grid slot
    // they qualified in, with the traffic that slot sees.
    playerIndex: -1,
    standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config, field);
  const player = engine.cars[gridSlot];

  const touching = new Set<number>();
  const contactWhere = new Map<string, number>();
  let contacts = 0;
  let contactsLap1 = 0;
  let playerContacts = 0;
  const retiredBy = new Map<string, number>();
  const seenRetired = new Set<number>();
  let retiredLap1 = 0;

  const maxSteps = Math.round((laps * def.referencePoleTimeS * 3.2 + 180) / PHYSICS_DT);
  for (let i = 0; i < maxSteps && !engine.over; i++) {
    engine.step();

    for (const car of engine.cars) {
      if (!car.retired || seenRetired.has(car.index)) continue;
      seenRetired.add(car.index);
      retiredBy.set(car.retirementReason, (retiredBy.get(car.retirementReason) ?? 0) + 1);
      if (car.lap < 1) retiredLap1++;
    }

    if (i % 4 !== 0) continue;
    const n = engine.cars.length;
    for (let a = 0; a < n; a++) {
      const ca = engine.cars[a];
      if (ca.retired || ca.inPitBox) continue;
      for (let b = a + 1; b < n; b++) {
        const cb = engine.cars[b];
        if (cb.retired || cb.inPitBox || ca.inPitLane !== cb.inPitLane) continue;
        const key = a * 64 + b;
        const g = bodyGapM(ca, cb);
        if (g < TOUCH_M) {
          if (!touching.has(key)) {
            touching.add(key);
            contacts++;
            if (ca.lap < 1 || cb.lap < 1) contactsLap1++;
            if (a === gridSlot || b === gridSlot) playerContacts++;
            // Named where possible; otherwise the 100m box it happened in, so
            // contacts on a straight still cluster instead of scattering.
            const where = engine.track.cornerNameAt(ca.s) ||
              'straight @' + (Math.round(ca.s / 100) * 100) + 'm';
            contactWhere.set(where, (contactWhere.get(where) ?? 0) + 1);
          }
        } else if (g > CLEAR_M) {
          touching.delete(key);
        }
      }
    }
  }

  const penaltiesBySource = new Map<PenaltySource, number>();
  const penaltyReasons = new Map<string, number>();
  let penalties = 0;
  let carsWithPenalty = 0;
  let strikes = 0;
  let carLaps = 0;
  for (const car of engine.cars) {
    strikes += car.trackLimitStrikes;
    carLaps += car.lap;
    // A warning is not a penalty and does not put a badge on the tower.
    const real = car.penalties.filter((p) => p.kind !== 'track-limits-warning');
    penalties += real.length;
    for (const p of real) {
      const s = sourceOf(p.reason);
      penaltiesBySource.set(s, (penaltiesBySource.get(s) ?? 0) + 1);
      // Keep the shape of the reason, not its numbers — "Track limits xN at T"
      // is one kind of penalty however many times it happened.
      const shape = p.kind + ': ' + p.reason.replace(/[-0-9.]+/g, 'N');
      penaltyReasons.set(shape, (penaltyReasons.get(shape) ?? 0) + 1);
    }
    if (wearsBadge(car)) carsWithPenalty++;
  }

  return {
    laps,
    retired: engine.cars.filter((c) => c.retired).length,
    retiredBy,
    retiredLap1,
    contacts,
    contactsLap1,
    penalties,
    penaltiesBySource,
    penaltyReasons,
    carsWithPenalty,
    strikes,
    carLaps,
    contactWhere,
    playerRetired: player.retired ? player.retirementReason : '',
    playerContacts,
    playerPenalties: player.penalties.filter((p) => p.kind !== 'track-limits-warning').length,
    playerPosition: player.position,
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const world = createWorld(20260801);
installWorld(world);

/**
 * The race the report was about.
 *
 * A 14-lap race at a circuit whose full distance is in the mid fifties is the
 * 25% preset, and the tier and grid slot are the ones a career starts in: a
 * rookie's first Formula 3 seat, qualifying near the back. Nothing here is a
 * worst case — it is the default.
 */
const TIER: TierId = (process.env.RACELOG_TIER as TierId) ?? 'F3';
const GRID_SLOT = Number(process.env.RACELOG_SLOT ?? 17);
/**
 * Monza is in the default set on purpose, and it is the one that fails.
 *
 * It is where the penalty column the player described actually comes from: a
 * car beaches, the safety car comes out, and `checkNeutralisationDelta` then
 * issues a fresh five-second penalty to every car in the field on every one of
 * the twenty marshalling sectors it is judged quick in. Measured, two races:
 * 256 delta penalties, 15 of 20 cars carrying a badge at the flag, the driven
 * car holding twelve of them. A probe that passed while that was live would be
 * a probe that had been aimed away from the bug.
 */
const CIRCUITS = (process.env.RACELOG_CIRCUITS ?? 'bahrain,silverstone,spa,monza').split(',');
const SEEDS = (process.env.RACELOG_SEEDS ?? '20260729,20268648')
  .split(',').map((s) => Number(s.trim()));
/**
 * Quarter distance by default, and full distance on request.
 *
 * Not a shortcut. The 25% preset is the distance the report was about, and it
 * is the one where the numbers are worst per race — a quarter-distance race
 * used to carry a whole Grand Prix's reliability risk, and the opening lap is
 * four times as large a share of it. So the short race is the demanding case,
 * not the cheap one.
 *
 * It is also the only affordable one. Sixteen races, half of them 53 to 78
 * laps, is over two hours of wall clock on this machine, and a check nobody can
 * run is a check that gets deleted. `RACELOG_LAPS=full` runs the Grand Prix
 * comparison when it is wanted.
 */
const DISTANCES = (process.env.RACELOG_LAPS ?? 'quarter')
  .split(',') as RaceDistanceId[];
/** The level a new player is given, not the one the harness calibrates against. */
const DIFFICULTY = (process.env.RACELOG_DIFFICULTY as AIDifficultyId) ?? DEFAULT_AI_DIFFICULTY;

console.log('');
console.log(`THE RACE THE PLAYER DRIVES — ${TIER}, grid slot P${GRID_SLOT + 1}, ` +
  `AI on ${DIFFICULTY}, ${CIRCUITS.length} circuits x ${SEEDS.length} seeds`);
console.log('');

interface Agg {
  races: number; laps: number;
  retired: number; retiredLap1: number;
  contacts: number; contactsLap1: number;
  penalties: number; carsWithPenalty: number;
  strikes: number; carLaps: number;
  playerOut: number; playerContacts: number; playerPenalties: number;
  bySource: Map<PenaltySource, number>;
  byReason: Map<string, number>;
  /** Verbatim penalty reasons, numbers stripped, so the shape of them shows. */
  byPenaltyReason: Map<string, number>;
  contactWhere: Map<string, number>;
  worstRetired: number; worstPenalisedCars: number;
}

function emptyAgg(): Agg {
  return {
    races: 0, laps: 0, retired: 0, retiredLap1: 0, contacts: 0, contactsLap1: 0,
    penalties: 0, carsWithPenalty: 0, strikes: 0, carLaps: 0,
    playerOut: 0, playerContacts: 0, playerPenalties: 0,
    bySource: new Map(), byReason: new Map(), byPenaltyReason: new Map(),
    contactWhere: new Map(), worstRetired: 0, worstPenalisedCars: 0,
  };
}

const perDistance = new Map<RaceDistanceId, Agg>();

for (const distance of DISTANCES) {
  const agg = emptyAgg();
  perDistance.set(distance, agg);

  for (const circuitId of CIRCUITS) {
    const def = getCircuit(circuitId);
    const laps = raceLapsFor(def.raceLaps, { ...DEFAULT_WEEKEND_OPTIONS, raceDistance: distance });
    for (const seed of SEEDS) {
      const t0 = Date.now();
      const log = runRace(circuitId, TIER, GRID_SLOT, laps, seed, DIFFICULTY);
      agg.races++;
      agg.laps += laps;
      agg.retired += log.retired;
      agg.retiredLap1 += log.retiredLap1;
      agg.contacts += log.contacts;
      agg.contactsLap1 += log.contactsLap1;
      agg.penalties += log.penalties;
      agg.carsWithPenalty += log.carsWithPenalty;
      agg.strikes += log.strikes;
      agg.carLaps += log.carLaps;
      if (log.playerRetired) agg.playerOut++;
      agg.playerContacts += log.playerContacts;
      agg.playerPenalties += log.playerPenalties;
      for (const [s, n] of log.penaltiesBySource) agg.bySource.set(s, (agg.bySource.get(s) ?? 0) + n);
      for (const [r, n] of log.penaltyReasons) {
        agg.byPenaltyReason.set(r, (agg.byPenaltyReason.get(r) ?? 0) + n);
      }
      for (const [r, n] of log.retiredBy) agg.byReason.set(r, (agg.byReason.get(r) ?? 0) + n);
      for (const [w, n] of log.contactWhere) {
        agg.contactWhere.set(w, (agg.contactWhere.get(w) ?? 0) + n);
      }
      agg.worstRetired = Math.max(agg.worstRetired, log.retired);
      agg.worstPenalisedCars = Math.max(agg.worstPenalisedCars, log.carsWithPenalty);

      console.log(
        `  ${distance.padEnd(8)}${def.name.padEnd(14)}${(laps + ' laps').padStart(9)}` +
        `  seed ${String(seed).padEnd(10)}` +
        `${(log.retired + ' out').padStart(8)}` +
        `${(log.contacts + ' contacts').padStart(14)}` +
        `${(log.carsWithPenalty + '/20 penalised').padStart(17)}` +
        `${(log.strikes + ' off-track').padStart(14)}` +
        `   player P${log.playerPosition}` +
        (log.playerRetired ? ' OUT (' + log.playerRetired + ')' : '') +
        `, ${log.playerContacts} contact${log.playerContacts === 1 ? '' : 's'}` +
        `, ${log.playerPenalties} pen` +
        `   [${((Date.now() - t0) / 1000).toFixed(0)}s]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

console.log('');
console.log('PER RACE, AND WHAT A GRAND PRIX PRODUCES');
console.log('  ' + 'DISTANCE'.padEnd(10) + 'RETIRED'.padStart(9) + 'CONTACTS'.padStart(10) +
  'PENALTIES'.padStart(11) + 'CARS WITH ONE'.padStart(15) + '   PLAYER (out / contacts / pen)');
for (const [distance, a] of perDistance) {
  const per = (n: number) => (n / Math.max(1, a.races)).toFixed(2);
  console.log(
    '  ' + distance.padEnd(10) +
    per(a.retired).padStart(9) +
    per(a.contacts).padStart(10) +
    per(a.penalties).padStart(11) +
    per(a.carsWithPenalty).padStart(15) +
    '   ' + (a.playerOut / a.races * 100).toFixed(0) + '% / ' +
    per(a.playerContacts) + ' / ' + per(a.playerPenalties),
  );
}

console.log('');
console.log('  the real sport, per Grand Prix:   1-2 retired,  ~1-3 penalties across 20 cars');
// The mean is not what a player complains about. They complain about the race
// they sat through, and the report this probe exists for was a screenshot of
// one race — so the worst of the sweep is quoted beside the average.
for (const [distance, a] of perDistance) {
  console.log(`  worst single ${distance} race:      ${a.worstRetired} retired, ` +
    `${a.worstPenalisedCars} of 20 carrying a penalty`);
}

for (const [distance, a] of perDistance) {
  console.log('');
  console.log(`  ${distance.toUpperCase()} — where the retirements went (${a.retired} over ${a.races} races)`);
  for (const [reason, n] of [...a.byReason].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${String(n).padStart(4)}  ${reason}   (${(n / a.races).toFixed(2)} a race)`);
  }
  console.log(`    of which lost on the opening lap: ${(a.retiredLap1 / a.races).toFixed(2)} a race`);
  console.log(`  ${distance.toUpperCase()} — who issued the penalties (${a.penalties} over ${a.races} races)`);
  for (const [source, n] of [...a.bySource].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${String(n).padStart(4)}  ${source}   (${(n / a.races).toFixed(2)} a race)`);
  }
  for (const [reason, n] of [...a.byPenaltyReason].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
    console.log(`        ${String(n).padStart(4)}  ${reason}`);
  }
  console.log(`  ${distance.toUpperCase()} — contacts on the opening lap: ` +
    `${(a.contactsLap1 / a.races).toFixed(2)} of ${(a.contacts / a.races).toFixed(2)} a race`);
  const where = [...a.contactWhere].sort((x, y) => y[1] - x[1]).slice(0, 8);
  for (const [w, n] of where) {
    console.log(`        ${String(n).padStart(4)}  ${w}   (${(n / a.races).toFixed(1)} a race)`);
  }
  // The input to the penalty column. A real Grand Prix produces a handful of
  // sanctionable excursions across twenty cars over a whole race — well under
  // 0.02 a car-lap — and the number above about a tenth of that is what turns
  // the ladder in `onTrackLimitInfraction` into a stream of five-second
  // penalties, because every excursion past the fourth is another one.
  console.log(`  ${distance.toUpperCase()} — sanctionable excursions: ` +
    `${(a.strikes / a.races).toFixed(1)} a race = ` +
    `${(a.strikes / Math.max(1, a.carLaps)).toFixed(3)} a car-lap`);
}

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * What a race is allowed to look like.
 *
 * These are per RACE, which is the unit the player perceives, and they are set
 * against the sport rather than against the previous measurement. A Grand Prix
 * loses one or two cars; three is a bad day and five is a headline. Penalties
 * are handed to a handful of cars at most, and the great majority of the field
 * finishes without one — so the assertion is on HOW MANY CARS CARRY A BADGE,
 * not on the penalty count, because two penalties on one car look like one
 * penalised driver on the tower and twelve penalties spread over twelve cars
 * look like the thing the player complained about.
 *
 * Deliberately generous rather than tight: a bound that fails on noise gets
 * disabled, and these have six races behind them at the default sweep.
 */
const MAX_RETIRED_PER_RACE = 3.0;
const MAX_PENALISED_CARS_PER_RACE = 4.0;
const MAX_CONTACTS_PER_RACE = 12.0;
/**
 * Sanctionable track-limit excursions per car-lap.
 *
 * Derived from the ladder rather than picked. `onTrackLimitInfraction` warns on
 * the first two, shows a black-and-white flag on the third and issues a five
 * second penalty on the FOURTH and on every one after it. So the rate at which
 * the field leaves the road becomes a penalty rate at exactly the point where
 * the average car reaches four excursions over a Grand Prix — four over the
 * longest race on the calendar is 4/53, and above it the ladder starts
 * converting an ordinary lap into a stream of penalties for half the field.
 *
 * Which is also roughly where the sport sits: Austria 2023, the worst day the
 * rule has ever had, produced about eighty sanctionable excursions over 71 laps
 * and 20 cars — 0.06 a car-lap — and an ordinary Grand Prix is an order of
 * magnitude below that. Two independent derivations landing in the same place
 * is the reason to trust the number.
 */
const MAX_STRIKES_PER_CAR_LAP = 4 / 53;

for (const [distance, a] of perDistance) {
  const retired = a.retired / a.races;
  const penalised = a.carsWithPenalty / a.races;
  const contacts = a.contacts / a.races;
  check(retired <= MAX_RETIRED_PER_RACE,
    `${distance}: ${retired.toFixed(2)} cars retire per race — a Grand Prix loses one or two`);
  check(penalised <= MAX_PENALISED_CARS_PER_RACE,
    `${distance}: ${penalised.toFixed(2)} of 20 cars finish carrying a penalty — ` +
    `"it seems like every driver there had a penalty"`);
  check(contacts <= MAX_CONTACTS_PER_RACE,
    `${distance}: ${contacts.toFixed(2)} car-to-car contacts a race — the field is fighting itself`);
  const strikeRate = a.strikes / Math.max(1, a.carLaps);
  check(strikeRate <= MAX_STRIKES_PER_CAR_LAP,
    `${distance}: ${strikeRate.toFixed(3)} sanctionable excursions a car-lap ` +
    `(${(a.strikes / a.races).toFixed(1)} a race) — the field cannot stay on the road`);
}

// A field that never touches anybody is the other failure, and it is just as
// wrong: "i can understand how occasionally things happen". Asserted across the
// whole sweep, and only once the sweep is long enough for the claim to mean
// something — zero contacts in one short race is an ordinary race, and a floor
// that fires on that is a floor nobody will keep.
{
  let anyContacts = 0;
  let races = 0;
  for (const a of perDistance.values()) { anyContacts += a.contacts; races += a.races; }
  if (races >= 4) {
    check(anyContacts > 0,
      `not one car touched another in ${races} races — the field has stopped racing`);
  }
}

clearGrid();

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('PASS — a race looks like a race.');
}
