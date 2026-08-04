import { clamp, clamp01 } from '../core/MathUtils';
import { findDriver, findTeam, performanceOf, raceSeats, type CareerWorld, type WorldDriver } from './World';
import type { RoundResult, SeasonState } from './Season';
import type { TierId } from '../data/roster';

/**
 * THE DRIVER RATINGS MODEL — RTG, and EXP / RAC / AWA / PAC / FOC.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AND WHY IT EXISTS *FIRST*
 * ===========================================================================
 *
 * Issue #77 asks for six screens out of `reference/target/` — accolades,
 * contracts, a ratings reveal, recognition, a driver-market comparison and a
 * driver-market table. Every one of them is a *view onto a driver rating*, and
 * before this file there was no such thing anywhere in the game. Building the
 * panels first would have produced six beautiful screens with nothing true in
 * them, which is the trap that left the podium built and unreachable for weeks
 * (#13) and the trap #62 found when `probe:smoke` reported "every screen
 * renders" having walked fourteen livery buttons.
 *
 * So the rule for this module is stated once and enforced by `probe:ratings`:
 *
 *   **THE SCREENS READ THIS. THE SCREENS NEVER RE-DERIVE IT.**
 *
 * This project has shipped the opposite twice — `TIER_INFO.carPace`, declared,
 * documented and read by nothing; and the pit panel with four separate
 * derivations of one fact. `probe:ratings` §6 greps `src/ui/` for the
 * arithmetic and fails if a screen computes a rating out of raw driver
 * attributes instead of calling in here.
 *
 * ===========================================================================
 * THE SECOND RULE: THERE IS NO SECOND COPY OF A DRIVER
 * ===========================================================================
 *
 * A rating is a **pure projection of the `WorldDriver` record**. Nothing in
 * here is stored per driver, for anybody, ever. That is deliberate and it is
 * the whole reason the model cannot drift:
 *
 *   · There are ~60 drivers across three championships plus generated rookies.
 *     A stored rating for each is 60 opportunities for the stored number and
 *     the raced number to disagree, and they would disagree the first time the
 *     off-season moved somebody's attributes.
 *   · `WorldDriver` is what `simulateRound` scores, what `AIVehicleController`
 *     drives and what `valuation` prices. If the rating is a function of it,
 *     then a driver who is quick on the screen is quick in the race by
 *     construction rather than by coincidence.
 *
 * What *is* stored (`RatingsState`, in the save) is the things a projection
 * genuinely cannot recover: the rating at the last reveal, so a delta can be
 * shown; the rating after each past race weekend, so the contract chart has a
 * line to draw; the goal the team set at signing; and the lifetime counters the
 * accolades count. All four are history, not state.
 *
 * ===========================================================================
 * THE ATTRIBUTES, AND WHAT EACH ONE IS MADE OF
 * ===========================================================================
 *
 * The five names come from the reference (`reference/target/86.png`). What
 * each is made of comes from what this simulation actually reads, so that a
 * rating is a statement about the car that will be on the track and not a
 * decoration:
 *
 * | shown | is | built from | who reads that |
 * |---|---|---|---|
 * | `PAC` | Pace | `skill` | `simulateRound` (weight 0.36), `AIVehicleController` |
 * | `RAC` | Racecraft | `racecraft` | wheel-to-wheel, `Stewards` |
 * | `AWA` | Awareness | `tyreManagement`, and *not* over-driving (`1 − aggression`) | `simulateRound` (0.04), `TrafficAwareness` |
 * | `FOC` | Focus | `consistency` and `wetSkill`, less `narrative.pressure` | the race-day spread and the driver-error retirement term |
 * | `EXP` | Experience | race starts, on a saturating curve | `valuation`, `prefersExperience` |
 *
 * `AWA` and `FOC` are deliberately built from *different* attributes even
 * though both read as "does not bin it". Awareness is where the car is put;
 * focus is whether the lap holds together. Sharing `consistency` between them
 * would have made two columns of one number, which is the shape of a screen
 * that looks informative and is not.
 *
 * ===========================================================================
 * RTG, AND THE PART OF THE REFERENCE THAT IS NOT REPRODUCED
 * ===========================================================================
 *
 * `RTG` is a weighted mean of the five. The weights are **this simulation's**,
 * derived from `simulateRound`'s own coefficients (see `RTG_WEIGHT` below) so
 * that a higher RTG genuinely finishes higher — which `probe:ratings` §3
 * asserts over 40 simulated seasons rather than assuming.
 *
 * They are NOT F1 Manager's weights and this file does not pretend otherwise.
 * The reference frames give three worked examples and no two of them fit one
 * convex combination: `87.png` has Opmeer at 72 from 39/71/80/70/90 and
 * Hulkenberg at 84 from 89/85/86/82/98, and `88.png` has Lawson at **93** from
 * 49/83/78/87/98 — a number no weighted mean of those five can reach. Their
 * overall is a curve this project cannot see and guessing at it would be
 * fiction. `INDEX.md` asks for exactly this to be said rather than substituted
 * silently: the *layout, wording, order and typography* of those screens are
 * copied; the arithmetic behind the figure is ours and is documented here.
 */

