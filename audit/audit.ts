import * as THREE from 'three';
import { Renderer } from '../src/render/Renderer';
import { CAMERA_MODES, type CameraMode } from '../src/render/CameraDirector';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { CarEntry } from '../src/race/CarEntry';

/**
 * The browser half of `npm run audit:circuits`.
 *
 * This page exists because every rendering fix in this project so far has been
 * verified on whichever circuit happened to be loaded and then declared done.
 * There are eleven, they differ in scenery type, ambience, elevation, banking
 * and width, and the bugs that matter — scenery standing on the road, black
 * seams across the asphalt, a camera that ends up inside a building — are all
 * per-circuit. So the harness drives the REAL renderer, the REAL engine and the
 * REAL world model, and photographs all of them.
 *
 * It deliberately shares the game's own code paths rather than re-implementing
 * a viewer. A viewer that builds its own scene proves nothing about the game.
 */

declare global {
  interface Window {
    __audit: AuditApi;
  }
}

interface AuditApi {
  /** Builds a session on a circuit. Resolves when the world is on screen. */
  load(circuitId: string): Promise<CircuitInfo>;
  /** Photographs through the game's own camera director, in the given mode. */
  shootMode(mode: CameraMode): Promise<string>;
  /** Overhead plan view centred on a fraction of the lap. */
  shootPlan(fraction: number, height: number): Promise<string>;
  /** Whole-circuit plan view. */
  shootOverview(): Promise<string>;
  /** Eye level beside the racing line, looking down the road. */
  shootEye(fraction: number): Promise<string>;
  /** Composes the shots taken since the last call into one contact sheet. */
  contact(cols: number): Promise<string>;
  /** Captions the shot just taken. */
  label(text: string): void;
  cameraModes: readonly CameraMode[];
}

interface CircuitInfo {
  id: string;
  name: string;
  scenery: string;
  ambience: string;
  lengthM: number;
  /** Counts straight off the world model, so the report can cite them. */
  sceneryCount: number;
  obstacleCount: number;
}

const canvas = document.getElementById('view') as HTMLCanvasElement;

// A fixed backing-store size, so every circuit is photographed at exactly the
// same resolution regardless of the window the headless browser gives us.
const SHOT_W = 1280;
const SHOT_H = 720;
canvas.style.width = `${SHOT_W}px`;
canvas.style.height = `${SHOT_H}px`;

// Quality is forced high. The low tier exists for phones and uses coarser
// tessellation and no mirrors; auditing it would photograph a different world
// from the one the complaint is about.
const renderer = new Renderer({ canvas, quality: 'high' });
renderer.resize();

let engine: RaceEngine | null = null;
let focus: CarEntry | null = null;

/** A free camera for the plan and eye-level shots, matched to the game's. */
const freeCam = new THREE.PerspectiveCamera(55, SHOT_W / SHOT_H, 0.3, 8000);

function frame(): void {
  if (!engine || !focus) return;
  renderer.render(1 / 60, engine, focus);
}

/**
 * Renders the scene through an arbitrary camera, using the game's own post
 * chain.
 *
 * Through the post chain on purpose: bloom, the tone map and the sharpen pass
 * are all candidates for "grainy", so a shot that bypassed them would be
 * evidence about a picture nobody sees.
 */
/**
 * The sky dome, which is parented to nothing and repositioned onto the camera
 * every frame by `Renderer.render`.
 *
 * It has to be found rather than asked for, because it is private to the
 * renderer — and it has to be found at all, because a free camera that does not
 * drag the dome with it flies straight out through the shell and photographs a
 * flat wall of sky colour. The first overview shot of every circuit came back
 * as a blank white rectangle for exactly that reason.
 */
function findSky(): THREE.Object3D | null {
  for (const o of renderer.scene.children) {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (m && m.uniforms && m.uniforms.topColor) return o;
  }
  return null;
}

function renderFree(): void {
  if (!engine) return;
  // The racing-line ribbon is drawn around the CAR, not around whatever camera
  // is looking. A free camera standing on the racing line therefore has a 1.4m
  // green ribbon a few centimetres under its eye, filling half the frame — and
  // these shots exist to photograph the road surface. It is a driving aid, not
  // part of the world, and the camera-mode shots put it back.
  renderer.racingLine?.setVisible(false);
  const sky = findSky();
  if (sky) sky.position.copy(freeCam.position);
  freeCam.updateMatrixWorld(true);
  renderer.post.setCamera(freeCam, renderer.scene);
  // Zero speed: the radial blur is speed-driven, and a still frame of a parked
  // camera should not be smeared.
  renderer.post.update(1 / 60, 0, 0.5, 0.5, 0, freeCam);
  renderer.post.render(renderer.scene, freeCam);
}

