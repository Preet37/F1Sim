import * as THREE from 'three';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * The ground the circuit stands on.
 *
 * WHAT THIS REPLACES, AND WHY. The world beyond the circuit used to be a single
 * flat quad at a fixed y of -0.62, and the circuit itself is a ribbon that
 * follows an authored elevation profile: 0 to 6m at Bahrain, 6 to 58m at Spa,
 * 2 to 40m at COTA. Everything drawn beside the road — run-off, verge — is
 * drawn at the ROAD's height, and a vertical "skirt" was then dropped off the
 * outer edge of the verge to close the gap down to that flat plane.
 *
 * So the skirt was as tall as the circuit was elevated. Measured across the
 * calendar it averages 4.1m at Bahrain and 27.2m at Spa, and peaks at 58.6m.
 * That is not a lip, it is a cliff, and it runs continuously around the outside
 * of every corner where there is room beside the road to see it. The report was
 * exact: *"the tracks on the turns at least some of them still has that hugee
 * hole"* — a corner sitting on a raised sand-coloured plateau, walled all the
 * way round, with the desert floor several car-heights below.
 *
 * It appeared at corners and not on straights for the same reason the previous
 * defect did: the barrier stands further back on the outside of a corner than
 * it does beside a straight, the ground beside the road reaches out to the
 * barrier, and so the edge of the plateau — the thing you can actually see — is
 * only far enough from the road to be in shot where the road turns.
 *
 * THE FIX is not to shorten the skirt. It is that the ground beside a circuit
 * is at the height of the circuit: a track built on a hill has a hill under it.
 * This module turns the track's own elevation profile into a height field over
 * the whole world, so the terrain rises and falls with the road and the skirt
 * becomes what it was always described as — a lip a few tens of centimetres
 * tall closing the join between two surfaces that very nearly meet.
 *
 * The field is sampled by two things and they must agree exactly:
 *   - `buildTerrainMesh`, for the ground the player sees;
 *   - `TrackMesh`, for the foot of the skirt at each station.
 * Both call `heightAt`, so the skirt lands on the terrain by construction, at
 * every node of every circuit, whatever the elevation does.
 */

/**
 * How far the terrain sits below the road surface immediately beside it.
 *
 * The circuit is built up on its own formation, so the ground next to the
 * asphalt is a little lower than the asphalt — and it has to be lower by
 * something, because two coplanar surfaces in a depth buffer fight. This is the
 * same 0.62m the old flat plane sat at when the elevation was zero, kept so the
 * relationship between road and ground is the one that was already tuned.
 */
export const GROUND_DROP_M = 0.62;

/**
 * `Object3D.name` given to the ground mesh.
 *
 * A probe that has to tell the circuit's meshes apart should not have to infer
 * which one is the ground from its vertex count.
 */
export const GROUND_MESH_NAME = 'ground';

/**
 * Extra depth immediately beside the circuit, metres, and how far out it runs.
 *
 * A shallow swale hugging the road, which does two jobs. It is what a real
 * circuit has beside it — the ground falls away from the formation so water
 * drains off the track — and it buys margin against the ground mesh, which
 * samples this field at its vertices and is linear in between, so a cell that
 * spans a place where the field bends can bulge slightly above it. Beside the
 * road that bulge would poke up through the run-off. Sunk by a third of a metre
 * it cannot. Together with the drop above it makes the skirt a lip 0.97m tall,
 * which is the number `probe:shoulders` reports as the mean on every circuit.
 */
const SWALE_DEPTH_M = 0.35;
const SWALE_RUN_M = 12;

/**
 * How far out samples are gathered, metres.
 *
 * A hard cutoff on an inverse-distance sum is a STEP in the result: the moment
 * a sample leaves the radius its contribution disappears, and with thousands of
 * samples on a circuit that step draws a contour line in the ground at exactly
 * this distance from the road, all the way round. So the kernel is windowed —
 * it reaches zero at the radius rather than being cut off at it — and the
 * relaxation to the far-field level finishes inside the window, so a point with
 * no sample in reach and a point with one just inside it agree.
 */
