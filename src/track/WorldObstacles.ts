import {
  pitLaneGeometry,
  isPaddockGround,
  PIT_WALL_HEIGHT_M,
  type PitLaneGeometry,
} from './PitGeometry';
import type { TrackSpline } from './TrackSpline';

/**
 * Where the world's solid objects stand, and what the ground beside the circuit
 * is allowed to have built on it.
 *
 * This module exists because two separate bugs turned out to be the same bug.
 *
 *   1. Set dressing was placed at a lateral offset from whichever node of the
 *      spline it happened to be generated at, and nothing ever checked the rest
 *      of the lap. A circuit is a closed loop that folds back on itself, so an
 *      offset that is clear of the road at node A routinely lands squarely ON
 *      the road at node B — which is how a thirty-metre office block ended up
 *      straddling the racing surface at Monaco, with the player's car parked
 *      inside it.
 *   2. Nothing outside the track's own barrier line was solid. Buildings,
 *      grandstands and the pit wall were all scenery in the literal sense: a
 *      car drove through them without so much as a scrape.
 *
 * Both need the same thing — a description of the world's geometry that is
 * independent of Three.js, so the headless simulation and the renderer agree on
 * it exactly. The renderer draws what this returns; the race engine collides
 * against what this returns. Nothing can be drawn that is not solid, and
 * nothing can be solid that is not drawn.
 */

// ===========================================================================
// Keep-out field
// ===========================================================================

/**
 * Every square metre a car is supposed to be able to reach, as a set of discs
 * in a coarse grid hash.
 *
 * A disc per node of the centreline (radius = the track's half width there),
 * plus a disc per few metres of pit lane, is a good enough description of the
 * drivable world for the question this has to answer: "is this footprint clear
 * of the circuit — ALL of the circuit — by at least this margin?" Testing the
 * whole lap by brute force would be a thousand-odd nodes per candidate; the
 * hash makes it a couple of dozen.
 */
export class KeepOutField {
  private static readonly CELL_M = 24;

  private readonly bins = new Map<number, number[]>();
  private readonly cx: number[] = [];
  private readonly cz: number[] = [];
  private readonly cr: number[] = [];
  private maxRadius = 0;

  add(x: number, z: number, r: number): void {
    const i = this.cx.length;
    this.cx.push(x);
    this.cz.push(z);
    this.cr.push(r);
    if (r > this.maxRadius) this.maxRadius = r;
    const c = KeepOutField.CELL_M;
    KeepOutField.push(this.bins, Math.floor(x / c), Math.floor(z / c), i);
  }

  private static push(bins: Map<number, number[]>, gx: number, gz: number, i: number): void {
    const key = KeepOutField.key(gx, gz);
    const bin = bins.get(key);
    if (bin) bin.push(i);
    else bins.set(key, [i]);
  }

  /**
   * Hash of a cell coordinate.
   *
   * A hash collision can only ever fold two cells into one bin, which adds
   * candidates to a query rather than losing them — and every candidate is
   * distance-tested exactly, so a collision costs a few microseconds and
   * changes no answer.
   */
  private static key(gx: number, gz: number): number {
    return (gx * 73856093) ^ (gz * 19349663);
  }

  /**
   * True when an oriented box stands at least `margin` metres clear of every
   * part of the drivable world.
   *
   * `(cos, sin)` is the box's yaw as used everywhere else in the codebase:
   * local +Z runs along the track tangent `(sin, cos)`, local +X along the
   * track normal `(cos, -sin)`.
   */
  clearOfBox(
    x: number, z: number, cos: number, sin: number,
    halfX: number, halfZ: number, margin: number,
  ): boolean {
    const c = KeepOutField.CELL_M;
    const reach = Math.hypot(halfX, halfZ) + margin + this.maxRadius;
    const g0x = Math.floor((x - reach) / c);
    const g1x = Math.floor((x + reach) / c);
    const g0z = Math.floor((z - reach) / c);
    const g1z = Math.floor((z + reach) / c);

    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const bin = this.bins.get(KeepOutField.key(gx, gz));
        if (!bin) continue;
        for (const i of bin) {
          const dx = this.cx[i] - x;
          const dz = this.cz[i] - z;
          // Into the box's own frame, then the standard point-to-box distance.
          const lx = Math.abs(dx * cos - dz * sin) - halfX;
          const lz = Math.abs(dx * sin + dz * cos) - halfZ;
          const ox = lx > 0 ? lx : 0;
          const oz = lz > 0 ? lz : 0;
          const need = this.cr[i] + margin;
          if (ox * ox + oz * oz < need * need) return false;
        }
      }
    }
    return true;
  }
}

