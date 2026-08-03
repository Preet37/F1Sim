/**
 * Can the race survive a car stopped ON the racing surface?
 *
 * WHY THIS EXISTS. `probe:hudtext` has failed for a long time on one assertion
 * — "no team-owned bulletin was filed in a 20-minute race" — and the recorded
 * diagnosis was an engine call site that never fires. It is not. The probe
 * builds a race with `playerIndex: 0` and never touches `engine.playerControls`,
 * so the player's car sits on its grid box at zero throttle for the whole race.
 * Within sixty seconds the ENTIRE FIELD is queued nose-to-tail behind it and
 * stationary, and it never moves again: no laps, no pit stops, no damage, and
 * therefore no team bulletins. The probe was not failing on a missing call
 * site, it was failing on a frozen race.
 *
 * Underneath that harness artefact is a real defect, and this probe is about
 * the defect rather than the artefact:
 *
 *   1. `RaceEngine.checkBeached` is the ONLY thing that clears a stationary car,
 *      and it is gated on `Math.abs(car.lateral) > halfWidth + 2` — the car must
 *      be OFF the road. A car stopped on the racing line is never retired, never
 *      recovered, and raises no stationary-car flag. The method's own comment
 *      says a beached car left in place "stops the race ever finishing", which
 *      is exactly what a car stopped on the road does, only sooner.
 *
 *   2. The AI will not pass a stationary car. It closes up behind it and brakes
 *      to a standstill, and the car behind that does the same, until the whole
 *      field is stopped.
 *
 * The player reaches this state by spinning to a halt on the road, stalling on
 * the grid, or putting the controller down. So this probe stages it WITHOUT a
 * player — every car AI, one of them pinned to the asphalt mid-race — which is
 * the same defect with the harness artefact removed.
 *
 * WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: the field stops making progress
 * past a stationary car. That is measured as laps completed by cars OTHER than
 * the blocker, against a control run of the identical seed with no blockage.
 * Both runs share a seed and a circuit, so the control absorbs the simulation's
 * own attrition and the comparison is about the blockage alone.
 *
 * Run: npm run probe:blockage
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

/** Circuits picked for width: a wide one, a medium one and a narrow one. */
const CIRCUITS = ['monza', 'spa', 'monaco'];
const SEED = 20260803;
/** Let the field spread and start racing before anything is staged. */
const SETTLE_S = 90;
/** Long enough that a blocked field cannot be mistaken for a slow one. */
const OBSERVE_S = 240;

function build(circuitId: string): RaceEngine {
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 40,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: SEED,
  };
  return new RaceEngine(getCircuit(circuitId), config);
}

/** Laps completed by every car except `exclude`. */
function lapsExcluding(engine: RaceEngine, exclude: number): number {
  let n = 0;
  for (const c of engine.cars) if (c.index !== exclude) n += c.lap;
  return n;
}

/**
 * @param pin false runs the identical staging with the blocker left alone. Every
 *        assertion below must then PASS — that is the guard against a probe
 *        which is simply incapable of going green, and it is the first thing to
 *        look at if this file ever reports a failure on the null case.
 */
