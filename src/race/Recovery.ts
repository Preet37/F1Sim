/**
 * Getting a crashed car off the circuit.
 *
 * The question this exists to answer is the player's: "if there is a crash for a
 * car that's not the user car, then it should probably clear the car up
 * eventually right?" It should, and before this it did not — not really. A
 * retired car sat where it stopped for a flat one hundred and fifty seconds, on
 * every circuit, in every place, whatever had happened to it, and then vanished.
 * Two constants in two files had to be kept equal by hand for the flag to come
 * down at the same moment the car stopped being drawn.
 *
 * A recovery is not a timer. It is an operation with prerequisites, and the
 * prerequisites are what make it interesting:
 *
 *   WHERE THE CAR IS decides how it has to be moved. A car that has rolled to a
 *   stop in an escape road is pushed through a gap in the barrier by four
 *   marshals in under half a minute. A car buried nose-first in a gravel trap
 *   needs a tractor or a crane, and that is minutes, not seconds.
 *
 *   WHERE THE MARSHALS HAVE TO STAND decides whether the race can continue
 *   around them. This is the part with a regulation behind it. The safety car is
 *   deployed when "Competitors or officials are in immediate physical danger on
 *   or near the track" (2025 Sporting Regs Art. 55.3 / 2026 Section B Art.
 *   B5.13.1) and the VSC when "double waved yellow flags are needed on any
 *   section of track and Competitors or officials may be in danger, but the
 *   circumstances are not such as to warrant use of the Safety Car" (Art. 56.1a /
 *   B5.12). Both articles are about people being where the cars run. So a
 *   recovery that puts marshals or a recovery vehicle on or beside the racing
 *   surface REQUIRES the race to be neutralised, and one that happens behind the
 *   barriers does not — the yellow flags at that post are enough, which is the
 *   ISC Appendix H Art. 2.5.5b single-waved-yellow case: a hazard beside the
 *   track with marshals working on it.
 *
 * That is the whole model. Everything else here is the arithmetic of it.
 *
 * WHAT THE NUMBERS ARE. None of the durations below are regulations — the FIA
 * publishes no recovery times and there is nothing to cite for them. They are
 * chosen against televised recoveries: a car pushed behind a barrier is off the
 * circuit in well under a minute, a crane lift out of a gravel trap runs to two
 * or three minutes with the debris sweep, and a virtual safety car for a stopped
 * car is typically a lap or two rather than the four laps the old flat timer
 * produced.
 */

/** How the car has to be moved. */
export type RecoveryMethod = 'push' | 'crane';

/** What a marshal post shows for an operation, or null when it is finished. */
export type RecoverySignal = 'yellow' | 'double-yellow' | null;

export type RecoveryPhase = 'reaching' | 'waiting' | 'working' | 'clear';

/**
 * How far beyond the white line an operation still counts as being on the road,
 * metres.
 *
 * Inside this the marshals — or the front of a tractor — are within a car's
 * width of a racing line, which is the "on or near the track" of Art. 55.3 /
 * B5.13.1. Outside it they are behind the barrier and the cars go past.
 *
 * This is the same margin race control uses to decide whether a stopped car is
 * still a hazard worth flagging, and it is deliberately one number rather than
 * two: a car that warrants a flag and a car that warrants people standing next
 * to it are the same car.
 */
export const RECOVERY_TRACKSIDE_M = 4;

/**
 * The same distance, on a part of the circuit the cars arrive at quickly.
 *
 * A run-off at the end of a straight is crossed at a closing speed nothing on
 * foot can react to, so the working area that has to be clear of racing cars is
 * wider. The speed that divides "fast" from "slow" is the one race control
 * already uses to decide a stopped car is dangerous.
 */
export const RECOVERY_TRACKSIDE_FAST_M = 8;

/** Racing-line speed above which a stretch of circuit counts as fast, m/s. */
export const RECOVERY_FAST_SECTION_MS = 50;

/**
 * Beyond this far into the run-off a car has to be lifted, not pushed, metres.
 *
 * Marshals push a car a long way by hand — the limit is not their strength, it
 * is whether the car will roll at all and whether there is a barrier opening to
 * push it through. A car that has run twelve metres off is in the gravel or
 * against the wall, and that is a tractor's job.
 */
