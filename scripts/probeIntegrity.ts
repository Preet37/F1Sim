import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * Hunts for the class of bug that makes the simulation untrustworthy.
 *
 * These are not questions about whether the racing is good. They are questions
 * about whether the world holds together at all, and every one of them was a
 * real defect found by playing rather than by testing:
 *
 *  - Cars escaping through the barriers and ending up out in the landscape.
 *  - Sector times of a few milliseconds, recorded when a car crosses a sector
 *    boundary backwards.
 *  - Lap times that are physically impossible for the circuit.
 *  - Cars whose position or velocity has gone non-finite.
 *
 * Every circuit is run for a full session so the check covers the whole
 * calendar, not just whichever track happened to be open.
 */

const SESSION_SECONDS = 220;
const STEPS_PER_SECOND = Math.round(1 / PHYSICS_DT);

interface Issue {
  circuit: string;
  kind: string;
  detail: string;
}

const issues: Issue[] = [];

for (const def of CIRCUITS) {
  const config: SessionConfig = {
    kind: 'qualifying',
    name: 'probe',
    durationS: SESSION_SECONDS,
    laps: 0,
    playerIndex: -1,
    standingStart: false,
    pitLaneStart: true,
    seed: 20260730,
  };
  const engine = new RaceEngine(def, config);

  // Worst lateral excursion seen at any point, per car. The barrier sits at
  // half-width plus the run-off, so anything meaningfully beyond that is a car
  // that has left the world rather than merely run wide.
  const runoff = def.scenery === 'street' ? 2.5 : 14;
  let worstEscape = 0;
  let worstEscapeCar = '';
  let nonFinite = 0;

  for (let t = 0; t < SESSION_SECONDS; t++) {
    for (let i = 0; i < STEPS_PER_SECOND; i++) engine.step();

    for (const car of engine.cars) {
      if (car.retired) continue;
      const p = car.physics;
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y) ||
          !Number.isFinite(p.velocity.x) || !Number.isFinite(car.s)) {
        nonFinite++;
        continue;
      }
      if (car.inPitLane) continue;
      const idx = engine.track.indexAt(car.s);
      const limit = engine.track.width[idx] * 0.5 + runoff;
      const over = Math.abs(car.lateral) - limit;
      if (over > worstEscape) {
        worstEscape = over;
        worstEscapeCar = car.driver.code;
      }
    }
  }

  // --- Checks -------------------------------------------------------------
  if (nonFinite > 0) {
    issues.push({ circuit: def.id, kind: 'non-finite', detail: `${nonFinite} non-finite car states` });
  }

  // A metre or two of overshoot is the solver catching up within a step. Ten
  // metres means the containment failed.
  if (worstEscape > 10) {
    issues.push({
      circuit: def.id, kind: 'escaped',
      detail: `${worstEscapeCar} reached ${worstEscape.toFixed(0)}m beyond the barrier`,
    });
  }

  // Implausible sector and lap times.
  const reference = engine.track.referenceLapTime;
  for (const car of engine.cars) {
    for (let i = 0; i < 3; i++) {
      const st = car.bestSectors[i];
      // A real sector is at minimum a few seconds; anything under one second is
      // a timing artefact, not a lap.
      if (st > 0 && st < 1) {
        issues.push({
          circuit: def.id, kind: 'sector',
          detail: `${car.driver.code} S${i + 1} = ${st.toFixed(3)}s`,
        });
      }
    }
    if (car.bestLapTime > 0 && car.bestLapTime < reference * 0.75) {
      issues.push({
        circuit: def.id, kind: 'lap',
        detail: `${car.driver.code} lap ${car.bestLapTime.toFixed(2)}s vs reference ${reference.toFixed(2)}s`,
      });
    }
  }

  const laps = engine.cars.filter((c) => c.bestLapTime > 0).length;
  const escaped = worstEscape > 10 ? ` ESCAPE ${worstEscape.toFixed(0)}m` : '';
  console.log(
    `${def.id.padEnd(13)} lapsSet=${String(laps).padStart(2)}/20  ` +
    `maxOverBarrier=${worstEscape.toFixed(1)}m${escaped}`,
  );
}

console.log('');
if (issues.length === 0) {
  console.log('PASS — no integrity failures');
  process.exit(0);
}
const byKind = new Map<string, Issue[]>();
for (const i of issues) {
  if (!byKind.has(i.kind)) byKind.set(i.kind, []);
  byKind.get(i.kind)!.push(i);
}
for (const [kind, list] of byKind) {
  console.log(`${kind.toUpperCase()} (${list.length}):`);
  for (const i of list.slice(0, 6)) console.log(`  ${i.circuit}: ${i.detail}`);
  if (list.length > 6) console.log(`  ... and ${list.length - 6} more`);
}
process.exit(1);