/**
 * Interpolates a world position at a distance along the lap and a signed
 * lateral offset.
 *
 * Between nodes rather than at the nearest one: the pit lane's features are
 * often shorter than the ~3m node spacing, and snapping collapses them.
 */
function worldAt(track: TrackSpline, s: number, lateral: number): { x: number; z: number } {
  const count = track.count;
  const nodeM = track.length / count;
  const w = ((s % track.length) + track.length) % track.length;
  const f = w / nodeM;
  const i = Math.floor(f) % count;
  const j = (i + 1) % count;
  const t = f - Math.floor(f);
  const cx = track.px[i] + (track.px[j] - track.px[i]) * t;
  const cz = track.pz[i] + (track.pz[j] - track.pz[i]) * t;
  const nx = track.nx[i] + (track.nx[j] - track.nx[i]) * t;
  const nz = track.nz[i] + (track.nz[j] - track.nz[i]) * t;
  return { x: cx + nx * lateral, z: cz + nz * lateral };
}

/**
 * The drivable world: the racing surface for the whole lap, plus the pit lane
 * from the point it splits off the circuit to the point its exit road has
 * merged away again.
 */
export function buildKeepOutField(track: TrackSpline): KeepOutField {
  const field = new KeepOutField();

  for (let i = 0; i < track.count; i++) {
    field.add(track.px[i], track.pz[i], track.width[i] * 0.5);
  }

  const g = pitLaneGeometry(track.def, track.length);
  const hwAt = (u: number): number => track.width[track.indexAt(g.splitS + u)] * 0.5;
  for (let u = 0; u <= g.totalU; u += 3) {
    const e = g.edgesAt(u, hwAt(u));
    const mid = (e.inner + e.outer) * 0.5;
    const p = worldAt(track, g.splitS + u, g.sign * mid);
    field.add(p.x, p.z, (e.outer - e.inner) * 0.5);
  }

  return field;
}

// ===========================================================================
// Set dressing
// ===========================================================================

export type SceneryKind = 'tree' | 'grandstand' | 'building';

/**
 * One placed piece of set dressing.
 *
 * The layout decides the size as well as the position, because the size is what
 * the clearance test is run against — a renderer free to pick its own
 * dimensions could put a wall back on the road.
 */
export interface SceneryItem {
  kind: SceneryKind;
  /** Instance origin, at ground level. */
  x: number;
  y: number;
  z: number;
  /** Yaw about +Y. Local +Z runs along the track, local +X across it. */
  yaw: number;
  /** Plan footprint of the instance, in its own frame. */
  spanX: number;
  spanZ: number;
  height: number;
  /** Deterministic 0..1 variation, so the renderer can tint and scale. */
  h: number;
  h2: number;
}

/**
 * Footprint of the trackside grandstand geometry, measured from
 * `grandstandPreset('trackside', ...)`.
 *
 * The stand's local frame puts its front barrier at x = 0 and builds backwards
 * away from the track, so the box that describes it is offset half its depth
 * behind the anchor.
 */
const STAND_WIDTH_M = 30;
const STAND_DEPTH_M = 11.4;
/** Footprint of `grandstandPreset('main', ...)`, which the paddock places. */
export const MAIN_STAND_WIDTH_M = 74;
export const MAIN_STAND_DEPTH_M = 19.4;

/** Spacing between set-dressing slots along the lap, metres. */
const SCENERY_SPACING_M = 55;

/** An oriented rectangle in plan. */
export interface Footprint {
  x: number;
  z: number;
  cos: number;
  sin: number;
  halfX: number;
  halfZ: number;
}

/**
 * The ground a piece of set dressing actually stands on.
 *
 * The single place that knows how each kind of object relates to its instance
 * origin: a building and a tree are centred on theirs, a grandstand is anchored
 * at its front barrier and built backwards along its own +X. The layout pass,
 * the obstacle builder and the validation probe all go through here, so there
 * is no way for one of them to be testing a different rectangle from the one
 * the renderer draws.
 */
export function footprintOf(item: SceneryItem): Footprint {
  const cos = Math.cos(item.yaw);
  const sin = Math.sin(item.yaw);
  const inset = item.kind === 'grandstand' ? item.spanX * 0.5 : 0;
  return {
    // Local +X is (cos, -sin), matching the yaw convention used everywhere.
    x: item.x + cos * inset,
    z: item.z - sin * inset,
    cos, sin,
    halfX: item.spanX * 0.5,
    halfZ: item.spanZ * 0.5,
  };
}

