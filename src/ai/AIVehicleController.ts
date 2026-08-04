import { clamp, clamp01, damp, lerp, loopDelta, Rng, wrapAngle, Vec2 } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { VehiclePhysics, VehicleControls, ErsMode } from '../physics/VehiclePhysics';
import { steerRackLimit } from '../physics/VehiclePhysics';
import {
  UNLAP_PACE_MULT, applyNeutralisedLimit, neutralisedLimit, queueHoldMs,
} from '../physics/NeutralisedLimiter';
import {
  PIT_ENTRY_DECEL_MS2, PIT_ENTRY_SCAN_M, PIT_ENTRY_SETTLE_M, PIT_ENTRY_TARGET_SHARE,
  PIT_LIMITER_ARM_M, brakeFor, pitEntryTargetMs, pitLimiterSetpointMs,
} from '../physics/PitLimiter';
import {
  BLOCKAGE_CLEARANCE_M, BLOCKAGE_CRAWL_MS, BLOCKAGE_SIDE_DEADBAND_M, CONTACT_GAP_M,
  PIT_DECEL_MS2, PIT_STANDOFF_M, RACING_ROOM_M, TRAFFIC_STANDOFF_M,
  requiredDecelMs2, safeFollowSpeedMs,
} from './TrafficAwareness';

/**
 * Speed taper on this controller's FEEDBACK gains (not its feedforward).
 *
 * This is not a new idea, only a newly honest one. Every feedback gain below was
 * tuned by measurement while the steering rack was quietly attenuating it by
 * exactly this curve, so the curve was already part of the tuning — it just was
 * not written down anywhere, and it lived in a constant whose real job is to
 * decide how much lock the front tire gets.
 *
 * Writing it here separates the two. Loop gain still falls from 1.0 at low speed
 * to about 0.6 at 260km/h, which is what keeps a 300km/h car from weaving, and
 * the rack ratio is now free to be chosen for the tire.
 */
const AI_FEEDBACK_GAIN_SCHEDULE = (speedMs: number): number =>
  1 / (1 + Math.max(0, speedMs - 14) * 0.020);
import type { Driver } from '../data/teams';

/**
 * AI driver: a finite state machine over an explicit spatial picture of the cars
 * around it.
 *
 * The design principle is that the AI drives the *same car* through the *same
 * physics* as the player. It has no grip bonus, no rubber-banding, and no
 * scripted lap times. Everything it does is expressed as throttle, brake, steer,
 * DRS and ERS — the identical five inputs the player has. When an AI car is
 * quicker it is because its driver's skill parameters let it brake later and
 * carry more speed, and when it makes a mistake the mistake is real.
 *
 * States:
 *   LINE_FOLLOWER  clean air; track the solved racing line at the solved speed
 *   OVERTAKE       committed to a pass; offset off-line and use everything
 *   DEFEND         under attack; take the inside line before the braking zone
 *   FOLLOW         held up but no opportunity; sit in the tow and mind the tires
 *   AVOID          something has stopped on the road; go round it
 *   RECOVER        off-track or spun; rejoin safely
 *   PIT_APPROACH   entering the pit lane
 *   PIT_EXIT       leaving the pit lane, rejoining
 *
 * Steering uses pure pursuit toward a look-ahead point on the target path. The
 * look-ahead distance scales with speed, which is what makes the same controller
 * stable both through Monaco's hairpin and along Monza's back straight.
 */

export type AIState =
  | 'LINE_FOLLOWER'
  | 'OVERTAKE'
  | 'DEFEND'
  | 'FOLLOW'
  | 'AVOID'
  | 'RECOVER'
  | 'PIT_APPROACH'
  | 'PIT_EXIT';

/** What the AI knows about a neighbouring car. Filled in by the race sim. */
export interface Neighbour {
  /** Index into the race sim's car array. */
  index: number;
  /** Signed gap along the track in metres; positive means ahead. */
  gapM: number;
  /** Signed gap in seconds at current closing speed. */
  gapS: number;
  /** Lateral offset from the centreline, +left, metres. */
  lateral: number;
  /** Their speed, m/s. */
  speedMs: number;
  /** Closing rate, m/s. Positive means we are catching them. */
  closingMs: number;
}

/** Spatial picture the race sim hands the AI each decision tick. */
export interface AIPerception {
  /**
   * Metres of pit-exit blend zone remaining. Above zero, the car must keep off
   * the racing line and let faster traffic through.
   */
  blendRemainingM: number;
  ahead: Neighbour | null;
  behind: Neighbour | null;
  /** Cars alongside, within a car length longitudinally. */
  alongsideLeft: Neighbour | null;
  alongsideRight: Neighbour | null;
  /**
   * The car in front that this one has to avoid HITTING, as opposed to the car
   * in front on the timing screen.
   *
   * Different from `ahead` in the two ways that decide whether a collision
   * happens. It is filtered to the corridor this car is actually driving down,
   * so a car being cleanly passed two metres across the road is not something to
   * brake for; and it is chosen by which car imposes the lowest safe speed
   * rather than by which is nearest, so a stopped car sixty metres away outranks
   * a fast one at twenty.
   *
   * `ahead` is deliberately left exactly as it was — the racing logic that reads
   * it (overtake range, follow distance, defending) is about position, and
   * position is a longitudinal idea.
   */
  hazard: Neighbour | null;
  /**
   * A car that has STOPPED on the road in front of this one, or null.
   *
   * The third picture, and the one that answers "is there something here I have
   * to drive round". Neither of the other two can:
   *
   *   `ahead` is the car in front on the timing screen, and the racing logic
   *   that reads it holds station on it. Holding station on a car that is not
   *   moving means stopping — and then the car behind holds station on US, and
   *   the whole field is parked. Measured at Monza and Monaco with one car
   *   pinned to the racing line: 0 of the field still moving four minutes later
   *   (`npm run probe:blockage`).
   *
   *   `hazard` is corridor-filtered, so it vanishes the instant this car has
   *   moved a couple of metres across the road — which is exactly when the
   *   avoidance is half done, and letting go of it there steers straight back
   *   into the obstacle.
   *
   * So this one has no corridor filter, carries the obstacle's own lateral
   * position (the number needed to choose a side), and is qualified by how long
   * the car has been standing rather than by how slowly it is going — a grid
   * full of stationary cars at the start is not twenty obstacles.
   */
  blockage: Neighbour | null;
  /**
   * Metres this car may move to its LEFT before its bodywork reaches another
   * car's. `Infinity` when the road on that side is clear.
   *
   * Measured to bodywork rather than to centres, so zero means touching, and it
   * accounts for cars that are not beside us yet but will be by the time the
   * move completes — see `lateralOverlap`.
   */
  roomLeftM: number;
  /** The same, to the right. */
  roomRightM: number;
  /** True when overtaking is forbidden here — any yellow, or a neutralisation. */
  localYellow: boolean;
  /**
   * 0 green, 1 single waved yellow, 2 double waved yellow.
   *
   * Single yellow: "reduce their speed and be prepared to change direction"
   * (2025 Art. 26.1a / 2026 Art. B1.8.4a). Double: "reduce your speed
   * significantly ... and be prepared to change direction or stop" (Art. 26.1b /
   * B1.8.4b). A driver who treats the two the same is not obeying either.
   */
  yellowLevel: 0 | 1 | 2;
  /** True when the car is being lapped and must yield. */
  blueFlag: boolean;
  /** Safety car or VSC in force — hold position and respect the delta. */
  neutralised: boolean;
  /** Speed cap the neutralisation imposes, m/s. 0 when not applicable. */
  neutralisedTargetMs: number;
  /**
   * Fraction of the racing-line speed to run at under a neutralisation.
   *
   * The cap alone only bites on the straights, which is why a safety car built
   * from a cap alone produced a lap barely slower than a racing one at a circuit
   * whose corners were already under it. See `SC_PACE_SCALE`.
   */
  neutralisedScale: number;
  /** Multiplier a car over the queue gap limit may use to close it. */
  neutralisedCatchUpMult: number;
  /**
   * Maximum gap to the car ahead under a safety car, metres. 0 when free.
   * Ten car lengths — Art. 55.7 / B5.13.2b.
   */
  queueGapM: number;
  /**
   * Metres to whatever is in front of this car in the queue, or -1 for nothing.
   *
   * Not the same as `ahead.gapM`, and the difference is the whole of the
   * form-up defect. The queue forms up behind the SAFETY CAR (Art. 55.7 /
   * B5.13.2b), so for the leader the thing in front is the safety car and not
   * a racing car at all. With only `ahead` to read, the leader had no gap to
   * close, never closed one, and the nineteen cars behind it dutifully held
   * station on a leader that was itself hundreds of metres adrift.
   */
  queueAheadM: number;
  /**
   * Metres to the safety car ahead on the road, or -1 when it is not there.
   *
   * Separate from `queueAheadM` because it answers a different question: how
   * close this car may get before it would be driving past the safety car.
   */
  safetyCarAheadM: number;
  /** Speed of the safety car, m/s. */
  safetyCarSpeedMs: number;
  /** Speed of whatever `queueAheadM` measures to, m/s. */
  queueAheadSpeedMs: number;
  /**
   * This car has been waved past and must unlap itself past the lead-lap cars
   * and the safety car. Art. 55.14 / B5.13.4c.
   */
  mustUnlap: boolean;
  /**
   * Lead-lap car while others unlap: hold the racing line and let them by.
   * Art. 55.14 / B5.13.4c.
   */
  holdRacingLine: boolean;
  /**
   * The safety car has come in but this car has not yet crossed the Line, so
   * overtaking is still forbidden. Art. 55.8 / B5.13.2c.
   */
  holdUntilLine: boolean;
  /** True when the strategy wants this car in the pits this lap. */
  pitThisLap: boolean;
  /**
   * Metres still to run to this car's own pit box, or -1 when there is no box
   * to stop at — not in the lane, or already serviced this visit.
   *
   * A driver in the pit lane is not driving to the end of it, they are driving
   * to a painted rectangle with their own crew standing in front of it, and
   * they have to arrive at it stopped. Without this the AI simply held the
   * limiter the length of the lane and drove out the far end.
   */
  pitBoxAheadM: number;
  /** 0 dry .. 1 standing water, AT THIS CAR'S POSITION. */
  wetness: number;
  /**
   * How far off the dry line the grip has moved, 0..1.
   *
   * 0 says the racing line is the place to be, which is the answer on a dry
   * track and on a track that has dried. 1 says the rubbered groove has gone
   * slick under the water and there is meaningfully more grip beside it.
   *
   * It is a GRIP measurement, not a wetness threshold — `TrackSurface`
   * computes it by asking its own grip function the same question the driver is
   * asking — so the line the AI takes and the grip the physics gives it cannot
   * come apart. This is the field that makes twenty cars visibly abandon the
   * racing line when the rain arrives and drift back onto it as it dries.
   */
  lineAvoidance: number;
  /**
   * How hard this driver has to save fuel, 1 = not at all.
   *
   * From `FuelPlan.fuelPaceScale`, which is where the whole argument lives.
   * The short version: the tank is emptied per second and was filled per
   * kilometre, and the failure mode of getting that wrong is not a slow car —
   * `VehiclePhysics.step` makes no drive force at all on an empty tank, so the
   * car simply coasts to a halt on the racing surface with the throttle open.
   * Measured on `main`: sixteen of twenty cars retired that way in one
   * full-distance race.
   *
   * It is a lift-and-coast instruction, which is a real and extremely common
   * one, and this codebase already puts it on the team radio (`RaceEngineer`
   * files a `fuel` note when the margin goes negative). Nothing listened to it.
   */
  fuelPaceScale: number;
}

export function createPerception(): AIPerception {
  return {
    blendRemainingM: 0,
    ahead: null, behind: null, alongsideLeft: null, alongsideRight: null,
    hazard: null, blockage: null, roomLeftM: Infinity, roomRightM: Infinity,
    localYellow: false, yellowLevel: 0, blueFlag: false, neutralised: false,
    neutralisedTargetMs: 0, neutralisedScale: 0, neutralisedCatchUpMult: 1,
    queueGapM: 0, queueAheadM: -1, safetyCarAheadM: -1, safetyCarSpeedMs: 0,
    queueAheadSpeedMs: 0, mustUnlap: false,
    holdRacingLine: false, holdUntilLine: false,
    pitThisLap: false, pitBoxAheadM: -1, wetness: 0, lineAvoidance: 0,
    fuelPaceScale: 1,
  };
}

/**
 * The fastest this car can get through the corner at `sAt`, from the lateral
 * force balance:
 *
 *     m v^2 / R = mu (m g + cl v^2)
 *  => v^2 = mu m g / (m/R - mu cl)
 *
 * When the denominator goes non-positive the corner is aero-limited — grip
 * grows with speed faster than the demand does — so it is flat out. That single
 * term is why an F1 car takes a 500m-radius kink without lifting.
 *
 * Uses the LIMITING axle's grip, not the average: the car lets go when the
 * first end runs out, not when the mean does.
 *
 * Module-level and exported because the PLAYER needs it too and has no AI to
 * ask. The neutralised limiter applied to the player's car has to be computed
 * against the same reference the nineteen cars around them are driving to, or
 * it is a different limit with the same name: measured at Monaco, a limit
 * derived from the raw racing-line speed instead let the player run 47% quicker
 * than the queue they were in, while every individual number in it looked
 * right.
 */
