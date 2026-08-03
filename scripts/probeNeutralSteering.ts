/**
 * "I was supposed to be limited and in that case my car swerved."
 *
 * WHAT IS BEING MEASURED. A swerve is not a matter of opinion either, and this
 * borrows `probe:reverse`'s method wholesale: it records the car's HEADING every
 * physics step and looks at how that heading is changing. A car being steered
 * through a corner turns steadily — the sign of its yaw ACCELERATION holds for
 * the length of the corner — and a car that is being fought turns one way and
 * then the other several times a second while the driver's hands have not
 * moved. So the statistic is REVERSALS: steps at which the yaw rate changes
 * sign with meaningful rate either side, counted per second, and separately the
 * worst single-step change in yaw rate.
 *
 * WHY IT IS THE LIMITER'S FAULT AND NOT THE DRIVER'S. The same driver, on the
 * same circuit, at the same seed, is measured under green and under a
 * neutralisation, and the two are compared. The driver is the game's own AI
 * (exactly as `probe:neutralplayer` does it, and for the same reason: a
 * throwaway driver that cannot get round a corner fails the probe for reasons
 * that have nothing to do with the safety car), and it is given one lie — it
 * does not know the race is neutralised — so every input it makes is a green
 * input and any difference in the car's behaviour belongs to the limiter.
 *
 * A second, sharper control: the SAME neutralised laps are run with
 * `neutralisationAssist` off. That isolates the assist from the neutralisation:
 * if the car is calm with the assist off and fighting with it on, it is the
 * assist.
 *
 * WHAT IT WOULD FAIL ON. Anything that makes the limiter's braking a thing the
 * car has to absorb rather than a thing it obeys: a pedal that chatters between
 * steps, a demand that saturates the tyres already busy cornering, or a
 * setpoint that steps faster than a car can follow.
 *
 * The circuits are chosen for corners. A neutralised lap of Monza is mostly
 * straight and a limiter can be badly wrong there without ever showing.
 *
 * Run: npm run probe:neutralsteer
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';
import type { TrackSpline } from '../src/track/TrackSpline';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/** Yaw rate either side of a sign change that counts as a real reversal, deg/s. */
const REVERSAL_RATE_DEG_S = 4;
/**
 * How much worse a neutralised lap may be than a green one before the limiter
 * is fighting the car rather than slowing it.
 *
 * A ratio rather than an absolute, because the two regimes are driven at
 * different speeds through the same corners and a slow lap has more steering
 * lock in it per metre by nature. Half as much again is generous: the reported
 * defect measured at more than four times.
 */
const MAX_REVERSAL_RATIO = 1.5;
/**
 * The most the yaw rate may change in one step, degrees per second per step.
 *
 * At 120Hz this is 300 deg/s² sustained, which is more than any car with grip
 * at all does in a corner and far less than a snap. It catches the specific
 * failure the limiter can produce — a braking demand that arrives whole in one
 * step and takes the rear axle with it — without objecting to ordinary
 * cornering.
 */
const MAX_YAW_STEP_DEG_S = 2.5;

/** A driver who does not know the race has been neutralised. */
class BlindDriver {
  private readonly ai: AIVehicleController;
  private readonly view: AIPerception;

  constructor(private readonly car: CarEntry, track: TrackSpline) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    this.view = { ...car.perception };
  }

  drive(dt: number, out: VehicleControls): void {
    Object.assign(this.view, this.car.perception);
    this.view.neutralised = false;
    this.view.neutralisedTargetMs = 0;
    this.view.neutralisedScale = 0;
    this.view.queueGapM = 0;
    this.view.queueAheadM = -1;
    this.view.safetyCarAheadM = -1;
    this.view.pitThisLap = false;

    const c = this.ai.update(dt, this.car.physics, this.car.s, this.car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.drsRequested = false;
    out.ersMode = c.ersMode;
    out.gearRequest = 0;
    out.reverse = false;
  }
}

/** One regime's worth of heading history. */
class Trace {
  seconds = 0;
  reversals = 0;
  worstYawStepDegS = 0;
  /** Worst single-step jump in the limiter's own setpoint, m/s per step. */
  worstSetpointStepMs = 0;
  /** Steps the brake pedal moved by more than half its travel. */
  pedalJumps = 0;
  samples = 0;

