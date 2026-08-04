import { wrapAngle } from '../core/MathUtils';
import type { CarEntry } from '../race/CarEntry';
import type { SafetyCar } from '../race/SafetyCar';

/**
 * Movement in one physics step beyond which the car was PLACED, not driven.
 *
 * The fastest thing on the circuit does about 100 m/s, which is 0.84m in a
 * 120Hz step, and a barrier rebound resolves inside a step without moving the
 * car far. 5m is six times the honest maximum and far below the smallest
 * teleport there is (a pit-box placement moves tens of metres), so it separates
 * the two cleanly with nothing near the boundary. See `updateRenderPoses`.
 */
export const TELEPORT_M = 5;

/**
 * Places every car where it should be DRAWN this frame.
 *
 * THE BUG THIS FIXES. The doc comment on `Renderer.render` used to say that
 * `alpha` was "unused for now; the physics runs at 120Hz, comfortably above
 * display rate", and that reasoning is the defect. Being above the display rate
 * is not the property that matters — being an INTEGER MULTIPLE of it is, and it
 * almost never is. The accumulator hands out whole steps, so a 50fps frame
 * worth 2.4 steps is delivered as 2, 2, 3, 2, 3, 2, 2, 3... A car at 80 m/s
 * covers 0.67m per step, so drawn at the last completed step it advances 1.33m
 * on one frame and 2.00m on the next: the same car, on the same straight, at
 * the same speed, apparently accelerating and decelerating by 50% every frame.
 * That is the reported "one frame and then the next frame that car moves to
 * another position ... its not a smooth frame transition".
 *
 * WHY ONLY OTHER CARS. The player's car looked fine because every following
 * camera is anchored to it. The camera inherits the identical stagger, so in
 * screen space the error cancels and the player's car sits still while the
 * whole world — and every rival in it — judders around it. The report said
 * exactly that, and it is the signature of this bug and of no other.
 *
 * THE FIX is the standard one for a fixed-step simulation: draw the pose at
 * `alpha` of the way from the previous step to the current one, where `alpha`
 * is the fraction of a step still sitting in the accumulator. That renders up
 * to one step (8.3ms) in the past, which is invisible, and removes the stagger
 * entirely because the drawn pose is now a continuous function of wall-clock
 * time instead of a staircase.
 *
 * THE POSE IS FIVE NUMBERS, NOT THREE — issue #54, and this is the half that
 * #9 missed. `x`, `z` and `heading` place a car in PLAN. Every height in the
 * scene comes from `s` and `lateral` instead, because the road is a swept
 * ribbon and the only way to ask how high the asphalt is under a car is to ask
 * where the car is ALONG and ACROSS it (`bankedCarGroundY`). Interpolating the
 * first three and not the last two makes the drawn world a continuous function
 * of wall-clock time horizontally and a staircase vertically — the same 2,2,3
 * stagger, rotated 90 degrees. Worse: the CAMERA's own height is taken from
 * the same pair (`CameraDirector`), so unlike the plan error this one does NOT
 * cancel in screen space for the car being followed. It is applied to the
 * viewpoint, which is why the user reported it as *"jittering happening for the
 * track"* rather than as the cars juddering. Measured by `probe:framerate`,
 * section "WORLD SMOOTHNESS".
 *
 * `s` WRAPS AT THE LINE, exactly as heading wraps at +-pi, so it gets the same
 * short-way-round treatment. Without it a car crossing the Line reads as
 * travelling backwards round the entire circuit inside one frame, and the
 * height it is drawn at is sampled from the far side of the lap.
 *
 * TELEPORTS ARE NOT INTERPOLATED. A car placed on the grid, serviced in its
 * box or craned back onto the circuit moves further in one step than any car
 * can drive, and lerping across that would smear it over several hundred
 * metres of scenery for a frame. Anything beyond `TELEPORT_M` snaps — in plan,
 * along the lap, or across it. The along-the-lap test also covers a PROJECTION
 * jump with no teleport behind it at all: at Suzuka's crossover the two legs of
 * the figure-of-eight pass within 0.159m of each other (issue #37), so
 * `project` can hand back an `s` from the other leg, and the height with it.
 *
 * Cost: five lerps and two wraps per car per frame — 22 cars is about a
 * microsecond, which is why this was always the right thing to do.
 *
 * Lives in its own module rather than inside `Renderer` so that a probe can
 * drive the REAL rule. `probe:framerate` measures the camera's height through
 * the real `CameraDirector` fed by the real interpolation; a probe that
 * restated either of them would be measuring its own copy, which is the
 * failure mode §3.2 of PROJECT.md exists to prevent.
 *
 * @param cars        every car in the session
 * @param trackLength lap length in metres, for the wrap at the Line
 * @param alpha       fraction of a physics step left in the accumulator.
 *                    Passing 1 draws the last completed step, which is what
 *                    the renderer did before interpolation existed — so it is
 *                    also the honest control for any measurement of this.
 */
