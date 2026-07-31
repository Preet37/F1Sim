import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils';
import { buildCar, disposeCarGeometryCache, type CarVisual } from './CarMesh';
import { buildTrackMeshes, type TrackMeshes } from './TrackMesh';
import { buildPaddock, type PaddockScene } from './Paddock';
import { CameraDirector } from './CameraDirector';
import { EffectsDirector } from './EffectsDirector';
import { EnvProbe } from './EnvProbe';
import { PostFX } from './PostFX';
import { RacingLine } from './RacingLine';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';

/**
 * The render layer. Reads simulation state and draws it; the simulation has no
 * knowledge of this file.
 *
 * Two things matter more than visual fidelity here:
 *
 *  1. DYNAMIC RESOLUTION. An iPhone will happily render this at a device pixel
 *     ratio of 3, cook itself, and drop to 40fps within a minute. The renderer
 *     measures its own frame rate and scales the drawing buffer to hold 60,
 *     preferring a slightly softer image at a stable frame rate over a sharp one
 *     that stutters. A racing game is unplayable below about 50fps.
 *
 *  2. NO PER-FRAME ALLOCATION. Vectors, colours and matrices are hoisted. The
 *     render loop runs at display rate on top of a 120Hz physics loop, and garbage
 *     collection pauses show up as stutter exactly when the car is at the limit.
 */

/**
 * Tone-mapping exposure, by time of day.
 *
 * These are well above 1, and that is a correction rather than a taste
 * decision. Work the numbers through for a piece of dry asphalt: albedo about
 * 0.07 in linear light, total irradiance from the rig about 3, and the Lambert
 * BRDF divides by pi — so the surface leaves the shader at roughly 0.07 linear,
 * ACES pulls that to about 0.08, and sRGB encoding lands it near 0.3 of full
 * scale. Reference footage of a real circuit, day or night, has its road
 * sitting closer to 0.45. Every surface in the scene was therefore arriving
 * about a stop and a half dark, which reads as a dull, muddy image that no
 * amount of material work fixes — the materials were right and the print was
 * under-exposed.
 *
 * Raising exposure rather than every light's intensity is deliberate: ACES
 * compresses the top end, so the highlights that were already correct roll off
 * instead of clipping, and the correction lands where it is needed, in the
 * midtones.
 */
const EXPOSURE = { day: 1.55, dusk: 1.5, night: 1.7 };

