import { installCanvasStub } from './lib/domStub';

installCanvasStub();

import * as THREE from 'three';
import {
  carPartsForProbe, frontCornerForProbe, frontMembers, rearMembers, TYRE_RADIUS_M,
  type CarPart, type CarTier, type SuspensionMember,
} from '../src/render/CarMesh';
import { ROAD_SURFACE_Y, carGroundY } from '../src/render/TrackMesh';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';

/**
 * Whether the car is ONE OBJECT, measured rather than looked at.
 *
 * WHY THIS EXISTS. Every complaint the car has ever drawn about its assembly —
 * "the pipes that are supposed to be attached to the front wing are just
 * flying", a black slab hovering over the rear tyre, a halo reading as a ring
 * above the airbox with no legs under it, wheels sunk into the road — is the
 * same class of defect: a part that is in the right SHAPE and the wrong PLACE,
 * by a few centimetres. Every one of them was previously judged from a
 * screenshot, in words, which is why each has been "fixed" more than once.
 *
 * A part that does not touch the car is not a matter of taste. It has a
 * distance, in millimetres, and this measures it.
 *
 * WHAT IS MEASURED
 *
 *  1. CONTACT PATCH. The lowest vertex of each wheel, in the car's own frame,
 *     must be at y = 0 — and the renderer must then stand that frame on the
 *     DRAWN asphalt, which is `ROAD_SURFACE_Y` above the elevation the
 *     simulation uses. Those are two different numbers and the gap between
 *     them is exactly how far the tyres were buried.
 *
 *  2. SUSPENSION ENDPOINTS. Every member of every corner, from the same
 *     `frontMembers` / `rearMembers` tables the mesh is extruded along, must
 *     have BOTH of its ends inside another part: the inboard end on the
 *     chassis, the outboard end on the upright or the wheel. An end that is in
 *     mid-air is reported with the distance to whatever it came closest to.
 *
 *  3. DISJOINT PARTS. Everything the car is made of, treated as a graph:
 *     two parts are joined if any point of one lies within `JOIN_TOL` of a
 *     surface of the other. The car has to come out as ONE connected cluster.
 *     Anything else is a floating part, and it is named and measured — that is
 *     the check that found the slab over the rear tyre.
 *
 * The parts come from `carPartsForProbe`, which runs the real `buildShellParts`
 * and hands back the pieces BEFORE they are merged into the dozen meshes the
 * renderer draws. Reading the merged buffer instead would be measuring a
 * vertex soup: correct, and unable to name anything.
 *
 * TOLERANCE. 10mm. Parts of a car are authored to overlap — a strut ends
 * INSIDE the tub it is bolted to, a wing element buries its tip in the
 * endplate — so genuine joints measure zero and only a real gap is a positive
 * number. 10mm is a millimetre less than the thinnest slot gap on the car, so
 * nothing can pass this check by being fat.
 */

/** A part is joined to another if it comes within this of it, metres. */
const JOIN_TOL = 0.010;

/**
 * How far a suspension member's end may sit from the part it mounts to.
 *
 * Wider than `JOIN_TOL` because the endpoint is the member's CENTRELINE, not
 * its skin: a leg 78mm across meets a tub whose surface is curved, and the
 * centreline can legitimately stop a few millimetres outside the skin it is
 * bolted through. 25mm is a third of a leg's chord — anything more is a member
 * that ends in air, which is what the reference frames of this car show.
 */
const JOINT_TOL = 0.025;

/** The contact patch may sit this far off the road before it is a defect. */
const CONTACT_TOL = 0.0015;

/**
 * Front wing limits, from the technical regulations quoted in `CarMesh`.
 *
 * SLOT GAP is the one that was reported: "slot gaps that do not read at
 * distance". The regulations put it between 5 and 15mm, so the answer to
 * illegibility is not a bigger gap — 15mm is the ceiling and the wing was
 * already near it — but an OPEN one. A slot 14mm tall that the next element
 * overhangs by half its chord is a slot no camera in front of the car can see
 * into, and that is what the assembly was: four blades stacked with 25 to 46
 * per cent of plan overlap, reading as one rolled slab.
 *
 * So both are measured. `SLOT_MIN/MAX` is the physical gap. `SEE_THROUGH` is
 * the fraction of the span at which a straight line runs from the middle of the
 * slot to the camera without touching the car — daylight, in other words, which
 * is the thing the eye actually reads a multi-element wing by.
 */
const SLOT_MIN = 0.005;
const SLOT_MAX = 0.015;
const SEE_THROUGH_MIN = 0.6;
/** Front overhang: nothing may sit more than 1350mm ahead of the front axle. */
const FRONT_OVERHANG_Z = 3.15;

const TIERS: CarTier[] = ['high', 'low'];

interface Prepared {
  part: CarPart;
  /** World-space (car-local) triangle vertices, flat. */
  tri: Float32Array;
  /** Query points: every vertex, plus each triangle's centroid. */
  probe: Float32Array;
  box: THREE.Box3;
}

