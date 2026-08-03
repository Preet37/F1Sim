import { clamp01, lerp } from '../core/MathUtils';
import { brakeFor } from './PitLimiter';

/**
 * The speed limit a neutralisation imposes, and what it takes to arrive at it.
 *
 * The direct sibling of `PitLimiter.ts`, and deliberately built the same way and
 * for the same reason. The pit lane taught the lesson: three separate pieces of
 * the simulation have to agree exactly about a speed limit, and while they did
 * not, the disagreement was worth a penalty every time a car came in. A
 * neutralisation is the same shape of problem with the same three consumers:
 *
 *   - `AIVehicleController` folds the limit into the target speed its nineteen
 *     cars drive to.
 *
 *   - `RaceEngine` does it for the PLAYER, whose limiter is automatic in the
 *     pit lane and had no equivalent under a safety car. The player's report is
 *     one sentence about both: "under safetycar and flags and everything every
 *     car has to follow the speedlimit, it should auto put the speed up." The
 *     AI was fixed. The player was still being asked to judge a delta by eye
 *     against a HUD that told them nothing about what the delta was.
 *
 *   - `RaceControlManager` judges the marshalling-sector times that decide
 *     whether the limit was obeyed, against the same numbers.
 *
 * WHAT IS AND IS NOT A REGULATION HERE. The obligation itself is: drivers "must
 * stay above the minimum time set by the FIA ECU at least once in each
 * marshalling sector" under both the safety car and the VSC (2025 Sporting Regs
 * Art. 55.7 and 56.5 / 2026 Section B Art. B5.13.2b and B5.12.2b), the queue
 * forms up "no more than ten (10) car lengths apart" (Art. 55.7 / B5.13.2b),
 * and a car waved past has to pass the whole queue within a lap (Art. 55.14 /
 * B5.13.4c) which cannot be done at the delta. The PACE is not: the FIA
 * publishes neither a percentage nor a formula, so the cap and the scale that
 * produce it are a modelling choice and live where they are calibrated, in
 * `RaceControlManager`. This file only combines them with the situation.
 */

/**
 * How the limit applies to one car right now.
 *
 * A CAP and a SCALE, never a target the car is asked to reach. The distinction
 * is not cosmetic: the scale multiplies whatever cornering limit the car's own
 * grip allows, so it can only ever slow the car down, while a target would
 * override that limit and send a car told to close a gap straight on at a
 * hairpin.
 */
export interface NeutralisedLimit {
  /** Straight-line speed cap, m/s. */
  capMs: number;
  /** Fraction of the speed the car would otherwise carry, 0..1 or above. */
  scale: number;
  /** True while this car is entitled to run quicker than the queue pace. */
  catchingUp: boolean;
}

/**
 * The share of the maximum queue gap the field actually runs at.
 *
 * A modelling choice with a regulation behind it in one direction only: the ten
 * car lengths of Art. 55.7 / B5.13.2b is a ceiling that must not be exceeded,
 * and nothing says how far inside it to sit. Just over half is what the
 * television pictures show — the cars are nose to tail behind a safety car, not
 * strung out at the maximum they are permitted.
 */
export const SC_QUEUE_TARGET_SHARE = 0.55;

/**
 * How much above the delta a car waved past may run while unlapping itself.
 *
 * It has a lap to make up on the entire queue and on the safety car, and
 * Art. 55.14 / B5.13.4c requires it to complete the manoeuvre, so it cannot do
 * it at the delta. Real unlapping runs are visibly quicker than the queue.
 */
export const UNLAP_PACE_MULT = 1.75;

/** Reused so the per-step path allocates nothing. */
const scratch: NeutralisedLimit = { capMs: 0, scale: 1, catchingUp: false };

/**
 * Works out the cap and scale for one car under a neutralisation.
 *
 * @param capMs        the neutralised cap, `RaceControlManager.vscTargetMs`
 * @param scale        the neutralised scale, `neutralisedScale`
 * @param catchUpMult  how much quicker a car closing a gap may run
 * @param queueGapLimitM  the ten-car-length limit, or 0 when it does not apply
 * @param gapAheadM    metres to whatever is in front in the queue, -1 for none
 * @param mustUnlap    this car has been waved past and has a lap to make up
 * @param unlapMult    how much quicker a car unlapping itself may run
 *
 * The returned object is REUSED. Read it before calling again.
 */
