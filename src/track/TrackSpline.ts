import { Vec2, clamp, clamp01, lerp, wrapDistance, loopDelta } from '../core/MathUtils';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';

/**
 * Closed-loop track geometry, sampled from a Catmull-Rom spline through the
 * circuit's control points.
 *
 * Data layout is struct-of-arrays (parallel Float32Arrays) rather than an array
 * of node objects. A 5.8km circuit at 3m resolution is ~1900 nodes, queried by
 * 20 cars 120 times a second; SoA keeps the hot fields (position, tangent,
 * curvature, target speed) in contiguous cache lines and means zero pointer
 * chasing per query.
 *
 * Two derived products are solved here rather than authored by hand:
 *
 *  1. The racing line, by iterative curvature minimisation inside the track
 *     boundaries. This is the standard approach and it finds real apexes,
 *     including the late apex on a corner that leads onto a straight.
 *
 *  2. The speed profile, by solving the lateral force balance at each node and
 *     then running backward (braking) and forward (traction) passes. This is
 *     what a lap-time simulator does, and it means braking points and corner
 *     speeds are *consequences* of the car's grip and downforce rather than
 *     magic numbers. Change the aero package and the whole profile moves.
 */

const NODE_SPACING_M = 3;

/** Reference car used to solve the speed profile. Real cars deviate from it. */
export interface SpeedSolverParams {
  /** Peak tire friction coefficient on a dry track. */
  mu: number;
  /** Downforce coefficient: F_down = cl * v^2  (Newtons, v in m/s). */
  cl: number;
  /** Drag coefficient: F_drag = cd * v^2. */
  cd: number;
  massKg: number;
  /** Peak power in Watts, used for the traction-limited forward pass. */
  powerW: number;
  /** Total brake force at full pedal, N — the same cap the car itself has. */
  maxBrakeForceN: number;
  maxSpeedMs: number;
}

/**
 * Aero and grip constants for the reference car, calibrated by
 * `npm run calibrate` against real pole times across the whole calendar.
 */
export const REFERENCE_CAR = {
  mu: 1.86,
  maxBrakeForceN: 36_000,
  massKg: 850,
  powerW: 600_000,
  /** Downforce coefficient at the low-downforce (Monza) and high (Monaco) ends. */
  clLow: 2.1,
  clHigh: 4.5,
  /** Drag coefficient at the same two ends. */
  cdLow: 0.66,
  cdHigh: 1.18,
  /** Hard ceiling, never reached in practice — drag binds first. */
  maxSpeedMs: 103,
};

/**
 * Builds solver parameters for a circuit from its downforce demand.
 *
 * Teams do not run one aero package all season: Monza runs a skinny rear wing
 * for straight-line speed and gives up cornering grip, Monaco runs maximum
 * downforce and does not care about drag. Modelling one fixed aero package for
 * every circuit is what made the fast tracks come out too quick and the twisty
 * ones too slow — the error was systematic and in opposite directions, which is
 * exactly the signature of a missing variable rather than bad geometry.
 */
export function solverParamsFor(demand: number): SpeedSolverParams {
  const d = clamp01(demand);
  return {
    mu: REFERENCE_CAR.mu,
    maxBrakeForceN: REFERENCE_CAR.maxBrakeForceN,
    massKg: REFERENCE_CAR.massKg,
    powerW: REFERENCE_CAR.powerW,
    cl: lerp(REFERENCE_CAR.clLow, REFERENCE_CAR.clHigh, d),
    cd: lerp(REFERENCE_CAR.cdLow, REFERENCE_CAR.cdHigh, d),
    maxSpeedMs: REFERENCE_CAR.maxSpeedMs,
  };
}

const G = 9.81;

export class TrackSpline {
  readonly def: TrackDefinition;

  /** Number of sampled nodes. */
  readonly count: number;
  /** Total lap distance in metres, matched to the circuit's official length. */
  readonly length: number;

