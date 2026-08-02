import * as THREE from 'three';
import { Renderer } from '../src/render/Renderer';
import { CAMERA_MODES, type CameraMode } from '../src/render/CameraDirector';
import { MIRROR_GLASS_Z, MIRROR_X, MIRROR_Y } from '../src/render/CockpitMesh';
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
  /**
   * Reshapes the frame.
   *
   * The cockpit complaints are all about FRAMING, and framing is a function of
   * the aspect ratio: the camera's field of view is vertical, so a 2.17:1 phone
   * in landscape sees the same slice of world top to bottom as a 16:9 desktop
   * and a fifth more of it left to right. Anything measured as a fraction of
   * frame width is therefore a different number on the two, and the reference
   * footage being matched against is 2.17:1.
   */
  setFrame(w: number, h: number): void;
  /**
   * Parks another car directly behind the focus car, so a mirror can be proved
   * to be showing traffic rather than sky.
   *
   * @param gapM    how far back, metres
   * @param lateralM offset across the road, along the car's local +x.
   *
   * WHICH WAY +X IS. It is the car's LEFT, and it appears on the LEFT of the
   * screen, and those two facts are not the same fact. The world is
   * right-handed with y up, so for a car whose nose is its own +z the direction
   * `forward x up` — its right — comes out as local -x; and a camera behind it
   * looking the same way has its screen-right on local -x too. The two
   * inversions cancel, which is why nothing in the game looks mirrored and why
   * nobody has ever had to think about it. A mirror is the one place they do
   * not cancel, because a mirror reverses handedness on purpose, so a test of
   * one has to be explicit about which side the car it is looking for is on.
   */
  placeBehind(gapM: number, lateralM: number): void;
  /** Photographs a mode, then blows a region of the frame up to full size. */
  shootZoom(mode: CameraMode, x: number, y: number, w: number, h: number): Promise<string>;
  /**
   * Photographs a mode and blows up the mirror pane on one side, found by
   * projecting the pane itself rather than by guessing at a crop.
   *
   * The pane is about sixty pixels across in a 1280-wide frame and it moves
   * with the car's yaw, roll and the camera's head turn, so a fixed crop box
   * lands on it only by luck — two attempts at eyeballing one came back with a
   * picture of the front wing and a picture of the driver's helmet, neither of
   * which says anything about whether the mirror works.
   *
   * @param side +1 for the pane on the car's local +x, which is the one that
   *             appears on the LEFT of the screen. See `placeBehind`.
   */
  shootMirror(mode: CameraMode, side: 1 | -1, spanPx: number): Promise<string>;
  /** Milliseconds per frame in the given mode, averaged over `frames`. */
  timeMode(mode: CameraMode, frames: number): Promise<number>;
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
let SHOT_W = 1280;
let SHOT_H = 720;
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
  focus = engine.playerCar ?? engine.cars[0];
  // The cockpit interior goes into the car the camera will be inside. There is
  // no player car here on purpose (see `playerIndex` above), and the interior
  // used to be tied to `isPlayer` — so every cockpit shot this sweep has ever
  // taken was of an EMPTY tub with no wheel, no hands and no mirror panes in
  // it, which is not the view anybody plays.
  renderer.loadSession(engine, focus);

  // Roll the field away from the grid and out onto the circuit, so the shots
  // show cars at racing speed on the racing line rather than twenty cars
  // stacked on the grid. Long enough to be well clear of the start.
  for (let i = 0; i < Math.round(45 / PHYSICS_DT); i++) engine.step();

  // A few frames so the camera rig, the environment probe and the post chain
  // settle before anything is photographed.
  for (let i = 0; i < 4; i++) { frame(); await present(); }

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
  //
  // Six frames, not thirty. `setMode` clears `initialised`, so the camera SNAPS
  // to its new anchor on the first frame and only the damping refines it after
  // that. This loop is the dominant cost of the entire sweep — seven modes
  // times eleven circuits of full frames, software-rendered — and at thirty it
  // put a sweep at three hours, which is long enough that nobody runs it.
  for (let i = 0; i < 6; i++) { frame(); await present(); }
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

function setFrame(w: number, h: number): void {
  SHOT_W = w;
  SHOT_H = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  renderer.resize();
  freeCam.aspect = w / h;
  freeCam.updateProjectionMatrix();
}

/**
 * Puts a rival where the mirrors are supposed to see it.
 *
 * Teleporting a car is not something the simulation does, so this writes
 * straight into the physics state and leaves the race engine to catch up. It is
 * only ever used for one frame's photograph — the point is to answer "does the
 * pane show a car that is genuinely behind", which needs a car that is
 * genuinely behind and not a lucky moment in traffic.
 */
