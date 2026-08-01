/**
 * Physics validation harness.
 *
 * Runs the vehicle model through the standard performance tests and compares
 * against published figures for a current-generation F1 car. These are the
 * numbers that tell you whether the model is a car or just a set of equations:
 *
 *   0-100 km/h        ~2.6 s
 *   0-200 km/h        ~4.6 s
 *   0-300 km/h        ~8.6 s
 *   top speed         330-360 km/h depending on trim
 *   300-0 km/h        ~4.0 s in roughly 120 m
 *   peak braking      ~6-7 g of specific force (tire plus ~1g of drag at 300)
 *   peak lateral      ~2.0 g at 100 km/h, 4.5-6.0 g at 250+ km/h
 *
 * Run: npm run validate:physics
 */

import { VehiclePhysics, type VehicleControls, type EnvironmentState } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';
import { PHYSICS_DT } from '../src/core/SimClock';
import { MS_TO_KPH } from '../src/core/MathUtils';

const ENV: EnvironmentState = {
  trackTempC: 38,
  airTempC: 25,
  wetness: 0,
  airDensityRatio: 1,
  abrasion: 1,
};

function controls(over: Partial<VehicleControls> = {}): VehicleControls {
  return {
    throttle: 0, brake: 0, steer: 0,
    drsRequested: false, ersMode: 'push', gearRequest: 0, pitLimiter: false, speedLimitMs: 0,
    ...over,
  };
}

/** Builds a car in low-downforce trim (Monza) unless told otherwise. */
function makeCar(downforceDemand = 0.15, fuelL = 10) {
  const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(downforceDemand, fuelL));
  const car = new VehiclePhysics(spec, 'soft');
  car.fuelL = fuelL;
  // Tires in their window, as they would be on a hot lap.
  car.frontTires.tempC = 105;
  car.rearTires.tempC = 108;
  car.frontTires.lapsOnSet = 2;
  car.rearTires.lapsOnSet = 2;
  return car;
}

const pass = (ok: boolean) => (ok ? 'ok  ' : 'FAIL');
const failures: string[] = [];
function check(label: string, value: number, lo: number, hi: number, unit: string): void {
  const ok = value >= lo && value <= hi;
  if (!ok) failures.push(`${label}: ${value.toFixed(2)}${unit} outside expected ${lo}-${hi}${unit}`);
  console.log(
    '  ' + pass(ok) + ' ' + label.padEnd(26) +
    value.toFixed(2).padStart(8) + ' ' + unit.padEnd(5) +
    ' expected ' + lo + '-' + hi + unit,
  );
}

// ===========================================================================
console.log('\nSTANDING ACCELERATION (low-downforce trim, 10L fuel)');
// ===========================================================================
{
  const car = makeCar();
  car.placeAt(0, 0, 0, 0);
  const ctl = controls({ throttle: 1, ersMode: 'overtake' });

  // A launch is run by a clutch and torque map, not by flooring the throttle:
  // now that spinning the rears costs grip, feeding the power in is genuinely
  // quicker. This models a good getaway rather than a wheelspin-limited one.
  let t = 0;
  let t100 = 0, t200 = 0, t300 = 0;
  let distance100 = 0;
  let peakLongG = 0;

  while (t < 30) {
    ctl.throttle = Math.min(1, car.tractionLimitFraction * 1.02);
    car.step(PHYSICS_DT, ctl, ENV);
    t += PHYSICS_DT;
    const kph = car.speedKph;
    if (!t100 && kph >= 100) { t100 = t; distance100 = car.position.y; }
    if (!t200 && kph >= 200) t200 = t;
    if (!t300 && kph >= 300) t300 = t;
    if (car.longitudinalG > peakLongG) peakLongG = car.longitudinalG;
    if (t300) break;
  }

  check('0-100 km/h', t100 || 99, 2.2, 3.2, 's');
  check('0-200 km/h', t200 || 99, 3.9, 5.6, 's');
  check('0-300 km/h', t300 || 99, 7.2, 11.5, 's');
  check('distance to 100 km/h', distance100, 20, 50, 'm');
  check('peak acceleration', peakLongG, 1.1, 2.2, 'g');
}

