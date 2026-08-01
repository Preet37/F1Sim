/**
 * Does the pit limiter actually limit?
 *
 * The player's limiter is automatic — `RaceEngine.step` sets
 * `controls.pitLimiter` for the player rather than asking them to press a
 * button — so the HUD reads LIMITER ON the moment the car crosses the pit entry
 * line. What the HUD says and what the car does are different claims, and the
 * gap between them is a drive-through penalty:
 *
 *   "when you go into pit like for pit entry you have a speed limiter on but
 *    the speed of the car isn't actually reduced and thus giving some pit lane
 *    penalty"
 *
 * This probe drives the player's car at the pit entry at racing speed with the
 * throttle pinned — no manual braking whatsoever, because the player is not
 * told where the entry line is and the limiter is sold to them as automatic —
 * and measures three things:
 *
 *   1. WHEN the limiter engages, in metres relative to the pit entry line.
 *      Engaging on the line is already too late: race control judges speeding
 *      on the same step that `inPitLane` becomes true, so a limiter armed on
 *      the line loses the race against its own penalty.
 *
 *   2. HOW FAR into the lane the car is still over the limit, and the peak
 *      speed reached inside it. The limiter used to shed the excess at half a
 *      g, which from racing speed needs four hundred metres of pit lane. No
 *      circuit has one.
 *
 *   3. WHETHER a speeding penalty is issued. With an automatic limiter and an
 *      automatic pit entry, a player who did nothing wrong must not collect
 *      one.
 *
 * Monaco is in the list deliberately: its limit is 60 km/h, not 80, and a
 * limiter that hard-codes 80 passes every other circuit on the calendar while
 * being twenty over at the one that matters.
 *
 * Run: npm run probe:pitlimiter
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { TrackSpline } from '../src/track/TrackSpline';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }


/**
 * How far past the entry line the car may still be over the limit.
 *
 * Not zero: the limiter is a speed cap and not a teleport, so a car that is a
 * shade over on the line sheds the last of it in the first strides of the lane.
 * But it has to be a small fraction of the lane, because the thing at the end
 * of the lane is a stationary pit crew.
 */
const SETTLE_M = 25;

/** Race control's own tolerance, so the probe judges what it judges. */
const TOLERANCE_KPH = 0.5;

/** PROBE_TRACE=1 prints the whole approach, step by step. */
const TRACE = process.env.PROBE_TRACE === '1';

interface Result {
  circuit: string;
  limitKph: number;
  entrySpeedKph: number;
  /** Speed as the car crossed the entry line. */
  atLineKph: number;
  /** Highest speed recorded anywhere inside the lane. */
  peakInLaneKph: number;
  /**
   * Metres past the entry line at which the car was last over the limit — i.e.
   * how much pit lane the limiter needed. Zero means it was never over.
   */
  settledInM: number;
  /** Where the limiter first came on, relative to the entry line. -ve = before. */
  armedAtM: number;
  /** The car got through the lane: stopped in its box, or reached the exit. */
  completed: boolean;
  penalties: string[];
}

/**
 * The stand-in for a human at the wheel.
 *
 * This is the game's own AI controller, driving the PLAYER's car. Writing a
 * throwaway driver for the probe was tried first and it is not good enough:
 * anything that cannot get round Parabolica at 300 km/h fails the probe for
 * reasons that have nothing to do with the pit lane, and a probe that fails for
 * the wrong reason is worse than no probe. The AI can drive every circuit on
 * the calendar, which is exactly the competence a player has.
 *
 * It is given one lie, and only one: `pitThisLap` is forced FALSE in the
 * perception it reads. That keeps it out of its `PIT_APPROACH` state, so it
 * never brakes for the pit entry and never arms its own limiter — and that is
 * not a handicap invented to make the test fail, it is the situation the player
 * is actually in. The entry line is not drawn on the HUD, the limiter is
 * applied FOR the player by the race engine rather than pressed by them, and
 * the engine's own comment says managing it by hand "is tedious rather than
 * interesting". A player who has pressed PIT and kept racing is entitled to
 * arrive in the lane under the limit. If the only way to avoid a drive-through
 * is knowledge the game never gave them, the game issued that penalty, not the
 * driver.
 *
 * The engine still takes the player path for this car — `car.isPlayer` is true,
 * so `RaceEngine.step` reads `playerControls` and applies the automatic
 * limiter. That path is what is under test.
 */
class ProbeDriver {
  private readonly ai: AIVehicleController;
  /** The perception handed to the AI: the car's own, with the pit call removed. */
  private readonly view: AIPerception;

