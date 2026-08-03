/**
 * The vocabulary a livery is designed in.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `Livery.ts`. That file imports three.js and
 * allocates textures, which makes it unusable from a headless probe and
 * expensive to reach from a menu. Everything here is plain data and plain canvas
 * geometry: the families, the palette, the marks and the finishes. So the
 * editor, the probe and the painter all agree about what a livery IS without any
 * of them having to build one.
 *
 * WHY THERE ARE FAMILIES AT ALL. The painter this replaces was good — three
 * unwrapped panels, a swept nose, a deck spine, race numbers, sponsor decals and
 * painted-in occlusion — and it had exactly one design. Every car on the grid was
 * the same drawing in different colours, which is the specific reason generated
 * liveries read as generated. Two colour pickers on top of that would have
 * produced the same grid with the player's hues in it.
 *
 * So the thing that varies is the ARRANGEMENT, and the palette is three colours
 * rather than two. The third one is what most people would not be able to name
 * and would immediately miss: real liveries almost always carry a thin line of a
 * third colour along the edge of the second — a pinstripe between the red and
 * the black — and it is most of the difference between a paint scheme and two
 * fields of colour meeting.
 */

export type LiveryFamilyId =
  | 'bolt' | 'stripe' | 'chevron' | 'wave' | 'split' | 'halo';

export type LiveryFinish = 'gloss' | 'satin' | 'matte';

export interface LiveryFamily {
  id: LiveryFamilyId;
  name: string;
  /** One sentence, in the player's language, about what it will look like. */
  note: string;
}

/**
 * Six arrangements of the same drawing vocabulary.
 *
 * Ordered loosest to tightest. `halo` is last and it is the one that will look
 * best, which is a thing worth knowing and worth not hiding: the restrained
 * option nearly always wins, and a designer's job is to make sure it is on the
 * list.
 */
export const LIVERY_FAMILIES: readonly LiveryFamily[] = [
  { id: 'bolt', name: 'Bolt', note: 'A swept nose, a deck spine and a flash down the flank.' },
  { id: 'stripe', name: 'Stripe', note: 'Twin racing stripes, nose to tail, over the airbox.' },
  { id: 'chevron', name: 'Chevron', note: 'Forward chevrons repeated down the sidepod.' },
  { id: 'wave', name: 'Wave', note: 'A curve rising off the floor into the airbox.' },
  { id: 'split', name: 'Split', note: 'One hard diagonal. Front half against rear half.' },
  { id: 'halo', name: 'Halo', note: 'Accent on the shoulder line only. The quiet one.' },
];

export const FINISHES: readonly { id: LiveryFinish; name: string; note: string }[] = [
  { id: 'gloss', name: 'Gloss', note: 'Wet-looking. Holds a hard highlight down the flank.' },
  { id: 'satin', name: 'Satin', note: 'The grid standard. A broad, soft sheen.' },
  { id: 'matte', name: 'Matte', note: 'No highlight at all. The shape does the work.' },
];

/**
 * A complete livery.
 *
 * `colour` and `accent` are not here: they live on the team, because the timing
 * tower, the pit board, the map and the generated team mark all read them and
 * none of those know what a pattern family is. This record is everything ELSE
 * the painter needs.
 */
export interface LiveryDesign {
  family: LiveryFamilyId;
  /** The third colour: pinstripes, hairlines, the mark's ground. */
  trim: number;
  finish: LiveryFinish;
  /** Index into `MARK_DEVICES`, or -1 for a car that carries no mark. */
  mark: number;
  /** Sponsor names, largest first. Empty falls back to the house set. */
  sponsors?: readonly string[];
}

/**
 * What a car with no design gets.
 *
 * `bolt`, `satin`, no mark, and the trim colour the swatch table already used —
 * chosen so that every car on the existing grid paints EXACTLY as it did before
 * families existed. `audit:car` and every screenshot of the twenty-two real
 * entrants are unchanged by this work, which is the property that made it safe
 * to do at all.
 */
export const DEFAULT_LIVERY_DESIGN: LiveryDesign = {
  family: 'bolt',
  trim: 0x1e222a,
  finish: 'satin',
  mark: -1,
};

// ===========================================================================
// The palette
// ===========================================================================

