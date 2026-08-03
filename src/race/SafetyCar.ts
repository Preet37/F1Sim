/**
 * The safety car, as a vehicle rather than as a speed limit.
 *
 * WHY THIS FILE EXISTS. Before it, a "safety car period" in this game was a
 * state: a cap on everybody's speed, a set of boards, and a phase machine. There
 * was no car. The player's report is the whole brief —
 *
 *   "technically the safety car should be in front of the leader, so you have to
 *    look up how safety cars look like and design and create one and have it
 *    come out on the circuit and lead the way until the debris is cleared out."
 *
 * — and it is also what the regulations describe. Every operative sentence of
 * 2026 Section B Art. B5.13 (2025 Sporting Regs Art. 55) is about an object on
 * the road: it "will join the track with its orange lights illuminated"
 * (B5.13.1 / Art. 55.6), cars "form up in a queue behind the Safety Car"
 * (B5.13.2b / Art. 55.7), "the green light on the Safety Car will be
 * illuminated" (B5.13.4a / Art. 55.9), it "shall be used at least until the
 * leader is behind it" (B5.13.5a / Art. 55.10), "the orange lights on the Safety
 * Car will be extinguished" (B5.13.6 / Art. 55.15), and it enters "the Pit Entry
 * Road" at the end of that lap. None of that can be modelled by a number.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT. This owns where the car IS, how fast it
 * is going, and which of its lamps are lit. It does not decide anything: every
 * transition is ordered by `RaceControlManager`, which is the Race Director.
 * The split is the same one the regulations use — B1.3.3e gives the Race
 * Director authority over "the use of the Safety Car", and B1.2.1j appoints a
 * driver to actually drive it.
 *
 * WHY IT IS NOT A `CarEntry`. A `CarEntry` is a competitor: it has a driver, a
 * team, tyres that wear, damage, a strategy, a classification, an AI controller
 * with a racing line and an overtaking model, and an index that nineteen other
 * systems use as an array subscript — `EffectsDirector` sizes its skid-mark
 * budget on `cars.length`, `Renderer.carVisuals` is index-parallel with it, the
 * timing loop sorts it, and the stewards judge it. The safety car is none of
 * those things and putting it in that array would make it all of them. It is a
 * position on the lap that follows an instruction, which is exactly what this
 * class is.
 *
 * THE PIT LANE IS A DISTANCE RANGE ON THE SAME SPLINE. See `PitLane` in
 * `TrackDefinition.ts`: the lane is modelled as a stretch of lap distance plus a
 * lateral offset, not as a second geometry. So one `(s, lateral)` pair describes
 * the safety car whether it is in its garage, running down the lane, or leading
 * the field, and the renderer needs no special case to draw it.
 */

import { clamp01, loopDelta } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Where the car physically is.
 *
 *   GARAGE     Parked at the end of the pit lane, lights out, waiting. Art. 55.2
 *              has it take up position at the front of the grid before the
 *              start and cover a lap; for the rest of the session it sits here.
 *   SCRAMBLING Ordered out. Running down the pit lane toward the exit, orange
 *              lights already on — the boards and the message go out the moment
 *              the order is given (B5.13.1 / Art. 55.4), not when it arrives.
 *   CIRCUIT    On the racing surface, leading the field.
 *   RETURNING  In the Pit Entry Road and the pit lane, orange lights out
 *              (B5.13.6 / Art. 55.15), on its way back to the garage.
 */
export type SafetyCarStation = 'garage' | 'scrambling' | 'circuit' | 'returning';

/**
 * How fast it runs down the pit lane, as a fraction of the posted limit.
 *
 * A scrambling safety car is not obeying the pit lane limiter — it is a course
 * vehicle under the Race Director's orders, not a competitor — but it is still
 * driving down a lane with people in it, so it does not fly. Nine tenths of the
 * limit is the compromise, and it is a modelling choice with nothing to cite.
 */
const SC_LANE_PACE_SHARE = 0.9;

/**
 * How far before the pit exit the car waits, metres.
 *
 * Where a real safety car sits with its engine running: at the end of the lane,
 * short of the exit line, so that when the order comes it is already rolling.
 */
const SC_HOLD_SHORT_M = 30;

/** Acceleration and braking the safety car uses, m/s². A road car, not an F1 car. */
const SC_ACCEL_MS2 = 4.5;

export class SafetyCar {
  private readonly track: TrackSpline;

  station: SafetyCarStation = 'garage';

  /** Distance along the lap, metres. Valid in every station — see the header. */
  s = 0;
  /** Lateral offset from the centreline, metres, +left. */
  lateral = 0;
  /** Which lap of the circuit it is on. Only meaningful while on the circuit. */
  lap = 0;
  /** Current speed, m/s. */
  speedMs = 0;

  /**
   * The orange lights on the roof.
   *
   * On from the moment the order is given until "SAFETY CAR IN THIS LAP", when
   * they are extinguished — and their going out IS the signal, both to the
   * drivers and to this simulation: "the orange lights on the Safety Car will be
   * extinguished. This will be the signal to the Competitors and drivers that it
   * will be entering the Pit Lane at the end of that lap" (B5.13.6 / Art.
   * 55.15).
   */
  orangeLights = false;

  /**
   * The green light on the back.
   *
   * Lit only to order specific cars past, and it is the ONLY thing that makes an
   * overtake legal under a safety car other than the listed exceptions:
   * B5.13.2c-i, "if a driver is signalled to do so from the Safety Car, by use
   * of the green light on the Safety Car". It is used for two different
   * instructions — cars wrongly picked up (B5.13.4a / Art. 55.9) and lapped cars
   * (B5.13.4c / Art. 55.14) — and goes out when they have all gone by.
   */
  greenLight = false;

  /** Seconds the car has spent in its current station. */
  stationS = 0;

