import type { TrackDefinition } from '../data/tracks/TrackDefinition';

/**
 * The shape of the pit lane, in one place.
 *
 * `PitLane` in the track data says only where the lane starts, where it ends
 * and how far it sits from the centreline. That is everything the *simulation*
 * needs — the lane is a speed limit and a lateral offset — but a pit lane you
 * can look at needs a cross-section and a plan: where the wall stands, where
 * the fast lane ends and the working lane begins, where the garage frontage is,
 * and, most of all, where the lane peels off the circuit and where it rejoins.
 *
 * Deriving all of that here rather than inline in the mesh builder is what lets
 * the painted box sit under the garage the paddock builds, the entry hatching
 * end exactly on the pit-entry line, and the exit blend line converge onto the
 * track edge instead of stopping in mid-air.
 *
 * Every lateral distance below is a MAGNITUDE from the centreline; `sign` says
 * which side of the circuit the lane is on. Cross-section, outwards:
 *
 *   centreline · · · track edge · · · apron · · | wall | · · fast lane · ·
 *   · · divider · · working lane · · | garages
 *
 * Distances along the lap are handled as a "lane parameter" `u`: metres from
 * the point the lane splits off the circuit. The lane wraps past the
 * start/finish line on most circuits, so measuring from the split is the only
 * way to write the profile as a straight run of monotonically increasing
 * numbers.
 */

/**
 * Half-width of the pit lane.
 *
 * Six metres either side of the lane centre, matching the offset the physics
 * pins a car in the lane to and the frontage the paddock's garages are built
 * on. Change it here and the paint, the walls and the buildings all move
 * together.
 */
const LANE_HALF_M = 6;
/**
 * The fast lane's share of the lane.
 *
 * A car under the limiter runs down the lane centre, so the divider has to sit
 * outside it with room to spare — otherwise the "fast lane" line is painted
 * directly under the cars using it.
 */
const DIVIDER_OFFSET_M = 2.0;
/** Centreline of the pit wall, measured in from the lane's track-side edge. */
const WALL_INSET_M = 0.5;
const WALL_THICK_M = 0.45;
/** Height of the pit wall. */
export const PIT_WALL_HEIGHT_M = 1.05;

/** How far before the pit-entry line the lane starts peeling off the circuit. */
export const PIT_ENTRY_LEAD_M = 55;
/** How far past the pit-entry line the lane reaches the fast lane's full width. */
export const PIT_ENTRY_OPEN_M = 45;
/** How long the working lane takes to open out once the lane is full width. */
export const PIT_WORKING_OPEN_M = 45;
/** The working lane closes up this far before the exit. */
export const PIT_WORKING_END_M = 80;
/** How far past the exit the exit road has converged onto the track edge. */
export const PIT_EXIT_JOIN_M = 55;
/** How far past the exit the exit road has narrowed away entirely. */
export const PIT_EXIT_MERGE_M = 170;

/**
 * The concrete apron at the garage mouth: how far it reaches out into the
 * working lane, and how far it stands proud of it.
 *
 * The paddock builds the apron; the circuit builder paints the pit boxes on top
 * of it. Both need the same two numbers, and a box painted at road level would
 * simply disappear underneath a step twelve centimetres high.
 */
export const PIT_APRON_DEPTH_M = 3.3;
export const PIT_APRON_HEIGHT_M = 0.12;

/** Spacing between pit boxes: one per car, two per team garage. */
export const PIT_GARAGE_SPACING_M = 11;
/** Boxes painted. A Formula 1 pit lane has one per car. */
export const PIT_GARAGE_COUNT = 20;
/**
 * Where the row of boxes is anchored, relative to the box the simulation stops
 * cars in. The paddock's garage bays are laid out from the same point, so the
 * paint lands under the buildings.
 */
export const PIT_ROW_ANCHOR_M = 8;

export interface LaneEdges {
  /** Magnitude of the lane's track-side edge. */
  inner: number;
  /** Magnitude of the lane's far edge. */
  outer: number;
}

