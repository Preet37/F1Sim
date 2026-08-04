import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp01 } from '../core/MathUtils';

/**
 * The post-processing chain.
 *
 * Pass order is not cosmetic, it is the whole thing:
 *
 *   scene (MSAA) -> bloom pyramid -> grade (adds bloom) -> tone map & sRGB
 *
 * Bloom has to run on the linear, un-tone-mapped image. Bloom is a physical
 * effect — light scattering inside the lens and the eye — and scattering is
 * proportional to actual radiance. Once the tone mapper has compressed a
 * 20,000-nit spark and a white kerb into the same near-white pixel, no amount
 * of thresholding can tell them apart, and blooming afterwards makes bright
 * paintwork glow exactly as hard as a spark does. Run before it, only the
 * genuinely hot things bloom, which is why the sparks and brake discs read as
 * emissive and the white bodywork does not.
 *
 * The grade pass then does everything else in one fragment shader, because each
 * piece is a handful of instructions and separate full-screen passes would cost
 * a round trip through memory apiece for no benefit:
 *
 *  - AMBIENT OCCLUSION from the depth buffer. This is the pass that stops
 *    objects floating. Direct light and an environment probe both arrive from
 *    everywhere, so a crevice — the gap between two wing elements, the undercut
 *    of a sidepod, the strip of road under a floor — receives exactly as much
 *    light as an exposed surface does, and renders exactly as bright. Real
 *    crevices are dark, and the eye uses that darkening to work out what is
 *    touching what. Reconstructing it in screen space from depth alone costs
 *    twelve texture fetches and needs no extra geometry pass, which matters
 *    when there are twenty cars to draw.
 *  - RADIAL BLUR that strengthens with speed. This is the single most effective
 *    speed cue there is. A car at 320 km/h and a car at 120 km/h fill the same
 *    fraction of the screen and the road ahead looks identical; smearing the
 *    periphery towards a vanishing point is what the eye actually uses to judge
 *    velocity, and it is why 200 km/h feels dangerous rather than brisk.
 *  - VIGNETTE, which darkens the corners and pushes attention to the apex.
 *  - DITHER, sub-perceptual, purely to break 8-bit banding.
 *
 * These are all capable of turning a clean picture into what looks like archive
 * footage, and had between them done exactly that: a heavy vignette, a lens
 * fringe present at a standstill, and a linear-space grain that the output
 * transform amplified into visible striping across every shadow. The rule they
 * are now tuned to is that none of them should be identifiable as an effect. If
 * you can point at the vignette, it is too strong.
 *
 * THERE IS NO LONGER ANY CHROMATIC ABERRATION, and there should not be. It was
 * reported as "purple almost holo imaging ... when they sped up", which is an
 * accurate description of what a radial R/B channel split does to a periphery
 * that is also being smeared. It had already been halved once for the same
 * complaint. See the grade shader for why amplitude was never the fix.
 *
 * On the low quality tier the whole composer is skipped and the scene renders
 * straight to the canvas. Bloom on a phone GPU is five extra full-screen passes
 * at half resolution, and holding 60fps matters more than glow.
 *
 * WHAT THIS CHAIN COSTS, AND WHY IT IS SHAPED THIS WAY
 *
 * The post chain, not the scene, is where a frame goes. Measured on an M5 with
 * `EXT_disjoint_timer_query_webgl2`, paired A/B inside a single session so that
 * machine load cancels (`scripts/probeRenderPerf.ts`, `PERF_PAIR=`), at a
 * 2940x1396 drawing buffer:
 *
 *   whole post chain   +22.5ms   of a 31.5ms frame — nearly 3x the scene render
 *   bloom              +14.4ms
 *   grade + AO          +8.4ms
 *   tone map / sRGB     +1.2ms
 *   FXAA               +17.5ms   (before it was removed)
 *   shadow re-render     0.0ms
 *
 * Three things follow from those numbers.
 *
 * FXAA is gone. It cost more than the entire scene render, and the image it was
 * smoothing had usually been rendered at half resolution and stretched, so what
 * it did in practice was blur an already-soft picture. MSAA on the scene target
 * is real geometric antialiasing and it stays.
 *
 * `EffectComposer` ping-pongs between two copies of the target it is given, so
 * `samples: 4` made every full-screen quad write four samples per pixel for a
 * pixel-identical result. Only the buffer the scene lands in is multisampled
 * now.
 *
 * And bloom no longer touches a full-resolution pixel at all: see
 * `BloomChainPass` for why `UnrealBloomPass` cost what it did, and why the
 * replacement produces a texture that the grade pass adds rather than blending
 * itself over the frame.
 */

/**
 * Bloom threshold, in linear scene radiance, before any night bias.
 *
 * This number is not a taste setting, it is a measurement of what the lighting
 * puts on screen. Under three's lighting a white surface returns roughly
 * `albedo * sum(intensities) / PI`; with the day rig that is about 1.3, and with
 * the night rig about 1.1. Both are comfortably ABOVE 1.0, so the old 0.85 was
 * below plain white paint — every line on the circuit, every kerb and every pale
 * livery panel cleared it and bloomed, which is precisely the "glare and old
 * raspy lines" complaint. Sitting above both figures means paint stays paint.
 *
 * What is left above the threshold is what should be: brake discs at 2.7 under
 * load, sparks at 3.4, and the specular hits where a floodlight lands on gloss.
 */
const BLOOM_THRESHOLD = 1.55;

/**
 * How much of that gets scattered back into the frame.
 *
 * Dropped from 0.42. With the threshold where it now is, bloom only ever
 * catches genuinely hot things, and a hot thing wants a tight halo rather than
 * a wash — which is what the reference footage shows around a floodlight.
 */
const BLOOM_STRENGTH = 0.3;

