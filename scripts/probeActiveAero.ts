/**
 * ACTIVE AERO — does each team's wing actually open, and stay legal?
 *
 * The 2026 car has active aerodynamics at both ends, in two commanded positions
 * the regulations name Corner Mode and Straight Mode (Technical Art. C3.10.10
 * for the front wing, C3.11.6 for the rear). Unlike DRS, the rules no longer
 * fix where the flap's axis sits along its chord or how far it travels, and the
 * grid has separated accordingly — so this game gives each team one of four
 * real solutions. See `ACTUATION` in `CarMesh` for the sourcing.
 *
 * Four things have to be true of all of them, and none is obvious by eye:
 *
 *  1. THE CLOSED WING IS IDENTICAL ON EVERY CAR. Moving the hinge must change
 *     how the flap opens, not where it sits when shut. The whole rear wing
 *     assembly is dimensioned backwards from the Z=910 height limit, so a flap
 *     that drifted with its own hinge would put some cars outside the box.
 *  2. THE SLOT ACTUALLY OPENS. This is the failure the previous pass found: the
 *     hinge was once at the flap's LEADING edge, from which a slot physically
 *     cannot open, because the slot IS the gap between the mainplane's trailing
 *     edge and the flap's leading edge. Hinging there rotates the flap and
 *     leaves the one dimension that matters exactly where it was.
 *  3. NOTHING BREAKS THE HEIGHT LIMIT. Rear wing profiles are capped at Z=910
 *     above the reference plane, y=0.945 here, in EITHER position.
 *  4. THE OPENINGS ARE TELLABLE APART. That is the point of the exercise: if
 *     four archetypes all open to within a few millimetres of each other, they
 *     are one mechanism with four names.
 *
 * Run: npm run probe:activeaero
 */

import { ACTUATION, DRS_FLAP_CHORD, DRS_CLOSED_RAD, DRS_PIVOT_Y, DRS_PIVOT_Z,
  REAR_WING_TOP_Y, MAINPLANE_TRAILING, type ActuationId } from '../src/render/CarMesh';

/** The regulation ceiling for rear wing profiles: Z=910 -> y 0.945 here. */
const HEIGHT_LIMIT_Y = 0.945;

interface Pose { axY: number; axZ: number; teY: number; teZ: number; leY: number; leZ: number; rotDeg: number }

/**
 * Where the flap's edges are, in the car's frame, in one of the two positions.
 *
 * Reproduces exactly what `buildCar` does: the axis is placed by walking back
 * from the trailing edge along the chord, and the flap rotates about it.
 */
function pose(id: ActuationId, open: boolean): Pose {
  const a = ACTUATION[id];
  const back = DRS_FLAP_CHORD * (1 - a.pivotChordFrac);
  const axY = DRS_PIVOT_Y - back * Math.sin(DRS_CLOSED_RAD);
  const axZ = DRS_PIVOT_Z + back * Math.cos(DRS_CLOSED_RAD);
  const rot = DRS_CLOSED_RAD + (open ? a.openRad : 0);
  const dTE = DRS_FLAP_CHORD * (1 - a.pivotChordFrac);
  const dLE = DRS_FLAP_CHORD * a.pivotChordFrac;
  return {
    axY, axZ, rotDeg: (rot * 180) / Math.PI,
    teY: axY + dTE * Math.sin(rot), teZ: axZ - dTE * Math.cos(rot),
    leY: axY - dLE * Math.sin(rot), leZ: axZ + dLE * Math.cos(rot),
  };
}

/** Slot gap: mainplane trailing edge to flap leading edge. */
function slot(p: Pose): number {
  return Math.hypot(p.leY - MAINPLANE_TRAILING.y, p.leZ - MAINPLANE_TRAILING.z);
}

function pad(s: string, w: number): string { return s.padStart(w); }
function padr(s: string, w: number): string { return s.padEnd(w); }

const IDS: ActuationId[] = ['leading', 'forward', 'central', 'trailing'];

console.log('\n' + '='.repeat(96));
console.log('ACTIVE AERO — rear flap travel, per team archetype');
console.log('='.repeat(96));
console.log(`flap chord ${(DRS_FLAP_CHORD * 1000).toFixed(0)}mm, built at ` +
  `${((DRS_CLOSED_RAD * 180) / Math.PI).toFixed(1)} deg. Height limit y=${HEIGHT_LIMIT_Y} ` +
  `(Z=910). Assembly top ${REAR_WING_TOP_Y}.`);
