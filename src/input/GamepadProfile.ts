/**
 * The controller profile: what is bound to what, how each axis is calibrated,
 * and how the steering is shaped.
 *
 * This file is deliberately free of DOM and of the Gamepad API itself. It talks
 * to a structural `GamepadLike`, which the browser's `Gamepad` satisfies and a
 * plain object in a test also satisfies. That is what makes the whole mapping
 * layer verifiable without hardware: `scripts/probeGamepad.ts` feeds it invented
 * pads and checks the numbers that come out.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A standard Xbox pad and a Logitech G29 both arrive through `navigator
 * .getGamepads()` and look superficially alike, and almost nothing about them
 * is the same:
 *
 *   - The pad reports `mapping: "standard"`, four axes and sixteen buttons, its
 *     triggers as analogue BUTTONS 6 and 7 resting at 0.
 *   - The wheel reports `mapping: ""`, six or more axes and twenty-odd buttons,
 *     its pedals as AXES resting at +1 and travelling to -1 — backwards, and
 *     with a rest position that is not zero.
 *
 * So a raw reading of 0 on an axis is genuinely ambiguous: on the pad's stick it
 * means centred, on the wheel's throttle it means HALF PRESSED. No amount of
 * cleverness resolves that from one sample. The only thing that resolves it is
 * asking the player to let go of the control and then press it fully, which is
 * what the calibration in `AxisCal` records, and why every axis carries a `rest`
 * separate from its `min` and `max`.
 */

// ===========================================================================
// The structural view of a gamepad
// ===========================================================================

export interface GamepadButtonLike {
  pressed: boolean;
  value: number;
}

export interface GamepadLike {
  index: number;
  id: string;
  mapping: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly GamepadButtonLike[];
}

/** Which family a device belongs to. Decides the starting profile, nothing else. */
export type DeviceClass = 'wheel' | 'standard' | 'generic';

/** The three analogue controls the car actually needs, plus a clutch. */
export type AxisRole = 'steer' | 'throttle' | 'brake' | 'clutch';

export const AXIS_ROLES: readonly AxisRole[] = ['steer', 'throttle', 'brake', 'clutch'];

/** Everything that can be put on a button. */
export type ButtonAction =
  | 'shiftUp' | 'shiftDown' | 'drs' | 'ers' | 'pit' | 'camera' | 'pause' | 'reverse';

export const BUTTON_ACTIONS: readonly ButtonAction[] = [
  'shiftUp', 'shiftDown', 'drs', 'ers', 'pit', 'camera', 'pause', 'reverse',
];

export const BUTTON_LABELS: Record<ButtonAction, string> = {
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  drs: 'DRS',
  ers: 'ERS mode',
  pit: 'Pit request',
  camera: 'Camera',
  pause: 'Pause',
  reverse: 'Reverse',
};

export const AXIS_LABELS: Record<AxisRole, string> = {
  steer: 'Steering',
  throttle: 'Throttle',
  brake: 'Brake',
  clutch: 'Clutch',
};

/** Where a value is read from. `none` means the control is unbound. */
export type SourceKind = 'axis' | 'button' | 'none';

/**
 * One calibrated analogue input.
 *
 * `kind` is independent of the ROLE: a throttle can legitimately live on a
 * button (an Xbox trigger) or on an axis (a wheel's pedal), and this is what
 * lets one binding screen cover both without the player being told their
 * hardware is wrong.
 *
 * `rest`, `min` and `max` are RAW device units, whatever those turn out to be.
 * A pedal that rests at +1 and travels to -1 is described by rest=1, max=-1, and
 * every formula below works unchanged because they only ever use the difference.
 */
