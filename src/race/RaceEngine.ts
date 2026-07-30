import { clamp, clamp01, damp, loopDelta, Rng, wrapDistance, MS_TO_KPH } from '../core/MathUtils';
import { PHYSICS_DT } from '../core/SimClock';
import { TrackSpline } from '../track/TrackSpline';
import { CarEntry } from './CarEntry';
import { RaceControlManager } from './RaceControlManager';
import { DRIVERS, getTeam, type Driver } from '../data/teams';
import { DRY_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { EnvironmentState, SurfaceType, VehicleControls } from '../physics/VehiclePhysics';
import type { Neighbour } from '../ai/AIVehicleController';
import { createNeighbour } from '../ai/AIVehicleController';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';

/**
 * The simulation. Owns the track, the cars, race control, timing and the
 * weather, and steps everything at a fixed rate.
 *
 * Deliberately headless: it knows nothing about Three.js, the DOM, or the HUD.
 * The render layer reads its state and draws it. That separation is what lets the
 * validation scripts run entire race weekends in a few seconds with no browser,
 * which is the only practical way to test whether the AI can actually race.
 */

export type SessionKind = 'practice' | 'qualifying' | 'race';

export interface SessionConfig {
  kind: SessionKind;
  /** Display name: FP1, Q2, Grand Prix. */
  name: string;
  /** Session length in seconds, or 0 for a lap-limited session. */
  durationS: number;
  /** Race distance in laps, or 0 for a time-limited session. */
  laps: number;
  /** Index into the car array for the player, or -1 for a fully simulated race. */
  playerIndex: number;
  /** Cars start from a standing grid rather than rolling out of the pits. */
  standingStart: boolean;
  seed: number;
}

/** Weather that evolves over a session. */
export class Weather {
  /** 0 dry .. 1 standing water. */
  wetness = 0;
  /** Target the wetness is drifting toward. */
  private targetWetness = 0;
  airTempC = 24;
  trackTempC = 38;
  /** True once any rain has fallen — suspends the two-compound rule. */
  hasRained = false;
  /** Human-readable state for the HUD. */
  get label(): string {
    if (this.wetness < 0.05) return 'Dry';
    if (this.wetness < 0.35) return 'Damp';
    if (this.wetness < 0.7) return 'Wet';
    return 'Heavy Rain';
  }

  private rng: Rng;
  private nextEventIn: number;

  constructor(def: TrackDefinition, seed: number) {
    this.rng = new Rng(seed ^ 0x5bf03635);
    this.airTempC = def.baseAirTempC + this.rng.range(-3, 3);
    this.trackTempC = def.baseTrackTempC + this.rng.range(-4, 4);
    this.nextEventIn = this.rng.range(300, 1400);
    // Decide up front whether it rains at all this session.
    if (this.rng.chance(def.rainChance)) {
      this.targetWetness = this.rng.range(0.25, 0.95);
    }
  }

  update(dt: number): void {
    this.nextEventIn -= dt;
    if (this.nextEventIn <= 0) {
      this.nextEventIn = this.rng.range(420, 1600);
      // Rain arrives, intensifies, or clears.
      if (this.wetness > 0.1) this.targetWetness = this.rng.chance(0.55) ? 0 : this.rng.range(0.2, 1);
      else if (this.rng.chance(0.35)) this.targetWetness = this.rng.range(0.3, 0.9);
    }

    // Rain arrives faster than a track dries — a wet track takes many laps to
    // come back, which is what makes the crossover call so difficult.
    const rate = this.targetWetness > this.wetness ? 0.055 : 0.016;
    this.wetness = damp(this.wetness, this.targetWetness, rate, dt);
    if (this.wetness > 0.08) this.hasRained = true;

    // Rain cools the track sharply.
    const tempTarget = this.trackTempC - this.wetness * 12;
    this.trackTempC = damp(this.trackTempC, tempTarget, 0.02, dt);
  }
}

/** Fixed grid-slot geometry: 8m between rows, ~4m side offset. */
const GRID_ROW_SPACING_M = 8;
const GRID_SIDE_OFFSET_M = 3.4;

/** Distance behind a leader within which its wake is felt. */
const WAKE_LENGTH_M = 30;
/** Peak downforce loss in the wake. */
const MAX_DIRTY_AIR_LOSS = 0.4;
/** Peak drag reduction from a tow. */
const MAX_SLIPSTREAM_GAIN = 0.2;

export class RaceEngine {
  readonly track: TrackSpline;
  readonly cars: CarEntry[] = [];
  readonly raceControl: RaceControlManager;
  readonly weather: Weather;
  readonly config: SessionConfig;

  /** Session elapsed time, seconds. */
  time = 0;
  /** True once the session has finished. */
  over = false;
  /** Countdown before a standing start releases the cars. */
  startLights = 0;
  started = false;

  /** Cars in classified order. Rebuilt each timing tick, never reallocated. */
  readonly standings: CarEntry[] = [];

  readonly environment: EnvironmentState = {
    trackTempC: 38, airTempC: 24, wetness: 0, airDensityRatio: 1, abrasion: 1,
  };

  private readonly rng: Rng;
  /** Reused neighbour records, two per car, so perception never allocates. */
  private readonly neighbourPool: Neighbour[] = [];
  /** Player control input, written by the input layer each frame. */
  readonly playerControls: VehicleControls = {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false,
  };

  private timingAccumulator = 0;

  constructor(def: TrackDefinition, config: SessionConfig, entries?: readonly Driver[]) {
    this.track = new TrackSpline(def);
    this.config = config;
    this.raceControl = new RaceControlManager(this.track);
    this.weather = new Weather(def, config.seed);
    this.rng = new Rng(config.seed ^ 0x1f2e3d4c);

    const field = entries ?? DRIVERS;
    // Race fuel: enough for the distance plus a small margin. Qualifying runs
    // light, which is why a Q3 lap is several seconds faster than a race lap.
    const fuelL = config.kind === 'race'
      ? Math.min(110, def.raceLaps * (def.lengthM / 1000) * 0.33 + 4)
      : 40;

    for (let i = 0; i < field.length; i++) {
      const d = field[i];
      const team = getTeam(d.teamId);
      const compound: CompoundId = config.kind === 'race' ? 'medium' : 'soft';
      const car = new CarEntry(
        i, d, team, this.track,
        i === config.playerIndex,
        config.seed + i * 7919,
        fuelL, compound,
      );
      this.cars.push(car);
      this.standings.push(car);
      this.neighbourPool.push(createNeighbour(), createNeighbour(), createNeighbour(), createNeighbour());
    }

    this.planStrategies();
    this.placeGrid();
    this.updateEnvironment();
  }

  // =========================================================================
  // Setup
  // =========================================================================

  /**
   * Builds each AI car's pit strategy.
   *
   * Stint length comes from the compound's wear rate against the circuit's
   * abrasion, so the number of stops is a consequence of the tyre model rather
   * than a fixed number per track. Faster cars tend toward the aggressive
   * strategy, which gives the field genuinely different plans.
   */
  private planStrategies(): void {
    if (this.config.kind !== 'race') return;
    const laps = this.config.laps || this.track.def.raceLaps;
    const abrasion = this.track.def.surfaceAbrasion;

    for (const car of this.cars) {
      const wearMult = car.team.performance.tireWearMult * abrasion;
      const care = car.driver.tyreManagement;

      // Laps a medium will last before the cliff on this surface.
      const mediumLife = clamp(30 / wearMult * (0.85 + care * 0.3), 12, 46);
      const hardLife = mediumLife * 1.45;
      const softLife = mediumLife * 0.66;

      const twoStopTotal = softLife + mediumLife + mediumLife;
      const oneStopTotal = mediumLife + hardLife;

      const plan: { compound: CompoundId; pitOnLap: number }[] = [];
      if (oneStopTotal >= laps && !this.rng.chance(0.3)) {
        // One stop: medium then hard.
        plan.push({ compound: 'medium', pitOnLap: Math.round(clamp(mediumLife * 0.92, 8, laps - 6)) });
        plan.push({ compound: 'hard', pitOnLap: -1 });
      } else if (twoStopTotal >= laps || this.rng.chance(0.5)) {
        const first = Math.round(clamp(laps * 0.32, 8, laps - 12));
        const second = Math.round(clamp(laps * 0.66, first + 6, laps - 5));
        plan.push({ compound: 'medium', pitOnLap: first });
        plan.push({ compound: 'hard', pitOnLap: second });
        plan.push({ compound: 'medium', pitOnLap: -1 });
      } else {
        plan.push({ compound: 'medium', pitOnLap: Math.round(laps * 0.45) });
        plan.push({ compound: 'hard', pitOnLap: -1 });
      }

      car.plan = plan;
      car.targetPitLap = plan[0].pitOnLap;
    }
  }

  /**
   * Places cars on the grid, or spreads them for a practice session.
   * Grid order is the current standings order (set by qualifying).
   */
  private placeGrid(): void {
    const startS = 0;
    if (this.config.standingStart) {
      for (let i = 0; i < this.cars.length; i++) {
        const car = this.cars[i];
        const row = Math.floor(i / 2);
        const side = i % 2 === 0 ? 1 : -1;
        // Grid slots run backwards from the line.
        const s = wrapDistance(startS - 12 - row * GRID_ROW_SPACING_M, this.track.length);
        car.placeOnTrack(this.track, s, side * GRID_SIDE_OFFSET_M, 0);
        car.lap = 0;
      }
      this.startLights = 5;
      this.started = false;
    } else {
      // Practice and qualifying: spread the field around the lap so cars are not
      // all queueing at the pit exit.
      for (let i = 0; i < this.cars.length; i++) {
        const car = this.cars[i];
        const s = (i / this.cars.length) * this.track.length;
        const lineOffset = this.track.lineOffset[this.track.indexAt(s)];
        car.placeOnTrack(this.track, s, lineOffset, this.track.targetSpeed[this.track.indexAt(s)] * 0.8);
        car.lap = 0;
        car.lapStartTime = 0;
      }
      this.started = true;
      this.startLights = 0;
    }
  }

  private updateEnvironment(): void {
    this.environment.trackTempC = this.weather.trackTempC;
    this.environment.airTempC = this.weather.airTempC;
    this.environment.wetness = this.weather.wetness;
    this.environment.abrasion = this.track.def.surfaceAbrasion;
    this.environment.airDensityRatio = 1;
  }

  // =========================================================================
  // Main step
  // =========================================================================

  /** Advances the simulation by exactly one fixed physics step. */
  step(): void {
    if (this.over) return;
    const dt = PHYSICS_DT;

    this.time += dt;
    this.weather.update(dt);
    this.updateEnvironment();

    // Start lights.
    if (!this.started) {
      this.startLights -= dt;
      if (this.startLights <= 0) {
        this.started = true;
        this.raceControl.log('Lights out and away we go', 'info', this.time);
      }
    }

    const wetness = this.weather.wetness;

    // 1. Timing and standings at 20Hz. Positions do not need 120Hz updates and
    //    the sort is the most expensive non-physics work in the loop.
    this.timingAccumulator += dt;
    if (this.timingAccumulator >= 0.05) {
      this.timingAccumulator = 0;
      this.updateStandings();
      this.updateDrsEligibility();
    }

    // 2. Per-car update.
    // Marshals clear a stopped car. Without this a retirement holds a local
    // yellow for the rest of the race, which keeps the safety car deployed
    // permanently and turns every remaining lap into a safety-car lap.
    for (const car of this.cars) {
      if (car.retired && !car.recovered) {
        car.recoveryTimer += dt;
        if (car.recoveryTimer > 22) car.recovered = true;
      }
    }

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.retired) continue;

      this.updateAero(car);
      this.updateSurface(car);
      this.buildPerception(car);

      let controls: VehicleControls;
      if (car.isPlayer) {
        controls = this.playerControls;
        // The pit limiter is automatic for the player too — being asked to
        // manage it by hand is tedious rather than interesting.
        controls.pitLimiter = car.inPitLane;
      } else {
        car.ai!.onConditionsChanged(wetness);
        controls = car.ai!.update(dt, car.physics, car.s, car.lateral, car.perception);
      }

      // Before the lights go out nobody moves.
      if (!this.started) {
        this.holdOnGrid(car);
        continue;
      }

      copyControls(controls, car.appliedControls);
      car.physics.drsAvailable = this.isDrsAllowed(car);
      car.physics.step(dt, car.appliedControls, this.environment);

      const crossedLine = car.updateProjection(this.track);
      this.enforceBarriers(car);
      this.updateSectorTiming(car);
      this.updatePitLane(car, dt);

      if (crossedLine) this.onCrossLine(car);
      this.checkReliability(car, dt);
      this.checkBeached(car, dt);
    }

    // 3. Contact resolution between cars.
    this.resolveContacts();

    // 4. Race control.
    this.raceControl.update(dt, this.cars, this.time, this.config.kind === 'race');
    for (const car of this.cars) {
      car.blueFlag = this.config.kind === 'race' && this.raceControl.shouldShowBlueFlag(car, this.cars);
    }

    // 5. Session end.
    this.checkSessionEnd();
  }

  private holdOnGrid(car: CarEntry): void {
    // Hold the car stationary without letting the physics drift it.
    car.physics.velocity.set(0, 0);
    car.physics.yawRate = 0;
    car.physics.localVelX = 0;
    car.physics.localVelY = 0;
    car.appliedControls.throttle = 0;
    car.appliedControls.brake = 1;
    car.lapStartTime = this.time;
  }

  // =========================================================================
  // Aerodynamic interaction
  // =========================================================================

  /**
   * Dirty air and slipstream.
   *
   * Rather than raycasting backward from every leader (twenty rays a frame for a
   * result that is a pure function of the gap), this uses the gap the timing loop
   * already computed. A car in the 30m wake loses up to 40% of its downforce and
   * up to 20% of its drag — so it corners worse and goes faster in a straight
   * line, which is precisely the trade-off that makes following hard and DRS
   * necessary.
   *
   * The loss is scaled by the circuit's dirty-air sensitivity, which is why
   * following is survivable at Monza and hopeless at Monaco.
   */
  private updateAero(car: CarEntry): void {
    let closestGap = Infinity;
    let lateralAlignment = 0;

    for (const other of this.cars) {
      if (other === car || other.retired || other.inPitLane) continue;
      const gap = loopDelta(car.s, other.s, this.track.length);
      // Only cars ahead, within the wake length.
      if (gap <= 0.5 || gap > WAKE_LENGTH_M) continue;
      if (gap < closestGap) {
        closestGap = gap;
        // A car offset to one side leaves cleaner air alongside it, so the
        // follower can move out of the wake — which is how a driver "gets out of
        // the dirty air" onto a different line.
        const lateralSep = Math.abs(other.lateral - car.lateral);
        lateralAlignment = clamp01(1 - lateralSep / 3.2);
      }
    }

    if (closestGap === Infinity) {
      car.physics.dirtyAirDownforceMult = damp(car.physics.dirtyAirDownforceMult, 1, 6, PHYSICS_DT);
      car.physics.slipstreamDragMult = damp(car.physics.slipstreamDragMult, 1, 6, PHYSICS_DT);
      return;
    }

    // Wake strength falls off with distance.
    const proximity = clamp01(1 - closestGap / WAKE_LENGTH_M);
    const strength = proximity * lateralAlignment * this.track.def.dirtyAirSensitivity;

    const dfTarget = 1 - MAX_DIRTY_AIR_LOSS * strength;
    const dragTarget = 1 - MAX_SLIPSTREAM_GAIN * proximity * lateralAlignment;

    car.physics.dirtyAirDownforceMult = damp(car.physics.dirtyAirDownforceMult, dfTarget, 8, PHYSICS_DT);
    car.physics.slipstreamDragMult = damp(car.physics.slipstreamDragMult, dragTarget, 8, PHYSICS_DT);
  }

  /**
   * Keeps cars inside the circuit.
   *
   * Every real track is bounded by a barrier or a wall, and without one a car
   * that runs wide simply keeps travelling — during development one ended up
   * 126 metres off the road, still "racing", permanently stuck in a gravel trap
   * generating a yellow flag for the rest of the session.
   *
   * The barrier is modelled as a lateral limit with an inelastic normal
   * response: the component of velocity into the wall is absorbed, the component
   * along it is scrubbed, and a hard enough hit damages or ends the car's race.
   * Street circuits have walls right at the track edge, which is why Monaco
   * punishes a mistake that Silverstone forgives.
   */
  private enforceBarriers(car: CarEntry): void {
    if (car.inPitLane) return;

    const idx = this.track.indexAt(car.s);
    const halfWidth = this.track.width[idx] * 0.5;
    // Street circuits are walled; permanent circuits have run-off.
    const runoff = this.track.def.scenery === 'street' ? 2.5 : 14;
    const limit = halfWidth + runoff;

    const lat = car.lateral;
    if (Math.abs(lat) <= limit) return;

    const side = Math.sign(lat);
    const nx = this.track.nx[idx] * side;
    const nz = this.track.nz[idx] * side;

    // Correct along the wall normal ONLY, by exactly the overlap.
    //
    // Rebuilding the position from (s, limit) instead looks equivalent but pins
    // the car: it overwrites the along-track component with a value from before
    // this step, so a car against the barrier stops making progress and sits
    // there for the rest of the session. One did exactly that at Parabolica.
    const overlap = Math.abs(lat) - limit;
    car.physics.position.x -= nx * overlap;
    car.physics.position.y -= nz * overlap;
    car.lateral = side * limit;

    // Absorb the velocity component into the wall.
    const into = car.physics.velocity.x * nx + car.physics.velocity.y * nz;
    if (into > 0) {
      car.physics.velocity.x -= nx * into;
      car.physics.velocity.y -= nz * into;
      // Scrub speed along the wall and unsettle the car.
      car.physics.velocity.scale(0.82);
      car.physics.yawRate *= 0.4;

      const severity = clamp01(into / 22);
      if (severity > 0.25) {
        this.applyContactDamage(car, severity);
        this.raceControl.log(
          car.driver.code + ' into the barrier at ' +
          (this.track.cornerNameAt(car.s) || 'the exit'),
          severity > 0.6 ? 'critical' : 'warning', this.time, car.index,
        );
      }
      if (severity > 0.72) {
        car.retire('Accident', this.time);
      }
    }
  }

  /** Determines what surface the car is on from its lateral offset. */
  private updateSurface(car: CarEntry): void {
    const idx = this.track.indexAt(car.s);
    const halfWidth = this.track.width[idx] * 0.5;
    const lat = car.lateral;
    const absLat = Math.abs(lat);

    let surface: SurfaceType;
    if (car.inPitLane) {
      surface = 'pitlane';
    } else if (absLat <= halfWidth - 0.4) {
      surface = 'track';
    } else if (absLat <= halfWidth + 1.1) {
      // Kerbing only exists where the track has it.
      // Lateral is positive-right, so a negative offset is the left-hand side.
      const onKerb = lat < 0 ? this.track.isCurbLeft[idx] : this.track.isCurbRight[idx];
      surface = onKerb ? 'curb' : 'runoff';
    } else if (absLat <= halfWidth + 5) {
      surface = 'runoff';
    } else if (absLat <= halfWidth + 12) {
      surface = 'grass';
    } else {
      surface = 'gravel';
    }

    car.physics.surface = surface;
    car.physics.bankingRad = this.track.banking[idx];
    car.physics.gradeRatio = this.track.gradeAt(car.s);
  }

  // =========================================================================
  // Perception
  // =========================================================================

  /**
   * Fills a car's perception with the cars around it.
   *
   * One O(n) sweep per car, writing into pre-allocated records. At twenty cars
   * that is 400 comparisons per step, which is nothing next to the physics.
   */
  private buildPerception(car: CarEntry): void {
    const p = car.perception;
    const base = car.index * 4;
    const len = this.track.length;

    let bestAhead = Infinity;
    let bestBehind = -Infinity;
    let aheadCar: CarEntry | null = null;
    let behindCar: CarEntry | null = null;
    let leftCar: CarEntry | null = null;
    let rightCar: CarEntry | null = null;

    for (const other of this.cars) {
      if (other === car || other.retired) continue;
      const gap = loopDelta(car.s, other.s, len);

      if (gap > 0 && gap < bestAhead) { bestAhead = gap; aheadCar = other; }
      if (gap < 0 && gap > bestBehind) { bestBehind = gap; behindCar = other; }

      // Alongside: within a car length longitudinally and beside us laterally.
      if (Math.abs(gap) < 5.2) {
        const dLat = other.lateral - car.lateral;
        if (dLat > 0.9 && dLat < 4.2) leftCar = other;
        else if (dLat < -0.9 && dLat > -4.2) rightCar = other;
      }
    }

    p.ahead = aheadCar ? this.fillNeighbour(this.neighbourPool[base], car, aheadCar, bestAhead) : null;
    p.behind = behindCar ? this.fillNeighbour(this.neighbourPool[base + 1], car, behindCar, bestBehind) : null;
    p.alongsideLeft = leftCar
      ? this.fillNeighbour(this.neighbourPool[base + 2], car, leftCar, loopDelta(car.s, leftCar.s, len))
      : null;
    p.alongsideRight = rightCar
      ? this.fillNeighbour(this.neighbourPool[base + 3], car, rightCar, loopDelta(car.s, rightCar.s, len))
      : null;

    p.localYellow = this.raceControl.overtakingBannedAt(car.s);
    p.blueFlag = car.blueFlag;
    p.neutralised = this.raceControl.neutralisation !== 'none';
    p.neutralisedTargetMs = this.raceControl.vscTargetMs;
    p.wetness = this.weather.wetness;
    p.pitThisLap = this.shouldPit(car);
  }

  private fillNeighbour(n: Neighbour, self: CarEntry, other: CarEntry, gapM: number): Neighbour {
    n.index = other.index;
    n.gapM = Math.abs(gapM);
    n.lateral = other.lateral;
    n.speedMs = other.physics.speedMs;
    n.closingMs = self.physics.speedMs - other.physics.speedMs;
    // Gap in seconds at our own speed, which is how a driver perceives it.
    n.gapS = n.gapM / Math.max(self.physics.speedMs, 8);
    return n;
  }

  // =========================================================================
  // Timing and standings
  // =========================================================================

  /**
   * Sorts the field and computes gaps.
   *
   * Race order is by total distance covered, which handles lapped cars correctly
   * without any special-casing. Qualifying and practice order is by best lap.
   */
  private updateStandings(): void {
    const isRace = this.config.kind === 'race';

    // In-place insertion sort. The order barely changes between ticks, so this is
    // effectively O(n) and allocates nothing, unlike Array.sort with a closure.
    const arr = this.standings;
    for (let i = 1; i < arr.length; i++) {
      const item = arr[i];
      let j = i - 1;
      while (j >= 0 && this.ordersBefore(item, arr[j], isRace)) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = item;
    }

    for (let i = 0; i < arr.length; i++) arr[i].position = i + 1;

    // Gaps.
    const leader = arr[0];
    for (let i = 0; i < arr.length; i++) {
      const car = arr[i];
      if (isRace) {
        // Convert a distance deficit into a time gap at the leader's pace.
        const refSpeed = Math.max(leader.physics.speedMs, 20);
        car.gapToLeader = (leader.totalDistance - car.totalDistance) / refSpeed;
        car.interval = i === 0
          ? 0
          : (arr[i - 1].totalDistance - car.totalDistance) / Math.max(car.physics.speedMs, 20);
      } else {
        car.gapToLeader = car.bestLapTime > 0 && leader.bestLapTime > 0
          ? car.bestLapTime - leader.bestLapTime
          : 0;
        car.interval = i === 0 || arr[i - 1].bestLapTime === 0 || car.bestLapTime === 0
          ? 0
          : car.bestLapTime - arr[i - 1].bestLapTime;
      }
    }
  }

  private ordersBefore(a: CarEntry, b: CarEntry, isRace: boolean): boolean {
    // Retired and disqualified cars sort to the back.
    if (a.disqualified !== b.disqualified) return b.disqualified;
    if (a.retired !== b.retired) return b.retired;

    if (isRace) {
      if (a.finished !== b.finished) return a.finished;
      if (a.finished && b.finished) return a.classifiedTime() < b.classifiedTime();
      return a.totalDistance > b.totalDistance;
    }
    // Session order: a set lap beats no lap, then fastest first.
    if ((a.bestLapTime > 0) !== (b.bestLapTime > 0)) return a.bestLapTime > 0;
    if (a.bestLapTime === 0) return false;
    return a.bestLapTime < b.bestLapTime;
  }

  private updateSectorTiming(car: CarEntry): void {
    const idx = this.track.indexAt(car.s);
    car.crossSector(this.track.sector[idx] - 1, this.time);
  }

  private onCrossLine(car: CarEntry): void {
    car.completeLap(this.time);

    if (this.config.kind === 'race') {
      const laps = this.config.laps || this.track.def.raceLaps;
      if (car.lap > laps) {
        if (!car.finished) {
          car.finished = true;
          car.finishTime = this.time;
        }
      }
      // The leader finishing waves the chequered flag.
      if (!this.raceControl.raceFinished && car.lap > laps && car.position === 1) {
        this.raceControl.chequeredFlag(this.time);
      }
    }
  }

  // =========================================================================
  // DRS
  // =========================================================================

  /**
   * DRS eligibility, evaluated at the detection points.
   *
   * Eligibility is earned at a detection line and spent in the zone that follows,
   * exactly as the real system works. Checking the gap continuously inside the
   * zone instead would let a driver who has already been passed keep the wing
   * open, and would remove the tactical value of being within a second AT the
   * detection point.
   */
  private updateDrsEligibility(): void {
    const zones = this.track.def.drsZones;
    if (zones.length === 0) return;

    // DRS is disabled for the first two laps of a race, in the wet, and while
    // the race is neutralised.
    const enabled =
      this.config.kind !== 'race' ? true
        : (this.leaderLap() > 2 && this.weather.wetness < 0.25 &&
           this.raceControl.neutralisation === 'none' &&
           this.raceControl.flagSeverity < 0.25);

    for (const car of this.cars) {
      if (!enabled || car.retired || car.inPitLane) {
        car.drsEligible = false;
        car.drsEligibleZone = -1;
        continue;
      }

      for (let z = 0; z < zones.length; z++) {
        const zone = zones[z];
        // Have we just passed this zone's detection point?
        const dToDetection = loopDelta(car.s, zone.detectionS, this.track.length);
        if (dToDetection > -14 && dToDetection <= 0) {
          const ahead = car.perception.ahead;
          const withinASecond = ahead !== null && ahead.gapS <= 1.0;
          car.drsEligible = withinASecond;
          car.drsEligibleZone = withinASecond ? z : -1;
        }
      }

      // Eligibility expires at the end of the zone it was earned for.
      if (car.drsEligibleZone >= 0) {
        const zone = zones[car.drsEligibleZone];
        const past = loopDelta(zone.endS, car.s, this.track.length);
        if (past > 0 && past < this.track.length * 0.5) {
          car.drsEligible = false;
          car.drsEligibleZone = -1;
        }
      }
    }
  }

  /** True when this car may open its wing right now. */
  private isDrsAllowed(car: CarEntry): boolean {
    if (!car.drsEligible || car.drsEligibleZone < 0) return false;
    const zone = this.track.def.drsZones[car.drsEligibleZone];
    if (!zone) return false;
    const afterStart = loopDelta(zone.startS, car.s, this.track.length);
    const beforeEnd = loopDelta(car.s, zone.endS, this.track.length);
    return afterStart >= 0 && beforeEnd >= 0;
  }

  private leaderLap(): number {
    return this.standings.length > 0 ? this.standings[0].lap : 0;
  }

  // =========================================================================
  // Pit lane
  // =========================================================================

  /** Does the strategy want this car in the pits on this lap? */
  private shouldPit(car: CarEntry): boolean {
    if (this.config.kind !== 'race' || car.isPlayer) return false;
    if (car.inPitLane) return false;
    if (car.lastPitLap === car.lap) return false;

    // Serving a drive-through is not optional.
    if (car.pendingServePenalty() !== null) return true;

    // Wet-weather crossover: if the track is wet and we are on slicks, the tyre
    // is worth many seconds a lap. This overrides any planned stop.
    const onSlicks = !getCompound(car.compound).isWetWeather;
    if (this.weather.wetness > 0.4 && onSlicks) return true;
    if (this.weather.wetness < 0.12 && !onSlicks && car.physics.rearTires.lapsOnSet > 2) return true;

    // Planned stop, or an emergency stop because the tyres are gone.
    // targetPitLap is -1 once the plan has no further stops, and `lap >= -1` is
    // always true — which had every car pitting on every lap.
    const tyresGone = car.physics.rearTires.wear < 0.24;
    const plannedStopDue = car.targetPitLap > 0 && car.lap >= car.targetPitLap;
    return plannedStopDue || tyresGone;
  }

  /**
   * Moves a car through the pit lane: entry, the box, service, and exit.
   *
   * The pit lane is a lateral offset on the main spline rather than a separate
   * path. For a speed-limited straight running parallel to the track that is a
   * faithful model, and it costs one branch instead of a second geometry
   * pipeline.
   */
  private updatePitLane(car: CarEntry, dt: number): void {
    const pit = this.track.def.pitLane;
    const len = this.track.length;

    const fromEntry = loopDelta(pit.entryS, car.s, len);
    const toExit = loopDelta(car.s, pit.exitS, len);
    const geometricallyInLane = fromEntry >= 0 && toExit >= 0 && fromEntry < len * 0.5;

    // A car is in the pit lane only if it entered deliberately and is offset
    // toward the pit wall.
    if (!car.inPitLane) {
      const wantsPit = car.isPlayer
        ? car.perception.pitThisLap
        : car.ai!.state === 'PIT_APPROACH';
      if (wantsPit && geometricallyInLane && fromEntry < 40) {
        car.inPitLane = true;
        car.lastPitLap = car.lap;
      }
      return;
    }

    if (!geometricallyInLane && !car.inPitBox) {
      // Left the lane.
      car.inPitLane = false;
      car.pitSpeedingFlagged = false;
      car.servicedThisVisit = false;
      if (car.ai) car.ai.onRejoinTrack();
      return;
    }

    // Drag the car toward the pit lane's lateral offset so it visibly uses the
    // lane rather than the racing line.
    const targetLat = pit.lateralOffsetM;
    const p = this.track.tmpB;
    const blend = clamp01(dt * 2.2);
    const newLat = car.lateral + (targetLat - car.lateral) * blend;
    this.track.toWorld(car.s, newLat, p);
    car.physics.position.set(p.x, p.y);

    // The box. One service per visit: without the guard a car that is still
    // within the box window after being serviced simply gets serviced again.
    const toBox = loopDelta(car.s, pit.boxS, len);
    if (!car.inPitBox && !car.servicedThisVisit && toBox > -6 && toBox <= 2 && car.physics.speedMs < 22) {
      car.inPitBox = true;
      const crewTime = car.team.performance.pitCrewTimeS;
      // Occasional slow stop — a sticking wheel gun is part of racing.
      const fumble = this.rng.chance(0.06) ? this.rng.range(1.2, 5.5) : 0;
      car.pitBoxTimer = crewTime + this.rng.range(-0.15, 0.35) + fumble;

      // Serve a drive-through by simply passing through without stopping; a
      // stop-go adds its time to the stationary period.
      const pen = car.pendingServePenalty();
      if (pen) {
        if (pen.kind === 'stop-go-10s') car.pitBoxTimer += 10;
        pen.served = true;
      }
    }

    if (car.inPitBox) {
      car.physics.velocity.set(0, 0);
      car.physics.localVelX = 0;
      car.physics.localVelY = 0;
      car.pitBoxTimer -= dt;
      if (car.pitBoxTimer <= 0) {
        car.inPitBox = false;
        car.servicedThisVisit = true;
        const compound = this.chooseCompoundForStint(car);
        car.serviceInBox(compound, 0, this.weather.trackTempC + 40);
        // Advance the plan.
        const next = car.plan[Math.min(car.pitStops, car.plan.length - 1)];
        car.targetPitLap = next ? next.pitOnLap : -1;
        if (car.ai) car.ai.onPitStopComplete();
        this.raceControl.log(
          car.driver.code + ' pit stop — ' + getCompound(compound).name,
          'info', this.time, car.index,
        );
      }
    }
  }

  /** Picks the compound for the next stint, honouring the two-compound rule. */
  private chooseCompoundForStint(car: CarEntry): CompoundId {
    // Weather first: the right tyre for the conditions beats any plan.
    if (this.weather.wetness > 0.6) return 'wet';
    if (this.weather.wetness > 0.3) return 'intermediate';

    const planned = car.plan[Math.min(car.pitStops + 1, car.plan.length - 1)];
    let choice: CompoundId = planned ? planned.compound : 'hard';

    // If this is the last stop and we have only used one dry compound, we must
    // fit a different one or be disqualified at the flag.
    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const lapsRemaining = totalLaps - car.lap;
    const dryUsed = new Set(car.usedCompounds.filter((c) => !getCompound(c).isWetWeather));
    if (dryUsed.size < 2 && lapsRemaining < 30) {
      if (dryUsed.has(choice)) {
        for (const alt of DRY_COMPOUNDS) {
          if (!dryUsed.has(alt)) { choice = alt; break; }
        }
      }
    }
    return choice;
  }

  // =========================================================================
  // Contact
  // =========================================================================

  /**
   * Car-to-car contact.
   *
   * Treats each car as a circle and resolves overlap with an impulse. Not a full
   * collision solver — but wheel-to-wheel contact in F1 either nudges a car
   * offline or launches it, and an impulse plus a spin torque reproduces both.
   * Front-to-back contact costs the following car more, which is realistic and
   * discourages the AI from using the car ahead as a brake.
   */
  private resolveContacts(): void {
    const RADIUS = 2.4;
    const cars = this.cars;

    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.retired || a.inPitBox) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.retired || b.inPitBox) continue;

        const dx = b.physics.position.x - a.physics.position.x;
        const dz = b.physics.position.y - a.physics.position.y;
        const distSq = dx * dx + dz * dz;
        const minDist = RADIUS * 2;
        if (distSq > minDist * minDist || distSq < 1e-6) continue;

        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;
        const overlap = minDist - dist;

        // Separate them.
        const push = overlap * 0.5;
        a.physics.position.x -= nx * push;
        a.physics.position.y -= nz * push;
        b.physics.position.x += nx * push;
        b.physics.position.y += nz * push;

        // Exchange momentum along the contact normal.
        const relVx = b.physics.velocity.x - a.physics.velocity.x;
        const relVz = b.physics.velocity.y - a.physics.velocity.y;
        const approach = relVx * nx + relVz * nz;
        if (approach < 0) {
          const impulse = -approach * 0.42;
          a.physics.velocity.x -= nx * impulse;
          a.physics.velocity.y -= nz * impulse;
          b.physics.velocity.x += nx * impulse;
          b.physics.velocity.y += nz * impulse;

          // A meaningful hit unsettles the cars and can spin them.
          const severity = clamp01(-approach / 12);
          a.physics.yawRate += severity * 0.55 * (nx * 0.4 + 0.2);
          b.physics.yawRate -= severity * 0.55 * (nx * 0.4 + 0.2);

          if (severity > 0.35) {
            // Damage: a real hit costs downforce.
            this.applyContactDamage(a, severity);
            this.applyContactDamage(b, severity);
            this.raceControl.log(
              'Contact between ' + a.driver.code + ' and ' + b.driver.code,
              'warning', this.time,
            );
          }
        }
      }
    }
  }

  private applyContactDamage(car: CarEntry, severity: number): void {
    // Front wing damage costs downforce, which makes the car understeer — the
    // right consequence, and it pressures the driver into an unplanned stop.
    //
    // Tracked as a single multiplier with a floor rather than by rewriting the
    // spec. Compounding an unbounded multiplicative loss left cars with
    // effectively no downforce after a handful of nudges, at which point they
    // could not corner at all and the whole field ended up in the barriers.
    car.aeroDamage = clamp(car.aeroDamage - severity * 0.09, 0.55, 1);
    car.physics.spec = { ...car.physics.baseSpec, clBase: car.physics.baseSpec.clBase * car.aeroDamage };

    if (severity > 0.85 && this.rng.chance(0.12)) {
      car.retire('Accident damage', this.time);
      this.raceControl.log(car.driver.code + ' is out of the race', 'critical', this.time, car.index);
    }
  }

  /**
   * Retires a car that has been stationary off the road for too long.
   *
   * Without this a beached car holds a local yellow forever, which keeps the
   * safety car out, which stops the race ever finishing. Marshals recover a
   * stranded car; so does this.
   */
  private checkBeached(car: CarEntry, dt: number): void {
    const offRoad = Math.abs(car.lateral) > this.track.halfWidthAt(car.s) + 2;
    if (car.physics.speedMs < 2.5 && offRoad && !car.inPitLane) {
      car.stuckTimer += dt;
      if (car.stuckTimer > 9) {
        car.retire('Beached in the gravel', this.time);
        // Marked recovered immediately so the yellow clears with it.
        car.recovered = true;
        this.raceControl.log(
          car.driver.code + ' is out — stranded off track', 'critical', this.time, car.index,
        );
      }
    } else {
      car.stuckTimer = 0;
    }
  }

  // =========================================================================
  // Reliability
  // =========================================================================

  private checkReliability(car: CarEntry, dt: number): void {
    if (this.config.kind !== 'race') return;
    // Failure rate is per race distance, converted to a per-second hazard.
    const raceSeconds = (this.config.laps || this.track.def.raceLaps) * this.track.referenceLapTime;
    const perSecond = car.team.performance.failureRate / Math.max(raceSeconds, 1);
    if (this.rng.next() < perSecond * dt) {
      const causes = ['Power unit failure', 'Gearbox failure', 'Hydraulics', 'Overheating', 'Loss of drive'];
      const cause = this.rng.pick(causes);
      car.retire(cause, this.time);
      this.raceControl.log(car.driver.code + ' — ' + cause, 'critical', this.time, car.index);
    }
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  private checkSessionEnd(): void {
    const cfg = this.config;

    if (cfg.kind === 'race') {
      // Everyone still running has either finished or retired.
      let anyRunning = false;
      for (const car of this.cars) {
        if (!car.retired && !car.finished) anyRunning = true;
      }
      // Give backmarkers a window to complete their final lap after the leader.
      if (!anyRunning || (this.raceControl.raceFinished && this.time > this.raceFinishedAt + 180)) {
        this.finishSession();
      }
      if (this.raceControl.raceFinished && this.raceFinishedAt === 0) {
        this.raceFinishedAt = this.time;
      }
      return;
    }

    if (cfg.durationS > 0 && this.time >= cfg.durationS) {
      this.finishSession();
    }
  }

  private raceFinishedAt = 0;

  private finishSession(): void {
    if (this.over) return;
    this.over = true;
    for (const car of this.cars) {
      if (!car.finished && !car.retired) {
        car.finished = true;
        car.finishTime = this.time;
      }
    }
    if (this.config.kind === 'race') {
      this.raceControl.checkMandatoryCompounds(this.cars, this.weather.hasRained, this.time);
    }
    this.updateStandings();
  }

  /** Forces the session to end, for a UI skip. */
  endNow(): void {
    this.finishSession();
  }

  // =========================================================================
  // Accessors for the render and UI layers
  // =========================================================================

  get playerCar(): CarEntry | null {
    const i = this.config.playerIndex;
    return i >= 0 && i < this.cars.length ? this.cars[i] : null;
  }

  /** Fastest lap of the session and who set it. */
  fastestLap(): { car: CarEntry; time: number } | null {
    let best: CarEntry | null = null;
    for (const car of this.cars) {
      if (car.bestLapTime <= 0) continue;
      if (!best || car.bestLapTime < best.bestLapTime) best = car;
    }
    return best ? { car: best, time: best.bestLapTime } : null;
  }

  /** Session progress 0..1, for the UI. */
  get progress(): number {
    const cfg = this.config;
    if (cfg.kind === 'race') {
      const laps = cfg.laps || this.track.def.raceLaps;
      return clamp01(this.leaderLap() / laps);
    }
    return cfg.durationS > 0 ? clamp01(this.time / cfg.durationS) : 0;
  }

  /** Remaining time or laps, formatted by the caller. */
  get lapsRemaining(): number {
    const laps = this.config.laps || this.track.def.raceLaps;
    return Math.max(0, laps - this.leaderLap());
  }

  get speedKphOfPlayer(): number {
    const p = this.playerCar;
    return p ? p.physics.speedMs * MS_TO_KPH : 0;
  }
}

/** Copies controls without allocating. */
function copyControls(from: VehicleControls, to: VehicleControls): void {
  to.throttle = from.throttle;
  to.brake = from.brake;
  to.steer = from.steer;
  to.drsRequested = from.drsRequested;
  to.ersMode = from.ersMode;
  to.gearRequest = from.gearRequest;
  to.pitLimiter = from.pitLimiter;
}
