import { loopDelta } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { CarEntry } from './CarEntry';
import {
  CAR_WIDTH_M, completedWithinTrackLimits, insideMarginM, insideRoomMarginM, insideness,
  outsideRoomMarginM, racingRoomM, tariffSeconds,
  type CornerHand, type Offence, type RacingCar, type VerdictKind,
} from './DrivingStandards';

/**
 * The stewards.
 *
 * `RaceControlManager` raises a notice when two cars touch. Until now it
 * resolved to nothing: the notice appeared, and no verdict ever followed. This
 * module is the missing half — it watches the incident, waits, and reaches one
 * of the three outcomes a real investigation can reach.
 *
 *   NO FURTHER ACTION       a racing incident, or nothing proved
 *   GIVE THE POSITION BACK  the remedy, and the thing that avoids a penalty
 *   PENALTY                 with the offence named
 *
 * ===========================================================================
 * THE THREE OFFENCES, AND WHY ONLY THREE
 * ===========================================================================
 *
 * A steward that is wrong is worse than no steward. Every rule here is one
 * whose test is written down as a test somewhere — a distance, an edge, a
 * position — rather than one that needs an opinion about intent. Three of those
 * exist, and they happen to be exactly the three a driver complains about:
 *
 *   CAUSING A COLLISION                     ISC Appendix L Ch. IV Art. 2(d),
 *                                           adjudicated with DSG Points A and B
 *   FORCING ANOTHER DRIVER OFF THE TRACK    ISC Appendix L Ch. IV Art. 2(b)
 *   LEAVING THE TRACK AND GAINING AN
 *   ADVANTAGE                               Art. B1.8.6, DSG Point F
 *
 * Deliberately NOT judged, though the guidelines cover them: Point G (moving on
 * the straight — needs a count of direction changes, and a defensible definition
 * of "the racing line" for a defending car), Point H (moving under braking),
 * Point E (impeding), Point I (unsafe re-join). Each of those is real and each
 * would be a guess here. `DrivingStandards.ts` is the place to add them when the
 * evidence exists to judge them on.
 *
 * ===========================================================================
 * THE THING THIS IS MOST CAREFUL ABOUT
 * ===========================================================================
 *
 * Not missing offences. Inventing them.
 *
 * A steward that hands the player a penalty for a contact the AI caused is
 * worse than a race with no stewards in it, because the player cannot argue and
 * cannot appeal. So every test below is written to return NO FURTHER ACTION
 * unless the case is clear, and the margins are set wide on purpose:
 *
 *  - The corner-priority test must be clear by `CLEAR_PRIORITY_M`. A car half a
 *    metre short of the mirror is not "dived in", it is a racing incident.
 *  - It is not enough to have been in the wrong place. Somebody has to have
 *    CLOSED the gap, by `CLEAR_CONVERGENCE_M`, more than the other car did.
 *    A car that held its line and was driven into is not at fault for being
 *    there, whichever side of the corner it was on.
 *  - A multi-car incident is a racing incident. `CROWD_RADIUS_M`.
 *  - Causing a collision needs a collision. A contact that cost the other car
 *    nothing is a rub, and rubs happen several times a lap in a twenty-car
 *    field. See `Evidence.consequenceA`, which is the single change that took
 *    this from ten penalties a Grand Prix to three.
 *  - Anything involving a stationary wreck, the pit lane, a neutralisation or a
 *    car that had already lost control is not judged at all.
 *
 * The consequence is a distribution rather than a rule. Measured over the
 * calendar, with one car driven through `playerControls` exactly as a human
 * would be: 53 incidents noted, 47 no further action, one position ordered
 * back, six penalties, none of them against the driven car. Scaled off the
 * opening lap that works out at about three penalties in a full-distance Grand
 * Prix, which is what a real one produces. `npm run probe:stewards` measures it
 * and fails if it drifts outside half a penalty to six.
 *
 * ===========================================================================
 * WHY THE VERDICT IS SLOW
 * ===========================================================================
 *
 * Because a real one is. "Unless it is completely clear that a driver committed
 * a driving infringement any such incident will normally be investigated after
 * the relevant session" (Art. B1.9.4a, for an LTCS) — and in a race the stewards
 * announce a note, then an investigation, then a decision, and the whole
 * sequence takes the better part of a lap. A verdict that arrives in the same
 * frame as the contact reads as a collision detector, not as a judgement.
 */

// ===========================================================================
// Tuning
// ===========================================================================

/** Ring buffer sample rate, Hz. The physics runs at 120; this is enough. */
const SAMPLE_HZ = 20;
/** How far back the stewards can look, seconds. A corner takes about four. */
const WINDOW_S = 8;
const SAMPLE_CAP = SAMPLE_HZ * WINDOW_S;
/** Floats per sample. See `FIELD_*`. */
const STRIDE = 12;

const FIELD_T = 0;
const FIELD_S = 1;
const FIELD_LATERAL = 2;
const FIELD_SPEED = 3;
const FIELD_HALF_WIDTH = 4;
const FIELD_TARGET_SPEED = 5;
const FIELD_TOTAL_DISTANCE = 6;
const FIELD_STEER = 7;
const FIELD_OFF_TRACK = 8;
const FIELD_LAP = 9;
const FIELD_POSITION = 10;
const FIELD_IN_PIT = 11;

/** Contacts below this are a rub. `RaceEngine` uses the same number for damage. */
export const JUDGED_SEVERITY = 0.35;

/** Seconds from the contact to "UNDER INVESTIGATION". */
const NOTE_TO_INVESTIGATION_S = 6;
/** Seconds from there to the decision. About a lap, all told. */
const INVESTIGATION_MIN_S = 34;
const INVESTIGATION_MAX_S = 62;

/**
 * How clear the corner-priority test has to be, in metres, before it decides
 * anything. Inside this band the cars were level and it is a racing incident.
 */
const CLEAR_PRIORITY_M = 0.5;

/**
 * How much more than the other car one of them has to have moved across, in
 * metres, before the closing is attributed to it.
 *
 * This is the guard that stops a car being penalised for holding its line.
 * Contact requires two cars to arrive in the same place; the offence is causing
 * that, and causing it means having been the one that moved.
 */
const CLEAR_CONVERGENCE_M = 0.25;

/** Over how long the convergence is measured, seconds. */
const CONVERGENCE_WINDOW_S = 0.7;

/**
 * Lateral separation below which the two cars were on the same line, metres.
 *
 * Below this there is no inside and no outside, so DSG Points A and B have
 * nothing to say and the contact falls through to the following-car test.
 *
 * MEASURED, AND IT USED TO BE FAR TOO WIDE. At 0.9m this was quietly throwing
 * away most of the corner contacts in a race. Over a calendar, thirty-eight
 * incidents ended in no further action and twenty-four of them died in the
 * following-car test having never reached a guideline at all — "not on the same
 * line" fourteen times and "side by side, no corner to own" ten — against ONE
 * that reached the corner-priority test and was declined on its own margin. The
 * bench was not being careful; it was not looking.
 *
 * Two cars actually in contact are at most about two metres apart across the
 * road and are usually much less, and a car half a metre up the inside on the
 * way into a corner is exactly what Points A and B are about. There is no
 * minimum lateral separation anywhere in the guidelines, and there should not
 * be one here either beyond the width needed for "inside" to mean anything.
 * Forty centimetres is a fifth of a car.
 *
 * Widening the door does not make the bench freer with penalties, because it is
 * not the door that decides: `CLEAR_PRIORITY_M` and `CLEAR_CONVERGENCE_M` still
 * have to be cleared, and a case that cannot clear them comes out as a racing
 * incident WITH A STATED REASON instead of as a shrug about a straight.
 */
const SAME_LINE_M = 0.4;

/** Longitudinal separation at corner entry beyond which they were not fighting. */
const ENGAGED_GAP_M = 14;

/** A contact with this many cars near it in this many seconds is a pile-up. */
const CROWD_RADIUS_M = 60;
const CROWD_WINDOW_S = 2.5;
const CROWD_CARS = 3;

/** Clear-cut following-car collision: gap, speed excess, lateral separation. */
const REAR_END_GAP_M = 3.0;
const REAR_END_CLOSING_MS = 3.0;
const REAR_END_LATERAL_M = 1.2;
/**
 * Above this deceleration the car in front was doing something abnormal, so the
 * car behind running into it is not straightforwardly the car behind's fault.
 * A 2026 F1 car brakes at about 50 m/s^2; 40 is a heavy but ordinary stop.
 */
const REAR_END_LEAD_DECEL_MS2 = 40;

/**
 * How far over the corner's reference speed a car has to arrive at the apex
 * before DSG Point A(ii)'s "dived in" is taken to be made out.
 *
 * A quarter over. `TrackSpline.targetSpeed` is the speed the solver thinks the
 * corner is worth for a lap time, not the speed at which the car leaves the
 * road, and a driver committing to a move genuinely does carry more than that
 * in. Setting it tight would make every overtaking attempt a dive.
 */
const DIVE_IN_OVERSPEED = 1.25;

/**
 * How long after a contact the stewards look at what it did, seconds.
 *
 * See `Evidence.consequenceA`.
 */
