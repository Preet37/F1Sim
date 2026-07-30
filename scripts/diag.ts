import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const def = CIRCUITS.find((c) => c.id === 'monza') ?? CIRCUITS[0];
const config: SessionConfig = {
  kind: 'race',
  name: 'diag',
  durationS: 0,
  laps: 20,
  playerIndex: -1,
  standingStart: true,
  pitLaneStart: false,
  seed: 4242,
};
const engine = new RaceEngine(def, config);
const STEPS = Math.round(1 / PHYSICS_DT);

const orderKey = () => engine.standings.map((c) => c.driver.code).join(',');
let last = orderKey();
let orderChanges = 0;
const pitVisits = new Map<number, number>();
const pitLaneEnters = new Map<number, number>();
const prevInLane = new Map<number, boolean>();
let scSeen = 0;
let vscSeen = 0;

for (let t = 0; t < 60 * 30; t++) {
  for (let i = 0; i < STEPS; i++) engine.step();
  if (engine.over) break;
  const k = orderKey();
  if (k !== last) { orderChanges++; last = k; }
  for (const car of engine.cars) {
    const was = prevInLane.get(car.index) ?? false;
    if (car.inPitLane && !was) pitLaneEnters.set(car.index, (pitLaneEnters.get(car.index) ?? 0) + 1);
    prevInLane.set(car.index, car.inPitLane);
    pitVisits.set(car.index, car.pitStops);
  }
  if (engine.raceControl.neutralisation === 'safety-car') scSeen++;
  if (engine.raceControl.neutralisation === 'vsc') vscSeen++;
}

const msgs = engine.raceControl.messages;
console.log('recent race control:', msgs.slice(-14).map((m) => m.text).join(' | '));
console.log('circuit         ', def.id);
console.log('sim time        ', engine.time.toFixed(1) + 's, leaderLap=' + engine.standings[0].lap);
console.log('standings order changes:', orderChanges);
console.log('SC seconds=' + scSeen + '  VSC seconds=' + vscSeen);
let multi = 0;
let anyPit = 0;
for (const car of engine.cars) {
  const enters = pitLaneEnters.get(car.index) ?? 0;
  if (enters > 0) anyPit++;
  if (enters > 1) multi++;
}
console.log(`cars that entered the pit lane at all: ${anyPit}/20`);
console.log(`cars that entered the pit lane MORE THAN ONCE: ${multi}/20`);
console.log('pitStops per car:', engine.cars.map((c) => `${c.driver.code}:${c.pitStops}/${pitLaneEnters.get(c.index) ?? 0}`).join(' '));
console.log('final order:', engine.standings.map((c) => `${c.position}.${c.driver.code}`).join(' '));
