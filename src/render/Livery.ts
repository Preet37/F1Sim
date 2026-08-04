import * as THREE from 'three';
import {
  DEFAULT_LIVERY_DESIGN, drawMark,
  type LiveryDesign, type LiveryFamilyId, type LiveryFinish,
} from './LiveryDesign';
import { brandImage, onBrandChange, type BrandImage } from './BrandAssets';

/**
 * Procedural team liveries.
 *
 * A livery is not a colour. Painting a car in one flat hue and a second flat hue
 * gives you a toy: real cars carry a contrasting nose, a flash that runs the
 * length of the sidepod and lifts over the engine cover, a race number, the
 * driver's three-letter code, and — the detail almost nobody notices consciously
 * but everybody notices — a matte/gloss split, where the deck and engine cover
 * are satin and the flanks are wet-looking. Those are graphics, and graphics need
 * a parameterisation, which is why the bodywork is lofted and carries UVs.
 *
 * Everything is drawn into a canvas at runtime. There are no image files in this
 * project and there will not be any.
 *
 * ONE TEXTURE PER CAR, ONE DRAW CALL PER CAR. The atlas holds three unwrapped
 * panels — monocoque, sidepod, airbox — plus a grid of flat swatches. Parts that
 * are a single colour (a wishbone, a tyre, a visor) pin all of their UVs to one
 * swatch texel, so they can live in the same merged geometry and the same
 * material as the painted panels. That is what keeps the whole shell of the car,
 * driver included, to a single draw call while still letting twenty cars look
 * completely different from one another.
 *
 * The roughness/metalness map is SHARED across every car, because how shiny a
 * panel is does not depend on what colour it is. Twenty cars therefore cost
 * twenty colour textures and one surface map.
 *
 * PANEL COORDINATES. Every painter works in (L, G): L runs 0 at the front of the
 * part to 1 at the back, G runs round the section — 0 and 1 on the bottom
 * centreline, 0.25 the left flank, 0.5 the top centreline, 0.75 the right flank.
 * The seam falls under the car where nothing is drawn. Sizes are given in METRES
 * and converted using each panel's real extent, because the atlas is not
 * isotropic and guessing in pixels produces text a metre long.
 */

export interface LiverySpec {
  /** Primary team colour. */
  colour: number;
  /** Secondary accent colour. */
  accent: number;
  /** Race number painted on the nose and engine cover. */
  number: number;
  /** Driver's three-letter code. */
  code: string;
  /**
   * Pattern family, trim colour, finish and mark.
   *
   * OPTIONAL, AND THAT IS THE WHOLE COMPATIBILITY STORY. `CarMesh.ts` builds
   * this record from a team's two colours and a driver's number and code, and it
   * belongs to another agent — so it does not pass a design and does not have
   * to. Absent, the design is looked up in the registry below by the team's
   * colour pair; absent from there too, it is `DEFAULT_LIVERY_DESIGN`, which
   * paints exactly what this file painted before families existed.
   */
  design?: LiveryDesign;
  /**
   * The team's id, and the ONLY thing that reaches `public/brand/<team-id>/`.
   *
   * Optional, and absent it behaves exactly as this file did before asset slots
   * existed: no team id, no slot lookup, no override, generated marks. It is
   * the id from `src/data/roster/` — `ferrari`, `mclaren`, `red-bull` — which
   * makes the artwork boundary the same boundary the names already use.
   */
  team?: string;
}

// ===========================================================================
// The design registry
// ===========================================================================

/**
 * Designs, keyed by the colour pair that identifies a team.
 *
 * WHY A REGISTRY AND NOT AN ARGUMENT. The one call site that builds a livery is
 * `shellMaterial` in `CarMesh.ts`, which is another agent's file and which knows
 * a team only as `colour, accent, number, code`. Threading a design through it
 * would mean changing `buildCar`, `CarStage`, the paddock screen and the intro
 * sequence — four files nobody involved in this work owns — for a value only one
 * car on the grid has.
 *
 * So a design is REGISTERED against the colour pair it belongs to, exactly the
 * way `CarMesh` already caches materials against the same pair. The career
 * registers the player's team on load and after the editor closes; every other
 * car looks itself up, finds nothing, and paints as it always has.
 */
const designs = new Map<string, LiveryDesign>();

/** Bumped on every registration, so a repaint cannot be served from the cache. */
let designEpoch = 0;

function designKey(colour: number, accent: number): string {
  return colour + ':' + accent;
}

/** Gives the car painted in these two colours a design of its own. */
export function registerLiveryDesign(
  colour: number, accent: number, design: LiveryDesign,
): void {
  designs.set(designKey(colour, accent), { ...design });
  designEpoch++;
}

/** Forgets every registered design. Called when a career is left. */
export function clearLiveryDesigns(): void {
  if (designs.size === 0) return;
  designs.clear();
  designEpoch++;
}

/** The design a car in these colours will be painted in. Never null. */
export function liveryDesignFor(colour: number, accent: number): LiveryDesign {
  return designs.get(designKey(colour, accent)) ?? DEFAULT_LIVERY_DESIGN;
}

export interface LiveryTextures {
  /** Base colour map. Per car. */
  map: THREE.CanvasTexture;
  /** Green = roughness, blue = metalness. Shared by every car. */
  surface: THREE.Texture;
}

/** A rectangle of the atlas, in UV space with v pointing up. */
interface Rect { u0: number; v0: number; u1: number; v1: number }

export type PanelName = 'body' | 'pod' | 'airbox' | 'helmet';

/**
 * Unwrapped panels, laid out so each one's LENGTH runs along the atlas's u axis.
 * The body gets the full width because it is by far the longest part.
 */
export const PANEL: Record<PanelName, Rect> = {
  body: { u0: 0.0, v0: 0.62, u1: 1.0, v1: 1.0 },
  pod: { u0: 0.0, v0: 0.40, u1: 1.0, v1: 0.60 },
  airbox: { u0: 0.0, v0: 0.20, u1: 0.62, v1: 0.38 },
  // The one piece of unused atlas there was, beside the airbox. At 512 it is
  // 184 by 97 pixels for a helmet whose circumference is about 600mm, which is
  // 300 pixels per metre — the densest thing on the sheet, and it has to be:
  // the helmet is 300mm across and the chase camera looks straight down onto it.
  helmet: { u0: 0.640, v0: 0.195, u1: 1.0, v1: 0.385 },
};

/** Real extents of each panel: length along the car, girth round the section. */
const PANEL_SIZE: Record<PanelName, { lengthM: number; girthM: number }> = {
  body: { lengthM: 4.86, girthM: 1.85 },
  pod: { lengthM: 2.87, girthM: 1.40 },
  airbox: { lengthM: 1.31, girthM: 0.80 },
  // Not a loft, so these are not a length and a girth: the helmet is unwrapped
  // as a projection (see `helmetUV` in DriverMesh) and the numbers below are
  // the circumference and the half-circumference of a 142mm shell, which is
  // what makes text on it come out the size it is asked for.
  helmet: { lengthM: 0.90, girthM: 0.45 },
};

const SWATCH_REGION: Rect = { u0: 0.0, v0: 0.0, u1: 1.0, v1: 0.18 };
const SWATCH_COLS = 6;
/**
 * THREE ROWS, NOT TWO, since the halo got its own paint (issue #34).
 *
 * Twelve names fitted a 6x2 grid exactly and the thirteenth does not, so the
 * grid grew a row rather than the region growing downward: `SWATCH_REGION` ends
 * at v = 0.18 and `PANEL.airbox` begins at 0.20, and taking that 0.02 would have
 * moved the airbox's own parameterisation. A third row costs each cell a third
 * of its height — 85 by 31 pixels at 512, 85 by 15 at 256 — and every cell is a
 * flat fill sampled at its centre, so its size is not load-bearing. The five
 * unused cells in the last row are never sampled by anything.
 */
const SWATCH_ROWS = 3;

export type SwatchName =
  | 'body' | 'accent' | 'carbon' | 'trim' | 'halo' | 'rim' | 'tyre'
  | 'glass' | 'light' | 'helmet' | 'suit' | 'glove' | 'dark';

/**
 * `halo` SITS IMMEDIATELY AFTER `trim`, AND THAT ADJACENCY IS LOAD-BEARING.
 *
 * The halo hoop is ONE tube carrying TWO swatches — the painted crown and the
 * dark fairing under it (see `flatSplit` in `CarMesh`) — so the triangles that
 * straddle the paint line have one vertex in each cell and the rasteriser
 * interpolates the UV between the two cell centres. Neighbouring cells in the
 * same row means that path crosses exactly one boundary between two flat fills:
 * a hard paint line with a texel of bilinear softening on it. Put the two cells
 * anywhere else on the sheet and the same interpolation sweeps through every
 * swatch in between, and the paint line acquires a band of tyre black and rim
 * silver in the middle of it.
 */
const SWATCH_ORDER: SwatchName[] = [
  'body', 'accent', 'carbon', 'trim', 'halo', 'rim',
  'tyre', 'glass', 'light', 'helmet', 'suit', 'glove',
  'dark',
];

function swatchRect(name: SwatchName): Rect {
  const i = SWATCH_ORDER.indexOf(name);
  const col = i % SWATCH_COLS;
  const row = Math.floor(i / SWATCH_COLS);
  const w = (SWATCH_REGION.u1 - SWATCH_REGION.u0) / SWATCH_COLS;
  const h = (SWATCH_REGION.v1 - SWATCH_REGION.v0) / SWATCH_ROWS;
  return {
    u0: SWATCH_REGION.u0 + col * w,
    v0: SWATCH_REGION.v0 + row * h,
    u1: SWATCH_REGION.u0 + (col + 1) * w,
    v1: SWATCH_REGION.v0 + (row + 1) * h,
  };
}

/** UV of the centre of a swatch cell. Used by `setFlatUV`. */
export function swatchUV(name: SwatchName): [number, number] {
  const r = swatchRect(name);
  return [(r.u0 + r.u1) * 0.5, (r.v0 + r.v1) * 0.5];
}

/**
 * The whole cell, in UV.
 *
 * Exported for `probe:halo`, which builds an emissive mask that lights up ONE
 * swatch cell and nothing else, so that the crown of the halo can be found in a
 * finished frame without the probe holding a second copy of where the halo is.
 * It reads the real layout out of this file rather than restating it, which is
 * the same rule `probe:framing` follows for `HALO_PATH`.
 */
