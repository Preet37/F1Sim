import { clamp01, Rng } from '../core/MathUtils';
import { TIER_ORDER, tierAbove, type TierId } from '../data/roster';
import {
  TIER_CAR, ageDrivers, expireContracts, findDriver, findTeam, performanceOf,
  raceSeats,
  rollOffSeasonForm, transfer,
  type CareerWorld, type WorldDriver, type WorldTeam,
} from './World';

/**
 * Championships, results and the off-season.
 *
 * All three tiers are run EVERY season, whether or not the player is in them.
 * That is the difference between a ladder and a backdrop: when the player is
 * promoted to Formula 2, the two drivers who come up from Formula 3 alongside
 * them are drivers who actually won a Formula 3 season that was simulated, in
 * cars whose performance the same physics would have produced. A career that
 * only simulated the player's own championship would have to invent its
 * promotions, and invented promotions are the thing that makes a career mode
 * feel like a menu.
 *
 * The player's own races are driven, and the other two championships — plus any
 * round the player chooses to skip — are resolved by `simulateRound` below.
 * Both paths read the same `performanceOf` and the same driver attributes, so a
 * skipped season and a driven one produce the same kind of table.
 */

// ===========================================================================
// State
// ===========================================================================

export interface StandingsEntry {
  driverId: string;
  teamId: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  /** Best finish so far, for tie-breaking and for the UI. */
  bestFinish: number;
}

export interface RoundResult {
  round: number;
  circuitId: string;
  /** Driver ids in classified order: classified, then retired, then disqualified. */
  order: string[];
  /** Ids of drivers who did not finish. */
  retired: string[];
  /**
   * Ids of drivers excluded from the results.
   *
   * SEPARATE FROM `retired`, because the 2026 regulations make them separate
   * outcomes and the race engine now models both. A retired car did not cover
   * the distance; a disqualified one may well have won on the road and been
   * excluded afterwards. Both score nothing, but only one of them is a DNF, and
   * conflating them would put a disqualification in a driver's retirement count
   * — which is the statistic a career screen shows to say how reliable their car
   * has been.
   *
   * Optional because it was added after the save format shipped. `recordRound`
   * treats a missing list as empty, and the codec's minor-version rule means a
   * career written before this field existed still loads.
   */
  disqualified?: string[];
  poleDriverId: string;
  fastestLapDriverId: string;
  wetRace: boolean;
  /** True when the player drove this one rather than it being simulated. */
  driven: boolean;
}

export interface TierSeason {
  tier: TierId;
  /** Index of the next round to run. Equals the calendar length when complete. */
  round: number;
  standings: StandingsEntry[];
  constructorPoints: Record<string, number>;
  results: RoundResult[];
}

export interface SeasonState {
  year: number;
  tiers: Record<TierId, TierSeason>;
}

/** One completed season, kept for the career's history. Deliberately compact. */
export interface SeasonSummary {
  year: number;
  /** Champion driver id per tier. */
  championByTier: Record<string, string>;
  /** Constructors' champion team id per tier. */
  constructorByTier: Record<string, string>;
  /** The player's tier, position and points, if they were racing. */
  playerTier: TierId | null;
  playerPosition: number;
  playerPoints: number;
  playerTeamId: string;
  promoted: boolean;
}

// ===========================================================================
// Starting a season
// ===========================================================================

function blankEntry(driverId: string, teamId: string): StandingsEntry {
  return {
    driverId, teamId, points: 0, wins: 0, podiums: 0,
    poles: 0, fastestLaps: 0, dnfs: 0, bestFinish: 99,
  };
}

/** Fresh standings for every tier, from whoever currently holds a race seat. */
export function startSeason(world: CareerWorld): SeasonState {
  const tiers = {} as Record<TierId, TierSeason>;
  for (const tier of TIER_ORDER) {
    const seats = raceSeats(world, tier);
    tiers[tier] = {
      tier,
      round: 0,
      standings: seats.map((d) => blankEntry(d.id, d.teamId)),
      constructorPoints: Object.fromEntries(
        world.tiers[tier].teams.map((t) => [t.id, 0]),
      ),
      results: [],
    };
  }
  return { year: world.season, tiers };
}

export function seasonComplete(world: CareerWorld, season: SeasonState, tier: TierId): boolean {
  return season.tiers[tier].round >= world.tiers[tier].calendar.length;
}

export function circuitFor(world: CareerWorld, season: SeasonState, tier: TierId): string {
  const cal = world.tiers[tier].calendar;
  return cal[Math.min(season.tiers[tier].round, cal.length - 1)];
}

// ===========================================================================
// Recording a result
// ===========================================================================

