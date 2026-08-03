/**
 * Handling balance probe.
 *
 * The performance harness (`validate:physics`) answers "is this car fast?".
 * This one answers "does it drive?" — which is a different question and the one
 * players actually feel. It measures the three things that decide whether a car
 * is planted and responsive or vague and snappy:
 *
 *   1. TURN-IN RESPONSE. Time from a step steer input to 90% of the steady-state
 *      yaw rate. A real F1 car is on the order of 0.15-0.25s. Much slower and
 *      the car feels like it "will not turn"; much faster and it is twitchy.
 *
 *   2. LIMIT BALANCE. Which axle saturates first when you keep adding lock. If
 *      the rear runs out before the front, the car snaps into oversteer and the
 *      player reports "it drifts a lot". If the front runs out a long way
 *      before the rear, the car washes out and the player reports "it is hard
 *      to turn". A road-going race car wants the front marginally first.
 *
 *   3. STABILITY. Hold a corner at the limit, then lift off. A stable car
 *      settles; an unstable one diverges into a spin.
 *
 * The peak of the magic formula is at alpha = 1.978 / B (where B is the axle's
 * cornering stiffness), so the two stiffness numbers set BOTH the linear balance
 * and the limit balance and cannot be chosen independently. That coupling is why
 * this probe exists: it is the only way to see what a given pair actually does.
 *
 * Run: npm run probe:handling
 */

import { VehiclePhysics, type VehicleControls, type EnvironmentState } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';

const ENV: EnvironmentState = {
  trackTempC: 38, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
};

function controls(over: Partial<VehicleControls> = {}): VehicleControls {
  return {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'balanced', gearRequest: 0, pitLimiter: false, speedLimitMs: 0,
    reverse: false,
    ...over,
  };
}

function makeCar(downforceDemand = 0.55, fuelL = 60) {
  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(downforceDemand, fuelL));
  const car = new VehiclePhysics(spec, 'medium');
  car.fuelL = fuelL;
  car.frontTires.tempC = 105;
  car.rearTires.tempC = 108;
  car.frontTires.lapsOnSet = 2;
  car.rearTires.lapsOnSet = 2;
  return car;
}

/** Holds a constant steer at a constant speed and reports the settled state. */
function stepSteer(speedKph: number, steer: number, holdS = 4) {
  const car = makeCar();
  car.placeAt(0, 0, 0, speedKph / 3.6);
  const ctl = controls();

  // Settle straight-line first so load transfer and rpm are stable.
  for (let i = 0; i < 60; i++) {
    ctl.throttle = holdThrottle(car, speedKph);
    car.step(PHYSICS_DT, ctl, ENV);
  }

  ctl.steer = steer;
  const steady: number[] = [];
  let t = 0;
  let t90 = 0;
  let peakYaw = 0;
  let spun = false;

  const steps = Math.round(holdS / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    ctl.throttle = holdThrottle(car, speedKph);
    car.step(PHYSICS_DT, ctl, ENV);
    t += PHYSICS_DT;
    const yaw = Math.abs(car.yawRate);
    if (yaw > peakYaw) peakYaw = yaw;
    // A slip angle past 35 degrees is not a car cornering, it is a car spinning.
    if (Math.abs(Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 1))) > 0.61) spun = true;
    if (t > holdS * 0.6) steady.push(yaw);
  }

  const settledYaw = steady.reduce((a, b) => a + b, 0) / Math.max(steady.length, 1);

  // Second pass for the rise time, now that the settled value is known.
  {
    const c2 = makeCar();
    c2.placeAt(0, 0, 0, speedKph / 3.6);
    const k = controls();
    for (let i = 0; i < 60; i++) { k.throttle = holdThrottle(c2, speedKph); c2.step(PHYSICS_DT, k, ENV); }
    k.steer = steer;
    let tt = 0;
    for (let i = 0; i < steps; i++) {
      k.throttle = holdThrottle(c2, speedKph);
      c2.step(PHYSICS_DT, k, ENV);
      tt += PHYSICS_DT;
      if (!t90 && Math.abs(c2.yawRate) >= settledYaw * 0.9) { t90 = tt; break; }
    }
  }

  return {
    yawRate: settledYaw,
    peakYaw,
    lateralG: Math.abs(car.lateralG),
    balance: car.balance,
    alphaFrontDeg: (car.frontTires.slipAngle * 180) / Math.PI,
    alphaRearDeg: (car.rearTires.slipAngle * 180) / Math.PI,
    frontUse: car.frontLateralN / Math.max(car.capFrontN, 1),
    rearUse: car.rearLateralN / Math.max(car.capRearN, 1),
    t90,
    spun,
  };
}

