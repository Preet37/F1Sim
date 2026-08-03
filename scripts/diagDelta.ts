/**
 * TEMPORARY diagnostic: why does the safety-car delta issue 128 penalties a race?
 *
 * Not a probe and not part of the suite. Delete once the neutralisation owner
 * has the answer.
 */
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';

const world = createWorld(20260801);
installWorld(world);
const def = getCircuit('monza');
const field = raceSeats(world, 'F3').map(toDriver);
const config: SessionConfig = {
  kind: 'race', name: 'GP', durationS: 0, laps: 13,
  playerIndex: -1, standingStart: true, pitLaneStart: false,
  aiDifficulty: 'hard', seed: 20260729,
};
const engine = new RaceEngine(def, config, field);
const rc = engine.raceControl;
const prev = new Map<number, number>();
for (const c of engine.cars) prev.set(c.index, 0);
let reported = 0;
const maxSteps = Math.round((13 * def.referencePoleTimeS * 3.2 + 180) / PHYSICS_DT);
let neutralSteps = 0;
let minSeen = Infinity;
let maxSeen = 0;
for (let i = 0; i < maxSteps && !engine.over; i++) {
  engine.step();
  if (rc.neutralisation !== 'none') {
    neutralSteps++;
    const m = rc.minimumSectorTimeS;
    if (m < minSeen) minSeen = m;
    if (m > maxSeen) maxSeen = m;
  }
  for (const c of engine.cars) {
    const n = c.penalties.length;
    if (n > (prev.get(c.index) ?? 0)) {
      prev.set(c.index, n);
      const p = c.penalties[n - 1];
      if (p.reason.includes('delta') && reported < 25) {
        reported++;
        console.log(
          `${c.driver.code} lap${c.lap} sec=${rc.sectorIndexAt(c.s)} ` +
          `sectorTime=${c.deltaSectorTime.toFixed(2)}s min=${rc.minimumSectorTimeS.toFixed(2)}s ` +
          `speed=${c.physics.speedKph.toFixed(0)}kph breaches=${c.deltaBreaches} ` +
          `neut=${rc.neutralisation} lat=${c.lateral.toFixed(1)} ` +
          `inPit=${c.inPitLane} unlap=${c.mustUnlap}`,
        );
      }
    }
  }
}
console.log(`\nsector length ${(engine.track.length / 20).toFixed(0)}m, ` +
  `neutralised for ${(neutralSteps * PHYSICS_DT).toFixed(0)}s`);
console.log(`minimumSectorTimeS ranged ${minSeen.toFixed(2)} .. ${maxSeen.toFixed(2)}`);
let tot = 0;
for (const c of engine.cars) tot += c.penalties.filter((p) => p.reason.includes('delta')).length;
console.log(`total delta penalties ${tot}`);