/**
 * Folds a round into the championship.
 *
 * The same function whichever way the result was produced — driven or simulated
 * — so the two paths cannot award points differently. That is not a stylistic
 * preference: the previous version of this game had a driven race and a skipped
 * race build their `SeasonResult` in two different places, and any divergence
 * between them would have been invisible until a championship came out wrong in
 * the ninth round of somebody's season.
 */
export function recordRound(
  season: SeasonState, tier: TierId, result: RoundResult,
): void {
  const ts = season.tiers[tier];
  const points = TIER_CAR[tier].points;
  const retired = new Set(result.retired);
  const excluded = new Set(result.disqualified ?? []);

  for (let i = 0; i < result.order.length; i++) {
    const id = result.order[i];
    const entry = ts.standings.find((e) => e.driverId === id);
    if (!entry) continue;

    // A disqualified driver scores nothing but has not retired, so it is not
    // counted against their reliability. The race engine sorts both behind the
    // classified runners, so neither can take a points-paying position from
    // somebody who finished.
    if (excluded.has(id)) continue;

    const dnf = retired.has(id);
    if (dnf) {
      entry.dnfs++;
      continue;
    }

    const pos = i + 1;
    const pts = i < points.length ? points[i] : 0;
    entry.points += pts;
    if (pos < entry.bestFinish) entry.bestFinish = pos;
    if (pos === 1) entry.wins++;
    if (pos <= 3) entry.podiums++;
    if (id === result.poleDriverId) entry.poles++;
    if (id === result.fastestLapDriverId) {
      entry.fastestLaps++;
      // A point for the fastest lap, only inside the top ten — the current rule.
      if (TIER_CAR[tier].fastestLapPoint && pos <= 10) entry.points += 1;
    }

    ts.constructorPoints[entry.teamId] = (ts.constructorPoints[entry.teamId] ?? 0) + pts;
  }

  ts.results.push(result);
  ts.round++;
}

/**
 * Championship order.
 *
 * Points, then wins, then the count of each subsequent finishing position — the
 * real countback. Implemented down to podiums and best finish, which resolves
 * every tie a season of this length can actually produce.
 */
export function sortedStandings(ts: TierSeason): StandingsEntry[] {
  return ts.standings.slice().sort((a, b) =>
    b.points - a.points
    || b.wins - a.wins
    || b.podiums - a.podiums
    || a.bestFinish - b.bestFinish
    || a.driverId.localeCompare(b.driverId));
}

export function positionOf(ts: TierSeason, driverId: string): number {
  return sortedStandings(ts).findIndex((e) => e.driverId === driverId) + 1;
}

// ===========================================================================
// Simulating a round
// ===========================================================================

/**
 * Resolves a round on paper.
 *
 * Used for the two championships the player is not in, and for any round they
 * choose to skip. It reads `performanceOf` — the same record the physics turns
 * into a spec — so a car that is fast in a driven race is fast here too, and the
 * two cannot drift apart as the career changes the cars.
 *
 * The weighting between car and driver is the one real results show: the car
 * matters more, but not so much more that a great driver in a poor car never
 * beats a poor driver in a good one.
 */
export function simulateRound(
  world: CareerWorld, season: SeasonState, tier: TierId, rng: Rng,
  opts: { wet?: boolean } = {},
): RoundResult {
  const ts = season.tiers[tier];
  const circuitId = circuitFor(world, season, tier);
  const wet = opts.wet ?? rng.chance(0.16);
  const seats = raceSeats(world, tier);

  interface Runner { id: string; teamId: string; score: number; quali: number }
  const runners: Runner[] = [];

  for (const d of seats) {
    const team = findTeam(world, d.teamId);
    if (!team) continue;
    const p = performanceOf(team);

    // A car's overall pace: the three multipliers that decide lap time, less a
    // penalty for drag, which is a cost rather than a benefit.
    const carPace = (p.powerMult + p.downforceMult + p.mechanicalGripMult) / 3
      - (p.dragMult - 1) * 0.15;

    const driverPace = wet
      ? d.wetSkill * 0.7 + d.skill * 0.3
      : d.skill;

    const base = carPace * 0.60 + driverPace * 0.36 + d.tyreManagement * 0.04;

    // Qualifying is a single lap: less tyre management, more raw pace, and a
    // smaller random component than a race distance has.
    const quali = carPace * 0.62 + d.skill * 0.38 + rng.gaussian(0, 0.020);

    // Consistency narrows the race-day spread. An inconsistent driver is not
    // slower on average, they are less predictable — which over a season costs
    // them, because the downside is a retirement and the upside is only a place.
    const spread = 0.040 * (1.4 - d.consistency * 0.6);
    runners.push({ id: d.id, teamId: d.teamId, score: base + rng.gaussian(0, spread), quali });
  }

  // Retirements: the team's own failure rate, plus a driver-error term that
  // rises in the wet and falls with consistency.
  const finishers: Runner[] = [];
  const retirements: Runner[] = [];
  for (const r of runners) {
    const team = findTeam(world, r.teamId);
    const mech = team ? performanceOf(team).failureRate : 0.04;
    const driver = findDriver(world, r.id);
    const errorRate = driver
      ? (1 - driver.consistency) * (wet ? 0.075 : 0.030)
      : 0.03;
    if (rng.chance(mech + errorRate)) retirements.push(r);
    else finishers.push(r);
  }

  finishers.sort((a, b) => b.score - a.score);
  // Retirements are classified behind the finishers, in the order they were
  // running, which is what a real classification does.
  retirements.sort((a, b) => b.score - a.score);

  const order = [...finishers.map((r) => r.id), ...retirements.map((r) => r.id)];

  const byQuali = runners.slice().sort((a, b) => b.quali - a.quali);
  const pole = byQuali.length > 0 ? byQuali[0].id : '';

  // The fastest lap is usually set by one of the quick cars, and often by
  // someone on a free stop late in the race — so it is drawn from the top few
  // finishers rather than always being the winner.
  const flPool = finishers.slice(0, Math.min(6, finishers.length));
  const fastest = flPool.length > 0 ? flPool[rng.int(0, flPool.length)].id : pole;

  return {
    round: ts.round,
    circuitId,
    order,
    retired: retirements.map((r) => r.id),
    poleDriverId: pole,
    fastestLapDriverId: fastest,
    wetRace: wet,
    driven: false,
  };
}

