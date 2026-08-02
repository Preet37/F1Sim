/**
 * What a driver owes the cars around it.
 *
 * WHY THIS FILE EXISTS. The AI tracked the racing line and treated the field as
 * a set of gaps in a timing screen. It knew there was a car ahead — it held a
 * following distance expressed in SECONDS, which is a comfort metric — and it
 * knew nothing at all about where that car was across the road. Two consequences
 * the player reported, both reproducible in `scripts/probeTraffic.ts`:
 *
 *   A car stationary in the pit lane was driven into from behind. A gap held in
 *   seconds says nothing about whether the gap can still be shed: at 22 m/s the
 *   AI began lifting 13 metres from a parked car it needed sixty to stop for.
 *
 *   At a standing start a car on the right of the grid drove across to the
 *   racing line on the left THROUGH whatever was in the way. Nothing in the
 *   controller ever asked whether the space it was steering into was empty —
 *   `alongsideLeft` and `alongsideRight` were computed by the race engine every
 *   step and read by nothing except a timer that made decisions run faster.
 *
 * So the two obligations are separated here and both are expressed as distances
 * the car can actually check:
 *
 *   LONGITUDINAL  never arrive at the car in front faster than this car's own
 *                 brakes can wash off. Not a fixed gap and not a time — a
 *                 required deceleration, computed from the closing rate and the
 *                 room, which is the same law the controller already uses to
 *                 brake for a corner. A stationary car is not a special case of
 *                 it, it is the limit of it.
 *
 *   LATERAL       before crossing the road, check the road you are crossing
 *                 into. Room is measured to the nearest body on that side, and
 *                 a move is clamped to it rather than being abandoned, so a car
 *                 held out of a gap resumes taking it the moment it opens.
 *
 * What this deliberately does NOT do is add caution. Every function here returns
 * a bound that is enormous in clean air — `safeFollowSpeedMs` at a hundred
 * metres is far above any speed the circuit allows — so in the ninety-odd
 * percent of a lap where nothing is near, none of it binds and the lap time is
 * the lap time. Racing contact between two cars taking the same corner is still
 * possible and is meant to be: what these rule out is driving into a car that
 * was simply there.
 */

/**
 * Longitudinal centre-to-centre distance at which two cars touch, metres.
 *
 * Not a taste parameter. `RaceEngine.resolveContacts` models each car as three
 * discs of radius 1.0m at ±1.85m and 0 along its centreline, so nose-to-tail
 * contact is at 1.85 + 1.0 + 1.0 + 1.85. Any standoff smaller than this is not
 * a standoff, it is an overlap, and that is the mistake to avoid: the obvious
 * "five metre gap" is already inside the other car.
 */
export const CONTACT_GAP_M = 5.7;

/** Lateral centre-to-centre distance at which two cars touch, metres. */
export const CONTACT_WIDTH_M = 2.0;

/**
 * How much clear air a driver keeps behind the car in front on the circuit,
 * metres, measured beyond contact.
 *
 * Small on purpose. This is the floor a driver will not cross, not the gap they
 * choose to run — the FOLLOW state holds a comfortable several car lengths of
 * its own accord. Making the floor generous looks safe and is not: the field
 * spends most of a race in traffic, so a floor that binds during ordinary
 * following is a lap-time tax on every car at once, and one big enough to stop
 * a slipstream also stops the overtake the slipstream was for.
 */
export const TRAFFIC_STANDOFF_M = 1.1;

/**
 * The same, in the pit lane, metres.
 *
 * Bigger, because the pit lane is a different regime and not merely a slow one.
 * The tyres have been cooling since the entry and the friction circle scales the
 * brake demand down with them — full pedal delivers about 3 m/s² down there
 * against the 25-plus a braking zone has — so the room a driver needs is a much
 * larger multiple of the speed than it is on the circuit. It is also a queue
 * with a pit wall on one side and no way past, so there is nothing to gain from
 * being close.
 */
export const PIT_STANDOFF_M = 3.4;

/** Deceleration a car can actually produce at pit-lane speed, m/s². */
export const PIT_DECEL_MS2 = 3.0;

/**
 * Half-width of the corridor a car counts as being IN FRONT of us in, metres.
 *
 * Slightly wider than a contact — a car 2.0m across the road from us is touching
 * us, and we should have started slowing before it got there. Wider than this
 * and the AI brakes for cars it is cleanly passing, which is exactly the timid
 * behaviour that turns a race into a procession.
 */