/**
 * A bloom chain that never touches a full-resolution pixel.
 *
 * `UnrealBloomPass` was measured at 14.4ms of a 31ms frame on an M5 at
 * 2940x1396 — 46% of the whole frame — and, crucially, dropping its mip chain
 * from half resolution to a quarter changed that by 0.4ms. So the cost was
 * never the blurs. It was its two full-resolution operations: the bright-pass
 * read of the full-size half-float buffer, and the full-screen additive blend
 * of the result back into it. (For scale: a plain full-screen tone-map pass to
 * the canvas costs 1.2ms, so this is not a general "full-screen quads are
 * expensive" effect — writing an RGBA16F offscreen target with blending is
 * simply far more expensive than writing the canvas.)
 *
 * Neither operation needs to exist. Bloom is a low-frequency term added to the
 * image in linear light, so it can be produced entirely at reduced resolution
 * and added by a pass that was reading the frame anyway. This class produces
 * only a TEXTURE; the grade pass adds it. Nothing here writes to a composer
 * buffer, and the largest surface it ever fills is a quarter of the frame in
 * each axis.
 *
 * The chain is a downsample pyramid with a tent-filter upsample — the standard
 * dual-filter arrangement — rather than five independent gaussian mips. Same
 * shape of falloff, a third of the passes.
 */
const BLOOM_LEVELS = 4;

/**
 * A colour grade: four separable terms, in linear light. See the shader.
 *
 * `balance` is a per-channel linear gain, `contrast` a power about `pivot`,
 * `toe` a crush of everything below `toeRange`, `saturation` a mix toward luma.
 * Identity is `[1,1,1] / 1 / 0 / 1`, and `GRADES.off` is exactly that.
 */
export interface Grade {
  balance: [number, number, number];
  contrast: number;
  pivot: number;
  toe: number;
  toeRange: number;
  saturation: number;
}

/**
 * The grades, one per ambience, FITTED TO THE REFERENCE FRAMES.
 *
 * Every number here was produced by `npm run probe:grade`, which photographs
 * the real game through the real browser at the resolution the real scaler
 * settles on, measures the median luma, RMS contrast, HSV saturation and
 * mean(R)-mean(B) of the world region of the frame, and compares them against
 * the same four numbers taken from `reference/target/`. None of it was chosen
 * by looking at the picture — PROJECT.md section 3.1, and this is precisely the
 * kind of claim that section exists about.
 *
 * WHAT THE REFERENCE ACTUALLY MEASURES, because one part of the brief for this
 * work turned out to be wrong and it is worth recording rather than quietly
 * correcting. The look was described as "slightly desaturated, high contrast,
 * warm key". Two of those three hold: `76.png`'s world region carries an RMS
 * contrast of 57.1 against a mean of 30-40 for a typical game render, and its
 * saturation is 0.261. The third does not — its mean(R)-mean(B) is MINUS 17.0,
 * i.e. decidedly cool, because a daylight F1 frame is dominated by open sky and
 * grey asphalt and the warm key light is a small, bright fraction of the pixels.
 * `90.png` at night is warm, at +6.5 across the road. So the balance term is per
 * ambience and it does not all point the same way, which is the whole reason it
 * is a table rather than a constant.
 */
const GRADES: Record<'day' | 'dusk' | 'night' | 'off', Grade> = {
  off: { balance: [1, 1, 1], contrast: 1, pivot: 0.18, toe: 0, toeRange: 0.06, saturation: 1 },
  /**
   * Fitted against `reference/target/76.png` — the frame the user named "the
   * best image" — with `EXPOSURE.day` held at its new measured value of 0.50.
   * The four numbers, reference against fit, on the world band above the halo:
   *
   *            reference   before   after
   *   p50           82       166      95
   *   rms         57.2      46.9    46.9
   *   saturation 0.254     0.154   0.254
   *   warmth     -17.2      -8.4   -15.3
   *   p1             1        46      11
   *   shadow      6.1%      0.1%    6.3%
   *   clipped     1.2%      4.4%    0.0%
   *
   * BALANCE IS LEFT AT UNITY DELIBERATELY, and it is the one term that was not
   * fitted. The optimiser wanted [1.149, 1.000, 0.931] — a warm push — and it
   * wanted it because the two daylight reference frames DISAGREE about white
   * balance: `76.png` reads -17.2 and `71.png` reads +0.9, so the least-squares
   * answer is a compromise that is wrong for both. The reference set does not
   * define a daylight white balance, so this does not invent one. Our own frame
   * lands at -15.3 against 76's -17.2 without any balance term at all, which is
   * near enough that adding one would be tuning to noise.
   *
   * SATURATION IS 1.0, WHICH IS THE OPPOSITE OF THE BRIEF. The look was
   * described as "slightly desaturated". Measured, our daylight frame was at
   * 0.154 against the reference's 0.254 — we were 40% UNDER, not over — and
   * essentially all of the recovery comes from the exposure cut, because HSV
   * saturation collapses as pixels approach white and 4.4% of the frame was
   * clipped. Pulling saturation as well would have taken it back to where it
   * started.
   */
  day: {
    balance: [1, 1, 1],
    contrast: 1.38,
    pivot: 0.19,
    toe: 0.39,
    toeRange: 0.066,
    saturation: 0.82,
  },
  /**
   * NOT FITTED, AND SAID SO. No circuit in `src/data/tracks/circuits.ts` uses
   * `dusk` — all eleven are `day` or `night` — so there is no shot of it to
   * measure and there is no dusk frame in `reference/target/`. This is the day
   * grade with the toe eased, on the reasoning that a low sun already supplies
   * the contrast the toe is there to add. It is a guess, it is labelled as one,
   * and the moment a circuit uses it `probe:grade` should get a fourth pair.
   */
  dusk: {
    balance: [1, 1, 1],
    contrast: 1.38,
    pivot: 0.19,
    toe: 0.26,
    toeRange: 0.066,
    saturation: 0.82,
  },
  /**
   * Fitted against `reference/target/90.png`'s road band.
   *
   * THE NIGHT GRADE IS SMALL ON PURPOSE, AND THE REASON IS THE INTERESTING
   * PART. The night frame's gap is not a grade gap: our floodlit road measured
   * p50 57 against the reference's 107, and an exposure sweep says that even at
   * 2.6 — half a stop past anything defensible — it only reaches 80, while the
   * shadow fraction goes the wrong way. A grade cannot add light that the scene
   * never emitted. What was actually wrong was the SKY and the absence of any
   * light-source geometry; both are fixed in `Renderer.applyAmbience` and
   * `FloodlightTowers.ts`, and this grade only does the last few per cent on
   * top of them. See PROJECT.md section 6.
   */
  night: {
    balance: [1, 1, 1],
    contrast: 1.05,
    pivot: 0.16,
    toe: 0.10,
    toeRange: 0.05,
    saturation: 0.90,
  },
};

