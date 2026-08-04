/**
 * WHY DOES A FULL-DISTANCE RACE LOSE ELEVEN CARS? — issue #26, third attempt.
 *
 * `probe:racelog` at `RACELOG_LAPS=full` says 11.50 retirements and 22.50
 * car-to-car contacts a race at issue #26's own configuration (52 laps,
 * Silverstone, F3, grid slot P18, AI on medium, two seeds), against a Grand
 * Prix's one or two. The default quarter-distance run passes. That is a number
 * and not a cause, and this issue has now had its cause named wrongly twice:
 *
 *   1. "cars are spinning off slowly and getting stuck" — refuted by #28, which
 *      showed they were being stopped by the NEUTRALISATION logic on clear road.
 *   2. "the neutralised limiter, not recovery" — refuted by #10, which showed
 *      they were RUNNING OUT OF FUEL (`peakFuelBurnLps` at 129.6 kg/h against
 *      Art. 5.1.4's 100, and a tank filled per kilometre while emptied per
 *      second).
 *
 * Both refutations came from measuring the STATE OF A CAR at the moment it
 * stopped rather than from reasoning about where it stopped. So that is what
 * this does, on every retirement in the race, without a hypothesis:
 *
 *   - the lap it happened on, as a fraction of the distance;
 *   - the tyres — compound, laps on the set, wear and grip front and rear;
 *   - the stint — how many stops the car had made, and how many laps it had
 *     been on that set;
 *   - the damage — the worst component on the car;
 *   - the fuel, so #10's mechanism can be ruled back in or out by measurement
 *     rather than by assumption;
 *   - whether another car had touched it in the last ten seconds;
 *   - whether the race was neutralised;
 *   - and all of the above again at `lastRacing` — the most recent sample with
 *     the car ON THE ROAD and above 15 m/s — because what a stopped car looks
 *     like is not what put it there. The first version of this took the run-up
 *     three seconds before the retirement and that was wrong: a car is retired
 *     nine seconds after it stops, so three seconds before the retirement is six
 *     seconds INTO the excursion. `lastRacing` needs no chosen interval at all.
 *
 * plus the three distributions that say whether anything is distance-specific at
 * all: retirements and contacts per tenth of the race, the tyre-life
 * distribution over the field, and the field's worst component per tenth.
 *
 * IT ASSERTS NOTHING. `probe:racelog` owns the bars; this exists to say what is
 * underneath them, and a diagnostic that fails is a diagnostic people stop
 * running.
 *
 * Run: npm run diag:attrition
 *      DIAG_ATTR_CIRCUITS=silverstone DIAG_ATTR_SEEDS=20260729 npm run diag:attrition
 *      DIAG_ATTR_LAPS=quarter npm run diag:attrition     (the control)
 */

import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { PHYSICS_DT } from '../src/core/SimClock';
import { clearGrid } from '../src/data/teams';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import { raceLapsFor, DEFAULT_WEEKEND_OPTIONS, type RaceDistanceId } from '../src/race/WeekendFormat';
import { DEFAULT_AI_DIFFICULTY, type AIDifficultyId } from '../src/ai/AIVehicleController';

// The same three-disc body and the same hysteresis `probe:racelog` counts a
// contact with, so "touched in the last ten seconds" here and "a contact" there
// are the same event.
const DISC_R = 1.0;
const DISC_OFF = [1.85, 0, -1.85];
const TOUCH_M = DISC_R * 2;
const CLEAR_M = 3.5;

function bodyGapM(a: CarEntry, b: CarEntry): number {
  const aS = Math.sin(a.physics.heading), aC = Math.cos(a.physics.heading);
  const bS = Math.sin(b.physics.heading), bC = Math.cos(b.physics.heading);
  let best = Infinity;
  for (const oa of DISC_OFF) {
    const ax = a.physics.position.x + aS * oa;
    const az = a.physics.position.y + aC * oa;
    for (const ob of DISC_OFF) {
      const d = Math.hypot(
        b.physics.position.x + bS * ob - ax,
        b.physics.position.y + bC * ob - az,
      );
      if (d < best) best = d;
    }
  }
  return best;
}

