/**
 * DOES A CRASHED CAR COME TO REST? — issue #58
 *
 * Reported from a screen recording, three observations in one sentence:
 *
 *   "one the wheels are in the ground not sure how thats possible, second
 *    there is a lot of shaking back and forth even tho the car has crashed
 *    which it shouldnt do, third the speedometer is in N?"
 *
 * The issue's own hypothesis was that all three are one contact-resolution
 * state that never converges. THAT HYPOTHESIS IS WRONG and this probe is why:
 * the simulation does not step a retired car at all, so there is nothing to
 * converge and its solver state is frozen by construction. Both real defects
 * are in the DRAWING of that frozen state, they are independent of each other,
 * and each needs its own section here.
 *
 * ---------------------------------------------------------------------------
 * 1. SETTLING — a car the simulation has frozen must be DRAWN frozen
 * ---------------------------------------------------------------------------
 *
 * `RaceEngine.step` captures `prevX`/`prevZ`/`prevHeading`/`prevS`/`prevLateral`
 * immediately before `physics.step`, and `updateRenderPoses` draws the car at
 * `prev + (now - prev) * alpha`, where `alpha` is the fraction of a physics step
 * still sitting in the accumulator. Four branches of that loop `continue`
 * BEFORE the capture — a retired car, a car sitting the period out, a car on
 * its release timer, and the whole field before the lights go out — so for
 * those the pair is never refreshed again. It stays at the top of the last step
 * the car WAS stepped on while `physics.position` holds the end of it, and the
 * two differ by one step of travel plus the barrier push-out.
 *
 * `alpha` sweeps 0..1 as the display beats against 120Hz. So the wreck is drawn
 * sliding back and forth across its final step, every frame, forever, and it
 * cannot decay because nothing about it is a transient. It is below `TELEPORT_M`
 * so the snap that exists for placements does not catch it.
 *
 * This section drives the REAL `SimClock` and the REAL `updateRenderPoses` — a
 * probe that restated the interpolation would be measuring its own copy — and
 * asks how far the drawn car moves between two frames. A frozen car must move
 * ZERO, which is why the bound is a tenth of a millimetre rather than a
 * negotiated figure: there is no mechanism by which a car nobody is stepping
 * may move at all.
 *
 * ---------------------------------------------------------------------------
 * 2. WHEELS — the lean a wreck is drawn at must still stand on the road
 * ---------------------------------------------------------------------------
 *
 * A wreck has no accelerations, so the roll and pitch that make a running car
 * look loaded up both fall to zero and it would sit dead level. `Renderer`
 * gives it a settled lean instead. That lean is applied by rotating the car
 * root about the car's ORIGIN — and the origin is the contact-patch plane, the
 * thing `bankedCarGroundY` puts exactly on the drawn asphalt. Rotating about it
 * takes every contact point on the low side straight through the surface: at
 * 4.3 degrees of roll the outer edge of a front tyre is 962mm from the axis and
 * goes 72mm under, and at 2.6 degrees of pitch the front axle is 1800mm from
 * the axis and goes 81mm under.
 *
 * The measurement RAYCASTS THE DRAWN TRIANGLES, the way `probe:banking` does,
 * because the alternative — comparing the placement rule against the placement
 * rule — is a tautology that stays green with the whole thing deleted.
 *
 * It asserts the LEAN'S OWN CONTRIBUTION: how much deeper the leaned car is
 * than the same car standing on the road at the same point of the same lap.
 * That isolates this defect from the second, larger and quite separate one that
 * section 4 now owns.
 *
 * ---------------------------------------------------------------------------
 * 4. SURFACE — every car, all the time, has to lie ON the road (issue #71)
 * ---------------------------------------------------------------------------
 *
 * The larger half of the same sentence, and a different population: this is not
 * a wreck, it is the whole field on every lap. The car root's `rotation.y` came
 * from the heading and its `rotation.x`/`rotation.z` from the car's own
 * accelerations, and from NOTHING about the surface under it — so a car placed
 * correctly at its origin was then drawn horizontal on a road that is neither
 * flat nor level. Pure geometry: 3.6m of wheelbase on Spa's 18.7 per cent
 * gradient buries an axle 337mm, and 1.925m of track on Zandvoort's 18 degrees
 * buries a tyre 313mm.
 *
 * Section 4 sweeps ALL ELEVEN CIRCUITS at three lateral offsets with NO LEAN at
 * all, and asserts. Eleven and not four, because on the build it was written
 * against Monaco measured 434mm and Monza 15mm — Monza is flat, so a check
 * written there reports this as fine. PROJECT.md section 3.5.
 *
 * Section 4b reads the source of BOTH consumers, because `CameraDirector`
 * carried a line-for-line copy of the two expressions and the eye has to ride
 * the same car the renderer draws.
 *
 * ---------------------------------------------------------------------------
 * 3. GEAR — "the speedometer is in N?"
 * ---------------------------------------------------------------------------
 *
 * Not a defect, and this section exists to say so with a measurement rather
 * than an opinion. `Hud.update` reads `N` whenever the car is below 0.6 m/s
 * with the throttle shut, and a wreck is stopped dead — `onSolidImpact` calls
 * `physics.stop()` on a write-off precisely so the HUD does not keep reading a
 * speed for a car pinned against a barrier. Neutral is also what the car IS:
 * FIA Technical Regulations Art. 12.4 requires a retired car to be left with a
 * neutral selector reachable from outside so marshals can move it, and every
 * broadcast onboard of a stopped car reads N for that reason.
 *
 * What this section checks is that the readout is that answer DELIBERATELY and
 * not by accident: that it is stable rather than flickering against a gear
 * number, and that the rule is still the rule after issue #45 reworked the
 * gearbox and added the AUTO/MANUAL mode line beside it.
 *
 * ---------------------------------------------------------------------------
 * Circuits
 * ---------------------------------------------------------------------------
 * Sections 1, 2 and 3 stage a real accident, which costs a race apiece, so they
 * run on four: Monza (flat and fast, where the accident arrives at 290 km/h),
 * Zandvoort (18 degrees of banking), Spa (the steepest road on the calendar)
 * and Monaco (a wall a metre off the paint).
 *
 * SECTION 4 RUNS ON ALL ELEVEN. It needs no accident — it places a car on the
 * road and asks whether the road is under it — so there is no reason to sample
 * the calendar, and every reason not to: the flat circuit is the one that
 * reports the defect as fine. PROJECT.md section 3.5.
 *
 * Run: npm run probe:crashrest
 */

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { installCanvasStub } from './lib/domStub';

