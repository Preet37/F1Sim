/**
 * THE EFFECTS ON AND AROUND THE CAR — issues #11, #34, #19
 *
 * ===========================================================================
 * WHY THIS PROBE IS SHAPED THE WAY IT IS
 * ===========================================================================
 *
 * Issue #11 is not "an effect looks wrong". It is:
 *
 *   *"sparks don't fly until like the car is braking so idk why they are
 *    constantly flying"*
 *   *"f1 cars don't leave marks unless they lock up"*
 *
 * Both of those are complaints about an effect firing WHEN IT SHOULD NOT. An
 * effects probe that asserts "sparks were drawn" and "rubber was laid" passes
 * with flying colours on the exact build those two sentences were written
 * against — it fired sparks on every straight of every lap and painted a black
 * line through every corner, so "something was drawn" was more true then than
 * it is now. That is PROJECT.md §3.2 in its purest form and it is the trap this
 * file is built to avoid.
 *
 * So every section here asserts BOTH directions:
 *
 *   - the effect fires when it should      (or the fix is "delete the effect")
 *   - the effect does NOT fire when it should not
 *
 * and it does so by publishing, on the same frame, the emission counts AND the
 * physics state that was supposed to have caused them. `EffectsDirector.frame`
 * is that channel; see `FxFrame`.
 *
 * ===========================================================================
 * SECTIONS
 * ===========================================================================
 *
 *  1. SPARKS — fired only by the plank grounding out, never continuously, and
 *     not as a disguised function of speed. Eleven circuits.
 *  2. RUBBER — laid only by lock-up or wheelspin, never by cornering slip; a
 *     clean lap leaves nothing and a staged lock-up leaves a mark.
 *  3. THE PURPLE — the chromatic aberration is gone and the radial blur's taps
 *     merge instead of resolving as copies. Measured off the shader source.
 *  4. THE REAR LAMPS — the real `RearLight` rule, and where the three lenses
 *     physically are against Art. C14.3.
 *  5. PER-TEAM ACTUATION — that the four archetypes reach the actual grid.
 *
 * Sections 3, 4 and 5 need no simulation and run in under a second. Section 1
 * and 2 drive real races, which is the expensive part.
 *
 * Run: npm run probe:effects
 *
 * PROVING IT GOES RED. §3.2 again: a probe nobody has watched fail is a probe
 * nobody has tested. Two mechanisms, and the split is deliberate.
 *
 *   FX_BREAK=chroma | blur | teams | flash
 *     re-introduces one historical defect FROM THE PROBE SIDE — a substitution
 *     in the shader text this section reads, or a forced answer from the lookup
 *     it queries. Nothing in `src/` changes, so these can be run at any time by
 *     anybody and are the ones to reach for first.
 *
 *   The spark, rubber and lamp-placement sections cannot be broken that way,
 *   because what they measure is a real simulation and a real parts list. Those
 *   were proved red by editing `EffectsDirector.ts` and `CarMesh.ts` back to
 *   the pre-fix code, running, and reverting — the numbers are recorded in
 *   PROJECT.md §6 under this work. Adding a break path to the effects hot loop
 *   to avoid that would put a branch in the renderer that only a probe takes,
 *   which is the thing `probe:assets` is careful about and worth being careful
 *   about here too.
 */

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { installCanvasStub } from './lib/domStub';

installCanvasStub();

const { RaceEngine } = await import('../src/race/RaceEngine');
type SessionConfig = import('../src/race/RaceEngine').SessionConfig;
const { getCircuit } = await import('../src/data/tracks/circuits');
const { EffectsDirector } = await import('../src/render/EffectsDirector');
const { updateRenderPoses } = await import('../src/render/RenderPose');
const { PHYSICS_DT } = await import('../src/core/SimClock');
const { rearLightState, rearLightLevel, HARVEST_FLASH_FRAC, REAR_LIGHT_FLASH_HZ } =
  await import('../src/render/RearLight');
