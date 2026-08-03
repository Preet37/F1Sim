/** TEMPORARY DIAGNOSTIC. What does a race actually cost in fuel? */
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';

const world = createWorld(20260801);
installWorld(world);

const circuitId = process.env.DIAG_TRACK ?? 'silverstone';
const laps = Number(process.env.DIAG_LAPS ?? 12);
const tier = (process.env.DIAG_TIER ?? 'F3') as TierId;
const def = getCircuit(circuitId);
const field = raceSeats(world, tier).map(toDriver);
const config: SessionConfig = {
  kind: 'race', name: 'Grand Prix', durationS: 0, laps,
  aiDifficulty: 'medium', playerIndex: -1,
  standingStart: true, pitLaneStart: false, seed: 1,
};
const engine = new RaceEngine(def, config, field);
const start = engine.cars.map((c) => c.physics.fuelRemaining);
let steps = 0;
const maxSteps = Math.round((laps * def.referencePoleTimeS * 4.5 + 600) / PHYSICS_DT);
while (!engine.over && steps < maxSteps) { engine.step(); steps++; }

console.log(`circuit=${circuitId} laps=${laps} tier=${tier}`);
console.log(`referencePoleTimeS ${def.referencePoleTimeS.toFixed(1)}  lengthM ${def.lengthM}  raceLaps ${def.raceLaps}`);
console.log(`solved referenceLapTime ${engine.track.referenceLapTime.toFixed(1)}s`);
console.log(`sim duration ${engine.time.toFixed(0)}s   over=${engine.over}`);
let usedTot = 0, lapTot = 0, n = 0;
for (const c of engine.cars) {
  const used = start[c.index] - c.physics.fuelRemaining;
  if (c.lap < 1) continue;
  usedTot += used; lapTot += c.lap; n++;
  if (c.index < 4) {
    console.log(`  car ${c.index} laps=${c.lap} start=${start[c.index].toFixed(1)}L used=${used.toFixed(1)}L left=${c.physics.fuelRemaining.toFixed(1)}L retired=${c.retirementReason}`);
  }
}
console.log(`mean litres per lap  ${(usedTot / Math.max(1, lapTot)).toFixed(3)}`);
console.log(`mean lap time        ${(engine.time / Math.max(1, lapTot / Math.max(1, n))).toFixed(1)}s`);
console.log(`load formula gives   ${Math.min(110, def.raceLaps * (def.lengthM / 1000) * 0.33 + 4).toFixed(1)}L for ${def.raceLaps} laps`);
console.log(`full distance needs  ${(def.raceLaps * usedTot / Math.max(1, lapTot)).toFixed(1)}L`);
