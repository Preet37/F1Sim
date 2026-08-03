/**
 * The pit stop, from the pit entry to the green light.
 *
 * This probe exists because of one sentence:
 *
 *   "sometimes if I don't brake the car just goes through the barrier and
 *    skips the pitstop"
 *
 * Both halves of that were real and neither was caught by anything. There was
 * no test at all for a car arriving at its own box too fast to stop in it: the
 * car sailed past at the 80 km/h limit, drove out the far end of the lane, and
 * the exit path then cleared `pitRequested` as though the call had been
 * answered. The stop was silently deleted — no tyres, no message, no penalty,
 * and on a two-stop strategy a disqualification at the flag for a stop the
 * driver had asked for and been quietly refused.
 *
 * So this drives the real engine into the real pit box at a sweep of arrival
 * speeds and stopping points, and asks four questions of each:
 *
 *   1. Was the car SERVICED, or was the stop lost? And if it was lost, does the
 *      driver still owe one — i.e. is the call still standing, so they come
 *      round and try again — or did it evaporate?
 *
 *   2. Did the car stay INSIDE the pit lane? The lane is bounded by the pit
 *      wall on one side and the garage frontage on the other, both of them
 *      solid, and a car that ends up outside either has gone through a wall.
 *      Measured against the lane's own geometry rather than against a guess.
 *
 *   3. Did the CHOREOGRAPHY run? A stop is jacks up, four guns, four wheels
 *      off, four wheels on, four guns again, jacks down, light green — in that
 *      order, with the light gating the driver. This walks the timeline and
 *      checks the order and that the driver is not released early.
 *
 *   4. Is the stationary TIME a function of the crew, with a believable spread?
 *      A pit crew is a career upgrade, so `pitCrewTimeS` has to be a real dial
 *      and not a decoration, and the distribution around it has to look like a
 *      season of real stops rather than a constant plus noise.
 *
 * Run: npm run probe:pitstop
 */

import { RaceEngine, type SessionConfig, type SessionKind } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta, Rng } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { TrackSpline } from '../src/track/TrackSpline';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';
import {
  PIT_CREW, PIT_CREW_SIZE, PIT_CREW_TIME_ELITE_S, PIT_CREW_TIME_POOR_S,
  WHEEL_CORNERS, makePitStopProgress, pitStopProgress, resolvePitStop,
} from '../src/race/PitStopChoreography';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/** PROBE_TRACE=1 prints the approach and the stop, step by step. */
const TRACE = process.env.PROBE_TRACE === '1';

// ===========================================================================
// The driver
// ===========================================================================

/**
 * How the driver aims at the box.
 *
 * `onmarks` is a good stop. `short` and `long` are the ordinary human error a
 * crew absorbs. `waylong` is an overshoot the crew cannot reach. `nobrake` is
 * the reported bug: the player never lifts, because nothing has told them the
 * box is a thing you brake for.
 */
type Approach = 'onmarks' | 'short' | 'long' | 'waylong' | 'nobrake';

/** Metres past the painted marks each approach aims to stop at. */
const AIM_M: Record<Approach, number> = {
  onmarks: 0,
  short: -4,
  long: 4,
  waylong: 22,
  nobrake: Number.NaN,
};

/**
 * The stand-in for a human at the wheel.
 *
 * The game's own AI drives to the pit entry — as in `probe:pitlimiter`, and for
 * the same reason: a throwaway driver that cannot get round the circuit fails
 * the probe for reasons that have nothing to do with the pit lane. Inside the
 * lane the AI hands over to a plain stopping controller, because the thing
 * under test is what happens when a car does or does not stop on its marks, and
 * that has to be commanded rather than left to a state machine that already
 * knows how.
 */
class PitDriver {
  private readonly ai: AIVehicleController;
  private readonly view: AIPerception;
  private inLane = false;
  /**
   * How many times this driver has been down the lane.
   *
   * The scripted approach applies to the FIRST visit only. A driver who has
   * just been waved through for overshooting does not overshoot again on
   * purpose — they come round and stop on the marks — and testing the recovery
   * with a driver who repeats the same mistake for ever tests nothing.
   */
  private visits = 0;
  /** Seconds spent stationary in the lane with nobody working on the car. */
  private waitedS = 0;

