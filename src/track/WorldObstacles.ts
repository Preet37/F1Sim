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
  /** Distance along the lap this disc came from, or -1 for the pit lane. */
  private readonly cs: number[] = [];
  private maxRadius = 0;

  add(x: number, z: number, r: number, s = -1): void {
    const i = this.cx.length;
    this.cx.push(x);
    this.cz.push(z);
    this.cr.push(r);
    this.cs.push(s);
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

  /**
   * Distance from a point to the nearest bit of drivable ground, ignoring the
   * stretch of lap the caller is standing on.
   *
   * The exclusion is what makes this useful for placing a barrier. A barrier
   * fourteen metres off the racing line is, trivially, fourteen metres from the
   * racing line — the question is whether it is also standing on a DIFFERENT
   * part of the same circuit, which at a track that doubles back on itself is
   * exactly what happens. Excluding a window either side of the caller's own
   * lap distance asks that question and nothing else.
   *
   * @param cap distance beyond which the answer stops mattering
   */
  clearanceAt(
    x: number, z: number, cap: number, excludeS: number, window: number, lapLength: number,
  ): number {
    const c = KeepOutField.CELL_M;
    const reach = cap + this.maxRadius;
    const g0x = Math.floor((x - reach) / c);
    const g1x = Math.floor((x + reach) / c);
    const g0z = Math.floor((z - reach) / c);
    const g1z = Math.floor((z + reach) / c);

    let best = cap;
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const bin = this.bins.get(KeepOutField.key(gx, gz));
        if (!bin) continue;
        for (const i of bin) {
          const s = this.cs[i];
          if (s >= 0 && excludeS >= 0) {
            let d = Math.abs(s - excludeS);
            if (d > lapLength * 0.5) d = lapLength - d;
            if (d <= window) continue;
          }
          const dx = this.cx[i] - x;
          const dz = this.cz[i] - z;
          const d = Math.hypot(dx, dz) - this.cr[i];
          if (d < best) best = d;
        }
      }
    }
    return best;
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
    field.add(track.px[i], track.pz[i], track.width[i] * 0.5, track.dist[i]);
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
// The barrier line
// ===========================================================================

/**
 * Nominal distance from the track edge to the barrier.
 *
 * Street circuits are walled right at the edge of the road, which is why they
 * punish a mistake so much harder than a permanent circuit's run-off.
 */
export function nominalBarrierOffset(track: TrackSpline): number {
  return track.def.scenery === 'street' ? 2.5 : 14;
}

/** How close a barrier is ever allowed to come to the track edge. */
const BARRIER_MIN_OFFSET_M = 2.2;
/** Clearance a barrier must keep from any OTHER part of the circuit. */
const BARRIER_ROAD_CLEARANCE_M = 2.0;
/** Lap distance either side of a node that counts as "the same bit of road". */
const BARRIER_SAME_ROAD_M = 70;
/** Most a barrier may step in or out between adjacent nodes, metres. */
const BARRIER_SLOPE_M = 0.35;

/**
 * True where the trackside barrier gives way to the paddock or the pit lane.
 *
 * The barrier, the catch fencing, the sponsor hoardings and the set dressing
 * are all laid down at a fixed offset for the whole lap; along the pits that
 * puts an armco through the middle of the fast lane. One rule, used by the
 * renderer and the simulation alike, so what is drawn and what is solid stop
 * where each other stop.
 */
export function barrierSuppressed(
  track: TrackSpline, node: number, side: -1 | 1, pit: PitLaneGeometry,
): boolean {
  if (isPaddockGround(track, node, side)) return true;
  if (side !== pit.sign) return false;
  // Only the lane's working length, not its tapered ends: over the taper the
  // circuit's own barrier is still the right thing beside the entry and exit
  // roads, and suppressing it there leaves the track edge running into space.
  const u = pit.u(track.dist[node]);
  return u > pit.entryOpenU - 25 && u < pit.exitU + 25;
}

/**
 * How far off the track edge the barrier actually stands, per node, per side.
 *
 * This is the fix for cars ending up on the wrong side of the fence.
 *
 * A circuit is a closed loop, and several of them fold back within a few tens
 * of metres of themselves — Silverstone's Loop and Wellington Straight, the
 * National and Grand Prix pit straights, Suzuka's crossover. A barrier laid
 * down blindly fourteen metres off the edge of one of those runs straight
 * across the OTHER one. There is then no continuous boundary at all: the
 * "run-off" of the first section is the road of the second, the two barriers
 * enclose a corridor rather than the circuit, and a car that runs wide is
 * measured against whichever section its projection happens to snap to —
 * which, once it is in that corridor, is the far one. Its lateral offset is
 * small, containment never fires, and it comes to rest behind an armco and a
 * catch fence with the track on the other side of them.
 *
 * So the offset is capped per node at whatever leaves the barrier clear of
 * every other part of the circuit, and the result is slope-limited so the wall
 * eases in and out rather than stepping. Where two straights run close, the
 * barrier now sits between them, close in, exactly as it does in reality.
 */