export interface Pigment {
  name: string;
  hex: number;
}

/**
 * The paint shelf.
 *
 * NOT A COLOUR WHEEL, and that is the point. A free picker gives everybody the
 * same three washed-out mid-tones, because the colours that look good on a car
 * are a narrow and specific set: deep and saturated for a base, bright and
 * legible for an accent, near-neutral for trim. These are chosen to look right
 * under this game's lighting in particular — a dark hall with one warm key —
 * where a pale mid-tone goes to mud and a fully saturated primary blows out.
 *
 * Every one of them is a colour a real car has been painted, and they are
 * grouped so the shelf reads as a shelf: the deep ones first, then the metals
 * and neutrals, then the brights that only work as an accent.
 */
export const PIGMENTS: readonly Pigment[] = [
  // Deep — these are base colours.
  { name: 'Racing Green', hex: 0x0f4d35 },
  { name: 'Oxford Blue', hex: 0x142a52 },
  { name: 'Midnight', hex: 0x10161f },
  { name: 'Oxblood', hex: 0x6b1420 },
  { name: 'Imperial', hex: 0x3d2470 },
  { name: 'Deep Teal', hex: 0x0e5a62 },
  { name: 'Bottle', hex: 0x1d3a2a },
  { name: 'Aubergine', hex: 0x361b33 },
  // Mid — base or accent.
  { name: 'Signal Red', hex: 0xc8102e },
  { name: 'Cobalt', hex: 0x1747b8 },
  { name: 'Papaya', hex: 0xef6014 },
  { name: 'Bronze', hex: 0x8a5a2b },
  { name: 'Gunmetal', hex: 0x2b3138 },
  { name: 'Slate', hex: 0x4c5a68 },
  { name: 'Rust', hex: 0x8f3b1a },
  { name: 'Sea', hex: 0x1f7f9c },
  // Light and bright — accent and trim.
  { name: 'Pearl', hex: 0xf2f5f9 },
  { name: 'Ivory', hex: 0xe8e0d0 },
  { name: 'Gold', hex: 0xe0a72c },
  { name: 'Chartreuse', hex: 0xc6d92e },
  { name: 'Lime', hex: 0x6fce3c },
  { name: 'Ice', hex: 0x9fc4d8 },
  { name: 'Magenta', hex: 0xd21b7c },
  { name: 'Carbon', hex: 0x14181d },
];

// ===========================================================================
// The mark
// ===========================================================================

/**
 * Ten geometric devices, painted rather than reproduced.
 *
 * THE SAME TEN the timing tower already draws beside every team's name
 * (`teamMarkSvg` in `src/ui/Hud.ts`), redrawn as canvas paths so that the badge
 * on the screen and the badge on the engine cover are the same badge. A team
 * whose mark on the tower and mark on the car disagree does not have a mark, it
 * has two decorations.
 *
 * They are DEVICES, not logos. Nothing here approximates any real team's badge,
 * which is the line `docs/CAREER_MODE.md` section 0 draws and does not cross:
 * naming a team is not reproducing its trademark, and an approximated badge
 * would be both infringing and visibly fake.
 *
 * Each function draws into a 24x24 box whose origin is already translated, with
 * `a` the accent and `p` the ground.
 */
export type MarkDevice = (
  ctx: CanvasRenderingContext2D, a: string, p: string, scale: number,
) => void;

export const MARK_NAMES: readonly string[] = [
  'Chevron', 'Bar', 'Half', 'Ring', 'Triangle',
  'Twin', 'Dot', 'Saltire', 'Crescent', 'Quarters',
];