  constructor(
    private readonly car: CarEntry,
    private readonly track: TrackSpline,
    private readonly approach: Approach,
  ) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    this.view = { ...car.perception };
  }

  drive(dt: number, out: VehicleControls): void {
    const car = this.car;
    if (car.inPitLane && !this.inLane) {
      this.inLane = true;
      this.visits++;
      // The AI's pit-exit state is the one that drives a lane properly: hold
      // the offset, stay on the limiter, leave at the far end. Its approach
      // state would fight the scripted stop below.
      this.ai.onPitStopComplete();
    }
    if (!car.inPitLane && this.inLane) {
      this.inLane = false;
      // The engine calls this for AI cars on the way out of the lane; the
      // player has no `car.ai`, so the probe's own driver has to be told. Left
      // out, the controller stayed in its pit-exit state for the rest of the
      // session — holding the pit-lane offset at 80 km/h all the way round —
      // and the car never came back to try the box again.
      this.ai.onRejoinTrack();
    }

    Object.assign(this.view, car.perception);
    this.view.pitThisLap = false;
    const c = this.ai.update(dt, car.physics, car.s, car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.reverse = c.reverse;
    out.gearRequest = c.gearRequest;
    out.ersMode = c.ersMode;
    out.drsRequested = c.drsRequested;
    out.pitLimiter = false;

    // Move over to the pit side on the run in. A car has to be on the pit side
    // of the road to be let in, the AI declines to do it, and it is the one
    // part of a pit entry that is unambiguously the driver's job.
    const pit = this.track.def.pitLane;
    const toEntry = loopDelta(car.s, pit.entryS, this.track.length);
    if (!car.inPitLane && toEntry >= 0 && toEntry < 300) {
      const side = Math.sign(pit.lateralOffsetM) || -1;
      const want = side * this.track.halfWidthAt(car.s) * 0.5;
      out.steer = Math.max(-1, Math.min(1, out.steer - (want - car.lateral) * 0.05));
    }

    if (!car.inPitLane || car.servicedThisVisit) {
      this.waitedS = 0;
      return;
    }

    // Sitting still in the pit lane and nobody is working on the car.
    //
    // That is what an overshoot feels like from the cockpit: you stop, and
    // nothing happens, because the crew and their equipment are eight metres
    // behind you and the gantry light is not going to go green. What a driver
    // does then is what this does — give up on the box and drive out, and come
    // back round. Without it the probe's car sat with the brake pinned on the
    // spot it had overshot to, for the rest of the session, and the recovery it
    // was meant to be testing never got a chance to happen.
    if (!car.inPitBox && car.physics.speedMs < 0.5) this.waitedS += dt;
    // Sticky for the rest of the visit. Cleared on the way out of the lane,
    // above. Left un-sticky it deadlocked: the car pulled away, the wait reset,
    // the aiming controller saw an aim point it was already past and stood on
    // the brakes again, and it shuffled forward a few centimetres at a time for
    // the rest of the session.
    if (this.waitedS > 1.5) {
      out.throttle = 1;
      out.brake = 0;
      return;
    }

    const approach: Approach = this.visits > 1 ? 'onmarks' : this.approach;

    if (approach === 'nobrake') {
      out.throttle = 1;
      out.brake = 0;
      return;
    }

    // Stop on the marks: follow the speed a constant-deceleration approach
    // would be doing here, rather than braking once and coasting. A driver
    // aiming at a painted line does exactly this — they keep the car coming
    // until it is on the line — and a probe that merely brakes early and drifts
    // in cannot tell "stopped short" apart from "stopped long".
    const len = this.track.length;
    const raw = loopDelta(car.s, car.pitBoxS + AIM_M[approach], len);
    const toAim = raw > len * 0.5 ? raw - len : raw;
    const v = car.physics.speedMs;
    const vWanted = Math.min(24, Math.sqrt(2 * 4.0 * Math.max(toAim, 0)));
    if (toAim <= 0.1) {
      out.throttle = 0;
      out.brake = 1;
    } else if (v > vWanted + 0.3) {
      out.throttle = 0;
      out.brake = Math.min(1, (v - vWanted) / 3);
    } else if (v < vWanted - 0.3) {
      out.throttle = 0.35;
      out.brake = 0;
    } else {
      out.throttle = 0;
      out.brake = 0;
    }
  }
}

