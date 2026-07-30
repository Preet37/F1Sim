import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural low-poly Formula 1 car.
 *
 * Built from primitives rather than loaded from a model file: it costs no
 * download, it takes the team's livery colours as parameters, and at the scale a
 * racing camera actually sees the car the silhouette is what reads — the front
 * wing, the sidepods, the airbox, the rear wing and the exposed wheels.
 *
 * DRAW CALLS ARE THE POINT OF THIS FILE'S DESIGN. Assembled as separate meshes,
 * one car is about thirteen draw calls and a twenty-car grid is 260 — measured at
 * 271 total, which no phone will render at 60fps. So every part of the car that
 * does not move independently is merged into ONE geometry with the livery baked
 * into vertex colours, leaving only the four wheels and the DRS flap separate.
 * That is six draw calls per car instead of thirteen, and the merged body geometry
 * is cached per livery, so ten teams share ten geometries across twenty cars.
 */

export interface CarVisual {
  root: THREE.Group;
  frontLeft: THREE.Object3D;
  frontRight: THREE.Object3D;
  rearLeft: THREE.Object3D;
  rearRight: THREE.Object3D;
  /** The rear wing flap, rotated open when DRS is active. */
  drsFlap: THREE.Object3D;
  /** Brake glow discs, brightened under heavy braking. */
  brakeGlow: THREE.Mesh[];
  /** Frees the per-car material. Shared geometry is freed by the cache. */
  dispose(): void;
}

/** Real F1 dimensions: ~5.6m long, 2.0m wide. */
const LENGTH = 5.6;
const WIDTH = 2.0;

/** One part of the car, before merging. */
interface Part {
  geo: THREE.BufferGeometry;
  colour: number;
  x: number; y: number; z: number;
  rx?: number; ry?: number; rz?: number;
}

const CARBON = 0x14161a;
const VISOR = 0x1c1f26;

/**
 * Describes the whole car body. Colour 0 means "livery primary", 1 means
 * "livery accent"; anything else is a literal colour.
 */
function bodyParts(): Part[] {
  const wingZ = -LENGTH * 0.4;
  return [
    // Floor and tub
    { geo: new THREE.BoxGeometry(WIDTH * 0.82, 0.05, 3.9), colour: CARBON, x: 0, y: 0.09, z: -0.2 },
    { geo: new THREE.BoxGeometry(0.72, 0.36, 2.5), colour: 0, x: 0, y: 0.36, z: -0.15 },

    // Nose and front wing
    { geo: new THREE.CylinderGeometry(0.1, 0.3, 1.9, 6), colour: 0, x: 0, y: 0.3, z: 1.45, rx: Math.PI / 2 },
    { geo: new THREE.BoxGeometry(WIDTH * 0.92, 0.07, 0.62), colour: 1, x: 0, y: 0.12, z: LENGTH * 0.42 },
    { geo: new THREE.BoxGeometry(0.06, 0.26, 0.6), colour: 1, x: -WIDTH * 0.46, y: 0.22, z: LENGTH * 0.42 },
    { geo: new THREE.BoxGeometry(0.06, 0.26, 0.6), colour: 1, x: WIDTH * 0.46, y: 0.22, z: LENGTH * 0.42 },

    // Sidepods
    { geo: new THREE.BoxGeometry(0.5, 0.42, 1.9), colour: 0, x: -0.62, y: 0.32, z: -0.25 },
    { geo: new THREE.BoxGeometry(0.5, 0.42, 1.9), colour: 0, x: 0.62, y: 0.32, z: -0.25 },

    // Halo and driver
    { geo: new THREE.TorusGeometry(0.42, 0.045, 4, 10, Math.PI), colour: 0x0c0d10, x: 0, y: 0.66, z: 0.42, rx: -Math.PI / 2, rz: Math.PI },
    { geo: new THREE.SphereGeometry(0.17, 8, 6), colour: VISOR, x: 0, y: 0.62, z: 0.25 },

    // Airbox and engine cover
    { geo: new THREE.BoxGeometry(0.44, 0.42, 0.6), colour: 1, x: 0, y: 0.68, z: -0.28 },
    { geo: new THREE.CylinderGeometry(0.26, 0.13, 1.9, 6), colour: 0, x: 0, y: 0.44, z: -1.25, rx: Math.PI / 2 },

    // Rear wing (the flap itself stays separate so DRS can open it)
    { geo: new THREE.BoxGeometry(WIDTH * 0.62, 0.06, 0.34), colour: 1, x: 0, y: 0.86, z: wingZ },
    { geo: new THREE.BoxGeometry(0.05, 0.62, 0.5), colour: 1, x: -WIDTH * 0.31, y: 0.72, z: wingZ },
    { geo: new THREE.BoxGeometry(0.05, 0.62, 0.5), colour: 1, x: WIDTH * 0.31, y: 0.72, z: wingZ },
    { geo: new THREE.BoxGeometry(WIDTH * 0.7, 0.24, 0.5), colour: CARBON, x: 0, y: 0.16, z: -LENGTH * 0.46 },
  ];
}

/** Wheel geometry, shared by every car. Axis along X so rotation.x spins it. */
interface WheelGeo {
  tyre: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
}
let wheelGeo: WheelGeo | null = null;

