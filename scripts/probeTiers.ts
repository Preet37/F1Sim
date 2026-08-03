/**
 * Is a Formula 3 car actually a Formula 3 car?
 *
 * WHY THIS EXISTS. The career mode this replaces had a field called
 * `TIER_INFO.carPace`, with a comment above it reading "carPace scales the
 * vehicle spec's power and downforce for the tier: an F3 car is meaningfully
 * slower than an F1 car, so lap times differ correctly." Nothing read it. Not
 * one line. An F3 race and an F1 race put the same thousand-horsepower car on
 * the same circuit, and the only difference between the two championships was
 * the string printed at the top of the screen.
 *
 * That is the failure mode this whole design exists to prevent, and a comment
 * claiming otherwise is worse than no comment — so the claim is now a
 * measurement. This drives every tier's real car, built through the real
 * `performanceOf` -> `specForTeam` -> `applySetup` path that `CarEntry` uses,
 * around every one of the eleven surveyed circuits, and asserts:
 *
 *   1. THE ORDER IS RIGHT. F1 is quicker than F2 is quicker than F3, at every
 *      circuit, without exception.
 *   2. THE MARGIN IS RIGHT. Real Formula 2 laps are about 13% off Formula 1 and
 *      real Formula 3 laps about 21%. If the multipliers drift out of those
 *      bands the tiers stop feeling like different categories — too close and
 *      the ladder is pointless, too far and Formula 3 is unbearable.
 *   3. THE TOP SPEED IS RIGHT. A junior car must not reach a Formula 1 car's
 *      terminal velocity down Monza's straight, which is the check that catches
 *      a drag multiplier tuned to fix a lap time at the cost of the physics.
 *   4. THE SPEC IS PHYSICAL. No zero or negative power, downforce or grip
 *      anywhere, at any tier, for any team.
 *
 * Run: npm run probe:tiers
 */

import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { formatLapTime } from '../src/core/MathUtils';
import { clearGrid } from '../src/data/teams';
import { TIER_ORDER, type TierId } from '../src/data/roster';
import {
  createWorld, installWorld, performanceOf, raceSeats, toDriver,
} from '../src/career/World';
import {
  applySetup, baselineSetupFor, specForTeam, BASE_F1_SPEC,
} from '../src/physics/VehicleSpec';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

/**
 * Expected lap-time penalty against Formula 1, as a fraction.
 *
 * `mean` is held to the real figures: across a season, Formula 2 laps about 13%
 * off Formula 1 and Formula 3 about 18-19%. Those are the numbers that decide
 * whether the ladder feels like three categories.
 *
 * `perCircuit` is deliberately much wider, and the reason is a known and
 * documented compromise rather than slack. `specForTeam` multiplies power,
 * downforce, drag and grip, but NOT MASS — see `TIER_CAR` in
 * `src/career/World.ts` — so the junior cars run at a Formula 1 car's 798kg when
 * a real Formula 3 car is 605kg. Mass costs most where speeds are lowest, so the
 * deficit is correct at Monza and overstated at Zandvoort, and no amount of
 * tuning downforce fixes that: downforce does nothing at 80km/h, which is
 * exactly where the error lives.
 *
 * Widening this band is therefore recording a known artefact, not hiding a bug.
 * The fix is a `massMult` field on `TeamPerformance` and one line in
 * `specForTeam`, which is a change in a physics file this work does not own. When
 * that lands, these bands should be tightened to the mean ones and the
 * per-circuit spread should collapse.
 */
const EXPECTED: Record<TierId, { mean: { lo: number; hi: number }; perCircuit: number }> = {
  F1: { mean: { lo: 0, hi: 0 }, perCircuit: 0 },
  F2: { mean: { lo: 0.11, hi: 0.17 }, perCircuit: 0.21 },
  F3: { mean: { lo: 0.18, hi: 0.26 }, perCircuit: 0.32 },
};

const world = createWorld(20260801);
installWorld(world);

// ---------------------------------------------------------------------------
// 4. Is the spec physical, for every team in every tier?
// ---------------------------------------------------------------------------

