/**
 * What the weather does to the track, to the car, and to the strategy.
 *
 * WHY THIS PROBE EXISTS. Weather in this game used to be one number that
 * scaled grip and nothing else. A screenshot of a race whose HUD read HEAVY
 * RAIN showed dry asphalt, no spray, and cars on the same racing line they take
 * in the dry — because there was nothing in the simulation for a renderer to
 * draw or for a driver to react to. The model that replaced it makes a series
 * of claims that are easy to state and easy to get wrong, and every one of them
 * is asserted below:
 *
 *   1. The operating point the strategist compares tyres at puts every dry
 *      compound in its authored temperature window, and takes every one of
 *      them out of it when the track floods. Section 1 also REPORTS, without
 *      asserting, a 40C discrepancy between that window and the temperature
 *      the AI field actually races at, which this work did not create and did
 *      not fix — see the note in that section.
 *   2. Lap time really does go as grip to a power, and it is THIS power. The
 *      whole crossover arithmetic is built on `LAP_TIME_GRIP_EXPONENT`, so it
 *      is fitted against lap times the simulation produces.
 *   3. Slicks are faster than intermediates below the crossover and slower
 *      above it — measured on the road, not read off the model that predicts
 *      it. A model and a race that agree by construction prove nothing; these
 *      are two independent measurements of the same quantity.
 *   4. The track dries, it dries on the racing line first, and the dry line is
 *      a real, growing difference in water depth rather than a label.
 *   5. Grip off the racing line EXCEEDS grip on it when the track is soaked,
 *      and the relationship reverses as it dries. This is the claim the whole
 *      wet racing line rests on.
 *   6. The cars actually move. Twenty-two AI drivers put the car somewhere
 *      different on a soaked circuit than they do on a dry one.
 *   7. Water collects where the circuit's elevation says it should, on real
 *      circuits, without anybody authoring a puddle.
 *   8. The pit wall's forecast is USEFUL AND WRONG. Better than a coin, worse
 *      than the truth, with a confidence that means something.
 *   9. The wall asks a question the player can answer, and the answer reaches
 *      the car.
 *  10. The AI's compound choices track the conditions.
 *
 * Run: npm run probe:weather
 */

import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { TrackSpline } from '../src/track/TrackSpline';
import {
  TireState, RACE_PACE_SLIP_POWER, steadyGrip, aquaplaneFraction, equilibriumTempC,
  thermalFactorOf, wetFactorOf,
} from '../src/physics/TireModel';
import { getCompound, type CompoundId } from '../src/data/tires';
import {
  LAP_TIME_GRIP_EXPONENT, crossoverWetness, fastestCompound, relativePace,
  slickToInterWetness, interToWetWetness, crossoverCase, conditionsCompound,
} from '../src/race/Strategy';
import { PitWall, TrackSurface, Weather, type PitWallContext } from '../src/race/Weather';
import { VehiclePhysics, type EnvironmentState } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

const REF_TEMP = 38;

// ===========================================================================
// 1. The operating point
// ===========================================================================
//
// `RACE_PACE_SLIP_POWER` is the slip power the strategist evaluates every
// compound at, and its whole job is to put the tyre at the TEMPERATURE a race
// runs it at — because the second half of why a slick is bad in the rain is
// that it never reaches its window, and a comparison made at the wrong
// temperature would miss it entirely.
//
// So the assertion is on temperature, not on slip power. An earlier version of
// this section compared the constant against the field's mean instantaneous
// slip power and found 1.83 against 7.70, which looks damning and is not: the
// mean is taken over the whole lap including the straights, where a rolling
// tyre has almost no slip and is being cooled rather than heated, while the
// equilibrium the tyre actually sits at is set by the peaks. Comparing the two
// directly was measuring the wrong thing. What the constant has to reproduce is
// the temperature, and that is a number this simulation can be asked for.

