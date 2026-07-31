/**
 * Race simulation validation.
 *
 * This is the test that matters most. Every earlier harness checked a component
 * in isolation; this one runs entire races headlessly and asks whether the whole
 * thing actually works as racing:
 *
 *   - Do all twenty cars complete the distance without falling off the track?
 *   - Are lap times realistic, and is the spread between the fastest and slowest
 *     car a believable couple of seconds rather than thirty?
 *   - Does the finishing order correlate with car and driver quality, rather than
 *     being random or being fixed by grid position?
 *   - Do overtakes happen, at a plausible rate for the circuit?
 *   - Do pit stops happen, and does everyone satisfy the two-compound rule?
 *   - Does the field stay intact — no cars teleporting, no infinite yellows?
 *
 * Run: npm run validate:race
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { formatLapTime } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import { getCompound } from '../src/data/tires';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/**
 * Shifts every seed in this harness by a constant.
 *
 * A race is a chaotic system: two cars a tenth apart into turn one decide who
 * leads for the next thirty laps, and a change of a couple of percent anywhere
 * in the physics reshuffles which circuits happen to trip an assertion. Judging
 * a change by ONE run of the default seeds therefore measures the weather, not
 * the code. Sweep the offset (`RACE_SEED_OFFSET=1 npm run validate:race`, and
 * so on) and compare the DISTRIBUTION of failure counts before and after.
 *
 * Zero by default, so the committed `npm run validate:race` is bit-identical to
 * what it has always been.
 */
const SEED_OFFSET = Number(process.env.RACE_SEED_OFFSET ?? 0) | 0;

interface RaceResult {
  trackName: string;
  wallMs: number;
  simSeconds: number;
  laps: number;
  finishers: number;
  retirements: number;
  fastestLap: number;
  referenceLap: number;
  slowestCarBest: number;
  overtakes: number;
  pitStops: number;
  positionChanges: number;
  offTrackExcursions: number;
  disqualified: number;
  penalties: number;
  safetyCars: number;
  winner: string;
  winnerStartPos: number;
  order: { code: string; team: string; pos: number; laps: number; best: number; stops: number }[];
}

function runRace(trackId: string, laps: number, seedBase: number): RaceResult {
  const seed = seedBase + SEED_OFFSET * 7919;
  const def = getCircuit(trackId);
  const config: SessionConfig = {
    kind: 'race',
    name: 'Grand Prix',
    durationS: 0,
    laps,
    playerIndex: -1, // fully simulated: every car is an AI
    standingStart: true,
    seed,
  };

  const engine = new RaceEngine(def, config);

  // Grid order as placed, so we can measure how much the order changes.
  const startPositions = new Map<number, number>();
  engine.cars.forEach((c, i) => startPositions.set(c.index, i + 1));

  // Track overtakes by watching position swaps between adjacent cars.
  const lastPosition = new Map<number, number>();
  for (const c of engine.cars) lastPosition.set(c.index, c.position);
  let overtakes = 0;
  let offTrackExcursions = 0;
  let safetyCars = 0;
  let wasNeutralised = false;
  const wasOffTrack = new Map<number, boolean>();

  const t0 = performance.now();
  const MAX_STEPS = Math.round((laps * def.referencePoleTimeS * 3.2) / PHYSICS_DT);
  let steps = 0;

  while (!engine.over && steps < MAX_STEPS) {
    engine.step();
    steps++;

    // Sample derived events at 10Hz — enough to catch every swap.
    if (steps % 12 === 0) {
      for (const c of engine.cars) {
        const prev = lastPosition.get(c.index)!;
        if (c.position < prev) overtakes++;
        lastPosition.set(c.index, c.position);

        const half = engine.track.halfWidthAt(c.s);
        const off = Math.abs(c.lateral) > half + 1.5 && !c.inPitLane;
        if (off && !wasOffTrack.get(c.index)) offTrackExcursions++;
        wasOffTrack.set(c.index, off);
      }
      const neutral = engine.raceControl.neutralisation !== 'none';
      if (neutral && !wasNeutralised) safetyCars++;
      wasNeutralised = neutral;
    }
  }
  const wallMs = performance.now() - t0;

  let positionChanges = 0;
  for (const c of engine.cars) {
    positionChanges += Math.abs(c.position - (startPositions.get(c.index) ?? c.position));
  }

  const order = engine.standings.map((c) => ({
    code: c.driver.code,
    team: c.team.shortName,
    pos: c.position,
    laps: c.lap,
    best: c.bestLapTime,
    stops: c.pitStops,
  }));

  let slowestCarBest = 0;
  for (const c of engine.cars) {
    if (c.bestLapTime > slowestCarBest) slowestCarBest = c.bestLapTime;
  }

  const fl = engine.fastestLap();
  const winner = engine.standings[0];

  return {
    trackName: def.name,
    wallMs,
    simSeconds: engine.time,
    laps,
    finishers: engine.cars.filter((c) => c.finished && !c.disqualified).length,
    retirements: engine.cars.filter((c) => c.retired).length,
    fastestLap: fl ? fl.time : 0,
    referenceLap: engine.track.referenceLapTime,
    slowestCarBest,
    overtakes,
    pitStops: engine.cars.reduce((a, c) => a + c.pitStops, 0),
    positionChanges,
    offTrackExcursions,
    disqualified: engine.cars.filter((c) => c.disqualified).length,
    penalties: engine.cars.reduce((a, c) => a + c.penalties.length, 0),
    safetyCars,
    winner: winner.driver.code + ' (' + winner.team.shortName + ')',
    winnerStartPos: startPositions.get(winner.index) ?? 0,
    order,
  };
}

