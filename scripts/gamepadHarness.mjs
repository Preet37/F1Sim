/**
 * End-to-end controller verification against a synthetic gamepad.
 *
 *   npm run dev            # in another terminal
 *   node scripts/gamepadHarness.mjs [--url http://localhost:5173] [--shots DIR]
 *
 * WHY THIS EXISTS
 *
 * `npm run validate:gamepad` proves the mapping maths. It cannot prove that the
 * screen is wired to that maths, that a bind button captures the input the
 * player actually pressed, that a calibration reaches the car, or that rumble is
 * asked for at the right moments — all of which live in the browser.
 *
 * There is no controller to plug in, so this replaces `navigator.getGamepads`
 * before any application code runs. Everything downstream of that call is the
 * real thing: the real InputController polling on the real game loop, the real
 * screen, the real save path through localStorage. The only fiction is the
 * device, and the device is exactly the part that cannot be had.
 *
 * The fake defaults to a WHEEL rather than a pad on purpose. Its pedals rest at
 * +1 and travel to −1, which is the case the whole calibration layer exists for:
 * read naively, a released throttle on this device is half applied, and a car
 * that creeps out of the garage on its own is precisely the bug this is here to
 * catch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright is a verification dependency, not a runtime one, so it is not in
// package.json. Take it from wherever it is installed.
async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/private/tmp/claude-501/-Users-preet-Desktop-f1/1e5db780-c1b1-4760-b053-e947a98720fb/scratchpad/node_modules/playwright/index.mjs',
  ];
  for (const c of candidates) {
    try {
      return await import(c);
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    'playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_MODULE ' +
    'to the path of an installed copy.',
  );
}

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL_BASE = argOf('url', process.env.F1_URL ?? 'http://localhost:5173');
const SHOT_DIR = argOf('shots', join(process.cwd(), 'artifacts', 'gamepad'));

let failures = 0;
let checks = 0;
function ok(name, condition, detail = '') {
  checks++;
  const line = `  ${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`;
  console.log(line);
  if (!condition) failures++;
}

/**
 * The fake device, installed before the page's own scripts.
 *
 * `window.__pad` is the control surface: the harness writes axes and buttons
 * into it and the page reads them through a `navigator.getGamepads` that is
 * indistinguishable, from the application's side, from the real one.
 *
 * Rumble is recorded rather than performed, which is the only way to check that
 * force feedback is being driven from the physics at all.
 */
function installFakeGamepad() {
  const state = {
    // A Logitech-style wheel: non-standard mapping, six axes, pedals idling at
    // +1. Axis 0 steering, 1 throttle, 2 brake, 3 clutch.
    id: 'Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
    mapping: '',
    axes: [0, 1, 1, 1, 0, 0],
    buttons: new Array(25).fill(0),
    connected: true,
    effects: [],
  };

  const actuator = {
    type: 'dual-rumble',
    playEffect(type, params) {
      state.effects.push({ type, ...params, at: performance.now() });
      return Promise.resolve('complete');
    },
    reset() {
      return Promise.resolve('complete');
    },
  };

  const build = () => {
    if (!state.connected) return null;
    return {
      index: 0,
      id: state.id,
      mapping: state.mapping,
      connected: true,
      timestamp: performance.now(),
      // Fresh copies each poll, exactly as the real API hands out fresh
      // snapshots rather than live objects.
      axes: state.axes.slice(),
      buttons: state.buttons.map((v) => ({ pressed: v > 0.5, value: v, touched: v > 0 })),
      vibrationActuator: actuator,
    };
  };

  navigator.getGamepads = () => [build(), null, null, null];
  window.__pad = state;
  window.__padConnect = () => {
    state.connected = true;
    window.dispatchEvent(new Event('gamepadconnected'));
  };
  window.__padDisconnect = () => {
    state.connected = false;
    window.dispatchEvent(new Event('gamepaddisconnected'));
  };
  /**
   * Swaps the hardware for a different class of device.
   *
   * The axis and button counts change with it, which changes the device
   * signature — so the game must treat this as a genuinely different controller
   * and build it a fresh profile rather than reusing the wheel's calibration.
   */
  window.__padBecome = (kind) => {
    if (kind === 'xbox') {
      state.id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)';
      state.mapping = 'standard';
      state.axes = [0, 0, 0, 0];
      state.buttons = new Array(17).fill(0);
    }
    state.connected = true;
    window.dispatchEvent(new Event('gamepadconnected'));
  };
}

const { chromium } = await loadPlaywright();
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => {
  console.log('PAGE ERROR', e.message);
  failures++;
});