export interface AxisCal {
  kind: SourceKind;
  index: number;
  /** Raw value with the control released. The "off"/"centred" end. */
  rest: number;
  /** Raw value at full travel. For steering, this is full RIGHT. */
  max: number;
  /** Raw value at full travel the other way. Steering only (full LEFT). */
  min: number;
  /** Flip the sense of the control after normalisation. */
  invert: boolean;
  /** Fraction of travel next to rest that reads as zero, 0..0.4. */
  deadzone: number;
  /**
   * Fraction of travel trimmed off the far end, so full output arrives early.
   *
   * Defaults to zero everywhere, and deliberately so. Deadzone and saturation
   * are applied by the same rescale — `(t - dz) / (1 - dz - sat)` — so a
   * non-zero default would have made every steering input very slightly larger
   * than the pre-profile code produced for the same stick position. Small
   * enough not to be noticed, big enough to be a silent change to how the game
   * steers, which is not a thing to do by accident.
   */
  saturation: number;
  /** False until the player has actually run the calibration for this axis. */
  calibrated: boolean;
}

/** Where a button action is read from. An axis can stand in for a button. */
export interface ButtonRef {
  kind: SourceKind;
  index: number;
  /** For an axis acting as a button: which way it has to move. */
  dir: 1 | -1;
  /** For an axis acting as a button: its resting value, captured at bind time. */
  rest: number;
}

/** Shaping applied to the steering after calibration. */
export interface SteerTuning {
  /**
   * Exponent on the normalised steering input. 1 is linear; above 1 softens the
   * centre and keeps full lock reachable; below 1 makes it sharper.
   */
  curve: number;
  /** Multiplier applied after the curve, before the clamp. */
  sensitivity: number;
  /**
   * Ceiling on how fast the steering output may change, units per second.
   * 0 disables it. A real rack cannot go lock to lock instantly and a stick can,
   * so this is the knob that stops a flick of the thumb spinning the car.
   */
  rateLimit: number;
}

export interface GamepadProfile {
  /** The device this was built for, for display. */
  deviceId: string;
  deviceClass: DeviceClass;
  axes: Record<AxisRole, AxisCal>;
  buttons: Record<ButtonAction, ButtonRef>;
  steer: SteerTuning;
}

/** Persisted controller state. Lives inside `GameSettings`. */
export interface GamepadSettings {
  /**
   * Profiles keyed by device signature, so plugging a wheel in does not throw
   * away the pad's configuration and vice versa.
   */
  profiles: Record<string, GamepadProfile>;
  /** Signature of the device the player last chose. */
  activeSignature: string;
  /** Master switch for rumble. */
  forceFeedback: boolean;
  /** Rumble scale, 0..1. */
  ffbStrength: number;
}

export const DEFAULT_GAMEPAD_SETTINGS: GamepadSettings = {
  profiles: {},
  activeSignature: '',
  forceFeedback: true,
  ffbStrength: 0.75,
};

// ===========================================================================
// Construction
// ===========================================================================

export function unboundAxis(): AxisCal {
  return {
    kind: 'none', index: -1,
    rest: 0, max: 1, min: -1,
    invert: false, deadzone: 0.06, saturation: 0,
    calibrated: false,
  };
}

export function unboundButton(): ButtonRef {
  return { kind: 'none', index: -1, dir: 1, rest: 0 };
}

function axisOn(index: number, rest: number, max: number, min: number, deadzone: number): AxisCal {
  return { kind: 'axis', index, rest, max, min, invert: false, deadzone, saturation: 0, calibrated: false };
}

function buttonAxis(index: number, deadzone: number): AxisCal {
  // A trigger reported as a button: rests at 0, full travel at 1, and there is
  // no "other side" so min is the same as rest.
  return { kind: 'button', index, rest: 0, max: 1, min: 0, invert: false, deadzone, saturation: 0, calibrated: false };
}

function btn(index: number): ButtonRef {
  return { kind: 'button', index, dir: 1, rest: 0 };
}

export const DEFAULT_STEER_TUNING: SteerTuning = {
  // Linear, no rate cap. This is exactly what the game did before there was a
  // profile at all, so a player who never opens the screen is not quietly given
  // different steering than they had.
  curve: 1,
  sensitivity: 1,
  rateLimit: 0,
};

