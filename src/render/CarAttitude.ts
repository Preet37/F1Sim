/**
 * The attitude a car is DRAWN at, and what standing on the ground costs it.
 *
 * `Renderer.syncCars` places a car's origin on the drawn asphalt
 * (`bankedCarGroundY`) and then rotates the whole visual about that origin.
 * Every wheel is built with its contact patch at car-local y = 0 (`CarMesh`),
 * which is the only frame in which the placement rule can be one number, so the
 * origin sits exactly on the surface and the tyres touch it.
 *
 * There are TWO rotations in that stack and they are different things:
 *
 *  1. **The road's own attitude** (`surfaceAttitude`). The road is neither flat
 *     nor level, and a car is a rigid body 3.6m long and 1.9m wide, so being
 *     right at the origin is not being right. This one is exact, undamped, and
 *     applies to every car all the time. Issue #71.
 *  2. **The lean under load** (`corneringRoll` / `corneringPitch`, and
 *     `wreckLean` for a car that has stopped). This models the BODY moving on
 *     its suspension while the tyres stay planted, and it is a deviation FROM
 *     the road plane rather than from the horizontal. Damped, small, and
 *     deliberately not compensated for a running car — see `groundLift`.
 *
 * ROTATING ABOUT THE ORIGIN PUTS CONTACT POINTS UNDERGROUND: a lean of `theta`
 * puts a contact point `r` metres out from the axis `r * sin(theta)` below the
 * plane the car was placed on, and the outer edge of a front tyre is 962mm from
 * the centreline while a front axle is 1800mm from the origin. For (1) that
 * does not arise, because the rotation IS the plane the points are measured
 * against. For (2) it does, and `groundLift` is what pays for it.
 *
 * Lives in its own module rather than inside `Renderer` for the same reason
 * `RenderPose.ts` does: so that a probe can drive the REAL rule instead of
 * restating it, which is the failure mode PROJECT.md section 3.2 exists to
 * prevent. `probe:crashrest` sections 2 and 4 raycast the drawn road under the
 * points below, with the attitude, the lean and the lift this module computes.
 *
 * NO THREE AND NO DOM. The rotation matrix is written out by hand — it is nine
 * lines — rather than borrowed from `THREE.Euler`, so that this module can be
 * imported by anything, including a probe that never builds a scene.
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
 * fall to zero and it would sit dead level ON THE ROAD — the one attitude a car
 * that has just been in an accident is never in. Deterministic from the index
 * so it is stable for the session with no state to store.
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

/**
 * The attitude a car lies at, plus the plane it is lying on.
 *
 * `gradX`/`gradZ` are the drawn surface's gradient in world x and z under the
 * car — dy/dx and dy/dz of the plane through the four sample points. They are
 * carried alongside the angles because `groundLift` has to measure a lean
 * against the ROAD rather than against the horizontal, and on 18 degrees of
 * banking those two planes are 313mm apart at the edge of a tyre.
 */
export interface SurfacePose {
  pitch: number;
  roll: number;
  gradX: number;
  gradZ: number;
  /**
   * How far the origin must rise for the plane to clear the road, metres.
   *
   * Not part of the ANGLE rule — `surfaceAttitude` leaves it alone — because it
   * is a property of the surface's curvature rather than of its slope, and only
   * something that has read the surface can know it. `TrackMesh.roadPoseUnderCar`
   * fills it in; see the note there.
   */
  lift: number;
}

/** A fresh, level pose. Callers that keep one per car reuse it. */
export function newSurfacePose(): SurfacePose {
  return { pitch: 0, roll: 0, gradX: 0, gradZ: 0, lift: 0 };
}

/**
 * THE ATTITUDE THE ROAD PUTS A CAR AT — issue #71.
 *
 * Before this existed the car root was given `rotation.y` from the heading and
 * `rotation.x` / `rotation.z` from the car's own accelerations, and NOTHING at
 * all from the surface under it. The origin was placed correctly and the car
 * was then drawn horizontal, so on any gradient the downhill axle went under
 * the asphalt and on any banking the low-side tyre did. It is pure geometry: a
 * 3.6m wheelbase on Spa's 18.7% gradient buries an axle 337mm, and a 1.925m
 * track on Zandvoort's 18 degrees buries a tyre 313mm. Raycast against the
 * drawn triangles it measured 434mm at Monaco, 396mm at Zandvoort and 341mm at
 * Spa — and 15mm at Monza, because Monza is flat, which is PROJECT.md section
 * 3.5 in one line.
 *
 * This is the ANGLE half of the rule and it takes the plane as given. Reading
 * the road is `TrackMesh.roadPoseUnderCar`, which samples the drawn surface at
 * this car's own four corners and calls straight through to here — that split
 * is what keeps this module free of three and of the track model, so a probe
 * can drive the rule with nothing loaded.
 *
 * UNDAMPED, deliberately, at both consumers. The lean under load is damped
 * because it is a body moving on springs; this is the road, and a road does not
 * lag. Filtering it would put the car through the asphalt at the foot of every
 * gradient for as long as the filter took to catch up, which is the defect
 * rather than a softer version of it. The only smoothing is the 3.6m baseline
 * the surface is read over, and that is smoothing of the right kind: a car's
 * attitude is set by where its wheels are, not by the ground under its middle.
 *
 * @param gradX,gradZ the drawn road's gradient under the car, dy/dx and dy/dz
 * @param heading     the car's drawn heading, radians (`renderHeading`)
 */
