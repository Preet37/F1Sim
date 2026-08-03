import { clamp, clamp01, Rng } from '../core/MathUtils';
import { POWER_UNITS, type PowerUnit } from '../data/roster';
import { UPGRADE_LIMIT, emptyUpgrades, type TeamUpgrades, type WorldDriver, type WorldTeam } from './World';

/**
 * My Team: the money, the factory, and the engine deal.
 *
 * THE RULE THIS FILE IS WRITTEN AGAINST. Every quantity here has to end up in a
 * `TeamPerformance` field, because that is the entire bandwidth between a career
 * and the car the physics integrates. A management system that stops at a number
 * on a screen is a spreadsheet, and this project has already had one of those —
 * `carDevelopment` used to be read only by the paper model, so developing your
 * car improved the races you skipped and did nothing to the ones you drove.
 *
 * So the chain is stated once, here, and every screen and probe is measured
 * against it:
 *
 *     budget → what you can commission
 *     cost cap → the hard ceiling on how much of that budget can be development
 *     department morale → what a project COSTS and whether it PASSES QC
 *     a delivered project → `WorldTeam.upgrades`
 *     `WorldTeam.upgrades` → `performanceOf` → `TeamPerformance`
 *     `TeamPerformance` → `specForTeam` → `icePowerW`, `clBase`, `cdBase`,
 *                                         `baseMu`, `dryMassKg`
 *
 * Nothing in this file is allowed to stop before the end of that chain. Where
 * something does — commercial income, below — it says so in its own comment
 * rather than being dressed up.
 */

// ===========================================================================
// Money
// ===========================================================================

/** What the player starts with. Enough for one good season or two thin ones. */
export const STARTING_BUDGET_USD = 150_000_000;

/**
 * The cost cap, per season.
 *
 * A HARD BOUND ON DEVELOPMENT, NOT ON CASH, and the distinction is the whole
 * point of modelling it. A team can be rich and still unable to spend, because
 * the cap counts what goes into the car rather than what goes out of the bank —
 * driver salaries and the engine supply deal sit outside it, exactly as they do
 * in the real regulations. That is what makes "sign a quick, expensive
 * team-mate" a genuinely different decision from "run a concept aero project":
 * one of them competes for cash and the other competes for cap.
 */
export const COST_CAP_USD = 135_000_000;

/** Under 5% over is a minor breach. Above it the penalties get serious. */
export const MINOR_BREACH_FRACTION = 0.05;

/**
 * Constructors' prize money, P1 down.
 *
 * Twelve entries because a My Team career makes the grid twelve teams. The
 * curve is the real shape: the winner takes about three times the last-placed
 * team, and the drop from first to second is bigger than the drop from second
 * to third, which is what makes a championship worth winning commercially and
 * not only sportingly.
 */
export const PRIZE_MONEY_USD: readonly number[] = [
  70_000_000, 58_000_000, 50_000_000, 44_000_000, 39_000_000, 35_000_000,
  32_000_000, 29_000_000, 27_000_000, 25_000_000, 23_000_000, 22_000_000,
];

export function prizeMoneyFor(constructorPosition: number): number {
  const i = clamp(Math.round(constructorPosition) - 1, 0, PRIZE_MONEY_USD.length - 1);
  return PRIZE_MONEY_USD[i];
}

/**
 * Commercial income per round.
 *
 * HONEST LABEL: this is not the sponsorship system. Sponsors — named brands with
 * minimum fan ratings, signing bonuses, contract objectives and their names
 * painted down the side of the car — are Layer 4 of `docs/CAREER_MODE.md` and
 * are NOT BUILT. What this is, is the team's baseline commercial revenue, and it
 * is here because a factory with no income at all is not a budget decision, it
 * is a countdown.
 *
 * It is tied to fan rating so the number is not a constant and so the hook the
 * sponsor system needs already exists and is already load-bearing: raising fan
 * rating raises what the team can develop, which is the loop sponsors will
 * sharpen rather than introduce.
 */
export function commercialIncomePerRound(fanRating: number, rounds: number): number {
  return Math.round(commercialIncomeAnnualUsd(fanRating) / Math.max(1, rounds));
}