function wheels(): WheelGeo {
  if (wheelGeo) return wheelGeo;
  const tyre = new THREE.CylinderGeometry(0.36, 0.36, 0.38, 12);
  const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.39, 8);
  const disc = new THREE.CylinderGeometry(0.24, 0.24, 0.04, 10);
  tyre.rotateZ(Math.PI / 2);
  rim.rotateZ(Math.PI / 2);
  disc.rotateZ(Math.PI / 2);
  // Tyre and rim merge into one wheel mesh: they never move relative to each
  // other, so keeping them separate would double the grid's wheel draw calls.
  const merged = mergeGeometries([tyre, rim], false);
  tyre.dispose();
  rim.dispose();
  wheelGeo = {
    tyre: merged ?? new THREE.CylinderGeometry(0.36, 0.36, 0.38, 12),
    rim: new THREE.BufferGeometry(),
    disc,
    flap: new THREE.BoxGeometry(WIDTH * 0.6, 0.045, 0.24),
  };
  return wheelGeo;
}

/** Merged body geometry per livery, keyed by the two colours. */
const bodyCache = new Map<string, THREE.BufferGeometry>();
const sharedMaterials: Record<string, THREE.Material> = {};

function material(key: string, make: () => THREE.Material): THREE.Material {
  const existing = sharedMaterials[key];
  if (existing) return existing;
  const m = make();
  sharedMaterials[key] = m;
  return m;
}

/**
 * Merges the body into one geometry with the livery baked into vertex colours.
 * Cached, so cars sharing a livery share the geometry.
 */
function bodyGeometryFor(bodyColour: number, accentColour: number): THREE.BufferGeometry {
  const key = bodyColour + ':' + accentColour;
  const cached = bodyCache.get(key);
  if (cached) return cached;

  const parts = bodyParts();
  const transformed: THREE.BufferGeometry[] = [];
  const tmpColour = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  for (const part of parts) {
    const geo = part.geo;
    euler.set(part.rx ?? 0, part.ry ?? 0, part.rz ?? 0);
    quat.setFromEuler(euler);
    pos.set(part.x, part.y, part.z);
    matrix.compose(pos, quat, one);
    geo.applyMatrix4(matrix);

    // Bake the colour into a per-vertex attribute so one material covers the
    // whole body.
    const resolved = part.colour === 0 ? bodyColour : part.colour === 1 ? accentColour : part.colour;
    tmpColour.setHex(resolved);
    const count = geo.attributes.position.count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colours[i * 3] = tmpColour.r;
      colours[i * 3 + 1] = tmpColour.g;
      colours[i * 3 + 2] = tmpColour.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    // mergeGeometries requires matching attribute sets; drop UVs, which nothing
    // here uses.
    geo.deleteAttribute('uv');
    transformed.push(geo);
  }

  const merged = mergeGeometries(transformed, false);
  for (const g of transformed) g.dispose();

  const result = merged ?? new THREE.BoxGeometry(1, 1, 1);
  bodyCache.set(key, result);
  return result;
}

export function buildCar(bodyColour: number, accentColour: number): CarVisual {
  const root = new THREE.Group();
  const w = wheels();

  // One material for the whole body; the livery lives in the vertex colours.
  const bodyMat = material('body', () => new THREE.MeshLambertMaterial({ vertexColors: true }));
  const rubber = material('rubber', () => new THREE.MeshLambertMaterial({ color: 0x121317 }));

  const body = new THREE.Mesh(bodyGeometryFor(bodyColour, accentColour), bodyMat);
  root.add(body);

  // DRS flap, on a pivot at its leading edge so opening rotates rather than slides.
  const accentMat = new THREE.MeshLambertMaterial({ color: accentColour });
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0, 1.0, -LENGTH * 0.4 + 0.06);
  const flap = new THREE.Mesh(w.flap, accentMat);
  flap.position.set(0, 0, -0.12);
  flapPivot.add(flap);
  root.add(flapPivot);

  const brakeGlow: THREE.Mesh[] = [];
  const makeWheel = (x: number, z: number): THREE.Group => {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0.36, z);
    wheel.add(new THREE.Mesh(w.tyre, rubber));

    // Brake disc glows under load. MeshBasic so it reads at night without a light.
    const discMat = new THREE.MeshBasicMaterial({ color: 0x201410 });
    const disc = new THREE.Mesh(w.disc, discMat);
    disc.position.x = x > 0 ? -0.04 : 0.04;
    wheel.add(disc);
    brakeGlow.push(disc);

    root.add(wheel);
    return wheel;
  };

  const halfTrack = WIDTH * 0.5 - 0.19;
  const frontZ = LENGTH * 0.29;
  const rearZ = -LENGTH * 0.27;

  const frontLeft = makeWheel(-halfTrack, frontZ);
  const frontRight = makeWheel(halfTrack, frontZ);
  const rearLeft = makeWheel(-halfTrack, rearZ);
  const rearRight = makeWheel(halfTrack, rearZ);

  return {
    root, frontLeft, frontRight, rearLeft, rearRight,
    drsFlap: flapPivot, brakeGlow,
    dispose(): void {
      accentMat.dispose();
      for (const d of brakeGlow) (d.material as THREE.Material).dispose();
    },
  };
}

/** Disposes the shared geometry and material caches. Call on teardown. */
export function disposeCarGeometryCache(): void {
  for (const g of bodyCache.values()) g.dispose();
  bodyCache.clear();
  if (wheelGeo) {
    wheelGeo.tyre.dispose();
    wheelGeo.rim.dispose();
    wheelGeo.disc.dispose();
    wheelGeo.flap.dispose();
    wheelGeo = null;
  }
  for (const key of Object.keys(sharedMaterials)) {
    sharedMaterials[key].dispose();
    delete sharedMaterials[key];
  }
}