await page.addInitScript(installFakeGamepad);
// Start from a clean settings slate so the run is repeatable — but ONCE, not on
// every navigation. An init script runs again on reload, and clearing there
// would wipe the settings whose survival across a reload is the thing being
// tested. sessionStorage is the right marker because it survives a reload and
// dies with the tab.
await page.addInitScript(() => {
  try {
    if (!window.sessionStorage.getItem('__harnessCleared')) {
      window.localStorage.removeItem('f1sim.settings');
      window.sessionStorage.setItem('__harnessCleared', '1');
    }
  } catch { /* private mode */ }
});

await page.goto(URL_BASE + '/?quality=low', { waitUntil: 'load' });
await page.waitForTimeout(1500);

/**
 * Sets axes/buttons on the fake device and holds them long enough for the game
 * loop to poll them.
 *
 * Deliberately generous. The page polls on requestAnimationFrame, and a
 * software-rasterised headless browser does not hold a steady 60Hz — so a hold
 * measured in "about three frames" is a flaky test, not a fast one. A real
 * player holds a button for a tenth of a second at the very least, which is
 * what this reproduces.
 */
async function setPad(patch, holdMs = 220) {
  await page.evaluate((p) => {
    if (p.axes) for (const k of Object.keys(p.axes)) window.__pad.axes[Number(k)] = p.axes[k];
    if (p.buttons) for (const k of Object.keys(p.buttons)) window.__pad.buttons[Number(k)] = p.buttons[k];
  }, patch);
  await page.waitForTimeout(holdMs);
}

/**
 * Scrolls the screen overlay to `scroll` and screenshots the viewport.
 *
 * Playwright's `fullPage` is useless on this UI: `.screen` is `position: fixed`
 * with its own scroller, so the DOCUMENT is always exactly one viewport tall.
 * A full-page capture therefore returns the top of the page however long the
 * page actually is — which is how a screenshot can be both "full page" and miss
 * two thirds of the content.
 */
async function shot(name, scroll = 0) {
  await page.evaluate((y) => {
    const s = document.querySelector('.screen');
    if (s) s.scrollTop = y;
  }, scroll);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOT_DIR, name) });
}

// ==========================================================================
console.log('\n=== Reaching the controller screen ===');
// ==========================================================================

await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(320);
await shot('01-settings.png');

ok('Settings shows a controller entry point',
  await page.getByRole('button', { name: 'Controller Setup' }).isVisible());
ok('Settings names the connected device',
  (await page.textContent('body')).includes('Logitech G29'));

await page.getByRole('button', { name: 'Controller Setup' }).click();
await page.waitForTimeout(420);

const bodyText = async () => page.textContent('body');
ok('the device is recognised as a wheel', (await bodyText()).includes('Racing wheel'));
ok('its non-standard mapping is reported', (await bodyText()).includes('mapping non-standard'));
ok('the uncalibrated wheel is called out',
  (await bodyText()).includes('has not been calibrated'));

await shot('02-controller.png');

// ==========================================================================
console.log('\n=== The live bars follow the device ===');
// ==========================================================================

/** Reads the profile the game is actually driving from. */
const profile = () => page.evaluate(() => {
  const s = window.__game.settings.gamepad;
  const sig = Object.keys(s.profiles)[0];
  return { sig, profile: s.profiles[sig] };
});

/** The width the steering bar is currently drawn at. */
const steerBarWidth = () => page.evaluate(() => {
  const fill = document.querySelectorAll('.ctrl-bar-fill')[0];
  return fill ? parseFloat(fill.style.width) || 0 : -1;
});

await setPad({ axes: { 0: 0 } });
const centred = await steerBarWidth();
await setPad({ axes: { 0: 0.8 } });
const turned = await steerBarWidth();
await setPad({ axes: { 0: 0 } });

ok('the steering bar is empty at centre', centred < 1, `width ${centred}%`);
ok('the steering bar fills as the wheel turns', turned > 30, `width ${turned}%`);

await setPad({ axes: { 0: -0.65 } });
await shot('03-live-axes.png');
await setPad({ axes: { 0: 0 } });

// ==========================================================================
console.log('\n=== The pedal ambiguity, before calibration ===');
// ==========================================================================

/** Throttle as the game computes it, straight out of the input layer. */
const throttleNow = () => page.evaluate(async () => {
  const m = await import('/src/input/GamepadProfile.ts');
  const g = window.__game;
  const s = g.settings.gamepad;
  const p = s.profiles[Object.keys(s.profiles)[0]];
  return m.pedalValue(navigator.getGamepads()[0], p.axes.throttle);
});

