/**
 * Who the player is, as data.
 *
 * ---------------------------------------------------------------------------
 * WHY A HELMET, AND NOT A FACE
 * ---------------------------------------------------------------------------
 *
 * The request was blunt: "there is no figure, there is no person, and there's
 * no rendering happening of an actual person — that's the face of this new
 * agency." A career about you needs a protagonist you can see. Three things
 * decide what that protagonist can be:
 *
 *   1. NO REAL DRIVER LIKENESSES. Non-negotiable, and it rules out the obvious
 *      shortcut of a portrait that happens to resemble somebody.
 *   2. THERE IS NO ARTIST ON THIS PROJECT. Anything hand-drawn is out, which
 *      rules out a set of authored faces.
 *   3. A GENERATED FACE IS WORSE THAN NO FACE. A parametric human head at this
 *      budget lands somewhere between a corporate illustration and a mannequin,
 *      and it would be the only thing on the screen that looked cheap.
 *
 * So the protagonist is a HELMET. This is not a workaround, it is the sport's
 * own answer: a driver in a car is a helmet, that is how they are identified
 * from a grandstand and from a helicopter, and it is the single most
 * recognisable object in Formula 1. It is also the only piece of their
 * equipment a driver personally designs, which means putting it in the player's
 * hands is not a compromise — it is the correct thing to let them do.
 *
 * And it is completely parametric. A helmet design is a shell colour, a stripe
 * colour, a trim colour, one of a small family of patterns, and a visor tint.
 * Every combination of those is a legitimate design, because that is exactly
 * how the real ones are made. Six numbers in the save, drawn as vector art at
 * any size, deterministic, and no artwork is reproduced from anybody.
 *
 * WHERE IT GOES. `src/ui/DriverPortrait.ts` draws it: at 40 pixels beside a
 * name in a results row, at 200 on the career hub, at full height on the
 * podium. The same record could paint the helmet on `DriverMesh` in the car —
 * that is the obvious next step and it is deliberately NOT taken here, because
 * `DriverMesh.ts` belongs to the car-mesh work.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER HALF: THE THINGS THE PLAYER CHOSE
 * ---------------------------------------------------------------------------
 *
 * A career only says your name if the name gets everywhere, so the derivations
 * that turn what somebody typed into what the simulation needs — the broadcast
 * code, the nationality, the race number — live here rather than being inlined
 * at the create screen, and `probe:identity` asserts them.
 */

import { Rng } from '../core/MathUtils';

// ===========================================================================
// The broadcast code
// ===========================================================================

/**
 * The three letters that appear on the timing tower.
 *
 * The old derivation was `lastName.slice(0, 3).toUpperCase().padEnd(3, 'X')`,
 * which is right most of the time and wrong in the two cases somebody actually
 * hits: a surname with a diacritic gives a code with a diacritic in it — Ž is
 * not a broadcast character — and a two-letter surname gives "WUX".
 *
 * Spaces and apostrophes are dropped before the cut, so "de Vries" gives DEV
 * and "O'Sullivan" gives OSU, which is what the real timing screens show.
 */
export function driverCode(lastName: string): string {
  const stripped = lastName
    .normalize('NFD')
    // Combining marks. Ž -> Z, ő -> o, ç -> c.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  if (stripped.length >= 3) return stripped.slice(0, 3);
  // A surname too short to fill the field is padded from the given name in
  // real life; with nothing to borrow from, the last letter is doubled, which
  // at least reads as a code rather than as an error.
  if (stripped.length === 2) return stripped + stripped[1];
  if (stripped.length === 1) return stripped + stripped + stripped;
  return 'DRV';
}

/**
 * A code nobody else on the grid is using.
 *
 * Two drivers sharing a code is not fatal — the tower would simply print the
 * same three letters twice — but it is the kind of detail that tells a player
 * the game is not really theirs. The walk is over the second and third letters
 * of the surname before it gives up and counts, so "ZDR" busy gives "ZDA" then
 * "ZDB", which still reads as the same person's code.
 */
export function uniqueDriverCode(lastName: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toUpperCase());
  const base = driverCode(lastName);
  if (!used.has(base)) return base;

  const letters = lastName.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '').toUpperCase();
  for (let i = 3; i < letters.length; i++) {
    const c = base.slice(0, 2) + letters[i];
    if (!used.has(c)) return c;
  }
  for (let i = 0; i < 26; i++) {
    const c = base.slice(0, 2) + String.fromCharCode(65 + i);
    if (!used.has(c)) return c;
  }
  return base;
}

// ===========================================================================
// Nationality
// ===========================================================================