/** One sample of a car, kept for a while so the run-up can be read. */
interface Sample {
  t: number;
  lap: number;
  speedMs: number;
  lateral: number;
  offRoad: boolean;
  gripF: number;
  gripR: number;
  wearF: number;
  wearR: number;
  lapsOnSet: number;
  fuelL: number;
  worstHealth: number;
  worstPart: string;
  slipF: number;
}

function sampleOf(engine: RaceEngine, car: CarEntry): Sample {
  const p = car.physics;
  let worst = 1;
  let worstPart = '-';
  for (const [id, h] of Object.entries(car.damage.health) as [string, number][]) {
    if (typeof h === 'number' && h < worst) { worst = h; worstPart = id; }
  }
  return {
    t: engine.time,
    lap: car.lap,
    speedMs: p.speedMs,
    lateral: car.lateral,
    offRoad: Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 1.0,
    gripF: p.frontTires.grip,
    gripR: p.rearTires.grip,
    wearF: p.frontTires.wear,
    wearR: p.rearTires.wear,
    lapsOnSet: p.rearTires.lapsOnSet,
    fuelL: p.fuelRemaining,
    worstHealth: worst,
    worstPart,
    slipF: p.frontTires.slipAngle,
  };
}

const world = createWorld(20260801);
installWorld(world);

const TIER: TierId = (process.env.DIAG_ATTR_TIER as TierId) ?? 'F3';
// No `playerIndex` here: this measures the FIELD, and `probe:racelog` already
// owns the one-car-in-a-grid-slot view. Kept as a comment rather than a unused
// constant so the difference between the two harnesses stays visible.
const CIRCUITS = (process.env.DIAG_ATTR_CIRCUITS ?? 'silverstone').split(',');
const SEEDS = (process.env.DIAG_ATTR_SEEDS ?? '20260729,20268648')
  .split(',').map((s) => Number(s.trim()));
const DISTANCE = (process.env.DIAG_ATTR_LAPS ?? 'full') as RaceDistanceId;
const DIFFICULTY = (process.env.DIAG_ATTR_DIFFICULTY as AIDifficultyId) ?? DEFAULT_AI_DIFFICULTY;

/**
 * How far back the "what put it there" sample is taken, seconds.
 *
 * THREE SECONDS WAS WRONG AND THE FIRST RUN PROVED IT. A car is retired
 * `BEACHED_RETIRE_S` = 9 seconds after it stops, so a sample three seconds
 * before the retirement is six seconds AFTER the excursion — it reports a
 * stationary car in the gravel, which is what the retirement already said. It
 * also mis-attributes damage: a car sitting off the road is accumulating
 * `applyWear` the whole time, so the health it carries at that point is partly a
 * consequence of the excursion rather than a cause of it.
 *
 * Twenty seconds clears the stranded timer with room to spare. The `lastRacing`
 * sample below is the stronger one — the most recent moment the car was on the
 * road AND moving — because it does not depend on choosing a number at all.
 */
const RUNUP_S = 20.0;
/** A touch this recently counts as "somebody hit it". */
const CONTACT_MEMORY_S = 10.0;

interface Retirement {
  circuit: string;
  seed: number;
  code: string;
  reason: string;
  lapFraction: number;
  lap: number;
  neutralised: boolean;
  hitRecently: boolean;
  at: Sample;
  before: Sample | null;
  /** The most recent sample with the car on the road and racing. */
  lastRacing: Sample | null;
  pitStops: number;
}