for (const tier of TIER_ORDER) {
  for (const team of world.tiers[tier].teams) {
    const perf = performanceOf(team);
    const spec = applySetup(specForTeam(perf), baselineSetupFor(0.5, 60));

    check(spec.icePowerW > 100_000,
      `${tier}/${team.id}: ${(spec.icePowerW / 1000).toFixed(0)}kW of engine is not a racing car`);
    check(spec.clBase > 0.5,
      `${tier}/${team.id}: downforce coefficient ${spec.clBase.toFixed(2)}`);
    check(spec.cdBase > 0.1,
      `${tier}/${team.id}: drag coefficient ${spec.cdBase.toFixed(2)}`);
    check(spec.baseMu > 0.5,
      `${tier}/${team.id}: friction coefficient ${spec.baseMu.toFixed(2)}`);
    check(perf.failureRate >= 0 && perf.failureRate < 0.30,
      `${tier}/${team.id}: failure rate ${perf.failureRate.toFixed(3)}`);
    check(perf.pitCrewTimeS > 1.5 && perf.pitCrewTimeS < 6,
      `${tier}/${team.id}: pit stop of ${perf.pitCrewTimeS.toFixed(2)}s`);

    // The junior formulae have no hybrid at all, and that is deliberate — it is
    // most of why they cannot live with a Formula 1 car onto a straight.
    if (tier !== 'F1') {
      check(spec.ersPowerW === 0,
        `${tier}/${team.id}: a junior car has ${(spec.ersPowerW / 1000).toFixed(0)}kW of ERS`);
    } else {
      check(spec.ersPowerW > 50_000,
        `${tier}/${team.id}: only ${(spec.ersPowerW / 1000).toFixed(0)}kW of ERS`);
    }
  }
}

// Sanity on the reference itself: Formula 1's fastest car must still be
// recognisably the car every other probe in this repository measures.
{
  const f1 = world.tiers.F1.teams.map((t) => performanceOf(t));
  const bestPower = Math.max(...f1.map((p) => p.powerMult));
  check(bestPower > 0.98 && bestPower < 1.12,
    `the quickest F1 power unit is ${bestPower.toFixed(3)}x the base spec, which has drifted`);
}

// ---------------------------------------------------------------------------
// 1-3. Drive each tier's car round each circuit
// ---------------------------------------------------------------------------

/**
 * Runs a short headless qualifying session and returns the best lap and the
 * highest speed anybody reached.
 *
 * A real session rather than a solved lap, because that is what the player will
 * experience — the AI has to be able to DRIVE the junior car, and a car that is
 * quick on paper and undriveable in practice would pass a solver and fail here.
 */
function measure(circuitId: string, tier: TierId): { lap: number; topKph: number } {
  const def = getCircuit(circuitId);
  const seats = raceSeats(world, tier).slice(0, 10).map(toDriver);

  const config: SessionConfig = {
    kind: 'qualifying',
    name: 'Probe',
    durationS: 420,
    laps: 0,
    playerIndex: -1,
    standingStart: false,
    pitLaneStart: true,
    seed: 90210,
  };

  const engine = new RaceEngine(def, config, seats);
  const steps = Math.round(config.durationS / PHYSICS_DT);
  let topKph = 0;
  for (let i = 0; i < steps; i++) {
    engine.step();
    if ((i & 63) === 0) {
      for (const car of engine.cars) {
        const kph = car.physics.speedKph;
        if (kph > topKph) topKph = kph;
      }
    }
  }

  let best = Infinity;
  for (const car of engine.cars) {
    if (car.bestLapTime > 0 && car.bestLapTime < best) best = car.bestLapTime;
  }
  return { lap: best, topKph };
}

interface Row { circuit: string; f1: number; f2: number; f3: number; topF1: number; topF2: number; topF3: number }
const rows: Row[] = [];

/**
 * Circuits to measure. All eleven by default.
 *
 * `TIERS_CIRCUITS=monza,zandvoort` narrows it, which matters because tuning the
 * tier multipliers is an iterative loop and a full run drives thirty-three
 * seven-minute sessions. Monza and Zandvoort are the two ends of the trade —
 * one rewards power and low drag, the other rewards downforce — so a junior car
 * that lands correctly at both is very unlikely to be wrong anywhere else.
 */
const ONLY = (process.env.TIERS_CIRCUITS ?? '').split(',').filter(Boolean);
const TO_MEASURE = ONLY.length > 0
  ? CIRCUITS.filter((c) => ONLY.includes(c.id))
  : CIRCUITS;