/** Runs a whole tier's remaining season on paper. */
export function simulateRestOfSeason(
  world: CareerWorld, season: SeasonState, tier: TierId, rng: Rng,
): void {
  let guard = 0;
  while (!seasonComplete(world, season, tier)) {
    recordRound(season, tier, simulateRound(world, season, tier, rng));
    if (++guard > 100) throw new Error('Season did not terminate in ' + tier);
  }
}

// ===========================================================================
// The off-season
// ===========================================================================

export interface Promotion {
  driverId: string;
  from: TierId;
  to: TierId;
  toTeamId: string;
  /** 1 for the champion, 2 for the runner-up. */
  championshipPosition: number;
}

export interface Departure {
  driverId: string;
  reason: 'retired' | 'dropped';
}

export interface Signing {
  driverId: string;
  teamId: string;
  tier: TierId;
  previousTeamId: string;
}

export interface OffSeasonReport {
  year: number;
  champions: { tier: TierId; driverId: string; teamId: string }[];
  constructorChampions: { tier: TierId; teamId: string }[];
  promotions: Promotion[];
  departures: Departure[];
  signings: Signing[];
  rookies: string[];
}

/**
 * How many drivers move up from each tier at the end of a season.
 *
 * TWO. This is the rule the whole career is built around and it has no
 * exceptions, no reputation gate and no discretion: finish first or second and
 * you go up, finish third and you do not, and that applies to the player exactly
 * as it applies to everybody else. The previous implementation promoted the
 * player on `won || (position <= 3 && reputation > 40)` and never promoted an AI
 * driver at all, which meant the ladder was a thing that happened to one person.
 */
export const PROMOTIONS_PER_TIER = 2;

/**
 * What a team thinks a driver is worth.
 *
 * Deliberately not "skill", because a paddock does not sign the fastest
 * available driver. It signs the one that fits: an established team with a
 * preference for experience will take the safe pair of hands over the quick
 * rookie, and a team with no money cannot take either.
 */
export function valuation(team: WorldTeam, d: WorldDriver): number {
  const pace = d.skill * 0.55 + d.racecraft * 0.15 + d.consistency * 0.15
    + d.tyreManagement * 0.08 + d.wetSkill * 0.07;
  const experienceBonus = Math.min(d.experience, 10) / 10 * team.prefersExperience * 0.18;
  // Youth is an asset to a team that develops drivers and a risk to one that
  // does not, which is what `prefersExperience` is for on both sides.
  const youth = d.age <= 23 ? (1 - team.prefersExperience) * 0.10 : 0;
  const decline = d.age >= 36 ? -(d.age - 35) * 0.02 : 0;
  return pace + experienceBonus + youth + decline;
}

/**
 * Whether a team can afford a driver at all.
 *
 * ONLY IN FORMULA 1. In the junior formulae the money runs the other way: a
 * driver brings a budget to the team rather than drawing a wage from it, and
 * `salaryUsd` on a junior is a valuation for the market to sort by, not a bill.
 *
 * Applying the Formula 1 rule to them was quietly catastrophic and is worth
 * recording. AIX Racing's Formula 2 budget is $3.1M, so the test allowed a wage
 * of $868k — and the cheapest junior on the grid "costs" $1.09M by that
 * formula. AIX could not afford ANY driver in the world. Neither could most of
 * Formula 3, which is why the market generated nine hundred rookies across a
 * hundred seasons instead of the two hundred or so a healthy pyramid produces,
 * and why Formula 2 kept turning up to races with twenty cars. The rule was
 * right; the tier it was applied to was not.
 */
