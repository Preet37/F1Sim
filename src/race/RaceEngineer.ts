import type { CarEntry } from './CarEntry';
import type { TeamNote } from './RaceControlManager';
import type { RadioAnswer, RadioCall } from './Weather';

/**
 * When the pit wall has something worth saying.
 *
 * WHY THIS EXISTS AS ITS OWN OBJECT. The team channel was, measurably, silent:
 * `probe:hudtext` asserts that a twenty-minute race produces at least one
 * team-owned bulletin and it did not, because every existing `feed: 'team'` log
 * in the engine hangs off an event that a short race never reaches — a completed
 * pit stop, a refused pit entry, a component below its damage threshold. Two
 * agents confirmed the failure and traced it to `updatePitStops`; the trace was
 * right and the conclusion was too narrow. The channel is not broken. It has
 * nothing on it, because everything on it is an ACCIDENT REPORT, and a race in
 * which nothing goes wrong is a race in which the driver's own engineer never
 * speaks to them.
 *
 * That is also the fault behind the reported one:
 *
 *   "the conversation between the team and me should go two ways right not just
 *    one?"
 *
 * A channel that only carries accidents cannot go two ways, because nobody asks
 * a question about a broken floor. So this object watches the ordinary run of a
 * race — the gap to the car behind, the tyre, the forecast, the stewards, the
 * other side of the garage — and files a note whenever one of them changes by
 * enough to be worth a driver's attention.
 *
 * THE RULE EVERY TRIGGER BELOW IS BUILT ON: say the thing the driver does not
 * already know. Never restate a regulation they are obeying, never narrate the
 * dashboard, never describe what just happened to them — they were there. So
 * there is no trigger here for "you are under a VSC" or "your tyres are at 40%".
 * There is one for the RATE the car behind is closing at, which is three laps of
 * arithmetic done in a car doing 300km/h, and one for the lap the rain lands on,
 * which is on a screen the driver cannot see.
 *
 * Every threshold is a hysteresis or a cooldown, because the second-worst radio
 * in a racing game is a wall that says nothing and the worst is one that will
 * not shut up.
 *
 * Pure of the DOM and of the display. It emits `TeamNote`s; `teamLine` in the
 * HUD turns them into English. That boundary is the existing one and it is the
 * right one — the same event is said differently about your own car and about
 * your team-mate's, and only the display knows which car the player is in.
 */

/** What the engineer needs to know about the race this step. */
export interface EngineerContext {
  timeS: number;
  /** The player's car. */
  car: CarEntry;
  /** The other car in the same garage, or null in a one-car entry. */
  mate: CarEntry | null;
  /** The running order, for the cars either side. */
  standings: readonly CarEntry[];
  /** Laps left to run. */
  lapsRemaining: number;
  /** A representative lap, seconds — for turning distances into laps. */
  refLapS: number;
  /** Wetness now, 0..1. */
  wetness: number;
  /** Wetness expected at the end of the strategist's horizon. */
  projectedWetness: number;
  /** Seconds until the weather changes, or null when the radar is quiet. */
  weatherEtaS: number | null;
  /** Confidence in that, 0..1. */
  weatherConfidence: number;
  /** Fuel margin in laps: positive is spare, negative is short. */
  fuelMarginLaps: number;
  /** True while the session is green and the car is racing. */
  racing: boolean;
}

/**
 * How long the wall stays off the radio after speaking, seconds.
 *
 * Not one number, because the shapes are not equally welcome. A gap update is
 * conversation and can wait; a penalty is news and cannot.
 */
const COOLDOWN_S: Readonly<Record<string, number>> = {
  gap: 42,
  tyres: 70,
  weather: 90,
  position: 12,
  fuel: 75,
  cede: 999,
  penalty: 999,
  call: 0,
  reply: 0,
};

/** Nothing at all in the first few seconds of a race. Everyone is busy. */
const SETTLE_S = 25;

/**
 * The gap that counts as "being raced", seconds.
 *
 * Beyond this the two cars are not in the same event and a line about the gap is
 * the wall filling silence, which is the thing this whole pass is against.
 */
const RACING_GAP_S = 4.5;

/**
 * How fast a gap has to be moving before it is worth mentioning, s/lap.
 *
 * A tenth a lap is noise — tyre temperature, traffic, a scruffy exit. Two
 * tenths sustained is somebody actually coming.
 */