// ===========================================================================
// One visit to the pit lane
// ===========================================================================

interface Visit {
  circuit: string;
  approach: Approach;
  /** Did the car get into the lane at all? */
  entered: boolean;
  /** Speed as the car passed the painted marks, km/h. -1 if it stopped short. */
  atBoxKph: number;
  /** Where it came to rest relative to the marks, metres. NaN if it never did. */
  stoppedAtM: number;
  /** Was it serviced? */
  serviced: boolean;
  /** Stationary time, seconds. */
  stationaryS: number;
  /** Is the driver still owed a stop after the visit? */
  stillOwed: boolean;
  /** Did the car leave the lane at the far end? */
  leftLane: boolean;
  /**
   * The worst the car got outside the pit lane, metres.
   *
   * Positive means it was beyond the garage frontage — through the buildings.
   * The pit-wall side is measured separately because a car that crosses THAT
   * one is out on the circuit, which is a different and worse failure.
   */
  outsideGarageM: number;
  outsideWallM: number;
  /** Did it come round and complete a stop on a later lap? */
  completedLater: boolean;
  penalties: string[];
}

function runVisit(circuitId: string, approach: Approach, kind: SessionKind = 'race'): Visit {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind,
    name: 'Pit stop probe',
    durationS: 0,
    laps: 8,
    playerIndex: 0,
    standingStart: false,
    pitLaneStart: false,
    seed: 24601,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const g = engine.pitGeom;
  const player = engine.cars[0];

  // One car, one stretch of road. Nineteen AI cars converging on the same pit
  // entry is a different experiment and it is `probe:strategy`'s.
  for (const car of engine.cars) {
    if (car !== player) car.eliminated = true;
  }

  const startS = (pit.entryS - 900 + track.length) % track.length;
  const i0 = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[i0], track.targetSpeed[i0]);
  engine.requestPit(player, true);

  const driver = new PitDriver(player, track, approach);
  const c = engine.playerControls;

  const r: Visit = {
    circuit: def.name,
    approach,
    entered: false,
    atBoxKph: -1,
    stoppedAtM: Number.NaN,
    serviced: false,
    stationaryS: 0,
    stillOwed: false,
    leftLane: false,
    outsideGarageM: 0,
    outsideWallM: 0,
    completedLater: false,
    penalties: [],
  };

  let wasInLane = false;
  let leftOnce = false;
  let stationary = 0;
  const maxSteps = Math.round(400 / PHYSICS_DT);

  for (let step = 0; step < maxSteps; step++) {
    driver.drive(PHYSICS_DT, c);
    engine.step();
    if (player.retired) break;

    if (player.inPitLane) {
      if (!wasInLane) { wasInLane = true; r.entered = true; }

      // Containment. `lateral` is signed; the lane is on `g.sign`'s side, so a
      // magnitude beyond `garageFace` is through the garages and a magnitude
      // below `wallMag` is over the pit wall and onto the circuit.
      const mag = player.lateral * g.sign;
      r.outsideGarageM = Math.max(r.outsideGarageM, mag - g.garageFace);
      // Only judged where the wall actually stands — the entry and exit roads
      // taper in from the track edge and the car is legitimately inside the
      // line of the wall there.
      const u = g.u(player.s);
      if (u > g.entryOpenU + 5 && u < g.exitU - 5) {
        r.outsideWallM = Math.max(r.outsideWallM, g.wallMag - mag);
      }

      const raw = loopDelta(player.s, player.pitBoxS, track.length);
      const d = raw > track.length * 0.5 ? raw - track.length : raw;
      // Only before the stop: after it, the car drives past its own marks again
      // on the way out and would report the speed it left at.
      if (r.atBoxKph < 0 && d <= 0 && d > -6 && !player.servicedThisVisit) {
        r.atBoxKph = player.physics.speedKph;
      }
      if (player.inPitBox) {
        if (stationary === 0) r.stoppedAtM = d;
        stationary += PHYSICS_DT;
      }
    } else if (wasInLane) {
      wasInLane = false;
      if (!leftOnce) {
        leftOnce = true;
        r.leftLane = true;
        r.serviced = player.pitStops > 0;
        r.stationaryS = stationary;
        r.stillOwed = player.pitRequested;
        for (const p of player.penalties) r.penalties.push(p.kind + ': ' + p.reason);
        // A stop that worked needs nothing more proving.
        if (r.serviced) break;

        // The second attempt is put back on the approach rather than driven
        // round the lap.
        //
        // Not to save time — to keep the question honest. What is being tested
        // is that the ENGINE still owes the driver a stop and will take them
        // again, and a lap of Monza in between makes the answer depend on
        // whether the probe's driver survives Lesmo. It did not: the car left
        // the pit lane at Monza having missed its box, put it in the barrier
        // at 295 km/h on the way to Curva Grande, and the recovery test failed
        // for a reason that had nothing to do with the pit lane.
        const back = (pit.entryS - 900 + track.length) % track.length;
        const bi = track.indexAt(back);
        player.placeOnTrack(track, back, track.lineOffset[bi], track.targetSpeed[bi]);
      }
    }

    // The whole point of the fix: a lost stop must be recoverable. After the
    // first visit the car keeps driving, and the pit call is still standing, so
    // it should come round and get its stop on a later lap.
    if (leftOnce && player.pitStops > 0) {
      r.completedLater = true;
      break;
    }

    if (TRACE && step % 30 === 0 && loopDelta(player.s, pit.entryS, track.length) < 400) {
      console.log('      s=' + player.s.toFixed(0) +
        ' kph=' + player.physics.speedKph.toFixed(0) +
        ' lat=' + player.lateral.toFixed(1) +
        ' lane=' + player.inPitLane + ' box=' + player.inPitBox +
        ' req=' + player.pitRequested + ' stops=' + player.pitStops);
    }
  }

  if (!leftOnce) {
    r.serviced = player.pitStops > 0;
    r.stationaryS = stationary;
    r.stillOwed = player.pitRequested;
  }
  return r;
}

