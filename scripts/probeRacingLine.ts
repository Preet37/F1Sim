import { RacingLine } from '../src/render/RacingLine';
import { TrackSpline } from '../src/track/TrackSpline';
import { CIRCUITS, getCircuit } from '../src/data/tracks/circuits';

/**
 * Does the racing-line overlay tell the truth?
 *
 * Two questions, and the second is the one that matters.
 *
 *  1. How far before a corner does the line warn you? The measure is the colour
 *     of the tarmac IMMEDIATELY AHEAD of the car — that is what a driver looks
 *     at. If that stays green until the corner arrives, the aid is useless
 *     however correct the far end of the ribbon is.
 *
 *  2. DOES A DRIVER WHO FOLLOWS THE GREEN ACTUALLY MAKE THE CORNER?
 *
 * The second is the assertion, and it is stated as a property of the display
 * rather than as the behaviour of a simulated driver. At every point on all
 * eleven circuits it finds the fastest speed at which the road ahead still
 * reads green, releases a car from there, gives it a fifth of a second before
 * it may touch the brakes, and then brakes it as hard as the tyres will allow —
 * and checks it was never asked for more lateral grip than it has.
 *
 * Phrasing it that way is deliberate. The obvious test is to fly a synthetic
 * driver at every corner, and that is run too (section 3) — but it cannot be
 * the assertion, because a driver who goes to full throttle the instant the
 * road turns green will exceed the grip on the exit of Monaco's hairpin no
 * matter how honest the display is. A test that cannot separate "the display
 * lied" from "the driver was clumsy" is no use for fixing either.
 *
 * It exists because the overlay used to fail this outright. It coloured every
 * segment by whether the corner was still REACHABLE — whether a driver who
 * braked immediately, at a flat and wildly optimistic 38 m/s², would arrive at
 * the right speed. A driver who instead read green as "you are fine" and turned
 * in was shown green all the way to the point they ran out of road. The display
 * was self-consistent and useless, which is the worst kind of wrong: it looked
 * like it was working.
 */

const G_TOLERANCE = 1.02;

/** Reaction time granted before a released car starts braking, seconds. */
const RELEASE_REACTION_S = 0.2;

// ===========================================================================
// 1. How early does the warning arrive?
// ===========================================================================

{
  const track = new TrackSpline(getCircuit('monza'));
  const line = new RacingLine(track);

  let bestI = 0, bestDrop = 0;
  for (let i = 0; i < track.count; i++) {
    const j = (i + 60) % track.count;
    const d = track.targetSpeed[i] - track.targetSpeed[j];
    if (d > bestDrop) { bestDrop = d; bestI = i; }
  }
  const cornerS = track.dist[(bestI + 60) % track.count];
  const cornerKph = track.targetSpeed[(bestI + 60) % track.count] * 3.6;
  console.log(`Monza: heaviest braking zone into a ${cornerKph.toFixed(0)} km/h corner\n`);
  console.log('colour of the road just ahead of the car:');
  console.log('distance to corner   R     G     B    reads as');

  for (const kph of [330, 240, 160, 90]) {
    console.log(`\n--- approaching at ${kph} km/h ---`);
    const speed = kph / 3.6;
    for (const dist of [600, 350, 200, 150, 100, 60]) {
      const s = (cornerS - dist + track.length) % track.length;
      const [r, g, b] = colourAhead(line, s, speed);
      console.log(
        `${String(dist).padStart(13)}m   ${r.toFixed(2)}  ${g.toFixed(2)}  ${b.toFixed(2)}   ${reads(r, g)}`,
      );
    }
  }
}

// ===========================================================================
// 2. A driver who follows the green makes the corner
// ===========================================================================

