import * as THREE from 'three';
import { buildSafetyCar } from '../src/render/SafetyCarMesh';
import { EnvProbe, type Ambience } from '../src/render/EnvProbe';

/**
 * The safety car, photographed.
 *
 * WHY THIS EXISTS. Nothing in `scripts/` has ever photographed the safety car.
 * `audit:circuits` shoots cars on the racing line, `audit:car` shoots the
 * Formula 1 car in a garage rig, and the safety car is only ever drawn by
 * `Renderer.syncSafetyCar` while a neutralisation is running — so the one
 * vehicle the whole field queues behind, with the broadcast camera on it, had
 * no picture anywhere in this repository. That is how its bodywork sat at
 * `metalness 0.35` through five audits.
 *
 * It builds the REAL `buildSafetyCar` under a light rig copied value for value
 * from `audit/car.ts`, which is itself copied from `Renderer.applyAmbience` —
 * so the shot is of the real object under the real lighting, not of a bespoke
 * viewer. It is deliberately small: this is the missing picture, not a new
 * audit suite.
 */

declare global {
  interface Window {
    __materials: { build(q?: 'low' | 'high'): void; shoot(v: string): string };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const SHOT_W = 1280;
const SHOT_H = 800;
canvas.width = SHOT_W;
canvas.height = SHOT_H;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(SHOT_W, SHOT_H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, SHOT_W / SHOT_H, 0.05, 400);
const probe = new EnvProbe(renderer);

/** Copied from `audit/car.ts`, which copied it from `Renderer`. */
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a3a30, 0.75);
const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
const fill = new THREE.DirectionalLight(0xbcd2f2, 0.55);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -8;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.004;
sun.position.set(-11, 20, 9);
fill.position.set(9, 7, -12);
rim.position.set(3, 4, -14);
scene.add(hemi, sun, sun.target, fill, rim);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.92, metalness: 0.0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const AMBIENCE: Ambience = 'day';
renderer.toneMappingExposure = 1.35;
probe.apply(scene, AMBIENCE, 0);

let car: { root: THREE.Group; dispose(): void } | null = null;

function build(quality: 'low' | 'high' = 'high'): void {
  if (car) { scene.remove(car.root); car.dispose(); car = null; }
  const built = buildSafetyCar(quality);
  car = built;
  built.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  scene.add(built.root);
  renderer.render(scene, camera);
}

/** Stations that show the painted flank, the roof and the three-quarter. */
const VIEWS: Record<string, { pos: number[]; at: number[]; fov: number }> = {
  hero: { pos: [6.4, 2.1, 6.2], at: [0, 0.75, 0], fov: 34 },
  side: { pos: [11.0, 1.15, 0.0], at: [0, 0.75, 0], fov: 26 },
  front34: { pos: [5.0, 1.35, 6.6], at: [0, 0.70, 0.8], fov: 32 },
  roof: { pos: [0.05, 7.0, 3.2], at: [0, 0.60, 0], fov: 40 },
};

function shoot(view: string): string {
  const v = VIEWS[view];
  camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
  camera.lookAt(v.at[0], v.at[1], v.at[2]);
  camera.fov = v.fov;
  camera.updateProjectionMatrix();
  sun.target.position.set(0, 0.6, 0);
  sun.target.updateMatrixWorld(true);
  renderer.render(scene, camera);
  return canvas.toDataURL('image/png');
}

window.__materials = { build, shoot };
