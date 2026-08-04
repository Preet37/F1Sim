/** Throwaway diagnostic: what does `plankLoad` actually do on a lap? */
import { installCanvasStub } from './lib/domStub';
installCanvasStub();
const { RaceEngine } = await import('../src/race/RaceEngine');
type SessionConfig = import('../src/race/RaceEngine').SessionConfig;
const { getCircuit } = await import('../src/data/tracks/circuits');

for (const id of ['suzuka', 'zandvoort', 'monza']) {
  const cfg: SessionConfig = {
    kind: 'race', name: 'GP', durationS: 0, laps: 3,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 9001,
  };
  const engine = new RaceEngine(getCircuit(id), cfg);
  const car = engine.cars[0];
  const hist: number[] = [];
  const rh: number[] = [];
  let n = 0;
  for (let s = 0; s < 400000 && !engine.over; s++) {
    engine.step();
    if (!engine.started) continue;
    if (++n % 2) continue;
    hist.push(car.physics.plankLoad);
    rh.push(car.physics.frontRideHeightM);
  }
  const nz = hist.filter((v) => v > 0);
  const sorted = [...hist].sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.floor(sorted.length * p)] ?? 0;
  const nzs = [...nz].sort((a, b) => a - b);
  console.log(`${id}: frames=${hist.length}  plankLoad>0 in ${(nz.length / hist.length * 100).toFixed(1)}%`
    + `  median=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)} p999=${q(0.999).toFixed(3)}`
    + `  nonzero median=${nzs.length ? (nzs[Math.floor(nzs.length / 2)] ?? 0).toFixed(3) : '-'}`);
  const rhs = [...rh].sort((a, b) => a - b);
  const p = (v: number): string => ((rhs[Math.floor(rhs.length * v)] ?? 0) * 1000).toFixed(1);
  console.log(`    frontRideHeight mm: p10=${p(0.1)} median=${p(0.5)} p90=${p(0.9)}`);
}
