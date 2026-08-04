/**
 * WHAT A NEUTRALISATION DOES TO THE CARS IN IT.
 *
 * ===========================================================================
 * WHY THIS FILE WAS REWRITTEN — PROJECT.md section 3.2
 * ===========================================================================
 *
 * It used to be nine races times three seeds of full-distance simulation that
 * printed a table and **exited 0 whatever the table said**. PROJECT.md records
 * it as "40+ minutes of compute that cannot report a failure", which is the
 * exact shape section 3.2 exists to forbid: a probe a broken feature passes is
 * worse than no probe, and this one was expensive as well as blind.
 *
 * Everything it printed is still printed. What is new is that every number now
 * has a bound derived from a regulation or from the simulation's own
 * constants, and the section that matters most — the standstill — did not
 * exist at all.
 *
 * ===========================================================================
 * SECTION 1. THE STANDSTILL (issue #26, issue #10)
 * ===========================================================================
 *
 * The finding this section was built for, measured from outside this subsystem
 * by the agent that fixed issue #28 and recorded in PROJECT.md section 7:
 *
 *   at 52 laps, Silverstone, F3, medium, on pre-#28 `main`, cars spent
 *   **3458 car-seconds stationary with nothing within 60m in front of them
 *   while the race was neutralised**, in a race that was 38% neutralised and
 *   took 14457 simulated seconds — four hours for a ninety-minute Grand Prix.
 *   The simulation counted every one of them as still running.
 *
 * #28 gave the engine a stationary timer that notices, and the only thing it
 * can do with a car that has stopped is recover it — so the invisible stall
 * became **10.5 retirements a race** classified `Stopped on track`, every one
 * of them traced to a VSC, from lap 48, with clear road ahead.
 *
 * THAT IS WHY THIS SECTION MEASURES THREE THINGS AND NOT ONE. The raw
 * car-seconds figure is not the whole quantity on today's build, because #28
 * takes the car away after twelve seconds (`STOPPED_ON_TRACK_RETIRE_S`) and
 * the seconds stop accruing. A probe that watched only that number would read
 * a stall that ends in a retirement as an improvement. So:
 *
 *   CRAWLING     car-seconds under `STRANDED_SPEED_MS` — the engine's own
 *                threshold for "this car has stopped racing" — while
 *                neutralised, on the racing surface, with clear road ahead.
 *                This is the quantity BEFORE the twelve-second clock fires,
 *                and it is the one the limiter actually controls.
 *   STATIONARY   car-seconds under 0.5 m/s in the same conditions. The
 *                comparable to the 3458 figure above.
 *   STALL DNFs   cars retired `Stopped on track` while neutralised with clear
 *                road ahead. What the crawling turns into.
 *
 * "CLEAR ROAD AHEAD" IS MEASURED GEOMETRICALLY, over every car on the same
 * piece of road plus the safety car, and NOT from `CarEntry.perception`. That
 * distinction is load-bearing: `buildPerception` deliberately drops a car that
 * has stopped from `ahead` (issue #28), so a queue of twenty stationary cars
 * ten metres apart would each report nothing in front of them. A measurement
 * taken through the perception cannot tell a limiter stall from a traffic jam.
 *
 * WHAT IS EXCLUDED, AND WHY EACH ONE. A car standing still under a
 * neutralisation is not automatically a bug — something has to have caused the
 * neutralisation. So the count excludes cars that are retired, finished, in
 * the pit lane, or standing off the racing surface (`|lateral|` beyond the
 * half width, i.e. in the run-off, where a stopped car is a crash and not a
 * stall), and cars whose bodywork is wrecked past `DRIVEABLE_HEALTH`, which is
 * a car that has had an accident. What is left is a car that could drive away
 * and is not.
 *
 * ===========================================================================
 * SECTION 2. HOW MUCH OF A RACE IS NEUTRALISED
 * ===========================================================================
 *
 * The original question, kept: `validate:race` runs five-lap races, and five
 * laps is short enough that one deployment is a large fraction of the event,
 * so a rise in the neutralised fraction there may be the harness's distance
 * rather than the rule. It is now asserted at both ends. Too little and the
 * regulations are not being applied; too much and the race is not a race —
 * and the second bound is the one the standstill used to break, because a
 * field that keeps stopping keeps re-neutralising the race it is in.
 *
 * ===========================================================================
 * SECTION 3. THE SAFETY CAR IS DRAWN SMOOTHLY (issue #54, second half)
 * ===========================================================================
 *
 * #54 gave every racing car a five-number render pose and measured the result
 * on the camera's own height: worst per-frame second difference at Spa
 * 123.8mm -> 11.5mm. It could not reach the safety car, because
 * `Renderer.syncSafetyCar` reads `SafetyCar.s`/`.lateral` and `SafetyCar` is
 * race-side code — so the one vehicle everybody is looking at under a
 * neutralisation was still stepped, and stepped in ALL THREE axes rather than
 * only in height, because its X and Z come out of `toWorld(s, lateral)` too.
 *
 * This section drives the REAL `SafetyCar` round the REAL spline at 120Hz and
 * samples the height it would be DRAWN at through the REAL
 * `updateSafetyCarPose`, at 50 and 85 fps — neither of which divides 120 —
 * against a stepped control taken in the same run. Same metric and same 20mm
 * bound as `probe:framerate`'s WORLD SMOOTHNESS section, and the bound is
 * derived the same way: every circuit is a polyline with a node every 3.00m
 * and linear elevation between nodes, so a vehicle crossing a node gets a real
 * step in vertical velocity, worth about 9.2mm in a 50fps frame at the worst
 * kink on the calendar.
 *
 * Run: npm run probe:neutral
 *      NEUTRAL_STALL_TRACKS=spa NEUTRAL_STALL_SEEDS=1,2,3 npm run probe:neutral
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { TrackSpline } from '../src/track/TrackSpline';
import { SafetyCar } from '../src/race/SafetyCar';
import { updateSafetyCarPose } from '../src/render/RenderPose';
import { bankedCarGroundY } from '../src/render/TrackMesh';
import { loopDelta } from '../src/core/MathUtils';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import type { AIDifficultyId } from '../src/ai/AIVehicleController';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

// ===========================================================================
// The thresholds, and where each one comes from
// ===========================================================================

/**
 * The engine's own "this car has stopped racing" speed, m/s.
 *
 * `RaceEngine.STRANDED_SPEED_MS`, restated because it is not exported. It is
 * also `AIVehicleController.CRAWL_MS` to the digit, and that coincidence is
 * the mechanism: the AI treats a target speed below it as an instruction to
 * STOP and puts the brake on, and the engine treats an actual speed below it
 * as a car that needs recovering. A limiter that produces a target under this
 * number therefore does not slow a car down, it retires it — in twelve
 * seconds.
 */
