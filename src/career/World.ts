import { clamp, clamp01, Rng } from '../core/MathUtils';
import { installGrid, type Driver, type Team } from '../data/teams';
import {
  REAL_ROSTER, TIER_ORDER, getPowerUnit, powerUnitFor,
  type Roster, type RosterDriver, type RosterTeam, type TierId,
} from '../data/roster';
import type { TeamPerformance } from '../physics/VehicleSpec';

/**
 * The career's world: three championships, their teams, their drivers, and the
 * cars they race.
 *
 * THIS IS THE FILE THAT MAKES A TIER MEAN SOMETHING.
 *
 * Before it, `TIER_INFO.carPace` was declared, documented as "scales the vehicle
 * spec's power and downforce for the tier", and read by nothing at all — so a
 * Formula 3 race was driven in a thousand-horsepower Formula 1 car and the whole
 * ladder was a label on a menu. The reason that happened is worth understanding,
 * because it is the trap this design exists to avoid: the career layer had no
 * channel to the simulation, so a number it invented had nowhere to go.
 *
 * There is exactly one channel. `CarEntry` builds every car with
 * `applySetup(specForTeam(team.performance))`, and `team` comes from
 * `getTeam(driver.teamId)`. So `TeamPerformance` is the entire bandwidth between
 * this file and the physics, and everything a career decides has to end up in
 * one of its eight fields or it does not exist.
 *
 * A car here is therefore the product of four things, multiplied together:
 *
 *   1. THE TIER'S CAR. A Formula 3 car is not a Formula 1 car with a worse
 *      driver in it; it is 380 horsepower against a thousand, and about a third
 *      of the downforce. That is `TIER_CAR` below.
 *   2. THE TEAM'S CHASSIS. In Formula 1 this is the whole game. In the junior
 *      formulae it is nothing at all, because they are spec series — so junior
 *      teams differ only in pit crew, preparation and set-up, which is exactly
 *      what makes a junior championship about driving.
 *   3. THE POWER UNIT. Only in Formula 1, and only there does a customer get a
 *      slightly worse version of what the works team runs.
 *   4. THIS SAVE'S FORM. A hidden per-team variance, rolled once at career
 *      creation and nudged every off-season, so that no two careers have the
 *      same pecking order and no pecking order stays still.
 *
 * The world is stored IN THE SAVE rather than being recomputed from the roster
 * on load. It costs perhaps eighty kilobytes and it buys the thing that matters:
 * a career in progress is not silently rewritten when the roster file is edited
 * or a driver's rating is corrected between builds.
 */

// ===========================================================================
// The car each tier races
// ===========================================================================

export interface TierCar {
  name: string;
  shortName: string;
  /** Multipliers on the base Formula 1 spec. */
  powerMult: number;
  ersMult: number;
  downforceMult: number;
  dragMult: number;
  mechanicalGripMult: number;
  /** Points for positions 1..10. */
  points: readonly number[];
  /** Point for the fastest lap, inside the top ten. */
  fastestLapPoint: boolean;
}

/**
 * What each championship actually drives.
 *
 * The targets these were tuned to are the real ratios: a Formula 2 lap is about
 * 13% slower than a Formula 1 lap at the same circuit, and a Formula 3 lap about
 * 21% slower. `probe:tiers` measures the ratio headlessly at all eleven circuits
 * and fails if it drifts outside 11-16% and 18-24%, so these numbers are held to
 * a measurement rather than to an opinion.
 *
 * ERS IS ZERO IN THE JUNIOR FORMULAE, because neither car has any. That is not a
 * fudge to slow them down — it removes the deployment the physics would
 * otherwise hand them out of every corner, and it is a large part of why an F2
 * car cannot live with an F1 car onto a straight.
 *
 * ONE KNOWN COMPROMISE. `specForTeam` multiplies power, downforce, drag and grip
 * but not MASS, and a real Formula 3 car is 605kg against a Formula 1 car's 798.
 * So the junior cars here are correctly underpowered and correctly short of
 * downforce, but too heavy — which flatters their braking and hurts their
 * traction out of slow corners. Fixing it properly needs a `massMult` field on
 * `TeamPerformance` and one line in `specForTeam`, which is a change in
 * `src/physics/VehicleSpec.ts`. It is a request, not something taken here, and
 * the multipliers below are tuned to land the lap times with the mass as it is.
 */
