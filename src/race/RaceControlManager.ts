import { clamp01, loopDelta } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { CarEntry } from './CarEntry';
import { RECOVERY_FAST_SECTION_MS, RECOVERY_TRACKSIDE_M } from './Recovery';
import type { DebrisField } from './DebrisField';

/**
 * Race Control: flags, track limits, and penalties.
 *
 * Modelled as a per-segment flag state rather than a single global flag, because
 * that is how it actually works — a yellow at turn 4 does not stop the cars in
 * sector 3. The track is divided into marshalling sectors and each carries its
 * own flag state, which is what lets a local yellow slow only the cars that are
 * approaching the incident.
 *
 * Penalties are appended to a car's race time rather than served immediately, in
 * line with how time penalties are applied at the end of a race, with
 * drive-throughs handled as an in-race obligation.
 */

export type FlagState = 'green' | 'yellow' | 'double-yellow' | 'red' | 'chequered';
export type NeutralisationState = 'none' | 'vsc' | 'safety-car' | 'sc-ending';

/**
 * Half the car's OVERALL width, over the tyres, in metres.
 *
 * This is the only width track limits may be judged on, and it is not the same
 * quantity as `VehicleSpec.trackWidthM`. "Track width" in its automotive sense
 * is the distance between the wheel CENTRES — `EffectsDirector` uses the spec
 * field that way, to place the contact patches — and the part of the car that
 * decides whether it is still on the circuit is the outboard face of the tyre,
 * half a tyre width further out again on each side.
 *
 * Taking the axle track for the overall width makes the car narrower than it is
 * drawn, and a threshold set on a car narrower than the real one fires while the
 * real one is still overlapping the paint. That is the reported defect: laps
 * deleted from a car the player can see is still touching the white line.
 *
 * The number is the car in `CarMesh`, measured rather than assumed: the hubs sit
 * at ±(1.0 - tyreWidth/2 - 0.005) and the tyres are 0.325m front and 0.425m
 * rear, so the outboard face of every tyre lands at ±0.995. The regulations cap
 * overall width at 2000mm (2026 Technical Regulations Art. 3.2.2) and this car
 * is built to it, so 0.995 is both what is drawn and what is legal.
 *
 * Kept here rather than in `VehicleSpec` deliberately. Adding a second width to
 * the spec invites the two to be confused again at the next call site; naming
 * this one for what race control needs, next to the only rule that needs it,
 * does not.
 */
export const CAR_HALF_WIDTH_M = 0.995;

/**
 * What a marshal post is actually displaying at a point on the circuit.
 *
 * A superset of `FlagState`, because a neutralisation is signalled by boards and
 * light panels rather than by a flag — "all FIA light panels will display 'VSC'"
 * (Art. 56.2 / B5.12.1), and the safety car is signalled by "SC" boards and
 * waved yellows at every post (Art. 55.5 / B5.13.2a). Modelling them as one
 * enumeration is what lets one lookup drive the map, the trackside panels and
 * the HUD banner, so the three can never disagree with each other.
 */
export type FlagSignal = FlagState | 'vsc' | 'safety-car';

/**
 * Display ordering, worst last.
 *
 * Used to fold twenty marshalling sectors into three timing sectors for the
 * circuit map, and to decide which of two overlapping signals a post shows. It
 * is a presentation ranking, not a regulatory one: a local double yellow ranks
 * above the safety car boards because it is the more urgent instruction to the
 * driver arriving at that specific corner, which is exactly why the yellows keep
 * being waved at the incident while the rest of the lap shows SC.
 */
const SIGNAL_RANK: Record<FlagSignal, number> = {
  green: 0,
  chequered: 1,
  vsc: 2,
  'safety-car': 3,
  yellow: 4,
  'double-yellow': 5,
  red: 6,
};

/** The more severe of two signals, for folding sectors together. */
export function worseSignal(a: FlagSignal, b: FlagSignal): FlagSignal {
  return SIGNAL_RANK[b] > SIGNAL_RANK[a] ? b : a;
}

/**
 * Where a safety car period has got to.
 *
 * The regulations do not describe a safety car as a single state; they describe
 * a sequence with a different obligation on the drivers at each step. Modelling
 * it as one boolean is what makes a simulated safety car feel like a speed limit
 * rather than like a safety car.
 *
 *   BUNCHING      Field forming up behind the car, ten car lengths apart.
 *                 2025 Sporting Regs Art. 55.7 / 2026 Section B Art. B5.13.2b.
 *   WAVING_LAPPED "LAPPED CARS MAY NOW OVERTAKE": every car lapped by the
 *                 leader is REQUIRED to pass the cars on the lead lap and the
 *                 safety car itself. Art. 55.14 / B5.13.4c.
 *   IN_THIS_LAP   "SAFETY CAR IN THIS LAP", orange lights extinguished. The
 *                 leader now dictates the pace and may fall back beyond the
 *                 maximum gap. Art. 55.15 / B5.13.6.
 *   RESTART       Green at the Line. Overtaking is still forbidden until each
 *                 car has itself passed the Line. Art. 55.8 / B5.13.2c.
 */
export type SafetyCarPhase =
  | 'none'
  | 'bunching'
  | 'waving-lapped'
  | 'in-this-lap'
  | 'restart';

export type PenaltyKind =
  | 'track-limits-warning'
  | 'time-5s'
  | 'time-10s'
  | 'drive-through'
  | 'stop-go-10s'
  | 'disqualified';

export interface Penalty {
  kind: PenaltyKind;
  reason: string;
  /** Lap on which it was issued. */
  lap: number;
  /** Seconds added to race time, if a time penalty. */
  timeS: number;
  /** True once a drive-through or stop-go has been served. */
  served: boolean;
}

/**
 * Which feed a bulletin belongs on.
 *
 * THE SPORT HAS TWO VOICES AND THIS GAME WAS USING ONE. Every message in this
 * log was being read out by the player's own team principal, so a driver on
 * another team going off at sector 2 arrived as `MARCO VIDAL · TEAM PRINCIPAL
 * — "Yellow flag — HAL off at sector 2"`, and so did a stranger's track-limits
 * warning. Neither is a team matter and neither driver is on the player's team.
 *
 *   "the FIA will say stuff like racing incident noted, and then if someone got
 *    a penalty ... nobody will ever say this person's suspension broke or this
 *    broke, that is a team only conversation so if they are not part of the
 *    users team then they shouldn't be getting those notifs."
 *
 * So a message declares who owns it:
 *
 *   `race-control`  Official and impersonal. Sessions, flags, the safety car,
 *                   incidents noted and investigated, penalties, track limits,
 *                   the chequered flag. Everyone sees it, about anyone.
 *   `team`          The player's own car and their own team-mate. Damage,
 *                   tyres, fuel, pit calls, the gap to the car being raced.
 *                   Shown only when the car it names is on the player's team,
 *                   and DROPPED otherwise. A third party's suspension failure
 *                   never reaches this feed.
 *   `either`        An event both would remark on, from opposite sides: an
 *                   accident, a retirement, a car stranded. Race control notes
 *                   it when it is somebody else's car; the pit wall reacts to
 *                   it when it is one of yours. One event, one card, the right
 *                   voice — never both at once, because the rail is 60 pixels
 *                   tall on a landscape phone and the second card evicts the
 *                   first.
 *
 * The filter is OWNERSHIP, and it is applied by the HUD, which is the only
 * layer that knows which car the player is in.
 */
export type MessageFeed = 'race-control' | 'team' | 'either';

/**
 * An incident as race control words it.
 *
 * Four fields because that is what an official bulletin is: who, where, what,
 * and what is being done about it. A broadcast draws them as a banner reading
 * `RACE CONTROL: <DRIVER>, <DRIVER> INCIDENT` over `TURN 1 · IMPEDING · NOTED`,
 * and keeping them apart rather than pre-baking a sentence is what lets the HUD
 * draw that shape instead of a paragraph.
 */
export interface RaceNotice {
  /** Driver codes named, in the order race control names them. */
  parties: string[];
  /** `TURN 4`, `SECTOR 2`, `PIT LANE`, or '' for a session-wide notice. */
  where: string;
  /** `CONTACT`, `TRACK LIMITS`, `CAR STOPPED`, `PIT LANE SPEEDING`. */
  offence: string;
  /** `NOTED`, `UNDER INVESTIGATION`, `5 SECOND TIME PENALTY`, `LAP DELETED`. */
  status: string;
}

/**
 * A team event, as facts rather than as a sentence.
 *
 * The principal's line is written at the display, from these, because a line
 * written here would be a string in the physics — and because the same event
 * is said differently about your own car and about your team-mate's.
 */
export type TeamNote =
  | { kind: 'off'; corner: string; hit: string; heavy: boolean }
  | { kind: 'damage'; part: string; health: number }
  | { kind: 'retired'; reason: string }
  | { kind: 'failure'; cause: string }
  | { kind: 'stranded' }
  | { kind: 'recovered' }
  | { kind: 'stop'; compound: string }
  | { kind: 'pit-closed' }
  | { kind: 'pit-missed' }
  | { kind: 'pit-fast' }
  | { kind: 'penalty-served' };

export interface RaceControlMessage {
  /** Session time the message was issued. */
  time: number;
  text: string;
  severity: 'info' | 'warning' | 'critical';
  /** Car this concerns, or -1 for a session-wide message. */
  carIndex: number;
  /** Which voice owns it. */
  feed: MessageFeed;
  /** Structured incident detail, when race control has any. */
  notice?: RaceNotice;
  /** Structured team detail, when the pit wall has any. */
  team?: TeamNote;
}

