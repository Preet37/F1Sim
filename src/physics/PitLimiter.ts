import type { PitLane } from '../data/tracks/TrackDefinition';
import { clamp01 } from '../core/MathUtils';

/**
 * The pit lane speed limit, and what it takes to arrive at it.
 *
 * This lives on its own because three separate pieces of the simulation have to
 * agree about it exactly, and until they did the disagreement was worth a
 * drive-through penalty every time a car came in:
 *
 *   - `VehiclePhysics` enforces the cap once the limiter is armed. It used to
 *     hard-code 80 km/h, which is right at ten circuits and wrong at Monaco,
 *     where the limit is 60. A car sitting obediently on its limiter in the
 *     Monaco pit lane settled at 80.2 km/h and was penalised for it, by the
 *     same simulation that was holding it there.
 *
 *   - `AIVehicleController` brakes for the entry so its cars cross the line
 *     already under the limit.
 *
 *   - `RaceEngine` does the same for the PLAYER, whose limiter is automatic and
 *     who is therefore owed the braking that makes an automatic limiter
 *     possible. Without it the player crossed the line at whatever they were
 *     doing — 299 km/h at Monza — took an instant drive-through, and watched a
 *     HUD that said LIMITER ON the whole way.
 *
 * A limiter is a speed cap, not a brake and not a teleport. Everything in here
 * is about arriving at the cap; holding it is the physics' job.
 */

/**
 * How much under the posted limit the cars actually sit, km/h.
 *
 * Nobody drives a pit lane on the number itself. The penalty for a single km/h
 * over is a drive-through, the tolerance race control allows is half a km/h,
 * and a limiter is a control loop with overshoot like any other.
 */
export const PIT_LIMIT_MARGIN_KPH = 2;

/**
 * Planning deceleration for the pit entry, m/s².
 *
 * Deliberately below what the brakes can do. Planning at the limit means
 * arriving at the limit with no margin: the brakes do not reach their rate
 * instantly, so every car crossed the entry line between 80 and 116 km/h
 * against a limit of 80, collected a drive-through, came in to serve it, sped
 * again on the way in, and shuttled in and out of the pit lane for the rest of
 * the race. Seven visits and no stops was a normal race.
 */
export const PIT_ENTRY_DECEL_MS2 = 7;

/**
 * How far before the pit entry line the approach is planned, metres.
 *
 * Has to be comfortably MORE than the distance a car needs to slow from its top
 * speed, or the window in which a car both knows about the pit entry and still
 * has room to make it can be empty. At 620m it was: a car arriving at 340 km/h
 * needs about 620m under the planning rate above, so by the time it noticed the
 * pit entry it had already decided it could not make it — and it made that
 * decision on every lap, for ever.
 */
export const PIT_ENTRY_SCAN_M = 950;

/**
 * How far BEFORE the entry line the car is asked to already be at the limit,
 * metres.
 *
 * Aiming to reach the limit exactly AT the line is what a driver would call
 * cutting it fine and what race control calls a drive-through. The braking
 * profile is a square root, so a target of "be at 72 km/h at the line" still
 * permits 82 km/h ten metres before it, and ten metres is not enough road to
 * shed the difference once the brakes have any lag at all.
 */
export const PIT_ENTRY_SETTLE_M = 35;

/**
 * Share of the limit the car aims to cross the entry line at.
 *
 * A driver arrives comfortably UNDER the limit and lets the limiter hold them
 * there, because the penalty for being a single km/h over is a drive-through.
 */
export const PIT_ENTRY_TARGET_SHARE = 0.92;

/**
 * How far before the entry line the limiter goes on, metres.
 *
 * Not zero, and this is the whole of one of the two reported defects. Race
 * control judges "was this car speeding" on the same step that decides "is this
 * car in the pit lane", so a limiter armed ON the line loses that race by one
 * step and the penalty is issued before the limiter has cut a single newton.
 * In a real car the button is pressed on the approach.
 */
export const PIT_LIMITER_ARM_M = 45;

/**
 * The hardest the limiter itself may brake, in g.
 *
 * A limiter is an engine cut and nothing else; this is the sim's stand-in for
 * the engine braking and drag that a real car has behind the cut, and for the
 * driver's own foot. It was half a g, which needs four hundred metres to bring
 * a car from racing speed to 80 km/h — longer than any pit lane on the calendar
 * — so a car that arrived hot simply sped the whole length of the lane with
 * LIMITER ON showing on the HUD.
 *
 * A g is still far inside what these brakes and tires can do, so it cannot lock
 * a wheel or step the back out, and it is applied on the car's own brake
 * balance and then through the friction circle rather than dumped into the rear
 * axle the way the original did.
 */
