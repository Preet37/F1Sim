/**
 * The player's input path, as a rig a probe can drive.
 *
 * Every handling probe in this repo except `probe:gearbox` and
 * `probe:framerate` builds a `VehicleControls` literal and hands it straight to
 * `VehiclePhysics.step`. That can only ever find bugs in the solver. It cannot
 * see the keyboard ramp, the return-to-centre spring, the speed-sensitive
 * assist, the frame/step split, or anything else between the key and the tyre —
 * which is the half of the chain the player actually operates, and the half
 * issue #45 lived in.
 *
 * This module is the same chain `main.ts` runs,
 *
 *     synthetic KeyboardEvent -> InputController.onKeyDown
 *       -> InputController.update(clock.frameDt, controls, ...)
 *         -> VehiclePhysics.step(PHYSICS_DT, controls, env)  x stepsThisFrame
 *
 * driven off a simulated wall clock so a run is repeatable and independent of
 * how long the probe itself takes to execute.
 *
 * CLOSED LOOP, which is the point. The existing handling probes fly OPEN-LOOP
 * manoeuvres: a step of lock, a scripted slalom, a lift. A player never does
 * that. A player looks at where the car is, decides it is not where they want
 * it, and taps a key — and then reacts to what that tap did. Whether a car is
 * pleasant or "swervy" is a property of that loop, not of either half alone: a
 * car with a perfectly respectable open-loop step response can still be
 * impossible to hold straight if the only input available is a digital key with
 * a ramp on it. Nothing in this repo measured that before.
 */

// ===========================================================================
// DOM stub — enough for InputController.attach() and its handlers.
// ===========================================================================

type Listener = (e: unknown) => void;

const windowListeners = new Map<string, Listener[]>();

function addListener(type: string, fn: Listener): void {
  const list = windowListeners.get(type) ?? [];
  list.push(fn);
  windowListeners.set(type, list);
}

function installWindowStub(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.window) return;
  g.window = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: (type: string, fn: Listener) => addListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => {
      const list = windowListeners.get(type);
      if (list) windowListeners.set(type, list.filter((f) => f !== fn));
    },
  };
  g.navigator = { maxTouchPoints: 0, getGamepads: () => [] };
}

function stubElement(): HTMLElement {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  } as unknown as HTMLElement;
}

installWindowStub();

import { PHYSICS_DT, SimClock } from '../../src/core/SimClock';
import { DEFAULT_INPUT_CONFIG, InputController } from '../../src/input/InputController';
import {
  VehiclePhysics,
  steerRackLimit,
  type EnvironmentState,
  type VehicleControls,
} from '../../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../../src/physics/VehicleSpec';

export const RIG_ENV: EnvironmentState = {
  trackTempC: 38, airTempC: 25, wetness: 0, surfaceGrip: 1,
  airDensityRatio: 1, abrasion: 1,
};

/**
 * Human reaction time, seconds — the same 250ms `probe:drivability` and
 * `RacingLine` both use, so the three cannot quietly disagree about what a
 * driver is capable of.
 */
export const REACTION_S = 0.25;

function freshControls(): VehicleControls {
  return {
    throttle: 0, brake: 0, steer: 0, drsRequested: false, ersMode: 'balanced',
    gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
  };
}

function fireKey(type: 'keydown' | 'keyup', key: string, timeStampMs: number): void {
  // `timeStamp` is when the key MOVED, not when a busy main thread dispatched
  // the event. Carrying it is what lets the controller charge a press for the
  // time it was actually held rather than for the frames that happened to see
  // it — the fix recorded in PROJECT.md §6 under "the keyboard bug".
  const evt = {
    key, code: key, timeStamp: timeStampMs,
    target: { tagName: 'DIV' }, preventDefault: () => {},
  };
  for (const fn of windowListeners.get(type) ?? []) fn(evt);
}

// ===========================================================================
// The lane
// ===========================================================================

/**
 * The path the driver is trying to hold.
 *
 * `radiusM = Infinity` is a straight along +Z from the origin. A finite radius
 * is a constant-radius RIGHT-hander whose centre is at (-R, 0), which means the
 * driver has to hold lock rather than hold zero — and holding lock is where the
 * user says the car misbehaves (*"the car is literally gliding when the user
 * turns"*).
 *
 * THE SIGN CONVENTION, measured rather than assumed, because getting it wrong
 * produces a driver that steers away from the lane and a probe that reports a
 * perfectly good car as undrivable. `VehiclePhysics` faces +Z at heading 0 and
 * calls world +X the car's LEFT (`localVelY = velocity.x` at heading 0), so
 * POSITIVE steer turns right: 0.30 of lock held for two seconds at 120 km/h
 * puts the car at x = -27.54, and -0.30 puts it at +27.54.
 *
 * Everything below is therefore written so that a POSITIVE cross-track error
 * wants POSITIVE (right) steer, on the straight and in the corner alike.
 */