export const MARK_DEVICES: readonly MarkDevice[] = [
  // 0 — chevron
  (c, a, _p, s) => {
    c.strokeStyle = a; c.lineWidth = 3.2 * s; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(9 * s, 6.5 * s); c.lineTo(15.5 * s, 12 * s); c.lineTo(9 * s, 17.5 * s);
    c.stroke();
  },
  // 1 — bar
  (c, a, _p, s) => { c.fillStyle = a; c.fillRect(3 * s, 9.8 * s, 18 * s, 4.4 * s); },
  // 2 — half disc
  (c, a, _p, s) => {
    c.fillStyle = a;
    c.beginPath();
    c.arc(12 * s, 12 * s, 12 * s, -Math.PI / 2, Math.PI / 2);
    c.closePath();
    c.fill();
  },
  // 3 — ring
  (c, a, _p, s) => {
    c.strokeStyle = a; c.lineWidth = 3.2 * s;
    c.beginPath(); c.arc(12 * s, 12 * s, 6.4 * s, 0, Math.PI * 2); c.stroke();
  },
  // 4 — triangle
  (c, a, _p, s) => {
    c.fillStyle = a;
    c.beginPath();
    c.moveTo(12 * s, 4.6 * s); c.lineTo(18.6 * s, 17.2 * s); c.lineTo(5.4 * s, 17.2 * s);
    c.closePath(); c.fill();
  },
  // 5 — twin bars
  (c, a, _p, s) => {
    c.fillStyle = a;
    c.fillRect(5.5 * s, 6.4 * s, 4 * s, 11.2 * s);
    c.fillRect(14.5 * s, 6.4 * s, 4 * s, 11.2 * s);
  },
  // 6 — dot
  (c, a, _p, s) => {
    c.fillStyle = a;
    c.beginPath(); c.arc(12 * s, 12 * s, 5.2 * s, 0, Math.PI * 2); c.fill();
  },
  // 7 — saltire
  (c, a, _p, s) => {
    c.strokeStyle = a; c.lineWidth = 3.2 * s; c.lineCap = 'round';
    c.beginPath();
    c.moveTo(7.4 * s, 7.4 * s); c.lineTo(16.6 * s, 16.6 * s);
    c.moveTo(16.6 * s, 7.4 * s); c.lineTo(7.4 * s, 16.6 * s);
    c.stroke();
  },
  // 8 — crescent
  (c, a, p, s) => {
    c.fillStyle = a;
    c.beginPath(); c.arc(11 * s, 12 * s, 8 * s, 0, Math.PI * 2); c.fill();
    c.fillStyle = p;
    c.beginPath(); c.arc(15.6 * s, 12 * s, 7 * s, 0, Math.PI * 2); c.fill();
  },
  // 9 — quarters
  (c, a, _p, s) => {
    c.fillStyle = a;
    c.fillRect(12 * s, 4 * s, 7 * s, 8 * s);
    c.fillRect(5 * s, 12 * s, 7 * s, 8 * s);
  },
];

/**
 * Draws a mark into a box.
 *
 * The disc is the ground and the device sits on it, exactly as on the tower. The
 * hairline round the edge is what stops a dark mark disappearing into a dark
 * engine cover, and it is why the tower has one too.
 */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
  device: number, ground: string, accent: string,
): void {
  const i = ((device % MARK_DEVICES.length) + MARK_DEVICES.length) % MARK_DEVICES.length;
  const s = size / 24;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.beginPath();
  ctx.arc(12 * s, 12 * s, 12 * s, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, size, size);
  MARK_DEVICES[i](ctx, accent, ground, s);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.26)';
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.beginPath();
  ctx.arc(x, y, size * 0.466, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Whether a family id is one this build can paint. */
export function isLiveryFamily(id: string): id is LiveryFamilyId {
  return LIVERY_FAMILIES.some((f) => f.id === id);
}

/** Coerces whatever a save holds into a design that can definitely be painted. */
export function coerceDesign(raw: Partial<LiveryDesign> | undefined): LiveryDesign {
  if (!raw) return { ...DEFAULT_LIVERY_DESIGN };
  return {
    family: typeof raw.family === 'string' && isLiveryFamily(raw.family)
      ? raw.family : DEFAULT_LIVERY_DESIGN.family,
    trim: typeof raw.trim === 'number' && Number.isFinite(raw.trim)
      ? raw.trim & 0xffffff : DEFAULT_LIVERY_DESIGN.trim,
    finish: raw.finish === 'gloss' || raw.finish === 'matte' || raw.finish === 'satin'
      ? raw.finish : DEFAULT_LIVERY_DESIGN.finish,
    mark: typeof raw.mark === 'number' && Number.isFinite(raw.mark)
      ? Math.trunc(raw.mark) : DEFAULT_LIVERY_DESIGN.mark,
    sponsors: raw.sponsors,
  };
}
