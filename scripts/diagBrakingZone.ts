/**
 * One braking zone, step by step — the third cut at issue #1.
 *
 * `diagPaceProfile.ts` says the AI asks for 91-100% of the reference speed and
 * achieves 57-70% of it in the braking zones, so the deficit is not the target
 * and is not commitment. This prints the zone itself: where the pedal goes down,
 * how much deceleration the car is actually producing, and how much the same
 * car's own tyres and brakes could produce at that speed.
 *
 * Two numbers decide it:
 *   g used     the longitudinal deceleration the car is actually generating
 *   g avail    `TrackSpline.brakingDecelForCar` for THIS car at THIS speed,
 *              which is the expression the solver's own backward pass uses
 *
 * A car braking at half of what it has, over twice the distance, arrives at the
 * apex at the right speed and has thrown away the whole entry — which is
 * invisible to any measurement taken at the apex.
 *
 * Run: npx tsx scripts/diagBrakingZone.ts [circuitId]
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';
import { PHYSICS_DT } from '../src/core/SimClock';

const ID = process.argv[2] ?? 'silverstone';
const def = CIRCUITS.find((c) => c.id === ID);
if (!def) { console.log('no such circuit: ' + ID); process.exit(1); }

const cfg: SessionConfig = {
  kind: 'practice', name: 'FP', durationS: 900, laps: 0,
  playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 11,
};
const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
const track = engine.track;
const c = engine.cars[0];

interface Sample {
  s: number; v: number; ref: number; want: number; brake: number; thr: number;
  decel: number; avail: number; tract: number; lat: number; latG: number;
}
const samples: Sample[] = [];

// Settle for a lap, then record the second.
while (!engine.over && c.lap < 1 && !c.retired) engine.step();
const startLap = c.lap;
while (!engine.over && c.lap === startLap && !c.retired) {
  const before = c.physics.speedMs;
  engine.step();
  const v = c.physics.speedMs;
  const i = track.indexAt(c.s);
  samples.push({
    s: c.s,
    v,
    ref: track.targetSpeed[i],
    want: c.ai ? c.ai.lastTargetSpeedMs : 0,
    brake: c.ai ? c.ai.controls.brake : 0,
    thr: c.ai ? c.ai.controls.throttle : 0,
    tract: c.physics.tractionLimitFraction,
    lat: c.lateral,
    latG: Math.abs(c.physics.frontLateralN + c.physics.rearLateralN) /
      (c.physics.totalMassKg * 9.81),
    decel: (before - v) / PHYSICS_DT,
    avail: track.brakingDecelForCar(v, {
      mu: c.physics.spec.baseMu * Math.min(c.physics.frontTires.grip, c.physics.rearTires.grip),
      cl: c.physics.spec.clBase,
      cd: c.physics.spec.cdBase,
      massKg: c.physics.totalMassKg,
      maxBrakeForceN: c.physics.spec.maxBrakeForceN,
      maxSpeedMs: 103,
    }),
  });
}

// Find the biggest speed drop in the reference profile — the heaviest braking
// zone on the circuit — and print the run-up to it.
let bestI = 0;
let bestDrop = 0;
const count = track.count;
const ds = track.length / count;
const look = Math.max(1, Math.round(120 / ds));
for (let i = 0; i < count; i++) {
  const drop = track.targetSpeed[i] - track.targetSpeed[(i + look) % count];
  if (drop > bestDrop) { bestDrop = drop; bestI = i; }
}
const zoneStart = (bestI * ds) - 60;
const zoneEnd = (bestI * ds) + 200;

console.log('');
console.log(def.name + ' — heaviest braking zone in the reference profile, s = ' +
  zoneStart.toFixed(0) + '..' + zoneEnd.toFixed(0) + 'm  (drop ' + bestDrop.toFixed(1) + ' m/s)');
console.log('  best lap ' + c.bestLapTime.toFixed(2) + 's against reference ' +
  track.referenceLapTime.toFixed(2) + 's');
console.log('');
console.log('      s      v km/h   ref km/h  want km/h   brake  thr  tract   latG    lat   g used  g avail');
let printed = 0;
let brakeOnS = -1;
let sumUsed = 0;
let sumAvail = 0;
let nBrake = 0;
for (const sm of samples) {
  if (sm.s < zoneStart || sm.s > zoneEnd) continue;
  if (sm.brake > 0.05) {
    if (brakeOnS < 0) brakeOnS = sm.s;
    sumUsed += sm.decel;
    sumAvail += sm.avail;
    nBrake++;
  }
  if (printed++ % 12) continue;
  console.log(
    sm.s.toFixed(0).padStart(7) + '  ' +
    (sm.v * 3.6).toFixed(1).padStart(8) + '  ' +
    (sm.ref * 3.6).toFixed(1).padStart(9) + '  ' +
    (sm.want * 3.6).toFixed(1).padStart(9) + '  ' +
    sm.brake.toFixed(2).padStart(6) + ' ' +
    sm.thr.toFixed(2).padStart(5) + ' ' +
    sm.tract.toFixed(2).padStart(6) + ' ' +
    sm.latG.toFixed(2).padStart(6) + ' ' +
    sm.lat.toFixed(1).padStart(6) + '  ' +
    sm.decel.toFixed(2).padStart(7) + '  ' +
    sm.avail.toFixed(2).padStart(7));
}
console.log('');
if (nBrake) {
  console.log('  while the pedal is down, over the WHOLE lap-segment shown:');
  console.log('    mean deceleration used   ' + (sumUsed / nBrake).toFixed(2) + ' m/s2');
  console.log('    mean available           ' + (sumAvail / nBrake).toFixed(2) + ' m/s2');
  console.log('    fraction of the car used ' + (sumUsed / sumAvail).toFixed(3));
}

// Same question over every braking application on the lap, not just this zone.
let lapUsed = 0;
let lapAvail = 0;
let lapN = 0;
let lapPedal = 0;
for (const sm of samples) {
  if (sm.brake > 0.05) { lapUsed += sm.decel; lapAvail += sm.avail; lapPedal += sm.brake; lapN++; }
}
console.log('');
console.log('  WHOLE LAP, every sample with the pedal down (' + lapN + ' of ' + samples.length + '):');
console.log('    mean deceleration used   ' + (lapUsed / lapN).toFixed(2) + ' m/s2');
console.log('    mean available           ' + (lapAvail / lapN).toFixed(2) + ' m/s2');
console.log('    fraction of the car used ' + (lapUsed / lapAvail).toFixed(3));
console.log('    mean pedal               ' + (lapPedal / lapN).toFixed(3));
console.log('');