const allRetirements: Retirement[] = [];
/** Contacts and retirements by tenth of the race, summed over the sweep. */
const contactsByDecile = new Array(10).fill(0);
const retiredByDecile = new Array(10).fill(0);
/** Tyre life at the flag, over every surviving car. */
const lapsOnSetAtFlag: number[] = [];
const stopsAtFlag: number[] = [];
const gripAtFlag: number[] = [];
/**
 * The whole field's worst component, sampled once per tenth of the race.
 *
 * The decisive test for anything DISTANCE-specific. `CarDamage.applyWear` is a
 * per-second cost — kerbs, gravel and the rev limiter — and `RaceEngine`'s own
 * comment calls it "a race-distance cost rather than a corner-by-corner one". If
 * that is what is emptying the grid, the field's health has to fall monotonically
 * across the race and a quarter-distance control has to stop a quarter of the way
 * down the same curve. If it does not, the hypothesis is dead and this says so.
 */
const healthByDecile: number[][] = Array.from({ length: 10 }, () => []);
let racesRun = 0;
let totalContacts = 0;

for (const circuitId of CIRCUITS) {
  const def = getCircuit(circuitId);
  const laps = raceLapsFor(def.raceLaps, { ...DEFAULT_WEEKEND_OPTIONS, raceDistance: DISTANCE });

  for (const seed of SEEDS) {
    const field = raceSeats(world, TIER).map(toDriver);
    const config: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps,
      aiDifficulty: DIFFICULTY, playerIndex: -1,
      standingStart: true, pitLaneStart: false, seed,
    };
    const engine = new RaceEngine(def, config, field);
    racesRun++;

    /** A short ring of samples per car, so the run-up is available on demand. */
    const history = new Map<number, Sample[]>();
    /** Last time each car was in contact with another. */
    const lastTouch = new Map<number, number>();
    const touching = new Set<number>();
    const seenRetired = new Set<number>();

    let nextDecile = 0;
    const t0 = Date.now();
    const maxSteps = Math.round((laps * def.referencePoleTimeS * 3.2 + 400) / PHYSICS_DT);
    for (let i = 0; i < maxSteps && !engine.over; i++) {
      engine.step();

      // Sample every 0.5s. Enough resolution for a three-second run-up and
      // cheap enough not to change what this costs.
      if (i % 60 === 0) {
        for (const car of engine.cars) {
          if (car.retired) continue;
          const h = history.get(car.index) ?? [];
          h.push(sampleOf(engine, car));
          while (h.length > 0 && h[0].t < engine.time - 90) h.shift();
          history.set(car.index, h);
        }

        // The field's health, once per tenth of the race, off the leader's lap.
        const leaderLap = Math.max(...engine.cars.map((c) => c.lap));
        while (nextDecile < 10 && leaderLap / laps >= (nextDecile + 1) / 10) {
          for (const car of engine.cars) {
            if (car.retired) continue;
            healthByDecile[nextDecile].push(sampleOf(engine, car).worstHealth);
          }
          nextDecile++;
        }
      }

      // Contacts, on the same cadence `probe:racelog` uses.
      if (i % 4 === 0) {
        const n = engine.cars.length;
        for (let a = 0; a < n; a++) {
          const ca = engine.cars[a];
          if (ca.retired || ca.inPitBox) continue;
          for (let b = a + 1; b < n; b++) {
            const cb = engine.cars[b];
            if (cb.retired || cb.inPitBox || ca.inPitLane !== cb.inPitLane) continue;
            const key = a * 64 + b;
            const g = bodyGapM(ca, cb);
            if (g < TOUCH_M) {
              if (!touching.has(key)) {
                touching.add(key);
                totalContacts++;
                lastTouch.set(a, engine.time);
                lastTouch.set(b, engine.time);
                const frac = Math.min(0.999, Math.max(ca.lap, cb.lap) / laps);
                contactsByDecile[Math.floor(frac * 10)]++;
              }
            } else if (g > CLEAR_M) {
              touching.delete(key);
            }
          }
        }
      }

      for (const car of engine.cars) {
        if (!car.retired || seenRetired.has(car.index)) continue;
        seenRetired.add(car.index);
        const h = history.get(car.index) ?? [];
        const at = h.length > 0 ? h[h.length - 1] : sampleOf(engine, car);
        let before: Sample | null = null;
        for (let k = h.length - 1; k >= 0; k--) {
          if (h[k].t <= engine.time - RUNUP_S) { before = h[k]; break; }
        }
        // The last moment this car was doing the thing it is here to do. No
        // chosen interval, so nothing about the excursion can leak into it.
        let lastRacing: Sample | null = null;
        for (let k = h.length - 1; k >= 0; k--) {
          if (!h[k].offRoad && h[k].speedMs > 15) { lastRacing = h[k]; break; }
        }
        const frac = Math.min(0.999, car.lap / laps);
        retiredByDecile[Math.floor(frac * 10)]++;
        allRetirements.push({
          circuit: circuitId, seed,
          code: car.driver.code,
          reason: car.retirementReason,
          lap: car.lap,
          lapFraction: frac,
          neutralised: engine.raceControl.neutralisation !== 'none',
          hitRecently: (engine.time - (lastTouch.get(car.index) ?? -1e9)) < CONTACT_MEMORY_S,
          at, before, lastRacing,
          pitStops: car.pitStops,
        });
      }
    }

    for (const car of engine.cars) {
      if (car.retired) continue;
      lapsOnSetAtFlag.push(car.physics.rearTires.lapsOnSet);
      stopsAtFlag.push(car.pitStops);
      gripAtFlag.push(car.physics.rearTires.grip);
    }

    console.log(`  ${circuitId} seed ${seed}: ${laps} laps, ` +
      `${engine.cars.filter((c) => c.retired).length} out, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log('');
console.log(`WHERE THE CARS WENT — ${DISTANCE} distance, ${TIER}, AI on ${DIFFICULTY}, ` +
  `${racesRun} race(s)`);
console.log('');
console.log('  Every column is the car\'s state at `lastRacing` — the most recent moment it');
console.log('  was on the road and above 15 m/s — except DMG@20s, which is the same worst');
console.log('  component 20 seconds before the retirement, and DMG@out, which is at it.');
console.log('');
console.log('  ' + 'CAR'.padEnd(5) + 'REASON'.padEnd(22) + 'LAP'.padStart(5) +
  '  %RACE' + '  STOPS' + ' SETLAPS' + '  GRIP F/R' + '  WEAR F/R' +
  '  DMG@race' + ' PART'.padEnd(11) + ' DMG@20s' + ' DMG@out' +
  '  FUEL' + '  SPD' + '  HIT' + '  VSC');
for (const r of allRetirements) {
  const b = r.lastRacing ?? r.before ?? r.at;
  console.log('  ' +
    r.code.padEnd(5) +
    r.reason.slice(0, 21).padEnd(22) +
    String(r.lap).padStart(5) +
    (100 * r.lapFraction).toFixed(0).padStart(6) + '%' +
    String(r.pitStops).padStart(6) +
    String(b.lapsOnSet).padStart(8) +
    ('  ' + b.gripF.toFixed(2) + '/' + b.gripR.toFixed(2)) +
    ('  ' + b.wearF.toFixed(2) + '/' + b.wearR.toFixed(2)) +
    ('      ' + b.worstHealth.toFixed(2)) +
    (' ' + b.worstPart.slice(0, 10).padEnd(11)) +
    ('   ' + (r.before ?? r.at).worstHealth.toFixed(2) + '  ') +
    ('   ' + r.at.worstHealth.toFixed(2)) +
    ('  ' + b.fuelL.toFixed(1)) +
    ('  ' + b.speedMs.toFixed(0)) +
    ('  ' + (r.hitRecently ? 'yes' : ' no')) +
    ('  ' + (r.neutralised ? 'yes' : ' no')));
}

// --- The distributions ----------------------------------------------------
console.log('');
console.log('  BY TENTH OF THE RACE      ' +
  Array.from({ length: 10 }, (_, i) => String(i * 10 + 10).padStart(5)).join(''));
console.log('    retirements             ' +
  retiredByDecile.map((n) => (n / racesRun).toFixed(1).padStart(5)).join(''));
console.log('    contacts                ' +
  contactsByDecile.map((n) => (n / racesRun).toFixed(1).padStart(5)).join(''));
console.log('    worst part, field mean  ' +
  healthByDecile.map((xs) => (xs.length ? mean(xs).toFixed(2) : '  - ').padStart(5)).join(''));
console.log('    worst part, field min   ' +
  healthByDecile.map((xs) => (xs.length ? Math.min(...xs).toFixed(2) : '  - ').padStart(5)).join(''));
console.log('    cars below 0.70         ' +
  healthByDecile.map((xs) =>
    (xs.length ? (xs.filter((h) => h < 0.7).length / racesRun).toFixed(1) : '  - ').padStart(5)).join(''));

console.log('');
console.log('  AT THE FLAG, over the survivors');
console.log(`    pit stops              mean ${mean(stopsAtFlag).toFixed(2)}, ` +
  `min ${Math.min(...stopsAtFlag)}, max ${Math.max(...stopsAtFlag)}`);
console.log(`    laps on the final set  mean ${mean(lapsOnSetAtFlag).toFixed(1)}, ` +
  `max ${Math.max(...lapsOnSetAtFlag)}`);
console.log(`    rear tyre grip         mean ${mean(gripAtFlag).toFixed(3)}, ` +
  `min ${Math.min(...gripAtFlag).toFixed(3)}`);
console.log(`    contacts a race        ${(totalContacts / racesRun).toFixed(2)}`);
console.log(`    retirements a race     ${(allRetirements.length / racesRun).toFixed(2)}`);

// --- The summaries that answer the question -------------------------------
const byReason = new Map<string, number>();
for (const r of allRetirements) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
console.log('');
console.log('  BY REASON');
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
  const rs = allRetirements.filter((r) => r.reason === reason);
  const hit = rs.filter((r) => r.hitRecently).length;
  const vsc = rs.filter((r) => r.neutralised).length;
  console.log(`    ${String(n).padStart(3)}  ${reason.padEnd(24)}` +
    ` (${(n / racesRun).toFixed(2)} a race)  ` +
    `hit by another car within ${CONTACT_MEMORY_S}s: ${hit}/${n}, ` +
    `under a neutralisation: ${vsc}/${n}`);
}

const racing = (r: Retirement) => r.lastRacing ?? r.before ?? r.at;
console.log('');
const worn = allRetirements.filter((r) => racing(r).gripR < 0.85).length;
console.log(`  ${worn} of ${allRetirements.length} retirements were on rear tyres below 0.85 ` +
  'grip the last time the car was racing');
const damaged = allRetirements.filter((r) => racing(r).worstHealth < 0.7).length;
console.log(`  ${damaged} of ${allRetirements.length} were already carrying a component ` +
  'below 0.70 health the last time the car was racing');
const badlyDamaged = allRetirements.filter((r) => racing(r).worstHealth < 0.4).length;
console.log(`  ${badlyDamaged} of ${allRetirements.length} were below 0.40 on some component`);
const dry = allRetirements.filter((r) => racing(r).fuelL < 2).length;
console.log(`  ${dry} of ${allRetirements.length} had under 2 litres of fuel left ` +
  '(#10\'s mechanism, kept in view)');
const clean = allRetirements.filter((r) =>
  !r.hitRecently && racing(r).worstHealth >= 0.7 && racing(r).gripR >= 0.85 &&
  racing(r).fuelL >= 2).length;
console.log(`  ${clean} of ${allRetirements.length} were an undamaged car on good tyres with ` +
  'fuel in it and nobody near it — a car that simply left the road');

clearGrid();
