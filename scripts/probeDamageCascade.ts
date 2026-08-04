/**
 * DOES ORDINARY RACING CONTACT EVENTUALLY DESTROY THE CAR? — issue #26.
 *
 * `diag:attrition` reports and this judges, which is the same division of
 * labour `probe:racelog` and that diagnostic already have. What is judged here
 * is one link of the chain and not the race-level bars: `probe:racelog` owns
 * "how many cars retire" and "how many contacts a race", and it should, because
 * those are what the player counts. This owns the mechanism underneath them,
 * because a race-level bar cannot say WHY it moved and a probe that can only
 * say "worse" sends the next agent looking in the wrong file. Issue #26 has
 * been closed twice on the wrong mechanism and both times the number moved.
 *
 * ===========================================================================
 * WHAT WAS MEASURED, on merged `main`, at issue #26's own configuration
 * ===========================================================================
 * 52 laps, Silverstone, F3, grid slot P18, AI on medium, two seeds:
 *
 *   13.00 retirements a race, 19 of 26 of them `Beached in the gravel`
 *   0 of 19 beached cars had been touched by anybody in the previous 10s
 *   20 of 26 were already under 0.70 on a component the last time they raced
 *   the field's worst component falls 0.94 -> 0.50 across the race, min 0.10
 *
 *   THE LEDGER — where the health goes, over every car:
 *     car-to-car contact   56.7 a race (72%) over 113.5 damaging impacts
 *     the barrier          21.0 a race (27%) over  46.5
 *     kerbs/gravel/revs     0.6 a race  (1%)
 *
 *   THE DOSE-RESPONSE — excursions per 1000 car-seconds ON the road, by the
 *   car's worst component. Five bands, monotone, which a threshold artefact
 *   cannot produce:
 *     >= 0.95   0.86   x1.0
 *     0.85-0.95 1.23   x1.4
 *     0.70-0.85 1.36   x1.6
 *     0.50-0.70 1.60   x1.9
 *     <  0.50   3.29   x3.8      <- 35% of all excursions, 16% of the exposure
 *
 * So: contact breaks the car, a broken car leaves the road, and the knee is
 * BELOW 0.50. That is the quantity this probe defends.
 *
 * ===========================================================================
 * WHAT IT ASSERTS, AND WHY BOTH DIRECTIONS
 * ===========================================================================
 * A probe that only says "less damage is better" is passed by a damage model
 * that does nothing, and a field of indestructible cars is a worse simulation
 * than a field that eats itself. So every section here asserts a floor as well
 * as a ceiling, the same rule `probe:effects` carries.
 *
 *   1  THE RATCHET. Repeated NON-terminal racing contact must not walk a
 *      component down to its structural floor — and a WRITE-OFF must still take
 *      it there.
 *   2  WHAT THE RATCHET COSTS. The cornering grip a car is left with after a
 *      race's worth of ordinary contact, because `baseMu` is the term the
 *      excursion rate above responds to. Bounded below as well as above.
 *   3  A CAR THAT IS GOING SOMEWHERE HAS NOT STOPPED. The last link: a driver
 *      crawling out of the run-off at the speed thirteen of nineteen beached
 *      cars were actually doing when they were retired is left alone, and a car
 *      that has genuinely stopped is still out on the marshals' own schedule.
 *   4  IN A RACE. Two full-distance races at #26's own configuration: how many
 *      cars are ground under 0.50 while still running, and how many
 *      retirements were already there. Plus the floor: cars must still touch
 *      each other and still be damaged by it.
 *
 * `CASCADE_BREAK=ratchet` restores the pre-fix model — the linear term with no
 * energy bound on it — and takes sections 1 and 2 red, 12 failures. It does NOT
 * reach section 4, and that is worth saying rather than leaving to be
 * discovered: section 4 runs the real engine, so the only way to break it is to
 * change the engine. Disabling the progress test in `RaceEngine.checkStranded`
 * takes section 3 red on its own; both were run before this was committed.
 *
 * SECTION 4 IS CURRENTLY RED AND THE BAR WAS NOT MOVED — 5.5 of 20 cars a race
 * against a bar of 4. See TESTING.md's known-failing list and PROJECT.md §7
 * under #26. The bar is the sport's and the number is what this fix reached.
 *
 * Node-only: no browser, no wall-clock deadline, every seed stated. Slow
 * because section 4 is two real Grands Prix (~10 minutes); sections 1 to 3 are
 * fast and are what a change to `DamageModel` or `checkStranded` should be run
 * against first — `CASCADE_RACE=0` runs only those.
 *
 * Run: npm run probe:cascade
 *      CASCADE_BREAK=ratchet npm run probe:cascade    (must go red)
 *      CASCADE_RACE=0 npm run probe:cascade           (bench sections only)
 */

