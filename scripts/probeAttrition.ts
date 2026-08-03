/**
 * Does the field survive a race?
 *
 * A grand prix in which seventeen of twenty cars are out on lap one is not a
 * grand prix, and every other probe in this repo was blind to it: the handling
 * probe measures a steady-state skidpad with no longitudinal force, the race
 * validator asserts lap TIMES, and neither has anything to say about a field
 * that eats itself. This one asks the only question that matters first — how
 * many cars are still running at the flag — and then, when the answer is bad,
 * says where and why they went.
 *
 * Two sections:
 *
 *   1. ATTRITION. Twenty AI cars, five laps, on the circuits that were worst.
 *      Survivors, cars lost on lap one, why they retired and where. The
 *      retirement positions are clustered, because "thirteen of seventeen
 *      within a hundred metres of the same corner" is a different bug report
 *      from "spread evenly around the lap" and the number alone cannot tell
 *      them apart.
 *
 *   2. COMBINED LOAD. Braking INTO a corner, which is the condition the field
 *      was dying in and the one no other probe covers. A car is put on a fixed
 *      radius at a fixed speed and the brake pedal is swept; what is reported is
 *      how far the rear slip angle runs and whether the car ends up facing
 *      backwards. A tire model behaving itself gives a curve. A cliff between
 *      one pedal position and the next is snap oversteer, and it does not matter
 *      how good the steady-state balance looks if the car has one.
 *
 * Run: npm run probe:attrition
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { MS_TO_KPH } from '../src/core/MathUtils';
import { VehiclePhysics, type VehicleControls, type EnvironmentState } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';

const LAPS = 5;
const CIRCUITS_UNDER_TEST = ['silverstone', 'spa', 'monza', 'bahrain', 'suzuka'] as const;
const SEEDS = [20260729, 20268648, 20276567];

/**
 * How many of twenty cars must still be running after five laps.
 *
 * Five laps is not a race distance and real attrition over it is close to zero;
 * a couple of cars lost to contact or a mechanical is generous rather than
 * strict. The bar is set at three quarters of the field because below that the
 * result of the race is decided by which cars survived rather than by which
 * were quick, and that is the point at which a race stops being one.
 */
const MIN_SURVIVORS = 15;

const failures: string[] = [];

// ===========================================================================
console.log('\nATTRITION — 20 AI cars, ' + LAPS + ' laps, no player');
// ===========================================================================
console.log(
  '  ' + 'CIRCUIT'.padEnd(14) + 'SURVIVORS'.padStart(10) + 'LAP-1 LOSSES'.padStart(14) +
  'ACCIDENT'.padStart(10) + 'MECH'.padStart(6) + 'BEACHED'.padStart(9),
);
console.log('  ' + '-'.repeat(63));

type Retirement = { reason: string; s: number; lap: number; lateral: number; speedKph: number };

for (const id of CIRCUITS_UNDER_TEST) {
  const def = getCircuit(id);
  let survivorsTotal = 0;
  let lap1Total = 0;
  const reasons = new Map<string, number>();
  let worstRun: { seed: number; survivors: number; retirements: Retirement[] } | null = null;

  for (const seed of SEEDS) {
    const config: SessionConfig = {
      kind: 'race', name: 'attrition', durationS: 0, laps: LAPS,
      playerIndex: -1, standingStart: true, pitLaneStart: false, seed,
    };
    const engine = new RaceEngine(def, config);
    const maxSteps = Math.round((LAPS * def.referencePoleTimeS * 3.2) / PHYSICS_DT);

    // Catch each retirement as it happens: afterwards the car has been moved,
    // recovered and its speed zeroed, so where it actually stopped is gone.
    const seen = new Set<number>();
    const retirements: Retirement[] = [];
    let steps = 0;
    while (!engine.over && steps < maxSteps) {
      engine.step();
      steps++;
      for (const car of engine.cars) {
        if (!car.retired || seen.has(car.index)) continue;
        seen.add(car.index);
        retirements.push({
          reason: car.retirementReason,
          s: car.s,
          lap: car.lap,
          lateral: car.lateral,
          speedKph: car.physics.speedKph,
        });
      }
    }

    const survivors = engine.cars.filter((c) => !c.retired).length;
    survivorsTotal += survivors;
    lap1Total += retirements.filter((r) => r.lap < 1).length;
    for (const r of retirements) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    if (!worstRun || survivors < worstRun.survivors) worstRun = { seed, survivors, retirements };
  }

  const meanSurvivors = survivorsTotal / SEEDS.length;

  // Classified by PREFIX, against the strings `RaceEngine` actually retires
  // cars with. Exact-matching them was wrong in both directions and had been
  // reporting a fiction:
  //
  //   'Accident'               matched, and was the only thing counted as one
  //   'Accident damage'        counted as MECHANICAL
  //   'Beached in the gravel'  counted as MECHANICAL — and because the test
  //                            looked for the bare word 'Beached', which no car
  //                            has ever retired with, the BEACHED column could
  //                            not print anything but 0.0 on any circuit
  //
  // So two thirds of the accident column was filed under mechanical failures,
  // which is the difference between "the cars keep breaking" and "the cars keep
  // crashing" — opposite diagnoses with opposite fixes. Measured at Spa: what
  // this reported as 2.0 mechanicals a race is beaching and accident damage,
  // and the genuine mechanical count there is zero.
  let accident = 0;
  let beached = 0;
  let mech = 0;
  for (const [reason, n] of reasons) {
    if (reason.startsWith('Beached')) beached += n;
    else if (reason.startsWith('Accident')) accident += n;
    else mech += n;
  }

  console.log(
    '  ' + def.name.padEnd(14) +
    (meanSurvivors.toFixed(1) + '/20').padStart(10) +
    (lap1Total / SEEDS.length).toFixed(1).padStart(14) +
    (accident / SEEDS.length).toFixed(1).padStart(10) +
    (mech / SEEDS.length).toFixed(1).padStart(6) +
    (beached / SEEDS.length).toFixed(1).padStart(9),
  );

  if (meanSurvivors < MIN_SURVIVORS) {
    failures.push(
      `${id}: ${meanSurvivors.toFixed(1)} of 20 cars still running after ${LAPS} laps ` +
      `(want at least ${MIN_SURVIVORS})`,
    );
    // Where did they go? Cluster the worst run's retirements by lap distance.
    const rs = [...worstRun!.retirements].sort((a, b) => a.s - b.s);
    const clusters: Retirement[][] = [];
    for (const r of rs) {
      const last = clusters[clusters.length - 1];
      if (last && r.s - last[last.length - 1].s < 100) last.push(r);
      else clusters.push([r]);
    }
    clusters.sort((a, b) => b.length - a.length);
    for (const c of clusters.slice(0, 3)) {
      if (c.length < 2) continue;
      const mid = c[Math.floor(c.length / 2)];
      const half = getCircuit(id) && 0; // placeholder to keep the line short
      void half;
      console.log(
        `      ${c.length} of ${rs.length} retirements within 100m of s=${mid.s.toFixed(0)}m` +
        (mid.lateral !== undefined ? ` (lateral ${mid.lateral.toFixed(1)}m)` : ''),
      );
    }
  }
}

