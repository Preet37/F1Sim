/**
 * Track limits: is the rule the one the regulations state, and can the driver
 * SEE the boundary they are being judged against?
 *
 * Two questions, deliberately in one probe, because they are the same question
 * asked of two layers. The FIA definition is geometric:
 *
 *   "Drivers must make every reasonable effort to use the track at all times...
 *    a driver will be judged to have left the track if no part of the car
 *    remains in contact with it."   (2025 Sporting Regulations, Art. 33.3)
 *
 * and the track is bounded by the OUTER edge of the white lines — the line is
 * part of the track. So the moment of the offence is exactly the moment the
 * INNERMOST extremity of the car — the outboard face of the tyre on the side
 * nearer the circuit — passes the outer edge of that paint. Not the car's
 * centre, not its wheel centres, and not the inner edge of the line.
 *
 * That single number is worth measuring properly, because both ways of being
 * wrong are visible to the player and one of them was reported: a threshold set
 * a few centimetres tight deletes laps from a car the player can plainly see is
 * still touching the paint, and every false deletion is noticed.
 *
 * WHAT IS MEASURED
 *
 * 1. THE PAINT, from the built geometry. For every circuit, on BOTH sides, at
 *    every node: is there a piece of white paint at the track edge that a
 *    camera would actually see? "Would actually see" is the whole point — the
 *    edge lines were being generated on both sides all along, but the right-hand
 *    quads were wound clockwise seen from above, and the paint mesh is
 *    single-sided, so every triangle of the right-hand line faced the ground and
 *    was culled. Geometry that exists is not the test; geometry that survives
 *    backface culling is. So the probe rejects any triangle whose winding faces
 *    away from a viewer above it, exactly as the GPU does.
 *
 *    It also measures WHERE the paint is, by sampling laterally across the edge
 *    and reporting the inner and outer edge of the painted band. The outer edge
 *    is the regulation boundary and it must coincide with `halfWidthAt`, or the
 *    rule below is being applied at a line nobody painted.
 *
 * 2. THE RULE, by driving the real `RaceControlManager` on the real circuits.
 *    A car is placed at known lateral offsets expressed RELATIVE TO THE PAINT —
 *    inner extremity fully inboard of the line, straddling it, sitting exactly
 *    on its outer edge, and clear of it — and race control is stepped once per
 *    case. Only the last may delete the lap. The exact threshold is then found
 *    by bisection and reported in metres, so a regression shows up as a number
 *    rather than as a pass.
 *
 * Run: npm run validate:limits
 */

import * as THREE from 'three';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { buildWorldModel } from '../src/track/WorldObstacles';
import { pitLaneGeometry } from '../src/track/PitGeometry';
import { PHYSICS_DT } from '../src/core/SimClock';
import { buildTrackMeshes, PAINT_HEIGHT_M, EDGE_LINE_WIDTH_M } from '../src/render/TrackMesh';
import { DRIVERS } from '../src/data/teams';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import { CAR_HALF_WIDTH_M } from '../src/race/RaceControlManager';
import { installCanvasStub } from './lib/domStub';

// The circuit's textures are painted into canvases at build time. None of them
// is measured here; they only have to not throw.
installCanvasStub();

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

// =============================================================================
// Part 1 — the paint
// =============================================================================

/**
 * Every horizontal triangle in the circuit, indexed by a coarse XZ grid.
 *
 * Only triangles that survive backface culling from above are kept: three.js
 * renders the paint mesh with `side: FrontSide`, and a front face is one whose
 * vertex order is counter-clockwise seen from the camera. For a near-horizontal
 * triangle seen from above that is exactly `((v1-v0) x (v2-v0)).y > 0`. A quad
 * wound the other way is invisible no matter what normal is stored on it, which
 * is the failure this exists to catch.
 */
class PaintIndex {
  private readonly cell = 8;
  private readonly bins = new Map<number, number[]>();
  /** Flat triangle store: 9 floats per triangle. */
  private readonly tri: number[] = [];

  private key(x: number, z: number): number {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    return cx * 73856093 ^ cz * 19349663;
  }

