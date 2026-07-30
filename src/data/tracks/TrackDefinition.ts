/**
 * Circuit data model.
 *
 * Control points are authored in approximate metres and then uniformly scaled by
 * TrackSpline so the sampled spline length equals `lengthM`. That means the
 * authored shape only has to be right in *proportion* — the absolute corner
 * radii, and therefore the corner speeds and lap times, come out of the
 * normalisation. A track whose layout is proportionally correct will produce
 * realistic lap times without per-track fudging.
 *
 * Everything measured in `s` is distance in metres from the start/finish line,
 * in the direction of travel.
 */

export interface DrsZone {
  /** Where the gap to the car ahead is measured. */
  detectionS: number;
  /** Where the wing may be opened. */
  startS: number;
  /** Where it is forced shut. */
  endS: number;
}

export interface WidthOverride {
  startS: number;
  endS: number;
  widthM: number;
}

export interface CurbOverride {
  startS: number;
  endS: number;
  side: 'left' | 'right' | 'both';
}

export interface BankingSegment {
  startS: number;
  endS: number;
  /** Positive banks the left edge up (i.e. supports a right-hand turn). */
  degrees: number;
}

export interface ElevationPoint {
  s: number;
  /** Metres relative to the start/finish line. */
  y: number;
}

export interface CornerMarker {
  s: number;
  name: string;
}

/**
 * The pit lane is modelled as a distance range on the main spline plus a lateral
 * offset, rather than as a separate spline. It costs one branch in the physics
 * step instead of a whole second geometry pipeline, and for a sim where the pit
 * lane is a speed-limited straight that is a completely faithful model.
 */
export interface PitLane {
  entryS: number;
  exitS: number;
  /** Lateral offset of the pit lane centre from the track centreline, +left. */
  lateralOffsetM: number;
  /** Where the car actually stops, distance along the lap. */
  boxS: number;
  /** Regulation limit inside the pit lane, km/h. */
  speedLimitKph: number;
  /** Time lost vs staying out, excluding the stationary time. Seconds. */
  transitLossS: number;
}

export interface TrackDefinition {
  id: string;
  name: string;
  /** Official circuit name, for the UI. */
  officialName: string;
  country: string;
  countryCode: string;
  city: string;
  /** Official lap distance, metres. */
  lengthM: number;
  /** Grand Prix distance in laps. */
  raceLaps: number;
  /** Direction: most circuits are clockwise. Affects nothing but flavour text. */
  clockwise: boolean;

  /** Packed [x0,z0, x1,z1, ...] control points, closed loop. */
  controlPoints: readonly number[];

  defaultWidthM: number;
  sector1EndS: number;
  sector2EndS: number;

  drsZones: readonly DrsZone[];
  pitLane: PitLane;

  corners?: readonly CornerMarker[];
  widthOverrides?: readonly WidthOverride[];
  curbOverrides?: readonly CurbOverride[];
  bankingSegments?: readonly BankingSegment[];
  elevationPoints?: readonly ElevationPoint[];

  /** Baseline ambient/track temperatures in °C for this venue. */
  baseAirTempC: number;
  baseTrackTempC: number;
  /** Probability per session of rain appearing. 0..1. */
  rainChance: number;
  /** How abrasive the surface is; scales tire wear. 1.0 = neutral. */
  surfaceAbrasion: number;
  /** How much slower a lap is in dirty air here. Higher = harder to follow. */
  dirtyAirSensitivity: number;
  /** Downforce level teams run here, 0 (Monza) .. 1 (Monaco). Flavour + setup. */
  downforceDemand: number;
  /** Real pole time in seconds, for validating the solver. Not used in sim. */
  referencePoleTimeS: number;
  /** Sky/scenery tint hint for the renderer. */
  ambience: 'day' | 'dusk' | 'night';
  /** Dominant scenery type, drives procedural set dressing. */
  scenery: 'parkland' | 'desert' | 'street' | 'forest' | 'coastal' | 'stadium';
}
