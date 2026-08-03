/**
 * The FIA's racing-standards rules, as arithmetic.
 *
 * Everything in this file is a REGULATION expressed as a function, and nothing
 * in it knows about the engine, the cars, the renderer or the HUD. That is the
 * point: a stewards' decision has to be defensible, and a rule you can call with
 * two numbers and read the answer off is defensible in a way that a rule tangled
 * into a 3000-line update loop is not. `Stewards.ts` gathers the evidence; this
 * file decides what the evidence means.
 *
 * ===========================================================================
 * THE SOURCES
 * ===========================================================================
 *
 * Three documents, and they do different jobs.
 *
 * 1. FIA FORMULA 1 DRIVING STANDARDS GUIDELINES, 26 February 2026, v01. The
 *    document the drivers asked for in 2022 so they would know how the stewards
 *    read the rules, and the only place the corner-entry tests are written down
 *    as tests. Its own first line is the caveat that governs this whole file:
 *
 *      "These are GUIDELINES and NOT REGULATIONS. At all times the Stewards
 *       will adjudicate based upon the Regulations, but decisions will be
 *       informed and guided by these guidelines and the experience of their
 *       Driver Stewards."
 *
 *    Points are lettered A to L; this file implements A, B, D and F.
 *
 * 2. FIA INTERNATIONAL SPORTING CODE, APPENDIX L, CHAPTER IV — Code of Driving
 *    Conduct on Circuits. The actual prohibition. Art. 2(b) is where "one car
 *    width" lives and Art. 2(d) is where "causing a collision" lives; the DSG
 *    tells you who was entitled to the corner, and Appendix L tells you that the
 *    driver who took it from them committed an offence.
 *
 * 3. 2026 FORMULA 1 SPORTING REGULATIONS, SECTION B. Art. B1.8.6 is the track
 *    limits and lasting-advantage article; Art. B1.9.5 is the penalty tariff.
 *
 * A NOTE ON ARTICLE NUMBERS. Section B was renumbered between Issue 1 (17
 * October 2024) and the issue the 2026 Driving Standards Guidelines cite. The
 * quotations below are verbatim from Issue 1, under the numbers the current
 * issue gives them, which are also the numbers already used elsewhere in this
 * codebase (`RaceControlManager.sanctionableLap` cites Art. B1.9.4 and
 * `probeTrackLimits` cites Art. B1.8.6). The mapping, where it matters:
 *
 *     current   Issue 1    subject
 *     B1.8.5    B1.9.5     driving unnecessarily slowly, erratically, dangerously
 *     B1.8.6    B1.9.6     leaving the track; re-joining; lasting advantage
 *     B1.9.4    B1.10.3    incidents during an LTCS
 *     B1.9.5    B1.10.4    incidents during a TTCS — the penalty tariff
 *     B1.9.6    B1.10.5    procedure for serving a penalty
 *
 * The DSG's own references (Point D cites "Article B1.8.6" for track limits and
 * "Article B1.9.5" for the penalty, Point E cites "Article B1.8.5") are what
 * pins that mapping down.
 */

// ===========================================================================
// The car
// ===========================================================================

/**
 * Half the car's OVERALL width, over the tyres, in metres.
 *
 * The same number `RaceControlManager` judges track limits on, and for the same
 * reason: the part of the car that decides where it is, is the outboard face of
 * the tyre. Duplicated rather than imported to keep this module free of engine
 * imports — `probeStewards` asserts the two agree, so it cannot drift.
 */
export const CAR_HALF_WIDTH_M = 0.995;

/**
 * One car's width, in metres. Appendix L's unit of racing room.
 *
 * 1.99m, because the 2026 Technical Regulations cap overall width at 2000mm
 * (Art. 3.2.2) and the car this game draws is built to it.
 */
export const CAR_WIDTH_M = CAR_HALF_WIDTH_M * 2;

