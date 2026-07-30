import type { TrackDefinition } from './TrackDefinition';
import { buildLayout, str, left, right, type Segment } from './SegmentBuilder';
import { REAL_GEOMETRY } from './realGeometry';

/**
 * Whether to drive on the surveyed circuit shapes rather than the authored ones.
 *
 * OFF by default, and that is a deliberate, temporary state — the real geometry
 * is correct and the conversion is verified (every circuit's traced length lands
 * within 0.3% of its published figure), but the SPEED SOLVER is not yet
 * calibrated for it.
 *
 * The authored layouts were built by choosing corner radii that made the solved
 * lap times match real pole times, so the solver's parameters silently absorbed
 * whatever those layouts got wrong. Swapping in the true centrelines removes
 * that compensation and the solved laps come out 14% slow — not because the
 * shapes are wrong, but because the car model and the track width profile were
 * tuned against the old ones.
 *
 * Turning this on before recalibrating would make every circuit's lap times
 * wrong, so it stays off until `scripts/calibrateSolver.ts` has been re-run
 * against the real shapes and the width profiles have been widened to the real
 * 12-15m. Flip it here to compare:  npm run validate:tracks
 */
const USE_REAL_GEOMETRY = false;

/**
 * Circuit library.
 *
 * The centreline geometry comes from real surveyed traces — see
 * `src/data/tracks/realGeometry.ts`, generated from the GeoJSON in
 * `data/circuits/`. Corner radii, straight lengths and the shape of the lap are
 * therefore the real ones, not a reconstruction.
 *
 * The segment list below is still authored, and still matters: it supplies
 * everything keyed by distance around the lap rather than by position in space
 * — corner names, DRS zones, track width, elevation and banking. Those are
 * expressed as fractions of the lap, so they map onto the real centreline
 * directly.
 *
 * `referencePoleTimeS` is the real-world pole time. It is never used by the sim;
 * it exists so `npm run validate:tracks` can print solved-vs-real lap time and
 * flag a layout whose radii have drifted.
 */

interface CircuitSpec {
  meta: Omit<TrackDefinition, 'controlPoints' | 'corners' | 'drsZones' | 'widthOverrides'>;
  segments: Segment[];
  /**
   * Turning number of the closed centreline: +1 clockwise, -1 anticlockwise,
   * and 0 for a figure-eight, where the two lobes turn opposite ways and
   * cancel. Suzuka is the only figure-eight on the calendar.
   */
  turningNumber: -1 | 0 | 1;
  /** Detection point for each DRS zone, as metres *before* the zone start. */
  drsDetectionOffsets?: number[];
}