function reportVisit(r: Visit): void {
  console.log(
    '  ' + r.circuit.padEnd(22) + r.approach.padEnd(9) +
    ' in ' + (r.entered ? 'yes' : 'NO ') +
    '  at box ' + (r.atBoxKph < 0 ? '   -' : r.atBoxKph.toFixed(0).padStart(4)) + ' km/h' +
    '  rest ' + (Number.isNaN(r.stoppedAtM) ? '    -' : r.stoppedAtM.toFixed(1).padStart(5)) + 'm' +
    '  served ' + (r.serviced ? 'yes' : 'no ') +
    '  ' + r.stationaryS.toFixed(2).padStart(5) + 's' +
    '  owed after ' + (r.stillOwed ? 'yes' : 'no ') +
    '  retry ' + (r.completedLater ? 'ok ' : '-  ') +
    '  outside ' + r.outsideGarageM.toFixed(2) + '/' + r.outsideWallM.toFixed(2) + 'm',
  );
  for (const p of r.penalties) console.log('        penalty: ' + p);
}

function checkVisit(r: Visit): void {
  const tag = r.circuit + ' / ' + r.approach;

  if (!r.entered) {
    fail(tag + ': the car never got into the pit lane.');
    return;
  }

  // 1. Containment. Half a metre of tolerance, which is the contact resolution
  //    pushing the car back out of a wall it touched — not a car through it.
  if (r.outsideGarageM > 0.5) {
    fail(tag + ': got ' + r.outsideGarageM.toFixed(2) +
      'm beyond the garage frontage. That is through the buildings.');
  }
  if (r.outsideWallM > 0.5) {
    fail(tag + ': got ' + r.outsideWallM.toFixed(2) +
      'm past the pit wall, which puts it on the circuit.');
  }

  // 2. A stop that should have worked, worked.
  if (r.approach === 'onmarks' || r.approach === 'short' || r.approach === 'long') {
    if (!r.serviced) {
      fail(tag + ': stopped ' + r.stoppedAtM.toFixed(1) +
        'm from the marks and was not serviced. The crew can reach that.');
    }
    if (r.serviced && r.stillOwed) {
      fail(tag + ': serviced, but the pit call is still standing — the car will ' +
        'come straight back in next lap.');
    }
  }

  // 3. A stop that could not work is a lost stop, not a deleted one. This is
  //    the reported bug: the driver has to still owe the stop, and has to be
  //    able to come round and take it.
  if (r.approach === 'waylong' || r.approach === 'nobrake') {
    if (r.serviced) {
      fail(tag + ': the crew serviced a car that stopped ' +
        r.stoppedAtM.toFixed(1) + 'm from the marks. They cannot reach it.');
    }
    if (!r.stillOwed) {
      fail(tag + ': the stop was skipped AND the pit call was cleared. ' +
        'The driver has silently lost the stop they asked for.');
    }
    if (!r.completedLater) {
      fail(tag + ': the car never got its stop on a later lap. A missed box ' +
        'has to be recoverable by coming round again.');
    }
  }

  // 4. Nobody collects a penalty for any of this. Overshooting your box is not
  //    an offence; speeding in the pit lane is, and none of these do.
  const speeding = r.penalties.filter((p) => /speeding/i.test(p));
  if (speeding.length > 0) {
    fail(tag + ': pit lane speeding penalty — ' + speeding[0]);
  }
}

