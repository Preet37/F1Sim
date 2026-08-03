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

/**
 * Box-blur radius, in nodes, applied to the solved racing line so that a car
 * with finite steering and tire response can actually hold it. See the note in
 * `solveRacingLine`.
 */
const LINE_RESPONSE_RADIUS = 2;

/**
 * How far off the dry line a car runs on a soaked circuit, metres.
 *
 * MEASURED AGAINST THE BAND IT HAS TO ESCAPE, and the first attempt got it
 * wrong by not doing that. At 1.8m — chosen as "about a car's width, which must
 * be enough" — `probeWeather` measured a car on the wet line at Spa's tightest
 * corner as still 56% inside the rubber groove, because the groove there is
 * 1.68m of half-width and `TrackSurface` fades it out over 1.35 times that. The
 * cars moved 0.4m on a soaked circuit and the whole effect was invisible.
 *
 * 2.4m clears it. It is the distance at which `TrackSurface.onLineFraction`
 * reaches zero at a tight corner, which is the only number that matters: a
 * shift that leaves the car on the rubber has bought a longer lap for nothing.
 * There is room — the corridor at Spa's tightest point is 5.05m either side of
 * the ideal line once the car's width and the tracking margin are taken out —
 * and where there is not, the clamp below handles it.
 */
const WET_LINE_SHIFT_M = 2.4;

/**
 * Corner radius below which a kerb is laid on the inside automatically, metres.
 *
 * 250, down from 400, and the difference is not a matter of taste — it was
 * measured. At 400m the calendar averaged 42.6% of every lap with kerbing on
 * one side or the other, running to 59% at Monaco and 58% at Zandvoort. A real
 * circuit kerbs its apexes and its exits; it does not kerb three fifths of a
 * lap, and a lap that is more kerb than road is a large part of why the corners
 * looked wrong. 400m is also simply not a corner at these speeds: it is a fast
 * curve a Formula One car takes flat, and no driver puts a wheel on a kerb
 * there because there is nothing to gain by it.
 *
 * 250m is the radius at which a car is genuinely turning — around 240 km/h at
 * the grip these cars have — and it is the point where drivers start using the
 * inside of the road. It takes the calendar to 32.5%. Anything a circuit wants
 * beyond that is authored, through `curbOverrides`, which is what that field is
 * for. `npm run probe:kerbs` prints the per-circuit figures.
 */
const AUTO_CURB_RADIUS_M = 250;

/**
 * The tightest a node may turn no matter how narrow the road is, metres.
 *
 * A backstop under the width-derived limit in `easeCentrelineKinks`, so that a
 * circuit authored unusually narrow cannot license a centreline that turns
 * inside anything a car could drive. Monaco's Grand Hotel hairpin, the
 * tightest corner in Formula One, is about ten metres of centreline radius;
 * eight is comfortably inside that and every other corner on the calendar is
 * looser than either.
 */
const CENTRELINE_FLOOR_R_M = 10;

/**
 * How much of the centreline's own rate the inner edge of the road must still
 * make, at every node, on both sides.
 *
 * Zero is where the edge stops advancing and the ribbon folds. This is the
 * margin above zero that `narrowWhereTheInnerEdgeFolds` holds, and
 * `probe:shoulders` prints every node that is under it.
 */
export const MIN_EDGE_ADVANCE = 0.3;

/**
 * The narrowest a road may be made by the fold pass, metres.
 *
 * Twelve metres is the narrowest a modern Formula One circuit is built — the
 * regulations ask for fifteen and the exceptions are the street circuits.
 * Where a node is ALREADY narrower than this, because it is Monaco or because
 * `narrowWhereTheLapOverlapsItself` has been there, the floor is that width
 * instead: this pass may never be the thing that makes a road narrower than
 * the circuit it belongs to already is.
 */
const FOLD_FLOOR_WIDTH_M = 12;

/**
 * Everything needed to answer "how fast can THIS car go round THIS radius, and
 * how hard can it stop".
 *
 * Split out of `SpeedSolverParams` so that the two questions the track gets
 * asked can be told apart. Solving a speed profile is a whole-lap operation
 * that needs engine power; asking whether a particular car will make a
 * particular corner does not, and the caller that asks it — the racing-line
 * overlay — has a live car in front of it rather than a reference.
 */
export interface CarCapability {
  /** Peak tire friction coefficient on a dry track. */
  mu: number;
  /** Downforce coefficient: F_down = cl * v^2  (Newtons, v in m/s). */
  cl: number;
  /** Drag coefficient: F_drag = cd * v^2. */
  cd: number;
  massKg: number;
  /** Total brake force at full pedal, N — the same cap the car itself has. */
  maxBrakeForceN: number;
  maxSpeedMs: number;
}

/** Reference car used to solve the speed profile. Real cars deviate from it. */
export interface SpeedSolverParams extends CarCapability {
  /** Peak power in Watts, used for the traction-limited forward pass. */
  powerW: number;
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

  /**
   * The line a car takes when the dry line is the worst part of the road.
   *
   * WHY THERE ARE TWO LINES. Rubber laid into the asphalt over a dry weekend is
   * slick under water, so on a soaked circuit the groove every car has been
   * driving is the LAST place to put a tyre. The cars move off it — wider on
   * entry, later on the apex, off the polished strip — and that sight is the
   * most recognisable thing about wet Formula 1.
   *
   * It is a second baked array rather than a modification of the first because
   * `lineOffset` is calibrated: `probeRacingLine`, `probeDrivability` and the
   * whole solved speed profile are measured against it, and a line that moved
   * when it rained would move all of them. This one is derived FROM it, is
   * never the input to the speed solver, and is blended in by the AI according
   * to how much grip the surface model says is actually to be had off the
   * groove — so on a dry track it has no effect whatsoever.
   *
   * `wetLineCurvature` exists for the same reason the dry one does: the AI
   * steers with a curvature feedforward, and a car fed the dry line's curvature
   * while driving the wet line's geometry tracks visibly worse than one fed
   * neither.
   */
  readonly wetLineOffset: Float32Array;
  readonly wetLineCurvature: Float32Array;
  /** Solved reference speed at this node, m/s. */
  readonly targetSpeed: Float32Array;
  /**
   * The purely LATERAL limit at this node, m/s: the fastest the reference car
   * can go round the racing line's radius here before the tyres let go.
   *
   * Distinct from `targetSpeed`, and the distinction is the whole point of it
   * existing. `targetSpeed` is this number after the braking and traction
   * passes have run over it, so on the approach to a hairpin it is far below
   * the local grip limit — the road there is straight and would take 300 km/h,
   * but the profile says 120 because that is what is needed to make the corner.
   * That makes `targetSpeed` the right answer to "what should I be doing" and
   * the WRONG answer to "can the tyres hold what I am doing".
   *
   * The racing-line overlay needs the second question, because a driver who
   * follows a green line into a corner and washes straight off has been told
   * about their braking and never about their grip.
   */
  readonly corneringSpeed: Float32Array;

  /**
   * The curvature the cornering limit at each node was actually solved against:
   * the WORST |curvature| in a short window around the node, not the value at
   * the node itself. See the `kWorst` block in `solveSpeedProfile` for why the
   * window exists.
   *
   * Stored because `corneringSpeed` answers the grip question for ONE car — the
   * reference car — and anything asking it for a DIFFERENT car needs the radius
   * back. Recovering it algebraically from `corneringSpeed` is possible but
   * breaks exactly where it matters least and lies most: on a straight the
   * solved speed is clamped to `maxSpeedMs`, and inverting that clamp yields a
   * finite radius for a road that has none.
   */
  readonly lineCurvatureWorst: Float32Array;

