import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline, MIN_EDGE_ADVANCE } from '../src/track/TrackSpline';
import { buildWorldModel } from '../src/track/WorldObstacles';
import {
  computeShoulders, SHOULDER_SLOPE_M, STREET_RUNOFF_W, RUNOFF_W,
  bankHeight, groundSamples, Y_ROAD, Y_RUNOFF, KERB_ROOM_M,
} from '../src/render/TrackMesh';
import { TerrainField, buildTerrainMesh } from '../src/render/Terrain';

/**
 * The hole at the apex.
 *
 * The report was exact — *"when turning on certain corners its still showing
 * the hole? ... what is this hole at the curve?"* — and the two words that
 * matter in it are "certain corners". A defect that appears at some corners and
 * not at others, and never on a straight, is a function of RADIUS, and a
 * function of radius can be measured without rendering anything.
 *
 * What is drawn beside the road is three strips: run-off from the white line
 * outward, verge from there to the barrier, and a vertical skirt dropping off
 * the outer edge of the verge to the ground plane. All three are cut off at
 * `computeShoulders`, which reports how much room there is between this piece of
 * road and the next piece of road the lap folds back onto. Two things it can do
 * produce a hole:
 *
 *   ZERO. Where the shoulder is zero the mesh builder drew nothing at all — no
 *   run-off, no verge, no skirt — so what showed through was the ground plane,
 *   two thirds of a metre below and unlit at night. A wedge of that at the edge
 *   of the road, opening and closing as the shoulder does, is exactly a hole you
 *   can see through. Nodes at zero are counted here.
 *
 *   STEPPING. The width is slope-limited to `SHOULDER_SLOPE_M` per node, and
 *   the strips were swept span by span at the NARROWER of the span's two ends.
 *   That makes the outer edge a staircase rather than a curve: two neighbouring
 *   spans end their skirts at different distances from the road, and the gap
 *   between the two vertical faces is a slot from verge level all the way down
 *   to the ground plane. Steps are counted here too.
 *
 * Both are worst where the shoulder is changing fastest, which is where the
 * road curves hardest, which is why it is "certain corners". The table below
 * prints the correlation directly: the mean radius at the nodes with no
 * shoulder against the mean radius over the whole lap.
 *
 * Run: npm run probe:shoulders
 */

const failures: string[] = [];

/**
 * Node-sides where the lap crosses OVER ITSELF, so no shoulder can exist.
 *
 * Suzuka is a figure of eight. Where the two legs meet there is no width, not
 * even half a metre, at which the ground beside one of them is clear of the
 * other — and drawing the narrowest strip that fits would put a vertical face
 * of grass through the middle of a racing surface, which is worse than the gap
 * it replaces. A zero shoulder is the RIGHT answer at a crossing, so the count
 * above has to be able to tell one from a defect, and it has to do it from the
 * geometry rather than from a circuit name or a range of `s`.
 *
 * Two tests, and both are needed:
 *
 *   THE ROADS OVERLAP. Another part of the lap is close enough that its
 *   asphalt covers the ground this node's shoulder would be drawn on. That is
 *   what costs the shoulder, and on its own it is also true of two legs
 *   running side by side, which is a squeeze and not a crossing.
 *
 *   AND THE CENTRELINES CROSS. Somewhere in the contiguous run of overlap the
 *   two polylines properly intersect. Two roads running past each other never
 *   do; two roads that meet always do. This is the test that makes the
 *   exclusion a crossing test rather than a proximity test, and it is why the
 *   run is flood-filled from the intersection instead of taken within some
 *   radius of it — the extent of a crossing is however far the two roads
 *   actually overlap, which depends on their angle and their widths, and is
 *   not a number to pick.
 *
 * `MIN_LAP_GAP_M` only has to exclude a node's own neighbourhood. A corner
 * that folds back on itself does so within a couple of hundred metres of lap;
 * Suzuka's crossover is 2340m apart along the lap.
 */
