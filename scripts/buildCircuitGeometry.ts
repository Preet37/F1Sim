import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Converts real circuit centrelines into the control points the track spline
 * consumes.
 *
 * Source is `data/circuits/*.geojson`, vendored from bacinger/f1-circuits (MIT)
 * — a GeoJSON LineString of WGS84 coordinates per circuit, plus the official
 * length. Until now the circuits were hand-authored from a segment DSL, which
 * produced layouts that were faithful in corner *sequence* but were not the
 * real shape. These are the real shape.
 *
 * The conversion is three steps, and each one exists for a reason:
 *
 *  1. PROJECT. Latitude and longitude are angles on a sphere, not metres. An
 *     equirectangular projection about the circuit's own centre is exact enough
 *     over the few kilometres a circuit spans, provided the longitude axis is
 *     scaled by cos(latitude) — skip that and every circuit comes out stretched
 *     east-west by up to a factor of two at high latitudes. Zandvoort at 52°N
 *     would be 60% too wide.
 *
 *  2. DEDUPLICATE AND CLOSE. The source traces start and end on the same point
 *     to close the ring. Fed to a closed spline that duplicate becomes a
 *     zero-length segment, which produces a NaN tangent and poisons the whole
 *     curvature array.
 *
 *  3. RESAMPLE TO UNIFORM ARCLENGTH. Source vertices are placed where the
 *     tracer clicked — 20m apart through Monaco's corners, 70m apart down
 *     Baku's straight. Uneven spacing weights a Catmull-Rom's shape toward
 *     wherever the points are dense, so resampling evenly is what stops the
 *     corners bulging.
 *
 * The spline itself rescales to the official length, so absolute scale here
 * only has to be self-consistent, not exact.
 */

const SRC_DIR = 'data/circuits';
const OUT_FILE = 'src/data/tracks/realGeometry.ts';

/** Target spacing of emitted control points, metres. */
const CONTROL_SPACING_M = 26;
/**
 * Taubin smoothing passes over the resampled trace.
 *
 * Hand-traced coordinates carry jitter of a few metres, and curvature is a
 * second derivative — so jitter that is invisible on a map becomes violent
 * spikes in the curvature array, which the speed solver reads as a series of
 * hairpins on what should be a straight.
 */
const SMOOTH_PASSES = 6;
/** Spacing used for the intermediate smoothing pass, metres. */
const SMOOTH_SPACING_M = 8;

interface Circuit {
  id: string;
  name: string;
  officialLengthM: number;
  altitudeM: number;
  points: number[];
}

/** Equirectangular projection about a reference latitude, in metres. */
function project(coords: number[][]): { xs: number[]; zs: number[] } {
  const R = 6_378_137;
  let latSum = 0;
  let lonSum = 0;
  for (const [lon, lat] of coords) { latSum += lat; lonSum += lon; }
  const lat0 = (latSum / coords.length) * (Math.PI / 180);
  const lon0 = lonSum / coords.length;
  const cosLat = Math.cos(lat0);

  const xs: number[] = [];
  const zs: number[] = [];
  for (const [lon, lat] of coords) {
    xs.push(((lon - lon0) * (Math.PI / 180)) * R * cosLat);
    // Negated so that north is -z, matching the renderer's convention of the
    // camera looking down +z.
    zs.push(-((lat - (lat0 * 180 / Math.PI)) * (Math.PI / 180)) * R);
  }
  return { xs, zs };
}

/** Removes consecutive duplicates, including the closing repeat. */
function dedupe(xs: number[], zs: number[]): { xs: number[]; zs: number[] } {
  const ox: number[] = [];
  const oz: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const n = ox.length;
    if (n > 0 && Math.hypot(xs[i] - ox[n - 1], zs[i] - oz[n - 1]) < 1e-6) continue;
    ox.push(xs[i]);
    oz.push(zs[i]);
  }
  // The trace closes on its start point; drop it so the ring is implicit.
  while (ox.length > 2 && Math.hypot(ox[0] - ox[ox.length - 1], oz[0] - oz[oz.length - 1]) < 1e-6) {
    ox.pop();
    oz.pop();
  }
  return { xs: ox, zs: oz };
}

/**
 * Taubin smoothing: noise removal that does not shrink the shape.
 *
 * Plain Laplacian smoothing — repeatedly replacing each point with a weighted
 * average of its neighbours — removes jitter, but every pass also pulls the
 * curve toward its own centre. Run it hard enough to flatten tracer noise on a
 * straight and it eats the corners: at 22 passes Monaco lost 7% of its lap
 * distance, which is not smoothing, it is deleting the hairpin.
 *
 * Taubin's fix is to alternate a positive smoothing pass (lambda) with a
 * slightly larger negative one (mu). The negative pass is a controlled
 * un-smoothing that pushes the surface back out. High-frequency noise, which
 * the positive pass removed almost entirely, does not come back; low-frequency
 * shape, which it barely touched, is restored. The result is a filter with a
 * genuine pass band rather than one that just shrinks everything toward a
 * point.
 *
 * The condition for stability is mu < -lambda.
 */
