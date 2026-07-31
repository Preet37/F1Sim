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
    roughnessVariation: 0.16,
    // 0.58 rather than 0.62. Asphalt is rough, but it is not chalk: a wide,
    // low-frequency sheen sweeps across it wherever a light source is roughly
    // mirrored, and under floodlights that sheen is most of what the surface
    // IS. At 0.62 the specular lobe was wide enough to be indistinguishable
    // from the diffuse term and the road went dead flat at night. Below about
    // 0.55 it goes the other way and the lobe tightens into a single glaring
    // hotspot that fills the onboard camera.
    roughness: 0.58, metalness: 0.05,
    // Half the strength at just over half the frequency. Doubling the stone
    // size takes the finest octave from a fifth of a pixel to nearly half of
    // one at the range that was boiling, which is the side of the sampling
    // limit it has to be on; halving the strength deals with what is left.
    // The road still reads as a surface with stones in it — that is what the
    // term is for, and every reference frame of real asphalt has one — it just
    // stops sparkling.
    aggregate: 0.34, aggregateScale: 3.0,
    seams: 0.55, seamScale: 0.045,
    patches: 0.85, patchScale: 0.02,
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
 *
 * Three bands are packed into the one texture, because the road wants noise at
 * three different smoothnesses and three lookups would cost three times as much
 * as three channels of one:
 *
 *  R — every octave. Fine grain, and the field the normal map is derived from.
 *  G — the two coarsest octaves only. Smooth, large blobs. Thresholding this is
 *      what gives patch repairs a clean boundary; thresholding R gives a mess of
 *      camouflage, because R still has quarter-metre detail in it at any scale.
 *  B — the middle octaves. Its half-value contour is a meandering curve of about
 *      the right wander for a paving joint or a crack.
 */