/**
 * How far past the barrier line set dressing has to stand.
 *
 * The circuit's own containment already stops a car at half-width plus the
 * run-off, and a car's collision discs reach a metre beyond its centre, so
 * anything at least the run-off plus two metres clear of the racing surface is
 * behind the wall from the driver's point of view. That is the correct place
 * for a building: you hit the barrier, and the barrier is what stops you.
 */
function sceneryMargin(track: TrackSpline): number {
  return (track.def.scenery === 'street' ? 2.5 : 14) + 2;
}

/**
 * Places every piece of set dressing on the circuit, rejecting anything that
 * would stand on the road.
 *
 * The candidate position is the one the old code used — a pseudo-random lateral
 * offset from the node the slot falls on — but it is now only a starting point.
 * If the footprint is not clear of the WHOLE lap it is pushed further out and
 * retried, and if there is genuinely nowhere for it to go the slot is dropped.
 * Pushing rather than dropping matters: on a tight street circuit a strict
 * reject would strip most of the scenery out, and the scenery is what the eye
 * measures speed against.
 *
 * Quality no longer changes the layout. It used to change the spacing, which
 * would have meant the low-detail build colliding with buildings the high-detail
 * build had somewhere else. Quality now only changes how finely each object is
 * tessellated.
 */
export function buildSceneryLayout(track: TrackSpline, keepOut: KeepOutField): SceneryItem[] {
  const items: SceneryItem[] = [];
  const scenery = track.def.scenery;
  const isStreet = scenery === 'street';
  const barrier = isStreet ? 2.5 : 14;
  const margin = sceneryMargin(track);
  const pit = pitLaneGeometry(track.def, track.length);

  const slots = Math.floor(track.length / SCENERY_SPACING_M);

  for (let k = 0; k < slots; k++) {
    const s = k * SCENERY_SPACING_M;
    const i = track.indexAt(s);
    const hw = track.width[i] * 0.5;
    const groundY = track.elevation[i];
    const heading = Math.atan2(track.tx[i], track.tz[i]);

    for (const side of [-1, 1] as const) {
      // Nothing gets planted in the paddock, or in the pit lane.
      if (isPaddockGround(track, i, side)) continue;
      if (side === pit.sign && pit.covers(track.dist[i])) continue;

      // Deterministic pseudo-random from the index: identical every load, and
      // no RNG state to thread through.
      const h = Math.abs((Math.sin(k * 12.9898 + side * 78.233) * 43758.5453) % 1);
      const h2 = Math.abs((Math.sin(k * 39.3468 + side * 11.135) * 24634.6345) % 1);
      const baseLat = hw + barrier + 5 + h * 24;
      const fast = track.targetSpeed[i] > 62;

      /**
       * Builds the candidate object at a lateral offset, then walks it outward
       * until its footprint is clear of the circuit.
       *
       * The candidate is constructed in full and tested through `footprintOf`,
       * rather than testing a box assembled here from the same numbers. Those
       * two are easy to get subtly out of step — the first attempt at this
       * tested a grandstand as a box centred on its anchor when a grandstand is
       * anchored at its front barrier and built backwards, so every stand
       * passed a test on a footprint six metres away from its real one.
       */
      const place = (
        startLat: number, make: (lat: number) => SceneryItem,
      ): SceneryItem | null => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const item = make(startLat + attempt * 6);
          const f = footprintOf(item);
          if (keepOut.clearOfBox(f.x, f.z, f.cos, f.sin, f.halfX, f.halfZ, margin)) return item;
        }
        return null;
      };
      const anchor = (lat: number): { x: number; z: number } => worldAt(track, s, side * lat);

      if (isStreet) {
        // A city block. Sized first, then walked out until the block is off the
        // road — which is the check that was missing entirely.
        const height = 11 + h * 30;
        const w = 9 + h2 * 12;
        const found = place(baseLat, (lat) => {
          const p = anchor(lat);
          return {
            kind: 'building',
            x: p.x, y: groundY, z: p.z,
            yaw: heading,
            spanX: w, spanZ: w * 0.85, height,
            h, h2,
          };
        });
        if (found) items.push(found);
        continue;
      }

      // A grandstand on the straights, where a real circuit puts them, and as
      // close to the track as it can legitimately stand.
      if (fast && h2 > 0.72) {
        const yaw = heading + (side > 0 ? 0 : Math.PI);
        const found = place(hw + barrier + 9, (lat) => {
          const p = anchor(lat);
          return {
            kind: 'grandstand',
            x: p.x, y: groundY, z: p.z,
            yaw,
            spanX: STAND_DEPTH_M, spanZ: STAND_WIDTH_M,
            height: 12,
            h, h2,
          };
        });
        if (found) {
          items.push(found);
          continue;
        }
      }

      const size = scenery === 'desert' ? 0.5 + h * 0.4 : 0.8 + h * 0.85;
      const canopy = 2.1 * size;
      const found = place(baseLat, (lat) => {
        const p = anchor(lat);
        return {
          kind: 'tree',
          x: p.x, y: groundY, z: p.z,
          yaw: h * 6.283,
          spanX: canopy * 2, spanZ: canopy * 2,
          height: 9 * size,
          h, h2,
        };
      });
      if (found) items.push(found);
    }
  }

  return items;
}