const AFTERMATH_S = 2.5;
/**
 * How far a car's pace has to fall away, as a fraction of what the road is
 * worth, before the contact is taken to have cost it something.
 *
 * MEASURED AS A RATIO TO THE REFERENCE SPEED, and both of the obvious
 * alternatives are wrong in opposite directions:
 *
 *   Against the car's own speed at the moment of contact. A car hit at 80 m/s
 *   on a straight and braking normally for the next corner is thirty metres a
 *   second slower a second later, and none of that is the contact. It finds a
 *   consequence in every hit before a braking zone.
 *
 *   Against the reference speed alone — "is it under 72% of what this corner is
 *   worth". Cars in traffic, on worn tyres, or simply off the ideal line run
 *   under that all the time, so it finds a consequence in almost everything.
 *
 * The ratio removes the road from the question and leaves the car. A driver who
 * was taking the corner at 95% of the reference and is taking it at 70% two
 * seconds later has lost something; one who is at 95% before and after has not,
 * whatever the two absolute speeds were.
 */
const CONSEQUENCE_PACE_DROP = 0.18;

/** Lateral movement toward the other car that counts as crowding, metres. */
const SQUEEZE_MOVE_M = 0.35;
/** Over how long, seconds. */
const SQUEEZE_WINDOW_S = 0.9;
/** How long a squeeze stays live waiting for its consequence, seconds. */
const SQUEEZE_CONSEQUENCE_S = 1.6;

/** An excursion longer than this was an accident, not a shortcut. */
const EXCURSION_MAX_S = 6;
/** Below this fraction of the reference speed on re-join, the car lost time. */
const EXCURSION_KEPT_PACE = 0.8;
/** How far away a rival can be and still be the one the place was taken from. */
const RIVAL_RANGE_M = 60;
/**
 * How close a pursuing car has to be for the car ahead to count as DEFENDING,
 * in seconds. DSG Point F's defending case is at the stewards' "sole
 * discretion"; this is the narrowest reading of it.
 */
const DEFENDING_GAP_S = 1.0;

/** Ceilings, so one bad lap cannot flood the feed. */
const MAX_OPEN_INCIDENTS = 6;
const MAX_INCIDENTS_PER_RACE = 40;
/** One incident per car per this many seconds. */
const PER_CAR_COOLDOWN_S = 8;

// ===========================================================================
// What the stewards hand back
// ===========================================================================

/** The four fields race control words an incident with. Mirrors `RaceNotice`. */
export interface StewardsNotice {
  parties: string[];
  where: string;
  offence: string;
  status: string;
}

/**
 * Everything the stewards need from the outside world.
 *
 * Deliberately tiny, and deliberately not `RaceControlManager` itself: the
 * decision-making has to be runnable from a probe with a stub on the other end,
 * and a module that reaches into race control cannot be.
 */
export interface StewardsWire {
  /** Files a bulletin. `carIndex` must be the car it concerns, never -1, or the
   * HUD cannot render it as a decision. */
  file(
    text: string,
    severity: 'info' | 'warning' | 'critical',
    time: number,
    carIndex: number,
    notice: StewardsNotice,
  ): void;
  /** Applies a time penalty to a car and announces it. */
  penalise(car: CarEntry, seconds: 5 | 10, offence: Offence, where: string, time: number): void;
}

/** A decision, in the form the rest of the game consumes it. */
export interface Verdict {
  kind: VerdictKind;
  /** Named only when `kind` is not `no-further-action`. */
  offence: Offence | null;
  /** The car the verdict is against, or -1 for a racing incident. */
  againstIndex: number;
  /** The car wronged, or -1. */
  victimIndex: number;
  /** Free text for the log — why, in the stewards' terms. */
  because: string;
}

/**
 * No further action, with the reason stated.
 *
 * Every one of these is a place a decision was declined, and the reason is worth
 * as much as the verdict: it is what the probe reads when a staged case comes
 * out the wrong way, and it is the difference between a bench that found nothing
 * and a bench that never looked.
 */
function nfa(because: string): Verdict {
  return {
    kind: 'no-further-action', offence: null,
    againstIndex: -1, victimIndex: -1, because,
  };
}

// ===========================================================================
// Corner geometry
// ===========================================================================

/**
 * A corner with an entry, an apex and an exit — which is what DSG Points A and
 * B need and what `TrackDefinition` does not carry.
 *
 * `CornerMarker` is `{ s, name }` and nothing else, but the `s` in it is not
 * arbitrary: `SegmentBuilder` writes `segStartS + arcLen * 0.5`, the MIDPOINT of
 * the corner's arc, which for a constant-radius corner is the apex. So the apex
 * is already in the data and only the extents have to be found, which the
 * curvature gives up directly.
 */
export interface CornerFrame {
  name: string;
  apexS: number;
  entryS: number;
  exitS: number;
  hand: CornerHand;
  peakCurvature: number;
}

/**
 * WHY THE BRAKING ZONE IS NOT PART OF THE CORNER HERE, having been tried.
 *
 * The corner window runs from where the curvature comes up, thirty or forty
 * metres before the apex. Most racing contact happens earlier than that, under
 * braking, so most of it falls through to the following-car test and is declined
 * with a reason about straights. That looks exactly like an oversight, and DSG
 * Point A(i) appears to license the fix: the front axle must be alongside the
 * mirror "PRIOR TO AND AT THE APEX", which plainly includes the approach.
 *
 * Extending the window a hundred metres back was tried and reverted. Measured
 * over four circuits it took the bench from four penalties to eight, from one a
 * race to two, and — the number that condemned it — from a majority of
 * incidents ending in no further action to a majority ending in a penalty.
 *
 * The reason is not that the threshold was wrong. It is that the TEST does not
 * apply there. Points A and B are evaluated AT THE APEX because that is the
 * moment the question is settled; a car three metres behind at the braking point
 * is not diving in, it may be perfectly placed by the apex, and it has not yet
 * done anything the guidelines have an opinion about. When the contact happens
 * before either car reaches the apex there is no apex evidence, and applying the
 * at-the-apex geometry to the braking point produces a confident answer to a
 * question the geometry was never asked.
 *
 * Real stewards do penalise braking-zone collisions constantly, and they do it
 * on Point A(ii) and A(iii) — was the move controlled, was it ever going to make
 * the corner — which is the subjective half this module declines to model at
 * all. So the honest state is the one that ships: those contacts are declined,
 * with a stated reason, and this comment is here so the next person to notice
 * the gap knows it was measured rather than missed.
 */

/** Below this the "corner" is a flat-out kink and has no meaningful apex. */
const MIN_CORNER_CURVATURE = 1 / 600;
/** Where the corner is deemed to begin and end, as a fraction of its peak. */
const CORNER_EDGE_FRACTION = 0.35;
const CORNER_SEARCH_M = 40;
const CORNER_MAX_EXTENT_M = 220;
const CORNER_MIN_EXTENT_M = 25;

/**
 * Turns the circuit's corner markers into judgeable corners.
 *
 * Runs once per track and is pure, so a probe can build one and assert on it
 * without an engine.
 */
export function buildCornerTable(track: TrackSpline): CornerFrame[] {
  const markers = track.def.corners;
  if (!markers || markers.length === 0) return [];
  const len = track.length;
  const out: CornerFrame[] = [];

  for (const marker of markers) {
    // The apex the data gives us is the arc midpoint. Refine it to the local
    // peak of curvature, which is the same point on a constant-radius corner
    // and the right point on one that tightens.
    let peakIdx = track.indexAt(marker.s);
    let peak = Math.abs(track.curvature[peakIdx]);
    const step = len / track.count;
    const span = Math.max(1, Math.round(CORNER_SEARCH_M / step));
    for (let d = -span; d <= span; d++) {
      const i = (peakIdx + d + track.count) % track.count;
      const k = Math.abs(track.curvature[i]);
      if (k > peak) { peak = k; peakIdx = i; }
    }
    if (peak < MIN_CORNER_CURVATURE) continue;

    const hand: CornerHand = track.curvature[peakIdx] >= 0 ? 1 : -1;
    const edge = peak * CORNER_EDGE_FRACTION;
    const maxSteps = Math.round(CORNER_MAX_EXTENT_M / step);
    const minSteps = Math.round(CORNER_MIN_EXTENT_M / step);

    let back = 0;
    while (back < maxSteps) {
      const i = (peakIdx - back - 1 + track.count) % track.count;
      if (Math.abs(track.curvature[i]) < edge && back >= minSteps) break;
      back++;
    }
    let fwd = 0;
    while (fwd < maxSteps) {
      const i = (peakIdx + fwd + 1) % track.count;
      if (Math.abs(track.curvature[i]) < edge && fwd >= minSteps) break;
      fwd++;
    }

    const apexS = track.dist[peakIdx];
    out.push({
      name: marker.name,
      apexS,
      entryS: (apexS - back * step + len) % len,
      exitS: (apexS + fwd * step) % len,
      hand,
      peakCurvature: peak,
    });
  }
  return out;
}