/**
 * A season of commercial revenue.
 *
 * $44M with nobody watching, $84M with everybody.
 *
 * THESE NUMBERS ARE A MEASUREMENT, NOT AN OPINION. The first pass had the floor
 * at $34M, and `probe:myteam` reported the consequence over a hundred seasons:
 * a starting team's fixed annual bill is about $68M and last place pays $22M, so
 * a team that developed NOTHING AT ALL still lost about $8M a season and was
 * insolvent by its third. Eighty-five projects were commissioned across a
 * hundred seasons; the mode was a countdown rather than a budget.
 *
 * At $44M the back of the grid breaks even and every place gained in the
 * constructors' table is worth two to five million of development. The cost cap
 * only becomes the binding constraint near the front — $70M of prize money plus
 * $84M of commercial against a $68M bill and $87M of headroom — which is exactly
 * where it binds in the real sport, and it is why `probe:myteam` tests the cap
 * against a deliberately rich team rather than expecting a new one to reach it.
 */
export function commercialIncomeAnnualUsd(fanRating: number): number {
  return Math.round(44_000_000 + clamp(fanRating, 0, 100) / 100 * 40_000_000);
}

// ===========================================================================
// The factory
// ===========================================================================

export type DepartmentId = 'aero' | 'chassis' | 'powertrain';

export const DEPARTMENT_IDS: readonly DepartmentId[] = ['aero', 'chassis', 'powertrain'];

export const DEPARTMENT_NAME: Record<DepartmentId, string> = {
  aero: 'Aerodynamics',
  chassis: 'Chassis',
  powertrain: 'Powertrain',
};

/** What each department buys, in the player's words and in the car's. */
export const DEPARTMENT_EFFECT: Record<DepartmentId, string> = {
  aero: 'Downforce, and the drag that comes with it',
  chassis: 'Mechanical grip and tyre life',
  powertrain: 'Power, deployment and reliability',
};

export interface DepartmentState {
  /** Facility level, 1..5. Cuts project duration and quality-control failures. */
  level: number;
  /** Headcount. Scales what a project delivers and what the wage bill is. */
  staff: number;
  /** 0..100. Decides what a project costs and whether it passes QC. */
  morale: number;
}

export const MIN_STAFF = 40;
export const MAX_STAFF = 320;
export const MAX_FACILITY_LEVEL = 5;

/**
 * Annual wage bill per head. Inside the cap, like every operational cost.
 *
 * $130k rather than a real engineer's salary, because `staff` here is a
 * department's whole establishment — designers, aerodynamicists, technicians,
 * the composites shop — averaged. A starting team's 235 heads therefore cost
 * about $31M of a $135M cap, which leaves roughly $87M of cap for development
 * and makes CASH the constraint in the first seasons and CAP the constraint once
 * the team is commercially successful. That crossover is the mode.
 */
export const STAFF_WAGE_USD = 130_000;

/** Annual upkeep of a facility at each level, per department. Inside the cap. */
export function facilityUpkeepUsd(level: number): number {
  return clamp(level, 1, MAX_FACILITY_LEVEL) * 3_400_000;
}

/** What it costs to take a facility to the next level. Inside the cap. */
export function facilityUpgradeCostUsd(currentLevel: number): number {
  if (currentLevel >= MAX_FACILITY_LEVEL) return Infinity;
  return currentLevel * 14_000_000;
}

export type Ambition = 'refinement' | 'development' | 'concept';

export interface AmbitionSpec {
  name: string;
  /** Rounds until delivery, at facility level 3. */
  rounds: number;
  /** List price, before morale and facility. */
  costUsd: number;
  /** Fractional gain on the department's performance term, before scaling. */
  gain: number;
  /** Base probability the part fails quality control and delivers nothing. */
  qcFailure: number;
  note: string;
}

/**
 * The three ambitions.
 *
 * The interesting property is that they are NOT a straight line: a concept
 * project is nearly five times the price of a refinement for five times the
 * gain, but it takes three and a half times as long and fails quality control
 * five times as often. So the expected value per dollar is roughly flat and the
 * real choice is about RISK AND TIME — whether the season in front of you can
 * afford seven rounds of nothing, and whether your factory is in a state to be
 * trusted with something ambitious. That is a decision. A dominant option would
 * not have been.
 */