// ===========================================================================
// The choreography
// ===========================================================================

/**
 * Walks one stop from the moment the car comes to rest and reports the
 * timeline: when the jacks lift, when each corner's gun reports, when the car
 * comes down, and when the light goes green.
 *
 * The order is the thing being checked. A wheel cannot go on before the old one
 * is off, the car cannot come down before all four are tight, and the driver
 * cannot leave before the light — and every one of those is a claim about the
 * animation the player is watching as well as about the simulation.
 */
function runChoreography(circuitId: string): void {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race', name: 'Choreography', durationS: 0, laps: 8,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 4242,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const player = engine.cars[0];
  for (const car of engine.cars) if (car !== player) car.eliminated = true;

  const startS = (pit.entryS - 900 + track.length) % track.length;
  const i0 = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[i0], track.targetSpeed[i0]);
  engine.requestPit(player, true);

  const driver = new PitDriver(player, track, 'onmarks');
  const c = engine.playerControls;

  let seenStationary = false;
  let released = -1;
  const rows: string[] = [];
  let lastPhase = '';
  const cornerDone: number[] = [];
  let liftedAt = -1;
  let downAt = -1;

  for (let step = 0; step < Math.round(300 / PHYSICS_DT); step++) {
    driver.drive(PHYSICS_DT, c);
    engine.step();
    const view = engine.pitStopOf(player);

    if (player.inPitBox) {
      seenStationary = true;
      const p = view.progress;
      if (liftedAt < 0 && p.jack > 0.98) liftedAt = view.elapsedS;
      if (liftedAt >= 0 && downAt < 0 && p.jack < 0.02 && view.elapsedS > 0.5) downAt = view.elapsedS;
      for (let k = 0; k < p.corners.length; k++) {
        if (cornerDone[k] === undefined && p.corners[k].done) cornerDone[k] = view.elapsedS;
      }
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        rows.push('    ' + view.elapsedS.toFixed(2).padStart(5) + 's  ' + p.phase);
      }
    } else if (seenStationary) {
      released = engine.pitStopOf(player).lastStationaryS;
      break;
    }
  }

  if (!seenStationary) {
    fail(circuitId + ': the choreography probe never got the car into its box.');
    return;
  }

  console.log('  Phases:');
  for (const row of rows) console.log(row);
  console.log('  Jacks up at ' + liftedAt.toFixed(2) + 's, down at ' + downAt.toFixed(2) + 's');
  console.log('  Guns reported: ' + WHEEL_CORNERS
    .map((w, k) => w + ' ' + (cornerDone[k] ?? -1).toFixed(2) + 's').join('   '));
  console.log('  Released at ' + released.toFixed(2) + 's');

  if (liftedAt < 0 || liftedAt > 0.4) {
    fail(circuitId + ': the jacks took ' + liftedAt.toFixed(2) +
      's to lift the car. Both jacks go in as it stops.');
  }
  const lastGun = Math.max(...cornerDone);
  if (downAt < lastGun) {
    fail(circuitId + ': the car came down at ' + downAt.toFixed(2) +
      's, before the last gun reported at ' + lastGun.toFixed(2) + 's.');
  }
  if (released < downAt) {
    fail(circuitId + ': released at ' + released.toFixed(2) +
      's, before the car was back on the ground at ' + downAt.toFixed(2) + 's.');
  }
  if (cornerDone.length !== 4) {
    fail(circuitId + ': only ' + cornerDone.length + ' of four corners ever reported.');
  }
}

