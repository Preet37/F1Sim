import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { clamp01 } from '../core/MathUtils';

/**
 * The post-processing chain.
 *
 * Pass order is not cosmetic, it is the whole thing:
 *
 *   scene -> bloom -> grade -> tone map & sRGB
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
 *  - CHROMATIC ABERRATION on the same radial axis, scaled by the same term.
 *    Kept subtle, and gated entirely behind speed.
 *  - VIGNETTE, which darkens the corners and pushes attention to the apex.
 *  - DITHER, sub-perceptual, purely to break 8-bit banding.
 *
 * The last three are all capable of turning a clean picture into what looks like
 * archive footage, and had between them done exactly that: a heavy vignette, a
 * lens fringe present at a standstill, and a linear-space grain that the output
 * transform amplified into visible striping across every shadow. The rule they
 * are now tuned to is that none of them should be identifiable as an effect. If
 * you can point at the vignette, it is too strong.
 *
 * On the low quality tier the whole composer is skipped and the scene renders
 * straight to the canvas. Bloom on a phone GPU is five extra full-screen passes
 * at half resolution, and holding 60fps matters more than glow.
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

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Scene depth, shared by both composer buffers. */
    tDepth: { value: null as THREE.Texture | null },
    /** 0..1 blur strength, driven by speed. */
    uSpeed: { value: 0 },
    /** Vanishing point in UV space — where the blur streaks converge. */
    uFocus: { value: new THREE.Vector2(0.5, 0.5) },
    uVignette: { value: 0.14 },
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
    uniform float uSpeed;
    uniform vec2 uFocus;
    uniform float uVignette;
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
        // Ramp in from 15mm, so shading noise and depth precision do not
        // register, and out again past 0.9m, beyond which it is another object.
        occ += smoothstep(0.015, 0.13, diff) * (1.0 - smoothstep(0.35, 0.9, diff));
      }

      occ /= float(TAPS);
      // Fade the whole effect out with distance: at 90m a half-metre radius is
      // a couple of pixels and all it contributes is noise.
      occ *= 1.0 - smoothstep(45.0, 90.0, centre);
      return clamp(occ, 0.0, 1.0);
    }

    void main() {
      vec2 dir = vUv - uFocus;
      float dist = length(dir);

      // Blur only the periphery. The centre of the screen is where the driver
      // is looking and where the apex is; smearing it would just look broken.
      float falloff = smoothstep(0.06, 0.75, dist);
      float amount = uSpeed * falloff * 0.055;

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

      // Chromatic aberration along the same radial axis. Red and blue are
      // displaced in opposite directions, which is how a real lens fails.
      //
      // Gated entirely behind speed. The constant term that used to sit
      // alongside it fringed the edge of every frame including a stationary
      // one, which is a description of a cheap lens rather than of going fast,
      // and it is part of what made the picture look like old footage. What is
      // left is a speed cue: at rest there is none, and at 300 km/h it is a
      // fraction of a pixel at the very edge of the frame.
      float ca = uSpeed * falloff * 0.0016;
      if (ca > 0.00005) {
        colour.r = texture2D(tDiffuse, vUv - dir * ca).r;
        colour.b = texture2D(tDiffuse, vUv + dir * ca).b;
      }

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

export class PostFX {
  readonly enabled: boolean;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private fxaa: ShaderPass | null = null;
  private depth: THREE.DepthTexture | null = null;
  private readonly renderer: THREE.WebGLRenderer;
  private flash = 0;
  private flashDecay = 4;
  private time = 0;
  /** AO strength for the current tier; 0 on low. */
  private aoStrength = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    quality: 'low' | 'high',
  ) {
    this.renderer = renderer;
    this.enabled = quality === 'high';
    if (!this.enabled) return;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // A depth attachment the grade pass can read. Both of the composer's
    // ping-pong buffers point at this same texture, so it does not matter which
    // one is being read when the AO runs — and nothing downstream of the scene
    // render writes depth, so it stays valid all the way to the end of the
    // chain.
    const depth = new THREE.DepthTexture(size.x, size.y);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.UnsignedIntType;
    this.depth = depth;

    // Half-float target. An 8-bit intermediate would clip every value above 1.0
    // before the bloom pass ever sees it, which defeats the point of running
    // bloom on linear radiance in the first place.
    //
    // MSAA is kept on: it resolves geometric edges properly, which no
    // post-process filter can, and the FXAA at the end of the chain is there to
    // catch the shading and texture aliasing MSAA cannot see.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      stencilBuffer: false,
      depthTexture: depth,
    });

    const composer = new EffectComposer(renderer, target);
    // The second buffer is cloned from the first and must share the depth
    // attachment, or the AO reads an empty texture on every other frame.
    composer.renderTarget2.depthTexture = depth;
    composer.addPass(new RenderPass(scene, camera));

    // strength / radius / threshold. See `update` for how the threshold was
    // arrived at; the short version is that it has to sit above what a white
    // painted line reaches, and a painted line is brighter than 1.0.
    this.bloom = new UnrealBloomPass(size, BLOOM_STRENGTH, 0.62, BLOOM_THRESHOLD);
    composer.addPass(this.bloom);

    this.grade = new ShaderPass(GRADE_SHADER);
    this.grade.uniforms.tDepth.value = depth;
    this.aoStrength = 0.85;
    this.grade.uniforms.uAO.value = this.aoStrength;
    composer.addPass(this.grade);

    // Applies the renderer's tone mapping and converts to sRGB.
    composer.addPass(new OutputPass());

    // FXAA goes AFTER the tone mapper, not before it.
    //
    // FXAA decides where an edge is by looking at perceived luminance
    // differences between neighbouring pixels. Run on linear radiance, a step
    // from 8.0 to 9.0 — invisible once tone-mapped — reads as a huge edge and
    // gets blended, while the step from 0.02 to 0.05 that is genuinely visible
    // reads as nothing and is left jagged. Running it on the display-referred
    // image is the whole reason it works.
    const fxaa = new ShaderPass(FXAAShader);
    fxaa.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
    this.fxaa = fxaa;
    composer.addPass(fxaa);

    this.composer = composer;
  }

  /** Swaps the camera after a session change. */
  setCamera(camera: THREE.Camera, scene: THREE.Scene): void {
    if (!this.composer) return;
    const pass = this.composer.passes[0] as RenderPass;
    pass.camera = camera;
    pass.scene = scene;
  }

  setSize(width: number, height: number): void {
    this.composer?.setSize(width, height);
    this.bloom?.setSize(width, height);
    this.fxaa?.material.uniforms.resolution.value.set(1 / width, 1 / height);
    if (this.grade) {
      (this.grade.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    }
  }

  /**
   * @param speedMs   car speed, for the radial blur
   * @param focus     vanishing point in normalised screen space
   * @param nightBias more bloom at night, where the lights are the subject
   */
  update(
    dt: number,
    speedMs: number,
    focusX: number,
    focusY: number,
    nightBias: number,
    camera?: THREE.PerspectiveCamera,
  ): void {
    this.time += dt;
    if (!this.grade) return;

    const u = this.grade.uniforms;

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
      this.bloom.strength = BLOOM_STRENGTH;
      this.bloom.threshold = BLOOM_THRESHOLD + nightBias * 0.35;
    }
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
    this.composer?.dispose();
    this.composer = null;
    this.depth?.dispose();
    this.depth = null;
  }
}
