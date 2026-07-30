import * as THREE from 'three';

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
}

export interface LiveryTextures {
  /** Base colour map. Per car. */
  map: THREE.CanvasTexture;
  /** Green = roughness, blue = metalness. Shared by every car. */
  surface: THREE.Texture;
}

/** A rectangle of the atlas, in UV space with v pointing up. */
interface Rect { u0: number; v0: number; u1: number; v1: number }

export type PanelName = 'body' | 'pod' | 'airbox';

/**
 * Unwrapped panels, laid out so each one's LENGTH runs along the atlas's u axis.
 * The body gets the full width because it is by far the longest part.
 */
export const PANEL: Record<PanelName, Rect> = {
  body: { u0: 0.0, v0: 0.62, u1: 1.0, v1: 1.0 },
  pod: { u0: 0.0, v0: 0.40, u1: 1.0, v1: 0.60 },
  airbox: { u0: 0.0, v0: 0.20, u1: 0.62, v1: 0.38 },
};

/** Real extents of each panel: length along the car, girth round the section. */
const PANEL_SIZE: Record<PanelName, { lengthM: number; girthM: number }> = {
  body: { lengthM: 4.86, girthM: 1.85 },
  pod: { lengthM: 2.87, girthM: 1.40 },
  airbox: { lengthM: 1.31, girthM: 0.80 },
};

const SWATCH_REGION: Rect = { u0: 0.0, v0: 0.0, u1: 1.0, v1: 0.18 };
const SWATCH_COLS = 6;
const SWATCH_ROWS = 2;

export type SwatchName =
  | 'body' | 'accent' | 'carbon' | 'trim' | 'rim' | 'tyre'
  | 'glass' | 'light' | 'helmet' | 'suit' | 'glove' | 'dark';