console.log('\n\n=== follow-the-green: does the colour keep its promise? ===\n');
console.log('At every point on every lap, the fastest speed at which the road ahead');
console.log('still reads GREEN is found, and the car is released from there: it holds');
console.log('that speed for a fifth of a second — a driver reacting to the colour');
console.log('CHANGING, which it has not yet done — and then brakes as hard as the');
console.log('tyres allow. "worst load" is the most lateral grip it is asked for on the');
console.log('way through. Above 1.00 the car leaves the road, and the green that put');
console.log('it there was a lie.\n');
console.log(
  'circuit'.padEnd(14) + 'points'.padStart(8) + 'worst load'.padStart(12) +
  '  at'.padEnd(12) + 'was'.padStart(8),
);

const failures: string[] = [];

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const line = new RacingLine(track);

  let worst = 0;
  let worstS = 0;
  let tested = 0;

  // Every fourth node — about twelve metres, far finer than the eight-metre
  // segments the ribbon is built from.
  for (let i = 0; i < track.count; i += 4) {
    const s = track.dist[i];
    const v = fastestGreen(track, line, s);
    if (v === null) continue;
    tested++;
    const load = releaseFrom(track, s, v);
    if (load > worst) { worst = load; worstS = s; }
  }

  const ok = worst <= G_TOLERANCE;
  console.log(
    def.id.padEnd(14) + String(tested).padStart(8) +
    worst.toFixed(3).padStart(12) + `  s=${worstS.toFixed(0)}m`.padEnd(14) +
    (ok ? 'ok' : 'FAIL').padStart(8),
  );
  if (!ok) {
    failures.push(
      `${def.id}: released at the fastest speed the line still calls green, the car ` +
      `is asked for ${(worst * 100).toFixed(0)}% of the grip available at s=${worstS.toFixed(0)}m`,
    );
  }
}

console.log('');
if (failures.length === 0) {
  console.log('PASS — green means the car makes the corner, on all eleven circuits');
} else {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}

// ===========================================================================
// 3. What the old rule would have done, for comparison
// ===========================================================================
//
// The same measurement against the longitudinal-only rule the overlay used to
// apply. Reported rather than asserted: it is the control that shows the new
// test is doing work, and it is the number to quote if anyone proposes taking
// the lateral test back out.

console.log('\n\n=== the same measurement, driver-in-the-loop ===\n');
console.log('A credulous driver — full throttle on green, maximum braking on anything');
console.log('else — flown at every corner. Reported, not asserted: past the point the');
console.log('colour turns, what happens is about the driver, not the display.\n');
console.log(
  'circuit'.padEnd(14) + 'corners'.padStart(8) + 'worst load'.padStart(12) +
  '   longitudinal-only would be'.padStart(30),
);

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const line = new RacingLine(track);
  const corners = findCorners(track);
  let now = 0;
  let old = 0;
  for (const ci of corners) {
    now = Math.max(now, flyAt(track, line, ci, true).load);
    old = Math.max(old, flyAt(track, line, ci, false).load);
  }
  console.log(
    def.id.padEnd(14) + String(corners.length).padStart(8) +
    now.toFixed(3).padStart(12) + old.toFixed(3).padStart(30),
  );
}

// ===========================================================================

/**
 * The colour of the tarmac about 30m ahead of the car — the piece of road a
 * driver is actually looking at.
 *
 * Read out of the built vertex buffer rather than by calling the colouring
 * function directly, so this tests the thing that reaches the screen.
 */
function colourAhead(line: RacingLine, s: number, speedMs: number): [number, number, number] {
  line.update(s, speedMs);
  const c = line.mesh.geometry.getAttribute('color').array as Float32Array;
  const o = 4 * 6 * 3;
  return [c[o], c[o + 1], c[o + 2]];
}

function reads(r: number, g: number): string {
  if (r > 0.85 && g < 0.35) return 'RED';
  if (r > 0.6 && g > 0.45) return 'AMBER';
  return 'GREEN';
}

/** True when the road ahead is telling the driver to do nothing. */
function isGreen(r: number, g: number): boolean {
  return reads(r, g) === 'GREEN';
}

/**
 * The fastest the car can be going at `s` and still be shown a green road
 * ahead, or null if the line is never green there.
 *
 * Binary search, which is sound because every term of the ratio grows with
 * speed: the longitudinal one because a faster car brakes to a higher speed
 * over the same road, the lateral one because it is speed over a fixed grip
 * limit. Greenness is therefore monotone in speed and there is exactly one
 * crossing to find.
 */