// ===========================================================================
// Autodromo Nazionale Monza — the Temple of Speed
// ===========================================================================
const MONZA: CircuitSpec = {
  meta: {
    id: 'monza',
    name: 'Monza',
    officialName: 'Autodromo Nazionale Monza',
    country: 'Italy',
    countryCode: 'IT',
    city: 'Monza',
    lengthM: 5793,
    raceLaps: 53,
    clockwise: true,
    defaultWidthM: 15,
    sector1EndS: 1900,
    sector2EndS: 3900,
    pitLane: {
      entryS: 5400, exitS: 420, lateralOffsetM: -16,
      boxS: 5650, speedLimitKph: 80, transitLossS: 8.4,
    },
    baseAirTempC: 26, baseTrackTempC: 40,
    rainChance: 0.14, surfaceAbrasion: 0.86,
    dirtyAirSensitivity: 0.55, downforceDemand: 0.12,
    referencePoleTimeS: 79.0,
    ambience: 'day', scenery: 'parkland',
    elevationPoints: [
      { s: 0, y: 0 }, { s: 1400, y: 4 }, { s: 2600, y: 9 },
      { s: 3800, y: 5 }, { s: 4900, y: 1 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(1100, { drs: true, name: 'Rettifilo Tribune' }),
    right(60, 28, 'Variante del Rettifilo'),
    str(22),
    left(55, 32),
    str(65),
    right(95, 330, 'Curva Grande'),
    str(330),
    left(55, 42, 'Variante della Roggia'),
    str(22),
    right(50, 46),
    str(245),
    right(85, 88, 'Curva di Lesmo 1'),
    str(195),
    right(75, 78, 'Curva di Lesmo 2'),
    str(780, { drs: true, name: 'Curva del Serraglio' }),
    left(50, 95, 'Variante Ascari'),
    str(25),
    right(60, 72),
    str(25),
    left(45, 115),
    str(650),
    right(140, 190, 'Curva Parabolica'),
    str(700),
  ],
};

// ===========================================================================
// Circuit de Spa-Francorchamps
// ===========================================================================
const SPA: CircuitSpec = {
  meta: {
    id: 'spa',
    name: 'Spa',
    officialName: 'Circuit de Spa-Francorchamps',
    country: 'Belgium',
    countryCode: 'BE',
    city: 'Stavelot',
    lengthM: 7004,
    raceLaps: 44,
    clockwise: true,
    defaultWidthM: 14,
    sector1EndS: 2100,
    sector2EndS: 4900,
    pitLane: {
      entryS: 6650, exitS: 380, lateralOffsetM: -15,
      boxS: 6870, speedLimitKph: 80, transitLossS: 9.1,
    },
    baseAirTempC: 18, baseTrackTempC: 28,
    rainChance: 0.42, surfaceAbrasion: 0.95,
    dirtyAirSensitivity: 0.5, downforceDemand: 0.3,
    referencePoleTimeS: 103.6,
    ambience: 'day', scenery: 'forest',
    // The real elevation change at Spa is about 100m; Eau Rouge alone climbs ~40m.
    elevationPoints: [
      { s: 0, y: 30 }, { s: 400, y: 8 }, { s: 700, y: 12 },
      { s: 1000, y: 48 }, { s: 1900, y: 58 }, { s: 2600, y: 44 },
      { s: 3400, y: 22 }, { s: 4200, y: 10 }, { s: 5000, y: 6 },
      { s: 5900, y: 16 }, { s: 6500, y: 28 },
    ],
    bankingSegments: [{ startS: 900, endS: 1050, degrees: 4 }],
  },
  turningNumber: 1,
  segments: [
    str(300, { name: 'Start straight' }),
    right(190, 26, 'La Source'),
    str(200),
    left(35, 130, 'Eau Rouge'),
    right(60, 150, 'Raidillon'),
    left(30, 300),
    str(1100, { drs: true, name: 'Kemmel Straight' }),
    right(80, 55, 'Les Combes'),
    left(70, 60),
    str(90),
    left(35, 100, 'Malmedy'),
    str(150),
    right(175, 45, 'Bruxelles'),
    str(300),
    left(80, 140, 'Pouhon'),
    str(300),
    right(70, 65, 'Fagnes'),
    left(60, 70),
    str(300),
    right(65, 90, 'Campus'),
    left(40, 120),
    str(250),
    right(105, 55, 'Stavelot'),
    str(900, { drs: true }),
    left(30, 400, 'Blanchimont'),
    str(500),
    right(80, 25, 'Bus Stop Chicane'),
    str(30),
    left(85, 28),
    str(260),
  ],
};

// ===========================================================================
// Silverstone Circuit
// ===========================================================================
const SILVERSTONE: CircuitSpec = {
  meta: {
    id: 'silverstone',
    name: 'Silverstone',
    officialName: 'Silverstone Circuit',
    country: 'United Kingdom',
    countryCode: 'GB',
    city: 'Silverstone',
    lengthM: 5891,
    raceLaps: 52,
    clockwise: true,
    defaultWidthM: 15,
    sector1EndS: 1900,
    sector2EndS: 3950,
    pitLane: {
      entryS: 5500, exitS: 400, lateralOffsetM: -16,
      boxS: 5720, speedLimitKph: 80, transitLossS: 8.7,
    },
    baseAirTempC: 19, baseTrackTempC: 29,
    rainChance: 0.38, surfaceAbrasion: 1.06,
    dirtyAirSensitivity: 0.62, downforceDemand: 0.55,
    referencePoleTimeS: 85.8,
    ambience: 'day', scenery: 'parkland',
    elevationPoints: [
      { s: 0, y: 0 }, { s: 1200, y: 5 }, { s: 2600, y: 2 },
      { s: 4000, y: 7 }, { s: 5200, y: 3 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(420, { drs: true, name: 'Hamilton Straight' }),
    right(95, 45, 'Abbey'),
    str(60),
    left(50, 130, 'Farm Curve'),
    str(180),
    right(130, 35, 'Village'),
    str(70),
    left(75, 60, 'The Loop'),
    str(180),
    left(40, 220, 'Aintree'),
    str(760, { drs: true, name: 'Wellington Straight' }),
    right(105, 40, 'Brooklands'),
    str(90),
    right(75, 95, 'Luffield'),
    str(60),
    left(55, 130, 'Woodcote'),
    str(560, { drs: true, name: 'National Straight' }),
    right(70, 180, 'Copse'),
    str(200),
    left(55, 210, 'Maggotts'),
    right(60, 180, 'Becketts'),
    left(60, 90, 'Chapel'),
    str(680, { name: 'Hangar Straight' }),
    right(90, 95, 'Stowe'),
    str(320),
    left(50, 60, 'Vale'),
    str(60),
    right(115, 55, 'Club'),
    str(340),
  ],
};

// ===========================================================================
// Circuit de Monaco
// ===========================================================================
const MONACO: CircuitSpec = {
  meta: {
    id: 'monaco',
    name: 'Monaco',
    officialName: 'Circuit de Monaco',
    country: 'Monaco',
    countryCode: 'MC',
    city: 'Monte Carlo',
    lengthM: 3337,
    raceLaps: 78,
    clockwise: true,
    defaultWidthM: 10,
    sector1EndS: 1050,
    sector2EndS: 2250,
    pitLane: {
      entryS: 3130, exitS: 240, lateralOffsetM: -12,
      boxS: 3240, speedLimitKph: 60, transitLossS: 10.8,
    },
    baseAirTempC: 22, baseTrackTempC: 34,
    rainChance: 0.2, surfaceAbrasion: 0.72,
    // Monaco's real signature: overtaking is essentially impossible.
    dirtyAirSensitivity: 0.95, downforceDemand: 1.0,
    referencePoleTimeS: 70.3,
    ambience: 'day', scenery: 'street',
    elevationPoints: [
      { s: 0, y: 0 }, { s: 260, y: 4 }, { s: 620, y: 32 },
      { s: 900, y: 34 }, { s: 1150, y: 12 }, { s: 1500, y: 2 },
      { s: 2400, y: 3 }, { s: 3100, y: 1 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(200, { drs: true, name: 'Boulevard Albert 1er' }),
    right(70, 24, 'Sainte Devote'),
    str(300, { name: 'Beau Rivage' }),
    left(110, 60, 'Massenet'),
    str(60),
    right(65, 40, 'Casino'),
    str(120),
    right(60, 30, 'Mirabeau Haute'),
    str(70),
    right(175, 11, 'Grand Hotel Hairpin'),
    str(80),
    right(55, 35, 'Mirabeau Bas'),
    str(60),
    right(60, 45, 'Portier'),
    str(420, { name: 'Tunnel' }),
    left(30, 350),
    str(180),
    right(70, 22, 'Nouvelle Chicane'),
    str(35),
    left(90, 26),
    str(190),
    left(105, 55, 'Tabac'),
    str(90),
    left(95, 45, 'Piscine Entry'),
    str(40),
    right(70, 40),
    str(70),
    right(80, 25, 'Piscine Exit'),
    str(35),
    left(100, 22),
    str(80),
    right(150, 14, 'La Rascasse'),
    str(90),
    right(35, 40, 'Anthony Noghes'),
    str(120),
  ],
};

// ===========================================================================
// Suzuka International Racing Course
// ===========================================================================
const SUZUKA: CircuitSpec = {
  meta: {
    id: 'suzuka',
    name: 'Suzuka',
    officialName: 'Suzuka International Racing Course',
    country: 'Japan',
    countryCode: 'JP',
    city: 'Suzuka',
    lengthM: 5807,
    raceLaps: 53,
    clockwise: true,
    defaultWidthM: 14,
    sector1EndS: 1850,
    sector2EndS: 4100,
    pitLane: {
      entryS: 5430, exitS: 400, lateralOffsetM: -15,
      boxS: 5650, speedLimitKph: 80, transitLossS: 8.9,
    },
    baseAirTempC: 21, baseTrackTempC: 32,
    rainChance: 0.35, surfaceAbrasion: 1.02,
    dirtyAirSensitivity: 0.7, downforceDemand: 0.7,
    referencePoleTimeS: 88.2,
    ambience: 'day', scenery: 'parkland',
    // Suzuka is a figure-of-eight: the Degners section crosses under the
    // back straight. The crossover is a bridge, so the loop stays planar here
    // and the elevation profile carries the height difference.
    elevationPoints: [
      { s: 0, y: 4 }, { s: 900, y: 20 }, { s: 1700, y: 26 },
      { s: 2400, y: 14 }, { s: 3100, y: 2 }, { s: 4000, y: 8 },
      { s: 4900, y: 16 }, { s: 5500, y: 8 },
    ],
  },
  turningNumber: 0,
  segments: [
    str(450, { drs: true, name: 'Main Straight' }),
    right(85, 85, 'Turn 1'),
    right(55, 130, 'Turn 2'),
    str(120),
    left(60, 110, 'S Curves 1'),
    right(65, 95, 'S Curves 2'),
    left(70, 100, 'S Curves 3'),
    right(60, 90, 'S Curves 4'),
    str(90),
    left(80, 75, 'Dunlop Curve'),
    str(200),
    right(80, 55, 'Degner 1'),
    str(90),
    right(95, 30, 'Degner 2'),
    str(280),
    left(150, 28, 'Hairpin'),
    str(340),
    left(50, 200, 'Spoon Entry'),
    left(95, 70, 'Spoon Exit'),
    str(1000, { drs: true, name: 'Back Straight' }),
    left(25, 500, '130R'),
    str(280),
    right(95, 32, 'Casio Triangle'),
    str(35),
    left(70, 45),
    str(220),
    right(60, 400, 'Final Curve'),
    str(200),
  ],
};

// ===========================================================================
// Autodromo Jose Carlos Pace (Interlagos)
// ===========================================================================
const INTERLAGOS: CircuitSpec = {
  meta: {
    id: 'interlagos',
    name: 'Interlagos',
    officialName: 'Autodromo Jose Carlos Pace',
    country: 'Brazil',
    countryCode: 'BR',
    city: 'Sao Paulo',
    lengthM: 4309,
    raceLaps: 71,
    clockwise: false,
    defaultWidthM: 13,
    sector1EndS: 1400,
    sector2EndS: 2900,
    pitLane: {
      entryS: 4000, exitS: 300, lateralOffsetM: 14,
      boxS: 4150, speedLimitKph: 80, transitLossS: 8.2,
    },
    baseAirTempC: 24, baseTrackTempC: 38,
    rainChance: 0.45, surfaceAbrasion: 1.12,
    dirtyAirSensitivity: 0.52, downforceDemand: 0.6,
    referencePoleTimeS: 68.8,
    ambience: 'day', scenery: 'stadium',
    elevationPoints: [
      { s: 0, y: 22 }, { s: 400, y: 6 }, { s: 1100, y: 2 },
      { s: 1900, y: 8 }, { s: 2600, y: 14 }, { s: 3300, y: 4 },
      { s: 3900, y: 14 },
    ],
  },
  turningNumber: -1,
  segments: [
    str(300, { drs: true, name: 'Reta Oposta approach' }),
    left(80, 40, 'Senna S — Turn 1'),
    str(70),
    left(40, 90, 'Curva do Sol'),
    str(700, { drs: true, name: 'Reta Oposta' }),
    left(70, 45, 'Descida do Lago'),
    str(60),
    right(55, 120, 'Turn 5'),
    str(240),
    left(40, 55, 'Ferradura'),
    str(120),
    left(25, 150, 'Laranja'),
    str(100),
    left(60, 40, 'Pinheirinho'),
    str(150),
    right(60, 55, 'Bico de Pato'),
    str(90),
    left(30, 45, 'Mergulho'),
    str(280),
    left(80, 55, 'Juncao'),
    str(200),
    left(20, 180, 'Subida dos Boxes'),
    str(150),
    left(25, 220, 'Arquibancadas'),
    str(320),
  ],
};

// ===========================================================================
// Bahrain International Circuit
// ===========================================================================
const BAHRAIN: CircuitSpec = {
  meta: {
    id: 'bahrain',
    name: 'Bahrain',
    officialName: 'Bahrain International Circuit',
    country: 'Bahrain',
    countryCode: 'BH',
    city: 'Sakhir',
    lengthM: 5412,
    raceLaps: 57,
    clockwise: true,
    defaultWidthM: 15,
    sector1EndS: 1750,
    sector2EndS: 3700,
    pitLane: {
      entryS: 5050, exitS: 400, lateralOffsetM: -16,
      boxS: 5230, speedLimitKph: 80, transitLossS: 8.6,
    },
    baseAirTempC: 27, baseTrackTempC: 33,
    rainChance: 0.02, surfaceAbrasion: 1.28,
    dirtyAirSensitivity: 0.45, downforceDemand: 0.5,
    referencePoleTimeS: 89.2,
    ambience: 'night', scenery: 'desert',
    elevationPoints: [
      { s: 0, y: 0 }, { s: 1200, y: 6 }, { s: 2600, y: 3 },
      { s: 4000, y: 5 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(700, { drs: true, name: 'Main Straight' }),
    right(110, 40, 'Turn 1'),
    str(180),
    left(55, 90, 'Turn 2'),
    right(45, 110, 'Turn 3'),
    str(620, { drs: true }),
    right(95, 45, 'Turn 4'),
    str(120),
    left(60, 75, 'Turn 5'),
    str(70),
    left(50, 95, 'Turn 6'),
    str(230),
    right(80, 55, 'Turn 8'),
    str(90),
    right(70, 70, 'Turn 9'),
    str(190),
    left(105, 42, 'Turn 10'),
    str(560, { drs: true }),
    right(85, 50, 'Turn 11'),
    str(80),
    right(60, 85, 'Turn 12'),
    str(140),
    right(75, 60, 'Turn 13'),
    str(110),
    left(50, 130, 'Turn 14'),
    str(240),
    right(55, 150, 'Turn 15'),
    str(320),
  ],
};

// ===========================================================================
// Circuit Zandvoort
// ===========================================================================
const ZANDVOORT: CircuitSpec = {
  meta: {
    id: 'zandvoort',
    name: 'Zandvoort',
    officialName: 'Circuit Zandvoort',
    country: 'Netherlands',
    countryCode: 'NL',
    city: 'Zandvoort',
    lengthM: 4259,
    raceLaps: 72,
    clockwise: true,
    defaultWidthM: 12,
    sector1EndS: 1400,
    sector2EndS: 2900,
    pitLane: {
      entryS: 3980, exitS: 320, lateralOffsetM: -13,
      boxS: 4120, speedLimitKph: 80, transitLossS: 9.4,
    },
    baseAirTempC: 18, baseTrackTempC: 27,
    rainChance: 0.34, surfaceAbrasion: 1.15,
    dirtyAirSensitivity: 0.88, downforceDemand: 0.85,
    referencePoleTimeS: 69.9,
    ambience: 'day', scenery: 'coastal',
    elevationPoints: [
      { s: 0, y: 4 }, { s: 700, y: 14 }, { s: 1500, y: 20 },
      { s: 2300, y: 10 }, { s: 3100, y: 6 }, { s: 3800, y: 16 },
    ],
    // Zandvoort's two banked corners are its signature: Hugenholtzbocht (T3)
    // and the final Arie Luyendykbocht, both around 18 degrees.
    bankingSegments: [
      { startS: 640, endS: 800, degrees: 18 },
      { startS: 3900, endS: 4200, degrees: 18 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(280, { drs: true, name: 'Start Straight' }),
    right(85, 38, 'Tarzanbocht'),
    str(140),
    left(45, 70, 'Gerlachbocht'),
    right(150, 30, 'Hugenholtzbocht'),
    str(300),
    right(55, 90, 'Hunserug'),
    str(120),
    left(50, 55, 'Rob Slotemakerbocht'),
    str(90),
    right(65, 60, 'Scheivlak'),
    str(180),
    left(60, 45, 'Mastersbocht'),
    str(110),
    right(60, 70, 'Turn 9'),
    str(90),
    left(60, 40, 'Turn 10'),
    str(140),
    right(90, 35, 'Hans Ernst 1'),
    str(60),
    left(55, 50, 'Hans Ernst 2'),
    str(180),
    right(65, 55, 'Kumho'),
    str(330),
    left(45, 80, 'Arie Luyendyk entry'),
    right(120, 55, 'Arie Luyendykbocht', { drs: true }),
    str(300, { drs: true }),
  ],
};

// ===========================================================================
// Circuit of the Americas
// ===========================================================================
const COTA: CircuitSpec = {
  meta: {
    id: 'cota',
    name: 'Austin',
    officialName: 'Circuit of the Americas',
    country: 'United States',
    countryCode: 'US',
    city: 'Austin',
    lengthM: 5513,
    raceLaps: 56,
    clockwise: false,
    defaultWidthM: 15,
    sector1EndS: 1800,
    sector2EndS: 3800,
    pitLane: {
      entryS: 5150, exitS: 400, lateralOffsetM: 16,
      boxS: 5320, speedLimitKph: 80, transitLossS: 8.8,
    },
    baseAirTempC: 25, baseTrackTempC: 36,
    rainChance: 0.22, surfaceAbrasion: 1.08,
    dirtyAirSensitivity: 0.58, downforceDemand: 0.65,
    referencePoleTimeS: 92.5,
    ambience: 'day', scenery: 'parkland',
    // Turn 1 at COTA climbs about 40m from the grid — the steepest on the calendar.
    elevationPoints: [
      { s: 0, y: 2 }, { s: 380, y: 40 }, { s: 900, y: 26 },
      { s: 1800, y: 18 }, { s: 2700, y: 12 }, { s: 3600, y: 24 },
      { s: 4600, y: 14 }, { s: 5200, y: 4 },
    ],
  },
  turningNumber: -1,
  segments: [
    str(1000, { drs: true, name: 'Main Straight' }),
    left(135, 42, 'Turn 1'),
    str(120),
    right(65, 85, 'Turn 2'),
    left(70, 75, 'Turn 3'),
    right(75, 70, 'Turn 4'),
    left(70, 80, 'Turn 5'),
    right(65, 85, 'Turn 6'),
    left(60, 90, 'Turn 7'),
    str(120),
    right(85, 60, 'Turn 8'),
    str(90),
    left(55, 110, 'Turn 9'),
    str(120),
    left(110, 50, 'Turn 11'),
    str(1000, { drs: true, name: 'Back Straight' }),
    left(120, 45, 'Turn 12'),
    str(150),
    right(80, 55, 'Turn 13'),
    str(90),
    left(60, 90, 'Turn 14'),
    str(180),
    right(75, 65, 'Turn 15'),
    str(80),
    left(105, 60, 'Turn 16'),
    left(60, 90, 'Turn 17'),
    str(90),
    right(70, 70, 'Turn 18'),
    right(55, 100, 'Turn 19'),
    str(120),
    left(85, 45, 'Turn 20'),
    str(300),
  ],
};

// ===========================================================================
// Jeddah Corniche Circuit
// ===========================================================================
const JEDDAH: CircuitSpec = {
  meta: {
    id: 'jeddah',
    name: 'Jeddah',
    officialName: 'Jeddah Corniche Circuit',
    country: 'Saudi Arabia',
    countryCode: 'SA',
    city: 'Jeddah',
    lengthM: 6174,
    raceLaps: 50,
    clockwise: false,
    defaultWidthM: 12,
    sector1EndS: 2000,
    sector2EndS: 4200,
    pitLane: {
      entryS: 5800, exitS: 380, lateralOffsetM: 13,
      boxS: 5960, speedLimitKph: 80, transitLossS: 8.5,
    },
    baseAirTempC: 29, baseTrackTempC: 34,
    rainChance: 0.01, surfaceAbrasion: 0.82,
    dirtyAirSensitivity: 0.4, downforceDemand: 0.28,
    referencePoleTimeS: 87.5,
    ambience: 'night', scenery: 'street',
    elevationPoints: [{ s: 0, y: 0 }, { s: 3000, y: 3 }],
  },
  turningNumber: -1,
  segments: [
    str(800, { drs: true, name: 'Main Straight' }),
    left(80, 45, 'Turn 1'),
    str(90),
    right(60, 90, 'Turn 2'),
    left(50, 80, 'Turn 3'),
    str(240),
    left(30, 220, 'Turn 4'),
    str(160),
    right(50, 190, 'Turn 6'),
    str(140),
    left(40, 170, 'Turn 8'),
    str(200),
    right(60, 150, 'Turn 10'),
    str(420, { drs: true }),
    left(65, 60, 'Turn 11'),
    str(120),
    left(35, 180, 'Turn 12'),
    right(55, 200, 'Turn 13', { drs: true }),
    str(560, { drs: true }),
    left(50, 130, 'Turn 14'),
    left(30, 300, 'Turn 15'),
    str(180),
    right(60, 160, 'Turn 16'),
    str(140),
    left(45, 140, 'Turn 18'),
    str(120),
    right(55, 170, 'Turn 20'),
    str(200),
    left(70, 55, 'Turn 22'),
    str(160),
    left(45, 130, 'Turn 24'),
    str(120),
    left(50, 110, 'Turn 26'),
    str(200),
    left(75, 65, 'Turn 27'),
    str(420),
  ],
};

// ===========================================================================
// Red Bull Ring
// ===========================================================================
const RED_BULL_RING: CircuitSpec = {
  meta: {
    id: 'redbullring',
    name: 'Red Bull Ring',
    officialName: 'Red Bull Ring',
    country: 'Austria',
    countryCode: 'AT',
    city: 'Spielberg',
    lengthM: 4318,
    raceLaps: 71,
    clockwise: true,
    defaultWidthM: 14,
    sector1EndS: 1400,
    sector2EndS: 2900,
    pitLane: {
      entryS: 4000, exitS: 320, lateralOffsetM: -15,
      boxS: 4140, speedLimitKph: 80, transitLossS: 8.3,
    },
    baseAirTempC: 21, baseTrackTempC: 33,
    rainChance: 0.3, surfaceAbrasion: 0.98,
    dirtyAirSensitivity: 0.48, downforceDemand: 0.4,
    referencePoleTimeS: 63.7,
    ambience: 'day', scenery: 'parkland',
    elevationPoints: [
      { s: 0, y: 6 }, { s: 700, y: 48 }, { s: 1500, y: 40 },
      { s: 2300, y: 22 }, { s: 3100, y: 12 }, { s: 3800, y: 14 },
    ],
  },
  turningNumber: 1,
  segments: [
    str(320, { drs: true, name: 'Start Straight' }),
    right(85, 50, 'Turn 1'),
    str(700, { drs: true, name: 'Uphill Straight' }),
    right(105, 45, 'Remus'),
    str(560, { drs: true }),
    right(90, 55, 'Schlossgold'),
    str(200),
    left(65, 200, 'Turn 4'),
    str(240),
    right(80, 65, 'Turn 5'),
    str(180),
    right(60, 90, 'Rauch'),
    str(120),
    left(80, 110, 'Turn 7'),
    str(160),
    right(70, 70, 'Turn 8'),
    str(140),
    right(85, 60, 'Turn 9'),
    str(280),
    left(75, 150, 'Turn 10'),
    str(240),
  ],
};

// ===========================================================================
// Assembly
// ===========================================================================

const SPECS: CircuitSpec[] = [
  BAHRAIN, JEDDAH, MONACO, SILVERSTONE, RED_BULL_RING,
  SPA, ZANDVOORT, MONZA, SUZUKA, COTA, INTERLAGOS,
];

function materialise(spec: CircuitSpec): TrackDefinition {
  const built = buildLayout(spec.segments, spec.turningNumber, spec.meta.lengthM);

  // The authored segment lengths and the circuit's official length usually
  // differ by a few percent. TrackSpline scales the geometry to match
  // `lengthM`, so distances derived here must be scaled the same way to stay
  // aligned with the final spline.
  const k = spec.meta.lengthM / built.totalLength;

  const drsZones = built.drsRanges.map((r, i) => {
    const startS = r.startS * k;
    const endS = r.endS * k;
    const detectionBack = spec.drsDetectionOffsets?.[i] ?? 220;
    return {
      detectionS: startS - detectionBack,
      // Activation begins a little into the straight, as the real lines do.
      startS: startS + 30,
      endS: endS - 60,
    };
  });

  // Real geometry replaces the authored layout wherever a trace exists.
  //
  // The segment DSL is still what supplies every *distance-keyed* attribute —
  // corner names, DRS zones, width overrides, elevation, banking — and those
  // are all expressed as fractions of the lap, so they carry over onto the real
  // centreline unchanged. What changes is the shape the car actually drives:
  // corner radii, straight lengths and the sequence of direction changes now
  // come from a survey of the real circuit rather than from a reconstruction.
  const real = USE_REAL_GEOMETRY ? REAL_GEOMETRY[spec.meta.id] : undefined;
  const controlPoints: readonly number[] = real ? real.points : Array.from(built.controlPoints);

  return {
    ...spec.meta,
    controlPoints,
    // Kept so scripts/probeCurvature.ts can compare the two side by side.
    authoredControlPoints: Array.from(built.controlPoints),
    corners: built.corners.map((c) => ({ s: c.s * k, name: c.name })),
    drsZones,
    widthOverrides: built.widthRanges.map((w) => ({
      startS: w.startS * k,
      endS: w.endS * k,
      widthM: w.widthM,
    })),
  };
}

/** All circuits, in calendar order. */
export const CIRCUITS: readonly TrackDefinition[] = SPECS.map(materialise);

const BY_ID = new Map<string, TrackDefinition>();
for (const t of CIRCUITS) BY_ID.set(t.id, t);

export function getCircuit(id: string): TrackDefinition {
  const t = BY_ID.get(id);
  if (!t) throw new Error('Unknown circuit: ' + id);
  return t;
}

export function circuitIds(): string[] {
  return CIRCUITS.map((c) => c.id);
}

/** Diagnostics for the validation script. */
export function layoutDiagnostics() {
  return SPECS.map((s) => {
    const b = buildLayout(s.segments, s.turningNumber, s.meta.lengthM);
    return {
      id: s.meta.id,
      closureErrorM: b.closureErrorM,
      rawTurnDeg: b.rawTurnDeg,
      worstAngleChangeDeg: b.worstAngleChangeDeg,
      worstStraightChange: b.worstStraightChange,
      worstRadiusChange: b.worstRadiusChange,
      iterations: b.iterations,
      authoredM: b.totalLength,
      officialM: s.meta.lengthM,
      turningNumber: s.turningNumber,
    };
  });
}