export const AMBITION: Record<Ambition, AmbitionSpec> = {
  refinement: {
    name: 'Refinement',
    rounds: 2, costUsd: 5_500_000, gain: 0.0065, qcFailure: 0.04,
    note: 'Small, quick, and it almost always works.',
  },
  development: {
    name: 'Development',
    rounds: 4, costUsd: 13_000_000, gain: 0.0150, qcFailure: 0.10,
    note: 'The standard package. Half a season of the factory.',
  },
  concept: {
    name: 'Concept',
    rounds: 7, costUsd: 26_000_000, gain: 0.0320, qcFailure: 0.22,
    note: 'A new idea. Large if it lands, and it often does not.',
  },
};

export interface UpgradeProject {
  id: string;
  department: DepartmentId;
  ambition: Ambition;
  /**
   * Aero only: spend the project on drag instead of downforce.
   *
   * The one place the player says which side of the aero trade they want. An
   * efficiency project takes drag off the car without adding load, which is
   * worth more at Monza than at Monaco, and it is priced higher because that is
   * the harder thing to find.
   */
  efficiency: boolean;
  /** What was actually committed against the cap when it was started. */
  costUsd: number;
  /** Rounds remaining until it is delivered. */
  roundsLeft: number;
  /** The gain it will apply if it passes quality control. */
  gain: number;
  /** Rolled at commission time and hidden until delivery. */
  willFailQc: boolean;
  /** The round it was started on, for the UI. */
  startedRound: number;
}

/**
 * What a project costs this department, today.
 *
 * A PROUD DEPARTMENT WORKS CHEAP. This is the formula from the design document
 * and it is the reason morale is a mechanic rather than a mood: at 100 morale a
 * project is three quarters of list price, at 0 it is a quarter over. Across a
 * season that is the difference between four development projects and three,
 * which is the difference between catching the car in front and not.
 */
export function projectCostUsd(
  spec: AmbitionSpec, department: DepartmentId, morale: number, efficiency: boolean,
): number {
  const moraleFactor = 1.25 - 0.50 * (clamp(morale, 0, 100) / 100);
  // Powertrain work is dearer than bodywork, and efficiency is dearer than load.
  const deptFactor = department === 'powertrain' ? 1.18 : 1.0;
  const kindFactor = efficiency ? 1.35 : 1.0;
  return Math.round(spec.costUsd * moraleFactor * deptFactor * kindFactor);
}

/**
 * The chance this project delivers nothing.
 *
 * The money is spent either way. That is the point: a demoralised department
 * does not deliver a worse part, it delivers a part that does not pass, and the
 * player finds out six rounds after the conversation that caused it.
 */
export function qcFailureChance(
  spec: AmbitionSpec, dept: DepartmentState,
): number {
  const moraleFactor = 1.6 - 0.8 * (clamp(dept.morale, 0, 100) / 100);
  const facilityFactor = 0.6 + 0.4 * clamp(dept.level, 1, MAX_FACILITY_LEVEL);
  return clamp01(spec.qcFailure * moraleFactor / facilityFactor);
}

/** How long a project takes here. A better facility is a faster one. */
export function projectRounds(spec: AmbitionSpec, dept: DepartmentState): number {
  // Level 3 is the reference; level 5 takes about a round off a big project and
  // level 1 adds one.
  const shift = Math.round((3 - clamp(dept.level, 1, MAX_FACILITY_LEVEL)) * spec.rounds * 0.14);
  return Math.max(1, spec.rounds + shift);
}

/**
 * What a project delivers if it passes.
 *
 * Headcount scales it and the facility scales it, which is what makes staffing
 * and building a decision rather than a display. Both are deliberately
 * sub-linear: doubling a department does not double its output, because the
 * real constraint on a design office has never been how many people are in it.
 */
