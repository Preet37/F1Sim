/**
 * Fixed-timestep accumulator.
 *
 * The physics MUST run at a fixed rate — a slip-angle tire model integrated at a
 * variable timestep produces different lap times on different devices, which
 * would make lap records meaningless and career progression device-dependent.
 * So: physics at a fixed 120Hz, rendering at whatever the display gives us,
 * with interpolation left to the render layer.
 *
 * Time dilation (`timeScale`) is applied to accumulated time, so slow-motion
 * replays and 2x/4x race skip both fall out of the same loop.
 */

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/** Never simulate more than this many steps per frame — prevents death spiral. */
const MAX_STEPS_PER_FRAME = 8;

export class SimClock {
  /** Simulated seconds since the session started (excludes paused time). */
  simTime = 0;
  /** Wall-clock seconds of the last render frame. */
  frameDt = 0;
  /** 1 = realtime. 0.25 = slow-mo replay. 4 = race skip. */
  timeScale = 1;
  paused = false;

  private accumulator = 0;
  private lastNow = 0;
  private started = false;

  /** Smoothed frames-per-second, used by the dynamic resolution scaler. */
  fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;

  /** How many physics steps the last `advance()` call produced. */
  stepsLastFrame = 0;
  /** True when we hit the step ceiling — the sim is falling behind realtime. */
  saturated = false;

  reset(): void {
    this.simTime = 0;
    this.accumulator = 0;
    this.started = false;
    this.stepsLastFrame = 0;
    this.saturated = false;
  }

  /**
   * Feeds a new wall-clock timestamp (ms, from requestAnimationFrame) and
   * returns the number of fixed physics steps to run this frame.
   */
  advance(nowMs: number): number {
    if (!this.started) {
      this.started = true;
      this.lastNow = nowMs;
      return 0;
    }

    let dt = (nowMs - this.lastNow) * 0.001;
    this.lastNow = nowMs;

    // Tab-switch, breakpoint, or thermal stall: discard the gap rather than
    // teleporting 20 cars through the barriers.
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;

    this.frameDt = dt;

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.25) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.paused) {
      this.stepsLastFrame = 0;
      return 0;
    }

    this.accumulator += dt * this.timeScale;

    let steps = Math.floor(this.accumulator / PHYSICS_DT);
    this.saturated = steps > MAX_STEPS_PER_FRAME;
    if (this.saturated) {
      // Drop the backlog. Better to lose a few ms of sim time than to spend
      // 200ms in one frame and stutter.
      steps = MAX_STEPS_PER_FRAME;
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * PHYSICS_DT;
    }

    this.stepsLastFrame = steps;
    this.simTime += steps * PHYSICS_DT;
    return steps;
  }

  /**
   * Fraction of a physics step left in the accumulator, for render
   * interpolation between the last two physics states.
   */
  get interpolationAlpha(): number {
    return this.accumulator / PHYSICS_DT;
  }
}