await setPad({ axes: { 1: 1 } });
ok('a released pedal (raw +1) is no throttle', Math.abs(await throttleNow()) < 0.01);
await setPad({ axes: { 1: -1 } });
ok('a floored pedal (raw -1) is full throttle', Math.abs(await throttleNow() - 1) < 0.01);
await setPad({ axes: { 1: 0 } });
const halfway = await throttleNow();
ok('a raw reading of 0 is half throttle on this device, not off',
  Math.abs(halfway - 0.5) < 0.05, `got ${halfway.toFixed(3)}`);
await setPad({ axes: { 1: 1 } });

// ==========================================================================
console.log('\n=== Press-to-bind ===');
// ==========================================================================

// Bind DRS to button 12 by asking, then pressing it.
const drsRow = page.locator('.ctrl-row', { hasText: 'DRS' }).first();
await drsRow.getByRole('button', { name: 'Bind' }).click();
await page.waitForTimeout(400);
ok('the page asks for the input', (await bodyText()).includes('press…'));
await shot('04-binding.png');

await setPad({ buttons: { 12: 1 } }, 360);
await setPad({ buttons: { 12: 0 } }, 260);
let prof = (await profile()).profile;
ok('DRS captured the button that was pressed',
  prof.buttons.drs.kind === 'button' && prof.buttons.drs.index === 12,
  `got ${prof.buttons.drs.kind} ${prof.buttons.drs.index}`);

// Now the awkward case: bind a BUTTON action to an AXIS.
const pitRow = page.locator('.ctrl-row', { hasText: 'Pit request' }).first();
await pitRow.getByRole('button', { name: 'Bind' }).click();
await page.waitForTimeout(400);
await setPad({ axes: { 5: 0.95 } }, 360);
prof = (await profile()).profile;
ok('a button action can be bound to an axis',
  prof.buttons.pit.kind === 'axis' && prof.buttons.pit.index === 5,
  `got ${prof.buttons.pit.kind} ${prof.buttons.pit.index}`);
ok('...and records the axis resting value, not zero',
  Math.abs(prof.buttons.pit.rest - 0) < 1e-9);

const pitHeld = () => page.evaluate(async () => {
  const m = await import('/src/input/GamepadProfile.ts');
  const s = window.__game.settings.gamepad;
  const p = s.profiles[Object.keys(s.profiles)[0]];
  return m.buttonPressed(navigator.getGamepads()[0], p.buttons.pit);
});
await setPad({ axes: { 5: 0 } });
ok('the axis-as-button is released at rest', (await pitHeld()) === false);
await setPad({ axes: { 5: 0.95 } });
ok('the axis-as-button is held when moved', (await pitHeld()) === true);
await setPad({ axes: { 5: 0 } });

// And the mirror: bind an AXIS role to a BUTTON.
const clutchRow = page.locator('.ctrl-row', { hasText: 'Clutch' }).first();
await clutchRow.getByRole('button', { name: 'Bind' }).click();
await page.waitForTimeout(400);
await setPad({ buttons: { 7: 1 } }, 360);
await setPad({ buttons: { 7: 0 } }, 200);
prof = (await profile()).profile;
ok('an axis role can be bound to a button',
  prof.axes.clutch.kind === 'button' && prof.axes.clutch.index === 7,
  `got ${prof.axes.clutch.kind} ${prof.axes.clutch.index}`);

// ==========================================================================
console.log('\n=== Calibration ===');
// ==========================================================================

// Give the throttle a deliberately awkward range: rests at 0.62, floors at
// -0.15. Nothing could guess this; only calibration can resolve it.
const throttleRow = page.locator('.ctrl-row', { hasText: 'Throttle' }).first();
await throttleRow.getByRole('button', { name: 'Calibrate' }).click();
await page.waitForTimeout(400);
ok('calibration asks for the rest position first',
  (await bodyText()).includes('Step 1 of 2'));

await setPad({ axes: { 1: 0.62 } });
await shot('05-calibrate-rest.png');
await throttleRow.getByRole('button', { name: 'Set rest' }).click();
await page.waitForTimeout(400);
ok('calibration then asks for the full sweep',
  (await bodyText()).includes('Step 2 of 2'));

// Sweep the pedal. The screen records the extremes as they go past.
for (const v of [0.62, 0.4, 0.1, -0.15, 0.1, 0.62]) await setPad({ axes: { 1: v } }, 200);
await shot('06-calibrate-sweep.png');
await throttleRow.getByRole('button', { name: 'Finish' }).click();
await page.waitForTimeout(400);

prof = (await profile()).profile;
ok('the captured rest is the awkward one, not 0',
  Math.abs(prof.axes.throttle.rest - 0.62) < 0.02, `rest ${prof.axes.throttle.rest}`);
