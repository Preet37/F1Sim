import { Rng } from '../core/MathUtils';

/**
 * A Formula 1 pit stop: who does it, in what order, and how long it takes.
 *
 * This module is the whole of the pit stop as a *thing that happens*. The race
 * engine owns where the car is; this owns what the twenty-odd people around it
 * are doing while it is stationary, when the light goes green, and — the part
 * that matters most for the career — how a better crew turns into a faster car.
 *
 * It is deliberately free of Three.js and of the engine, so the same numbers
 * drive the simulation, the animation and the probe. There is exactly one
 * description of a pit stop in this project and this is it.
 *
 * ===========================================================================
 * WHAT A REAL PIT STOP IS
 * ===========================================================================
 *
 * Everything in this file is measured against the real thing rather than
 * invented, in the same way `CarMesh` carries the FIA's regulation volumes. The
 * sources, once, here:
 *
 * THE CREW. Around twenty to twenty-three people go over the wall, in fixed
 * roles. Wikipedia, "Pit stop"
 * (https://en.wikipedia.org/wiki/Pit_stop), gives the breakdown directly:
 *
 *   "Four wheel-gunners or tyre changers, one for each wheel/corner of the car,
 *    use a pneumatic wrench ('tyre gun')"
 *   "Eight tyre carriers are used (four each of wheel-off and wheel-on), two
 *    for each wheel/corner"
 *   "Two stabilisers stabilise the car on each side at the middle of the car"
 *
 * plus the front and rear jack men with "lever-type jacks to lift the car", the
 * "front wing men, if necessary, adjust the front wing angle", and a fire
 * extinguisher man. It also notes that Formula One rules "limit teams to a
 * single pit crew for the mandatory two cars entered" — which is why there is
 * one crew per garage and not two, and why `PIT_CREW` below is a single list.
 * The user's own reference diagram adds a SPARE JACK operator standing by at
 * each end in case the first jack is damaged, and a spotter; both are in
 * `PIT_CREW`. Twelve on the wheels, two jacks, two spares, two stabilisers, two
 * on the wing, one spotter — twenty-one.
 *
 * THE TIME. The same source: "A pit stop typically takes approximately 3
 * seconds to complete", and "McLaren holds the current world record for the
 * fastest pit stop, with a 1.80-second stop performed at the 2023 Qatar Grand
 * Prix on Lando Norris." The three-second figure is the whole population
 * including the stops that go wrong; a clean stop by a front-running team is
 * closer to 2.0-2.4s, and the record is the left tail of that distribution
 * rather than its centre. `PIT_CREW_TIME_ELITE_S` and `PIT_CREW_TIME_POOR_S`
 * bracket the grid accordingly, and `probe:pitstop` prints the distribution the
 * model actually produces and checks it against those figures.
 *
 * For scale, the same article on what the sport used to be: during the
 * refuelling era, "Stops generally lasted for six to twelve seconds, depending
 * upon how much fuel was put into the car." A modern stop is a wheel change and
 * nothing else, which is why four corners in parallel is the whole model.
 *
 * THE RELEASE. Each wheel gun reports when its nut is tight, and the car is
 * released by an automatic light rather than by a person holding a board — the
 * driver is watching the light. That is why `resolvePitStop` gates the stop on
 * the SLOWEST corner rather than on an average, and why the light is a drawn,
 * colour-changing object in `PitCrew.ts` instead of an implicit timer.
 *
 * The regulations the engine already cites for the rest of the pit lane are in
 * `RaceEngine.updatePitLane`: the pit-exit light (2025 Art. 37.2 / 2026 Art.
 * B1.6.3e), closing the exit while cars unlap (2025 Art. 55.14 / 2026 Art.
 * B5.13.4c) and the neutralised-pit-entry rules (2025 Art. 55.12, 56.4 / 2026
 * Art. B5.13.3, B5.12.3).
 */

// ===========================================================================
// The crew
// ===========================================================================

/** The four corners of the car, in the order the crew number them. */
export type WheelCorner = 'FL' | 'FR' | 'RL' | 'RR';

export const WHEEL_CORNERS: readonly WheelCorner[] = ['FL', 'FR', 'RL', 'RR'];

