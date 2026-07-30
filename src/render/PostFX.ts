import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
 * The grade pass then does three things in one fragment shader, because each is
 * a couple of instructions and three separate full-screen passes would cost
 * three round trips through memory for no benefit:
 *
 *  - RADIAL BLUR that strengthens with speed. This is the single most effective
 *    speed cue there is. A car at 320 km/h and a car at 120 km/h fill the same
 *    fraction of the screen and the road ahead looks identical; smearing the
 *    periphery towards a vanishing point is what the eye actually uses to judge
 *    velocity, and it is why 200 km/h feels dangerous rather than brisk.
 *  - CHROMATIC ABERRATION on the same radial axis, scaled by the same term.
 *    Kept subtle. It sells the periphery as a lens rather than a viewport.
 *  - VIGNETTE, which darkens the corners and pushes attention to the apex.
 *
 * On the low quality tier the whole composer is skipped and the scene renders
 * straight to the canvas. Bloom on a phone GPU is five extra full-screen passes
 * at half resolution, and holding 60fps matters more than glow.
 */

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0..1 blur strength, driven by speed. */
    uSpeed: { value: 0 },
    /** Vanishing point in UV space — where the blur streaks converge. */
    uFocus: { value: new THREE.Vector2(0.5, 0.5) },
    uVignette: { value: 0.34 },
    /** Rises when the car is off track or damaged, for a dirt/heat feel. */
    uGrain: { value: 0.03 },
    uTime: { value: 0 },
    /** Full-screen flash, 0..1: used for the start lights and impacts. */
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
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
    uniform float uSpeed;
    uniform vec2 uFocus;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;

    // Interleaved gradient noise: one line, well distributed, and stable enough
    // between frames that it does not crawl the way a hash of uv+time does.
    float dither(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
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
      float ca = uSpeed * falloff * 0.0035 + falloff * 0.0006;
      if (ca > 0.00005) {
        colour.r = texture2D(tDiffuse, vUv - dir * ca).r;
        colour.b = texture2D(tDiffuse, vUv + dir * ca).b;
      }

      // Vignette. Squared so it stays clear of the centre and rolls in fast at
      // the corners rather than dimming the whole frame.
      float v = 1.0 - uVignette * dist * dist * 2.2;
      colour *= clamp(v, 0.0, 1.0);

      // A little grain keeps flat sky and asphalt from banding on 8-bit output.
      float g = dither(gl_FragCoord.xy + fract(uTime) * 512.0) - 0.5;
      colour += g * uGrain;

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
  private readonly renderer: THREE.WebGLRenderer;
  private flash = 0;
  private flashDecay = 4;
  private time = 0;

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

    // Half-float target. An 8-bit intermediate would clip every value above 1.0
    // before the bloom pass ever sees it, which defeats the point of running
    // bloom on linear radiance in the first place.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      stencilBuffer: false,
    });

    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));

    // strength / radius / threshold. The threshold is the important number: at
    // 0.85 only things meaningfully brighter than white bloom, which is the
    // sparks, the brake discs, the sun on chrome and the start lights.
    this.bloom = new UnrealBloomPass(size, 0.42, 0.62, 0.85);
    composer.addPass(this.bloom);

    this.grade = new ShaderPass(GRADE_SHADER);
    composer.addPass(this.grade);

    // Applies the renderer's tone mapping and converts to sRGB. Must be last.
    composer.addPass(new OutputPass());

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
  }

  /**
   * @param speedMs   car speed, for the radial blur
   * @param focus     vanishing point in normalised screen space
   * @param nightBias more bloom at night, where the lights are the subject
   */
  update(dt: number, speedMs: number, focusX: number, focusY: number, nightBias: number): void {
    this.time += dt;
    if (!this.grade) return;

    const u = this.grade.uniforms;
    // Blur starts around 130 km/h and is at full strength near 320. Below that
    // there is nothing to sell — a slow car should look calm.
    const t = clamp01((speedMs - 36) / 54);
    u.uSpeed.value = t * t;
    (u.uFocus.value as THREE.Vector2).set(focusX, focusY);
    u.uTime.value = this.time;

    this.flash = Math.max(0, this.flash - this.flashDecay * dt);
    u.uFlash.value = this.flash;

    if (this.bloom) this.bloom.strength = 0.42 + nightBias * 0.5;
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
  }
}
