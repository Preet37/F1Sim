/**
 * Segment-based circuit authoring.
 *
 * Circuits are described the way an engineer describes them — "1.1km straight,
 * then a 60-degree right at 28m radius" — instead of as a list of coordinates.
 * That matters because corner *radius* sets corner speed, and corner speed sets
 * lap time. Authoring coordinates by eye gets the shape roughly right but the
 * radii arbitrarily wrong, so lap times come out meaningless. Authoring radii
 * directly gets both right.
 *
 * The hard part is closing the loop. An authored segment list will not meet
 * itself, and naively forcing it shut wrecks whichever quantity you force.
 * The solver here exploits an asymmetry in what the errors cost:
 *
 *   - A corner's RADIUS determines its speed. Changing it changes the physics.
 *   - A corner's ANGLE does not. A 70-degree and an 80-degree corner at the same
 *     radius are taken at the same speed. Angle is nearly free to adjust.
 *   - A STRAIGHT's length sets top speed. Moderately expensive to change.
 *
 * So closure is absorbed primarily by redistributing corner angles, secondarily
 * by straight lengths, and only as a last resort by radii. Because a change to
 * one angle rotates the whole remaining chain, that is a nonlinear problem,
 * solved by damped Gauss-Newton against four constraints:
 *
 *     endpoint x = start x            (loop closes)
 *     endpoint z = start z
 *     total arclength = official lap distance
 *     total turn = 360 * turning number
 *
 * Turning number is +1 clockwise, -1 anticlockwise, and 0 for a figure-eight
 * like Suzuka, whose two lobes turn opposite ways and cancel.
 *
 * The step is a weighted minimum-norm solution, with each variable's weight set
 * to the square of how much we are willing to see it move. That makes the units
 * commensurate and encodes the cost asymmetry directly: ~20 degrees of angle,
 * ~25% of a straight, ~5% of a radius.
 */

export interface StraightSegment {
  kind: 'straight';
  /** Length in metres. */
  len: number;
  /** Marks this straight as a DRS activation zone. */
  drs?: boolean;
  /** Overrides track width for this segment. */
  width?: number;
  name?: string;
  /**
   * Locks this straight's length. Use for straights whose length is a defining
   * feature of the circuit (Monza's Rettifilo, Spa's Kemmel).
   */
  fixed?: boolean;
}

export interface CornerSegment {
  kind: 'corner';
  /** Turn angle in degrees, always positive. */
  angle: number;
  /** Corner radius in metres — the number that sets the speed. */
  radius: number;
  /** 'R' turns right (clockwise from above), 'L' turns left. */
  dir: 'L' | 'R';
  name?: string;
  width?: number;
  /** Rare: a corner inside a DRS zone (e.g. Jeddah's flat-out kinks). */
  drs?: boolean;
}

export type Segment = StraightSegment | CornerSegment;

export interface BuiltLayout {
  /** Packed [x0,z0, x1,z1, ...] control points for TrackSpline. */
  controlPoints: number[];
  /** Arclength of the closed centreline, metres. */
  totalLength: number;
  /** Corner markers with their distance-along-lap. */
  corners: { s: number; name: string }[];
  /** DRS activation ranges in metres along the lap. */
  drsRanges: { startS: number; endS: number }[];
  /** Width overrides in metres along the lap. */
  widthRanges: { startS: number; endS: number; widthM: number }[];

  // --- Diagnostics, surfaced by scripts/validateTracks.ts ---
  /** Residual endpoint gap after solving. Should be ~0. */
  closureErrorM: number;
  /** Total authored turn before solving, degrees. */
  rawTurnDeg: number;
  /** Largest change made to any corner angle, degrees. Cheap; may be large. */
  worstAngleChangeDeg: number;
  /** Largest fractional change made to any straight. Moderately expensive. */
  worstStraightChange: number;
  /** Largest fractional change made to any corner radius. Want small. */
  worstRadiusChange: number;
  /** Gauss-Newton iterations used. */
  iterations: number;
}

const SAMPLE_SPACING_M = 10;
const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** How far we are willing to let each class of variable move. */
const EXPECT_ANGLE_RAD = 20 * DEG;
const EXPECT_STRAIGHT_FRAC = 0.25;
const EXPECT_RADIUS_FRAC = 0.05;

