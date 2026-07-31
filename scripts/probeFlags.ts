/**
 * Does the field actually obey the flags?
 *
 * `RaceControlManager` implements the safety car, the VSC and the yellow flag
 * regime with the articles cited in the source. That says what the code intends.
 * It does not say what twenty cars do when the flag goes up, and those are
 * different questions — a lift factor applied to a target speed that some other
 * limit was already below changes nothing, an overtaking ban that the AI's
 * OVERTAKE state never consults is decoration, and a ten-car-length queue rule
 * is worth exactly as much as the gaps it actually produces.
 *
 * So this measures behaviour, not intent.
 *
 * HOW THE INCIDENTS ARE STAGED
 *
 * Waiting for a natural safety car is not a test, it is a lottery: a five-lap
 * race might produce none and a different seed might produce four. Instead a
 * single car is retired at a chosen point on the circuit, which is the exact
 * condition `updateIncidentFlags` reacts to, and everything downstream — the
 * yellows, the choice between VSC and safety car, the phases, the restart — runs
 * on its own. Nothing about race control is stubbed or forced.
 *
 * Where the car is left decides which response the regulations call for, and
 * that is the regulation's own test, not the probe's:
 *
 *   fast section, near the track   immediate physical danger  -> SAFETY CAR
 *                                  (Art. 55.3 / B5.13.1)
 *   slow section, well off it      double yellows needed, but -> VSC
 *                                  not safety car circumstances
 *                                  (Art. 56.1a / B5.12)
 *   qualifying                     no neutralisation exists   -> YELLOW ONLY
 *
 * The marshals are held back for the measurement window — a stopped car is
 * craned away after 22 seconds, which is not long enough to gather a
 * distribution — by keeping its recovery timer at zero. That is the only thing
 * about the simulation this probe touches.
 *
 * THREE MEASUREMENT TRAPS, AND WHAT IS DONE ABOUT THEM
 *
 * 1. WHERE. "Cars are 12% slower under yellow" is meaningless without saying
 *    where. A marshalling sector containing a hairpin has cars at 60 km/h under
 *    green; a sector that is all straight has them at 330. So every pace
 *    comparison is paired by (car, marshalling sector): the same driver, on the
 *    same piece of road, green against flagged. Nothing else is compared.
 *
 * 2. WHO. In qualifying half the field is on an out-lap at any moment, and an
 *    out-lap is thirty seconds slower than a flying one for reasons that have
 *    nothing to do with flags. Out-laps, pit-lane laps and the stationary grid
 *    are excluded from pace entirely.
 *
 * 3. WHAT COUNTS AS A PASS. A car gaining a position because the car ahead
 *    pitted is not an overtake, and under a safety car half the field pits. So a
 *    pass is only counted when it is an adjacent swap between two cars that are
 *    both on the circuit and neither of which has been in the pit lane in the
 *    last thirty seconds. Cars waved past under Art. 55.14 are counted
 *    separately, because for them passing is the instruction rather than the
 *    offence.
 *
 * Run: npm run validate:flags
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/** The flag regime a car is driving under at this instant. */
type Bucket = 'GREEN' | 'YEL' | '2YEL' | 'VSC' | 'SC';

/** Seconds after leaving the pit lane before a car's positions count again. */
const PIT_BLACKOUT_S = 30;

/** How far clear a car must be before a pass is treated as completed, metres. */
const PASS_CLEAR_M = 3;

/**
 * How close two cars must be on the road for a change of classification to be
 * an overtake, metres.
 *
 * Under three car lengths. Two things make this necessary rather than fussy.
 * Cars half a circuit apart share a lap count, so one pulling away from the
 * other changes the classification without either going near the other. And
 * `totalDistance` is accumulated per step with a guard that discards
 * implausible jumps, so it drifts a few metres from `lap * length + s` over a
 * race — enough that two cars forty metres apart can cross over in the
 * classification while nothing whatsoever happens on the road.
 *
 * A real overtake has the two cars alongside. Fifteen metres is also inside
 * `NO_PASS_HOLD_M`, so any pass this counts is one the hold was supposed to
 * have prevented.
 */
