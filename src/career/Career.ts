import { Rng, clamp, clamp01 } from '../core/MathUtils';
import { getTeam, type Driver } from '../data/teams';
import { REAL_ROSTER, TIER_ORDER, type TierId } from '../data/roster';
import {
  TIER_CAR, createWorld, emptyUpgrades, findDriver, findTeam, installWorld, raceSeats,
  toDriver, transfer,
  type CareerWorld, type WorldDriver, type WorldTeam,
} from './World';
import {
  AMBITION, COST_CAP_USD, DEPARTMENT_IDS, MAX_FACILITY_LEVEL, MAX_STAFF,
  MIN_STAFF, NEW_TEAM_CHASSIS, PIT_CREW_STEP_USD, STAFF_WAGE_USD,
  STARTING_BUDGET_USD, applyUpgrade, breachPenaltyFor, capSpent,
  commercialIncomePerRound, defaultDepartments, emptyLedger, engineBreakFeeUsd,
  engineOffers, facilityUpgradeCostUsd, facilityUpkeepUsd, factoryAnnualCostUsd,
  generateFreeAgents, investInPitCrew, prizeMoneyFor, projectCostUsd,
  projectGain, projectRounds, qcFailureChance,
  type Ambition, type BreachPenalty, type DepartmentId, type Ledger,
  type UpgradeProject,
} from './MyTeam';
import {
  circuitFor, positionOf, recordRound, runOffSeason, seasonComplete,
  settleGrid, simulateRound, sortedStandings, startSeason,
  type OffSeasonReport, type RoundResult, type SeasonState, type SeasonSummary,
} from './Season';
import {
  SAVE_MINOR, SAVE_VERSION, playerAsWorldDriver, playerStanding,
  type CareerMode, type CareerState, type MyTeamState, type PlayerProfile,
} from './CareerState';
import {
  CareerEventManager, type CareerEvent, type EventContext,
} from './Events';
import {
  availableNumbers, defaultHelmet, uniqueDriverCode, type HelmetDesign,
} from './Identity';
import {
  offSeasonStories, openDecisions, roundDebrief,
  type Decision, type Story,
} from './Newsroom';
import {
  ACCOLADES, HISTORY_LIMIT, RATING_KEYS, accoladeProgress, applyMove, buildMarket,
  capsFor, emptyRatingsState, levelToPoints, moveForRound, newContractGoal,
  ratingsFor, recognitionFor, recordRoundInRecord, recordSeasonInRecord, sortMarket,
  type AccoladeProgress, type ContractGoal, type DriverRatings, type MarketEntry,
  type MarketSort, type RatingKey, type RatingMove, type RatingsState,
  type RecognitionSplit,
} from './DriverRatings';

/** A project that reached the end of its schedule, and whether it passed QC. */
export interface ProjectDelivery {
  project: UpgradeProject;
  /**
   * False when quality control rejected it.
   *
   * The money is gone either way. That is the mechanic: a demoralised
   * department does not deliver a worse part, it delivers one that does not
   * pass, and the cap space it consumed is not refunded.
   */
  passed: boolean;
}

/** What a season did to the team's books. */
export interface TeamSeasonReport {
  constructorPosition: number;
  prizeUsd: number;
  capSpentUsd: number;
  penalty: BreachPenalty;
  closingCashUsd: number;
  /**
   * The season's ledger as it stood after the audit, before it was emptied.
   *
   * WHY THE REPORT CARRIES IT. The prize and the cap fine are the two largest
   * cash movements in the mode and both land inside `endSeason`, between the
   * last round and `rollTeamIntoNextSeason` wiping the ledger for the new year.
   * Anything reading `team.ledger` after `endSeason` returns sees the NEXT
   * season's opening bill, so those two figures were unreconcilable by
   * construction — `probe:myteam` invariant 2 closed its window before the
   * prize was paid and reopened it after the fine was taken. This is the copy
   * that makes the whole season balance.
   */
  closingLedger: Ledger;
}

/** The answer to "can this be paid for, and is it allowed". */
export interface CommitCheck {
  /** Affordable AND permitted. False for an unconfirmed cap breach. */
  ok: boolean;
  /** Affordable, but it would take the season past the cost cap. */
  overCap: boolean;
  reason: string;
  /**
   * The refusal is a cap breach the player may still choose to make.
   *
   * The screen turns this into a confirmation naming the penalty, and retries
   * with `allowBreach`. Anything without it is a plain refusal.
   */
  needsConfirmation?: boolean;
}

/** Dollars as millions, to one decimal. Every money string in the mode uses it. */
function fmtM(usd: number): string {
  return (usd / 1e6).toFixed(1);
}

/**
 * The career, as one object the rest of the game talks to.
 *
 * It owns three things that have to stay consistent with one another and were
 * previously scattered: the WORLD (who exists), the SEASON (what has happened),
 * and the PLAYER (where they are in it). Every operation that touches more than
 * one of those lives here, because the bugs in a career mode are almost entirely
 * bugs where two of the three disagreed.
 *
 * It also owns the grid overlay. `installWorld` puts this career's teams and
 * drivers behind `getTeam`/`getDriver`, which is how a decision made in a menu
 * reaches the car the physics integrates. The overlay is installed on load and
 * on creation, and it is the caller's job to take it down when leaving career
 * mode — `Career.dispose()`.
 */
export class Career {
  readonly state: CareerState;
  private rng: Rng;
  /**
   * The factory's own randomness, deliberately NOT `this.rng`.
   *
   * WHY A SECOND STREAM. `this.rng` is the world's: it runs the championship,
   * the off-season and the narrative events. The quality-control roll in
   * `startProject` used to draw from it, which meant that commissioning an
   * upgrade advanced the world's stream — so two careers founded on the same
   * seed, one developing and one idle, no longer raced the same championship.
   * Every result after the first commission differed for a reason that had
   * nothing to do with the car.
   *
   * That is not a tidiness argument. `probeMyTeam` invariant 7 compares a
   * developing career against an idle one to prove that building the car is
   * worth doing, and with the streams shared it was measuring RNG divergence:
   * it PASSED with the upgrade block in `World.performanceOf` hard-disabled,
   * i.e. with the factory completely disconnected from the car. See
   * PROJECT.md §3.2.
   */
  private factoryRng: Rng;

  constructor(state: CareerState) {
    this.state = state;
    this.rng = new Rng(state.seed ^ 0x2f6a1b3c);
    this.factoryRng = new Rng(state.seed ^ 0x5be3c19d);
    installWorld(state.world);
  }

  // =======================================================================
  // Creation
  // =======================================================================

  /**
   * Starts a career.
   *
   * A driver career begins in Formula 3 with the weakest team on the grid, which
   * is where a rookie with no results actually starts. The player REPLACES a
   * driver rather than being added as a twenty-first car, because the grid size
   * is what the pit lane paints and what every probe measures; the driver they
   * replace becomes a reserve rather than being deleted, so the world stays
   * whole and the transfer market can give them a seat again later.
   */
  static create(opts: {
    firstName: string;
    lastName: string;
    nationality: string;
    raceNumber?: number;
    helmet?: HelmetDesign;
    mode?: CareerMode;
    seed?: number;
  }): Career {
    const seed = opts.seed ?? Math.floor(Date.now() % 2147483647);
    const world = createWorld(seed, REAL_ROSTER);
    const rng = new Rng(seed ^ 0x11f0a7d3);

    /**
     * The code and the number are taken against the grid the player is joining,
     * not in isolation. Two cars in one championship cannot carry the same
     * number, and two drivers sharing three letters on the timing tower is the
     * kind of detail that quietly tells somebody the game is not really theirs.
     */
    const f3Drivers = world.tiers.F3.drivers;
    const code = uniqueDriverCode(opts.lastName, f3Drivers.map((d) => d.code));
    const wanted = opts.raceNumber ?? 47;
    const numbersTaken = new Set(f3Drivers.map((d) => d.raceNumber));
    const raceNumber = numbersTaken.has(wanted)
      ? (availableNumbers(numbersTaken)[0] ?? wanted)
      : wanted;

    const player: PlayerProfile = {
      firstName: opts.firstName,
      lastName: opts.lastName,
      code,
      nationality: opts.nationality,
      raceNumber,
      helmet: opts.helmet ?? defaultHelmet(seed),
      // A junior with obvious potential and nothing proven. Deliberately below
      // the Formula 3 field's median, so the first season is a fight.
      skill: 0.70,
      aggression: 0.68,
      consistency: 0.64,
      tyreManagement: 0.62,
      wetSkill: 0.68,
      racecraft: 0.63,
      experience: 0,
      age: 18,
    };

    // The weakest Formula 3 team, which is the seat a rookie with no results is
    // actually offered.
    const f3 = world.tiers.F3;
    const startTeam = f3.teams[f3.teams.length - 1];

    const state: CareerState = {
      saveVersion: SAVE_VERSION,
      saveMinor: SAVE_MINOR,
      createdAt: new Date().toISOString(),
      seed,
      mode: opts.mode ?? 'driver',
      player,
      playerDriverId: 'PLAYER',
      tier: 'F3',
      teamId: startTeam.id,
      contractYears: 2,
      seasonsInTier: 0,
      world,
      // Replaced immediately below, once the player is in the world.
      season: { year: world.season, tiers: {} as SeasonState['tiers'] },
      history: [],
      narrative: {
        fanRating: 8,
        reputation: 10,
        pressure: 20,
        departmentMorale: {},
        rivalries: [],
        flags: {},
        firedEvents: [],
      },
      team: null,
      prepSlotsLeft: 2,
      // Placeholder — replaced below, once the player's record is in the world
      // and there is a rating to set a contract goal against.
      ratings: emptyRatingsState(0, world.season),
    };

    // Take a seat by displacing the weakest driver at that team, who becomes a
    // reserve rather than disappearing.
    const seatHolders = f3.drivers.filter((d) => d.teamId === startTeam.id && !d.reserve);
    const displaced = seatHolders.sort((a, b) => a.skill - b.skill)[0];
    if (displaced) displaced.reserve = true;
    f3.drivers.push(playerAsWorldDriver(state));

    const career = new Career(state);
    career.state.season = startSeason(world);
    career.seedRivalries(rng);
    career.resetContractGoal();
    return career;
  }

