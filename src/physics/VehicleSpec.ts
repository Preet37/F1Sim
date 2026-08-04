/**
 * Physical description of a car, and the per-team variance applied to it.
 *
 * Team differences are expressed as multipliers on physical quantities — power,
 * downforce, drag, mechanical grip — rather than as a single "car rating". That
 * way a low-drag, low-downforce car is genuinely fast at Monza and genuinely
 * poor at Monaco, and the strengths fall out of the physics instead of being
 * scripted per circuit.
 */

export interface VehicleSpec {
  /** Dry mass including driver, kg. FIA minimum is 798kg. */
  dryMassKg: number;
  /** Fuel tank capacity, litres. */
  fuelCapacityL: number;
  /** Fuel density, kg per litre. */
  fuelDensity: number;

  wheelbaseM: number;
  /** Distance from CoG to front axle, m. */
  cogToFrontM: number;
  /** CoG height, m. Drives longitudinal and lateral load transfer. */
  cogHeightM: number;
  trackWidthM: number;
  /** Loaded tire radius, m. */
  tireRadiusM: number;

  /** Peak internal combustion power, W. */
  icePowerW: number;
  /** MGU-K deployment power, W. Regulation limit is 120kW. */
  ersPowerW: number;
  /** Engine speed limits. */
  idleRpm: number;
  redlineRpm: number;
  /** Fraction of redline where peak torque occurs. */
  peakTorqueFrac: number;

  /** Gear ratios, first to eighth, multiplied by the final drive. */
  gearRatios: readonly number[];
  /** Reverse ratio. */
  reverseRatio: number;
  /** Drivetrain efficiency. */
  driveEfficiency: number;

  /** Downforce coefficient: F = cl * v^2, Newtons. */
  clBase: number;
  /** Fraction of downforce acting on the front axle. */
  aeroBalanceFront: number;
  /** Drag coefficient: F = cd * v^2. */
  cdBase: number;
  /** Fractional drag reduction when DRS is open. */
  drsDragReduction: number;
  /** Fractional downforce loss when DRS is open (the rear wing stalls). */
  drsDownforceLoss: number;

  /**
   * Ride height at the plank under each axle with the car dry and at rest, m.
   *
   * The plank is the 10mm wooden board under the floor (F1 Technical
   * Regulations Art. 3.5.9) into which the titanium skid blocks are bolted, and
   * it is the skids — not the bodywork — that touch the road and throw sparks.
   * Rear is higher than front: that difference is the car's rake.
   */
  staticRideHeightFrontM: number;
  staticRideHeightRearM: number;
  /**
   * Vertical stiffness at the axle in heave, N/m.
   *
   * What decides how far the floor sinks under load, and therefore when it
   * touches the road. Front is stiffer than rear on a ground-effect car because
   * the front of the floor is the part that must not be allowed to seal.
   */
  heaveStiffnessFrontNPerM: number;
  heaveStiffnessRearNPerM: number;

  /** Peak tire friction coefficient before compound and thermal effects. */
  baseMu: number;
  /** Cornering stiffness coefficient for the magic-formula lateral model. */
  corneringStiffnessFront: number;
  corneringStiffnessRear: number;

  /** Maximum steering angle at the road wheels, radians. */
  maxSteerRad: number;
  /** Peak brake torque split, front fraction. */
  brakeBalanceFront: number;
  /** Total braking force at full pedal, N, before grip limiting. */
  maxBrakeForceN: number;

  /** Fuel burn at full throttle and peak rpm, litres per second. */
  peakFuelBurnLps: number;

  /** Battery capacity, Joules. Regulation store is 4MJ. */
  batteryCapacityJ: number;
  /** Maximum harvest power under braking, W. */
  maxHarvestW: number;
}

