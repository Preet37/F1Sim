import * as THREE from 'three';

/**
 * The particle layer: tyre smoke, dust, gravel, spray, sparks and exhaust flame.
 *
 * The design decision that matters here is that particles are simulated on the
 * GPU, not the CPU. Each particle stores its spawn state — position, velocity,
 * birth time, lifetime — and the vertex shader evaluates a closed-form
 * trajectory for the current time. Nothing is integrated per frame, so the CPU
 * touches a particle exactly once, when it is born.
 *
 * The alternative, stepping several thousand particles in JavaScript and
 * re-uploading the whole position buffer every frame, is the standard way this
 * is done and it is what turns a smooth 60fps into a stuttering 45 the moment a
 * car locks up in front of you. Here, a lock-up costs a few dozen array writes.
 *
 * The trajectory the shader evaluates is a real one rather than a straight line:
 * velocity decays exponentially under drag, and a constant acceleration term
 * carries gravity for debris and buoyancy for smoke. Both have exact integrals,
 * so this costs a handful of instructions:
 *
 *   p(t) = p0 + v0 * (1 - e^(-kt)) / k + 0.5 * a * t^2
 *
 * Smoke that slows and rises, gravel that arcs and falls, and sparks that shower
 * backwards all come out of the same four lines with different constants.
 */

/** Soft pool: smoke, dust, spray. Alpha blended, sorted-independent. */
const SOFT_CAPACITY = 2400;
/** Bright pool: sparks and flame. Additively blended. */
const BRIGHT_CAPACITY = 900;

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uPixelScale;

  attribute vec3 aVel;
  attribute vec2 aLife;    // x = spawn time, y = lifetime
  attribute vec2 aSize;    // x = size at birth, y = size at death
  attribute vec3 aColor;
  attribute vec4 aMisc;    // x = accel (y axis), y = drag, z = seed, w = peak opacity

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vAge;

  void main() {
    float t = uTime - aLife.x;
    float life = aLife.y;

    // Unborn or expired: collapse to a degenerate point behind the camera so
    // it is culled before rasterisation rather than discarded per-fragment.
    if (life <= 0.0 || t < 0.0 || t > life) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    float u = t / life;

    // Exponential drag has an exact integral; guard the k -> 0 limit where the
    // expression degenerates to plain linear motion.
    float k = max(aMisc.y, 0.0001);
    vec3 travel = aVel * ((1.0 - exp(-k * t)) / k);
    vec3 accel = vec3(0.0, aMisc.x, 0.0) * 0.5 * t * t;
    vec3 world = position + travel + accel;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;

    // Perspective-correct point size, so a puff has a real metre size rather
    // than a fixed pixel size that looks wrong at every distance but one.
    float size = mix(aSize.x, aSize.y, u);
    gl_PointSize = uPixelScale * size / max(-mv.z, 0.1);

    // Fade in fast, out slow. A particle that pops into existence at full
    // opacity reads as a glitch; 12% of its life is enough to hide the birth.
    float fadeIn = smoothstep(0.0, 0.12, u);
    float fadeOut = 1.0 - smoothstep(0.35, 1.0, u);
    vAlpha = fadeIn * fadeOut * aMisc.w;
    vColor = aColor;
    vSeed = aMisc.z;
    vAge = u;
  }
`;

const FRAG_SOFT = /* glsl */`
  precision mediump float;
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vAge;

  void main() {
    if (vAlpha <= 0.001) discard;

    // Rotate the sprite around its centre. Every puff spinning at its own rate
    // is what stops a cloud of identical billboards reading as a repeated
    // stamp, which is the usual tell of a cheap particle system.
    float a = vSeed * 6.2831 + vAge * (vSeed - 0.5) * 2.4;
    float s = sin(a), c = cos(a);
    vec2 uv = gl_PointCoord - 0.5;
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;

    vec4 tex = texture2D(uMap, uv);
    float alpha = tex.a * vAlpha;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(vColor * tex.rgb, alpha);
  }
`;

const FRAG_BRIGHT = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vAge;

  void main() {
    if (vAlpha <= 0.001) discard;
    // Analytic hot core with a soft halo — no texture fetch. A spark is small
    // enough on screen that texture detail is invisible, but the bloom pass
    // downstream is very sensitive to how hot the centre is.
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = pow(1.0 - r, 3.0);
    float halo = pow(1.0 - r, 1.2) * 0.35;
    gl_FragColor = vec4(vColor * (core * 2.2 + halo), (core + halo) * vAlpha);
  }
`;

