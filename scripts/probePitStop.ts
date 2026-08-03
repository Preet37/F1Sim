/**
 * Does the stop you chose become the stop you get?
 *
 * WHY THIS EXISTS. It did not.
 *
 *   "when I tried to choose the options, I don't think it followed, I chose
 *    hard at one point and saying to fix my wing, but it gave me softs"
 *
 * and the screenshot backed it: the panel said `the engineers would fit hard`,
 * the status line said `BOX AHEAD · hard`, and the SOFT tile was the one drawn
 * as chosen. Three answers to one question. The cause was that there were
 * three answers to compute — a class list written inside a click handler, a
 * briefing that worked out the crew's pick by deleting the driver's instruction
 * off the car and putting it back, and a private chooser at the box — and
 * nothing held them together but care.
 *
 * A screenshot cannot catch that, because a screenshot is one frame of the
 * display and the fault is a disagreement between the display and the car. So
 * this probe never looks at the panel. It drives a real player car into a real
 * pit box on a real circuit, having set the choice through the SAME functions
 * the keyboard, the gamepad and a tap all call, and then asks the car what it
 * came out on.
 *
 * What is asserted, for every compound and with the wing both repaired and not:
 *
 *   1. The sheet's `fitting` is the compound the engine will fit. Not a
 *      re-derivation — `pitSheet` is asked, and the answer is compared against
 *      the tyre bolted on at the far end of a full stop.
 *   2. Exactly one tile is selected, and it is that compound.
 *   3. The front wing instruction survives the drive down the lane: asking for
 *      a new nose gets one and costs the time, declining keeps the damage.
 *   4. Cycling — what the T key and the D-pad do — visits every offered
 *      compound and comes back, and the sheet agrees at every step.
 *   5. Reading the sheet does not MOVE the sheet. `pitSheet` is called a
 *      hundred times between the call and the box, exactly as a 60fps HUD
 *      calls it, and the driver's instruction is still there at the end.
 *   6. A stop the PIT WALL called and the driver then waved off stays waved
 *      off. See §6 — this is the same latch as issue #32 read the other way
 *      round, and it is the assertion that would have caught both.
 *
 * WHAT §1 IS REALLY MEASURING. Six of its seven cases — every one that chooses
 * a compound — failed on `main` for six weeks (issue #32) because the pit wall
 * cancelled any stop the driver had picked a tyre for, 8ms after they picked
 * it. The "the car never completed a stop" line is not a harness complaint; it
 * is the game-breaking symptom. Deliberately restoring that cancel turns §1
 * red in exactly the six cases the issue reported, which is the evidence that
 * this probe is load-bearing rather than decorative.
 *
 * Run: npm run probe:pitstop
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
// Shared with `diagPitChoice`, which needs the same driver to be able to
// separate this probe's failing cases from each other. See `lib/pitDriver`.
import { ProbeDriver } from './lib/pitDriver';
import { DRY_COMPOUNDS, type CompoundId } from '../src/data/tires';
import {
  clearPitOrder, cyclePitCompound, offeredCompounds, pitSheet, setPitCompound,
  setPitRepair, togglePitRepair,
} from '../src/race/PitStop';
import type { PitWallContext } from '../src/race/Weather';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

interface Stop {
  /** What the sheet said was going on, taken the instant the choice was made. */
  sheetFitting: CompoundId;
  /** What the sheet said one step before the box. */
  sheetAtBox: CompoundId;
  /** What the car actually came out on. */
  fitted: CompoundId | null;
  /** Did the nose come off? */
  noseChanged: boolean;
  wingAfter: number;
  stationaryS: number;
  selectedTiles: CompoundId[];
  warned: boolean;
}

/**
 * One stop, start to finish.
 *
 * The car is placed 900m before the pit entry with a damaged nose and a stop
 * called, the choice is made through the shared mutators, and then it is driven
 * in. `pitSheet` is polled on every step at frame rate, which is what the HUD
 * does and which is exactly the traffic that used to destroy the instruction.
 */