import { CarDamage, COMPONENT_IDS, COMPONENT_FLOORS, type ComponentId } from '../src/race/DamageModel';
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { PHYSICS_DT } from '../src/core/SimClock';
import { clearGrid } from '../src/data/teams';
import type { TierId } from '../src/data/roster';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import { raceLapsFor, DEFAULT_WEEKEND_OPTIONS, type RaceDistanceId } from '../src/race/WeekendFormat';
import { DEFAULT_AI_DIFFICULTY, type AIDifficultyId } from '../src/ai/AIVehicleController';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

/**
 * The severity of the average DAMAGING car-to-car contact in a real race here.
 *
 * Not chosen. Measured: the field loses 56.7 health-units a race to car-to-car
 * contact over 113.5 damaging impacts, which is 0.50 a hit; the mean spread
 * weight over the five zones is 2.6; and the linear term is `s * 0.32 * w`. So
 * 0.32 * 2.6 * s = 0.50 gives s = 0.60. Every ladder below is run at it.
 */
const RACING_SEVERITY = 0.60;

/**
 * How many separate damaging contacts one car takes in a full-distance race.
 *
 * The worst-off car in the measured sweep took twelve; the field mean is 5.7.
 * The ladders run to twenty, which is well past anything a race produces, so
 * "it holds for a race" is not being asserted on the edge of the evidence.
 */
const LADDER_HITS = 20;

/**
 * The health below which the excursion rate goes non-linear.
 *
 * Read off the dose-response above: x1.0 / x1.4 / x1.6 / x1.9 across the top
 * four bands and x3.8 below 0.50. Everything above this band is a car having a
 * worse afternoon; below it is a car that cannot hold the road.
 */
const CASCADE_HEALTH = 0.50;

const BREAK = process.env.CASCADE_BREAK ?? '';
const RUN_RACE = process.env.CASCADE_RACE !== '0';

// ===========================================================================
// The pre-fix model, so this probe can be shown to fail
// ===========================================================================
/**
 * `CarDamage.applyImpact` as it stood before the energy bound, reimplemented
 * against the same health record.
 *
 * A copy, deliberately, and it is the only copy of a rule in this file. The
 * alternative is a switch inside the shipped model, which is a branch in the
 * simulation that exists only for a test and which somebody eventually reads as
 * a feature. This one is fifteen lines, it is quoted from the diff, and if it
 * ever stops reproducing the old numbers the section that uses it says so.
 */
function applyImpactPreFix(
  damage: CarDamage, zone: 'front' | 'rear' | 'left' | 'right' | 'floor', severity: number,
): void {
  const s = Math.max(0, Math.min(1, severity));
  if (s <= 0.001) return;
  const spread: Partial<Record<ComponentId, number>> =
    zone === 'front' ? { frontWingL: 1.0, frontWingR: 1.0, suspFL: 0.35, suspFR: 0.35, floor: 0.2 }
    : zone === 'rear' ? { rearWing: 1.0, suspRL: 0.4, suspRR: 0.4, gearbox: 0.3, engine: 0.15 }
    : zone === 'left' ? { sidepodL: 1.0, suspFL: 0.6, suspRL: 0.6, frontWingL: 0.5, floor: 0.3 }
    : zone === 'right' ? { sidepodR: 1.0, suspFR: 0.6, suspRR: 0.6, frontWingR: 0.5, floor: 0.3 }
    : { floor: 1.0, sidepodL: 0.2, sidepodR: 0.2 };
  const rate = s * 0.32;
  for (const id of COMPONENT_IDS) {
    const w = spread[id];
    if (!w) continue;
    const after = Math.max(COMPONENT_FLOORS[id], Math.min(1, damage.health[id] - rate * w));
    damage.health[id] = after;
  }
}