export function swatchUVRect(name: SwatchName): Rect {
  return swatchRect(name);
}

/**
 * The same cell in CANVAS PIXELS, at a given atlas size.
 *
 * `Panel`'s own mapping, not a second copy of it: UV v runs from the bottom of
 * the sheet and canvas y from the top, and getting that inversion wrong puts a
 * mask two rows away from what it is supposed to be masking with no symptom
 * except a number that is quietly measuring the wrong object. Exported for
 * `probe:halo`, which paints one cell white on a black copy of the atlas and
 * uses it as an emissive map to find the crown in a finished frame.
 */
export function swatchPixelRect(
  name: SwatchName, size: number,
): { x: number; y: number; w: number; h: number } {
  const r = swatchRect(name);
  return {
    x: r.u0 * size,
    y: (1 - r.v1) * size,
    w: (r.u1 - r.u0) * size,
    h: (r.v1 - r.v0) * size,
  };
}

/**
 * What colour a given team's halo comes out, and how bright that is.
 *
 * The rule is `haloColour` and the luminance is `luminance`; this is the two of
 * them together so that `probe:halo` can print the whole grid without holding a
 * copy of either. A probe that re-implements the rule it is checking measures
 * its own copy — PROJECT.md §3.2 — which is exactly how `probe:activeaero`
 * managed to report four wing solutions on a grid where every car ran one.
 */
export function haloPaintForTeam(colour: number, accent: number): {
  colour: number; luminance: number; bodyLuminance: number;
} {
  const flash = contrastFlash(colour, accent);
  const paint = haloColour(colour, flash);
  return {
    colour: paint,
    luminance: luminance(paint),
    bodyLuminance: luminance(colour),
  };
}

// ===========================================================================
// Colour helpers
// ===========================================================================

function css(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * Intrinsic size of a dropped-in asset.
 *
 * `naturalWidth` FIRST, and `width` only as a fallback: an `HTMLImageElement`
 * that has never been in the document reports `width` as 0 whatever it decoded,
 * and every image this file draws comes from `BrandAssets` and has never been
 * in the document. An `ImageBitmap` has no `naturalWidth` at all and carries
 * `width`, which is the other half of why both are read.
 *
 * The 1:1 fallback covers an SVG with no intrinsic size — `<svg>` with a
 * viewBox and no width/height attribute, which is what most icon exporters
 * produce. Chrome reports naturalWidth 0 for it, and a square is the least
 * wrong guess for a badge.
 */
function imageWidth(img: BrandImage): number {
  const el = img as HTMLImageElement;
  return el.naturalWidth || (img.width as number) || 1;
}

function imageHeight(img: BrandImage): number {
  const el = img as HTMLImageElement;
  return el.naturalHeight || (img.height as number) || 1;
}

function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function pack(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** Blends toward white for t > 0 and toward black for t < 0. */
function shade(hex: number, t: number): number {
  const [r, g, b] = rgb(hex);
  const target = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  return pack(r + (target - r) * k, g + (target - g) * k, b + (target - b) * k);
}

function luminance(hex: number): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** White or near-black, whichever will actually be legible on the background. */
function readable(hex: number): string {
  return luminance(hex) > 0.45 ? '#0b0e13' : '#f4f7fa';
}

/**
 * The race suit's colour: the team's body colour, darkened.
 *
 * Exported because two modules paint the same driver. The shared shell puts it
 * on the `suit` swatch for the whole field; `buildCockpit` needs the same value
 * as a plain colour for the articulated arms it draws for the one car the
 * onboard camera is inside, and those two arms are in the same place.
 */
export function suitColour(bodyColour: number): number {
  return shade(bodyColour, -0.4);
}

/**
 * Picks the colour used for graphics that must contrast with the base coat.
 *
 * A few teams pair two dark colours or two light ones, and a nose flash that is
 * invisible against the body it sits on is worse than no flash at all.
 */
function contrastFlash(colour: number, accent: number): number {
  const dl = Math.abs(luminance(colour) - luminance(accent));
  if (dl > 0.16) return accent;
  return shade(accent, luminance(colour) > 0.4 ? -0.55 : 0.6);
}

/**
 * The floor under the halo's paint, and where it comes from.
 *
 * NOT A TASTE JUDGEMENT AND NOT A TOLERANCE. The hardware black this paint
 * replaces is `0x1e222a`, whose relative luminance is **0.132**. A "paint"
 * darker than the bare part it is painted over is not a paint — it is the same
 * near-black under a different name, and the whole defect in issue #34 is that
 * near-black arc having no silhouette. So the floor is the hardware's own
 * luminance with a small margin: below it, the team's colour cannot do the job
 * the reference frames show it doing and the accent is used instead.
 *
 * On the real 2026 grid this moves exactly ONE car of eleven. Body luminance:
 * Mercedes 0.776, Haas 0.732, Williams 0.706, McLaren 0.571, Racing Bulls
 * 0.567, Alpine 0.518, Aston Martin 0.489, Red Bull 0.418, Ferrari 0.206, Audi
 * 0.198 — all above. Cadillac's `0x1c1c28` is **0.113**, and it takes its own
 * gold accent, which is what a black-and-gold car's halo is anyway.
 */
const HALO_LUMA_FLOOR = 0.15;

/**
 * The near-black every unpainted fitting on the car is, in one place.
 *
 * It was a literal in `case 'trim'` and it is now named because the halo's
 * fairing, its pillar and its mounts all have to be exactly it — and because
 * `?haloUnpainted=1` has to be able to give the crown the same value, which is
 * the only way to measure the defect this file just fixed.
 */
const TRIM_HARDWARE = 0x1e222a;

/**
 * `?haloUnpainted=1` — re-introduces issue #34 on purpose.
 *
 * PROJECT.md §3.2: a probe a broken feature passes is worse than no probe, and
 * the only honest way to know this one can go red is to put the defect back.
 * With this set the `halo` swatch returns the hardware black the crown used to
 * take from `trim`, in colour AND in surface (see `surfaceFor`), so the frame
 * it draws is the frame `main` drew before this change — same geometry, same
 * UVs, one texel of the atlas filled differently. `probe:halo` measures both
 * arms and the separation between them is where its bound comes from.
 *
 * A query parameter rather than an env var because the thing being measured is
 * a rendered frame in a real browser, and `main.ts` already reads five of these
 * (`circuit`, `session`, `quality`, `wet`, `introslow`). Guarded for Node,
 * where `probe:carrig` and `audit:car` import this module with no `location`.
 */
const UNPAINTED_HALO = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('haloUnpainted') === '1';

/**
 * The halo's paint — issue #34.
 *
 * **Both reference frames paint it in the team's own colour**, and this rule is
 * read straight off them rather than invented. `reference/target/76.png` is the
 * Zandvoort onboard the user called *"the best image"*: a Mercedes whose body
 * is `0x27f4d2` teal in this roster, with the crown of the hoop that same teal
 * the whole way round the arc. `reference/target/90.png` is the Bahrain night
 * frame: an Aston Martin whose body is `0x229971` green, with the halo in that
 * green. In both, the painted colour is the BODY colour — so that is what this
 * returns, and the accent is a fallback for a car too dark to carry it.
 *
 * WHY THIS IS NOT THE `trim` SWATCH, which is where the halo used to be. That
 * swatch is shared with the painted suspension, and the note on `case 'trim'`
 * below records what happened when it was driven from the design's own trim
 * colour: an ivory trim turned every wishbone into a white rod. The halo is one
 * object of a known size in a known place, so it can carry a whole team colour
 * where a scatter of 20mm rods across the front of the car cannot. Splitting it
 * out is what lets the halo be painted WITHOUT the suspension being painted,
 * and it is the reason #34 was left for a pass that owned this file.
 */
function haloColour(body: number, flash: number): number {
  if (luminance(body) >= HALO_LUMA_FLOOR) return body;
  if (luminance(flash) >= HALO_LUMA_FLOOR) return flash;
  // Both dark. Lift the body rather than invent a third colour: a car with two
  // near-black colours still has to have a hoop somebody can see.
  return shade(body, 0.5);
}

// ===========================================================================
// Surface treatments
// ===========================================================================

/**
 * Draws a carbon-fibre twill into a rectangle.
 *
 * Bare carbon is the second most common surface on a modern car after paint —
 * the floor, the diffuser, the wishbones, the wing pylons, the underside of the
 * nose — and it is not "dark grey". It is a 2x2 twill whose tows run at forty
 * five degrees and alternate direction every cell, so it catches light in two
 * distinct directions and shimmers as the car turns. Painting it flat grey is
 * what makes a procedural car's floor look like a sheet of plastic.
 *
 * The weave is drawn small enough that at any real viewing distance it reads as
 * a subtle directional sheen rather than as a checkerboard, which is exactly
 * what it does on the real thing.
 */
function carbonFill(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  base: string, cell: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);

  const c = Math.max(2, cell);
  const cols = Math.ceil(w / c) + 1;
  const rows = Math.ceil(h / c) + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // 2x2 twill: the tow direction flips on a diagonal, which is what gives
      // carbon its characteristic interlocked-square look.
      const warp = ((i + j) & 2) === 0;
      const px = x + i * c;
      const py = y + j * c;
      ctx.fillStyle = warp ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.30)';
      if (warp) ctx.fillRect(px, py, c, c * 0.5);
      else ctx.fillRect(px, py, c * 0.5, c);
    }
  }
  ctx.restore();
}

let carbonTex: { map: THREE.CanvasTexture; surface: THREE.CanvasTexture } | null = null;

/**
 * A standalone tiling carbon weave, for parts that are not on the livery atlas.
 *
 * The cockpit is the obvious customer. It is the surface closest to the camera
 * in the view the game is mostly played from, so it is the one place where a
 * flat dark grey is not merely dull but actually reads as a bug — at half a
 * metre the eye expects to resolve the weave and gets a painted board instead.
 *
 * Shared by every car that has one, which is one car.
 */