/**
 * A job over the wall.
 *
 * These are ROLES and not people, which is the distinction that makes the
 * choreography possible: a role has one task, one moment in the sequence and
 * one place to stand, so "what should this figure be doing 0.9 seconds into the
 * stop" has an answer that does not depend on which figure it is.
 */
export type PitRole =
  /** Lifts the front of the car. Steps in front of the car as it arrives. */
  | 'front-jack'
  /** Lifts the rear. Comes in from behind once the car is past. */
  | 'rear-jack'
  /** Second jack of each end, held ready in case the first is damaged. */
  | 'spare-jack'
  /** On the single centre-lock nut, with the gun. */
  | 'gun'
  /** Takes the used wheel off and carries it clear. */
  | 'wheel-off'
  /** Holds the new wheel, fits it, and steps back out. */
  | 'wheel-on'
  /** Steadies the car against the guns' torque, one each side. */
  | 'stabiliser'
  /** Front wing: steadies it, and changes the flap angle if asked. */
  | 'front-wing'
  /** Watches the lane and the car's approach, and calls the release. */
  | 'spotter';

/**
 * One member of the crew, and where they stand.
 *
 * Positions are in the PIT BOX FRAME:
 *
 *   +x is across the box, away from the pit wall and TOWARDS THE GARAGE
 *   +z is forward, the way the car is pointing
 *   the origin is the point the car's centre of gravity stops on
 *
 * so a figure at (-1.6, +1.9) is on the pit-wall side of the car, level with
 * the front axle. `heading` is a yaw in radians about +y from facing +z, i.e.
 * from facing the same way as the car.
 *
 * "Towards the garage" is deliberately not "the car's left". Which side of the
 * car the garages are on depends on which side of the circuit the pit lane is
 * and on the direction of travel, and it is not the same on every circuit on
 * the calendar. The renderer resolves it once per frame from the track's own
 * normal and mirrors this whole plan if it comes out the other way round; see
 * `outward` in `PitCrew.ts`. Authoring the stations in the car's frame instead
 * put the spare jack men and the spotter standing in the fast lane at half the
 * circuits, which is the one place in a pit lane where nobody stands.
 *
 * The stations are laid out around a car 5.6m long and 2.0m wide with its axles
 * 3.4m apart, which is what `VehicleSpec` describes and what `CarMesh` draws.
 */
export interface CrewStation {
  role: PitRole;
  /** Which wheel this member belongs to, for the twelve who belong to one. */
  corner: WheelCorner | null;
  x: number;
  z: number;
  heading: number;
}

/** Half-track and half-wheelbase of the car the crew are working on, metres. */
const HALF_TRACK_M = 0.86;
const FRONT_AXLE_Z = 1.72;
const REAR_AXLE_Z = -1.68;

/**
 * Every job over the wall, in one list.
 *
 * Twenty-one people. Count them: twelve on the wheels, two jacks, two spare
 * jacks, two stabilisers, two on the front wing, one spotter. That is the crew
 * in the reference diagram and it is the crew that appears in the pit lane.
 *
 * The three per wheel are stacked, not spread out. The gunman is ON the nut;
 * the wheel-off man is immediately outboard and slightly behind, because he
 * takes the wheel rearwards out of the arch; the wheel-on man is outboard and
 * slightly ahead with the new tyre already held at hub height. Standing them in
 * a neat row would be tidy and wrong — the reason a stop looks like a scrum is
 * that three people are working inside one metre of each other.
 */
