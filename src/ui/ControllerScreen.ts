import './controller.css';

import type { InputController } from '../input/InputController';
import {
  autoProfileFor, axisFromCapture, baselineOf, buttonFromCapture, buttonPressed,
  captureInput, describeAxis, describeButton, pedalTravel, pedalValue,
  signatureOf, steerResponse, steerTravel,
  AXIS_LABELS, AXIS_ROLES, BUTTON_ACTIONS, BUTTON_LABELS,
  type AxisRole, type ButtonAction, type GamepadLike,
  type GamepadProfile, type GamepadSettings, type PadBaseline,
} from '../input/GamepadProfile';

/**
 * The controller setup and calibration page.
 *
 * WHY THIS IS A LIVE SCREEN AND NOT A FORM
 *
 * Every other settings page in this game can be a list of choices, because the
 * player knows what they are choosing. Controller configuration is the one place
 * where that is not true: the player does not know what their device reports,
 * cannot know, and neither can the game. A wheel that idles its throttle at +1
 * and a pad that idles it at 0 are indistinguishable from a single sample, and
 * the difference between them is whether the car sits at half throttle in the
 * garage.
 *
 * So the design principle for this page is that NOTHING IS ASSERTED WITHOUT
 * BEING SHOWN. Every axis has a bar that moves while you touch the control, and
 * that bar draws two things: the raw travel and the value the car will actually
 * receive. Those two being different is what a deadzone IS, and being able to
 * see the gap between them is the difference between a calibration screen and a
 * screen of numbers you have to take on faith.
 *
 * The other consequence is that the page has to run at frame rate. `tick()` is
 * called from the game loop; the screen never polls on its own timer, because a
 * second timer would drift against the one the input layer samples on and the
 * bars would lag behind the hands moving the control.
 */

export interface ControllerScreenOptions {
  input: InputController;
  settings: GamepadSettings;
  /** Called after any change, so the caller can persist. */
  onChange: () => void;
}

export interface ControllerScreenHandle {
  /** Call once per animation frame while the screen is open. */
  tick(): void;
  /** Releases the input layer and the device-change hook. */
  dispose(): void;
}

/** A binding in progress. */
interface Pending {
  target: { kind: 'axis'; role: AxisRole } | { kind: 'button'; action: ButtonAction };
  baseline: PadBaseline;
  startedAt: number;
}

/** A calibration in progress. */
interface Calibration {
  role: AxisRole;
  phase: 'rest' | 'sweep';
  /** Running extremes seen during the sweep, in raw device units. */
  lo: number;
  hi: number;
  /** The rest value captured in phase one. */
  rest: number;
}

/** Binding gives up after this long so the page cannot get stuck. */
const BIND_TIMEOUT_MS = 8000;