export function projectGain(
  spec: AmbitionSpec, dept: DepartmentState,
): number {
  const staffFactor = 0.72 + 0.55 * Math.sqrt(clamp(dept.staff, MIN_STAFF, MAX_STAFF) / MAX_STAFF);
  const facilityFactor = 0.70 + 0.15 * clamp(dept.level, 1, MAX_FACILITY_LEVEL);
  return spec.gain * staffFactor * facilityFactor;
}

/**
 * Applies a delivered project to the team's car.
 *
 * THE LINE THIS WHOLE FILE EXISTS FOR. After this call, `performanceOf(team)`
 * returns a different record, `specForTeam` turns that record into a different
 * `VehicleSpec`, and the car the player drives at the next round has more
 * downforce, more grip or more power than the one they drove at the last one.
 */
export function applyUpgrade(team: WorldTeam, project: UpgradeProject): void {
  const up = team.upgrades ?? (team.upgrades = emptyUpgrades());
  const cap = UPGRADE_LIMIT;
  switch (project.department) {
    case 'aero':
      if (project.efficiency) {
        up.aeroEfficiency = Math.min(cap.aeroEfficiency, up.aeroEfficiency + project.gain);
      } else {
        up.aero = Math.min(cap.aero, up.aero + project.gain);
      }
      break;
    case 'chassis':
      up.chassis = Math.min(cap.chassis, up.chassis + project.gain);
      break;
    case 'powertrain':
      up.powertrain = Math.min(cap.powertrain, up.powertrain + project.gain);
      break;
  }
}

/** The pit crew is bought directly rather than as a project: people, not parts. */
export const PIT_CREW_STEP_S = 0.06;
export const PIT_CREW_STEP_USD = 2_600_000;

export function investInPitCrew(team: WorldTeam): boolean {
  const up = team.upgrades ?? (team.upgrades = emptyUpgrades());
  if (up.pitCrew >= UPGRADE_LIMIT.pitCrew - 1e-9) return false;
  up.pitCrew = Math.min(UPGRADE_LIMIT.pitCrew, up.pitCrew + PIT_CREW_STEP_S);
  return true;
}

// ===========================================================================
// The engine deal
// ===========================================================================

export interface EngineOffer {
  unit: PowerUnit;
  /** False when the manufacturer will not talk to this team yet, and why. */
  available: boolean;
  reason: string;
  /** Cost per season for this team specifically. */
  costUsd: number;
  /** Effective multipliers this team would receive. Customer penalty included. */
  powerMult: number;
  ersMult: number;
  failureRate: number;
}

/**
 * Which manufacturers will supply this team, this season.
 *
 * Three gates, and each one is a real thing rather than a difficulty knob:
 *
 *   · A WORKS TEAM IS SERVED FIRST. A manufacturer with its own entry is not
 *     going to hand a customer the current specification, which is exactly what
 *     `customerPenalty` in `powerUnits.ts` already models.
 *   · SOME MANUFACTURERS DO NOT SUPPLY CUSTOMERS AT ALL YET. Audi opens in 2029,
 *     which means the best available deal genuinely changes mid-career and the
 *     player has to be ready for it.
 *   · REPUTATION. A struggling new constructor cannot simply buy the best engine
 *     on the grid, which is what makes the engine choice a consequence of the
 *     rest of the career rather than a free pick on a menu.
 */
export function engineOffers(
  teamId: string, season: number, reputation: number,
): EngineOffer[] {
  return POWER_UNITS.map((unit) => {
    const works = unit.worksTeamId === teamId;
    const k = works ? 1 : unit.customerPenalty;
    let available = true;
    let reason = works ? 'Works supply' : 'Customer supply';

    if (!works && season < unit.customersFrom) {
      available = false;
      reason = `Works entries only until ${unit.customersFrom}`;
    } else if (!works && reputation < unit.minReputation) {
      available = false;
      reason = `Needs ${unit.minReputation} reputation; you have ${Math.round(reputation)}`;
    }

    return {
      unit,
      available,
      reason,
      costUsd: works ? 0 : unit.costPerSeasonUsd,
      powerMult: unit.powerMult * k,
      ersMult: unit.ersMult * k,
      failureRate: unit.failureRate * (works ? 1 : 1.12),
    };
  });
}