/** The corner a point on the lap belongs to, or null on a straight. */
export function cornerAt(corners: readonly CornerFrame[], s: number, len: number): CornerFrame | null {
  for (const c of corners) {
    // Distance from entry to exit going forwards, and from entry to s going
    // forwards. Inside the corner iff the second is no more than the first.
    const span = (c.exitS - c.entryS + len) % len;
    const into = (s - c.entryS + len) % len;
    if (into <= span) return c;
  }
  return null;
}

// ===========================================================================
// The evidence
// ===========================================================================

/** One car at one instant, as the stewards read it. */
export interface Snapshot extends RacingCar {
  t: number;
  speedMs: number;
  halfWidthM: number;
  targetSpeedMs: number;
  totalDistance: number;
  steer: number;
  lap: number;
  position: number;
  inPitLane: boolean;
}

/** A car's speed as a fraction of what the road it is on is worth. */
function paceOf(s: Snapshot): number {
  return s.targetSpeedMs > 1 ? s.speedMs / s.targetSpeedMs : 1;
}

function blankSnapshot(): Snapshot {
  return {
    t: 0, s: 0, lateral: 0, speedMs: 0, halfWidthM: 0, targetSpeedMs: 0,
    totalDistance: 0, steer: 0, lap: 0, position: 0,
    cogToFrontM: 1.98, offTrack: false, inPitLane: false,
  };
}

/**
 * A few seconds of the whole field, at 20 Hz, in one flat buffer.
 *
 * The engine already queues impacts, but an impact is an instant and a corner is
 * a manoeuvre: the tests in `DrivingStandards` are evaluated AT THE APEX, which
 * for a contact on the exit was two seconds ago. So the window is recorded
 * continuously and the incident reaches back into it, rather than the incident
 * trying to capture state at the moment it fires.
 *
 * Flat `Float32Array`, one write per car per sample, no allocation. Twenty-two
 * cars at 20 Hz for eight seconds is 42k floats — 170 kB, once, for the session.
 */
export class IncidentRecorder {
  private readonly buf: Float32Array;
  private readonly cars: number;
  /** Next slot to write. Shared: every car is sampled in the same pass. */
  private head = 0;
  private filled = 0;
  private nextSampleAt = -1;
  private readonly cogToFront: Float32Array;

  constructor(carCount: number) {
    this.cars = carCount;
    this.buf = new Float32Array(carCount * SAMPLE_CAP * STRIDE);
    this.cogToFront = new Float32Array(carCount);
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.nextSampleAt = -1;
  }

  /**
   * Records the field, if a sample is due. Call every physics step.
   *
   * Returns true on the steps it actually recorded, which is what lets the
   * pair-scanning above run at the recorder's rate rather than at 120Hz.
   */
  sample(cars: readonly CarEntry[], track: TrackSpline, sessionTime: number): boolean {
    if (sessionTime < this.nextSampleAt) return false;
    this.nextSampleAt = sessionTime + 1 / SAMPLE_HZ;

    const slot = this.head;
    for (let i = 0; i < this.cars && i < cars.length; i++) {
      const car = cars[i];
      const base = (i * SAMPLE_CAP + slot) * STRIDE;
      const b = this.buf;
      b[base + FIELD_T] = sessionTime;
      b[base + FIELD_S] = car.s;
      b[base + FIELD_LATERAL] = car.lateral;
      b[base + FIELD_SPEED] = car.physics.speedMs;
      b[base + FIELD_HALF_WIDTH] = track.halfWidthAt(car.s);
      b[base + FIELD_TARGET_SPEED] = track.targetSpeed[track.indexAt(car.s)];
      b[base + FIELD_TOTAL_DISTANCE] = car.totalDistance;
      b[base + FIELD_STEER] = car.appliedControls.steer;
      b[base + FIELD_OFF_TRACK] = car.offTrackNow ? 1 : 0;
      b[base + FIELD_LAP] = car.lap;
      b[base + FIELD_POSITION] = car.position;
      b[base + FIELD_IN_PIT] = car.inPitLane ? 1 : 0;
      this.cogToFront[i] = car.physics.spec.cogToFrontM;
    }
    this.head = (this.head + 1) % SAMPLE_CAP;
    if (this.filled < SAMPLE_CAP) this.filled++;
    return true;
  }

  /** How many samples are held. */
  get depth(): number {
    return this.filled;
  }

  private slotAge(age: number): number {
    return (this.head - 1 - age + SAMPLE_CAP * 2) % SAMPLE_CAP;
  }

  private readSlot(carIndex: number, slot: number, out: Snapshot): void {
    const base = (carIndex * SAMPLE_CAP + slot) * STRIDE;
    const b = this.buf;
    out.t = b[base + FIELD_T];
    out.s = b[base + FIELD_S];
    out.lateral = b[base + FIELD_LATERAL];
    out.speedMs = b[base + FIELD_SPEED];
    out.halfWidthM = b[base + FIELD_HALF_WIDTH];
    out.targetSpeedMs = b[base + FIELD_TARGET_SPEED];
    out.totalDistance = b[base + FIELD_TOTAL_DISTANCE];
    out.steer = b[base + FIELD_STEER];
    out.offTrack = b[base + FIELD_OFF_TRACK] > 0.5;
    out.lap = b[base + FIELD_LAP];
    out.position = b[base + FIELD_POSITION];
    out.inPitLane = b[base + FIELD_IN_PIT] > 0.5;
    out.cogToFrontM = this.cogToFront[carIndex];
  }

  /**
   * The newest sample at or before `t`. False when the window does not reach.
   *
   * Constant time, not a scan. It is called from the pair loop that looks for a
   * car being crowded toward an edge, which is O(cars squared) to begin with; a
   * linear walk through a hundred and sixty samples inside that is twenty cars
   * times twenty cars times a hundred and sixty, twenty times a second, for an
   * answer that simple arithmetic gives directly. The samples are evenly spaced
   * in time by construction, so the age of the one wanted is just the elapsed
   * time over the sample interval — the short correction loops afterwards exist
   * only to absorb the rounding.
   */
  read(carIndex: number, t: number, out: Snapshot): boolean {
    if (this.filled === 0) return false;
    const newest = this.buf[(carIndex * SAMPLE_CAP + this.slotAge(0)) * STRIDE + FIELD_T];
    let age = Math.floor((newest - t) * SAMPLE_HZ);
    if (age < 0) age = 0;
    if (age >= this.filled) age = this.filled - 1;
    const stampAt = (a: number): number =>
      this.buf[(carIndex * SAMPLE_CAP + this.slotAge(a)) * STRIDE + FIELD_T];
    // Too new: walk back until the sample is at or before `t`.
    while (age < this.filled - 1 && stampAt(age) > t + 1e-6) age++;
    // Too old: walk forward while the next one is still not after `t`.
    while (age > 0 && stampAt(age - 1) <= t + 1e-6) age--;
    if (stampAt(age) > t + 1e-6) return false;
    this.readSlot(carIndex, this.slotAge(age), out);
    return true;
  }

  /**
   * The sample at which this car's origin last reached `targetS`, searching back
   * from `notAfterT`.
   *
   * This is how "at the apex" becomes a moment in time: the two cars cross the
   * apex at different instants, and the test is evaluated at the first of them.
   * Returns false if the car had not reached that point inside the window, which
   * is the "contact happened on the way in" case.
   */
  readAtS(
    carIndex: number, targetS: number, notAfterT: number, trackLength: number, out: Snapshot,
  ): boolean {
    let found = -1;
    for (let age = 0; age < this.filled; age++) {
      const slot = this.slotAge(age);
      const base = (carIndex * SAMPLE_CAP + slot) * STRIDE;
      if (this.buf[base + FIELD_T] > notAfterT + 1e-6) continue;
      // Ahead of the target still: keep walking back.
      if (loopDelta(this.buf[base + FIELD_S], targetS, trackLength) <= 0) {
        found = slot;
        continue;
      }
      // First sample BEFORE the target. The one after it is the crossing.
      break;
    }
    if (found < 0) return false;
    this.readSlot(carIndex, found, out);
    return true;
  }
}

// ===========================================================================
// The bench
// ===========================================================================

type IncidentKind = 'contact' | 'forced-off' | 'off-track-advantage';

/**
 * The frozen file on an incident.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT, which is worth stating because it is
 * invisible until you look for it: the recorder holds eight seconds and a
 * verdict arrives the better part of a minute later. Judging from the recorder
 * at verdict time therefore judges from a window that has already scrolled past
 * the incident, and every case comes back "no evidence held" — which looks
 * exactly like a bench that has decided there was nothing in it.
 *
 * So the evidence is taken WHEN THE INCIDENT HAPPENS and the decision is taken
 * later, from the file. That is also how it works: the stewards do not re-watch
 * a live feed an hour afterwards, they look at the footage and the telemetry
 * somebody pulled at the time.
 */
