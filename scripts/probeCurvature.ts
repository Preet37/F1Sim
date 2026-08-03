import { TrackSpline, MIN_EDGE_ADVANCE } from '../src/track/TrackSpline';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { REAL_GEOMETRY } from '../src/data/tracks/realGeometry';

/**
 * Compares the curvature of the authored layouts against the surveyed ones.
 *
 * The surveyed shapes solve about 14% slower, and there are only two ways that
 * can happen: either the real circuits genuinely have tighter corners than the
 * hand-authored approximations, or the conversion has left high-frequency
 * wiggle in the centreline that the speed solver reads as corners and brakes
 * for. Those two causes need completely different fixes, so the first job is to
 * tell them apart.
 *
 * The discriminator is WHERE the curvature lives. Real corners are long, smooth
 * arcs — high curvature sustained over tens of metres. Conversion noise is
 * high curvature that flips sign every few nodes. Measuring the mean absolute
 * curvature tells you how bent the track is; measuring how often curvature
 * changes sign tells you whether that bend is real.
 */

const rows: string[] = [];
let sumRealOsc = 0;
let sumAuthOsc = 0;
let sumRealAbs = 0;
let sumAuthAbs = 0;
let n = 0;

console.log(
  'circuit'.padEnd(13) +
  '  authored: |k|      flips/km' +
  '   surveyed: |k|      flips/km',
);

for (const def of CIRCUITS) {
  if (!REAL_GEOMETRY[def.id]) continue;

  // Build BOTH splines explicitly rather than relying on whichever geometry the
  // USE_REAL_GEOMETRY flag happens to select — otherwise, with the flag off,
  // this compares the authored layout against itself and reports a perfect
  // match no matter how bad the conversion is.
  const authored = new TrackSpline({
    ...def,
    controlPoints: def.authoredControlPoints ?? def.controlPoints,
  });
  const surveyed = new TrackSpline({
    ...def,
    controlPoints: REAL_GEOMETRY[def.id].points,
  });

  const stats = (t: TrackSpline) => {
    let absSum = 0;
    let flips = 0;
    for (let i = 0; i < t.count; i++) {
      const k = t.curvature[i];
      absSum += Math.abs(k);
      const nxt = t.curvature[(i + 1) % t.count];
      // A sign change with meaningful magnitude on both sides is an
      // oscillation; near-zero crossings on a straight are not.
      if (k * nxt < 0 && Math.abs(k) > 0.002 && Math.abs(nxt) > 0.002) flips++;
    }
    return {
      meanAbs: absSum / t.count,
      flipsPerKm: (flips / t.length) * 1000,
    };
  };

  const a = stats(authored);
  const s = stats(surveyed);
  sumAuthOsc += a.flipsPerKm;
  sumRealOsc += s.flipsPerKm;
  sumAuthAbs += a.meanAbs;
  sumRealAbs += s.meanAbs;
  n++;

  rows.push(
    def.id.padEnd(13) +
    `  ${a.meanAbs.toFixed(5)}   ${a.flipsPerKm.toFixed(1).padStart(6)}` +
    `      ${s.meanAbs.toFixed(5)}   ${s.flipsPerKm.toFixed(1).padStart(6)}` +
    `   lap ${authored.referenceLapTime.toFixed(1)}s -> ${surveyed.referenceLapTime.toFixed(1)}s`,
  );
}

for (const r of rows) console.log(r);
console.log('');
console.log(`mean curvature sign-flips per km: authored ${(sumAuthOsc / n).toFixed(1)}, surveyed ${(sumRealOsc / n).toFixed(1)}`);
console.log('');
// Verdict from the two signals together, not from oscillation alone.
//
// An earlier version of this compared flips-per-km against 1.5x the authored
// figure — but the authored layouts are idealised arcs and straights and score
// exactly 0.0, so ANY oscillation at all cleared the threshold and the script
// confidently reported "conversion noise" on evidence of 0.2 flips per km.
// A ratio test against zero is not a test.
const oscillating = sumRealOsc / n > 2;
const curvatureRatio = sumRealAbs / sumAuthAbs;