export interface PitLaneGeometry {
  /** +1 if the lane is left of the centreline, -1 if right. */
  sign: number;
  /** Magnitude of the lane centre — where a car under the limiter runs. */
  centre: number;
  /** The lane's track-side edge, where the wall stands. */
  laneInner: number;
  /** Centreline of the pit wall. */
  wallMag: number;
  wallThick: number;
  /** The solid line dividing the fast lane from the working lane. */
  divider: number;
  /** The garage frontage, and the lane's outer edge. */
  garageFace: number;
  /** Distance along the lap at which the entry road begins to split away. */
  splitS: number;
  /** Lane parameter at which the fast lane reaches full width. */
  entryOpenU: number;
  /** Lane parameter at which the working lane and the garages begin. */
  workingStartU: number;
  /** Lane parameter at which the working lane starts to close up. */
  workingEndU: number;
  /** Lane parameter of the pit-exit line. */
  exitU: number;
  /** Total lane parameter covered, including the exit road's merge. */
  totalU: number;
  /** Lane parameter for a distance along the lap. */
  u(s: number): number;
  /** True when this distance along the lap runs alongside the pit lane. */
  covers(s: number): boolean;
  /** The lane's two edges at a lane parameter, given the track's half width. */
  edgesAt(u: number, halfWidth: number): LaneEdges;
  /**
   * Distance along the lap the row of boxes is anchored at.
   *
   * The track data's `pitLane.boxS` is a wish; this is where the row actually
   * ended up once it was made to fit inside the working lane. Anything laid out
   * alongside the boxes — garages, crews, the paint — has to use THIS, or it
   * describes a pit lane the simulation is not running.
   */
  rowAnchorS: number;
  /** Distance along the lap of pit box `slot`, 0 being nearest the exit. */
  boxS(slot: number): number;
}

