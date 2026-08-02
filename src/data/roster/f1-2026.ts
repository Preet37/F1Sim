import type { RosterTier } from './types';

/**
 * The 2026 Formula 1 World Championship: eleven teams, twenty-two drivers.
 *
 * Team names, driver names, car numbers, nationalities and power-unit
 * allocations are real, taken from the published 2026 entry list. Ability
 * ratings, chassis multipliers, budgets and salaries are this project's own
 * estimates — see the note on `RosterDriver.skill`.
 *
 * NO LOGOS, NO BADGES, NO SPONSORS. Teams are identified by name, by their real
 * livery colours, and by the generated geometric mark the timing tower already
 * draws. Nothing trademarked is reproduced. See `docs/CAREER_MODE.md` section 0.
 *
 * Chassis multipliers describe the 2026 regulation reset: the field is spread
 * wider than a settled ruleset would give, because a new formula always
 * separates the teams that understood it from the teams that did not, and a
 * career that begins at a reset is a career where the order can change.
 */
export const F1_2026: RosterTier = {
  tier: 'F1',
  season: 2026,

  calendar: [
    // The eleven surveyed circuits, in an order that follows the real season's
    // shape: a Middle Eastern opener, the European summer, the flyaways, and a
    // South American finish.
    'bahrain', 'jeddah', 'monaco', 'redbullring', 'silverstone',
    'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
  ],

  teams: [
    {
      id: 'mclaren', name: 'McLaren Formula 1 Team', shortName: 'McLaren', code: 'MCL',
      colour: 0xff8000, accent: 0x1a1a1a, powerUnitId: 'mercedes-pu',
      // Reigning champions: the best chassis on the grid and the best pit crew,
      // kind to its tyres, and reliable.
      chassis: {
        downforceMult: 1.048, dragMult: 0.968, mechanicalGripMult: 1.032,
        tireWearMult: 0.938, failureRate: 0.016, pitCrewTimeS: 2.28,
      },
      developmentRate: 0.95, prefersExperience: 0.45, budgetUsd: 145_000_000,
    },
    {
      id: 'ferrari', name: 'Scuderia Ferrari', shortName: 'Ferrari', code: 'FER',
      colour: 0xe8002d, accent: 0xf2e8d5, powerUnitId: 'ferrari-pu',
      // Strong but hard on its rear tyres, which is where its race pace goes.
      chassis: {
        downforceMult: 1.030, dragMult: 0.988, mechanicalGripMult: 1.018,
        tireWearMult: 1.045, failureRate: 0.024, pitCrewTimeS: 2.42,
      },
      developmentRate: 0.90, prefersExperience: 0.65, budgetUsd: 145_000_000,
    },
    {
      id: 'red-bull', name: 'Oracle Red Bull Racing', shortName: 'Red Bull', code: 'RBR',
      colour: 0x3671c6, accent: 0xfacd28, powerUnitId: 'redbull-ford',
      // A works team with its own first-year power unit: the best chassis
      // efficiency on the grid attached to the least reliable engine on it.
      chassis: {
        downforceMult: 1.040, dragMult: 0.962, mechanicalGripMult: 1.026,
        tireWearMult: 0.960, failureRate: 0.022, pitCrewTimeS: 2.22,
      },
      developmentRate: 0.94, prefersExperience: 0.40, budgetUsd: 145_000_000,
    },
    {
      id: 'mercedes', name: 'Mercedes-AMG Petronas F1 Team', shortName: 'Mercedes', code: 'MER',
      colour: 0x27f4d2, accent: 0x1a1a1a, powerUnitId: 'mercedes-pu',
      chassis: {
        downforceMult: 1.026, dragMult: 0.976, mechanicalGripMult: 1.020,
        tireWearMult: 0.972, failureRate: 0.018, pitCrewTimeS: 2.34,
      },
      developmentRate: 0.92, prefersExperience: 0.50, budgetUsd: 145_000_000,
    },
    {
      id: 'aston-martin', name: 'Aston Martin Aramco F1 Team', shortName: 'Aston Martin', code: 'AMR',
      colour: 0x229971, accent: 0xcedc00, powerUnitId: 'honda-pu',
      chassis: {
        downforceMult: 1.014, dragMult: 0.984, mechanicalGripMult: 1.008,
        tireWearMult: 0.990, failureRate: 0.026, pitCrewTimeS: 2.48,
      },
      developmentRate: 0.86, prefersExperience: 0.60, budgetUsd: 142_000_000,
    },
    {
      id: 'williams', name: 'Atlassian Williams Racing', shortName: 'Williams', code: 'WIL',
      colour: 0x64c4ff, accent: 0x00205b, powerUnitId: 'mercedes-pu',
      // A genuinely low-drag car — quick where the straights are long, ordinary
      // where they are not. The physics gives that to it for free.
      chassis: {
        downforceMult: 0.994, dragMult: 0.958, mechanicalGripMult: 1.000,
        tireWearMult: 1.010, failureRate: 0.032, pitCrewTimeS: 2.52,
      },
      developmentRate: 0.82, prefersExperience: 0.55, budgetUsd: 138_000_000,
    },
    {
      id: 'racing-bulls', name: 'Visa Cash App Racing Bulls', shortName: 'Racing Bulls', code: 'RBV',
      colour: 0x6692ff, accent: 0xe8002d, powerUnitId: 'redbull-ford',
      chassis: {
        downforceMult: 1.002, dragMult: 0.980, mechanicalGripMult: 0.998,
        tireWearMult: 1.004, failureRate: 0.030, pitCrewTimeS: 2.44,
      },
      developmentRate: 0.80, prefersExperience: 0.25, budgetUsd: 132_000_000,
    },
    {
      id: 'audi', name: 'Audi F1 Team', shortName: 'Audi', code: 'AUD',
      // Titanium and red. Audi's 2026 livery was not settled at the time of
      // writing; these are the brand's own colours and are a one-line edit.
      colour: 0xbb0a30, accent: 0xa5acaf, powerUnitId: 'audi-pu',
      chassis: {
        downforceMult: 0.988, dragMult: 0.992, mechanicalGripMult: 0.992,
        tireWearMult: 1.018, failureRate: 0.034, pitCrewTimeS: 2.58,
      },
      developmentRate: 0.88, prefersExperience: 0.50, budgetUsd: 140_000_000,
    },
    {
      id: 'alpine', name: 'BWT Alpine F1 Team', shortName: 'Alpine', code: 'ALP',
      colour: 0x00a1e8, accent: 0xff87bc, powerUnitId: 'mercedes-pu',
      chassis: {
        downforceMult: 0.984, dragMult: 0.996, mechanicalGripMult: 0.986,
        tireWearMult: 1.028, failureRate: 0.038, pitCrewTimeS: 2.62,
      },
      developmentRate: 0.74, prefersExperience: 0.45, budgetUsd: 130_000_000,
    },
    {
      id: 'haas', name: 'MoneyGram Haas F1 Team', shortName: 'Haas', code: 'HAS',
      colour: 0xb6babd, accent: 0xe6002b, powerUnitId: 'ferrari-pu',
      chassis: {
        downforceMult: 0.976, dragMult: 1.000, mechanicalGripMult: 0.980,
        tireWearMult: 1.040, failureRate: 0.042, pitCrewTimeS: 2.70,
      },
      developmentRate: 0.66, prefersExperience: 0.40, budgetUsd: 122_000_000,
    },
    {
      id: 'cadillac', name: 'Cadillac Formula 1 Team', shortName: 'Cadillac', code: 'CAD',
      // A first-year entry, with the deficit that always implies. Brand colours;
      // the 2026 livery was not settled at the time of writing.
      colour: 0x1c1c28, accent: 0xc9a227, powerUnitId: 'ferrari-pu',
      chassis: {
        downforceMult: 0.958, dragMult: 1.014, mechanicalGripMult: 0.968,
        tireWearMult: 1.062, failureRate: 0.058, pitCrewTimeS: 2.86,
      },
      // The highest development rate on the grid: a new team has the most to
      // learn and the fewest constraints, so it climbs fastest across a career.
      developmentRate: 0.90, prefersExperience: 0.80, budgetUsd: 128_000_000,
    },
  ],

  drivers: [
    // --- McLaren ---------------------------------------------------------
    {
      id: 'norris', firstName: 'Lando', lastName: 'Norris', code: 'NOR',
      raceNumber: 1, nationality: 'United Kingdom', teamId: 'mclaren',
      skill: 0.95, aggression: 0.78, consistency: 0.92, tyreManagement: 0.91,
      wetSkill: 0.93, racecraft: 0.90, experience: 7, age: 26,
      contractYears: 3, salaryUsd: 28_000_000,
    },
    {
      id: 'piastri', firstName: 'Oscar', lastName: 'Piastri', code: 'PIA',
      raceNumber: 81, nationality: 'Australia', teamId: 'mclaren',
      skill: 0.93, aggression: 0.74, consistency: 0.94, tyreManagement: 0.92,
      wetSkill: 0.87, racecraft: 0.89, experience: 4, age: 25,
      contractYears: 2, salaryUsd: 20_000_000,
    },

    // --- Ferrari ---------------------------------------------------------
    {
      id: 'leclerc', firstName: 'Charles', lastName: 'Leclerc', code: 'LEC',
      raceNumber: 16, nationality: 'Monaco', teamId: 'ferrari',
      // The best single lap on the grid; a shade behind the very best over a
      // race distance, which is what the consistency and tyre numbers say.
      skill: 0.94, aggression: 0.84, consistency: 0.86, tyreManagement: 0.83,
      wetSkill: 0.90, racecraft: 0.91, experience: 8, age: 28,
      contractYears: 2, salaryUsd: 34_000_000,
    },
    {
      id: 'hamilton', firstName: 'Lewis', lastName: 'Hamilton', code: 'HAM',
      raceNumber: 44, nationality: 'United Kingdom', teamId: 'ferrari',
      // Past his peak on raw pace and still the best wet-weather driver and the
      // best tyre manager in the field. Age is doing what age does.
      skill: 0.90, aggression: 0.79, consistency: 0.91, tyreManagement: 0.96,
      wetSkill: 0.97, racecraft: 0.95, experience: 19, age: 41,
      contractYears: 1, salaryUsd: 45_000_000,
    },

    // --- Red Bull --------------------------------------------------------
    {
      id: 'verstappen', firstName: 'Max', lastName: 'Verstappen', code: 'VER',
      // Number 1 belongs to the reigning champion, so this is the career number.
      raceNumber: 33, nationality: 'Netherlands', teamId: 'red-bull',
      skill: 0.98, aggression: 0.88, consistency: 0.95, tyreManagement: 0.92,
      wetSkill: 0.97, racecraft: 0.96, experience: 11, age: 28,
      contractYears: 3, salaryUsd: 55_000_000,
    },
    {
      id: 'hadjar', firstName: 'Isack', lastName: 'Hadjar', code: 'HAD',
      raceNumber: 6, nationality: 'France', teamId: 'red-bull',
      skill: 0.84, aggression: 0.80, consistency: 0.81, tyreManagement: 0.79,
      wetSkill: 0.82, racecraft: 0.83, experience: 1, age: 21,
      contractYears: 2, salaryUsd: 3_000_000,
    },

    // --- Mercedes --------------------------------------------------------
    {
      id: 'russell', firstName: 'George', lastName: 'Russell', code: 'RUS',
      raceNumber: 63, nationality: 'United Kingdom', teamId: 'mercedes',
      skill: 0.92, aggression: 0.76, consistency: 0.93, tyreManagement: 0.88,
      wetSkill: 0.89, racecraft: 0.88, experience: 7, age: 28,
      contractYears: 2, salaryUsd: 26_000_000,
    },
    {
      id: 'antonelli', firstName: 'Andrea Kimi', lastName: 'Antonelli', code: 'ANT',
      raceNumber: 12, nationality: 'Italy', teamId: 'mercedes',
      skill: 0.87, aggression: 0.82, consistency: 0.80, tyreManagement: 0.82,
      wetSkill: 0.86, racecraft: 0.84, experience: 1, age: 19,
      contractYears: 3, salaryUsd: 4_000_000,
    },

    // --- Aston Martin ----------------------------------------------------
    {
      id: 'alonso', firstName: 'Fernando', lastName: 'Alonso', code: 'ALO',
      raceNumber: 14, nationality: 'Spain', teamId: 'aston-martin',
      // The race craft number is the highest in the field and is not a
      // sentimental one: it is what twenty-two seasons of knowing exactly where
      // to put a car is worth on a Sunday.
      skill: 0.89, aggression: 0.86, consistency: 0.90, tyreManagement: 0.94,
      wetSkill: 0.92, racecraft: 0.97, experience: 22, age: 44,
      contractYears: 1, salaryUsd: 24_000_000,
    },
    {
      id: 'stroll', firstName: 'Lance', lastName: 'Stroll', code: 'STR',
      raceNumber: 18, nationality: 'Canada', teamId: 'aston-martin',
      skill: 0.77, aggression: 0.72, consistency: 0.76, tyreManagement: 0.78,
      wetSkill: 0.84, racecraft: 0.75, experience: 9, age: 27,
      contractYears: 2, salaryUsd: 12_000_000,
    },

    // --- Williams --------------------------------------------------------
    {
      id: 'albon', firstName: 'Alexander', lastName: 'Albon', code: 'ALB',
      raceNumber: 23, nationality: 'Thailand', teamId: 'williams',
      skill: 0.85, aggression: 0.73, consistency: 0.88, tyreManagement: 0.90,
      wetSkill: 0.83, racecraft: 0.86, experience: 7, age: 30,
      contractYears: 2, salaryUsd: 10_000_000,
    },
    {
      id: 'sainz', firstName: 'Carlos', lastName: 'Sainz', code: 'SAI',
      raceNumber: 55, nationality: 'Spain', teamId: 'williams',
      skill: 0.88, aggression: 0.79, consistency: 0.90, tyreManagement: 0.89,
      wetSkill: 0.84, racecraft: 0.90, experience: 11, age: 31,
      contractYears: 2, salaryUsd: 15_000_000,
    },

    // --- Racing Bulls ----------------------------------------------------
    {
      id: 'lawson', firstName: 'Liam', lastName: 'Lawson', code: 'LAW',
      raceNumber: 30, nationality: 'New Zealand', teamId: 'racing-bulls',
      skill: 0.81, aggression: 0.85, consistency: 0.78, tyreManagement: 0.78,
      wetSkill: 0.80, racecraft: 0.82, experience: 2, age: 24,
      contractYears: 1, salaryUsd: 2_500_000,
    },
    {
      id: 'lindblad', firstName: 'Arvid', lastName: 'Lindblad', code: 'LIN',
      raceNumber: 34, nationality: 'United Kingdom', teamId: 'racing-bulls',
      skill: 0.78, aggression: 0.83, consistency: 0.72, tyreManagement: 0.74,
      wetSkill: 0.77, racecraft: 0.76, experience: 0, age: 18,
      contractYears: 2, salaryUsd: 1_200_000,
    },

    // --- Audi ------------------------------------------------------------
    {
      id: 'hulkenberg', firstName: 'Nico', lastName: 'Hülkenberg', code: 'HUL',
      raceNumber: 27, nationality: 'Germany', teamId: 'audi',
      skill: 0.83, aggression: 0.71, consistency: 0.89, tyreManagement: 0.87,
      wetSkill: 0.88, racecraft: 0.84, experience: 14, age: 38,
      contractYears: 1, salaryUsd: 9_000_000,
    },
    {
      id: 'bortoleto', firstName: 'Gabriel', lastName: 'Bortoleto', code: 'BOR',
      raceNumber: 5, nationality: 'Brazil', teamId: 'audi',
      skill: 0.80, aggression: 0.77, consistency: 0.79, tyreManagement: 0.81,
      wetSkill: 0.82, racecraft: 0.79, experience: 1, age: 21,
      contractYears: 2, salaryUsd: 2_000_000,
    },

    // --- Alpine ----------------------------------------------------------
    {
      id: 'gasly', firstName: 'Pierre', lastName: 'Gasly', code: 'GAS',
      raceNumber: 10, nationality: 'France', teamId: 'alpine',
      skill: 0.85, aggression: 0.80, consistency: 0.84, tyreManagement: 0.85,
      wetSkill: 0.86, racecraft: 0.85, experience: 9, age: 30,
      contractYears: 2, salaryUsd: 11_000_000,
    },
    {
      id: 'colapinto', firstName: 'Franco', lastName: 'Colapinto', code: 'COL',
      raceNumber: 43, nationality: 'Argentina', teamId: 'alpine',
      skill: 0.80, aggression: 0.84, consistency: 0.74, tyreManagement: 0.76,
      wetSkill: 0.81, racecraft: 0.80, experience: 2, age: 22,
      contractYears: 1, salaryUsd: 2_200_000,
    },

    // --- Haas ------------------------------------------------------------
    {
      id: 'ocon', firstName: 'Esteban', lastName: 'Ocon', code: 'OCO',
      raceNumber: 31, nationality: 'France', teamId: 'haas',
      skill: 0.83, aggression: 0.81, consistency: 0.85, tyreManagement: 0.84,
      wetSkill: 0.82, racecraft: 0.83, experience: 10, age: 29,
      contractYears: 2, salaryUsd: 7_000_000,
    },
    {
      id: 'bearman', firstName: 'Oliver', lastName: 'Bearman', code: 'BEA',
      raceNumber: 87, nationality: 'United Kingdom', teamId: 'haas',
      skill: 0.82, aggression: 0.79, consistency: 0.80, tyreManagement: 0.80,
      wetSkill: 0.80, racecraft: 0.81, experience: 1, age: 20,
      contractYears: 2, salaryUsd: 2_000_000,
    },

    // --- Cadillac --------------------------------------------------------
    {
      id: 'perez', firstName: 'Sergio', lastName: 'Pérez', code: 'PER',
      raceNumber: 11, nationality: 'Mexico', teamId: 'cadillac',
      skill: 0.82, aggression: 0.75, consistency: 0.82, tyreManagement: 0.93,
      wetSkill: 0.81, racecraft: 0.87, experience: 14, age: 36,
      contractYears: 2, salaryUsd: 12_000_000,
    },
    {
      id: 'bottas', firstName: 'Valtteri', lastName: 'Bottas', code: 'BOT',
      raceNumber: 77, nationality: 'Finland', teamId: 'cadillac',
      skill: 0.80, aggression: 0.70, consistency: 0.88, tyreManagement: 0.86,
      wetSkill: 0.83, racecraft: 0.78, experience: 13, age: 36,
      contractYears: 2, salaryUsd: 8_000_000,
    },
  ],
};
