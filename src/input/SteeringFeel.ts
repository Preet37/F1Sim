/**
 * Keyboard steering feel — the named candidates, and which one ships.
 *
 * WHY THIS FILE EXISTS. Issue #46 established, by measurement on merged `main`,
 * that the swerve the player reports is in the INPUT PATH and not in the car.
 * Every open-loop measurement of the vehicle passes; the same pure-pursuit
 * driver holding the same 2.0g corner at 200 km/h wanders 7.67m through the keys
 * and 0.12m with a wheel — 62x — and at 2.6g/280 km/h the keyboard arm leaves
 * the road entirely.
 *
 * The mechanism is an ASYMMETRY. The wheel winds on at 3.4 units/s while a key
 * is down and springs back at 5.5 units/s the instant it is released, so a
 * corner needing a steady 0.253 of lock cannot be held: it becomes a 0.00-0.71
 * sawtooth at about 8 Hz, and the amplitude of that sawtooth is what the player
 * feels as the car gliding and darting.
 *
 * There are three ways to attack it and they are not the same trade, so this
 * file holds all three as named presets rather than picking one silently. Every
 * number below was measured by `probe:steeringfeel` against the same rig
 * (`scripts/lib/keyboardRig.ts`) on the same lanes `probe:handling` §5 uses.
 *
 *   1. SLOW THE RETURN (`keyboardCentreRate`, swept 5.5 / 4.5 / 3.4 / 2.8 / 2.2).
 *      Attacks the asymmetry directly and leaves turn-in untouched. Its cost is
 *      NOT the flick, which was the expected answer and is wrong: pressing the
 *      other key ramps straight through centre at the rack rate and never
 *      consults the return rate at all, so a full direction change is 367ms
 *      whether the return is 5.5 or 2.2. What it costs is LETTING GO — unwinding
 *      from full lock with no key down goes 183ms -> 367ms at 2.8 and 450ms at
 *      2.2.
 *   2. SLOW THE RAMP (`keyboardSteerRate`, swept 3.4 / 2.8 / 2.2 / 1.7). Heavier,
 *      more predictable steering. Charged on EVERY input: at 2.2 the flick goes
 *      367ms -> 567ms and the chicane goes through the wander bar. It is the only
 *      one of the three that made the closed loop WORSE at every rate.
 *   3. PUBLISH THE MEAN. Hand the physics the time-weighted mean lock across the
 *      frame instead of the value the frame ended on. Costs 16ms on the flick and
 *      nothing on turn-in — and it is the only candidate that fixes the deleted
 *      30ms press (0.000m at 15fps -> 0.232m, frame spread 182% -> 4.0%).
 *
 * A preset is three numbers and a name. It is deliberately NOT a free-form
 * slider: the point of the switch is that the player can try the candidates the
 * measurements were taken on, and a slider would produce configurations nothing
 * has ever measured.
 */

export type SteeringFeelId =
  | 'classic'
  | 'settled'
  | 'calm'
  | 'slow-return'
  | 'heavy'
  | 'smoothed';

/** What a frame hands the physics: the wheel's end position, or its mean. */
export type SteerPublish = 'end' | 'mean';

export interface SteeringFeel {
  id: SteeringFeelId;
  /** Shown on the settings row. */
  label: string;
  /** One line under the label, in the player's terms. */
  note: string;
  /** Units of lock per second while a key is held. */
  keyboardSteerRate: number;
  /** Units of lock per second the wheel springs back at when it is not. */
  keyboardCentreRate: number;
  keyboardSteerPublish: SteerPublish;
}

/**
 * The five, in the order they are offered.
 *
 * `classic` is byte-for-byte what shipped before this work and is kept so the
 * old feel is recoverable and so every candidate has a control arm the player
 * can switch back to in one click.
 */