console.log('=== 1. the operating point the strategist compares tyres at ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'silverstone')!;
  const config: SessionConfig = {
    kind: 'race', name: 'GP', durationS: 0, laps: 12,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 21,
  };
  const engine = new RaceEngine(def, config);
  // Held dry, so this measures racing work and not aquaplaning.
  engine.weather.forceRain(0);

  let tempSum = 0, spSum = 0, n = 0, peakSp = 0;
  const steps = Math.round(420 / PHYSICS_DT);
  for (let i = 0; i < steps && !engine.over; i++) {
    engine.step();
    engine.weather.forceRain(0);
    // Sampled after the field has settled into a rhythm and only from cars
    // actually racing — an out-lap and a pit stop are not race pace.
    if (i > steps * 0.3 && i % 40 === 0) {
      for (const car of engine.cars) {
        if (car.retired || car.inPitLane || car.physics.speedMs < 25) continue;
        if (car.compound !== 'medium') continue;
        tempSum += (car.physics.frontTires.tempC + car.physics.rearTires.tempC) * 0.5;
        const sp = (car.physics.frontTires.slipPower + car.physics.rearTires.slipPower) * 0.5;
        spSum += sp; n++;
        if (sp > peakSp) peakSp = sp;
      }
    }
  }
  const meanTemp = n > 0 ? tempSum / n : 0;
  const trackTemp = engine.weather.trackTempC;
  const predicted = equilibriumTempC(getCompound('medium'), trackTemp, 0, RACE_PACE_SLIP_POWER);
  console.log(`  track temperature                            : ${trackTemp.toFixed(1)}C`);
  console.log(`  measured mean tyre temp, mediums, ${String(n).padStart(5)} samples: ${meanTemp.toFixed(1)}C`);
  console.log(`  closed form at RACE_PACE_SLIP_POWER=${RACE_PACE_SLIP_POWER.toFixed(1)}      : ${predicted.toFixed(1)}C`);
  console.log(`  medium's authored window                     : ` +
    `${getCompound('medium').optimalTempMinC}-${getCompound('medium').optimalTempMaxC}C`);
  console.log(`  (instantaneous slip power: mean ${(spSum / Math.max(n, 1)).toFixed(2)}, peak ${peakSp.toFixed(2)})`);
  check(n > 100, `only ${n} samples of a medium at race pace — the measurement is not meaningful`);

  // ---------------------------------------------------------------------
  // REPORTED, NOT ASSERTED — and this is the honest part of this probe.
  //
  // The measurement above and the constant below do not agree, and the
  // disagreement is NOT something this weather work introduced or can fix.
  //
  // The compound windows in `data/tires.ts` are authored between 90 and 115C.
  // The AI field, driving a race, runs its tyres at around half that: the
  // controller is smooth, the slip it generates is small, and the heat balance
  // in `TireModel.update` settles far below the window on every compound. So
  // there are two different "operating points" available and they are 40C
  // apart:
  //
  //   THE AUTHORED ONE, in the middle of the windows, which is what the
  //   compound data plainly intends — the whole point of a soft having a
  //   higher window than a hard is that both are reachable.
  //
  //   THE OBSERVED ONE, where the field actually runs, at which every dry
  //   compound is cold and — because the intermediate's window is 60-85C — an
  //   INTERMEDIATE HAS MORE THERMAL GRIP THAN A MEDIUM ON A DRY TRACK.
  //
  // The strategist uses the authored one, because a crossover model built on
  // the observed one would recommend intermediates in the dry, which is
  // obviously wrong and would be wrong for a reason that has nothing to do with
  // weather. That choice is defensible and it is not a fix: the underlying
  // discrepancy is a pre-existing property of the thermal model and the AI's
  // pace, and closing it means retuning `heatingRate`/`coolingRate` against
  // every handling probe in the project.
  //
  // So it is printed, every run, in the plainest terms available, rather than
  // asserted away or silently accommodated.
  const gap = Math.abs(predicted - meanTemp);
  if (gap > 12) {
    console.log(`\n  NOTE — OPEN DISCREPANCY, not a failure of this model:`);
    console.log(`    the field races its mediums at ${meanTemp.toFixed(0)}C but the compound's`);
    console.log(`    authored window is ${getCompound('medium').optimalTempMinC}-${getCompound('medium').optimalTempMaxC}C, a gap of ${gap.toFixed(0)}C. The strategist`);
    console.log(`    evaluates at the authored window (RACE_PACE_SLIP_POWER), because at the`);
    console.log(`    observed temperature an INTERMEDIATE outgrips a MEDIUM on a dry track:`);
    const eqObs = meanTemp;
    console.log(`      medium at ${eqObs.toFixed(0)}C : ${(getCompound('medium').peakGrip * thermalFactorOf(getCompound('medium'), eqObs)).toFixed(3)}`);
    console.log(`      inter  at ${eqObs.toFixed(0)}C : ${(getCompound('intermediate').peakGrip * thermalFactorOf(getCompound('intermediate'), eqObs) * wetFactorOf(getCompound('intermediate'), 0)).toFixed(3)}`);
    console.log(`    Closing it means retuning the tyre thermal model against every`);
    console.log(`    handling probe in the project. Out of scope here; recorded so it is`);
    console.log(`    not discovered again from scratch.`);
  }

  // And that temperature has to be somewhere useful for all three dry
  // compounds, or every comparison is being made on a tyre that is not working.
  console.log('');
  for (const id of ['soft', 'medium', 'hard'] as CompoundId[]) {
    const c = getCompound(id);
    const eq = equilibriumTempC(c, trackTemp, 0, RACE_PACE_SLIP_POWER);
    const eqWet = equilibriumTempC(c, trackTemp, 1, RACE_PACE_SLIP_POWER);
    console.log(`  ${id.padEnd(7)} dry ${eq.toFixed(1)}C / soaked ${eqWet.toFixed(1)}C  ` +
      `(window ${c.optimalTempMinC}-${c.optimalTempMaxC}, dry grip ` +
      `${steadyGrip(c, trackTemp, 0).toFixed(3)}, soaked ${steadyGrip(c, trackTemp, 1).toFixed(3)})`);
    check(eq > c.optimalTempMinC - 15 && eq < c.optimalTempMaxC + 15,
      `${id} is evaluated at ${eq.toFixed(0)}C, far outside its ${c.optimalTempMinC}-${c.optimalTempMaxC} window`);
    check(eqWet < c.optimalTempMinC,
      `${id} still reaches its operating window on a soaked track — a slick in the rain ` +
      'has to be cold as well as slippery');
  }
  // The closed form and the actual integrator must agree, or the strategist is
  // reasoning with a different tyre from the one the race runs.
  const t = new TireState('medium', 90);
  const sp = RACE_PACE_SLIP_POWER;
  for (let i = 0; i < 6000; i++) t.update(1 / 120, sp / 2.2, 5000 * 2.2, 5000, trackTemp, 0, 1, 60);
  console.log(`\n  integrator at the same slip power settles at ${t.tempC.toFixed(1)}C ` +
    `against the closed form's ${predicted.toFixed(1)}C`);
  check(Math.abs(t.tempC - predicted) < 3,
    `the closed form (${predicted.toFixed(1)}C) and the integrator it was solved from ` +
    `(${t.tempC.toFixed(1)}C) disagree — equilibriumTempC does not match update()`);
}

// ===========================================================================
// 2. Lap time against grip
// ===========================================================================
//
// The crossover arithmetic converts a grip ratio into a lap-time delta with a
// single exponent. Here it is fitted, by running the same car round the same
// circuit at a spread of grip multipliers.