function prepare(part: CarPart): Prepared {
  const g = part.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const index = g.index;
  const off = part.offset ?? new THREE.Vector3();
  const n = index ? index.count : pos.count;
  const tri = new Float32Array(n * 3);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const j = index ? index.getX(i) : i;
    v.set(pos.getX(j), pos.getY(j), pos.getZ(j)).add(off);
    tri[i * 3] = v.x; tri[i * 3 + 1] = v.y; tri[i * 3 + 2] = v.z;
    box.expandByPoint(v);
  }
  // Query points: the corners, plus a centroid per face so a big flat panel —
  // the mirror pane is two triangles — cannot slip between samples.
  const faces = Math.floor(n / 3);
  const probe = new Float32Array((n + faces) * 3);
  probe.set(tri.subarray(0, n * 3), 0);
  for (let f = 0; f < faces; f++) {
    const o = f * 9;
    const q = (n + f) * 3;
    probe[q] = (tri[o] + tri[o + 3] + tri[o + 6]) / 3;
    probe[q + 1] = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
    probe[q + 2] = (tri[o + 2] + tri[o + 5] + tri[o + 8]) / 3;
  }
  return { part, tri, probe, box };
}

/** Squared distance from a point to a triangle. The standard region test. */
function pointTriSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3);
          qx = ax + abx * t; qy = ay + aby * t; qz = az + abz * t;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            qx = ax + acx * t; qy = ay + acy * t; qz = az + acz * t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * t; qy = by + (cy - by) * t; qz = bz + (cz - bz) * t;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w;
              qy = ay + aby * v + acy * w;
              qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * A uniform grid over every triangle on the car, so a nearest-surface query is
 * a handful of cells rather than a sweep over sixty thousand faces.
 */
class TriGrid {
  private readonly cell: number;
  private readonly bins = new Map<number, number[]>();
  /** Triangle f belongs to part `owner[f]`. */
  readonly owner: Int32Array;
  private readonly tri: Float32Array;

  constructor(prepared: readonly Prepared[], cell: number) {
    this.cell = cell;
    let faces = 0;
    for (const p of prepared) faces += p.tri.length / 9;
    this.tri = new Float32Array(faces * 9);
    this.owner = new Int32Array(faces);
    let f = 0;
    for (let pi = 0; pi < prepared.length; pi++) {
      const t = prepared[pi].tri;
      for (let o = 0; o < t.length; o += 9, f++) {
        this.tri.set(t.subarray(o, o + 9), f * 9);
        this.owner[f] = pi;
      }
    }
    for (let i = 0; i < faces; i++) this.insert(i);
  }

  private key(ix: number, iy: number, iz: number): number {
    // A cheap 3D hash. The grid is a few thousand cells; collisions only cost
    // a longer candidate list, never a wrong answer, because every candidate
    // is distance-tested anyway.
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  }

  private insert(f: number): void {
    const o = f * 9;
    const t = this.tri;
    const c = this.cell;
    const x0 = Math.floor(Math.min(t[o], t[o + 3], t[o + 6]) / c);
    const x1 = Math.floor(Math.max(t[o], t[o + 3], t[o + 6]) / c);
    const y0 = Math.floor(Math.min(t[o + 1], t[o + 4], t[o + 7]) / c);
    const y1 = Math.floor(Math.max(t[o + 1], t[o + 4], t[o + 7]) / c);
    const z0 = Math.floor(Math.min(t[o + 2], t[o + 5], t[o + 8]) / c);
    const z1 = Math.floor(Math.max(t[o + 2], t[o + 5], t[o + 8]) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = this.key(ix, iy, iz);
          const b = this.bins.get(k);
          if (b) b.push(f); else this.bins.set(k, [f]);
        }
      }
    }
  }

  /**
   * Whether the straight line from `p` to `q` touches anything.
   *
   * Brute force over every triangle on the car, because the whole probe casts a
   * few dozen of these and a grid walk along a segment is more code than it
   * saves. `skip` drops the two elements the slot is between: a ray leaving the
   * middle of a slot starts flush with both of their surfaces and would
   * otherwise report itself blocked by the thing it is measuring.
   */
  clearLine(
    px: number, py: number, pz: number, qx: number, qy: number, qz: number,
    skip: (part: number) => boolean,
  ): boolean {
    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const t = this.tri;
    for (let f = 0; f < this.owner.length; f++) {
      if (skip(this.owner[f])) continue;
      const o = f * 9;
      // Moller-Trumbore.
      const e1x = t[o + 3] - t[o], e1y = t[o + 4] - t[o + 1], e1z = t[o + 5] - t[o + 2];
      const e2x = t[o + 6] - t[o], e2y = t[o + 7] - t[o + 1], e2z = t[o + 8] - t[o + 2];
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      const a = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(a) < 1e-12) continue;
      const inv = 1 / a;
      const sx = px - t[o], sy = py - t[o + 1], sz = pz - t[o + 2];
      const u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qqx = sy * e1z - sz * e1y, qqy = sz * e1x - sx * e1z, qqz = sx * e1y - sy * e1x;
      const v = (dx * qqx + dy * qqy + dz * qqz) * inv;
      if (v < 0 || u + v > 1) continue;
      const s = (e2x * qqx + e2y * qqy + e2z * qqz) * inv;
      // 1e-4 off each end so a surface the ray starts or lands on is not a hit.
      if (s > 1e-4 && s < 1 - 1e-4) return false;
    }
    return true;
  }

  /**
   * Nearest surface to a point, ignoring parts in `skip`.
   *
   * Returns the part index and the distance, or a distance of Infinity if
   * nothing at all lies within `reach`.
   */
  nearest(px: number, py: number, pz: number, reach: number, skip: (part: number) => boolean): { part: number; dist: number } {
    const c = this.cell;
    const r = Math.ceil(reach / c);
    const cx = Math.floor(px / c), cy = Math.floor(py / c), cz = Math.floor(pz / c);
    let bestSq = reach * reach;
    let best = -1;
    const t = this.tri;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          const b = this.bins.get(this.key(ix, iy, iz));
          if (!b) continue;
          for (const f of b) {
            const owner = this.owner[f];
            if (skip(owner)) continue;
            const o = f * 9;
            const d = pointTriSq(
              px, py, pz,
              t[o], t[o + 1], t[o + 2],
              t[o + 3], t[o + 4], t[o + 5],
              t[o + 6], t[o + 7], t[o + 8],
            );
            if (d < bestSq) { bestSq = d; best = owner; }
          }
        }
      }
    }
    return { part: best, dist: best < 0 ? Infinity : Math.sqrt(bestSq) };
  }
}