function smooth(xs: number[], zs: number[], passes: number): void {
  const n = xs.length;
  const LAMBDA = 0.5;
  const MU = -0.53;

  const step = (k: number) => {
    const cx = xs.slice();
    const cz = zs.slice();
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      // Discrete Laplacian: the offset from this point to its neighbours' mean.
      const lx = (cx[a] + cx[b]) * 0.5 - cx[i];
      const lz = (cz[a] + cz[b]) * 0.5 - cz[i];
      xs[i] = cx[i] + k * lx;
      zs[i] = cz[i] + k * lz;
    }
  };

  for (let p = 0; p < passes; p++) {
    step(LAMBDA);
    step(MU);
  }
}

/**
 * Centripetal Catmull-Rom interpolation through the source vertices.
 *
 * The source is a coarse polyline — vertices 20 to 70 metres apart — and
 * resampling it directly produces a polygon. Curvature is a second derivative,
 * so a polygon reads as a straight line punctuated by infinite-curvature
 * spikes at each vertex; the speed solver sees those as corners and brakes for
 * them, which is why the first attempt solved every lap 12% slow.
 *
 * Fitting a curve THROUGH the vertices instead gives continuous curvature
 * between them, which is what the real tarmac has.
 *
 * Centripetal parameterisation (the exponent of 0.5 on the chord length) rather
 * than uniform is essential here precisely because the vertices are unevenly
 * spaced: uniform Catmull-Rom overshoots badly when a short segment follows a
 * long one, throwing loops out past the corner. Centripetal is provably free of
 * cusps and self-intersections.
 */
function catmullRomClosed(xs: number[], zs: number[], samplesPerSpan: number): { xs: number[]; zs: number[] } {
  const n = xs.length;
  const ox: number[] = [];
  const oz: number[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = (i - 1 + n) % n;
    const p1 = i;
    const p2 = (i + 1) % n;
    const p3 = (i + 2) % n;

    const x0 = xs[p0], z0 = zs[p0];
    const x1 = xs[p1], z1 = zs[p1];
    const x2 = xs[p2], z2 = zs[p2];
    const x3 = xs[p3], z3 = zs[p3];

    // Knot sequence from chord lengths raised to 0.5.
    const d = (ax: number, az: number, bx: number, bz: number) =>
      Math.pow(Math.max(Math.hypot(bx - ax, bz - az), 1e-6), 0.5);
    const t0 = 0;
    const t1 = t0 + d(x0, z0, x1, z1);
    const t2 = t1 + d(x1, z1, x2, z2);
    const t3 = t2 + d(x2, z2, x3, z3);

    for (let s = 0; s < samplesPerSpan; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSpan;

      const a1x = ((t1 - t) * x0 + (t - t0) * x1) / (t1 - t0);
      const a1z = ((t1 - t) * z0 + (t - t0) * z1) / (t1 - t0);
      const a2x = ((t2 - t) * x1 + (t - t1) * x2) / (t2 - t1);
      const a2z = ((t2 - t) * z1 + (t - t1) * z2) / (t2 - t1);
      const a3x = ((t3 - t) * x2 + (t - t2) * x3) / (t3 - t2);
      const a3z = ((t3 - t) * z2 + (t - t2) * z3) / (t3 - t2);

      const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
      const b1z = ((t2 - t) * a1z + (t - t0) * a2z) / (t2 - t0);
      const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
      const b2z = ((t3 - t) * a2z + (t - t1) * a3z) / (t3 - t1);

      ox.push(((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1));
      oz.push(((t2 - t) * b1z + (t - t1) * b2z) / (t2 - t1));
    }
  }
  return { xs: ox, zs: oz };
}

/** Resamples a closed polyline to evenly spaced points. */
function resample(xs: number[], zs: number[], count: number): number[] {
  const n = xs.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
    seg.push(d);
    total += d;
  }

  const out: number[] = [];
  const step = total / count;
  let segIndex = 0;
  let segRemaining = seg[0];
  let cx = xs[0];
  let cz = zs[0];

  for (let k = 0; k < count; k++) {
    let need = step;
    // Walk forward along the polyline until this sample's distance is consumed.
    while (need > segRemaining && segIndex < n * 2) {
      need -= segRemaining;
      segIndex++;
      const i = segIndex % n;
      const j = (segIndex + 1) % n;
      cx = xs[i];
      cz = zs[i];
      segRemaining = seg[i];
      void j;
    }
    const i = segIndex % n;
    const j = (segIndex + 1) % n;
    const len = seg[i] || 1;
    const t = 1 - (segRemaining - need) / len;
    void t;
    const frac = need / (segRemaining || 1);
    const nx = cx + (xs[j] - cx) * frac;
    const nz = cz + (zs[j] - cz) * frac;
    out.push(nx, nz);
    segRemaining -= need;
    cx = nx;
    cz = nz;
  }
  return out;
}