export function corneringSpeedLimitMs(
  track: TrackSpline, car: VehiclePhysics, sAt: number,
): number {
  // The worst curvature over the next stretch, so the limit is set by the
  // tightest part of the corner rather than by wherever the sample landed.
  // A short window only. Twenty-four metres is eight nodes, which flattens a
  // whole corner down to its single tightest point and holds the car at that
  // speed through the entry and the exit as well as the apex. The braking
  // scan already looks ahead properly, so this only needs to cover the
  // sampling grid.
  let k = 0;
  for (let d = 0; d <= 9; d += 3) {
    const a = Math.abs(track.lineCurvature[track.indexAt(sAt + d)]);
    if (a > k) k = a;
  }
  if (k < 1e-5) return Infinity;

  const radius = 1 / k;
  const m = car.totalMassKg;
  const grip = Math.min(car.frontTires.grip, car.rearTires.grip);
  const mu = car.spec.baseMu * grip;
  const cl = car.spec.clBase * car.dirtyAirDownforceMult;

  const denom = m / radius - mu * cl;
  if (denom <= 1e-6) return Infinity;
  return Math.sqrt((mu * m * 9.81) / denom);
}

export function createNeighbour(): Neighbour {
  return { index: -1, gapM: 0, gapS: 0, lateral: 0, speedMs: 0, closingMs: 0 };
}

export type AIDifficultyId = 'easy' | 'medium' | 'hard';

/**
 * How hard the field is to race against.
 *
 * The principle is the same one the whole AI is built on: the opposition drives
 * the same car through the same physics as the player, with the same five
 * inputs. Difficulty therefore changes how well they DRIVE it — how close to
 * the limit they run, how tidy they are, how willing they are to have a go —
 * and never gives or takes grip, power or lap time directly. An easy field is
 * beatable because it brakes earlier and makes more mistakes, which is
 * something the player can watch happening and exploit, rather than because a
 * number was subtracted from its lap time somewhere off-screen.
 *
 * `hard` is the calibrated baseline: every multiplier is 1, so the field runs
 * exactly as `scripts/tuneAI.ts` tuned it. Easier levels only ever scale down
 * from there, which means adding a difficulty cannot change what the validation
 * harness measures.
 */
export interface AIDifficulty {
  id: AIDifficultyId;
  label: string;
  /** Description for the settings screen. */
  blurb: string;
  /** Scale on the speed the driver attempts everywhere on the lap. */
  paceScale: number;
  /** Scale on how close to the computed cornering limit they run. */
  commitmentScale: number;
  /** Scale on how late they brake. */
  brakingScale: number;
  /** Scale on willingness to attack and to defend. */
  aggressionScale: number;
  /** Scale on the size of their errors and the rate they make them. */
  errorScale: number;
}

export const AI_DIFFICULTIES: Record<AIDifficultyId, AIDifficulty> = {
  easy: {
    id: 'easy', label: 'Easy',
    blurb: 'Brakes early, holds the line, rarely fights back',
    paceScale: 0.945, commitmentScale: 0.94, brakingScale: 0.93,
    aggressionScale: 0.55, errorScale: 1.8,
  },
  medium: {
    id: 'medium', label: 'Medium',
    blurb: 'Racing pace, will defend a position',
    paceScale: 0.976, commitmentScale: 0.975, brakingScale: 0.97,
    aggressionScale: 0.8, errorScale: 1.25,
  },
  hard: {
    id: 'hard', label: 'Hard',
    blurb: 'Everything the car has, and they want the place back',
    paceScale: 1, commitmentScale: 1, brakingScale: 1,
    aggressionScale: 1, errorScale: 1,
  },
};

/** What a new player gets. */
export const DEFAULT_AI_DIFFICULTY: AIDifficultyId = 'medium';

/**
 * What a session that does not specify a level gets.
 *
 * Deliberately NOT the player default. `hard` has every multiplier at 1, so an
 * unconfigured field is exactly the field `scripts/tuneAI.ts` calibrated and
 * every validation script has always measured. Defaulting to the player's level
 * instead would silently re-baseline the entire harness the moment a difficulty
 * setting was added — every lap-time check in the suite would move because of a
 * menu option.
 */
export const CALIBRATION_DIFFICULTY: AIDifficultyId = 'hard';

/** Coerces anything stored in a save into a valid difficulty id. */
export function toDifficultyId(value: unknown): AIDifficultyId {
  if (typeof value === 'string' && value in AI_DIFFICULTIES) return value as AIDifficultyId;
  // Older saves stored a bare number, 0..1. Map it onto the nearest level so a
  // career in progress keeps roughly the opposition it was being played at.
  if (typeof value === 'number') {
    if (value < 0.75) return 'easy';
    if (value < 0.92) return 'medium';
    return 'hard';
  }
  return DEFAULT_AI_DIFFICULTY;
}

/** Tuning derived once from a driver's attributes. */
interface DriverProfile {
  /** Fraction of the reference speed profile this driver attempts. */
  paceFactor: number;
  /** How late they brake relative to the reference. >1 is later. */
  brakingConfidence: number;
  /** Gap in seconds at which they commit to an overtake. */
  overtakeThresholdS: number;
  /** How close they will run to the car ahead. Lower is braver. */
  followDistanceS: number;
  /** Magnitude of random steering/throttle noise. */
  errorScale: number;
  /** Willingness to use the full track width when defending. */
  defenceCommitment: number;
  /** How hard they lean on the tires. Lower saves them. */
  tyreAbuse: number;
}

function profileFor(d: Driver, wetness: number, diff: AIDifficulty): DriverProfile {
  // Wet conditions shift the weighting from raw pace toward wet skill, which is
  // why the order shuffles in the rain rather than staying fixed.
  const effSkill = lerp(d.skill, d.wetSkill, clamp01(wetness));
  // Difficulty scales the driver's attributes, so the SPREAD between a good
  // driver and a poor one survives at every level — an easy field is still led
  // by the quick drivers, it is just slower and messier as a whole.
  const aggression = clamp01(d.aggression * diff.aggressionScale);
  const racecraft = clamp01(d.racecraft * diff.aggressionScale);
  return {
    // A 0.77-skill backmarker runs ~2.5% off the reference; a 0.97 driver is
    // essentially on it. Across a 90s lap that is a spread of about 2.2s.
    paceFactor: lerp(0.968, 1.0, (effSkill - 0.75) / 0.25) * diff.paceScale,
    brakingConfidence: lerp(0.9, 1.02, (effSkill - 0.75) / 0.25) * diff.brakingScale,
    overtakeThresholdS: lerp(1.15, 0.55, aggression),
    followDistanceS: lerp(0.9, 0.35, aggression),
    errorScale: lerp(0.028, 0.004, d.consistency) * diff.errorScale,
    defenceCommitment: lerp(0.45, 1.0, racecraft),
    tyreAbuse: lerp(1.12, 0.9, d.tyreManagement),
  };
}

/**
 * Global scale on how close every AI runs to its computed limit.
 *
 * Exposed as a mutable module constant so `scripts/tuneAI.ts` can sweep it and
 * find the highest value at which the whole field completes clean laps on every
 * circuit. Tuning this empirically against the real simulation is far more
 * reliable than reasoning about it — the value that works is a property of the
 * controller's tracking accuracy, not something derivable from the physics.
 */
export const AI_TUNING = {
  /** How close to its computed cornering limit the whole field runs. */
  commitmentScale: 0.90,
  /**
   * Share of the rear axle's remaining longitudinal capacity the AI will use.
   *
   * `tractionLimitFraction` is the pedal at which the rears begin to spin, so
   * sitting exactly on it leaves the tire at the edge of its friction circle
   * with nothing in reserve for the lateral force the corner still needs.
   *
   * THIS WAS 1.03, AND THE COMMENT ABOVE ARGUES FOR A VALUE BELOW 1. Both were
   * right, because the number it multiplies was wrong. Until issue #1's work,
   * `tractionLimitFraction`'s denominator credited the car with full
   * `ersPowerW` whatever the deployment mode was actually doing, so the limit
   * it returned was too small — and by a factor that MOVED WITH THE ENERGY
   * STRATEGY: 1.212x too small in `harvest`, 1.084x in `balanced`, 1.025x in
   * `push`, and correct only in `overtake` (measured, `probe:envelope` §2).
   *
   * So a nominal 1.03 was really a throttle discipline that wandered between
   * 0.85 and 1.03 of the rear axle's true limit as a side effect of which ERS
   * mode `chooseErsMode` had picked. Nobody chose that coupling and nothing
   * recorded it.
   *
   * With the denominator corrected, 1.03 means what it says — the whole field
   * genuinely 3% past its traction limit — and `probe:racesweep` says that
   * costs races: 11/55 -> 14/55, retirements 0.62 -> 1.02, Spa over the
   * off-track bar at 96 and 106. 0.95 is the value that keeps the discipline
   * the field was really calibrated at (1.03/1.084 = 0.95 in `balanced`, which
   * is `chooseErsMode`'s default) now that the limit is honest, and it is one
   * of the four values in `scripts/tuneAI.ts`'s own throttle sweep rather than
   * a number invented here.
   *
   * A single car cannot choose this and it is worth knowing why: `tuneAI.ts
   * throttle` flies ONE car and reports 11/11 clean and ZERO excursions at
   * every value from 0.85 to 1.10, monotonically faster the higher it goes.
   * The cost only exists in traffic, which is #1 and #30 being different
   * problems (PROJECT.md §7).
   */
  throttleShare: 0.95,
  /** Share of the lock-up-limited brake pedal the AI will use. */
  brakeShare: 0.98,
};

/**
 * Fraction of the tires' grip circle a driver commits to STRAIGHT-LINE braking.
 *
 * Not 1.0, because a braking zone is never perfectly straight and the car is
 * already turning in by the end of it. Not the old 0.72 either — that reserved
 * so much grip that the AI began braking half again as early as it needed to.
 */
const BRAKING_GRIP_SHARE = 0.9;

/**
 * Deceleration used to bring a car to rest on its pit box, m/s².
 *
 * Gentle: this is a driver rolling up to their crew under the limiter, not a
 * braking zone.
 *
 * MEASURED, not chosen. This was 6, which reads like a modest number next to
 * the 20-plus a braking zone uses — but a car in the pit lane is doing 80km/h
 * on tyres that have been cooling since the entry, and the friction circle was
 * scaling its brake demand down to under a tenth. Full pedal delivered about
 * 4m/s². Planning the approach at 6 meant the profile was never achievable, so
 * the car crossed its own box at 8-9m/s, was not serviced, left the lane, and
 * — its strategy still calling for a stop — came straight back in next lap.
 * Half the field spent the race doing that.
 *
 * At 3.2 the approach is planned at a rate the car can actually hold with the
 * pedal in reserve. From the limit that needs about 77 metres, and the boxes
 * sit at least 90 past the pit entry (see PitGeometry), so there is room.
 */
const PIT_BOX_DECEL_MS2 = 3.2;
/** How near its box the car counts as having arrived, metres. */
const PIT_BOX_ARRIVED_M = 0.4;
/**
 * How near its box a car is committed to stopping, metres.
 *
 * Inside this, the driver is stopping — full stop, on the brakes, whatever the
 * approach profile says. Without it the controller let go of the brake the
 * instant the box went behind the car (the perception reports -1 for "no box
 * ahead") and drove away from a stop it was two metres from completing.
 */
const PIT_BOX_COMMIT_M = 12;
/** How long a committed car keeps the brake on after its box goes behind it. */
const PIT_BOX_HOLD_S = 3;
/**
 * The pit lane constants and the entry braking profile live in
 * `physics/PitLimiter` rather than here.
 *
 * They used to be local to this file, which was fine while the AI was the only
 * thing that knew how to arrive at a pit lane. It is not: the player's limiter
 * is applied automatically by the race engine, the cap itself is enforced in
 * `VehiclePhysics`, and all three have to agree to the km/h or race control
 * penalises a car the simulation was itself holding at the wrong speed.
 */

/**
 * How much of its speed a driver gives up for a yellow flag.
 *
 * A modelling choice, not a regulation — see the note at the call site. The
 * FIA fixes the ordering (a double must be a bigger lift than a single, and
 * both must be discernible) and publishes no numbers.
 */
const YELLOW_LIFT_SINGLE = 0.88;
const YELLOW_LIFT_DOUBLE = 0.62;

/**
 * How close a car may get to the one in front while overtaking is forbidden,
 * metres.
 *
 * Three car lengths. Under a neutralisation the overtaking ban is absolute
 * (Art. 55.8 / B5.13.2c, Art. 56.5 / B5.12.2b), and the only thing that makes a
 * ban real in a simulation is a following car that will not close the gap far
 * enough to get alongside. Comfortably inside the ten-car-length queue limit, so
 * a queue that holds this distance is also a queue that satisfies Art. 55.7.
 */
const NO_PASS_HOLD_M = 17;