function makeGrain(size = 256): { grain: THREE.DataTexture; normal: THREE.DataTexture } {
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
  // normal map is differentiated from and it has a four-pixel period, so it is
  // the finest thing the texture can express — and on a road tiled several
  // times per metre it lands below one screen pixel at any useful range. Energy
  // there cannot be resolved; it can only alias. Moving it one octave coarser
  // keeps the same overall contrast in the colour, where it is wanted, and
  // takes it out of the derivative, where it was only ever sparkle.
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
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = height[y * size + xp] - height[y * size + xm];
      const dy = height[yp * size + x] - height[ym * size + x];
      // Tangent-space normal of the height field, packed to 0..255.
      //
      // Gain 2.4, not 4. A central difference over a normalised field times
      // four produces slopes past 60 degrees on the steepest cells, and a
      // 60-degree facet either mirrors a floodlight into the camera or misses
      // it entirely — there is no middle. Real asphalt has no such facets.
      let nx = -dx * 2.4, ny = -dy * 2.4, nz = 1;
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

const RUBBER_RES = 2048;
const RUBBER_DATA = new Uint8Array(RUBBER_RES * RUBBER_RES);
const RUBBER_TEX = new THREE.DataTexture(RUBBER_DATA, RUBBER_RES, RUBBER_RES, THREE.RedFormat);
RUBBER_TEX.wrapS = RUBBER_TEX.wrapT = THREE.ClampToEdgeWrapping;
RUBBER_TEX.magFilter = THREE.LinearFilter;
RUBBER_TEX.minFilter = THREE.LinearMipmapLinearFilter;
RUBBER_TEX.generateMipmaps = true;
RUBBER_TEX.anisotropy = 4;
RUBBER_TEX.needsUpdate = true;

/** World-to-map transform: (originX, originZ, 1/span, 1/span). */
const RUBBER_XF = new THREE.Vector4(0, 0, 0, 0);

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
export function setRubberLine(track: TrackSpline | null): void {
  RUBBER_DATA.fill(0);

  if (!track) {
    RUBBER_XF.set(0, 0, 0, 0);
    RUBBER_TEX.needsUpdate = true;
    return;
  }

  const { count, px, pz, nx, nz, lineOffset, width, lineCurvature } = track;

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

    // The groove is wider where the cars are spread out and narrower where a
    // corner funnels everyone onto one line. Curvature is the cheapest honest
    // proxy for that, and it is what makes the band pinch at an apex and fan
    // out down a straight — the shape the band has in every aerial photograph.
    const k = Math.abs(lineCurvature[i]);
    const tight = Math.min(1, k * 90);
    const halfW = Math.max(1.4, width[i] * (0.19 - 0.07 * tight));
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
    const aggCode = aggregate <= 0 ? '' : /* glsl */`
      float aggN = texture2D(uGrain, vDetailPos.xz * ${f(profile.aggregateScale ?? 5.5)} + vec2(0.31, 0.67)).r;
      // A gentler contrast stretch than 0.40..0.76. Narrowing the window is
      // what turns a smooth noise field into discrete speckle, and discrete
      // speckle a fraction of a pixel across is the definition of aliasing.
      agg = smoothstep(0.34, 0.86, aggN);
      dMix *= mix(1.0, 0.74 + agg * 0.46, ${f(aggregate)});
    `;
    // The half-value contour of the mid band, taken twice at different scales
    // and offsets: one set of long joints running the length of the surface and
    // one much finer set of cracks branching off them.
    const seamCode = seams <= 0 ? '' : /* glsl */`
      float seamN = texture2D(uGrain, vDetailPos.xz * ${f(profile.seamScale ?? 0.05)} + vec2(0.73, 0.19)).b;
      float seamJoint = 1.0 - smoothstep(0.0, 0.014, abs(seamN - 0.5));
      float crackN = texture2D(uGrain, vDetailPos.xz * ${f((profile.seamScale ?? 0.05) * 5.0)} + vec2(0.41, 0.62)).b;
      float crackLine = 1.0 - smoothstep(0.0, 0.02, abs(crackN - 0.5));
      dMix *= 1.0 - (seamJoint * 0.6 + crackLine * 0.4) * ${f(seams * 0.45)};
    `;
    const patchCode = patches <= 0 ? '' : /* glsl */`
      // The smooth band, so a repair comes out as one large region with a
      // definite boundary rather than as camouflage.
      float patchN = texture2D(uGrain, vDetailPos.xz * ${f(profile.patchScale ?? 0.022)} + vec2(0.11, 0.83)).g;
      sdPatch = smoothstep(0.615, 0.645, patchN);
      dMix *= 1.0 - sdPatch * ${f(patches * 0.15)};
    `;
    const rubberCode = rubber <= 0 ? '' : /* glsl */`
      if (uRubberXf.z > 0.0) {
        vec2 rUv = (vDetailPos.xz - uRubberXf.xy) * uRubberXf.zw;
        rub = texture2D(uRubber, rUv).r * ${f(rubber)};
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
           * pixel, and past about half a cycle per pixel the band is fading
           * out because nothing else can be done with it honestly.
           */
          float detailResolve(float cyclesPerMetre) {
            float footprintM = max(fwidth(vDetailPos.x), fwidth(vDetailPos.z));
            return 1.0 - smoothstep(0.25, 0.85, footprintM * cyclesPerMetre);
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
          ${aggCode}
          ${seamCode}
          ${patchCode}
          ${rubberCode}
          diffuseColor.rgb *= dMix;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.66, 0.655, 0.70), rub);
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
          roughnessFactor = clamp(
            roughnessFactor + (dFine - 0.5) * uRoughVar * resolveA
              + (1.0 - resolveA) * uRoughVar * 0.5
              - rub * 0.26 + sdPatch * 0.07,
            0.04, 1.0);
        `)
        // Bump last, so it perturbs the normal three.js has already resolved.
        // The projection is planar in XZ, so the map's x and y drive world x
        // and z; on a near-vertical face that is meaningless, which is why
        // walls set the strength to zero.
        .replace('#include <normal_fragment_maps>', /* glsl */`
          #include <normal_fragment_maps>
          if (uNormalStrength > 0.0) {
            vec3 bumpA = texture2D(uGrainNormal, vDetailPos.xz * uScale.x).xyz * 2.0 - 1.0;
            vec3 bump = vec3(bumpA.x, 0.0, bumpA.y) * uNormalStrength * resolveA;
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
              float resolveB = detailResolve(${f((profile.aggregateScale ?? 5.5) * 64)});
              bump += vec3(bumpB.x, 0.0, bumpB.y) * ${f(aggregate * 0.3)} * resolveB;
            `}
            // Rubber fills the surface texture in. Where the band is heaviest
            // the road is visibly smoother, not just darker.
            normal = normalize(normal + bump * (1.0 - rub * 0.65));
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
