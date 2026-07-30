import type { TeamPerformance } from '../physics/VehicleSpec';

/**
 * Grid configuration.
 *
 * Team performance is expressed as multipliers on physical quantities, so each
 * car's strengths and weaknesses are real rather than scripted. A team with high
 * power and low drag will beat a high-downforce car at Monza and lose to it at
 * Monaco without any per-circuit special cases — the physics does that.
 *
 * These are fictional teams and drivers with plausible performance spreads,
 * modelled on the shape of a modern grid (two or three cars fighting for wins, a
 * competitive midfield, a couple of teams off the pace). Nothing here uses real
 * team or driver names or any licensed data.
 */

export interface Team {
  id: string;
  name: string;
  shortName: string;
  /** Three-letter code for the timing tower. */
  code: string;
  /** Primary livery colour. */
  colour: number;
  /** Secondary accent colour. */
  accent: number;
  /** Engine supplier — matters for the career's engine-deal storylines. */
  engine: string;
  performance: TeamPerformance;
  /** Budget tier, drives how fast they develop over a season. 0..1. */
  developmentRate: number;
  /** How much the team values experience over raw pace when signing drivers. */
  prefersExperience: number;
}

export interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  /** Three-letter broadcast abbreviation. */
  code: string;
  raceNumber: number;
  nationality: string;
  teamId: string;

  /** Overall pace, 0..1. The single biggest determinant of lap time. */
  skill: number;
  /** Willingness to commit to a move. Feeds the AI's overtake threshold. */
  aggression: number;
  /** Resistance to mistakes under pressure and in changing conditions. */
  consistency: number;
  /** Skill at managing tires and fuel over a stint. */
  tyreManagement: number;
  /** Wet-weather ability, applied on top of skill when the track is damp. */
  wetSkill: number;
  /** Race-craft: defending, positioning, first-lap gains. */
  racecraft: number;
  /** Experience in seasons. Affects career progression and contract value. */
  experience: number;
  /** Age, for career simulation. */
  age: number;
}