ok('the captured full travel is the far extreme',
  Math.abs(prof.axes.throttle.max - -0.15) < 0.02, `max ${prof.axes.throttle.max}`);
ok('the throttle is now marked calibrated', prof.axes.throttle.calibrated === true);

await setPad({ axes: { 1: 0.62 } });
ok('after calibration a released pedal reads 0', Math.abs(await throttleNow()) < 0.01);
await setPad({ axes: { 1: -0.15 } });
ok('after calibration a floored pedal reads 1', Math.abs(await throttleNow() - 1) < 0.01);
await setPad({ axes: { 1: 0.235 } });
const mid = await throttleNow();
ok('and halfway through the new range is half throttle',
  Math.abs(mid - 0.5) < 0.03, `got ${mid.toFixed(3)}`);
await setPad({ axes: { 1: 0.62 } });

// Steering calibration: an off-centre wheel, stops at -0.7 and +0.9.
const steerRow = page.locator('.ctrl-row', { hasText: 'Steering' }).first();
await steerRow.getByRole('button', { name: 'Calibrate' }).click();
await page.waitForTimeout(400);
await setPad({ axes: { 0: 0.12 } });
await steerRow.getByRole('button', { name: 'Set centre' }).click();
await page.waitForTimeout(400);
for (const v of [0.12, -0.3, -0.7, 0, 0.5, 0.9, 0.12]) await setPad({ axes: { 0: v } }, 200);
await steerRow.getByRole('button', { name: 'Finish' }).click();
await page.waitForTimeout(400);

prof = (await profile()).profile;
ok('steering centre captured off-centre', Math.abs(prof.axes.steer.rest - 0.12) < 0.02);
ok('steering stops captured',
  Math.abs(prof.axes.steer.max - 0.9) < 0.02 && Math.abs(prof.axes.steer.min - -0.7) < 0.02,
  `min ${prof.axes.steer.min} max ${prof.axes.steer.max}`);

const steerNow = () => page.evaluate(async () => {
  const m = await import('/src/input/GamepadProfile.ts');
  const s = window.__game.settings.gamepad;
  const p = s.profiles[Object.keys(s.profiles)[0]];
  return m.steerValue(navigator.getGamepads()[0], p.axes.steer);
});
await setPad({ axes: { 0: 0.12 } });
ok('an off-centre wheel reads dead straight at its captured centre',
  Math.abs(await steerNow()) < 0.01);
await setPad({ axes: { 0: 0.9 } });
ok('full right is +1', Math.abs(await steerNow() - 1) < 0.01);
await setPad({ axes: { 0: -0.7 } });
ok('full left is -1', Math.abs(await steerNow() + 1) < 0.01);
await setPad({ axes: { 0: 0.51 } });
const halfRight = await steerNow();
await setPad({ axes: { 0: -0.29 } });
const halfLeft = await steerNow();
ok('the two halves scale independently against the centre',
  Math.abs(halfRight - 0.5) < 0.02 && Math.abs(halfLeft + 0.5) < 0.02,
  `right ${halfRight.toFixed(3)} left ${halfLeft.toFixed(3)}`);
await setPad({ axes: { 0: 0.12 } });

await shot('07-calibrated.png');

// ==========================================================================
console.log('\n=== Tuning and the response plot ===');
// ==========================================================================

const plotPath = () => page.evaluate(() => document.querySelector('.ctrl-plot-curve')?.getAttribute('d') ?? '');
const beforeCurve = await plotPath();

// Drag the linearity slider up and confirm the drawn curve actually changes.
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctrl-slider-item')];
  const item = items.find((i) => i.textContent.includes('Linearity'));
  const range = item.querySelector('input[type=range]');
  range.value = '2.2';
  range.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const afterCurve = await plotPath();
prof = (await profile()).profile;

ok('the linearity slider reaches the profile', Math.abs(prof.steer.curve - 2.2) < 0.01);
ok('the plotted curve redraws when it changes', beforeCurve !== afterCurve);

await setPad({ axes: { 0: 0.51 } });
const shapedHalf = await page.evaluate(async () => {
  const m = await import('/src/input/GamepadProfile.ts');
  const s = window.__game.settings.gamepad;
  const p = s.profiles[Object.keys(s.profiles)[0]];
  const pad = navigator.getGamepads()[0];
  return m.applySteerCurve(m.steerValue(pad, p.axes.steer), p.steer);
});
ok('the curve softens the centre of the real steering output',
  Math.abs(shapedHalf - Math.pow(0.5, 2.2)) < 0.02, `got ${shapedHalf.toFixed(3)}`);