/**
 * Whether a device is a wheel, a normal pad, or something we have no opinion
 * about.
 *
 * The id string is checked first because it is the only signal that is ever
 * definite. After that: `mapping: "standard"` with the usual counts is a pad,
 * and anything with a lot of axes that is NOT claiming the standard mapping is
 * almost certainly a wheel with a pedal set, because that is the only class of
 * device that reports five or more analogue channels.
 */
export function classifyPad(pad: GamepadLike): DeviceClass {
  const id = pad.id.toLowerCase();
  if (/wheel|racing|driving force|g25|g27|g29|g920|g923|t150|t300|t500|tmx|thrustmaster|fanatec|clubsport|csl|simucube|moza|logitech momo|pedal/.test(id)) {
    return 'wheel';
  }
  if (pad.mapping === 'standard' && pad.axes.length >= 4 && pad.buttons.length >= 16) {
    return 'standard';
  }
  if (pad.axes.length >= 5 && pad.mapping !== 'standard') return 'wheel';
  return 'generic';
}

/**
 * The profile a device starts with before anyone touches the screen.
 *
 * For a standard pad this reproduces the mapping the game had hard-coded — left
 * stick steers, the triggers are throttle and brake, A is DRS, B is reverse, Y
 * is the camera — so nothing changes for a player who already had a pad working.
 *
 * For a wheel it is a GUESS, and it is marked as one. Axis 0 steering is
 * near-universal; pedals on axes 1, 2 and 3 resting at +1 and travelling to -1
 * is what the common Logitech and Thrustmaster wheels report on Chrome, but it
 * is not a standard and a device that does something else will read wrong until
 * the player calibrates. `calibrated` stays false so the screen can say so
 * rather than the car quietly driving itself.
 */
export function autoProfileFor(pad: GamepadLike): GamepadProfile {
  const cls = classifyPad(pad);
  const nAxes = pad.axes.length;
  const nButtons = pad.buttons.length;

  if (cls === 'wheel') {
    return {
      deviceId: pad.id,
      deviceClass: cls,
      axes: {
        steer: axisOn(0, 0, 1, -1, 0.02),
        // Wheel pedals: released at +1, floored at -1. Deliberately a small
        // deadzone — a pedal with a big one feels dead off the stop.
        throttle: nAxes > 1 ? axisOn(1, 1, -1, 1, 0.03) : unboundAxis(),
        brake: nAxes > 2 ? axisOn(2, 1, -1, 1, 0.03) : unboundAxis(),
        clutch: nAxes > 3 ? axisOn(3, 1, -1, 1, 0.05) : unboundAxis(),
      },
      buttons: {
        // Paddle shifters are buttons 4 and 5 on a Logitech wheel, 0 and 1 on
        // some others. Another guess the player can correct in two presses.
        shiftUp: nButtons > 5 ? btn(5) : unboundButton(),
        shiftDown: nButtons > 4 ? btn(4) : unboundButton(),
        drs: nButtons > 0 ? btn(0) : unboundButton(),
        ers: nButtons > 2 ? btn(2) : unboundButton(),
        pit: nButtons > 8 ? btn(8) : unboundButton(),
        camera: nButtons > 3 ? btn(3) : unboundButton(),
        pause: nButtons > 9 ? btn(9) : unboundButton(),
        reverse: nButtons > 1 ? btn(1) : unboundButton(),
      },
      // A wheel has real travel and real self-centring, so it wants none of the
      // softening a thumbstick needs.
      steer: { curve: 1, sensitivity: 1, rateLimit: 0 },
    };
  }

  // Standard pad, and the fallback for anything unrecognised — which is what
  // the game already assumed for every device, so this is not a regression for
  // an odd pad, it is the same guess with a screen to fix it on.
  return {
    deviceId: pad.id,
    deviceClass: cls,
    axes: {
      steer: axisOn(0, 0, 1, -1, 0.09),
      throttle: nButtons > 7 ? buttonAxis(7, 0.02) : (nAxes > 5 ? axisOn(5, -1, 1, -1, 0.02) : unboundAxis()),
      brake: nButtons > 6 ? buttonAxis(6, 0.02) : (nAxes > 4 ? axisOn(4, -1, 1, -1, 0.02) : unboundAxis()),
      clutch: unboundAxis(),
    },
    buttons: {
      shiftUp: nButtons > 5 ? btn(5) : unboundButton(),
      shiftDown: nButtons > 4 ? btn(4) : unboundButton(),
      drs: nButtons > 0 ? btn(0) : unboundButton(),
      ers: nButtons > 2 ? btn(2) : unboundButton(),
      pit: nButtons > 8 ? btn(8) : unboundButton(),
      camera: nButtons > 3 ? btn(3) : unboundButton(),
      pause: nButtons > 9 ? btn(9) : unboundButton(),
      reverse: nButtons > 1 ? btn(1) : unboundButton(),
    },
    // Linear and uncapped, which is exactly what the hard-coded gamepad path
    // did before this profile existed. A thumbstick usually wants a curve above
    // 1 to soften the centre — but changing the default would silently alter
    // the steering of every player who already had a pad working, so the screen
    // offers it and does not impose it.
    steer: { curve: 1, sensitivity: 1, rateLimit: 0 },
  };
}

