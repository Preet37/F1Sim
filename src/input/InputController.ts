import { clamp, clamp01, damp, moveToward } from '../core/MathUtils';
import type { ErsMode, VehicleControls } from '../physics/VehiclePhysics';
import { GamepadManager } from './GamepadManager';
import {
  applySteerCurve, buttonPressed, pedalValue, steerValue,
  BUTTON_ACTIONS, DEFAULT_GAMEPAD_SETTINGS,
  type ButtonAction, type GamepadSettings,
} from './GamepadProfile';

/**
 * Unified input.
 *
 * Every source — keyboard, gamepad, touch joystick, device tilt — writes into the
 * same three normalised targets (`targetSteer`, `targetThrottle`, `targetBrake`),
 * and one place turns those into the actual `VehicleControls`. Nothing downstream
 * knows or cares which device is in use, and the physics receives identical inputs
 * from a phone and a desktop.
 *
 * The important design point is that digital sources are RAMPED, not applied
 * instantly. A keyboard gives 0 or 1, but a car given an instantaneous full-lock
 * steering input at 300km/h simply spins. Ramping the digital input at a rate a
 * human hand or foot could actually achieve is what makes a keyboard playable
 * without giving the car artificial stability — the car is unchanged; the input is
 * made physically plausible.
 */

export type InputSource = 'keyboard' | 'gamepad' | 'touch' | 'tilt';

export interface InputConfig {
  /** Steering rate for digital input, units per second. */
  keyboardSteerRate: number;
  /** How fast digital steering returns to centre. */
  keyboardCentreRate: number;
  /** Pedal ramp rates for digital input. */
  keyboardThrottleRate: number;
  keyboardBrakeRate: number;
  /**
   * Deadzone applied to analogue sticks.
   *
   * Now only a documented default: the live value is per-device and lives in
   * the controller profile, because one number cannot be right for a thumbstick
   * that rattles and a wheel with a hall sensor that does not.
   */
  gamepadDeadzone: number;
  /** Tilt angle in degrees mapped to full lock. */
  tiltFullLockDeg: number;
  /** Tilt angle treated as neutral, captured on calibration. */
  tiltNeutralDeg: number;
  /** Invert tilt steering. */
  tiltInvert: boolean;
  /** Steering assist: scales lock down with speed, as a real rack does. */
  speedSensitiveSteering: boolean;
  /** Optional traction assist for less experienced players. */
  tractionAssist: boolean;
  /** Optional braking assist that prevents lock-ups. */
  brakingAssist: boolean;
}

export const DEFAULT_INPUT_CONFIG: InputConfig = {
  keyboardSteerRate: 3.4,
  keyboardCentreRate: 5.5,
  keyboardThrottleRate: 4.5,
  /**
   * Brake pedal ramp, pedal-fraction per second.
   *
   * Deliberately SLOWER than the throttle, which is the opposite of what it was.
   *
   * The brake needs finer modulation than the throttle, not coarser. Measured
   * against the tyre model: from about 100 km/h upward the brakes out-grip the
   * tyres, so the fronts lock at 0.64 pedal at 150 km/h and 0.84 at 200, while
   * the throttle can be held at 0.99 and 1.00 at those speeds. Only above
   * 250 km/h, once downforce has caught up, is full pedal usable at all.
   *
   * At the old 6.5 the brake reached full travel in 0.154s against the
   * throttle's 0.222s — 1.44x faster — so a keyboard tap blew straight through
   * the lock-up threshold before the player could feel it. That is why braking
   * felt so much harder than accelerating. At 3.2 a tap lands around 0.3 pedal
   * and holding builds to the limit over a third of a second, which is roughly
   * how quickly a real driver rolls onto the pedal.
   */
  keyboardBrakeRate: 3.2,
  gamepadDeadzone: 0.09,
  tiltFullLockDeg: 26,
  tiltNeutralDeg: 0,
  tiltInvert: false,
  speedSensitiveSteering: true,
  tractionAssist: false,
  brakingAssist: false,
};

/**
 * How long a digital control has actually been held, in wall-clock time.
 *
 * This exists because ramping a digital input by the FRAME time is not the same
 * thing as ramping it by the time the key was down, and the difference is a
 * frame-rate dependency in the handling.
 *
 * A key held for 200ms is only seen by the frames that happen to tick while it
 * is down, and each of those ramps the input by `rate * its own frame time`. So
 * the steering produced is proportional to (number of ticks inside the press) x
 * (frame period) rather than to the length of the press. Measured by
 * `probe:framerate` on the real controller: the same 200ms of key produced 0.447
 * of steering lock at 15fps and 0.652 at 144fps — 46% more steering for the same
 * input — rising monotonically with frame rate the whole way. A 40ms tap was
 * discarded entirely on 40% of attempts at 15fps and always registered at 60.
 *
 * It is unbiased in expectation over random press phase, which is why it never
 * showed up as a wrong average; what it produces is SPREAD, and spread in how
 * much lock a press buys is felt directly as the car darting more on one press
 * than the next. The player's frame rate recently went from 19-30 to 50-60 and
 * the same presses started buying up to a third more lock.
 *
 * Recording the edges against the event clock and integrating the real held time
 * removes it. Note this changes nothing at all when a key is held across whole
 * frames — which is the steady-state case — so the car's response to a sustained
 * input is untouched. Only the edges move, and the edges are where the bug was.
 */
class HoldClock {
  private downAt = -1;
  private accumMs = 0;

  press(tMs: number): void {
    if (this.downAt < 0) this.downAt = tMs;
  }