/** A current-generation ground-effect F1 car. */
export const BASE_F1_SPEC: VehicleSpec = {
  dryMassKg: 798,
  fuelCapacityL: 145,
  fuelDensity: 0.75,

  wheelbaseM: 3.6,
  cogToFrontM: 1.98, // 45/55 rearward weight distribution
  cogHeightM: 0.28,
  trackWidthM: 2.0,
  tireRadiusM: 0.36,

  icePowerW: 560_000,
  ersPowerW: 120_000,
  idleRpm: 4_000,
  redlineRpm: 15_000,
  peakTorqueFrac: 0.72,

  // Geometric spread giving ~110km/h in first and ~340km/h in eighth.
  gearRatios: [18.5, 15.75, 13.41, 11.42, 9.72, 8.28, 7.05, 6.0],
  reverseRatio: 16.0,
  driveEfficiency: 0.93,

  clBase: 3.3,
  // At racing speed downforce dwarfs the car's own weight, so this number — not
  // the mass distribution — decides how much load the front axle actually has,
  // and with it the car's understeer margin.
  //
  // A steady turn needs the front to supply b/L = 45% of the cornering force. It
  // was set to 0.455, i.e. the front had very slightly MORE than its share, which
  // makes the car neutral-to-oversteering by load. That was compensation for a
  // bug, not a chassis decision: the old yaw damper forced the front axle to
  // out-pull the rear by ~2kNm at all times (see the yaw-damping block in
  // VehiclePhysics), a ~10% permanent front overload, and raising aero balance to
  // 0.455 was an attempt to feed the front enough load to survive it. It could
  // not — `balance` stayed negative everywhere — and it left the car with no real
  // stability margin of its own.
  //
  // With the damper corrected the compensation has to come off too, or the car
  // has terminal oversteer: it spun above 140km/h from an ordinary steering
  // input, and peak lateral at 300km/h fell to 4.6g because the fast runs were
  // spins. 0.435 gave the front slightly less than its share, which is a real
  // understeer margin that the chassis owns rather than one borrowed from a
  // fictitious torque.
  //
  // 0.435 was not ENOUGH margin, and the reason is that it was measured on a
  // skidpad with no longitudinal force on the car. Real cornering never happens
  // that way. Longitudinal load transfer is `a * m * h / L`, so at 200km/h in
  // maximum-downforce trim, drag ALONE is worth 0.37g and moves the front's
  // share of the load from 0.44 to 0.452 — past the 0.45 the moment balance
  // needs, before the driver has touched anything. The whole 1.5-point margin is
  // spent by the car simply travelling fast. Add four percent of brake pedal and
  // the front is at 0.457, the rear has to work past the peak of its own tire
  // curve to make up its share, and beyond that peak there is no equilibrium at
  // all: the car spins. Four percent. Measured, at 200km/h on a 3.6g corner.
  //
  // That is what was destroying the field — 17 of 20 cars out on lap one at
  // Silverstone, 13 of 17 retirements at Spa inside a hundred metres of one
  // corner, every one of them trail-braking into a fast turn.
  //
  // 0.40 buys a five-point margin, which is roughly 1.4g of longitudinal load
  // transfer — a real braking zone — before the balance crosses over. It costs
  // about 2% of peak lateral grip (300km/h skidpad 5.71 -> 5.62g), and it is
  // still inside the real 40-46% window. Over 55 races it is worth 12.0 -> 8.4
  // mean retirements and a FASTER field, not a slower one: mean lap 1.507 ->
  // 1.444 of the solved reference, because the cars now finish their corners
  // instead of spinning in them.
  aeroBalanceFront: 0.40,
  cdBase: 0.82,
  drsDragReduction: 0.22,
  drsDownforceLoss: 0.16,

  // Ride height and heave. These four numbers exist to answer one question —
  // when is the floor ON the road — because that is what makes sparks, and
  // sparks were previously drawn from a speed term that never switched off.
  //
  // They are set so that the car grounds where a real one does, which is a
  // stronger constraint than it sounds; the stiffnesses are not free once the
  // ride heights are chosen, because downforce is already fixed by `clBase`.
  //
  //   At 250km/h in race trim: q = 4823, downforce ~17.5kN once `applySetup`
  //   has scaled it, split 40/60 by `aeroBalanceFront`. Plus a full tank
  //   (~1.08kN) split 45/55. Front sees ~7.5kN, which at 360kN/m is 20.8mm of
  //   travel against 20mm of static height — so the front skid touches down at
  //   about 250km/h with fuel in the car, and rather later without it.
  //
  //   Braking is the other half. Load transfer is `a*m*h/L` = 3.36kN at 5g,
  //   all of it onto the front. At 200km/h that puts the front 3mm INTO the
  //   road when it was 6mm clear a moment earlier — which is why the sparks a
  //   television camera catches are almost always in a braking zone at the end
  //   of a long straight, and why they stop as the car slows.
  //
  //   The rear is 60mm on softer springs and grounds later, above about
  //   280km/h, which is the pure top-speed case rather than the braking one.
  //
  // CALIBRATION. The first pass at these numbers used 26mm and 70mm and was
  // measurably too high: `probe:rideheight` put the floor on the road for
  // 0.0-0.9% of a lap, which is a spark shower nobody would ever see. These
  // give a few per cent, concentrated in the braking zones, which is what the
  // report asked for and what a broadcast actually looks like. The point is
  // that it is now a number that can be checked rather than a feel.
  //
  // Both together mean sparks are an EVENT with a cause, not a speed effect.
  // Measured across the calendar by `npm run probe:rideheight`.
  staticRideHeightFrontM: 0.020,
  staticRideHeightRearM: 0.060,
  heaveStiffnessFrontNPerM: 360_000,
  heaveStiffnessRearNPerM: 210_000,

  baseMu: 1.70,
  // These two set BOTH the linear balance and the limit balance and cannot be
  // chosen independently: the magic formula peaks at alpha = 1.978 / stiffness,
  // so a stiffer axle also saturates at a SMALLER slip angle. Keeping the rear
  // stiffer than the front is what makes the car understeer rather than
  // oversteer in the linear range, which is the stable way round.
  //
  // The front was 11.5, peaking at 9.85 degrees against the rear's 8.85. In
  // practice the front was operating at 7-13 degrees and the rear at 3-4, so
  // the front spent most of a corner past its own peak while the rear had grip
  // to spare. 12.4 pulls the front's peak to 9.14 degrees — close enough to the
  // rear's that the two axles give up together — and sharpens turn-in without
  // inverting the understeer gradient.
  corneringStiffnessFront: 12.4,
  corneringStiffnessRear: 12.8,

  // 24 degrees at the road wheels. Monaco's Grand Hotel hairpin is an 11m radius
  // and needs atan(wheelbase/radius) = 18 degrees just to geometrically fit, so a
  // narrower rack cannot physically make the corner — the AI ran wide there on
  // every single lap regardless of how slowly it approached.
  maxSteerRad: 0.42,
  /**
   * Front share of the mechanical brake force.
   *
   * This is the single most effective stability control the model has, and it
   * was set 6 points too far rearward. `probe:drivability` measures what a yaw
   * disturbance does when the driver holds the wheel still, differenced against
   * an undisturbed run of the same manoeuvre, and at 0.58 the answer under
   * braking was that it NEVER decayed — at 150, 220 and 300 km/h alike, a bump
   * taken with a quarter of brake pedal grew monotonically for the whole
   * measurement window. Coasting and on power the same disturbance died away at
   * 2.5-6 per second. The car was directionally unstable whenever the brake was
   * touched, and that is precisely the "randomly starts over steering" report.
   *
   * The mechanism is the friction circle, not the tyre curve. Braking transfers
   * load forward, so the front axle's grip budget grows and the rear's shrinks;
   * for the car to stay understeering, the front has to be spending that extra
   * budget on stopping rather than banking it as extra cornering force. Brake
   * bias is exactly the lever that decides how much it spends. At 150 km/h with
   * a quarter of pedal the rear was at 100.6% of its circle and the front at
   * 91%: the rear was the limiting axle under braking, which is the definition
   * of a car that snaps.
   *
   * Measured across the bias sweep, holding everything else fixed:
   *
   *     bias   hands-still divergences   brake pedal accepted   300-50 distance
   *     0.58            6 of 12                  0.37                84 m
   *     0.64            1 of 12                  0.65                94 m
   *     0.70            0 of 12                  1.00                98 m
   *
   * 0.64 takes 12% more distance to stop from 300, which is real and is the
   * price, and it is still 94m against a 75-175m expectation with peak braking
   * at 6.35g. That is a trade worth making: the stopping distance is a number
   * nobody feels and the spin is the entire complaint.
   *
   * It is also more defensible than it first looks. Published F1 bias figures of
   * 54-58% are the split between the front and rear BRAKING SYSTEMS, and this
   * car recovers up to 200kW through the MGU-K on the rear axle under braking —
   * worth another 3.6kN of rear retardation at 200km/h — which this model banks
   * as charge without applying as force. A mechanical split of 0.64 against a
   * rear axle that is also harvesting is not an unusual car.
   */
  brakeBalanceFront: 0.64,
  // Sized so the calipers can lock the wheels at ANY speed, which is what a real
  // F1 brake system does and what this one used to get backwards.
  //
  // At 38kN the car was brake-limited when fast and grip-limited when slow: the
  // tires can take 53.5kN at 300 km/h, so full pedal there reached only 71% of
  // the available grip and the pedal simply ran out of authority. Below about
  // 150 km/h the same 38kN was already well over the grip limit. The result was
  // a car whose hardest braking happened in the slow corners — exactly inverted
  // from a downforce car, and the reason the initial bite from a straight felt
  // soft. 52kN covers the tire's peak longitudinal capacity at 300 km/h, so the
  // limit is now the tire everywhere and the driver, not the caliper, decides
  // how much retardation is on offer. Overdoing it still locks and flat-spots.
  maxBrakeForceN: 52_000,

  /**
   * Peak fuel burn, litres per second.
   *
   * THIS IS A REGULATION AND IT WAS 30% OVER IT. FIA Technical Regulations
   * Art. 5.1.4 — "fuel mass flow must not exceed 100kg/h" — and 100 kg/h at the
   * `fuelDensity` above is 0.0370 L/s. It was 0.048, which is 129.6 kg/h: a
   * power unit that could not be homologated, running a flow limiter that does
   * not exist.
   *
   * The thermodynamics agree, which is the check worth doing on a number like
   * this. 0.02778 kg/s of a fuel with a lower heating value around 42 MJ/kg is
   * 1167 kW into the engine, and `icePowerW` is 560 kW out of it — 48% thermal
   * efficiency, which is what a modern Formula 1 hybrid is quoted at. At 0.048
   * the same arithmetic gives 37%, which is a road car.
   *
   * WHAT IT COST. Nothing in performance — this constant is read in exactly one
   * place, `VehiclePhysics.step`'s `burn`, and never in the force or power path
   * — and everything in reliability. It made a race cost 2.980 litres a lap
   * against a tank filled with 105.1, so the field ran dry on lap 35 of 52,
   * coasted to a halt on the racing surface and was retired for stopping on
   * track: twenty of twenty cars, at two circuits, at full distance. See
   * `physics/FuelPlan.ts` for the whole chain and issue #26 for what it was
   * mistaken for.
   *
   * The 2026 power unit's own limit is lower still — the ICE moves to an energy
   * flow cap of about 3000 MJ/h, near 70 kg/h — but it comes with a 400 kW ICE
   * and a 350 kW MGU-K, and `icePowerW`/`ersPowerW` above model the 560/120
   * generation. The flow limit and the engine it feeds have to be the same
   * generation, so this is Art. 5.1.4's.
   */
  peakFuelBurnLps: 0.0370,

  batteryCapacityJ: 4_000_000,
  maxHarvestW: 200_000,
};