function crossingNodes(track: TrackSpline): Uint8Array {
  const n = track.count;
  const MIN_LAP_GAP_M = 250;
  /** How far out from the road edge a shoulder has to reach to exist. */
  const REACH_M = 1;

  const lapGap = (a: number, b: number): number => {
    const d = Math.abs(track.dist[a] - track.dist[b]);
    return Math.min(d, track.length - d);
  };

  // 1. Which nodes have another leg's asphalt over their shoulder.
  const overlap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hi = track.width[i] * 0.5;
    for (let j = 0; j < n; j++) {
      if (lapGap(i, j) < MIN_LAP_GAP_M) continue;
      const reach = hi + track.width[j] * 0.5 + REACH_M;
      const dx = track.px[j] - track.px[i];
      const dz = track.pz[j] - track.pz[i];
      if (dx * dx + dz * dz > reach * reach) continue;
      overlap[i] = 1;
      break;
    }
  }

  // 2. Where the centrelines properly intersect.
  const crosses = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!overlap[i]) continue;
    const i1 = (i + 1) % n;
    const ax = track.px[i], az = track.pz[i];
    const bx = track.px[i1], bz = track.pz[i1];
    for (let j = 0; j < n; j++) {
      if (lapGap(i, j) < MIN_LAP_GAP_M) continue;
      const j1 = (j + 1) % n;
      const cx = track.px[j], cz = track.pz[j];
      const dx2 = track.px[j1], dz2 = track.pz[j1];
      const r0 = bx - ax, r1 = bz - az;
      const s0 = dx2 - cx, s1 = dz2 - cz;
      const den = r0 * s1 - r1 * s0;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * s1 - (cz - az) * s0) / den;
      const u = ((cx - ax) * r1 - (cz - az) * r0) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      crosses[i] = 1;
      crosses[i1] = 1;
      break;
    }
  }

  // 3. A run of overlap that contains an intersection is a crossing, all of it.
  const out = new Uint8Array(n);
  if (!crosses.some((v) => v === 1)) return out;
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || !overlap[start]) continue;
    const run: number[] = [];
    let k = start;
    // Walk back to the head of the run first, so a run is only walked once.
    while (overlap[(k - 1 + n) % n] && (k - 1 + n) % n !== start) k = (k - 1 + n) % n;
    let hasCross = false;
    do {
      run.push(k);
      seen[k] = 1;
      if (crosses[k]) hasCross = true;
      k = (k + 1) % n;
    } while (overlap[k] && !seen[k]);
    if (hasCross) for (const q of run) out[q] = 1;
  }
  return out;
}

console.log(
  'circuit        nodes  zero-shoulder   steps>0.3m   mean R at holes   mean R lap   worst step'
  + '   at a crossing',
);

let totalZero = 0;
let totalCrossing = 0;
let totalSteps = 0;

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const runoffW = def.scenery === 'street' ? STREET_RUNOFF_W : RUNOFF_W;
  const sh = computeShoulders(track, world, runoffW);
  const n = track.count;

  const crossing = crossingNodes(track);

  let zero = 0;
  let atCrossing = 0;
  let steps = 0;
  let worstStep = 0;
  let radiusAtZero = 0;
  let radiusSum = 0;
  let radiusCount = 0;

  const radius = (i: number): number =>
    track.curvature[i] !== 0 ? 1 / Math.abs(track.curvature[i]) : Infinity;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const r = radius(i);
    if (Number.isFinite(r)) { radiusSum += r; radiusCount++; }
    for (const arr of [sh.left, sh.right]) {
      if (arr[i] <= 0) {
        if (crossing[i]) {
          atCrossing++;
        } else {
          zero++;
          if (Number.isFinite(r)) radiusAtZero += r;
        }
      }
      const step = Math.abs(arr[j] - arr[i]);
      if (step > 0.3) steps++;
      if (step > worstStep) worstStep = step;
    }
  }

  totalZero += zero;
  totalCrossing += atCrossing;
  totalSteps += steps;

  const meanHoleR = zero > 0 ? (radiusAtZero / zero).toFixed(0) + 'm' : '-';
  const meanR = radiusCount > 0 ? (radiusSum / radiusCount).toFixed(0) + 'm' : '-';
  console.log(
    def.id.padEnd(13) + String(n).padStart(6) +
    String(zero).padStart(10) + ' (' + (100 * zero / (2 * n)).toFixed(1).padStart(4) + '%)' +
    String(steps).padStart(11) +
    meanHoleR.padStart(18) + meanR.padStart(13) +
    (worstStep.toFixed(2) + 'm').padStart(13) +
    String(atCrossing).padStart(16),
  );

  // A step wider than the slope limiter is meant to allow is a mesh that cannot
  // possibly be continuous.
  if (worstStep > SHOULDER_SLOPE_M + 1e-6) {
    failures.push(
      `${def.id}: shoulder steps ${worstStep.toFixed(2)}m between adjacent nodes, ` +
      `above the ${SHOULDER_SLOPE_M}m slope limit`,
    );
  }
  if (zero > 0) {
    failures.push(
      `${def.id}: ${zero} node-sides with no ground beside the road, and no ` +
      'crossing to explain them',
    );
  }
}