function affordable(team: WorldTeam, d: WorldDriver): boolean {
  if (team.tier !== 'F1') return true;
  // Salaries sit outside the cost cap, so this is a budget question rather than
  // a regulatory one. A quarter of the operating budget is about the most any
  // team spends on one driver.
  return d.salaryUsd <= team.budgetUsd * 0.28;
}

const ROOKIE_FIRST = [
  'Luca', 'Mateo', 'Noah', 'Elias', 'Kai', 'Arjun', 'Rui', 'Tomás', 'Nikita',
  'Jonas', 'Aleix', 'Milo', 'Sora', 'Ayaan', 'Emil', 'Théo', 'Lars', 'Dario',
  'Kian', 'Bruno', 'Otto', 'Anton', 'Enzo', 'Mika', 'Nuno', 'Rafa', 'Levi',
];
const ROOKIE_LAST = [
  'Brandt', 'Ferrante', 'Okafor', 'Lindholm', 'Duarte', 'Novikov', 'Kaur',
  'Marchand', 'Bergström', 'Oyelaran', 'Castellanos', 'Vermeulen', 'Ishikawa',
  'Molnár', 'Rasmussen', 'Sørheim', 'Delacroix', 'Ravenna', 'Halstead',
  'Pinheiro', 'Aaltonen', 'Steiner', 'Варга', 'Quirós', 'Whitlock',
];
const ROOKIE_NATIONS = [
  'Italy', 'France', 'United Kingdom', 'Spain', 'Germany', 'Netherlands',
  'Brazil', 'Japan', 'Australia', 'United States', 'Mexico', 'Denmark',
  'Sweden', 'Finland', 'Poland', 'India', 'Argentina', 'Canada', 'Thailand',
];

/**
 * Creates a driver who was not in the world before, so a junior grid can never
 * run out of people.
 *
 * In Formula 3 this is a karting graduate — the bottom of the pyramid, and the
 * reason it has a base at all. In Formula 2 it is a driver arriving from one of
 * the categories this game does not simulate (a regional Formula 3, Super
 * Formula, an American ladder), which is exactly where a real Formula 2 grid
 * finds people when its own intake is thin.
 *
 * Formula 1 deliberately has no equivalent. Nobody appears in Formula 1 from
 * nowhere; if its grid cannot be filled from Formula 2, that is a bug and the
 * probe should say so rather than have it papered over here.
 */
export function generateRookie(
  world: CareerWorld, teamId: string, rng: Rng, tier: TierId = 'F3',
): WorldDriver {
  const index = world.nextRookieIndex++;
  const first = rng.pick(ROOKIE_FIRST);
  const last = rng.pick(ROOKIE_LAST);
  // An intake is mostly good and occasionally exceptional. The long tail upward
  // is what makes a future champion appear in a career the player is already
  // halfway through, which is the point of generating them at all.
  const centre = tier === 'F2' ? 0.72 : 0.66;
  const talent = clamp01(rng.gaussian(centre, 0.055) + (rng.chance(0.08) ? 0.09 : 0));

  return {
    id: `rookie-${index}`,
    tier,
    firstName: first,
    lastName: last,
    // Codes can collide with a real driver's; the timing tower shows the team
    // colour beside it, and real championships have collisions too.
    code: last.slice(0, 3).toUpperCase().padEnd(3, 'X'),
    raceNumber: 40 + (index % 55),
    nationality: rng.pick(ROOKIE_NATIONS),
    teamId,
    skill: talent,
    aggression: clamp01(rng.gaussian(0.75, 0.06)),
    consistency: clamp01(talent - rng.range(0.02, 0.10)),
    tyreManagement: clamp01(talent - rng.range(0.01, 0.08)),
    wetSkill: clamp01(talent + rng.gaussian(0, 0.05)),
    racecraft: clamp01(talent - rng.range(0.0, 0.06)),
    experience: tier === 'F2' ? 1 : 0,
    age: (tier === 'F2' ? 19 : 17) + rng.int(0, 3),
    contractYears: 1,
    salaryUsd: 250_000,
    reserve: false,
  };
}

/**
 * Runs the whole off-season.
 *
 * Order matters and each step depends on the one before it:
 *
 *   1. Titles are settled, because promotion reads the final table.
 *   2. Promotions resolve top-two, bottom tier upward, so a seat vacated in
 *      Formula 2 by someone going to Formula 1 is available to the Formula 3
 *      champion in the same winter rather than a year later.
 *   3. Retirements and drops, which open the remaining seats.
 *   4. The market fills every empty seat, generating Formula 3 rookies when the
 *      bottom of the ladder runs out of drivers.
 *   5. Cars develop and the hidden form is re-rolled.
 *   6. Everybody gets a year older.
 */
