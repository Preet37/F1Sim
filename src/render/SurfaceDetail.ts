import * as THREE from 'three';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Surface detail for the circuit's geometry.
 *
 * Before this existed, every surface in the game was one flat vertex colour
 * over hundreds of square metres — asphalt was a grey field, grass was a green
 * field, and the only thing breaking either up was the lighting. That single
 * property is the strongest "untextured 3D scene" signal there is, and no
 * amount of post-processing hides it: a perfectly graded, bloomed, tone-mapped
 * image of a flat grey plane is still a flat grey plane.
 *
 * The fix is texture, but not a texture *atlas*. UV-mapping a 7km circuit built
 * from a swept spline means either stretching a texture over segments of wildly
 * different length or building a UV solve nobody needs. Instead the detail is
 * projected from world XZ in the shader:
 *
 *  - Nothing to unwrap. Any geometry passing under the projection picks up
 *    detail, including geometry generated at load time from the track spline.
 *  - Adjacent surfaces line up automatically, because they share one projection.
 *    Grass meeting runoff meeting asphalt has no seam.
 *  - It tiles at two scales at once. One scale alone reveals its own period as
 *    an obvious repeating grid the moment you look down a straight; two
 *    incommensurate scales multiplied together have a period long enough that
 *    the eye never finds it.
 *
 * The projection is planar, so it stretches on a vertical face. Walls therefore
 * run at a low strength and no normal perturbation, where the stretch does not
 * read.
 *
 * Everything is generated at runtime. Two 256px textures cost a few
 * milliseconds to build — the separable low pass the normal map is band-limited
 * with is the bulk of it, at 256*256*23*2 multiply-adds, and it runs once per
 * session — and nothing to download.
 */

/** Per-surface detail tuning. */
export interface SurfaceProfile {
  /** Tiling frequency of the two octaves, in cycles per metre. */
  scaleA: number;
  scaleB: number;
  /** How much each octave darkens the base colour, 0..1. */
  strengthA: number;
  strengthB: number;
  /** Bump strength. Zero on vertical faces, where a planar projection smears. */
  normalStrength: number;
  /** How much the grain varies the roughness — wet-looking patches and sheen. */
  roughnessVariation: number;
  roughness: number;
  metalness: number;

  // --- Road-surface terms --------------------------------------------------
  //
  // All four default to zero and cost nothing when they do: the shader code for
  // a term is only injected when its strength is non-zero, so grass and walls
  // compile the same two-fetch program they always did.

  /**
   * Visible aggregate: the individual stones in the mix.
   *
   * Sampled at metre-scale and contrast-stretched so the grain resolves into
   * discrete speckle rather than a smooth wash. This is what stops asphalt
   * reading as felt in a close camera.
   */
  aggregate?: number;
  /** Frequency of the aggregate speckle, cycles per metre. */
  aggregateScale?: number;
  /**
   * Paving seams and cracks.
   *
   * Taken from the zero crossing of a mid-scale noise field rather than a grid.
   * A grid in world XZ would put parallel straight joints across a circuit that
   * curves through every heading, which reads as a floor tile. The zero set of
   * a noise field meanders the way a real cold joint or a crack does.
   */
  seams?: number;
  seamScale?: number;
  /**
   * Patch repairs: broad regions of newer, darker, smoother asphalt with a hard
   * edge. Thresholding low-frequency noise gives exactly that — blobs with a
   * definite boundary rather than a gradient.
   */
  patches?: number;
  patchScale?: number;
  /**
   * How strongly this surface responds to water, 0..1. Defaults to 1.
   *
   * Not every material goes glossy when it rains. Asphalt does — a wet road is
   * darker and near-mirror, which is the single most recognisable thing about
   * a wet circuit. Grass does not: it gets darker and stays matte, because the
   * water goes into it rather than onto it. Getting that wrong turns the
   * verges into sheets of glass and the whole scene into a swimming pool, which
   * is the failure mode a single global wetness term always has.
   *
   * A uniform rather than a compiled-in constant so that it does not have to
   * appear in `customProgramCacheKey` and multiply the program count by the
   * number of distinct values.
   */
  wetResponse?: number;
  /**
   * How strongly this surface takes rubber from the racing line.
   *
   * See `setRubberLine`. Asphalt takes it fully, paint and kerbs partially
   * (rubber goes over the lines and over the kerbs at an apex), grass none.
   */
  rubber?: number;
}