console.log(
  '\ntotal nodes with no ground beside the road at all: ' + totalZero +
  '\n  ...and a further ' + totalCrossing + ' where the lap crosses over itself, which is' +
  '\n     correct: the other leg IS the ground beside this one. Detected from the' +
  '\n     geometry — roads overlapping and centrelines actually intersecting — not' +
  '\n     from a circuit name. All of them are Suzuka\'s figure-of-eight, at' +
  '\n     s=2274..2304 against s=4643..4673, 2340m apart along the lap and within' +
  '\n     0.6m of each other in plan.' +
  '\ntotal adjacent-node steps over 0.3m:               ' + totalSteps,
);
// ===========================================================================
// The fold: where the road is wider than the corner is round
// ===========================================================================
//
// The road is swept as a ribbon `width` metres across the centreline. Its
// INNER edge therefore advances more slowly than the centreline does, by the
// factor `1 - halfWidth * curvature`, and that factor is the whole story:
//
//   1     a straight; the two edges and the centre move together
//   0.3   the limit held by `narrowWhereTheInnerEdgeFolds`
//   0     the inner edge has STOPPED. The span's quad is a triangle with a
//         cusp on the inside of the corner, and the shoulder scan finds the
//         node's own asphalt wrapped around the point where its shoulder
//         would go.
//   <0    the inner edge is running BACKWARDS. The quad is a bowtie: asphalt
//         folded over itself, no pocket for a kerb, and the white line
//         crossing itself. `validate:limits` reported it as a 6m gap in
//         Monaco's left-hand line and a 3m gap in COTA's.
//
// Measured here from the drawn edge polyline rather than from `curvature`,
// because `curvature` is smoothed over five nodes and the fold is not: at
// COTA s=3431 the smoothed radius read 14m while the polyline was turning
// inside 5.1m and the advance factor was -0.165.
//
// As authored the calendar had ten of these. What produced them is in
// `easeCentrelineKinks`: the surveyed traces carry a control point every 25m,
// so a hairpin arrives as one 85-130 degree vertex and resampling puts nearly
// all of the turn into a single 3m node.
// Imported, not repeated, so the number the pass holds and the number the
// probe checks cannot drift apart.
const MIN_ADVANCE = MIN_EDGE_ADVANCE;
console.log(
  'circuit      worst advance      where        R      half-width   nodes under ' +
  MIN_ADVANCE.toFixed(2),
);
let foldTotal = 0;
for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const n = track.count;
  const nodeM = track.length / n;
  let worst = Infinity;
  let worstI = -1;
  let worstSide = 1;
  let under = 0;
  const rows: string[] = [];

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const hi = track.width[i] * 0.5;
    const hj = track.width[j] * 0.5;
    // The centreline's own step across this span. NOT the nominal node
    // spacing: the resampler places nodes at uniform arclength along a dense
    // curve, and where that curve bends hard between two samples the chord
    // between them is far shorter than the arc — 1.6m against a nominal 3m at
    // Monaco's hairpin. The advance is a RATIO of the edge's progress to the
    // centreline's, so both have to be measured the same way.
    const centre = (track.px[j] - track.px[i]) * track.tx[i]
      + (track.pz[j] - track.pz[i]) * track.tz[i];
    if (centre <= 1e-6) continue;
    for (const side of [-1, 1] as const) {
      const ex = (track.px[j] + track.nx[j] * side * hj) - (track.px[i] + track.nx[i] * side * hi);
      const ez = (track.pz[j] + track.nz[j] * side * hj) - (track.pz[i] + track.nz[i] * side * hi);
      const adv = (ex * track.tx[i] + ez * track.tz[i]) / centre;
      if (adv < worst) { worst = adv; worstI = i; worstSide = side; }
      if (adv >= MIN_ADVANCE - 1e-3) continue;
      under++;
      if (rows.length < 6) {
        rows.push(
          '    s=' + track.dist[i].toFixed(0).padStart(5) + '  ' + (side > 0 ? 'left ' : 'right') +
          '  advance ' + adv.toFixed(3).padStart(7) +
          '  half-width ' + hi.toFixed(2) + 'm',
        );
      }
    }
  }
  foldTotal += under;

  // The discrete radius the centreline actually turns through at that node,
  // from the two chords meeting there — not the smoothed `curvature`.
  const discreteR = (i: number): number => {
    const p = (i - 1 + n) % n;
    const q = (i + 1) % n;
    const a1 = Math.atan2(track.pz[i] - track.pz[p], track.px[i] - track.px[p]);
    const a2 = Math.atan2(track.pz[q] - track.pz[i], track.px[q] - track.px[i]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) < 1e-9 ? Infinity : nodeM / Math.abs(d);
  };

  const r = discreteR(worstI);
  console.log(
    def.id.padEnd(13) + worst.toFixed(3).padStart(9) +
    ('s=' + track.dist[worstI].toFixed(0) + ' ' + (worstSide > 0 ? 'L' : 'R')).padStart(14) +
    (Number.isFinite(r) ? r.toFixed(1) + 'm' : '-').padStart(11) +
    ((track.width[worstI] * 0.5).toFixed(2) + 'm').padStart(13) +
    String(under).padStart(14),
  );
  for (const row of rows) console.log(row);

  if (under > 0) {
    failures.push(
      `${def.id}: ${under} node-sides where the inner edge of the road advances ` +
      `less than ${MIN_ADVANCE} of the centreline's rate — worst ${worst.toFixed(3)} ` +
      `at s=${track.dist[worstI].toFixed(0)}m. The road is wider than the corner is round`,
    );
  }
}
console.log(
  '\ntotal node-sides where the road folds towards itself: ' + foldTotal + '\n' +
  '\nBefore `easeCentrelineKinks` and `narrowWhereTheInnerEdgeFolds` this table\n' +
  'read 18 node-sides under 0.30 on six circuits: COTA -0.201 at s=3434 and\n' +
  '-0.170 at s=3431, both self-intersecting, on a 5.1m discrete radius against a\n' +
  '7.50m half-width; Bahrain 0.007 at s=2544 and 0.010 at s=2547; Monza 0.082 at\n' +
  's=621; Spa 0.080 at s=207; Monaco 0.111 at s=333. Those same nodes were 17 of\n' +
  'the calendar\'s 49 zero shoulders and the 6m and 3m gaps `validate:limits`\n' +
  'found in Monaco\'s and COTA\'s white lines.\n',
);