export function runOffSeason(
  world: CareerWorld, season: SeasonState, rng: Rng,
  opts: { playerDriverId?: string } = {},
): OffSeasonReport {
  const report: OffSeasonReport = {
    year: season.year,
    champions: [], constructorChampions: [],
    promotions: [], departures: [], signings: [], rookies: [],
  };

  // --- 0. Contracts expire ----------------------------------------------
  // Before anything else, because every step below asks who is available and
  // the answer is decided here.
  expireContracts(world);

  // --- 1. Titles ---------------------------------------------------------
  for (const tier of TIER_ORDER) {
    const table = sortedStandings(season.tiers[tier]);
    if (table.length > 0) {
      report.champions.push({ tier, driverId: table[0].driverId, teamId: table[0].teamId });
    }
    const teams = Object.entries(season.tiers[tier].constructorPoints)
      .sort((a, b) => b[1] - a[1]);
    if (teams.length > 0) report.constructorChampions.push({ tier, teamId: teams[0][0] });
  }

  // --- 2. Promotions, bottom up -----------------------------------------
  // Walking F3 then F2 means the Formula 2 seats freed by drivers going to
  // Formula 1 are already open when the Formula 3 graduates are placed.
  const promoted = new Set<string>();
  for (const tier of ['F3', 'F2'] as const) {
    const above = tierAbove(tier);
    if (!above) continue;
    const table = sortedStandings(season.tiers[tier]);
    for (let i = 0; i < Math.min(PROMOTIONS_PER_TIER, table.length); i++) {
      const driverId = table[i].driverId;
      const driver = findDriver(world, driverId);
      if (!driver || driver.retired) continue;
      promoted.add(driverId);
      // The seat is chosen after the tier above has emptied, so it is recorded
      // here and placed in step 4 with everybody else.
      report.promotions.push({
        driverId, from: tier, to: above, toTeamId: '', championshipPosition: i + 1,
      });
    }
  }

  // --- 3. Retirements and drops -----------------------------------------
  for (const tier of TIER_ORDER) {
    const state = world.tiers[tier];
    const alive = state.drivers.filter((d) => !d.retired).length;
    // A grid does not lose a third of itself in one winter. Capping the churn
    // is not cosmetic: without it the junior formulae shed a whole cohort at
    // once — every driver who hit four seasons in the same year — and Formula 2
    // came out of the off-season with seventeen cars because there was nobody
    // left anywhere to fill the other five. `probe:season` reported it as a
    // grid that shrank in 2029 and recovered by 2030, which is exactly what a
    // cohort effect looks like.
    let budget = Math.max(2, Math.floor(alive * 0.22));

    // Longest-serving first, so the drop rule takes the drivers whose time has
    // actually run out rather than whoever the array happens to reach first.
    const order = state.drivers.slice().sort((a, b) => b.experience - a.experience);

    for (const d of order) {
      if (d.retired || promoted.has(d.id)) continue;
      // The player never retires behind their own back.
      if (d.id === opts.playerDriverId) continue;
      if (budget <= 0) break;

      // Age. The probability climbs steeply once the decline has started.
      if (d.age >= 34) {
        const p = 0.10 + (d.age - 34) * 0.14;
        if (rng.chance(Math.min(0.9, p))) {
          d.retired = true;
          report.departures.push({ driverId: d.id, reason: 'retired' });
          budget--;
          continue;
        }
      }
      // A junior driver who has been in the same tier too long without getting
      // out of it loses the seat. Without this a Formula 3 grid silts up and no
      // rookie ever gets in. Probabilistic rather than a hard threshold, so the
      // intake is a trickle every year instead of a flood every fourth one.
      if (tier !== 'F1' && d.experience >= 4 && d.contractYears <= 0) {
        if (rng.chance(0.55)) {
          d.retired = true;
          report.departures.push({ driverId: d.id, reason: 'dropped' });
          budget--;
        }
      }
    }
  }

  // --- 4. Make room, then run the market ---------------------------------
  makeRoomForPromotions(world, report, promoted, rng, opts.playerDriverId);
  fillSeats(world, report, promoted, rng, opts.playerDriverId);

  // --- 5 and 6. Cars and ages -------------------------------------------
  rollOffSeasonForm(world, rng);
  ageDrivers(world);
  world.season++;

  return report;
}

