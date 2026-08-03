/** TEMPORARY DIAGNOSTIC. Does an empty tank produce the stall signature? */
import { VehiclePhysics } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC } from '../src/physics/VehicleSpec';
import type { VehicleControls, EnvironmentState } from '../src/physics/VehiclePhysics';

const ENV: EnvironmentState = {
  trackTempC: 40, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
};

function run(fuelL: number): string {
  const p = new VehiclePhysics({ ...BASE_F1_SPEC });
  p.placeAt(0, 0, 0, 3);
  p.fuelL = fuelL;
  const c: VehicleControls = {
    throttle: 0.2, brake: 0, steer: 0, drsRequested: false, ersMode: 'harvest',
    gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
  };
  const out: string[] = [];
  for (let i = 0; i < 1200; i++) {
    p.step(1 / 120, c, ENV);
    if (i % 240 === 0) out.push(`t=${(i / 120).toFixed(1)}s v=${p.speedMs.toFixed(2)} gear=${p.gear} rpm=${p.rpm.toFixed(0)} trac=${p.tractionLimitFraction.toFixed(2)} fuel=${p.fuelRemaining.toFixed(2)}`);
  }
  return out.join('\n  ');
}

console.log('FULL TANK, 20% throttle from 3 m/s');
console.log('  ' + run(50));
console.log('\nEMPTY TANK, 20% throttle from 3 m/s');
console.log('  ' + run(0));