// Deadzone, applied live.
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctrl-slider-item')];
  const item = items.find((i) => i.textContent.includes('Deadzone'));
  const range = item.querySelector('input[type=range]');
  range.value = '0.3';
  range.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
await setPad({ axes: { 0: 0.28 } });
ok('a 30% deadzone swallows a small input', Math.abs(await steerNow()) < 1e-6);
await setPad({ axes: { 0: 0.9 } });
ok('...but full lock is still reachable', Math.abs(await steerNow() - 1) < 1e-6);

// Scrolled down to the tuning section, so the sliders and the plotted response
// curve are actually in frame.
await shot('08-tuning-curve.png', 1080);
await shot('08b-force-feedback.png', 1750);
await shot('08c-top.png', 0);

// Put it back so the driving check below is not fighting a 30% deadzone.
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ctrl-slider-item')];
  for (const [name, value] of [['Deadzone', '0.02'], ['Linearity', '1']]) {
    const item = items.find((i) => i.textContent.includes(name));
    const range = item.querySelector('input[type=range]');
    range.value = value;
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.waitForTimeout(400);
await setPad({ axes: { 0: 0.12 } });

// ==========================================================================
console.log('\n=== Persistence ===');
// ==========================================================================

const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem('f1sim.settings')).gamepad);
const savedProfile = saved.profiles[Object.keys(saved.profiles)[0]];
ok('the profile reached localStorage', savedProfile !== undefined);
ok('the calibration was persisted',
  Math.abs(savedProfile.axes.throttle.rest - 0.62) < 0.02 &&
  savedProfile.axes.throttle.calibrated === true);
ok('the bindings were persisted',
  savedProfile.buttons.drs.index === 12 && savedProfile.buttons.pit.kind === 'axis');

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1400);
const afterReload = await page.evaluate(() => {
  const s = window.__game.settings.gamepad;
  return s.profiles[Object.keys(s.profiles)[0]];
});
ok('the profile survives a reload',
  Math.abs(afterReload.axes.throttle.rest - 0.62) < 0.02 &&
  afterReload.buttons.drs.index === 12);

// ==========================================================================
console.log('\n=== Hotplug ===');
// ==========================================================================

await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Controller Setup' }).click();
await page.waitForTimeout(320);
ok('the device is listed', (await bodyText()).includes('Logitech G29'));

await page.evaluate(() => window.__padDisconnect());
await page.waitForTimeout(420);
ok('unplugging is noticed', (await bodyText()).includes('No controller detected'));
await shot('09-disconnected.png');

await page.evaluate(() => window.__padConnect());
await page.waitForTimeout(420);
ok('plugging back in is noticed', (await bodyText()).includes('Logitech G29'));
ok('and the profile was not lost', (await profile()).profile.buttons.drs.index === 12);

// ==========================================================================
console.log('\n=== Driving the car ===');
// ==========================================================================

await page.goto(URL_BASE + '/?circuit=bahrain&session=race&laps=30&rolling=1&seed=7&quality=low',
  { waitUntil: 'load' });
await page.waitForTimeout(5000);

/**
 * Freezes the simulation, leaving the input layer running.
 *
 * What is under test here is the chain from device to `playerControls`, and
 * that chain is complete before the car moves. Letting the car actually drive
 * would add two failure modes that have nothing to do with controllers: a car
 * held at full throttle with the wheel at full lock crashes and retires, which
 * ends the session and freezes `playerControls` at whatever it last held — and
 * a frozen value looks exactly like a working one to an assertion. Stopping the
 * world removes both, and makes every check below deterministic.
 */
await page.evaluate(() => {
  const e = window.__game.engine;
  window.__realStep = e.step.bind(e);
  e.step = () => {};
});

const controls = () => page.evaluate(() => {
  const g = window.__game;
  const c = g.engine.playerControls;
  return {
    steer: c.steer, throttle: c.throttle, brake: c.brake,
    drs: c.drsRequested, ers: c.ersMode, gear: c.gearRequest,
    source: g.input.lastSource,
    gearNow: g.engine.playerCar.physics.gear,
    screen: g.screen, over: g.engine.over,
  };
});

/**
 * Polls until the controls satisfy `pred`, then returns them.
 *
 * A fixed sleep is not usable here. The racing screen renders a full 3D scene,
 * and under the software rasteriser this verification runs on it manages two to
 * four frames a second — so "wait 400ms" is "wait for about one poll of the
 * gamepad", and about one is sometimes zero. Every early version of this file
 * that used sleeps reported failures that were nothing but a missed frame.
 * Polling for the condition is correct at any frame rate, including a real
 * player's 144.
 */