export function neutralisedLimit(
  capMs: number,
  scale: number,
  catchUpMult: number,
  queueGapLimitM: number,
  gapAheadM: number,
  mustUnlap: boolean,
  unlapMult: number,
): NeutralisedLimit {
  scratch.capMs = capMs;
  scratch.scale = scale > 0 ? scale : 1;
  scratch.catchingUp = false;

  // A car that has been waved past is under an instruction it cannot obey at
  // the delta: pass the entire queue and the safety car inside a lap
  // (Art. 55.14 / B5.13.4c).
  if (mustUnlap) {
    scratch.capMs *= unlapMult;
    scratch.scale = 1;
    scratch.catchingUp = true;
    return scratch;
  }

  // "All F1 Cars must reduce speed and form up behind the Safety Car no more
  // than ten (10) car lengths apart" — Art. 55.7 / B5.13.2b.
  //
  // TEN CAR LENGTHS IS A MAXIMUM, NOT A TARGET, and reading it as a target is
  // what left the queue permanently on the wrong side of it. A ramp that begins
  // at the limit gives a car sitting exactly on the limit no reason at all to
  // close, so the queue settled into an equilibrium a few metres either side of
  // it and 63% of measured gaps were over. Drivers do not do that: they close
  // right up, and the gap they hold is a fraction of what they are allowed. So
  // the ramp begins well inside the limit, and the limit is where the ramp has
  // already got some urgency behind it rather than where it starts.
  const target = queueGapLimitM * SC_QUEUE_TARGET_SHARE;
  if (queueGapLimitM > 0 && gapAheadM > target) {
    // The urgency ramp relaxes the corner scale as well as the straight-line
    // cap, because a car that only gets a higher cap can close a gap on the
    // straights and nowhere else — which at a circuit that is mostly corners is
    // not closing it at all.
    const urgency = clamp01((gapAheadM - target) / (queueGapLimitM * 2));
    scratch.capMs *= 1 + urgency * (catchUpMult - 1);
    // Capped at twice the neutralised scale rather than at racing pace: a car
    // closing the queue is quicker than the queue, not as quick as it was under
    // green, and letting it back to green pace turns catching up into racing.
    scratch.scale = lerp(scratch.scale, Math.min(1, scratch.scale * 2), urgency);
    scratch.catchingUp = urgency > 0;
  }
  return scratch;
}

/** Applies a limit to a speed the car would otherwise have carried, m/s. */
export function applyNeutralisedLimit(speedMs: number, limit: NeutralisedLimit): number {
  return Math.min(speedMs * limit.scale, limit.capMs);
}

/**
 * Station-keeping: the speed the thing in front allows, m/s.
 *
 * Inside the target gap a driver in a queue drives to the car in front, not to
 * a pace, and the difference is the difference between a train and twenty cars
 * that happen to be doing the same average speed. Every car in the queue is at
 * a different point on the lap, so a pace-only queue has each car braking for
 * its own corner while the one behind is still on a straight; the gaps breathe
 * by hundreds of metres a lap and the concertina never settles.
 *
 * The taper reaches exactly 1 at the target gap. That is what stops it
 * compounding down nineteen cars: a car sitting at the target asks for exactly
 * the speed of the thing in front, so the train propagates the pace rather than
 * dividing it.
 *
 * Returns `Infinity` when there is nothing to hold station on.
 *
 * @param minMovingMs below this the thing in front has stopped racing and is to
 *        be driven around rather than queued behind
 */
export function queueHoldMs(
  queueAheadM: number,
  queueAheadSpeedMs: number,
  queueGapLimitM: number,
  minMovingMs: number,
): number {
  const hold = queueGapLimitM * SC_QUEUE_TARGET_SHARE;
  if (hold <= 0 || queueAheadM < 0 || queueAheadM >= hold) return Infinity;
  if (queueAheadSpeedMs <= minMovingMs) return Infinity;
  const t = clamp01(queueAheadM / hold);
  return queueAheadSpeedMs * lerp(0.55, 1, t);
}