export const PIT_CREW: readonly CrewStation[] = (() => {
  const out: CrewStation[] = [];
  // +x is the car's LEFT. That is the convention the rest of the project uses —
  // the world is right-handed with y up, so for a car whose nose is its own +z
  // the direction `forward x up` is its RIGHT and comes out as local -x — and
  // getting it backwards here puts the left-front crew on the right-front
  // wheel, which is invisible until a wheel is animated onto a hub four metres
  // from where the man fitting it is standing.
  const cornerAt = (c: WheelCorner): { x: number; z: number; side: number } => {
    const side = c === 'FL' || c === 'RL' ? 1 : -1;
    return { x: side * HALF_TRACK_M, z: c[0] === 'F' ? FRONT_AXLE_Z : REAR_AXLE_Z, side };
  };

  for (const c of WHEEL_CORNERS) {
    const { x, z, side } = cornerAt(c);
    // Facing the wheel: from outboard, that is facing back across the car.
    const inward = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    // Tucked in tighter than they look on television, because the working lane
    // is only about four metres wide with a two-metre car in the middle of it.
    // At a comfortable-looking 1.1m outboard the wheel carriers stood past the
    // divider line and out in the fast lane, which other cars are driving down.
    out.push({ role: 'gun', corner: c, x: x + side * 0.58, z, heading: inward });
    out.push({ role: 'wheel-off', corner: c, x: x + side * 0.92, z: z - 0.78, heading: inward + side * 0.5 });
    out.push({ role: 'wheel-on', corner: c, x: x + side * 0.98, z: z + 0.74, heading: inward - side * 0.5 });
  }

  // The jacks. The front jack man stands IN FRONT of the car and the driver
  // aims the nose at his jack; the rear jack man comes in from behind the
  // moment the car has passed him.
  out.push({ role: 'front-jack', corner: null, x: 0, z: FRONT_AXLE_Z + 1.85, heading: Math.PI });
  out.push({ role: 'rear-jack', corner: null, x: 0, z: REAR_AXLE_Z - 1.75, heading: 0 });
  // A spare of each, front and rear, standing off the working area.
  //
  // Both on the GARAGE side (-x here, because +x is the car's left and the
  // garages are on its right when the lane runs the normal way round). A spare
  // jack man standing out in the fast lane is a man standing in the road other
  // cars are driving down at 80 km/h, and that is the one place in a pit lane
  // nobody stands.
  out.push({ role: 'spare-jack', corner: null, x: -2.6, z: FRONT_AXLE_Z + 1.4, heading: Math.PI - 0.5 });
  out.push({ role: 'spare-jack', corner: null, x: -2.6, z: REAR_AXLE_Z - 1.3, heading: 0.5 });

  // Steadying the car, one each side, at the sidepod.
  out.push({ role: 'stabiliser', corner: null, x: -1.35, z: 0.05, heading: Math.PI / 2 });
  out.push({ role: 'stabiliser', corner: null, x: 1.35, z: 0.05, heading: -Math.PI / 2 });

  // The front wing pair, one each side of the nose.
  out.push({ role: 'front-wing', corner: null, x: -0.92, z: FRONT_AXLE_Z + 1.05, heading: Math.PI + 0.35 });
  out.push({ role: 'front-wing', corner: null, x: 0.92, z: FRONT_AXLE_Z + 1.05, heading: Math.PI - 0.35 });

  // The spotter, back and on the garage side, where he can see up the lane past
  // the car without standing in the fast lane it is coming down.
  out.push({ role: 'spotter', corner: null, x: -2.4, z: REAR_AXLE_Z - 2.6, heading: 0.25 });

  return out;
})();

/** How many people go over the wall. Twenty-one, and it is checked. */
export const PIT_CREW_SIZE = PIT_CREW.length;

// ===========================================================================
// Crew quality
// ===========================================================================

/**
 * The stationary time a crew at the very top of the sport produces on a clean
 * stop, seconds.
 *
 * This is the floor of the career's upgrade path, not a number anyone hits
 * every time: the individual stop still scatters around it, and the record is
 * below it because a record is the left tail of a distribution and not its
 * centre.
 */
export const PIT_CREW_TIME_ELITE_S = 1.9;

/**
 * The same for a crew at the bottom of the grid, seconds.
 *
 * A backmarker team's clean stop, with nothing going wrong, is most of a second
 * slower than a front-runner's — and it goes wrong more often, which is where
 * the rest of the difference comes from.
 */
export const PIT_CREW_TIME_POOR_S = 3.2;

/**
 * Crew quality on 0..1, from the one number the career actually moves.
 *
 * `Team.performance.pitCrewTimeS` IS the crew-quality parameter. It is a time
 * in seconds because that is the unit a player understands and the unit the
 * career's upgrade screen will want to print — "2.6s crew" means something,
 * "crew rating 0.42" does not — and because it was already there and already
 * wired to the grid. Everything else in this file is derived from it: the
 * scatter of a clean stop, the chance of a fumble, and how bad a fumble is.
 *
 * A career that wants a better crew lowers this number. Nothing else has to
 * change.
 */
