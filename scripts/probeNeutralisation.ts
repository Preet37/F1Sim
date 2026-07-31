/**
 * How much of a race is spent neutralised, as a function of race LENGTH.
 *
 * The question this answers: `validate:race` runs five-lap races, and five laps
 * is short enough that one safety car deployment is a large fraction of the
 * whole event. If the neutralised fraction falls back towards its old value as
 * the distance becomes realistic, then the rise is an artefact of the harness's
 * distance and not a regression in the rule.
 *
 * Run: npm run probe:neutral
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

interface Row {
  laps: number;
  neutralFrac: number;
  scCount: number;
  simS: number;
  fastestLap: number;
  refLap: number;
  flUnderNeutral: boolean;
}

function run(trackId: string, laps: number, seed: number): Row {
  const def = getCircuit(trackId);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    playerIndex: -1, standingStart: true, seed,
  };
  const engine = new RaceEngine(def, config);

  let neutralSteps = 0;
  let steps = 0;
  let scCount = 0;
  let wasNeutral = false;
  // Track, per car, whether the lap it is currently on was ever neutralised, so
  // a "fastest lap" set behind the safety car can be identified.
  const lapDirty = new Map<number, boolean>();
  const lastLap = new Map<number, number>();
  let cleanFastest = Infinity;
  for (const c of engine.cars) { lapDirty.set(c.index, false); lastLap.set(c.index, c.lap); }

  const MAX_STEPS = Math.round((laps * def.referencePoleTimeS * 3.6) / PHYSICS_DT);
  while (!engine.over && steps < MAX_STEPS) {
    engine.step();
    steps++;
    const neutral = engine.raceControl.neutralisation !== 'none';
    if (neutral) neutralSteps++;
    if (neutral && !wasNeutral) scCount++;
    wasNeutral = neutral;

    if (steps % 12 === 0) {
      for (const c of engine.cars) {
        if (neutral) lapDirty.set(c.index, true);
        const prev = lastLap.get(c.index)!;
        if (c.lap > prev) {
          // The lap just completed: if it was never neutralised, its time is a
          // candidate for a genuinely clean fastest lap.
          if (!lapDirty.get(c.index) && c.lastLapTime > 0) {
            cleanFastest = Math.min(cleanFastest, c.lastLapTime);
          }
          lapDirty.set(c.index, false);
          lastLap.set(c.index, c.lap);
        }
      }
    }
  }

  const fl = engine.fastestLap();
  const fastestLap = fl ? fl.time : 0;
  return {
    laps,
    neutralFrac: neutralSteps / Math.max(1, steps),
    scCount,
    simS: engine.time,
    fastestLap,
    refLap: engine.track.referenceLapTime,
    // If the best clean lap is materially quicker than the reported fastest,
    // the reported one is not the limiting pace.
    flUnderNeutral: Number.isFinite(cleanFastest) && cleanFastest < fastestLap - 0.01,
  };
}

const tracks = (process.env.NEUTRAL_TRACKS ?? 'zandvoort,silverstone,monaco').split(',');
const lengths = (process.env.NEUTRAL_LAPS ?? '5,15,30').split(',').map(Number);
/**
 * Seeds per cell. One race says nothing: a deployment is a discrete event whose
 * cost is a large fraction of a short race, so the per-race figure is bimodal
 * and only the mean over several seeds is worth comparing.
 */
const seedCount = Number(process.env.NEUTRAL_SEEDS ?? 3);
const seeds = Array.from({ length: seedCount }, (_, i) => 20260729 + i * 7919);

console.log('NEUTRALISED FRACTION vs RACE LENGTH');
console.log('  ' + 'CIRCUIT'.padEnd(13) + 'LAPS'.padStart(5) + 'NEUTRAL%'.padStart(10) +
  'DEPLOYS'.padStart(9) + 'FL/REF'.padStart(9) + 'CLEANER'.padStart(9));
console.log('  ' + '-'.repeat(55));

const byLength = new Map<number, number[]>();
for (const t of tracks) {
  for (const laps of lengths) {
    const fr: number[] = [];
    let scs = 0, ratio = 0, cleaner = 0;
    for (const s of seeds) {
      const r = run(t, laps, s);
      fr.push(r.neutralFrac);
      scs += r.scCount;
      ratio += r.fastestLap > 0 ? r.fastestLap / r.refLap : 0;
      if (r.flUnderNeutral) cleaner++;
    }
    const mean = fr.reduce((a, b) => a + b, 0) / fr.length;
    byLength.set(laps, [...(byLength.get(laps) ?? []), mean]);
    console.log('  ' + t.padEnd(13) + String(laps).padStart(5) +
      (mean * 100).toFixed(1).padStart(10) +
      (scs / seeds.length).toFixed(1).padStart(9) +
      ((ratio / seeds.length) * 100).toFixed(0).padStart(8) + '%' +
      String(cleaner + '/' + seeds.length).padStart(9));
  }
}

console.log('  ' + '-'.repeat(55));
for (const laps of lengths) {
  const v = byLength.get(laps)!;
  console.log('  mean across circuits at ' + String(laps).padStart(2) + ' laps: ' +
    ((v.reduce((a, b) => a + b, 0) / v.length) * 100).toFixed(1) + '%');
}
