import * as THREE from 'three';

/**
 * Rubber laid on the road: lock-ups, wheelspin and the black lines out of a
 * slow corner where twenty cars have all been on the throttle too early.
 *
 * Marks are welded into one preallocated, non-indexed triangle ribbon and
 * drawn in a single call. They are never rebuilt — a quad is stamped into the
 * ring when a tyre slips and left alone afterwards, so a full race's worth of
 * rubber costs nothing per frame beyond the rasterisation.
 *
 * The ring means memory is fixed and the oldest marks are eventually recycled.
 * That is the correct trade: a session-long unbounded buffer is a slow leak
 * that ends in a stall, and by the time the ring wraps the earliest marks are
 * several laps old and nobody is looking at them.
 *
 * These are visual only. The physics does not model a rubbered-in racing line,
 * so the marks make no claim to change grip — they record what already
 * happened rather than pretending to affect what happens next.
 */

/** Quads in the ring. One quad is roughly 0.4m of one tyre's trail. */
const CAPACITY = 3600;
const VERTS_PER_QUAD = 6;
/** Only lay a new quad once the tyre has moved this far. */
const MIN_SEGMENT_M = 0.28;
/** Marks sit this far above the road to clear the white lines. */
const Y_OFFSET = 0.028;

/** Per-tyre continuation state: where the last quad ended. */
interface Trail {
  active: boolean;
  x: number;
  z: number;
  /** Left and right edge offsets of the previous quad, so quads share an edge. */
  lx: number;
  lz: number;
  rx: number;
  rz: number;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly positions: Float32Array;
  private readonly colours: Float32Array;
  private readonly trails: Trail[] = [];

  private cursor = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -Infinity;
  private live = 0;

  constructor(tyreCount: number, quality: 'low' | 'high') {
    const capacity = quality === 'high' ? CAPACITY : Math.round(CAPACITY * 0.45);
    this.positions = new Float32Array(capacity * VERTS_PER_QUAD * 3);
    this.colours = new Float32Array(capacity * VERTS_PER_QUAD * 4);

    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colours, 4);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    geo.setDrawRange(0, 0);
    // Marks are scattered over the whole circuit, so a bounding sphere that
    // grows with them would never cull anything useful. Skip the bookkeeping.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Coplanar with the asphalt, so without a depth offset this z-fights into
      // a shimmering mess at any distance.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.matrixAutoUpdate = false;

    for (let i = 0; i < tyreCount; i++) {
      this.trails.push({ active: false, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0 });
    }

    this.capacity = capacity;
  }

  private readonly capacity: number;

  /**
   * Reports a tyre's contact patch for this frame.
   *
   * @param id      stable per-tyre index
   * @param x,z     contact point in world space
   * @param nx,nz   unit vector across the tyre, for the mark's width
   * @param width   contact patch width, metres
   * @param opacity 0 lifts the pen off the paper; above 0 lays rubber
   * @param y       road height at this point
   */
  report(
    id: number,
    x: number, z: number,
    nx: number, nz: number,
    width: number,
    opacity: number,
    y: number,
  ): void {
    const t = this.trails[id];
    if (!t) return;

    if (opacity <= 0.02) {
      // Lift the pen. The next contact starts a fresh trail rather than drawing
      // a long quad across the gap — otherwise a car that stops sliding, drives
      // half a straight and slides again leaves a stripe down the straight.
      t.active = false;
      return;
    }

    const hw = width * 0.5;
    const lx = x + nx * hw;
    const lz = z + nz * hw;
    const rx = x - nx * hw;
    const rz = z - nz * hw;

    if (!t.active) {
      t.active = true;
      t.x = x; t.z = z;
      t.lx = lx; t.lz = lz; t.rx = rx; t.rz = rz;
      return;
    }

    const dx = x - t.x;
    const dz = z - t.z;
    if (dx * dx + dz * dz < MIN_SEGMENT_M * MIN_SEGMENT_M) return;

    this.pushQuad(t.lx, t.lz, t.rx, t.rz, lx, lz, rx, rz, y, opacity);

    t.x = x; t.z = z;
    t.lx = lx; t.lz = lz; t.rx = rx; t.rz = rz;
  }

  /** Writes one quad, sharing its leading edge with the previous quad. */
  private pushQuad(
    alx: number, alz: number, arx: number, arz: number,
    blx: number, blz: number, brx: number, brz: number,
    y: number, opacity: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.live < this.capacity) this.live++;

    const p = i * VERTS_PER_QUAD * 3;
    const c = i * VERTS_PER_QUAD * 4;
    const yy = y + Y_OFFSET;

    // Two triangles: (aL, aR, bR) and (aL, bR, bL). Double-sided material, so
    // winding does not matter, which saves worrying about it on banked corners.
    const px = this.positions;
    px[p +  0] = alx; px[p +  1] = yy; px[p +  2] = alz;
    px[p +  3] = arx; px[p +  4] = yy; px[p +  5] = arz;
    px[p +  6] = brx; px[p +  7] = yy; px[p +  8] = brz;
    px[p +  9] = alx; px[p + 10] = yy; px[p + 11] = alz;
    px[p + 12] = brx; px[p + 13] = yy; px[p + 14] = brz;
    px[p + 15] = blx; px[p + 16] = yy; px[p + 17] = blz;

    // Fresh rubber is nearly black; a light scuff is a grey smear. Alpha does
    // the work so the mark tints the asphalt underneath rather than painting
    // over it, which is what keeps it looking like rubber and not paint.
    const a = Math.min(opacity, 1) * 0.72;
    const shade = 0.05;
    const cl = this.colours;
    for (let v = 0; v < VERTS_PER_QUAD; v++) {
      const o = c + v * 4;
      cl[o] = shade; cl[o + 1] = shade; cl[o + 2] = shade * 1.05; cl[o + 3] = a;
    }

    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  /** Uploads the quads written this frame. */
  flush(): void {
    this.geometry.setDrawRange(0, this.live * VERTS_PER_QUAD);
    if (this.dirtyMax < this.dirtyMin) return;

    const start = this.dirtyMin * VERTS_PER_QUAD;
    const count = (this.dirtyMax - this.dirtyMin + 1) * VERTS_PER_QUAD;
    for (const name of ['position', 'color']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  clear(): void {
    this.cursor = 0;
    this.live = 0;
    this.geometry.setDrawRange(0, 0);
    for (const t of this.trails) t.active = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
