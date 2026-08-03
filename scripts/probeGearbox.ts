/**
 * GEARBOX PROBE — can the player still change gear?
 *
 * Written for issue #45, in which one stray press of `4` on the careers page
 * left the car locked in fourth for the rest of the session: 205 km/h, 15,000
 * rpm, every shift light red, no upshift and no downshift available.
 *
 * WHY THE EXISTING PROBES MISSED IT, which is the part worth copying. Both
 * `probe:drivability` and `probe:handling` construct a `VehicleControls` literal
 * with `gearRequest: 0` and hand it straight to `VehiclePhysics.step`. Neither
 * of them has ever seen an `InputController`, so neither of them can express the
 * only thing the player actually did — press a key. A probe that builds its own
 * controls object is a probe that can only find bugs in the solver, and this bug
 * was not in the solver: the solver did exactly what the control it was given
 * said. Every case below therefore drives the REAL path,
 *
 *     synthetic KeyboardEvent -> InputController.onKeyDown
 *       -> InputController.update(dt, controls, ...)
 *         -> VehiclePhysics.step(dt, controls, env)
 *
 * with only §4 deliberately bypassing the input layer, because §4 is the case
 * that asserts the gearbox protects itself no matter WHO set the request.
 *
 * The DOM stub is the same idea as `probe:framerate`'s: a `window` with a
 * listener registry, so the controller's real handlers, real key set, real
 * text-field guard and real hold clocks all run.
 *
 * Run: npm run probe:gearbox
 */

// ===========================================================================
// DOM stub — enough for InputController.attach() and its event handlers
// ===========================================================================

type Listener = (e: unknown) => void;

const windowListeners = new Map<string, Listener[]>();

function addListener(type: string, fn: Listener): void {
  const list = windowListeners.get(type) ?? [];
  list.push(fn);
  windowListeners.set(type, list);
}

function installWindowStub(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.window) return;
  g.window = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: (type: string, fn: Listener) => addListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => {
      const list = windowListeners.get(type);
      if (list) windowListeners.set(type, list.filter((f) => f !== fn));
    },
  };
  g.navigator = { maxTouchPoints: 0, getGamepads: () => [] };
}

function stubElement(): HTMLElement {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  } as unknown as HTMLElement;
}

installWindowStub();

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PHYSICS_DT } from '../src/core/SimClock';
import { InputController } from '../src/input/InputController';
import {
  VehiclePhysics,
  type EnvironmentState,
  type VehicleControls,
} from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import { clamp } from '../src/core/MathUtils';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RAD = 180 / Math.PI;

const ENV: EnvironmentState = {
  trackTempC: 38, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
};

const TOP_GEAR = BASE_F1_SPEC.gearRatios.length;
/** The rpm fraction `updateGearbox` calls "on the limiter". */
const LIMITER_FRAC = 0.985;

// ===========================================================================
// Reporting
// ===========================================================================

let failures = 0;
let checks = 0;

function ok(label: string, pass: boolean, detail: string): void {
  checks++;
  if (!pass) failures++;
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`         ${detail}`);
}

function section(title: string): void {
  console.log('');
  console.log('-'.repeat(84));
  console.log(title);
  console.log('-'.repeat(84));
}

// ===========================================================================
// The rig — a transcription of main.ts's frame loop
// ===========================================================================

interface Rig {
  input: InputController;
  physics: VehiclePhysics;
  controls: VehicleControls;
  /** Simulated wall clock, milliseconds. Drives the controller's hold clocks. */
  nowMs: number;
}

function freshControls(): VehicleControls {
  return {
    throttle: 0, brake: 0, steer: 0, drsRequested: false, ersMode: 'balanced',
    gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
  };
}

/** A fresh car and a fresh controller. Controller state is persistent, so never reuse one. */
function rig(entryKph = 0): Rig {
  windowListeners.clear();
  const input = new InputController();
  input.attach(stubElement());
  const physics = new VehiclePhysics(BASE_F1_SPEC, 'medium');
  physics.frontTires.fit('medium', 95);
  physics.rearTires.fit('medium', 95);
  physics.placeAt(0, 0, 0, entryKph / 3.6);
  const r: Rig = { input, physics, controls: freshControls(), nowMs: 0 };
  input.timeSourceMs = () => r.nowMs;
  return r;
}

