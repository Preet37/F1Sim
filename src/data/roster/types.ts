/**
 * The shapes the roster files are written in.
 *
 * These are deliberately NOT `Team` and `Driver` from `src/data/teams.ts`. A
 * roster entry describes a real entrant; a `Team` describes a car the physics
 * can integrate. The conversion between them happens once, in
 * `src/career/World.ts`, and it is where the tier's car, the power-unit deal and
 * this save's hidden form variance are folded together.
 *
 * Keeping the two apart is what lets the whole real-world roster be swapped for
 * a fictional one without touching a line of simulation code.
 */

export type TierId = 'F3' | 'F2' | 'F1';

export interface RosterTeam {
  id: string;
  /** Full entrant name, as it appears on an entry list. */
  name: string;
  /** Short form for a timing tower. */
  shortName: string;
  /** Three-letter code. */
  code: string;

  /**
   * Primary and secondary livery colours.
   *
   * These are how a car is identified — a broadcast timing screen uses the same
   * device — and they are the ONLY visual identity taken from the real world.
   * No badge, logo or wordmark is reproduced; the geometric team mark drawn
   * beside each name in `src/ui/TimingRow.ts` is generated from these two
   * numbers, and that is the whole of it.
   *
   * They approximate each team's published primary livery. Where a team's 2026
   * livery was not settled at the time of writing (Audi, Cadillac) the colours
   * are taken from the parent brand, and correcting one is a one-line edit here.
   */
  colour: number;
  accent: number;

  /** Power unit supplier, by id into `POWER_UNITS`. Junior tiers use ''. */
  powerUnitId: string;

  /**
   * CHASSIS performance only — the engine is applied separately.
   *
   * Splitting them is the point of the whole exercise: a customer team with a
   * good chassis and a poor engine is a real and recognisable thing, and it
   * cannot be expressed by a single team rating. Each is a multiplier on the
   * base spec in the sense `specForTeam` means.
   */
  chassis: {
    downforceMult: number;
    dragMult: number;
    mechanicalGripMult: number;
    tireWearMult: number;
    /** Non-engine terminal failures: gearbox, hydraulics, suspension. */
    failureRate: number;
    pitCrewTimeS: number;
  };

  /** How fast this team develops across a season and a career. 0..1. */
  developmentRate: number;
  /** How much the team weights experience over pace when signing. 0..1. */
  prefersExperience: number;
  /** Annual operating budget in dollars, for the transfer market's arithmetic. */
  budgetUsd: number;
}

export interface RosterDriver {
  id: string;
  firstName: string;
  lastName: string;
  /** Three-letter broadcast abbreviation. */
  code: string;
  raceNumber: number;
  nationality: string;
  teamId: string;

  /**
   * Ability, on the same 0..1 scale the simulation already uses.
   *
   * NOT FROM ANY SOURCE. Nobody publishes these; they are this project's own
   * estimates, set so that a simulated championship comes out in a plausible
   * order and so that the spread between the fastest and slowest driver is worth
   * about the half-second a lap it is historically worth. They are opinions, and
   * they are meant to be argued with and edited.
   */
  skill: number;
  aggression: number;
  consistency: number;
  tyreManagement: number;
  wetSkill: number;
  racecraft: number;
  /** Seasons completed in this tier's championship, at the roster's season. */
  experience: number;
  age: number;

  /**
   * Seasons left on the contract at the start of the roster's season.
   *
   * Drives the silly season: a driver out of contract can be approached, and one
   * with two years left cannot without a buy-out.
   */
  contractYears: number;
  /** Annual salary in dollars. Outside the cost cap, as in the real regulations. */
  salaryUsd: number;
  /**
   * True for a driver who is on the entry list but not in one of the two race
   * seats — a reserve, or F3's third car, which this game does not run.
   *
   * They stay in the world and the transfer market can promote them, so nobody
   * is deleted for the sake of a 20-car grid.
   */
  reserve?: boolean;
}

export interface RosterTier {
  tier: TierId;
  /** Season these entries describe. */
  season: number;
  teams: readonly RosterTeam[];
  drivers: readonly RosterDriver[];
  /**
   * Circuit ids, in calendar order.
   *
   * Drawn from the eleven circuits this game has surveyed geometry for, ordered
   * to approximate the shape of each real championship's season rather than
   * being the same list three times. A real calendar visits circuits this game
   * does not have; those rounds are dropped rather than faked.
   */
  calendar: readonly string[];
}