// ===========================================================================
// Static obstacles
// ===========================================================================

export type ObstacleKind = 'building' | 'grandstand' | 'wall' | 'pitwall';

/** One solid, immovable box, described in plan. */
export interface Obstacle {
  kind: ObstacleKind;
  /** Centre of the footprint. */
  x: number;
  z: number;
  cos: number;
  sin: number;
  /** Half extents along the box's local X (across) and Z (along). */
  halfX: number;
  halfZ: number;
}

function boxAt(
  kind: ObstacleKind, x: number, z: number, yaw: number, spanX: number, spanZ: number,
): Obstacle {
  return {
    kind,
    x, z,
    cos: Math.cos(yaw), sin: Math.sin(yaw),
    halfX: spanX * 0.5, halfZ: spanZ * 0.5,
  };
}

/**
 * Everything solid a car can run into that is not the circuit's own barrier.
 *
 * Trees are deliberately absent. They only ever stand beyond the barrier line,
 * so a car reaches the wall long before it reaches a tree, and several hundred
 * unreachable obstacles would cost broadphase work for a collision that cannot
 * happen. The same is true of the buildings and stands on a well-laid-out
 * circuit — they are included anyway, because "solid" should not depend on the
 * layout pass having done its job perfectly.
 */
export function buildStaticObstacles(track: TrackSpline, scenery: SceneryItem[]): Obstacle[] {
  const out: Obstacle[] = [];

  for (const item of scenery) {
    if (item.kind === 'tree') continue;
    const f = footprintOf(item);
    out.push({
      kind: item.kind === 'building' ? 'building' : 'grandstand',
      x: f.x, z: f.z, cos: f.cos, sin: f.sin, halfX: f.halfX, halfZ: f.halfZ,
    });
  }

  out.push(...buildPitWallObstacles(track));

  // Nothing solid is allowed to stand on the racing surface, ever.
  //
  // Not a substitute for placing things correctly — it is the backstop for
  // when that goes wrong. A wall that overlaps the road is invisible until a
  // car hits it, at which point it stops being a cosmetic defect and becomes
  // every car on the lead lap driving into an obstruction, so the invariant is
  // enforced here rather than trusted.
  const road = new KeepOutField();
  for (let i = 0; i < track.count; i++) {
    road.add(track.px[i], track.pz[i], track.width[i] * 0.5);
  }
  return out.filter((o) => road.clearOfBox(o.x, o.z, o.cos, o.sin, o.halfX, o.halfZ, 0));
}

/**
 * The pit wall, and the walls down the outside of the entry and exit roads.
 *
 * These are the solid objects a car can genuinely reach. Along the pits the
 * circuit's own barrier and fencing are suppressed — the pit wall IS the
 * boundary there — but the simulation's lateral limit stayed at half-width plus
 * the run-off, so a car that ran wide onto the pit straight drove straight over
 * the wall and out into the fast lane.
 */