export const HAZARD_CORRIDOR_M = 2.7;

/**
 * Lateral room a driver leaves alongside another car, metres, beyond contact.
 *
 * "A car's width" is the phrase the stewards use; this is much less than that,
 * because it is a MINIMUM and not a target. It has to be small enough that two
 * cars can still race through a corner side by side on a nine-metre road.
 */
export const RACING_ROOM_M = 0.55;

/**
 * How far ahead a lateral move looks, seconds.
 *
 * A car half a car length behind and closing at 10 m/s will be alongside within
 * the time it takes to change lane, so it occupies the space being moved into
 * even though it is not in it yet. This is what makes the race-start case work:
 * the car being driven across to is usually not beside the AI at the moment the
 * AI decides to go.
 */
export const LATERAL_LOOK_S = 1.2;

/**
 * Cap on how much road the look-ahead above may claim, metres.
 *
 * Without it a car closing at 15 m/s on a slower one treats forty metres of
 * empty road as occupied and cannot move off the line at all — which does not
 * make it safe, it makes it unable to overtake, and the two failures look
 * identical from the outside. The space being moved into is a car length and a
 * bit; anything further away is somewhere this car will get to later, and it
 * will look again when it does.
 */
export const LATERAL_LOOK_CAP_M = 12;

/**
 * The fastest this car may be going and still be able to slow to `leadSpeedMs`
 * before it is closer than `standoffM` to the car in front.
 *
 * v_safe = sqrt(v_lead² + 2 a d), the constant-deceleration solution, with `d`
 * the room beyond the standoff. Inside the standoff the answer tapers from the
 * lead car's speed down to zero at contact, so a car that is already too close
 * backs out of the gap instead of holding station in it.
 *
 * Returns `Infinity` when there is nothing to follow, so callers can use it as
 * an unconditional `Math.min` without a branch.
 */
export function safeFollowSpeedMs(
  gapM: number, leadSpeedMs: number, decelMs2: number, standoffM: number,
): number {
  const room = gapM - CONTACT_GAP_M - standoffM;
  if (room <= 0) {
    // Inside the standoff. Zero at contact, the lead car's speed at the edge of
    // the standoff — never negative, and never above what we are following.
    const t = 1 + room / Math.max(standoffM, 0.5);
    return Math.max(0, leadSpeedMs * (t > 0 ? t : 0));
  }
  return Math.sqrt(leadSpeedMs * leadSpeedMs + 2 * decelMs2 * room);
}

/**
 * The deceleration this car must already be producing to avoid the car in front,
 * m/s². Zero when it does not need to slow at all.
 *
 * The same `a = (v² - v_target²) / 2d` the corner-braking scan uses, pointed at
 * a car instead of at an apex. Expressing it this way rather than as a threshold
 * is what makes a stationary car fall out of the model for free: `v_target` is
 * zero, so the demand is `v²/2d` and it rises without limit as the room runs
 * out. There is no case to special-case.
 */
export function requiredDecelMs2(
  speedMs: number, gapM: number, leadSpeedMs: number, standoffM: number,
): number {
  if (speedMs <= leadSpeedMs) return 0;
  const room = Math.max(gapM - CONTACT_GAP_M - standoffM, 0.35);
  return (speedMs * speedMs - leadSpeedMs * leadSpeedMs) / (2 * room);
}

/**
 * Is a car at longitudinal separation `gapM` (positive = ahead) close enough
 * that a lateral move by us would put us into it?
 *
 * Asymmetric in the closing rate, and that is the point: a car we are catching
 * occupies more of the road ahead than one dropping back does, and a car
 * catching US occupies road behind us we are about to be beside.
 */
export function lateralOverlap(
  gapM: number, ourSpeedMs: number, theirSpeedMs: number,
): boolean {
  const pad = CONTACT_GAP_M + 1.5;
  const d = ourSpeedMs - theirSpeedMs;
  const closing = Math.min(Math.max(0, d) * LATERAL_LOOK_S, LATERAL_LOOK_CAP_M);
  const dropping = Math.min(Math.max(0, -d) * LATERAL_LOOK_S, LATERAL_LOOK_CAP_M);
  return gapM <= pad + closing && gapM >= -(pad + dropping);
}