  /**
   * Starts a My Team career: owner and lead driver, in Formula 1, from nothing.
   *
   * A SEPARATE CAREER TYPE, NOT A LADDER SHORTCUT. The brief is "build a racing
   * empire from the ground up", so the team enters Formula 1 directly as a
   * TWELFTH ENTRY rather than buying somebody else's. That makes the grid 24
   * cars, which is outside the envelope every existing probe measures at 20 —
   * `probe:fieldsize` runs full headless races at 20, 22 and 24 on Monaco, Spa
   * and Monza and reports that the grid holds structurally at every size: every
   * car starts clear, every car gets its own pit box, everybody is classified
   * once. That measurement is why this is a twelfth team and not a takeover.
   *
   * The player is the lead driver and takes no salary — they own the outfit.
   * The second car is a real `WorldDriver` in this save's world, so whoever is
   * signed qualifies on merit, races the same physics, scores constructors'
   * points and beats the player or does not.
   */
  static createMyTeam(opts: {
    firstName: string;
    lastName: string;
    nationality: string;
    raceNumber?: number;
    helmet?: HelmetDesign;
    seed?: number;
    team: {
      name: string;
      shortName: string;
      code: string;
      baseCountry: string;
      colour: number;
      accent: number;
      trim: number;
      liveryFamily: string;
      liveryFinish: 'gloss' | 'satin' | 'matte';
      liveryMark: number;
    };
    /** Chosen from `Career.freeAgentsFor(seed)`. */
    teammate: WorldDriver;
    /** Chosen from `engineOffers`. Must be one the team is allowed to have. */
    powerUnitId: string;
  }): Career {
    const seed = opts.seed ?? Math.floor(Date.now() % 2147483647);
    const world = createWorld(seed, REAL_ROSTER);
    const rng = new Rng(seed ^ 0x11f0a7d3);

    const f1 = world.tiers.F1;
    const teamId = 'myteam';

    const team: WorldTeam = {
      id: teamId,
      tier: 'F1',
      name: opts.team.name,
      shortName: opts.team.shortName,
      code: opts.team.code,
      colour: opts.team.colour,
      accent: opts.team.accent,
      powerUnitId: opts.powerUnitId,
      chassis: { ...NEW_TEAM_CHASSIS },
      // No hidden form roll for the player's own team. Every other car on the
      // grid carries a variance the player has to work out from the stopwatch;
      // applying one to their own would mean a career where the first season is
      // secretly good or secretly bad for a reason nothing on any screen could
      // ever explain. Their car is exactly what they built.
      form: 0,
      development: 0,
      developmentRate: 0.6,
      prefersExperience: 0.4,
      budgetUsd: STARTING_BUDGET_USD,
      upgrades: emptyUpgrades(),
      isPlayerTeam: true,
    };
    f1.teams.push(team);

    const code = uniqueDriverCode(opts.lastName, f1.drivers.map((d) => d.code));
    const wanted = opts.raceNumber ?? 47;
    const taken = new Set(f1.drivers.map((d) => d.raceNumber));
    const raceNumber = taken.has(wanted) ? (availableNumbers(taken)[0] ?? wanted) : wanted;
    taken.add(raceNumber);

    const player: PlayerProfile = {
      firstName: opts.firstName,
      lastName: opts.lastName,
      code,
      nationality: opts.nationality,
      raceNumber,
      helmet: opts.helmet ?? defaultHelmet(seed),
      // An owner-driver entering Formula 1 is not a Formula 3 rookie. They are
      // credible and they are not a front-runner, which is the same place the
      // car starts — so the first season is about the operation rather than
      // about either being unusually good or unusually bad.
      skill: 0.76,
      aggression: 0.70,
      consistency: 0.72,
      tyreManagement: 0.70,
      wetSkill: 0.72,
      racecraft: 0.71,
      experience: 3,
      age: 24,
    };

    const departments = defaultDepartments();
    const myTeam: MyTeamState = {
      teamId,
      name: opts.team.name,
      shortName: opts.team.shortName,
      code: opts.team.code,
      baseCountry: opts.team.baseCountry,
      colour: opts.team.colour,
      accent: opts.team.accent,
      trim: opts.team.trim,
      liveryFamily: opts.team.liveryFamily,
      liveryFinish: opts.team.liveryFinish,
      liveryMark: opts.team.liveryMark,
      cashUsd: STARTING_BUDGET_USD,
      ledger: emptyLedger(),
      departments,
      projects: [],
      nextProjectId: 1,
      powerUnitId: opts.powerUnitId,
      powerUnitYearsLeft: 3,
      teammateDriverId: opts.teammate.id,
      developmentBanRounds: 0,
      pointsDeducted: 0,
    };

    const state: CareerState = {
      saveVersion: SAVE_VERSION,
      saveMinor: SAVE_MINOR,
      createdAt: new Date().toISOString(),
      seed,
      mode: 'myteam',
      player,
      playerDriverId: 'PLAYER',
      tier: 'F1',
      teamId,
      contractYears: 99,
      seasonsInTier: 0,
      world,
      season: { year: world.season, tiers: {} as SeasonState['tiers'] },
      history: [],
      narrative: {
        fanRating: 12,
        reputation: 20,
        pressure: 22,
        // The three departments start with a morale each, because morale is
        // read by `projectCostUsd` and `qcFailureChance` from the first project
        // commissioned. An empty record here would mean the whole mechanic did
        // nothing until something happened to populate it.
        departmentMorale: {
          aero: departments.aero.morale,
          chassis: departments.chassis.morale,
          powertrain: departments.powertrain.morale,
        },
        rivalries: [],
        flags: {},
        firedEvents: [],
      },
      team: myTeam,
      prepSlotsLeft: 2,
      ratings: emptyRatingsState(0, world.season),
    };

    // The second car, signed into the world as a real entrant.
    const mate: WorldDriver = {
      ...opts.teammate,
      tier: 'F1',
      teamId,
      contractYears: 2,
      reserve: false,
      raceNumber: taken.has(opts.teammate.raceNumber)
        ? (availableNumbers(taken)[0] ?? opts.teammate.raceNumber)
        : opts.teammate.raceNumber,
    };
    f1.drivers.push(playerAsWorldDriver(state));
    f1.drivers.push(mate);

    const career = new Career(state);
    career.state.season = startSeason(world);
    career.seedRivalries(rng);
    career.beginTeamSeason();
    // An owner-driver picked themselves, which is what the academy line on the
    // recognition screen means: nobody else in the garage chose that seat.
    career.resetContractGoal();
    career.state.ratings!.recognition.academyChoice = true;
    return career;
  }

  /**
   * The free agents available to a team created from this seed.
   *
   * Deterministic, so the create screen and `createMyTeam` cannot disagree about
   * who was on the market — and so a career is reproducible from its seed, which
   * is what makes `probe:myteam` able to run the same career twice.
   */
  static freeAgentsFor(seed: number, season = REAL_ROSTER.season): WorldDriver[] {
    return generateFreeAgents(new Rng(seed ^ 0x63a1d7f5), 8, season);
  }

  /** Removes this career's grid, returning the game to the static one. */
  dispose(): void {
    // Deliberately not `clearGrid()` here — the caller decides, because leaving
    // career mode and starting a Quick Race are the same transition and only
    // `main.ts` knows which one is happening.
  }

  // =======================================================================
  // Where are we?
  // =======================================================================

  get world(): CareerWorld { return this.state.world; }
  get season(): SeasonState { return this.state.season; }
  get tier(): TierId { return this.state.tier; }

  get calendar(): readonly string[] {
    return this.state.world.tiers[this.state.tier].calendar;
  }