console.log(`mean |curvature| ratio surveyed/authored: ${curvatureRatio.toFixed(2)}x`);
console.log('');
if (oscillating) {
  console.log('VERDICT: the surveyed centrelines oscillate — conversion noise. Smooth harder.');
} else if (curvatureRatio > 1.15) {
  console.log(
    'VERDICT: the surveyed lines are smooth but genuinely more curved ' +
    `(${curvatureRatio.toFixed(2)}x). This is real: the authored layouts are idealised ` +
    'straights and constant-radius arcs, whereas real circuits curve continuously. ' +
    'The speed solver treats all of that curvature as cornering constraint, so it ' +
    'brakes for bends a real car takes flat. The fix is in the solver and the racing ' +
    'line, not in the conversion.',
  );
} else {
  console.log('VERDICT: the two geometries are comparable.');
}

// ===========================================================================
// DOES THE ROAD FOLD OVER ITSELF?
// ===========================================================================
//
// The section above asks how bent the centreline is. This one asks whether the
// road that is swept along it is a surface at all, which is a different
// question with a hard answer.
//
// A road is a ribbon `width` across. Across a span from node i to node j its
// inner edge advances by
//
//     1 - halfWidth_j * |n_j . t_i| / ((p_j - p_i) . t_i)
//
// of the centreline's own rate. At 1 the edge keeps pace — a straight. Below 1
// it is the inside of a corner. AT ZERO IT HAS STOPPED and the quad has
// collapsed to a triangle with a cusp; BELOW ZERO the edge runs backwards, the
// quad is a bowtie and the asphalt is folded over itself. There is then no
// pocket for a kerb, no strip of ground beside the road to draw, and a gap in
// the white line — on screen all three are one thing, the hole at the apex.
// COTA's turn eleven reached -0.181 against a 7.5m half-width and Bahrain's
// turn ten 0.001. Ten nodes on the calendar were at or through zero.
//
// TWO MEASURES ARE PRINTED AND THEY ARE NOT THE SAME.
//
//   nodeAdv is `1 - halfWidth * |curvature|`, which is how issue #4 quoted the
//     defect. It reads the SMOOTHED curvature array, which is the right input
//     for the speed solver and the wrong one here — a fold is a property of two
//     adjacent quads, and smoothing spreads a cusp across its neighbours.
//   spanAdv is the expression above, evaluated on the same two spans that bound
//     each node. It is what `narrowWhereTheInnerEdgeFolds` holds and what the
//     mesh actually sweeps, so it is the one the verdict is taken from.
//
// The threshold is `MIN_EDGE_ADVANCE`, imported rather than copied: the number
// asserted here has to BE the number the geometry pass enforces, or this is
// just a second opinion that can drift away from what is built.
const advRows: string[] = [];
let worstSpan = Infinity;
let worstSpanAt = '';
let folded = 0;
let underMargin = 0;

console.log('');
console.log('='.repeat(96));
console.log('INNER-EDGE ADVANCE — does the ribbon still go forwards on the inside of a corner?');
console.log('='.repeat(96));
console.log(
  'circuit'.padEnd(14) +
  'tightest R'.padStart(12) + 'half-w'.padStart(9) +
  'min nodeAdv'.padStart(13) + '@s'.padStart(8) +
  'min spanAdv'.padStart(13) + '@s'.padStart(8) +
  'folds'.padStart(7) + 'under'.padStart(7),
);