function driveStop(
  circuitId: string, want: CompoundId | null, repair: 'crew' | 'change' | 'keep',
): Stop {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race', name: 'Pit stop probe', durationS: 0, laps: 20,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 24601,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const player = engine.cars[0];
  // One car and one stretch of road. Nineteen AI cars converging on the same
  // pit box is a different experiment.
  for (const car of engine.cars) if (car !== player) car.eliminated = true;

  const startS = (pit.entryS - 900 + track.length) % track.length;
  const idx = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[idx], track.targetSpeed[idx]);
  // A damaged nose, so the wing decision is a real one with a real cost.
  player.damage.health.frontWingL = 0.5;
  player.damage.health.frontWingR = 0.5;
  player.physics.spec = player.damage.applyTo(player.physics.baseSpec);

  engine.requestPit(player, true);
  if (want !== null) setPitCompound(player, want);
  setPitRepair(player, repair);

  const chosen = pitSheet(engine, player);
  const stop: Stop = {
    sheetFitting: chosen.fitting,
    sheetAtBox: chosen.fitting,
    fitted: null,
    noseChanged: false,
    wingAfter: 1,
    stationaryS: 0,
    selectedTiles: chosen.tiles.filter((t) => t.selected).map((t) => t.id),
    warned: chosen.warning.length > 0,
  };

  const driver = new ProbeDriver(player, track);
  const controls = engine.playerControls;
  let peakBoxTimer = 0;

  for (let i = 0; i < Math.round(200 / PHYSICS_DT); i++) {
    driver.drive(PHYSICS_DT, controls);
    engine.step();
    if (player.retired) break;

    // The HUD's traffic. A read that mutates the model would show up here and
    // nowhere else, which is how the original fault escaped for a whole round.
    const live = pitSheet(engine, player);
    if (!player.inPitBox && player.pitStops === 0) stop.sheetAtBox = live.fitting;
    if (player.inPitBox) peakBoxTimer = Math.max(peakBoxTimer, player.pitBoxTimer);

    if (player.pitStops > 0) {
      stop.fitted = player.compound;
      stop.noseChanged = player.pitNoseChanging;
      stop.wingAfter = Math.min(player.damage.health.frontWingL, player.damage.health.frontWingR);
      stop.stationaryS = peakBoxTimer;
      break;
    }
  }
  return stop;
}

// ---------------------------------------------------------------------------
// 1. Every compound, with the wing repaired and not
// ---------------------------------------------------------------------------

console.log('choice -> stop, silverstone');
let served = 0;
for (const want of DRY_COMPOUNDS) {
  for (const repair of ['change', 'keep'] as const) {
    const s = driveStop('silverstone', want, repair);
    const ok = s.fitted !== null;
    served += ok ? 1 : 0;
    console.log(
      `  chose ${want.padEnd(6)} wing=${repair.padEnd(6)}` +
      ` -> fitted ${String(s.fitted).padEnd(6)}` +
      ` nose=${s.noseChanged ? 'new ' : 'kept'}` +
      ` wing=${s.wingAfter.toFixed(2)}` +
      ` stationary=${s.stationaryS.toFixed(1)}s`,
    );

    check(ok, `${want}/${repair}: the car never completed a stop, so nothing was proved`);
    if (!ok) continue;

    // THE assertion. The tyre the driver asked for is the tyre on the car.
    check(s.fitted === want,
      `${want}/${repair}: asked for ${want}, came out on ${s.fitted}`);
    // And the sheet said so, before the stop and at the box.
    check(s.sheetFitting === want,
      `${want}/${repair}: the sheet said ${s.sheetFitting} was going on, not ${want}`);
    check(s.sheetAtBox === want,
      `${want}/${repair}: the sheet drifted to ${s.sheetAtBox} on the way down the lane`);
    // Exactly one tile is highlighted, and it is that one. The reported fault
    // was two different tyres claiming to be the answer at the same time.
    check(s.selectedTiles.length === 1 && s.selectedTiles[0] === want,
      `${want}/${repair}: tiles selected = [${s.selectedTiles.join(', ')}], expected [${want}]`);

    // The wing. Asking for it gets it and costs the time; declining keeps the
    // damage and keeps the seconds.
    if (repair === 'change') {
      check(s.noseChanged, `${want}: asked for a new nose and did not get one`);
      check(s.wingAfter > 0.99, `${want}: nose changed but the wing is still at ${s.wingAfter.toFixed(2)}`);
      check(s.stationaryS > 9, `${want}: a nose change took only ${s.stationaryS.toFixed(1)}s stationary`);
    } else {
      check(!s.noseChanged, `${want}: declined the nose and the crew changed it anyway`);
      check(s.wingAfter < 0.6, `${want}: declined the nose but the wing was repaired to ${s.wingAfter.toFixed(2)}`);
      check(s.stationaryS < 9, `${want}: declined the nose and was still held ${s.stationaryS.toFixed(1)}s`);
    }
  }
}
check(served === DRY_COMPOUNDS.length * 2, `${served} of ${DRY_COMPOUNDS.length * 2} stops completed`);

