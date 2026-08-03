import { Rng } from '../../core/MathUtils';

/**
 * A person, as twenty numbers.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE FACES HERE AT ALL, HAVING ARGUED THERE SHOULD NOT BE
 * ---------------------------------------------------------------------------
 *
 * `src/career/Identity.ts` makes the case for a helmet instead of a face, and
 * it is still right for the driver: a driver in a car IS a helmet, and the
 * player designs it. But a career is not only a driver in a car. It has a team
 * principal telling you what the board thinks, a press conference where three
 * people sit behind a desk answering questions, and a podium where the first
 * thing that happens is that the helmet comes off. In every one of those the
 * helmet dodge fails, and what was left instead was a single grey silhouette on
 * a coloured disc reused for all eleven teams — which produced the exact
 * complaint that started this work: "why does it seem like the same person as
 * the team principal for all the teams? that doesn't make sense."
 *
 * It did not make sense. So there are faces now.
 *
 * ---------------------------------------------------------------------------
 * THE REGISTER, AND WHY IT IS NOT THE OBVIOUS ONE
 * ---------------------------------------------------------------------------
 *
 * Two ways to draw a generated face and both of them are traps.
 *
 *   · A 3D HEAD. The failure mode named in the brief, and correctly: a
 *     parametric skull with a parametric nose on it, lit by the same renderer
 *     that lights a car, lands in the uncanny valley and never climbs out. It
 *     would also be the only thing in this game whose cost lands during a
 *     session. Refused.
 *   · A FLAT AVATAR. Two dot eyes, a smile arc, a circle for a head. This is
 *     what every generated-avatar library produces, it is instantly readable as
 *     one, and it belongs to a different game — the brief's "obv forget about
 *     the lego people" rules out the blocky version of exactly this.
 *
 * What is drawn instead is a PLANAR PORTRAIT: a head whose features come from
 * LIGHT rather than from line. There is one key, warm, above and to the left —
 * the same key the rest of the interface is lit by, declared in `styles.css` and
 * already obeyed by the helmet portrait. The brow casts a band of shadow and the
 * eyes sit inside it. The nose is a shadow down one side and a highlight on the
 * bridge, with no outline anywhere. The jaw turns away from the light and takes
 * a shade across its lower right. The mouth is one soft dark stroke.
 *
 * That is how a title-sequence illustrator draws a face, and it has three
 * properties this project needs: it is entirely describable as numbers, it
 * cannot slip into cartoon because there are no cartoon primitives in it, and it
 * degrades to a correct silhouette at 32 pixels because the silhouette is doing
 * most of the work anyway.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES TWO PEOPLE DIFFERENT
 * ---------------------------------------------------------------------------
 *
 * Not the face. Faces differ here, but at the size these are seen the things
 * that actually tell two principals apart, in order of strength, are:
 *
 *   1. SILHOUETTE — the outline of the head with its hair on it. A shaved head
 *      beside a mass of curls beside a receding hairline are three different
 *      people from across a room; three noses are not.
 *   2. VALUE — how dark the person is against the backdrop, which is complexion
 *      and hair colour together.
 *   3. FURNITURE — glasses, a beard, a headset, a cap. Hard-edged, high-contrast
 *      objects that survive at any size.
 *   4. BUILD — a heavy man and a slight woman have different shoulders, and
 *      shoulders are a third of what is on screen in a bust.
 *
 * So the model spends its parameters there first. The facial proportions exist
 * and do move, but they are the last ten percent, not the first.
 */

// ===========================================================================
// Colour
// ===========================================================================

/**
 * A complexion, as three stops of one material under the fixed key.
 *
 * THREE STOPS RATHER THAN ONE COLOUR AND A MULTIPLY. Multiplying a skin colour
 * toward black to get its shadow is what makes generated portraits look like
 * plastic: real skin goes cooler and slightly redder into shadow and warmer into
 * the light, and the shift is not the same for a pale complexion as for a deep
 * one. Authoring all three is nine numbers per entry and it is the difference
 * between a face and a vinyl decal.
 *
 * THEY ARE NOT NAMED. Every other palette in this project — the helmet
 * pigments, the nation plates — carries names because the player picks from it.
 * Nobody picks a complexion here: a principal's is authored with their record
 * and everyone else's is derived from an id. A list of names for skin tones that
 * no interface ever shows is a liability with no upside, so these are indices.
 */