const PASS_PROXIMITY_M = 15;

/** Seconds after a flag changes during which a pass counts as transitional. */
const TRANSITION_S = 8;

interface Cell { sum: number; n: number; }

class Measurement {
  /** pace[bucket] keyed by "carIndex:sector". */
  private readonly pace = new Map<Bucket, Map<string, Cell>>();

  /** Complete laps run entirely under one regime, keyed by bucket. */
  readonly lapTimes = new Map<Bucket, number[]>();

  /** Passes completed while overtaking was forbidden, keyed by the regime. */
  readonly illegalByBucket = new Map<Bucket, number>();
  legalUnlapPasses = 0;
  greenPasses = 0;
  /** Passes of a car that had gone off or was crawling — not a real overtake. */
  passesOfDisabledCars = 0;
  /** Classification changes between cars nowhere near each other on the road. */
  distanceGains = 0;
  /** Passes completed in the first seconds of a flag, by cars already alongside. */
  transitionalPasses = 0;

  get illegalPasses(): number {
    let n = 0;
    for (const v of this.illegalByBucket.values()) n += v;
    return n;
  }

  illegalIn(bucket: Bucket): number {
    return this.illegalByBucket.get(bucket) ?? 0;
  }

  readonly scFormUpGaps: number[] = [];
  /** Largest lead-lap queue seen while forming up. */
  queueSize = 0;
  readonly phaseSeconds = new Map<string, number>();

  lappedAtWave = -1;
  wavedCars = 0;
  unlappedInTime = 0;
  waveHappened = false;

  deltaPenalties = 0;
  readonly messages: string[] = [];
  readonly passDetail: string[] = [];

  addPace(bucket: Bucket, car: number, sector: number, ratio: number): void {
    let m = this.pace.get(bucket);
    if (!m) { m = new Map(); this.pace.set(bucket, m); }
    const key = car + ':' + sector;
    const cell = m.get(key) ?? { sum: 0, n: 0 };
    cell.sum += ratio;
    cell.n++;
    m.set(key, cell);
  }

  addLap(bucket: Bucket, time: number): void {
    const list = this.lapTimes.get(bucket) ?? [];
    list.push(time);
    this.lapTimes.set(bucket, list);
  }

  /**
   * Mean pace under `a` and under `b`, over the (car, sector) pairs that have a
   * real sample under both. Returns null when they never overlap.
   */
  comparePace(a: Bucket, b: Bucket): { a: number; b: number; pairs: number } | null {
    const ma = this.pace.get(a);
    const mb = this.pace.get(b);
    if (!ma || !mb) return null;
    let sa = 0, na = 0, sb = 0, nb = 0, pairs = 0;
    for (const [key, ca] of ma) {
      const cb = mb.get(key);
      // A couple of samples is noise. Require a second of data on each side —
      // ten samples at the 10Hz this is gathered at.
      if (!cb || ca.n < 10 || cb.n < 10) continue;
      sa += ca.sum; na += ca.n;
      sb += cb.sum; nb += cb.n;
      pairs++;
    }
    if (pairs === 0) return null;
    return { a: sa / na, b: sb / nb, pairs };
  }

  meanLap(bucket: Bucket): number {
    const l = this.lapTimes.get(bucket);
    if (!l || l.length === 0) return 0;
    return l.reduce((x, y) => x + y, 0) / l.length;
  }
}

interface Staging {
  atS: number;
  dangerous: boolean;
  holdS: number;
  cripple?: { slot: number; health: number }[];
}

/**
 * Picks a distance along the lap that satisfies the danger test, or fails it.
 *
 * `updateNeutralisation` asks two questions of a stopped car: is the racing line
 * quick here, and is the car near the track. This finds a point that answers
 * both the way the scenario wants.
 */
