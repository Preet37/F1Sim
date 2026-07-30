import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils';
import { buildCar, disposeCarGeometryCache, type CarVisual } from './CarMesh';
import { buildTrackMeshes, type TrackMeshes } from './TrackMesh';
import { CameraDirector } from './CameraDirector';
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

  /** Current resolution scale, 0.5 .. 1.0. */
  resolutionScale = 1;
  /** Detected quality tier. */
  readonly quality: 'low' | 'high';

  /** Smoothed frame rate, exposed for the HUD's diagnostics. */
  fps = 60;

  private trackMeshes: TrackMeshes | null = null;
  private carVisuals: CarVisual[] = [];
  private readonly canvas: HTMLCanvasElement;

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;

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
    this.renderer.toneMappingExposure = 1.05;

    // Real shadows on capable hardware; the cars also carry a cheap contact
    // shadow so they stay grounded when this is off.
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
      this.sun.shadow.mapSize.set(1024, 1024);
      const c = this.sun.shadow.camera;
      c.near = 1;
      c.far = 220;
      c.left = -34;
      c.right = 34;
      c.top = 34;
      c.bottom = -34;
      this.sun.shadow.bias = -0.0012;
      this.sun.shadow.normalBias = 0.03;
      this.scene.add(this.sun.target);
    }
    this.scene.add(this.sun);

    this.buildSky();
    this.buildEnvironment();
    this.applySize();
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
    const geo = new THREE.SphereGeometry(3600, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x2f6fc4) },
        midColor: { value: new THREE.Color(0x8fc0ea) },
        bottomColor: { value: new THREE.Color(0xd8e4ee) },
        offset: { value: 120 },
        exponent: { value: 0.9 },
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
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          // Two-stop gradient: pale at the horizon, deeper overhead.
          vec3 c = mix(bottomColor, midColor, smoothstep(0.0, 0.28, t));
          c = mix(c, topColor, smoothstep(0.22, 1.0, t));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  /**
   * Builds the environment map that the car's paint reflects.
   *
   * This is the single highest-impact visual addition: a MeshStandardMaterial with
   * no environment map has nothing to reflect, so bodywork renders as flat shaded
   * colour and looks like plastic. A generated room probe gives the sharp
   * highlights that run along a curved flank as the car turns, which is most of
   * what makes a car look like painted metal.
   */
  private buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();

    // A simple procedural probe: bright above, dark below, warm on one side. Far
    // cheaper than loading an HDR and enough to read as a real reflection.
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1);
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const sky = Math.pow(1 - v, 0.7);
        const warm = 0.5 + 0.5 * Math.cos((u - 0.25) * Math.PI * 2);
        const r = 40 + sky * 190 + warm * 26;
        const g = 52 + sky * 190 + warm * 14;
        const b = 66 + sky * 200;
        const i = (y * size + x) * 4;
        data[i] = Math.min(255, r);
        data[i + 1] = Math.min(255, g);
        data[i + 2] = Math.min(255, b);
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const target = pmrem.fromEquirectangular(tex);
    this.scene.environment = target.texture;
    this.envTarget = target;
    tex.dispose();
    pmrem.dispose();
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

    this.trackMeshes = buildTrackMeshes(engine.track, this.quality);
    this.scene.add(this.trackMeshes.root);

    for (const car of engine.cars) {
      // The race number and the driver's code are painted into the livery
      // texture, so they have to be known when the car is built.
      const visual = buildCar(car.team.colour, car.team.accent, {
        number: car.driver.raceNumber,
        code: car.driver.code,
        quality: this.quality,
      });
      this.scene.add(visual.root);
      this.carVisuals.push(visual);
    }

    this.applyAmbience(engine);
    this.director.setMode(this.director.mode);
  }

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

    let fogColour: number;
    if (night) {
      setSky(0x02040a, 0x0a1020, 0x1a2233);
      fogColour = 0x0d1420;
      this.hemi.color.setHex(0x2c3a58);
      this.hemi.groundColor.setHex(0x080a10);
      this.hemi.intensity = 0.35;
      this.sun.color.setHex(0xdce6ff);
      this.sun.intensity = 1.1;
      this.sun.position.set(60, 300, 40);
      this.renderer.toneMappingExposure = 1.25;
    } else if (dusk) {
      setSky(0x1e2a55, 0x9a5c72, 0xf0a070);
      fogColour = 0xc08a6a;
      this.hemi.color.setHex(0xffb98a);
      this.hemi.groundColor.setHex(0x2a1e22);
      this.hemi.intensity = 0.6;
      this.sun.color.setHex(0xffa04c);
      this.sun.intensity = 2.0;
      this.sun.position.set(-500, 70, 120);
      this.renderer.toneMappingExposure = 1.1;
    } else {
      setSky(0x2f6fc4, 0x8fc0ea, 0xd8e4ee);
      fogColour = 0xc6d8e8;
      this.hemi.color.setHex(0xcfe0ff);
      this.hemi.groundColor.setHex(0x3a3a30);
      this.hemi.intensity = 0.75;
      this.sun.color.setHex(0xfff4e2);
      this.sun.intensity = 2.6;
      this.sun.position.set(-220, 400, 180);
      this.renderer.toneMappingExposure = 1.05;
    }
    this.scene.background = null; // the sky dome is the background now

    // Fog matched to the horizon colour so distance fades into the sky rather
    // than into a differently-coloured haze.
    const wet = engine.weather.wetness;
    const far = 1700 - wet * 900;
    this.scene.fog = new THREE.Fog(fogColour, far * 0.3, far);
  }

  unloadSession(): void {
    if (this.trackMeshes) {
      this.scene.remove(this.trackMeshes.root);
      this.trackMeshes.dispose();
      this.trackMeshes = null;
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
  }

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
    this.syncCars(dt, engine);
    this.director.update(dt, focusCar, engine.track);

    const cam = this.director.camera;
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

    this.renderer.render(this.scene, cam);
  }

  /** Copies simulation state onto the visuals. */
  private syncCars(dt: number, engine: RaceEngine): void {
    const track = engine.track;
    // One shared wheel-spin phase: individual wheel speeds are indistinguishable
    // at speed and this avoids twenty separate integrations.
    this.wheelSpin += dt;

    // The cockpit camera sits inside the driver's helmet. Drawing it would fill
    // the screen with the inside of a shell, so that one car loses its head for
    // that one view — and only that car, because every other driver on track
    // should still have one.
    const insideOwnHelmet = this.director.mode === 'cockpit';

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
      v.driverHead.visible = !(insideOwnHelmet && car.isPlayer);

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
    disposeCarGeometryCache();
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.sky = null;
    }
    this.envTarget?.dispose();
    this.renderer.dispose();
  }

  /** Triangles drawn last frame, for the diagnostics overlay. */
  get triangleCount(): number {
    return this.renderer.info.render.triangles;
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
}