export interface Complexion {
  id: string;
  /** The lit plane: forehead, the bridge of the nose, the top of a cheek. */
  lift: string;
  /** The material, and most of the area. */
  base: string;
  /** The turned plane: under the brow, under the jaw, the shadow side. */
  shade: string;
}

export const COMPLEXIONS: readonly Complexion[] = [
  { id: 's1', lift: '#fbe2d2', base: '#f0c9b2', shade: '#c99b86' },
  { id: 's2', lift: '#f6d8bf', base: '#e8ba99', shade: '#bd8b6d' },
  { id: 's3', lift: '#eec9a4', base: '#dda87e', shade: '#ab7853' },
  { id: 's4', lift: '#e0b183', base: '#c9905d', shade: '#95633a' },
  { id: 's5', lift: '#cf9666', base: '#b0743f', shade: '#7d4d26' },
  { id: 's6', lift: '#b57c4c', base: '#8f5a2e', shade: '#61391a' },
  { id: 's7', lift: '#8f5c36', base: '#6b3f1f', shade: '#472510' },
  { id: 's8', lift: '#6b4128', base: '#4a2916', shade: '#2e170c' },
];

export function complexionOf(id: string): Complexion {
  return COMPLEXIONS.find((c) => c.id === id) ?? COMPLEXIONS[2];
}

/**
 * Hair, as two stops.
 *
 * `base` is the mass and `lift` the sheen the key catches off the top of it.
 * Grey is a separate entry rather than a modifier, and salt-and-pepper is its
 * own entry too, because a head that is greying at the temples is a specific
 * and recognisable thing rather than a lerp toward white.
 */
export interface HairPigment { id: string; base: string; lift: string }

export const HAIR_PIGMENTS: readonly HairPigment[] = [
  { id: 'jet', base: '#191a1f', lift: '#3b4048' },
  { id: 'dark', base: '#2c2119', lift: '#4e3c2c' },
  { id: 'brown', base: '#4a3423', lift: '#77563a' },
  { id: 'chestnut', base: '#5e3419', lift: '#8e5326' },
  { id: 'auburn', base: '#7a3418', lift: '#b45426' },
  { id: 'ginger', base: '#a8541d', lift: '#d9822f' },
  { id: 'sand', base: '#8a6b3c', lift: '#c1a068' },
  { id: 'blond', base: '#b28c4e', lift: '#e6c98a' },
  { id: 'pepper', base: '#3a3a3d', lift: '#8e9096' },
  { id: 'steel', base: '#6d7075', lift: '#a9adb4' },
  { id: 'silver', base: '#9aa0a8', lift: '#d6dae0' },
];

export function hairOf(id: string): HairPigment {
  return HAIR_PIGMENTS.find((h) => h.id === id) ?? HAIR_PIGMENTS[2];
}

// ===========================================================================
// Silhouette
// ===========================================================================

/**
 * The hair styles.
 *
 * Chosen for how different their OUTLINES are from each other, which is the
 * first thing in the list above. Two styles that differ only in parting are one
 * style as far as a player at arm's length is concerned, so there is one
 * parting and the rest of the set spends itself on volume and on where the mass
 * sits: none at all, close to the skull, high at the front, wide at the sides,
 * long past the jaw, gathered behind.
 */
export type HairStyle =
  | 'bald' | 'shaved' | 'crop' | 'receding' | 'side' | 'swept'
  | 'volume' | 'curls' | 'long' | 'tied' | 'bun';

export const HAIR_STYLES: readonly HairStyle[] = [
  'bald', 'shaved', 'crop', 'receding', 'side', 'swept',
  'volume', 'curls', 'long', 'tied', 'bun',
];

/** Beards, from nothing to a full one. `stubble` is a wash, not a shape. */
export type FacialHair = 'none' | 'stubble' | 'moustache' | 'goatee' | 'beard' | 'full';

export const FACIAL_HAIR: readonly FacialHair[] = [
  'none', 'stubble', 'moustache', 'goatee', 'beard', 'full',
];

/**
 * Glasses.
 *
 * The single highest-value accessory in the set. A pair of glasses is two hard
 * black rectangles across the one part of a face that a viewer looks at, it
 * survives being drawn at 24 pixels, and about a third of any real paddock is
 * wearing them.
 */
export type Eyewear = 'none' | 'rect' | 'round' | 'thin' | 'shades';

export const EYEWEAR: readonly Eyewear[] = ['none', 'rect', 'round', 'thin', 'shades'];

/**
 * What is on the head, over the hair.
 *
 * A team cap is the paddock uniform and it takes the team's colour, which makes
 * it do identity work as well as silhouette work. The headset is the pit wall.
 */