/**
 * Fires a keyboard event at the real handlers.
 *
 * `target` defaults to a plain div, i.e. NOT a text field — which is exactly the
 * situation the player was in: a career page with a button or the body focused,
 * where `isTextEntry` correctly returns false and the game consumes the key.
 */
function key(
  r: Rig, type: 'keydown' | 'keyup', k: string, target: unknown = { tagName: 'DIV' },
): void {
  const evt = { key: k, code: k, timeStamp: r.nowMs, target, preventDefault: () => {} };
  for (const fn of windowListeners.get(type) ?? []) fn(evt);
}

interface Trace {
  /** Highest gear the gearbox ever selected. */
  maxGear: number;
  endGear: number;
  topKph: number;
  endKph: number;
  /** Seconds spent at or above the limiter fraction with a taller gear available. */
  strandedS: number;
  /** Largest lateral distance from the line the car started on, metres. */
  maxLateralM: number;
  peakRearSlipDeg: number;
  peakYawRate: number;
  endRpm: number;
}

/**
 * Runs `durationS` of wall clock at `fps`, holding whatever keys are down.
 *
 * `beforeFrame` is called once per frame with the elapsed time, so a manoeuvre
 * is written on a wall-clock schedule rather than in frames.
 */
function drive(
  r: Rig,
  durationS: number,
  opts: {
    fps?: number;
    beforeFrame?: (tS: number) => void;
    /** Written into the controls AFTER the input layer, to bypass it. */
    forceRequest?: number;
    /**
     * Pins `physics.gear` before every solver step.
     *
     * Reproduces the state the player was actually in — locked in fourth, rpm
     * clamped on the limiter — WITHOUT depending on the bug still being present.
     * §9 has to compare against the broken car to say anything about issue #46,
     * and once #45 is fixed there is no longer any input that reaches that
     * state, so the state has to be constructed directly or the comparison
     * quietly turns into two identical runs.
     */
    holdGear?: number;
  } = {},
): Trace {
  const fps = opts.fps ?? 60;
  const frameDt = 1 / fps;
  const startX = r.physics.position.x;
  const t: Trace = {
    maxGear: r.physics.gear, endGear: r.physics.gear, topKph: 0, endKph: 0,
    strandedS: 0, maxLateralM: 0, peakRearSlipDeg: 0, peakYawRate: 0, endRpm: 0,
  };

  let carry = 0;
  const frames = Math.round(durationS * fps);
  for (let f = 0; f < frames; f++) {
    r.nowMs += frameDt * 1000;
    opts.beforeFrame?.(f * frameDt);
    r.input.update(
      frameDt, r.controls, r.physics.speedMs,
      r.physics.brakeLimitFraction, r.physics.tractionLimitFraction,
    );
    if (opts.forceRequest !== undefined) r.controls.gearRequest = opts.forceRequest;
    r.input.endFrame();

    // The clock hands the frame to the fixed-step solver, exactly as SimClock does.
    carry += frameDt;
    let steps = 0;
    while (carry >= PHYSICS_DT && steps < 8) { carry -= PHYSICS_DT; steps++; }
    for (let s = 0; s < steps; s++) {
      if (opts.holdGear !== undefined) r.physics.gear = opts.holdGear;
      r.physics.step(PHYSICS_DT, r.controls, ENV);
      const frac = r.physics.rpm / BASE_F1_SPEC.redlineRpm;
      if (frac >= LIMITER_FRAC && r.physics.gear < TOP_GEAR) t.strandedS += PHYSICS_DT;
      t.maxGear = Math.max(t.maxGear, r.physics.gear);
      t.topKph = Math.max(t.topKph, r.physics.speedKph);
      t.maxLateralM = Math.max(t.maxLateralM, Math.abs(r.physics.position.x - startX));
      t.peakRearSlipDeg = Math.max(t.peakRearSlipDeg, r.physics.rearTires.slipAngle * RAD);
      t.peakYawRate = Math.max(t.peakYawRate, Math.abs(r.physics.yawRate));
    }
  }
  t.endGear = r.physics.gear;
  t.endKph = r.physics.speedKph;
  t.endRpm = r.physics.rpm;
  return t;
}

// ===========================================================================
console.log('='.repeat(84));
console.log('GEARBOX PROBE — issue #45, the gear a key press locks you into');
console.log('='.repeat(84));