console.log('\n=== 2. lap time vs grip: fitting LAP_TIME_GRIP_EXPONENT ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'silverstone')!;
  const track = new TrackSpline(def);
  // The speed solver is the honest instrument here: it produces the lap time a
  // car with a given grip level can achieve on this circuit, and it is the same
  // solver the racing line and the AI's target speeds come from.
  const base = track.solverParams;
  const points: Array<{ g: number; lap: number }> = [];
  for (const g of [0.55, 0.7, 0.85, 1.0, 1.1]) {
    const lap = track.resolveSpeedProfile({ ...base, mu: base.mu * g });
    points.push({ g, lap });
  }
  // Restore, so nothing downstream inherits a doctored profile.
  track.resolveSpeedProfile(base);

  const ref = points.find((p) => p.g === 1)!;
  console.log('  grip    lap time    ratio    implied exponent');
  let sumExp = 0, nExp = 0;
  for (const p of points) {
    if (p.g === 1) {
      console.log(`  ${p.g.toFixed(2)}    ${p.lap.toFixed(2)}s     1.000    (reference)`);
      continue;
    }
    const ratio = p.lap / ref.lap;
    // lap ~ grip^-k  =>  k = -ln(ratio)/ln(g)
    const k = -Math.log(ratio) / Math.log(p.g);
    sumExp += k; nExp++;
    console.log(`  ${p.g.toFixed(2)}    ${p.lap.toFixed(2)}s     ${ratio.toFixed(3)}    ${k.toFixed(3)}`);
  }
  const fitted = sumExp / nExp;
  console.log(`\n  fitted exponent      : ${fitted.toFixed(3)}`);
  console.log(`  LAP_TIME_GRIP_EXPONENT: ${LAP_TIME_GRIP_EXPONENT.toFixed(3)}`);
  check(Math.abs(fitted - LAP_TIME_GRIP_EXPONENT) <= 0.04,
    `LAP_TIME_GRIP_EXPONENT is ${LAP_TIME_GRIP_EXPONENT} but the speed solver fits ` +
    `${fitted.toFixed(3)} — the crossover arithmetic is built on the wrong exponent`);
}

// ===========================================================================
// 3. The crossover, predicted and measured
// ===========================================================================

console.log('\n=== 3. the wet crossover ===\n');

{
  const slickInter = slickToInterWetness(REF_TEMP);
  const interWet = interToWetWetness(REF_TEMP);
  console.log(`  model says slick -> inter at wetness ${slickInter.toFixed(3)}`);
  console.log(`  model says inter -> wet   at wetness ${interWet.toFixed(3)}\n`);

  check(slickInter > 0.05 && slickInter < 0.6,
    `the slick/inter crossover is at ${slickInter.toFixed(3)}, which is not a usable place for it`);
  check(interWet > slickInter,
    `the inter/wet crossover (${interWet.toFixed(3)}) is not above the slick/inter one`);

  console.log('  relative pace by compound and water depth (lower is faster):');
  console.log('  wet    soft   med    hard   inter  wet    fastest');
  for (let w = 0; w <= 1.0001; w += 0.1) {
    const row = (['soft', 'medium', 'hard', 'intermediate', 'wet'] as CompoundId[])
      .map((c) => relativePace(c, w, REF_TEMP).toFixed(3)).join('  ');
    console.log(`  ${w.toFixed(1)}    ${row}  ${fastestCompound(w, REF_TEMP)}`);
  }

  // The two claims the whole thing rests on, asserted rather than eyeballed.
  const below = slickInter - 0.08;
  const above = slickInter + 0.08;
  check(relativePace('medium', below, REF_TEMP) < relativePace('intermediate', below, REF_TEMP),
    `at wetness ${below.toFixed(2)}, below the crossover, the intermediate is already faster than the slick`);
  check(relativePace('medium', above, REF_TEMP) > relativePace('intermediate', above, REF_TEMP),
    `at wetness ${above.toFixed(2)}, above the crossover, the slick is still faster than the intermediate`);
  // A pair with no crossover has to say so rather than inventing one.
  check(crossoverWetness('soft', 'medium', REF_TEMP) === null,
    'soft and medium are reported as crossing over, which they do not');
}

// ===========================================================================
// 3b. ...and the same crossover measured on the road
// ===========================================================================
//
// Section 3 asks the model. This asks the CAR. A model that predicts a
// crossover and a simulation that produces a different one is the exact failure
// the shared-arithmetic rule in `Strategy.ts` exists to prevent, and the only
// way to catch it is to measure both.

console.log('\n=== 3b. the crossover, driven ===\n');