export type Headwear = 'none' | 'cap' | 'capBack' | 'headset' | 'capHeadset';

export const HEADWEAR: readonly Headwear[] = ['none', 'cap', 'capBack', 'headset', 'capHeadset'];

// ===========================================================================
// The record
// ===========================================================================

/**
 * Everything a person is.
 *
 * Twenty-one fields, all of them either a small integer, a palette id or a
 * number in 0..1. A principal's is authored by hand in `Principals.ts`; everyone
 * else's is derived from their id and stored nowhere.
 */
export interface PersonLook {
  // --- Colour ---
  complexion: string;
  hairPigment: string;

  // --- Silhouette ---
  hair: HairStyle;
  facialHair: FacialHair;
  eyewear: Eyewear;
  headwear: Headwear;

  /**
   * Build, 0..1. Drives shoulder width, neck thickness and torso taper
   * together, because they do not vary independently on a real body.
   */
  build: number;
  /** Height, 0..1. Only visible in a scene with more than one person in it. */
  height: number;

  // --- Head proportion. All 0..1, all centred on 0.5 = unremarkable. ---
  /** Width at the cheekbones. */
  headWidth: number;
  /** Crown to chin, against that width. */
  faceLength: number;
  /** Width at the angle of the jaw. Low is tapered, high is square. */
  jaw: number;
  /** Width at the chin itself. */
  chin: number;
  /** How far the brow overhangs. High reads as heavy and as older. */
  brow: number;
  /** How high the eyes sit in the face. */
  eyeLine: number;
  /** Distance between the eyes. */
  eyeSpacing: number;
  /** Length of the nose. */
  nose: number;
  /** Width of the nose. */
  noseWidth: number;
  /** Width of the mouth. */
  mouth: number;
  /** Fullness of the lips. */
  lips: number;
  /** How much the cheekbone catches the light. */
  cheek: number;

  /**
   * Where the head is pointing, -1 (their right, frame left) to 1.
   *
   * A ROW OF PEOPLE ALL FACING DEAD FRONT IS A LINE-UP AT A POLICE STATION. A
   * few degrees of turn per person, in different directions, is the whole
   * difference between a panel of three and a mugshot of three. It is not a
   * rotation: the feature centreline slides, the far half of the outline
   * narrows, and the far ear disappears. Three-quarters of the way to a real
   * head turn for a twentieth of the work.
   */
  turn: number;

  /**
   * Age, 0 (mid twenties) to 1 (seventies).
   *
   * Adds a nasolabial fold, a line under the eye, a heavier upper lid and — the
   * one that reads hardest — greys the hair independently of its pigment, so an
   * older person can still be recognisably dark-haired.
   */
  age: number;
}

// ===========================================================================
// Derivation
// ===========================================================================

/** FNV-1a. Same function the rest of the project hashes ids with. */
export function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A number in 0..1 with the middle of the range favoured. Two rolls, averaged. */
function centred(rng: Rng): number {
  return (rng.next() + rng.next()) * 0.5;
}

/** A number in 0..1 with the ENDS favoured — for the fields that must not blur. */
function spread(rng: Rng): number {
  const t = rng.next();
  return t < 0.5 ? t * 0.62 : 1 - (1 - t) * 0.62;
}

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng.next() * xs.length))];
}

/**
 * How much of the paddock each role is.
 *
 * A generated cast that draws uniformly from every option produces a paddock
 * where one team principal in eleven has a bun and one in eleven is wearing
 * sunglasses indoors, and that is not a paddock, it is a random number
 * generator with a face. So each role weights its own options: principals skew
 * older and are half of them greying; journalists are the only ones who are
 * ever scruffy; crew wear the team's cap and nothing else.
 */
export type PersonRole = 'principal' | 'driver' | 'journalist' | 'crew' | 'official' | 'guest';

interface RoleProfile {
  ageRange: [number, number];
  hair: readonly HairStyle[];
  facialHair: readonly FacialHair[];
  eyewear: readonly Eyewear[];
  headwear: readonly Headwear[];
  buildRange: [number, number];
}