export function buildCarbonTexture(): { map: THREE.CanvasTexture; surface: THREE.CanvasTexture } {
  if (carbonTex) return carbonTex;
  const size = 256;

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  // Eight cells across the tile. Any more and the weave aliases into grey at
  // the distances this is actually seen from.
  carbonFill(ctx, 0, 0, size, size, '#15171c', size / 8);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  map.needsUpdate = true;

  // The weave is also a roughness pattern, not just a colour one: the resin
  // sits in the troughs between tows and pools glossier there. Reusing the same
  // twill for both is what makes it catch light in two directions.
  const s = document.createElement('canvas');
  s.width = s.height = size;
  const sctx = s.getContext('2d')!;
  // roughness 0.33, metalness 0.02 — the same Fresnel floor `buildSurfaceMap`
  // uses for lacquered carbon. It was 5, which is not a material: dry laminate
  // and the resin over it are both dielectrics, and the difference between them
  // is gloss, which is the green channel's job and not the blue one's.
  sctx.fillStyle = 'rgb(0,84,5)';
  sctx.fillRect(0, 0, size, size);
  carbonFill(sctx, 0, 0, size, size, 'rgb(0,84,5)', size / 8);
  const surface = new THREE.CanvasTexture(s);
  surface.colorSpace = THREE.NoColorSpace;
  surface.wrapS = surface.wrapT = THREE.RepeatWrapping;
  surface.anisotropy = 4;
  surface.needsUpdate = true;

  carbonTex = { map, surface };
  return carbonTex;
}

/**
 * The sponsor set.
 *
 * A real car is covered in them, and their absence is one of the loudest tells
 * that a livery is generated: a car painted in two clean colours with nothing
 * written on it reads as a concept render, not as something that goes racing.
 * These are invented names — the point is the visual rhythm of small blocks of
 * type at varying weights and sizes, not the words.
 */
const SPONSORS = [
  'VERTIGO', 'GOLDMINE', 'DATA·AUDIT', 'PROLINE', 'HAZEDTIFY',
  'MAXPOWER', 'WAVELESS', 'NEBULA', 'ARALDI', 'LUMINARE',
] as const;

/**
 * The names painted on this car.
 *
 * A design may carry its own set — which is where the sponsorship system will
 * plug in, largest deal first — and falls back to the house set otherwise. THE
 * SET IS AND STAYS FICTIONAL. A sponsor's name down the side of a car at 115mm
 * is a reproduced wordmark, which is exactly the thing `docs/CAREER_MODE.md`
 * section 0 rules out, and it is ruled out whether the team wearing it is real
 * or not.
 */
function sponsorSet(d: LiveryDesign): readonly string[] {
  return d.sponsors && d.sponsors.length > 0 ? d.sponsors : SPONSORS;
}

// ===========================================================================
// Asset slot overrides
// ===========================================================================

/**
 * What `public/brand/<team-id>/` has for this car, if anything.
 *
 * ALL THREE FIELDS ARE NULL ON EVERY BUILD THAT SHIPS, which is the property
 * the whole exercise turns on. `brandImage` returns null for a slot with no
 * file, and every use of these below is a branch that is then not taken — never
 * a different code path, never a different constant, never a reordered draw. So
 * a car with no artwork on disk is painted by exactly the instruction sequence
 * that painted it before this existed, and `probe:assets` §3 sha256s that claim
 * rather than restating it.
 *
 * `spec.team` absent short-circuits the lookup entirely, so the six probes and
 * two audit harnesses that build a car without a team id do not even ask.
 */
interface BrandOverrides {
  /** Replaces the generated `MARK_DEVICES` badge on the deck and the flanks. */
  badge: BrandImage | null;
  /** Replaces the title sponsor's wordmark on the sidepod. */
  sponsor: BrandImage | null;
  /** A whole replacement atlas — a community livery, drawn over the panels. */
  livery: BrandImage | null;
}

const NO_BRAND: BrandOverrides = { badge: null, sponsor: null, livery: null };

function brandFor(spec: LiverySpec): BrandOverrides {
  if (!spec.team) return NO_BRAND;
  const badge = brandImage(spec.team, 'badge');
  const sponsor = brandImage(spec.team, 'sponsor');
  const livery = brandImage(spec.team, 'livery');
  if (!badge && !sponsor && !livery) return NO_BRAND;
  return { badge, sponsor, livery };
}

// ===========================================================================
// Canvas plumbing
// ===========================================================================

/**
 * Drawing helper bound to one atlas rectangle.
 *
 * Local coordinates are (L, G) — see the file header — and text sizes are in
 * metres, converted through the panel's real extent. Without that conversion the
 * atlas's anisotropy leaks into every graphic drawn on the car.
 */
class Panel {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Canvas pixels per metre along the car, and round the section. */
  readonly pxL: number;
  readonly pxG: number;

  constructor(
    readonly ctx: CanvasRenderingContext2D,
    rect: Rect,
    size: number,
    lengthM = 1,
    girthM = 1,
  ) {
    this.x = rect.u0 * size;
    this.y = (1 - rect.v1) * size;
    this.w = (rect.u1 - rect.u0) * size;
    this.h = (rect.v1 - rect.v0) * size;
    this.pxL = this.w / lengthM;
    this.pxG = this.h / girthM;
  }

  px(l: number): number { return this.x + l * this.w; }
  py(g: number): number { return this.y + g * this.h; }

  fill(colour: string): void {
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(this.x, this.y, this.w, this.h);
  }

  /** Fills a rectangle of the panel. */
  band(l0: number, l1: number, g0: number, g1: number, colour: string): void {
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(this.px(l0), this.py(g0), (l1 - l0) * this.w, (g1 - g0) * this.h);
  }

  /** Fills a rectangle of the panel with carbon-fibre twill. */
  carbon(l0: number, l1: number, g0: number, g1: number, base: string): void {
    // The weave cell is sized in metres, so it comes out the same physical
    // scale on the sidepod as on the monocoque despite the two panels having
    // completely different pixel densities.
    carbonFill(
      this.ctx, this.px(l0), this.py(g0), (l1 - l0) * this.w, (g1 - g0) * this.h,
      base, Math.max(2, 0.011 * this.pxG),
    );
  }

  /**
   * Darkens a strip with a soft gradient — occlusion, painted in.
   *
   * Screen-space AO cannot see into a gap narrower than its sampling radius,
   * and the places a car is darkest are exactly those: the shut line where the
   * engine cover meets the chassis, the tuck under a shoulder, the inside of an
   * inlet. Painting them costs nothing at runtime and it is what makes the
   * bodywork read as separate mouldings bolted together rather than as one
   * extruded lump.
   */
  shadeBand(l0: number, l1: number, g0: number, g1: number, strength: number): void {
    const c = this.ctx;
    const y0 = this.py(g0);
    const y1 = this.py(g1);
    const grad = c.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, `rgba(0,0,0,${strength})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fillRect(this.px(l0), Math.min(y0, y1), (l1 - l0) * this.w, Math.abs(y1 - y0));
  }

  /** A small sponsor decal. Returns nothing; purely decorative. */
  decal(
    l: number, g: number, str: string,
    opts: { face: 'left' | 'right' | 'deck'; heightM: number; colour: string; weight?: number },
  ): void {
    this.text(l, g, str, {
      face: opts.face,
      heightM: opts.heightM,
      colour: opts.colour,
      weight: opts.weight ?? 700,
      tracking: 0.02,
    });
  }

  /** Fills a closed polygon given in local (L, G). */
  poly(points: readonly [number, number][], colour: string): void {
    const c = this.ctx;
    c.fillStyle = colour;
    c.beginPath();
    c.moveTo(this.px(points[0][0]), this.py(points[0][1]));
    for (let i = 1; i < points.length; i++) c.lineTo(this.px(points[i][0]), this.py(points[i][1]));
    c.closePath();
    c.fill();
  }

  /**
   * Outlines a closed polygon — the pinstripe.
   *
   * THE SINGLE MOST VALUABLE MARK ON A RACING CAR, and the one a generated
   * livery never has. Real paint schemes almost always separate two fields of
   * colour with a thin line of a third: a white hairline between a red flash and
   * a black body, a gold line round a green panel. It is the difference between
   * a shape that has been PLACED on the car and two colours that happen to meet,
   * and it costs one stroke.
   *
   * Width is given as a fraction of the panel's girth so it comes out the same
   * physical thickness on the sidepod as on the monocoque despite the two having
   * entirely different pixel densities.
   */
  edge(points: readonly [number, number][], colour: string, widthG: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = colour;
    c.lineWidth = Math.max(1, widthG * this.h);
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(this.px(points[0][0]), this.py(points[0][1]));
    for (let i = 1; i < points.length; i++) c.lineTo(this.px(points[i][0]), this.py(points[i][1]));
    c.closePath();
    c.stroke();
    c.restore();
  }

  /** Strokes an open path in (L, G). A hairline that does not close on itself. */
  line(points: readonly [number, number][], colour: string, widthG: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = colour;
    c.lineWidth = Math.max(1, widthG * this.h);
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(this.px(points[0][0]), this.py(points[0][1]));
    for (let i = 1; i < points.length; i++) c.lineTo(this.px(points[i][0]), this.py(points[i][1]));
    c.stroke();
    c.restore();
  }

  /** Paints the team's mark, sized in metres like every other graphic here. */
  mark(l: number, g: number, device: number, diameterM: number,
    ground: string, accent: string): void {
    // Sized on the girth axis, which is the one a mark on the deck is read
    // across; the atlas is anisotropic, so the disc is squashed back on the
    // other axis to come out round on the car.
    const size = diameterM * this.pxG;
    const c = this.ctx;
    c.save();
    c.translate(this.px(l), this.py(g));
    c.scale(this.pxL / this.pxG, 1);
    drawMark(c, 0, 0, size, device, ground, accent);
    c.restore();
  }

  /**
   * Stamps a supplied badge where `mark` would have drawn a generated one.
   *
   * Same framing rule as `mark` — sized on the girth axis, squashed back on the
   * other so the atlas's anisotropy does not oval it — and the image is fitted
   * INSIDE the diameter rather than stretched to it, because a badge that is
   * not square is the normal case and a stretched one is instantly wrong. A
   * wide badge therefore comes out the full width and short; a tall one comes
   * out the full height and narrow. Nothing is cropped.
   */
  badge(l: number, g: number, img: BrandImage, diameterM: number): void {
    const w = imageWidth(img);
    const h = imageHeight(img);
    if (w <= 0 || h <= 0) return;
    const size = diameterM * this.pxG;
    const scale = Math.min(size / w, size / h);
    const c = this.ctx;
    c.save();
    c.translate(this.px(l), this.py(g));
    c.scale(this.pxL / this.pxG, 1);
    c.drawImage(img, -w * scale * 0.5, -h * scale * 0.5, w * scale, h * scale);
    c.restore();
  }

  /**
   * Stamps a supplied wordmark where `decal` would have drawn type.
   *
   * Sized by HEIGHT in metres, exactly as the text it replaces is sized by cap
   * height, with the width following the image's own aspect. Rotated by the
   * same rule `text` resolves — see that method for why the three faces differ.
   */
  decalImage(l: number, g: number, img: BrandImage,
    opts: { face: 'left' | 'right' | 'deck'; heightM: number }): void {
    const w = imageWidth(img);
    const h = imageHeight(img);
    if (w <= 0 || h <= 0) return;
    const c = this.ctx;
    c.save();
    c.translate(this.px(l), this.py(g));
    let drawH: number;
    let squash: number;
    if (opts.face === 'deck') {
      c.rotate(-Math.PI / 2);
      drawH = opts.heightM * this.pxL;
      squash = this.pxG / this.pxL;
    } else {
      if (opts.face === 'left') c.rotate(Math.PI);
      drawH = opts.heightM * this.pxG;
      squash = this.pxL / this.pxG;
    }
    c.scale(squash, 1);
    const drawW = drawH * (w / h);
    c.drawImage(img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    c.restore();
  }

  /**
   * Draws text so it reads the right way up on the car.
   *
   * The (L, G) frame points in a different direction on each face of the body,
   * so the same string has to be rotated differently depending on where it
   * lands. Getting this wrong is not subtle — the number comes out sideways or
   * mirrored — so it is resolved once, here:
   *
   *  - right flank: L runs to the viewer's right and G upward. Draw as-is.
   *  - left flank: both axes reverse. Draw upside down.
   *  - deck: seen from above or from behind, G runs across the screen and L down
   *    it, so deck text reads ACROSS the car, which is where a real engine-cover
   *    number reads too.
   */
  text(
    l: number, g: number, str: string,
    opts: {
      face: 'left' | 'right' | 'deck';
      /** Cap height on the car, in metres. */
      heightM: number;
      colour: string;
      weight?: number;
      slant?: number;
      outline?: string;
      tracking?: number;
    },
  ): void {
    const c = this.ctx;
    c.save();
    c.translate(this.px(l), this.py(g));

    // Font size is measured along the glyph's own height axis, and the two axes
    // of this atlas do not have the same pixel density, so the other axis has to
    // be scaled back to keep the letterforms in proportion.
    let fontPx: number;
    let squash: number;
    if (opts.face === 'deck') {
      c.rotate(-Math.PI / 2);
      fontPx = opts.heightM * this.pxL;
      squash = this.pxG / this.pxL;
    } else {
      if (opts.face === 'left') c.rotate(Math.PI);
      fontPx = opts.heightM * this.pxG;
      squash = this.pxL / this.pxG;
    }
    c.scale(squash, 1);
    // A forward lean is most of what makes racing numerals look like racing
    // numerals rather than like a spreadsheet.
    if (opts.slant) c.transform(1, 0, -opts.slant, 1, 0, 0);

    c.font = `${opts.weight ?? 800} ${Math.max(4, fontPx)}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const spaced = c as CanvasRenderingContext2D & { letterSpacing: string };
    if (opts.tracking) spaced.letterSpacing = `${opts.tracking * fontPx}px`;
    if (opts.outline) {
      c.lineWidth = Math.max(1.2, fontPx * 0.085);
      c.strokeStyle = opts.outline;
      c.lineJoin = 'round';
      c.strokeText(str, 0, 0);
    }
    c.fillStyle = opts.colour;
    c.fillText(str, 0, 0);
    if (opts.tracking) spaced.letterSpacing = '0px';
    c.restore();
  }
}