// ---------------------------------------------------------------------------
// 2. Leaving it to the crew is still a coherent stop
// ---------------------------------------------------------------------------

{
  const s = driveStop('silverstone', null, 'crew');
  console.log(`  chose nothing        -> fitted ${s.fitted} nose=${s.noseChanged ? 'new' : 'kept'}`);
  check(s.fitted !== null, 'a driver who chooses nothing must still get a stop');
  check(s.fitted === s.sheetFitting,
    `the crew fitted ${s.fitted} while the sheet promised ${s.sheetFitting}`);
  check(s.selectedTiles.length === 1,
    `with no instruction the sheet highlighted ${s.selectedTiles.length} tiles, expected 1`);
  // The wing is at 50%, under the crew's own 70% rule, so the default is a new
  // nose — and the sheet has to have said so before it happened.
  check(s.noseChanged, 'a nose at 50% left to the crew must be changed');
}

// ---------------------------------------------------------------------------
// 3. Cycling, which is what the keyboard and the D-pad do
// ---------------------------------------------------------------------------

{
  const def = getCircuit('monza');
  const config: SessionConfig = {
    kind: 'race', name: 'cycle', durationS: 0, laps: 40,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 11,
  };
  const engine = new RaceEngine(def, config);
  const car = engine.cars[0];
  const offered = offeredCompounds(engine, car);
  check(offered.length === 3,
    `a dry race offered ${offered.length} compounds; wets must not be on a dry sheet`);

  // Forward, all the way round, back to where it started.
  const seen: CompoundId[] = [];
  for (let i = 0; i < offered.length; i++) {
    cyclePitCompound(engine, car, 1);
    const sheet = pitSheet(engine, car);
    seen.push(sheet.fitting);
    check(sheet.fitting === car.pitCompoundRequest,
      `cycle ${i}: the sheet shows ${sheet.fitting}, the car holds ${car.pitCompoundRequest}`);
    check(sheet.tiles.filter((t) => t.selected).length === 1,
      `cycle ${i}: ${sheet.tiles.filter((t) => t.selected).length} tiles selected`);
  }
  check(new Set(seen).size === offered.length,
    `cycling visited ${new Set(seen).size} of ${offered.length} compounds: ${seen.join(' -> ')}`);
  console.log(`cycle forward: ${seen.join(' -> ')}`);

  // And backwards, which is the other direction of the same control.
  const back: CompoundId[] = [];
  for (let i = 0; i < offered.length; i++) {
    cyclePitCompound(engine, car, -1);
    back.push(pitSheet(engine, car).fitting);
  }
  check(new Set(back).size === offered.length,
    `cycling backwards visited ${new Set(back).size} of ${offered.length}: ${back.join(' -> ')}`);

  // The wing toggle is two states and lands on a real decision either way.
  car.damage.health.frontWingL = 0.4;
  car.damage.health.frontWingR = 0.4;
  const first = engine.noseChangeForStop(car);
  togglePitRepair(engine, car);
  check(engine.noseChangeForStop(car) === !first, 'toggling the wing did not change the decision');
  check(car.pitNoseChangeRequest !== null, 'toggling the wing left the call with the crew');
  togglePitRepair(engine, car);
  check(engine.noseChangeForStop(car) === first, 'toggling the wing twice did not come back');
  console.log('wing toggle: two states, both explicit');
}