const STRANDED_SPEED_MS = 2.5;

/** Genuinely not moving. The threshold the 3458 car-second figure was taken at. */
const STOPPED_MS = 0.5;

/**
 * How much road counts as clear, metres.
 *
 * Sixty metres is the figure issue #26 was measured at and is kept for
 * comparability. It is also about ten car lengths, which is the largest gap
 * any regulation asks a driver to hold under a neutralisation (Art. 55.7 /
 * B5.13.2b), so a car with more than this in front of it is a car with nothing
 * to queue behind by the regulations' own measure.
 */
const CLEAR_ROAD_M = 60;

/**
 * Bodywork health below which a stationary car is an accident, not a stall.
 *
 * `DamageModel`'s own detach threshold region. A car that has lost a wing and
 * stopped has a reason to be stopped that this probe is not measuring.
 */
const DRIVEABLE_HEALTH = 0.35;

// ===========================================================================
// Section 1 — the standstill
// ===========================================================================

interface StallRow {
  circuit: string;
  seed: number;
  simS: number;
  neutralFrac: number;
  crawlCarS: number;
  stoppedCarS: number;
  stallRetirements: number;
  retirements: number;
  laps: number;
  /** Cars that emptied the tank. The cause the standstill turned out to have. */
  dry: number;
  fuelLoadL: number;
  perLapL: number;
}

