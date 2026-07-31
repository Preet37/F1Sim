import * as THREE from 'three';

/**
 * The environment probe: the thing the car's paint reflects.
 *
 * This is the highest-leverage object in the whole renderer, and the reason is
 * worth stating plainly, because the first version of it got this exactly wrong.
 *
 * A `MeshStandardMaterial` computes its specular response by integrating the
 * environment over a cone whose width is set by roughness. If the environment is
 * a SMOOTH GRADIENT, that integral is — to within a few percent — the same
 * number everywhere on a curved panel. Which means the reflection term is a flat
 * wash, the diffuse term is a flat wash, and the sum of two flat washes is
 * painted plastic. That is what the previous 64x64 "bright above, dark below,
 * warm on one side" probe produced, and no amount of tuning roughness rescues
 * it, because the information simply is not in the probe.
 *
 * What makes a car look like a car is CONTRAST IN THE PROBE, specifically:
 *
 *  - A HARD HORIZON. The single most important feature. Sky is bright, ground is
 *    dark, and the line between them is sharp. As a curved flank turns past the
 *    horizon, its reflection sweeps from bright to dark across a few centimetres
 *    — that travelling light/dark boundary along a sidepod is the whole reason
 *    the shape reads as a shape. A probe without a horizon has no shape cue at
 *    all.
 *  - A SMALL, VERY BRIGHT SUN. Order 100x the sky's radiance, not 1.2x. This is
 *    what puts a compact hot highlight on the airbox and along the halo, and it
 *    only works if the probe is float — an 8-bit probe clips it to the same
 *    white as the sky and the highlight disappears into the wash.
 *  - HORIZONTAL STRUCTURE. Cloud banding by day, a ring of floodlights at night,
 *    a bright horizon haze band always. These stretch into the long streaky
 *    highlights that run the length of a real car's bodywork. They are the
 *    difference between "shiny" and "wet-looking".
 *
 * Cost: one 256x128 float image, generated once per ambience, PMREM-filtered,
 * and then it is free forever. There are no image files in this project and
 * there will not be any.
 */

export type Ambience = 'day' | 'dusk' | 'night';

/** Equirectangular probe resolution. PMREM downsamples anyway; this is plenty. */
const W = 256;
const H = 128;

interface Palette {
  /** Zenith, horizon-sky, and ground colours as linear RGB triples. */
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  /** Sun colour and peak radiance multiplier. */
  sun: [number, number, number];
  sunPower: number;
  /** Elevation of the sun, in degrees above the horizon. */
  sunElevation: number;
  /** Azimuth of the sun, in degrees. */
  sunAzimuth: number;
  /** Strength of the bright haze band sitting on the horizon. */
  hazeBoost: number;
  /** Cloud/floodlight banding strength. */
  banding: number;
  /** Number of discrete light sources around the horizon (floodlights). */
  floodlights: number;
  /** Radiance of each floodlight. */
  floodPower: number;
  /** Colour of the floodlights. */
  floodColour: [number, number, number];
}