for (const def of CIRCUITS) {
  const t = new TrackSpline(def);
  let minNode = Infinity;
  let minNodeS = 0;
  let tightR = Infinity;
  let hwAtR = 0;

  for (let i = 0; i < t.count; i++) {
    const hw = t.width[i] * 0.5;
    const k = Math.abs(t.curvature[i]);
    const adv = 1 - hw * k;
    if (adv < minNode) { minNode = adv; minNodeS = t.dist[i]; }
    if (k > 1e-9 && 1 / k < tightR) { tightR = 1 / k; hwAtR = hw; }
  }

  /**
   * The advance of the inner edge across one span, in the frame of the node the
   * span is measured FROM. `dir` is +1 when that is the lower-numbered node.
   *
   * Only one side is ever on the inside of a turn, and the other advances
   * faster than the centreline, so the magnitude of the swing answers for
   * whichever side that is. Distances are against the centreline's own step
   * across this span rather than the nominal node spacing: the resampler places
   * nodes at uniform ARCLENGTH, so where the curve bends hard between two
   * samples the chord is shorter than the arc — 1.6m against a nominal 3m at
   * Monaco's hairpin — and dividing by the nominal figure reports a fold that
   * is in the denominator.
   */
  const spanAdvance = (k: number, f: number, dir: 1 | -1): number => {
    const ux = t.tx[f] * dir;
    const uz = t.tz[f] * dir;
    const along = (t.px[k] - t.px[f]) * ux + (t.pz[k] - t.pz[f]) * uz;
    if (along <= 0) return Number.NaN;
    const swing = t.nx[k] * ux + t.nz[k] * uz;
    return 1 - (t.width[k] * 0.5 * Math.abs(swing)) / along;
  };

  let minSpan = Infinity;
  let minSpanS = 0;
  let circuitFolds = 0;
  let circuitUnder = 0;
  for (let i = 0; i < t.count; i++) {
    const j = (i + 1) % t.count;
    for (const a of [spanAdvance(j, i, 1), spanAdvance(i, j, -1)]) {
      if (!Number.isFinite(a)) continue;
      if (a < minSpan) { minSpan = a; minSpanS = t.dist[i]; }
      if (a <= 0) circuitFolds++;
      else if (a < MIN_EDGE_ADVANCE - 1e-9) circuitUnder++;
    }
  }
  folded += circuitFolds;
  underMargin += circuitUnder;
  if (minSpan < worstSpan) { worstSpan = minSpan; worstSpanAt = `${def.id} s=${minSpanS.toFixed(0)}`; }

  advRows.push(
    def.id.padEnd(14) +
    `${tightR.toFixed(1)}m`.padStart(12) + `${hwAtR.toFixed(2)}m`.padStart(9) +
    minNode.toFixed(3).padStart(13) + minNodeS.toFixed(0).padStart(8) +
    minSpan.toFixed(3).padStart(13) + minSpanS.toFixed(0).padStart(8) +
    String(circuitFolds).padStart(7) + String(circuitUnder).padStart(7),
  );
}

for (const r of advRows) console.log(r);
console.log('');
console.log(`margin held by the geometry: MIN_EDGE_ADVANCE = ${MIN_EDGE_ADVANCE.toFixed(2)}`);
console.log(`worst span advance on the calendar: ${worstSpan.toFixed(3)} (${worstSpanAt})`);
console.log('');
if (folded > 0) {
  console.log(`FAIL — ${folded} spans have an inner edge that has stopped or reversed. The asphalt`);
  console.log('folds over itself there: no kerb pocket, no shoulder, and a gap in the white line.');
  process.exitCode = 1;
} else if (underMargin > 0) {
  console.log(`FAIL — ${underMargin} spans advance less than ${MIN_EDGE_ADVANCE} of the centreline's`);
  console.log('rate on the inside. Nothing is folded yet, but the geometry no longer holds the');
  console.log('margin it is built to hold, so the next thing that touches the width will fold it.');
  process.exitCode = 1;
} else {
  console.log(`PASS — every span on all ${CIRCUITS.length} circuits keeps at least ` +
    `${MIN_EDGE_ADVANCE} of the centreline's`);
  console.log('rate on its inner edge. The road is a surface everywhere; nothing folds.');
}