// ===========================================================================
// The shape
// ===========================================================================

export type RatingKey = 'exp' | 'rac' | 'awa' | 'pac' | 'foc';

/** Display order, top to bottom, exactly as `reference/target/86.png` prints it. */
export const RATING_KEYS: readonly RatingKey[] = ['exp', 'rac', 'awa', 'pac', 'foc'];

/** The three-letter code, which is what the screens shout. */
export const RATING_CODE: Readonly<Record<RatingKey, string>> = {
  exp: 'EXP', rac: 'RAC', awa: 'AWA', pac: 'PAC', foc: 'FOC',
};

/** The word underneath it, which is what the screens whisper. */
export const RATING_NAME: Readonly<Record<RatingKey, string>> = {
  exp: 'Experience', rac: 'Racecraft', awa: 'Awareness', pac: 'Pace', foc: 'Focus',
};

/** One line on what the attribute actually does to a race. */
export const RATING_EFFECT: Readonly<Record<RatingKey, string>> = {
  exp: 'What the paddock will pay for, and what a team that prefers a safe pair of hands looks at.',
  rac: 'Wheel to wheel. Overtaking, defending, and how the stewards read an incident.',
  awa: 'Where the car is put. Tyre life, traffic, and not asking for a gap that is not there.',
  foc: 'Whether the lap holds together. Narrows the race-day spread and keeps you out of the barrier.',
  pac: 'Outright speed. The single largest driver term in a race result.',
};

export interface DriverRatings {
  /** The overall. 0..100, integer. */
  rtg: number;
  exp: number;
  rac: number;
  awa: number;
  pac: number;
  foc: number;
}

/**
 * How the five make an overall.
 *
 * Read straight off `simulateRound`: driver pace carries 0.36 of a race score
 * and tyre management 0.04, consistency narrows the spread AND cuts the
 * driver-error retirement term, and racecraft is what decides the places that
 * change hands once the paper order is set. Experience is deliberately small —
 * it is what a *team* pays for (`valuation`) rather than what makes a car
 * quick, and a rating dominated by starts would tell a rookie their ceiling is
 * their birthday.
 *
 * Sums to exactly 1, so five 99s make a 99 — which is the one arithmetic fact
 * `86.png` does pin down.
 */
export const RTG_WEIGHT: Readonly<Record<RatingKey, number>> = {
  pac: 0.36,
  rac: 0.24,
  awa: 0.16,
  foc: 0.16,
  exp: 0.08,
};

/**
 * Development points per rating level.
 *
 * The reference prints progress as `4856 / 4856` beside a 99, i.e. about 49
 * points a level, and the *form* of that — four digits, current over cap — is
 * what is being copied. The exact constant is arbitrary and is stated here
 * rather than being spread across the screens that print it.
 */
export const POINTS_PER_LEVEL = 49;

export function levelToPoints(level: number): number {
  return Math.round(level * POINTS_PER_LEVEL);
}

// ===========================================================================
// The projection
// ===========================================================================

/** 0..1 attribute to a 0..100 rating, rounded the way every screen shows it. */
function lvl(v: number): number {
  return Math.round(clamp01(v) * 100);
}

/**
 * Experience, from race starts.
 *
 * Saturating rather than linear, because the difference between a first race
 * and a tenth is enormous and the difference between a two-hundredth and a
 * two-hundred-and-tenth is nothing. 0 starts is 0; a full first season (~22)
 * is about 30; a hundred starts is about 80. It approaches 100 asymptotically
 * and the displayed integer gets there at around 290 starts — thirteen full
 * seasons, which is a career, and is meant to be.
 *
 * `WorldDriver.experience` counts SEASONS for the roster's own drivers, which
 * is the only figure the roster carries, so it is multiplied up by a nominal
 * season length. That conversion lives here and nowhere else.
 */
export const STARTS_PER_SEASON = 22;

export function experienceFromStarts(starts: number): number {
  const s = Math.max(0, starts);
  return 100 * (1 - Math.exp(-s / 62));
}

/**
 * Everything the projection reads, and nothing else.
 *
 * `WorldDriver` (the career's record) and `Driver` (the simulation's) both
 * satisfy it, which is what lets one function rate a driver on the paddock
 * screen, in the market and on the reveal. The alternative — a second overload
 * for the second type — is how a rating ends up meaning two things.
 */
export type RatableDriver = Pick<WorldDriver,
  'skill' | 'aggression' | 'consistency' | 'tyreManagement' | 'wetSkill'
  | 'racecraft' | 'experience'>;

/**
 * How many races this driver has started.
 *
 * The player's own count is authoritative and comes from `CareerRecord.starts`.
 * Everybody else is `experience` seasons times a season, which is the only
 * information the roster has about them.
 */
