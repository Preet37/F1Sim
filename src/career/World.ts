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
  /** Scales the 798kg Formula 1 minimum. See the note below. */
  massMult: number;
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
 * MASS IS NOW A TERM, and it was the missing one. `specForTeam` used to multiply
 * power, downforce, drag and grip but not mass, so a Formula 3 car weighed what
 * a Formula 1 car weighs. That is not a small error and it is not a uniform one:
 * downforce goes as v squared and mass does not, so a tier built only out of
 * power and downforce is correct at the circuit where speed is highest and too
 * slow everywhere the car is slow. `probe:tiers` measured exactly that — Monza
 * +12.7 / +20.1 against Zandvoort +16.8 / +24.8, for targets of 13 and 19 — and
 * no amount of tuning the other multipliers could have fixed the spread, only
 * moved which circuit was wrong. See `massMult` in VehicleSpec.
 *
 * The two mass figures are the minimum weights the formulae run to, with driver:
 * 605kg for Formula 3 and 795 for Formula 2, against Formula 1's 798. Formula 2
 * is therefore very nearly as heavy as a Formula 1 car and gets almost nothing
 * out of this; its deficit is a power and downforce deficit, and always was.
 */
export const TIER_CAR: Record<TierId, TierCar> = {
  F3: {
    name: 'FIA Formula 3 Championship', shortName: 'Formula 3',
    // ~380hp against ~750hp of combustion, no hybrid, and a wing package that
    // makes about a third of the downforce.
    powerMult: 0.49, ersMult: 0, downforceMult: 0.72,
    // Much less wing means much less drag, which is why the deficit down a
    // straight is nothing like the deficit through a corner.
    dragMult: 0.80, mechanicalGripMult: 0.95,
    // 605kg of 798.
    massMult: 0.758,
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapPoint: true,
  },
  F2: {
    name: 'FIA Formula 2 Championship', shortName: 'Formula 2',
    powerMult: 0.71, ersMult: 0, downforceMult: 0.86,
    dragMult: 0.88, mechanicalGripMult: 1.00,
    // 795kg of 798. A Formula 2 car is not a light car.
    massMult: 0.996,
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapPoint: true,
  },
  F1: {
    name: 'FIA Formula One World Championship', shortName: 'Formula 1',
    powerMult: 1, ersMult: 1, downforceMult: 1, dragMult: 1, mechanicalGripMult: 1,
    massMult: 1,
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

  /**
   * What the factory has built, per department.
   *
   * SEPARATE FROM `development` on purpose. `development` is the abstract
   * "this team got better over the winter" term the paper model moves for every
   * AI team; this is the thing the player actually commissioned, and it is
   * itemised because the three departments buy three different physical
   * properties. An aero project that lands is not a car that is 1% better, it
   * is a car with more downforce AND more drag — which is a worse car at Monza
   * and a better one at Monaco, and the physics works that out on its own.
   *
   * Optional, so every team that is not the player's carries nothing and every
   * save written before My Team existed loads unchanged.
   */
  upgrades?: TeamUpgrades;

  /** True for the player's own constructor in My Team. */
  isPlayerTeam?: boolean;
}

/**
 * Accumulated in-career development, itemised by what it physically bought.
 *
 * Every field here is a fraction, and every one of them lands on a named
 * `TeamPerformance` field in `performanceOf` below. There is no field in this
 * record that does not reach the car; that is the test each one had to pass.
 */
export interface TeamUpgrades {
  /** Adds to `downforceMult`, and costs drag unless bought back by efficiency. */
  aero: number;
  /** Subtracts from `dragMult`. The expensive kind of aero. */
  aeroEfficiency: number;
  /** Adds to `mechanicalGripMult` and takes off `tireWearMult`. */
  chassis: number;
  /** Adds to `powerMult` and `ersMult`, and takes off `failureRate`. */
  powertrain: number;
  /** Seconds off `pitCrewTimeS`, which `Strategy.ts` already prices. */
  pitCrew: number;
}

/**
 * Ceilings on what a factory can buy.
 *
 * WHY THERE HAS TO BE A CEILING. Upgrades accumulate and nothing else in this
 * model takes them away within a season, so an uncapped term is a career that
 * ends with a car three seconds a lap faster than the grid — which is not a
 * reward, it is the end of the game. These are the widths of the real thing:
 * 16% of downforce is roughly the gap between the best and worst car on a
 * modern grid, and it takes several seasons of maximum spend to reach.
 *
 * `probe:myteam` develops fifty upgrades and asserts the multipliers are still
 * inside a sane envelope afterwards, which is what these numbers are for.
 */
export const UPGRADE_LIMIT: TeamUpgrades = {
  aero: 0.16,
  aeroEfficiency: 0.10,
  chassis: 0.12,
  powertrain: 0.09,
  pitCrew: 0.60,
};

export function emptyUpgrades(): TeamUpgrades {
  return { aero: 0, aeroEfficiency: 0, chassis: 0, powertrain: 0, pitCrew: 0 };
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
    // The tier's own mass. Nothing a team does changes it: every car in a
    // championship runs to the same minimum weight, and a team that finds a
    // kilogram spends it on ballast placement rather than on being lighter.
    massMult: car.massMult,
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

  /**
   * WHAT THE FACTORY BUILT.
   *
   * This is the last thing applied and it is the whole of My Team's connection
   * to the simulation. Every one of the five terms lands on a different
   * physical quantity, and the reason they are five rather than one is that a
   * single "car quality" number would make every upgrade identical and every
   * decision fake:
   *
   *   · AERO buys downforce and CHARGES DRAG for it. That is the real trade and
   *     it is deliberately not free — a team that only ever runs aero projects
   *     builds a car that is quick at Monaco and slow at Monza, and the
   *     physics discovers that without a single per-circuit special case.
   *   · AERO EFFICIENCY buys the drag back without the downforce, which is what
   *     a real efficiency programme is and why it is the expensive one.
   *   · CHASSIS buys mechanical grip — the low-speed corner and the traction
   *     zone, where downforce does nothing — and is kinder to the tyres, which
   *     lengthens a stint and is priced by `Strategy.ts`.
   *   · POWERTRAIN buys combustion power and deployment together and takes
   *     reliability off the failure rate, because a development programme is
   *     mostly a reliability programme.
   *   · PIT CREW is seconds of stationary time, and `Strategy.ts` already turns
   *     seconds of stationary time into a decision about how many stops to make.
   *
   * Applied AFTER the power unit, so a customer penalty is on the engine the
   * team was supplied and not on the work its own factory did.
   */
  const up = team.upgrades;
  if (up) {
    base.downforceMult *= 1 + up.aero;
    // Downforce is not free. A wing that makes more load makes more drag, and
    // the ratio here — about half a per cent of drag per per cent of load — is
    // the one a real development curve shows. Efficiency work buys it back.
    base.dragMult *= 1 + up.aero * 0.55 - up.aeroEfficiency;
    base.mechanicalGripMult *= 1 + up.chassis;
    base.tireWearMult *= 1 - up.chassis * 0.8;
    base.powerMult *= 1 + up.powertrain;
    base.ersMult *= 1 + up.powertrain;
    // A floor rather than a subtraction to zero: no car ever finishes every
    // race, and a career where the player's entry cannot fail has removed the
    // only thing that makes a reliability project worth buying.
    base.failureRate = Math.max(0.006, base.failureRate - up.powertrain * 0.35);
    // Two seconds is a pit stop that has already gone as well as one can.
    base.pitCrewTimeS = Math.max(1.95, base.pitCrewTimeS - up.pitCrew);
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

      /**
       * The winter takes some of the factory's work back.
       *
       * NOT A PUNISHMENT — THE SAME REGRESSION EVERY OTHER TEAM GETS. An AI
       * team's advantage decays toward the mean by 22% a winter (the `regress`
       * term two lines up), because the rest of the grid copies what works,
       * the regulations move, and a development curve flattens. A player team
       * whose upgrades were permanent would be exempt from the one mechanism
       * that stops this career becoming a single dominant car for fifteen
       * seasons, and it would be exempt for no reason other than that its
       * performance is stored in a different field.
       *
       * So: the same 22%, on the same schedule. Development still compounds —
       * 78% of a large number is a large number — it just cannot run away.
       */
      if (t.upgrades) {
        const u = t.upgrades;
        u.aero *= 0.78;
        u.aeroEfficiency *= 0.78;
        u.chassis *= 0.78;
        u.powertrain *= 0.78;
        // Except the pit crew. A trained crew is people, not bodywork, and
        // nobody's regulations reset them over the winter.
        u.pitCrew *= 0.94;
      }
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
