import { TrackSpline } from '../src/track/TrackSpline';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';
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
