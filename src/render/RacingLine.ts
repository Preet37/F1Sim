import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * The racing-line overlay: the optimal line laid on the track, coloured by
 * whether the car is going to make the next part of it.
 *
 * The line itself is not invented for the display. `TrackSpline` already solves
 * a racing line and a speed profile because the AI drives on them, so this
 * ribbon is drawn straight from `lineOffset` and `targetSpeed` — the overlay
 * and the AI are following the identical path, and a player who traces the
 * green is genuinely driving the line the simulation considers fastest.
 *
 * The colouring answers one question: *at my current speed, am I going to make
 * that?*
 *
 *   green   — comfortably within the limit for that point
 *   yellow  — close to it; a lift would settle the car
 *   red     — arriving faster than the corner will take. Brake.
 *
 * TWO tests, and the colour is the worse of them. That is not an embellishment;
 * a version of this shipped with only the first, and it actively lied.
 *
 *   1. LONGITUDINAL — "can I still slow down enough?" Compares the car's speed
 *      against the highest speed from which it could still be down to the
 *      target by the time it arrives, given the road left to brake in.
 *
 *   2. LATERAL — "at this speed, on this radius, will the tyres hold?" Compares
 *      the car's speed directly against the grip limit of the road just ahead,
 *      with no credit for braking at all.
 *
 * The complaint that produced the second test was exact and correct: *"I see
 * the green and I turn, but the car goes off the road and doesn't turn enough.
 * If the racing lines were green, why didn't the car turn?"*
 *
 * Because green never meant that. Test 1 alone asks whether the corner is still
 * REACHABLE — whether a driver who brakes now, hard, gets there at the right
 * speed. A driver who reads that as "you are fine" and turns in instead of
 * braking is shown green right up to the moment they run out of road, and the
 * display was, on its own terms, correct the whole way. It answered a question
 * nobody was asking.
 *
 * Test 2 asks the question they were actually asking. It is the plain
 * cornering equation — grip must supply mv²/r — and it goes red the instant the
 * car is carrying more speed than the radius it is about to turn into will
 * take, whether or not the corner could still be saved by braking. Green now
 * means the car will make it, not that it could still be made to.
 *
 * Only a window ahead of the car is drawn. Colouring the whole circuit would
 * mean rewriting every vertex colour on the lap every frame, and the far side
 * of a 7km track cannot be seen anyway.
 */

/**
 * Metres of line drawn ahead of the car.
 *
 * Generous on purpose. At 320 km/h the car covers 89 metres a second, so a
 * 320m line is under four seconds of warning — and since the colour only turns
 * at the far end of it, the braking cue arrived far too late to act on. 900m
 * is about ten seconds at racing speed, which is enough to see a braking zone
 * developing rather than being told about it as you arrive.
 */
const LOOKAHEAD_M = 900;
/** Metres behind, so the ribbon does not start abruptly under the nose. */
const LOOKBEHIND_M = 25;
/**
 * Ribbon width, metres.
 *
 * A racing car is 2m wide and the track is 12-15m. At 0.55m the line was a
 * thread that disappeared into the asphalt at any distance — exactly where it
 * needs to be readable. 1.4m reads as a painted racing line from a long way
 * out without hiding the road under it.
 */
const WIDTH_M = 1.4;
/** Height above the road, metres. Above the kerbs and the painted lines. */
const Y_OFFSET = 0.05;

/**
 * Fraction of the car's real braking capability the longitudinal test credits.
 *
 * Deliberately below what the car can actually do. The line should turn red
 * slightly before the last possible moment — a warning that arrives exactly at
 * the limit arrives too late to act on.
 *
 * This replaces a flat 38 m/s². That constant was very nearly four g, which the
 * car can only reach above about 250 km/h where the wings are loading the
 * tyres; below that the honest figure is closer to eighteen. So the old line
 * promised, at every speed a corner is actually taken at, roughly twice the
 * braking the car had — and a promise of twice the braking is a promise that a
 * corner is still reachable when it is already gone. `TrackSpline.brakingDecel`
 * gives the real, speed-dependent number from the same constants the speed
 * profile itself was solved with.
 */
const BRAKE_CONFIDENCE = 0.88;

/**
 * How far ahead the lateral test looks, in SECONDS of travel.
 *
 * Seconds rather than metres because the question it asks is about committing
 * to a piece of road, and how much road that is depends entirely on speed. At
 * 90 km/h through a chicane, 1.9 s is 47 metres; down the Kemmel straight it is
 * 170. Both are "the corner I am about to turn into".
 *
 * Metres would be wrong at one end or the other, and the wrong one is
 * expensive: a fixed horizon long enough to be useful at speed would, at a
 * hairpin, be reporting the grip limit of a corner two corners away, and the
 * line would sit red permanently. A permanently red line is ignored, which
 * makes it exactly as useful as a permanently green one.
 */
const LATERAL_HORIZON_S = 1.9;

/** Slowest speed the lateral horizon is evaluated at, m/s — keeps it sane in the pits. */
const LATERAL_MIN_SPEED = 12;

