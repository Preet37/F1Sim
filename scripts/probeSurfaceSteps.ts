/**
 * Sweeps every node of every circuit looking for a DISCONTINUITY in anything a
 * tyre can feel.
 *
 * The report this exists for: "I slip at exactly the same place, a couple of
 * times a lap". Exactly the same place is not a physics instability — an
 * instability wanders. It is the world being discontinuous at one fixed s, and
 * the car meeting that discontinuity every lap.
 *
 * So this measures steps, not values. For each per-node field the car reads,
 * the largest single-node change around the lap, and where. A smooth road has
 * small steps everywhere; a defect is an outlier in one column at one node.
 */

import { TrackSpline } from '../src/track/TrackSpline';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSurface } from '../src/race/Weather';
import { bankHeight, carGroundY, Y_ROAD } from '../src/render/TrackMesh';

interface Peak {
  step: number;
  i: number;
  s: number;
  a: number;
  b: number;
}

function peak(): Peak {
  return { step: 0, i: -1, s: 0, a: 0, b: 0 };
}

function offer(p: Peak, step: number, i: number, s: number, a: number, b: number): void {
  if (step > p.step) {
    p.step = step;
    p.i = i;
    p.s = s;
    p.a = a;
    p.b = b;
  }
}

/** Largest single-node step in a looped field. */
function scan(t: TrackSpline, f: (i: number) => number): Peak {
  const p = peak();
  for (let i = 0; i < t.count; i++) {
    const j = (i + 1) % t.count;
    const a = f(i);
    const b = f(j);
    offer(p, Math.abs(b - a), i, t.dist[i], a, b);
  }
  return p;
}

const only = process.env.AUDIT_ONLY;
const circuits = only ? CIRCUITS.filter((c) => c.id === only) : CIRCUITS;

interface Row {
  id: string;
  cols: Record<string, Peak>;
}

const COLS = [
  'curvature', 'lineCurv', 'targetSpd', 'cornerSpd', 'width', 'banking',
  'elevation', 'grade', 'lineOff', 'rubberHalf', 'gripDry', 'gripWet',
  'surfType', 'drawnY',
];

const rows: Row[] = [];

for (const def of circuits) {
  const t = new TrackSpline(def);
  const surface = new TrackSurface(t);

  const cols: Record<string, Peak> = {};

  cols.curvature = scan(t, (i) => t.curvature[i]);
  cols.lineCurv = scan(t, (i) => t.lineCurvature[i]);
  cols.targetSpd = scan(t, (i) => t.targetSpeed[i]);
  cols.cornerSpd = scan(t, (i) => t.corneringSpeed[i]);
  cols.width = scan(t, (i) => t.width[i]);
  cols.banking = scan(t, (i) => t.banking[i]);
  cols.elevation = scan(t, (i) => t.elevation[i]);
  cols.grade = scan(t, (i) => t.gradeAt(t.dist[i]));
  cols.lineOff = scan(t, (i) => t.lineOffset[i]);
  cols.rubberHalf = scan(t, (i) => t.rubberHalfWidthAt(i));

  // Grip on a bone-dry circuit, on the line the player is actually driving.
  cols.gripDry = scan(t, (i) => surface.surfaceGripAt(i, t.lineOffset[i]));

  // And soaked, which is where the surface model has any authority at all.
  surface.soak(1);
  cols.gripWet = scan(t, (i) => surface.surfaceGripAt(i, t.lineOffset[i]));

  // The surface TYPE a car holding a constant lateral offset would be told it
  // is on. Encoded as the grip multiplier so a flip shows up as a number.
  // Sampled just inboard of the white line, which is where a car on the limit
  // at an apex actually is.
  const surfaceGripOfType = (i: number): number => {
    const hw = t.width[i] * 0.5;
    // A car running 30cm inside the left-hand white line.
    const lat = hw - 0.3;
    const absLat = Math.abs(lat);
    if (absLat <= hw - 0.4) return 1.0;
    if (absLat <= hw + 1.1) return t.isCurbLeft[i] ? 0.85 : 0.82;
    if (absLat <= hw + 5) return 0.82;
    return 0.42;
  };
  cols.surfType = scan(t, surfaceGripOfType);

  // The DRAWN asphalt under the car, against the height the car is placed at.
  // The renderer puts a car origin at carGroundY(elevation); the mesh under it
  // is elevation + bankHeight(lat) + Y_ROAD. Any disagreement is a car sunk
  // into, or floating over, the road it is standing on.
  cols.drawnY = scan(t, (i) => {
    const hw = t.width[i] * 0.5;
    const lat = t.lineOffset[i];
    const meshY = t.elevation[i] + bankHeight(t.banking[i], lat, hw) + Y_ROAD;
    return meshY - carGroundY(t.elevation[i]);
  });

  rows.push({ id: def.id, cols });
}