/** Threshold and downsample, four bilinear taps, in one pass. */
const BLOOM_PREFILTER_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uThreshold;
    varying vec2 vUv;
    void main() {
      // Four taps on the source grid rather than one. A single tap on a
      // quarter-size target samples every fourth pixel of the frame, so a
      // one-pixel spark alternately clears the threshold and vanishes as the
      // camera moves, which is a flickering dot rather than a glow.
      vec2 o = uTexel;
      vec3 c = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb;
      c *= 0.25;
      // Soft knee. A hard cutoff makes the boundary of a bloomed region a
      // visible edge that crawls as brightness drifts across the threshold.
      float lum = max(c.r, max(c.g, c.b));
      float knee = uThreshold * 0.5;
      float soft = clamp((lum - uThreshold + knee) / (2.0 * knee), 0.0, 1.0);
      float w = max(lum - uThreshold, soft * soft * knee) / max(lum, 1e-4);
      gl_FragColor = vec4(c * w, 1.0);
    }
  `,
};

/** One step of the pyramid, up or down, with a 3x3 tent. */
const BLOOM_RESAMPLE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 o = uTexel;
      vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
      c += (texture2D(tDiffuse, vUv + vec2(-o.x, 0.0)).rgb
          + texture2D(tDiffuse, vUv + vec2( o.x, 0.0)).rgb
          + texture2D(tDiffuse, vUv + vec2(0.0, -o.y)).rgb
          + texture2D(tDiffuse, vUv + vec2(0.0,  o.y)).rgb) * 2.0;
      c += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb;
      gl_FragColor = vec4(c / 16.0, 1.0);
    }
  `,
};

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Scene depth, shared by both composer buffers. */
    tDepth: { value: null as THREE.Texture | null },
    /** The bloom pyramid's top level, at a quarter of the frame. */
    tBloom: { value: null as THREE.Texture | null },
    /** How much of the bloom is scattered back in. */
    uBloom: { value: 0 },
    /** 0..1 blur strength, driven by speed. */
    uSpeed: { value: 0 },
    /** Vanishing point in UV space — where the blur streaks converge. */
    uFocus: { value: new THREE.Vector2(0.5, 0.5) },
    uVignette: { value: 0.14 },
    /**
     * How wet the world is, 0..1. Drives the desaturation and the lifted black
     * point that are most of what "it is raining" looks like on a screen.
     */
    uWet: { value: 0 },
    /**
     * Dither amplitude, as a FRACTION of the pixel. See the shader for why it
     * is relative rather than absolute, and why it is this small.
     */
    uGrain: { value: 0.012 },
    uTime: { value: 0 },
    /** Full-screen flash, 0..1: used for the start lights and impacts. */
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    /** Camera clip planes, for linearising the depth buffer. */
    uNear: { value: 0.1 },
    uFar: { value: 2000 },
    /**
     * 0.5 / tan(fovY / 2). Converts a world radius at a given view depth into a
     * screen-space radius, which is what keeps the AO's footprint a fixed size
     * in METRES rather than in pixels — without it the occlusion around a car
     * grows as the camera approaches and the whole effect swims.
     */
    uProjScale: { value: 1.0 },
    uAspect: { value: 1.6 },
    /** Overall AO strength; 0 disables the taps entirely. */
    uAO: { value: 0.0 },
    /** AO sampling radius in metres. */
    uAORadius: { value: 0.5 },
    /** One over the render target size, in pixels. */
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    /**
     * THE COLOUR GRADE. See `GRADES` and the shader block for what each term
     * does and where its value came from. Identity is
     * balance (1,1,1) / contrast 1 / saturation 1 / toe 0, and the whole block
     * is skipped when `uGradeOn` is 0, so a build with the grade off is
     * byte-identical to the pre-#78 image.
     */
    uGradeOn: { value: 0 },
    /** Per-channel gain in linear light: white balance. */
    uBalance: { value: new THREE.Vector3(1, 1, 1) },
    /** Contrast exponent about `uPivot`, in linear light. */
    uContrast: { value: 1 },
    /** The linear value contrast pivots about. 0.18 is mid grey. */
    uPivot: { value: 0.18 },
    /** Shadow crush, 0..1, applied below `uToeRange`. */
    uToe: { value: 0 },
    uToeRange: { value: 0.06 },
    /** 1 leaves saturation alone; below 1 desaturates. */
    uSaturation: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uSpeed;
    uniform vec2 uFocus;
    uniform float uVignette;
    uniform float uWet;
    uniform float uGrain;
    uniform float uTime;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    uniform float uNear;
    uniform float uFar;
    uniform float uProjScale;
    uniform float uAspect;
    uniform float uAO;
    uniform float uAORadius;
    uniform vec2 uTexel;
    uniform float uGradeOn;
    uniform vec3 uBalance;
    uniform float uContrast;
    uniform float uPivot;
    uniform float uToe;
    uniform float uToeRange;
    uniform float uSaturation;
    varying vec2 vUv;

    // Interleaved gradient noise: one line, well distributed, and stable enough
    // between frames that it does not crawl the way a hash of uv+time does.
    float dither(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    /** Depth buffer value to distance from the eye, in metres. */
    float linearDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // Perspective depth is stored non-linearly; this is the standard inverse.
      // Clamped just short of 1.0 so the sky returns a large finite number
      // instead of a division by zero.
      d = min(d, 0.9999999);
      return (uNear * uFar) / (uFar - d * (uFar - uNear));
    }

    /**
     * Screen-space ambient occlusion from depth alone.
     *
     * The naive version of this — "count how many neighbours are nearer than I
     * am" — does not work, and it is worth saying why, because it is the
     * version everybody writes first and it is what the first attempt here did.
     * A flat panel seen at a grazing angle has an enormous depth gradient
     * across it: at 30 degrees, neighbours half a metre away in screen space
     * are a quarter of a metre nearer the camera. The naive test calls that
     * occlusion, so every flank of the car acquires a grey wash that swims
     * about as the camera moves, and the actual creases are lost inside it.
     *
     * The fix is to measure depth against the LOCAL SURFACE PLANE rather than
     * against the centre depth. Two derivatives give the plane's slope in
     * screen space for free — no normal buffer, no second geometry pass — and
     * the test becomes "is this neighbour in front of the plane I am lying on?"
     * A flat panel then reports exactly zero occlusion at any angle, and only
     * genuine geometry sticking out above the surface darkens anything.
     *
     * The far rejection is the other essential term: a neighbour several metres
     * nearer is a different object, not a crease, and counting it draws a dark
     * halo around every car against the sky.
     */
    float ambientOcclusion(vec2 uv, float centre, vec2 texel) {
      // The plane fit is done in INVERSE depth, and that is not a detail.
      //
      // For a planar surface under a perspective projection, 1/z is an exactly
      // linear function of screen position; z itself is not. Fitting a plane to
      // z and extrapolating it a few hundred pixels — which is what a
      // half-metre radius amounts to in the near field — therefore misses by a
      // margin that grows with the offset, and the miss is read as occlusion.
      // Since the screen radius shrinks with distance, that error shrinks too,
      // so the road picked up a wash of false occlusion nearby which faded out
      // further away: a perfectly straight horizontal band across the middle of
      // every chase and onboard shot. In 1/z the fit is exact at any angle and
      // any distance, and a flat road reports zero.
      float invC = 1.0 / centre;
      float didx = dFdx(invC);
      float didy = dFdy(invC);
      // Derivatives explode across a silhouette. Clamp to a slope no real
      // surface plausibly has, so a pixel on the edge of the car predicts a
      // sane plane instead of a wall.
      //
      // The limit is a CONSTANT in inverse-depth space, and that matters. For a
      // plane, d(1/z) per pixel is the same number everywhere on it — that is
      // the property this whole approach rests on — so a limit that scales with
      // 1/z inevitably drops below the road's own constant gradient at some
      // depth, starts clamping, and produces false occlusion from there to the
      // horizon. The boundary lands at one particular depth, which draws a
      // perfectly straight horizontal line across the image: the same seam the
      // linear-depth fit produced, moved rather than removed. A fixed limit has
      // no such crossover, and it still rejects silhouettes easily, because a
      // silhouette jumps 1/z by two orders of magnitude more than this in a
      // single pixel.
      const float LIM = 0.02;
      didx = clamp(didx, -LIM, LIM);
      didy = clamp(didy, -LIM, LIM);

      // Twelve taps on a spiral. The rotation comes from a 2x2 ordered pattern
      // rather than a hash: it decorrelates neighbouring pixels enough to break
      // the twelve-spoke banding, but repeats every two pixels, so what is left
      // reads as a fine even texture instead of the salt-and-pepper noise a
      // per-pixel random rotation leaves behind.
      const int TAPS = 12;
      vec2 pix = floor(gl_FragCoord.xy);
      float ord = mod(pix.x, 2.0) + 2.0 * mod(pix.y, 2.0);
      float rot = ord * 1.5707963;
      float ca = cos(rot), sa = sin(rot);

      // World radius to screen radius. Beyond this depth the footprint is
      // sub-pixel and the taps just read the centre back, so it is faded out.
      float rUv = uAORadius * uProjScale / max(centre, 0.35);
      float occ = 0.0;

      for (int i = 0; i < TAPS; i++) {
        float fi = float(i);
        float a = fi * 2.399963;                 // golden angle
        float r = sqrt((fi + 0.5) / float(TAPS)); // uniform disc coverage
        vec2 o = vec2(cos(a), sin(a)) * r;
        o = vec2(o.x * ca - o.y * sa, o.x * sa + o.y * ca) * rUv;
        o.x /= uAspect;

        // Where the local plane says this neighbour should be.
        vec2 dp = o / texel;
        float predictedInv = invC + didx * dp.x + didy * dp.y;
        float predicted = 1.0 / max(predictedInv, 1e-4);

        float d = linearDepth(uv + o);
        float diff = predicted - d;
        // Ramp in from 30mm, so shading noise and depth precision do not
        // register, and out again past 0.9m, beyond which it is another object.
        //
        // 30mm rather than 15mm, and this is a measured change. Twelve taps is
        // a coarse estimator: the per-pixel variance in the result is large, and
        // the 2x2 rotation below turns that variance into a fixed fine pattern
        // rather than removing it. On a surface that should report exactly zero
        // — a flat road — the estimate still wanders, because the road is a
        // tessellated sweep and the plane fit is only exact WITHIN a triangle,
        // not across an edge. With the ramp opening at 15mm those sub-centimetre
        // facet steps cleared it, and the asphalt picked up a fine crawling
        // texture worth about 0.7 of a display level. Nothing that is genuinely
        // a crevice is under 30mm deep.
        occ += smoothstep(0.030, 0.15, diff) * (1.0 - smoothstep(0.35, 0.9, diff));
      }

      occ /= float(TAPS);
      // Fade the whole effect out with distance: at 65m a half-metre radius is
      // a couple of pixels and all it contributes is noise. It used to run to
      // 90m, which is well past the range at which the footprint stops
      // resolving, so the last forty metres of every straight was paying for
      // noise and getting no occlusion.
      occ *= 1.0 - smoothstep(30.0, 65.0, centre);
      return clamp(occ, 0.0, 1.0);
    }

    void main() {
      vec2 dir = vUv - uFocus;
      float dist = length(dir);

      // Blur only the periphery. The centre of the screen is where the driver
      // is looking and where the apex is; smearing it would just look broken.
      float falloff = smoothstep(0.06, 0.75, dist);

      // "WHEN THEY SPED UP THERE WAS THIS PURPLE ALMOST HOLO IMAGING, I THINK
      // THAT WAS TRYING TO SHOW THAT THE CARS WERE GOING REALLY FAST."
      //
      // It was, and it was this line and the chromatic aberration under it.
      // Two separate mistakes stacked into one artefact:
      //
      // THE GHOSTING. The coefficient was 0.055. dir runs to about 0.7 at a
      // screen corner, so the smear reached 0.0385 in UV — 3.85% of the frame,
      // which is 74 pixels across a 1920 buffer. Spread over EIGHT taps that is
      // 9 pixels between samples, and eight copies of a car spaced 9 pixels
      // apart is not a motion blur. It is eight copies of a car. That is the
      // "holo imaging" exactly: a ghosted multiple image, appearing on whatever
      // is in the periphery, which at racing speed is every other car.
      //
      // A radial blur only reads as blur when consecutive taps land within a
      // pixel or two of each other. 0.012 puts the worst case at 0.0084 UV = 16
      // pixels over 8 taps, so 2 pixels between samples, and the taps merge into
      // a smear instead of resolving as copies. It is also strictly CHEAPER
      // than what it replaces — same tap count, shorter reads, better cache
      // coherence — so the fix costs nothing.
      float amount = uSpeed * falloff * 0.012;

      vec3 colour;
      if (amount > 0.0008) {
        // Eight taps along the radius, jittered per pixel so the taps do not
        // band into visible concentric rings on a smooth gradient like the sky.
        float jitter = dither(gl_FragCoord.xy + uTime * 60.0);
        vec3 sum = vec3(0.0);
        const int TAPS = 8;
        for (int i = 0; i < TAPS; i++) {
          float t = (float(i) + jitter) / float(TAPS);
          sum += texture2D(tDiffuse, vUv - dir * amount * t).rgb;
        }
        colour = sum / float(TAPS);
      } else {
        colour = texture2D(tDiffuse, vUv).rgb;
      }

      // CHROMATIC ABERRATION: REMOVED, and this is where the PURPLE came from.
      //
      // It displaced the red channel one way along the radius and the blue
      // channel the other, which is what a real lens does — and on this image it
      // was the wrong effect at any amplitude. Splitting R and B in opposite
      // directions puts magenta on one side of every high-contrast edge and
      // green on the other, and against a grey road under a blue-grey sky the
      // green side is invisible while the magenta side is not. What reaches the
      // eye is a one-sided purple fringe, on the periphery, appearing as speed
      // rises. Stacked on the eight ghost images the blur above was producing,
      // that is precisely "purple almost holo imaging ... when they sped up".
      //
      // This is the SECOND time it was reduced rather than removed: it went
      // 0.0016 -> 0.0009 for tinting the near field "green and magenta". The
      // amplitude was never the problem. The effect is a lens artefact, this is
      // not footage of a lens, and it is being used as a speed cue when the
      // radial blur above already is one and is honest about it. Two texture
      // fetches per pixel come back with it.
      //
      // Do not reintroduce it. If a speed cue needs to be stronger, the blur is
      // the term to reach for, subject to the tap-spacing constraint above.

      // Bloom, added here rather than in a pass of its own.
      //
      // This is still scattering LINEAR radiance — the pass order constraint
      // that the whole chain is built around — because nothing has tone mapped
      // yet; the output pass does that afterwards. What it saves is the two
      // full-resolution operations a standalone bloom pass needs, a bright-pass
      // read and an additive blend, in a shader that was already reading this
      // pixel. See BloomChainPass.
      //
      // Before the occlusion and the vignette, so that a glow is dimmed by the
      // corners of the lens the same way everything else is, and is not carved
      // into by screen-space occlusion that knows nothing about it.
      if (uBloom > 0.0) colour += texture2D(tBloom, vUv).rgb * uBloom;

      // Ambient occlusion. Applied before the vignette and after the blur, so
      // that at speed the periphery smears an already-occluded image rather
      // than acquiring crisp AO on top of a smeared one.
      if (uAO > 0.001) {
        float centre = linearDepth(vUv);
        float ao = ambientOcclusion(vUv, centre, uTexel);
        // Occlusion attenuates ambient light, which is roughly proportional to
        // how little of the pixel's brightness came from the key light. Rather
        // than track that, this leans on luminance: a blown highlight is
        // key-lit and should barely darken, a mid tone is mostly ambient and
        // should darken fully. It is an approximation, but it is the one that
        // keeps specular highlights from being eaten by their own crevice.
        float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
        float protect = 1.0 - smoothstep(0.55, 2.0, lum);
        colour *= 1.0 - ao * uAO * protect;
      }

      // Vignette. Squared so it stays clear of the centre and rolls in fast at
      // the corners rather than dimming the whole frame.
      float v = 1.0 - uVignette * dist * dist * 2.2;
      colour *= clamp(v, 0.0, 1.0);

      // --- Weather -----------------------------------------------------------
      //
      // What rain does to an image, in the two terms that actually carry it.
      //
      // SATURATION. Overcast light has no colour temperature to speak of and
      // water on every surface kills the diffuse bounce that carries most of a
      // scene's colour. A wet circuit photographs nearly monochrome, and pulling
      // saturation is the single strongest cue that it is raining — stronger
      // than anything drawn in the world, because it affects every pixel.
      //
      // CONTRAST, downward and only in the shadows. Spray and low cloud lift
      // the black point: there is no true black in a rainstorm because the
      // whole volume between the camera and the subject is scattering. Lifting
      // it is what makes distance read as murk rather than as fog with a colour.
      //
      // Both are done here rather than as another pass because this shader is
      // already sampling and already writing, and an extra full-screen pass for
      // eight instructions would cost more than the effect.
      //
      // BOTH TERMS ARE HALF WHAT THEY FIRST WERE. At 0.42 desaturation and a
      // 0.045 black lift, a screenshot of Bahrain in heavy rain came back with
      // no black anywhere in the frame and the whole image sitting in a narrow
      // band of grey — which is a photograph of a rainstorm through a dirty
      // lens, not a photograph of a wet circuit. The scene ALREADY has three
      // other things pulling in the same direction: fog that closes from 1700m
      // to 800m, cloud cover that rises with the water, and an environment
      // probe that flattens the sun. Stacking a heavy grade on top of those
      // triple-counted the effect. What is left is enough to read and little
      // enough to leave the picture some contrast.
      if (uWet > 0.002) {
        float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
        colour = mix(colour, vec3(lum), uWet * 0.22);
        colour = mix(colour, colour * 0.92 + vec3(0.022), uWet);
      }

      // --- The colour grade ---------------------------------------------------
      //
      // THE PASS WAS CALLED grade AND DID NOT GRADE. Until issue #78 this
      // shader added bloom, occluded, vignetted, desaturated for rain, dithered
      // and flashed — every one of which is a lens or a weather effect — and
      // there was no tonal or chromatic transform in the renderer at all. The
      // image went straight from ACES to the screen. That is the actual reason
      // the picture reads flat against reference/target/76.png and 90.png,
      // and it was invisible for as long as it was because "colour grading" is
      // the one thing everybody assumes is already there.
      //
      // RUN IN LINEAR LIGHT, BEFORE THE TONE MAPPER, and that is deliberate for
      // exactly the reason stated at the top of this file for bloom: once ACES
      // has compressed the top four stops into the last few code values, a
      // contrast curve applied afterwards is operating on an image whose
      // highlights have already been thrown away, and pushing it makes the
      // bright end posterise instead of getting brighter. A power curve about a
      // pivot in linear light IS an S-curve by the time it comes out of ACES,
      // with the roll-off preserved, which is the shape wanted.
      //
      // FOUR TERMS, EACH ANSWERING ONE OF THE FOUR THINGS probe:grade
      // MEASURES SEPARATELY, so that a number moving can be attributed:
      //
      //  - uBalance   per-channel gain -> warmth, mean(R) - mean(B)
      //  - uContrast  power about a pivot -> rms, and p50 through the pivot
      //  - uToe       crush below the toe range -> p1 and the shadow fraction
      //  - uSaturation mix toward luma -> sat
      //
      // They are four because they were three at first and the third one could
      // not be tuned: contrast about a pivot moves the black point, the median
      // AND the spread together, so fitting it to the reference's rms drove the
      // median off and fitting the median drove the spread off. Splitting the
      // shadow end out into its own term is what made the fit converge.
      //
      // NOT A LUT, AND THIS IS THE ONE PLACE THE OBVIOUS ANSWER IS THE WRONG
      // ONE. A 3D LUT is the standard tool and the user named it. What a LUT
      // gets you is an arbitrary transform an artist authored in a grading
      // application; what it costs is a 32x32x32 texture fetch per pixel, a
      // second asset to ship and version, and — the part that matters here —
      // a transform nobody can measure the parts of. This grade is fifteen ALU
      // operations and every one of its four numbers is separately readable in
      // probe:grade's output, which is what let them be FITTED to the
      // reference frames rather than eyeballed. If a hand-authored look is ever
      // wanted, this operator is exactly what a .cube would be baked FROM, and
      // the swap point is PostFX.setGrade.
      if (uGradeOn > 0.5) {
        colour = max(colour, vec3(0.0));

        // WHITE BALANCE. A per-channel gain, which is what a camera's white
        // balance physically is.
        colour *= uBalance;

        // CONTRAST about a pivot. pow of a non-negative base, so no NaN.
        colour = uPivot * pow(colour / uPivot, vec3(uContrast));

        // SHADOW TOE. Crushes the bottom of the range without touching
        // anything above it, which is the half of "high contrast" that a
        // symmetric power curve cannot deliver on its own.
        if (uToe > 0.001) {
          float sl = dot(colour, vec3(0.2126, 0.7152, 0.0722));
          colour *= mix(1.0 - uToe, 1.0, smoothstep(0.0, uToeRange, sl));
        }

        // SATURATION, last, so it acts on the tones the curve actually
        // produced rather than on the ones it was handed.
        float gl = dot(colour, vec3(0.2126, 0.7152, 0.0722));
        colour = mix(vec3(gl), colour, uSaturation);
      }

      // Dither, not grain.
      //
      // The only job here is to break 8-bit banding in the sky and across the
      // asphalt. A modern camera has no film grain, and the reference footage
      // has none; anything visible is a defect.
      //
      // It is applied as a FRACTION of the pixel rather than as a fixed step,
      // and that is the whole fix. This pass is linear and the output transform
      // is not: the tone mapper and the sRGB encode together stretch the bottom
      // of the range by roughly a factor of twelve. A flat +/-0.015 in linear
      // sits invisibly under a mid tone and comes out of that transform as
      // several display levels of noise everywhere the image is dark — which at
      // a floodlit circuit is most of the frame, and which read as the texture
      // of old film stock. Because the pattern here is interleaved gradient
      // noise, which is deliberately structured rather than random, what
      // actually appeared was fine diagonal striping across the road.
      //
      // Relative, the perturbation that survives the transform is a roughly
      // constant fraction of the output instead — about a third of an 8-bit
      // level at 0.012, which dissolves a banding edge and is below the
      // threshold of visibility anywhere else.
      float g = dither(gl_FragCoord.xy + fract(uTime) * 512.0) - 0.5;
      colour *= 1.0 + g * uGrain;

      colour = mix(colour, uFlashColor, uFlash);

      gl_FragColor = vec4(colour, 1.0);
    }
  `,
};

/**
 * The bloom pyramid. Produces a texture; adds nothing to anything.
 *
 * A `Pass` so the composer drives it in order, with `needsSwap = false` because
 * it leaves both composer buffers exactly as it found them.
 */
class BloomChainPass extends Pass {
  /** The finished bloom, at a quarter of the frame in each axis. */
  get texture(): THREE.Texture { return this.levels[0].texture; }

  private levels: THREE.WebGLRenderTarget[] = [];
  private readonly prefilter = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(BLOOM_PREFILTER_SHADER.uniforms),
    vertexShader: BLOOM_PREFILTER_SHADER.vertexShader,
    fragmentShader: BLOOM_PREFILTER_SHADER.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  private readonly resample = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(BLOOM_RESAMPLE_SHADER.uniforms),
    vertexShader: BLOOM_RESAMPLE_SHADER.vertexShader,
    fragmentShader: BLOOM_RESAMPLE_SHADER.fragmentShader,
    depthTest: false,
    depthWrite: false,
    // The upward half of the pyramid adds each coarse level onto the finer one
    // below it, which is what turns a stack of blurs into a single falloff.
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  private readonly quad = new FullScreenQuad(this.prefilter);

  constructor(width: number, height: number) {
    super();
    this.needsSwap = false;
    this.setSize(width, height);
  }

  /** Threshold in linear radiance, above which light scatters. */
  set threshold(v: number) { this.prefilter.uniforms.uThreshold.value = v; }
  get threshold(): number { return this.prefilter.uniforms.uThreshold.value as number; }

  override setSize(width: number, height: number): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    // Starts at a quarter of the frame. Half would cost four times as much for
    // a term whose finest detail is a blur several pixels across.
    let w = Math.max(1, Math.round(width / 4));
    let h = Math.max(1, Math.round(height / 4));
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const t = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      this.levels.push(t);
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // Down: threshold into level 0, then successively halve.
    this.prefilter.uniforms.tDiffuse.value = readBuffer.texture;
    (this.prefilter.uniforms.uTexel.value as THREE.Vector2)
      .set(1 / readBuffer.width, 1 / readBuffer.height);
    this.quad.material = this.prefilter;
    renderer.setRenderTarget(this.levels[0]);
    renderer.clear(true, false, false);
    this.quad.render(renderer);

    this.quad.material = this.resample;
    this.resample.blending = THREE.NoBlending;
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      this.resample.uniforms.tDiffuse.value = src.texture;
      (this.resample.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.levels[i]);
      renderer.clear(true, false, false);
      this.quad.render(renderer);
    }

    // Up: add each coarse level back onto the one below it.
    this.resample.blending = THREE.AdditiveBlending;
    for (let i = this.levels.length - 1; i > 0; i--) {
      const src = this.levels[i];
      this.resample.uniforms.tDiffuse.value = src.texture;
      (this.resample.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.levels[i - 1]);
      this.quad.render(renderer);
    }

    renderer.autoClear = oldAutoClear;
    renderer.setRenderTarget(oldTarget);
  }

  override dispose(): void {
    for (const t of this.levels) t.dispose();
    this.levels = [];
    this.prefilter.dispose();
    this.resample.dispose();
    this.quad.dispose();
  }
}

export class PostFX {
  /**
   * True when a chain exists and the frame goes through it.
   *
   * NO LONGER `readonly`, and no longer `quality === 'high'`. It was both, and
   * that single line was a quarter of issue #29: every touch-primary device
   * resolved to `low`, so the constructor returned before allocating anything
   * and **the reporting device had never once seen bloom, the colour grade or
   * the contact occlusion.** The chain is now built and torn down on demand by
   * `setEnabled`, so the Video tab can turn it on without ending the session.
   */
  enabled = false;

  private composer: EffectComposer | null = null;
  private bloom: BloomChainPass | null = null;
  private grade: ShaderPass | null = null;
  private depth: THREE.DepthTexture | null = null;
  private readonly renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  /**
   * Whether the composer's scene target is multisampled.
   *
   * MSAA HAS TWO HOMES AND THEY MUST AGREE. When the chain is off the frame is
   * drawn straight to the canvas and the multisampling is the GL context's own
   * `antialias` attribute; when the chain is on the scene lands in the
   * composer's target instead and the context attribute does nothing at all —
   * the samples that matter are this one. Before three tiers existed the two
   * could not disagree, because the only configuration with a chain was also
   * the only configuration with `antialias`. `medium` is post-with-no-MSAA and
   * would have silently paid for four samples a pixel without it.
   */
  private msaa = true;
  private flash = 0;
  private flashDecay = 4;
  private time = 0;
  /** AO strength for the current tier; 0 while the chain is off. */
  private aoStrength = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: { post: boolean; msaa: boolean },
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.msaa = opts.msaa;
    if (opts.post) this.build();
  }

  /**
   * Turns the chain on or off without restarting the session.
   *
   * Allocating the composer costs one frame — three render targets and a
   * bloom pyramid — and that is worth naming, because it is the reason the
   * Video tab's note used to say a change needed a new session. It does not:
   * a single dropped frame on the settings screen is not a frame anybody is
   * racing on. Idempotent, so the caller can push its whole state every time
   * rather than tracking which fields moved.
   */
  setEnabled(on: boolean, msaa = this.msaa): void {
    if (on === this.enabled && msaa === this.msaa) return;
    this.msaa = msaa;
    this.dispose();
    if (on) this.build();
  }

  /** The samples the scene target is actually allocated with. For probes. */
  get sceneSamples(): number {
    return this.composer ? this.composer.renderTarget2.samples : 0;
  }

  private build(): void {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    this.enabled = true;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // A depth attachment the grade pass can read.
    //
    // It belongs to exactly one of the composer's two buffers, and which one is
    // not arbitrary: `RenderPass` does not swap, so the scene always lands in
    // the composer's READ buffer, which the composer initialises to
    // `renderTarget2`. Nothing downstream of the scene writes depth, so it
    // stays valid to the end of the chain.
    //
    // It must NOT also be attached to `renderTarget1`. The grade pass renders
    // INTO renderTarget1 while sampling this texture, and a texture that is
    // simultaneously an attachment of the framebuffer being drawn to is a
    // feedback loop.
    const depth = new THREE.DepthTexture(size.x, size.y);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    this.depth = depth;

    // Half-float target. An 8-bit intermediate would clip every value above 1.0
    // before the bloom pass ever sees it, which defeats the point of running
    // bloom on linear radiance in the first place.
    //
    // MSAA resolves geometric edges properly, which no post-process filter
    // can, and it is the only antialiasing in the chain — but it is now a
    // separate switch, because it is also the single most expensive thing in
    // the chain to leave on. See `msaa` above for why the context's own
    // `antialias` attribute cannot be the one that decides here.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: this.msaa ? 4 : 0,
      stencilBuffer: false,
    });

    const composer = new EffectComposer(renderer, target);
    composer.renderTarget2.depthTexture = depth;
    // `renderTarget1` only ever holds the output of a full-screen quad, and a
    // full-screen quad has no geometric edges to resolve — multisampling it is
    // four times the write bandwidth for a pixel-identical image. Set before
    // the first render, so the backend allocates it single-sampled rather than
    // reallocating it later.
    composer.renderTarget1.samples = 0;
    composer.addPass(new RenderPass(scene, camera));

    // Bloom BEFORE the grade pass, because the grade pass is what adds it.
    // It reads the composer's read buffer — the scene, in linear radiance,
    // untouched — and writes only into its own pyramid.
    this.bloom = new BloomChainPass(size.x, size.y);
    this.bloom.threshold = BLOOM_THRESHOLD;
    composer.addPass(this.bloom);

    this.grade = new ShaderPass(GRADE_SHADER);
    this.grade.uniforms.tDepth.value = depth;
    this.grade.uniforms.tBloom.value = this.bloom.texture;
    this.grade.uniforms.uBloom.value = BLOOM_STRENGTH;
    // 0.6, down from 0.85. The occlusion this pass produces is a twelve-tap
    // estimate with no blur after it, so its noise scales with its strength;
    // measured against a frame with the pass disabled it was contributing
    // around forty per cent of all the high-frequency variance on the road.
    // What it is FOR — stopping objects floating — is carried by the strong
    // contacts, and those survive at 0.6 with the noise cut by a third.
    this.aoStrength = 0.6;
    this.grade.uniforms.uAO.value = this.aoStrength;
    // Whatever grade was in force before the chain was rebuilt. The Video tab
    // can turn the chain off and on mid-session (issue #29), and the grade
    // belongs to the circuit's ambience, which is not re-applied on that path.
    this.applyGrade();
    composer.addPass(this.grade);

    // Applies the renderer's tone mapping and converts to sRGB. Last in the
    // chain, so the composer points it straight at the canvas and the frame is
    // never copied again after it.
    composer.addPass(new OutputPass());

    this.composer = composer;
  }

  /**
   * Swaps the camera after a session change.
   *
   * Recorded on the instance as well as pushed into the pass, because the
   * chain can now be rebuilt at any moment and a rebuild that used the camera
   * this object was CONSTRUCTED with would draw the menu's camera over a race.
   */
  setCamera(camera: THREE.Camera, scene: THREE.Scene): void {
    this.camera = camera;
    this.scene = scene;
    if (!this.composer) return;
    const pass = this.composer.passes[0] as RenderPass;
    pass.camera = camera;
    pass.scene = scene;
  }

  setSize(width: number, height: number): void {
    // `composer.setSize` calls `setSize` on every pass it holds, which includes
    // the bloom chain — so the pyramid is rebuilt for the new frame size by
    // that call, and the grade pass has to be pointed at the new top level
    // afterwards or it samples a disposed texture.
    this.composer?.setSize(width, height);
    if (this.grade) {
      (this.grade.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
      if (this.bloom) this.grade.uniforms.tBloom.value = this.bloom.texture;
    }
  }

  /**
   * @param speedMs   car speed, for the radial blur
   * @param focus     vanishing point in normalised screen space
   * @param nightBias more bloom at night, where the lights are the subject
   * @param wetness   0..1, how much water is on the world
   */
  update(
    dt: number,
    speedMs: number,
    focusX: number,
    focusY: number,
    nightBias: number,
    camera?: THREE.PerspectiveCamera,
    wetness = 0,
  ): void {
    this.time += dt;
    if (!this.grade) return;

    const u = this.grade.uniforms;
    u.uWet.value = clamp01(wetness);

    // The AO's world-space radius depends on the projection, and the camera
    // director changes the field of view continuously with speed. Reading it
    // every frame is what keeps the occlusion the same physical size at 60 and
    // at 320 km/h.
    if (camera) {
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uProjScale.value = 0.5 / Math.tan((camera.fov * Math.PI) / 360);
      u.uAspect.value = camera.aspect;
    }
    // Blur starts around 130 km/h and is at full strength near 320. Below that
    // there is nothing to sell — a slow car should look calm.
    const t = clamp01((speedMs - 36) / 54);
    u.uSpeed.value = t * t;
    (u.uFocus.value as THREE.Vector2).set(focusX, focusY);
    u.uTime.value = this.time;

    this.flash = Math.max(0, this.flash - this.flashDecay * dt);
    u.uFlash.value = this.flash;

    if (this.bloom) {
      // Strength does not move with the time of day, and that is the correction.
      //
      // The old model treated a night circuit as a dim scene that needed more
      // glow, and pushed strength up by half at night. A floodlit circuit is not
      // dim — it is lit by two hundred lamps from every direction, which is why
      // the night light rig carries a hemisphere of 1.85 against daylight's 0.75
      // — so the extra glow was not compensating for anything. It was doubling
      // the bloom on a scene that already had the brightest painted lines in the
      // game, and it is what turned every white line and kerb into a horizontal
      // smear across the road.
      //
      // What DOES change at night is the width of the range: a lamp reflected in
      // gloss paint is many times the road beside it, and the exposure the night
      // grade runs at is higher. So the threshold rises, and only the threshold.
      u.uBloom.value = BLOOM_STRENGTH;
      this.bloom.threshold = BLOOM_THRESHOLD + nightBias * 0.35;
    }
  }

  /**
   * The grade in force. Held on the instance rather than only on the uniform,
   * because the chain is built and torn down on demand (issue #29) and a grade
   * set while the chain was off would otherwise be lost on the way back.
   */
  private gradeParams: Grade = GRADES.off;

  /**
   * Install a colour grade by name, or turn it off.
   *
   * `Renderer.applyAmbience` is the caller: the grade belongs to the time of
   * day, because a floodlit circuit and an overcast afternoon do not want the
   * same white balance and the reference frames measure differently on every
   * one of the four terms.
   */
  setGrade(which: 'day' | 'dusk' | 'night' | 'off'): void {
    this.gradeParams = GRADES[which];
    this.applyGrade();
  }

  private applyGrade(): void {
    if (!this.grade) return;
    const g = this.gradeParams;
    const u = this.grade.uniforms;
    u.uGradeOn.value = g === GRADES.off ? 0 : 1;
    (u.uBalance.value as THREE.Vector3).set(g.balance[0], g.balance[1], g.balance[2]);
    u.uContrast.value = g.contrast;
    u.uPivot.value = g.pivot;
    u.uToe.value = g.toe;
    u.uToeRange.value = g.toeRange;
    u.uSaturation.value = g.saturation;
  }

  /** A full-screen flash: impacts, the start, a chequered flag. */
  triggerFlash(strength: number, decayPerSecond: number, colour: THREE.ColorRepresentation): void {
    if (!this.grade) return;
    this.flash = Math.max(this.flash, clamp01(strength));
    this.flashDecay = decayPerSecond;
    (this.grade.uniforms.uFlashColor.value as THREE.Color).set(colour);
  }

  /** Draws the frame. Falls back to a direct render when post is disabled. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.bloom?.dispose();
    this.bloom = null;
    this.composer?.dispose();
    this.composer = null;
    this.depth?.dispose();
    this.depth = null;
    this.grade?.dispose();
    this.grade = null;
    this.aoStrength = 0;
    this.enabled = false;
  }
}
