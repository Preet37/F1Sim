import { clamp, clamp01 } from '../core/MathUtils';
import { coerceHelmet, type HelmetDesign } from './Identity';
import type { TierId } from '../data/roster';
import type { CareerWorld, WorldDriver } from './World';
import type {
  DepartmentId, DepartmentState, Ledger, UpgradeProject,
} from './MyTeam';
import type { RoundResult, SeasonState, SeasonSummary } from './Season';
import type { RatingsState } from './DriverRatings';

/**
 * Everything a career is, in one serialisable object.
 *
 * SHAPE FIRST, BECAUSE EVERYTHING DEPENDS ON IT. A career spans ten or more
 * seasons and many builds of the game, so the save is not an implementation
 * detail of the career engine — it is the contract the career engine has to keep
 * with its own past. Getting this wrong is not a bug that shows up in testing;
 * it is a bug that shows up when somebody who has played for fifteen hours
 * updates the page.
 *
 * Three decisions are load-bearing.
 *
 * 1. THE WORLD IS IN THE SAVE. The previous version stored `teamId` and driver
 *    ids as references into the static `TEAMS` and `DRIVERS` arrays. That works
 *    exactly as long as the grid is a constant, and the grid is not: junior
 *    formulae, generated rookies, drivers transferring between teams, and a
 *    hidden per-save performance roll all make it dynamic. So the whole world —
 *    every team, every driver, every calendar — is written out. It costs about
 *    eighty kilobytes and it means a career in progress is never silently
 *    rewritten by an edit to a roster file.
 *
 * 2. TWO VERSION NUMBERS, NOT ONE. `saveVersion` changes when the shape changes
 *    incompatibly and a higher one is genuinely refused. `saveMinor` changes for
 *    additive fields, and a higher one LOADS — with the fields this build does
 *    not recognise preserved verbatim and written back on the next save. That is
 *    what lets somebody play on a new build, open the career on an older one,
 *    and not lose the new build's data.
 *
 * 3. NOTHING HERE IS A CLASS. Plain data, no methods, no `Date` objects, no
 *    `Map`s, no `undefined` where a value is expected — everything survives
 *    `JSON.parse(JSON.stringify(x))` unchanged. A save format that needs a
 *    revival step is a save format that will eventually be revived wrongly.
 */

export const SAVE_VERSION = 2;
/**
 * Bumped for ADDITIVE changes only, which is what makes them safe.
 *
 * 2: `RoundResult.disqualified`, once the race engine started modelling
 *    exclusion separately from retirement under the 2026 regulations.
 * 3: `PlayerProfile.helmet`, once the player had a face.
 * 4: `CareerState.weekendInProgress`, so a weekend survives a reload.
 * 5: `MyTeamState` grew a factory — departments, projects, an itemised ledger,
 *    a three-colour livery and cap penalties. A driver career has `team: null`
 *    and is entirely unaffected; a My Team career written by a build before this
 *    one never existed, because My Team did not.
 * 6: `CareerState.ratings` — the driver ratings model (issue #77). Additive and
 *    entirely recoverable: a career written before it existed is given a
 *    contract goal at its current rating and an empty history, which is exactly
 *    what a driver who has just signed has. The one thing that genuinely cannot
 *    be reconstructed is the per-race lifetime counters the accolades read, and
 *    `SaveCodec.backfill` says so by seeding `starts` from the seasons already
 *    in `history` rather than pretending to know how many podiums there were.
 */
export const SAVE_MINOR = 6;

/** The player, as a driver. Mirrors `WorldDriver` because they are one. */
export interface PlayerProfile {
  firstName: string;
  lastName: string;
  code: string;
  nationality: string;
  raceNumber: number;

  /**
   * The helmet the player designed. See `src/career/Identity.ts` for why a
   * helmet is the protagonist of this career mode and not a face.
   *
   * OPTIONAL, WHICH IS THE WHOLE POINT OF `saveMinor`. A career started before
   * the designer existed has no helmet in it and must still open; it is given a
   * default rolled from its own seed on load, so that career gets a helmet of
   * its own rather than everybody's being the same one.
   */
  helmet?: HelmetDesign;

  skill: number;
  aggression: number;
  consistency: number;
  tyreManagement: number;
  wetSkill: number;
  racecraft: number;
  experience: number;
  age: number;
}

/** How the player entered the sport. Decided once, at creation. */
export type CareerMode = 'driver' | 'myteam';