const CLOSING_RATE_S = 0.18;

export class RaceEngineer {
  /** Session time each kind of note was last filed. */
  private readonly lastSaid = new Map<string, number>();
  /** Interval to the car behind, sampled a lap ago, for the closing rate. */
  private lastInterval = { behind: 0, ahead: 0, atLap: -1 };
  /** Rate the gaps are moving at, s/lap, smoothed over the last two laps. */
  private rate = { behind: 0, ahead: 0 };
  /** Position at the end of the last completed lap, to notice it changing. */
  private lastPosition = 0;
  /** Penalties already announced, by their index in `car.penalties`. */
  private penaltiesSaid = 0;
  /** The car the driver was last told to hand a place back to. */
  private cedeSaid = -1;
  /** The `PitWall` call id already put on the radio. */
  private callSaid = 0;
  /** The lap the tyre warning last quoted, so it is not repeated on the same one. */
  private tyreLapSaid = -1;

  /** Clears everything. New session, or a car that has retired. */
  reset(): void {
    this.lastSaid.clear();
    this.lastInterval = { behind: 0, ahead: 0, atLap: -1 };
    this.rate = { behind: 0, ahead: 0 };
    this.lastPosition = 0;
    this.penaltiesSaid = 0;
    this.cedeSaid = -1;
    this.callSaid = 0;
    this.tyreLapSaid = -1;
  }

  /**
   * The notes worth filing this step, in the order they should be said.
   *
   * Returns an array rather than logging directly so the whole decision is
   * testable with no engine around it, and so the caller owns the log.
   *
   * Ordered by consequence, not by chronology: a penalty outranks a gap, because
   * if only one of them is going to be read before the driver arrives at the
   * next corner it had better be the one that changes the result.
   */
  update(ctx: EngineerContext): TeamNote[] {
    const { car, timeS } = ctx;
    if (car.retired || timeS < SETTLE_S) return [];

    const notes: TeamNote[] = [];
    // The two that are news, and are therefore exempt from the settle and from
    // everything below: they are said the moment they are true.
    this.collectPenalty(ctx, notes);
    this.collectCede(ctx, notes);

    if (!ctx.racing) {
      this.sampleGaps(ctx);
      return notes;
    }

    // The strategist's own call, question and all. Ordered next because it is
    // the only note in this file that the driver can ANSWER, and an offer the
    // player never sees is an offer that lapses.
    this.collectPosition(ctx, notes);
    this.collectTyres(ctx, notes);
    this.collectWeather(ctx, notes);
    this.collectFuel(ctx, notes);
    this.collectGap(ctx, notes);
    this.sampleGaps(ctx);
    return notes;
  }

  /**
   * The `PitWall`'s call, lifted onto the team feed.
   *
   * Separate from `update` because the wall is ticked by the engine on its own
   * schedule and this has to run after it, not alongside it. Returns a note the
   * first time it sees a given call id and nothing on every step after.
   */
  callNote(call: RadioCall | null): TeamNote | null {
    if (!call || call.id === this.callSaid) return null;
    this.callSaid = call.id;
    return {
      kind: 'call',
      message: call.message,
      reason: call.reason,
      compound: call.compound ?? '',
      question: call.question,
      callId: call.id,
      urgent: call.priority === 'urgent',
    };
  }

  /** What the wall says back once the driver has answered — or has not. */
  replyNote(outcome: RadioAnswer, compound: string): TeamNote {
    return { kind: 'reply', outcome, compound };
  }

  // -------------------------------------------------------------------------
  // The triggers
  // -------------------------------------------------------------------------

  private collectPenalty(ctx: EngineerContext, out: TeamNote[]): void {
    const held = ctx.car.penalties;
    while (this.penaltiesSaid < held.length) {
      const p = held[this.penaltiesSaid++];
      // A track-limits warning is not a penalty and the wall does not treat it
      // as one — race control has already told the driver, on its own feed, and
      // repeating it in the principal's voice is the duplication this whole
      // two-channel split exists to prevent.
      if (p.kind === 'track-limits-warning') continue;
      const drivethrough = p.kind === 'drive-through' || p.kind === 'stop-go-10s';
      out.push({
        kind: 'penalty',
        seconds: p.timeS,
        offence: p.reason,
        // The half the driver is asking for. A time penalty is served at the
        // next stop (Art. B1.9.5b); a drive-through has three laps to be taken
        // (Art. B1.9.4a) and is therefore an instruction, not information.
        whenServed: drivethrough ? 'now' : ctx.lapsRemaining > 2 ? 'at the stop' : 'at the flag',
      });
    }
  }

