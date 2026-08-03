import type { RosterDriver, RosterTeam, RosterTier } from './types';

/**
 * The FIA Formula 2 and Formula 3 championships, 2026.
 *
 * Team names, driver names, car numbers and nationalities are real, from the
 * published entry lists. Ability ratings are this project's estimates.
 *
 * WHY THESE TWO TIERS ARE WRITTEN DIFFERENTLY FROM FORMULA 1.
 *
 * Both are SPEC SERIES: every team runs the same chassis and the same engine —
 * the Dallara F2 2024 and the Dallara F3 2025. So there is no per-team car to
 * describe, and writing eleven near-identical chassis blocks would be pretending
 * there is. Junior teams differ in exactly three things, all of which are
 * operations rather than machinery:
 *
 *   · `pitCrewTimeS`  — how good the crew is
 *   · `failureRate`   — how well the car is prepared
 *   · `tireWearMult`  — how well the team sets it up for a race stint
 *
 * That is the whole of it, and it is the right model: a junior championship is
 * decided by drivers and by race craft, which is exactly the feeling the bottom
 * of a career should have. It also means the ladder teaches the player to drive
 * before it teaches them to manage.
 *
 * The car itself — the fact that an F3 car has 380 horsepower and an F1 car has
 * over a thousand — lives in `src/career/World.ts`, which folds each tier's spec
 * into every team on it. That is the mechanism `TIER_INFO.carPace` claimed to be
 * and never was.
 */

/** Operations quality: the only axis junior teams differ on. */
interface JuniorOps {
  /** 0 = the worst-run team on the grid, 1 = the best. */
  quality: number;
}

function juniorTeam(
  id: string, name: string, shortName: string, code: string,
  colour: number, accent: number, ops: JuniorOps, budgetUsd: number,
): RosterTeam {
  const q = ops.quality;
  return {
    id, name, shortName, code, colour, accent,
    // No power-unit deal: a spec series buys its engines from the promoter.
    powerUnitId: '',
    chassis: {
      // Identical for everyone. The tier's own car is applied on top, in World.
      downforceMult: 1, dragMult: 1, mechanicalGripMult: 1,
      // The three that are not identical.
      tireWearMult: 1.06 - q * 0.10,
      failureRate: 0.075 - q * 0.045,
      pitCrewTimeS: 3.30 - q * 0.55,
    },
    developmentRate: 0.4 + q * 0.35,
    prefersExperience: 0.2 + q * 0.2,
    budgetUsd,
  };
}

/**
 * A junior driver.
 *
 * Positional rather than named-field because there are forty-two of them and a
 * table is easier to read and to correct than forty-two object literals. The
 * five ability numbers are ordered the way the interface declares them:
 * skill, aggression, consistency, tyre management, wet, race craft.
 */
function jd(
  id: string, first: string, last: string, code: string, num: number,
  nat: string, teamId: string, age: number, exp: number,
  skill: number, agg: number, cons: number, tyre: number, wet: number, race: number,
  reserve = false,
): RosterDriver {
  return {
    id, firstName: first, lastName: last, code, raceNumber: num,
    nationality: nat, teamId,
    skill, aggression: agg, consistency: cons, tyreManagement: tyre,
    wetSkill: wet, racecraft: race,
    experience: exp, age,
    contractYears: 1,
    // Junior drivers are usually paying rather than being paid. The salary field
    // is used by the transfer market as a valuation, not as a wage bill.
    salaryUsd: 250_000 + Math.round(skill * 1_200_000),
    ...(reserve ? { reserve: true } : {}),
  };
}

// ===========================================================================
// Formula 2 — eleven teams, twenty-two drivers
// ===========================================================================

