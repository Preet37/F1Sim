/**
 * Sweeps the AI's path-controller gains and its commitment scale against the
 * running simulation, and reports how fast and how cleanly a single car laps
 * every circuit.
 *
 * Tuning against the simulation rather than reasoning about it is deliberate:
 * the usable values are properties of how accurately the controller tracks the
 * line through THIS vehicle model, which is not something you can derive from
 * the vehicle model on paper.
 *
 *   npx tsx scripts/tuneAI.ts              sweep the commitment scale
 *   npx tsx scripts/tuneAI.ts converge     sweep the convergence time
 *   npx tsx scripts/tuneAI.ts zeta         sweep the damping ratio
 *   npx tsx scripts/tuneAI.ts bias         sweep the adaptive bias rate
 *   npx tsx scripts/tuneAI.ts share        sweep the correction grip share
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';
import { AI_TUNING } from '../src/ai/AIVehicleController';

interface Trial { clean: number; ratio: number; off: number; cells: string[] }

/** Four flying laps of a single car on every circuit. */
function trial(): Trial {
  let clean = 0;
  let ratioSum = 0;
  let ratioN = 0;
  let offTotal = 0;
  const cells: string[] = [];

  for (const def of CIRCUITS) {
    const cfg: SessionConfig = {
      kind: 'practice', name: 'FP', durationS: 900, laps: 0,
      playerIndex: -1, standingStart: false, seed: 11,
    };
    const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
    const car = engine.cars[0];
    let off = 0;
    let wasOff = false;
    while (!engine.over && car.lap < 5 && !car.retired) {
      engine.step();
      const o = Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 1.5;
      if (o && !wasOff) off++;
      wasOff = o;
    }
    const ratio = car.bestLapTime > 0 ? car.bestLapTime / engine.track.referenceLapTime : 0;
    const ok = off === 0 && ratio > 0;
    if (ok) clean++;
    if (ratio > 0) { ratioSum += ratio; ratioN++; }
    offTotal += off;
    cells.push((ratio > 0 ? (ratio * 100).toFixed(0) : '--').padStart(4) +
      (off ? '/' + off : '  ').padEnd(3));
  }
  return { clean, ratio: ratioN ? ratioSum / ratioN : 0, off: offTotal, cells };
}

const SWEEPS: Record<string, { key: keyof typeof AI_TUNING; values: number[] }> = {
  commitment: { key: 'commitmentScale', values: [1.0, 0.96, 0.92, 0.88, 0.84] },
  throttle: { key: 'throttleShare', values: [1.1, 1.03, 0.95, 0.85] },
  brake: { key: 'brakeShare', values: [1.05, 1.0, 0.95, 0.88] },
};

const which = process.argv[2] ?? 'commitment';
const sweep = SWEEPS[which];
if (!sweep) {
  console.log('unknown sweep: ' + which + '  (try ' + Object.keys(SWEEPS).join(', ') + ')');
  process.exit(1);
}

const original = AI_TUNING[sweep.key];
console.log('\n' + sweep.key.toUpperCase() + '   ' +
  CIRCUITS.map((c) => c.name.slice(0, 4).padStart(7)).join('') + '   CLEAN   MEAN   OFF');

for (const v of sweep.values) {
  AI_TUNING[sweep.key] = v;
  const r = trial();
  console.log(
    v.toFixed(2).padEnd(8) + r.cells.join('') + '   ' +
    (String(r.clean) + '/' + CIRCUITS.length).padStart(5) + '   ' +
    (r.ratio ? (r.ratio * 100).toFixed(1) + '%' : '--').padStart(6) + '  ' +
    String(r.off).padStart(4));
}
AI_TUNING[sweep.key] = original;
console.log('\n  cells are  lap%ofReference/offTrackExcursions\n');