function buildPitWallObstacles(track: TrackSpline): Obstacle[] {
  const out: Obstacle[] = [];
  const g: PitLaneGeometry = pitLaneGeometry(track.def, track.length);

  const SEG_M = 6;

  /**
   * One straight run of wall between two points on the lane.
   *
   * The box is built from the two ENDPOINTS, not from a centre and the track's
   * heading there. Those are not the same thing on a curve: the circuit builder
   * draws the wall as a chain of chords between exactly these points, so
   * deriving the box's direction from the local tangent instead put the two out
   * of step by a couple of metres round Sainte Dévote — enough for the solid
   * wall to reach across the track edge while the drawn one sat correctly
   * beside it.
   */
  const segment = (
    kind: ObstacleKind, u0: number, u1: number, mag0: number, mag1: number, thick: number,
  ): void => {
    const p0 = worldAt(track, g.splitS + u0, g.sign * mag0);
    const p1 = worldAt(track, g.splitS + u1, g.sign * mag1);
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    // Local +Z is (sin yaw, cos yaw), so this points the box along the chord.
    out.push(boxAt(
      kind, (p0.x + p1.x) * 0.5, (p0.z + p1.z) * 0.5, Math.atan2(dx, dz), thick, len,
    ));
  };

  // The pit wall proper, for the lane's whole walled length.
  for (let u = g.entryOpenU; u < g.exitU; u += SEG_M) {
    segment('pitwall', u, Math.min(u + SEG_M, g.exitU), g.wallMag, g.wallMag, g.wallThick);
  }

  // The wall down the OUTSIDE of the entry and exit roads is deliberately not
  // solid. It adds nothing: a car in the lane is already held by the garage
  // frontage, which is where that wall stands. And it cannot be modelled
  // honestly — it sits more than twenty metres off the centreline, and where
  // the lane runs round a corner tighter than that the offset curve folds over
  // itself, so the "wall" is a smear of overlapping fragments rather than a
  // line. Making that solid walled cars into the working lane at Austin and
  // left sixteen of them stuck in the pits.
  return out;
}

/** Height of the pit wall, re-exported so callers need one import. */
export { PIT_WALL_HEIGHT_M };

// ===========================================================================
// Broadphase
// ===========================================================================

/**
 * A uniform grid over the static obstacles.
 *
 * Rebuilt once at session load and read every physics step by every car, so it
 * is a plain array of indices per cell with no allocation in the query path.
 */
export class ObstacleField {
  private static readonly CELL_M = 16;

  readonly obstacles: readonly Obstacle[];
  private readonly bins = new Map<number, number[]>();

  constructor(obstacles: readonly Obstacle[]) {
    this.obstacles = obstacles;
    const c = ObstacleField.CELL_M;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // Axis-aligned bound of the oriented box.
      const ex = Math.abs(o.cos) * o.halfX + Math.abs(o.sin) * o.halfZ;
      const ez = Math.abs(o.sin) * o.halfX + Math.abs(o.cos) * o.halfZ;
      const g0x = Math.floor((o.x - ex) / c);
      const g1x = Math.floor((o.x + ex) / c);
      const g0z = Math.floor((o.z - ez) / c);
      const g1z = Math.floor((o.z + ez) / c);
      for (let gx = g0x; gx <= g1x; gx++) {
        for (let gz = g0z; gz <= g1z; gz++) {
          const key = ObstacleField.key(gx, gz);
          const bin = this.bins.get(key);
          if (bin) bin.push(i);
          else this.bins.set(key, [i]);
        }
      }
    }
  }

  private static key(gx: number, gz: number): number {
    return (gx * 73856093) ^ (gz * 19349663);
  }

  get isEmpty(): boolean {
    return this.obstacles.length === 0;
  }

  /**
   * Collects the obstacles whose cells overlap a circle, into `out`.
   *
   * `out` is cleared and reused by the caller, so a full field of cars costs no
   * allocations per step. Duplicates are possible where a box spans cells, and
   * are filtered here rather than in the caller's inner loop.
   */
  query(x: number, z: number, radius: number, out: number[]): void {
    out.length = 0;
    if (this.obstacles.length === 0) return;
    const c = ObstacleField.CELL_M;
    const g0x = Math.floor((x - radius) / c);
    const g1x = Math.floor((x + radius) / c);
    const g0z = Math.floor((z - radius) / c);
    const g1z = Math.floor((z + radius) / c);
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const bin = this.bins.get(ObstacleField.key(gx, gz));
        if (!bin) continue;
        for (const i of bin) {
          if (out.indexOf(i) < 0) out.push(i);
        }
      }
    }
  }
}

/**
 * The complete static world for one circuit: what to draw, and what is solid.
 */
export interface WorldModel {
  keepOut: KeepOutField;
  scenery: SceneryItem[];
  obstacles: ObstacleField;
}

export function buildWorldModel(track: TrackSpline): WorldModel {
  const keepOut = buildKeepOutField(track);
  const scenery = buildSceneryLayout(track, keepOut);
  return {
    keepOut,
    scenery,
    obstacles: new ObstacleField(buildStaticObstacles(track, scenery)),
  };
}