const ROLES: Readonly<Record<PersonRole, RoleProfile>> = {
  // Fifty-something, mostly, and the greying is the point: a principal who
  // looks twenty-eight undermines every sentence they say to you.
  principal: {
    ageRange: [0.34, 0.92],
    hair: ['bald', 'shaved', 'crop', 'receding', 'receding', 'side', 'swept', 'volume', 'tied', 'bun'],
    facialHair: ['none', 'none', 'stubble', 'moustache', 'goatee', 'beard', 'full'],
    eyewear: ['none', 'none', 'rect', 'round', 'thin'],
    headwear: ['none', 'none', 'none', 'cap'],
    buildRange: [0.3, 0.85],
  },
  // Twenty to thirty-five, fit, and never in glasses on camera.
  driver: {
    ageRange: [0.0, 0.3],
    hair: ['shaved', 'crop', 'crop', 'side', 'swept', 'volume', 'curls', 'tied', 'long'],
    facialHair: ['none', 'none', 'none', 'stubble', 'goatee'],
    eyewear: ['none'],
    headwear: ['none', 'none', 'cap', 'capBack'],
    buildRange: [0.22, 0.58],
  },
  journalist: {
    ageRange: [0.1, 0.85],
    hair: ['bald', 'crop', 'receding', 'side', 'swept', 'volume', 'curls', 'long', 'tied', 'bun'],
    facialHair: ['none', 'stubble', 'stubble', 'goatee', 'beard', 'full'],
    eyewear: ['none', 'rect', 'rect', 'round', 'thin'],
    headwear: ['none', 'none', 'none', 'cap'],
    buildRange: [0.25, 0.9],
  },
  crew: {
    ageRange: [0.05, 0.6],
    hair: ['shaved', 'crop', 'side', 'tied', 'bun'],
    facialHair: ['none', 'stubble', 'goatee', 'beard'],
    eyewear: ['none', 'none', 'rect'],
    headwear: ['cap', 'cap', 'capBack', 'capHeadset', 'headset'],
    buildRange: [0.3, 0.75],
  },
  official: {
    ageRange: [0.4, 0.95],
    hair: ['bald', 'receding', 'crop', 'side', 'tied'],
    facialHair: ['none', 'none', 'moustache', 'beard'],
    eyewear: ['rect', 'rect', 'round', 'thin', 'none'],
    headwear: ['none', 'cap'],
    buildRange: [0.35, 0.9],
  },
  guest: {
    ageRange: [0.0, 0.9],
    hair: HAIR_STYLES,
    facialHair: FACIAL_HAIR,
    eyewear: EYEWEAR,
    headwear: ['none', 'none', 'cap', 'capBack'],
    buildRange: [0.2, 0.9],
  },
};

/**
 * A person from a seed.
 *
 * DETERMINISTIC AND NOT STORED, exactly as `helmetForDriver` is: the third
 * journalist in the fourth row of the press room is the same person every time
 * that press conference is opened, and not one byte of him is in the save.
 */
export function lookFromSeed(seed: number, role: PersonRole = 'guest'): PersonLook {
  const rng = new Rng((seed ^ 0x5bf03635) >>> 0);
  const p = ROLES[role];
  const age = p.ageRange[0] + rng.next() * (p.ageRange[1] - p.ageRange[0]);

  // Hair pigment, then the greying pass. Greying is applied to the PIGMENT
  // rather than blended at draw time so that a fifty-year-old is either "dark
  // hair going grey at the temples" or "grey", which is what heads actually do,
  // rather than a uniform desaturation nobody's hair has ever performed.
  let pigment = pick(rng, HAIR_PIGMENTS.slice(0, 8)).id;
  const greyChance = Math.max(0, (age - 0.32) * 1.35);
  if (rng.next() < greyChance) {
    pigment = pick(rng, ['pepper', 'pepper', 'steel', 'silver']);
  }

  return {
    complexion: pick(rng, COMPLEXIONS).id,
    hairPigment: pigment,
    hair: pick(rng, p.hair),
    facialHair: pick(rng, p.facialHair),
    eyewear: pick(rng, p.eyewear),
    headwear: pick(rng, p.headwear),
    build: p.buildRange[0] + centred(rng) * (p.buildRange[1] - p.buildRange[0]),
    height: centred(rng),
    headWidth: spread(rng),
    faceLength: spread(rng),
    jaw: spread(rng),
    chin: centred(rng),
    brow: centred(rng) * 0.6 + age * 0.4,
    eyeLine: centred(rng),
    eyeSpacing: centred(rng),
    nose: spread(rng),
    noseWidth: spread(rng),
    mouth: centred(rng),
    lips: centred(rng),
    cheek: centred(rng),
    // Never zero: a head pointing dead front is the mugshot the field exists to
    // avoid. Signed, so a row of people look in different directions.
    turn: (rng.next() < 0.5 ? -1 : 1) * (0.18 + rng.next() * 0.62),
    age,
  };
}