const circuits: Circuit[] = [];

for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith('.geojson')).sort()) {
  const id = file.replace(/\.geojson$/, '');
  const doc = JSON.parse(readFileSync(join(SRC_DIR, file), 'utf8'));
  const feature = doc.features[0];
  const props = feature.properties;
  const coords: number[][] = feature.geometry.coordinates;

  const projected = project(coords);
  const clean = dedupe(projected.xs, projected.zs);

  const officialLengthM: number = props.length;

  // Resample BEFORE smoothing, not after.
  //
  // The source vertices are unevenly spaced — dense through corners, sparse
  // down straights — and a fixed-width smoothing kernel applied to them
  // therefore smooths by a different real-world distance at every point. It
  // barely touches a straight and heavily rounds a corner, which is the exact
  // opposite of what is wanted. Resampling to uniform spacing first makes the
  // kernel mean the same number of metres everywhere.
  //
  // This matters more than it sounds: curvature is a second derivative, so a
  // few metres of tracer jitter becomes a spike the speed solver reads as a
  // corner. Left unsmoothed, the solved lap times came out 12% slow because
  // every straight was littered with phantom curvature.
  // Interpolate a smooth curve through the sparse vertices first, THEN resample
  // it evenly and take the jitter off with a shrink-free filter.
  const curve = catmullRomClosed(clean.xs, clean.zs, 12);

  const fine = Math.max(128, Math.round(officialLengthM / SMOOTH_SPACING_M));
  const uniform = resample(curve.xs, curve.zs, fine);
  const ux: number[] = [];
  const uz: number[] = [];
  for (let i = 0; i < uniform.length; i += 2) { ux.push(uniform[i]); uz.push(uniform[i + 1]); }
  smooth(ux, uz, SMOOTH_PASSES);

  const count = Math.max(64, Math.round(officialLengthM / CONTROL_SPACING_M));
  const points = resample(ux, uz, count);

  circuits.push({
    id,
    name: props.Name,
    officialLengthM,
    altitudeM: props.altitude ?? 0,
    points: points.map((v) => Math.round(v * 100) / 100),
  });

  // Sanity: the traced length should land close to the official figure. A big
  // discrepancy means the projection or the source trace is wrong.
  let traced = 0;
  for (let i = 0; i < ux.length; i++) {
    const j = (i + 1) % ux.length;
    traced += Math.hypot(ux[j] - ux[i], uz[j] - uz[i]);
  }
  const err = ((traced - officialLengthM) / officialLengthM) * 100;
  console.log(
    `${id.padEnd(13)} ${props.Name.slice(0, 34).padEnd(36)} ` +
    `official=${officialLengthM}m traced=${traced.toFixed(0)}m (${err >= 0 ? '+' : ''}${err.toFixed(1)}%)  ` +
    `pts=${count}`,
  );
}

const header = `// GENERATED FILE — do not edit by hand.
//
// Produced by scripts/buildCircuitGeometry.ts from the GeoJSON traces in
// data/circuits/, which are vendored from bacinger/f1-circuits (MIT licence,
// see data/circuits/LICENSE-f1-circuits.md).
//
// These are the real circuit shapes, projected to metres and resampled to
// uniform arclength. The track spline rescales them to each circuit's official
// length, so the numbers here only need to be internally consistent.
//
// Regenerate with:  npm run build:circuits

export interface RealCircuitGeometry {
  /** Official circuit name, for cross-checking against the game's own data. */
  name: string;
  /** Published lap distance, metres. */
  officialLengthM: number;
  /** Altitude of the start/finish line, metres above sea level. */
  altitudeM: number;
  /** Centreline control points as flat [x, z, x, z, ...] in metres. */
  points: readonly number[];
}

export const REAL_GEOMETRY: Record<string, RealCircuitGeometry> = {
`;

const body = circuits.map((c) => {
  const pts = c.points.join(',');
  return `  ${c.id}: {\n` +
    `    name: ${JSON.stringify(c.name)},\n` +
    `    officialLengthM: ${c.officialLengthM},\n` +
    `    altitudeM: ${c.altitudeM},\n` +
    `    points: [${pts}],\n` +
    `  },`;
}).join('\n');

writeFileSync(OUT_FILE, header + body + '\n};\n');
console.log(`\nWrote ${OUT_FILE} — ${circuits.length} circuits.`);
