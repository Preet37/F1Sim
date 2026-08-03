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

// ---------------------------------------------------------------------------
// 3. A NEUTRALISED LAP IS STILL A LAP.
//
//    "Each lap completed while the Safety Car is deployed will be counted as a
//    lap of the TTCS" — 2026 Section B Art. B5.13.7 / 2025 Sporting Regs
//    Art. 55.16 — and identically for the VSC, B5.12.5 / Art. 56.8. There is no
//    suspension of the counter and there never has been.
//
//    The player's report from a race clip: "when there is a safety car, doesn't
//    mean that the lap isn't continued — like they crossed the line but were
//    still on lap 6 for some reason. it should've updated right to the next
//    lap."
//
//    Blocks 1 and 2 above cannot see this. Both of them only test for laps
//    counted that were not DRIVEN — the invariant is `car.lap - implied < 1.35`,
//    which is one-sided. This block is the mirror: it drives a real safety car
//    period and asserts that every crossing of the Line under it was credited,
//    and that the number the race is shown as being on never goes backwards.
//
//    THE SECOND HALF IS THE ONE THAT FAILED. No lap was ever missed — measured
//    over a full race at Monza with a staged safety car, every geometric
//    crossing scored — but `leaderLap()` read `standings[0].lap` live, and the
//    standings are sorted on `totalDistance`. A bunched field puts twenty cars
//    nose to tail inside a kilometre, so two cars either side of the Line are
//    metres apart in distance and a whole lap apart on the counter, and the sort
//    flickers between them at 20Hz. Six, seven, six, seven.
// ---------------------------------------------------------------------------
console.log('\nA LAP UNDER THE SAFETY CAR IS STILL A LAP (Art. 55.16 / B5.13.7)');
{
  const def = getCircuit('monza');
  const engine = new RaceEngine(def, {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 12,
    playerIndex: -1, standingStart: true, seed: 5,
  } as SessionConfig);
  const rc = engine.raceControl;
  const track = engine.track;
  const L = track.length;

  // The fastest point on the lap, clear of the pit lane: a car stopped there is
  // "immediate physical danger on or near the track" and gets the full safety
  // car rather than the VSC (Art. 55.3 / B5.13.1). Same staging as
  // `validate:flags`, so the two are looking at the same event.
  let hazardS = 0;
  let fastest = -Infinity;
  for (let i = 0; i < track.count; i += 4) {
    const s = (i / track.count) * L;
    const pit = track.def.pitLane;
    const fromEntry = ((s - pit.entryS) % L + L) % L;
    const toExit = ((pit.exitS - s) % L + L) % L;
    if (fromEntry < L * 0.5 && toExit < L * 0.5) continue;
    if (track.targetSpeed[i] > fastest) { fastest = track.targetSpeed[i]; hazardS = s; }
  }

  const lastS = new Map<number, number>();
  const lapBefore = new Map<number, number>();
  for (const c of engine.cars) lastS.set(c.index, c.s);

  let victim: (typeof engine.cars)[number] | null = null;
  let stagedAt = 0;
  let neutralSteps = 0;
  let crossingsUnderSc = 0;
  let missedUnderSc = 0;
  let lapWentBackwards = 0;
  let worstBackStep = 0;
  let shownLap = 0;
  let sawSafetyCar = false;

  const MAX = Math.round((12 * def.referencePoleTimeS * 4 + 900) * 120);
  for (let step = 0; step < MAX && !engine.over; step++) {
    for (const c of engine.cars) lapBefore.set(c.index, c.lap);
    engine.step();

    // Every geometric crossing of the Line, and whether it scored.
    const neutral = rc.neutralisation !== 'none';
    if (neutral) neutralSteps++;
    for (const c of engine.cars) {
      const prev = lastS.get(c.index)!;
      lastS.set(c.index, c.s);
      if (c.retired) continue;
      if (!(prev > L * 0.75 && c.s < L * 0.25)) continue;
      if (!neutral) continue;
      crossingsUnderSc++;
      if (c.lap <= lapBefore.get(c.index)!) missedUnderSc++;
    }

    // The number the race is shown as being on. `lapsRemaining` is the engine's
    // own published quantity and the one the tower reads, so it is what is
    // asserted rather than a reimplementation of it.
    const total = 12;
    const nowLap = total - engine.lapsRemaining;
    if (nowLap < shownLap) {
      lapWentBackwards++;
      worstBackStep = Math.max(worstBackStep, shownLap - nowLap);
    }
    shownLap = Math.max(shownLap, nowLap);

    if (rc.neutralisation === 'safety-car') sawSafetyCar = true;

    if (!victim && engine.time >= 240 && rc.neutralisation === 'none' &&
        rc.activeIncidents === 0) {
      const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
      victim = running[running.length - 1] ?? null;
      if (victim) {
        stagedAt = engine.time;
        victim.retire('Regression: staged incident', engine.time);
        victim.s = hazardS;
        victim.lateral = track.halfWidthAt(hazardS) + 1.6;
        victim.physics.velocity.set(0, 0);
      }
    }
    // Hold the marshals so the deployment lasts long enough to cross the Line
    // under it. The only thing this test touches, and the same lever
    // `validate:flags` and `probe:recovery` use.
    if (victim && engine.time - stagedAt < 220) {
      victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
      victim.recovery.elapsedS = 0;
    }
  }

  console.log(`  neutralised for ${(neutralSteps / 120).toFixed(0)}s, ` +
    `${crossingsUnderSc} crossings of the Line under it, ${missedUnderSc} uncredited`);
  console.log(`  the lap the race was shown as being on went backwards ` +
    `${lapWentBackwards} times (worst ${worstBackStep} lap(s))`);

  check(sawSafetyCar, 'a safety car must be deployed for a car stopped at the fastest ' +
    'point on the lap — nothing below is evidence otherwise');
  check(crossingsUnderSc > 0,
    'no car crossed the Line under a neutralisation — the case is not being exercised');
  check(missedUnderSc === 0,
    `${missedUnderSc} of ${crossingsUnderSc} crossings under a neutralisation scored no lap ` +
    '— Art. 55.16 / B5.13.7 counts every one of them');
  check(lapWentBackwards === 0,
    `the lap counter went backwards ${lapWentBackwards} times — a completed lap cannot ` +
    'un-complete itself');
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('Lap counting is earned by distance, and ordinary racing still counts.');