/**
 * Breaking a supply contract early. Outside the cap, and it hurts.
 *
 * NO FLOOR ON `yearsLeft`. This used to be `Math.max(1, yearsLeft)` while
 * `Career.signPowerUnit` inlined the same arithmetic without one — two copies
 * of one formula that already disagreed, and the exported copy was the wrong
 * one: a contract with zero years left has run out, and charging 45% of a
 * season for tearing up a deal that has already expired is a fee for nothing.
 * The caller gates on `powerUnitYearsLeft > 0`, so the floor could only ever
 * have fired in the case where it is incorrect. One definition now, here,
 * because the engine deal is this module's subject.
 */
export function engineBreakFeeUsd(unit: PowerUnit, yearsLeft: number): number {
  return Math.round(unit.costPerSeasonUsd * 0.45 * yearsLeft);
}

// ===========================================================================
// The driver market
// ===========================================================================

const AGENT_FIRST = [
  'Casper', 'Idris', 'Matteo', 'Rune', 'Santiago', 'Yuki', 'Emile', 'Bo',
  'Frederik', 'Ilias', 'Marek', 'Oscar', 'Renzo', 'Tobias', 'Xavi', 'Zane',
  'Aurelio', 'Bastien', 'Cato', 'Dimitri', 'Eero', 'Gustav', 'Hugo', 'Ivar',
];
const AGENT_LAST = [
  'Aleman', 'Bracco', 'Caruso', 'Dahl', 'Eichel', 'Fontana', 'Grimaldi',
  'Hjelm', 'Isaksen', 'Jourdan', 'Kaminski', 'Larsen', 'Mistral', 'Nyberg',
  'Ostrowski', 'Pellegrin', 'Quintero', 'Roussel', 'Sandoval', 'Takahara',
  'Ueda', 'Voight', 'Wexler', 'Yilmaz', 'Zabala',
];
const AGENT_NATIONS = [
  'Italy', 'France', 'United Kingdom', 'Spain', 'Germany', 'Netherlands',
  'Brazil', 'Japan', 'Australia', 'United States', 'Denmark', 'Sweden',
  'Finland', 'Poland', 'Argentina', 'Canada', 'Belgium', 'Switzerland',
];

/**
 * The free agents a new constructor can actually sign.
 *
 * Deliberately NOT the best drivers in the world. A team that has never scored
 * a point is choosing between a veteran on the way down, a junior nobody has
 * taken a chance on, and a solid professional who will do a competent job — and
 * the spread of asking prices is what makes that a decision. The top of the
 * grid is under contract; the market for a new entry is the bottom of it.
 *
 * These become REAL `WorldDriver` records in this save's world, so whoever is
 * signed drives the second car in every session with their own skill,
 * aggression and tyre management, qualifies on merit, scores constructors'
 * points, and beats the player or does not.
 */