const INFLUENCE_M = 150;
/**
 * Softening radius of the weighting kernel, metres.
 *
 * Weight is 1/(d^2 + EPS^2)^2 — inverse fourth power, not inverse square.
 *
 * An inverse-distance blend only reproduces its data AT the data, and the one
 * place this field has to be right is the foot of the skirt. With the shoulder
 * edges among the samples (see `groundSamples`) a query at the foot of the
 * skirt lands ON a sample, so all that is needed is for that sample to win —
 * and the competition is a different piece of the same lap forty metres away
 * with fifty samples on it. Inverse square lost that vote: the count beat the
 * distance, and the ground beside Suzuka's crossover was dragged eight metres
 * down toward the road passing under it. Inverse fourth power with a 5m
 * softening wins it, and takes the number of stations dropping more than two
 * metres from 21% of Zandvoort to 2%.
 */
const KERNEL_EPS_M = 5;
/**
 * Steepest the ground is allowed to climb away from a piece of road.
 *
 * Where the lap folds back on itself — Spa between Les Combes and the Kemmel
 * straight, Monaco above and below the tunnel — two pieces of road at very
 * different heights pass within a few tens of metres, and a smooth blend
 * between them passes through heights above the LOWER of the two. Terrain above
 * a road is terrain through a road.
 *
 * The first attempt at guarding that took the minimum elevation within a fixed
 * radius, and it swapped one cliff for another: the ground beside Monaco's
 * climb to the Casino was dragged down to the height of the road under it and
 * the probe reported a 33m face. What is wanted is not a floor but a GRADIENT
 * limit — the ground beside a road is at that road's height and may rise from
 * it no faster than this. It is an upper envelope of cones, one per node, and
 * between two levels it produces the embankment that is actually there.
 *
 * 1.4 is about 55 degrees: steep enough that it never binds on ordinary terrain
 * — where it would, it would be inventing a cliff of its own — and shallow
 * enough to stop the ground climbing over a road passing beneath another.
 *
 * Where the lap genuinely crosses itself with height between the two levels,
 * Suzuka's figure of eight being the clearest case, no height field can put
 * ground beside both roads at once, and what is left is a retaining wall
 * between them. That is what is actually there. `probe:shoulders` separates
 * those places from cliffs with nothing to explain them.
 */
const CLIMB_SLOPE = 1.4;
/**
 * Where the terrain starts relaxing toward the far-field level, and ends.
 *
 * Both inside `INFLUENCE_M`, which is what makes the window seamless: by the
 * distance at which the last sample fades out, the answer is the far-field
 * level regardless of what the samples said.
 */
const RELAX_START_M = 55;
const RELAX_END_M = 145;

/**
 * Node stride for the field's samples.
 *
 * Every node. It was every fourth, on the reasoning that the ground is smooth
 * at 12m — and the reasoning is right about the ground and wrong about the
 * query: the point that matters is the foot of the skirt, the whole trick is
 * that a sample sits exactly under it, and at a stride of four the nearest
 * sample was up to six metres away. Six metres is enough for a road passing
 * thirteen metres higher to outvote it, which put the ground beside Zandvoort's
 * lower level three metres above the road it was beside.
 *
 * Exported because the samples are built by whoever knows the road's
 * cross-section — see `groundSamples` in `TrackMesh` — and the two have to
 * agree on how many of them there are.
 */
export const GROUND_SAMPLE_STRIDE = 1;
/** Bucket size for the sample lookup grid, metres. */
const BUCKET_M = 24;

/**
 * Points the ground is known at.
 *
 * The circuit's own footprint, as a set of heights: the centreline, and the
 * outer edge of the ground beside it on each side. The edges matter more than
 * the centreline does, because they are where the skirt's foot lands and where
 * the ground mesh has to meet it.
 *
 * `r` is how much of the world that sample's node covers with road, run-off and
 * verge — used only to sink the ground under geometry that hides it anyway.
 */
export interface GroundSamples {
  x: Float64Array;
  z: Float64Array;
  y: Float64Array;
  r: Float64Array;
}