// --- Report ---------------------------------------------------------------

const W = 11;
console.log('LARGEST SINGLE-NODE STEP, per circuit (value, and s= where)\n');
console.log('circuit'.padEnd(13) + COLS.map((c) => c.padStart(W)).join(''));
for (const r of rows) {
  const line = r.id.padEnd(13) + COLS.map((c) => {
    const p = r.cols[c];
    const v = p.step;
    const s = v === 0 ? '0' : v < 0.001 ? v.toExponential(1) : v.toFixed(3);
    return s.padStart(W);
  }).join('');
  console.log(line);
}

console.log('\nWHERE (s in metres)\n');
console.log('circuit'.padEnd(13) + COLS.map((c) => c.padStart(W)).join(''));
for (const r of rows) {
  const line = r.id.padEnd(13) + COLS.map((c) => {
    const p = r.cols[c];
    return (p.step === 0 ? '-' : Math.round(p.s).toString()).padStart(W);
  }).join('');
  console.log(line);
}

// --- Outliers -------------------------------------------------------------
//
// A step is only interesting against the field's own typical step. Report any
// node whose step is more than 8x the 99th percentile of that field, which is
// the shape a genuine discontinuity has: everything smooth, one node not.

console.log('\nOUTLIERS: nodes stepping far beyond the field\'s own norm\n');

let found = 0;
for (const def of circuits) {
  const t = new TrackSpline(def);
  const surface = new TrackSurface(t);
  const fields: Record<string, (i: number) => number> = {
    curvature: (i) => t.curvature[i],
    lineCurv: (i) => t.lineCurvature[i],
    targetSpd: (i) => t.targetSpeed[i],
    cornerSpd: (i) => t.corneringSpeed[i],
    width: (i) => t.width[i],
    banking: (i) => t.banking[i],
    elevation: (i) => t.elevation[i],
    lineOff: (i) => t.lineOffset[i],
    rubberHalf: (i) => t.rubberHalfWidthAt(i),
    gripDry: (i) => surface.surfaceGripAt(i, t.lineOffset[i]),
  };

  for (const [name, f] of Object.entries(fields)) {
    const steps: { v: number; i: number }[] = [];
    for (let i = 0; i < t.count; i++) {
      steps.push({ v: Math.abs(f((i + 1) % t.count) - f(i)), i });
    }
    const sorted = steps.map((x) => x.v).sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    if (p99 <= 1e-9) continue;
    for (const st of steps) {
      if (st.v > p99 * 8) {
        console.log(
          `  ${def.id.padEnd(13)} ${name.padEnd(11)} node ${String(st.i).padStart(5)} ` +
          `s=${Math.round(t.dist[st.i]).toString().padStart(5)}m  ` +
          `step=${st.v.toPrecision(4)}  (p99=${p99.toPrecision(3)}, ${(st.v / p99).toFixed(0)}x)`,
        );
        found++;
      }
    }
  }
}
if (found === 0) console.log('  none');