export function generateFreeAgents(rng: Rng, count = 8, season = 2026): WorldDriver[] {
  const out: WorldDriver[] = [];
  const usedNumbers = new Set<number>();
  for (let i = 0; i < count; i++) {
    // Three archetypes, in rotation, so the pool always contains a real choice
    // rather than eight versions of the same driver at eight prices.
    const kind = i % 3;
    const age = kind === 0 ? 34 + rng.int(0, 5)      // the veteran
      : kind === 1 ? 19 + rng.int(0, 3)              // the junior
        : 25 + rng.int(0, 6);                        // the professional
    const centre = kind === 0 ? 0.76 : kind === 1 ? 0.68 : 0.74;
    const skill = clamp01(rng.gaussian(centre, 0.05));
    const experience = kind === 0 ? 8 + rng.int(0, 7) : kind === 1 ? 0 : 2 + rng.int(0, 5);

    let raceNumber = 2 + rng.int(0, 96);
    let guard = 0;
    while (usedNumbers.has(raceNumber) && guard++ < 200) raceNumber = 2 + rng.int(0, 96);
    usedNumbers.add(raceNumber);

    const last = rng.pick(AGENT_LAST);
    out.push({
      id: `agent-${season}-${i}`,
      tier: 'F1',
      firstName: rng.pick(AGENT_FIRST),
      lastName: last,
      code: last.slice(0, 3).toUpperCase().padEnd(3, 'X'),
      raceNumber,
      nationality: rng.pick(AGENT_NATIONS),
      teamId: '',
      skill,
      aggression: clamp01(rng.gaussian(kind === 1 ? 0.80 : 0.70, 0.07)),
      // Experience is worth consistency, which is most of what a veteran has
      // left and most of what a junior has not got yet.
      consistency: clamp01(skill - 0.06 + Math.min(experience, 10) / 10 * 0.10),
      tyreManagement: clamp01(skill - 0.05 + Math.min(experience, 10) / 10 * 0.08),
      wetSkill: clamp01(skill + rng.gaussian(0, 0.05)),
      racecraft: clamp01(skill - 0.04 + Math.min(experience, 10) / 10 * 0.07),
      experience,
      age,
      contractYears: 0,
      // The asking price. A veteran's name costs money, a junior's does not, and
      // pace costs most of all. Outside the cap, so this competes with the
      // engine deal for cash rather than with the factory for cap.
      salaryUsd: Math.round(
        1_800_000
        + Math.pow(clamp01(skill - 0.6) / 0.4, 1.8) * 16_000_000
        + Math.min(experience, 12) * 260_000),
      reserve: false,
    });
  }
  return out;
}

// ===========================================================================
// The season ledger
// ===========================================================================

/**
 * Every dollar in and out, for one season.
 *
 * Kept itemised rather than as a running balance because the cost cap only
 * counts three of these seven lines, and a career that stored one number could
 * not tell the player which of their commitments was the one costing them their
 * development ceiling. `probe:myteam` reconstructs the cash balance from this
 * record every season and fails if it disagrees with the balance the career is
 * carrying, which is the only way an accounting bug is ever found.
 */
export interface Ledger {
  /** Income. */
  prizeUsd: number;
  commercialUsd: number;
  /** Outside the cap. */
  salariesUsd: number;
  engineUsd: number;
  /**
   * The cost-cap fine, if the season ended in a breach. OUTSIDE THE CAP, since
   * a penalty for overspending that itself counted as spending would compound.
   *
   * It is on the ledger at all because it was not: `settleTeamSeason` took it
   * straight off `cashUsd` with no entry, so the largest single outgoing in the
   * mode was invisible to `ledgerExpenditure` and therefore to `probe:myteam`
   * invariant 2, "the books balance". A career could lose $38M and reconcile.
   */
  fineUsd: number;
  /** Under the cap. */
  developmentUsd: number;
  facilityUsd: number;
  staffUsd: number;
}

export function emptyLedger(): Ledger {
  return {
    prizeUsd: 0, commercialUsd: 0, salariesUsd: 0, engineUsd: 0, fineUsd: 0,
    developmentUsd: 0, facilityUsd: 0, staffUsd: 0,
  };
}

/** What this season has committed against the cost cap. */
export function capSpent(l: Ledger): number {
  return l.developmentUsd + l.facilityUsd + l.staffUsd;
}

export function ledgerIncome(l: Ledger): number {
  return l.prizeUsd + l.commercialUsd;
}

export function ledgerExpenditure(l: Ledger): number {
  return l.salariesUsd + l.engineUsd + l.fineUsd + capSpent(l);
}

export type BreachSeverity = 'none' | 'minor' | 'major';

export function breachSeverity(spentUsd: number): BreachSeverity {
  if (spentUsd <= COST_CAP_USD) return 'none';
  if (spentUsd <= COST_CAP_USD * (1 + MINOR_BREACH_FRACTION)) return 'minor';
  return 'major';
}

export interface BreachPenalty {
  severity: BreachSeverity;
  /** Constructors' points removed. */
  pointsDeducted: number;
  /** Rounds of the following season during which nothing can be commissioned. */
  developmentBanRounds: number;
  fineUsd: number;
  summary: string;
}

