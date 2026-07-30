import { clamp, clamp01, damp, loopDelta, Rng, wrapDistance, MS_TO_KPH } from '../core/MathUtils';
import { PHYSICS_DT } from '../core/SimClock';
import { TrackSpline } from '../track/TrackSpline';
import { CarEntry } from './CarEntry';
import { RaceControlManager } from './RaceControlManager';
import { bandOf, COMPONENT_NAMES, type ImpactZone } from './DamageModel';
import { DRIVERS, getTeam, type Driver } from '../data/teams';
import { DRY_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { EnvironmentState, SurfaceType, VehicleControls } from '../physics/VehiclePhysics';
import type { Neighbour } from '../ai/AIVehicleController';
import { createNeighbour } from '../ai/AIVehicleController';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import { buildWorldModel, type Obstacle, type WorldModel } from '../track/WorldObstacles';
import { pitLaneGeometry, type PitLaneGeometry } from '../track/PitGeometry';

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
  /**
   * Cars begin stationary in their garages and must leave down the pit lane
   * under the speed limiter.
   *
   * This is the correct default for every session that is not a race start. A
   * real practice or qualifying session never begins with cars already at
   * speed on the circuit — they roll out of the garage, serve the pit lane at
   * 80 km/h, and pick up the track at the pit exit.
   */
  pitLaneStart: boolean;
  /**
   * Qualifying knockout segment: 1, 2 or 3. Undefined outside qualifying.
   */
  qualifyingPhase?: 1 | 2 | 3;
  /**
   * How many cars survive this segment. The slowest are eliminated and take
   * grid slots from the back in the order they were knocked out.
   */
  advancing?: number;
  /**
   * Car indices allowed to participate. Undefined means the whole field.
   * Q2 and Q3 run with a progressively smaller field.
   */
  participants?: readonly number[];
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

/** Spacing between cars queueing in the pit lane at a garage start, metres. */
const GARAGE_SPACING_M = 11;
/**
 * Gap between successive cars being released from the garage, seconds.
 *
 * Wide on purpose. At 1.2s a ten-car field emerged from the pit exit
 * nose-to-tail as a single train, and the cars at the back of it rear-ended the
 * ones in front hard enough to be written off before anyone had set a lap. Real
 * teams space their runners for exactly this reason — nobody wants their driver
 * in traffic on an out-lap.
 */
const GARAGE_RELEASE_GAP_S = 3.4;
/**
 * Length of the pit-exit blend zone, metres.
 *
 * Long enough for a car leaving at the 80 km/h limit to be back at racing pace
 * before it takes the line. Roughly 250m is what a real circuit paints.
 */
const PIT_EXIT_BLEND_M = 260;

/**
 * Car collision shape: three discs strung along the car's centreline.
 *
 * Radius is the car's half-width, and the offsets span its length, so together
 * they approximate the real 5.6m x 2.0m footprint. Using the half-width as the
 * radius is what makes side-by-side racing possible without phantom contact.
 */
const DISC_RADIUS_M = 1.0;
const DISC_OFFSETS_M = [1.85, 0, -1.85] as const;
/** Centre-to-centre distance beyond which no discs can possibly overlap. */
const BROAD_PHASE_M = 2 * (1.85 + DISC_RADIUS_M);

/** What race control calls each kind of solid object a car can hit. */
const OBSTACLE_NAMES: Record<Obstacle['kind'], string> = {
  building: 'a building',
  grandstand: 'the grandstand',
  wall: 'the wall',
  pitwall: 'the pit wall',
};

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
  /**
   * The static world: where the set dressing stands, and which of it is solid.
   *
   * Built here rather than in the renderer so that the headless validation
   * harness collides against exactly the same buildings, stands and walls the
   * browser draws.
   */
  readonly world: WorldModel;
  private readonly pitGeom: PitLaneGeometry;
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
    reverse: false,
  };

  private timingAccumulator = 0;
  /** Broadphase scratch for the static-obstacle pass. Reused, never reallocated. */
  private readonly obstacleHits: number[] = [];

  constructor(def: TrackDefinition, config: SessionConfig, entries?: readonly Driver[]) {
    this.track = new TrackSpline(def);
    this.world = buildWorldModel(this.track);
    this.pitGeom = pitLaneGeometry(def, this.track.length);
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

    // Cars outside this session's participant list are already knocked out.
    // Marking them here means the step loop, the timing tower and the standings
    // all agree without each needing to consult the config.
    if (config.participants) {
      for (const car of this.cars) {
        if (!config.participants.includes(car.index)) {
          car.eliminated = true;
          car.eliminatedInPhase = (config.qualifyingPhase ?? 1) - 1;
        }
      }
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

      // Every stop must land on a lap that actually exists.
      //
      // The bounds used to be written as fixed lap counts — `clamp(x, 8, laps-6)`
      // — which for any race shorter than fourteen laps inverts: the low bound
      // is above the high one, `clamp` returns the high one, and the stop is
      // scheduled for lap -1, meaning never. Every car then ran the whole
      // distance on one compound and was disqualified at the flag under the
      // two-compound rule, which is why the short validation races reported
      // twenty starters, zero finishers and no pit stops at all.
      //
      // Expressing the window as a FRACTION of the distance makes it correct at
      // every length: a five-lap sprint stops on lap two, a Grand Prix on lap
      // twenty-four, and the tyre model still decides which of the two.
      //
      // The stops are also spread across the field. Twenty cars whose tyre
      // model happens to agree will otherwise all queue for the same lap, which
      // in a short race means the entire grid arrives at one pit box at once.
      // Real teams stagger for exactly this reason.
      const window = Math.max(1, laps - 1);
      const spread = Math.min(3, laps * 0.12) * (((car.index * 7) % 5) - 2) * 0.5;
      const stopLap = (lap: number): number =>
        clamp(Math.round(lap + spread), 1, window);

      const plan: { compound: CompoundId; pitOnLap: number }[] = [];
      if (oneStopTotal >= laps && !this.rng.chance(0.3)) {
        // One stop: medium then hard, at whichever comes first — the tyre's
        // useful life or the middle of the race.
        plan.push({ compound: 'medium', pitOnLap: stopLap(Math.min(mediumLife * 0.92, laps * 0.62)) });
        plan.push({ compound: 'hard', pitOnLap: -1 });
      } else if (twoStopTotal >= laps || this.rng.chance(0.5)) {
        const first = stopLap(laps * 0.32);
        const second = stopLap(Math.max(laps * 0.66, first + 1));
        plan.push({ compound: 'medium', pitOnLap: first });
        plan.push({ compound: 'hard', pitOnLap: second });
        plan.push({ compound: 'medium', pitOnLap: -1 });
      } else {
        plan.push({ compound: 'medium', pitOnLap: stopLap(laps * 0.45) });
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

    // Only cars taking part. Q2 and Q3 run a reduced field; everyone else is
    // already eliminated and sits out.
    const field = this.participants;

    if (this.config.standingStart) {
      for (let i = 0; i < field.length; i++) {
        const car = field[i];
        const row = Math.floor(i / 2);
        const side = i % 2 === 0 ? 1 : -1;
        // Grid slots run backwards from the line.
        const s = wrapDistance(startS - 12 - row * GRID_ROW_SPACING_M, this.track.length);
        car.placeOnTrack(this.track, s, side * GRID_SIDE_OFFSET_M, 0);
        car.lap = 0;
      }
      this.startLights = 5;
      this.started = false;
      return;
    }

    if (this.config.pitLaneStart) {
      // Cars queue in the pit lane in their garages and leave under the
      // limiter. This is how every session that is not a race start actually
      // begins — nobody is teleported onto the circuit at speed.
      const pit = this.track.def.pitLane;
      const len = this.track.length;

      for (let i = 0; i < field.length; i++) {
        const car = field[i];
        // Stack the queue backwards from the box toward the pit entry, so the
        // cars form an orderly line rather than occupying the same metre.
        const s = wrapDistance(pit.boxS - i * GARAGE_SPACING_M, len);
        car.placeOnTrack(this.track, s, pit.lateralOffsetM, 0);
        car.lap = 0;
        car.lapStartTime = 0;
        car.inPitLane = true;
        car.inPitBox = false;
        // Already "serviced": these cars are leaving the garage, not stopping
        // for a stop. Without this they would immediately try to take service
        // in the box they are parked next to.
        car.servicedThisVisit = true;
        // The lap out of the garage is an out-lap and must not be timed.
        car.onOutLap = true;
        // Staggered release, so twenty cars do not all pull out at once and
        // pile into each other at the pit exit.
        car.releaseTimer = i * GARAGE_RELEASE_GAP_S;
        // Put the AI in its pit-exit state so it drives the lane properly:
        // limiter on, holding the pit lane's lateral offset, until the exit.
        if (car.ai) car.ai.onPitStopComplete();
      }

      this.started = true;
      this.startLights = 0;
      return;
    }

    // Fallback: spread the field around the lap. Used only by the validation
    // harness, which measures pace and does not want to spend a third of a
    // short session watching an out-lap.
    for (let i = 0; i < field.length; i++) {
      const car = field[i];
      const s = (i / field.length) * this.track.length;
      const lineOffset = this.track.lineOffset[this.track.indexAt(s)];
      car.placeOnTrack(this.track, s, lineOffset, this.track.targetSpeed[this.track.indexAt(s)] * 0.8);
      car.lap = 0;
      car.lapStartTime = 0;
    }
    this.started = true;
    this.startLights = 0;
  }

  /** Cars taking part in this session. */
  get participants(): CarEntry[] {
    const allowed = this.config.participants;
    if (!allowed) return this.cars;
    return this.cars.filter((c) => allowed.includes(c.index));
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

  /**
   * True if `time` would be the fastest sector `index` anyone has set this
   * session — the purple-sector test.
   */
  isSessionBestSector(index: number, time: number): boolean {
    if (time <= 0) return false;
    for (const car of this.cars) {
      const best = car.bestSectors[index];
      if (best > 0 && best < time - 1e-4) return false;
    }
    return true;
  }

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
      // Cars knocked out of qualifying take no further part in the session.
      if (car.eliminated) continue;

      // Held in the garage until this car's release slot comes round.
      if (car.releaseTimer > 0) {
        car.releaseTimer -= dt;
        this.holdOnGrid(car);
        continue;
      }

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

      // Attrition from riding kerbs, running through gravel and holding the
      // engine against the limiter. Small per-second rates, so this is a
      // race-distance cost rather than a corner-by-corner one — which is what
      // gives a track-limits rule real teeth over a stint.
      if (car.blendRemainingM > 0) {
        car.blendRemainingM = Math.max(0, car.blendRemainingM - car.physics.speedMs * dt);
      }

      car.damage.applyWear(dt, car.physics.surface, car.physics.speedMs, car.physics.rpmFraction);
      if (car.damage.specDirty) car.physics.spec = car.damage.applyTo(car.physics.baseSpec);

      const crossedLine = car.updateProjection(this.track);
      this.enforceBarriers(car, dt);
      this.collideWithObstacles(car, dt);
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
   * The barrier is modelled as a lateral limit. This function owns only the
   * geometry — where the wall is and how far the car has gone through it — and
   * hands the velocity response to the vehicle model, which bounces the car off
   * with a restitution scaled by how square the hit was: a graze slides along
   * the wall, a square-on hit rebounds onto the circuit, and a hard enough one
   * damages or ends the car's race. Street circuits have walls right at the
   * track edge, which is why Monaco punishes a mistake Silverstone forgives.
   */
  private enforceBarriers(car: CarEntry, dt: number): void {
    const idx = this.track.indexAt(car.s);
    const halfWidth = this.track.width[idx] * 0.5;
    // Street circuits are walled; permanent circuits have run-off.
    const runoff = this.track.def.scenery === 'street' ? 2.5 : 14;
    let limit = halfWidth + runoff;

    if (car.inPitLane) {
      // A car in the pit lane is still contained — just by a different wall.
      //
      // This used to return immediately, leaving pit-lane cars with NO
      // containment at all. That was survivable when the only way to be in the
      // pit lane was to deliberately drive into it, but garage starts put every
      // car in the lane at the start of every practice and qualifying session.
      // Any car whose flag failed to clear could then drive through the
      // barriers and out across the landscape — which is exactly the "stranded
      // a hundred metres outside the fence" state.
      const pitLat = this.track.def.pitLane.lateralOffsetM;
      limit = Math.abs(pitLat) + 6;
      // ...and on the other side by the pit wall. Without this a car in the
      // lane could simply drift across the wall and rejoin the circuit through
      // it, which is the same "the world is not solid" complaint from the
      // opposite direction.
      this.enforcePitWall(car, dt);
      if (Math.abs(car.lateral) <= limit) return;
    }

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

    // The velocity response — restitution, scrape and yaw damping — belongs to
    // the vehicle model, which owns `velocity` and the body-frame copy of it
    // that has to stay in step. See VehiclePhysics.collideWithBarrier.
    const severity = car.physics.collideWithBarrier(nx, nz, dt);
    this.onSolidImpact(car, severity, nx, nz, 'the barrier');
  }

  /**
   * Books the consequences of hitting something immovable.
   *
   * Shared by the circuit's barrier line, the pit wall and every static
   * obstacle in the world, so a car that drives into a grandstand is punished
   * exactly as hard as one that drives into an armco at the same speed and the
   * same angle. Severity comes from the vehicle model and is the closing speed
   * ALONG THE CONTACT NORMAL as a fraction of the write-off speed — so it
   * already carries both the speed and the angle of the impact, and a
   * glancing brush at 300 km/h costs less than a square-on hit at 80.
   */
  private onSolidImpact(
    car: CarEntry, severity: number, nx: number, nz: number, what: string,
  ): void {
    if (severity > 0.25) {
      this.applyContactDamage(car, severity, zoneFor(car.physics.heading, nx, nz));
      this.raceControl.log(
        car.driver.code + ' into ' + what + ' at ' +
        (this.track.cornerNameAt(car.s) || 'the exit'),
        severity > 0.6 ? 'critical' : 'warning', this.time, car.index,
      );
    }
    if (severity > 0.72) {
      car.retire('Accident', this.time);
      // A written-off car is stationary. Retiring without this left the wreck
      // carrying its impact speed, so the HUD kept reading a speed for a car
      // that was out of the race and pinned against a barrier.
      car.physics.stop();
      car.recovered = true;
      this.raceControl.log(
        car.driver.code + ' is out on the spot — heavy impact',
        'critical', this.time, car.index,
      );
    }
  }

  /**
   * The pit wall, from the pit lane's side.
   *
   * Only over the wall's actual length, and with a few metres of slack at each
   * end: a car joining the lane crosses the wall line diagonally over the entry
   * wedge, and clamping it there would shove every car sideways as it entered
   * the pits. The wall is solid from the CIRCUIT's side through the ordinary
   * static-obstacle pass; this is the mirror of it.
   */
  private enforcePitWall(car: CarEntry, dt: number): void {
    const g = this.pitGeom;
    const u = g.u(car.s);
    if (u < g.entryOpenU + 10 || u > g.exitU - 10) return;

    const inner = g.wallMag + g.wallThick * 0.5 + DISC_RADIUS_M;
    const onSide = car.lateral * g.sign;
    if (onSide >= inner) return;

    const idx = this.track.indexAt(car.s);
    const push = inner - onSide;
    car.physics.position.x += this.track.nx[idx] * g.sign * push;
    car.physics.position.y += this.track.nz[idx] * g.sign * push;
    car.lateral = g.sign * inner;

    // The car was travelling toward the circuit, so the normal it hit the wall
    // along points back across the lane.
    const nx = -this.track.nx[idx] * g.sign;
    const nz = -this.track.nz[idx] * g.sign;
    const severity = car.physics.collideWithBarrier(nx, nz, dt);
    this.onSolidImpact(car, severity, nx, nz, 'the pit wall');
  }

  /**
   * Car versus the solid world: buildings, grandstands, the pit wall and the
   * walls down the pit entry and exit roads.
   *
   * Before this the only thing keeping a car in the world was a lateral limit
   * on the spline, which is a fine model of a barrier that follows the track
   * and no model at all of a building standing beside it. Everything else was
   * scenery in the literal sense — the car drove through it.
   *
   * The car is the same three discs `resolveContacts` uses, so its footprint
   * here and its footprint against another car are the same shape. Each disc is
   * tested against the obstacle's oriented box by the standard closest-point
   * construction, the deepest contact wins, and the response is handed to
   * `VehiclePhysics.collideWithBarrier` — the same restitution, scrape and yaw
   * damping the circuit's own barrier uses, so hitting a wall feels like
   * hitting a wall wherever the wall came from.
   */
  private collideWithObstacles(car: CarEntry, dt: number): void {
    const field = this.world.obstacles;
    if (field.isEmpty) return;

    const p = car.physics;
    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);
    const reach = DISC_OFFSETS_M[0] + DISC_RADIUS_M;

    field.query(p.position.x, p.position.y, reach, this.obstacleHits);

    for (const oi of this.obstacleHits) {
      const o: Obstacle = field.obstacles[oi];
      // A car in the pit lane is held off the pit wall by `enforcePitWall`,
      // which knows about the entry and exit tapers. Applying both would fight
      // over the same car at the split.
      if (o.kind === 'pitwall' && car.inPitLane) continue;

      let bestPen = 0;
      let bnx = 0;
      let bnz = 0;

      for (const off of DISC_OFFSETS_M) {
        const dx = p.position.x + sinH * off - o.x;
        const dz = p.position.y + cosH * off - o.z;
        // Into the box's frame: local +X across the track, +Z along it.
        const lx = dx * o.cos - dz * o.sin;
        const lz = dx * o.sin + dz * o.cos;
        const qx = clamp(lx, -o.halfX, o.halfX);
        const qz = clamp(lz, -o.halfZ, o.halfZ);
        const ex = lx - qx;
        const ez = lz - qz;
        const d = Math.hypot(ex, ez);

        let pen: number;
        let nlx: number;
        let nlz: number;
        if (d > 1e-6) {
          pen = DISC_RADIUS_M - d;
          if (pen <= 0) continue;
          nlx = ex / d;
          nlz = ez / d;
        } else {
          // The disc's centre is inside the box. Push it out through the
          // nearest face rather than an arbitrary one, so a car that somehow
          // ends up inside a building comes out of the side it went in.
          const outX = o.halfX - Math.abs(lx);
          const outZ = o.halfZ - Math.abs(lz);
          if (outX < outZ) {
            pen = outX + DISC_RADIUS_M;
            nlx = lx >= 0 ? 1 : -1;
            nlz = 0;
          } else {
            pen = outZ + DISC_RADIUS_M;
            nlx = 0;
            nlz = lz >= 0 ? 1 : -1;
          }
        }

        if (pen > bestPen) {
          bestPen = pen;
          bnx = nlx * o.cos + nlz * o.sin;
          bnz = -nlx * o.sin + nlz * o.cos;
        }
      }

      if (bestPen <= 0) continue;

      // Separate along the contact normal only — the same rule, and for the
      // same reason, as the barrier: rebuilding the position from the spline
      // pins the car in place.
      p.position.x += bnx * bestPen;
      p.position.y += bnz * bestPen;

      // `collideWithBarrier` wants the normal pointing the way the car was
      // travelling when it hit, which is into the obstacle.
      const severity = p.collideWithBarrier(-bnx, -bnz, dt);
      this.onSolidImpact(car, severity, -bnx, -bnz, OBSTACLE_NAMES[o.kind]);
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
      // Lateral is positive-LEFT, so a positive offset is the left-hand side.
      const onKerb = lat > 0 ? this.track.isCurbLeft[idx] : this.track.isCurbRight[idx];
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
    p.blendRemainingM = car.blendRemainingM;
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
      // Left the lane. The lap in progress ran through the pit lane, so it is
      // an out-lap and its time must not be classified.
      car.inPitLane = false;
      car.onOutLap = true;
      car.blendRemainingM = PIT_EXIT_BLEND_M;
      car.pitSpeedingFlagged = false;
      car.servicedThisVisit = false;
      if (car.ai) car.ai.onRejoinTrack();
      return;
    }

    // Drag the car toward the pit lane's lateral offset so it visibly uses the
    // lane rather than the racing line.
    //
    // Applied as a displacement ALONG THE TRACK NORMAL, not by rebuilding the
    // position from (s, lateral). Rebuilding looks equivalent and is not: it
    // overwrites the along-track component with a value from earlier in the
    // step, so every metre of progress the car makes is thrown away and only
    // its lateral motion survives. A car whose nose was pointing even slightly
    // across the lane therefore stopped advancing entirely while its speedo
    // still read 100 km/h — it sat in the pit lane for the rest of the race,
    // holding a yellow flag and a safety car with it. In a twenty-car race
    // seventeen cars ended up in that state, which is why almost no circuit
    // could get a single car to the finish and why the full-race check saw no
    // pit stops at all: nobody ever reached the box.
    //
    // This is the same mistake, and the same fix, as the one documented at
    // length in `enforceBarriers` above.
    const idx = this.track.indexAt(car.s);
    const dLat = (pit.lateralOffsetM - car.lateral) * clamp01(dt * 2.2);
    car.physics.position.x += this.track.nx[idx] * dLat;
    car.physics.position.y += this.track.nz[idx] * dLat;

    // The box. One service per visit: without the guard a car that is still
    // within the box window after being serviced simply gets serviced again.
    const toBox = loopDelta(car.s, pit.boxS, len);
    if (!car.inPitBox && !car.servicedThisVisit && toBox > -6 && toBox <= 2 && car.physics.speedMs < 22) {
      car.inPitBox = true;
      const crewTime = car.team.performance.pitCrewTimeS;
      // Occasional slow stop — a sticking wheel gun is part of racing.
      const fumble = this.rng.chance(0.06) ? this.rng.range(1.2, 5.5) : 0;
      car.pitBoxTimer = crewTime + this.rng.range(-0.15, 0.35) + fumble;

      // A damaged nose costs real time to change: the crew has to remove the
      // old assembly and fit a new one, and that is why a driver with a broken
      // wing weighs limping to the end against losing a dozen seconds now.
      const frontWing = Math.min(car.damage.health.frontWingL, car.damage.health.frontWingR);
      if (frontWing < 0.7) car.pitBoxTimer += 9 + (1 - frontWing) * 5;

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
        // The lap out of the garage is an out-lap and must not be timed.
        car.onOutLap = true;
        const compound = this.chooseCompoundForStint(car);
        car.serviceInBox(compound, 0, this.weather.trackTempC + 40);

        // The crew replaces the nose and the bodywork they can reach. Floor,
        // suspension and power unit damage stays with the car for the rest of
        // the race — those are not parts anyone changes in three seconds.
        car.damage.repair('frontWingL', 'frontWingR', 'sidepodL', 'sidepodR');
        car.physics.spec = car.damage.applyTo(car.physics.baseSpec);
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
   * Each car is modelled as three overlapping discs strung along its own
   * centreline, not as one big circle.
   *
   * A single 2.4m-radius circle per car meant contact was reported whenever two
   * centres came within 4.8 metres — more than twice the width of a real car.
   * Cars racing properly side by side, a full car's width apart and never
   * touching, generated a stream of "Contact between..." messages and took
   * damage for it. The circle has to be big enough to cover a 5.6m-long car,
   * so making one circle fit the length inevitably makes it far too fat across.
   *
   * Three discs of half-width radius, spaced along the length, cover the same
   * 5.6m x 2.0m footprint while respecting its shape. Side by side, contact now
   * happens at 2.0m — the real width of two cars touching. Nose to tail it
   * happens at 5.6m. And because the discs rotate with the car, a car turned
   * across another is correctly a different shape to one alongside it.
   *
   * The response is still an impulse rather than a full rigid-body solve:
   * wheel-to-wheel contact in F1 either nudges a car offline or launches it,
   * and an impulse plus a spin torque reproduces both.
   */
  private resolveContacts(): void {
    const cars = this.cars;

    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.retired || a.inPitBox) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.retired || b.inPitBox) continue;
        // A car in the pit lane and a car on the circuit are separated by the
        // pit wall, however close their spline coordinates are. Without this
        // the two collide through the wall wherever the lane runs near the
        // track — which at the pit exit wrote off half the field before anyone
        // had set a lap.
        if (a.inPitLane !== b.inPitLane) continue;

        // Cheap reject before the per-disc test: if the centres are further
        // apart than the two cars' full diagonals, nothing can be touching.
        const cdx = b.physics.position.x - a.physics.position.x;
        const cdz = b.physics.position.y - a.physics.position.y;
        const centreSq = cdx * cdx + cdz * cdz;
        if (centreSq > BROAD_PHASE_M * BROAD_PHASE_M) continue;

        // Find the closest pair of discs between the two cars.
        const aSin = Math.sin(a.physics.heading), aCos = Math.cos(a.physics.heading);
        const bSin = Math.sin(b.physics.heading), bCos = Math.cos(b.physics.heading);

        let dist = Infinity;
        let dx = 0;
        let dz = 0;
        for (const oa of DISC_OFFSETS_M) {
          const ax = a.physics.position.x + aSin * oa;
          const az = a.physics.position.y + aCos * oa;
          for (const ob of DISC_OFFSETS_M) {
            const bx = b.physics.position.x + bSin * ob;
            const bz = b.physics.position.y + bCos * ob;
            const ex = bx - ax;
            const ez = bz - az;
            const d = Math.hypot(ex, ez);
            if (d < dist) { dist = d; dx = ex; dz = ez; }
          }
        }

        const minDist = DISC_RADIUS_M * 2;
        if (dist > minDist || dist < 1e-6) continue;

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
            // Work out which face of each car was struck. The contact normal
            // points from a to b, so a is hit on the side facing b and b on the
            // side facing a — projecting that normal into each car's own frame
            // is what makes a side-swipe damage sidepods and a rear-end hit
            // damage wings and gearboxes.
            this.applyContactDamage(a, severity, zoneFor(a.physics.heading, nx, nz));
            this.applyContactDamage(b, severity, zoneFor(b.physics.heading, -nx, -nz));
            this.raceControl.log(
              'Contact between ' + a.driver.code + ' and ' + b.driver.code,
              'warning', this.time,
            );
          }
        }
      }
    }
  }

  /**
   * @param zone which face of the car took the hit, so the damage lands on the
   *             components that would actually have been in the way
   */
  private applyContactDamage(car: CarEntry, severity: number, zone: ImpactZone = 'front'): void {
    const broken = car.damage.applyImpact(zone, severity);

    // Rebuild the spec from the PRISTINE baseline every time. Deriving it from
    // the current spec instead compounds the multiplier on every hit, and the
    // car quietly decays to no performance while its health numbers still look
    // reasonable.
    car.physics.spec = car.damage.applyTo(car.physics.baseSpec);

    // Report the specific failure rather than a generic "damage", but only when
    // a component actually crosses into a worse band, so a graze stays quiet.
    for (const id of broken) {
      const h = car.damage.health[id];
      if (bandOf(h) === 'ok') continue;
      this.raceControl.log(
        car.driver.code + ': ' + COMPONENT_NAMES[id].toLowerCase() + ' damage',
        bandOf(h) === 'critical' ? 'critical' : 'warning', this.time, car.index,
      );
    }

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
  to.reverse = from.reverse;
}

/**
 * Which face of a car a world-space contact normal strikes.
 *
 * The normal points away from the car, into whatever hit it. Rotating it into
 * the car's own frame gives longitudinal and lateral components; whichever
 * dominates names the face. Without this every impact would land on the front
 * wing, and a car tapped from behind would lose its front wing rather than its
 * rear one.
 */
function zoneFor(heading: number, nx: number, nz: number): ImpactZone {
  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  // Forward is (sin, cos); right is (cos, -sin), matching the vehicle model.
  const along = nx * sinH + nz * cosH;
  const lateral = nx * cosH - nz * sinH;
  if (Math.abs(along) >= Math.abs(lateral)) return along > 0 ? 'front' : 'rear';
  return lateral > 0 ? 'right' : 'left';
}