installCanvasStub();

const { RaceEngine } = await import('../src/race/RaceEngine');
type SessionConfig = import('../src/race/RaceEngine').SessionConfig;
type CarEntry = import('../src/race/CarEntry').CarEntry;
const { getCircuit } = await import('../src/data/tracks/circuits');
const { TrackSpline } = await import('../src/track/TrackSpline');
const { buildWorldModel } = await import('../src/track/WorldObstacles');
const { SimClock } = await import('../src/core/SimClock');
const { updateRenderPoses } = await import('../src/render/RenderPose');
const { Vec2 } = await import('../src/core/MathUtils');
const { bankedCarGroundY, roadPoseUnderCar, buildTrackMeshes, ROAD_MESH_NAME } =
  await import('../src/render/TrackMesh');
const { CONTACT_POINTS, groundLift, newSurfacePose, wreckLean } =
  await import('../src/render/CarAttitude');
const { CIRCUITS: ALL_CIRCUITS } = await import('../src/data/tracks/circuits');

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); console.log('    FAIL — ' + msg); }
let checks = 0;
function ok(): void { checks++; }

const CIRCUITS = ['monza', 'zandvoort', 'spa', 'monaco'];

/**
 * How far the drawn pose of a frozen car may move between two frames, metres.
 *
 * A tenth of a millimetre, and it is not a tolerance in the usual sense: the
 * simulation is not stepping this car, so the honest answer is exactly zero and
 * anything above float noise is a mechanism. The artefact it is there to catch
 * measured 303mm.
 */
const REST_TOL_M = 0.0001;

/**
 * How much deeper into the asphalt the LEAN may put a tyre, metres.
 *
 * Two millimetres, the same bar `probe:banking` holds the placement rule to
 * against the same triangles. The artefact it is there to catch measured 155mm
 * on flat road.
 */
const LEAN_TOL_M = 0.002;

/**
 * How far below the drawn asphalt a tyre of a car with NO lean may sit, metres.
 *
 * TEN MILLIMETRES, and it is derived rather than negotiated. Two things stop it
 * being zero and both are the mesh's own discretisation rather than the rule's:
 *
 *  - The road is swept at a node every 3.00m with its elevation interpolated
 *    LINEARLY, so the drawn surface creases at every node while the car is a
 *    rigid plate spanning 3.6m of it. The worst node kink on the calendar is
 *    0.0057 of gradient (Spa, at the foot of Eau Rouge — `probe:framerate`
 *    measures it), worth 0.0057 * 1.8 = 10.3mm at an axle in the worst phase.
 *  - Across the width the ribbon is drawn as quads between node rows, so on a
 *    corner the drawn edge is a CHORD where the placement rule walks the arc.
 *
 * `probe:banking` holds the ORIGIN to 2mm against these same triangles; this is
 * the same measurement taken 1.8m out along a rigid body, so it is that bound
 * with the mesh's own crease added and nothing else. The artefact it is there
 * to catch measured 434mm — forty times the bound.
 */
const SURFACE_TOL_M = 0.010;

/** Frame rates to draw at. Neither divides 120, so `alpha` sweeps. */
const FRAME_RATES = [50, 85];

function pad(s: string, w: number): string { return s.padStart(w); }
function padr(s: string, w: number): string { return s.padEnd(w); }

// ===========================================================================
// Staging: a real accident, through the real barrier code
// ===========================================================================

