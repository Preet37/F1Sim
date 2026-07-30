import { VehiclePhysics, type VehicleControls } from '../physics/VehiclePhysics';
import { applySetup, baselineSetupFor, specForTeam, type CarSetup } from '../physics/VehicleSpec';
import { AIVehicleController, createPerception, type AIPerception } from '../ai/AIVehicleController';
import { createProjection, type TrackProjection } from '../track/TrackSpline';
import type { TrackSpline } from '../track/TrackSpline';
import type { Driver, Team } from '../data/teams';
import type { CompoundId } from '../data/tires';
import type { Penalty } from './RaceControlManager';

/**
 * One car in the session: its driver, its physics, its timing, and its state.
 *
 * This is deliberately a mutable long-lived object. A race allocates twenty of
 * them once and then never allocates again — the arrays it owns (sector times,
 * used compounds, penalties) are the only things that grow, and they grow a
 * handful of entries per race rather than per frame.
 */

export type StintPlan = {
  compound: CompoundId;
  /** Lap on which to pit and switch to the next compound. */
  pitOnLap: number;
};

export class CarEntry {
  /** Index into the race engine's car array. Stable for the session. */
  readonly index: number;
  readonly driver: Driver;
  readonly team: Team;
  readonly physics: VehiclePhysics;
  /** Null for the player's car. */
  readonly ai: AIVehicleController | null;
  /** True for the car the player controls. */
  readonly isPlayer: boolean;

  setup: CarSetup;

  // --- Track-space position ------------------------------------------------
  readonly projection: TrackProjection = createProjection();
  /** Distance along the current lap, metres. */
  s = 0;
  /** Lateral offset from the centreline, +left, metres. */
  lateral = 0;
  /** Total distance covered this session, metres. Drives race position. */
  totalDistance = 0;
  private lastS = 0;

  // --- Timing --------------------------------------------------------------
  /** Completed laps. */
  lap = 0;
  /** Session time at which the current lap began. */
  lapStartTime = 0;
  lastLapTime = 0;
  bestLapTime = 0;
  /** Sector times for the lap in progress. */
  readonly currentSectors: number[] = [0, 0, 0];
  readonly bestSectors: number[] = [0, 0, 0];
  readonly lastSectors: number[] = [0, 0, 0];
  private sectorStartTime = 0;
  private currentSectorIndex = 0;
  /** True when the lap in progress has been invalidated (track limits). */
  currentLapInvalidated = false;

  /** Every completed lap time, for the career's statistics and the UI. */
  readonly lapHistory: number[] = [];

  // --- Standings -----------------------------------------------------------
  /** 1-based classified position. */
  position = 1;
  /** Seconds behind the leader. */
  gapToLeader = 0;
  /** Seconds behind the car directly ahead. */
  interval = 0;

  // --- Tyres and strategy --------------------------------------------------
  compound: CompoundId = 'medium';
  readonly usedCompounds: CompoundId[] = [];
  /** Planned stints for the race. The AI strategist may revise this. */
  plan: StintPlan[] = [];
  pitStops = 0;
  /** Lap the strategist wants this car to pit on. */
  targetPitLap = -1;

  // --- Pit lane state ------------------------------------------------------
  inPitLane = false;
  /** True while stationary in the box. */
  inPitBox = false;
  /** Remaining stationary time, seconds. */
  pitBoxTimer = 0;
  pitSpeedingFlagged = false;
  /** Lap on which the car most recently entered the pit lane. */
  lastPitLap = -1;

  // --- Penalties and infractions ------------------------------------------
  readonly penalties: Penalty[] = [];
  /** Total time penalty to add to race time, seconds. */
  penaltySeconds = 0;
  trackLimitStrikes = 0;
  offTrackNow = false;
  disqualified = false;

  // --- Race state ----------------------------------------------------------
  retired = false;
  retirementReason = '';
  /** True once a retired car has been craned away and stops causing yellows. */
  recovered = false;
  finished = false;
  /** Session time at which the car crossed the line for the last time. */
  finishTime = 0;
  /** True while this car is causing a yellow flag. */
  yellowRaised = false;
  /** Seconds spent stationary off the road, for the beached-car timeout. */
  stuckTimer = 0;
  /** Seconds since retiring, before marshals clear the car. */
  recoveryTimer = 0;
  /** True once serviced during the current pit-lane visit. */
  servicedThisVisit = false;
  /** Surviving fraction of the car's downforce after contact damage. */
  aeroDamage = 1;

  // --- DRS -----------------------------------------------------------------
  /** True when the gap at the last detection point was under one second. */
  drsEligible = false;
  /** Index of the DRS zone the eligibility was earned for. */
  drsEligibleZone = -1;

  // --- Flags ---------------------------------------------------------------
  blueFlag = false;

  /** Perception buffer, reused every tick so the AI never allocates. */
  readonly perception: AIPerception = createPerception();

  /** Controls actually applied this step, whether from AI or player input. */
  readonly appliedControls: VehicleControls = {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false,
    reverse: false,
  };