// ===========================================================================
console.log('\nTOP SPEED (drag-limited)');
// ===========================================================================
{
  for (const [label, demand] of [['Monza trim', 0.12], ['Monaco trim', 1.0]] as const) {
    const car = makeCar(demand);
    car.placeAt(0, 0, 0, 60);
    car.drsAvailable = true;
    const ctl = controls({ throttle: 1, ersMode: 'balanced', drsRequested: true });
    for (let i = 0; i < 120 * 120; i++) car.step(PHYSICS_DT, ctl, ENV);
    const lo = demand < 0.5 ? 320 : 250;
    const hi = demand < 0.5 ? 372 : 310;
    check('top speed, ' + label, car.speedKph, lo, hi, 'kph');
  }

  // DRS should be worth a real chunk of top speed.
  const car = makeCar(0.5);
  car.placeAt(0, 0, 0, 70);
  const closed = controls({ throttle: 1, ersMode: 'overtake' });
  for (let i = 0; i < 120 * 60; i++) car.step(PHYSICS_DT, closed, ENV);
  const vClosed = car.speedKph;

  car.drsAvailable = true;
  const open = controls({ throttle: 1, ersMode: 'overtake', drsRequested: true });
  for (let i = 0; i < 120 * 60; i++) car.step(PHYSICS_DT, open, ENV);
  const vOpen = car.speedKph;
  check('DRS top-speed gain', vOpen - vClosed, 8, 30, 'kph');
}

// ===========================================================================
console.log('\nBRAKING FROM 300 km/h');
// ===========================================================================
{
  // Two runs: a driver modulating the pedal at the limit, and a driver simply
  // standing on it. The second must be SLOWER — locking the fronts has to cost
  // stopping distance, or lock-ups carry no penalty and brake modulation stops
  // being a skill the sim rewards.
  function stop(modulate: boolean) {
    const car = makeCar(0.5);
    car.placeAt(0, 0, 0, 300 / MS_TO_KPH);
    const ctl = controls({ brake: 1, ersMode: 'harvest' });
    const startZ = car.position.y;
    let t = 0;
    let peakG = 0;
    let locked = 0;
    while (car.speedKph > 50 && t < 20) {
      // There is no ABS in F1; the driver eases off as downforce bleeds away.
      ctl.brake = modulate ? Math.min(1, car.brakeLimitFraction * 0.98) : 1;
      car.step(PHYSICS_DT, ctl, ENV);
      t += PHYSICS_DT;
      if (-car.longitudinalG > peakG) peakG = -car.longitudinalG;
      if (car.wheelsLocked) locked += PHYSICS_DT;
      if (t > 0.05 && -car.longitudinalG < 0.05) break; // stopped decelerating
    }
    return { t, dist: car.position.y - startZ, peakG, locked, surface: car.frontTires.surface };
  }

  const good = stop(true);
  const clumsy = stop(false);

  // Published figures for 300-0 cluster around 4s / 130m. This model is at the
  // optimistic end of that: it applies peak brake force instantly, where a real
  // stop includes a pedal ramp and a driver who is not at the limit immediately.
  check('300-50, modulated, time', good.t, 1.8, 4.6, 's');
  check('300-50, modulated, dist', good.dist, 75, 175, 'm');
  // The ceiling here is NOT the same quantity as the lateral ceiling below,
  // and it used to be set as though it were.
  //
  // `longitudinalG` is specific force — what an accelerometer in the car reads —
  // so under braking it is tire force PLUS aerodynamic drag, and at 300 km/h
  // this car's drag alone is worth about 1.05g. The skidpad checks measure tire
  // force on its own. A shared 6.8g bound therefore asked the braking case to
  // fit a whole g of drag inside a tire-only budget, which no grip-limited stop
  // from 300 km/h can do. It only ever passed because the calipers ran out of
  // authority first and hid the tire limit. With brakes that can reach the tire
  // limit the bound has to be the tire ceiling plus the drag that rides on top.
  check('peak braking', good.peakG, 4.0, 7.5, 'g');
  check('lock-up time, modulated', good.locked, 0, 0.35, 's');
  check('lock-up penalty, distance', clumsy.dist - good.dist, 1, 400, 'm');
  check('flat-spot from locking', 1 - clumsy.surface, 0.02, 0.35, '');
}

// ===========================================================================
console.log('\nSTEADY-STATE CORNERING (skidpad, max lateral g)');
// ===========================================================================
{
  // At each target speed, sweep steering to find the maximum sustained lateral
  // acceleration. Load-sensitive grip means this should rise steeply with speed.
  for (const targetKph of [100, 180, 250, 300]) {
    let best = 0;
    for (let steer = 0.05; steer <= 1.0; steer += 0.05) {
      const car = makeCar(0.7, 10);
      car.placeAt(0, 0, 0, targetKph / MS_TO_KPH);
      const ctl = controls({ steer, throttle: 0.35 });

      let sum = 0;
      let n = 0;
      for (let i = 0; i < 120 * 3; i++) {
        // Hold speed roughly constant so we measure cornering, not deceleration.
        ctl.throttle = car.speedKph < targetKph ? 0.6 : 0.15;
        car.step(PHYSICS_DT, ctl, ENV);
        if (i > 120) { sum += Math.abs(car.lateralG); n++; }
      }
      const avg = n > 0 ? sum / n : 0;
      // Reject runs where the car spun or fell far off the target speed.
      if (Math.abs(car.speedKph - targetKph) < targetKph * 0.35 && avg > best) best = avg;
    }
    const [lo, hi] =
      targetKph <= 100 ? [1.4, 2.8] :
      targetKph <= 180 ? [2.4, 4.4] :
      targetKph <= 250 ? [3.2, 5.8] : [3.6, 6.8];
    check('max lateral @ ' + targetKph + ' km/h', best, lo, hi, 'g');
  }
}