export const TIER_CAR: Record<TierId, TierCar> = {
  F3: {
    name: 'FIA Formula 3 Championship', shortName: 'Formula 3',
    // ~380hp against ~750hp of combustion, no hybrid, and a wing package that
    // makes about a third of the downforce.
    powerMult: 0.52, ersMult: 0, downforceMult: 0.80,
    // Much less wing means much less drag, which is why the deficit down a
    // straight is nothing like the deficit through a corner.
    dragMult: 0.80, mechanicalGripMult: 1.00,
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapPoint: true,
  },
  F2: {
    name: 'FIA Formula 2 Championship', shortName: 'Formula 2',
    powerMult: 0.68, ersMult: 0, downforceMult: 0.86,
    dragMult: 0.88, mechanicalGripMult: 1.00,
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapPoint: true,
  },
  F1: {
    name: 'FIA Formula One World Championship', shortName: 'Formula 1',
    powerMult: 1, ersMult: 1, downforceMult: 1, dragMult: 1, mechanicalGripMult: 1,
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapPoint: true,
  },
};

// ===========================================================================
// Saved shapes
// ===========================================================================

/**
 * A team as the career holds it.
 *
 * Everything the simulation needs plus everything a career changes. The split
 * between `chassis` and `form` and `development` is deliberate: the first is
 * what the team brought to the season, the second is this save's hidden luck,
 * and the third is what has been built since — and only the third is something
 * the player can affect.
 */
export interface WorldTeam {
  id: string;
  tier: TierId;
  name: string;
  shortName: string;
  code: string;
  colour: number;
  accent: number;

  powerUnitId: string;

  chassis: RosterTeam['chassis'];
  /**
   * Hidden per-save variance, as a fraction. Applied to downforce, grip and
   * power alike, so a lucky team is simply a better car and the player has to
   * work out which one it is from the stopwatch.
   */
  form: number;
  /** Accumulated in-career development, same units as `form`. */
  development: number;

  developmentRate: number;
  prefersExperience: number;
  budgetUsd: number;

  /** True for the player's own constructor in My Team. */
  isPlayerTeam?: boolean;
}

export interface WorldDriver {
  id: string;
  tier: TierId;
  firstName: string;
  lastName: string;
  code: string;
  raceNumber: number;
  nationality: string;
  teamId: string;

  skill: number;
  aggression: number;
  consistency: number;
  tyreManagement: number;
  wetSkill: number;
  racecraft: number;
  experience: number;
  age: number;

  contractYears: number;
  salaryUsd: number;
  /** On the entry list but not in a race seat. */
  reserve: boolean;
  /** Set when a driver leaves the sport. Kept for the career's history. */
  retired?: boolean;
}

export interface WorldTierState {
  tier: TierId;
  teams: WorldTeam[];
  drivers: WorldDriver[];
  calendar: string[];
}

export interface CareerWorld {
  /** The season this world currently describes. */
  season: number;
  /** Seed the form rolls come from. Stored so a career is reproducible. */
  seed: number;
  tiers: Record<TierId, WorldTierState>;
  /** Ids already handed out, so a generated rookie never collides. */
  nextRookieIndex: number;
}

// ===========================================================================
// Building a world
// ===========================================================================

/**
 * Standard deviation of the hidden form roll, as a fraction of performance.
 *
 * 0.012 is about a third of a second a lap, which is roughly the width of the
 * midfield. Big enough that the order genuinely differs between careers; small
 * enough that it never turns the slowest team into the fastest, which would read
 * as a bug rather than as a season.
 */
const FORM_SIGMA = 0.012;

/** Form is clamped so a roll can never invert the grid. */
const FORM_LIMIT = 0.03;

function toWorldTeam(t: RosterTeam, tier: TierId, rng: Rng): WorldTeam {
  return {
    id: t.id, tier, name: t.name, shortName: t.shortName, code: t.code,
    colour: t.colour, accent: t.accent,
    powerUnitId: t.powerUnitId,
    chassis: { ...t.chassis },
    // Junior formulae are spec series, so there is nothing for form to vary:
    // every car really is the same car, and pretending otherwise would take the
    // one honest thing about a junior championship away from it.
    form: tier === 'F1' ? clamp(rng.gaussian(0, FORM_SIGMA), -FORM_LIMIT, FORM_LIMIT) : 0,
    development: 0,
    developmentRate: t.developmentRate,
    prefersExperience: t.prefersExperience,
    budgetUsd: t.budgetUsd,
  };
}

function toWorldDriver(d: RosterDriver, tier: TierId): WorldDriver {
  return {
    id: d.id, tier,
    firstName: d.firstName, lastName: d.lastName, code: d.code,
    raceNumber: d.raceNumber, nationality: d.nationality, teamId: d.teamId,
    skill: d.skill, aggression: d.aggression, consistency: d.consistency,
    tyreManagement: d.tyreManagement, wetSkill: d.wetSkill, racecraft: d.racecraft,
    experience: d.experience, age: d.age,
    contractYears: d.contractYears, salaryUsd: d.salaryUsd,
    reserve: d.reserve ?? false,
  };
}