export interface Lane {
  radiusM: number;
}

/**
 * Signed cross-track error, metres. Positive means the car has drifted to the
 * LEFT of the lane — outside, in the right-hander — and wants right lock.
 */
function crossTrackError(lane: Lane, x: number, z: number): number {
  if (!Number.isFinite(lane.radiusM)) return x;
  const cx = -lane.radiusM;
  const d = Math.hypot(x - cx, z);
  return d - lane.radiusM;
}

/** Lane curvature, 1/m, signed the same way the steering is: positive is right. */
function laneCurvature(lane: Lane): number {
  return Number.isFinite(lane.radiusM) ? 1 / lane.radiusM : 0;
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** The controller's own ramp primitive, so the driver plans against the real one. */
function moveToward(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  return cur + (d > maxDelta ? maxDelta : d < -maxDelta ? -maxDelta : d);
}

function clampAbs(v: number, lim: number): number {
  return v < -lim ? -lim : v > lim ? lim : v;
}

/** Lateral g the lane itself demands at `speedMs`. */
export function laneLateralG(lane: Lane, speedMs: number): number {
  if (!Number.isFinite(lane.radiusM)) return 0;
  return (speedMs * speedMs) / lane.radiusM / 9.81;
}

/** The radius that asks for `g` of lateral acceleration at `speedKph`. */
export function radiusForG(speedKph: number, g: number): number {
  const v = speedKph / 3.6;
  return (v * v) / (g * 9.81);
}

// ===========================================================================
// The smallest correction a keyboard can make
// ===========================================================================

export interface TapResult {
  /** Largest steering input the tap bought. */
  peakSteer: number;
  /** Lateral displacement one second after the key went down, metres. */
  lateral1sM: number;
  /** Lateral displacement two seconds after the key went down, metres. */
  lateral2sM: number;
  /** Heading change two seconds after the key went down, degrees. */
  headingDeg: number;
  peakLatG: number;
  peakYawRate: number;
  peakRearSlipDeg: number;
}

/**
 * One press of one key, from straight running, and what the car does about it.
 *
 * Model-free: there is no driver, no controller and no tuning parameter in
 * this measurement at all. It is the transfer function from the smallest thing
 * a player can physically DO to the thing they see, which is why it is the
 * honest headline for "does a correction on this car do something reasonable".
 *
 * A player correcting a line wants to move the car something like half a car's
 * width. If the shortest press they can make moves it several metres, the only
 * way to drive is to over-correct and then correct back — which is what
 * swerving is, and no amount of vehicle-dynamics work upstream of the rack can
 * fix it.
 */
export function tapOnce(opts: {
  speedKph: number;
  tapMs: number;
  framePeriodMs?: number;
  tweak?: (car: VehiclePhysics) => void;
}): TapResult {
  const { speedKph, tapMs, framePeriodMs = 1000 / 60 } = opts;

  windowListeners.clear();
  const input = new InputController();
  input.attach(stubElement());

  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(0.6, 60));
  const car = new VehiclePhysics(spec, 'medium');
  car.fuelL = 60;
  car.frontTires.fit('medium', 95);
  car.rearTires.fit('medium', 95);
  const v = speedKph / 3.6;
  car.placeAt(0, 0, 0, v);
  opts.tweak?.(car);

  const clock = new SimClock();
  const controls = freshControls();
  let nowMs = 0;
  input.timeSourceMs = () => nowMs;
  clock.advance(0);

  // A second of straight running first, so the powertrain and the load
  // transfer are settled and the tap is the only thing that happens.
  const SETTLE_MS = 1000;
  const events = [
    { tMs: SETTLE_MS, type: 'keydown' as const },
    { tMs: SETTLE_MS + tapMs, type: 'keyup' as const },
  ];
  let next = 0;

  let peakSteer = 0, peakLatG = 0, peakYaw = 0, peakRear = 0;
  let lateral1 = 0, lateral2 = 0, heading2 = 0;

  const endMs = SETTLE_MS + 2000;
  while (nowMs < endMs - 1e-9) {
    nowMs += framePeriodMs;
    if (nowMs > endMs) nowMs = endMs;
    while (next < events.length && events[next].tMs <= nowMs + 1e-9) {
      const e = events[next++];
      fireKey(e.type, 'd', e.tMs);
    }
    const steps = clock.advance(nowMs);
    input.update(
      clock.frameDt, controls, car.speedMs,
      car.brakeLimitFraction, car.tractionLimitFraction,
    );
    const errV = v - car.speedMs;
    if (errV > 0) { controls.throttle = Math.min(1, errV * 0.35); controls.brake = 0; }
    else { controls.throttle = 0; controls.brake = Math.min(0.5, -errV * 0.12); }
    if (Math.abs(controls.steer) > peakSteer) peakSteer = Math.abs(controls.steer);

    for (let i = 0; i < steps; i++) {
      car.step(PHYSICS_DT, controls, RIG_ENV);
      if (nowMs >= SETTLE_MS) {
        const g = Math.abs(car.lateralG);
        if (g > peakLatG) peakLatG = g;
        const y = Math.abs(car.yawRate);
        if (y > peakYaw) peakYaw = y;
        const rd = Math.abs(car.rearTires.slipAngle) * (180 / Math.PI);
        if (rd > peakRear) peakRear = rd;
      }
    }
    if (lateral1 === 0 && nowMs >= SETTLE_MS + 1000) lateral1 = Math.abs(car.position.x);
    input.endFrame();
  }
  lateral2 = Math.abs(car.position.x);
  heading2 = Math.abs(car.heading) * (180 / Math.PI);
  input.detach();

  return {
    peakSteer,
    lateral1sM: lateral1,
    lateral2sM: lateral2,
    headingDeg: heading2,
    peakLatG,
    peakYawRate: peakYaw,
    peakRearSlipDeg: peakRear,
  };
}