/**
 * Whether a point is INSIDE a part, by ray parity along +x.
 *
 * A suspension leg that ends 40mm inside the survival cell is bolted through
 * it, which is how a real one is made and what every reference photograph
 * shows; a leg that ends 40mm outside it is the defect. An unsigned
 * distance-to-surface cannot tell those two apart, and the first version of
 * this probe therefore had to be answered with "move the pickup until the
 * number goes down", which is how a pickup ends up sitting exactly on a skin
 * and popping out of it the moment the loft is resampled.
 *
 * The parts are closed lofts, so parity is exact for them. It is meaningless
 * for the open ones — a wing element is a closed tube, a plane is not — and
 * that is fine: an open part reports "outside" everywhere, which is the
 * conservative answer.
 */
function insideAny(prepared: readonly Prepared[], px: number, py: number, pz: number, skip: number): number {
  for (let pi = 0; pi < prepared.length; pi++) {
    if (pi === skip) continue;
    const p = prepared[pi];
    if (px < p.box.min.x - 1e-6 || px > p.box.max.x + 1e-6) continue;
    if (py < p.box.min.y || py > p.box.max.y || pz < p.box.min.z || pz > p.box.max.z) continue;
    const t = p.tri;
    let crossings = 0;
    for (let o = 0; o < t.length; o += 9) {
      // Ray along +x from (px, py, pz): solve in the (y, z) plane first.
      const y0 = t[o + 1], z0 = t[o + 2];
      const y1 = t[o + 4], z1 = t[o + 5];
      const y2 = t[o + 7], z2 = t[o + 8];
      const d = (z1 - z2) * (y0 - y2) + (y2 - y1) * (z0 - z2);
      if (Math.abs(d) < 1e-12) continue;
      const a = ((z1 - z2) * (py - y2) + (y2 - y1) * (pz - z2)) / d;
      if (a < 0 || a > 1) continue;
      const b = ((z2 - z0) * (py - y2) + (y0 - y2) * (pz - z2)) / d;
      if (b < 0 || a + b > 1) continue;
      const c = 1 - a - b;
      const hitX = a * t[o] + b * t[o + 3] + c * t[o + 6];
      if (hitX > px) crossings++;
    }
    if (crossings % 2 === 1) return pi;
  }
  return -1;
}

/**
 * One part as a SOLID, so the question "is this point inside it" is cheap.
 *
 * `insideAny` above answers the same question by sweeping every triangle of
 * every part, which is fine for the forty-eight suspension endpoints it was
 * written for and hopeless for the hundreds of thousands of queries the
 * bolted-joint and interpenetration sections make. This buckets each triangle
 * by the (y, z) cells its projection covers, so a +x parity ray only has to
 * look at the triangles that could possibly be in its way.
 *
 * Exact for the closed lofts the car is made of; an open surface reports
 * "outside" everywhere, which is the conservative answer and the same one
 * `insideAny` gives.
 */
const SOLID_CELL = 0.05;
class Solid {
  private readonly bins = new Map<number, number[]>();
  constructor(private readonly p: Prepared) {
    const t = p.tri;
    for (let o = 0, f = 0; o < t.length; o += 9, f++) {
      const y0 = Math.floor(Math.min(t[o + 1], t[o + 4], t[o + 7]) / SOLID_CELL);
      const y1 = Math.floor(Math.max(t[o + 1], t[o + 4], t[o + 7]) / SOLID_CELL);
      const z0 = Math.floor(Math.min(t[o + 2], t[o + 5], t[o + 8]) / SOLID_CELL);
      const z1 = Math.floor(Math.max(t[o + 2], t[o + 5], t[o + 8]) / SOLID_CELL);
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = (iy * 92837111) ^ (iz * 689287499);
          const b = this.bins.get(k);
          if (b) b.push(f); else this.bins.set(k, [f]);
        }
      }
    }
  }

  contains(px: number, py: number, pz: number): boolean {
    const b = this.p.box;
    if (px < b.min.x - 1e-6 || px > b.max.x + 1e-6) return false;
    if (py < b.min.y || py > b.max.y || pz < b.min.z || pz > b.max.z) return false;
    const key = (Math.floor(py / SOLID_CELL) * 92837111) ^ (Math.floor(pz / SOLID_CELL) * 689287499);
    const list = this.bins.get(key);
    if (!list) return false;
    const t = this.p.tri;
    let crossings = 0;
    for (const f of list) {
      const o = f * 9;
      const y0 = t[o + 1], z0 = t[o + 2];
      const y1 = t[o + 4], z1 = t[o + 5];
      const y2 = t[o + 7], z2 = t[o + 8];
      const d = (z1 - z2) * (y0 - y2) + (y2 - y1) * (z0 - z2);
      if (Math.abs(d) < 1e-12) continue;
      const a = ((z1 - z2) * (py - y2) + (y2 - y1) * (pz - z2)) / d;
      if (a < 0 || a > 1) continue;
      const bb = ((z2 - z0) * (py - y2) + (y0 - y2) * (pz - z2)) / d;
      if (bb < 0 || a + bb > 1) continue;
      const c = 1 - a - bb;
      const hitX = a * t[o] + bb * t[o + 3] + c * t[o + 6];
      if (hitX > px) crossings++;
    }
    return crossings % 2 === 1;
  }
}