/** Waits for the browser to actually present the frame we just drew. */
function present(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * Draws once and reads the canvas back, with nothing in between.
 *
 * The absence of an `await` is the whole point. `Renderer` builds its context
 * without `preserveDrawingBuffer`, which is the right call for the game — it
 * lets the browser hand the buffer straight to the compositor instead of
 * copying it — but it means the drawing buffer is cleared the moment control
 * returns to the event loop. The first version of this settled the frame, then
 * awaited a `requestAnimationFrame`, then called `toDataURL`, and got 198
 * perfectly black PNGs. The read has to happen in the same synchronous turn as
 * the draw.
 */
function drawAndShoot(draw: () => void): string {
  draw();
  const png = canvas.toDataURL('image/png');
  thumbs.push(thumbnail());
  return png;
}

/**
 * Contact-sheet cells, accumulated as the sweep runs.
 *
 * Kept here rather than assembled in Node from the full-size shots. Eighteen
 * 1280x720 PNGs is around 25MB of base64 per circuit, and handing that back
 * across the CDP boundary and then straight back in again to be composited
 * wedged the browser somewhere around the fourth circuit. A 480x270 JPEG is
 * about 1% of the size and is all a contact sheet can show anyway.
 */
const thumbs: string[] = [];
const CELL_W = 480;
const CELL_H = 270;

const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = CELL_W;
thumbCanvas.height = CELL_H;

function thumbnail(): string {
  const g = thumbCanvas.getContext('2d')!;
  g.drawImage(canvas, 0, 0, CELL_W, CELL_H);
  return thumbCanvas.toDataURL('image/jpeg', 0.82);
}

async function load(circuitId: string): Promise<CircuitInfo> {
  const def = getCircuit(circuitId);
  const config: SessionConfig = {
    kind: 'race',
    name: 'audit',
    durationS: 0,
    laps: 5,
    // Fully simulated: every car has a driver.
    //
    // With a player car in the field, nobody is driving it — there is no input
    // in a headless sweep — so twelve seconds after the rolling start it is
    // parked against the barrier, and all seven camera-mode shots are seven
    // views of a wrecked car against a wall. Useless for judging a camera, and
    // worse, plausible enough to be mistaken for a camera bug.
    playerIndex: -1,
    standingStart: false,
    pitLaneStart: false,
    seed: 11,
  };
  engine = new RaceEngine(def, config);
  renderer.loadSession(engine);
  focus = engine.playerCar ?? engine.cars[0];

  // Roll the field away from the grid and out onto the circuit, so the shots
  // show cars at racing speed on the racing line rather than twenty cars
  // stacked on the grid. Long enough to be well clear of the start.
  for (let i = 0; i < Math.round(45 / PHYSICS_DT); i++) engine.step();

  // A few frames so the camera rig, the environment probe and the post chain
  // settle before anything is photographed.
  for (let i = 0; i < 8; i++) { frame(); await present(); }

  return {
    id: def.id,
    name: def.name,
    scenery: def.scenery,
    ambience: def.ambience,
    lengthM: engine.track.length,
    sceneryCount: engine.world.scenery.length,
    obstacleCount: engine.world.obstacles.obstacles.length,
  };
}

async function shootMode(mode: CameraMode): Promise<string> {
  if (!engine || !focus) throw new Error('no session');
  // Hand the post chain back to the game's own camera.
  //
  // `PostFX.render(scene, camera)` ignores its camera argument whenever the
  // composer exists — the render pass uses whatever `setCamera` last gave it —
  // which is invisible in the game, because the game only ever has one camera.
  // Here it meant every plan and eye-level shot left the composer pointed at
  // the free camera, so all seven camera modes came back as seven identical
  // copies of the last eye-level view, with no car in any of them. They looked
  // plausible, which is why it took a contact sheet to notice.
  renderer.post.setCamera(renderer.director.camera, renderer.scene);
  renderer.racingLine?.setVisible(true);
  renderer.director.setMode(mode);
  // The rig re-seats on a mode change and then damps into place; a shot taken
  // on the first frame photographs the transition rather than the camera.
  for (let i = 0; i < 30; i++) { frame(); await present(); }
  return drawAndShoot(frame);
}

/** Node index at a fraction of the lap. */
function nodeAt(fraction: number): number {
  const track = engine!.track;
  return track.indexAt(((fraction % 1) + 1) % 1 * track.length);
}

async function shootPlan(fraction: number, height: number): Promise<string> {
  const track = engine!.track;
  const i = nodeAt(fraction);
  // Slightly off vertical and looking back along the track: a dead-vertical
  // plan flattens everything to a map and hides a grandstand standing ON the
  // road, which is the single thing this view exists to catch.
  freeCam.position.set(
    track.px[i] - track.tx[i] * height * 0.35,
    track.elevation[i] + height,
    track.pz[i] - track.tz[i] * height * 0.35,
  );
  freeCam.up.set(0, 1, 0);
  freeCam.lookAt(track.px[i], track.elevation[i], track.pz[i]);
  freeCam.fov = 60;
  freeCam.updateProjectionMatrix();
  return drawAndShoot(renderFree);
}

async function shootOverview(): Promise<string> {
  const track = engine!.track;
  const b = track.bounds();
  const cx = (b.minX + b.maxX) * 0.5;
  const cz = (b.minZ + b.maxZ) * 0.5;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  freeCam.position.set(cx, span * 0.95, cz + span * 0.28);
  freeCam.up.set(0, 1, 0);
  freeCam.lookAt(cx, 0, cz);
  freeCam.fov = 60;
  freeCam.updateProjectionMatrix();
  // Fog off for this one shot only. It is a map, taken from two kilometres up,
  // and the circuit's fog is tuned to end at 1700m — left on, the overview is a
  // photograph of fog. Every other shot in the sweep keeps the game's fog,
  // because every other shot is meant to be what a player sees.
  const fog = renderer.scene.fog;
  renderer.scene.fog = null;
  try {
    return drawAndShoot(renderFree);
  } finally {
    renderer.scene.fog = fog;
  }
}

async function shootEye(fraction: number): Promise<string> {
  const track = engine!.track;
  const i = nodeAt(fraction);
  const off = track.lineOffset[i];
  // A driver's eye height, on the racing line, looking 120m up the road. This
  // is the view the complaint is actually about: what the asphalt and the
  // trackside furniture look like from a car.
  const x = track.px[i] + track.nx[i] * off;
  const z = track.pz[i] + track.nz[i] * off;
  const y = track.elevation[i] + 1.15;
  const j = track.indexAt((track.dist[i] + 120) % track.length);
  freeCam.position.set(x, y, z);
  freeCam.up.set(0, 1, 0);
  freeCam.lookAt(
    track.px[j] + track.nx[j] * track.lineOffset[j],
    track.elevation[j] + 1.0,
    track.pz[j] + track.nz[j] * track.lineOffset[j],
  );
  freeCam.fov = 55;
  freeCam.updateProjectionMatrix();
  return drawAndShoot(renderFree);
}

/**
 * Composes a set of shots into one labelled contact sheet.
 *
 * In the page rather than in Node because the project has no image library and
 * is not gaining one for this: a canvas is already here, and 2D compositing is
 * exactly what it is for.
 */
async function contact(cols: number): Promise<string> {
  const LABEL_H = 22;
  const rows = Math.ceil(thumbs.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * CELL_W;
  c.height = rows * (CELL_H + LABEL_H);
  const g = c.getContext('2d')!;
  g.fillStyle = '#101215';
  g.fillRect(0, 0, c.width, c.height);

  for (let k = 0; k < thumbs.length; k++) {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('bad shot'));
      img.src = thumbs[k];
    });
    const cx = (k % cols) * CELL_W;
    const cy = Math.floor(k / cols) * (CELL_H + LABEL_H);
    g.drawImage(img, cx, cy + LABEL_H, CELL_W, CELL_H);
    g.fillStyle = '#e8eaee';
    g.font = '600 15px ui-monospace, monospace';
    g.fillText(labels[k] ?? '', cx + 8, cy + 16);
  }
  const out = c.toDataURL('image/jpeg', 0.9);
  c.width = 1;
  c.height = 1;
  thumbs.length = 0;
  labels.length = 0;
  return out;
}

/** Cell captions, pushed by the harness alongside each shot. */
const labels: string[] = [];

window.__audit = {
  load, shootMode, shootPlan, shootOverview, shootEye, contact,
  label: (t: string) => { labels.push(t); },
  cameraModes: CAMERA_MODES,
};