{
  /**
   * Maximum sustained lateral g on a compound at a given water depth.
   *
   * The same instrument `validatePhysics` uses for its cornering check, and
   * deliberately so: it sweeps steering angle at a fixed speed and reports the
   * best settled lateral acceleration, which is the quantity a corner is
   * actually limited by. A model that predicts a crossover and a car that
   * produces a different one is the exact failure the shared-arithmetic rule in
   * `Strategy.ts` exists to prevent, and the only way to catch it is to measure
   * both. Nothing below reads `relativePace`.
   */
  const maxLateralG = (compound: CompoundId, wetness: number): number => {
    const env: EnvironmentState = {
      trackTempC: REF_TEMP, airTempC: 25, wetness, surfaceGrip: 1,
      airDensityRatio: 1, abrasion: 1,
    };
    const targetKph = 180;
    let best = 0;
    for (let steer = 0.05; steer <= 1.0; steer += 0.05) {
      const spec = applySetup(BASE_F1_SPEC, baselineSetupFor(0.7, 10));
      const car = new VehiclePhysics(spec, compound);
      car.fuelL = 10;
      // Warmed to the equilibrium this compound reaches in these conditions,
      // not to a fixed number: a slick in the rain never gets to temperature
      // and that second grip loss is half of why it is a bad tyre. Starting it
      // hot would measure a tyre that does not exist.
      const eq = equilibriumTempC(getCompound(compound), REF_TEMP, wetness, RACE_PACE_SLIP_POWER);
      car.frontTires.tempC = eq;
      car.rearTires.tempC = eq;
      car.frontTires.lapsOnSet = 2;
      car.rearTires.lapsOnSet = 2;
      car.placeAt(0, 0, 0, targetKph / 3.6);
      const ctl = {
        throttle: 0.35, brake: 0, steer,
        drsRequested: false, ersMode: 'balanced' as const, gearRequest: 0,
        pitLimiter: false, speedLimitMs: 0, reverse: false,
      };
      let sum = 0, n = 0;
      for (let i = 0; i < 360; i++) {
        ctl.throttle = car.speedKph < targetKph ? 0.6 : 0.15;
        car.step(PHYSICS_DT, ctl, env);
        if (i > 120) { sum += Math.abs(car.lateralG); n++; }
      }
      const avg = n > 0 ? sum / n : 0;
      if (Math.abs(car.speedKph - targetKph) < targetKph * 0.35 && avg > best) best = avg;
    }
    return best;
  };

  console.log('  max sustained lateral g at 180 km/h:');
  console.log('  wetness   medium    inter     faster');
  const measured: Array<{ w: number; med: number; inter: number }> = [];
  for (const w of [0.0, 0.15, 0.3, 0.45, 0.6, 0.8]) {
    const med = maxLateralG('medium', w);
    const inter = maxLateralG('intermediate', w);
    measured.push({ w, med, inter });
    console.log(`  ${w.toFixed(2)}      ${med.toFixed(3).padStart(6)}    ${inter.toFixed(3).padStart(6)}` +
      `    ${med > inter ? 'medium' : 'intermediate'}`);
  }

  const dry = measured[0];
  check(dry.med > dry.inter,
    `on a dry track the intermediate corners faster than the medium (${dry.inter.toFixed(1)} vs ${dry.med.toFixed(1)} m/s)`);
  const soaked = measured[measured.length - 1];
  check(soaked.inter > soaked.med,
    `on a soaked track the medium still corners faster than the intermediate ` +
    `(${soaked.med.toFixed(1)} vs ${soaked.inter.toFixed(1)} m/s) — slicks are not bad enough in the wet`);

  // Where the driven crossover actually falls, by linear interpolation on the
  // sign change, against where the model said it would.
  let driven = NaN;
  for (let i = 1; i < measured.length; i++) {
    const a = measured[i - 1], b = measured[i];
    const da = a.med - a.inter, db = b.med - b.inter;
    if (da > 0 && db <= 0) { driven = a.w + (b.w - a.w) * (da / (da - db)); break; }
  }
  const predicted = slickToInterWetness(REF_TEMP);
  console.log(`\n  driven crossover    : ${Number.isNaN(driven) ? 'not found' : driven.toFixed(3)}`);
  console.log(`  model crossover     : ${predicted.toFixed(3)}`);
  check(!Number.isNaN(driven),
    'the driven measurement never crossed over — slicks and inters never swap places on the road');
  check(Number.isNaN(driven) || Math.abs(driven - predicted) < 0.18,
    `the car crosses over at ${driven.toFixed(3)} but the strategist thinks ${predicted.toFixed(3)} — ` +
    `the recommendation and the race disagree`);

  // Aquaplaning: the thing that makes standing water categorically different
  // from a damp track.
  console.log('\n  aquaplaning fraction at 55 m/s (198 km/h):');
  for (const w of [0.4, 0.6, 0.8, 1.0]) {
    const row = (['medium', 'intermediate', 'wet'] as CompoundId[])
      .map((c) => aquaplaneFraction(getCompound(c), w, 55).toFixed(2)).join('   ');
    console.log(`    wetness ${w.toFixed(1)} : ${row}   (medium / inter / wet)`);
  }
  check(aquaplaneFraction(getCompound('medium'), 0.2, 80) === 0,
    'a slick aquaplanes on a merely damp track, which is not a thing that happens');
  check(aquaplaneFraction(getCompound('wet'), 1.0, 90) < 0.05,
    'a full wet aquaplanes at racing speed in standing water — the tyre exists precisely so it does not');
  check(aquaplaneFraction(getCompound('medium'), 0.9, 60) > 0.6,
    'a slick does not aquaplane in deep standing water at 216 km/h');
}

// ===========================================================================
// 4. The track dries, and it dries on the line first
// ===========================================================================