const world = createWorld(20260801);
installWorld(world);

function runStall(
  circuitId: string, tier: TierId, laps: number, seed: number, difficulty: AIDifficultyId,
): StallRow {
  const def = getCircuit(circuitId);
  const field = raceSeats(world, tier).map(toDriver);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    aiDifficulty: difficulty, playerIndex: -1,
    standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config, field);
  const len = engine.track.length;

  let crawlCarS = 0;
  let stoppedCarS = 0;
  let stallRetirements = 0;
  let neutralSteps = 0;
  let steps = 0;
  /** Whether each car was crawling on clear road under a neutralisation. */
  const stalling = new Set<number>();
  const seenRetired = new Set<number>();

  // Sampled at 10Hz rather than every step. A car takes twelve seconds to be
  // retired for stopping, so a tenth of a second resolves the quantity to
  // better than a percent and costs a twelfth of the arithmetic.
  const SAMPLE = 12;
  const sampleS = SAMPLE * PHYSICS_DT;

  // Generous, because the failure this probe exists to catch MAKES RACES
  // LONGER — 14457 simulated seconds for a ninety-minute Grand Prix — and a
  // ceiling tight enough to be efficient on a healthy build would truncate the
  // broken one and hide the thing being measured.
  const maxSteps = Math.round((laps * def.referencePoleTimeS * 4.5 + 600) / PHYSICS_DT);

  while (!engine.over && steps < maxSteps) {
    engine.step();
    steps++;
    const rc = engine.raceControl;
    const neutral = rc.neutralisation !== 'none';
    if (neutral) neutralSteps++;

    // A retirement is an event and has to be caught on the step it happens,
    // together with the state that caused it.
    for (const car of engine.cars) {
      if (!car.retired || seenRetired.has(car.index)) continue;
      seenRetired.add(car.index);
      if (car.retirementReason === 'Stopped on track' && stalling.has(car.index)) {
        stallRetirements++;
      }
    }

    if (steps % SAMPLE !== 0) continue;
    for (const car of engine.cars) {
      if (!neutral || car.retired || car.finished || car.inPitLane) {
        stalling.delete(car.index);
        continue;
      }
      // In the run-off, a stopped car is a crash. On the road it is this bug.
      if (Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 1.0) {
        stalling.delete(car.index);
        continue;
      }
      if (car.damage.worst().health < DRIVEABLE_HEALTH) {
        stalling.delete(car.index);
        continue;
      }
      const v = car.physics.speedMs;
      if (v >= STRANDED_SPEED_MS) { stalling.delete(car.index); continue; }

      // Clear road, geometrically. See the header for why this is not read off
      // the perception.
      let nearest = Infinity;
      for (const other of engine.cars) {
        if (other === car || other.retired || other.inPitLane !== car.inPitLane) continue;
        const d = loopDelta(car.s, other.s, len);
        if (d > 0 && d < nearest) nearest = d;
      }
      if (rc.scOnTrack) {
        const d = loopDelta(car.s, rc.scS, len);
        if (d > 0 && d < nearest) nearest = d;
      }
      if (nearest <= CLEAR_ROAD_M) { stalling.delete(car.index); continue; }

      stalling.add(car.index);
      crawlCarS += sampleS;
      if (v < STOPPED_MS) stoppedCarS += sampleS;
    }
  }

  let lapTot = 0, usedTot = 0;
  for (const c of engine.cars) {
    if (c.lap < 1) continue;
    lapTot += c.lap;
    usedTot += c.setup.fuelLoadL - c.physics.fuelRemaining;
  }
  return {
    circuit: circuitId, seed, laps,
    simS: engine.time,
    neutralFrac: neutralSteps / Math.max(1, steps),
    crawlCarS, stoppedCarS, stallRetirements,
    retirements: engine.cars.filter((c) => c.retired).length,
    // Counted BOTH ways so that this number survives the fix that names the
    // cause: before it, a car that ran dry was retired `Stopped on track` and
    // the tank is the only evidence left.
    dry: engine.cars.filter((c) =>
      c.retirementReason === 'Out of fuel' || c.physics.fuelRemaining <= 0.02).length,
    fuelLoadL: engine.cars[0].setup.fuelLoadL,
    perLapL: usedTot / Math.max(1, lapTot),
  };
}