for (const def of TO_MEASURE) {
  const m: Record<TierId, { lap: number; topKph: number }> = {
    F1: measure(def.id, 'F1'),
    F2: measure(def.id, 'F2'),
    F3: measure(def.id, 'F3'),
  };

  for (const tier of TIER_ORDER) {
    check(Number.isFinite(m[tier].lap),
      `${def.id}/${tier}: nobody completed a lap — the car may be undriveable`);
  }
  if (!Number.isFinite(m.F1.lap)) continue;

  rows.push({
    circuit: def.name,
    f1: m.F1.lap, f2: m.F2.lap, f3: m.F3.lap,
    topF1: m.F1.topKph, topF2: m.F2.topKph, topF3: m.F3.topKph,
  });

  // 1. Order
  check(m.F1.lap < m.F2.lap,
    `${def.id}: F1 lapped in ${formatLapTime(m.F1.lap)} against F2's ${formatLapTime(m.F2.lap)}`);
  check(m.F2.lap < m.F3.lap,
    `${def.id}: F2 lapped in ${formatLapTime(m.F2.lap)} against F3's ${formatLapTime(m.F3.lap)}`);

  // 2. Margin, per circuit. The mean is checked once at the end.
  for (const tier of ['F2', 'F3'] as const) {
    const delta = m[tier].lap / m.F1.lap - 1;
    const cap = EXPECTED[tier].perCircuit;
    check(delta > 0.05 && delta <= cap,
      `${def.id}: ${tier} is ${(delta * 100).toFixed(1)}% off F1 ` +
      `(${formatLapTime(m[tier].lap)} vs ${formatLapTime(m.F1.lap)}), ` +
      `outside the 5-${(cap * 100).toFixed(0)}% a circuit may show`);
  }

  // 3. Top speed
  check(m.F2.topKph < m.F1.topKph,
    `${def.id}: an F2 car reached ${m.F2.topKph.toFixed(0)}km/h against F1's ${m.F1.topKph.toFixed(0)}`);
  check(m.F3.topKph < m.F2.topKph,
    `${def.id}: an F3 car reached ${m.F3.topKph.toFixed(0)}km/h against F2's ${m.F2.topKph.toFixed(0)}`);
}

clearGrid();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('circuit          F1         F2         F3        F2%    F3%   top F1/F2/F3');
for (const r of rows) {
  const d2 = (r.f2 / r.f1 - 1) * 100;
  const d3 = (r.f3 / r.f1 - 1) * 100;
  console.log(
    r.circuit.padEnd(16) +
    formatLapTime(r.f1).padStart(9) +
    formatLapTime(r.f2).padStart(11) +
    formatLapTime(r.f3).padStart(11) +
    ('+' + d2.toFixed(1) + '%').padStart(8) +
    ('+' + d3.toFixed(1) + '%').padStart(7) +
    '   ' + r.topF1.toFixed(0) + '/' + r.topF2.toFixed(0) + '/' + r.topF3.toFixed(0));
}

if (rows.length > 0) {
  const meanF2 = rows.reduce((s, r) => s + (r.f2 / r.f1 - 1), 0) / rows.length;
  const meanF3 = rows.reduce((s, r) => s + (r.f3 / r.f1 - 1), 0) / rows.length;
  console.log(`\nmean deficit: F2 +${(meanF2 * 100).toFixed(1)}%, F3 +${(meanF3 * 100).toFixed(1)}%`);

  // THE ASSERTION THAT MATTERS. A season's worth of circuits, against the real
  // championship's figures. Only checked on a full run — a narrowed run is for
  // tuning and its mean is not a season.
  if (rows.length === CIRCUITS.length) {
    for (const [tier, value] of [['F2', meanF2], ['F3', meanF3]] as const) {
      const band = EXPECTED[tier].mean;
      check(value >= band.lo && value <= band.hi,
        `${tier} averages ${(value * 100).toFixed(1)}% off F1 across the calendar, ` +
        `expected ${(band.lo * 100).toFixed(0)}-${(band.hi * 100).toFixed(0)}%`);
    }
  } else {
    console.log(`(${rows.length} of ${CIRCUITS.length} circuits — the mean is not asserted)`);
  }
}

// The base spec must not have been mutated by any of this.
check(BASE_F1_SPEC.icePowerW === 560_000, 'the base spec was mutated by a tier');

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:tiers OK');
