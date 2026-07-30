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
  // Matched to the 45% static front weight split. At racing speed downforce
  // dwarfs the car's own weight, so this number — not the mass distribution —
  // decides how much load the front axle actually has. Setting it BELOW the
  // mechanical split meant the aero platform was fighting the chassis: in a
  // steady turn a bicycle model needs the front to supply 45% of the cornering
  // force, but it only had 44% of the load to do it with, so the front ran out
  // first everywhere. 0.455 is still inside the real 44-46% window.
  aeroBalanceFront: 0.455,
  cdBase: 0.82,
  drsDragReduction: 0.22,
  drsDownforceLoss: 0.16,

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
  brakeBalanceFront: 0.58,
  maxBrakeForceN: 38_000,

  peakFuelBurnLps: 0.048,

  batteryCapacityJ: 4_000_000,
  maxHarvestW: 200_000,
};

/**
 * Per-team performance deltas. Each field multiplies the base spec.
 * A value of 1.0 is the reference car.
 */
export interface TeamPerformance {
  powerMult: number;
  downforceMult: number;
  dragMult: number;
  mechanicalGripMult: number;
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
  brakeBias: 0.58,
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
    brakeBias: 0.58,
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
