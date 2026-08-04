/**
 * DO THE CARS STAND ON THE ROAD THAT IS DRAWN, OR ON THE CENTRELINE'S HEIGHT?
 *
 * `carGroundY` took the centreline's elevation and added the road's thickness.
 * That is right in the middle of the road and wrong everywhere else, because a
 * banked road is TILTED: the asphalt `lateral` metres off the centreline sits
 * `lateral * tan(bank)` above or below the centreline, and a car standing on it
 * has to sit there too. Two circuits on the calendar are banked enough for it to
 * matter and one of them — Zandvoort, 18 degrees through Hugenholtz and the
 * final turn — is banked enough that it was the largest positioning error in the
 * game.
 *
 * ---------------------------------------------------------------------------
 * Why this builds the circuit instead of doing the arithmetic
 * ---------------------------------------------------------------------------
 *
 * The first version of this probe computed the height of the asphalt as
 * `elevation + bankHeight(...) + ROAD_SURFACE_Y` and compared it against
 * `bankedCarGroundY`. Both sides of that comparison ARE the placement rule. It
 * stays green with the banking taken out of the ROAD MESH, and green again with
 * every car in the game placed by the flat rule, because it never looked at a
 * triangle and it never looked at a caller. A probe whose two sides are the same
 * expression is a tautology — the same shape of mistake as the racing-line probe
 * that flew the reference car at the reference car's own line.
 *
 * So it does two things that can fail:
 *
 *  1. IT RAYCASTS THE DRAWN ASPHALT. `buildTrackMeshes` is run for real on every
 *     circuit and the mesh named `ROAD_MESH_NAME` is shot from above at the
 *     point where a car would be standing. The answer is the y of a triangle the
 *     player can see, compared against the y the placement rule puts the car's
 *     origin at. Take the banking out of either side and the two disagree.
 *
 *  2. IT CHECKS WHO IS ALLOWED TO USE THE FLAT RULE. `carGroundY` knows nothing
 *     about lateral offset and is right only on the centreline, so outside
 *     `TrackMesh.ts` — which owns both — nothing in `src/` may call it. That is
 *     the half of the defect with no geometry in it: the mesh can be perfect and
 *     the cars still placed by the wrong function, which is the state issue #3
 *     described.
 *
 * ---------------------------------------------------------------------------
 * AND THE FIRST VERSION OF (1) COULD ONLY EVER LOOK AT THE VERTEX ROWS
 * ---------------------------------------------------------------------------
 *
 * Section 1 fires every ray at `px[i] + nx[i] * lat` — a row of MESH VERTICES,
 * where the drawn corners are on the placement rule by construction. It
 * reported `0.000m` on eleven circuits and it was not wrong; it was blind.
 *
 * The road is swept as ONE quad across its full width per node. Where the two
 * node rows FAN — every corner on the calendar — that quad is not planar, so
 * the diagonal it is split on lifts or drops the drawn triangles off
 * `bankedCarGroundY` EVERYWHERE EXCEPT AT THE FOUR CORNERS. `probe:crashrest`
 * §4 found it while measuring something else (issue #71): up to 113.5mm at
 * Suzuka. A probe that samples only at the corners of the one place a mesh can
 * be wrong reports zero forever.
 *
 * So section 2 samples BETWEEN the rows and BETWEEN the edges — five stations
 * across each span, seven offsets across the road — and asks the same question
 * section 1 asks, at the points section 1 cannot reach. Same rule, same
 * raycast, same exclusion of the crossover; only the sample positions differ.
 * That is the whole of the addition, and it is what makes the mesh fix below
 * measurable rather than asserted.
 *
 * Run: npm run probe:banking
 */

import * as THREE from 'three';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installCanvasStub } from './lib/domStub';
import { RoadTriangles } from './lib/roadTriangles';

// The renderer paints signage and surface-detail textures into canvases as it
// builds. None of that is measured here, but it has to succeed before there are
// any triangles — hence the stub, installed BEFORE the render modules load, and
// hence the dynamic imports: a static `import` is hoisted above this call.
installCanvasStub();