console.log(
  '\nThese are counts of PLACES, not of holes. Whether a step is a visible slot\n' +
  'depends on how the strips between them are swept — see `buildTrackMeshes`,\n' +
  'which now interpolates the width across every span so the outer edge is a\n' +
  'continuous polyline and the skirt below it a continuous wall.\n',
);

// ===========================================================================
// The SECOND hole, which is a cliff
// ===========================================================================
//
// The width defect above was real and is fixed. It is not what the next round
// of screenshots showed. Those showed the outside of a corner sitting on a
// raised sand plateau walled all the way round by a vertical face several
// car-heights tall — *"the tracks on the turns at least some of them still has
// that hugee hole"* — with the car stopped at the bottom of it.
//
// That is a defect in HEIGHT, not in width, and it has two independent causes.
// Both are measured here, per node, per side, on every circuit.
//
//   BOUNDARY. Where the run-off meets the road there must be nothing to fall
//   down. Both surfaces are swept from the same station at the same lateral, so
//   this should be the 2cm of paint clearance and nothing else. Reported so the
//   claim is checked rather than assumed.
//
//   CROSS-SLOPE. Banking was applied as `-lat * tan(bank)` with no limit on
//   lat, and lat runs out to the barrier. At Zandvoort's 18-degree corners the
//   ground beside the road is 16.8m wide, so its outer edge was drawn 7.4m
//   above the racing surface on one side and 7.4m below it on the other.
//
//   SKIRT. The vertical face closing the gap between the outer edge of the
//   ground beside the road and the world beyond it. The world used to be a
//   single flat quad at y = -0.62 while the circuit climbs to 6m at Bahrain, 40
//   at COTA and 58 at Spa — so this face was as tall as the circuit is high,
//   everywhere, all the way round. It is the cliff in the screenshots.
//
// A correct circuit has all three within a few tens of centimetres.
const SKIRT_LIMIT_M = 2.0;
const CROSS_LIMIT_M = 2.5;
/**
 * How close and how far below another piece of the lap has to be for a tall
 * face to be a retaining wall rather than a cliff.
 *
 * Where the circuit runs back alongside itself at a different height — Suzuka's
 * crossover, Monaco under the Casino, Zandvoort's back section — no height
 * field can put ground at both levels in the same place, and the step between
 * them is a wall. That is a real thing at a real circuit. What is NOT is a face
 * with open ground on the other side of it, which is what the whole calendar
 * had.
 */