export function updateRenderPoses(cars: readonly CarEntry[], trackLength: number, alpha: number): void {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const half = trackLength * 0.5;
  for (const car of cars) {
    const p = car.physics;
    const dx = p.position.x - car.prevX;
    const dz = p.position.y - car.prevZ;
    // Along the lap, the short way round.
    let ds = car.s - car.prevS;
    if (ds < -half) ds += trackLength;
    else if (ds > half) ds -= trackLength;
    const dlat = car.lateral - car.prevLateral;

    if (dx * dx + dz * dz > TELEPORT_M * TELEPORT_M ||
        Math.abs(ds) > TELEPORT_M || Math.abs(dlat) > TELEPORT_M) {
      car.renderX = p.position.x;
      car.renderZ = p.position.y;
      car.renderHeading = p.heading;
      car.renderS = car.s;
      car.renderLateral = car.lateral;
      continue;
    }

    car.renderX = car.prevX + dx * a;
    car.renderZ = car.prevZ + dz * a;
    // Through the short way round. A car crossing the +-pi branch would
    // otherwise spin through a full turn in one frame, which is a far worse
    // artefact than the one being fixed.
    car.renderHeading = car.prevHeading + wrapAngle(p.heading - car.prevHeading) * a;

    // Back into [0, length) after the wrap-aware lerp, because every consumer
    // hands this straight to `TrackSpline`, which indexes on it.
    let s = car.prevS + ds * a;
    if (s < 0) s += trackLength;
    else if (s >= trackLength) s -= trackLength;
    car.renderS = s;
    car.renderLateral = car.prevLateral + dlat * a;
  }
}

/**
 * The same rule, for the one vehicle on the circuit that is not a `CarEntry`.
 *
 * WHY IT NEEDED ITS OWN CALL. #54 gave every racing car a five-number pose and
 * `Renderer.syncSafetyCar` was left reading `sc.s`/`sc.lateral` — the raw
 * solver state — for its height AND for its plan position, because both come
 * out of `toWorld(sc.s, sc.lateral)`. So the safety car was stepped in all
 * three axes while everything around it was smooth, which under a
 * neutralisation is the one vehicle every camera in the game is pointed at.
 * §7 of PROJECT.md listed it as the half #54 could not reach, because
 * `SafetyCar` is race-side code.
 *
 * It is a SEPARATE function rather than a widened `updateRenderPoses` because
 * the safety car is not a competitor and deliberately not in `engine.cars` —
 * see the header of `SafetyCar.ts` for the twenty things that array subscript
 * means. What it does share is this rule, and sharing the rule is the whole
 * point: a probe that measured the cars with one interpolation and the safety
 * car with another would be measuring its own copy.
 *
 * The teleport test is the one that matters here rather than an optimisation.
 * The safety car is PLACED twice in every deployment — `join()` sets `s` to the
 * pit exit and `returnToPits()`/the garage arrival set it back to the holding
 * point, both of which move it most of a lap in one step.
 */
export function updateSafetyCarPose(sc: SafetyCar, trackLength: number, alpha: number): void {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const half = trackLength * 0.5;

  let ds = sc.s - sc.prevS;
  if (ds < -half) ds += trackLength;
  else if (ds > half) ds -= trackLength;
  const dlat = sc.lateral - sc.prevLateral;

  if (Math.abs(ds) > TELEPORT_M || Math.abs(dlat) > TELEPORT_M) {
    sc.renderS = sc.s;
    sc.renderLateral = sc.lateral;
    return;
  }

  let s = sc.prevS + ds * a;
  if (s < 0) s += trackLength;
  else if (s >= trackLength) s -= trackLength;
  sc.renderS = s;
  sc.renderLateral = sc.prevLateral + dlat * a;
}