export interface RivalryState {
  driverId: string;
  /** 0..100. Rises when the two finish near each other. */
  heat: number;
  state: 'none' | 'cordial' | 'hostile' | 'feud';
  /** True when the player declared it rather than it emerging. */
  declared: boolean;
  /** Head-to-head across the current season. */
  wonAgainst: number;
  lostTo: number;
}

/**
 * Everything narrative, gathered in one place.
 *
 * Kept as its own object rather than spread across the career root so that the
 * whole of layer four can be added to, migrated and reasoned about without
 * touching the parts of the save that decide whether a championship is correct.
 */
export interface NarrativeState {
  /** 0..100. Gates which sponsors will sign. */
  fanRating: number;
  /** 0..100. Standing in the paddock. Decides the seats offered. */
  reputation: number;
  /** 0..100. Erodes consistency, which is a real lap-time cost. */
  pressure: number;
  /** Per-department morale, 0..100. Empty outside My Team. */
  departmentMorale: Record<string, number>;
  rivalries: RivalryState[];
  /** Arbitrary story flags, so new content needs no schema change. */
  flags: Record<string, boolean>;
  /** Event ids already fired, so `onceEver` works. */
  firedEvents: string[];
}

/**
 * The player's own constructor. Null unless the career is My Team.
 *
 * PLAIN DATA, AND NO IMPORT FROM THE RENDERER. The livery is stored as a family
 * name, three colours and a finish rather than as anything `src/render/Livery.ts`
 * defines, because that module imports three.js and this one is loaded by every
 * headless probe. A save schema that drags a WebGL dependency behind it is a
 * save schema that cannot be tested in a script.
 */
export interface MyTeamState {
  teamId: string;
  name: string;
  shortName: string;
  code: string;
  baseCountry: string;

  /** The three-colour palette. See `src/render/Livery.ts` for what paints them. */
  colour: number;
  accent: number;
  trim: number;
  /** Pattern family id, one of `LIVERY_FAMILIES`. */
  liveryFamily: string;
  liveryFinish: 'gloss' | 'satin' | 'matte';
  /** Which generated geometric mark the team carries, 0..n. */
  liveryMark: number;

  /** Cash in the bank. Can go negative; the career says so plainly when it does. */
  cashUsd: number;
  /** This season's ledger, itemised. See `src/career/MyTeam.ts`. */
  ledger: Ledger;

  /** The three departments: facility level, headcount, morale. */
  departments: Record<DepartmentId, DepartmentState>;
  /** Upgrade projects in the factory right now. */
  projects: UpgradeProject[];
  /** Monotonic, so no two projects in a career ever share an id. */
  nextProjectId: number;

  powerUnitId: string;
  powerUnitYearsLeft: number;
  /** The second car. A real driver record in this save's world. */
  teammateDriverId: string;

  /**
   * Rounds of a development ban still to serve.
   *
   * The consequence of a major cost-cap breach, carried across the off-season,
   * which is the whole reason it is stored rather than recomputed: the penalty
   * for last season's spending has to survive into a season whose ledger has
   * been reset.
   */
  developmentBanRounds: number;
  /** Constructors' points deducted this season by a cap penalty. */
  pointsDeducted: number;
}

/**
 * A race weekend that has been started and not finished.
 *
 * WHY THIS IS IN THE SAVE. Everything the career records — results, standings,
 * history, the world — persists, and `probe:save` proves it round-trips. What
 * did not persist was the weekend itself: the session queue, how far through it
 * the player was, and the grid qualifying had produced so far. Those lived as
 * fields on the app shell, so qualifying on the Saturday and closing the tab
 * threw the qualifying away and put the player back at the hub with the round
 * unrun. Everything the game had told them about that weekend was gone.
 *
 * `sessions` is stored as opaque values on purpose. It is a `SessionConfig[]`,
 * which belongs to the race engine, and importing that type here would put a
 * simulation type in the middle of the save schema — where every probe and
 * every migration would then have to know about it. It round-trips through JSON
 * unchanged, which is the only property the save needs from it.
 */
export interface WeekendProgress {
  circuitId: string;
  /** The round it belongs to. A stale weekend from an earlier round is ignored. */
  round: number;
  /** Which session of the queue is next. */
  index: number;
  /** `SessionConfig[]`, verbatim. See above for why it is not typed here. */
  sessions: unknown[];
  /** The grid qualifying has built so far, by driver id. */
  qualifyingGrid: string[];
  qualifyingSurvivors: string[];
  /** Barred from the rest of qualifying under Art. B4.3.2. */
  qualifyingBarred: string[];
}