// ===========================================================================
console.log('\nFUEL AND MASS');
// ===========================================================================
{
  const car = makeCar(0.5, 100);
  const startMass = car.totalMassKg;
  check('mass with 100L', startMass, 860, 890, 'kg');

  const ctl = controls({ throttle: 0.85, ersMode: 'balanced' });
  car.placeAt(0, 0, 0, 70);
  // Roughly one lap's worth of running at high throttle.
  for (let i = 0; i < 120 * 90; i++) car.step(PHYSICS_DT, ctl, ENV);
  const burned = 100 - car.fuelL;
  check('fuel burn over 90s', burned, 1.8, 4.6, 'L');
  check('mass loss over 90s', startMass - car.totalMassKg, 1.3, 3.5, 'kg');
}

// ===========================================================================
console.log('\nTIRE DEGRADATION');
// ===========================================================================
{
  const car = makeCar(0.6, 100);
  car.placeAt(0, 0, 0, 60);
  // Sustained cornering load, which is what actually wears a tire.
  const ctl = controls({ throttle: 0.55, steer: 0.35 });
  let steps = 0;
  const maxSteps = 120 * 60 * 30;
  while (car.rearTires.wear > 0.4 && steps < maxSteps) {
    ctl.throttle = car.speedKph < 170 ? 0.75 : 0.3;
    car.step(PHYSICS_DT, ctl, ENV);
    steps++;
  }
  const minutesToCliff = (steps * PHYSICS_DT) / 60;
  check('minutes of load to cliff', minutesToCliff, 6, 45, 'min');
  check('rear temp under load', car.rearTires.tempC, 85, 165, 'C');

  // Grip must fall off a cliff below 40% wear, not decline linearly.
  const t = car.rearTires;
  t.wear = 0.45; const gAbove = t.wearFactor();
  t.wear = 0.25; const gBelow = t.wearFactor();
  t.wear = 0.1;  const gGone = t.wearFactor();
  check('grip at 45% life', gAbove * 100, 88, 100, '%');
  check('grip at 25% life', gBelow * 100, 60, 88, '%');
  check('grip at 10% life', gGone * 100, 25, 62, '%');
}

// ===========================================================================
console.log('\nALLOCATION CHECK (step() must not allocate)');
// ===========================================================================
{
  const car = makeCar(0.5, 100);
  car.placeAt(0, 0, 0, 60);
  const ctl = controls({ throttle: 0.8, steer: 0.2 });

  // Warm the JIT hard before measuring. Early iterations allocate for inline
  // caches and shape transitions, which swamps the real per-step figure and
  // makes an allocation-free loop look like it leaks 100 bytes a call.
  for (let i = 0; i < 400_000; i++) car.step(PHYSICS_DT, ctl, ENV);

  const STEPS = 400_000;
  let bytesPerStep = Infinity;
  for (let batch = 0; batch < 3; batch++) {
    (global as unknown as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < STEPS; i++) car.step(PHYSICS_DT, ctl, ENV);
    const after = process.memoryUsage().heapUsed;
    bytesPerStep = Math.min(bytesPerStep, (after - before) / STEPS);
  }
  console.log('  info  ' + bytesPerStep.toFixed(3) + ' bytes/step steady-state over ' +
              STEPS.toLocaleString() + ' steps');
  if (bytesPerStep > 8) failures.push(`step() allocates ~${bytesPerStep.toFixed(1)} bytes/call`);

  const t0 = performance.now();
  for (let i = 0; i < 120 * 60; i++) car.step(PHYSICS_DT, ctl, ENV);
  const ms = performance.now() - t0;
  const perCarPerSecond = ms / 60;
  console.log('  info  ' + ms.toFixed(1) + 'ms per simulated minute (' +
              perCarPerSecond.toFixed(3) + 'ms per car-second)');
  // Twenty cars at realtime must fit in well under a frame's budget.
  const twentyCarsRealtimeMsPerFrame = perCarPerSecond * 20 / 60 * 1000 / 1000;
  console.log('  info  20 cars realtime ≈ ' + (twentyCarsRealtimeMsPerFrame * 16.7).toFixed(2) +
              'ms per 60fps frame');
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('All physics checks within expected ranges.\n');
}