/**
 * The fraction of `mu * N` that this car's axles actually deliver in a corner.
 *
 * **`baseMu` is a magic-formula coefficient, not an achievable lateral friction
 * coefficient, and for the whole life of this project four separate places have
 * treated it as though it were one.** `TrackSpline.corneringSpeedForCar`,
 * `TrackSpline.brakingDecelForCar`, `AIVehicleController.corneringSpeedLimitMs`
 * and the racing-line overlay all evaluate the same closed form,
 *
 *     mu * (m*g + cl*v^2)  =  m*v^2/r
 *
 * and all four read `mu` straight off `baseMu`. A point mass with one friction
 * coefficient reaches that. A car with two axles does not, for three reasons
 * that are all in `VehiclePhysics` already and none of which the closed form
 * can see: tyre grip is sub-linear in load, so transferring load across an axle
 * loses more on the unloaded wheel than the loaded one gains; the two axles peak
 * at different slip angles (see `corneringStiffness*` above), so they cannot
 * both be at their peak at once; and holding a steady corner spends some of the
 * budget on drag.
 *
 * **MEASURED, not chosen.** `npm run probe:envelope` steps the real
 * `VehiclePhysics` at the real `PHYSICS_DT` through a steering sweep at five
 * speeds, on eleven circuits, with two cars — front-runner on mediums with 60L
 * and backmarker on hards with 100L — and takes the largest steady lateral g the
 * car will actually hold. The mean of `measured / closed-form` over those 110
 * samples is this number, and the probe FAILS if the two drift more than 0.03
 * apart. It also fails if the ratio stops being flat across speed, downforce and
 * tyre, because a single scalar is only the right shape while it is.
 *
 * Measured 2026-08-03: **mean 0.7770 over 110 samples, range 0.730..0.813.**
 * The spread is the part that justifies one scalar: it is 0.083 wide over a
 * 2.6x range of speed, a 0.12..1.00 range of downforce demand, two teams and two
 * compounds. The residual structure in it is real and is the direction physics
 * predicts — the ratio falls slightly with speed, because more downforce means
 * more load and grip is sub-linear in load — but 8% is not worth a table.
 *
 * The first value written here was 0.858, arrived at by hand arithmetic off a
 * single circuit. The probe failed it immediately and named the number, which is
 * the demonstration that it can go red, for free and on the first run.
 *
 * **What it is for.** The overlay colours the road GREEN while the corner ahead
 * is inside the closed form's answer, so an uncorrected closed form promises the
 * player grip the car has not got — the user's *"if the racing line is green how
 * did i go off the track?"*. Applying this makes the promise honest.
 *
 * **What it is NOT for.** It is deliberately NOT applied inside
 * `solveSpeedProfile`. `REFERENCE_CAR.mu` is not a physical claim about any car
 * — it is a parameter `npm run calibrate` fitted so that the solved lap time
 * lands on real pole times across the whole calendar, and moving it re-bases
 * every lap-time assertion in the suite at once. The gap between the reference
 * lap and what the vehicle model can do is real and is issue #1's ground; it is
 * measured by `scripts/diagAiPace.ts` rather than papered over here.
 */