// ===========================================================================
// The livery itself
// ===========================================================================

// ===========================================================================
// The pattern families
// ===========================================================================

/**
 * The graphics each family draws on each panel.
 *
 * WHAT IS AND IS NOT IN HERE. A family owns the ARRANGEMENT of colour and
 * nothing else: the base coat, the bare-laminate underside, the race numbers,
 * the driver code, the sponsor set, the panel seams and the painted-in occlusion
 * are identical for every car and live in the three `paint*` functions below.
 * That split is what stops six families becoming six copies of one painter that
 * slowly disagree about where the number goes.
 *
 * `bolt` is byte-for-byte the design this file painted before families existed,
 * and it is the default. Every car on the real 2026 grid therefore looks exactly
 * as it did; the five below it are new surface, reachable only by a team that
 * has chosen one.
 */
interface FamilyPainter {
  body(p: Panel, spec: LiverySpec, acc: string, trim: string): void;
  pod(p: Panel, spec: LiverySpec, acc: string, trim: string): void;
  airbox(p: Panel, spec: LiverySpec, acc: string, trim: string): void;
}

/** Smooth 0..1, for the curves the wave family is made of. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * A rising curve across a panel, as a closed polygon.
 *
 * Sampled rather than a bezier because a bezier through the atlas's anisotropy
 * would need its control points converted twice, and sixteen segments is already
 * smoother than the texel grid it lands on.
 */
function risingBand(
  gFrom: number, gTo: number, thickness: number, samples = 16,
): [number, number][] {
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const g = gFrom + (gTo - gFrom) * smoothstep(t);
    top.push([t, g]);
    bottom.push([t, g + thickness]);
  }
  return [...top, ...bottom.reverse()];
}

const FAMILIES: Record<LiveryFamilyId, FamilyPainter> = {
  /**
   * BOLT — the original. A swept nose, a deck spine, a flank flash.
   *
   * Unchanged, deliberately and permanently. It is what the whole grid wears.
   */
  bolt: {
    body(p, _spec, acc) {
      // Swept back further along the deck than down the sides, which is how a
      // real nose flash is shaped and reads instantly as livery rather than as
      // two-tone.
      p.poly([
        [0.0, 0.10], [0.075, 0.10], [0.110, 0.22], [0.145, 0.40],
        [0.145, 0.60], [0.110, 0.78], [0.075, 0.90], [0.0, 0.90],
      ], acc);
      // Runs from behind the cockpit to the tail, widening over the engine cover.
      p.poly([
        [0.40, 0.475], [0.40, 0.525],
        [0.55, 0.560], [0.80, 0.565], [1.0, 0.545],
        [1.0, 0.455], [0.80, 0.435], [0.55, 0.440],
      ], acc);
      // The visible sliver between the nose and the sidepod inlet, rising toward
      // the shoulder as it goes back.
      for (const g of [0.25, 0.75] as const) {
        const s = g > 0.5 ? -1 : 1;
        p.poly([
          [0.14, g + s * 0.055], [0.33, g + s * 0.10],
          [0.33, g + s * 0.045], [0.14, g - s * 0.02],
        ], acc);
      }
    },
    pod(p, _spec, acc) {
      for (const g of [0.25, 0.75] as const) {
        const s = g > 0.5 ? -1 : 1;
        p.poly([
          [0.03, g - s * 0.075], [0.03, g + s * 0.085],
          [0.30, g + s * 0.095], [0.62, g + s * 0.075],
          [0.90, g + s * 0.030], [1.0, g],
          [1.0, g - s * 0.035], [0.72, g - s * 0.005],
          [0.40, g + s * 0.010], [0.14, g - s * 0.020],
        ], acc);
      }
    },
    airbox(p, _spec, acc) {
      p.band(0, 1, 0.43, 0.57, acc);
    },
  },

  /**
   * STRIPE — twin racing stripes, nose to tail, straight over the airbox.
   *
   * The oldest motor-racing graphic there is and still the best-looking one,
   * because it follows the car's own axis rather than fighting it. The trim
   * hairline down each outer edge is doing the real work: without it the pair
   * reads as one wide band with a slot in it.
   */
  stripe: {
    body(p, _spec, acc, trim) {
      /**
       * WIDE, AND WIDER THAN THEY FIRST WERE.
       *
       * The body panel's girth is the whole circumference of the section, so a
       * band of a few per cent of it is only a few centimetres on the car — and
       * the first attempt at this drew a pair of 6cm stripes that vanished into
       * a gold hairline down the engine cover. Real racing stripes are wide
       * enough to run over the shoulder of the bodywork and be visible from the
       * side as well as from above, which is what the 12cm here does.
       */
      for (const [g0, g1] of [[0.400, 0.464], [0.536, 0.600]] as const) {
        p.band(0, 1, g0 - 0.014, g0, trim);
        p.band(0, 1, g0, g1, acc);
        p.band(0, 1, g1, g1 + 0.014, trim);
      }
    },
    pod(p, _spec, acc, trim) {
      // The pods are outboard of the centreline, so the stripes cannot run over
      // them. They get the shoulder line instead, which is what carries the eye
      // from the nose stripes to the rear wing.
      p.band(0, 1, 0.255, 0.315, acc);
      p.band(0, 1, 0.315, 0.327, trim);
      p.band(0, 1, 0.685, 0.745, acc);
      p.band(0, 1, 0.673, 0.685, trim);
    },
    airbox(p, _spec, acc, trim) {
      // The SAME fractions as the body deck, so the pair runs unbroken from the
      // nose over the roll hoop rather than stepping sideways at the panel join.
      for (const [g0, g1] of [[0.400, 0.464], [0.536, 0.600]] as const) {
        p.band(0, 1, g0 - 0.014, g0, trim);
        p.band(0, 1, g0, g1, acc);
        p.band(0, 1, g1, g1 + 0.014, trim);
      }
    },
  },

  /**
   * CHEVRON — forward chevrons repeated down the flank and across the deck.
   *
   * A rhythm rather than a shape: four of them make a car look like it is
   * already moving in a static screenshot, which is the only reason a repeating
   * device is worth the paint. Alternating accent and trim is what keeps the
   * repeat from turning into a fence.
   */
  chevron: {
    body(p, _spec, acc, trim) {
      // A blunt accent nose, cut square with a trim edge — the chevrons need a
      // solid mass at the front of the car to point away from.
      p.poly([[0.0, 0.10], [0.088, 0.10], [0.088, 0.90], [0.0, 0.90]], acc);
      p.line([[0.092, 0.10], [0.092, 0.90]], trim, 0.020);
      const t = 0.042;
      for (let i = 0; i < 4; i++) {
        const l = 0.455 + i * 0.132;
        p.poly([
          [l, 0.500], [l + 0.072, 0.408], [l + 0.072 + t, 0.408],
          [l + t, 0.500], [l + 0.072 + t, 0.592], [l + 0.072, 0.592],
        ], i % 2 === 0 ? acc : trim);
      }
    },
    pod(p, _spec, acc, trim) {
      const t = 0.055;
      for (const g of [0.25, 0.75] as const) {
        const s = g > 0.5 ? -1 : 1;
        for (let i = 0; i < 4; i++) {
          const l = 0.10 + i * 0.20;
          p.poly([
            [l, g], [l + 0.085, g + s * 0.125], [l + 0.085 + t, g + s * 0.125],
            [l + t, g], [l + 0.085 + t, g - s * 0.125], [l + 0.085, g - s * 0.125],
          ], i % 2 === 0 ? acc : trim);
        }
      }
    },
    airbox(p, _spec, acc, trim) {
      p.poly([
        [0.10, 0.50], [0.36, 0.28], [0.46, 0.28],
        [0.20, 0.50], [0.46, 0.72], [0.36, 0.72],
      ], acc);
      p.band(0, 1, 0.485, 0.515, trim);
    },
  },

  /**
   * WAVE — a curve rising off the floor, over the sidepod, into the airbox.
   *
   * The only family whose boundary is not a straight line, and the one that
   * follows the car's actual surface: the sidepod undercut rises toward the
   * rear on a real car, and a graphic that rises with it looks moulded in rather
   * than stuck on.
   */
  wave: {
    body(p, _spec, acc, trim) {
      for (const g of [0.16, 0.84] as const) {
        const s = g > 0.5 ? -1 : 1;
        const pts = risingBand(g, g + s * 0.20, s * 0.085);
        p.poly(pts, acc);
        p.edge(pts, trim, 0.014);
      }
      // The crest carries over the deck at the tail, closing the shape.
      p.poly([[0.86, 0.44], [1.0, 0.425], [1.0, 0.575], [0.86, 0.56]], acc);
    },
    pod(p, _spec, acc, trim) {
      for (const g of [0.14, 0.86] as const) {
        const s = g > 0.5 ? -1 : 1;
        const pts = risingBand(g, g + s * 0.26, s * 0.115);
        p.poly(pts, acc);
        p.edge(pts, trim, 0.012);
      }
    },
    airbox(p, _spec, acc, trim) {
      const pts = risingBand(0.72, 0.42, 0.24);
      p.poly(pts, acc);
      p.edge(pts, trim, 0.018);
    },
  },

  /**
   * SPLIT — one hard diagonal, front half against rear half.
   *
   * The most legible livery on a grid and the one that survives being a hundred
   * pixels across in a trackside shot, because it is a single edge rather than a
   * set of details. It leans forward as it goes up, so the car looks like it is
   * being driven into the split rather than wearing a stripe.
   */
  split: {
    body(p, _spec, acc, trim) {
      p.poly([[0.66, 0.10], [0.42, 0.90], [1.0, 0.90], [1.0, 0.10]], acc);
      p.line([[0.66, 0.10], [0.42, 0.90]], trim, 0.030);
    },
    pod(p, _spec, acc, trim) {
      p.poly([[0.46, 0.0], [0.20, 1.0], [1.0, 1.0], [1.0, 0.0]], acc);
      p.line([[0.46, 0.0], [0.20, 1.0]], trim, 0.026);
    },
    airbox(p, _spec, acc, trim) {
      p.poly([[0.62, 0.0], [0.40, 1.0], [1.0, 1.0], [1.0, 0.0]], acc);
      p.line([[0.62, 0.0], [0.40, 1.0]], trim, 0.030);
    },
  },

  /**
   * HALO — the accent confined to the shoulder line and the airbox crown.
   *
   * The restrained one, and it is the best-looking of the six. A car is a shape
   * before it is a graphic, and a single band following the highest line on the
   * bodywork does nothing except tell the eye where that line is. Matte black
   * with one band of colour along the shoulder is the livery most players will
   * reach for first and it was previously impossible to make.
   */
  halo: {
    body(p, _spec, acc, trim) {
      p.band(0, 1, 0.285, 0.330, acc);
      p.band(0, 1, 0.330, 0.342, trim);
      p.band(0, 1, 0.670, 0.715, acc);
      p.band(0, 1, 0.658, 0.670, trim);
      // A cap right on the tip of the nose. One accent mark at the front of the
      // car, so it is not read from head-on as unpainted.
      p.band(0.0, 0.030, 0.10, 0.90, acc);
    },
    pod(p, _spec, acc, trim) {
      p.band(0, 1, 0.300, 0.352, acc);
      p.band(0, 1, 0.352, 0.364, trim);
      p.band(0, 1, 0.648, 0.700, acc);
      p.band(0, 1, 0.636, 0.648, trim);
    },
    airbox(p, _spec, acc, trim) {
      p.band(0, 1, 0.455, 0.545, acc);
      p.band(0, 1, 0.443, 0.455, trim);
      p.band(0, 1, 0.545, 0.557, trim);
    },
  },
};

