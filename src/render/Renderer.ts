import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils';
import {
  buildCar, disposeCarGeometryCache, BODY_PART_IDS, FRONT_X_MODE_RAD,
  type BodyPartId, type CarVisual,
} from './CarMesh';
import { MIRROR_FAR, MIRROR_STRIDE_HIGH, MIRROR_STRIDE_LOW } from './CockpitMesh';
import { Wreckage } from './Wreckage';
import { buildTrackMeshes, type TrackMeshes } from './TrackMesh';
import { buildPaddock, type PaddockScene } from './Paddock';
import { CameraDirector, isOnboardMode } from './CameraDirector';
import { EffectsDirector } from './EffectsDirector';
import { EnvProbe } from './EnvProbe';
import { PostFX } from './PostFX';
import { RacingLine } from './RacingLine';
import { buildPitBoxMarker, type PitBoxMarker } from './PitBoxMarker';
import { MarshalPosts } from './MarshalPost';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';
// One threshold, read by the simulation (which files the debris and raises the
// flag) and by the renderer (which takes the part off the car). It used to be
// declared privately in both.
import { PART_DETACH_HEALTH, PART_REPAIR_HEALTH } from '../race/DamageModel';

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
 *     It is worth knowing how badly this can go wrong, because it did, for
 *     every player, on every circuit, for a long time: the scaler collapsed to
 *     half resolution in the first two seconds of every session and had no
 *     reachable path back. A quarter of the pixels, stretched to the canvas, is
 *     an exact description of "grainy and unclear", and no amount of texture or
 *     material work can be seen through it. See `updateResolutionScale`.
 *
 *  2. NO PER-FRAME ALLOCATION. Vectors, colours and matrices are hoisted. The
 *     render loop runs at display rate on top of a 120Hz physics loop, and garbage
 *     collection pauses show up as stutter exactly when the car is at the limit.
 */

/** Suspension health below which a corner starts visibly folding up. */
const SUSPENSION_BEND_HEALTH = 0.62;

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
const EXPOSURE = { day: 1.35, dusk: 1.4, night: 1.7 };

/** Never scale below this fraction of native resolution. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.0;

/**
 * How the dynamic resolution scaler decides. See `updateResolutionScale`.
 *
 * The thresholds are FRAME TIMES rather than frame rates, and they are compared
 * against a trimmed mean rather than an average — see `frameCostMs` for why
 * neither a plain mean nor a median can be used here.
 */
/** Frames of history each decision is taken on. About 0.75s at 60Hz. */
const SCALE_WINDOW = 45;
/**
 * Frame cost above which the image shrinks. 20ms is 50fps.
 *
 * Not tighter than this, and that is a measured decision rather than a
 * tolerant one. On the machine this was developed on the game is CPU-bound at
 * around 20ms a frame once the drawing buffer is under about 2.6 megapixels:
 * dropping Monaco from scale 0.95 to 0.85 moved it from 49 to 51fps. Below
 * this point the scaler would be giving away sharpness and buying nothing,
 * which is exactly the trade that made the picture look cheap in the first
 * place.
 */
const DROP_MS = 20;
/**
 * Frame cost below which the image grows. 17.2ms is 58fps.
 *
 * The number that was here before asked for more than 68fps before it would
 * grow the image back, and 68fps is not a thing a vsync-limited display can
 * report. The browser hands out frames at the refresh rate and no faster, so
 * on the overwhelmingly common 60Hz panel the climb branch was unreachable
 * code: once the scale had dropped it could never recover, for the rest of the
 * session, on every circuit. Sitting AT the refresh rate is precisely what
 * headroom looks like when a display is capping you, so that is what this
 * tests for.
 */
const CLIMB_MS = 17.2;
/**
 * How far one decision moves the scale. Down is coarser than up on purpose,
 * and grows with how far over budget the frame is.
 *
 * A fixed step is fine for a machine that is a little short and wrong for one
 * that is nowhere near: at 0.1 a step and 1.2s a decision, a device managing
 * 10fps would spend six seconds walking down to the floor with every one of
 * those seconds unplayable. The multiplier gets it there in two.
 */
const SCALE_STEP_DOWN = 0.1;
const SCALE_STEP_DOWN_MAX = 0.25;
const SCALE_STEP_UP = 0.05;
/**
 * Seconds after a session loads during which the scaler watches but does not
 * act.
 *
 * The first seconds of a session are shader compilation, texture upload and the
 * first shadow cascade, measured here at 3 to 15fps for about five seconds on a
 * machine that then holds 60 comfortably. Reacting to that transient is what
 * drove the scale to its floor within two seconds of every session starting.
 *
 * It is not free, though, so it is not longer than it has to be. A device that
 * genuinely cannot render the first frame is being asked to keep trying for the
 * whole of it, and on software GL that is measurable: the headless exit
 * regression's page-`load` event went from just under its thirty-second budget
 * to 31.7s with this at five seconds.
 */