export function buildLayout(
  segments: readonly Segment[],
  turningNumber: -1 | 0 | 1 = 1,
  targetLengthM?: number,
): BuiltLayout {
  // -------------------------------------------------------------------------
  // Unpack the authored layout into flat parameter arrays.
  // -------------------------------------------------------------------------
  /** Signed corner angles in radians, in segment order. */
  const theta: number[] = [];
  const theta0: number[] = [];
  /** Corner radii in metres. */
  const radius: number[] = [];
  const radius0: number[] = [];
  /** Straight lengths in metres. */
  const slen: number[] = [];
  const slen0: number[] = [];
  const sFixed: boolean[] = [];

  for (const seg of segments) {
    if (seg.kind === 'corner') {
      const a = (seg.dir === 'R' ? seg.angle : -seg.angle) * DEG;
      theta.push(a);
      theta0.push(a);
      radius.push(seg.radius);
      radius0.push(seg.radius);
    } else {
      slen.push(seg.len);
      slen0.push(seg.len);
      sFixed.push(seg.fixed === true);
    }
  }

  const M = theta.length;
  const S = slen.length;

  let rawTurn = 0;
  for (const a of theta0) rawTurn += a;

  const authoredLen =
    slen0.reduce((acc, l) => acc + l, 0) +
    theta0.reduce((acc, a, j) => acc + Math.abs(a) * radius0[j], 0);

  const targetLen = targetLengthM ?? authoredLen;
  const targetTurn = turningNumber * 360 * DEG;

  // -------------------------------------------------------------------------
  // Walks the segment chain and returns the endpoint, arclength and total turn.
  // The residual of this against the four targets is what Gauss-Newton drives
  // to zero.
  // -------------------------------------------------------------------------
  const walkOut = { x: 0, z: 0, len: 0, turn: 0 };
  function walk(): void {
    let x = 0;
    let z = 0;
    let h = 0;
    let len = 0;
    let turn = 0;
    let ci = 0;
    let si = 0;

    for (const seg of segments) {
      if (seg.kind === 'straight') {
        const l = slen[si++];
        x += Math.sin(h) * l;
        z += Math.cos(h) * l;
        len += l;
      } else {
        const a = theta[ci];
        const r = radius[ci];
        ci++;
        const absA = Math.abs(a);
        const sgn = a >= 0 ? 1 : -1;
        // Displacement of a circular arc from its entry point: r*sin|a| along
        // the entry heading, r*(1-cos a) to the side the corner turns.
        // Forward axis is (sin h, cos h); the right-hand axis is (cos h, -sin h).
        const fwd = r * Math.sin(absA);
        const lat = r * (1 - Math.cos(a));
        x += Math.sin(h) * fwd + Math.cos(h) * lat * sgn;
        z += Math.cos(h) * fwd - Math.sin(h) * lat * sgn;
        h += a;
        len += absA * r;
        turn += a;
      }
    }

    walkOut.x = x;
    walkOut.z = z;
    walkOut.len = len;
    walkOut.turn = turn;
  }

  // -------------------------------------------------------------------------
  // Variable table. Index layout: [0, M) angles, [M, M+S) straights,
  // [M+S, 2M+S) radii.
  // -------------------------------------------------------------------------
  const N = M + S + M;
  const IDX_STRAIGHT = M;
  const IDX_RADIUS = M + S;

  /** Weight = (willing movement)^2, which makes mixed units commensurate. */
  const weight = new Float64Array(N);
  const lo = new Float64Array(N);
  const hi = new Float64Array(N);
  const free = new Uint8Array(N);

  for (let j = 0; j < M; j++) {
    weight[j] = EXPECT_ANGLE_RAD * EXPECT_ANGLE_RAD;
    // An angle may flex a long way but must not invert or collapse: a corner
    // has to stay a corner, turning the same way.
    const a0 = theta0[j];
    const mag = Math.abs(a0);
    const loMag = Math.max(4 * DEG, mag * 0.3);
    const hiMag = Math.max(mag * 2.4, mag + 40 * DEG);
    lo[j] = a0 >= 0 ? loMag : -hiMag;
    hi[j] = a0 >= 0 ? hiMag : -loMag;
    free[j] = 1;
  }
  for (let i = 0; i < S; i++) {
    const j = IDX_STRAIGHT + i;
    const e = Math.max(slen0[i] * EXPECT_STRAIGHT_FRAC, 1);
    weight[j] = e * e;
    lo[j] = sFixed[i] ? slen0[i] : Math.max(10, slen0[i] * 0.4);
    hi[j] = sFixed[i] ? slen0[i] : slen0[i] * 2.5;
    free[j] = sFixed[i] ? 0 : 1;
  }
  for (let k = 0; k < M; k++) {
    const j = IDX_RADIUS + k;
    const e = Math.max(radius0[k] * EXPECT_RADIUS_FRAC, 0.25);
    weight[j] = e * e;
    // Radii are the physics. Keep them within a quarter of what was authored so
    // a corner never changes gear class.
    lo[j] = Math.max(9, radius0[k] * 0.78);
    hi[j] = radius0[k] * 1.26;
    free[j] = 1;
  }

  /** Reads variable j out of the parameter arrays. */
  const getVar = (j: number): number =>
    j < IDX_STRAIGHT ? theta[j]
      : j < IDX_RADIUS ? slen[j - IDX_STRAIGHT]
        : radius[j - IDX_RADIUS];

  /** Writes variable j back into the parameter arrays. */
  const setVar = (j: number, v: number): void => {
    if (j < IDX_STRAIGHT) theta[j] = v;
    else if (j < IDX_RADIUS) slen[j - IDX_STRAIGHT] = v;
    else radius[j - IDX_RADIUS] = v;
  };

  // Jacobian rows: 4 constraints x N variables.
  const J = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];

  // -------------------------------------------------------------------------
  // Damped Gauss-Newton.
  // -------------------------------------------------------------------------
  const H = 1e-6;
  let iterations = 0;

  for (let iter = 0; iter < 120; iter++) {
    iterations = iter + 1;
    walk();
    const f0 = walkOut.x;
    const f1 = walkOut.z;
    const f2 = walkOut.len - targetLen;
    const f3 = walkOut.turn - targetTurn;

    if (Math.hypot(f0, f1) < 1e-5 && Math.abs(f2) < 1e-4 && Math.abs(f3) < 1e-9) break;

    // Numerical Jacobian. A chain walk is ~40 segments and there are ~50
    // variables, so a column costs almost nothing — and this all runs once, at
    // module load, not per frame.
    for (let j = 0; j < N; j++) {
      if (!free[j]) {
        J[0][j] = J[1][j] = J[2][j] = J[3][j] = 0;
        continue;
      }
      const orig = getVar(j);
      // Scale the probe to the variable's own magnitude for conditioning.
      const h = H * Math.max(1, Math.abs(orig));
      setVar(j, orig + h);
      walk();
      J[0][j] = (walkOut.x - f0) / h;
      J[1][j] = (walkOut.z - f1) / h;
      J[2][j] = (walkOut.len - (f2 + targetLen)) / h;
      J[3][j] = (walkOut.turn - (f3 + targetTurn)) / h;
      setVar(j, orig);
    }

    // Minimum weighted-norm step: dx = W J^T (J W J^T)^-1 (-f).
    const A: number[][] = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    for (let r = 0; r < 4; r++) {
      for (let c = r; c < 4; c++) {
        let sum = 0;
        for (let j = 0; j < N; j++) {
          if (!free[j]) continue;
          sum += weight[j] * J[r][j] * J[c][j];
        }
        A[r][c] = sum;
        A[c][r] = sum;
      }
      // Levenberg-style ridge: keeps the solve stable when the active set has
      // left the system rank-deficient (e.g. every straight pinned).
      A[r][r] += 1e-9 * (1 + Math.abs(A[r][r]));
    }

    const lambda = solve4(A, [-f0, -f1, -f2, -f3]);
    if (!lambda) break;

    const DAMP = 0.85;
    let anyClamped = false;
    for (let j = 0; j < N; j++) {
      if (!free[j]) continue;
      let d = 0;
      for (let r = 0; r < 4; r++) d += J[r][j] * lambda[r];
      d *= weight[j] * DAMP;

      const next = getVar(j) + d;
      if (next < lo[j]) {
        setVar(j, lo[j]);
        free[j] = 0;
        anyClamped = true;
      } else if (next > hi[j]) {
        setVar(j, hi[j]);
        free[j] = 0;
        anyClamped = true;
      } else {
        setVar(j, next);
      }
    }

    // If the active set has swallowed everything there is nothing left to do.
    if (anyClamped) {
      let anyFree = false;
      for (let j = 0; j < N; j++) if (free[j]) { anyFree = true; break; }
      if (!anyFree) break;
    }
  }

  walk();
  const closureErrorM = Math.hypot(walkOut.x, walkOut.z);

  let worstAngleChangeDeg = 0;
  let worstStraightChange = 0;
  let worstRadiusChange = 0;
  for (let j = 0; j < M; j++) {
    const d = Math.abs(theta[j] - theta0[j]) * RAD2DEG;
    if (d > worstAngleChangeDeg) worstAngleChangeDeg = d;
    const dr = Math.abs(radius[j] - radius0[j]) / radius0[j];
    if (dr > worstRadiusChange) worstRadiusChange = dr;
  }
  for (let i = 0; i < S; i++) {
    const d = Math.abs(slen[i] - slen0[i]) / Math.max(slen0[i], 1);
    if (d > worstStraightChange) worstStraightChange = d;
  }

  // -------------------------------------------------------------------------
  // Emit geometry with the solved parameters.
  // -------------------------------------------------------------------------
  const pts: number[] = [];
  const corners: { s: number; name: string }[] = [];
  const drsRanges: { startS: number; endS: number }[] = [];
  const widthRanges: { startS: number; endS: number; widthM: number }[] = [];

  let x = 0;
  let z = 0;
  let heading = 0;
  let s = 0;
  let ci = 0;
  let si = 0;
  pts.push(x, z);

  for (const seg of segments) {
    const segStartS = s;
    let segLen: number;

    if (seg.kind === 'straight') {
      const len = slen[si++];
      const dx = Math.sin(heading);
      const dz = Math.cos(heading);
      const steps = Math.max(1, Math.round(len / SAMPLE_SPACING_M));
      const step = len / steps;
      for (let i = 0; i < steps; i++) {
        x += dx * step;
        z += dz * step;
        pts.push(x, z);
      }
      segLen = len;
    } else {
      const a = theta[ci];
      const r = radius[ci];
      ci++;
      const arcLen = Math.abs(a) * r;
      const steps = Math.max(3, Math.round(arcLen / SAMPLE_SPACING_M));
      const dTheta = a / steps;
      // Advance by the sub-arc's chord from its midpoint heading, so the sampled
      // points sit on the circle of radius r rather than slightly inside it.
      const chord = 2 * r * Math.sin(Math.abs(dTheta) * 0.5);
      for (let i = 0; i < steps; i++) {
        heading += dTheta * 0.5;
        x += Math.sin(heading) * chord;
        z += Math.cos(heading) * chord;
        heading += dTheta * 0.5;
        pts.push(x, z);
      }
      segLen = arcLen;
      if (seg.name) corners.push({ s: segStartS + arcLen * 0.5, name: seg.name });
    }

    s += segLen;

    if (seg.drs) {
      const last = drsRanges[drsRanges.length - 1];
      if (last && Math.abs(last.endS - segStartS) < 1) last.endS = s;
      else drsRanges.push({ startS: segStartS, endS: s });
    }
    if (seg.width !== undefined) {
      widthRanges.push({ startS: segStartS, endS: s, widthM: seg.width });
    }
  }

  // The final point coincides with the first; drop it so the closed
  // Catmull-Rom never sees a zero-length segment.
  const n = pts.length / 2;
  pts.length = (n - 1) * 2;

  // Measure the polyline actually produced rather than trusting the parameters.
  let totalLength = 0;
  const m = pts.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    totalLength += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }

  return {
    controlPoints: pts,
    totalLength,
    corners,
    drsRanges,
    widthRanges,
    closureErrorM,
    rawTurnDeg: rawTurn * RAD2DEG,
    worstAngleChangeDeg,
    worstStraightChange,
    worstRadiusChange,
    iterations,
  };
}

