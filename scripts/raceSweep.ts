/**
 * Multi-seed race sweep — a chaos-tolerant version of validate:race.
 *
 * validate:race runs the whole circuit list on ONE seed, so a tiny physics
 * change can flip several assertions at once. This runs the same 5-lap race on
 * every circuit across five seeds and reports the aggregate, so a merge can be
 * judged on the distribution rather than a single roll of the dice.
 *
 * Run: npx tsx scripts/raceSweep.ts
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const SEEDS = [20260729, 4242, 1000, 1137, 1274];

interface Row {
  circuit: string;
  seed: number;
  finishers: number;
  retirements: number;
  fastestLap: number;
  referenceLap: number;
  spread: number;
  overtakes: number;
  pitStops: number;
  offTrack: number;
  failures: string[];
}

function runRace(trackId: string, laps: number, seed: number): Row {
  const def = getCircuit(trackId);
  const config: SessionConfig = {
    kind: 'race',
    name: 'Grand Prix',
    durationS: 0,
    laps,
    playerIndex: -1,
    standingStart: true,
    seed,
  };
  const engine = new RaceEngine(def, config);
  const lastPosition = new Map<number, number>();
  for (const c of engine.cars) lastPosition.set(c.index, c.position);
  let overtakes = 0;
  let offTrack = 0;
  const wasOff = new Map<number, boolean>();

  const MAX_STEPS = Math.round((laps * def.referencePoleTimeS * 3.2) / PHYSICS_DT);
  let steps = 0;
  while (!engine.over && steps < MAX_STEPS) {
    engine.step();
    steps++;
    if (steps % 12 === 0) {
      for (const c of engine.cars) {
        const prev = lastPosition.get(c.index)!;
        if (c.position < prev) overtakes++;
        lastPosition.set(c.index, c.position);
        const half = engine.track.halfWidthAt(c.s);
        const off = Math.abs(c.lateral) > half + 1.5 && !c.inPitLane;
        if (off && !wasOff.get(c.index)) offTrack++;
        wasOff.set(c.index, off);
      }
    }
  }

  const fl = engine.fastestLap();
  const fastestLap = fl ? fl.time : 0;
  let slowestCarBest = 0;
  for (const c of engine.cars) if (c.bestLapTime > slowestCarBest) slowestCarBest = c.bestLapTime;
  const finishers = engine.cars.filter((c) => c.finished && !c.disqualified).length;
  const retirements = engine.cars.filter((c) => c.retired).length;
  const spread = slowestCarBest - fastestLap;
  const referenceLap = engine.track.referenceLapTime;

  // Same assertions validate:race applies to the per-circuit short races.
  const failures: string[] = [];
  if (finishers + retirements < 14) failures.push(`classified ${finishers}+${retirements} of 20`);
  if (fastestLap <= 0) failures.push('no lap time set');
  else {
    const ratio = fastestLap / referenceLap;
    if (ratio < 0.97) failures.push(`fastest ${(ratio * 100).toFixed(0)}% of reference (too fast)`);
    if (ratio > 1.45) failures.push(`fastest ${(ratio * 100).toFixed(0)}% of reference (too slow)`);
  }
  if (spread > 70) failures.push(`${spread.toFixed(1)}s spread`);
  if (offTrack > 90) failures.push(`${offTrack} off-track excursions`);

  return {
    circuit: def.id,
    seed,
    finishers,
    retirements,
    fastestLap,
    referenceLap,
    spread,
    overtakes,
    pitStops: engine.cars.reduce((a, c) => a + c.pitStops, 0),
    offTrack,
    failures,
  };
}

const rows: Row[] = [];
for (const seed of SEEDS) {
  for (const def of CIRCUITS) rows.push(runRace(def.id, 5, seed));
}

const failed = rows.filter((r) => r.failures.length > 0);
console.log(`RACE SWEEP: ${rows.length} races (${CIRCUITS.length} circuits x ${SEEDS.length} seeds)`);
for (const r of failed) {
  console.log(`  FAIL ${r.circuit}/${r.seed}: ${r.failures.join('; ')}`);
}
const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
const n = rows.length;
console.log('');
console.log(`  races failing            ${failed.length} / ${n}`);
console.log(`  mean finishers           ${(sum((r) => r.finishers) / n).toFixed(2)}`);
console.log(`  mean retirements         ${(sum((r) => r.retirements) / n).toFixed(2)}`);
console.log(`  mean overtakes           ${(sum((r) => r.overtakes) / n).toFixed(2)}`);
console.log(`  mean off-track           ${(sum((r) => r.offTrack) / n).toFixed(2)}`);
console.log(`  mean pit stops           ${(sum((r) => r.pitStops) / n).toFixed(2)}`);
console.log(`  mean lap/reference       ${(sum((r) => r.fastestLap / r.referenceLap) / n).toFixed(4)}`);
console.log(`  mean spread              ${(sum((r) => r.spread) / n).toFixed(2)}`);