/**
 * A stable key for a device.
 *
 * The id alone is not enough — the same wheel in different modes enumerates
 * with different axis counts and needs a different calibration — and the index
 * alone is not enough either, because it changes between sessions.
 */
export function signatureOf(pad: GamepadLike): string {
  return pad.id + '#' + pad.axes.length + 'a' + pad.buttons.length + 'b';
}

// ===========================================================================
// Reading a device through a profile
// ===========================================================================

/** The raw device value behind a source, in whatever units the device uses. */
export function rawValue(pad: GamepadLike, kind: SourceKind, index: number): number {
  if (kind === 'axis') return pad.axes[index] ?? 0;
  if (kind === 'button') {
    const b = pad.buttons[index];
    if (!b) return 0;
    // Some pads report a digital button with value 0 but pressed true.
    return b.value !== 0 ? b.value : (b.pressed ? 1 : 0);
  }
  return 0;
}

export function rawAxis(pad: GamepadLike, cal: AxisCal): number {
  return rawValue(pad, cal.kind, cal.index);
}

/**
 * Deadzone and saturation on a 0..1 travel fraction.
 *
 * Rescaled rather than clipped, so the usable range still reaches 1.0. Clipping
 * instead would mean a 10% deadzone costs 10% of your throttle forever.
 */
function shapeTravel(t: number, deadzone: number, saturation: number): number {
  const dz = Math.min(Math.max(deadzone, 0), 0.45);
  const sat = Math.min(Math.max(saturation, 0), 0.45);
  const span = 1 - dz - sat;
  if (span <= 1e-6) return t > dz ? 1 : 0;
  if (t <= dz) return 0;
  if (t >= 1 - sat) return 1;
  return (t - dz) / span;
}

/**
 * A pedal, normalised to 0..1.
 *
 * `(raw - rest) / (max - rest)` is the whole trick, and it is why calibration
 * is not optional. It works identically for a trigger (rest 0, max 1), for a
 * wheel pedal (rest 1, max -1) and for a pedal wired backwards (rest -1, max 1),
 * because a fraction of travel does not care which direction travel goes in.
 */
export function pedalValue(pad: GamepadLike, cal: AxisCal): number {
  if (cal.kind === 'none') return 0;
  const raw = rawAxis(pad, cal);
  const span = cal.max - cal.rest;
  if (Math.abs(span) < 1e-6) return 0;
  let t = (raw - cal.rest) / span;
  t = Math.min(Math.max(t, 0), 1);
  const out = shapeTravel(t, cal.deadzone, cal.saturation);
  return cal.invert ? 1 - out : out;
}