export const ACHIEVABLE_GRIP_FRACTION = 0.777;

/**
 * Per-team performance deltas. Each field multiplies the base spec.
 * A value of 1.0 is the reference car.
 */
export interface TeamPerformance {
  powerMult: number;
  downforceMult: number;
  dragMult: number;
  mechanicalGripMult: number;
  /**
   * Scales the car's dry mass. Optional; 1.0, and absent, are the same car.
   *
   * This exists because `TeamPerformance` is the ENTIRE bandwidth between career
   * mode and the simulation, and career mode now runs Formula 2 and Formula 3 by
   * expressing them as teams. Without a mass term a Formula 3 car weighs what a
   * Formula 1 car weighs, and no amount of power and downforce tuning can
   * substitute for that, because mass and downforce do not act alike:
   *
   *   - downforce goes as v squared, so taking it away costs a car almost
   *     nothing at 60km/h and everything at 250;
   *   - mass is there at every speed, and what it costs is worst where the car
   *     is slowest — traction out of a hairpin, and the transient before
   *     downforce arrives.
   *
   * So a junior tier built only out of power and downforce comes out right at
   * Monza and too slow at Zandvoort, which is exactly what `probe:tiers`
   * measured: +12.7 and +20.1 per cent at Monza against +16.8 and +24.8 at
   * Zandvoort, for targets of 13 and 19.
   *
   * OPTIONAL RATHER THAN REQUIRED, deliberately. Every existing caller builds
   * this record by hand and none of them wanted a mass change; making the field
   * required would have meant editing all of them to write `massMult: 1`, which
   * is a lot of diff for no behaviour and one place to get it wrong. Absent
   * means 798kg, and `probe:handling`, `probe:turnin` and `validate:physics` all
   * report byte-identical numbers across this change.
   */
  massMult?: number;
  /** Scales tire wear — a car that is kind to its tires can run longer stints. */
  tireWearMult: number;
  /** Reliability: probability per race distance of a terminal failure. */
  failureRate: number;
  /** Base pit crew stationary time, seconds. */
  pitCrewTimeS: number;
  /** Scales ERS deployment efficiency. */
  ersMult: number;
}