// ---------------------------------------------------------------------------
section('1. THE REPORTED BUG: one stray digit on a menu, then drive');
// ---------------------------------------------------------------------------
//
// The player pressed `4` while trying to type on the careers page and then went
// racing. Nothing else here is unusual: full throttle, straight line, thirty
// seconds. An F1 car reaches eighth in well under that.
//
// The speed bar is a REFERENCE RUN, not a chosen number. An untouched car is
// driven through the identical manoeuvre in the same process and the stray-digit
// run is required to match it. A fixed threshold would have been useless here:
// the rpm clamp at `VehiclePhysics.ts:1406` means a car held in fourth still
// makes torque at the limiter, so it crawls to 300.1 km/h over thirty seconds
// against the reference's 309.5 — a "top speed >= 300" bar passes the bug.
{
  const ref = rig(60);
  key(ref, 'keydown', 'w');
  const tRef = drive(ref, 30);

  const r = rig(60);
  // The stray press. Target is a DIV, not an input — the text-field guard is
  // working and is not what let this through.
  key(r, 'keydown', '4');
  key(r, 'keyup', '4');
  key(r, 'keydown', 'w');
  const t = drive(r, 30);

  console.log(`  reference (no key touched): gear ${tRef.endGear}, `
    + `top ${tRef.topKph.toFixed(1)} km/h, ${tRef.strandedS.toFixed(2)}s on the limiter`);
  console.log(`  after one press of 4    : gear ${t.endGear} of ${TOP_GEAR}, `
    + `top ${t.topKph.toFixed(1)} km/h, ${t.endRpm.toFixed(0)} rpm at the flag`);
  console.log(`  seconds held at >= ${(LIMITER_FRAC * 100).toFixed(1)}% of redline `
    + `with a taller gear available: ${t.strandedS.toFixed(2)}s of 30.00s `
    + `(reference ${tRef.strandedS.toFixed(2)}s)`);

  ok('a stray digit does not lock the gearbox — the car still reaches top gear',
    t.endGear === TOP_GEAR,
    `finished in gear ${t.endGear}, expected ${TOP_GEAR}`);
  ok('the car is no slower than one whose driver never touched a key',
    t.topKph >= tRef.topKph * 0.99,
    `${t.topKph.toFixed(1)} km/h against a reference ${tRef.topKph.toFixed(1)} km/h `
    + `(${((t.topKph / tRef.topKph - 1) * 100).toFixed(1)}%)`);
  ok('the car does not live on the limiter with gears left',
    t.strandedS <= 1.0,
    `${t.strandedS.toFixed(2)}s stranded on the limiter, allowed 1.00s`);
}

// ---------------------------------------------------------------------------
section('2. A PLAYER WHO NEVER TOUCHES A NUMBER KEY IS NEVER IN MANUAL');
// ---------------------------------------------------------------------------
//
// The reverse assertion the issue asks for. A fix that worked by making manual
// mode unreachable would pass §1 and be useless, so this pins the default.
{
  const r = rig(60);
  key(r, 'keydown', 'w');
  const t = drive(r, 30);

  console.log(`  mode ${r.input.gearMode}, gearRequest ${r.input.gearRequest}, `
    + `gear ${t.endGear}, top ${t.topKph.toFixed(1)} km/h`);

  ok('the default gearbox mode is automatic',
    r.input.gearMode === 'auto',
    `gearMode is '${r.input.gearMode}'`);
  ok('no manual request is ever published',
    r.input.gearRequest === 0 && r.controls.gearRequest === 0,
    `input.gearRequest ${r.input.gearRequest}, controls.gearRequest ${r.controls.gearRequest}`);
  ok('automatic reaches top gear',
    t.endGear === TOP_GEAR, `gear ${t.endGear}`);
}