/**
 * The nations a driver can be from.
 *
 * A LIST RATHER THAN A TEXT FIELD, because the create screen used to ask the
 * player to type "United Kingdom" and a typed nationality is a string nothing
 * downstream can do anything with. As a chosen value it carries a three-letter
 * code the boards can print in the column they already have for one, and two
 * colours for the plate behind it.
 *
 * The colours are the flag's principal two. They are NOT a drawing of the flag:
 * nothing here reproduces a coat of arms, a canton or an emblem, and a flag
 * drawn approximately is worse than a plate with the country's code on it.
 * `src/ui/DriverPortrait.ts` draws the plate.
 *
 * The set is the nations that have actually put drivers on a Formula 1 grid,
 * plus the junior formulae's, which is what makes it feel like a paddock rather
 * than a dropdown of every country in the world.
 */
export interface Nation {
  name: string;
  /** Three-letter code, as the timing boards print it. */
  code: string;
  /** The flag's two principal colours, for the plate. */
  colours: [number, number];
}

export const NATIONS: readonly Nation[] = [
  { name: 'Argentina', code: 'ARG', colours: [0x75aadb, 0xffffff] },
  { name: 'Australia', code: 'AUS', colours: [0x00843d, 0xffcd00] },
  // Bahrain is on the calendar and was not on this list, so #77's contract
  // chart drew the `FIA` fallback plate under a Bahrain grand prix. Every
  // country in `src/data/tracks/circuits.ts` is here now.
  { name: 'Bahrain', code: 'BHR', colours: [0xce1126, 0xffffff] },
  { name: 'Austria', code: 'AUT', colours: [0xed2939, 0xffffff] },
  { name: 'Belgium', code: 'BEL', colours: [0xfdda24, 0x000000] },
  { name: 'Brazil', code: 'BRA', colours: [0x009c3b, 0xffdf00] },
  { name: 'Canada', code: 'CAN', colours: [0xd80621, 0xffffff] },
  { name: 'China', code: 'CHN', colours: [0xde2910, 0xffde00] },
  { name: 'Colombia', code: 'COL', colours: [0xfcd116, 0x003893] },
  { name: 'Czechia', code: 'CZE', colours: [0xd7141a, 0x11457e] },
  { name: 'Denmark', code: 'DEN', colours: [0xc8102e, 0xffffff] },
  { name: 'Estonia', code: 'EST', colours: [0x0072ce, 0x000000] },
  { name: 'Finland', code: 'FIN', colours: [0x003580, 0xffffff] },
  { name: 'France', code: 'FRA', colours: [0x0055a4, 0xef4135] },
  { name: 'Germany', code: 'GER', colours: [0x000000, 0xdd0000] },
  { name: 'India', code: 'IND', colours: [0xff9933, 0x138808] },
  { name: 'Indonesia', code: 'INA', colours: [0xce1126, 0xffffff] },
  { name: 'Ireland', code: 'IRL', colours: [0x169b62, 0xff883e] },
  { name: 'Israel', code: 'ISR', colours: [0x0038b8, 0xffffff] },
  { name: 'Italy', code: 'ITA', colours: [0x008c45, 0xcd212a] },
  { name: 'Japan', code: 'JPN', colours: [0xbc002d, 0xffffff] },
  { name: 'Mexico', code: 'MEX', colours: [0x006847, 0xce1126] },
  { name: 'Monaco', code: 'MON', colours: [0xce1126, 0xffffff] },
  { name: 'Netherlands', code: 'NED', colours: [0xae1c28, 0x21468b] },
  { name: 'New Zealand', code: 'NZL', colours: [0x00247d, 0xcc142b] },
  { name: 'Poland', code: 'POL', colours: [0xdc143c, 0xffffff] },
  { name: 'Portugal', code: 'POR', colours: [0x006600, 0xff0000] },
  { name: 'Saudi Arabia', code: 'KSA', colours: [0x006c35, 0xffffff] },
  { name: 'South Africa', code: 'RSA', colours: [0x007a4d, 0xffb612] },
  // Every nationality that appears in `src/data/roster/` is here. Singapore
  // and Sri Lanka were missing and two Formula 3 drivers drew the `FIA`
  // fallback plate on #77's market table because of it.
  { name: 'Singapore', code: 'SGP', colours: [0xed2939, 0xffffff] },
  { name: 'Sri Lanka', code: 'SRI', colours: [0x8d2029, 0xffb700] },
  { name: 'Spain', code: 'ESP', colours: [0xaa151b, 0xf1bf00] },
  { name: 'Sweden', code: 'SWE', colours: [0x006aa7, 0xfecc00] },
  { name: 'Switzerland', code: 'SUI', colours: [0xd52b1e, 0xffffff] },
  { name: 'Thailand', code: 'THA', colours: [0xa51931, 0x2d2a4a] },
  { name: 'United Arab Emirates', code: 'UAE', colours: [0x00732f, 0xff0000] },
  { name: 'United Kingdom', code: 'GBR', colours: [0x012169, 0xc8102e] },
  { name: 'United States', code: 'USA', colours: [0x3c3b6e, 0xb22234] },
  { name: 'Uruguay', code: 'URU', colours: [0x0038a8, 0xffffff] },
];