const { CIRCUITS } = await import('../src/data/tracks/circuits');
const { TrackSpline } = await import('../src/track/TrackSpline');
const { buildWorldModel } = await import('../src/track/WorldObstacles');
const {
  carGroundY, bankedCarGroundY, buildTrackMeshes, ROAD_SURFACE_Y, ROAD_MESH_NAME,
} = await import('../src/render/TrackMesh');

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

/**
 * Node stride the road mesh is built at on the `high` tier.
 *
 * Sampling on the stride puts every ray on a row of mesh vertices, where the
 * drawn surface and the spline agree exactly. Off the stride the two differ by
 * the sag of a chord across a 6m quad, which is real but is a tessellation
 * question and not the one this probe asks.
 */
const MESH_STEP = 2;

/**
 * How far from the local elevation a hit still counts as THIS piece of road.
 *
 * Suzuka crosses over itself and several circuits run back alongside a lower
 * section, so a ray fired down at a point on the road can pass through another
 * leg of the lap on the way. Hits further than this from the local elevation
 * belong to that other leg and are discarded; of what remains the HIGHEST is
 * taken, because the surface a car stands on is the topmost one under it.
 *
 * Not "the hit nearest the elevation", which was tried and is wrong: at Suzuka's
 * crossover the two legs are drawn 20mm apart in height, and nearest-in-
 * elevation picked the OTHER leg's asphalt by 0.3mm and reported a 20mm error
 * against a road that was drawn exactly right. Nor "nearest to where the car is
 * being placed", which would choose the triangle that makes the answer come out
 * green. Five metres is far wider than any error this is looking for — the worst
 * on the calendar was 1.56m — so the window cannot hide one.
 */
const SAME_ROAD_M = 5;

/**
 * Height difference below which two hits are the same piece of asphalt.
 *
 * A millimetre. The road is drawn as triangles and a ray through the edge two
 * of them share is reported against both, which is not two surfaces.
 */
const COINCIDENT_M = 0.001;

/**
 * Where section 2 samples ALONG a span, as a fraction of the node interval.
 *
 * Strictly inside (0, 1) and deliberately never 0 or 1: those are section 1's
 * vertex rows, where the answer is exact by construction and proves nothing.
 * Five stations rather than one because the worst point of a warped quad is not
 * reliably its middle — the diagonal the quad is split on makes the error
 * asymmetric, so a mid-span-only sweep understates one half of every corner.
 */
const BETWEEN_LONG_FRACS = [1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6];

/**
 * Where section 2 samples ACROSS the road, as a fraction of half-width.
 *
 * 0.9 rather than 1.0: the outermost column of a subdivided sweep meets the
 * white line exactly, and a sample sitting on the mesh's outer edge is another
 * vertex row. 0.9 of half-width is still a car's outside tyre on the paint at
 * every circuit on the calendar. The centreline is included because a quad
 * split on its diagonal is wrong in the MIDDLE of the road too — that is where
 * the diagonal runs.
 */
const BETWEEN_LAT_FRACS = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];

/**
 * How far the drawn road may sit from the placement rule BETWEEN the rows.
 *
 * The same 2mm as section 1, and it is the same rule for the same reason
 * rather than a second budget. Every vertex of the road mesh is on
 * `bankedCarGroundY` exactly — that is what section 1 measures — so between
 * them the only thing that can differ is how finely the surface is
 * tessellated, which is a decision this file makes and not a property of the
 * surveyed data. There is no floor here to be generous about: a sweep fine
 * enough drives it to zero, and the honest expectation is therefore section
 * 1's own number.
 *
 * NOT loosened to fit. On the build this section was written against it fails
 * on seven of eleven circuits, worst 113.5mm.
 */
const TOL_BETWEEN_M = 0.002;

/** One circuit's answer to section 2. */
interface BetweenRow {
  id: string;
  samples: number;
  offMesh: number;
  crossings: number;
  max: number;
  mean: number;
  atS: number;
  atLat: number;
}

const betweenRows: BetweenRow[] = [];
/** Largest disagreement between the grid index and THREE's own raycaster. */
let crossCheck = 0;

