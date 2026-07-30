/**
 * Track validation harness.
 *
 * Checks each authored layout for:
 *  - closure error (should be ~0 after the linear solve)
 *  - heading correction the 360-degree normaliser had to apply, in degrees
 *  - the worst fractional change the closure made to a straight
 *  - solved reference lap time vs the real pole time
 *
 * A layout whose solved lap time is within a few percent of the real pole time
 * has corner radii and straight lengths that are approximately right. That is
 * the only objective check available without licensed survey data, and it is a
 * surprisingly strict one: get a radius badly wrong and the error shows up
 * immediately.
 *
 * Run: npm run validate:tracks
 */

import { CIRCUITS, layoutDiagnostics } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { formatLapTime } from '../src/core/MathUtils';

const diags = layoutDiagnostics();
const byId = new Map(diags.map((d) => [d.id, d]));

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

console.log('');
console.log(
  pad('CIRCUIT', 14) + padL('OFFIC', 7) + padL('BUILT', 7) + padL('TURN', 7) +
  padL('CLOSE', 7) + padL('dANG', 6) + padL('dSTR', 6) + padL('dRAD', 6) + padL('IT', 4) +
  padL('SOLVED', 10) + padL('POLE', 10) + padL('DELTA', 8) + padL('TIGHT', 7),
);
console.log('-'.repeat(103));

let worstLapErrorPct = 0;
let sumSignedErr = 0;
const failures: string[] = [];

for (const def of CIRCUITS) {
  const spline = new TrackSpline(def);
  const d = byId.get(def.id)!;

  const solved = spline.referenceLapTime;
  const real = def.referencePoleTimeS;
  const errPct = ((solved - real) / real) * 100;
  sumSignedErr += errPct;
  if (Math.abs(errPct) > worstLapErrorPct) worstLapErrorPct = Math.abs(errPct);

  // A geometric kink shows up as a curvature spike far tighter than any real
  // corner. Monaco's hairpin is the tightest on the calendar at about 11m.
  let maxK = 0;
  for (let i = 0; i < spline.count; i++) {
    const k = Math.abs(spline.curvature[i]);
    if (k > maxK) maxK = k;
  }
  const tightestRadius = 1 / maxK;

  if (tightestRadius < 9) failures.push(`${def.id}: curvature spike, tightest radius ${tightestRadius.toFixed(1)}m`);
  if (d.closureErrorM > 1) failures.push(`${def.id}: loop did not close (${d.closureErrorM.toFixed(1)}m)`);
  if (d.worstStraightChange > 1.05) failures.push(`${def.id}: a straight moved ${(d.worstStraightChange * 100).toFixed(0)}% to close the loop`);
  if (d.worstAngleChangeDeg > 110) failures.push(`${def.id}: a corner angle moved ${d.worstAngleChangeDeg.toFixed(0)}deg to close the loop`);
  if (d.worstRadiusChange > 0.29) failures.push(`${def.id}: a corner radius moved ${(d.worstRadiusChange * 100).toFixed(0)}% to close the loop`);
  if (Math.abs(d.authoredM - def.lengthM) > 5) failures.push(`${def.id}: built length ${d.authoredM.toFixed(0)}m != official ${def.lengthM}m`);
  if (Math.abs(errPct) > 9) failures.push(`${def.id}: solved lap ${errPct > 0 ? '+' : ''}${errPct.toFixed(1)}% vs pole`);

  console.log(
    pad(def.name, 14) +
    padL(String(def.lengthM), 7) +
    padL(d.authoredM.toFixed(0), 7) +
    padL(d.rawTurnDeg.toFixed(0), 7) +
    padL(d.closureErrorM.toFixed(2), 7) +
    padL(d.worstAngleChangeDeg.toFixed(0) + '°', 6) +
    padL((d.worstStraightChange * 100).toFixed(0) + '%', 6) +
    padL((d.worstRadiusChange * 100).toFixed(0) + '%', 6) +
    padL(String(d.iterations), 4) +
    padL(formatLapTime(solved), 10) +
    padL(formatLapTime(real), 10) +
    padL((errPct >= 0 ? '+' : '') + errPct.toFixed(1) + '%', 8) +
    padL(tightestRadius.toFixed(0) + 'm', 7),
  );
}

console.log('-'.repeat(103));
console.log(
  'worst lap error ' + worstLapErrorPct.toFixed(1) + '%   ' +
  'mean bias ' + (sumSignedErr / CIRCUITS.length >= 0 ? '+' : '') +
  (sumSignedErr / CIRCUITS.length).toFixed(1) + '%',
);
console.log('');

if (failures.length > 0) {
  console.log('ISSUES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('All layouts within tolerance.');
  console.log('');
}