export function barrierOffsets(
  track: TrackSpline, keepOut: KeepOutField, pit: PitLaneGeometry,
): { left: Float64Array; right: Float64Array } {
  const count = track.count;
  const nominal = nominalBarrierOffset(track);
  const out = { left: new Float64Array(count), right: new Float64Array(count) };

  for (const side of [-1, 1] as const) {
    const arr = side > 0 ? out.left : out.right;
    for (let i = 0; i < count; i++) {
      const hw = track.width[i] * 0.5;
      // 0 means "no barrier here at all". If there is nowhere to put one that
      // is not standing on drivable ground — which happens where the pit exit
      // road runs alongside the circuit as it merges — then the honest answer
      // is not to build one. A wall across a road a car is meant to drive down
      // is worse than a gap in the chain, and the road itself is what the car
      // is contained by there.
      let offset = 0;

      // On the inside of a corner, an offset curve tighter than the corner's
      // own radius folds over itself: the "barrier" doubles back and encloses
      // the apex run-off in a pocket with no way out. Capping the offset at a
      // fraction of the radius of curvature keeps the line convex, which is
      // also what a real circuit does — the armco on the inside of a hairpin
      // is close to the road, not fourteen metres back.
      let cap = nominal;

      // Where another part of the circuit runs alongside, the two barriers
      // meet in the middle of the gap rather than each reaching its full
      // offset. Without this, section A's barrier stands in section B's
      // run-off: B's containment lets a car out to a place that has A's armco
      // and debris fence between it and B's road. That is the strip the
      // player's car was photographed parked on.
      {
        const probeLat = side * (hw + 2);
        const gap = keepOut.clearanceAt(
          track.px[i] + track.nx[i] * probeLat,
          track.pz[i] + track.nz[i] * probeLat,
          nominal * 2 + 10, track.dist[i], BARRIER_SAME_ROAD_M, track.length,
        );
        cap = Math.min(cap, Math.max(BARRIER_MIN_OFFSET_M, (gap + 2) * 0.5));
      }

      const kappa = track.curvature[i];
      // Positive curvature turns toward positive lateral, i.e. toward the left
      // side, so the LEFT barrier is the inner one there.
      const inner = (side > 0 && kappa > 0) || (side < 0 && kappa < 0);
      if (inner && Math.abs(kappa) > 1e-4) {
        cap = Math.min(cap, Math.max(BARRIER_MIN_OFFSET_M, 0.7 / Math.abs(kappa) - hw));
      }

      // Walk outward and keep the largest offset that is still clear.
      for (let d = cap; d >= BARRIER_MIN_OFFSET_M; d -= 1) {
        const lat = side * (hw + d);
        const x = track.px[i] + track.nx[i] * lat;
        const z = track.pz[i] + track.nz[i] * lat;
        const clear = keepOut.clearanceAt(
          x, z, BARRIER_ROAD_CLEARANCE_M + 1, track.dist[i],
          BARRIER_SAME_ROAD_M, track.length,
        );
        if (clear >= BARRIER_ROAD_CLEARANCE_M) { offset = d; break; }
      }
      arr[i] = offset;
    }

    // Slope-limit, wrapped, downward only — so smoothing can never push the
    // barrier back out onto a piece of road the search just moved it off.
    // A suppressed node (0) is skipped rather than dragging its neighbours to
    // zero with it; the chain simply ends beside it.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < count; k++) {
        const i = k % count;
        const p = (i - 1 + count) % count;
        if (arr[i] <= 0 || arr[p] <= 0) continue;
        if (arr[i] > arr[p] + BARRIER_SLOPE_M) arr[i] = arr[p] + BARRIER_SLOPE_M;
      }
      for (let k = count - 1; k >= 0; k--) {
        const i = k % count;
        const n = (i + 1) % count;
        if (arr[i] <= 0 || arr[n] <= 0) continue;
        if (arr[i] > arr[n] + BARRIER_SLOPE_M) arr[i] = arr[n] + BARRIER_SLOPE_M;
      }
    }
  }

  // Suppressed stretches are marked with 0, so a caller can skip them without
  // having to re-derive the rule.
  for (let i = 0; i < count; i++) {
    if (barrierSuppressed(track, i, 1, pit)) out.left[i] = 0;
    if (barrierSuppressed(track, i, -1, pit)) out.right[i] = 0;
  }

  return out;
}

