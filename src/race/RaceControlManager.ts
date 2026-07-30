import { clamp01, loopDelta } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { CarEntry } from './CarEntry';

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

export interface RaceControlMessage {
  /** Session time the message was issued. */
  time: number;
  text: string;
  severity: 'info' | 'warning' | 'critical';
  /** Car this concerns, or -1 for a session-wide message. */
  carIndex: number;
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

export class RaceControlManager {
  private readonly track: TrackSpline;

  /** Flag state per marshalling sector. */
  readonly sectorFlags: FlagState[] = [];
  /** Global session flag — red and chequered override everything. */
  sessionFlag: FlagState = 'green';
  neutralisation: NeutralisationState = 'none';

  /** Speed all cars must respect under VSC, m/s. */
  vscTargetMs = 0;
  /** Lap on which the current neutralisation began. */
  neutralisedSinceLap = 0;
  private neutralisationTimer = 0;

  /** Rolling log for the radio/UI. Bounded so it cannot grow without limit. */
  readonly messages: RaceControlMessage[] = [];
  private static readonly MAX_MESSAGES = 60;

  /** True once the leader has taken the chequered flag. */
  raceFinished = false;

  constructor(track: TrackSpline) {
    this.track = track;
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags.push('green');
  }

  reset(): void {
    for (let i = 0; i < MARSHAL_SECTORS; i++) this.sectorFlags[i] = 'green';
    this.sessionFlag = 'green';
    this.neutralisation = 'none';
    this.vscTargetMs = 0;
    this.neutralisationTimer = 0;
    this.raceFinished = false;
    this.messages.length = 0;
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

  log(text: string, severity: RaceControlMessage['severity'], time: number, carIndex = -1): void {
    this.messages.push({ time, text, severity, carIndex });
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
  update(dt: number, cars: CarEntry[], sessionTime: number, isRace: boolean): void {
    this.updateIncidentFlags(cars, sessionTime);
    this.updateNeutralisation(dt, cars, sessionTime, isRace);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.retired) continue;
      this.checkTrackLimits(car, i, sessionTime, isRace);
      this.checkPitLaneSpeed(car, i, sessionTime);
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
  private updateIncidentFlags(cars: CarEntry[], sessionTime: number): void {
    // Clear to green, then re-raise. Cheap at 20 sectors and avoids stale flags.
    for (let i = 0; i < MARSHAL_SECTORS; i++) {
      if (this.sectorFlags[i] !== 'red') this.sectorFlags[i] = 'green';
    }

    let incidents = 0;
    for (const car of cars) {
      if (car.inPitLane) continue;

      const offTrack = Math.abs(car.lateral) > this.track.halfWidthAt(car.s) + 1.0;
      const slow = car.physics.speedMs < STOPPED_SPEED_MS;
      const stranded = car.retired && !car.recovered;

      if (stranded || (offTrack && slow)) {
        // Only a genuinely stopped car counts toward a safety car. A car that
        // runs wide and rejoins gets a waved yellow at most — treating every
        // excursion as safety-car-worthy left the race permanently neutralised,
        // and with twenty cars there is almost always somebody off.
        if (stranded) incidents++;
        const sec = this.sectorIndexAt(car.s);
        // The incident sector and the one before it — drivers need warning
        // before they arrive, which is the whole point of a yellow.
        const prev = (sec + MARSHAL_SECTORS - 1) % MARSHAL_SECTORS;
        const severity: FlagState = stranded ? 'double-yellow' : 'yellow';
        this.raiseFlag(sec, severity);
        this.raiseFlag(prev, severity);

        if (!car.yellowRaised) {
          car.yellowRaised = true;
          this.log(
            'Yellow flag — ' + car.driver.code + ' off at ' +
            (this.track.cornerNameAt(car.s) || 'sector ' + (sec + 1)),
            'warning', sessionTime, car.index,
          );
        }
      } else if (car.yellowRaised) {
        car.yellowRaised = false;
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
   * Decides whether to neutralise the race, and manages the phases of doing so.
   *
   * A single stranded car gets a VSC; two or more, or a car stopped in a
   * dangerous place, gets a full safety car. The safety car then runs for a
   * number of laps before ending, which is what bunches the field and creates the
   * strategic swing that makes safety cars matter.
   */
  private updateNeutralisation(dt: number, cars: CarEntry[], sessionTime: number, isRace: boolean): void {
    if (!isRace) {
      // In practice and qualifying, incidents produce yellows but never a
      // safety car — sessions are red-flagged instead.
      this.neutralisation = 'none';
      return;
    }

    if (this.neutralisation !== 'none') {
      this.neutralisationTimer -= dt;

      if (this.neutralisation === 'sc-ending' && this.neutralisationTimer <= 0) {
        this.neutralisation = 'none';
        this.vscTargetMs = 0;
        this.log('Safety car in this lap — racing resumes', 'info', sessionTime);
        return;
      }

      if (this.neutralisationTimer <= 0 && this.activeIncidents === 0) {
        if (this.neutralisation === 'safety-car') {
          this.neutralisation = 'sc-ending';
          this.neutralisationTimer = 25;
          this.log('Safety car ending', 'info', sessionTime);
        } else {
          this.neutralisation = 'none';
          this.vscTargetMs = 0;
          this.log('VSC ending — green flag', 'info', sessionTime);
        }
      }
      return;
    }

    if (this.activeIncidents === 0) return;

    // A stranded car in a fast place is more dangerous than one in a
    // gravel trap, so the response escalates with where the incident is.
    let dangerous = false;
    for (const car of cars) {
      if (!car.retired || car.recovered) continue;
      const halfWidth = this.track.halfWidthAt(car.s);
      const nearTrack = Math.abs(car.lateral) < halfWidth + 4;
      const fastHere = this.track.targetSpeed[this.track.indexAt(car.s)] > 50;
      if (nearTrack && fastHere) dangerous = true;
    }

    // A single stopped car in a safe place gets a VSC; a stopped car somewhere
    // fast, or more than one, gets the full safety car.
    if (this.activeIncidents >= 2 || (this.activeIncidents >= 1 && dangerous)) {
      this.neutralisation = 'safety-car';
      // Under a safety car the field runs at roughly half racing speed.
      this.vscTargetMs = 22;
      this.neutralisationTimer = 55;
      this.log('SAFETY CAR DEPLOYED', 'critical', sessionTime);
    } else {
      this.neutralisation = 'vsc';
      // VSC delta is roughly 60% of racing pace.
      this.vscTargetMs = 32;
      this.neutralisationTimer = 30;
      this.log('VIRTUAL SAFETY CAR', 'warning', sessionTime);
    }
  }

  /**
   * Track limits.
   *
   * The regulation is that no part of the car may be entirely beyond the white
   * line — in practice, all four wheels off. The car's bounding box is checked
   * against the track edge, and an infraction is counted once per excursion
   * rather than once per physics step, which would issue 120 penalties a second.
   */
  private checkTrackLimits(car: CarEntry, index: number, sessionTime: number, isRace: boolean): void {
    if (car.inPitLane) return;

    const halfWidth = this.track.halfWidthAt(car.s);
    const spec = car.physics.spec;
    // All four wheels beyond the line means the inner edge of the car's track
    // width has crossed it, not merely its centre.
    const innerEdge = Math.abs(car.lateral) - spec.trackWidthM * 0.5;
    const allFourOff = innerEdge > halfWidth;

    if (allFourOff) {
      if (!car.offTrackNow) {
        car.offTrackNow = true;
        // Only counts if the car gained something — leaving the road under
        // control at a corner exit counts, spinning off into a gravel trap and
        // losing four seconds does not, and stewards apply the same logic.
        const lostTime = car.physics.speedMs < this.track.targetSpeed[this.track.indexAt(car.s)] * 0.72;
        if (!lostTime) {
          car.trackLimitStrikes++;
          this.onTrackLimitInfraction(car, index, sessionTime, isRace);
        }
      }
    } else if (car.offTrackNow) {
      car.offTrackNow = false;
    }
  }

  private onTrackLimitInfraction(car: CarEntry, index: number, sessionTime: number, isRace: boolean): void {
    const n = car.trackLimitStrikes;
    const corner = this.track.cornerNameAt(car.s) || 'turn';

    // In qualifying and practice, an off-track lap is simply deleted — there is
    // no strike system, because the penalty is losing the lap time.
    if (!isRace) {
      car.currentLapInvalidated = true;
      this.log(car.driver.code + ' lap time deleted — track limits at ' + corner, 'warning', sessionTime, index);
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
      );
    } else {
      this.log(
        car.driver.code + ' — track limits warning ' + n + '/3 at ' + corner,
        'info', sessionTime, index,
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
   * Yielding is required within a few corners, so the check is a distance one.
   */
  shouldShowBlueFlag(car: CarEntry, cars: CarEntry[]): boolean {
    if (car.inPitLane || car.retired) return false;
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
