// Single-seed slice of raceSweep, for comparing two commits without paying for
// fifty-five races. Untracked on purpose.
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const SEEDS = [1137, 1000];
let fails = 0, races = 0, ratioSum = 0;
for (const seed of SEEDS) {
  for (const c of CIRCUITS) {
    const def = getCircuit(c.id);
    const config: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps: 5,
      playerIndex: -1, standingStart: true, seed,
    } as SessionConfig;
    const engine = new RaceEngine(def, config);
    const MAX = Math.round((5 * def.referencePoleTimeS * 3.2) / PHYSICS_DT);
    let steps = 0;
    while (!engine.over && steps < MAX) { engine.step(); steps++; }
    const fl = engine.fastestLap();
    const fastest = fl ? fl.time : 0;
    const ratio = fastest / engine.track.referenceLapTime;
    const finishers = engine.cars.filter((x) => x.finished && !x.disqualified).length;
    const retired = engine.cars.filter((x) => x.retired).length;
    const bad = ratio > 1.45 || fastest <= 0 || finishers + retired < 14;
    if (bad) fails++;
    races++;
    ratioSum += ratio;
    console.log(`${c.id.padEnd(13)} ${seed}  ratio ${(ratio * 100).toFixed(0)}%  ` +
      `cls ${finishers}+${retired}` + (bad ? '  FAIL' : ''));
  }
}
console.log(`TOTAL ${fails}/${races} failing, mean ratio ${(ratioSum / races).toFixed(4)}`);
