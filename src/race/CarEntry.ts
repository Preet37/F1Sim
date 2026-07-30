import { VehiclePhysics, type VehicleControls } from '../physics/VehiclePhysics';
import { applySetup, baselineSetupFor, specForTeam, type CarSetup } from '../physics/VehicleSpec';
import { AIVehicleController, createPerception, type AIPerception } from '../ai/AIVehicleController';
import { createProjection, type TrackProjection } from '../track/TrackSpline';
import type { TrackSpline } from '../track/TrackSpline';
import type { Driver, Team } from '../data/teams';
import type { CompoundId } from '../data/tires';
import { CarDamage } from './DamageModel';
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
  /**
   * Sector being driven, 0..2.
   *
   * Readable so the HUD can show the sector in progress live rather than
   * leaving the board blank until the sector is completed — which would make it
   * useful only three times a lap.
   */
  currentSectorIndex = 0;
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
  /**
   * Whole laps behind the leader.
   *
   * A timing tower's single most important job for a car at the back is to say
   * that it is a lap down, and this is what lets it. Without it a car one lap
   * behind is displayed as though it were three seconds behind the car ahead,
   * which is not merely imprecise — it is the opposite of the truth, and it
   * makes the whole lower half of the tower read as a close battle that is not
   * happening.
   */
  lapsDown = 0;

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
  /**
   * This car's own pit box: its slot in the row, and where that slot sits.
   *
   * A pit lane has one box per car and a driver stops in THEIRS. The simulation
   * used to service every car at the single `pitLane.boxS` from the track data,
   * which is one point on the lap for twenty cars — so nobody had a box of their
   * own to aim at, the player had nowhere marked to stop, and the paint the
   * circuit builder lays down (which does use one box per slot) described a pit
   * lane the simulation was not running.
   *
   * Assigned by the race engine from `PitGeometry.boxS(slot)`, which is the same
   * function the mesh builder and the paddock use, so the box the car stops in
   * is the box painted on the road with this team's garage behind it.
   */
  pitSlot = 0;
  /** Distance along the lap of this car's own box. */
  pitBoxS = 0;
  /**
   * True when this car has been called in, independently of who decided it.
   *
   * The player's pit request and the AI strategist's decision have to live in
   * the same field, because the pit-lane code needs one answer to "is this car
   * coming in", and they must SURVIVE the perception rebuild. The request used
   * to be written straight onto `perception.pitThisLap`, which the engine
   * recomputes from the strategy every single physics step — and the strategy
   * hard-returns false for the player. A player pressing the pit button
   * therefore had the request erased 8ms later, every time, which is why the
   * player could never pit at all.
   */
  pitRequested = false;
  /** True while a pit request is being refused because the entry is closed. */
  pitEntryRefused = false;
  /**
   * This visit is a drive-through, so the car does NOT stop.
   *
   * A drive-through penalty is served by entering the pit lane, driving its
   * length under the limiter and rejoining — the whole point is that the car
   * does not stop. Requiring it to stop in its box to have the penalty marked
   * served meant it never was: the car transited the lane, the penalty stayed
   * outstanding, the strategist called it in again on the next lap, and it
   * spent the rest of the race shuttling in and out of the pit lane. Six visits
   * and no stops was a normal race for a car with one drive-through.
   */
  pitTransitOnly = false;
  /** Seconds still to wait at a closed pit exit before being released. */
  pitExitHold = 0;

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
  /**
   * Seconds still to wait in the garage before this car is released.
   *
   * Above zero the car is held stationary. Releasing twenty cars at once turns
   * the pit exit into a pile-up, and a real session trickles them out anyway.
   */
  releaseTimer = 0;
  /**
   * True once this car has been knocked out of qualifying. An eliminated car
   * keeps its lap time and its grid slot but takes no part in later segments.
   */
  eliminated = false;
  /** The qualifying segment this car was eliminated in, or 0 if it survived. */
  eliminatedInPhase = 0;
  /**
   * True while the car is on an out-lap and its time must not count.
   *
   * A lap that begins in the garage or in the pit lane includes the stationary
   * wait and the whole speed-limited transit, so it is not a representative
   * lap of the circuit — in qualifying it would be twenty to forty seconds
   * slower than a real flying lap and would poison the classification. Set on
   * leaving the pits, cleared the first time the car crosses the line.
   */
  onOutLap = false;
  /**
   * Metres of pit-exit blend zone still to run.
   *
   * A car leaving the pits rejoins at 80 km/h into traffic doing 300, and if it
   * merges straight onto the racing line the closing speed is enough to end
   * both races. Every real circuit paints a blend line for exactly this reason:
   * the rejoining car is required to stay off the racing line until it is up to
   * speed. While this is positive the car holds the pit side of the track.
   */
  blendRemainingM = 0;
  /**
   * Per-component condition. Every part feeds a real term in the vehicle spec,
   * so what the damage panel shows is what the physics is running.
   */
  readonly damage = new CarDamage();

  // --- DRS -----------------------------------------------------------------
  /** True when the gap at the last detection point was under one second. */
  drsEligible = false;
  /** Index of the DRS zone the eligibility was earned for. */
  drsEligibleZone = -1;

  // --- Flags ---------------------------------------------------------------
  blueFlag = false;
  /**
   * This car has been waved past and is REQUIRED to unlap itself.
   *
   * "the message 'LAPPED CARS MAY NOW OVERTAKE' will be sent ... to signal to
   * all cars that have been lapped by the leader that they are required to pass
   * the cars on the lead lap and the Safety Car" — 2025 Art. 55.14 / 2026 Art.
   * B5.13.4c. Required, not permitted.
   */
  mustUnlap = false;
  /**
   * This car is on the lead lap while lapped cars are coming past, and must
   * hold the racing line: "cars on the lead lap must always stay on the racing
   * line unless deviating is unavoidable" — Art. 55.14 / B5.13.4c.
   */
  holdRacingLine = false;
  /**
   * Overtaking still forbidden until this car has itself crossed the Line.
   *
   * "no driver may overtake another F1 Car on the track, including the Safety
   * Car, until they pass the Line for the first time after the Safety Car has
   * entered the Pit Entry Road to return to the Pit Lane" — Art. 55.8 /
   * B5.13.2c. The obligation is per-car, not global: the leader is racing again
   * while a car half a lap back still is not.
   */
  holdUntilLine = false;

  // --- Neutralisation delta ------------------------------------------------
  /** Seconds spent in the marshalling sector currently being timed. */
  deltaSectorTime = 0;
  /** Marshalling sector being timed, or -1 when not under a neutralisation. */
  deltaSectorIndex = -1;
  /** Marshalling sectors completed below the minimum time. */
  deltaBreaches = 0;
  /**
   * True while the sector being timed was joined part-way through, so its time
   * is a stub and must not be judged against a whole sector's minimum.
   */
  deltaSectorPartial = true;

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

    // An out-lap is completed by this crossing, not timed by it. Discard the
    // time and let the flying lap that starts here be the one that counts.
    if (this.onOutLap) {
      this.onOutLap = false;
      this.lap++;
      this.lapStartTime = sessionTime;
      this.sectorStartTime = sessionTime;
      this.currentSectorIndex = 0;
      this.currentLapInvalidated = false;
      this.physics.onLapComplete();
      return;
    }

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
  crossSector(sectorIndex: number, sessionTime: number, sectorCount = 3): void {
    if (sectorIndex === this.currentSectorIndex) return;

    // Only ever advance to the NEXT sector.
    //
    // This used to accept any change of sector index, which meant a car moving
    // BACKWARDS across a boundary — reversing out of a gravel trap, spinning
    // back over the line, or simply oscillating on the boundary itself —
    // recorded a sector time of whatever fraction of a second it had been on
    // the other side. That is where the 0.008s sector times came from, and
    // once one is recorded it becomes a "personal best" that can never be
    // beaten, which poisons the delta and the timing board for the session.
    const expected = (this.currentSectorIndex + 1) % sectorCount;
    if (sectorIndex !== expected) {
      // Going backwards over a boundary invalidates the lap: the car has not
      // driven the full circuit in order.
      if (sectorIndex !== this.currentSectorIndex) this.currentLapInvalidated = true;
      return;
    }

    const prev = this.currentSectorIndex;
    if (prev >= 0 && prev < this.currentSectors.length) {
      this.currentSectors[prev] = sessionTime - this.sectorStartTime;
    }
    this.sectorStartTime = sessionTime;
    this.currentSectorIndex = sectorIndex;
  }

  /** Elapsed time on the lap in progress. */
  /** Time spent in the sector currently being driven, seconds. */
  currentSectorElapsed(sessionTime: number): number {
    return Math.max(0, sessionTime - this.sectorStartTime);
  }

  /**
   * Live delta to this car's best lap, in seconds.
   *
   * Compares elapsed time on this lap against how long the best lap had taken
   * by the same point. That reference point is approximated from completed
   * sectors: exact at every sector boundary and interpolated in between, which
   * is the same compromise a real delta display makes.
   */
  deltaToBest(sessionTime: number): number {
    if (this.bestLapTime <= 0) return 0;
    const elapsed = this.currentLapTime(sessionTime);

    // Time the best lap had used by the start of the current sector.
    let reference = 0;
    for (let i = 0; i < this.currentSectorIndex; i++) reference += this.bestSectors[i];

    // Add a proportional share of the sector in progress.
    const bestThis = this.bestSectors[this.currentSectorIndex];
    if (bestThis > 0) {
      const into = this.currentSectorElapsed(sessionTime);
      reference += Math.min(into, bestThis);
    }
    return elapsed - reference;
  }

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