const { actuationForTeam, carPartsForProbe, REAR_LAMPS, ACTUATION } =
  await import('../src/render/CarMesh');
const { F1_2026 } = await import('../src/data/roster/f1-2026');

const BREAK = process.env.FX_BREAK ?? '';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); console.log('    FAIL — ' + msg); }
let checks = 0;
function ok(): void { checks++; }
function check(cond: boolean, msg: string): void { if (cond) ok(); else fail(msg); }

function pad(s: string, w: number): string { return s.padStart(w); }
function padr(s: string, w: number): string { return s.padEnd(w); }
function f(n: number, d = 2): string { return n.toFixed(d); }

/** PROJECT.md §3.5: every rendering fix in this project was shipped broken on
 *  ten circuits after being verified on one. */
const CIRCUITS = process.env.FX_CIRCUITS
  ? process.env.FX_CIRCUITS.split(',').map((s) => s.trim()).filter(Boolean)
  : [...F1_2026.calendar];

// ===========================================================================
// The harness: a real race, drawn at a real frame rate
// ===========================================================================

interface Sample {
  sparks: number; rubber: number; smoke: number;
  plankLoad: number; sinceGroundedS: number;
  brake: number; speed: number; lockup: number; wheelSpin: number;
}

interface Run {
  /** Frames of the focus car, in order. */
  focus: Sample[];
  /** Laps the focus car completed while being sampled. */
  laps: number;
  /** Worst offence found anywhere in the FIELD, not just on the focus car. */
  sparkOffTrigger: { s: number; gap: number } | null;
  rubberOffTrigger: { lockup: number; spin: number } | null;
  /** Rubber quads laid, per car-lap, over the whole field. */
  fieldRubberPerCarLap: number;
  /** The quietest car-lap in the field: fewest rubber quads laid. */
  quietestCarLapRubber: number;
  /** Total spark particles emitted by the focus car. */
  focusSparks: number;
}

/**
 * How long the plank may have been clear of the road before a spark emitted
 * there is a defect, in seconds.
 *
 * NOT a negotiated tolerance. `fx.compression` is a one-pole filter at
 * `0.72/0.28`, so from a full strike it decays under `SPARK_STRIKE_GATE` in
 * about a dozen frames — 0.20s at the 60fps this probe draws at — and that persistence is
 * deliberate: a shower should carry over a crest rather than switch off between
 * two physics steps. Half a second is that decay with a factor of 2.5 on it.
 * The artefact this exists to catch had NO decay in it at all: it fired for the
 * whole of every straight, so it fails this at any bound above the filter's own
 * settling time.
 */
const SPARK_MEMORY_S = 0.5;

/** Drawn at 60fps: the effects are rate-based off dt, not per frame. */
const FRAME_DT = 1 / 60;