const FOLD_NEAR_M = 60;

console.log(
  'circuit       boundary  cross-slope at outer edge     skirt face height        over 2m'
  + '        drawn ground\n'
  + '                  max     mean     p95     max      mean     p95     max    tot / unexplained'
  + '   above run-off',
);

let worstSkirtAll = 0;
let unexplainedAll = 0;

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const runoffW = def.scenery === 'street' ? STREET_RUNOFF_W : RUNOFF_W;
  const sh = computeShoulders(track, world, runoffW);
  const n = track.count;

  // Exactly what `buildTrackMeshes` builds the ground from — the same call, so
  // there is no second implementation to drift.
  const terrain = new TerrainField(track, groundSamples(track, sh));
  // And the mesh that field actually becomes, so what is measured is what is
  // drawn. A field that is right and a grid too coarse to follow it would put
  // ground back up through the run-off with every number here reading clean.
  const drawn = buildTerrainMesh(track, terrain);
  let meshOver = 0;

  let boundaryMax = 0;
  const cross: number[] = [];
  const skirt: number[] = [];
  const tall: { i: number; s: number; face: number; side: -1 | 1 }[] = [];

  /**
   * Is there another piece of this lap near this point and below it?
   *
   * Brute force over the nodes, and it only runs for the handful of stations
   * that come out over the limit, so it costs nothing.
   *
   * THE LAP-DISTANCE EXCLUSION IS NARROW ON PURPOSE. It exists to stop a
   * station explaining its face with the road it is itself beside, and 40m of
   * lap either way covers that with room to spare — a node's own road, run-off
   * and verge together reach nothing like that far. It used to be 120m, and at
   * three of the calendar's real climbs that is longer than the doubling-back
   * itself: COTA's turn one passes over its own approach 78m along the lap and
   * 7m above it, Spa's climb out of La Source 87m and 7m, and both were being
   * told they had open ground below them when they have a hillside. The
   * requirement that the other piece be genuinely LOWER is what does the real
   * work here; lap distance only has to exclude your own feet.
   */
  const foldBelow = (x: number, z: number, y: number, atS: number): number => {
    let best = 0;
    for (let j = 0; j < n; j++) {
      const ds = Math.abs(track.dist[j] - atS);
      if (Math.min(ds, track.length - ds) < 40) continue;
      const dx = track.px[j] - x;
      const dz = track.pz[j] - z;
      if (dx * dx + dz * dz > FOLD_NEAR_M * FOLD_NEAR_M) continue;
      const drop = y - track.elevation[j];
      if (drop > best) best = drop;
    }
    return best;
  };

  for (let i = 0; i < n; i++) {
    const hw = track.width[i] * 0.5;
    const bank = track.banking[i];
    const elev = track.elevation[i];
    const radius = track.curvature[i] !== 0 ? 1 / Math.abs(track.curvature[i]) : Infinity;

    for (const side of [-1, 1] as const) {
      const w = (side > 0 ? sh.left : sh.right)[i];
      if (w <= 0) continue;

      // The road's outer edge and the run-off's inner edge, as drawn.
      const edgeLat = side * hw;
      const roadY = elev + bankHeight(bank, edgeLat, hw) + Y_ROAD;
      const innerY = elev + bankHeight(bank, edgeLat, hw) + Y_RUNOFF;
      boundaryMax = Math.max(boundaryMax, Math.abs(roadY - innerY));

      // The outer edge of the ground beside the road, and the drop from it.
      const outLat = side * (hw + w);
      const outY = elev + bankHeight(bank, outLat, hw) + Y_RUNOFF;
      cross.push(Math.abs(outY - innerY));

      const x = track.px[i] + track.nx[i] * outLat;
      const z = track.pz[i] + track.nz[i] * outLat;
      const face = outY - terrain.heightAt(x, z);
      skirt.push(face);
      // How far the DRAWN ground rises above the run-off it is beside. Positive
      // is grass standing in the run-off; it must not happen anywhere.
      meshOver = Math.max(meshOver, drawn.sampleAt(x, z) - outY);
      if (face > SKIRT_LIMIT_M) tall.push({ i, s: track.dist[i], face, side });
      void radius;
    }
  }

  // Of the tall faces, the ones with another piece of lap near and below are
  // retaining walls between two levels. The rest are cliffs.
  // Asked AT THE FACE, not at the centreline. The face stands at the outer edge
  // of the ground beside the road, which is up to 16.75m away across, and what
  // is under the centreline says nothing about what is under a point sixteen
  // metres from it — on the inside of a hill climb it is the difference between
  // finding the lower leg and missing it entirely. The half-width was already
  // being computed here and then discarded with a `void`; this is that offset
  // finally being applied.
  const unexplained = tall.filter((r) => {
    const hw = track.width[r.i] * 0.5;
    const w = (r.side > 0 ? sh.left : sh.right)[r.i];
    const outLat = r.side * (hw + w);
    const x = track.px[r.i] + track.nx[r.i] * outLat;
    const z = track.pz[r.i] + track.nz[r.i] * outLat;
    return foldBelow(x, z, track.elevation[r.i], r.s) < r.face * 0.5;
  });
  unexplainedAll += unexplained.length;

  const stat = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    const mean = s.reduce((p, q) => p + q, 0) / (s.length || 1);
    return {
      mean,
      p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0,
      max: s[s.length - 1] ?? 0,
    };
  };
  const c = stat(cross);
  const k = stat(skirt);
  worstSkirtAll = Math.max(worstSkirtAll, k.max);

  const m = (v: number) => (v.toFixed(2) + 'm').padStart(8);
  console.log(
    def.id.padEnd(13) + m(boundaryMax) + m(c.mean) + m(c.p95) + m(c.max)
    + '  ' + m(k.mean) + m(k.p95) + m(k.max)
    + (String(tall.length) + ' / ' + String(unexplained.length)).padStart(15)
    + ('  mesh ' + meshOver.toFixed(2) + 'm').padStart(14),
  );

  if (meshOver > 0) {
    failures.push(
      `${def.id}: the drawn ground stands ${meshOver.toFixed(2)}m ABOVE the run-off ` +
      'beside it — the ground grid is too coarse to follow its own field',
    );
  }

  if (unexplained.length > 0) {
    const w = unexplained.reduce((p, q) => (q.face > p.face ? q : p));
    failures.push(
      `${def.id}: ${unexplained.length} stations where the ground beside the road ` +
      `drops over ${SKIRT_LIMIT_M}m to the terrain with nothing below to explain ` +
      `it — worst ${w.face.toFixed(2)}m at s=${w.s.toFixed(0)}m. That is a cliff ` +
      'around the circuit, not a lip',
    );
  }
  if (c.max > CROSS_LIMIT_M) {
    failures.push(
      `${def.id}: the outer edge of the ground beside the road is ${c.max.toFixed(2)}m ` +
      `off the racing surface it adjoins, above the ${CROSS_LIMIT_M}m limit — ` +
      'the banking is running out past the shoulder',
    );
  }
}

