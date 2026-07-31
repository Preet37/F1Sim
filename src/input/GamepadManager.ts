import {
  autoProfileFor, classifyPad, signatureOf,
  type DeviceClass, type GamepadLike, type GamepadProfile, type GamepadSettings,
} from './GamepadProfile';

/**
 * The bridge between the Gamepad API and the profile layer.
 *
 * Everything browser-shaped lives here: enumeration, hotplug, choosing which of
 * several devices is the live one, and rumble. `GamepadProfile` stays pure so it
 * can be tested without a browser; this file is the part that cannot be.
 *
 * Two things about the Gamepad API make this less trivial than it looks.
 *
 *  1. IT IS POLLED, NOT EVENT-DRIVEN. `navigator.getGamepads()` returns a fresh
 *     snapshot array every call and the objects in it are NOT live — holding a
 *     reference to a `Gamepad` and reading it next frame gives stale values in
 *     some engines. So the pad is re-fetched every poll, never cached.
 *
 *  2. IT LIES ABOUT AVAILABILITY. Until a device has been touched, some browsers
 *     report nothing at all: no gamepadconnected event, an empty array. There is
 *     no fix for that other than saying so on the screen, which is why the
 *     controller page tells the player to press a button if it sees nothing.
 */

export interface PadInfo {
  index: number;
  id: string;
  signature: string;
  axes: number;
  buttons: number;
  mapping: string;
  cls: DeviceClass;
}

/** Structural view of the vibration actuator, which TS does not ship types for. */
interface VibrationActuatorLike {
  playEffect?: (type: string, params: Record<string, number>) => Promise<string>;
  reset?: () => Promise<string>;
  type?: string;
}

type PadWithActuator = Gamepad & {
  vibrationActuator?: VibrationActuatorLike;
  hapticActuators?: VibrationActuatorLike[];
};

export class GamepadManager {
  /** Signature of the device the player has chosen, '' for "first connected". */
  preferredSignature = '';

  /** Fired when a device appears or disappears, so a screen can redraw. */
  onDevicesChanged: (() => void) | null = null;

  /** True once any gamepad has ever been seen this session. */
  seenAny = false;

  private lastFeedbackAt = 0;
  private lastFeedbackMagnitude = 0;
  private rumbleFailed = false;

  private boundConnected = (e: Event) => this.onHotplug(e);
  private boundDisconnected = (e: Event) => this.onHotplug(e);

  attach(): void {
    window.addEventListener('gamepadconnected', this.boundConnected);
    window.addEventListener('gamepaddisconnected', this.boundDisconnected);
  }

  detach(): void {
    window.removeEventListener('gamepadconnected', this.boundConnected);
    window.removeEventListener('gamepaddisconnected', this.boundDisconnected);
  }

  private onHotplug(_e: Event): void {
    this.rumbleFailed = false;
    this.onDevicesChanged?.();
  }

  /** Every connected device, in enumeration order. */
  list(): PadInfo[] {
    const out: PadInfo[] = [];
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      this.seenAny = true;
      out.push({
        index: pad.index,
        id: pad.id,
        signature: signatureOf(pad),
        axes: pad.axes.length,
        buttons: pad.buttons.length,
        mapping: pad.mapping,
        cls: classifyPad(pad),
      });
    }
    return out;
  }

  /**
   * The device the game is currently reading.
   *
   * Preference wins when it is plugged in; otherwise the first connected device
   * does, so unplugging the wheel does not leave the player with no controller
   * at all when a pad is sitting right there.
   */
  activePad(): GamepadLike | null {
    const pads = navigator.getGamepads?.() ?? [];
    let first: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      this.seenAny = true;
      if (!first) first = pad;
      if (this.preferredSignature && signatureOf(pad) === this.preferredSignature) return pad;
    }
    return first;
  }

  /** The raw `Gamepad`, for the things only it can do. */
  private activeNative(): PadWithActuator | null {
    const pads = navigator.getGamepads?.() ?? [];
    let first: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (!first) first = pad;
      if (this.preferredSignature && signatureOf(pad) === this.preferredSignature) return pad as PadWithActuator;
    }
    return first as PadWithActuator | null;
  }

  /**
   * The profile for the active device, creating and storing one if this is the
   * first time the device has been seen.
   *
   * Returns null when nothing is plugged in, which the input layer treats as
   * "there is no gamepad", not as "use a default profile" — reading a profile
   * against no device would produce a steering value out of thin air.
   */
  profileFor(settings: GamepadSettings): GamepadProfile | null {
    const pad = this.activePad();
    if (!pad) return null;
    const sig = signatureOf(pad);
    let profile = settings.profiles[sig];
    if (!profile) {
      profile = autoProfileFor(pad);
      settings.profiles[sig] = profile;
    }
    return profile;
  }

  /** The profile for a named device, creating it if the device is present. */
  profileForSignature(settings: GamepadSettings, signature: string): GamepadProfile | null {
    const existing = settings.profiles[signature];
    if (existing) return existing;
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (signatureOf(pad) === signature) {
        const p = autoProfileFor(pad);
        settings.profiles[signature] = p;
        return p;
      }
    }
    return null;
  }

  // =========================================================================
  // Rumble
  // =========================================================================

  /** True when the active device can vibrate. */
  get hasRumble(): boolean {
    const pad = this.activeNative();
    if (!pad || this.rumbleFailed) return false;
    if (typeof pad.vibrationActuator?.playEffect === 'function') return true;
    return Array.isArray(pad.hapticActuators) && pad.hapticActuators.length > 0;
  }

  /**
   * Plays a rumble effect.
   *
   * Rate-limited to about 14Hz and only re-issued when the magnitude actually
   * moves, because `playEffect` returns a promise and firing one every animation
   * frame queues effects faster than the device consumes them — which shows up
   * as latency that grows the longer you drive, and eventually as a controller
   * that buzzes a second behind the car.
   *
   * Every failure path is swallowed. A device with no actuator, a browser that
   * has not implemented the API, and a page that has lost user activation all
   * throw or reject here, and none of them is a reason to interrupt a race.
   */
  rumble(strong: number, weak: number, durationMs = 110, now = performance.now()): void {
    const pad = this.activeNative();
    if (!pad || this.rumbleFailed) return;

    const magnitude = Math.max(strong, weak);
    const changed = Math.abs(magnitude - this.lastFeedbackMagnitude) > 0.06;
    if (now - this.lastFeedbackAt < 70 && !changed) return;
    // Stopping is worth a call; staying silent is not.
    if (magnitude < 0.02 && this.lastFeedbackMagnitude < 0.02) return;

    this.lastFeedbackAt = now;
    this.lastFeedbackMagnitude = magnitude;

    const actuator = pad.vibrationActuator ?? pad.hapticActuators?.[0];
    if (!actuator?.playEffect) return;
    try {
      const p = actuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: Math.max(20, durationMs),
        strongMagnitude: Math.min(Math.max(strong, 0), 1),
        weakMagnitude: Math.min(Math.max(weak, 0), 1),
      });
      // A rejected promise here means the device does not support the effect
      // type. Stop asking rather than logging once per frame forever.
      void p?.catch?.(() => { this.rumbleFailed = true; });
    } catch {
      this.rumbleFailed = true;
    }
  }

  /** Stops any effect in progress. Used when a session ends. */
  stopRumble(): void {
    const pad = this.activeNative();
    const actuator = pad?.vibrationActuator ?? pad?.hapticActuators?.[0];
    this.lastFeedbackMagnitude = 0;
    try {
      void actuator?.reset?.()?.catch?.(() => {});
    } catch {
      // Nothing to do; the effect will time out on its own.
    }
  }
}
