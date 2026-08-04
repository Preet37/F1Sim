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
  /**
   * Health lost so far, by cause. The column that decides which way the
   * correlation runs — see `DamageSource` in `src/race/DamageModel.ts`.
   */
  lostContact: number;
  lostSolid: number;
  lostWear: number;
  hitsContact: number;
  hitsSolid: number;
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
    lostContact: car.damage.lostBy.contact,
    lostSolid: car.damage.lostBy.solid,
    lostWear: car.damage.lostBy.wear,
    hitsContact: car.damage.hitsBy.contact,
    hitsSolid: car.damage.hitsBy.solid,
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
/**
 * ...of which happened while the race was neutralised.
 *
 * The other half of the loop nobody had counted. A full-distance race here is
 * interrupted seven times and 35% of it runs behind a safety car or a VSC, and
 * a neutralisation is exactly the condition that takes a field spread over a
 * lap and folds it into one queue. If most of the contacts are in the queue,
 * the contact bar is downstream of the retirement bar as well as upstream of
 * it, and the two bars are one loop rather than one chain.
 */
let contactsNeutralised = 0;
/** Seconds of race, and of neutralisation, so the rate can be compared. */
let raceSeconds = 0;
let neutralSeconds = 0;
let deployments = 0;
/** The whole field's damage ledger at the flag or at retirement. */
const fieldLost = { contact: 0, solid: 0, wear: 0 };
const fieldHits = { contact: 0, solid: 0 };
/**
 * EXCURSIONS, and what happened to them.
 *
 * The quantity nothing in this repository counts. A retirement reading
 * `Beached in the gravel` is the END of an excursion; how many excursions the
 * field has and what fraction of them end in a retirement are two different
 * numbers, and the fix is in a different place depending on which one is large.
 * A field that leaves the road twice a race and never gets back is a recovery
 * problem; a field that leaves it forty times and rejoins from most of them is
 * a driving problem.
 *
 * "Off" here is the same test `RaceEngine.checkStranded` uses to decide that a
 * stopped car is beached rather than stopped on track — the half-width plus
 * `STRANDED_OFFROAD_M` — so an excursion counted here is one the engine would
 * also call off the road.
 */
let excursions = 0;
let excursionsRejoined = 0;
let excursionSeconds = 0;
const excursionsByDecile = new Array(10).fill(0);
/**
 * THE CAUSAL TEST, and the reason this file exists at all.
 *
 * "20 of 26 retiring cars were already carrying a component below 0.70" is a
 * correlation with two readings. Either a broken car cannot hold the road — in
 * which case cutting the contact rate cuts the retirements — or the cars that
 * leave the road are the same cars that were going to leave it anyway and the
 * damage came along for the ride, in which case it does not.
 *
 * The two are told apart by an exposure-weighted rate rather than by a count:
 * car-seconds on the road split by whether the car's worst component is above
 * or below 0.70, and excursions counted in the same two buckets. A damaged car
 * that leaves the road at the same rate per second as a healthy one is not
 * being put off by its damage, however many of the retirements it accounts for.
 */
const exposureS = { healthy: 0, damaged: 0 };
const excursionsBy = { healthy: 0, damaged: 0 };
/** The health band the car was in when this excursion started. */
const offDamaged = new Set<number>();
/**
 * The same rate, per tenth of the race, in both bands.
 *
 * The count alone cannot separate "a broken car goes off more" from "everybody
 * goes off more after half distance": the field gets more broken as the race
 * runs, so the two are confounded in the raw by-tenth row. A rate per
 * car-second within each band, per tenth, is not — if the HEALTHY band's rate
 * is flat across the race then the by-tenth shape is entirely a population
 * shift and the damage is the cause. If the healthy rate climbs too, something
 * that is not damage is also going on and this says so.
 */
const excDecHealthy = new Array(10).fill(0);
const excDecDamaged = new Array(10).fill(0);
const expDecHealthy = new Array(10).fill(0);
const expDecDamaged = new Array(10).fill(0);
/**
 * THE DOSE-RESPONSE, which is the version of the causal test worth trusting.
 *
 * A two-band split at 0.70 is confounded twice over: the field gets more
 * broken as the race runs, and a car at 0.72 sits in the "healthy" band while
 * being substantially damaged. A monotone rise across five bands is neither —
 * a threshold cannot produce one by accident, and "everybody goes off after
 * half distance" predicts a flat curve.
 */