export const SURFACES: Record<string, SurfaceProfile> = {
  /**
   * Asphalt. Fine aggregate grain plus a much broader patchiness for the
   * resurfacing seams and age variation every real circuit has.
   */
  asphalt: {
    scaleA: 1.4, scaleB: 0.055,
    strengthA: 0.3, strengthB: 0.22,
    normalStrength: 0.42,
    // Down from 0.55, and the aggregate terms below are down much further.
    //
    // Measured, not guessed: with every post-processing pass disabled, the
    // asphalt within five metres of a bumper camera carried 2.6 display levels
    // of high-frequency variance against the sky's 0.0. That is the "still
    // grainy" report, and none of it was the dither in the grade pass — which
    // measures 0.01 of a level and is doing exactly what it was retuned to do.
    // It was here.
    //
    // The mechanism is specular aliasing. A normal map fed by a noise field
    // whose finest octave has a four-pixel period, sampled at five and a half
    // tiles per metre, puts a 3mm bump on the road; three metres from the
    // camera that is a fifth of a pixel. Mip-mapping averages the NORMALS but
    // cannot widen the specular lobe to match, so every one of those sub-pixel
    // facets either catches a floodlight or does not, and the road boils.
    // Under a floodlit night sky, where the sheen is most of what the surface
    // is, it boils hard.
    //
    // THE DIAGNOSIS ABOVE WAS RIGHT AND THE REMEDY WAS NOT. Trimming this
    // number and the aggregate frequency moved the tint and left the derivative
    // where it was, because slope goes as amp/period and the period never
    // changed. It came back as issue #48 and the near field measured 11.3x the
    // mid-distance; see THE BUMP BAND LIMIT below for the mechanism and the
    // fix, which is in the map rather than in this number. 0.42 is unchanged.
    roughnessVariation: 0.16,
    // 0.58 rather than 0.62. Asphalt is rough, but it is not chalk: a wide,
    // low-frequency sheen sweeps across it wherever a light source is roughly
    // mirrored, and under floodlights that sheen is most of what the surface
    // IS. At 0.62 the specular lobe was wide enough to be indistinguishable
    // from the diffuse term and the road went dead flat at night. Below about
    // 0.55 it goes the other way and the lobe tightens into a single glaring
    // hotspot that fills the onboard camera.
    roughness: 0.58, metalness: 0.05,
    // Just over half the frequency, and most of the strength kept.
    //
    // Doubling the stone size takes the finest octave from a fifth of a pixel
    // to nearly half of one at the range that was boiling, which is the side of
    // the sampling limit it has to be on. The strength stays high because this
    // term does two different jobs and only one of them was the problem: it
    // TINTS, which a mip chain filters correctly and which is what stops the
    // road reading as a grey plane, and it BUMPS, which a mip chain cannot
    // filter correctly and which is where the sparkle came from. So the tint
    // keeps its strength and the bump below is cut to a third of it and faded
    // on its own footprint.
    aggregate: 0.45, aggregateScale: 3.0,
    // Seams and patches, both turned right down from 0.55 and 0.85.
    //
    // At those strengths the zero-set of the seam field read as a network of
    // dark branching veins over the whole circuit — the road looked like
    // cracked dry mud, and the patch field piled broad dark blotches on top.
    // The user reported this repeatedly as the track being "grainy" and as
    // "black shit on the track".
    //
    // Three separate sessions hunted it and missed, because every one of them
    // measured TEMPORAL variance — render, jitter the camera by a fraction of a
    // pixel, difference the frames. That finds shimmer and aliasing, and it
    // correctly found the catch fence. But a crack is a STATIC feature: it sits
    // still, it differences to nothing, and it is invisible to that method
    // however ugly it looks. The lesson is that "grainy" needed someone to LOOK
    // at a still frame, not to measure one.
    //
    // Real asphalt does have joints and repairs, so these are not zero — just
    // faint enough to read as surface history rather than as damage.
    seams: 0.10, seamScale: 0.045,
    patches: 0.18, patchScale: 0.02,
    rubber: 1,
  },
  /**
   * Painted lines and grid markings.
   *
   * Deliberately not glossy. Track paint is matte in reality, and a low
   * roughness here puts a mirror-bright specular band right across the circuit
   * wherever the sun's reflection lands — which the bloom pass then amplifies
   * into a blown-out white stripe across the racing line.
   */
  paint: {
    scaleA: 1.4, scaleB: 0.055,
    strengthA: 0.12, strengthB: 0.1,
    normalStrength: 0.15,
    roughnessVariation: 0.1,
    roughness: 0.72, metalness: 0.0,
    aggregate: 0.16, aggregateScale: 5.5,
    // Paint wears through where the cars run over it — a white line that
    // survives the racing line untouched is a line nobody has driven on.
    rubber: 0.75,
  },
  /** Kerbs: painted concrete, worn and scuffed by cars running over them. */
  kerb: {
    scaleA: 2.2, scaleB: 0.12,
    strengthA: 0.18, strengthB: 0.16,
    normalStrength: 0.3,
    roughness: 0.55, metalness: 0.02,
    roughnessVariation: 0.18,
    aggregate: 0.2, aggregateScale: 6.5,
    rubber: 0.5,
  },
  /** Gravel and tarmac run-off: coarse, matte, strongly broken up. */
  runoff: {
    scaleA: 0.75, scaleB: 0.09,
    strengthA: 0.42, strengthB: 0.3,
    // 0.85, not 1.1, for the same sampling reason as the asphalt above: run-off
    // fills the outside of every corner, so it is on screen at grazing angles
    // constantly, and a bump map past about 0.9 sparkles there for exactly the
    // same reason it did on the road.
    normalStrength: 0.85,
    roughnessVariation: 0.15,
    roughness: 0.92, metalness: 0,
    wetResponse: 0.85,
  },
  /** Grass: large-scale mottling, mowing variation, no sheen at all. */
  grass: {
    scaleA: 0.55, scaleB: 0.035,
    strengthA: 0.4, strengthB: 0.34,
    normalStrength: 0.8,
    roughnessVariation: 0.08,
    roughness: 0.97, metalness: 0,
    // Water soaks in rather than sitting on top. Grass gets darker; it does
    // not become a mirror, and a scene where it does looks flooded.
    wetResponse: 0.3,
  },
  /** Concrete walls and barriers. Planar projection, so no bump. */
  wall: {
    scaleA: 0.5, scaleB: 0.06,
    strengthA: 0.16, strengthB: 0.12,
    normalStrength: 0,
    roughnessVariation: 0.1,
    roughness: 0.8, metalness: 0.04,
    // Only the splash line at the bottom is ever really wet, and this shader
    // has no way to know where that is.
    wetResponse: 0.4,
  },
};

/* ---------------------------------------------------------------------------
 * THE BUMP BAND LIMIT — issue #48.
 *
 * The report is a Bahrain night frame whose far and mid-distance asphalt reads
 * smooth and correct and whose near field — the bottom third — is dense
 * high-frequency speckle, with a visible transition band across it. Measured
 * with `probe:grain` (mean absolute Laplacian of luma, road pixels only, banded
 * over the road's own extent in the frame), the near-field asphalt carried
 * **11.3x** the high-frequency energy of the mid-distance at Bahrain by night
 * and 6.0x by day, on the `low` tier the reporter's phone was pinned to. The
 * profile far -> near was 2.1 1.5 1.6 2.2 12.2 17.9: flat, then a cliff.
 *
 * IT IS THE NORMAL MAP AND NOTHING ELSE. Bisected by measurement, not argued:
 * setting `asphalt.normalStrength` to zero takes 11.32 -> 0.88 and 6.04 -> 0.73
 * and flattens the whole profile. Zeroing the aggregate bump instead moves the
 * number by 0.02, so it is not the fine stones — it is the base band. The other
 * three suspects in the issue are all clear: anisotropy is already 16 on both
 * maps and on the fence, kerb and marker textures; there is no negative mip
 * bias anywhere in `src/`; and the procedural threshold terms are already
 * widened by their own `fwidth`.
 *
 * WHY IT COULD ONLY EVER HAVE ALIASED. The height field's finest octave has a
 * four-texel period in a 256-texel tile, and the asphalt tiles that map at
 * `scaleA` = 1.4 cycles per metre — so that octave is an **11mm** bump. A
 * central difference is a high-pass filter: an octave contributes to the SLOPE
 * in proportion to amp/period, so that band carried 59% of the map's gradient
 * energy while carrying 35% of its contrast. From a camera 0.77m above the road
 * the along-view footprint of one pixel is z^2/h times the pixel angle, which
 * at the cockpit's 40 degrees over 1396 rows is 6.5e-4 * z^2 metres: 2.8mm at
 * 2m, 5.9mm at 3m, 23mm at 6m. An 11mm feature is therefore under two pixels
 * from three metres out and never more than four pixels anywhere the road is on
 * screen. Mip-mapping averages the NORMALS, which is the wrong average — the
 * right one would widen the specular lobe to cover the range of normals in the
 * footprint — so each sub-pixel facet either mirrors a floodlight or misses it,
 * every frame, at random. `detailResolve` was the guard against exactly this
 * and it did its job in the only direction it was pointed: it fades a band out
 * with DISTANCE, so beyond ~4m the bump is gone (which is why the mid-distance
 * measures 1.5 and reads as a flat plane), and inside ~2m it is at full
 * strength (which is why the near field measures 17.9). The transition band the
 * user can see IS that smoothstep.
 *
 * So the amplitude was never the free variable. An 11mm bump cannot be drawn on
 * this road at any strength; the relief has to move to a wavelength the road can
 * carry. The normal map is therefore differentiated from a LOW-PASSED copy of
 * the height field. The R channel — the tint, the roughness break-up, the
 * aggregate contrast stretch — is untouched, because a mip chain filters colour
 * correctly and colour was never the problem.
 *
 * WHAT WAS TRIED AND REJECTED, because it is the obvious idea and it is wrong:
 * restoring the map's original RMS SLOPE after the low pass, so the surface
 * keeps the same distribution of facet angles at a longer wavelength. It was
 * implemented and measured. The near/mid ratio at Bahrain by night came down
 * only to 3.74 — still a cliff, still failing — and the road photographs as
 * coarse gravel or hammered metal rather than as asphalt, because a 13-degree
 * mean slope at 45mm is a genuinely rough surface where the same slope at 11mm
 * is a fine one. Real asphalt is self-affine: its slope falls with wavelength,
 * and inventing slope back is inventing a road. The gain therefore stays at the
 * 2.4 it always was — the surviving bands keep their own amplitudes, mean slope
 * falls from 13.3 to 4.1 degrees and the worst facet from 40.7 to 12.1 — and the
 * measured result is 1.43 with the road still reading as a surface rather than
 * as a plane.
 *
 * THE SECOND HALF is `detailResolve`'s ramp, which was `smoothstep(0.25, 0.85)`
 * on cycles per pixel. Nyquist is 0.5, so that ramp drew a band at full strength
 * down to four pixels per cycle and at HALF strength at 1.8 pixels per cycle —
 * below the sampling limit — which is why the coarser map still measured 7.5 in
 * the middle distance until the ramp was corrected. It is `smoothstep(0.08,
 * 0.25)` now: full strength only while a band spans twelve pixels or more, gone
 * by four. Combined with the coarser map that leaves every surface's relief
 * reaching almost exactly as far as it did before — grass fades out at 6.6m
 * against 6.1m — so this is a change of CONTENT, not of extent.
 */