/**
 * How far ahead of the car's origin its MIRRORS sit, in metres.
 *
 * This is the single most load-bearing number in the file, because DSG Point
 * A(i) is a test about a mirror, and a mirror in the wrong place moves the line
 * between "entitled to the corner" and "dived in" by however far it is wrong.
 *
 * So it is measured off the car this game actually draws rather than guessed.
 * `CockpitMesh.MIRROR_Z` is 0.790 and `CarMesh` builds the shell about the
 * WHEELBASE MIDPOINT — its axles are at z = +1.80 and z = -1.80. The physics
 * integrates about the CENTRE OF MASS, which `VehicleSpec` puts at
 * `cogToFrontM` = 1.98 behind the front axle, i.e. 0.18m behind that midpoint.
 * A point 0.790 ahead of the midpoint is therefore 0.970 ahead of the origin
 * every `s` in this game is measured at.
 *
 * Not imported from `CockpitMesh` on purpose: that module pulls in three.js, and
 * a stewards' decision must be computable in a headless script.
 */
export const MIRROR_AHEAD_OF_ORIGIN_M = 0.97;

/** The subset of a car the corner-entry tests read. */
export interface RacingCar {
  /** Distance along the lap of the car's origin (its centre of mass), metres. */
  s: number;
  /** Offset from the centreline, metres, POSITIVE LEFT — `TrackSpline`'s sign. */
  lateral: number;
  /** `VehicleSpec.cogToFrontM`: how far ahead of the origin the front axle is. */
  cogToFrontM: number;
  /** True when no part of the car was in contact with the track. */
  offTrack: boolean;
}

/** Distance along the lap of a car's FRONT AXLE. */
export function frontAxleS(car: RacingCar): number {
  return car.s + car.cogToFrontM;
}

/** Distance along the lap of a car's MIRRORS. */
export function mirrorS(car: RacingCar): number {
  return car.s + MIRROR_AHEAD_OF_ORIGIN_M;
}

// ===========================================================================
// Which way the corner goes, and which car is on the inside of it
// ===========================================================================

/**
 * Which hand the corner turns.
 *
 * +1 for a RIGHT-hander, -1 for a LEFT-hander — the sign of `TrackSpline`'s
 * `curvature`, whose header is explicit that positive is a right turn and that
 * an earlier revision had it backwards.
 */
export type CornerHand = 1 | -1;

/**
 * How far toward the INSIDE of the corner a car is sitting, in metres.
 *
 * `lateral` is positive LEFT; the inside of a right-hander is on the right, so
 * the inside is where `lateral` is most negative. Multiplying by `-hand` turns
 * both cases into one number where bigger is further inside, which is what makes
 * "who is on the inside" a comparison rather than a pair of branches.
 */
export function insideness(lateral: number, hand: CornerHand): number {
  return -hand * lateral;
}

/**
 * Was `a` on the inside of `b`?
 *
 * Returns the margin in metres: positive if `a` was inside, negative if outside.
 * Callers should treat a small magnitude as "side by side on the same line",
 * which is not an overtake on either side and not something to judge.
 */
export function insideMarginM(a: RacingCar, b: RacingCar, hand: CornerHand): number {
  return insideness(a.lateral, hand) - insideness(b.lateral, hand);
}

// ===========================================================================
// DSG Point A — overtaking on the INSIDE of a corner
// ===========================================================================

/**
 * DSG Point A(i), as a margin in metres.
 *
 *   "A. Overtaking on the INSIDE of a corner. To be entitled to be given room
 *    when overtaking on the INSIDE, the overtaking car must:
 *      i)  Have its front axle AT LEAST ALONGSIDE THE MIRROR of the other car
 *          PRIOR TO AND AT THE APEX
 *      ii) Be driven in a fully controlled manner particularly from entry to
 *          apex and not have 'dived in'.
 *      iii) In the Stewards' estimation, have taken a reasonable racing line and
 *          been able to complete the move whilst remaining within track limits."
 *
 * This function is (i) and only (i) — the geometric half, which is the half that
 * has an answer. Positive means the front axle was ahead of the mirror by that
 * many metres and the car is entitled to room; negative means it was short.
 *
 * With this game's car the threshold works out at 1.01m of centre-to-centre
 * deficit: an overtaker whose origin is up to 1.01m behind the defender's still
 * has its front axle level with the defender's mirrors. That is a demanding
 * test, and it is meant to be — "at least alongside the mirror" is most of a car
 * alongside, not a nose up the inside.
 */