console.log('\n=== 4. drying, and the dry line ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'silverstone')!;
  const track = new TrackSpline(def);
  const surf = new TrackSurface(track);
  surf.soak(0.95);
  const soakedLine = surf.meanLineWater;
  console.log(`  soaked: line ${surf.meanLineWater.toFixed(3)}, off-line ${surf.meanOffWater.toFixed(3)}\n`);

  console.log('  minutes  rain  line   off    gap    peak');
  const trace: Array<{ t: number; line: number; off: number }> = [];
  for (let t = 0; t <= 900; t += 1) {
    // Rain stops at t=0 and 22 cars keep circulating.
    surf.update(1, 0, REF_TEMP, 22);
    if (t % 120 === 0) {
      trace.push({ t, line: surf.meanLineWater, off: surf.meanOffWater });
      console.log(`  ${(t / 60).toFixed(1).padStart(6)}   0.00  ` +
        `${surf.meanLineWater.toFixed(3)}  ${surf.meanOffWater.toFixed(3)}  ` +
        `${(surf.meanOffWater - surf.meanLineWater).toFixed(3)}  ${surf.peakWater.toFixed(3)}`);
    }
  }

  check(surf.meanLineWater < soakedLine * 0.35,
    `after fifteen minutes with a full field circulating the line is still at ` +
    `${surf.meanLineWater.toFixed(3)} of a starting ${soakedLine.toFixed(3)} — the track does not dry`);
  const gaps = trace.map((p) => p.off - p.line);
  const maxGap = Math.max(...gaps);
  console.log(`\n  largest line/off-line gap: ${maxGap.toFixed(3)}`);
  check(maxGap > 0.05,
    `the racing line never dries measurably faster than the road beside it (best gap ${maxGap.toFixed(3)}) — ` +
    'there is no dry line');

  // And with nobody running, it takes far longer. That asymmetry is what makes
  // a red flag in a drying race a strategic disaster.
  //
  // COMPARED AT FOUR MINUTES, not at fifteen. The first version of this check
  // ran both cases the full fifteen and compared the endpoints, by which time
  // both are at exactly zero and the comparison is between two dry tracks — it
  // failed while the model was working perfectly. A rate has to be measured
  // while something is still happening.
  const AT_S = 240;
  const empty = new TrackSurface(track);
  empty.soak(0.95);
  const busy = new TrackSurface(track);
  busy.soak(0.95);
  for (let t = 0; t < AT_S; t++) {
    empty.update(1, 0, REF_TEMP, 0);
    busy.update(1, 0, REF_TEMP, 22);
  }
  console.log(`  at ${AT_S / 60} minutes: line water is ${busy.meanLineWater.toFixed(3)} with a full ` +
    `field, ${empty.meanLineWater.toFixed(3)} on an empty circuit`);
  check(empty.meanLineWater > busy.meanLineWater + 0.15,
    `an empty circuit dries as fast as one with twenty-two cars on it ` +
    `(${empty.meanLineWater.toFixed(3)} vs ${busy.meanLineWater.toFixed(3)}) — traffic is not doing anything`);

  // Wetting is much faster than drying: the asymmetry that makes a stop for
  // inters a commitment.
  const wetting = new TrackSurface(track);
  let toSoak = 0;
  for (let t = 0; t < 600; t++) {
    wetting.update(1, 1, REF_TEMP, 22);
    if (wetting.meanLineWater > 0.6 && toSoak === 0) toSoak = t;
  }
  console.log(`  dry to 0.6 water under a downpour: ${toSoak}s`);
  check(toSoak > 0 && toSoak < 120,
    `a downpour takes ${toSoak}s to put real water on the road — rain has to arrive within a lap or two`);
}

// ===========================================================================
// 5. The fast line moves
// ===========================================================================

console.log('\n=== 5. grip on the line vs beside it ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'spa')!;
  const track = new TrackSpline(def);
  const surf = new TrackSurface(track);

  // A corner, where the rubber is heaviest and the effect is largest.
  let corner = 0;
  for (let i = 0; i < track.count; i++) {
    if (Math.abs(track.lineCurvature[i]) > Math.abs(track.lineCurvature[corner])) corner = i;
  }
  const onLat = track.lineOffset[corner];
  const offLat = track.wetLineOffset[corner];
  console.log(`  Spa node ${corner}: dry line at ${onLat.toFixed(2)}m, wet line at ${offLat.toFixed(2)}m ` +
    `(road half-width ${(track.width[corner] / 2).toFixed(2)}m)`);
  check(Math.abs(offLat - onLat) > 0.5,
    `the wet line is only ${Math.abs(offLat - onLat).toFixed(2)}m from the dry one — it is not a different line`);

  console.log('\n  water   grip on line   grip off line   better   avoidance');
  const rows: Array<{ w: number; on: number; off: number }> = [];
  for (const w of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    surf.soak(w);
    const on = surf.surfaceGripAt(corner, onLat);
    const off = surf.surfaceGripAt(corner, offLat);
    const av = surf.lineAvoidance(corner, offLat);
    rows.push({ w, on, off });
    console.log(`  ${w.toFixed(1)}     ${on.toFixed(4)}         ${off.toFixed(4)}          ` +
      `${off > on ? 'off ' : 'on  '}     ${av.toFixed(3)}`);
  }

  const dry = rows[0];
  check(Math.abs(dry.on - 1) < 1e-6 && Math.abs(dry.off - 1) < 1e-6,
    `on a bone-dry track the surface grip is ${dry.on.toFixed(4)} on the line and ${dry.off.toFixed(4)} off it — ` +
    'it must be exactly 1.0 everywhere, or this model has changed how dry races are raced');
  const soaked = rows[rows.length - 1];
  check(soaked.off > soaked.on + 0.05,
    `on a soaked track the rubbered line has grip ${soaked.on.toFixed(3)} against ${soaked.off.toFixed(3)} beside it — ` +
    'not enough of a difference for a driver to bother moving');

  // And on a DRYING track, where the line has less water on it, the grip comes
  // back to the line. Measured end to end — surface grip times the tyre's own
  // steady grip at the water it is actually in — and measured on BOTH tyres,
  // because they give opposite answers and both answers are right.
  surf.soak(0.9);
  for (let t = 0; t < 420; t++) surf.update(1, 0, REF_TEMP, 22);
  const onWater = surf.waterAt(corner, onLat);
  const offWater = surf.waterAt(corner, offLat);
  console.log(`\n  seven minutes into drying: line has ${onWater.toFixed(3)} water, ` +
    `off-line ${offWater.toFixed(3)}`);
  for (const id of ['medium', 'intermediate'] as CompoundId[]) {
    const c = getCompound(id);
    const on = surf.surfaceGripAt(corner, onLat) * steadyGrip(c, REF_TEMP, onWater);
    const off = surf.surfaceGripAt(corner, offLat) * steadyGrip(c, REF_TEMP, offWater);
    console.log(`    on ${id.padEnd(13)}: line ${on.toFixed(4)}, off-line ${off.toFixed(4)}` +
      `  -> ${on > off ? 'the line' : 'off the line'}`);
    if (id === 'medium') {
      // The claim that matters. Once a driver has committed to slicks the dry
      // line is the ONLY place the car works, and that is what makes the
      // crossover to slicks a commitment rather than a free option.
      check(on > off,
        'on a drying track a car on slicks is no faster on the dry line than beside it — ' +
        'the dry line is not paying off, and there is no reason to fight over it');
    } else {
      // ...and the opposite, which is not a defect. An intermediate wants water
      // in it: `wetGripCurve` peaks at damp and the tread overheats on dry
      // asphalt. Drivers genuinely do run through the wet parts to cool inters
      // on a drying circuit, and this model reproduces it without being told to.
      console.log('      (expected: an inter prefers the damp part — its wet curve peaks there,');
      console.log('       which is why drivers hunt for water on a drying track)');
    }
  }
}

