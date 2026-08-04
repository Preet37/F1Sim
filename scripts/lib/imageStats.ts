import type { Raster } from './png';

/**
 * The numbers that describe "the look" of a frame, and nothing else.
 *
 * WHY THESE AND NOT OTHERS
 *
 * The brief for issue #78 is that the reference frames have "a broadcast look —
 * slightly desaturated, high contrast, warm key" and ours does not. That is a
 * claim about four separable things, and until they are separated the claim
 * cannot be acted on, only agreed with. Every visual claim made from a
 * screenshot in this project has eventually turned out to be wrong (PROJECT.md
 * §3.1), and "it looks flat" is the flattest claim of all.
 *
 *  - EXPOSURE is where the mid tone sits: `p50`.
 *  - CONTRAST is how far the tones spread: `rms`, plus the black and white
 *    points (`p1`, `p99`) which say whether the spread is achieved by crushing,
 *    by clipping, or by neither.
 *  - SATURATION is mean HSV S over the frame. Deliberately HSV rather than
 *    chroma-in-Lab: S is scale-free in luminance, so a dark frame and a bright
 *    frame of the same scene report the same number and the saturation question
 *    does not get contaminated by the exposure one.
 *
 *    THE SAME SCALE-FREENESS IS ALSO THIS METRIC'S ONE FAILURE MODE, AND IT IS
 *    GUARDED. `S = (max - min) / max` is a ratio of small integers near black,
 *    so the sRGB triple (1, 2, 4) — visually indistinguishable from black —
 *    reports a saturation of 0.75. Measured on the first run of `probe:grade`,
 *    our Bahrain night sky came back at 0.670 against the reference's 0.060,
 *    and essentially all of that was quantisation noise in a near-black navy
 *    gradient rather than a picture that was actually seven-tenths saturated.
 *    Saturation is therefore averaged over pixels above `SAT_FLOOR` only, and
 *    the fraction of the frame that qualified is reported alongside it so a
 *    number taken over 3% of the pixels cannot be read as a number about the
 *    frame. This is a correction to a broken instrument, not a loosened
 *    tolerance: the guarded metric is STRICTER on any frame that is genuinely
 *    saturated and it stops a dark frame scoring highly for nothing.
 *  - WHITE BALANCE is `warmth`, mean(R) - mean(B) in code values. A warm key
 *    against a cool ambient is the single most identifiable thing about
 *    television lighting, and it is one subtraction.
 *
 * All of it is computed on the DISPLAY-REFERRED image — 8-bit sRGB code values,
 * after the tone map — because that is the image the user is looking at when
 * they say it looks wrong, and because the reference frames exist only in that
 * form. Working in linear light here would be more principled and would answer
 * a different question.
 *
 * `grain` is the same instrument issue #29 built: mean absolute Laplacian of
 * luma. It is here so that a grade change can be shown NOT to have traded
 * sharpness away, which §6 records as hard-won at 5.4-11.3x.
 */
export interface LookStats {
  /** Pixels measured. */
  n: number;
  /** Rec.709 luma percentiles, 0..255, on the display-referred image. */
  p1: number;
  p5: number;
  p50: number;
  p95: number;
  p99: number;
  /** Mean luma, 0..255. */
  mean: number;
  /** Standard deviation of luma, 0..255. The contrast number. */
  rms: number;
  /** Mean HSV saturation over pixels above `SAT_FLOOR`, 0..1. */
  sat: number;
  /** Fraction of the frame that was bright enough to contribute to `sat`. */
  satCoverage: number;
  /** mean(R) - mean(B), code values. Positive is warm. */
  warmth: number;
  /** Fraction of pixels below luma 32 — how much of the frame is in shadow. */
  shadowFrac: number;
  /** Fraction of pixels above luma 224. */
  highlightFrac: number;
  /** Mean absolute Laplacian of luma. The #29 grain/sharpness instrument. */
  grain: number;
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Below this sRGB code value, HSV saturation is quantisation noise. See the
 * header. 24 is a little under 10% of the range and roughly where an 8-bit
 * triple has enough separation for its hue to mean anything.
 */
const SAT_FLOOR = 24;

export function lookStats(img: Raster): LookStats {
  const { width, height, rgb } = img;
  const n = width * height;
  const luma = new Float32Array(n);
  const hist = new Uint32Array(256);
  let sumR = 0, sumG = 0, sumB = 0, sumS = 0, satN = 0;

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
    const y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    luma[i] = y;
    hist[Math.min(255, Math.max(0, Math.round(y)))]++;
    sumR += r; sumG += g; sumB += b;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (mx >= SAT_FLOOR) {
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      sumS += (mx - mn) / mx;
      satN++;
    }
  }

  const pct = (f: number): number => {
    const want = f * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= want) return v;
    }
    return 255;
  };

  let sumY = 0;
  for (let i = 0; i < n; i++) sumY += luma[i];
  const mean = sumY / n;
  let varY = 0;
  for (let i = 0; i < n; i++) { const d = luma[i] - mean; varY += d * d; }

  let dark = 0, bright = 0;
  for (let v = 0; v < 32; v++) dark += hist[v];
  for (let v = 225; v < 256; v++) bright += hist[v];

  // Laplacian, interior only.
  let lap = 0;
  let lapN = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      lap += Math.abs(v);
      lapN++;
    }
  }

  return {
    n,
    p1: pct(0.01),
    p5: pct(0.05),
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
    mean,
    rms: Math.sqrt(varY / n),
    sat: satN ? sumS / satN : 0,
    satCoverage: satN / n,
    warmth: (sumR - sumB) / n,
    shadowFrac: dark / n,
    highlightFrac: bright / n,
    grain: lapN ? lap / lapN : 0,
  };
}

/** Grain in horizontal bands, top to bottom — the #29 depth-band instrument. */
export function grainBands(img: Raster, bands: number): number[] {
  const { width, height, rgb } = img;
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    luma[i] = LUMA_R * rgb[p] + LUMA_G * rgb[p + 1] + LUMA_B * rgb[p + 2];
  }
  const out: number[] = [];
  for (let b = 0; b < bands; b++) {
    const y0 = Math.max(1, Math.floor((b * height) / bands));
    const y1 = Math.min(height - 1, Math.floor(((b + 1) * height) / bands));
    let acc = 0, cnt = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        acc += Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width]);
        cnt++;
      }
    }
    out.push(cnt ? acc / cnt : 0);
  }
  return out;
}

export function fmtStats(s: LookStats): string {
  return [
    `p50 ${s.p50.toString().padStart(3)}`,
    `rms ${s.rms.toFixed(1).padStart(5)}`,
    `sat ${s.sat.toFixed(3)}/${(s.satCoverage * 100).toFixed(0).padStart(3)}%`,
    `warm ${s.warmth >= 0 ? '+' : ''}${s.warmth.toFixed(1).padStart(5)}`,
    `p1 ${s.p1.toString().padStart(3)}`,
    `p99 ${s.p99.toString().padStart(3)}`,
    `shad ${(s.shadowFrac * 100).toFixed(1).padStart(4)}%`,
    `hi ${(s.highlightFrac * 100).toFixed(1).padStart(4)}%`,
    `grain ${s.grain.toFixed(2).padStart(5)}`,
  ].join('  ');
}