export function startsOf(d: Pick<WorldDriver, 'experience'>): number {
  return Math.max(0, Math.round(d.experience * STARTS_PER_SEASON));
}

export interface RatingsContext {
  /**
   * 0..100. Erodes focus, exactly as `playerAsWorldDriver` already erodes
   * consistency by it — this is the same fact shown rather than a second one.
   */
  pressure?: number;
  /** Overrides `startsOf`, for the player, whose starts are counted exactly. */
  starts?: number;
}

/**
 * A driver's ratings. Pure, total, and the only place these five are computed.
 */
export function ratingsFor(d: RatableDriver, ctx: RatingsContext = {}): DriverRatings {
  const starts = ctx.starts ?? startsOf(d);
  const pressure = clamp(ctx.pressure ?? 0, 0, 100);

  const exp = Math.round(experienceFromStarts(starts));
  const rac = lvl(d.racecraft);
  // Awareness: reading the car and the traffic, minus the part of aggression
  // that is asking for a gap that is not there. `1 - aggression` is not a
  // penalty on racing hard — a 0.68 aggression is a normal racing driver and
  // lands mid-band; it is a penalty on 0.95.
  const awa = lvl(d.tyreManagement * 0.72 + (1 - d.aggression) * 0.28);
  const pac = lvl(d.skill);
  // Focus: holding a lap together, in the wet as well as the dry, under
  // whatever the season is doing to you.
  const foc = lvl((d.consistency * 0.74 + d.wetSkill * 0.26) * (1 - (pressure / 100) * 0.12));

  const parts: Record<RatingKey, number> = { exp, rac, awa, pac, foc };
  return { ...parts, rtg: overallRtg(parts) };
}

/** The overall, from five levels. The one definition. */
export function overallRtg(parts: Record<RatingKey, number>): number {
  let sum = 0;
  for (const k of RATING_KEYS) sum += parts[k] * RTG_WEIGHT[k];
  return Math.round(clamp(sum, 0, 100));
}

// ===========================================================================
// Caps
// ===========================================================================

/**
 * The ceiling on each attribute, per driver.
 *
 * ABSOLUTE, AND THIS IS THE SECOND VERSION. The first read `current + a bit of
 * headroom`, which is not a ceiling — it is a rolling window that moves up
 * every time the driver does, so it can never bind and the progress bar it
 * feeds can never fill. `probe:ratings` §4 found it: 340 race starts of nothing
 * but wins finished with every attribute "at its cap" and the cap 26 points
 * higher than it started. A cap that follows its subject is `TIER_INFO.carPace`
 * with a progress bar on it.
 *
 * So potential is a fixed number: a hash of the driver's id, the attribute and
 * the career seed. Stable for the whole career, identical on every machine,
 * different in every career, and not one byte of save. Age closes it, which is
 * the same decline `developPlayer` and `ageDrivers` already apply.
 *
 * The one place it yields is a driver who is ALREADY better than their hash
 * says: a real roster driver rated 92 with a hash potential of 80 is at their
 * ceiling, not eleven points past it. Drawing a bar past the end of its own
 * track is the failure this clamp exists to prevent, and the honest reading of
 * "you are better than I thought" is that the estimate was wrong.
 */