// ===========================================================================
// The driver
// ===========================================================================

/**
 * How far ahead the driver looks, seconds.
 *
 * A driver does not steer at the error under the car; they steer at where the
 * car is going to be. Without a preview term any controller with a transport
 * delay in it limit-cycles regardless of what the car does — which would make
 * this rig a measurement of the driver model and nothing else.
 */
const PREVIEW_S = 1.1;

/** Shortest lookahead the pure-pursuit law is evaluated at, metres. */
const MIN_LOOKAHEAD_M = 12;

/** Window the driver differences the error over to judge its rate, seconds. */
const RATE_WINDOW_S = 0.12;

/**
 * Lock error, in input units, inside which the driver leaves the keys alone.
 *
 * A player is not chasing millimetres of wheel. Without a band a digital
 * controller chatters at the frame rate and the reversal count means nothing.
 */
const LOCK_BAND = 0.015;

/**
 * Curvature the driver adds per metre-second of accumulated error.
 *
 * A learned corner, not a control-theory flourish. The kinematic relation
 * `delta = atan(kappa * L)` is the lock a car with no tyre slip would need, and
 * a real one at 2g needs appreciably more — so a driver working purely off what
 * they can see runs wide by a fixed amount for the whole corner and a probe
 * with no integral term measures that offset instead of measuring the car.
 * Drivers do not do this: they arrive at a corner they have driven before with
 * the lock already wound on. The integrator is that memory, and `captureS` is
 * long enough for it to have converged before anything is measured.
 */
const LEARN_GAIN = 1.6e-4;
/** Ceiling on the learned term, 1/m, so a departure cannot wind it up. */
const LEARN_CLAMP = 0.01;

/**
 * How often the driver issues a new motor command, seconds.
 *
 * A hand does not re-plan at the frame rate. Left free-running, the digital arm
 * taps 28 times a second at 60fps and 8 at 15fps, so the rig would be measuring
 * how superhuman the model is allowed to be rather than anything about the car.
 * Deliberate corrections at 8 a second is at the brisk end of what a finger
 * sustains.
 *
 * It matters because a keyboard CANNOT HOLD a lock. The wheel ramps at 3.4
 * units/s while a key is down and springs back at 5.5 units/s the moment it is
 * released, so any steady lock between zero and full is a limit cycle whose
 * amplitude is set by how finely the hand can meter the press. That amplitude
 * is what the player feels as the car wandering.
 */
const DECISION_S = 0.125;