function run(circuitId: string, pin = true): void {
  const steps = (s: number): number => Math.round(s / PHYSICS_DT);

  // --- The control: the same seed, the same circuit, nothing staged ---------
  const control = build(circuitId);
  for (let i = 0; i < steps(SETTLE_S + OBSERVE_S); i++) control.step();

  // --- The staged run ------------------------------------------------------
  const engine = build(circuitId);
  for (let i = 0; i < steps(SETTLE_S); i++) engine.step();

  // Block with a car in the middle of the running order, so there is a field
  // both ahead of it and behind it. A blocker at the back proves nothing.
  const runners = engine.standings.filter((c) => !c.retired && !c.inPitLane);
  if (runners.length < 6) {
    failures.push(`${circuitId}: only ${runners.length} cars running after ${SETTLE_S}s — ` +
      'the staging window is wrong, not the simulation');
    return;
  }
  const blocker = runners[Math.floor(runners.length / 2)];
  const blockedAtS = blocker.s;

  const lapsAtStage = lapsExcluding(engine, blocker.index);

  // The control's lap count over the SAME window: run a second control only as
  // far as the staging point and difference the two. The blocker is excluded
  // from both sides, so the comparison is the rest of the field against itself.
  const controlSettle = build(circuitId);
  for (let i = 0; i < steps(SETTLE_S); i++) controlSettle.step();
  const controlWindow = lapsExcluding(control, blocker.index) -
    lapsExcluding(controlSettle, blocker.index);

  for (let i = 0; i < steps(OBSERVE_S); i++) {
    // Pin the blocker to the asphalt on the racing line. Re-applied every step
    // because the engine integrates it like any other car; this is a car that
    // has stopped, not one that has been removed.
    if (pin && !blocker.retired) {
      blocker.physics.velocity.set(0, 0);
      blocker.physics.localVelX = 0;
      blocker.physics.localVelY = 0;
      blocker.lateral = 0;
    }
    engine.step();
  }

  const stagedLaps = lapsExcluding(engine, blocker.index) - lapsAtStage;
  const moving = engine.cars.filter((c) => !c.retired && c.physics.speedMs > 5).length;
  const alive = engine.cars.filter((c) => !c.retired).length;
  const ratio = controlWindow > 0 ? stagedLaps / controlWindow : 0;
  const label = pin ? circuitId : circuitId + ' [null]';

  console.log(
    `${label.padEnd(16)} blocker=${blocker.driver.code} at s=${blockedAtS.toFixed(0)}m  ` +
    `field laps in ${OBSERVE_S}s: staged ${stagedLaps} vs control ${controlWindow} ` +
    `(${(ratio * 100).toFixed(0)}%)  moving at the end: ${moving}/${alive}`);

  // 1. THE FIELD KEEPS RACING. A stationary car costs the cars immediately
  //    behind it time; it must not cost the field its race. Half the control's
  //    lap count is a generous floor — a working simulation loses far less.
  check(ratio >= 0.5,
    `${label}: with one car stopped on the racing line the field completed ${stagedLaps} laps ` +
    `against ${controlWindow} unblocked (${(ratio * 100).toFixed(0)}%) — the blockage stops the race`);

  // 2. THE FIELD IS STILL MOVING AT THE END. The lap count above can be met by
  //    a field that crawls to a halt in the last thirty seconds, and a race
  //    that is stopped is stopped whenever it happened.
  check(moving >= Math.max(2, Math.floor((alive - 1) * 0.5)),
    `${label}: ${moving} of ${alive} surviving cars are still moving ${OBSERVE_S}s after ` +
    'one car stopped on the racing line — the field has queued up behind it');

  // 3. THE STATIONARY CAR IS DEALT WITH. Real race control does not leave a car
  //    stopped on the racing line for four minutes: it is recovered, retired,
  //    or a flag is raised naming it. Only asked of the staged run — there is
  //    nothing to deal with in the null case.
  //
  //    A bare `neutralisation !== 'none'` is deliberately NOT accepted: a safety
  //    car deployed for somebody else's accident would satisfy it, and this has
  //    to be about THIS car.
  if (pin) {
    const handled = blocker.retired ||
      engine.raceControl.messages.some((m) => m.carIndex === blocker.index && m.time > SETTLE_S);
    check(handled,
      `${label}: a car stood still on the racing line for ${OBSERVE_S}s and race control ` +
      'never retired it, never recovered it and never raised a flag naming it');
  }
}

// The null case FIRST, so a broken probe is identified before any of its
// verdicts about the simulation are believed.
run(CIRCUITS[0], false);
for (const id of CIRCUITS) run(id);

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — a car stopped on the racing line does not stop the race.');
}
