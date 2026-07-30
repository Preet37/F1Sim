/**
 * Tire compound data.
 *
 * Peak grip, wear rate and the optimal temperature window are the three numbers
 * that make compound choice a real strategic decision rather than a menu pick:
 * the soft is genuinely faster, genuinely shorter-lived, and genuinely harder to
 * keep in its window on a hot track.
 */

export type CompoundId = 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet';

export interface TireCompound {
  id: CompoundId;
  /** Short label for the HUD. */
  code: string;
  name: string;
  /** Colour used by the HUD and the tire wall in the render layer. */
  colour: number;

  /** Multiplier on peak lateral/longitudinal grip at optimal temperature. */
  peakGrip: number;
  /**
   * Wear per metre of sliding-equivalent distance, scaled by load and slip.
   * Tuned so a soft gives up around 20 laps at a medium-abrasion circuit.
   */
  wearRate: number;

  /** Bottom of the operating window, °C. */
  optimalTempMinC: number;
  /** Top of the operating window, °C. */
  optimalTempMaxC: number;
  /** How sharply grip falls away outside the window. Higher = peakier. */
  thermalSensitivity: number;

  /**
   * Heat generated per unit of slip power. Softer compounds heat faster, which
   * is why they overheat when you follow another car closely.
   */
  heatingRate: number;
  /** Convective cooling coefficient toward track/air temperature. */
  coolingRate: number;

  /**
   * Grip multiplier as a function of standing water. 1.0 means unaffected.
   * A dry slick on a wet track is the single biggest grip loss in the sim.
   */
  wetGripCurve: readonly [dry: number, damp: number, wet: number];

  /** True for intermediates and full wets — they overheat on a dry track. */
  isWetWeather: boolean;
  /** Laps of warm-up before the compound reaches full grip. */
  warmupLaps: number;
}

export const TIRE_COMPOUNDS: Record<CompoundId, TireCompound> = {
  soft: {
    id: 'soft', code: 'S', name: 'Soft', colour: 0xd0202a,
    peakGrip: 1.05,
    wearRate: 1.55,
    optimalTempMinC: 100, optimalTempMaxC: 115,
    thermalSensitivity: 1.35,
    heatingRate: 1.22, coolingRate: 0.92,
    wetGripCurve: [1.0, 0.72, 0.42],
    isWetWeather: false,
    warmupLaps: 0.4,
  },
  medium: {
    id: 'medium', code: 'M', name: 'Medium', colour: 0xe8c53a,
    peakGrip: 1.0,
    wearRate: 1.0,
    optimalTempMinC: 95, optimalTempMaxC: 110,
    thermalSensitivity: 1.0,
    heatingRate: 1.0, coolingRate: 1.0,
    wetGripCurve: [1.0, 0.74, 0.44],
    isWetWeather: false,
    warmupLaps: 0.7,
  },
  hard: {
    id: 'hard', code: 'H', name: 'Hard', colour: 0xe8e8e8,
    peakGrip: 0.94,
    wearRate: 0.66,
    optimalTempMinC: 90, optimalTempMaxC: 105,
    thermalSensitivity: 0.78,
    heatingRate: 0.84, coolingRate: 1.08,
    wetGripCurve: [1.0, 0.76, 0.46],
    isWetWeather: false,
    warmupLaps: 1.2,
  },
  intermediate: {
    id: 'intermediate', code: 'I', name: 'Intermediate', colour: 0x3ba55d,
    peakGrip: 0.87,
    wearRate: 1.15,
    optimalTempMinC: 60, optimalTempMaxC: 85,
    thermalSensitivity: 1.1,
    heatingRate: 1.05, coolingRate: 1.35,
    // Inters are the fastest tire on a damp track and destroy themselves on a dry one.
    wetGripCurve: [0.86, 1.0, 0.82],
    isWetWeather: true,
    warmupLaps: 0.3,
  },
  wet: {
    id: 'wet', code: 'W', name: 'Full Wet', colour: 0x2f6fd0,
    peakGrip: 0.79,
    wearRate: 1.0,
    optimalTempMinC: 50, optimalTempMaxC: 75,
    thermalSensitivity: 0.95,
    heatingRate: 0.95, coolingRate: 1.6,
    wetGripCurve: [0.72, 0.9, 1.0],
    isWetWeather: true,
    warmupLaps: 0.3,
  },
};

/** The three dry compounds, in the order the HUD and strategy screens show them. */
export const DRY_COMPOUNDS: readonly CompoundId[] = ['soft', 'medium', 'hard'];
export const WET_COMPOUNDS: readonly CompoundId[] = ['intermediate', 'wet'];

export function getCompound(id: CompoundId): TireCompound {
  return TIRE_COMPOUNDS[id];
}

/** True when using this compound would satisfy the two-compound rule. */
export function isDryCompound(id: CompoundId): boolean {
  return id === 'soft' || id === 'medium' || id === 'hard';
}