  get round(): number {
    return this.state.season.tiers[this.state.tier].round;
  }

  get currentCircuitId(): string {
    return circuitFor(this.state.world, this.state.season, this.state.tier);
  }

  get seasonComplete(): boolean {
    return seasonComplete(this.state.world, this.state.season, this.state.tier);
  }

  get tierName(): string {
    return TIER_CAR[this.state.tier].shortName;
  }

  get championshipPosition(): number {
    return positionOf(this.state.season.tiers[this.state.tier], this.state.playerDriverId);
  }

  standing(): { points: number; position: number } {
    return playerStanding(this.state);
  }

  /** The player's driver record, refreshed from the profile. */
  playerAsDriver(): Driver {
    return toDriver(playerAsWorldDriver(this.state));
  }

  /**
   * The full grid for the player's tier, in team order, with the player in it.
   *
   * This is what `main.ts` hands to `RaceEngine`. The player's record is rebuilt
   * from the profile each time rather than read from the world, so training and
   * pressure applied since the last save are actually in the car.
   */
  grid(): Driver[] {
    const seats = raceSeats(this.state.world, this.state.tier);
    return seats.map((d) =>
      d.id === this.state.playerDriverId ? this.playerAsDriver() : toDriver(d));
  }

  /** The team the player currently drives for, as the simulation sees it. */
  playerTeam(): ReturnType<typeof getTeam> {
    return getTeam(this.state.teamId);
  }

  // =======================================================================
  // Running a round
  // =======================================================================

  /**
   * Records the player's round and resolves the same round in the other two
   * championships.
   *
   * The other tiers are advanced HERE rather than lazily at the end of the
   * season, so that a career the player quits halfway through still has three
   * championships in a consistent state, and so that a promotion the player
   * reads about is one that has already happened rather than one computed
   * retroactively.
   */
  recordPlayerRound(result: RoundResult): ProjectDelivery[] {
    // Captured BEFORE the round is folded in, because "up to P4" is a
    // comparison and there is nothing to compare against afterwards.
    const positionBefore = this.championshipPosition;

    const pointsBefore = this.standing().points;

    recordRound(this.state.season, this.state.tier, result);
    this.advanceOtherTiers();
    this.updateRivalries(result);
    // THE RATINGS MOVE HERE, and only here. See `applyRoundToRatings`.
    this.applyRoundToRatings(result, this.standing().points - pointsBefore);
    this.state.prepSlotsLeft = this.prepSlotsForNextRound();
    // The factory runs on the same clock as the championship.
    const deliveries = this.advanceFactory();

    /**
     * WHAT JUST HAPPENED, WRITTEN DOWN.
     *
     * The verdict on this career mode was that it is not clear what is going on,
     * and the largest single reason was that everything the simulation did
     * between one press of "Race Weekend" and the next went unreported. A part
     * arrived and changed the car; the championship moved; somebody won the
     * Formula 2 race the player is trying to be promoted into. All of it was in
     * the state and none of it was ever said.
     *
     * Held on the instance rather than in the save because it is a report about
     * a moment, not a fact about the career — and because a save that carried a
     * queue of unread news would show somebody a race result from three weeks
     * ago the next time they opened the tab.
     */
    this.recentStories = roundDebrief({
      state: this.state,
      result,
      positionBefore,
      deliveries: deliveries.map((d) => ({
        department: d.project.department,
        ambition: d.project.ambition,
        efficiency: d.project.efficiency,
        passed: d.passed,
        gain: d.project.gain,
        costUsd: d.project.costUsd,
      })),
    });

    return deliveries;
  }

  /**
   * The news, however the player arrived at this screen.
   *
   * After a round it is the debrief. On a fresh load — where there is no
   * "just happened" to report — it falls back to what is true of the season
   * right now, so the hub is never blank and never stale.
   */
  private recentStories: Story[] = [];

  stories(): Story[] {
    if (this.recentStories.length > 0) return this.recentStories;
    return roundDebrief({
      state: this.state,
      // A synthetic round with nobody in it: `roundDebrief` reports only what it
      // can find, so an empty order produces the standings and paddock lines and
      // no race result. That is exactly right for "you have just opened this".
      result: {
        round: this.round, circuitId: this.currentCircuitId, order: [], retired: [],
        poleDriverId: '', fastestLapDriverId: '', wetRace: false, driven: false,
      },
      deliveries: [],
      positionBefore: 0,
    });
  }

  /** What the player is actually being asked to decide, most urgent first. */
  decisions(): Decision[] {
    return openDecisions(this.state, Math.max(0, this.calendar.length - this.round));
  }

  /** Resolves the player's round on paper, for a race they chose to skip. */
  simulatePlayerRound(opts: { wet?: boolean } = {}): RoundResult {
    return simulateRound(this.state.world, this.state.season, this.state.tier, this.rng, opts);
  }

  /**
   * Keeps the two championships the player is not in level with the one they
   * are, by rounds completed as a fraction of the calendar.
   *
   * Fractional rather than round-for-round because the calendars are different
   * lengths — Formula 3 runs nine rounds and Formula 2 twelve — so "the same
   * round" is not a meaningful thing to keep in step. What has to be true is
   * that all three finish together.
   */
  private advanceOtherTiers(): void {
    const mine = this.state.season.tiers[this.state.tier];
    const myProgress = mine.round / Math.max(1, this.calendar.length);

    for (const tier of TIER_ORDER) {
      if (tier === this.state.tier) continue;
      const cal = this.state.world.tiers[tier].calendar.length;
      const target = Math.round(myProgress * cal);
      let guard = 0;
      while (this.state.season.tiers[tier].round < target
        && !seasonComplete(this.state.world, this.state.season, tier)) {
        recordRound(this.state.season, tier,
          simulateRound(this.state.world, this.state.season, tier, this.rng));
        if (++guard > 60) break;
      }
    }
  }

  /** Two slots between rounds, three when the calendar leaves a longer gap. */
  private prepSlotsForNextRound(): number {
    return this.round % 3 === 0 ? 3 : 2;
  }

  // =======================================================================
  // The off-season
  // =======================================================================

  /**
   * Ends the season and moves the career into the next one.
   *
   * Every championship is finished first, so a player who skipped nothing and a
   * player who simulated everything reach the same off-season. Then the world's
   * own off-season runs — promotions, retirements, the market, development — and
   * only afterwards is the player placed, using the same rules.
   */
  endSeason(): {
    report: OffSeasonReport; summary: SeasonSummary; promoted: boolean;
    team: TeamSeasonReport | null; stories: Story[];
  } {
    const s = this.state;

    // Finish anything outstanding, in every tier.
    for (const tier of TIER_ORDER) {
      let guard = 0;
      while (!seasonComplete(s.world, s.season, tier)) {
        recordRound(s.season, tier, simulateRound(s.world, s.season, tier, this.rng));
        if (++guard > 60) break;
      }
    }

    // The books close on the season that just ran, before the world moves on:
    // prize money is paid on the constructors' table as it finished, and the
    // cap audit deducts from that same table. Doing it after `runOffSeason`
    // would be auditing a championship that no longer exists.
    const teamReport = this.settleTeamSeason();

    const myTable = sortedStandings(s.season.tiers[s.tier]);
    const myPosition = myTable.findIndex((e) => e.driverId === s.playerDriverId) + 1;
    const myPoints = myTable.find((e) => e.driverId === s.playerDriverId)?.points ?? 0;
    const wasTier = s.tier;

    const report = runOffSeason(s.world, s.season, this.rng, {
      playerDriverId: s.playerDriverId,
    });

    // --- The player goes through the same rules -----------------------------
    const promoted = this.placePlayer(myPosition, report);

    // The player has just moved, after the market closed. If they were promoted
    // they took a seat out of the tier below with them, and somebody has to fill
    // it — otherwise that championship runs a car short for a whole season, in
    // exactly the years the player did well.
    if (promoted) {
      const extra = settleGrid(s.world, this.rng, s.playerDriverId);
      report.rookies.push(...extra.rookies);
      report.signings.push(...extra.signings);
    }

    const summary: SeasonSummary = {
      year: s.season.year,
      championByTier: Object.fromEntries(report.champions.map((c) => [c.tier, c.driverId])),
      constructorByTier: Object.fromEntries(
        report.constructorChampions.map((c) => [c.tier, c.teamId])),
      playerTier: wasTier,
      playerPosition: myPosition,
      playerPoints: myPoints,
      playerTeamId: s.teamId,
      promoted,
    };
    s.history.push(summary);

    // --- The ratings model's own year-end ----------------------------------
    //
    // Two counters and one contract. `recordSeasonInRecord` is what makes the
    // `Championship Top 5` accolade a real count rather than a label, and the
    // contract is either renewed against the new seat or ages by a year at the
    // same one — which is what `Years with Team` on the recognition screen is.
    const ratings = this.ratingsState;
    recordSeasonInRecord(ratings.record, myPosition);
    if (promoted) {
      this.resetContractGoal();
    } else {
      ratings.contract.seasonsAtTeam++;
    }

    // Age the player alongside everybody else.
    s.player.age++;
    s.player.experience++;
    this.developPlayer();

    s.season = startSeason(s.world);
    s.prepSlotsLeft = 3;
    // The team's own new year: ledger reset, unfinished projects written off,
    // next season's fixed bill charged. After the world's off-season, because
    // the wage bill depends on which driver the market left in the second car.
    this.rollTeamIntoNextSeason();
    installWorld(s.world);
    // The winter, as news. `runOffSeason` has always returned every promotion,
    // retirement and signing it made; until now they were rendered as a list of
    // ids on one screen and thrown away.
    this.recentStories = offSeasonStories(s, report);
    return { report, summary, promoted, team: teamReport, stories: this.recentStories };
  }