/**
 * How far out the car is allowed to go, per node, per side — which is NOT the
 * same question as where the wall stands.
 *
 * A barrier chain is allowed to have gaps in it. Where the pit exit road runs
 * alongside the circuit there is nowhere to put a wall that would not be a wall
 * across a road, so `barrierOffsets` honestly reports nothing there. The trouble
 * is what the gap's far END looks like: the chain resumes at the minimum offset,
 * two metres off the track edge, and a car that used the gap to run out to
 * thirteen metres arrives beside a wall it is already behind. It then hits the
 * back of that wall, stops, and sits there — off the road, out of the race, with
 * an armco between it and the circuit. That is the Suzuka escape, and the same
 * shape of gap exists on every circuit on the calendar.
 *
 * So containment is the barrier line SLOPE-LIMITED ACROSS ITS OWN GAPS, at the
 * same 0.35m per node the wall itself is smoothed with. Near the end of a gap
 * the limit has closed back down to where the wall is about to be, so a car is
 * funnelled in ahead of it rather than finding it side-on; a hundred metres
 * deeper into the gap the allowance has opened out to fifteen-odd metres and the
 * limit is no more restrictive than the run-off. Nothing is drawn for it,
 * because nothing is there — this is the edge of the run-off, not a solid
 * object, and it is enforced the way the run-off edge always was.
 *
 * Stretches suppressed for the pit lane or the paddock keep their zero. A car in
 * the lane is contained by the lane, a car in the paddock is meant to be able to
 * reach a garage, and neither wants a funnel.
 */
export function containmentOffsets(
  track: TrackSpline, offsets: { left: Float64Array; right: Float64Array },
  pit: PitLaneGeometry,
): { left: Float64Array; right: Float64Array } {
  const count = track.count;
  const out = {
    left: Float64Array.from(offsets.left),
    right: Float64Array.from(offsets.right),
  };

  for (const side of [-1, 1] as const) {
    const src = side > 0 ? offsets.left : offsets.right;
    const arr = side > 0 ? out.left : out.right;

    // Nothing to spread from, and nothing to spread into.
    let anyWall = false;
    for (let i = 0; i < count; i++) if (src[i] > 0) { anyWall = true; break; }
    if (!anyWall) continue;

    for (let i = 0; i < count; i++) arr[i] = src[i] > 0 ? src[i] : Infinity;

    // Two wrapped sweeps, forward then back: the standard way to take a
    // minimum over "value at j, plus the cost of walking from j to i".
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < count; k++) {
        const i = k % count;
        const p = (i - 1 + count) % count;
        const via = arr[p] + BARRIER_SLOPE_M;
        if (via < arr[i]) arr[i] = via;
      }
      for (let k = count - 1; k >= 0; k--) {
        const i = k % count;
        const n = (i + 1) % count;
        const via = arr[n] + BARRIER_SLOPE_M;
        if (via < arr[i]) arr[i] = via;
      }
    }

    // Back to "0 means no limit from here" for the stretches that want it, and
    // for anything the sweeps could not reach.
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(arr[i]) || barrierSuppressed(track, i, side, pit)) arr[i] = 0;
    }
  }

  return out;
}

/** A straight run of solid surface, in plan. */
export interface WallSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal pointing AWAY from the racing surface. */
  ox: number;
  oz: number;
}

/**
 * The barrier line as a chain of world-space segments — the exact boundary the
 * renderer draws and the simulation collides against.
 */
