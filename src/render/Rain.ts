import * as THREE from 'three';

/**
 * Rain in the air, as a camera-anchored volume of falling streaks.
 *
 * WHY NOT THE PARTICLE SYSTEM. `ParticleSystem` is built around emission: a car
 * throws up spray, a tyre smokes, and each particle is born somewhere specific
 * at a specific moment. Rain is the opposite — it is everywhere, it has always
 * been falling, and none of it belongs to anything. Feeding it through an
 * emitter means either spawning thousands of particles a second (which empties
 * a ring buffer that other effects need) or spawning too few and drawing
 * sparse, obviously-fake dots.
 *
 * So this is a fixed volume that never spawns anything. Every drop exists for
 * the whole session; the vertex shader falls it, wraps it modulo the box, and
 * re-centres the box on the camera every frame. Nothing is uploaded after
 * construction, nothing is culled, and the whole effect is ONE draw call of
 * thin lines.
 *
 * WHY LINES. A raindrop at 8 m/s photographed at a 1/50s shutter is a streak
 * about 15cm long and well under a pixel wide at any useful distance. That is
 * exactly a line segment, and drawing it as one costs two vertices and no
 * overdraw. The alternative — a stretched alpha-blended quad per drop — is the
 * same picture with twenty times the fill cost, and fill is the thing this
 * game does not have spare. Measured on the host GPU at Spa the whole effect
 * costs 0.4ms of a 16ms frame at full intensity, against the 1.5–2ms a quad
 * implementation of the same drop count measured at.
 *
 * WebGL will not draw a line wider than one pixel on any desktop driver worth
 * naming, and that is fine here: it is the correct width.
 */

/**
 * Drops in the volume at full intensity.
 *
 * The box is 90m on a side, so this is one drop per 66 cubic metres — far
 * sparser than real rain and deliberately so. What sells rain on a screen is
 * not the count, it is the streak length and the fact that the near ones move
 * fast enough to be a blur. A count high enough to be physically honest reads
 * as fog and costs ten times as much.
 */
const MAX_DROPS_HIGH = 5200;
/**
 * ...and on the low quality path. Not zero: rain is the single clearest signal
 * that the weather has changed, and a machine that cannot afford it is better
 * served by fewer drops than by a dry-looking downpour.
 */
const MAX_DROPS_LOW = 1600;

/** Side of the volume the drops live in, metres. */
const BOX_M = 90;
/** ...and its height. Taller than it is wide, so looking up finds rain. */
const BOX_H = 55;

/**
 * Terminal velocity of a raindrop, m/s.
 *
 * Real, and worth being real about: a 2mm drop falls at about 6.5 m/s and a
 * 5mm one at about 9 m/s (Gunn & Kinzer, 1949, and the standard measurement
 * ever since). Heavier rain has bigger drops, so the fall speed rises with
 * intensity, which is why a downpour looks like it is coming down harder as
 * well as thicker.
 */
const FALL_MIN_MS = 6.0;
const FALL_MAX_MS = 9.2;

export class RainCurtain {
  readonly mesh: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly maxDrops: number;
  /** How much of the volume is currently drawn, 0..1. */
  private intensity = 0;