/**
 * Monocoque panel: nose, chassis flanks, engine-cover deck.
 *
 * Only some of this surface is ever seen. The chassis flanks disappear behind
 * the sidepods from L about 0.31 back, and everything below G 0.15 is inside the
 * floor. So the graphics go where they will actually be looked at: the nose, the
 * short stretch of flank between the nose and the sidepod inlet, and the deck.
 */
function paintBody(
  p: Panel, spec: LiverySpec, flash: number, ink: string, d: LiveryDesign,
  brand: BrandOverrides = NO_BRAND,
): void {
  const base = css(spec.colour);
  const acc = css(flash);
  const trim = css(d.trim);
  const carbon = '#101216';

  p.fill(base);

  // Underside and the lower flanks: never painted on a real car — they are bare
  // laminate, so they get a real weave rather than a flat dark fill.
  p.carbon(0, 1, 0.0, 0.10, carbon);
  p.carbon(0, 1, 0.90, 1.0, carbon);
  p.band(0, 1, 0.10, 0.15, css(shade(spec.colour, -0.45)));
  p.band(0, 1, 0.85, 0.90, css(shade(spec.colour, -0.45)));

  FAMILIES[d.family].body(p, spec, acc, trim);

  // --- Race numbers -------------------------------------------------------
  //
  // WHY THE OUTLINE IS CONDITIONAL. `bolt` puts every number on the nose flash
  // or the deck spine, so a single ink colour read from the accent is correct
  // and is what this file has always drawn. The other five families do not
  // guarantee what is underneath a number — a `halo` nose is base colour, a
  // `split` engine cover depends on where the diagonal fell — so those get a
  // contrasting outline, which is what a real racing number carries anyway and
  // which is legible on any ground.
  const num = String(spec.number);
  const plain = d.family === 'bolt';
  const numInk = plain ? ink : readable(spec.colour);
  const outline = plain ? undefined : (luminance(spec.colour) > 0.45 ? '#f4f7fa' : '#0b0e13');
  p.text(0.062, 0.26, num,
    { face: 'left', heightM: 0.135, colour: numInk, slant: 0.16, outline });
  p.text(0.062, 0.74, num,
    { face: 'right', heightM: 0.135, colour: numInk, slant: 0.16, outline });
  // On the deck of the nose, where the overhead and chase cameras see it.
  p.text(0.075, 0.50, num,
    { face: 'deck', heightM: 0.15, colour: numInk, slant: 0.16, outline });
  // And on the engine cover, sitting on the spine.
  p.text(0.72, 0.50, num,
    { face: 'deck', heightM: 0.19, colour: numInk, slant: 0.16, outline });

  // --- Driver code by the cockpit ----------------------------------------
  const codeInk = readable(spec.colour);
  p.text(0.255, 0.245, spec.code, {
    face: 'left', heightM: 0.075, colour: codeInk, weight: 700, tracking: 0.07,
  });
  p.text(0.255, 0.755, spec.code, {
    face: 'right', heightM: 0.075, colour: codeInk, weight: 700, tracking: 0.07,
  });

  // --- Sponsors -----------------------------------------------------------
  // On the deck behind the cockpit and along the nose, which are the two places
  // a chase camera actually reads. Kept in the ink colour rather than in a
  // third hue: a real car's sponsor set is nearly all white or black, because
  // that is what stays legible across a whole grid of liveries.
  const decalInk = readable(spec.colour);
  const faint = luminance(spec.colour) > 0.45 ? 'rgba(12,16,22,0.62)' : 'rgba(240,244,248,0.62)';
  const brands = sponsorSet(d);
  p.decal(0.185, 0.50, brands[spec.number % brands.length], {
    face: 'deck', heightM: 0.052, colour: decalInk, weight: 800,
  });
  p.decal(0.325, 0.50, brands[(spec.number + 3) % brands.length], {
    face: 'deck', heightM: 0.034, colour: faint,
  });
  p.decal(0.545, 0.50, brands[(spec.number + 6) % brands.length], {
    face: 'deck', heightM: 0.040, colour: faint,
  });
  for (const [g, face] of [[0.30, 'left'], [0.70, 'right']] as const) {
    p.decal(0.185, g, brands[(spec.number + 1) % brands.length], {
      face, heightM: 0.042, colour: faint,
    });
  }

  // --- The team's mark ------------------------------------------------------
  //
  // On the engine cover, ahead of the number, where the overhead and chase
  // cameras hold it — and on the nose deck, which is what a front-on shot and
  // the podium camera see. The SAME device the timing tower draws beside this
  // team's name, so the badge on the screen and the badge on the car are one
  // badge. Only a team that has chosen one carries it; `mark: -1` is the
  // default and is what every car on the real grid has.
  //
  // A DROPPED-IN BADGE SUPPRESSES THE GENERATED ONE rather than sitting on top
  // of it, and it is drawn later, in `stampBrand`, so that it lands over a
  // replacement livery atlas rather than under it. Note the asymmetry with
  // `mark >= 0`: an override shows even for a team that never chose a device,
  // because a user who has put `ferrari/badge.png` on disk has chosen one.
  if (d.mark >= 0 && !brand.badge) {
    const ground = css(shade(spec.colour, luminance(spec.colour) > 0.45 ? -0.55 : 0.18));
    p.mark(0.585, 0.50, d.mark, 0.20, ground, acc);
    p.mark(0.305, 0.300, d.mark, 0.11, ground, acc);
    p.mark(0.305, 0.700, d.mark, 0.11, ground, acc);
  }

  // --- Panel seams and occlusion -------------------------------------------
  // Hairlines where the engine cover meets the chassis, plus the soft darkening
  // that lives in every shut line and under every shoulder. The hairline alone
  // reads as a drawn-on stripe; it is the gradient beside it that makes it read
  // as a gap between two pieces.
  p.ctx.fillStyle = 'rgba(0,0,0,0.30)';
  p.ctx.fillRect(p.px(0.40), p.py(0.15), Math.max(1, p.w * 0.0025), p.h * 0.70);
  p.ctx.fillRect(p.px(0.895), p.py(0.15), Math.max(1, p.w * 0.002), p.h * 0.70);

  // Under the shoulders, where the flank turns under toward the floor and no
  // sky reaches.
  p.shadeBand(0, 1, 0.155, 0.245, 0.45);
  p.shadeBand(0, 1, 0.845, 0.755, 0.45);
}