  private prevHeading = NaN;
  private prevRate = 0;
  private prevBrake = 0;
  private prevLimit = 0;

  /** Yaw rate in deg/s at this step, from the heading only. */
  record(heading: number, brake: number, limitMs: number): void {
    this.seconds += PHYSICS_DT;
    this.samples++;
    if (!Number.isNaN(this.prevHeading)) {
      let d = heading - this.prevHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const rate = (d / PHYSICS_DT) * (180 / Math.PI);
      const step = Math.abs(rate - this.prevRate);
      if (step > this.worstYawStepDegS) this.worstYawStepDegS = step;
      if (Math.sign(rate) !== Math.sign(this.prevRate) &&
          Math.abs(rate) > REVERSAL_RATE_DEG_S &&
          Math.abs(this.prevRate) > REVERSAL_RATE_DEG_S) {
        this.reversals++;
      }
      this.prevRate = rate;
      if (Math.abs(brake - this.prevBrake) > 0.5) this.pedalJumps++;
      if (this.prevLimit > 0 && limitMs > 0) {
        const ds = Math.abs(limitMs - this.prevLimit);
        if (ds > this.worstSetpointStepMs) this.worstSetpointStepMs = ds;
      }
    }
    this.prevHeading = heading;
    this.prevBrake = brake;
    this.prevLimit = limitMs;
  }

  get reversalsPerS(): number {
    return this.seconds > 1 ? this.reversals / this.seconds : 0;
  }
}

function stagePoint(track: TrackSpline, dangerous: boolean): number {
  let best = 0;
  let bestScore = dangerous ? -Infinity : Infinity;
  for (let i = 0; i < track.count; i += 4) {
    const v = track.targetSpeed[i];
    const s = (i / track.count) * track.length;
    const pit = track.def.pitLane;
    const from = ((s - pit.entryS) % track.length + track.length) % track.length;
    if (from < track.length * 0.5 &&
        ((pit.exitS - s) % track.length + track.length) % track.length < track.length * 0.5) {
      continue;
    }
    if (dangerous ? v > bestScore : v < bestScore) { bestScore = v; best = s; }
  }
  return best;
}

interface Run {
  circuit: string;
  green: Trace;
  neutral: Trace;
}

function run(circuit: string, laps: number, seed: number, assist: boolean): Run {
  const def = getCircuit(circuit);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    playerIndex: 0, standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config);
  engine.neutralisationAssist = assist;
  const rc = engine.raceControl;
  const player = engine.cars[0];
  const driver = new BlindDriver(player, engine.track);
  const c = engine.playerControls;

  const green = new Trace();
  const neutral = new Trace();

  let victim: CarEntry | null = null;
  let staged = 0;
  let stage = 0;

  const maxSteps = Math.round(laps * def.referencePoleTimeS * 4 / PHYSICS_DT);
  for (let step = 0; step < maxSteps && !engine.over; step++) {
    driver.drive(PHYSICS_DT, c);
    engine.step();

    if (stage < 3 && !victim && engine.time > 45 + stage * 5 &&
        rc.neutralisation === 'none' && rc.activeIncidents === 0) {
      const running = engine.standings.filter(
        (x) => !x.retired && !x.inPitLane && !x.isPlayer);
      const cand = running[running.length - 1];
      if (cand) {
        victim = cand;
        staged = engine.time;
        const s = stagePoint(engine.track, stage % 2 === 1);
        cand.retire('Probe: staged incident', engine.time);
        cand.s = s;
        cand.lateral = engine.track.halfWidthAt(s) + 1.6;
        cand.physics.velocity.set(0, 0);
        cand.physics.localVelX = 0;
        cand.physics.localVelY = 0;
        stage++;
      }
    }
    if (victim && engine.time - staged < 150) {
      victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
      victim.recovery.elapsedS = 0;
    } else if (victim && engine.time - staged >= 150) {
      victim = null;
    }

    if (player.retired || player.inPitLane || !engine.started) continue;
    // A car that is not moving has no heading worth reading, and a car below
    // walking pace produces enormous yaw rates for millimetres of travel.
    if (player.physics.speedMs < 12) continue;

    const brake = player.appliedControls.brake;
    const limit = player.appliedControls.speedLimitMs;
    if (rc.neutralisation !== 'none') {
      neutral.record(player.physics.heading, brake, limit);
    } else {
      green.record(player.physics.heading, brake, limit);
    }
  }

  return { circuit, green, neutral };
}

