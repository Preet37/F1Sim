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
    // Shadows are the single most expensive feature for the least benefit in a
    // stylised look, so they are off and the car casts a cheap blob instead.
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.director = new CameraDirector(this.aspect);

    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2a24, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
    this.sun.position.set(-220, 400, 180);
    this.scene.add(this.sun);

    this.applySize();
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
      const visual = buildCar(car.team.colour, car.team.accent);
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

    if (night) {
      this.scene.background = new THREE.Color(0x05070d);
      this.hemi.color.setHex(0x35415e);
      this.hemi.groundColor.setHex(0x0a0c12);
      this.hemi.intensity = 0.55;
      this.sun.color.setHex(0xc9d6ff);
      this.sun.intensity = 0.55;
      // Floodlit circuits look flat from directly overhead.
      this.sun.position.set(0, 500, 0);
    } else if (dusk) {
      this.scene.background = new THREE.Color(0x2a2036);
      this.hemi.color.setHex(0xffb98a);
      this.hemi.intensity = 0.7;
      this.sun.color.setHex(0xffa860);
      this.sun.intensity = 1.0;
      this.sun.position.set(-500, 90, 120);
    } else {
      this.scene.background = new THREE.Color(0x8fb8e8);
      this.hemi.color.setHex(0xbfd4ff);
      this.hemi.groundColor.setHex(0x2a2a24);
      this.hemi.intensity = 0.85;
      this.sun.color.setHex(0xfff2dd);
      this.sun.intensity = 1.35;
      this.sun.position.set(-220, 400, 180);
    }

    // Fog hides the edge of the world and doubles as a depth cue. Tightened in
    // the wet, which is both atmospheric and cheaper to draw.
    const wet = engine.weather.wetness;
    const far = 1500 - wet * 700;
    this.scene.fog = new THREE.Fog(
      (this.scene.background as THREE.Color).getHex(),
      far * 0.25,
      far,
    );
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
    this.renderer.render(this.scene, this.director.camera);
  }

  /** Copies simulation state onto the visuals. */
  private syncCars(dt: number, engine: RaceEngine): void {
    const track = engine.track;
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

      // Wheels: spin at road speed and steer the fronts.
      const spin = (p.speedMs / 0.36) * dt;
      v.frontLeft.rotation.x -= spin;
      v.frontRight.rotation.x -= spin;
      v.rearLeft.rotation.x -= spin;
      v.rearRight.rotation.x -= spin;

      const steer = car.appliedControls.steer * p.spec.maxSteerRad;
      v.frontLeft.rotation.y = -steer;
      v.frontRight.rotation.y = -steer;

      // DRS flap: open is roughly 50 degrees.
      const flapTarget = p.drsOpen ? -0.85 : 0;
      v.drsFlap.rotation.x = damp(v.drsFlap.rotation.x, flapTarget, 14, dt);

      // Brake glow from braking effort. Cheap and reads brilliantly at night.
      const heat = clamp01(car.appliedControls.brake * clamp01(p.speedMs / 45));
      this.tmpColour.setRGB(0.13 + heat * 0.87, 0.08 + heat * 0.18, 0.06);
      for (const disc of v.brakeGlow) {
        (disc.material as THREE.MeshBasicMaterial).color.copy(this.tmpColour);
      }
    }
  }

  /** Frees everything. */
  dispose(): void {
    this.unloadSession();
    disposeCarGeometryCache();
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