export class RacingLine {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly positions: Float32Array;
  private readonly colours: Float32Array;
  /** Per-segment braking urgency, before the backward maximum is applied. */
  private readonly ratio: Float32Array;
  private readonly segments: number;
  private readonly track: TrackSpline;
  /** Metres between drawn segments. */
  private readonly stepM: number;

  private _visible = true;

  constructor(track: TrackSpline) {
    this.track = track;
    // Coarser segments than the 4m original: at 900m of lookahead that would
    // be 230 quads rebuilt every frame for detail far finer than the eye can
    // resolve at distance. 8m keeps the colour gradient smooth and halves the
    // per-frame vertex writes.
    this.stepM = 8;
    this.segments = Math.ceil((LOOKAHEAD_M + LOOKBEHIND_M) / this.stepM);

    // Two triangles per segment, six vertices, never reallocated.
    const verts = this.segments * 6;
    this.positions = new Float32Array(verts * 3);
    this.colours = new Float32Array(verts * 3);
    this.ratio = new Float32Array(this.segments);

    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colours, 3);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    // The ribbon moves with the car every frame, so a bounding sphere would be
    // stale the moment it was computed. Culling is off; it is one draw call.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      // Coplanar with the asphalt; without an offset this z-fights into a
      // shimmering line at any distance.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      // Unlit on purpose. A driving aid must read identically at Monaco at
      // night and at Silverstone at noon; shading it would make it vanish in
      // shadow exactly where the braking points are.
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.matrixAutoUpdate = false;
  }

  get visible(): boolean {
    return this._visible;
  }

  setVisible(on: boolean): void {
    this._visible = on;
    this.mesh.visible = on;
  }

  /**
   * Rebuilds the visible window of the line.
   *
   * @param s       the car's distance along the lap, metres
   * @param speedMs the car's current speed
   */
  update(s: number, speedMs: number): void {
    if (!this._visible) return;

    const track = this.track;
    const len = track.length;
    let v = 0;
    let c = 0;

    // The lateral half-width of the ribbon, in track-normal terms.
    const half = WIDTH_M * 0.5;

    const horizon = Math.max(speedMs, LATERAL_MIN_SPEED) * LATERAL_HORIZON_S;

    // The best-case speed the car could have at the segment being considered,
    // integrated forward as the loop walks up the road.
    //
    // Integrated, not evaluated once, and that is a correction rather than a
    // refinement. Deceleration is strongly speed-dependent — the wings are
    // worth about 5g at 320 km/h and nothing at all at 60 — so taking the
    // figure at the car's CURRENT speed and applying it across the whole
    // braking zone overstates the average by something like two thirds. Measured
    // against the follow-the-green probe, that one shortcut was the difference
    // between a driver arriving at 130% of the available grip and arriving
    // inside it: the display was promising a stopping distance a bit over half
    // the real one, and therefore staying green through the point where the
    // corner was still saveable.
    let vBrake = speedMs;
    let integrated = 0;

    for (let i = 0; i < this.segments; i++) {
      const dA = -LOOKBEHIND_M + i * this.stepM;
      const dB = dA + this.stepM;

      const sA = wrap(s + dA, len);
      const sB = wrap(s + dB, len);
      const iA = track.indexAt(sA);
      const iB = track.indexAt(sB);

      // Points on the solved racing line, not the centreline.
      const offA = track.lineOffset[iA];
      const offB = track.lineOffset[iB];
      const ax = track.px[iA] + track.nx[iA] * offA;
      const az = track.pz[iA] + track.nz[iA] * offA;
      const bx = track.px[iB] + track.nx[iB] * offB;
      const bz = track.pz[iB] + track.nz[iB] * offB;
      const ay = track.elevation[iA] + Y_OFFSET;
      const by = track.elevation[iB] + Y_OFFSET;

      // Widen along the track normal.
      const anx = track.nx[iA] * half;
      const anz = track.nz[iA] * half;
      const bnx = track.nx[iB] * half;
      const bnz = track.nz[iB] * half;

      const p = v * 3;
      const px = this.positions;
      px[p +  0] = ax + anx; px[p +  1] = ay; px[p +  2] = az + anz;
      px[p +  3] = ax - anx; px[p +  4] = ay; px[p +  5] = az - anz;
      px[p +  6] = bx - bnx; px[p +  7] = by; px[p +  8] = bz - bnz;
      px[p +  9] = ax + anx; px[p + 10] = ay; px[p + 11] = az + anz;
      px[p + 12] = bx - bnx; px[p + 13] = by; px[p + 14] = bz - bnz;
      px[p + 15] = bx + bnx; px[p + 16] = by; px[p + 17] = bz + bnz;

      // --- 1. Longitudinal: can the car still slow down enough? -------------
      // The distance available to shed speed before reaching it.
      const ahead = Math.max(dB, 0);
      // The lower of the solved profile and the raw grip limit.
      //
      // They disagree, by up to 22% at Monaco's tightest apexes, because the
      // solver box-filters the finished profile and a filter run over a sharp
      // minimum lifts the bottom of it. That is a defensible thing to do to a
      // reference line the AI follows — it smooths one node's worth of
      // discretisation noise out of a lap time — but it is not a speed the
      // tyres will hold, and this display must not promise a speed the tyres
      // will not hold. Taking the minimum costs nothing anywhere else on the
      // lap, where the profile is far below the grip limit anyway.
      const target = Math.min(track.targetSpeed[iB], track.corneringSpeed[iB]);

      // Brake flat out from here to there, and see what speed that leaves.
      // One step per segment: `ahead` grows by exactly `stepM` each time round
      // once it is past the car.
      while (integrated < ahead) {
        const h = Math.min(this.stepM, ahead - integrated);
        const a = track.brakingDecel(vBrake) * BRAKE_CONFIDENCE;
        const sq = vBrake * vBrake - 2 * a * h;
        vBrake = sq > 1 ? Math.sqrt(sq) : 1;
        integrated += h;
      }

      // Below 1, the car is inside its budget for this point. Above 1, it is
      // arriving too fast even under maximum braking. Stored rather than
      // coloured immediately — see the backward pass below, which is what makes
      // the warning arrive in time.
      let ratio = vBrake / Math.max(target, 1);

      // --- 2. Lateral: at this speed, on this radius, will the tyres hold? ---
      //
      // No braking credit whatsoever. That is the entire difference between the
      // two tests, and it is why this one catches the case the other cannot:
      // the driver who does not brake, because the line was green.
      //
      // Only within the horizon — beyond it the car has time to do something
      // about the corner, and test 1 is the one that says so.
      if (ahead <= horizon) {
        const grip = track.corneringSpeed[iB];
        const lateral = speedMs / Math.max(grip, 1);
        if (lateral > ratio) ratio = lateral;
      }

      this.ratio[i] = ratio;

      v += 6;
      c += 6;
    }

    // --- Propagate urgency backwards --------------------------------------
    //
    // Each segment now takes the WORST ratio of itself and everything beyond
    // it, so a corner the car cannot make lights up the road in front of the
    // car, not the corner itself.
    //
    // Colouring each segment by its own reachability — which is what this did
    // before — is subtly useless. A corner 400m away has 400m of braking
    // distance available, so it scores green no matter how fast the car is
    // going; it only turns red once it is close enough that its own braking
    // distance has run out. By then the driver is already too late, which is
    // exactly the complaint: green all the way up to the turn, red at the
    // apex. Taking the running maximum from the far end backwards means the
    // tarmac immediately ahead reports the most urgent thing anywhere in the
    // lookahead — which is the question a driver is actually asking.
    // Seeded with the load the car is under RIGHT NOW, not with zero.
    //
    // Without the seed the ribbon can be green while the car is already sliding.
    // The colour a driver reads is the tarmac a few metres ahead, and the
    // backward maximum only carries urgency from further up the road — so a car
    // accelerating out of Monaco's hairpin at 140% of the grip available under
    // its own tyres was shown green, because ten metres ahead the corner opens
    // out and everything beyond that is fine. It was being told about a future
    // it was not going to reach.
    //
    // The ribbon must never be greener than the situation the car is in.
    const here = this.track.indexAt(wrap(s, len));
    let worst = speedMs / Math.max(this.track.corneringSpeed[here], 1);
    for (let i = this.segments - 1; i >= 0; i--) {
      if (this.ratio[i] > worst) worst = this.ratio[i];
      else this.ratio[i] = worst;
    }

    // --- Write the colours -------------------------------------------------
    const cl = this.colours;
    for (let i = 0; i < this.segments; i++) {
      const rgb = colourFor(this.ratio[i]);
      const cc = i * 6 * 3;
      for (let k = 0; k < 6; k++) {
        const o = cc + k * 3;
        cl[o] = rgb[0]; cl[o + 1] = rgb[1]; cl[o + 2] = rgb[2];
      }
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, c);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Green through amber to red as the car moves from comfortably within the
 * limit to arriving too fast.
 *
 * Interpolated through two stops rather than switched between three colours,
 * so the line shades continuously as a braking zone approaches instead of
 * flicking between states — a step change reads as a glitch and gives no sense
 * of how much margin is left.
 */
function colourFor(ratio: number): [number, number, number] {
  // Everything below 0.78 is comfortably fine and stays fully green, so the
  // line is not permanently amber on a straight.
  //
  // The band is deliberately WIDE (0.78 to 1.02). A narrow band snaps from
  // green to red almost instantly, which tells the driver they are already too
  // late; a wide one shades gradually through amber as a braking zone
  // approaches, so the colour communicates how much margin is left rather than
  // just whether it has run out.
  const t = clamp01((ratio - 0.78) / 0.24);
  if (t < 0.5) {
    // Green to amber.
    const k = t * 2;
    return [0.15 + 0.85 * k, 0.95 - 0.20 * k, 0.25 - 0.22 * k];
  }
  // Amber to red.
  const k = (t - 0.5) * 2;
  return [1.0, 0.75 - 0.70 * k, 0.03];
}

/** Wraps a distance into [0, len). */
function wrap(x: number, len: number): number {
  let v = x % len;
  if (v < 0) v += len;
  return v;
}