/**
 * Steering, normalised to -1..1.
 *
 * The two halves are scaled independently against the captured centre. That
 * matters on real hardware: a wheel calibrated by hand rarely has its centre
 * exactly halfway between its stops, and averaging the two halves would make
 * the car pull to one side at rest — the single most obvious way for a steering
 * calibration to feel broken.
 */
export function steerValue(pad: GamepadLike, cal: AxisCal): number {
  if (cal.kind === 'none') return 0;
  const t = steerTravel(pad, cal);
  const shaped = Math.sign(t) * shapeTravel(Math.abs(t), cal.deadzone, cal.saturation);
  return cal.invert ? -shaped : shaped;
}

/**
 * Raw steering travel as a fraction of the calibrated range, -1..1, with no
 * deadzone, saturation or inversion applied.
 *
 * This is the honest "where is the wheel physically" number. The screen plots
 * the response against it, and shows it as a separate marker on the live bar,
 * so a player can see the difference between the device not moving and the
 * deadzone eating the movement — two faults that look identical if you only
 * ever show the processed value.
 */
export function steerTravel(pad: GamepadLike, cal: AxisCal): number {
  if (cal.kind === 'none') return 0;
  const raw = rawAxis(pad, cal);
  const centre = cal.rest;
  let t: number;
  if (raw >= centre) {
    const span = cal.max - centre;
    t = Math.abs(span) < 1e-6 ? 0 : (raw - centre) / span;
  } else {
    const span = centre - cal.min;
    t = Math.abs(span) < 1e-6 ? 0 : -((centre - raw) / span);
  }
  return Math.min(Math.max(t, -1), 1);
}

/** Raw pedal travel, 0..1, before deadzone and saturation. */
export function pedalTravel(pad: GamepadLike, cal: AxisCal): number {
  if (cal.kind === 'none') return 0;
  const span = cal.max - cal.rest;
  if (Math.abs(span) < 1e-6) return 0;
  return Math.min(Math.max((rawAxis(pad, cal) - cal.rest) / span, 0), 1);
}

/**
 * The steering curve.
 *
 * Exponent on the magnitude, sign preserved, then the sensitivity multiplier.
 * `curve` above 1 spends more of the stick's travel on small corrections without
 * putting full lock out of reach, which is the shape a thumbstick needs and a
 * wheel does not.
 */
export function applySteerCurve(x: number, tune: SteerTuning): number {
  const mag = Math.min(Math.abs(x), 1);
  const gamma = Math.max(tune.curve, 0.2);
  const shaped = Math.pow(mag, gamma) * Math.max(tune.sensitivity, 0);
  return Math.sign(x) * Math.min(shaped, 1);
}

/**
 * The whole steering chain, from a fraction of physical travel to the value the
 * car receives.
 *
 * Exists so the response plot on the controller screen is drawn from the same
 * code the car is driven by. A plot computed from its own copy of the formula
 * is a drawing of what someone believed the setting did, and the first time the
 * two drift apart the plot becomes actively misleading.
 *
 * `t` is -1..1, where ±1 is the wheel or stick against its calibrated stop.
 */
export function steerResponse(t: number, cal: AxisCal, tune: SteerTuning): number {
  const shaped = Math.sign(t) * shapeTravel(Math.min(Math.abs(t), 1), cal.deadzone, cal.saturation);
  return applySteerCurve(cal.invert ? -shaped : shaped, tune);
}

/** True when a button action is currently held. */
export function buttonPressed(pad: GamepadLike, ref: ButtonRef): boolean {
  if (ref.kind === 'button') {
    const b = pad.buttons[ref.index];
    if (!b) return false;
    return b.pressed || b.value > 0.5;
  }
  if (ref.kind === 'axis') {
    const raw = pad.axes[ref.index] ?? 0;
    // Measured against the resting value captured when the binding was made, so
    // an axis that idles at -1 (a hat, or a pedal) does not read as permanently
    // held the moment it is bound.
    return ref.dir * (raw - ref.rest) > 0.55;
  }
  return false;
}

// ===========================================================================
// Press-to-bind
// ===========================================================================