// ===========================================================================
// The distribution
// ===========================================================================

/**
 * What a season of stops looks like, per crew.
 *
 * The career sells a better pit crew, so the thing being sold has to be
 * visible: a better crew is faster on a good day AND has fewer bad days, and
 * both halves have to show up in the numbers. Checked against real stops — a
 * top team's clean stop is around two seconds, the record is 1.80s, a normal
 * one is 2.2-2.6s, and stops beyond three seconds are the handful per race that
 * make the highlights.
 */
function distribution(crewTimeS: number, n: number): {
  p05: number; p50: number; p90: number; p99: number; min: number; max: number;
  over3: number; over5: number;
} {
  const rng = new Rng(0x5eed1234);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(resolvePitStop({
      crewTimeS, extraWorkS: 0, penaltyS: 0, holdBeforeWorkS: 0,
      noseChange: false, trafficRisk: 0.03,
    }, rng).stationaryS);
  }
  out.sort((a, b) => a - b);
  const q = (p: number): number => out[Math.min(out.length - 1, Math.floor(p * out.length))];
  return {
    p05: q(0.05), p50: q(0.5), p90: q(0.9), p99: q(0.99),
    min: out[0], max: out[out.length - 1],
    over3: out.filter((t) => t > 3).length / out.length,
    over5: out.filter((t) => t > 5).length / out.length,
  };
}

// ===========================================================================


/**
 * A five-second penalty served in the box, and what it actually costs.
 *
 * The stewards issue these; the crew serve them. Art. B1.9.5c: the car "may not
 * be worked on until the Car has been stationary for the duration of the
 * penalty. In this context, touching the Car or driver by hand or tools or
 * equipment will all constitute working."
 *
 * The thing being checked is that the hold is at the FRONT of the stop and not
 * added to the end of it, because those two produce the same stationary time
 * and completely different pit stops. At the front, the driver sits for five
 * seconds watching twenty-one people stand off his car and THEN has a full stop
 * — which is why a five-second penalty is worth far more than five seconds, and
 * why staying out is sometimes the right call. Added to the end, the crew work
 * normally and the car simply sits there afterwards, which is not the rule and
 * is not worth watching.
 *
 * So: no gun reports before the hold has elapsed, the jacks do not lift the car
 * before then, and the total is the hold PLUS a full stop rather than the
 * maximum of the two.
 */
