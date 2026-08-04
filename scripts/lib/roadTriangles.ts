import * as THREE from 'three';

/**
 * Height difference below which two hits are the same piece of asphalt.
 *
 * A millimetre. The road is drawn as triangles and a point on the edge two of
 * them share is inside both, which is not two surfaces.
 */
const COINCIDENT_M = 0.001;

/**
 * THE DRAWN ROAD TRIANGLES, INDEXED SO A DENSE SWEEP IS AFFORDABLE.
 *
 * `THREE.Raycaster` tests every triangle of a mesh for every ray, which is
 * minutes per circuit once a probe wants tens of thousands of samples. This is
 * an INDEX over the same triangles the raycaster would have walked — read
 * straight out of the built geometry's position attribute, through the mesh's
 * own world matrix — and not a second model of the road. Nothing here knows
 * how the road is swept; it only knows what triangles came out.
 *
 * Its answers are cross-checked against `THREE.Raycaster` on a thinned subset
 * by every caller, so a bug in the acceleration structure cannot quietly
 * report a flat road.
 */
export class RoadTriangles {
  private readonly cells = new Map<number, number[]>();
  private readonly tri: Float64Array;
  private readonly cell: number;

  constructor(mesh: THREE.Mesh, cellM = 8) {
    this.cell = cellM;
    mesh.updateMatrixWorld(true);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const index = geo.getIndex();
    const n = index ? index.count : pos.count;
    const tri = new Float64Array((n / 3) * 9);
    const p = new THREE.Vector3();
    for (let t = 0; t < n / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        p.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        tri[t * 9 + k * 3] = p.x;
        tri[t * 9 + k * 3 + 1] = p.y;
        tri[t * 9 + k * 3 + 2] = p.z;
      }
      const x0 = Math.min(tri[t * 9], tri[t * 9 + 3], tri[t * 9 + 6]);
      const x1 = Math.max(tri[t * 9], tri[t * 9 + 3], tri[t * 9 + 6]);
      const z0 = Math.min(tri[t * 9 + 2], tri[t * 9 + 5], tri[t * 9 + 8]);
      const z1 = Math.max(tri[t * 9 + 2], tri[t * 9 + 5], tri[t * 9 + 8]);
      for (let cx = Math.floor(x0 / cellM); cx <= Math.floor(x1 / cellM); cx++) {
        for (let cz = Math.floor(z0 / cellM); cz <= Math.floor(z1 / cellM); cz++) {
          const key = cx * 73856093 ^ cz * 19349663;
          let bucket = this.cells.get(key);
          if (!bucket) { bucket = []; this.cells.set(key, bucket); }
          bucket.push(t);
        }
      }
    }
    this.tri = tri;
  }

  /**
   * Every distinct surface height directly above or below (x, z), unsorted.
   *
   * A vertical line, not a ray — the caller decides which hit is the piece of
   * road it meant, exactly as section 1 does. Heights within `COINCIDENT_M`
   * are folded, because a point on the edge two triangles share is inside
   * both and that is one surface rather than two.
   */
  heightsAt(x: number, z: number, out: number[]): number[] {
    out.length = 0;
    const key = Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
    const bucket = this.cells.get(key);
    if (!bucket) return out;
    const t = this.tri;
    for (const idx of bucket) {
      const o = idx * 9;
      const ax = t[o], ay = t[o + 1], az = t[o + 2];
      const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
      const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
      // Barycentric containment in the XZ projection. A degenerate triangle —
      // and a fold at a hairpin apex produces them — has zero area and is
      // skipped rather than dividing by it.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      const y = l0 * ay + l1 * by + l2 * cy;
      if (out.some((v) => Math.abs(v - y) <= COINCIDENT_M)) continue;
      out.push(y);
    }
    return out;
  }
}