// ===========================================================================
// 6. Twenty-two drivers actually move
// ===========================================================================

console.log('\n=== 6. does the field change its line when it rains? ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'silverstone')!;

  /** Mean |lateral - dryLine| over the field, once they are up to speed. */
  const runFor = (wet: number): { dev: number; laps: number } => {
    const config: SessionConfig = {
      kind: 'race', name: 'GP', durationS: 0, laps: 10,
      playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 33,
    };
    const engine = new RaceEngine(def, config);
    engine.weather.forceRain(wet, true);
    let sum = 0, n = 0;
    const steps = Math.round(300 / PHYSICS_DT);
    for (let i = 0; i < steps && !engine.over; i++) {
      engine.step();
      // Held there, so this measures the line and not the weather's own drift.
      if (i % 200 === 0) engine.weather.forceRain(wet, true);
      if (i > steps * 0.45 && i % 60 === 0) {
        for (const car of engine.cars) {
          if (car.retired || car.inPitLane || car.physics.speedMs < 20) continue;
          const idx = engine.track.indexAt(car.s);
          sum += Math.abs(car.lateral - engine.track.lineOffset[idx]);
          n++;
        }
      }
    }
    const laps = Math.max(...engine.cars.map((c) => c.lap));
    return { dev: n > 0 ? sum / n : 0, laps };
  };

  const dry = runFor(0);
  const soaked = runFor(0.95);
  console.log(`  dry     : mean offset from the dry line ${dry.dev.toFixed(3)}m  (leader reached lap ${dry.laps})`);
  console.log(`  soaked  : mean offset from the dry line ${soaked.dev.toFixed(3)}m  (leader reached lap ${soaked.laps})`);
  console.log(`  moved   : ${(soaked.dev - dry.dev).toFixed(3)}m`);
  check(soaked.dev > dry.dev + 0.25,
    `the field runs ${soaked.dev.toFixed(2)}m off the dry line when soaked against ${dry.dev.toFixed(2)}m when dry — ` +
    'the cars are not moving off the racing line in the wet');
  check(soaked.laps > 0,
    'nobody completed a lap on a soaked circuit — the wet model has made the game undriveable');
}

// ===========================================================================
// 7. Water collects where the elevation says it should
// ===========================================================================

console.log('\n=== 7. standing water, derived from real circuit elevation ===\n');

{
  console.log('  circuit        nodes  mean drain  max drain  pooling nodes  elev range');
  for (const def of CIRCUITS) {
    const track = new TrackSpline(def);
    const surf = new TrackSurface(track);
    let sum = 0, max = 0, pooling = 0;
    for (let i = 0; i < track.count; i++) {
      const d = surf.drainage[i];
      sum += d;
      if (d > max) max = d;
      if (d > 0.25) pooling++;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < track.count; i++) {
      lo = Math.min(lo, track.elevation[i]);
      hi = Math.max(hi, track.elevation[i]);
    }
    const mean = sum / track.count;
    void pooling;
    console.log(`  ${def.id.padEnd(13)} ${String(track.count).padStart(5)}  ` +
      `${mean.toFixed(3).padStart(10)}  ${max.toFixed(3).padStart(9)}  ` +
      `${String(pooling).padStart(13)}  ${(hi - lo).toFixed(1).padStart(6)}m`);

    // The assertion is conditioned on the circuit having elevation to speak of,
    // and that is not a way of excusing the flat ones — it is the correct
    // claim. Jeddah's surveyed profile varies by 3m over 6.2km and its deepest
    // point sits 3cm below the road ninety metres either side of it. There is
    // no pooling to derive there, and a model that manufactured some would be
    // amplifying survey noise into a puddle. A flat circuit floods uniformly,
    // which is what this returns.
    if (hi - lo > 15) {
      check(max > 0.4,
        `${def.id} has ${(hi - lo).toFixed(0)}m of elevation change and still no place where ` +
        `water collects (max drainage ${max.toFixed(3)}) — the elevation data is not reaching ` +
        'the water model');
    }
    check(mean < 0.6,
      `${def.id} pools everywhere (mean drainage ${mean.toFixed(3)}) — the whole circuit is a lake`);
  }
}

// ===========================================================================
// 8. The forecast is useful, and wrong
// ===========================================================================