function race(circuitId: string, laps: number, seed: number): Run {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config);
  const fx = new EffectsDirector('high');
  fx.loadSession(engine);

  const focusIndex = 0;
  const cam = new THREE.Vector3();
  const run: Run = {
    focus: [], laps: 0, sparkOffTrigger: null, rubberOffTrigger: null,
    fieldRubberPerCarLap: 0, quietestCarLapRubber: Infinity, focusSparks: 0,
  };

  const rubberByCar = new Array<number>(engine.cars.length).fill(0);
  const lapsByCar = new Array<number>(engine.cars.length).fill(0);

  let acc = 0;
  let startLap = -1;
  // Two physics steps to one drawn frame at 60fps against a 120Hz solver.
  const stepsPerFrame = Math.max(1, Math.round(FRAME_DT / PHYSICS_DT));

  for (let step = 0; step < 3_000_000 && !engine.over; step++) {
    engine.step();
    acc++;
    if (acc < stepsPerFrame) continue;
    acc = 0;

    updateRenderPoses(engine.cars, engine.track.length, 1);
    const focus = engine.cars[focusIndex];
    if (!focus) break;
    // The camera rides on the focus car so its LOD is 1 and its emission rates
    // are the full-rate ones a player sees. Nothing visual depends on this;
    // `EffectsDirector` uses the camera for distance culling and for nothing
    // else. The trigger CONDITIONS are LOD-independent, which is why the
    // field-wide offence checks below are still valid for the other cars.
    cam.set(focus.renderX, 1, focus.renderZ);
    fx.update(FRAME_DT, engine, cam);

    if (!engine.started) continue;
    if (startLap < 0) startLap = focus.lap;

    for (let i = 0; i < engine.cars.length; i++) {
      const t = fx.frame[i];
      if (!t || !t.live) continue;

      // --- OFFENCE 1: a spark struck by nothing ---------------------------
      if (t.sparks > 0 && t.sinceGroundedS > SPARK_MEMORY_S) {
        if (!run.sparkOffTrigger || t.sinceGroundedS > run.sparkOffTrigger.gap) {
          run.sparkOffTrigger = { s: t.speed, gap: t.sinceGroundedS };
        }
      }
      // --- OFFENCE 2: rubber laid by a rolling tyre -----------------------
      // 0.12 is `WHEELSPIN_MARK_THRESHOLD` in `EffectsDirector`. A tyre that is
      // neither locked nor spinning is ROLLING, and a rolling tyre leaves
      // nothing however far it is sliding sideways — which is the whole of
      // "f1 cars don't leave marks unless they lock up".
      if (t.rubber > 0 && t.lockup <= 0 && t.wheelSpin <= 0.12) {
        if (!run.rubberOffTrigger) run.rubberOffTrigger = { lockup: t.lockup, spin: t.wheelSpin };
      }
      rubberByCar[i] += t.rubber;
    }

    const ft = fx.frame[focusIndex];
    if (ft && ft.live) {
      run.focus.push({
        sparks: ft.sparks, rubber: ft.rubber, smoke: ft.smoke,
        plankLoad: ft.plankLoad, sinceGroundedS: ft.sinceGroundedS,
        brake: ft.brake, speed: ft.speed, lockup: ft.lockup, wheelSpin: ft.wheelSpin,
      });
      run.focusSparks += ft.sparks;
    }
  }

  for (let i = 0; i < engine.cars.length; i++) lapsByCar[i] = Math.max(1, engine.cars[i].lap);
  run.laps = Math.max(1, (engine.cars[focusIndex]?.lap ?? 1) - Math.max(0, startLap));
  let totalRubber = 0, totalLaps = 0;
  for (let i = 0; i < engine.cars.length; i++) {
    totalRubber += rubberByCar[i];
    totalLaps += lapsByCar[i];
    const per = rubberByCar[i] / lapsByCar[i];
    if (per < run.quietestCarLapRubber) run.quietestCarLapRubber = per;
  }
  run.fieldRubberPerCarLap = totalRubber / Math.max(1, totalLaps);
  fx.dispose();
  return run;
}