export const PIT_LIMITER_MAX_DECEL_G = 1;

/**
 * How much pit lane the limiter is allowed to need, metres.
 *
 * A car that crosses the entry line needing more road than this to get under
 * the limit has not made the pit entry, and letting it in is a guaranteed
 * drive-through — served by driving down the same pit lane, where it happens
 * again. It comes round instead, which is what a real driver does.
 */
export const PIT_ENTRY_RESCUE_M = 50;

/**
 * The speed the limiter actually holds, m/s, from the posted limit alone.
 *
 * Takes the number rather than the `PitLane` because `VehiclePhysics` — the
 * FIRST of the three pieces the note at the top of this file says have to agree
 * exactly — only ever has the number. It was the one that did not read this
 * rule: it capped the car at the posted limit itself, so the player's automatic
 * limiter sat on 80.0 with race control's tolerance at 80.5, while the AI aimed
 * at 78 and had two and a half km/h in hand. Half a km/h of margin is not a
 * margin; it is a control loop being asked not to overshoot.
 */
export function pitLimiterSetpointFromKph(speedLimitKph: number): number {
  return Math.max(speedLimitKph - PIT_LIMIT_MARGIN_KPH, 5) / 3.6;
}

/** The speed the limiter actually holds, m/s. */
export function pitLimiterSetpointMs(pit: PitLane): number {
  return pitLimiterSetpointFromKph(pit.speedLimitKph);
}

/** The speed to cross the entry line at, m/s. */
export function pitEntryTargetMs(pit: PitLane): number {
  return pitLimiterSetpointMs(pit) * PIT_ENTRY_TARGET_SHARE;
}

/**
 * The fastest a car may be doing `toEntryM` before the entry line and still
 * make the limit, m/s.
 *
 * The constant-deceleration solution v = sqrt(vt² + 2·a·d), with the settling
 * distance taken off the front so the car is at the limit before the line
 * rather than on it.
 */
export function pitEntryCeilingMs(pit: PitLane, toEntryM: number): number {
  const vAtLine = pitEntryTargetMs(pit);
  const d = Math.max(toEntryM - PIT_ENTRY_SETTLE_M, 0);
  return Math.sqrt(vAtLine * vAtLine + 2 * PIT_ENTRY_DECEL_MS2 * d);
}

/**
 * Road needed to get from `speedMs` to the entry target, metres.
 *
 * What a driver checks before committing: a call that arrives eighty metres
 * before the line at 280 km/h cannot be answered on this lap, and diving in
 * anyway earns a drive-through for speeding rather than a pit stop.
 */
export function pitEntryRoomNeededM(pit: PitLane, speedMs: number): number {
  const vAtLine = pitEntryTargetMs(pit);
  return Math.max(speedMs * speedMs - vAtLine * vAtLine, 0) /
    (2 * PIT_ENTRY_DECEL_MS2) + PIT_ENTRY_SETTLE_M;
}

/**
 * Road the limiter itself needs to bring `speedMs` under the limit, metres.
 *
 * Uses the limiter's own bound, so it answers the question the physics will
 * actually answer a step later rather than a nearby but different one.
 */
export function pitLimiterShedDistanceM(pit: PitLane, speedMs: number): number {
  const limitMs = pit.speedLimitKph / 3.6;
  if (speedMs <= limitMs) return 0;
  const decel = 9.81 * PIT_LIMITER_MAX_DECEL_G;
  return (speedMs * speedMs - limitMs * limitMs) / (2 * decel);
}

/**
 * Brake pedal needed to be doing `vTarget` in `distance` metres, 0..1.
 *
 * Compares the car against the constant-deceleration profile and brakes only
 * when it is ABOVE it. The comparison matters: taking the required deceleration
 * on its own and turning it straight into pedal means a car two hundred metres
 * from its box still needs a third of a metre per second squared to stop there,
 * which is a small but permanent brake application. It fought the throttle the
 * whole length of the pit lane and the car crawled to its box at half the speed
 * limit, losing several seconds on every stop for no reason a driver would
 * recognise.
 */
export function brakeFor(
  speed: number, vTarget: number, distance: number, refDecel: number,
): number {
  if (distance <= 0.01) return speed > vTarget ? 1 : 0;
  const profile = Math.sqrt(vTarget * vTarget + 2 * refDecel * distance);
  if (speed <= profile) return 0;
  const needed = (speed * speed - vTarget * vTarget) / (2 * distance);
  // Slightly over-braking (the 1.15) makes the approach converge instead of
  // asymptotically never arriving.
  return clamp01(needed / (refDecel * 1.15));
}