export function surfaceAttitude(
  gradX: number, gradZ: number, heading: number,
  out: SurfacePose = newSurfacePose(),
): SurfacePose {
  // The gradient resolved onto the car's own axes. The nose (+z local) points
  // along (sin h, cos h) and the car's LEFT (+x local) along (cos h, -sin h) —
  // the same convention as `root.rotation.y = heading` on an Object3D, which is
  // where these angles end up.
  const sh = Math.sin(heading), ch = Math.cos(heading);
  const slopeFwd = gradX * sh + gradZ * ch;
  const slopeLeft = gradX * ch - gradZ * sh;

  // SIGNS, from the rotation these end up in. With order 'YXZ' the car's nose
  // (0, 0, 1) goes to (0, -sin p, cos p), so a POSITIVE pitch is nose DOWN and
  // a road that rises ahead asks for a negative one. The car's left (1, 0, 0)
  // goes to (cos r, sin r cos p, ...), so a POSITIVE roll lifts the left-hand
  // side, which is what a road whose left side is higher asks for.
  out.pitch = -Math.atan(slopeFwd);
  out.roll = Math.atan(slopeLeft);
  out.gradX = gradX;
  out.gradZ = gradZ;
  return out;
}

/**
 * How far the origin must RISE so that no contact point ends up under the road.
 *
 * Exactly the depth of the deepest contact point below the PLANE THE CAR IS
 * STANDING ON, or zero if the rotation happens to lift all eight. That is what
 * a car standing on a surface does: it pivots about whichever corner is lowest
 * and the rest of it comes up, which is also what a real car on its suspension
 * does — the loaded tyre stays on the road and the unloaded one rises.
 *
 * THE PLANE, NOT THE HORIZONTAL, and that half of it is #71. Once the car
 * follows the road, its contact points are legitimately below the horizontal
 * plane through its origin — 313mm of them at Zandvoort — and a lift measured
 * against the horizontal would fling the car into the air on every banked
 * corner. `gradX`/`gradZ` come straight out of `surfaceAttitude`, so the plane
 * the lift is measured against is the plane the attitude was solved from.
 *
 * THE HEADING IS AN ARGUMENT AND IT MATTERS. `Renderer` writes the three angles
 * onto an `Object3D`, and this has to build the same rotation from the same
 * three numbers in the same order or it would correct for a pose nobody drew.
 * That order is 'YXZ' — `Ry * Rx * Rz`, yaw then pitch then roll, so the pitch
 * is about the CAR's own lateral axis. It used to be three's default 'XYZ',
 * which applies the pitch about the WORLD x axis AFTER the yaw, so a car
 * heading along +x received its braking pitch as pure ROLL. That was a defect
 * in its own right and it is fixed with #71; both consumers
 * (`Renderer.syncCars` and `CameraDirector`'s cockpit and driver's-eye rigs)
 * now build the same order as this does.
 */
export function groundLift(
  pitch: number, heading: number, roll: number, gradX = 0, gradZ = 0,
): number {
  if (pitch === 0 && roll === 0 && gradX === 0 && gradZ === 0) return 0;
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sr = Math.sin(roll), cr = Math.cos(roll);
  const sy = Math.sin(heading), cy = Math.cos(heading);

  // R = Ry(heading) * Rx(pitch) * Rz(roll), written out. Only the two columns a
  // contact point at (x, 0, z) can reach are needed.
  // Rx*Rz takes (1,0,0) to (cr, sr*cp, sr*sp) and (0,0,1) to (0, -sp, cp);
  // then Ry takes (a,b,c) to (a*cy + c*sy, b, -a*sy + c*cy).
  const xColX = cr * cy + sr * sp * sy;
  const xColY = sr * cp;
  const xColZ = -cr * sy + sr * sp * cy;
  const zColX = cp * sy;
  const zColY = -sp;
  const zColZ = cp * cy;

  let deepest = 0;
  for (const [x, z] of CONTACT_POINTS) {
    const dx = xColX * x + zColX * z;
    const dy = xColY * x + zColY * z;
    const dz = xColZ * x + zColZ * z;
    // Height of the contact point above the road plane through the origin.
    const clearance = dy - (gradX * dx + gradZ * dz);
    if (clearance < deepest) deepest = clearance;
  }
  return -deepest;
}
