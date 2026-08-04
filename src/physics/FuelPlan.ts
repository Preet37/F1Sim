import { clamp } from '../core/MathUtils';

/**
 * How much fuel a race needs, and what a driver does when it is not enough.
 *
 * The third member of the family `PitLimiter.ts` and `NeutralisedLimiter.ts`
 * belong to, and it is here for the same reason both of those are: several
 * parts of the simulation have to agree exactly about a limit the car is
 * under, and while they did not, the disagreement retired sixteen cars a race.
 *
 * ===========================================================================
 * WHAT WAS MEASURED, AND WHY IT LOOKED LIKE A SAFETY CAR BUG
 * ===========================================================================
 *
 * Issue #26 recorded, from outside this subsystem, that cars were spending
 * 3458 car-seconds "stationary with nothing within 60m in front of them while
 * the race was neutralised", and that after issue #28 gave the engine a
 * stationary timer, 10.5 cars a race were being retired `Stopped on track` —
 * "every one under a VSC, from lap 48, with clear road ahead". Both issues
 * localised the cause to the neutralised limiter. **It is not there**, and the
 * instrumentation says so in one line:
 *
 *   vsc ai=FOLLOW thr=0.20 brk=0.00 gear=1 rpm=4000 trac=0.20
 *   gripF=0.807 gripR=0.807 wearF=0.99 corner=29.3 line=39.9 cap=50 scale=0.50
 *
 * The tyres are fine, the cornering limit is 29.3 m/s, the neutralised limit is
 * asking for about 20 m/s, the brake is OFF and the driver has the throttle
 * open — and the car is doing 0.05 m/s and slowing. Nothing is braking it.
 * `VehiclePhysics.step` makes no drive force at all when `fuelL <= 0.01`, and
 * an empty tank reproduces exactly that trace on the bench: 20% throttle from
 * 3 m/s in first gear decays to 0.76 m/s in eight seconds and keeps going.
 *
 * THE DEFECT IS TWO THINGS, AND EITHER ALONE WOULD HAVE BEEN SURVIVABLE.
 *
 * (a) `peakFuelBurnLps` was 0.048 L/s, which is 129.6 kg/h against the 100 kg/h
 *     of FIA Technical Regulations Art. 5.1.4. See the constant's own note in
 *     `VehicleSpec.ts`: it is 30% over a regulation and it implies a 37%
 *     efficient hybrid.
 *
 * (b) The tank was filled per KILOMETRE — `raceLaps x lengthKm x 0.33 + 4` —
 *     and it is emptied per SECOND. Those two agree at exactly one lap time and
 *     the field does not run it: the AI is 1.4 to 1.6 times the solved
 *     reference lap (PROJECT.md's oldest open item) and a neutralisation adds
 *     seconds without adding metres.
 *
 * Measured by `probe:neutral`, full distance, F3, medium, on `main`:
 *
 *                          Silverstone 52     Monza 53
 *   loaded                       105.1 L       105.3 L
 *   burnt                       2.85 L/lap    2.63 L/lap
 *   tanks emptied                  14            9
 *   retired                     20 of 20      20 of 20
 *   of those, stalled under a
 *   neutralisation on clear road   12            8
 *
 * So the field runs out of fuel three quarters of the way through every full
 * distance race, coasts to a halt wherever it happens to be, and — since #28 —
 * is retired for stopping on track. **That is issue #26's 10.5 retirements a
 * race, and it is why full-distance retirement counts have not been measuring
 * attrition.**
 *
 * WHY IT PRESENTS AS A NEUTRALISATION BUG, WHICH IS THE INTERESTING PART. A
 * neutralisation is the one thing in a race that adds SECONDS without adding
 * METRES: the race that produced the numbers above was 30% neutralised and took
 * 6390 simulated seconds for a distance worth about 4600. Every second of that
 * is charged against a tank that was filled for the distance. So the
 * neutralisation genuinely is what empties the tank — it simply does it through
 * the fuel model rather than through the speed limit, and the car it stops is
 * stopped a lap or two later, under whatever flag happens to be out. Hence
 * "every one under a VSC, with clear road ahead".
 *
 * ===========================================================================
 * WHAT THIS FILE DOES ABOUT IT
 * ===========================================================================
 *
 * Two halves, and they are deliberately independent so that neither is load
 * bearing on its own.
 *
 * `raceFuelLoadL` fills the tank from the race's expected DURATION and the
 * burn model, instead of from a litres-per-kilometre constant.
 *
 * `fuelPaceScale` is what a driver does when the sums still do not work, which
 * on the longest circuits they will, because the tank is a finite size and the
 * regulations cap it. A real driver lifts and coasts — it is the single most
 * common instruction on a team radio and this codebase already broadcasts it
 * (`RaceEngineer` files a `fuel` note when the margin goes negative) with
 * nothing at all listening to it. Running the tank to zero and stopping on the
 * racing surface is not a thing that happens in motor racing, and it is not a
 * thing the driver has no answer to.
 */

/**
 * Litres per lap the fill is planned against, per second of racing.
 *
 * NOT a litres-per-kilometre constant, which is the bug.
 *
 * MEASURED, and cross-checked against the burn model rather than derived from
 * it. A Silverstone F3 race burns 2.13 L in a 143.0s lap once
 * `peakFuelBurnLps` is at the flow limit Art. 5.1.4 actually sets, which is
 * 0.0149 L/s. The model's own arithmetic agrees: `peakFuelBurnLps` is 0.0370
 * L/s and the model charges `throttle x (0.35 + 0.65 x rpmFraction)` of it, so
 * a lap spent roughly 60% of its time with the throttle open at an rpm fraction
 * near three quarters gives 0.0370 x 0.60 x (0.35 + 0.65 x 0.75) = 0.0186 L/s.
 *
 * 0.0175 sits between them, 17% above the measurement. Being conservative is
 * the right direction and not a symmetric choice: a car that finishes with fuel
 * left has carried weight it did not need and lost a fraction of a second a
 * lap, and a car that finishes without it has stopped on the circuit and been
 * retired.
 */