export function pitCrewQuality(crewTimeS: number): number {
  const span = PIT_CREW_TIME_POOR_S - PIT_CREW_TIME_ELITE_S;
  const q = (PIT_CREW_TIME_POOR_S - crewTimeS) / span;
  return q < 0 ? 0 : q > 1 ? 1 : q;
}

// ===========================================================================
// What can go wrong
// ===========================================================================

/**
 * The named ways a stop is lost.
 *
 * Every one of these is a thing that happens on television several times a
 * season, and each has its own signature: a sticking gun is half a second and
 * the crowd barely notices, a cross-threaded nut is four seconds and a race,
 * and a wheel that is not ready is the corner man visibly stepping backwards
 * with the tyre still in his hands.
 *
 * They are per-corner, except the jack and the release — which is exactly why
 * the release light has to wait for the SLOWEST corner rather than for an
 * average. Three corners doing 1.9s and one doing 4.2s is a 4.2s stop.
 */
export type PitProblem =
  /** The gun does not engage the nut first time and has to be re-seated. */
  | 'gun-slip'
  /** The nut goes on crooked. The nightmare: it has to come off and go back. */
  | 'cross-thread'
  /** The new wheel is not at the hub when the old one comes off. */
  | 'wheel-late'
  /** The jack does not lift, or is knocked off; the spare comes in. */
  | 'jack'
  /** Nothing wrong with the stop at all — the light was held for traffic. */
  | 'held';

/** One corner's contribution to the stop. */
export interface CornerResult {
  corner: WheelCorner;
  /** When this corner's gun reported the nut tight, seconds after the stop. */
  doneS: number;
  problem: PitProblem | null;
}

/**
 * A stop, resolved: everything that is going to happen, decided when the car
 * comes to rest.
 *
 * Resolved up front rather than rolled step by step because the animation has
 * to know the whole shape of the stop in advance in order to play it — a crew
 * member cannot start fitting a wheel at a time that has not been decided yet
 * — and because the stationary time has to be one number that the timing
 * screen, the strategy model and the career can all agree on.
 */
export interface PitStopResult {
  /** Total time the car is stationary, seconds. Everything is inside this. */
  stationaryS: number;
  /** The wheel change alone, without extra work or a held light. */
  wheelChangeS: number;
  /** Each corner's own time and its own problem. */
  corners: readonly CornerResult[];
  /** The worst thing that happened, or null for a clean stop. */
  problem: PitProblem | null;
  /** Seconds the car sat with the work finished and the light still red. */
  heldS: number;
  /** Seconds added by work the wheel crew were not doing: a new nose. */
  extraWorkS: number;
  /** Seconds added by a penalty served stationary in the box. */
  penaltyS: number;
  /**
   * Seconds the crew must stand back BEFORE any work, at the front of the stop.
   *
   * A five- or ten-second time penalty served in the box. Everything else in
   * this result is measured from the end of it: `corners[].doneS` already has
   * it added on, so a caller walking the choreography does not have to know
   * the penalty exists.
   */
  holdBeforeWorkS: number;
  /** True if the front wing assembly is being changed. */
  noseChange: boolean;
}

/** Everything the model needs to know about the stop being asked for. */
export interface PitStopRequest {
  /** The team's crew-quality parameter: `Team.performance.pitCrewTimeS`. */
  crewTimeS: number;
  /** Seconds of extra work: a nose change, mostly. Added after the wheels. */
  extraWorkS: number;
  /** Seconds of stationary penalty: a stop-go is ten. */
  penaltyS: number;
  /**
   * Seconds the crew must stand back before touching the car.
   *
   * `CarEntry.penaltyHoldS()`. Art. B1.9.5c: a car serving a five- or
   * ten-second penalty in the pit lane "may not be worked on until the Car has
   * been stationary for the duration of the penalty. In this context, touching
   * the Car or driver by hand or tools or equipment will all constitute
   * working."
   *
   * It is a state at the FRONT of the stop and not a number added to the end of
   * it, and the difference is the whole point: for five seconds the car sits
   * there with twenty-one people visibly standing off it, and only then does
   * anything happen. That is why a five-second penalty costs a driver far more
   * than five seconds — the stop still has to happen afterwards, at full
   * length — and it is the only version of the rule a player can watch.
   */
  holdBeforeWorkS: number;
  /** True when the front wing assembly is coming off. */
  noseChange: boolean;
  /**
   * How likely the release is to be held for traffic, 0..1.
   *
   * NOT a crew-quality term. This is the strategist's problem — the car in the
   * fast lane that the spotter can see and the driver cannot — and the career
   * hangs a separate upgrade off it, so it comes in from outside.
   */
  trafficRisk: number;
}

