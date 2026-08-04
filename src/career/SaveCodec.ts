import { SAVE_MINOR, SAVE_VERSION, playerAsWorldDriver, type CareerState } from './CareerState';
import { defaultDepartments, emptyLedger, type Ledger } from './MyTeam';
import {
  RETAIN_GAP, emptyCareerRecord, emptyRatingsState, newContractGoal, ratingsFor,
} from './DriverRatings';

/**
 * Reading and writing a career, across versions of the game.
 *
 * WHAT THIS IS FOR. A career runs for ten or more seasons and many hours, and
 * the game it is running in will change underneath it. So the question this file
 * answers is not "can we serialise an object" — it is "what happens to somebody
 * fifteen hours into a career when the build changes". There are four cases and
 * all four are handled explicitly, because the default behaviour for three of
 * them is silent corruption.
 *
 *   SAME VERSION            Load it.
 *   OLDER MAJOR             Walk the migration ladder. Each step is idempotent,
 *                           so a very old save can walk all the way forward.
 *   NEWER MINOR             LOAD IT, and keep the fields this build does not
 *                           understand. Additive changes must not cost anybody a
 *                           career just because they opened it on an older tab.
 *   NEWER MAJOR             Refuse, and say so. The shape has changed
 *                           incompatibly, and guessing would corrupt it slowly
 *                           rather than failing honestly.
 *
 * THE UNKNOWN-KEY BAG is the mechanism behind the third case and it is worth
 * being explicit about how cheap it is: on load, every top-level key this build
 * does not know about is moved into `state.unknown`; on save, they are spread
 * back out. That is the whole implementation. It works only because nothing in
 * `CareerState` is a class instance — an unknown key is just a value, and a
 * value survives a JSON round-trip without this build needing to know what it
 * means.
 */

/** Why a load failed, in words a screen can show. */
export type LoadFailure =
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'unparseable' }
  | { ok: false; reason: 'not-a-career' }
  | { ok: false; reason: 'from-the-future'; version: number };

export type LoadResult = { ok: true; state: CareerState; migratedFrom?: number } | LoadFailure;

/** Top-level keys this build knows about. Anything else is preserved. */
const KNOWN_KEYS = new Set<string>([
  'saveVersion', 'saveMinor', 'createdAt', 'seed', 'mode',
  'player', 'playerDriverId', 'tier', 'teamId', 'contractYears',
  'seasonsInTier', 'endedReason',
  'world', 'season', 'history', 'narrative', 'team', 'prepSlotsLeft',
  'weekendInProgress', 'ratings',
  'unknown',
]);

/**
 * Migrations, keyed by the version they migrate FROM.
 *
 * Each one must be idempotent and must not assume any field exists — it is
 * running against data written by a build that no longer exists, possibly
 * hand-edited, possibly truncated by a browser that ran out of quota mid-write.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => void> = {
  /**
   * Version 1 was a flat career: a single tier, a `standings` array of the
   * player's own championship, ids pointing into the static `TEAMS` and
   * `DRIVERS` arrays, and no world of its own.
   *
   * There is no honest way to reconstruct three championships and a transfer
   * market from it, because the information was never there — a version 1 save
   * does not know who was in Formula 2, since Formula 2 did not exist. So what
   * is carried across is what genuinely survives: WHO THE PLAYER IS, what they
   * have won, and how far they got. The world is rebuilt fresh around them.
   *
   * That is a real loss and it is stated plainly rather than pretended away: the
   * standings of the season in progress cannot come with them. It is still very
   * much better than refusing the save, which would end the career outright.
   */
  1: (raw) => {
    const player = (raw.player ?? {}) as Record<string, unknown>;
    raw.mode = 'driver';
    raw.playerDriverId = 'PLAYER';
    raw.seasonsInTier = 0;
    raw.prepSlotsLeft = 2;
    raw.history = Array.isArray(raw.history) ? raw.history : [];
    raw.team = null;

    raw.narrative = {
      fanRating: 10,
      reputation: typeof raw.reputation === 'number' ? raw.reputation : 10,
      pressure: typeof raw.pressureLevel === 'number' ? raw.pressureLevel : 20,
      departmentMorale: {},
      rivalries: [],
      flags: (raw.flags && typeof raw.flags === 'object') ? raw.flags : {},
      firedEvents: Array.isArray(raw.firedEvents) ? raw.firedEvents : [],
    };

    // The player's own attributes are the part worth keeping — they represent
    // seasons of the player's own development.
    raw.player = {
      firstName: str(player.firstName, 'Rookie'),
      lastName: str(player.lastName, 'Driver'),
      code: str(player.code, 'ROO'),
      nationality: str(player.nationality, 'United Kingdom'),
      raceNumber: num(player.raceNumber, 47),
      skill: num(player.skill, 0.7),
      aggression: num(player.aggression, 0.65),
      consistency: num(player.consistency, 0.65),
      tyreManagement: num(player.tyreManagement, 0.6),
      wetSkill: num(player.wetSkill, 0.65),
      racecraft: num(player.racecraft, 0.63),
      experience: num(player.experience, 0),
      age: num(player.age, 18),
    };

    // The world and the season are rebuilt by the caller, which is the only
    // component that knows how — see `SaveManager.load`. Marking them absent is
    // how that is signalled.
    delete raw.world;
    delete raw.season;
    delete raw.standings;
    delete raw.constructorPoints;
    delete raw.results;
    delete raw.staff;
    delete raw.rivalries;
    delete raw.money;
    delete raw.reputation;
    delete raw.pressureLevel;
    delete raw.teamMorale;
    delete raw.teamTrust;
    delete raw.carDevelopment;

    raw.saveVersion = 2;
    raw.saveMinor = 0;
  },
};

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Is this even a career?
 *
 * Checks the fields the game will immediately dereference rather than validating
 * everything. The goal is to reject a corrupt or foreign file before it causes a
 * crash somewhere deep in a screen, not to be a schema validator — a save that
 * is structurally a career but has one nonsense number in it should load and be
 * playable, because the alternative is telling somebody their career is gone
 * over a rounding error.
 */