  /**
   * The aero and grip constants the speed profile was solved with.
   *
   * Exposed so that anything asking "could the car do X here" answers it with
   * the same numbers the line itself was built from, rather than a constant of
   * its own that drifts out of step.
   */
  readonly solverParams: SpeedSolverParams;

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
    this.solverParams = params;

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
    this.wetLineOffset = new Float32Array(count);
    this.wetLineCurvature = new Float32Array(count);
    this.targetSpeed = new Float32Array(count);
    this.corneringSpeed = new Float32Array(count);
    this.lineCurvatureWorst = new Float32Array(count);
    this.isCurbLeft = new Uint8Array(count);
    this.isCurbRight = new Uint8Array(count);
    this.isDrsZone = new Uint8Array(count);
    this.sector = new Uint8Array(count);
    this.isPassingZone = new Uint8Array(count);

    resampleClosedCatmullRom(ctrl, nCtrl, count, this.px, this.pz);

    for (let i = 0; i < count; i++) this.dist[i] = (i * def.lengthM) / count;

    this.easeCentrelineKinks();
    this.computeFrames();
    this.applyMetadata();
    this.solveRacingLine();
    this.referenceLapTime = this.solveSpeedProfile(params);
  }

  // =========================================================================
  // Geometry
  // =========================================================================

  /**
   * Eases the centreline where it turns tighter than the road is wide.
   *
   * THE TRACES HAVE CORNERS IN THEM, not corner radii. `realGeometry` carries
   * a control point about every twenty-five metres, so a hairpin arrives as a
   * single vertex turning through eighty to a hundred and thirty degrees —
   * Monaco's Grand Hotel is 130.4 degrees at one point, COTA's turn eleven
   * 94.5, Bahrain's turn ten 85.8. Interpolating through a vertex like that
   * and resampling at three metres puts almost all of the turn into one or two
   * nodes: as authored, the tightest node-to-node radius on the calendar was
   * 2.5m at Monaco, 5.1m at COTA, 6.3m at Bahrain, 6.9m at Monza and 7.0m at
   * Spa. Centripetal parameterisation was tried and does not help, because
   * this is not an interpolation artefact — the control polygon really does
   * have a 130-degree vertex in it, and any curve through it turns sharply.
   *
   * That is not survivable, because the road is a ribbon `width` across:
   * its INNER edge advances at `1 - halfWidth * curvature` of the centreline's
   * rate, so at five metres of radius against seven and a half metres of
   * half-width the factor is NEGATIVE. The edge reverses, the asphalt folds
   * over itself, and there is no ground beside the road to draw, no pocket for
   * a kerb, and a gap in the white line. `probe:shoulders` counts the first,
   * `probe:kerbs` the second and `validate:limits` the third; on screen all
   * three are one thing, the hole at the apex.
   *
   * SO THE LIMIT IS DERIVED, NOT CHOSEN. Each node's turn is held to the
   * radius its own authored half-width needs to keep `MIN_EDGE_ADVANCE` of
   * forward progress on the inside, which is the least easing that makes the
   * ribbon sound. Nothing is smoothed for tidiness: a corner already wide
   * enough for its road is left exactly as surveyed, and on the calendar that
   * is 99% of nodes — Silverstone and Interlagos are not touched at all.
   *
   * A constrained Laplacian relaxation does the work, with two limits:
   *
   *   ONLY WHERE IT IS NEEDED. A node moves only if it, or a node within
   *   `HALO` of it, is over its own limit, and the weight falls off linearly
   *   across the halo so the easing blends into the surveyed trace rather than
   *   stepping into it. The halo is what lets the turn SPREAD: a hundred and
   *   thirty degrees at ten metres of radius needs twenty-three metres of arc,
   *   which is eight node spacings, so a corner cannot be opened up without
   *   borrowing from the approach and the exit. Five is not a free parameter —
   *   at six or more Monaco stops converging and its hairpin comes out at a
   *   1.7m radius, which `probe:shoulders` catches as a fold.
   *
   *   AND NEVER FAR. `MAX_SHIFT_M` is a hard leash back to where the trace put
   *   each node. It is a safety net rather than a working limit and nothing on
   *   the calendar reaches it. What actually moves, measured: Monaco 61 nodes,
   *   worst 10.4m at the apex of the hairpin, where the trace's own control
   *   polygon says the corner is a 9.7m-radius one and the resampled polyline
   *   had made it a 2.5m cusp; COTA 81 nodes, worst 3.75m; Bahrain 61, worst
   *   2.30m; Monza 28, worst 1.53m; Spa 40, worst 1.42m; Zandvoort 19, worst
   *   0.16m. Jeddah, Silverstone, Red Bull Ring, Suzuka and Interlagos are not
   *   touched at all — 290 nodes of 18,273 on the calendar move, 1.6%.
   *
   * `dist` stays uniform afterwards while the polyline it describes has got a
   * little shorter — an eased corner is a shorter path. Measured against each
   * circuit's official length: Monaco -0.55%, COTA -0.15%, Bahrain -0.07%, and
   * under 0.05% everywhere else. The alternative is re-parameterising the
   * whole lap, which would slide every distance-keyed thing on the circuit —
   * corner names, DRS zones, elevation, banking, the pit lane — by up to the
   * accumulated error, to fix a discrepancy of a fraction of a percent.
   */
  private easeCentrelineKinks(): void {
    const { count, px, pz, def } = this;
    /** Nodes either side of a spike that share in the easing. */
    const HALO = 5;
    /** Fraction of the way to the chord midpoint one pass may move a node. */
    const RELAX = 0.35;
    /** Most any node may end up from where the surveyed trace put it. */
    const MAX_SHIFT_M = 12;
    /**
     * Extra advance asked of the centreline over what the ribbon needs.
     *
     * `narrowWhereTheInnerEdgeFolds` runs afterwards and holds the same
     * `MIN_EDGE_ADVANCE` exactly; leaving the centreline sitting on the
     * threshold would hand it every node of every hairpin to narrow. This is
     * the daylight between the two so that the width pass has nothing to do
     * except where the centreline genuinely could not be eased.
     */
    const HEADROOM = 0.08;

    // The authored width, before `narrowWhereTheLapOverlapsItself` and before
    // the fold pass — neither has run yet, and both only ever narrow, so this
    // is the widest the road at a node will ever be and therefore the
    // strictest limit it can ask of the centreline.
    const authored = new Float64Array(count).fill(def.defaultWidthM);
    if (def.widthOverrides) {
      for (const seg of def.widthOverrides) {
        this.forEachNodeInRange(seg.startS, seg.endS, (i) => { authored[i] = seg.widthM; });
      }
    }
    /**
     * How far the heading may swing per metre of centreline: a curvature.
     *
     * Per node, because the radius each node needs is the one its own road
     * width asks for.
     */
    const nodeM = this.length / count;
    const maxSwing = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const need = (authored[i] * 0.5) / (1 - MIN_EDGE_ADVANCE - HEADROOM);
      maxSwing[i] = 1 / Math.max(CENTRELINE_FLOOR_R_M, need);
    }

    const ox = Float64Array.from(px);
    const oz = Float64Array.from(pz);
    const weight = new Float64Array(count);
    const nextX = new Float64Array(count);
    const nextZ = new Float64Array(count);

    for (let pass = 0; pass < 600; pass++) {
      weight.fill(0);
      let tightest = 0;

      for (let i = 0; i < count; i++) {
        const p = (i - 1 + count) % count;
        const n = (i + 1) % count;
        const a1 = Math.atan2(pz[i] - pz[p], px[i] - px[p]);
        const a2 = Math.atan2(pz[n] - pz[i], px[n] - px[i]);
        let turn = a2 - a1;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        // Against the NOMINAL node spacing, not the local chord, and that is a
        // deliberate choice with a measurement behind it. A radius is a turn
        // per metre, so the chord is the honest denominator and it is what
        // `narrowWhereTheInnerEdgeFolds` and `probe:shoulders` use. But a
        // relaxation cannot be steered by it: easing a corner shortens the
        // path it takes, the nodes in it close up, and a chord-normalised
        // limit therefore tightens faster than the relaxation can satisfy it.
        // Tried both ways — chord-normalised, with and without a floor under
        // the chord and with the re-spacing widened to pull nodes in from the
        // approach, Monaco's hairpin ran away to a 1.7m radius instead of
        // easing; against the nominal spacing it converges on every circuit on
        // the calendar. The price is that a corner whose nodes have closed up
        // ends slightly tighter than asked, which is why Monaco lands at 8.8m
        // against a 10m target and is reported rather than hidden.
        const over = Math.abs(turn) - maxSwing[i] * nodeM;
        if (over <= 0) continue;
        if (over > tightest) tightest = over;
        for (let k = -HALO; k <= HALO; k++) {
          const j = (i + k + count) % count;
          const w = 1 - Math.abs(k) / (HALO + 1);
          if (w > weight[j]) weight[j] = w;
        }
      }

      if (tightest === 0) break;

      let moved = false;
      for (let i = 0; i < count; i++) {
        nextX[i] = px[i];
        nextZ[i] = pz[i];
        const w = weight[i];
        if (w <= 0) continue;
        const p = (i - 1 + count) % count;
        const n = (i + 1) % count;
        const mx = RELAX * w * ((px[p] + px[n]) * 0.5 - px[i]);
        const mz = RELAX * w * ((pz[p] + pz[n]) * 0.5 - pz[i]);
        let x = px[i] + mx;
        let z = pz[i] + mz;
        const dx = x - ox[i];
        const dz = z - oz[i];
        const d = Math.hypot(dx, dz);
        if (d > MAX_SHIFT_M) {
          x = ox[i] + (dx * MAX_SHIFT_M) / d;
          z = oz[i] + (dz * MAX_SHIFT_M) / d;
        }
        if (x !== px[i] || z !== pz[i]) moved = true;
        nextX[i] = x;
        nextZ[i] = z;
      }
      if (!moved) break;
      px.set(nextX);
      pz.set(nextZ);
      this.respaceRuns(weight, ox, oz, MAX_SHIFT_M);
    }
  }

  /**
   * Puts the nodes of each eased run back at uniform spacing along it.
   *
   * WITHOUT THIS THE EASING DOES NOT REACH ITS TARGET, and the reason took a
   * measurement to find. The resampler places nodes at uniform ARCLENGTH along
   * a dense curve, so where that curve cusps the chords between consecutive
   * nodes are far shorter than the arc — 1.6m against a nominal 3m at Monaco.
   * A relaxation that limits the turn per node to `nodeSpacing / R` therefore
   * delivers `chord / turn`, which at Monaco is little more than half of R;
   * and the Laplacian step makes it worse, because pulling a node towards the
   * midpoint of its neighbours shortens both of its chords. Left alone, asking
   * for a 10m hairpin produced a 7.4m one, the racing-line solver read the
   * tighter radius, `validate:tracks` failed its curvature-spike check, and
   * Monaco's apex speed came out at 25.6 km/h against a real 47.
   *
   * Re-spacing closes the loop: the run is walked at uniform arclength between
   * two nodes outside it, so the chords come back towards nominal, the turn
   * limit means what it says, and the relaxation converges on something near
   * the radius it was asked for — 9.1m at Monaco, and above 14.9m everywhere
   * else. The endpoints being fixed is what keeps this local: nothing outside
   * an eased run and its padding is touched.
   */
  private respaceRuns(
    weight: Float64Array, ox: Float64Array, oz: Float64Array, maxShiftM: number,
  ): void {
    const { count, px, pz } = this;
    /**
     * Nodes of untouched approach and exit taken into the re-spacing.
     *
     * The corner an eased run describes is genuinely SHORTER than the one that
     * was surveyed — a hairpin opened from a cusp to a ten-metre arc loses
     * eighteen metres of path at Monaco — and those metres have to come out of
     * something. Re-spacing the run alone takes them all out of the run, which
     * drops its chords to 2.1m against a nominal 3m; and since a node's
     * curvature is read from the circumradius of its two chords, that alone
     * reports a 10m corner as an 8.8m one and hands the speed solver a corner
     * that is not there. `validate:tracks` fails it outright, at its 9m
     * curvature-spike limit.
     *
     * Borrowing a few nodes of approach and exit spreads the loss and brings
     * the worst chord on the calendar back to 2.25m and Monaco's tightest
     * radius to 9.1m. FOUR, and this one is genuinely narrow: the padded nodes
     * are also pulled out of the corner, which raises the turn each remaining
     * node has to make, and past about six of them Monaco's relaxation stops
     * converging altogether. The other ten circuits are indifferent to it.
     */
    const PAD = 4;
    const touched = (i: number): boolean => weight[(i + count) % count] > 0;

    for (let scan = 0; scan < count; scan++) {
      if (!touched(scan) || touched(scan - 1)) continue;
      let end = scan;
      while (touched(end + 1) && end - scan < count - 3) end++;
      if (end - scan + 2 * PAD + 3 > count) continue;
      const from = scan - PAD;
      end += PAD;

      // The polyline from the last node before the padded run to the first
      // after it. Both ends are fixed; everything between is redistributed.
      const first = ((from - 1) % count + count) % count;
      const n = end - from + 3;
      const xs = new Float64Array(n);
      const zs = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const i = (first + k) % count;
        xs[k] = px[i];
        zs[k] = pz[i];
      }
      const cum = new Float64Array(n);
      for (let k = 1; k < n; k++) {
        cum[k] = cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]);
      }
      const total = cum[n - 1];
      if (total < 1e-6) continue;

      let cursor = 0;
      for (let k = 1; k < n - 1; k++) {
        const target = (k / (n - 1)) * total;
        while (cursor < n - 2 && cum[cursor + 1] < target) cursor++;
        const seg = cum[cursor + 1] - cum[cursor];
        const f = seg > 1e-9 ? (target - cum[cursor]) / seg : 0;
        let x = xs[cursor] + (xs[cursor + 1] - xs[cursor]) * f;
        let z = zs[cursor] + (zs[cursor + 1] - zs[cursor]) * f;
        const i = (first + k) % count;
        const dx = x - ox[i];
        const dz = z - oz[i];
        const d = Math.hypot(dx, dz);
        if (d > maxShiftM) {
          x = ox[i] + (dx * maxShiftM) / d;
          z = oz[i] + (dz * maxShiftM) / d;
        }
        px[i] = x;
        pz[i] = z;
      }
      scan = end;
    }
  }

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
    // tighter than AUTO_CURB_RADIUS_M. Real circuits kerb every apex, so
    // deriving it from curvature is both accurate and saves authoring 1900
    // flags per track.
    for (let i = 0; i < count; i++) {
      const k = this.curvature[i];
      if (Math.abs(k) > 1 / AUTO_CURB_RADIUS_M) {
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

    // Last, because it needs the finished widths AND the finished elevation.
    this.narrowWhereTheLapOverlapsItself();
    // And after that, because it is allowed to narrow further but never wider.
    this.narrowWhereTheInnerEdgeFolds();
  }

  /**
   * Narrows the road wherever the centreline still turns tighter than the road
   * is wide, so the inside edge always advances.
   *
   * The road is swept as a ribbon: node i's edge on one side is at
   * `p_i + n_i * side * halfWidth_i`, and the span to node i+1 is the quad
   * between the two. How far that edge moves ALONG the road across the span,
   * as a fraction of how far the centreline moves, is the advance factor. At 1
   * the edge keeps pace with the centreline — a straight. Below 1 it is the
   * inside of a corner. At 0 it has stopped, and the quad has collapsed to a
   * triangle with a cusp at that corner. Below 0 the edge is running BACKWARDS
   * and the quad is a bowtie: the asphalt is folded over itself, there is no
   * pocket for a kerb, no strip of ground to draw beside it, and a gap in the
   * white line where the paint crosses itself. COTA's turn eleven reached
   * -0.201 and Bahrain's turn ten 0.007.
   *
   * The arithmetic is exact and needs no iteration, because of one
   * cancellation: expanding the advance gives
   *
   *     (p_j - p_i)·t_i + side·h_j·(n_j·t_i) - side·h_i·(n_i·t_i)
   *
   * and `n_i·t_i` is zero by construction. A span's advance therefore depends
   * on the half-width at its FAR end only, and each node's width is bounded by
   * exactly two spans — the one arriving and the one leaving, the latter read
   * backwards. Both are applied here.
   *
   * `easeCentrelineKinks` has already taken the sampling spikes out, so what
   * this has left to do is small and it is meant to be: it exists as the
   * guarantee, not as the mechanism. Anything it cannot fix within
   * `FOLD_FLOOR_WIDTH_M` is a genuinely over-tight centreline and
   * `probe:shoulders` prints it rather than letting a road be narrowed to a
   * footpath to hide it.
   */
  private narrowWhereTheInnerEdgeFolds(): void {
    const { count, px, pz, tx, tz, nx, nz, width } = this;
    /** Most the half-width may change between adjacent nodes, metres. */
    const WIDTH_SLOPE_M = 0.25;

    const cap = new Float64Array(count);
    for (let i = 0; i < count; i++) cap[i] = width[i] * 0.5;

    /**
     * Bounds the half-width at `k` from one span, traversed towards `k`.
     *
     * `f` is the node the span starts at, whose frame the advance is measured
     * in, and `dir` is +1 when that is the lower-numbered node.
     *
     * Both distances are measured against the CENTRELINE's own step across
     * this span, not against the nominal node spacing. The resampler puts the
     * nodes at uniform ARCLENGTH along a dense curve, so at a hairpin, where
     * that curve bends hard between two samples, the chord between them is
     * shorter than the arc — 1.6m against a nominal 3m at Monaco's Grand
     * Hotel. Dividing by the nominal figure there would report an inner edge
     * doing 0.165 of the centreline's rate when it is doing 0.30 of it, and
     * would then narrow a road to fix a defect that is in the denominator.
     */
    const bound = (k: number, f: number, dir: 1 | -1): void => {
      const ux = tx[f] * dir;
      const uz = tz[f] * dir;
      const along = (px[k] - px[f]) * ux + (pz[k] - pz[f]) * uz;
      const swing = nx[k] * ux + nz[k] * uz;
      if (swing === 0 || along <= 0) return;
      // Only one side is ever on the inside of a turn — the one where
      // `side * swing` is negative. The other edge advances FASTER than the
      // centreline and needs no bound, so the magnitude is all that is read
      // and the answer is the same bound for whichever side that is.
      const allow = ((1 - MIN_EDGE_ADVANCE) * along) / Math.abs(swing);
      if (allow < cap[k]) cap[k] = allow;
    };

    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      bound(j, i, 1);
      bound(i, j, -1);
    }

    for (let i = 0; i < count; i++) {
      const half = width[i] * 0.5;
      // Never wider than authored, and never narrower than the circuit is.
      const floor = Math.min(half, FOLD_FLOOR_WIDTH_M * 0.5);
      width[i] = Math.max(floor, Math.min(half, cap[i])) * 2;
    }

    // Ease it in and out. Slope-limited DOWNWARD only and wrapped, exactly as
    // `narrowWhereTheLapOverlapsItself` does it: a symmetric smoothing pass
    // would put the width back up on the very node that was just narrowed.
    // Without this a node steps three metres narrower than its neighbour and
    // the shoulder beside it steps with it, which is the defect `steps>0.3m`
    // in `probe:shoulders` counts.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < count; k++) {
        const i = k % count;
        const p = (i - 1 + count) % count;
        if (width[i] > width[p] + WIDTH_SLOPE_M * 2) width[i] = width[p] + WIDTH_SLOPE_M * 2;
      }
      for (let k = count - 1; k >= 0; k--) {
        const i = k % count;
        const n = (i + 1) % count;
        if (width[i] > width[n] + WIDTH_SLOPE_M * 2) width[i] = width[n] + WIDTH_SLOPE_M * 2;
      }
    }
  }

  /**
   * Caps the width where the lap runs back alongside itself closer than the
   * road is wide, so the racing surface never overlaps its own other side.
   *
   * The centrelines are surveyed traces; the widths are one number per circuit
   * with a handful of authored overrides. At a hairpin tight enough that the two
   * legs pass within a road's width of each other, those two facts contradict
   * each other and the drawn surface folds over itself.
   *
   * `validate:world` found exactly one instance of it on the calendar: Monaco's
   * Grand Hotel hairpin, where the legs are eight metres apart centre to centre
   * and the road is ten metres wide. Because the hairpin is also on the climb,
   * the two legs are drawn 0.7m apart vertically — so it is not a harmless
   * coplanar overlap that nobody can see, it is a two-metre-wide slab of asphalt
   * hanging in mid-air across the outside of the corner, at exactly the height a
   * car's nose occupies. That is the "-2.08m of track-surface on the racing
   * surface at s=330m" the probe reports.
   *
   * The honest fix is the one a real circuit uses: a hairpin that tight is
   * NARROW. Monaco's is about seven and a half metres across in reality, which
   * is roughly where this lands it.
   *
   * A CROSSOVER IS NOT A SQUEEZE, and that is the exemption that matters.
   * Suzuka's figure-of-eight overlaps itself by six metres in plan, and no width
   * separates two roads whose centrelines MEET — the only width that would is
   * zero. Narrowing the back straight to a footpath to satisfy a rule aimed at
   * hairpins would be inventing a defect where the world is correct. So the
   * amount either leg may give is capped at a quarter of its half-width: below
   * that the legs are running past each other and a real circuit is narrow
   * there, above it they cross and the geometry is left exactly as surveyed.
   * Monaco's hairpin asks for 15%; Suzuka's crossover asks for 47%.
   *
   * The vertical test is the second exemption: two pieces of road more than
   * `DECK_GAP_M` apart in height are one passing over the other.
   */
  private narrowWhereTheLapOverlapsItself(): void {
    const { count, px, pz, tx, tz, nx, nz, width, elevation } = this;
    const nodeM = this.length / count;
    /**
     * Half-length of the rectangle one node's road occupies, metres.
     *
     * Deliberately longer than the 0.6 node spacings `validate:world` measures
     * against. The two models of "which piece of road is under this point" agree
     * to within a centimetre or two, and Monaco's conflict sits exactly on the
     * boundary of one — so a pass that used the same figure declared the hairpin
     * clear while the probe, rounding the other way, still called it an
     * obstruction. Reaching further can only ever narrow slightly more of a
     * corner that is being narrowed anyway.
     */
    const halfSlab = nodeM * 0.9;
    /**
     * Nodes either side that are the same piece of road by definition.
     *
     * ONE, and the `along` test below is what makes that safe rather than
     * reckless: a node's edge only lands inside ANOTHER node's slab if the two
     * are level with each other across the road, and three metres of arc only
     * projects back to within 1.8m along the tangent once the road is turning
     * inside about a seven-metre radius. Nothing on the calendar is.
     *
     * Anything larger simply hides the case this pass exists for. Monaco's
     * hairpin turns through 71 degrees in two node spacings, so the conflicting
     * pairs there are (110, 112) and (110, 113) — a skip of three saw neither,
     * and a skip of two still saw only the second of them.
     */
    const SKIP_NODES = 1;
    /**
     * Gap left between the two legs once they have both given ground.
     *
     * Comfortably more than the 0.10m of penetration `validate:world` tolerates
     * as discretisation noise, so a corner that is fixed is fixed with room to
     * spare rather than sitting on the threshold.
     */
    const SEPARATION_M = 0.5;
    /**
     * Height difference below which an overlap is invisible, and above which it
     * is one road passing over another.
     *
     * Two pieces of asphalt at the same height that overlap simply merge — there
     * is nothing to see and nothing to hit, and every tight corner on the
     * calendar has a little of it where one node's slab reaches across the
     * next's. What makes an overlap a defect is the STEP: `validate:world` calls
     * a vertex an obstruction once it is 0.25m above the road beneath it, and
     * that is exactly the height at which a slab of road hanging over another
     * one starts being something a car's nose can meet. So the band this pass
     * acts on is bounded at both ends.
     */
    const STEP_M = 0.22;
    const DECK_GAP_M = 2.5;
    /**
     * Most of its half-width one leg may give up before this stops being a
     * squeeze and starts being a crossing.
     *
     * A backstop behind the junction test above, not the primary discriminator —
     * it is here so that a fold-back the junction test somehow does not see can
     * still never narrow a circuit past recognition. Monaco's hairpin, the one
     * real case on the calendar, asks for 32% and lands at a road 6.8m across,
     * which is close to what Loews actually measures.
     */
    const MAX_GIVE_FRACTION = 0.45;
    /** Nodes either side of a crossing that are part of the same crossing. */
    const JUNCTION_SPREAD_NODES = 20;
    /**
     * No circuit is ever narrowed below this half-width.
     *
     * Six metres of road is the tightest thing on the calendar that is still a
     * road, and only Monaco's hairpin reaches it.
     */
    const MIN_HALF_M = 3.0;
    /** Most the half-width may grow between adjacent nodes, metres. */
    const WIDTH_SLOPE_M = 0.25;

    // A coarse grid over the nodes, so this stays linear. `TrackSpline` is
    // constructed once per session but many times over in the probes, and a
    // brute-force pass over two thousand nodes squared is felt there.
    const CELL = 16;
    const bins = new Map<number, number[]>();
    const key = (gx: number, gz: number): number => (gx * 73856093) ^ (gz * 19349663);
    let reach = halfSlab;
    for (let i = 0; i < count; i++) reach = Math.max(reach, width[i] * 0.5 + halfSlab);
    for (let i = 0; i < count; i++) {
      const g0x = Math.floor((px[i] - reach) / CELL), g1x = Math.floor((px[i] + reach) / CELL);
      const g0z = Math.floor((pz[i] - reach) / CELL), g1z = Math.floor((pz[i] + reach) / CELL);
      for (let gx = g0x; gx <= g1x; gx++) {
        for (let gz = g0z; gz <= g1z; gz++) {
          const k = key(gx, gz);
          const bin = bins.get(k);
          if (bin) bin.push(i);
          else bins.set(k, [i]);
        }
      }
    }

    // Where the lap CROSSES itself, and the stretch either side of it.
    //
    // A crossing is one centreline running over another, not two roads running
    // past each other, and the whole approach and exit of it has to be exempt —
    // not just the node where they meet. At Suzuka the two legs overlap for
    // twenty-five metres before their centrelines actually touch, and the
    // shallow overlaps at each end of that are individually small enough to look
    // like an ordinary squeeze. Narrowing them achieves nothing, because the
    // metres in the middle are untouchable, and it costs the back straight two
    // metres of width for it.
    const junction = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const bin = bins.get(key(Math.floor(px[i] / CELL), Math.floor(pz[i] / CELL)));
      if (!bin) continue;
      for (const j of bin) {
        let d = Math.abs(i - j);
        if (d > count / 2) d = count - d;
        if (d <= SKIP_NODES) continue;
        if (Math.abs(elevation[i] - elevation[j]) > DECK_GAP_M) continue;
        const dx = px[i] - px[j];
        const dz = pz[i] - pz[j];
        const along = dx * tx[j] + dz * tz[j];
        if (along < -halfSlab || along > halfSlab) continue;
        if (Math.abs(dx * nx[j] + dz * nz[j]) > width[j] * 0.5) continue;
        junction[i] = 1;
        junction[j] = 1;
      }
    }
    if (junction.some((v) => v === 1)) {
      const spread = new Uint8Array(junction);
      for (let i = 0; i < count; i++) {
        if (!junction[i]) continue;
        for (let k = -JUNCTION_SPREAD_NODES; k <= JUNCTION_SPREAD_NODES; k++) {
          spread[(i + k + count) % count] = 1;
        }
      }
      junction.set(spread);
    }

    // Relaxed to convergence, both legs giving half the overlap at a time.
    //
    // Halving and stopping is not enough, and the reason is worth stating: an
    // edge pulled in along its OWN normal does not necessarily move across the
    // other leg's road at all. At Monaco's hairpin the two legs meet at right
    // angles, so node 111's normal points along node 113's tangent — narrowing
    // 111 slides its edge up and down 113's road without ever leaving it, and
    // only 113 giving ground actually separates them. One pass of "each gives
    // half" therefore left three quarters of a metre still overlapping.
    //
    // Iterating is safe here because the two exemptions — the junction map and
    // the floor below — are both fixed before the loop starts, off the widths as
    // authored. Nothing can be narrowed a slice at a time past a test it would
    // have failed outright.
    const origHalf = new Float64Array(count);
    for (let i = 0; i < count; i++) origHalf[i] = width[i] * 0.5;
    /** As narrow as each node may ever get. */
    const floor = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      floor[i] = Math.max(MIN_HALF_M, origHalf[i] * (1 - MAX_GIVE_FRACTION));
    }

    // The edge is sampled BETWEEN nodes as well as at them, because that is
    // where it is drawn: the paint and the kerb sections are swept at several
    // stations per node spacing, off a normal interpolated between two nodes.
    // Whatever a sample between i and i+1 asks for is charged to both of them.
    const EDGE_SUB = 4;
    const distNodes = (a: number, b: number): number => {
      const d = Math.abs(a - b);
      return d > count / 2 ? count - d : d;
    };

    for (let pass = 0; pass < 24; pass++) {
      const cap = new Float64Array(count);
      for (let i = 0; i < count; i++) cap[i] = width[i] * 0.5;
      let worst = 0;

      for (let i = 0; i < count; i++) {
        const i1 = (i + 1) % count;
        if (junction[i] || junction[i1]) continue;
        const hwA = width[i] * 0.5;
        const hwB = width[i1] * 0.5;
        for (let k = 0; k < EDGE_SUB; k++) {
          const f = k / EDGE_SUB;
          const g = 1 - f;
          const cx = px[i] * g + px[i1] * f;
          const cz = pz[i] * g + pz[i1] * f;
          let enx = nx[i] * g + nx[i1] * f;
          let enz = nz[i] * g + nz[i1] * f;
          const len = Math.hypot(enx, enz) || 1;
          enx /= len; enz /= len;
          const hw = hwA * g + hwB * f;
          for (const side of [-1, 1] as const) {
            const ex = cx + enx * side * hw;
            const ez = cz + enz * side * hw;
            const bin = bins.get(key(Math.floor(ex / CELL), Math.floor(ez / CELL)));
            if (!bin) continue;
            for (const j of bin) {
              if (distNodes(i, j) <= SKIP_NODES || distNodes(i1, j) <= SKIP_NODES) continue;
              if (junction[j]) continue;
              const step = Math.abs(elevation[i] - elevation[j]);
              if (step < STEP_M || step > DECK_GAP_M) continue;
              const dx = ex - px[j];
              const dz = ez - pz[j];
              const along = dx * tx[j] + dz * tz[j];
              if (along < -halfSlab || along > halfSlab) continue;
              const lat = Math.abs(dx * nx[j] + dz * nz[j]);
              const hwj = width[j] * 0.5;
              const pen = hwj - lat;
              if (pen <= 0) continue;
              if (pen > worst) worst = pen;
              const give = (pen + SEPARATION_M) * 0.5;
              if (hwA - give < cap[i]) cap[i] = hwA - give;
              if (hwB - give < cap[i1]) cap[i1] = hwB - give;
              if (hwj - give < cap[j]) cap[j] = hwj - give;
            }
          }
        }
      }

      if (worst <= 0) break;
      let moved = false;
      for (let i = 0; i < count; i++) {
        const next = Math.max(floor[i], cap[i]) * 2;
        if (next < width[i] - 1e-4) { width[i] = next; moved = true; }
      }
      // Everything left is up against the floor: two roads that genuinely meet.
      if (!moved) break;
    }

    // Ease the narrowing in and out. Slope-limited DOWNWARD only and wrapped,
    // exactly as the barrier line is: a symmetric smoothing pass would put the
    // width back up on the very nodes that were just moved off the other leg.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < count; k++) {
        const i = k % count;
        const p = (i - 1 + count) % count;
        if (width[i] > width[p] + WIDTH_SLOPE_M * 2) width[i] = width[p] + WIDTH_SLOPE_M * 2;
      }
      for (let k = count - 1; k >= 0; k--) {
        const i = k % count;
        const n = (i + 1) % count;
        if (width[i] > width[n] + WIDTH_SLOPE_M * 2) width[i] = width[n] + WIDTH_SLOPE_M * 2;
      }
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
  // Racing line: constrained minimum-curvature optimisation
  // =========================================================================

  /**
   * Solves the racing line as the minimum-curvature path through the corridor.
   *
   * The line is parameterised by one lateral offset per centreline node,
   * `a[i]`, so the path is `p[i] = c[i] + a[i] * n[i]` and the only unknowns are
   * the offsets. The objective is the discrete bending energy
   *
   *     J(a) = sum_i | p[i-1] - 2 p[i] + p[i+1] |^2
   *
   * subject to `|a[i]| <= limit[i]`. Because `p` is affine in `a`, `J` is a
   * convex quadratic and the box constraints are convex, so this is a convex QP:
   * there is exactly one minimum and no local traps. That is what makes it safe
   * to solve numerically rather than construct by hand.
   *
   * WHY THIS REPLACED THE HAND-CONSTRUCTED LINE
   *
   * The previous version built the line from rules — "if |curvature| is above a
   * threshold, hug the inside in proportion to it; otherwise set up on the
   * outside of the next corner". That works on idealised geometry, where a
   * straight has curvature of exactly zero and a corner is a constant-radius
   * arc, and it is why the authored layouts solved close to their real pole
   * times. It falls apart on surveyed geometry. A real circuit's straights are
   * not straight: they bend gently and continuously, at radii of a few hundred
   * metres, which cleared the rule's corner threshold nearly everywhere. Almost
   * every node was therefore classified as "in a corner" and pushed to the
   * inside — the shortest-path failure mode, which makes the driven radius
   * TIGHTER than the centreline's. Surveyed laps came out 14% slow.
   *
   * Optimising the real objective inverts that behaviour exactly where it
   * matters. A gentle bend can be cancelled outright by the corridor: with
   * about 5m of usable offset each side, a 500m-radius sweep stays straight for
   * over 200m of track. Those are the bends a real car takes flat and the rule
   * braked for. Tight corners still get the classic out-in-out, because that
   * genuinely is the lowest-curvature path through a tight corridor.
   *
   * SOLVER
   *
   * Projected Gauss-Seidel, run over a cascade of node strides. The Hessian is
   * a fourth-difference operator, whose condition number grows like N^4, so a
   * single-scale sweep would need tens of thousands of passes to move the
   * long-wavelength part of the answer — which is precisely the part that
   * straightens a 200m bend. Sweeping at stride 128 first, then 64, 32, ... down
   * to 1, moves each wavelength band at the scale where it converges in a few
   * passes. Each coordinate update is an exact Newton step (the diagonal of the
   * Hessian is a constant 6 per node, since the stencil is [1,-4,6,-4,1]),
   * clamped back into the corridor.
   *
   * Runs once per circuit at load, not per frame.
   */
  private solveRacingLine(): void {
    const { count, width, lineOffset } = this;

    // Half the car plus a margin. Deliberately more than the regulation minimum:
    // an ideal line sitting exactly on the white line leaves a driver no room for
    // their own tracking error, and the AI put a wheel over the edge at every apex.
    const CAR_HALF_WIDTH = 1.0;
    const MARGIN = 0.95;

    const limit = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      limit[i] = Math.max(0, width[i] * 0.5 - CAR_HALF_WIDTH - MARGIN);
    }

    const a = this.minimiseCurvature(limit);

    for (let i = 0; i < count; i++) lineOffset[i] = a[i];

    // Drivability filter.
    //
    // The solved line is optimal for a point mass that can be anywhere on the
    // road at any instant. A car cannot: the steering rack, the tire sidewalls
    // and the yaw inertia all take time to respond, so the line a real car can
    // hold is the optimum with its shortest wavelengths taken off. Without this
    // the AI's mean deviation from the line doubled to 1.5m and it put all four
    // wheels off often enough that most qualifying laps were deleted.
    //
    // The window is set by that response time rather than by taste: a box blur
    // of radius 2 spans five nodes, 15m, which is the distance a car covers in
    // roughly 0.15s at racing speed. It costs 1.6% of solved lap time, and that
    // cost is real — it is the part of the theoretical optimum no driver gets.
    smoothWrapped(lineOffset, LINE_RESPONSE_RADIUS, 1);
    for (let i = 0; i < count; i++) {
      lineOffset[i] = clamp(lineOffset[i], -limit[i], limit[i]);
    }

    this.computeLineCurvature();
    this.solveWetLine(limit);
  }

  /**
   * The wet line: the dry line pushed off the rubber, and no further.
   *
   * A DERIVATION, NOT A SECOND OPTIMISATION. The temptation is to re-run
   * `minimiseCurvature` with the rubber band as an obstacle, and it would be
   * wrong: the wet line is not a different optimum, it is the same optimum
   * given up in exchange for a surface. What a driver actually does in the wet
   * is take a wider entry and a later apex, which is geometrically a shift away
   * from the inside of the corner — away from exactly the strip where the
   * rubber is heaviest, because the rubber is heaviest where the cars have been
   * loading the tyres hardest. One signed shift, driven by the line's own
   * curvature, produces that and nothing else.
   *
   * The shift is bounded by the room available and then run through the same
   * response filter the dry line gets, because a wet line is still driven by a
   * car with the same steering rack. Without the filter the AI's tracking error
   * roughly doubles — the comment above `smoothWrapped(lineOffset, ...)` is
   * about the dry line but the physics it describes is not.
   */
  private solveWetLine(limit: Float64Array): void {
    const { count, lineOffset, lineCurvature, wetLineOffset } = this;

    for (let i = 0; i < count; i++) {
      const k = lineCurvature[i];
      // Sign convention: `lineCurvature` positive is a LEFT turn, and
      // `lineOffset` positive is to the driver's left, so the apex of a left
      // hander sits at a large positive offset. Moving off the rubber means
      // moving toward the outside, which is subtracting.
      const dir = k > 0 ? 1 : k < 0 ? -1 : 0;
      // How much shift is worth taking. On a straight the rubber band is wide
      // and shallow and there is nothing to gain from a specific line, so the
      // shift tapers off with curvature; through a corner the band is narrow
      // and heavy and moving two metres puts the car cleanly beside it.
      const tight = Math.min(1, Math.abs(k) * 90);
      const want = lineOffset[i] - dir * WET_LINE_SHIFT_M * (0.35 + 0.65 * tight);
      wetLineOffset[i] = clamp(want, -limit[i], limit[i]);
    }

    smoothWrapped(wetLineOffset, LINE_RESPONSE_RADIUS, 1);
    for (let i = 0; i < count; i++) {
      wetLineOffset[i] = clamp(wetLineOffset[i], -limit[i], limit[i]);
    }

    // Curvature of the line the car will actually be driving, computed with the
    // same stencil and the same smoothing as the dry one.
    const { px, pz, nx, nz, wetLineCurvature } = this;
    for (let i = 0; i < count; i++) {
      const a = i === 0 ? count - 1 : i - 1;
      const b = i === count - 1 ? 0 : i + 1;
      wetLineCurvature[i] = signedCurvature(
        px[a] + nx[a] * wetLineOffset[a], pz[a] + nz[a] * wetLineOffset[a],
        px[i] + nx[i] * wetLineOffset[i], pz[i] + nz[i] * wetLineOffset[i],
        px[b] + nx[b] * wetLineOffset[b], pz[b] + nz[b] * wetLineOffset[b],
      );
    }
    smoothWrapped(wetLineCurvature, 2, 1);
  }

  /**
   * Half-width of the rubbered-in groove at a node, metres.
   *
   * ONE RULE, TWO CONSUMERS, and that is why it is a method on the track rather
   * than a private constant in either of them. `SurfaceDetail` rasterises this
   * band into the map that darkens the road, and `TrackSurface` decides from it
   * whether a car is on the rubber or beside it. If those two disagreed, the
   * player would be looking at a dark stripe that is not where the grip is, and
   * there is no way to notice that from inside either file.
   *
   * The groove is wider where the cars are spread out and narrower where a
   * corner funnels everyone onto one line. Curvature is the cheapest honest
   * proxy for that, and it is what makes the band pinch at an apex and fan out
   * down a straight — the shape it has in every aerial photograph.
   */
  rubberHalfWidthAt(i: number): number {
    const tight = Math.min(1, Math.abs(this.lineCurvature[i]) * 90);
    return Math.max(1.4, this.width[i] * (0.19 - 0.07 * tight));
  }

  /**
   * The line to drive, blended between dry and wet by how much the surface
   * model says there is to gain from getting off the rubber.
   *
   * `avoidance` is `TrackSurface.lineAvoidance` — 0 on a dry track, 1 when the
   * groove is fully soaked. Everything that steers goes through here, so there
   * is exactly one place where the two lines are combined and no possibility of
   * the AI's target and its feedforward being blended differently.
   */
  lineOffsetAt(i: number, avoidance: number): number {
    if (avoidance <= 0) return this.lineOffset[i];
    return this.lineOffset[i] + (this.wetLineOffset[i] - this.lineOffset[i]) * avoidance;
  }

  /** The matching curvature. Must be blended with the same weight. */
  lineCurvatureAt(i: number, avoidance: number): number {
    if (avoidance <= 0) return this.lineCurvature[i];
    return this.lineCurvature[i] + (this.wetLineCurvature[i] - this.lineCurvature[i]) * avoidance;
  }

  /**
   * Minimises the path's total squared curvature by weighted projected
   * Gauss-Seidel over a cascade of strides. Returns the offsets in metres.
   *
   * THE WEIGHTS ARE THE WHOLE POINT
   *
   * Unweighted, the natural discrete objective is the bending energy
   * `sum |p[i-1] - 2p[i] + p[i+1]|^2`, and it is subtly but badly wrong: it is
   * not a measure of curvature, it is a measure of curvature times the fourth
   * power of the node spacing. Since the nodes sit at fixed centreline stations
   * and the path can move laterally between them, a path that cuts to the inside
   * of a corner has closer-together nodes, and the spacing term falls faster than
   * the curvature term rises. Minimising it therefore drives the line to the
   * inside of every tight corner — the shortest path, at a radius TIGHTER than
   * the centreline's. Measured on the surveyed layouts it was severe: Monaco's
   * line came out with a 3.5m minimum radius against the centreline's 9.5m, Spa
   * 7.6m against 15.2m. Those are the numbers that made the speed solver crawl.
   *
   * The quantity that actually wants minimising is `integral k^2 ds`, and since
   * `k = |d| / ds^2` that is `sum |d[i]|^2 / ds[i]^3`. So each node's residual is
   * weighted by the inverse cube of the local spacing of the LINE, which is
   * exactly the term that punishes cutting inside. Sanity check on a circular
   * arc of radius R cut to R-e: the unweighted objective falls like (R-e),
   * rewarding the cut; the weighted one rises like 1/(R(R-e)), penalising it,
   * and matches the closed-form `integral k^2 ds = theta/(R-e)`.
   *
   * The spacing depends on the answer, so this is solved by reweighting: solve
   * with the current weights, remeasure the spacing, repeat. Three rounds is
   * enough — the weights are a smooth function of a quantity that barely moves
   * after the first solve.
   *
   * SOLVER
   *
   * Projected Gauss-Seidel. At stride `h` the weighted residual is
   *
   *     r[j] = n[j] . ( w[j-h] d[j-h] - 2 w[j] d[j] + w[j+h] d[j+h] )
   *
   * with `d[i] = p[i-h] - 2 p[i] + p[i+h]`, and the exact minimiser along
   * coordinate j is a step of `-r[j] / (w[j-h] + 4 w[j] + w[j+h])` — the
   * diagonal of the Hessian, which for unit weights is the familiar 6 from the
   * [1,-4,6,-4,1] stencil. Sweeping in place (Gauss-Seidel rather than Jacobi)
   * is what keeps the full Newton step stable; a Jacobi sweep of the same
   * operator diverges unless damped below 0.75.
   *
   * The stride cascade exists because the Hessian is a fourth-difference
   * operator whose condition number grows like N^4. A single-scale sweep would
   * need tens of thousands of passes to move the long-wavelength part of the
   * answer — which is precisely the part that straightens a 200m bend. Sweeping
   * at stride 128 first, then 64, 32, ... down to 1 moves each wavelength band
   * at the scale where it converges in a few passes.
   */
  private minimiseCurvature(limit: Float64Array): Float64Array {
    const { count, px, pz, nx, nz } = this;
    const dsNominal = this.length / count;

    const a = new Float64Array(count);
    // Line positions, kept in step with `a` so a sweep never has to rebuild them.
    const lx = new Float64Array(count);
    const lz = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      lx[i] = px[i];
      lz[i] = pz[i];
    }

    // Weights start at 1, which is the correct value for the centreline the
    // solve begins from: its nodes are uniformly spaced by construction.
    const w = new Float64Array(count).fill(1);

    const wrap = (i: number) => {
      let j = i % count;
      if (j < 0) j += count;
      return j;
    };

    const sweep = (h: number, passes: number) => {
      for (let p = 0; p < passes; p++) {
        for (let j = 0; j < count; j++) {
          const jm = wrap(j - h);
          const jp = wrap(j + h);
          const jmm = wrap(j - 2 * h);
          const jpp = wrap(j + 2 * h);

          // d[j-h], d[j], d[j+h] — second differences at stride h.
          const wm = w[jm];
          const wc = w[j];
          const wp = w[jp];

          const rx =
            wm * (lx[jmm] - 2 * lx[jm] + lx[j]) -
            2 * wc * (lx[jm] - 2 * lx[j] + lx[jp]) +
            wp * (lx[j] - 2 * lx[jp] + lx[jpp]);
          const rz =
            wm * (lz[jmm] - 2 * lz[jm] + lz[j]) -
            2 * wc * (lz[jm] - 2 * lz[j] + lz[jp]) +
            wp * (lz[j] - 2 * lz[jp] + lz[jpp]);

          const resid = nx[j] * rx + nz[j] * rz;

          let next = a[j] - resid / (wm + 4 * wc + wp);
          const lim = limit[j];
          if (next > lim) next = lim;
          else if (next < -lim) next = -lim;

          a[j] = next;
          lx[j] = px[j] + nx[j] * next;
          lz[j] = pz[j] + nz[j] * next;
        }
      }
    };

    // Four reweights and these pass counts are twice what it takes to converge:
    // halving every one of them moves no circuit's solved lap time at all. Kept
    // at double for headroom on layouts tighter than anything on this calendar.
    const REWEIGHTS = 4;
    for (let outer = 0; outer < REWEIGHTS; outer++) {
      // Coarse to fine. The coarse strides carry the long-wavelength decision —
      // which way across the track this whole sector of the lap should run — and
      // the fine ones resolve the apex.
      let h = 1;
      while (h * 8 < count) h *= 2;
      for (; h >= 1; h = Math.floor(h / 2)) sweep(h, 24);
      // Polish at full resolution. Cheap, and it is what removes the last of the
      // residual left behind by the constrained nodes.
      sweep(1, 120);

      if (outer === REWEIGHTS - 1) break;

      // Remeasure the line's own node spacing and rebuild the weights from it.
      // Clamped, because a weight is an inverse cube and a single bad sample on
      // a hairpin would otherwise dominate the entire objective.
      for (let i = 0; i < count; i++) {
        const im = wrap(i - 1);
        const ip = wrap(i + 1);
        const ds = Math.hypot(lx[ip] - lx[im], lz[ip] - lz[im]) * 0.5;
        const ratio = clamp(ds / dsNominal, 0.45, 1.8);
        w[i] = 1 / (ratio * ratio * ratio);
      }
      smoothWrapped64(w, 2, 1);
    }

    return a;
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
    const m = p.massKg;

    // Node-to-node distance along the RACING LINE, not along the centreline.
    //
    // The nodes are uniformly spaced on the centreline, but the car is not on
    // the centreline — it is `lineOffset` metres to one side, and on the inside
    // of a corner that makes the step between two nodes measurably shorter. Over
    // a lap the solved line runs about 1.2% shorter than the centreline, which
    // is a real 1.2% of lap time that integrating uniform spacing simply threw
    // away. It matters in the braking and traction passes too: those integrate
    // v dv = a ds, and feeding them the wrong ds moves every braking point.
    const dsLine = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const j = i === count - 1 ? 0 : i + 1;
      const ax = this.px[i] + this.nx[i] * this.lineOffset[i];
      const az = this.pz[i] + this.nz[i] * this.lineOffset[i];
      const bx = this.px[j] + this.nx[j] * this.lineOffset[j];
      const bz = this.pz[j] + this.nz[j] * this.lineOffset[j];
      dsLine[i] = Math.hypot(bx - ax, bz - az);
    }
    // Used only where a nominal spacing is wanted rather than the true one:
    // window sizes expressed in metres.
    const ds = length / count;

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
      this.lineCurvatureWorst[i] = peak;
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
      // Kept before the braking and traction passes overwrite it. This is the
      // grip limit itself, uncontaminated by what the car has to do to reach
      // the NEXT corner — see the field's own comment for why the two must not
      // be confused.
      this.corneringSpeed[i] = targetSpeed[i];
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
        const vMax = Math.sqrt(vn * vn + 2 * aBrake * dsLine[i]);
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

        const vpSq = vp * vp + 2 * aAccel * dsLine[prv];
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
    for (let i = 0; i < count; i++) t += dsLine[i] / Math.max(targetSpeed[i], 1);
    return t;
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /**
   * Deceleration the reference car can actually produce at this speed, m/s².
   *
   * The same expression the solver's backward pass uses, lifted out so that
   * anything reasoning about braking distance uses the car's real capability
   * rather than a constant.
   *
   * It is strongly speed-dependent, and that is the point. At 320 km/h the
   * wings are worth about four tonnes of extra load and the car will stop at
   * something like 5g; at 100 km/h there is almost no downforce left and the
   * limit is the tyre on the car's own weight, a little over 1.8g. A single
   * averaged figure is therefore wrong at both ends — and wrong in the
   * dangerous direction at the bottom, where it promises braking the car cannot
   * deliver.
   */
  brakingDecel(v: number): number {
    const p = this.solverParams;
    const gripLimit = p.mu * (p.massKg * G + p.cl * v * v);
    return (Math.min(p.maxBrakeForceN, gripLimit) + p.cd * v * v) / p.massKg;
  }

  /**
   * The same expression, for a car that is NOT the reference car.
   *
   * The reference car exists so that one solved line and one lap time can be
   * shared by twenty cars. That is the right trade for the AI, which is judged
   * on lap time. It is the wrong trade for anything that makes the PLAYER a
   * promise about their own car, because no player ever drives the reference
   * car: it has mu 1.86 and 850kg, and a real car leaves the garage at 1.70
   * before the compound multiplier, carrying 75kg of fuel.
   */
  brakingDecelForCar(v: number, car: CarCapability): number {
    const gripLimit = car.mu * (car.massKg * G + car.cl * v * v);
    return (Math.min(car.maxBrakeForceN, gripLimit) + car.cd * v * v) / car.massKg;
  }

  /**
   * Grip-limited cornering speed at node `i` for an arbitrary car, m/s.
   *
   * Identical algebra to the cornering pass in `solveSpeedProfile` — the same
   * banking term, the same windowed curvature, the same closed-form solve of
   *
   *     mu * (m g + cl v^2)  =  m v^2 / r
   *
   * so that a car with the reference car's numbers gets the reference car's
   * answer to the last bit. It is written once here rather than duplicated into
   * the overlay precisely so the two cannot drift apart.
   */
  corneringSpeedForCar(i: number, car: CarCapability): number {
    const r = 1 / Math.max(this.lineCurvatureWorst[i], 1e-6);
    const bank = Math.abs(this.banking[i]);
    const effMu = car.mu * (Math.cos(bank) + Math.sin(bank) * 1.2);
    const denom = car.massKg / r - effMu * car.cl;
    if (denom <= 1e-6) return car.maxSpeedMs;
    return Math.min(Math.sqrt((effMu * car.massKg * G) / denom), car.maxSpeedMs);
  }

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

  /**
   * Banking at `s`, radians, INTERPOLATED between nodes.
   *
   * Interpolated rather than read off the nearest node, and the difference is
   * not academic. Anything standing on a banked road is lifted by
   * `lateral * tan(bank)`; at Zandvoort's 18-degree banking that is 2.4m at the
   * edge of the road, so a banking value that stepped from node to node would
   * step the car's height with it — several centimetres every three metres of
   * travel, which is a car visibly hopping through the corner.
   */
  bankingAt(s: number): number {
    const f = (wrapDistance(s, this.length) / this.length) * this.count;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    return lerp(this.banking[i], this.banking[j], f - Math.floor(f));
  }

  /** Road width at `s`, metres, interpolated between nodes. */
  widthAt(s: number): number {
    const f = (wrapDistance(s, this.length) / this.length) * this.count;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    return lerp(this.width[i], this.width[j], f - Math.floor(f));
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

/** As `smoothWrapped`, for the double-precision arrays the line solver uses. */
function smoothWrapped64(arr: Float64Array, radius: number, passes: number): void {
  const n = arr.length;
  if (n === 0 || radius < 1) return;
  const tmp = new Float64Array(n);
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