function fastestGreen(track: TrackSpline, line: RacingLine, s: number): number | null {
  const [r0, g0] = colourAhead(line, s, 4);
  if (!isGreen(r0, g0)) return null;
  let lo = 4;
  let hi = track.solverParams.maxSpeedMs;
  const [r1, g1] = colourAhead(line, s, hi);
  if (isGreen(r1, g1)) return hi;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) * 0.5;
    const [r, g] = colourAhead(line, s, mid);
    if (isGreen(r, g)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Releases a car at `(s, v)` and reports the most lateral grip it is asked for.
 *
 * The car holds `v` for a reaction time and then brakes as hard as the tyres
 * will allow, all the way to the end of the drawn ribbon. The reaction time is
 * there because the display has not told the driver anything yet — the road is
 * green — so the earliest they can possibly begin is the moment it stops being
 * green, which is at least one frame after this.
 *
 * This is the promise the colour makes, stated as a measurement, and it needs
 * no model of how a driver uses the throttle. That matters: a synthetic driver
 * who goes to full power the instant the road turns green will exceed the grip
 * on the exit of a hairpin no matter how honest the display is, and a test that
 * cannot tell those two failures apart cannot be used to fix either.
 */
function releaseFrom(track: TrackSpline, s0: number, v0: number): number {
  const STEP_M = 2;
  const RANGE_M = 900;
  let v = v0;
  let s = s0;
  let load = 0;
  let coasted = 0;
  const coastM = v0 * RELEASE_REACTION_S;

  for (let d = 0; d < RANGE_M; d += STEP_M) {
    if (coasted >= coastM) {
      const sq = v * v - 2 * track.brakingDecel(v) * STEP_M;
      v = sq > 1 ? Math.sqrt(sq) : 1;
    } else {
      coasted += STEP_M;
    }
    s = (s + STEP_M) % track.length;
    const grip = track.corneringSpeed[track.indexAt(s)];
    const ask = v / Math.max(grip, 1);
    if (ask > load) load = ask;
    // Once the car is slow enough that nothing ahead can catch it out, stop.
    if (v <= 8) break;
  }
  return load;
}

/**
 * Every corner worth testing: a local minimum of the lateral grip limit that is
 * meaningfully slower than the road around it.
 */
function findCorners(track: TrackSpline): number[] {
  const { count, corneringSpeed } = track;
  const out: number[] = [];
  const WINDOW = 12;
  for (let i = 0; i < count; i++) {
    const v = corneringSpeed[i];
    // Flat out — nothing to test.
    if (v > 75) continue;
    let isMin = true;
    for (let k = -WINDOW; k <= WINDOW && isMin; k++) {
      const j = (i + k + count) % count;
      if (corneringSpeed[j] < v - 1e-6) isMin = false;
    }
    if (!isMin) continue;
    // Not a second sample of a corner already collected.
    if (out.length > 0) {
      const prev = out[out.length - 1];
      let d = Math.abs(i - prev);
      if (d > count / 2) d = count - d;
      if (d < WINDOW * 2) continue;
    }
    out.push(i);
  }
  return out;
}

/**
 * Flies one corner with a driver who obeys the display literally.
 *
 * The driver has no knowledge of the circuit — no memory of the corner, no
 * braking marker, nothing but the colour of the road in front of them. They
 * accelerate while it is green and brake as hard as the car will when it is
 * not, after a fifth of a second to react. That is deliberately the most
 * credulous driver possible, because the overlay's promise is made to exactly
 * that driver: someone who has been told the green line is the line to follow.
 *
 * @param lateral when false, the lateral test is suppressed and the driver is
 *                flown against the longitudinal-only rule the overlay used to
 *                apply — the control that shows the difference.
 * @returns the worst fraction of available lateral grip they were asked for.
 */
function flyAt(
  track: TrackSpline, line: RacingLine, cornerNode: number, lateral: boolean,
): { load: number; atS: number } {
  const RUN_UP_M = 700;
  const STEP_M = 2;
  const REACTION_S = 0.2;
  /** Continuous green needed before the driver gets back on the throttle. */
  const RELEASE_S = 0.5;
  /** Metres before the corner from which the car's grip usage is scored. */
  const SCORE_BEFORE_M = 260;
  const p = track.solverParams;

  const cornerS = track.dist[cornerNode];
  let s = (cornerS - RUN_UP_M + track.length) % track.length;
  // Start at the speed the solved profile says is right for that point, which
  // is where a driver on the line genuinely would be.
  let v = track.targetSpeed[track.indexAt(s)];
  // The reaction has to LATCH. Decrementing a timer and re-arming it whenever
  // it reaches zero gives a driver who brakes for one step in ten and coasts
  // into the corner at 260 km/h — which is a bug in the probe that looks
  // exactly like a bug in the thing being probed. Once the driver has committed
  // to braking they stay committed until the road goes green again.
  let reactionLeft = REACTION_S;
  let committed = false;
  let greenFor = RELEASE_S;

  let load = 0;
  let atS = s;

  const steps = Math.round((RUN_UP_M + 60) / STEP_M);
  for (let n = 0; n < steps; n++) {
    const [r, g] = colourAhead(line, s, v);
    // Suppressing the lateral half of the test cannot be done from out here, so
    // the control run reproduces the old rule directly: brake only once the
    // corner stops being reachable under the old flat deceleration.
    let act: boolean;
    if (lateral) {
      act = !isGreen(r, g);
    } else {
      const iB = track.indexAt(s + 30);
      const reachable = Math.sqrt(track.targetSpeed[iB] ** 2 + 2 * 38 * 30);
      act = v / Math.max(reachable, 1) > 0.78;
    }

    if (act) {
      greenFor = 0;
      if (!committed) {
        reactionLeft -= STEP_M / Math.max(v, 1);
        if (reactionLeft <= 0) committed = true;
      }
    } else {
      // Releasing the brake needs the road to have been green for a moment, not
      // merely to be green this instant.
      //
      // Without that, the model is a bang-bang controller: braking drops the
      // ratio under the threshold, the road goes green, it goes back to full
      // throttle, the road goes red again, and the car chatters into the corner
      // at a steady speed having neither braked nor accelerated. What that
      // measures is the stability of the controller, not the honesty of the
      // display. A driver lifts, waits to feel the car settle, and only then
      // gets back on it.
      greenFor += STEP_M / Math.max(v, 1);
      if (greenFor >= RELEASE_S) {
        committed = false;
        reactionLeft = REACTION_S;
      }
    }

    let a: number;
    if (committed) {
      a = -track.brakingDecel(v);
    } else {
      const fPower = p.powerW / Math.max(v, 1);
      const fTraction = p.mu * (p.massKg * 9.81 + p.cl * v * v) * 0.62;
      a = (Math.min(fPower, fTraction) - p.cd * v * v) / p.massKg;
    }

    const vSq = v * v + 2 * a * STEP_M;
    v = vSq > 1 ? Math.sqrt(vSq) : 1;

    s = (s + STEP_M) % track.length;

    // How much of the tyre the corner under the car is asking for, right now.
    //
    // Scored only near the corner this run is testing. The run-up is 700m long
    // and on a circuit like Monaco that crosses two or three other corners,
    // which the car enters carrying whatever speed this run's artificial
    // starting condition left it with. Those corners are not untested — each
    // gets its own run, with its own 700m of approach — and scoring them here
    // as well would be marking them against a starting speed that no lap ever
    // produces.
    const travelledM = (n + 1) * STEP_M;
    if (travelledM >= RUN_UP_M - SCORE_BEFORE_M) {
      const grip = track.corneringSpeed[track.indexAt(s)];
      const ask = v / Math.max(grip, 1);
      if (ask > load) { load = ask; atS = s; }
    }
  }

  return { load, atS };
}