/** A person from a string id. */
export function lookFor(id: string, role: PersonRole = 'guest'): PersonLook {
  return lookFromSeed(hashOf(id), role);
}

/**
 * Fills in the fields an authored record left out.
 *
 * Authoring a principal means writing down the four or five things that make
 * them themselves — bald, heavy, glasses, sixty — and letting the rest come off
 * the hash of their name. Requiring all twenty-one fields per person would mean
 * eleven records nobody would ever update.
 */
export function look(id: string, role: PersonRole, over: Partial<PersonLook> = {}): PersonLook {
  return { ...lookFromSeed(hashOf(id), role), ...over };
}

/** Clamps whatever came out of a save or an author's hand into the legal range. */
export function coerceLook(value: unknown, fallbackSeed: number, role: PersonRole = 'guest'): PersonLook {
  const d = lookFromSeed(fallbackSeed, role);
  if (!value || typeof value !== 'object') return d;
  const v = value as Partial<PersonLook>;
  const n = (x: unknown, f: number, lo = 0, hi = 1): number =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : f;
  return {
    complexion: COMPLEXIONS.some((c) => c.id === v.complexion) ? v.complexion! : d.complexion,
    hairPigment: HAIR_PIGMENTS.some((h) => h.id === v.hairPigment) ? v.hairPigment! : d.hairPigment,
    hair: HAIR_STYLES.includes(v.hair as HairStyle) ? v.hair! : d.hair,
    facialHair: FACIAL_HAIR.includes(v.facialHair as FacialHair) ? v.facialHair! : d.facialHair,
    eyewear: EYEWEAR.includes(v.eyewear as Eyewear) ? v.eyewear! : d.eyewear,
    headwear: HEADWEAR.includes(v.headwear as Headwear) ? v.headwear! : d.headwear,
    build: n(v.build, d.build),
    height: n(v.height, d.height),
    headWidth: n(v.headWidth, d.headWidth),
    faceLength: n(v.faceLength, d.faceLength),
    jaw: n(v.jaw, d.jaw),
    chin: n(v.chin, d.chin),
    brow: n(v.brow, d.brow),
    eyeLine: n(v.eyeLine, d.eyeLine),
    eyeSpacing: n(v.eyeSpacing, d.eyeSpacing),
    nose: n(v.nose, d.nose),
    noseWidth: n(v.noseWidth, d.noseWidth),
    mouth: n(v.mouth, d.mouth),
    lips: n(v.lips, d.lips),
    cheek: n(v.cheek, d.cheek),
    turn: n(v.turn, d.turn, -1, 1),
    age: n(v.age, d.age),
  };
}

/**
 * How far apart two people look, 0..1.
 *
 * Not decoration: `probe:people` uses it to assert that no two principals on the
 * grid are within a threshold of each other, which is the machine-checkable form
 * of the complaint this whole module answers. It weights the four things the
 * header says actually distinguish people, in the same order.
 */
export function lookDistance(a: PersonLook, b: PersonLook): number {
  let d = 0;
  // Silhouette. The dominant term.
  if (a.hair !== b.hair) d += 0.30;
  if (a.facialHair !== b.facialHair) d += 0.12;
  if (a.headwear !== b.headwear) d += 0.10;
  // Value.
  const ci = (id: string) => COMPLEXIONS.findIndex((c) => c.id === id);
  d += Math.min(0.22, Math.abs(ci(a.complexion) - ci(b.complexion)) * 0.055);
  const hi = (id: string) => HAIR_PIGMENTS.findIndex((h) => h.id === id);
  d += Math.min(0.10, Math.abs(hi(a.hairPigment) - hi(b.hairPigment)) * 0.022);
  // Furniture.
  if (a.eyewear !== b.eyewear) d += 0.10;
  // Build and age.
  d += Math.min(0.08, Math.abs(a.build - b.build) * 0.14);
  d += Math.min(0.08, Math.abs(a.age - b.age) * 0.14);
  // Proportion, all of it together, worth less than any one of the above.
  const props: (keyof PersonLook)[] = [
    'headWidth', 'faceLength', 'jaw', 'chin', 'brow', 'nose', 'noseWidth', 'mouth',
  ];
  let prop = 0;
  for (const k of props) prop += Math.abs((a[k] as number) - (b[k] as number));
  d += Math.min(0.10, prop * 0.03);
  return Math.min(1, d);
}