function stagePoint(engine: RaceEngine, dangerous: boolean): number {
  const t = engine.track;
  let best = 0;
  let bestScore = dangerous ? -Infinity : Infinity;
  for (let i = 0; i < t.count; i += 4) {
    const v = t.targetSpeed[i];
    const s = (i / t.count) * t.length;
    // Keep clear of the pit lane, where a stopped car is not on the circuit.
    const pit = t.def.pitLane;
    const fromEntry = loopDelta(pit.entryS, s, t.length);
    if (fromEntry >= 0 && fromEntry < t.length * 0.5 && loopDelta(s, pit.exitS, t.length) >= 0) {
      continue;
    }
    if (dangerous ? v > bestScore : v < bestScore) { bestScore = v; best = s; }
  }
  return best;
}

function bucketFor(engine: RaceEngine, car: CarEntry): Bucket {
  const rc = engine.raceControl;
  if (rc.neutralisation === 'safety-car') return 'SC';
  if (rc.neutralisation === 'vsc') return 'VSC';
  const y = rc.yellowLevelAt(car.s);
  return y === 2 ? '2YEL' : y === 1 ? 'YEL' : 'GREEN';
}

function runScenario(
  name: string,
  circuitId: string,
  kind: 'race' | 'qualifying',
  laps: number,
  durationS: number,
  seed: number,
  staging: Staging,
): Measurement {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind,
    name,
    durationS,
    laps,
    playerIndex: -1,
    standingStart: kind === 'race',
    pitLaneStart: kind !== 'race',
    seed,
    ...(kind === 'qualifying' ? { qualifyingPhase: 1 as const } : {}),
  };
  const engine = new RaceEngine(def, config);
  const rc = engine.raceControl;
  const m = new Measurement();

  // A car with a broken engine genuinely loses a lap over a race distance, and
  // that is the only honest way to have lapped cars present when the safety car
  // comes out. This uses the real damage model, applied through the same
  // `applyTo` the simulation uses when a car is hit.
  for (const c of staging.cripple ?? []) {
    const car = engine.cars[c.slot];
    if (!car) continue;
    car.damage.health.engine = c.health;
    car.physics.spec = car.damage.applyTo(car.physics.baseSpec);
  }

  let victim: CarEntry | null = null;
  let stagedAt = 0;
  /** Session time the current flag regime began, for the transition window. */
  let regimeStartedAt = 0;
  let regime: string = 'GREEN';
  /** When each marshalling sector's signal last changed, and to what. */
  const sectorSince = new Array<number>(rc.marshalSectorCount).fill(0);
  const sectorSignal = new Array<string>(rc.marshalSectorCount).fill('green');
  // Identity, not an index. The race control log is a bounded ring that SHIFTS,
  // so "everything past index n" silently stops finding anything the moment the
  // log wraps — which with twenty cars and track-limit warnings is within a lap,
  // and it is why the first version of this probe reported no race control
  // messages at all for a session that plainly had a safety car in it.
  const seenMessages = new Set<unknown>();

  const n = engine.cars.length;
  /** Session time each car was last in the pit lane. */
  const lastPitTime = new Array<number>(n).fill(-1e9);
  /** Confirmed running order, updated only when a car is clear of another. */
  const confirmed = engine.standings.map((c) => c.index);
  /** Regime at the start of each car's current lap, and whether it held. */
  const lapBucket = new Array<Bucket | null>(n).fill(null);
  const lapPure = new Array<boolean>(n).fill(true);
  const lapCount = engine.cars.map((c) => c.lap);
  /** True once this car has spent part of its current lap closing a gap. */
  const lapCatchingUp = new Array<boolean>(n).fill(false);
  const wasLapped = new Set<number>();

  const maxSteps = Math.round(
    (kind === 'race' ? laps * def.referencePoleTimeS * 3.4 : durationS + 60) / PHYSICS_DT,
  );
  let steps = 0;

  while (!engine.over && steps < maxSteps) {
    engine.step();
    steps++;

    // --- Stage the incident ----------------------------------------------
    if (!victim && engine.time >= staging.atS &&
        rc.neutralisation === 'none' && rc.activeIncidents === 0 &&
        engine.cars.every((c) => !c.retired || c.recovered)) {
      // The last classified car, so the incident does not distort the fight at
      // the front more than a real one would.
      const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
      const candidate = running[running.length - 1];
      if (candidate) {
        victim = candidate;
        stagedAt = engine.time;
        const s = stagePoint(engine, staging.dangerous);
        const half = engine.track.halfWidthAt(s);
        victim.retire('Probe: staged incident', engine.time);
        victim.s = s;
        // Just off the road for a dangerous stop (inside the "near the track"
        // radius), well into the run-off for a benign one.
        victim.lateral = staging.dangerous ? half + 1.6 : half + 9;
        victim.physics.velocity.set(0, 0);
        m.messages.push('t=' + engine.time.toFixed(0) + 's  [probe] staged ' +
          (staging.dangerous ? 'dangerous' : 'benign') + ' incident, ' +
          victim.driver.code + ' stopped at s=' + s.toFixed(0) + 'm');
      }
    }
    if (victim && engine.time - stagedAt < staging.holdS) {
      victim.recovered = false;
      victim.recoveryTimer = 0;
    }

    // --- Race control messages -------------------------------------------
    for (const msg of rc.messages) {
      if (seenMessages.has(msg)) continue;
      seenMessages.add(msg);
      if (/SAFETY CAR|VSC|GREEN|LAPPED|RED FLAG|LOW VISIBILITY/i.test(msg.text)) {
        m.messages.push('t=' + msg.time.toFixed(0) + 's  ' + msg.text);
      }
      if (/below the delta/i.test(msg.text) && /penalty/i.test(msg.text)) m.deltaPenalties++;
    }

    if (rc.neutralisation === 'safety-car') {
      m.phaseSeconds.set(rc.scPhase, (m.phaseSeconds.get(rc.scPhase) ?? 0) + PHYSICS_DT);
    }

    const nowRegime = rc.neutralisation !== 'none' ? rc.neutralisation : 'green';
    if (nowRegime !== regime) { regime = nowRegime; regimeStartedAt = engine.time; }
    for (let i = 0; i < sectorSince.length; i++) {
      const sig = rc.signalForSector(i);
      if (sig !== sectorSignal[i]) { sectorSignal[i] = sig; sectorSince[i] = engine.time; }
    }

    // --- Lap timing under a constant regime -------------------------------
    for (const car of engine.cars) {
      if (car.retired || car.eliminated) continue;
      const b = bucketFor(engine, car);
      if (car.inPitLane) lastPitTime[car.index] = engine.time;
      if (lapBucket[car.index] === null) lapBucket[car.index] = b;
      else if (lapBucket[car.index] !== b) lapPure[car.index] = false;
      // A car more than the queue limit behind the car in front is closing a
      // gap, which is quicker than the queue pace by design (Art. 55.7 requires
      // it to close). Its lap is not a safety car lap.
      if (rc.neutralisation === 'safety-car' &&
          car.perception.ahead && car.perception.ahead.gapM > 10 * 5.6) {
        lapCatchingUp[car.index] = true;
      }
      if (car.lap < (engine.standings[0]?.lap ?? 0)) lapCatchingUp[car.index] = true;

      if (car.lap !== lapCount[car.index]) {
        // A lap the car spent entirely under one flag regime, that was not an
        // out-lap and did not involve the pit lane, is the only lap whose time
        // says anything about that regime.
        const pure = lapPure[car.index];
        const bucket = lapBucket[car.index];
        const clean = engine.time - lastPitTime[car.index] > car.lastLapTime + 1;
        if (pure && bucket && clean && !lapCatchingUp[car.index] && car.lastLapTime > 5) {
          m.addLap(bucket, car.lastLapTime);
        }
        lapCount[car.index] = car.lap;
        lapBucket[car.index] = b;
        lapPure[car.index] = true;
        lapCatchingUp[car.index] = false;
      }
    }

    // The moment lapped cars are told to go.
    if (rc.lappedCarsWaved && !m.waveHappened) {
      m.waveHappened = true;
      m.wavedCars = engine.cars.filter((c) => c.mustUnlap).length;
      const leader = engine.standings[0];
      m.lappedAtWave = leader
        ? engine.cars.filter((c) => !c.retired && !c.inPitLane && c.lap < leader.lap).length
        : 0;
      for (const c of engine.cars) if (c.mustUnlap) wasLapped.add(c.index);
    }
    if (m.waveHappened) {
      for (const idx of wasLapped) {
        const c = engine.cars[idx];
        if (c && !c.mustUnlap) { wasLapped.delete(idx); m.unlappedInTime++; }
      }
    }

    // --- Sample at 10Hz ---------------------------------------------------
    if (steps % 12 !== 0) continue;

    // --- Pace -------------------------------------------------------------
    for (const car of engine.cars) {
      if (car.retired || car.inPitLane || car.eliminated) continue;
      if (!engine.started || car.releaseTimer > 0) continue;
      // An out-lap is slow for reasons that have nothing to do with flags.
      if (car.onOutLap || engine.time - lastPitTime[car.index] < PIT_BLACKOUT_S) continue;

      const idx = engine.track.indexAt(car.s);
      const target = engine.track.targetSpeed[idx];
      if (target > 1) {
        m.addPace(bucketFor(engine, car), car.index, rc.sectorIndexAt(car.s),
          car.physics.speedMs / target);
      }
    }

    // --- Overtaking -------------------------------------------------------
    //
    // Held as a CONFIRMED order with a deadband, not as a comparison against
    // the previous sample. In a slow safety car queue two cars sit within a car
    // length of each other for minutes and the classification flickers between
    // them a dozen times; comparing consecutive samples counts every flicker as
    // an overtake. A car is only recorded as having passed another once it is
    // clear of it by more than half a car length, and the confirmed order is
    // only updated then, so the flicker resolves to nothing.
    for (let pass = 0; pass < confirmed.length; pass++) {
      let swapped = false;
      for (let i = 0; i + 1 < confirmed.length; i++) {
        const b = engine.cars[confirmed[i]];
        const a = engine.cars[confirmed[i + 1]];
        if (a.totalDistance - b.totalDistance <= PASS_CLEAR_M) continue;

        confirmed[i] = a.index;
        confirmed[i + 1] = b.index;
        swapped = true;

        if (a.retired || b.retired || a.inPitLane || b.inPitLane) continue;
        if (engine.time - lastPitTime[a.index] < PIT_BLACKOUT_S) continue;
        if (engine.time - lastPitTime[b.index] < PIT_BLACKOUT_S) continue;
        if (a.lap !== b.lap) continue;
        // Two cars with the same lap count can be half a circuit apart, and one
        // pulling away from the other then shows up as a change of
        // classification. An overtake happens between cars that are next to each
        // other on the road, so that is the test.
        const roadGap = loopDelta(b.s, a.s, engine.track.length);
        if (roadGap < 0 || roadGap > PASS_PROXIMITY_M) {
          m.distanceGains++;
          continue;
        }

        if (rc.overtakingBannedAt(a.s) || a.holdUntilLine) {
          // A car waved past is REQUIRED to overtake — Art. 55.14 / B5.13.4c.
          // Counting that as a violation would be counting compliance.
          if (a.mustUnlap) { m.legalUnlapPasses++; continue; }

          // Passing a car that has spun, gone off, or is crawling is not the
          // offence the overtaking ban is about, and no steward has ever
          // penalised it — you cannot be required to queue behind a car that is
          // no longer racing. Measured at Monza, every "illegal pass" reported
          // by the first version of this check was a lap-one incident: one car
          // at 13 m/s and a queue of healthy cars going round it.
          const bTarget = engine.track.targetSpeed[engine.track.indexAt(b.s)];
          const bHalf = engine.track.halfWidthAt(b.s);
          // The 14 m/s floor is the same one the AI uses to decide a car ahead
          // has stopped racing (`NO_PASS_MIN_AHEAD_MS`). The probe must not
          // score as a violation the one case the rule deliberately permits.
          const neutralFloor = rc.neutralisation !== 'none' ? rc.vscTargetMs * 0.5 : 0;
          if (b.physics.speedMs < bTarget * 0.45 || b.physics.speedMs < 14 ||
              b.physics.speedMs < neutralFloor || Math.abs(b.lateral) > bHalf) {
            m.passesOfDisabledCars++;
            continue;
          }

          const bucket = bucketFor(engine, a);
          // A pass completed in the first few seconds of a flag is a driver who
          // was already alongside when it came out. A car doing 300 km/h cannot
          // be un-alongside instantly, and in a real race the stewards deal
          // with it by ordering the position back rather than by expecting the
          // manoeuvre to evaporate. Counted, but counted separately: the
          // question the ban is really asking is whether cars pass each other
          // once the field has settled under the flag.
          const flagAge = Math.min(
            engine.time - regimeStartedAt,
            engine.time - sectorSince[rc.sectorIndexAt(a.s)],
          );
          if (flagAge < TRANSITION_S) {
            m.transitionalPasses++;
            continue;
          }
          m.illegalByBucket.set(bucket, (m.illegalByBucket.get(bucket) ?? 0) + 1);
          if (m.passDetail.length < 8) {
            m.passDetail.push(
              't=' + engine.time.toFixed(0) + 's ' + a.driver.code + ' passed ' + b.driver.code +
              ' — ' + rc.neutralisation + '/' + rc.scPhase +
              ' gapAhead=' + (a.perception.ahead ? a.perception.ahead.gapM.toFixed(1) : 'none') +
              'm v=' + a.physics.speedMs.toFixed(1) + '/' + b.physics.speedMs.toFixed(1) +
              ' hold=' + a.holdUntilLine,
            );
          }
        } else {
          m.greenPasses++;
        }
      }
      if (!swapped) break;
    }

    // --- Safety car queue -------------------------------------------------
    if (rc.neutralisation === 'safety-car' &&
        (rc.scPhase === 'bunching' || rc.scPhase === 'waving-lapped')) {
      const leadLap = engine.standings[0]?.lap ?? 0;
      const queue = engine.standings.filter(
        (c) => !c.retired && !c.inPitLane && c.lap >= leadLap,
      );
      m.queueSize = Math.max(m.queueSize, queue.length);
      for (let i = 1; i < queue.length; i++) {
        const gap = loopDelta(queue[i].s, queue[i - 1].s, engine.track.length);
        if (gap > 0 && gap < engine.track.length * 0.5) m.scFormUpGaps.push(gap);
      }
    }
  }

  return m;
}

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