/** Applies a team's performance deltas to the base spec, producing a new spec. */
export function specForTeam(perf: TeamPerformance, base: VehicleSpec = BASE_F1_SPEC): VehicleSpec {
  return {
    ...base,
    dryMassKg: base.dryMassKg * (perf.massMult ?? 1),
    icePowerW: base.icePowerW * perf.powerMult,
    ersPowerW: base.ersPowerW * perf.ersMult,
    clBase: base.clBase * perf.downforceMult,
    cdBase: base.cdBase * perf.dragMult,
    baseMu: base.baseMu * perf.mechanicalGripMult,
  };
}

/**
 * Setup choices the player and AI make per circuit.
 * These trade off against each other the way real setup does.
 */
export interface CarSetup {
  /** 0 = Monza skinny wing, 1 = Monaco maximum. Raises cl and cd together. */
  downforceLevel: number;
  /** Aero balance shift, -1 rearward (stable) .. +1 forward (pointy). */
  aeroBalance: number;
  /**
   * Anti-roll bar balance, -1 stiff rear .. +1 stiff front.
   *
   * The mechanical counterpart to aero balance, and the reason a car can be
   * pointy in slow corners and stable in fast ones or the other way round. In a
   * real car this is roll stiffness deciding how lateral load transfer is split
   * between the axles; a stiffer axle transfers more load, and because tire
   * grip is sub-linear in load, the axle that transfers more loses more grip.
   * So a stiff FRONT bar means understeer. This model has no per-wheel loads,
   * so the effect is applied where it actually shows up: the axle's cornering
   * stiffness.
   */
  suspensionBalance: number;
  /** Brake bias, front fraction. */
  brakeBias: number;
  /** Differential lock, 0 open .. 1 locked. Affects corner-exit traction. */
  diffLock: number;
  /** Starting fuel load, litres. */
  fuelLoadL: number;
  /** Gear ratio spread, 0 short (acceleration) .. 1 long (top speed). */
  gearing: number;
}

