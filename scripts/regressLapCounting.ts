/**
 * Regression: a lap must involve going round the circuit.
 *
 * The bug this locks down
 * -----------------------
 * `CarEntry.updateProjection` reported a lap whenever the car's spline position
 * jumped from the last quarter of the lap to the first. That test is
 * one-directional by design — reversing back over the Line does not fire it — so
 * the counter only ever went up. Crossing the Line, reversing forty metres, and
 * crossing it again therefore scored a second full lap, and a third, and a
 * fourth, for a few metres of travel each. A race ends on the lap counter, so
 * this was enough to take the chequered flag from a standstill; a car spun round
 * at the Line in traffic hit it by accident.
 *
 * Measured on the broken build, driving with nothing but throttle, brake and
 * reverse: 2 laps counted for 417 metres travelled at Bahrain, where a lap is
 * 5412 metres.
 *
 * What this test would fail on
 * ----------------------------
 * Anything that lets the lap counter run ahead of the ground actually covered.
 * The invariant is checked against `totalDistance`, which is accumulated from
 * SIGNED spline deltas by the same function under test, so the second half of
 * the test drives a normal racing stint and asserts laps ARE counted — a fix
 * that simply stopped counting laps would fail that half.
 *
 * Run: npm run regress:laps
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';

const failures: string[] = [];
function check(ok: boolean, msg: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
}

// ---------------------------------------------------------------------------
// 1. Rocking back and forth over the Line must not manufacture laps.
// ---------------------------------------------------------------------------
console.log('\nSHUFFLING OVER THE START/FINISH LINE');
{
  const def = getCircuit('bahrain');
  const engine = new RaceEngine(def, {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 5,
    playerIndex: 0, standingStart: true, seed: 11,
  } as SessionConfig);
  const p = engine.playerCar!;
  const track = engine.track;
  const L = track.length;
  const c = engine.playerControls;
  const zero = () => { c.throttle = 0; c.brake = 0; c.steer = 0; c.reverse = false; };

  // Get the race under way so the car is released and the session is live.
  for (let i = 0; i < 900; i++) engine.step();

  // Park 30m short of the Line, at rest, pointing the right way. This is a
  // legitimate position: it is where the front row of the grid sits.
  const i0 = track.indexAt(L - 30);
  p.physics.placeAt(track.px[i0], track.pz[i0], Math.atan2(track.tx[i0], track.tz[i0]), 0);
  p.updateProjection(track);
  zero(); c.brake = 1;
  for (let i = 0; i < 240; i++) engine.step();

  const lap0 = p.lap;
  const dist0 = p.totalDistance;

  // Everything from here uses only the pedals a player has.
  for (let n = 0; n < 8; n++) {
    zero(); c.throttle = 0.18;
    let guard = 0;
    while (!(p.s > 25 && p.s < 200) && guard++ < 3000) engine.step();
    zero(); c.brake = 1;
    for (let i = 0; i < 300; i++) engine.step();

    zero(); c.reverse = true; c.throttle = 0.18;
    guard = 0;
    while (!(p.s > L - 200 && p.s < L - 20) && guard++ < 3000) engine.step();
    zero(); c.brake = 1;
    for (let i = 0; i < 300; i++) engine.step();
    if (engine.over) break;
  }

  const lapsGained = p.lap - lap0;
  const metres = p.totalDistance - dist0;
  // One lap is allowed for the single honest crossing at the start of the shuffle.
  const allowed = Math.floor(Math.max(0, metres) / L) + 1;
  console.log(`  gained ${lapsGained} lap(s) for ${metres.toFixed(0)}m of travel ` +
    `(a lap is ${L.toFixed(0)}m; at most ${allowed} may be credited)`);
  check(lapsGained <= allowed,
    `lap counter gained ${lapsGained} for ${metres.toFixed(0)}m — laps must be earned by distance`);
  check(!engine.raceControl.raceFinished,
    'shuffling over the Line must not bring out the chequered flag');
}

// ---------------------------------------------------------------------------
// 2. Ordinary racing must still count every lap. A fix that broke this would
//    make the whole game unfinishable, so it is asserted rather than assumed.
// ---------------------------------------------------------------------------
console.log('\nORDINARY RACING STILL COUNTS LAPS');
for (const id of ['bahrain', 'monaco', 'spa']) {
  const def = getCircuit(id);
  const engine = new RaceEngine(def, {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 3,
    playerIndex: -1, standingStart: true, seed: 9,
  } as SessionConfig);

  let steps = 0;
  const MAX = Math.round((3 * def.referencePoleTimeS * 4 + 600) * 120);
  while (!engine.over && steps < MAX) { engine.step(); steps++; }

  const leader = engine.standings[0];
  const L = engine.track.length;
  // Every car's lap count must be consistent with the ground it covered.
  let worst = 0;
  let worstCode = '';
  for (const car of engine.cars) {
    const implied = car.totalDistance / L;
    const over = car.lap - implied;
    if (over > worst) { worst = over; worstCode = car.driver.code; }
  }
  console.log(`  ${id.padEnd(9)} leader lap=${leader.lap} dist=${(leader.totalDistance / L).toFixed(2)} laps  ` +
    `worst overcount ${worst.toFixed(2)} laps (${worstCode})`);
  check(leader.lap >= 4, `${id}: the leader must complete a 3-lap race (lap=${leader.lap})`);
  check(engine.raceControl.raceFinished, `${id}: the chequered flag must come out`);
  check(worst < 1.35, `${id}: ${worstCode} counted ${worst.toFixed(2)} laps more than it drove`);
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('Lap counting is earned by distance, and ordinary racing still counts.');