type Zone = 'front' | 'rear' | 'left' | 'right' | 'floor';
const ZONES: Zone[] = ['front', 'rear', 'left', 'right', 'floor'];

function hit(damage: CarDamage, zone: Zone, s: number, writeOff = false): void {
  if (BREAK === 'ratchet' && !writeOff) applyImpactPreFix(damage, zone, s);
  else damage.applyImpact(zone, s, writeOff);
}

function worstOf(damage: CarDamage): { id: ComponentId; health: number } {
  return damage.worst();
}

/**
 * The components a pit stop cannot put back, and why they are the ones judged.
 *
 * `RaceEngine`'s stop refits the nose (`pitNoseChanging`, taken whenever the
 * front wing is under 0.70) and the sidepod panels, and its own comment says
 * the rest "stays with the car for the rest of the race — those are not parts
 * anyone changes in three seconds". That is correct and is not what is being
 * changed here. What it means is that damage to these components is a RATCHET
 * over a race distance and damage to the bodywork is not, which is why the
 * measured retirement table is dominated by them: `suspFL`/`suspFR` were the
 * worst part on 9 of 26 retirements, against 4 for the sidepods and 6 for the
 * front wings, and the cars carrying those wings had all had a chance to have
 * them replaced.
 *
 * So the bodywork is allowed to be worn to the bound and the structure is not.
 * Asserting a single bar over `worst()` instead would either let the structure
 * through or demand that a front wing survive a race of contact untouched, and
 * neither is the thing that was measured.
 */
const UNREPAIRABLE: ComponentId[] = [
  'suspFL', 'suspFR', 'suspRL', 'suspRR', 'floor', 'engine', 'gearbox',
];

/**
 * The zones a contact can actually produce.
 *
 * `RaceEngine.zoneFor` projects the contact normal into the car's own frame and
 * returns front, rear, left or right; nothing in the engine ever asks for
 * `floor`, which the damage model carries for a grounding strike that is not
 * wired up. Its row is printed because it is part of the model and a silent
 * unreachable branch is how one goes stale — but it is not judged, because
 * asserting a bound on a path no impact can reach would be asserting nothing.
 */
const CONTACT_ZONES: Zone[] = ['front', 'rear', 'left', 'right'];

// ===========================================================================
console.log('\n1  THE RATCHET — ' + LADDER_HITS + ' separate racing contacts at severity ' +
  RACING_SEVERITY.toFixed(2) + ', one zone at a time');
// ===========================================================================
console.log('  ' + 'ZONE'.padEnd(8) + 'WORST AFTER 1'.padStart(15) + 'AFTER 5'.padStart(10) +
  ('AFTER ' + LADDER_HITS).padStart(11) + '  PART'.padEnd(14) +
  'WORST UNREPAIRABLE'.padStart(19) + '  AT ITS FLOOR?');

for (const zone of ZONES) {
  const damage = new CarDamage();
  let after1 = 1, after5 = 1;
  for (let i = 1; i <= LADDER_HITS; i++) {
    hit(damage, zone, RACING_SEVERITY);
    if (i === 1) after1 = worstOf(damage).health;
    if (i === 5) after5 = worstOf(damage).health;
  }
  const w = worstOf(damage);
  let structId = UNREPAIRABLE[0];
  for (const id of UNREPAIRABLE) if (damage.health[id] < damage.health[structId]) structId = id;
  const structH = damage.health[structId];
  const atFloor = COMPONENT_IDS.filter((id) => damage.health[id] <= COMPONENT_FLOORS[id] + 1e-6);
  console.log('  ' + zone.padEnd(8) +
    after1.toFixed(3).padStart(15) + after5.toFixed(3).padStart(10) +
    w.health.toFixed(3).padStart(11) + '  ' + w.id.padEnd(12) +
    (structH.toFixed(3) + ' ' + structId).padStart(19) + '  ' +
    (atFloor.length ? atFloor.join(', ') : '—'));

  if (!CONTACT_ZONES.includes(zone)) continue;

  // THE ASSERTIONS. Twenty ordinary racing touches to the same face of the car
  // is already more than three times what the worst-off car in a measured Grand
  // Prix takes, and it must not leave the car in a state it cannot race out of.
  check(structH > CASCADE_HEALTH,
    `${zone}: ${LADDER_HITS} racing contacts at severity ${RACING_SEVERITY} leave ${structId} at ` +
    `${structH.toFixed(3)}, under ${CASCADE_HEALTH}, and no pit stop can put it back — ` +
    'ordinary contact is writing a permanent grip penalty into the car');
  check(atFloor.length === 0,
    `${zone}: ${LADDER_HITS} racing contacts drove ${atFloor.join(', ')} to the structural floor, ` +
    'which is the last value before a car cannot corner at all');
}

