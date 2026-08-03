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
 * IN TWO MODES, because the two halves of the defect have to be able to fail
 * separately. The staged run lets everything deal with the car — the marshals
 * take it away, the flags come out, the drivers behind pass what is left. The
 * `[held]` run holds race control out of it (see `HELD_STOPPED_S`) and leaves
 * the drivers alone with the obstacle. Deleting the AI's avoidance and keeping
 * only the retirement passes the first and fails the second, which is exactly
 * the discrimination a probe has to have to be worth running.
 *
 * Run: npm run probe:blockage
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { loopDelta } from '../src/core/MathUtils';

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
 * Seconds the `held` mode pins the blocker's stationary clock at.
 *
 * WHY THIS NUMBER, and it is the whole point of that mode. The engine has two
 * thresholds on how long a car has been standing still, and they are a second
 * apart:
 *
 *   1.0s  `BLOCKAGE_SETTLE_S` — past this the cars behind are told there is
 *         something stopped in front of them, and the AI has to go round it.
 *   2.0s  `STOPPED_ON_TRACK_FLAG_S` — past this race control puts the boards
 *         out, neutralises the race and eventually takes the car away.
 *
 * Holding the clock between them takes RACE CONTROL out of the picture
 * entirely — no flag, no VSC, no retirement — and leaves the AI alone with a
 * stationary obstacle. Every real occurrence passes through this window; this
 * mode holds it open long enough to measure.
 *
 * IT EXISTS BECAUSE THE PROBE WITHOUT IT WAS NOT ENOUGH. Deleting the AI's
 * avoidance entirely and leaving only the retirement still read 93%, 91% and
 * 95% here — race control took the car away after twelve seconds and the field
 * never had to deal with it. A probe that a broken feature passes is worse than
 * no probe, so this is the mode that fails when the AI cannot get past.
 */
const HELD_STOPPED_S = 1.5;

/**
 * How long the `[held]` mode holds the obstacle there, seconds.
 *
 * Much shorter than `OBSERVE_S`, and it has to be, because it is asking a
 * different question. The staged run asks whether the RACE survives, and four
 * minutes is chosen there so that a blocked field cannot be mistaken for a slow
 * one. This asks whether the DRIVERS get past, and the honest length of that
 * job is however long the car is really there for: twelve seconds before it is
 * retired, nine for the marshals to reach it and about sixteen to push it away,
 * so something under a minute. Ninety seconds is generous.
 *
 * Holding it for four minutes instead measures something nobody has to survive.
 * Twenty cars keep arriving at a car welded to the racing line, the road fills
 * up with stopped cars four abreast, and no amount of driving gets anyone out —
 * a real race is red-flagged long before that. A probe that demands the
 * impossible is one that eventually gets its threshold quietly lowered.
 */
const HELD_OBSERVE_S = 90;

/**
 * Cars a minute that must get past the obstacle in `[held]` mode.
 *
 * MEASURED BOTH WAYS, over the 90-second window, with `AIPerception.blockage`
 * forced to null for the broken column and nothing else changed:
 *
 *                  with avoidance      without
 *   monza            3.3 / min          2.0 / min
 *   monaco           3.3 / min          0.0 / min
 *   spa              not measured       6.0 / min
 *
 * 2.5 sits between the two on the circuits that discriminate. SPA DOES NOT
 * DISCRIMINATE and the table says so rather than hiding it: a car standing in
 * the braking zone for La Source is collected within seconds, so the obstacle
 * stops existing and there is nothing left to measure — which is why the check
 * below refuses to quote a rate off a sample that short.
 *
 * If this number is ever in the way, the thing to do is re-measure both columns
 * and put the new table here. Lowering it on its own would delete the only
 * assertion in this file that the AI has to pass.
 */
const PASS_RATE_FLOOR = 2.5;

/**
 * Seconds the obstacle must have survived before its pass rate means anything.
 *
 * A rate quoted off four seconds of standing is one car and a division.
 */
const MIN_STANDING_S = 30;

/**
 * @param pin false runs the identical staging with the blocker left alone. Every
 *        assertion below must then PASS — that is the guard against a probe
 *        which is simply incapable of going green, and it is the first thing to
 *        look at if this file ever reports a failure on the null case.
 * @param held true holds race control out (see `HELD_STOPPED_S`) so the run
 *        measures the AI alone.
 */
