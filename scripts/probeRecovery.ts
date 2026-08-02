/**
 * Does a crashed car actually get cleared up?
 *
 * The player's question was the plain one — "if there is a crash for a car
 * that's not the user car, then it should probably clear the car up eventually
 * right?" — and the answer the code gave was "after exactly one hundred and
 * fifty seconds, everywhere, whatever happened". Two independent stopwatches in
 * two files, one in the race engine and one in the renderer, kept equal by hand
 * so that the yellow flag came down on the same frame the wreck stopped being
 * drawn. Nothing checked that they were equal, and nothing checked that either
 * had anything to do with a recovery.
 *
 * So this measures the recovery as an event with a beginning, a duration and an
 * end, and asserts the five things that make it one:
 *
 *   1. A car retires and a flag comes out IN ITS OWN MARSHALLING SECTOR.
 *   2. The wreck is there — `cleared` is false, which is the single fact the
 *      renderer draws the car on.
 *   3. Not one sample of green flag in that sector while the car is lying in it.
 *   4. The wreck is LATER GONE. Every scenario, every circuit, and inside a
 *      plausible time rather than eventually.
 *   5. The flag clears on the SAME STEP the wreck goes. Not a step before, not
 *      a step after, and not on a clock of its own.
 *
 * And the two things the recovery model claims that a flat timer could not:
 *
 *   6. Where the car stopped changes what it takes. A car beside the road is
 *      pushed away by marshals; a car buried in a gravel trap needs a crane and
 *      takes materially longer.
 *   7. The debris goes with the car. A corner declared clear does not still
 *      have a scatter of carbon on the racing line — measured on the real
 *      `Wreckage` instance buffer, cycled repeatedly, so a sweep that leaked
 *      pieces or grew the buffer would show up.
 *
 * And, since debris became an incident of its own rather than a rendering
 * effect, the three things that make bodywork nobody is coming to recover go
 * away anyway — which is a different defect from all of the above and the one
 * behind "why are there blue pieces everywhere":
 *
 *   8. A pile on the racing line RAISES A YELLOW at the post covering it, which
 *      is what sends anybody to it in the first place.
 *   9. It is then COLLECTED under that local yellow, with no recovery and no
 *      neutralisation involved, and the flag comes down when it goes.
 *  10. A pile in the RUN-OFF outlives one on the racing line by a long way,
 *      because nobody walks out for it until the race is slowed for something
 *      else. Real run-off collects carbon over a race distance.
 *
 * Circuits include a street circuit, where the run-off is a wall a metre from
 * the white line and every recovery is therefore the hard case.
 *
 * Run: npm run probe:recovery
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import { Wreckage } from '../src/render/Wreckage';
import { RECOVERY_BACKSTOP_S } from '../src/race/Recovery';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

/** Shifts every scenario seed, for judging against a distribution. */
const SEED_OFFSET = Number(process.env.RECOVERY_SEED_OFFSET ?? 0) | 0;

/** Where the car is left, as metres beyond the white line. */
type Site = 'roadside' | 'gravel';

const SITE_LATERAL_M: Record<Site, number> = {
  // Just off the road, the way a car with a broken engine is pulled over: the
  // marshals have to walk out to it and they are within a car's width of a
  // racing line while they do.
  roadside: 1.6,
  // Deep in the trap, nose-first. Nobody pushes this one anywhere.
  gravel: 14,
};

interface Result {
  circuit: string;
  site: Site;
  /** Marshalling sector the car stopped in. */
  sector: number;
  /** Session time of the retirement. */
  retiredAt: number;
  /** Seconds from the retirement to the first flag in its sector. */
  flagUpAfterS: number;
  /** Seconds from the retirement to the wreck being gone. -1 if never. */
  clearedAfterS: number;
  /** Seconds from the retirement to the sector going green. -1 if never. */
  flagDownAfterS: number;
  /** Samples with the car still lying there and the sector reading green. */
  greenOverWreck: number;
  /** Samples with the car lying there at all. */
  wreckSamples: number;
  method: string;
  neededNeutralisation: boolean;
  /** Neutralisation in force at the moment the recovery finished, if any. */
  neutralisationDuring: string;
  /** Another retired car was lying in the same sector — assertion 5 is unsafe. */
  contested: boolean;
}