export const DEFAULT_SETUP: CarSetup = {
  downforceLevel: 0.5,
  aeroBalance: 0,
  suspensionBalance: 0,
  brakeBias: 0.64,
  diffLock: 0.5,
  fuelLoadL: 100,
  gearing: 0.5,
};

/** A sensible setup for a circuit, given its downforce demand. */
export function baselineSetupFor(downforceDemand: number, fuelL: number): CarSetup {
  return {
    downforceLevel: downforceDemand,
    aeroBalance: 0,
    suspensionBalance: 0,
    brakeBias: 0.64,
    diffLock: 0.5,
    fuelLoadL: fuelL,
    // Long gearing where there are long straights.
    gearing: 1 - downforceDemand * 0.7,
  };
}

/** Applies a setup to a spec, returning the effective values used by the sim. */
export function applySetup(spec: VehicleSpec, setup: CarSetup): VehicleSpec {
  // Downforce and drag rise together — that is the entire trade-off. Going from
  // minimum to maximum wing roughly doubles downforce and adds ~70% drag.
  const dfScale = 0.62 + setup.downforceLevel * 0.76;
  const dragScale = 0.72 + setup.downforceLevel * 0.66;
  const gearScale = 0.92 + setup.gearing * 0.16;

  // Roll stiffness: the stiffer axle transfers more lateral load and, because
  // grip is sub-linear in load, ends up with less of it. Applied to cornering
  // stiffness, which is the axle's grip per degree of slip.
  const rollFront = 1 - setup.suspensionBalance * 0.09;
  const rollRear = 1 + setup.suspensionBalance * 0.09;

  // A locked differential ties the rear wheels together, so the outside wheel
  // is dragged and the inside driven: the axle generates a yaw moment that
  // OPPOSES the turn. That is stability on corner exit and understeer on entry,
  // and it is why a driver unlocks the diff for a tight, slow circuit. Centred
  // on the half-locked default so the baseline car is the tuned one.
  const diffStabilise = 1 + (setup.diffLock - 0.5) * 0.12;

  return {
    ...spec,
    clBase: spec.clBase * dfScale,
    cdBase: spec.cdBase * dragScale,
    aeroBalanceFront: spec.aeroBalanceFront + setup.aeroBalance * 0.04,
    corneringStiffnessFront: spec.corneringStiffnessFront * rollFront,
    corneringStiffnessRear: spec.corneringStiffnessRear * rollRear * diffStabilise,
    brakeBalanceFront: setup.brakeBias,
    gearRatios: spec.gearRatios.map((r) => r / gearScale),
  };
}