export const RACE_BURN_L_PER_S = 0.0175;

/**
 * How much longer than the reference lap a race lap actually is.
 *
 * The number the old per-kilometre constant implicitly assumed to be 1.00, and
 * it is nowhere near it. PROJECT.md has recorded "AI pace ~1.43x reference" as
 * the oldest open item in the project for as long as there has been a list, and
 * a neutralised race is slower still: 6390s for 52 laps of Silverstone against
 * a solved reference lap of 88.3s is 1.39x, and the 12-lap measurement above
 * reads 1.62x with a larger neutralised share.
 *
 * 1.50 sits between them and above the pace item's own figure. It is a
 * PLANNING number and it is deliberately generous: over-fuelling costs a
 * fraction of a second a lap in weight, and under-fuelling parks the car.
 *
 * IF THE AI PACE ITEM IS EVER CLOSED, THIS SHOULD COME DOWN WITH IT. It is
 * written here as one named constant, in one place, so that it can be.
 */
export const RACE_PACE_VS_REFERENCE = 1.50;

/**
 * Reserve on top of the plan, as a fraction.
 *
 * The regulations require a one-litre sample to be available after the race
 * (2026 Technical Regs; the 2025 equivalent is Art. 6.5.2), so a real car never
 * plans to arrive empty either. Ten per cent covers that plus the difference
 * between one driver's duty cycle and another's.
 */
export const FUEL_RESERVE_SHARE = 0.05;

/**
 * Racing seconds a car burns that are not laps, per race.
 *
 * The engine is running on the grid before the lights go out, round the
 * formation lap, down the pit lane on every stop, and on the slowing-down lap
 * after the flag, and the burn model charges for all of it. It is a FIXED cost
 * and not a per-lap one, which is why a plan built purely from lap count
 * leaves a short race dry while leaving a long one comfortable — measured, a
 * three-lap race emptied four tanks on a per-lap-only plan that had 45% of
 * margin at fifty laps.
 *
 * Four minutes: about a minute on the grid, a formation lap, two pit lane
 * transits and a slowing-down lap.
 */
export const FUEL_FIXED_S = 240;

/**
 * The race fuel load, litres.
 *
 * @param laps            race distance in laps, from the SESSION
 * @param referenceLapS   the solved reference lap time for this circuit
 * @param capacityL       the tank, `VehicleSpec.fuelCapacityL`
 *
 * THE DISTANCE IS THE SESSION'S. The old formula used `def.raceLaps`
 * unconditionally, so a five-lap harness race and a quarter-distance career
 * race both started with a full Grand Prix of fuel on board — about eighty
 * kilos of ballast, carried for the whole session, on a car whose lap time the
 * same harness then measured.
 *
 * Capped by the tank, which is a real constraint and not a safety net: at full
 * distance the plan does not fit and is not meant to. 145 litres is about 109
 * kilos, which is what a real car starts a Grand Prix with. What covers the
 * shortfall is `fuelPaceScale`, exactly as it does in the real sport.
 */
export function raceFuelLoadL(laps: number, referenceLapS: number, capacityL: number): number {
  const planS = laps * referenceLapS * RACE_PACE_VS_REFERENCE + FUEL_FIXED_S;
  const planL = planS * RACE_BURN_L_PER_S * (1 + FUEL_RESERVE_SHARE);
  return Math.min(capacityL, planL);
}

/**
 * The floor the saving may take a car down to, as a fraction of its own pace.
 *
 * A fuel-saving lap is a few per cent off, not half. But the floor here is not
 * about realism — it is about the failure this whole file exists to prevent:
 * a scale that is allowed to approach zero is a limiter that stops the car,
 * which is the bug with a different cause. 0.70 of pace is a car that is
 * plainly nursing it home and is still unambiguously driving, and it is well
 * clear of `RaceEngine.STRANDED_SPEED_MS` at every point on every lap.
 */
export const FUEL_SAVE_FLOOR = 0.70;

/**
 * How hard the driver has to save, 1 = not at all.
 *
 * LINEAR IN THE SHORTFALL, and that is the burn model's own arithmetic rather
 * than a guess. Running a lap at a fraction `k` of pace takes `1/k` times as
 * long, and the throttle it needs falls roughly as `k^2` because most of the
 * energy goes into drag — so the litres per lap, which is the product of the
 * two, falls as `k`. A driver who is 10% short of fuel therefore has to be
 * about 10% off the pace, which is also about what a real fuel-save
 * instruction costs.
 *
 * @param remainingL   fuel in the tank now
 * @param perLapL      what this car has been using per lap
 * @param lapsRemaining laps still to run
 *
 * Returns 1 when there is nothing to do, which is the overwhelming majority of
 * every race — this is a floor under a failure, not a pace handicap.
 */
export function fuelPaceScale(
  remainingL: number, perLapL: number, lapsRemaining: number,
): number {
  if (perLapL <= 0.001 || lapsRemaining <= 0) return 1;
  const needed = perLapL * lapsRemaining;
  if (needed <= remainingL) return 1;
  return clamp(remainingL / needed, FUEL_SAVE_FLOOR, 1);
}
