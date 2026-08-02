import * as THREE from 'three';
import { buildCar, type CarVisual } from '../src/render/CarMesh';
import { EnvProbe, type Ambience } from '../src/render/EnvProbe';

/**
 * The browser half of `npm run audit:car`.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `audit/audit.ts`
 *
 * The circuit sweep photographs the car at the distance a race camera holds it,
 * which is between eight and forty metres. Every complaint that has ever been
 * made about the CAR ITSELF — tread pattern on a slick, a rim with no brake
 * behind it, suspension members at angles that do not describe a wishbone, a
 * rear wing with no flap — is invisible at that range and is only ever seen in
 * a garage shot. So the two harnesses do not overlap: that one answers "does
 * the world look right", this one answers "is the car the right object".
 *
 * It deliberately reuses `buildCar` and `EnvProbe` rather than lighting a car
 * of its own, for the same reason the circuit harness drives the real renderer:
 * a bespoke viewer proves nothing about the game. The light rig below is copied
 * from `Renderer.applyAmbience` value for value, and if it ever drifts from it
 * the shots stop being evidence.
 */

declare global {
  interface Window {
    __car: CarAuditApi;
  }
}

interface CarAuditApi {
  build(opts: BuildOpts): Promise<Stats>;
  shoot(view: ViewName, opts?: ShotOpts): Promise<string>;
  views: readonly ViewName[];
  stats(): Stats;
}

interface BuildOpts {
  quality?: 'low' | 'high';
  ambience?: Ambience;
  colour?: number;
  accent?: number;
  compound?: 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet';
  /** Steering angle in radians, applied to the front steer groups. */
  steer?: number;
  /** 0 closed, 1 fully open: DRS flap and the front wing's X-mode together. */
  drs?: number;
}

/** Per-LOD-tier cost, measured off the built scene graph rather than declared. */
interface Stats {
  quality: string;
  /** Draw calls the renderer actually issued for the last frame. */
  drawCalls: number;
  triangles: number;
  /** Vertices summed over every unique geometry reachable from the car root. */
  vertices: number;
  /** Per-mesh breakdown, largest first. */
  parts: { name: string; verts: number; tris: number }[];
}

const canvas = document.getElementById('view') as HTMLCanvasElement;

const SHOT_W = 1280;
const SHOT_H = 800;
canvas.width = SHOT_W;
canvas.height = SHOT_H;
canvas.style.width = `${SHOT_W}px`;
canvas.style.height = `${SHOT_H}px`;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(SHOT_W, SHOT_H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, SHOT_W / SHOT_H, 0.05, 400);

const probe = new EnvProbe(renderer);

/** Copied from `Renderer`, which is the only reason these shots mean anything. */
const EXPOSURE: Record<Ambience, number> = { day: 1.35, dusk: 1.4, night: 1.7 };

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a3a30, 0.75);
const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
const fill = new THREE.DirectionalLight(0xbcd2f2, 0.55);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -6;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0006;
scene.add(hemi, sun, sun.target, fill, rim);

/** A patch of asphalt, so the car has something to stand on and reflect. */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.92, metalness: 0.0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

function applyAmbience(a: Ambience): void {
  if (a === 'night') {
    hemi.color.setHex(0x6d7c96);
    hemi.groundColor.setHex(0x3a3c45);
    hemi.intensity = 1.85;
    sun.color.setHex(0xfff4de);
    sun.intensity = 0.75;
    sun.position.set(6, 30, 4);
    fill.color.setHex(0xa8bcdc);
    fill.intensity = 0.78;
    rim.color.setHex(0xfff0d4);
    rim.intensity = 1.0;
  } else if (a === 'dusk') {
    hemi.color.setHex(0xffb98a);
    hemi.groundColor.setHex(0x2a1e22);
    hemi.intensity = 0.6;
    sun.color.setHex(0xffa04c);
    sun.intensity = 2.0;
    sun.position.set(-25, 3.5, 6);
    fill.color.setHex(0x7c92d0);
    fill.intensity = 0.42;
    rim.color.setHex(0xffd0a0);
    rim.intensity = 1.1;
  } else {
    hemi.color.setHex(0xcfe0ff);
    hemi.groundColor.setHex(0x3a3a30);
    hemi.intensity = 0.75;
    sun.color.setHex(0xfff4e2);
    sun.intensity = 2.6;
    sun.position.set(-11, 20, 9);
    fill.color.setHex(0xbcd2f2);
    fill.intensity = 0.55;
    rim.color.setHex(0xdfe8ff);
    rim.intensity = 0.9;
  }
  // The game's own directional positions are hundreds of metres out, which is
  // wrong for a 6m shadow frustum; the DIRECTIONS above are the same.
  fill.position.set(9, 7, -12);
  rim.position.set(3, 4, -14);
  ground.material.color.setHex(a === 'night' ? 0x24262b : 0x3a3d42);
  renderer.toneMappingExposure = EXPOSURE[a];
  probe.apply(scene, a, 0);
}

let car: CarVisual | null = null;
let stats: Stats = { quality: '-', drawCalls: 0, triangles: 0, vertices: 0, parts: [] };