/**
 * Gaussian sigma, in texels, applied to the height field before the normal map
 * is differentiated from it.
 *
 * A Gaussian attenuates a sinusoid of period P by exp(-2*pi^2*sigma^2/P^2). At
 * 3.4 texels that is 0.000 at P=4, 0.026 at P=8, 0.404 at P=16 and 0.799 at
 * P=32 — so the 11mm and 22mm bands are gone and the 45mm and 89mm bands are
 * substantially kept.
 *
 * 3.4 is the SMALLEST sigma that makes the band the map claims to carry the band
 * it actually carries, and that is what fixes it rather than taste. Slope
 * contribution goes as amp/period, so P=8 starts out 5.4x heavier than P=16: at
 * sigma 2.6 the survivors are P=8 0.0069 against P=16 0.0054 and the map is
 * still an eight-texel map wearing a sixteen-texel label, which `detailResolve`
 * would then draw at Nyquist. At 3.4 it is 0.0012 against 0.0035 — P=16 leads
 * 2.9 to 1 — so 16 cycles per tile is an honest description of the map.
 */
const BUMP_SIGMA_TEXELS = 3.4;

/**
 * Cycles per tile of the finest band the normal map still carries after the low
 * pass above. Was effectively 64 — the four-texel octave.
 *
 * The shader needs this number rather than 64, because `detailResolve` fades a
 * band out on ITS OWN frequency, and a band limit is only worth anything if the
 * fade is told about it.
 */
const NORMAL_CYCLES_PER_TILE = 16;

/**
 * Gain on the low-passed field's central difference.
 *
 * 2.4, not 4, and NOT scaled up to make up for the low pass — see the block
 * above for the measurement that rejected that. A central difference over a
 * normalised field times four produces slopes past 60 degrees on the steepest
 * cells, and a 60-degree facet either mirrors a floodlight into the camera or
 * misses it entirely; there is no middle, and real asphalt has no such facets.
 */
const NORMAL_GAIN = 2.4;

/**
 * Separable Gaussian blur with wrapping edges.
 *
 * Wrapping is not optional: the whole point of the noise generator is that the
 * lattice wraps modulo each octave's period, and a blur that clamped at the
 * edges would put a seam back into a map built specifically not to have one.
 * Runs once, at texture build time, on a 256px field.
 */
function lowPassWrapped(field: Float32Array, size: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += kernel[k + radius] * field[y * size + ((x + k + size) % size)];
      }
      tmp[y * size + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += kernel[k + radius] * tmp[((y + k + size) % size) * size + x];
      }
      out[y * size + x] = acc;
    }
  }
  return out;
}

/**
 * Seamless multi-octave value noise, plus the normal map derived from it.
 *
 * Tiling is the whole trick: the lattice wraps modulo the octave's period, so
 * the left edge is genuinely the same as the right edge and the texture repeats
 * without a visible seam. Getting this wrong shows up as a grid of hard lines
 * across the track that is impossible to miss once seen.
 *
 * Three bands are packed into the one texture, because the road wants noise at
 * three different smoothnesses and three lookups would cost three times as much
 * as three channels of one:
 *
 *  R — every octave. Fine grain. The normal map is derived from a LOW-PASSED
 *      copy of this field rather than from the field itself; see the block
 *      above on issue #48.
 *  G — the two coarsest octaves only. Smooth, large blobs. Thresholding this is
 *      what gives patch repairs a clean boundary; thresholding R gives a mess of
 *      camouflage, because R still has quarter-metre detail in it at any scale.
 *  B — the middle octaves. Its half-value contour is a meandering curve of about
 *      the right wander for a paving joint or a crack.
 */
