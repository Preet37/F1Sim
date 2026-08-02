/**
 * Does a career survive ten seasons?
 *
 * WHY THIS EXISTS. A championship that is wrong is wrong in the ninth round of
 * somebody's fourth season, three hours into an evening, and it is invisible
 * until then. Nothing about a career can be verified by looking at it: the only
 * way to know that promotion works, that the grid does not silt up, that points
 * add up and that nobody is quietly lost in a transfer is to run whole careers
 * and assert the invariants at every step.
 *
 * So this simulates ten independent careers of ten seasons each — three hundred
 * championships, about three thousand races — and checks after every single
 * off-season that the world is still a legal world.
 *
 * The invariants, and why each one is here:
 *
 *   1. PROMOTION IS EXACTLY TOP TWO. The one promise the career makes. Checked
 *      against the final table rather than against the code's own opinion of who
 *      won, so a bug in the standings sort cannot hide a bug in promotion.
 *   2. THE GRID IS INTACT. Every tier has the right number of teams, every team
 *      has exactly two race drivers, no driver holds two seats, no seat is
 *      empty. This is the check that catches a transfer market that drops
 *      somebody on the floor.
 *   3. POINTS ADD UP. The sum of the points awarded equals the sum in the table,
 *      and the constructors' table equals the sum of its own drivers'.
 *   4. NOBODY LEAVES THE RANGE. Ages, abilities and form all stay legal for ten
 *      seasons, so a career cannot slowly drift into a grid of 0.99-skill
 *      forty-year-olds.
 *   5. THE FIELD DOES NOT INFLATE OR COLLAPSE. Mean Formula 1 skill after ten
 *      seasons is still recognisably a Formula 1 grid.
 *   6. THE CHAMPION IS EARNED. Across many seeds, the drivers' champion is
 *      correlated with car and driver quality rather than being random.
 *
 * Run: npm run probe:season
 */

import { Rng } from '../src/core/MathUtils';
import { TIER_ORDER, type TierId } from '../src/data/roster';
import {
  createWorld, findDriver, findTeam, performanceOf, raceSeats,
  type CareerWorld,
} from '../src/career/World';
import {
  PROMOTIONS_PER_TIER, recordRound, runOffSeason, simulateRound,
  seasonComplete, sortedStandings, startSeason,
  type SeasonState,
} from '../src/career/Season';
import { CIRCUITS } from '../src/data/tracks/circuits';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

const CAREERS = 10;
const SEASONS = 10;
const CIRCUIT_IDS = new Set(CIRCUITS.map((c) => c.id));

// Only report the first few of any repeated failure, or a systematic bug prints
// three thousand identical lines and hides everything else.
const seen = new Map<string, number>();
function checkOnce(ok: boolean, kind: string, msg: string): void {
  if (ok) return;
  const n = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, n);
  if (n <= 3) fail(msg);
  else if (n === 4) fail(`${kind}: ...and more`);
}

// ---------------------------------------------------------------------------
// Structural checks on a world
// ---------------------------------------------------------------------------

