import { clamp, clamp01, damp, lerp, loopDelta, Rng, wrapAngle, Vec2 } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';
import type { VehiclePhysics, VehicleControls, ErsMode } from '../physics/VehiclePhysics';
import { steerRackLimit } from '../physics/VehiclePhysics';

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
  /** True when a yellow flag covers the sector the car is in. */
  localYellow: boolean;
  /** True when the car is being lapped and must yield. */
  blueFlag: boolean;
  /** Safety car or VSC in force — hold position and respect the delta. */
  neutralised: boolean;
  /** Speed the VSC delta requires, m/s. 0 when not applicable. */
  neutralisedTargetMs: number;
  /** True when the strategy wants this car in the pits this lap. */
  pitThisLap: boolean;
  /** 0 dry .. 1 standing water. */
  wetness: number;
}

export function createPerception(): AIPerception {
  return {
    blendRemainingM: 0,
    ahead: null, behind: null, alongsideLeft: null, alongsideRight: null,
    localYellow: false, blueFlag: false, neutralised: false,
    neutralisedTargetMs: 0, pitThisLap: false, wetness: 0,
  };
}

export function createNeighbour(): Neighbour {
  return { index: -1, gapM: 0, gapS: 0, lateral: 0, speedMs: 0, closingMs: 0 };
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

function profileFor(d: Driver, wetness: number): DriverProfile {
  // Wet conditions shift the weighting from raw pace toward wet skill, which is
  // why the order shuffles in the rain rather than staying fixed.
  const effSkill = lerp(d.skill, d.wetSkill, clamp01(wetness));
  return {
    // A 0.77-skill backmarker runs ~2.5% off the reference; a 0.97 driver is
    // essentially on it. Across a 90s lap that is a spread of about 2.2s.
    paceFactor: lerp(0.968, 1.0, (effSkill - 0.75) / 0.25),
    brakingConfidence: lerp(0.9, 1.02, (effSkill - 0.75) / 0.25),
    overtakeThresholdS: lerp(1.15, 0.55, d.aggression),
    followDistanceS: lerp(0.9, 0.35, d.aggression),
    errorScale: lerp(0.028, 0.004, d.consistency),
    defenceCommitment: lerp(0.45, 1.0, d.racecraft),
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
   */
  throttleShare: 1.03,
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

/** How often the FSM re-evaluates its state, in seconds. */
const DECISION_INTERVAL = 0.1;
/** How often the proximity scan runs while committed to a move. */
const CLOSE_QUARTERS_INTERVAL = 1 / 120;

export class AIVehicleController {
  readonly driver: Driver;
  private readonly track: TrackSpline;
  private readonly rng: Rng;

  state: AIState = 'LINE_FOLLOWER';
  /** Seconds spent in the current state. */
  stateTime = 0;

  /** Lateral offset the AI is currently targeting, relative to centreline. */
  targetLateral = 0;
  private smoothedLateral = 0;

  /** The controls this AI produced last tick. */
  readonly controls: VehicleControls = {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false,
    reverse: false,
  };

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

  constructor(driver: Driver, track: TrackSpline, seed: number) {
    this.driver = driver;
    this.track = track;
    this.runoffCaution = track.def.scenery === 'street' ? 0.96 : 1.0;
    this.rng = new Rng(seed);
    this.profile = profileFor(driver, 0);
    this.errorPhase = this.rng.range(0, 100);
  }

  /** Recomputes the driver profile when conditions change materially. */
  onConditionsChanged(wetness: number): void {
    this.profile = profileFor(this.driver, wetness);
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
      this.targetLateral = clamp(track.lineOffset[track.indexAt(s)], -halfWidth * 0.5, halfWidth * 0.5);
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
      return;
    }
    if (p.pitThisLap) {
      const pit = track.def.pitLane;
      // Commit once inside the braking distance for the pit entry.
      const toEntry = loopDelta(s, pit.entryS, track.length);
      if (toEntry > 0 && toEntry < 260) {
        this.setState('PIT_APPROACH');
        return;
      }
    }

    // --- Under a safety car or VSC nobody races.
    if (p.neutralised) {
      this.setState('FOLLOW');
      this.targetLateral = track.lineOffset[track.indexAt(s)];
      return;
    }

    // --- Blue flag: yield. A lapped car must let the leader past, and doing so
    // means getting decisively off the racing line, not just lifting.
    if (p.blueFlag) {
      this.setState('FOLLOW');
      const lineOffset = track.lineOffset[track.indexAt(s)];
      // Move to the opposite side of the track from the racing line.
      this.targetLateral = clamp(-Math.sign(lineOffset || 1) * halfWidth * 0.72, -halfWidth, halfWidth);
      return;
    }

    const lineOffset = track.lineOffset[track.indexAt(s)];
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

      if (withinRange && catching && canPass && !p.localYellow) {
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

    // Move toward the target offset at a rate the car can actually achieve.
    // Snapping the target would produce a steering step change the tires cannot
    // follow, and the car would simply slide.
    const lateralRate = this.state === 'OVERTAKE' || this.state === 'DEFEND' ? 3.2 : 2.0;
    this.smoothedLateral = damp(this.smoothedLateral, this.targetLateral, lateralRate, dt);

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
      this.sample(track.lineCurvature, s + lead - 3) +
      this.sample(track.lineCurvature, s + lead) +
      this.sample(track.lineCurvature, s + lead + 3)
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
    const lineHere = this.state === 'LINE_FOLLOWER'
      ? this.sample(track.lineOffset, s)
      : this.smoothedLateral;
    const latError = lineHere - lateral;

    // The racing line's own heading relative to the centreline tangent. Without
    // this the controller has to generate the whole of a corner's turn-in as
    // "error", which means it is always behind the line rather than on it.
    const H = 12;
    const dOffsetDs =
      (this.sample(track.lineOffset, s + H) - this.sample(track.lineOffset, s - H)) / (2 * H);
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

    // Neutralised: obey the delta.
    if (p.neutralised && p.neutralisedTargetMs > 0) {
      targetSpeed = Math.min(targetSpeed, p.neutralisedTargetMs);
    }

    // Pit lane speed limit.
    if (this.state === 'PIT_APPROACH' || this.state === 'PIT_EXIT') {
      const pit = track.def.pitLane;
      const inLane = this.isInPitLane(s);
      c.pitLimiter = inLane;
      if (inLane) targetSpeed = Math.min(targetSpeed, (pit.speedLimitKph - 2) / 3.6);
    } else {
      c.pitLimiter = false;
    }

    // Following: hold a gap rather than driving into the car ahead. Without an
    // explicit term here, AI cars simply rear-end each other in traffic.
    if (p.ahead !== null && this.state !== 'OVERTAKE') {
      const desiredGapM = Math.max(6, prof.followDistanceS * speed);
      if (p.ahead.gapM < desiredGapM) {
        const deficit = 1 - clamp01(p.ahead.gapM / Math.max(desiredGapM, 1));
        targetSpeed = Math.min(targetSpeed, p.ahead.speedMs * (1 - deficit * 0.22));
      }
    }
    // Even while overtaking, do not drive through the car being passed.
    if (p.ahead !== null && p.ahead.gapM < 5 && Math.abs(p.ahead.lateral - lateral) < 2.0) {
      targetSpeed = Math.min(targetSpeed, p.ahead.speedMs * 0.96);
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
   */
  private corneringSpeedLimit(car: VehiclePhysics, sAt: number): number {
    const track = this.track;

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
    this.setState('PIT_EXIT');
  }

  /** Called when the car rejoins the track after a stop. */
  onRejoinTrack(): void {
    this.setState('LINE_FOLLOWER');
    this.defensiveMoveUsed = false;
  }

  /** Human-readable state for the debug overlay. */
  get stateLabel(): string {
    return this.state;
  }
}