/** Builds a fresh world from a roster, rolling this save's hidden form. */
export function createWorld(seed: number, roster: Roster = REAL_ROSTER): CareerWorld {
  const rng = new Rng(seed ^ 0x5bf03635);
  const tiers = {} as Record<TierId, WorldTierState>;

  for (const tier of TIER_ORDER) {
    const src = roster.tiers[tier];
    tiers[tier] = {
      tier,
      teams: src.teams.map((t) => toWorldTeam(t, tier, rng)),
      drivers: src.drivers.map((d) => toWorldDriver(d, tier)),
      calendar: [...src.calendar],
    };
  }

  return { season: roster.season, seed, tiers, nextRookieIndex: 0 };
}

// ===========================================================================
// Turning a world into a grid the simulation can race
// ===========================================================================

/**
 * The performance record for one team: tier car × chassis × power unit × form.
 *
 * This is the function the whole design converges on. Every management decision
 * in career mode — an engine deal, an aero upgrade, a season of development, a
 * demoralised department delivering a part that does not work — arrives here, as
 * a number, and leaves as a car.
 */
export function performanceOf(team: WorldTeam): TeamPerformance {
  const car = TIER_CAR[team.tier];
  const c = team.chassis;

  // Form and development are the same kind of quantity — a fraction on the car's
  // overall performance — so they are added and applied once, to the three
  // multipliers that decide lap time. Drag is deliberately NOT lifted by them: a
  // team that finds performance finds it as efficiency, and a career that could
  // buy its way out of drag would have no reason ever to run less wing.
  const lift = 1 + team.form + team.development;

  const base = {
    powerMult: car.powerMult * lift,
    ersMult: car.ersMult,
    downforceMult: car.downforceMult * c.downforceMult * lift,
    dragMult: car.dragMult * c.dragMult,
    mechanicalGripMult: car.mechanicalGripMult * c.mechanicalGripMult * lift,
    tireWearMult: c.tireWearMult,
    failureRate: c.failureRate,
    pitCrewTimeS: c.pitCrewTimeS,
  };

  // Formula 1 only: the power unit is a separate supply deal, and a customer
  // does not get quite what the works team gets.
  if (team.tier === 'F1' && team.powerUnitId) {
    const pu = powerUnitFor(getPowerUnit(team.powerUnitId), team.id);
    base.powerMult *= pu.powerMult;
    base.ersMult *= pu.ersMult;
    // Engine and chassis failures are independent events, so the rates add.
    base.failureRate += pu.failureRate;
  }

  return base;
}

/** A `Team` the race engine can build cars from. */
export function toTeam(team: WorldTeam): Team {
  return {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
    code: team.code,
    colour: team.colour,
    accent: team.accent,
    engine: team.powerUnitId
      ? getPowerUnit(team.powerUnitId).shortName
      : TIER_CAR[team.tier].shortName,
    performance: performanceOf(team),
    developmentRate: team.developmentRate,
    prefersExperience: team.prefersExperience,
  };
}

/** A `Driver` the race engine can build a car for. */
export function toDriver(d: WorldDriver): Driver {
  return {
    id: d.id,
    firstName: d.firstName, lastName: d.lastName, code: d.code,
    raceNumber: d.raceNumber, nationality: d.nationality, teamId: d.teamId,
    skill: d.skill, aggression: d.aggression, consistency: d.consistency,
    tyreManagement: d.tyreManagement, wetSkill: d.wetSkill, racecraft: d.racecraft,
    experience: d.experience, age: d.age,
  };
}

/**
 * Installs the whole world — all three tiers at once — over the static grid.
 *
 * All three rather than just the player's, because the paper simulation that
 * resolves the two championships the player is not in reads the same
 * `getTeam`/`getDriver` the physics does. One grid, one answer, whichever way a
 * result is produced.
 */
export function installWorld(world: CareerWorld): void {
  const teams: Team[] = [];
  const drivers: Driver[] = [];
  for (const tier of TIER_ORDER) {
    for (const t of world.tiers[tier].teams) teams.push(toTeam(t));
    for (const d of world.tiers[tier].drivers) drivers.push(toDriver(d));
  }
  installGrid(teams, drivers);
}

// ===========================================================================
// Queries
// ===========================================================================

/** Drivers in a tier's race seats, in team order. This is the grid. */
export function raceSeats(world: CareerWorld, tier: TierId): WorldDriver[] {
  const state = world.tiers[tier];
  const out: WorldDriver[] = [];
  // Ordered by team so the pit boxes come out two-per-garage, which is what
  // `pitGeom.boxS` lays out and what the paddock builds its bays from.
  for (const team of state.teams) {
    for (const d of state.drivers) {
      if (d.teamId === team.id && !d.reserve && !d.retired) out.push(d);
    }
  }
  return out;
}