export function barrierSegments(
  track: TrackSpline, offsets: { left: Float64Array; right: Float64Array }, step: number,
): WallSegment[] {
  const out: WallSegment[] = [];
  const count = track.count;
  for (const side of [-1, 1] as const) {
    const arr = side > 0 ? offsets.left : offsets.right;
    for (let a = 0; a < count; a += step) {
      const b = (a + step) % count;
      if (arr[a] <= 0 || arr[b] <= 0) continue;
      const la = side * (track.width[a] * 0.5 + arr[a]);
      const lb = side * (track.width[b] * 0.5 + arr[b]);
      out.push({
        ax: track.px[a] + track.nx[a] * la,
        az: track.pz[a] + track.nz[a] * la,
        bx: track.px[b] + track.nx[b] * lb,
        bz: track.pz[b] + track.nz[b] * lb,
        ox: track.nx[a] * side,
        oz: track.nz[a] * side,
      });
    }
  }
  return out;
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

export type ObstacleKind = 'building' | 'grandstand' | 'barrier' | 'pitwall';

/**
 * Thickness of the trackside barrier as a collision box.
 *
 * Only a collision shape, not the drawn wall: it exists so a car cannot pass
 * through the chain even at the very shallowest of angles.
 */
const BARRIER_THICKNESS_M = 1.2;
/** Extra length per barrier box, so consecutive boxes overlap at the joint. */
const BARRIER_JOINT_OVERLAP_M = 1.2;

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
export function buildStaticObstacles(
  track: TrackSpline, scenery: SceneryItem[], barrier: readonly WallSegment[],
): Obstacle[] {
  const out: Obstacle[] = [];

  for (const item of scenery) {
    if (item.kind === 'tree') continue;
    const f = footprintOf(item);
    out.push({
      kind: item.kind === 'building' ? 'building' : 'grandstand',
      x: f.x, z: f.z, cos: f.cos, sin: f.sin, halfX: f.halfX, halfZ: f.halfZ,
    });
  }

  // The circuit's own barrier, as real geometry rather than as a lateral limit
  // on the spline. This is the fix for a car ending up behind the fence: a
  // spline limit is only ever as good as the projection it is measured
  // against, and where a circuit runs back close to itself that projection
  // snaps to the wrong section. A wall in world space does not care which node
  // the car thinks it is nearest to.
  for (const s of barrier) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    // The box's inner face sits ON the barrier line, so a car is stopped where
    // the wall is drawn rather than a car's width short of it.
    const cx = (s.ax + s.bx) * 0.5 + s.ox * BARRIER_THICKNESS_M * 0.5;
    const cz = (s.az + s.bz) * 0.5 + s.oz * BARRIER_THICKNESS_M * 0.5;
    // Overlapped along their length. Butted end to end, the joint between two
    // segments on a curve leaves a step of an inch or two facing back up the
    // track, and a car scraping along the wall catches every one of them —
    // which reads as the barrier being made of teeth. Overlapping buries the
    // step inside the neighbouring box.
    out.push(boxAt(
      'barrier', cx, cz, Math.atan2(dx, dz),
      BARRIER_THICKNESS_M, len + BARRIER_JOINT_OVERLAP_M,
    ));
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

  // The garage frontage, which is the far side of the pit lane over the row of
  // bays — a continuous two-storey building in the paddock's geometry, and now
  // a continuous wall in the simulation's. Without it a car that lost its
  // pit-lane flag in the lane simply drove out through the garages and parked
  // in the paddock behind them.
  for (let u = 0; u < g.totalU; u += SEG_M) {
    const b = Math.min(u + SEG_M, g.totalU);
    const iA = track.indexAt(g.splitS + u);
    const iB = track.indexAt(g.splitS + b);
    if (!isPaddockGround(track, iA, g.sign as -1 | 1)) continue;
    if (!isPaddockGround(track, iB, g.sign as -1 | 1)) continue;
    segment('pitwall', u, b, g.garageFace, g.garageFace, 0.5);
  }

  // The wall down the OUTSIDE of the entry and exit roads is deliberately NOT
  // solid. It cannot be modelled honestly: it sits more than twenty metres off
  // the centreline, and where the lane runs round a corner tighter than that
  // the offset curve folds over itself, so the "wall" is a smear of
  // overlapping fragments rather than a line. Making it solid walled cars into
  // the working lane at Austin and left sixteen of them stuck in the pits. The
  // lane's own lateral limit is the boundary there instead.
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
  /** Barrier distance from the track edge, per node, per side. 0 = suppressed. */
  barrierOffsets: { left: Float64Array; right: Float64Array };
  /**
   * How far off the track edge a car may go, per node, per side. 0 = no limit
   * from here. The same line as `barrierOffsets` wherever there is a wall, and
   * closed across the gaps between walls — see `containmentOffsets`.
   */
  containment: { left: Float64Array; right: Float64Array };
  /** The barrier line as world-space segments — drawn and collided identically. */
  barrier: WallSegment[];
  obstacles: ObstacleField;
}

/** Node step used for both the drawn barrier and its collision chain. */
export const BARRIER_STEP_NODES = 2;

export function buildWorldModel(track: TrackSpline): WorldModel {
  const keepOut = buildKeepOutField(track);
  const pit = pitLaneGeometry(track.def, track.length);
  const offsets = barrierOffsets(track, keepOut, pit);
  const barrier = barrierSegments(track, offsets, BARRIER_STEP_NODES);
  const scenery = buildSceneryLayout(track, keepOut);
  return {
    keepOut,
    scenery,
    barrierOffsets: offsets,
    containment: containmentOffsets(track, offsets, pit),
    barrier,
    obstacles: new ObstacleField(buildStaticObstacles(track, scenery, barrier)),
  };
}