// ---------------------------------------------------------------------------
// 4. Reading the sheet does not move the sheet
// ---------------------------------------------------------------------------

{
  const def = getCircuit('monaco');
  const config: SessionConfig = {
    kind: 'race', name: 'purity', durationS: 0, laps: 50,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 5,
  };
  const engine = new RaceEngine(def, config);
  const car = engine.cars[0];
  setPitCompound(car, 'hard');
  setPitRepair(car, 'keep');

  // 600 calls: ten seconds of a 60fps HUD, which is roughly a pit entry.
  const first = pitSheet(engine, car);
  for (let i = 0; i < 600; i++) {
    pitSheet(engine, car);
    engine.pitBriefing(car);
    engine.compoundForStint(car, true);
  }
  const last = pitSheet(engine, car);
  check(car.pitCompoundRequest === 'hard',
    `600 reads of the sheet turned the instruction into ${car.pitCompoundRequest}`);
  check(car.pitNoseChangeRequest === false,
    `600 reads of the sheet turned the wing call into ${car.pitNoseChangeRequest}`);
  check(first.fitting === last.fitting && last.fitting === 'hard',
    `the sheet drifted from ${first.fitting} to ${last.fitting} while only being read`);
  console.log('600 reads: instruction intact');
}

// ---------------------------------------------------------------------------
// 5. The rule the driver can break, and is told about
// ---------------------------------------------------------------------------

{
  const def = getCircuit('bahrain');
  const config: SessionConfig = {
    kind: 'race', name: 'rule', durationS: 0, laps: 20,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 3,
  };
  const engine = new RaceEngine(def, config);
  const car = engine.cars[0];
  car.compound = 'medium';
  car.usedCompounds.length = 0;
  car.usedCompounds.push('medium');
  car.lap = 15;

  // Choosing the compound already run, on the last stop, is a disqualification
  // at the flag — and the engine will let the driver do it, deliberately. The
  // sheet's job is to say so rather than to overrule.
  setPitCompound(car, 'medium');
  const bad = pitSheet(engine, car);
  check(bad.fitting === 'medium', 'the driver was overruled; the sheet is meant to be an instruction');
  check(bad.warning.length > 0, 'fitting a used compound on the last stop raised no warning');

  setPitCompound(car, 'hard');
  const good = pitSheet(engine, car);
  check(good.warning === '', `a legal choice raised a warning: "${good.warning}"`);
  console.log('two-compound rule: warned, not overruled');
}

// ---------------------------------------------------------------------------
// 6. "Stay out, stay out" — a stop the WALL called, waved off by the driver
// ---------------------------------------------------------------------------
//
// The other half of issue #32. That issue was the pit wall CANCELLING a stop
// the driver called; this is the pit wall REINSTATING one the driver cancelled,
// and it is the same latch read the other way round.
//
// `PitWall.boxRequested` is a latch, not an event: it stands from the moment
// the driver says yes on the radio until the stop is served. The engine mirrors
// it onto `car.pitRequested` every physics step. `requestPit(car, false)` — the
// PIT button, and the only way a player can wave a stop off — wrote only to
// `car.pitRequested`, so the mirror put it straight back 8ms later, together
// with the wall's own tyre. The radio said "Stay out, stay out" and the car
// pitted anyway, on a compound the driver had just cleared.
//
// Driven through the real controls: the wall's own `answer()` for the yes, and
// `requestPit` + `clearPitOrder` for the wave-off, which is exactly what
// `main.ts:togglePitRequest` calls.