/** The optional half of `log`, so thirty existing call sites stay as they are. */
export interface MessageDetail {
  feed?: MessageFeed;
  notice?: RaceNotice;
  team?: TeamNote;
}

/** Number of marshalling sectors the track is divided into. */
const MARSHAL_SECTORS = 20;

/** Track-limit infractions before a black-and-white warning flag. */
const TRACK_LIMIT_WARNING_AT = 3;
/** Infractions after which each further one adds a time penalty. */
const TRACK_LIMIT_PENALTY_AT = 4;

/** A car below this speed off-track is treated as a stopped car. */
const STOPPED_SPEED_MS = 8;

/** Regulation pit lane limit tolerance, km/h. */
const PIT_SPEED_TOLERANCE_KPH = 0.5;

/**
 * Length of a Formula 1 car, metres.
 *
 * The regulations express the safety car queue in CAR LENGTHS, not metres, so
 * the conversion has to exist somewhere. A current car is a little over five
 * metres between the axles and about 5.6 overall.
 */
const CAR_LENGTH_M = 5.6;

/**
 * Maximum gap to the car ahead under the safety car, in car lengths.
 *
 * "All F1 Cars must reduce speed and form up behind the Safety Car no more than
 * ten (10) car lengths apart." — 2025 Sporting Regs Art. 55.7 / 2026 Section B
 * Art. B5.13.2b.
 */
const SC_MAX_GAP_CAR_LENGTHS = 10;
/**
 * The low-visibility variant, new for 2026.
 *
 * At the Race Director's sole discretion the maximum allowable gap may be
 * increased to twenty car lengths, announced as "LOW VISIBILITY - MAXIMUM GAP
 * TWENTY CAR LENGTHS". 2026 Section B Art. B5.13.2b; no 2025 equivalent.
 */
const SC_MAX_GAP_CAR_LENGTHS_LOW_VIS = 20;

/**
 * The pace the field runs at under a neutralisation, m/s.
 *
 * IMPORTANT: this is a tuning constant, not a regulation. The regulations only
 * ever say drivers must "stay above the minimum time set by the FIA ECU"
 * (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b). The FIA publishes neither a
 * percentage nor a formula, and the secondary sources that quote one disagree
 * with each other, so there is no number here that could be cited. These are
 * chosen against the one thing that IS observable: how long a neutralised lap
 * takes relative to a racing one. A real safety car lap is roughly 1.6 to 2
 * times the racing lap, and a VSC lap roughly 1.4 times.
 *
 * These are speed CAPS, not average speeds — a car still slows for the corners
 * underneath them — so the resulting lap is slower than the number suggests.
 * They were originally 22 and 32 m/s, which capped a safety car lap of Monza at
 * over four minutes; a single deployment then consumed a fifth of the race and
 * the field spent more than half of every race neutralised.
 *
 * They are only half the pace model. A cap alone cannot hold a lap-time ratio
 * across circuits — see `SC_PACE_SCALE` below, and the measurement that showed
 * it.
 */
const SC_PACE_MS = 40;
const VSC_PACE_MS = 50;

/**
 * The other half of the neutralised pace: a fraction of the racing-line speed.
 *
 * A speed CAP alone cannot produce a neutralised lap of the right length, and
 * measuring it is what shows this. A cap only binds where the car would have
 * been faster than it — which is the straights — so at Monza, where most of the
 * lap is straight, a 44 m/s cap produced a safety car lap of x1.30 a green one,
 * and at Monaco, where almost nothing on the lap is quicker than 44 m/s anyway,
 * it produced a safety car lap barely slower than a racing one. Neither is a
 * safety car. A real one runs at x1.6 to x2 EVERYWHERE, because the safety car
 * itself is slow through the corners too and the field is queued behind it.
 *
 * So the neutralised target is `min(racingLineSpeed * scale, cap)`. The scale
 * sets the lap-time ratio and holds it across circuits; the cap stops a queue
 * from doing 200 km/h down a long straight, which no safety car does.
 *
 * These two numbers are a MODELLING CHOICE, like the caps they replace: the
 * regulations fix no percentage and the FIA publishes no formula, only the
 * requirement to stay above the ECU minimum time (Art. 55.7 and 56.5 /
 * B5.13.2b and B5.12.2b). They are calibrated against the one thing that is
 * observable — how long a neutralised lap takes relative to a racing one, about
 * x1.6-2 under the safety car and about x1.4 under the VSC — and
 * `scripts/probeFlags.ts` measures exactly that and fails if it drifts.
 */
const SC_PACE_SCALE = 0.42;
const VSC_PACE_SCALE = 0.5;

/**
 * How much of its pace the safety car keeps while it is still picking the
 * leader up.
 *
 * Art. 55.10 / B5.13.5a asks for the leader to end up behind the safety car,
 * and the leader is held to the same speed the safety car is — so unless the
 * safety car gives some of that back the two never meet. Just over a third is
 * what a real safety car does on the lap it is deployed: it is barely moving
 * until the leader arrives, and everyone watching says so.
 */
const SC_BUNCHING_PACE_SHARE = 0.38;

/**
 * How far ahead of the leader the safety car joins the circuit, metres.
 *
 * Enough road that a leader arriving at racing speed cannot get past it while
 * it slows down. A car doing 85 m/s braking to a 35 m/s safety car pace covers
 * about 130m more than the safety car does over the same period; 250 gives that
 * a wide margin at every circuit and is still close enough that the pick-up
 * happens within a few seconds rather than over a lap.
 */
const SC_PICKUP_LEAD_M = 250;

/**
 * How much quicker than the neutralised pace a car catching the queue may run.
 *
 * Deliberately just under `DELTA_REFERENCE_MARGIN`: a car closing a gap must be
 * able to close it without earning a penalty for doing so, and the regulation
 * requires it to close (ten car lengths, Art. 55.7 / B5.13.2b) while also
 * requiring it to stay above the minimum time. The only value that satisfies
 * both is one just inside the threshold.
 */
const SC_CATCHUP_MULT = 1.4;

/**
 * How long the safety car may keep bunching before it gives up and comes in.
 *
 * Art. 55.10 / B5.13.5a says the car "shall be used at least until the leader is
 * behind it and all remaining cars are lined up behind them" — a condition, not
 * a timer. But a condition with no escape is a race that never restarts: a field
 * containing a car with a broken engine may simply never line up. Two safety car
 * laps is the longest a real deployment spends bunching.
 */
const SC_MAX_BUNCH_EXTRA_S = 120;

/**
 * Seconds between "VSC ENDING" and the panels going green.
 *
 * "the message 'VSC ENDING' will be sent to all Competitors and, at any time
 * between 10 and 15 seconds later, 'VSC' on the FIA light panels will change to
 * green" — Art. 56.7 / B5.12.4. The window is deliberately variable so that
 * drivers cannot time the restart, so this is drawn at random within it rather
 * than fixed.
 */
const VSC_ENDING_MIN_S = 10;
const VSC_ENDING_MAX_S = 15;

/** Minimum time a safety car spends bunching the field before it can come in. */
const SC_MIN_BUNCH_S = 25;
/**
 * Laps between "LAPPED CARS MAY NOW OVERTAKE" and the safety car coming in.
 *
 * "once the message 'LAPPED CARS MAY NOW OVERTAKE' has been sent ... the Safety
 * Car will return to the pits at the end of the following lap."
 * Art. 55.14 (final paragraph) / B5.13.5b. One full lap.
 */
const SC_LAPS_AFTER_WAVE = 1;

/**
 * How far ahead of, and behind, the safety car the queue is considered to
 * reach, metres.
 *
 * Twenty cars ten car lengths apart is a train a little over a kilometre long,
 * and it is the train, not the safety car alone, that a car released from the
 * pit lane would be released into.
 */
const SC_QUEUE_LEAD_M = 120;
const SC_QUEUE_TAIL_M = 1200;

/**
 * How much quicker than the neutralised pace a car may run before the minimum
 * time is breached.
 *
 * The minimum time is a THRESHOLD, not the pace itself. That distinction is the
 * whole of this constant: a driver who is closing a gap to the queue, or
 * getting a lap time back after being caught out at a bad moment, runs quicker
 * than the cruising pace and is not penalised for it — the regulation's own
 * wording asks only that they be above the minimum time "at least once in each
 * marshalling sector" (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b), which
 * explicitly tolerates being quick for part of it.
 *
 * Setting the threshold at the cruising pace instead made the safety car's own
 * ten-car-length rule illegal to obey: a car told to close up to the queue was
 * penalised five seconds for doing so, repeatedly, every lap.
 */
const DELTA_REFERENCE_MARGIN = 1.45;

export class RaceControlManager {
  private readonly track: TrackSpline;

  /** Flag state per marshalling sector. */
  readonly sectorFlags: FlagState[] = [];
  /** Global session flag — red and chequered override everything. */
  sessionFlag: FlagState = 'green';
  neutralisation: NeutralisationState = 'none';