/** Sidepod: inlet surround, downwash ramp, and the flash that runs off the body. */
function paintPod(
  p: Panel, spec: LiverySpec, flash: number, d: LiveryDesign,
  brand: BrandOverrides = NO_BRAND,
): void {
  p.fill(css(spec.colour));
  // The undercut is bare laminate on every current car, and it is a large area
  // seen from every trackside and chase angle.
  p.carbon(0, 1, 0.0, 0.12, '#101216');
  p.carbon(0, 1, 0.88, 1.0, '#101216');

  // Dark surround at the inlet, so the mouth reads as a hole in bodywork.
  p.band(0.0, 0.035, 0.0, 1.0, '#0a0c11');

  FAMILIES[d.family].pod(p, spec, css(flash), css(d.trim));

  // Sponsors down the flank, which is the largest uninterrupted painted area on
  // the car and the one a trackside camera sees most of.
  //
  // THE TITLE SPONSOR GETS THE SIDEPOD, at 115mm, and it is the only piece of
  // type on the car big enough to read from a trackside camera. When the
  // sponsorship system exists these will be the deals the player signed; today
  // they are the invented house set, and either way they come through
  // `sponsorSet` so the painter never needs to know which.
  const podInk = readable(spec.colour);
  const podFaint = luminance(spec.colour) > 0.45 ? 'rgba(12,16,22,0.58)' : 'rgba(240,244,248,0.58)';
  const brands = sponsorSet(d);
  for (const [g, face] of [[0.30, 'left'], [0.70, 'right']] as const) {
    // The title slot only. A supplied decal replaces the 115mm wordmark and
    // nothing else — the two faint ones below it stay generated, because a
    // sidepod carrying one graphic and no small print reads emptier than one
    // carrying none at all. Drawn later, in `stampBrand`, for the same reason
    // the badge is.
    if (!brand.sponsor) {
      p.decal(0.30, g, brands[(spec.number + 2) % brands.length], {
        face, heightM: 0.115, colour: podInk, weight: 800,
      });
    }
    p.decal(0.60, g, brands[(spec.number + 5) % brands.length], {
      face, heightM: 0.065, colour: podFaint,
    });
    p.decal(0.79, g, brands[(spec.number + 8) % brands.length], {
      face, heightM: 0.048, colour: podFaint,
    });
  }

  // Shoulder hairline: the pod's own panel split, with the tuck under it.
  p.ctx.fillStyle = 'rgba(0,0,0,0.22)';
  p.ctx.fillRect(p.x, p.py(0.605), p.w, Math.max(1, p.h * 0.012));
  p.ctx.fillRect(p.x, p.py(0.385), p.w, Math.max(1, p.h * 0.012));
  // The undercut is the darkest place on the whole car: it faces the floor,
  // and nothing but bounced light off the asphalt reaches it.
  p.shadeBand(0, 1, 0.135, 0.30, 0.55);
  p.shadeBand(0, 1, 0.865, 0.70, 0.55);
}

/** Airbox and roll hoop: accent crown, driver code on the flanks. */
function paintAirbox(p: Panel, spec: LiverySpec, flash: number, d: LiveryDesign): void {
  p.fill(css(spec.colour));
  FAMILIES[d.family].airbox(p, spec, css(flash), css(d.trim));
  p.band(0, 1, 0.0, 0.10, '#101216');
  p.band(0, 1, 0.90, 1.0, '#101216');
  // The mouth end goes dark: it is a duct, not a nose.
  //
  // FOUR PER CENT, NOT TEN. The airbox loft's first stations are its forward
  // fairing, and a tenth of the panel's length is 130mm of it — so the whole
  // front of the roll hoop came out near-black, which with a flat first ring
  // under it read as a carton stood behind the driver's head. What wants to be
  // dark is the LIP around the intake and nothing else.
  p.band(0.0, 0.04, 0.0, 1.0, '#08090e');

  const codeInk = readable(spec.colour);
  p.text(0.42, 0.255, spec.code, {
    face: 'left', heightM: 0.105, colour: codeInk, weight: 800, slant: 0.12, tracking: 0.04,
  });
  p.text(0.42, 0.745, spec.code, {
    face: 'right', heightM: 0.105, colour: codeInk, weight: 800, slant: 0.12, tracking: 0.04,
  });
}

/**
 * The driver's helmet.
 *
 * A helmet is one of the most recognisable objects in the sport and ours was a
 * flat-coloured egg with a dark band across it. The roster is real now, so these
 * belong to named people — and for exactly that reason NONE of them reproduces
 * any real driver's design. What they do is generate a distinct, plausible
 * livery per driver out of the team's own palette plus black and white, which is
 * where a real helmet's colours mostly come from anyway.
 *
 * THE UNWRAP. `helmetUV` in DriverMesh projects the shell and the jaw through a
 * spherical map about the head centre, so in this painter:
 *
 *   l = 0.5 is the FRONT of the helmet, l = 0 and l = 1 are both the back, and
 *       the seam between them is where the shell's own seam already is;
 *   g = 0 is the CROWN and g = 1 is under the chin, so the equator is g = 0.5.
 *
 * Everything converges as g goes to zero, which is what a projection does at a
 * pole: a shape drawn across the whole of l at small g is a cap on the crown,
 * and a vertical bar is a ray running down from it. Both of those are how real
 * helmet graphics are actually laid out, which is why this unwrap is the right
 * one rather than merely the cheap one.
 */
function paintHelmet(p: Panel, spec: LiverySpec, flash: number): void {
  // Deterministic per driver, so a driver's helmet is his for the whole career
  // and two team-mates never turn up in the same one.
  let h = (spec.number * 2654435761) >>> 0;
  for (let i = 0; i < spec.code.length; i++) {
    h = (Math.imul(h, 31) + spec.code.charCodeAt(i)) >>> 0;
  }
  const pick = <T>(list: readonly T[], salt: number): T => list[(h >>> salt) % list.length];

  const white = 0xeef1f6;
  const black = 0x14171d;
  const palette = [spec.colour, flash, white, black, shade(spec.colour, 0.45)];
  const base = pick(palette, 0);
  // The mark has to be legible ON the base, which two colours out of the same
  // team palette very often are not.
  let mark = pick(palette, 5);
  if (Math.abs(luminance(mark) - luminance(base)) < 0.22) {
    mark = luminance(base) > 0.5 ? black : white;
  }
  const third = luminance(base) > 0.5 ? black : white;
  const ink = readable(base);

  p.fill(css(base));

  switch ((h >>> 11) % 6) {
    case 0:
      // Crown cap over a ring: the commonest arrangement there is.
      p.band(0, 1, 0, 0.30, css(mark));
      p.band(0, 1, 0.30, 0.335, css(third));
      p.band(0, 1, 0.46, 0.53, css(third));
      break;
    case 1:
      // Rays down from the crown.
      for (let i = 0; i < 6; i++) {
        p.poly([
          [i / 6 + 0.012, 0], [(i + 1) / 6 - 0.012, 0],
          [(i + 1) / 6 - 0.055, 0.62], [i / 6 + 0.055, 0.62],
        ], css(i % 2 === 0 ? mark : third));
      }
      break;
    case 2:
      // A blaze over the front, pointing down between the eyes.
      p.poly([[0.28, 0], [0.72, 0], [0.62, 0.44], [0.5, 0.60], [0.38, 0.44]], css(mark));
      p.band(0, 1, 0.62, 0.665, css(third));
      break;
    case 3:
      // Diagonal split, which on a projection is a wave: the boundary has to
      // meet itself at the seam or the back of the helmet shows a step.
      p.poly([
        [0, 0.18], [0.25, 0.42], [0.5, 0.20], [0.75, 0.42], [1, 0.18], [1, 0], [0, 0],
      ], css(mark));
      p.band(0, 1, 0.70, 0.74, css(third));
      break;
    case 4:
      // Quartered. Reads as four panels of two colours from any angle.
      for (let i = 0; i < 4; i++) {
        if (i % 2 === 0) p.band(i / 4, (i + 1) / 4, 0, 0.58, css(mark));
      }
      p.band(0, 1, 0.58, 0.62, css(third));
      break;
    default:
      // A chequered band round the shell, over a coloured crown.
      p.band(0, 1, 0, 0.26, css(mark));
      for (let i = 0; i < 12; i++) {
        p.band(i / 12, (i + 0.5) / 12, 0.34, 0.44, css(third));
        p.band((i + 0.5) / 12, (i + 1) / 12, 0.44, 0.54, css(third));
      }
      break;
  }

  // The visor aperture's shadow. The glass and its surround are separate
  // geometry, but the paint under them is what stops a hard-edged black band
  // from reading as a decal stuck on a ball.
  p.shadeBand(0.30, 0.70, 0.72, 0.62, 0.45);

  // The race number, on both sides. After the design itself this is the thing
  // that identifies a helmet at any distance, and it is on every real one.
  const num = String(spec.number);
  p.text(0.25, 0.50, num, { face: 'right', heightM: 0.075, colour: ink, weight: 800, slant: 0.14 });
  p.text(0.75, 0.50, num, { face: 'right', heightM: 0.075, colour: ink, weight: 800, slant: 0.14 });
  // And the code across the back, where a real one carries the driver's name.
  p.text(0.06, 0.40, spec.code, {
    face: 'right', heightM: 0.045, colour: ink, weight: 700, tracking: 0.06,
  });
  p.text(0.94, 0.40, spec.code, {
    face: 'right', heightM: 0.045, colour: ink, weight: 700, tracking: 0.06,
  });
}