/**
 * What a breach costs.
 *
 * NOT A WARNING DIALOG. A cap that can be exceeded with a shrug is not a
 * constraint, and a constraint that cannot be exceeded at all is not a decision.
 * So it can be broken, deliberately, and it costs something the player will feel
 * in the championship they are trying to win.
 */
export function breachPenaltyFor(spentUsd: number): BreachPenalty {
  const severity = breachSeverity(spentUsd);
  const over = Math.max(0, spentUsd - COST_CAP_USD);
  if (severity === 'none') {
    return {
      severity, pointsDeducted: 0, developmentBanRounds: 0, fineUsd: 0,
      summary: 'Within the cost cap.',
    };
  }
  if (severity === 'minor') {
    const points = Math.min(20, 5 + Math.round(over / 1_500_000));
    return {
      severity, pointsDeducted: points, developmentBanRounds: 0,
      fineUsd: Math.round(over * 0.6),
      summary: `Minor breach: ${points} constructors' points and a `
        + `$${(Math.round(over * 0.6) / 1e6).toFixed(1)}M fine.`,
    };
  }
  const points = Math.min(60, 20 + Math.round(over / 1_200_000));
  return {
    severity, pointsDeducted: points, developmentBanRounds: 3,
    fineUsd: Math.round(over * 1.1),
    summary: `Major breach: ${points} constructors' points, no development for the `
      + 'first three rounds of next season, and a '
      + `$${(Math.round(over * 1.1) / 1e6).toFixed(1)}M fine.`,
  };
}

// ===========================================================================
// The team a player creates
// ===========================================================================

/**
 * The chassis a brand-new constructor turns up with.
 *
 * AT THE BACK, AND IT HAS TO BE. The premise is building an empire from the
 * ground up, and a first-year team that is competitive on arrival deletes the
 * entire arc. These numbers put the car roughly where the slowest entry on the
 * grid is — about a second and a half a lap off — which is a long way from
 * hopeless and a long way from good. Every tenth of it back is something the
 * player commissioned.
 */
export const NEW_TEAM_CHASSIS: WorldTeam['chassis'] = {
  downforceMult: 0.948,
  dragMult: 1.030,
  mechanicalGripMult: 0.965,
  tireWearMult: 1.070,
  failureRate: 0.055,
  pitCrewTimeS: 2.85,
};

export function defaultDepartments(): Record<DepartmentId, DepartmentState> {
  return {
    // A new team is an aero team first, because that is where the lap time is
    // and because it is the department a start-up can actually staff.
    aero: { level: 2, staff: 100, morale: 62 },
    chassis: { level: 2, staff: 80, morale: 60 },
    powertrain: { level: 1, staff: 55, morale: 58 },
  };
}

/** Annual wage and upkeep bill for the whole factory. All inside the cap. */
export function factoryAnnualCostUsd(
  departments: Record<DepartmentId, DepartmentState>,
): { staffUsd: number; facilityUsd: number } {
  let staffUsd = 0;
  let facilityUsd = 0;
  for (const id of DEPARTMENT_IDS) {
    staffUsd += departments[id].staff * STAFF_WAGE_USD;
    facilityUsd += facilityUpkeepUsd(departments[id].level);
  }
  return { staffUsd: Math.round(staffUsd), facilityUsd: Math.round(facilityUsd) };
}

/** A short, honest read on where the car is, for the HQ screen. */
export function upgradeSummary(up: TeamUpgrades | undefined): string {
  if (!up) return 'Nothing built yet.';
  const parts: string[] = [];
  if (up.aero > 0.0005) parts.push(`+${(up.aero * 100).toFixed(1)}% downforce`);
  if (up.aeroEfficiency > 0.0005) parts.push(`−${(up.aeroEfficiency * 100).toFixed(1)}% drag`);
  if (up.chassis > 0.0005) parts.push(`+${(up.chassis * 100).toFixed(1)}% grip`);
  if (up.powertrain > 0.0005) parts.push(`+${(up.powertrain * 100).toFixed(1)}% power`);
  if (up.pitCrew > 0.0005) parts.push(`−${up.pitCrew.toFixed(2)}s stops`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing built yet.';
}