  release(tMs: number): void {
    if (this.downAt < 0) return;
    this.accumMs += Math.max(0, tMs - this.downAt);
    this.downAt = -1;
  }

  /** Seconds held since the previous call. Resets the window. */
  consumeS(tMs: number): number {
    let ms = this.accumMs;
    this.accumMs = 0;
    if (this.downAt >= 0) {
      ms += Math.max(0, tMs - this.downAt);
      this.downAt = tMs;
    }
    return ms * 0.001;
  }

  clear(): void {
    this.downAt = -1;
    this.accumMs = 0;
  }

  /**
   * Whether the control is still down at the end of the window.
   *
   * Needed to get the ORDER of a frame's two portions right. A frame in which a
   * key went down partway through is chronologically "released, then held", and
   * a frame in which one came up is "held, then released" — and applying them
   * the wrong way round is not a rounding error. At 15fps a press landing 50ms
   * into a 66.7ms frame buys 0.057 of lock, and centring the other 50ms at
   * 5.5/s afterwards takes 0.275 back: the press is erased outright. That is
   * exactly the "flick produced nothing" case, and it is why a tap at 15fps
   * registered 0.048 against 0.264 at 90fps.
   */
  get isDown(): boolean {
    return this.downAt >= 0;
  }
}

/** A touch zone on screen, in normalised viewport coordinates. */
interface TouchZone {
  x0: number; y0: number; x1: number; y1: number;
}

/** Right-hand-side control layout for touch. Tuned for a thumb's reach. */
const TOUCH_ZONES = {
  // Left half: steering joystick. Anywhere in this box starts a drag.
  steer: { x0: 0.0, y0: 0.42, x1: 0.44, y1: 1.0 } as TouchZone,
  throttle: { x0: 0.72, y0: 0.5, x1: 1.0, y1: 1.0 } as TouchZone,
  brake: { x0: 0.5, y0: 0.62, x1: 0.71, y1: 1.0 } as TouchZone,
  drs: { x0: 0.5, y0: 0.4, x1: 0.71, y1: 0.6 } as TouchZone,
  ers: { x0: 0.72, y0: 0.3, x1: 1.0, y1: 0.48 } as TouchZone,
};

function inZone(z: TouchZone, nx: number, ny: number): boolean {
  return nx >= z.x0 && nx <= z.x1 && ny >= z.y0 && ny <= z.y1;
}

