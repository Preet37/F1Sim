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
 * that?* Each segment ahead compares the car's speed now against the target
 * speed there, allowing for how much road is left to brake in:
 *
 *   green   — comfortably within the limit for that point
 *   yellow  — close to it; a lift would settle the car
 *   red     — arriving faster than the corner will take. Brake.
 *
 * That is why the line ahead flushes red as a braking zone approaches and falls
 * back through yellow to green as the car slows: it is a live readout of
 * whether the car is inside its own future grip budget, not a fixed
 * decoration painted on the road.
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
 * Deceleration used to judge whether a corner is still reachable, m/s².
 *
 * Deliberately below what the car can actually do under full braking. The line
 * should turn red slightly before the last possible moment — a warning that
 * arrives exactly at the limit arrives too late to act on.
 */
const BRAKE_DECEL = 38;

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

      // --- Braking urgency for this segment ---------------------------------
      // The distance available to shed speed before reaching it.
      const ahead = Math.max(dB, 0);
      const target = track.targetSpeed[iB];

      // Highest speed the car could be doing NOW and still be down to `target`
      // by the time it arrives:  v_max^2 = target^2 + 2 * a * distance
      const reachable = Math.sqrt(target * target + 2 * BRAKE_DECEL * ahead);

      // Below 1, the car is inside its budget for this point. Above 1, it is
      // arriving too fast. Stored rather than coloured immediately — see the
      // backward pass below, which is what makes the warning arrive in time.
      this.ratio[i] = speedMs / Math.max(reachable, 1);

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
    let worst = 0;
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