  /**
   * Puts the player in a seat for next season.
   *
   * THE SAME RULE AS EVERYBODY ELSE: top two in the championship go up. There is
   * no reputation gate and no discretion, which is exactly what was wrong with
   * the version this replaces — it promoted the player on
   * `won || (position <= 3 && reputation > 40)` and never promoted anyone else
   * at all.
   *
   * Which seat, though, is a market question, and the answer is the best team in
   * the new tier that has a seat open. A champion arrives before a runner-up and
   * therefore gets the better of what is available, without either being
   * scripted.
   */
  private placePlayer(position: number, report: OffSeasonReport): boolean {
    const s = this.state;
    const above = s.tier === 'F3' ? 'F2' : s.tier === 'F2' ? 'F1' : null;
    const goingUp = position > 0 && position <= 2 && above !== null;

    if (goingUp && above) {
      const seat = this.bestOpenSeat(above);
      if (seat) {
        this.moveSelfTo(above, seat);
        s.seasonsInTier = 0;
        s.contractYears = above === 'F1' ? 2 : 1;
        report.promotions.push({
          driverId: s.playerDriverId, from: s.history.length > 0 ? s.tier : s.tier,
          to: above, toTeamId: seat, championshipPosition: position,
        });
        s.tier = above;
        s.teamId = seat;
        this.state.narrative.reputation = Math.min(100, this.state.narrative.reputation + 18);
        return true;
      }
      // Promoted with nowhere to go. Real, and it stays in the same tier.
    }

    s.seasonsInTier++;
    s.contractYears = Math.max(0, s.contractYears - 1);

    /**
     * Four seasons in a junior tier without getting out of it and the seat goes.
     *
     * FOUR, NOT THREE. The first version of this was three, and `probe:save`
     * showed what that actually meant: a career simulated with no training at
     * all ended in Formula 3 in its third season, every time. A rookie starts
     * below the field on purpose — the premise is working your way up — and
     * three seasons is not enough runway to close that gap even playing well.
     *
     * It still has to bite, or the ladder has no stakes and a player can sit in
     * Formula 3 for fifteen years. Four seasons is roughly one wasted year of
     * grace, which is the shape of the real thing.
     */
    if (s.tier !== 'F1' && s.seasonsInTier >= 4 && s.contractYears <= 0) {
      s.endedReason = `Dropped after ${s.seasonsInTier} seasons in ${TIER_CAR[s.tier].shortName} ` +
        'without a promotion.';
    }
    return false;
  }

  /** The best team in a tier with a seat going spare. */
  private bestOpenSeat(tier: TierId): string | null {
    const state = this.state.world.tiers[tier];
    const ranked = state.teams.slice().sort((a, b) => {
      const rate = (t: typeof a) =>
        t.chassis.downforceMult + t.chassis.mechanicalGripMult - t.chassis.dragMult + t.form;
      return rate(b) - rate(a);
    });
    for (const team of ranked) {
      const held = state.drivers.filter(
        (d) => d.teamId === team.id && !d.reserve && !d.retired).length;
      if (held < 2) return team.id;
    }
    // Nothing open. Take the weakest team's weakest seat, displacing them to
    // reserve — the same thing that happens to the driver the player replaced at
    // the very start, and a real outcome for a champion nobody wanted.
    const worst = ranked[ranked.length - 1];
    const holder = state.drivers
      .filter((d) => d.teamId === worst.id && !d.reserve && !d.retired)
      .sort((a, b) => a.skill - b.skill)[0];
    if (holder) {
      holder.reserve = true;
      return worst.id;
    }
    return null;
  }

  /** Moves the player's world record into a new tier and team. */
  private moveSelfTo(tier: TierId, teamId: string): void {
    const s = this.state;
    const existing = findDriver(s.world, s.playerDriverId);
    if (existing) {
      transfer(s.world, s.playerDriverId, teamId, tier);
    } else {
      const rec = playerAsWorldDriver(s);
      rec.tier = tier;
      rec.teamId = teamId;
      s.world.tiers[tier].drivers.push(rec);
    }
  }

  /**
   * A season of racing makes the player better.
   *
   * The same curve every other driver is on — see `ageDrivers` — so the player
   * is not on a privileged development track. What the player has that the AI
   * does not is the preparation slots between rounds, which is where a career's
   * choices actually show up in the driver.
   */
  private developPlayer(): void {
    const p = this.state.player;
    if (p.age <= 26) {
      p.skill = clamp01(p.skill + 0.013);
      p.consistency = clamp01(p.consistency + 0.017);
      p.racecraft = clamp01(p.racecraft + 0.015);
      p.tyreManagement = clamp01(p.tyreManagement + 0.012);
    } else if (p.age <= 33) {
      p.consistency = clamp01(p.consistency + 0.005);
      p.racecraft = clamp01(p.racecraft + 0.006);
    } else {
      p.skill = clamp01(p.skill - 0.012);
    }
    this.syncPlayerIntoWorld();
  }

  /**
   * Writes the player's profile back into the world's copy of their record.
   *
   * The world holds a `WorldDriver` for the player so that the transfer market,
   * the standings and `raceSeats` all see them as one of the field. That copy is
   * derived, not authoritative — the profile is — so it has to be refreshed
   * whenever the profile changes, or the player trains all season and the grid
   * keeps racing last year's version of them.
   */
  syncPlayerIntoWorld(): void {
    const s = this.state;
    const rec = findDriver(s.world, s.playerDriverId);
    if (!rec) return;
    const fresh = playerAsWorldDriver(s);
    Object.assign(rec, fresh, { tier: rec.tier, teamId: rec.teamId });
  }

  // =======================================================================
  // Preparation between rounds
  // =======================================================================

  /**
   * Spends a preparation slot.
   *
   * These are the answer to "what do you do between races", and every one of
   * them reaches something the simulation reads: training moves a driver
   * attribute the AI's own model uses, a factory visit moves department morale
   * which decides what an upgrade costs, and a media day moves fan rating which
   * decides which sponsors will talk.
   */
  spendPrepSlot(kind: 'train' | 'simulator' | 'media' | 'factory' | 'sponsor',
    attribute?: keyof PlayerProfile): boolean {
    const s = this.state;
    if (s.prepSlotsLeft <= 0) return false;
    s.prepSlotsLeft--;

    switch (kind) {
      case 'train': {
        const key = attribute ?? 'skill';
        const v = s.player[key];
        if (typeof v === 'number') {
          // Diminishing returns: the closer to the ceiling, the less a week buys.
          const headroom = 1 - v;
          (s.player[key] as number) = clamp01(v + 0.004 + headroom * 0.012);
        }
        break;
      }
      case 'simulator':
        s.narrative.flags.simulatorPrepared = true;
        break;
      /**
       * A media day and a factory visit are the two ends of the same trade, and
       * BOTH ENDS ARE NOW REAL.
       *
       * They used to move `narrative.departmentMorale` only. In a My Team career
       * that record is a mirror — the authoritative morale lives on the
       * department, because that is what `projectCostUsd` and `qcFailureChance`
       * read — so the whole mechanic was moving a copy nothing consulted. A day
       * at the factory now genuinely makes the next aero package cheaper and
       * more likely to pass, and a day in front of the cameras genuinely does
       * not.
       */
      case 'media':
        s.narrative.fanRating = Math.min(100, s.narrative.fanRating + 4);
        this.nudgeEveryDepartment(-2);
        break;
      case 'factory':
        this.nudgeEveryDepartment(5);
        break;
      case 'sponsor':
        if (s.team) {
          s.team.cashUsd += 750_000;
          s.team.ledger.commercialUsd += 750_000;
        }
        break;
    }

    this.syncPlayerIntoWorld();
    return true;
  }

  // =======================================================================
  // Rivalries
  // =======================================================================

  private seedRivalries(rng: Rng): void {
    const field = raceSeats(this.state.world, this.state.tier)
      .filter((d) => d.id !== this.state.playerDriverId);
    // The two quickest in the tier, plus the teammate: the drivers the player
    // will actually be measured against.
    const ranked = field.slice().sort((a, b) => b.skill - a.skill).slice(0, 2);
    const mate = field.find((d) => d.teamId === this.state.teamId);
    const set = new Set<WorldDriver>(ranked);
    if (mate) set.add(mate);

    for (const d of set) {
      this.state.narrative.rivalries.push({
        driverId: d.id,
        heat: rng.range(10, 30),
        state: 'none',
        declared: false,
        wonAgainst: 0,
        lostTo: 0,
      });
    }
  }