export function buildControllerScreen(
  parent: HTMLElement,
  opts: ControllerScreenOptions,
): ControllerScreenHandle {
  const input = opts.input;
  const pads = input.gamepads;
  const settings = opts.settings;

  const root = document.createElement('div');
  parent.appendChild(root);

  /** Redraws that run every frame. */
  let ticks: (() => void)[] = [];
  /** Set when the page's structure — not just its values — has to be rebuilt. */
  let dirty = true;
  let pending: Pending | null = null;
  let calib: Calibration | null = null;

  const previousDevicesHook = pads.onDevicesChanged;
  pads.onDevicesChanged = () => { dirty = true; };

  const el = (tag: string, cls: string, p: HTMLElement, text = ''): HTMLElement => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text) d.textContent = text;
    p.appendChild(d);
    return d;
  };

  const button = (label: string, p: HTMLElement, onClick: () => void, cls = 'ctrl-btn'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    p.appendChild(b);
    return b;
  };

  const persist = () => opts.onChange();

  /** The profile being edited, created on demand for whatever is plugged in. */
  function currentProfile(): GamepadProfile | null {
    const pad = pads.activePad();
    if (!pad) return null;
    const sig = signatureOf(pad);
    let p = settings.profiles[sig];
    if (!p) {
      p = autoProfileFor(pad);
      settings.profiles[sig] = p;
      persist();
    }
    return p;
  }

  // =========================================================================
  // Binding and calibration state machines
  // =========================================================================

  function beginBind(target: Pending['target']): void {
    const pad = pads.activePad();
    if (!pad) return;
    calib = null;
    pending = { target, baseline: baselineOf(pad), startedAt: performance.now() };
    // The device must not drive the car — or this page's own buttons — while
    // the player is mashing it to bind something.
    input.gamepadSuspended = true;
    dirty = true;
  }

  function cancelBind(): void {
    pending = null;
    input.gamepadSuspended = calib !== null;
    dirty = true;
  }

  function resolveBind(pad: GamepadLike): void {
    if (!pending) return;
    if (performance.now() - pending.startedAt > BIND_TIMEOUT_MS) { cancelBind(); return; }

    const profile = currentProfile();
    if (!profile) return;

    const prefer = pending.target.kind === 'axis' ? 'axis' : 'button';
    const cap = captureInput(pad, pending.baseline, prefer);
    if (!cap) return;

    if (pending.target.kind === 'axis') {
      const role = pending.target.role;
      // An axis role can legitimately end up on a button — an Xbox trigger IS
      // the throttle — and `axisFromCapture` keeps the kind it actually got
      // rather than refusing the input the player just gave.
      profile.axes[role] = axisFromCapture(cap, profile.axes[role], role);
    } else {
      // And a button action can legitimately end up on an axis: wheel rims put
      // rotary encoders and hats on axes, and a paddle on a cheap wheel often
      // reports as one too.
      profile.buttons[pending.target.action] = buttonFromCapture(cap);
    }
    pending = null;
    input.gamepadSuspended = calib !== null;
    persist();
    dirty = true;
  }

  function beginCalibration(role: AxisRole): void {
    pending = null;
    calib = { role, phase: 'rest', lo: 0, hi: 0, rest: 0 };
    input.gamepadSuspended = true;
    dirty = true;
  }

  function endCalibration(): void {
    calib = null;
    input.gamepadSuspended = pending !== null;
    dirty = true;
  }

  /**
   * Turns the recorded sweep into a calibration.
   *
   * For steering, the two extremes are the two stops and the captured rest is
   * the centre — kept separate on purpose, because a wheel's centre is rarely
   * exactly halfway between its stops and forcing it to be would leave the car
   * pulling to one side with the wheel straight.
   *
   * For a pedal there is only one direction that means anything, so the "full"
   * end is whichever extreme ended up further from rest. That single line is
   * what makes a pedal resting at +1 and travelling to -1 work identically to
   * a trigger resting at 0 and travelling to +1, with no per-device special
   * cases anywhere else in the codebase.
   */
  function commitCalibration(profile: GamepadProfile, c: Calibration): void {
    const cal = profile.axes[c.role];
    cal.rest = c.rest;
    if (c.role === 'steer') {
      cal.max = Math.max(c.hi, c.rest);
      cal.min = Math.min(c.lo, c.rest);
    } else {
      const upTravel = Math.abs(c.hi - c.rest);
      const downTravel = Math.abs(c.rest - c.lo);
      cal.max = upTravel >= downTravel ? c.hi : c.lo;
      cal.min = c.rest;
    }
    // A sweep that never left the rest position has told us nothing; keeping it
    // would produce a zero-width range and an axis that reads 0 forever.
    const usable = Math.abs(cal.max - cal.rest) > 0.15;
    cal.calibrated = usable;
    if (!usable) {
      // Fall back to the full nominal range rather than leaving a zero-width
      // one behind. A player who pressed Finish without moving anything gets a
      // working axis and a screen that still says "not calibrated".
      cal.max = 1;
      cal.min = -1;
    }
    persist();
  }

  // =========================================================================
  // Small reusable pieces
  // =========================================================================

  /**
   * Writes a style property only when it actually changes.
   *
   * This is not a micro-optimisation, it is what makes the page usable. The
   * screen redraws at frame rate, and assigning to `style` unconditionally
   * marks the element dirty every single frame — which invalidates style and
   * paint for a page that is around 1900px tall and full of borders, rounded
   * corners and an SVG. Measured in a software rasteriser, writing every frame
   * dropped the whole application from 61fps to 2, and the controller page is
   * the ONE page whose entire purpose is showing you a control responding in
   * real time. Writing only on change puts it back to 61.
   */
  function setStyle(node: HTMLElement, prop: 'left' | 'width', value: string): void {
    if (node.style[prop] !== value) node.style[prop] = value;
  }

  function setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }

  /** Quantised so sub-pixel jitter on an analogue axis does not cause a write. */
  function pct(v: number): string {
    return v.toFixed(2) + '%';
  }

  /**
   * A live bar.
   *
   * `bipolar` bars grow from the centre, which is the only honest way to draw
   * a steering axis: a bar that grows from the left would show "hard left" and
   * "centred" as the same visual quantity of nothing.
   */
  function liveBar(p: HTMLElement, bipolar: boolean) {
    const bar = el('div', 'ctrl-bar', p);
    const fill = el('div', 'ctrl-bar-fill', bar);
    if (bipolar) el('div', 'ctrl-bar-centre', bar);
    const raw = el('div', 'ctrl-bar-raw', bar);
    return {
      set(value: number, rawValue: number) {
        if (bipolar) {
          const v = Math.max(-1, Math.min(1, value));
          const half = Math.abs(v) * 50;
          setStyle(fill, 'left', pct(v >= 0 ? 50 : 50 - half));
          setStyle(fill, 'width', pct(half));
          setStyle(raw, 'left', pct(50 + Math.max(-1, Math.min(1, rawValue)) * 50));
        } else {
          const v = Math.max(0, Math.min(1, value));
          setStyle(fill, 'left', '0%');
          setStyle(fill, 'width', pct(v * 100));
          setStyle(raw, 'left', pct(Math.max(0, Math.min(1, rawValue)) * 100));
        }
      },
    };
  }

  function slider(
    p: HTMLElement,
    name: string,
    note: string,
    min: number, max: number, step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
  ): void {
    const item = el('div', 'ctrl-slider-item', p);
    const head = el('div', 'ctrl-slider-head', item);
    el('div', 'ctrl-slider-name', head, name);
    const value = el('div', 'ctrl-slider-value', head, format(get()));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(get());
    range.setAttribute('aria-label', name);
    range.addEventListener('input', () => {
      set(Number(range.value));
      value.textContent = format(get());
      persist();
    });
    item.appendChild(range);
    el('div', 'ctrl-slider-note', item, note);
  }

  // =========================================================================
  // The page
  // =========================================================================

  function rebuild(): void {
    ticks = [];
    root.innerHTML = '';

    const devices = pads.list();
    const pad = pads.activePad();
    const profile = currentProfile();

    // --- Devices -----------------------------------------------------------
    el('div', 'section-title', root, 'Device');

    if (devices.length === 0) {
      const b = el('div', 'ctrl-banner warn', root);
      b.innerHTML =
        '<b>No controller detected.</b> Connect a gamepad or wheel, then <b>press a button on it</b> — ' +
        'browsers deliberately hide a gamepad from a page until it has been used, so a device that is ' +
        'plugged in but untouched genuinely does not exist yet as far as this page is concerned. ' +
        'Keyboard and touch controls are unaffected and keep working.';
      return;
    }

    const grid = el('div', 'card-grid', root);
    for (const d of devices) {
      const selected = pad !== null && d.index === pad.index;
      const card = el('div', 'card' + (selected ? ' selected' : ''), grid);
      el('div', 'card-name', card, d.id.length > 42 ? d.id.slice(0, 41) + '…' : d.id);
      el('div', 'card-meta', card,
        d.cls === 'wheel' ? 'Racing wheel' : d.cls === 'standard' ? 'Standard gamepad' : 'Generic device');
      el('div', 'card-stat', card,
        d.axes + ' axes · ' + d.buttons + ' buttons · mapping ' + (d.mapping || 'non-standard'));
      card.addEventListener('click', () => {
        pads.preferredSignature = d.signature;
        settings.activeSignature = d.signature;
        persist();
        dirty = true;
      });
    }

    if (!pad || !profile) return;

    // A wheel's starting profile is a guess, and saying so is the difference
    // between a player calibrating it and a player concluding the game is broken.
    const uncalibrated = AXIS_ROLES.filter(
      (r) => profile.axes[r].kind !== 'none' && !profile.axes[r].calibrated,
    );
    if (uncalibrated.length > 0) {
      const b = el('div', 'ctrl-banner' + (profile.deviceClass === 'wheel' ? ' warn' : ''), root);
      b.innerHTML = profile.deviceClass === 'wheel'
        ? '<b>This wheel has not been calibrated.</b> Wheels do not use a standard mapping, and a pedal ' +
          'that rests at −1 is indistinguishable from one resting at 0 until you show the game both ends ' +
          'of its travel. Until then a released pedal may read as half applied. ' +
          'Calibrate ' + uncalibrated.map((r) => AXIS_LABELS[r].toLowerCase()).join(', ') + ' below.'
        : 'Using the detected defaults for ' + uncalibrated.map((r) => AXIS_LABELS[r].toLowerCase()).join(', ') +
          '. They are usually right for a standard pad — calibrate anyway if anything reads wrong.';
    }

    // --- Axes --------------------------------------------------------------
    el('div', 'section-title', root, 'Axes');
    const axisList = el('div', 'ctrl-list', root);
    for (const role of AXIS_ROLES) buildAxisRow(axisList, profile, role);

    // --- Buttons -----------------------------------------------------------
    el('div', 'section-title', root, 'Buttons');
    const btnGrid = el('div', 'ctrl-buttons', root);
    for (const action of BUTTON_ACTIONS) buildButtonRow(btnGrid, profile, action);

    // --- Steering response -------------------------------------------------
    el('div', 'section-title', root, 'Steering response');
    const tune = el('div', 'ctrl-tune', root);
    const sliders = el('div', 'ctrl-sliders', tune);
    const steerCal = profile.axes.steer;

    slider(sliders, 'Deadzone',
      'Travel either side of centre that reads as straight. Raise it if the car wanders with your hands off; ' +
      'every unit of it is steering you no longer have.',
      0, 0.35, 0.01,
      () => steerCal.deadzone, (v) => { steerCal.deadzone = v; },
      (v) => (v * 100).toFixed(0) + '%');

    slider(sliders, 'Saturation',
      'How much travel is trimmed off the far end. Full lock arrives before the stop, which suits a 900° wheel ' +
      'you do not want to have to turn all the way.',
      0, 0.35, 0.01,
      () => steerCal.saturation, (v) => { steerCal.saturation = v; },
      (v) => (v * 100).toFixed(0) + '%');

    slider(sliders, 'Linearity',
      'Below 1 is sharper than the device; 1 is exactly what the device reports; above 1 spends more travel ' +
      'on small corrections without putting full lock out of reach. A thumbstick usually wants 1.3–1.8, a wheel wants 1.',
      0.4, 3, 0.05,
      () => profile.steer.curve, (v) => { profile.steer.curve = v; },
      (v) => v.toFixed(2));

    slider(sliders, 'Sensitivity',
      'A flat multiplier after the curve. Above 1 reaches full lock before the control does.',
      0.4, 2, 0.05,
      () => profile.steer.sensitivity, (v) => { profile.steer.sensitivity = v; },
      (v) => '×' + v.toFixed(2));

    slider(sliders, 'Rate limit',
      'Ceiling on how fast the steering may change, lock-to-lock per second. 0 is off. A stick can go lock to ' +
      'lock in one frame and no steering rack can, so a low value here is what stops a flick of the thumb spinning the car.',
      0, 12, 0.5,
      () => profile.steer.rateLimit, (v) => { profile.steer.rateLimit = v; },
      (v) => (v === 0 ? 'off' : v.toFixed(1) + '/s'));

    buildPlot(tune, profile);

    // --- Force feedback ----------------------------------------------------
    el('div', 'section-title', root, 'Force feedback');
    const ffb = el('div', 'ctrl-list', root);
    const ffbRow = el('div', 'ctrl-row', ffb);
    const ffbHead = el('div', 'ctrl-row-head', ffbRow);
    el('div', 'ctrl-name', ffbHead, 'Rumble');
    const supported = pads.hasRumble;
    el('div', 'ctrl-binding' + (supported ? '' : ' none'), ffbHead,
      supported ? 'available' : 'not supported');
    el('div', 'ctrl-spacer', ffbHead);
    const toggle = button(settings.forceFeedback ? 'ON' : 'OFF', ffbHead, () => {
      settings.forceFeedback = !settings.forceFeedback;
      if (!settings.forceFeedback) pads.stopRumble();
      persist();
      dirty = true;
    }, 'ctrl-btn' + (settings.forceFeedback ? ' on' : ''));
    toggle.disabled = !supported;
    const test = button('Test', ffbHead, () => pads.rumble(0.85, 0.5, 350), 'ctrl-btn');
    test.disabled = !supported;

    el('div', 'ctrl-banner', ffbRow, supported
      ? 'Driven from the physics, not from canned effects: the heavy motor follows the tyre model’s own ' +
        'vibration output, so it fires on kerbs, grass and gravel, and the light motor picks up a locked ' +
        'front under braking and wheelspin on corner exit.'
      : 'This device reports no vibration actuator, so there is nothing to drive. Everything else on this ' +
        'page works normally — force feedback is the one feature that degrades to silence.');

    const strengthWrap = el('div', 'ctrl-sliders', ffbRow);
    strengthWrap.style.marginTop = '10px';
    slider(strengthWrap, 'Strength', 'Scales everything the motors are asked for.',
      0, 1, 0.05,
      () => settings.ffbStrength, (v) => { settings.ffbStrength = v; },
      (v) => (v * 100).toFixed(0) + '%');

    // --- Reset -------------------------------------------------------------
    const row = el('div', 'btn-row', root);
    button('Reset this device', row, () => {
      const p = pads.activePad();
      if (!p) return;
      settings.profiles[signatureOf(p)] = autoProfileFor(p);
      persist();
      dirty = true;
    }, 'btn secondary');
  }

  // --- One analogue axis ---------------------------------------------------

  function buildAxisRow(parentEl: HTMLElement, profile: GamepadProfile, role: AxisRole): void {
    const cal = profile.axes[role];
    const binding = pending && pending.target.kind === 'axis' && pending.target.role === role;
    const calibrating = calib?.role === role;
    const bipolar = role === 'steer';

    const row = el('div', 'ctrl-row' + (binding || calibrating ? ' active' : ''), parentEl);
    const head = el('div', 'ctrl-row-head', row);
    el('div', 'ctrl-name', head, AXIS_LABELS[role]);

    el('div', 'ctrl-binding' + (binding ? ' waiting' : cal.kind === 'none' ? ' none' : ''), head,
      binding ? 'press or move…' : describeAxis(cal));

    el('div', 'ctrl-spacer', head);

    if (binding) {
      button('Cancel', head, cancelBind);
    } else if (!calibrating) {
      button('Bind', head, () => beginBind({ kind: 'axis', role }));
      const calBtn = button('Calibrate', head, () => beginCalibration(role));
      calBtn.disabled = cal.kind === 'none';
      const inv = button(cal.invert ? 'Inverted' : 'Invert', head, () => {
        cal.invert = !cal.invert;
        persist();
        dirty = true;
      }, 'ctrl-btn' + (cal.invert ? ' on' : ''));
      inv.disabled = cal.kind === 'none';
      if (cal.kind !== 'none') {
        button('Clear', head, () => {
          profile.axes[role] = { ...cal, kind: 'none', index: -1, calibrated: false };
          persist();
          dirty = true;
        });
      }
    }

    const bar = liveBar(row, bipolar);
    const readout = el('div', 'ctrl-readout', row);
    const rawText = el('span', '', readout, 'raw —');
    const outText = el('span', 'val', readout, 'output —');
    const rangeText = el('span', '', readout,
      cal.kind === 'none' ? '' : 'rest ' + cal.rest.toFixed(2) + ' · full ' + cal.max.toFixed(2));

    if (calibrating) buildCalibration(row, profile, role);

    ticks.push(() => {
      const p = pads.activePad();
      if (!p || cal.kind === 'none') {
        bar.set(0, 0);
        setText(rawText, 'raw —');
        setText(outText, 'output —');
        return;
      }
      const raw = cal.kind === 'axis' ? (p.axes[cal.index] ?? 0) : (p.buttons[cal.index]?.value ?? 0);
      const travel = bipolar ? steerTravel(p, cal) : pedalTravel(p, cal);
      const shown = bipolar ? steerResponse(travel, cal, profile.steer) : pedalValue(p, cal);
      bar.set(shown, travel);
      setText(rawText, 'raw ' + raw.toFixed(3));
      setText(outText, 'output ' + (bipolar && shown >= 0 ? '+' : '') + shown.toFixed(3));
      if (calib?.role === role && calib.phase === 'sweep') {
        setText(rangeText, 'seen ' + calib.lo.toFixed(2) + ' … ' + calib.hi.toFixed(2));
      }
    });
  }

  /** The two-step calibration wizard, rendered inside an axis row. */
  function buildCalibration(row: HTMLElement, profile: GamepadProfile, role: AxisRole): void {
    const c = calib;
    if (!c) return;
    const box = el('div', 'ctrl-calib', row);
    const step = el('div', 'ctrl-calib-step', box);
    const controls = el('div', 'ctrl-calib-row', box);

    if (c.phase === 'rest') {
      step.innerHTML = role === 'steer'
        ? '<b>Step 1 of 2.</b> Let the wheel or stick return to centre and take your hands off it, then press Set centre. ' +
          'This is the reading the game will treat as straight ahead.'
        : '<b>Step 1 of 2.</b> Take your foot off the pedal completely, then press Set rest. ' +
          'This is the reading the game will treat as fully released — it is not assumed to be zero, ' +
          'because on most wheels it is not.';
      const nums = el('div', 'ctrl-calib-nums', controls, '');
      button('Set ' + (role === 'steer' ? 'centre' : 'rest'), controls, () => {
        const p = pads.activePad();
        if (!p) return;
        const cal = profile.axes[role];
        const raw = cal.kind === 'axis' ? (p.axes[cal.index] ?? 0) : (p.buttons[cal.index]?.value ?? 0);
        c.rest = raw;
        c.lo = raw;
        c.hi = raw;
        c.phase = 'sweep';
        dirty = true;
      });
      button('Cancel', controls, endCalibration);
      ticks.push(() => {
        const p = pads.activePad();
        const cal = profile.axes[role];
        if (!p || cal.kind === 'none') return;
        const raw = cal.kind === 'axis' ? (p.axes[cal.index] ?? 0) : (p.buttons[cal.index]?.value ?? 0);
        setText(nums, 'reading ' + raw.toFixed(3));
      });
      return;
    }

    step.innerHTML = role === 'steer'
      ? '<b>Step 2 of 2.</b> Turn the wheel all the way to <b>full left</b>, then all the way to <b>full right</b>. ' +
        'The extremes are being recorded as you go — watch the numbers move — then press Finish. ' +
        'The two halves are scaled separately against the centre you just set, so a wheel whose centre is not ' +
        'exactly halfway between its stops still tracks straight.'
      : '<b>Step 2 of 2.</b> Press the pedal all the way to the floor and release it. ' +
        'Whichever direction it travelled becomes "fully applied", so a pedal that reads +1 released and −1 ' +
        'pressed works exactly like one that reads 0 released and +1 pressed.';

    const nums = el('div', 'ctrl-calib-nums', controls, '');
    button('Finish', controls, () => {
      commitCalibration(profile, c);
      endCalibration();
    });
    button('Cancel', controls, endCalibration);

    ticks.push(() => {
      const p = pads.activePad();
      const cal = profile.axes[role];
      if (!p || cal.kind === 'none') return;
      const raw = cal.kind === 'axis' ? (p.axes[cal.index] ?? 0) : (p.buttons[cal.index]?.value ?? 0);
      c.lo = Math.min(c.lo, raw);
      c.hi = Math.max(c.hi, raw);
      setText(nums,
        'reading ' + raw.toFixed(3) + '  ·  seen ' + c.lo.toFixed(3) + ' … ' + c.hi.toFixed(3) +
        '  ·  travel ' + (c.hi - c.lo).toFixed(3));
    });
  }

  // --- One button action ---------------------------------------------------

  function buildButtonRow(parentEl: HTMLElement, profile: GamepadProfile, action: ButtonAction): void {
    const ref = profile.buttons[action];
    const binding = pending && pending.target.kind === 'button' && pending.target.action === action;

    const row = el('div', 'ctrl-row' + (binding ? ' active' : ''), parentEl);
    const head = el('div', 'ctrl-row-head', row);
    const dot = el('div', 'ctrl-dot', head);
    el('div', 'ctrl-name', head, BUTTON_LABELS[action]);
    el('div', 'ctrl-binding' + (binding ? ' waiting' : ref.kind === 'none' ? ' none' : ''), head,
      binding ? 'press…' : describeButton(ref));
    el('div', 'ctrl-spacer', head);
    if (binding) {
      button('Cancel', head, cancelBind);
    } else {
      button('Bind', head, () => beginBind({ kind: 'button', action }));
      if (ref.kind !== 'none') {
        button('Clear', head, () => {
          profile.buttons[action] = { kind: 'none', index: -1, dir: 1, rest: 0 };
          persist();
          dirty = true;
        });
      }
    }

    let lit = false;
    ticks.push(() => {
      const p = pads.activePad();
      const now = p !== null && buttonPressed(p, ref);
      if (now !== lit) {
        lit = now;
        dot.classList.toggle('on', now);
      }
    });
  }

  // --- The response plot ---------------------------------------------------

  /**
   * The steering curve, drawn from `steerResponse` — the same function the car
   * is steered by — with a live dot showing where the device currently sits on
   * it.
   *
   * The dot is the part that matters. A static curve tells you what the setting
   * would do; the dot tells you what your hands are doing to it right now, and
   * a deadzone that is too large is instantly obvious as a dot that sits at the
   * bottom of the plot while the wheel is visibly moving.
   */
  function buildPlot(parentEl: HTMLElement, profile: GamepadProfile): void {
    const box = el('div', 'ctrl-plot', parentEl);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    box.appendChild(svg);

    const mk = (tag: string, attrs: Record<string, string>, cls: string) => {
      const n = document.createElementNS(NS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
      n.setAttribute('class', cls);
      svg.appendChild(n);
      return n;
    };

    mk('line', { x1: '50', y1: '0', x2: '50', y2: '100' }, 'ctrl-plot-grid');
    mk('line', { x1: '0', y1: '50', x2: '100', y2: '50' }, 'ctrl-plot-grid');
    // The 1:1 reference, so "what the curve is doing" is measured against
    // "what the device is doing" rather than against nothing.
    mk('line', { x1: '0', y1: '100', x2: '100', y2: '0' }, 'ctrl-plot-ref');

    const curve = mk('path', { d: '' }, 'ctrl-plot-curve');
    const dot = mk('circle', { cx: '50', cy: '50', r: '2.6' }, 'ctrl-plot-dot');

    el('div', 'ctrl-plot-caption', box,
      'Horizontal: how far the control has moved from centre. Vertical: the steering the car receives. ' +
      'The dashed diagonal is a 1:1 response. The dot is your device, live.');

    const toX = (t: number) => 50 + t * 50;
    const toY = (v: number) => 50 - v * 50;

    // The curve only changes when a tuning value does, so it is keyed on those
    // five numbers rather than recomputed and reassigned sixty times a second.
    let lastKey = '';
    let lastDot = '';

    ticks.push(() => {
      const cal = profile.axes.steer;
      const key = [cal.deadzone, cal.saturation, cal.invert, profile.steer.curve, profile.steer.sensitivity].join(',');
      if (key !== lastKey) {
        lastKey = key;
        let d = '';
        for (let i = 0; i <= 60; i++) {
          const t = -1 + (2 * i) / 60;
          const v = steerResponse(t, cal, profile.steer);
          d += (i === 0 ? 'M' : 'L') + toX(t).toFixed(2) + ' ' + toY(v).toFixed(2) + ' ';
        }
        curve.setAttribute('d', d);
      }

      const p = pads.activePad();
      const t = p ? steerTravel(p, cal) : 0;
      const cx = toX(t).toFixed(2);
      const cy = toY(steerResponse(t, cal, profile.steer)).toFixed(2);
      if (cx + ',' + cy !== lastDot) {
        lastDot = cx + ',' + cy;
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', cy);
      }
    });
  }

  // =========================================================================

  function tick(): void {
    if (dirty) {
      dirty = false;
      rebuild();
    }
    const pad = pads.activePad();
    if (pad && pending) resolveBind(pad);
    for (const f of ticks) f();
  }

  function dispose(): void {
    pads.onDevicesChanged = previousDevicesHook;
    input.gamepadSuspended = false;
    pending = null;
    calib = null;
    ticks = [];
  }

  // Paint once immediately so the page is not blank for a frame.
  tick();

  return { tick, dispose };
}