/**
 * Opens enough seats for everyone who has earned one.
 *
 * THIS IS THE ANSWER TO THE HARDEST QUESTION IN THE WHOLE DESIGN. The Formula 1
 * grid is real and it is full: eleven teams, twenty-two seats, every one of them
 * occupied by a real driver. The promotion rule says the top two in Formula 2
 * come up every single year. Those two facts collide, and how they are resolved
 * decides whether the career feels like a sport or like a menu deleting people
 * to make space for the player.
 *
 * It is resolved the way the real sport resolves it, in this order:
 *
 *   1. RETIREMENT. Step 3 has already run, and the grid this career starts from
 *      is genuinely old at the top — a 44-year-old, a 41-year-old, two drivers
 *      at 36 and one at 38. In most winters that alone opens two or three seats
 *      and nobody has to be pushed anywhere.
 *   2. EXPIRING CONTRACTS. A driver whose deal is up is not guaranteed a seat.
 *      Teams choose in step 4 and some of them choose somebody else.
 *   3. AND ONLY IF THAT IS NOT ENOUGH: the least-valued driver at the weakest
 *      team, out of contract, loses the seat. That is a real event — it happens
 *      most seasons — and it is applied to the driver a paddock would actually
 *      drop, not to whoever happens to be last in an array.
 *
 * A driver under contract is never displaced, so the player cannot arrive in
 * Formula 1 by evicting a champion who has two years left. And the promotion is
 * honoured unconditionally: if the sport will not make room voluntarily, room is
 * made, because "top two go up" is the one promise this career makes.
 */
function makeRoomForPromotions(
  world: CareerWorld, report: OffSeasonReport, promoted: Set<string>,
  rng: Rng, playerDriverId?: string,
): void {
  for (const tier of TIER_ORDER) {
    const state = world.tiers[tier];
    const seatsTotal = state.teams.length * 2;

    const incoming = [...promoted].filter((id) => {
      const d = findDriver(world, id);
      return d && tierAbove(d.tier) === tier;
    }).length;
    if (incoming === 0) continue;

    const seated = () => state.drivers.filter(
      (d) => !d.reserve && !d.retired && !promoted.has(d.id)).length;

    let open = seatsTotal - seated();
    if (open >= incoming) continue;

    // Who a paddock would actually drop: out of contract, worth least, and at a
    // team with the least to lose by changing. Never the player.
    const droppable = state.drivers
      .filter((d) => !d.retired && !d.reserve && d.contractYears <= 0
        && d.id !== playerDriverId && !promoted.has(d.id))
      .map((d) => {
        const team = findTeam(world, d.teamId);
        return { d, worth: team ? valuation(team, d) : d.skill };
      })
      .sort((a, b) => a.worth - b.worth);

    for (const { d } of droppable) {
      if (open >= incoming) break;
      d.retired = true;
      report.departures.push({ driverId: d.id, reason: 'dropped' });
      open++;
    }

    // Last resort: nobody was out of contract. Rather than evicting a driver
    // mid-deal, the shortest remaining contract is bought out — which is what a
    // team with a champion waiting in Formula 2 actually does.
    if (open < incoming) {
      const buyouts = state.drivers
        .filter((d) => !d.retired && !d.reserve && d.id !== playerDriverId
          && !promoted.has(d.id))
        .sort((a, b) => a.contractYears - b.contractYears
          || rng.next() - 0.5);
      for (const d of buyouts) {
        if (open >= incoming) break;
        d.retired = true;
        report.departures.push({ driverId: d.id, reason: 'dropped' });
        open++;
      }
    }
  }
}

/**
 * Fills every empty race seat in every tier.
 *
 * WHY THIS IS A LOOP AND NOT A SINGLE PASS. The obvious implementation walks the
 * tiers top-down, walks each tier's teams best-first, and fills whatever is
 * empty. It does not work, and the way it fails is worth recording: a team
 * signing an out-of-contract driver from a rival EMPTIES THE RIVAL'S SEAT, and
 * if that rival has already been visited, the seat is never filled again. Ten
 * seasons of it and Formula 2 runs twenty cars instead of twenty-two with three
 * teams fielding one apiece — which is what `probe:season` caught on its first
 * run, and precisely the kind of slow structural rot that would never have been
 * noticed by playing.
 *
 * So it repeats until nothing more can be placed. Each pass cascades: Formula 1
 * takes from Formula 2, Formula 2 takes from Formula 3, and Formula 3 makes a
 * new driver. A signing sets a contract of one to three years, which removes
 * that driver from the pool, so the loop always terminates — and it throws
 * rather than spinning if it ever somehow does not, because a market that cannot
 * settle should fail loudly instead of hanging a career.
 *
 * Best teams choose first, which is what makes it read as a paddock rather than
 * a shuffle: the quickest car has its pick, and what is left cascades down.
 */