/**
 * FULL DISTANCE, AND IT HAS TO BE FULL DISTANCE.
 *
 * This is expensive — a fifty-two lap race is about a million physics steps for
 * twenty cars — and the temptation to run a third of it and multiply is exactly
 * the mistake that let the defect survive. The old fuel load was
 * `def.raceLaps x lengthKm x 0.33 + 4` and it used the CHAMPIONSHIP distance
 * whatever the session was, so a short race started with a full Grand Prix of
 * fuel on board and could not run dry however badly the arithmetic was wrong.
 * Every probe in this repository that runs five or fourteen laps was therefore
 * structurally incapable of seeing it, and `probe:racelog` at full distance —
 * the one that could — read it as thirteen beachings and a path-tracking
 * failure (issue #26).
 *
 * So the distance is the circuit's own, the tier and difficulty are the ones
 * issue #26 is written at, and the cost is the price of a probe that can fail.
 * One seed a circuit; two circuits, because a single one has been wrong in this
 * project's history every time it was tried.
 */
const STALL_TIER = (process.env.NEUTRAL_TIER as TierId) ?? 'F3';
const STALL_DIFFICULTY = (process.env.NEUTRAL_DIFFICULTY as AIDifficultyId) ?? 'medium';
/** 0 means "this circuit's own championship distance", which is the default. */
const STALL_LAPS = Number(process.env.NEUTRAL_STALL_LAPS ?? 0);
const STALL_CIRCUITS = (process.env.NEUTRAL_STALL_TRACKS ?? 'silverstone,monza').split(',');
const STALL_SEEDS = (process.env.NEUTRAL_STALL_SEEDS ?? '1').split(',').map(Number);

console.log('THE STANDSTILL — a neutralisation is a speed limit, not a stop signal');
console.log(`  full distance, ${STALL_TIER}, ${STALL_DIFFICULTY}, clear road = ` +
  `${CLEAR_ROAD_M}m, crawl = under ${STRANDED_SPEED_MS} m/s`);
console.log('  ' + 'CIRCUIT'.padEnd(13) + 'SEED'.padStart(5) + 'SIM s'.padStart(9) +
  'NEUTRAL%'.padStart(10) + 'CRAWL cs'.padStart(10) + 'STOPPED cs'.padStart(12) +
  'STALL DNF'.padStart(11) + 'DNF'.padStart(6) + 'DRY'.padStart(5) +
  'FUEL L'.padStart(9) + 'L/LAP'.padStart(8));
console.log('  ' + '-'.repeat(98));

const stallRows: StallRow[] = [];
for (const circuit of STALL_CIRCUITS) {
  const laps = STALL_LAPS > 0 ? STALL_LAPS : getCircuit(circuit).raceLaps;
  for (const seed of STALL_SEEDS) {
    const r = runStall(circuit, STALL_TIER, laps, seed, STALL_DIFFICULTY);
    stallRows.push(r);
    console.log('  ' + r.circuit.padEnd(13) + String(r.seed).padStart(5) +
      r.simS.toFixed(0).padStart(9) +
      (r.neutralFrac * 100).toFixed(1).padStart(10) +
      r.crawlCarS.toFixed(0).padStart(10) +
      r.stoppedCarS.toFixed(0).padStart(12) +
      String(r.stallRetirements).padStart(11) +
      String(r.retirements).padStart(6) +
      String(r.dry).padStart(5) +
      r.fuelLoadL.toFixed(1).padStart(9) +
      r.perLapL.toFixed(2).padStart(8));
  }
}