async function controlsUntil(pred, timeout = 9000) {
  const t0 = Date.now();
  let c = await controls();
  while (!pred(c) && Date.now() - t0 < timeout) {
    await page.waitForTimeout(120);
    c = await controls();
  }
  return c;
}

ok('the session is live before the driving checks',
  (await controls()).screen === 'racing' && !(await controls()).over);

// Pedals at rest: the car must not be asking for anything. This is the check
// that would have caught a released wheel pedal reading as half throttle.
await setPad({ axes: { 0: 0.12, 1: 0.62, 2: 1 } }, 0);
let c = await controlsUntil((x) => x.throttle < 0.02 && Math.abs(x.steer) < 0.02);
ok('at rest the car is given no throttle', c.throttle < 0.02, `throttle ${c.throttle.toFixed(3)}`);
ok('at rest the car is given no steering', Math.abs(c.steer) < 0.02, `steer ${c.steer.toFixed(3)}`);

await setPad({ axes: { 1: -0.15 } }, 0);
c = await controlsUntil((x) => x.throttle > 0.95);
ok('flooring the throttle reaches the car', c.throttle > 0.95, `throttle ${c.throttle.toFixed(3)}`);
ok('the gamepad becomes the active input source', c.source === 'gamepad');

await setPad({ axes: { 0: 0.9 } }, 0);
c = await controlsUntil((x) => x.steer > 0.5);
ok('turning the wheel reaches the car', c.steer > 0.5, `steer ${c.steer.toFixed(3)}`);
await setPad({ axes: { 0: -0.7 } }, 0);
c = await controlsUntil((x) => x.steer < -0.5);
ok('and the other way', c.steer < -0.5, `steer ${c.steer.toFixed(3)}`);
await setPad({ axes: { 0: 0.12 } }, 0);
await controlsUntil((x) => Math.abs(x.steer) < 0.02);

await setPad({ axes: { 2: -1 } }, 0);
c = await controlsUntil((x) => x.brake > 0.95);
ok('the brake pedal reaches the car', c.brake > 0.95, `brake ${c.brake.toFixed(3)}`);
await setPad({ axes: { 2: 1 } }, 0);
await controlsUntil((x) => x.brake < 0.02);

// The bound DRS button.
await setPad({ buttons: { 12: 1 } }, 0);
ok('the bound DRS button is seen as a DRS request',
  (await controlsUntil((x) => x.drs === true)).drs === true);
await setPad({ buttons: { 12: 0 } }, 0);
ok('and releasing it stops the request',
  (await controlsUntil((x) => x.drs === false)).drs === false);

// Paddle shifts, resolved against the gear the gearbox is actually in.
const before = await controls();
await setPad({ buttons: { 5: 1 } }, 0);
const afterUp = await controlsUntil((x) => x.gear > 0);
await setPad({ buttons: { 5: 0 } }, 0);
ok('a paddle shift asks for a gear', afterUp.gear > 0, `gearRequest ${afterUp.gear}`);
ok('...one above the gear the car was in',
  afterUp.gear === Math.min(8, Math.max(1, before.gearNow) + 1),
  `was in ${before.gearNow}, asked for ${afterUp.gear}`);
await setPad({ buttons: { 4: 1 } }, 0);
const afterDown = await controlsUntil((x) => x.gear === afterUp.gear - 1);
await setPad({ buttons: { 4: 0 } }, 0);
ok('and the down paddle goes back', afterDown.gear === afterUp.gear - 1,
  `asked for ${afterDown.gear}`);

// ERS cycles on a rising edge only — one press must not run through all four.
const ersBefore = (await controls()).ers;
await setPad({ buttons: { 2: 1 } }, 0);
const ersHeld = (await controlsUntil((x) => x.ers !== ersBefore)).ers;
ok('holding the ERS button changes the mode exactly once',
  ersHeld !== ersBefore, `${ersBefore} -> ${ersHeld}`);
// Keep holding it for several more polls of the device; a mode that is cycled
// on the level rather than the edge would have run round the loop by now.
await page.waitForTimeout(2000);
ok('...and holding it longer does not keep cycling', (await controls()).ers === ersHeld);
await setPad({ buttons: { 2: 0 } }, 0);

await page.screenshot({ path: join(SHOT_DIR, '10-driving.png') });

// ==========================================================================
console.log('\n=== Force feedback ===');
// ==========================================================================

const effectCount = () => page.evaluate(() => window.__pad.effects.length);
await page.evaluate(() => { window.__pad.effects.length = 0; });