/** Tracks one active touch. */
interface ActiveTouch {
  id: number;
  role: 'steer' | 'throttle' | 'brake' | 'drs' | 'ers' | 'none';
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export class InputController {
  config: InputConfig = { ...DEFAULT_INPUT_CONFIG };

  /** The unified targets every source writes into. */
  targetSteer = 0;
  targetThrottle = 0;
  targetBrake = 0;

  /** True while the player is asking for DRS. */
  drsHeld = false;
  /** True while reverse is being requested from the keyboard/gamepad. */
  reverseHeld = false;
  /** True while the on-screen reverse control is held. */
  reverseTouchHeld = false;
  ersMode: ErsMode = 'balanced';
  /** Set for one frame when the camera key is pressed. */
  cameraCyclePressed = false;
  /** Set for one frame when the help key is pressed. */
  helpToggled = false;
  /** True on the frame the racing-line key was pressed. */
  racingLineToggled = false;
  pausePressed = false;
  /**
   * Which gearbox the player is driving, and the gear they last asked for.
   *
   * These used to be one number, and that was issue #45. `gearRequest` was a
   * LATCH: pressing `4` once set it to 4 and only `0` ever cleared it, `0`
   * appeared in no UI and in no help text, and `VehiclePhysics.updateGearbox`
   * returned early on any non-zero request — so the automatic block below it was
   * dead code for the rest of the session and the car could neither upshift nor
   * downshift. The player found it by pressing a digit on the careers page and
   * arrived at 205 km/h in fourth on the limiter with every shift light red.
   *
   * Splitting the mode out of the number is what makes the state SAYABLE. A
   * single integer cannot be displayed as "you are in manual" without inventing
   * a gear to show, and a mode nothing displays is a mode nobody can leave.
   * `gearMode` is what the HUD prints and what `G` toggles; `gearRequest` is
   * only meaningful while it reads 'manual', and `update` publishes 0 otherwise
   * so the physics sees a clean automatic request rather than a stale level.
   */
  gearMode: 'auto' | 'manual' = 'auto';
  /** The gear last asked for. Only published while `gearMode` is 'manual'. */
  gearRequest = 0;
  /** Set for one frame when the player asks to pit. */
  pitRequestToggled = false;
  /**
   * The pit sheet's three controls, each set for one frame.
   *
   * They live here rather than on the panel because a panel that listens to the
   * keyboard itself is a panel that only works on a keyboard. Everything the
   * car obeys already arrives through this class — profile-mapped gamepad,
   * wheel, keyboard, touch — and the pit sheet is a control of the car.
   */
  pitTyreCyclePressed = false;
  pitRepairTogglePressed = false;
  pitConfirmPressed = false;
  /**
   * Set for one frame on a paddle shift.
   *
   * Deliberately NOT turned into a `gearRequest` here. A paddle asks for "one
   * gear up from whatever I am in", and this class does not know what gear the
   * car is in — only the caller holding the physics does. Guessing here would
   * mean tracking a shadow gear that drifts out of step with the gearbox the
   * moment it shifts on its own.
   */
  shiftUpPressed = false;
  shiftDownPressed = false;

  /** Which source produced the most recent meaningful input. */
  lastSource: InputSource = 'keyboard';
  /** True when a touch device has been detected. */
  touchAvailable = false;
  /** True when device orientation is available and permitted. */
  tiltAvailable = false;
  /** True when tilt steering is the active steering source. */
  tiltEnabled = false;

  /**
   * Whether keystrokes are driving inputs at all.
   *
   * `attach` is called once when the shell starts and released only on teardown,
   * so this object's `keydown` listener is live on the menu, the settings page
   * and every career screen — everywhere in the game. The text-field guard in
   * `onKeyDown` stops a key aimed at an `<input>`, and it works; what it cannot
   * stop is a key pressed with a BUTTON focused, which is most of a career
   * screen. Nothing downstream noticed because `main.ts` only READS this object
   * while `screen === 'racing'` — but three pieces of state here are persistent
   * rather than per-frame (the gear mode, the ERS mode, the DRS flag), so a
   * digit or an `E` pressed on a menu was still sitting in the car when the
   * session started. That is precisely how issue #45 was reached: the player was
   * "trying to run something on the careers page".
   *
   * Defaults to true so that a controller used without a shell — every probe in
   * `scripts/` — behaves exactly as before. The shell opts out.
   */
  private enabledFlag = true;

  get enabled(): boolean { return this.enabledFlag; }

  /**
   * Turning it off also puts everything down.
   *
   * The same reasoning as the `blur` handler: a key held at the moment focus
   * leaves never sends its `keyup` to us, and a control left held is a car that
   * drives itself the next time a session starts.
   */
  set enabled(v: boolean) {
    if (this.enabledFlag === v) return;
    this.enabledFlag = v;
    if (v) return;
    this.keys.clear();
    for (const c of Object.values(this.holds)) c.clear();
    this.targetSteer = 0;
    this.targetThrottle = 0;
    this.targetBrake = 0;
    this.drsHeld = false;
    this.reverseHeld = false;
  }

  /** Live joystick state, for the on-screen overlay to draw. */
  joystickActive = false;
  joystickCentreX = 0;
  joystickCentreY = 0;
  joystickX = 0;
  joystickY = 0;
  throttleHeld = false;
  brakeHeld = false;

  /** Device enumeration, profiles and rumble. */
  readonly gamepads = new GamepadManager();
  /**
   * The persisted controller configuration.
   *
   * Replaced wholesale by the shell once settings have been loaded. It starts
   * as a copy of the defaults so that an InputController used without a shell —
   * in a test, or before settings arrive — still has somewhere to put the
   * profile it auto-detects rather than throwing on first poll.
   */
  gamepadSettings: GamepadSettings = { ...DEFAULT_GAMEPAD_SETTINGS, profiles: {} };
  /**
   * Suspends gamepad reading.
   *
   * Set while the controller screen is binding or calibrating, so pressing the
   * button you are trying to bind does not also cycle the camera, and so a
   * throttle held to its stop during calibration is not fed to a car.
   */
  gamepadSuspended = false;

  private readonly keys = new Set<string>();
  /**
   * How long each digital control has been held, against the event clock.
   * Keyed by the logical control rather than by the key, so that Left and A
   * are one control and holding both does not count twice.
   */
  private readonly holds = {
    left: new HoldClock(), right: new HoldClock(), throttle: new HoldClock(),
    brake: new HoldClock(), down: new HoldClock(),
  };
  /**
   * The clock the held-time integration is measured against, milliseconds.
   *
   * Overridable so that `probe:framerate` can drive the real controller on a
   * simulated clock and get a repeatable answer. In the game it is
   * `performance.now()`, which is the same clock a KeyboardEvent's `timeStamp`
   * is expressed in — so a press is timed by when the browser says it arrived,
   * not by when a busy main thread got round to dispatching it.
   */
  timeSourceMs: () => number = () => performance.now();
  private readonly touches = new Map<number, ActiveTouch>();
  private element: HTMLElement | null = null;
  private tiltGamma = 0;
  private tiltCalibrated = false;
  /** Previous frame's held state per action, for edge detection. */
  private readonly padHeld = new Map<ButtonAction, boolean>();

  /** Joystick travel, in pixels, that corresponds to full lock. */
  private joystickRadiusPx = 90;

  private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => {
    this.keys.clear();
    for (const c of Object.values(this.holds)) c.clear();
  };
  private boundOrientation = (e: DeviceOrientationEvent) => this.onOrientation(e);
  private boundTouchStart = (e: TouchEvent) => this.onTouchStart(e);
  private boundTouchMove = (e: TouchEvent) => this.onTouchMove(e);
  private boundTouchEnd = (e: TouchEvent) => this.onTouchEnd(e);
  private boundGamepadConnected = () => { this.lastSource = 'gamepad'; };

  /** Attaches listeners. `element` receives the touch events. */
  attach(element: HTMLElement): void {
    this.element = element;
    this.touchAvailable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    window.addEventListener('keydown', this.boundKeyDown, { passive: false });
    window.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('blur', this.boundBlur);
    window.addEventListener('gamepadconnected', this.boundGamepadConnected);
    this.gamepads.attach();

    element.addEventListener('touchstart', this.boundTouchStart, { passive: false });
    element.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    element.addEventListener('touchend', this.boundTouchEnd, { passive: false });
    element.addEventListener('touchcancel', this.boundTouchEnd, { passive: false });

    // The joystick's full-lock travel scales with screen size so it feels the
    // same on a phone and a tablet.
    this.joystickRadiusPx = clamp(Math.min(window.innerWidth, window.innerHeight) * 0.16, 55, 130);
  }

  detach(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('blur', this.boundBlur);
    window.removeEventListener('gamepadconnected', this.boundGamepadConnected);
    window.removeEventListener('deviceorientation', this.boundOrientation);
    this.gamepads.detach();
    if (this.element) {
      this.element.removeEventListener('touchstart', this.boundTouchStart);
      this.element.removeEventListener('touchmove', this.boundTouchMove);
      this.element.removeEventListener('touchend', this.boundTouchEnd);
      this.element.removeEventListener('touchcancel', this.boundTouchEnd);
    }
    this.element = null;
  }

  /**
   * Requests permission for device orientation and enables tilt steering.
   *
   * iOS requires this to be called from a user gesture, and silently does nothing
   * otherwise — so it must be wired to a button press, never to page load.
   */
  async enableTilt(): Promise<boolean> {
    type PermissionCapable = { requestPermission?: () => Promise<'granted' | 'denied'> };
    const DOE = (window as unknown as { DeviceOrientationEvent?: PermissionCapable }).DeviceOrientationEvent;

    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        if (result !== 'granted') return false;
      } catch {
        return false;
      }
    } else if (!('DeviceOrientationEvent' in window)) {
      return false;
    }

