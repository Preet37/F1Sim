/**
 * DO THE CARS STAND ON THE BANKED ROAD, OR ON THE CENTRELINE'S HEIGHT?
 *
 * `carGroundY` took the centreline's elevation and added the road's thickness.
 * That is right in the middle of the road and wrong everywhere else, because a
 * banked road is TILTED: the asphalt `lateral` metres off the centreline sits
 * `lateral * tan(bank)` above or below the centreline, and a car standing on it
 * has to sit there too.
 *
 * Two circuits on the calendar are banked enough for it to matter, and one of
 * them is banked enough that the error is the largest positioning defect in the
 * game. This probe measures, per circuit:
 *
 *   the drawn asphalt height under a car at a given lateral offset, taken from
 *   `bankHeight` — the SAME function `buildTrackMeshes` sweeps the road with —
 *   against the height each rule places the car's origin at.
 *
 * The old rule's error is a number the renderer never knew it had. The new
 * rule's must be zero by construction, and this asserts it: if the car is
 * placed with anything other than the road's own arithmetic, they will diverge.
 *
 * Run: npm run probe:banking
 */

import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { bankHeight, carGroundY, bankedCarGroundY, ROAD_SURFACE_Y } from '../src/render/TrackMesh';

function pad(s: string, w: number): string { return s.padStart(w); }
function padr(s: string, w: number): string { return s.padEnd(w); }

/**
 * Where a car actually sits when it is racing, as a fraction of half-width.
 *
 * Not the road edge. A car uses most of the road but not the paint, and the
 * error scales linearly with offset, so quoting it at the extreme edge would
 * overstate what a player sees. 0.8 is a car on the outside of a corner with a
 * tyre's width in hand, which at Zandvoort is exactly where a car IS — the
 * banking is there so that they can lean on it.
 */
const RACING_OFFSET_FRAC = 0.8;

console.log('\n' + '='.repeat(94));
console.log('BANKING — is a car placed on the road it is standing on?');
console.log('='.repeat(94));
console.log(`Road thickness ${(ROAD_SURFACE_Y * 1000).toFixed(0)}mm. Cars sampled at ` +
  `${(RACING_OFFSET_FRAC * 100).toFixed(0)}% of half-width, both sides, every node.`);
console.log('"error" is how far the car origin sits from the drawn asphalt under it.\n');

console.log(
  padr('circuit', 14) + pad('max bank', 10) + pad('banked m', 10) +
  '  |' + pad('OLD max err', 13) + pad('OLD mean', 10) +
  '  |' + pad('NEW max err', 13) + pad('NEW mean', 10),
);

let worstOld = 0, worstOldAt = '';
let worstNew = 0, worstNewAt = '';

for (const def of CIRCUITS) {
  const t = new TrackSpline(def);
  let maxBank = 0;
  let bankedNodes = 0;
  let oldMax = 0, oldSum = 0;
  let newMax = 0, newSum = 0;
  let n = 0;

  for (let i = 0; i < t.count; i++) {
    const s = t.dist[i];
    const bank = t.banking[i];
    if (Math.abs(bank) > maxBank) maxBank = Math.abs(bank);
    if (Math.abs(bank) > 1e-6) bankedNodes++;

    const hw = t.width[i] * 0.5;
    for (const side of [-1, 1]) {
      const lateral = side * hw * RACING_OFFSET_FRAC;
      // The road the mesh actually draws under this point. Same call
      // `buildTrackMeshes` makes for its own vertices.
      const asphalt = t.elevation[i] + bankHeight(bank, lateral, hw) + ROAD_SURFACE_Y;

      // What each rule places the car's origin at.
      const oldY = carGroundY(t.elevationAt(s));
      const newY = bankedCarGroundY(t, s, lateral);

      const eOld = Math.abs(oldY - asphalt);
      const eNew = Math.abs(newY - asphalt);
      oldSum += eOld; newSum += eNew; n++;
      if (eOld > oldMax) oldMax = eOld;
      if (eNew > newMax) newMax = eNew;
      if (eOld > worstOld) { worstOld = eOld; worstOldAt = `${def.id} s=${s.toFixed(0)}`; }
      if (eNew > worstNew) { worstNew = eNew; worstNewAt = `${def.id} s=${s.toFixed(0)}`; }
    }
  }

  const m = (v: number): string => v.toFixed(3) + 'm';
  console.log(
    padr(def.id, 14) +
    pad(((maxBank * 180) / Math.PI).toFixed(1) + 'deg', 10) +
    pad(((100 * bankedNodes) / t.count).toFixed(0) + '%', 10) +
    '  |' + pad(m(oldMax), 13) + pad(m(oldSum / n), 10) +
    '  |' + pad(m(newMax), 13) + pad(m(newSum / n), 10),
  );
}

console.log('\n' + '-'.repeat(94));
console.log(`worst error, OLD rule: ${worstOld.toFixed(3)}m  (${worstOldAt})`);
console.log(`worst error, NEW rule: ${worstNew.toFixed(3)}m  (${worstNewAt})`);
console.log('');

// The new rule is not "better", it is EXACT — it calls the same function the
// road mesh is swept with. A residue here means the car and the road have been
// allowed to disagree again, which is the whole defect.
const TOL_M = 0.002;
if (worstNew > TOL_M) {
  console.log(`FAIL — the car is still off the drawn asphalt by up to ${worstNew.toFixed(3)}m.`);
  console.log('The placement must go through the same `bankHeight` the mesh does.');
  process.exitCode = 1;
} else {
  console.log(`PASS — cars stand on the asphalt within ${(TOL_M * 1000).toFixed(0)}mm everywhere,`);
  console.log('including on 18 degrees of banking at Zandvoort. The residue is the interpolation');
  console.log('between nodes, not a disagreement about where the road is.');
}
console.log('');