/** Target frame rate. Below this, resolution scales down. */
const TARGET_FPS = 60;
/** Never scale below this fraction of native resolution. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.0;

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Force a quality tier, or leave undefined to detect. */
  quality?: 'low' | 'high';
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly director: CameraDirector;
  readonly effects: EffectsDirector;
  readonly post: PostFX;
  /** Racing-line overlay, or null outside a session. */
  racingLine: RacingLine | null = null;

  /** Current resolution scale, 0.5 .. 1.0. */
  resolutionScale = 1;
  /** Detected quality tier. */
  readonly quality: 'low' | 'high';

  /** Smoothed frame rate, exposed for the HUD's diagnostics. */
  fps = 60;

  private trackMeshes: TrackMeshes | null = null;
  private paddock: PaddockScene | null = null;
  private carVisuals: CarVisual[] = [];
  private readonly canvas: HTMLCanvasElement;

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /**
   * A dim, cool light from behind and opposite the sun.
   *
   * A single key light leaves every surface facing away from it at exactly the
   * ambient term, which is a flat colour — so half of every curved panel on the
   * car is a dead area with no shading information in it at all. A fill at a
   * fifth of the key's intensity from the opposite quarter gives that half a
   * gradient, and a gradient is what the eye reads as form. It costs nothing:
   * it casts no shadow.
   */
  private fill: THREE.DirectionalLight;
  /**
   * A rim light, low and behind the camera's usual position, that separates the
   * car's upper edges from the background. This is the light that draws the
   * bright line along the top of the halo and the roll hoop in the reference
   * footage, and without it a dark car at night is a silhouette.
   */
  private rim: THREE.DirectionalLight;
  private sky: THREE.Mesh | null = null;
  private envProbe: EnvProbe;
  private ambience: 'day' | 'dusk' | 'night' = 'day';

  // Frame-time tracking for the resolution scaler.
  private frameAccum = 0;
  private frameCount = 0;
  private scaleCooldown = 0;

  // Hoisted scratch.
  private readonly tmpColour = new THREE.Color();
  private wheelSpin = 0;

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas;

    // Detect a low-power device. A hard device check is unreliable, so this uses
    // the two signals that actually correlate: core count and whether the browser
    // reports a touch-primary device.
    const cores = navigator.hardwareConcurrency ?? 4;
    const touchPrimary = matchMedia('(pointer: coarse)').matches;
    this.quality = opts.quality ?? (touchPrimary || cores <= 4 ? 'low' : 'high');

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: this.quality === 'high',
      powerPreference: 'high-performance',
      // The depth buffer is all we need; no stencil work here.
      stencil: false,
      alpha: false,
    });
    this.renderer.setClearColor(0x0a0c10, 1);

    // Colour pipeline. Rendering in linear light and tone-mapping to sRGB at the
    // end is what gives highlights roll-off instead of clipping to flat white,
    // and it is most of the difference between "programmer render" and something
    // that looks photographed. Without it, a metallic livery under a bright sun
    // just goes to pure white.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // See `applyAmbience` for why this is not 1.
    this.renderer.toneMappingExposure = EXPOSURE.day;

    // Real shadows on capable hardware; the cars also carry a cheap contact
    // shadow so they stay grounded when this is off.
    this.renderer.shadowMap.enabled = this.quality === 'high';
    // PCF, not PCFSoft: three deprecated the latter and silently substitutes
    // this one anyway, which meant the `shadow.radius` set below was being
    // applied to a mode that had already been swapped out from under it. Asking
    // for what actually runs makes the penumbra width mean something.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.director = new CameraDirector(this.aspect);

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2a24, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.sun.position.set(-220, 400, 180);
    if (this.quality === 'high') {
      this.sun.castShadow = true;
      // A tight shadow frustum that follows the car. Trying to cover a whole 7km
      // circuit with one shadow map gives about one texel per metre, which is
      // worse than no shadow at all.
      //
      // 2048 over a 44m box is roughly 21 texels per metre, which is what it
      // takes for a wishbone — a 22mm tube — to cast anything other than a
      // dotted line. At the old 1024 over 68m the entire suspension, the halo
      // and the wing elements were below the sampling limit and simply did not
      // cast, which is a large part of why the car did not sit on the road.
      this.sun.shadow.mapSize.set(2048, 2048);
      const c = this.sun.shadow.camera;
      c.near = 1;
      c.far = 200;
      c.left = -22;
      c.right = 22;
      c.top = 22;
      c.bottom = -22;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.018;
      // PCF samples a fixed kernel; the radius widens it into a penumbra rather
      // than a hard stencil edge.
      this.sun.shadow.radius = 2.6;
      this.scene.add(this.sun.target);
    }
    this.scene.add(this.sun);

    this.fill = new THREE.DirectionalLight(0xbcd2f2, 0.55);
    this.fill.position.set(240, 160, -220);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xdfe8ff, 0.9);
    this.rim.position.set(60, 40, -320);
    this.scene.add(this.rim);

    this.buildSky();
    this.envProbe = new EnvProbe(this.renderer);
    this.envProbe.apply(this.scene, 'day', 0);

    this.effects = new EffectsDirector(this.quality);
    this.scene.add(this.effects.root);

    // Capture the scene's real cost the instant it finishes drawing.
    //
    // `renderer.info.render` resets at the start of every render call, and the
    // composer issues one per pass. Reading the counters after the frame is
    // done would therefore describe the last fullscreen quad — a constant "1
    // draw call, 2 triangles" regardless of what is on screen. This hook fires
    // only for the scene itself, because the post passes render a different
    // scene of their own.
    this.scene.onAfterRender = () => {
      this.sceneDrawCalls = this.renderer.info.render.calls;
      this.sceneTriangles = this.renderer.info.render.triangles;
    };

    this.post = new PostFX(this.renderer, this.scene, this.director.camera, this.quality);

    this.applySize();
  }

  /** True when the frame goes through the post chain rather than straight out. */
  get postEnabled(): boolean {
    return this.post.enabled;
  }

  /**
   * Gradient sky dome.
   *
   * A flat clear colour puts a hard seam where the ground ends and reads as a
   * void. A vertical gradient with a warmer band near the horizon costs one
   * shader and two triangles' worth of thought, and it is the difference between
   * looking outdoors and looking at a background fill.
   */
  private buildSky(): void {
    const geo = new THREE.SphereGeometry(3600, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x1f5cbe) },
        midColor: { value: new THREE.Color(0x6fa8e2) },
        bottomColor: { value: new THREE.Color(0xc0d6ea) },
        cloudColor: { value: new THREE.Color(0xeef3fa) },
        cloudShadow: { value: new THREE.Color(0x6a7488) },
        sunColor: { value: new THREE.Color(0xfff0d0) },
        sunDir: { value: new THREE.Vector3(-0.45, 0.62, 0.36).normalize() },
        cloudAmount: { value: 0.5 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        uniform vec3 cloudColor;
        uniform vec3 cloudShadow;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        uniform float cloudAmount;
        uniform float uTime;
        varying vec3 vWorld;

        // Value noise on a 3D lattice. Cheap, and the sky is drawn once per
        // frame over a few thousand pixels, so the cost is irrelevant next to
        // what a flat gradient costs in believability.
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float noise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                         mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                         mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        // Five octaves of fractional Brownian motion. The billowing, self-similar
        // structure of real cloud comes from exactly this: each octave is half
        // the amplitude at roughly twice the frequency.
        float fbm(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 5; i++) {
            v += a * noise(p);
            p *= 2.02;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorld);
          float h = dir.y;

          // --- Base sky -------------------------------------------------
          float t = pow(max(h, 0.0), 0.9);
          vec3 sky = mix(bottomColor, midColor, smoothstep(0.0, 0.28, t));
          sky = mix(sky, topColor, smoothstep(0.22, 1.0, t));

          // --- Sun ------------------------------------------------------
          // A disc plus a wide forward-scattering halo. The halo is what makes
          // the sky near the sun read as bright *air* rather than as a sticker
          // of a sun pasted onto a flat gradient.
          float sd = max(dot(dir, normalize(sunDir)), 0.0);
          float disc = smoothstep(0.9985, 0.9995, sd);
          float halo = pow(sd, 12.0) * 0.35 + pow(sd, 3.0) * 0.13;
          sky += sunColor * halo;

          // --- Clouds ---------------------------------------------------
          // Projected onto a flat plane above the viewer rather than onto the
          // sphere. Cloud decks are flat, so the projection is what produces
          // the foreshortening that makes them stretch and compress toward the
          // horizon — the single strongest cue that they are a layer at
          // altitude and not a texture on a dome.
          float cloud = 0.0;
          if (h > 0.002) {
            // The divisor is clamped well above zero. Left unclamped, the
            // projection blows up toward the horizon — at h = 0.005 it is a 200x
            // magnification — and the cloud field collapses into high-frequency
            // mush that aliases into flat grey. Clamping keeps the foreshortening
            // that sells the altitude while bounding the frequency.
            vec2 proj = dir.xz / max(h, 0.11);
            vec3 p = vec3(proj * 0.5, uTime * 0.006);
            float base = fbm(p);
            // Warping the domain by another noise field breaks up the regular
            // lumpiness of plain fbm into wispy, sheared forms.
            float warped = fbm(p + vec3(base * 0.85, base * 0.6, 0.0));

            // cloudAmount slides the coverage threshold, so the same field can
            // give a clear day or heavy overcast.
            // The threshold and, just as importantly, its WIDTH are sized to
            // the field's actual distribution: warped fbm here has a median
            // near 0.47 and sits between roughly 0.34 and 0.56 for half its
            // samples. A ramp wider than that spread never saturates, so every
            // pixel gets a couple of percent of cloud and the sky reads as
            // uniformly empty — which is exactly what the first version did.
            float cover = mix(0.52, 0.34, cloudAmount);
            cloud = smoothstep(cover, cover + 0.11, warped);
            // Thin the deck right at the horizon, where distant cloud is lost in
            // haze. Kept narrow: a chase camera looks along the ground, so the
            // visible sky is a shallow band just above the horizon and fading
            // over a wide angle here erases every cloud the player can actually
            // see.
            cloud *= smoothstep(0.0, 0.05, h);

            // Shade by the local density gradient toward the sun, so tops are
            // lit and undersides are grey. Two samples, which is all that is
            // needed to imply a light direction.
            float lit = fbm(p + normalize(vec3(sunDir.xz, 0.0)) * 0.16);
            float shade = clamp((warped - lit) * 3.4 + 0.46, 0.0, 1.0);
            vec3 body = mix(cloudShadow, cloudColor, shade);
            // Silver lining: cloud edges near the sun glow.
            body += sunColor * pow(sd, 6.0) * 0.5 * (1.0 - shade);
            sky = mix(sky, body, cloud * 0.92);
          }

          // The sun disc itself draws over everything except thick cloud.
          sky += sunColor * disc * (1.0 - cloud) * 6.0;

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    // Drawn first, with depth test off, so it never fights the scene.
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  private get aspect(): number {
    return this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
  }

  /**
   * Loads a session: builds the circuit and one visual per car.
   * Safe to call repeatedly; the previous session's resources are released.
   */
  loadSession(engine: RaceEngine): void {
    this.unloadSession();

    // The set-dressing layout comes from the engine, not from the renderer:
    // these are the objects the simulation collides against, and the only way
    // for what you can see and what you can hit to be the same thing is for
    // both to read the same list.
    this.trackMeshes = buildTrackMeshes(engine.track, this.quality, engine.world);
    this.scene.add(this.trackMeshes.root);

    // The pit garages, the paddock behind them and the main grandstand. Built
    // separately from the circuit because it is architecture rather than track
    // surface, and because every session that is not a race start opens looking
    // straight at it.
    this.paddock = buildPaddock(engine.track, this.quality);
    this.scene.add(this.paddock.root);

    for (const car of engine.cars) {
      // The race number and the driver's code are painted into the livery
      // texture, so they have to be known when the car is built.
      //
      // Only the player's car carries the cockpit interior: it is the only one
      // the cockpit camera can ever be inside, and twenty steering wheels and
      // twenty pairs of gloves nobody will see is not a good trade.
      const visual = buildCar(car.team.colour, car.team.accent, {
        number: car.driver.raceNumber,
        code: car.driver.code,
        quality: this.quality,
        withCockpit: car.isPlayer,
        compound: car.compound,
      });
      this.scene.add(visual.root);
      this.carVisuals.push(visual);
    }

    this.racingLine = new RacingLine(engine.track);
    this.racingLine.setVisible(this.racingLineVisible);
    this.scene.add(this.racingLine.mesh);

    this.effects.loadSession(engine);
    this.applyAmbience(engine);
    this.director.setMode(this.director.mode);
    this.post.setCamera(this.director.camera, this.scene);
  }

  /** How much extra bloom this circuit's lighting wants, 0..1. */
  private nightBias = 0;

  /** Sky, fog and light for the circuit's time of day and weather. */
  private applyAmbience(engine: RaceEngine): void {
    const def = engine.track.def;
    const night = def.ambience === 'night';
    const dusk = def.ambience === 'dusk';

    const skyMat = this.sky?.material as THREE.ShaderMaterial | undefined;
    const setSky = (top: number, mid: number, bottom: number) => {
      if (!skyMat) return;
      (skyMat.uniforms.topColor.value as THREE.Color).setHex(top);
      (skyMat.uniforms.midColor.value as THREE.Color).setHex(mid);
      (skyMat.uniforms.bottomColor.value as THREE.Color).setHex(bottom);
    };
    /** Cloud deck colour, coverage, and where the sun sits in the sky. */
    const setClouds = (lit: number, shadow: number, sun: number, amount: number) => {
      if (!skyMat) return;
      (skyMat.uniforms.cloudColor.value as THREE.Color).setHex(lit);
      (skyMat.uniforms.cloudShadow.value as THREE.Color).setHex(shadow);
      (skyMat.uniforms.sunColor.value as THREE.Color).setHex(sun);
      skyMat.uniforms.cloudAmount.value = amount;
    };

    // At night and at dusk the bright things in frame are lights rather than
    // sunlit surfaces, so the bloom is doing most of the atmospheric work and
    // is worth pushing well past its daytime setting.
    this.nightBias = night ? 1 : dusk ? 0.45 : 0;

    let fogColour: number;
    // Cloud cover follows the weather, so a wet race is genuinely overcast
    // rather than raining out of a clear blue sky.
    const overcast = clamp01(0.35 + engine.weather.wetness * 0.6);

    if (night) {
      setSky(0x02040a, 0x0a1020, 0x1a2233);
      setClouds(0x2a3348, 0x0b1018, 0x9fb4d8, overcast * 0.8);
      fogColour = 0x0d1420;
      // Floodlights, not moonlight. A circuit under lights is genuinely BRIGHT
      // at track level — the reference footage has asphalt sitting at a solid
      // mid grey — and it is the sky that is black, not the road. The previous
      // settings lit the whole scene at a third of daylight and produced a
      // uniformly murky image in which nothing had a highlight.
      // The dominant term at night, by a long way.
      //
      // A floodlit circuit is not a dark place. Every reference frame has the
      // asphalt sitting at a comfortable mid grey with plenty of legible detail
      // in it, and only the SKY is black — which is the opposite of the
      // intuition that "night" means "turn everything down". Two hundred lamps
      // on masts produce a large, nearly uniform irradiance from above, and
      // that is a hemisphere light, not a key. The ground colour is lifted well
      // off black too, because the road bounces a great deal of that light back
      // up into the underside of the cars.
      this.hemi.color.setHex(0x6d7c96);
      this.hemi.groundColor.setHex(0x2a2b30);
      this.hemi.intensity = 1.85;
      // A floodlit circuit is lit by two hundred lamps from every direction at
      // once, so the DIRECTIONAL component of it is weak. It is the ambient
      // and the probe that carry the night, not a key light — and the probe is
      // the right place for it, because a ring of fourteen sources puts a
      // string of small highlights along a flank where a single directional
      // light can only put one. Left at daylight intensity this light mirrored
      // off the asphalt into one enormous glint that the bloom pass then
      // spread over the whole frame; the onboard shot went white from the road
      // alone. Kept low, it survives only as the shadow caster.
      this.sun.color.setHex(0xfff4de);
      this.sun.intensity = 0.75;
      this.sun.position.set(60, 300, 40);
      this.fill.color.setHex(0xa8bcdc);
      this.fill.intensity = 0.55;
      this.rim.color.setHex(0xfff0d4);
      this.rim.intensity = 0.85;
      this.renderer.toneMappingExposure = EXPOSURE.night;
    } else if (dusk) {
      setSky(0x1e2a55, 0x9a5c72, 0xf0a070);
      // The reference look: a low sun under-lighting a heavy deck, so the cloud
      // bases go pink and the sky behind them stays deep blue.
      setClouds(0xffc9a4, 0x6b4a63, 0xffb070, clamp01(overcast + 0.25));
      fogColour = 0xc08a6a;
      this.hemi.color.setHex(0xffb98a);
      this.hemi.groundColor.setHex(0x2a1e22);
      this.hemi.intensity = 0.6;
      this.sun.color.setHex(0xffa04c);
      this.sun.intensity = 2.0;
      this.sun.position.set(-500, 70, 120);
      this.fill.color.setHex(0x7c92d0);
      this.fill.intensity = 0.42;
      this.rim.color.setHex(0xffd0a0);
      this.rim.intensity = 1.1;
      this.renderer.toneMappingExposure = EXPOSURE.dusk;
    } else {
      setSky(0x1f5cbe, 0x6fa8e2, 0xc0d6ea);
      // Cloud white is deliberately below pure: at 1.0 it clears the bloom
      // pass's threshold and every cloud blooms into the sky around it, which
      // is what turned the first version into uniform haze.
      setClouds(0xeef3fa, 0x6e788c, 0xfff0d0, overcast);
      fogColour = 0xc6d8e8;
      this.hemi.color.setHex(0xcfe0ff);
      this.hemi.groundColor.setHex(0x3a3a30);
      this.hemi.intensity = 0.75;
      this.sun.color.setHex(0xfff4e2);
      this.sun.intensity = 2.6;
      this.sun.position.set(-220, 400, 180);
      this.fill.color.setHex(0xbcd2f2);
      this.fill.intensity = 0.55;
      this.rim.color.setHex(0xdfe8ff);
      this.rim.intensity = 0.9;
      this.renderer.toneMappingExposure = EXPOSURE.day;
    }

    // The probe has to agree with the light rig, or the reflection on a flank
    // says "midday" while the shading on it says "dusk" and the car reads as a
    // cut-out. Rebuilt only when the ambience or the weather actually changes.
    this.ambience = night ? 'night' : dusk ? 'dusk' : 'day';
    this.envProbe.apply(this.scene, this.ambience, engine.weather.wetness);
    // Point the shader's sun at the same place as the light, so the halo, the
    // silver lining on the cloud edges and the shadows on the track all agree.
    if (skyMat) {
      (skyMat.uniforms.sunDir.value as THREE.Vector3)
        .copy(this.sun.position).normalize();
    }

    this.scene.background = null; // the sky dome is the background now

    // Fog matched to the horizon colour so distance fades into the sky rather
    // than into a differently-coloured haze.
    //
    // EXPONENTIAL, not linear. Linear fog is zero everywhere nearer than its
    // near plane and then ramps, and on a flat road that discontinuity is a
    // perfectly straight horizontal line drawn across the image at whatever
    // depth the near plane sits — which is exactly what it was doing, a hard
    // tonal step across the track a few hundred metres ahead of the car in
    // every chase and onboard shot. Exponential-squared fog has no onset at
    // all: it is smooth from the camera outwards, which is also how air
    // actually behaves.
    const wet = engine.weather.wetness;
    const far = 1700 - wet * 900;
    // Chosen so the fog is most of the way to opaque at `far`, matching what
    // the linear version's far plane used to mean.
    this.scene.fog = new THREE.FogExp2(fogColour, 1.9 / far);
  }

  /** Player preference, kept across sessions. */
  private racingLineVisible = true;

  setRacingLineVisible(on: boolean): void {
    this.racingLineVisible = on;
    this.racingLine?.setVisible(on);
  }

  unloadSession(): void {
    if (this.racingLine) {
      this.scene.remove(this.racingLine.mesh);
      this.racingLine.dispose();
      this.racingLine = null;
    }
    this.effects?.unload();
    if (this.trackMeshes) {
      this.scene.remove(this.trackMeshes.root);
      this.trackMeshes.dispose();
      this.trackMeshes = null;
    }
    if (this.paddock) {
      this.scene.remove(this.paddock.root);
      this.paddock.dispose();
      this.paddock = null;
    }
    for (const v of this.carVisuals) {
      this.scene.remove(v.root);
      v.dispose();
    }
    this.carVisuals.length = 0;
  }

  /** Handles a viewport change. */
  resize(): void {
    this.applySize();
    this.director.setAspect(this.aspect);
  }

  private applySize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // Cap the device pixel ratio before the dynamic scaler even starts. A phone
    // reporting DPR 3 is asking for nine times the pixels of DPR 1 for a
    // difference almost nobody can see on a moving image.
    const dprCap = this.quality === 'low' ? 2 : 2.5;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.setPixelRatio(dpr * this.resolutionScale);
    this.renderer.setSize(w, h, false);

    // The composer's targets are sized in device pixels, and it does not read
    // the renderer's pixel ratio for us. Missing this leaves post-processing
    // rendering at the wrong resolution every time the dynamic scaler moves,
    // which shows up as the image softening and never sharpening back.
    const buffer = this.renderer.getDrawingBufferSize(this.tmpSize);
    this.post?.setSize(buffer.x, buffer.y);
    this.effects?.setProjection(this.director.camera.fov, buffer.y);
  }

  private readonly tmpSize = new THREE.Vector2();

  /**
   * Adjusts resolution to hold the target frame rate.
   *
   * Deliberately asymmetric and slow to react: scaling down happens readily,
   * scaling back up happens grudgingly and only once there is real headroom.
   * A scaler that reacts symmetrically oscillates, and a resolution that visibly
   * pulses is worse than one that is simply a bit low.
   */
  private updateResolutionScale(dt: number): void {
    this.frameAccum += dt;
    this.frameCount++;
    this.scaleCooldown -= dt;

    if (this.frameAccum < 0.5) return;

    this.fps = this.frameCount / this.frameAccum;
    this.frameAccum = 0;
    this.frameCount = 0;

    if (this.scaleCooldown > 0) return;

    const before = this.resolutionScale;
    if (this.fps < TARGET_FPS - 1) {
      // Drop harder the further behind we are.
      const deficit = clamp01((TARGET_FPS - this.fps) / 25);
      this.resolutionScale = clamp(this.resolutionScale - 0.08 - deficit * 0.12, MIN_SCALE, MAX_SCALE);
      this.scaleCooldown = 0.8;
    } else if (this.fps > TARGET_FPS + 8 && this.resolutionScale < MAX_SCALE) {
      this.resolutionScale = clamp(this.resolutionScale + 0.05, MIN_SCALE, MAX_SCALE);
      this.scaleCooldown = 2.5;
    }

    if (this.resolutionScale !== before) this.applySize();
  }

  /**
   * Draws one frame.
   * @param dt real frame time in seconds
   * @param alpha interpolation fraction between physics steps (unused for now;
   *              the physics runs at 120Hz, comfortably above display rate)
   */
  render(dt: number, engine: RaceEngine, focusCar: CarEntry): void {
    this.updateResolutionScale(dt);
    this.syncCars(dt, engine, focusCar);
    this.director.update(dt, focusCar, engine.track);

    const cam = this.director.camera;

    // Drift the cloud deck. Slow enough that it never reads as motion during a
    // lap, fast enough that a stationary car on the grid is not sitting under a
    // frozen photograph.
    const skyMat = this.sky?.material as THREE.ShaderMaterial | undefined;
    if (skyMat) skyMat.uniforms.uTime.value += dt;

    // Particles are sized in metres, so the metres-to-pixels conversion has to
    // track the camera's FOV — which the director widens continuously with
    // speed. Without this, smoke visibly changes size as the car accelerates.
    const buffer = this.renderer.getDrawingBufferSize(this.tmpSize);
    this.effects.setProjection(cam.fov, buffer.y);
    this.effects.update(dt, engine, cam.position);

    // Driven from the focused car, so a spectator camera still shows the line
    // relevant to whoever is being watched.
    this.racingLine?.update(focusCar.s, focusCar.physics.speedMs);

    // The radial blur converges on the point the car is heading for, not the
    // centre of the screen. In a corner the vanishing point swings wide, and
    // anchoring the streaks to it is the difference between the blur feeling
    // like motion and feeling like a filter.
    this.projectFocus(focusCar, cam);
    this.post.update(
      dt, focusCar.physics.speedMs, this.focusUv.x, this.focusUv.y, this.nightBias, cam,
    );
    // Keep the sky centred on the camera so it never clips or parallaxes.
    if (this.sky) this.sky.position.copy(cam.position);

    // Move the shadow frustum with the car; a fixed one covering the circuit
    // would have roughly one texel per metre.
    if (this.sun.castShadow) {
      const y = engine.track.elevationAt(focusCar.s);
      this.sun.target.position.set(focusCar.physics.position.x, y, focusCar.physics.position.y);
      this.sun.position.set(
        focusCar.physics.position.x - 60,
        y + 110,
        focusCar.physics.position.y + 48,
      );
    }

    this.post.render(this.scene, cam);

  }

  private sceneDrawCalls = 0;
  private sceneTriangles = 0;

  /**
   * Projects a point well ahead of the car into screen space, clamped near the
   * centre so a hairpin cannot fling the blur origin off-screen and smear the
   * entire frame in one direction.
   */
  private projectFocus(car: CarEntry, cam: THREE.PerspectiveCamera): void {
    const p = car.physics;
    this.tmpVec.set(
      p.position.x + Math.sin(p.heading) * 60,
      1.2,
      p.position.y + Math.cos(p.heading) * 60,
    );
    this.tmpVec.project(cam);
    // NDC to the pass's UV space. No y flip: a render target's v axis points the
    // same way as NDC y, unlike DOM coordinates.
    this.focusUv.set(
      clamp(this.tmpVec.x * 0.5 + 0.5, 0.22, 0.78),
      clamp(this.tmpVec.y * 0.5 + 0.5, 0.25, 0.75),
    );
  }

  private readonly tmpVec = new THREE.Vector3();
  private readonly focusUv = new THREE.Vector2(0.5, 0.5);

  /** A full-screen flash — start lights going out, a heavy impact. */
  flash(strength: number, decayPerSecond: number, colour: THREE.ColorRepresentation): void {
    this.post.triggerFlash(strength, decayPerSecond, colour);
  }

  /** Copies simulation state onto the visuals. */
  private syncCars(dt: number, engine: RaceEngine, focusCar: CarEntry): void {
    const track = engine.track;
    const cockpitView = this.director.mode === 'cockpit';
    // One shared wheel-spin phase: individual wheel speeds are indistinguishable
    // at speed and this avoids twenty separate integrations.
    this.wheelSpin += dt;

    for (let i = 0; i < engine.cars.length; i++) {
      const car = engine.cars[i];
      const v = this.carVisuals[i];
      if (!v) continue;

      // A retired car stays where it stopped; hide it once recovered.
      if (car.retired && car.recovered) {
        v.root.visible = false;
        continue;
      }
      v.root.visible = true;

      // The cockpit camera sits inside the driver's helmet, and the detailed
      // cockpit wheel is drawn on top of the coarse one. Both live in the same
      // mesh, so one flag deals with both — for that one car only, because
      // every other driver on track should still have a head.
      const inside = cockpitView && car === focusCar;
      v.driverHead.visible = !inside;

      const p = car.physics;
      const y = track.elevationAt(car.s);
      v.root.position.set(p.position.x, y, p.position.y);
      v.root.rotation.y = p.heading;

      // Body roll and pitch from the actual accelerations, which is what makes
      // the car look loaded up rather than sliding around on rails.
      const roll = clamp(-p.lateralG * 0.016, -0.06, 0.06);
      const pitch = clamp(p.longitudinalG * 0.012, -0.05, 0.05);
      v.root.rotation.z = damp(v.root.rotation.z, roll, 8, dt);
      v.root.rotation.x = damp(v.root.rotation.x, pitch, 8, dt);

      // Wheels: spin on the inner group, steer on the outer one.
      //
      // These must be separate objects. Putting spin (X) and steer (Y) on the
      // same Euler means that once a wheel has rotated, the steering axis is no
      // longer vertical, so the front wheels tilt and wobble rather than turning.
      const spin = (p.speedMs / 0.36) * dt;
      v.frontLeftSpin.rotation.x -= spin;
      v.frontRightSpin.rotation.x -= spin;
      v.rearLeftSpin.rotation.x -= spin;
      v.rearRightSpin.rotation.x -= spin;

      const steer = car.appliedControls.steer * p.spec.maxSteerRad;
      v.frontLeftSteer.rotation.y = -steer;
      v.frontRightSteer.rotation.y = -steer;

      // Cockpit interior: shown only for the car the cockpit camera is inside,
      // so it can never appear floating in a chase or trackside shot.
      if (v.cockpit) {
        v.setCockpitVisible(inside);
        if (inside) {
          v.cockpit.update({
            steerRad: steer,
            gearLabel: p.inReverse ? 'R'
              : p.speedMs < 0.6 && car.appliedControls.throttle < 0.02 ? 'N'
              : String(p.gear),
            speedKph: p.speedKph,
            rpmFraction: p.rpmFraction,
            drsOpen: p.drsOpen,
            ersPercent: p.ersChargePercent,
          });
        }
      }

      // Tyres. Cheap to check every frame — `setCompound` returns immediately
      // when the material is already the right one — and it means a pit stop
      // changes the sidewall colour the instant the sim says it has.
      v.setCompound(car.compound);

      // DRS flap: open is roughly 50 degrees.
      const flapTarget = p.drsOpen ? -0.85 : 0;
      v.drsFlap.rotation.x = damp(v.drsFlap.rotation.x, flapTarget, 14, dt);

      // Brake glow from braking effort. Cheap and reads brilliantly at night.
      const heat = clamp01(car.appliedControls.brake * clamp01(p.speedMs / 45));
      this.tmpColour.setRGB(0.10 + heat * 1.5, 0.055 + heat * 0.22, 0.045);
      for (const disc of v.brakeGlow) {
        (disc.material as THREE.MeshBasicMaterial).color.copy(this.tmpColour);
      }
    }
  }

  /** Frees everything. */
  dispose(): void {
    this.unloadSession();
    this.effects.dispose();
    this.post.dispose();
    disposeCarGeometryCache();
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.sky = null;
    }
    this.envProbe.dispose();
    this.renderer.dispose();
  }

  /** Triangles in the scene last frame, for the diagnostics overlay. */
  get triangleCount(): number {
    return this.sceneTriangles;
  }

  get drawCalls(): number {
    return this.sceneDrawCalls;
  }
}