function stagePoint(engine: RaceEngine, fast: boolean): number {
  const t = engine.track;
  let best = 0;
  let bestScore = fast ? -Infinity : Infinity;
  for (let i = 0; i < t.count; i += 4) {
    const v = t.targetSpeed[i];
    const s = (i / t.count) * t.length;
    // A stopped car in the pit lane is not on the circuit.
    const pit = t.def.pitLane;
    const fromEntry = loopDelta(pit.entryS, s, t.length);
    if (fromEntry >= 0 && fromEntry < t.length * 0.5 && loopDelta(s, pit.exitS, t.length) >= 0) {
      continue;
    }
    if (fast ? v > bestScore : v < bestScore) { bestScore = v; best = s; }
  }
  return best;
}

function runScenario(circuit: string, site: Site, seed: number): Result | null {
  const def = getCircuit(circuit);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 6,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config);
  const rc = engine.raceControl;

  let victim: CarEntry | null = null;
  const r: Result = {
    circuit, site, sector: -1, retiredAt: 0,
    flagUpAfterS: -1, clearedAfterS: -1, flagDownAfterS: -1,
    greenOverWreck: 0, wreckSamples: 0,
    method: '', neededNeutralisation: false, neutralisationDuring: 'none',
    contested: false,
  };

  const maxSteps = Math.round(6 * def.referencePoleTimeS * 3.6 / PHYSICS_DT);

  /**
   * Is anything OTHER than this recovery holding a yellow over these sectors?
   *
   * Three things can: another wreck, a car merely off and slow, and — since the
   * debris ledger moved into the simulation — a piece of bodywork lying on the
   * racing line, which is a hazard in its own right with its own operation and
   * its own flag. See `src/race/DebrisField.ts`. None of them is this recovery,
   * so a sector holding a yellow for one of them is not this recovery's flag
   * failing to come down, and assertion 5 has nothing to say about it.
   */
  const contestedNow = (): boolean => {
    const sec = r.sector;
    const prev = (sec + rc.marshalSectorCount - 1) % rc.marshalSectorCount;
    if (engine.cars.some((c) => c !== victim && c.retired && !c.cleared &&
      (rc.sectorIndexAt(c.s) === sec || rc.sectorIndexAt(c.s) === prev))) return true;
    if (engine.cars.some((c) => c !== victim && !c.retired && !c.inPitLane &&
      (rc.sectorIndexAt(c.s) === sec || rc.sectorIndexAt(c.s) === prev) &&
      Math.abs(c.lateral) > engine.track.halfWidthAt(c.s) + 1 &&
      c.physics.speedMs < 8)) return true;
    return engine.debris.piles.some((p) => p.signal !== null &&
      (rc.sectorIndexAt(p.s) === sec || rc.sectorIndexAt(p.s) === prev));
  };

  for (let step = 0; step < maxSteps && !engine.over; step++) {
    engine.step();

    // --- Stage exactly one retirement, once the field has settled ----------
    // Waits for a clean circuit rather than for a fixed moment: a car that had
    // its own accident on lap one leaves a flag of its own, and this scenario
    // is about one incident at a time.
    if (!victim && engine.time > 60 && rc.neutralisation === 'none' &&
        rc.activeIncidents === 0 && engine.cars.every((c) => !c.retired || c.cleared)) {
      // The last classified car, so the incident does not distort the fight at
      // the front more than a real one would.
      const running = engine.standings.filter((c) => !c.retired && !c.inPitLane);
      const candidate = running[running.length - 1];
      if (!candidate) continue;
      victim = candidate;
      // Deliberately a slow part of the lap for both sites. What is being
      // measured here is the RECOVERY, and putting the car at the end of a
      // straight would additionally decide the safety-car-versus-VSC question,
      // which `validate:flags` already measures.
      const s = stagePoint(engine, false);
      victim.retire('Probe: staged incident', engine.time, site === 'gravel' ? 0.4 : 0);
      victim.s = s;
      victim.lateral = engine.track.halfWidthAt(s) + SITE_LATERAL_M[site];
      victim.physics.velocity.set(0, 0);
      victim.physics.localVelX = 0;
      victim.physics.localVelY = 0;
      r.sector = rc.sectorIndexAt(s);
      r.retiredAt = engine.time;
      continue;
    }
    if (!victim) continue;

    const since = engine.time - r.retiredAt;
    const sec = r.sector;
    const prev = (sec + rc.marshalSectorCount - 1) % rc.marshalSectorCount;
    const local = rc.sectorFlags[sec];
    const flagged = local !== 'green';

    if (r.flagUpAfterS < 0 && flagged) r.flagUpAfterS = since;

    if (!victim.cleared) {
      r.wreckSamples++;
      if (!flagged) r.greenOverWreck++;
    } else if (r.clearedAfterS < 0) {
      // The step the wreck went. Everything about this moment is recorded here
      // rather than reconstructed afterwards, because the whole assertion is
      // that it IS one moment.
      r.clearedAfterS = since;
      r.method = victim.recovery.method;
      r.neutralisationDuring = rc.neutralisation;
      r.contested = contestedNow();
    }

    // And checked every step from there until the flag comes down, rather than
    // sampled once at the moment the wreck went. Another car can spin off, or a
    // piece of bodywork can land, at any point in that window and hold the
    // yellow on its own account — and a snapshot taken before it arrived blames
    // this recovery for a flag that is not its.
    if (r.clearedAfterS >= 0 && r.flagDownAfterS < 0 && !r.contested) {
      r.contested = contestedNow();
    }

    if (r.flagDownAfterS < 0 && r.flagUpAfterS >= 0 &&
        rc.sectorFlags[sec] === 'green' && rc.sectorFlags[prev] === 'green') {
      r.flagDownAfterS = since;
    }

    if (r.clearedAfterS >= 0 && r.flagDownAfterS >= 0) break;
  }

  if (!victim) return null;
  r.neededNeutralisation = victim.recovery.needsNeutralisation;
  if (!r.method) r.method = victim.recovery.method;
  return r;
}