/**
 * Planning deceleration for a neutralisation, m/s².
 *
 * Well below the pit entry's, and for a reason the pit entry does not have: the
 * pit entry is a line at a known distance that must be crossed under a known
 * speed, and a neutralisation is a limit that varies continuously along the lap
 * as the racing line's own speed does. Planning it at the pit entry's rate
 * would put the player on the brakes hard for every corner of a safety car lap,
 * which is not what the field around them is doing — the AI arrives at the same
 * corner having simply lifted.
 */
export const NEUTRAL_DECEL_MS2 = 4.5;

/**
 * How far ahead the limit is looked at, metres, and at what spacing.
 *
 * A limiter that only reads the limit where the car IS arrives at every corner
 * over the limit and then cuts, which is a car that lurches round a safety car
 * lap. The lookahead is the same square-root profile `pitEntryCeilingMs` uses:
 * for each point ahead, the fastest the car may be doing NOW to still be under
 * the limit when it gets there, and the limiter takes the lowest.
 *
 * Two hundred metres is about four seconds at safety car pace, which is longer
 * than the approach to any corner at that speed.
 */
export const NEUTRAL_LOOKAHEAD_M = 200;
/**
 * Ten metres, not twenty.
 *
 * The limit is capped by the car's own cornering limit, and that is computed
 * over a nine-metre curvature window — so a twenty-metre sampling grid can step
 * straight over the tightest part of a hairpin and only discover it once the
 * car is in it. The setpoint then falls by twenty metres a second between two
 * steps and a limiter bounded to a g cannot follow that. Halving the step
 * costs ten array lookups and removes the class of spike entirely.
 */
export const NEUTRAL_LOOKAHEAD_STEP_M = 10;

/**
 * How much of the limit the limiter actually holds.
 *
 * The same idea as `PIT_LIMIT_MARGIN_KPH`: nobody drives a limit on the number
 * itself, and here there is a specific reason to sit under it. Race control
 * times each marshalling sector and penalises one completed too quickly
 * (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b), so a car held exactly on the
 * pace has no margin for the parts of a sector where the road lets it run
 * faster than the plan.
 */
export const NEUTRAL_LIMIT_MARGIN = 0.97;

/**
 * How close to the theoretical cornering limit the neutralised limit is set.
 *
 * The neutralised pace is a FRACTION of the speed the car would otherwise
 * carry, and "would otherwise carry" has to mean the same thing for the player
 * as for the nineteen cars around them. The AI never runs at the theoretical
 * corner limit — nobody does; the limit assumes a perfect line, ideal load
 * distribution and no longitudinal force — and its own commitment factor lands
 * between 0.855 and 0.93 depending on the driver and the circuit.
 *
 * Taking the raw racing-line speed instead is the mistake this exists to
 * prevent, and it is invisible at a circuit like Monza where the neutralised
 * CAP binds on the straights and hides it. At Monaco, where nothing on the lap
 * is quicker than the cap anyway, it let the player run 47% faster than the
 * queue they were sitting in while every individual number involved looked
 * correct.
 *
 * The top of the AI's range rather than the middle, because this is a CEILING
 * the player is held under rather than a target they are driven to: a limit
 * that is stricter than what the field is doing is a different kind of wrong.
 */
export const NEUTRAL_COMMITMENT = 0.93;

/**
 * What the limiter should hold, and what the driver has to do to get there.
 *
 * The pit lane's two halves, in the pit lane's own order. `applyPitLaneAssist`
 * brakes for the entry with `brakeFor` and then arms the limiter; this returns
 * the same pair for a limit that moves along the lap instead of sitting at a
 * fixed line — and it uses the same `brakeFor`, so a driver arriving at a
 * neutralised corner and a driver arriving at the pit entry are doing the same
 * thing in the same code.
 *
 * The braking scan deliberately starts one step AHEAD rather than at the car.
 * Braking for the limit where the car already is fights the limiter for the
 * whole of a safety car lap — the pedal would flicker on every metre the road
 * lets the car run a fraction quick. Holding the limit where the car is, is the
 * limiter's job and it is bounded to a g while doing it; the pedal's job is the
 * corner two hundred metres away that a limiter cannot see.
 */