/**
 * Chance that one corner suffers each kind of problem, for a perfect crew and
 * for a poor one.
 *
 * The elite figures are what a top team's season looks like: four wheels times
 * about forty stops is 160 corner-attempts, and a leading team will have two or
 * three visibly slow corners in a year and one genuinely disastrous nut.
 */
const PROBLEM_RATES: Record<'gun-slip' | 'cross-thread' | 'wheel-late', [number, number]> = {
  // [elite, poor] probability, per corner, per stop.
  'gun-slip': [0.012, 0.055],
  'cross-thread': [0.0022, 0.011],
  'wheel-late': [0.005, 0.030],
};

/** Seconds a problem costs, [best case, worst case]. */
const PROBLEM_COST_S: Record<PitProblem, [number, number]> = {
  'gun-slip': [0.25, 0.9],
  'cross-thread': [1.4, 4.2],
  'wheel-late': [0.4, 1.6],
  jack: [0.8, 2.6],
  held: [0, 0],
};

/** Chance the jack fails and the spare has to come in, [elite, poor]. */
const JACK_FAILURE_RATE: [number, number] = [0.0015, 0.008];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Resolves a pit stop.
 *
 * The shape of the model, and why it is this shape:
 *
 *   1. Each corner is drawn INDEPENDENTLY. It gets a clean time centred on the
 *      crew's standard with a scatter that tightens as the crew improves, and
 *      then its own chance of its own problem.
 *
 *   2. The wheel change ends when the LAST corner ends. That is not a modelling
 *      convenience, it is how the release works: the light cannot go green
 *      until all four guns have reported, so the stop is a max and not a mean.
 *      It is also why a stop is longer than one corner's work — with four
 *      independent draws the maximum sits well above the average, which is
 *      exactly the asymmetry a real stop has.
 *
 *   3. Extra work and stationary penalties are added AFTER, because they are
 *      serial: the nose crew cannot start until the car is on its jacks and the
 *      ten seconds of a stop-go begins when the car stops.
 *
 *   4. The held light is added last, because it is the last thing that happens
 *      and because it is the one delay that is nobody in the box's fault.
 */
export function resolvePitStop(req: PitStopRequest, rng: Rng): PitStopResult {
  const q = pitCrewQuality(req.crewTimeS);
  // Nothing happens until the hold has elapsed, so every time below is measured
  // from the end of it rather than from the moment the car stopped.
  const hold = Math.max(req.holdBeforeWorkS, 0);

  // The clean stationary time this crew is aiming at. `crewTimeS` is the
  // WHOLE stop, so the per-corner work has to come out a little under it: the
  // jacks going up and down and the release itself are inside the same number
  // and are not the wheel crew's time.
  const overheadS = JACKS_UP_S + JACKS_DOWN_S + RELEASE_REACTION_S;
  const cornerTarget = Math.max(req.crewTimeS - overheadS, 0.45);

  // Scatter of one corner about the target. A crew that is quick is also
  // repeatable — that is most of what "a good crew" means — so the spread
  // closes with quality rather than staying constant.
  const sigma = lerp(0.20, 0.055, q);

  const corners: CornerResult[] = [];
  let slowest = 0;
  let worst: PitProblem | null = null;
  let worstCost = 0;

  for (const corner of WHEEL_CORNERS) {
    // Clean work, clamped so the tail cannot produce a physically silly corner.
    let t = cornerTarget + rng.gaussian(0, sigma);
    if (t < cornerTarget * 0.72) t = cornerTarget * 0.72;

    let problem: PitProblem | null = null;
    // Ordered worst-first: a cross-threaded nut is not also a gun slip.
    for (const kind of ['cross-thread', 'gun-slip', 'wheel-late'] as const) {
      const [pElite, pPoor] = PROBLEM_RATES[kind];
      if (rng.chance(lerp(pPoor, pElite, q))) {
        problem = kind;
        const [lo, hi] = PROBLEM_COST_S[kind];
        // A better crew recovers from the same mistake faster: they notice it
        // sooner and the man beside them is already moving.
        const cost = rng.range(lo, lerp(hi, lo + (hi - lo) * 0.55, q));
        t += cost;
        if (cost > worstCost) { worstCost = cost; worst = kind; }
        break;
      }
    }

    corners.push({ corner, doneS: hold + JACKS_UP_S + t, problem });
    if (corners[corners.length - 1].doneS > slowest) slowest = corners[corners.length - 1].doneS;
  }

  // The jack. One failure holds the whole car up, literally, and the spare goes
  // in — which is what the spare is standing there for.
  let jackLossS = 0;
  if (rng.chance(lerp(JACK_FAILURE_RATE[1], JACK_FAILURE_RATE[0], q))) {
    const [lo, hi] = PROBLEM_COST_S.jack;
    jackLossS = rng.range(lo, hi);
    if (jackLossS > worstCost) { worstCost = jackLossS; worst = 'jack'; }
  }

  // `slowest` already includes the hold, because every corner's `doneS` does.
  const wheelChangeS = slowest + jackLossS + JACKS_DOWN_S + RELEASE_REACTION_S;

  // Held at the light. The spotter's call, and the one delay the crew cannot
  // shorten: the car alongside has right of way in the fast lane and releasing
  // into it is an unsafe release.
  let heldS = 0;
  if (rng.chance(req.trafficRisk)) {
    heldS = rng.range(0.2, 1.6);
    if (heldS > worstCost) { worstCost = heldS; worst = 'held'; }
  }

  const stationaryS = wheelChangeS + req.extraWorkS + req.penaltyS + heldS;

  return {
    stationaryS,
    wheelChangeS,
    corners,
    problem: worst,
    heldS,
    extraWorkS: req.extraWorkS,
    penaltyS: req.penaltyS,
    holdBeforeWorkS: hold,
    noseChange: req.noseChange,
  };
}

