/** Throwaway: does standings[0].lap flicker under a safety car? */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';

const def = getCircuit('monza');
const engine = new RaceEngine(def, {
  kind: 'race', name: 'GP', durationS: 0, laps: 12,
  playerIndex: -1, standingStart: true, seed: 5,
} as SessionConfig);
const rc = engine.raceControl;
const t = engine.track;

let hazardS = 0, fastest = -Infinity;
for (let i = 0; i < t.count; i += 4) {
  const s = (i / t.count) * t.length;
  const pit = t.def.pitLane;
  const fromEntry = ((s - pit.entryS) % t.length + t.length) % t.length;
  const toExit = ((pit.exitS - s) % t.length + t.length) % t.length;
  if (fromEntry < t.length * 0.5 && toExit < t.length * 0.5) continue;
  if (t.targetSpeed[i] > fastest) { fastest = t.targetSpeed[i]; hazardS = s; }
}

let victim: any = null;
let stagedAt = 0;
let liveBack = 0, liveWorst = 0, prevLive = 0;
let sc = false;
const MAX = 900 * 120;
for (let step = 0; step < MAX && !engine.over; step++) {
  engine.step();
  const live = engine.standings.length ? engine.standings[0].lap : 0;
  if (live < prevLive) { liveBack++; liveWorst = Math.max(liveWorst, prevLive - live); }
  prevLive = live;
  if (rc.neutralisation === 'safety-car') sc = true;

  if (!victim && engine.time >= 240 && rc.neutralisation === 'none' && rc.activeIncidents === 0) {
    const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
    victim = running[running.length - 1];
    stagedAt = engine.time;
    victim.retire('diag', engine.time);
    victim.s = hazardS;
    victim.lateral = t.halfWidthAt(hazardS) + 1.6;
    victim.physics.velocity.set(0, 0);
  }
  if (victim && engine.time - stagedAt < 220) {
    victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
    victim.recovery.elapsedS = 0;
  }
}
console.log(`sawSC=${sc}  t=${engine.time.toFixed(0)}s`);
console.log(`LIVE standings[0].lap went backwards ${liveBack} times (worst ${liveWorst})`);
console.log(`LATCHED (engine.lapsRemaining) is asserted by regress:laps`);