function reportPace(m: Measurement, from: Bucket, to: Bucket, label: string): number | null {
  const c = m.comparePace(from, to);
  if (!c) {
    console.log('  ' + label.padEnd(32) + 'no paired samples — not measured');
    return null;
  }
  const drop = 1 - c.b / c.a;
  console.log(
    '  ' + label.padEnd(32) +
    (c.a * 100).toFixed(1) + '% -> ' + (c.b * 100).toFixed(1) + '% of line speed' +
    '   lift ' + pct(drop).padStart(7) + '   (' + c.pairs + ' car-sector pairs)',
  );
  return drop;
}

/**
 * Neutralised lap length as a multiple of a green one.
 *
 * Derived from the paired pace measurement rather than from lap times. Within
 * one marshalling sector, the time-weighted mean speed IS the distance over the
 * time, so the ratio of the green mean to the flagged mean over the same piece
 * of road is the ratio of the times taken to cross it — and averaged over every
 * (car, sector) pair with data on both sides, that is the lap ratio.
 *
 * Measuring whole lap times directly sounds more honest and is much worse: a lap
 * only counts if the flag held for its whole length AND the car neither pitted
 * nor spent the lap closing a gap, and across a fourteen-lap race that condition
 * is satisfied by almost nothing. The pace pairing has hundreds of samples.
 */