/**
 * Puts one car into the wall and hands it back once it has retired.
 *
 * Not `car.retire(...)` directly. The whole question is what a car looks like
 * after an ACCIDENT, and the state an accident leaves behind — the barrier
 * push-out, the yaw the impact put in, `physics.stop()` on the write-off, the
 * lateral the containment line clamped it to — is produced by
 * `enforceBarriers` and `onSolidImpact` and by nothing a probe can fake. So the
 * probe drives a car off the road at racing speed and lets the engine do it.
 */
function crash(circuitId: string): { engine: InstanceType<typeof RaceEngine>; victim: CarEntry; speedKph: number } | null {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 8,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 4001,
  };
  const engine = new RaceEngine(def, config);

  let victim: CarEntry | null = null;
  let speedKph = 0;
  for (let step = 0; step < 400000 && !engine.over; step++) {
    engine.step();
    if (!victim && engine.time > 25) {
      // The last classified runner, so the staged accident does not rearrange
      // the fight at the front more than a real one would.
      const running = engine.standings.filter((c) => !c.retired && !c.inPitLane && c.physics.speedMs > 25);
      victim = running[running.length - 1] ?? null;
      if (victim) speedKph = victim.physics.speedMs * 3.6;
      continue;
    }
    if (!victim) continue;
    if (victim.retired) return { engine, victim, speedKph };
    // Keep pushing it at the wall until the wall ends its race. One kick can be
    // survived — a glancing hit scrubs speed and the car slides along the
    // armco — and what is being staged is the accident that RETIRES a car.
    const idx = engine.track.indexAt(victim.s);
    const side = victim.lateral >= 0 ? 1 : -1;
    victim.physics.velocity.x += engine.track.nx[idx] * side * 3.0;
    victim.physics.velocity.y += engine.track.nz[idx] * side * 3.0;
  }
  return null;
}

// ===========================================================================
// 1. SETTLING
// ===========================================================================

console.log('\n' + '='.repeat(100));
console.log('CRASHED CAR AT REST — issue #58');
console.log('='.repeat(100));
console.log('\n1. SETTLING — does the DRAWN pose of a wreck move after the simulation has frozen it?');
console.log(`   bound ${(REST_TOL_M * 1000).toFixed(1)}mm of movement between two frames.\n`);
console.log('   circuit      impact   fps   worst plan   worst height   mean plan');

interface Wreck { engine: InstanceType<typeof RaceEngine>; victim: CarEntry; speedKph: number }
const wrecks = new Map<string, Wreck>();

for (const id of CIRCUITS) {
  const staged = crash(id);
  if (!staged) {
    fail(`${id}: could not stage an accident that retired a car — the probe measured nothing`);
    continue;
  }
  wrecks.set(id, staged);
  const { engine, victim, speedKph } = staged;

  for (const fps of FRAME_RATES) {
    const clock = new SimClock();
    let now = 0;
    let lastX = NaN, lastZ = NaN, lastY = NaN;
    let worstPlan = 0, worstY = 0, sumPlan = 0, n = 0;
    let worstAt = '';
    for (let f = 0; f < 200; f++) {
      // Real displays are not metronomes, and `alpha` is a function of the
      // jitter as much as of the rate. A perfectly regular clock at some rates
      // parks `alpha` on one value and hides the whole defect.
      now += 1000 / fps + (f % 7 === 0 ? 1.7 : f % 3 === 0 ? -0.8 : 0.15);
      const steps = clock.advance(now);
      for (let i = 0; i < steps && !engine.over; i++) engine.step();
      updateRenderPoses(engine.cars, engine.track.length, clock.interpolationAlpha);
      const y = bankedCarGroundY(engine.track, victim.renderS, victim.renderLateral);
      if (!Number.isNaN(lastX) && f > 4) {
        const dp = Math.hypot(victim.renderX - lastX, victim.renderZ - lastZ);
        const dy = Math.abs(y - lastY);
        if (dp > worstPlan) { worstPlan = dp; worstAt = `alpha ${clock.interpolationAlpha.toFixed(3)}`; }
        if (dy > worstY) worstY = dy;
        sumPlan += dp; n++;
      }
      lastX = victim.renderX; lastZ = victim.renderZ; lastY = y;
    }
    console.log(`   ${padr(id, 12)} ${pad(speedKph.toFixed(0) + 'kph', 7)} ${pad(String(fps), 4)}`
      + `  ${pad((worstPlan * 1000).toFixed(2) + 'mm', 10)}   ${pad((worstY * 1000).toFixed(2) + 'mm', 12)}`
      + `   ${pad((sumPlan / Math.max(1, n) * 1000).toFixed(2) + 'mm', 9)}`);
    if (worstPlan > REST_TOL_M) {
      fail(`${id} at ${fps}fps: a car the simulation has frozen is DRAWN moving `
        + `${(worstPlan * 1000).toFixed(1)}mm in one frame (${worstAt}), bound ${(REST_TOL_M * 1000).toFixed(1)}mm`);
    } else ok();
    if (worstY > REST_TOL_M) {
      fail(`${id} at ${fps}fps: the height a frozen car is drawn at moves `
        + `${(worstY * 1000).toFixed(1)}mm in one frame, bound ${(REST_TOL_M * 1000).toFixed(1)}mm`);
    } else ok();
  }
}