/** The longest unbroken run of spark-emitting frames, in seconds. */
function longestSparkRunS(samples: readonly Sample[]): number {
  let best = 0, cur = 0;
  for (const s of samples) {
    if (s.sparks > 0) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best * FRAME_DT;
}

function dutyCycle(samples: readonly Sample[], pick: (s: Sample) => boolean): number {
  let n = 0, hit = 0;
  for (const s of samples) { if (!pick(s)) continue; n++; if (s.sparks > 0) hit++; }
  return n === 0 ? 0 : hit / n;
}

// ===========================================================================
console.log('\n' + '='.repeat(100));
console.log('EFFECTS ON AND AROUND THE CAR — issues #11, #34, #19');
if (BREAK) console.log(`FX_BREAK=${BREAK} — a historical defect has been re-introduced on purpose.`);
console.log('='.repeat(100));

// ===========================================================================
// 1 & 2. SPARKS AND RUBBER, on eleven circuits
// ===========================================================================

console.log('\n1/2. SPARKS AND RUBBER — what fired, and what the car was doing at the time');
console.log(`     3 laps, 20 cars, drawn at 60fps. A spark more than ${f(SPARK_MEMORY_S, 1)}s after the plank`);
console.log('     last touched the road, or a rubber quad from a tyre that was neither locked');
console.log('     nor spinning, is a defect wherever in the field it happens.\n');
console.log('     ' + padr('circuit', 13) + pad('sparks/lap', 11) + pad('longest', 9) + pad('duty', 7)
  + pad('duty>200kph', 13) + pad('rubber/lap', 12) + pad('quietest', 10));

let anySparks = 0;
let circuitsWithSparks = 0;
let worstDutyFast = 0;
let worstRun = 0;
for (const id of CIRCUITS) {
  const r = race(id, 3, 9001);
  const perLap = r.focusSparks / r.laps;
  const runS = longestSparkRunS(r.focus);
  const duty = dutyCycle(r.focus, () => true);
  // 55 m/s is 198 km/h. The defect this replaces was `clamp01((v-45)/40)` on
  // top of a term that was permanently above the gate, so EVERY frame above
  // about 160 km/h emitted. If sparks are still a disguised speed effect, this
  // column reads close to 1.00.
  const dutyFast = dutyCycle(r.focus, (s) => s.speed > 55);
  anySparks += r.focusSparks;
  if (r.focusSparks > 0) circuitsWithSparks++;
  if (dutyFast > worstDutyFast) worstDutyFast = dutyFast;
  if (runS > worstRun) worstRun = runS;

  console.log('     ' + padr(id, 13) + pad(f(perLap, 1), 11) + pad(f(runS, 2) + 's', 9)
    + pad(f(duty, 3), 7) + pad(f(dutyFast, 3), 13)
    + pad(f(r.fieldRubberPerCarLap, 1), 12) + pad(f(r.quietestCarLapRubber, 1), 10));

  if (r.sparkOffTrigger) {
    fail(`${id}: sparks emitted ${f(r.sparkOffTrigger.gap, 2)}s after the plank last touched the road, at ${f(r.sparkOffTrigger.s * 3.6, 0)} km/h`);
  } else ok();

  if (r.rubberOffTrigger) {
    fail(`${id}: rubber laid by a tyre with lockup ${f(r.rubberOffTrigger.lockup, 3)} and wheelspin ${f(r.rubberOffTrigger.spin, 3)} — it was rolling`);
  } else ok();

  // A car cannot lay rubber down the whole lap. Set from BOTH measurements
  // rather than guessed: the fixed build runs 26.9-56.6 quads per car-lap over
  // the whole calendar, and restoring the pre-#11 rule — `clamp01((slip-2)/5)`,
  // an ordinary cornering slip angle — took MONZA, the circuit that marks
  // LEAST of the eleven, to 860.7. 200 is 3.5x the worst honest circuit and a
  // quarter of the re-break's easiest one. (The theoretical ceiling is far
  // higher again: at MIN_SEGMENT_M = 0.28m four tyres marking continuously is
  // `4 * length / 0.28`, about 60,000 quads a lap at Spa.)
  check(r.fieldRubberPerCarLap < 200,
    `${id}: ${f(r.fieldRubberPerCarLap, 0)} rubber quads per car-lap — the field is painting the circuit`);

  // AND the other direction: somebody in a field of twenty must get round
  // without marking at all, or the trigger is still firing on ordinary
  // cornering slip. This is the assertion that the broken build cannot pass and
  // that a "sparks were drawn" style probe would never have made.
  check(r.quietestCarLapRubber < 1,
    `${id}: the quietest car in the field still laid ${f(r.quietestCarLapRubber, 1)} quads a lap — nobody had a clean lap`);
}

// Sparks must EXIST. Asserting only that they do not fire is satisfied
// perfectly by an emitter that has been deleted, and this project has shipped
// exactly that mistake before.
check(anySparks > 0, 'no sparks were struck anywhere on the calendar — the emitter is dead, not fixed');
// A third of the calendar, so `FX_CIRCUITS` narrowing the run cannot fail this
// on arithmetic alone.
const SPARK_CIRCUIT_FLOOR = Math.max(1, Math.round(CIRCUITS.length / 3));
check(circuitsWithSparks >= SPARK_CIRCUIT_FLOOR,
  `sparks fired on only ${circuitsWithSparks} of ${CIRCUITS.length} circuits`);
check(worstRun < 4.0,
  `sparks ran continuously for ${f(worstRun, 2)}s — that is a shower that never stops`);
check(worstDutyFast < 0.5,
  `${f(worstDutyFast, 3)} of frames above 200 km/h emitted sparks — this is still a speed effect wearing a physics costume`);

// ---------------------------------------------------------------------------
// 2b. A STAGED LOCK-UP MUST LEAVE A MARK
// ---------------------------------------------------------------------------
console.log('\n2b. AND THE OTHER WAY — a car that genuinely locks a wheel must lay rubber.');
console.log('    Full brake at racing speed on the straight, through the real physics.\n');
{
  const def = getCircuit('monza');
  const engine = new RaceEngine(def, {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 5,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 7,
  });
  const fx = new EffectsDirector('high');
  fx.loadSession(engine);
  const cam = new THREE.Vector3();
  let quads = 0, peakLock = 0, acc = 0, braking = 0;
  for (let step = 0; step < 400_000 && !engine.over; step++) {
    engine.step();
    const car = engine.cars[0];
    // Once the car is up to speed, stand on the brake. `appliedControls` is
    // what the engine hands the physics, so this is a real pedal input and the
    // lock-up that follows is the tyre model's own answer to it.
    if (engine.started && engine.time > 40 && car.physics.speedMs > 55 && braking < 90) {
      car.appliedControls.brake = 1;
      car.appliedControls.throttle = 0;
      braking++;
    }
    if (++acc < 2) continue;
    acc = 0;
    updateRenderPoses(engine.cars, engine.track.length, 1);
    cam.set(car.renderX, 1, car.renderZ);
    fx.update(FRAME_DT, engine, cam);
    const t = fx.frame[0];
    if (t) { quads += t.rubber; peakLock = Math.max(peakLock, t.lockup); }
    if (braking >= 90 && car.physics.speedMs < 25) break;
  }
  console.log(`    peak lock-up ${f(peakLock, 3)},  ${quads} rubber quads laid`);
  check(peakLock > 0.05, `standing on the brake at 200 km/h produced a peak lock-up of ${f(peakLock, 3)} — the staging did not lock a wheel, so this section proves nothing`);
  check(quads > 0, 'a locked wheel laid no rubber at all — the trigger is now too tight');
  fx.dispose();
}

// ===========================================================================
// 3. THE PURPLE
// ===========================================================================
//
// *"there was this purple almost holo imaging"*, at speed. Two terms in the
// grade pass produced it between them and both are measured off the shader
// SOURCE rather than off a screenshot, for the same reason `probe:autotier` §6
// reads `Renderer.ts`: the artefact is a property of the arithmetic, it is a
// one-sided fringe on a periphery that is also being smeared, and photographing
// it reliably needs a high-contrast edge parked in a screen corner at 300 km/h.
//
console.log('\n3. THE PURPLE — the two terms that made it, read off the grade shader.\n');
{
  let src = readFileSync('src/render/PostFX.ts', 'utf8');
  if (BREAK === 'chroma') {
    src = src.replace('float amount = uSpeed * falloff * 0.012;',
      'float amount = uSpeed * falloff * 0.012;\n      float chroma = uSpeed * 0.0016;\n'
      + '      colour.r = texture2D(tDiffuse, vUv + dir * chroma).r;\n'
      + '      colour.b = texture2D(tDiffuse, vUv - dir * chroma).b;');
  }
  if (BREAK === 'blur') src = src.replace('float amount = uSpeed * falloff * 0.012;', 'float amount = uSpeed * falloff * 0.055;');

  // CHROMATIC ABERRATION. What makes it purple is that the RED and BLUE
  // channels are displaced in OPPOSITE directions along the radius, so a
  // high-contrast edge gets magenta on one side and green on the other and only
  // the magenta side survives against a grey road under a blue-grey sky. The
  // signature in any implementation of it is a texture fetch whose result is
  // taken as a SINGLE CHANNEL — you do not read one channel of a frame for any
  // other reason.
  const singleChannelFetches = [...src.matchAll(/texture2D\s*\(\s*tDiffuse[^)]*\)\s*\.\s*[rgb]\b/g)];
  console.log(`   single-channel fetches of the frame buffer: ${singleChannelFetches.length}`);
  check(singleChannelFetches.length === 0,
    `the grade shader takes ${singleChannelFetches.length} single-channel sample(s) of the frame — that is a chromatic split, and it is where the purple came from`);

  // THE GHOSTING. A radial blur only reads as blur when consecutive taps land
  // within a pixel or two of each other; further apart and eight taps are eight
  // copies of a car, which is the "holo imaging". The worst case is a screen
  // corner at full speed: dir has length sqrt(0.5^2 + 0.5^2), falloff and
  // uSpeed are both 1, and the smear is spread over TAPS samples.
  const m = /float amount = uSpeed \* falloff \* ([0-9.]+);/.exec(src);
  const tapsM = /const int TAPS = (\d+);/.exec(src);
  check(!!m && !!tapsM, 'could not find the radial blur coefficient in the grade shader');
  if (m && tapsM) {
    const k = Number(m[1]);
    const taps = Number(tapsM[1]);
    const FRAME_W = 1920;
    const maxDir = Math.hypot(0.5, 0.5);
    const spacingPx = (maxDir * k / taps) * FRAME_W;
    console.log(`   radial blur k=${k}, ${taps} taps  ->  worst-case tap spacing ${f(spacingPx, 2)} px on a ${FRAME_W}px frame`);
    // Three pixels. Above that the taps resolve as separate images rather than
    // merging into a smear — the artefact measured 9.3 px.
    check(spacingPx < 3.0,
      `radial blur taps are ${f(spacingPx, 2)} px apart — eight taps at that spacing are eight copies of a car, not a blur`);
  }
}