function reportLapRatio(m: Measurement, bucket: Bucket, label: string): number | null {
  const c = m.comparePace('GREEN', bucket);
  if (!c) {
    console.log('  ' + label.padEnd(32) + 'not measured');
    return null;
  }
  const ratio = c.a / c.b;
  const direct = m.meanLap(bucket);
  const green = m.meanLap('GREEN');
  console.log(
    '  ' + label.padEnd(32) + 'x' + ratio.toFixed(2) + ' a green lap' +
    (direct > 0 && green > 0
      ? '   (whole laps: ' + green.toFixed(1) + 's -> ' + direct.toFixed(1) + 's, x' +
        (direct / green).toFixed(2) + ')'
      : ''),
  );
  return ratio;
}

// ===========================================================================
// 1. Yellow flags, in qualifying — where no neutralisation can mask the lift
// ===========================================================================
console.log('\nYELLOW FLAGS (qualifying at Silverstone — no SC or VSC exists in a non-race)');
{
  const m = runScenario('Q1', 'silverstone', 'qualifying', 0, 480, 77001, {
    atS: 200, dangerous: true, holdS: 220,
  });

  const singles = reportPace(m, 'GREEN', 'YEL', 'single yellow vs green');
  const doubles = reportPace(m, 'GREEN', '2YEL', 'double yellow vs green');
  console.log('  ' + 'passes under a yellow'.padEnd(32) + m.illegalPasses);
  console.log('  ' + 'passes of a car that had gone off'.padEnd(32) + m.passesOfDisabledCars);
  console.log('  ' + 'passes under green'.padEnd(32) + m.greenPasses);

  // The regulations fix the ORDERING, not a number: a double yellow must be a
  // bigger lift than a single, and both must be discernible (Art. 26.1a/b /
  // B1.8.4a/b). "Discernible" is the stewards' word and is deliberately
  // qualitative, so the bar here is only that the lift is real.
  if (singles !== null && singles < 0.03) {
    fail(`single yellow produces only a ${pct(singles)} lift — not a discernible reduction`);
  }
  if (doubles !== null && singles !== null && doubles <= singles) {
    fail(`double yellow lift ${pct(doubles)} is not greater than single yellow ${pct(singles)}`);
  }
  if (m.illegalPasses > 0) {
    fail(`${m.illegalPasses} passes completed under a yellow flag — overtaking is forbidden`);
  }
}