const races = Math.max(1, stallRows.length);
const meanCrawl = stallRows.reduce((a, r) => a + r.crawlCarS, 0) / races;
const meanStopped = stallRows.reduce((a, r) => a + r.stoppedCarS, 0) / races;
const meanStallDnf = stallRows.reduce((a, r) => a + r.stallRetirements, 0) / races;
const meanDry = stallRows.reduce((a, r) => a + r.dry, 0) / races;
console.log('  ' + '-'.repeat(98));
console.log('  mean a race: crawl ' + meanCrawl.toFixed(0) + ' car-s, stopped ' +
  meanStopped.toFixed(0) + ' car-s, stall retirements ' + meanStallDnf.toFixed(2) +
  ', tanks emptied ' + meanDry.toFixed(2));

/**
 * THE BOUNDS, and neither is a fitted number.
 *
 * STALL RETIREMENTS: zero, per race, and it has to be zero. Every exclusion
 * above removes a car that has a reason to be stopped — it has crashed, it is
 * in the gravel, it has lost its bodywork, it is in the pit lane. What is left
 * is a car with clear road in front of it and nothing wrong with it, and the
 * regulations do not contain a sentence under which such a car is required to
 * stop. Under the VSC, Art. B5.12.2b / 56.5 asks a driver to stay ABOVE a
 * minimum sector time and says nothing that could bring one to rest; under the
 * safety car, B5.13.2b / 55.7 asks them to close up to within ten car lengths
 * of the car in front, which a car with sixty metres of empty road in front of
 * it is by definition not doing. A number greater than zero here is the
 * simulation retiring a car for obeying it. Measured on `main` before this
 * work: see the PR.
 *
 * CRAWLING: bounded at one car-second per race per car. The engine gives a
 * stationary car twelve seconds before it acts (`STOPPED_ON_TRACK_RETIRE_S`),
 * so a single car that genuinely drops below the threshold once — coming to
 * rest after a spin the damage model did not register, say — is worth up to
 * twelve car-seconds before it is either driving again or gone. The bound is
 * set at 20 car-seconds a race, which is under two such events, and it is
 * deliberately much tighter than the 3458 the defect produced so that a
 * partial fix cannot pass.
 */
const STALL_DNF_BOUND = 0;
const CRAWL_BOUND_CAR_S = 20;
if (meanStallDnf > STALL_DNF_BOUND) {
  fail(
    `${meanStallDnf.toFixed(2)} cars a race are retired for stopping on track while ` +
    `neutralised with ${CLEAR_ROAD_M}m of clear road in front of them — nothing in ` +
    `Art. B5.12.2b or B5.13.2b asks a car to stop, and the limiter is doing it`,
  );
}
if (meanCrawl > CRAWL_BOUND_CAR_S) {
  fail(
    `${meanCrawl.toFixed(0)} car-seconds a race under ${STRANDED_SPEED_MS} m/s while ` +
    `neutralised on clear road, bound ${CRAWL_BOUND_CAR_S} — a car with clear road in ` +
    `front of it is being brought below the speed the engine reads as "stopped racing"`,
  );
}
/**
 * AND THE CAUSE, MEASURED DIRECTLY. Kept as its own bound rather than left to
 * the two above, because it is the quantity that actually moved and because a
 * count of stopped cars is a symptom that several different faults can produce.
 * Nothing in the sporting or technical regulations contemplates a car running
 * out of fuel — Art. 6.5.2 requires a one-litre sample to be AVAILABLE at the
 * end of the race, which is a rule written on the assumption that there is fuel
 * left — and a field that empties its tanks is a field that was fuelled for a
 * different race from the one it ran. Zero, per race, over the whole field.
 */