const PALETTES: Record<Ambience, Palette> = {
  day: {
    zenith: [0.06, 0.13, 0.34],
    horizon: [0.55, 0.66, 0.82],
    ground: [0.035, 0.036, 0.040],
    sun: [1.0, 0.93, 0.80],
    sunPower: 220,
    sunElevation: 52,
    sunAzimuth: 205,
    hazeBoost: 1.5,
    banding: 0.42,
    floodlights: 0,
    floodPower: 0,
    floodColour: [1, 1, 1],
  },
  dusk: {
    zenith: [0.035, 0.055, 0.16],
    horizon: [0.85, 0.36, 0.20],
    ground: [0.022, 0.018, 0.020],
    sun: [1.0, 0.55, 0.22],
    sunPower: 90,
    sunElevation: 6,
    sunAzimuth: 250,
    hazeBoost: 2.1,
    banding: 0.55,
    floodlights: 0,
    floodPower: 0,
    floodColour: [1, 1, 1],
  },
  night: {
    // A night probe is NOT "the day probe, darker". At night the only things
    // that reflect are the floodlights, and they are point-like and violently
    // brighter than everything else in frame. That ratio — a near-black dome
    // punctured by a ring of small hot sources — is exactly what produces the
    // hard specular streaks running along a car's flanks under lights, and it
    // is the entire reason the reference footage reads as a night race rather
    // than as a grey race.
    zenith: [0.004, 0.006, 0.014],
    horizon: [0.030, 0.034, 0.052],
    ground: [0.010, 0.010, 0.012],
    sun: [0.5, 0.6, 0.9],
    sunPower: 0,
    sunElevation: 60,
    sunAzimuth: 30,
    hazeBoost: 1.9,
    banding: 0.20,
    floodlights: 14,
    floodPower: 34,
    floodColour: [1.0, 0.97, 0.88],
  },
};

/** Smooth Hermite step, matching the GLSL builtin. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Renders the probe into a half-float equirectangular texture.
 *
 * Float matters more here than resolution. The sun is two hundred times the
 * radiance of the sky; in eight bits both are 255 and the car loses its
 * highlight entirely.
 */