function penaltyHold(): void {
  const rng = new Rng(0xbeef01);
  const crewTimeS = 2.4;

  const clean = resolvePitStop({
    crewTimeS, extraWorkS: 0, penaltyS: 0, holdBeforeWorkS: 0,
    noseChange: false, trafficRisk: 0,
  }, new Rng(0xbeef01));

  for (const holdS of [5, 10]) {
    const r = resolvePitStop({
      crewTimeS, extraWorkS: 0, penaltyS: 0, holdBeforeWorkS: holdS,
      noseChange: false, trafficRisk: 0,
    }, new Rng(0xbeef01));

    const firstGun = Math.min(...r.corners.map((c) => c.doneS));
    console.log(
      '  ' + holdS + 's penalty:  stationary ' + r.stationaryS.toFixed(2) + 's' +
      '  (clean stop ' + clean.stationaryS.toFixed(2) + 's)' +
      '  first gun at ' + firstGun.toFixed(2) + 's',
    );

    // The stop is the hold AND the work, not the larger of them.
    const expected = holdS + clean.stationaryS;
    if (Math.abs(r.stationaryS - expected) > 0.02) {
      fail('a ' + holdS + 's penalty made the stop ' + r.stationaryS.toFixed(2) +
        's; the hold is served BEFORE the work, so it should be ' +
        expected.toFixed(2) + 's — the hold plus a full stop.');
    }
    // Nothing happens during the hold.
    if (firstGun < holdS) {
      fail('a gun reported at ' + firstGun.toFixed(2) + 's into a ' + holdS +
        's penalty hold. The crew may not touch the car until it has elapsed.');
    }

    // And the choreography agrees, sampled through the hold.
    const prog = makePitStopProgress();
    for (const at of [0.1, holdS * 0.5, holdS - 0.1]) {
      pitStopProgress(r, at, prog);
      if (prog.phase !== 'penalty-hold') {
        fail('at ' + at.toFixed(1) + 's into a ' + holdS + 's hold the stop is in phase "' +
          prog.phase + '"; it should be serving the penalty.');
      }
      if (prog.jack > 0.001) {
        fail('the car is ' + (prog.jack * 100).toFixed(0) +
          '% up on its jacks ' + at.toFixed(1) + 's into a penalty hold.');
      }
      if (prog.corners.some((c) => c.loosening > 0.001)) {
        fail('a gun is on a nut ' + at.toFixed(1) + 's into a penalty hold.');
      }
    }
    // Immediately after it, the crew are on the car.
    pitStopProgress(r, holdS + 0.3, prog);
    if (prog.phase !== 'wheels' && prog.phase !== 'jacking') {
      fail('0.3s after a ' + holdS + 's hold elapsed the stop is in phase "' +
        prog.phase + '"; the crew should be working.');
    }
  }
  void rng;
}