// ...and the other direction. A model in which nothing can ever break is the
// failure this replaced, not an improvement on it.
{
  const damage = new CarDamage();
  hit(damage, 'front', 1.0, true);
  const w = worstOf(damage);
  console.log('  ' + 'write-off'.padEnd(8) + '  one terminal front impact at severity 1.00 leaves ' +
    w.id + ' at ' + w.health.toFixed(3));
  check(damage.health.frontWingL <= COMPONENT_FLOORS.frontWingL + 1e-6,
    `a terminal impact left the front wing at ${damage.health.frontWingL.toFixed(3)} — ` +
    'a written-off car has to be written off');
}
{
  // And racing contact still has to HURT. The bound is on where the damage
  // stops, not on whether it starts.
  const damage = new CarDamage();
  hit(damage, 'left', RACING_SEVERITY);
  check(damage.health.sidepodL < 0.9,
    `one severity-${RACING_SEVERITY} side contact left the sidepod at ` +
    `${damage.health.sidepodL.toFixed(3)} — contact has stopped costing anything`);
}
{
  // The three-hits-to-strip-a-wing ladder `probe:damage` asserts is a HEAVY
  // hit, and it must survive this. Restated here rather than only there,
  // because it is the thing most likely to be broken by a change to the bound.
  const damage = new CarDamage();
  for (let i = 0; i < 6; i++) hit(damage, 'front', 0.8);
  console.log('  ' + 'heavy'.padEnd(8) + '  6 x severity 0.80 front: front wing ' +
    damage.health.frontWingL.toFixed(3) + ', susp FL ' + damage.health.suspFL.toFixed(3));
  check(damage.health.frontWingL <= 0.3,
    `six heavy front impacts left the front wing at ${damage.health.frontWingL.toFixed(3)} — ` +
    'nothing can come off the car (see probe:damage)');
}

// ===========================================================================
console.log('\n2  WHAT THE RATCHET COSTS — the grip a car is left with');
// ===========================================================================
//
// `baseMu` is the term the excursion rate responds to: the AI computes its
// cornering limit from `spec.baseMu * tyre grip` and the physics computes the
// axle it has from the same number, so a car whose `baseMu` has collapsed is
// asking a corner for grip it does not have on every lap for the rest of the
// race. This is the quantity the dose-response is a picture of.
{
  console.log('  ' + 'ZONE'.padEnd(8) + 'baseMu'.padStart(10) + 'clBase'.padStart(10) +
    'of pristine'.padStart(13));
  for (const zone of ZONES) {
    const damage = new CarDamage();
    for (let i = 0; i < LADDER_HITS; i++) hit(damage, zone, RACING_SEVERITY);
    const spec = damage.applyTo(BASE_F1_SPEC);
    const muFrac = spec.baseMu / BASE_F1_SPEC.baseMu;
    console.log('  ' + zone.padEnd(8) + spec.baseMu.toFixed(3).padStart(10) +
      spec.clBase.toFixed(3).padStart(10) + (100 * muFrac).toFixed(1).padStart(12) + '%');
    // A race's worth of ordinary contact may cost a car real performance — it
    // should — but not the grip it needs to negotiate the circuit. 0.90 is
    // where the AI's own commitment margin runs out: `AI_TUNING.commitmentScale`
    // is 0.90, so a car that has lost more than a tenth of its mu is asking for
    // more than its own controller's margin every corner.
    check(muFrac > 0.90,
      `${zone}: ${LADDER_HITS} racing contacts leave baseMu at ${(100 * muFrac).toFixed(1)}% of ` +
      'pristine — less margin than the AI\'s own commitment scale, so the car cannot hold its line');
  }
  // The floor, again: a written-off car must lose real grip.
  const wreck = new CarDamage();
  hit(wreck, 'left', 1.0, true);
  const wreckSpec = wreck.applyTo(BASE_F1_SPEC);
  check(wreckSpec.baseMu / BASE_F1_SPEC.baseMu < 0.92,
    'a written-off car keeps ' +
    `${(100 * wreckSpec.baseMu / BASE_F1_SPEC.baseMu).toFixed(1)}% of its grip — ` +
    'destruction has stopped costing anything');
}