function fillSeats(
  world: CareerWorld, report: OffSeasonReport, promoted: Set<string>,
  rng: Rng, playerDriverId?: string,
): void {
  const heldBy = (tier: TierId, teamId: string): number =>
    world.tiers[tier].drivers.filter(
      (d) => d.teamId === teamId && !d.reserve && !d.retired).length;

  /**
   * Everyone who has already signed somewhere this winter.
   *
   * This — not the contract field — is what stops a driver moving twice in one
   * off-season. See the note in `bestAvailable` on why the two are different
   * rules that look like one.
   */
  const placed = new Set<string>();

  // ONE TIER AT A TIME, TOP DOWN, EACH RUN TO A FIXPOINT BEFORE THE NEXT.
  //
  // The ordering is the mechanism, and interleaving the tiers does not work.
  // Formula 1 teams poach out-of-contract Formula 1 drivers from each other,
  // which opens fresh Formula 1 seats several passes in — and by then Formula 2
  // has re-signed every driver it has, so there is nobody left to promote and
  // Formula 1 starts a season with twenty-one cars. `probe:season` found exactly
  // that in 2027 of the first career: Racing Bulls fielding one car, with
  // twenty-two perfectly good Formula 2 drivers all signed the previous pass.
  //
  // Settling Formula 1 entirely before Formula 2 opens means the tier that
  // recruits from below always has the pick of it. Then Formula 2 refills from
  // Formula 3, and Formula 3 from the karting intake. The cascade only runs one
  // way, so it terminates and cannot starve itself.
  for (const tier of ['F1', 'F2', 'F3'] as const) {
    const state = world.tiers[tier];
    let progress = true;
    let guard = 0;

    while (progress) {
      progress = false;
      if (++guard > 40) throw new Error('The transfer market did not settle in ' + tier);

      // Ranked by the car they will race, which is what a driver is actually
      // choosing between. Last season's table is not in scope here and would
      // say very nearly the same thing anyway.
      const teams = state.teams.slice().sort((a, b) => rateCar(b) - rateCar(a));

      for (const team of teams) {
        while (heldBy(tier, team.id) < 2) {
          const candidate = bestAvailable(
            world, team, tier, promoted, placed, playerDriverId, rng);

          // Last resort, and only in the junior formulae: the sport finds
          // somebody new. Formula 3 takes a karting graduate; Formula 2 takes a
          // driver from one of the categories this game does not simulate,
          // which is where a real Formula 2 grid finds people when its own
          // intake is thin.
          //
          // Formula 1 has no such escape hatch on purpose. Nobody arrives there
          // from nowhere, so if its grid cannot be filled from Formula 2 the
          // probe should fail rather than have the hole quietly papered over.
          if (!candidate) {
            if (tier === 'F1') break;
            const rookie = generateRookie(world, team.id, rng, tier);
            state.drivers.push(rookie);
            placed.add(rookie.id);
            report.rookies.push(rookie.id);
            progress = true;
            continue;
          }

          const previousTeamId = candidate.teamId;
          const fromTier = candidate.tier;
          transfer(world, candidate.id, team.id, tier);
          // Now under contract, and therefore out of the pool. This is what
          // guarantees the loop terminates, and it is also what stops a driver
          // being promoted twice in one winter.
          //
          // A JUNIOR DEAL IS ALWAYS ONE YEAR. Formula 2 and Formula 3 are places
          // drivers pass through, and locking a junior into a three-year deal
          // would starve the tier above of anybody to sign — which is a real
          // failure mode this had, not a hypothetical one. Only Formula 1 does
          // multi-year contracts, and they are what makes its grid stable enough
          // that a seat opening there is an event.
          candidate.contractYears = tier === 'F1' ? 1 + rng.int(0, 3) : 1;
          placed.add(candidate.id);
          progress = true;

          if (promoted.has(candidate.id)) {
            promoted.delete(candidate.id);
            const p = report.promotions.find((x) => x.driverId === candidate.id);
            if (p) p.toTeamId = team.id;
          } else if (previousTeamId !== team.id || fromTier !== tier) {
            report.signings.push({
              driverId: candidate.id, teamId: team.id, tier, previousTeamId,
            });
          }
        }
      }
    }
  }

  // A promotion that found no seat is not a promotion. The driver stays where
  // they are rather than vanishing, which is a real outcome — a champion who
  // cannot find a drive — and the report says so honestly rather than claiming
  // a move that did not happen.
  for (const p of report.promotions) {
    if (!p.toTeamId) {
      p.toTeamId = findDriver(world, p.driverId)?.teamId ?? '';
      p.to = p.from;
    }
  }
}

/**
 * Runs the market again over a world with no promotions pending.
 *
 * Exists because THE PLAYER MOVES AFTER THE MARKET HAS CLOSED. The off-season
 * fills every seat, and only then does the career place the player — which is
 * the right order, because where the player lands depends on what the market
 * left open. But a player promoted out of Formula 2 takes a seat with them, and
 * that seat is now empty in a championship the market has finished with.
 *
 * `probe:season` caught it as Formula 2 running twenty-one cars in exactly the
 * seasons a training career was promoted, which is a lovely example of a bug
 * that only appears when the player does well.
 */