export function makeGrain(size = 256): { grain: THREE.DataTexture; normal: THREE.DataTexture } {
  const height = new Float32Array(size * size);
  const blob = new Float32Array(size * size);
  const mid = new Float32Array(size * size);

  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  // Octaves at powers of two so every one divides the texture exactly and
  // therefore wraps.
  //
  // The finest octave carries 0.34 rather than 0.5 of the total, with the
  // difference handed to the eight-pixel band. That octave is the one the
  // normal map used to be differentiated from and it has a four-pixel period,
  // so it is the finest thing the texture can express — and on a road tiled
  // several times per metre it lands below one screen pixel at any useful
  // range. Energy there cannot be resolved; it can only alias.
  //
  // ISSUE #48: reducing its amplitude was not enough and could not have been.
  // The weights below are amplitudes of the HEIGHT field, and a central
  // difference is a high-pass filter — an octave's contribution to the SLOPE
  // goes as amp/period, so the four-texel band was carrying 0.34/4 = 59% of the
  // whole map's gradient energy while carrying 35% of its contrast. Trimming
  // the amplitude moved the tint and left the derivative almost exactly where
  // it was. The colour band and the bump band therefore have to be separated,
  // which is what `bumpHeight` below does: the octaves stay as they are for the
  // R channel, and the normal map is differentiated from a low-passed copy.
  const octaves = [
    { period: 4, amp: 0.34, blob: 0, mid: 0 },
    { period: 8, amp: 0.38, blob: 0, mid: 0.18 },
    { period: 16, amp: 0.14, blob: 0, mid: 0.5 },
    { period: 32, amp: 0.07, blob: 0.34, mid: 1 },
    { period: 64, amp: 0.03, blob: 1, mid: 0 },
  ];

  for (const oct of octaves) {
    const { period, amp } = oct;
    const cells = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / period;
      const y0 = Math.floor(fy) % cells;
      const y1 = (y0 + 1) % cells;
      const ty = fy - Math.floor(fy);
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / period;
        const x0 = Math.floor(fx) % cells;
        const x1 = (x0 + 1) % cells;
        const tx = fx - Math.floor(fx);
        const sx = tx * tx * (3 - 2 * tx);

        const a = hash(x0, y0), b = hash(x1, y0);
        const c = hash(x0, y1), d = hash(x1, y1);
        const v = (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
        const i = y * size + x;
        height[i] += v * amp;
        if (oct.blob > 0) blob[i] += v * oct.blob;
        if (oct.mid > 0) mid[i] += v * oct.mid;
      }
    }
  }

  // Normalise to 0..1 so the profiles' strengths mean the same thing whatever
  // the octave weights happen to sum to.
  const normalise = (field: Float32Array) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      if (field[i] < lo) lo = field[i];
      if (field[i] > hi) hi = field[i];
    }
    const span = Math.max(hi - lo, 1e-6);
    for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) / span;
  };
  normalise(height);
  normalise(blob);
  normalise(mid);

  // The field the NORMAL map is differentiated from: the same height field,
  // low-passed so that nothing survives which the road cannot resolve. See
  // `BUMP_SIGMA_TEXELS` and `NORMAL_CYCLES_PER_TILE`. Separable and wrapping,
  // so the normal map still tiles exactly.
  const bumpHeight = lowPassWrapped(height, size, BUMP_SIGMA_TEXELS);

  const grainData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = height[i];
      const o = i * 4;
      grainData[o] = Math.round(v * 255);
      grainData[o + 1] = Math.round(blob[i] * 255);
      grainData[o + 2] = Math.round(mid[i] * 255);
      grainData[o + 3] = 255;

      // Central differences with wrapping indices, so the normal map tiles too.
      // Taken over `bumpHeight`, NOT over `height`: see issue #48 above. The R
      // channel written just above is still the full field, so the tint, the
      // roughness break-up and the aggregate stretch are all untouched — only
      // the derivative changed, because only the derivative was aliasing.
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = bumpHeight[y * size + xp] - bumpHeight[y * size + xm];
      const dy = bumpHeight[yp * size + x] - bumpHeight[ym * size + x];
      // Tangent-space normal of the height field, packed to 0..255. See
      // `NORMAL_GAIN` for why the gain is what it is and why the low pass is
      // deliberately NOT compensated for.
      let nx = -dx * NORMAL_GAIN, ny = -dy * NORMAL_GAIN, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      normalData[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalData[o + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    // 16, not 4. These are the only two textures in the game that are viewed at
    // a genuinely grazing angle — a road under a bumper camera is compressed
    // twenty to one along the view direction — and four samples across a
    // twenty-to-one footprint leaves most of the footprint unsampled, which is
    // the streaky half of the sparkle. They are 256px each, so the extra taps
    // cost almost nothing; three.js clamps the figure to what the GPU offers.
    t.anisotropy = 16;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return { grain: mk(grainData, false), normal: mk(normalData, false) };
}

/* ---------------------------------------------------------------------------
 * The rubbered-in racing line.
 *
 * A dark band worn down the ideal line is one of the strongest realism cues a
 * circuit has. Every reference photograph of a race track has one, and its
 * absence is a large part of why a procedurally generated road reads as CGI:
 * real asphalt is not uniform, it is a record of where cars have been.
 *
 * It cannot come from the XZ noise projection, because it is not a property of
 * a position on the ground — it is a property of the distance from a curve that
 * only the track spline knows. So it gets its own map: the racing line is
 * rasterised, once per session, into a single-channel top-down texture covering
 * the circuit's bounding box, and every surface samples it by world XZ through
 * the same planar projection as the grain. That means:
 *
 *  - No geometry has to change and nothing needs UVs. The asphalt, the painted
 *    lines and the kerbs all pick the band up from where they are in the world,
 *    and it crosses between them without a seam, exactly as rubber does.
 *  - The band follows `lineOffset`, so it sits where the racing line actually
 *    is — tight to the apex kerbs, wide on the exits — rather than down the
 *    middle of the road.
 *
 * The texture and its transform are module singletons that are *mutated* in
 * place rather than replaced. Uniform values are captured by reference when a
 * shader compiles, so a track loaded after the first compile still lands: the
 * pixels change under a texture object the programs already hold.
 */

/**
 * Coarsest the rubber map is allowed to be, metres per pixel.
 *
 * The map was a fixed 2048 square stretched over whatever the circuit's
 * bounding box happened to be, so its resolution was a function of circuit
 * SIZE — 0.53 m/px at Monaco, 0.64 at Bahrain, and 1.39 at Jeddah. The rubbered
 * band is 1.4 to 2.85m of half-width, so at Jeddah, Monza and Spa the racing
 * line was one to two pixels wide in the map, magnified back up with bilinear
 * filtering, and drawn as a 31% darkening with a large drop in roughness. A
 * dark, glossy ribbon reconstructed from a two-pixel stamp chain is a blocky,
 * aliased dark line down the middle of the road — and it appeared on the long
 * circuits and not on the short one that every fix was checked against.
 *
 * Sizing the map from the circuit instead of from a constant costs memory only
 * where it is needed: seven circuits stay at 2048.
 */
const RUBBER_MAX_M_PER_PX = 0.7;
/** Smallest and largest map, in pixels. */
const RUBBER_MIN_RES = 1024;
const RUBBER_MAX_RES = 4096;

let RUBBER_RES = 2048;
let RUBBER_DATA = new Uint8Array(RUBBER_RES * RUBBER_RES);
const RUBBER_TEX = new THREE.DataTexture(RUBBER_DATA, RUBBER_RES, RUBBER_RES, THREE.RedFormat);
RUBBER_TEX.wrapS = RUBBER_TEX.wrapT = THREE.ClampToEdgeWrapping;
RUBBER_TEX.magFilter = THREE.LinearFilter;
RUBBER_TEX.minFilter = THREE.LinearMipmapLinearFilter;
RUBBER_TEX.generateMipmaps = true;
// 16, not 4. This is the one texture in the scene viewed at the most grazing
// angle there is — it lies on the road and the camera looks along it — which is
// the argument the grain maps below already make for themselves.
RUBBER_TEX.anisotropy = 16;
RUBBER_TEX.needsUpdate = true;

/**
 * Resizes the shared map, keeping the same texture object.
 *
 * The object identity matters: uniform values are captured by reference when a
 * shader compiles, so every program already holding this texture has to keep
 * holding it. Only the image behind it is replaced.
 */
function resizeRubberMap(res: number): void {
  if (res === RUBBER_RES) return;
  RUBBER_RES = res;
  RUBBER_DATA = new Uint8Array(res * res);
  RUBBER_TEX.image = { data: RUBBER_DATA, width: res, height: res };
  RUBBER_TEX.needsUpdate = true;
}

/** World-to-map transform: (originX, originZ, 1/span, 1/span). */
const RUBBER_XF = new THREE.Vector4(0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * How much water is lying on the circuit, and where the dry line has got to.
 *
 *   x  mean water depth on the road, 0..1
 *   y  how far the racing line has dried relative to the rest, 0..1
 *   z  unused
 *   w  unused
 *
 * A single shared `Vector4`, held by reference by every compiled program for
 * the same reason `RUBBER_TEX` is: a session that starts dry and rains on lap
 * ten has to reach shaders that were compiled on lap one. Nothing here is
 * per-material, so writing to it once a frame updates the whole circuit.
 */
const WET = new THREE.Vector4(0, 0, 0, 0);

/**
 * Where water collects, rasterised once per session into a world-space map.
 *
 * WHY IT IS STATIC. The water field in the simulation evolves continuously, and
 * the obvious implementation is to re-rasterise it and re-upload every second
 * or two. That is the wrong trade. The part of the field that varies in SPACE —
 * which dips hold water, which crests shed it — is fixed by the circuit's
 * elevation and never changes; the part that varies in TIME is very nearly a
 * single scalar multiplying it. So the map is built once and the scalar is a
 * uniform, and the per-frame cost of standing water is one texture fetch and no
 * uploads at all.
 *
 * 512 rather than the rubber map's 2048, because the drainage field is smoothed
 * over about ninety metres in `TrackSurface` and there is nothing above that
 * frequency in it to resolve. At Spa's 7km bounding box that is fourteen metres
 * a pixel, which is four to seven pixels across a puddle — enough, with bilinear
 * filtering, for a soft-edged pool rather than a hard-edged one, which is what
 * a pool has.
 */
const POOL_RES = 512;
const POOL_DATA = new Uint8Array(POOL_RES * POOL_RES);
const POOL_TEX = new THREE.DataTexture(POOL_DATA, POOL_RES, POOL_RES, THREE.RedFormat);
POOL_TEX.wrapS = POOL_TEX.wrapT = THREE.ClampToEdgeWrapping;
POOL_TEX.magFilter = THREE.LinearFilter;
POOL_TEX.minFilter = THREE.LinearFilter;
POOL_TEX.generateMipmaps = false;
POOL_TEX.needsUpdate = true;

/**
 * Tells the whole circuit how wet it is.
 *
 * `wetness` is the mean water depth and `dryLine` is how much further the
 * racing line has dried than the road around it — 0 while it is raining, rising
 * as the line comes back. Cheap enough to call every frame and intended to be.
 */
export function setSurfaceWetness(wetness: number, dryLine: number): void {
  WET.x = wetness;
  WET.y = dryLine;
}

/** What the circuit currently thinks it is. For probes. */
export function surfaceWetness(): { wetness: number; dryLine: number } {
  return { wetness: WET.x, dryLine: WET.y };
}

/**
 * Rasterises a circuit's racing line into the shared rubber map.
 *
 * Call once when a session's track is known and before, or after, the track
 * mesh is built — either order works, because the texture object is shared and
 * only its contents change.
 *
 * Passing null clears the map, which is what the surfaces look like with no
 * rubber down: the state a brand new resurfacing is in.
 */
export function setRubberLine(track: TrackSpline | null, drainage?: Float32Array): void {
  if (!track) {
    RUBBER_DATA.fill(0);
    POOL_DATA.fill(0);
    RUBBER_XF.set(0, 0, 0, 0);
    RUBBER_TEX.needsUpdate = true;
    POOL_TEX.needsUpdate = true;
    return;
  }

  const { count, px, pz, nx, nz, lineOffset, lineCurvature } = track;

  // Square bounding box with a margin, so one metres-per-pixel figure covers
  // both axes and the band is not stretched on the long side of the circuit.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = px[i] + nx[i] * lineOffset[i];
    const z = pz[i] + nz[i] * lineOffset[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const margin = 40;
  const span = Math.max(maxX - minX, maxZ - minZ) + margin * 2;

  // Size the map to the circuit, then clear it — in that order, because
  // resizing allocates a fresh buffer and clearing the old one first would be
  // clearing the wrong array.
  let res = RUBBER_MIN_RES;
  while (res < RUBBER_MAX_RES && span / res > RUBBER_MAX_M_PER_PX) res *= 2;
  resizeRubberMap(res);
  RUBBER_DATA.fill(0);

  // Centre the circuit in the square rather than pinning it to a corner.
  const originX = (minX + maxX) * 0.5 - span * 0.5;
  const originZ = (minZ + maxZ) * 0.5 - span * 0.5;
  const pxPerM = RUBBER_RES / span;
  RUBBER_XF.set(originX, originZ, 1 / span, 1 / span);

  /** Soft disc, taking the maximum so overlapping stamps do not accumulate. */
  const stamp = (wx: number, wz: number, radiusM: number, peak: number) => {
    const cx = (wx - originX) * pxPerM;
    const cz = (wz - originZ) * pxPerM;
    const r = radiusM * pxPerM;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(RUBBER_RES - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r));
    const z1 = Math.min(RUBBER_RES - 1, Math.ceil(cz + r));
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - cz;
      const row = z * RUBBER_RES;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        // Smoothstep falloff: a hard-edged band looks painted on, and rubber
        // has no edge — it fades out where fewer cars have been.
        const t = 1 - Math.sqrt(d2) / r;
        const v = Math.round(t * t * (3 - 2 * t) * peak * 255);
        const o = row + x;
        if (v > RUBBER_DATA[o]) RUBBER_DATA[o] = v;
      }
    }
  };

  // One stamp per node, with sub-steps so the band is continuous even where the
  // node spacing exceeds the band radius.
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = px[i] + nx[i] * lineOffset[i];
    const az = pz[i] + nz[i] * lineOffset[i];
    const bx = px[j] + nx[j] * lineOffset[j];
    const bz = pz[j] + nz[j] * lineOffset[j];

    // The band's width comes from the track, not from here. `TrackSurface` in
    // the simulation decides whether a car is on the rubber using the same
    // rule, and if the two ever diverged the player would be aiming at a dark
    // stripe that is not where the grip is — a discrepancy invisible from
    // inside either file.
    const k = Math.abs(lineCurvature[i]);
    const tight = Math.min(1, k * 90);
    const halfW = track.rubberHalfWidthAt(i);
    // Heaviest where the cars are hardest on the tyres, which is the corners.
    const peak = 0.55 + 0.35 * tight;

    const segLen = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(segLen / Math.max(0.5, halfW * 0.6)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      stamp(ax + (bx - ax) * t, az + (bz - az) * t, halfW, peak);
    }
  }

  RUBBER_TEX.needsUpdate = true;
  rasterisePool(track, drainage);
}