// ===========================================================================
// 2. WHEELS
// ===========================================================================

console.log('\n2. WHEELS — is any tyre of a wreck deeper into the DRAWN asphalt than the same car standing level?');
console.log(`   bound ${(LEAN_TOL_M * 1000).toFixed(1)}mm, raycast against the ${ROAD_MESH_NAME} mesh.\n`);
console.log('   circuit      cars  worst lean cost   at                          level baseline');

/** Node stride the road mesh is built at, so every ray lands on a vertex row. */
const MESH_STEP = 2;
/** How far from where the car stands a hit still counts as this piece of road. */
const SAME_ROAD_M = 5;
/**
 * Height difference below which two hits are the same piece of asphalt.
 *
 * A millimetre, the same figure and the same reason as `probe:banking`: the
 * road is drawn as triangles and a ray through the edge two of them share is
 * reported against both, which is not two surfaces.
 */
const COINCIDENT_M = 0.001;
/** Contact points that found the lap crossing itself. Reported, not asserted. */
let ambiguous = 0;

const scratchEuler = new THREE.Euler();
const scratchMatrix = new THREE.Matrix4();
const ray = new THREE.Raycaster();
ray.far = 2000;
const from = new THREE.Vector3();
const down = new THREE.Vector3(0, -1, 0);
const carAt = new Vec2();

/**
 * Depth of the deepest contact point below the drawn asphalt, metres.
 *
 * Positive means buried. Returns null where no triangle of THIS piece of road
 * lies under the car — off the mesh, or under another leg of the lap.
 *
 * DRIVES THE REAL RULE, step for step with `Renderer.syncCars`: the origin from
 * `bankedCarGroundY`, the road's attitude from `TrackMesh.roadPoseUnderCar`
 * (which is `CarAttitude.surfaceAttitude` over the drawn surface), the body
 * lean added on top, the Euler built in the renderer's own 'YXZ' order, and
 * `groundLift` for a wreck. A probe that restated any of those would be
 * measuring its own copy, which is the failure mode PROJECT.md section 3.2
 * exists to prevent. What is NOT restated is the surface: every height below
 * comes off a raycast against the drawn triangles.
 */
const probePose = newSurfacePose();
const patches = new Float64Array(CONTACT_POINTS.length * 3);

/** What one placement measured: see `deepestBelowRoad`. */
interface Depths {
  /** Deepest contact point below the DRAWN triangles, metres. Null: no road. */
  drawn: number | null;
  /**
   * Worst departure of the DRAWN triangles from the placement rule, metres.
   *
   * A PROPERTY OF THE ROAD MESH ALONE, and it is not zero. Measured at the
   * exact world points `roadPoseUnderCar` read the surface at, against the
   * `bankedCarGroundY` it read there — one point, two surfaces, no car in it.
   *
   * The road is swept as ONE quad across its full width per node. A quad whose
   * two node rows FAN — every corner — is not a plane, so the diagonal it is
   * split on puts the drawn surface off the analytic one everywhere except at
   * the four corners. `probe:banking` reports 0.000m because it only ever
   * raycasts AT a node row, where those corners are exact by construction.
   * Measured here at up to 69mm.
   *
   * It is the floor below which no placement rule built on `bankedCarGroundY`
   * can go, which is why the bound on `drawn` is this plus a margin rather than
   * a number somebody chose. It is a real defect and a separate one; see
   * PROJECT.md section 7.
   */
  mesh: number;
  /**
   * Worst `drawn` at a contact point less `mesh` at that SAME contact point.
   *
   * What the attitude rule owns, with the mesh's own error taken off where it
   * can be measured, wheel by wheel. Null where no contact point had both.
   */
  excess: number | null;
}