function smoothstep(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/**
 * The height of the ground at any point in the world.
 *
 * Built once per session, from the track alone. Deliberately not a texture or a
 * baked grid: `TrackMesh` needs the value at arbitrary points — the outer edge
 * of the verge at every swept station — and a baked grid would answer those
 * with interpolation error, which is exactly the gap this exists to close.
 */
export class TerrainField {
  /**
   * Far-field ground level: the circuit's mean elevation, less the drop.
   *
   * The world past the last of the terrain is flat, and this is how high it is.
   * The mean rather than the lowest point, because the transition from the
   * circuit's own height to this one happens over ninety metres and the mean
   * halves the worst gradient it has to do it in — at Spa the lowest point is
   * 52m under the highest, so relaxing everything to the low one puts a 60%
   * slope round the top of the circuit, where relaxing to the mean puts a 30%
   * one round each. A circuit in a valley then reads as being in a valley.
   */
  readonly baseY: number;

  private readonly sx: Float64Array;
  private readonly sz: Float64Array;
  private readonly sy: Float64Array;
  /** Radius around each sample that the circuit itself occupies. */
  private readonly sr: Float64Array;

  private readonly buckets = new Map<number, number[]>();
  private readonly minX: number;
  private readonly maxX: number;
  private readonly minZ: number;
  private readonly maxZ: number;

  constructor(track: TrackSpline, samples: GroundSamples) {
    this.sx = samples.x;
    this.sz = samples.z;
    this.sy = samples.y;
    this.sr = samples.r;
    const n = this.sx.length;

    let sum = 0;
    for (let i = 0; i < track.count; i++) sum += track.elevation[i];
    this.baseY = sum / Math.max(1, track.count) - GROUND_DROP_M;

    const b = track.bounds();
    this.minX = b.minX; this.maxX = b.maxX;
    this.minZ = b.minZ; this.maxZ = b.maxZ;

    for (let k = 0; k < n; k++) {
      const key = this.key(this.sx[k], this.sz[k]);
      const list = this.buckets.get(key);
      if (list) list.push(k); else this.buckets.set(key, [k]);
    }
  }

  private key(x: number, z: number): number {
    // A 1e6 stride is comfortably beyond any circuit's extent in buckets.
    return Math.floor(x / BUCKET_M) * 1_000_000 + Math.floor(z / BUCKET_M);
  }

  /**
   * Ground height at a world point.
   *
   * Inverse-fourth weighting over the samples near it, capped by the climb
   * envelope, sunk by the swale beside the road, and relaxed to the far-field
   * level as the nearest road recedes.
   */
  heightAt(x: number, z: number): number {
    // Nothing within reach: the flat world beyond the circuit.
    if (x < this.minX - RELAX_END_M || x > this.maxX + RELAX_END_M
      || z < this.minZ - RELAX_END_M || z > this.maxZ + RELAX_END_M) return this.baseY;

    let wsum = 0;
    let wy = 0;
    let dMin = Infinity;
    let ceiling = Infinity;
    let rAtMin = 0;
    const eps2 = KERNEL_EPS_M * KERNEL_EPS_M;

    const r = INFLUENCE_M;
    const r2 = r * r;
    const bx0 = Math.floor((x - r) / BUCKET_M);
    const bx1 = Math.floor((x + r) / BUCKET_M);
    const bz0 = Math.floor((z - r) / BUCKET_M);
    const bz1 = Math.floor((z + r) / BUCKET_M);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        const list = this.buckets.get(bx * 1_000_000 + bz);
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const k = list[q];
          const dx = x - this.sx[k];
          const dz = z - this.sz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          // Inverse fourth power, windowed so it reaches exactly zero at the
          // gather radius. Both factors are squares, so this is one multiply
          // more than the unwindowed kernel was.
          const taper = 1 - d2 / r2;
          const u = taper / (d2 + eps2);
          const w = u * u;
          wsum += w;
          wy += w * this.sy[k];
          if (d2 < dMin) { dMin = d2; rAtMin = this.sr[k]; }
          const cap = this.sy[k] + CLIMB_SLOPE * Math.sqrt(d2);
          if (cap < ceiling) ceiling = cap;
        }
      }
    }
    if (wsum === 0) return this.baseY;

    dMin = Math.sqrt(dMin);
    let h = wy / wsum;
    if (ceiling < h) h = ceiling;
    h -= GROUND_DROP_M;
    // The swale: deepest against the circuit's own footprint, gone `SWALE_RUN_M`
    // beyond it, so there is no step anywhere along it.
    h -= SWALE_DEPTH_M * smoothstep((rAtMin + SWALE_RUN_M - dMin) / SWALE_RUN_M);

    const g = 1 - smoothstep((dMin - RELAX_START_M) / (RELAX_END_M - RELAX_START_M));
    return this.baseY + (h - this.baseY) * g;
  }

  /**
   * The highest the ground may be at a point, given every road within `r`.
   *
   * `heightAt` is right AT the foot of the skirt and the ground mesh samples it
   * at its vertices — but a mesh is linear between vertices, and where the lap
   * runs back alongside itself thirteen metres higher the field climbs at the
   * full climb slope, so a cell straddling that bank bridges clean over the
   * lower road and puts a hill in its run-off. The probe caught exactly that:
   * five metres of ground standing above the run-off at Zandvoort.
   *
   * So every vertex is also held under the roads near it, allowing a gentle
   * rise away from them. 0.14 is above the steepest gradient any circuit on the
   * calendar actually climbs — COTA's run to turn 1 is 10% — so on ordinary
   * ground it never binds and the terrain follows the road exactly. It binds
   * only where two levels of circuit are within a cell of each other.
   */
  roofAt(x: number, z: number, r: number): number {
    let roof = Infinity;
    const r2 = r * r;
    const bx0 = Math.floor((x - r) / BUCKET_M);
    const bx1 = Math.floor((x + r) / BUCKET_M);
    const bz0 = Math.floor((z - r) / BUCKET_M);
    const bz1 = Math.floor((z + r) / BUCKET_M);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        const list = this.buckets.get(bx * 1_000_000 + bz);
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const k = list[q];
          const dx = x - this.sx[k];
          const dz = z - this.sz[k];
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          const cap = this.sy[k] + ROOF_SLOPE * Math.sqrt(d2);
          if (cap < roof) roof = cap;
        }
      }
    }
    return roof === Infinity ? Infinity : roof - GROUND_DROP_M - SWALE_DEPTH_M;
  }
}