    window.addEventListener('deviceorientation', this.boundOrientation);
    this.tiltAvailable = true;
    this.tiltEnabled = true;
    this.tiltCalibrated = false;
    return true;
  }

  disableTilt(): void {
    this.tiltEnabled = false;
    window.removeEventListener('deviceorientation', this.boundOrientation);
  }

  /** Captures the current tilt as neutral. */
  calibrateTilt(): void {
    this.config.tiltNeutralDeg = this.tiltGamma;
    this.tiltCalibrated = true;
  }

  // =========================================================================
  // Event handlers
  // =========================================================================

  private onKeyDown(e: KeyboardEvent): void {
    // A key typed into a text field belongs to the text field.
    //
    // These listeners are on `window`, so they see every keystroke in the
    // document including the ones aimed at an input. `GAME_KEYS` covers w, a,
    // s, d, b, h, c, p, e, l, t, f, the digits, space and Enter — so with no
    // guard here, typing a driver's name into the career screen silently lost
    // more than half its letters, could not contain a space, and could not be
    // submitted with Enter. The player sees some keys work and others do
    // nothing, which is exactly how it was reported.
    //
    // Released as well as pressed: bailing out of keydown alone would leave a
    // key stuck in `this.keys` if focus moved to a field mid-press, and the car
    // would drive itself. `onKeyUp` runs unconditionally for the same reason.
    if (isTextEntry(e.target)) return;
    // And a key pressed anywhere outside a session belongs to no car. See
    // `enabled` — this is the other half of the same rule, for the case where
    // the focused element is a button rather than a field.
    if (!this.enabled) return;

    const k = e.key.toLowerCase();
    // Only swallow keys the game actually uses, so browser shortcuts still work.
    if (GAME_KEYS.has(k) || GAME_KEYS.has(e.code)) e.preventDefault();
    if (this.keys.has(k)) return;
    this.keys.add(k);
    this.syncHolds(stampOf(e, this.timeSourceMs));
    this.lastSource = 'keyboard';

    switch (k) {
      case 'c': this.cameraCyclePressed = true; break;
      case 'h': this.helpToggled = true; break;
      case 'r': this.racingLineToggled = true; break;
      case 'p': case 'escape': this.pausePressed = true; break;
      case 'e': this.cycleErsMode(); break;
      case 'l': this.pitRequestToggled = true; break;
      // The pit sheet, on three keys next to each other under the left hand,
      // none of which does anything while the sheet is down. T for tyre, F for
      // the front wing, Enter to send it.
      case 't': this.pitTyreCyclePressed = true; break;
      case 'f': this.pitRepairTogglePressed = true; break;
      case 'enter': this.pitConfirmPressed = true; break;
      // The gearbox mode, on its own key, printed in the controls overlay and
      // shown on the HUD beside the gear. Issue #45's second requirement: there
      // has to be a way back that a player can FIND. `0` was the old way back
      // and it is kept below, but it was in no menu, on no screen and in no help
      // text, so in practice the mode was one-way.
      case 'g': this.toggleGearMode(); break;
      default: break;
    }
    // Manual gears on the number keys. A digit now says "manual, this gear"
    // rather than silently latching a value that outlives the press: the mode is
    // explicit, it is on screen, and G or 0 leaves it.
    if (k >= '1' && k <= '8') this.selectGear(Number(k));
    if (k === '0') this.setGearMode('auto');
  }

  /**
   * Asks for a gear, entering manual if the car was not already there.
   *
   * The single entry point for every manual selection — number keys here, and
   * the paddles, which `main.ts` resolves against the gear the gearbox is
   * actually in. A paddle meaning "manual from now on" is the deliberate choice
   * (issue #45 point 3): there is no automatic gearbox in the real sport, so a
   * driver who takes a paddle has taken the gearbox. It is only defensible
   * because the HUD now says MANUAL and G gives it back.
   */
  selectGear(gear: number): void {
    this.gearMode = 'manual';
    this.gearRequest = clamp(Math.round(gear), 1, 8);
  }

  setGearMode(mode: 'auto' | 'manual'): void {
    this.gearMode = mode;
    if (mode === 'auto') this.gearRequest = 0;
  }

  /**
   * Flips between the two, keeping the gear the car is in.
   *
   * Going manual with `gearRequest` left at 0 would publish an automatic request
   * while the HUD said MANUAL, which is the disagreement between display and
   * behaviour this whole change exists to remove. So it asks for the gear it was
   * last in, or first if it has never been in one — and asking for first at
   * 300 km/h is safe because `VehiclePhysics.updateGearbox` raises any request
   * to the lowest gear that will not over-rev the engine.
   */
  toggleGearMode(): void {
    if (this.gearMode === 'manual') this.setGearMode('auto');
    else this.selectGear(this.gearRequest > 0 ? this.gearRequest : 1);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key.toLowerCase());
    this.syncHolds(stampOf(e, this.timeSourceMs));
  }

  /**
   * Brings the hold clocks into line with the keys that are down.
   *
   * Driven off the key set rather than off the individual event, so that the two
   * keys bound to one control (Left and A) behave as one control: releasing A
   * while Left is still down does not stop the clock.
   *
   * The brake is tracked as its own keys only. `ArrowDown` is a separate clock
   * because whether it means "brake" or "reverse" depends on road speed, which
   * an event handler has no business knowing; `update` composes the two.
   */
  private syncHolds(tMs: number): void {
    const kb = this.keys;
    const set = (c: HoldClock, on: boolean): void => { if (on) c.press(tMs); else c.release(tMs); };
    set(this.holds.left, kb.has('a') || kb.has('arrowleft'));
    set(this.holds.right, kb.has('d') || kb.has('arrowright'));
    set(this.holds.throttle, kb.has('w') || kb.has('arrowup'));
    set(this.holds.brake, kb.has('b') || kb.has(' ') || kb.has('s'));
    set(this.holds.down, kb.has('arrowdown'));
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    // gamma is the left-right tilt in degrees when the phone is held in
    // landscape. It is the only axis that maps naturally to steering.
    if (e.gamma === null) return;
    this.tiltGamma = e.gamma;
    if (!this.tiltCalibrated) {
      this.config.tiltNeutralDeg = e.gamma;
      this.tiltCalibrated = true;
    }
    this.lastSource = 'tilt';
  }

  private zoneFor(nx: number, ny: number): ActiveTouch['role'] {
    if (inZone(TOUCH_ZONES.throttle, nx, ny)) return 'throttle';
    if (inZone(TOUCH_ZONES.brake, nx, ny)) return 'brake';
    if (inZone(TOUCH_ZONES.drs, nx, ny)) return 'drs';
    if (inZone(TOUCH_ZONES.ers, nx, ny)) return 'ers';
    if (inZone(TOUCH_ZONES.steer, nx, ny)) return 'steer';
    return 'none';
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    this.lastSource = this.tiltEnabled ? 'tilt' : 'touch';
    const rect = (this.element as HTMLElement).getBoundingClientRect();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const nx = (t.clientX - rect.left) / rect.width;
      const ny = (t.clientY - rect.top) / rect.height;
      const role = this.zoneFor(nx, ny);

      this.touches.set(t.identifier, {
        id: t.identifier, role,
        startX: t.clientX, startY: t.clientY,
        x: t.clientX, y: t.clientY,
      });

      if (role === 'steer' && !this.tiltEnabled) {
        // The joystick centre is wherever the thumb landed. A fixed-position
        // stick forces the player to look at the screen to find it.
        this.joystickActive = true;
        this.joystickCentreX = t.clientX;
        this.joystickCentreY = t.clientY;
        this.joystickX = t.clientX;
        this.joystickY = t.clientY;
      } else if (role === 'drs') {
        this.drsHeld = true;
      } else if (role === 'ers') {
        this.cycleErsMode();
      }
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const active = this.touches.get(t.identifier);
      if (!active) continue;
      active.x = t.clientX;
      active.y = t.clientY;
      if (active.role === 'steer' && !this.tiltEnabled) {
        this.joystickX = t.clientX;
        this.joystickY = t.clientY;
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const active = this.touches.get(t.identifier);
      if (!active) continue;
      if (active.role === 'steer') this.joystickActive = false;
      if (active.role === 'drs') this.drsHeld = false;
      this.touches.delete(t.identifier);
    }
  }

  private cycleErsMode(): void {
    const order: ErsMode[] = ['harvest', 'balanced', 'push', 'overtake'];
    const i = order.indexOf(this.ersMode);
    this.ersMode = order[(i + 1) % order.length];
  }

  // =========================================================================
  // Per-frame resolution
  // =========================================================================

  /**
   * Resolves every source into the unified targets, then into `out`.
   *
   * @param dt      real frame time, seconds
   * @param speedMs current car speed, for speed-sensitive steering
   * @param brakeLimit pedal fraction at which the fronts lock (for the assist)
   * @param tractionLimit pedal fraction at which the rears spin (for the assist)
   */
  update(
    dt: number,
    out: VehicleControls,
    speedMs: number,
    brakeLimit: number,
    tractionLimit: number,
  ): void {
    // --- Gamepad, polled rather than event-driven ---------------------------
    //
    // Everything here now goes through the device's PROFILE rather than through
    // a fixed mapping. That is the whole difference between supporting "a
    // gamepad" and supporting the player's gamepad: the profile knows that this
    // device's throttle is button 7 resting at 0 or axis 2 resting at +1, and
    // the code below does not have to.
    let gamepadSteer = 0;
    let gamepadThrottle = 0;
    let gamepadBrake = 0;
    let gamepadActive = false;
    let padDrs = false;
    let padReverse = false;

    const pad = this.gamepadSuspended ? null : this.gamepads.activePad();
    const profile = pad ? this.gamepads.profileFor(this.gamepadSettings) : null;

    if (pad && profile) {
      gamepadSteer = applySteerCurve(steerValue(pad, profile.axes.steer), profile.steer);
      gamepadThrottle = pedalValue(pad, profile.axes.throttle);
      gamepadBrake = pedalValue(pad, profile.axes.brake);

      if (Math.abs(gamepadSteer) > 0.001 || gamepadThrottle > 0.01 || gamepadBrake > 0.01) {
        gamepadActive = true;
        this.lastSource = 'gamepad';
      }

      // Every action's held state is sampled once, so the edge map stays in
      // step even for actions nothing is bound to. Sampling only the ones being
      // acted on would leave a stale `true` behind and swallow the next press.
      for (const action of BUTTON_ACTIONS) {
        const now = buttonPressed(pad, profile.buttons[action]);
        const was = this.padHeld.get(action) ?? false;
        this.padHeld.set(action, now);
        const pressed = now && !was;
        if (pressed) this.lastSource = 'gamepad';

        switch (action) {
          case 'drs': padDrs = now; break;
          // Reverse, like the keyboard's Down, only once the car is genuinely
          // stopped — selecting reverse at speed is not a thing a car does.
          case 'reverse': padReverse = now && speedMs < 1.6; break;
          case 'camera': if (pressed) this.cameraCyclePressed = true; break;
          case 'ers': if (pressed) this.cycleErsMode(); break;
          case 'pit': if (pressed) this.pitRequestToggled = true; break;
          case 'pitTyre': if (pressed) this.pitTyreCyclePressed = true; break;
          case 'pitRepair': if (pressed) this.pitRepairTogglePressed = true; break;
          case 'pitConfirm': if (pressed) this.pitConfirmPressed = true; break;
          case 'pause': if (pressed) this.pausePressed = true; break;
          case 'shiftUp': if (pressed) this.shiftUpPressed = true; break;
          case 'shiftDown': if (pressed) this.shiftDownPressed = true; break;
        }
      }
    } else {
      this.padHeld.clear();
    }

    // --- Keyboard -----------------------------------------------------------
    //
    // Layout:
    //   Up / W        accelerate
    //   B / Space / S brake
    //   Down          brake while moving forward, then REVERSE once stopped
    //   Left / Right  steer
    //
    // Down doing double duty is deliberate: it is the intuitive key to press when
    // you want to stop or back out of a gravel trap, and which of the two you meant
    // is unambiguous from whether the car is still moving.
    // Which keys are down still decides what the controls MEAN — reverse, DRS.
    // How much pedal or lock they have bought is no longer read from here but
    // from the hold clocks, which know how long each has been down rather than
    // merely that it is down on the frame that happened to look.
    const kb = this.keys;
    const kbDownArrow = kb.has('arrowdown');
    const kbDrs = kb.has('shift');

    // Reverse only once genuinely stopped, and only while Down is held.
    //
    // The pad's reverse is OR-ed in rather than overwritten. It used to be
    // assigned here unconditionally, a line after the gamepad block had just
    // set it — so the controller's reverse button was erased on every single
    // frame and had never once worked.
    const nearlyStopped = speedMs < 1.6;
    this.reverseHeld = (kbDownArrow && nearlyStopped) || padReverse;
    // DRS is a held control on three different devices. Touch owns the flag
    // directly through its own handlers, so only clear it when the last input
    // actually came from a device represented here.
    if (kbDrs || padDrs) this.drsHeld = true;
    else if (this.lastSource === 'keyboard' || this.lastSource === 'gamepad') this.drsHeld = false;

    // --- Touch --------------------------------------------------------------
    let touchSteer = 0;
    let touchThrottle = 0;
    let touchBrake = 0;
    this.throttleHeld = false;
    this.brakeHeld = false;

    for (const t of this.touches.values()) {
      if (t.role === 'steer' && !this.tiltEnabled) {
        // Progressive steering from thumb displacement, not a binary press.
        touchSteer = clamp((t.x - this.joystickCentreX) / this.joystickRadiusPx, -1, 1);
      } else if (t.role === 'throttle') {
        // Sliding a thumb up the throttle zone gives partial throttle, which
        // makes a slow corner exit controllable on a touchscreen.
        this.throttleHeld = true;
        touchThrottle = 1;
      } else if (t.role === 'brake') {
        this.brakeHeld = true;
        touchBrake = 1;
      }
    }

    // --- Tilt ---------------------------------------------------------------
    let tiltSteer = 0;
    if (this.tiltEnabled) {
      const delta = this.tiltGamma - this.config.tiltNeutralDeg;
      const raw = delta / Math.max(this.config.tiltFullLockDeg, 1);
      // Squared response keeps small corrections gentle while leaving full lock
      // reachable; linear tilt steering is unusably twitchy.
      const sign = Math.sign(raw);
      const mag = clamp01(Math.abs(raw));
      tiltSteer = sign * mag * mag * (this.config.tiltInvert ? -1 : 1);
    }

    // --- Resolve into the unified targets ----------------------------------
    // Analogue sources are authoritative when present; digital sources ramp.
    if (gamepadActive) {
      // The rate limit is the one piece of shaping that cannot live in the
      // profile maths, because it is a limit on how fast the value may CHANGE
      // and so needs the previous frame and the frame time. Zero means off,
      // which is the default and reproduces the old direct assignment exactly.
      const rate = profile?.steer.rateLimit ?? 0;
      this.targetSteer = rate > 0
        ? moveToward(this.targetSteer, gamepadSteer, rate * dt)
        : gamepadSteer;
      this.targetThrottle = gamepadThrottle;
      this.targetBrake = gamepadBrake;
    } else if (this.tiltEnabled || this.touches.size > 0) {
      this.targetSteer = this.tiltEnabled ? tiltSteer : damp(this.targetSteer, touchSteer, 18, dt);
      this.targetThrottle = moveToward(this.targetThrottle, touchThrottle, this.config.keyboardThrottleRate * dt);
      this.targetBrake = moveToward(this.targetBrake, touchBrake, this.config.keyboardBrakeRate * dt);
    } else {
      // Keyboard: ramp toward the held direction, spring back to centre — by the
      // time each control was actually DOWN inside this frame, not by the frame
      // time. See HoldClock for the measurement that made this necessary.
      const now = this.timeSourceMs();
      // Clamped into the frame so the three portions partition `dt` exactly and
      // no ramp can outrun the frame it belongs to. Without the clamp a first
      // frame, a resumed tab or a drifting time source could hand over a hold
      // longer than the frame and snap the wheel to full lock.
      const held = (c: HoldClock): number => clamp(c.consumeS(now), 0, dt);
      const tRight = held(this.holds.right);
      const tLeft = held(this.holds.left);
      const tThrottle = held(this.holds.throttle);
      const tBrakeKey = held(this.holds.brake);
      const tDownArrow = held(this.holds.down);
      // Down doubles as the brake while the car is still rolling. The union of
      // the two is capped at the frame, which is exact whenever only one of them
      // is down and never over-credits when both are.
      const tBrake = nearlyStopped ? tBrakeKey : Math.min(dt, tBrakeKey + tDownArrow);
      // Whatever is left of the frame, the wheel is unattended and returning.
      const tCentre = Math.max(0, dt - tRight - tLeft);

      // The two portions of a frame are applied in the order they HAPPENED. A
      // key that is still down at the end went down partway through, so the
      // frame reads "centring, then lock"; one that is up went up partway
      // through, so it reads "lock, then centring". See HoldClock.isDown — the
      // wrong order erases a short press entirely rather than rounding it.
      const steerRate = this.config.keyboardSteerRate;
      const ramp = (): void => {
        if (tRight > 0) this.targetSteer = moveToward(this.targetSteer, 1, steerRate * tRight);
        if (tLeft > 0) this.targetSteer = moveToward(this.targetSteer, -1, steerRate * tLeft);
      };
      const centre = (): void => {
        if (tCentre > 0) {
          this.targetSteer = moveToward(this.targetSteer, 0, this.config.keyboardCentreRate * tCentre);
        }
      };
      if (this.holds.right.isDown || this.holds.left.isDown) { centre(); ramp(); }
      else { ramp(); centre(); }

      /** One pedal, same chronological ordering. */
      const pedal = (cur: number, tHeld: number, rate: number, downAtEnd: boolean): number => {
        const tOff = Math.max(0, dt - tHeld);
        if (downAtEnd) {
          return moveToward(moveToward(cur, 0, rate * tOff), 1, rate * tHeld);
        }
        return moveToward(moveToward(cur, 1, rate * tHeld), 0, rate * tOff);
      };
      const brakeDownAtEnd = this.holds.brake.isDown
        || (this.holds.down.isDown && !nearlyStopped);
      this.targetThrottle = pedal(
        this.targetThrottle, tThrottle, this.config.keyboardThrottleRate, this.holds.throttle.isDown,
      );
      this.targetBrake = pedal(
        this.targetBrake, tBrake, this.config.keyboardBrakeRate, brakeDownAtEnd,
      );
    }

    // --- Steering assist ----------------------------------------------------
    // Real steering racks are geared so full lock at speed is not available.
    // Applying it here rather than in the physics keeps the vehicle model honest
    // and makes the assist something the player can turn off.
    let steer = clamp(this.targetSteer, -1, 1);
    if (this.config.speedSensitiveSteering) {
      // Gentle, and deliberately much weaker than it looks like it should be.
      //
      // VehiclePhysics ALREADY applies a speed-sensitive limit to the steering
      // rack. Applying a second reduction here multiplies with that one: at
      // 300 km/h the two compounded to 0.66 x 0.32 = 21% of full lock, about
      // five degrees at the road wheel, and the car felt like it simply would
      // not turn. This now only takes the last of the twitchiness off the
      // keyboard's instant full-deflection input.
      const scale = 1 - clamp01((speedMs - 30) / 100) * 0.12;
      steer *= scale;
    }

    // --- Optional assists ---------------------------------------------------
    let throttle = clamp01(this.targetThrottle);
    let brake = clamp01(this.targetBrake);
    if (this.config.tractionAssist) throttle = Math.min(throttle, tractionLimit * 1.02);
    if (this.config.brakingAssist) brake = Math.min(brake, brakeLimit * 0.99);

    out.steer = steer;
    out.throttle = throttle;
    out.brake = brake;
    out.drsRequested = this.drsHeld;
    out.ersMode = this.ersMode;
    // 0 is "automatic", and it is published from the MODE rather than from the
    // number. Publishing the raw number is what made the old request a latch:
    // once written it was never unwritten, because nothing but a key press could
    // change it and the only key that could was undiscoverable.
    out.gearRequest = this.gearMode === 'manual' ? this.gearRequest : 0;
    out.reverse = this.reverseHeld || this.reverseTouchHeld;
    // Reversing needs pedal input; Down alone should be enough to actually move.
    if (out.reverse && out.throttle < 0.35 && out.brake < 0.35) out.brake = 0.6;
    // pitLimiter is owned by the race engine, which knows where the pit lane is.
  }

  /** Clears one-frame edge flags. Call at the end of each frame. */
  endFrame(): void {
    this.cameraCyclePressed = false;
    this.helpToggled = false;
    this.racingLineToggled = false;
    this.pausePressed = false;
    this.pitRequestToggled = false;
    this.pitTyreCyclePressed = false;
    this.pitRepairTogglePressed = false;
    this.pitConfirmPressed = false;
    this.shiftUpPressed = false;
    this.shiftDownPressed = false;
  }

  /**
   * Drives the controller's rumble from what the car is doing.
   *
   * The inputs are the physics' own outputs, not invented effects, so what the
   * hands feel and what the camera shakes to are the same signal:
   *
   *  - `vibration` is the high-frequency term the tyre model produces on kerbs,
   *    grass and gravel. It goes to the STRONG (low-frequency) motor, because a
   *    kerb strike is a thump.
   *  - a lock-up is a distinct, sharper buzz on the weak motor. A driver feels
   *    a locked front through the wheel long before the tyre smoke appears, and
   *    it is the single most useful thing haptics can tell you in a braking zone.
   *  - wheelspin gets a lighter version of the same on corner exit.
   *
   * Everything degrades silently: a device with no actuator, or a browser that
   * has not implemented one, simply produces no calls. Nothing above this line
   * checks whether it worked.
   */
  updateForceFeedback(
    vibration: number,
    wheelsLocked: boolean,
    wheelSpin: number,
    speedMs: number,
  ): void {
    const settings = this.gamepadSettings;
    if (!settings.forceFeedback || settings.ffbStrength <= 0) return;
    if (this.gamepadSuspended || this.lastSource !== 'gamepad') return;
    if (!this.gamepads.hasRumble) return;

    // Below walking pace there is nothing to feel, and a stationary car buzzing
    // in the garage is just noise.
    const moving = clamp01(speedMs / 6);
    const strong = clamp01(Math.abs(vibration)) * 0.85 * moving;
    const lock = wheelsLocked ? 0.7 : 0;
    const spin = clamp01(wheelSpin) * 0.45;
    const weak = clamp01(Math.max(lock, spin)) * moving;

    const g = settings.ffbStrength;
    this.gamepads.rumble(strong * g, weak * g);
  }

  /** Stops any rumble in progress. Called when a session ends. */
  stopForceFeedback(): void {
    this.gamepads.stopRumble();
  }

  /** Normalised joystick displacement, for the overlay. */
  get joystickOffset(): { x: number; y: number; radius: number } {
    return {
      x: this.joystickX - this.joystickCentreX,
      y: this.joystickY - this.joystickCentreY,
      radius: this.joystickRadiusPx,
    };
  }

  /** True when the on-screen touch controls should be shown. */
  get showTouchOverlay(): boolean {
    return this.touchAvailable && (this.lastSource === 'touch' || this.lastSource === 'tilt');
  }
}