interface Evidence {
  /** Null when the contact was not in a corner at all. */
  corner: CornerFrame | null;
  /** False when the window did not reach far enough back to gather anything. */
  ok: boolean;
  missing: string;
  /** Several cars touching in the same place at the same time. */
  pileUp: boolean;
  /** Both cars at the moment of the incident. */
  contactA: Snapshot;
  contactB: Snapshot;
  /** Both cars at the first of the pair's apex crossings. */
  apexA: Snapshot;
  apexB: Snapshot;
  /** Both cars at the first of the pair's corner-entry crossings. */
  entryA: Snapshot;
  entryB: Snapshot;
  /** Both cars `CONVERGENCE_WINDOW_S` before the contact. */
  beforeA: Snapshot;
  beforeB: Snapshot;
  /** The car in front's deceleration over the half-second before contact. */
  leadDecelMs2: number;
  /**
   * Did the contact actually do anything to each car?
   *
   * Filled `AFTERMATH_S` after the incident, not at it, because the answer is
   * not available at the moment of the hit.
   *
   * THIS IS THE DIFFERENCE BETWEEN A COLLISION AND A RUB, and it is how the
   * offence is really applied. Appendix L Art. 2(d) is "causing a collision",
   * and two cars touching wheels through a corner and carrying on is not one:
   * the stewards note it and take no further action. What earns a penalty is a
   * contact that put somebody off the road, cost them a place, spun them, or
   * ended their race. Without this test the rule fires on every wheel-to-wheel
   * rub in a twenty-car field, which is several a lap.
   */
  consequenceA: boolean;
  consequenceB: boolean;
  /** The measurements behind those two, kept so a verdict can state them. */
  paceDropA: number;
  paceDropB: number;
  wentOffA: boolean;
  wentOffB: boolean;
  aftermathDone: boolean;
}

interface OpenIncident {
  kind: IncidentKind;
  /** The car whose conduct is in question first. */
  aIndex: number;
  bIndex: number;
  time: number;
  lap: number;
  where: string;
  severity: number;
  investigateAt: number;
  verdictAt: number;
  investigated: boolean;
  /** For an off-track case: who the place was taken from. */
  victimIndex: number;
  /** Taken at `time`, judged at `verdictAt`. */
  ev: Evidence;
}

/** Live watch on a car being crowded toward an edge. */
interface SqueezeWatch {
  by: number;
  at: number;
  roomM: number;
}

/** Live watch on a car that is currently off the road. */
interface Excursion {
  leftAt: number;
  /** Immediately ahead when it left, and by how much. */
  aheadIndex: number;
  aheadDistance: number;
  /** Immediately behind when it left, and by how much. */
  behindIndex: number;
  behindDistance: number;
}

/**
 * How long this particular incident takes to decide, in seconds.
 *
 * Deliberately NOT drawn from a random number generator. `RaceControlManager`'s
 * generator is the one that decides when a safety car comes out and how long a
 * recovery takes, and a bench that draws from it would change the outcome of
 * every neutralisation in the race by the mere fact of having noticed a contact
 * — which is a race that cannot be replayed from its seed. A hash of the
 * incident gives the same spread, varies between incidents in the same race,
 * and consumes nothing.
 */
function deliberationS(aIndex: number, bIndex: number, lap: number, nth: number): number {
  let h = (aIndex * 73856093) ^ (bIndex * 19349663) ^ (lap * 83492791) ^ (nth * 2654435761);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  const frac = ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  return INVESTIGATION_MIN_S + frac * (INVESTIGATION_MAX_S - INVESTIGATION_MIN_S);
}

export class Stewards {
  private readonly track: TrackSpline;
  private readonly wire: StewardsWire;
  private readonly corners: CornerFrame[];
  readonly recorder: IncidentRecorder;

  private readonly open: OpenIncident[] = [];
  private readonly pending: { a: number; b: number; severity: number; time: number }[] = [];
  private readonly squeeze: (SqueezeWatch | null)[] = [];
  private readonly excursion: (Excursion | null)[] = [];
  private readonly wasOff: boolean[] = [];
  private readonly lastIncidentAt: number[] = [];
  /** Contacts in the recent past, for the pile-up test. */
  private readonly recentContacts: { s: number; time: number; a: number; b: number }[] = [];

  /**
   * Every decision this session, oldest first.
   *
   * The COMPLETE record, including the penalties that are not the outcome of an
   * investigation — a driver who ignored an instruction to hand a place back is
   * penalised by the remedy loop rather than by the bench, and leaving that out
   * of the ledger would make any count of "penalties this season" wrong in the
   * one direction that matters, since ignoring an instruction is the offence a
   * human player is most likely to commit.
   */
  readonly verdicts:
    (Verdict & { time: number; lap: number; where: string; incident: IncidentKind })[] = [];
  /** How many incidents have been noted this session. */
  noted = 0;

  /**
   * Every contact reported, counted by severity in tenths. Diagnostic.
   *
   * Two of the numbers in this file are calibrated rather than regulated —
   * `JUDGED_SEVERITY` and `CONSEQUENCE_PACE_DROP` — and a calibrated number is
   * exactly the thing that goes stale when the world underneath it changes. It
   * has already happened once: a rebuilt car, a rewritten weather model and a
   * fix to which cars are collidable at all moved the penalty rate by a factor
   * of seven without a line of this file changing. So the means to re-derive
   * them ships with them. `npm run probe:stewards` prints both distributions.
   */
  readonly severityBands = new Int32Array(10);
  /** The worst pace drop measured on a car that was hit, in hundredths. */
  readonly paceDropBands = new Int32Array(10);

  /** Scratch for the evidence gatherer. Nothing else may hold on to these. */
  private readonly scratchA = blankSnapshot();
  private readonly scratchB = blankSnapshot();

  constructor(track: TrackSpline, carCount: number, wire: StewardsWire) {
    this.track = track;
    this.wire = wire;
    this.corners = buildCornerTable(track);
    this.recorder = new IncidentRecorder(carCount);
    for (let i = 0; i < carCount; i++) {
      this.squeeze.push(null);
      this.excursion.push(null);
      this.wasOff.push(false);
      this.lastIncidentAt.push(-Infinity);
    }
  }

  reset(): void {
    this.open.length = 0;
    this.pending.length = 0;
    this.recentContacts.length = 0;
    this.verdicts.length = 0;
    this.noted = 0;
    this.recorder.reset();
    this.severityBands.fill(0);
    this.paceDropBands.fill(0);
    for (let i = 0; i < this.squeeze.length; i++) {
      this.squeeze[i] = null;
      this.excursion[i] = null;
      this.wasOff[i] = false;
      this.lastIncidentAt[i] = -Infinity;
    }
  }

  /** The corners this circuit was judged to have. For probes. */
  get cornerTable(): readonly CornerFrame[] {
    return this.corners;
  }

  /**
   * Reports a contact.
   *
   * Called from `RaceEngine.resolveContacts` at the moment of the hit, with the
   * severity it already computes. Nothing is judged here; the incident is queued
   * and picked up by `update` in the same physics step, by which time the
   * recorder has the contact instant in its window.
   */
  reportContact(a: CarEntry, b: CarEntry, severity: number, time: number): void {
    const band = Math.min(9, Math.max(0, Math.floor(severity * 10)));
    this.severityBands[band]++;
    if (severity < JUDGED_SEVERITY) return;
    if (this.pending.length >= 16) return;
    this.pending.push({ a: a.index, b: b.index, severity, time });
  }

  /**
   * One step of the bench.
   *
   * Runs after `resolveContacts` and after race control's own per-car checks, so
   * `offTrackNow` is current and this step's contacts are already queued.
   */
  update(
    cars: readonly CarEntry[], sessionTime: number, isRace: boolean, neutralised: boolean,
  ): void {
    // Only a race gets a VERDICT. Art. B1.9.4 is the whole of what the stewards
    // may do about an incident in a Lap Time Classified Session — delete a lap
    // time, or drop the driver grid positions — and neither is a verdict about
    // racing room. The guidelines apply in qualifying; the machinery in this
    // file does not.
    //
    // The NOTE still goes out, because it always did: race control announcing a
    // contact in Q1 is not a stewards' decision, it is race control saying it
    // saw something. Losing that when the bulletin moved out of the contact
    // solver would have been a silent regression in three session types.
    if (!isRace) {
      this.noteOnly(cars, sessionTime);
      return;
    }

    // The crowding scan is O(cars squared) and it can only see as far back as
    // the recorder, so there is nothing to be gained from running it more often
    // than the recorder samples.
    const sampled = this.recorder.sample(cars, this.track, sessionTime);
    this.trimRecentContacts(sessionTime);
    if (sampled) this.scanForCrowding(cars, sessionTime);
    this.scanForExcursions(cars, sessionTime);
    this.drainContacts(cars, sessionTime, neutralised);
    this.deliberate(cars, sessionTime);
    this.runCedeLoop(cars, sessionTime);
  }

  /** Announces contacts without judging them. Practice and qualifying. */
  private noteOnly(cars: readonly CarEntry[], now: number): void {
    for (const c of this.pending) {
      const a = cars[c.a];
      const b = cars[c.b];
      if (now - this.lastIncidentAt[c.a] < PER_CAR_COOLDOWN_S) continue;
      this.lastIncidentAt[c.a] = now;
      this.lastIncidentAt[c.b] = now;
      this.noted++;
      this.wire.file(
        'Contact between ' + a.driver.code + ' and ' + b.driver.code,
        'warning', now, c.a,
        {
          parties: [a.driver.code, b.driver.code],
          where: (this.track.cornerNameAt(a.s) || '').toUpperCase(),
          offence: 'CONTACT', status: 'NOTED',
        },
      );
    }
    this.pending.length = 0;
  }