export const RECOVERY_CRANE_OFFROAD_M = 12;

/** Wreck severity above which the car is lifted whatever its position. */
export const RECOVERY_CRANE_SEVERITY = 0.6;

/** Seconds before the nearest marshals are at a car beside the road. */
export const MARSHAL_REACH_BASE_S = 9;
/** Extra seconds per metre they have to cross to get to it. */
export const MARSHAL_REACH_PER_M_S = 0.55;

/** Seconds to push a car through a gap in the barrier. */
export const RECOVERY_PUSH_S = 16;
/** Seconds to get a tractor or crane to a car and lift it out. */
export const RECOVERY_CRANE_S = 46;
/** Seconds of sweeping a completely destroyed car's debris off the road. */
export const RECOVERY_SWEEP_S = 30;

/**
 * The longest any recovery may take, seconds.
 *
 * A backstop, not a model. An operation that needs the race neutralised and
 * never gets it — the chequered flag has fallen, the session is a practice
 * session where no safety car exists, the field is down to two cars and race
 * control has better things to do — would otherwise hold a yellow flag for the
 * rest of the session and, through it, keep the race permanently neutralised.
 * The marshals get it done eventually.
 */
export const RECOVERY_BACKSTOP_S = 210;

/**
 * One car's recovery, from the moment it stops to the moment it and its
 * bodywork have gone.
 *
 * Long-lived and mutable, like everything else hanging off a `CarEntry`: one is
 * allocated per car when the session is built and reset between sessions.
 */
export class RecoveryOperation {
  /** True once the car and its debris have actually been taken away. */
  done = false;

  /** Seconds since the car stopped. */
  elapsedS = 0;

  /** Marshal travel still to run before work can begin, seconds. */
  reachRemainingS = 0;

  /** Recovery work still to run once they are at the car, seconds. */
  workRemainingS = 0;

  /**
   * True while the operation would put people or a recovery vehicle where the
   * racing cars run, so it cannot begin until the race is neutralised.
   */
  needsNeutralisation = false;

  /** How the car has to be moved. */
  method: RecoveryMethod = 'push';

  /** True once the marshals are at the car and only the work is left. */
  reached = false;

  /**
   * True once the plan has been frozen.
   *
   * A retired car does not move, but it may still be sliding on the step it
   * retires, so the site is re-read until the marshals actually arrive. After
   * that the plan is theirs and cannot change under them.
   */
  private frozen = false;

  /** True once anything has been planned at all. */
  private planned = false;

  reset(): void {
    this.done = false;
    this.elapsedS = 0;
    this.reachRemainingS = 0;
    this.workRemainingS = 0;
    this.needsNeutralisation = false;
    this.method = 'push';
    this.reached = false;
    this.frozen = false;
    this.planned = false;
  }

  /**
   * Reads the site and works out what the recovery will take.
   *
   * @param offRoadM   metres the car is beyond the white line; negative when it
   *                   is still on the racing surface
   * @param lineSpeedMs racing-line speed where it stopped
   * @param wreckSeverity 0..1, how comprehensively the car was destroyed — a
   *                   reliability retirement is 0, a car folded into a barrier
   *                   is near 1, and it buys both a crane and a debris sweep
   */
  plan(offRoadM: number, lineSpeedMs: number, wreckSeverity: number): void {
    if (this.frozen) return;

    const clearance = lineSpeedMs > RECOVERY_FAST_SECTION_MS
      ? RECOVERY_TRACKSIDE_FAST_M : RECOVERY_TRACKSIDE_M;

    this.method =
      offRoadM > RECOVERY_CRANE_OFFROAD_M || wreckSeverity > RECOVERY_CRANE_SEVERITY
        ? 'crane' : 'push';

    // Two ways an operation ends up needing the race slowed down. Either people
    // are working within a car's width of a racing line, or a recovery VEHICLE
    // has to come inside the barriers at all — a tractor is driven in through a
    // gate and a crane swings its jib over the circuit, and neither is
    // something a modern race director allows at racing speed anywhere on the
    // lap. A car that will roll and can be pushed out through the nearest
    // opening needs none of that, and gets a yellow at its own post and nothing
    // else, which is the common case and the reason a race with three
    // retirements in it still finishes.
    this.needsNeutralisation = offRoadM < clearance || this.method === 'crane';

    const reach = MARSHAL_REACH_BASE_S + Math.max(offRoadM, 0) * MARSHAL_REACH_PER_M_S;
    const work = (this.method === 'crane' ? RECOVERY_CRANE_S : RECOVERY_PUSH_S) +
      RECOVERY_SWEEP_S * Math.max(wreckSeverity, 0);

    if (!this.planned) {
      this.planned = true;
      this.reachRemainingS = reach;
      this.workRemainingS = work;
      return;
    }
    // Re-planned while the car was still settling: keep whatever progress has
    // been made rather than restarting the clock, but adopt the new totals.
    this.reachRemainingS = Math.min(this.reachRemainingS, reach);
    this.workRemainingS = work;
  }