// ===========================================================================
// 4. THE THREE REAR LAMPS
// ===========================================================================
console.log('\n4. THE REAR LAMPS — the real `RearLight` rule, and where the lenses physically are.\n');
{
  const dry = { wetTyre: false, lowVisibility: false, harvestFrac: 0, running: true };

  // (a) A DRY NIGHT RACE SHOWS NOTHING. Reference 90.png is Bahrain under the
  //     lights on slicks and there is no lamp lit on either car in the frame.
  //     This is the assertion that a literal reading of #19 — "add a brake
  //     light" — would fail, and it should: F1 has no brake light.
  const dryBraking = rearLightState({ ...dry, harvestFrac: 0.9 });
  check(!dryBraking.on,
    'a car on slicks braking hard in the dry lit its rear lamps — F1 has no brake light');

  // (b) Sporting B1.5.5(a): lit "at all times when using intermediate or
  //     wet-weather tyres".
  const wet = rearLightState({ ...dry, wetTyre: true });
  check(wet.on, 'an intermediate or wet tyre did not light the rear lamps — Sporting B1.5.5(a)');
  check(!wet.flashing, 'the lamp flashed while the car was not recovering — it should be STEADY when merely on');

  // (c) Low visibility: reference 77.png, the red-flag frame in the wet.
  check(rearLightState({ ...dry, lowVisibility: true }).on,
    'the Race Director declared low visibility and the lamps stayed off');

  // (d) A recovered wreck is not running.
  check(!rearLightState({ ...dry, wetTyre: true, running: false }).on,
    'a car that has been recovered off the circuit is still showing a lamp');

  // (e) THE FLASH. Under recovery — which happens under braking — the lamp
  //     flashes. This is what issue #19 is actually looking at, and it is NOT
  //     cited to an article: see `RearLight.ts` for why not.
  const wetBraking = BREAK === 'flash'
    ? { on: true, flashing: false }
    : rearLightState({ ...dry, wetTyre: true, harvestFrac: HARVEST_FLASH_FRAC + 0.01 });
  check(wetBraking.flashing, 'the lamp did not flash while the MGU-K was recovering hard');

  // Count the edges over one second. A steady lamp has none; a 4Hz flash has
  // four. Sampling at 240Hz so a 4Hz square wave cannot be aliased into one.
  const edges = (st: { on: boolean; flashing: boolean }): number => {
    let n = 0, prev = rearLightLevel(st, 0);
    for (let i = 1; i <= 240; i++) {
      const v = rearLightLevel(st, i / 240);
      if (v > 0.5 && prev <= 0.5) n++;
      prev = v;
    }
    return n;
  };
  const flashEdges = edges(wetBraking);
  const steadyEdges = edges(wet);
  console.log(`   steady: ${steadyEdges} rising edges in 1s, level ${f(rearLightLevel(wet, 0.31), 2)} throughout`);
  console.log(`   flashing: ${flashEdges} rising edges in 1s at ${REAR_LIGHT_FLASH_HZ}Hz`);
  check(steadyEdges === 0,
    `a lamp that is merely ON pulsed ${steadyEdges} times a second — that is the pre-#19 behaviour, which flashed whenever it was lit and did nothing under braking`);
  check(flashEdges >= REAR_LIGHT_FLASH_HZ - 1 && flashEdges <= REAR_LIGHT_FLASH_HZ + 1,
    `a flashing lamp produced ${flashEdges} edges a second against a ${REAR_LIGHT_FLASH_HZ}Hz rate`);
  // Steady means steady: sample it across a second and it must not move at all.
  let steadyMin = 1, steadyMax = 0;
  for (let i = 0; i <= 240; i++) {
    const v = rearLightLevel(wet, i / 240);
    steadyMin = Math.min(steadyMin, v); steadyMax = Math.max(steadyMax, v);
  }
  check(steadyMax - steadyMin < 1e-9,
    `a steady lamp varied between ${f(steadyMin, 2)} and ${f(steadyMax, 2)}`);

  // --- (f) WHERE THE LENSES ACTUALLY ARE --------------------------------
  //
  // Issue #34 twice over: "plain red quads ... with no housing, no depth" and
  // "reads as floating". The second is measured by `probe:carrig`, which can
  // now see the lenses at all — they are in `carPartsForProbe` — so what is
  // left here is the REGULATION BAND, which the rig probe knows nothing about.
  console.log('\n   lens placement against Art. C14.3:');
  const parts = carPartsForProbe('high');
  for (const lamp of REAR_LAMPS) {
    const part = parts.find((p) => p.name === lamp.name);
    if (!part) { fail(`${lamp.name} is not in the car's parts list`); continue; }
    const box = new THREE.Box3().setFromBufferAttribute(
      part.geometry.getAttribute('position') as THREE.BufferAttribute);
    const centre = lamp.name.endsWith('C');
    // C14.3.2: the central lamp's CENTRE between Z=295 and Z=305 above the
    // reference plane. C14.3.3(d): the outer pair "in its entirety" between
    // Z=700 and Z=870.
    const lo = centre ? 0.330 : 0.735;
    const hi = centre ? 0.340 : 0.905;
    const measured = centre ? (box.min.y + box.max.y) / 2 : box.min.y;
    const measuredHi = centre ? measured : box.max.y;
    console.log(`     ${padr(lamp.name, 20)} y ${f(box.min.y, 3)}..${f(box.max.y, 3)}   x ${f(box.min.x, 3)}..${f(box.max.x, 3)}   band ${f(lo, 3)}..${f(hi, 3)}`);
    check(measured >= lo && measuredHi <= hi,
      `${lamp.name} at y ${f(box.min.y, 3)}..${f(box.max.y, 3)} is outside the C14.3 band ${f(lo, 3)}..${f(hi, 3)}`);
    // And it has DEPTH. A `PlaneGeometry` measures exactly zero here, which is
    // the whole of "plain red quads".
    const depth = box.max.z - box.min.z;
    check(depth > 0.005,
      `${lamp.name} is ${f(depth * 1000, 1)}mm deep — that is a flat quad, not a lens`);
    // And a falloff. A flat colour cannot look like a lamp at any brightness.
    const col = part.geometry.getAttribute('color');
    if (!col) { fail(`${lamp.name} has no per-vertex falloff — it will render as one flat colour`); continue; }
    let cmin = 1, cmax = 0;
    for (let i = 0; i < col.count; i++) { cmin = Math.min(cmin, col.getX(i)); cmax = Math.max(cmax, col.getX(i)); }
    check(cmax - cmin > 0.3,
      `${lamp.name}'s falloff spans only ${f(cmax - cmin, 2)} — it will still read as a flat rectangle`);
  }
}