// ===========================================================================
// 2. Virtual safety car — a stopped car somewhere slow and well off the road
// ===========================================================================
console.log('\nVIRTUAL SAFETY CAR (Bahrain, 10 laps — benign incident, Art. 56.1a / B5.12)');
{
  const m = runScenario('Grand Prix', 'bahrain', 'race', 10, 0, 77002, {
    atS: 90, dangerous: false, holdS: 200,
  });

  const drop = reportPace(m, 'GREEN', 'VSC', 'VSC vs green');
  const ratio = reportLapRatio(m, 'VSC', 'VSC lap time');
  console.log('  ' + 'passes under the VSC'.padEnd(32) + m.illegalIn('VSC'));
  console.log('  ' + 'passes as the flag came out'.padEnd(32) + m.transitionalPasses);
  console.log('  ' + 'passes under a local yellow'.padEnd(32) + m.illegalIn('YEL') + ' / ' +
    m.illegalIn('2YEL') + ' double');
  console.log('  ' + 'passes of a car that had gone off'.padEnd(32) + m.passesOfDisabledCars);
  console.log('  ' + 'passes under green'.padEnd(32) + m.greenPasses);
  console.log('  ' + 'delta penalties issued'.padEnd(32) + m.deltaPenalties);
  for (const d of m.passDetail) console.log('      ' + d);
  console.log('  race control:');
  for (const msg of m.messages.slice(0, 8)) console.log('    ' + msg);

  if (drop === null) {
    fail('the VSC was never deployed for a stopped car in a slow section');
  }
  // The one observable the pace constants can honestly be calibrated against:
  // a VSC lap runs about 1.4x a racing lap. See the note on SC_PACE_MS.
  if (ratio !== null && (ratio < 1.25 || ratio > 1.7)) {
    fail(`a VSC lap is x${ratio.toFixed(2)} a green lap — a real one is about x1.4`);
  }
  if (m.illegalIn('VSC') > 0) {
    fail(`${m.illegalIn('VSC')} passes completed under the VSC — Art. 56.5 forbids overtaking`);
  }
}