function run(circuitId: string, pin = true, held = false): void {
  const steps = (s: number): number => Math.round(s / PHYSICS_DT);

  // --- The control: the same seed, the same circuit, nothing staged ---------
  const control = build(circuitId);
  const observeS = held ? HELD_OBSERVE_S : OBSERVE_S;
  for (let i = 0; i < steps(SETTLE_S + observeS); i++) control.step();

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

  // Cars that get PAST the obstacle while it is still standing there.
  //
  // The lap count below is the field's problem; this is the driver's. A car that
  // arrives behind a stopped one, goes round it and carries on has done the
  // thing an AI has to be able to do, and counting those is the only measurement
  // here that is about the driving rather than about race control.
  const len = engine.track.length;
  const prevDelta = new Map<number, number>();
  let passes = 0;
  let standingS = 0;
  for (const c of engine.cars) {
    if (c.index !== blocker.index) prevDelta.set(c.index, loopDelta(c.s, blocker.s, len));
  }

  for (let i = 0; i < steps(observeS); i++) {
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
    // AFTER the step, because the step is what advances the clock. Holding it
    // here rather than before means the engine has already done its own
    // arithmetic on a genuinely stationary car and only the consequence is
    // withheld.
    if (pin && held && !blocker.retired) blocker.stuckTimer = HELD_STOPPED_S;

    // A pass is the gap to the blocker going from ahead-of-us to behind-us
    // without wrapping. The wrap guard is what keeps a car crossing the start
    // line, or the blocker itself being lapped, out of the count.
    //
    // Only while the obstacle is actually there. A stationary car in a braking
    // zone gets hit sooner or later — at Spa it is collected at La Source
    // within the first minute — and once it has been, the thing being measured
    // has stopped existing. `standingS` is what the count is quoted against.
    if (blocker.retired) continue;
    standingS += PHYSICS_DT;
    for (const c of engine.cars) {
      if (c.index === blocker.index || c.retired || c.inPitLane) continue;
      const d = loopDelta(c.s, blocker.s, len);
      const was = prevDelta.get(c.index);
      if (was !== undefined && was > 0 && d < 0 && was - d < 30) passes++;
      prevDelta.set(c.index, d);
    }
  }

  const stagedLaps = lapsExcluding(engine, blocker.index) - lapsAtStage;
  const moving = engine.cars.filter((c) => !c.retired && c.physics.speedMs > 5).length;
  const alive = engine.cars.filter((c) => !c.retired).length;
  const ratio = controlWindow > 0 ? stagedLaps / controlWindow : 0;
  const label = !pin ? circuitId + ' [null]' : held ? circuitId + ' [held]' : circuitId;

  console.log(
    `${label.padEnd(16)} blocker=${blocker.driver.code} at s=${blockedAtS.toFixed(0)}m  ` +
    `field laps in ${observeS}s: staged ${stagedLaps} vs control ${controlWindow} ` +
    `(${(ratio * 100).toFixed(0)}%)  moving at the end: ${moving}/${alive}` +
    (held
      ? `  cars past the obstacle: ${passes} in ${standingS.toFixed(0)}s standing` +
        ` (${(passes / Math.max(standingS, 1) * 60).toFixed(1)}/min)`
      : ''));

  if (held) {
    // THE DRIVERS GET PAST IT, with race control held out of the picture.
    //
    // This is the AI's assertion and nothing else's. It is a COUNT OF CARS
    // rather than a lap ratio, and that is deliberate: a car welded to the
    // racing line for four minutes while twenty others keep arriving at it is
    // not a situation any amount of driving makes normal — a real race would be
    // red-flagged — so asking for a lap count here would be asking for
    // something unachievable and would eventually be "fixed" by lowering it.
    // What IS achievable, and what the AI is responsible for, is that cars
    // arriving behind a stationary one go round it and carry on.
    //
    // Quoted as a RATE because the obstacle does not always last the window: a
    // stationary car in a braking zone gets collected, and at Spa it is hit at
    // La Source within seconds. See `PASS_RATE_FLOOR` for both measured columns.
    if (standingS < MIN_STANDING_S) {
      console.log(`${''.padEnd(16)} (the obstacle was destroyed after ` +
        `${standingS.toFixed(0)}s — nothing to measure here)`);
      return;
    }
    const rate = passes / standingS * 60;
    check(rate >= PASS_RATE_FLOOR,
      `${label}: ${passes} cars got past a car standing on the racing line in ` +
      `${standingS.toFixed(0)}s (${rate.toFixed(1)}/min, floor ${PASS_RATE_FLOOR}) — ` +
      'the AI is queueing behind it rather than going round it');
    return;
  }

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
    `${label}: ${moving} of ${alive} surviving cars are still moving ${observeS}s after ` +
    'one car stopped on the racing line — the field has queued up behind it');

  // 3. THE STATIONARY CAR IS DEALT WITH. Real race control does not leave a car
  //    stopped on the racing line for four minutes: it is recovered, retired,
  //    or a flag is raised naming it. Only asked of the staged run — there is
  //    nothing to deal with in the null case.
  //
  //    A bare `neutralisation !== 'none'` is deliberately NOT accepted: a safety
  //    car deployed for somebody else's accident would satisfy it, and this has
  //    to be about THIS car.
  if (pin && !held) {
    const handled = blocker.retired ||
      engine.raceControl.messages.some((m) => m.carIndex === blocker.index && m.time > SETTLE_S);
    check(handled,
      `${label}: a car stood still on the racing line for ${observeS}s and race control ` +
      'never retired it, never recovered it and never raised a flag naming it');
  }
}

// The null case FIRST, so a broken probe is identified before any of its
// verdicts about the simulation are believed.
run(CIRCUITS[0], false);
// Then the whole thing: a car stops, and everything the simulation has —
// marshals, flags, the drivers behind — gets to deal with it.
for (const id of CIRCUITS) run(id);
// Then the drivers on their own, with race control held out. This is the mode
// that fails if the AI cannot pass a stationary car; the one above is not,
// because retiring the car twelve seconds in hides the AI's half of the job.
for (const id of CIRCUITS) run(id, true, true);

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — a car stopped on the racing line does not stop the race.');
}
