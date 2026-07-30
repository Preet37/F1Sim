import { clamp, clamp01, damp, moveToward } from '../core/MathUtils';
import type { ErsMode, VehicleControls } from '../physics/VehiclePhysics';

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
  /** Deadzone applied to analogue sticks. */
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
  keyboardBrakeRate: 6.5,
  gamepadDeadzone: 0.09,
  tiltFullLockDeg: 26,
  tiltNeutralDeg: 0,
  tiltInvert: false,
  speedSensitiveSteering: true,
  tractionAssist: false,
  brakingAssist: false,
};

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
  /** Manual gear request, 0 for automatic. */
  gearRequest = 0;
  /** Set for one frame when the player asks to pit. */
  pitRequestToggled = false;

  /** Which source produced the most recent meaningful input. */
  lastSource: InputSource = 'keyboard';
  /** True when a touch device has been detected. */
  touchAvailable = false;
  /** True when device orientation is available and permitted. */
  tiltAvailable = false;
  /** True when tilt steering is the active steering source. */
  tiltEnabled = false;

  /** Live joystick state, for the on-screen overlay to draw. */
  joystickActive = false;
  joystickCentreX = 0;
  joystickCentreY = 0;
  joystickX = 0;
  joystickY = 0;
  throttleHeld = false;
  brakeHeld = false;

  private readonly keys = new Set<string>();
  private readonly touches = new Map<number, ActiveTouch>();
  private element: HTMLElement | null = null;
  private tiltGamma = 0;
  private tiltCalibrated = false;
  private cameraLatch = false;

  /** Joystick travel, in pixels, that corresponds to full lock. */
  private joystickRadiusPx = 90;

  private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private boundKeyUp = (e: KeyboardEvent) => this.onKeyUp(e);
  private boundBlur = () => this.keys.clear();
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
    const k = e.key.toLowerCase();
    // Only swallow keys the game actually uses, so browser shortcuts still work.
    if (GAME_KEYS.has(k) || GAME_KEYS.has(e.code)) e.preventDefault();
    if (this.keys.has(k)) return;
    this.keys.add(k);
    this.lastSource = 'keyboard';

    switch (k) {
      case 'c': this.cameraCyclePressed = true; break;
      case 'h': this.helpToggled = true; break;
      case 'r': this.racingLineToggled = true; break;
      case 'p': case 'escape': this.pausePressed = true; break;
      case 'e': this.cycleErsMode(); break;
      case 'l': this.pitRequestToggled = true; break;
      default: break;
    }
    // Manual gears on the number keys, for players who want them.
    if (k >= '1' && k <= '8') this.gearRequest = Number(k);
    if (k === '0') this.gearRequest = 0;
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key.toLowerCase());
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
    let gamepadSteer = 0;
    let gamepadThrottle = 0;
    let gamepadBrake = 0;
    let gamepadActive = false;

    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dz = this.config.gamepadDeadzone;
      const lx = applyDeadzone(pad.axes[0] ?? 0, dz);
      // Triggers are buttons 6 and 7 on the standard mapping, with analogue
      // values; the axes fallback covers pads that report them as axes instead.
      const rt = pad.buttons[7]?.value ?? Math.max(0, pad.axes[5] ?? 0);
      const lt = pad.buttons[6]?.value ?? Math.max(0, pad.axes[4] ?? 0);

      if (Math.abs(lx) > 0.001 || rt > 0.01 || lt > 0.01) {
        gamepadActive = true;
        gamepadSteer = lx;
        gamepadThrottle = rt;
        gamepadBrake = lt;
        this.lastSource = 'gamepad';
      }
      // Face buttons: A/cross for DRS, B/circle for reverse, Y for camera.
      if (pad.buttons[0]?.pressed) this.drsHeld = true;
      else if (this.lastSource === 'gamepad') this.drsHeld = false;
      if (pad.buttons[1]?.pressed && speedMs < 1.6) this.reverseHeld = true;
      if (pad.buttons[3]?.pressed && !this.cameraLatch) {
        this.cameraCyclePressed = true;
        this.cameraLatch = true;
      } else if (!pad.buttons[3]?.pressed) {
        this.cameraLatch = false;
      }
      break;
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
    const kb = this.keys;
    const kbLeft = kb.has('a') || kb.has('arrowleft');
    const kbRight = kb.has('d') || kb.has('arrowright');
    const kbUp = kb.has('w') || kb.has('arrowup');
    const kbBrake = kb.has('b') || kb.has(' ') || kb.has('s');
    const kbDownArrow = kb.has('arrowdown');
    const kbDrs = kb.has('shift');

    // Reverse only once genuinely stopped, and only while Down is held.
    const nearlyStopped = speedMs < 1.6;
    this.reverseHeld = kbDownArrow && nearlyStopped;
    // Down brakes whenever the car is still rolling.
    const kbDown = kbBrake || (kbDownArrow && !nearlyStopped);
    if (kbDrs) this.drsHeld = true;
    else if (this.lastSource === 'keyboard') this.drsHeld = false;

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
      this.targetSteer = gamepadSteer;
      this.targetThrottle = gamepadThrottle;
      this.targetBrake = gamepadBrake;
    } else if (this.tiltEnabled || this.touches.size > 0) {
      this.targetSteer = this.tiltEnabled ? tiltSteer : damp(this.targetSteer, touchSteer, 18, dt);
      this.targetThrottle = moveToward(this.targetThrottle, touchThrottle, this.config.keyboardThrottleRate * dt);
      this.targetBrake = moveToward(this.targetBrake, touchBrake, this.config.keyboardBrakeRate * dt);
    } else {
      // Keyboard: ramp toward the held direction, spring back to centre.
      const dir = (kbRight ? 1 : 0) - (kbLeft ? 1 : 0);
      if (dir !== 0) {
        this.targetSteer = moveToward(this.targetSteer, dir, this.config.keyboardSteerRate * dt);
      } else {
        this.targetSteer = moveToward(this.targetSteer, 0, this.config.keyboardCentreRate * dt);
      }
      this.targetThrottle = moveToward(this.targetThrottle, kbUp ? 1 : 0, this.config.keyboardThrottleRate * dt);
      this.targetBrake = moveToward(this.targetBrake, kbDown ? 1 : 0, this.config.keyboardBrakeRate * dt);
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
    out.gearRequest = this.gearRequest;
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

function applyDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  // Rescale so the usable range still reaches 1.0 rather than 1-dz.
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Keys the game consumes, so everything else reaches the browser. */
const GAME_KEYS = new Set([
  'w', 'a', 's', 'd', 'b', 'h', ' ', 'c', 'p', 'e', 'l', 'shift', 'escape',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  '0', '1', '2', '3', '4', '5', '6', '7', '8',
]);