export function insideRoomMarginM(overtaker: RacingCar, defender: RacingCar): number {
  return frontAxleS(overtaker) - mirrorS(defender);
}

// ===========================================================================
// DSG Point B — overtaking on the OUTSIDE of a corner
// ===========================================================================

/**
 * DSG Point B(i), as a margin in metres.
 *
 *   "B. Overtaking on the OUTSIDE of a corner. To be entitled to be given room,
 *    including at the exit, when overtaking on the OUTSIDE, the overtaking car
 *    must:
 *      i)   Have its front axle AHEAD OF THE FRONT AXLE of the other car AT THE
 *           APEX.
 *      ii)  Be driven in a controlled manner from entry, to apex, and to exit.
 *      iii) Be able to make the corner within track limits."
 *
 * Both cars are the same shape, so the axle offsets cancel and this reduces to
 * the difference in `s`. It is deliberately much harder to satisfy than Point A:
 * the outside of a corner is the wrong place to be, and the guidelines only
 * protect a car that is genuinely ahead there. This is the user's case — "I was
 * at the apex first and by the rules they weren't and therefore that corner
 * should've been mine".
 *
 * The entitlement it confers is wider than Point A's, though: room "INCLUDING AT
 * THE EXIT", which is why a car that satisfies B and is then run out of road on
 * the exit has been wronged even though the contact happened after the apex.
 */
export function outsideRoomMarginM(overtaker: RacingCar, defender: RacingCar): number {
  return frontAxleS(overtaker) - frontAxleS(defender);
}

/**
 * DSG Point A(iii) / B(iii): could the overtaking car have made the corner?
 *
 * The honest part of it, which is the observable part: a car that was off the
 * track at the apex did not complete the move within track limits, so it was
 * never entitled to room in the first place.
 *
 * The unobservable part — whether the move was "optimistic", whether the driver
 * "dived in" — is the subjective half the guidelines reserve for the Driver
 * Stewards, and `Stewards.ts` approximates it with entry speed rather than
 * pretending it is settled here.
 */
export function completedWithinTrackLimits(overtaker: RacingCar): boolean {
  return !overtaker.offTrack;
}

// ===========================================================================
// Appendix L Chapter IV Art. 2(b) — racing room
// ===========================================================================

/**
 * How much clear road a car is leaving between itself and the edge, in metres.
 *
 * ISC Appendix L, Chapter IV, Art. 2(b):
 *
 *   "Any driver moving back towards the racing line, having earlier defended his
 *    position off-line, should leave at least one car width between his own car
 *    and the edge of the track on the approach to the corner.
 *    However, manoeuvres liable to hinder other drivers, such as deliberate
 *    crowding of a car beyond the edge of the track or any other abnormal change
 *    of direction, are strictly prohibited."
 *
 * The measurement the regulation describes is from the SQUEEZING car's bodywork
 * to the edge of the track — not from its centreline, and not to the squeezed
 * car. So: take the edge on the side the other car is on, subtract where the
 * squeezer's outboard tyres are, and what is left is the gap a car has to fit
 * into. Below `CAR_WIDTH_M` it does not fit, and the car in it is being run out
 * of road. This is the user's case — "I had no room to make a turn because the
 * other car kinda boxed me out".
 *
 * `towardSide` is +1 when the squeezed car is to the squeezer's LEFT (greater
 * `lateral`) and -1 when it is to its right.
 */
export function racingRoomM(
  squeezerLateral: number, halfWidthM: number, towardSide: 1 | -1,
): number {
  return halfWidthM - squeezerLateral * towardSide - CAR_HALF_WIDTH_M;
}

/** True when less than one car's width of track was left on that side. */
export function roomWasDenied(roomM: number): boolean {
  return roomM < CAR_WIDTH_M;
}

// ===========================================================================
// The offences
// ===========================================================================