export const STEERING_FEELS: Record<SteeringFeelId, SteeringFeel> = {
  settled: {
    id: 'settled',
    label: 'Settled',
    note: 'The default. The wheel comes back at the speed it went on, and each '
      + 'frame gives the car the lock it actually held. Holds a line; still flicks.',
    keyboardSteerRate: 3.4,
    keyboardCentreRate: 2.8,
    keyboardSteerPublish: 'mean',
  },
  calm: {
    id: 'calm',
    label: 'Calm',
    note: 'Settled, with the wheel slower still to straighten on its own. The '
      + 'steadiest car here; the slowest to unwind when you let go.',
    keyboardSteerRate: 3.4,
    keyboardCentreRate: 2.2,
    keyboardSteerPublish: 'mean',
  },
  'slow-return': {
    id: 'slow-return',
    label: 'Slow return',
    note: 'The unwind fix on its own — a wheel that no longer springs back faster '
      + 'than it winds on, with no change to what a frame reports.',
    keyboardSteerRate: 3.4,
    keyboardCentreRate: 2.8,
    keyboardSteerPublish: 'end',
  },
  heavy: {
    id: 'heavy',
    label: 'Heavy',
    note: 'A slower, heavier rack. Steadier per press, and noticeably slower to '
      + 'answer and to change direction.',
    keyboardSteerRate: 2.2,
    keyboardCentreRate: 5.5,
    keyboardSteerPublish: 'end',
  },
  smoothed: {
    id: 'smoothed',
    label: 'Smoothed',
    note: 'Classic rates, but each frame gives the car the average lock it held '
      + 'rather than its last instant. Fixes the short flick that used to vanish.',
    keyboardSteerRate: 3.4,
    keyboardCentreRate: 5.5,
    keyboardSteerPublish: 'mean',
  },
  classic: {
    id: 'classic',
    label: 'Classic',
    note: 'What the game shipped with. Quickest to unwind, hardest to hold — the '
      + 'wheel springs back 62% faster than it winds on.',
    keyboardSteerRate: 3.4,
    keyboardCentreRate: 5.5,
    keyboardSteerPublish: 'end',
  },
};

/** Offer order: the recommendation first, the control arm last. */
export const STEERING_FEEL_IDS: SteeringFeelId[] = [
  'settled', 'calm', 'slow-return', 'heavy', 'smoothed', 'classic',
];

/**
 * What a new player gets, and why it is this one.
 *
 * MEASURED, NOT CHOSEN. `probe:steeringfeel` flew fifteen configurations down
 * seven lanes at three frame rates each, against the same analogue-wheel control
 * arm. On the headline case — the 2.0g corner at 200 km/h the issue is written
 * about — `settled` takes the keyboard driver from 7.67m of wander to 0.36m and
 * the ratio against the wheel from 61.9x to 3.0x, keeps the 2.6g/280 km/h corner
 * the old feel left the road on at every frame rate, and is the SLOWEST unwind
 * that still holds the 1.2g chicane inside the 2.0m wander bar at 30, 60 and
 * 144fps. `calm` is one step further and is offered rather than defaulted
 * because it puts the chicane through that bar.
 *
 * WHAT IT COSTS, also measured: nothing at all to reach a corner's lock (83ms at
 * 60fps, unchanged), 16ms on a full direction change (367 -> 383ms), and 184ms
 * on letting the wheel unwind by itself from full lock (183 -> 367ms). The last
 * of those is the real handicap and it is the price of the fix.
 */
export const DEFAULT_STEERING_FEEL: SteeringFeelId = 'settled';

/** Falls back to the default rather than throwing on an unknown persisted id. */
export function steeringFeel(id: string | undefined): SteeringFeel {
  return STEERING_FEELS[id as SteeringFeelId] ?? STEERING_FEELS[DEFAULT_STEERING_FEEL];
}

/**
 * Writes a preset into a live input config.
 *
 * Takes the three fields structurally rather than importing `InputConfig`,
 * because `InputController` imports THIS module for its defaults and a cycle
 * between the two would be a real one at module-evaluation time, not merely a
 * type-level one.
 */
export function applySteeringFeel(
  cfg: {
    keyboardSteerRate: number;
    keyboardCentreRate: number;
    keyboardSteerPublish: SteerPublish;
  },
  id: string | undefined,
): SteeringFeel {
  const f = steeringFeel(id);
  cfg.keyboardSteerRate = f.keyboardSteerRate;
  cfg.keyboardCentreRate = f.keyboardCentreRate;
  cfg.keyboardSteerPublish = f.keyboardSteerPublish;
  return f;
}
