import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Lofted surface generation.
 *
 * A modern Formula 1 car has almost no flat surfaces on it. Building one from box
 * primitives produces something that reads unmistakably as boxes no matter how
 * many you use, because the silhouette is made of hard 90-degree corners and the
 * shading is faceted.
 *
 * The fix is to loft: define a series of cross-sections along the car's length,
 * each a smooth closed profile, and skin a surface between them. That gives a
 * continuously curved body whose silhouette tapers the way a real car's does, and
 * whose normals can be averaged for smooth shading. It is also how the shape would
 * be modelled in a 3D package, so the result is not an approximation of the right
 * technique — it is the right technique.
 *
 * Every surface here carries UVs, because a livery is not a colour. It is graphics
 * — a flash down the sidepod, a contrasting nose, a race number — and graphics
 * need a parameterisation. A lofted surface has one for free: u runs around the
 * section, v runs along the car. That is the whole reason the body is lofted
 * rather than assembled, and it is what lets `Livery.ts` paint a car by drawing
 * into a canvas instead of by subdividing geometry.
 *
 * UV CONVENTION. u = 0 sits on the BOTTOM centreline and runs 0.25 left flank,
 * 0.5 top centreline, 0.75 right flank, 1.0 back to the bottom. The seam therefore
 * falls on the underside of the car, where nothing is ever drawn and nobody looks.
 * v = 0 is the first section (the front) and 1 the last, distributed by arc length
 * so a long taper does not squash the texture. `setPanelUV` turns that a quarter
 * turn on its way into the atlas; see the note there for why.
 */

/** A closed cross-section at some distance along the loft axis. */
export interface Section {
  /** Position along the loft axis (the car's Z, positive forward). */
  z: number;
  /** Half-width of the section. */
  halfWidth: number;
  /**
   * Lateral centre of the section, 0 on the car's centreline.
   *
   * Sidepods are the reason this exists. A pod lofted about a fixed centreline
   * and then translated outboard can only ever be a constant distance from the
   * car's axis, so its tail stays out at the same x as its inlet — and the tail
   * is exactly where the rear tyre is. The result is the tyre passing through
   * the bodywork, which is what the reference car conspicuously does not do:
   * every current pod pulls hard inboard behind the radiator exit into the
   * "coke bottle", and the empty channel that leaves between the pod and the
   * rear wheel is one of the shapes the eye checks for.
   */
  xc?: number;
  /** Total height of the section. */
  height: number;
  /** Vertical centre of the section. */
  y: number;
  /**
   * Corner rounding, 0..1. At 0 the section is a rectangle; at 1 it is an
   * ellipse. Intermediate values give the squared-off-oval shape an F1
   * monocoque actually has.
   */
  round: number;
  /**
   * Flattens the top of the section, 0..1. Used for the cockpit opening and the
   * floor, both of which are flat on top of an otherwise rounded body.
   */
  flatTop?: number;
  /** Scales the lower half only — an undercut, as under a sidepod. */
  undercut?: number;
  /**
   * Depth of the cockpit trough below the coaming line, in metres. Zero — the
   * default — leaves the section closed.
   *
   * This is the aperture. See `OpenTop` for what it does and why the depth is
   * a per-section scalar rather than a flag.
   */
  openDepth?: number;
  /**
   * How far inboard of the coaming the interior wall starts, in metres. This
   * is the thickness of the bodywork at the rim, and it is what makes the
   * aperture edge read as a rolled lip rather than as a cut in paper.
   */
  openWall?: number;
}

/**
 * Builds a section from the two numbers that are actually easy to reason about
 * on a car: how high off the ground its underside and its upper surface sit.
 *
 * Every real constraint on this bodywork is expressed that way — the floor is at
 * 60mm, the cockpit rim at 550mm, the top of the airbox at 950mm — and converting
 * those to a centre and a height by hand at every station is how the first version
 * of this file ended up with a monocoque whose roof line wandered.
 */
export function section(
  z: number,
  halfWidth: number,
  bottom: number,
  top: number,
  round: number,
  extra?: {
    flatTop?: number; undercut?: number; xc?: number;
    openDepth?: number; openWall?: number;
  },
): Section {
  return {
    z,
    halfWidth,
    xc: extra?.xc,
    height: top - bottom,
    y: (top + bottom) * 0.5,
    round,
    flatTop: extra?.flatTop,
    undercut: extra?.undercut,
    openDepth: extra?.openDepth,
    openWall: extra?.openWall,
  };
}

/**
 * One point on a section's outline.
 *
 * Uses a superellipse rather than a blend of a rectangle and a circle: the
 * exponent gives direct control over how square the corners are, and it produces
 * evenly-distributed points, which matters because uneven spacing shows up as
 * banding in the shading.
 *
 * The parameter starts at the bottom of the section rather than the side, which
 * is what puts the UV seam under the car.
 */
function profilePoint(s: Section, t01: number): { x: number; y: number } {
  const flatTop = s.flatTop ?? 0;
  const undercut = s.undercut ?? 1;

  // Superellipse exponent: 2 is an ellipse, higher is squarer.
  const n = 2 + (1 - s.round) * 6;
  const halfHeight = s.height * 0.5;

  const t = t01 * Math.PI * 2 - Math.PI / 2;
  const c = Math.cos(t);
  const sn = Math.sin(t);

  const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * s.halfWidth;
  let py = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n) * halfHeight;

  // Flatten the upper surface toward a plane.
  if (flatTop > 0 && py > 0) {
    py = py * (1 - flatTop) + halfHeight * flatTop * (Math.abs(px) < s.halfWidth * 0.72 ? 1 : 0.35);
  }
  // Undercut narrows the lower half.
  const xScale = py < 0 ? 1 - (1 - undercut) * (-py / halfHeight) : 1;

  return { x: (s.xc ?? 0) + px * xScale, y: s.y + py };
}

// ---------------------------------------------------------------------------
// Open-top lofts: a real cockpit aperture
// ---------------------------------------------------------------------------