class DisjointSet {
  private readonly up: number[];
  constructor(n: number) { this.up = Array.from({ length: n }, (_, i) => i); }
  find(a: number): number {
    let r = a;
    while (this.up[r] !== r) r = this.up[r];
    while (this.up[a] !== r) { const n = this.up[a]; this.up[a] = r; a = n; }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.up[rb] = ra;
  }
}

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.log(`  FAIL  ${msg}`);
}

function boxLabel(b: THREE.Box3): string {
  const f = (n: number) => (n >= 0 ? ' ' : '') + n.toFixed(3);
  return `x${f(b.min.x)}..${f(b.max.x)} y${f(b.min.y)}..${f(b.max.y)} z${f(b.min.z)}..${f(b.max.z)}`;
}

function run(tier: CarTier): void {
  console.log(`\n=== ${tier} tier ===`);
  const parts = carPartsForProbe(tier);
  const prepared = parts.map(prepare);
  const grid = new TriGrid(prepared, 0.06);

  // --- 1. contact patch ----------------------------------------------------
  console.log('\ncontact patch (car-local y of the lowest vertex on each wheel)');
  for (const p of prepared) {
    if (p.part.bucket !== 'wheel') continue;
    const y = p.box.min.y;
    const ok = Math.abs(y) <= CONTACT_TOL;
    console.log(`  ${p.part.name.padEnd(16)} ${(y * 1000).toFixed(1).padStart(7)}mm  ${ok ? 'on the road' : 'OFF THE ROAD'}`);
    if (!ok) fail(`${p.part.name} contact patch is ${(y * 1000).toFixed(1)}mm off the road`);
  }
  // Nothing on the car may reach BELOW the contact patch: the plank is the
  // lowest thing on a real car and it rides on the reference plane.
  let lowest = Infinity, lowestName = '';
  for (const p of prepared) {
    if (p.box.min.y < lowest) { lowest = p.box.min.y; lowestName = p.part.name; }
  }
  console.log(`  lowest point on the car: ${(lowest * 1000).toFixed(1)}mm (${lowestName})`);
  if (lowest < -CONTACT_TOL) fail(`${lowestName} is ${(-lowest * 1000).toFixed(1)}mm underground`);

  // And where the renderer then stands it. The car's frame has its contact
  // patch at y = 0, so the origin has to sit on the DRAWN asphalt, not on the
  // elevation the simulation uses — those differ by the thickness of the road
  // mesh and that difference is how far the wheels were buried.
  const elevation = 12.5;
  const rootY = carGroundY(elevation);
  const buried = elevation + ROAD_SURFACE_Y - rootY;
  console.log(`  road surface ${(ROAD_SURFACE_Y * 1000).toFixed(0)}mm above the sim elevation;`
    + ` car origin placed ${((rootY - elevation) * 1000).toFixed(0)}mm above it`
    + `  ->  tyres ${(buried * 1000).toFixed(1)}mm into the asphalt`);
  if (Math.abs(buried) > CONTACT_TOL) fail(`the renderer buries the tyres ${(buried * 1000).toFixed(1)}mm into the asphalt`);
  if (Math.abs(TYRE_RADIUS_M - 0.36) > 1e-9) fail('tyre radius is not the regulation 720mm diameter');

  // --- 2. suspension endpoints ---------------------------------------------
  console.log('\nsuspension members (both ends must land on the part they mount to)');
  const beforeMembers = failures;
  const byName = new Map<string, number>();
  prepared.forEach((p, i) => byName.set(p.part.name, i));
  const corners: [string, (s: 1 | -1) => SuspensionMember[]][] = [
    ['front', frontMembers], ['rear', rearMembers],
  ];
  for (const [corner, table] of corners) {
    for (const side of [-1, 1] as const) {
      for (const m of table(side)) {
        const self = byName.get(`${corner} ${m.name} ${side < 0 ? 'L' : 'R'}`);
        if (self === undefined) { fail(`no mesh named "${corner} ${m.name}"`); continue; }
        for (const [end, pt] of [['inboard', m.a], ['outboard', m.b]] as [string, readonly number[]][]) {
          const inside = insideAny(prepared, pt[0], pt[1], pt[2], self);
          const hit = grid.nearest(pt[0], pt[1], pt[2], 0.25, (o) => o === self);
          const d = hit.dist;
          const onto = inside >= 0 ? prepared[inside].part.name
            : hit.part >= 0 ? prepared[hit.part].part.name : 'nothing within 250mm';
          const ok = inside >= 0 || d <= JOINT_TOL;
          if (!ok || process.env.RIG_VERBOSE) {
            const how = inside >= 0 ? '  inside' : `${(d * 1000).toFixed(1).padStart(7)}mm from`;
            console.log(`  ${corner} ${m.name} ${side < 0 ? 'L' : 'R'}`.padEnd(28)
              + `${end.padEnd(9)} ${how} ${onto}`);
          }
          if (!ok) fail(`${corner} ${m.name} ${side < 0 ? 'L' : 'R'} ${end} end floats ${(d * 1000).toFixed(0)}mm clear of ${onto}`);
        }
      }
    }
  }
  if (failures === beforeMembers) console.log('  all 24 members land on a part at both ends');

  // --- 3. front wing -------------------------------------------------------
  //
  // Measured across the span from 300mm out to the endplate, which is clear of
  // the nose fairing that deliberately buries itself in the inner sections.
  console.log('\nfront wing (mainplane + 3 flaps; slot 5-15mm, and open to the eye)');
  const elements = [1, 2, 3, 4].map((n) => prepared[byName.get(`front wing element ${n}`)!]);
  const STATIONS = [0.30, 0.42, 0.54, 0.66, 0.78, 0.88];
  /**
   * Leading and trailing edge of an element in a 60mm band about a station.
   *
   * A BAND rather than a plane, because the elements are lofted at sixteen
   * spanwise stations and a plane cut at an arbitrary x finds no vertices at
   * all — which the first version of this did, silently, and reported every
   * slot as measured at zero stations.
   */
  const edgeAt = (p: Prepared, x: number): { le: THREE.Vector3; te: THREE.Vector3 } | null => {
    let le: THREE.Vector3 | null = null, te: THREE.Vector3 | null = null;
    const t = p.tri;
    for (let i = 0; i < t.length; i += 3) {
      if (Math.abs(t[i] - x) > 0.060) continue;
      const v = new THREE.Vector3(t[i], t[i + 1], t[i + 2]);
      if (!le || v.z > le.z) le = v;
      if (!te || v.z < te.z) te = v;
    }
    return le && te ? { le, te } : null;
  };
  // Where the head-on camera stands in `audit/car.ts`. The slot has to be open
  // to THAT eye, which is the shot the wing was reported from.
  const EYE = new THREE.Vector3(0.0, 0.75, 8.4);
  let front = -Infinity, frontName = '';
  for (const p of prepared) {
    if (p.part.bucket !== 'frontWing' && p.part.bucket !== 'frontFlap') continue;
    if (p.box.max.z > front) { front = p.box.max.z; frontName = p.part.name; }
  }
  console.log(`  foremost point ${front.toFixed(3)} (${frontName}); the overhang limit is ${FRONT_OVERHANG_Z.toFixed(3)}`);
  if (front > FRONT_OVERHANG_Z + 0.001) {
    fail(`the front wing reaches ${((front - FRONT_OVERHANG_Z) * 1000).toFixed(0)}mm past the 1350mm front overhang limit`);
  }
  for (let i = 0; i < 3; i++) {
    const a = elements[i], b = elements[i + 1];
    const ai = prepared.indexOf(a), bi = prepared.indexOf(b);
    // The gap: the closest either element's skin comes to the other's.
    let gap = Infinity;
    for (let q = 0; q < a.probe.length; q += 3) {
      const hit = grid.nearest(a.probe[q], a.probe[q + 1], a.probe[q + 2], 0.05, (o) => o !== bi);
      if (hit.dist < gap) gap = hit.dist;
    }
    // Daylight: from the middle of the slot to the head-on camera.
    let open = 0, tested = 0;
    for (const x of STATIONS) {
      const ea = edgeAt(a, x), eb = edgeAt(b, x);
      if (!ea || !eb) continue;
      tested++;
      const mid = ea.te.clone().add(eb.le).multiplyScalar(0.5);
      if (grid.clearLine(mid.x, mid.y, mid.z, EYE.x, EYE.y, EYE.z, (o) => o === ai || o === bi)) open++;
    }
    const frac = tested ? open / tested : 0;
    const gapOk = gap >= SLOT_MIN - 1e-4 && gap <= SLOT_MAX + 1e-4;
    const seeOk = frac >= SEE_THROUGH_MIN;
    console.log(`  slot ${i + 1}-${i + 2}   ${(gap * 1000).toFixed(1).padStart(5)}mm`
      + `   open to the head-on eye at ${open}/${tested} stations`
      + `   ${gapOk && seeOk ? '' : '<-'}`);
    if (!gapOk) fail(`slot ${i + 1}-${i + 2} is ${(gap * 1000).toFixed(1)}mm; the regulation range is 5-15mm`);
    if (!seeOk) fail(`slot ${i + 1}-${i + 2} shows daylight at only ${open} of ${tested} stations`);
  }

  // --- 4. bolted joints ----------------------------------------------------
  //
  // ISSUE #47. Section 5 below says whether a part TOUCHES the car within
  // 10mm. That is not the same question as whether it is BOLTED to it, and the
  // over-wheel cover is the proof: it sat 2.6mm off the vane that carries it at
  // the high tier and 8.6mm off it at the low one, so the disjoint set joined
  // it up and reported the car as a single cluster while the driver could see
  // sky through the joint.
  //
  // The rule this asserts is the one this file's own tolerance note already
  // states: "Parts of a car are authored to overlap — a strut ends INSIDE the
  // tub it is bolted to ... so genuine joints measure zero." A joint that
  // measures a POSITIVE number is not a joint, it is a gap, and a gap a couple
  // of millimetres wide 300mm from the driver's eye is daylight.
  //
  // So: every part must INTERSECT at least one other part — a sampled point of
  // one inside the solid of the other, tested both ways. That is a volumetric
  // test with no tolerance in it at all, which is why it cannot be tuned.
  //
  // WHAT IS EXEMPT, AND WHY. Two kinds of part cannot satisfy it and are not
  // defects. A part drawn as an OPEN surface has no inside, so nothing can be
  // inside it and its own points cannot be inside a neighbour it merely rests
  // against — the mirror pane is two triangles. And a part whose only
  // neighbours are open surfaces has nothing to be inside. Both are listed by
  // name rather than by rule, so adding one is a deliberate act.
  console.log('\nbolted joints (every part must INTERSECT another, not merely come near one)');
  const solids = prepared.map((p) => new Solid(p));
  /** Parts drawn as open surfaces: no interior, so parity says nothing. */
  const OPEN_SURFACE = new Set([
    'mirror glass L', 'mirror glass R',
  ]);
  const boltedTo: (string | null)[] = prepared.map(() => null);
  for (let i = 0; i < prepared.length; i++) {
    if (boltedTo[i]) continue;
    const bi = prepared[i].box;
    for (let j = 0; j < prepared.length && !boltedTo[i]; j++) {
      if (j === i) continue;
      const bj = prepared[j].box;
      if (bi.max.x < bj.min.x || bi.min.x > bj.max.x) continue;
      if (bi.max.y < bj.min.y || bi.min.y > bj.max.y) continue;
      if (bi.max.z < bj.min.z || bi.min.z > bj.max.z) continue;
      const pi = prepared[i].probe, pj = prepared[j].probe;
      let hit = false;
      for (let q = 0; q < pi.length && !hit; q += 3) hit = solids[j].contains(pi[q], pi[q + 1], pi[q + 2]);
      for (let q = 0; q < pj.length && !hit; q += 3) hit = solids[i].contains(pj[q], pj[q + 1], pj[q + 2]);
      if (hit) {
        boltedTo[i] = prepared[j].part.name;
        if (!boltedTo[j]) boltedTo[j] = prepared[i].part.name;
      }
    }
  }
  const loose = prepared
    .map((p, i) => [i, p] as const)
    .filter(([i, p]) => !boltedTo[i] && !OPEN_SURFACE.has(p.part.name));
  if (!loose.length) {
    console.log(`  all ${prepared.length} parts intersect the part they are bolted to`);
  }
  for (const [i, p] of loose) {
    // How wide the gap actually is, measured both ways so tessellation cannot
    // flatter it: the closest either surface comes to the other.
    let gap = Infinity, onto = '';
    for (let q = 0; q < p.probe.length; q += 3) {
      const hit = grid.nearest(p.probe[q], p.probe[q + 1], p.probe[q + 2], 0.10, (o) => o === i);
      if (hit.dist < gap) { gap = hit.dist; onto = prepared[hit.part].part.name; }
    }
    for (let j = 0; j < prepared.length; j++) {
      if (j === i) continue;
      const pj = prepared[j].probe;
      for (let q = 0; q < pj.length; q += 3) {
        const hit = grid.nearest(pj[q], pj[q + 1], pj[q + 2], gap, (o) => o !== i);
        if (hit.part === i && hit.dist < gap) { gap = hit.dist; onto = prepared[j].part.name; }
      }
    }
    console.log(`  PERCHED   ${p.part.name} — nearest surface ${gap === Infinity ? '>100' : (gap * 1000).toFixed(2)}mm away (${onto || 'nothing within 100mm'})`);
    fail(`${p.part.name} is bolted to nothing: ${gap === Infinity ? 'more than 100' : (gap * 1000).toFixed(2)}mm of daylight to ${onto || 'the nearest part'}`);
  }

  // --- 5. interpenetration -------------------------------------------------
  //
  // ISSUE #47, the other half: "phasing through the carbon". A part can be
  // attached and still pass through what it is attached to, and every check
  // above is blind to that — attachment and interpenetration are the SAME
  // measurement with opposite signs, and sections 2, 4 and 5 all read it as
  // good news. Section 2 explicitly does: `insideAny` returning a part is how
  // a suspension endpoint PASSES.
  //
  // What a member is allowed to do is end inside the things it is bolted to.
  // What it may not do is cross a piece of BODYWORK in mid-span — in one
  // surface and out of the other — because from any camera that is a carbon
  // leg crossing a carbon panel with no joint at either crossing.
  //
  // So the centreline is walked at 2mm and every run of it lying inside a body
  // is found. A run that reaches an END of the member is a pickup; the
  // allowance for "reaches" is `JOINT_TOL`, which is the same 25mm section 2
  // already grants a member's centreline against the skin it bolts through,
  // and it is not a new number. A run in the middle is a passage through
  // somebody else's bodywork, and it is named with where along the member it
  // happens.
  //
  // WHAT IS NOT TESTED, AND WHY. The RUNNING GEAR: the wheel, the upright,
  // the brake drum, the steering arm, the driveshaft and the other five
  // members of the same corner. Those are the parts a member is supposed to
  // reach into — six legs converging on two ball joints overlap each other by
  // construction — and the merged wheel is several shells deep, so a parity
  // ray through it reports a string of runs that mean nothing. Testing them
  // produced 171 reports of which none was a defect, and a check that cries
  // that often is a check nobody reads. `probe:suspension` owns the members'
  // geometry against each other; this owns them against the carbon.
  console.log('\ninterpenetration (a member may END inside a body, never cross one in mid-span)');
  const runningGear = new Set<string>();
  for (const [corner, table] of corners) {
    for (const side of [-1, 1] as const) {
      const sfx = side < 0 ? 'L' : 'R';
      for (const m of table(side)) runningGear.add(`${corner} ${m.name} ${sfx}`);
      for (const n of ['front upright', 'rear upright', 'front brake duct', 'rear brake duct',
        'front steering arm', 'driveshaft']) runningGear.add(`${n} ${sfx}`);
    }
  }
  const isBody = prepared.map((p) => p.part.bucket !== 'wheel' && !runningGear.has(p.part.name));
  const STEP = 0.002;
  const beforePhase = failures;
  for (const [corner, table] of corners) {
    for (const side of [-1, 1] as const) {
      for (const m of table(side)) {
        const label = `${corner} ${m.name} ${side < 0 ? 'L' : 'R'}`;
        const ax = m.a[0], ay = m.a[1], az = m.a[2];
        const bx = m.b[0], by = m.b[1], bz = m.b[2];
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        const n = Math.max(2, Math.round(len / STEP));
        const near = Math.ceil(JOINT_TOL / STEP);
        for (let j = 0; j < prepared.length; j++) {
          if (!isBody[j]) continue;
          let runStart = -1;
          for (let k = 0; k <= n; k++) {
            const u = k / n;
            const inside = solids[j].contains(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u);
            if (inside && runStart < 0) runStart = k;
            if ((!inside || k === n) && runStart >= 0) {
              const runEnd = inside ? k : k - 1;
              if (runStart > near && runEnd < n - near) {
                const from = (runStart / n) * len, to = (runEnd / n) * len;
                console.log(`  THROUGH   ${label.padEnd(22)} crosses ${prepared[j].part.name}`
                  + `  from ${(from * 1000).toFixed(0)}mm to ${(to * 1000).toFixed(0)}mm of a ${(len * 1000).toFixed(0)}mm member`);
                fail(`${label} passes clean through ${prepared[j].part.name} for ${((to - from) * 1000).toFixed(0)}mm in mid-span`);
              }
              runStart = -1;
            }
          }
        }
      }
    }
  }
  if (failures === beforePhase) console.log('  no member crosses a body it is not bolted to');

  // --- 6. the corner, THROUGH THE STEERING RANGE ---------------------------
  //
  // Everything above is measured with the wheels straight, and for most of
  // this car that is the whole story: `Renderer` places the visual at
  // `bankedCarGroundY` and nothing moves the body relative to the wheels, so
  // there is no ride-height freedom to sweep. The front corner is the one
  // exception, and it is a large one.
  //
  // The upright, steering arm, brake drum, wheel cover and both cover posts
  // ride on the steer group; the six suspension members do not. Between the
  // two locks a post 178mm inboard of the hub sweeps 145mm of arc, across a
  // pair of wishbone legs 78mm wide with a 21mm window between them — so
  // clearance straight ahead says nothing at all about clearance on lock, and
  // the wheel cover is exactly the part that has to survive it.
  //
  // TWO RULES, and neither is vacuous.
  //
  //  (a) Nothing on the steer group may enter a piece of CHASSIS bodywork at
  //      any angle. The drum sweeps 122mm of arc and the tyre more; the floor's
  //      leading edge, the floor fences, the nose and the front wing are all
  //      within reach of it, and none of the checks above looks at the corner
  //      anywhere but straight ahead.
  //
  //  (b) No steered BODY — an aero fairing rather than running gear — may
  //      enter a suspension member at any angle. The members do not steer, so
  //      a fairing that clears them straight ahead can still sweep through
  //      them, and that is exactly what killed the over-wheel cover: measured
  //      at 2 to 24mm of a leg between 12 and 24 degrees of lock. There is no
  //      such fairing on the car today and the check says so by name, so if one
  //      is put back it is measured from its first frame instead of after the
  //      next screenshot.
  console.log('\nsteering lock (the corner sweeps; the chassis does not)');
  const LOCK = BASE_F1_SPEC.maxSteerRad;
  const beforeLock = failures;
  /** Running gear: the parts a member is SUPPOSED to reach into. */
  const cornerRunningGear = (n: string) => /upright|steering arm|brake duct/.test(n);
  const memberNames = new Set<string>();
  for (const [corner, table] of corners) {
    for (const side of [-1, 1] as const) {
      for (const m of table(side)) memberNames.add(`${corner} ${m.name} ${side < 0 ? 'L' : 'R'}`);
    }
  }
  /** Chassis bodywork: everything that does not steer and is not a member. */
  const chassis = prepared
    .map((p, i) => [i, p] as const)
    .filter(([, p]) => p.part.bucket !== 'wheel' && p.part.bucket !== 'upright'
      && !memberNames.has(p.part.name));
  let steeredBodies = 0;
  for (let step = -6; step <= 6; step++) {
    const steer = (step / 6) * LOCK;
    const deg = (steer * 180 / Math.PI).toFixed(1);
    for (const side of [-1, 1] as const) {
      const corner = frontCornerForProbe(tier, side, steer);
      for (const p of corner) {
        const pr = prepare(p);
        // (a) into the chassis.
        for (const [ci, cp] of chassis) {
          let deep = 0;
          for (let q = 0; q < pr.probe.length; q += 3) {
            if (solids[ci].contains(pr.probe[q], pr.probe[q + 1], pr.probe[q + 2])) deep++;
          }
          if (deep > 0) {
            console.log(`  FOULED    ${p.name.padEnd(22)} is inside ${cp.part.name} at ${deg} deg of lock`);
            fail(`${p.name} is inside ${cp.part.name} at ${deg} deg of lock`);
          }
        }
        // (b) a steered fairing into a member.
        if (cornerRunningGear(p.name) || p.bucket === 'wheel') continue;
        steeredBodies++;
        const solid = new Solid(pr);
        for (const m of frontMembers(side)) {
          const label = `front ${m.name} ${side < 0 ? 'L' : 'R'}`;
          const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
          const n = Math.max(2, Math.round(len / STEP));
          let deep = 0;
          for (let k = 0; k <= n; k++) {
            const u = k / n;
            if (solid.contains(
              m.a[0] + (m.b[0] - m.a[0]) * u,
              m.a[1] + (m.b[1] - m.a[1]) * u,
              m.a[2] + (m.b[2] - m.a[2]) * u,
            )) deep++;
          }
          if (deep > 0) {
            console.log(`  FOULED    ${label.padEnd(22)} is ${(deep * STEP * 1000).toFixed(0)}mm inside`
              + ` ${p.name} at ${deg} deg of lock`);
            fail(`${label} is ${(deep * STEP * 1000).toFixed(0)}mm inside ${p.name} at ${deg} deg of lock`);
          }
        }
      }
    }
  }
  if (failures === beforeLock) {
    console.log(`  13 angles from ${(-LOCK * 180 / Math.PI).toFixed(1)} to ${(LOCK * 180 / Math.PI).toFixed(1)} deg,`
      + ` both corners: nothing on the steer group enters the chassis,`
      + ` and the ${steeredBodies} steered fairing${steeredBodies === 1 ? '' : 's'} clear the suspension`);
  }

  // --- 7. disjoint parts ---------------------------------------------------
  console.log('\nconnectivity (every part must touch the car)');
  const dsu = new DisjointSet(prepared.length);
  for (let i = 0; i < prepared.length; i++) {
    const probe = prepared[i].probe;
    for (let q = 0; q < probe.length; q += 3) {
      const hit = grid.nearest(probe[q], probe[q + 1], probe[q + 2], JOIN_TOL, (o) => o === i);
      if (hit.part >= 0) dsu.union(i, hit.part);
    }
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < prepared.length; i++) {
    const r = dsu.find(i);
    const c = clusters.get(r);
    if (c) c.push(i); else clusters.set(r, [i]);
  }
  const sorted = [...clusters.values()].sort((a, b) => b.length - a.length);
  console.log(`  ${prepared.length} parts in ${sorted.length} cluster${sorted.length === 1 ? '' : 's'}`);
  const hull = new Set(sorted[0]);
  for (const c of sorted.slice(1)) {
    // How far this cluster actually is from the car, so the report is a
    // distance rather than a verdict.
    let gap = Infinity;
    let onto = '';
    for (const i of c) {
      const probe = prepared[i].probe;
      for (let q = 0; q < probe.length; q += 3) {
        const hit = grid.nearest(probe[q], probe[q + 1], probe[q + 2], 0.40, (o) => !hull.has(o));
        if (hit.dist < gap) { gap = hit.dist; onto = prepared[hit.part].part.name; }
      }
    }
    const names = c.map((i) => prepared[i].part.name).join(', ');
    const box = new THREE.Box3();
    for (const i of c) box.union(prepared[i].box);
    console.log(`  DETACHED  ${names}`);
    console.log(`            ${boxLabel(box)}`);
    console.log(`            nearest ${gap === Infinity ? '>400' : (gap * 1000).toFixed(0)}mm from ${onto || 'the car'}`);
    fail(`${names} floats ${gap === Infinity ? 'more than 400' : (gap * 1000).toFixed(0)}mm clear of the car`);
  }
}

for (const tier of TIERS) run(tier);

console.log('');
if (failures) {
  console.log(`${failures} defect${failures === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('the car is one object: every part touches, every member lands, every tyre stands on the road');
