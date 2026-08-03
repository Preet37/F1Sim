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
 *   fast section, beside the road  immediate physical danger  -> SAFETY CAR
 *                                  (Art. 55.3 / B5.13.1)
 *   slow section, beside the road  double yellows needed, but -> VSC
 *                                  not safety car circumstances
 *                                  (Art. 56.1a / B5.12)
 *   qualifying                     no neutralisation exists   -> YELLOW ONLY
 *
 * Both race cases leave the car within the marshals' working clearance of the
 * white line, because that is what makes a recovery something the race has to
 * be slowed down for at all (see `src/race/Recovery.ts`); what separates them
 * is how fast the cars arrive there, which is the regulations' own distinction.
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
import {
  CATCHUP_HEADROOM, DELTA_REFERENCE_MARGIN, MEASURED_CONTROLLER_OVERSHOOT,
} from '../src/race/RaceControlManager';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import { installDomStub, readClasses } from './lib/domStub';
import { MarshalPosts } from '../src/render/MarshalPost';
import { TrackMap } from '../src/ui/TrackMap';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/**
 * Shifts every scenario seed, for judging a change against a DISTRIBUTION.
 *
 * A staged safety car is a twenty-car chaotic system: the form-up gap on one
 * seed is a sample, not a measurement, and a change that shifts the race by a
 * tenth of a second on lap one produces a different queue. Sweep the offset
 * (`FLAG_SEED_OFFSET=1 npm run validate:flags`, and so on) and compare the
 * distribution rather than arguing about one number.
 *
 * Zero by default, so the committed run is bit-identical to what it has always
 * been.
 */
const SEED_OFFSET = Number(process.env.FLAG_SEED_OFFSET ?? 0) | 0;

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

/**
 * The most delta penalties one race may hand out.
 *
 * Deliberately absolute rather than a rate. A race with three neutralisations in
 * it and twenty cars can legitimately produce a handful; it cannot legitimately
 * produce dozens, and any implementation that starts scaling with the count of
 * marshalling sectors — there are twenty of those per lap — sails past this
 * immediately, which is exactly what happened.
 */
const MAX_DELTA_PENALTIES = 12;

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
  /**
   * How far the leader was from the Line when the green came out, metres.
   *
   * Kept separately per regime because the regulations put them in different
   * places — see the note where they are recorded.
   */
  readonly scGreenToLineM: number[] = [];
  readonly vscGreenToLineM: number[] = [];
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

/**
 * Is this car a lap or more behind, measured in DISTANCE?
 *
 * The lap counter cannot answer this. A car ten metres behind the leader has a
 * lap counter one lower than the leader's for the ten metres either side of the
 * Line, and is not lapped by anybody.
 */