export const F2_2026: RosterTier = {
  tier: 'F2',
  season: 2026,
  // Twelve rounds across the eleven surveyed circuits — Monza is a
  // double-header, as the real calendar has. F2 supports Formula 1, so it races
  // where Formula 1 races.
  calendar: [
    'bahrain', 'jeddah', 'monaco', 'redbullring', 'silverstone', 'spa',
    'zandvoort', 'monza', 'monza', 'suzuka', 'cota', 'interlagos',
  ],

  teams: [
    juniorTeam('invicta', 'Invicta Racing', 'Invicta', 'INV', 0x1b2a4a, 0xd4af37, { quality: 0.95 }, 5_200_000),
    juniorTeam('prema-f2', 'Prema Racing', 'Prema', 'PRE', 0xe8002d, 0xffffff, { quality: 0.92 }, 5_400_000),
    juniorTeam('art-f2', 'ART Grand Prix', 'ART', 'ART', 0x101820, 0xc0c8d0, { quality: 0.86 }, 4_900_000),
    juniorTeam('campos-f2', 'Campos Racing', 'Campos', 'CAM', 0x0b3d91, 0xf0a500, { quality: 0.84 }, 4_500_000),
    juniorTeam('mp-f2', 'MP Motorsport', 'MP', 'MPM', 0xff6b00, 0x101820, { quality: 0.82 }, 4_400_000),
    juniorTeam('rodin-f2', 'Rodin Motorsport', 'Rodin', 'ROD', 0x151515, 0x00d95f, { quality: 0.76 }, 4_200_000),
    juniorTeam('dams-f2', 'DAMS Lucas Oil', 'DAMS', 'DAM', 0x0057b8, 0xe30613, { quality: 0.70 }, 4_000_000),
    juniorTeam('hitech-f2', 'Hitech TGR', 'Hitech', 'HIT', 0x1a1f3a, 0x8fd6ff, { quality: 0.64 }, 3_900_000),
    juniorTeam('trident-f2', 'Trident', 'Trident', 'TRI', 0x0d47a1, 0xffd21f, { quality: 0.56 }, 3_600_000),
    juniorTeam('var-f2', 'Van Amersfoort Racing', 'VAR', 'VAR', 0xe8002d, 0x101820, { quality: 0.44 }, 3_400_000),
    juniorTeam('aix-f2', 'AIX Racing', 'AIX', 'AIX', 0x2b2b2b, 0xc9a227, { quality: 0.30 }, 3_100_000),
  ],

  drivers: [
    // Invicta Racing — reigning teams' champions
    jd('camara', 'Rafael', 'Câmara', 'CAM', 1, 'Brazil', 'invicta', 21, 1, 0.86, 0.78, 0.84, 0.82, 0.83, 0.84),
    jd('durksen', 'Joshua', 'Dürksen', 'DUR', 2, 'Paraguay', 'invicta', 23, 2, 0.79, 0.76, 0.78, 0.77, 0.76, 0.78),
    // Prema Racing
    jd('montoya', 'Sebastián', 'Montoya', 'MON', 11, 'Colombia', 'prema-f2', 21, 2, 0.80, 0.82, 0.75, 0.76, 0.79, 0.80),
    jd('boya', 'Mari', 'Boya', 'BOY', 12, 'Spain', 'prema-f2', 21, 1, 0.79, 0.77, 0.77, 0.78, 0.77, 0.77),
    // ART Grand Prix
    jd('maini', 'Kush', 'Maini', 'MAI', 16, 'India', 'art-f2', 25, 3, 0.78, 0.74, 0.80, 0.80, 0.75, 0.78),
    jd('inthraphuvasak', 'Tasanapol', 'Inthraphuvasak', 'INT', 17, 'Thailand', 'art-f2', 21, 1, 0.72, 0.75, 0.70, 0.71, 0.72, 0.71),
    // Campos Racing
    jd('leon', 'Noel', 'León', 'LEO', 5, 'Mexico', 'campos-f2', 21, 1, 0.77, 0.80, 0.73, 0.74, 0.76, 0.77),
    jd('tsolov', 'Nikola', 'Tsolov', 'TSO', 6, 'Bulgaria', 'campos-f2', 20, 1, 0.83, 0.81, 0.79, 0.78, 0.81, 0.82),
    // MP Motorsport
    jd('mini', 'Gabriele', 'Minì', 'MIN', 9, 'Italy', 'mp-f2', 21, 2, 0.84, 0.76, 0.82, 0.83, 0.80, 0.81),
    jd('goethe', 'Oliver', 'Goethe', 'GOE', 10, 'Germany', 'mp-f2', 22, 2, 0.76, 0.78, 0.74, 0.75, 0.74, 0.75),
    // Rodin Motorsport
    jd('dunne', 'Alex', 'Dunne', 'DUN', 15, 'Ireland', 'rodin-f2', 21, 1, 0.85, 0.86, 0.76, 0.77, 0.82, 0.85),
    jd('stenshorne', 'Martinius', 'Stenshorne', 'STE', 14, 'Norway', 'rodin-f2', 21, 1, 0.76, 0.75, 0.75, 0.76, 0.79, 0.75),
    // DAMS Lucas Oil
    jd('beganovic', 'Dino', 'Beganovic', 'BEG', 7, 'Sweden', 'dams-f2', 22, 2, 0.81, 0.74, 0.83, 0.82, 0.79, 0.79),
    jd('bilinski', 'Roman', 'Bilinski', 'BIL', 8, 'Poland', 'dams-f2', 21, 1, 0.71, 0.77, 0.68, 0.70, 0.70, 0.72),
    // Hitech TGR
    jd('miyata', 'Ritomo', 'Miyata', 'MIY', 3, 'Japan', 'hitech-f2', 27, 3, 0.75, 0.72, 0.78, 0.79, 0.76, 0.74),
    jd('herta', 'Colton', 'Herta', 'HER', 4, 'United States', 'hitech-f2', 26, 1, 0.80, 0.83, 0.76, 0.75, 0.78, 0.83),
    // Trident
    jd('vanhoepen', 'Laurens', 'van Hoepen', 'VHO', 24, 'Netherlands', 'trident-f2', 21, 1, 0.73, 0.74, 0.72, 0.73, 0.74, 0.72),
    jd('bennett', 'John', 'Bennett', 'BEN', 25, 'United Kingdom', 'trident-f2', 20, 0, 0.70, 0.76, 0.66, 0.68, 0.69, 0.70),
    // Van Amersfoort Racing
    jd('varrone', 'Nico', 'Varrone', 'VAR', 22, 'Argentina', 'var-f2', 24, 1, 0.69, 0.78, 0.65, 0.67, 0.71, 0.71),
    jd('villagomez', 'Rafael', 'Villagómez', 'VIL', 23, 'Mexico', 'var-f2', 24, 2, 0.66, 0.71, 0.67, 0.68, 0.65, 0.66),
    // AIX Racing
    jd('fittipaldi', 'Emerson', 'Fittipaldi Jr.', 'FIT', 20, 'Brazil', 'aix-f2', 21, 0, 0.67, 0.75, 0.64, 0.66, 0.68, 0.68),
    jd('shields', 'Cian', 'Shields', 'SHI', 21, 'United Kingdom', 'aix-f2', 22, 1, 0.65, 0.72, 0.66, 0.66, 0.64, 0.65),
  ],
};