/**
 * How far behind the safety car a driver starts giving way to it, metres.
 *
 * More than twice `NO_PASS_HOLD_M`, and the floor it tapers to is much lower,
 * because the two are not the same instruction. A car ahead is something you
 * may end up alongside and must then not complete a pass on; the safety car is
 * something no F1 car may be in front of at all while it is deployed — the
 * queue forms up BEHIND it (Art. 55.7 / B5.13.2b) and overtaking is forbidden
 * from deployment until the Line (Art. 55.8 / B5.13.2c). A soft hold measured
 * at the car-to-car distance was not enough: the leader arrived, sat at fifteen
 * metres targeting 95% of the safety car's speed, overshot on a corner exit,
 * and was a hundred and forty metres in front of it a lap later.
 */
const SC_HOLD_M = 40;

/**
 * Below this speed the car ahead is treated as an obstacle rather than a rival,
 * m/s.
 *
 * About 50 km/h — slower than any corner on the calendar is taken, so a car
 * under it has spun, is limping, or has stopped. The overtaking ban is not a
 * requirement to crash into it.
 */
const NO_PASS_MIN_AHEAD_MS = 14;

/**
 * Below this target speed the driver is stopping rather than going slowly, m/s.
 *
 * About 9 km/h — under any speed a racing car is ever asked to hold, including
 * the slowest hairpin on the calendar and the pit lane limit, so nothing that is
 * merely slow can be mistaken for a stop.
 */
const CRAWL_MS = 2.5;

/** How often the FSM re-evaluates its state, in seconds. */
const DECISION_INTERVAL = 0.1;
/** How often the proximity scan runs while committed to a move. */
const CLOSE_QUARTERS_INTERVAL = 1 / 120;

export class AIVehicleController {
  readonly driver: Driver;
  private readonly track: TrackSpline;
  private readonly rng: Rng;

  state: AIState = 'LINE_FOLLOWER';
  /** True once the car is close enough to its box to be stopping at it. */
  private boxCommitted = false;
  /** Seconds spent on the brake past the box while committed to the stop. */
  private boxOvershootS = 0;
  /** Seconds spent in the current state. */
  stateTime = 0;

  /** Lateral offset the AI is currently targeting, relative to centreline. */
  targetLateral = 0;
  private smoothedLateral = 0;

  /** The controls this AI produced last tick. */
  readonly controls: VehicleControls = {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false, speedLimitMs: 0,
    reverse: false,
  };

  /**
   * The speed this driver was asking for last tick, m/s, after every cap.
   *
   * Written for one reason: so that a harness can tell "the AI aimed low" apart
   * from "the AI aimed correctly and could not hold it". Those are different
   * defects with different fixes, and for the whole life of issue #1 the only
   * number anybody had was the lap time, which is their sum. A probe that
   * recomputes the target itself is measuring its own copy of the rule
   * (PROJECT.md §3.2), so the real one is published instead. Never read by the
   * simulation.
   */
  lastTargetSpeedMs = 0;

  private profile: DriverProfile;
  private decisionTimer = 0;
  private errorPhase = 0;
  /** Slowly-varying pace noise, so a driver has good and bad laps. */
  private formNoise = 0;
  /** Counts down after an off-track moment; the driver backs off while it runs. */
  private shakenTimer = 0;
  /** How long the car has been at a standstill while trying to recover. */
  private stallTimer = 0;
  /** Seconds left of a deliberate reversing manoeuvre. */
  private reverseTimer = 0;

  /**
   * FIA regulations allow one change of direction to defend a position. This
   * tracks whether that move has been used on the current straight, and resets
   * when the car next brakes for a corner.
   */
  private defensiveMoveUsed = false;
  private lastPassingZone = false;

  /** Set when the AI decides to commit to a pass, cleared when done. */
  private overtakeTargetIndex = -1;
  private overtakeSide = 0;

  /**
   * Which stopped car is being driven round, and on which side.
   *
   * Latched, because the side has to be decided ONCE. Re-deciding it every tick
   * against a shrinking gap is how a car ends up steering left, then right,
   * then arriving at the obstacle in the middle of the road having committed to
   * nothing — and there is no second chance with something that is not moving.
   */
  private avoidSide = 0;

  /** Cached scratch to avoid allocating in the hot path. */
  private readonly lookAheadPoint = new Vec2();

  /** Node index hint for the track projection, kept between ticks. */
  nodeHint = 0;

  /** Previous steering output, for the rate limiter. */
  private lastSteer = 0;

  /**
   * How much margin this circuit demands, 0..1, applied to cornering speed.
   *
   * What forgives a tracking error is RUN-OFF, not track width. The margin used
   * to be derived from the width alone, which gets Monaco right by accident and
   * Jeddah completely wrong: Jeddah is a wide circuit lined with walls, so the
   * AI committed to it as though it were Silverstone and fifteen of twenty cars
   * retired against the barriers in a five-lap race. Half a metre of error
   * costs nothing on a permanent circuit and ends the race on a street one.
   */
  private readonly runoffCaution: number;

  /** How hard this driver is to race against. */
  private difficulty: AIDifficulty = AI_DIFFICULTIES[CALIBRATION_DIFFICULTY];
  private lastWetness = 0;

  constructor(driver: Driver, track: TrackSpline, seed: number, difficulty?: AIDifficultyId) {
    this.driver = driver;
    this.track = track;
    this.runoffCaution = track.def.scenery === 'street' ? 0.96 : 1.0;
    this.rng = new Rng(seed);
    if (difficulty) this.difficulty = AI_DIFFICULTIES[difficulty];
    this.profile = profileFor(driver, 0, this.difficulty);
    this.errorPhase = this.rng.range(0, 100);
  }

  /** Changes the difficulty mid-session. Used by the settings screen. */
  setDifficulty(id: AIDifficultyId): void {
    this.difficulty = AI_DIFFICULTIES[id];
    this.profile = profileFor(this.driver, this.lastWetness, this.difficulty);
  }

  /** Recomputes the driver profile when conditions change materially. */
  onConditionsChanged(wetness: number): void {
    this.lastWetness = wetness;
    this.profile = profileFor(this.driver, wetness, this.difficulty);
  }

  /**
   * How far off the dry line this driver has decided to run, 0..1.
   *
   * Damped toward what the surface model says is available rather than set from
   * it, and damped SLOWLY — three seconds or so to make the move. A driver does
   * not step sideways the instant the grip changes; they feel it over a corner
   * or two and then commit. Setting it directly made the whole field twitch
   * laterally as they crossed between a soaked node and a slightly less soaked
   * one, which looks like a bug because it is one.
   *
   * `driver.wetSkill` scales it: a driver who is good in the wet finds the
   * off-line grip and a driver who is not stays on the familiar line for
   * longer. That is a real difference between drivers and it costs the ones who
   * do not adapt real lap time, through the same grip model as everyone else.
   */
  private lineAvoidance = 0;

  private updateLineAvoidance(dt: number, want: number): void {
    const willing = 0.55 + this.driver.wetSkill * 0.45;
    this.lineAvoidance = damp(this.lineAvoidance, clamp01(want) * willing, 0.35, dt);
  }

  /**
   * Produces controls for this physics step.
   *
   * The FSM transition check runs at 10Hz because racing decisions do not need
   * to be re-litigated 120 times a second, but the steering and pedal control
   * runs every step so the car is smooth. While actually alongside another car,
   * the proximity check escalates to full rate — that is the one situation where
   * a 100ms-stale picture causes a collision.
   */
  update(
    dt: number,
    car: VehiclePhysics,
    s: number,
    lateral: number,
    perception: AIPerception,
  ): VehicleControls {
    this.stateTime += dt;
    this.decisionTimer -= dt;
    this.updateLineAvoidance(dt, perception.lineAvoidance);
    if (this.shakenTimer > 0) this.shakenTimer -= dt;

    const closeQuarters =
      perception.alongsideLeft !== null ||
      perception.alongsideRight !== null ||
      (perception.ahead !== null && perception.ahead.gapM < 12);

    if (this.decisionTimer <= 0) {
      this.evaluateState(car, s, lateral, perception);
      this.decisionTimer = closeQuarters ? CLOSE_QUARTERS_INTERVAL : DECISION_INTERVAL;
    }

    this.driveTowardTarget(dt, car, s, lateral, perception);
    return this.controls;
  }

  // =========================================================================
  // State machine
  // =========================================================================

  private setState(next: AIState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
  }