/** Gaussian elimination with partial pivoting on a 4x4 system. */
function solve4(A: number[][], b: number[]): number[] | null {
  const m = [
    [A[0][0], A[0][1], A[0][2], A[0][3], b[0]],
    [A[1][0], A[1][1], A[1][2], A[1][3], b[1]],
    [A[2][0], A[2][1], A[2][2], A[2][3], b[2]],
    [A[3][0], A[3][1], A[3][2], A[3][3], b[3]],
  ];

  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-14) return null;
    if (piv !== col) {
      const t = m[piv];
      m[piv] = m[col];
      m[col] = t;
    }
    const d = m[col][col];
    for (let c = col; c < 5; c++) m[col][c] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c < 5; c++) m[r][c] -= f * m[col][c];
    }
  }

  const out = [m[0][4], m[1][4], m[2][4], m[3][4]];
  for (const v of out) if (!Number.isFinite(v)) return null;
  return out;
}

/** Convenience constructors so track files read like a circuit description. */
export function str(len: number, opts: Omit<StraightSegment, 'kind' | 'len'> = {}): StraightSegment {
  return { kind: 'straight', len, ...opts };
}

export function right(angle: number, radius: number, name?: string, opts: Partial<CornerSegment> = {}): CornerSegment {
  return { kind: 'corner', angle, radius, dir: 'R', name, ...opts };
}

export function left(angle: number, radius: number, name?: string, opts: Partial<CornerSegment> = {}): CornerSegment {
  return { kind: 'corner', angle, radius, dir: 'L', name, ...opts };
}
