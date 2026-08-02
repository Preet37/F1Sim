import { installCanvasStub } from './lib/domStub';

installCanvasStub();

import * as THREE from 'three';
import {
  carPartsForProbe, frontMembers, rearMembers, TYRE_RADIUS_M,
  type CarPart, type CarTier, type SuspensionMember,
} from '../src/render/CarMesh';
import { ROAD_SURFACE_Y, carGroundY } from '../src/render/TrackMesh';

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
  if (!failures) console.log('  all 24 members land on a part at both ends');

  // --- 3. disjoint parts ---------------------------------------------------
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