function isLapped(engine: RaceEngine, car: CarEntry, leader: CarEntry): boolean {
  const len = engine.track.length;
  return (leader.lap * len + leader.s) - (car.lap * len + car.s) >= len;
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
        // Just off the road either way — a stopped car the marshals have to
        // walk out to. What decides the response is where on the lap it is:
        // the same stop at the end of a straight is the safety car's case and
        // at a hairpin is the VSC's.
        victim.lateral = half + 1.6;
        victim.physics.velocity.set(0, 0);
        m.messages.push('t=' + engine.time.toFixed(0) + 's  [probe] staged ' +
          (staging.dangerous ? 'dangerous' : 'benign') + ' incident, ' +
          victim.driver.code + ' stopped at s=' + s.toFixed(0) + 'm');
      }
    }
    // Hold the marshals back for the measurement window.
    //
    // A recovery is now an operation with a duration (see `src/race/Recovery.ts`)
    // rather than a stopwatch, so holding it open means keeping work
    // outstanding: the marshals are at the car, the crane is not finished with
    // it, and the flag therefore stays out. `elapsedS` is pinned too, because
    // the operation carries a backstop that completes it regardless after three
    // and a half minutes and some of these windows are longer than that.
    //
    // This is the only thing about the simulation the probe touches.
    if (victim && engine.time - stagedAt < staging.holdS) {
      victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
      victim.recovery.elapsedS = 0;
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
    if (nowRegime !== regime) {
      // WHERE THE GREEN CAME OUT. A VSC may end anywhere on the lap: "at any
      // time between 10 and 15 seconds later, 'VSC' on the FIA light panels will
      // change to green and drivers may continue racing immediately" (Art. 56.7
      // / B5.12.4). A safety car period may not — it ends at the Line, and the
      // regulation names the place: "as the leader approaches the Line the
      // yellow flags will be withdrawn and a green flag and/or green light panel
      // will be displayed at the Line" (Art. 55.15 / B5.13.6).
      //
      // The distinction is the player's report, and until it was fixed the game
      // had the two the same: "the vsc ending can happen whenever but safety car
      // ends at the end of the lap". So this records the leader's distance along
      // the lap at the instant of every green, and the two regimes are asserted
      // separately below.
      const leaderNow = engine.standings[0];
      if (nowRegime === 'green' && leaderNow) {
        const toLine = engine.track.length - leaderNow.s;
        if (regime === 'sc-ending' || regime === 'safety-car') m.scGreenToLineM.push(toLine);
        else if (regime === 'vsc') m.vscGreenToLineM.push(toLine);
      }
      regime = nowRegime;
      regimeStartedAt = engine.time;
    }
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
      const leaderNow = engine.standings[0];
      if (leaderNow && isLapped(engine, car, leaderNow)) lapCatchingUp[car.index] = true;

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
        ? engine.cars.filter(
            (c) => !c.retired && !c.inPitLane && isLapped(engine, c, leader)).length
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
      // THE TRAIN, ordered by where the cars are on the ROAD.
      //
      // Not by the classification, which is a different order and was giving a
      // different answer. Art. 55.7 / B5.13.2b says "All F1 Cars must reduce
      // speed and form up behind the Safety Car no more than ten (10) car
      // lengths apart" — all of them, in one physical line, with the lapped
      // cars still in it because the unlapping procedure has not happened yet.
      // Walking the standings instead skips over every lapped car, so the pair
      // either side of one reads as a single gap spanning a piece of road that
      // has a car sitting in it: measured, a car whose real gap to the car in
      // front was 99m was recorded at 863m.
      //
      // The first gap is to the safety car itself, which is what the field is
      // forming up behind.
      const L = engine.track.length;
      const train: { behind: number }[] = [];
      for (const c of engine.cars) {
        if (c.retired || c.inPitLane) continue;
        // A car released from the pit lane rejoins into whatever gap happens to
        // be passing the exit. It is physically not in the queue yet and no
        // ten-car-length rule can apply to it until it has caught the train —
        // the same blackout, for the same reason, as the overtaking check.
        if (engine.time - lastPitTime[c.index] < PIT_BLACKOUT_S) continue;
        train.push({ behind: (((rc.scS - c.s) % L) + L) % L });
      }
      train.sort((a, b) => a.behind - b.behind);
      m.queueSize = Math.max(m.queueSize, train.length);
      for (let i = 1; i < train.length; i++) {
        const gap = train[i].behind - train[i - 1].behind;
        if (gap > 0) m.scFormUpGaps.push(gap);
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
// ===========================================================================
// 0. The two constants that must not cross.
//
// A car closing on the safety car queue is told to run at `SC_CATCHUP_MULT`
// times the queue pace, and a car that crosses a marshalling sector faster than
// `DELTA_REFERENCE_MARGIN` times it is penalised. If the first is not provably
// under the second — INCLUDING the error of the controller doing the aiming —
// then the game issues penalties for compliance, and it did: measured over two
// races at Monza, 262 penalties, 256 of them from the delta check, fifteen of
// twenty cars carrying one. The player's report is "it seems like every driver
// there had a penalty".
//
// `RaceControlManager` derives one from the other and throws at load if they
// cross. This asserts the same relation from the outside, so that the invariant
// is checked by the thing that would notice it being broken as well as by the
// thing that would break it.
// ===========================================================================
console.log('\nTHE DELTA CONSTANTS');
{
  // Derived here the same way `RaceControlManager` derives it, from the exported
  // inputs, so the probe cannot silently drift onto a stale copy of the answer.
  const catchUp = DELTA_REFERENCE_MARGIN / CATCHUP_HEADROOM;
  const fastest = catchUp * MEASURED_CONTROLLER_OVERSHOOT;
  console.log('  ' + 'catch-up allowance'.padEnd(32) + 'x' + catchUp.toFixed(3) +
    ' the queue pace');
  console.log('  ' + 'reached with controller error'.padEnd(32) + 'x' + fastest.toFixed(3));
  console.log('  ' + 'penalty threshold'.padEnd(32) + 'x' + DELTA_REFERENCE_MARGIN.toFixed(3));
  console.log('  ' + 'headroom'.padEnd(32) +
    pct(DELTA_REFERENCE_MARGIN / fastest - 1) + ' inside the threshold');
  if (fastest >= DELTA_REFERENCE_MARGIN) {
    fail(
      `a car obeying the catch-up instruction reaches x${fastest.toFixed(3)} the queue ` +
      `pace against a penalty threshold of x${DELTA_REFERENCE_MARGIN.toFixed(3)} — ` +
      `every car closing a gap is penalised for closing it`,
    );
  }
}

console.log('\nYELLOW FLAGS (qualifying at Silverstone — no SC or VSC exists in a non-race)');
{
  const m = runScenario('Q1', 'silverstone', 'qualifying', 0, 480, 77001 + SEED_OFFSET, {
    atS: 200, dangerous: true, holdS: 220,
  });

  const singles = reportPace(m, 'GREEN', 'YEL', 'single yellow vs green');
  const singlePairs = m.comparePace('GREEN', 'YEL')?.pairs ?? 0;
  const doubles = reportPace(m, 'GREEN', '2YEL', 'double yellow vs green');
  console.log('  ' + 'passes under a yellow'.padEnd(32) + m.illegalPasses);
  console.log('  ' + 'passes of a car that had gone off'.padEnd(32) + m.passesOfDisabledCars);
  console.log('  ' + 'passes under green'.padEnd(32) + m.greenPasses);

  // The regulations fix the ORDERING, not a number: a double yellow must be a
  // bigger lift than a single, and both must be discernible (Art. 26.1a/b /
  // B1.8.4a/b). "Discernible" is the stewards' word and is deliberately
  // qualitative, so the bar here is only that the lift is real.
  //
  // BOTH CHECKS NEED ENOUGH DATA TO BE ABOUT ANYTHING, and the single-yellow
  // side often does not have it. The incident staged here is deliberately
  // dangerous — it is the only way to get a flag out in qualifying — so it sits
  // on the racing line and its posts show DOUBLE yellow. The single-yellow
  // bucket is then whatever fell either side of it, and it has been as low as
  // ONE (car, sector) pair. That one pair reported a 85.3% lift, which is not a
  // car lifting: it is a car that had stopped, or one crawling out of a run-off,
  // averaged over a sector with nothing to compare it against. On that evidence
  // the ordering check failed for a long time while every simulated car in the
  // field was in fact obeying both flags correctly.
  //
  // A statistic computed from one sample is not a measurement, and asserting on
  // it is not a test. Twenty pairs is the same order as the double-yellow side
  // usually collects, and below it the probe says so instead of guessing.
  const MIN_PAIRS = 20;
  if (singles !== null && singlePairs < MIN_PAIRS) {
    console.log('  ' + 'single yellow'.padEnd(32) +
      `only ${singlePairs} car-sector pairs — not enough to judge, not asserted`);
  } else if (singles !== null && singles < 0.03) {
    fail(`single yellow produces only a ${pct(singles)} lift — not a discernible reduction`);
  }
  if (doubles !== null && singles !== null && singlePairs >= MIN_PAIRS &&
      doubles <= singles) {
    fail(`double yellow lift ${pct(doubles)} is not greater than single yellow ${pct(singles)}`);
  }
  if (m.illegalPasses > 0) {
    // The other two scenarios print the detail; this one did not, which made
    // the one failure it can produce impossible to diagnose from the report.
    for (const d of m.passDetail) console.log('      ' + d);
    fail(`${m.illegalPasses} passes completed under a yellow flag — overtaking is forbidden`);
  }
}

// ===========================================================================
// 2. Virtual safety car — a stopped car somewhere slow and well off the road
// ===========================================================================
console.log('\nVIRTUAL SAFETY CAR (Bahrain, 10 laps — benign incident, Art. 56.1a / B5.12)');
{
  const m = runScenario('Grand Prix', 'bahrain', 'race', 10, 0, 77002 + SEED_OFFSET, {
    atS: 90, dangerous: false, holdS: 200,
  });

  const drop = reportPace(m, 'GREEN', 'VSC', 'VSC vs green');
  const ratio = reportLapRatio(m, 'VSC', 'VSC lap time');
  if (m.vscGreenToLineM.length > 0) {
    // The contrast case, reported rather than asserted. A VSC ends "at any time
    // between 10 and 15 seconds" after the warning and the cars are wherever
    // they are (Art. 56.7 / B5.12.4); there is nothing to require of the place,
    // and requiring one would be importing the safety car's rule.
    console.log('  ' + 'green shown with the leader'.padEnd(32) +
      m.vscGreenToLineM.map((d) => d.toFixed(0) + 'm').join(', ') +
      ' from the Line (unconstrained — Art. 56.7 / B5.12.4)');
  }
  console.log('  ' + 'passes under the VSC'.padEnd(32) + m.illegalIn('VSC'));
  console.log('  ' + 'passes as the flag came out'.padEnd(32) + m.transitionalPasses);
  console.log('  ' + 'passes under a local yellow'.padEnd(32) + m.illegalIn('YEL') + ' / ' +
    m.illegalIn('2YEL') + ' double');
  console.log('  ' + 'passes of a car that had gone off'.padEnd(32) + m.passesOfDisabledCars);
  console.log('  ' + 'passes under green'.padEnd(32) + m.greenPasses);
  console.log('  ' + 'delta penalties issued'.padEnd(32) + m.deltaPenalties);
  if (m.deltaPenalties > MAX_DELTA_PENALTIES) {
    fail(
      `${m.deltaPenalties} delta penalties issued in one race under the VSC — ` +
      `Art. 56.5 / B5.12.2b is one decision from a four-item menu, not a charge per ` +
      `marshalling sector`,
    );
  }
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
  const m = runScenario('Grand Prix', 'monza', 'race', 14, 0, 77003 + SEED_OFFSET, {
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

  // WHERE THE SAFETY CAR PERIOD ENDED.
  //
  // "As the Safety Car is approaching the Pit Entry Road the SC boards will be
  // withdrawn and, other than on the last lap of the TTCS, as the leader
  // approaches the Line the yellow flags will be withdrawn and a green flag
  // and/or green light panel will be displayed at the Line" — 2026 Section B
  // Art. B5.13.6 / 2025 Sporting Regs Art. 55.15, final paragraph.
  //
  // The green is at the LINE. It is the one thing about a safety car period that
  // a VSC does not share — Art. 56.7 / B5.12.4 puts the VSC's green wherever the
  // cars happen to be, ten to fifteen seconds after the warning — and the game
  // had them the same until it was reported: "the vsc ending can happen whenever
  // but safety car ends at the end of the lap".
  //
  // The window is generous because the article's own word is APPROACHES: the
  // flag is out before the leader gets there, or nobody could see it and go.
  const SC_GREEN_WINDOW_M = 400;
  if (m.scGreenToLineM.length > 0) {
    const worst = Math.max(...m.scGreenToLineM);
    console.log('  ' + 'green shown with the leader'.padEnd(32) +
      m.scGreenToLineM.map((d) => d.toFixed(0) + 'm').join(', ') + ' from the Line');
    if (worst > SC_GREEN_WINDOW_M) {
      fail(
        `a safety car period went green with the leader ${worst.toFixed(0)}m from the Line — ` +
        `Art. 55.15 / B5.13.6 shows the green AT the Line, and that is the whole ` +
        `difference between a safety car and a VSC`,
      );
    }
  } else {
    fail('no safety car period ended during the measurement — the withdrawal is not covered');
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

  // HOW MANY PENALTIES A NEUTRALISATION HANDS OUT.
  //
  // "the stewards may impose either a 5-Second Penalty, a 10-Second Penalty, a
  // Drive-Through Penalty or a Stop-and-Go Penalty on any driver who fails to
  // stay above the minimum time" (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b) is
  // one decision from a menu. It was implemented as a charge per marshalling
  // sector, and there are twenty of those a lap: measured over two races at
  // Monza, 262 penalties, 256 of them from the delta check, none at all from the
  // stewards or track limits, and fifteen of twenty cars carrying one. One car
  // held twelve.
  console.log('  ' + 'delta penalties issued'.padEnd(32) + m.deltaPenalties);
  if (m.deltaPenalties > MAX_DELTA_PENALTIES) {
    fail(
      `${m.deltaPenalties} delta penalties issued in one race under the safety car — ` +
      `Art. 55.7 / B5.13.2b is one decision from a four-item menu, not a charge per ` +
      `marshalling sector`,
    );
  }
}

// ===========================================================================
// 4. What the signals actually SHOW
// ===========================================================================
//
// Everything above this line measures what the CARS do about a flag. That was
// the whole of this probe, and it left the obvious gap: the AI can lift
// perfectly for a yellow the player is never shown. The report was exactly
// that —
//
//   "you have the green flag everywhere but if there is a change in flag status
//    like say someone crashed out that sector signals should be yellow flags
//    no? it cant stay green signal if there is a yellow flag called"
//
// — and it is not a question the pace measurements can answer, because a
// perfectly obedient field and a stuck display look identical from the timing
// screen.
//
// So this section drives the real display objects: `MarshalPosts`, which is the
// trackside light panels, and `TrackMap`, which is the coloured circuit map,
// both fed from race control exactly as the renderer and the HUD feed them.
// Nothing here is a reimplementation — the map is built through a DOM stub and
// read back out of the SVG tree it produces, and the posts are read out of the
// instanced colour buffer that goes to the GPU. If either drifts from race
// control, or race control itself declares a road clear that still has a car
// sitting on it, this fails.
runDisplayCheck();

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('Flag compliance validated.\n');
}

/**
 * The colours two stacked panels are showing at one post, as a comparable key.
 *
 * The mapping from signal to colour lives in the renderer and is deliberately
 * not duplicated here. What is asserted instead is that the mapping is a
 * BIJECTION over a whole race: every sector under a yellow shows the same thing
 * as every other sector under a yellow, and it is not the thing a green sector
 * shows. That catches a stuck panel, an inverted lookup and a missed update
 * without this probe having an opinion about which shade of yellow is correct.
 */
function panelKey(colours: { getX(i: number): number; getY(i: number): number; getZ(i: number): number }, post: number): string {
  const parts: string[] = [];
  for (let p = 0; p < 2; p++) {
    const i = post * 2 + p;
    parts.push(
      colours.getX(i).toFixed(3) + ',' + colours.getY(i).toFixed(3) + ',' + colours.getZ(i).toFixed(3),
    );
  }
  return parts.join(' | ');
}

function runDisplayCheck(): void {
  console.log('\nWHAT THE SIGNALS SHOW (Monza, staged retirement on the racing line)');

  installDomStub();

  const def = getCircuit('monza');
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 8,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 77004 + SEED_OFFSET,
  };
  const engine = new RaceEngine(def, config);
  const rc = engine.raceControl;

  const posts = new MarshalPosts(engine.track, rc.marshalSectorCount);
  const map = new TrackMap(engine.track, engine.cars, rc.marshalSectorCount);
  // The panels are the first thing the post group adds; their instanced colour
  // buffer is what the GPU is handed, so it is what the driver sees.
  const panelMesh = posts.root.children[0] as unknown as {
    instanceColor: { getX(i: number): number; getY(i: number): number; getZ(i: number): number } | null;
  };

  /** signal -> the panel colours seen for it, and the reverse. */
  const signalToPanel = new Map<string, string>();
  const panelToSignal = new Map<string, string>();

  let samples = 0;
  let mapMismatches = 0;
  let postMismatches = 0;
  let chipUnderstatements = 0;
  /** Samples where a car was still lying there and its sector read green. */
  let greenOverWreck = 0;
  let wreckSamples = 0;
  /** Longest run of green-over-wreck, in seconds. */
  let greenOverWreckS = 0;
  const examples: string[] = [];

  let victim: CarEntry | null = null;
  const maxSteps = Math.round(8 * def.referencePoleTimeS * 3.4 / PHYSICS_DT);

  for (let step = 0; step < maxSteps && !engine.over; step++) {
    engine.step();

    // Stage one retirement, on the racing line rather than in the run-off.
    // That is the case the reported defect is about: a car stopped ON the road,
    // which is still there long after the race has been released.
    if (!victim && engine.time > 70) {
      const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
      victim = running[running.length - 1] ?? null;
      if (victim) {
        victim.retire('Probe: staged incident', engine.time);
        victim.physics.velocity.set(0, 0);
        victim.physics.localVelX = 0;
        victim.physics.localVelY = 0;
        console.log(
          '  staged: ' + victim.driver.code + ' stopped at s=' + victim.s.toFixed(0) +
          'm (marshalling sector ' + (rc.sectorIndexAt(victim.s) + 1) + '), lateral ' +
          victim.lateral.toFixed(1) + 'm of a ' +
          engine.track.halfWidthAt(victim.s).toFixed(1) + 'm half-width',
        );
      }
    }

    // The display is repainted at rendered-frame rate, not physics rate.
    if (step % 4 !== 0) continue;
    posts.update(rc);
    map.update(rc);
    samples++;

    const ribbons = readClasses(map.root as never, 'map-line flag-');
    const chips = readClasses(map.root as never, 'map-chip flag-');

    for (let i = 0; i < rc.marshalSectorCount; i++) {
      const signal = rc.signalForSector(i);

      // --- The map's ribbon for this sector ------------------------------
      const want = 'map-line flag-' + signal;
      if (ribbons[i] !== want) {
        mapMismatches++;
        if (examples.length < 6) {
          examples.push('map sector ' + (i + 1) + ' shows "' + ribbons[i] +
            '" while race control says ' + signal);
        }
      }

      // --- The trackside post for this sector ----------------------------
      if (panelMesh.instanceColor) {
        const key = panelKey(panelMesh.instanceColor, i);
        const seenFor = signalToPanel.get(signal);
        const meansOther = panelToSignal.get(key);
        if (seenFor !== undefined && seenFor !== key) {
          postMismatches++;
          if (examples.length < 6) {
            examples.push('post ' + (i + 1) + ' shows a different colour for ' + signal +
              ' than other posts under the same signal');
          }
        } else if (meansOther !== undefined && meansOther !== signal) {
          postMismatches++;
          if (examples.length < 6) {
            examples.push('post ' + (i + 1) + ' shows the ' + meansOther + ' colour while ' +
              'race control says ' + signal);
          }
        } else {
          signalToPanel.set(signal, key);
          panelToSignal.set(key, signal);
        }
      }
    }

    // --- The three timing-sector chips ------------------------------------
    // A chip may be WORSE than the road inside it (it takes the worst), but it
    // must never read greener.
    const bounds = [
      { from: 0, to: def.sector1EndS },
      { from: def.sector1EndS, to: def.sector2EndS },
      { from: def.sector2EndS, to: engine.track.length },
    ];
    for (let i = 0; i < 3; i++) {
      const shown = (chips[i] ?? '').replace('map-chip flag-', '');
      if (shown !== 'green') continue;
      const first = rc.sectorIndexAt(bounds[i].from);
      const last = rc.sectorIndexAt(bounds[i].to - 1);
      for (let k = first; ; k = (k + 1) % rc.marshalSectorCount) {
        if (rc.signalForSector(k) !== 'green') {
          chipUnderstatements++;
          if (examples.length < 6) {
            examples.push('timing sector ' + (i + 1) + ' chip reads green while marshalling ' +
              'sector ' + (k + 1) + ' inside it is ' + rc.signalForSector(k));
          }
          break;
        }
        if (k === last) break;
      }
    }

    // --- And the question underneath all of it ----------------------------
    // Is there a car lying ON THE ROAD under a green flag? `cleared` is the
    // race engine's own statement that the wreck has been taken away, and it is
    // the same clock the renderer stops drawing the car on, so a sector that
    // reads green while a car is not yet cleared is a green flag next to a car
    // the player can see out of the cockpit.
    //
    // Restricted to cars still near the racing surface, because that is what
    // race control undertakes to flag: a car that speared deep into a gravel
    // trap is behind the barriers with the marshals long before the crane
    // arrives, and asking for a two-minute yellow for it would be asking for
    // something wrong.
    for (const car of engine.cars) {
      if (!car.retired || car.cleared || car.inPitLane) continue;
      if (Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 4) continue;
      wreckSamples++;
      const sec = rc.sectorIndexAt(car.s);
      const local = rc.sectorFlags[sec];
      if (local === 'green') {
        greenOverWreck++;
        greenOverWreckS += PHYSICS_DT * 4;
        if (examples.length < 6) {
          examples.push(car.driver.code + ' has been stopped for ' +
            car.recoveryTimer.toFixed(0) + 's at s=' + car.s.toFixed(0) +
            'm and marshalling sector ' + (sec + 1) + ' is showing GREEN');
        }
      }
    }
  }

  posts.dispose();

  console.log('  ' + 'display samples'.padEnd(38) + samples);
  console.log('  ' + 'map sectors disagreeing with race control'.padEnd(38) + mapMismatches);
  console.log('  ' + 'trackside posts disagreeing'.padEnd(38) + postMismatches);
  console.log('  ' + 'timing chips reading greener than the road'.padEnd(38) + chipUnderstatements);
  console.log('  ' + 'samples with a car still lying on track'.padEnd(38) + wreckSamples);
  console.log('  ' + 'of those, sector showing green'.padEnd(38) + greenOverWreck +
    (greenOverWreck > 0 ? '   (' + greenOverWreckS.toFixed(0) + 's)' : ''));
  console.log('  ' + 'distinct signals displayed'.padEnd(38) +
    [...signalToPanel.keys()].sort().join(', '));
  for (const e of examples) console.log('      ' + e);

  if (mapMismatches > 0) {
    fail(`${mapMismatches} samples where the circuit map's colour did not match ` +
      `RaceControlManager.signalForSector — the display and race control have drifted apart`);
  }
  if (postMismatches > 0) {
    fail(`${postMismatches} samples where a trackside marshal post showed the wrong signal`);
  }
  if (chipUnderstatements > 0) {
    fail(`${chipUnderstatements} samples where a timing-sector chip read green while a piece ` +
      `of road inside it was flagged`);
  }
  if (greenOverWreck > 0) {
    fail(`${greenOverWreckS.toFixed(0)}s of green flag shown in a sector that still had a ` +
      `retired car lying in it — a car that has crashed out holds a yellow until it is ` +
      `actually taken away`);
  }
  if (!signalToPanel.has('yellow') && !signalToPanel.has('double-yellow')) {
    fail('no yellow was ever displayed anywhere, on a race with a staged retirement in it ' +
      '— the display is not being driven at all');
  }
}
