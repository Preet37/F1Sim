import * as THREE from 'three';

/**
 * The attitude a car is DRAWN at, and what standing on the ground costs it.
 *
 * `Renderer.syncCars` places a car's origin on the drawn asphalt
 * (`bankedCarGroundY`) and then rotates the whole visual about that origin —
 * roll on z, pitch on x. Every wheel is built with its contact patch at car-
 * local y = 0 (`CarMesh`), which is the only frame in which the placement rule
 * can be one number, so the origin sits exactly on the surface and the tyres
 * touch it. ROTATE ABOUT THAT ORIGIN AND THEY DO NOT: a lean of `theta` puts
 * the contact point `r` metres out from the axis of rotation `r * sin(theta)`
 * BELOW the surface the car was placed on, and the outer edge of a front tyre
 * is 962mm from the centreline while a front axle is 1800mm from the origin.
 *
 * FOR A RUNNING CAR that is a transient and it is left alone deliberately —
 * see `wreckLean` below. FOR A WRECK it is permanent, it is the largest lean
 * the renderer ever applies, and it is issue #58: *"one the wheels are in the
 * ground not sure how thats possible"*.
 *
 * Lives in its own module rather than inside `Renderer` for the same reason
 * `RenderPose.ts` does: so that a probe can drive the REAL rule instead of
 * restating it, which is the failure mode PROJECT.md section 3.2 exists to
 * prevent. `probe:crashrest` raycasts the drawn road under the points below,
 * with the lean and the lift this module computes.
 */

/**
 * Half the front and rear track, plus half a tyre, and the axle positions.
 *
 * These are the numbers from `CarMesh` — `FRONT_HUB_X`, `REAR_HUB_X`,
 * `FRONT_TYRE_W`, `REAR_TYRE_W`, `FRONT_AXLE_Z`, `REAR_AXLE_Z` — and they are
 * restated rather than imported because importing `CarMesh` pulls the whole
 * geometry builder, its canvas-painted textures and three's material stack into
 * the placement path. `probe:carrig` measures the real merged geometry against
 * these, so a change to the car that moved a hub would be caught there.
 *
 * A tyre is a cylinder resting on a plane, so what touches the ground is the
 * LINE across its width at the axle, and the two ends of that line are the
 * extremes under any lean. Eight points, four wheels.
 */
export const CONTACT_POINTS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (const [hub, z, w] of [
    [0.800, 1.80, 0.325],   // front
    [0.780, -1.80, 0.425],  // rear
  ] as [number, number, number][]) {
    for (const side of [-1, 1]) {
      out.push([side * (hub + w * 0.5), z]);
      out.push([side * (hub - w * 0.5), z]);
    }
  }
  return out;
})();

/** Roll, radians, that a car under lateral load is drawn at. */
export function corneringRoll(lateralG: number): number {
  return Math.max(-0.06, Math.min(0.06, -lateralG * 0.016));
}

/** Pitch, radians, that a car under longitudinal load is drawn at. */
export function corneringPitch(longitudinalG: number): number {
  return Math.max(-0.05, Math.min(0.05, longitudinalG * 0.012));
}

/**
 * The settled lean a wreck is drawn at, from its own index.
 *
 * A wreck has no accelerations, so `corneringRoll` and `corneringPitch` both
 * fall to zero and it would sit dead level and square to the road — the one
 * attitude a car that has just been in an accident is never in. Deterministic
 * from the index so it is stable for the session with no state to store.
 *
 * Up to 0.075 rad of roll and 0.045 of pitch: 4.3 and 2.6 degrees. Small on
 * paper, and at the 962mm and 1800mm the contact points sit from the axes it
 * is 72mm plus 81mm of tyre under the road.
 */
export function wreckLean(index: number): { roll: number; pitch: number } {
  return {
    roll: Math.sin(index * 12.9898) * 0.075,
    pitch: Math.cos(index * 4.1414) * 0.045,
  };
}

const scratchEuler = new THREE.Euler();
const scratchMatrix = new THREE.Matrix4();

/**
 * How far the origin must RISE so that no contact point ends up underground.
 *
 * Exactly the depth of the deepest contact point under the leaned rotation, or
 * zero if the lean happens to lift all eight. That is what a car standing on a
 * surface does: it pivots about whichever corner is lowest and the rest of it
 * comes up, which is also what a real car on its suspension does — the loaded
 * tyre stays on the road and the unloaded one rises.
 *
 * THE HEADING IS AN ARGUMENT AND IT MATTERS. `Renderer` writes the three angles
 * onto an `Object3D`, whose Euler order is the default 'XYZ' — that is
 * `RX * RY * RZ`, so the pitch is applied about the WORLD x axis, AFTER the
 * yaw. A car pointing along world x therefore receives its "pitch" as roll.
 * That is a defect in its own right (recorded in PROJECT.md section 7), but the
 * lift has to be computed against the rotation that is actually applied rather
 * than against the one that was meant, or it would under-correct exactly where
 * the error is worst. So this builds the same Euler, in the same order, from
 * the same three numbers.
 */
export function groundLift(pitch: number, heading: number, roll: number): number {
  if (pitch === 0 && roll === 0) return 0;
  scratchEuler.set(pitch, heading, roll, 'XYZ');
  scratchMatrix.makeRotationFromEuler(scratchEuler);
  const m = scratchMatrix.elements;
  // Column-major: the y component of R * (x, 0, z) is m[4*0+1]*x + m[4*2+1]*z.
  const yx = m[1];
  const yz = m[9];
  let deepest = 0;
  for (const [x, z] of CONTACT_POINTS) {
    const y = yx * x + yz * z;
    if (y < deepest) deepest = y;
  }
  return -deepest;
}