// ===========================================================================
// 5. PER-TEAM ACTUATION — does it reach the GRID?
// ===========================================================================
//
// *"ferrari opens up differently than mercedes does which is different than red
// bull etc."* The four archetypes were built for that and `probe:activeaero`
// measures all four — by iterating `ACTUATION`. Iterating the archetypes
// answers "are there four solutions"; it does not answer "does any car on the
// grid run any of them", and the answer to the second was NO, eleven times out
// of eleven, because the lookup table was keyed on the fictional grid this
// project carried before the real roster landed.
//
console.log('\n5. PER-TEAM ACTUATION — do the four solutions reach the actual grid?\n');
{
  const ids = F1_2026.teams.map((t) => t.id);
  const counts = new Map<string, number>();
  for (const id of ids) {
    const a = BREAK === 'teams' ? 'central' : actuationForTeam(id);
    counts.set(a, (counts.get(a) ?? 0) + 1);
    const act = ACTUATION[a];
    console.log(`   ${padr(id, 16)} ${padr(a, 10)} pivot ${f(act.pivotChordFrac, 2)} chord   travel ${f(act.openRad, 2)} rad in ${f(act.travelS, 2)}s`);
  }
  const distinct = counts.size;
  const biggest = Math.max(...counts.values());
  console.log(`\n   ${ids.length} teams, ${distinct} distinct solutions, largest group ${biggest}`);
  check(distinct >= 3,
    `the whole grid runs ${distinct} distinct actuation(s) — "Ferrari opens differently to Mercedes" is not true on this build`);
  check(biggest <= Math.ceil(ids.length * 0.6),
    `${biggest} of ${ids.length} teams share one actuation`);
  for (const a of Object.keys(ACTUATION)) {
    check((counts.get(a) ?? 0) > 0, `no team on the grid runs the '${a}' actuation — the archetype is built and unreachable`);
  }
}

// ===========================================================================
console.log('\n' + '='.repeat(100));
if (failures.length) {
  console.log(`${checks} ok / ${failures.length} FAILED`);
  for (const m of failures) console.log('  ' + m);
  console.log('='.repeat(100));
  process.exit(1);
}
console.log(`${checks} ok / 0 failed — effects fire when they should and not when they should not`);
console.log('='.repeat(100));
