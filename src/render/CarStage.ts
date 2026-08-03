import * as THREE from 'three';
import { buildCar, type CarVisual } from './CarMesh';
import { RainCurtain } from './Rain';

/**
 * THE REVEAL STAGE — a real, lit, rotating car on its own canvas.
 *
 * WHY THIS EXISTS
 *
 * Every menu in this game used to describe a car: a livery swatch, a top-down
 * SVG silhouette, seven bars reading seven multipliers. All of it true, none of
 * it a car. The screens that sell a racing game are the ones where the machine
 * itself is standing in front of you catching light, and the game already
 * builds that machine — the same lofted mesh, the same livery, the same tyres
 * the race renders. It was only ever missing a room to stand in.
 *
 * So this is that room: a launch-night hall. A dark cyclorama, one hot key from
 * high and to the left, a cool fill opposite, a hard rim from behind, and a
 * polished floor the car sits in the reflection of. The car turns slowly on the
 * spot. Nothing else happens.
 *
 * WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE
 *
 * A second `WebGLRenderer` means a second GL context, which is a real cost and
 * a real risk — browsers cap contexts and drop the oldest without warning. Two
 * rules keep that safe, and both are enforced here rather than left to callers:
 *
 *   1. The stage is only ever mounted on menu screens. The moment a session
 *      starts, the menu tree is torn down and `dispose()` runs.
 *   2. `dispose()` returns the process to exactly the state it was in before
 *      `mount()`: geometry, textures, programs, the render loop and the resize
 *      observer all go. The car's geometry and materials are the shared cache
 *      inside `CarMesh`, so they are released through `CarVisual.dispose()` and
 *      the cache — deliberately — survives, which is why six mount/unmount
 *      cycles settle on a constant texture count rather than climbing.
 *
 * Everything drawn is procedural. The backdrop and the floor are canvas
 * gradients; the environment the paint reflects is six emissive panels — a
 * photographer's softboxes — filtered into a PMREM. No files.
 */

/** How the reflection is faded back into the floor, and how bright it starts. */
const REFLECTION_OPACITY = 0.34;

/** Degrees per second of turntable rotation. Slow enough to read as staged. */
const SPIN_DEG_PER_S = 9;

/**
 * Frames per second the stage draws at.
 *
 * Deliberately half the display's. A car turning at nine degrees a second is
 * not an animation anybody can see stutter, and the stage is the only thing
 * moving on a screen where nothing else is happening — so paying for sixty
 * frames of it buys nothing and costs a phone real battery while somebody
 * reads a menu. The race is untouched: this loop does not exist during one.
 */
const STAGE_FPS = 30;

/**
 * WHERE THE CAMERA STANDS.
 *
 * A single parked three-quarter angle is a press photograph, and a press
 * photograph is what the menu wants. A title sequence wants the other four:
 * the shots a broadcast director actually cuts between when a car comes past.
 * Each is a direction and a distance around the car rather than a position, so
 * the same table frames a car of any size in a box of any shape.
 *
 *   yaw    radians around the car from dead ahead
 *   pitch  radians above the floor
 *   dist   multiple of the fitted distance — under one is a closer, tighter shot
 *   aim    height the camera looks at, metres. Zero is the contact patch.
 */
export type StageLook = 'hero' | 'flank' | 'nose' | 'wing' | 'low';

const LOOKS: Record<StageLook, {
  yaw: number; pitch: number; dist: number; aim: number; fov: number;
}> = {
  // The launch photograph. Unchanged from what every menu in the game has used.
  hero: { yaw: 0.326, pitch: 0.176, dist: 1.00, aim: -0.06, fov: 30 },
  // Side on and low, the length of the car across the frame.
  flank: { yaw: 1.42, pitch: 0.055, dist: 0.80, aim: 0.30, fov: 34 },
  // Head on, from the height of the front wing. The shot that makes a car
  // look like it is arriving.
  nose: { yaw: 0.06, pitch: 0.048, dist: 0.70, aim: 0.24, fov: 42 },
  // Over the rear wing, from behind and above.
  wing: { yaw: 2.72, pitch: 0.215, dist: 0.74, aim: 0.46, fov: 36 },
  // Kerb height, three-quarter rear. Tyre, floor edge, and the light on wet
  // tarmac under it.
  low: { yaw: 0.70, pitch: 0.012, dist: 0.82, aim: 0.15, fov: 38 },
};

/** How fast the camera settles onto a new look. Seconds to close 63% of a gap. */
const LOOK_EASE_S = 1.35;