  private evaluateState(
    car: VehiclePhysics,
    s: number,
    lateral: number,
    p: AIPerception,
  ): void {
    const track = this.track;
    const halfWidth = track.halfWidthAt(s);

    // --- Highest priority: recovery. Everything else is irrelevant if the car
    // is off the road or pointing the wrong way.
    const offTrack = Math.abs(lateral) > halfWidth + 1.2;
    // A car can be a long way sideways and still be recovering under control, so
    // "spun" means genuinely pointing the wrong way, not merely oversteering.
    const spun = Math.abs(wrapAngle(car.heading - track.headingAt(s))) > 1.55;
    // --- Pit exit blend ---------------------------------------------------
    // Rejoining traffic holds the pit side of the road until it is up to speed.
    // Without this, cars leaving the garage merge onto the racing line at a
    // third of racing speed and are collected by the field — which in testing
    // retired five of the ten runners in Q3 before anyone set a lap.
    if (p.blendRemainingM > 0 && !offTrack && !spun) {
      this.setState('LINE_FOLLOWER');
      const pitSide = Math.sign(track.def.pitLane.lateralOffsetM || 1);
      this.targetLateral = clamp(pitSide * halfWidth * 0.7, -halfWidth, halfWidth);
      return;
    }

    // --- Inside the pit lane, nothing else applies -------------------------
    // This has to come BEFORE the off-track test, because a car in the pit lane
    // is by definition a long way outside the track's half-width and the test
    // cannot tell the difference.
    //
    // It could not, and the consequences were severe. A pit lane offset ten or
    // more metres from the centreline — which is most of the calendar — put
    // every car that entered the pits straight into RECOVER. RECOVER steers for
    // the racing line; the pit-lane code simultaneously drags the car back to
    // the pit offset and rebuilds its position from (s, lateral), which
    // discards exactly the lateral motion the AI was generating. The result is
    // a car doing 50 km/h whose distance-along-lap does not advance at all: it
    // sits in the pit lane burning its whole velocity sideways, for the rest of
    // the race, holding a yellow flag and a safety car with it. Half the field
    // ended up in that state, which is why races took four times as long as
    // they should and why almost nobody was classified.
    //
    // It is also, from the outside, exactly what the pit lane looked like:
    // one car crawling, everyone else queued behind it.
    if ((this.state === 'PIT_APPROACH' || this.state === 'PIT_EXIT') && this.isInPitLane(s)) {
      this.targetLateral = track.def.pitLane.lateralOffsetM;
      return;
    }

    if (offTrack || spun) {
      this.shakenTimer = 6;
      this.setState('RECOVER');
      this.targetLateral = clamp(this.lineAtNode(track.indexAt(s)), -halfWidth * 0.5, halfWidth * 0.5);
      return;
    }
    if (this.state === 'RECOVER') {
      // Hysteresis: require the car to be comfortably back on the road, not just
      // barely inside the line, before resuming racing. Without the margin the
      // state flaps every decision tick and the controller never settles.
      const safelyOn = Math.abs(lateral) < halfWidth - 0.8;
      const recovered = safelyOn && !spun && car.forwardSpeedMs > 8 && this.stateTime > 0.6;
      if (!recovered) return;
      this.setState('LINE_FOLLOWER');
    }

    // --- Pit lane states are sticky; the strategy layer owns them.
    if (this.state === 'PIT_APPROACH' || this.state === 'PIT_EXIT') {
      // Hold the pit lane's own lateral offset while inside it.
      //
      // This used to return without touching targetLateral, so the car kept
      // whatever line it had been aiming at — which is the RACING line. Cars
      // leaving a garage therefore drove diagonally out of the pit lane onto
      // the circuit while still in the pit lane's distance range, arrived at
      // racing-line lateral doing 80 km/h, and were collected by the field.
      if (this.isInPitLane(s)) {
        this.targetLateral = track.def.pitLane.lateralOffsetM;
      }
      // NOT moved across to the pit-entry side on the approach, though a real
      // driver does. Tried, and it costs more than it saves: the pit side of
      // the road is the outside of some of the corners leading to it, and a car
      // holding three quarters of the half-width through those simply runs out
      // of road. Off-track excursions went UP by a third across the calendar,
      // and Spa acquired a hundred of its own. The approach stays on the line
      // the solver produced until the car is actually in the lane.
      return;
    }
    if (p.pitThisLap) {
      const pit = track.def.pitLane;
      // Commit once inside the braking distance for the pit entry.
      //
      // The commitment is decided by whether there is ROOM TO STOP, not by a
      // fixed distance. A strategist's call can arrive at any moment — a tyre
      // going off, a safety car, a puncture — and if it lands eighty metres
      // before the pit entry line at 280 km/h, the car physically cannot be
      // under 80 km/h by the line. Diving in anyway is what produced the loop
      // that ate the race: cross the line over the limit, take a drive-through,
      // come in to serve it, arrive over the limit again, take another.
      //
      // A driver in that position stays out and comes in next lap, and so does
      // this. The 1.15 is margin for the brakes not biting instantly.
      const toEntry = loopDelta(s, pit.entryS, track.length);
      const vAtLine = pitEntryTargetMs(pit);
      const v = car.speedMs;
      const roomNeeded =
        Math.max(v * v - vAtLine * vAtLine, 0) / (2 * PIT_ENTRY_DECEL_MS2) + PIT_ENTRY_SETTLE_M;
      if (toEntry > 0 && toEntry < PIT_ENTRY_SCAN_M && toEntry > roomNeeded * 1.08) {
        this.setState('PIT_APPROACH');
        return;
      }
    }

    // --- AVOID. Something has stopped on the road. Go round it.
    //
    // ABOVE THE NEUTRALISATION BRANCH ON PURPOSE, and this is the one place the
    // ordering is a regulation rather than a preference. Art. 55.14 / B5.13.4c
    // requires cars on the lead lap to "always stay on the racing line unless
    // deviating is unavoidable" — and a car parked on the racing line is the
    // definition of unavoidable. It is also the case that matters most: the
    // stopped car is very often WHY the race was neutralised, so a rule that
    // put every car back on the racing line while it was neutralised would send
    // the whole field, in order, into the thing being recovered.
    //
    // What this is NOT is an overtake. There is no gate on a passing zone, on
    // closing speed, or on a yellow flag, because none of those questions are
    // being asked: a stationary car is not a position being contested, it is an
    // obstacle, and a driver under double waved yellows is instructed to "be
    // prepared to change direction or stop" (Art. 26.1b / B1.8.4b) — to change
    // direction, not to stop behind it. The speed the car goes past at is
    // already handled elsewhere: the yellow lift, the neutralisation cap and
    // the `hazard` following bound all still apply on top of this, and all
    // three are speed limits rather than steering.
    const block = p.blockage;
    if (block !== null) {
      const committing = this.state !== 'AVOID' || this.avoidSide === 0;
      this.setState('AVOID');
      // DECIDE THE SIDE ONCE, ON ENTERING, AND THEN LIVE WITH IT.
      //
      // Not once per obstacle, which is what this did first and what does not
      // work: a queue behind a stopped car is itself a row of stopped cars, so
      // the NEAREST one keeps changing as they shuffle, and a decision keyed on
      // its identity is re-taken every few steps. Nor freshly every tick. Both
      // produce the same failure, measured at Monza in the `[held]` mode of
      // `probe:blockage`: a car sitting directly behind the obstacle is a
      // hand's width to one side of it, the tie-break flips on that hand's
      // width, and the target offset alternates between +0.3m and -6.7m at the
      // decision rate. The car never commits to either, tracks the average,
      // arrives still on the racing line, and stops.
      //
      // Cars either side of us are still read live below, because the room on
      // the left is exactly what changes while nineteen other cars are making
      // the same decision. It is the SIDE that is latched.
      if (committing) {
        // THE SIDE THIS CAR IS ALREADY ON, unless the road is not there.
        //
        // Choosing purely by which side has more asphalt is wrong and was also
        // measured wrong. A stopped car sits near the middle of the road, so
        // "more asphalt" comes out the same way for every car in the field —
        // and a car already four metres to the right of it is then asked to
        // cross the whole road, in front of it, to reach the side that won by a
        // few centimetres. `roomLimited` correctly refuses to drive that car
        // through the obstacle, so the target it can actually reach is a
        // position two and a half metres away, which is inside
        // `HAZARD_CORRIDOR_M` and therefore still something to brake for.
        const roomIfLeft = halfWidth - block.lateral;
        const roomIfRight = halfWidth + block.lateral;
        const dLat = lateral - block.lateral;
        if (Math.abs(dLat) > BLOCKAGE_SIDE_DEADBAND_M) {
          // Far enough to one side that "the side I am on" means something.
          let side = Math.sign(dLat);
          const roomOurs = side > 0 ? roomIfLeft : roomIfRight;
          const roomOther = side > 0 ? roomIfRight : roomIfLeft;
          // Only cross if the road genuinely is not there on our own side,
          // which is the case that matters at a hairpin.
          if (roomOther > roomOurs + BLOCKAGE_CLEARANCE_M) side = -side;
          this.avoidSide = side;
        } else if (Math.abs(roomIfLeft - roomIfRight) > 1.0) {
          // Squarely behind it: take the side with the road on it.
          this.avoidSide = roomIfLeft > roomIfRight ? 1 : -1;
        } else {
          // Squarely behind it, in the middle of a symmetric road. Go the way
          // the racing line is not, which is where the cars are not.
          this.avoidSide = -Math.sign(this.lineAtNode(track.indexAt(s)) || 1);
        }
      }
      const freeLeft = p.roomLeftM > RACING_ROOM_M + 1.0;
      const freeRight = p.roomRightM > RACING_ROOM_M + 1.0;
      // ...but never into a side somebody else is already using. Taking the
      // wider side regardless is how two cars avoiding the same obstacle end up
      // avoiding it into each other.
      if (this.avoidSide > 0 && !freeLeft && freeRight) this.avoidSide = -1;
      else if (this.avoidSide < 0 && !freeRight && freeLeft) this.avoidSide = 1;

      // Clear of its bodywork by a margin, measured from where IT is rather
      // than from the centreline, and held inside the white line so that going
      // round a stopped car is not itself a track-limits offence.
      const want = block.lateral + this.avoidSide * BLOCKAGE_CLEARANCE_M;
      this.targetLateral = clamp(want, -halfWidth * 0.92, halfWidth * 0.92);
      return;
    }
    // Past it, or it moved. The next obstacle is a fresh decision.
    this.avoidSide = 0;

    // --- Under a safety car or VSC nobody races.
    //
    // Except for one case that the regulations single out: a car that has been
    // waved past is REQUIRED to unlap itself, and it cannot do that by holding
    // station. "the message 'LAPPED CARS MAY NOW OVERTAKE' will be sent ... to
    // signal to all cars that have been lapped by the leader that they are
    // required to pass the cars on the lead lap and the Safety Car"
    // (2025 Art. 55.14 / 2026 Art. B5.13.4c). So it goes past, off the racing
    // line, while the lead-lap cars hold theirs.
    if (p.mustUnlap) {
      this.setState('OVERTAKE');
      const lineOffset = this.lineAtNode(track.indexAt(s));
      this.targetLateral = clamp(-Math.sign(lineOffset || 1) * halfWidth * 0.6, -halfWidth, halfWidth);
      return;
    }
    if (p.neutralised) {
      this.setState('FOLLOW');
      // "cars on the lead lap must always stay on the racing line unless
      // deviating is unavoidable" while lapped cars come past —
      // Art. 55.14 / B5.13.4c. Off the racing line is precisely where the
      // unlapping cars are, which is why the rule exists.
      this.targetLateral = this.lineAtNode(track.indexAt(s));
      return;
    }

    // --- The safety car has come in, but this car has not yet reached the
    // Line. Racing does not resume until it does — Art. 55.8 / B5.13.2c.
    if (p.holdUntilLine) {
      this.setState('FOLLOW');
      this.targetLateral = this.lineAtNode(track.indexAt(s));
      return;
    }

    // --- Blue flag: yield. A lapped car must let the leader past, and doing so
    // means getting decisively off the racing line, not just lifting.
    if (p.blueFlag) {
      this.setState('FOLLOW');
      const lineOffset = this.lineAtNode(track.indexAt(s));
      // Move to the opposite side of the track from the racing line.
      this.targetLateral = clamp(-Math.sign(lineOffset || 1) * halfWidth * 0.72, -halfWidth, halfWidth);
      return;
    }

    const lineOffset = this.lineAtNode(track.indexAt(s));
    const inPassingZone = track.inPassingZone(s);

    // Reset the one-defensive-move allowance when we leave a passing zone —
    // effectively, at the next braking zone, which is what the rule means.
    if (this.lastPassingZone && !inPassingZone) this.defensiveMoveUsed = false;
    this.lastPassingZone = inPassingZone;

    const ahead = p.ahead;
    const behind = p.behind;
    const prof = this.profile;

    // --- DEFEND. Being attacked takes priority over attacking: losing a place
    // costs more than gaining one is worth, and it is what real drivers do.
    // The gap the sim reports is unsigned, so "within 0.8s and not losing more
    // than half a metre a second" described essentially every car in a
    // twenty-car pack for the whole race: eleven cars at a time sat in DEFEND
    // on lap one, all moving off the racing line into each other. A driver
    // defends when someone is genuinely on their gearbox AND genuinely quicker,
    // which is a much narrower condition than that.
    const underAttack =
      behind !== null &&
      behind.gapS < 0.45 &&
      behind.closingMs > 0.6;

    if (underAttack && inPassingZone && !p.localYellow) {
      this.setState('DEFEND');
      // Take the inside line for the corner ahead, denying the attacker the
      // apex. Which side is "inside" depends on which way the next corner goes.
      const nextCurve = this.upcomingCurvature(s, 160);
      let defensive: number;
      if (Math.abs(nextCurve) > 1 / 900) {
        // Inside of a left-hander is the left of the track.
        defensive = Math.sign(nextCurve) * halfWidth * 0.55 * prof.defenceCommitment;
      } else {
        // On a pure straight, cover the side the attacker is using.
        defensive = -Math.sign(behind.lateral || 1) * halfWidth * 0.4 * prof.defenceCommitment;
      }

      // One change of direction only. If the move is already made, hold it.
      if (this.defensiveMoveUsed) {
        this.targetLateral = this.smoothedLateral;
      } else {
        if (Math.abs(defensive - lineOffset) > halfWidth * 0.18) this.defensiveMoveUsed = true;
        this.targetLateral = clamp(defensive, -halfWidth * 0.8, halfWidth * 0.8);
      }
      return;
    }

    // --- OVERTAKE. Requires a real opportunity: close enough, actually
    // catching, and somewhere a pass is physically possible.
    if (ahead !== null) {
      const withinRange = ahead.gapS < prof.overtakeThresholdS;
      const catching = ahead.closingMs > 0.4;
      const canPass = inPassingZone || track.inDrsZone(s);

      // A pass needs somewhere to put the car. Both tests below are about the
      // TARMAC — how much road is left on each side of the car being passed —
      // and neither of them ever asked whether a third car was standing in it,
      // which is how a driver ends up committing to a move into an occupied
      // gap and then having to complete it or crash.
      const freeLeft = p.roomLeftM > RACING_ROOM_M + 1.0;
      const freeRight = p.roomRightM > RACING_ROOM_M + 1.0;

      if (withinRange && catching && canPass && !p.localYellow && (freeLeft || freeRight)) {
        this.setState('OVERTAKE');
        if (this.overtakeTargetIndex !== ahead.index) {
          this.overtakeTargetIndex = ahead.index;
          // Pick the side with more room, biased away from the car ahead.
          const theirSide = Math.sign(ahead.lateral || lineOffset || 1);
          const roomIfLeft = halfWidth - Math.max(0, ahead.lateral);
          const roomIfRight = halfWidth + Math.min(0, ahead.lateral);
          this.overtakeSide = roomIfLeft > roomIfRight ? 1 : -1;
          // Never pick the side they are already hugging.
          if (this.overtakeSide === theirSide && Math.abs(ahead.lateral) > halfWidth * 0.3) {
            this.overtakeSide = -theirSide;
          }
        }
        // ...and never the side somebody else is already using. Choosing by
        // available tarmac alone put two cars into the same piece of road on
        // lap one at every circuit with a wide run to turn one.
        if (this.overtakeSide > 0 && !freeLeft) this.overtakeSide = -1;
        else if (this.overtakeSide < 0 && !freeRight) this.overtakeSide = 1;

        // Offset far enough to be clearly alongside, not just nudging.
        const offset = this.overtakeSide * Math.min(halfWidth * 0.68, Math.abs(lineOffset) + 3.4);
        this.targetLateral = clamp(offset, -halfWidth * 0.85, halfWidth * 0.85);
        return;
      }

      // --- FOLLOW. Stuck behind with no opportunity: hold a sensible gap and
      // keep the tires alive rather than burning them in dirty air.
      if (ahead.gapS < prof.followDistanceS * 2.2) {
        this.setState('FOLLOW');
        this.overtakeTargetIndex = -1;
        // Sit slightly offset for cleaner air and a better run onto the
        // straight — but only where there is room to do it. Stepping a metre
        // off the line in the middle of a corner spends grip the corner needs,
        // and in a pack it is how cars end up in the gravel on lap one.
        const side = Math.sign(lineOffset || 1);
        this.targetLateral = inPassingZone
          ? clamp(lineOffset - side * 1.1, -halfWidth * 0.8, halfWidth * 0.8)
          : lineOffset;
        return;
      }
    }

    // --- Default: the racing line.
    this.setState('LINE_FOLLOWER');
    this.overtakeTargetIndex = -1;
    this.targetLateral = lineOffset;
  }


  /**
   * Limits how fast the steering may change. Full lock takes ~0.22s at rest.
   *
   * The rate is a ROAD-WHEEL angular rate converted to input units, not a rate
   * on the input itself. Those are the same thing only at a standstill, and
   * capping the input rate meant the AI's real steering rate was whatever
   * fraction of lock the rack happened to allow — so every past attempt to gear
   * the rack for the front tire also silently halved how fast the AI could turn
   * the wheel, made the cars run wide everywhere, and was reverted as a failure.
   *
   * `schedule` carries the same speed taper the rest of the feedback path uses,
   * because this limit was measured with it in the loop. The point is not to
   * change the AI's behaviour — it is to make that behaviour independent of the
   * rack ratio, which is a separate design choice.
   */
  private slewSteer(target: number, dt: number, radPerInput = 0.42, schedule = 1): number {
    // 1.9 rad/s at the road wheel — centre to full lock in a little over 0.2s,
    // which is about as fast as hands actually move.
    const RATE_RAD_PER_S = 1.9 * schedule;
    // Clamped so the very small rack ratios at top speed cannot turn this into
    // an instantaneous input step the tires could never follow.
    const maxDelta = Math.min(RATE_RAD_PER_S / Math.max(radPerInput, 0.06), 14) * dt;
    const d = target - this.lastSteer;
    this.lastSteer += d > maxDelta ? maxDelta : d < -maxDelta ? -maxDelta : d;
    return clamp(this.lastSteer, -1, 1);
  }