/**
 * Cuts a genuine opening along the top of a loft.
 *
 * A closed loft can only ever describe a lid. The monocoque's cockpit region
 * was authored with a `flatTop` schedule and a comment reading "cockpit
 * opening", and that is all it was: the deck ran unbroken across the car at
 * y 0.562-0.594 for the whole length of the survival cell, sealing the driver,
 * the tub interior and the headrest inside it and leaving the helmet sitting on
 * the bodywork like a ball on a table. From the driver's own camera the same
 * deck was the "yellow blob" filling the bottom half of the frame. No amount of
 * re-profiling fixes that, because the surface being profiled is the wrong
 * surface: what is needed is a hole.
 *
 * WHAT THIS DOES. Over a band of the ring parameter centred on the top
 * centreline, the profile stops following the outer superellipse and instead
 * rolls over an inner lip and descends into a squared-off trough — the survival
 * cell. The ring stays a single closed loop, so the surface is still watertight,
 * still skins with the same quad strip, still caps at the ends and still takes
 * averaged normals. Nothing downstream of `profilePoint` had to learn about it.
 *
 * WHY THE DEPTH LIVES ON THE SECTION AND THE SPAN LIVES HERE. The aperture has
 * to open and close along the car — there is bodywork ahead of the driver's
 * knees and behind his headrest — so its DEPTH is a per-section scalar that
 * `resample` interpolates like any other, and a section with `openDepth` of
 * zero is simply closed. Its ANGULAR SPAN, though, is fixed for the whole loft,
 * and it has to be: the skin connects vertex i of one ring to vertex i of the
 * next, so if two neighbouring rings disagreed about which part of the ring is
 * aperture, the surface between them would twist.
 *
 * THE POINT BUDGET. A squared-off section spends most of its ring parameter on
 * the corners — at `round` 0.2 the whole deck between the shoulders is barely a
 * tenth of the ring, which is three vertices out of thirty-two. That is plenty
 * for a flat lid and nowhere near enough for a lip, two walls and a floor. So
 * the ring is REPARAMETERISED: `share` of the vertices are given to the
 * aperture band regardless of how little of the profile it spans.
 *
 * That warp is deliberately kept out of the UVs. `loft` derives u from the
 * warped parameter rather than from the vertex index, so a point on the flank
 * carries exactly the u it carried before — the livery does not move by a
 * pixel, and the texture that used to paint the deck now paints the coaming and
 * the interior, which is where it belongs.
 */
export interface OpenTop {
  /**
   * Ring parameter of the coaming on the +x side. The aperture spans
   * `[edge, 1 - edge]`; 0.25 is the flank and 0.5 the top centreline, so a
   * larger number is a narrower opening. Use `apertureEdge` to get this from a
   * width instead of guessing.
   */
  edge: number;
  /** Share of each ring's vertices given to the aperture, 0..1. */
  share: number;
  /**
   * Fraction of the aperture span spent rolling over the lip at each side.
   *
   * This is the radius on the coaming. At zero the deck meets the inner wall in
   * a knife edge that catches no light and reads as a cut in paper; a real
   * cockpit surround is laid up over a radius and that radius is the bright
   * line the eye follows all the way round the opening.
   */
  roll?: number;
  /**
   * Squareness of the trough, the same convention as `Section.round` inverted:
   * 2 is a half-ellipse, higher gives the near-vertical walls and flat floor a
   * survival cell actually has.
   */
  wallExp?: number;
  /**
   * Texture coordinate for every vertex inside the opening — a swatch, not a
   * point on the body panel.
   *
   * Without this the aperture is the right shape and still reads as a dished
   * PANEL rather than as a hole, because it is painted in the team's colour all
   * the way to the floor. A survival cell is bare carbon inside; that contrast
   * between a lit painted coaming and a dark interior is most of what tells the
   * eye there is a hole there at all, and it does more work than the geometry.
   *
   * The lip therefore has to be a hard UV seam, and this is what makes it one:
   * the two coaming columns are DUPLICATED, one carrying the panel's u and one
   * carrying the swatch, so nothing interpolates between them. Left as a single
   * column the quad either side of the lip would have run its u from the middle
   * of the body panel to a swatch on the far side of the atlas, dragging a band
   * of whatever lies between them round the entire opening. The positions of
   * the two columns are identical and their normals are averaged back together
   * afterwards, so the seam is invisible except in the paint — which is exactly
   * where a real coaming's is.
   */
  interiorUV?: readonly [number, number];
}

/**
 * The ring parameter at which a section of the given roundness reaches `frac`
 * of its half-width.
 *
 * The superellipse's x is `|cos t|^(2/n)` of the half-width, so this inverts
 * exactly rather than searching. Lets the cockpit opening be specified as "72%
 * of the tub's width", which is a number that can be checked against a
 * photograph, instead of as a raw ring parameter, which cannot.
 */
export function apertureEdge(round: number, frac: number): number {
  const n = 2 + (1 - round) * 6;
  const c = Math.pow(Math.max(1e-6, Math.min(1, frac)), n / 2);
  return (Math.acos(Math.min(1, c)) + Math.PI / 2) / (Math.PI * 2);
}

/** An `OpenTop` with its optional shape parameters filled in. */
type ResolvedOpen =
  Required<Omit<OpenTop, 'interiorUV'>> & Pick<OpenTop, 'interiorUV'>;

/** Smoothstep, for the lip roll. */
function smoothstep(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
}

/**
 * One point on a section's outline, with the cockpit aperture applied.
 *
 * Outside the aperture band, and on any section whose `openDepth` is zero, this
 * is `profilePoint` unchanged — which is what keeps the nose, the engine cover
 * and every other loft in the project byte-identical.
 */
function openProfilePoint(
  s: Section, t01: number, o: ResolvedOpen,
): { x: number; y: number } {
  const outer = profilePoint(s, t01);
  const depth = s.openDepth ?? 0;
  if (depth <= 1e-6 || t01 <= o.edge || t01 >= 1 - o.edge) return outer;

  // q runs 0 at the +x coaming to 1 at the -x one.
  const q = (t01 - o.edge) / (1 - 2 * o.edge);
  // The lip roll: 0 on the coaming itself, so the aperture surface leaves the
  // outer skin at exactly the point the outer skin ends at, and 1 once we are
  // fully inside.
  const b = smoothstep(Math.min(q, 1 - q) / o.roll);
  if (b <= 0) return outer;

  const xc = s.xc ?? 0;
  // The coaming, taken from the section's own profile: the opening therefore
  // follows the tub's shoulder line up and down the car for free.
  const rim = profilePoint(s, o.edge);
  const inner = Math.max(1e-4, rim.x - xc - (s.openWall ?? 0.024));

  const th = Math.PI * q;
  const p = 2 / o.wallExp;
  const c = Math.cos(th), sn = Math.sin(th);
  const bx = xc + Math.sign(c) * Math.pow(Math.abs(c), p) * inner;
  const by = rim.y - depth * Math.pow(Math.abs(sn), p);

  return { x: outer.x + (bx - outer.x) * b, y: outer.y + (by - outer.y) * b };
}

/**
 * Builds the index-to-ring-parameter warp that gives the aperture its share of
 * the vertices.
 *
 * Piecewise linear in three pieces, so the density is constant within the
 * flanks, within the aperture, and within the flanks again. The two breaks land
 * exactly on the coaming, which is a crease anyway.
 */