  // --- Centreline geometry -------------------------------------------------
  readonly px: Float32Array;
  readonly pz: Float32Array;
  /** Unit tangent (direction of travel). */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /**
   * Unit normal pointing to the driver's LEFT.
   *
   * For a tangent of (0,1) this is (1,0) = +X. In a right-handed system with +Y
   * up, a traveller facing +Z has their right toward -X, so +X is their LEFT.
   * Every lateral offset in this codebase is therefore positive-LEFT.
   *
   * An earlier revision of this comment claimed the opposite. That mistake is
   * what produced inverted player steering, so it is worth being precise.
   */
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  /**
   * Signed centreline curvature, 1/m.
   *
   * Positive means the path curves toward -X, i.e. a RIGHT turn, because this is
   * computed from a cross product whose sign is opposite to the heading rate.
   */
  readonly curvature: Float32Array;
  /** Distance along the lap at this node. */
  readonly dist: Float32Array;
  /** Full track width at this node, metres. */
  readonly width: Float32Array;
  /** Elevation, metres. Cosmetic + a small longitudinal gravity term. */
  readonly elevation: Float32Array;
  /** Banking angle in radians (positive banks the left side up). */
  readonly banking: Float32Array;

  // --- Derived racing line -------------------------------------------------
  /** Lateral offset of the racing line from centreline, +left, metres. */
  readonly lineOffset: Float32Array;
  /** Curvature of the racing line itself. Drives the speed profile. */
  readonly lineCurvature: Float32Array;
  /** Solved reference speed at this node, m/s. */
  readonly targetSpeed: Float32Array;

  // --- Flags ---------------------------------------------------------------
  readonly isCurbLeft: Uint8Array;
  readonly isCurbRight: Uint8Array;
  readonly isDrsZone: Uint8Array;
  readonly sector: Uint8Array;
  /** 1 where overtaking is realistic (straights + heavy braking zones). */
  readonly isPassingZone: Uint8Array;

  /** Theoretical lap time from the solved speed profile, seconds. */
  readonly referenceLapTime: number;

  private readonly scratchA = new Vec2();
  private readonly scratchB = new Vec2();

  constructor(def: TrackDefinition, solver?: SpeedSolverParams) {
    this.def = def;
    const params = solver ?? solverParamsFor(def.downforceDemand);

    // 1. Scale the authored control points so the sampled spline length matches
    //    the circuit's official distance. Authoring in approximate metres and
    //    then normalising means corner radii — and therefore corner speeds and
    //    lap times — land in the right ballpark without hand-tuning each track.
    const raw = def.controlPoints;
    const nCtrl = raw.length / 2;
    const provisional = measureClosedCatmullRom(raw, nCtrl);
    const scale = def.lengthM / provisional;

    const ctrl = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) ctrl[i] = raw[i] * scale;

    // 2. Resample at uniform arclength.
    const count = Math.max(64, Math.round(def.lengthM / NODE_SPACING_M));
    this.count = count;
    this.length = def.lengthM;

    this.px = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.tx = new Float32Array(count);
    this.tz = new Float32Array(count);
    this.nx = new Float32Array(count);
    this.nz = new Float32Array(count);
    this.curvature = new Float32Array(count);
    this.dist = new Float32Array(count);
    this.width = new Float32Array(count);
    this.elevation = new Float32Array(count);
    this.banking = new Float32Array(count);
    this.lineOffset = new Float32Array(count);
    this.lineCurvature = new Float32Array(count);
    this.targetSpeed = new Float32Array(count);
    this.isCurbLeft = new Uint8Array(count);
    this.isCurbRight = new Uint8Array(count);
    this.isDrsZone = new Uint8Array(count);
    this.sector = new Uint8Array(count);
    this.isPassingZone = new Uint8Array(count);

    resampleClosedCatmullRom(ctrl, nCtrl, count, this.px, this.pz);

    for (let i = 0; i < count; i++) this.dist[i] = (i * def.lengthM) / count;