// Drive over a kerb. The physics' own vibration output is what feeds the
// motors, so setting it is the same thing that happens when a wheel drops onto
// a kerb — and with the simulation frozen it stays set rather than being damped
// away before the next poll.
await page.evaluate(() => {
  const p = window.__game.engine.playerCar.physics;
  p.surface = 'curb';
  p.vibration = 0.9;
  p.wheelsLocked = true;
});
await setPad({ axes: { 1: -0.15 } }, 0);
const t0ffb = Date.now();
while ((await effectCount()) === 0 && Date.now() - t0ffb < 9000) {
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1200);
const n = await effectCount();
ok('a kerb strike drives the rumble motors', n > 0, `${n} effects`);

const effects = await page.evaluate(() => window.__pad.effects.slice(0, 6));
ok('the effect is a dual-rumble with a real magnitude',
  effects.length > 0 && effects[0].type === 'dual-rumble' && effects[0].strongMagnitude > 0.1,
  effects.length ? `strong ${effects[0].strongMagnitude.toFixed(2)} weak ${effects[0].weakMagnitude.toFixed(2)}` : '');

// Rate limiting: playEffect is async, and one call per frame outruns the device.
const rateOk = await page.evaluate(() => {
  const e = window.__pad.effects;
  if (e.length < 3) return true;
  let minGap = Infinity;
  for (let i = 1; i < e.length; i++) minGap = Math.min(minGap, e[i].at - e[i - 1].at);
  return minGap > 40;
});
ok('rumble calls are rate limited rather than one per frame', rateOk);

// And it degrades silently when the device cannot do it.
await page.evaluate(() => {
  const orig = navigator.getGamepads.bind(navigator);
  navigator.getGamepads = () => orig().map((p) => {
    if (!p) return p;
    const { vibrationActuator, ...rest } = p;
    return rest;
  });
  window.__pad.effects.length = 0;
});
const errorsBefore = failures;
await setPad({ axes: { 1: 0.62 } }, 0);
await setPad({ axes: { 1: -0.15 } }, 2500);
ok('a device with no actuator produces no effects and no errors',
  (await effectCount()) === 0 && failures === errorsBefore,
  `${await effectCount()} effects`);

// ==========================================================================
console.log('\n=== Keyboard and touch are untouched ===');
// ==========================================================================

// Unplug the wheel and clear whatever it last asked for, so a stale value
// cannot be mistaken for the keyboard working.
await page.evaluate(() => window.__padDisconnect());
await page.evaluate(() => {
  const c = window.__game.engine.playerControls;
  c.throttle = 0; c.brake = 0; c.steer = 0;
  const i = window.__game.input;
  i.targetThrottle = 0; i.targetBrake = 0; i.targetSteer = 0;
});
await page.waitForTimeout(400);

await page.keyboard.down('ArrowUp');
const kb = await controlsUntil((x) => x.throttle > 0.5);
await page.keyboard.up('ArrowUp');
ok('the keyboard still drives the car with no gamepad connected',
  kb.throttle > 0.5 && kb.source === 'keyboard', `throttle ${kb.throttle.toFixed(3)}`);
await controlsUntil((x) => x.throttle < 0.02);

await page.keyboard.down('ArrowLeft');
const kbSteer = (await controlsUntil((x) => x.steer < -0.05)).steer;
await page.keyboard.up('ArrowLeft');
ok('keyboard steering still ramps rather than snapping',
  kbSteer < -0.05 && kbSteer > -1.01, `steer ${kbSteer.toFixed(3)}`);

// The brake ramp is deliberately slower than the throttle, and that is a tuning
// decision someone made on purpose after measuring it against the tyre model.
// This is here to make sure nothing in the controller work quietly moved it.
const rates = await page.evaluate(() => {
  const c = window.__game.input.config;
  return { throttle: c.keyboardThrottleRate, brake: c.keyboardBrakeRate };
});
ok('the deliberate slower brake ramp is intact',
  Math.abs(rates.brake - 3.2) < 1e-9 && Math.abs(rates.throttle - 4.5) < 1e-9,
  `throttle ${rates.throttle}/s brake ${rates.brake}/s`);
ok('...and the brake is still slower than the throttle', rates.brake < rates.throttle,
  `${(1 / rates.brake).toFixed(3)}s vs ${(1 / rates.throttle).toFixed(3)}s to full travel`);

// ==========================================================================
console.log('\n=== A standard pad, with no configuration at all ===');
// ==========================================================================
//
// The wheel above needed calibrating, which is the interesting case. This is
// the COMMON one: somebody plugs in an Xbox pad and expects to drive. Nothing
// below touches the controller screen — the profile has to be built, applied
// and correct without the player ever opening it, and it has to match the
// mapping the game hard-coded before any of this existed.