const smooth = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function pitLaneGeometry(def: TrackDefinition, lengthM: number): PitLaneGeometry {
  const lane = def.pitLane;
  const sign = Math.sign(lane.lateralOffsetM) || -1;
  const centre = Math.abs(lane.lateralOffsetM);

  const laneInner = centre - LANE_HALF_M;
  const garageFace = centre + LANE_HALF_M;
  const divider = centre + DIVIDER_OFFSET_M;
  const wallMag = laneInner + WALL_INSET_M;

  const norm = (x: number): number => ((x % lengthM) + lengthM) % lengthM;

  const splitS = norm(lane.entryS - PIT_ENTRY_LEAD_M);
  // Length of the lane proper: from where it splits off to the pit-exit line.
  const exitU = norm(lane.exitS - splitS);
  const entryOpenU = Math.min(PIT_ENTRY_LEAD_M + PIT_ENTRY_OPEN_M, exitU * 0.3);
  const workingStartU = Math.min(entryOpenU + PIT_WORKING_OPEN_M, exitU * 0.45);
  const workingEndU = Math.max(workingStartU + 20, exitU - PIT_WORKING_END_M);
  const totalU = exitU + PIT_EXIT_MERGE_M;

  const u = (s: number): number => norm(s - splitS);
  const covers = (s: number): boolean => u(s) <= totalU;

  const edgesAt = (uu: number, halfWidth: number): LaneEdges => {
    // The lane can never be narrower than the track edge it grows out of.
    const hw = Math.min(halfWidth, laneInner - 0.5);
    if (uu <= entryOpenU) {
      // The split: a wedge opening out from the track edge to the fast lane.
      const t = smooth(uu / entryOpenU);
      return { inner: lerp(hw, laneInner, t), outer: lerp(hw, divider, t) };
    }
    if (uu <= workingStartU) {
      // The working lane opens out alongside the first garage.
      const t = smooth((uu - entryOpenU) / (workingStartU - entryOpenU));
      return { inner: laneInner, outer: lerp(divider, garageFace, t) };
    }
    if (uu <= workingEndU) return { inner: laneInner, outer: garageFace };
    if (uu <= exitU) {
      // Past the last garage the working lane closes up, leaving the fast lane.
      const t = smooth((uu - workingEndU) / (exitU - workingEndU));
      return { inner: laneInner, outer: lerp(garageFace, divider, t) };
    }
    // The exit road: converges onto the track edge, then narrows away.
    const v = uu - exitU;
    return {
      inner: lerp(laneInner, hw, smooth(v / PIT_EXIT_JOIN_M)),
      outer: lerp(divider, hw, smooth(v / PIT_EXIT_MERGE_M)),
    };
  };

  // Two boxes per team garage, laid out from the same anchor the paddock builds
  // its bays from, so a painted box always has a garage behind it.
  //
  // The row is laid out BACKWARDS from the anchor — box 0 nearest the exit,
  // box 19 furthest up the lane — so twenty boxes reach 203m back from it. The
  // track data's `boxS` is a single hand-placed number that predates there
  // being twenty of them, and on several circuits the row it anchors runs off
  // the top of the lane: at Bahrain the anchor is 235m down a lane whose
  // working section starts at 145m, so the last four boxes were painted level
  // with, or BEFORE, the pit entry line itself.
  //
  // That is not a cosmetic problem. A car is serviced where its box is, so a
  // car whose box sits before the entry can never reach it: it enters the lane,
  // drives the length of it without ever passing its own mark, leaves
  // unserviced, and — its strategy still calling for a stop — comes straight
  // back in on the next lap, for the rest of the race. Half the field at
  // Bahrain was in that loop, entering the pit lane twenty times and stopping
  // never.
  //
  // So the row is fitted to the lane it is painted in. The working lane is
  // where the garages are by definition (`workingStartU`/`workingEndU` above),
  // and it begins ~90m past the pit entry — comfortably more than the 41m a car
  // needs to stop from the 80km/h limit. Where the hand-placed anchor already
  // fits, it is left exactly where it is.
  const rowFrontM = PIT_GARAGE_SPACING_M * 0.5;
  const rowBackM =
    Math.floor((PIT_GARAGE_COUNT - 1) / 2) * (PIT_GARAGE_SPACING_M * 2) + PIT_GARAGE_SPACING_M * 0.5;
  const anchorU = (() => {
    const wanted = u(norm(lane.boxS + PIT_ROW_ANCHOR_M));
    const lo = workingStartU + rowBackM;
    const hi = workingEndU - rowFrontM;
    // A lane too short to hold twenty boxes at full pitch: centre them and let
    // the row overhang symmetrically rather than dropping it off one end.
    if (hi < lo) return (workingStartU + workingEndU) * 0.5 + (rowBackM - rowFrontM) * 0.5;
    return wanted < lo ? lo : wanted > hi ? hi : wanted;
  })();
  const rowAnchorS = norm(splitS + anchorU);

  const boxS = (slot: number): number =>
    norm(rowAnchorS
      - Math.floor(slot / 2) * (PIT_GARAGE_SPACING_M * 2)
      + (slot % 2 === 0 ? PIT_GARAGE_SPACING_M * 0.5 : -PIT_GARAGE_SPACING_M * 0.5));

  return {
    sign,
    centre,
    laneInner,
    wallMag,
    wallThick: WALL_THICK_M,
    divider,
    garageFace,
    splitS,
    entryOpenU,
    workingStartU,
    workingEndU,
    exitU,
    totalU,
    u,
    covers,
    edgesAt,
    rowAnchorS,
    boxS,
  };
}

/**
 * Garage bay pitch: one bay per team, and a team runs two cars, so a bay is two
 * pit boxes wide.
 */
export const PIT_BAY_PITCH_M = PIT_GARAGE_SPACING_M * 2;
/** Slack at each end of the garage row where trackside furniture is suppressed. */
export const PIT_ROW_MARGIN_M = 26;

