import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils';
import {
  buildCar, disposeCarGeometryCache, actuationForTeam, BODY_PART_IDS,
  type BodyPartId, type CarVisual,
} from './CarMesh';
import { MIRROR_FAR, MIRROR_STRIDE_HIGH, MIRROR_STRIDE_LOW } from './CockpitMesh';
import { Wreckage } from './Wreckage';
import { buildTrackMeshes, bankedCarGroundY, type TrackMeshes } from './TrackMesh';
import { updateRenderPoses } from './RenderPose';
import { corneringPitch, corneringRoll, groundLift, wreckLean } from './CarAttitude';
import { buildPaddock, type PaddockScene } from './Paddock';
import { CameraDirector, isOnboardMode } from './CameraDirector';
import { EffectsDirector } from './EffectsDirector';
import { EnvProbe } from './EnvProbe';
import { setSurfaceWetness } from './SurfaceDetail';
import { PostFX } from './PostFX';
import {
  AutoTierPolicy, DEFAULT_GRAPHICS, applyOverrides, readDeviceSignals, resolveGraphics,
  tierNoticeFor,
  type AutoTierMove, type DeviceSignals, type GraphicsSettings, type QualityTier,
  type ResolvedGraphics, type TierNotice,
} from './QualityTiers';
import { RacingLine, capabilityOf } from './RacingLine';
import { buildPitBoxMarker, type PitBoxMarker } from './PitBoxMarker';
import { buildPitCrew, PIT_JACK_LIFT_M, type PitCrewScene } from './PitCrew';
import { MarshalPosts } from './MarshalPost';
import { FloodlightTowers } from './FloodlightTowers';
import { buildSafetyCar, type SafetyCarVisual } from './SafetyCarMesh';
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
 * Rain-light pulse rate, Hz.
 *
 * NOT a regulation figure. The rear light is a Standard Supply Component
 * (Art. C14.3.4) specified in FIA-F1-DOC-025, which is not published, and
 * neither the Technical nor the Sporting Regulations say anything about a
 * flashing mode. 2Hz is what the units visibly do on track.
 */
const RAIN_LIGHT_HZ = 2;

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
/**
 * DAY WAS 1.35 AND IT WAS OVER-EXPOSED BY ABOUT A STOP AND A THIRD. Issue #78.
 *
 * The paragraph above justifies 1.35 against a stated target — "reference
 * footage of a real circuit, day or night, has its road sitting closer to 0.45"
 * of full scale. That number was never measured off a reference frame, and when
 * it finally was, it was wrong: `reference/target/76.png`'s asphalt band sits at
 * a median of 68/255 = 0.27, and the whole world band above the halo sits at
 * 82/255 = 0.32. Ours measured 166/255 = 0.65 on the same band — 2.0x the
 * reference — with 4.4% of the frame clipped to white at Zandvoort and 9.2% at
 * Monza, and with NO BLACK ANYWHERE IN IT: the 1st percentile was code value 46
 * against the reference's 1, and 0.1% of the frame was in shadow against 6.1%.
 *
 * `npm run probe:grade` is the instrument and `scripts/lib/gradeModel.ts` is
 * how the value was chosen: the display pipeline is inverted on a real shot,
 * the exposure swept, and the pipeline re-applied.
 *
 * IT WAS FITTED TWICE, AND THE SECOND FIT IS WHY IT IS THIS LOW. Against the
 * generated environment probe the answer was 0.50. Then the captured sky landed
 * (`EnvProbe.ts`) and the same frame came back at a median of 136 rather than
 * the predicted 95, because a photographed sky delivers substantially more
 * ambient light than a 256x128 analytic one — which is a real result about the
 * HDRI and not an error in the model. Re-swept on a shot that HAD the capture
 * in it, the answer is 0.333.
 *
 * MEASURED, shipped, with `GRADES.day` on top: Zandvoort's world band lands at
 * a median of 123 against `76.png`'s 81, RMS contrast 54.5 against 57.1,
 * saturation 0.255 against 0.253, white balance -16.9 against -17.0, 1st
 * percentile 1 against 1, 13.1% in shadow against 6.1%, and 0.1% clipped
 * against 4.4% before. It is set from the Zandvoort frame rather than the Monza
 * one because the user named `76.png` "the best image"; **Monza still comes out
 * at 139 against `71.png`'s 89, and that residual is recorded rather than
 * averaged away** — the two circuits differ by 50 code values under identical
 * settings while the two reference frames differ by 8, and nobody has diagnosed
 * why. See PROJECT.md section 7.
 *
 * Dusk is moved with it and NOT measured — no circuit uses `dusk`, so there is
 * nothing to shoot and no reference frame for it. Night is unchanged, because
 * the night gap measured as a scene problem rather than an exposure one: the
 * sky and the light rig in `applyAmbience`, and `GRADES.night` in `PostFX.ts`.
 */
const EXPOSURE = { day: 0.333, dusk: 0.37, night: 1.7 };

/** Never scale below this fraction of native resolution. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.0;

/**
 * What the distance goes toward in the rain.
 *
 * A flat, faintly blue grey. Rain does not have a colour of its own; what it
 * does is remove the colour from everything more than a few hundred metres
 * away, and a wet circuit photographed at dusk has the same grey horizon a wet
 * circuit photographed at noon does.
 */
