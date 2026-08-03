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

/**
 * The most the limiter's own setpoint may move between two consecutive steps.
 *
 * The limiter sheds speed at a bounded rate — a full g, `PIT_LIMITER_MAX_DECEL_G`
 * — so at 120Hz it can follow about 0.08 m/s of setpoint per step. Anything much
 * above that is a number the car is chasing rather than holding, and the
 * measured defect was 22 m/s: eighty km/h in eight milliseconds. A quarter of a
 * metre per second is three times what the limiter can track and still small
 * enough to catch the class of fault.
 */
const MAX_SETPOINT_STEP_MS = 0.25;

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

/**
 * A car turning faster than this is not being measured, deg/s.
 *
 * THE FIRST VERSION OF THIS PROBE MEASURED CRASHES. It took the worst
 * single-step change in yaw rate over a whole race and reported twenty thousand
 * degrees a second — under green as well as under the safety car, at every
 * circuit — because a car that hits a barrier, is placed on the grid or spins in
 * traffic changes heading by a large fraction of a turn between two steps, and
 * one such event dominates a maximum taken over four hundred thousand of them.
 * A statistic that a single collision can set is not a measurement of a limiter.
 *
 * So: a car rotating faster than a hundred degrees a second has stopped being
 * driven and is excluded, the samples either side of any gap are not compared
 * across it, and what is reported is a high quantile rather than a maximum.
 */
const SPINNING_DEG_S = 100;

/** One regime's worth of heading history. */
class Trace {
  seconds = 0;
  reversals = 0;
  /** Worst single-step jump in the limiter's own setpoint, m/s per step. */
  worstSetpointStepMs = 0;
  /** Steps the brake pedal moved by more than half its travel. */
  pedalJumps = 0;
  samples = 0;
  /** Steps discarded because the car was spinning or the trace had a gap. */
  discarded = 0;

  private prevHeading = NaN;
  private prevRate = NaN;
  private prevBrake = NaN;
  private prevLimit = 0;
  private prevStep = -2;
  /** Every yaw-rate step seen, for the quantile. */
  private readonly yawSteps: number[] = [];

  /**
   * @param step the physics step index, so a gap in the trace is visible. Two
   *        samples either side of a pit stop are not consecutive and the change
   *        between them is not a step.
   */
  record(step: number, heading: number, brake: number, limitMs: number): void {
    this.seconds += PHYSICS_DT;
    this.samples++;
    const continuous = step === this.prevStep + 1;
    this.prevStep = step;

    if (!continuous || Number.isNaN(this.prevHeading)) {
      this.prevHeading = heading;
      this.prevRate = NaN;
      this.prevBrake = brake;
      this.prevLimit = limitMs;
      this.discarded++;
      return;
    }

    let d = heading - this.prevHeading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const rate = (d / PHYSICS_DT) * (180 / Math.PI);
    this.prevHeading = heading;

    if (Math.abs(rate) > SPINNING_DEG_S) {
      // Off the road, in a barrier or spinning. Nothing here is about a limiter.
      this.prevRate = NaN;
      this.prevBrake = brake;
      this.prevLimit = limitMs;
      this.discarded++;
      return;
    }

    if (!Number.isNaN(this.prevRate)) {
      this.yawSteps.push(Math.abs(rate - this.prevRate));
      if (Math.sign(rate) !== Math.sign(this.prevRate) &&
          Math.abs(rate) > REVERSAL_RATE_DEG_S &&
          Math.abs(this.prevRate) > REVERSAL_RATE_DEG_S) {
        this.reversals++;
      }
      if (Math.abs(brake - this.prevBrake) > 0.5) this.pedalJumps++;
      if (this.prevLimit > 0 && limitMs > 0) {
        const ds = Math.abs(limitMs - this.prevLimit);
        if (ds > this.worstSetpointStepMs) this.worstSetpointStepMs = ds;
      }
    }
    this.prevRate = rate;
    this.prevBrake = brake;
    this.prevLimit = limitMs;
  }

  get reversalsPerS(): number {
    return this.seconds > 1 ? this.reversals / this.seconds : 0;
  }

