import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import { DEFAULT_INPUT_CONFIG } from '../src/input/InputController';

/** How much grip exists vs how much pedal authority sits behind each control. */
const s = BASE_F1_SPEC;
const G = 9.81;
const massKg = s.dryMassKg + 100 * s.fuelDensity;

console.log(`mass ${massKg.toFixed(0)}kg   brakes ${s.maxBrakeForceN}N   power ${(s.icePowerW/1000).toFixed(0)}kW\n`);
console.log('speed   downforce   grip(all4)   brakeAuthority   pedal@lock   throttle@spin');
for (const kph of [60, 100, 150, 200, 250, 300]) {
  const v = kph / 3.6;
  const df = s.clBase * v * v;
  const load = massKg * G + df;
  const gripAll = s.baseMu * load;
  // Brake force is applied to all four wheels, so compare against total grip.
  const pedalAtLock = Math.min(1, gripAll / s.maxBrakeForceN);
  // Drive is rear-axle only; roughly half the load plus the rear aero share.
  const rearLoad = load * (1 - s.aeroBalanceFront);
  const gripRear = s.baseMu * rearLoad;
  const driveForce = Math.min(s.icePowerW / Math.max(v, 1), 30000);
  const throttleAtSpin = Math.min(1, gripRear / driveForce);
  console.log(
    `${String(kph).padStart(4)}   ${df.toFixed(0).padStart(8)}N   ${gripAll.toFixed(0).padStart(8)}N   ` +
    `${s.maxBrakeForceN}N        ${pedalAtLock.toFixed(2)}          ${throttleAtSpin.toFixed(2)}`,
  );
}
const c = DEFAULT_INPUT_CONFIG;
console.log(`\nkeyboard ramp: throttle 0->1 in ${(1/c.keyboardThrottleRate).toFixed(3)}s, ` +
  `brake 0->1 in ${(1/c.keyboardBrakeRate).toFixed(3)}s`);
console.log(`brake reaches full ${(c.keyboardBrakeRate/c.keyboardThrottleRate).toFixed(2)}x faster than throttle`);