console.log(
  '\nBOUNDARY is the step where the run-off meets the road: it is the 2cm of\n' +
  'paint clearance and never was anything else, which is why the defect was not\n' +
  'found by looking there. CROSS-SLOPE is how far the OUTER edge of that ground\n' +
  'has moved away from the road by the time it reaches the barrier, and it is\n' +
  'banking. SKIRT is the vertical face from that outer edge down to the world\n' +
  'beyond — the cliff. Worst skirt on the calendar: ' + worstSkirtAll.toFixed(2) + 'm,\n' +
  'of which ' + unexplainedAll + ' stations have nothing below them to explain it.\n' +
  '\nBefore the ground became a height field these read: boundary 0.02m, cross-\n' +
  'slope up to 7.44m at Zandvoort, and a skirt on EVERY station of every circuit\n' +
  'equal to the local elevation plus 0.62m — 4.1m mean at Bahrain, 27.2m mean at\n' +
  'Spa, 58.6m worst on the calendar.\n',
);

// ===========================================================================
// The kerb the driver cannot see
// ===========================================================================
//
// This is where the width defect stops being a rendering complaint and starts
// being a driving one, and it is why the two reports arrived together.
//
// `RaceEngine.updateSurface` reads `isCurbLeft/Right` and, when the car's
// centre passes `halfWidth - 0.4`, hands every tyre on the car a kerb's grip
// instead of asphalt's — SURFACE_GRIP 0.85 against 1.00. That is a 15% step
// with no blend, and measured on a settled car it is worth about 0.4 degrees
// of extra rear slip angle at an apex.
//
// `buildTrackMeshes` draws a kerb only where the shoulder is wide enough to
// hold one. So wherever the shoulder was wrongly zeroed, the simulation put a
// grip change at a place the renderer left as plain asphalt with a metre drop
// beyond it: the driver clips the same apex on every lap, the car steps
// sideways every time, and there is nothing on screen where it happens.
//
// Before the shoulder scan stopped reading a corner's own road as an
// obstruction this was 458 node-sides on the calendar — 7.2% of all flagged
// kerbing, 10.6% at Bahrain, 18.9% at Monaco, 13.2% at COTA. What is left is
// a different defect, measured but not fixed here: at ten nodes across the
// calendar the authored centreline turns tighter than the road is wide, so the
// inside edge of the road has no forward progress at all and there is
// genuinely no pocket for a kerb to sit in. That wants the road narrowed, not
// the shoulder widened.
console.log('circuit'.padEnd(13) + 'flagged kerb'.padStart(14) + 'drawn'.padStart(8)
  + 'invisible'.padStart(11) + '   % the driver cannot see');
let flagAll = 0, missAll = 0;
for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const sh = computeShoulders(
    track, world, def.scenery === 'street' ? STREET_RUNOFF_W : RUNOFF_W,
  );
  let flagged = 0, drawn = 0;
  for (let i = 0; i < track.count; i++) {
    for (const side of [1, -1] as const) {
      if (!(side > 0 ? track.isCurbLeft[i] : track.isCurbRight[i])) continue;
      flagged++;
      if ((side > 0 ? sh.left : sh.right)[i] >= KERB_ROOM_M) drawn++;
    }
  }
  flagAll += flagged; missAll += flagged - drawn;
  console.log(
    def.id.padEnd(13) + String(flagged).padStart(14) + String(drawn).padStart(8) +
    String(flagged - drawn).padStart(11) +
    ('  ' + (100 * (flagged - drawn) / Math.max(1, flagged)).toFixed(1) + '%').padStart(14),
  );
}
console.log(
  `\ntotal flagged ${flagAll}, invisible ${missAll} ` +
  `(${(100 * missAll / Math.max(1, flagAll)).toFixed(1)}%) — was 458 (7.2%)\n`,
);

if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
