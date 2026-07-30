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

/** Metres of line drawn ahead of the car. */
const LOOKAHEAD_M = 320;
/** Metres behind, so the ribbon does not start abruptly under the nose. */
const LOOKBEHIND_M = 25;
/** Ribbon width, metres. */
const WIDTH_M = 0.55;
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
  private readonly segments: number;
  private readonly track: TrackSpline;
  /** Metres between drawn segments. */
  private readonly stepM: number;

  private _visible = true;

  constructor(track: TrackSpline) {
    this.track = track;
    this.stepM = 4;
    this.segments = Math.ceil((LOOKAHEAD_M + LOOKBEHIND_M) / this.stepM);

    // Two triangles per segment, six vertices, never reallocated.
    const verts = this.segments * 6;
    this.positions = new Float32Array(verts * 3);
    this.colours = new Float32Array(verts * 3);

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
      opacity: 0.78,
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

      // --- Colour ---------------------------------------------------------
      // The distance available to shed speed before reaching this segment.
      const ahead = Math.max(dB, 0);
      const target = track.targetSpeed[iB];

      // Highest speed the car could be doing NOW and still be down to `target`
      // by the time it arrives, given a realistic rate of deceleration:
      //   v_max^2 = target^2 + 2 * a * distance
      const reachable = Math.sqrt(target * target + 2 * BRAKE_DECEL * ahead);

      // Below 1, the car is inside its budget. Above 1, it is arriving too fast.
      const ratio = speedMs / Math.max(reachable, 1);
      const rgb = colourFor(ratio);

      const cc = v * 3;
      const cl = this.colours;
      for (let k = 0; k < 6; k++) {
        const o = cc + k * 3;
        cl[o] = rgb[0]; cl[o + 1] = rgb[1]; cl[o + 2] = rgb[2];
      }

      v += 6;
      c += 6;
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
  // Everything below 0.82 is comfortably fine and stays fully green, so the
  // line is not permanently amber on a straight.
  const t = clamp01((ratio - 0.82) / 0.28);
  if (t < 0.5) {
    // Green to amber.
    const k = t * 2;
    return [0.11 + 0.85 * k, 0.82 - 0.12 * k, 0.20 - 0.16 * k];
  }
  // Amber to red.
  const k = (t - 0.5) * 2;
  return [0.96, 0.70 - 0.62 * k, 0.04];
}

/** Wraps a distance into [0, len). */
function wrap(x: number, len: number): number {
  let v = x % len;
  if (v < 0) v += len;
  return v;
}
