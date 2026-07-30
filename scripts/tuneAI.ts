/**
 * Sweeps the AI's commitment scale to find the fastest pace at which the whole
 * field completes clean laps on every circuit.
 *
 * Tuning this against the running simulation rather than reasoning about it is
 * deliberate: the usable value is a property of how accurately the controller
 * tracks the line, which is not something you can derive from the vehicle model.
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';
import { AI_TUNING } from '../src/ai/AIVehicleController';

const SCALES = [1.0, 0.96, 0.92, 0.88, 0.84, 0.80];
console.log('\nSCALE  ' + CIRCUITS.map(c => c.name.slice(0,4).padStart(5)).join('') + '   CLEAN  MEAN RATIO');

for (const scale of SCALES) {
  AI_TUNING.commitmentScale = scale;
  let clean = 0; let ratioSum = 0; let ratioN = 0;
  const cells: string[] = [];
  for (const def of CIRCUITS) {
    const cfg: SessionConfig = { kind:'practice', name:'FP', durationS: 420, laps:0, playerIndex:-1, standingStart:false, seed: 11 };
    const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
    const car = engine.cars[0];
    let off = 0, wasOff = false;
    while (!engine.over && car.lap < 4 && !car.retired) {
      engine.step();
      const o = Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 1.5;
      if (o && !wasOff) off++;
      wasOff = o;
    }
    const ok = off === 0 && car.lap >= 3;
    if (ok) clean++;
    if (car.bestLapTime > 0) { ratioSum += car.bestLapTime / engine.track.referenceLapTime; ratioN++; }
    cells.push((ok ? 'ok' : String(off) + 'x').padStart(5));
  }
  console.log(scale.toFixed(2).padEnd(7) + cells.join('') + '   ' +
    String(clean).padStart(2) + '/11   ' + (ratioN ? (ratioSum/ratioN).toFixed(3) : '--'));
}
console.log('');