/**
 * The two ramp rates the driver is planning against.
 *
 * Read from `DEFAULT_INPUT_CONFIG` rather than restated, so a change to the
 * keyboard feel moves the model of the player with it. The asymmetry is the
 * point: the wheel returns to centre 62% faster than it winds on, so a press
 * has to pay for the spring as well as for the lock it wants.
 */
const STEER_RATE = DEFAULT_INPUT_CONFIG.keyboardSteerRate;
const CENTRE_RATE = DEFAULT_INPUT_CONFIG.keyboardCentreRate;

export interface LaneRun {
  /** Peak |cross-track error| after the capture window, metres. */
  maxErrM: number;
  /** RMS cross-track error over the measurement window, metres. */
  rmsErrM: number;
  /** Peak-to-peak wander over the measurement window, metres. This is "swerve". */
  swingM: number;
  /** RMS over the last third divided by RMS over the middle third. >1 is growing. */
  growth: number;
  /** Sign reversals of the driver's steering command, per second. */
  reversalsPerS: number;
  /** Key presses per second — how hard the input path makes the player work. */
  pressesPerS: number;
  /** Largest |steer| the input path ever published. */
  peakSteer: number;
  peakRearSlipDeg: number;
  meanKph: number;
  /** The car left the lane by more than `departM`, or spun. */
  departed: boolean;
  /** Frames the SimClock could not keep up with. */
  saturatedFrames: number;
}

export interface LaneOptions {
  lane: Lane;
  speedKph: number;
  /** Wall-clock seconds to simulate. */
  durationS: number;
  /** Frame period, milliseconds. 16.7 = 60fps. */
  framePeriodMs: number;
  /** Lateral offset the car is released from, metres. */
  startOffsetM?: number;
  /** Seconds at the start excluded from the measurement, while the car captures the lane. */
  captureS?: number;
  /** Cross-track error, metres, past which the run is called departed. */
  departM?: number;
  /** Seconds between the driver's motor commands. Defaults to `DECISION_S`. */
  decisionS?: number;
  /** Called once per frame with (seconds, cross-track error, published steer). */
  onSample?: (tS: number, errM: number, steer: number) => void;
  /** Mutates the car before the run — used to break handling deliberately. */
  tweak?: (car: VehiclePhysics) => void;
  /**
   * Steering is delivered by keyboard when true (the default), and by writing
   * `controls.steer` directly when false.
   *
   * The false arm is not a shortcut: it is the CONTROL. The same driver, the
   * same car, the same loop, with the digital ramp taken out — so a difference
   * between the two arms is attributable to the input path rather than to the
   * vehicle, and agreement between them rules the input path out.
   */
  keyboard?: boolean;
}

/**
 * Flies a closed-loop lane hold and reports how much the car wandered.
 *
 * The driver sees the car's cross-track error and its rate as they were
 * `REACTION_S` ago — a real transport delay, implemented as a queue of past
 * states rather than as a filter, because a filter delays the SIGNAL and a
 * human delays the DECISION and the two behave differently inside a loop.
 */