console.log('');
console.log(
  padr('archetype', 12) + pad('axis@', 7) + pad('travel', 8) + pad('ms', 6) +
  '  |' + pad('CLOSED', 9) + pad('slot', 8) + pad('topY', 8) +
  '  |' + pad('OPEN', 9) + pad('slot', 8) + pad('topY', 8) + pad('gain', 9),
);

let minClosedSlot = Infinity, maxClosedSlot = 0;
let anyOverLimit = false;
let anyNotOpening = false;
const openSlots: number[] = [];
let refClosedTe = '';

for (const id of IDS) {
  const a = ACTUATION[id];
  const c = pose(id, false);
  const o = pose(id, true);
  const cs = slot(c), os = slot(o);
  const cTop = Math.max(c.teY, c.leY);
  const oTop = Math.max(o.teY, o.leY);
  const teKey = `${c.teY.toFixed(4)},${c.teZ.toFixed(4)}`;
  if (refClosedTe === '') refClosedTe = teKey;

  if (cs < minClosedSlot) minClosedSlot = cs;
  if (cs > maxClosedSlot) maxClosedSlot = cs;
  if (oTop > HEIGHT_LIMIT_Y || cTop > HEIGHT_LIMIT_Y) anyOverLimit = true;
  if (os <= cs) anyNotOpening = true;
  openSlots.push(os);

  console.log(
    padr(id, 12) + pad(a.pivotChordFrac.toFixed(2), 7) +
    pad(((a.openRad * 180) / Math.PI).toFixed(0) + 'deg', 8) +
    pad((a.travelS * 1000).toFixed(0), 6) +
    '  |' + pad(c.rotDeg.toFixed(1) + 'deg', 9) + pad((cs * 1000).toFixed(1) + 'mm', 8) +
    pad(cTop.toFixed(3), 8) +
    '  |' + pad(o.rotDeg.toFixed(1) + 'deg', 9) + pad((os * 1000).toFixed(1) + 'mm', 8) +
    pad(oTop.toFixed(3), 8) +
    pad('+' + ((os - cs) * 1000).toFixed(0) + 'mm', 9) +
    (teKey !== refClosedTe ? '  CLOSED POSE DIFFERS' : '') +
    (oTop > HEIGHT_LIMIT_Y ? '  OVER HEIGHT LIMIT' : ''),
  );
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

console.log('\n' + '-'.repeat(96));

const closedSpreadMm = (maxClosedSlot - minClosedSlot) * 1000;
console.log(`1. closed slot spread across archetypes: ${closedSpreadMm.toFixed(3)}mm` +
  (closedSpreadMm < 0.01 ? '   OK — every car is identical in Corner Mode' : '   FAIL'));

console.log(`2. every archetype opens the slot: ${anyNotOpening ? 'NO — FAIL' : 'yes'}`);

console.log(`3. height limit respected in both positions: ${anyOverLimit ? 'NO — FAIL' : 'yes'}`);

const lo = Math.min(...openSlots) * 1000;
const hi = Math.max(...openSlots) * 1000;
console.log(`4. open slot ranges ${lo.toFixed(0)}mm to ${hi.toFixed(0)}mm across the grid ` +
  `(${(hi - lo).toFixed(0)}mm spread)`);
console.log(`   ${hi - lo > 20 ? 'OK — the four solutions are tellable apart from behind'
  : 'TOO SIMILAR — these are one mechanism with four names'}`);

console.log('\nNOTE ON THE 85mm FIGURE. Under the DRS rules (2022-2025) Art. 3.10.10(g) capped');
console.log('the deployed gap at 85mm, measured with a spherical gauge, and every car on the');
console.log('grid ran the same open-source actuator (Appendix 5 row 2C) to that same limit.');
console.log('That cap does not carry into 2026: C3.11.1(g) governs the CLOSED gap (8-12mm)');
console.log('and there is no equivalent ceiling on the deployed position, which is why the');
console.log('openings above are both larger and different from one another. Do not "fix" a');
console.log('figure here to 85mm — that would be applying a superseded regulation.');
console.log('');