function looksLikeCareer(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.saveVersion !== 'number') return false;
  if (typeof o.player !== 'object' || o.player === null) return false;
  const p = o.player as Record<string, unknown>;
  return typeof p.firstName === 'string';
}

/** Serialises a career, folding any preserved unknown keys back in. */
export function encode(state: CareerState): string {
  const { unknown, ...rest } = state;
  const out: Record<string, unknown> = { ...unknown, ...rest };
  out.saveVersion = SAVE_VERSION;
  out.saveMinor = SAVE_MINOR;
  return JSON.stringify(out);
}

/**
 * Parses a career.
 *
 * Returns a discriminated result rather than `null`, because "this save is from
 * a newer build" and "this file is not a save at all" want completely different
 * things said to the player, and a bare null cannot tell them apart.
 */
export function decode(text: string | null): LoadResult {
  if (!text) return { ok: false, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (!looksLikeCareer(parsed)) return { ok: false, reason: 'not-a-career' };
  const raw = parsed as Record<string, unknown>;
  const from = raw.saveVersion as number;

  if (from > SAVE_VERSION) {
    return { ok: false, reason: 'from-the-future', version: from };
  }

  // Walk the ladder. Each step advances `saveVersion`, so a save several
  // versions old climbs one rung at a time and every step sees data in exactly
  // the shape it was written to expect.
  let guard = 0;
  while ((raw.saveVersion as number) < SAVE_VERSION) {
    const step = MIGRATIONS[raw.saveVersion as number];
    if (!step) {
      // A gap in the ladder. Better to refuse than to hand the game a shape
      // nothing has ever migrated.
      return { ok: false, reason: 'not-a-career' };
    }
    step(raw);
    if (++guard > 16) return { ok: false, reason: 'not-a-career' };
  }

  // Quarantine anything this build has never heard of. A save written by a newer
  // MINOR version keeps its extra fields and gets them back on the next write.
  const unknown: Record<string, unknown> = { ...(raw.unknown as object ?? {}) };
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      unknown[key] = raw[key];
      delete raw[key];
    }
  }

  const state = raw as unknown as CareerState;
  state.unknown = Object.keys(unknown).length > 0 ? unknown : undefined;
  backfill(state);

  return { ok: true, state, migratedFrom: from < SAVE_VERSION ? from : undefined };
}

/**
 * Gives every field added since this save was written a sensible value.
 *
 * Runs on EVERY load, not only on a migration, because a save written by a build
 * one minor version behind is missing exactly the fields this build added — and
 * `undefined` reaching arithmetic is how a career quietly becomes NaN points in
 * a championship nobody can win.
 */