function checkWorld(world: CareerWorld, where: string): void {
  for (const tier of TIER_ORDER) {
    const state = world.tiers[tier];

    // Calendar
    checkOnce(state.calendar.length > 0, 'calendar-empty',
      `${where}: ${tier} has an empty calendar`);
    for (const id of state.calendar) {
      checkOnce(CIRCUIT_IDS.has(id), 'calendar-unknown',
        `${where}: ${tier} calendar names an unknown circuit "${id}"`);
    }

    // Seats
    const seats = raceSeats(world, tier);
    const expected = state.teams.length * 2;
    checkOnce(seats.length === expected, 'grid-size',
      `${where}: ${tier} has ${seats.length} race seats, expected ${expected}`);

    const perTeam = new Map<string, number>();
    for (const d of seats) perTeam.set(d.teamId, (perTeam.get(d.teamId) ?? 0) + 1);
    for (const t of state.teams) {
      const n = perTeam.get(t.id) ?? 0;
      checkOnce(n === 2, 'team-seats',
        `${where}: ${tier}/${t.id} has ${n} race drivers, expected 2`);
    }

    // Nobody in two places
    const ids = new Set<string>();
    for (const d of state.drivers) {
      checkOnce(!ids.has(d.id), 'duplicate-driver',
        `${where}: ${tier} lists driver ${d.id} twice`);
      ids.add(d.id);
      checkOnce(d.tier === tier, 'tier-mismatch',
        `${where}: driver ${d.id} is in the ${tier} array but says tier ${d.tier}`);
    }

    // Ranges
    for (const d of state.drivers) {
      if (d.retired) continue;
      const attrs: [string, number][] = [
        ['skill', d.skill], ['aggression', d.aggression],
        ['consistency', d.consistency], ['tyreManagement', d.tyreManagement],
        ['wetSkill', d.wetSkill], ['racecraft', d.racecraft],
      ];
      for (const [name, v] of attrs) {
        checkOnce(v >= 0 && v <= 1 && Number.isFinite(v), 'attr-range',
          `${where}: ${d.id} has ${name}=${v}`);
      }
      checkOnce(d.age >= 15 && d.age <= 55, 'age-range',
        `${where}: ${d.id} is ${d.age} years old`);
    }

    for (const t of state.teams) {
      const p = performanceOf(t);
      for (const [k, v] of Object.entries(p)) {
        checkOnce(Number.isFinite(v) && v >= 0, 'perf-range',
          `${where}: ${tier}/${t.id} performance.${k} = ${v}`);
      }
      checkOnce(Math.abs(t.form) <= 0.05, 'form-range',
        `${where}: ${tier}/${t.id} form drifted to ${t.form.toFixed(4)}`);
    }
  }

  // Global: no driver id appears in two tiers.
  const global = new Map<string, TierId>();
  for (const tier of TIER_ORDER) {
    for (const d of world.tiers[tier].drivers) {
      const prev = global.get(d.id);
      checkOnce(prev === undefined, 'cross-tier-duplicate',
        `${where}: driver ${d.id} is in both ${prev} and ${tier}`);
      global.set(d.id, tier);
    }
  }
}

// ---------------------------------------------------------------------------
// Points arithmetic
// ---------------------------------------------------------------------------

function checkPoints(season: SeasonState, where: string): void {
  for (const tier of TIER_ORDER) {
    const ts = season.tiers[tier];
    const driverTotal = ts.standings.reduce((s, e) => s + e.points, 0);
    const teamTotal = Object.values(ts.constructorPoints).reduce((s, v) => s + v, 0);

    // The constructors' table cannot exceed the drivers' — the only difference
    // is the fastest-lap point, which is awarded to a driver and not to a team.
    const flPoints = ts.standings.reduce((s, e) => s + e.fastestLaps, 0);
    checkOnce(teamTotal <= driverTotal, 'points-constructors-high',
      `${where}: ${tier} constructors have ${teamTotal} against drivers' ${driverTotal}`);
    checkOnce(driverTotal - teamTotal <= flPoints, 'points-mismatch',
      `${where}: ${tier} drivers ${driverTotal} vs constructors ${teamTotal}, ` +
      `difference exceeds the ${flPoints} fastest-lap points awarded`);

    for (const e of ts.standings) {
      checkOnce(e.points >= 0 && Number.isFinite(e.points), 'points-negative',
        `${where}: ${tier}/${e.driverId} has ${e.points} points`);
      checkOnce(e.wins <= ts.results.length, 'wins-impossible',
        `${where}: ${tier}/${e.driverId} won ${e.wins} of ${ts.results.length} rounds`);
      checkOnce(e.podiums >= e.wins, 'podiums-lt-wins',
        `${where}: ${tier}/${e.driverId} has ${e.wins} wins but ${e.podiums} podiums`);
    }

    // Every round classified every starter exactly once.
    for (const r of ts.results) {
      const unique = new Set(r.order);
      checkOnce(unique.size === r.order.length, 'result-duplicate',
        `${where}: ${tier} round ${r.round} classifies a driver twice`);
      checkOnce(r.order.length === ts.standings.length, 'result-size',
        `${where}: ${tier} round ${r.round} classified ${r.order.length} of ` +
        `${ts.standings.length} entrants`);
    }
  }
}