  /**
   * Control while off the track or spun.
   *
   * The normal controller cannot rescue a stopped car: it aims at a point far up
   * the track, which from a standstill facing the wrong way produces a steering
   * command that does nothing. Recovery instead aims at the nearest point on the
   * racing surface, applies enough throttle to actually move on a low-grip
   * surface, and reverses when the car is pointing the wrong way.
   */
  private driveRecovery(dt: number, car: VehiclePhysics, s: number, lateral: number): void {
    const track = this.track;
    const c = this.controls;
    const speed = car.speedMs;
    c.reverse = false;

    // Aim at the racing line ahead. The look-ahead scales with speed for the same
    // reason it does in normal driving: a fixed short target at 120km/h demands a
    // steering angle the tires cannot deliver, and the car simply spins.
    const lookAhead = clamp(18 + speed * 0.55, 20, 60);
    track.racingLineAt(s + lookAhead, this.lookAheadPoint);
    const dx = this.lookAheadPoint.x - car.position.x;
    const dz = this.lookAheadPoint.y - car.position.y;
    const desired = Math.atan2(dx, dz);
    const err = wrapAngle(desired - car.heading);

    const facingBackwards = Math.abs(err) > 1.9;

    // --- Getting unstuck ---------------------------------------------------
    // A car that has stopped is the most destructive thing that can happen to a
    // race: it holds a local yellow, which keeps the safety car out, which stops
    // anybody ever completing the distance.
    //
    // This branch used to set `throttle = 0` and `brake = 0.3`, with a comment
    // saying "the only way out is to reverse" — but it never set the reverse
    // control, so the car simply sat there for the rest of the session. At
    // Monaco the lead car did exactly that on its first lap every single time,
    // which is why that circuit never recorded a lap at all.
    if (speed < 2.5) this.stallTimer += dt; else this.stallTimer = 0;
    if (this.reverseTimer <= 0 && this.stallTimer > 1.0) {
      this.reverseTimer = facingBackwards ? 2.6 : 1.4;
      this.stallTimer = 0;
    }

    if (this.reverseTimer > 0 && speed < 9) {
      this.reverseTimer -= dt;
      // Back up under power, steering to swing the nose toward the track. A
      // reversing car rotates the opposite way for a given lock, hence the sign
      // flip against the forward case below.
      c.reverse = true;
      c.throttle = 0.85;
      c.brake = 0;
      c.steer = this.slewSteer(clamp(err * 1.3, -1, 1), dt);
      c.gearRequest = 0;
      c.drsRequested = false;
      c.ersMode = 'harvest';
      c.pitLimiter = false;
      this.smoothedLateral = lateral;
      return;
    }
    this.reverseTimer = 0;

    if (speed > 14) {
      // Still carrying real speed. If the car is sideways, the first job is to
      // catch it, and you catch a slide by steering toward where the car is
      // actually travelling — not toward where you want to go. Only once the nose
      // is pointing along the velocity vector does aiming at the track make sense.
      const travelHeading = Math.atan2(car.velocity.x, car.velocity.y);
      const slideAngle = wrapAngle(travelHeading - car.heading);

      if (Math.abs(slideAngle) > 0.25) {
        c.steer = this.slewSteer(clamp(-slideAngle * 1.6, -1, 1), dt);
        c.throttle = 0;
        c.brake = clamp01((speed - 18) / 40) * car.brakeLimitFraction * 0.5;
      } else {
        // Under control: gentle correction back toward the road. An aggressive
        // gain here is what turns a small excursion into a spin.
        c.steer = this.slewSteer(clamp(-err * 0.55, -0.75, 0.75), dt);
        c.brake = clamp01((speed - 22) / 30) * car.brakeLimitFraction * 0.7;
        c.throttle = 0;
      }
    } else {
      // Slow and roughly pointing the right way: drive back onto the road.
      const offTrack = Math.abs(lateral) > track.halfWidthAt(s);
      c.steer = this.slewSteer(clamp(-err * 1.1, -1, 1), dt);
      c.brake = 0;
      const wantSpeed = offTrack ? 16 : 28;
      c.throttle = speed < wantSpeed
        ? Math.min(clamp01(0.6 - Math.abs(err) * 0.15), car.tractionLimitFraction * 1.05)
        : 0.2;
    }

    c.gearRequest = 0;
    c.drsRequested = false;
    c.ersMode = 'harvest';
    c.pitLimiter = false;
    this.smoothedLateral = lateral;
  }

  /**
   * Linearly interpolated sample of a per-node track array.
   *
   * The track is stored every three metres and `indexAt` floors, so reading
   * `lineOffset[indexAt(s)]` gives a staircase. For rendering that is
   * invisible; for a control loop it is not. In a 13m-radius hairpin the
   * centreline heading changes 0.23 radians between adjacent nodes, so the
   * cross-track error the controller measures is a sawtooth riding on top of
   * the real signal — and the controller faithfully steers against it.
   * Interpolating costs two array reads and removes the whole effect.
   */
  private sample(arr: Float32Array, s: number): number {
    const { length, count } = this.track;
    let u = s / length;
    u -= Math.floor(u);
    u *= count;
    const i0 = Math.floor(u);
    const f = u - i0;
    const i1 = i0 + 1 >= count ? 0 : i0 + 1;
    return arr[i0] * (1 - f) + arr[i1] * f;
  }

  /**
   * The line to drive at `s`, blended between the dry line and the wet one.
   *
   * EVERY read of the racing line in this controller goes through here or
   * through `lineCurvAt`, and that is deliberate. The steering is a curvature
   * feedforward plus a cross-track error against a target, and if those two
   * were blended by different amounts — or one blended and one not — the car
   * would feed forward for a corner it is not taking. That failure is silent
   * and looks exactly like a badly tuned controller.
   *
   * On a dry track `lineAvoidance` is zero and both of these are byte-for-byte
   * the old behaviour: `lineOffsetAt` returns early.
   */
  private lineAt(s: number): number {
    const a = this.lineAvoidance;
    if (a <= 0) return this.sample(this.track.lineOffset, s);
    return this.sample(this.track.lineOffset, s)
      + (this.sample(this.track.wetLineOffset, s) - this.sample(this.track.lineOffset, s)) * a;
  }

  /** The curvature of that same line. Blended with the same weight. */
  private lineCurvAt(s: number): number {
    const a = this.lineAvoidance;
    if (a <= 0) return this.sample(this.track.lineCurvature, s);
    return this.sample(this.track.lineCurvature, s)
      + (this.sample(this.track.wetLineCurvature, s) - this.sample(this.track.lineCurvature, s)) * a;
  }

  /** Node-indexed form, for the decision layer which works in nodes. */
  private lineAtNode(i: number): number {
    return this.track.lineOffsetAt(i, this.lineAvoidance);
  }

  /**
   * A lateral target, clamped to the road that is actually free.
   *
   * The clamp is one-sided per side and measured from where the car IS, not from
   * where the line is, which is what makes it behave like a driver rather than
   * like a rule. A car with four metres of room to its left may move up to four
   * metres left and no further, so a move across the circuit proceeds as far as
   * it can, stops at the other car, and continues the moment the space opens.
   * The alternative — refusing the move outright while anything is there — is
   * how an AI ends up parked on the wrong line for half a lap.
   *
   * Negative room means the cars are already inside racing room of each other,
   * in which case the clamp pushes the target AWAY. That is the "do not
   * converge" half of the obligation: two cars side by side through a corner may
   * touch and that is racing, but neither of them may be the one steering into
   * the other.
   */
  private roomLimited(
    want: number, lateral: number, p: AIPerception, inLane: boolean,
  ): number {
    // Not in the pit lane. Down there the driver does not choose a line at all:
    // the lane is single file between a wall and the garages, and `updatePitLane`
    // owns the car's lateral placement outright — it drags the car onto the lane
    // offset, or across to the working lane and its box, at a rate of its own.
    // An AI steering for a room-limited target while the engine drags it
    // somewhere else is two hands on the same wheel, and the car loses. Measured
    // at Austin, where the boxes sit off the fast lane so a serviced car really
    // is three metres to one side of the queue: the cars behind steered away
    // from it, fought the drag, burned their grip budget sideways, and a third
    // of the field spent the race stationary in the pit lane. Twenty-four
    // car-laps of a hundred simply never happened.
    if (inLane) return want;
    const left = p.roomLeftM - RACING_ROOM_M;
    const right = p.roomRightM - RACING_ROOM_M;
    if (left === Infinity && right === Infinity) return want;
    const capLeft = lateral + left;
    const capRight = lateral - right;
    // Squeezed from both sides — a three-wide moment. There is no legal target,
    // so split the difference and stay where the least contact is.
    if (capRight > capLeft) return (capRight + capLeft) * 0.5;
    return clamp(want, capRight, capLeft);
  }

  /** Largest curvature within `distance` metres ahead. Signs the corner. */
  private upcomingCurvature(s: number, distance: number): number {
    const track = this.track;
    const step = 12;
    let peak = 0;
    for (let d = 20; d <= distance; d += step) {
      const k = track.lineCurvature[track.indexAt(s + d)];
      if (Math.abs(k) > Math.abs(peak)) peak = k;
    }
    return peak;
  }

  // =========================================================================
  // Control
  // =========================================================================

