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
  const boxS = (slot: number): number =>
    norm(lane.boxS + PIT_ROW_ANCHOR_M
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
    boxS,
  };
}