console.log('\n' + '='.repeat(102));
console.log('BANKING — is a car placed on the asphalt that is DRAWN under it?');
console.log('='.repeat(102));
console.log(`Road thickness ${(ROAD_SURFACE_Y * 1000).toFixed(0)}mm. Cars sampled at ` +
  `${(RACING_OFFSET_FRAC * 100).toFixed(0)}% of half-width, both sides, every ${MESH_STEP} nodes.`);
console.log('Asphalt height is RAYCAST off the built road mesh. "error" is how far the car');
console.log('origin sits from the triangle underneath it.\n');

console.log(
  padr('circuit', 14) + pad('max bank', 10) + pad('banked', 8) + pad('rays', 8) +
  pad('overlap', 9) + pad('slope err', 12) +
  '  |' + pad('OLD max err', 13) + pad('OLD mean', 10) +
  '  |' + pad('NEW max err', 13) + pad('NEW mean', 10),
);

let worstOld = 0, worstOldAt = '';
let worstNew = 0, worstNewAt = '';
let misses = 0;
let missDetail = '';
let overlaps = 0;
let worstOverlapM = 0;
let worstOverlapAt = '';
let worstSlope = 0;
let worstSlopeAt = '';

const down = new THREE.Vector3(0, -1, 0);
const origin = new THREE.Vector3();
const ray = new THREE.Raycaster();
ray.far = 2000;