/** A snapshot of every channel, taken before capture starts. */
export interface PadBaseline {
  axes: number[];
  buttons: number[];
}

export function baselineOf(pad: GamepadLike): PadBaseline {
  return {
    axes: pad.axes.slice(),
    buttons: pad.buttons.map((b) => (b.value !== 0 ? b.value : b.pressed ? 1 : 0)),
  };
}

export interface CapturedInput {
  kind: 'axis' | 'button';
  index: number;
  /** Which way the input moved from its baseline. */
  dir: 1 | -1;
  /** The baseline value, which for an axis is its resting position. */
  rest: number;
}

/**
 * The first channel to move far enough from where it started.
 *
 * Everything is measured against a baseline rather than against zero, which is
 * what lets this work on a wheel whose pedals sit at -1 and whose hat sits at
 * 3.28 when untouched. Without the baseline, binding anything on such a device
 * would instantly capture whichever channel happened to idle furthest from zero.
 *
 * `prefer` tilts the search but never excludes: asking for an axis and getting a
 * button back is a legitimate answer (an Xbox trigger IS the throttle), and the
 * caller converts. Buttons are checked first when preferred because a button
 * press on a wheel often twitches an axis at the same moment.
 */
export function captureInput(
  pad: GamepadLike,
  baseline: PadBaseline,
  prefer: 'axis' | 'button',
  axisThreshold = 0.5,
): CapturedInput | null {
  const findButton = (): CapturedInput | null => {
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i];
      const v = b.value !== 0 ? b.value : b.pressed ? 1 : 0;
      const was = baseline.buttons[i] ?? 0;
      if (v > 0.6 && v - was > 0.5) return { kind: 'button', index: i, dir: 1, rest: was };
    }
    return null;
  };
  const findAxis = (): CapturedInput | null => {
    let best: CapturedInput | null = null;
    let bestDelta = axisThreshold;
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i] ?? 0;
      const was = baseline.axes[i] ?? 0;
      const d = v - was;
      if (Math.abs(d) > bestDelta) {
        bestDelta = Math.abs(d);
        best = { kind: 'axis', index: i, dir: d > 0 ? 1 : -1, rest: was };
      }
    }
    return best;
  };

  return prefer === 'button'
    ? (findButton() ?? findAxis())
    : (findAxis() ?? findButton());
}

/**
 * Turns a captured input into an axis binding, whichever kind it turned out to
 * be.
 *
 * A button captured for an axis role keeps its natural 0..1 travel. An axis
 * captured for an axis role starts with the direction the player actually moved
 * it as its "full" end, and its resting value as rest — which is already a
 * usable one-press calibration for a pedal, before the full routine is run.
 */
export function axisFromCapture(cap: CapturedInput, previous: AxisCal, role: AxisRole): AxisCal {
  const next: AxisCal = { ...previous, kind: cap.kind, index: cap.index, calibrated: false };
  if (cap.kind === 'button') {
    next.rest = 0;
    next.max = 1;
    next.min = 0;
    next.invert = false;
    return next;
  }
  next.rest = cap.rest;
  if (role === 'steer') {
    // Steering has two ends; assume a symmetric device until calibrated.
    next.max = cap.dir > 0 ? 1 : -1;
    next.min = cap.dir > 0 ? -1 : 1;
  } else {
    next.max = cap.dir > 0 ? 1 : -1;
    next.min = cap.rest;
  }
  next.invert = false;
  return next;
}

/** Turns a captured input into a button binding, whichever kind it turned out to be. */
export function buttonFromCapture(cap: CapturedInput): ButtonRef {
  return { kind: cap.kind, index: cap.index, dir: cap.dir, rest: cap.rest };
}

/** How a binding reads on screen. */
export function describeAxis(cal: AxisCal): string {
  if (cal.kind === 'none') return 'unbound';
  if (cal.kind === 'button') return 'Button ' + cal.index;
  return 'Axis ' + cal.index;
}