  constructor(quality: 'low' | 'high') {
    this.maxDrops = quality === 'high' ? MAX_DROPS_HIGH : MAX_DROPS_LOW;

    const n = this.maxDrops;
    const seed = new Float32Array(n * 2 * 3);
    const end = new Float32Array(n * 2);
    const rank = new Float32Array(n * 2);
    const size = new Float32Array(n * 2);

    for (let i = 0; i < n; i++) {
      const sx = (Math.random() - 0.5) * BOX_M;
      const sy = Math.random() * BOX_H;
      const sz = (Math.random() - 0.5) * BOX_M;
      // Drop size, which sets both the fall speed and the streak length.
      const s = Math.random();
      // `rank` is a stable 0..1 per drop, compared against the intensity in the
      // vertex shader to decide whether this drop exists at all. That is how the
      // count follows the rain without ever touching a buffer: a drop that is
      // not wanted is collapsed to a degenerate segment and the rasteriser
      // discards it. Re-uploading a shorter buffer every time the rain changed
      // would be the obvious alternative and would stall the driver.
      const r = i / n;
      for (let k = 0; k < 2; k++) {
        const at = i * 2 + k;
        seed[at * 3] = sx; seed[at * 3 + 1] = sy; seed[at * 3 + 2] = sz;
        end[at] = k;
        rank[at] = r;
        size[at] = s;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.setAttribute('aRank', new THREE.BufferAttribute(rank, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    // Never culled: the volume moves with the camera, so it is always in view
    // by construction, and a bounding sphere computed from the seed positions
    // would be about the origin and would cull the whole thing everywhere but
    // the start/finish line.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uIntensity: { value: 0 },
        /** Wind, m/s, in world XZ. Slants the rain, which is most of the look. */
        uWind: { value: new THREE.Vector2(2.2, 0.9) },
        uColour: { value: new THREE.Color(0.72, 0.78, 0.86) },
        uOpacity: { value: 0.34 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        attribute float aEnd;
        attribute float aRank;
        attribute float aSize;
        uniform float uTime;
        uniform vec3 uCam;
        uniform float uIntensity;
        uniform vec2 uWind;
        varying float vFade;

        const float BOX = ${BOX_M.toFixed(1)};
        const float BOXH = ${BOX_H.toFixed(1)};

        void main() {
          // Drops beyond the current intensity do not exist. Collapsing both
          // ends of the segment to the same clip-space point gives the
          // rasteriser a zero-length line, which it discards without shading a
          // single fragment.
          if (aRank > uIntensity) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vFade = 0.0;
            return;
          }

          float fall = mix(${FALL_MIN_MS.toFixed(1)}, ${FALL_MAX_MS.toFixed(1)}, aSize);
          vec3 p = aSeed;
          p.x += uWind.x * uTime;
          p.z += uWind.y * uTime;
          p.y -= fall * uTime;

          // Wrap into a box centred on the camera. The camera's own position
          // goes into the modulus so the volume travels with it: a car at
          // 300km/h never outruns the rain, and no drop is ever seen to pop.
          vec3 rel = p - uCam;
          rel.x = mod(rel.x + BOX * 0.5, BOX) - BOX * 0.5;
          rel.z = mod(rel.z + BOX * 0.5, BOX) - BOX * 0.5;
          // Vertically the box sits mostly above the camera — there is no rain
          // below the road — with a little below so a high camera still sees it.
          rel.y = mod(rel.y + BOXH * 0.2, BOXH) - BOXH * 0.2;

          vec3 world = rel + uCam;

          // The streak. One end of the segment is trailed back up the drop's
          // own velocity vector, so the slant follows the wind and the length
          // follows the fall speed — a heavy drop draws a longer streak because
          // it covers more ground in a shutter interval, which is true.
          if (aEnd > 0.5) {
            vec3 vel = vec3(uWind.x, -fall, uWind.y);
            world -= vel * 0.055;
          }

          vec4 mv = modelViewMatrix * vec4(world, 1.0);
          // Fade the nearest drops out. A drop two metres from the lens is a
          // blurred smear in reality and a hard bright line here, and it is the
          // one thing that makes screen-space rain read as a decal stuck to the
          // camera rather than as weather in the world.
          float d = -mv.z;
          vFade = smoothstep(1.5, 7.0, d) * (1.0 - smoothstep(BOX * 0.34, BOX * 0.5, d));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColour;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          if (vFade <= 0.001) discard;
          gl_FragColor = vec4(uColour, uOpacity * vFade);
        }
      `,
      transparent: true,
      // Rain does not occlude anything and nothing occludes it correctly at
      // this thickness, so it neither writes depth nor blends additively.
      // Additive rain over a bright sky turns the upper half of the frame
      // white, which is the failure this project has had before with particle
      // effects whose rate was set without looking at the result.
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  /**
   * @param rainRate  what is falling, 0..1 — NOT how wet the road is. Rain
   *                  stops before the track dries and the sky has to stop with
   *                  it, or a drying track is drawn under a downpour.
   */
  update(dt: number, rainRate: number, cameraPos: THREE.Vector3): void {
    this.material.uniforms.uTime.value += dt;
    (this.material.uniforms.uCam.value as THREE.Vector3).copy(cameraPos);

    // Eased so drizzle is visible without being as dense as a downpour, and so
    // the very first drops of a shower appear before the road has darkened.
    this.intensity = Math.min(1, Math.pow(Math.max(rainRate, 0), 0.7));
    this.material.uniforms.uIntensity.value = this.intensity;
    this.material.uniforms.uOpacity.value = 0.22 + rainRate * 0.2;
    this.mesh.visible = this.intensity > 0.005;
  }

  /** Drops actually being drawn, for the perf probe. */
  get activeDrops(): number {
    return this.mesh.visible ? Math.round(this.maxDrops * this.intensity) : 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