  /**
   * Runs the operation for one step.
   *
   * @param permitted true when the marshals may work — the race is neutralised,
   *        or the operation is behind the barriers and never needed it
   * @returns true on the step the car and its debris are finally gone
   */
  advance(dt: number, permitted: boolean): boolean {
    if (this.done) return false;
    this.elapsedS += dt;

    // Getting there happens whatever the race is doing: the marshals walk to
    // the car from their own post, on their own side of the barrier.
    if (this.reachRemainingS > 0) {
      this.reachRemainingS -= dt;
      if (this.reachRemainingS <= 0) {
        this.reachRemainingS = 0;
        this.reached = true;
        this.frozen = true;
      }
      // The backstop still runs while they are on their way.
      return this.checkBackstop();
    }
    this.reached = true;
    this.frozen = true;

    // The work itself is the part that needs the cars slowed down, and only
    // when it puts somebody on or beside the racing surface.
    if (permitted || !this.needsNeutralisation) {
      this.workRemainingS -= dt;
      if (this.workRemainingS <= 0) {
        this.workRemainingS = 0;
        this.done = true;
        return true;
      }
    }
    return this.checkBackstop();
  }

  private checkBackstop(): boolean {
    if (this.elapsedS < RECOVERY_BACKSTOP_S) return false;
    this.reachRemainingS = 0;
    this.workRemainingS = 0;
    this.reached = true;
    this.done = true;
    return true;
  }

  get phase(): RecoveryPhase {
    if (this.done) return 'clear';
    if (!this.reached) return 'reaching';
    return this.needsNeutralisation ? 'waiting' : 'working';
  }

  /**
   * What the posts covering this incident display.
   *
   * Double waved yellow while the operation is on or beside the racing surface
   * — "the hazard is wholly or partly blocking the track, or there are marshals
   * on the track" (ISC Appendix H Art. 2.5.5b; 2025 Art. 26.1b / 2026 Art.
   * B1.8.4b). Single waved yellow for a hazard beside the track being worked on
   * from behind the barrier (Appendix H Art. 2.5.5b; Art. 26.1a / B1.8.4a).
   * Nothing once the car has gone — and that, not a timer, is what puts the
   * sector back to green.
   */
  get signal(): RecoverySignal {
    if (this.done) return null;
    return this.needsNeutralisation ? 'double-yellow' : 'yellow';
  }

  /**
   * True while this incident is a reason to neutralise the race.
   *
   * The recovery cannot be carried out with cars going past it at racing speed,
   * so the race stays neutralised until it is finished. That is the direct
   * reading of Art. 55.3 / B5.13.1 and Art. 56.1a / B5.12, both of which
   * describe the danger to OFFICIALS as the trigger, and it is why a VSC ends
   * when the crane leaves rather than on a stopwatch.
   */
  get warrantsNeutralisation(): boolean {
    return !this.done && this.needsNeutralisation;
  }

  /** Seconds of recovery still outstanding, for the radio and the HUD. */
  get remainingS(): number {
    return this.reachRemainingS + this.workRemainingS;
  }
}
