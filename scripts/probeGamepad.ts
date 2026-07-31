import {
  applySteerCurve, autoProfileFor, axisFromCapture, baselineOf, buttonFromCapture,
  buttonPressed, captureInput, classifyPad, normaliseGamepadSettings, normaliseProfile,
  pedalValue, signatureOf, steerResponse, steerTravel, steerValue,
  type AxisCal, type GamepadLike, type GamepadProfile,
} from '../src/input/GamepadProfile';

/**
 * Controller mapping, binding and calibration, verified without hardware.
 *
 * There is no controller plugged into a CI machine and there never will be, so
 * the mapping layer was written to talk to a structural `GamepadLike` rather
 * than to the browser's `Gamepad`. That one decision is what makes this file
 * possible: a plain object with an `axes` array and a `buttons` array is, as
 * far as every function under test is concerned, indistinguishable from a real
 * device — and unlike a real device it can be made to report anything.
 *
 * So the pads below are not stand-ins for hardware. They ARE the hardware, from
 * the code's point of view, and they are deliberately nastier than most real
 * devices: a wheel whose pedals rest at +1 and travel to −1, a wheel whose
 * centre is off to one side, a pad that reports its triggers as buttons, and a
 * device that idles every axis a long way from zero.
 *
 * The one thing this cannot check is that a browser hands us what we think it
 * does. `scripts/gamepadHarness.mjs` covers that end, driving the real Gamepad
 * API — mocked at the navigator level — through the real screen in a real
 * browser.
 */

let failures = 0;
let checks = 0;