/** See `TerrainField.roofAt`. */
const ROOF_SLOPE = 0.14;

/**
 * Half the width of the uniform grid beyond the circuit's own extent.
 *
 * A little past `RELAX_END_M`: beyond that the ground is flat at the far-field
 * level and there is nothing for a fine grid to resolve.
 */
const NEAR_PAD_M = 170;
/**
 * Target cell size of the uniform part of the grid, metres.
 *
 * Ten, and it was arrived at by measurement rather than by taste: at 26m and at
 * 16m the drawn surface still stood 0.4m to 5m above the run-off where the lap
 * runs back alongside itself at a different height, because a cell that wide
 * bridges the bank between the two levels. At 10m it is zero on all eleven
 * circuits — see the last column of `npm run probe:shoulders`. It costs between
 * 62k and 134k triangles per circuit in one draw call, against the 900k the
 * circuit already is, and 0.2 to 0.5s of load.
 */
const CELL_M = 10;
/** Cap on uniform cells per axis, so a big circuit does not blow the budget. */
const MAX_UNIFORM = 400;
/**
 * How far the ground has to reach.
 *
 * Beyond the fog's far distance, not beyond the track: looking down a 1km
 * straight, ground that stops 400m past the circuit shows its own edge as a
 * hard horizon line.
 */
const FAR_M = 6000;
/** Growth factor of the cells outside the uniform region. */
const FAR_GROWTH = 1.8;

/**
 * Sample coordinates along one axis: uniform over the circuit and its
 * surroundings, then geometrically expanding out to the horizon.
 *
 * One mesh rather than a detailed patch inside a coarse plane, because two
 * meshes meeting is a seam and a seam at ground level under a low sun is a
 * black line across the landscape. Expanding cells give the resolution where
 * the terrain is doing something and cost about twenty columns for the rest.
 */