// ===========================================================================
// 3. Safety car — a stopped car in a fast section, right beside the track
// ===========================================================================
console.log('\nSAFETY CAR (Monza, 14 laps — dangerous incident, Art. 55.3 / B5.13.1)');
{
  // Two cars given a broken engine at the start, so that by the time the safety
  // car is deployed there are genuinely lapped cars in the field for the
  // unlapping procedure to act on.
  const m = runScenario('Grand Prix', 'monza', 'race', 14, 0, 77003, {
    atS: 520, dangerous: true, holdS: 60,
    cripple: [{ slot: 18, health: 0.45 }, { slot: 19, health: 0.4 }],
  });

  const drop = reportPace(m, 'GREEN', 'SC', 'safety car vs green');
  const ratio = reportLapRatio(m, 'SC', 'safety car lap time');
  console.log('  ' + 'passes under the safety car'.padEnd(32) + m.illegalIn('SC'));
  console.log('  ' + 'passes as the flag came out'.padEnd(32) + m.transitionalPasses);
  console.log('  ' + 'passes under a local yellow'.padEnd(32) + m.illegalIn('YEL') + ' / ' +
    m.illegalIn('2YEL') + ' double');
  console.log('  ' + 'passes by cars told to unlap'.padEnd(32) + m.legalUnlapPasses);
  console.log('  ' + 'passes of a car that had gone off'.padEnd(32) + m.passesOfDisabledCars);
  console.log('  ' + 'passes under green'.padEnd(32) + m.greenPasses);
  for (const d of m.passDetail) console.log('      ' + d);

  const gaps = m.scFormUpGaps.slice().sort((a, b) => a - b);
  const limit = 10 * 5.6; // ten car lengths, Art. 55.7 / B5.13.2b
  if (gaps.length > 0) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const over = gaps.filter((g) => g > limit).length / gaps.length;
    console.log(
      '  ' + 'form-up gap to car ahead'.padEnd(32) +
      'median ' + quantile(gaps, 0.5).toFixed(1) + 'm  mean ' + mean.toFixed(1) +
      'm  p90 ' + quantile(gaps, 0.9).toFixed(1) + 'm',
    );
    console.log('  ' + 'over the ten-car-length limit'.padEnd(32) + pct(over) +
      ' of samples (limit ' + limit.toFixed(0) + 'm)');
    console.log('  ' + 'cars on the lead lap in the queue'.padEnd(32) + m.queueSize);
    if (quantile(gaps, 0.5) > limit * 2) {
      fail(
        `median safety car gap ${quantile(gaps, 0.5).toFixed(0)}m is more than twice the ` +
        `ten-car-length limit — the field is not forming up`,
      );
    }
  } else {
    fail('the safety car was never deployed for a stopped car in a fast section');
  }

  console.log('  phases:');
  for (const [phase, secs] of m.phaseSeconds) {
    console.log('    ' + phase.padEnd(16) + secs.toFixed(1) + 's');
  }

  console.log('  ' + 'lapped cars at the wave'.padEnd(32) +
    (m.waveHappened ? m.lappedAtWave : 'no wave — nobody was a lap down'));
  if (m.waveHappened) {
    console.log('  ' + 'cars told to unlap themselves'.padEnd(32) + m.wavedCars);
    console.log('  ' + 'of those, back on the lead lap'.padEnd(32) + m.unlappedInTime);
    if (m.wavedCars !== m.lappedAtWave) {
      fail(
        `${m.lappedAtWave} cars were a lap down but ${m.wavedCars} were told to unlap — ` +
        `Art. 55.14 applies to all of them, not some`,
      );
    }
  }

  console.log('  race control:');
  for (const msg of m.messages.slice(0, 14)) console.log('    ' + msg);

  if (drop !== null && drop < 0.2) {
    fail(`safety car only slows the field by ${pct(drop)} — that is not a safety car`);
  }
  // A safety car lap is roughly 1.6 to 2 times a racing lap. This is the
  // number SC_PACE_MS exists to produce.
  if (ratio !== null && (ratio < 1.45 || ratio > 2.2)) {
    fail(`a safety car lap is x${ratio.toFixed(2)} a green lap — a real one is x1.6 to x2`);
  }
  if (m.illegalIn('SC') > 0) {
    fail(`${m.illegalIn('SC')} passes completed under the safety car — Art. 55.8 forbids it`);
  }
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('Flag compliance validated.\n');
}