  private collectCede(ctx: EngineerContext, out: TeamNote[]): void {
    const to = ctx.car.cedePositionTo;
    if (to < 0) { this.cedeSaid = -1; return; }
    if (to === this.cedeSaid) return;
    this.cedeSaid = to;
    const who = ctx.standings.find((c) => c.index === to);
    out.push({
      kind: 'cede',
      who: who ? who.driver.lastName : 'the car behind',
      withinS: Math.max(0, Math.round(ctx.car.cedeDeadline - ctx.timeS)),
    });
  }

  private collectPosition(ctx: EngineerContext, out: TeamNote[]): void {
    const now = ctx.car.position;
    if (this.lastPosition === 0) { this.lastPosition = now; return; }
    if (now === this.lastPosition) return;
    const gained = now < this.lastPosition;
    const was = this.lastPosition;
    this.lastPosition = now;
    if (!this.due('position', ctx.timeS)) return;

    // WHO it was, which is the only part of this the driver might not have. The
    // car that took the place is the one now holding the position they lost —
    // or, having gained one, the car they just displaced.
    const other = ctx.standings.find((c) => c.position === (gained ? now + 1 : was));
    if (!other || other === ctx.car) return;
    // Losing a place to a stranger is racing. Losing it to the car the same
    // people built is politics, and the two cannot be said in the same words.
    const teammate = ctx.mate !== null && other.index === ctx.mate.index;
    // A place changing hands in the ordinary run of a lap is not worth a
    // transmission unless it was the other side of the garage or it was for
    // something — the podium, the points, the lead.
    if (!teammate && now > 10) return;
    out.push({
      kind: 'position', gained, position: now, who: other.driver.lastName, teammate,
    });
    this.said('position', ctx.timeS);
  }

  /**
   * The tyre, expressed as laps rather than as a percentage.
   *
   * The wear bar is already on the driver's screen and saying "your rears are at
   * thirty percent" is reading it back to them. What is not on their screen is
   * how many laps are left in it and what each of those laps is costing, both of
   * which are derived from a wear RATE the car does not display at all.
   */
  private collectTyres(ctx: EngineerContext, out: TeamNote[]): void {
    const { car } = ctx;
    if (car.inPitLane || car.pitRequested) return;
    if (!this.due('tyres', ctx.timeS)) return;
    if (car.lap === this.tyreLapSaid) return;

    const perLap = car.wearPerLapEstimate();
    if (perLap <= 0) return;
    const front = car.physics.frontTires.wear;
    const rear = car.physics.rearTires.wear;
    // `wear` is life REMAINING in this model: 1 is a new tyre.
    const worst = Math.min(front, rear);
    const axle: 'front' | 'rear' = front < rear ? 'front' : 'rear';
    const lapsLeft = Math.floor(worst / perLap);
    // Only once the number has become a decision. Twelve laps of tyre left with
    // twenty to run is a strategy call; twelve with eight to run is nothing.
    if (lapsLeft > 8 || lapsLeft >= ctx.lapsRemaining) return;
    // What the wear is costing, which is the fact that makes the laps mean
    // something. A tyre losing nothing has no story in it.
    const dropOffS = (1 - worst) * 2.4;
    if (dropOffS < 0.25) return;
    this.tyreLapSaid = car.lap;
    this.said('tyres', ctx.timeS);
    out.push({ kind: 'tyres', lapsLeft: Math.max(0, lapsLeft), dropOffS, axle });
  }

  private collectWeather(ctx: EngineerContext, out: TeamNote[]): void {
    const eta = ctx.weatherEtaS;
    if (eta === null || eta < 20 || eta > 900) return;
    if (ctx.weatherConfidence < 0.5) return;
    // Only a CHANGE. A forecast that says the dry track will still be dry is a
    // forecast with nothing in it.
    const wet = ctx.projectedWetness > ctx.wetness + 0.2;
    const drying = ctx.projectedWetness < ctx.wetness - 0.2;
    if (!wet && !drying) return;
    if (!this.due('weather', ctx.timeS)) return;
    this.said('weather', ctx.timeS);

    // THE LAPS IT LANDS ON, which is the whole value of the note. The driver can
    // see the sky; they cannot see the radar mapped onto their own lap counter.
    const lapsAway = Math.max(1, Math.round(eta / Math.max(ctx.refLapS, 1)));
    const from = ctx.car.lap + lapsAway;
    out.push({
      kind: 'weather',
      wet,
      minutes: Math.max(1, Math.round(eta / 60)),
      fromLap: from,
      toLap: from + Math.max(2, Math.round(lapsAway * 0.8)),
      confidence: ctx.weatherConfidence,
      // What the team is going to DO about it, which is the difference between
      // a weather report and a radio call.
      plan: wet ? 'inters' : 'slicks',
    });
  }