export const TEAMS: readonly Team[] = [
  {
    id: 'apex', name: 'Apex Racing', shortName: 'Apex', code: 'APX',
    colour: 0x1b3a8f, accent: 0xe8b52c, engine: 'Apex Power',
    performance: {
      powerMult: 1.035, downforceMult: 1.05, dragMult: 0.965,
      mechanicalGripMult: 1.03, tireWearMult: 0.94,
      failureRate: 0.035, pitCrewTimeS: 2.3, ersMult: 1.03,
    },
    developmentRate: 0.95, prefersExperience: 0.5,
  },
  {
    id: 'scuderia-rosso', name: 'Scuderia Rosso', shortName: 'Rosso', code: 'ROS',
    colour: 0xc8102e, accent: 0xf2e8d5, engine: 'Rosso Corse',
    performance: {
      powerMult: 1.045, downforceMult: 1.015, dragMult: 1.01,
      mechanicalGripMult: 1.01, tireWearMult: 1.06,
      failureRate: 0.055, pitCrewTimeS: 2.5, ersMult: 1.02,
    },
    developmentRate: 0.9, prefersExperience: 0.65,
  },
  {
    id: 'meridian', name: 'Meridian GP', shortName: 'Meridian', code: 'MER',
    colour: 0x00b3a4, accent: 0x1a1a1a, engine: 'Meridian Hybrid',
    performance: {
      powerMult: 1.02, downforceMult: 1.04, dragMult: 0.985,
      mechanicalGripMult: 1.02, tireWearMult: 0.97,
      failureRate: 0.03, pitCrewTimeS: 2.4, ersMult: 1.04,
    },
    developmentRate: 0.92, prefersExperience: 0.55,
  },
  {
    id: 'albion', name: 'Albion Motorsport', shortName: 'Albion', code: 'ALB',
    colour: 0xf07d1a, accent: 0x101820, engine: 'Meridian Hybrid',
    performance: {
      powerMult: 1.01, downforceMult: 1.025, dragMult: 0.99,
      mechanicalGripMult: 1.015, tireWearMult: 0.99,
      failureRate: 0.04, pitCrewTimeS: 2.45, ersMult: 1.0,
    },
    developmentRate: 0.88, prefersExperience: 0.4,
  },
  {
    id: 'aurora', name: 'Aurora Works', shortName: 'Aurora', code: 'AUR',
    colour: 0x2e6b4f, accent: 0xd8ff5a, engine: 'Rosso Corse',
    performance: {
      powerMult: 1.0, downforceMult: 1.0, dragMult: 1.0,
      mechanicalGripMult: 1.0, tireWearMult: 1.0,
      failureRate: 0.045, pitCrewTimeS: 2.6, ersMult: 0.99,
    },
    developmentRate: 0.8, prefersExperience: 0.6,
  },
  {
    id: 'vantage', name: 'Vantage Grand Prix', shortName: 'Vantage', code: 'VAN',
    colour: 0x6b2d8f, accent: 0xf0d8ff, engine: 'Apex Power',
    performance: {
      powerMult: 0.995, downforceMult: 0.985, dragMult: 1.005,
      mechanicalGripMult: 0.99, tireWearMult: 1.03,
      failureRate: 0.05, pitCrewTimeS: 2.7, ersMult: 0.985,
    },
    developmentRate: 0.75, prefersExperience: 0.45,
  },
  {
    id: 'northstar', name: 'Northstar Racing', shortName: 'Northstar', code: 'NOR',
    colour: 0x1a6ec8, accent: 0xffffff, engine: 'Kestrel Racing Engines',
    performance: {
      powerMult: 0.98, downforceMult: 0.99, dragMult: 1.0,
      mechanicalGripMult: 0.985, tireWearMult: 1.02,
      failureRate: 0.06, pitCrewTimeS: 2.65, ersMult: 0.97,
    },
    developmentRate: 0.7, prefersExperience: 0.35,
  },
  {
    id: 'lumen', name: 'Lumen Motorsport', shortName: 'Lumen', code: 'LUM',
    colour: 0x9aa5b1, accent: 0x2b3440, engine: 'Kestrel Racing Engines',
    performance: {
      powerMult: 0.975, downforceMult: 0.975, dragMult: 1.015,
      mechanicalGripMult: 0.975, tireWearMult: 1.05,
      failureRate: 0.07, pitCrewTimeS: 2.8, ersMult: 0.96,
    },
    developmentRate: 0.62, prefersExperience: 0.5,
  },
  {
    id: 'kestrel', name: 'Kestrel Team', shortName: 'Kestrel', code: 'KES',
    colour: 0x0e3b5c, accent: 0x8fd6ff, engine: 'Kestrel Racing Engines',
    performance: {
      powerMult: 0.965, downforceMult: 0.96, dragMult: 1.02,
      mechanicalGripMult: 0.97, tireWearMult: 1.04,
      failureRate: 0.075, pitCrewTimeS: 2.85, ersMult: 0.955,
    },
    developmentRate: 0.55, prefersExperience: 0.3,
  },
  {
    id: 'brava', name: 'Brava Competizione', shortName: 'Brava', code: 'BRA',
    colour: 0x7a1020, accent: 0xd9a545, engine: 'Rosso Corse',
    performance: {
      powerMult: 0.96, downforceMult: 0.95, dragMult: 1.03,
      mechanicalGripMult: 0.96, tireWearMult: 1.08,
      failureRate: 0.085, pitCrewTimeS: 2.95, ersMult: 0.95,
    },
    developmentRate: 0.5, prefersExperience: 0.25,
  },
];