export function driveLane(opts: LaneOptions): LaneRun {
  const {
    lane, speedKph, durationS, framePeriodMs,
    startOffsetM = 0, captureS = 1.5, departM = 6, keyboard = true,
    decisionS = DECISION_S,
  } = opts;

  windowListeners.clear();
  const input = new InputController();
  input.attach(stubElement());

  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(0.6, 60));
  const car = new VehiclePhysics(spec, 'medium');
  car.fuelL = 60;
  car.frontTires.fit('medium', 95);
  car.rearTires.fit('medium', 95);
  const v = speedKph / 3.6;
  // Released pointing along the lane, displaced sideways by `startOffsetM`.
  car.placeAt(startOffsetM, 0, 0, v);
  opts.tweak?.(car);

  const clock = new SimClock();
  const controls = freshControls();
  let nowMs = 0;
  input.timeSourceMs = () => nowMs;

  /** Everything the driver has seen, most recent last. */
  const hist: { t: number; err: number }[] = [];
  /** Cross-track error as it was `back` seconds ago. */
  const errAgo = (tNow: number, back: number): number => {
    const want = tNow - back;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= want) return hist[i].err;
    return hist.length ? hist[0].err : 0;
  };
  /** Key events scheduled in continuous time, drained as the clock reaches them. */
  const queue: { tMs: number; type: 'keydown' | 'keyup'; key: 'a' | 'd' }[] = [];
  let nextDecisionMs = 0;
  let reversals = 0;
  let presses = 0;
  let lastDir = 0;
  /** The driver's learned extra curvature for this corner, 1/m. */
  let learned = 0;

  const errs: number[] = [];
  let maxErr = 0;
  let peakSteer = 0;
  let peakRear = 0;
  let kphSum = 0, kphN = 0;
  let departed = false;
  let saturatedFrames = 0;

  clock.advance(0);
  const endMs = durationS * 1000;

  while (nowMs < endMs - 1e-9) {
    nowMs += framePeriodMs;
    if (nowMs > endMs) nowMs = endMs;
    const tS = nowMs / 1000;

    // --- What the driver perceives, one reaction time ago -------------------
    //
    // The rate is differenced over a FIXED window rather than over one frame.
    // A frame difference is a derivative of a quantity that moves by
    // millimetres per frame, so at 144fps it is mostly numerical noise — and a
    // noisy rate term makes the driver twitch at the frame rate, which the rig
    // would then report as the car being twitchy. Frame-rate effects that are
    // real belong to the input path, not to the eyes.
    const err = crossTrackError(lane, car.position.x, car.position.y);
    hist.push({ t: tS, err });
    while (hist.length > 2 && hist[0].t < tS - 1.5) hist.shift();
    const seenErr = errAgo(tS, REACTION_S);
    const seenRate = (seenErr - errAgo(tS, REACTION_S + RATE_WINDOW_S)) / RATE_WINDOW_S;
    const seen = { err: seenErr, rate: seenRate };

    // --- The decision -------------------------------------------------------
    //
    // Pure pursuit, which is the standard model of a human path-follower and,
    // more importantly, is a model of a driver aiming at a POINT rather than a
    // relay on the error under the car. The lookahead is a distance because
    // that is what a driver sees: the same 0.4m of error is a twitch at 60 km/h
    // and a serious problem at 300.
    const Ld = Math.max(MIN_LOOKAHEAD_M, car.speedMs * PREVIEW_S);
    const eT = seen.err + PREVIEW_S * seen.rate;
    // Curvature, positive = right. The lane's own curvature plus whatever is
    // needed to null the predicted error: a car outside the right-hander
    // (positive error) needs more right, so both terms share a sign.
    learned = clampAbs(learned + LEARN_GAIN * seen.err * (framePeriodMs / 1000), LEARN_CLAMP);
    const kappa = laneCurvature(lane) + (2 * eT) / (Ld * Ld) + learned;
    const deltaRad = Math.atan(kappa * car.spec.wheelbaseM);
    // Into the units the rack takes. See the sign note on `Lane`.
    const steerCmd = clampUnit(
      deltaRad / Math.max(car.spec.maxSteerRad * steerRackLimit(car.speedMs), 1e-4),
    );

    const dir = Math.sign(steerCmd);
    if (dir !== 0 && lastDir !== 0 && dir !== lastDir) reversals++;
    if (dir !== 0) lastDir = dir;

    if (keyboard) {
      // The driver plans a PRESS, not a key state: they decide how much more
      // lock they want and hold the key for about as long as that takes, then
      // let go. That is what a keyboard player does, and it is the only way to
      // ask a digital control for a value between zero and full.
      //
      // Whether the release lands on a frame boundary is not up to them, so
      // the events are scheduled in continuous time and drained by the frame
      // that catches up with them — which is exactly what a browser does, and
      // exactly the path `HoldClock` exists to get right.
      if (nowMs >= nextDecisionMs) {
        nextDecisionMs = nowMs + decisionS * 1000;
        const cur = controls.steer;
        const gap = steerCmd - cur;
        if (Math.abs(gap) > LOCK_BAND) {
          const dir = gap > 0 ? 1 : -1;
          // How long to hold the key, SOLVED against the controller's own two
          // ramps rather than guessed, and solved for the MEAN lock across the
          // window rather than for the lock at the end of it.
          //
          // Both of those are corrections to earlier drafts and both mattered.
          // A closed-form solution assumes the wheel does not cross centre
          // inside the window; when it does, the algebra inverts and asks for a
          // full-window press — 0.425 of lock where 0.05 was wanted. And aiming
          // at the END of the window is aiming at the bottom of a sawtooth: the
          // car integrates lock into heading, so what it actually responds to is
          // the average, and a press that lands the wheel on 0.25 at the end of
          // the window has averaged 0.38 on the way there. That 52%
          // over-delivery is the driver being naive, not the car being wrong,
          // and leaving it in would have been charged to the car.
          const meanLockOver = (h: number): number => {
            const N = 48;
            const dt = decisionS / N;
            let lock = cur;
            let sum = 0;
            for (let k = 0; k < N; k++) {
              const t0 = k * dt;
              const held = Math.max(0, Math.min(dt, h - t0));
              if (held > 0) lock = moveToward(lock, dir, STEER_RATE * held);
              if (dt - held > 0) lock = moveToward(lock, 0, CENTRE_RATE * (dt - held));
              sum += lock;
            }
            return sum / N;
          };
          let lo = 0, hi = decisionS;
          if (dir * (meanLockOver(hi) - steerCmd) < 0) lo = hi;
          else {
            for (let k = 0; k < 20; k++) {
              const m = (lo + hi) * 0.5;
              if (dir * (meanLockOver(m) - steerCmd) < 0) lo = m; else hi = m;
            }
          }
          const holdS = (lo + hi) * 0.5;
          if (holdS > 1e-3) {
            const dirKey: 'a' | 'd' = dir > 0 ? 'd' : 'a';
            queue.push({ tMs: nowMs, type: 'keydown', key: dirKey });
            queue.push({ tMs: nowMs + holdS * 1000, type: 'keyup', key: dirKey });
            presses++;
          }
        }
      }
      // Drain everything the wall clock has passed, carrying the true event
      // timestamps. A press and release inside one frame therefore leaves no
      // key in the set — which is what a browser does with a flick shorter
      // than a frame, and what `HoldClock` still has to charge for.
      while (queue.length > 0 && queue[0].tMs <= nowMs + 1e-9) {
        const e = queue.shift()!;
        fireKey(e.type, e.key, e.tMs);
      }
    }

    const stepsThisFrame = clock.advance(nowMs);
    if (clock.saturated) saturatedFrames++;

    input.update(
      clock.frameDt, controls, car.speedMs,
      car.brakeLimitFraction, car.tractionLimitFraction,
    );

    if (!keyboard) {
      // The control arm: a continuous wheel that simply goes where the same
      // driver asked it to go.
      controls.steer = steerCmd;
    }

    // Hold the speed. The pedals are not what is being measured here.
    const errV = v - car.speedMs;
    if (errV > 0) { controls.throttle = Math.min(1, errV * 0.35); controls.brake = 0; }
    else { controls.throttle = 0; controls.brake = Math.min(0.5, -errV * 0.12); }

    if (Math.abs(controls.steer) > peakSteer) peakSteer = Math.abs(controls.steer);

    for (let i = 0; i < stepsThisFrame; i++) {
      car.step(PHYSICS_DT, controls, RIG_ENV);
      const e = crossTrackError(lane, car.position.x, car.position.y);
      const rearDeg = Math.abs(car.rearTires.slipAngle) * (180 / Math.PI);
      if (rearDeg > peakRear) peakRear = rearDeg;
      kphSum += car.speedKph; kphN++;
      if (tS >= captureS) {
        errs.push(e);
        if (Math.abs(e) > maxErr) maxErr = Math.abs(e);
      }
      if (Math.abs(e) > departM) departed = true;
      // A sideslip past 45 degrees is not a car cornering.
      const beta = Math.abs(Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 1)));
      if (beta > 0.785) departed = true;
    }

    opts.onSample?.(tS, crossTrackError(lane, car.position.x, car.position.y), controls.steer);

    input.endFrame();
    if (departed) break;
  }

  input.detach();

  const rms = (a: number[]): number =>
    a.length ? Math.sqrt(a.reduce((s, e) => s + e * e, 0) / a.length) : 0;

  const n = errs.length;
  const mid = errs.slice(Math.floor(n / 3), Math.floor((2 * n) / 3));
  const last = errs.slice(Math.floor((2 * n) / 3));
  let lo = Infinity, hi = -Infinity;
  for (const e of errs) { if (e < lo) lo = e; if (e > hi) hi = e; }

  return {
    maxErrM: maxErr,
    rmsErrM: rms(errs),
    swingM: n ? hi - lo : 0,
    growth: rms(mid) > 1e-6 ? rms(last) / rms(mid) : 1,
    reversalsPerS: reversals / Math.max(nowMs / 1000, 1e-6),
    pressesPerS: presses / Math.max(nowMs / 1000, 1e-6),
    peakSteer,
    peakRearSlipDeg: peakRear,
    meanKph: kphN ? kphSum / kphN : 0,
    departed,
    saturatedFrames,
  };
}
