import type { Raster } from './png';

/**
 * A FAITHFUL OFF-LINE MODEL OF THE OUTPUT END OF `PostFX`, so that a grade can
 * be FITTED instead of guessed.
 *
 * WHY THIS EXISTS. One shoot of `probe:sharpness` is a Vite build, a preview
 * server, a headful Chrome and eleven circuits — twenty-five minutes on a quiet
 * machine and considerably worse on this one. Fitting six numbers per ambience
 * against four reference frames by re-shooting after every guess is not a
 * measurement loop, it is a week. This takes a frame the renderer has already
 * produced, runs the display pipeline BACKWARDS to recover the linear radiance
 * that produced it, applies a candidate grade in exactly the arithmetic the
 * shader uses, and runs the pipeline forwards again. A parameter sweep then
 * costs a second.
 *
 * WHAT IT IS AND IS NOT. It is exact for everything the grade touches: the
 * matrices, `RRTAndODTFit` and the sRGB transfer are three's own, copied from
 * `tonemapping_pars_fragment.glsl.js` and `colorspace_pars_fragment`, and the
 * grade arithmetic is line-for-line the block in `GRADE_SHADER`.
 *
 * IT IS NOT EXACT IN ONE PLACE AND THE PLACE IS NAMED: ACES clamps to [0,1] at
 * the end, so every pixel that came out of the tone mapper at 255 could have
 * been produced by any of an unbounded range of linear inputs, and the inverse
 * has to pick one. It picks the boundary. A frame with a lot of clipped
 * highlights therefore under-predicts what raising contrast will do to them.
 * `probe:grade`'s daylight frames clip 4.4% and 9.2% of their pixels, so the
 * model is used to CHOOSE the parameters and a real shoot is used to CONFIRM
 * them — which is the check that the model was good enough, and it is reported
 * either way.
 */

export interface GradeParams {
  balance: [number, number, number];
  contrast: number;
  pivot: number;
  toe: number;
  toeRange: number;
  saturation: number;
}

export const IDENTITY: GradeParams = {
  balance: [1, 1, 1], contrast: 1, pivot: 0.18, toe: 0, toeRange: 0.06, saturation: 1,
};

// three's ACESInputMat / ACESOutputMat, row-major here (the GLSL literals above
// are column-major, i.e. already transposed from the ACES source).
const IN_MAT = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];
const OUT_MAT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function mul(m: number[][], v: [number, number, number]): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function inverse3(m: number[][]): number[][] {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const IN_INV = inverse3(IN_MAT);
const OUT_INV = inverse3(OUT_MAT);

function rrt(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

/** Monotonic on the range that matters, so bisection is exact and stable. */
function rrtInverse(y: number): number {
  let lo = 0;
  let hi = 64;
  // 24 halvings of a 64-wide bracket is 4e-6, which is three orders of
  // magnitude below one 8-bit code value at the darkest end of the range.
  for (let k = 0; k < 24; k++) {
    const mid = 0.5 * (lo + hi);
    if (rrt(mid) < y) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** Display sRGB byte triple -> scene linear radiance, exposure divided out. */
export function toScene(r: number, g: number, b: number, exposure: number): [number, number, number] {
  const disp: [number, number, number] = [
    srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255),
  ];
  const ap1 = mul(OUT_INV, disp);
  const fit: [number, number, number] = [
    rrtInverse(ap1[0]), rrtInverse(ap1[1]), rrtInverse(ap1[2]),
  ];
  const lin = mul(IN_INV, fit);
  const k = exposure / 0.6;
  return [lin[0] / k, lin[1] / k, lin[2] / k];
}

/** Scene linear radiance -> display sRGB bytes. Three's ACES, exactly. */
export function toDisplay(v: [number, number, number], exposure: number): [number, number, number] {
  const k = exposure / 0.6;
  const ap1 = mul(IN_MAT, [v[0] * k, v[1] * k, v[2] * k]);
  const fit: [number, number, number] = [rrt(ap1[0]), rrt(ap1[1]), rrt(ap1[2])];
  const out = mul(OUT_MAT, fit);
  return [
    Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, out[0])))),
    Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, out[1])))),
    Math.round(255 * linearToSrgb(Math.min(1, Math.max(0, out[2])))),
  ];
}

/** The grade block from `GRADE_SHADER`, in TypeScript. Keep the two in step. */
export function applyGrade(v: [number, number, number], g: GradeParams): [number, number, number] {
  let c: [number, number, number] = [
    Math.max(0, v[0]) * g.balance[0],
    Math.max(0, v[1]) * g.balance[1],
    Math.max(0, v[2]) * g.balance[2],
  ];
  c = [
    g.pivot * Math.pow(c[0] / g.pivot, g.contrast),
    g.pivot * Math.pow(c[1] / g.pivot, g.contrast),
    g.pivot * Math.pow(c[2] / g.pivot, g.contrast),
  ];
  if (g.toe > 0.001) {
    const sl = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const t = Math.min(1, Math.max(0, sl / g.toeRange));
    const s = t * t * (3 - 2 * t);
    const k = (1 - g.toe) + g.toe * s;
    c = [c[0] * k, c[1] * k, c[2] * k];
  }
  const gl = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [
    gl + (c[0] - gl) * g.saturation,
    gl + (c[1] - gl) * g.saturation,
    gl + (c[2] - gl) * g.saturation,
  ];
}

/**
 * Predict what a frame would look like with a grade applied and, optionally, a
 * different tone-mapping exposure. `exposureIn` must be the exposure the frame
 * was actually rendered at — see `EXPOSURE` in `Renderer.ts`.
 */
export function regrade(
  img: Raster,
  g: GradeParams,
  exposureIn: number,
  exposureOut = exposureIn,
): Raster {
  const out = new Uint8Array(img.rgb.length);
  // The inverse tone map is the expensive part and an 8-bit input has only 256
  // distinct values per channel, but the matrices mix channels so the cache has
  // to be on the whole triple. In practice a frame has far fewer distinct
  // triples than pixels, which is what makes this fast enough to sweep.
  const cache = new Map<number, number>();
  for (let p = 0; p < img.rgb.length; p += 3) {
    const key = (img.rgb[p] << 16) | (img.rgb[p + 1] << 8) | img.rgb[p + 2];
    let hit = cache.get(key);
    if (hit === undefined) {
      const scene = toScene(img.rgb[p], img.rgb[p + 1], img.rgb[p + 2], exposureIn);
      const [r, gg, b] = toDisplay(applyGrade(scene, g), exposureOut);
      hit = (r << 16) | (gg << 8) | b;
      cache.set(key, hit);
    }
    out[p] = (hit >> 16) & 0xff;
    out[p + 1] = (hit >> 8) & 0xff;
    out[p + 2] = hit & 0xff;
  }
  return { width: img.width, height: img.height, rgb: out };
}
