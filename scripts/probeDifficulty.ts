import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { AI_DIFFICULTIES, type AIDifficultyId } from '../src/ai/AIVehicleController';

/**
 * Does the difficulty setting actually change anything?
 *
 * A difficulty that reads well in a menu and does nothing to the cars is worse
 * than no difficulty at all, so this measures the only thing that matters: the
 * lap times the AI actually sets. Same circuits, same seed, same drivers, same
 * cars — only the level changes.
 *
 * The check is on the ORDERING and the SIZE of the gaps. Easy must be
 * measurably slower than medium, medium than hard, and the whole spread has to
 * be large enough for a player to feel. A tenth would satisfy an ordering test
 * and would be indistinguishable from noise from behind the wheel.
 */

const CIRCUITS_TO_RUN = ['bahrain', 'monza', 'silverstone'];
const SESSION_SECONDS = 420;
const STEPS_PER_SECOND = Math.round(1 / PHYSICS_DT);
const LEVELS: AIDifficultyId[] = ['easy', 'medium', 'hard'];

/** Smallest gap between adjacent levels that a driver would actually notice. */
const MIN_STEP_PCT = 0.4;
/** Smallest total spread from easy to hard. */
const MIN_SPREAD_PCT = 1.5;

interface Row { circuit: string; best: Record<string, number>; mean: Record<string, number> }

const rows: Row[] = [];
let failures = 0;

for (const id of CIRCUITS_TO_RUN) {
  const def = getCircuit(id);
  const row: Row = { circuit: id, best: {}, mean: {} };

  for (const level of LEVELS) {
    const config: SessionConfig = {
      kind: 'qualifying',
      name: 'difficulty probe',
      durationS: SESSION_SECONDS,
      laps: 0,
      playerIndex: -1,
      standingStart: false,
      // Spread the field around the lap: this is a pace measurement, and
      // spending half of a short session on an out-lap measures the pit lane.
      pitLaneStart: false,
      aiDifficulty: level,
      seed: 77001,
    };
    const engine = new RaceEngine(def, config);
    for (let t = 0; t < SESSION_SECONDS && !engine.over; t++) {
      for (let i = 0; i < STEPS_PER_SECOND; i++) engine.step();
    }

    const laps = engine.cars.map((c) => c.bestLapTime).filter((t) => t > 0);
    row.best[level] = laps.length > 0 ? Math.min(...laps) : 0;
    row.mean[level] = laps.length > 0 ? laps.reduce((a, b) => a + b, 0) / laps.length : 0;
  }
  rows.push(row);
}

const pct = (a: number, b: number): number => ((a - b) / b) * 100;

console.log('AI DIFFICULTY — best lap and field mean, by level');
console.log('');
console.log('  circuit        level     best      mean    vs hard');
for (const row of rows) {
  for (const level of LEVELS) {
    const d = pct(row.mean[level], row.mean.hard);
    console.log(
      '  ' + row.circuit.padEnd(14) + level.padEnd(9) +
      row.best[level].toFixed(3).padStart(8) +
      row.mean[level].toFixed(3).padStart(10) +
      (d > 0 ? '+' + d.toFixed(2) + '%' : d < 0 ? d.toFixed(2) + '%' : '  --').padStart(10),
    );
  }
  console.log('');
}

console.log('SETTINGS');
for (const level of LEVELS) {
  const d = AI_DIFFICULTIES[level];
  console.log(
    '  ' + d.label.padEnd(8) + ' pace x' + d.paceScale.toFixed(3) +
    '  commitment x' + d.commitmentScale.toFixed(3) +
    '  braking x' + d.brakingScale.toFixed(2) +
    '  aggression x' + d.aggressionScale.toFixed(2) +
    '  error x' + d.errorScale.toFixed(2),
  );
}
console.log('');

for (const row of rows) {
  const e = row.mean.easy;
  const m = row.mean.medium;
  const h = row.mean.hard;
  if (!(e > 0 && m > 0 && h > 0)) {
    console.log(`FAIL ${row.circuit}: a level set no laps at all`);
    failures++;
    continue;
  }
  if (pct(e, m) < MIN_STEP_PCT) {
    console.log(`FAIL ${row.circuit}: easy is only ${pct(e, m).toFixed(2)}% off medium`);
    failures++;
  }
  if (pct(m, h) < MIN_STEP_PCT) {
    console.log(`FAIL ${row.circuit}: medium is only ${pct(m, h).toFixed(2)}% off hard`);
    failures++;
  }
  if (pct(e, h) < MIN_SPREAD_PCT) {
    console.log(`FAIL ${row.circuit}: easy to hard is only ${pct(e, h).toFixed(2)}%`);
    failures++;
  }
}

if (failures === 0) {
  console.log('PASS — every level is measurably slower than the one above it');
  process.exit(0);
}
process.exit(1);