  private updateRivalries(result: RoundResult): void {
    const s = this.state;
    const mine = result.order.indexOf(s.playerDriverId);
    if (mine < 0) return;

    for (const r of s.narrative.rivalries) {
      const theirs = result.order.indexOf(r.driverId);
      if (theirs < 0) continue;
      if (theirs > mine) r.wonAgainst++; else r.lostTo++;

      // Heat rises when they finish near each other and cools when they do not,
      // so a rivalry is something that develops out of racing rather than being
      // announced.
      const gap = Math.abs(theirs - mine);
      r.heat = Math.max(0, Math.min(100, r.heat + (gap <= 2 ? 7 : -2)));
      if (r.heat > 75) r.state = 'feud';
      else if (r.heat > 50) r.state = 'hostile';
      else if (r.heat > 25) r.state = 'cordial';
      else r.state = 'none';
    }
  }

  /** Names a driver as a declared rival, which raises what beating them is worth. */
  declareRivalry(driverId: string): void {
    const existing = this.state.narrative.rivalries.find((r) => r.driverId === driverId);
    if (existing) {
      existing.declared = true;
      existing.heat = Math.max(existing.heat, 55);
      return;
    }
    this.state.narrative.rivalries.push({
      driverId, heat: 55, state: 'hostile', declared: true, wonAgainst: 0, lostTo: 0,
    });
  }

  // =======================================================================
  // Driver ratings — issue #77
  // =======================================================================
  //
  // EVERY SCREEN READS THESE. None of them recomputes a rating from a driver
  // attribute, and `probe:ratings` §6 greps `src/ui/` to prove it. The model
  // itself is `src/career/DriverRatings.ts`; what is here is the wiring
  // between it and the career it describes.

  /** The stored half of the model. Always present — the codec backfills it. */
  get ratingsState(): RatingsState {
    this.state.ratings ??= emptyRatingsState(0, this.state.season.year);
    return this.state.ratings;
  }

  /**
   * The player as a driver record, WITHOUT the pressure penalty.
   *
   * `playerAsWorldDriver` bakes the pressure erosion into `consistency`,
   * correctly, because that is the record the simulation races. The ratings
   * model must not read that one, for two separate reasons and the second is
   * the serious one:
   *
   *   · It applies pressure itself, to FOC, so reading the pre-eroded record
   *     would count the same penalty twice.
   *   · `applyRoundToRatings` writes the moved record BACK to the profile. Do
   *     that through the eroded copy and the penalty is re-applied and stored
   *     on every single round. `probe:ratings` §4 measured it: 340 weekends of
   *     winning finished with FOC at **17**, from a start of 64, on a driver
   *     who had done nothing wrong. A mirror written back into its own source
   *     is the same species of bug as `narrative.departmentMorale`.
   */
  private playerRaw(): WorldDriver {
    return { ...playerAsWorldDriver(this.state), consistency: this.state.player.consistency };
  }

  /** The player's ratings, right now. */
  ratings(): DriverRatings {
    return ratingsFor(this.playerRaw(), {
      pressure: this.state.narrative.pressure,
      starts: this.ratingsState.record.starts,
    });
  }

  /** Anybody's ratings, right now. The one entry point for the AI's numbers. */
  ratingsOf(driverId: string): DriverRatings | null {
    if (driverId === this.state.playerDriverId) return this.ratings();
    const d = findDriver(this.state.world, driverId);
    return d ? ratingsFor(d) : null;
  }

  /** The ceiling on each of the player's attributes. */
  ratingCaps(): Record<RatingKey, number> {
    return capsFor(this.playerRaw(), this.state.seed);
  }

  /** Race starts, exactly counted. */
  starts(): number { return this.ratingsState.record.starts; }

  /** The team's expectation of this contract. */
  contractGoal(): ContractGoal { return this.ratingsState.contract; }

  /**
   * Sets a fresh goal against the rating the player is on today.
   *
   * Called at creation and on every move of team, because a target set against
   * the rating a Formula 3 rookie carried is not a target a Formula 1 seat
   * would set. `seasonsAtTeam` resets with it: recognition is loyalty to THIS
   * garage, not tenure in the sport.
   */
  resetContractGoal(): void {
    const r = this.ratingsState;
    r.contract = newContractGoal(this.ratings().rtg, this.state.season.year);
  }

  /**
   * One race weekend, folded into the model.
   *
   * The order matters and is the whole of the method: the counters move first
   * (so `starts` is right when experience is computed), then the pure move is
   * computed against the driver as they were, then it is applied and capped,
   * then the sample is appended. Doing the sample before the move would draw a
   * chart of the driver who turned up rather than the one who left.
   */
  private applyRoundToRatings(result: RoundResult, pointsScored: number): void {
    const s = this.state;
    const r = this.ratingsState;
    if (result.order.indexOf(s.playerDriverId) < 0) return;

    recordRoundInRecord(r.record, result, s.playerDriverId, pointsScored);

    const me = this.playerRaw();
    const mate = this.teammate();
    const move = moveForRound(me, {
      world: s.world,
      season: s.season,
      tier: s.tier,
      driverId: s.playerDriverId,
      result,
      teammateId: mate?.id,
      pressure: s.narrative.pressure,
      starts: r.record.starts,
    });

    // The move lands on the PROFILE, which is authoritative, and is then
    // mirrored into the world by `syncPlayerIntoWorld`. Writing it to the world
    // record instead would be overwritten by the very next sync — this project
    // has shipped that exact bug as `narrative.departmentMorale` (§6, prep
    // slots), a mirror nothing consulted.
    const before: WorldDriver = { ...me };
    applyMove(before, move, s.seed);
    for (const key of ['skill', 'racecraft', 'consistency', 'tyreManagement',
      'wetSkill', 'aggression'] as const) {
      s.player[key] = before[key];
    }
    this.syncPlayerIntoWorld();

    r.history.push(move.sample);
    if (r.history.length > HISTORY_LIMIT) {
      r.history.splice(0, r.history.length - HISTORY_LIMIT);
    }
    this.lastRatingMove = move;
  }

  /** What the last weekend did, for the debrief and the reveal screen. */
  lastRatingMove: RatingMove | null = null;

  /**
   * The reveal, as the screen shows it: now, then, and the change.
   *
   * `86.png` prints a delta beside every attribute and a running progress
   * figure under it. Both come from here rather than from the screen, so the
   * "+8,171" and the bar cannot disagree about which two numbers they are the
   * difference between.
   */
  ratingsReveal(): {
    now: DriverRatings;
    previous: DriverRatings | null;
    caps: Record<RatingKey, number>;
    deltaPoints: Record<RatingKey, number>;
  } {
    const now = this.ratings();
    const previous = this.ratingsState.lastRevealed;
    const caps = this.ratingCaps();
    const deltaPoints = {} as Record<RatingKey, number>;
    for (const k of RATING_KEYS) {
      const was = previous ? previous[k] : 0;
      deltaPoints[k] = levelToPoints(now[k]) - levelToPoints(was);
    }
    return { now, previous, caps, deltaPoints };
  }

  /** Marks the reveal as seen, so the next one shows the change since this. */
  markRatingsRevealed(): void {
    this.ratingsState.lastRevealed = this.ratings();
  }

  /** Every accolade with its tier and its count. */
  accolades(): AccoladeProgress[] {
    const rec = this.ratingsState.record;
    return ACCOLADES.map((a) => accoladeProgress(a, rec));
  }

  /**
   * The recognition split against the other car.
   *
   * Null when there is no other car — a Formula 3 team the player has joined
   * always has one, but a career mid-transfer briefly does not, and a screen
   * that divides by a missing team-mate is a screen that prints NaN%.
   */
  recognition(): (RecognitionSplit & { teammate: WorldDriver }) | null {
    const mate = this.teammate();
    if (!mate) return null;
    const r = this.ratingsState;
    return {
      ...recognitionFor({
        mine: this.ratings(),
        theirs: ratingsFor(mate),
        seasonsAtTeam: r.contract.seasonsAtTeam,
        contractYears: this.state.contractYears,
        meetings: r.recognition.meetings,
        academyChoice: r.recognition.academyChoice,
      }),
      teammate: mate,
    };
  }

  /**
   * A meeting with the principal, bought with a preparation slot.
   *
   * REACHES `spendPrepSlot` RATHER THAN REIMPLEMENTING IT. §7 records that
   * method as fully built and unreachable; a second morale path here would
   * have been a fifth derivation of a fact that already has one. The slot is
   * spent as a factory day — which is what a meeting in the factory is — and
   * the meeting is counted on top, because recognition is what the meeting
   * buys and morale is what the day buys.
   */
  takeMeeting(): { ok: boolean; reason: string } {
    if (this.state.prepSlotsLeft <= 0) {
      return { ok: false, reason: 'No preparation slots left before the next round.' };
    }
    this.spendPrepSlot('factory');
    this.ratingsState.recognition.meetings++;
    return { ok: true, reason: 'A morning at the factory, and they noticed.' };
  }