// ===========================================================================
console.log('\n3  A CAR THAT IS GOING SOMEWHERE HAS NOT STOPPED');
// ===========================================================================
//
// The last link. `RaceEngine.checkStranded` retires an off-road car that has
// been under `STRANDED_SPEED_MS` = 2.5 m/s for `BEACHED_RETIRE_S` = 9 seconds,
// and nothing asked whether it was moving. Measured on merged `main`: of
// nineteen `Beached in the gravel` retirements in two full-distance races,
// THIRTEEN were still doing between 0.7 and 1.9 m/s on the step they were
// retired — a driver crawling back onto the circuit under power, written off
// for being slow.
//
// Both directions, because "nothing is ever retired" is the failure this must
// not become: a car making progress is left alone, and a car that has genuinely
// stopped is still retired on the same schedule as before.
{
  const world = createWorld(20260801);
  installWorld(world);
  const def = getCircuit('silverstone');
  const field = raceSeats(world, 'F3' as TierId).map(toDriver);

  /**
   * Puts one car in the run-off and holds it at `crawlMs`, then reports how
   * long it survived.
   *
   * The car is driven by hand rather than by the recovery controller so the
   * measurement is of the RULE and not of how well the AI gets out of gravel —
   * those are two different claims and only one of them is this file's.
   */
  function strand(
    crawlMs: number, holdS: number,
  ): { retiredAfterS: number | null; reason?: string } {
    const config: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps: 5,
      aiDifficulty: DEFAULT_AI_DIFFICULTY, playerIndex: -1,
      standingStart: true, pitLaneStart: false, seed: 20260729,
    };
    const engine = new RaceEngine(def, config, field);
    // Let the start unfold so the car is racing before it is put off.
    for (let i = 0; i < Math.round(45 / PHYSICS_DT); i++) engine.step();
    const car = engine.cars.find((c) => !c.retired && !c.inPitLane);
    if (!car) return { retiredAfterS: null };

    const halfW = engine.track.halfWidthAt(car.s);
    const startT = engine.time;
    for (let i = 0; i < Math.round(holdS / PHYSICS_DT); i++) {
      // Hold it in the run-off, four metres beyond the edge, travelling along
      // the circuit at `crawlMs`. Re-applied every step for the same reason
      // `probe:blockage` re-pins its blocker: the engine integrates this car
      // like any other and the point is a car in that state, not one removed
      // from the simulation.
      if (!car.retired) {
        const h = car.physics.heading;
        car.lateral = halfW + 4;
        car.physics.velocity.set(Math.sin(h) * crawlMs, Math.cos(h) * crawlMs);
        car.physics.localVelX = 0;
        car.physics.localVelY = crawlMs;
        car.physics.position.x += Math.sin(h) * crawlMs * PHYSICS_DT;
        car.physics.position.y += Math.cos(h) * crawlMs * PHYSICS_DT;
      }
      engine.step();
      if (car.retired) {
        return { retiredAfterS: engine.time - startT, reason: car.retirementReason };
      }
    }
    return { retiredAfterS: null };
  }

  // (a) THE CASE THAT WAS BEING RETIRED. A driver picking his way out at
  // 1.5 m/s — the median of the thirteen measured above — held for fifteen
  // seconds. Fifteen because the whole claim is about the window between
  // `BEACHED_RETIRE_S` (9s, which this car must now survive) and
  // `BEACHED_ABANDON_S` (19s, which it must not): every one of the thirteen was
  // written off inside it, at 9 to 15 seconds, while moving.
  //
  // Deliberately NOT staged as "and then it rejoins". Teleporting the car back
  // onto the racing line at speed is a car appearing in the middle of a moving
  // field, and the first attempt at it retired the car with `Accident` two
  // seconds later — a true result about a thing nobody is claiming. The rule is
  // what is under test, so the measurement is of the rule.
  const crawling = strand(1.5, 15);
  console.log('  crawling at 1.5 m/s, 15s in the run-off: ' +
    (crawling.retiredAfterS === null ? 'still running'
      : `RETIRED after ${crawling.retiredAfterS.toFixed(1)}s — ${crawling.reason}`));
  check(crawling.retiredAfterS === null,
    'a car crawling out of the run-off at 1.5 m/s was retired after ' +
    `${crawling.retiredAfterS?.toFixed(1)}s (${crawling.reason}) — it had covered ` +
    `${((crawling.retiredAfterS ?? 0) * 1.5).toFixed(0)}m under its own power`);

  // (b) The first floor. A car that has actually stopped is still out, on the
  // schedule it always was.
  const stopped = strand(0, 40);
  console.log('  stopped dead in the run-off:          ' +
    (stopped.retiredAfterS === null ? 'STILL RUNNING after 40s'
      : `retired after ${stopped.retiredAfterS.toFixed(1)}s`));
  check(stopped.retiredAfterS !== null && stopped.retiredAfterS < 20,
    'a car stopped dead in the run-off was ' +
    (stopped.retiredAfterS === null ? 'never retired' :
      `left there for ${stopped.retiredAfterS.toFixed(1)}s`) +
    ' — the progress test has become a licence to sit in the gravel');

  // (c) The second floor, and it is the one `validate:race` found the hard way.
  // A car that crawls and NEVER gets back on is not recovering, it is pottering
  // about in the run-off, and `BEACHED_ABANDON_S` has to end it. The first
  // version of that backstop was `RECOVERY_BACKSTOP_S` at 210 seconds and this
  // is the assertion that would have caught it: `cota: 187.9s spread between
  // fastest and slowest car` was one car doing exactly this and finishing.
  const pottering = strand(1.5, 40);
  console.log('  crawls out at 1.5 m/s, never returns:  ' +
    (pottering.retiredAfterS === null ? 'STILL RUNNING after 40s'
      : `retired after ${pottering.retiredAfterS.toFixed(1)}s`));
  check(pottering.retiredAfterS !== null && pottering.retiredAfterS < 30,
    'a car that crawled around the run-off for 40s without ever rejoining was ' +
    (pottering.retiredAfterS === null ? 'never retired' :
      `left there for ${pottering.retiredAfterS.toFixed(1)}s`) +
    ' — the progress test has become a licence to potter about off the road');

  clearGrid();
}