  add(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Instanced scenery is never paint and there is a lot of it.
      if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
      const pos = mesh.geometry?.getAttribute('position');
      if (!pos) return;
      const idx = mesh.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const a = idx ? idx.getX(i) : i;
        const b = idx ? idx.getX(i + 1) : i + 1;
        const c = idx ? idx.getX(i + 2) : i + 2;
        const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
        const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
        const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
        // Winding normal, NOT the stored normal: `StripBuilder.tri` flips the
        // stored normal up so that lighting is right, which would hide exactly
        // the defect being looked for.
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        if (ny <= 0) continue;              // back-facing from above: culled
        const area2 = Math.hypot(
          (by - ay) * (cz - az) - (bz - az) * (cy - ay),
          ny,
          (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
        );
        if (area2 <= 1e-9 || ny / area2 < 0.85) continue;  // not a ground surface
        const t = this.tri.length / 9;
        this.tri.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
        const minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
        for (let gx = Math.floor(minX / this.cell); gx <= Math.floor(maxX / this.cell); gx++) {
          for (let gz = Math.floor(minZ / this.cell); gz <= Math.floor(maxZ / this.cell); gz++) {
            const k = gx * 73856093 ^ gz * 19349663;
            let bin = this.bins.get(k);
            if (!bin) { bin = []; this.bins.set(k, bin); }
            bin.push(t);
          }
        }
      }
    });
  }

  /**
   * Is there a visible surface at (x, z) whose height is within `tol` of `y`?
   *
   * The height window is what separates paint from the asphalt beneath it: the
   * road is drawn 15mm lower, so asking for the surface at the paint's own
   * height is the same question as asking whether the paint is there.
   */
  hasSurfaceAt(x: number, z: number, y: number, tol: number): boolean {
    const bin = this.bins.get(this.key(x, z));
    if (!bin) return false;
    for (const t of bin) {
      const o = t * 9;
      const ax = this.tri[o], ay = this.tri[o + 1], az = this.tri[o + 2];
      const bx = this.tri[o + 3], by = this.tri[o + 4], bz = this.tri[o + 5];
      const cx = this.tri[o + 6], cy = this.tri[o + 7], cz = this.tri[o + 8];
      // Barycentric in the XZ plane.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      if (Math.abs(l1 * ay + l2 * by + l3 * cy - y) <= tol) return true;
    }
    return false;
  }
}

interface PaintResult {
  coverage: [number, number];      // [right, left] fraction of nodes painted
  outerEdgeErr: number;            // worst |painted outer edge - halfWidth|, m
  bandWidth: number;               // median painted band width, m
  gaps: number;                    // longest unpainted run, metres, worst side
  gapAt: string;                   // where it is, and whether the pit lane explains it
}