  /**
   * The driver market, as `88.png` draws it.
   *
   * The player's own tier, so a Formula 3 driver looks at Formula 3 and a
   * Formula 1 one looks at Formula 1. Reads the ratings model — market value
   * and acclaim are both functions of the rating, which is why the model had
   * to exist before this screen could.
   */
  market(sort: MarketSort = 'acclaim'): MarketEntry[] {
    return sortMarket(buildMarket({
      world: this.state.world,
      tier: this.state.tier,
      playerDriverId: this.state.playerDriverId,
      playerStarts: this.ratingsState.record.starts,
      pressure: this.state.narrative.pressure,
      seed: this.state.seed,
      teamName: (id) => this.teamNameOf(id),
    }), sort);
  }

  // =======================================================================
  // My Team — the money and the factory
  // =======================================================================

  get myTeam(): MyTeamState | null { return this.state.team; }

  /** The player's own constructor, as the world holds it. */
  myTeamRecord(): WorldTeam | null {
    const t = this.state.team;
    return t ? findTeam(this.state.world, t.teamId) ?? null : null;
  }

  /**
   * Rebuilds the grid overlay from the world.
   *
   * CALLED AFTER EVERY MUTATION, AND IT HAS TO BE. `installWorld` converts each
   * `WorldTeam` into a plain `Team` by calling `performanceOf` ONCE, and that
   * `Team` is what `getTeam` hands to `CarEntry`. So an upgrade written into
   * `world` and not re-installed is an upgrade the physics will never see —
   * which is precisely the class of bug this whole design exists to eliminate,
   * reintroduced one layer higher up. Every method below that changes a car, a
   * colour or a name ends with this call.
   */
  private refreshGrid(): void {
    installWorld(this.state.world);
  }

  /** The second driver at the player's team, whoever it currently is. */
  teammate(): WorldDriver | null {
    const t = this.state.team;
    if (!t) return null;
    const seats = this.state.world.tiers.F1.drivers.filter(
      (d) => d.teamId === t.teamId && !d.reserve && !d.retired
        && d.id !== this.state.playerDriverId);
    const mate = seats[0] ?? null;
    // The stored id is a convenience for screens; the world is the truth, and
    // the transfer market can change it behind the player's back between
    // seasons. Resyncing here means the two can never disagree.
    if (mate) t.teammateDriverId = mate.id;
    return mate;
  }

  /**
   * Charges the season's fixed bill, up front.
   *
   * ANNUALLY AND IN ADVANCE, rather than accruing per round, because the cost
   * cap is an annual limit and a player deciding whether they can afford a
   * concept project in round two needs to know what the wage bill is going to
   * be by round eleven. Accruing would let somebody commission everything early
   * and discover in October that the staff they employ had been counting
   * against the cap the whole time. This way the headroom on the screen is the
   * real headroom.
   */
  beginTeamSeason(): void {
    const t = this.state.team;
    if (!t) return;
    const factory = factoryAnnualCostUsd(t.departments);
    const mate = this.teammate();
    const engine = engineOffers(t.teamId, this.state.season.year, this.state.narrative.reputation)
      .find((o) => o.unit.id === t.powerUnitId);

    t.ledger.staffUsd = factory.staffUsd;
    t.ledger.facilityUsd = factory.facilityUsd;
    // The owner-driver takes no salary. The second car does.
    t.ledger.salariesUsd = mate?.salaryUsd ?? 0;
    t.ledger.engineUsd = engine?.costUsd ?? 0;

    t.cashUsd -= t.ledger.staffUsd + t.ledger.facilityUsd
      + t.ledger.salariesUsd + t.ledger.engineUsd;
    this.refreshGrid();
  }

  /** Cap already committed this season, including the full-season factory bill. */
  capCommittedUsd(): number {
    const t = this.state.team;
    return t ? capSpent(t.ledger) : 0;
  }

  /** How much of the cost cap is left to commit. Can be negative after a breach. */
  capHeadroomUsd(): number {
    return COST_CAP_USD - this.capCommittedUsd();
  }

  /**
   * Whether a commitment is allowed, and what it would cost.
   *
   * Returns rather than throws, because every screen that can spend money has
   * to be able to show the reason BEFORE the button is pressed. A cap breach is
   * a decision the player is entitled to make deliberately, so `overCap` is
   * reported rather than refused — the caller confirms it, naming the penalty.
   */
  canCommit(costUsd: number, opts: { underCap: boolean }): CommitCheck {
    const t = this.state.team;
    if (!t) return { ok: false, overCap: false, reason: 'Not a My Team career.' };
    if (costUsd > t.cashUsd) {
      return {
        ok: false, overCap: false,
        reason: `Costs $${fmtM(costUsd)}M and there is $${fmtM(t.cashUsd)}M in the bank.`,
      };
    }
    if (opts.underCap && costUsd > this.capHeadroomUsd()) {
      const over = costUsd - this.capHeadroomUsd();
      return {
        ok: true, overCap: true,
        reason: `Takes you $${fmtM(over)}M past the cost cap. `
          + breachPenaltyFor(this.capCommittedUsd() + costUsd).summary,
      };
    }
    return { ok: true, overCap: false, reason: '' };
  }

  /**
   * The gate every commitment goes through.
   *
   * WHY THIS IS SEPARATE FROM `canCommit`, AND WHY IT HAD TO BE. `canCommit`
   * reports; this one decides. The first version of this code had only the
   * reporter, and every commit path checked its `ok` field — which is TRUE for
   * an over-cap commitment, because being able to afford something and being
   * allowed to buy it are different questions. So a career that spent
   * aggressively sailed straight past the cost cap to $160M of a $135M ceiling
   * without anything stopping it, and `probe:myteam` reported exactly that on
   * its first run: "committed $160.2M against a $135M cap without being
   * stopped". The cap was a displayed number, which is the one thing this whole
   * design says a management system must never be.
   *
   * A breach is still a decision the player is entitled to make — it is a real
   * thing teams do — so it is not forbidden. It requires `allowBreach`, which
   * the screen only passes after a confirmation naming the penalty.
   */
  private gate(costUsd: number, underCap: boolean, allowBreach: boolean): CommitCheck {
    const check = this.canCommit(costUsd, { underCap });
    if (!check.ok) return check;
    if (check.overCap && !allowBreach) {
      return { ok: false, overCap: true, reason: check.reason, needsConfirmation: true };
    }
    return check;
  }

  /** The five manufacturers, and whether each will deal with this team today. */
  engineOffers(): ReturnType<typeof engineOffers> {
    const t = this.state.team;
    return engineOffers(
      t?.teamId ?? this.state.teamId,
      this.state.season.year,
      this.state.narrative.reputation);
  }

  /**
   * Who the player could put in the second car.
   *
   * Two sources, and both are real people in this save's world rather than a
   * list of names on a screen: drivers who currently hold no seat — reserves,
   * anyone the market left over — and a generated pool of free agents for this
   * season. Whoever is signed becomes a `WorldDriver` and races.
   */
  driverMarket(): WorldDriver[] {
    const world = this.state.world;
    const mate = this.teammate();
    const seatless = TIER_ORDER.flatMap((tier) => world.tiers[tier].drivers)
      .filter((d) => !d.retired && d.reserve && d.id !== this.state.playerDriverId
        && d.id !== mate?.id);
    // Seeded on the season as well as the career, so the market changes between
    // years rather than offering the same eight people for a decade.
    const fresh = generateFreeAgents(
      new Rng((this.state.seed ^ 0x63a1d7f5) + this.state.season.year * 7919),
      6, this.state.season.year);
    return [...seatless, ...fresh].sort((a, b) => b.skill - a.skill);
  }

  /** What a project would cost and deliver, before it is commissioned. */
  quoteProject(department: DepartmentId, ambition: Ambition, efficiency = false): {
    costUsd: number; rounds: number; gain: number; qcFailure: number;
  } {
    const t = this.state.team;
    const spec = AMBITION[ambition];
    const dept = t?.departments[department]
      ?? { level: 1, staff: MIN_STAFF, morale: 50 };
    return {
      costUsd: projectCostUsd(spec, department, dept.morale, efficiency),
      rounds: projectRounds(spec, dept),
      gain: projectGain(spec, dept),
      qcFailure: qcFailureChance(spec, dept),
    };
  }