export interface CareerState {
  saveVersion: number;
  saveMinor: number;
  createdAt: string;
  /** Seed everything random in this career derives from. */
  seed: number;
  mode: CareerMode;

  player: PlayerProfile;
  /** The id the player's driver record carries in the world. */
  playerDriverId: string;
  /** Which championship the player is currently in. */
  tier: TierId;
  teamId: string;
  contractYears: number;
  /** Consecutive seasons in this tier without promotion. Drives the drop rule. */
  seasonsInTier: number;
  /** Set when the career has ended, with the reason. */
  endedReason?: string;

  world: CareerWorld;
  season: SeasonState;
  history: SeasonSummary[];
  narrative: NarrativeState;
  team: MyTeamState | null;

  /** Preparation slots left before the next round. */
  prepSlotsLeft: number;

  /**
   * The driver ratings model's HISTORY — see `src/career/DriverRatings.ts`.
   *
   * NOT THE RATINGS THEMSELVES. Those are a pure projection of the player's
   * `WorldDriver` record and are recomputed on every read, precisely so that
   * a stored copy can never disagree with the driver who goes racing. What is
   * here is the four things a projection genuinely cannot recover: the rating
   * at the last reveal (so a delta can be shown), the rating after each past
   * weekend (so the contract chart has a line), the goal the team set at
   * signing, and the lifetime counters the accolades count.
   *
   * Additive, so a career written before #77 simply gets a fresh goal at its
   * current rating and an empty chart.
   */
  ratings?: RatingsState;

  /**
   * The weekend the player is part-way through, if any.
   *
   * Additive, so a save written before it existed simply has no weekend to
   * resume. Cleared when the weekend ends or is abandoned.
   */
  weekendInProgress?: WeekendProgress;

  /**
   * Fields written by a NEWER build than this one.
   *
   * Preserved verbatim and merged back on save. This is the entire mechanism
   * behind forward compatibility, and it is worth being explicit that it only
   * works because nothing here is a class: an unknown key is just a value, and a
   * value round-trips through JSON without this build needing to know what it
   * means.
   */
  unknown?: Record<string, unknown>;
}

// ===========================================================================
// Construction
// ===========================================================================

/** A player driver's record, in the shape the world and the simulation use. */
export function playerAsWorldDriver(state: CareerState): WorldDriver {
  const p = state.player;
  // Pressure erodes consistency, and that is not narration — consistency is read
  // by the AI's mistake model and by the paper simulation alike, so a driver
  // under contract pressure genuinely makes more mistakes.
  const pressurePenalty = (state.narrative.pressure / 100) * 0.08;
  return {
    id: state.playerDriverId,
    tier: state.tier,
    firstName: p.firstName,
    lastName: p.lastName,
    code: p.code,
    raceNumber: p.raceNumber,
    nationality: p.nationality,
    teamId: state.teamId,
    skill: p.skill,
    aggression: p.aggression,
    consistency: clamp01(p.consistency - pressurePenalty),
    tyreManagement: p.tyreManagement,
    wetSkill: p.wetSkill,
    racecraft: p.racecraft,
    experience: p.experience,
    age: p.age,
    contractYears: state.contractYears,
    salaryUsd: 500_000,
    reserve: false,
  };
}

/**
 * The player's helmet, whatever state the save is in.
 *
 * The one accessor everything draws from, so a career from before the designer
 * existed, a career hand-edited into nonsense and a career created five minutes
 * ago all produce a helmet that can be painted. A drawing routine that has to
 * check for `undefined` is a drawing routine that will eventually be given one.
 */
export function playerHelmet(state: CareerState): HelmetDesign {
  return coerceHelmet(state.player.helmet, state.seed);
}

/** Applies a bounded change to a narrative quantity. */
export function nudge(state: CareerState, key: 'fanRating' | 'reputation' | 'pressure', by: number): void {
  state.narrative[key] = clamp(state.narrative[key] + by, 0, 100);
}

/** The player's entry in the current season's standings, if they are racing. */
export function playerStanding(state: CareerState): { points: number; position: number } {
  const ts = state.season.tiers[state.tier];
  const sorted = ts.standings.slice().sort((a, b) => b.points - a.points || b.wins - a.wins);
  const i = sorted.findIndex((e) => e.driverId === state.playerDriverId);
  return { points: i >= 0 ? sorted[i].points : 0, position: i + 1 };
}

/** Whether a round result involved the player at all. */
export function playerPositionIn(state: CareerState, result: RoundResult): number {
  const i = result.order.indexOf(state.playerDriverId);
  return i < 0 ? 0 : i + 1;
}