/**
 * When an event actually happened, in milliseconds on the `performance.now()`
 * clock.
 *
 * `KeyboardEvent.timeStamp` is a DOMHighResTimeStamp on the same origin as
 * `performance.now()`, and it is the time the event was CREATED rather than the
 * time the handler ran. That distinction is the whole reason to prefer it: when
 * the main thread is busy — which on this game means a frame that took 50ms to
 * render — events queue and are dispatched late, all together. Reading the clock
 * inside the handler would time them all at the moment the thread came free and
 * report a press that lasted 90ms as one that lasted nothing.
 *
 * Falls back to the live clock for synthetic events that carry no stamp.
 */
function stampOf(e: { timeStamp?: number }, fallback: () => number): number {
  const t = e.timeStamp;
  // `>= 0`, not `> 0`. Zero is a legitimate instant on a simulated clock, and
  // rejecting it sent the very first press of a probe run down the fallback path
  // — which is the frame boundary, i.e. exactly the quantisation being measured.
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : fallback();
}

/** Keys the game consumes, so everything else reaches the browser. */
/**
 * Is this event aimed at somewhere the player is typing?
 *
 * `contentEditable` is checked as well as the tag, because an inline-edit field
 * has no distinguishing tag name, and `<select>` counts too — it consumes
 * letter keys to jump between options.
 *
 * Duck-typed rather than `instanceof HTMLElement`. This module is driven
 * headlessly by `probe:framerate` and `validate:gamepad` against a DOM stub
 * where the `HTMLElement` global does not exist, so an `instanceof` test throws
 * a `ReferenceError` on the first synthetic keystroke and takes the probe with
 * it. Reading the two fields we actually care about works in both worlds.
 *
 * Deliberately NOT keyed off `document.activeElement`: the event's own target
 * is the element the browser is about to deliver the character to, and reading
 * global focus instead would be a second source of truth that can disagree with
 * it mid focus change.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || el.isContentEditable === true;
}

const GAME_KEYS = new Set([
  'w', 'a', 's', 'd', 'b', 'h', ' ', 'c', 'p', 'e', 'l', 'shift', 'escape',
  't', 'f', 'g', 'enter',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  '0', '1', '2', '3', '4', '5', '6', '7', '8',
]);

/**
 * What to print on the pit sheet so the controls are discoverable.
 *
 * Keyed off the device the player last actually used, because a hint that says
 * `T` to somebody holding a controller is a hint that costs them the stop. The
 * gamepad's labels come out of the live profile rather than out of a table, so
 * a rebound button reads as the button it is now on.
 */
export interface PitBindingHints {
  tyre: string;
  repair: string;
  confirm: string;
  cancel: string;
}

export function pitBindingHints(
  source: InputSource, describe: (a: ButtonAction) => string,
): PitBindingHints {
  if (source === 'gamepad') {
    return {
      tyre: describe('pitTyre'),
      repair: describe('pitRepair'),
      confirm: describe('pitConfirm'),
      cancel: describe('pit'),
    };
  }
  if (source === 'touch' || source === 'tilt') {
    return { tyre: 'Tap', repair: 'Tap', confirm: 'Tap', cancel: 'PIT' };
  }
  return { tyre: 'T', repair: 'F', confirm: 'ENTER', cancel: 'L' };
}