function axisCoords(lo: number, hi: number): number[] {
  const a = lo - NEAR_PAD_M;
  const b = hi + NEAR_PAD_M;
  let cells = Math.ceil((b - a) / CELL_M);
  if (cells > MAX_UNIFORM) cells = MAX_UNIFORM;
  const cell = (b - a) / cells;

  const out: number[] = [];
  for (let i = 0; i <= cells; i++) out.push(a + i * cell);

  // Outward on both sides. The last step is snapped to the horizon distance so
  // the mesh ends exactly where it is meant to.
  const grow = (from: number, dir: 1 | -1): number[] => {
    const edge = from + dir * FAR_M;
    const list: number[] = [];
    let at = from;
    let d = cell * FAR_GROWTH;
    while (dir > 0 ? at + d < edge : at - d > edge) {
      at += dir * d;
      list.push(at);
      d *= FAR_GROWTH;
    }
    list.push(edge);
    return list;
  };
  return [...grow(a, -1).reverse(), ...out, ...grow(b, 1)];
}

/** A built ground mesh, and a way to ask what height it actually drew. */
export interface TerrainMesh {
  geometry: THREE.BufferGeometry;
  /**
   * The height of the DRAWN surface at a world point.
   *
   * Not the same question as `TerrainField.heightAt`: the mesh samples the
   * field at its vertices and is linear in between, so between them it can sit
   * a little above or below the field. Above is the one that matters — that is
   * ground poking up through the run-off — and this is how `probe:shoulders`
   * checks for it rather than trusting the grid to be fine enough.
   */
  sampleAt(x: number, z: number): number;
}

/**
 * The ground mesh, following the field.
 *
 * Vertex heights come from `TerrainField.heightAt` — the same call the skirt's
 * foot uses — so the two surfaces meet at every station rather than nearly.
 */
export function buildTerrainMesh(
  track: TrackSpline, field: TerrainField,
): TerrainMesh {
  const b = track.bounds();
  const xs = axisCoords(b.minX, b.maxX);
  const zs = axisCoords(b.minZ, b.maxZ);
  const nx = xs.length;
  const nz = zs.length;

  const positions = new Float32Array(nx * nz * 3);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const o = (iz * nx + ix) * 3;
      const x = xs[ix];
      const z = zs[iz];
      // The roof is taken over this vertex's own cells, so that a cell which
      // straddles a road has all four corners held under it and cannot bridge
      // across. Beyond the uniform region the cells are kilometres wide and
      // there is no circuit near them, so the roof never applies.
      const span = Math.max(
        ix > 0 ? x - xs[ix - 1] : 0, ix < nx - 1 ? xs[ix + 1] - x : 0,
        iz > 0 ? z - zs[iz - 1] : 0, iz < nz - 1 ? zs[iz + 1] - z : 0,
      );
      positions[o] = x;
      positions[o + 1] = Math.min(
        field.heightAt(x, z), field.roofAt(x, z, Math.min(span * 1.5, 60)),
      );
      positions[o + 2] = z;
    }
  }

  const quads = (nx - 1) * (nz - 1);
  const index = quads * 6 > 65535
    ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let t = 0;
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const c = a + 1;
      const d = a + nx;
      const e = d + 1;
      // Wound counter-clockwise seen from above, which is front-facing for a
      // surface you look down on.
      index[t++] = a; index[t++] = d; index[t++] = c;
      index[t++] = c; index[t++] = d; index[t++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  /** Index of the cell containing `v` in an ascending coordinate list. */
  const cell = (list: number[], v: number): number => {
    let lo = 0;
    let hi = list.length - 2;
    if (v <= list[0]) return 0;
    if (v >= list[list.length - 1]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const yAt = (ix: number, iz: number) => positions[(iz * nx + ix) * 3 + 1];

  return {
    geometry: geo,
    sampleAt(x: number, z: number): number {
      const ix = cell(xs, x);
      const iz = cell(zs, z);
      const u = (x - xs[ix]) / (xs[ix + 1] - xs[ix]);
      const v = (z - zs[iz]) / (zs[iz + 1] - zs[iz]);
      const ya = yAt(ix, iz);
      const yc = yAt(ix + 1, iz);
      const yd = yAt(ix, iz + 1);
      const ye = yAt(ix + 1, iz + 1);
      // The cell is split along the u+v=1 diagonal, matching the winding above.
      return u + v <= 1
        ? ya + u * (yc - ya) + v * (yd - ya)
        : ye + (1 - u) * (yd - ye) + (1 - v) * (yc - ye);
    },
  };
}