export interface NeutralisedPlan {
  /** Speed the limiter holds, m/s. */
  ceilingMs: number;
  /** Brake pedal needed for the limit ahead, 0..1. */
  brake: number;
}

const plan: NeutralisedPlan = { ceilingMs: 0, brake: 0 };

/**
 * Deceleration the GREEN reference profile is built with, m/s².
 *
 * Not the same number as `NEUTRAL_DECEL_MS2` and not used for the same thing.
 * This one answers "how fast would a racing car actually be going here", which
 * is the quantity the neutralised scale multiplies — and the answer on a short
 * straight between two hairpins is "much less than the racing line's speed,
 * because it is already braking for the next one". Racing braking, not
 * neutralised braking.
 *
 * Leaving it out is what let the player run twice the field's pace at Monaco.
 * The racing line's speed is a corner-by-corner ideal that a car only ever
 * touches at the fastest point of each straight; scale THAT by a half and the
 * result is a limit which, everywhere else on a tight circuit, is well above
 * what the nineteen cars around the player are doing.
 */
const GREEN_BRAKE_MS2 = 18;

/** The reference profile, pre-allocated: nothing here allocates per step. */
const N_LOOKAHEAD = Math.round(NEUTRAL_LOOKAHEAD_M / NEUTRAL_LOOKAHEAD_STEP_M) + 1;
const baseProfile = new Float64Array(N_LOOKAHEAD);

/**
 * @param baseAtM the speed the car would carry `d` metres ahead if the race
 *        were green, m/s, before any neutralisation is applied
 * @param limit the cap and scale from `neutralisedLimit`
 *
 * Takes the lookahead as a function so the caller owns the track: the race
 * engine has a spline, and a probe has whatever it is staging. The returned
 * object is REUSED — read it before calling again.
 */
export function neutralisedPlan(
  speedMs: number, baseAtM: (d: number) => number, limit: NeutralisedLimit,
): NeutralisedPlan {
  for (let i = 0; i < N_LOOKAHEAD; i++) {
    baseProfile[i] = baseAtM(i * NEUTRAL_LOOKAHEAD_STEP_M);
  }
  // Backwards pass: a car cannot be doing more here than it can shed before the
  // corner it is approaching. One O(n) sweep turns a set of independent corner
  // limits into the speed profile a car actually drives.
  for (let i = N_LOOKAHEAD - 2; i >= 0; i--) {
    const reachable = Math.sqrt(
      baseProfile[i + 1] * baseProfile[i + 1] +
      2 * GREEN_BRAKE_MS2 * NEUTRAL_LOOKAHEAD_STEP_M,
    );
    if (reachable < baseProfile[i]) baseProfile[i] = reachable;
  }

  let ceiling = Infinity;
  let pedal = 0;
  for (let i = 0; i < N_LOOKAHEAD; i++) {
    const d = i * NEUTRAL_LOOKAHEAD_STEP_M;
    const v = applyNeutralisedLimit(baseProfile[i], limit);
    // v = sqrt(vt² + 2ad): the constant-deceleration solution, so a limit that
    // drops for a corner is met by lifting early rather than by cutting late.
    const allowed = Math.sqrt(v * v + 2 * NEUTRAL_DECEL_MS2 * d);
    if (allowed < ceiling) ceiling = allowed;
    if (d > 0) {
      const p = brakeFor(speedMs, v, d, NEUTRAL_DECEL_MS2);
      if (p > pedal) pedal = p;
    }
  }
  plan.ceilingMs = ceiling * NEUTRAL_LIMIT_MARGIN;
  plan.brake = pedal;
  return plan;
}