const NATION_BY_NAME = new Map(NATIONS.map((n) => [n.name.toLowerCase(), n]));

/** Fallback for a nationality that came from a save older than the list. */
const UNKNOWN_NATION: Nation = { name: 'International', code: 'FIA', colours: [0x2b3440, 0x93a1b2] };

/**
 * The nation record for a nationality string.
 *
 * Never throws and never returns undefined, because a career that was created
 * before this list existed has a free-typed nationality in it and that career
 * still has to open.
 */
export function nationOf(nationality: string): Nation {
  return NATION_BY_NAME.get(nationality.trim().toLowerCase()) ?? {
    ...UNKNOWN_NATION,
    // Keep whatever they typed, so the hub still says where they are from.
    name: nationality.trim() || UNKNOWN_NATION.name,
  };
}

// ===========================================================================
// The race number
// ===========================================================================

/**
 * Numbers a driver may choose.
 *
 * 2 to 99, because 1 belongs to the reigning World Champion and 0 and negative
 * numbers are not numbers a car carries. Whatever is already on the grid is
 * excluded — two cars in one championship cannot share a number, and finding
 * out that yours was taken after the season started is not a discovery anybody
 * enjoys.
 */
export function availableNumbers(taken: Iterable<number>): number[] {
  const used = new Set<number>(taken);
  const out: number[] = [];
  for (let n = 2; n <= 99; n++) if (!used.has(n)) out.push(n);
  return out;
}

// ===========================================================================
// The helmet
// ===========================================================================

export type HelmetFamilyId =
  | 'plain' | 'centreline' | 'quarters' | 'chevron'
  | 'halo' | 'blade' | 'starburst' | 'bands';

export interface HelmetFamily {
  id: HelmetFamilyId;
  name: string;
  /** One line, in the voice of somebody describing their own helmet. */
  note: string;
}

/**
 * The pattern families.
 *
 * Eight, and every one of them is an idiom that has been on a real helmet for
 * fifty years — a centre stripe, a quartered shell, a chevron over the temple.
 * None of them is a copy of a specific design, because none of them is specific:
 * they are the grammar, and the player's three colours are the sentence.
 */
export const HELMET_FAMILIES: readonly HelmetFamily[] = [
  { id: 'centreline', name: 'Centre stripe', note: 'One stripe over the crown, front to back.' },
  { id: 'quarters', name: 'Quarters', note: 'Split on the diagonal. Two halves, two colours.' },
  { id: 'chevron', name: 'Chevron', note: 'Arrowheads over the temple, pointing where you are going.' },
  { id: 'halo', name: 'Halo', note: 'A band around the shell, above the visor.' },
  { id: 'blade', name: 'Blade', note: 'A wedge swept back from the visor.' },
  { id: 'starburst', name: 'Starburst', note: 'Rays off the crown. Loud, and meant to be.' },
  { id: 'bands', name: 'Bands', note: 'Three stripes low on the shell.' },
  { id: 'plain', name: 'Plain', note: 'Shell, trim, nothing else. Confidence, or a rookie budget.' },
];

export type VisorTint = 'dark' | 'gold' | 'blue' | 'clear';

export interface VisorOption {
  id: VisorTint;
  name: string;
  /** Fill of the visor, over the shell. */
  fill: string;
  /** The specular streak across it. */
  sheen: string;
}

export const VISORS: readonly VisorOption[] = [
  { id: 'dark', name: 'Dark', fill: '#0b0f14', sheen: 'rgba(190, 215, 255, 0.42)' },
  { id: 'gold', name: 'Gold', fill: '#3a2c0e', sheen: 'rgba(255, 214, 120, 0.72)' },
  { id: 'blue', name: 'Blue', fill: '#0c1c33', sheen: 'rgba(140, 190, 255, 0.62)' },
  { id: 'clear', name: 'Clear', fill: '#111820', sheen: 'rgba(226, 238, 255, 0.30)' },
];

/**
 * The colours on offer.
 *
 * A PALETTE, NOT A COLOUR PICKER. Two reasons, and the second is the real one.
 * A picker lets a player choose #2b2b2d on #2c2c2e and produce a helmet with no
 * design on it at all. And a fixed set of pigments is what a helmet painter
 * actually works from — these are racing colours, mixed to sit at similar
 * lightness so any pair of them holds a pattern.
 */
export interface Pigment { name: string; hex: number }