// ===========================================================================
// Formula 3 — ten teams
// ===========================================================================

/**
 * Formula 3 really runs THREE cars per team, for a thirty-car grid.
 *
 * This game runs the first two of each and marks the third a reserve. Thirty
 * cars is a step change in cost on a phone for a tier the player leaves after a
 * season or two, and two-per-team is what the pit lane paints. The third drivers
 * are still in the world — the transfer market can promote them into a seat, and
 * several of them do get promoted over a long career — so nobody is deleted for
 * the sake of the grid size.
 */
export const F3_2026: RosterTier = {
  tier: 'F3',
  season: 2026,
  // Nine rounds, as the real championship runs.
  calendar: [
    'bahrain', 'monaco', 'redbullring', 'silverstone', 'spa',
    'zandvoort', 'monza', 'cota', 'interlagos',
  ],

  teams: [
    juniorTeam('campos-f3', 'Campos Racing', 'Campos', 'CAM', 0x0b3d91, 0xf0a500, { quality: 0.94 }, 2_400_000),
    juniorTeam('trident-f3', 'Trident', 'Trident', 'TRI', 0x0d47a1, 0xffd21f, { quality: 0.88 }, 2_300_000),
    juniorTeam('prema-f3', 'Prema Racing', 'Prema', 'PRE', 0xe8002d, 0xffffff, { quality: 0.86 }, 2_500_000),
    juniorTeam('mp-f3', 'MP Motorsport', 'MP', 'MPM', 0xff6b00, 0x101820, { quality: 0.80 }, 2_200_000),
    juniorTeam('art-f3', 'ART Grand Prix', 'ART', 'ART', 0x101820, 0xc0c8d0, { quality: 0.74 }, 2_300_000),
    juniorTeam('rodin-f3', 'Rodin Motorsport', 'Rodin', 'ROD', 0x151515, 0x00d95f, { quality: 0.66 }, 2_000_000),
    juniorTeam('hitech-f3', 'Hitech TGR', 'Hitech', 'HIT', 0x1a1f3a, 0x8fd6ff, { quality: 0.58 }, 1_900_000),
    juniorTeam('var-f3', 'Van Amersfoort Racing', 'VAR', 'VAR', 0xe8002d, 0x101820, { quality: 0.48 }, 1_800_000),
    juniorTeam('dams-f3', 'DAMS Lucas Oil', 'DAMS', 'DAM', 0x0057b8, 0xe30613, { quality: 0.38 }, 1_800_000),
    juniorTeam('aix-f3', 'AIX Racing', 'AIX', 'AIX', 0x2b2b2b, 0xc9a227, { quality: 0.24 }, 1_600_000),
  ],

  drivers: [
    // Campos Racing
    jd('nael', 'Théophile', 'Naël', 'NAE', 1, 'France', 'campos-f3', 18, 1, 0.79, 0.78, 0.74, 0.73, 0.76, 0.77),
    jd('ugochukwu', 'Ugo', 'Ugochukwu', 'UGO', 2, 'United States', 'campos-f3', 19, 1, 0.77, 0.80, 0.71, 0.72, 0.74, 0.76),
    jd('rivera', 'Ernesto', 'Rivera', 'RIV', 3, 'Mexico', 'campos-f3', 18, 0, 0.66, 0.74, 0.63, 0.64, 0.65, 0.66, true),
    // Trident
    jd('stromsted', 'Noah', 'Strømsted', 'STR', 4, 'Denmark', 'trident-f3', 19, 1, 0.76, 0.76, 0.73, 0.73, 0.75, 0.74),
    jd('slater', 'Freddie', 'Slater', 'SLA', 5, 'United Kingdom', 'trident-f3', 18, 1, 0.80, 0.79, 0.75, 0.74, 0.77, 0.78),
    jd('depalo', 'Matteo', 'De Palo', 'DEP', 6, 'Italy', 'trident-f3', 19, 1, 0.68, 0.73, 0.66, 0.67, 0.67, 0.68, true),
    // Prema Racing
    jd('sharp', 'Louis', 'Sharp', 'SHA', 20, 'New Zealand', 'prema-f3', 18, 1, 0.75, 0.77, 0.72, 0.72, 0.73, 0.74),
    jd('wharton', 'James', 'Wharton', 'WHA', 21, 'Australia', 'prema-f3', 19, 1, 0.74, 0.75, 0.73, 0.73, 0.72, 0.73),
    jd('garfias', 'José', 'Garfias', 'GAR', 22, 'Mexico', 'prema-f3', 18, 0, 0.65, 0.72, 0.62, 0.63, 0.64, 0.65, true),
    // MP Motorsport
    jd('taponen', 'Tuukka', 'Taponen', 'TAP', 8, 'Finland', 'mp-f3', 18, 1, 0.78, 0.74, 0.75, 0.75, 0.79, 0.75),
    jd('giusti', 'Alessandro', 'Giusti', 'GIU', 9, 'France', 'mp-f3', 19, 1, 0.72, 0.76, 0.69, 0.70, 0.71, 0.72),
    jd('colnaghi', 'Mattia', 'Colnaghi', 'CLN', 7, 'Argentina', 'mp-f3', 18, 0, 0.64, 0.73, 0.61, 0.62, 0.63, 0.64, true),
    // ART Grand Prix
    jd('kato', 'Taito', 'Kato', 'KAT', 10, 'Japan', 'art-f3', 18, 0, 0.71, 0.72, 0.70, 0.70, 0.70, 0.70),
    jd('gladysz', 'Maciej', 'Gładysz', 'GLA', 11, 'Poland', 'art-f3', 19, 1, 0.70, 0.74, 0.68, 0.68, 0.69, 0.70),
    jd('le', 'Kanato', 'Le', 'KLE', 12, 'Japan', 'art-f3', 18, 0, 0.63, 0.71, 0.61, 0.62, 0.62, 0.63, true),
    // Rodin Motorsport
    jd('clerot', 'Pedro', 'Clerot', 'CLE', 17, 'Brazil', 'rodin-f3', 18, 1, 0.73, 0.79, 0.68, 0.69, 0.73, 0.74),
    jd('badoer', 'Brando', 'Badoer', 'BAD', 18, 'Italy', 'rodin-f3', 19, 1, 0.69, 0.73, 0.68, 0.69, 0.68, 0.69),
    jd('ho', 'Christian', 'Ho', 'CHO', 19, 'Singapore', 'rodin-f3', 19, 1, 0.62, 0.70, 0.60, 0.61, 0.61, 0.62, true),
    // Hitech TGR
    jd('mclaughlin', 'Fionn', 'McLaughlin', 'MCL', 24, 'Ireland', 'hitech-f3', 18, 0, 0.70, 0.75, 0.66, 0.67, 0.69, 0.70),
    jd('nakamura', 'Jin', 'Nakamura', 'NAK', 25, 'Japan', 'hitech-f3', 18, 0, 0.68, 0.72, 0.66, 0.67, 0.67, 0.67),
    jd('shin', 'Michael', 'Shin', 'SHN', 23, 'South Korea', 'hitech-f3', 19, 1, 0.61, 0.69, 0.60, 0.61, 0.60, 0.61, true),
    // Van Amersfoort Racing
    jd('yamakoshi', 'Hiyu', 'Yamakoshi', 'YAM', 14, 'Japan', 'var-f3', 18, 0, 0.66, 0.71, 0.65, 0.66, 0.66, 0.66),
    jd('deligny', 'Enzo', 'Deligny', 'DEL', 15, 'France', 'var-f3', 18, 0, 0.67, 0.74, 0.64, 0.65, 0.66, 0.67),
    jd('delpino', 'Bruno', 'del Pino', 'DPI', 16, 'Spain', 'var-f3', 19, 1, 0.60, 0.70, 0.59, 0.60, 0.60, 0.60, true),
    // DAMS Lucas Oil
    jd('lacorte', 'Nicola', 'Lacorte', 'LAC', 29, 'Italy', 'dams-f3', 18, 0, 0.65, 0.72, 0.63, 0.64, 0.64, 0.65),
    jd('bhirombhakdi', 'Nandhavud', 'Bhirombhakdi', 'BHI', 30, 'Thailand', 'dams-f3', 19, 1, 0.59, 0.68, 0.60, 0.61, 0.59, 0.59),
    jd('xie', 'Gerrard', 'Xie', 'XIE', 31, 'China', 'dams-f3', 18, 0, 0.58, 0.69, 0.57, 0.58, 0.58, 0.58, true),
    // AIX Racing
    jd('david', 'Yevan', 'David', 'DAV', 27, 'Sri Lanka', 'aix-f3', 19, 1, 0.62, 0.70, 0.61, 0.62, 0.62, 0.62),
    jd('barrichello', 'Fernando', 'Barrichello', 'BAR', 28, 'Brazil', 'aix-f3', 18, 0, 0.63, 0.73, 0.60, 0.61, 0.63, 0.63),
    jd('hanna', 'Salim', 'Hanna', 'HAN', 26, 'Colombia', 'aix-f3', 19, 1, 0.56, 0.68, 0.56, 0.57, 0.56, 0.56, true),
  ],
};