  /** Speed cap all cars must respect under a neutralisation, m/s. */
  vscTargetMs = 0;
  /**
   * Fraction of the racing-line speed the field runs at under a neutralisation.
   *
   * Zero when the race is green. See `SC_PACE_SCALE` for why a cap on its own is
   * not enough to make a neutralised lap the right length.
   */
  neutralisedScale = 0;
  /** Multiplier a car over the queue gap limit may use to close it. */
  readonly catchUpMult = SC_CATCHUP_MULT;
  /** Lap on which the current neutralisation began. */
  neutralisedSinceLap = 0;
  private neutralisationTimer = 0;

  // --- Safety car ----------------------------------------------------------
  /** Which step of the safety car procedure is in force. */
  scPhase: SafetyCarPhase = 'none';
  /**
   * The safety car itself, as a position on the lap.
   *
   * A safety car period is a car on the circuit that the field queues behind,
   * not a global speed limit, and the difference shows: the leader has to catch
   * it, everyone else has to catch the leader, and the concertina that produces
   * is most of what a safety car does to a race.
   */
  scS = 0;
  scLap = 0;
  /** How fast it is going, m/s. See `safetyCarPaceMs`. */
  scSpeedMs = 0;
  /** True while the safety car is physically on the circuit. */
  scOnTrack = false;
  /**
   * Maximum gap to the car ahead, metres. Ten car lengths, or twenty when the
   * Race Director has declared low visibility.
   */
  maxQueueGapM = SC_MAX_GAP_CAR_LENGTHS * CAR_LENGTH_M;
  lowVisibility = false;
  /**
   * True once lapped cars have been told to unlap themselves and before the
   * safety car comes in. Art. 55.14 / B5.13.4c.
   */
  lappedCarsWaved = false;
  /**
   * Pit EXIT closed while unlapped cars rejoin the back of the queue.
   *
   * "the pit lane exit may be closed at the race director's sole discretion
   * while these cars rejoin" — Art. 55.14 / B5.13.4c.
   */
  pitExitClosed = false;
  /**
   * Pit ENTRY closed.
   *
   * "In exceptional circumstances the Race Director may ask for the pit entry
   * to be closed for safety reasons. At such times drivers may only enter the
   * Pit Lane in order for essential and entirely evident repairs to be carried
   * out." — 2025 Art. 34.15 / 2026 Art. B1.6.4.
   */
  pitEntryClosed = false;
  /** Leader's lap when lapped cars were waved past. */
  private scWaveLap = -1;
  private scTimer = 0;
  /** Road left before the safety car reaches the pit entry, metres. */
  private scToEntryM = 0;
  /** Seconds until the VSC panels go green. Negative when not ending. */
  private vscGreenIn = -1;
  /** Track wetness, supplied by the engine. Drives the low-visibility call. */
  private wetness = 0;
  private readonly rng: () => number;

  /** Rolling log for the radio/UI. Bounded so it cannot grow without limit. */
  readonly messages: RaceControlMessage[] = [];
  private static readonly MAX_MESSAGES = 60;

  /** True once the leader has taken the chequered flag. */
  raceFinished = false;

  constructor(track: TrackSpline, rng?: () => number) {
    this.track = track;
    // Deterministic by default: a replayed race must neutralise identically.
    this.rng = rng ?? (() => 0.5);
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags.push('green');
  }

  reset(): void {
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags[i] = 'green';
    this.sessionFlag = 'green';
    this.neutralisation = 'none';
    this.vscTargetMs = 0;
    this.neutralisedScale = 0;
    this.neutralisationTimer = 0;
    this.raceFinished = false;
    this.messages.length = 0;
    this.scPhase = 'none';
    this.scOnTrack = false;
    this.scSpeedMs = 0;
    this.lappedCarsWaved = false;
    this.pitExitClosed = false;
    this.pitEntryClosed = false;
    this.lowVisibility = false;
    this.scWaveLap = -1;
    this.vscGreenIn = -1;
  }

  /** How many marshalling sectors the lap is divided into. */
  get marshalSectorCount(): number {
    return MARSHAL_SECTORS;
  }

  /** Distance along the lap at which marshalling sector `i` begins, metres. */
  marshalSectorStartS(i: number): number {
    return (i / MARSHAL_SECTORS) * this.track.length;
  }

  /**
   * What the marshal post covering this sector is displaying.
   *
   * The local flag wins over the neutralisation boards, because that is what the
   * posts actually do: the incident keeps its waved yellows while the rest of the
   * circuit shows SC or VSC. Everything the player sees — the coloured circuit
   * map, the trackside panels and the HUD banner — reads from this one function,
   * so they cannot drift apart.
   */
  signalForSector(i: number): FlagSignal {
    if (this.sessionFlag === 'red') return 'red';
    const local = this.sectorFlags[((i % MARSHAL_SECTORS) + MARSHAL_SECTORS) % MARSHAL_SECTORS];
    if (local === 'yellow' || local === 'double-yellow' || local === 'red') return local;
    if (this.neutralisation === 'safety-car') return 'safety-car';
    if (this.neutralisation === 'vsc') return 'vsc';
    if (this.sessionFlag === 'chequered') return 'chequered';
    return 'green';
  }

  /** What the posts are displaying at a distance along the lap. */
  signalAt(s: number): FlagSignal {
    return this.signalForSector(this.sectorIndexAt(s));
  }

  /**
   * The worst signal anywhere between two distances along the lap.
   *
   * This is how a timing sector gets a colour: a timing sector spans several
   * marshalling sectors, and the one that matters is the worst of them. Handles
   * a range that wraps the start/finish line, which sector 3 always does not but
   * a caller might.
   */
  signalBetween(fromS: number, toS: number): FlagSignal {
    const len = this.track.length;
    const first = this.sectorIndexAt(fromS);
    const last = this.sectorIndexAt((toS - 1e-3 + len) % len);
    let worst: FlagSignal = this.signalForSector(first);
    for (let i = first; i !== last; ) {
      i = (i + 1) % MARSHAL_SECTORS;
      worst = worseSignal(worst, this.signalForSector(i));
    }
    return worst;
  }

  /** Marshalling sector index for a distance along the lap. */
  sectorIndexAt(s: number): number {
    const f = (s / this.track.length) * MARSHAL_SECTORS;
    const i = Math.floor(f) % MARSHAL_SECTORS;
    return i < 0 ? i + MARSHAL_SECTORS : i;
  }

  /** Flag a car approaching `s` must obey. */
  flagAt(s: number): FlagState {
    if (this.sessionFlag === 'red' || this.sessionFlag === 'chequered') return this.sessionFlag;
    return this.sectorFlags[this.sectorIndexAt(s)];
  }

  /** True when overtaking is forbidden at this point on the track. */
  overtakingBannedAt(s: number): boolean {
    if (this.neutralisation !== 'none') return true;
    const f = this.flagAt(s);
    return f === 'yellow' || f === 'double-yellow' || f === 'red';
  }

  /**
   * How hard a driver at `s` must lift, 0 = green, 1 = single yellow,
   * 2 = double yellow.
   *
   * The two are genuinely different instructions and the regulations spell out
   * the difference. Single waved yellow: "reduce their speed and be prepared to
   * change direction ... expected to have braked earlier and/or discernibly
   * reduced speed in the relevant marshalling sector" (2025 Art. 26.1a / 2026
   * Art. B1.8.4a; ISC Appendix H Art. 2.5.5b — the hazard is BESIDE or partly
   * on the track). Double waved yellow: "reduce your speed significantly ...
   * and be prepared to change direction or stop" (Art. 26.1b / B1.8.4b;
   * Appendix H 2.5.5b — the hazard is wholly or partly BLOCKING the track, or
   * there are marshals on it).
   *
   * Note that neither carries a published numeric lift. The standard is
   * qualitative and judged by the stewards; the only quantitative obligation in
   * the whole yellow-flag regime is the FIA ECU minimum time, and that applies
   * only to a double yellow inside a safety car or VSC period (Art. 26.1c /
   * B1.8.4c). The lift factors used by the AI are therefore a modelling choice,
   * not a regulation, and are documented as such where they are applied.
   */
  yellowLevelAt(s: number): 0 | 1 | 2 {
    const f = this.flagAt(s);
    if (f === 'double-yellow' || f === 'red') return 2;
    if (f === 'yellow') return 1;
    return 0;
  }

  /**
   * May this car enter the pit lane right now?
   *
   * Two separate rules, commonly conflated and commonly got wrong:
   *
   * 1. The pit lane is NOT closed by a neutralisation. There is no article in
   *    the 2024, 2025 or 2026 regulations that closes it as a consequence of a
   *    safety car — the closed-pits-under-safety-car regime is historic (2007-08)
   *    and has no current basis. What the regulations actually say is a
   *    restriction on the PURPOSE: "no F1 Car may enter the pits whilst the
   *    Safety Car is deployed unless it is for the purpose of changing tyres"
   *    (Art. 55.12 / B5.13.3), and identically for the VSC (Art. 56.4 /
   *    B5.12.3). So a free stop is legal and a drive-through-for-the-sake-of-it
   *    is not.
   *
   * 2. The Race Director MAY close the pit entry in exceptional circumstances,
   *    and then only essential and entirely evident repairs may be carried out
   *    (Art. 34.15 / B1.6.4). That is a real closure, and breaching it is a
   *    Stop-and-Go.
   */
  mayEnterPitLane(forTyres: boolean, forRepairs: boolean): boolean {
    if (this.pitEntryClosed) return forRepairs;
    if (this.neutralisation !== 'none') return forTyres || forRepairs;
    return true;
  }