export const HELMET_PIGMENTS: readonly Pigment[] = [
  { name: 'Chalk', hex: 0xf2f3f5 },
  { name: 'Jet', hex: 0x14171c },
  { name: 'Signal red', hex: 0xe11d2e },
  { name: 'Papaya', hex: 0xff7a1a },
  { name: 'Amber', hex: 0xffc61a },
  { name: 'Acid', hex: 0xc8f21f },
  { name: 'Racing green', hex: 0x0f7a45 },
  { name: 'Teal', hex: 0x11b3b3 },
  { name: 'Cobalt', hex: 0x1f56d6 },
  { name: 'Midnight', hex: 0x111f4a },
  { name: 'Violet', hex: 0x8b3ce8 },
  { name: 'Magenta', hex: 0xe0219b },
  { name: 'Rosé', hex: 0xf2a9c0 },
  { name: 'Sand', hex: 0xcbb28a },
  { name: 'Gunmetal', hex: 0x59636f },
  { name: 'Bronze', hex: 0xa9702f },
];

export interface HelmetDesign {
  family: HelmetFamilyId;
  /** The shell. */
  base: number;
  /** The pattern painted on it. */
  stripe: number;
  /** The line that separates the two, and the ring at the aperture. */
  trim: number;
  visor: VisorTint;
}

/** Everything a helmet can be, for the designer's arrows to walk. */
export const HELMET_FAMILY_IDS: readonly HelmetFamilyId[] = HELMET_FAMILIES.map((f) => f.id);

export function familyOf(id: HelmetFamilyId): HelmetFamily {
  return HELMET_FAMILIES.find((f) => f.id === id) ?? HELMET_FAMILIES[0];
}

export function visorOf(id: VisorTint): VisorOption {
  return VISORS.find((v) => v.id === id) ?? VISORS[0];
}

/**
 * A helmet to open the designer on.
 *
 * Rolled from the career's seed rather than fixed, so two players who never
 * touch the designer do not end up with the same helmet, and CONTRASTING by
 * construction: the stripe is picked from the pigments furthest in lightness
 * from the shell, so the opening design always has a visible pattern on it.
 * A designer whose default looks like a mistake does not invite anybody in.
 */
export function defaultHelmet(seed: number): HelmetDesign {
  const rng = new Rng(seed ^ 0x4a1b93f5);
  const base = HELMET_PIGMENTS[Math.floor(rng.next() * HELMET_PIGMENTS.length)];
  const lum = (hex: number) => {
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const baseLum = lum(base.hex);
  const contrasting = HELMET_PIGMENTS
    .filter((p) => Math.abs(lum(p.hex) - baseLum) > 0.28);
  const pool = contrasting.length > 0 ? contrasting : HELMET_PIGMENTS;
  const stripe = pool[Math.floor(rng.next() * pool.length)];
  const trim = baseLum > 0.5 ? 0x14171c : 0xf2f3f5;
  return {
    family: HELMET_FAMILY_IDS[Math.floor(rng.next() * HELMET_FAMILY_IDS.length)],
    base: base.hex,
    stripe: stripe.hex,
    trim,
    visor: VISORS[Math.floor(rng.next() * VISORS.length)].id,
  };
}

/**
 * A helmet for an AI driver.
 *
 * Derived from their id, so every driver on the grid has one, it is the same
 * one every time the career is opened, and it is not stored — twenty helmets in
 * every save for people the player will never look at twice is eighty kilobytes
 * spent badly. The player's helmet IS stored, because the player chose it.
 */
export function helmetForDriver(driverId: string): HelmetDesign {
  let h = 0x811c9dc5;
  for (let i = 0; i < driverId.length; i++) {
    h ^= driverId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return defaultHelmet(h);
}

/** Normalises whatever came out of a save into a helmet that can be drawn. */
export function coerceHelmet(value: unknown, fallbackSeed: number): HelmetDesign {
  const d = defaultHelmet(fallbackSeed);
  if (!value || typeof value !== 'object') return d;
  const v = value as Partial<HelmetDesign>;
  return {
    family: HELMET_FAMILY_IDS.includes(v.family as HelmetFamilyId)
      ? (v.family as HelmetFamilyId) : d.family,
    base: typeof v.base === 'number' ? v.base : d.base,
    stripe: typeof v.stripe === 'number' ? v.stripe : d.stripe,
    trim: typeof v.trim === 'number' ? v.trim : d.trim,
    visor: VISORS.some((x) => x.id === v.visor) ? (v.visor as VisorTint) : d.visor,
  };
}

/** `#rrggbb`, which is what SVG and CSS both want. */
export function hex(colour: number): string {
  return '#' + (colour >>> 0).toString(16).padStart(6, '0').slice(-6);
}
