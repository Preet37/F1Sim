import { clamp, clamp01, damp, loopDelta, Rng, wrapDistance, MS_TO_KPH } from '../core/MathUtils';
import { PHYSICS_DT } from '../core/SimClock';
import { TrackSpline } from '../track/TrackSpline';
import { CarEntry } from './CarEntry';
import { RaceControlManager } from './RaceControlManager';
import { bandOf, COMPONENT_NAMES, type ImpactZone } from './DamageModel';
import { DRIVERS, getTeam, type Driver } from '../data/teams';
import { DRY_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { EnvironmentState, SurfaceType, VehicleControls } from '../physics/VehiclePhysics';
import type { Neighbour, AIDifficultyId } from '../ai/AIVehicleController';
import { createNeighbour } from '../ai/AIVehicleController';
import { pitLaneGeometry, type PitLaneGeometry } from '../track/PitGeometry';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import { buildWorldModel, type Obstacle, type WorldModel } from '../track/WorldObstacles';

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
  /**
   * How hard the AI field is to race against. Defaults to the medium level.
   *
   * Applies to the opposition only — the player's car has no AI to scale — and
   * the hard level is the calibrated baseline with every multiplier at 1, so
   * the validation harness measures the same field it always did.
   */
  aiDifficulty?: AIDifficultyId;
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
 * How near its own box a car has to be for the crew to take it, metres.
 *
 * Half a car length either side of the painted stop bar. Wide enough that a
 * driver who is roughly right is served, tight enough that "stop in your box"
 * is a real instruction and stopping in somebody else's does nothing.
 */
const PIT_BOX_WINDOW_M = 3.2;
/**
 * How far before its box a car pulls out of the fast lane and across into the
 * working lane — a car's length, plus the room to make the move in.
 */
const PIT_BOX_PULL_IN_M = 34;
/** How fast a car changes lane inside the pit lane, m/s. */
const PIT_LANE_SHIFT_MS = 3.5;
/**
 * Speed below which a car counts as stopped in its box, m/s.
 *
 * Walking pace. This is a "have you stopped" test, and it has to sit well below
 * the pit lane limiter — see the note in `updatePitLane` for what happens when
 * it does not.
 */
const PIT_BOX_STOP_SPEED_MS = 1.6;

/**
 * How late the strategist will leave the mandatory second compound, in laps.
 *
 * Late enough that the free choice is exhausted first — a stop taken to satisfy
 * the rule and nothing else is a stop taken as late as possible — but with
 * enough road left that a car which is held up, or which arrives at a closed
 * pit entry, still gets another chance before the flag.
 */
const MANDATORY_COMPOUND_MARGIN_LAPS = 4;

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
  barrier: 'the barrier',
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
  readonly cars: CarEntry[] = [];
  readonly raceControl: RaceControlManager;
  readonly weather: Weather;
  readonly config: SessionConfig;
  /**
   * The pit lane's plan, shared with the mesh builder and the paddock.
   *
   * Deriving box positions here from the same function that paints them is what
   * makes "stop in your box" mean anything: the simulation services a car at the
   * distance the paint is at, rather than at one arbitrary point on the lap.
   */
  readonly pitGeom: PitLaneGeometry;

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
    this.config = config;
    this.pitGeom = pitLaneGeometry(def, this.track.length);
    this.rng = new Rng(config.seed ^ 0x1f2e3d4c);
    // Race control draws from its own stream so that adding a decision there
    // cannot shift the sequence the rest of the simulation sees. A replayed
    // race has to neutralise identically.
    const rcRng = new Rng(config.seed ^ 0x7a3b1d95);
    this.raceControl = new RaceControlManager(this.track, () => rcRng.next());
    this.weather = new Weather(def, config.seed);

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
        config.aiDifficulty,
      );
      // Each car gets its own box. Slot order follows the entry list, which is
      // ordered by team with two cars per team — exactly the layout `boxS`
      // assumes when it puts two boxes in front of every garage.
      car.pitSlot = i;
      car.pitBoxS = this.pitGeom.boxS(i);
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

      for (let i = 0; i < field.length; i++) {
        const car = field[i];
        // Each car sits in its OWN box, under its own garage, rather than being
        // stacked in a queue backwards from a single point. That is where the
        // paint is and where the buildings are, and it is where a driver
        // looking for their car would expect to find it.
        car.placeOnTrack(this.track, car.pitBoxS, pit.lateralOffsetM, 0);
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
      // Where the car is BEFORE it moves, for the swept test against the solid
      // world below. Recorded here rather than at the end of the previous step
      // so that a car which was teleported (placed on the grid, reset by a
      // probe, craned back on) sweeps from where it now is and not from where
      // it used to be several hundred metres away.
      car.prevX = car.physics.position.x;
      car.prevZ = car.physics.position.y;
      car.prevHeading = car.physics.heading;
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
    this.raceControl.update(
      dt, this.cars, this.standings, this.time,
      this.config.kind === 'race', this.weather.wetness,
    );
    const leadLap = this.leaderLap();
    for (const car of this.cars) {
      car.blueFlag = this.config.kind === 'race' && this.raceControl.shouldShowBlueFlag(car, this.cars);
      // A car on the lead lap holds the racing line while the lapped runners
      // come past — Art. 55.14 / B5.13.4c.
      car.holdRacingLine = this.raceControl.lappedCarsWaved && car.lap >= leadLap;
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
    // The limit is where the barrier ACTUALLY stands at this node, on this
    // side, read from the world model. It used to be a flat fourteen metres
    // (two and a half on a street circuit) all the way round, which is wrong
    // wherever the circuit doubles back within that distance of itself: the
    // barrier is drawn pulled in, but the containment kept letting cars run
    // out to the nominal figure — straight through the wall on screen and into
    // the corridor between two sections of circuit.
    const lat0 = car.lateral;
    // `containment`, not `barrierOffsets`: the same line wherever a wall
    // stands, but closed across the gaps BETWEEN walls. A gap in the chain is
    // not an invitation to leave — the chain resumes two metres off the track
    // edge at the far end of it, and a car that used the gap to get fifteen
    // metres out arrives beside a wall it is already behind. See
    // `containmentOffsets`.
    const off = lat0 >= 0
      ? this.world.containment.left[idx]
      : this.world.containment.right[idx];
    // A zero offset means the barrier gives way to the pit lane or the
    // paddock. There the pit wall is the boundary, and it is enforced as a real
    // object by `collideWithObstacles`; the spline limit only has to stop a car
    // wandering off into the landscape behind it.
    // `garageFace` is already measured from the centreline, not from the track
    // edge — adding the half width to it puts the backstop several metres
    // behind the garages, which is where a car that lost its pit-lane flag
    // ended up parked.
    let limit = off > 0 ? halfWidth + off : this.pitGeom.garageFace;

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
      // The other side of the lane is the pit wall, and that is a real object
      // in `collideWithObstacles` — solid from the lane as well as from the
      // circuit. It used to be enforced here as a second, spline-relative
      // clamp, which meant two mechanisms fighting over the same car through
      // the entry and exit tapers and a car at speed slipping between them.
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
   *
   * TWO passes, and the order matters.
   *
   * `sweepIntoObstacles` runs first and asks where along this step's motion the
   * car FIRST touched something, then puts it there. The pass below it asks only
   * about the position the car is at now. On its own that second question is not
   * enough, and the reason is arithmetic: a step at 120Hz is 8.3ms, so a car at
   * 72 m/s covers 0.6m in one, and a barrier box is 1.2m thick in plan. Sample
   * the endpoints of a 0.6m stride either side of a thin wall and both are
   * legitimately clear of it — the wall passes between two consecutive frames
   * and never reports a contact at all. That is a tunnel, and it does not need
   * anything exotic to happen: driving at a barrier at 260 km/h is enough.
   *
   * The discrete pass is kept because the swept one does not replace it. A car
   * resting against a wall, or pushed into one by another car after this runs,
   * has no motion to sweep and still has to be pushed back out.
   */
  private collideWithObstacles(car: CarEntry, dt: number): void {
    const field = this.world.obstacles;
    if (field.isEmpty) return;

    const p = car.physics;
    const reach = DISC_OFFSETS_M[0] + DISC_RADIUS_M;

    // ONE broadphase query for both passes. A circle around the midpoint of the
    // step's motion, grown by half its length, contains the whole swept
    // footprint and therefore also the end position the discrete pass needs —
    // so sweeping costs no extra grid work, which is what makes it affordable
    // for twenty cars at 120Hz.
    const travelX = p.position.x - car.prevX;
    const travelZ = p.position.y - car.prevZ;
    const travel = Math.hypot(travelX, travelZ);
    field.query(
      (car.prevX + p.position.x) * 0.5,
      (car.prevZ + p.position.y) * 0.5,
      reach + travel * 0.5,
      this.obstacleHits,
    );

    this.sweepIntoObstacles(car, dt, travel);

    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);

    for (const oi of this.obstacleHits) {
      const o: Obstacle = field.obstacles[oi];
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

  /**
   * The swept half of the static-world collision: where along this step's
   * motion did the car first touch something, and put it there.
   *
   * The car's footprint is the same three discs as everywhere else, and each
   * one traces a segment from where it was at the top of the step to where it
   * is now. A disc of radius r sweeping against a box is, by the standard
   * Minkowski argument, a POINT sweeping against that box grown by r — so each
   * test is a ray against a box in the box's own frame, which the slab method
   * answers in a handful of multiplies. Growing the box squares off the corners
   * that ought to be rounded, which can register a corner contact a couple of
   * centimetres early; erring toward "solid" is the right way to be wrong here.
   *
   * The earliest contact across every disc and every candidate box wins, the
   * car is placed at that fraction of its motion, and the impact is booked
   * exactly as the discrete pass books one. Everything after the contact point
   * is discarded, which is the whole point: the car stops AT the wall instead of
   * being teleported to the far side of it and asked afterwards where it is.
   *
   * @param travel length of this step's motion, m — already computed by the
   *   caller for the broadphase.
   */
  private sweepIntoObstacles(car: CarEntry, dt: number, travel: number): void {
    const p = car.physics;
    // Below a few centimetres the endpoint test cannot miss anything, and above
    // a few metres this is not a step of motion at all — it is a car being
    // placed on the grid, recovered by the marshals or reset by a probe, and
    // sweeping the line to wherever it came from would collide it with every
    // wall in between.
    if (travel < 0.02 || travel > 8) return;

    // Captured before anything below moves the car.
    const moveX = p.position.x - car.prevX;
    const moveZ = p.position.y - car.prevZ;

    const sin1 = Math.sin(p.heading);
    const cos1 = Math.cos(p.heading);
    const sin0 = Math.sin(car.prevHeading);
    const cos0 = Math.cos(car.prevHeading);

    let bestT = Infinity;
    let bnx = 0;
    let bnz = 0;
    let bestIndex = 0;

    const all = this.world.obstacles.obstacles;
    for (const oi of this.obstacleHits) {
      const o: Obstacle = all[oi];
      // The box grown by the disc radius, so the disc becomes a point.
      const ex = o.halfX + DISC_RADIUS_M;
      const ez = o.halfZ + DISC_RADIUS_M;

      for (const off of DISC_OFFSETS_M) {
        // The disc's path, taken relative to the box centre and rotated into
        // the box's frame — the same frame convention as the discrete pass.
        const ax = car.prevX + sin0 * off - o.x;
        const az = car.prevZ + cos0 * off - o.z;
        const bx = p.position.x + sin1 * off - o.x;
        const bz = p.position.y + cos1 * off - o.z;

        const lax = ax * o.cos - az * o.sin;
        const laz = ax * o.sin + az * o.cos;
        const lbx = bx * o.cos - bz * o.sin;
        const lbz = bx * o.sin + bz * o.cos;

        // Already overlapping at the top of the step: not a tunnel, and the
        // discrete pass owns it.
        if (Math.abs(lax) < ex && Math.abs(laz) < ez) continue;

        const dx = lbx - lax;
        const dz = lbz - laz;

        // Slab method. `tIn` climbs to the last entry, `tOut` falls to the
        // first exit; they cross over when the ray misses the box entirely.
        let tIn = 0;
        let tOut = 1;
        // Which face the ray enters through, as a local-frame unit normal.
        let nlx = 0;
        let nlz = 0;

        let miss = false;
        for (let axis = 0; axis < 2 && !miss; axis++) {
          const a = axis === 0 ? lax : laz;
          const d = axis === 0 ? dx : dz;
          const e = axis === 0 ? ex : ez;
          if (Math.abs(d) < 1e-9) {
            // Parallel to this pair of faces: either inside the slab for the
            // whole sweep, or outside it for the whole sweep.
            if (Math.abs(a) > e) miss = true;
            continue;
          }
          let t1 = (-e - a) / d;
          let t2 = (e - a) / d;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          // Whichever of the two faces is entered, it is always the one facing
          // INTO the oncoming ray, so its outward normal is simply -sign(d).
          // This does not depend on which of t1/t2 turned out to be the smaller
          // and must not be flipped along with them: doing so hands back an
          // inward normal for every approach from the box's positive side,
          // which pushes the car through the wall instead of stopping it at it.
          const sign = d > 0 ? -1 : 1;
          if (t1 > tIn) {
            tIn = t1;
            nlx = axis === 0 ? sign : 0;
            nlz = axis === 0 ? 0 : sign;
          }
          if (t2 < tOut) tOut = t2;
          if (tIn > tOut) miss = true;
        }
        // `nlx === 0 && nlz === 0` means the entry time never moved off zero,
        // i.e. the start point was already inside the grown box on both axes.
        if (miss || tIn > tOut || tIn >= bestT || (nlx === 0 && nlz === 0)) continue;

        bestT = tIn;
        bnx = nlx * o.cos + nlz * o.sin;
        bnz = -nlx * o.sin + nlz * o.cos;
        bestIndex = oi;
      }
    }

    if (bestT === Infinity) return;

    // Stop the car at the contact point, held a hair off the surface so the
    // discrete pass finds no penetration and does not book the same impact a
    // second time.
    const skin = 1e-3;
    p.position.x = car.prevX + moveX * bestT + bnx * skin;
    p.position.y = car.prevZ + moveZ * bestT + bnz * skin;

    const severity = p.collideWithBarrier(-bnx, -bnz, dt);
    this.onSolidImpact(car, severity, -bnx, -bnz, OBSTACLE_NAMES[all[bestIndex].kind]);
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

    const rc = this.raceControl;
    p.localYellow = rc.overtakingBannedAt(car.s) || car.holdUntilLine;
    p.yellowLevel = rc.yellowLevelAt(car.s);
    p.blueFlag = car.blueFlag;
    p.neutralised = rc.neutralisation !== 'none';
    p.neutralisedTargetMs = rc.vscTargetMs;
    p.neutralisedScale = rc.neutralisedScale;
    p.neutralisedCatchUpMult = rc.catchUpMult;
    p.queueGapM = rc.queueGapLimitM(car, car.position === 1);
    p.mustUnlap = car.mustUnlap;
    p.holdRacingLine = car.holdRacingLine;
    p.holdUntilLine = car.holdUntilLine;
    p.wetness = this.weather.wetness;
    p.blendRemainingM = car.blendRemainingM;
    p.pitThisLap = this.shouldPit(car);

    // Distance to this car's own box, once it is committed to the lane and
    // still owes it a stop. -1 means "nothing to stop for".
    if (car.inPitLane && !car.servicedThisVisit && !car.inPitBox && !car.pitTransitOnly) {
      const d = loopDelta(car.s, car.pitBoxS, len);
      // Only ahead of us, and only within the lane. A box already passed is not
      // something to brake for, and the wrap-around would otherwise report a
      // box just behind the car as being a full lap away.
      p.pitBoxAheadM = d >= -PIT_BOX_WINDOW_M && d < len * 0.5 ? Math.max(d, 0) : -1;
    } else {
      p.pitBoxAheadM = -1;
    }
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
        const behindM = Math.max(0, leader.totalDistance - car.totalDistance);
        // Whole laps down, from distance rather than from lap counters: a car
        // ten metres behind a leader who has just crossed the line is not a lap
        // down, though its lap counter says it is.
        car.lapsDown = Math.floor(behindM / this.track.length);
        // Convert a distance deficit into a time gap at a REPRESENTATIVE pace,
        // not at whatever speed the car happens to be doing this instant.
        //
        // Instantaneous speed is the wrong divisor and it showed: a car in a
        // slow corner, or under the pit limiter, divides its distance deficit
        // by a third of racing speed and its gap trebles for a second before
        // snapping back. The tower's numbers jittered by tens of seconds every
        // lap with nothing happening on the road.
        const pace = this.referencePaceMs();
        car.gapToLeader = behindM / pace;
        car.interval = i === 0
          ? 0
          : Math.max(0, arr[i - 1].totalDistance - car.totalDistance) / pace;
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

  /**
   * A representative on-track pace, m/s, for turning distance gaps into times.
   *
   * The leader's most recent lap when there is one, because that is the pace
   * the gaps are actually being opened and closed at; the circuit's reference
   * lap before anyone has completed one.
   */
  private referencePaceMs(): number {
    const leader = this.standings[0];
    const lapTime = leader && leader.lastLapTime > 5
      ? leader.lastLapTime
      : this.track.referenceLapTime;
    return this.track.length / Math.max(lapTime, 1);
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

    // Racing resumes for THIS car at the Line, not when the safety car left the
    // circuit: "no driver may overtake ... until they pass the Line for the
    // first time after the Safety Car has entered the Pit Entry Road"
    // (2025 Art. 55.8 / 2026 Art. B5.13.2c). The leader is racing again while a
    // car half a lap back still is not, which is why the flag is per-car.
    car.holdUntilLine = false;
    // A car that has unlapped itself has completed the manoeuvre.
    if (car.mustUnlap && this.raceControl.lappedCarsWaved) {
      const leader = this.standings[0];
      if (leader && car.lap >= leader.lap) car.mustUnlap = false;
    }

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

  /**
   * Calls the player in, or cancels the call. Owned by the UI.
   *
   * Written to `pitRequested` and not to `perception.pitThisLap`, because the
   * perception buffer is rebuilt from scratch every physics step and any request
   * left there is erased within 8ms.
   */
  requestPit(car: CarEntry, on: boolean): void {
    car.pitRequested = on;
  }

  /** Does the strategy want this car in the pits on this lap? */
  /**
   * Why the player should be thinking about the pit lane, or null if they
   * should not.
   *
   * The AI has known this all along — `shouldPit` below is exactly this
   * decision, made every step for nineteen cars — and the player was the one
   * car it was never told to. Nothing is being given away: this is the radio
   * call the driver would already have had.
   */
  pitAdvice(car: CarEntry): string | null {
    if (this.config.kind !== 'race') return null;
    if (car.inPitLane || car.retired || car.finished || car.disqualified) return null;

    const pen = car.pendingServePenalty();
    if (pen !== null) {
      return pen.kind === 'drive-through' ? 'DRIVE-THROUGH TO SERVE' : 'PENALTY TO SERVE';
    }
    if (car.damage.worst().health < 0.7) return 'DAMAGE — PIT FOR REPAIRS';

    const onSlicks = !getCompound(car.compound).isWetWeather;
    if (this.weather.wetness > 0.4 && onSlicks) return 'RAIN — WET TYRES';
    if (this.weather.wetness < 0.12 && !onSlicks && car.physics.rearTires.lapsOnSet > 2) {
      return 'TRACK DRY — SLICKS';
    }

    const wear = car.physics.rearTires.wear;
    if (wear < 0.24) return 'TYRES GONE';

    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const lapsLeft = totalLaps - car.lap;
    if (!this.weather.hasRained && lapsLeft <= MANDATORY_COMPOUND_MARGIN_LAPS) {
      const dryUsed = new Set(car.usedCompounds.filter((c) => !getCompound(c).isWetWeather));
      if (dryUsed.size < 2) return 'SECOND COMPOUND REQUIRED';
    }
    if (wear < 0.45) return 'TYRES WORN — PIT WINDOW OPEN';
    return null;
  }

  /**
   * What the crew would do at this car's next stop, and why — the briefing the
   * pit screen shows before the driver chooses.
   *
   * Everything here is read from the same functions that run the stop, so the
   * screen cannot describe a stop the engine would not perform. `compound` is
   * literally `chooseCompoundForStint`'s answer with the driver's own override
   * removed, which is what makes it honest to label it "the engineers' call".
   */
  pitBriefing(car: CarEntry): {
    compound: CompoundId;
    /** Dry compounds already used, for the mandatory-two rule. */
    dryUsed: CompoundId[];
    /** True when reaching the flag without another dry compound is a DSQ. */
    secondCompoundRequired: boolean;
    /** Front wing condition, 0..1, and whether the crew would change it. */
    frontWing: number;
    noseChangeAdvised: boolean;
    /** Seconds the stationary time would cost a nose change. */
    noseChangeCostS: number;
    /** Estimated stationary time without a nose change. */
    baseStopS: number;
    lapsRemaining: number;
  } {
    const held = car.pitCompoundRequest;
    car.pitCompoundRequest = null;
    const compound = this.chooseCompoundForStint(car);
    car.pitCompoundRequest = held;

    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const dryUsed = [...new Set(car.usedCompounds.filter((c) => !getCompound(c).isWetWeather))];
    const frontWing = Math.min(car.damage.health.frontWingL, car.damage.health.frontWingR);

    return {
      compound,
      dryUsed,
      secondCompoundRequired:
        this.config.kind === 'race' && !this.weather.hasRained && dryUsed.length < 2,
      frontWing,
      noseChangeAdvised: frontWing < 0.7,
      noseChangeCostS: frontWing < 0.999 ? 9 + (1 - frontWing) * 5 : 0,
      baseStopS: car.team.performance.pitCrewTimeS,
      lapsRemaining: Math.max(0, totalLaps - car.lap),
    };
  }

  private shouldPit(car: CarEntry): boolean {
    // The player is called in by the player, not by the strategist. Their
    // request is a latch that survives until it is served or cancelled.
    if (car.isPlayer) return car.pitRequested && !car.inPitLane;
    if (this.config.kind !== 'race') return false;
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
    if (plannedStopDue || tyresGone) return true;

    // The mandatory second compound.
    //
    // Reaching the flag on a single dry compound is a disqualification, not a
    // time penalty, and `checkMandatoryCompounds` duly applies it. Until now no
    // car ever pitted, so the rule never bit and nobody noticed the strategist
    // had no concept of it. With stops working it bites immediately: over a
    // short race the cars whose tyres happened to last were disqualified en
    // masse for a rule they had made no plan to satisfy.
    //
    // A real strategist takes the stop before the end whatever the tyres are
    // doing, because a slow stop costs twenty seconds and a disqualification
    // costs the race. This is that decision.
    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const lapsLeft = totalLaps - car.lap;
    if (!this.weather.hasRained && lapsLeft <= MANDATORY_COMPOUND_MARGIN_LAPS) {
      const dryUsed = new Set(car.usedCompounds.filter((c) => !getCompound(c).isWetWeather));
      if (dryUsed.size < 2) return true;
    }

    // The cheap stop.
    //
    // A stop under a neutralisation costs a fraction of what it costs under
    // green, because the whole field is circulating slowly while you serve the
    // pit lane. Every strategist in the paddock takes it, and an AI that did
    // not would be leaving the single biggest strategic swing in the sport on
    // the table. It is legal — the pit lane is NOT closed by a safety car in
    // the current regulations — but it is legal only for one purpose: "no F1
    // Car may enter the pits whilst the Safety Car is deployed unless it is for
    // the purpose of changing tyres" (2025 Art. 55.12 / 2026 Art. B5.13.3, and
    // identically for the VSC at Art. 56.4 / B5.12.3).
    if (this.raceControl.neutralisation !== 'none') {
      const worthIt = car.physics.rearTires.lapsOnSet > 6 &&
        car.targetPitLap > 0 &&
        this.raceControl.mayEnterPitLane(true, false);
      if (worthIt) return true;
    }
    return false;
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

      // Is the driver ALLOWED in? Under a neutralisation the lane stays open
      // but only for tyres (Art. 55.12 / B5.13.3, Art. 56.4 / B5.12.3), and the
      // Race Director may close the entry outright, in which case only
      // "essential and entirely evident repairs" get through (2025 Art. 34.15 /
      // 2026 Art. B1.6.4). A car serving a penalty is obliged to come in and is
      // not making a free choice, so it is let through either way.
      const forRepairs =
        car.damage.worst().health < 0.7 || car.pendingServePenalty() !== null;
      const allowed = this.raceControl.mayEnterPitLane(true, forRepairs);
      if (wantsPit && !allowed && !car.pitEntryRefused) {
        car.pitEntryRefused = true;
        this.raceControl.log(
          car.driver.code + ' — pit entry closed, stay out',
          'warning', this.time, car.index,
        );
      }
      if (!wantsPit) car.pitEntryRefused = false;

      // You get into the pit lane from the PIT SIDE of the road, by crossing the
      // line into the entry road — not from wherever you happen to be.
      //
      // Without this the entry was purely a distance test, so a car on the far
      // edge of the track when it reached the entry line was simply dragged the
      // full width of the circuit into the lane, at whatever speed it was doing.
      // At Monza that produced a car crossing the entry at 179 km/h on the wrong
      // side, collecting a drive-through it had earned, scraping the length of
      // the pit wall — front wing 0.84 down to 0.10 — and missing its box. A car
      // that is not on the pit side at the entry has missed the pit entry, which
      // is what happens in a race, and it comes round again.
      const pitSide = Math.sign(pit.lateralOffsetM) || -1;
      const onPitSide = car.lateral * pitSide > -this.track.halfWidthAt(car.s) * 0.5;
      if (wantsPit && allowed && !onPitSide && geometricallyInLane && fromEntry < 40
          && !car.pitEntryMissed) {
        car.pitEntryMissed = true;
        this.raceControl.log(
          car.driver.code + ' missed the pit entry — round again',
          'warning', this.time, car.index,
        );
      }
      if (!geometricallyInLane) car.pitEntryMissed = false;

      if (wantsPit && allowed && onPitSide && geometricallyInLane && fromEntry < 40) {
        car.inPitLane = true;
        car.lastPitLap = car.lap;
        // Every per-visit flag is cleared HERE, on the way in, not on the way
        // out. Clearing them on exit is the same thing only when the exit path
        // actually runs, and it does not always: a car that retires in the
        // lane, is placed in the lane at the start of a session, or is put back
        // on track by the recovery code leaves `servicedThisVisit` latched true
        // — and a latched flag means the next visit drives straight past the
        // box without stopping, for the rest of the race. Resetting on entry
        // makes a visit self-contained and is why a car can now pit twice.
        car.servicedThisVisit = false;
        car.inPitBox = false;
        car.pitBoxTimer = 0;
        car.pitSpeedingFlagged = false;
        // A drive-through is served by transiting the lane without stopping.
        // A stop-go is not — that one is served stationary in the box.
        const pen = car.pendingServePenalty();
        car.pitTransitOnly = pen !== null && pen.kind === 'drive-through';
      }
      return;
    }

    // Held at the pit exit while unlapped cars rejoin the queue.
    //
    // "the pit lane exit may be closed at the race director's sole discretion
    // while these cars rejoin" — 2025 Art. 55.14 / 2026 Art. B5.13.4c. A car
    // released into the middle of a line of cars unlapping themselves at three
    // times its speed is exactly the situation the discretion exists for. The
    // red light at the end of the lane is the mechanism: "F1 Cars may only be
    // driven out of the Pit Lane when the light at the end of the Pit Lane is
    // green" (2025 Art. 37.2 / 2026 Art. B1.6.3e).
    const atExitLight = toExit >= 0 && toExit < 25;
    if (this.raceControl.pitExitClosed && atExitLight && car.servicedThisVisit) {
      car.physics.velocity.set(0, 0);
      car.physics.localVelX = 0;
      car.physics.localVelY = 0;
      car.pitExitHold += dt;
      return;
    }
    car.pitExitHold = 0;

    if (!geometricallyInLane && !car.inPitBox) {
      // Left the lane. The lap in progress ran through the pit lane, so it is
      // an out-lap and its time must not be classified.
      car.inPitLane = false;
      car.onOutLap = true;
      car.blendRemainingM = PIT_EXIT_BLEND_M;
      car.pitSpeedingFlagged = false;
      car.servicedThisVisit = false;
      // The call has been answered. Leaving it latched would send the car
      // straight back down the pit lane on the next lap, for ever.
      car.pitRequested = false;
      // A drive-through is discharged by the transit itself, and it has just
      // been completed.
      if (car.pitTransitOnly) {
        const pen = car.pendingServePenalty();
        if (pen && pen.kind === 'drive-through') {
          pen.served = true;
          this.raceControl.log(
            car.driver.code + ' has served the drive-through penalty',
            'info', this.time, car.index,
          );
        }
        car.pitTransitOnly = false;
      }
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
    // WHERE in the lane depends on what the car is here to do.
    //
    // A car passing through runs down the fast lane, which is the lane centre.
    // A car being serviced pulls ACROSS into the working lane and stops on its
    // own box, against the garages — which is where the paint is, where the crew
    // stands and where the marker is drawn. Servicing the car on the lane centre
    // left it stopped in the middle of the road with its box, its crew and its
    // marker four metres away to the side: "it says my box is 0m away but where,
    // I don't see shit" is precisely that, and it was right.
    const workingLat = this.pitGeom.sign * (this.pitGeom.divider + this.pitGeom.garageFace) * 0.5;
    const headingForBox = !car.servicedThisVisit && !car.pitTransitOnly;
    const pullingIn = headingForBox && loopDelta(car.s, car.pitBoxS, len) < PIT_BOX_PULL_IN_M;
    const targetLat = pullingIn || car.inPitBox ? workingLat : pit.lateralOffsetM;

    // Moved at a rate a car can actually change lane at, rather than at whatever
    // rate closes the gap. The correction used to be proportional and unbounded:
    // at the pit entry the error is the full width of the lane, which came out
    // as two tenths of a metre PER STEP — twenty-four metres a second sideways,
    // faster than the car was going forwards. The car does not feel it, because
    // it is a displacement and not a velocity, but the driver watches the world
    // slide across the screen and corrects for a slide that is not there.
    //
    // With one hard constraint on top: the entry road has to be finished with by
    // the time the lane is fully open, because the PIT WALL starts there and it
    // is solid. Merely slowing the transition down put the car alongside the
    // wall while it was still crossing the line of it, and it stopped dead
    // against it forty metres inside the lane. So the rate is whatever the
    // remaining entry road demands, and the cap applies only where there is room
    // for it — which is everywhere except the entry itself.
    const idx = this.track.indexAt(car.s);
    const want = targetLat - car.lateral;
    const roadLeftM = this.pitGeom.entryOpenU - this.pitGeom.u(car.s);
    let rate = PIT_LANE_SHIFT_MS;
    if (roadLeftM > 0) {
      const secsLeft = roadLeftM / Math.max(car.physics.speedMs, 6);
      rate = secsLeft > 0.05 ? Math.max(rate, Math.abs(want) / secsLeft) : Infinity;
    }
    const shift = Math.min(Math.abs(want), rate * dt) * Math.sign(want);
    car.physics.position.x += this.track.nx[idx] * shift;
    car.physics.position.y += this.track.nz[idx] * shift;

    // The box.
    //
    // THIS car's box, not a single point on the lap shared by twenty cars, and
    // the stop is triggered by the car having actually STOPPED in it rather
    // than by a speed threshold it could never satisfy.
    //
    // The old test was `speedMs < 22` at a pit lane limited to 80 km/h. 80 km/h
    // is 22.22 m/s, so a car sitting exactly on its limiter — which is what
    // every car in a pit lane is doing — was always above the threshold by a
    // fifth of a metre a second, and the condition never once became true. Cars
    // drove into the pit lane, straight through the box at the limit, and out
    // the other end: `pitStops` was zero for all twenty cars in a full race,
    // no tyres were ever changed, and every car was disqualified at the flag
    // under the two-compound rule. It also meant the strategy never advanced,
    // because `targetPitLap` is only moved on by a completed stop.
    //
    // One service per visit: without the guard a car that is still within the
    // box window after being serviced simply gets serviced again.
    const toBox = loopDelta(car.s, car.pitBoxS, len);
    const inBoxWindow = toBox > -PIT_BOX_WINDOW_M && toBox <= PIT_BOX_WINDOW_M;
    if (!car.inPitBox && !car.servicedThisVisit && !car.pitTransitOnly && inBoxWindow &&
        car.physics.speedMs < PIT_BOX_STOP_SPEED_MS) {
      car.inPitBox = true;
      const crewTime = car.team.performance.pitCrewTimeS;
      // Occasional slow stop — a sticking wheel gun is part of racing.
      const fumble = this.rng.chance(0.06) ? this.rng.range(1.2, 5.5) : 0;
      car.pitBoxTimer = crewTime + this.rng.range(-0.15, 0.35) + fumble;

      // A damaged nose costs real time to change: the crew has to remove the
      // old assembly and fit a new one, and that is why a driver with a broken
      // wing weighs limping to the end against losing a dozen seconds now.
      //
      // The crew's own rule is "change it below 70%". A driver who has been
      // asked can overrule it in either direction, and the decision is latched
      // HERE rather than read again on release: the timer charged for the stop
      // and the work actually done have to be the same decision, or a player
      // who changed their mind mid-stop would be billed for a wing they did not
      // get, or get one they did not pay for.
      const frontWing = Math.min(car.damage.health.frontWingL, car.damage.health.frontWingR);
      car.pitNoseChanging = car.pitNoseChangeRequest ?? (frontWing < 0.7);
      if (car.pitNoseChanging && frontWing < 0.999) {
        car.pitBoxTimer += 9 + (1 - frontWing) * 5;
      }

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
        //
        // The nose is separable from the bodywork because it is the expensive
        // half of the job: the sidepod panels come off and on inside the tyre
        // stop, the front wing assembly does not. A driver who declined the
        // wing keeps the damage and keeps the nine seconds.
        if (car.pitNoseChanging) car.damage.repair('frontWingL', 'frontWingR');
        car.damage.repair('sidepodL', 'sidepodR');
        car.physics.spec = car.damage.applyTo(car.physics.baseSpec);
        // The driver's instructions were for THIS stop. Leaving them latched
        // would silently apply a Monaco tyre call to a stop twenty laps later.
        car.pitCompoundRequest = null;
        car.pitNoseChangeRequest = null;
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
    // A driver who has told the crew what to fit gets what they asked for,
    // including when it is a mistake. The pit screen states the mandatory
    // second-compound position and the weather in plain terms before the choice
    // is made; overriding it here would make the screen a suggestion box.
    if (car.pitCompoundRequest) return car.pitCompoundRequest;

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