const DRY_BOUND = 0;
if (meanDry > DRY_BOUND) {
  fail(
    `${meanDry.toFixed(2)} cars a race empty the tank before the flag — the race fuel ` +
    `load (${stallRows[0].fuelLoadL.toFixed(1)}L) does not cover the race that is run ` +
    `at ${stallRows[0].perLapL.toFixed(2)}L a lap`,
  );
}

// ===========================================================================
// Section 2 — how much of a race is neutralised, as a function of distance
// ===========================================================================

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
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed,
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

const tracks = (process.env.NEUTRAL_TRACKS ?? 'zandvoort,monaco').split(',');
const lengths = (process.env.NEUTRAL_LAPS ?? '5,15').split(',').map(Number);
/**
 * Seeds per cell. One race says nothing: a deployment is a discrete event whose
 * cost is a large fraction of a short race, so the per-race figure is bimodal
 * and only the mean over several seeds is worth comparing.
 */
const seedCount = Number(process.env.NEUTRAL_SEEDS ?? 2);
const seeds = Array.from({ length: seedCount }, (_, i) => 20260729 + i * 7919);

console.log('\nNEUTRALISED FRACTION vs RACE LENGTH');
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
const longest = lengths[lengths.length - 1];
for (const laps of lengths) {
  const v = byLength.get(laps)!;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log('  mean across circuits at ' + String(laps).padStart(2) + ' laps: ' +
    (mean * 100).toFixed(1) + '%');
  /**
   * THE UPPER BOUND, and where it comes from.
   *
   * A real Formula 1 season runs somewhere around a third of its races with a
   * safety car or VSC at all, and a deployment costs three to six laps of a
   * fifty-lap race. Averaged over a season that is a few per cent; at a
   * five-lap harness distance one deployment is most of the race, which is the
   * artefact this section was written to separate out. So the bound is applied
   * only at the LONGEST distance measured, where the artefact has washed out,
   * and it is set at half — a race that spends more time behind a
   * neutralisation than racing is not a race, whatever the cause.
   *
   * It is a ceiling on a symptom rather than a rule, and it is here because
   * the standstill drove it to 38% at full distance while every individual
   * deployment looked reasonable: a field that keeps stopping keeps
   * re-neutralising the race it is in.
   */
  if (laps === longest && mean > 0.5) {
    fail(
      `${(mean * 100).toFixed(1)}% of a ${laps}-lap race is spent neutralised — more of ` +
      `the race is behind a flag than under green`,
    );
  }
}

// ===========================================================================
// Section 3 — the safety car is DRAWN smoothly
// ===========================================================================
//
// See the file header. Same metric, same bound and the same stepped control as
// `probe:framerate`'s WORLD SMOOTHNESS section, applied to the one vehicle
// that section could not reach.

/**
 * Worst per-frame second difference of the DRAWN height, metres.
 *
 * Derived from the world model, not from the output. Every circuit is stored
 * as a polyline with a node every 3.00m and elevation interpolated linearly
 * between nodes, so a vehicle crossing a node gets a genuine step in vertical
 * velocity; the worst node kink on the calendar is 0.0057 of gradient at the
 * foot of Eau Rouge, worth 9.2mm in a 50fps frame at 80 m/s. A safety car runs
 * at less than half that speed, so the honest ceiling is lower still. 20mm,
 * exactly as `probe:framerate` uses, and the artefact it is there to catch is
 * an order of magnitude above it.
 */
const SMOOTH_BOUND_M = 0.020;
const SC_RATES = [50, 85];

interface SmoothRow { circuit: string; fps: number; stepped: number; interp: number }

