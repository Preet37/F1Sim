import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { buildWorldModel } from '../src/track/WorldObstacles';
import { computeShoulders, SHOULDER_SLOPE_M, STREET_RUNOFF_W, RUNOFF_W } from '../src/render/TrackMesh';

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

if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