function placeBehind(gapM: number, lateralM: number): void {
  if (!engine || !focus) throw new Error('no session');
  const other = engine.cars.find((c) => c !== focus && !c.retired);
  if (!other) throw new Error('nobody to place');
  const h = focus.physics.heading;
  const p = focus.physics.position;
  // Along the focus car's own axes: back down the nose vector by `gapM`, then
  // across it. The physics' position is (x, y) in plan with y along world z.
  other.physics.position.x = p.x - Math.sin(h) * gapM + Math.cos(h) * lateralM;
  other.physics.position.y = p.y - Math.cos(h) * gapM - Math.sin(h) * lateralM;
  other.physics.heading = h;
  other.s = focus.s - gapM;
}

async function shootZoom(
  mode: CameraMode, x: number, y: number, w: number, h: number,
): Promise<string> {
  const full = await shootMode(mode);
  // `shootMode` already pushed a thumbnail of the whole frame; this replaces it
  // with the blow-up, so the contact sheet shows what was actually examined.
  thumbs.pop();
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('bad shot'));
    img.src = full;
  });
  const c = document.createElement('canvas');
  c.width = SHOT_W;
  c.height = SHOT_H;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, SHOT_W, SHOT_H);
  const out = c.toDataURL('image/png');
  const t = thumbCanvas.getContext('2d')!;
  t.drawImage(c, 0, 0, CELL_W, CELL_H);
  thumbs.push(thumbCanvas.toDataURL('image/jpeg', 0.82));
  c.width = 1;
  c.height = 1;
  return out;
}

const mirrorWorld = new THREE.Vector3();

async function shootMirror(mode: CameraMode, side: 1 | -1, spanPx: number): Promise<string> {
  if (!engine || !focus) throw new Error('no session');
  // Take the shot first: the camera has to be settled in the mode before the
  // pane's screen position means anything.
  const full = await shootMode(mode);
  thumbs.pop();

  const car = renderer.carVisuals?.find((v) => v.cockpit) ?? null;
  if (!car) throw new Error('no cockpit on any car');
  mirrorWorld.set(side * MIRROR_X, MIRROR_Y, MIRROR_GLASS_Z);
  car.root.updateWorldMatrix(true, false);
  mirrorWorld.applyMatrix4(car.root.matrixWorld);
  mirrorWorld.project(renderer.director.camera);
  const cx = (mirrorWorld.x * 0.5 + 0.5) * SHOT_W;
  const cy = (0.5 - mirrorWorld.y * 0.5) * SHOT_H;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('bad shot'));
    img.src = full;
  });
  const c = document.createElement('canvas');
  c.width = SHOT_W;
  c.height = SHOT_H;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const h = (spanPx * SHOT_H) / SHOT_W;
  g.drawImage(img, cx - spanPx / 2, cy - h / 2, spanPx, h, 0, 0, SHOT_W, SHOT_H);
  const out = c.toDataURL('image/png');
  const t = thumbCanvas.getContext('2d')!;
  t.drawImage(c, 0, 0, CELL_W, CELL_H);
  thumbs.push(thumbCanvas.toDataURL('image/jpeg', 0.82));
  c.width = 1;
  c.height = 1;
  return out;
}

/**
 * Frame cost of a mode, in milliseconds.
 *
 * `finish()` on the way out of each frame, because a WebGL draw call returns
 * long before the GPU has done the work and a timer around an unsynchronised
 * render measures the JavaScript, not the frame. Under SwiftShader — which is
 * what the sweep runs on — everything is CPU anyway, so the number is a
 * pessimistic stand-in for a real GPU; what it is good for is the RATIO between
 * two configurations measured the same way, which is the question a mirror
 * costs anything at all.
 */
async function timeMode(mode: CameraMode, frames: number): Promise<number> {
  if (!engine || !focus) throw new Error('no session');
  renderer.post.setCamera(renderer.director.camera, renderer.scene);
  renderer.director.setMode(mode);
  for (let i = 0; i < 8; i++) { frame(); await present(); }
  const gl = renderer.renderer.getContext();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    frame();
    gl.finish();
  }
  return (performance.now() - t0) / frames;
}

window.__audit = {
  load, shootMode, shootPlan, shootOverview, shootEye, contact,
  label: (t: string) => { labels.push(t); },
  setFrame, placeBehind, shootZoom, shootMirror, timeMode,
  cameraModes: CAMERA_MODES,
};