/**
 * What the stewards found, in the words they would use.
 *
 * Every one of these is a named offence in a published document, and the string
 * is what appears on the timing screen, so it is the regulation's own wording
 * rather than a paraphrase.
 */
export type Offence =
  /**
   * ISC Appendix L Ch. IV Art. 2(d): "Causing a collision, repetition of serious
   * mistakes or the appearance of a lack of control over the car (such as
   * leaving the track) will be reported to the Stewards and may entail the
   * imposition of penalties up to and including the disqualification of any
   * driver concerned."
   */
  | 'CAUSING A COLLISION'
  /**
   * ISC Appendix L Ch. IV Art. 2(b), the car-width sentence and the crowding
   * sentence together. The offence the stewards name on the timing screen for
   * this is "forcing another driver off the track".
   */
  | 'FORCING ANOTHER DRIVER OFF THE TRACK'
  /**
   * Art. B1.8.6: "Should a Car leave the track the driver may re-join, however,
   * this may only be done when it is safe to do so and without gaining any
   * lasting advantage." DSG Point F is the guidance on giving it back.
   */
  | 'LEAVING THE TRACK AND GAINING AN ADVANTAGE'
  /**
   * The remedy declined. Art. B1.8.6 gives the driver "the opportunity to give
   * back the whole of any advantage he gained by leaving the track"; a driver
   * who does not take it is penalised for the original offence instead.
   */
  | 'FAILING TO GIVE THE POSITION BACK';

/**
 * What the stewards decided. Every noted incident ends on exactly one of these.
 *
 * The user's summary of the real thing — "when the FIA note something down they
 * can either give a penalty or no further action on that incident" — with the
 * third outcome that sits between them and is the one that most often ends a
 * real investigation without a penalty.
 */
export type VerdictKind =
  /** Racing incident, or no offence proved. Nothing follows. */
  | 'no-further-action'
  /** A position is to be handed back. A penalty only if it is not. */
  | 'give-position-back'
  /** A penalty, with the offence named. */
  | 'penalty';

// ===========================================================================
// The tariff
// ===========================================================================

/**
 * What a penalty for this offence is, before the stewards' discretion.
 *
 * Art. B1.9.5 lists what the stewards may impose for an incident during a Total
 * Time Classified Session: a five second time penalty (a.), a ten second time
 * penalty (b.), a drive-through (c.), a ten second stop-and-go (d.), a time
 * penalty (e.), a reprimand (f.), a grid drop (g.), disqualification (h.) and
 * suspension (i.). It does NOT say which offence gets which — that is the
 * stewards' judgement, informed by the DSG's own note that
 *
 *   "As a general policy, penalty points will be applied only for dangerous,
 *    reckless or apparently deliberate actions resulting in a collision, or
 *    other unacceptable driving behaviour or unsportsmanlike behaviour on the
 *    part of the driver"
 *
 * so the ordinary racing offence is a time penalty and the ladder above it is
 * reserved for something worse. The numbers here are the ones the stewards
 * actually reach for in a modern Grand Prix: five seconds is the standard
 * sanction for a minor collision or an advantage not given back, ten for a
 * heavier one or for running a driver out of road.
 *
 * `severity` is the closing speed of the contact over 12 m/s — `RaceEngine`'s
 * own measure — and is zero for offences with no contact in them.
 */
export function tariffSeconds(offence: Offence, severity: number): 5 | 10 {
  switch (offence) {
    // A collision that ended someone's race is not the same offence as a rub at
    // the hairpin. 0.6 of `RaceEngine`'s severity is a 7.2 m/s closing speed,
    // which is the point at which bodywork comes off rather than scuffing.
    case 'CAUSING A COLLISION':
      return severity >= 0.6 ? 10 : 5;
    // Running a driver off the road is the one on this list that is squarely a
    // "manoeuvre liable to hinder other drivers ... strictly prohibited", and it
    // costs the victim the corner outright.
    case 'FORCING ANOTHER DRIVER OFF THE TRACK':
      return 10;
    case 'LEAVING THE TRACK AND GAINING AN ADVANTAGE':
    case 'FAILING TO GIVE THE POSITION BACK':
      return 5;
  }
}