for (const def of CIRCUITS) {
  const t = new TrackSpline(def);
  const world = buildWorldModel(t);
  const meshes = buildTrackMeshes(t, 'high', world);
  const road = meshes.root.getObjectByName(ROAD_MESH_NAME) as THREE.Mesh | undefined;
  if (!road) {
    console.log(`FAIL — no mesh named ${ROAD_MESH_NAME} at ${def.id}. The asphalt cannot be found.`);
    process.exitCode = 1;
    meshes.dispose();
    continue;
  }

  let maxBank = 0;
  let bankedNodes = 0;
  let sampled = 0;
  let circuitOverlaps = 0;
  let slopeMax = 0;
  let oldMax = 0, oldSum = 0;
  let newMax = 0, newSum = 0;
  let n = 0;

  for (let i = 0; i < t.count; i += MESH_STEP) {
    const s = t.dist[i];
    const bank = t.banking[i];
    sampled++;
    if (Math.abs(bank) > maxBank) maxBank = Math.abs(bank);
    if (Math.abs(bank) > 1e-6) bankedNodes++;

    const hw = t.width[i] * 0.5;
    /** Drawn asphalt height at ±RACING_OFFSET_FRAC, for the cross-slope check. */
    const drawn: Record<number, number> = {};
    for (const side of [-1, 1]) {
      const lateral = side * hw * RACING_OFFSET_FRAC;
      const x = t.px[i] + t.nx[i] * lateral;
      const z = t.pz[i] + t.nz[i] * lateral;

      // What the player can see: the height of the triangle under the car.
      origin.set(x, t.elevation[i] + 500, z);
      ray.set(origin, down);
      const hits = ray.intersectObject(road, false);
      // Two hits at the same height are one surface: a ray that passes exactly
      // through the edge two triangles share is reported against both, and
      // sampling on the mesh's own vertex rows puts a ray on an edge every
      // time. Four of those, at the seam where the lap closes and at one node
      // of Jeddah, were counted as overlapping asphalt until the heights were
      // compared: 0.477 against 0.477. Separate surfaces differ.
      const ys: number[] = [];
      for (const h of hits) {
        if (Math.abs(h.point.y - t.elevation[i]) > SAME_ROAD_M) continue;
        if (ys.some((y) => Math.abs(y - h.point.y) <= COINCIDENT_M)) continue;
        ys.push(h.point.y);
      }
      const inWindow = ys.length;
      let asphalt = -Infinity;
      for (const y of ys) if (y > asphalt) asphalt = y;
      if (inWindow === 0) {
        misses++;
        if (!missDetail) missDetail = `${def.id} s=${s.toFixed(0)} lat=${lateral.toFixed(1)}`;
        continue;
      }
      // TWO PIECES OF ASPHALT AT ONE POINT. The lap crosses itself and neither
      // leg is drawn as a bridge, so there is genuinely no single answer to
      // "what is the road height here" — Suzuka's crossover draws its two legs
      // within a few centimetres of each other. That is a real defect and a
      // separate one; it is counted and printed rather than charged to the
      // banking rule, which cannot be measured at a point where the question
      // is ambiguous.
      if (inWindow > 1) {
        overlaps++;
        circuitOverlaps++;
        let gapBottom = Infinity;
        for (const y of ys) if (y < gapBottom) gapBottom = y;
        if (asphalt - gapBottom > worstOverlapM) {
          worstOverlapM = asphalt - gapBottom;
          worstOverlapAt = `${def.id} s=${s.toFixed(0)}`;
        }
        continue;
      }

      drawn[side] = asphalt;

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

    // IS THE ROAD ACTUALLY BANKED? Everything above compares the car against
    // the asphalt, and a flat road with a flat placement rule agrees perfectly
    // — proved by breaking `bankHeight` to return 0 and watching the errors
    // stay at zero. So the drawn cross-slope is also read straight off the two
    // triangles and checked against the circuit's OWN banking datum, which is
    // the surveyed number in `circuits.ts` and owes nothing to the renderer.
    // This is what fails when the banking quietly leaves the world.
    if (drawn[-1] !== undefined && drawn[1] !== undefined) {
      const span = 2 * hw * RACING_OFFSET_FRAC;
      // Left-hand normal, so +lateral is to the left and a positive bank drops
      // it: `bankHeight` returns -lat*tan(bank) inside the road edge.
      const drawnBank = Math.atan2(drawn[-1] - drawn[1], span);
      const err = Math.abs(drawnBank - bank);
      if (err > slopeMax) { slopeMax = err; }
      if (err > worstSlope) {
        worstSlope = err;
        worstSlopeAt = `${def.id} s=${s.toFixed(0)}`;
      }
    }
  }

  // =======================================================================
  // SECTION 2 — the same question, at the points section 1 cannot reach.
  // =======================================================================
  const index = new RoadTriangles(road);
  const hits: number[] = [];
  const kept: number[] = [];
  let bMax = 0, bSum = 0, bN = 0, bOff = 0, bCross = 0, bAtS = 0, bAtLat = 0;
  let checkTick = 0;
  for (let i = 0; i < t.count; i++) {
    const j = (i + 1) % t.count;
    const sNode = t.dist[i];
    let span = t.dist[j] - sNode;
    if (span <= 0) span += t.length;
    for (const lf of BETWEEN_LONG_FRACS) {
      const s = sNode + span * lf;
      const hw = t.widthAt(s) * 0.5;
      const elev = t.elevationAt(s);
      for (const vf of BETWEEN_LAT_FRACS) {
        const lateral = vf * hw;
        // Where the placement rule says a car standing at (s, lateral) IS, and
        // how high it says the car's origin goes. Both come out of `src/`; the
        // only thing measured here is whether a triangle is drawn there.
        const p = t.toWorld(s, lateral, t.tmpA);
        const ruleY = bankedCarGroundY(t, s, lateral);
        index.heightsAt(p.x, p.y, hits);
        kept.length = 0;
        for (const y of hits) if (Math.abs(y - elev) <= SAME_ROAD_M) kept.push(y);
        if (kept.length === 0) { bOff++; continue; }
        // Two pieces of asphalt under one point: issue #37, excluded here for
        // exactly the reason section 1 excludes it.
        if (kept.length > 1) { bCross++; continue; }

        // THE INDEX IS CHECKED AGAINST THE RAYCASTER, on a thinned subset, so
        // that a bug in the acceleration structure cannot quietly report a
        // flat road. One in 997 samples, which is ~70 per circuit.
        if (++checkTick % 997 === 0) {
          origin.set(p.x, elev + 500, p.y);
          ray.set(origin, down);
          let best = -Infinity;
          for (const h of ray.intersectObject(road, false)) {
            if (Math.abs(h.point.y - elev) > SAME_ROAD_M) continue;
            if (h.point.y > best) best = h.point.y;
          }
          if (best > -Infinity) {
            const d = Math.abs(best - kept[0]);
            if (d > crossCheck) crossCheck = d;
          }
        }

        const err = Math.abs(kept[0] - ruleY);
        bSum += err; bN++;
        if (err > bMax) { bMax = err; bAtS = s; bAtLat = lateral; }
      }
    }
  }
  betweenRows.push({
    id: def.id, samples: bN, offMesh: bOff, crossings: bCross,
    max: bMax, mean: bN > 0 ? bSum / bN : 0, atS: bAtS, atLat: bAtLat,
  });

  meshes.dispose();

  const m = (v: number): string => v.toFixed(3) + 'm';
  console.log(
    padr(def.id, 14) +
    pad(((maxBank * 180) / Math.PI).toFixed(1) + 'deg', 10) +
    pad(((100 * bankedNodes) / sampled).toFixed(0) + '%', 8) +
    pad(String(n), 8) + pad(String(circuitOverlaps), 9) +
    pad(((slopeMax * 180) / Math.PI).toFixed(2) + 'deg', 12) +
    '  |' + pad(m(oldMax), 13) + pad(m(oldSum / n), 10) +
    '  |' + pad(m(newMax), 13) + pad(m(newSum / n), 10),
  );
}

console.log('\n' + '-'.repeat(102));
console.log(`worst error, OLD rule (centreline height): ${worstOld.toFixed(3)}m  (${worstOldAt})`);
console.log(`worst error, NEW rule (bankedCarGroundY):  ${worstNew.toFixed(3)}m  (${worstNewAt})`);
if (misses > 0) {
  console.log(`rays that found no asphalt within ${SAME_ROAD_M}m of the elevation: ${misses}` +
    ` (first: ${missDetail})`);
}
if (overlaps > 0) {
  console.log(`samples with two pieces of asphalt drawn at them: ${overlaps}, worst separation ` +
    `${worstOverlapM.toFixed(3)}m (${worstOverlapAt}). Not a banking error — the lap crosses`);
  console.log('itself and neither leg is drawn as a bridge. Excluded from the figures above.');
}

// ===========================================================================
// SECTION 2 — BETWEEN THE ROWS
// ===========================================================================

console.log('\n' + '='.repeat(102));
console.log('BETWEEN THE ROWS — is the DRAWN road the surface the placement rule describes,');
console.log('                  at the points that are not mesh vertices?');
console.log('='.repeat(102));
console.log(
  `${BETWEEN_LONG_FRACS.length} stations across every span x ${BETWEEN_LAT_FRACS.length} offsets ` +
  'across the road, none of them on a vertex row.',
);
console.log('Section 1 above samples only where the quad\'s corners are, which is where the mesh');
console.log('and the rule agree by construction. This is the same comparison, off the corners.\n');

console.log(
  padr('circuit', 14) + pad('samples', 10) + pad('no road', 9) + pad('crossover', 11) +
  pad('max err', 11) + pad('mean err', 11) + '  worst at',
);
let worstBetween = 0;
let worstBetweenAt = '';
for (const r of betweenRows) {
  console.log(
    padr(r.id, 14) + pad(String(r.samples), 10) + pad(String(r.offMesh), 9) +
    pad(String(r.crossings), 11) +
    pad((r.max * 1000).toFixed(1) + 'mm', 11) + pad((r.mean * 1000).toFixed(1) + 'mm', 11) +
    `  s=${r.atS.toFixed(0)}m lat=${r.atLat.toFixed(1)}m` +
    (r.max > TOL_BETWEEN_M ? '  <== FAIL' : ''),
  );
  if (r.max > worstBetween) {
    worstBetween = r.max;
    worstBetweenAt = `${r.id} s=${r.atS.toFixed(0)} lat=${r.atLat.toFixed(1)}`;
  }
}
console.log(
  `\nworst departure between the rows: ${(worstBetween * 1000).toFixed(1)}mm  (${worstBetweenAt})`,
);
console.log(
  `index vs THREE's raycaster, worst disagreement on the cross-checked subset: ` +
  `${(crossCheck * 1000).toFixed(4)}mm`,
);

/** Every `.ts` file under a directory, recursively. */
function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFilesUnder(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

const OWNER = join('src', 'render', 'TrackMesh.ts');
const strays: string[] = [];
for (const file of tsFilesUnder('src')) {
  if (file.endsWith(OWNER)) continue;
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, k) => {
    // The CALL, not the word: comments across the renderer refer to
    // `carGroundY` by name and should keep doing so.
    if (/(^|[^a-zA-Z.`])carGroundY\s*\(/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
      strays.push(`${file}:${k + 1}  ${line.trim()}`);
    }
  });
}
console.log('');
if (strays.length > 0) {
  console.log('FAIL — the flat, centreline-only rule is called outside TrackMesh.ts:');
  for (const s of strays) console.log(`  ${s}`);
  console.log('Anything placed at a lateral offset must go through `bankedCarGroundY`.');
} else {
  console.log('Call sites: `carGroundY` is called only inside TrackMesh.ts; every placement');
  console.log('elsewhere in src/ goes through `bankedCarGroundY`.');
}

// The new rule is not "better", it is EXACT — the road mesh and the car are
// swept by the same `bankHeight`. A residue here means the car and the road have
// been allowed to disagree again, which is the whole defect.
const TOL_M = 0.002;
/**
 * How far the drawn cross-slope may sit from the circuit's own banking datum.
 *
 * A tenth of a degree, which at Zandvoort's 7.5m of half-width is 13mm across
 * the road. The surface is a plane inside the white lines and the sampling is
 * on the mesh's vertex rows, so the honest expectation is zero and the measured
 * residue is 0.00 degrees on all eleven circuits. This is a tripwire, not a
 * budget.
 */
const TOL_SLOPE_RAD = (0.1 * Math.PI) / 180;
console.log(`worst drawn cross-slope error against the circuit's banking datum: ` +
  `${((worstSlope * 180) / Math.PI).toFixed(3)}deg (${worstSlopeAt || 'nowhere'})`);
console.log('');

let failed = strays.length > 0;
if (worstSlope > TOL_SLOPE_RAD) {
  console.log(`FAIL — the road is drawn ${((worstSlope * 180) / Math.PI).toFixed(2)}deg off the ` +
    'banking the circuit is surveyed with.');
  console.log('The cars would stand on it happily; the corner simply is not banked any more.');
  failed = true;
}
if (misses > 0) {
  console.log(`FAIL — ${misses} sample points have no asphalt drawn under them.`);
  failed = true;
} else if (worstNew > TOL_M) {
  console.log(`FAIL — the car is still off the drawn asphalt by up to ${worstNew.toFixed(3)}m.`);
  console.log('The placement must go through the same `bankHeight` the mesh does.');
  failed = true;
}
const betweenBad = betweenRows.filter((r) => r.max > TOL_BETWEEN_M);
if (betweenBad.length > 0) {
  console.log(
    `FAIL — BETWEEN the mesh's node rows the drawn road departs from the placement rule by up\n` +
    `to ${(worstBetween * 1000).toFixed(1)}mm, on ${betweenBad.length} of ${CIRCUITS.length} ` +
    `circuits, bound ${(TOL_BETWEEN_M * 1000).toFixed(0)}mm:`,
  );
  for (const r of betweenBad) {
    console.log(
      `  ${padr(r.id, 13)} ${(r.max * 1000).toFixed(1).padStart(7)}mm ` +
      `at s=${r.atS.toFixed(0)}m, lat=${r.atLat.toFixed(1)}m`,
    );
  }
  console.log('A car placed by the rule stands that far off the asphalt a player can see. The road');
  console.log('is swept as one quad across its full width; where the node rows fan it is not planar,');
  console.log('so the diagonal it is split on carries the surface away from the rule between the');
  console.log('corners. Sub-divide the sweep ACROSS the width the way it already sub-divides ALONG.');
  failed = true;
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log(`PASS — cars stand on the drawn asphalt within ${(TOL_M * 1000).toFixed(0)}mm on all`);
  console.log(`${CIRCUITS.length} circuits, including on 18 degrees of banking at Zandvoort, and`);
  console.log("the drawn cross-slope is the circuit's own surveyed banking — and the road stays");
  console.log(`within ${(TOL_BETWEEN_M * 1000).toFixed(0)}mm of the rule BETWEEN the rows as well as on them.`);
}
console.log('');