  constructor(
    index: number,
    driver: Driver,
    team: Team,
    track: TrackSpline,
    isPlayer: boolean,
    seed: number,
    fuelL: number,
    startCompound: CompoundId,
  ) {
    this.index = index;
    this.driver = driver;
    this.team = team;
    this.isPlayer = isPlayer;

    this.setup = baselineSetupFor(track.def.downforceDemand, fuelL);
    const spec = applySetup(specForTeam(team.performance), this.setup);

    this.physics = new VehiclePhysics(spec, startCompound);
    this.physics.fuelL = fuelL;
    this.compound = startCompound;
    this.usedCompounds.push(startCompound);

    this.ai = isPlayer ? null : new AIVehicleController(driver, track, seed);
  }

  /** Places the car for the start of a session. */
  placeOnTrack(track: TrackSpline, s: number, lateralOffset: number, speedMs: number): void {
    const p = track.tmpA;
    track.toWorld(s, lateralOffset, p);
    this.physics.placeAt(p.x, p.y, track.headingAt(s), speedMs);
    this.s = s;
    this.lastS = s;
    this.lateral = lateralOffset;
    this.projection.s = s;
    this.projection.index = track.indexAt(s);
    if (this.ai) this.ai.nodeHint = this.projection.index;
  }

  /**
   * Updates track-space position from the physics position.
   * Returns true if the car crossed the start/finish line this step.
   */
  updateProjection(track: TrackSpline): boolean {
    const hint = this.projection.index;
    track.project(this.physics.position.x, this.physics.position.y, hint, this.projection);
    this.s = this.projection.s;
    this.lateral = this.projection.lateral;
    if (this.ai) this.ai.nodeHint = this.projection.index;

    // Distance travelled along the lap, handling the wrap at the line.
    let delta = this.s - this.lastS;
    const half = track.length * 0.5;
    if (delta < -half) delta += track.length;
    else if (delta > half) delta -= track.length;

    // Guard against a spurious projection jump (e.g. at Suzuka's crossover)
    // being counted as progress.
    if (Math.abs(delta) < 60) this.totalDistance += delta;

    const crossedLine = this.lastS > track.length * 0.75 && this.s < track.length * 0.25;
    this.lastS = this.s;
    return crossedLine;
  }

  /** Records a completed lap. */
  completeLap(sessionTime: number, sectorCount = 3): void {
    const lapTime = sessionTime - this.lapStartTime;

    // Close out the final sector.
    this.currentSectors[sectorCount - 1] = sessionTime - this.sectorStartTime;

    if (this.lap > 0 && lapTime > 5) {
      this.lastLapTime = lapTime;
      for (let i = 0; i < sectorCount; i++) this.lastSectors[i] = this.currentSectors[i];

      if (!this.currentLapInvalidated) {
        this.lapHistory.push(lapTime);
        if (this.bestLapTime === 0 || lapTime < this.bestLapTime) this.bestLapTime = lapTime;
        for (let i = 0; i < sectorCount; i++) {
          const st = this.currentSectors[i];
          if (st > 0 && (this.bestSectors[i] === 0 || st < this.bestSectors[i])) {
            this.bestSectors[i] = st;
          }
        }
      }
    }

    this.lap++;
    this.lapStartTime = sessionTime;
    this.sectorStartTime = sessionTime;
    this.currentSectorIndex = 0;
    this.currentLapInvalidated = false;
    this.physics.onLapComplete();
  }

  /** Called when the car crosses a sector boundary. */
  crossSector(sectorIndex: number, sessionTime: number): void {
    if (sectorIndex === this.currentSectorIndex) return;
    const prev = this.currentSectorIndex;
    if (prev >= 0 && prev < this.currentSectors.length) {
      this.currentSectors[prev] = sessionTime - this.sectorStartTime;
    }
    this.sectorStartTime = sessionTime;
    this.currentSectorIndex = sectorIndex;
  }

  /** Elapsed time on the lap in progress. */
  currentLapTime(sessionTime: number): number {
    return sessionTime - this.lapStartTime;
  }

  /** Fits a new set of tyres and adds fuel. */
  serviceInBox(compound: CompoundId, fuelToAddL: number, blanketTempC: number): void {
    this.physics.serviceCar(compound, fuelToAddL, blanketTempC);
    this.compound = compound;
    this.usedCompounds.push(compound);
    this.pitStops++;
  }

  /** Retires the car. */
  retire(reason: string, sessionTime: number): void {
    if (this.retired) return;
    this.retired = true;
    this.retirementReason = reason;
    this.finishTime = sessionTime;
  }

  /** Race time including penalties, used for final classification. */
  classifiedTime(): number {
    return this.finishTime + this.penaltySeconds;
  }

  /** Unserved drive-through or stop-go, if any. */
  pendingServePenalty(): Penalty | null {
    for (const p of this.penalties) {
      if (!p.served && (p.kind === 'drive-through' || p.kind === 'stop-go-10s')) return p;
    }
    return null;
  }

  /** Estimated tyre wear per lap, from the last few laps. For the strategy UI. */
  wearPerLapEstimate(): number {
    const t = this.physics.rearTires;
    if (t.lapsOnSet < 1) return 0.02;
    return (1 - t.wear) / Math.max(t.lapsOnSet, 1);
  }
}