function backfill(state: CareerState): void {
  state.saveMinor ??= 0;
  state.mode ??= 'driver';
  state.playerDriverId ??= 'PLAYER';
  state.tier ??= 'F3';
  state.contractYears ??= 1;
  state.seasonsInTier ??= 0;
  state.prepSlotsLeft ??= 2;
  state.history ??= [];
  state.team ??= null;

  state.narrative ??= {
    fanRating: 10, reputation: 10, pressure: 20,
    departmentMorale: {}, rivalries: [], flags: {}, firedEvents: [],
  };
  const n = state.narrative;
  n.fanRating ??= 10;
  n.reputation ??= 10;
  n.pressure ??= 20;
  n.departmentMorale ??= {};
  n.rivalries ??= [];
  n.flags ??= {};
  n.firedEvents ??= [];

  // THE MY TEAM BLOCK. `state.team ??= null` above only guarantees the block
  // exists or does not; it says nothing about what is inside it, and everything
  // inside it is arithmetic. `capSpent` sums three ledger lines and
  // `ledgerExpenditure` sums four more, so ONE missing line turns a career's
  // whole cost cap into NaN — a number that compares false against every
  // threshold, so the cap silently stops binding rather than throwing. The mode
  // is young and its state has already gained nine fields and lost two; this is
  // what makes the next one survive contact with a save written yesterday.
  const t = state.team;
  if (t) {
    t.cashUsd ??= 0;
    t.ledger ??= emptyLedger();
    for (const line of Object.keys(emptyLedger()) as (keyof Ledger)[]) {
      t.ledger[line] ??= 0;
    }
    t.departments ??= defaultDepartments();
    t.projects ??= [];
    t.nextProjectId ??= t.projects.length + 1;
    t.powerUnitYearsLeft ??= 0;
    t.developmentBanRounds ??= 0;
    t.pointsDeducted ??= 0;
    t.trim ??= t.accent ?? 0xe8e0d0;
    t.liveryFamily ??= 'halo';
    t.liveryFinish ??= 'satin';
    t.liveryMark ??= 0;
    t.baseCountry ??= '';
  }

  backfillRatings(state);
}

/**
 * THE RATINGS BLOCK, defended the same way the My Team block is and for the
 * same reason (issue #77).
 *
 * Every field in here is read by a screen that prints it as a figure or draws
 * it as a bar. `history` missing is a chart calling `.length` on `undefined`;
 * `record` missing one counter is an accolade whose progress bar is `NaN%`
 * wide, which CSS silently drops to zero — so the screen would say "0 of 100
 * race starts" to somebody with eighty-six of them and never throw. That is
 * the same class of silent failure as the ledger line that turned a cost cap
 * into `NaN` and stopped it binding.
 *
 * `contract` is seeded from the CURRENT rating rather than from a stored one,
 * because a career from before this existed genuinely has no signing rating,
 * and inventing a target it has already missed would open the mode on a
 * contract the player is failing through no act of theirs.
 *
 * Proved red by deleting the per-field loop below: `probe:save` reports
 * `a missing lifetime counter came back undefined, which is NaN in an
 * accolade`. Deleting the whole function takes it to four failures.
 */
function backfillRatings(state: CareerState): void {
  const seasons = Array.isArray(state.history) ? state.history.length : 0;
  const year = state.season?.year ?? new Date().getFullYear();

  // The rating a pre-#77 career is worth right now. Computed from the player's
  // own profile through the same projection every screen uses — there is no
  // second formula here.
  const current = (): number => {
    try {
      return ratingsFor(playerAsWorldDriver(state)).rtg;
    } catch {
      return 50;
    }
  };

  state.ratings ??= emptyRatingsState(current(), year);
  const r = state.ratings;
  r.lastRevealed ??= null;
  r.history ??= [];
  r.contract ??= newContractGoal(current(), year);
  r.contract.signedRtg ??= current();
  r.contract.targetRtg ??= Math.min(100, r.contract.signedRtg + 1);
  r.contract.retainRtg ??= Math.max(1, r.contract.signedRtg - RETAIN_GAP);
  r.contract.signedYear ??= year;
  r.contract.seasonsAtTeam ??= 0;

  r.record ??= emptyCareerRecord();
  const blank = emptyCareerRecord();
  for (const key of Object.keys(blank) as (keyof typeof blank)[]) {
    r.record[key] ??= 0;
  }
  // The one honest reconstruction available: a career with N closed seasons
  // behind it has started at least a season's worth of races per season. It is
  // stated as a floor rather than as a count, and nothing else is guessed.
  if (r.record.starts === 0 && seasons > 0) {
    r.record.starts = seasons * 20;
  }

  r.recognition ??= { academyChoice: false, meetings: 0 };
  r.recognition.academyChoice ??= false;
  r.recognition.meetings ??= 0;
}

/** True when a decoded save needs its world rebuilt — a version 1 career. */
export function needsWorldRebuild(state: CareerState): boolean {
  return !state.world || !state.season;
}