/** Throttle needed to hold roughly constant speed, so drag does not decay it. */
function holdThrottle(car: VehiclePhysics, targetKph: number): number {
  const err = targetKph - car.speedKph;
  return Math.max(0, Math.min(0.55, 0.18 + err * 0.05));
}

const F = (n: number, w = 6, d = 2) => n.toFixed(d).padStart(w);

console.log('\nSTEP-STEER RESPONSE (constant speed, steady throttle)');
console.log('  SPEED  STEER   YAW/s   LAT g   T90    aF°    aR°   Fuse   Ruse  BAL   SPUN');
console.log('  ' + '-'.repeat(74));
for (const kph of [90, 150, 220, 300]) {
  for (const steer of [0.25, 0.5, 1.0]) {
    const r = stepSteer(kph, steer);
    console.log(
      '  ' + String(kph).padStart(5) + F(steer, 6) + F(r.yawRate, 8) + F(r.lateralG, 8) +
      F(r.t90, 7, 3) + F(r.alphaFrontDeg, 7, 1) + F(r.alphaRearDeg, 7, 1) +
      F(r.frontUse, 7) + F(r.rearUse, 7) + F(r.balance, 6) + (r.spun ? '   SPIN' : '   -'),
    );
  }
}

console.log('\nLIMIT BALANCE (which axle gives up first as lock is added)');
console.log('  Positive balance = the REAR is closer to its limit (oversteer/drift).');
console.log('  SPEED   first-to-saturate   steer at saturation   balance there');
console.log('  ' + '-'.repeat(66));
for (const kph of [90, 150, 220, 300]) {
  let firstAxle = 'neither';
  let atSteer = 0;
  let bal = 0;
  for (let s = 0.1; s <= 1.001; s += 0.05) {
    const r = stepSteer(kph, s, 2.5);
    if (r.frontUse > 0.985 || r.rearUse > 0.985 || r.spun) {
      firstAxle = r.spun ? 'REAR (spin)' : r.frontUse >= r.rearUse ? 'front' : 'REAR';
      atSteer = s;
      bal = r.balance;
      break;
    }
  }
  console.log('  ' + String(kph).padStart(5) + '   ' + firstAxle.padEnd(18) +
    F(atSteer, 20) + F(bal, 16));
}

console.log('\nLIFT-OFF STABILITY (at the limit, close the throttle, does it settle?)');
console.log('  SPEED   peak slip after lift   outcome');
console.log('  ' + '-'.repeat(50));
for (const kph of [110, 180, 260]) {
  const car = makeCar();
  car.placeAt(0, 0, 0, kph / 3.6);
  const ctl = controls({ steer: 0.55 });
  for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
    ctl.throttle = holdThrottle(car, kph);
    car.step(PHYSICS_DT, ctl, ENV);
  }
  ctl.throttle = 0;
  let peakSlip = 0;
  for (let i = 0; i < Math.round(2.5 / PHYSICS_DT); i++) {
    car.step(PHYSICS_DT, ctl, ENV);
    const slip = Math.abs(Math.atan2(car.localVelY, Math.max(Math.abs(car.localVelX), 1)));
    if (slip > peakSlip) peakSlip = slip;
  }
  const deg = (peakSlip * 180) / Math.PI;
  console.log('  ' + String(kph).padStart(5) + F(deg, 22, 1) + '°   ' +
    (deg > 35 ? 'SPUN' : deg > 14 ? 'sliding but caught' : 'settled'));
}

console.log('');