// ===========================================================================
// 1. The recovery itself, on five circuits and both kinds of site
// ===========================================================================

console.log('\nRECOVERY — a staged retirement, watched until the car has gone');
console.log(
  '  ' + 'CIRCUIT'.padEnd(14) + 'SITE'.padEnd(10) + 'METHOD'.padEnd(8) +
  'NEUTRAL'.padEnd(9) + 'FLAG UP'.padStart(8) + 'CLEARED'.padStart(9) +
  'FLAG DOWN'.padStart(11) + '  GREEN-OVER-WRECK',
);

const CIRCUITS = ['monza', 'monaco', 'jeddah', 'silverstone', 'suzuka'];
const results: Result[] = [];

for (let i = 0; i < CIRCUITS.length; i++) {
  for (const site of ['roadside', 'gravel'] as Site[]) {
    const r = runScenario(CIRCUITS[i], site, 88100 + i * 7 + (site === 'gravel' ? 3 : 0) + SEED_OFFSET);
    if (!r) {
      fail(`${CIRCUITS[i]}/${site}: no retirement could be staged at all`);
      continue;
    }
    results.push(r);
    console.log(
      '  ' + r.circuit.padEnd(14) + r.site.padEnd(10) + r.method.padEnd(8) +
      (r.neededNeutralisation ? r.neutralisationDuring : 'no').padEnd(9) +
      (r.flagUpAfterS >= 0 ? r.flagUpAfterS.toFixed(1) + 's' : 'never').padStart(8) +
      (r.clearedAfterS >= 0 ? r.clearedAfterS.toFixed(1) + 's' : 'never').padStart(9) +
      (r.flagDownAfterS >= 0 ? r.flagDownAfterS.toFixed(1) + 's' : 'never').padStart(11) +
      '  ' + r.greenOverWreck + ' / ' + r.wreckSamples + ' samples' +
      (r.contested ? '   (another incident in the same sector)' : ''),
    );
  }
}

