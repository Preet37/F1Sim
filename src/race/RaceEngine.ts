import { clamp, clamp01, damp, loopDelta, Rng, wrapDistance, MS_TO_KPH } from '../core/MathUtils';
import { PHYSICS_DT } from '../core/SimClock';
import { TrackSpline } from '../track/TrackSpline';
import { CarEntry } from './CarEntry';
import {
  compoundsAvailableTo, crossoverCandidates, crossoverCase, isWetCompound, stintLife,
} from './Strategy';
import { PitWall, Weather, wetCompoundFor, type PitWallContext } from './Weather';
import { RaceControlManager } from './RaceControlManager';
import {
  bandOf, COMPONENT_NAMES, BODY_PART_IDS, PART_DETACH_HEALTH, PART_REPAIR_HEALTH,
  PART_SIZE_M, type BodyPartId, type ImpactZone,
} from './DamageModel';
import { DebrisField } from './DebrisField';
import { classificationTier } from './Classification';
import { DRIVERS, getTeam, type Driver } from '../data/teams';
import { DRY_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { EnvironmentState, SurfaceType, VehicleControls } from '../physics/VehiclePhysics';
import type { Neighbour, AIDifficultyId } from '../ai/AIVehicleController';
import { corneringSpeedLimitMs, createNeighbour } from '../ai/AIVehicleController';
import {
  CONTACT_WIDTH_M, HAZARD_CORRIDOR_M, lateralOverlap, safeFollowSpeedMs,
} from '../ai/TrafficAwareness';
import { pitLaneGeometry, type PitLaneGeometry } from '../track/PitGeometry';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import { buildWorldModel, type Obstacle, type WorldModel } from '../track/WorldObstacles';
import {
  PIT_ENTRY_DECEL_MS2, PIT_ENTRY_RESCUE_M, PIT_ENTRY_SCAN_M, PIT_ENTRY_SETTLE_M,
  PIT_LIMITER_ARM_M, brakeFor, pitEntryCeilingMs, pitEntryRoomNeededM,
  pitEntryTargetMs, pitLimiterShedDistanceM,
} from '../physics/PitLimiter';
import {
  NEUTRAL_COMMITMENT, UNLAP_PACE_MULT, neutralisedLimit, neutralisedPlan, queueHoldMs,
} from '../physics/NeutralisedLimiter';

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
   * Car indices that are entered in this segment but may not run in it.
   *
   * Art. B4.3.2 — a car the marshals had to recover during qualifying takes no
   * further part in the session. These cars stay in `participants`, so they are
   * counted and classified, and are simply never released from the garage. They
   * set no time and Art. B2.4.3a.v(C) ranks them accordingly.
   */
  withdrawn?: readonly number[];
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

/**
 * `Weather` used to be defined here, inline, in forty lines that drifted one
 * number between 0 and 1. It now lives in `./Weather` along with the water it
 * puts on the road and the pit wall that can see it coming — see that file's
 * header for why. Re-exported because a good deal of code says
 * `import { Weather } from './RaceEngine'` and there is nothing wrong with it.
 */
export { Weather, PitWall, TrackSurface, Forecast } from './Weather';
export type {
  RadioCall, RadioAnswer, ForecastReading, PitWallContext, Precipitation,
} from './Weather';

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
 * How many laps early a strategist will pull a planned stop forward to take
 * advantage of a neutralisation.
 *
 * ONE. The saving on offer is the pit loss you were going to pay anyway, so it
 * only exists if you were going to pay it very soon; pulled further forward the
 * "cheap" stop costs a set of tyres with most of its life left and leaves a final
 * stint too long for the one that replaces it. A neutralisation lasts several
 * laps, so a lap of reach is enough for any car whose window opens while it is
 * running — and it is short enough that the plan the player was shown is still
 * recognisably the plan the race executed. See the note at the call site for
 * what a generous version of this did to the field.
 */
const NEUTRALISED_PULL_FORWARD_LAPS = 1;

/**
 * Tyre life at which a stop is due on its own merits, 0..1.
 *
 * Deliberately the same number `pitAdvice` uses for "TYRES WORN — PIT WINDOW
 * OPEN". The player is given that radio call and the AI acts on it; if the two
 * were different constants the strategist would be recommending one thing and
 * doing another, which is the failure this whole area exists to avoid.
 */
const TYRE_PIT_WINDOW = 0.45;

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

/** Neighbour records kept per car: ahead, behind, left, right, hazard. */
const NEIGHBOUR_SLOTS = 5;

/**
 * Deceleration the perception sweep assumes when it RANKS hazards, m/s².
 *
 * Only a scoring constant. The engine's job here is to decide which of the cars
 * in front is the one worth reporting; the controller then recomputes the answer
 * from its own live grip, downforce and tyre state, which is the number that
 * actually decides the pedal. Deliberately on the optimistic side so the ranking
 * does not smother a genuinely urgent hazard behind a merely close one.
 */
const HAZARD_REFERENCE_DECEL_MS2 = 22;

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

/**
 * Impact severity above which loose carbon comes off the car.
 *
 * `severity` is the closing speed divided by 12 m/s, so this is a 6.6 m/s hit —
 * hard enough to break an endplate off, and well clear of the wheel-to-wheel
 * rubbing that goes on all race. The old figure was 0.45, which is a 5.4 m/s
 * nudge, and combined with up to six pieces per event it carpeted the circuit.
 */
const IMPACT_SHED_SEVERITY = 0.55;

/**
 * Size of the piece of bodywork a hard contact breaks off, metres.
 *
 * A front wing endplate, roughly, which is what usually goes. The shards drawn
 * from it are a fraction of this again — see `Wreckage.spawn`.
 */
const IMPACT_SHARD_SIZE_M = [0.45, 0.12, 0.35] as const;

/** How far above the road each part is mounted, metres. */
const PART_MOUNT_HEIGHT_M: Record<BodyPartId, number> = {
  frontWing: 0.16, rearWing: 0.85, sidepodL: 0.42, sidepodR: 0.42,
};

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

  /**
   * Whether the player's neutralised speed limit is applied for them.
   *
   * On, always, in the game. It exists as a switch for one reason: an assist is
   * worth whatever the difference is between having it and not, and that is a
   * measurement rather than an argument. `probe:neutralplayer` runs each
   * scenario twice — the same seed, the same driver, the same staged safety car
   * — and reports both, which is how the size of the defect this fixes is
   * known rather than asserted.
   */
  neutralisationAssist = true;

  /** Session elapsed time, seconds. */
  time = 0;
  /** True once the session has finished. */
  over = false;
  /** Countdown before a standing start releases the cars. */
  startLights = 0;
  started = false;

  /** Cars in classified order. Rebuilt each timing tick, never reallocated. */
  readonly standings: CarEntry[] = [];

  /**
   * Impacts since the renderer last looked.
   *
   * The renderer cannot detect a collision for itself: contact is resolved
   * inside a 120Hz physics step and is over well before the next frame is
   * drawn, so a hit at 300 km/h can happen, damage the car and finish between
   * one drawn frame and the next with nothing on screen to say it did. This is
   * the only channel that carries "something just hit something" out of the
   * simulation, and it is why `EffectsDirector.reportImpact` had never once
   * fired despite being written, wired and correct.
   *
   * A plain array, drained by the renderer each frame and bounded so a pile-up
   * cannot grow it without limit. Cars are named by index rather than by
   * reference so nothing here keeps a car alive past a session.
   */
  readonly impacts: { carIndex: number; severity: number }[] = [];

  /**
   * The carbon lying on the circuit, and the marshals coming for it.
   *
   * In the simulation rather than the renderer because it raises FLAGS, and a
   * flag changes how the race is driven. A headless race and a rendered one
   * have to come out the same, so the thing that puts a yellow out cannot live
   * in the half of the program that only exists when there is a screen. See
   * `DebrisField.ts`.
   */
  readonly debris = new DebrisField();

  /**
   * The environment the physics reads, rewritten PER CAR before that car steps.
   *
   * It used to be written once per step and shared, which was correct while
   * `wetness` was a session-wide scalar. It is not one any more: the water on a
   * wet circuit is deeper in the dips and shallower on the line the cars have
   * been clearing, and a car that moves two metres sideways is driving on a
   * different surface. So this is now scratch space — filled in from
   * `weather.surface` at the position the car occupies, immediately before
   * `physics.step` reads it — and nothing may hold a reference to it expecting
   * the values to still be about their own car.
   */
  readonly environment: EnvironmentState = {
    trackTempC: 38, airTempC: 24, wetness: 0, surfaceGrip: 1,
    airDensityRatio: 1, abrasion: 1,
  };

  /**
   * The pit wall, one per car, keyed by car index.
   *
   * Every car gets one because the decision is per car — a leader and a
   * backmarker on different tyres get different calls at different moments —
   * but only the player's is ever asked a question. See `updatePitWall`.
   */
  readonly pitWalls: PitWall[] = [];

  private readonly rng: Rng;
  /** Reused neighbour records, five per car, so perception never allocates. */
  private readonly neighbourPool: Neighbour[] = [];
  /** Player control input, written by the input layer each frame. */
  readonly playerControls: VehicleControls = {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false, speedLimitMs: 0,
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
    // The track goes in, so the weather can put water on it where the circuit's
    // own elevation says water would go.
    this.weather = new Weather(def, config.seed, this.track);

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
      // The limiter's setpoint is a property of the circuit, not of the car.
      // Monaco is 60 km/h and everywhere else is 80; the physics used to assume
      // 80 everywhere and penalise the Monaco cars for obeying it.
      car.physics.pitSpeedLimitKph = def.pitLane.speedLimitKph;
      this.cars.push(car);
      this.standings.push(car);
      this.pitWalls.push(new PitWall());
      for (let n = 0; n < NEIGHBOUR_SLOTS; n++) this.neighbourPool.push(createNeighbour());
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

    // Art. B4.3.2 cars: entered, classified, and going nowhere. Marked here
    // rather than filtered out of `participants`, because filtering them out
    // would make them `eliminated` — which would hand them the grid slot of the
    // segment they were knocked out of instead of the one they are about to be
    // classified last in. The regulation bars the driver from running; it does
    // not strike the entry.
    if (config.withdrawn) {
      for (const car of this.cars) {
        if (config.withdrawn.includes(car.index)) {
          car.withdrawn = true;
          car.withdrawnReason = 'Recovered by the marshals in an earlier segment';
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

    for (const car of this.cars) {
      // The tyre-life model lives in `Strategy.ts` so that the plan a car
      // actually runs and the plan the strategy screen recommends are the same
      // arithmetic. They used to be the same only by coincidence, because this
      // expression was private to this method and the screen did not exist; a
      // strategist whose recommendation the race then contradicts is worse
      // than no strategist.
      const { soft: softLife, medium: mediumLife, hard: hardLife } =
        stintLife(car.team, car.driver, this.track.def);

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

  /**
   * Cars taking part in this session, in the order the last segment classified
   * them.
   *
   * The ORDER is load-bearing and used to be accidental. This mapped over
   * `this.cars` and filtered, which returns car-number order however the
   * entry list was written. Art. B2.4.3a.v ends "the relative classification of
   * drivers in each of the categories (A), (B), or (C) above shall be
   * determined in accordance with the order they were classified in the
   * previous period of Qualifying" — so when several drivers set no time, the
   * previous period's order is the tie-break, and `rankSegment`'s stable sort
   * can only preserve an order it is actually given. `config.participants` is
   * written from the previous segment's classification, so mapping over it in
   * its own order is what makes that regulation come out right.
   */
  get participants(): CarEntry[] {
    const allowed = this.config.participants;
    if (!allowed) return this.cars;
    const byIndex = new Map(this.cars.map((c) => [c.index, c]));
    return allowed
      .map((i) => byIndex.get(i))
      .filter((c): c is CarEntry => c !== undefined);
  }

  /**
   * The parts of the environment that are the same everywhere on the circuit.
   * Called once per step; `applyLocalSurface` finishes the job per car.
   */
  private updateEnvironment(): void {
    this.environment.trackTempC = this.weather.trackTempC;
    this.environment.airTempC = this.weather.airTempC;
    this.environment.wetness = this.weather.wetness;
    this.environment.surfaceGrip = 1;
    this.environment.abrasion = this.track.def.surfaceAbrasion;
    this.environment.airDensityRatio = 1;
  }

  /**
   * Writes the water depth and surface condition at THIS car's position.
   *
   * Called immediately before `physics.step`, and it is the whole reason a wet
   * race is now something a driver can do anything about. Two cars a car's
   * width apart on a soaked circuit are on measurably different surfaces: one
   * on the rubbered groove that has gone slick, one beside it on abrasive
   * asphalt with more water on it and more grip in it. Neither is simply
   * "better" — which is the point, and which is what makes the wet line a
   * decision rather than a setting.
   *
   * Off the racing surface entirely — grass, gravel, the pit lane — the water
   * field does not apply and `SURFACE_GRIP` in the physics is already the
   * dominant term, so this leaves those cases alone.
   */
  private applyLocalSurface(car: CarEntry): void {
    const surf = car.physics.surface;
    if (surf !== 'track' && surf !== 'curb') {
      this.environment.wetness = this.weather.wetness;
      this.environment.surfaceGrip = 1;
      return;
    }
    const i = this.track.indexAt(car.s);
    this.environment.wetness = this.weather.surface.waterAt(i, car.lateral);
    this.environment.surfaceGrip = this.weather.surface.surfaceGripAt(i, car.lateral);
  }

  // =========================================================================
  // The pit wall
  // =========================================================================

  /**
   * The player's pit wall — the one that asks questions.
   *
   * Exposed as its own accessor because it is the whole of the API the HUD
   * needs: `engine.pitWall.pending` is the call to draw and
   * `engine.pitWall.answer(id, yes)` is the button. Everything else on this
   * class stays where it is.
   */
  get pitWall(): PitWall | null {
    const car = this.playerCar;
    return car ? this.pitWalls[car.index] ?? null : null;
  }

  /**
   * How far ahead the wall reasons, in laps.
   *
   * Three laps is roughly the distance over which a tyre decision is still a
   * decision. Shorter, and the wall is reacting rather than planning; longer,
   * and it is projecting a forecast well past the point at which the forecast
   * means anything, which is a confident way to be wrong.
   */
  private static readonly WALL_HORIZON_LAPS = 3;

  private updatePitWalls(dt: number): void {
    // Only in a race. There is no crossover call in a practice session — the
    // car comes in when the run plan says so — and asking one in qualifying
    // would be asking the driver to decide something the format has already
    // decided.
    if (this.config.kind !== 'race') return;

    const refLap = this.track.def.referencePoleTimeS;
    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const horizonS = RaceEngine.WALL_HORIZON_LAPS * refLap;
    const projected = this.weather.projectedWetness(horizonS);

    for (const car of this.cars) {
      const wall = this.pitWalls[car.index];
      if (!wall) continue;
      // Only the player is asked. The AI's own strategist is `shouldPit`, which
      // reads the same crossover model — see `wetCrossoverWantsStop` — so the
      // two halves of the field are making the same call from the same numbers
      // and the AI simply does not need to be asked out loud.
      if (!car.isPlayer) continue;

      if (car.retired) { wall.reset(); continue; }

      const i = this.track.indexAt(car.s);
      const ctx: PitWallContext = {
        timeS: this.time,
        compound: car.compound,
        dryPreference: this.plannedDryCompound(car),
        wetness: this.weather.surface.waterAt(i, car.lateral),
        trackTempC: this.weather.trackTempC,
        lapsRemaining: Math.max(0, totalLaps - car.lap),
        refLapS: refLap,
        pitCostS: this.track.def.pitLane.transitLossS + car.team.performance.pitCrewTimeS,
        usedDryCompounds: car.usedCompounds.filter((c) => !getCompound(c).isWetWeather),
        hasRained: this.weather.hasRained,
        racing: this.started && !car.inPitLane && !car.retired && car.lap > 0,
        projectedWetness: projected,
        horizonLaps: RaceEngine.WALL_HORIZON_LAPS,
        forecast: this.weather.forecast.reading,
      };
      wall.update(dt, ctx);

      // A yes on the radio is the same thing as pressing the pit-request
      // button, and it goes through the same field so there is exactly one way
      // for a player's car to be called in.
      if (wall.boxRequested && !car.pitRequested && !car.inPitLane) {
        car.pitRequested = true;
        car.pitCompoundRequest = wall.requestedCompound;
      }
      if (!wall.boxRequested && car.pitRequested && wall.requestedCompound === null
          && car.pitCompoundRequest !== null) {
        // The driver answered yes to "stay out" after having agreed to box.
        car.pitRequested = false;
        car.pitCompoundRequest = null;
      }
    }
  }

  /**
   * Whether the weather alone justifies a stop for this car.
   *
   * The AI's half of the same decision the pit wall makes for the player, and
   * it calls into the same `crossoverCase` — which is the whole reason that
   * function is in `Strategy` rather than here. Before this, the engine decided
   * it with two inline thresholds (`wetness > 0.4`, `wetness < 0.12`) that
   * nothing else could see, and the strategy screen's recommendation and the
   * race's behaviour had no way of agreeing except by coincidence.
   */
  /**
   * The slick this car's plan wants next — what it goes back to when the track
   * dries. Falls back to the medium for a car whose plan has run out, which is
   * the same default `compoundForStint` has always used.
   */
  private plannedDryCompound(car: CarEntry): CompoundId {
    const planned = car.plan[Math.min(car.pitStops + 1, car.plan.length - 1)];
    const c = planned ? planned.compound : 'medium';
    return isWetCompound(c) ? 'medium' : c;
  }

  private wetCrossoverWantsStop(car: CarEntry): boolean {
    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const lapsLeft = Math.max(0, totalLaps - car.lap);
    if (lapsLeft <= 1) return false;
    const i = this.track.indexAt(car.s);
    const wetness = this.weather.surface.waterAt(i, car.lateral);
    const available = compoundsAvailableTo(
      car.usedCompounds.filter((c) => !getCompound(c).isWetWeather),
      this.weather.hasRained, lapsLeft, MANDATORY_COMPOUND_MARGIN_LAPS,
    );
    // Restricted to the tyre on the car and the tyre the conditions want. Not
    // restricting it asks "is there a faster tyre", to which the answer on a
    // dry track is always "a new soft" — see `crossoverCandidates`.
    const candidates = crossoverCandidates(
      car.compound, wetness, this.weather.trackTempC, this.plannedDryCompound(car), available,
    );
    const c = crossoverCase(
      car.compound, wetness, this.weather.trackTempC, this.track.def.referencePoleTimeS,
      this.track.def.pitLane.transitLossS + car.team.performance.pitCrewTimeS,
      lapsLeft, candidates,
    );
    // A tyre that has only just been fitted does not come straight back off for
    // a marginal gain. Without this a car crossing a puddle on its out-lap
    // decides it is on the wrong tyre and pits again.
    if (car.physics.rearTires.lapsOnSet < 2 && c.lossPerLapS < 3) return false;
    return c.worthIt;
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
    // How many cars are actually circulating, which is most of why a racing
    // line dries first. A red-flagged circuit dries at the rate the sun dries
    // it and no faster.
    let running = 0;
    for (const c of this.cars) if (!c.retired && !c.eliminated && !c.inPitLane) running++;
    this.weather.setTraffic(running);
    this.weather.update(dt);
    this.updateEnvironment();
    this.updatePitWalls(dt);

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
    // Marshals recover the stopped cars. Without this a retirement holds a
    // local yellow for the rest of the race, which keeps the safety car
    // deployed permanently and turns every remaining lap into a safety-car lap.
    this.updateRecoveries(dt);
    // ...and collect the carbon. Same shape, same reason: without it a wing
    // that came off in lap two is still on the racing line at the flag.
    this.updateDebris(dt);

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.retired) continue;
      // Cars knocked out of qualifying take no further part in the session.
      if (car.eliminated) continue;
      // ...and neither does a car the marshals recovered in an earlier segment
      // (Art. B4.3.2). It stays parked in its box for the whole period and is
      // classified on the time it does not set.
      if (car.withdrawn) { this.holdOnGrid(car); continue; }

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
      // Applied to the COPY, not to `playerControls`. The player's own control
      // block is owned by the input layer and rewritten once per rendered
      // frame, while this runs once per physics step; writing the assist back
      // into it would leave a stale brake application behind whenever the assist
      // stopped applying between two input frames.
      if (car.isPlayer) {
        this.applyNeutralisationAssist(car, car.appliedControls);
        this.applyPitLaneAssist(car, car.appliedControls);
      }
      car.physics.drsAvailable = this.isDrsAllowed(car);
      // Where the car is BEFORE it moves, for the swept test against the solid
      // world below. Recorded here rather than at the end of the previous step
      // so that a car which was teleported (placed on the grid, reset by a
      // probe, craned back on) sweeps from where it now is and not from where
      // it used to be several hundred metres away.
      car.prevX = car.physics.position.x;
      car.prevZ = car.physics.position.y;
      car.prevHeading = car.physics.heading;
      // Last thing before the step: the water and the surface under THIS car.
      this.applyLocalSurface(car);
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
      // After the projection, so a part that has just come off is filed at the
      // lap distance and lateral offset the car is at NOW — which is the place
      // the marshals will be sent to and the sector that shows the yellow.
      this.updateShedParts(car);
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
      this.config.kind === 'race', this.weather.wetness, this.debris,
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
    this.reportImpact(car, severity);
    // Decided before the damage is applied, because the damage model needs to
    // know: an impact that ends the session destroys the bodywork it hit, and
    // one that does not merely wears it. See `CarDamage.applyImpact`.
    const writeOff = severity > 0.72;
    if (severity > 0.25) {
      this.applyContactDamage(car, severity, zoneFor(car.physics.heading, nx, nz), writeOff);
      const where = this.track.cornerNameAt(car.s) || 'the exit';
      this.raceControl.log(
        car.driver.code + ' into ' + what + ' at ' + where,
        severity > 0.6 ? 'critical' : 'warning', this.time, car.index,
        {
          feed: 'either',
          notice: {
            parties: [car.driver.code], where: where.toUpperCase(),
            offence: 'CONTACT WITH ' + what.toUpperCase(), status: 'NOTED',
          },
          team: { kind: 'off', corner: where, hit: what, heavy: severity > 0.6 },
        },
      );
    }
    if (writeOff) {
      // The severity goes with the retirement: a car folded into a barrier is a
      // crane job with a debris sweep after it, not something four marshals
      // push through a gap. See `Recovery.ts`.
      car.retire('Accident', this.time, severity);
      // A written-off car is stationary. Retiring without this left the wreck
      // carrying its impact speed, so the HUD kept reading a speed for a car
      // that was out of the race and pinned against a barrier.
      car.physics.stop();
      this.raceControl.log(
        car.driver.code + ' is out on the spot — heavy impact',
        'critical', this.time, car.index,
        {
          feed: 'either',
          notice: {
            parties: [car.driver.code], where: (this.track.cornerNameAt(car.s) || '').toUpperCase(),
            offence: 'CAR STOPPED', status: 'RECOVERY IN PROGRESS',
          },
          team: { kind: 'retired', reason: 'heavy impact' },
        },
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
    const base = car.index * NEIGHBOUR_SLOTS;
    const len = this.track.length;

    let bestAhead = Infinity;
    let bestBehind = -Infinity;
    let aheadCar: CarEntry | null = null;
    let behindCar: CarEntry | null = null;
    let leftCar: CarEntry | null = null;
    let rightCar: CarEntry | null = null;

    // The collision picture, which is a different question to the racing one.
    //
    // `hazardCar` is whatever imposes the LOWEST safe speed rather than whatever
    // is nearest — a stopped car sixty metres away is a bigger problem than a
    // fast one at twenty, and picking by distance gets that backwards. Scored
    // with a reference deceleration here because the engine is choosing between
    // candidates, not deciding how hard to brake; the controller redoes the
    // arithmetic with its own live grip.
    let hazardCar: CarEntry | null = null;
    let hazardGap = 0;
    let hazardScore = Infinity;
    let roomLeft = Infinity;
    let roomRight = Infinity;
    const ourSpeed = car.physics.speedMs;

    for (const other of this.cars) {
      if (other === car || other.retired) continue;
      // The pit lane is a different road. It shares this spline — it is modelled
      // as a lateral offset on it — so a car in the lane has an `s` that reads
      // as "just ahead" to a car on the circuit passing the pits, and it was
      // being followed as if it were.
      //
      // That is most of what was left of the form-up defect. Under a safety car
      // half the field stops, every one of them transits the lane at the pit
      // limit, and every car on the circuit that came past a car in the lane
      // treated it as the car in front — under a yellow, which means the
      // no-pass hold applied, which means it slowed to a little over half the
      // speed of a car doing 80 km/h in a different piece of road behind a wall.
      // Measured, one car sat two kilometres behind the queue for three
      // minutes, oscillating between 11 and 58 m/s, unable to close a gap it was
      // being braked for by a car it could not have hit.
      if (other.inPitLane !== car.inPitLane) continue;
      const gap = loopDelta(car.s, other.s, len);

      if (gap > 0 && gap < bestAhead) { bestAhead = gap; aheadCar = other; }
      if (gap < 0 && gap > bestBehind) { bestBehind = gap; behindCar = other; }

      // Alongside: within a car length longitudinally and beside us laterally.
      if (Math.abs(gap) < 5.2) {
        const dLat = other.lateral - car.lateral;
        if (dLat > 0.9 && dLat < 4.2) leftCar = other;
        else if (dLat < -0.9 && dLat > -4.2) rightCar = other;
      }

      // --- Collision picture ---------------------------------------------
      //
      // A car sitting in its box is excluded from both halves, and that is the
      // engine's own rule rather than a new one: `resolveContacts` skips
      // `inPitBox` cars, so it is not something another car can hit. Treating it
      // as solid anyway would be worse than useless — every car whose box is
      // further down the lane would queue behind the one being serviced and the
      // pit lane would deadlock, which is precisely the failure the comment on
      // `isSolidWreck` describes for wrecks on the racing line.
      if (other.inPitBox) continue;

      const theirSpeed = other.physics.speedMs;
      const dLat = other.lateral - car.lateral;

      // In front, and in the corridor this car is driving down.
      if (gap > 0 && Math.abs(dLat) < HAZARD_CORRIDOR_M) {
        const safe = safeFollowSpeedMs(gap, theirSpeed, HAZARD_REFERENCE_DECEL_MS2, 1.1);
        if (safe < hazardScore) { hazardScore = safe; hazardCar = other; hazardGap = gap; }
      }

      // Beside us, or close enough that a lateral move would put us beside them.
      if (lateralOverlap(gap, ourSpeed, theirSpeed)) {
        if (dLat > 0) roomLeft = Math.min(roomLeft, dLat - CONTACT_WIDTH_M);
        if (dLat < 0) roomRight = Math.min(roomRight, -dLat - CONTACT_WIDTH_M);
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
    p.hazard = hazardCar
      ? this.fillNeighbour(this.neighbourPool[base + 4], car, hazardCar, hazardGap)
      : null;
    p.roomLeftM = roomLeft;
    p.roomRightM = roomRight;

    const rc = this.raceControl;
    // The ban starts at the BOARD, not at the sector line.
    //
    // A marshalling sector is a couple of hundred metres of road and the flag
    // is shown at the start of it, so a driver has seen the yellow before he is
    // in the zone it covers and has already backed off. Reading the ban at the
    // car's own position instead means a car arrives at the sector boundary at
    // full speed, a car length off the one in front, and is only then told not
    // to pass — by which point it is alongside and the manoeuvre completes
    // inside the yellow. `validate:flags` caught exactly one of those in
    // qualifying at Silverstone and it is the only illegal pass left on the
    // calendar: two cars at 25 m/s, both lifting, one crossing the boundary
    // already committed.
    //
    // A second of travel is roughly the sight line to the post, and it costs
    // nothing where there is no flag out.
    const lookAheadM = Math.max(20, car.physics.speedMs);
    p.localYellow = rc.overtakingBannedAt(car.s) ||
      rc.overtakingBannedAt(car.s + lookAheadM) ||
      car.holdUntilLine;
    p.yellowLevel = rc.yellowLevelAt(car.s);
    p.blueFlag = car.blueFlag;
    p.neutralised = rc.neutralisation !== 'none';
    p.neutralisedTargetMs = rc.vscTargetMs;
    p.neutralisedScale = rc.neutralisedScale;
    p.neutralisedCatchUpMult = rc.catchUpMult;
    p.queueGapM = rc.queueGapLimitM(car, car.position === 1);

    // The safety car, as something on the road in front of this car.
    //
    // It is not one of `this.cars` — it is a position on the lap owned by race
    // control — so the sweep above cannot see it, and for the LEADER it is the
    // only thing in front. That omission is the form-up defect: the leader had
    // no gap to close, so it never closed one, so the nineteen cars behind it
    // held station on a leader that was itself hundreds of metres adrift of the
    // car they were all supposed to be queueing behind.
    if (rc.scOnTrack) {
      const toSc = loopDelta(car.s, rc.scS, len);
      // Ahead of us, and on this lap rather than most of the way round.
      p.safetyCarAheadM = toSc > 0 && toSc < len * 0.5 ? toSc : -1;
      p.safetyCarSpeedMs = rc.scSpeedMs;
    } else {
      p.safetyCarAheadM = -1;
      p.safetyCarSpeedMs = 0;
    }
    // Whatever is nearest in front IN THE QUEUE — which for the leader is the
    // safety car and nothing else.
    //
    // The exclusion is not a detail. `ahead` is the nearest car on the ROAD, and
    // the nearest car on the road in front of the leader is the last car in the
    // field, most of a lap away. Feeding that gap to the catch-up rule told the
    // leader it was hundreds of metres adrift of a queue it was in fact leading,
    // so it was granted the full catch-up relaxation and drove away from the
    // whole field at 210 km/h under a safety car — measured, the gap from the
    // leader to second was still opening at 1900 metres. Everything behind it
    // then held station on nothing.
    const carAhead = car.position === 1 || !p.ahead ? -1 : p.ahead.gapM;
    const scNearer = p.safetyCarAheadM >= 0 && (carAhead < 0 || p.safetyCarAheadM < carAhead);
    p.queueAheadM = scNearer ? p.safetyCarAheadM
      : p.safetyCarAheadM < 0 ? carAhead
      : Math.min(carAhead, p.safetyCarAheadM);
    p.queueAheadSpeedMs = scNearer ? rc.scSpeedMs : (p.ahead ? p.ahead.speedMs : 0);
    p.mustUnlap = car.mustUnlap;
    p.holdRacingLine = car.holdRacingLine;
    p.holdUntilLine = car.holdUntilLine;
    // Both of these are LOCAL: the water this car is driving through, and how
    // much better it would be off the groove where this car is. A car two
    // metres away gets different numbers, which is the point.
    const wi = this.track.indexAt(car.s);
    p.wetness = this.weather.surface.waterAt(wi, car.lateral);
    p.lineAvoidance = this.weather.surface.lineAvoidance(
      wi, this.track.wetLineOffset[wi],
    );
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
    // Disqualified cars sort to the back of any session; retired cars sort to
    // the back of a RACE only. `classificationTier` owns that rule and cites
    // the articles — the short version is that a Lap Time Classified Session is
    // classified on a lap time (Art. B2.4.3a) and putting the car in a barrier
    // afterwards does not delete the lap. This test used to demote a retired
    // car in every session type, which is how the fastest driver in Q1 ended up
    // sorted twentieth by their own accident and was then shown "P20 — DNF".
    const at = classificationTier(a, isRace);
    const bt = classificationTier(b, isRace);
    if (at !== bt) return at < bt;

    if (isRace) {
      if (a.finished !== b.finished) return a.finished;
      if (a.finished && b.finished) {
        // DISTANCE FIRST, then time. A race is classified by who covered the
        // distance; time only separates cars that covered the same amount of
        // it.
        //
        // This used to compare `classifiedTime()` alone, and that is only the
        // same thing when every finisher completed the same number of laps.
        // They do not: when the flag falls, everyone still circulating is
        // classified where they are, and they all get the same finish time.
        // Comparing on time then ranks the entire field by penalty seconds
        // instead of by laps, and a five-second track-limits penalty put the
        // winner of a three-lap race — the only car to complete it — fifteenth,
        // behind fourteen cars that were still on lap three.
        //
        // A time penalty still costs positions, which is the point of it. It
        // costs them among the cars on the same lap, which is where a five
        // second gap can actually change an order.
        if (a.lap !== b.lap) return a.lap > b.lap;
        return a.classifiedTime() < b.classifiedTime();
      }
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
      //
      // "The leader" is the FIRST car to complete the distance, which is what
      // this tests, and not `car.position === 1`, which is what it used to.
      // Position is recomputed at 20Hz and a line crossing happens on a 120Hz
      // step in between, so a leader that crossed the Line during a flicker in
      // the classification — two cars a few metres apart, `totalDistance`
      // accumulating at slightly different rates — was reading a stale 2 and no
      // flag came out. Measured at Spa: the winner crossed to finish, was
      // recorded as P2 for that one step, and the race simply ran on until
      // every car had finished with no chequered flag at all.
      //
      // The test is exact rather than approximate: this is latched, a lapped
      // car by definition has fewer laps than the leader, and a lap can only be
      // earned by distance, so the first car here IS the leader.
      if (!this.raceControl.raceFinished && car.lap > laps) {
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

    // The crossover, from the shared model rather than from a pair of
    // thresholds written here. The reason is the same one the strategy file
    // exists for: a reason string that disagrees with the stop the car then
    // makes is worse than no reason string.
    if (this.wetCrossoverWantsStop(car)) {
      const onSlicks = !isWetCompound(car.compound);
      return onSlicks ? 'RAIN — WET TYRES' : 'TRACK DRY — SLICKS';
    }

    const wear = car.physics.rearTires.wear;
    if (wear < 0.24) return 'TYRES GONE';

    const totalLaps = this.config.laps || this.track.def.raceLaps;
    const lapsLeft = totalLaps - car.lap;
    if (!this.weather.hasRained && lapsLeft <= MANDATORY_COMPOUND_MARGIN_LAPS) {
      const dryUsed = new Set(car.usedCompounds.filter((c) => !getCompound(c).isWetWeather));
      if (dryUsed.size < 2) return 'SECOND COMPOUND REQUIRED';
    }
    if (wear < TYRE_PIT_WINDOW) return 'TYRES WORN — PIT WINDOW OPEN';
    return null;
  }

  /**
   * What the crew would do at this car's next stop, and why — the briefing the
   * pit screen shows before the driver chooses.
   *
   * Everything here is read from the same functions that run the stop, so the
   * screen cannot describe a stop the engine would not perform. `compound` is
   * literally `compoundForStint`'s answer with the driver's own instruction
   * excluded, which is what makes it honest to label it "the engineers' call".
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
    // The engineers' own answer: the same function the stop runs, asked to
    // ignore the driver's instruction rather than having it temporarily deleted
    // off the car. The previous version wrote `null` onto `pitCompoundRequest`,
    // called the chooser, and wrote the value back — a read-only query that
    // mutated the one piece of state the whole pit sheet is derived from. Any
    // throw between the two writes, and any read taken in between, saw a driver
    // who had asked for nothing. That is exactly the shape of "I chose hard and
    // it gave me softs", and no amount of care at the call sites fixes a getter
    // that edits the model.
    const compound = this.compoundForStint(car, true);

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

  /**
   * Will the crew take the nose off at this car's next stop?
   *
   * The crew's own rule is "below 70%", and a driver who has been asked
   * overrules it in either direction. Public for the same reason
   * `compoundForStint` is: the sheet that offers the choice and the stop that
   * performs it have to be reading one function.
   */
  noseChangeForStop(car: CarEntry): boolean {
    const frontWing = Math.min(car.damage.health.frontWingL, car.damage.health.frontWingR);
    return car.pitNoseChangeRequest ?? (frontWing < 0.7);
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

    // Wet-weather crossover. Worth many seconds a lap in either direction, so
    // it overrides any planned stop — and it is now the same arithmetic the
    // player's pit wall reasons with rather than a threshold that happened to
    // be in the same neighbourhood.
    if (this.wetCrossoverWantsStop(car)) return true;

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
    //
    // WHAT MAKES IT CHEAP IS THAT IT IS A STOP YOU WERE GOING TO MAKE ANYWAY.
    // The saving is the pit loss you would otherwise have paid later, and if you
    // were not going to pay it later then there is no saving — there is a
    // twenty-second stop, a set of tyres binned with ninety-six percent of its
    // life left, and a stint at the far end that is now too long for the tyre
    // that has to cover it.
    //
    // The test used to be "more than six laps on this set", which on a
    // thirty-lap race is most of the field most of the time. Measured at
    // Silverstone, seed 7: a safety car came out on lap nine and sixteen of the
    // twenty cars dived in on lap nine or ten, against plans that named laps
    // sixteen to twenty-two, on tyres reading 0.965 of full life. That single
    // branch was the whole of the strategy defect `probe:strategy` reports — not
    // worn tyres and not the mandatory-compound rule, both of which were
    // measured firing far later or not at all. The plan was not being overridden
    // by an emergency; it was being thrown away for a bargain that was not one.
    //
    // A real strategist pulls a stop forward under a safety car by a couple of
    // laps, not by twelve. Either the stop is nearly due, or the tyre is in the
    // window the driver would be told about anyway (`pitAdvice` says "TYRES WORN
    // — PIT WINDOW OPEN" at the same number, so the AI and the player's radio
    // call now agree), or it is not a cheap stop and the plan stands.
    if (this.raceControl.neutralisation !== 'none') {
      const nearlyDue = car.lap >= car.targetPitLap - NEUTRALISED_PULL_FORWARD_LAPS;
      const inTheWindow = car.physics.rearTires.wear < TYRE_PIT_WINDOW;
      const worthIt = (nearlyDue || inTheWindow) &&
        car.targetPitLap > 0 &&
        this.raceControl.mayEnterPitLane(true, false);
      if (worthIt) return true;
    }
    return false;
  }

  /**
   * The player's neutralised speed limit, applied for them.
   *
   * The pit lane's assist, pointed at the other limit the driver is required to
   * obey. Everything about the shape of it is deliberately the same, because the
   * two are the same problem: the limit is armed BEFORE the car needs it, the
   * car is braked into it on a planning profile rather than dropped onto it, and
   * the HUD says the limiter is on. `applyPitLaneAssist` below is the original
   * and its comment explains why an automatic limiter obliges the game to
   * provide the arrival; this owes the driver exactly the same thing.
   *
   * WHY IT HAS TO EXIST AT ALL. The player's report is one sentence covering
   * both halves — "under safetycar and flags and everything every car has to
   * follow the speedlimit, it should auto put the speed up." The nineteen AI
   * cars were fixed and the twentieth was not, which makes the rule a handicap
   * rather than a rule. And a neutralised limit is much harder to judge by eye
   * than a pit entry: what the regulations actually require is a minimum TIME
   * through each marshalling sector, set by the FIA ECU (2025 Sporting Regs
   * Art. 55.7 and 56.5 / 2026 Section B Art. B5.13.2b and B5.12.2b), which is
   * not a number a driver can read off a speedometer. The penalty for getting
   * it wrong is five seconds.
   *
   * WHAT IT DOES NOT DO. Steering is the driver's, everywhere. The throttle is
   * the driver's everywhere the limit is not binding. And the limit relaxes
   * exactly as it does for the AI when the player is entitled to run quicker —
   * closing a gap to the queue (Art. 55.7 / B5.13.2b requires them to close it)
   * or unlapping themselves (Art. 55.14 / B5.13.4c requires them to pass) — via
   * the same shared `neutralisedLimit`, so the player is never braked for
   * obeying the other article.
   */
  private applyNeutralisationAssist(car: CarEntry, c: VehicleControls): void {
    const rc = this.raceControl;
    if (!this.neutralisationAssist ||
        rc.neutralisation === 'none' || car.inPitLane || car.retired || !this.started) {
      c.speedLimitMs = 0;
      car.neutralLimitMs = 0;
      return;
    }

    const p = car.perception;
    const limit = neutralisedLimit(
      rc.vscTargetMs, rc.neutralisedScale, rc.catchUpMult,
      p.queueGapM, p.queueAheadM, car.mustUnlap, UNLAP_PACE_MULT,
    );

    // The limit `d` metres up the road. The lookahead is what stops the limiter
    // being a thing that cuts in at every corner instead of a thing the car
    // arrives at — the racing line's own speed falls away before a corner and
    // the neutralised limit falls with it.
    // Station-keeping, from the same shared rule the AI drives to. Without it
    // the player's cap comes only from the racing line, and the racing line is
    // not what the queue in front of them is doing: measured at Monaco, where
    // the field runs a long way under the line speed even before a
    // neutralisation, the player was held to 37% of the line while the cars
    // ahead were doing 26% of it. A limit that lets one car run 44% quicker
    // than the queue it is in is not the same limit.
    const hold = queueHoldMs(
      p.queueAheadM, p.queueAheadSpeedMs, p.queueGapM, rc.vscTargetMs * 0.25,
    );

    const len = this.track.length;
    const plan = neutralisedPlan(car.physics.speedMs, (d) => {
      const sAt = (car.s + d) % len;
      // The speed the car "would otherwise carry" — the same reference the AI
      // scales down, which is the racing line capped by what this car's own
      // grip and downforce can actually do through the corner. See
      // `NEUTRAL_COMMITMENT` for what taking the raw line speed instead cost.
      // `neutralisedPlan` then runs a braking pass over it, which is the other
      // half of the same idea.
      const line = this.track.targetSpeed[this.track.indexAt(sAt)];
      const grip = corneringSpeedLimitMs(this.track, car.physics, sAt) * NEUTRAL_COMMITMENT;
      return Math.min(line, grip);
    }, limit);

    c.speedLimitMs = Math.min(plan.ceilingMs, hold);
    car.neutralLimitMs = c.speedLimitMs;
    if (plan.brake > c.brake) {
      c.brake = plan.brake;
      c.throttle = 0;
    }
  }

  /**
   * The player's pit limiter, and the braking that makes it possible.
   *
   * The limiter is automatic for the player — being asked to manage it by hand
   * is tedious rather than interesting — and that decision has a consequence
   * that went unpaid for a long time: if the game presses the button, the game
   * owes the driver an entry that is not an instant penalty.
   *
   * What actually happened was the reverse. `pitLimiter` was set to
   * `car.inPitLane` and nothing else, so it came on one step AFTER the car was
   * already in the lane — the same step race control uses to decide whether the
   * car was speeding. The drive-through was therefore issued before the limiter
   * had cut a single newton, and the limiter then had to shed two hundred and
   * twenty km/h using half a g, which needs more pit lane than exists. The
   * player's report is exact: "you have a speed limiter on but the speed of the
   * car isn't actually reduced and thus giving some pit lane penalty."
   *
   * So this does the two things a driver does, in the order a driver does them.
   * It brakes for the entry — the same square-root profile, the same planning
   * rate and the same shared constants the AI uses, so the player's car and the
   * nineteen around it arrive at the line the same way — and it arms the
   * limiter BEFORE the line rather than on it.
   *
   * It touches nothing else. Steering is the driver's, the throttle is the
   * driver's everywhere except while this is braking, and the moment the car is
   * in the lane the assist stops planning and simply holds the limiter on.
   */
  private applyPitLaneAssist(car: CarEntry, c: VehicleControls): void {
    const pit = this.track.def.pitLane;

    // In the lane: the limiter is on, and that is the whole of it. Speed inside
    // the lane is the limiter's job, and stopping on the box is the driver's.
    if (car.inPitLane) {
      c.pitLimiter = true;
      return;
    }

    c.pitLimiter = false;

    // Not coming in, or not being let in — either way there is nothing to brake
    // for, and slowing the car on the racing line would be an unexplained loss
    // of speed in the middle of a lap.
    //
    // `mayEnterPitLane` is asked directly rather than reading the latched
    // `pitEntryRefused`: that flag records that a refusal has been ANNOUNCED and
    // is only cleared when the driver gives up on the idea, so a pit entry that
    // closed and reopened would leave it set and the assist silently switched
    // off for the rest of the request.
    if (!car.perception.pitThisLap) return;
    const forRepairs = car.damage.worst().health < 0.7 || car.pendingServePenalty() !== null;
    if (!this.raceControl.mayEnterPitLane(true, forRepairs)) return;

    const toEntry = loopDelta(car.s, pit.entryS, this.track.length);
    if (toEntry < 0 || toEntry > PIT_ENTRY_SCAN_M) return;

    // Is this lap the lap? A call that lands inside the braking distance cannot
    // be answered, and standing on the brakes for an entry the car will then be
    // refused is the worst of both. `PIT_ENTRY_RESCUE_M` of slack is what the
    // limiter itself can finish off in the first metres of the lane.
    //
    // The test is stable rather than knife-edge: a car tracking the braking
    // profile has `roomNeeded` exactly equal to `toEntry`, so once the assist
    // is working it stays working with the whole of the slack in hand.
    const speed = car.physics.speedMs;
    if (pitEntryRoomNeededM(pit, speed) > toEntry + PIT_ENTRY_RESCUE_M) return;

    if (speed > pitEntryCeilingMs(pit, toEntry)) {
      const pedal = brakeFor(
        speed, pitEntryTargetMs(pit),
        Math.max(toEntry - PIT_ENTRY_SETTLE_M, 0.01),
        PIT_ENTRY_DECEL_MS2,
      );
      if (pedal > c.brake) {
        c.brake = pedal;
        c.throttle = 0;
      }
    }

    c.pitLimiter = toEntry < PIT_LIMITER_ARM_M;
  }

  /**
   * Can the limiter get this car under the pit lane limit in the first metres
   * of the lane?
   *
   * Asked at the entry line. A car that says no has missed the pit entry: it is
   * going to be over the limit for most of a pit lane full of standing
   * mechanics, and the drive-through it collects is served by driving down that
   * same pit lane, where it happens again.
   */
  private canMakeThePitLimit(car: CarEntry): boolean {
    return pitLimiterShedDistanceM(this.track.def.pitLane, car.physics.speedMs)
      <= PIT_ENTRY_RESCUE_M;
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
          { feed: 'team', team: { kind: 'pit-closed' } },
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
          { feed: 'team', team: { kind: 'pit-missed' } },
        );
      }
      // And is the car SLOW ENOUGH to be let in?
      //
      // Only asked of the player. The AI declines the entry on the approach
      // when there is no room to stop, and this is the same judgement made at
      // the line for the one car that has no such state machine. Its limiter
      // and its entry braking are both automatic, so arriving far too fast
      // means the assist was never given a chance — the call landed inside the
      // braking distance — and letting the car in anyway is a guaranteed
      // drive-through, served by driving down the very pit lane it is currently
      // speeding through. A driver in that position stays out and comes round
      // again, and so does this.
      const tooFast = car.isPlayer && !this.canMakeThePitLimit(car);
      if (wantsPit && allowed && onPitSide && geometricallyInLane && fromEntry < 40 &&
          tooFast && !car.pitEntryMissed) {
        car.pitEntryMissed = true;
        this.raceControl.log(
          car.driver.code + ' — too fast for the pit entry, round again',
          'warning', this.time, car.index,
          { feed: 'team', team: { kind: 'pit-fast' } },
        );
      }
      if (!geometricallyInLane) car.pitEntryMissed = false;

      if (wantsPit && allowed && onPitSide && geometricallyInLane && fromEntry < 40 && !tooFast) {
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
      // Art. B2.4.3a.v(C) is about drivers who never got out of the garage;
      // this latch is the record that this one did.
      car.leftThePits = true;
      car.blendRemainingM = PIT_EXIT_BLEND_M;
      car.pitSpeedingFlagged = false;
      car.servicedThisVisit = false;
      // The call has been answered. Leaving it latched would send the car
      // straight back down the pit lane on the next lap, for ever.
      car.pitRequested = false;
      // ...and the wall's own latch with it, or it would keep re-requesting.
      this.pitWalls[car.index]?.onServed();
      // A drive-through is discharged by the transit itself, and it has just
      // been completed.
      if (car.pitTransitOnly) {
        const pen = car.pendingServePenalty();
        if (pen && pen.kind === 'drive-through') {
          pen.served = true;
          this.raceControl.log(
            car.driver.code + ' has served the drive-through penalty',
            'info', this.time, car.index,
            {
              feed: 'either',
              notice: {
                parties: [car.driver.code], where: 'PIT LANE',
                offence: 'DRIVE-THROUGH PENALTY', status: 'SERVED',
              },
              team: { kind: 'penalty-served' },
            },
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
      car.pitNoseChanging = this.noseChangeForStop(car);
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
        const compound = this.compoundForStint(car);
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
          { feed: 'team', team: { kind: 'stop', compound: getCompound(compound).name } },
        );
      }
    }
  }

  /**
   * The compound this car's next stop will fit. THE value, not a copy of it.
   *
   * Public and pure — it reads the car and the session and writes nothing — so
   * the pit sheet, the status line, the briefing and the stop itself are all
   * one function call rather than four re-derivations that drift.
   *
   * @param ignoreDriverRequest asks what the CREW would do, for the line that
   *        says so. It does not, and must not, disturb the driver's own call.
   */
  compoundForStint(car: CarEntry, ignoreDriverRequest = false): CompoundId {
    // A driver who has told the crew what to fit gets what they asked for,
    // including when it is a mistake. The pit screen states the mandatory
    // second-compound position and the weather in plain terms before the choice
    // is made; overriding it here would make the screen a suggestion box.
    if (!ignoreDriverRequest && car.pitCompoundRequest) return car.pitCompoundRequest;

    // Weather first: the right tyre for the conditions beats any plan. Solved
    // from the tyre model at this track temperature rather than read off two
    // constants, so the crew fits what the strategist recommended.
    const wetChoice = wetCompoundFor(this.weather.wetness, this.weather.trackTempC);
    if (wetChoice) return wetChoice;

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
  /**
   * Is this wreck something other cars can hit?
   *
   * Only off the racing surface, and the restriction is not cosmetic caution —
   * it is the difference between a race that finishes and one that does not.
   *
   * A retired car used to be excluded from contact entirely, so it was a ghost
   * and cars drove through the wreckage. Making it solid everywhere fixed that
   * and broke something worse: a wreck sitting on the road is an immovable
   * object that the AI cannot see (it is excluded from perception, because
   * treating a permanently stationary car as the car ahead makes the whole
   * field queue behind it at walking pace). Cars arrived at it, stopped dead
   * against it, and stayed there. At Spa the chequered flag stopped coming out
   * at all — the race simply never ended.
   *
   * Off the road there is nothing to block. A wreck in the gravel or against
   * the barriers is exactly where the cameras find it and exactly where it can
   * be solid for free: the only cars that can reach it are cars that have also
   * left the circuit, and them hitting it is correct.
   *
   * A wreck ON the road stays a ghost. That is a compromise, and an honest one:
   * the alternative is a simulation that can deadlock.
   */
  private isSolidWreck(car: CarEntry): boolean {
    // Until the crane has actually taken it away, not until the race has been
    // released. Those are different moments now, and the honest one is the
    // first: a car that is still lying in the gravel is still something another
    // car sliding into the same gravel can hit, and the player can see it there.
    if (car.cleared) return false;
    return Math.abs(car.lateral) > this.track.halfWidthAt(car.s);
  }

  private resolveContacts(): void {
    const cars = this.cars;

    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.inPitBox || (a.retired && !this.isSolidWreck(a))) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.inPitBox || (b.retired && !this.isSolidWreck(b))) continue;
        // Two wrecks lying against each other have nothing left to resolve.
        if (a.retired && b.retired) continue;
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
        //
        // A wreck does not move. Its race is over, it has been stopped by the
        // thing it hit, and pushing it around the circuit for the rest of the
        // session with the noses of cars that arrive later would walk it out of
        // the place the accident actually happened. So the share of the
        // separation each car takes is weighted: two runners split it, and a
        // runner meeting a wreck takes all of it. Without this the wreck was
        // not merely soft — it was not there at all, and cars drove through it.
        const aFixed = a.retired ? 1 : 0;
        const bFixed = b.retired ? 1 : 0;
        const aShare = aFixed ? 0 : bFixed ? 1 : 0.5;
        const bShare = bFixed ? 0 : aFixed ? 1 : 0.5;
        a.physics.position.x -= nx * overlap * aShare;
        a.physics.position.y -= nz * overlap * aShare;
        b.physics.position.x += nx * overlap * bShare;
        b.physics.position.y += nz * overlap * bShare;

        // Exchange momentum along the contact normal.
        const relVx = b.physics.velocity.x - a.physics.velocity.x;
        const relVz = b.physics.velocity.y - a.physics.velocity.y;
        const approach = relVx * nx + relVz * nz;
        if (approach < 0) {
          // The same weighting again: hitting a stopped wreck is hitting
          // something immovable, so the running car absorbs the whole impulse
          // rather than half of it.
          const impulse = -approach * 0.42;
          a.physics.velocity.x -= nx * impulse * (aShare * 2);
          a.physics.velocity.y -= nz * impulse * (aShare * 2);
          b.physics.velocity.x += nx * impulse * (bShare * 2);
          b.physics.velocity.y += nz * impulse * (bShare * 2);

          // A meaningful hit unsettles the cars and can spin them.
          const severity = clamp01(-approach / 12);
          a.physics.yawRate += severity * 0.55 * (nx * 0.4 + 0.2) * (aShare * 2);
          b.physics.yawRate -= severity * 0.55 * (nx * 0.4 + 0.2) * (bShare * 2);
          this.reportImpact(a.retired ? b : a, severity);

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
              'warning', this.time, -1,
              { notice: {
                parties: [a.driver.code, b.driver.code],
                where: (this.track.cornerNameAt(a.s) || '').toUpperCase(),
                offence: 'CONTACT', status: 'NOTED',
              } },
            );
          }
        }
      }
    }
  }

  /**
   * Queues a hit for the renderer.
   *
   * Deliberately quiet below a threshold: cars rub wheels and brush walls
   * constantly, and a shower of sparks for every one of those is noise that
   * makes the shower for a real accident mean nothing.
   */
  private reportImpact(car: CarEntry, severity: number): void {
    if (severity < 0.08) return;
    this.shedFromImpact(car, severity);
    // Bounded. Twenty cars in a first-corner accident can report a lot of
    // contacts in one frame, and the renderer only needs to know that it was
    // bad, not to draw every individual one.
    if (this.impacts.length >= 24) return;
    this.impacts.push({ carIndex: car.index, severity });
  }

  /**
   * Puts a hard hit's worth of loose carbon on the road.
   *
   * The threshold and the count are both a good deal meaner than they were, and
   * the reason is arithmetic rather than taste. At `severity > 0.45` — a 5.4
   * m/s closing speed, which is a firm nudge — with up to six pieces, the six
   * contact events of an ordinary two-lap stint produced thirty-odd panels of
   * bodywork on the circuit. A real Grand Prix does not leave thirty pieces of
   * visible carbon on the road in two laps; a wheel-to-wheel rub leaves none,
   * and a proper hit leaves an endplate and a couple of fragments.
   *
   * So: nothing until the hit is genuinely hard, and then one to three pieces.
   * `severity` here is the closing speed over 12 m/s, so 0.55 is a 6.6 m/s
   * impact — the point at which an endplate is coming off rather than scuffing.
   */
  private shedFromImpact(car: CarEntry, severity: number): void {
    if (severity < IMPACT_SHED_SEVERITY) return;
    const pieces = Math.min(3, 1 + Math.round((severity - IMPACT_SHED_SEVERITY) * 4));
    this.recordDebris(car, IMPACT_SHARD_SIZE_M, pieces, 0, 0.35);
  }

  /**
   * Notices a whole piece of bodywork leaving the car and puts it on the road.
   *
   * This decision used to be made in the renderer, from the same health numbers,
   * and made there ONLY: the simulation had no idea a wing had come off, so the
   * carbon on the road was invisible to race control and nothing was ever going
   * to be sent to collect it. Reading it here means the ledger, the flag and
   * the shards on screen all follow from one crossing of one threshold.
   */
  private updateShedParts(car: CarEntry): void {
    const h = car.damage.health;
    for (let k = 0; k < BODY_PART_IDS.length; k++) {
      const id = BODY_PART_IDS[k];
      const health = id === 'frontWing'
        ? Math.min(h.frontWingL, h.frontWingR)
        : h[id as 'rearWing' | 'sidepodL' | 'sidepodR'];
      const gone = health <= PART_DETACH_HEALTH;
      if (gone === car.partsShed[k]) {
        // Refitted in the pits: the latch reopens so the same wing can be lost
        // again later in the race.
        if (!gone && health > PART_REPAIR_HEALTH) car.partsShed[k] = false;
        continue;
      }
      if (!gone) {
        if (health > PART_REPAIR_HEALTH) car.partsShed[k] = false;
        continue;
      }
      car.partsShed[k] = true;
      // A wing breaks into more pieces than a sidepod, because it is a thin
      // laminate on two mounts and a sidepod is one large moulding.
      this.recordDebris(
        car, PART_SIZE_M[id], id === 'frontWing' ? 4 : 3, k + 1, PART_MOUNT_HEIGHT_M[id],
      );
    }
  }

  /**
   * Files one pile of bodywork with the marshals.
   *
   * @param size    what the part measures, so the shards are a fraction of the
   *                thing they came off rather than a fixed size
   * @param source  0 for loose carbon off an impact, otherwise the body part's
   *                index plus one, so the renderer can offset the shards to the
   *                point the part was bolted to
   * @param heightM how far above the road it left the car
   */
  private recordDebris(
    car: CarEntry, size: readonly [number, number, number],
    pieces: number, source: number, heightM: number,
  ): void {
    // Where it will COME TO REST, not where it left the car.
    //
    // A wing that comes off at 300 km/h keeps most of that speed for the second
    // or so it is in the air, so it lands the better part of a corner's length
    // further on. The ledger's position is what decides which marshalling post
    // shows the flag and how far somebody has to walk, and both of those are
    // about where the carbon ends up. Filing it at the point of failure put the
    // yellow out at the wrong post at any real speed.
    //
    // The fraction is the one `Wreckage.spawn` carries forward — a piece keeps
    // 55-90% of the car's velocity — times a flight of roughly eight tenths of
    // a second, which is what the ballistic arc there works out to from the
    // launch heights it uses.
    const carryM = Math.min(80, car.physics.speedMs * 0.72 * 0.8);
    const s = wrapDistance(car.s + carryM, this.track.length);
    const offRoadM = Math.abs(car.lateral) - this.track.halfWidthAt(s);
    this.debris.add({
      s,
      lateralM: car.lateral,
      ownerIndex: car.index,
      x: car.physics.position.x,
      y: this.track.elevationAt(car.s) + heightM,
      z: car.physics.position.y,
      vx: car.physics.velocity.x,
      vz: car.physics.velocity.y,
      sizeX: size[0], sizeY: size[1], sizeZ: size[2],
      pieces,
      offRoadM,
      source,
    });
  }

  /**
   * Runs the marshals' operation on every pile of carbon.
   *
   * Same shape as `updateRecoveries`, and deliberately: a piece of bodywork on
   * the racing line is an incident with a flag on it and an operation to end
   * it, not an object with a lifetime. What differs is only the precondition —
   * a car needs the race neutralised before anybody goes near it, and a wing
   * endplate is picked up by hand under the local yellow.
   */
  private updateDebris(dt: number): void {
    const rc = this.raceControl;
    const neutralised = this.config.kind !== 'race' ||
      rc.neutralisation !== 'none' || rc.sessionFlag === 'red';
    this.debris.advance(dt, neutralised);
  }

  /**
   * @param zone     which face of the car took the hit, so the damage lands on
   *                 the components that would actually have been in the way
   * @param writeOff true when this impact has already been judged terminal
   */
  private applyContactDamage(
    car: CarEntry, severity: number, zone: ImpactZone = 'front', writeOff = false,
  ): void {
    const broken = car.damage.applyImpact(zone, severity, writeOff);

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
      // Team only, and this is the line the user pointed at: "nobody will ever
      // say this person's suspension broke ... that is a team only
      // conversation". A rival's floor damage is not race control's business
      // and it is certainly not the player's principal's.
      this.raceControl.log(
        car.driver.code + ': ' + COMPONENT_NAMES[id].toLowerCase() + ' damage',
        bandOf(h) === 'critical' ? 'critical' : 'warning', this.time, car.index,
        { feed: 'team', team: { kind: 'damage', part: COMPONENT_NAMES[id], health: h } },
      );
    }

    if (severity > 0.85 && this.rng.chance(0.12)) {
      car.retire('Accident damage', this.time, severity);
      // The same rule as a barrier write-off: the impact that ends a session
      // is the one that takes the bodywork off. Applied here rather than in the
      // call above because whether this contact was terminal is decided by a
      // dice roll, and the destruction has to follow the roll rather than
      // precede it — otherwise every hard racing contact would strip the car.
      car.damage.applyImpact(zone, severity, true);
      car.physics.spec = car.damage.applyTo(car.physics.baseSpec);
      this.raceControl.log(
        car.driver.code + ' is out of the race', 'critical', this.time, car.index,
        {
          feed: 'either',
          notice: {
            parties: [car.driver.code], where: '',
            offence: 'CAR RETIRED', status: 'OUT OF THE RACE',
          },
          team: { kind: 'retired', reason: 'terminal damage' },
        },
      );
    }
  }

  /**
   * Runs the marshals' operation on every stopped car.
   *
   * The two flags a retirement carries — `recovered` ("the race no longer needs
   * to be slowed down for this") and `cleared` ("the car has gone") — are
   * written here and nowhere else, and both come from the same operation. That
   * is the whole point: before this they were two independent stopwatches, 22
   * seconds and 150 seconds, and the second one had to be kept equal by hand to
   * a third constant in the renderer for the flag to come down at the moment
   * the wreck stopped being drawn. Now the wreck disappears BECAUSE the
   * recovery finished, and the flag clears on the same step for the same
   * reason.
   *
   * WHEN THE MARSHALS ARE ALLOWED TO WORK. If the operation puts anybody on or
   * beside the racing surface it needs the race neutralised first (Art. 55.3 /
   * B5.13.1 and Art. 56.1a / B5.12 — both are about officials in danger), and
   * the neutralisation in turn only ends when the operation is finished, which
   * is the loop a real VSC runs in. Outside a race there is no safety car to
   * deploy, so the session's own yellow and red flags stand in for it: a
   * practice session is stopped for a recovery, it does not race around one.
   */
  private updateRecoveries(dt: number): void {
    const rc = this.raceControl;
    // In a race, work on the circuit waits for the neutralisation. In practice
    // and qualifying no neutralisation exists — the session is red-flagged
    // instead — so the marshals simply get on with it.
    const permitted = this.config.kind !== 'race' ||
      rc.neutralisation !== 'none' || rc.sessionFlag === 'red';

    for (const car of this.cars) {
      if (!car.retired) continue;
      const op = car.recovery;
      if (op.done) continue;

      // Re-read the site until the marshals are actually there. A car is often
      // still sliding on the step it retires, and planning a crane job from the
      // point of impact rather than the point it came to rest would be planning
      // for the wrong corner.
      const offRoadM = Math.abs(car.lateral) - this.track.halfWidthAt(car.s);
      op.plan(offRoadM, this.track.targetSpeed[this.track.indexAt(car.s)], car.wreckSeverity);

      if (op.advance(dt, permitted)) {
        // The crane takes the wreck and the marshals sweep after it, so this
        // car's bodywork goes off the ledger on the same step the car does.
        this.debris.clearOwner(car.index);
        rc.log(
          car.driver.code + '’s car has been recovered — ' +
          (this.track.cornerNameAt(car.s) || 'sector ' + (rc.sectorIndexAt(car.s) + 1)) +
          ' is clear',
          'info', this.time, car.index,
          {
            feed: 'either',
            notice: {
              parties: [car.driver.code],
              where: (this.track.cornerNameAt(car.s) ||
                'sector ' + (rc.sectorIndexAt(car.s) + 1)).toUpperCase(),
              offence: 'CAR RECOVERED', status: 'TRACK CLEAR',
            },
            team: { kind: 'recovered' },
          },
        );
      }
      car.recoveryTimer = op.elapsedS;
      car.recovered = !op.warrantsNeutralisation;
      car.cleared = op.done;
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
        // Intact, but deep enough into the run-off that it is a lift rather
        // than a push. `Recovery` reads that off where the car actually is, so
        // there is nothing to declare here beyond the retirement itself — and
        // in particular this no longer claims the car has been recovered on the
        // step it got stuck, which is what used to make the yellow vanish while
        // a tractor would still have been on its way.
        car.retire('Beached in the gravel', this.time);
        this.raceControl.log(
          car.driver.code + ' is out — stranded off track', 'critical', this.time, car.index,
          {
            feed: 'either',
            notice: {
              parties: [car.driver.code],
              where: (this.track.cornerNameAt(car.s) || '').toUpperCase(),
              offence: 'CAR STOPPED OFF TRACK', status: 'RECOVERY IN PROGRESS',
            },
            team: { kind: 'stranded' },
          },
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
      this.raceControl.log(
        car.driver.code + ' — ' + cause, 'critical', this.time, car.index,
        {
          feed: 'either',
          notice: {
            parties: [car.driver.code], where: '',
            offence: 'CAR RETIRED', status: cause.toUpperCase(),
          },
          team: { kind: 'failure', cause },
        },
      );
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
  to.speedLimitMs = from.speedLimitMs;
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