// ===========================================================================
// The choreography
// ===========================================================================

/**
 * Fixed costs at each end of the stop, seconds.
 *
 * These are not the wheel crew's time and they do not improve much with
 * practice, because they are limited by the jacks and by a human reaction:
 *
 *   - the jacks lift the car in about a fifth of a second, both together, the
 *     instant it stops;
 *   - dropping it is quicker than lifting it, because gravity does it;
 *   - and the release is a light, so what is left is the driver seeing it.
 */
export const JACKS_UP_S = 0.22;
export const JACKS_DOWN_S = 0.14;
export const RELEASE_REACTION_S = 0.10;

/** Where a stop has got to, as a phase the animation and the HUD can name. */
export type PitPhase =
  /** The car is not in the box yet; the crew are set and waiting. */
  | 'waiting'
  /**
   * Stationary, serving a time penalty, with the crew standing off the car.
   *
   * Nobody may touch it — Art. B1.9.5c — so the jacks are not in, no gun is on
   * a nut, and the whole stop is still ahead of the driver.
   */
  | 'penalty-hold'
  /** Stationary, jacks going in and up. */
  | 'jacking'
  /** Guns on the nuts, wheels coming off and going on. */
  | 'wheels'
  /** All four reported; the car is coming down. */
  | 'dropping'
  /** Work finished, light still red — held for traffic. */
  | 'held'
  /** Green. Go. */
  | 'released';

/**
 * One corner's own progress, 0..1 through each of its four sub-tasks.
 *
 * The animation needs sub-task progress rather than a phase name, because the
 * whole point of the choreography is that the four corners are NOT in step: the
 * left front can be tightening while the right rear is still waiting for its
 * wheel, and a crew that moves in unison is the tell that the animation is a
 * loop rather than a stop.
 */
export interface CornerProgress {
  /** Gun on the nut and spinning it off. */
  loosening: number;
  /** Old wheel coming off and going back. */
  removing: number;
  /** New wheel going on. */
  fitting: number;
  /** Gun tightening. */
  tightening: number;
  /** True once this corner's gun has reported. */
  done: boolean;
}

/** The whole stop at one instant. */
export interface PitStopProgress {
  phase: PitPhase;
  /** Seconds since the car came to rest. */
  elapsedS: number;
  /** How far the car is off the ground, 0..1. */
  jack: number;
  /** Per corner, in `WHEEL_CORNERS` order. */
  corners: readonly CornerProgress[];
  /** The front wing crew's work, 0..1, or 0 when there is none. */
  nose: number;
  /** True when the release light is green. */
  green: boolean;
}