// ===========================================================================
// 4  IN A RACE
// ===========================================================================
if (RUN_RACE) {
  const world = createWorld(20260801);
  installWorld(world);
  const TIER: TierId = (process.env.CASCADE_TIER as TierId) ?? 'F3';
  const CIRCUIT = process.env.CASCADE_CIRCUIT ?? 'silverstone';
  /**
   * TWO SEEDS, AND THE BAR IS ON THE MEAN.
   *
   * One race was not enough and the first version of this probe proved it by
   * landing on 5 against a bar of 4 — a single count on a single seed, one car
   * either side of a decision. The bar is not the thing to change there; the
   * MEASUREMENT is. Two seeds is what `probe:racelog` and `diag:attrition` both
   * use at this configuration, so the three harnesses are looking at the same
   * two races and a number quoted from one can be checked against another.
   */
  const SEEDS = (process.env.CASCADE_SEEDS ?? '20260729,20268648')
    .split(',').map((s) => Number(s.trim()));
  const DISTANCE = (process.env.CASCADE_LAPS ?? 'full') as RaceDistanceId;
  const DIFFICULTY = (process.env.CASCADE_DIFFICULTY as AIDifficultyId) ?? DEFAULT_AI_DIFFICULTY;

  const def = getCircuit(CIRCUIT);
  const laps = raceLapsFor(def.raceLaps, { ...DEFAULT_WEEKEND_OPTIONS, raceDistance: DISTANCE });
  console.log(`\n4  IN A RACE — ${CIRCUIT}, ${laps} laps, ${TIER}, AI on ${DIFFICULTY}, ` +
    `${SEEDS.length} seed(s)`);

  let lostToContact = 0;
  let contactImpacts = 0;
  let groundDown = 0;
  let retiredGroundDown = 0;
  let retired = 0;
  let cars = 0;

  for (const SEED of SEEDS) {
    const field = raceSeats(world, TIER).map(toDriver);
    const config: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps,
      aiDifficulty: DIFFICULTY, playerIndex: -1,
      standingStart: true, pitLaneStart: false, seed: SEED,
    };
    const engine = new RaceEngine(def, config, field);

    /** The worst component each car was carrying the last time it was racing. */
    const worstWhileRacing = new Map<number, number>();
    const t0 = Date.now();
    const maxSteps = Math.round((laps * def.referencePoleTimeS * 3.2 + 400) / PHYSICS_DT);
    for (let i = 0; i < maxSteps && !engine.over; i++) {
      engine.step();
      if (i % 60 !== 0) continue;
      for (const car of engine.cars) {
        // The same `lastRacing` rule `diag:attrition` samples on: on the road
        // and above 15 m/s, so nothing about an excursion leaks into it.
        if (car.retired || car.physics.speedMs <= 15) continue;
        if (Math.abs(car.lateral) > engine.track.halfWidthAt(car.s) + 1.0) continue;
        worstWhileRacing.set(car.index, car.damage.worst().health);
      }
    }

    let seedRetired = 0;
    let seedGround = 0;
    for (const car of engine.cars) {
      cars++;
      lostToContact += car.damage.lostBy.contact;
      contactImpacts += car.damage.hitsBy.contact;
      const w = worstWhileRacing.get(car.index) ?? 1;
      if (car.retired) {
        retired++; seedRetired++;
        if (w < CASCADE_HEALTH) { retiredGroundDown++; seedGround++; }
      } else if (w < CASCADE_HEALTH) {
        groundDown++; seedGround++;
      }
    }
    console.log(`  seed ${SEED}: ${seedRetired} of ${engine.cars.length} retired, ` +
      `${seedGround} ground under ${CASCADE_HEALTH}, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
  }

  console.log(`  ${retired} of ${cars} retired over ${SEEDS.length} race(s)`);
  console.log(`  health lost to car-to-car contact: ${lostToContact.toFixed(1)} over ` +
    `${contactImpacts} damaging impacts (${contactImpacts > 0 ?
      (lostToContact / contactImpacts).toFixed(3) : '-'} a hit)`);
  console.log(`  cars ground under ${CASCADE_HEALTH} while still racing: ` +
    `${groundDown} finishers, ${retiredGroundDown} of the ${retired} retirements, ` +
    `${((groundDown + retiredGroundDown) / SEEDS.length).toFixed(1)} a race`);

  // THE ASSERTION, and it is on the population rather than on the retirement
  // count: `probe:racelog` owns the retirement count and would fail on the same
  // race for a dozen reasons. What is asserted here is the mechanism — how many
  // cars the race grinds into the band where the excursion rate goes x3.8.
  //
  // The bar, PER RACE, and it has not moved since it was written. A Grand Prix
  // damages cars: a front wing endplate, a floor edge, a sidepod panel are all
  // ordinary. What is not ordinary is a QUARTER of the grid driving round on a
  // component at half health or less, which is what merged `main` produces —
  // 15 of 26 retirements were already under 0.40 and the field's worst
  // component reached 0.10, the front wing's structural floor exactly. Four of
  // twenty is one bad afternoon a race.
  //
  // What DID change is the measurement under it: this was a count on one seed
  // and it landed on 5 against the 4, which is one car either side of a
  // decision. Two seeds and a mean is the same claim measured properly. The bar
  // is the sport's; the seed count is the instrument's.
  const MAX_GROUND_DOWN = 4;
  const groundPerRace = (groundDown + retiredGroundDown) / SEEDS.length;
  check(groundPerRace <= MAX_GROUND_DOWN,
    `${groundPerRace.toFixed(1)} of 20 cars a race were ground under ` +
    `${CASCADE_HEALTH} on a component while still racing (bar ${MAX_GROUND_DOWN}) — ` +
    'the field is damaging itself into the band where it cannot hold the road');

  // ...and the floor. A race in which nobody touches anybody, or in which
  // contact costs nothing, passes every bar above and is not a race.
  check(contactImpacts > 0 && lostToContact > 0,
    `no car was damaged by another car in ${laps} laps — the field has stopped racing, ` +
    'which passes every bar above and is not a fix');

  clearGrid();
}

console.log('');
if (BREAK) console.log(`(CASCADE_BREAK=${BREAK})`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('PASS — racing contact wears the car; it does not destroy it.');
}