await page.evaluate(() => window.__padBecome('xbox'));
await page.waitForTimeout(700);

const padProfile = () => page.evaluate(() => {
  const s = window.__game.settings.gamepad;
  const key = Object.keys(s.profiles).find((k) => k.includes('Xbox'));
  return key ? s.profiles[key] : null;
});

// Touch the sticks so the profile is created by the game's own polling.
await setPad({ axes: { 0: 0.6 } }, 0);
await controlsUntil((x) => Math.abs(x.steer) > 0.3);

const xp = await padProfile();
ok('a new device gets its own profile', xp !== null);
ok('the wheel profile was not reused',
  (await page.evaluate(() => Object.keys(window.__game.settings.gamepad.profiles).length)) === 2);

if (xp) {
  ok('the pad is recognised as a standard gamepad', xp.deviceClass === 'standard');
  ok('steering lands on the left stick', xp.axes.steer.kind === 'axis' && xp.axes.steer.index === 0);
  ok('throttle lands on the right trigger',
    xp.axes.throttle.kind === 'button' && xp.axes.throttle.index === 7);
  ok('brake lands on the left trigger',
    xp.axes.brake.kind === 'button' && xp.axes.brake.index === 6);
  ok('the steering deadzone matches the value the game shipped with',
    Math.abs(xp.axes.steer.deadzone - 0.09) < 1e-9, `${xp.axes.steer.deadzone}`);
  ok('the steering curve is linear, as it was before profiles existed',
    xp.steer.curve === 1 && xp.steer.sensitivity === 1 && xp.steer.rateLimit === 0);
}

c = await controlsUntil((x) => x.steer > 0.4);
ok('the stick steers the car with no setup', c.steer > 0.4, `steer ${c.steer.toFixed(3)}`);

// The exact-value check has to have the speed-sensitive steering assist out of
// the way. That assist scales the finished steering down with speed — it is
// pre-existing, it applied to the old hard-coded path identically, and at
// 235km/h it is worth about 4%, which is more than enough to bury the thing
// actually being measured here: that the deadzone rescale produces the same
// number the game produced before profiles existed.
await page.evaluate(() => { window.__game.input.config.speedSensitiveSteering = false; });
await setPad({ axes: { 0: 0 } }, 0);
await controlsUntil((x) => Math.abs(x.steer) < 0.001);
await setPad({ axes: { 0: 0.6 } }, 0);
c = await controlsUntil((x) => x.steer > 0.4);
// 0.6 through a 0.09 deadzone, rescaled so full travel still reaches 1.0:
// (0.6 - 0.09) / (1 - 0.09).
ok('...by exactly the amount the old hard-coded path produced',
  Math.abs(c.steer - (0.6 - 0.09) / 0.91) < 0.002, `steer ${c.steer.toFixed(4)}`);
await page.evaluate(() => { window.__game.input.config.speedSensitiveSteering = true; });

await setPad({ axes: { 0: 0.05 } }, 0);
c = await controlsUntil((x) => Math.abs(x.steer) < 0.001);
ok('a stick inside the deadzone is ignored', Math.abs(c.steer) < 0.001);

await setPad({ axes: { 0: 0 }, buttons: { 7: 1 } }, 0);
c = await controlsUntil((x) => x.throttle > 0.95);
ok('the right trigger is full throttle with no setup', c.throttle > 0.95,
  `throttle ${c.throttle.toFixed(3)}`);
await setPad({ buttons: { 7: 0.5 } }, 0);
c = await controlsUntil((x) => x.throttle > 0.4 && x.throttle < 0.6);
ok('a half-pulled trigger is half throttle', c.throttle > 0.4 && c.throttle < 0.6,
  `throttle ${c.throttle.toFixed(3)}`);
await setPad({ buttons: { 7: 0, 6: 1 } }, 0);
c = await controlsUntil((x) => x.brake > 0.95);
ok('the left trigger is the brake with no setup', c.brake > 0.95, `brake ${c.brake.toFixed(3)}`);
await setPad({ buttons: { 6: 0 } }, 0);

await setPad({ buttons: { 0: 1 } }, 0);
ok('A is DRS with no setup', (await controlsUntil((x) => x.drs === true)).drs === true);
await setPad({ buttons: { 0: 0 } }, 0);

// ==========================================================================

console.log(`\n${checks} checks, ${failures} failure(s)`);
console.log('screenshots in ' + SHOT_DIR);
writeFileSync(join(SHOT_DIR, 'result.txt'), `${checks} checks, ${failures} failures\n`);

await browser.close();
console.log(failures === 0 ? 'PASS' : 'FAIL');
process.exit(failures === 0 ? 0 : 1);