  /** The 99.9th percentile step in yaw rate, deg/s. */
  get yawStepP999(): number {
    if (this.yawSteps.length < 100) return 0;
    const sorted = this.yawSteps.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999))];
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

    // On the road. A car in the gravel changes direction for reasons that have
    // nothing to do with a limiter.
    if (Math.abs(player.lateral) > engine.track.halfWidthAt(player.s) + 0.5) continue;

    const brake = player.appliedControls.brake;
    const limit = player.appliedControls.speedLimitMs;
    if (rc.neutralisation !== 'none') {
      neutral.record(step, player.physics.heading, brake, limit);
    } else {
      green.record(step, player.physics.heading, brake, limit);
    }
  }

  return { circuit, green, neutral };
}

function line(label: string, t: Trace): string {
  return '    ' + label.padEnd(26) +
    (t.seconds.toFixed(0) + 's').padStart(7) +
    (t.reversalsPerS.toFixed(2) + '/s').padStart(10) +
    (t.yawStepP999.toFixed(2) + '°/s').padStart(11) +
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

  // THE CONTROL IS THE SAME LAPS WITHOUT THE ASSIST, not the green laps. Green
  // laps are driven at racing speed through the same corners and have more
  // steering in them per second by nature; comparing against them measures the
  // pace, not the limiter. What isolates the assist is the identical
  // neutralisation with it switched off.
  const ratio = off.neutral.reversalsPerS > 0
    ? on.neutral.reversalsPerS / off.neutral.reversalsPerS : 0;
  const yawRatio = off.neutral.yawStepP999 > 0
    ? on.neutral.yawStepP999 / off.neutral.yawStepP999 : 0;
  console.log('    ' + ('vs the same laps without the assist: ' +
    'reversals x' + ratio.toFixed(2) + ', yaw step x' + yawRatio.toFixed(2)).padStart(70));

  // A ratio of two very small numbers is noise, and under a safety car both are
  // small — a queue at 40% of racing pace barely changes direction at all. The
  // absolute rate has to be worth comparing before the comparison means
  // anything.
  const MEANINGFUL_PER_S = 0.15;
  if (off.neutral.reversalsPerS >= MEANINGFUL_PER_S && ratio > MAX_REVERSAL_RATIO) {
    fail(`${cs.circuit}: turning the assist ON multiplies the direction changes by ` +
      `x${ratio.toFixed(2)} (${on.neutral.reversalsPerS.toFixed(2)}/s against ` +
      `${off.neutral.reversalsPerS.toFixed(2)}/s over the same neutralisation) — ` +
      `it is the assist and not the neutralisation`);
  }
  if (yawRatio > MAX_REVERSAL_RATIO && on.neutral.yawStepP999 > MAX_YAW_STEP_DEG_S) {
    fail(`${cs.circuit}: with the assist on, the yaw rate's 99.9th-percentile single-step ` +
      `change is ${on.neutral.yawStepP999.toFixed(2)}°/s against ` +
      `${off.neutral.yawStepP999.toFixed(2)}°/s without it — the limiter is turning the car`);
  }
  // The direct measurement of the defect, and the one that caught it: a brake
  // pedal that moves more than half its travel between two 8ms steps.
  if (on.neutral.pedalJumps > off.neutral.pedalJumps + 10) {
    fail(`${cs.circuit}: the assist moved the brake pedal more than half its travel in one ` +
      `step ${on.neutral.pedalJumps} times (${off.neutral.pedalJumps} without it) — ` +
      `a pedal that steps like that is a pedal the car cannot absorb`);
  }
  // And the setpoint it is holding. A limiter bounded to a g cannot follow a
  // number that moves faster than a g.
  if (on.neutral.worstSetpointStepMs > MAX_SETPOINT_STEP_MS) {
    fail(`${cs.circuit}: the limiter's own setpoint moved ` +
      `${on.neutral.worstSetpointStepMs.toFixed(1)} m/s between two consecutive steps ` +
      `(limit ${MAX_SETPOINT_STEP_MS}) — the car is chasing a number that has already moved`);
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('The neutralised limiter slows the car without steering it.');