  /**
   * Commissions an upgrade.
   *
   * The quality-control roll happens HERE, at commission time, and is hidden
   * until delivery. That is deliberate and it is the difference between a
   * mechanic and a slot machine: the outcome is decided by the state of the
   * department on the day the work was ordered, so the player's earlier choices
   * — what they said to the press, whether they went to the factory instead of
   * a media day — are what determined it, rather than a coin flip four rounds
   * later that nothing could have influenced.
   */
  startProject(
    department: DepartmentId, ambition: Ambition, efficiency = false,
    opts: { allowBreach?: boolean } = {},
  ): { ok: boolean; reason: string; needsConfirmation?: boolean; project?: UpgradeProject } {
    const t = this.state.team;
    if (!t) return { ok: false, reason: 'Not a My Team career.' };
    if (t.developmentBanRounds > 0) {
      return {
        ok: false,
        reason: `Development ban: ${t.developmentBanRounds} more `
          + `${t.developmentBanRounds === 1 ? 'round' : 'rounds'}.`,
      };
    }
    if (department !== 'aero' && efficiency) {
      return { ok: false, reason: 'Only an aerodynamics project can target efficiency.' };
    }
    if (t.projects.some((p) => p.department === department)) {
      return { ok: false, reason: `${department} is already working on something.` };
    }

    const quote = this.quoteProject(department, ambition, efficiency);
    const check = this.gate(quote.costUsd, true, opts.allowBreach ?? false);
    if (!check.ok) {
      return { ok: false, reason: check.reason, needsConfirmation: check.needsConfirmation };
    }

    const dept = t.departments[department];
    const project: UpgradeProject = {
      id: `p${t.nextProjectId++}`,
      department,
      ambition,
      efficiency,
      costUsd: quote.costUsd,
      roundsLeft: quote.rounds,
      gain: quote.gain,
      willFailQc: this.factoryRng.chance(qcFailureChance(AMBITION[ambition], dept)),
      startedRound: this.round,
    };
    t.projects.push(project);
    t.cashUsd -= quote.costUsd;
    t.ledger.developmentUsd += quote.costUsd;
    return { ok: true, reason: '', project };
  }

  /**
   * Cancels a project.
   *
   * HALF THE MONEY COMES BACK AND NONE OF THE CAP DOES. Cap space, once
   * committed, is spent — that is how the real regulation works and it is what
   * stops "start everything, cancel what you cannot afford" being a free option.
   */
  cancelProject(id: string): boolean {
    const t = this.state.team;
    if (!t) return false;
    const i = t.projects.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const [p] = t.projects.splice(i, 1);
    t.cashUsd += Math.round(p.costUsd * 0.5);
    return true;
  }

  /** Takes on or lets go staff, charged pro-rata for the rest of the season. */
  changeStaff(
    department: DepartmentId, delta: number, opts: { allowBreach?: boolean } = {},
  ): { ok: boolean; reason: string; needsConfirmation?: boolean } {
    const t = this.state.team;
    if (!t) return { ok: false, reason: 'Not a My Team career.' };
    const dept = t.departments[department];
    const target = clamp(dept.staff + delta, MIN_STAFF, MAX_STAFF);
    const change = target - dept.staff;
    if (change === 0) {
      return {
        ok: false,
        reason: delta > 0 ? `Already at the ${MAX_STAFF} limit.` : `Already at the ${MIN_STAFF} minimum.`,
      };
    }

    const rounds = this.calendar.length;
    const remaining = Math.max(0, rounds - this.round) / Math.max(1, rounds);
    const cost = Math.round(change * STAFF_WAGE_USD * remaining);

    if (cost > 0) {
      const check = this.gate(cost, true, opts.allowBreach ?? false);
      if (!check.ok) {
        return { ok: false, reason: check.reason, needsConfirmation: check.needsConfirmation };
      }
    }
    dept.staff = target;
    t.cashUsd -= cost;
    t.ledger.staffUsd += cost;
    // Losing people is felt. Hiring is not a morale event, because nobody has
    // ever been cheered up by a colleague arriving.
    if (change < 0) this.nudgeMorale(department, -6);
    return { ok: true, reason: '' };
  }

  /** Builds the next level of a facility. Capital cost, under the cap. */
  upgradeFacility(
    department: DepartmentId, opts: { allowBreach?: boolean } = {},
  ): { ok: boolean; reason: string; needsConfirmation?: boolean } {
    const t = this.state.team;
    if (!t) return { ok: false, reason: 'Not a My Team career.' };
    const dept = t.departments[department];
    if (dept.level >= MAX_FACILITY_LEVEL) {
      return { ok: false, reason: 'This facility is already at level ' + MAX_FACILITY_LEVEL + '.' };
    }
    const cost = facilityUpgradeCostUsd(dept.level);
    // The upkeep of the new level for the rest of this season, WORKED OUT
    // BEFORE THE GATE AND PUT THROUGH IT.
    //
    // This used to be charged to `ledger.facilityUsd` after `gate()` had
    // approved the capital cost alone — and `facilityUsd` is one of the three
    // lines `capSpent` sums, so an approval for $28.0M could spend $31.4M and
    // carry the team $3.4M past a $135.0M cost cap with no confirmation ever
    // shown. A gate that approves one figure and then charges another is not a
    // gate. Art. 3 of the Financial Regulations counts committed cost, not the
    // headline price of the building. See `probe:myteam` invariant 3b, which
    // puts the cap in exactly that window on purpose.
    const rounds = this.calendar.length;
    const remaining = Math.max(0, rounds - this.round) / Math.max(1, rounds);
    const extraUpkeep = Math.round(
      (facilityUpkeepUsd(dept.level + 1) - facilityUpkeepUsd(dept.level)) * remaining);
    const check = this.gate(cost + extraUpkeep, true, opts.allowBreach ?? false);
    if (!check.ok) {
      return { ok: false, reason: check.reason, needsConfirmation: check.needsConfirmation };
    }

    dept.level++;
    t.cashUsd -= cost;
    t.ledger.facilityUsd += cost;
    t.cashUsd -= extraUpkeep;
    t.ledger.facilityUsd += extraUpkeep;
    // A department given a new building is a department that believes you.
    this.nudgeMorale(department, 9);
    return { ok: true, reason: '' };
  }

  /**
   * Buys a faster pit crew.
   *
   * Straight to `TeamPerformance.pitCrewTimeS`, which `PitStop.ts` uses as the
   * stationary time and `Strategy.ts` already prices when it decides how many
   * stops to make. Six hundredths a step is not a rounding error over a season:
   * it is the difference between a two-stop being worth it and not.
   */
  investInPitCrew(opts: { allowBreach?: boolean } = {}): {
    ok: boolean; reason: string; needsConfirmation?: boolean;
  } {
    const t = this.state.team;
    const team = this.myTeamRecord();
    if (!t || !team) return { ok: false, reason: 'Not a My Team career.' };
    const check = this.gate(PIT_CREW_STEP_USD, true, opts.allowBreach ?? false);
    if (!check.ok) {
      return { ok: false, reason: check.reason, needsConfirmation: check.needsConfirmation };
    }
    if (!investInPitCrew(team)) {
      return { ok: false, reason: 'This crew is as quick as a crew gets.' };
    }
    t.cashUsd -= PIT_CREW_STEP_USD;
    t.ledger.developmentUsd += PIT_CREW_STEP_USD;
    this.refreshGrid();
    return { ok: true, reason: '' };
  }

  /**
   * Moves a department's morale, keeping the two copies of it in step.
   *
   * THERE ARE TWO COPIES AND ONLY ONE OF THEM IS AUTHORITATIVE. The department
   * record is the truth, because it is what the cost and quality-control
   * formulas read; `narrative.departmentMorale` is the mirror the narrative
   * layer and the save's driver-career shape already had. Every write goes
   * through here so they cannot drift — which they did, silently, for as long
   * as the preparation slots were writing only to the mirror.
   */
  nudgeMorale(department: DepartmentId, by: number): void {
    const t = this.state.team;
    if (!t) {
      const n = this.state.narrative.departmentMorale;
      n[department] = clamp((n[department] ?? 50) + by, 0, 100);
      return;
    }
    const dept = t.departments[department];
    dept.morale = clamp(dept.morale + by, 0, 100);
    this.state.narrative.departmentMorale[department] = dept.morale;
  }

  /** The whole factory at once. What a media day and a factory visit move. */
  nudgeEveryDepartment(by: number): void {
    if (this.state.team) {
      for (const id of DEPARTMENT_IDS) this.nudgeMorale(id, by);
      return;
    }
    const n = this.state.narrative.departmentMorale;
    for (const k of Object.keys(n)) n[k] = clamp(n[k] + by, 0, 100);
  }