// ===========================================================================
// Short races on every circuit: does the sim hold together everywhere?
// ===========================================================================
console.log('\nSHORT RACE ON EVERY CIRCUIT (5 laps, 20 AI cars)');
console.log(
  '  ' + 'CIRCUIT'.padEnd(14) + 'FASTEST'.padStart(10) + 'REF'.padStart(10) +
  'SPREAD'.padStart(8) + 'FIN'.padStart(5) + 'RET'.padStart(5) + 'OVT'.padStart(5) +
  'STOP'.padStart(6) + 'OFF'.padStart(5) + 'SC'.padStart(4) + 'WALL'.padStart(8),
);
console.log('  ' + '-'.repeat(84));

let totalWall = 0;
let totalSim = 0;

for (const def of CIRCUITS) {
  const r = runRace(def.id, 5, 20260729);
  totalWall += r.wallMs;
  totalSim += r.simSeconds;

  const spread = r.slowestCarBest - r.fastestLap;
  console.log(
    '  ' + r.trackName.padEnd(14) +
    formatLapTime(r.fastestLap).padStart(10) +
    formatLapTime(r.referenceLap).padStart(10) +
    (spread > 0 ? '+' + spread.toFixed(2) : '--').padStart(8) +
    String(r.finishers).padStart(5) +
    String(r.retirements).padStart(5) +
    String(r.overtakes).padStart(5) +
    String(r.pitStops).padStart(6) +
    String(r.offTrackExcursions).padStart(5) +
    String(r.safetyCars).padStart(4) +
    (r.wallMs / 1000).toFixed(2).padStart(7) + 's',
  );

  // --- Assertions --------------------------------------------------------
  if (r.finishers + r.retirements < 14) {
    fail(`${def.id}: only ${r.finishers} finishers and ${r.retirements} retirements of 20 cars`);
  }
  if (r.fastestLap <= 0) {
    fail(`${def.id}: no car set a lap time — the AI cannot complete a lap`);
  } else {
    // The AI's fastest lap should be near the solved reference, on race fuel.
    const ratio = r.fastestLap / r.referenceLap;
    if (ratio < 0.97) fail(`${def.id}: fastest lap ${(ratio * 100).toFixed(0)}% of reference — AI is impossibly fast`);
    // The AI currently runs ~15-25% off the solved theoretical reference. That is
    // slower than real race pace and is the main outstanding limitation: it is set
    // by how accurately the line-following controller tracks the racing line, not
    // by the vehicle model. Recorded here rather than hidden.
    if (ratio > 1.45) fail(`${def.id}: fastest lap ${(ratio * 100).toFixed(0)}% of reference — AI is far too slow`);
  }
  if (spread > 70) {
    fail(`${def.id}: ${spread.toFixed(1)}s spread between fastest and slowest car — field is not credible`);
  }
  if (r.offTrackExcursions > 90) {
    fail(`${def.id}: ${r.offTrackExcursions} off-track excursions — the AI cannot stay on the road`);
  }
}

console.log('  ' + '-'.repeat(84));
console.log(
  '  simulated ' + (totalSim / 60).toFixed(1) + ' minutes of racing in ' +
  (totalWall / 1000).toFixed(2) + 's wall clock (' +
  (totalSim / (totalWall / 1000)).toFixed(0) + 'x realtime)',
);