console.log('\n=== 8. the pit wall forecast ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'spa')!;
  let readings = 0, correct = 0, phantom = 0, missed = 0;
  let confSum = 0;
  let sawUncertain = false;
  const errors: number[] = [];

  // Many seeds, because the question is about a distribution and one session
  // cannot answer it.
  for (let seed = 0; seed < 260; seed++) {
    const w = new Weather(def, seed);
    // Half an hour, sampled every 20s.
    let lastEta = -1;
    for (let t = 0; t < 1800; t++) {
      w.setTraffic(20);
      w.update(1);
      if (t % 20 !== 0) continue;
      const r = w.forecast.reading;
      if (!r) continue;
      if (r.confidence < 0.8) sawUncertain = true;
      // A reading is "judged" when it says a change is due within a minute:
      // that is the moment a strategist would act on it.
      if (r.etaS < 60 && r.etaS !== lastEta) {
        lastEta = r.etaS;
        readings++;
        confSum += r.confidence;
        // Did the sky actually do what was predicted, within two minutes?
        const before = w.rainRate;
        for (let k = 0; k < 150; k++) { w.setTraffic(20); w.update(1); }
        const after = w.rainRate;
        const predictedUp = r.intensity > before + 0.12;
        const predictedDown = r.intensity < before - 0.12;
        const actuallyUp = after > before + 0.1;
        const actuallyDown = after < before - 0.1;
        if ((predictedUp && actuallyUp) || (predictedDown && actuallyDown)
            || (!predictedUp && !predictedDown && !actuallyUp && !actuallyDown)) {
          correct++;
        } else if (predictedUp && !actuallyUp) {
          phantom++;
        } else if (!predictedUp && actuallyUp) {
          missed++;
        }
        errors.push(Math.abs(r.intensity - after));
        t += 150;
      }
    }
  }

  const rate = readings > 0 ? correct / readings : 0;
  const meanConf = readings > 0 ? confSum / readings : 0;
  const meanErr = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
  console.log(`  imminent-change readings judged : ${readings}`);
  console.log(`  called correctly                : ${correct} (${(rate * 100).toFixed(1)}%)`);
  console.log(`  rain called that never came     : ${phantom}`);
  console.log(`  rain that arrived uncalled      : ${missed}`);
  console.log(`  mean stated confidence          : ${(meanConf * 100).toFixed(1)}%`);
  console.log(`  mean intensity error            : ${meanErr.toFixed(3)}`);

  check(readings > 30, `only ${readings} forecast readings over 260 sessions — the wall barely says anything`);
  check(rate > 0.5,
    `the forecast is right ${(rate * 100).toFixed(0)}% of the time, which is no better than guessing`);
  check(rate < 0.97,
    `the forecast is right ${(rate * 100).toFixed(0)}% of the time — a strategist who is never wrong ` +
    'turns the crossover call from a decision into an instruction');
  check(sawUncertain, 'the wall never expresses less than 80% confidence in anything');
  check(meanConf < 0.95, `the wall averages ${(meanConf * 100).toFixed(0)}% confidence — it is too sure of itself`);
}

// ===========================================================================
// 9. The wall asks, the driver answers, the car pits
// ===========================================================================

console.log('\n=== 9. the radio exchange ===\n');

{
  const base: PitWallContext = {
    timeS: 0, compound: 'medium', dryPreference: 'medium',
    wetness: 0, trackTempC: REF_TEMP, lapsRemaining: 30,
    refLapS: 100, pitCostS: 22, usedDryCompounds: ['medium'],
    hasRained: false, racing: true, projectedWetness: 0,
    horizonLaps: 3, forecast: null,
  };

  // Dry, nothing coming: silence. A wall that talks on a dry track is noise.
  {
    const wall = new PitWall();
    for (let i = 0; i < 600; i++) wall.update(1 / 10, base);
    console.log(`  dry track, no forecast   : ${wall.pending ? 'SPOKE — ' + wall.pending.message : 'silent'}`);
    check(wall.pending === null,
      'the pit wall makes a call on a dry track with a dry forecast');
  }

  // Rain arriving, and the wall can see it: it should offer the stop BEFORE the
  // track is wet, which is the entire value of having a forecast.
  {
    const wall = new PitWall();
    const ctx: PitWallContext = {
      ...base,
      wetness: 0.05,
      projectedWetness: 0.75,
      forecast: {
        etaS: 140, intensity: 0.8, precipitation: 'rain',
        confidence: 0.78, worsening: true,
      },
    };
    let call = null;
    for (let i = 0; i < 200 && !call; i++) { wall.update(1 / 10, ctx); call = wall.pending; }
    console.log(`  rain forecast, track dry : ${call ? '"' + call.message + '"' : 'silent'}`);
    if (call) {
      console.log(`                   question: "${call.question ?? '(none)'}"`);
      console.log(`                   reason  : ${call.reason}`);
      console.log(`                   action  : ${call.action} ${call.compound ?? ''} ` +
        `(confidence ${(call.confidence * 100).toFixed(0)}%, ${call.priority})`);
    }
    check(call !== null, 'the wall says nothing with heavy rain two minutes away and the car on slicks');
    check(call !== null && call.question !== null,
      'the wall states the situation but never asks the driver anything');
    check(call !== null && call.action === 'box' && call.compound === 'intermediate',
      `the wall recommends ${call?.compound ?? 'nothing'} with the track about to be soaked`);
    check(call !== null && call.reason.length > 10,
      'the recommendation arrives without a reason attached');

    // The answer, and where it goes.
    const answered = call ? wall.answer(call.id, true) : 'lapsed';
    console.log(`  driver answers YES       : ${answered}, boxRequested=${wall.boxRequested}, ` +
      `compound=${wall.requestedCompound}`);
    check(answered === 'yes', 'answering the call yes did not take');
    check(wall.boxRequested && wall.requestedCompound === 'intermediate',
      'the driver said yes and the wall did not ask for the tyre it recommended');

    // And answering an id that is no longer live must do nothing rather than
    // throw or, worse, silently pit the car.
    check(wall.answer(9999, true) === 'lapsed', 'answering a stale call was accepted');
  }

  // Saying no means no, and the wall does not immediately ask again.
  {
    const wall = new PitWall();
    const ctx: PitWallContext = {
      ...base, wetness: 0.6, projectedWetness: 0.7,
      forecast: { etaS: 30, intensity: 0.7, precipitation: 'rain', confidence: 0.8, worsening: true },
    };
    let call = null;
    for (let i = 0; i < 200 && !call; i++) { wall.update(1 / 10, ctx); call = wall.pending; }
    check(call !== null, 'the wall says nothing with the car on slicks on a soaked track');
    if (call) wall.answer(call.id, false);
    check(!wall.boxRequested, 'saying no to the call still requested a stop');
    let asked = 0;
    for (let i = 0; i < 300; i++) { wall.update(1 / 10, ctx); if (wall.pending) asked++; }
    console.log(`  driver answers NO        : re-asked within 30s? ${asked > 0 ? 'yes' : 'no'}`);
    check(asked === 0, 'the driver said no and the wall asked again within half a minute');
  }

  // An unanswered call lapses rather than hanging about for ever.
  {
    const wall = new PitWall();
    const ctx: PitWallContext = {
      ...base, wetness: 0.6, projectedWetness: 0.7,
      forecast: { etaS: 30, intensity: 0.7, precipitation: 'rain', confidence: 0.8, worsening: true },
    };
    for (let i = 0; i < 200 && !wall.pending; i++) wall.update(1 / 10, ctx);
    check(wall.pending !== null, 'no call to lapse');
    for (let i = 0; i < 800; i++) wall.update(1 / 10, ctx);
    console.log(`  unanswered call          : ${wall.pending ? 'still pending' : 'lapsed'}`);
    check(wall.pending === null, 'an unanswered offer never expires');
    check(!wall.boxRequested, 'an unanswered offer pitted the car anyway');
  }

  // The two-compound rule constrains what can be offered.
  {
    const wall = new PitWall();
    const ctx: PitWallContext = {
      ...base, compound: 'medium', dryPreference: 'medium',
      wetness: 0.5, projectedWetness: 0.5, lapsRemaining: 8,
      usedDryCompounds: ['medium'], hasRained: false,
      forecast: { etaS: 20, intensity: 0.5, precipitation: 'rain', confidence: 0.8, worsening: true },
    };
    let call = null;
    for (let i = 0; i < 200 && !call; i++) { wall.update(1 / 10, ctx); call = wall.pending; }
    console.log(`  8 laps left, one dry compound used: recommends ${call?.compound ?? 'nothing'}`);
    check(call === null || call.compound !== 'medium',
      'the wall recommended the compound the car is already on');
  }
}