/**
 * How fast the assist's brake pedal may move, pedal travel per second.
 *
 * THE SWERVE. The player's report is "there is a glitch that when the safety car
 * happened, I was supposed to be limited and in that case my car swerved", and
 * measured — `npm run probe:neutralsteer`, which records the car's heading every
 * physics step — the assist was slamming the pedal from nothing to more than
 * half its travel in a SINGLE 8ms step, fourteen hundred times in one race at
 * Monaco, against zero times with the assist switched off.
 *
 * That is not a limiter, it is a kick. The plan behind it is computed afresh
 * every step from a two-hundred-metre lookahead, and the pedal it asks for is
 * the MAXIMUM over that window (see `neutralisedPlan`): a corner entering the
 * window from two hundred metres away arrives whole, at whatever pedal it needs,
 * between one step and the next. In a straight line that is merely abrupt. In a
 * corner it puts a large longitudinal demand through tyres that are already
 * spending their grip laterally, the friction circle takes the difference out of
 * the lateral force, and the car changes direction. The pit lane has exactly the
 * same machinery and never showed it, because a pit entry is a straight line.
 *
 * So the pedal moves at a rate a foot moves at. Three per second is a third of a
 * second from nothing to everything, which is quick, and it is the same order as
 * the keyboard pedal rates the input layer uses for the player's own foot.
 */
export const NEUTRAL_PEDAL_RATE = 3;

/**
 * How fast the held ceiling may move, m/s per second.
 *
 * The second half of the same problem, and the reason it is separate. The
 * setpoint is `min(plan.ceilingMs, queueHoldMs(...))` and the second term is
 * DISCONTINUOUS by construction: `queueHoldMs` returns the speed of the car in
 * front while inside the target gap and `Infinity` outside it, so a car drifting
 * across the target gap sees its ceiling step by the whole difference between
 * its own plan and the speed of whatever is in front. Measured at Zandvoort the
 * setpoint moved 22 m/s between two consecutive steps — eighty km/h in eight
 * milliseconds — and the limiter, which is bounded to a g, spends the next
 * second trying to catch a number that has already moved again.
 *
 * Falling is allowed to be quicker than rising and both are bounded by what the
 * car could actually do: `NEUTRAL_DECEL_MS2` is the rate the plan is built at, so
 * a ceiling that falls at that rate is a ceiling the planning profile has already
 * arranged for the car to meet.
 */
export const NEUTRAL_CEILING_FALL_MS2 = NEUTRAL_DECEL_MS2;
export const NEUTRAL_CEILING_RISE_MS2 = 6;

/**
 * The assist's own memory, one per car.
 *
 * It exists because a limiter with no memory cannot be rate-limited, and a
 * limiter that cannot be rate-limited is the defect above. Long-lived and
 * mutable, like everything else hanging off a `CarEntry`.
 */
export class NeutralisedAssistState {
  /** Pedal the assist is currently asking for, 0..1. */
  brake = 0;
  /** Ceiling the assist is currently holding, m/s. 0 when not armed. */
  ceilingMs = 0;

  reset(): void {
    this.brake = 0;
    this.ceilingMs = 0;
  }

  /**
   * Moves the assist toward what the plan wants, at a rate a car can absorb.
   *
   * @param wantBrake   the plan's pedal
   * @param wantCeiling the setpoint the plan and the queue between them ask for
   * @param brakeCeiling the most pedal the tyres have left after cornering —
   *        `VehiclePhysics.brakeLimitFraction`, which is the friction circle's
   *        own answer and already knows how much lateral force is committed
   */
  advance(dt: number, wantBrake: number, wantCeiling: number, brakeCeiling: number): void {
    // Never more pedal than there is grip to take it. Asking for more does not
    // produce more braking — the friction circle clamps it — it produces the
    // clamp, and the clamp is applied per axle, which is what steps the back of
    // the car out. Just inside the limit, exactly as the AI drives it.
    const target = Math.min(wantBrake, brakeCeiling * 0.95);
    const dp = target - this.brake;
    const maxDp = NEUTRAL_PEDAL_RATE * dt;
    this.brake = Math.abs(dp) <= maxDp ? target : this.brake + Math.sign(dp) * maxDp;
    if (this.brake < 0) this.brake = 0;

    // The ceiling. Armed from wherever the car currently is rather than from
    // zero, so the first step of a neutralisation is not a wall.
    if (this.ceilingMs <= 0) {
      this.ceilingMs = wantCeiling;
      return;
    }
    const dv = wantCeiling - this.ceilingMs;
    const rate = (dv < 0 ? NEUTRAL_CEILING_FALL_MS2 : NEUTRAL_CEILING_RISE_MS2) * dt;
    this.ceilingMs = Math.abs(dv) <= rate ? wantCeiling : this.ceilingMs + Math.sign(dv) * rate;
  }
}