// ---------------------------------------------------------------------------
section('3. THE WAY BACK IS A CONTROL, AND IT IS WRITTEN DOWN');
// ---------------------------------------------------------------------------
//
// `0` existed before this and did clear the latch. It is not the fix, because it
// appeared in no UI and in no help text: a control nobody can find is not a way
// back. The source checks are deliberate — an undiscoverable escape is exactly
// the gap that let a permanent, invisible mode change ship.
{
  const r = rig(60);
  key(r, 'keydown', '4');
  key(r, 'keyup', '4');
  drive(r, 2);
  const inManual = r.input.gearMode;

  key(r, 'keydown', 'g');
  key(r, 'keyup', 'g');
  drive(r, 1);
  const afterToggle = r.input.gearMode;

  console.log(`  after pressing 4: ${inManual};  after pressing G: ${afterToggle}`);

  ok('a digit selects manual mode explicitly',
    inManual === 'manual', `gearMode '${inManual}'`);
  ok('the toggle returns the car to automatic',
    afterToggle === 'auto' && r.controls.gearRequest === 0,
    `gearMode '${afterToggle}', controls.gearRequest ${r.controls.gearRequest}`);

  key(r, 'keydown', '6');
  key(r, 'keyup', '6');
  drive(r, 0.5);
  const manualAgain = r.input.gearMode;
  key(r, 'keydown', '0');
  key(r, 'keyup', '0');
  drive(r, 0.5);
  ok('0 still returns to automatic',
    manualAgain === 'manual' && r.input.gearMode === 'auto',
    `'${manualAgain}' then '${r.input.gearMode}'`);

  const hud = readFileSync(resolve(REPO, 'src/ui/Hud.ts'), 'utf8');
  const from = hud.indexOf('help-title');
  const help = from >= 0 ? hud.slice(from, hud.indexOf('Toggle this help') + 40) : '';
  ok('the controls overlay names the gearbox controls',
    /1&ndash;8|1&#8211;8|1 &ndash; 8/.test(help) && /class="k">G</.test(help),
    'the help grid must list both the number keys and the auto/manual toggle');
  ok('the HUD reports which mode the gearbox is in',
    /gearMode/.test(hud),
    'Hud must read InputController.gearMode so AUTO/MANUAL is on screen');
}

// ---------------------------------------------------------------------------
section('4. THE BACKSTOP IS INDEPENDENT OF WHO SET THE REQUEST');
// ---------------------------------------------------------------------------
//
// The input layer is bypassed here on purpose. `gearRequest` is a field on the
// shared `VehicleControls`, and `AIVehicleController`, `RaceEngine.copyControls`
// and every probe harness in `scripts/` write it; a fix that lives only in
// `InputController` leaves all of them able to strand the car. A car at the
// limiter with four gears in hand is wrong whatever put it there.
{
  const r = rig(60);
  key(r, 'keydown', 'w');
  const t = drive(r, 30, { forceRequest: 4 });

  console.log(`  request pinned at 4 every frame -> gear ${t.endGear}, `
    + `top ${t.topKph.toFixed(1)} km/h, ${t.strandedS.toFixed(2)}s on the limiter`);

  ok('a pinned request cannot hold the car on the limiter',
    t.strandedS <= 1.0,
    `${t.strandedS.toFixed(2)}s stranded, allowed 1.00s`);
  ok('the backstop shifts up rather than sitting there',
    t.maxGear === TOP_GEAR, `highest gear reached ${t.maxGear}`);
}

// ---------------------------------------------------------------------------
section('5. MANUAL MODE STILL MEANS MANUAL');
// ---------------------------------------------------------------------------
//
// The backstop must not quietly become an automatic gearbox. Below the limiter
// the gear the player asked for is the gear the car is in, and it stays there.
{
  const r = rig(120);
  key(r, 'keydown', '2');
  key(r, 'keyup', '2');
  drive(r, 0.5);
  const inSecond = r.physics.gear;

  key(r, 'keydown', '6');
  key(r, 'keyup', '6');
  drive(r, 0.5);
  const inSixth = r.physics.gear;

  // Sixth at 120 km/h is a long way below the limiter and a long way below where
  // an automatic would downshift, so nothing should move it. Coast and check.
  const held = drive(r, 2.0);

  console.log(`  requested 2 -> gear ${inSecond};  requested 6 -> gear ${inSixth}; `
    + `after 2s coasting -> gear ${held.endGear} at ${held.endKph.toFixed(0)} km/h, `
    + `${(held.endRpm / BASE_F1_SPEC.redlineRpm * 100).toFixed(1)}% of redline`);

  ok('a manual selection is honoured', inSecond === 2, `gear ${inSecond}`);
  ok('a second manual selection is honoured', inSixth === 6, `gear ${inSixth}`);
  ok('nothing overrides the driver below the limiter',
    held.endGear === 6, `gear ${held.endGear}, expected 6`);
}

