/**
 * TEMPORARY DIAGNOSTIC — not a probe. Finds the mechanism behind the standstill
 * measured in issue #26: cars stopping dead under a neutralisation on clear
 * road. Deleted once the cause is known.
 */
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import { loopDelta } from '../src/core/MathUtils';
import { corneringSpeedLimitMs } from '../src/ai/AIVehicleController';

const world = createWorld(20260801);
installWorld(world);

const circuitId = process.env.DIAG_TRACK ?? 'silverstone';
const laps = Number(process.env.DIAG_LAPS ?? 52);
const seed = Number(process.env.DIAG_SEED ?? 1);
const tier = (process.env.DIAG_TIER ?? 'F3') as TierId;

const def = getCircuit(circuitId);
const field = raceSeats(world, tier).map(toDriver);
const config: SessionConfig = {
  kind: 'race', name: 'Grand Prix', durationS: 0, laps,
  aiDifficulty: 'medium', playerIndex: -1,
  standingStart: true, pitLaneStart: false, seed,
};
const engine = new RaceEngine(def, config, field);
const len = engine.track.length;

const CLEAR_M = 60;
const STOPPED_MS = 2.5;
let stalledCarS = 0;
let neutralSteps = 0;
let steps = 0;
const SAMPLE = 12; // 10Hz
const samples: string[] = [];
const reasons = new Map<string, number>();

const maxSteps = Math.round((laps * def.referencePoleTimeS * 4.5 + 600) / PHYSICS_DT);
while (!engine.over && steps < maxSteps) {
  engine.step();
  steps++;
  const rc = engine.raceControl;
  const neutral = rc.neutralisation !== 'none';
  if (neutral) neutralSteps++;
  if (steps % SAMPLE !== 0 || !neutral) continue;

  for (const car of engine.cars) {
    if (car.retired || car.inPitLane || car.finished) continue;
    if (car.physics.speedMs > STOPPED_MS) continue;
    // Anything within CLEAR_M ahead on the road?
    let nearest = Infinity;
    for (const o of engine.cars) {
      if (o === car || o.retired || o.inPitLane) continue;
      const d = loopDelta(car.s, o.s, len);
      if (d > 0 && d < nearest) nearest = d;
    }
    if (rc.scOnTrack) {
      const d = loopDelta(car.s, rc.scS, len);
      if (d > 0 && d < nearest) nearest = d;
    }
    if (nearest <= CLEAR_M) continue;

    stalledCarS += SAMPLE * PHYSICS_DT;
    const p = car.perception;
    const ph = car.physics;
    const key = [
      rc.neutralisation,
      'ai=' + (car.ai ? car.ai.stateLabel : '-'),
      'thr=' + car.appliedControls.throttle.toFixed(2),
      'brk=' + car.appliedControls.brake.toFixed(2),
      'gear=' + ph.gear,
      'rpm=' + ph.rpm.toFixed(0),
      'trac=' + ph.tractionLimitFraction.toFixed(2),
      'gripF=' + ph.frontTires.grip.toFixed(3),
      'gripR=' + ph.rearTires.grip.toFixed(3),
      'wearF=' + ph.frontTires.wear.toFixed(2),
      'tempF=' + ph.frontTires.tempC.toFixed(0),
      'corner=' + corneringSpeedLimitMs(engine.track, ph, car.s).toFixed(1),
      'line=' + engine.track.targetSpeed[engine.track.indexAt(car.s)].toFixed(1),
      'cap=' + rc.vscTargetMs.toFixed(0),
      'scale=' + rc.neutralisedScale.toFixed(2),
      'off=' + (car.offTrackNow ? 'y' : 'n'),
      'wet=' + p.wetness.toFixed(2),
      'dirty=' + ph.dirtyAirDownforceMult.toFixed(2),
    ].join(' ');
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    if (samples.length < 60) {
      samples.push(
        `t=${engine.time.toFixed(0)}s lap=${car.lap} car=${car.index} s=${car.s.toFixed(0)} ` +
        `lat=${car.lateral.toFixed(2)} v=${car.physics.speedMs.toFixed(2)} nearest=${
          nearest === Infinity ? 'none' : nearest.toFixed(0)}m ${key}`,
      );
    }
  }
}

console.log(`circuit=${circuitId} laps=${laps} seed=${seed} tier=${tier}`);
console.log(`sim duration      ${engine.time.toFixed(0)}s   steps ${steps}`);
console.log(`neutralised       ${(neutralSteps / Math.max(1, steps) * 100).toFixed(1)}%`);
console.log(`stalled car-secs  ${stalledCarS.toFixed(0)}  (stopped, nothing within ${CLEAR_M}m ahead)`);
const byReason = new Map<string, number>();
for (const c of engine.cars) {
  if (c.retired) byReason.set(c.retirementReason, (byReason.get(c.retirementReason) ?? 0) + 1);
}
console.log('retirements       ' + [...byReason].map(([k, v]) => `${k}=${v}`).join(', '));
console.log('\nTOP STALL SIGNATURES');
for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log('  ' + String(v).padStart(6) + '  ' + k);
}
console.log('\nFIRST SAMPLES');
for (const s of samples) console.log('  ' + s);
