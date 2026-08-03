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
 * than the same car standing level at the same point of the same lap. That
 * isolates this defect from a second, larger and quite separate one which this
 * probe REPORTS and does not assert — see the closing note.
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
 * Monza (flat and fast, where the accident arrives at 290 km/h), Zandvoort
 * (18 degrees of banking), Spa (the steepest road on the calendar) and Monaco
 * (a wall a metre off the paint). PROJECT.md section 3.5.
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
const { bankedCarGroundY, buildTrackMeshes, ROAD_MESH_NAME } =
  await import('../src/render/TrackMesh');
const { CONTACT_POINTS, groundLift, wreckLean } = await import('../src/render/CarAttitude');

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

const scratchEuler = new THREE.Euler();
const scratchMatrix = new THREE.Matrix4();
const ray = new THREE.Raycaster();
ray.far = 2000;
const from = new THREE.Vector3();
const down = new THREE.Vector3(0, -1, 0);

/**
 * Depth of the deepest contact point below the drawn asphalt, metres.
 *
 * Positive means buried. Returns null where no triangle of THIS piece of road
 * lies under the car — off the mesh, or under another leg of the lap.
 */
function deepestBelowRoad(
  track: InstanceType<typeof TrackSpline>, road: THREE.Mesh,
  s: number, lateral: number, heading: number, roll: number, pitch: number,
): number | null {
  const out = new Vec2();
  track.toWorld(s, lateral, out);
  const rootY = bankedCarGroundY(track, s, lateral) + groundLift(pitch, heading, roll);
  scratchEuler.set(pitch, heading, roll, 'XYZ');
  scratchMatrix.makeRotationFromEuler(scratchEuler);
  const m = scratchMatrix.elements;
  let deepest: number | null = null;
  for (const [lx, lz] of CONTACT_POINTS) {
    const wx = out.x + m[0] * lx + m[8] * lz;
    const wy = rootY + m[1] * lx + m[9] * lz;
    const wz = out.y + m[2] * lx + m[10] * lz;
    from.set(wx, wy + 80, wz);
    ray.set(from, down);
    const hits = ray.intersectObject(road, true);
    let surf = -Infinity;
    for (const h of hits) {
      if (Math.abs(h.point.y - rootY) > SAME_ROAD_M) continue;
      if (h.point.y > surf) surf = h.point.y;
    }
    if (surf === -Infinity) continue;
    const below = surf - wy;
    if (deepest === null || below > deepest) deepest = below;
  }
  return deepest;
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
        const leaned = deepestBelowRoad(track, road, s, lateral, heading, lean.roll, lean.pitch);
        const level = deepestBelowRoad(track, road, s, lateral, heading, 0, 0);
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

console.log('\n' + '-'.repeat(100));
console.log('WHAT THIS PROBE DOES NOT ASSERT, AND IT IS A REAL DEFECT.');
console.log('The "level baseline" column of section 2 is how deep a tyre is with NO lean at all:');
console.log('the car root is placed on the drawn asphalt correctly (probe:banking, 2mm on eleven');
console.log('circuits) and then drawn LEVEL WITH THE WORLD, while the road under it is neither');
console.log('flat nor level. A 3.6m wheelbase on Spa\'s 18.7% gradient buries an axle 337mm, and');
console.log('a 1.925m track on Zandvoort\'s 18 degrees of banking buries a tyre 313mm. That is a');
console.log('separate bug from this one — it applies to every car all the time, not to a wreck —');
console.log('and fixing it means giving the car the road\'s attitude, which the cameras copy line');
console.log('for line and probe:framing is laid out against. ISSUE #71; see PROJECT.md 7.');
console.log('-'.repeat(100));

console.log(`\n${checks} ok, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