/** Colour for each flat swatch, derived from the team's three colours. */
function swatchColour(
  name: SwatchName, spec: LiverySpec, flash: number, _d: LiveryDesign,
): number {
  switch (name) {
    case 'body': return spec.colour;
    case 'accent': return flash;
    case 'carbon': return 0x0f1115;
    /**
     * DELIBERATELY NOT THE DESIGN'S TRIM COLOUR.
     *
     * This swatch is the painted suspension, the mirror stalks, the brake-duct
     * strut and — since issue #34 — everything about the halo EXCEPT the crown
     * of its hoop. The first version of this work did drive it from the trim
     * colour, which with an ivory trim turned every wishbone and the halo into
     * a white rod and made the front of the car read as a scatter of
     * scaffolding. The trim colour is a hairline. Given a whole structure to
     * colour it stops being one and starts being the loudest thing on the car.
     *
     * So the trim reads where it is supposed to read: as the pinstripe along
     * the edge of a flash, which is exactly the mark that makes a livery look
     * designed. The hardware stays the near-black it has always been.
     *
     * THE HALO WAS THE ONE PART THAT COULD NOT AFFORD THAT, and it took until
     * #34 to separate the two. A wishbone is a 20mm rod seen against the car; a
     * halo is a 1.4m arc seen against the SKY from 600mm away, and near-black
     * against a night sky or a shaded pit straight is no silhouette at all. See
     * `case 'halo'`.
     */
    case 'trim': return TRIM_HARDWARE;
    /**
     * The crown of the halo hoop, and NOTHING else on the car — issue #34.
     *
     * See `haloColour` for where the colour comes from and why the halo is not
     * on `trim` any more. What takes this swatch is the up-facing part of the
     * hoop's section only: the pillar, the pillar root, the two mounts and the
     * hoop's own underside all stay `trim`, because that is what
     * `reference/target/76.png` shows when it is enlarged — a solid painted
     * band across the top of the arc, and black everywhere a driver is looking
     * THROUGH the structure rather than at it. Painting the whole tube would
     * have put a bright bar across the lower half of the onboard picture, which
     * is the complaint §6 records four separate passes fighting.
     */
    case 'halo': return UNPAINTED_HALO
      ? TRIM_HARDWARE
      : haloColour(spec.colour, flash);
    case 'rim': return 0xb4bcc6;
    case 'tyre': return 0x101216;
    case 'glass': return 0x090c13;
    case 'light': return 0xff2408;
    // A helmet in a lifted version of the accent reads as the driver's own
    // rather than as a second piece of bodywork.
    case 'helmet': return shade(flash, luminance(flash) > 0.5 ? -0.3 : 0.4);
    case 'suit': return suitColour(spec.colour);
    case 'glove': return 0x15181e;
    case 'dark': return 0x04050a;
  }
}

// ===========================================================================
// Texture assembly
// ===========================================================================

const cache = new Map<string, CacheEntry>();

/**
 * One shared surface map PER FINISH, rather than one for the whole grid.
 *
 * How shiny a panel is does not depend on what colour it is — which is why this
 * was a single texture shared by twenty-two cars, and why it stays shared. But
 * it does depend on what the car was painted WITH, and a matte car is a
 * different material from a gloss one rather than a differently coloured one.
 *
 * Three maps instead of one keeps the property that made this cheap: a grid of
 * twenty-four cars costs twenty-four colour textures and at most three surface
 * maps, and in practice one, because only a team that has chosen a finish is
 * anything other than satin.
 */
const surfaces = new Map<string, THREE.Texture>();

/** Roughness of clear-coated paint, per finish. Metalness is 0.02 throughout. */
const FINISH_ROUGHNESS: Record<LiveryFinish, { paint: number; deck: number; helmet: number }> = {
  // Wet-looking: a tight lobe that holds a hard highlight down a flank. Not
  // tighter than 0.21 — see the note on PAINT below about what the probe's sun
  // does to a narrow lobe on a curved panel.
  gloss: { paint: 0.22, deck: 0.28, helmet: 0.18 },
  // The grid standard, and the values this file has always used.
  satin: { paint: 0.30, deck: 0.38, helmet: 0.24 },
  // No highlight at all. The shape does the work, which is the whole appeal.
  matte: { paint: 0.62, deck: 0.66, helmet: 0.44 },
};

/**
 * Green = roughness, blue = metalness, matching three.js's channel convention so
 * one texture can serve as both maps.
 *
 * This is where the matte/gloss split lives. It is identical for every car with
 * the same finish, so the whole grid normally shares one copy of it.
 */