  constructor(track: TrackSpline) {
    this.track = track;
    this.reset();
  }

  reset(): void {
    const pit = this.track.def.pitLane;
    this.station = 'garage';
    this.s = this.holdS;
    this.lateral = pit.lateralOffsetM;
    this.lap = 0;
    this.speedMs = 0;
    this.orangeLights = false;
    this.greenLight = false;
    this.stationS = 0;
  }

  /** Where it waits: just short of the pit exit line. */
  private get holdS(): number {
    const pit = this.track.def.pitLane;
    return ((pit.exitS - SC_HOLD_SHORT_M) % this.track.length + this.track.length) %
      this.track.length;
  }

  /** True while it is somewhere the player could see it. */
  get visible(): boolean {
    return this.station !== 'garage';
  }

  /** True while it is on the racing surface and the field is queued behind it. */
  get onTrack(): boolean {
    return this.station === 'circuit';
  }

  /**
   * The order to deploy.
   *
   * The car leaves its garage; the message and the boards are race control's
   * business and go out in the same step. It does not wait for the leader to be
   * anywhere: "the Safety Car will join the track with its orange lights
   * illuminated regardless of where the leader is" (B5.13.1 / Art. 55.6).
   */
  scramble(): void {
    if (this.station !== 'garage') return;
    this.station = 'scrambling';
    this.stationS = 0;
    this.orangeLights = true;
    this.greenLight = false;
    this.s = this.holdS;
    this.lateral = this.track.def.pitLane.lateralOffsetM;
    this.speedMs = 0;
  }

  /** True once it has run down the lane and is sitting at the exit line. */
  get readyToJoin(): boolean {
    if (this.station !== 'scrambling') return false;
    const toExit = loopDelta(this.s, this.track.def.pitLane.exitS, this.track.length);
    return toExit <= 1;
  }

  /**
   * Pulls out of the pit exit onto the circuit.
   *
   * @param lap the lap the leader is on, so the safety car's own lap counter
   *        starts alongside the field's rather than at zero
   */
  join(lap: number): void {
    this.station = 'circuit';
    this.stationS = 0;
    this.s = this.track.def.pitLane.exitS;
    this.lap = lap;
    this.orangeLights = true;
  }

  /**
   * Peels into the Pit Entry Road.
   *
   * The lights are already out — they went out at "SAFETY CAR IN THIS LAP", a
   * lap earlier — so nothing about the lamps changes here.
   */
  returnToPits(): void {
    this.station = 'returning';
    this.stationS = 0;
    this.orangeLights = false;
    this.greenLight = false;
  }

  /**
   * Runs the car for one step.
   *
   * @param dt seconds
   * @param paceMs the speed race control wants it to hold while on the circuit
   * @param lateralM where on the road it should be running
   * @returns true on the step it crosses the Line
   */
  advance(dt: number, paceMs: number, lateralM: number): boolean {
    this.stationS += dt;
    const pit = this.track.def.pitLane;
    const len = this.track.length;

    let target: number;
    let targetLateral: number;
    switch (this.station) {
      case 'garage':
        this.speedMs = 0;
        return false;

      case 'scrambling': {
        const toExit = loopDelta(this.s, pit.exitS, len);
        // Slows to a stop at the exit line and waits there for the order to
        // pull out, which is what a real one does — it is released into a gap.
        target = toExit <= 0 ? 0
          : Math.min(
            pit.speedLimitKph / 3.6 * SC_LANE_PACE_SHARE,
            Math.sqrt(2 * SC_ACCEL_MS2 * Math.max(toExit, 0)),
          );
        targetLateral = pit.lateralOffsetM;
        break;
      }

      case 'circuit':
        target = paceMs;
        targetLateral = lateralM;
        break;

      case 'returning': {
        target = pit.speedLimitKph / 3.6 * SC_LANE_PACE_SHARE;
        targetLateral = pit.lateralOffsetM;
        // Home once it has run the length of the lane back to where it waits.
        const toHold = loopDelta(this.s, this.holdS, len);
        if (toHold <= 1 || toHold > len * 0.5) {
          this.station = 'garage';
          this.stationS = 0;
          this.s = this.holdS;
          this.speedMs = 0;
          return false;
        }
        break;
      }
    }

    // A road car's rate of change of speed, not an F1 car's. Bounded both ways
    // so a pace that steps — and it does, because the racing line's own speed
    // steps at every corner — comes out as something that could be driven.
    const dv = target - this.speedMs;
    const maxDv = SC_ACCEL_MS2 * dt;
    this.speedMs += Math.abs(dv) <= maxDv ? dv : Math.sign(dv) * maxDv;
    if (this.speedMs < 0) this.speedMs = 0;

    // Lateral, at a rate a car changes lane at rather than instantly.
    const dl = targetLateral - this.lateral;
    const maxDl = 3 * dt;
    this.lateral += Math.abs(dl) <= maxDl ? dl : Math.sign(dl) * maxDl;

    this.s += this.speedMs * dt;
    if (this.s >= len) {
      this.s -= len;
      if (this.station === 'circuit') this.lap++;
      return this.station === 'circuit';
    }
    return false;
  }

  /**
   * Where on the road it runs, metres from the centreline.
   *
   * Not the racing line. A safety car sits on one side of the road — it is
   * showing the field where the circuit is, not setting a lap time — and it
   * being off-line is what makes the queue behind it legible: the leader is
   * tucked up behind it, not alongside.
   *
   * @param halfWidthM the road's half width where it currently is
   * @param sign +1 or -1, the side of the road the pit lane is on, so that the
   *        car is already on the correct side when it peels in
   */
  static runningLine(halfWidthM: number, sign: number): number {
    return sign * clamp01(0.45) * halfWidthM;
  }
}