export function describeButton(ref: ButtonRef): string {
  if (ref.kind === 'none') return 'unbound';
  if (ref.kind === 'axis') return 'Axis ' + ref.index + (ref.dir > 0 ? ' +' : ' −');
  return 'Button ' + ref.index;
}

// ===========================================================================
// Persistence hygiene
// ===========================================================================

/**
 * Repairs a profile read off disk.
 *
 * A save written by an older build, or hand-edited, must not be able to put a
 * NaN into the steering. Every field is coerced to something the maths above
 * can survive, because the alternative is a car that will not turn and a player
 * with no way to find out why.
 */
export function normaliseProfile(raw: unknown, fallbackId = 'controller'): GamepadProfile {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<GamepadProfile>;
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const kindOf = (v: unknown): SourceKind => (v === 'axis' || v === 'button' ? v : 'none');

  const axis = (v: unknown, def: AxisCal): AxisCal => {
    const a = (typeof v === 'object' && v !== null ? v : {}) as Partial<AxisCal>;
    const kind = a.kind === undefined ? def.kind : kindOf(a.kind);
    const index = num(a.index, def.index);
    return {
      kind: index < 0 ? 'none' : kind,
      index,
      rest: num(a.rest, def.rest),
      max: num(a.max, def.max),
      min: num(a.min, def.min),
      invert: a.invert === true,
      deadzone: Math.min(Math.max(num(a.deadzone, def.deadzone), 0), 0.45),
      saturation: Math.min(Math.max(num(a.saturation, def.saturation), 0), 0.45),
      calibrated: a.calibrated === true,
    };
  };

  const button = (v: unknown, def: ButtonRef): ButtonRef => {
    const b = (typeof v === 'object' && v !== null ? v : {}) as Partial<ButtonRef>;
    const kind = b.kind === undefined ? def.kind : kindOf(b.kind);
    const index = num(b.index, def.index);
    return {
      kind: index < 0 ? 'none' : kind,
      index,
      dir: b.dir === -1 ? -1 : 1,
      rest: num(b.rest, def.rest),
    };
  };

  const cls: DeviceClass =
    o.deviceClass === 'wheel' || o.deviceClass === 'standard' ? o.deviceClass : 'generic';

  const rawAxes = (o.axes ?? {}) as Partial<Record<AxisRole, AxisCal>>;
  const rawButtons = (o.buttons ?? {}) as Partial<Record<ButtonAction, ButtonRef>>;
  const axes = {} as Record<AxisRole, AxisCal>;
  for (const role of AXIS_ROLES) axes[role] = axis(rawAxes[role], unboundAxis());
  const buttons = {} as Record<ButtonAction, ButtonRef>;
  for (const action of BUTTON_ACTIONS) buttons[action] = button(rawButtons[action], unboundButton());

  const t = (o.steer ?? {}) as Partial<SteerTuning>;
  return {
    deviceId: typeof o.deviceId === 'string' ? o.deviceId : fallbackId,
    deviceClass: cls,
    axes,
    buttons,
    steer: {
      curve: Math.min(Math.max(num(t.curve, 1), 0.3), 3.5),
      sensitivity: Math.min(Math.max(num(t.sensitivity, 1), 0.2), 2.5),
      rateLimit: Math.min(Math.max(num(t.rateLimit, 0), 0), 20),
    },
  };
}

export function normaliseGamepadSettings(raw: unknown): GamepadSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<GamepadSettings>;
  const profiles: Record<string, GamepadProfile> = {};
  const src = (typeof o.profiles === 'object' && o.profiles !== null ? o.profiles : {}) as Record<string, unknown>;
  for (const key of Object.keys(src)) profiles[key] = normaliseProfile(src[key], key);
  const strength = typeof o.ffbStrength === 'number' && Number.isFinite(o.ffbStrength) ? o.ffbStrength : 0.75;
  return {
    profiles,
    activeSignature: typeof o.activeSignature === 'string' ? o.activeSignature : '',
    forceFeedback: o.forceFeedback !== false,
    ffbStrength: Math.min(Math.max(strength, 0), 1),
  };
}