// ---------------------------------------------------------------------------
section('6. A DOWNSHIFT THAT WOULD BURST THE ENGINE IS REFUSED');
// ---------------------------------------------------------------------------
//
// Selecting first at 300 km/h implies about 41,000 rpm against a 15,000 redline.
// A real gearbox blocks it, and blocking it is also what stops the backstop and
// the driver fighting each other once per frame.
{
  const r = rig(300);
  key(r, 'keydown', '1');
  key(r, 'keyup', '1');
  const t = drive(r, 0.5);
  const implied = (300 / 3.6) / BASE_F1_SPEC.tireRadiusM * BASE_F1_SPEC.gearRatios[0] * 9.5493;

  console.log(`  1st at 300 km/h would imply ${implied.toFixed(0)} rpm; `
    + `gearbox selected ${t.endGear}`);
  ok('the gearbox refuses an over-revving downshift',
    t.endGear > 1, `selected gear ${t.endGear}`);
  ok('and the driver is still in manual afterwards',
    r.input.gearMode === 'manual', `gearMode '${r.input.gearMode}'`);
}

// ---------------------------------------------------------------------------
section('7. A KEY PRESSED OUTSIDE A SESSION IS NOT A DRIVING INPUT');
// ---------------------------------------------------------------------------
//
// The route by which the player got here. `InputController.attach` is called
// once at startup and released only on teardown, so its window listener is live
// on the career screens, the menu and the settings page. The text-field guard is
// intact and was never the hole: the digit was pressed with a BUTTON focused, so
// `isTextEntry` correctly said no and the game took the key.
{
  const r = rig(60);
  r.input.enabled = false;
  key(r, 'keydown', '4');
  key(r, 'keyup', '4');
  key(r, 'keydown', 'e');
  key(r, 'keyup', 'e');

  console.log(`  with input disabled: gearMode ${r.input.gearMode}, `
    + `gearRequest ${r.input.gearRequest}, ers ${r.input.ersMode}`);

  ok('a digit pressed outside a session does not select a gear',
    r.input.gearMode === 'auto' && r.input.gearRequest === 0,
    `gearMode '${r.input.gearMode}', gearRequest ${r.input.gearRequest}`);
  ok('and neither does any other persistent game key',
    r.input.ersMode === 'balanced', `ersMode '${r.input.ersMode}'`);

  // Re-enabled it works again — the gate is a gate, not a removal.
  r.input.enabled = true;
  key(r, 'keydown', '4');
  key(r, 'keyup', '4');
  ok('re-enabling restores manual selection',
    r.input.gearMode === 'manual' && r.input.gearRequest === 4,
    `gearMode '${r.input.gearMode}', gearRequest ${r.input.gearRequest}`);

  // AND THAT THE SHELL ACTUALLY USES IT. Everything above proves the gate
  // works; none of it proves anything is holding it. `probe:banking` was green
  // for months against a road with the banking taken out of the mesh for
  // exactly this reason — see PROJECT.md §6, "two probes were passing a broken
  // feature". A gate nothing closes is not a gate.
  const shell = readFileSync(resolve(REPO, 'src/main.ts'), 'utf8');
  const wired = /input\.enabled\s*=/.test(shell);
  ok('the shell closes the gate when it leaves a session',
    wired && /this\.input\.enabled = inSession/.test(shell),
    'main.ts setScreen must set input.enabled from whether a session is running');
}

// ---------------------------------------------------------------------------
section('8. THE PADDLES: ONE GEAR AT A TIME, AND THE HUD SAYS SO');
// ---------------------------------------------------------------------------
//
// A paddle means manual from now on — there is no automatic in the real sport —
// which is only defensible if the HUD says which mode you are in and the toggle
// gets you out. Both are asserted in §3; this checks the paddle itself, through
// the same resolution `main.ts` performs.
//
// 150 km/h, coasting. The speed matters: fourth tops out at 178 km/h against a
// 15,000 rpm redline, so a paddle-down at 200 km/h is an over-rev and §6's guard
// correctly refuses it. Testing the paddle at a speed where the gear below is
// not legal tests the guard, not the paddle.
{
  const r = rig(150);
  drive(r, 1.0);
  const before = r.physics.gear;

  const paddle = (dir: 1 | -1): void => {
    const from = r.input.gearRequest > 0 ? r.input.gearRequest : Math.max(1, r.physics.gear);
    r.input.selectGear(clamp(from + dir, 1, TOP_GEAR));
  };

  paddle(-1);
  drive(r, 0.3);
  const down1 = r.physics.gear;
  paddle(1);
  drive(r, 0.3);
  const up1 = r.physics.gear;

  console.log(`  automatic had selected ${before}; paddle down -> ${down1}; paddle up -> ${up1}`);
  ok('a paddle shifts exactly one gear down',
    down1 === before - 1, `${before} -> ${down1}`);
  ok('and one gear back up', up1 === before, `${down1} -> ${up1}`);
  ok('a paddle puts the car in manual, visibly',
    r.input.gearMode === 'manual', `gearMode '${r.input.gearMode}'`);
}

