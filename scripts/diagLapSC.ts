/** Throwaway diagnostic: which line crossings fail to score a lap? */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';

const PHYSICS_DT = 1 / 120;
const circuit = process.argv[2] ?? 'monza';
const laps = Number(process.argv[3] ?? 20);
const def = getCircuit(circuit);
const engine = new RaceEngine(def, {
  kind: 'race', name: 'GP', durationS: 0, laps,
  playerIndex: -1, standingStart: true, seed: 5,
} as SessionConfig);
const rc = engine.raceControl;
const t = engine.track;

let best = 0, bestV = -Infinity;
for (let i = 0; i < t.count; i += 4) {
  const v = t.targetSpeed[i];
  const s = (i / t.count) * t.length;
  const pit = t.def.pitLane;
  const fromEntry = loopDelta(pit.entryS, s, t.length);
  if (fromEntry >= 0 && fromEntry < t.length * 0.5 && loopDelta(s, pit.exitS, t.length) >= 0) continue;
  if (v > bestV) { bestV = v; best = s; }
}

let victim: any = null;
let stagedAt = 0;
const lastS = new Map<number, number>();
const lapBefore = new Map<number, number>();
const distAtCross = new Map<number, number>();
for (const c of engine.cars) { lastS.set(c.index, c.s); distAtCross.set(c.index, 0); }

const misses: string[] = [];
let steps = 0;
const MAX = Math.round(4000 / PHYSICS_DT);
let scSeen = false;

while (!engine.over && steps < MAX) {
  for (const c of engine.cars) lapBefore.set(c.index, c.lap);
  engine.step(); steps++;

  for (const c of engine.cars) {
    if (c.retired) continue;
    const ls = lastS.get(c.index)!;
    const geo = ls > t.length * 0.75 && c.s < t.length * 0.25;
    lastS.set(c.index, c.s);
    if (!geo) continue;
    const scored = c.lap > lapBefore.get(c.index)!;
    const since = c.totalDistance - distAtCross.get(c.index)!;
    if (scored) distAtCross.set(c.index, c.totalDistance);
    else {
      misses.push(
        `t=${engine.time.toFixed(0)}s ${c.driver.code} lap=${c.lap} ` +
        `neut=${rc.neutralisation} phase=${rc.scPhase} inPit=${c.inPitLane} ` +
        `distSinceLastScored=${since.toFixed(0)}m (lap=${t.length.toFixed(0)}m) ` +
        `pitLap=${c.lastPitLap} unlap=${c.mustUnlap}`);
    }
  }

  if (!victim && engine.time >= 300 && rc.neutralisation === 'none' && rc.activeIncidents === 0) {
    const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
    victim = running[running.length - 1];
    stagedAt = engine.time;
    victim.retire('diag', engine.time);
    victim.s = best;
    victim.lateral = t.halfWidthAt(best) + 1.6;
    victim.physics.velocity.set(0, 0);
  }
  if (victim && engine.time - stagedAt < 200) {
    victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
    victim.recovery.elapsedS = 0;
  }
  if (rc.neutralisation === 'safety-car') scSeen = true;
}

console.log(`\n${circuit}: t=${engine.time.toFixed(0)}s over=${engine.over} scSeen=${scSeen}`);
console.log(`MISSED CROSSINGS: ${misses.length}`);
for (const m of misses.slice(0, 40)) console.log('  ' + m);
console.log('\n  car   lapsCredited  totalDist/L  retired  pitStops');
for (const c of engine.standings) {
  console.log(`  ${c.driver.code}   ${String(c.lap).padStart(3)}   ` +
    `${(c.totalDistance / t.length).toFixed(2)}   ${c.retired}`);
}