function ok(name: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`);
    failures++;
  }
}

function near(name: string, got: number, want: number, tol = 1e-6): void {
  ok(name, Math.abs(got - want) <= tol, `got ${got.toFixed(4)}, want ${want.toFixed(4)}`);
}

// ===========================================================================
// Synthetic devices
// ===========================================================================

function pad(
  id: string,
  mapping: string,
  axes: number[],
  buttonCount: number,
  pressed: Record<number, number> = {},
): GamepadLike {
  return {
    index: 0,
    id,
    mapping,
    connected: true,
    axes,
    buttons: Array.from({ length: buttonCount }, (_, i) => {
      const v = pressed[i] ?? 0;
      return { pressed: v > 0.5, value: v };
    }),
  };
}

/** An Xbox-style pad: standard mapping, triggers as analogue buttons at rest 0. */
function xbox(axes: number[] = [0, 0, 0, 0], pressed: Record<number, number> = {}): GamepadLike {
  return pad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', 'standard', axes, 17, pressed);
}

/**
 * A Logitech-style wheel: no standard mapping, six axes, and pedals that rest
 * at +1 and travel to −1 — the exact case that makes a raw reading of 0 mean
 * "half throttle" instead of "off".
 */
function wheel(axes: number[] = [0, 1, 1, 1, 0, 0], pressed: Record<number, number> = {}): GamepadLike {
  return pad('Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)', '', axes, 25, pressed);
}

// ===========================================================================

console.log('\n=== Device classification ===');
ok('xbox pad classifies as standard', classifyPad(xbox()) === 'standard');
ok('G29 classifies as wheel', classifyPad(wheel()) === 'wheel');
ok('unnamed 6-axis non-standard device classifies as wheel',
  classifyPad(pad('Unknown HID 1234', '', [0, 0, 0, 0, 0, 0], 20)) === 'wheel');
ok('unnamed 2-axis device classifies as generic',
  classifyPad(pad('Unknown HID 1234', '', [0, 0], 4)) === 'generic');
ok('a wheel that claims the standard mapping is still a wheel',
  classifyPad(pad('Thrustmaster T300RS', 'standard', [0, 0, 0, 0], 16)) === 'wheel',
  '— the id is the only signal that is ever definite');

ok('signature separates the same device in different modes',
  signatureOf(wheel([0, 1, 1, 1, 0, 0])) !== signatureOf(wheel([0, 1, 1, 1])),
  '— a wheel that re-enumerates with fewer axes needs its own calibration');

// ===========================================================================

console.log('\n=== Standard pad: the mapping the game shipped with ===');
{
  const p = autoProfileFor(xbox());
  ok('steering is axis 0', p.axes.steer.kind === 'axis' && p.axes.steer.index === 0);
  ok('throttle is button 7', p.axes.throttle.kind === 'button' && p.axes.throttle.index === 7);
  ok('brake is button 6', p.axes.brake.kind === 'button' && p.axes.brake.index === 6);
  near('steer deadzone matches the old hard-coded 0.09', p.axes.steer.deadzone, 0.09);
  near('steering curve is linear by default', p.steer.curve, 1);
  near('rate limit is off by default', p.steer.rateLimit, 0);

  // The old code: applyDeadzone(axes[0], 0.09) — rescaled so the range still
  // reaches 1.0. Reproducing that exactly is the no-regression check.
  const oldWay = (v: number, dz = 0.09) => {
    const a = Math.abs(v);
    return a < dz ? 0 : Math.sign(v) * ((a - dz) / (1 - dz));
  };
  for (const v of [-1, -0.6, -0.09, -0.05, 0, 0.05, 0.09, 0.3, 0.7, 1]) {
    near(`steer(${v}) matches the pre-profile behaviour`,
      applySteerCurve(steerValue(xbox([v, 0, 0, 0]), p.axes.steer), p.steer), oldWay(v), 1e-9);
  }

  near('trigger fully pressed is full throttle',
    pedalValue(xbox([0, 0, 0, 0], { 7: 1 }), p.axes.throttle), 1, 1e-9);
  near('trigger released is no throttle',
    pedalValue(xbox([0, 0, 0, 0], { 7: 0 }), p.axes.throttle), 0, 1e-9);
  ok('half trigger is roughly half throttle',
    Math.abs(pedalValue(xbox([0, 0, 0, 0], { 7: 0.5 }), p.axes.throttle) - 0.5) < 0.03);

  ok('A is DRS', p.buttons.drs.index === 0);
  ok('Y cycles the camera', p.buttons.camera.index === 3);
  ok('B is reverse', p.buttons.reverse.index === 1);
}

// ===========================================================================

console.log('\n=== A wheel pedal that rests at +1 and travels to -1 ===');
{
  const p = autoProfileFor(wheel());
  ok('detected as a wheel', p.deviceClass === 'wheel');
  ok('the wheel profile is NOT marked calibrated', !p.axes.throttle.calibrated,
    '— the defaults are a guess and the screen has to say so');

  // Axis 1 is the throttle: 1 = released, -1 = floored.
  near('released pedal reads 0', pedalValue(wheel([0, 1, 1, 1, 0, 0]), p.axes.throttle), 0, 1e-9);
  near('floored pedal reads 1', pedalValue(wheel([0, -1, 1, 1, 0, 0]), p.axes.throttle), 1, 1e-9);

  // THE headline case. A raw 0 is exactly halfway through this pedal's travel.
  // Read it as a naive implementation would (clamp01 of the raw value) and it
  // is 0 — fully off. Read it through the calibration and it is half throttle.
  const half = pedalValue(wheel([0, 0, 1, 1, 0, 0]), p.axes.throttle);
  ok('a raw reading of 0 is HALF throttle on this device, not off',
    Math.abs(half - 0.5) < 0.04, `got ${half.toFixed(3)}`);
  ok('...whereas on the pad, a raw 0 on the same role is off',
    pedalValue(xbox([0, 0, 0, 0], { 7: 0 }), autoProfileFor(xbox()).axes.throttle) === 0,
    '— which is why one number cannot serve both and calibration is not optional');

  near('brake is on axis 2 and reads the same way',
    pedalValue(wheel([0, 1, -1, 1, 0, 0]), p.axes.brake), 1, 1e-9);
}

// ===========================================================================

console.log('\n=== Calibration resolves an arbitrary device ===');
{
  // A deliberately hostile pedal: rests at -0.8, travels to +0.35, and nothing
  // about it is guessable. This is the shape calibration has to be able to fix.
  const cal: AxisCal = {
    kind: 'axis', index: 3,
    rest: -0.8, max: 0.35, min: -0.8,
    invert: false, deadzone: 0, saturation: 0, calibrated: true,
  };
  const at = (v: number) => pedalValue(pad('x', '', [0, 0, 0, v], 4), cal);
  near('at rest reads 0', at(-0.8), 0);
  near('at full travel reads 1', at(0.35), 1);
  near('halfway reads 0.5', at(-0.225), 0.5, 1e-6);
  near('beyond the recorded stop clamps to 1', at(0.9), 1);
  near('past rest the other way clamps to 0', at(-1), 0);

  // An off-centre steering calibration: centre at +0.1, stops at -0.9 and +0.7.
  // The two halves must scale independently or the car pulls to one side.
  const steer: AxisCal = {
    kind: 'axis', index: 0,
    rest: 0.1, max: 0.7, min: -0.9,
    invert: false, deadzone: 0, saturation: 0, calibrated: true,
  };
  const st = (v: number) => steerValue(pad('x', '', [v], 4), steer);
  near('an off-centre wheel reads dead straight at its captured centre', st(0.1), 0);
  near('full right is +1', st(0.7), 1);
  near('full left is -1', st(-0.9), -1);
  ok('the short half is not squashed onto the long one',
    Math.abs(st(0.4) - 0.5) < 1e-6 && Math.abs(st(-0.4) - -0.5) < 1e-6,
    '— averaging the two would leave the car pulling to one side');

  const inverted: AxisCal = { ...steer, invert: true };
  near('invert flips the sense', steerValue(pad('x', '', [0.7], 4), inverted), -1);
}

// ===========================================================================

console.log('\n=== Deadzone and saturation ===');
{
  const cal: AxisCal = {
    kind: 'axis', index: 0, rest: 0, max: 1, min: -1,
    invert: false, deadzone: 0.2, saturation: 0.1, calibrated: true,
  };
  const st = (v: number) => steerValue(pad('x', '', [v], 4), cal);
  near('inside the deadzone is exactly zero', st(0.15), 0);
  near('at the deadzone edge is still zero', st(0.2), 0);
  near('at the saturation edge is full output', st(0.9), 1);
  near('past saturation is still full output', st(1), 1);
  ok('the usable range is rescaled, not clipped',
    Math.abs(st(0.55) - 0.5) < 1e-6,
    '— a 20% deadzone must not cost 20% of the steering forever');
  ok('the deadzone is symmetric', Math.abs(st(-0.55) + 0.5) < 1e-6);
}

// ===========================================================================

console.log('\n=== The steering curve ===');
{
  const linear = { curve: 1, sensitivity: 1, rateLimit: 0 };
  const soft = { curve: 2, sensitivity: 1, rateLimit: 0 };
  const sharp = { curve: 0.5, sensitivity: 1, rateLimit: 0 };
  near('linear passes through unchanged', applySteerCurve(0.5, linear), 0.5);
  near('a curve above 1 softens the centre', applySteerCurve(0.5, soft), 0.25);
  near('a curve below 1 sharpens it', applySteerCurve(0.5, sharp), Math.SQRT1_2, 1e-9);
  ok('full lock stays reachable at every curve',
    applySteerCurve(1, soft) === 1 && applySteerCurve(1, sharp) === 1);
  ok('the curve preserves sign', applySteerCurve(-0.5, soft) === -0.25);
  near('sensitivity multiplies after the curve',
    applySteerCurve(0.5, { curve: 1, sensitivity: 1.5, rateLimit: 0 }), 0.75);
  ok('sensitivity cannot push past full lock',
    applySteerCurve(0.9, { curve: 1, sensitivity: 2, rateLimit: 0 }) === 1);

  // The plot on the screen is drawn from steerResponse, and the car is steered
  // by steerValue + applySteerCurve. If those two ever disagree the plot is a
  // drawing of a lie.
  const cal: AxisCal = {
    kind: 'axis', index: 0, rest: 0, max: 1, min: -1,
    invert: false, deadzone: 0.12, saturation: 0.08, calibrated: true,
  };
  let worst = 0;
  for (let i = 0; i <= 40; i++) {
    const v = -1 + (2 * i) / 40;
    const plotted = steerResponse(steerTravel(pad('x', '', [v], 4), cal), cal, soft);
    const driven = applySteerCurve(steerValue(pad('x', '', [v], 4), cal), soft);
    worst = Math.max(worst, Math.abs(plotted - driven));
  }
  ok('the plotted curve equals what the car is actually given', worst < 1e-12,
    `max divergence ${worst.toExponential(1)}`);
}

// ===========================================================================

console.log('\n=== Press-to-bind ===');
{
  // Binding on a device whose axes idle a long way from zero. Measuring against
  // zero instead of against a baseline would capture axis 1 the instant the
  // player asked to bind anything.
  const idle = wheel([0, 1, 1, 1, -1, 0.71]);
  const base = baselineOf(idle);
  ok('nothing is captured while the device sits still',
    captureInput(idle, base, 'button') === null && captureInput(idle, base, 'axis') === null,
    '— despite four axes reading far from zero');

  const pressed = wheel([0, 1, 1, 1, -1, 0.71], { 12: 1 });
  const capButton = captureInput(pressed, base, 'button');
  ok('a button press is captured', capButton?.kind === 'button' && capButton.index === 12);

  const moved = wheel([0, -0.9, 1, 1, -1, 0.71]);
  const capAxis = captureInput(moved, base, 'axis');
  ok('an axis movement is captured', capAxis?.kind === 'axis' && capAxis.index === 1);
  ok('the captured axis records its resting value, not zero',
    capAxis !== null && Math.abs(capAxis.rest - 1) < 1e-9);
  ok('the captured axis records which way it moved', capAxis?.dir === -1);
}

console.log('\n=== A button bound where an axis was expected, and vice versa ===');
{
  const p: GamepadProfile = autoProfileFor(wheel());

  // The player asks to bind the throttle and pulls a trigger — a BUTTON.
  const base = baselineOf(wheel());
  const cap = captureInput(wheel([0, 1, 1, 1, 0, 0], { 7: 1 }), base, 'axis');
  ok('asking for an axis and getting a button is accepted', cap?.kind === 'button');
  if (cap) {
    p.axes.throttle = axisFromCapture(cap, p.axes.throttle, 'throttle');
    ok('the throttle is now read from a button', p.axes.throttle.kind === 'button');
    near('released reads 0', pedalValue(wheel([0, 1, 1, 1, 0, 0], { 7: 0 }), p.axes.throttle), 0);
    near('pressed reads 1', pedalValue(wheel([0, 1, 1, 1, 0, 0], { 7: 1 }), p.axes.throttle), 1);
  }

  // And the reverse: the player asks to bind DRS and moves an AXIS — a rotary
  // encoder or a hat on a wheel rim. Only axis 5 moves, so only axis 5 can be
  // what the player meant.
  const capAx = captureInput(wheel([0, 1, 1, 1, 0, 0.9]), baselineOf(wheel()), 'button');
  ok('asking for a button and getting an axis is accepted', capAx?.kind === 'axis');
  ok('the largest movement wins when several axes move at once',
    captureInput(wheel([0, 1, 1, 1, -1, 0.6]), baselineOf(wheel()), 'button')?.index === 4,
    '— a wheel twitches several channels on one press; the intended one moved furthest');
  if (capAx) {
    p.buttons.drs = buttonFromCapture(capAx);
    ok('DRS is now read from an axis', p.buttons.drs.kind === 'axis');
    ok('it is NOT held while the axis sits at its resting value',
      !buttonPressed(wheel([0, 1, 1, 1, 0, 0]), p.buttons.drs),
      '— an axis idling at 0.0 with rest 0.0 must not read as permanently pressed');
    ok('it IS held once the axis moves the way it was bound',
      buttonPressed(wheel([0, 1, 1, 1, 0, 0.9]), p.buttons.drs));
    ok('it is not held when the axis moves the other way',
      !buttonPressed(wheel([0, 1, 1, 1, 0, -0.9]), p.buttons.drs));
  }

  // A trigger bound to a plain button action still reads its analogue value.
  const p2 = autoProfileFor(xbox());
  ok('a half-pulled trigger does not count as a button press',
    !buttonPressed(xbox([0, 0, 0, 0], { 5: 0.3 }), p2.buttons.shiftUp));
  ok('a fully pulled one does',
    buttonPressed(xbox([0, 0, 0, 0], { 5: 1 }), p2.buttons.shiftUp));
}

// ===========================================================================

console.log('\n=== An unbound control produces nothing ===');
{
  const p = autoProfileFor(xbox());
  p.axes.throttle = { ...p.axes.throttle, kind: 'none', index: -1 };
  near('an unbound pedal reads 0 whatever the device does',
    pedalValue(xbox([1, 1, 1, 1], { 6: 1, 7: 1 }), p.axes.throttle), 0);
  ok('an unbound button is never held',
    !buttonPressed(xbox([0, 0, 0, 0], { 0: 1 }), { kind: 'none', index: -1, dir: 1, rest: 0 }));

  // A zero-width calibration cannot be allowed to produce Infinity or NaN.
  const degenerate: AxisCal = {
    kind: 'axis', index: 0, rest: 0.5, max: 0.5, min: 0.5,
    invert: false, deadzone: 0, saturation: 0, calibrated: true,
  };
  ok('a zero-width range reads 0 rather than NaN',
    pedalValue(pad('x', '', [0.9], 2), degenerate) === 0 &&
    steerValue(pad('x', '', [0.9], 2), degenerate) === 0);
}

// ===========================================================================

console.log('\n=== Persistence hygiene ===');
{
  const junk = normaliseProfile({
    deviceId: 'x',
    axes: { steer: { kind: 'axis', index: 0, deadzone: Number.NaN, rest: 'nonsense', max: null } },
    steer: { curve: Number.POSITIVE_INFINITY, sensitivity: -5 },
  });
  ok('a NaN deadzone is repaired', Number.isFinite(junk.axes.steer.deadzone));
  ok('a non-numeric rest is repaired', Number.isFinite(junk.axes.steer.rest));
  ok('an infinite curve is clamped', Number.isFinite(junk.steer.curve) && junk.steer.curve <= 3.5);
  ok('a negative sensitivity is clamped up', junk.steer.sensitivity >= 0.2);
  ok('every axis role exists after repair',
    ['steer', 'throttle', 'brake', 'clutch'].every((r) => junk.axes[r as never] !== undefined));
  ok('every button action exists after repair',
    ['shiftUp', 'shiftDown', 'drs', 'ers', 'pit', 'camera', 'pause', 'reverse']
      .every((a) => junk.buttons[a as never] !== undefined));

  const s = normaliseGamepadSettings({ profiles: { a: {} }, ffbStrength: 99, forceFeedback: false });
  ok('force feedback off survives the round trip', s.forceFeedback === false);
  ok('an out-of-range strength is clamped', s.ffbStrength === 1);
  ok('a garbage profile is replaced with a usable one', s.profiles.a !== undefined);

  ok('null settings produce working defaults', normaliseGamepadSettings(null).forceFeedback === true);
  ok('a round trip through JSON is lossless', (() => {
    const p = autoProfileFor(wheel());
    p.axes.steer.rest = 0.123;
    p.steer.curve = 1.7;
    const back = normaliseProfile(JSON.parse(JSON.stringify(p)));
    return back.axes.steer.rest === 0.123 && back.steer.curve === 1.7 &&
      back.axes.throttle.index === p.axes.throttle.index;
  })());
}

// ===========================================================================

console.log(`\n${checks} checks, ${failures} failure(s)`);
console.log(failures === 0 ? 'PASS' : 'FAIL');
process.exit(failures === 0 ? 0 : 1);