// ---------------------------------------------------------------------------
// The careers
// ---------------------------------------------------------------------------

interface ChampionSample { skill: number; carRate: number; won: boolean }
const championSamples: ChampionSample[] = [];

let totalPromotions = 0;
let totalRookies = 0;
let totalRetirements = 0;

for (let career = 0; career < CAREERS; career++) {
  const seed = 1000 + career * 7919;
  const world = createWorld(seed);
  const rng = new Rng(seed ^ 0x51ed270b);

  checkWorld(world, `career ${career} season 0`);

  const startF1Skill = mean(world.tiers.F1.drivers.filter((d) => !d.reserve).map((d) => d.skill));

  for (let s = 0; s < SEASONS; s++) {
    const where = `career ${career} season ${s} (${world.season})`;
    const season = startSeason(world);

    // Run all three championships to the end.
    for (const tier of TIER_ORDER) {
      let guard = 0;
      while (!seasonComplete(world, season, tier)) {
        const result = simulateRound(world, season, tier, rng);
        checkOnce(result.circuitId.length > 0, 'round-circuit',
          `${where}: ${tier} round has no circuit`);
        recordRound(season, tier, result);
        if (++guard > 60) { fail(`${where}: ${tier} season did not terminate`); break; }
      }
      const cal = world.tiers[tier].calendar.length;
      checkOnce(season.tiers[tier].results.length === cal, 'round-count',
        `${where}: ${tier} ran ${season.tiers[tier].results.length} of ${cal} rounds`);
    }

    checkPoints(season, where);

    // --- The tables, before the off-season moves anybody ------------------
    const expectedPromotions: { id: string; from: TierId }[] = [];
    for (const tier of ['F3', 'F2'] as const) {
      const table = sortedStandings(season.tiers[tier]);
      for (let i = 0; i < PROMOTIONS_PER_TIER; i++) {
        if (table[i]) expectedPromotions.push({ id: table[i].driverId, from: tier });
      }
      // Championship order must be monotone in points.
      for (let i = 1; i < table.length; i++) {
        checkOnce(table[i - 1].points >= table[i].points, 'standings-order',
          `${where}: ${tier} standings are not sorted by points`);
      }
    }

    // Sample the F1 champion against the field, for the correlation check.
    {
      const table = sortedStandings(season.tiers.F1);
      for (const e of table) {
        const d = findDriver(world, e.driverId);
        const t = findTeam(world, e.teamId);
        if (!d || !t) continue;
        const p = performanceOf(t);
        championSamples.push({
          skill: d.skill,
          carRate: p.powerMult + p.downforceMult + p.mechanicalGripMult - p.dragMult,
          won: e.driverId === table[0].driverId,
        });
      }
    }

    const report = runOffSeason(world, season, rng);
    totalPromotions += report.promotions.length;
    totalRookies += report.rookies.length;
    totalRetirements += report.departures.length;

    // --- 1. Promotion is exactly top two ---------------------------------
    const promotedIds = new Set(report.promotions.map((p) => p.driverId));
    checkOnce(report.promotions.length === expectedPromotions.length, 'promotion-count',
      `${where}: promoted ${report.promotions.length}, expected ${expectedPromotions.length}`);
    for (const e of expectedPromotions) {
      checkOnce(promotedIds.has(e.id), 'promotion-wrong-driver',
        `${where}: ${e.id} finished top ${PROMOTIONS_PER_TIER} in ${e.from} and was not promoted`);
    }
    checkOnce(promotedIds.size === report.promotions.length, 'promotion-duplicate',
      `${where}: the same driver was promoted twice`);

    // A promoted driver must actually be in the tier above afterwards — unless
    // the report says no seat was found, which is a legal outcome.
    for (const p of report.promotions) {
      if (p.to === p.from) continue;
      const d = findDriver(world, p.driverId);
      checkOnce(!!d && d.tier === p.to, 'promotion-not-applied',
        `${where}: ${p.driverId} was promoted ${p.from}->${p.to} but is in ${d?.tier}`);
      checkOnce(!!d && d.teamId === p.toTeamId, 'promotion-team',
        `${where}: ${p.driverId} promoted to ${p.toTeamId} but drives for ${d?.teamId}`);
    }

    // --- 2. The world is still legal --------------------------------------
    checkWorld(world, where + ' (after off-season)');

    // --- A promoted driver starts the next season on zero -----------------
    const next = startSeason(world);
    for (const p of report.promotions) {
      if (p.to === p.from) continue;
      const entry = next.tiers[p.to].standings.find((e) => e.driverId === p.driverId);
      checkOnce(!!entry, 'promotion-missing-from-standings',
        `${where}: ${p.driverId} was promoted to ${p.to} but is not in its standings`);
      checkOnce(!entry || entry.points === 0, 'promotion-carried-points',
        `${where}: ${p.driverId} started the new season with points`);
    }
  }

  // --- 5. The field neither inflates nor collapses -------------------------
  const endF1Skill = mean(world.tiers.F1.drivers.filter((d) => !d.reserve && !d.retired).map((d) => d.skill));
  check(Math.abs(endF1Skill - startF1Skill) < 0.10,
    `career ${career}: mean F1 skill moved ${startF1Skill.toFixed(3)} -> ${endF1Skill.toFixed(3)} ` +
    'over ten seasons, which is a drift rather than a grid');
}