  private collectFuel(ctx: EngineerContext, out: TeamNote[]): void {
    // Only when it is a problem. A car with fuel in hand does not need telling.
    if (ctx.fuelMarginLaps > -0.15) return;
    if (!this.due('fuel', ctx.timeS)) return;
    this.said('fuel', ctx.timeS);
    out.push({ kind: 'fuel', marginLaps: ctx.fuelMarginLaps });
  }

  /**
   * The car being raced, and the rate it is moving at.
   *
   * The rate is the point. A gap is visible in a mirror; a gap CHANGING at two
   * tenths a lap is three laps of arithmetic, and it is the number that decides
   * whether the driver has to do anything about it.
   */
  private collectGap(ctx: EngineerContext, out: TeamNote[]): void {
    if (!this.due('gap', ctx.timeS)) return;
    const { car } = ctx;
    const order = ctx.standings;
    const at = order.indexOf(car);
    if (at < 0) return;

    const behind = order[at + 1];
    const ahead = order[at - 1];
    // Whichever of the two is the live story: somebody closing on you outranks
    // somebody you are closing on, because it is the one you can lose from.
    if (behind && !behind.retired && behind.interval > 0 && behind.interval < RACING_GAP_S
      && this.rate.behind < -CLOSING_RATE_S) {
      out.push({
        kind: 'gap', who: behind.driver.lastName, gapS: behind.interval,
        perLapS: this.rate.behind, behind: true,
      });
      this.said('gap', ctx.timeS);
      return;
    }
    if (ahead && !ahead.retired && car.interval > 0 && car.interval < RACING_GAP_S
      && this.rate.ahead < -CLOSING_RATE_S) {
      out.push({
        kind: 'gap', who: ahead.driver.lastName, gapS: car.interval,
        perLapS: this.rate.ahead, behind: false,
      });
      this.said('gap', ctx.timeS);
    }
  }

  /**
   * Samples the two intervals once a lap and turns the difference into a rate.
   *
   * Once a LAP rather than once a step, because that is the unit the answer is
   * quoted in and because sampling a gap continuously measures traffic and
   * corner exits rather than pace. Smoothed across two samples so one scruffy
   * lap does not produce a transmission.
   */
  private sampleGaps(ctx: EngineerContext): void {
    const { car } = ctx;
    if (car.lap === this.lastInterval.atLap) return;
    const order = ctx.standings;
    const at = order.indexOf(car);
    const behind = at >= 0 ? order[at + 1] : undefined;
    const bNow = behind && !behind.retired ? behind.interval : 0;
    const aNow = car.interval > 0 ? car.interval : 0;

    if (this.lastInterval.atLap >= 0) {
      const laps = Math.max(1, car.lap - this.lastInterval.atLap);
      // Negative means the gap is shrinking, which is the direction that
      // matters — for the car behind and for the car ahead alike.
      const bRate = bNow > 0 && this.lastInterval.behind > 0
        ? (bNow - this.lastInterval.behind) / laps : 0;
      const aRate = aNow > 0 && this.lastInterval.ahead > 0
        ? (aNow - this.lastInterval.ahead) / laps : 0;
      this.rate.behind = this.rate.behind * 0.5 + bRate * 0.5;
      this.rate.ahead = this.rate.ahead * 0.5 + aRate * 0.5;
    }
    this.lastInterval = { behind: bNow, ahead: aNow, atLap: car.lap };
  }

  // -------------------------------------------------------------------------

  private due(kind: string, timeS: number): boolean {
    const last = this.lastSaid.get(kind);
    return last === undefined || timeS - last >= (COOLDOWN_S[kind] ?? 60);
  }

  private said(kind: string, timeS: number): void {
    this.lastSaid.set(kind, timeS);
  }
}