function deepestBelowRoad(
  track: InstanceType<typeof TrackSpline>, road: THREE.Mesh,
  s: number, lateral: number, heading: number,
  leanRoll: number, leanPitch: number, retired: boolean, withMesh = false,
): Depths {
  track.toWorld(s, lateral, carAt);
  const surf = roadPoseUnderCar(track, s, lateral, heading, probePose, patches);
  const pitch = surf.pitch + leanPitch;
  const roll = surf.roll + leanRoll;
  let rootY = bankedCarGroundY(track, s, lateral) + surf.lift;
  if (retired) rootY += groundLift(pitch, heading, roll, surf.gradX, surf.gradZ);
  scratchEuler.set(pitch, heading, roll, 'YXZ');
  scratchMatrix.makeRotationFromEuler(scratchEuler);
  const m = scratchMatrix.elements;

  /**
   * The one unambiguous piece of asphalt under a world point, or null.
   *
   * TWO PIECES OF ASPHALT UNDER ONE TYRE is not a fault of anything measured
   * here. The lap crosses itself and neither leg is drawn as a bridge, so at
   * Suzuka's crossover there is genuinely no single answer to "what height is
   * the road here" — the two legs are drawn 170mm apart and whichever one a car
   * stands on, the other passes through it. `probe:banking` excludes those
   * points for the same reason and in the same words: a real defect and a
   * separate one, which cannot be charged to a rule being measured at a point
   * where the question is ambiguous. Counted, and reported by the caller.
   *
   * Two hits at the SAME height are one surface — a ray through the edge two
   * triangles share is reported against both — so they are folded first.
   */
  const asphaltAt = (x: number, y: number, z: number, count = false): number | null => {
    from.set(x, y + 80, z);
    ray.set(from, down);
    const ys: number[] = [];
    for (const h of ray.intersectObject(road, true)) {
      if (Math.abs(h.point.y - rootY) > SAME_ROAD_M) continue;
      if (ys.some((v) => Math.abs(v - h.point.y) <= COINCIDENT_M)) continue;
      ys.push(h.point.y);
    }
    if (ys.length === 0) return null;
    if (ys.length > 1) { if (count) ambiguous++; return null; }
    return ys[0];
  };

  let deepest: number | null = null;
  let meshGap = 0;
  let excess: number | null = null;
  for (let k = 0; k < CONTACT_POINTS.length; k++) {
    const [lx, lz] = CONTACT_POINTS[k];
    const wx = carAt.x + m[0] * lx + m[8] * lz;
    const wy = rootY + m[1] * lx + m[9] * lz;
    const wz = carAt.y + m[2] * lx + m[10] * lz;
    const surfY = asphaltAt(wx, wy, wz, true);
    let below: number | null = null;
    if (surfY !== null) {
      below = surfY - wy;
      if (deepest === null || below > deepest) deepest = below;
    }
    // The mesh's own departure, at the point `roadPoseUnderCar` read — one
    // world position, the rule's height and the drawn height, no car involved.
    // Costed separately because section 2 sweeps twenty cars and does not need
    // it; only section 4's bound is built on it.
    if (withMesh) {
      const px = patches[k * 3], py = patches[k * 3 + 1], pz = patches[k * 3 + 2];
      const drawnAtPatch = asphaltAt(px, py, pz);
      if (drawnAtPatch !== null) {
        const gap = Math.abs(drawnAtPatch - py);
        if (gap > meshGap) meshGap = gap;
        // PER CONTACT POINT. This tyre's depth, less what the mesh does to this
        // tyre's own metre of road. Pairing a circuit's worst burial against a
        // circuit's worst mesh error would be comparing two different corners,
        // and pairing a car's worst against the same car's worst would still be
        // comparing two different wheels.
        if (below !== null) {
          const e = below - gap;
          if (excess === null || e > excess) excess = e;
        }
      }
    }
  }
  return { drawn: deepest, mesh: meshGap, excess };
}

for (const id of CIRCUITS) {
  const def = getCircuit(id);
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const meshes = buildTrackMeshes(track, 'high', world);
  const road = meshes.root.getObjectByName(ROAD_MESH_NAME) as THREE.Mesh | undefined;
  if (!road) { fail(`${id}: no mesh named ${ROAD_MESH_NAME}`); continue; }

  let worstCost = -Infinity, worstAt = '', worstLevel = -Infinity;
  let sampled = 0;
  // Every car on the grid gets its own lean off its index, so the sweep is over
  // the whole field rather than over one representative angle — the worst car
  // is what a player sees when that car is the one that crashed.
  for (let index = 0; index < 20; index++) {
    const lean = wreckLean(index);
    for (let i = 0; i < track.count; i += MESH_STEP * 8) {
      const s = track.dist[i];
      const hw = track.width[i] * 0.5;
      for (const frac of [-0.7, 0.7]) {
        const lateral = hw * frac;
        const heading = track.headingAt(s);
        const leanedD = deepestBelowRoad(
          track, road, s, lateral, heading, lean.roll, lean.pitch, true,
        );
        const levelD = deepestBelowRoad(track, road, s, lateral, heading, 0, 0, false);
        const leaned = leanedD.drawn, level = levelD.drawn;
        if (leaned === null || level === null) continue;
        sampled++;
        const cost = leaned - level;
        if (cost > worstCost) {
          worstCost = cost;
          worstAt = `car ${index}, s=${s.toFixed(0)}, lat=${lateral.toFixed(1)}`;
        }
        if (level > worstLevel) worstLevel = level;
      }
    }
  }
  meshes.dispose();
  if (sampled === 0) { fail(`${id}: no contact point found a piece of road to stand on`); continue; }

  console.log(`   ${padr(id, 12)} ${pad('20', 4)}  ${pad((worstCost * 1000).toFixed(1) + 'mm', 15)}   `
    + `${padr(worstAt, 26)}  ${pad((worstLevel * 1000).toFixed(0) + 'mm', 8)}`);
  if (worstCost > LEAN_TOL_M) {
    fail(`${id}: the lean a wreck is drawn at puts a tyre ${(worstCost * 1000).toFixed(1)}mm `
      + `deeper into the asphalt than the same car standing level (${worstAt}), bound ${(LEAN_TOL_M * 1000).toFixed(1)}mm`);
  } else ok();
}