  private driveTowardTarget(
    dt: number,
    car: VehiclePhysics,
    s: number,
    lateral: number,
    p: AIPerception,
  ): void {
    if (this.state === 'RECOVER') {
      this.driveRecovery(dt, car, s, lateral);
      return;
    }
    const track = this.track;
    const prof = this.profile;
    const c = this.controls;
    const spec = car.spec;
    const speed = Math.max(car.speedMs, 0.5);
    c.reverse = false;

    // In the pit lane, and here on the driver's own terms rather than the
    // engine's: the state machine is what decides whether this car is using the
    // lane, and a car that merely happens to be passing the pits at racing speed
    // is not in it.
    const inLane = (this.state === 'PIT_APPROACH' || this.state === 'PIT_EXIT') &&
      this.isInPitLane(s);

    // What the brakes can do, right now. Computed here rather than down in the
    // braking section because the traffic rules below are expressed in the same
    // currency — a car's safe following speed is a fact about its brakes — and
    // the braking section reads them a second time unchanged.
    const mass = car.totalMassKg;
    const tireGrip = Math.min(car.frontTires.grip, car.rearTires.grip);
    const dragForceN = spec.cdBase * speed * speed;
    const gripLimitN =
      spec.baseMu * tireGrip *
      (mass * 9.81 + spec.clBase * car.dirtyAirDownforceMult * speed * speed);
    // Not the whole circle: a braking zone is never perfectly straight and the
    // pedal is modulated rather than stamped.
    const brakeForceAvailN = Math.min(spec.maxBrakeForceN, gripLimitN * BRAKING_GRIP_SHARE);
    const decelAvail = (brakeForceAvailN + dragForceN) / mass;

    // Move toward the target offset at a rate the car can actually achieve.
    // Snapping the target would produce a steering step change the tires cannot
    // follow, and the car would simply slide.
    //
    // The target is filtered through the road that is actually free first. A
    // driver moving across the circuit looks before they go; this controller
    // used to move to wherever the state machine wanted regardless of what was
    // there, which is the whole of the race-start complaint — a car on the right
    // of the grid heading for a racing line on the left drove through anything
    // in between, because nothing in the path from `targetLateral` to the
    // steering command ever mentioned another car.
    // AVOID moves at the committed rate for the same reason OVERTAKE does: the
    // move has to be finished before the car gets there, and there is less road
    // to do it in than a pass has.
    const lateralRate =
      this.state === 'OVERTAKE' || this.state === 'DEFEND' || this.state === 'AVOID' ? 3.2 : 2.0;
    this.smoothedLateral =
      damp(this.smoothedLateral,
        this.roomLimited(this.targetLateral, lateral, p, inLane), lateralRate, dt);

    // --- Steering ----------------------------------------------------------
    // Feedforward plus cross-track correction, NOT pure pursuit.
    //
    // Pure pursuit aims the car at a point some distance ahead on the path, which
    // means it drives the CHORD rather than the arc. Through a long corner that
    // is a systematically tighter path than the racing line, demanding more grip
    // than the speed profile allocated — so the car understeers and runs wide at
    // the exit of every fast corner. It did exactly that at Curva Grande.
    //
    // Instead: take the steady-state steering angle the corner's curvature
    // requires (the feedforward, which drives the arc correctly), then add a
    // correction for how far off the target line the car actually is.
    // Feedforward: the bicycle-model steer angle the path's curvature requires.
    // Sampled slightly ahead to compensate for steering and tire lag — enough
    // lead to be timely, not so much that it turns in early.
    const lead = clamp(speed * 0.28, 5, 22);
    // Averaged over a short window so a single noisy node cannot spike it.
    const ffCurvature = (
      this.lineCurvAt(s + lead - 3) +
      this.lineCurvAt(s + lead) +
      this.lineCurvAt(s + lead + 3)
    ) / 3;
    // Curvature is positive for a left turn, steering positive for a right turn.
    const ffRad = -Math.atan(car.spec.wheelbaseM * ffCurvature);

    // Cross-track error measured against where the line is HERE, not where it
    // will be at the look-ahead point.
    //
    // Comparing the car's current position against the line's offset 40m up the
    // road is a lead/lag error: the car chases a target that has already moved
    // toward the apex, so it turns in early and sits permanently inside the line.
    // Through Lesmo it ran 2.5m inside and off the inner edge on every lap.
    // LINE_FOLLOWER steers at the solved line directly rather than at the
    // smoothed target, so the room limit has to be applied here too or the one
    // state the field spends most of its time in would ignore it entirely.
    const lineHere = this.state === 'LINE_FOLLOWER'
      ? this.roomLimited(this.lineAt(s), lateral, p, inLane)
      : this.smoothedLateral;
    const latError = lineHere - lateral;

    // The racing line's own heading relative to the centreline tangent. Without
    // this the controller has to generate the whole of a corner's turn-in as
    // "error", which means it is always behind the line rather than on it.
    const H = 12;
    const dOffsetDs =
      (this.lineAt(s + H) - this.lineAt(s - H)) / (2 * H);
    const lineHeadingOffset = Math.atan(dOffsetDs);

    // Distance over which to close the remaining lateral error. Shorter in tight
    // corners, where the line moves quickly and a long horizon is too coarse.
    const tightness = clamp01(Math.abs(ffCurvature) * 190);
    const closeOver = clamp(10 + speed * 0.42, 12, 46) * (1 - 0.4 * tightness);

    // Lead compensation on the cross-track error.
    //
    // Without it the controller is pure proportional: it keeps demanding heading
    // until the error reaches zero, by which point the car is crossing the line
    // at several metres a second and sails straight past. Every corner-entry
    // failure was this overshoot — the car set up on the outside and kept going
    // over the white line.
    //
    // Subtracting the rate at which the error is ALREADY closing makes the
    // controller ease off as it arrives, which is what a driver's hands do.
    const nIdx = track.indexAt(s);
    const latRate = car.velocity.x * track.nx[nIdx] + car.velocity.y * track.nz[nIdx];
    const LEAD_S = 0.42;
    const effectiveError = latError - latRate * LEAD_S;

    const aimHeading =
      track.headingAt(s) + lineHeadingOffset + Math.atan2(effectiveError, Math.max(closeOver, 10));
    const headingError = wrapAngle(aimHeading - car.heading);

    // --- From here the controller works in ROAD-WHEEL RADIANS ---------------
    //
    // It used to work in steering-input units and convert with `/ maxSteerRad`,
    // which is only correct at a standstill: the rack is speed-sensitive, so an
    // input of 1.0 is 24 degrees of lock parked and 11 at 260km/h. Two separate
    // things went wrong as a result, and they pull in opposite directions.
    //
    // The FEEDFORWARD was simply under-delivered. It is a geometric angle the
    // corner requires, and it arrived at the tires attenuated by the rack curve
    // — 46% of it at 260km/h — on exactly the fast corners where it is the whole
    // of the demand. The AI understeered through every quick corner and made the
    // shortfall up with the error term a beat late. Delivering it properly is
    // worth a lot: Silverstone went from 192% of reference lap time to 158%.
    //
    // The FEEDBACK gains are the opposite case. They were tuned by measurement
    // with the same attenuation in the loop, so the rack curve was acting as an
    // unintended gain schedule — loop gain falling from 1.3 at low speed to 0.6
    // at 260km/h. That schedule is good control design, and simply removing it
    // doubled the loop gain at racing speed: the cars weaved, overshot, and the
    // spread between fastest and slowest blew out on eight circuits.
    //
    // So the schedule is kept, explicitly, as what it always was — a gain
    // schedule on the feedback path — instead of being an accident of the rack
    // ratio. The two are now independent: `RACK_TAPER_PER_MS` can be geared for
    // what the front tire wants without silently retuning this controller.
    const feedbackGain = AI_FEEDBACK_GAIN_SCHEDULE(speed);

    // Road-wheel angle per unit of steering input, at THIS speed.
    const radPerInput = car.spec.maxSteerRad * steerRackLimit(speed);

    // Negated to match the corrected steer convention: positive steer is RIGHT,
    // while increasing heading (which is what ffRad and headingError express) is
    // a turn to the LEFT in this frame.
    let steerRad = -(ffRad + headingError * 1.3 * feedbackGain);

    // Counter-steer damping: oppose yaw the driver did not ask for. This is what
    // lets the AI catch a slide instead of spinning, and it is exactly what a
    // real driver does with their hands.
    const desiredYawRate = -ffCurvature * speed;
    // Excess left-hand yaw needs right-hand correction, which is now positive.
    steerRad += (car.yawRate - desiredYawRate) * 0.05 * car.spec.maxSteerRad * feedbackGain;

    // --- Edge guardrail ----------------------------------------------------
    // An inward bias that grows sharply as the car approaches the track edge,
    // added on top of the line-following demand.
    //
    // Line following is a compromise between where the car is and where the line
    // is, and a compromise can still end up off the road. A driver does not treat
    // it as a compromise: past a certain point they abandon the ideal line and
    // simply keep the car on the asphalt, taking the lost time. Without this term
    // the controller tracked well on average and still put a wheel over the white
    // line at one specific corner on most circuits.
    const halfWidthNow = track.halfWidthAt(s);
    const edgeUse = Math.abs(lateral) / Math.max(halfWidthNow, 1);
    if (edgeUse > 0.68) {
      const urgency = clamp01((edgeUse - 0.68) / 0.28);
      // Lateral is positive to the driver's LEFT, so drifting positive means
      // coming back requires right-hand steer, which is positive.
      steerRad += Math.sign(lateral) * urgency * urgency * 0.85 * car.spec.maxSteerRad * feedbackGain;
    }

    // Human imperfection. A slow sine plus per-driver noise, so cars wander a
    // few centimetres and occasionally make a real mistake — without it, twenty
    // AI cars run identical lines forever and the racing looks robotic.
    this.errorPhase += dt * 1.7;
    const wander = Math.sin(this.errorPhase) * 0.35 + Math.sin(this.errorPhase * 2.3) * 0.2;
    // Scaled down with speed: as a raw steering offset the same number is a few
    // centimetres of wander at 80km/h and a 20 m/s^2 lateral jolt at 330km/h,
    // which is why the quick circuits always looked worse than the slow ones.
    steerRad += wander * prof.errorScale * clamp(24 / speed, 0.12, 1) * car.spec.maxSteerRad * feedbackGain;

    // Back to input units — the one place the rack ratio enters.
    const steer = steerRad / radPerInput;

    // Rate-limit the steering. Real hands take about a quarter second to go from
    // centre to full lock, and without that limit the pure-pursuit controller
    // slams between the stops as soon as the car is off-line — which is what sent
    // it spiralling into the gravel.
    c.steer = this.slewSteer(clamp(steer, -1, 1), dt, radPerInput, feedbackGain);

    // --- Target speed ------------------------------------------------------
    // Slow form drift, so a driver has better and worse laps.
    this.formNoise = damp(this.formNoise, this.rng.gaussian(0, 0.006), 0.35, dt);

    // One function computes the speed this driver will attempt at any point on
    // the track, and BOTH the current target and the braking scan below go
    // through it.
    //
    // Keeping them consistent is essential. When the scan targeted the raw
    // reference profile while the car actually tried to hold a margin-reduced
    // speed, the AI braked for a speed ~19% higher than it then attempted, so it
    // arrived at every corner too fast, tried to shed the difference mid-corner
    // while already using its grip to turn, exceeded the friction circle, and
    // spun. Every tight corner on the lap ended in the gravel.
    let targetSpeed = this.speedTargetAt(car, s, p);

    // Off-line and near the edge: the road remaining is not the road the profile
    // assumed, so back off rather than arriving at the barrier at the limit.
    // The threshold has to sit OUTSIDE the racing line itself. The solved line
    // runs at (halfWidth - 1.95) metres from the centre at an apex, which on
    // every circuit in the calendar is between 0.70 and 0.74 of the half-width
    // — so this fired at every single apex and cut the corner speed by up to a
    // quarter for a car that was exactly where it was supposed to be. That one
    // off-by-a-little threshold was most of the AI's missing pace.
    const halfW = track.halfWidthAt(s);
    if (Math.abs(lateral) > halfW * 0.88) {
      targetSpeed *= lerp(1, 0.85, clamp01((Math.abs(lateral) / halfW - 0.88) / 0.16));
    }

    // --- Fuel ---------------------------------------------------------------
    // Lift and coast. A pace scale rather than a throttle cap, because the
    // saving comes from arriving at the braking point slower and not from
    // feathering the pedal on the straight, and because a pace scale composes
    // with every bound below it — a car saving fuel behind a safety car is
    // already under the neutralised limit and this changes nothing.
    //
    // It is 1 for almost every car in almost every race. When it is not, the
    // alternative is not a slow car, it is a stopped one: see `FuelPlan.ts`.
    targetSpeed *= p.fuelPaceScale;

    // --- Yellow flags ------------------------------------------------------
    // Two different instructions, so two different lifts.
    //
    // Single waved yellow: "must reduce their speed and be prepared to change
    // direction ... expected to have braked earlier and/or discernibly reduced
    // speed in the relevant marshalling sector" (2025 Art. 26.1a / 2026 Art.
    // B1.8.4a). Double waved yellow: "reduce your speed significantly ... and
    // be prepared to change direction or stop" (Art. 26.1b / B1.8.4b; ISC
    // Appendix H Art. 2.5.5b) — the hazard is blocking the track, or there are
    // marshals standing on it.
    //
    // The two factors below are a MODELLING CHOICE, not a regulation. The FIA
    // publishes no numeric lift for either flag; the standard is qualitative
    // and judged by the stewards. What the regulations do fix is the ORDERING —
    // a double yellow must be a bigger lift than a single, and both must be
    // discernible — and that is what these encode. A car that is already slow
    // for a corner is not asked to slow further.
    if (!p.neutralised && p.yellowLevel > 0) {
      targetSpeed *= p.yellowLevel === 2 ? YELLOW_LIFT_DOUBLE : YELLOW_LIFT_SINGLE;
    }

    // Neutralised: obey the delta.
    //
    // Note that the regulation's obligation is to stay above the minimum time
    // "at least once in each marshalling sector" (Art. 55.7 and 56.5 /
    // B5.13.2b and B5.12.2b) rather than to hold a speed continuously — race
    // control times the sectors and penalises the ones done too quickly. The AI
    // satisfies that by simply running at the delta pace, which is what a real
    // driver does because it is the easy way to stay legal.
    if (p.neutralised && p.neutralisedTargetMs > 0) {
      // The cap and the scale come from `NeutralisedLimiter`, which is the same
      // function `RaceEngine` runs for the PLAYER. That sharing is the point:
      // "under safetycar and flags and everything every car has to follow the
      // speedlimit" is one rule, and nineteen cars obeying a rule the twentieth
      // is not held to is not that rule.
      //
      // The limit is applied as a CAP and a SCALE, never as a target the car is
      // asked to reach. Raising the target directly looks equivalent and is
      // catastrophic: it overrides the cornering limit computed from the car's
      // own grip, so a car told to close a ten-car-length gap tried to take
      // Monaco's hairpin at safety car pace and went straight on. Monaco's
      // off-track count doubled and the field spread went from 89 seconds to
      // 268 the moment this was a max() instead of a min().
      //
      // The gap that decides whether this car is catching up is the gap to
      // whatever is in front of it IN THE QUEUE, which for the leader is the
      // safety car itself. Reading only `ahead` left the leader with no reason
      // to close on a car it could not see: it cruised at the queue pace while
      // the safety car ran away from it, and the whole train behind stayed
      // strung out because the front of it never arrived.
      const limit = neutralisedLimit(
        p.neutralisedTargetMs,
        p.neutralisedScale,
        p.neutralisedCatchUpMult,
        p.queueGapM,
        p.queueAheadM,
        p.mustUnlap,
        UNLAP_PACE_MULT,
      );
      targetSpeed = applyNeutralisedLimit(targetSpeed, limit);

      // STATION-KEEPING, from the same shared rule the player's assist uses.
      // Measured at a wet Monza before it existed, the leader's gap to the
      // safety car swung between 48 and 630 metres for two full safety car
      // laps: everybody was obeying a pace and nobody was driving to a queue.
      //
      // The floor for "the thing in front has stopped racing" has to scale with
      // the neutralised pace: a queue genuinely does crawl through a chicane,
      // and the racing-speed threshold would switch station-keeping off exactly
      // where it is needed most.
      targetSpeed = Math.min(targetSpeed, queueHoldMs(
        p.queueAheadM, p.queueAheadSpeedMs, p.queueGapM,
        Math.min(NO_PASS_MIN_AHEAD_MS, p.neutralisedTargetMs * 0.25),
      ));

      // And nobody drives past the safety car. The overtaking ban runs from the
      // moment it is deployed (Art. 55.8 / B5.13.2c) and it is not limited to
      // the other F1 cars — the queue forms up BEHIND the safety car, which is
      // the whole of Art. 55.7 / B5.13.2b.
      if (p.safetyCarAheadM >= 0 && p.safetyCarAheadM < SC_HOLD_M) {
        const t = clamp01(p.safetyCarAheadM / SC_HOLD_M);
        targetSpeed = Math.min(targetSpeed, p.safetyCarSpeedMs * lerp(0.2, 1, t));
      }
    }

    // NOBODY PASSES.
    //
    // "no driver may overtake another F1 Car on the track" from the moment the
    // safety car is deployed until they pass the Line after it has come in
    // (Art. 55.8 / B5.13.2c), identically under the VSC (Art. 56.5 / B5.12.2b),
    // and under a waved yellow (ISC Appendix H Art. 2.5.5b). `localYellow` is
    // exactly that set of conditions.
    //
    // The state machine already refuses to enter OVERTAKE under any of them,
    // and that turned out to be worth very little: measured over a staged
    // deployment, 140 passes were completed under the VSC and 55 under the
    // safety car, because a car that is simply quicker than the one in front
    // does not need an overtaking STATE to drive past it. What stops it is not
    // being allowed to close the last few metres.
    //
    // The taper reaches 1 at the hold distance, which is what stops it
    // compounding down the queue — a car sitting at the hold distance targets
    // exactly the speed of the car in front, not a fraction of it. An earlier
    // version targeted 92% of the car ahead unconditionally; over nineteen cars
    // that is a factor of five, and the back of the train crawled at 65 km/h.
    if (p.localYellow && !p.mustUnlap && p.ahead !== null &&
        p.ahead.gapM < NO_PASS_HOLD_M &&
        // You do not queue behind a car that has stopped racing. A driver going
        // round a spun or crawling car is not overtaking it in any sense a
        // steward recognises, and refusing to would park the entire field
        // behind the incident the flag is there to warn about.
        p.ahead.speedMs > NO_PASS_MIN_AHEAD_MS) {
      const t = clamp01(p.ahead.gapM / NO_PASS_HOLD_M);
      targetSpeed = Math.min(targetSpeed, p.ahead.speedMs * lerp(0.55, 1, t));
    }

    // Pit lane speed limit, and the stop in the box.
    if (this.state === 'PIT_APPROACH' || this.state === 'PIT_EXIT') {
      const pit = track.def.pitLane;
      const inLane = this.isInPitLane(s);
      const limitMs = pitLimiterSetpointMs(pit);

      // Arm the limiter just BEFORE the line, not on it. The button is pressed
      // on the approach in a real car, and engaging it on the same step the car
      // crosses the line loses the race between "am I in the pit lane" and "was
      // I speeding when I got here" — which race control judges on that step.
      const toEntryNow = loopDelta(s, pit.entryS, track.length);
      c.pitLimiter = inLane ||
        (this.state === 'PIT_APPROACH' && toEntryNow >= 0 && toEntryNow < PIT_LIMITER_ARM_M);

      if (inLane) {
        targetSpeed = Math.min(targetSpeed, limitMs);
      } else if (this.state === 'PIT_APPROACH') {
        // Brake for the pit entry so the car crosses the line AT the limit.
        //
        // Without this the AI carried racing speed all the way to the entry and
        // arrived in the pit lane at 270 km/h, because the limiter only comes on
        // once the car is already inside. Every stop therefore began with a
        // drive-through penalty for pit lane speeding, and the car was still
        // doing three times the limit when it reached its box.
        if (toEntryNow >= 0 && toEntryNow < PIT_ENTRY_SCAN_M) {
          const vAtLine = limitMs * PIT_ENTRY_TARGET_SHARE;
          const d = Math.max(toEntryNow - PIT_ENTRY_SETTLE_M, 0);
          targetSpeed = Math.min(
            targetSpeed,
            Math.sqrt(vAtLine * vAtLine + 2 * PIT_ENTRY_DECEL_MS2 * d),
          );
        }
      }

      // Slow to a standstill on the box. A square-root profile is simply the
      // constant-deceleration solution v = sqrt(2 a d), so the car sheds speed
      // smoothly down the lane and arrives at zero on the mark rather than
      // stamping on the brakes at the last metre.
      if (p.pitBoxAheadM >= 0) {
        targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * PIT_BOX_DECEL_MS2 * p.pitBoxAheadM));
      }
    } else {
      c.pitLimiter = false;
    }

    // Following: hold a comfortable gap rather than sitting in dirty air. This
    // is the driver's PREFERENCE — how close they like to run — and it is a
    // per-driver number in seconds because that is how a driver thinks about it.
    //
    // Note that `ahead` can no longer be a car that has STOPPED: this bound is
    // `ahead.speedMs` times a shade under one, so a stationary car in front
    // makes it a target speed of zero — a comfort preference expressed as a
    // hard stop, which no amount of steering round the obstacle escapes because
    // it never asks where either car is across the road. That exclusion is made
    // once, in `RaceEngine.buildPerception`, along with the two other rules that
    // had the same failure. The floor underneath (`hazard`, below) is the bound
    // that actually keeps this car out of the back of that one, it is
    // corridor-filtered, and it is not going anywhere.
    if (p.ahead !== null && this.state !== 'OVERTAKE') {
      const desiredGapM = Math.max(6, prof.followDistanceS * speed);
      if (p.ahead.gapM < desiredGapM) {
        const deficit = 1 - clamp01(p.ahead.gapM / Math.max(desiredGapM, 1));
        targetSpeed = Math.min(targetSpeed, p.ahead.speedMs * (1 - deficit * 0.22));
      }
    }

    // --- The floor underneath all of that -----------------------------------
    //
    // A preference is not a guarantee, and the gap above is only a preference:
    // it is a fraction of a second of travel, it is scaled by how brave the
    // driver is, and — the part that made it useless — it says nothing about
    // whether the gap can still be SHED. At 80 m/s a 0.6s preference is 48
    // metres and the car needs 107 to stop. The preference was satisfied the
    // whole way into the accident.
    //
    // So underneath it sits a hard bound with no opinion in it: the fastest this
    // car can be going and still wash the difference off before it reaches the
    // one in front. It applies in EVERY state including OVERTAKE, because a
    // driver committed to a pass is still responsible for not driving into the
    // car being passed, and it applies to the corridor-filtered `hazard` rather
    // than to `ahead`, so a car already alongside and clear of us is not
    // something we brake for.
    //
    // In clean air the bound is hundreds of metres per second and binds nothing.
    // That is the design: this is not a caution term, it is a floor.
    const hz = p.hazard;
    /*
     * A THING THAT WAS TRIED HERE AND MEASURED WORSE. Recorded so it is not
     * retried blind, because the reasoning for it is good and it is wrong.
     *
     * Both bounds below solve `v² = v_lead² + 2 a d`, and both are handed the
     * lead car's speed RIGHT NOW — which asserts it will still be doing it when
     * we arrive. Into a braking zone that is the one moment the assertion is
     * most wrong: the car ahead is about to shed two hundred km/h for a corner
     * it is already turning into. The obvious correction is to plan against
     * `min(hz.speedMs, speedTargetAt(car, s + hz.gapM, p))` — what a driver
     * means by "he has to brake for the same corner I do".
     *
     * Measured at Spa, three seeds, quarter distance, F3, before and after:
     *
     *   off-track excursions   12.7 -> 6.3 a race     better, and consistently
     *   car-to-car contacts    20.0 -> 28.0 a race    WORSE, 2 of 3 seeds
     *   retirements             3.00 -> 3.67 a race   worse
     *
     * And `validate:race` at Monaco, which is where it showed up worst — the
     * tightest circuit on the calendar, so the most to bunch:
     *
     *   finishers of 20         15 -> 0     with the change, nobody finished
     *   retirements              5 -> 8
     *   position swaps         277 -> 485   a field shuffling, not racing
     *
     * Pace itself was never the cost: Bahrain's fastest race lap is 1:56.917
     * either way, identical to the digit. It is not a caution tax, it is a
     * concertina — a field that brakes earlier for the car in front arrives at
     * the corner bunched harder and touches more once it is there. Excursions
     * are an intermediate quantity; finishers, retirements and contacts are what
     * the player sees, and all three moved the wrong way.
     *
     * (Overtakes at Bahrain read 181 without and 197 with. Do not read that as
     * the change buying overtaking — at Monaco the same counter went to 485 for
     * a race no one finished, which is what a bunched field does to a
     * position-swap count.)
     *
     * The braking-zone error above is real and still unfixed. Whatever fixes it
     * has to not bunch the field to do it.
     */
    if (hz !== null) {
      const standoff = inLane ? PIT_STANDOFF_M : TRAFFIC_STANDOFF_M;
      // The pit lane gets a measured deceleration rather than the computed one.
      // Down there the tyres have been cooling since the entry and the friction
      // circle scales the pedal to about a tenth of a braking zone's, so the
      // grip model's own answer is an order of magnitude too optimistic and the
      // car plans a stop it cannot make. See `PIT_BOX_DECEL_MS2`.
      const decel = inLane ? PIT_DECEL_MS2 : decelAvail;
      // Planned at slightly less than everything the car has, so the demand
      // shows up as a lift before it has to show up as a stamp on the pedal.
      targetSpeed = Math.min(
        targetSpeed, safeFollowSpeedMs(hz.gapM, hz.speedMs, decel * 0.72, standoff),
      );

      // --- ...except that a car which has come to a complete stop cannot
      // steer, and going round something requires steering.
      //
      // THE DEADLOCK THIS BREAKS, measured at Monza in the `[held]` mode of
      // `probe:blockage`. The bound above is `sqrt(v_lead² + 2 a d)` against a
      // lead speed of zero, and inside the standoff it tapers to zero at
      // contact — so a car that arrives behind a stopped one settles about seven
      // metres back at zero. At zero there is no lateral force to be had at any
      // steering angle, so it cannot move across the road; being unable to move
      // across the road it stays in the hazard corridor; being in the corridor
      // the bound stays at zero. Sixteen of twenty cars queued up in that state
      // and were retired for stopping on track, having each been told to go
      // round something they were pointed straight at.
      //
      // A driver in that position picks their way past at walking pace, and so
      // does this. It is a FLOOR under a bound and not a target: it only ever
      // raises a demand the obstacle itself has pushed to nothing, only while
      // this car is committed to going round, and only while the side it has
      // chosen is actually free — if somebody is there, there is nothing to
      // creep into and the car waits like anyone else.
      const goingRound = this.state === 'AVOID' && p.blockage !== null &&
        hz.index === p.blockage.index;
      const sideFree = this.avoidSide > 0
        ? p.roomLeftM > RACING_ROOM_M + 1.0 : p.roomRightM > RACING_ROOM_M + 1.0;
      if (goingRound && sideFree && hz.gapM > CONTACT_GAP_M) {
        targetSpeed = Math.max(targetSpeed, BLOCKAGE_CRAWL_MS);
      }
    }

    // --- Braking -----------------------------------------------------------
    // The AI brakes from a REQUIRED-DECELERATION model rather than from a
    // threshold on a scalar "urgency". For every point in the scan window, the
    // deceleration needed to arrive there at that point's target speed is
    //
    //     a_req = (v^2 - v_target^2) / (2 * d)
    //
    // and the pedal is the brake force that satisfies the largest such demand
    // once drag has been credited against it. That is a continuous control law
    // with no threshold and no ramp band to tune: far from a corner the demand
    // is smaller than drag alone and the pedal stays shut, and approaching the
    // braking point it rises smoothly through partial pedal to full. It is also
    // self-correcting, because if the car is late a_req keeps rising.
    //
    // The old formulation stacked three separate safety margins — a 0.72 share
    // of the grip circle, a 1/confidence threshold, and a further 0.86 factor —
    // which compounded to braking roughly 55% earlier than necessary. That was
    // the single largest component of the AI's missing lap time.
    // `mass`, `dragForceN` and `decelAvail` were computed at the top of this
    // method, because the traffic rules above are the same arithmetic.

    // Scan far enough to cover the car's whole stopping distance. Deriving the
    // window from the current corner gives zero on a straight, which is how the
    // AI came to look 40m ahead while needing 99m to slow for a chicane.
    const horizon = clamp((speed * speed) / (2 * Math.max(decelAvail, 4)) * 1.3 + 45, 60, 700);

    // A confident driver treats the corner as being where it actually is; a
    // cautious one behaves as though it were slightly closer.
    const reach = clamp(prof.brakingConfidence, 0.85, 1.0);

    // Already above the speed for the corner we are IN: shed it over the next
    // few metres rather than waiting for the scan to notice.
    // A small deadband matters here: without it the car chatters between
    // throttle and brake either side of the target speed, because the throttle
    // is trying to reach it and any overshoot at all reads as a braking demand.
    const holdSpeed = targetSpeed * 1.012;
    let aReq = speed > holdSpeed
      ? (speed * speed - holdSpeed * holdSpeed) / (2 * 30)
      : 0;

    // Coarser sampling further away — the resolution that matters is near the
    // braking point, and this keeps twenty cars at 120Hz affordable.
    for (let d = 10; d <= horizon; d += Math.max(7, d * 0.1)) {
      const vAhead = this.speedTargetAt(car, s + d, p);
      if (vAhead >= speed) continue;
      const a = (speed * speed - vAhead * vAhead) / (2 * d * reach);
      if (a > aReq) aReq = a;
    }

    // The car in front is a braking point like any other, and it enters the
    // model at exactly the same place a corner does.
    //
    // Feeding traffic in only as a target speed was not enough on its own: the
    // overspeed term above sheds a target-speed excess over a FIXED thirty
    // metres, which is the right horizon for a corner the car is already in and
    // far too long for something solid twelve metres away. Asking the same
    // question about the actual gap is what makes a stationary car stop this one
    // rather than merely slow it. `reach` is deliberately not applied — a
    // driver's confidence is about how late they dare brake for a corner, and
    // nobody is confident about the back of another car.
    if (hz !== null) {
      const a = requiredDecelMs2(
        speed, hz.gapM, hz.speedMs, inLane ? PIT_STANDOFF_M : TRAFFIC_STANDOFF_M,
      );
      if (a > aReq) aReq = a;
    }

    // --- Pedals ------------------------------------------------------------
    // Brake force needed once drag has done its share. Negative means coasting
    // alone is enough, so the pedal stays shut.
    const pedal = (mass * aReq - dragForceN) / spec.maxBrakeForceN;

    if (pedal > 0.02) {
      // Cap at the point the first axle locks — there is no ABS, and a locked
      // front both stops later and flat-spots the tire.
      c.brake = clamp(pedal, 0, car.brakeLimitFraction * AI_TUNING.brakeShare);
      c.throttle = 0;
    } else {
      c.brake = 0;
      // Throttle: as much as the rear axle will take, unless we are at or past
      // the target speed, or a braking zone is close enough that accelerating
      // into it would be foolish. `tractionLimitFraction` is the friction circle
      // applied to the pedal, so this feeds in gently on a corner exit by
      // itself, and the share below leaves the rear something in reserve for
      // the lateral force the corner still needs.
      const over = speed / Math.max(targetSpeed, 1) - 1;
      const want = clamp01(1 - over * 12);
      c.throttle = Math.min(want, car.tractionLimitFraction * AI_TUNING.throttleShare);
    }

    // A target speed of zero means STOP, and neither of the two laws above can
    // say so.
    //
    // `over` is a RELATIVE overspeed with a floor of 1 m/s under the divisor, so
    // at half a metre a second against a target of nought it reads as "well
    // under the target" and asks for full throttle. The brake side is no better:
    // the required deceleration to arrive at a stationary car a metre away is
    // small in absolute terms, so `pedal` comes out under its own deadband and
    // the brake stays shut.
    //
    // Between them that is how a car which had correctly worked out that it must
    // stop still crept the last two metres into the back of a parked one under
    // power and sat there resting against it — measured in the pit lane at every
    // circuit, bodywork overlapping by six centimetres, for the rest of the
    // session. The queue behind it did the same thing to it in turn.
    //
    // Only while the car is actually going FASTER than it should be. The first
    // version of this clause left that out and shut the throttle whenever the
    // target was low, which pinned every car in a pit-lane queue at nought:
    // asked for 1.6 m/s and given no throttle to reach it, each car became the
    // stationary obstacle that set the car behind it the same impossible target.
    // A whole pit lane of cars, none of them touching, none of them moving.
    if (targetSpeed < CRAWL_MS && speed > targetSpeed) {
      c.throttle = 0;
      // Proportional to how much speed there is still to lose, so a car already
      // stopped is not pinned — see the note on the pit box for why holding the
      // brake on a stationary car unconditionally is a race-ending idea.
      const shed = clamp01((speed - targetSpeed) / CRAWL_MS);
      if (shed > 0.02) c.brake = Math.max(c.brake, shed * 0.9);
    }

    // Published for measurement only — see the field's own comment.
    this.lastTargetSpeedMs = targetSpeed;

    // --- Braking for the pit entry and for the box -------------------------
    // Commanded directly rather than left to the pedal model above, because
    // that model only ever sees the speed profile of the CIRCUIT: its braking
    // scan samples `speedTargetAt`, which knows about corners and knows nothing
    // about a pit entry or a pit box. Feeding either in as a target speed alone
    // produces a very gentle roll-off spread over thirty metres — the car
    // coasts through its box at walking pace instead of stopping in it.
    //
    // The arithmetic is the whole controller: the deceleration needed to reach
    // a given speed at a given distance, as a share of what the brakes can do.
    //
    // Note what this deliberately does NOT do: hold the brake down whenever the
    // car happens to be stationary. An earlier version did, via a `speed < 0.6`
    // clause, and it deadlocked the race. A car that stopped anywhere in the
    // lane — for instance because it had arrived at the entry far too fast and
    // stood the car on its nose — satisfied the clause, held full brake for
    // ever, and sat in the pit lane holding a yellow flag and a safety car for
    // the rest of the race. The car is only pinned when it is actually ON its
    // box, and everywhere else it is free to drive away.
    if (this.state === 'PIT_APPROACH' && !this.isInPitLane(s)) {
      const pit = track.def.pitLane;
      const toEntry = loopDelta(s, pit.entryS, track.length);
      const vAtLine = pitEntryTargetMs(pit);
      const settled = Math.max(toEntry - PIT_ENTRY_SETTLE_M, 0.01);
      if (toEntry >= 0 && toEntry < PIT_ENTRY_SCAN_M && speed > vAtLine) {
        // NOT capped at the lock-up limit, unlike every other brake application
        // in this controller. That cap exists because a locked wheel stops the
        // car later than a rolling one, and it is right everywhere else — but
        // here the alternative to a flat spot is a drive-through penalty, and
        // no driver has ever chosen the tyre. Capping it held the pedal at 0.21
        // on a car that needed everything it had, and the car crossed the line
        // at 159 km/h against a limit of 80.
        const pedal = brakeFor(speed, vAtLine, settled, PIT_ENTRY_DECEL_MS2);
        if (pedal > c.brake) { c.brake = pedal; c.throttle = 0; }
      }
    }

    if (p.pitBoxAheadM >= 0) {
      if (p.pitBoxAheadM <= PIT_BOX_COMMIT_M) this.boxCommitted = true;
      if (p.pitBoxAheadM < PIT_BOX_ARRIVED_M) {
        // On the mark. Hold it still — a car that creeps forward out of its own
        // box while the crew works on it is a car the crew cannot work on.
        c.throttle = 0;
        c.brake = 1;
      } else {
        const pedal = brakeFor(speed, 0, p.pitBoxAheadM, PIT_BOX_DECEL_MS2);
        if (pedal > c.brake) { c.brake = pedal; c.throttle = 0; }
      }
    } else if (this.boxCommitted) {
      // Committed to the stop and the box has gone behind us: the driver is a
      // metre long, not back on his way. Stay on the brake — that is what a
      // driver does, and stopping just past the mark is still inside the box.
      //
      // Time-limited, because a car that came in far too hot is past any help
      // from the brake, and a car sitting stationary on the brake for ever in
      // the middle of the pit lane is a worse outcome than a missed stop.
      this.boxOvershootS += dt;
      if (this.boxOvershootS < PIT_BOX_HOLD_S) { c.throttle = 0; c.brake = 1; }
      else this.boxCommitted = false;
    }

    // Mistakes: occasionally a driver genuinely gets it wrong. Rare, brief, and
    // scaled by consistency, so the low-consistency drivers are the ones who
    // throw it away — which is what makes them feel different to race against.
    // At the old rate the least consistent driver threw in a mistake every
    // fifteen seconds, which is not a mistake, it is a disability. Once per
    // couple of laps is what "occasionally" means. The magnitude is speed-scaled
    // for the same reason the wander is.
    if (this.rng.next() < prof.errorScale * dt * 0.35) {
      c.brake = Math.min(1, c.brake + 0.2);
      const bite = 0.3 * clamp(22 / speed, 0.1, 1);
      c.steer = clamp(c.steer + this.rng.range(-bite, bite), -1, 1);
    }

    // --- DRS ---------------------------------------------------------------
    c.drsRequested = car.drsAvailable && c.brake < 0.02 && speed > 25;

    // --- ERS ---------------------------------------------------------------
    c.ersMode = this.chooseErsMode(car, s, p);

    // Blue-flag or neutralised cars lift decisively rather than defending.
    if (p.blueFlag && p.ahead === null) {
      c.throttle *= 0.62;
    }
  }


  /**
   * The speed this driver will attempt at a given point on the track.
   *
   * Used both for the speed the car holds right now and for the braking scan's
   * view of what is coming. They MUST be the same function — see the note at the
   * call site for what happens when they diverge.
   */
  private speedTargetAt(car: VehiclePhysics, sAt: number, p: AIPerception): number {
    const track = this.track;
    const prof = this.profile;

    let v = track.targetSpeed[track.indexAt(sAt)] * prof.paceFactor * (1 + this.formNoise);

    // Cap by what THIS car can actually do through the corner, computed from its
    // own live grip and downforce rather than from the reference profile.
    //
    // This replaces a stack of empirical fudge factors with the force balance the
    // physics itself solves, and it is what makes the AI self-consistent: a car
    // on worn tyres, in dirty air, on a damp track, or with a damaged wing
    // computes a lower limit and slows down accordingly, with no special cases.
    const limit = this.corneringSpeedLimit(car, sAt);
    // Drivers do not run at the exact theoretical limit — the better ones run
    // closer to it. This is where skill turns into lap time.
    // The theoretical limit assumes a perfect line, ideal load distribution and
    // no longitudinal force. A real car is never in all three states at once, so
    // running at 97% of it simply understeers off at every corner exit. Even the
    // best drivers leave several percent.
    let commitment = lerp(0.855, 0.93, clamp01((this.driver.skill - 0.75) / 0.25));
    // Narrow circuits punish the same tracking error far more than wide ones:
    // there is no run-off at Monaco and 15 metres of asphalt at Monza, so the
    // same driver commits less on the narrow one.
    const widthHere = track.width[track.indexAt(sAt)];
    commitment *= lerp(0.94, 1.0, clamp01((widthHere - 9.5) / 5));
    commitment *= this.runoffCaution;
    // A recent excursion makes a driver cautious for a while.
    if (this.shakenTimer > 0) commitment *= 0.94;
    commitment *= AI_TUNING.commitmentScale;
    // Difficulty, applied to the one number that decides how close to the limit
    // the driver runs. An easier field genuinely corners slower rather than
    // being handicapped somewhere the player cannot see.
    commitment *= this.difficulty.commitmentScale;
    v = Math.min(v, limit * commitment);

    // Wet track: slower everywhere, and the better wet drivers lose less.
    if (p.wetness > 0.02) {
      v *= lerp(1, lerp(0.74, 0.84, this.driver.wetSkill), clamp01(p.wetness));
    }

    // Dirty air costs cornering speed. The physics already removed the
    // downforce; this stops the AI trying to carry speed it no longer has.
    if (car.dirtyAirDownforceMult < 0.98) {
      v *= lerp(1, 0.955, clamp01((1 - car.dirtyAirDownforceMult) / 0.4));
    }

    return v;
  }


  private corneringSpeedLimit(car: VehiclePhysics, sAt: number): number {
    return corneringSpeedLimitMs(this.track, car, sAt);
  }



  /**
   * ERS strategy. Deploy where it pays (out of slow corners, on straights, when
   * attacking) and harvest where it does not.
   */
  private chooseErsMode(car: VehiclePhysics, s: number, p: AIPerception): ErsMode {
    if (p.neutralised || this.controls.pitLimiter) return 'harvest';
    if (car.ersChargePercent < 0.12) return 'harvest';

    const attacking = this.state === 'OVERTAKE';
    const defending = this.state === 'DEFEND';
    if (attacking) return 'overtake';
    if (defending) return car.ersChargePercent > 0.4 ? 'push' : 'balanced';

    // Deploy on the exit of a corner onto a straight, which is where energy
    // converts most efficiently into lap time.
    const kNow = Math.abs(this.track.lineCurvature[this.track.indexAt(s)]);
    const kAhead = Math.abs(this.track.lineCurvature[this.track.indexAt(s + 120)]);
    const openingOut = kNow > 1 / 500 && kAhead < 1 / 900;
    if (openingOut && car.ersChargePercent > 0.3) return 'push';

    if (car.ersChargePercent > 0.8) return 'push';
    return 'balanced';
  }

  /** True when `s` lies inside the pit lane's distance range. */
  private isInPitLane(s: number): boolean {
    const pit = this.track.def.pitLane;
    const len = this.track.length;
    const fromEntry = loopDelta(pit.entryS, s, len);
    const toExit = loopDelta(s, pit.exitS, len);
    return fromEntry >= 0 && toExit >= 0;
  }

  /** Called by the session when this car enters the pit box. */
  onPitStopComplete(): void {
    this.boxCommitted = false;
    this.boxOvershootS = 0;
    this.setState('PIT_EXIT');
  }

  /** Called when the car rejoins the track after a stop. */
  onRejoinTrack(): void {
    this.boxCommitted = false;
    this.boxOvershootS = 0;
    this.setState('LINE_FOLLOWER');
    this.defensiveMoveUsed = false;
  }

  /** Human-readable state for the debug overlay. */
  get stateLabel(): string {
    return this.state;
  }
}
