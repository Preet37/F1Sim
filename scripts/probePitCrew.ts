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
import { pitLaneGeometry } from '../src/track/PitGeometry';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';
import {
  PIT_CREW, PIT_CREW_SIZE, PIT_CREW_TIME_ELITE_S, PIT_CREW_TIME_POOR_S,
  WHEEL_CORNERS, makePitStopProgress, pitStopProgress, resolvePitStop,
} from '../src/race/PitStopChoreography';
import {
  CREW_BUILD_STOCK, CREW_DETAIL_HIGH, POSTURES, crewBuild, mergeCrewFigure,
  type CrewBuild, type Posture, type PostureName,
} from '../src/render/CrewFigure';
import {
  drawCrewFigure, figureSignature, fromGeometry, measureFigure,
} from './lib/crewGeom';

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
// Twenty cars in one pit lane
// ===========================================================================

/**
 * Car-to-car separation in the pit lane, over a whole qualifying segment.
 *
 *   "you didn't fix the phasing cars issue in the pit"  — issue #75
 *
 * WHY THIS PROBE OWNS IT. This file's question 2 is containment: is the car
 * inside the lane, measured against the pit wall and the garage frontage. That
 * is car-versus-WALL. Car-versus-CAR is the same measurement with a different
 * other body, and nothing in the project made it. `probe:pitstop`,
 * `probe:pitlimiter` and this probe's own `runVisit` all open with
 *
 *     for (const car of engine.cars) if (car !== player) car.eliminated = true;
 *
 * so every existing pit-lane measurement is taken in an EMPTY pit lane, and
 * `audit:pitlane` photographs one serviced car. `probe:traffic` §1 does stage a
 * queue, but it hand-places four cars at `pitLaneStart: false`. Nothing
 * anywhere had ever run the real thing: the twenty-car `pitLaneStart` grid that
 * every practice and qualifying session in the game actually begins with.
 *
 * WHAT IT MEASURES. Every pair of cars that is physically in the pit lane —
 * every fourth step, against the same three-disc body the engine collides with.
 * A gap below one car width is two cars occupying the same ground, which is
 * what the player sees as phasing.
 *
 * "IN THE PIT LANE" IS ASKED OF THE GROUND, NOT OF `car.inPitLane`, and that is
 * the whole design of this section. `sittingOut`, `inPitBox` and `inPitLane`
 * are the flags that decide whether `resolveContacts` bothers with a pair, so
 * choosing pairs by them would be asking the engine whether it agrees with
 * itself — and worse, a "fix" that cleared `inPitLane` on a car it left parked
 * in the middle of the lane would empty the pair set and turn this green while
 * the player still drove through it. So a car is in the lane when it is
 * standing between the pit wall and the garage frontage, at a lap distance the
 * lane covers, and the flag is then checked against that answer separately.
 *
 * Q1 and Q2 are both run because they are different scenes. Q1 releases twenty
 * runners and nobody is parked; Q2 releases fifteen past five cars that are out
 * of the session and are standing in the lane for the whole segment.
 */

/** The same three discs `resolveContacts` uses: radius 1.0m at ±1.85m and 0. */
const LANE_DISC_R = 1.0;
const LANE_DISC_OFF = [1.85, 0, -1.85];
/** Below this the bodywork of the two cars is sharing ground. */
const LANE_TOUCH_M = LANE_DISC_R * 2;