// ---------------------------------------------------------------------------
// 2b. WIRING — and the renderer has to actually apply it
// ---------------------------------------------------------------------------
//
// Section 2 measures the RULE: given the lean and the lift, does the car stand
// on the road. It cannot see whether `Renderer` calls the lift at all, because
// it computes the root height itself — and a probe whose two sides are the same
// expression is the tautology PROJECT.md section 3.2 is about. `probe:banking`
// has the same shape of second check for the same reason: the mesh can be
// perfect and the cars still placed by the wrong function.
//
// So this reads the source. Not elegant, and it is the only thing that goes red
// when somebody deletes the one line that makes the rule reach the screen.

console.log('\n2b. WIRING — does `Renderer.syncCars` apply the lift to a retired car?\n');
{
  const src = readFileSync('src/render/Renderer.ts', 'utf8');
  const imports = /import\s*\{[^}]*\bgroundLift\b[^}]*\}\s*from\s*'\.\/CarAttitude'/.test(src);
  // The call has to be inside the `car.retired` branch and has to move the root
  // in y. Matching the whole statement rather than the bare identifier, so an
  // import left behind by a deletion does not keep this green.
  const applied = /v\.root\.position\.y\s*\+=\s*groundLift\(/.test(src);
  const guarded = /if\s*\(car\.retired\)\s*\{[\s\S]{0,200}?v\.root\.position\.y\s*\+=\s*groundLift\(/.test(src);
  console.log(`   imports groundLift from CarAttitude ......... ${imports ? 'yes' : 'NO'}`);
  console.log(`   adds it to the car root's y ................. ${applied ? 'yes' : 'NO'}`);
  console.log(`   inside the retired branch .................... ${guarded ? 'yes' : 'NO'}`);
  if (!imports) fail('src/render/Renderer.ts does not import groundLift — the lean stands on nothing');
  else ok();
  if (!applied) fail('src/render/Renderer.ts never adds groundLift to the car root — a wreck is drawn with its tyres in the road');
  else ok();
  if (!guarded) fail('groundLift is not applied on the `car.retired` branch in src/render/Renderer.ts');
  else ok();

  // And the renderer must not have kept a private copy of the lean. Two copies
  // of one expression in two files is how `Hud.PRINCIPALS` and the camera rig
  // drifted apart, and it is how this probe would end up measuring a rule the
  // screen no longer uses.
  if (/Math\.sin\(car\.index \* 12\.9898\)/.test(src)) {
    fail('src/render/Renderer.ts still inlines the wreck lean — it must come from CarAttitude.wreckLean');
  } else ok();
}

// ===========================================================================
// 3. GEAR
// ===========================================================================

console.log('\n3. GEAR — what does the readout say for a car that has crashed, and is it stable?\n');
console.log('   circuit      speed     throttle  physics gear   readout   stable over 120 frames');

/**
 * The gear label, exactly as `Hud.update` computes it.
 *
 * Restated rather than imported because `src/ui/Hud.ts` is a DOM module that
 * cannot be constructed without a document, and because this probe is asserting
 * the RULE rather than the widget. Any change to the expression in `Hud.update`
 * without a change here shows up as this section reporting a label the HUD does
 * not draw, which is the failure mode worth having: the two are one line and
 * they are meant to agree.
 */
function gearLabel(car: CarEntry): string {
  const p = car.physics;
  if (p.inReverse) return 'R';
  if (p.speedMs < 0.6 && car.appliedControls.throttle < 0.02) return 'N';
  return String(p.gear);
}

for (const id of CIRCUITS) {
  const staged = wrecks.get(id);
  if (!staged) continue;
  const { engine, victim } = staged;
  const labels = new Set<string>();
  for (let f = 0; f < 120; f++) {
    engine.step();
    labels.add(gearLabel(victim));
  }
  const stable = labels.size === 1;
  const label = [...labels].join('/');
  console.log(`   ${padr(id, 12)} ${pad(victim.physics.speedMs.toFixed(3) + 'm/s', 9)} `
    + `${pad(victim.appliedControls.throttle.toFixed(3), 9)} ${pad(String(victim.physics.gear), 13)}   `
    + `${pad(label, 7)}   ${stable ? 'yes' : 'NO — it flickers'}`);

  // A wreck is stopped dead by `onSolidImpact` and is in neutral. The readout
  // must say so, and must not flicker between N and the gear the car happened
  // to be in when it hit the wall — a display that alternates is what a player
  // reads as a fault whichever of the two values is right.
  if (label !== 'N') {
    fail(`${id}: a retired car reads "${label}" — a stopped car is in neutral `
      + `(FIA Technical Regulations Art. 12.4: a retired car is left in neutral for recovery)`);
  } else ok();
  if (!stable) {
    fail(`${id}: the gear readout for a stopped car is not stable — it showed ${label}`);
  } else ok();
}

// ===========================================================================
// 4. A RUNNING CAR STANDS ON THE ROAD — issue #71
// ===========================================================================
//
// The larger half of *"one the wheels are in the ground"*, and a different
// population from section 2: every car, all the time, not a wreck.
//
// `Renderer.syncCars` used to set the car root's `rotation.y` from the heading
// and its `rotation.x`/`rotation.z` from the car's own accelerations — and from
// NOTHING about the surface under it. The origin is placed correctly
// (`bankedCarGroundY`; `probe:banking` holds it to 2mm on eleven circuits) and
// the car was then drawn HORIZONTAL, so on any gradient the downhill axle went
// under the asphalt and on any banking the low-side tyre did. It is #3 one
// level up: the placement rule is right AT THE ORIGIN, and a car is a rigid
// body 3.6m long and 1.9m wide, so being right at one point is not being right.
//
// This section is what section 2's "level baseline" column used to only report.
// It carries NO LEAN AT ALL — the body's lean is section 2's business — so what
// it measures is the road and the car's attitude to it and nothing else.
//
// ALL ELEVEN CIRCUITS. On the build this was written against Monza measured
// 15mm and Monaco 434mm, because Monza is flat; a check written at Monza
// reports this as fine, which is PROJECT.md section 3.5 in one line.
//
// THREE LATERAL OFFSETS: the racing line the cars actually use, and the two
// white lines, with the car placed so that its whole width is still on the
// asphalt. The edges are where the cross-slope is largest and where the camber
// is about to run out, and a sweep of the racing line alone would miss both.
//
// THE BOUND IS MEASURED, NOT CHOSEN, AND FINDING OUT WHY IS HALF OF THIS WORK.
// The drawn road and the surface every car is PLACED on are not the same
// surface, and the difference is not small. The road is swept as ONE quad
// across its full width per node; a quad whose two node rows FAN — every corner
// — is not a plane, so the diagonal it is split on puts the drawn triangles off
// `bankedCarGroundY` everywhere except at the four corners. Measured, at the
// points the attitude rule itself reads: up to 69mm.
//
// `probe:banking` reports 0.000m on eleven circuits and is not wrong: it
// raycasts at `px[i] + nx[i] * lat`, which is a mesh VERTEX ROW, where the
// quad's corners are exact by construction. It has never sampled between them.
//
// No placement rule built on `bankedCarGroundY` can beat that floor, so what is
// asserted is the part of a tyre's depth the floor does NOT account for —
// PER PLACEMENT, not per circuit. The two are measured at the same car in the
// same pose in the same metre of road, and pairing a circuit's worst burial
// against a circuit's worst mesh error would be comparing two different corners.
// The floor is measured in the same run at the same points rather than written
// down, so the bound cannot be widened quietly, and the mesh defect it exposes
// is real and separate — see PROJECT.md section 7.

console.log('\n4. A RUNNING CAR — is any tyre below the DRAWN asphalt, with no lean at all? (issue #71)');
console.log(`   bound: the road mesh's own departure from the placement rule, plus`);
console.log(`   ${(SURFACE_TOL_M * 1000).toFixed(1)}mm, raycast against the drawn ${ROAD_MESH_NAME} triangles,`);
console.log('   at the racing offset and hard against each white line, on all eleven circuits.');
console.log('   `cross` counts contact points where the lap crosses itself and two pieces of');
console.log('   asphalt lie under one tyre — excluded, exactly as probe:banking excludes them.\n');
console.log('   circuit        rays   tyre below drawn   mesh vs rule   UNEXPLAINED  cross  worst at');

const SURFACE_SAMPLE_STRIDE = 8;
/** Half the width of the car, from its own contact points. */
const CAR_HALF_W = CONTACT_POINTS.reduce((m, p) => Math.max(m, Math.abs(p[0])), 0);

for (const def of ALL_CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const meshes = buildTrackMeshes(track, 'high', world);
  const road = meshes.root.getObjectByName(ROAD_MESH_NAME) as THREE.Mesh | undefined;
  if (!road) { fail(`${def.id}: no mesh named ${ROAD_MESH_NAME}`); continue; }

  let worstDrawn = -Infinity, worstDrawnAt = '';
  let worstMesh = 0, worstMeshAt = '';
  let worstExcess = -Infinity, worstExcessAt = '';
  let rays = 0;
  const ambiguousBefore = ambiguous;
  for (let i = 0; i < track.count; i += SURFACE_SAMPLE_STRIDE) {
    const s = track.dist[i];
    const hw = track.width[i] * 0.5;
    // Hard against each white line, with the whole car still on the asphalt —
    // any further out and the outer contact points are over the run-off, which
    // is a different surface and a different question.
    const edge = Math.max(0, hw - CAR_HALF_W);
    const heading = track.headingAt(s);
    for (const [where, lateral] of [
      ['racing', track.lineOffset[i]],
      ['left', edge],
      ['right', -edge],
    ] as [string, number][]) {
      const d = deepestBelowRoad(track, road, s, lateral, heading, 0, 0, false, true);
      rays++;
      const at = `${where}, s=${s.toFixed(0)}, lat=${lateral.toFixed(1)}`;
      if (d.drawn === null) continue;
      if (d.drawn > worstDrawn) { worstDrawn = d.drawn; worstDrawnAt = at; }
      if (d.mesh > worstMesh) { worstMesh = d.mesh; worstMeshAt = at; }
      if (d.excess === null) continue;
      if (d.excess > worstExcess) { worstExcess = d.excess; worstExcessAt = at; }
    }
  }
  meshes.dispose();

  const mm = (v: number): string => (v === -Infinity ? 'n/a' : (v * 1000).toFixed(1) + 'mm');
  const crossed = ambiguous - ambiguousBefore;
  console.log(`   ${padr(def.id, 14)} ${pad(String(rays), 4)}   ${pad(mm(worstDrawn), 16)}  `
    + `${pad(mm(worstMesh), 13)}  ${pad(mm(worstExcess), 11)}  ${pad(String(crossed), 5)}  `
    + `${worstExcessAt}`);

  if (worstExcess > SURFACE_TOL_M) {
    fail(`${def.id}: a car with no lean at all has a tyre ${(worstExcess * 1000).toFixed(1)}mm `
      + `deeper into the drawn asphalt than the road mesh's own departure from the placement `
      + `rule accounts for (${worstExcessAt}), bound ${(SURFACE_TOL_M * 1000).toFixed(1)}mm — `
      + 'the car is not following the road. Worst raw burial on this circuit '
      + `${(worstDrawn * 1000).toFixed(1)}mm at ${worstDrawnAt}; worst mesh departure `
      + `${(worstMesh * 1000).toFixed(1)}mm at ${worstMeshAt}`);
  } else ok();
}

// ---------------------------------------------------------------------------
// 4b. WIRING — and both consumers have to actually apply it
// ---------------------------------------------------------------------------
//
// Section 4 measures the RULE, and it computes the root's rotation itself, so
// it would stay green with the renderer's call deleted. Same tautology, same
// remedy, as 2b: read the source. And there are TWO consumers here rather than
// one — `CameraDirector` used to carry a line-for-line copy of the two lean
// expressions, with a comment saying the two must not disagree — so the check
// is both that each applies the shared rule and that neither has kept a private
// copy of it.

console.log('\n4b. WIRING — do the renderer AND the camera take their attitude from the road?\n');
{
  const renderer = readFileSync('src/render/Renderer.ts', 'utf8');
  const director = readFileSync('src/render/CameraDirector.ts', 'utf8');
  const rows: [string, boolean, string][] = [
    ['Renderer imports roadPoseUnderCar ..........',
      /import\s*\{[^}]*\broadPoseUnderCar\b[^}]*\}\s*from\s*'\.\/TrackMesh'/s.test(renderer),
      'src/render/Renderer.ts does not import roadPoseUnderCar — every car is drawn level with the world'],
    ['Renderer calls it for every car ............',
      /roadPoseUnderCar\(/.test(renderer),
      'src/render/Renderer.ts never calls roadPoseUnderCar'],
    ["Renderer's car root is 'YXZ' ...............",
      /v\.root\.rotation\.set\([\s\S]{0,200}?'YXZ'/.test(renderer),
      "src/render/Renderer.ts does not build the car root's rotation in 'YXZ' order — "
      + 'a car heading along +x gets its braking pitch as roll'],
    ['CameraDirector imports roadPoseUnderCar ....',
      /import\s*\{[^}]*\broadPoseUnderCar\b[^}]*\}\s*from\s*'\.\/TrackMesh'/s.test(director),
      'src/render/CameraDirector.ts does not import roadPoseUnderCar — the eye and the car disagree'],
    ['CameraDirector calls it ....................',
      /roadPoseUnderCar\(/.test(director),
      'src/render/CameraDirector.ts never calls roadPoseUnderCar'],
    ["CameraDirector's chassis Euler is 'YXZ' ....",
      !/carEuler\.set\([^)]*'XYZ'\)/.test(director),
      "src/render/CameraDirector.ts still builds the chassis Euler in 'XYZ' order"],
  ];
  for (const [label, pass, msg] of rows) {
    console.log(`   ${label} ${pass ? 'yes' : 'NO'}`);
    if (pass) ok(); else fail(msg);
  }
}

// ===========================================================================

console.log('\n' + '-'.repeat(100));
console.log('WHAT THIS PROBE STILL DOES NOT ASSERT, AND IT IS A DELIBERATE OMISSION.');
console.log('Section 4 carries no lean; section 2 asserts only what the WRECK\'s lean costs. The');
console.log('lean a RUNNING car is drawn at — up to 0.06 rad of roll and 0.05 of pitch under load');
console.log('— is still applied without a ground lift, and at the 962mm and 1800mm the contact');
console.log('points sit from the axes it can reach ~148mm of tyre under the road at full lock in');
console.log('both axes at once. That is issue #58\'s decision and #71 did not overturn it: a');
console.log('running car\'s roll models the BODY moving on its suspension while the tyres stay');
console.log('planted, and this rig cannot express that — lifting the whole car under braking');
console.log('draws it hopping off the road, which is a worse artefact and a transient one. What');
console.log('#71 changed is that the lean is now a deviation from the ROAD PLANE rather than from');
console.log('the horizontal, so it is the only thing left over. See PROJECT.md section 7.');
console.log('-'.repeat(100));

console.log(`\n${checks} ok, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