export const DRIVERS: readonly Driver[] = [
  // Apex Racing
  {
    id: 'v-halvorsen', firstName: 'Viktor', lastName: 'Halvorsen', code: 'HAL',
    raceNumber: 1, nationality: 'Norway', teamId: 'apex',
    skill: 0.97, aggression: 0.82, consistency: 0.95, tyreManagement: 0.9,
    wetSkill: 0.93, racecraft: 0.94, experience: 8, age: 28,
  },
  {
    id: 'm-okonkwo', firstName: 'Malik', lastName: 'Okonkwo', code: 'OKO',
    raceNumber: 11, nationality: 'Nigeria', teamId: 'apex',
    skill: 0.9, aggression: 0.74, consistency: 0.89, tyreManagement: 0.92,
    wetSkill: 0.86, racecraft: 0.87, experience: 6, age: 27,
  },

  // Scuderia Rosso
  {
    id: 'l-ferraro', firstName: 'Lorenzo', lastName: 'Ferraro', code: 'FER',
    raceNumber: 16, nationality: 'Italy', teamId: 'scuderia-rosso',
    skill: 0.94, aggression: 0.88, consistency: 0.85, tyreManagement: 0.83,
    wetSkill: 0.91, racecraft: 0.92, experience: 7, age: 27,
  },
  {
    id: 'd-vasquez', firstName: 'Diego', lastName: 'Vasquez', code: 'VAS',
    raceNumber: 55, nationality: 'Spain', teamId: 'scuderia-rosso',
    skill: 0.91, aggression: 0.79, consistency: 0.9, tyreManagement: 0.89,
    wetSkill: 0.85, racecraft: 0.9, experience: 9, age: 30,
  },

  // Meridian GP
  {
    id: 'j-lindqvist', firstName: 'Johan', lastName: 'Lindqvist', code: 'LIN',
    raceNumber: 44, nationality: 'Sweden', teamId: 'meridian',
    skill: 0.95, aggression: 0.71, consistency: 0.96, tyreManagement: 0.95,
    wetSkill: 0.96, racecraft: 0.95, experience: 15, age: 36,
  },
  {
    id: 'a-mbeki', firstName: 'Aiden', lastName: 'Mbeki', code: 'MBE',
    raceNumber: 63, nationality: 'South Africa', teamId: 'meridian',
    skill: 0.92, aggression: 0.76, consistency: 0.91, tyreManagement: 0.88,
    wetSkill: 0.88, racecraft: 0.89, experience: 5, age: 25,
  },

  // Albion Motorsport
  {
    id: 'r-whitfield', firstName: 'Rory', lastName: 'Whitfield', code: 'WHI',
    raceNumber: 4, nationality: 'United Kingdom', teamId: 'albion',
    skill: 0.93, aggression: 0.85, consistency: 0.88, tyreManagement: 0.86,
    wetSkill: 0.89, racecraft: 0.93, experience: 5, age: 24,
  },
  {
    id: 'k-tanaka', firstName: 'Kenji', lastName: 'Tanaka', code: 'TAN',
    raceNumber: 81, nationality: 'Japan', teamId: 'albion',
    skill: 0.89, aggression: 0.8, consistency: 0.87, tyreManagement: 0.85,
    wetSkill: 0.84, racecraft: 0.86, experience: 3, age: 23,
  },

  // Aurora Works
  {
    id: 'f-dubois', firstName: 'Florian', lastName: 'Dubois', code: 'DUB',
    raceNumber: 14, nationality: 'France', teamId: 'aurora',
    skill: 0.9, aggression: 0.73, consistency: 0.92, tyreManagement: 0.93,
    wetSkill: 0.87, racecraft: 0.88, experience: 14, age: 35,
  },
  {
    id: 's-novak', firstName: 'Stefan', lastName: 'Novak', code: 'NOV',
    raceNumber: 18, nationality: 'Czechia', teamId: 'aurora',
    skill: 0.86, aggression: 0.77, consistency: 0.85, tyreManagement: 0.84,
    wetSkill: 0.82, racecraft: 0.84, experience: 4, age: 26,
  },

  // Vantage Grand Prix
  {
    id: 'p-marchetti', firstName: 'Paolo', lastName: 'Marchetti', code: 'MAR',
    raceNumber: 10, nationality: 'Italy', teamId: 'vantage',
    skill: 0.87, aggression: 0.86, consistency: 0.81, tyreManagement: 0.8,
    wetSkill: 0.85, racecraft: 0.87, experience: 6, age: 28,
  },
  {
    id: 'e-larsson', firstName: 'Elias', lastName: 'Larsson', code: 'LAR',
    raceNumber: 31, nationality: 'Finland', teamId: 'vantage',
    skill: 0.85, aggression: 0.72, consistency: 0.88, tyreManagement: 0.87,
    wetSkill: 0.88, racecraft: 0.82, experience: 7, age: 29,
  },

  // Northstar Racing
  {
    id: 'c-mcallister', firstName: 'Cameron', lastName: 'McAllister', code: 'MCA',
    raceNumber: 23, nationality: 'Australia', teamId: 'northstar',
    skill: 0.86, aggression: 0.83, consistency: 0.84, tyreManagement: 0.82,
    wetSkill: 0.83, racecraft: 0.88, experience: 8, age: 30,
  },
  {
    id: 'y-alkaabi', firstName: 'Yusuf', lastName: 'Al-Kaabi', code: 'ALK',
    raceNumber: 27, nationality: 'Qatar', teamId: 'northstar',
    skill: 0.83, aggression: 0.75, consistency: 0.86, tyreManagement: 0.85,
    wetSkill: 0.79, racecraft: 0.81, experience: 2, age: 22,
  },

  // Lumen Motorsport
  {
    id: 'g-hoffmann', firstName: 'Greta', lastName: 'Hoffmann', code: 'HOF',
    raceNumber: 20, nationality: 'Germany', teamId: 'lumen',
    skill: 0.84, aggression: 0.78, consistency: 0.87, tyreManagement: 0.86,
    wetSkill: 0.85, racecraft: 0.83, experience: 4, age: 25,
  },
  {
    id: 'r-santos', firstName: 'Rafael', lastName: 'Santos', code: 'SAN',
    raceNumber: 24, nationality: 'Brazil', teamId: 'lumen',
    skill: 0.82, aggression: 0.84, consistency: 0.78, tyreManagement: 0.79,
    wetSkill: 0.87, racecraft: 0.85, experience: 3, age: 24,
  },

  // Kestrel Team
  {
    id: 'i-petrov', firstName: 'Ivan', lastName: 'Petrov', code: 'PET',
    raceNumber: 77, nationality: 'Bulgaria', teamId: 'kestrel',
    skill: 0.81, aggression: 0.7, consistency: 0.85, tyreManagement: 0.83,
    wetSkill: 0.78, racecraft: 0.79, experience: 10, age: 32,
  },
  {
    id: 'n-oshea', firstName: 'Niall', lastName: "O'Shea", code: 'OSH',
    raceNumber: 43, nationality: 'Ireland', teamId: 'kestrel',
    skill: 0.79, aggression: 0.81, consistency: 0.76, tyreManagement: 0.77,
    wetSkill: 0.8, racecraft: 0.8, experience: 1, age: 21,
  },

  // Brava Competizione
  {
    id: 'h-nakamura', firstName: 'Haruto', lastName: 'Nakamura', code: 'NAK',
    raceNumber: 6, nationality: 'Japan', teamId: 'brava',
    skill: 0.8, aggression: 0.74, consistency: 0.83, tyreManagement: 0.82,
    wetSkill: 0.79, racecraft: 0.78, experience: 5, age: 27,
  },
  {
    id: 'l-moreau', firstName: 'Luc', lastName: 'Moreau', code: 'MOR',
    raceNumber: 9, nationality: 'Belgium', teamId: 'brava',
    skill: 0.77, aggression: 0.79, consistency: 0.75, tyreManagement: 0.76,
    wetSkill: 0.77, racecraft: 0.76, experience: 2, age: 23,
  },
];

const TEAM_BY_ID = new Map(TEAMS.map((t) => [t.id, t]));
const DRIVER_BY_ID = new Map(DRIVERS.map((d) => [d.id, d]));

export function getTeam(id: string): Team {
  const t = TEAM_BY_ID.get(id);
  if (!t) throw new Error('Unknown team: ' + id);
  return t;
}

export function getDriver(id: string): Driver {
  const d = DRIVER_BY_ID.get(id);
  if (!d) throw new Error('Unknown driver: ' + id);
  return d;
}

export function driversForTeam(teamId: string): Driver[] {
  return DRIVERS.filter((d) => d.teamId === teamId);
}

export function fullName(d: Driver): string {
  return d.firstName + ' ' + d.lastName;
}