function buildSurfaceMap(size: number, finish: LiveryFinish): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const set = (rough: number, metal: number) =>
    `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // Default: satin, so anything not explicitly covered still behaves.
  ctx.fillStyle = set(0.45, 0.02);
  ctx.fillRect(0, 0, size, size);

  // PAINT IS NOT A METAL, and this is the single line that was making the whole
  // car read as shiny plastic.
  //
  // The metalness channel is not a gloss control. In a metallic-roughness
  // renderer it is a switch between two entirely different materials: at 0 the
  // surface has a coloured diffuse term and a small white specular; at 1 it has
  // NO diffuse term at all and its specular is tinted by the base colour. A
  // value in between is not "slightly shiny paint" — it is a physically
  // impossible half-metal, and what it produces is exactly what was on screen:
  // a body whose colour goes dead in shadow because a quarter of its diffuse
  // has been taken away, and whose highlights carry the paint's own hue at full
  // strength and clip to flat white where the environment probe's sun lands.
  // Every reference photograph of a real car shows the opposite — deep, holding
  // colour in the shade, with a WHITE highlight sitting on top of it.
  //
  // A painted, clear-coated carbon panel is a dielectric with a lacquer over
  // it. Metalness 0.02, which is the Fresnel floor and not a compromise.
  //
  // ROUGHNESS goes UP with it, from 0.21 to 0.30, and that is the other half of
  // the blown-highlight fix. With metalness at 0.26 the specular lobe was being
  // fed a quarter of the base colour's energy as well as the dielectric's own
  // 4 per cent, so it had to be kept narrow to stay dark; at metalness 0.02 the
  // lobe is fed 4 per cent and can afford to be the width a real clear coat's
  // is. The probe's sun is 220x the radiance of its sky (see EnvProbe), and a
  // lobe narrow enough to resolve that disc puts a clipped white blob on every
  // curved panel. 0.30 spreads the same energy over about twice the solid
  // angle, which takes the peak below the point ACES flattens it — and the
  // highlight becomes a bright soft sweep down a flank instead of a hole burnt
  // in the livery.
  const R = FINISH_ROUGHNESS[finish];
  const PAINT = set(R.paint, 0.02);
  // Structural carbon on a race car is CLEAR-COATED, and that is most of the
  // difference between the wings on the reference car and the wings that were
  // here. 0.62 is bare laminate straight out of the autoclave: matte, dusty,
  // the finish on an underbody panel nobody photographs. What is actually on a
  // front wing, a floor edge or an endplate is lacquer over the weave, and it
  // is very nearly as wet-looking as the paint beside it. At 0.62 every one of
  // those parts came out as a flat dark-grey shape with no highlight along any
  // edge — which is precisely how a plastic model of a car looks, and the
  // front wing is now entirely made of them.
  //
  // 0.38 rather than 0.30. Lacquered carbon is glossy, but the floor edge and
  // the sidepod's undercut are long, gently curved, near-horizontal surfaces —
  // exactly the geometry that turns a tight specular lobe into a metre-long
  // streak — and at 0.30 they came out as a blown white bar under the car in
  // every three-quarter shot. Still a world away from the 0.62 that made them
  // read as grey plastic.
  const CARBON = set(0.40, 0.02);

  /**
   * The satin strip along the top centreline.
   *
   * Every deck band below used to carry metalness 0.15-0.16 for the same
   * mistaken reason the paint did. It is the flattest, most upward-facing
   * surface on the car, so it sees the brightest part of the probe over its
   * whole area — which made it the first thing to blow out and the reason the
   * engine cover came back as a white stripe in three-quarter shots.
   */
  const DECK = set(R.deck, 0.02);

  const body = new Panel(ctx, PANEL.body, size);
  body.fill(PAINT);
  body.band(0, 1, 0.42, 0.58, DECK);
  // Carbon underside.
  body.band(0, 1, 0.0, 0.13, CARBON);
  body.band(0, 1, 0.87, 1.0, CARBON);

  const pod = new Panel(ctx, PANEL.pod, size);
  pod.fill(PAINT);
  pod.band(0, 1, 0.42, 0.58, DECK);
  pod.band(0, 1, 0.0, 0.12, CARBON);
  pod.band(0, 1, 0.88, 1.0, CARBON);
  pod.band(0.0, 0.05, 0.0, 1.0, set(0.85, 0.02));

  // A painted helmet shell: the same clear-coated paint as the bodywork, a
  // little glossier because a helmet is polished and a sidepod is not.
  // The helmet is the driver's, not the team's, so it keeps the satin shell it
  // has always had whatever the car was painted with.
  new Panel(ctx, PANEL.helmet, size).fill(set(FINISH_ROUGHNESS.satin.helmet, 0.02));

  const air = new Panel(ctx, PANEL.airbox, size);
  air.fill(PAINT);
  air.band(0, 1, 0.42, 0.58, DECK);
  air.band(0.0, 0.12, 0.0, 1.0, set(0.9, 0.02));

  /**
   * Roughness and metalness for each flat swatch.
   *
   * METALNESS IS A SWITCH, NOT A DIAL. See the note on PAINT above: a value
   * between 0 and 1 describes a material that does not exist, and the whole
   * table was full of them — painted bodywork at 0.28, the helmet at 0.16, the
   * rain light at 0.05. Each one was quietly deleting that fraction of the
   * surface's diffuse colour and adding it back as a tinted mirror, which is
   * the precise recipe for "reads as shiny plastic". Everything here is now
   * either a dielectric at the Fresnel floor or an honest metal.
   *
   * WHAT IS GENUINELY METAL ON A FORMULA 1 CAR: the halo (titanium), the
   * wheel's centre-lock nut and flange, the brake caliper, the exhaust, and the
   * odd fastener. That is all. The suspension members are AEROFOIL-SECTION
   * CARBON with a painted or lacquered finish, not polished steel — they were
   * at 0.72 metal, which under a blue sky turned every wishbone into a blue
   * mirrored rod and is a good part of why the front of the car looked like a
   * scatter of chrome.
   */
  const surfaceFor: Record<SwatchName, [number, number]> = {
    // Clear-coated paint over laminate. Matches PAINT above; if one moves the
    // other has to, or a flat-swatched panel and a painted one meeting along an
    // edge show a step in gloss right down the car.
    body: [R.paint, 0.02],
    accent: [R.paint - 0.01, 0.02],
    // Clear-coated laminate. See the CARBON constant above.
    carbon: [0.40, 0.02],
    // Painted carbon suspension and the halo share this swatch.
    //
    // 0.02, NOT 0.10. This entry used to read "the halo is the metal one and it
    // is 30mm of the car; the wishbones are not", and split the difference —
    // which is the exact mistake the paragraph above this table spends fifteen
    // lines forbidding. A half-metal is not a weighted average of two
    // materials, it is a third material that does not exist, and the swatch is
    // shared by an area that is overwhelmingly painted aerofoil-section carbon.
    //
    // It is also the wrong minority to have optimised for. A regulation halo is
    // titanium UNDER a bonded aerodynamic fairing, and on every car on the grid
    // that fairing is painted in the team's colours — so the surface actually
    // being drawn is paint over composite, and 0.02 is right for both users of
    // the swatch rather than a compromise between them.
    trim: [0.42, 0.02],
    /**
     * The painted crown of the halo — issue #34.
     *
     * The paragraph above `trim` already settled what material this is and it
     * did so for the halo specifically: *"a regulation halo is titanium UNDER a
     * bonded aerodynamic fairing, and on every car on the grid that fairing is
     * painted in the team's colours — so the surface actually being drawn is
     * paint over composite"*. So it takes the body's own paint roughness and
     * the same 0.02 Fresnel floor, and a crown meeting the engine cover reads
     * as the same finish rather than as a different one.
     *
     * Under `?haloUnpainted=1` it takes `trim`'s values instead, so the broken
     * arm differs from the fixed one in colour ALONE and the measurement cannot
     * be picking up a gloss change.
     */
    halo: UNPAINTED_HALO ? [0.42, 0.02] : [R.paint, 0.02],
    // The one honestly metallic swatch: machined and anodised hardware.
    rim: [0.26, 0.90],
    tyre: [0.88, 0.02],
    // A visor is the one truly mirror-like surface on the whole car. Dielectric
    // — it is polycarbonate with a tint, and its reflection is white.
    glass: [0.05, 0.02],
    light: [0.42, 0.02],
    // A painted helmet shell, which is the same material as the bodywork.
    helmet: [FINISH_ROUGHNESS.satin.helmet, 0.02],
    suit: [0.78, 0.02],
    glove: [0.86, 0.02],
    dark: [0.90, 0.02],
  };
  for (const name of SWATCH_ORDER) {
    const [r, m] = surfaceFor[name];
    new Panel(ctx, swatchRect(name), size).fill(set(r, m));
  }

  const tex = new THREE.CanvasTexture(canvas);
  // Linear, not sRGB: these are material parameters, not colour.
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds (or returns a cached) livery for one car.
 *
 * @param size texture edge in pixels; 512 on desktop, 256 on the low tier
 */
/**
 * Paints the atlas into a canvas of the caller's, and allocates nothing.
 *
 * FOR THE EDITOR'S THUMBNAILS, and the reason they can be trusted. A family
 * chip drawn by a second, simpler routine is a picture of what somebody thought
 * the painter did; this is the painter. Six chips therefore cost six canvases
 * and no GPU textures, no cache entries and no disposal, which matters because
 * they are repainted on every keystroke that changes a colour.
 */
export function paintLiveryAtlas(
  ctx: CanvasRenderingContext2D, spec: LiverySpec, size: number,
  design: LiveryDesign = DEFAULT_LIVERY_DESIGN,
): void {
  const flash = contrastFlash(spec.colour, spec.accent);
  const ink = readable(flash);
  const brand = brandFor(spec);

  ctx.fillStyle = css(spec.colour);
  ctx.fillRect(0, 0, size, size);

  const mk = (name: PanelName) =>
    new Panel(ctx, PANEL[name], size, PANEL_SIZE[name].lengthM, PANEL_SIZE[name].girthM);

  paintBody(mk('body'), spec, flash, ink, design, brand);
  paintPod(mk('pod'), spec, flash, design, brand);
  paintAirbox(mk('airbox'), spec, flash, design);

  stampBrand(ctx, mk, size, brand);

  for (const name of SWATCH_ORDER) {
    new Panel(ctx, swatchRect(name), size).fill(css(swatchColour(name, spec, flash, design)));
  }
}

/**
 * Lays the dropped-in artwork over the painted atlas.
 *
 * NO-OP WHEN NOTHING IS ON DISK, which is the point: `brand` is `NO_BRAND`,
 * every branch below is skipped, and the function returns having issued no
 * canvas call at all. `probe:assets` §3 is the proof.
 *
 * THE ORDER IS THE DESIGN. A replacement `livery.png` is a whole atlas and goes
 * down FIRST, over the generated panels; the badge and the sponsor go on top of
 * it, so a community livery downloaded from somewhere still gets this team's
 * badge stamped where the game puts badges. The flat swatches are repainted by
 * the caller AFTERWARDS and are deliberately out of reach: they are not
 * graphics, they are the single texel a wishbone, a tyre and a visor pin their
 * UVs to, and a supplied atlas that got those wrong would turn parts of the car
 * a colour nobody asked for with no visible cause.
 */
function stampBrand(
  ctx: CanvasRenderingContext2D,
  mk: (name: PanelName) => Panel,
  size: number,
  brand: BrandOverrides,
): void {
  if (brand === NO_BRAND) return;

  // A whole replacement atlas. Drawn to the full sheet, so what an author has
  // to match is `PANEL` and `SWATCH_REGION` in this file at any square size.
  if (brand.livery) ctx.drawImage(brand.livery, 0, 0, size, size);

  if (brand.badge) {
    // The same three stations the generated mark uses, so a team that swaps
    // between them does not have its badge move.
    const body = mk('body');
    body.badge(0.585, 0.50, brand.badge, 0.20);
    body.badge(0.305, 0.300, brand.badge, 0.11);
    body.badge(0.305, 0.700, brand.badge, 0.11);
  }

  if (brand.sponsor) {
    const pod = mk('pod');
    for (const [g, face] of [[0.30, 'left'], [0.70, 'right']] as const) {
      pod.decalImage(0.30, g, brand.sponsor, { face, heightM: 0.115 });
    }
  }
}

/** Where the monocoque panel sits in the atlas, so a chip can crop to it. */
export const BODY_PANEL_RECT = PANEL.body;

/**
 * Paints one car's whole atlas into a context.
 *
 * Extracted from `buildLivery` so that a car whose asset slot arrives after the
 * first frame can be REPAINTED INTO THE CANVAS IT ALREADY HAS. Rebuilding the
 * texture instead would mean a new `CanvasTexture`, a new material and a new
 * mesh for every car on the grid, which is a scene-graph edit in the middle of
 * a session; this is one `drawImage` chain and a `needsUpdate`, and it moves
 * nothing.
 */
function paintFullAtlas(
  ctx: CanvasRenderingContext2D, spec: LiverySpec, size: number, design: LiveryDesign,
): void {
  const flash = contrastFlash(spec.colour, spec.accent);
  const ink = readable(flash);
  const brand = brandFor(spec);

  // Fill everything with the body colour first, so a UV that lands on unused
  // atlas space picks up something plausible rather than transparent black.
  ctx.fillStyle = css(spec.colour);
  ctx.fillRect(0, 0, size, size);

  const mk = (name: PanelName) =>
    new Panel(ctx, PANEL[name], size, PANEL_SIZE[name].lengthM, PANEL_SIZE[name].girthM);

  paintBody(mk('body'), spec, flash, ink, design, brand);
  paintPod(mk('pod'), spec, flash, design, brand);
  paintAirbox(mk('airbox'), spec, flash, design);
  paintHelmet(mk('helmet'), spec, flash);

  stampBrand(ctx, mk, size, brand);

  for (const name of SWATCH_ORDER) {
    new Panel(ctx, swatchRect(name), size).fill(css(swatchColour(name, spec, flash, design)));
  }
}

/** Everything needed to repaint a cached atlas without rebuilding anything. */
interface CacheEntry extends LiveryTextures {
  ctx: CanvasRenderingContext2D;
  spec: LiverySpec;
  design: LiveryDesign;
  size: number;
}

/**
 * Repaints every cached atlas when an asset slot arrives.
 *
 * Registered ONCE, at module scope, for the whole process — not per car. It
 * fires only when a slot resolves to an actual file (`BrandAssets` deliberately
 * does not notify for a slot that resolved to nothing), so on a build with no
 * `public/brand/` it never runs at all.
 */
onBrandChange(() => {
  for (const entry of cache.values()) {
    paintFullAtlas(entry.ctx, entry.spec, entry.size, entry.design);
    entry.map.needsUpdate = true;
  }
});

export function buildLivery(spec: LiverySpec, size = 512): LiveryTextures {
  // The design comes from the call if there is one and from the registry
  // otherwise, which is how `CarMesh` — which knows nothing about families —
  // still paints the player's team correctly.
  const design = spec.design ?? liveryDesignFor(spec.colour, spec.accent);

  // `designEpoch` is in the key rather than the design's own fields because a
  // registration REPLACES a design at the same colour pair: without it, a
  // repaint in the livery editor would be served the previous texture out of
  // this cache and nothing on screen would change.
  //
  // The team id is in the key because it is what selects the asset slot, and
  // two teams that happen to share a colour pair must not share a badge. It
  // contributes an empty string for every caller that does not pass one, which
  // is every probe and both audit harnesses, so no existing key moves.
  const key = `${spec.colour}:${spec.accent}:${spec.number}:${spec.code}:${size}`
    + `:${design.family}:${design.trim}:${design.finish}:${design.mark}:${designEpoch}`
    + `:${spec.team ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  paintFullAtlas(ctx, spec, size, design);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;

  const surfaceKey = design.finish + ':' + size;
  let surface = surfaces.get(surfaceKey);
  if (!surface) {
    surface = buildSurfaceMap(size, design.finish);
    surfaces.set(surfaceKey, surface);
  }

  const result: CacheEntry = { map, surface, ctx, spec: { ...spec }, design, size };
  cache.set(key, result);
  return result;
}

export function disposeLiveryCache(): void {
  for (const t of cache.values()) t.map.dispose();
  cache.clear();
  for (const s of surfaces.values()) s.dispose();
  surfaces.clear();
  carbonTex?.map.dispose();
  carbonTex?.surface.dispose();
  carbonTex = null;
}