function apertureWarp(
  o: ResolvedOpen, a0: number, a1: number,
): (x: number) => number {
  const e0 = o.edge, e1 = 1 - o.edge;
  return (x: number): number => {
    if (x <= a0) return a0 > 0 ? (x / a0) * e0 : e0;
    if (x >= a1) return a1 < 1 ? e1 + ((x - a1) / (1 - a1)) * (1 - e1) : e1;
    return e0 + ((x - a0) / (a1 - a0)) * (e1 - e0);
  };
}

// ---------------------------------------------------------------------------
// Section resampling
// ---------------------------------------------------------------------------

/**
 * Monotone cubic (Fritsch–Carlson) slopes for a set of samples.
 *
 * Plain Catmull-Rom is the obvious choice for smoothing a section list and it
 * is the wrong one. The shape parameters here are not a path through space,
 * they are a schedule — `flatTop` steps 0, 0.25, 0.55, 0.70, 0.40 across the
 * cockpit opening — and a Catmull-Rom through a step OVERSHOOTS, so the roof of
 * the tub bulges above the highest section it was ever given and then dips
 * below the lowest. Monotone Hermite has the same C1 continuity and provably
 * never leaves the interval spanned by its neighbours, so a resampled body is
 * smooth AND stays inside the shape it was authored as.
 */
function monotoneSlopes(t: readonly number[], y: readonly number[]): number[] {
  const n = t.length;
  if (n < 2) return [0];
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    d[i] = dt > 1e-9 ? (y[i + 1] - y[i]) / dt : 0;
  }
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
  }
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-12) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return m;
}

/** Evaluates the monotone Hermite spline defined by (t, y, m) at `x`. */
function hermiteAt(
  t: readonly number[], y: readonly number[], m: readonly number[], x: number,
): number {
  const n = t.length;
  if (x <= t[0]) return y[0];
  if (x >= t[n - 1]) return y[n - 1];
  let i = 0;
  while (i < n - 2 && t[i + 1] < x) i++;
  const h = t[i + 1] - t[i];
  if (h <= 1e-9) return y[i];
  const s = (x - t[i]) / h;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y[i]
    + (s3 - 2 * s2 + s) * h * m[i]
    + (-2 * s3 + 3 * s2) * y[i + 1]
    + (s3 - s2) * h * m[i + 1];
}

/**
 * Resamples a section list onto a finer, smoothly-interpolated one.
 *
 * A loft skins STRAIGHT between the sections it is given. The bodywork here is
 * authored at 200-400mm stations, so the surface it produced was a fan of flat
 * facets a foot wide, and every station drew a crease across the car that no
 * amount of normal averaging can hide — averaging the normals only smears the
 * shading over a silhouette that is still visibly a polygon. This is the single
 * largest source of "blocky" on the body, and it is fixed here rather than by
 * hand-authoring forty sections per part.
 *
 * Every scalar of the section is interpolated independently against distance
 * along the loft axis, so a long lazy taper and a short abrupt one each get the
 * ring density they need.
 *
 * v-COORDINATE SAFETY. `loft` derives v from cumulative |Δz|, and resampling
 * only inserts rings BETWEEN existing ones without moving the ends, so every
 * original station keeps exactly the v it had. Liveries stay put.
 *
 * @param maxStep target ring spacing along the axis, in metres. Zero or less
 *                returns the input untouched, which is what the low tier wants.
 */
export function resample(sections: readonly Section[], maxStep: number): Section[] {
  if (maxStep <= 0 || sections.length < 3) return sections.slice();

  const n = sections.length;
  const t = new Array<number>(n);
  t[0] = 0;
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + Math.abs(sections[i].z - sections[i - 1].z);
  if (t[n - 1] < 1e-6) return sections.slice();

  const fields = {
    z: sections.map((s) => s.z),
    halfWidth: sections.map((s) => s.halfWidth),
    xc: sections.map((s) => s.xc ?? 0),
    height: sections.map((s) => s.height),
    y: sections.map((s) => s.y),
    round: sections.map((s) => s.round),
    flatTop: sections.map((s) => s.flatTop ?? 0),
    undercut: sections.map((s) => s.undercut ?? 1),
    // The aperture opens and closes along the car, and monotone Hermite is
    // exactly the right interpolant for it: the depth schedule is a ramp with
    // flat ends, and a Catmull-Rom through that would overshoot and drive the
    // trough BELOW the floor of the tub at the two stations either side of the
    // ramp — a hole in the underside of the car, in other words.
    openDepth: sections.map((s) => s.openDepth ?? 0),
    openWall: sections.map((s) => s.openWall ?? 0),
  };
  const slopes = {
    z: monotoneSlopes(t, fields.z),
    halfWidth: monotoneSlopes(t, fields.halfWidth),
    xc: monotoneSlopes(t, fields.xc),
    height: monotoneSlopes(t, fields.height),
    y: monotoneSlopes(t, fields.y),
    round: monotoneSlopes(t, fields.round),
    flatTop: monotoneSlopes(t, fields.flatTop),
    undercut: monotoneSlopes(t, fields.undercut),
    openDepth: monotoneSlopes(t, fields.openDepth),
    openWall: monotoneSlopes(t, fields.openWall),
  };

  const out: Section[] = [];
  for (let i = 0; i < n - 1; i++) {
    out.push(sections[i]);
    const span = t[i + 1] - t[i];
    const extra = Math.max(0, Math.ceil(span / maxStep) - 1);
    for (let k = 1; k <= extra; k++) {
      const x = t[i] + (span * k) / (extra + 1);
      out.push({
        z: hermiteAt(t, fields.z, slopes.z, x),
        halfWidth: hermiteAt(t, fields.halfWidth, slopes.halfWidth, x),
        xc: hermiteAt(t, fields.xc, slopes.xc, x),
        height: hermiteAt(t, fields.height, slopes.height, x),
        y: hermiteAt(t, fields.y, slopes.y, x),
        round: hermiteAt(t, fields.round, slopes.round, x),
        flatTop: hermiteAt(t, fields.flatTop, slopes.flatTop, x),
        undercut: hermiteAt(t, fields.undercut, slopes.undercut, x),
        openDepth: hermiteAt(t, fields.openDepth, slopes.openDepth, x),
        openWall: hermiteAt(t, fields.openWall, slopes.openWall, x),
      });
    }
  }
  out.push(sections[n - 1]);
  return out;
}

/**
 * Skins a surface through the given sections.
 *
 * @param sections    ordered front-to-back; at least two
 * @param segments    vertices per ring; 20 is smooth enough at racing distance
 * @param capEnds     closes the first and last ring with a fan
 * @param lengthStep  resample the sections to this spacing first; 0 to skip
 * @param open        cuts a cockpit aperture along the top; see `OpenTop`
 */