function laneBodyGapM(a: CarEntry, b: CarEntry): number {
  const aS = Math.sin(a.physics.heading), aC = Math.cos(a.physics.heading);
  const bS = Math.sin(b.physics.heading), bC = Math.cos(b.physics.heading);
  let best = Infinity;
  for (const oa of LANE_DISC_OFF) {
    const ax = a.physics.position.x + aS * oa;
    const az = a.physics.position.y + aC * oa;
    for (const ob of LANE_DISC_OFF) {
      const d = Math.hypot(
        b.physics.position.x + bS * ob - ax,
        b.physics.position.y + bC * ob - az,
      );
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * The five cars knocked out of Q1, as car indices.
 *
 * Scattered rather than the last five, and that matters: `pitSlot` is the car
 * index, so eliminating 15..19 would park every absentee at one end of the row
 * and a runner leaving from slot 0 would never pass one. Real knockouts are
 * interleaved through the row and a released car drives past them.
 */
const OUT_OF_Q1 = [2, 5, 9, 13, 18];

interface LaneSpacing {
  circuit: string;
  segment: string;
  /** Cars standing in the lane when the session opens. */
  inLaneAtStart: number;
  /** Cars entitled to run the segment. */
  runners: number;
  /** Closest body-to-body approach between any two cars in the lane. */
  worstGapM: number;
  /** ...and who, where, and when. */
  worstReport: string;
  /** Samples at which two bodies were sharing ground. */
  overlaps: number;
  /** Samples at which `inPitLane` disagreed with where the car was standing. */
  flagDisagreements: number;
  flagReport: string;
}

function pitLaneSpacing(circuitId: string, segment: 'Q1' | 'Q2', durationS: number): LaneSpacing {
  const def = getCircuit(circuitId);
  const isQ2 = segment === 'Q2';
  const participants = isQ2
    ? [...Array(20).keys()].filter((i) => !OUT_OF_Q1.includes(i))
    : undefined;
  const engine = new RaceEngine(def, {
    kind: 'qualifying', name: segment, durationS, laps: 0, playerIndex: -1,
    standingStart: false, pitLaneStart: true, seed: 8801,
    qualifyingPhase: isQ2 ? 2 : 1, advancing: isQ2 ? 10 : 15,
    participants,
  });

  const g = pitLaneGeometry(def, engine.track.length);
  /** How far outboard of the fast lane's centreline a car is standing. */
  const outboard = (car: CarEntry): number => Math.abs(car.lateral) - g.centre;
  /**
   * Is this car standing IN the pit lane, as a question about the ground?
   *
   * Between the pit wall and the garage frontage, at a lap distance the lane
   * covers. Half a car width of slack at each edge, so a car with a wheel over
   * a line still counts as being in the lane it is driving down.
   */
  const inTheLane = (car: CarEntry): boolean => {
    if (!g.covers(car.s)) return false;
    const mag = Math.abs(car.lateral);
    return mag >= g.laneInner - LANE_DISC_R && mag <= g.garageFace + LANE_DISC_R;
  };

  const inLaneAtStart = engine.cars.filter(inTheLane).length;
  const runners = engine.participants.filter((c) => !c.sittingOut).length;

  let worstGapM = Infinity;
  let worstReport = '';
  let overlaps = 0;
  let flagDisagreements = 0;
  let flagReport = '';
  const steps = Math.round(durationS / PHYSICS_DT);
  for (let i = 0; i < steps && !engine.over; i++) {
    engine.step();
    // Every fourth step. At 8ms a car under the 80km/h limiter covers 18cm, so
    // a pass this misses is not a pass that could have overlapped anything.
    if (i % 4 !== 0) continue;
    const inLane = engine.cars.filter(inTheLane);
    // The flag has to describe the ground. A car standing in the lane whose
    // `inPitLane` is false is invisible to every rule in the engine that is
    // written on that flag — including the pit-wall test in `resolveContacts`.
    // Only checked for cars that are stopped: a car crossing the pit entry or
    // merging at the exit is legitimately mid-transition for a few steps.
    for (const car of engine.cars) {
      if (car.physics.speedMs > 0.5) continue;
      if (inTheLane(car) === car.inPitLane) continue;
      flagDisagreements++;
      if (flagReport) continue;
      flagReport =
        `${car.driver.code} is standing ${outboard(car).toFixed(1)}m outboard of the fast ` +
        `lane at s=${car.s.toFixed(0)}m with inPitLane=${car.inPitLane}`;
    }
    for (let a = 0; a < inLane.length; a++) {
      for (let b = a + 1; b < inLane.length; b++) {
        const gap = laneBodyGapM(inLane[a], inLane[b]);
        if (gap < LANE_TOUCH_M) overlaps++;
        if (gap >= worstGapM) continue;
        worstGapM = gap;
        const ca = inLane[a], cb = inLane[b];
        worstReport =
          `${ca.driver.code} (${ca.physics.speedMs * 3.6 < 1 ? 'stopped' : 'moving'}, ` +
          `${outboard(ca).toFixed(1)}m outboard, box ${ca.pitSlot}, ` +
          `sittingOut=${ca.sittingOut} inPitBox=${ca.inPitBox}) and ` +
          `${cb.driver.code} (${cb.physics.speedMs * 3.6 < 1 ? 'stopped' : 'moving'}, ` +
          `${outboard(cb).toFixed(1)}m outboard, box ${cb.pitSlot}, ` +
          `sittingOut=${cb.sittingOut} inPitBox=${cb.inPitBox}) ` +
          `at t=${(i * PHYSICS_DT).toFixed(1)}s`;
      }
    }
  }

  return {
    circuit: circuitId, segment, inLaneAtStart, runners,
    worstGapM, worstReport, overlaps, flagDisagreements, flagReport,
  };
}

/**
 * A driver who does nothing at all, in the first garage.
 *
 *   "Monza, practice and qualifying: with the player sitting idle in the first
 *    garage, 0 of 20 cars leave the pit lane after fifteen minutes."  — #83
 *
 * A whole-session deadlock reachable by doing nothing, which is what a player
 * does while reading the setup screen.
 *
 * The staging is the whole test and it has to be exact. `pitSlot` is the car
 * index and box 0 is the box NEAREST THE PIT EXIT, so the player at index 0 is
 * parked at the head of the queue with nineteen cars behind them: every single
 * car in the session has to get past that one car to leave. Nothing is written
 * to `engine.playerControls`, so the car sits at zero throttle — which is not a
 * contrivance, it is what the engine does for a player who has not touched a
 * key, and PROJECT.md §4 records the same omission silently disabling
 * `probe:hudtext` for weeks.
 *
 * PRACTICE IS RUN AS WELL AS QUALIFYING, and that is what separates this from
 * the parked-eliminated-car fault above: a practice session has no
 * `participants` list, so nobody is `sittingOut` and there is nothing parked in
 * the lane at all. If practice deadlocks too, the cause is where the RUNNERS
 * are placed, not where the absentees are.
 */
function idlePlayerInTheFirstGarage(
  circuitId: string, kind: SessionKind, durationS: number,
): { left: number; others: number; stillInLane: number; playerOutboard: number } {
  const def = getCircuit(circuitId);
  const engine = new RaceEngine(def, {
    kind, name: 'idle', durationS, laps: 0, playerIndex: 0,
    standingStart: false, pitLaneStart: true, seed: 8302,
  });
  const g = pitLaneGeometry(def, engine.track.length);
  const player = engine.cars[0];

  // Deliberately never written: `engine.playerControls` stays at its default,
  // which is no throttle, no brake, no steering. The player is in the car and
  // is not driving it.
  const steps = Math.round(durationS / PHYSICS_DT);
  for (let i = 0; i < steps && !engine.over; i++) engine.step();

  const others = engine.cars.filter((c) => c !== player);
  return {
    left: others.filter((c) => c.leftThePits).length,
    others: others.length,
    stillInLane: others.filter((c) => c.inPitLane).length,
    playerOutboard: Math.abs(player.lateral) - g.centre,
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

// ===========================================================================
// What a crew member is made of  (issue #24)
// ===========================================================================

/**
 *   "the whole pitstop system needs to be a little revamped and re-rendered,
 *    the people are like legos, not how a pitstop really works."
 *
 * The pit-stop work before this one rebuilt the TORSO — three chamfered boxes
 * became oval sections with ball shoulders and a wrapped visor — and said, in
 * its own report, that it had not answered the complaint: *"all 21 are an
 * identical build in flat team colour"*, with per-person variety and one-knee-
 * down poses explicitly not done. This section is the measurement of that
 * sentence, and it is measured off the DRAWN TRIANGLES, never off the rig. See
 * the note at the top of `scripts/lib/crewGeom.ts` for why that distinction is
 * the whole design.
 *
 * `CREW_LEGACY=1` runs it against the figure exactly as it shipped: the stock
 * build for all twenty-one, and every posture's `kneel` and `asymArm` forced to
 * zero, which together IS the old `poseCrew` — one build, one flat colour, and
 * a pose mirrored about x = 0. Nothing test-only is left in `src/` for it; the
 * old figure is reproduced by feeding the new one its own neutral inputs.
 */
const CREW_LEGACY = process.env.CREW_LEGACY === '1';

/** The postures the choreography actually puts the twenty-one crew into. */
const WORKING_POSTURES: PostureName[] = ['ready', 'gun', 'fit', 'carry', 'jack', 'stand'];

/** The postures a person is meant to be down on one knee in. */
const KNEELING_POSTURES: PostureName[] = ['ready', 'gun'];

/**
 * How far apart the two legs' material has to sit before it counts as one knee
 * down, metres.
 *
 * Not a tolerance on an existing measurement — it is the definition of the
 * thing being counted. A knee on the ground and a foot on the ground put one
 * leg's mass at ankle height and the other's spread up to a raised knee, and
 * eight centimetres of difference in the mean is well below what that produces
 * and well above the couple of millimetres that anything short of a real kneel
 * can reach.
 */
const KNEEL_DROP_M = 0.08;

/** McLaren papaya — a real team colour off the roster's own palette. */
const TEAM_COLOUR = 0xff8000;

function posture(name: PostureName): Posture {
  const p: Posture = { ...POSTURES[name] };
  if (CREW_LEGACY) { p.kneel = 0; p.asymArm = 0; }
  return p;
}

function buildFor(i: number): CrewBuild {
  return CREW_LEGACY ? CREW_BUILD_STOCK : crewBuild(i + 1);
}

function crewAnatomy(): void {
  const n = PIT_CREW_SIZE;

  // ---- 1. Twenty-one people, or one person twenty-one times ---------------
  //
  // Stature is measured STANDING, because the bounding box of a crouching
  // figure is how low the crouch is and not how tall the person is — the first
  // version of this measured `ready` and reported a crew of 1.38m adults.
  // Everything else is measured in `ready`, which is the posture the whole crew
  // is in while the car comes down the lane and the shot the player gets time
  // to look at.
  const ready = posture('ready');
  const stand = posture('stand');
  const m = [];
  const heights: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = buildFor(i);
    m.push(measureFigure(drawCrewFigure(ready, b, CREW_DETAIL_HIGH, TEAM_COLOUR)));
    heights.push(measureFigure(drawCrewFigure(stand, b, CREW_DETAIL_HIGH, TEAM_COLOUR)).heightM);
  }
  const areas = m.map((x) => x.areaM2);
  const signatures = new Set(m.map(figureSignature));
  const hSpread = Math.max(...heights) - Math.min(...heights);
  const aRatio = Math.max(...areas) / Math.min(...areas);

  console.log('  distinct figures on screen   ' + signatures.size + ' of ' + n);
  console.log('  stature, standing            ' +
    Math.min(...heights).toFixed(2) + '-' + Math.max(...heights).toFixed(2) +
    'm  (spread ' + (hSpread * 100).toFixed(1) + 'cm)');
  console.log('  drawn surface per figure     ' +
    Math.min(...areas).toFixed(2) + '-' + Math.max(...areas).toFixed(2) +
    'm2  (ratio ' + aRatio.toFixed(2) + ')');

  if (signatures.size < 12) {
    fail('the twenty-one crew draw as ' + signatures.size + ' distinct figures. ' +
      'A pit crew is twenty-one people, and a row of identical figures is what ' +
      '"the people are like legos" describes — the giveaway is not that a piece ' +
      'is blocky, it is that every piece is the same piece.');
  }
  if (hSpread < 0.10) {
    fail('the tallest crew member is ' + (hSpread * 100).toFixed(1) +
      'cm taller than the shortest. Adult stature spans about 22cm across the ' +
      '5th to 95th percentile and `reference/target/89.png` shows two people ' +
      'in race kit who are visibly not the same height.');
  }
  if (aRatio < 1.12) {
    fail('the heaviest crew member draws ' + aRatio.toFixed(2) +
      'x the surface of the lightest. They are all the same build.');
  }

  // ---- 2. Somebody is down on one knee ------------------------------------
  //
  // The asymmetry numbers are the ones that cannot be argued with: a pose
  // mirrored about x = 0 scores EXACTLY zero on both of them, on every figure,
  // in every posture, for ever.
  console.log('  posture   asym z    asym y   leg aft  L / R    one-knee figures');
  for (const name of WORKING_POSTURES) {
    const p = posture(name);
    let worstZ = 0;
    let worstY = 0;
    let kneeling = 0;
    let sideL = 0;
    let sideR = 0;
    let legSample: [number, number] = [0, 0];
    for (let i = 0; i < n; i++) {
      const a = measureFigure(drawCrewFigure(p, buildFor(i), CREW_DETAIL_HIGH, TEAM_COLOUR));
      worstZ = Math.max(worstZ, a.asymZM);
      worstY = Math.max(worstY, a.asymYM);
      const drop = Math.abs(a.legAftM[0] - a.legAftM[1]);
      if (drop >= KNEEL_DROP_M) {
        kneeling++;
        if (a.legAftM[0] < a.legAftM[1]) sideL++; else sideR++;
      }
      if (i === 0) legSample = a.legAftM;
    }
    console.log('  ' + name.padEnd(9) +
      worstZ.toFixed(3) + 'm  ' + worstY.toFixed(3) + 'm   ' +
      legSample[0].toFixed(2) + ' / ' + legSample[1].toFixed(2) + 'm       ' +
      kneeling + ' of ' + n + (kneeling > 0 ? '  (' + sideL + ' left, ' + sideR + ' right)' : ''));

    if (worstZ < 0.02 && worstY < 0.02) {
      fail('every crew figure in the "' + name + '" posture is MIRROR-SYMMETRIC — ' +
        'left/right disagreement ' + worstZ.toFixed(3) + 'm fore-aft and ' +
        worstY.toFixed(3) + 'm in height, on all ' + n + '. Nobody stands like ' +
        'that, and a whole crew standing like it is the second half of "lego people".');
    }
    if (KNEELING_POSTURES.includes(name)) {
      if (kneeling < n) {
        fail('only ' + kneeling + ' of ' + n + ' crew are down on one knee in the "' +
          name + '" posture — the two legs\' material sits within ' +
          (KNEEL_DROP_M * 100).toFixed(0) + 'cm of the same height on the rest. Every ' +
          'reference photograph of a crew set and waiting has them on one knee, and ' +
          'this posture\'s own comment already said "often on one knee".');
      }
      if (sideL === 0 || sideR === 0) {
        fail('all ' + kneeling + ' kneeling crew in "' + name + '" are down on the ' +
          'SAME knee. Which knee is a property of the person, not of the job.');
      }
    }
  }

  // ---- 3. The kit is not one flat colour ----------------------------------
  //
  // Chromaticity, not colour. The per-vertex weight multiplies the instance
  // colour, so a figure drawn from one instance colour is one HUE at five
  // brightnesses however many weights it carries — boots, gloves, visor and all
  // in the team's own colour, which is not a thing any team's kit does.
  const chromas = m.map((x) => x.chromas);
  const palettes = new Set(m.map((x) => x.bandChroma));
  const median = [...chromas].sort((a, b) => a - b)[Math.floor(n / 2)];
  console.log('  chromaticities per figure    ' +
    Math.min(...chromas) + '-' + Math.max(...chromas) + ' (median ' + median + ')' +
    ', ' + palettes.size + ' distinct colour layouts across the crew');
  if (median < 2) {
    fail('the median crew member is drawn in ' + median +
      ' chromaticity — every part of them, boots and gloves and visor included, ' +
      'is the team colour at a different brightness. That is a silhouette, not a kit.');
  }
  if (palettes.size < 4) {
    fail('the whole crew draws ' + palettes.size + ' distinct colour layout(s) — the ' +
      'same colours in the same places on everybody. Real kit varies person to ' +
      'person, on the sleeves, the lower legs and the helmet, and ' +
      '`reference/target/89.png` is two people in one paddock in visibly ' +
      'different suits.');
  }

  // ---- 4. The two paths still describe the same person --------------------
  //
  // `CrewFigure`'s opening note: "A change to the proportions changes both,
  // which is the whole point." Asserted rather than asserted-in-a-comment. The
  // paddock's merged figure and the pit lane's instanced one are built from the
  // same parts, the same matrices and the same colours, so for one (posture,
  // build) they have to measure the same.
  let worstDelta = 0;
  for (let i = 0; i < n; i += 4) {
    const b = buildFor(i);
    const inst = measureFigure(drawCrewFigure(ready, b, CREW_DETAIL_HIGH, TEAM_COLOUR));
    const merged = mergeCrewFigure(ready, TEAM_COLOUR, CREW_DETAIL_HIGH, b);
    const stat = measureFigure(fromGeometry(merged));
    merged.dispose();
    worstDelta = Math.max(
      worstDelta,
      Math.abs(inst.heightM - stat.heightM),
      Math.abs(inst.areaM2 - stat.areaM2),
      Math.abs(inst.asymZM - stat.asymZM),
    );
    if (inst.bandChroma !== stat.bandChroma) {
      fail('the paddock draws crew member ' + i + ' in a different colour layout from ' +
        'the pit lane: ' + stat.bandChroma + ' against ' + inst.bandChroma);
    }
  }
  console.log('  merged vs instanced figure   worst difference ' + worstDelta.toFixed(4));
  if (worstDelta > 0.005) {
    fail('the paddock\'s merged figure and the pit lane\'s instanced one differ by ' +
      worstDelta.toFixed(4) + '. They are meant to be the same person built two ways.');
  }
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

  // ---- What a crew member is made of (issue #24) --------------------------
  console.log('\nWhat a crew member is made of' +
    (CREW_LEGACY ? '  [CREW_LEGACY=1 — the figure as it shipped]' : '') + ':');
  crewAnatomy();
  // The anatomy section is pure geometry in node and runs in about a second;
  // the rest of this file drives the engine round three circuits and takes ten
  // minutes. `CREW_ONLY=1` is for iterating on the figure without paying for
  // that, and it is not a way to run less of the probe — it exits 1 on failure
  // exactly as the full run does.
  if (process.env.CREW_ONLY === '1') { report(); return; }

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

  // ---- An idle player in the first garage --------------------------------
  //
  // Fifteen minutes, which is what the issue reports, on three circuits and in
  // both session kinds that start in the lane.
  console.log('\nAn idle player in the first garage (#83):');
  console.log('  circuit       kind         left the pits   still in the lane   player is');
  for (const circuitId of ['monza', 'monaco', 'bahrain']) {
    for (const kind of ['practice', 'qualifying'] as SessionKind[]) {
      const r = idlePlayerInTheFirstGarage(circuitId, kind, 900);
      console.log(
        '  ' + circuitId.padEnd(12) +
        '  ' + kind.padEnd(11) +
        '  ' + (r.left + ' of ' + r.others).padStart(13) +
        '  ' + String(r.stillInLane).padStart(17) +
        '  ' + r.playerOutboard.toFixed(1) + 'm outboard');
      if (r.left < r.others) {
        fail(circuitId + ' ' + kind + ': the player sat still in the first garage and only ' +
          r.left + ' of ' + r.others + ' other cars left the pit lane in ' +
          '15 minutes (' + r.stillInLane + ' still in it at the flag). A driver who does ' +
          'nothing must not be able to stop the session happening.');
      }
    }
  }

  // ---- Twenty cars in one pit lane ---------------------------------------
  //
  // Monaco's lane is the tightest on the calendar and Bahrain's is one of the
  // longest, so they lay the same twenty boxes out over very different ground;
  // Monza is a third shape again. Checking one of them is how every pit-lane
  // claim in this project has been shipped broken before (§3.5).
  console.log('\nTwenty cars in one pit lane (closest body-to-body approach):');
  console.log('  circuit       seg  in lane  runners   worst gap   overlapping samples');
  for (const circuitId of ['monaco', 'bahrain', 'monza']) {
    for (const segment of ['Q1', 'Q2'] as const) {
      const r = pitLaneSpacing(circuitId, segment, segment === 'Q1' ? 540 : 480);
      console.log(
        '  ' + r.circuit.padEnd(12) +
        '  ' + r.segment +
        '  ' + String(r.inLaneAtStart).padStart(7) +
        '  ' + String(r.runners).padStart(7) +
        '  ' + (r.worstGapM === Infinity ? '  n/a' : r.worstGapM.toFixed(2).padStart(9) + 'm') +
        '  ' + String(r.overlaps).padStart(19));
      if (r.overlaps > 0) {
        fail(r.circuit + ' ' + r.segment + ': two cars shared the same ground in the pit lane ' +
          'on ' + r.overlaps + ' samples — closest ' + r.worstGapM.toFixed(2) + 'm between ' +
          'bodies that are ' + LANE_TOUCH_M.toFixed(1) + 'm wide. ' + r.worstReport);
      }
      // The lane holds the cars that are IN the session and nothing else. A
      // car knocked out in an earlier segment is not one of them: Art. B2.4.3
      // classifies it on the lap it set in the period it ran, and it takes no
      // further part. Counted here rather than only in `probe:qualiboard`
      // because what the player reported was a COUNT OF CARS IN THE PIT LANE.
      if (r.inLaneAtStart !== r.runners) {
        fail(r.circuit + ' ' + r.segment + ': ' + r.inLaneAtStart + ' cars are standing in the ' +
          'pit lane at the start of a segment that ' + r.runners + ' cars are entitled to run.');
      }
      if (r.flagDisagreements > 0) {
        fail(r.circuit + ' ' + r.segment + ': `inPitLane` disagreed with where a stopped car ' +
          'was standing on ' + r.flagDisagreements + ' samples — ' + r.flagReport);
      }
    }
  }

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

  report();
}

function report(): void {
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