/**
 * Fractions of one corner's work spent on each sub-task.
 *
 * A corner's job is: get the gun on and the nut off, pull the wheel back and
 * out, swing the new one on, drive the nut home. The nut coming off and going
 * back on are the two long parts — the gun is doing the same job twice — and
 * the two wheel movements between them are quick, because the wheel-off man
 * pulls and the wheel-on man is already there.
 *
 * They overlap, and the overlap is the interesting bit: the new wheel starts
 * moving towards the hub before the old one is clear, which is why three people
 * per wheel is worth it at all.
 */
const CORNER_PLAN: { from: number; to: number }[] = [
  { from: 0.00, to: 0.34 },  // loosening
  { from: 0.30, to: 0.55 },  // removing
  { from: 0.48, to: 0.72 },  // fitting
  { from: 0.66, to: 1.00 },  // tightening
];

const span = (t: number, from: number, to: number): number => {
  if (t <= from) return 0;
  if (t >= to) return 1;
  return (t - from) / (to - from);
};

/**
 * Where a resolved stop has got to `elapsedS` after the car stopped.
 *
 * Pure, and called once per frame for at most one car, so it allocates into a
 * caller-supplied object rather than building a new one every frame.
 */
export function pitStopProgress(
  r: PitStopResult, elapsedS: number, into: PitStopProgress,
): PitStopProgress {
  into.elapsedS = elapsedS;

  // The jacks. Up fast at the start, down fast at the end, and the "end" is
  // when the last gun reported — not when the car is released, because a car
  // held at the light is sitting on its wheels with the crew standing back.
  const lastDone = Math.max(...r.corners.map((c) => c.doneS));
  const dropStart = lastDone;
  const dropEnd = lastDone + JACKS_DOWN_S;
  const hold = r.holdBeforeWorkS;
  const up = span(elapsedS, hold, hold + JACKS_UP_S);
  const down = span(elapsedS, dropStart, dropEnd);
  into.jack = up * (1 - down);

  for (let i = 0; i < r.corners.length; i++) {
    const c = r.corners[i];
    const work = c.doneS - hold - JACKS_UP_S;
    const t = work <= 0 ? 1 : span(elapsedS, hold + JACKS_UP_S, c.doneS);
    const p = into.corners[i] as CornerProgress;
    p.loosening = span(t, CORNER_PLAN[0].from, CORNER_PLAN[0].to);
    p.removing = span(t, CORNER_PLAN[1].from, CORNER_PLAN[1].to);
    p.fitting = span(t, CORNER_PLAN[2].from, CORNER_PLAN[2].to);
    p.tightening = span(t, CORNER_PLAN[3].from, CORNER_PLAN[3].to);
    p.done = elapsedS >= c.doneS;
  }

  // The nose crew work through the whole stop when there is a nose to change,
  // which is why it costs what it costs: the car cannot leave until they are
  // clear of it whatever the wheel crew have done.
  into.nose = r.noseChange
    ? span(elapsedS, hold + JACKS_UP_S, hold + JACKS_UP_S + Math.max(r.extraWorkS, 0.5))
    : 0;

  into.green = elapsedS >= r.stationaryS;
  into.phase = into.green
    ? 'released'
    : elapsedS < hold
      ? 'penalty-hold'
    : elapsedS < hold + JACKS_UP_S
      ? 'jacking'
      : elapsedS < dropStart
        ? 'wheels'
        // The reaction time is part of the drop, not a hold: the work is
        // finished, the car is down, and what is left is the light coming on
        // and the driver seeing it. Calling that 'held' put a "HELD FOR
        // TRAFFIC" caption on the last tenth of every clean stop.
        : elapsedS < dropEnd + r.extraWorkS + r.penaltyS + RELEASE_REACTION_S
          ? 'dropping'
          : 'held';
  return into;
}

/** A progress object to hand to `pitStopProgress`. */
export function makePitStopProgress(): PitStopProgress {
  return {
    phase: 'waiting',
    elapsedS: 0,
    jack: 0,
    corners: WHEEL_CORNERS.map(() => ({
      loosening: 0, removing: 0, fitting: 0, tightening: 0, done: false,
    })),
    nose: 0,
    green: false,
  };
}
