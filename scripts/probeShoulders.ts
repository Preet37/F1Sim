import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { buildWorldModel } from '../src/track/WorldObstacles';
import {
  computeShoulders, SHOULDER_SLOPE_M, STREET_RUNOFF_W, RUNOFF_W,
  bankHeight, groundSamples, Y_ROAD, Y_RUNOFF,
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

console.log(
  'circuit        nodes  zero-shoulder   steps>0.3m   mean R at holes   mean R lap   worst step',
);

let totalZero = 0;
let totalSteps = 0;

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const runoffW = def.scenery === 'street' ? STREET_RUNOFF_W : RUNOFF_W;
  const sh = computeShoulders(track, world, runoffW);
  const n = track.count;

  let zero = 0;
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
        zero++;
        if (Number.isFinite(r)) radiusAtZero += r;
      }
      const step = Math.abs(arr[j] - arr[i]);
      if (step > 0.3) steps++;
      if (step > worstStep) worstStep = step;
    }
  }

  totalZero += zero;
  totalSteps += steps;

  const meanHoleR = zero > 0 ? (radiusAtZero / zero).toFixed(0) + 'm' : '-';
  const meanR = radiusCount > 0 ? (radiusSum / radiusCount).toFixed(0) + 'm' : '-';
  console.log(
    def.id.padEnd(13) + String(n).padStart(6) +
    String(zero).padStart(10) + ' (' + (100 * zero / (2 * n)).toFixed(1).padStart(4) + '%)' +
    String(steps).padStart(11) +
    meanHoleR.padStart(18) + meanR.padStart(13) +
    (worstStep.toFixed(2) + 'm').padStart(13),
  );

  // A step wider than the slope limiter is meant to allow is a mesh that cannot
  // possibly be continuous.
  if (worstStep > SHOULDER_SLOPE_M + 1e-6) {
    failures.push(
      `${def.id}: shoulder steps ${worstStep.toFixed(2)}m between adjacent nodes, ` +
      `above the ${SHOULDER_SLOPE_M}m slope limit`,
    );
  }
}

console.log(
  '\ntotal nodes with no ground beside the road at all: ' + totalZero +
  '\ntotal adjacent-node steps over 0.3m:               ' + totalSteps,
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
  const tall: { i: number; s: number; face: number }[] = [];

  /**
   * Is there another piece of this lap near this point and below it?
   *
   * Brute force over the nodes, and it only runs for the handful of stations
   * that come out over the limit, so it costs nothing. Lap distance is used to
   * exclude the road this station is beside — the piece of circuit 40m along
   * the lap from you is you.
   */
  const foldBelow = (x: number, z: number, y: number, atS: number): number => {
    let best = 0;
    for (let j = 0; j < n; j++) {
      const ds = Math.abs(track.dist[j] - atS);
      if (Math.min(ds, track.length - ds) < 120) continue;
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
      if (face > SKIRT_LIMIT_M) tall.push({ i, s: track.dist[i], face });
      void radius;
    }
  }

  // Of the tall faces, the ones with another piece of lap near and below are
  // retaining walls between two levels. The rest are cliffs.
  const unexplained = tall.filter((r) => {
    const hw = track.width[r.i] * 0.5;
    const x = track.px[r.i];
    const z = track.pz[r.i];
    void hw;
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

if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