// ===========================================================================
// 10. The AI's compounds track the conditions
// ===========================================================================

console.log('\n=== 10. what the field fits, in a race that rains ===\n');

{
  const def = CIRCUITS.find((c) => c.id === 'silverstone')!;
  const config: SessionConfig = {
    kind: 'race', name: 'GP', durationS: 0, laps: 30,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 5,
  };
  const engine = new RaceEngine(def, config);

  console.log('  min   rain  water  Ttrk  wets  inters  slicks  stops  crossover');
  let sawWets = false, sawSlicksBack = false, peakWater = 0;
  let wetRaceReached = false;
  const steps = Math.round(2700 / PHYSICS_DT);
  for (let i = 0; i < steps && !engine.over; i++) {
    // A scripted front: dry, soaked, then drying. Scripted so the probe
    // measures the RESPONSE rather than the roll of the dice.
    if (i === Math.round(300 / PHYSICS_DT)) engine.weather.forceRain(0.95);
    if (i === Math.round(1200 / PHYSICS_DT)) engine.weather.forceRain(0);
    engine.step();

    if (i % Math.round(180 / PHYSICS_DT) === 0) {
      const w = engine.weather;
      let wets = 0, inters = 0, slicks = 0;
      for (const c of engine.cars) {
        if (c.retired) continue;
        if (c.compound === 'wet') wets++;
        else if (c.compound === 'intermediate') inters++;
        else slicks++;
      }
      if (inters + wets > 4) { sawWets = true; wetRaceReached = true; }
      if (wetRaceReached && slicks > 10 && i > Math.round(1500 / PHYSICS_DT)) sawSlicksBack = true;
      peakWater = Math.max(peakWater, w.wetness);
      const stops = engine.cars.reduce((a, c) => a + c.pitStops, 0);
      console.log(`  ${(engine.time / 60).toFixed(1).padStart(4)}  ${w.rainRate.toFixed(2)}  ` +
        `${w.wetness.toFixed(3)}  ${w.trackTempC.toFixed(0).padStart(4)}  ` +
        `${String(wets).padStart(4)}  ${String(inters).padStart(6)}  ${String(slicks).padStart(6)}  ` +
        `${String(stops).padStart(5)}  ${conditionsCompound(w.wetness, w.trackTempC, 'medium')}`);
    }
  }

  const finished = engine.cars.filter((c) => !c.retired).length;
  console.log(`\n  peak water ${peakWater.toFixed(3)}, ${finished} of ${engine.cars.length} still running`);
  check(peakWater > 0.4, `the scripted downpour only reached ${peakWater.toFixed(3)} water on the line`);
  check(sawWets, 'the field never fitted a wet-weather tyre in a race that was soaked for fifteen minutes');
  check(sawSlicksBack, 'the field never came back to slicks once the track dried');
  check(finished >= engine.cars.length * 0.5,
    `only ${finished} of ${engine.cars.length} cars survived a wet race — the wet model is not driveable`);

  // And the crossover the engine acts on is the one Strategy computes.
  const c = crossoverCase('medium', 0.7, REF_TEMP, def.referencePoleTimeS, 22, 20);
  console.log(`  on slicks at 0.70 water, 20 laps left: lose ${c.lossPerLapS.toFixed(2)}s/lap, ` +
    `stop costs ${c.pitCostS}s, breaks even in ${c.breakEvenLaps.toFixed(1)} laps -> ` +
    `${c.worthIt ? 'BOX' : 'stay out'} for ${c.best}`);
  check(c.worthIt && c.best === 'intermediate',
    'twenty laps on slicks with a soaked track is not judged worth a stop');
  const late = crossoverCase('medium', 0.7, REF_TEMP, def.referencePoleTimeS, 22, 1);
  console.log(`  ...and with 1 lap left               : ${late.worthIt ? 'BOX' : 'stay out'}`);
  check(!late.worthIt, 'the strategist calls a stop on the last lap, which can never pay for itself');
}

// ===========================================================================

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 30)) console.log('  ' + f);
  if (failures.length > 30) console.log(`  … and ${failures.length - 30} more`);
  process.exitCode = 1;
} else {
  console.log('\nWeather OK');
}