export interface CarStageOptions {
  /** Livery body colour, as a 24-bit RGB integer. */
  colour: number;
  /** Livery accent colour. */
  accent: number;
  /** Race number painted on the car. */
  number?: number;
  /** Driver's three-letter code. */
  code?: string;
  /**
   * Renderer effort. `low` drops shadows, antialiasing and the reflection pass,
   * and halves the pixel-ratio cap. Chosen by the caller from the same signals
   * the main renderer uses, so a phone that is running the race on the low tier
   * does not suddenly get a more expensive menu than it gets a race.
   */
  quality?: 'low' | 'high';
  /**
   * Stop the turntable. Set from `prefers-reduced-motion`, in which case the
   * car is parked at the three-quarter angle a press photograph would use and
   * the render loop stops after one frame.
   */
  still?: boolean;
  /**
   * Which room the car is standing in.
   *
   * `showroom` is the launch hall this class has always been: dry, polished,
   * warm key. `wet` is the same car at night in the rain — a dark reflective
   * surface, a cold key, real falling rain, and the light rig smeared down the
   * ground in front of it. It costs one extra draw call for the rain and a
   * different floor texture; everything else is shared.
   */
  set?: 'showroom' | 'wet';
  /**
   * The colours of the light rig standing behind the car.
   *
   * THE ONE PLACE THIS GAME SPENDS COLOUR ON SOMETHING THAT IS NOT DATA, and
   * the colours are the player's own — the shell and pattern of the helmet they
   * designed. Two to six of them; they are drawn as vertical bars behind the
   * car, they are in the environment the paint reflects, and they run down the
   * floor. Empty or absent gives a plain tungsten hall.
   */
  streaks?: readonly number[];
  /** Where the camera starts. Defaults to the launch photograph. */
  look?: StageLook;
}