function line(label: string, t: Trace): string {
  return '    ' + label.padEnd(26) +
    (t.seconds.toFixed(0) + 's').padStart(7) +
    (t.reversalsPerS.toFixed(2) + '/s').padStart(10) +
    (t.worstYawStepDegS.toFixed(2) + '°/s').padStart(11) +
    ('  pedal jumps ' + t.pedalJumps).padStart(18) +
    ('  setpoint step ' + t.worstSetpointStepMs.toFixed(1) + 'm/s').padStart(26);
}

console.log('\nDOES THE NEUTRALISED LIMITER FIGHT THE DRIVER?');
console.log('  (heading recorded every physics step; a reversal is the yaw rate');
console.log('   changing sign with more than ' + REVERSAL_RATE_DEG_S + '°/s either side)\n');
console.log('    ' + 'regime'.padEnd(26) + 'time'.padStart(7) + 'reversals'.padStart(10) +
  'worst step'.padStart(11) + '            pedal' + '                setpoint');

const CASES: { circuit: string; laps: number; seed: number }[] = [
  { circuit: 'monaco', laps: 8, seed: 4101 },
  { circuit: 'zandvoort', laps: 6, seed: 4102 },
  { circuit: 'suzuka', laps: 5, seed: 4103 },
];

for (const cs of CASES) {
  const on = run(cs.circuit, cs.laps, cs.seed, true);
  const off = run(cs.circuit, cs.laps, cs.seed, false);

  console.log('\n  ' + cs.circuit);
  console.log(line('green', on.green));
  console.log(line('neutralised, assist on', on.neutral));
  console.log(line('neutralised, assist off', off.neutral));

  if (on.neutral.seconds < 20) {
    fail(`${cs.circuit}: no neutralisation lasted long enough to measure`);
    continue;
  }

  const ratio = on.green.reversalsPerS > 0
    ? on.neutral.reversalsPerS / on.green.reversalsPerS : 0;
  console.log('    ' + ('reversal ratio vs green  x' + ratio.toFixed(2)).padStart(38));

  if (ratio > MAX_REVERSAL_RATIO) {
    fail(`${cs.circuit}: the limited car changes direction x${ratio.toFixed(2)} as often as ` +
      `the same driver under green (${on.neutral.reversalsPerS.toFixed(2)}/s vs ` +
      `${on.green.reversalsPerS.toFixed(2)}/s) — the limiter is fighting the car`);
  }
  if (on.neutral.worstYawStepDegS > MAX_YAW_STEP_DEG_S) {
    fail(`${cs.circuit}: the limited car's yaw rate jumped ` +
      `${on.neutral.worstYawStepDegS.toFixed(2)}°/s in a single step ` +
      `(limit ${MAX_YAW_STEP_DEG_S}) — something arrived whole instead of building`);
  }
  // The assist is the suspect, so it is named: if the car is calm without it
  // and fighting with it, the neutralisation is not what is doing this.
  if (off.neutral.seconds > 20 && off.neutral.reversalsPerS > 0 &&
      on.neutral.reversalsPerS > off.neutral.reversalsPerS * MAX_REVERSAL_RATIO) {
    fail(`${cs.circuit}: turning the assist ON multiplies the direction changes by ` +
      `x${(on.neutral.reversalsPerS / off.neutral.reversalsPerS).toFixed(2)} — ` +
      `it is the assist and not the neutralisation`);
  }
  if (on.neutral.pedalJumps > off.neutral.pedalJumps + 10) {
    fail(`${cs.circuit}: the assist moved the brake pedal more than half its travel in one ` +
      `step ${on.neutral.pedalJumps} times (${off.neutral.pedalJumps} without it) — ` +
      `a pedal that steps like that is a pedal the car cannot absorb`);
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('The neutralised limiter slows the car without steering it.');
