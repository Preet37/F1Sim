/**
 * Does anybody except the winner take the chequered flag?
 *
 * WHY THIS EXISTS. `RaceEngine.checkSessionEnd` is meant to give backmarkers a
 * window to complete their final lap after the leader finishes:
 *
 *     if (!anyRunning || (raceControl.raceFinished && time > raceFinishedAt + 180)) {
 *       this.finishSession();
 *     }
 *     if (raceControl.raceFinished && raceFinishedAt === 0) {
 *       raceFinishedAt = this.time;          // <- the ONLY write, one line BELOW the read
 *     }
 *
 * `raceFinishedAt` starts at 0 and is written on the line after the guard that
 * reads it, so on the step the leader crosses the line the guard evaluates
 * `time > 0 + 180`. Every race in the game is minutes long, so it is true
 * immediately and `finishSession()` runs on that same step. `finishSession`
 * stamps `finished = true` and `finishTime = this.time` on EVERY car still
 * circulating — so the whole field is classified at the winner's timestamp, on
 * the lap it happened to be on.
 *
 * The player never crosses the line unless they win. Their race is cut off
 * wherever they happen to be, and the result sheet gives them the winner's time.
 *
 * WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: the field being classified at one
 * shared instant instead of as each car finishes. That is measured two ways —
 * the spread of finish times, and how many cars completed the full distance —
 * so a fix that staggers the timestamps without actually letting anybody finish
 * the lap still fails the second check.
 *
 * Run: npm run probe:finish
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

const CIRCUITS = ['monza', 'bahrain', 'silverstone'];
const LAPS = 5;

for (const cid of CIRCUITS) {
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: LAPS,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 99,
  };
  const engine = new RaceEngine(getCircuit(cid), config);

  let leaderCrossedAt = -1;
  const maxSteps = Math.round(3000 / PHYSICS_DT);
  let steps = 0;
  while (!engine.over && steps < maxSteps) {
    engine.step();
    steps++;
    if (leaderCrossedAt < 0 && engine.raceControl.raceFinished) leaderCrossedAt = engine.time;
  }

  check(engine.over, `${cid}: the race never ended in 3000s — this probe measured nothing`);
  if (!engine.over) continue;

  const finishers = engine.cars.filter((c) => c.finished && !c.retired);
  check(finishers.length >= 5,
    `${cid}: only ${finishers.length} classified finishers — too few to measure`);
  if (finishers.length < 5) continue;

  const times = finishers.map((c) => c.finishTime);
  const spread = Math.max(...times) - Math.min(...times);
  // `lap` is the lap the car is ON, so a car that has completed the distance
  // reads LAPS + 1.
  const wentTheDistance = finishers.filter((c) => c.lap > LAPS).length;
  const sharingWinnersTime = times.filter((t) => Math.abs(t - times[0]) < 1e-6).length;

  console.log(
    `${cid.padEnd(12)} ${finishers.length} finishers  ` +
    `finish-time spread ${spread.toFixed(3)}s  ` +
    `completed the full ${LAPS} laps: ${wentTheDistance}/${finishers.length}  ` +
    `sharing the winner's exact time: ${sharingWinnersTime}/${finishers.length}  ` +
    `(race ended ${(engine.time - leaderCrossedAt).toFixed(2)}s after the leader crossed)`);

  // 1. FINISH TIMES ARE NOT ALL THE SAME INSTANT. Cars finish one at a time.
  //    A whole field sharing one timestamp to the microsecond is not a close
  //    finish, it is a single assignment.
  check(sharingWinnersTime <= 2,
    `${cid}: ${sharingWinnersTime} of ${finishers.length} classified finishers carry the winner's ` +
    `EXACT finish time (${times[0].toFixed(3)}s) — the whole field was stamped in one step ` +
    'rather than each car being timed across the line');

  // 2. THE FIELD ACTUALLY COMPLETED THE RACE DISTANCE. The spread above could
  //    be satisfied by cars stopped at different moments; this cannot.
  check(wentTheDistance >= Math.ceil(finishers.length * 0.7),
    `${cid}: only ${wentTheDistance} of ${finishers.length} classified finishers actually ` +
    `completed ${LAPS} laps — the rest were classified as finishers mid-lap`);

  // 3. THE RACE DID NOT END ON THE STEP THE LEADER CROSSED. Backmarkers need a
  //    window; a gap of zero means there was none.
  check(engine.time - leaderCrossedAt > 1,
    `${cid}: the session ended ${(engine.time - leaderCrossedAt).toFixed(3)}s after the leader ` +
    'crossed the line — nobody behind was given any time to finish their lap');
}

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — the field is timed across the line one car at a time.');
}
