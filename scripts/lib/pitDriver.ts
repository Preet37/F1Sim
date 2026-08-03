import { RaceEngine } from '../../src/race/RaceEngine';
import type { CarEntry } from '../../src/race/CarEntry';
import { loopDelta } from '../../src/core/MathUtils';
import type { TrackSpline } from '../../src/track/TrackSpline';
import { AIVehicleController, type AIPerception } from '../../src/ai/AIVehicleController';
import type { VehicleControls } from '../../src/physics/VehiclePhysics';

/**
 * The stand-in for a human at the wheel — the game's own AI, driving the
 * player's car, with `pitThisLap` forced false in the perception it reads so it
 * never enters its own pit-approach state. Lifted from `probePitLimiter`, and
 * for the same reason: anything that cannot get round the circuit at racing
 * speed fails for reasons that have nothing to do with the pit lane.
 *
 * WHY IT LIVES HERE rather than inside `probePitStop.ts`, where it was written.
 *
 * A probe that puts a real car through a real pit lane is expensive to get
 * right and every diagnostic aimed at the pit lane needs one. The first attempt
 * at splitting `probe:pitstop`'s six failing cases apart wrote its own crude
 * driver instead, and it put the car in the barrier before the pit entry in
 * every arm — so all four arms reported "no stop" for a reason that had nothing
 * to do with the question being asked, and the diagnostic distinguished
 * nothing. Anything that cannot reliably get to the pit lane cannot be used to
 * reason about the pit lane.
 *
 * Importing it from `probePitStop.ts` is not an option either: that file runs
 * its whole probe at module top level, so importing anything from it executes
 * a full seven-case sweep as a side effect. Hence a module of its own, with no
 * top-level behaviour at all.
 */
export class ProbeDriver {
  private readonly ai: AIVehicleController;
  private readonly view: AIPerception;
  private inLane = false;

  constructor(private readonly car: CarEntry, private readonly track: TrackSpline) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    this.view = { ...car.perception };
  }

  drive(dt: number, out: VehicleControls): void {
    const car = this.car;
    if (car.inPitLane && !this.inLane) { this.inLane = true; this.ai.onPitStopComplete(); }
    Object.assign(this.view, car.perception);
    this.view.pitThisLap = false;

    const c = this.ai.update(dt, car.physics, car.s, car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;

    // Move over to the pit side on the run in: a car has to be on the pit side
    // of the road to be let in, and the AI declines to do it.
    const pit = this.track.def.pitLane;
    const toEntry = loopDelta(car.s, pit.entryS, this.track.length);
    if (!this.inLane && toEntry >= 0 && toEntry < 300) {
      const side = Math.sign(pit.lateralOffsetM) || -1;
      const want = side * this.track.halfWidthAt(car.s) * 0.5;
      out.steer = Math.max(-1, Math.min(1, out.steer - (want - car.lateral) * 0.05));
    }
    out.reverse = c.reverse;
    out.gearRequest = c.gearRequest;
    out.ersMode = c.ersMode;
    out.drsRequested = c.drsRequested;
    out.pitLimiter = false;
  }
}

/** Keeps the import list honest for callers that only want the type. */
export type { RaceEngine };