  /**
   * Signs a power unit.
   *
   * The one management decision whose effect is visible in a speed trap. It
   * multiplies `powerMult` and `ersMult` and adds to `failureRate` in
   * `performanceOf`, so a career that switches from Audi to Ferrari gains about
   * five per cent of combustion power and takes on about two per cent more
   * chance of not finishing — and the player finds that out at Monza, not on
   * this screen.
   */
  signPowerUnit(unitId: string, years = 3): { ok: boolean; reason: string } {
    const t = this.state.team;
    const team = this.myTeamRecord();
    if (!t || !team) return { ok: false, reason: 'Not a My Team career.' };
    if (unitId === t.powerUnitId) return { ok: false, reason: 'Already your supplier.' };

    const offer = engineOffers(t.teamId, this.state.season.year, this.state.narrative.reputation)
      .find((o) => o.unit.id === unitId);
    if (!offer) return { ok: false, reason: 'No such manufacturer.' };
    if (!offer.available) return { ok: false, reason: offer.reason };

    // Breaking a deal that still has time to run costs a fee, outside the cap.
    if (t.powerUnitYearsLeft > 0 && t.powerUnitId) {
      const current = engineOffers(t.teamId, this.state.season.year, 100)
        .find((o) => o.unit.id === t.powerUnitId);
      if (current) {
        const fee = engineBreakFeeUsd(current.unit, t.powerUnitYearsLeft);
        if (fee > t.cashUsd) {
          return {
            ok: false,
            reason: `Breaking the ${current.unit.shortName} deal costs $${fmtM(fee)}M `
              + `and there is $${fmtM(t.cashUsd)}M in the bank.`,
          };
        }
        t.cashUsd -= fee;
        t.ledger.engineUsd += fee;
      }
    }

    t.powerUnitId = unitId;
    t.powerUnitYearsLeft = years;
    team.powerUnitId = unitId;
    this.refreshGrid();
    return { ok: true, reason: '' };
  }

  /**
   * Puts a new driver in the second car.
   *
   * The outgoing driver becomes a reserve rather than being deleted, so the
   * transfer market can give them a seat again — the same rule the player's own
   * arrival in Formula 3 follows, and the reason a career's world never quietly
   * loses people.
   */
  signTeammate(driver: WorldDriver, years = 2): { ok: boolean; reason: string } {
    const t = this.state.team;
    if (!t) return { ok: false, reason: 'Not a My Team career.' };
    // The first year of a salary is payable now; it sits outside the cap.
    const check = this.canCommit(driver.salaryUsd, { underCap: false });
    if (!check.ok) return { ok: false, reason: check.reason };

    const f1 = this.state.world.tiers.F1;
    const current = this.teammate();
    if (current) current.reserve = true;

    const taken = new Set(f1.drivers.filter((d) => !d.retired).map((d) => d.raceNumber));
    taken.delete(driver.raceNumber);
    const existing = findDriver(this.state.world, driver.id);
    if (existing) {
      transfer(this.state.world, driver.id, t.teamId, 'F1');
      existing.contractYears = years;
    } else {
      f1.drivers.push({
        ...driver,
        tier: 'F1',
        teamId: t.teamId,
        reserve: false,
        contractYears: years,
        raceNumber: taken.has(driver.raceNumber)
          ? (availableNumbers(taken)[0] ?? driver.raceNumber)
          : driver.raceNumber,
      });
    }

    t.cashUsd -= driver.salaryUsd;
    t.ledger.salariesUsd += driver.salaryUsd;
    t.teammateDriverId = driver.id;

    // A driver signed mid-season joins a championship already in progress, so
    // they need a standings entry or their points have nowhere to go.
    const ts = this.state.season.tiers.F1;
    if (!ts.standings.some((e) => e.driverId === driver.id)) {
      ts.standings.push({
        driverId: driver.id, teamId: t.teamId, points: 0, wins: 0, podiums: 0,
        poles: 0, fastestLaps: 0, dnfs: 0, bestFinish: 99,
      });
    }
    this.refreshGrid();
    return { ok: true, reason: '' };
  }

  /** Repaints the car. Reaches `team.colour`, which is what `CarMesh` paints. */
  applyLivery(design: {
    colour: number; accent: number; trim: number;
    family: string; finish: 'gloss' | 'satin' | 'matte'; mark: number;
  }): void {
    const t = this.state.team;
    const team = this.myTeamRecord();
    if (!t || !team) return;
    t.colour = design.colour;
    t.accent = design.accent;
    t.trim = design.trim;
    t.liveryFamily = design.family;
    t.liveryFinish = design.finish;
    t.liveryMark = design.mark;
    team.colour = design.colour;
    team.accent = design.accent;
    this.refreshGrid();
  }

  /**
   * One round of the factory: income in, projects on, deliveries out.
   *
   * Called from `recordPlayerRound`, so a season the player simulates and a
   * season they drive advance the factory identically. A project that only
   * progressed on driven weekends would make skipping a race a development
   * penalty, which nothing in the design says it should be.
   */
  private advanceFactory(): ProjectDelivery[] {
    const t = this.state.team;
    if (!t) return [];

    t.cashUsd += commercialIncomePerRound(this.state.narrative.fanRating, this.calendar.length);
    t.ledger.commercialUsd += commercialIncomePerRound(
      this.state.narrative.fanRating, this.calendar.length);

    if (t.developmentBanRounds > 0) t.developmentBanRounds--;

    const team = this.myTeamRecord();
    const delivered: ProjectDelivery[] = [];
    const still: UpgradeProject[] = [];
    for (const p of t.projects) {
      p.roundsLeft--;
      if (p.roundsLeft > 0) { still.push(p); continue; }
      if (p.willFailQc || !team) {
        delivered.push({ project: p, passed: false });
        // A part that failed is a department that knows it failed.
        this.nudgeMorale(p.department, -5);
      } else {
        applyUpgrade(team, p);
        delivered.push({ project: p, passed: true });
        this.nudgeMorale(p.department, 4);
      }
    }
    t.projects = still;
    if (delivered.length > 0) this.refreshGrid();
    return delivered;
  }

  /**
   * Closes the team's financial season: prize money, then the cap audit.
   *
   * IN THAT ORDER, AND THE ORDER MATTERS. The audit deducts constructors'
   * points, and the constructors' table is what decides prize money — so the
   * prize is paid on the position the team earned on track and the penalty is
   * applied to the championship afterwards, which is how the real thing works
   * and is a good deal more painful than losing the money as well.
   */
  private settleTeamSeason(): TeamSeasonReport | null {
    const t = this.state.team;
    if (!t) return null;

    const ts = this.state.season.tiers.F1;
    const table = Object.entries(ts.constructorPoints).sort((a, b) => b[1] - a[1]);
    const position = Math.max(1, table.findIndex(([id]) => id === t.teamId) + 1);
    const prize = prizeMoneyFor(position);
    t.cashUsd += prize;
    t.ledger.prizeUsd = prize;

    const spent = capSpent(t.ledger);
    const penalty = breachPenaltyFor(spent);
    if (penalty.severity !== 'none') {
      ts.constructorPoints[t.teamId] = Math.max(
        0, (ts.constructorPoints[t.teamId] ?? 0) - penalty.pointsDeducted);
      t.cashUsd -= penalty.fineUsd;
      t.ledger.fineUsd += penalty.fineUsd;
      t.developmentBanRounds = penalty.developmentBanRounds;
      t.pointsDeducted = penalty.pointsDeducted;
      // Being caught is felt across the whole factory.
      for (const id of DEPARTMENT_IDS) this.nudgeMorale(id, -8);
    } else {
      t.pointsDeducted = 0;
    }

    return {
      constructorPosition: position,
      prizeUsd: prize,
      capSpentUsd: spent,
      penalty,
      closingCashUsd: t.cashUsd,
      closingLedger: { ...t.ledger },
    };
  }

  /** Fresh ledger, fresh cap, and the new season's bill charged up front. */
  private rollTeamIntoNextSeason(): void {
    const t = this.state.team;
    if (!t) return;
    t.ledger = emptyLedger();
    // Projects do not survive a regulation change. Anything unfinished at the
    // end of a season is written off, which is why a concept started in round
    // ten is a bad idea and why the screen says how many rounds are left.
    t.projects = [];
    if (t.powerUnitYearsLeft > 0) t.powerUnitYearsLeft--;
    this.beginTeamSeason();
  }

  // =======================================================================
  // Narrative events
  // =======================================================================

  private readonly events = new CareerEventManager();

  /** Picks an event for this moment, or null when nothing applies. */
  drawEvent(ctx: EventContext): CareerEvent | null {
    return this.events.pick(this, ctx, this.rng);
  }

  applyEventChoice(ev: CareerEvent, choiceIndex: number): string[] {
    return this.events.applyChoice(this, ev, choiceIndex);
  }

  // =======================================================================
  // Display helpers
  // =======================================================================

  displayName(driverId: string): string {
    if (driverId === this.state.playerDriverId) {
      return this.state.player.firstName + ' ' + this.state.player.lastName;
    }
    const d = findDriver(this.state.world, driverId);
    return d ? d.firstName + ' ' + d.lastName : driverId;
  }

  displayCode(driverId: string): string {
    if (driverId === this.state.playerDriverId) return this.state.player.code;
    return findDriver(this.state.world, driverId)?.code ?? '???';
  }

  teamNameOf(teamId: string): string {
    return findTeam(this.state.world, teamId)?.name ?? teamId;
  }
}