  // -------------------------------------------------------------------------
  // Gathering
  // -------------------------------------------------------------------------

  private trimRecentContacts(now: number): void {
    while (this.recentContacts.length > 0 && now - this.recentContacts[0].time > CROWD_WINDOW_S) {
      this.recentContacts.shift();
    }
  }

  /**
   * Watches for a car being run out of road.
   *
   * Appendix L Ch. IV Art. 2(b) needs three things at once: a car alongside, less
   * than one car's width of track left for it, and the other car MOVING into
   * that space. The third is what separates the offence from a driver who simply
   * ran out of talent on the outside of a corner, and it is the reason this
   * cannot be a geometry test alone.
   *
   * Nothing is decided here. A live watch is armed, and it becomes an incident
   * only if the car actually goes off or is hit within `SQUEEZE_CONSEQUENCE_S`.
   */
  private scanForCrowding(cars: readonly CarEntry[], now: number): void {
    const len = this.track.length;
    for (let i = 0; i < cars.length; i++) {
      const w = this.squeeze[i];
      if (w && now - w.at > SQUEEZE_CONSEQUENCE_S) this.squeeze[i] = null;
    }

    for (let i = 0; i < cars.length; i++) {
      const victim = cars[i];
      if (victim.retired || victim.inPitLane) continue;
      for (let j = 0; j < cars.length; j++) {
        if (j === i) continue;
        const other = cars[j];
        if (other.retired || other.inPitLane) continue;

        // Alongside: the victim's origin no more than three metres behind the
        // other's, and no more than a car length ahead. Outside that the victim
        // is not in a space the other car is obliged to leave.
        const along = loopDelta(other.s, victim.s, len);
        if (along < -3.0 || along > 5.6) continue;

        const dLat = victim.lateral - other.lateral;
        if (Math.abs(dLat) < SAME_LINE_M || Math.abs(dLat) > 4.2) continue;
        const towardSide: 1 | -1 = dLat > 0 ? 1 : -1;

        const halfWidth = this.track.halfWidthAt(other.s);
        const room = racingRoomM(other.lateral, halfWidth, towardSide);
        if (room >= CAR_WIDTH_M) continue;

        // ...and the other car has to have moved INTO it. A car that was always
        // there did not crowd anyone.
        if (!this.recorder.read(j, now - SQUEEZE_WINDOW_S, this.scratchA)) continue;
        const moved = (other.lateral - this.scratchA.lateral) * towardSide;
        if (moved < SQUEEZE_MOVE_M) continue;

        this.squeeze[i] = { by: j, at: now, roomM: room };
      }
    }
  }