export function findTeam(world: CareerWorld, id: string): WorldTeam | undefined {
  for (const tier of TIER_ORDER) {
    const t = world.tiers[tier].teams.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

export function findDriver(world: CareerWorld, id: string): WorldDriver | undefined {
  for (const tier of TIER_ORDER) {
    const d = world.tiers[tier].drivers.find((x) => x.id === id);
    if (d) return d;
  }
  return undefined;
}

/**
 * Moves a driver to another team, and possibly another tier.
 *
 * Kept as one function because a transfer touches three things that must not
 * disagree — the driver's `teamId`, their `tier`, and which tier's array they
 * live in — and every bug in a transfer market is one of those three being
 * updated without the others.
 */
export function transfer(
  world: CareerWorld, driverId: string, toTeamId: string, toTier: TierId,
): void {
  const driver = findDriver(world, driverId);
  if (!driver) throw new Error('Unknown driver in transfer: ' + driverId);
  const from = world.tiers[driver.tier];
  const idx = from.drivers.indexOf(driver);
  if (idx >= 0) from.drivers.splice(idx, 1);

  driver.teamId = toTeamId;
  driver.tier = toTier;
  driver.reserve = false;
  world.tiers[toTier].drivers.push(driver);
}

// ===========================================================================
// The off-season's effect on the cars
// ===========================================================================

/**
 * Develops every team's car over the winter and re-rolls the hidden form.
 *
 * Three things happen at once and they are all necessary:
 *
 *  · TEAMS DEVELOP by their own rate, so a well-funded outfit pulls away.
 *  · THEY REGRESS toward the mean, which is what stops a career becoming a
 *    single team winning everything for fifteen years — the real sport's
 *    regulations, cost cap and diminishing returns all push the same way.
 *  · A FRESH SHOCK is applied, so the order drifts and a dominant car can be
 *    caught by something nobody saw coming. This is the mechanic that makes the
 *    tenth season of a career unlike the first.
 */
export function rollOffSeasonForm(world: CareerWorld, rng: Rng): void {
  for (const tier of TIER_ORDER) {
    // Spec series have no car development to do.
    if (tier !== 'F1') continue;
    const teams = world.tiers[tier].teams;

    let mean = 0;
    for (const t of teams) mean += t.form + t.development;
    mean /= Math.max(1, teams.length);

    for (const t of teams) {
      const total = t.form + t.development;
      // Development earned in-career is kept; the winter's movement lands on
      // `form`, which is the part the player cannot see and did not buy.
      const gain = (t.developmentRate - 0.5) * 0.006;
      const regress = (mean - total) * 0.22;
      const shock = rng.gaussian(0, FORM_SIGMA * 0.55);
      t.form = clamp(t.form + gain + regress + shock, -FORM_LIMIT, FORM_LIMIT);
    }
  }
}

/**
 * Runs every contract down by a year.
 *
 * SEPARATE FROM AGEING, AND BEFORE THE MARKET, because the order is the whole
 * mechanism. A contract expires at the end of the season; the driver is then a
 * free agent; then the market runs. Decrementing contracts at the end of the
 * off-season instead — which is where it started out, folded into `ageDrivers` —
 * meant that on the day the market opened, every driver in the world was still
 * under contract from the season that had just finished. Nobody could be signed
 * by anybody, so Formula 2 teams that had lost a driver to a promotion found an
 * empty market and simply ran one car. `probe:season` caught it as a grid that
 * quietly shrank.
 */
export function expireContracts(world: CareerWorld): void {
  for (const tier of TIER_ORDER) {
    for (const d of world.tiers[tier].drivers) {
      d.contractYears = Math.max(0, d.contractYears - 1);
    }
  }
}

/**
 * Ages every driver by a season and moves their ability accordingly.
 *
 * The curve is the one the sport actually shows: fast improvement to about 26,
 * a long plateau where experience keeps adding race craft after raw pace has
 * stopped growing, and a slow decline from the mid-thirties that consistency and
 * tyre management outlive.
 */
export function ageDrivers(world: CareerWorld): void {
  for (const tier of TIER_ORDER) {
    for (const d of world.tiers[tier].drivers) {
      if (d.retired) continue;
      d.age++;
      d.experience++;

      if (d.age <= 26) {
        d.skill = clamp01(d.skill + 0.013);
        d.consistency = clamp01(d.consistency + 0.017);
        d.racecraft = clamp01(d.racecraft + 0.015);
        d.tyreManagement = clamp01(d.tyreManagement + 0.012);
      } else if (d.age <= 33) {
        d.consistency = clamp01(d.consistency + 0.005);
        d.racecraft = clamp01(d.racecraft + 0.006);
        d.tyreManagement = clamp01(d.tyreManagement + 0.004);
      } else {
        d.skill = clamp01(d.skill - 0.012);
        d.racecraft = clamp01(d.racecraft + 0.002);
      }
    }
  }
}