/**
 * A soft, slightly cloudy sprite.
 *
 * A pure radial gradient looks like an airbrush dot. Multiplying it by a few
 * octaves of value noise gives the puff an irregular edge, and at the sizes
 * smoke is drawn that irregularity is the whole difference between "smoke" and
 * "grey circle".
 */
function makePuffTexture(): THREE.Texture {
  const S = 96;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(S, S);

  // Cheap deterministic value noise: a hash lattice with smooth interpolation.
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const smoothNoise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.hypot(dx, dy) * 2;

      let n = 0;
      let amp = 0.5;
      let freq = 3.5;
      for (let o = 0; o < 4; o++) {
        n += smoothNoise(x / S * freq, y / S * freq) * amp;
        amp *= 0.5;
        freq *= 2.1;
      }

      // Radial falloff eaten into by the noise, so the silhouette is ragged.
      const falloff = Math.max(0, 1 - r);
      const a = Math.pow(falloff, 1.6) * (0.45 + n * 0.9);
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** One pool of identically-blended particles. */
class Pool {
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly colour: Float32Array;
  private readonly misc: Float32Array;

  private cursor = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -Infinity;
  readonly capacity: number;

  constructor(capacity: number, material: THREE.ShaderMaterial) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity * 2);
    this.size = new Float32Array(capacity * 2);
    this.colour = new Float32Array(capacity * 3);
    this.misc = new Float32Array(capacity * 4);

    const geo = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('position', attr(this.pos, 3));
    geo.setAttribute('aVel', attr(this.vel, 3));
    geo.setAttribute('aLife', attr(this.life, 2));
    geo.setAttribute('aSize', attr(this.size, 2));
    geo.setAttribute('aColor', attr(this.colour, 3));
    geo.setAttribute('aMisc', attr(this.misc, 4));
    // The bounding sphere is meaningless for particles the shader moves, and a
    // stale one culls the whole system the moment the camera turns away from
    // the spawn point. Frustum culling is off; the pool is one draw call.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.geometry = geo;
    this.material = material;
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.matrixAutoUpdate = false;
  }

  /**
   * Claims the next slot in the ring and writes a particle into it.
   *
   * Oldest-first replacement: when the pool is full the longest-lived particle
   * is overwritten. Under a sustained lock-up that means the trail has a finite
   * length rather than the emitter silently stopping, which is the right
   * failure — a truncated cloud is far less noticeable than one that vanishes.
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    now: number, life: number,
    size0: number, size1: number,
    r: number, g: number, b: number,
    accelY: number, drag: number,
    opacity: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const i3 = i * 3;
    const i2 = i * 2;
    const i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i2] = now; this.life[i2 + 1] = life;
    this.size[i2] = size0; this.size[i2 + 1] = size1;
    this.colour[i3] = r; this.colour[i3 + 1] = g; this.colour[i3 + 2] = b;
    this.misc[i4] = accelY; this.misc[i4 + 1] = drag;
    this.misc[i4 + 2] = Math.random(); this.misc[i4 + 3] = opacity;

    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  /**
   * Uploads only the slots written since the last flush.
   *
   * Spawns come off a ring cursor so they are contiguous except at the wrap,
   * where this widens to the whole buffer for one frame. Uploading 2400
   * particles once per ring lap is nothing; uploading them every frame is the
   * cost this exists to avoid.
   */
  flush(): void {
    if (this.dirtyMax < this.dirtyMin) return;
    const start = this.dirtyMin;
    const count = this.dirtyMax - this.dirtyMin + 1;
    for (const name of ['position', 'aVel', 'aLife', 'aSize', 'aColor', 'aMisc']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  /** Expires everything immediately, for a session change. */
  clear(): void {
    this.life.fill(0);
    for (const name of ['aLife']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.needsUpdate = true;
    }
    this.cursor = 0;
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class ParticleSystem {
  readonly root = new THREE.Group();

  private readonly soft: Pool;
  private readonly bright: Pool;
  private readonly puff: THREE.Texture;
  private time = 0;

  /** Emission budget scaling, dropped on weak hardware. */
  private readonly density: number;

  constructor(quality: 'low' | 'high') {
    this.density = quality === 'high' ? 1 : 0.45;
    this.puff = makePuffTexture();

    const softMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 300 },
        uMap: { value: this.puff },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_SOFT,
      transparent: true,
      // Depth-tested so smoke is occluded by the car and the barriers, but not
      // depth-written, because thousands of overlapping billboards writing depth
      // produce hard intersection seams against each other.
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    const brightMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 300 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_BRIGHT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.soft = new Pool(Math.round(SOFT_CAPACITY * (quality === 'high' ? 1 : 0.5)), softMat);
    this.bright = new Pool(Math.round(BRIGHT_CAPACITY * (quality === 'high' ? 1 : 0.5)), brightMat);
    this.root.add(this.soft.points, this.bright.points);
    this.root.matrixAutoUpdate = false;
  }

  /**
   * Point size is specified in metres, so it has to be converted to pixels
   * using the projection. Recomputed on resize and on any FOV change, which the
   * camera director makes constantly as speed rises.
   */
  setProjection(fovDeg: number, viewportHeight: number): void {
    const scale = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    (this.soft.material.uniforms.uPixelScale.value as number) = scale;
    (this.bright.material.uniforms.uPixelScale.value as number) = scale;
  }

  advance(dt: number): void {
    this.time += dt;
    this.soft.material.uniforms.uTime.value = this.time;
    this.bright.material.uniforms.uTime.value = this.time;
  }

  /** Uploads this frame's spawns. Called once, after all emitters have run. */
  flush(): void {
    this.soft.flush();
    this.bright.flush();
  }

  clear(): void {
    this.soft.clear();
    this.bright.clear();
  }

  // =========================================================================
  // Emitters
  //
  // Each takes world position, the car's velocity, and an intensity that the
  // caller has already derived from physics state. Emitters own the look; the
  // caller owns when they fire.
  // =========================================================================

  /**
   * Tyre smoke from a sliding or spinning tyre.
   *
   * Given a rearward kick so it is left behind the car, plus buoyancy: hot
   * rubber smoke rises, and smoke that hangs at wheel height instead looks like
   * fog. The lifetime is long — three seconds — because a smoke cloud that
   * evaporates in half a second is the single most common thing that makes a
   * racing game look cheap.
   */
  emitTyreSmoke(
    x: number, y: number, z: number,
    vx: number, vz: number,
    intensity: number, count: number,
  ): void {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const spread = 0.8 + intensity * 1.2;
      // Smoke keeps a fraction of the car's velocity, then bleeds it off.
      const sx = vx * 0.16 + (Math.random() - 0.5) * spread;
      const sz = vz * 0.16 + (Math.random() - 0.5) * spread;
      const sy = 0.35 + Math.random() * 0.6 + intensity * 0.4;
      // Tyre smoke is a mid grey. Pure white reads as steam or fog, and once
      // the tone mapper and bloom have had it, white smoke turns the screen
      // into a blank sheet the moment more than one car is spinning up.
      const grey = 0.34 + Math.random() * 0.16;
      this.soft.spawn(
        x + (Math.random() - 0.5) * 0.3,
        y + 0.1,
        z + (Math.random() - 0.5) * 0.3,
        sx, sy, sz,
        this.time,
        1.1 + Math.random() * 0.9 + intensity * 0.5,
        0.35 + intensity * 0.3, 2.2 + intensity * 1.8,
        grey, grey * 0.99, grey * 0.98,
        0.3, 1.7,
        // Individually faint. Density has to come from many overlapping puffs
        // rather than from each one being opaque, or a single tyre locking
        // paints a solid wall across the camera.
        0.16 + intensity * 0.12,
      );
    }
  }

  /** Dust and grass thrown up by a car that has run wide. */
  emitDust(
    x: number, y: number, z: number,
    vx: number, vz: number,
    surface: 'grass' | 'gravel' | 'runoff',
    intensity: number, count: number,
  ): void {
    const n = Math.round(count * this.density);
    const [r, g, b] =
      surface === 'grass' ? [0.42, 0.44, 0.28]
      : surface === 'gravel' ? [0.66, 0.62, 0.54]
      : [0.55, 0.47, 0.38];

    for (let i = 0; i < n; i++) {
      this.soft.spawn(
        x + (Math.random() - 0.5) * 0.6,
        y + 0.1,
        z + (Math.random() - 0.5) * 0.6,
        -vx * 0.3 + (Math.random() - 0.5) * 3,
        1.2 + Math.random() * 2.4 * intensity,
        -vz * 0.3 + (Math.random() - 0.5) * 3,
        this.time,
        1.1 + Math.random() * 1.2,
        0.6, 3.4 + intensity * 2.5,
        r * (0.8 + Math.random() * 0.4), g * (0.8 + Math.random() * 0.4), b * (0.8 + Math.random() * 0.4),
        -0.6, 1.9,
        0.3 + intensity * 0.25,
      );
    }

    // Gravel throws solid stones as well as dust: heavier, ballistic, no drag.
    if (surface === 'gravel') {
      const stones = Math.round(n * 0.4);
      for (let i = 0; i < stones; i++) {
        this.bright.spawn(
          x, y + 0.15, z,
          -vx * 0.5 + (Math.random() - 0.5) * 8,
          3 + Math.random() * 6,
          -vz * 0.5 + (Math.random() - 0.5) * 8,
          this.time, 0.9 + Math.random() * 0.6,
          0.12, 0.09,
          0.5, 0.45, 0.38,
          -14, 0.05,
          0.9,
        );
      }
    }
  }

  /**
   * The rooster tail off a wet track.
   *
   * Thrown up and backwards, short-lived, and bright rather than grey — spray
   * is water catching the light, not smoke. In a race this is also the reason
   * following a car in the wet is genuinely hard, so it is worth drawing well.
   */
  emitSpray(
    x: number, y: number, z: number,
    vx: number, vz: number,
    speed: number, wetness: number, count: number,
  ): void {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const back = 0.35 + Math.random() * 0.5;
      this.soft.spawn(
        x + (Math.random() - 0.5) * 0.8,
        y + 0.15,
        z + (Math.random() - 0.5) * 0.8,
        -vx * back + (Math.random() - 0.5) * 2,
        1.5 + Math.random() * 3 + speed * 0.03,
        -vz * back + (Math.random() - 0.5) * 2,
        this.time,
        0.8 + Math.random() * 0.9,
        0.7, 3.2 + wetness * 2.5,
        0.82, 0.86, 0.9,
        -1.2, 2.4,
        0.22 + wetness * 0.2,
      );
    }
  }

  /**
   * Sparks from the plank and skid blocks grounding out.
   *
   * Titanium skids at 300 km/h over a compression, which is why sparks appear
   * under braking and at the bottom of dips and not in a slow corner. They are
   * shot backwards and down, bounce is not simulated — at this size and
   * lifetime nobody can tell, and the additive core lighting up the bloom pass
   * is the entire point of the effect.
   */
  emitSparks(
    x: number, y: number, z: number,
    vx: number, vz: number,
    intensity: number, count: number,
  ): void {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const spread = 2.5 + intensity * 4;
      this.bright.spawn(
        x + (Math.random() - 0.5) * 0.5,
        y + 0.05,
        z + (Math.random() - 0.5) * 0.5,
        -vx * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * spread,
        1 + Math.random() * 3,
        -vz * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * spread,
        this.time,
        0.28 + Math.random() * 0.42,
        0.1, 0.02,
        // Cooling from white-hot through orange as they fly.
        1.0, 0.55 + Math.random() * 0.3, 0.16,
        -9, 0.6,
        1.0,
      );
    }
  }

  /** Exhaust flame on a downshift or the overrun. */
  emitFlame(x: number, y: number, z: number, vx: number, vz: number, intensity: number): void {
    const n = Math.round(6 * intensity * this.density);
    for (let i = 0; i < n; i++) {
      this.bright.spawn(
        x, y, z,
        -vx * 0.1 + (Math.random() - 0.5) * 1.2,
        0.4 + Math.random() * 0.8,
        -vz * 0.1 + (Math.random() - 0.5) * 1.2,
        this.time, 0.14 + Math.random() * 0.12,
        0.28, 0.05,
        1.0, 0.42, 0.1,
        1.5, 3,
        1.0,
      );
    }
  }

  /** Debris burst from contact. */
  emitImpact(x: number, y: number, z: number, severity: number): void {
    const n = Math.round(26 * severity * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 12 * severity;
      this.bright.spawn(
        x, y + 0.3, z,
        Math.cos(a) * sp, 2 + Math.random() * 7, Math.sin(a) * sp,
        this.time, 0.5 + Math.random() * 0.7,
        0.13, 0.04,
        1.0, 0.7, 0.35,
        -12, 0.35,
        1.0,
      );
    }
    // Carbon dust hanging in the air after the hit.
    for (let i = 0; i < Math.round(10 * severity * this.density); i++) {
      this.soft.spawn(
        x, y + 0.4, z,
        (Math.random() - 0.5) * 5, 1 + Math.random() * 2, (Math.random() - 0.5) * 5,
        this.time, 1.4 + Math.random(),
        0.5, 3.2,
        0.22, 0.22, 0.24,
        0.1, 1.8,
        0.5,
      );
    }
  }

  dispose(): void {
    this.soft.dispose();
    this.bright.dispose();
    this.puff.dispose();
  }
}