for (const r of results) {
  const id = r.circuit + '/' + r.site;

  // 1. A flag, in the car's own sector, essentially at once.
  if (r.flagUpAfterS < 0) {
    fail(`${id}: a car retired and no flag was ever raised in marshalling sector ${r.sector + 1}`);
  } else if (r.flagUpAfterS > 1) {
    fail(`${id}: the flag took ${r.flagUpAfterS.toFixed(1)}s to come out — marshals react ` +
      `to a stopped car, they do not wait for it`);
  }

  // 2 and 3. The wreck is there, and the road is never declared clear while
  // it is.
  if (r.wreckSamples < 100) {
    fail(`${id}: only ${r.wreckSamples} samples with the wreck present — it was never really there`);
  }
  if (r.greenOverWreck > 0) {
    fail(`${id}: ${(r.greenOverWreck * PHYSICS_DT).toFixed(1)}s of green flag shown in a sector ` +
      `that still had ${r.site === 'gravel' ? 'a car in the gravel' : 'a car beside the road'}`);
  }

  // 4. It is later gone, and inside a plausible time.
  if (r.clearedAfterS < 0) {
    fail(`${id}: the wreck was never recovered — it is still lying there at the flag`);
    continue;
  }
  if (r.clearedAfterS >= RECOVERY_BACKSTOP_S) {
    fail(`${id}: the recovery took ${r.clearedAfterS.toFixed(0)}s and only finished because the ` +
      `backstop fired — nothing in the model actually recovered it`);
  }

  // 5. The flag clears at the same moment, not on a clock of its own.
  if (r.contested) continue;
  if (r.flagDownAfterS < 0) {
    fail(`${id}: the wreck went at ${r.clearedAfterS.toFixed(1)}s and the sector never went green`);
  } else if (Math.abs(r.flagDownAfterS - r.clearedAfterS) > PHYSICS_DT * 1.5) {
    fail(`${id}: the wreck went at ${r.clearedAfterS.toFixed(2)}s and the flag cleared at ` +
      `${r.flagDownAfterS.toFixed(2)}s — ${Math.abs(r.flagDownAfterS - r.clearedAfterS).toFixed(2)}s ` +
      `apart, so they are not the same event`);
  }
}

// 6. Where it stopped decides what it takes.
{
  const road = results.filter((r) => r.site === 'roadside' && r.clearedAfterS >= 0);
  const grav = results.filter((r) => r.site === 'gravel' && r.clearedAfterS >= 0);
  const mean = (xs: Result[]) => xs.reduce((a, r) => a + r.clearedAfterS, 0) / Math.max(xs.length, 1);
  const roadMean = mean(road);
  const gravMean = mean(grav);
  console.log('');
  console.log('  ' + 'mean recovery, beside the road'.padEnd(38) + roadMean.toFixed(1) + 's');
  console.log('  ' + 'mean recovery, buried in the gravel'.padEnd(38) + gravMean.toFixed(1) + 's');
  console.log('  ' + 'pushed away by marshals'.padEnd(38) +
    results.filter((r) => r.method === 'push').length + ' of ' + results.length);
  console.log('  ' + 'lifted out by a crane'.padEnd(38) +
    results.filter((r) => r.method === 'crane').length + ' of ' + results.length);

  if (road.length > 0 && grav.length > 0 && gravMean <= roadMean * 1.4) {
    fail(`a car buried in a gravel trap is recovered in ${gravMean.toFixed(0)}s against ` +
      `${roadMean.toFixed(0)}s for one beside the road — the site is not making a difference`);
  }
  if (grav.some((r) => r.method !== 'crane')) {
    fail('a car fourteen metres into a gravel trap was recorded as pushed away by hand');
  }
  if (road.some((r) => !r.neededNeutralisation)) {
    fail('a car stopped beside the racing line was recovered without the race being neutralised ' +
      '— Art. 55.3 / B5.13.1 and Art. 56.1a / B5.12 are both about officials on or near the track');
  }
}