function renderProbe(p: Palette, wetness: number): THREE.DataTexture {
  const data = new Float32Array(W * H * 4);

  const sunEl = (p.sunElevation * Math.PI) / 180;
  const sunAz = (p.sunAzimuth * Math.PI) / 180;
  const sunDir: [number, number, number] = [
    Math.cos(sunEl) * Math.sin(sunAz),
    Math.sin(sunEl),
    Math.cos(sunEl) * Math.cos(sunAz),
  ];

  // Overcast flattens the probe: a wet race genuinely has no hard sun, and
  // leaving one in is why an overcast scene can still show a hot highlight
  // that agrees with nothing else on screen.
  const sunPower = p.sunPower * (1 - wetness * 0.85);
  const bandAmount = p.banding * (1 - wetness * 0.5);

  for (let y = 0; y < H; y++) {
    // v = 0 at the top of the sphere.
    const theta = ((y + 0.5) / H) * Math.PI;
    const cy = Math.cos(theta);
    const sy = Math.sin(theta);

    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W) * Math.PI * 2;
      const dx = sy * Math.sin(phi);
      const dz = sy * Math.cos(phi);
      const dy = cy;

      let r: number, g: number, b: number;

      if (dy >= 0) {
        // --- Sky ---------------------------------------------------------
        // Biased toward the horizon so most of the dome's dynamic range sits
        // in the band a car actually reflects.
        const t = Math.pow(dy, 0.42);
        r = p.horizon[0] + (p.zenith[0] - p.horizon[0]) * t;
        g = p.horizon[1] + (p.zenith[1] - p.horizon[1]) * t;
        b = p.horizon[2] + (p.zenith[2] - p.horizon[2]) * t;

        // Horizontal banding. Low-frequency in elevation, so it stretches into
        // long highlights along a flank rather than dappling it.
        const band =
          Math.sin(dy * 11.0 + phi * 1.7) * 0.5 +
          Math.sin(dy * 23.0 - phi * 2.9) * 0.3 +
          Math.sin(dy * 41.0 + phi * 0.8) * 0.2;
        const bandMask = smoothstep(0.02, 0.55, dy) * (1 - smoothstep(0.6, 1.0, dy));
        const k = 1 + band * bandAmount * bandMask;
        r *= k; g *= k; b *= k;
      } else {
        // --- Ground ------------------------------------------------------
        // Dark, and slightly warmer looking straight down. The important part
        // is not what colour it is, it is that it is DARK and that the edge
        // against the sky is sharp.
        const t = Math.pow(-dy, 0.6);
        const fade = 1 - t * 0.45;
        r = p.ground[0] * fade;
        g = p.ground[1] * fade;
        b = p.ground[2] * fade;

        // Wet asphalt mirrors the sky back up. This is what makes a car look
        // like it is standing on a wet track rather than floating over a hole.
        if (wetness > 0.02) {
          const m = wetness * 0.55 * (1 - smoothstep(0.0, 0.5, -dy));
          r += p.horizon[0] * m;
          g += p.horizon[1] * m;
          b += p.horizon[2] * m;
        }
      }

      // --- Horizon haze band -----------------------------------------------
      // A bright, narrow strip sitting exactly on the horizon. This is the
      // brightest large feature in most real environments — distant sky through
      // haze, or the lit run-off and pit buildings — and it is what draws the
      // long horizontal highlight down the length of a sidepod.
      const haze = Math.exp(-Math.abs(dy) * 26.0) * p.hazeBoost;
      r += p.horizon[0] * haze;
      g += p.horizon[1] * haze;
      b += p.horizon[2] * haze;

      // --- Sun -------------------------------------------------------------
      if (sunPower > 0) {
        const d = dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2];
        if (d > 0) {
          // A small hard disc plus a wide forward-scattering skirt. The skirt
          // is what stops the highlight looking like a sticker.
          const disc = smoothstep(0.9975, 0.9995, d) * sunPower;
          const skirt = Math.pow(d, 220) * sunPower * 0.22 + Math.pow(d, 9) * 0.25;
          const s = disc + skirt;
          r += p.sun[0] * s;
          g += p.sun[1] * s;
          b += p.sun[2] * s;
        }
      }

      // --- Floodlights -------------------------------------------------------
      // A ring of small, very hot sources at about 18 degrees of elevation,
      // which is roughly where a real circuit's masts sit relative to a car.
      if (p.floodlights > 0) {
        const el = Math.asin(Math.max(-1, Math.min(1, dy)));
        for (let i = 0; i < p.floodlights; i++) {
          const a = (i / p.floodlights) * Math.PI * 2;
          // Two rows, slightly staggered, so a rotating car sweeps through them
          // continuously instead of strobing.
          const targetEl = (i % 2 === 0 ? 17 : 25) * (Math.PI / 180);
          let da = phi - a;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          const de = el - targetEl;
          const d2 = (da * da) / 0.0016 + (de * de) / 0.0009;
          if (d2 < 24) {
            const s = Math.exp(-d2) * p.floodPower;
            r += p.floodColour[0] * s;
            g += p.floodColour[1] * s;
            b += p.floodColour[2] * s;
          }
        }
      }

      const o = (y * W + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 1;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  // Already linear radiance: no colour-space conversion wanted.
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Owns the scene's environment map and swaps it when the ambience changes.
 *
 * Holds one PMREM target at a time and disposes the previous one, because a
 * session change that leaked a PMREM target per load would quietly eat a few
 * megabytes of VRAM per circuit visited.
 */
export class EnvProbe {
  private pmrem: THREE.PMREMGenerator;
  private target: THREE.WebGLRenderTarget | null = null;
  private key = '';

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /**
   * Builds the probe for an ambience and applies it to the scene.
   * A repeat call with the same parameters is free.
   */
  apply(scene: THREE.Scene, ambience: Ambience, wetness: number): void {
    // Quantised, so drizzle drifting from 0.30 to 0.31 does not rebuild and
    // re-filter the probe every frame.
    const w = Math.round(Math.min(1, Math.max(0, wetness)) * 4) / 4;
    const key = `${ambience}:${w}`;
    if (key === this.key && this.target) {
      scene.environment = this.target.texture;
      return;
    }

    const src = renderProbe(PALETTES[ambience], w);
    const next = this.pmrem.fromEquirectangular(src);
    src.dispose();

    this.target?.dispose();
    this.target = next;
    this.key = key;
    scene.environment = next.texture;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.pmrem.dispose();
  }
}