export function loft(
  sections: readonly Section[],
  segments = 20,
  capEnds = true,
  lengthStep = 0,
  open?: OpenTop,
): THREE.BufferGeometry {
  if (lengthStep > 0) sections = resample(sections, lengthStep);
  const rings = sections.length;

  // The aperture, if there is one. Resolved once for the whole loft: the warp
  // and the span have to be identical on every ring or the skin twists between
  // them — see the note on `OpenTop`.
  const op: ResolvedOpen | null = open ? { roll: 0.16, wallExp: 4.5, ...open } : null;
  const point = (s: Section, t01: number): { x: number; y: number } =>
    op ? openProfilePoint(s, t01, op) : profilePoint(s, t01);

  // COLUMN SCHEDULE. One entry per vertex of a ring: the ring parameter it is
  // built at, and the texture u it carries. Every ring walks the same list, so
  // the skin between two rings always joins like to like.
  //
  // The list is what the aperture needs to be expressed at all. Two columns
  // land exactly ON the coaming rather than straddling it, so the lip is a real
  // edge rather than something the tessellation happens to cross; and when the
  // interior is being painted from a swatch those two are duplicated, giving a
  // hard UV seam at the lip. See `OpenTop.interiorUV`.
  const colT: number[] = [];
  const colU: number[] = [];
  {
    // Snap the aperture's vertex budget to whole columns, so its edges land on
    // vertices. Rounding here rather than in the warp is what guarantees it.
    const i0 = op
      ? Math.min(Math.max(1, Math.round(segments * (0.5 - op.share * 0.5))), Math.floor(segments / 2) - 1)
      : 0;
    const i1 = segments - i0;
    const warp = op ? apertureWarp(op, i0 / segments, i1 / segments) : null;
    const inner = op?.interiorUV;
    for (let i = 0; i <= segments; i++) {
      const raw = i === segments ? 1 : i / segments;
      // The warp only redistributes vertices; the ring parameter it produces is
      // what BOTH the profile and the UV are taken from, so the livery stays
      // exactly where it was however the points are shuffled. See `OpenTop`.
      const t = warp ? warp(raw) : raw;
      // u runs the opposite way round the section to the vertex order. That is
      // not arbitrary: it makes the (u, v) frame right-handed against the
      // outward normal, and without it every graphic on the car — numbers
      // especially — comes out mirrored.
      const outerU = 1 - t;
      if (inner && i === i0) { colT.push(t); colU.push(outerU); colT.push(t); colU.push(-1); }
      else if (inner && i === i1) { colT.push(t); colU.push(-1); colT.push(t); colU.push(outerU); }
      else { colT.push(t); colU.push(inner && i > i0 && i < i1 ? -1 : outerU); }
    }
  }
  const cols = colT.length;
  const ringVerts = rings * cols;
  // A centre point plus every column except the last, which is the seam's
  // positional duplicate of the first and would give the fan a zero-width slice.
  const capRing = cols - 1;
  const capVerts = capEnds ? 2 * (capRing + 1) : 0;
  const total = ringVerts + capVerts;

  const positions = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  // Which vertices carry a swatch coordinate rather than a point on the body
  // panel. `setPanelUV` has to leave these alone — see `uvPinned` there.
  const pinned = op?.interiorUV ? new Uint8Array(total) : null;

  // v by arc length along the loft axis, so a long slow taper does not get the
  // same slice of the texture as a short abrupt one.
  const vs = new Float32Array(rings);
  let run = 0;
  for (let r = 1; r < rings; r++) {
    run += Math.abs(sections[r].z - sections[r - 1].z);
    vs[r] = run;
  }
  if (run > 1e-6) for (let r = 0; r < rings; r++) vs[r] /= run;
  else for (let r = 0; r < rings; r++) vs[r] = r / Math.max(1, rings - 1);

  const interiorUV = op?.interiorUV;
  for (let r = 0; r < rings; r++) {
    const s = sections[r];
    for (let i = 0; i < cols; i++) {
      const p = point(s, colT[i]);
      const o = (r * cols + i) * 3;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = s.z;
      const uo = (r * cols + i) * 2;
      if (colU[i] < 0 && interiorUV) {
        uvs[uo] = interiorUV[0];
        uvs[uo + 1] = interiorUV[1];
        if (pinned) pinned[r * cols + i] = 1;
      } else {
        uvs[uo] = colU[i];
        uvs[uo + 1] = vs[r];
      }
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * cols;
    const b = (r + 1) * cols;
    for (let i = 0; i < cols - 1; i++) {
      // The duplicated coaming columns are positionally identical, so the quad
      // between them has no area. Skipping it keeps the index buffer honest.
      if (colT[i] === colT[i + 1]) continue;
      // Two triangles per quad, wound so the outward face is front-facing.
      indices.push(a + i, b + i, b + i + 1);
      indices.push(a + i, b + i + 1, a + i + 1);
    }
  }

  if (capEnds) {
    // Cap with a fan to a centre point at each end. Without caps the body is
    // visibly hollow from any angle that sees into it.
    //
    // BOTH CAPS FACED INWARD, ON EVERY LOFT IN THE PROJECT, AND HAD SINCE THIS
    // WAS WRITTEN. The winding below is correct for a section list whose z
    // INCREASES; every list in CarMesh is authored front-to-back, so z
    // decreases, and the two caps came out with their front faces pointing into
    // the part. Back-face culling then removed them, and "capped" lofts were
    // hollow after all — you looked through the end of one and out the far side
    // of the car.
    //
    // It was found on the airbox. Its intake is a dark duct whose mouth is the
    // first section's cap, and the mouth simply was not drawn: with the cap
    // culled, what came through the hole was the engine cover's own upper
    // surface a foot further back, in the team's paint. Three passes fixed "the
    // airbox has no intake" by moving the duct around behind a skin that was
    // never the thing hiding it.
    //
    // `dir` is +1 when the list runs the way the winding assumes and -1 when it
    // runs the other way, which is how every part on this car is written.
    const dir = sections[rings - 1].z > sections[0].z ? 1 : -1;
    let base = ringVerts;
    for (const front of [true, false]) {
      const s = front ? sections[0] : sections[rings - 1];
      const v = front ? 0 : 1;
      positions[base * 3] = s.xc ?? 0;
      positions[base * 3 + 1] = s.y;
      positions[base * 3 + 2] = s.z;
      uvs[base * 2] = 0.5;
      uvs[base * 2 + 1] = v;
      for (let i = 0; i < capRing; i++) {
        // Same ring parameters as the skin, or the cap fan would not land on
        // the ring it is closing and the end of the part would show a ring of
        // cracks. Taken straight off the column schedule, duplicates and all —
        // a duplicated column just contributes a degenerate fan triangle.
        const p = point(s, colT[i]);
        const idx = base + 1 + i;
        positions[idx * 3] = p.x;
        positions[idx * 3 + 1] = p.y;
        positions[idx * 3 + 2] = s.z;
        const isInner = colU[i] < 0 && interiorUV;
        uvs[idx * 2] = isInner ? interiorUV[0] : colU[i];
        uvs[idx * 2 + 1] = isInner ? interiorUV[1] : v;
        if (pinned && isInner) pinned[idx] = 1;
      }
      for (let i = 0; i < capRing; i++) {
        const a = base + 1 + i;
        const b = base + 1 + ((i + 1) % capRing);
        if (front === (dir > 0)) indices.push(base, b, a);
        else indices.push(base, a, b);
      }
      base += capRing + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  if (pinned) geo.userData.uvPinned = pinned;

  // Averaged normals across shared vertices: this is what turns a faceted hull
  // into a smoothly-shaded surface.
  geo.computeVertexNormals();

  // Any pair of columns at the same ring parameter is a positional duplicate
  // that exists only to carry two different UVs, so each of the pair saw half
  // the surface when the normals were averaged. That is the underside seam, and
  // now also the two coaming columns: left alone the first draws a crease down
  // the belly of the car and the second draws a hard black line round the
  // cockpit opening. Welding their normals back together gives the lip the
  // continuous highlight a rolled edge has while keeping the paint seam hard.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const pairs: [number, number][] = [[0, cols - 1]];
  for (let i = 0; i < cols - 1; i++) if (colT[i] === colT[i + 1]) pairs.push([i, i + 1]);
  for (let r = 0; r < rings; r++) {
    for (const [i, j] of pairs) {
      const a = r * cols + i, b = r * cols + j;
      const nx = nrm.getX(a) + nrm.getX(b);
      const ny = nrm.getY(a) + nrm.getY(b);
      const nz = nrm.getZ(a) + nrm.getZ(b);
      const len = Math.hypot(nx, ny, nz) || 1;
      nrm.setXYZ(a, nx / len, ny / len, nz / len);
      nrm.setXYZ(b, nx / len, ny / len, nz / len);
    }
  }
  nrm.needsUpdate = true;

  return geo;
}

/**
 * Remaps a lofted surface's UVs into a panel of a texture atlas, turning them a
 * quarter turn on the way.
 *
 * The rotation is not cosmetic. A car is three times longer than it is round, so
 * mapping the length onto the texture's short axis leaves roughly forty pixels
 * per metre along the car against three hundred across it. Text drawn into that
 * comes out four characters wide and a metre long — which is exactly what the
 * first attempt produced. Turning the panel so the car's LENGTH runs along the
 * atlas's long axis brings the two densities within a factor of one and a half,
 * and everything drawn into it keeps its proportions.
 *
 * Texture u therefore carries the loft's v (front to back) and texture v carries
 * the loft's u (round the section), negated so the frame stays right-handed
 * against the outward normal and nothing comes out mirrored.
 */
export function setPanelUV(
  geo: THREE.BufferGeometry,
  u0: number, v0: number, u1: number, v1: number,
): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return geo;
  // Vertices already pinned to a swatch are NOT points on the panel and must
  // not be folded into it. The cockpit aperture's interior is the case: `loft`
  // pins it to bare carbon, and remapping that coordinate through the panel
  // transform lands it back in the middle of the team's paint — which is
  // exactly what happened the first time, and the opening went on reading as a
  // dished panel because it was still being painted like one.
  const pinned = geo.userData.uvPinned as Uint8Array | undefined;
  for (let i = 0; i < uv.count; i++) {
    if (pinned?.[i]) continue;
    const around = uv.getX(i);
    const along = uv.getY(i);
    uv.setXY(i, u0 + along * (u1 - u0), v0 + (1 - around) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Points every vertex at one texel.
 *
 * Parts that are a single flat colour — a wishbone, an endplate, a tyre — do not
 * need a parameterisation, but they do have to live in the same material as the
 * painted bodywork or the car costs a draw call per colour. Pinning them to a
 * swatch in the atlas is what collapses the entire shell to one draw call.
 */
export function setFlatUV(geo: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

/**
 * Pins a part to TWO texels, chosen per vertex by which way its surface faces.
 *
 * A PAINT LINE ALONG A TUBE, which is what a halo has and what a single flat
 * swatch cannot express. `setFlatUV` above collapses a part to one colour
 * because most parts are one colour; the halo hoop is not. Every real car
 * paints the crown of the hoop in the team's colours and leaves the underside
 * black — `reference/target/76.png` enlarged shows exactly that — and the split
 * is not a decal at a fixed place along the arc, it is "whichever surface faces
 * the sky", which is a property of the NORMAL and follows the hoop round its
 * own curve without anybody having to say where the crown is.
 *
 * Reading the normal rather than the section parameter matters. `TubeGeometry`
 * lays its rings out on a Frenet frame whose phase depends on the curve, so
 * "u = 0.25 round the section" is not reliably the top of anything; the y
 * component of the outward normal is the top of everything, on a hoop that
 * climbs 200mm and rolls through its whole length.
 *
 * THE TRIANGLES THAT STRADDLE THE LINE have one vertex in each cell and their
 * UV is interpolated across the atlas between the two. That is why `Livery`
 * puts the two cells side by side and says so: adjacent flat fills make the
 * interpolation a hard edge with a texel of softening, which is what a paint
 * line looks like. It is also why this takes swatch UVs rather than colours —
 * the part stays in the one material and the one draw call the whole shell is.
 *
 * @param upper texel for vertices whose outward normal is at least `minNormalY`
 * @param lower texel for everything else
 * @param minNormalY y of the unit outward normal at the paint line
 */
export function setFlatUVSplit(
  geo: THREE.BufferGeometry,
  upper: readonly [number, number],
  lower: readonly [number, number],
  minNormalY: number,
): THREE.BufferGeometry {
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const count = geo.attributes.position.count;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    // No normals at all is not a case any caller has, but a part with none
    // would silently come out entirely in the upper colour, which on a halo is
    // a bright tube. Fall back to the lower — the colour it had before.
    const up = nrm ? nrm.getY(i) >= minNormalY : false;
    const [u, v] = up ? upper : lower;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

/**
 * `setFlatUVSplit`'s sibling, split about the car's CENTRELINE — issue #8.
 *
 * WHY A SECOND FUNCTION RATHER THAN A PARAMETER. The halo's paint line is a
 * horizontal band round a tube and the axis that decides it is y; a front wing
 * endplate is a vertical panel and the axis that decides ITS paint line is x —
 * and, unlike y, x has no absolute meaning here. "Outward" on the left plate is
 * −x and on the right plate is +x, so the caller has to say which side the part
 * is on. A single function taking an axis index and a sign would be the same
 * code with two more arguments and one more thing to get backwards.
 *
 * `side` is +1 for the right-hand part and −1 for the left, matching the `for
 * (const side of [-1, 1])` loop `CarMesh` already builds both plates in. A
 * vertex whose outward normal points away from the centreline by at least
 * `minOutward` takes `outer`; everything else — the inner face, and the thin
 * leading and trailing edges where the normal is nearly fore-and-aft — takes
 * `inner`.
 *
 * THE EDGES DELIBERATELY STAY CARBON. `minOutward` is a floor on |n·x̂|, not a
 * sign test, so the wrapped edge of the plate is not painted: on the reference
 * the livery is a decal on the flat of the outer face and the edge reads as the
 * laminate it is. A pure sign test would paint the whole plate up to a
 * zero-width line and put a hard colour seam on the silhouette, which is the
 * one place on this part it would be seen.
 *
 * @param outer texel for vertices facing away from the centreline
 * @param inner texel for everything else
 * @param side +1 for the right-hand part, −1 for the left
 * @param minOutward |x| of the unit outward normal at the paint line
 */
export function setFlatUVSplitX(
  geo: THREE.BufferGeometry,
  outer: readonly [number, number],
  inner: readonly [number, number],
  side: number,
  minOutward: number,
): THREE.BufferGeometry {
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const count = geo.attributes.position.count;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    // Same fallback as the y split and for the same reason: a part with no
    // normals comes out entirely in the colour it had before, never entirely
    // in the new one.
    const out = nrm ? nrm.getX(i) * Math.sign(side) >= minOutward : false;
    const [u, v] = out ? outer : inner;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

/**
 * Builds a wing element: a cambered aerofoil extruded across the car.
 *
 * Boxes are the single most obvious tell of a procedural car, and wings are the
 * part of an F1 car a viewer looks at most. A real aerofoil section — thick
 * leading edge, thin trailing edge, curved underside — costs a handful of extra
 * triangles and completely changes how the car reads.
 */
export function wingElement(
  span: number,
  chord: number,
  thickness: number,
  camber: number,
  segments = 12,
  /**
   * How far FORWARD the tips sit relative to the root, in metres.
   *
   * A front wing is not a straight bar, and building it as one is the reason
   * the front of the car kept reading as a snowplough however dark it was
   * painted. Every current front wing sweeps: the endplates sit a good 200mm
   * ahead of where the elements cross the centreline, so in plan the assembly
   * is a shallow delta pointing forwards, and the elements' outer thirds are
   * visibly ahead of their inner thirds from any three-quarter view. That
   * delta is one of the handful of shapes a viewer checks for without knowing
   * they are checking.
   *
   * Applied quadratically in the span coordinate, which is what an aerofoil
   * swept about a spar actually does and what keeps the root region straight.
   */
  sweep = 0,
  /**
   * Interior span stations, overriding the default.
   *
   * A straight element is ruled between its two ends, so two stations describe
   * it exactly, and a swept one needs six to draw its plan curve. An element
   * that is about to be bent SPANWISE by `riseSpanwise` needs enough stations to
   * draw THAT curve, and the bend happens after this function has returned — so
   * the caller has to ask for them here or the shallow W comes out as a chevron.
   */
  interior = 0,
): THREE.BufferGeometry {
  // Closed aerofoil outline, upper surface forward then lower surface back, with
  // the leading and trailing edge points shared so the ring has no duplicates.
  const ring: [number, number][] = [];
  const surfaceY = (x: number, sign: number): number => {
    // NACA-like thickness distribution.
    const yt =
      thickness *
      (1.4845 * Math.sqrt(x) - 0.63 * x - 1.758 * x * x + 1.4215 * x * x * x - 0.5075 * x * x * x * x);
    // Camber line, biased to the rear like a high-downforce wing.
    const yc = camber * Math.sin(Math.pow(x, 0.75) * Math.PI);
    return yc + sign * yt;
  };
  for (let i = 0; i <= segments; i++) {
    // Cosine spacing clusters points at the leading edge, where curvature is.
    const x = (1 - Math.cos((i / segments) * Math.PI)) * 0.5;
    ring.push([x * chord, surfaceY(x, 1)]);
  }
  for (let i = segments - 1; i >= 1; i--) {
    const x = (1 - Math.cos((i / segments) * Math.PI)) * 0.5;
    ring.push([x * chord, surfaceY(x, -1)]);
  }
  const around = ring.length;

  // Span stations. An extruded aerofoil is a prism: its tips are a flat cut
  // through the section, and a flat cut looks exactly like what it is — a wing
  // sawn off. A real element closes its tip over a radius. The interior needs
  // only its two end stations because the surface is ruled between them; the
  // cost is entirely in the three rings at each tip.
  const half = span * 0.5;
  // The closing radius is the local thickness, not a fraction of the span: a
  // 1.9m front wing element and a 0.25m winglet want the same physical tuck.
  const tuck = Math.min(Math.max(thickness * 1.6, chord * 0.05), span * 0.12);
  const TIP_RINGS = 3;
  const stations: { z: number; scale: number }[] = [];
  for (let i = 0; i < TIP_RINGS; i++) {
    // Quarter-circle blend: full section at the start of the tuck, a point at
    // the tip itself.
    const f = i / TIP_RINGS;
    stations.push({ z: -half + tuck * f, scale: Math.sqrt(Math.max(0, 1 - (1 - f) * (1 - f))) });
  }
  // Interior stations. A straight element needs only its two ends, because the
  // surface between them is ruled — but a SWEPT one is a curve in plan, and a
  // curve through two points is a straight line. Six stations is enough that a
  // 200mm sweep across a 1.9m span shows as a smooth arc rather than as a
  // shallow chevron.
  const INTERIOR = Math.max(interior, sweep !== 0 ? 6 : 2);
  for (let i = 0; i < INTERIOR; i++) {
    const f = i / (INTERIOR - 1);
    stations.push({ z: -half + tuck + f * (span - 2 * tuck), scale: 1 });
  }
  for (let i = TIP_RINGS - 1; i >= 0; i--) {
    const f = i / TIP_RINGS;
    stations.push({ z: half - tuck * f, scale: Math.sqrt(Math.max(0, 1 - (1 - f) * (1 - f))) });
  }

  // AXES. Span runs along X (across the car) and chord along -Z (toward the
  // tail), which is the orientation every caller positions the result in. The
  // extruded version got here by building in the extruder's frame and then
  // rotating a quarter turn about Y; building it right way round from the start
  // removes a step that is easy to get backwards, and the bounding box comes
  // out identical so `center()` still lands the part exactly where it did.
  //
  // The section shrinks about the mid-chord, mid-thickness point so the tip
  // tuck pulls in from every side rather than collapsing onto the chord line.
  const cx = chord * 0.5;
  const rings = stations.length;
  const positions = new Float32Array(rings * around * 3);
  for (let r = 0; r < rings; r++) {
    const st = stations[r];
    // Sweep: the whole section shifts forward with the square of the span
    // coordinate. Shifting the section rather than shearing it keeps every
    // rib a true aerofoil, which is how a swept wing is really built.
    const t = half > 1e-6 ? st.z / half : 0;
    const fwd = sweep * t * t;
    for (let i = 0; i < around; i++) {
      const o = (r * around + i) * 3;
      positions[o] = st.z;
      positions[o + 1] = ring[i][1] * st.scale;
      positions[o + 2] = fwd - (cx + (ring[i][0] - cx) * st.scale);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * around;
    const b = (r + 1) * around;
    for (let i = 0; i < around; i++) {
      const j = (i + 1) % around;
      indices.push(a + i, b + i, b + j);
      indices.push(a + i, b + j, a + j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  // Indexed and shared: averaging across the ring is what gives the aerofoil a
  // continuous highlight instead of a row of flat facets. The old version came
  // out of ExtrudeGeometry, which is NON-indexed, so `computeVertexNormals`
  // could only produce per-face normals — every wing on the car was faceted no
  // matter how many points the profile had.
  //
  // This also replaces the bevel the extruded version put on its end caps. That
  // bevel existed for a real reason — a moulded composite tip is laid up over a
  // radius, never a ninety-degree corner, and the radius catches the thin line
  // of specular that tells the eye how thick the wing is. The tip TUCK above is
  // the same idea carried out properly: three rings closing over a quarter
  // circle, scaled about the mid-chord so the section pulls in from every side.
  // A sub-2mm bevel on a flat cut only softened the corner; this actually closes
  // the tip, so the wing no longer reads as sawn off.
  geo.computeVertexNormals();
  // Same bounding box as the extruded version had, so every caller's translate
  // still lands the element where it did before.
  geo.center();
  return geo;
}

/**
 * Bends a wing element spanwise: displaces every vertex in Y by a function of
 * how far out along the span it sits.
 *
 * THE SHALLOW W. A current front wing is not a flat bar and it is not a simple
 * arch either. Head-on it falls away either side of the nose to a low point
 * somewhere around the middle of each semi-span, then climbs steadily out to the
 * endplate, which is the highest point on the assembly. Both halves together
 * draw a shallow W, and that W is one of the two or three silhouettes that dates
 * a front wing to this generation — it is what the FIA's front-wing box forces
 * and it is in every head-on photograph. Built flat, four elements at four
 * heights fuse into one dark slab with a straight top edge, which is exactly
 * what the screenshots showed.
 *
 * Applied AFTER the caller has set the element's incidence, not before. Rotating
 * a bent element about X shears the bend into Z as well as Y, by an amount that
 * differs per element because each sits at a different angle — so the four
 * elements' W's come out at four different depths and the assembly splays. Doing
 * it in this order keeps one shared curve across the whole stack.
 *
 * @param halfSpan half the element's span; the argument to `f` is |x| / halfSpan
 *                 clamped to 1, so 0 is the root and 1 the tip
 */
export function riseSpanwise(
  geo: THREE.BufferGeometry,
  halfSpan: number,
  f: (a: number) => number,
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos || halfSpan <= 1e-6) return geo;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) + f(Math.min(1, Math.abs(pos.getX(i)) / halfSpan)));
  }
  pos.needsUpdate = true;
  // The surface has genuinely changed shape, so the normals it was given when it
  // was straight are wrong — and on a part this dark the shading IS the shape.
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Angle-based normal smoothing.
 *
 * Averages normals across edges shallower than `creaseDeg` and leaves sharper
 * ones split. This is what an artist means by a smoothing group, and it is the
 * only correct answer for geometry that is curved in some places and hard in
 * others — an extruded steering-wheel rim wants a continuous highlight round its
 * rounded corners and a hard line where the face meets the edge.
 */
export function creased(geo: THREE.BufferGeometry, creaseDeg = 40): THREE.BufferGeometry {
  const out = toCreasedNormals(geo, (creaseDeg * Math.PI) / 180);
  if (out !== geo) geo.dispose();
  return out;
}

/**
 * A straight round member between two points: a wishbone leg, a pushrod, a
 * mirror stalk.
 *
 * Suspension is worth more than it sounds. The gap between a wheel and the
 * bodywork is a large, obviously-empty void, and filling it with the right
 * linkage geometry is most of what makes an open-wheeler read as engineered
 * rather than as a toy.
 */
/**
 * A limb segment: a cylinder that TAPERS, between two points.
 *
 * `strut` takes one radius, which is right for a wishbone and wrong for an arm.
 * A forearm is half again as thick at the elbow as it is at the wrist, and it is
 * the narrowing into the glove that tells the eye which end is the hand — an
 * untapered tube reads as plumbing, which is what the driver's arms read as the
 * first time anything got close enough to see them.
 */
export function limb(
  a: readonly number[], b: readonly number[],
  r0: number, r1: number, radialSegments = 10,
): THREE.BufferGeometry {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  // CylinderGeometry's first radius is its +y end, which is `b` after the
  // rotation below.
  const g = new THREE.CylinderGeometry(r1, r0, len, radialSegments, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  ));
  g.translate((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5);
  return g;
}

export function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number,
  // Eight, not five. A wishbone is 22mm across and passes within two metres of
  // a chase camera, and a pentagon that size shows every one of its five flats.
  radialSegments = 8,
  capped = false,
  /**
   * Squashes the section across x, turning the round bar into a blade.
   *
   * A halo's forward pillar is not a pipe. It is a narrow vertical aerofoil —
   * roughly 20mm across and three times that front to back — and the entire
   * point of that section is that the one person who has to look straight down
   * it sees only the thin edge. Modelled round at the depth it structurally
   * needs, it comes out three times too wide in the single view where its
   * width is the thing that matters.
   */
  xScale = 1,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  // Open-ended by default: a suspension member's ends are buried in an upright
  // or a chassis pickup, and end caps on twenty-eight of them per car is a few
  // hundred triangles nobody will ever see.
  const g = new THREE.CylinderGeometry(r, r, len, radialSegments, 1, !capped);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  if (xScale !== 1) {
    // Squashed BEFORE the translate, so the section is flattened about its own
    // axis rather than about the car's centreline. Normals take the INVERSE
    // scale, or the blade lights like the round bar it was cut from.
    g.scale(xScale, 1, 1);
    const n = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) {
      const nx = n.getX(i) / xScale, ny = n.getY(i), nz = n.getZ(i);
      const l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
    }
    n.needsUpdate = true;
  }
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/**
 * A straight member with an AEROFOIL section: a wishbone leg, a pushrod, a
 * trackrod.
 *
 * WHY THIS EXISTS ALONGSIDE `strut`. Nothing in a Formula 1 suspension is a
 * round bar. Every member is a carbon blade with a streamwise section —
 * typically 60 to 100mm of chord and 15 to 25mm of thickness, a ratio of about
 * four to one — because each of them sits in clean air ahead of a tyre and
 * costs drag if it is not shaped. That section is not a detail: it is most of
 * what the eye uses to tell a racing car's front suspension from a go-kart's.
 * Built as 42mm round rods, which is what `strut` was giving them, the front of
 * the car reads as "a scatter of black rods at implausible angles" — which is
 * the complaint this function exists to answer.
 *
 * `strut` cannot be extended to do it. Its `xScale` squashes the finished
 * member along the WORLD x axis, which for a wishbone leg — a member that runs
 * very nearly along x — shortens it rather than flattening it. The section has
 * to be oriented in the member's own frame, which means building it there.
 *
 * The section is an ellipse rather than a true aerofoil. At 60mm of chord seen
 * from two metres the difference between an ellipse and a teardrop is under a
 * pixel; what reads is the ratio and the orientation, and both are exact.
 *
 * @param chord    section depth along `chordDir`, metres
 * @param thick    section thickness perpendicular to it, metres
 * @param chordDir the direction the chord lies along, in world axes. Defaults
 *                 to the car's z — streamwise — which is right for every
 *                 wishbone, pushrod and trackrod. A member that runs nearly
 *                 parallel to it (a fore-aft link) should be given something
 *                 else, since the component along the member's own axis is
 *                 projected out and what is left would be arbitrary.
 */
export function aeroStrut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  chord: number, thick: number,
  radialSegments = 8,
  chordDir: readonly [number, number, number] = [0, 0, 1],
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const axis = new THREE.Vector3(dx / len, dy / len, dz / len);

  // The chord direction, with the component along the member projected out. If
  // the caller hands in something nearly parallel to the axis the projection
  // collapses, so fall back to the world y — which for a fore-aft link is the
  // section orientation you would have wanted anyway.
  const c = new THREE.Vector3(chordDir[0], chordDir[1], chordDir[2]);
  c.addScaledVector(axis, -c.dot(axis));
  if (c.lengthSq() < 1e-8) c.set(0, 1, 0).addScaledVector(axis, -axis.y);
  c.normalize();
  const t = new THREE.Vector3().crossVectors(axis, c).normalize();

  // Unit cylinder along +y, then squashed into the section and rotated into the
  // member's frame. Open-ended for the same reason `strut` is: both ends are
  // buried in an upright or a chassis pickup.
  const g = new THREE.CylinderGeometry(1, 1, len, radialSegments, 1, true);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const ht = thick * 0.5;
  const hc = chord * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) * ht, py = pos.getY(i), pz = pos.getZ(i) * hc;
    pos.setXYZ(
      i,
      x0 + (x1 - x0) * 0.5 + t.x * px + axis.x * py + c.x * pz,
      y0 + (y1 - y0) * 0.5 + t.y * px + axis.y * py + c.y * pz,
      z0 + (z1 - z0) * 0.5 + t.z * px + axis.z * py + c.z * pz,
    );
    // Normals take the INVERSE of the section scale — the same rule `strut`
    // documents. Scaling a normal the same way as the position tilts it toward
    // the flattened axis and the blade lights like the round bar it was cut
    // from, which on a 4:1 section is a very visible error.
    let nx = nrm.getX(i) / ht, ny = nrm.getY(i), nz = nrm.getZ(i) / hc;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    nrm.setXYZ(
      i,
      t.x * nx + axis.x * ny + c.x * nz,
      t.y * nx + axis.y * ny + c.y * nz,
      t.z * nx + axis.z * ny + c.z * nz,
    );
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  return g;
}

/**
 * A swept tube through a smooth curve. Used for the halo, which is the one part
 * of the car that is genuinely a bent pipe and looks wrong as anything else.
 */
export function tube(
  points: readonly [number, number, number][],
  radius: number,
  tubularSegments = 24,
  radialSegments = 10,
  /**
   * Optional radius multiplier along the sweep, 0..1 from the first point to
   * the last.
   *
   * `TubeGeometry` sweeps one constant section, and a halo is not one constant
   * section: it is thickest at the two rear mounts, where the whole load of the
   * structure goes into the survival cell, and slimmest over the crown. That
   * taper is not decoration — the crown is the part that crosses the driver's
   * sightline, so it is the part whose diameter decides whether the hoop reads
   * as a thin line or as a bar across the sky.
   *
   * Applied by pushing each ring's vertices toward or away from the centreline
   * point they were generated around, which is what `TubeGeometry` would do
   * itself if it took a profile.
   */
  taper?: (t: number) => number,
  /**
   * Squashes the section vertically, turning the round tube into a flattened
   * teardrop lying on its side.
   *
   * A halo is not a pipe. Photographs of the real part show a section that is
   * appreciably wider than it is tall — an aerofoil laid flat, because the hoop
   * spends its life in the airflow feeding the airbox and every millimetre of
   * frontal height is drag and blocked sightline. Built round, it has to carry
   * its structural depth in BOTH axes, so it stands off the car like a roll bar
   * and reads, in the user's words, as "outwards" rather than as part of the
   * chassis.
   */
  flattenY?: number,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    'catmullrom',
    0.5,
  );
  const geo = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  if (!taper && flattenY === undefined) return geo;
  const flat = flattenY ?? 1;

  // TubeGeometry lays out (tubularSegments + 1) rings of (radialSegments + 1)
  // vertices, ring i generated about curve.getPointAt(i / tubularSegments).
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const ring = radialSegments + 1;
  const centre = new THREE.Vector3();
  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const k = taper ? taper(t) : 1;
    curve.getPointAt(t, centre);
    for (let j = 0; j < ring; j++) {
      const v = i * ring + j;
      pos.setXYZ(
        v,
        centre.x + (pos.getX(v) - centre.x) * k,
        centre.y + (pos.getY(v) - centre.y) * k * flat,
        centre.z + (pos.getZ(v) - centre.z) * k,
      );
    }
  }
  pos.needsUpdate = true;
  // The rings only changed radius, so the outward normals are still outward;
  // recomputing keeps the shading right where the taper rate is steep.
  geo.computeVertexNormals();

  // `TubeGeometry` lays each ring out with its first and last vertex in the
  // same place, carrying u = 0 and u = 1, and `computeVertexNormals` therefore
  // gives each of the pair only half the surface — a hard line straight down
  // the tube. Invisible on a halo two metres away and not invisible on a
  // finger 500mm from the cockpit camera, which is what this is for.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i <= tubularSegments; i++) {
    const a = i * ring, b = a + radialSegments;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / len, ny / len, nz / len);
    nrm.setXYZ(b, nx / len, ny / len, nz / len);
  }
  nrm.needsUpdate = true;
  return geo;
}