// ===========================================================================
// 2. The debris goes with the car, and the sweep does not leak
// ===========================================================================
//
// The renderer retires a pile of bodywork by calling `Wreckage.clearPile` when
// the simulation's ledger says the marshals have collected it. That buffer is a
// fixed-size instanced ring, so the two ways this could go wrong are leaving
// pieces behind and growing the buffer — and a previous session established
// that six load/unload cycles must return to identical geometry and texture
// counts, which is exactly the property a sweep that allocated would break.
console.log('\nDEBRIS — bodywork is swept up with the car it came off');
{
  const w = new Wreckage(120);
  const geometry = w.mesh.geometry;
  const material = w.mesh.material;
  const capacity = w.mesh.instanceMatrix.count;

  /** Instances whose matrix is not degenerate — a piece actually on the road. */
  const onRoad = (): number => {
    let n = 0;
    const a = w.mesh.instanceMatrix.array as ArrayLike<number>;
    for (let i = 0; i < w.mesh.count; i++) {
      // Column lengths of the 4x4: a swept piece is scaled to zero.
      const o = i * 16;
      const sx = Math.hypot(a[o], a[o + 1], a[o + 2]);
      if (sx > 1e-6) n++;
    }
    return n;
  };

  let leaked = 0;
  let grew = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let car = 0; car < 4; car++) {
      w.spawn(car * 10, 1, 0, 12, 0, 0.8, 0.2, 0.9, 0xff0000, 0, 5, car + 1);
    }
    const before = onRoad();
    if (before !== 20) leaked++;
    for (let car = 0; car < 4; car++) w.clearPile(car + 1);
    if (onRoad() !== 0) leaked++;
    if (w.mesh.instanceMatrix.count !== capacity) grew++;
    if (w.mesh.geometry !== geometry || w.mesh.material !== material) grew++;
    w.clear();
  }

  console.log('  ' + 'spawn/sweep cycles'.padEnd(38) + '6, four cars each');
  console.log('  ' + 'pieces left on the road after a sweep'.padEnd(38) + leaked);
  console.log('  ' + 'buffer or resource identity changed'.padEnd(38) + grew);
  console.log('  ' + 'instance capacity'.padEnd(38) + capacity + ' (unchanged)');

  if (leaked > 0) fail(`${leaked} cycles left one car's bodywork on the road after it was recovered`);
  if (grew > 0) fail(`${grew} cycles reallocated the debris buffer or its resources`);

  w.dispose();
}