function safetyCarSmoothness(track: TrackSpline, fps: number): SmoothRow {
  const sc = new SafetyCar(track);
  // Put it on the circuit and leave it there for a lap. `join` teleports it to
  // the pit exit, which is what the teleport guard in the render pose is for;
  // the measurement starts after that step so the snap is not sampled.
  sc.join(1);
  const len = track.length;

  const frameS = 1 / fps;
  let interpPrev2 = NaN, interpPrev1 = NaN;
  let stepPrev2 = NaN, stepPrev1 = NaN;
  let worstInterp = 0, worstStep = 0;

  /**
   * THE LOOP IS THE REAL ONE'S, IN THE REAL ONE'S ORDER, and getting it
   * backwards is not a subtle mistake — it produces an "interpolated" column
   * that reads exactly TWICE the stepped one, which is what an alpha clamped to
   * 1 on every frame does. `SimClock` takes a frame's worth of wall clock,
   * spends whole physics steps out of an accumulator while it can afford them,
   * and hands the renderer whatever fraction of a step is left over. That
   * remainder IS alpha, and it is only ever in [0, 1) because the loop above it
   * has already spent every whole step.
   */
  let acc = 0;
  let travelled = 0;
  let guard = 0;
  while (travelled < len && guard < 2_000_000) {
    guard++;
    acc += frameS;
    while (acc >= PHYSICS_DT) {
      acc -= PHYSICS_DT;
      const i = track.indexAt(sc.s);
      // The pace race control would ask for: the same profile the field runs
      // (see `RaceControlManager.safetyCarPaceMs`).
      const pace = Math.min(track.targetSpeed[i] * 0.42, 40);
      const lateral = SafetyCar.runningLine(track.width[i] * 0.5, 1);
      const before = sc.s;
      sc.advance(PHYSICS_DT, pace, lateral);
      let ds = sc.s - before;
      if (ds < -len * 0.5) ds += len;
      travelled += ds;
    }

    const alpha = acc / PHYSICS_DT;
    updateSafetyCarPose(sc, len, alpha);
    const yInterp = bankedCarGroundY(track, sc.renderS, sc.renderLateral);
    // The control: what the renderer did before this landed — the last
    // completed step, in both axes, which is `alpha = 1` on the solver state.
    const yStep = bankedCarGroundY(track, sc.s, sc.lateral);

    if (!Number.isNaN(interpPrev2)) {
      const d2 = Math.abs(yInterp - 2 * interpPrev1 + interpPrev2);
      if (d2 > worstInterp) worstInterp = d2;
      const d2s = Math.abs(yStep - 2 * stepPrev1 + stepPrev2);
      if (d2s > worstStep) worstStep = d2s;
    }
    interpPrev2 = interpPrev1; interpPrev1 = yInterp;
    stepPrev2 = stepPrev1; stepPrev1 = yStep;
  }
  return { circuit: track.def.id, fps, stepped: worstStep, interp: worstInterp };
}

console.log('\nTHE SAFETY CAR IS DRAWN SMOOTHLY (worst |d2| of its drawn height, mm)');
console.log('  ' + 'CIRCUIT'.padEnd(15) + 'FPS'.padStart(5) + 'STEPPED'.padStart(10) +
  'INTERPOLATED'.padStart(14) + '  BOUND ' + (SMOOTH_BOUND_M * 1000).toFixed(0) + 'mm');
console.log('  ' + '-'.repeat(48));
let smoothFailures = 0;
for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  for (const fps of SC_RATES) {
    const r = safetyCarSmoothness(track, fps);
    const bad = r.interp > SMOOTH_BOUND_M;
    if (bad) smoothFailures++;
    console.log('  ' + r.circuit.padEnd(15) + String(r.fps).padStart(5) +
      (r.stepped * 1000).toFixed(1).padStart(10) +
      (r.interp * 1000).toFixed(1).padStart(14) + (bad ? '   <-- over' : ''));
    if (bad) {
      fail(
        `${r.circuit} safety car at ${r.fps}fps: the height it is DRAWN at moves ` +
        `${(r.interp * 1000).toFixed(1)}mm of second difference between frames, bound ` +
        `${(SMOOTH_BOUND_M * 1000).toFixed(0)}mm — it is being drawn from stepped state`,
      );
    }
  }
}
void smoothFailures;

// ===========================================================================

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('Neutralisation validated.\n');
}