const HEALTH_BANDS = [0.95, 0.85, 0.70, 0.50, 0] as const;
const HEALTH_LABEL = ['>= 0.95', '0.85-0.95', '0.70-0.85', '0.50-0.70', '< 0.50'];
const excByBand = new Array(HEALTH_BANDS.length).fill(0);
const expByBand = new Array(HEALTH_BANDS.length).fill(0);
function bandIndex(h: number): number {
  for (let i = 0; i < HEALTH_BANDS.length; i++) if (h >= HEALTH_BANDS[i]) return i;
  return HEALTH_BANDS.length - 1;
}

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
    let wasNeutral = false;
    /** Which cars are currently off the road, so a crossing can be counted. */
    const off = new Set<number>();
    const t0 = Date.now();
    const maxSteps = Math.round((laps * def.referencePoleTimeS * 3.2 + 400) / PHYSICS_DT);
    for (let i = 0; i < maxSteps && !engine.over; i++) {
      engine.step();

      const neutral = engine.raceControl.neutralisation !== 'none';
      raceSeconds += PHYSICS_DT;
      if (neutral) neutralSeconds += PHYSICS_DT;
      if (neutral && !wasNeutral) deployments++;
      wasNeutral = neutral;

      // Excursions, on the same cadence as the contact test.
      if (i % 4 === 0) {
        for (const car of engine.cars) {
          if (car.retired || car.inPitLane) { off.delete(car.index); continue; }
          const isOff = Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 2;
          const worstNow = car.damage.worst().health;
          const broken = worstNow < 0.7;
          const band = bandIndex(worstNow);
          const dec = Math.floor(Math.min(0.999, car.lap / laps) * 10);
          if (isOff) {
            excursionSeconds += PHYSICS_DT * 4;
            if (!off.has(car.index)) {
              off.add(car.index);
              excursions++;
              if (broken) { excursionsBy.damaged++; offDamaged.add(car.index); excDecDamaged[dec]++; }
              else { excursionsBy.healthy++; excDecHealthy[dec]++; }
              excursionsByDecile[dec]++;
              excByBand[band]++;
            }
          } else {
            if (broken) expDecDamaged[dec] += PHYSICS_DT * 4;
            else expDecHealthy[dec] += PHYSICS_DT * 4;
            expByBand[band] += PHYSICS_DT * 4;
            // Exposure only counts time ON the road: the denominator is the
            // opportunity to leave it, and a car already in the gravel has
            // taken that opportunity.
            if (broken) exposureS.damaged += PHYSICS_DT * 4;
            else exposureS.healthy += PHYSICS_DT * 4;
            if (off.delete(car.index)) { excursionsRejoined++; offDamaged.delete(car.index); }
          }
        }
      }

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
                if (neutral) contactsNeutralised++;
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
      // The ledger is over EVERY car, retired or not: the question is what
      // takes health off the field, and a car that retired took its share of it
      // with it.
      fieldLost.contact += car.damage.lostBy.contact;
      fieldLost.solid += car.damage.lostBy.solid;
      fieldLost.wear += car.damage.lostBy.wear;
      fieldHits.contact += car.damage.hitsBy.contact;
      fieldHits.solid += car.damage.hitsBy.solid;
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

// --- WHICH WAY DOES THE CORRELATION RUN -----------------------------------
//
// The table above says the retiring cars were broken. It cannot say what broke
// them, and the two answers need different fixes. `DamageSource` books every
// loss against its cause, so this is the direction of the arrow rather than an
// inference about it.
console.log('');
console.log('  WHAT TOOK THE HEALTH OFF, per retiring car, at `lastRacing`');
console.log('  ' + 'CAR'.padEnd(5) + 'REASON'.padEnd(22) +
  'LOST/CONTACT'.padStart(13) + 'LOST/BARRIER'.padStart(14) + 'LOST/WEAR'.padStart(11) +
  '   HITS c/b' + '  SPD@out');
for (const r of allRetirements) {
  const b = r.lastRacing ?? r.before ?? r.at;
  console.log('  ' +
    r.code.padEnd(5) + r.reason.slice(0, 21).padEnd(22) +
    b.lostContact.toFixed(2).padStart(13) +
    b.lostSolid.toFixed(2).padStart(14) +
    b.lostWear.toFixed(2).padStart(11) +
    ('     ' + b.hitsContact + '/' + b.hitsSolid).padEnd(11) +
    // The speed the car had on the step it was retired. `checkStranded` calls a
    // car stranded when it is under STRANDED_SPEED_MS = 2.5 m/s for nine
    // seconds; a car crawling out of a gravel trap at 2 m/s is under that bar
    // and is not stranded, so this column says whether the rule is retiring
    // cars that were still moving.
    r.at.speedMs.toFixed(2).padStart(9));
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

console.log('');
console.log('  THE FIELD\'S DAMAGE LEDGER — total health lost over every car, by cause');
{
  const total = fieldLost.contact + fieldLost.solid + fieldLost.wear;
  const pct = (x: number) => total > 0 ? (100 * x / total).toFixed(0) + '%' : '-';
  console.log(`    car-to-car contact     ${(fieldLost.contact / racesRun).toFixed(1)} a race ` +
    `(${pct(fieldLost.contact)})  over ${(fieldHits.contact / racesRun).toFixed(1)} impacts`);
  console.log(`    the barrier and world  ${(fieldLost.solid / racesRun).toFixed(1)} a race ` +
    `(${pct(fieldLost.solid)})  over ${(fieldHits.solid / racesRun).toFixed(1)} impacts`);
  console.log(`    kerbs, gravel, revs    ${(fieldLost.wear / racesRun).toFixed(1)} a race ` +
    `(${pct(fieldLost.wear)})`);
}

console.log('');
console.log('  EXCURSIONS — how often the field leaves the road, and whether it gets back');
console.log(`    excursions a race      ${(excursions / racesRun).toFixed(1)}`);
console.log(`    rejoined               ${(excursionsRejoined / racesRun).toFixed(1)} a race ` +
  `(${excursions > 0 ? (100 * excursionsRejoined / excursions).toFixed(0) : '-'}%)`);
console.log(`    car-seconds off road   ${(excursionSeconds / racesRun).toFixed(0)} a race`);
console.log('    by tenth of the race  ' +
  excursionsByDecile.map((n) => (n / racesRun).toFixed(1).padStart(6)).join(''));
{
  // Per thousand car-seconds ON the road, which is the only comparison that
  // means anything: a damaged car has less exposure because it has already
  // retired half the time.
  const rate = (n: number, s: number) => s > 0 ? (1000 * n / s).toFixed(2) : '-';
  console.log(`    rate, worst part >=0.70  ${rate(excursionsBy.healthy, exposureS.healthy)}` +
    ` per 1000 car-seconds on the road (${excursionsBy.healthy} over ` +
    `${(exposureS.healthy / racesRun).toFixed(0)}s a race)`);
  console.log(`    rate, worst part < 0.70  ${rate(excursionsBy.damaged, exposureS.damaged)}` +
    ` per 1000 car-seconds on the road (${excursionsBy.damaged} over ` +
    `${(exposureS.damaged / racesRun).toFixed(0)}s a race)`);
  const rh = exposureS.healthy > 0 ? excursionsBy.healthy / exposureS.healthy : 0;
  const rd = exposureS.damaged > 0 ? excursionsBy.damaged / exposureS.damaged : 0;
  console.log(`    a broken car leaves the road ${rh > 0 ? (rd / rh).toFixed(2) : '-'}x as often ` +
    'per second as a healthy one');
  const row = (exc: number[], exp: number[]) => exc.map((n, i) =>
    (exp[i] > 30 ? (1000 * n / exp[i]).toFixed(2) : '   -').padStart(7)).join('');
  console.log('    ...per tenth of the race' +
    Array.from({ length: 10 }, (_, i) => String(i * 10 + 10).padStart(7)).join(''));
  console.log('    healthy, per 1000 c-s   ' + row(excDecHealthy, expDecHealthy));
  console.log('    broken,  per 1000 c-s   ' + row(excDecDamaged, expDecDamaged));
  console.log('');
  console.log('    DOSE-RESPONSE — excursions per 1000 car-seconds ON the road, by worst part');
  const base = expByBand[0] > 0 ? excByBand[0] / expByBand[0] : 0;
  for (let i = 0; i < HEALTH_BANDS.length; i++) {
    const r = expByBand[i] > 0 ? 1000 * excByBand[i] / expByBand[i] : 0;
    console.log(`      ${HEALTH_LABEL[i].padEnd(11)}${r.toFixed(2).padStart(7)}` +
      `   (${String(excByBand[i]).padStart(4)} over ${(expByBand[i] / racesRun).toFixed(0).padStart(6)}` +
      `s a race)   x${base > 0 ? (r / 1000 / base).toFixed(1) : '-'}`);
  }
}

console.log('');
console.log('  THE NEUTRALISATION LOOP — nothing had ever counted this');
console.log(`    deployments a race     ${(deployments / racesRun).toFixed(2)}`);
console.log(`    race neutralised       ${(100 * neutralSeconds / Math.max(raceSeconds, 1)).toFixed(1)}%` +
  ` of ${(raceSeconds / racesRun).toFixed(0)}s`);
console.log(`    contacts under one     ${(contactsNeutralised / racesRun).toFixed(2)} of ` +
  `${(totalContacts / racesRun).toFixed(2)} a race ` +
  `(${totalContacts > 0 ? (100 * contactsNeutralised / totalContacts).toFixed(0) : '-'}%)`);

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
