import * as THREE from 'three';
import { buildCar, type CarVisual } from './CarMesh';

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

  private raf = 0;
  private lastT = 0;
  private angle = START_ANGLE;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  /** Owned so `dispose` can release them; the scene graph does not do it. */
  private readonly owned: { dispose(): void }[] = [];

  constructor(opts: CarStageOptions) {
    this.quality = opts.quality ?? 'high';
    this.still = opts.still ?? false;

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

    this.scene.add(this.turntable);
    if (this.quality === 'high') this.scene.add(this.mirrorTable);

    this.setLivery(opts);
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
    this.angle += Math.min(0.25, dt) * SPIN_DEG_PER_S * (Math.PI / 180);
    this.applyAngle();
    this.renderer.render(this.scene, this.camera);
  };

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

    const aspect = w / h;
    this.camera.aspect = aspect;
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
    const halfFovY = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const tanY = Math.tan(halfFovY);
    // Roughly four fifths of the width rather than all of it: a car photographed
    // against a seamless backdrop needs the backdrop visible around it, or the
    // shot reads as a crop rather than as a car standing in a room.
    const distW = (this.halfSpan / 0.78) / (tanY * Math.max(aspect, 0.35));
    const distH = (this.halfHeight / 0.62) / tanY;
    const d = THREE.MathUtils.clamp(Math.max(distW, distH), 6, 40);
    // A photographer's eye line: low, about level with the top of the tyres,
    // looking very slightly down so the floor and the reflection in it are
    // both in frame. High enough to see over the sidepod, low enough that the
    // car is looked UP at, which is the whole difference between a press shot
    // and a parts catalogue.
    this.camera.position.set(d * 0.315, d * 0.175, d * 0.93);
    // Aimed at the FLOOR, not at the car. The subject of this picture is the
    // car and its reflection together, and those are symmetric about y=0 — so
    // aiming at the contact patch is what puts the horizon across the middle
    // of the frame and the car in the top half of it. Aiming at the car's own
    // centre pushed the whole composition down into whatever was standing in
    // front of the stage.
    this.camera.lookAt(0, -0.06, 0);
    this.camera.updateProjectionMatrix();
    if (this.still) this.renderOnce();
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
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
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
      rx: number, ry: number, intensity: number,
    ) => {
      const g = new THREE.PlaneGeometry(w, h);
      const m = new THREE.MeshBasicMaterial({
        color: new THREE.Color(intensity, intensity * 0.985, intensity * 0.95),
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
      panel(9, 7.5, -8.4, 2.6, 1.0, 0, Math.PI / 2, 3.4),
      panel(9, 7.5, 8.4, 2.6, -1.0, 0, -Math.PI / 2, 1.5),
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

  private buildLights(): void {
    // Key: warm, high, front-left. This is the light that models the car.
    const key = new THREE.DirectionalLight(0xfff0dc, 3.7);
    key.position.set(-5.2, 7.4, 5.0);
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
    // dark half of the cyclorama.
    const rim = new THREE.DirectionalLight(0xdcebff, 2.9);
    rim.position.set(1.6, 2.0, -8.0);
    this.scene.add(rim);

    this.scene.add(new THREE.HemisphereLight(0x8fa8cc, 0x14181e, 0.35));
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

    // Colour: a warm pool under the car falling off to the cold hall floor.
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.00, '#2b323d');
    grad.addColorStop(0.28, '#1a2028');
    grad.addColorStop(0.62, '#0d1116');
    grad.addColorStop(1.00, '#05070a');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // Alpha: the mask that decides how much reflection survives.
    //
    // It is never fully clear, even directly under the car. A polished floor
    // returns a FRACTION of the light that falls on it; a hole returns all of
    // it, and a reflection as bright as its subject does not read as a
    // reflection at all — it reads as a second car standing upside down, which
    // is exactly what the first version of this looked like.
    const mask = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    mask.addColorStop(0.00, 'rgba(0,0,0,0.56)');
    mask.addColorStop(0.22, 'rgba(0,0,0,0.62)');
    mask.addColorStop(0.52, 'rgba(0,0,0,0.88)');
    mask.addColorStop(1.00, 'rgba(0,0,0,1)');
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