function measurePaint(def: (typeof CIRCUITS)[number]): PaintResult {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const pit = pitLaneGeometry(def, track.length);
  const meshes = buildTrackMeshes(track, 'high', world);
  const index = new PaintIndex();
  index.add(meshes.root);

  const px = (i: number, lat: number) => track.px[i] + track.nx[i] * lat;
  const pz = (i: number, lat: number) => track.pz[i] + track.nz[i] * lat;
  const py = (i: number, lat: number) => {
    const bank = track.banking[i];
    return track.elevation[i] + (bank !== 0 ? -lat * Math.tan(bank) : 0);
  };

  const painted = (i: number, lat: number): boolean =>
    index.hasSurfaceAt(px(i, lat), pz(i, lat), py(i, lat) + PAINT_HEIGHT_M, 0.006);

  const nodeM = track.length / track.count;
  const covered = [0, 0];
  const total = [0, 0];
  const longestGap = [0, 0];
  const runGap = [0, 0];
  const gapEnd = [0, 0];
  let outerEdgeErr = 0;
  const bands: number[] = [];

  for (let i = 0; i < track.count; i++) {
    const hw = track.width[i] * 0.5;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      total[s]++;
      // Probe the middle of where the line is supposed to be.
      const hit = painted(i, side * (hw - EDGE_LINE_WIDTH_M * 0.5));
      if (hit) {
        covered[s]++;
        runGap[s] = 0;
      } else {
        runGap[s] += nodeM;
        if (runGap[s] > longestGap[s]) {
          longestGap[s] = runGap[s];
          gapEnd[s] = (i / track.count) * track.length;
        }
      }
    }

    // Where the paint actually lies, on a sparse subset — 5mm laterally is
    // enough to resolve a 140mm line.
    //
    // Walked OUTWARD and INWARD from the middle of the line until the paint
    // stops, rather than taking the extremes of a lateral sweep. The pit lane
    // has white lines of its own at the same height, several metres outboard of
    // the circuit's edge on every main straight, and a sweep that simply takes
    // the outermost paint it can find measures those instead. This measures the
    // band the edge line is actually part of.
    //
    // Not measured alongside the pit lane. There the pit entry and exit lines
    // are painted at the same height and butt straight up against the circuit's
    // own edge line, so the contiguous band is legitimately 340mm wide and its
    // outer edge is legitimately not the track limit. That stretch is excluded
    // from this measurement and only from this measurement — coverage above
    // still demands an edge line there.
    if (i % Math.max(1, Math.floor(track.count / 40)) !== 0) continue;
    if (pit.covers((i / track.count) * track.length)) continue;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const mid = hw - EDGE_LINE_WIDTH_M * 0.5;
      if (!painted(i, side * mid)) continue;      // no line here; coverage says so
      let hi = mid, lo = mid;
      while (painted(i, side * (hi + 0.005)) && hi - mid < 0.5) hi += 0.005;
      while (painted(i, side * (lo - 0.005)) && mid - lo < 0.5) lo -= 0.005;
      bands.push(hi - lo);
      const err = Math.abs(hi - hw);
      if (err > outerEdgeErr) outerEdgeErr = err;
    }
  }

  meshes.dispose();
  bands.sort((a, b) => a - b);
  const worstSide = longestGap[1] > longestGap[0] ? 1 : 0;
  const gap = longestGap[worstSide];
  return {
    coverage: [covered[0] / total[0], covered[1] / total[1]],
    outerEdgeErr,
    bandWidth: bands.length ? bands[bands.length >> 1] : 0,
    gaps: gap,
    gapAt: gap === 0 ? '' :
      (worstSide === 0 ? 'right' : 'left') + ' at ' + gapEnd[worstSide].toFixed(0) + 'm' +
      (pit.covers(gapEnd[worstSide]) ? ', pit lane' : ', NOT the pit lane'),
  };
}

// =============================================================================
// Part 2 — the rule
// =============================================================================

/** A one-car session, so nothing else in the field can raise a flag. */
function soloEngine(def: (typeof CIRCUITS)[number]): RaceEngine {
  const config: SessionConfig = {
    kind: 'practice', name: 'PROBE', durationS: 0, laps: 0,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 1,
  };
  const engine = new RaceEngine(def, config, [DRIVERS[0]]);
  return engine;
}

/** Puts the car at a lateral offset and a yaw, and asks race control once. */
function deletesAtLateral(
  engine: RaceEngine, s: number, lateral: number, yawRad: number,
): boolean {
  const car = engine.cars[0];
  const speed = engine.track.targetSpeed[engine.track.indexAt(s)];
  car.placeOnTrack(engine.track, s, lateral, speed);
  car.physics.heading = engine.track.headingAt(s) + yawRad;
  car.inPitLane = false;
  car.retired = false;
  car.offTrackNow = false;
  car.currentLapInvalidated = false;
  car.trackLimitStrikes = 0;
  engine.raceControl.update(1 / 120, engine.cars, engine.cars, 60, false, 0);
  return car.currentLapInvalidated;
}

/**
 * The lateral offset of the car's CENTRE at which its innermost contact patch
 * sits exactly `inset` metres inboard of the outer edge of the white line.
 *
 * With the car straight this is just `hw - inset + halfWidth`. With yaw it is
 * not, and the difference is the whole of the first bug: the four patches
 * spread across the track as the car rotates, so the innermost one is further
 * from the centreline than half a car width.
 */
function centreFor(
  engine: RaceEngine, s: number, inset: number, yawRad: number,
): number {
  const c = Math.cos(yawRad), sn = Math.sin(yawRad);
  const spec = engine.cars[0].physics.spec;
  const front = spec.cogToFrontM * sn;
  const rear = -(spec.wheelbaseM - spec.cogToFrontM) * sn;
  // Smallest of the four (across, along) offsets — the patch nearest the track.
  const nearest = Math.min(front, rear) - Math.abs(CAR_HALF_WIDTH_M * c);
  return engine.track.halfWidthAt(s) - inset - nearest;
}