const WET_FOG_COLOUR = new THREE.Color(0x8f97a1);

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
  /** Force a quality tier, or leave undefined/'auto' to detect and measure. */
  quality?: 'auto' | QualityTier;
  /** Per-feature overrides. Omitted means every switch on `auto`. */
  graphics?: GraphicsSettings;
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

  /**
   * What is actually lighting the scene: `hdri:<name>` or `generated`.
   *
   * Public because `probe:env` reads it, and it reads it because the captured
   * sky is loaded ASYNCHRONOUSLY from a gitignored directory and falls back
   * silently by design (see `EnvProbe.ts`). A silent fallback that nobody can
   * observe is a change that can be REPORTED as landed while never having run —
   * PROJECT.md section 3.2 — so the state is exposed rather than assumed.
   */
  get environmentSource(): string {
    return this.envProbe.hdriActive ? `hdri:${this.envProbe.hdriName}` : 'generated';
  }

  /** Light masts placed, for the same reason. Zero everywhere but at night. */
  get floodlightCount(): number {
    return this.floodlights?.count ?? 0;
  }
  /**
   * The tier in force right now.
   *
   * NOT `readonly` any more and no longer binary. `auto` moves it during a
   * session — see `updateAutoTier` — and the Video tab can set it outright.
   */
  quality: QualityTier;
  /**
   * Everything the tier and the player's overrides resolved to.
   *
   * THE THING ISSUE #29 IS ABOUT. Every gate in this renderer used to read
   * `this.quality === 'high'` directly, which made "the post chain",
   * "shadows", "MSAA" and "how much geometry" a single indivisible decision
   * that a phone always lost. They are four fields here and they move
   * independently.
   */
  features: ResolvedGraphics;
  /** What the player asked for, before the device had a say. */
  private prefs: GraphicsSettings;
  private tierPref: 'auto' | QualityTier;
  private readonly signals: DeviceSignals;
  /**
   * The detail level the meshes in the scene were BUILT with.
   *
   * Separate from `features.detail` because geometry is not rebuildable in
   * place: a tier change mid-session moves the post chain, the shadows and the
   * resolution ceiling, and leaves the meshes exactly as they are. Rebuilding
   * a circuit's road, kerbs, terrain, signage and twenty-two cars would cost
   * seconds of stall, which is the opposite of what a promotion is for. The
   * geometry follows at the next session load, and this field is what the
   * readout uses to say so honestly rather than claiming a change that has
   * only half happened.
   */
  private builtDetail: 'low' | 'high';
  /** Fires when the tier moves on its own, so the UI can redraw. */
  onQualityChange: ((r: ResolvedGraphics) => void) | null = null;

  /** Smoothed frame rate, exposed for the HUD's diagnostics. */
  fps = 60;

  private trackMeshes: TrackMeshes | null = null;
  private paddock: PaddockScene | null = null;
  /** The player's own pit box, highlighted so they can find it. */
  private pitBox: PitBoxMarker | null = null;
  private pitCrew: PitCrewScene | null = null;
  private marshalPosts: MarshalPosts | null = null;
  /** Light masts. Night circuits only; null everywhere else. Issue #78. */
  private floodlights: FloodlightTowers | null = null;
  /**
   * Readable so the audit harness can find the car with the cockpit in it and
   * project its mirror panes. A mirror pane is about sixty pixels across in a
   * 1280-wide frame and it moves with the car; photographing one by guessing at
   * a crop box does not work, and a mirror nobody can photograph is a mirror
   * nobody can prove is working, which is how this one stayed broken.
   */
  readonly carVisuals: CarVisual[] = [];
  /**
   * The safety car.
   *
   * Deliberately NOT in `carVisuals`. That array is index-parallel with
   * `engine.cars` — the debris code looks a pile's owner up by index, the
   * effects director sizes its skid-mark budget on `cars.length`, and the audio
   * engine indexes it the same way — so a twenty-third entry that is not a
   * competitor would silently corrupt all three. It is a scene fixture like the
   * marshal posts and the pit box marker, and it is built, updated and disposed
   * alongside them.
   */
  private safetyCar: SafetyCarVisual | null = null;
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
  /** 0..1 pulse for the rain lights, recomputed once per frame. */
  private rainLightPhase = 1;

  constructor(opts: RendererOptions) {
    this.canvas = opts.canvas;

    // WHAT THIS DEVICE IS ALLOWED TO SPEND. See `QualityTiers.ts` — the whole
    // decision, and the reasoning behind every threshold in it, lives there.
    // What used to be here was `touchPrimary || cores <= 4 ? 'low' : 'high'`,
    // which put every phone that has ever existed on the cheapest image the
    // renderer can draw with no way to say otherwise (issue #29).
    this.signals = readDeviceSignals();
    this.tierPref = opts.quality ?? 'auto';
    this.prefs = opts.graphics ?? { ...DEFAULT_GRAPHICS };
    this.features = resolveGraphics(this.tierPref, this.prefs, this.signals);
    this.quality = this.features.tier;
    this.builtDetail = this.features.detail;
    // The tier we start on is the one a demotion is measured against, so the
    // policy has to be told it rather than assuming `high`.
    this.autoTier = new AutoTierPolicy(this.features.tier);

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      // The context's own multisampling, which is what antialiases the frame
      // when the post chain is OFF and does nothing at all when it is on — the
      // chain draws the scene into its own target, and that target's samples
      // are set in `PostFX`. Both follow `features.msaa`.
      //
      // This is the ONE switch that cannot move without a new GL context, and
      // therefore the one thing on the Video tab that genuinely needs a
      // reload. `Renderer.setGraphics` reports it rather than pretending.
      antialias: this.features.msaa,
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
    this.renderer.shadowMap.enabled = this.features.shadows;
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
    // The shadow frustum is CONFIGURED UNCONDITIONALLY and only `castShadow`
    // follows the tier. Configuring it inside the tier branch meant the shadow
    // camera could never be turned on later without reproducing all of this,
    // and `sun.target` — which `updateShadowFocus` moves onto the car every
    // frame — was not even in the scene graph on a device that started low.
    // Setting up a light rig costs nothing until something renders with it.
    //
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
    {
      const c = this.sun.shadow.camera;
      c.near = 1;
      c.far = 200;
      c.left = -22;
      c.right = 22;
      c.top = 22;
      c.bottom = -22;
    }
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.018;
    // PCF samples a fixed kernel; the radius widens it into a penumbra rather
    // than a hard stencil edge.
    this.sun.shadow.radius = 2.6;
    this.sun.castShadow = this.features.shadows;
    this.scene.add(this.sun.target);
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

    this.effects = new EffectsDirector(this.features.detail);
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

    this.post = new PostFX(this.renderer, this.scene, this.director.camera, {
      post: this.features.post,
      msaa: this.features.msaa,
    });

    // A stated resolution ceiling applies to the very first frame, not from
    // the scaler's first decision two seconds in.
    this.resolutionScale = Math.min(MAX_SCALE, this.features.maxResolutionScale);
    this.climbCeiling = this.resolutionScale;
    this.applySize();
  }

  /** True when the frame goes through the post chain rather than straight out. */
  get postEnabled(): boolean {
    return this.post.enabled;
  }

  /**
   * The binary tier handed to the menu's own renderers (`CarStage`, the intro).
   *
   * DELIBERATELY NOT `features.detail`. Those two build a SECOND GL context,
   * with their own shadow map, their own MSAA and their own light rig, and
   * they run on a screen the player is reading rather than racing on — so the
   * question they are answering is "can this device afford a second renderer",
   * not "how much geometry can it hold". `medium` says yes to geometry and
   * nothing about a second context, and `probe:menucost` is what guards the
   * menu's budget, so this stays exactly as conservative as it was before the
   * middle tier existed. Widening it is a separate measurement.
   */
  get menuQuality(): 'low' | 'high' {
    return this.quality === 'high' ? 'high' : 'low';
  }

  /**
   * Applies a change made on the Video tab, mid-session where possible.
   *
   * WHAT MOVES NOW AND WHAT DOES NOT, and this is measured rather than
   * assumed:
   *
   *   - **Post chain: now.** `PostFX.setEnabled` allocates or frees the
   *     composer. Costs one frame.
   *   - **Shadows: now.** `shadowMap.enabled` changes which shader variant
   *     every material needs, so every material in the scene has to be told to
   *     recompile — `needsUpdate` below. That costs a visible stall of a few
   *     hundred milliseconds, which is why it is done here on a settings
   *     screen and NOT from the adaptive pass mid-lap.
   *   - **Resolution ceiling: now**, on the next scaler decision.
   *   - **Mesh detail: at the next session.** Geometry is not editable in
   *     place; see `builtDetail`.
   *   - **MSAA: at the next page load.** It is an attribute of the GL context
   *     and three cannot change it on a live one. Returned rather than
   *     swallowed, so the screen can say so instead of lying.
   *
   * @returns what could not be applied without a reload or a new session.
   */
  setGraphics(tier: 'auto' | QualityTier, prefs: GraphicsSettings): {
    needsReload: boolean; needsNewSession: boolean;
  } {
    this.tierPref = tier;
    this.prefs = { ...prefs };
    const next = resolveGraphics(tier, this.prefs, this.signals);
    // A change made by hand clears everything the adaptive pass had concluded,
    // including the latch, so a tier it had given up on can be tried again.
    // Switching back to `auto` restarts from detection rather than from
    // whatever the pass had measured — the measurement is better information,
    // but it was taken under the tier the player has just changed, and
    // carrying it forward would mean `auto` did something different depending
    // on what you had it set to first.
    this.autoTier.playerChose(next.tier);
    this.applyResolved(next);
    return {
      needsReload: this.renderer.getContext().getContextAttributes()?.antialias !== next.msaa,
      needsNewSession: this.builtDetail !== next.detail,
    };
  }

  /** Puts a resolved configuration into effect. The only writer of `features`. */
  private applyResolved(next: ResolvedGraphics): void {
    const prev = this.features;
    this.features = next;
    this.quality = next.tier;

    if (next.shadows !== prev.shadows) {
      this.renderer.shadowMap.enabled = next.shadows;
      this.sun.castShadow = next.shadows;
      // Turning the shadow map on or off changes the `#define` set every
      // material was compiled with. Without this the scene keeps drawing with
      // the old program and the change appears to do nothing at all — which is
      // exactly the failure mode issue #29 is about, so it is not left to
      // chance.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
        else m.needsUpdate = true;
      });
    }

    if (next.post !== prev.post || next.msaa !== prev.msaa) {
      this.post.setEnabled(next.post, next.msaa);
      // The chain was rebuilt at the default size and has to be told the size
      // the game is actually running at, including the scaler's current
      // position. `applySize` is the one place that arithmetic lives.
      this.post.setCamera(this.director.camera, this.scene);
    }

    if (next.maxResolutionScale < this.resolutionScale) {
      this.resolutionScale = next.maxResolutionScale;
      this.resetFrameWindow();
    }
    this.climbCeiling = Math.min(this.climbCeiling, next.maxResolutionScale);
    this.applySize();
    this.onQualityChange?.(next);
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
    // The detail level this scene's geometry is being built at. A tier change
    // made later in the session cannot alter it — see `builtDetail`.
    this.builtDetail = this.features.detail;

    this.trackMeshes = buildTrackMeshes(engine.track, this.features.detail, engine.world);
    this.scene.add(this.trackMeshes.root);

    // The pit garages, the paddock behind them and the main grandstand. Built
    // separately from the circuit because it is architecture rather than track
    // surface, and because every session that is not a race start opens looking
    // straight at it.
    this.paddock = buildPaddock(engine.track, this.features.detail, engine.world);
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
        quality: this.features.detail,
        withCockpit: car === cockpitCar,
        compound: car.compound,
        // Per TEAM, not per car: a team's two cars run the same rear wing.
        actuation: actuationForTeam(car.team.id),
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

    // The light masts, at a circuit that races under lights. Issue #78: the
    // largest single difference between `reference/target/90.png` and our own
    // Bahrain frame was that theirs is full of floodlight towers and ours had
    // none — while the environment probe was already reflecting fourteen of
    // them off the cars. Built here rather than in `TrackMesh` because it is a
    // scene fixture of the ambience, not of the road, and because `TrackMesh`
    // is held by the road-surface work.
    if (engine.track.def.ambience === 'night') {
      this.floodlights = new FloodlightTowers(engine.track);
      this.scene.add(this.floodlights.root);
    }

    // The player's pit box. Built for the player's car only — there is nothing
    // to highlight in a fully simulated session, and the twenty boxes the
    // circuit paints are identical, so without this the player has no way of
    // telling which one is theirs.
    const player = engine.playerCar;
    if (player) {
      this.pitBox = buildPitBoxMarker(engine.track, player);
      this.scene.add(this.pitBox.root);
    }

    // The working pit crew: twenty-one people, their equipment and the release
    // light. Exactly ONE crew exists — it follows whichever car is being
    // serviced and hides when none is — so a pit lane with nothing happening in
    // it costs a visibility test. See `PitCrew.ts`.
    this.pitCrew = buildPitCrew(this.features.detail);
    this.scene.add(this.pitCrew.root);

    // The safety car, parked in its garage until race control sends it out.
    this.safetyCar = buildSafetyCar(this.features.detail);
    this.safetyCar.root.visible = false;
    this.scene.add(this.safetyCar.root);

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
      // AND THE ABOVE IS WRONG, MEASURED AGAINST THE FRAME IT IS DESCRIBING.
      // Issue #78.
      //
      // `reference/target/90.png` IS the reference this paragraph appeals to —
      // Bahrain at night, two cars, floodlights, grandstands — and its sky is
      // not near-black and is not blue. Measured off the frame:
      //
      //   top 5% of the frame     mean sRGB (99, 98, 100), saturation 0.06-0.10
      //   the band at the horizon mean sRGB (128, 126, 119)
      //   the whole upper band    median 106, 1st percentile 59, 0.0% in shadow
      //
      // That is a NEUTRAL MID GREY, brighter at the horizon and very slightly
      // warm, with no black in it at all. What `0x01030a / 0x081020 / 0x243149`
      // actually put on screen at exposure 1.7 was sRGB (0,0,2), (1,7,24) and
      // (30,52,90): a deep navy void. Our own measured upper band came back at
      // a median of 29 against the reference's 106.
      //
      // The physical reason the reference looks like that, and the reason it is
      // right rather than a rendering error in their game: a floodlit desert
      // circuit throws a very large amount of light UPWARD into dust and
      // humidity, and the camera is exposed for the track. The sky is not a
      // window onto space, it is the near side of a lit atmosphere. Every
      // broadcast frame of Bahrain and Jeddah shows the same thing.
      //
      // The hexes below are SOLVED, not picked. `Color(hex)` decodes as sRGB
      // into the linear working space, the dome shader writes it, ACES maps it
      // at `EXPOSURE.night` and `OutputPass` encodes back to sRGB — so the hex
      // is not the colour on screen and the difference is nearly a factor of
      // three. `scratch`-side, `toScene()` from `scripts/lib/gradeModel.ts`
      // inverts that whole chain on the measured sRGB targets above and returns
      // these three values.
      setSky(0x4c4b4c, 0x535251, 0x5c5b56);
      // The cloud deck goes with it. A near-black cloud colour against a mid
      // grey sky would draw the deck as holes punched in the sky, which is the
      // inverse of what thin cloud over a lit city does.
      setClouds(0x6a6a6c, 0x45444a, 0xbfae95, overcast * 0.3);
      // Fog matched to the horizon band rather than to the old navy, so that
      // distance fades into the sky it is actually in front of.
      fogColour = 0x3d3b38;
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
      // SCALED 1.9x AGAINST THE MEASURED ROAD, issue #78. With the sky dome
      // corrected above, `probe:grade` read our floodlit asphalt at a median
      // of 58 against `90.png`'s 107 while the two SKIES agreed at 112 and
      // 106 — so the sky was right and the road was half as bright as it
      // should be relative to it. The lever is the light rig and not the
      // exposure, because the sky dome is an unlit shader whose colour goes
      // to the frame directly: raising the rig moves the road and leaves the
      // sky where it was measured to belong, and raising the exposure would
      // move both and break the half that is already right.
      this.hemi.intensity = 3.5;
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
      this.sun.intensity = 1.4;
      this.sun.position.set(60, 300, 40);
      // The fill is the other half of the shadow-detail problem: it is the only
      // light that reaches the side of a car the key is not on, and at 0.55 that
      // side was reading as a silhouette. The rim goes up with it so the top
      // edges still separate from the sky, which is now darker than it was.
      this.fill.color.setHex(0xa8bcdc);
      this.fill.intensity = 1.45;
      this.rim.color.setHex(0xfff0d4);
      this.rim.intensity = 1.6;
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
    // The sun's position goes with it now. The probe used to be built with no
    // knowledge of where the key light was standing, and its own sun was 104
    // degrees away from it — see the header of `EnvProbe.ts`.
    this.envProbe.apply(this.scene, this.ambience, engine.weather.wetness, this.sun.position);

    // THE COLOUR GRADE BELONGS TO THE TIME OF DAY. Until issue #78 there was no
    // colour grade at all: the frame went from ACES straight to the screen, and
    // the pass named `grade` in `PostFX` only ever added bloom, occluded and
    // vignetted. See `GRADES` there for the four terms and where each of their
    // values was measured from.
    this.post.setGrade(this.ambience);
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
    // Built once and then MUTATED by `applyWeather`, not rebuilt. `applyAmbience`
    // runs at session load and the weather changes for the rest of the session,
    // so the density and the colour below are starting values rather than
    // settled ones.
    this.fogColour = fogColour;
    this.scene.fog = new THREE.FogExp2(fogColour, 1.9 / 1700);
    this.applyWeather(engine, true);
  }

  /** The ambience's own fog colour, before the weather greys it down. */
  private fogColour = 0xc6d8e8;
  /** Wetness the scene was last dressed for, so the work can be skipped. */
  private dressedWetness = -1;

  /**
   * Pushes the weather into the scene. Called every frame.
   *
   * THIS IS THE BUG THE WHOLE VISUAL HALF OF THIS TASK TURNED ON. Every
   * wetness-aware thing in the renderer — the fog distance, the cloud cover,
   * the environment probe's flattened sun and ground mirror, the effects
   * director's spray trigger — was already written, correct, and read exactly
   * once, in `loadSession`. A race that started dry and rained on lap ten
   * rendered as a dry race for its entire duration, which is precisely what the
   * screenshot that prompted this work showed: a HUD reading HEAVY RAIN over a
   * dry-looking circuit.
   *
   * Quantised to a fiftieth so the expensive parts — the environment probe's
   * re-render, the pooling map — do not run on a wetness that has moved by
   * 0.0001 since the previous frame. `EnvProbe.apply` quantises again on its own
   * account; this is about not calling it at all.
   */
  private applyWeather(engine: RaceEngine, force = false): void {
    const w = engine.weather;
    const wet = clamp01(w.wetness);
    const q = Math.round(wet * 50) / 50;
    if (!force && q === this.dressedWetness) return;
    this.dressedWetness = q;

    // Visibility. A wet circuit is a hazy one — the spray of twenty-two cars is
    // the largest part of it and the low cloud is the rest.
    const far = 1700 - wet * 900;
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = 1.9 / far;
      // Toward a flat, bright grey as it soaks. A wet day has no colour in the
      // distance whatever the time of day, and keeping the dry ambience's fog
      // hue at full strength under heavy rain left a warm dusk haze behind a
      // rainstorm.
      fog.color.setHex(this.fogColour).lerp(WET_FOG_COLOUR, wet * 0.55);
    }

    // Cloud. The same expression `applyAmbience` used, now live.
    const skyMat = this.sky?.material as THREE.ShaderMaterial | undefined;
    if (skyMat) {
      const night = engine.track.def.ambience === 'night';
      const base = clamp01(0.35 + wet * 0.6);
      skyMat.uniforms.cloudAmount.value = night ? base * 0.3 : base;
    }

    // The road, and everything else the detail shader owns.
    //
    // `dryLine` is how much further the racing line has dried than the road
    // around it, which is the quantity that draws a dry line. Taken as the
    // measured difference between the two water fields rather than as a
    // function of time, so the stripe on screen appears exactly when and where
    // the simulation says the grip has come back.
    const surf = w.surface;
    const dryLine = clamp01((surf.meanOffWater - surf.meanLineWater) / 0.25);
    setSurfaceWetness(wet, dryLine);

    // The probe: a flattened sun and a ground mirror term, both already
    // implemented and both previously frozen at the session's opening wetness.
    this.envProbe.apply(this.scene, this.ambience, wet);
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
    if (this.pitCrew) {
      this.scene.remove(this.pitCrew.root);
      this.pitCrew.dispose();
      this.pitCrew = null;
    }
    if (this.marshalPosts) {
      this.scene.remove(this.marshalPosts.root);
      this.marshalPosts.dispose();
      this.marshalPosts = null;
    }
    if (this.floodlights) {
      this.scene.remove(this.floodlights.root);
      this.floodlights.dispose();
      this.floodlights = null;
    }
    if (this.safetyCar) {
      this.scene.remove(this.safetyCar.root);
      this.safetyCar.dispose();
      this.safetyCar = null;
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
    this.climbCeiling = Math.min(MAX_SCALE, this.features.maxResolutionScale);
    this.lastClimbAt = -1e9;
    this.lastDropAt = -1e9;
    // The timers go; the demotion counts and the latch STAY. Those describe the
    // device, which has not changed between one session load and the next, and
    // forgetting them would hand a machine that genuinely cannot hold a tier
    // the promote-and-fall-back stall again at every session start.
    this.autoTier.resetWindows();
  }

  /**
   * THE ADAPTIVE TIER DECISION. Lives in `QualityTiers.ts`, not here.
   *
   * `readonly` and public for the same reason `RenderPose.ts` is a module of
   * its own: so `probe:autotier` can drive **the real rule** rather than a
   * reimplementation of it. Everything below is glue — it reads the scaler's
   * state, asks the policy, and applies whatever comes back. There is no
   * second copy of a threshold or of the latch in this file, deliberately; the
   * previous version had the whole decision inline and issue #73 is what that
   * cost.
   */
  readonly autoTier: AutoTierPolicy;

  /**
   * Told when the adaptive pass moves the tier and the player should know.
   *
   * Null means the renderer shows its own one-line banner — see
   * `presentTierNotice`. A front end that would rather put it in the HUD's own
   * notice column can take it over by assigning here; nothing else changes.
   */
  onTierNotice: ((n: TierNotice) => void) | null = null;

  /**
   * MEASURES THE DEVICE AND MOVES THE TIER. The other half of `auto`.
   *
   * Two gates before the policy is consulted, and both matter:
   *
   *   - `features.adaptive` is false whenever the player has STATED a tier on
   *     the Video tab (`resolveGraphics` sets it from `tier === 'auto'`), so
   *     **auto can never overrule a choice made by hand.** Issue #73 asked for
   *     that to be verified rather than assumed; `probe:autotier` §5 asserts
   *     it against the live GL context.
   *   - the two facts the policy needs about the resolution scaler are derived
   *     HERE, from the scaler's own state, so the ordering "pixels first, then
   *     the picture" cannot drift out of step with the scaler itself.
   */
  private updateAutoTier(dt: number, med: number): void {
    if (!this.features.adaptive) return;
    const move = this.autoTier.update(this.features.tier, {
      dt,
      costMs: med,
      atMinScale: this.resolutionScale <= MIN_SCALE + 1e-6,
      atCeiling: this.resolutionScale >= Math.min(this.climbCeiling, MAX_SCALE) - 1e-6,
    });
    if (move) this.moveTier(move);
  }

  /**
   * Drives the adaptive tier pass with a stated frame cost.
   *
   * The real path — the real policy, the real `moveTier`, the real GL changes,
   * the real notice — with the one number the frame loop would have computed
   * supplied instead of measured. This is how `probe:autotier` puts a load
   * spike on the renderer without needing a machine that is genuinely in
   * trouble, which is not a thing a probe can arrange and certainly not a
   * thing it can arrange REPEATABLY. Set `resolutionScale` to say where the
   * scaler had got to; everything else is derived as it is in a live frame.
   */
  feedFrameCost(dt: number, costMs: number): void {
    this.updateAutoTier(dt, costMs);
  }

  private moveTier(m: AutoTierMove): void {
    this.applyResolved(applyOverrides(m.to, this.features.detectedTier, true, this.prefs));
    // The frames either side of a tier change describe two different pictures.
    this.resetFrameWindow();
    const notice = tierNoticeFor(m);
    if (!notice) return;
    if (this.onTierNotice) this.onTierNotice(notice);
    else this.presentTierNotice(notice);
  }

  private tierNoticeEl: HTMLElement | null = null;
  private tierNoticeTimer = 0;

  /**
   * The default presenter: one line, bottom centre, for eight seconds.
   *
   * Self-contained on purpose — its own element, its own inline styles, no
   * class in `styles.css` and nothing inside `.hud-notices`. The HUD's notice
   * column is a bounded band whose contents are measured by `shoot:panels`,
   * and a renderer-owned message appearing in it would be a layout failure
   * somebody else has to explain. `pointer-events: none` so it can never eat a
   * touch on the pit button underneath it.
   *
   * It names the route rather than offering a button, because the route works
   * today: the pause menu is one press away and the Video tab is in it. A
   * button here would have to reach into the app shell's screen router, which
   * is a different file with a different owner.
   */
  private presentTierNotice(n: TierNotice): void {
    if (typeof document === 'undefined') return;
    const host = this.canvas.parentElement ?? document.body;
    if (!this.tierNoticeEl) {
      const el = document.createElement('div');
      el.className = 'render-tier-notice';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        'bottom:calc(64px + env(safe-area-inset-bottom, 0px))',
        'z-index:60', 'pointer-events:none', 'max-width:min(420px, 86vw)',
        'padding:9px 14px', 'border-radius:9px', 'text-align:center',
        'background:rgba(8,10,15,0.86)', 'border:1px solid rgba(255,255,255,0.14)',
        'box-shadow:0 6px 22px rgba(0,0,0,0.45)',
        'font:600 12px/1.35 system-ui, -apple-system, sans-serif',
        'letter-spacing:0.02em', 'color:#e8ecf3',
        'transition:opacity 220ms ease', 'opacity:0',
      ].join(';');
      host.appendChild(el);
      this.tierNoticeEl = el;
    }
    const el = this.tierNoticeEl;
    el.textContent = '';
    const line = document.createElement('div');
    line.textContent = n.text;
    el.appendChild(line);
    if (n.hint) {
      const hint = document.createElement('div');
      hint.textContent = n.hint;
      hint.style.cssText = 'margin-top:3px;font-weight:500;font-size:10.5px;color:#9aa4b4';
      el.appendChild(hint);
    }
    el.style.opacity = '1';
    if (this.tierNoticeTimer) clearTimeout(this.tierNoticeTimer);
    this.tierNoticeTimer = setTimeout(() => {
      if (this.tierNoticeEl) this.tierNoticeEl.style.opacity = '0';
      this.tierNoticeTimer = 0;
    }, 8000) as unknown as number;
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

    // Whether the TIER should move is judged on the same window and before the
    // cooldown, because the tier's own timers are far longer than the scaler's
    // and it must not be starved by a scaler that is busy oscillating.
    this.updateAutoTier(dt, med);

    if (this.scaleCooldown > 0) return;

    // Whatever the tier or the player allows. `MAX_SCALE` is the renderer's
    // hard limit; this is the one in force.
    const ceiling = Math.min(MAX_SCALE, this.features.maxResolutionScale);

    // A ceiling learned from a failed climb is not permanent. Machines get
    // busy and then stop being busy — the whole point of this pass is that it
    // is allowed to change its mind in both directions.
    if (this.climbCeiling < ceiling && this.sessionTime - this.lastDropAt > CEILING_RELAX_S) {
      this.climbCeiling = Math.min(ceiling, this.climbCeiling + SCALE_STEP_UP);
      this.lastDropAt = this.sessionTime;
    }

    const before = this.resolutionScale;
    if (med > DROP_MS && this.resolutionScale > MIN_SCALE) {
      // If this arrives right after a climb, the climb is what caused it.
      if (this.sessionTime - this.lastClimbAt < CLIMB_VERDICT_S) {
        this.climbCeiling = clamp(this.resolutionScale - SCALE_STEP_UP, MIN_SCALE, ceiling);
      }
      const step = clamp(SCALE_STEP_DOWN * (med / DROP_MS), SCALE_STEP_DOWN, SCALE_STEP_DOWN_MAX);
      this.resolutionScale = clamp(this.resolutionScale - step, MIN_SCALE, ceiling);
      this.scaleCooldown = 1.2;
      this.lastDropAt = this.sessionTime;
    } else if (med < CLIMB_MS && this.resolutionScale < Math.min(ceiling, this.climbCeiling)) {
      this.resolutionScale = clamp(this.resolutionScale + SCALE_STEP_UP, MIN_SCALE,
        Math.min(ceiling, this.climbCeiling));
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
   * Places every car where it should be DRAWN this frame.
   *
   * The rule itself lives in `RenderPose.ts` — see the doc comment there for
   * why interpolation exists (issue #9) and why the pose is five numbers and
   * not three (issue #54). It is out of this file so that `probe:framerate`
   * can drive the real rule without instantiating WebGL.
   */
  private updateRenderPoses(engine: RaceEngine, alpha: number): void {
    updateRenderPoses(engine.cars, engine.track.length, alpha);
  }

  /**
   * Draws one frame.
   * @param dt real frame time in seconds
   * @param alpha fraction of a physics step left in the accumulator, from
   *              `SimClock.interpolationAlpha`. Drives `updateRenderPoses`;
   *              passing 1 draws the last completed step, which is what this
   *              did before interpolation existed.
   */
  render(dt: number, alpha: number, engine: RaceEngine, focusCar: CarEntry): void {
    // FIRST. Every consumer below — the cars, the cameras, the effects, the
    // shadow frustum, the motion-blur focus — reads the render pose, and they
    // must all read the same one.
    this.updateRenderPoses(engine, alpha);
    this.updateResolutionScale(dt);
    this.applyWeather(engine);
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
    // relevant to whoever is being watched — including what that car can
    // actually do, which is not what the reference car the line was solved for
    // can do. See `capabilityOf`.
    if (this.racingLine) {
      const cap = capabilityOf(focusCar.physics, engine.track.solverParams.maxSpeedMs);
      this.racingLine.update(focusCar.renderS, focusCar.physics.speedMs, cap);
    }

    // Light the player's box up when it is relevant: while they are in the pit
    // lane, and from the moment the call is made so they can see where they are
    // heading before they commit to the entry. Left on permanently it would be
    // twenty laps of an unexplained glowing rectangle in the pit lane.
    if (this.pitBox) {
      const p = engine.playerCar;
      this.pitBox.setVisible(!!p && (p.inPitLane || p.pitRequested));
    }

    // The crew. Poses twenty-one figures from the engine's own resolved stop
    // while a car is in its box, and returns after one branch when none is.
    this.pitCrew?.update(engine);

    // The marshal panels. Cheap: the colour buffer is only touched on the frame
    // a sector's flag actually changes.
    this.marshalPosts?.update(engine.raceControl);
    this.syncSafetyCar(dt, engine);

    // The radial blur converges on the point the car is heading for, not the
    // centre of the screen. In a corner the vanishing point swings wide, and
    // anchoring the streaks to it is the difference between the blur feeling
    // like motion and feeling like a filter.
    this.projectFocus(focusCar, cam);
    this.post.update(
      dt, focusCar.physics.speedMs, this.focusUv.x, this.focusUv.y, this.nightBias, cam,
      // The grade's own weather term: desaturation and a lifted black point.
      // Driven by what is FALLING as much as by what is lying, because the
      // visibility loss in the rain is airborne — spray and low cloud — and it
      // clears well before the road does.
      Math.max(engine.weather.wetness * 0.7, engine.weather.rainRate),
    );
    // Keep the sky centred on the camera so it never clips or parallaxes.
    if (this.sky) this.sky.position.copy(cam.position);

    // Move the shadow frustum with the car; a fixed one covering the circuit
    // would have roughly one texel per metre.
    if (this.sun.castShadow) {
      const y = engine.track.elevationAt(focusCar.renderS);
      this.sun.target.position.set(focusCar.renderX, y, focusCar.renderZ);
      this.sun.position.set(focusCar.renderX - 60, y + 110, focusCar.renderZ + 48);
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
    this.tmpVec.set(
      car.renderX + Math.sin(car.renderHeading) * 60,
      1.2,
      car.renderZ + Math.cos(car.renderHeading) * 60,
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
      const y = engine.track.elevationAt(car.renderS);
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
  /**
   * Puts the safety car where race control says it is.
   *
   * Exactly as one-way as everything else in this file: the simulation owns an
   * `(s, lateral, speed, lamps)` state on `RaceControlManager.safetyCar` and this
   * reads it. The one piece of arithmetic done here rather than there is the
   * conversion to world space, because the track spline is the render layer's
   * to interrogate and a course vehicle's position on the lap is not.
   */
  private syncSafetyCar(dt: number, engine: RaceEngine): void {
    const v = this.safetyCar;
    if (!v) return;
    const sc = engine.raceControl.safetyCar;
    v.root.visible = sc.visible;
    if (!sc.visible) return;

    const track = engine.track;
    const p = track.tmpA;
    track.toWorld(sc.s, sc.lateral, p);
    // `bankedCarGroundY` and not the bare elevation: the road surface sits 20mm
    // above the terrain, so a vehicle placed on the terrain has its wheels in
    // it — and on a banked corner the asphalt under the car is higher still the
    // further out it sits, which is worth 1.56m at Zandvoort. The safety car
    // leads the field through those corners, so it needs the same treatment the
    // racing cars get.
    v.root.position.set(p.x, bankedCarGroundY(track, sc.s, sc.lateral), p.y);
    v.root.rotation.y = track.headingAt(sc.s);

    // Wheels turn at the speed the car is doing. A course car whose wheels are
    // stationary while it circulates is the single most obvious tell there is.
    const spin = (sc.speedMs / 0.35) * dt;
    for (const w of v.wheelSpin) w.rotation.x += spin;

    // ...and the fronts point where the road goes. The safety car has no driver
    // model and no steering input to read, so the angle is taken from the road
    // itself: how much the centreline turns over the next few metres is what a
    // car following it has on lock. Not exact, and it does not need to be — a
    // car going round a hairpin with its front wheels straight ahead is what
    // this is for.
    const len = track.length;
    let turn = track.headingAt((sc.s + 8) % len) - track.headingAt(sc.s);
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const steer = Math.max(-0.5, Math.min(0.5, turn * 6));
    for (const w of v.wheelSteer) w.rotation.y = -steer;

    v.setLights(dt, sc.orangeLights, sc.greenLight);
  }

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
    // The rain lights' pulse. Shared across the field on purpose — twenty units
    // of one part number, all driven the same way, do not pulse out of phase.
    this.rainLightPhase = 0.5 + 0.5 * Math.sin(this.wheelSpin * RAIN_LIGHT_HZ * Math.PI * 2);

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
      // On the DRAWN asphalt, not on the bare elevation. The road mesh sits
      // `ROAD_SURFACE_Y` above the number the simulation carries, and the car's
      // own frame puts its contact patches at y = 0 — so placed at the bare
      // elevation every wheel on the grid ran 20mm underground and had a
      // 237mm-wide flat bitten out of the bottom of it. Measured by
      // `npm run probe:carrig`.
      // INTERPOLATED, not the solver's last step. See `updateRenderPoses` —
      // this one line is the whole of the "the cars jitter" defect.
      //
      // AND IT WAS ONLY HALF INTERPOLATED UNTIL ISSUE #54. `renderX`/`renderZ`
      // put the car in the right place in plan while `car.s`/`car.lateral`
      // stepped its HEIGHT up the elevation profile in whole 120Hz strides, so
      // a car crossing Eau Rouge climbed 2, 2, 3, 2, 3 steps per frame at
      // 50fps. Both halves of the pose now come from the same instant.
      let y = bankedCarGroundY(track, car.renderS, car.renderLateral);
      // A car in its pit box is ON JACKS, and for two and a half seconds it is
      // the most-looked-at car in the game. Both jacks go in the instant it
      // stops, lift it together, and drop it when the last gun reports — so the
      // height comes straight from the same choreography the crew are animated
      // from rather than from a timer of the renderer's own. Added ON TOP of
      // the banked ground height rather than replacing it: a car on jacks is
      // still standing on a road with a camber. See `PitStopChoreography.ts`.
      if (car.inPitBox) {
        y += engine.pitStopOf(car).progress.jack * PIT_JACK_LIFT_M;
      }
      v.root.position.set(car.renderX, y, car.renderZ);
      v.root.rotation.y = car.renderHeading;

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
      let roll = corneringRoll(p.lateralG);
      let pitch = corneringPitch(p.longitudinalG);
      if (car.retired) {
        const lean = wreckLean(car.index);
        roll = lean.roll;
        pitch = lean.pitch;
      }
      v.root.rotation.z = damp(v.root.rotation.z, roll, 8, dt);
      v.root.rotation.x = damp(v.root.rotation.x, pitch, 8, dt);

      // AND THE LEAN HAS TO STAND ON SOMETHING — issue #58, *"one the wheels
      // are in the ground not sure how thats possible"*. The rotation above is
      // about the car's ORIGIN, which is the contact-patch plane, so a leaned
      // car puts whichever tyre is on the low side under the road by the arm
      // times the angle: 4.3 degrees of roll at the 962mm outer edge of a front
      // tyre is 72mm, and 2.6 degrees of pitch at the 1800mm front axle is a
      // further 81mm. Measured against the DRAWN asphalt by `probe:crashrest`:
      // a wreck at Monza was 174mm into the road, which is half a tyre.
      //
      // ONLY FOR A WRECK, and the omission is deliberate. A running car's roll
      // and pitch model the BODY moving on its suspension while the tyres stay
      // planted, and this rig cannot express that — `Renderer` places the whole
      // visual at one height and nothing moves the body relative to the wheels
      // (see `CarMesh.frontCornerForProbe`). Lifting the whole car under
      // braking would draw it hopping off the road, which is a worse artefact
      // than the one it fixes, and it is transient in a way a wreck's lean is
      // not. The wreck's lean is a settled pose on a stationary car, and a
      // stationary car stands on the ground. Recorded in PROJECT.md section 7.
      if (car.retired) {
        v.root.position.y += groundLift(
          v.root.rotation.x, v.root.rotation.y, v.root.rotation.z,
        );
      }

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

      // ACTIVE AERO, BOTH ENDS, OFF ONE SIGNAL — and to this team's own travel.
      //
      // The 2026 car has no DRS. It has active aero at both ends, with two
      // commanded positions the regulations name Corner Mode and Straight Mode
      // (Technical Arts. C3.10.10 for the front wing, C3.11.6 for the rear).
      // Both ends are commanded together, which is why one flag drives both:
      // Sporting Art. B7.1.1(c) defines the system as "fully activated" only
      // when BOTH the front wing profiles and the rear flap are in Straight
      // Mode. Running them off `p.drsOpen` — the same flag the physics
      // integrates and the HUD's badge reads — is what guarantees the geometry,
      // the handling and the indicator can never disagree.
      //
      // PER TEAM. Under the old DRS rules every car on the grid ran the same
      // mechanism to the same 85mm limit, because Art. 3.10.10 fixed the axis
      // and the actuator position and Appendix 5 made the actuator itself an
      // open-source component shared across all competitors. The 2026 rules
      // drop all of that: they still require one actuator, one fixed Y-aligned
      // axis and two positions, but say nothing about where the axis sits along
      // the chord or how far the flap travels — and the grid has separated
      // accordingly. `ACTUATION` carries the four solutions and the sourcing.
      //
      // DAMPED, not snapped, at THIS car's rate. A wing that teleports between
      // two positions reads as a rendering glitch rather than as a mechanism.
      // The rate is the team's own transition time: C3.11.6(d) caps it at 400ms
      // for everyone, and where a team lands inside that follows from where it
      // put the axis. `damp` is exponential, so a rate of 4/travelS puts it
      // within 2% of the new position after `travelS` seconds.
      const a = v.actuation;
      const rearRate = 4 / a.travelS;
      const flapTarget = p.drsOpen ? a.openRad : 0;
      v.drsFlap.rotation.x = damp(v.drsFlap.rotation.x, flapTarget, rearRate, dt);
      // The front is the heavier assembly and is allowed two actuators against
      // the rear's one (C3.10.10(p) vs C3.11.6(e)), so it travels a little
      // slower rather than a little faster.
      const frontTarget = p.drsOpen ? a.frontOpenRad : 0;
      v.frontFlaps.rotation.x = damp(v.frontFlaps.rotation.x, frontTarget, rearRate * 0.72, dt);

      // --- Rear lights --------------------------------------------------------
      //
      // "WHEN THE CAR BRAKES THE BRAKE LIGHT SHOULD GO ON RIGHT?"
      //
      // No — and this is worth being exact about, because the intuition is
      // reasonable and the answer is not. A Formula 1 car has NO BRAKE LIGHT.
      // The phrase "brake light" does not occur anywhere in the 2025 or 2026
      // Technical or Sporting Regulations. The light on the back of the car is
      // a RAIN LIGHT, and it has one mandatory-illumination rule:
      //
      //   2026 Sporting Art. B1.5.5(a), and 2025 Sporting Art. 26.11 before it:
      //   the lights described in Art. C14.3 "must be illuminated at all times
      //   when using intermediate or wet-weather tyres".
      //
      // That is the whole rule. There is no regulation requiring it in the pit
      // lane, on an in-lap, or during recovery — those live in the Race
      // Director's Event Notes, which are per-event documents and not part of
      // the regulations. And contrary to a widely repeated claim, no regulation
      // has ever tied it to electric-only running or energy recovery: the 2014
      // regulations that introduced "electric mode" (Art. 5.19) do not mention
      // the rear light, and no edition since has either.
      //
      // So the light follows the TYRE, which is exactly what a driver looking
      // in their mirrors uses it for: three red lights ahead in the spray mean
      // there is a car there, not that it is slowing down.
      //
      // What a viewer actually sees under braking on a real car is the BRAKE
      // DISCS glowing, which is the block below and which this game already
      // had. That is the honest version of the effect being asked for.
      const wetTyre = car.compound === 'intermediate' || car.compound === 'wet';
      v.setRainLight(wetTyre, this.rainLightPhase);

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
    if (this.tierNoticeTimer) { clearTimeout(this.tierNoticeTimer); this.tierNoticeTimer = 0; }
    this.tierNoticeEl?.remove();
    this.tierNoticeEl = null;
  }

  /** Triangles in the scene last frame, for the diagnostics overlay. */
  get triangleCount(): number {
    return this.sceneTriangles;
  }

  get drawCalls(): number {
    return this.sceneDrawCalls;
  }
}
