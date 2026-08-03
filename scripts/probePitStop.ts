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
 *
 * Run: npm run probe:pitstop
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { loopDelta } from '../src/core/MathUtils';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { TrackSpline } from '../src/track/TrackSpline';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';
import { DRY_COMPOUNDS, type CompoundId } from '../src/data/tires';
import {
  cyclePitCompound, offeredCompounds, pitSheet, setPitCompound, setPitRepair,
  togglePitRepair,
} from '../src/race/PitStop';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

/**
 * The stand-in for a human at the wheel — the game's own AI, driving the
 * player's car, with `pitThisLap` forced false in the perception it reads so it
 * never enters its own pit-approach state. Lifted from `probePitLimiter`, and
 * for the same reason: anything that cannot get round the circuit at racing
 * speed fails for reasons that have nothing to do with the pit lane.
 */
class ProbeDriver {
  private readonly ai: AIVehicleController;
  private readonly view: AIPerception;
  private inLane = false;

  constructor(private readonly car: CarEntry, private readonly track: TrackSpline) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    this.view = { ...car.perception };
  }

  drive(dt: number, out: VehicleControls): void {
    const car = this.car;
    if (car.inPitLane && !this.inLane) { this.inLane = true; this.ai.onPitStopComplete(); }
    Object.assign(this.view, car.perception);
    this.view.pitThisLap = false;

    const c = this.ai.update(dt, car.physics, car.s, car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;

    // Move over to the pit side on the run in: a car has to be on the pit side
    // of the road to be let in, and the AI declines to do it.
    const pit = this.track.def.pitLane;
    const toEntry = loopDelta(car.s, pit.entryS, this.track.length);
    if (!this.inLane && toEntry >= 0 && toEntry < 300) {
      const side = Math.sign(pit.lateralOffsetM) || -1;
      const want = side * this.track.halfWidthAt(car.s) * 0.5;
      out.steer = Math.max(-1, Math.min(1, out.steer - (want - car.lateral) * 0.05));
    }
    out.reverse = c.reverse;
    out.gearRequest = c.gearRequest;
    out.ersMode = c.ersMode;
    out.drsRequested = c.drsRequested;
    out.pitLimiter = false;
  }
}

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

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:pitstop OK');