  constructor(private readonly car: CarEntry, track: TrackSpline) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    // A copy, emphatically not a reference: `car.perception.pitThisLap` is what
    // the race engine itself reads to decide the car is coming in, and writing
    // false into the real object would mean the car never enters the pit lane
    // and the probe measures nothing at all.
    this.view = { ...car.perception };
  }

  /** Writes this step's pedals and steering into the player's control block. */
  drive(dt: number, out: VehicleControls): void {
    const p = this.car.perception;
    // A shallow copy is enough: `pitThisLap` is a boolean on the object the
    // engine rebuilds each step, and everything else is read as-is.
    Object.assign(this.view, p);
    this.view.pitThisLap = false;

    const c = this.ai.update(dt, this.car.physics, this.car.s, this.car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.reverse = c.reverse;
    out.gearRequest = c.gearRequest;
    out.ersMode = c.ersMode;
    out.drsRequested = c.drsRequested;
    // Whatever the AI thinks about the limiter is not the subject. The engine
    // overwrites this for the player anyway; zeroing it here makes that
    // explicit, so a pass cannot be the AI's limiter quietly doing the work.
    out.pitLimiter = false;
  }
}

/**
 * Puts the player on the approach to the pit entry at racing speed and drives
 * it in, never touching the brakes for the entry line.
 */
function runEntry(circuitId: string): Result {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race',
    name: 'Pit limiter probe',
    durationS: 0,
    laps: 5,
    playerIndex: 0,
    standingStart: false,
    pitLaneStart: false,
    seed: 24601,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const player = engine.cars[0];

  // Everyone else is parked out of the way. This probe is about one car and one
  // stretch of road, and nineteen AI cars converging on the same pit entry is a
  // different experiment.
  for (const car of engine.cars) {
    if (car === player) continue;
    car.eliminated = true;
  }

  // 900m of approach: more than the longest braking distance from 300 km/h, so
  // the run-in is never the reason the car arrives too fast, and long enough
  // for the driver to have settled on the line before the entry.
  const startS = (pit.entryS - 900 + track.length) % track.length;
  const lineIdx = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[lineIdx], track.targetSpeed[lineIdx]);
  engine.requestPit(player, true);

  const driver = new ProbeDriver(player, track);
  const c = engine.playerControls;

  const r: Result = {
    circuit: def.name,
    limitKph: pit.speedLimitKph,
    entrySpeedKph: 0,
    atLineKph: -1,
    peakInLaneKph: 0,
    settledInM: 0,
    armedAtM: NaN,
    completed: false,
    penalties: [],
  };

  const limit = pit.speedLimitKph + TOLERANCE_KPH;
  let wasInLane = false;
  const maxSteps = Math.round(120 / PHYSICS_DT);

  for (let step = 0; step < maxSteps; step++) {
    const beforeS = player.s;
    driver.drive(PHYSICS_DT, c);
    engine.step();
    if (player.retired) break;

    // The speed the driver is actually carrying at the entry, recorded 150m
    // out. Reporting the number the case asked for would be reporting the
    // probe's intent instead of the car's behaviour.
    if (r.entrySpeedKph === 0) {
      const to = loopDelta(player.s, pit.entryS, track.length);
      if (to > 0 && to < 150) r.entrySpeedKph = player.physics.speedKph;
    }

    // Where the limiter came on, measured against the entry line. Negative is
    // before the line, which is where a driver presses the button.
    if (Number.isNaN(r.armedAtM) && player.appliedControls.pitLimiter) {
      const toEntry = loopDelta(player.s, pit.entryS, track.length);
      r.armedAtM = toEntry < track.length * 0.5 ? -toEntry : loopDelta(pit.entryS, player.s, track.length);
    }

    if (player.inPitLane) {
      const past = loopDelta(pit.entryS, player.s, track.length);
      const kph = player.physics.speedKph;
      if (!wasInLane) {
        wasInLane = true;
        r.atLineKph = kph;
      }
      r.peakInLaneKph = Math.max(r.peakInLaneKph, kph);
      // The LAST point at which the car was still over the limit, which is the
      // honest measure of how much lane the limiter needed. Taking the first
      // legal instant instead would let a car dip under, climb back over and
      // still report a good number.
      if (kph > limit) r.settledInM = past;
      if (player.inPitBox) r.completed = true;
    } else if (wasInLane) {
      r.completed = true;
      break; // Out the far end.
    }

    if (TRACE && step % 24 === 0) {
      console.log('      t=' + (step * PHYSICS_DT).toFixed(1) +
        ' s=' + player.s.toFixed(0) +
        ' toEntry=' + loopDelta(player.s, pit.entryS, track.length).toFixed(0) +
        ' lat=' + player.lateral.toFixed(1) +
        ' hw=' + track.halfWidthAt(player.s).toFixed(1) +
        ' kph=' + player.physics.speedKph.toFixed(0) +
        ' lim=' + player.appliedControls.pitLimiter +
        ' inPit=' + player.inPitLane +
        ' want=' + player.perception.pitThisLap);
    }

    // Sailed past the entry without going in. That is a result in itself, and
    // there is nothing left to measure on this lap.
    const past = loopDelta(pit.entryS, player.s, track.length);
    if (!wasInLane && past > 300 && past < track.length * 0.5) break;
    if (r.completed) break;
    void beforeS;
  }

  for (const p of player.penalties) r.penalties.push(p.kind + ': ' + p.reason);
  return r;
}