/** Places the car with its innermost contact patch `inset` inboard of the line. */
function deletesAt(engine: RaceEngine, s: number, inset: number, yawRad = 0): boolean {
  return deletesAtLateral(engine, s, centreFor(engine, s, inset, yawRad), yawRad);
}

/** The inset, in metres, at which the lap first survives. Bisected to 0.1mm. */
function threshold(engine: RaceEngine, s: number, yawRad = 0): number {
  let off = -0.9;                     // clear of the line: must delete
  let on = 0.9;                       // well inboard: must not
  for (let i = 0; i < 40; i++) {
    const mid = (off + on) * 0.5;
    if (deletesAt(engine, s, mid, yawRad)) off = mid; else on = mid;
  }
  return (off + on) * 0.5;
}

/** A node on a fast, wide part of the circuit, away from the pit lane. */
function probeS(engine: RaceEngine): number {
  const track = engine.track;
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < track.count; i += 5) {
    const s = (i / track.count) * track.length;
    if (s < track.length * 0.15 || s > track.length * 0.75) continue;
    const score = track.targetSpeed[i] + track.width[i];
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// =============================================================================

console.log('=== Track limits ===\n');
console.log('The white line is painted inboard of half-width, so its OUTER edge');
console.log('is the regulation boundary. A car is off only when its innermost');
console.log('extremity clears that edge.\n');
console.log('car half-width (over the tyres):  ' + CAR_HALF_WIDTH_M.toFixed(3) + ' m');
console.log('edge line width:                  ' + EDGE_LINE_WIDTH_M.toFixed(3) + ' m\n');

console.log('--- Paint, from the built geometry (front-facing triangles only) ---');
console.log('circuit          right    left   outer-edge err   band    max gap');
for (const def of CIRCUITS) {
  const r = measurePaint(def);
  console.log(
    def.id.padEnd(15) +
    (r.coverage[0] * 100).toFixed(1).padStart(6) + '%' +
    (r.coverage[1] * 100).toFixed(1).padStart(7) + '%' +
    r.outerEdgeErr.toFixed(3).padStart(14) + ' m' +
    r.bandWidth.toFixed(3).padStart(8) + ' m' +
    r.gaps.toFixed(0).padStart(8) + ' m  ' + r.gapAt,
  );
  for (let s = 0; s < 2; s++) {
    const name = s === 0 ? 'right' : 'left';
    if (r.coverage[s] < 0.99) {
      fail(def.id + ': ' + name + '-hand white line covers only ' +
        (r.coverage[s] * 100).toFixed(1) + '% of the lap');
    }
  }
  if (r.outerEdgeErr > 0.02) {
    fail(def.id + ': painted outer edge is ' + r.outerEdgeErr.toFixed(3) +
      ' m from halfWidthAt — race control judges a line nobody painted');
  }
  if (Math.abs(r.bandWidth - EDGE_LINE_WIDTH_M) > 0.03) {
    fail(def.id + ': painted band is ' + r.bandWidth.toFixed(3) + ' m, expected ' +
      EDGE_LINE_WIDTH_M.toFixed(3) + ' m');
  }
  // A few metres is tolerated, and the `gapAt` column says where: the pit entry
  // and exit legitimately break the circuit's own edge line, and COTA's turn 11
  // is a hairpin whose radius is smaller than the road is wide, so the inside
  // edge of the surface folds through itself for one node. Both are visible in
  // the column rather than hidden by the threshold.
  if (r.gaps > 25) {
    fail(def.id + ': ' + r.gaps.toFixed(0) + ' m of track edge with no line on it');
  }
}

console.log('\n--- The rule, from RaceControlManager ---');
console.log('Insets are measured from the OUTER edge of the white line to the');
console.log("car's innermost extremity. Positive = still overlapping the track.\n");
console.log('circuit          +0.10   +0.07   0.000  -0.001  -0.100   threshold');

const CASES: readonly { inset: number; delete: boolean; what: string }[] = [
  { inset: 0.10, delete: false, what: 'inner wheel fully inboard of the line' },
  { inset: EDGE_LINE_WIDTH_M * 0.5, delete: false, what: 'straddling the line' },
  { inset: 0.0, delete: false, what: 'exactly on the outer edge' },
  { inset: -0.001, delete: true, what: 'a millimetre clear of the line' },
  { inset: -0.10, delete: true, what: 'fully beyond the line' },
];

for (const def of CIRCUITS) {
  const engine = soloEngine(def);
  const s = probeS(engine);
  const got = CASES.map((c) => deletesAt(engine, s, c.inset));
  const th = threshold(engine, s);
  console.log(
    def.id.padEnd(15) +
    got.map((g) => (g ? 'DEL' : ' ok').padStart(8)).join('') +
    th.toFixed(4).padStart(12) + ' m',
  );
  for (let i = 0; i < CASES.length; i++) {
    if (got[i] === CASES[i].delete) continue;
    fail(def.id + ': ' + CASES[i].what + ' (inset ' + CASES[i].inset.toFixed(3) +
      ' m) ' + (got[i] ? 'DELETED the lap' : 'did not delete the lap') +
      ' — it should ' + (CASES[i].delete ? '' : 'not ') + 'have');
  }
  // The boundary must be the paint's outer edge, to the millimetre.
  if (Math.abs(th) > 0.005) {
    fail(def.id + ': deletion threshold is ' + th.toFixed(4) +
      ' m from the outer edge of the line, expected 0');
  }
}

console.log('\n--- The same test with the car yawed ---');
console.log('A car running wide is sliding. Its four contact patches spread');
console.log('across the track as it rotates, so the last one to leave the paint');
console.log('is further from the centreline than half a car width. The threshold');
console.log('below is metres of overlap still on the track when the lap died —');
console.log('positive means the lap was deleted while the car was still on it.\n');
console.log('circuit             0 deg    5 deg   10 deg   15 deg   25 deg');

// What the rule as it stood would have left on the track, worked out in closed
// form: it fired at |lateral| = halfWidth + trackWidthM/2 regardless of attitude,
// so the overlap it threw away is the difference between the car's real span at
// that attitude and the span it assumed.
{
  const spec = BASE_F1_SPEC;
  const row: string[] = [];
  for (const deg of [0, 5, 10, 15, 25]) {
    const psi = (deg * Math.PI) / 180;
    const sn = Math.sin(psi);
    const nearest = Math.min(spec.cogToFrontM * sn, -(spec.wheelbaseM - spec.cogToFrontM) * sn)
      - Math.abs(CAR_HALF_WIDTH_M * Math.cos(psi));
    row.push((-spec.trackWidthM * 0.5 - nearest).toFixed(3).padStart(9));
  }
  console.log('(old rule)     ' + row.join(''));
}

for (const def of CIRCUITS) {
  const engine = soloEngine(def);
  const s = probeS(engine);
  const row: string[] = [];
  for (const deg of [0, 5, 10, 15, 25]) {
    const th = -threshold(engine, s, (deg * Math.PI) / 180);
    row.push(th.toFixed(3).padStart(9));
    if (Math.abs(th) > 0.01) {
      fail(def.id + ': at ' + deg + ' deg of yaw the lap is deleted with ' +
        th.toFixed(3) + ' m of the car still on the track');
    }
  }
  console.log(def.id.padEnd(15) + row.join(''));
}

// -----------------------------------------------------------------------------
// Part 3 — what it costs in a real session
// -----------------------------------------------------------------------------
//
// The sections above are static placements. This drives the actual field on the
// actual circuits and counts the instants at which the OLD rule — the car's
// centre plus or minus half a width, yaw ignored — would have called a car off
// while its innermost contact patch was still on the paint. Those are the false
// deletions the player reported, measured rather than argued.

console.log('\n--- Cars driving: how many deletions the old rule invented ---');
console.log('An excursion is counted the way race control counts it: once, on the');
console.log('step the car is first judged off. A FALSE one is an excursion the old');
console.log('rule reported in which no part of the car ever actually left the');
console.log('track. Steps are counted too, because the AI is tuned to stay inside');
console.log('the line and rarely goes far past it — the player does, and the');
console.log('per-step disagreement is the size of the trap they drive into.\n');
console.log('circuit         car-steps   off:real   off:old  false-step  false-exc   worst m');

let totalFalse = 0;
let totalOld = 0;
let worstOverlap = 0;
for (const def of CIRCUITS) {
  const config: SessionConfig = {
    kind: 'practice', name: 'PROBE', durationS: 0, laps: 0,
    playerIndex: -1, standingStart: false, pitLaneStart: true, seed: 20260729,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const spec = engine.cars[0].physics.spec;

  // Per-car excursion state, mirroring `car.offTrackNow`.
  const wasOld = new Array<boolean>(engine.cars.length).fill(false);
  const wasNew = new Array<boolean>(engine.cars.length).fill(false);
  const everReallyOff = new Array<boolean>(engine.cars.length).fill(false);
  const settled = new Float64Array(engine.cars.length);

  let steps = 0, real = 0, old = 0, falseOnes = 0, falseSteps = 0, worst = 0;
  const SIM_S = 150;
  for (let t = 0; t < Math.round(SIM_S / PHYSICS_DT); t++) {
    engine.step();
    for (let ci = 0; ci < engine.cars.length; ci++) {
      const car = engine.cars[ci];
      if (car.retired || car.inPitLane) {
        wasOld[ci] = wasNew[ci] = false;
        settled[ci] = 0;
        continue;
      }
      // A car crossing the pit exit line is laterally well outside the circuit
      // by construction and is not an excursion. Give it three seconds to get
      // onto the road before judging it.
      settled[ci] += PHYSICS_DT;
      if (settled[ci] < 3) { wasOld[ci] = wasNew[ci] = false; continue; }
      steps++;
      const hw = track.halfWidthAt(car.s);
      const psi = car.physics.heading - track.headingAt(car.s);
      const c = Math.cos(psi), sn = Math.sin(psi);
      const front = spec.cogToFrontM * sn;
      const rear = -(spec.wheelbaseM - spec.cogToFrontM) * sn;
      const half = Math.abs(CAR_HALF_WIDTH_M * c);
      const min = car.lateral - half + Math.min(front, rear);
      const max = car.lateral + half + Math.max(front, rear);
      const nowOff = min > hw || max < -hw;
      // The rule as it was: the centre, half the spec's track width, no yaw.
      const oldOff = Math.abs(car.lateral) - spec.trackWidthM * 0.5 > hw;
      if (nowOff) { if (!wasNew[ci]) real++; }
      if (oldOff) {
        if (!wasOld[ci]) { old++; everReallyOff[ci] = false; }
        if (nowOff) {
          everReallyOff[ci] = true;
        } else {
          falseSteps++;
          const overlap = car.lateral > 0 ? hw - min : max + hw;
          if (overlap > worst) worst = overlap;
        }
      } else if (wasOld[ci] && !everReallyOff[ci]) {
        falseOnes++;
      }
      wasOld[ci] = oldOff;
      wasNew[ci] = nowOff;
    }
  }
  totalFalse += falseOnes;
  totalOld += old;
  if (worst > worstOverlap) worstOverlap = worst;
  console.log(
    def.id.padEnd(15) +
    String(steps).padStart(10) +
    String(real).padStart(11) +
    String(old).padStart(10) +
    String(falseSteps).padStart(12) +
    String(falseOnes).padStart(11) +
    worst.toFixed(3).padStart(10),
  );
}
console.log('\n' + totalFalse + ' of the old rule\'s ' + totalOld + ' reported excursions across the eleven');
console.log('circuits were of a car that never left the track, and it spent up to');
console.log(worstOverlap.toFixed(2) + ' m of car still on the paint while calling one off.');

// ===========================================================================
// Which laps can be sanctioned at all
// ===========================================================================
//
// Reported by a player: "the first lap is always the out lap ... idt there
// should be penalties or limits for the first lap of qualifying."
//
// They are right, for a precise reason. Art. B1.8.6 defines leaving the track
// geometrically and says nothing about which lap you are on, so the excursion
// on an out-lap is a real excursion. But Art. B1.9.4 is the whole of what the
// stewards may do about an incident in a Lap Time Classified Session — "the
// Stewards may delete a driver's lap time (or lap times) or drop the driver
// such number of grid positions as they consider appropriate" — and on a lap
// that carries no time the first of those has nothing to act on. The game was
// deleting a time that did not exist and telling the driver so, on the lap out
// of the garage.
//
// Both halves of this are worth asserting, because suppressing too much would
// be just as wrong: an out-lap must be untouchable and the flying lap that
// follows it must not be.

console.log('\n--- Which laps a track-limits excursion can be sanctioned on ---');
console.log('Art. B1.9.4: in an LTCS the sanction IS the deletion of a lap time.');
console.log('On a lap that carries no time there is nothing to delete.\n');
console.log('circuit          session   lap            deleted  strikes  announced');

/** Runs one excursion and reports everything race control did about it. */
function excursion(
  engine: RaceEngine, s: number, kind: 'race' | 'other',
  lap: 'out' | 'in' | 'flying',
): { deleted: boolean; strikes: number; announced: number } {
  const car = engine.cars[0];
  const before = engine.raceControl.messages.length;
  car.currentLapInvalidated = false;
  car.trackLimitStrikes = 0;
  car.offTrackNow = false;
  car.onOutLap = lap === 'out';
  car.pitRequested = lap === 'in';
  car.inPitLane = false;
  car.retired = false;
  // Well clear of the line, and at racing speed so it reads as a car that
  // gained something rather than one that spun off and lost time.
  car.placeOnTrack(engine.track, s,
    centreFor(engine, s, -0.30, 0), engine.track.targetSpeed[engine.track.indexAt(s)]);
  car.physics.heading = engine.track.headingAt(s);
  engine.raceControl.update(1 / 120, engine.cars, engine.cars, 60, kind === 'race', 0);
  const said = engine.raceControl.messages.slice(before)
    .filter((m) => /track limits/i.test(m.text));
  return { deleted: car.currentLapInvalidated, strikes: car.trackLimitStrikes, announced: said.length };
}

for (const def of CIRCUITS) {
  const engine = soloEngine(def);
  const s = probeS(engine);

  const expectations: {
    kind: 'race' | 'other'; lap: 'out' | 'in' | 'flying';
    deleted: boolean; strikes: number; announced: number; why: string;
  }[] = [
    // The out-lap, which is the reported bug.
    { kind: 'other', lap: 'out', deleted: false, strikes: 0, announced: 0,
      why: 'an out-lap carries no time, so Art. B1.9.4 has nothing to delete' },
    // The in-lap, for the same reason: the car turns off before the line and
    // the lap is never completed, so its time is never classified either.
    { kind: 'other', lap: 'in', deleted: false, strikes: 0, announced: 0,
      why: 'an in-lap is never classified, so there is no time to delete' },
    // ...and the lap that DOES count, which must still be deleted. Suppressing
    // this one would be a worse bug than the one being fixed.
    { kind: 'other', lap: 'flying', deleted: true, strikes: 1, announced: 1,
      why: 'a flying lap in an LTCS is deleted for track limits (Art. B1.9.4)' },
    // A race has no untimed laps and its own strike ladder, untouched.
    { kind: 'race', lap: 'out', deleted: false, strikes: 1, announced: 1,
      why: 'a race counts every excursion — there is no such thing as an ' +
        'untimed lap in one' },
    { kind: 'race', lap: 'flying', deleted: false, strikes: 1, announced: 1,
      why: 'a race counts every excursion' },
  ];

  for (const e of expectations) {
    const got = excursion(engine, s, e.kind, e.lap);
    const label = e.kind === 'race' ? 'race' : 'quali';
    console.log(
      def.id.padEnd(15) + label.padEnd(10) + e.lap.padEnd(15) +
      (got.deleted ? 'yes' : ' no').padStart(7) +
      String(got.strikes).padStart(9) + String(got.announced).padStart(11));
    if (got.deleted !== e.deleted) {
      fail(def.id + ' ' + label + ' ' + e.lap + '-lap: the lap was ' +
        (got.deleted ? '' : 'not ') + 'deleted — ' + e.why);
    }
    if (got.strikes !== e.strikes) {
      fail(def.id + ' ' + label + ' ' + e.lap + '-lap: ' + got.strikes +
        ' strike(s) recorded, expected ' + e.strikes + ' — ' + e.why);
    }
    if (got.announced !== e.announced) {
      fail(def.id + ' ' + label + ' ' + e.lap + '-lap: race control said ' +
        got.announced + ' thing(s) about track limits, expected ' + e.announced +
        ' — ' + e.why);
    }
  }
}

console.log('');
if (failures.length === 0) {
  console.log('PASS — the line is on both sides everywhere, the rule is');
  console.log('applied at its outer edge, and only a lap that carries a time');
  console.log('can lose one.');
} else {
  console.log('FAIL (' + failures.length + ')');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