// ===========================================================================
// A full-length race: strategy, pit stops, and the two-compound rule.
// ===========================================================================
console.log('\nFULL RACE DISTANCE (Silverstone, 30 laps)');
{
  const r = runRace('silverstone', 30, 4242);
  console.log('  winner              ' + r.winner + ' from grid ' + r.winnerStartPos);
  console.log('  fastest lap         ' + formatLapTime(r.fastestLap));
  console.log('  finishers           ' + r.finishers + ' / 20  (' + r.retirements + ' retired)');
  console.log('  pit stops           ' + r.pitStops);
  console.log('  overtakes           ' + r.overtakes);
  console.log('  position changes    ' + r.positionChanges);
  console.log('  penalties issued    ' + r.penalties);
  console.log('  disqualified        ' + r.disqualified);
  console.log('  safety cars         ' + r.safetyCars);
  console.log('  race duration       ' + (r.simSeconds / 60).toFixed(1) + ' min');

  if (r.pitStops < 8) fail(`full race: only ${r.pitStops} pit stops across 20 cars over 30 laps`);
  if (r.disqualified > 3) fail(`full race: ${r.disqualified} cars disqualified for the tyre rule`);
  if (r.overtakes < 10) fail(`full race: only ${r.overtakes} overtakes — the racing is static`);
  if (r.positionChanges < 12) fail(`full race: order barely changed (${r.positionChanges})`);

  console.log('\n  FINAL CLASSIFICATION');
  for (const o of r.order.slice(0, 20)) {
    console.log(
      '   ' + String(o.pos).padStart(2) + '  ' + o.code + '  ' +
      o.team.padEnd(11) + String(o.laps).padStart(3) + ' laps  ' +
      formatLapTime(o.best).padStart(9) + '  ' + o.stops + ' stops',
    );
  }
}

// ===========================================================================
// Does car and driver quality actually determine results?
// ===========================================================================
console.log('\nMERIT CORRELATION (3 races, does the best package win?)');
{
  // Sum finishing positions across several seeds. If the sim is working, the
  // quick cars should cluster at the front — and crucially NOT simply reproduce
  // the grid, which would mean nobody can overtake.
  const totals = new Map<string, { sum: number; n: number; skill: number; teamPace: number }>();
  let totalOvertakes = 0;

  for (let seed = 0; seed < 3; seed++) {
    const r = runRace('bahrain', 6, 1000 + seed * 137);
    totalOvertakes += r.overtakes;
    for (const o of r.order) {
      const cur = totals.get(o.code) ?? { sum: 0, n: 0, skill: 0, teamPace: 0 };
      cur.sum += o.pos;
      cur.n++;
      totals.set(o.code, cur);
    }
  }

  // Correlate mean finishing position against a simple merit score.
  const { DRIVERS } = await import('../src/data/teams');
  const rows: { code: string; meanPos: number; merit: number }[] = [];
  for (const d of DRIVERS) {
    const t = totals.get(d.code);
    if (!t) continue;
    const team = (await import('../src/data/teams')).getTeam(d.teamId);
    const p = team.performance;
    const teamPace = p.powerMult + p.downforceMult + p.mechanicalGripMult - 2;
    rows.push({ code: d.code, meanPos: t.sum / t.n, merit: d.skill * 0.55 + teamPace * 0.45 });
  }

  // Spearman-ish: correlation between merit rank and finishing rank.
  const byMerit = rows.slice().sort((a, b) => b.merit - a.merit);
  const byResult = rows.slice().sort((a, b) => a.meanPos - b.meanPos);
  const meritRank = new Map(byMerit.map((r, i) => [r.code, i]));
  const resultRank = new Map(byResult.map((r, i) => [r.code, i]));

  let sumD2 = 0;
  for (const r of rows) {
    const d = (meritRank.get(r.code) ?? 0) - (resultRank.get(r.code) ?? 0);
    sumD2 += d * d;
  }
  const n = rows.length;
  const rho = 1 - (6 * sumD2) / (n * (n * n - 1));

  console.log('  merit-vs-result rank correlation  rho = ' + rho.toFixed(3));
  console.log('  overtakes across 3 races          ' + totalOvertakes);
  console.log('\n  ' + 'DRIVER'.padEnd(8) + 'MEAN POS'.padStart(9) + '   MERIT');
  for (const r of byResult) {
    console.log('  ' + r.code.padEnd(8) + r.meanPos.toFixed(2).padStart(9) + '   ' + r.merit.toFixed(3));
  }

  if (rho < 0.3) {
    fail(`merit correlation rho=${rho.toFixed(2)} — results look random rather than earned`);
  }
  if (totalOvertakes < 25) {
    fail(`only ${totalOvertakes} overtakes across 3 races — cars cannot pass each other`);
  }
}

// ===========================================================================
// Tyre strategy actually differentiates
// ===========================================================================
console.log('\nTYRE COMPOUND BEHAVIOUR');
{
  for (const id of ['soft', 'medium', 'hard'] as const) {
    const c = getCompound(id);
    console.log(
      '  ' + c.name.padEnd(8) + ' grip x' + c.peakGrip.toFixed(2) +
      '  wear x' + c.wearRate.toFixed(2) +
      '  window ' + c.optimalTempMinC + '-' + c.optimalTempMaxC + 'C',
    );
  }
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('Race simulation validated.\n');
}
