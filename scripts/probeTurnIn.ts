import { VehiclePhysics, steerRackLimit } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * Does the car actually rotate as much as its steering says it should?
 *
 * "Gliding" is the feel of a car whose heading lags its path: the front wheels
 * are turned, the car is loaded up, but the yaw rate never reaches what the
 * steering geometry implies, so it washes wide. Comparing achieved yaw rate
 * against the kinematic (Ackermann) rate for the same steer angle and speed
 * separates that from a simple lack of grip.
 *
 * Three things the first version of this probe got wrong, all of which made the
 * car look worse and stranger than it was:
 *
 *  1. It could not resolve `steerRackLimit` — it looked for it as a static on
 *     the class, found nothing, and fell back to a limit of 1.0. Every steer
 *     angle it printed was therefore overstated, by 2.2x at 260km/h, and the
 *     kinematic yaw rate along with it. It is a plain module export; import it.
 *
 *  2. It ran at a fixed 0.28 throttle, so the car did not hold the speed it
 *     claimed to be testing. The "80 km/h" row finished at 121 km/h and the
 *     "260 km/h" row at 226. Yaw rate looked pinned at ~0.52 rad/s across the
 *     whole matrix largely because every run had drifted toward a similar speed
 *     while sitting at the grip limit, where yaw rate is just a_lat/v. Speed is
 *     now held with a controller so the speed column means something.
 *
 *  3. It applied the steering as a step. Nothing — no driver, not the AI's own
 *     rate limiter — can produce that, and it excites a transient the probe then
 *     reads as a steady-state result. The input is ramped over 0.6s.
 *
 * The extra columns are the ones that identify WHICH axle is the problem:
 * `rearSlip` next to `frontSlip` shows whether the front is being asked to do
 * more than its share, and `balance` (positive = rear closer to its limit) says
 * the same thing directly.
 */
const env = { trackTempC: 40, airTempC: 25, wetness: 0, airDensityRatio: 1, abrasion: 1 };

/** Slip angle at which the magic formula peaks: sin(C*atan(B*a)) maxes at B*a = 1.978. */
const peakSlipDeg = (1.978 / BASE_F1_SPEC.corneringStiffnessFront) * 57.3;

console.log(`front tire peaks at ${peakSlipDeg.toFixed(2)} deg of slip — past that the tire is`);
console.log('over its friction circle and steering harder makes the car turn LESS.\n');
console.log('speed  steer  steerAng  yawKinematic  yawActual  ratio  frontSlip  rearSlip  balance   latG');

for (const kph of [80, 140, 200, 260]) {
  for (const steer of [0.2, 0.35, 0.5, 0.7, 1.0]) {
    const p = new VehiclePhysics(BASE_F1_SPEC, 'medium', 40);
    p.frontTires.fit('medium', 95);
    p.rearTires.fit('medium', 95);
    const v = kph / 3.6;
    p.placeAt(0, 0, 0, v);
    const c = { throttle: 0.2, brake: 0, steer: 0, drsRequested: false,
      ersMode: 'balanced' as const, gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false };

    for (let i = 0; i < Math.round(4.0 / PHYSICS_DT); i++) {
      c.steer = steer * Math.min(1, (i * PHYSICS_DT) / 0.6);
      // Hold the target speed, so this measures cornering and not deceleration.
      const err = v - p.speedMs;
      if (err > 0) { c.throttle = Math.min(1, err * 0.35); c.brake = 0; }
      else { c.throttle = 0; c.brake = Math.min(0.5, -err * 0.12); }
      p.step(PHYSICS_DT, c, env);
    }

    const steerAng = Math.abs(steer * p.spec.maxSteerRad * steerRackLimit(p.speedMs));
    const yawKin = p.speedMs * Math.tan(steerAng) / p.spec.wheelbaseM;
    const yawAct = Math.abs(p.yawRate);
    const front = p.frontTires.slipAngle * 57.3;
    console.log(
      `${String(kph).padStart(4)}  ${steer.toFixed(2)}  ${(steerAng * 57.3).toFixed(2).padStart(6)}deg` +
      `  ${yawKin.toFixed(3).padStart(10)}  ${yawAct.toFixed(3).padStart(9)}` +
      `  ${(yawAct / Math.max(yawKin, 1e-6)).toFixed(2).padStart(5)}` +
      `  ${front.toFixed(2).padStart(7)}deg${front > peakSlipDeg ? '*' : ' '}` +
      ` ${(p.rearTires.slipAngle * 57.3).toFixed(2).padStart(6)}deg` +
      `  ${p.balance.toFixed(2).padStart(7)}  ${p.lateralG.toFixed(2).padStart(5)}`,
    );
  }
  console.log();
}
console.log('* = front tire past its peak slip angle.');