    this.computeFrames();
    this.applyMetadata();
    this.solveRacingLine();
    this.referenceLapTime = this.solveSpeedProfile(params);
  }

  // =========================================================================
  // Geometry
  // =========================================================================

  private computeFrames(): void {
    const { count, px, pz, tx, tz, nx, nz, curvature } = this;

    for (let i = 0; i < count; i++) {
      const prev = i === 0 ? count - 1 : i - 1;
      const next = i === count - 1 ? 0 : i + 1;

      let dx = px[next] - px[prev];
      let dz = pz[next] - pz[prev];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;

      tx[i] = dx;
      tz[i] = dz;
      // Left-hand normal: (tz, -tx), which is +X for a +Z tangent.
      nx[i] = dz;
      nz[i] = -dx;
    }

    // Signed curvature from the circumradius of three consecutive samples.
    for (let i = 0; i < count; i++) {
      const prev = i === 0 ? count - 1 : i - 1;
      const next = i === count - 1 ? 0 : i + 1;
      curvature[i] = signedCurvature(
        px[prev], pz[prev],
        px[i], pz[i],
        px[next], pz[next],
      );
    }

    smoothWrapped(curvature, 3, 2);
  }

  private applyMetadata(): void {
    const { count, def } = this;
    const defaultWidth = def.defaultWidthM;

    for (let i = 0; i < count; i++) {
      this.width[i] = defaultWidth;
      this.sector[i] = 1;
    }

    // Per-segment width overrides (Monaco's tunnel, pit straights, etc).
    if (def.widthOverrides) {
      for (const seg of def.widthOverrides) {
        this.forEachNodeInRange(seg.startS, seg.endS, (i) => {
          this.width[i] = seg.widthM;
        });
      }
    }

    // Sectors.
    const s1 = def.sector1EndS;
    const s2 = def.sector2EndS;
    for (let i = 0; i < count; i++) {
      const s = this.dist[i];
      this.sector[i] = s < s1 ? 1 : s < s2 ? 2 : 3;
    }

    // Curbing: authored, plus automatic curbs on the inside of every corner
    // tighter than 400m radius. Real circuits kerb every apex, so deriving it
    // from curvature is both accurate and saves authoring 1900 flags per track.
    for (let i = 0; i < count; i++) {
      const k = this.curvature[i];
      if (Math.abs(k) > 1 / 400) {
        // Kerbing goes on the inside of the corner. Positive curvature is a RIGHT
        // turn, whose inside is the track's right-hand side — and the right-hand
        // side is NEGATIVE lateral under the positive-left convention.
        if (k > 0) this.isCurbRight[i] = 1;
        else this.isCurbLeft[i] = 1;
      }
    }
    if (def.curbOverrides) {
      for (const seg of def.curbOverrides) {
        this.forEachNodeInRange(seg.startS, seg.endS, (i) => {
          if (seg.side === 'left' || seg.side === 'both') this.isCurbLeft[i] = 1;
          if (seg.side === 'right' || seg.side === 'both') this.isCurbRight[i] = 1;
        });
      }
    }

    for (const zone of def.drsZones) {
      this.forEachNodeInRange(zone.startS, zone.endS, (i) => {
        this.isDrsZone[i] = 1;
      });
    }

    // Elevation: authored key points, cosine-interpolated around the lap.
    if (def.elevationPoints && def.elevationPoints.length > 1) {
      this.buildElevation(def.elevationPoints);
    }

    if (def.bankingSegments) {
      for (const seg of def.bankingSegments) {
        this.forEachNodeInRange(seg.startS, seg.endS, (i) => {
          this.banking[i] = seg.degrees * (Math.PI / 180);
        });
      }
      smoothWrapped(this.banking, 8, 2);
    }

    // Passing zones: anywhere the reference speed will be high, plus explicit
    // authored zones. Filled properly after the speed solve; seed from
    // curvature here so the solver's braking passes have something to read.
    for (let i = 0; i < count; i++) {
      this.isPassingZone[i] = Math.abs(this.curvature[i]) < 1 / 600 ? 1 : 0;
    }
  }

  private buildElevation(points: readonly { s: number; y: number }[]): void {
    const pts = points.slice().sort((a, b) => a.s - b.s);
    const n = pts.length;
    for (let i = 0; i < this.count; i++) {
      const s = this.dist[i];
      let a = n - 1;
      let b = 0;
      for (let k = 0; k < n; k++) {
        if (pts[k].s <= s) a = k;
      }
      b = (a + 1) % n;
      const sa = pts[a].s;
      let sb = pts[b].s;
      if (sb <= sa) sb += this.length;
      const t = (s - sa) / (sb - sa);
      // Cosine ease gives smooth crests and compressions rather than kinks.
      const et = 0.5 - 0.5 * Math.cos(clamp(t, 0, 1) * Math.PI);
      this.elevation[i] = lerp(pts[a].y, pts[b].y, et);
    }
    smoothWrapped(this.elevation, 6, 1);
  }

  private forEachNodeInRange(startS: number, endS: number, fn: (i: number) => void): void {
    const a = wrapDistance(startS, this.length);
    const b = wrapDistance(endS, this.length);
    const ia = Math.floor((a / this.length) * this.count);
    const ib = Math.floor((b / this.length) * this.count);
    if (ia <= ib) {
      for (let i = ia; i <= ib && i < this.count; i++) fn(i);
    } else {
      for (let i = ia; i < this.count; i++) fn(i);
      for (let i = 0; i <= ib && i < this.count; i++) fn(i);
    }
  }

  // =========================================================================
  // Racing line: iterative curvature minimisation
  // =========================================================================

  /**
   * Solves the racing line: the path through the corridor that can be driven
   * fastest, found by minimising curvature.
   *
   * The naive approach — Laplacian smoothing, repeatedly moving each node to the
   * midpoint of its neighbours — is wrong, and wrong in a way that is easy to
   * miss. On a fixed node count, |p[i-1] - 2p[i] + p[i+1]| shrinks when the path
   * gets SHORTER as well as when it gets straighter, so the objective is
   * dominated by path length. The result is the shortest path, which hugs the
   * inside of every long corner and therefore has a *tighter* radius than the
   * centreline. At Monza it put the line on the inside of Parabolica at R=180
   * where the centreline is R=185, costing corner speed and leaving the car
   * nothing to work with.
   *
   * Instead this minimises the sum of squared TRUE geometric curvature, by
   * coordinate descent: for each node, try shifting its offset in and out and
   * keep whichever reduces the curvature of the local three-node window. The
   * trial step shrinks over the passes, so it converges. This finds the classic
   * out-in-out line — wide entry, late apex, wide exit — because that genuinely
   * is the lowest-curvature path through a corner corridor.
   *
   * Runs once per circuit at load, not per frame.
   */
  /**
   * Builds the racing line geometrically: outside on the approach, inside at the
   * apex, drifting out on exit — the line every driver is taught.
   *
   * Two numerical approaches were tried first and both failed, in instructive ways:
   *
   *  - Laplacian smoothing (repeatedly moving each node to the midpoint of its
   *    neighbours) minimises |p[i-1] - 2p[i] + p[i+1]|, which shrinks when the
   *    path gets SHORTER as well as straighter. On a fixed node count the length
   *    term dominates, so it converges on the shortest path, hugging the inside of
   *    every long corner at a TIGHTER radius than the centreline. At Monza it put
   *    Parabolica on the inside at R=180 where the centreline is R=185.
   *
   *  - Coordinate descent on true geometric curvature, with the line
   *    parameterised by coarse control points, does minimise the right objective,
   *    but converges to lines that are locally optimal and globally strange, and
   *    the AI could not follow them.
   *
   * A constructed line is worse than a perfectly optimised one in theory and much
   * better in practice: it is smooth by construction, always inside the corridor,
   * and predictable, which is what a controller needs. The apex positions come
   * from the circuit's own curvature, so it adapts to any layout.
   */
  private solveRacingLine(): void {
    const { count, width, lineOffset, curvature } = this;

    // Half the car plus a margin. Deliberately more than the regulation minimum:
    // an ideal line sitting exactly on the white line leaves a driver no room for
    // their own tracking error, and the AI put a wheel over the edge at every apex.
    const CAR_HALF_WIDTH = 1.0;
    const MARGIN = 0.95;

    const limit = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      limit[i] = Math.max(0, width[i] * 0.5 - CAR_HALF_WIDTH - MARGIN);
    }

    const ds = this.length / count;
    /** How far ahead a corner starts pulling the line to the outside. */
    const APPROACH_M = 95;
    const approachNodes = Math.max(4, Math.round(APPROACH_M / ds));

    // Positive curvature is a RIGHT turn, whose inside is the track's right-hand
    // side, which is negative under the positive-left convention.
    const insideSign = (k: number) => (k > 0 ? -1 : 1);

    const raw = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const k = curvature[i];
      const severity = clamp01(Math.abs(k) * 260);

      if (severity > 0.12) {
        // In a corner: hug the inside, in proportion to how tight it is.
        raw[i] = insideSign(k) * limit[i] * (0.3 + 0.5 * severity);
        continue;
      }

      // Not in a corner. Look ahead for the next one and set up on its outside;
      // this is what turns a corner-by-corner rule into a real racing line.
      let bestK = 0;
      let bestDist = Infinity;
      for (let d = 1; d <= approachNodes; d++) {
        const j = (i + d) % count;
        const kk = curvature[j];
        if (Math.abs(kk) * 260 > 0.3 && Math.abs(kk) > Math.abs(bestK) * 0.85) {
          if (d < bestDist) { bestDist = d; bestK = kk; }
        }
      }

      if (bestK !== 0) {
        // Closer to the corner means further to the outside.
        const closeness = 1 - bestDist / approachNodes;
        // Deliberately short of the corridor edge: the car will overshoot this
        // target slightly, and that overshoot must still be on the road.
        raw[i] = -insideSign(bestK) * limit[i] * 0.5 * clamp01(closeness * 1.3);
      } else {
        raw[i] = 0;
      }
    }

    lineOffset.set(raw);

    // Heavy smoothing. This is what makes the line drivable: the offset's second
    // derivative IS extra curvature, so an offset that changes abruptly asks the
    // car for a steering input it cannot produce. Smoothing over ~60m of track
    // turns the piecewise rule above into a continuous line, and creates the
    // gradual drift out of a corner exit for free.
    const smoothRadius = Math.max(3, Math.round(30 / ds));
    smoothWrapped(lineOffset, smoothRadius, 3);

    for (let i = 0; i < count; i++) {
      lineOffset[i] = clamp(lineOffset[i], -limit[i], limit[i]);
    }
    // One more light pass so the clamp cannot leave a corner.
    smoothWrapped(lineOffset, 2, 1);
    for (let i = 0; i < count; i++) {
      lineOffset[i] = clamp(lineOffset[i], -limit[i], limit[i]);
    }

    this.computeLineCurvature();
  }

  private computeLineCurvature(): void {
    const { count, px, pz, nx, nz, lineOffset, lineCurvature } = this;
    for (let i = 0; i < count; i++) {
      const a = i === 0 ? count - 1 : i - 1;
      const b = i === count - 1 ? 0 : i + 1;
      lineCurvature[i] = signedCurvature(
        px[a] + nx[a] * lineOffset[a], pz[a] + nz[a] * lineOffset[a],
        px[i] + nx[i] * lineOffset[i], pz[i] + nz[i] * lineOffset[i],
        px[b] + nx[b] * lineOffset[b], pz[b] + nz[b] * lineOffset[b],
      );
    }
    // Light smoothing only. Blurring hard removes the peak curvature of short
    // tight corners, which makes the solver allocate a corner speed no car can
    // actually achieve — a 42m chicane came out looking like a 70m sweep.
    smoothWrapped(lineCurvature, 2, 1);
  }

  // =========================================================================
  // Speed profile
  // =========================================================================

  /**
   * Solves the reference speed at every node and returns the resulting lap time.
   *
   * Corner speed comes from the lateral balance, including the fact that
   * downforce is itself a function of speed:
   *
   *     m*v^2/R = mu * (m*g + cl*v^2)
   *  => v^2 * (m/R - mu*cl) = mu*m*g
   *  => v^2 = mu*m*g / (m/R - mu*cl)
   *
   * When the denominator goes non-positive the corner is aero-limited — grip
   * grows faster than the demand does, so it's flat out. That single term is
   * why an F1 car takes 130R flat and a road car cannot.
   */
  /**
   * Re-solves the speed profile with different car parameters and returns the
   * new reference lap time. Geometry and racing line are untouched, so the
   * calibration sweep can try thousands of parameter sets without rebuilding
   * the expensive parts.
   */
  resolveSpeedProfile(params: SpeedSolverParams): number {
    return this.solveSpeedProfile(params);
  }

  private solveSpeedProfile(p: SpeedSolverParams): number {
    const { count, lineCurvature, targetSpeed, banking, length } = this;
    const ds = length / count;
    const m = p.massKg;

    // Use the WORST curvature in a short window rather than the value at the
    // node. A corner's limiting speed is set by its tightest point, and a car
    // that enters at the speed the average curvature allows arrives at the apex
    // already beyond the grip available. Being conservative here is what keeps
    // the profile physically achievable.
    const WINDOW = 1;
    const kWorst = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let peak = 0;
      for (let k = -WINDOW; k <= WINDOW; k++) {
        let j = (i + k) % count;
        if (j < 0) j += count;
        const a = Math.abs(lineCurvature[j]);
        if (a > peak) peak = a;
      }
      kWorst[i] = peak;
    }

    for (let i = 0; i < count; i++) {
      const r = 1 / Math.max(kWorst[i], 1e-6);

      // Banking adds a cos/sin term to the available lateral force.
      const bank = Math.abs(banking[i]);
      const effMu = p.mu * (Math.cos(bank) + Math.sin(bank) * 1.2);

      const denom = m / r - effMu * p.cl;
      let v: number;
      if (denom <= 1e-6) {
        v = p.maxSpeedMs;
      } else {
        v = Math.sqrt((effMu * m * G) / denom);
      }
      targetSpeed[i] = Math.min(v, p.maxSpeedMs);
    }

    // Braking and traction passes. Two rounds because the circuit is a closed
    // loop: the first backward pass can't know the speed it must arrive at
    // until the forward pass has run, and vice versa.
    for (let round = 0; round < 3; round++) {
      // Backward: never arrive at a corner faster than you can brake to.
      for (let k = count * 2; k >= 0; k--) {
        const i = k % count;
        const nxt = (i + 1) % count;
        const v = targetSpeed[i];
        const vn = targetSpeed[nxt];
        // Deceleration available at this speed. Deliberately the same model the
        // car itself uses: brake force capped by both the pedal's maximum and by
        // tire grip (which downforce raises), plus aerodynamic drag. If this
        // disagreed with VehiclePhysics the AI would brake at points its car
        // cannot actually make, and run wide at every corner.
        const gripLimit = p.mu * (m * G + p.cl * v * v);
        const aBrake = (Math.min(p.maxBrakeForceN, gripLimit) + p.cd * v * v) / m;
        const vMax = Math.sqrt(vn * vn + 2 * aBrake * ds);
        if (v > vMax) targetSpeed[i] = vMax;
      }

      // Forward: never leave a corner faster than power and traction allow.
      for (let k = 0; k <= count * 2; k++) {
        const i = k % count;
        const prv = (i + count - 1) % count;
        const v = targetSpeed[i];
        const vp = Math.max(targetSpeed[prv], 1);

        // Whichever binds first: engine power or rear-tire traction.
        const fPower = p.powerW / vp;
        const fTraction = p.mu * (m * G + p.cl * vp * vp) * 0.62; // rear axle share
        const fDrag = p.cd * vp * vp;
        // No floor on this. Once drag exceeds what the engine can deliver the
        // net force goes negative and the car stops accelerating — that is what
        // terminal velocity IS. Flooring it at a small positive number let the
        // reference car keep gaining speed forever down a long straight.
        const aAccel = (Math.min(fPower, fTraction) - fDrag) / m;

        const vpSq = vp * vp + 2 * aAccel * ds;
        const vMax = vpSq > 0 ? Math.sqrt(vpSq) : 0;
        if (v > vMax) targetSpeed[i] = vMax;
      }
    }

    smoothWrapped(targetSpeed, 2, 1);

    // Now that we know where the car is fast, mark realistic passing zones:
    // high speed, or a big speed drop just ahead (a heavy braking zone).
    for (let i = 0; i < count; i++) {
      const ahead = targetSpeed[(i + Math.floor(30 / ds)) % count];
      const fast = targetSpeed[i] > 58;
      const bigStop = targetSpeed[i] - ahead > 18;
      this.isPassingZone[i] = fast || bigStop ? 1 : 0;
    }
    for (const zone of this.def.drsZones) {
      this.forEachNodeInRange(zone.startS, zone.endS + 120, (i) => {
        this.isPassingZone[i] = 1;
      });
    }

    // Integrate ds/v for the theoretical lap time.
    let t = 0;
    for (let i = 0; i < count; i++) t += ds / Math.max(targetSpeed[i], 1);
    return t;
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /** Node index for a distance-along-lap value. */
  indexAt(s: number): number {
    const w = wrapDistance(s, this.length);
    const i = Math.floor((w / this.length) * this.count);
    return i >= this.count ? this.count - 1 : i;
  }

  /**
   * Nearest node to a world position, searching outward from `hint`.
   *
   * Cars move forward a bounded amount per tick, so a local search from the
   * previous index is O(1) where a global search would be O(n). Falls back to a
   * coarse global sweep when the local window misses (a spin, a reset, or a car
   * placed on the grid for the first time).
   */
  nearestIndex(x: number, z: number, hint: number): number {
    const { count, px, pz } = this;
    const WINDOW = 40;

    let best = -1;
    let bestD = Infinity;
    for (let k = -WINDOW; k <= WINDOW; k++) {
      let i = (hint + k) % count;
      if (i < 0) i += count;
      const dx = px[i] - x;
      const dz = pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }

    // If the closest point in the window is at its edge, the hint was stale.
    const edgeMiss = Math.abs(loopDelta(hint, best, count)) >= WINDOW - 1;
    if (!edgeMiss && bestD < 400 * 400) return best;

    const STRIDE = 8;
    best = 0;
    bestD = Infinity;
    for (let i = 0; i < count; i += STRIDE) {
      const dx = px[i] - x;
      const dz = pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    for (let k = -STRIDE; k <= STRIDE; k++) {
      let i = (best + k) % count;
      if (i < 0) i += count;
      const dx = px[i] - x;
      const dz = pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Projects a world position into track space.
   * Writes `s` (distance along lap) and `lateral` (+left, metres) into `out`.
   */
  project(x: number, z: number, hint: number, out: TrackProjection): number {
    const i = this.nearestIndex(x, z, hint);
    const dx = x - this.px[i];
    const dz = z - this.pz[i];

    const along = dx * this.tx[i] + dz * this.tz[i];
    const lateral = dx * this.nx[i] + dz * this.nz[i];

    out.index = i;
    out.s = wrapDistance(this.dist[i] + along, this.length);
    out.lateral = lateral;
    out.width = this.width[i];
    out.heading = Math.atan2(this.tx[i], this.tz[i]);
    return i;
  }

  /** World position of a point at (s, lateral). */
  toWorld(s: number, lateral: number, out: Vec2): Vec2 {
    const w = wrapDistance(s, this.length);
    const f = (w / this.length) * this.count;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    const t = f - Math.floor(f);

    const cx = lerp(this.px[i], this.px[j], t);
    const cz = lerp(this.pz[i], this.pz[j], t);
    const lnx = lerp(this.nx[i], this.nx[j], t);
    const lnz = lerp(this.nz[i], this.nz[j], t);

    return out.set(cx + lnx * lateral, cz + lnz * lateral);
  }

  /** World position of the racing line at distance `s`. */
  racingLineAt(s: number, out: Vec2): Vec2 {
    const i = this.indexAt(s);
    return this.toWorld(s, this.lineOffset[i], out);
  }

  /** Interpolated elevation at `s`, for the render layer and grade forces. */
  elevationAt(s: number): number {
    const f = (wrapDistance(s, this.length) / this.length) * this.count;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    return lerp(this.elevation[i], this.elevation[j], f - Math.floor(f));
  }

  /** Longitudinal grade (rise over run) at `s`. Positive = uphill. */
  gradeAt(s: number): number {
    const ahead = this.elevationAt(s + 12);
    const behind = this.elevationAt(s - 12);
    return (ahead - behind) / 24;
  }

  /** Reference speed some distance ahead — the AI's look-ahead primitive. */
  targetSpeedAhead(s: number, aheadM: number): number {
    return this.targetSpeed[this.indexAt(s + aheadM)];
  }

  /** Heading of the centreline at `s`, radians. */
  headingAt(s: number): number {
    const i = this.indexAt(s);
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  /** True if a DRS zone covers `s`. */
  inDrsZone(s: number): boolean {
    return this.isDrsZone[this.indexAt(s)] === 1;
  }

  /** True where a pass is realistic — used to gate AI overtake/defend states. */
  inPassingZone(s: number): boolean {
    return this.isPassingZone[this.indexAt(s)] === 1;
  }

  /** Half-width of the racing surface at `s`. */
  halfWidthAt(s: number): number {
    return this.width[this.indexAt(s)] * 0.5;
  }

  /**
   * Bounding box of the whole circuit, for fitting the minimap and the
   * camera's far plane. Called rarely, so allocating here is fine.
   */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const hw = this.width[i] * 0.5 + 6;
      const x = this.px[i];
      const z = this.pz[i];
      if (x - hw < minX) minX = x - hw;
      if (x + hw > maxX) maxX = x + hw;
      if (z - hw < minZ) minZ = z - hw;
      if (z + hw > maxZ) maxZ = z + hw;
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Name of the nearest named corner at or just behind `s`, for radio/UI. */
  cornerNameAt(s: number): string {
    const corners = this.def.corners;
    if (!corners || corners.length === 0) return '';
    let best = corners[corners.length - 1];
    let bestD = Infinity;
    for (const c of corners) {
      const d = Math.abs(loopDelta(c.s, s, this.length));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return bestD < 140 ? best.name : '';
  }

  /** Scratch vectors, exposed so callers can borrow instead of allocating. */
  get tmpA(): Vec2 { return this.scratchA; }
  get tmpB(): Vec2 { return this.scratchB; }
}

export interface TrackProjection {
  index: number;
  s: number;
  lateral: number;
  width: number;
  heading: number;
}

export function createProjection(): TrackProjection {
  return { index: 0, s: 0, lateral: 0, width: 0, heading: 0 };
}

// ===========================================================================
// Spline helpers
// ===========================================================================

/** Signed curvature through three points (positive = left turn in XZ). */
function signedCurvature(
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
): number {
  const v1x = bx - ax, v1z = bz - az;
  const v2x = cx - bx, v2z = cz - bz;
  const l1 = Math.hypot(v1x, v1z);
  const l2 = Math.hypot(v2x, v2z);
  const l3 = Math.hypot(cx - ax, cz - az);
  if (l1 < 1e-6 || l2 < 1e-6 || l3 < 1e-6) return 0;
  // Cross product gives 2 * signed triangle area; k = 4A / (abc).
  const cross = v1x * v2z - v1z * v2x;
  return (2 * cross) / (l1 * l2 * l3);
}

function catmullRom(
  p0: number, p1: number, p2: number, p3: number, t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Total arclength of a closed Catmull-Rom through packed [x,z,...] points. */
function measureClosedCatmullRom(pts: readonly number[] | Float32Array, n: number): number {
  const SUB = 24;
  let total = 0;
  let lx = 0, lz = 0, first = true;
  for (let i = 0; i < n; i++) {
    const i0 = ((i - 1) + n) % n;
    const i1 = i;
    const i2 = (i + 1) % n;
    const i3 = (i + 2) % n;
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      const x = catmullRom(pts[i0 * 2], pts[i1 * 2], pts[i2 * 2], pts[i3 * 2], t);
      const z = catmullRom(pts[i0 * 2 + 1], pts[i1 * 2 + 1], pts[i2 * 2 + 1], pts[i3 * 2 + 1], t);
      if (!first) total += Math.hypot(x - lx, z - lz);
      lx = x; lz = z; first = false;
    }
  }
  // Close the loop.
  const x0 = catmullRom(pts[(n - 1) * 2], pts[0], pts[2 % (n * 2)], pts[(4) % (n * 2)], 0);
  const z0 = catmullRom(pts[(n - 1) * 2 + 1], pts[1], pts[3 % (n * 2)], pts[5 % (n * 2)], 0);
  total += Math.hypot(x0 - lx, z0 - lz);
  return total;
}

/**
 * Resamples a closed Catmull-Rom spline at `outCount` points of uniform
 * arclength. Builds a dense polyline first, then walks it at constant spacing —
 * simpler and more robust than inverting the arclength function analytically.
 */
function resampleClosedCatmullRom(
  pts: Float32Array,
  n: number,
  outCount: number,
  outX: Float32Array,
  outZ: Float32Array,
): void {
  const SUB = 40;
  const denseCount = n * SUB;
  const dx = new Float64Array(denseCount + 1);
  const dz = new Float64Array(denseCount + 1);
  const cum = new Float64Array(denseCount + 1);

  let w = 0;
  for (let i = 0; i < n; i++) {
    const i0 = ((i - 1) + n) % n;
    const i1 = i;
    const i2 = (i + 1) % n;
    const i3 = (i + 2) % n;
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      dx[w] = catmullRom(pts[i0 * 2], pts[i1 * 2], pts[i2 * 2], pts[i3 * 2], t);
      dz[w] = catmullRom(pts[i0 * 2 + 1], pts[i1 * 2 + 1], pts[i2 * 2 + 1], pts[i3 * 2 + 1], t);
      w++;
    }
  }
  // Duplicate the first sample to close the loop.
  dx[denseCount] = dx[0];
  dz[denseCount] = dz[0];

  cum[0] = 0;
  for (let i = 1; i <= denseCount; i++) {
    cum[i] = cum[i - 1] + Math.hypot(dx[i] - dx[i - 1], dz[i] - dz[i - 1]);
  }
  const total = cum[denseCount];

  let cursor = 0;
  for (let i = 0; i < outCount; i++) {
    const target = (i / outCount) * total;
    while (cursor < denseCount - 1 && cum[cursor + 1] < target) cursor++;
    const segLen = cum[cursor + 1] - cum[cursor];
    const t = segLen > 1e-9 ? (target - cum[cursor]) / segLen : 0;
    outX[i] = dx[cursor] + (dx[cursor + 1] - dx[cursor]) * t;
    outZ[i] = dz[cursor] + (dz[cursor + 1] - dz[cursor]) * t;
  }
}

/** In-place box blur over a wrapped array. `radius` nodes, `passes` times. */
function smoothWrapped(arr: Float32Array, radius: number, passes: number): void {
  const n = arr.length;
  if (n === 0 || radius < 1) return;
  const tmp = new Float32Array(n);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = (i + k) % n;
        if (j < 0) j += n;
        sum += arr[j];
      }
      tmp[i] = sum / win;
    }
    arr.set(tmp);
  }
}