// ---------------------------------------------------------------------------
section('9. IS THE SWERVING (#46) A SYMPTOM OF THE GEARBOX (#45)?');
// ---------------------------------------------------------------------------
//
// MEASUREMENT, NOT AN ASSERTION. The two were reported in one message, and a car
// held on the limiter in fourth has different torque delivery, different engine
// braking and a different traction budget to one in the right gear — so the
// swerve had to be measured in both states before either could be called a
// separate bug. Identical steering input, identical entry speed, deterministic
// solver; the only difference is whether the gear request is pinned to 4.
{
  const SLALOM_S = 6.0;
  /**
   * 100ms pulses each side at 2Hz — `probe:framerate`'s "honest swerve test".
   *
   * The pulse LENGTH is the whole point. A keyboard ramps steer at 3.4/s, so
   * holding a key for the full 250ms half-cycle reaches full lock, and full lock
   * at 220 km/h is past the front tyre's peak: two runs a millisecond apart end
   * up pointing in different directions, and the difference between them is a
   * property of the divergence rather than of anything being tested. 100ms buys
   * 0.34 of lock and stays inside the tyre, where a difference measured is a
   * difference caused.
   */
  const schedule = (r: Rig) => {
    let phase = -1;
    return (tS: number): void => {
      const t = tS - 0.4;
      if (t < 0) return;
      const i = Math.floor(t / 0.25);
      if (i !== phase) {
        phase = i;
        key(r, 'keydown', i % 2 === 0 ? 'd' : 'a');
      } else if (t - i * 0.25 >= 0.10) {
        key(r, 'keyup', 'd');
        key(r, 'keyup', 'a');
      }
    };
  };

  const auto = rig(220);
  key(auto, 'keydown', 'w');
  const tAuto = drive(auto, SLALOM_S, { beforeFrame: schedule(auto) });

  const stuck = rig(220);
  key(stuck, 'keydown', 'w');
  const tStuck = drive(stuck, SLALOM_S, { beforeFrame: schedule(stuck), holdGear: 4 });

  console.log('  same 2Hz slalom, 220 km/h entry, 6.0s:');
  console.log(`    automatic  : lateral ${tAuto.maxLateralM.toFixed(3)} m, `
    + `peak rear slip ${tAuto.peakRearSlipDeg.toFixed(2)} deg, `
    + `peak yaw ${tAuto.peakYawRate.toFixed(4)} rad/s, `
    + `gear ${tAuto.endGear}, ${tAuto.strandedS.toFixed(2)}s on the limiter`);
  console.log(`    pinned in 4: lateral ${tStuck.maxLateralM.toFixed(3)} m, `
    + `peak rear slip ${tStuck.peakRearSlipDeg.toFixed(2)} deg, `
    + `peak yaw ${tStuck.peakYawRate.toFixed(4)} rad/s, `
    + `gear ${tStuck.endGear}, ${tStuck.strandedS.toFixed(2)}s on the limiter`);
  const ratio = tAuto.maxLateralM > 1e-6 ? tStuck.maxLateralM / tAuto.maxLateralM : Infinity;
  console.log(`    lateral excursion ratio, pinned / automatic: ${ratio.toFixed(3)}x`);
  console.log('  Read this against issue #46: a ratio near 1.00 says the gearbox is not');
  console.log('  what the player was feeling and #46 is a separate bug; a ratio well above');
  console.log('  1 says some of the swerve was #45 arriving in the steering.');
}

// ===========================================================================
console.log('');
console.log('='.repeat(84));
console.log(`${checks - failures} of ${checks} checks passed`);
console.log('='.repeat(84));
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