export class CarStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private car: CarVisual | null = null;
  /**
   * The reflection: a SECOND car, rotated a half-turn about the view axis.
   *
   * Not a negative scale, which is what a mirror actually is, because a
   * negative determinant reverses triangle winding — every face would be
   * back-facing, the car would be culled inside out, and the normals would
   * point into the bodywork. A half-turn about Z is a proper rotation that
   * flips the car in Y and in X at once, and an F1 car is symmetric about its
   * centreline, so the extra flip in X is invisible. The result is a real
   * upside-down car with sane lighting, which is all a reflection has to be.
   *
   * It costs almost nothing: `buildCar` shares geometry and materials through
   * its own cache, so a second car with the same livery adds no geometry, no
   * texture and no material — only the scene graph nodes and the draw calls.
   */
  private mirror: CarVisual | null = null;
  private turntable = new THREE.Group();
  private mirrorTable = new THREE.Group();

  private readonly quality: 'low' | 'high';
  private readonly still: boolean;

  /**
   * Half the car's widest horizontal extent, measured from the mesh itself.
   *
   * Measured rather than declared, because the car is built by another module
   * that is free to change its dimensions — a longer wheelbase or a wider
   * front wing would silently reframe every showcase in the game if this were
   * a constant here. Taken as the radius in the XZ plane so it is correct at
   * every angle of the turntable.
   */
  private halfSpan = 3.0;
  /** The car's height. With the reflection, the subject is twice this. */
  private halfHeight = 1.05;
  /** The host box's aspect. Kept so a look change can reframe without a resize. */
  private aspect = 1.6;

  private raf = 0;
  private lastT = 0;
  private angle = START_ANGLE;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  /** Which room. Decides the floor, the key light and whether it is raining. */
  private readonly set: 'showroom' | 'wet';
  /** The colours of the bars behind the car. */
  private streakColours: number[];
  /** The bars themselves, and their reflections. Rebuilt when the colours change. */
  private streakGroup: THREE.Group | null = null;
  private readonly streakOwned: { dispose(): void }[] = [];
  /** Rain, in the wet set only. */
  private rain: RainCurtain | null = null;

  /**
   * Where the camera is heading, and where it currently is.
   *
   * Two states rather than one because the sequence CUTS its looks and the
   * camera EASES between them: a hard cut every three seconds reads as a slide
   * show, and a hard cut with no motion at all is what the previous opening
   * did. The eased value is what is written onto the camera each frame.
   */
  private look: StageLook;
  private readonly want = { yaw: 0, pitch: 0, dist: 1, aim: 0, fov: 30 };
  private readonly at = { yaw: 0, pitch: 0, dist: 1, aim: 0, fov: 30 };
  /** Fitted distance for the current box, before the look's multiplier. */
  private fitDistance = 12;
  /**
   * A slow drift laid over whatever look is current.
   *
   * A camera that is perfectly still on a moving subject reads as a render; a
   * hand-held wobble reads as an apology. This is a fifth of a degree of orbit
   * and a couple of centimetres of rise, which is what a dolly on a track
   * actually gives you.
   */
  private driftT = 0;
  private drift = false;

  /** Owned so `dispose` can release them; the scene graph does not do it. */
  private readonly owned: { dispose(): void }[] = [];

  constructor(opts: CarStageOptions) {
    this.quality = opts.quality ?? 'high';
    this.still = opts.still ?? false;
    this.set = opts.set ?? 'showroom';
    this.streakColours = [...(opts.streaks ?? [])].slice(0, 6);
    this.look = opts.look ?? 'hero';
    Object.assign(this.want, LOOKS[this.look]);
    Object.assign(this.at, LOOKS[this.look]);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality === 'high',
      // Transparent, so the CSS underneath supplies the vignette and the warm
      // floor pool. Compositing the atmosphere in CSS rather than in GL means
      // the gradient is resolution-independent and free to animate, and it is
      // the same gradient on screens that have no car on them at all.
      alpha: true,
      powerPreference: 'low-power',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The same pipeline the race uses. Without the filmic curve the key light
    // clips the airbox and the top of the halo to flat white and the car reads
    // as a cutout.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.4, 90);

    this.buildEnvironment();
    this.buildLights();
    this.buildFloor();
    this.buildStreaks();

    if (this.set === 'wet') {
      // The one effect borrowed wholesale from the race, and deliberately: this
      // is the SAME rain the track renders, so the titles are showing the game
      // rather than a drawing of it. It is one draw call of thin lines.
      // Tuned for THIS picture, not for a track. The camera here is three
      // metres from the subject and barely moving, so the race's near fade of
      // seven metres would erase every drop the shot can actually see, and the
      // race's opacity is set against a bright road rather than a black hall.
      this.rain = new RainCurtain(this.quality, {
        // The volume is the size of the room, not of a lap. At the race's 90
        // metres the same drop count is one drop per sixty-six cubic metres,
        // which at this focal length is a handful of specks; at 26 it is rain.
        boxM: 26,
        boxH: 20,
        nearM: 2.0,
        gain: 2.1,
        colour: 0xcfe0f2,
      });
      this.scene.add(this.rain.mesh);
      // Depth. Without it the dark hall behind a dark wet car is a flat void
      // and the rain has nothing to fall through.
      this.scene.fog = new THREE.FogExp2(0x070a0f, 0.028);
    }

    this.scene.add(this.turntable);
    if (this.quality === 'high') this.scene.add(this.mirrorTable);

    this.setLivery(opts);
  }

  /**
   * Points the camera somewhere else.
   *
   * Eased, not cut — see the `want`/`at` pair. Setting the same look twice is
   * free, which lets a beat table call this every frame without thinking.
   */
  setLook(look: StageLook): void {
    if (this.disposed || look === this.look) return;
    this.look = look;
    Object.assign(this.want, LOOKS[look]);
  }

  /** Turns the slow dolly drift on. Off by default; the menu does not need it. */
  setDrift(on: boolean): void {
    this.drift = on && !this.still;
  }

  /** Repaints the light rig. Used when the player's colours change. */
  setStreaks(colours: readonly number[]): void {
    if (this.disposed) return;
    const next = [...colours].slice(0, 6);
    if (next.length === this.streakColours.length
      && next.every((c, i) => c === this.streakColours[i])) return;
    this.streakColours = next;
    this.buildStreaks();
    if (this.still) this.renderOnce();
  }

  /**
   * Attaches the canvas to a host element and starts the loop.
   *
   * The host is measured with a `ResizeObserver` rather than the window resize
   * event, because the stage's box changes when the layout reflows around it —
   * a chevron column appearing, the action bar wrapping — and none of those
   * fire a window resize.
   */
  mount(host: HTMLElement): void {
    if (this.disposed) return;
    host.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.lastT = performance.now();
    if (this.still) {
      // One update so the rain exists at all: the curtain hides itself until it
      // has been told how hard it is raining, and a still frame never runs the
      // loop that would tell it.
      this.rain?.update(0, 0.85, this.camera.position);
      this.renderer.render(this.scene, this.camera);
    } else {
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /**
   * Swaps the car for a different team's without touching the room.
   *
   * This is the path the chevrons take. Rebuilding the whole stage on every
   * press would drop the GL context and take one back from the browser's pool
   * twenty times while somebody walks the grid; rebuilding just the car reuses
   * the cached geometry and costs one livery canvas.
   */
  setLivery(opts: { colour: number; accent: number; number?: number; code?: string }): void {
    if (this.disposed) return;

    this.car?.dispose();
    this.mirror?.dispose();
    this.turntable.clear();
    this.mirrorTable.clear();

    const build = () => buildCar(opts.colour, opts.accent, {
      quality: this.quality,
      number: opts.number ?? 0,
      code: opts.code ?? '',
      compound: 'soft',
    });

    this.car = build();
    this.car.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    // The stage has its own floor and its own shadow; the car's own painted
    // contact blob is for a track surface and reads as a smudge on polish.
    this.car.shadow.visible = false;
    this.car.setCockpitVisible(false);
    this.turntable.add(this.car.root);

    if (this.quality === 'high') {
      this.mirror = build();
      this.mirror.shadow.visible = false;
      this.mirror.setCockpitVisible(false);
      // See the field comment: a half-turn about Z, not a negative scale.
      this.mirror.root.rotation.z = Math.PI;
      this.mirror.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
      });
      this.mirrorTable.add(this.mirror.root);
    }

    // The rear wing's flap is closed in the pit lane and closed on a stand.
    this.car.drsFlap.rotation.x = 0;
    if (this.mirror) this.mirror.drsFlap.rotation.x = 0;

    // Re-measure: the fit depends on the mesh, and the mesh has just changed.
    const box = new THREE.Box3().setFromObject(this.car.root);
    const size = box.getSize(new THREE.Vector3());
    this.halfSpan = 0.5 * Math.hypot(size.x, size.z);
    this.halfHeight = Math.max(0.4, size.y);
    this.resize();

    this.applyAngle();
    if (this.still) this.renderOnce();
  }

  /** Renders a single frame. Used when the turntable is parked. */
  private renderOnce(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  private readonly loop = (t: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = (t - this.lastT) / 1000;
    // Frame-rate limiter. `dt` is accumulated from the last DRAWN frame rather
    // than from the last callback, so the turntable turns at the same speed
    // whatever the display is doing.
    if (dt < 1 / STAGE_FPS) return;
    this.lastT = t;
    const step = Math.min(0.25, dt);
    this.angle += step * SPIN_DEG_PER_S * (Math.PI / 180);
    this.applyAngle();
    this.stepCamera(step);
    this.rain?.update(step, 0.85, this.camera.position);
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Eases the camera towards the current look and writes it onto the camera.
   *
   * Exponential smoothing rather than a tween with a duration, because the
   * looks are changed by a beat table that knows nothing about frames and a
   * tween interrupted halfway is a jerk. `1 - exp(-dt/tau)` is frame-rate
   * independent, which a naive `lerp(a, b, 0.1)` is not.
   */
  private stepCamera(dt: number): void {
    const k = 1 - Math.exp(-dt / LOOK_EASE_S);
    this.at.yaw += (this.want.yaw - this.at.yaw) * k;
    this.at.pitch += (this.want.pitch - this.at.pitch) * k;
    this.at.dist += (this.want.dist - this.at.dist) * k;
    this.at.aim += (this.want.aim - this.at.aim) * k;
    this.at.fov += (this.want.fov - this.at.fov) * k;
    if (this.drift) this.driftT += dt;
    this.applyCamera();
  }

  private applyAngle(): void {
    this.turntable.rotation.y = this.angle;
    // The SAME yaw, not the opposite one. A floor mirror reflects in Y and
    // leaves the heading alone; negating the yaw here was what sent the
    // reflection off to one side instead of sitting under the car.
    this.mirrorTable.rotation.y = this.angle;
  }

  /**
   * Fits the canvas to its host.
   *
   * Two things move with the box, not one. The obvious one is the drawing
   * buffer. The other is the camera: a phone in portrait gives the stage a tall
   * narrow box, and a 5.6m car framed to fill a tall box either pokes out of
   * both sides or sits as a matchstick in the middle. So the camera pulls back
   * as the box narrows, which keeps the car the same fraction of the WIDTH at
   * every aspect — the dimension a car actually occupies.
   */
  private resize(): void {
    if (this.disposed) return;
    const host = this.canvas.parentElement;
    if (!host) return;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    const cap = this.quality === 'high' ? 2 : 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(w, h, false);

    this.aspect = w / h;
    // Framed against BOTH axes, and pulled back to whichever binds.
    //
    // Fitting the width alone was wrong in the two places it matters most: a
    // portrait phone, where a tall narrow box makes the car a matchstick, and
    // the garage bay on the career hub, which is a letterbox six times wider
    // than it is tall — there the width constraint asks the camera to stand
    // two and a half metres from the car, which is inside the front wing.
    //
    // The vertical extent is the car AND its reflection, which are symmetric
    // about the floor, so the subject is twice the car's height however tall
    // the car happens to be.
    this.applyCamera();
    if (this.still) this.renderOnce();
  }

  /**
   * Puts the camera where the current look says, in the current box.
   *
   * The FIT and the LOOK are separate calculations and have to stay that way.
   * The fit answers "how far back does a car this size have to be to fill a box
   * this shape" — it depends on the mesh and on the aspect ratio and on nothing
   * else. The look answers "from which direction, and how tight" — it depends
   * on the shot and on nothing else. Multiplying one by the other is what lets
   * the same five shots work on a desktop, on a phone held sideways, and in the
   * letterbox garage bay on the career hub, none of which share an aspect.
   */
  private applyCamera(): void {
    const halfFovY = THREE.MathUtils.degToRad(this.at.fov) / 2;
    const tanY = Math.tan(halfFovY);
    // Roughly four fifths of the width rather than all of it: a car photographed
    // against a seamless backdrop needs the backdrop visible around it, or the
    // shot reads as a crop rather than as a car standing in a room.
    //
    // MORE OF IT ON A TALL BOX. In portrait the width is the scarce dimension
    // and there is height to spare, so holding the car to four fifths of the
    // width leaves a phone-shaped hole with a small car floating in the middle
    // of it. The margin closes as the box narrows.
    const room = this.aspect >= 1 ? 0.78
      : 0.78 + (1 - Math.min(1, Math.max(0.3, this.aspect))) * 0.34;
    const distW = (this.halfSpan / room) / (tanY * Math.max(this.aspect, 0.35));
    const distH = (this.halfHeight / 0.62) / tanY;
    this.fitDistance = THREE.MathUtils.clamp(Math.max(distW, distH), 6, 40);

    // The drift: a fifth of a degree of orbit and two centimetres of rise, on
    // two periods that do not divide into each other, so it never repeats
    // visibly within a title sequence.
    const driftYaw = this.drift ? Math.sin(this.driftT * 0.21) * 0.035 : 0;
    const driftPitch = this.drift ? Math.sin(this.driftT * 0.13 + 1.1) * 0.018 : 0;

    const d = this.fitDistance * this.at.dist;
    const yaw = this.at.yaw + driftYaw;
    const pitch = this.at.pitch + driftPitch;
    const cp = Math.cos(pitch);
    // A photographer's eye line: low, about level with the top of the tyres,
    // looking very slightly down so the floor and the reflection in it are
    // both in frame. High enough to see over the sidepod, low enough that the
    // car is looked UP at, which is the whole difference between a press shot
    // and a parts catalogue.
    this.camera.position.set(
      d * Math.sin(yaw) * cp,
      d * Math.sin(pitch),
      d * Math.cos(yaw) * cp,
    );
    // Aimed at a height, not at the car. The subject of the hero shot is the
    // car and its reflection together, and those are symmetric about y=0 — so
    // aiming near the contact patch is what puts the horizon across the middle
    // of the frame and the car in the top half of it. The tighter shots aim
    // higher, at the thing they are a shot OF.
    this.camera.lookAt(0, this.at.aim, 0);
    this.camera.aspect = this.aspect;
    this.camera.fov = this.at.fov;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.car?.dispose();
    this.mirror?.dispose();
    this.car = null;
    this.mirror = null;
    this.rain?.dispose();
    this.rain = null;
    for (const o of this.streakOwned) o.dispose();
    this.streakOwned.length = 0;
    this.streakGroup = null;
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.scene.fog = null;
    this.scene.clear();
    this.scene.environment = null;

    // Order matters: everything above hands its GPU objects back to the
    // renderer's caches, and `dispose` on the renderer is what actually frees
    // them and releases the context.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // =========================================================================
  // The room
  // =========================================================================

  /**
   * What the paint reflects: a photographer's lighting rig, as a PMREM.
   *
   * A smooth gradient probe is worthless here for the reason the race probe's
   * comment sets out at length — the specular integral over a smooth
   * environment is nearly constant across a curved panel, so the reflection
   * term is a flat wash and the car reads as painted plastic. What a studio
   * has that a gradient does not is HARD-EDGED SOURCES: two long softboxes
   * overhead and two tall ones at the sides. Those stretch into the travelling
   * bands of light that run the length of a sidepod as it turns, which is the
   * entire reason a car photographed in a studio looks like metal.
   */
  private buildEnvironment(): void {
    const room = new THREE.Scene();
    const panel = (
      w: number, h: number, x: number, y: number, z: number,
      rx: number, ry: number, intensity: number, tint?: number,
    ) => {
      const g = new THREE.PlaneGeometry(w, h);
      // `tint` is one of the player's own colours, mixed into a source so the
      // rig's light lands in the PAINT and not only on the wall behind it. A
      // reflection that is in the geometry but not in the environment map is
      // the specific reason a car in a coloured room can still look grey.
      const base = new THREE.Color(intensity, intensity * 0.985, intensity * 0.95);
      const m = new THREE.MeshBasicMaterial({
        color: tint === undefined
          ? base
          : base.lerp(new THREE.Color(tint).multiplyScalar(intensity), 0.55),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, 0);
      room.add(mesh);
      return { g, m };
    };

    // Ceiling: the walls and the dark surround the sources sit in.
    const shellGeo = new THREE.BoxGeometry(28, 14, 28);
    const shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.030, 0.034, 0.044),
      side: THREE.BackSide,
    });
    room.add(new THREE.Mesh(shellGeo, shellMat));

    const parts = [
      { g: shellGeo, m: shellMat },
      // Two long overhead softboxes, running the length of the car.
      panel(4.0, 15, -3.2, 6.6, 0, Math.PI / 2, 0, 9.0),
      panel(3.0, 15, 3.6, 6.6, 0, Math.PI / 2, 0, 5.2),
      // Tall side boxes: these are what draw the vertical highlight down the
      // leading edge of the front wing endplate and the sidepod shoulder.
      panel(9, 7.5, -8.4, 2.6, 1.0, 0, Math.PI / 2, 3.4, this.streakColours[0]),
      panel(9, 7.5, 8.4, 2.6, -1.0, 0, -Math.PI / 2, 1.5, this.streakColours[1]),
      // A cold kicker behind, for the rim.
      panel(12, 4.5, 0, 3.0, -9.5, 0, 0, 2.2),
      // The floor's own bounce, dim and warm.
      panel(16, 16, 0, -0.6, 0, -Math.PI / 2, 0, 0.20),
    ];

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const target = pmrem.fromScene(room, 0.02);
    this.scene.environment = target.texture;
    pmrem.dispose();
    for (const p of parts) { p.g.dispose(); p.m.dispose(); }
    this.owned.push(target);
  }

  /**
   * THE LIGHT RIG — the bars of colour standing behind the car.
   *
   * This is the one thing on the front end that is coloured for its own sake,
   * and it is the player's own two colours: the shell and the pattern of the
   * helmet they designed. Nothing else in this game is allowed to do that —
   * the five signal colours have fixed meanings and a decorative sixth would
   * take one of them away — so it is confined to the room the car stands in,
   * where nothing is being asserted about a lap time.
   *
   * They are drawn three times over and cost almost nothing each. Once as
   * geometry behind the car; once mirrored below the floor, so they run down
   * the polish in front of it the way a light does on wet tarmac; and once as
   * a soft ADDITIVE column, which is the bloom — a real one would need a
   * post-processing pass and this stage has no render targets.
   */
  private buildStreaks(): void {
    if (this.streakGroup) {
      this.scene.remove(this.streakGroup);
      this.streakGroup = null;
    }
    for (const o of this.streakOwned) o.dispose();
    this.streakOwned.length = 0;
    if (this.streakColours.length === 0) return;

    const wet = this.set === 'wet';
    const group = new THREE.Group();
    // The falloff. A light bar with a hard top and bottom edge is a PANEL; the
    // same bar faded out at both ends is a LIGHT. One 4x64 texture, shared by
    // every bar and every halo, is the entire difference between the two — and
    // it is the reason the first version of this read as coloured wallpaper.
    const fade = this.buildFalloffTexture();
    this.streakOwned.push(fade);

    // AN ARC BEHIND THE CAR, not a wall and not a full ring.
    //
    // A wall is out of frame for three of the five shots the title sequence
    // cuts to — down the flank, over the rear wing, at kerb height — which is
    // exactly what the first version did. A full ring puts a lamp between the
    // lens and the car in every one of them. So: a wide arc centred on the
    // point opposite the hero camera, wrapping far enough round each side that
    // there is always something lit in the back of the frame.
    // FEWER BARS ON THE LOW TIER. Thirteen bars are four quads each — fifty-two
    // draw calls of pure atmosphere — and the machines on this path are the
    // ones that cannot afford them. Seven reads as the same rig.
    const cap = this.quality === 'high' ? 13 : 7;
    const n = Math.max(this.quality === 'high' ? 9 : 5,
      Math.min(cap, this.streakColours.length * 5 + 1));
    const radius = 18;
    // Opposite the launch angle, which is where a photographer would stand.
    const centre = Math.PI + LOOKS.hero.yaw;
    for (let i = 0; i < n; i++) {
      const colour = new THREE.Color(this.streakColours[i % this.streakColours.length]);
      // A hundred and thirty degrees, not two hundred. Wider than this and the
      // bars at each end come round past the front axle and stand BETWEEN the
      // lens and the car, which is a lighting rig photographing itself.
      const a = centre + (-1.15 + (i / (n - 1)) * 2.3);
      const x = Math.sin(a) * radius;
      const z = Math.cos(a) * radius;
      // Bars straight behind the car are the hottest, so the rim light has
      // something to come from and the arc has a centre rather than being an
      // even fence.
      const behind = Math.max(0, Math.cos(a - centre));
      const gain = (wet ? 2.9 : 2.3) * (0.40 + behind * 0.95);
      // Short enough to stop below the top of the frame. A bar that runs the
      // full height crosses the wordmark and the identity chip, and the car
      // stops being the brightest thing in its own photograph.
      const h = 6.4 + ((i * 37) % 11) * 0.26;
      const y = h * 0.5 - 1.3;

      const bar = (
        w: number, height: number, py: number, mul: number, opacity: number,
        additive: boolean, order: number,
      ) => {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(w, height),
          new THREE.MeshBasicMaterial({
            color: colour.clone().multiplyScalar(gain * mul),
            alphaMap: fade,
            transparent: true,
            opacity,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide,
          }),
        );
        m.position.set(x, py, z);
        // Turned to face the middle, so a bar at the side of the ring is seen
        // edge-on-ish rather than as a billboard lying across the picture.
        m.lookAt(0, py, 0);
        m.renderOrder = order;
        group.add(m);
        this.streakOwned.push(m.geometry, m.material as THREE.Material);
      };

      // Core, halo, and a wide soft bloom. The core is narrow on purpose: a
      // wide bright rectangle is a wall, and it is the halo around a THIN
      // source that reads as light. The outermost bloom is the cheapest thing
      // to lose on a machine that is short of fill, and losing it costs the
      // picture least.
      bar(0.22, h, y, 1.0, 1.0, false, 4);
      bar(0.95, h * 1.02, y, 0.34, 0.66, true, 4);
      if (this.quality === 'high') bar(3.2, h * 1.06, y, 0.09, 0.46, true, 4);
      // The reflection, below the floor. Water returns more and stretches it,
      // which is why the wet set needs no second pass to look wet.
      bar(wet ? 0.72 : 0.34, h * (wet ? 1.6 : 1.0), -y * (wet ? 1.35 : 1.0),
        wet ? 0.5 : 0.28, wet ? 0.7 : 0.45, true, 0);
    }

    this.streakGroup = group;
    this.scene.add(group);
  }

  /**
   * The alpha ramp every light bar is masked with: nothing at the ends, full
   * in the middle, with the bottom held longer than the top because a lamp
   * standing on a floor is brightest near it.
   */
  private buildFalloffTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 128;
    const g = cv.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0.00, '#000');
    grad.addColorStop(0.14, '#8a8a8a');
    grad.addColorStop(0.42, '#ffffff');
    grad.addColorStop(0.80, '#e2e2e2');
    grad.addColorStop(1.00, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  private buildLights(): void {
    // In the wet set the key is the moon and the pit-lane floods: cooler,
    // weaker, and from higher, because a car photographed in rain is modelled
    // by the reflections in it rather than by a light on it.
    const wet = this.set === 'wet';
    const key = new THREE.DirectionalLight(wet ? 0xc8ddff : 0xfff0dc, wet ? 2.1 : 3.7);
    key.position.set(-5.2, wet ? 9.2 : 7.4, 5.0);
    if (this.quality === 'high') {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const c = key.shadow.camera;
      c.near = 1; c.far = 26; c.left = -5; c.right = 5; c.top = 5; c.bottom = -5;
      key.shadow.bias = -0.0009;
      key.shadow.normalBias = 0.014;
      key.shadow.radius = 3;
      this.scene.add(key.target);
    }
    this.scene.add(key);

    // Fill: cool, opposite, weak. Keeps the shadow side from going to black
    // without ever competing with the key.
    const fill = new THREE.DirectionalLight(0x9fc2ff, 0.55);
    fill.position.set(6.4, 2.6, 2.2);
    this.scene.add(fill);

    // Rim: from behind, hard, white. The edge that separates the rear wing
    // from the backdrop — without it the car's silhouette dissolves into the
    // dark half of the cyclorama. In the rain it is the strongest light in the
    // room, because a wet car IS its rim light.
    const rim = new THREE.DirectionalLight(0xdcebff, wet ? 4.4 : 2.9);
    rim.position.set(1.6, 2.0, -8.0);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0x8fa8cc, 0x14181e, wet ? 0.22 : 0.35));
  }

  /**
   * The floor: a polished plane the car and its reflection share.
   *
   * One plane does two jobs. Its colour is the pool of light spilling out from
   * under the car, and its alpha is the mask that fades the reflection back
   * into that pool — opaque at the edges of the stage where a real reflection
   * has long since scattered out, and nearly clear right under the car where
   * it is sharpest. Because the reflection is drawn as opaque geometry BELOW
   * the plane, and the plane is transparent and depth-tests against it, the
   * fade needs no extra pass and no render target.
   */
  private buildFloor(): void {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d')!;

    const wet = this.set === 'wet';

    // Colour: a warm pool under the car falling off to the cold hall floor.
    // Wet tarmac is the same idea two stops down and cold — the light on it is
    // the rig's reflection, not the surface's own colour.
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (wet) {
      grad.addColorStop(0.00, '#161c26');
      grad.addColorStop(0.30, '#0c1119');
      grad.addColorStop(0.66, '#070a10');
      grad.addColorStop(1.00, '#030507');
    } else {
      grad.addColorStop(0.00, '#2b323d');
      grad.addColorStop(0.28, '#1a2028');
      grad.addColorStop(0.62, '#0d1116');
      grad.addColorStop(1.00, '#05070a');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // Standing water, in the wet set only: broad soft bands across the surface
    // where the camber holds it. They are what make the reflection read as a
    // road rather than as a mirror, because a mirror is uniform and a wet road
    // is not.
    if (wet) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 7; i++) {
        const y = ((i * 71) % size);
        const h = 12 + ((i * 37) % 40);
        const band = g.createLinearGradient(0, y, 0, y + h);
        band.addColorStop(0, 'rgba(120, 150, 190, 0)');
        band.addColorStop(0.5, 'rgba(120, 150, 190, 0.09)');
        band.addColorStop(1, 'rgba(120, 150, 190, 0)');
        g.fillStyle = band;
        g.fillRect(0, y, size, h);
      }
      g.globalCompositeOperation = 'source-over';
    }

    // Alpha: the mask that decides how much reflection survives.
    //
    // It is never fully clear, even directly under the car. A polished floor
    // returns a FRACTION of the light that falls on it; a hole returns all of
    // it, and a reflection as bright as its subject does not read as a
    // reflection at all — it reads as a second car standing upside down, which
    // is exactly what the first version of this looked like.
    //
    // Water returns MORE than polish does, and much further out — which is why
    // a night race looks the way it does — so the wet mask is clearer
    // everywhere and stays clear to the edge of the stage.
    const mask = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (wet) {
      mask.addColorStop(0.00, 'rgba(0,0,0,0.40)');
      mask.addColorStop(0.28, 'rgba(0,0,0,0.48)');
      mask.addColorStop(0.62, 'rgba(0,0,0,0.72)');
      mask.addColorStop(1.00, 'rgba(0,0,0,0.96)');
    } else {
      mask.addColorStop(0.00, 'rgba(0,0,0,0.56)');
      mask.addColorStop(0.22, 'rgba(0,0,0,0.62)');
      mask.addColorStop(0.52, 'rgba(0,0,0,0.88)');
      mask.addColorStop(1.00, 'rgba(0,0,0,1)');
    }
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = mask;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(44, 44);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      // The reflection has to survive underneath, so this must not fill the
      // depth buffer over it.
      depthWrite: false,
      opacity: 1 - REFLECTION_OPACITY * 0.0,
    });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.renderOrder = 1;
    this.scene.add(floor);

    // A second, wholly opaque plane far below catches the shadow and stops the
    // reflection reading as a hole in the world at grazing angles.
    if (this.quality === 'high') {
      const shadowMat = new THREE.ShadowMaterial({ opacity: 0.5 });
      const catcher = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), shadowMat);
      catcher.rotation.x = -Math.PI / 2;
      catcher.position.y = 0.002;
      catcher.receiveShadow = true;
      catcher.renderOrder = 2;
      this.scene.add(catcher);
      this.owned.push(catcher.geometry, shadowMat);
    }

    this.owned.push(geo, mat, tex);
  }
}

/**
 * Where a parked car stands: the three-quarter front angle every car launch
 * photograph in the sport's history has used, because it shows the front wing,
 * the sidepod and the rear tyre at once.
 */
const START_ANGLE = -0.62;