/**
 * Rasterises the simulation's drainage field into the pooling map.
 *
 * Stamped across the FULL ROAD WIDTH rather than along the racing line, because
 * a puddle does not care where the cars go — that is the point of it. The
 * simulation's field is per node and the same one `TrackSurface` decides grip
 * with, so the water the player can see and the water the car is driving
 * through are the same water.
 *
 * With no field supplied the map is cleared and the shader falls back to a flat
 * wetness, which is what a probe with no race engine gets.
 */
function rasterisePool(track: TrackSpline, drainage?: Float32Array): void {
  POOL_DATA.fill(0);
  if (!drainage || drainage.length !== track.count || RUBBER_XF.z <= 0) {
    POOL_TEX.needsUpdate = true;
    return;
  }

  const originX = RUBBER_XF.x, originZ = RUBBER_XF.y, inv = RUBBER_XF.z;
  const { count, px, pz, nx, nz, width } = track;

  const stampPool = (wx: number, wz: number, radiusM: number, value: number): void => {
    const cx = (wx - originX) * inv * POOL_RES;
    const cy = (wz - originZ) * inv * POOL_RES;
    const r = radiusM * inv * POOL_RES;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(POOL_RES - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(POOL_RES - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        // Softened at the rim so pools do not have a stamped circular edge.
        const fall = 1 - Math.sqrt(d2 / r2);
        const v = Math.round(clamp01(value * (0.35 + 0.65 * fall)) * 255);
        const at = y * POOL_RES + x;
        if (v > POOL_DATA[at]) POOL_DATA[at] = v;
      }
    }
  };

  for (let i = 0; i < count; i++) {
    const d = drainage[i];
    if (d < 0.02) continue;
    // Out to the edge of the road and a little beyond: the water that runs off
    // the camber is lying against the kerb, which is where it is deepest.
    const half = width[i] * 0.5 + 1.5;
    // Three stamps across the width rather than one wide one, so the pool
    // follows the road rather than bulging into the run-off on a tight corner.
    for (let k = -1; k <= 1; k++) {
      const lat = (k * half) * 0.62;
      stampPool(px[i] + nx[i] * lat, pz[i] + nz[i] * lat, half * 0.55, d);
    }
  }

  POOL_TEX.needsUpdate = true;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A number as a GLSL float literal.
 *
 * Constants are baked into the source rather than passed as uniforms because
 * these terms are compiled in per profile anyway: a literal lets the driver
 * fold it, and it keeps the uniform block to the handful of things that are
 * genuinely shared.
 */
function f(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/**
 * Owns the shared textures, so every surface in the scene samples the same two
 * and the whole circuit still costs two texture units.
 */
export class SurfaceDetail {
  private readonly grain: THREE.DataTexture;
  private readonly normal: THREE.DataTexture;

  constructor() {
    const { grain, normal } = makeGrain(256);
    this.grain = grain;
    this.normal = normal;
  }

  /**
   * Attaches the detail projection to a standard material.
   *
   * Uses `onBeforeCompile` rather than a bespoke ShaderMaterial so the surface
   * keeps three.js's real lighting: shadows, the environment probe, fog and
   * tone mapping all still apply. Reimplementing those to get a texture on the
   * road would be a bad trade.
   */
  apply(material: THREE.MeshStandardMaterial, profile: SurfaceProfile): void {
    material.roughness = profile.roughness;
    material.metalness = profile.metalness;

    const aggregate = profile.aggregate ?? 0;
    const seams = profile.seams ?? 0;
    const patches = profile.patches ?? 0;
    const rubber = profile.rubber ?? 0;

    // Each road term is compiled in only where it is asked for. Grass, run-off
    // and walls keep the two-fetch program they had; only the asphalt pays for
    // aggregate, seams, patches and rubber, and it is the only surface anyone
    // ever looks at from two metres away.
    // Every threshold below is widened by its own screen-space derivative, and
    // that is the fix for the second-largest source of shimmer in the game.
    //
    // Measured with a third-of-a-pixel camera move: the asphalt within twenty
    // metres of the camera reads 0.4 display levels of change, which is
    // nothing, and the asphalt near the horizon reads 2.7, which is plainly
    // visible and is the whole of "the entire circuit seems very grainy" once
    // the catch fence is dealt with. It is not the texture fetches — those are
    // mip-mapped and filter correctly. It is these smoothsteps.
    //
    // A `smoothstep(0.615, 0.645, n)` is a decision three hundredths wide taken
    // on a value that, once minified, wanders by more than that from frame to
    // frame. It is the alpha-test problem in a different costume: the filtered
    // input converges toward its mean, the mean sits inside the ramp, and every
    // sub-pixel movement re-rolls which side of it each pixel lands on.
    //
    // `fwidth` is exactly how much the value moves across one pixel, so opening
    // the ramp by that much makes the decision no sharper than the sampling can
    // support. Near the camera the derivative is tiny and nothing changes; at
    // the horizon the ramp opens until the term is a constant, which is the
    // honest answer — a seam you cannot resolve is not a seam, it is part of
    // the average colour of the road.
    const aggCode = aggregate <= 0 ? '' : /* glsl */`
      float aggN = texture2D(uGrain, vDetailPos.xz * ${f(profile.aggregateScale ?? 5.5)} + vec2(0.31, 0.67)).r;
      // A gentler contrast stretch than 0.40..0.76. Narrowing the window is
      // what turns a smooth noise field into discrete speckle, and discrete
      // speckle a fraction of a pixel across is the definition of aliasing.
      float aggW = fwidth(aggN);
      agg = smoothstep(0.34 - aggW, 0.86 + aggW, aggN);
      dMix *= mix(1.0, 0.74 + agg * 0.46, ${f(aggregate)});
    `;
    // The half-value contour of the mid band, taken twice at different scales
    // and offsets: one set of long joints running the length of the surface and
    // one much finer set of cracks branching off them.
    const seamCode = seams <= 0 ? '' : /* glsl */`
      float seamN = texture2D(uGrain, vDetailPos.xz * ${f(profile.seamScale ?? 0.05)} + vec2(0.73, 0.19)).b;
      float seamJoint = 1.0 - smoothstep(0.0, 0.014 + fwidth(seamN) * 2.0, abs(seamN - 0.5));
      float crackN = texture2D(uGrain, vDetailPos.xz * ${f((profile.seamScale ?? 0.05) * 5.0)} + vec2(0.41, 0.62)).b;
      float crackLine = 1.0 - smoothstep(0.0, 0.02 + fwidth(crackN) * 2.0, abs(crackN - 0.5));
      dMix *= 1.0 - (seamJoint * 0.6 + crackLine * 0.4) * ${f(seams * 0.45)};
    `;
    const patchCode = patches <= 0 ? '' : /* glsl */`
      // The smooth band, so a repair comes out as one large region with a
      // definite boundary rather than as camouflage.
      float patchN = texture2D(uGrain, vDetailPos.xz * ${f(profile.patchScale ?? 0.022)} + vec2(0.11, 0.83)).g;
      float patchW = fwidth(patchN);
      sdPatch = smoothstep(0.615 - patchW, 0.645 + patchW, patchN);
      dMix *= 1.0 - sdPatch * ${f(patches * 0.15)};
    `;
    const rubberCode = rubber <= 0 ? '' : /* glsl */`
      rub = texture2D(uRubber, rUv).r * ${f(rubber)};
    `;

    /**
     * Water, in three terms.
     *
     * DEPTH is the mean water scaled by the pooling map, so the dips flood and
     * the crests stay merely damp. It is then taken back off wherever the
     * rubber band is, in proportion to how far the line has dried — which is
     * what draws the dry line, and draws it in the right place, because `rub`
     * is the same band the simulation decides grip with.
     *
     * COLOUR: wet asphalt is dramatically darker, not slightly. A water film
     * kills the diffuse bounce almost completely and what is left is specular.
     * 0.42 is about right for asphalt photographed wet against the same asphalt
     * dry, and it is most of what makes a rendered wet road read as wet.
     *
     * ROUGHNESS goes the other way and goes a long way: 0.06 is a smooth water
     * surface. This is where the reflections come from — the environment probe
     * is already wetness-aware and has a ground mirror term waiting for a
     * surface smooth enough to use it.
     */
    const wetCode = /* glsl */`
      float wetAmount = 0.0;
      if (uWet.x > 0.002 && uWetResponse > 0.0) {
        float pool = uRubberXf.z > 0.0 ? texture2D(uPool, rUv).r : 0.0;
        float depth = clamp(uWet.x * (0.72 + 0.85 * pool), 0.0, 1.0);
        depth *= 1.0 - rub * uWet.y * 0.9;
        wetAmount = depth * uWetResponse;
      }
    `;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGrain = { value: this.grain };
      shader.uniforms.uGrainNormal = { value: this.normal };
      shader.uniforms.uScale = { value: new THREE.Vector2(profile.scaleA, profile.scaleB) };
      shader.uniforms.uStrength = { value: new THREE.Vector2(profile.strengthA, profile.strengthB) };
      shader.uniforms.uNormalStrength = { value: profile.normalStrength };
      shader.uniforms.uRoughVar = { value: profile.roughnessVariation };
      // Shared by reference, so a track loaded later still reaches shaders that
      // have already been compiled.
      shader.uniforms.uRubber = { value: RUBBER_TEX };
      shader.uniforms.uRubberXf = { value: RUBBER_XF };
      shader.uniforms.uPool = { value: POOL_TEX };
      // Shared by reference, like the rubber map above and for the same reason:
      // a session that starts dry and rains on lap ten has to reach programs
      // that were compiled on lap one.
      shader.uniforms.uWet = { value: WET };
      shader.uniforms.uWetResponse = { value: profile.wetResponse ?? 1 };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying vec3 vDetailPos;
          uniform sampler2D uGrain;
          uniform sampler2D uGrainNormal;
          uniform vec2 uScale;
          uniform vec2 uStrength;
          uniform float uNormalStrength;
          uniform float uRoughVar;
          uniform sampler2D uRubber;
          uniform vec4 uRubberXf;
          uniform sampler2D uPool;
          uniform vec4 uWet;
          uniform float uWetResponse;
          float detailGrain(out float coarse) {
            float a = texture2D(uGrain, vDetailPos.xz * uScale.x).r;
            coarse = texture2D(uGrain, vDetailPos.xz * uScale.y).r;
            return a;
          }

          /**
           * How much of a detail band at \`cyclesPerMetre\` this pixel can
           * actually resolve, 1 down to 0.
           *
           * This is the term the whole grain problem turned on. A bump map is
           * a promise that the surface has features of a certain size; once
           * those features are smaller than the pixel that is sampling them,
           * the promise cannot be kept. Mip-mapping averages the NORMALS,
           * which is the wrong average — the correct one would widen the
           * specular lobe to cover the range of normals in the footprint — so
           * what actually happens is that each sub-pixel facet either mirrors
           * a floodlight or misses it, at random, every frame. That is the
           * sparkle.
           *
           * \`fwidth\` of the projected world position is the footprint in
           * metres. Multiplied by the band's frequency it gives cycles per
           * pixel, and past some fraction of a cycle per pixel the band is
           * fading out because nothing else can be done with it honestly.
           *
           * THAT FRACTION WAS WRONG UNTIL ISSUE #48, and it was wrong in the
           * unsafe direction. The ramp ran 0.25 to 0.85 cycles per pixel:
           * Nyquist is 0.5, so a band was drawn at FULL strength down to four
           * pixels per cycle and at half strength at 1.8 pixels per cycle,
           * which is past the point at which the pixel grid can represent it
           * at all. A specular normal needs far more headroom than an albedo
           * does, because the shading is a sharply non-linear function of the
           * normal and its output carries frequencies the input does not.
           * 0.08 to 0.25 is full strength only while a band spans twelve
           * pixels or more, and nothing at all by four.
           */
          float detailResolve(float cyclesPerMetre) {
            float footprintM = max(fwidth(vDetailPos.x), fwidth(vDetailPos.z));
            return 1.0 - smoothstep(0.08, 0.25, footprintM * cyclesPerMetre);
          }
        `)
        // After the base colour is established, darken it by the two octaves.
        // Multiplying keeps the vertex colour in charge of hue — the grain
        // only ever removes light, which is how real surface variation works.
        //
        // The road terms follow the same rule with one exception: rubber tints
        // as well as darkens, because laid-down rubber is not shadowed asphalt,
        // it is a different material sitting on top of it.
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          float dCoarse;
          float dFine = detailGrain(dCoarse);
          float dMix = mix(1.0, 0.45 + dFine, uStrength.x)
                     * mix(1.0, 0.55 + dCoarse * 0.9, uStrength.y);
          float agg = 0.0;
          float sdPatch = 0.0;
          float rub = 0.0;
          // The noise texture's finest octave has a four-pixel period in a
          // 256px map, so it carries 64 cycles per tile — hence the factor
          // below. Computed here rather than in the normal block because the
          // roughness stage runs first and has to know about it too.
          float resolveA = detailResolve(uScale.x * 64.0);
          // The NORMAL map's finest band is coarser than the colour map's, and
          // since issue #48 it is coarser by construction rather than by hope:
          // the derivative is taken over a low-passed copy of the field, so
          // nothing finer than NORMAL_CYCLES_PER_TILE survives to be drawn.
          // Two resolves rather than one because the two maps genuinely have
          // different band limits, and using the colour band's limit for the
          // bump is what left the mid-distance road with no relief at all.
          float resolveN = detailResolve(uScale.x * ${f(NORMAL_CYCLES_PER_TILE)});
          // The shared world-space map coordinate. Hoisted out of the rubber
          // block because the pooling map is sampled with it too, and because
          // a surface with no rubber can still be under water.
          vec2 rUv = uRubberXf.z > 0.0
            ? (vDetailPos.xz - uRubberXf.xy) * uRubberXf.zw
            : vec2(0.0);
          ${aggCode}
          ${seamCode}
          ${patchCode}
          ${rubberCode}
          ${wetCode}
          diffuseColor.rgb *= dMix;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.66, 0.655, 0.70), rub);
          // Water last, over the rubber tint, because the water is on top of
          // the rubber. Tinted very slightly toward blue as well as darkened:
          // a wet road picks up the sky, and a purely neutral darkening reads
          // as a shadow rather than as water.
          diffuseColor.rgb = mix(
            diffuseColor.rgb, diffuseColor.rgb * vec3(0.40, 0.42, 0.47), wetAmount);
        `)
        // Rougher where the grain is high. Gives the road patches of sheen that
        // slide across it as the car moves, which is most of what makes asphalt
        // look wet-ish and real rather than like grey felt.
        //
        // Rubber goes the other way. A rubbered-in line is polished by the
        // tyres that laid it, so it is smoother than the asphalt around it and
        // catches a low sun as a broad sheen. Fresh patch repairs are rougher.
        //
        // `sdPatch` rather than `patch`: `patch` is a reserved word in GLSL and
        // declaring it fails to compile with a message that does not mention
        // which of the injected snippets is at fault.
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          // The roughness swing is faded out with the bump it belongs to, and
          // the roughness itself is nudged UP by however much of the bump had
          // to be given away. That second term is the honest half of the
          // trade: the microfacets are still there on the real surface, they
          // are simply too small to draw, and a surface whose bumps have been
          // averaged away without a matching widening of the specular lobe
          // comes back as polished sheet rather than as distant asphalt.
          // The swing follows the COLOUR band it is computed from (resolveA);
          // the compensation follows the BUMP band it is compensating for
          // (resolveN), which since #48 fades out at a different range.
          roughnessFactor = clamp(
            roughnessFactor + (dFine - 0.5) * uRoughVar * resolveA
              + (1.0 - resolveN) * uRoughVar * 0.5
              - rub * 0.26 + sdPatch * 0.07,
            0.04, 1.0);
          // A film of water is a smooth dielectric sitting on top of whatever
          // the surface was, so it does not modulate the roughness, it
          // REPLACES it. 0.06 is a still water surface; the mix rather than a
          // subtraction is what stops a wet run-off area — which starts at
          // 0.92 — ending up rougher than wet asphalt, which would be exactly
          // backwards.
          roughnessFactor = mix(roughnessFactor, 0.06, wetAmount * 0.92);
        `)
        // Bump last, so it perturbs the normal three.js has already resolved.
        // The projection is planar in XZ, so the map's x and y drive world x
        // and z; on a near-vertical face that is meaningless, which is why
        // walls set the strength to zero.
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          if (uNormalStrength > 0.0) {
            vec3 bumpA = texture2D(uGrainNormal, vDetailPos.xz * uScale.x).xyz * 2.0 - 1.0;
            vec3 bump = vec3(bumpA.x, 0.0, bumpA.y) * uNormalStrength * resolveN;
            ${aggregate <= 0 ? '' : /* glsl */`
              // The stones themselves. A second, much finer bump is what makes
              // a close camera see a surface with a texture instead of a tinted
              // plane, and it is the difference between "grey road" and "road".
              vec3 bumpB = texture2D(uGrainNormal, vDetailPos.xz * ${f((profile.aggregateScale ?? 5.5))} + vec2(0.31, 0.67)).xyz * 2.0 - 1.0;
              // 0.30 of the aggregate strength, not 0.70, and faded on its own
              // footprint rather than the coarse band's — this is the finest
              // normal perturbation anywhere in the scene, applied at the
              // highest tiling frequency, so it is the first thing to drop
              // below a pixel and the single largest contributor to sparkle.
              float resolveB = detailResolve(${f((profile.aggregateScale ?? 5.5) * NORMAL_CYCLES_PER_TILE)});
              bump += vec3(bumpB.x, 0.0, bumpB.y) * ${f(aggregate * 0.3)} * resolveB;
            `}
            // Rubber fills the surface texture in. Where the band is heaviest
            // the road is visibly smoother, not just darker.
            // Water fills the surface in. Standing water is FLAT — that is what
            // makes a puddle a mirror rather than a wet patch — so the bump has
            // to go away as the depth comes up, or the reflection breaks into
            // the same speckle the dry road has and the whole effect reads as
            // a shiny road rather than a wet one.
            normal = normalize(normal + bump * (1.0 - rub * 0.65) * (1.0 - wetAmount * 0.85));
          }
        `);
    };

    // Materials that compile to different programs must not share a cache key,
    // or three.js hands the second one the first one's compiled shader and
    // every surface silently gets the asphalt profile.
    material.customProgramCacheKey = () =>
      `sd:${profile.scaleA}:${profile.scaleB}:${profile.strengthA}:${profile.strengthB}` +
      `:${profile.normalStrength}:${profile.roughnessVariation}` +
      `:${aggregate}:${profile.aggregateScale ?? 0}:${seams}:${profile.seamScale ?? 0}` +
      `:${patches}:${profile.patchScale ?? 0}:${rubber}`;
    material.needsUpdate = true;
  }

  dispose(): void {
    this.grain.dispose();
    this.normal.dispose();
  }
}
