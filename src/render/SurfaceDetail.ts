import * as THREE from 'three';

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
 * Everything is generated at runtime. Two 256px textures cost about a
 * millisecond to build and nothing to download.
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
}

export const SURFACES: Record<string, SurfaceProfile> = {
  /**
   * Asphalt. Fine aggregate grain plus a much broader patchiness for the
   * resurfacing seams and age variation every real circuit has.
   */
  asphalt: {
    scaleA: 1.4, scaleB: 0.055,
    strengthA: 0.3, strengthB: 0.22,
    normalStrength: 0.55,
    roughnessVariation: 0.3,
    roughness: 0.62, metalness: 0.05,
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
  },
  /** Kerbs: painted concrete, worn and scuffed by cars running over them. */
  kerb: {
    scaleA: 2.2, scaleB: 0.12,
    strengthA: 0.18, strengthB: 0.16,
    normalStrength: 0.3,
    roughness: 0.55, metalness: 0.02,
    roughnessVariation: 0.18,
  },
  /** Gravel and tarmac run-off: coarse, matte, strongly broken up. */
  runoff: {
    scaleA: 0.75, scaleB: 0.09,
    strengthA: 0.42, strengthB: 0.3,
    normalStrength: 1.1,
    roughnessVariation: 0.15,
    roughness: 0.92, metalness: 0,
  },
  /** Grass: large-scale mottling, mowing variation, no sheen at all. */
  grass: {
    scaleA: 0.55, scaleB: 0.035,
    strengthA: 0.4, strengthB: 0.34,
    normalStrength: 0.8,
    roughnessVariation: 0.08,
    roughness: 0.97, metalness: 0,
  },
  /** Concrete walls and barriers. Planar projection, so no bump. */
  wall: {
    scaleA: 0.5, scaleB: 0.06,
    strengthA: 0.16, strengthB: 0.12,
    normalStrength: 0,
    roughnessVariation: 0.1,
    roughness: 0.8, metalness: 0.04,
  },
};

/**
 * Seamless multi-octave value noise, plus the normal map derived from it.
 *
 * Tiling is the whole trick: the lattice wraps modulo the octave's period, so
 * the left edge is genuinely the same as the right edge and the texture repeats
 * without a visible seam. Getting this wrong shows up as a grid of hard lines
 * across the track that is impossible to miss once seen.
 */
function makeGrain(size = 256): { grain: THREE.DataTexture; normal: THREE.DataTexture } {
  const height = new Float32Array(size * size);

  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  // Octaves at powers of two so every one divides the texture exactly and
  // therefore wraps.
  const octaves = [
    { period: 4, amp: 0.5 },
    { period: 8, amp: 0.26 },
    { period: 16, amp: 0.14 },
    { period: 32, amp: 0.07 },
    { period: 64, amp: 0.03 },
  ];

  for (const { period, amp } of octaves) {
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
        height[y * size + x] += v * amp;
      }
    }
  }

  // Normalise to 0..1 so the profiles' strengths mean the same thing whatever
  // the octave weights happen to sum to.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < height.length; i++) {
    if (height[i] < lo) lo = height[i];
    if (height[i] > hi) hi = height[i];
  }
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - lo) / span;

  const grainData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = height[i];
      const o = i * 4;
      grainData[o] = grainData[o + 1] = grainData[o + 2] = Math.round(v * 255);
      grainData[o + 3] = 255;

      // Central differences with wrapping indices, so the normal map tiles too.
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = height[y * size + xp] - height[y * size + xm];
      const dy = height[yp * size + x] - height[ym * size + x];
      // Tangent-space normal of the height field, packed to 0..255.
      let nx = -dx * 4, ny = -dy * 4, nz = 1;
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
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return { grain: mk(grainData, false), normal: mk(normalData, false) };
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

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGrain = { value: this.grain };
      shader.uniforms.uGrainNormal = { value: this.normal };
      shader.uniforms.uScale = { value: new THREE.Vector2(profile.scaleA, profile.scaleB) };
      shader.uniforms.uStrength = { value: new THREE.Vector2(profile.strengthA, profile.strengthB) };
      shader.uniforms.uNormalStrength = { value: profile.normalStrength };
      shader.uniforms.uRoughVar = { value: profile.roughnessVariation };

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
          float detailGrain(out float coarse) {
            float a = texture2D(uGrain, vDetailPos.xz * uScale.x).r;
            coarse = texture2D(uGrain, vDetailPos.xz * uScale.y).r;
            return a;
          }
        `)
        // After the base colour is established, darken it by the two octaves.
        // Multiplying keeps the vertex colour in charge of hue — the grain
        // only ever removes light, which is how real surface variation works.
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          float dCoarse;
          float dFine = detailGrain(dCoarse);
          float dMix = mix(1.0, 0.45 + dFine, uStrength.x)
                     * mix(1.0, 0.55 + dCoarse * 0.9, uStrength.y);
          diffuseColor.rgb *= dMix;
        `)
        // Rougher where the grain is high. Gives the road patches of sheen that
        // slide across it as the car moves, which is most of what makes asphalt
        // look wet-ish and real rather than like grey felt.
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + (dFine - 0.5) * uRoughVar, 0.04, 1.0);
        `)
        // Bump last, so it perturbs the normal three.js has already resolved.
        // The projection is planar in XZ, so the map's x and y drive world x
        // and z; on a near-vertical face that is meaningless, which is why
        // walls set the strength to zero.
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          if (uNormalStrength > 0.0) {
            vec3 bumpA = texture2D(uGrainNormal, vDetailPos.xz * uScale.x).xyz * 2.0 - 1.0;
            normal = normalize(normal + vec3(bumpA.x, 0.0, bumpA.y) * uNormalStrength);
          }
        `);
    };

    // Materials that compile to different programs must not share a cache key,
    // or three.js hands the second one the first one's compiled shader and
    // every surface silently gets the asphalt profile.
    material.customProgramCacheKey = () =>
      `sd:${profile.scaleA}:${profile.scaleB}:${profile.strengthA}:${profile.strengthB}:${profile.normalStrength}:${profile.roughnessVariation}`;
    material.needsUpdate = true;
  }

  dispose(): void {
    this.grain.dispose();
    this.normal.dispose();
  }
}