function measure(root: THREE.Object3D, quality: string): Stats {
  const seen = new Set<THREE.BufferGeometry>();
  const parts: { name: string; verts: number; tris: number }[] = [];
  let vertices = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry as THREE.BufferGeometry;
    const v = g.attributes.position ? g.attributes.position.count : 0;
    const tris = g.index ? g.index.count / 3 : v / 3;
    // Unique geometries only: the four wheels share two, and the whole field
    // shares all of them. Counting them per instance would report a number
    // twenty times larger than the memory actually costs.
    if (!seen.has(g)) {
      seen.add(g);
      vertices += v;
      parts.push({ name: m.name || '(unnamed)', verts: v, tris: Math.round(tris) });
    }
  });
  parts.sort((a, b) => b.verts - a.verts);
  return {
    quality,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    vertices,
    parts,
  };
}

async function build(opts: BuildOpts): Promise<Stats> {
  if (car) {
    scene.remove(car.root);
    car.dispose();
    car = null;
  }
  const quality = opts.quality ?? 'high';
  applyAmbience(opts.ambience ?? 'day');
  car = buildCar(opts.colour ?? 0x1d4ed8, opts.accent ?? 0xf5c518, {
    quality,
    number: 16,
    code: 'AUD',
    compound: opts.compound ?? 'soft',
  });
  scene.add(car.root);
  // The shell sits with its wheel centres at y = tyreRadius already.
  const steer = opts.steer ?? 0;
  car.frontLeftSteer.rotation.y = steer;
  car.frontRightSteer.rotation.y = steer;
  const drs = opts.drs ?? 0;
  car.drsFlap.rotation.x = -0.62 * drs;
  car.frontFlaps.rotation.x = -0.20 * drs;
  // Name the meshes so the cost breakdown is readable.
  let i = 0;
  car.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.name) o.name = `mesh${i++}`;
  });
  renderer.render(scene, camera);
  stats = measure(car.root, quality);
  return stats;
}

/**
 * Camera stations, in metres, aimed at a point on the car.
 *
 * Every one of them is a shot somebody has complained about. `wheelFront` and
 * `rimClose` are the tyre and rim; `susFront` and `susRear` are the wishbone
 * topology; `rearWing` is the flap and the beam wing; `airbox` is the roll
 * hoop. The four three-quarter views are the ones the eye judges proportion
 * from.
 */
const VIEWS = {
  hero: { pos: [5.6, 1.9, 5.4], at: [0, 0.5, 0.1], fov: 34 },
  rear34: { pos: [4.6, 1.8, -5.6], at: [0, 0.55, -0.5], fov: 34 },
  front34Low: { pos: [4.4, 0.75, 5.0], at: [0, 0.42, 0.6], fov: 34 },
  side: { pos: [9.5, 0.85, 0.0], at: [0, 0.52, 0.0], fov: 24 },
  front: { pos: [0.0, 0.75, 8.4], at: [0, 0.5, 0.6], fov: 24 },
  rear: { pos: [0.0, 0.9, -8.4], at: [0, 0.55, -0.6], fov: 24 },
  top: { pos: [0.02, 8.0, 0.4], at: [0, 0.35, 0.0], fov: 34 },
  wheelFront: { pos: [2.55, 0.62, 2.35], at: [0.8, 0.36, 1.8], fov: 26 },
  rimClose: { pos: [2.1, 0.42, 1.82], at: [0.78, 0.36, 1.8], fov: 30 },
  susFront: { pos: [1.9, 1.15, 2.9], at: [0.5, 0.35, 1.8], fov: 34 },
  susRear: { pos: [2.0, 1.1, -2.9], at: [0.5, 0.35, -1.8], fov: 34 },
  rearWing: { pos: [2.2, 1.5, -4.3], at: [0, 0.85, -2.15], fov: 30 },
  rearWingSide: { pos: [4.4, 1.05, -2.1], at: [0, 0.82, -2.12], fov: 20 },
  airbox: { pos: [2.0, 1.55, -0.4], at: [0, 0.78, -0.6], fov: 34 },
  frontWing: { pos: [1.9, 0.5, 4.2], at: [0, 0.2, 2.9], fov: 30 },
  cockpit: { pos: [1.5, 1.35, 1.5], at: [0, 0.62, 0.35], fov: 34 },
  floor: { pos: [3.2, 0.22, -1.4], at: [0, 0.18, 0.4], fov: 30 },
} as const;

type ViewName = keyof typeof VIEWS;

interface ShotOpts {
  /** Overrides the preset's field of view. */
  fov?: number;
}

async function shoot(view: ViewName, opts: ShotOpts = {}): Promise<string> {
  const v = VIEWS[view];
  camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
  camera.lookAt(v.at[0], v.at[1], v.at[2]);
  camera.fov = opts.fov ?? v.fov;
  camera.updateProjectionMatrix();
  sun.target.position.set(0, 0.4, 0);
  sun.target.updateMatrixWorld(true);
  renderer.render(scene, camera);
  const png = canvas.toDataURL('image/png');
  stats = { ...stats, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  return png;
}

window.__car = {
  build,
  shoot,
  views: Object.keys(VIEWS) as ViewName[],
  stats: () => stats,
};