function main(): void {
  console.log('\n=== PIT STOP ===\n');

  // ---- The crew ----------------------------------------------------------
  console.log('Crew over the wall: ' + PIT_CREW_SIZE + ' people');
  const byRole = new Map<string, number>();
  for (const m of PIT_CREW) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  console.log('  ' + [...byRole].map(([k, v]) => v + ' x ' + k).join(', '));
  if (PIT_CREW_SIZE < 20 || PIT_CREW_SIZE > 23) {
    fail('the crew is ' + PIT_CREW_SIZE + ' people; a Formula 1 crew is 20-23 over the wall.');
  }
  for (const corner of WHEEL_CORNERS) {
    const n = PIT_CREW.filter((m) => m.corner === corner).length;
    if (n !== 3) fail('corner ' + corner + ' has ' + n + ' people on it; it is three.');
  }

  // ---- Arriving at the box ------------------------------------------------
  console.log('\nArriving at the box:');
  const approaches: Approach[] = ['onmarks', 'short', 'long', 'waylong', 'nobrake'];
  for (const id of ['bahrain', 'monza', 'monaco']) {
    for (const a of approaches) {
      const r = runVisit(id, a);
      reportVisit(r);
      checkVisit(r);
    }
  }

  // ---- Every session kind -------------------------------------------------
  //
  // "whenever I am pitting no matter what session is I should be asked". The
  // engine's answer to that question is `pitDecisionPending`, and it has to be
  // true in a practice session as much as in a race.
  console.log('\nThe stop happens, and the driver is asked, in every session:');
  for (const kind of ['practice', 'qualifying', 'race'] as SessionKind[]) {
    const r = runVisit('bahrain', 'onmarks', kind);
    console.log('  ' + kind.padEnd(11) +
      ' served ' + (r.serviced ? 'yes' : 'no ') +
      '  ' + r.stationaryS.toFixed(2) + 's');
    if (!r.serviced) fail(kind + ': the car was not serviced in its box.');
  }
  {
    const def = getCircuit('bahrain');
    for (const kind of ['practice', 'qualifying', 'race'] as SessionKind[]) {
      const engine = new RaceEngine(def, {
        kind, name: 'ask', durationS: 0, laps: 5, playerIndex: 0,
        standingStart: false, pitLaneStart: false, seed: 7,
      });
      const player = engine.cars[0];
      if (engine.pitDecisionPending(player)) {
        fail(kind + ': the pit panel is being raised for a driver who has not asked to pit.');
      }
      engine.requestPit(player, true);
      if (!engine.pitDecisionPending(player)) {
        fail(kind + ': the driver called for a stop and was never asked what they wanted.');
      }
    }
  }

  // ---- The choreography ---------------------------------------------------
  console.log('\nThe choreography, one stop at Bahrain:');
  runChoreography('bahrain');

  // ---- A penalty served in the box ---------------------------------------
  console.log('\nA time penalty served in the box, held at the front of the stop:');
  penaltyHold();

  // ---- The distribution ---------------------------------------------------
  console.log('\nStationary time by crew quality (20000 stops each):');
  console.log('  crew     min    p05    p50    p90    p99    max   >3s    >5s');
  const rows: { crew: number; d: ReturnType<typeof distribution> }[] = [];
  for (const crew of [PIT_CREW_TIME_ELITE_S, 2.1, 2.3, 2.6, 2.9, PIT_CREW_TIME_POOR_S]) {
    const d = distribution(crew, 20000);
    rows.push({ crew, d });
    console.log(
      '  ' + crew.toFixed(2).padStart(4) +
      '  ' + d.min.toFixed(2).padStart(5) +
      '  ' + d.p05.toFixed(2).padStart(5) +
      '  ' + d.p50.toFixed(2).padStart(5) +
      '  ' + d.p90.toFixed(2).padStart(5) +
      '  ' + d.p99.toFixed(2).padStart(5) +
      '  ' + d.max.toFixed(2).padStart(5) +
      '  ' + (d.over3 * 100).toFixed(1).padStart(4) + '%' +
      '  ' + (d.over5 * 100).toFixed(2).padStart(5) + '%',
    );
  }

  // The crew parameter has to actually do something, monotonically.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].d.p50 <= rows[i - 1].d.p50) {
      fail('a crew at ' + rows[i].crew + 's is no slower than one at ' +
        rows[i - 1].crew + 's. The upgrade does nothing.');
    }
    if (rows[i].d.over3 < rows[i - 1].d.over3) {
      fail('a worse crew at ' + rows[i].crew + 's has FEWER stops over three seconds ' +
        'than one at ' + rows[i - 1].crew + 's.');
    }
  }

  // And it has to land where real stops land.
  const elite = rows[0].d;
  if (elite.p50 < 1.75 || elite.p50 > 2.35) {
    fail('a top crew\'s median stop is ' + elite.p50.toFixed(2) +
      's. Real ones are around 2.0-2.3s, with a 1.80s record.');
  }
  if (elite.min > 2.1) {
    fail('a top crew never produced a stop under ' + elite.min.toFixed(2) +
      's in 20000 tries. The record is 1.80s and record stops happen.');
  }
  if (elite.over3 > 0.05) {
    fail('a top crew loses ' + (elite.over3 * 100).toFixed(1) +
      '% of its stops to three seconds or more. That is a midfield crew.');
  }
  const poor = rows[rows.length - 1].d;
  if (poor.over3 < 0.03) {
    fail('the worst crew on the grid only goes over three seconds ' +
      (poor.over3 * 100).toFixed(1) + '% of the time. It has to be visibly worse.');
  }
  if (poor.max < 5) {
    fail('nothing in 20000 stops by the worst crew on the grid reached five seconds. ' +
      'A disaster stop has to be possible.');
  }

  console.log('');
  if (failures.length === 0) {
    console.log('PASS — the pit stop is a pit stop.\n');
  } else {
    console.log('FAIL — ' + failures.length + ' problem(s):');
    for (const f of failures) console.log('  * ' + f);
    console.log('');
    process.exitCode = 1;
  }
}

main();