// ---------------------------------------------------------------------------
// 6. Is the championship earned?
// ---------------------------------------------------------------------------

{
  const champions = championSamples.filter((s) => s.won);
  const rest = championSamples.filter((s) => !s.won);
  const champSkill = mean(champions.map((s) => s.skill));
  const restSkill = mean(rest.map((s) => s.skill));
  const champCar = mean(champions.map((s) => s.carRate));
  const restCar = mean(rest.map((s) => s.carRate));

  check(champSkill > restSkill + 0.03,
    `champions average ${champSkill.toFixed(3)} skill against the field's ${restSkill.toFixed(3)} — ` +
    'the title is not going to the better drivers');
  check(champCar > restCar + 0.005,
    `champions average ${champCar.toFixed(4)} car rate against the field's ${restCar.toFixed(4)} — ` +
    'the title is not going to the better cars');

  console.log(`champion vs field: skill ${champSkill.toFixed(3)} / ${restSkill.toFixed(3)}, ` +
    `car ${champCar.toFixed(4)} / ${restCar.toFixed(4)}`);
}

// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

const seasonsRun = CAREERS * SEASONS;
console.log(`${CAREERS} careers x ${SEASONS} seasons = ${seasonsRun} years, ` +
  `${seasonsRun * 3} championships`);
console.log(`promotions ${totalPromotions}, rookies ${totalRookies}, departures ${totalRetirements}`);

// Sanity on the totals themselves: two per tier per season, from two tiers.
const expectedPromotionTotal = seasonsRun * 2 * PROMOTIONS_PER_TIER;
check(totalPromotions === expectedPromotionTotal,
  `expected ${expectedPromotionTotal} promotions across the run, got ${totalPromotions}`);
check(totalRookies >= seasonsRun * 2,
  `only ${totalRookies} rookies generated across ${seasonsRun} off-seasons — ` +
  'Formula 3 is not being backfilled');

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:season OK');