  /**
   * Files a bulletin.
   *
   * `detail` is optional and defaults to the official feed, which is what every
   * session-wide flag and neutralisation message is. Anything the pit wall owns
   * has to say so, and anything race control would word as an incident carries
   * the four fields it words it with.
   */
  log(
    text: string, severity: RaceControlMessage['severity'], time: number, carIndex = -1,
    detail: MessageDetail = {},
  ): void {
    this.messages.push({
      time, text, severity, carIndex,
      feed: detail.feed ?? 'race-control',
      notice: detail.notice,
      team: detail.team,
    });
    if (this.messages.length > RaceControlManager.MAX_MESSAGES) this.messages.shift();
  }

  // =========================================================================
  // Per-step evaluation
  // =========================================================================

  /**
   * Updates flags from the current state of the field, then evaluates each car
   * for infractions.
   *
   * Called once per physics step by the race engine. Everything here is O(cars)
   * with no allocation.
   */
  update(
    dt: number,
    cars: CarEntry[],
    standings: readonly CarEntry[],
    sessionTime: number,
    isRace: boolean,
    wetness = 0,
    debris?: DebrisField,
  ): void {
    this.wetness = wetness;
    this.updateIncidentFlags(cars, sessionTime, debris);
    this.updateNeutralisation(dt, cars, standings, sessionTime, isRace);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.retired) continue;
      this.checkTrackLimits(car, i, sessionTime, isRace);
      this.checkPitLaneSpeed(car, i, sessionTime);
      this.checkNeutralisationDelta(car, i, dt, sessionTime);
    }
  }

  /**
   * Raises and clears yellows based on where stopped or off-track cars are.
   *
   * A yellow is triggered by a car that is off the racing surface and slow, or
   * stationary on it — which is exactly the condition marshals react to, and it
   * means yellows appear as a consequence of incidents rather than being
   * scripted.
   */
  private updateIncidentFlags(
    cars: CarEntry[], sessionTime: number, debris?: DebrisField,
  ): void {
    // Clear to green, then re-raise. Cheap at 20 sectors and avoids stale flags.
    for (let i = 0; i < MARSHAL_SECTORS; i++) {
      if (this.sectorFlags[i] !== 'red') this.sectorFlags[i] = 'green';
    }

    let incidents = 0;
    for (const car of cars) {
      if (car.inPitLane) continue;

      // What, if anything, is this car giving the marshals to signal?
      //
      // A RETIREMENT signals whatever its RECOVERY needs, for exactly as long
      // as the recovery takes, and the recovery is a real operation rather than
      // a stopwatch — see `Recovery.ts`. Two consequences, and they are the two
      // halves of the reported defect:
      //
      //   The flag comes down when the CAR GOES, not on a timer that runs
      //   independently of it. Twenty-two seconds after a car stopped on the
      //   racing line the sector used to go green with the car still on the
      //   racing line, because the flag was reading a clock that had nothing to
      //   do with whether a crane had been anywhere near it.
      //
      //   A double yellow means people are on or beside the road. That is the
      //   Appendix H distinction (Art. 2.5.5b) and it is now the literal
      //   condition: a recovery inside the working clearance shows double
      //   yellows for its duration, one behind the barriers shows a single. A
      //   car that speared deep into a gravel trap does not put a third of the
      //   lap under double yellows for two minutes, and it does not go green
      //   while a tractor is still hooking it up either.
      //
      // A car that is merely OFF and slow gets a single yellow while it is
      // there and nothing once it has rejoined. It never counts toward a safety
      // car: treating every excursion as safety-car-worthy left the race
      // permanently neutralised, and with twenty cars there is almost always
      // somebody off.
      const halfWidth = this.track.halfWidthAt(car.s);
      let severity: FlagState | null = null;
      if (car.retired) {
        severity = car.recovery.signal;
        if (car.recovery.warrantsNeutralisation) incidents++;
      } else {
        const offTrack = Math.abs(car.lateral) > halfWidth + 1.0;
        const slow = car.physics.speedMs < STOPPED_SPEED_MS;
        if (offTrack && slow) severity = 'yellow';
      }

      if (severity !== null) {
        const sec = this.sectorIndexAt(car.s);
        // The incident sector and the one before it — drivers need warning
        // before they arrive, which is the whole point of a yellow.
        const prev = (sec + MARSHAL_SECTORS - 1) % MARSHAL_SECTORS;
        this.raiseFlag(sec, severity);
        this.raiseFlag(prev, severity);

        if (!car.yellowRaised) {
          car.yellowRaised = true;
          const where = (this.track.cornerNameAt(car.s) || 'sector ' + (sec + 1));
          // `either`: race control notes a stranger's excursion and raises the
          // flag; the pit wall reacts when the car in the gravel is one of
          // yours. The player's own principal has no business narrating a
          // rival's off, and that is exactly what he was doing.
          this.log(
            'Yellow flag — ' + car.driver.code + ' off at ' + where,
            'warning', sessionTime, car.index,
            {
              feed: 'either',
              notice: {
                parties: [car.driver.code],
                where: where.toUpperCase(),
                offence: 'CAR OFF TRACK',
                status: 'YELLOW FLAG',
              },
              team: { kind: 'off', corner: where, hit: '', heavy: severity !== 'yellow' },
            },
          );
        }
      } else if (car.yellowRaised) {
        car.yellowRaised = false;
      }
    }

    // --- Debris on the racing surface --------------------------------------
    //
    // A yellow, at the post covering it and the one before, for exactly as long
    // as it takes somebody to walk out and pick it up. That is the sequence a
    // televised race shows a dozen times a season, and modelling it is the only
    // thing that makes bodywork on the road TEMPORARY without inventing a
    // lifetime for it — the flag goes out because the carbon is there, and the
    // carbon goes because the flag brought marshals to it.
    //
    // Deliberately NOT counted toward `activeIncidents`. That counter decides
    // whether to deploy a safety car, and the article that deploys one (2025
    // Art. 55.3 / 2026 Art. B5.13.1) is about people in immediate physical
    // danger. A marshal collecting an endplate under a local yellow is the
    // routine alternative to that, not an instance of it, and wiring debris
    // into it would neutralise a race for every piece of carbon on the circuit.
    if (debris) {
      for (const pile of debris.piles) {
        const signal = pile.signal;
        if (signal === null) continue;
        const sec = this.sectorIndexAt(pile.s);
        this.raiseFlag(sec, signal);
        this.raiseFlag((sec + MARSHAL_SECTORS - 1) % MARSHAL_SECTORS, signal);
      }
    }

    this.activeIncidents = incidents;
  }

  /** Number of cars currently causing a yellow. Drives SC/VSC decisions. */
  activeIncidents = 0;

  private raiseFlag(sector: number, state: FlagState): void {
    const cur = this.sectorFlags[sector];
    if (cur === 'red') return;
    // Never downgrade a double yellow to a single.
    if (cur === 'double-yellow' && state === 'yellow') return;
    this.sectorFlags[sector] = state;
  }

  /**
   * Decides whether to neutralise the race, and runs the procedure.
   *
   * The choice between the two is the regulation's own: the VSC is "used when
   * double waved yellow flags are needed on any section of track and Competitors
   * or officials may be in danger, but the circumstances are not such as to
   * warrant use of the Safety Car" (2025 Art. 56.1a / 2026 Art. B5.12), and the
   * safety car is used "only if Competitors or officials are in immediate
   * physical danger on or near the track but the circumstances are not such as
   * to necessitate suspending" the session (Art. 55.3 / B5.13.1). So: a stopped
   * car somewhere fast, or more than one, is immediate physical danger and gets
   * the full safety car; a single car in a safe place gets the VSC.
   */
  private updateNeutralisation(
    dt: number,
    cars: CarEntry[],
    standings: readonly CarEntry[],
    sessionTime: number,
    isRace: boolean,
  ): void {
    if (!isRace) {
      // In practice and qualifying, incidents produce yellows but never a
      // safety car — sessions are red-flagged instead.
      this.neutralisation = 'none';
      this.scPhase = 'none';
      this.scOnTrack = false;
      return;
    }

    if (this.neutralisation === 'safety-car') {
      this.runSafetyCar(dt, cars, standings, sessionTime);
      return;
    }
    if (this.neutralisation === 'vsc') {
      this.runVirtualSafetyCar(dt, sessionTime);
      return;
    }

    if (this.activeIncidents === 0) return;

    // A stranded car in a fast place is more dangerous than one in a
    // gravel trap, so the response escalates with where the incident is.
    let dangerous = false;
    for (const car of cars) {
      if (!car.retired || car.recovered) continue;
      const halfWidth = this.track.halfWidthAt(car.s);
      const nearTrack = Math.abs(car.lateral) < halfWidth + RECOVERY_TRACKSIDE_M;
      const fastHere =
        this.track.targetSpeed[this.track.indexAt(car.s)] > RECOVERY_FAST_SECTION_MS;
      // A crane counts as being near the track wherever the car is. The jib
      // swings over the circuit and the tractor is driven in through a gate, so
      // the working area is the road itself however deep in the gravel the car
      // ended up — and doing that at the end of a straight is the "immediate
      // physical danger ... on or near the track" the safety car exists for
      // (Art. 55.3 / B5.13.1) rather than the lesser case the VSC covers.
      if (fastHere && (nearTrack || car.recovery.method === 'crane')) dangerous = true;
    }

    // The test is DANGER, not a head count. A safety car is for "immediate
    // physical danger on or near the track" (Art. 55.3 / B5.13.1); the VSC is
    // for when double yellows are needed and "the circumstances are not such as
    // to warrant use of the Safety Car" (Art. 56.1a / B5.12). Two cars parked
    // in gravel traps on opposite sides of the circuit are two VSC situations,
    // not a safety car — and treating them as one meant a field that crashes
    // often spent a third of the race behind a safety car that the regulations
    // would never have deployed.
    if (dangerous || this.activeIncidents >= 3) {
      this.deploySafetyCar(standings, sessionTime);
    } else {
      this.deployVirtualSafetyCar(sessionTime);
    }
  }

  // -------------------------------------------------------------------------
  // Virtual safety car — Art. 56 / B5.12
  // -------------------------------------------------------------------------

  private deployVirtualSafetyCar(sessionTime: number): void {
    this.neutralisation = 'vsc';
    this.vscTargetMs = VSC_PACE_MS;
    this.neutralisedScale = VSC_PACE_SCALE;
    this.neutralisationTimer = 30;
    this.vscGreenIn = -1;
    // The message and the panels are both part of the procedure: "the message
    // 'VSC DEPLOYED' will be sent to all Competitors [and] all FIA light panels
    // will display 'VSC'" — Art. 56.2 / B5.12.1.
    this.log('VSC DEPLOYED', 'warning', sessionTime);
  }

  private runVirtualSafetyCar(dt: number, sessionTime: number): void {
    // Already ending: count down the 10-to-15 second window to the green.
    if (this.vscGreenIn >= 0) {
      this.vscGreenIn -= dt;
      if (this.vscGreenIn <= 0) {
        this.neutralisation = 'none';
        this.vscTargetMs = 0;
        this.neutralisedScale = 0;
        this.vscGreenIn = -1;
        this.log('GREEN FLAG — VSC ended', 'info', sessionTime);
      }
      return;
    }

    this.neutralisationTimer -= dt;
    if (this.neutralisationTimer > 0 || this.activeIncidents > 0) return;

    // "the message 'VSC ENDING' will be sent to all Competitors and, at any time
    // between 10 and 15 seconds later, 'VSC' on the FIA light panels will change
    // to green" — Art. 56.7 / B5.12.4. The delay is drawn inside the window
    // rather than fixed, because the whole point of the window is that a driver
    // cannot time the restart.
    this.vscGreenIn = VSC_ENDING_MIN_S + this.rng() * (VSC_ENDING_MAX_S - VSC_ENDING_MIN_S);
    this.log('VSC ENDING', 'warning', sessionTime);
  }

  // -------------------------------------------------------------------------
  // Safety car — Art. 55 / B5.13
  // -------------------------------------------------------------------------

  private deploySafetyCar(standings: readonly CarEntry[], sessionTime: number): void {
    this.neutralisation = 'safety-car';
    this.scPhase = 'bunching';
    this.vscTargetMs = SC_PACE_MS;
    this.neutralisedScale = SC_PACE_SCALE;
    this.scOnTrack = true;
    this.scTimer = SC_MIN_BUNCH_S;
    this.lappedCarsWaved = false;
    this.scWaveLap = -1;
    this.pitExitClosed = false;

    // The car joins the circuit "regardless of where the leader is"
    // (Art. 55.4 / B5.13.1). Modelled as joining just ahead of the leader,
    // which is where it ends up once it has picked the leader up and is the
    // only part of that the field can observe.
    //
    // AHEAD, with room. It used to join exactly ON the leader, and a leader
    // arriving at 300 km/h needs a couple of hundred metres to come down to
    // safety car pace — so it was past the safety car before it had slowed, and
    // the "queue" then formed up behind a car that was itself in front of the
    // thing it was supposed to be queueing behind. `SC_PICKUP_LEAD_M` is more
    // road than that deceleration can eat.
    const leader = standings.length > 0 ? standings[0] : null;
    this.scS = leader ? (leader.s + SC_PICKUP_LEAD_M) % this.track.length : 0;
    this.scLap = leader ? leader.lap : 0;
    this.scSpeedMs = SC_PACE_MS;
    this.scToEntryM = Infinity;

    this.log('SAFETY CAR DEPLOYED', 'critical', sessionTime);

    // Ten car lengths, or twenty if the Race Director declares low visibility.
    //
    // New for 2026 and with no 2025 equivalent: "at the Race Director's sole
    // discretion the maximum allowable gap ... may be increased to twenty (20)
    // car lengths", announced with its own message (Art. B5.13.2b). Spray
    // behind a car in standing water is the reason the discretion exists, so
    // heavy rain is what triggers it here.
    this.lowVisibility = this.wetness > 0.65;
    this.maxQueueGapM = CAR_LENGTH_M *
      (this.lowVisibility ? SC_MAX_GAP_CAR_LENGTHS_LOW_VIS : SC_MAX_GAP_CAR_LENGTHS);
    if (this.lowVisibility) {
      this.log('LOW VISIBILITY — MAXIMUM GAP TWENTY CAR LENGTHS', 'warning', sessionTime);
    }
  }

  /**
   * Runs the safety car through its phases.
   *
   * Every transition below is a specific instruction in the regulations, and
   * each one changes what the drivers are required to do — which is why the
   * phases exist rather than a single timer.
   */
  private runSafetyCar(
    dt: number,
    cars: CarEntry[],
    standings: readonly CarEntry[],
    sessionTime: number,
  ): void {
    this.scTimer -= dt;

    const leader = standings.length > 0 ? standings[0] : null;

    // The safety car itself circulates at the neutralised pace.
    if (this.scOnTrack) {
      this.scSpeedMs = this.safetyCarPaceMs(leader);
      const travelled = this.scSpeedMs * dt;
      this.scS += travelled;
      this.scToEntryM -= travelled;
      if (this.scS >= this.track.length) {
        this.scS -= this.track.length;
        this.scLap++;
      }
    } else {
      this.scSpeedMs = 0;
    }

    switch (this.scPhase) {
      case 'bunching': {
        // "The Safety Car ... shall be used at least until the leader is behind
        // it and all remaining cars are lined up behind them" —
        // Art. 55.10 / B5.13.5a.
        //
        // That is a CONDITION, and it used to be implemented as a 25-second
        // timer, which is a different rule with a different result. Measured on
        // a staged deployment at Monza the field was still strung out over
        // 590 metres a car when the safety car left this phase — it had spent
        // fifty seconds bunching a field that needed two laps, and then come in
        // and restarted a race that had never formed up. The condition below is
        // the sentence the regulation actually contains.
        if (this.scTimer > 0 || this.activeIncidents > 0) return;
        if (!leader) return;
        if (!this.fieldFormedUp(standings) && this.scTimer > -SC_MAX_BUNCH_EXTRA_S) return;

        // Are there cars a lap or more down? If so they are told to unlap
        // themselves before the car comes in.
        if (this.countLappedCars(cars, leader) > 0) {
          this.waveLappedCarsPast(cars, leader, sessionTime);
        } else {
          this.callSafetyCarIn(sessionTime);
        }
        return;
      }

      case 'waving-lapped': {
        // The pit exit is closed only while the train is actually there.
        //
        // The regulation is specific about when: the exit may be closed "while
        // these cars rejoin ... when the Safety Car and the line of cars are
        // approaching or passing the pit exit" (Art. 55.14 / B5.13.4c). Holding
        // it shut for the whole phase instead is a very different rule — it
        // pins a car that has finished its stop at the end of the lane for a
        // complete safety car lap, which at Bahrain was over two minutes and
        // pushed the field's lap-time spread past four minutes.
        this.pitExitClosed = this.queueNearPitExit();

        // "once the message 'LAPPED CARS MAY NOW OVERTAKE' has been sent ... the
        // Safety Car will return to the pits at the end of the following lap"
        // — Art. 55.14 final paragraph / B5.13.5b.
        const lapsSince = leader ? leader.lap - this.scWaveLap : 0;
        const allUnlapped = leader ? this.countLappedCars(cars, leader) === 0 : false;
        if (lapsSince >= SC_LAPS_AFTER_WAVE || allUnlapped) {
          // The pit exit reopens once they are back in the queue.
          this.pitExitClosed = false;
          for (const car of cars) car.mustUnlap = false;
          this.callSafetyCarIn(sessionTime);
        }
        return;
      }

      case 'in-this-lap': {
        // The safety car peels into the pit entry road at the end of this lap.
        // From the moment the orange lights go out the leader dictates the pace
        // (Art. 55.15 / B5.13.6) — modelled by taking the car off the circuit,
        // which releases the queue's speed cap and hands the pace to the leader.
        if (this.scToEntryM <= 0) {
          this.scOnTrack = false;
          this.scPhase = 'restart';
          this.neutralisation = 'none';
          this.vscTargetMs = 0;
          this.neutralisedScale = 0;
          // "no driver may overtake another F1 Car on the track ... until they
          // pass the Line for the first time after the Safety Car has entered
          // the Pit Entry Road" — Art. 55.8 / B5.13.2c. Each car carries the
          // obligation individually until it has itself crossed the Line.
          for (const car of cars) car.holdUntilLine = !car.retired;
          this.log('GREEN FLAG — track clear at the Line', 'info', sessionTime);
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * How fast the safety car is going, m/s.
   *
   * TWO BUGS IN ONE CONSTANT. It used to be `SC_PACE_MS` — a flat 40 m/s — and
   * the field it was leading was held to `min(racingLineSpeed * 0.42, 40)`,
   * which at Monza is around 30. The safety car was therefore a third quicker
   * than the cars it was supposed to be bunching, and it drove away from them:
   * measured, the median form-up gap was 62m against a 56m limit at one seed
   * and 293m at the next, with 72-99% of samples over the ten-car-length limit
   * of Art. 55.7 / B5.13.2b. The queue could not form up because the front of
   * it was chasing something it could not catch.
   *
   * So the safety car runs the same profile the field runs — the same cap and
   * the same fraction of the racing line, so it slows for the same corners at
   * the same points, which is the whole reason a real safety car lap is 1.6 to
   * 2 times a racing one everywhere rather than only on the straights.
   *
   * And it waits. "The Safety Car ... shall be used at least until the leader
   * is behind it and all remaining cars are lined up behind them"
   * (Art. 55.10 / B5.13.5a) is a condition that cannot be satisfied by a car
   * driving away from the leader at the leader's own maximum speed, so while
   * the field is still bunching it backs off toward a crawl until the leader
   * has closed onto it. That is exactly what the real car does, and it is why
   * the first lap behind a safety car is the slowest one.
   */
  private safetyCarPaceMs(leader: CarEntry | null): number {
    const line = this.track.targetSpeed[this.track.indexAt(this.scS)];
    const pace = Math.min(line * SC_PACE_SCALE, SC_PACE_MS);

    // Only while the queue is still forming. Once it has, the safety car sets
    // the pace and the field holds station on it.
    if (this.scPhase !== 'bunching' || !leader) return pace;
    const behind = loopDelta(leader.s, this.scS, this.track.length);
    // Leader ahead of the safety car, or far enough back that slowing down
    // would take a whole extra lap to help — neither is a gap to close this
    // way. A quarter of a lap rather than a half, because at a half the test
    // cannot tell "the leader is a long way behind" from "the leader is a long
    // way in front", and it answered the wrong one.
    if (behind < 0 || behind > this.track.length * 0.25) return pace;
    // Full pace once the leader is within a few car lengths; a slow cruise
    // while it is a long way off, so the gap actually closes.
    const t = clamp01((behind - this.maxQueueGapM) / (this.maxQueueGapM * 4));
    return pace * (1 - t * (1 - SC_BUNCHING_PACE_SHARE));
  }

  /**
   * Cars that have been lapped by the leader and are therefore required to
   * unlap themselves when told to.
   *
   * Eligibility is fixed at the moment they crossed the Line — "only apply to
   * F1 Cars that were lapped at the time they crossed the Line at the end of the
   * lap during which they crossed the first safety car line for the second time
   * after the Safety Car was deployed" (Art. 55.14 / B5.13.4c). Approximated
   * here as "a lap or more down on the leader", which is the same set in every
   * case that matters.
   */
  /**
   * Is the leader behind the safety car with the field lined up behind them?
   *
   * The literal test from Art. 55.10 / B5.13.5a, with two allowances that the
   * regulation's own structure implies rather than states.
   *
   * Cars a lap or more down are not required to be in the queue at this point:
   * they are precisely the cars the next phase exists to deal with, and waiting
   * for a car that is half a lap behind the leader to close onto the car
   * classified ahead of it would mean waiting for it to make up a lap under the
   * safety car, which is the opposite of what is about to be asked of it.
   *
   * The tolerance is 2.5x the stated gap rather than 1x because the gap rule is
   * a target the drivers close onto, not a tripwire — a queue whose cars are
   * each within a couple of car lengths of the limit IS formed up, and demanding
   * that all twenty simultaneously sit inside it is a condition a real safety
   * car period never satisfies either.
   */
  private fieldFormedUp(standings: readonly CarEntry[]): boolean {
    const running = standings.filter((c) => !c.retired && !c.inPitLane);
    if (running.length < 2) return true;

    const leader = running[0];
    // The leader has to be behind the safety car, and reasonably close to it.
    const toSafetyCar = loopDelta(leader.s, this.scS, this.track.length);
    if (toSafetyCar < 0 || toSafetyCar > this.maxQueueGapM * 3) return false;

    const tolerance = this.maxQueueGapM * 2.5;
    for (let i = 1; i < running.length; i++) {
      if (this.isLapped(running[i], leader)) continue;
      const gap = loopDelta(running[i].s, running[i - 1].s, this.track.length);
      if (gap < 0 || gap > tolerance) return false;
    }
    return true;
  }

  /**
   * Is this car a full lap or more behind the leader?
   *
   * ON DISTANCE, not on the lap counter, and that distinction is most of why a
   * safety car queue never formed up. `car.lap < leader.lap` is true of every
   * car that has not yet crossed the Line on the lap the leader is currently
   * on — which, a metre after the leader takes the flag, is the entire rest of
   * the field. Measured at Monza, eighteen of the twenty cars were classified
   * as lapped at every deployment, all eighteen were told to unlap themselves
   * under Art. 55.14 / B5.13.4c, and all eighteen were then entitled to run at
   * 1.75x the queue pace past everybody. There was no queue left to form.
   *
   * A lap of distance is a lap of distance: where the two cars happen to be
   * relative to the start/finish line has nothing to do with it.
   */
  private isLapped(car: CarEntry, leader: CarEntry): boolean {
    const len = this.track.length;
    return (leader.lap * len + leader.s) - (car.lap * len + car.s) >= len;
  }

  private countLappedCars(cars: CarEntry[], leader: CarEntry): number {
    let n = 0;
    for (const car of cars) {
      if (car.retired || car.inPitLane) continue;
      if (this.isLapped(car, leader)) n++;
    }
    return n;
  }

  private waveLappedCarsPast(cars: CarEntry[], leader: CarEntry, sessionTime: number): void {
    this.scPhase = 'waving-lapped';
    this.lappedCarsWaved = true;
    this.scWaveLap = leader.lap;
    // "the pit lane exit may be closed at the race director's sole discretion
    // while these cars rejoin" — Art. 55.14 / B5.13.4c.
    this.pitExitClosed = true;

    for (const car of cars) {
      // Note the wording: lapped cars are REQUIRED to pass, not permitted to.
      // The 2021 partial-unlap has no basis in the text — it is all of them.
      car.mustUnlap = !car.retired && !car.inPitLane && this.isLapped(car, leader);
    }
    this.log('LAPPED CARS MAY NOW OVERTAKE', 'warning', sessionTime);
  }

  /**
   * Is the safety car, and the queue strung out behind it, at the pit exit?
   *
   * The queue occupies the road from the safety car backwards, so "approaching
   * or passing the pit exit" means the exit lies inside a stretch running from
   * a little ahead of the safety car to some way behind it.
   */
  private queueNearPitExit(): boolean {
    const exitS = this.track.def.pitLane.exitS;
    // Signed distance from the safety car to the pit exit, forwards positive.
    const ahead = loopDelta(this.scS, exitS, this.track.length);
    return ahead < SC_QUEUE_LEAD_M && ahead > -SC_QUEUE_TAIL_M;
  }

  private callSafetyCarIn(sessionTime: number): void {
    this.scPhase = 'in-this-lap';
    // "SAFETY CAR IN THIS LAP" means it peels off at the end of the lap it is
    // ON — so what remains is the distance from where the car actually is to
    // the pit entry, not a fresh lap of the circuit. Charging a full lap here
    // instead doubled the length of every deployment and left the field
    // neutralised for nearly half the race.
    const toEntry = loopDelta(this.scS, this.track.def.pitLane.entryS, this.track.length);
    const remaining = toEntry >= 0 ? toEntry : toEntry + this.track.length;
    // Held as a DISTANCE rather than as a time. It used to be
    // `max(remaining, 60) / SC_PACE_MS`, which converts a distance to a time
    // using the speed CAP rather than the speed — and now that the safety car
    // slows for the corners like everything else, the cap is not the speed
    // anywhere. A phase whose length is an estimate of a distance the same
    // object is simultaneously covering exactly is an estimate that does not
    // need to exist.
    this.scToEntryM = Math.max(remaining, 60);
    this.log('SAFETY CAR IN THIS LAP', 'warning', sessionTime);
  }

  /**
   * Enforces the minimum time under a neutralisation.
   *
   * "drivers must stay above the minimum time set by the FIA ECU at least once
   * in each marshalling sector and at both the first and second safety car
   * lines (a marshalling sector is defined as the section of track between each
   * of the FIA light panels)." — Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b.
   *
   * The "at least once in each marshalling sector" wording matters and is
   * routinely simulated wrongly as a continuous speed cap. It is not: a driver
   * may legally be below the delta momentarily inside a sector provided the
   * sector as a whole took at least the minimum time. So the check is on the
   * TIME TAKEN to cross each marshalling sector, which is what the ECU actually
   * measures, and a car is only penalised for completing one too quickly.
   *
   * Penalty menu is the regulation's own: 5-second, 10-second, drive-through or
   * stop-and-go (Art. 55.7 / 56.5, cross-referencing Art. 54.3a-d).
   */
  private checkNeutralisationDelta(car: CarEntry, index: number, dt: number, sessionTime: number): void {
    // A car that has been waved past is under an instruction to pass the whole
    // queue and the safety car within a lap (Art. 55.14 / B5.13.4c), which is
    // not something that can be done above the minimum time. Timing it against
    // the delta penalises it for obeying the other article — measured, twenty
    // five-second penalties were issued in a single race to cars doing exactly
    // what race control had just told them to do.
    if (car.mustUnlap) {
      car.deltaSectorTime = 0;
      car.deltaSectorIndex = -1;
      car.deltaSectorPartial = true;
      return;
    }
    if (this.neutralisation === 'none' || car.inPitLane) {
      car.deltaSectorTime = 0;
      car.deltaSectorIndex = -1;
      car.deltaSectorPartial = true;
      return;
    }

    const sector = this.sectorIndexAt(car.s);
    if (car.deltaSectorIndex !== sector) {
      // Closed out a marshalling sector. Judge the one just completed —
      // unless it was only partly driven under the neutralisation.
      //
      // The very first sector a car is timed through is the one it happened to
      // be in when the safety car was called, and it may already have been
      // nine tenths of the way through it. Timing that stub against a whole
      // sector's minimum makes every car in the field look like it was doing
      // ten times the delta, and the first thing a VSC did was hand out five
      // second penalties to whoever was unlucky enough to be near a boundary.
      const minimum = this.minimumSectorTimeS;
      if (!car.deltaSectorPartial && car.deltaSectorTime > 0.5 &&
          car.deltaSectorTime < minimum) {
        car.deltaBreaches++;
        // First one is a warning; a driver who keeps ignoring the delta is
        // gaining a real advantage and takes the time penalty.
        if (car.deltaBreaches >= 2) {
          car.penalties.push({
            kind: 'time-5s',
            reason: 'Below the delta under ' +
              (this.neutralisation === 'vsc' ? 'VSC' : 'the safety car'),
            lap: car.lap, timeS: 5, served: false,
          });
          car.penaltySeconds += 5;
          this.log(
            car.driver.code + ' — 5 second penalty, below the delta',
            'critical', sessionTime, index,
            { notice: {
              parties: [car.driver.code], where: 'SECTOR ' + (sector + 1),
              offence: 'BELOW THE DELTA', status: '5 SECOND TIME PENALTY',
            } },
          );
        } else {
          this.log(
            car.driver.code + ' — warning, below the delta', 'warning', sessionTime, index,
            { notice: {
              parties: [car.driver.code], where: 'SECTOR ' + (sector + 1),
              offence: 'BELOW THE DELTA', status: 'WARNING',
            } },
          );
        }
      }
      // Only a sector entered cleanly at its boundary is judged in full.
      car.deltaSectorPartial = car.deltaSectorIndex < 0;
      car.deltaSectorIndex = sector;
      car.deltaSectorTime = 0;
    }
    car.deltaSectorTime += dt;
  }

  /**
   * How far the car's four contact patches reach, either side of the
   * centreline, in the track's own lateral coordinate.
   *
   * Written to `contactSpan`, which is reused every step for every car.
   *
   * THE POINTS. The regulation asks whether any part of the car is still in
   * contact with the track, so the points that matter are the four tyres, and
   * of each tyre the OUTBOARD face — because the tyre nearest the circuit is
   * the last thing touching it, and it is that tyre's far edge that has to
   * clear the line. They sit at ±`CAR_HALF_WIDTH_M` on the front and rear axle
   * lines.
   *
   * THE YAW. This is why the four points are computed rather than assumed. A
   * car pointing straight down the road spans exactly ±`CAR_HALF_WIDTH_M`
   * across the track, so the old test — the car's centre, plus or minus half a
   * width — was right for that one case and wrong for every other. A car with
   * fifteen degrees of slip angle spans two thirds of a metre wider, and a car
   * running wide at a corner exit is never pointing straight down the road:
   * that is the whole reason it is running wide. Ignoring the yaw shrinks the
   * car to its own centreline projection and deletes the lap of a driver whose
   * inside rear is still on the paint, which is exactly the reported defect.
   *
   * A body point (`bx` outboard, `bz` forward) lands at track lateral
   * `car.lateral + bx cos psi + bz sin psi`, where `psi` is the car's heading
   * relative to the track's.
   */
  private readonly contactSpan = { min: 0, max: 0 };

  private measureContactSpan(car: CarEntry): void {
    const spec = car.physics.spec;
    const psi = car.physics.heading - this.track.headingAt(car.s);
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    const halfW = CAR_HALF_WIDTH_M * c;
    const front = spec.cogToFrontM * s;
    const rear = -(spec.wheelbaseM - spec.cogToFrontM) * s;

    let min = Infinity;
    let max = -Infinity;
    for (const along of [front, rear]) {
      for (const across of [halfW, -halfW]) {
        const lat = car.lateral + across + along;
        if (lat < min) min = lat;
        if (lat > max) max = lat;
      }
    }
    this.contactSpan.min = min;
    this.contactSpan.max = max;
  }

  /**
   * Track limits.
   *
   * "A driver will be judged to have left the track if no part of the car
   * remains in contact with it" (2025 Sporting Regulations Art. 33.3), and the
   * track is bounded by the OUTER edge of the white lines — the line itself is
   * part of the track, which is why a car with a tyre still on the paint has
   * not left it.
   *
   * That boundary is `halfWidthAt`, exactly and with no margin of its own:
   * `TrackMesh` paints the edge line INBOARD of the half-width, so the outer
   * edge of the paint the driver can see and the number tested here are the
   * same line. Adding a fudge factor to either would separate them again.
   *
   * An infraction is counted once per excursion rather than once per physics
   * step, which would issue 120 penalties a second.
   */
  private checkTrackLimits(car: CarEntry, index: number, sessionTime: number, isRace: boolean): void {
    if (car.inPitLane) return;

    const halfWidth = this.track.halfWidthAt(car.s);
    this.measureContactSpan(car);
    // Off only when EVERY contact patch is beyond the SAME edge. Testing the
    // two edges separately rather than against `Math.abs(lateral)` matters for
    // a car spun across a narrow circuit, where a bare magnitude test can find
    // it beyond both edges at once and call that an excursion.
    const allFourOff =
      this.contactSpan.min > halfWidth || this.contactSpan.max < -halfWidth;

    if (allFourOff) {
      if (!car.offTrackNow) {
        car.offTrackNow = true;
        // Only counts if the car gained something — leaving the road under
        // control at a corner exit counts, spinning off into a gravel trap and
        // losing four seconds does not, and stewards apply the same logic.
        const lostTime = car.physics.speedMs < this.track.targetSpeed[this.track.indexAt(car.s)] * 0.72;
        // ...and, outside a race, only if there is a lap time to lose. See
        // `sanctionableLap`.
        if (!lostTime && this.sanctionableLap(car, isRace)) {
          car.trackLimitStrikes++;
          this.onTrackLimitInfraction(car, index, sessionTime, isRace);
        }
      }
    } else if (car.offTrackNow) {
      car.offTrackNow = false;
    }
  }

  /**
   * Is there anything the stewards could actually do about an excursion here?
   *
   * The driver has still left the track — Art. B1.8.6 defines that by where the
   * car is and says nothing about which lap it is on, so the excursion is real
   * and the physics of running through the gravel are unchanged. The question
   * this answers is narrower: whether the offence carries a sanction.
   *
   * In a Lap Time Classified Session it does not, on a lap that will not be
   * timed. Art. B1.9.4 is the whole of what the stewards may do about an
   * incident in an LTCS — "the Stewards may delete a driver's lap time (or lap
   * times) or drop the driver such number of grid positions as they consider
   * appropriate" — and on an out-lap the first of those has no object. There is
   * no lap time to delete. The game was deleting one anyway and announcing it:
   * "lap time deleted — track limits at Turn 4", on the lap out of the garage,
   * about a time that was never going to be classified. Reported by a player,
   * who was right about it: "idt there should be penalties or limits for the
   * first lap of qualifying."
   *
   * It also stopped the strike counter running away. The 3-strike black-and-
   * white flag and the 5-second penalty above it are race machinery — Art.
   * B1.9.5's penalties are all TTCS penalties, and an LTCS has no accumulating
   * ladder at all — so a strike recorded in practice or qualifying exists only
   * to be printed beside the driver's name on the timesheet. Counting one for
   * an offence that carried no sanction made that column say something untrue.
   *
   * WHAT THIS DELIBERATELY DOES NOT SUPPRESS. Art. B1.9.4's second remedy, the
   * grid drop, applies perfectly well to an out-lap, and the offence it is most
   * often used for — impeding a driver who is on a flying lap while you crawl
   * on the racing line — is an out-lap offence almost by definition. This game
   * does not model impeding at all today. That is a gap in it, not something
   * this function is closing: when impeding arrives it belongs on the out-lap
   * and must not be gated on this.
   *
   * A race has no untimed laps, so `isRace` short-circuits the whole question.
   */
  private sanctionableLap(car: CarEntry, isRace: boolean): boolean {
    if (isRace) return true;
    // The lap out of the garage or out of the pit box. `RaceEngine` already
    // throws its time away at the line, so there is nothing here to delete.
    if (car.onOutLap) return false;
    // The lap in. Its time is never classified either — the car turns off
    // before the line and `completeLap` never runs — so a deletion notice for
    // it is noise about a time that does not exist.
    if (car.pitRequested) return false;
    return true;
  }

  private onTrackLimitInfraction(car: CarEntry, index: number, sessionTime: number, isRace: boolean): void {
    const n = car.trackLimitStrikes;
    const corner = this.track.cornerNameAt(car.s) || 'turn';

    // In qualifying and practice, an off-track lap is simply deleted — there is
    // no strike system, because the penalty is losing the lap time (Art.
    // B1.9.4). `sanctionableLap` has already established that there IS a lap
    // time here to lose.
    if (!isRace) {
      car.currentLapInvalidated = true;
      this.log(
        car.driver.code + ' lap time deleted — track limits at ' + corner,
        'warning', sessionTime, index,
        { notice: {
          parties: [car.driver.code], where: corner.toUpperCase(),
          offence: 'TRACK LIMITS', status: 'LAP TIME DELETED',
        } },
      );
      return;
    }

    if (n === TRACK_LIMIT_WARNING_AT) {
      car.penalties.push({
        kind: 'track-limits-warning',
        reason: 'Track limits x3 at ' + corner,
        lap: car.lap, timeS: 0, served: true,
      });
      this.log(
        car.driver.code + ' — black and white flag, track limits',
        'warning', sessionTime, index,
        { notice: {
          parties: [car.driver.code], where: corner.toUpperCase(),
          offence: 'TRACK LIMITS x3', status: 'BLACK AND WHITE FLAG',
        } },
      );
    } else if (n >= TRACK_LIMIT_PENALTY_AT) {
      car.penalties.push({
        kind: 'time-5s',
        reason: 'Track limits x' + n + ' at ' + corner,
        lap: car.lap, timeS: 5, served: false,
      });
      car.penaltySeconds += 5;
      this.log(
        car.driver.code + ' — 5 second time penalty, track limits',
        'critical', sessionTime, index,
        { notice: {
          parties: [car.driver.code], where: corner.toUpperCase(),
          offence: 'TRACK LIMITS x' + n, status: '5 SECOND TIME PENALTY',
        } },
      );
    } else {
      this.log(
        car.driver.code + ' — track limits warning ' + n + '/3 at ' + corner,
        'info', sessionTime, index,
        { notice: {
          parties: [car.driver.code], where: corner.toUpperCase(),
          offence: 'TRACK LIMITS', status: 'WARNING ' + n + ' OF 3',
        } },
      );
    }
  }

  /**
   * Pit lane speed limit.
   *
   * Exceeding it is a drive-through in a race. The check uses a small tolerance
   * so a car sitting exactly on the limiter is not penalised for float noise.
   */
  private checkPitLaneSpeed(car: CarEntry, index: number, sessionTime: number): void {
    if (!car.inPitLane) {
      car.pitSpeedingFlagged = false;
      return;
    }

    const limit = this.track.def.pitLane.speedLimitKph + PIT_SPEED_TOLERANCE_KPH;
    if (car.physics.speedKph > limit && !car.pitSpeedingFlagged) {
      car.pitSpeedingFlagged = true;
      car.penalties.push({
        kind: 'drive-through',
        reason: 'Speeding in the pit lane (' + car.physics.speedKph.toFixed(1) + ' km/h)',
        lap: car.lap, timeS: 0, served: false,
      });
      this.log(
        car.driver.code + ' — DRIVE THROUGH PENALTY, pit lane speeding',
        'critical', sessionTime, index,
        { notice: {
          parties: [car.driver.code], where: 'PIT LANE',
          offence: 'SPEEDING IN THE PIT LANE', status: 'DRIVE-THROUGH PENALTY',
        } },
      );
    }
  }

  // =========================================================================
  // End-of-race checks
  // =========================================================================

  /**
   * The mandatory two-compound rule.
   *
   * In a dry race a car must use at least two different dry compounds. Failing
   * to is a disqualification, not a time penalty. Cars that took a wet-weather
   * tire at any point are exempt, because the rule is suspended once the race is
   * declared wet.
   */
  checkMandatoryCompounds(cars: CarEntry[], raceWasWet: boolean, sessionTime: number): void {
    if (raceWasWet) return;

    for (const car of cars) {
      if (car.retired) continue;
      // Only cars that actually finished are subject to it.
      if (!car.finished) continue;

      const unique = new Set<string>();
      let usedWet = false;
      for (const c of car.usedCompounds) {
        if (c === 'intermediate' || c === 'wet') usedWet = true;
        else unique.add(c);
      }
      if (usedWet) continue;

      if (unique.size < 2) {
        car.penalties.push({
          kind: 'disqualified',
          reason: 'Did not use two different dry compounds',
          lap: car.lap, timeS: 0, served: true,
        });
        car.disqualified = true;
        this.log(
          car.driver.code + ' DISQUALIFIED — mandatory tyre rule not satisfied',
          'critical', sessionTime, car.index,
          { notice: {
            parties: [car.driver.code], where: '',
            offence: 'MANDATORY TYRE RULE', status: 'DISQUALIFIED',
          } },
        );
      }
    }
  }

  /** Red-flags the session, freezing the order. */
  redFlag(reason: string, sessionTime: number): void {
    this.sessionFlag = 'red';
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags[i] = 'red';
    this.log('RED FLAG — ' + reason, 'critical', sessionTime);
  }

  /** Waves the chequered flag. */
  chequeredFlag(sessionTime: number): void {
    this.sessionFlag = 'chequered';
    this.raceFinished = true;
    this.log('Chequered flag', 'info', sessionTime);
  }

  /** Clears a red flag back to green, for a restart. */
  resumeFromRed(sessionTime: number): void {
    this.sessionFlag = 'green';
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags[i] = 'green';
    this.log('Green flag — session resumed', 'info', sessionTime);
  }

  /**
   * Blue flag: is this car about to be lapped by a faster one?
   *
   * "the flag should normally be shown to a car about to be lapped ... When
   * shown, the driver concerned must allow the following car to pass at the
   * earliest opportunity." — ISC Appendix H Art. 2.5.5e. Yielding is required
   * within a few corners, so the check is a distance one.
   *
   * Note on the widely-quoted "three blue flags and it is a five second
   * penalty": that is not in the Sporting Regulations or in Appendix H. Every
   * mention of blue in the 2024, 2025 and 2026 F1 Sporting Regulations is the
   * pit-exit warning flag (2025 Art. 37.2 / 2026 Art. B1.6.3e). The three-flag
   * threshold is a stewarding convention published per-event in the Race
   * Director's Event Notes, so there is no article to cite for it and it is
   * deliberately not modelled as a penalty here.
   *
   * Suspended under a neutralisation: nobody is being lapped behind a safety
   * car, and while lapped cars are unlapping themselves the obligation is
   * reversed — see `mustUnlap`.
   */
  shouldShowBlueFlag(car: CarEntry, cars: CarEntry[]): boolean {
    if (car.inPitLane || car.retired) return false;
    if (this.neutralisation !== 'none') return false;
    for (const other of cars) {
      if (other === car || other.retired || other.inPitLane) continue;
      // A car a full lap or more ahead, closing on us.
      if (other.lap <= car.lap) continue;
      const gap = loopDelta(car.s, other.s, this.track.length);
      // Behind us but within a couple of hundred metres and coming quickly.
      if (gap < 0 && gap > -190 && other.physics.speedMs > car.physics.speedMs + 1.5) {
        return true;
      }
    }
    return false;
  }

  /**
   * Gap this car must not exceed to the car ahead, metres, or 0 when free.
   *
   * Ten car lengths under the safety car (Art. 55.7 / B5.13.2b), lifted for the
   * leader from the moment the orange lights go out, because at that point
   * "the first F1 Car in line behind the Safety Car may dictate the pace and may
   * fall back from the Safety Car, exceeding the maximum allowable gap"
   * (Art. 55.15 / B5.13.6). That single sentence is the reason a leader can
   * back the field up before a restart.
   */
  queueGapLimitM(car: CarEntry, isLeader: boolean): number {
    if (this.neutralisation !== 'safety-car') return 0;
    // A car in the pit lane is not in the queue.
    if (car.inPitLane || car.retired) return 0;
    if (isLeader && this.scPhase === 'in-this-lap') return 0;
    return this.maxQueueGapM;
  }

  /**
   * The minimum time a marshalling sector may be crossed in, seconds.
   *
   * The quantity the regulations actually impose under both neutralisations —
   * "drivers must stay above the minimum time set by the FIA ECU at least once
   * in each marshalling sector" (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b) —
   * and therefore the number the HUD has to be able to show. A driver cannot
   * read this off a speedometer, which is the whole reason the limit is applied
   * for the player rather than left to them to judge.
   *
   * Public because three things need the same number: race control judging the
   * sector, the HUD reporting it, and the probe asserting that they agree.
   * Zero when the race is green.
   */
  get minimumSectorTimeS(): number {
    if (this.vscTargetMs <= 0) return 0;
    return (this.track.length / MARSHAL_SECTORS) /
      (this.vscTargetMs * DELTA_REFERENCE_MARGIN);
  }

  /** 0..1 severity used to tint the HUD flag banner. */
  get flagSeverity(): number {
    if (this.sessionFlag === 'red') return 1;
    if (this.neutralisation === 'safety-car') return 0.85;
    if (this.neutralisation === 'vsc') return 0.6;
    let worst = 0;
    for (const f of this.sectorFlags) {
      if (f === 'double-yellow') worst = Math.max(worst, 0.5);
      else if (f === 'yellow') worst = Math.max(worst, 0.3);
    }
    return clamp01(worst);
  }
}