const SCALE_GRACE_S = 3.5;
/** A drop this soon after a climb is blamed on the climb. */
const CLIMB_VERDICT_S = 5;
/** How long a ceiling learned that way survives before it is retried. */
const CEILING_RELAX_S = 25;

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
  /** The player's own pit box, highlighted so they can find it. */
  private pitBox: PitBoxMarker | null = null;
  private marshalPosts: MarshalPosts | null = null;
  /**
   * Readable so the audit harness can find the car with the cockpit in it and
   * project its mirror panes. A mirror pane is about sixty pixels across in a
   * 1280-wide frame and it moves with the car; photographing one by guessing at
   * a crop box does not work, and a mirror nobody can photograph is a mirror
   * nobody can prove is working, which is how this one stayed broken.
   */
  readonly carVisuals: CarVisual[] = [];
  /** Bodywork lying on the circuit. One draw call, session-lifetime. */
  private wreckage: Wreckage | null = null;
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

  // Frame-time tracking for the resolution scaler. A ring buffer of the last
  // `SCALE_WINDOW` frame times in milliseconds, plus the scratch it is sorted
  // into — allocated once, because this runs every frame.
  private readonly frameTimes = new Float64Array(SCALE_WINDOW);
  private readonly frameSort = new Float64Array(SCALE_WINDOW);
  private frameIdx = 0;
  private frameFilled = 0;
  private scaleCooldown = 0;
  private sessionTime = 0;
  private graceLeft = SCALE_GRACE_S;
  /** Highest scale the scaler currently believes this machine can hold. */
  private climbCeiling = MAX_SCALE;
  private lastClimbAt = -1e9;
  private lastDropAt = -1e9;

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
  /**
   * @param cockpitCar which car gets the cockpit interior built into it.
   *
   * Defaults to the player's, which is the only car a player can ever sit in.
   * It is a parameter because the audit harness runs a fully simulated field
   * with NO player car — twenty AI drivers, so the shots are of cars actually
   * racing — and then photographs the cockpit through `cars[0]`. With the
   * interior tied to `isPlayer` that shot came back with no steering wheel, no
   * hands, no bolsters and no mirror panes in it: an empty tub, photographed
   * for months as if it were the cockpit view, while the real one had furniture
   * in it that nothing in the sweep had ever seen.
   */
  loadSession(engine: RaceEngine, cockpitCar: CarEntry | null = engine.playerCar): void {
    this.unloadSession();
    // A new circuit is a new set of shaders to compile and a new set of
    // textures to upload, so the grace period starts again with it.
    this.resetResolutionScaler();

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
    this.paddock = buildPaddock(engine.track, this.quality, engine.world);
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
        withCockpit: car === cockpitCar,
        compound: car.compound,
      });
      this.scene.add(visual.root);
      this.carVisuals.push(visual);
    }

    this.racingLine = new RacingLine(engine.track);
    this.racingLine.setVisible(this.racingLineVisible);
    this.scene.add(this.racingLine.mesh);

    // The flag panels, one per marshalling sector. Built from race control's own
    // sector count rather than a constant of the renderer's, so the panel a
    // driver sees and the sector the simulation is flagging are the same object.
    this.marshalPosts = new MarshalPosts(engine.track, engine.raceControl.marshalSectorCount);
    this.scene.add(this.marshalPosts.root);

    // The player's pit box. Built for the player's car only — there is nothing
    // to highlight in a fully simulated session, and the twenty boxes the
    // circuit paints are identical, so without this the player has no way of
    // telling which one is theirs.
    const player = engine.playerCar;
    if (player) {
      this.pitBox = buildPitBoxMarker(engine.track, player);
      this.scene.add(this.pitBox.root);
    }

    this.wreckage = new Wreckage();
    this.scene.add(this.wreckage.mesh);

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
      // A floodlit circuit's sky is CLEAN and it is not uniform.
      //
      // Side by side with the reference the old night sky was the single
      // biggest difference, and it was not brightness — it was cloud. An
      // overcast term of 0.8 laid a grey deck across the whole upper half of
      // every frame, and a grey deck lit from below by a city is the exact
      // recipe for the muddiness in the report: no black anywhere to anchor
      // the image, and no clean gradient either. The reference frames are shot
      // at desert circuits under a clear sky. The top of frame is genuinely
      // near-black, the horizon carries a warm sodium glow from the city and
      // the light towers, and what little cloud there is reads as thin.
      //
      // So: darker and cooler at the zenith, warmer and lighter at the horizon
      // — a wider range across the same frame, which is what stops it reading
      // as a flat wash — and a third of the cloud.
      setSky(0x01030a, 0x081020, 0x243149);
      setClouds(0x1c2537, 0x070b12, 0x9fb4d8, overcast * 0.3);
      fogColour = 0x141d2e;
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
      // Lifted, because the complaint about the night is specifically about the
      // SHADOWS: ours go flat and dead where the reference keeps detail in
      // them. A floodlit circuit's shadows are filled by two hundred lamps
      // arriving from every other direction and by a very large area of lit
      // asphalt bouncing back up, and the ground term of a hemisphere light is
      // exactly the knob for that bounce. Raising it is not "turning night
      // up" — the sky term above it is unchanged and the sky itself went
      // darker; it narrows the range at the bottom end only, which is where
      // legibility lives.
      this.hemi.groundColor.setHex(0x3a3c45);
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
      // The fill is the other half of the shadow-detail problem: it is the only
      // light that reaches the side of a car the key is not on, and at 0.55 that
      // side was reading as a silhouette. The rim goes up with it so the top
      // edges still separate from the sky, which is now darker than it was.
      this.fill.color.setHex(0xa8bcdc);
      this.fill.intensity = 0.78;
      this.rim.color.setHex(0xfff0d4);
      this.rim.intensity = 1.0;
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
    if (this.wreckage) {
      this.scene.remove(this.wreckage.mesh);
      this.wreckage.dispose();
      this.wreckage = null;
    }
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
    if (this.pitBox) {
      this.scene.remove(this.pitBox.root);
      this.pitBox.dispose();
      this.pitBox = null;
    }
    if (this.marshalPosts) {
      this.scene.remove(this.marshalPosts.root);
      this.marshalPosts.dispose();
      this.marshalPosts = null;
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
   * What a frame costs, in milliseconds: the mean of the fastest 90% of the
   * window.
   *
   * A trimmed mean rather than either of the obvious choices, and both of the
   * obvious choices are wrong here:
   *
   *  - A plain MEAN is what the old scaler used, and one 200ms hitch in half a
   *    second drags it from 60fps to 30 on its own. That is what made the
   *    scaler collapse the image over a shader compile.
   *
   *  - A MEDIAN cannot see judder at all. Under vsync a machine that misses
   *    every other frame produces exactly two frame times, 16.7ms and 33.3ms,
   *    and as long as a bare majority land on the fast one the median reads a
   *    flawless 16.7 — measured here at 45fps on Spa with a median of 17.2ms.
   *    The scaler would have sat at full resolution calling it 60fps.
   *
   * Discarding the slowest tenth removes the hitches without hiding sustained
   * missed frames, so a 60/40 split between 16.7 and 33.3 reads as 22ms, which
   * is what it feels like.
   */
  private frameCostMs(): number {
    const n = this.frameFilled;
    const a = this.frameSort;
    for (let i = 0; i < n; i++) a[i] = this.frameTimes[i];
    // An insertion sort on 45 numbers allocates nothing and beats `sort` with a
    // comparator, which matters in a per-frame path.
    for (let i = 1; i < n; i++) {
      const v = a[i];
      let j = i - 1;
      while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; }
      a[j + 1] = v;
    }
    const keep = Math.max(1, Math.floor(n * 0.9));
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += a[i];
    return sum / keep;
  }

  /** Throws away the history. Called whenever the resolution changes. */
  private resetFrameWindow(): void {
    this.frameIdx = 0;
    this.frameFilled = 0;
  }

  /** Puts the scaler back to a clean slate. Called when a session loads. */
  private resetResolutionScaler(): void {
    this.resetFrameWindow();
    this.sessionTime = 0;
    this.graceLeft = SCALE_GRACE_S;
    this.scaleCooldown = 0;
    this.climbCeiling = MAX_SCALE;
    this.lastClimbAt = -1e9;
    this.lastDropAt = -1e9;
  }

  /**
   * Adjusts resolution to hold a playable frame rate.
   *
   * Three things this has to get right, all of which the previous version got
   * wrong and all of which were measured on a real GPU rather than reasoned
   * about:
   *
   *   1. It must be able to go back up. The old climb condition was "faster
   *      than 68fps", which a vsync-limited display can never report; the game
   *      therefore ran the entire session at the floor. See `CLIMB_MS`.
   *
   *   2. It must ignore the start of a session. Shader compilation and the
   *      first texture uploads cost five seconds at 3-15fps on hardware that
   *      then holds 60 without effort. Reacting to that put every session at
   *      the floor within two seconds of the lights going out, and nothing
   *      afterwards could undo it. See `SCALE_GRACE_S`.
   *
   *   3. It must judge on a statistic that sees sustained judder but not a
   *      one-off hitch — a plain mean sees only the hitch, a median sees only
   *      the judder. See `frameCostMs`.
   *
   * Still deliberately asymmetric: down in 0.1 steps after 1.2s, up in 0.05
   * steps after 2.5s, and if a climb is followed by a drop the level that
   * failed is remembered as a ceiling and not retried for `CEILING_RELAX_S`.
   * That is what stops it pulsing between two resolutions, which is worse to
   * look at than either of them.
   */
  private updateResolutionScale(dt: number): void {
    // A tab-switch, a breakpoint or a thermal stall is not a frame time.
    if (dt > 0 && dt < 0.5) {
      this.frameTimes[this.frameIdx] = dt * 1000;
      this.frameIdx = (this.frameIdx + 1) % SCALE_WINDOW;
      if (this.frameFilled < SCALE_WINDOW) this.frameFilled++;
    }

    this.sessionTime += dt;
    this.scaleCooldown -= dt;
    if (this.graceLeft > 0) {
      this.graceLeft -= dt;
      return;
    }
    if (this.frameFilled < SCALE_WINDOW) return;

    const med = this.frameCostMs();
    this.fps = 1000 / Math.max(med, 0.001);

    if (this.scaleCooldown > 0) return;

    // A ceiling learned from a failed climb is not permanent. Machines get
    // busy and then stop being busy — the whole point of this pass is that it
    // is allowed to change its mind in both directions.
    if (this.climbCeiling < MAX_SCALE && this.sessionTime - this.lastDropAt > CEILING_RELAX_S) {
      this.climbCeiling = Math.min(MAX_SCALE, this.climbCeiling + SCALE_STEP_UP);
      this.lastDropAt = this.sessionTime;
    }

    const before = this.resolutionScale;
    if (med > DROP_MS && this.resolutionScale > MIN_SCALE) {
      // If this arrives right after a climb, the climb is what caused it.
      if (this.sessionTime - this.lastClimbAt < CLIMB_VERDICT_S) {
        this.climbCeiling = clamp(this.resolutionScale - SCALE_STEP_UP, MIN_SCALE, MAX_SCALE);
      }
      const step = clamp(SCALE_STEP_DOWN * (med / DROP_MS), SCALE_STEP_DOWN, SCALE_STEP_DOWN_MAX);
      this.resolutionScale = clamp(this.resolutionScale - step, MIN_SCALE, MAX_SCALE);
      this.scaleCooldown = 1.2;
      this.lastDropAt = this.sessionTime;
    } else if (med < CLIMB_MS && this.resolutionScale < Math.min(MAX_SCALE, this.climbCeiling)) {
      this.resolutionScale = clamp(this.resolutionScale + SCALE_STEP_UP, MIN_SCALE, this.climbCeiling);
      this.scaleCooldown = 2.5;
      this.lastClimbAt = this.sessionTime;
    }

    if (this.resolutionScale !== before) {
      // The frames either side of a resolution change describe two different
      // images. Mixing them would have the next decision judging the new
      // resolution on the old one's cost.
      this.resetFrameWindow();
      this.applySize();
    }
  }

  /**
   * Draws one frame.
   * @param dt real frame time in seconds
   * @param alpha interpolation fraction between physics steps (unused for now;
   *              the physics runs at 120Hz, comfortably above display rate)
   */
  render(dt: number, engine: RaceEngine, focusCar: CarEntry): void {
    this.updateResolutionScale(dt);
    this.drainImpacts(engine);
    this.drainDebris(engine);
    this.syncCars(dt, engine, focusCar);
    this.wreckage?.advance(dt);
    this.director.update(dt, focusCar, engine.track, engine.world);

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

    // Light the player's box up when it is relevant: while they are in the pit
    // lane, and from the moment the call is made so they can see where they are
    // heading before they commit to the entry. Left on permanently it would be
    // twenty laps of an unexplained glowing rectangle in the pit lane.
    if (this.pitBox) {
      const p = engine.playerCar;
      this.pitBox.setVisible(!!p && (p.inPitLane || p.pitRequested));
    }

    // The marshal panels. Cheap: the colour buffer is only touched on the frame
    // a sector's flag actually changes.
    this.marshalPosts?.update(engine.raceControl);

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

    // Mirror feeds, immediately before the frame that samples them.
    //
    // Here rather than inside `syncCars` because it is a RENDER, not a state
    // update: it needs the camera in its final position for this frame, or the
    // reflected sightline is a frame stale and the mirrors swim in a corner.
    //
    // "The mirrors on the cars should actually be doing something." They were
    // not, and there were two reasons rather than one, which is why fixing
    // either on its own would have proved nothing:
    //
    //  - the feed only ran in 'cockpit', and the T-cam is the view the report
    //    came from. In every other mode the panes are the shell's flat dark
    //    swatch: mirror-SHAPED, and showing nothing, exactly as described;
    //  - it only ran on the HIGH tier, and the tier is chosen by
    //    `(pointer: coarse) || cores <= 4`. Every phone is 'low'. So on the
    //    device the complaint came from the feed had never run at all, in any
    //    mode, since it was written.
    //
    // It now runs on both onboard modes and on both tiers, and the low tier
    // pays for it by refreshing less often rather than not at all — see
    // `MIRROR_STRIDE` in CockpitMesh for the budget and what it measures.
    // COST. A mirror feed is a second pass over the scene, and this game is
    // frame-limited on the device that asked for it — 19 to 30fps with under
    // 110 draw calls — so the pass is rationed three ways: one pane per turn
    // rather than both, a small short frustum, and the stride below. What
    // rations it hardest is the question the mirror is for. If there is nobody
    // within `MIRROR_FAR` behind, the pane shows an empty piece of road that is
    // not changing in any way a driver needs to see promptly, and it drops to a
    // quarter rate — which is most of a race, because most of a race is spent
    // alone. The moment a car closes to within that range it goes back to full
    // rate, so the refresh is fastest exactly when something is happening.
    if (isOnboardMode(this.director.mode)) {
      const base = this.quality === 'low' ? MIRROR_STRIDE_LOW : MIRROR_STRIDE_HIGH;
      const stride = base * (this.trafficBehind(engine, focusCar) ? 1 : 4);
      for (const v of this.carVisuals) {
        v.cockpit?.renderMirrors(this.renderer, this.scene, cam, stride);
      }
    }

    this.post.render(this.scene, cam);

  }

  /**
   * Is there a car close enough behind for a mirror to have anything to say?
   *
   * Straight-line distance rather than a gap along the racing line, because a
   * mirror is a lens and does not know what a lap is: a car on the other side
   * of a hairpin is fifty metres away in the pane whatever its race position,
   * and one being lapped a straight ahead of you is not in the pane at all.
   * Behind is judged against the car's own heading, so a rival alongside counts
   * — that is precisely when a driver looks.
   *
   * Twenty cars, two multiplies each, once a frame.
   */
  private trafficBehind(engine: RaceEngine, focusCar: CarEntry): boolean {
    const p = focusCar.physics;
    const sinH = Math.sin(p.heading);
    const cosH = Math.cos(p.heading);
    for (const car of engine.cars) {
      if (car === focusCar || (car.retired && car.cleared)) continue;
      const dx = car.physics.position.x - p.position.x;
      const dz = car.physics.position.y - p.position.y;
      // Behind, or level: anything more than a car's length up the road is not
      // in a mirror.
      if (dx * sinH + dz * cosH > 6) continue;
      if (dx * dx + dz * dz < MIRROR_FAR * MIRROR_FAR) return true;
    }
    return false;
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

  /**
   * Takes this frame's collisions off the engine and turns them into effects.
   *
   * The physics runs at 120Hz and the display at 60, so a contact can begin and
   * end entirely between two drawn frames. The engine queues them; this drains
   * the queue. Without it there is no visible consequence to a collision at all,
   * which is exactly the state the code was in — `EffectsDirector.reportImpact`
   * existed, was correct, and had no caller anywhere in the project.
   */
  private drainImpacts(engine: RaceEngine): void {
    const list = engine.impacts;
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const car = engine.cars[ev.carIndex];
      if (!car) continue;
      const y = engine.track.elevationAt(car.s);
      this.effects.reportImpact(car.physics.position.x, y, car.physics.position.y, ev.severity);

      // Whether the hit shed any bodywork is not decided here any more. It is
      // decided in the simulation, because a piece of carbon on the racing line
      // raises a yellow flag and a flag changes how the race is driven — see
      // `RaceEngine.shedFromImpact` and `src/race/DebrisField.ts`. This half of
      // the program draws what the ledger says is there, and nothing else.

      // Only the player's own accident shakes the camera. A shunt happening to
      // somebody else on the other side of the circuit should not.
      if (car === engine.playerCar && ev.severity > 0.4) {
        this.flash(Math.min(0.35, ev.severity * 0.3), 4.5, 0xffd9c0);
      }
    }
    list.length = 0;
  }

  /**
   * Draws the piles the simulation has put on the circuit, and stops drawing
   * the ones the marshals have collected.
   *
   * Two edges rather than a state: a pile appears once and goes once, and every
   * frame in between it is a hundred sleeping instances that cost nothing.
   *
   * The reason the ledger is upstream of this is worth restating, because the
   * old arrangement looked like a rendering concern and was not. Debris used to
   * be spawned here and removed only when the car it came off was RECOVERED, so
   * a car that lost a sidepod and kept racing left its bodywork on the circuit
   * until the session ended. Six contact events in two laps left six permanent
   * piles of it. No amount of retinting fixes carbon that never goes away, and
   * the thing that takes it away — marshals, sent because a post is showing a
   * yellow — belongs to the race, not to the picture of it.
   */
  private drainDebris(engine: RaceEngine): void {
    const field = engine.debris;

    for (let i = 0; i < field.spawned.length; i++) {
      const pile = field.spawned[i];
      const car = engine.cars[pile.ownerIndex];
      if (!car) continue;

      // Where on the car it let go. The ledger files a pile at the CAR, which
      // is the right place for the marshals to be sent to; the shards want the
      // point the part was actually bolted to, which is the renderer's own
      // knowledge because only the renderer has a mesh.
      let x = pile.x;
      let z = pile.z;
      const v = this.carVisuals[pile.ownerIndex];
      if (pile.source > 0 && v) {
        const id = BODY_PART_IDS[pile.source - 1];
        const o = v.bodyParts[id].origin;
        const sin = Math.sin(car.physics.heading);
        const cos = Math.cos(car.physics.heading);
        x += o.x * cos + o.z * sin;
        z += -o.x * sin + o.z * cos;
      }

      const groundY = engine.track.elevationAt(pile.s);
      this.wreckage?.spawn(
        x, pile.y, z,
        pile.vx, pile.vz,
        pile.sizeX, pile.sizeY, pile.sizeZ,
        car.team.colour,
        groundY,
        pile.pieces,
        pile.id,
      );
      // Carbon shattering is bright. The burst is the moment; the shards are
      // what is left of it.
      if (pile.source > 0) this.effects.reportImpact(x, pile.y, z, 0.75);
    }
    field.spawned.length = 0;

    for (let i = 0; i < field.removed.length; i++) this.wreckage?.clearPile(field.removed[i]);
    field.removed.length = 0;
  }

  /**
   * Turns the simulation's per-component damage into a car that looks damaged.
   *
   * Runs for every car every frame, and is cheap enough to: it is four
   * comparisons and four wheel transforms, and it does the work of REMEMBERING
   * nothing — the state of the car is read from the health numbers each frame
   * rather than accumulated here. That matters because damage can go back up: a
   * pit stop fits a new wing, and a visual model that only ever subtracted would
   * leave the repaired car still missing it.
   *
   * The only thing that IS remembered is which parts have already been thrown on
   * the ground, because debris is spawned once, on the transition.
   */
  private syncDamage(car: CarEntry, v: CarVisual): void {
    const h = car.damage.health;

    // --- Bodywork -----------------------------------------------------------
    // A part is gone when its component is in the 'critical' band. The front
    // wing takes the worse of its two halves: an F1 wing is one assembly on two
    // mounts, and losing either side takes the whole thing off.
    const condition: Record<BodyPartId, number> = {
      frontWing: Math.min(h.frontWingL, h.frontWingR),
      rearWing: h.rearWing,
      sidepodL: h.sidepodL,
      sidepodR: h.sidepodR,
    };

    for (const id of BODY_PART_IDS) {
      const part = v.bodyParts[id];
      const lost = condition[id] <= PART_DETACH_HEALTH;
      if (lost === !part.attached) continue;

      if (lost) {
        // The carbon itself is the simulation's business — it filed the pile on
        // the step the health crossed the threshold, and `drainDebris` will
        // have drawn it. All that is left here is taking the part off the car.
        v.setPartAttached(id, false);
      } else if (condition[id] > PART_REPAIR_HEALTH) {
        // Repaired in the pits.
        v.setPartAttached(id, true);
      }
    }

    // --- Suspension ---------------------------------------------------------
    // A broken corner does not vanish, it COLLAPSES: the wheel drops onto its
    // bump stop, falls into negative camber and points somewhere the driver did
    // not ask for. That silhouette — one wheel folded under the car — is what
    // reads as a broken car from a hundred metres away, and it is the single
    // most recognisable damage state in the sport.
    const corners: [number, THREE.Object3D, number][] = [
      [h.suspFL, v.frontLeftSteer, -1],
      [h.suspFR, v.frontRightSteer, 1],
      [h.suspRL, v.rearLeftSteer, -1],
      [h.suspRR, v.rearRightSteer, 1],
    ];
    for (const [health, hub, side] of corners) {
      // Nothing until the corner is genuinely hurt, then it runs to fully
      // collapsed at the component's floor.
      const collapse = clamp01((SUSPENSION_BEND_HEALTH - health) / (SUSPENSION_BEND_HEALTH - 0.25));
      if (collapse <= 0 && hub.position.y === v.tyreRadiusM) continue;
      hub.position.y = v.tyreRadiusM - collapse * 0.085;
      // Camber pulls the top of the wheel inboard, which is the way a failed
      // upper wishbone lets it fall.
      hub.rotation.z = -side * collapse * 0.42;
      hub.rotation.x = collapse * 0.10;
    }
  }

  /** Copies simulation state onto the visuals. */
  private syncCars(dt: number, engine: RaceEngine, focusCar: CarEntry): void {
    const track = engine.track;
    // BOTH onboard modes, not just 'cockpit'. The T-cam is mounted on the roll
    // hoop too, so everything that follows from "the camera is inside this car"
    // applies to it: the camera pod it is itself inside must not be drawn, and
    // the cockpit interior — wheel, hands, dash, and the mirror panes that are
    // the only ones with a live feed on them — must be.
    const cockpitView = isOnboardMode(this.director.mode);
    // One shared wheel-spin phase: individual wheel speeds are indistinguishable
    // at speed and this avoids twenty separate integrations.
    this.wheelSpin += dt;

    for (let i = 0; i < engine.cars.length; i++) {
      const car = engine.cars[i];
      const v = this.carVisuals[i];
      if (!v) continue;

      // A retired car is a WRECK, and a wreck stays where it stopped.
      //
      // This used to read `car.retired && car.recovered`, and because the race
      // engine marks a car written off in a heavy impact as recovered on the
      // very frame it retires, the practical effect was that a car that hit a
      // wall hard ceased to exist between one frame and the next — the crash
      // the player had just had was erased before they could look at it. That
      // is the whole of the "it just poof gone" report.
      //
      // It goes when the MARSHALS have taken it, and not on a clock of the
      // renderer's own. This used to be a 150-second lifetime here that had to
      // be kept equal by hand to a matching 150 in the race engine, so that the
      // yellow came down on the frame the car stopped being drawn; the two
      // could drift apart at any edit and nothing would have noticed. Now there
      // is one fact — `RecoveryOperation.done`, reported as `cleared` — and the
      // flag, the wreck and its debris all answer to it, so they cannot
      // disagree. See `src/race/Recovery.ts`.
      //
      // The debris goes with the car. A crane lifts the wreck and the marshals
      // sweep up after it, so a corner that has been declared clear does not
      // still have a scatter of carbon lying on the racing line. `visible` is
      // the latch: this runs once, on the frame the recovery finished.
      if (car.retired && car.cleared) {
        v.root.visible = false;
        continue;
      }
      v.root.visible = true;

      this.syncDamage(car, v);

      // The onboard camera is the pod on the roll hoop, and the detailed
      // cockpit wheel is drawn on top of the coarse one. Both live in the same
      // mesh, so one flag deals with both — for that one car only, because
      // every other car on track should still have a camera pod on it.
      const inside = cockpitView && car === focusCar;
      v.onboardHidden.visible = !inside;

      const p = car.physics;
      const y = track.elevationAt(car.s);
      v.root.position.set(p.position.x, y, p.position.y);
      v.root.rotation.y = p.heading;

      // Geometry LOD, from the camera's position at the END of the previous
      // frame — the director has not moved it yet this frame. A frame of lag on
      // a sixty-metre threshold is not something anybody can see, and reading it
      // here rather than after the director runs keeps all the per-car work in
      // one loop.
      v.updateDetail(this.director.camera.position.distanceTo(v.root.position));

      // Body roll and pitch from the actual accelerations, which is what makes
      // the car look loaded up rather than sliding around on rails.
      //
      // A wreck has no accelerations, so both terms fall to zero and it would
      // sit dead level and square to the road — which is the one attitude a
      // car that has just been in an accident is never in. It gets a settled
      // lean instead, picked from its own index so it is stable for the session
      // rather than jittering, and eased into over about a second so the car
      // slumps as it comes to rest instead of snapping into the pose.
      let roll = clamp(-p.lateralG * 0.016, -0.06, 0.06);
      let pitch = clamp(p.longitudinalG * 0.012, -0.05, 0.05);
      if (car.retired) {
        // Deterministic, from the car's index: a stable number per car with no
        // state to store and nothing to reset between sessions.
        roll = Math.sin(car.index * 12.9898) * 0.075;
        pitch = Math.cos(car.index * 4.1414) * 0.045;
      }
      v.root.rotation.z = damp(v.root.rotation.z, roll, 8, dt);
      v.root.rotation.x = damp(v.root.rotation.x, pitch, 8, dt);

      // Wheels: spin on the inner group, steer on the outer one.
      //
      // These must be separate objects. Putting spin (X) and steer (Y) on the
      // same Euler means that once a wheel has rotated, the steering axis is no
      // longer vertical, so the front wheels tilt and wobble rather than turning.
      // THE SIGN. This was negated, and the whole field drove down the road with
      // its wheels turning backwards.
      //
      // The wheel is built with its axle along the car's +x and the car's nose
      // along +z, so a point on the FRONT of the tyre sits at (y = 0, z = +r).
      // A positive rotation about +x takes that point to (y = -r sin, z = r cos)
      // — down and under, which is a wheel rolling forwards. Subtracting rolled
      // it the other way.
      //
      // One sign is right for all four. The left-hand wheels carry a half turn
      // about Y, but that lives on the MESH, inside the spin group, so the axis
      // being spun about is the car's own x on every corner. The tyre is a solid
      // of revolution either way.
      const spin = (p.speedMs / v.tyreRadiusM) * dt;
      v.frontLeftSpin.rotation.x += spin;
      v.frontRightSpin.rotation.x += spin;
      v.rearLeftSpin.rotation.x += spin;
      v.rearRightSpin.rotation.x += spin;

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

      // Tyres.
      //
      // POLLED, not pushed. A pit stop changes `car.compound` deep inside the
      // race engine's service path (`serviceInBox`), which knows nothing about
      // the renderer and should not have to. `setCompound` returns immediately
      // when the compound is already the right one, so asking every car every
      // frame costs one comparison — and it cannot go stale the way a missed
      // notification would. The sidewall changes colour the instant the sim says
      // the new set is on.
      v.setCompound(car.compound);

      // ACTIVE AERO, both ends, off one signal.
      //
      // When the system opens, the rear flap rotates up and forward to open a
      // large slot above the main plane and the two upper front-wing elements
      // rotate flat — X-mode against the Z-mode the wing is built in. Both shed
      // drag, which is what `drsDragReduction` in the vehicle spec is already
      // doing to the physics, and both cost downforce, which is
      // `drsDownforceLoss`. Driving the two ends from `p.drsOpen` — the same
      // flag the physics integrates and the same one the HUD's badge reads — is
      // what guarantees the geometry, the handling and the indicator can never
      // disagree about which state the car is in.
      //
      // DAMPED, not snapped. A real flap takes a couple of tenths to travel, and
      // a wing that teleports between two positions reads as a rendering glitch
      // rather than as a mechanism. The front pair move a little slower than the
      // rear flap because they are the heavier assembly.
      const flapTarget = p.drsOpen ? -0.85 : 0;
      v.drsFlap.rotation.x = damp(v.drsFlap.rotation.x, flapTarget, 14, dt);
      const frontTarget = p.drsOpen ? FRONT_X_MODE_RAD : 0;
      v.frontFlaps.rotation.x = damp(v.frontFlaps.rotation.x, frontTarget, 10, dt);

      // Brake glow from braking effort. Cheap and reads brilliantly at night.
      //
      // A disc under load has to end up above the bloom threshold or it is just
      // a red circle: bloom is what makes it read as something hot rather than
      // something painted, and the threshold now sits above white paint at 1.55.
      // 2.7 at full effort clears it with room to spare, and the pedal has to be
      // hard on at speed to get there, so it stays an event rather than a
      // permanent glow.
      const heat = clamp01(car.appliedControls.brake * clamp01(p.speedMs / 45));
      this.tmpColour.setRGB(0.10 + heat * 2.6, 0.055 + heat * 0.30, 0.045);
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