  /**
   * Watches for a car leaving the track and coming back in front.
   *
   * Art. B1.8.6: "Should a Car leave the track the driver may re-join, however,
   * this may only be done when it is safe to do so and without gaining any
   * lasting advantage. At the absolute discretion of the Race Director a driver
   * may be given the opportunity to give back the whole of any advantage he
   * gained by leaving the track."
   *
   * `offTrackNow` is `RaceControlManager`'s own four-contact-patch test, so the
   * definition of "left the track" here and the one track limits are judged on
   * are literally the same measurement.
   */
  private scanForExcursions(cars: readonly CarEntry[], now: number): void {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const off = car.offTrackNow && !car.inPitLane && !car.retired;

      if (off && !this.wasOff[i]) {
        // Just left. Record who was immediately ahead and immediately behind,
        // because those are the only two cars an advantage can be taken from.
        let aheadIndex = -1, aheadDistance = Infinity;
        let behindIndex = -1, behindDistance = Infinity;
        for (let j = 0; j < cars.length; j++) {
          if (j === i) continue;
          const o = cars[j];
          if (o.retired || o.inPitLane) continue;
          const gap = o.totalDistance - car.totalDistance;
          if (gap > 0 && gap < aheadDistance && gap < RIVAL_RANGE_M) {
            aheadIndex = j; aheadDistance = gap;
          } else if (gap < 0 && -gap < behindDistance && -gap < RIVAL_RANGE_M) {
            behindIndex = j; behindDistance = -gap;
          }
        }
        this.excursion[i] = {
          leftAt: now, aheadIndex, aheadDistance, behindIndex, behindDistance,
        };
      } else if (!off && this.wasOff[i]) {
        this.settleExcursion(cars, i, now);
        this.excursion[i] = null;
      }
      this.wasOff[i] = off;
    }
  }

  private settleExcursion(cars: readonly CarEntry[], i: number, now: number): void {
    const ex = this.excursion[i];
    if (!ex) return;
    const car = cars[i];
    if (car.retired || car.inPitLane) return;
    // A long excursion is an accident. The advantage rule is about a shortcut.
    if (now - ex.leftAt > EXCURSION_MAX_S) return;
    // A car that lost time gained nothing, which is the same test race control
    // already applies before counting a track-limits strike.
    const target = this.track.targetSpeed[this.track.indexAt(car.s)];
    if (car.physics.speedMs < target * EXCURSION_KEPT_PACE) return;

    // The plain case: behind that car when it left the road, ahead of it now.
    if (ex.aheadIndex >= 0) {
      const rival = cars[ex.aheadIndex];
      if (!rival.retired && !rival.inPitLane && car.totalDistance > rival.totalDistance) {
        this.openIncident({
          kind: 'off-track-advantage', aIndex: i, bIndex: ex.aheadIndex,
          victimIndex: ex.aheadIndex, severity: 0, now, cars,
        });
        return;
      }
    }

    // DSG Point F, the defending case: "If, while defending a position, a car
    // leaves the track (or cuts a chicane) and re-joins in the same position, it
    // will generally be considered by the stewards as having gained a lasting
    // advantage and therefore, generally, the position should be conceded."
    //
    // Whether a driver was "defending" is expressly the stewards' sole
    // discretion, so this takes the narrowest reading available: somebody was
    // close enough behind to be attacking, and is still behind.
    if (ex.behindIndex >= 0) {
      const chaser = cars[ex.behindIndex];
      const pace = Math.max(car.physics.speedMs, 30);
      if (!chaser.retired && !chaser.inPitLane &&
          ex.behindDistance < DEFENDING_GAP_S * pace &&
          car.totalDistance > chaser.totalDistance) {
        this.openIncident({
          kind: 'off-track-advantage', aIndex: i, bIndex: ex.behindIndex,
          victimIndex: ex.behindIndex, severity: 0, now, cars,
        });
      }
    }
  }

  private drainContacts(cars: readonly CarEntry[], now: number, neutralised: boolean): void {
    for (const c of this.pending) {
      this.recentContacts.push({ s: cars[c.a].s, time: c.time, a: c.a, b: c.b });
      const a = cars[c.a];
      const b = cars[c.b];
      // Never judged: a wreck lying in the road is not a driver, the pit lane
      // has its own rules, and a contact under a neutralisation is a different
      // offence (Art. B5.13/B5.12) that this module does not own.
      if (a.retired || b.retired || a.inPitLane || b.inPitLane || neutralised) continue;
      // A car being crowded off is a forced-off incident, not a corner-priority
      // one, whichever way round the contact was reported.
      const kind: IncidentKind =
        this.freshSqueezeOn(c.a, c.b, now) || this.freshSqueezeOn(c.b, c.a, now)
          ? 'forced-off' : 'contact';
      // For a forced-off case the victim is the crowded car, so put it second.
      const squeezedIsA = this.freshSqueezeOn(c.a, c.b, now);
      const aIndex = kind === 'forced-off' ? (squeezedIsA ? c.b : c.a) : c.a;
      const bIndex = kind === 'forced-off' ? (squeezedIsA ? c.a : c.b) : c.b;
      this.openIncident({
        kind, aIndex, bIndex, victimIndex: kind === 'forced-off' ? bIndex : -1,
        severity: c.severity, now, cars,
      });
    }
    this.pending.length = 0;

    // A car crowded clean off the road without ever being touched is the same
    // offence and has to be caught separately, because there is no contact to
    // report it.
    for (let i = 0; i < cars.length; i++) {
      const w = this.squeeze[i];
      if (!w) continue;
      if (!cars[i].offTrackNow) continue;
      this.squeeze[i] = null;
      if (neutralised) continue;
      this.openIncident({
        kind: 'forced-off', aIndex: w.by, bIndex: i, victimIndex: i,
        severity: 0, now, cars,
      });
    }
  }

  private freshSqueezeOn(victim: number, by: number, now: number): boolean {
    const w = this.squeeze[victim];
    return w !== null && w.by === by && now - w.at <= SQUEEZE_CONSEQUENCE_S;
  }

  private openIncident(p: {
    kind: IncidentKind; aIndex: number; bIndex: number; victimIndex: number;
    severity: number; now: number; cars: readonly CarEntry[];
  }): void {
    if (this.open.length >= MAX_OPEN_INCIDENTS) return;
    if (this.noted >= MAX_INCIDENTS_PER_RACE) return;
    if (p.now - this.lastIncidentAt[p.aIndex] < PER_CAR_COOLDOWN_S) return;
    if (p.now - this.lastIncidentAt[p.bIndex] < PER_CAR_COOLDOWN_S) return;
    for (const inc of this.open) {
      if ((inc.aIndex === p.aIndex && inc.bIndex === p.bIndex) ||
          (inc.aIndex === p.bIndex && inc.bIndex === p.aIndex)) return;
    }

    const cars = p.cars;
    const a = cars[p.aIndex];
    const b = cars[p.bIndex];
    const where = (this.track.cornerNameAt(a.s) || '').toUpperCase();
    const wait = deliberationS(p.aIndex, p.bIndex, a.lap, this.noted);

    this.lastIncidentAt[p.aIndex] = p.now;
    this.lastIncidentAt[p.bIndex] = p.now;
    this.noted++;
    this.open.push({
      kind: p.kind, aIndex: p.aIndex, bIndex: p.bIndex, time: p.now, lap: a.lap,
      where, severity: p.severity, victimIndex: p.victimIndex,
      investigateAt: p.now + NOTE_TO_INVESTIGATION_S,
      verdictAt: p.now + NOTE_TO_INVESTIGATION_S + wait,
      investigated: false,
      ev: this.gatherEvidence(p.aIndex, p.bIndex, p.now),
    });

    this.wire.file(
      'Contact between ' + a.driver.code + ' and ' + b.driver.code,
      'warning', p.now, p.aIndex,
      {
        parties: [a.driver.code, b.driver.code],
        where,
        offence: p.kind === 'off-track-advantage' ? 'LEAVING THE TRACK' : 'CONTACT',
        status: 'NOTED',
      },
    );
  }

  /**
   * Pulls the telemetry, now, while it still exists.
   *
   * Everything the three judgements need, read out of the ring buffer in one
   * pass and copied into plain objects. Nothing here decides anything — it is
   * all "where was each car when", and the same file supports whichever of the
   * tests turns out to apply.
   */
  private gatherEvidence(aIndex: number, bIndex: number, now: number): Evidence {
    const len = this.track.length;
    const ev: Evidence = {
      corner: null, ok: false, missing: 'no evidence held', pileUp: false,
      contactA: blankSnapshot(), contactB: blankSnapshot(),
      apexA: blankSnapshot(), apexB: blankSnapshot(),
      entryA: blankSnapshot(), entryB: blankSnapshot(),
      beforeA: blankSnapshot(), beforeB: blankSnapshot(),
      leadDecelMs2: 0,
      consequenceA: false, consequenceB: false, aftermathDone: false,
      paceDropA: 0, paceDropB: 0, wentOffA: false, wentOffB: false,
    };

    if (!this.recorder.read(aIndex, now, ev.contactA)) return ev;
    if (!this.recorder.read(bIndex, now, ev.contactB)) return ev;
    ev.ok = true;
    ev.missing = '';

    // Several cars touching in the same place at the same time. Evaluated here
    // because `recentContacts` is a live two-and-a-half second window and will
    // be empty by the time the verdict is due.
    const involved = new Set<number>([aIndex, bIndex]);
    for (const c of this.recentContacts) {
      if (Math.abs(c.time - now) > CROWD_WINDOW_S) continue;
      if (Math.abs(loopDelta(c.s, ev.contactA.s, len)) > CROWD_RADIUS_M) continue;
      involved.add(c.a);
      involved.add(c.b);
    }
    ev.pileUp = involved.size >= CROWD_CARS;

    // How hard the car in front was braking, for the following-car test.
    if (this.recorder.read(bIndex, now - 0.5, this.scratchA) &&
        now - this.scratchA.t > 0.05) {
      const gap = loopDelta(ev.contactA.s, ev.contactB.s, len);
      const leadIdx = gap > 0 ? bIndex : aIndex;
      const leadNow = gap > 0 ? ev.contactB : ev.contactA;
      if (this.recorder.read(leadIdx, now - 0.5, this.scratchA) &&
          now - this.scratchA.t > 0.05) {
        ev.leadDecelMs2 = (this.scratchA.speedMs - leadNow.speedMs) / (now - this.scratchA.t);
      }
    }

    // The convergence window.
    this.recorder.read(aIndex, now - CONVERGENCE_WINDOW_S, ev.beforeA);
    this.recorder.read(bIndex, now - CONVERGENCE_WINDOW_S, ev.beforeB);

    const corner = cornerAt(this.corners, ev.contactA.s, len);
    ev.corner = corner;
    if (!corner) return ev;

    // "AT THE APEX" as a moment: the first of the pair to reach it, not later
    // than the contact. If neither had reached it the contact was on the way in,
    // and the guidelines' "PRIOR TO AND AT THE APEX" is then evaluated at the
    // contact itself.
    let evalT = now;
    const gotA = this.recorder.readAtS(aIndex, corner.apexS, now, len, this.scratchA);
    const tApexA = this.scratchA.t;
    const gotB = this.recorder.readAtS(bIndex, corner.apexS, now, len, this.scratchB);
    const tApexB = this.scratchB.t;
    if (gotA && gotB) evalT = Math.min(tApexA, tApexB);
    else if (gotA) evalT = tApexA;
    else if (gotB) evalT = tApexB;
    this.recorder.read(aIndex, evalT, ev.apexA);
    this.recorder.read(bIndex, evalT, ev.apexB);

    // BOTH CARS READ AT THE SAME INSTANT, which is the whole trick. The obvious
    // implementation — ask the recorder where each car was when IT crossed the
    // entry — compares two different moments in time, and since both answers are
    // "at the entry line" it reports a gap of zero however far apart the cars
    // actually were. So the crossing is used only to fix a clock, and the pair
    // is then sampled off that one clock.
    let entryT = evalT - 1.0;
    const crossedA = this.recorder.readAtS(aIndex, corner.entryS, evalT, len, this.scratchA);
    const tEntryA = this.scratchA.t;
    const crossedB = this.recorder.readAtS(bIndex, corner.entryS, evalT, len, this.scratchB);
    const tEntryB = this.scratchB.t;
    if (crossedA && crossedB) entryT = Math.min(tEntryA, tEntryB);
    else if (crossedA) entryT = tEntryA;
    else if (crossedB) entryT = tEntryB;
    if (!this.recorder.read(aIndex, entryT, ev.entryA) ||
        !this.recorder.read(bIndex, entryT, ev.entryB)) {
      ev.ok = false;
      ev.missing = 'the corner entry is outside the recorded window';
    }
    return ev;
  }

  /**
   * Looks at what the contact did, a couple of seconds after it.
   *
   * Reads the recorder rather than the cars, so "went off at any point since"
   * is a real answer rather than a snapshot of this instant — a car that speared
   * across the gravel and rejoined has suffered the consequence even if it is
   * back on the road by the time anybody looks.
   */
  private takeAftermath(inc: OpenIncident, cars: readonly CarEntry[], now: number): void {
    const ev = inc.ev;
    ev.aftermathDone = true;
    if (!ev.ok) return;
    this.measureAftermath(inc.aIndex, ev.contactA, cars, inc.time, now, ev, 'A');
    this.measureAftermath(inc.bIndex, ev.contactB, cars, inc.time, now, ev, 'B');
    ev.consequenceA = ev.wentOffA || ev.paceDropA > CONSEQUENCE_PACE_DROP;
    ev.consequenceB = ev.wentOffB || ev.paceDropB > CONSEQUENCE_PACE_DROP;
    const dropA = Math.min(9, Math.max(0, Math.floor(ev.paceDropA * 100 / 5)));
    const dropB = Math.min(9, Math.max(0, Math.floor(ev.paceDropB * 100 / 5)));
    this.paceDropBands[dropA]++;
    this.paceDropBands[dropB]++;
  }

  /**
   * The worst thing that happened to one car in the seconds after the contact.
   *
   * Recorded as a magnitude rather than decided as a boolean, so that the
   * threshold above it can be re-derived from a season's distribution instead
   * of guessed again — and so a verdict of no further action can say by how
   * much it missed.
   */
  private measureAftermath(
    index: number, atContact: Snapshot, cars: readonly CarEntry[],
    from: number, now: number, ev: Evidence, which: 'A' | 'B',
  ): void {
    const car = cars[index];
    let off = car.retired;
    let worstDrop = car.retired ? 1 : 0;
    const paceBefore = paceOf(atContact);
    for (let t = from; t <= now + 1e-6; t += 1 / SAMPLE_HZ) {
      if (!this.recorder.read(index, t, this.scratchA)) continue;
      if (this.scratchA.t < from - 1e-6) continue;
      const s = this.scratchA;
      // Put off the road, or dropped a place: both are the whole answer on
      // their own, and neither is a matter of degree.
      if (s.offTrack || s.position > atContact.position) off = true;
      // Spun, or dragged down to a pace the road does not explain.
      const drop = paceBefore - paceOf(s);
      if (drop > worstDrop) worstDrop = drop;
    }
    if (which === 'A') { ev.wentOffA = off; ev.paceDropA = worstDrop; }
    else { ev.wentOffB = off; ev.paceDropB = worstDrop; }
  }

  // -------------------------------------------------------------------------
  // Deliberating
  // -------------------------------------------------------------------------

  private deliberate(cars: readonly CarEntry[], now: number): void {
    for (let k = this.open.length - 1; k >= 0; k--) {
      const inc = this.open[k];
      const a = cars[inc.aIndex];
      const b = cars[inc.bIndex];

      if (!inc.ev.aftermathDone && now >= inc.time + AFTERMATH_S) {
        this.takeAftermath(inc, cars, now);
      }

      if (!inc.investigated && now >= inc.investigateAt) {
        inc.investigated = true;
        this.wire.file(
          a.driver.code + ' / ' + b.driver.code + ' — under investigation',
          'warning', now, inc.aIndex,
          {
            parties: [a.driver.code, b.driver.code], where: inc.where,
            offence: inc.kind === 'off-track-advantage'
              ? 'LEAVING THE TRACK AND GAINING AN ADVANTAGE'
              : inc.kind === 'forced-off' ? 'FORCING ANOTHER DRIVER OFF THE TRACK' : 'CONTACT',
            status: 'UNDER INVESTIGATION',
          },
        );
      }

      if (now < inc.verdictAt) continue;
      this.open.splice(k, 1);
      const verdict = this.judge(inc);
      this.publish(inc, verdict, cars, now);
    }
  }

  /**
   * Decides everything still open, because the race has ended.
   *
   * An incident on the last lap would otherwise never be decided at all: the
   * bench takes about a lap and there is no lap left. Real stewards do not drop
   * those — the regulations expressly contemplate a penalty imposed "after the
   * end of a TTCS" and set out what happens to it (Art. B1.9.5) — so the file is
   * closed at the flag instead.
   *
   * A give-back is the one verdict that cannot survive the flag: there is no
   * road left to hand a place back on. Art. B1.8.6's remedy is discretionary
   * ("At the absolute discretion of the Race Director a driver MAY be given the
   * opportunity"), and when the opportunity does not exist the offence stands on
   * its own, so it becomes the five seconds it would have become anyway.
   */
  closeOutstanding(cars: readonly CarEntry[], now: number): void {
    for (const inc of this.open) {
      if (!inc.ev.aftermathDone) this.takeAftermath(inc, cars, now);
      let verdict = this.judge(inc);
      if (verdict.kind === 'give-position-back') {
        verdict = {
          ...verdict, kind: 'penalty',
          because: verdict.because + ', with no opportunity left to give it back',
        };
      }
      this.publish(inc, verdict, cars, now);
    }
    this.open.length = 0;

    // Instructions nobody had time to obey become the penalty too, for the same
    // reason and by the same article.
    for (const car of cars) {
      if (car.cedePositionTo < 0) continue;
      const to = cars[car.cedePositionTo];
      car.cedePositionTo = -1;
      if (car.retired || to.retired || to.totalDistance > car.totalDistance) continue;
      this.recordPenalty(
        car.index, to.index, car.lap, now, 'the race ended with the place still held');
      this.wire.penalise(car, 5, 'FAILING TO GIVE THE POSITION BACK', '', now);
    }
  }

  private judge(inc: OpenIncident): Verdict {
    switch (inc.kind) {
      case 'off-track-advantage':
        return {
          kind: 'give-position-back',
          offence: 'LEAVING THE TRACK AND GAINING AN ADVANTAGE',
          againstIndex: inc.aIndex, victimIndex: inc.victimIndex,
          because: 'left the track and re-joined ahead',
        };
      case 'forced-off':
        return this.judgeForcedOff(inc);
      case 'contact':
        return this.judgeContact(inc);
    }
  }

  /**
   * A crowding case.
   *
   * The watch that opened the incident already established the three elements of
   * Appendix L Art. 2(b) — alongside, under one car's width of room, and the
   * other car moving into it. What is left is the pile-up guard and the
   * requirement that the crowded car had actually established itself alongside
   * rather than sticking a nose in and hoping.
   */
  private judgeForcedOff(inc: OpenIncident): Verdict {
    const ev = inc.ev;
    if (!ev.ok) return nfa(ev.missing);
    if (ev.pileUp) return nfa('multi-car incident');

    // The victim has to have been genuinely alongside. "Significant portion of
    // the car ... alongside" in Appendix L's own terms; taken here as the
    // victim's front axle ahead of the offender's origin, which is about half a
    // car of overlap.
    const along = loopDelta(ev.contactA.s, ev.contactB.s, this.track.length);
    if (along + ev.contactB.cogToFrontM < 0) return nfa('not sufficiently alongside');

    return {
      kind: 'penalty',
      offence: 'FORCING ANOTHER DRIVER OFF THE TRACK',
      againstIndex: inc.aIndex, victimIndex: inc.bIndex,
      because: "left less than a car's width to the edge of the track",
    };
  }

  /**
   * A corner, two cars, and a contact.
   *
   * The order of the tests matters, and it is the order the guidelines put them
   * in: establish which car was entitled to the corner, and only then ask who
   * took it from them.
   *
   * Reads nothing but `inc.ev`, which was frozen at the moment of the incident.
   * That is not an optimisation — see `Evidence`.
   */
  private judgeContact(inc: OpenIncident): Verdict {
    const ev = inc.ev;
    const len = this.track.length;
    if (!ev.ok) return nfa(ev.missing);
    if (ev.contactA.inPitLane || ev.contactB.inPitLane) return nfa('in the pit lane');
    if (ev.pileUp) return nfa('multi-car incident');

    const corner = ev.corner;
    if (!corner) return this.judgeStraightLineContact(inc);

    const atApexA = ev.apexA;
    const atApexB = ev.apexB;

    // Same line: no inside/outside dispute for A or B to decide.
    const sideMargin = insideMarginM(atApexA, atApexB, corner.hand);
    if (Math.abs(sideMargin) < SAME_LINE_M) return this.judgeStraightLineContact(inc);

    // Who was overtaking whom. Settled at the corner ENTRY, because that is when
    // the move began; the whole question is whether it had been completed
    // enough by the apex.
    const gapAtEntry = loopDelta(ev.entryA.s, ev.entryB.s, len);
    if (Math.abs(gapAtEntry) > ENGAGED_GAP_M) {
      return nfa('not fighting for the corner: ' + gapAtEntry.toFixed(1) + 'm apart at entry');
    }

    // Positive `gapAtEntry` means B was ahead of A at the entry, so A is the
    // overtaking car.
    const aIsOvertaker = gapAtEntry > 0;
    const overtakerIndex = aIsOvertaker ? inc.aIndex : inc.bIndex;
    const defenderIndex = aIsOvertaker ? inc.bIndex : inc.aIndex;
    const ot = aIsOvertaker ? atApexA : atApexB;
    const def = aIsOvertaker ? atApexB : atApexA;

    const overtakerInside = insideMarginM(ot, def, corner.hand) > 0;

    // DSG Point A(i) or B(i).
    let margin = overtakerInside
      ? insideRoomMarginM(ot, def)
      : outsideRoomMarginM(ot, def);

    // Point A(iii) / B(iii): a car that was off the road at the apex did not
    // complete the move within track limits and was never entitled to room.
    if (!completedWithinTrackLimits(ot)) margin = Math.min(margin, -CLEAR_PRIORITY_M * 2);

    // Point A(ii) / B(ii), "driven in a fully controlled manner ... and not have
    // 'dived in'". The observable half of it: a car that arrived at the apex
    // well above the speed the corner can be taken at was not in control of
    // where it was going to end up. The threshold is generous, and it is meant
    // to be — the guidelines' own caveats warn that "a lock up or small steering
    // correction do not necessarily imply a driver has lost control", and the
    // solver's reference speed is a lap-time number rather than a limit of
    // adhesion.
    const divedIn = ot.targetSpeedMs > 1 && ot.speedMs > ot.targetSpeedMs * DIVE_IN_OVERSPEED;
    if (divedIn) margin = Math.min(margin, -CLEAR_PRIORITY_M * 2);

    if (Math.abs(margin) < CLEAR_PRIORITY_M) {
      return nfa('level at the apex: ' + margin.toFixed(2) + 'm');
    }

    // Somebody has to have CLOSED the gap. Being in the wrong place is not
    // causing a collision; driving into the space the other car is in, is.
    const closedBy = this.attributeConvergence(
      inc, overtakerIndex, defenderIndex, corner.hand, overtakerInside,
    );
    if (closedBy < 0) return nfa('neither car moved across');

    if (margin >= CLEAR_PRIORITY_M) {
      // The overtaking car was entitled to room. The defender is at fault only
      // if the defender is the one that closed on it.
      if (closedBy !== defenderIndex) return nfa('the entitled car was the one that moved');
      if (!this.costSomething(inc, overtakerIndex)) return nfa(this.noConsequence(inc, overtakerIndex));
      return {
        kind: 'penalty', offence: 'CAUSING A COLLISION',
        againstIndex: defenderIndex, victimIndex: overtakerIndex,
        because: overtakerInside
          ? 'the overtaking car was alongside the mirror at the apex (DSG A)'
          : 'the overtaking car was ahead at the apex (DSG B)',
      };
    }

    // The overtaking car was not entitled to room, so the defender was free to
    // take its line. Fault only if the overtaker is the one that closed.
    if (closedBy !== overtakerIndex) return nfa('the defending car was the one that moved');
    if (!this.costSomething(inc, defenderIndex)) return nfa(this.noConsequence(inc, defenderIndex));
    return {
      kind: 'penalty', offence: 'CAUSING A COLLISION',
      againstIndex: overtakerIndex, victimIndex: defenderIndex,
      because: overtakerInside
        ? 'the front axle was not alongside the mirror at the apex (DSG A)'
        : 'the car on the outside was not ahead at the apex (DSG B)',
    };
  }

  /**
   * Contact away from a corner, or between cars on the same line.
   *
   * Only one case here is clear enough to judge: a car running into the back of
   * one that was plainly in front of it and not doing anything abnormal. Every
   * other straight-line contact — a squeeze on a straight, a late move under
   * braking — needs either DSG Point G's count of direction changes or Point H's
   * definition of the deceleration phase, and neither is modelled. They come out
   * as racing incidents, which is the honest answer while that is true.
   */
  private judgeStraightLineContact(inc: OpenIncident): Verdict {
    const ev = inc.ev;
    const len = this.track.length;

    const gap = loopDelta(ev.contactA.s, ev.contactB.s, len);
    const leader = gap > 0 ? ev.contactB : ev.contactA;
    const follower = gap > 0 ? ev.contactA : ev.contactB;
    const leaderIndex = gap > 0 ? inc.bIndex : inc.aIndex;
    const followerIndex = gap > 0 ? inc.aIndex : inc.bIndex;

    if (Math.abs(gap) < REAR_END_GAP_M) return nfa('side by side, no corner to own');
    if (Math.abs(leader.lateral - follower.lateral) > REAR_END_LATERAL_M) {
      return nfa('not on the same line');
    }
    if (follower.speedMs - leader.speedMs < REAR_END_CLOSING_MS) {
      return nfa('the car behind was not closing');
    }
    // Was the car in front doing something abnormal? A car that stood on the
    // brakes in front of somebody is not simply a victim.
    if (ev.leadDecelMs2 > REAR_END_LEAD_DECEL_MS2) {
      return nfa('the car in front braked abnormally');
    }
    if (!this.costSomething(inc, leaderIndex)) return nfa(this.noConsequence(inc, leaderIndex));

    return {
      kind: 'penalty', offence: 'CAUSING A COLLISION',
      againstIndex: followerIndex, victimIndex: leaderIndex,
      because: 'ran into the back of a car ahead on the same line',
    };
  }

  /** Did the contact cost the named car anything? See `Evidence.consequenceA`. */
  private costSomething(inc: OpenIncident, victimIndex: number): boolean {
    return victimIndex === inc.aIndex ? inc.ev.consequenceA : inc.ev.consequenceB;
  }

  /** ...and if not, by how much it missed, which is what a reader wants next. */
  private noConsequence(inc: OpenIncident, victimIndex: number): string {
    const drop = victimIndex === inc.aIndex ? inc.ev.paceDropA : inc.ev.paceDropB;
    return 'contact without consequence: pace drop ' + drop.toFixed(3) +
      ' against ' + CONSEQUENCE_PACE_DROP;
  }

  /**
   * Which car moved into the other, or -1 for neither clearly.
   *
   * Measured across the track, toward the other car, over the last
   * `CONVERGENCE_WINDOW_S` before the contact. Returning a car index rather than
   * a boolean makes the caller state which car it expected, so a verdict can
   * never be reached against a car that was holding its line.
   */
  private attributeConvergence(
    inc: OpenIncident, overtakerIndex: number, defenderIndex: number,
    hand: CornerHand, overtakerInside: boolean,
  ): number {
    const ev = inc.ev;
    const aIsOvertaker = overtakerIndex === inc.aIndex;
    const otNow = aIsOvertaker ? ev.contactA : ev.contactB;
    const otWas = aIsOvertaker ? ev.beforeA : ev.beforeB;
    const defNow = aIsOvertaker ? ev.contactB : ev.contactA;
    const defWas = aIsOvertaker ? ev.beforeB : ev.beforeA;

    // The overtaker sits toward the inside when it is the inside car, so the
    // defender closes on it by moving further inside, and vice versa.
    const towardOvertaker = overtakerInside ? 1 : -1;
    const defClosed =
      (insideness(defNow.lateral, hand) - insideness(defWas.lateral, hand)) * towardOvertaker;
    const otClosed =
      (insideness(otNow.lateral, hand) - insideness(otWas.lateral, hand)) * -towardOvertaker;

    if (defClosed - otClosed >= CLEAR_CONVERGENCE_M) return defenderIndex;
    if (otClosed - defClosed >= CLEAR_CONVERGENCE_M) return overtakerIndex;
    return -1;
  }

  // -------------------------------------------------------------------------
  // Publishing, and the remedy
  // -------------------------------------------------------------------------

  private publish(
    inc: OpenIncident, verdict: Verdict, cars: readonly CarEntry[], now: number,
  ): void {
    this.verdicts.push({
      ...verdict, time: now, lap: inc.lap, where: inc.where, incident: inc.kind,
    });

    const a = cars[inc.aIndex];
    const b = cars[inc.bIndex];
    const parties = [a.driver.code, b.driver.code];

    if (verdict.kind === 'no-further-action') {
      this.wire.file(
        parties.join(' / ') + ' — no further action',
        'info', now, inc.aIndex,
        { parties, where: inc.where, offence: 'INCIDENT', status: 'NO FURTHER ACTION' },
      );
      return;
    }

    const offender = cars[verdict.againstIndex];
    if (verdict.kind === 'give-position-back') {
      const victim = cars[verdict.victimIndex];
      // A remedy nobody can carry out is not a remedy. If either car has since
      // retired or the places have already swapped back, the matter is closed.
      if (offender.retired || victim.retired ||
          victim.totalDistance > offender.totalDistance) {
        this.wire.file(
          offender.driver.code + ' — no further action',
          'info', now, verdict.againstIndex,
          {
            parties: [offender.driver.code, victim.driver.code], where: inc.where,
            offence: 'LEAVING THE TRACK AND GAINING AN ADVANTAGE',
            status: 'NO FURTHER ACTION',
          },
        );
        return;
      }
      offender.cedePositionTo = verdict.victimIndex;
      offender.cedeDeadline = now + this.cedeWindowS();
      this.wire.file(
        offender.driver.code + ' — give the position back to ' + victim.driver.code,
        'critical', now, verdict.againstIndex,
        {
          parties: [offender.driver.code, victim.driver.code], where: inc.where,
          offence: 'LEAVING THE TRACK AND GAINING AN ADVANTAGE',
          status: 'GIVE THE POSITION BACK',
        },
      );
      return;
    }

    const offence = verdict.offence!;
    this.wire.penalise(offender, tariffSeconds(offence, inc.severity), offence, inc.where, now);
  }

  /** Files a penalty that did not come from an investigation into the ledger. */
  private recordPenalty(
    against: number, victim: number, lap: number, now: number, because: string,
  ): void {
    this.verdicts.push({
      kind: 'penalty', offence: 'FAILING TO GIVE THE POSITION BACK',
      againstIndex: against, victimIndex: victim, because,
      time: now, lap, where: '', incident: 'off-track-advantage',
    });
  }

  /**
   * How long a driver has to hand the place back.
   *
   * The regulations do not put a number on it — Art. B1.8.6 gives the Race
   * Director "absolute discretion" to offer the opportunity at all — and in
   * practice the instruction is expected to be obeyed within the lap. So: a lap,
   * measured on this circuit's own reference time, with a floor for the very
   * short ones.
   */
  private cedeWindowS(): number {
    return Math.max(30, this.track.referenceLapTime);
  }

  /**
   * Watches an instruction being obeyed, or not.
   *
   * This is the half of the rule that makes it a rule. A car told to give a
   * place back and left alone has been told nothing; the penalty for not doing
   * it is what the instruction is worth. It binds the AI and the player
   * identically — the AI's compliance is enforced by `RaceEngine`, and a player
   * who ignores it gets the five seconds.
   */
  private runCedeLoop(cars: readonly CarEntry[], now: number): void {
    for (const car of cars) {
      if (car.cedePositionTo < 0) continue;
      const to = cars[car.cedePositionTo];

      // The obligation dies with either car's race, and with a pit stop, which
      // resolves the order by itself.
      if (car.retired || to.retired || to.inPitLane || car.inPitLane) {
        car.cedePositionTo = -1;
        continue;
      }

      if (to.totalDistance > car.totalDistance) {
        const beneficiary = to.driver.code;
        car.cedePositionTo = -1;
        this.wire.file(
          car.driver.code + ' has given the position back to ' + beneficiary,
          'info', now, car.index,
          {
            parties: [car.driver.code, beneficiary], where: '',
            offence: 'POSITION GIVEN BACK', status: 'NO FURTHER ACTION',
          },
        );
        continue;
      }

      if (now >= car.cedeDeadline) {
        car.cedePositionTo = -1;
        this.recordPenalty(car.index, to.index, car.lap, now, 'the place was never handed back');
        this.wire.penalise(car, 5, 'FAILING TO GIVE THE POSITION BACK', '', now);
      }
    }
  }
}