/**
 * True where the paddock occupies the ground beside the circuit, so the
 * trackside furniture must give way to it.
 *
 * The barrier line, the catch fencing, the sponsor hoardings and the set
 * dressing are all laid down blindly at a fixed offset from the track edge all
 * the way round the lap — which, along the pits, puts a steel armco and a
 * five-metre debris fence straight *through* the pit lane and drops trees in
 * the middle of the garages.
 *
 * This lives here, with the rest of the pit lane's plan, rather than with the
 * geometry that draws the paddock: the headless simulation needs it too, and
 * the paddock module cannot be loaded without Three.js.
 *
 * IT MUST BE MEASURED FROM `rowAnchorS`, NOT FROM `pitLane.boxS`.
 *
 * It used to use the raw `boxS` from the track data, and that is the SAME
 * mistake the row layout above documents itself as fixing — made a second time,
 * fifty lines further down, by a function that then disagreed with everything
 * it was supposed to be describing. The two anchors are 106m apart at Bahrain,
 * and 130m at Monaco, so the run of ground this function called "the paddock"
 * was displaced from the row of garages the paddock actually builds by most of
 * the length of the row.
 *
 * Everything downstream inherited that displacement, and one of the results is
 * a bug you can drive into:
 *
 *   - `buildPitWallObstacles` builds the SOLID garage frontage — the far side
 *     of the pit lane, the thing that stops a car leaving the lane through the
 *     buildings — only where this returns true. At Bahrain that put the wall
 *     across lane metres 10..280 while the garages, the painted boxes and the
 *     cars being serviced in them are at 145..354. Boxes 0 to 6 — seven of the
 *     twenty, including the ones nearest the pit exit — had a drawn garage in
 *     front of them and no wall at all, so a car that ran wide there went
 *     straight through the building and out the back of the paddock.
 *
 *   - the circuit builder and the scenery placer both suppress trackside
 *     furniture here, so the far end of the garage row was getting armco,
 *     debris fencing and trees planted through it, while an invisible barrier
 *     was suppressed over 130m of empty ground before the row started.
 *
 * `rowAnchorS` is the fitted anchor — where the row of boxes ACTUALLY ended up
 * once it was made to fit inside the working lane — and it is what the paint,
 * the garages, the crews and the race engine all use.
 */
export function isPaddockGround(
  track: { def: TrackDefinition; dist: Float32Array; length: number },
  node: number,
  side: -1 | 1,
): boolean {
  const lane = track.def.pitLane;
  if (side !== (Math.sign(lane.lateralOffsetM) || -1)) return false;
  const L = track.length;
  const rowLen = (PIT_GARAGE_COUNT / 2 - 1) * PIT_BAY_PITCH_M;
  const from = paddockAnchorS(track.def, L) - rowLen - PIT_BAY_PITCH_M / 2 - PIT_ROW_MARGIN_M;
  let d = (track.dist[node] - from) % L;
  if (d < 0) d += L;
  return d <= rowLen + PIT_BAY_PITCH_M + PIT_ROW_MARGIN_M * 2;
}

/**
 * `pitLaneGeometry(def).rowAnchorS`, cached per track definition.
 *
 * `isPaddockGround` is asked once per spline node per side — several thousand
 * times per circuit build, from three separate passes — and solving the whole
 * lane plan on each of those calls turned a cheap predicate into a measurable
 * share of the load time. The plan is a pure function of the definition and the
 * lap length, so it is solved once and kept.
 */
const anchorCache = new WeakMap<TrackDefinition, { length: number; anchorS: number }>();

function paddockAnchorS(def: TrackDefinition, lengthM: number): number {
  const hit = anchorCache.get(def);
  if (hit && hit.length === lengthM) return hit.anchorS;
  const anchorS = pitLaneGeometry(def, lengthM).rowAnchorS;
  anchorCache.set(def, { length: lengthM, anchorS });
  return anchorS;
}