function report(r: Result): void {
  const tag = r.circuit + ' @ ' + r.entrySpeedKph.toFixed(0) + ' km/h';
  console.log(
    '  ' + tag.padEnd(34) +
    ' limit ' + String(r.limitKph).padStart(3) +
    '  at line ' + r.atLineKph.toFixed(1).padStart(6) +
    '  peak ' + r.peakInLaneKph.toFixed(1).padStart(6) +
    '  legal after ' + (r.settledInM.toFixed(0) + 'm').padStart(6) +
    '  limiter armed ' + (Number.isNaN(r.armedAtM) ? 'never' : r.armedAtM.toFixed(0) + 'm').padStart(6) +
    '  lane ' + (r.completed ? 'ok' : 'STUCK'),
  );
  for (const p of r.penalties) console.log('      penalty: ' + p);
}

function check(r: Result): void {
  const tag = r.circuit + ' @ ' + r.entrySpeedKph.toFixed(0) + 'km/h';

  // 1. The limiter must be on BEFORE the line, not on it.
  if (Number.isNaN(r.armedAtM)) {
    fail(tag + ': the pit limiter never engaged at all.');
  } else if (r.armedAtM > 0) {
    fail(tag + ': limiter engaged ' + r.armedAtM.toFixed(0) +
      'm INSIDE the pit lane. It must be armed on the approach, before the entry line.');
  }

  // 2. The car must actually be slowed, and slowed by the line.
  if (r.atLineKph > r.limitKph + TOLERANCE_KPH) {
    fail(tag + ': crossed the pit entry line at ' + r.atLineKph.toFixed(1) +
      ' km/h against a limit of ' + r.limitKph + '.');
  }
  if (r.settledInM > SETTLE_M) {
    fail(tag + ': still over the limit ' + r.settledInM.toFixed(0) +
      'm into the pit lane (peak ' + r.peakInLaneKph.toFixed(1) +
      ' km/h); budget is ' + SETTLE_M + 'm.');
  }

  // 3. And no penalty for a player who did nothing but ask to pit.
  const speeding = r.penalties.filter((p) => /speeding in the pit lane/i.test(p));
  if (speeding.length > 0) {
    fail(tag + ': ' + speeding.length + ' pit lane speeding penalty issued to a car ' +
      'whose limiter is automatic — ' + speeding[0]);
  }

  // 4. And it must still get where it was going. A limiter that stops the car
  //    dead in the entry road has not fixed anything.
  if (!r.completed) {
    fail(tag + ': the car never got through the pit lane.');
  }
}

/**
 * A car already in the pit lane cannot exceed the limit by flooring it.
 *
 * The limiter is a cap, not a suggestion, and this is the case that has nothing
 * to do with the entry: the car is inside the lane, under the limit, and the
 * driver asks for everything.
 */
function runHold(circuitId: string): { peakKph: number; limitKph: number; penalties: number } {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race', name: 'Pit limiter hold', durationS: 0, laps: 5,
    playerIndex: 0, standingStart: false, pitLaneStart: true, seed: 1337,
  };
  const engine = new RaceEngine(def, config);
  const player = engine.cars[0];
  for (const car of engine.cars) if (car !== player) car.eliminated = true;
  player.releaseTimer = 0;

  const c = engine.playerControls;
  c.throttle = 1; c.brake = 0; c.steer = 0; c.reverse = false;

  let peak = 0;
  const maxSteps = Math.round(60 / PHYSICS_DT);
  for (let step = 0; step < maxSteps; step++) {
    engine.step();
    if (!player.inPitLane) break;
    peak = Math.max(peak, player.physics.speedKph);
  }
  const speeding = player.penalties.filter((p) => /speeding in the pit lane/i.test(p.reason));
  return { peakKph: peak, limitKph: def.pitLane.speedLimitKph, penalties: speeding.length };
}

function main(): void {
  console.log('\n=== PIT LIMITER ===\n');

  console.log('Pit entry at racing speed, no braking for the entry line:');
  // Monaco is in the list deliberately — its limit is 60, not 80.
  for (const id of ['monza', 'spa', 'silverstone', 'monaco', 'suzuka', 'jeddah']) {
    const r = runEntry(id);
    report(r);
    check(r);
  }

  console.log('\nHolding the limit in the lane, throttle pinned:');
  for (const id of ['monza', 'monaco']) {
    const h = runHold(id);
    console.log(
      '  ' + id.padEnd(14) + ' limit ' + String(h.limitKph).padStart(3) +
      '  peak ' + h.peakKph.toFixed(1).padStart(6) +
      '  speeding penalties ' + h.penalties,
    );
    if (h.peakKph > h.limitKph + 2) {
      fail(id + ': car reached ' + h.peakKph.toFixed(1) +
        ' km/h in the pit lane against a limit of ' + h.limitKph + '.');
    }
    if (h.penalties > 0) {
      fail(id + ': ' + h.penalties + ' speeding penalties while sitting on the limiter.');
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log('PASS — the pit limiter limits.\n');
  } else {
    console.log('FAIL — ' + failures.length + ' problem(s):');
    for (const f of failures) console.log('  * ' + f);
    console.log('');
    process.exitCode = 1;
  }
}

main();