const SWATCH_ORDER: SwatchName[] = [
  'body', 'accent', 'carbon', 'trim', 'rim', 'tyre',
  'glass', 'light', 'helmet', 'suit', 'glove', 'dark',
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

// ===========================================================================
// Colour helpers
// ===========================================================================

function css(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
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

/**
 * Monocoque panel: nose, chassis flanks, engine-cover deck.
 *
 * Only some of this surface is ever seen. The chassis flanks disappear behind
 * the sidepods from L about 0.31 back, and everything below G 0.15 is inside the
 * floor. So the graphics go where they will actually be looked at: the nose, the
 * short stretch of flank between the nose and the sidepod inlet, and the deck.
 */
function paintBody(p: Panel, spec: LiverySpec, flash: number, ink: string): void {
  const base = css(spec.colour);
  const acc = css(flash);
  const carbon = '#101216';

  p.fill(base);

  // Underside and the lower flanks: never painted on a real car.
  p.band(0, 1, 0.0, 0.10, carbon);
  p.band(0, 1, 0.90, 1.0, carbon);
  p.band(0, 1, 0.10, 0.15, css(shade(spec.colour, -0.45)));
  p.band(0, 1, 0.85, 0.90, css(shade(spec.colour, -0.45)));

  // --- Contrasting nose ---------------------------------------------------
  // Swept back further along the deck than down the sides, which is how a real
  // nose flash is shaped and reads instantly as livery rather than as two-tone.
  p.poly([
    [0.0, 0.10], [0.075, 0.10], [0.110, 0.22], [0.145, 0.40],
    [0.145, 0.60], [0.110, 0.78], [0.075, 0.90], [0.0, 0.90],
  ], acc);

  // --- Deck spine ---------------------------------------------------------
  // Runs from behind the cockpit to the tail, widening over the engine cover.
  p.poly([
    [0.40, 0.475], [0.40, 0.525],
    [0.55, 0.560], [0.80, 0.565], [1.0, 0.545],
    [1.0, 0.455], [0.80, 0.435], [0.55, 0.440],
  ], acc);

  // --- Chassis flank flash ------------------------------------------------
  // The visible sliver between the nose and the sidepod inlet, rising toward the
  // shoulder as it goes back.
  for (const g of [0.25, 0.75] as const) {
    const s = g > 0.5 ? -1 : 1;
    p.poly([
      [0.14, g + s * 0.055], [0.33, g + s * 0.10],
      [0.33, g + s * 0.045], [0.14, g - s * 0.02],
    ], acc);
  }

  // --- Race numbers -------------------------------------------------------
  const num = String(spec.number);
  p.text(0.062, 0.26, num, { face: 'left', heightM: 0.135, colour: ink, slant: 0.16 });
  p.text(0.062, 0.74, num, { face: 'right', heightM: 0.135, colour: ink, slant: 0.16 });
  // On the deck of the nose, where the overhead and chase cameras see it.
  p.text(0.075, 0.50, num, { face: 'deck', heightM: 0.15, colour: ink, slant: 0.16 });
  // And on the engine cover, sitting on the spine.
  p.text(0.72, 0.50, num, { face: 'deck', heightM: 0.19, colour: ink, slant: 0.16 });

  // --- Driver code by the cockpit ----------------------------------------
  const codeInk = readable(spec.colour);
  p.text(0.255, 0.245, spec.code, {
    face: 'left', heightM: 0.075, colour: codeInk, weight: 700, tracking: 0.07,
  });
  p.text(0.255, 0.755, spec.code, {
    face: 'right', heightM: 0.075, colour: codeInk, weight: 700, tracking: 0.07,
  });

  // --- Panel seams --------------------------------------------------------
  // Hairlines where the engine cover meets the chassis. Cheap, and the eye reads
  // them as separate pieces of bodywork rather than one moulded lump.
  p.ctx.fillStyle = 'rgba(0,0,0,0.30)';
  p.ctx.fillRect(p.px(0.40), p.py(0.15), Math.max(1, p.w * 0.0025), p.h * 0.70);
  p.ctx.fillRect(p.px(0.895), p.py(0.15), Math.max(1, p.w * 0.002), p.h * 0.70);
}

/** Sidepod: inlet surround, downwash ramp, and the flash that runs off the body. */
function paintPod(p: Panel, spec: LiverySpec, flash: number): void {
  p.fill(css(spec.colour));
  p.band(0, 1, 0.0, 0.12, '#101216');
  p.band(0, 1, 0.88, 1.0, '#101216');

  // Dark surround at the inlet, so the mouth reads as a hole in bodywork.
  p.band(0.0, 0.035, 0.0, 1.0, '#0a0c11');

  // Flash along both flanks — the pods are mirror images of one another in the
  // world but share this panel, so both sides have to carry it.
  for (const g of [0.25, 0.75] as const) {
    const s = g > 0.5 ? -1 : 1;
    p.poly([
      [0.03, g - s * 0.075], [0.03, g + s * 0.085],
      [0.30, g + s * 0.095], [0.62, g + s * 0.075],
      [0.90, g + s * 0.030], [1.0, g],
      [1.0, g - s * 0.035], [0.72, g - s * 0.005],
      [0.40, g + s * 0.010], [0.14, g - s * 0.020],
    ], css(flash));
  }

  // Shoulder hairline: the pod's own panel split.
  p.ctx.fillStyle = 'rgba(0,0,0,0.22)';
  p.ctx.fillRect(p.x, p.py(0.605), p.w, Math.max(1, p.h * 0.012));
  p.ctx.fillRect(p.x, p.py(0.385), p.w, Math.max(1, p.h * 0.012));
}

/** Airbox and roll hoop: accent crown, driver code on the flanks. */
function paintAirbox(p: Panel, spec: LiverySpec, flash: number): void {
  p.fill(css(spec.colour));
  p.band(0, 1, 0.43, 0.57, css(flash));
  p.band(0, 1, 0.0, 0.10, '#101216');
  p.band(0, 1, 0.90, 1.0, '#101216');
  // The mouth end goes dark: it is a duct, not a nose.
  p.band(0.0, 0.10, 0.0, 1.0, '#08090e');

  const codeInk = readable(spec.colour);
  p.text(0.42, 0.255, spec.code, {
    face: 'left', heightM: 0.105, colour: codeInk, weight: 800, slant: 0.12, tracking: 0.04,
  });
  p.text(0.42, 0.745, spec.code, {
    face: 'right', heightM: 0.105, colour: codeInk, weight: 800, slant: 0.12, tracking: 0.04,
  });
}

/** Colour for each flat swatch, derived from the team's two colours. */
function swatchColour(name: SwatchName, spec: LiverySpec, flash: number): number {
  switch (name) {
    case 'body': return spec.colour;
    case 'accent': return flash;
    case 'carbon': return 0x0f1115;
    case 'trim': return 0x1e222a;
    case 'rim': return 0xb4bcc6;
    case 'tyre': return 0x101216;
    case 'glass': return 0x090c13;
    case 'light': return 0xff2408;
    // A helmet in a lifted version of the accent reads as the driver's own
    // rather than as a second piece of bodywork.
    case 'helmet': return shade(flash, luminance(flash) > 0.5 ? -0.3 : 0.4);
    case 'suit': return shade(spec.colour, -0.4);
    case 'glove': return 0x15181e;
    case 'dark': return 0x04050a;
  }
}

// ===========================================================================
// Texture assembly
// ===========================================================================

const cache = new Map<string, LiveryTextures>();
let sharedSurface: THREE.Texture | null = null;

/**
 * Green = roughness, blue = metalness, matching three.js's channel convention so
 * one texture can serve as both maps.
 *
 * This is where the matte/gloss split lives. It is identical for every car, so
 * twenty cars share one copy of it.
 */
function buildSurfaceMap(size: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const set = (rough: number, metal: number) =>
    `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // Default: satin, so anything not explicitly covered still behaves.
  ctx.fillStyle = set(0.45, 0.2);
  ctx.fillRect(0, 0, size, size);

  const body = new Panel(ctx, PANEL.body, size);
  body.fill(set(0.28, 0.32));
  // Satin deck: the strip along the top centreline of the car.
  body.band(0, 1, 0.42, 0.58, set(0.58, 0.14));
  // Carbon underside.
  body.band(0, 1, 0.0, 0.13, set(0.52, 0.14));
  body.band(0, 1, 0.87, 1.0, set(0.52, 0.14));

  const pod = new Panel(ctx, PANEL.pod, size);
  pod.fill(set(0.28, 0.32));
  pod.band(0, 1, 0.42, 0.58, set(0.6, 0.13));
  pod.band(0.0, 0.05, 0.0, 1.0, set(0.85, 0.05));

  const air = new Panel(ctx, PANEL.airbox, size);
  air.fill(set(0.30, 0.30));
  air.band(0, 1, 0.42, 0.58, set(0.58, 0.14));
  air.band(0.0, 0.12, 0.0, 1.0, set(0.9, 0.03));

  const surfaceFor: Record<SwatchName, [number, number]> = {
    body: [0.30, 0.32],
    accent: [0.28, 0.30],
    carbon: [0.72, 0.07],
    trim: [0.58, 0.30],
    rim: [0.26, 0.92],
    tyre: [0.94, 0.02],
    glass: [0.06, 0.15],
    light: [0.40, 0.05],
    helmet: [0.20, 0.22],
    suit: [0.82, 0.02],
    glove: [0.88, 0.02],
    dark: [0.96, 0.02],
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
export function buildLivery(spec: LiverySpec, size = 512): LiveryTextures {
  const key = `${spec.colour}:${spec.accent}:${spec.number}:${spec.code}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const flash = contrastFlash(spec.colour, spec.accent);
  const ink = readable(flash);

  // Fill everything with the body colour first, so a UV that lands on unused
  // atlas space picks up something plausible rather than transparent black.
  ctx.fillStyle = css(spec.colour);
  ctx.fillRect(0, 0, size, size);

  const mk = (name: PanelName) =>
    new Panel(ctx, PANEL[name], size, PANEL_SIZE[name].lengthM, PANEL_SIZE[name].girthM);

  paintBody(mk('body'), spec, flash, ink);
  paintPod(mk('pod'), spec, flash);
  paintAirbox(mk('airbox'), spec, flash);

  for (const name of SWATCH_ORDER) {
    new Panel(ctx, swatchRect(name), size).fill(css(swatchColour(name, spec, flash)));
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;

  if (!sharedSurface) sharedSurface = buildSurfaceMap(size);

  const result: LiveryTextures = { map, surface: sharedSurface };
  cache.set(key, result);
  return result;
}

export function disposeLiveryCache(): void {
  for (const t of cache.values()) t.map.dispose();
  cache.clear();
  sharedSurface?.dispose();
  sharedSurface = null;
}