// ===========================================================================
// 3. Debris that no recovery is ever coming for
// ===========================================================================
//
// This is the defect the whole `DebrisField` exists for, and it is not the one
// section 2 tests. Section 2 asks whether a RECOVERED car's carbon goes with
// it, and it always did. The reported bug is the other case: a car that sheds a
// wing, keeps racing, and is never recovered at all. Nothing removed that
// bodywork, ever, so a race with six contact events in two laps ended with six
// permanent piles of it on the circuit — "why are there blue pieces everywhere".
//
// The three properties that make it temporary without a lifetime:
//
//   a. A pile on the racing surface RAISES A YELLOW at the post covering it.
//      That is the thing that sends marshals, and it is why this is modelled in
//      the simulation rather than in the renderer.
//   b. It is then COLLECTED, under that local yellow, with no neutralisation
//      and no recovery involved — and the flag comes down when it goes.
//   c. A pile in the RUN-OFF outlives one on the racing line by a long way,
//      because nobody walks out for it until the race is slowed for something
//      else. Real run-off collects carbon over a race distance.
console.log('\nLOOSE DEBRIS — carbon nobody is coming to recover');
{
  const CIRCUITS = ['bahrain', 'monaco', 'spa', 'suzuka'];
  const rows: string[] = [];

  for (const circuit of CIRCUITS) {
    const def = getCircuit(circuit);
    const config: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps: 6,
      playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 31,
    };
    const engine = new RaceEngine(def, config);
    const rc = engine.raceControl;

    // Settle the field, then plant three piles by hand, well apart so their
    // marshalling sectors cannot overlap: a whole front wing on the racing
    // line, the scatter off a contact on the racing line, and a pile out in
    // the run-off. The three cases the ledger distinguishes.
    for (let i = 0; i < Math.round(70 / PHYSICS_DT); i++) engine.step();

    const sPart = engine.track.length * 0.10;
    const sLoose = engine.track.length * 0.40;
    const sOff = engine.track.length * 0.72;
    const plant = (s: number, offRoadM: number, source: number): number =>
      engine.debris.add({
        s, lateralM: engine.track.halfWidthAt(s) + offRoadM, ownerIndex: 0,
        x: 0, y: 0, z: 0, vx: 0, vz: 0,
        sizeX: 0.4, sizeY: 0.1, sizeZ: 0.3, pieces: 3, source,
        offRoadM,
      }).id;
    const partId = plant(sPart, -1.5, 1);
    const looseId = plant(sLoose, -1.5, 0);
    const offId = plant(sOff, 9, 1);

    const partSector = rc.sectorIndexAt(sPart);
    const plantedAt = engine.time;
    let partGoneAt = -1;
    let looseGoneAt = -1;
    let offGoneAt = -1;
    let yellowSamples = 0;
    let liveSamples = 0;
    let greenOverPart = 0;

    const alive = (id: number): boolean => engine.debris.piles.some((p) => p.id === id);

    for (let step = 0; step < Math.round(400 / PHYSICS_DT) && !engine.over; step++) {
      engine.step();
      if (alive(partId)) {
        liveSamples++;
        if (rc.sectorFlags[partSector] === 'green') greenOverPart++;
        else yellowSamples++;
      } else if (partGoneAt < 0) partGoneAt = engine.time - plantedAt;
      if (!alive(looseId) && looseGoneAt < 0) looseGoneAt = engine.time - plantedAt;
      if (!alive(offId) && offGoneAt < 0) offGoneAt = engine.time - plantedAt;
      if (partGoneAt >= 0 && looseGoneAt >= 0 && offGoneAt >= 0) break;
    }

    const at = (x: number): string =>
      (x < 0 ? '>400s' : x.toFixed(1) + 's').padEnd(9);
    rows.push(
      '  ' + circuit.padEnd(13) +
      'wing on line ' + at(partGoneAt) +
      'scatter on line ' + at(looseGoneAt) +
      'run-off ' + at(offGoneAt) +
      'green over the wing ' + greenOverPart + ' / ' + liveSamples,
    );

    // 1. A whole part on the racing line is a flagged hazard and goes quickly.
    if (partGoneAt < 0) {
      fail(`${circuit}: a wing lying on the racing line was never collected`);
    } else if (partGoneAt > 90) {
      fail(`${circuit}: a wing on the racing line took ${partGoneAt.toFixed(0)}s to collect`);
    }
    if (yellowSamples === 0) {
      fail(`${circuit}: a wing lying on the racing line never raised a flag`);
    }
    // A step or two of green between the collection and the next flag pass is
    // fair; anything more is a hazard nobody is being warned about.
    if (greenOverPart > liveSamples * 0.02) {
      fail(`${circuit}: sector read green for ${greenOverPart} of ${liveSamples} ` +
        'samples with a wing lying on the racing line');
    }

    // 2. The scatter off a contact is not flagged — race control does not stop
    //    a race for an endplate fragment — but it is still collected, at the
    //    first opportunity rather than at the end of the race.
    if (looseGoneAt < 0) {
      fail(`${circuit}: the scatter off a contact was never collected`);
    } else if (looseGoneAt > 130) {
      fail(`${circuit}: contact scatter took ${looseGoneAt.toFixed(0)}s to collect`);
    }

    // 3. And carbon in the run-off outlasts both, because nobody walks out for
    //    it until the race is slowed down for something else.
    if (offGoneAt >= 0 && partGoneAt >= 0 && offGoneAt < partGoneAt) {
      fail(`${circuit}: run-off debris was collected before debris on the racing line`);
    }
  }

  for (const r of rows) console.log(r);
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('Crashed cars get recovered, and the flag says so for exactly as long.\n');
}