export function capsFor(d: WorldDriver, seed = 0): Record<RatingKey, number> {
  const now = ratingsFor(d);
  const out = {} as Record<RatingKey, number>;
  for (const k of RATING_KEYS) {
    if (k === 'exp') {
      // Experience is not a talent. Its ceiling is its own curve.
      out.exp = 100;
      continue;
    }
    const h = hash32(d.id + ':' + k + ':' + seed);
    // 72..98 of raw potential, closed by age. A 36-year-old is not going to
    // get quicker, and the model should not draw them a bar that says they are.
    const raw = 72 + (h % 27);
    const decline = d.age >= 34 ? (d.age - 33) * 3 : 0;
    out[k] = Math.round(clamp(Math.max(now[k], raw - decline), 0, 100));
  }
  return out;
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ===========================================================================
// What is stored — history, not state
// ===========================================================================

/** One race weekend's ratings, for the contract chart and the ratings graph. */
export interface RatingSample {
  year: number;
  /** Round index within that season, 0-based, as `TierSeason.round` counts. */
  round: number;
  circuitId: string;
  rtg: number;
  exp: number;
  rac: number;
  awa: number;
  pac: number;
  foc: number;
}

/**
 * The goal the team set when the contract was signed.
 *
 * `85.png` prints three figures — Target, Current, Retain Seat — under the
 * heading `INCREASE RATING BY 1`, so the target is relative to the rating at
 * signing rather than absolute. `retainRtg` is the floor below which the seat
 * is at risk; the reference has 69 / 68 / 62, i.e. seven below the target, and
 * that gap is `RETAIN_GAP` here.
 */
export interface ContractGoal {
  /** RTG the day the contract was signed. */
  signedRtg: number;
  /** What the team wants by the end of the season. */
  targetRtg: number;
  /** Below this, the seat is at risk. */
  retainRtg: number;
  /** Season the contract was signed in. */
  signedYear: number;
  /** Seasons completed at this team. Feeds recognition. */
  seasonsAtTeam: number;
}

export const RETAIN_GAP = 7;

/** The goal a team sets a driver it has just signed. */
export function newContractGoal(rtg: number, year: number): ContractGoal {
  const target = Math.min(100, rtg + 1);
  return {
    signedRtg: rtg,
    targetRtg: target,
    retainRtg: Math.max(1, target - RETAIN_GAP),
    signedYear: year,
    seasonsAtTeam: 0,
  };
}

/**
 * Lifetime counters. The accolades count these and nothing else.
 *
 * Kept as an accumulator rather than derived from `history`, because
 * `SeasonSummary` records a season's position and points and no per-race
 * result — so podium and top-ten counts across past seasons are genuinely not
 * recoverable from what the save holds. Every one of these is incremented in
 * exactly one place (`recordRoundInRatings` / `closeSeasonInRatings`).
 */
export interface CareerRecord {
  starts: number;
  wins: number;
  podiums: number;
  top10: number;
  points: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
  /** Championships won, any tier. */
  titles: number;
  /** Seasons finished in the top five of a championship. */
  top5Seasons: number;
}

export function emptyCareerRecord(): CareerRecord {
  return {
    starts: 0, wins: 0, podiums: 0, top10: 0, points: 0,
    poles: 0, fastestLaps: 0, dnfs: 0, titles: 0, top5Seasons: 0,
  };
}

/** The things a player did that move recognition. See `recognitionFor`. */
export interface RecognitionState {
  /** Came up through this team's own academy. Set at creation. */
  academyChoice: boolean;
  /** Meetings taken with the principal. Each one is a spent preparation slot. */
  meetings: number;
}

export interface RatingsState {
  /**
   * The ratings as they stood the last time the reveal screen was shown.
   *
   * Null on a career that has never seen it, which is what makes the first
   * reveal print the whole of a rookie's rating rather than a delta of zero.
   */
  lastRevealed: DriverRatings | null;
  /** Oldest first, bounded to `HISTORY_LIMIT`. */
  history: RatingSample[];
  contract: ContractGoal;
  record: CareerRecord;
  recognition: RecognitionState;
}

/**
 * How many weekends the chart keeps.
 *
 * `85.png` draws ten. Thirty is a season and a bit, which is enough for the
 * chart to have somewhere to scroll and small enough that a ten-season career
 * carries 30 samples rather than 300 — `probe:save` measures the whole career
 * against a browser quota and this is the only unbounded thing #77 adds.
 */
export const HISTORY_LIMIT = 30;

export function emptyRatingsState(rtg: number, year: number): RatingsState {
  return {
    lastRevealed: null,
    history: [],
    contract: newContractGoal(rtg, year),
    record: emptyCareerRecord(),
    recognition: { academyChoice: false, meetings: 0 },
  };
}

// ===========================================================================
// MOVING WITH RESULTS — the part that makes the screens true
// ===========================================================================

/** What one race weekend did to the driver, in rating levels. */
export interface RatingMove {
  /** Change applied to each underlying attribute, in 0..1 units. */
  delta: Partial<Record<'skill' | 'racecraft' | 'consistency' | 'tyreManagement' | 'wetSkill' | 'aggression', number>>;
  /** The sample appended to the history. */
  sample: RatingSample;
  /** Human-readable, for the debrief. */
  notes: string[];
}

/**
 * How much a single race can move an attribute.
 *
 * A ceiling on the whole thing, deliberately small. A career is twenty-odd
 * rounds a season for ten seasons; if one weekend could move a rating by more
 * than a level, a good Sunday would be worth more than a season of work and
 * the number would stop meaning anything. 0.006 of an attribute is 0.6 of a
 * rating level, so it takes about two good weekends to move one point — which
 * is what makes `INCREASE RATING BY 1` a season's goal rather than a formality.
 */
const MOVE_LIMIT = 0.006;

/**
 * What the car alone would have produced.
 *
 * Every attribute except experience moves on the difference between where the
 * driver finished and where the CAR should have finished, because that is the
 * only honest way to rate a driver in a sport where the machinery is most of
 * the result. A P12 in the worst car on the grid is a better weekend than a P6
 * in the best one, and a model that rewarded the P6 would rate the seat.
 */
export function expectedPositionOf(
  world: CareerWorld, tier: TierId, driverId: string,
): number {
  const seats = raceSeats(world, tier);
  const scored = seats.map((d) => {
    const team = findTeam(world, d.teamId);
    const p = team ? performanceOf(team) : null;
    const carPace = p
      ? (p.powerMult + p.downforceMult + p.mechanicalGripMult) / 3 - (p.dragMult - 1) * 0.15
      : 1;
    return { id: d.id, carPace };
  });
  scored.sort((a, b) => b.carPace - a.carPace);
  const i = scored.findIndex((s) => s.id === driverId);
  return i < 0 ? Math.ceil(scored.length / 2) : i + 1;
}

export interface RoundContext {
  world: CareerWorld;
  season: SeasonState;
  tier: TierId;
  driverId: string;
  result: RoundResult;
  /** The player's team-mate, if they have one. */
  teammateId?: string;
  pressure: number;
  /** Starts after this round. */
  starts: number;
}

/**
 * One race weekend, as a change to the driver.
 *
 * PURE. It takes state and returns a move; it writes nothing. `Career`
 * applies it. That is what lets `probe:ratings` drive a thousand weekends
 * without a career object, and what stops this becoming a second place where
 * a driver record is edited.
 */
export function moveForRound(d: WorldDriver, ctx: RoundContext): RatingMove {
  const notes: string[] = [];
  const delta: RatingMove['delta'] = {};
  const finished = ctx.result.order.indexOf(ctx.driverId);
  const position = finished < 0 ? 0 : finished + 1;
  const retired = ctx.result.retired.includes(ctx.driverId);
  const field = Math.max(1, ctx.result.order.length);
  const expected = expectedPositionOf(ctx.world, ctx.tier, ctx.driverId);

  // --- PAC. Beating the car is what pace is. --------------------------------
  //
  // Normalised by the field, so beating the car by three places at the front
  // of a twenty-car grid and by three at the back are worth the same, and
  // clamped, so a first-lap pile-up that hands somebody P4 is not a career.
  if (position > 0 && !retired) {
    const beat = clamp((expected - position) / field, -0.35, 0.35);
    const move = beat * MOVE_LIMIT * 2.2;
    delta.skill = move;
    if (beat > 0.08) notes.push(`P${position} in a car worth P${expected}. Pace is up.`);
    else if (beat < -0.08) notes.push(`P${position} in a car worth P${expected}.`);
  }

  // --- RAC. The team-mate is the only fair comparison in motorsport. --------
  if (ctx.teammateId && !retired) {
    const theirs = ctx.result.order.indexOf(ctx.teammateId);
    if (theirs >= 0 && position > 0) {
      const won = theirs > finished;
      delta.racecraft = (won ? 1 : -0.7) * MOVE_LIMIT * 0.6;
      notes.push(won ? 'Beat the other car.' : 'Beaten by the other car.');
    }
  }
  // Points are racecraft too — a top-ten finish is places held under pressure.
  if (position > 0 && position <= 10 && !retired) {
    delta.racecraft = (delta.racecraft ?? 0) + MOVE_LIMIT * 0.35;
  }

  // --- AWA. Finishing, and finishing ahead of quicker cars. ----------------
  if (retired || position === 0) {
    delta.tyreManagement = -MOVE_LIMIT * 0.5;
    delta.aggression = MOVE_LIMIT * 0.25;
    notes.push('Out of the race. Awareness is down.');
  } else {
    const ahead = countFasterCarsBeaten(ctx, position);
    delta.tyreManagement = MOVE_LIMIT * (0.25 + clamp(ahead / field, 0, 0.4));
    // Racing at the front for a whole season quietly takes the edge off the
    // over-driving that gets a junior noticed and gets a Formula 1 driver a
    // five-second penalty.
    delta.aggression = -MOVE_LIMIT * 0.12;
  }

  // --- FOC. Delivering the result the car had in it. -----------------------
  //
  // Focus is measured against what the CAR was worth, not against the front of
  // the grid: a midfield driver who turns in the car's own result every Sunday
  // is focused, and a model that only rewarded winning would call them
  // unfocused for driving a slow car.
  //
  // AND IT MUST NOT PUNISH IMPROVEMENT. The first version of this compared the
  // weekend against the driver's own recent RATINGS and rewarded a flat line —
  // so a driver who was genuinely getting better registered as inconsistent,
  // every round, and `probe:ratings` §4 measured the result: 340 wins finished
  // with FOC at 17. The bug is the whole reason this comment is here.
  if (retired) {
    delta.consistency = -MOVE_LIMIT * 0.9;
    notes.push('A retirement costs focus.');
  } else if (position > 0) {
    const shortfall = position - expected;
    delta.consistency = shortfall <= 1
      ? MOVE_LIMIT * 0.45
      : shortfall >= 4 ? -MOVE_LIMIT * 0.30 : 0;
    if (ctx.result.wetRace) delta.wetSkill = MOVE_LIMIT * 0.7;
  }
  if (ctx.result.poleDriverId === ctx.driverId) {
    delta.skill = (delta.skill ?? 0) + MOVE_LIMIT * 0.5;
    notes.push('Pole position.');
  }
  if (ctx.result.fastestLapDriverId === ctx.driverId) {
    delta.skill = (delta.skill ?? 0) + MOVE_LIMIT * 0.25;
  }

  // The sample is taken from the driver AS THEY WILL BE — the caller applies
  // `delta` before reading it — so it is computed against a copy here rather
  // than being guessed at.
  const after: WorldDriver = { ...d };
  for (const [k, v] of Object.entries(delta) as [keyof typeof delta, number][]) {
    after[k] = clamp01((after[k] as number) + v);
  }
  const r = ratingsFor(after, { pressure: ctx.pressure, starts: ctx.starts });

  return {
    delta,
    notes,
    sample: {
      year: ctx.season.year,
      round: ctx.result.round,
      circuitId: ctx.result.circuitId,
      rtg: r.rtg, exp: r.exp, rac: r.rac, awa: r.awa, pac: r.pac, foc: r.foc,
    },
  };
}

/** How many cars with a genuinely faster machine finished behind this driver. */
function countFasterCarsBeaten(ctx: RoundContext, position: number): number {
  let n = 0;
  const mine = expectedPositionOf(ctx.world, ctx.tier, ctx.driverId);
  for (const [i, id] of ctx.result.order.entries()) {
    if (id === ctx.driverId) continue;
    if (i + 1 <= position) continue;
    if (expectedPositionOf(ctx.world, ctx.tier, id) < mine) n++;
  }
  return n;
}

/**
 * Applies a move to a driver record and caps it.
 *
 * The cap is enforced HERE and only here, so nothing can push an attribute
 * past a ceiling the screens are drawing a progress bar against.
 */
export function applyMove(d: WorldDriver, move: RatingMove, seed = 0): void {
  const caps = capsFor(d, seed);
  for (const [k, v] of Object.entries(move.delta) as [keyof RatingMove['delta'], number][]) {
    d[k] = clamp01((d[k] as number) + v);
  }
  // Re-read after the move and pull back anything that has gone over its own
  // ceiling. Expressed as a level so the bar and the bound are the same unit.
  const now = ratingsFor(d);
  const pull = (key: RatingKey, attr: 'skill' | 'racecraft' | 'tyreManagement' | 'consistency'): void => {
    const over = now[key] - caps[key];
    if (over > 0) d[attr] = clamp01((d[attr] as number) - over / 100);
  };
  pull('pac', 'skill');
  pull('rac', 'racecraft');
  pull('awa', 'tyreManagement');
  pull('foc', 'consistency');
}

// ===========================================================================
// The accolades — `reference/target/83.png`
// ===========================================================================

/**
 * An accolade: a lifetime counter, three tiers of it, and the attribute
 * completing it enhances.
 *
 * The reference prints `RACE STARTS`, `86/100 | TIER 1`, the sentence
 * "Quantity of Race starts in your F1 career", and "Complete this Accolade to
 * enhance your: Exp | Experience". All four of those come out of this record.
 */
export interface Accolade {
  id: string;
  /** As the heading shouts it. */
  name: string;
  /** The line under the count. */
  note: string;
  /** Which rating it enhances when a tier completes. */
  enhances: RatingKey;
  /** The three thresholds. */
  tiers: readonly [number, number, number];
  /** The counter it reads. */
  count: (r: CareerRecord) => number;
  /** The device drawn on the card. See `accoladeGlyph` in the screen. */
  glyph: 'chevron' | 'shield' | 'diamond' | 'points' | 'five';
}

export const ACCOLADES: readonly Accolade[] = [
  {
    id: 'starts', name: 'Race Starts', note: 'Quantity of Race starts in your career',
    enhances: 'exp', tiers: [100, 250, 500], count: (r) => r.starts, glyph: 'chevron',
  },
  {
    id: 'top10', name: 'Top 10 Finishes', note: 'Quantity of points finishes in your career',
    enhances: 'rac', tiers: [50, 150, 300], count: (r) => r.top10, glyph: 'shield',
  },
  {
    id: 'podiums', name: 'Podium Finishes', note: 'Quantity of podium finishes in your career',
    enhances: 'pac', tiers: [10, 25, 50], count: (r) => r.podiums, glyph: 'diamond',
  },
  {
    id: 'points', name: 'Championship Points', note: 'Championship points scored in your career',
    enhances: 'awa', tiers: [500, 1500, 3000], count: (r) => r.points, glyph: 'points',
  },
  {
    id: 'top5', name: 'Championship Top 5', note: 'Seasons finished in the top five of a championship',
    enhances: 'foc', tiers: [1, 3, 5], count: (r) => r.top5Seasons, glyph: 'five',
  },
];

export interface AccoladeProgress {
  accolade: Accolade;
  /** 1..3, or 4 when all three are complete. */
  tier: number;
  count: number;
  /** The threshold currently being worked toward. */
  target: number;
  /** 0..1. */
  fraction: number;
  complete: boolean;
}

export function accoladeProgress(a: Accolade, r: CareerRecord): AccoladeProgress {
  const count = a.count(r);
  let tier = 1;
  for (const t of a.tiers) if (count >= t) tier++;
  const complete = tier > a.tiers.length;
  const target = complete ? a.tiers[a.tiers.length - 1] : a.tiers[tier - 1];
  const floor = tier <= 1 ? 0 : a.tiers[tier - 2];
  return {
    accolade: a, tier: Math.min(tier, a.tiers.length), count, target,
    fraction: complete ? 1 : clamp01((count - floor) / Math.max(1, target - floor)),
    complete,
  };
}

// ===========================================================================
// Recognition — `reference/target/84.png`
// ===========================================================================

/**
 * The perks, and the share of team recognition each one unlocks at.
 *
 * The reference's own ladder: 35 / 40 / 45 / 50 / 55 / 60 / 65 per cent, with
 * the first three unlocked at 45%. Every one of them names something this
 * career can actually do, because a perk that unlocks nothing is the
 * `TIER_INFO.carPace` mistake in a nicer typeface.
 */
export const RECOGNITION_PERKS: readonly { at: number; name: string }[] = [
  { at: 35, name: '1st R&D Secret Upgrade' },
  { at: 40, name: '2 Simultaneous Upgrades' },
  { at: 45, name: 'R&D Rush' },
  { at: 50, name: '2nd R&D Secret Upgrade' },
  { at: 55, name: '3 Simultaneous Upgrades' },
  { at: 60, name: '3rd R&D Secret Upgrade' },
  { at: 65, name: '∞ Simultaneous Upgrades' },
];

export interface RecognitionSplit {
  /** 0..100, the player's share. The two shares always sum to 100. */
  mine: number;
  theirs: number;
  /** The bonus, in points, on top of the rating-derived share. */
  bonusPct: number;
  /** The four lines the reference itemises under the perk table. */
  breakdown: { label: string; pct: number }[];
}

/**
 * How the garage's attention is split between the two drivers.
 *
 * The base is the two RTGs against each other, because a team backs the driver
 * who scores. Everything else is a bonus on the player's side and every line of
 * it is a real career quantity — which is the point, because the perks it
 * unlocks are real too.
 */
export function recognitionFor(opts: {
  mine: DriverRatings;
  theirs: DriverRatings;
  seasonsAtTeam: number;
  contractYears: number;
  meetings: number;
  academyChoice: boolean;
}): RecognitionSplit {
  const total = Math.max(1, opts.mine.rtg + opts.theirs.rtg);
  const base = (opts.mine.rtg / total) * 100;

  const breakdown = [
    { label: 'Academy Choice', pct: opts.academyChoice ? 4.66 : 0 },
    { label: 'Secret Meeting Bonus', pct: Math.min(6, opts.meetings * 1.5) },
    { label: 'Years with Team', pct: Math.min(5, opts.seasonsAtTeam * 1.55) },
    { label: 'Current Contract', pct: Math.min(4, opts.contractYears * 1.395) },
  ];
  const bonusPct = breakdown.reduce((a, b) => a + b.pct, 0);

  const mine = clamp(base + bonusPct, 0, 100);
  return { mine, theirs: 100 - mine, bonusPct, breakdown };
}

// ===========================================================================
// The market — `reference/target/87.png` and `88.png`
// ===========================================================================

/**
 * Acclaim: how well known this driver is, 0..20.
 *
 * `88.png` sorts the market on it and draws it as a small stepped bar, with
 * the F1 field between 11 and 15. It is a REPUTATION figure rather than a
 * rating: results the public remembers, plus longevity. A quick rookie is
 * worth signing and is not yet famous, and the table is sorted so that shows.
 */
export const ACCLAIM_MAX = 20;

export function acclaimOf(d: Pick<WorldDriver, 'tier' | 'experience'>, ratings: DriverRatings): number {
  const fame = (ratings.rtg - 55) / 45;            // 0 at 55 RTG, 1 at 100
  const tenure = Math.min(1, startsOf(d) / 150);
  const tier = d.tier === 'F1' ? 1 : d.tier === 'F2' ? 0.55 : 0.3;
  return Math.round(clamp((fame * 0.62 + tenure * 0.38) * ACCLAIM_MAX * tier, 0, ACCLAIM_MAX));
}

/**
 * What a driver would cost to buy out of their seat.
 *
 * Their salary, times the years still to run, times a documented fraction —
 * the same shape as `engineBreakFeeUsd` in `MyTeam.ts`, and deliberately the
 * corrected version of it: a contract that has already expired costs nothing
 * to break, which the exported copy in that file got wrong (§6, My Team).
 */
export function buyoutUsd(d: WorldDriver): number {
  const years = Math.max(0, d.contractYears);
  if (years <= 0) return 0;
  return Math.round(d.salaryUsd * years * 0.5);
}

/**
 * Market value.
 *
 * Not the salary. `88.png` prints both and they differ: Lawson is $3M of
 * salary and $3M of value, Hulkenberg $5.5M of salary and $8.25M of value.
 * Value is what the paddock thinks the driver is worth; salary is what this
 * particular contract pays. So value is built from the RATING and the ACCLAIM,
 * and salary stays the contract's own number.
 */
export function marketValueUsd(d: WorldDriver, ratings: DriverRatings): number {
  const acclaim = acclaimOf(d, ratings);
  // A steep curve: the difference between an 85 and a 92 is most of the money
  // in a driver market, which is what makes signing one a decision.
  //
  // The floor is 35 rather than 50 because a floor at 50 priced the entire
  // bottom of a junior grid at exactly $0.00M — a market where a third of the
  // rows read zero is a market with no information in it.
  const rating = Math.pow(clamp01((ratings.rtg - 35) / 65), 2.1);
  const tierScale = d.tier === 'F1' ? 12e6 : d.tier === 'F2' ? 2.2e6 : 0.9e6;
  const fameScale = 0.55 + (acclaim / ACCLAIM_MAX) * 0.75;
  const age = d.age >= 34 ? 1 - (d.age - 33) * 0.09 : d.age <= 22 ? 1.06 : 1;
  const usd = rating * tierScale * fameScale * clamp(age, 0.3, 1.1);
  // Rounded to $50k, because a driver market quoting $8,247,113 is a
  // spreadsheet rather than a valuation.
  return Math.max(0, Math.round(usd / 50_000) * 50_000);
}

/** One row of the driver market, with everything the table and card print. */
export interface MarketEntry {
  driver: WorldDriver;
  ratings: DriverRatings;
  caps: Record<RatingKey, number>;
  acclaim: number;
  marketValueUsd: number;
  buyoutUsd: number;
  teamName: string;
  /** True for the player's own record. */
  isPlayer: boolean;
}

export type MarketSort = 'acclaim' | 'value' | 'rating' | 'name' | 'team';

/**
 * The whole market, as the table draws it.
 *
 * ONE function, so the table (`88.png`), the comparison (`87.png`) and the
 * My Team signing flow are three views of one list rather than three lists.
 */
export function buildMarket(opts: {
  world: CareerWorld;
  tier: TierId;
  playerDriverId: string;
  playerStarts: number;
  pressure: number;
  seed: number;
  teamName: (teamId: string) => string;
  /** Restrict to drivers without a seat. */
  freeAgentsOnly?: boolean;
}): MarketEntry[] {
  const t = opts.world.tiers[opts.tier];
  const out: MarketEntry[] = [];
  for (const d of t.drivers) {
    if (d.retired) continue;
    if (opts.freeAgentsOnly && d.teamId) continue;
    const isPlayer = d.id === opts.playerDriverId;
    const ratings = ratingsFor(d, isPlayer
      ? { pressure: opts.pressure, starts: opts.playerStarts }
      : {});
    out.push({
      driver: d,
      ratings,
      caps: capsFor(d, opts.seed),
      acclaim: acclaimOf(d, ratings),
      marketValueUsd: marketValueUsd(d, ratings),
      buyoutUsd: buyoutUsd(d),
      teamName: d.teamId ? opts.teamName(d.teamId) : 'Free agent',
      isPlayer,
    });
  }
  return out;
}

export function sortMarket(rows: MarketEntry[], by: MarketSort): MarketEntry[] {
  const out = rows.slice();
  switch (by) {
    case 'acclaim': out.sort((a, b) => b.acclaim - a.acclaim || b.ratings.rtg - a.ratings.rtg); break;
    case 'value': out.sort((a, b) => b.marketValueUsd - a.marketValueUsd); break;
    case 'rating': out.sort((a, b) => b.ratings.rtg - a.ratings.rtg); break;
    case 'name': out.sort((a, b) => a.driver.lastName.localeCompare(b.driver.lastName)); break;
    case 'team': out.sort((a, b) => a.teamName.localeCompare(b.teamName)
      || b.ratings.rtg - a.ratings.rtg); break;
  }
  return out;
}

// ===========================================================================
// Bookkeeping helpers the career calls
// ===========================================================================

/** Folds one race weekend into the lifetime counters. */
export function recordRoundInRecord(
  record: CareerRecord, result: RoundResult, driverId: string, pointsScored: number,
): void {
  const i = result.order.indexOf(driverId);
  if (i < 0) return;
  record.starts++;
  record.points += pointsScored;
  const retired = result.retired.includes(driverId)
    || (result.disqualified ?? []).includes(driverId);
  if (retired) { record.dnfs++; return; }
  const pos = i + 1;
  if (pos === 1) record.wins++;
  if (pos <= 3) record.podiums++;
  if (pos <= 10) record.top10++;
  if (result.poleDriverId === driverId) record.poles++;
  if (result.fastestLapDriverId === driverId) record.fastestLaps++;
}

/** Folds one closed season into the lifetime counters. */
export function recordSeasonInRecord(
  record: CareerRecord, championshipPosition: number,
): void {
  if (championshipPosition === 1) record.titles++;
  if (championshipPosition >= 1 && championshipPosition <= 5) record.top5Seasons++;
}

/** Finds the driver's own record in the world, or null. */
export function driverRecord(world: CareerWorld, id: string): WorldDriver | null {
  return findDriver(world, id) ?? null;
}