// ===========================================================================
console.log('\nCOMBINED LOAD — braking INTO a corner');
// ===========================================================================
// The steady-state skidpad in `probe:handling` reports this car as front-limited
// and stable at every speed, and it is — with no longitudinal force on it. This
// is the same car with the brake pedal down.
{
  const ENV: EnvironmentState = {
    trackTempC: 38, airTempC: 25, wetness: 0, surfaceGrip: 1, airDensityRatio: 1, abrasion: 1,
  };
  const controls = (over: Partial<VehicleControls> = {}): VehicleControls => ({
    throttle: 0, brake: 0, steer: 0, drsRequested: false,
    ersMode: 'balanced', gearRequest: 0, pitLimiter: false, speedLimitMs: 0, reverse: false,
    ...over,
  });

  function turnIn(speedKph: number, radiusM: number, brake: number) {
    const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(0.6, 40));
    const car = new VehiclePhysics(spec, 'medium');
    car.fuelL = 40;
    car.frontTires.tempC = 100;
    car.rearTires.tempC = 103;
    car.frontTires.lapsOnSet = 3;
    car.rearTires.lapsOnSet = 3;
    car.placeAt(0, 0, 0, speedKph / MS_TO_KPH);

    // The steering the radius geometrically needs, held throughout.
    const steer = Math.min(1, Math.atan(spec.wheelbaseM / radiusM) / spec.maxSteerRad);
    const ctl = controls({ brake, steer });

    let peakRearSlip = 0;
    let peakSideslip = 0;
    let spun = false;
    for (let i = 0; i < 120 * 4; i++) {
      car.step(PHYSICS_DT, ctl, ENV);
      const rearSlip = (car.rearTires.slipAngle * 180) / Math.PI;
      const sideslip = Math.abs((Math.atan2(car.localVelY, Math.abs(car.localVelX)) * 180) / Math.PI);
      if (rearSlip > peakRearSlip) peakRearSlip = rearSlip;
      if (sideslip > peakSideslip) peakSideslip = sideslip;
      if (sideslip > 45) { spun = true; break; }
      if (car.speedKph < 30) break;
    }
    return { peakRearSlip, peakSideslip, spun };
  }

  const CASES = [
    { label: '150 km/h, 100m radius', kph: 150, radius: 100 },
    { label: '220 km/h, 200m radius', kph: 220, radius: 200 },
    { label: '280 km/h, 400m radius', kph: 280, radius: 400 },
  ];
  const PEDALS = [0.2, 0.3, 0.4, 0.5, 0.7, 1.0];

  for (const c of CASES) {
    console.log('  ' + c.label);
    console.log(
      '    ' + 'BRAKE'.padStart(6) + 'REAR SLIP'.padStart(11) + 'SIDESLIP'.padStart(10) + '  RESULT',
    );
    let prevSlip = 0;
    let worstJump = 0;
    let jumpAt = 0;
    for (const b of PEDALS) {
      const r = turnIn(c.kph, c.radius, b);
      console.log(
        '    ' + b.toFixed(2).padStart(6) +
        (r.peakRearSlip.toFixed(1) + '°').padStart(11) +
        (r.peakSideslip.toFixed(1) + '°').padStart(10) +
        '  ' + (r.spun ? 'SPUN' : 'held'),
      );
      if (r.spun) {
        failures.push(`${c.label}: spun at ${b.toFixed(2)} brake — snap oversteer under combined load`);
      }
      const jump = r.peakRearSlip - prevSlip;
      if (jump > worstJump) { worstJump = jump; jumpAt = b; }
      prevSlip = r.peakRearSlip;
    }
    // A tire model gives a curve. A step means one more notch of pedal takes the
    // car from gripping to gone, which is not something a driver can drive.
    if (worstJump > 20) {
      failures.push(
        `${c.label}: rear slip jumps ${worstJump.toFixed(0)}° between one pedal step and the next ` +
        `(at ${jumpAt.toFixed(2)}) — that is a cliff, not a limit`,
      );
    }
  }
}

// ===========================================================================
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — the field survives and the car has no snap oversteer.');
}