export function settleGrid(
  world: CareerWorld, rng: Rng, playerDriverId?: string,
): OffSeasonReport {
  const report: OffSeasonReport = {
    year: world.season,
    champions: [], constructorChampions: [],
    promotions: [], departures: [], signings: [], rookies: [],
  };
  fillSeats(world, report, new Set(), rng, playerDriverId);
  return report;
}

/** How good a car is, in one number, for ranking teams against each other. */
function rateCar(team: WorldTeam): number {
  const p = performanceOf(team);
  return p.powerMult + p.downforceMult + p.mechanicalGripMult - p.dragMult;
}

/** The driver a given team would most like to sign, and can. */
function bestAvailable(
  world: CareerWorld, team: WorldTeam, tier: TierId,
  promoted: Set<string>, placed: Set<string>,
  playerDriverId: string | undefined, rng: Rng,
): WorldDriver | null {
  const pool: WorldDriver[] = [];

  const consider = (d: WorldDriver, seatless: boolean): void => {
    if (d.retired) return;
    if (d.id === playerDriverId) return;      // the player is placed by the career
    if (placed.has(d.id)) return;             // already moved in this off-season
    if (d.teamId === team.id && !d.reserve) return;
    // Under contract elsewhere and already in a seat: not available.
    if (!seatless && d.contractYears > 0 && !promoted.has(d.id)) return;
    if (!affordable(team, d)) return;

    // A driver in a seat does not move sideways.
    //
    // Without this the market is technically correct and reads as nonsense: the
    // first run of it changed fifty-four of Formula 1's twenty-two seats in one
    // winter, because every out-of-contract driver was equally happy to sign for
    // anybody. A real paddock moves three or four drivers a year, and the reason
    // is simply that leaving a seat for an equivalent one is a bad trade. So a
    // move within a tier has to be a genuine step up — worth roughly a tenth of
    // a second of car — before the driver will take it.
    if (!d.reserve && d.tier === tier && d.teamId !== team.id) {
      const current = findTeam(world, d.teamId);
      if (current && rateCar(team) < rateCar(current) + 0.012) return;
    }

    pool.push(d);
  };

  // Drivers promoted INTO this tier come first, and they are the only ones
  // considered while any remain: a promotion is a guaranteed seat, so it cannot
  // lose a straight valuation contest to an established driver who happens to
  // be worth more. Restricting to `tierAbove(d.tier) === tier` is what stops a
  // Formula 3 champion being dropped into a Formula 1 seat because Formula 1
  // happened to be short that winter.
  if (promoted.size > 0) {
    for (const t of TIER_ORDER) {
      for (const d of world.tiers[t].drivers) {
        if (promoted.has(d.id) && tierAbove(d.tier) === tier) consider(d, true);
      }
    }
  }

  if (pool.length === 0) {
    // Everyone in this tier without a seat, then reserves, then anyone out of
    // contract in the tier below looking for a step up.
    for (const d of world.tiers[tier].drivers) {
      const seated = !d.reserve && d.teamId !== '';
      consider(d, !seated || d.reserve);
    }
  }

  if (pool.length === 0) {
    // A step up from the tier below.
    //
    // Contracts are deliberately NOT consulted here, and the `placed` set is
    // what makes that safe. The two rules being separated look like one rule and
    // are not:
    //
    //   · "not available, they are under contract" — a real constraint, and the
    //     reason a Formula 1 grid is stable.
    //   · "not available, they were signed ten milliseconds ago in this same
    //     off-season" — bookkeeping, and nothing to do with contracts.
    //
    // Conflating them broke the ladder twice in opposite directions. Ignoring
    // contracts entirely let a driver be promoted F3 to F2 and then F2 to F1 in
    // one winter, straight past a whole championship. Then respecting them
    // starved Formula 2: every Formula 3 driver had just signed an annual deal,
    // so no Formula 2 team could sign anybody and the grid ran twenty cars
    // instead of twenty-two. `probe:season` caught both, several seasons deep
    // into careers nobody would have played that far by hand.
    //
    // A junior contract is an annual formality; what actually stops a second
    // move is that the driver has already moved.
    const below = TIER_ORDER[TIER_ORDER.indexOf(tier) - 1];
    if (below) {
      for (const d of world.tiers[below].drivers) consider(d, true);
    }
  }

  if (pool.length === 0) return null;

  pool.sort((a, b) => valuation(team, b) - valuation(team, a));
  // A little noise, so the same career does not always produce the same market
  // and so a paddock occasionally makes a decision nobody understands.
  const top = pool.slice(0, Math.min(3, pool.length));
  return top[rng.int(0, top.length)] ?? null;
}