{
  const def = getCircuit('silverstone');
  const config: SessionConfig = {
    kind: 'race', name: 'wave-off', durationS: 0, laps: 20,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 24601,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const player = engine.cars[0];
  for (const car of engine.cars) if (car !== player) car.eliminated = true;

  const startS = (pit.entryS - 900 + track.length) % track.length;
  const idx = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[idx], track.targetSpeed[idx]);

  // Get a real box call out of the engine's own wall, by driving it with the
  // wet context the weather would give it. Rain arriving is the one situation
  // where the wall calls a driver in unprompted, and it is the situation the
  // player meets it in.
  const wall = engine.pitWall;
  check(wall !== null, 'the player has no pit wall');
  const ctx: PitWallContext = {
    timeS: 0, compound: 'medium', dryPreference: 'medium',
    wetness: 0.05, trackTempC: 30, lapsRemaining: 18,
    refLapS: 92, pitCostS: 22, usedDryCompounds: ['medium'],
    hasRained: false, racing: true, projectedWetness: 0.75,
    horizonLaps: 3,
    forecast: { etaS: 140, intensity: 0.8, precipitation: 'rain', confidence: 0.78, worsening: true },
  };
  let call = wall?.pending ?? null;
  for (let i = 0; i < 200 && wall && !call; i++) { wall.update(0.1, ctx); call = wall.pending; }
  check(call !== null, 'the wall never offered a stop with heavy rain on the way');
  const answered = call && wall ? wall.answer(call.id, true) : 'lapsed';
  check(answered === 'yes', 'the driver said yes to the box call and it did not take');

  const driver = new ProbeDriver(player, track);
  const controls = engine.playerControls;

  // One step for the engine to mirror the wall's call onto the car.
  driver.drive(PHYSICS_DT, controls);
  engine.step();
  console.log(`wall calls in        -> pitRequested=${player.pitRequested}` +
    ` compound=${player.pitCompoundRequest}`);
  check(player.pitRequested, 'the driver agreed to box and the car was never called in');

  // Now the driver changes their mind. This is the PIT button, verbatim.
  engine.requestPit(player, false);
  clearPitOrder(player);

  let backAfterSteps = -1;
  let compoundWhenBack: string | null = null;
  let reachedLane = false;
  let travelledM = 0;
  for (let i = 0; i < Math.round(60 / PHYSICS_DT); i++) {
    driver.drive(PHYSICS_DT, controls);
    engine.step();
    if (backAfterSteps < 0 && player.pitRequested) {
      backAfterSteps = i;
      compoundWhenBack = player.pitCompoundRequest;
    }
    if (player.inPitLane) reachedLane = true;
    travelledM = Math.max(travelledM, (player.s - startS + track.length) % track.length);
    if (player.retired || player.pitStops > 0) break;
  }
  console.log(`driver waves it off  -> request back after ${backAfterSteps < 0 ? 'never' : backAfterSteps + ' step(s)'}` +
    ` compound=${compoundWhenBack} lane=${reachedLane ? 'yes' : 'no'} stops=${player.pitStops}` +
    ` drove ${travelledM.toFixed(0)}m`);

  // THE VACUITY GUARD, and it is not optional. "The car did not pit" is also
  // what a car that crashed 200m after the wave-off reports, and this section
  // would then go green having proved nothing — which is the exact failure the
  // first attempt at `diag:pitchoice` shipped. The car has to actually reach
  // and pass the pit entry, 900m away, with the wave-off standing.
  check(!player.retired && travelledM > 900,
    `the car never reached the pit entry (drove ${travelledM.toFixed(0)}m of 900m, ` +
    `retired=${player.retired}), so the wave-off was never tested`);

  check(backAfterSteps < 0,
    `the driver waved the stop off and the wall put it back ${backAfterSteps} step(s) later`);
  check(compoundWhenBack === null,
    `the wave-off cleared the tyre choice and the wall wrote ${compoundWhenBack} back onto the car`);
  check(!reachedLane && player.pitStops === 0,
    `the driver said "stay out" and the car pitted anyway (${player.pitStops} stop(s))`);
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:pitstop OK');
