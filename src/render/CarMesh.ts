import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loft, wingElement, type Section } from './Loft';
import { buildCockpit, type CockpitVisual } from './CockpitMesh';

/**
 * Formula 1 car, built procedurally from lofted cross-sections and aerofoils.
 *
 * The first version of this file assembled the car from BoxGeometry primitives.
 * It was unmistakably a pile of boxes, because a modern F1 car has essentially no
 * flat surfaces and no hard 90-degree edges — the monocoque tapers continuously,
 * the sidepods undercut, the nose is a cone, and every wing is a cambered
 * aerofoil. No number of boxes fixes that; the primitive is wrong.
 *
 * So the body is lofted through cross-sections with averaged normals, the wings
 * are real aerofoil extrusions, and the materials are physically-based with an
 * environment map. Those three things — curvature, smooth shading, reflections —
 * are what separate a car that reads as a car from one that reads as programmer
 * art.
 *
 * DRAW CALLS still matter: twenty cars must not cost 260 calls. Everything that
 * does not move independently is merged into one geometry per livery and cached,
 * leaving the four wheels and the DRS flap separate. Six calls per car.
 */

export interface CarVisual {
  root: THREE.Group;
  /**
   * Front wheels are a STEER group containing a SPIN group.
   *
   * They cannot be the same object. With Euler XYZ order, applying steer about Y
   * to an object that has already accumulated spin about X means the steering
   * axis is no longer vertical, so the wheels visibly tilt and wobble instead of
   * turning. Nesting keeps the two rotations independent.
   */
  frontLeftSteer: THREE.Object3D;
  frontRightSteer: THREE.Object3D;
  frontLeftSpin: THREE.Object3D;
  frontRightSpin: THREE.Object3D;
  rearLeftSpin: THREE.Object3D;
  rearRightSpin: THREE.Object3D;
  drsFlap: THREE.Object3D;
  brakeGlow: THREE.Mesh[];
  /** Contact shadow under the car, scaled with speed for a little squash. */
  shadow: THREE.Mesh;
  /**
   * The driver's helmet, as a separate mesh, for cars that can be sat in.
   * Null for every other car, whose head is merged into the body.
   */
  driverHead: THREE.Mesh | null;
  /** Cockpit furniture, or null if this car was not built for the inside view. */
  cockpit: CockpitVisual | null;
  /** Shows or hides the cockpit interior, swapping the driver's head out with it. */
  setCockpitVisible(v: boolean): void;
  dispose(): void;
}

const LENGTH = 5.6;
const WIDTH = 2.0;

/** 18-inch wheels with low-profile tyres: 0.36m rolling radius, 0.36m wide. */
const TYRE_R = 0.36;
const TYRE_W = 0.365;
const RIM_R = 0.229;

const CARBON = 0x0e1013;
const DARK_TRIM = 0x1a1d22;

/**
 * Halo hoop geometry, shared with the cockpit camera.
 *
 * The hoop has to clear the driver's helmet (top at ~0.82m) and sit above the
 * eye point the cockpit camera uses, or it cuts the view in half instead of
 * arcing over it.
 */
const HALO_Y = 0.90;
const HALO_Z = 0.22;
const HALO_R = 0.40;

/** A tapered cylinder running between two points. Used for struts and arms. */
function strutGeo(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1 = r0,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, 8);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

// ===========================================================================
// Body: lofted monocoque
// ===========================================================================

/**
 * Cross-sections from the nose tip to the rear crash structure.
 *
 * These are the numbers that make it look like an F1 car rather than a generic
 * open-wheeler: a very low, narrow nose tip; a rapid rise into the chassis; the
 * cockpit opening as a flat-topped section; a broad shoulder over the fuel cell;
 * then a long taper to a slim rear.
 */
function monocoqueSections(): Section[] {
  return [
    { z: 2.86, halfWidth: 0.055, height: 0.10, y: 0.20, round: 1.0 },
    { z: 2.55, halfWidth: 0.105, height: 0.15, y: 0.215, round: 0.95 },
    { z: 2.15, halfWidth: 0.155, height: 0.21, y: 0.245, round: 0.88 },
    { z: 1.70, halfWidth: 0.205, height: 0.27, y: 0.285, round: 0.8 },
    { z: 1.25, halfWidth: 0.255, height: 0.33, y: 0.33, round: 0.72 },
    { z: 0.85, halfWidth: 0.30, height: 0.40, y: 0.375, round: 0.62 },
    // Cockpit opening: flat-topped, widest point of the survival cell.
    { z: 0.45, halfWidth: 0.335, height: 0.46, y: 0.40, round: 0.5, flatTop: 0.55 },
    { z: 0.05, halfWidth: 0.345, height: 0.50, y: 0.415, round: 0.45, flatTop: 0.7 },
    { z: -0.35, halfWidth: 0.335, height: 0.54, y: 0.43, round: 0.45, flatTop: 0.35 },
    // Over the fuel cell and engine.
    { z: -0.85, halfWidth: 0.305, height: 0.58, y: 0.44, round: 0.55 },
    { z: -1.35, halfWidth: 0.255, height: 0.55, y: 0.435, round: 0.65 },
    { z: -1.85, halfWidth: 0.195, height: 0.46, y: 0.415, round: 0.75 },
    { z: -2.25, halfWidth: 0.135, height: 0.34, y: 0.375, round: 0.85 },
    { z: -2.60, halfWidth: 0.085, height: 0.22, y: 0.33, round: 0.95 },
  ];
}

/** Sidepod: a wide inlet that undercuts hard and tapers into the coke bottle. */
function sidepodSections(side: number): Section[] {
  const x = side * 0.63;
  const mk = (z: number, hw: number, h: number, y: number, round: number, undercut: number): Section =>
    ({ z, halfWidth: hw, height: h, y, round, undercut });
  const s = [
    mk(0.62, 0.055, 0.30, 0.40, 0.5, 0.9),
    mk(0.45, 0.20, 0.42, 0.40, 0.4, 0.55),
    mk(0.05, 0.235, 0.46, 0.395, 0.45, 0.42),
    mk(-0.45, 0.22, 0.44, 0.39, 0.5, 0.38),
    mk(-0.95, 0.175, 0.40, 0.385, 0.6, 0.4),
    mk(-1.45, 0.11, 0.32, 0.375, 0.7, 0.5),
    mk(-1.85, 0.05, 0.22, 0.36, 0.85, 0.7),
  ];
  // Offset laterally by translating after the loft; sections are centred on x=0.
  return s.map((sec) => ({ ...sec, _x: x }) as Section & { _x: number });
}

interface Part {
  geo: THREE.BufferGeometry;
  colour: number;
}

/**
 * The driver's head, as its own set of parts.
 *
 * Split out so it can be built into a separate mesh for the player's car and
 * hidden while the cockpit camera is active. The eye point is, by definition,
 * inside the helmet; leaving it in place means the cockpit camera looks at the
 * back of the visor, or (with backfaces culled) at a hole punched through the
 * middle of the world.
 */
function driverParts(accentColour: number): Part[] {
  const helmet = new THREE.SphereGeometry(0.155, 16, 12);
  helmet.scale(1, 1.05, 1.12);
  helmet.translate(0, 0.66, 0.05);

  const visor = new THREE.SphereGeometry(0.157, 16, 8, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.2);
  visor.scale(1, 1.05, 1.12);
  visor.translate(0, 0.66, 0.05);

  return [
    { geo: helmet, colour: accentColour },
    { geo: visor, colour: 0x08090d },
  ];
}

/** Assembles every static part of the car, ready to merge. */
function buildParts(bodyColour: number, accentColour: number, includeDriver = true): Part[] {
  const parts: Part[] = [];
  const add = (geo: THREE.BufferGeometry, colour: number): void => { parts.push({ geo, colour }); };

  // --- Monocoque --------------------------------------------------------
  add(loft(monocoqueSections(), 22), bodyColour);

  // --- Sidepods ---------------------------------------------------------
  for (const side of [-1, 1] as const) {
    const secs = sidepodSections(side) as (Section & { _x: number })[];
    const g = loft(secs, 18);
    g.translate(secs[0]._x, 0, 0);
    add(g, bodyColour);
  }

  // --- Floor and diffuser -----------------------------------------------
  {
    const floor = loft([
      { z: 2.0, halfWidth: 0.30, height: 0.05, y: 0.075, round: 0.3 },
      { z: 1.0, halfWidth: 0.62, height: 0.055, y: 0.075, round: 0.25 },
      { z: 0.0, halfWidth: 0.80, height: 0.06, y: 0.07, round: 0.2 },
      { z: -1.2, halfWidth: 0.80, height: 0.06, y: 0.07, round: 0.2 },
      { z: -2.0, halfWidth: 0.72, height: 0.10, y: 0.10, round: 0.25 },
      { z: -2.55, halfWidth: 0.62, height: 0.30, y: 0.20, round: 0.3 },
    ], 16);
    add(floor, CARBON);
  }

  // --- Nose cone tip ----------------------------------------------------
  // A separate darker tip reads as the crash structure and breaks up the nose.
  {
    const tip = loft([
      { z: 2.95, halfWidth: 0.035, height: 0.07, y: 0.195, round: 1 },
      { z: 2.86, halfWidth: 0.055, height: 0.10, y: 0.20, round: 1 },
    ], 16);
    add(tip, accentColour);
  }

  // --- Front wing -------------------------------------------------------
  // Four elements of increasing chord, stacked and staggered, as a real
  // multi-element front wing is.
  {
    const frontZ = LENGTH * 0.435;
    for (let i = 0; i < 4; i++) {
      const chord = 0.15 + i * 0.055;
      const g = wingElement(WIDTH * 0.95, chord, 0.1, 0.035, 10);
      g.translate(0, 0.075 + i * 0.043, frontZ - i * 0.105);
      add(g, i === 3 ? accentColour : bodyColour);
    }
    // Endplates: swept outward and upward.
    for (const side of [-1, 1] as const) {
      const ep = loft([
        { z: frontZ + 0.12, halfWidth: 0.022, height: 0.16, y: 0.11, round: 0.3 },
        { z: frontZ - 0.10, halfWidth: 0.028, height: 0.30, y: 0.17, round: 0.25 },
        { z: frontZ - 0.34, halfWidth: 0.030, height: 0.34, y: 0.20, round: 0.25 },
      ], 12);
      ep.translate(side * WIDTH * 0.475, 0, 0);
      add(ep, accentColour);
    }
    // Nose pillars connecting wing to nose.
    for (const side of [-1, 1] as const) {
      const p = new THREE.CylinderGeometry(0.022, 0.028, 0.16, 6);
      p.translate(side * 0.10, 0.175, frontZ - 0.16);
      add(p, CARBON);
    }
  }

  // --- Airbox -----------------------------------------------------------
  {
    const airbox = loft([
      { z: -0.10, halfWidth: 0.10, height: 0.15, y: 0.70, round: 0.55 },
      { z: -0.30, halfWidth: 0.155, height: 0.26, y: 0.72, round: 0.5 },
      { z: -0.62, halfWidth: 0.175, height: 0.30, y: 0.70, round: 0.55 },
      { z: -1.00, halfWidth: 0.16, height: 0.26, y: 0.66, round: 0.65 },
    ], 16);
    add(airbox, accentColour);

    // Intake mouth, dark, so it reads as an opening rather than a lump.
    const mouth = loft([
      { z: -0.11, halfWidth: 0.075, height: 0.11, y: 0.70, round: 0.7 },
      { z: -0.22, halfWidth: 0.065, height: 0.095, y: 0.705, round: 0.75 },
    ], 12);
    add(mouth, 0x05060a);
  }

  // --- Engine cover and shark fin ---------------------------------------
  {
    const fin = loft([
      { z: -1.15, halfWidth: 0.016, height: 0.20, y: 0.62, round: 0.2 },
      { z: -1.70, halfWidth: 0.014, height: 0.30, y: 0.62, round: 0.2 },
      { z: -2.15, halfWidth: 0.012, height: 0.26, y: 0.66, round: 0.2 },
    ], 10);
    add(fin, bodyColour);
  }

  // --- Rear wing --------------------------------------------------------
  {
    const wingZ = -LENGTH * 0.435;
    // Main plane.
    const main = wingElement(WIDTH * 0.52, 0.28, 0.11, 0.05, 12);
    main.translate(0, 0.92, wingZ);
    add(main, accentColour);

    // Endplates.
    for (const side of [-1, 1] as const) {
      const ep = loft([
        { z: wingZ + 0.26, halfWidth: 0.020, height: 0.42, y: 0.80, round: 0.2 },
        { z: wingZ - 0.02, halfWidth: 0.024, height: 0.56, y: 0.80, round: 0.18 },
        { z: wingZ - 0.28, halfWidth: 0.020, height: 0.50, y: 0.82, round: 0.2 },
      ], 12);
      ep.translate(side * WIDTH * 0.26, 0, 0);
      add(ep, accentColour);
    }

    // Swan-neck pylon.
    const pylon = loft([
      { z: -2.05, halfWidth: 0.035, height: 0.10, y: 0.58, round: 0.35 },
      { z: -2.25, halfWidth: 0.030, height: 0.09, y: 0.78, round: 0.35 },
      { z: wingZ + 0.02, halfWidth: 0.028, height: 0.08, y: 0.92, round: 0.35 },
    ], 10);
    add(pylon, CARBON);

    // Beam wing below.
    const beam = wingElement(WIDTH * 0.42, 0.16, 0.10, 0.03, 8);
    beam.translate(0, 0.50, wingZ + 0.06);
    add(beam, CARBON);
  }

  // --- Halo -------------------------------------------------------------
  //
  // The halo is the single most recognisable feature of a modern F1 car and the
  // dominant object in any onboard shot, so it is worth getting the geometry
  // right rather than approximating it with a flat arc at cockpit-rim height.
  //
  // The real thing is a closed titanium hoop that clears the driver's helmet,
  // carried on one central pillar in front of the driver's face and two mounts
  // on the chassis flanks behind them. It is tessellated finely because at
  // cockpit range — half a metre from the camera — a twenty-segment torus reads
  // as a polygon, and this same geometry is what the cockpit camera looks at.
  {
    const hoop = new THREE.TorusGeometry(HALO_R, 0.036, 10, 40);
    hoop.rotateX(-Math.PI / 2);
    hoop.translate(0, HALO_Y, HALO_Z);
    add(hoop, DARK_TRIM);

    // Central pillar, straight down the middle of the driver's view.
    add(strutGeo(0, HALO_Y - 0.005, HALO_Z + HALO_R - 0.005, 0, 0.545, 0.735, 0.034, 0.040), DARK_TRIM);

    // Rear mounts onto the chassis flanks.
    for (const side of [-1, 1] as const) {
      add(strutGeo(side * (HALO_R - 0.02), HALO_Y - 0.015, HALO_Z - 0.08, side * 0.30, 0.60, 0.02, 0.030, 0.038), DARK_TRIM);
    }
  }

  // --- Cockpit interior -------------------------------------------------
  {
    // Dark cockpit tub, so the opening reads as a hole rather than a decal.
    const tub = loft([
      { z: 0.60, halfWidth: 0.19, height: 0.10, y: 0.50, round: 0.5 },
      { z: 0.20, halfWidth: 0.215, height: 0.12, y: 0.50, round: 0.45 },
      { z: -0.22, halfWidth: 0.20, height: 0.11, y: 0.50, round: 0.5 },
    ], 14);
    add(tub, 0x0a0b0f);

    // Headrest. Stays on the body: it is behind the driver's eyes, so it never
    // needs hiding for the cockpit camera.
    const rest = loft([
      { z: -0.05, halfWidth: 0.20, height: 0.16, y: 0.56, round: 0.5 },
      { z: -0.26, halfWidth: 0.185, height: 0.14, y: 0.555, round: 0.55 },
    ], 12);
    add(rest, DARK_TRIM);

    if (includeDriver) for (const p of driverParts(accentColour)) parts.push(p);
  }

  // --- Suspension -------------------------------------------------------
  // Wishbones matter more than they sound: they fill the gap between body and
  // wheels, which is otherwise an obviously empty void.
  {
    const arm = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number) => {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const len = Math.hypot(dx, dy, dz);
      const g = new THREE.CylinderGeometry(r, r, len, 6);
      // Orient the cylinder's Y axis along the arm.
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx / len, dy / len, dz / len),
      );
      g.applyQuaternion(q);
      g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
      return g;
    };

    const hubX = WIDTH * 0.5 - TYRE_W * 0.5;
    for (const side of [-1, 1] as const) {
      const fz = LENGTH * 0.29;
      const rz = -LENGTH * 0.27;
      // Front upper and lower wishbones.
      add(arm(side * 0.26, 0.44, fz + 0.16, side * hubX, 0.46, fz, 0.026), DARK_TRIM);
      add(arm(side * 0.26, 0.20, fz - 0.14, side * hubX, 0.24, fz, 0.028), DARK_TRIM);
      // Trackrod.
      add(arm(side * 0.24, 0.30, fz - 0.24, side * hubX, 0.32, fz - 0.06, 0.018), DARK_TRIM);
      // Rear wishbones.
      add(arm(side * 0.24, 0.46, rz - 0.18, side * hubX, 0.46, rz, 0.028), DARK_TRIM);
      add(arm(side * 0.24, 0.20, rz + 0.16, side * hubX, 0.24, rz, 0.030), DARK_TRIM);
    }
  }

  // --- Mirrors ----------------------------------------------------------
  // Mounted forward on the chassis flanks, level with the cockpit opening.
  // Position is not arbitrary: a mirror behind the driver's shoulder is outside
  // even a 100-degree field of view, so a cockpit camera would never see it.
  // Real cars carry them here for the same reason.
  for (const side of [-1, 1] as const) {
    const stalk = new THREE.CylinderGeometry(0.013, 0.013, 0.17, 6);
    stalk.rotateZ(Math.PI / 2);
    stalk.translate(side * 0.375, 0.60, 0.70);
    add(stalk, DARK_TRIM);
    const housing = new THREE.BoxGeometry(0.115, 0.075, 0.03);
    housing.translate(side * 0.455, 0.625, 0.702);
    add(housing, bodyColour);
  }

  return parts;
}

// ===========================================================================
// Wheels
// ===========================================================================

interface WheelGeo {
  tyre: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
  shadow: THREE.BufferGeometry;
}
let wheelGeo: WheelGeo | null = null;

function wheels(): WheelGeo {
  if (wheelGeo) return wheelGeo;

  // Tyre as a lofted torus-ish profile: a real tyre has a crowned tread and
  // bulging sidewalls, and a plain cylinder is the second most obvious tell of a
  // procedural car after box wings.
  const RADIAL = 24;
  const profile: { r: number; x: number }[] = [
    { r: RIM_R + 0.005, x: -TYRE_W * 0.5 },
    { r: TYRE_R * 0.90, x: -TYRE_W * 0.5 },
    { r: TYRE_R * 0.995, x: -TYRE_W * 0.42 },
    { r: TYRE_R, x: -TYRE_W * 0.28 },
    { r: TYRE_R, x: TYRE_W * 0.28 },
    { r: TYRE_R * 0.995, x: TYRE_W * 0.42 },
    { r: TYRE_R * 0.90, x: TYRE_W * 0.5 },
    { r: RIM_R + 0.005, x: TYRE_W * 0.5 },
  ];

  const rings = profile.length;
  const positions = new Float32Array(rings * RADIAL * 3);
  for (let p = 0; p < rings; p++) {
    for (let i = 0; i < RADIAL; i++) {
      const a = (i / RADIAL) * Math.PI * 2;
      const o = (p * RADIAL + i) * 3;
      // Wheel axis along X so a rotation about X spins it.
      positions[o] = profile[p].x;
      positions[o + 1] = Math.sin(a) * profile[p].r;
      positions[o + 2] = Math.cos(a) * profile[p].r;
    }
  }
  const idx: number[] = [];
  for (let p = 0; p < rings - 1; p++) {
    const a = p * RADIAL;
    const b = (p + 1) * RADIAL;
    for (let i = 0; i < RADIAL; i++) {
      const j = (i + 1) % RADIAL;
      idx.push(a + i, b + i, b + j);
      idx.push(a + i, b + j, a + j);
    }
  }
  const tyre = new THREE.BufferGeometry();
  tyre.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tyre.setIndex(idx);
  tyre.computeVertexNormals();

  // Rim face with a hub, plus a wheel cover disc as current regulations require.
  const rimBarrel = new THREE.CylinderGeometry(RIM_R, RIM_R, TYRE_W * 0.98, RADIAL, 1, true);
  rimBarrel.rotateZ(Math.PI / 2);
  const coverL = new THREE.CircleGeometry(RIM_R, RADIAL);
  coverL.rotateY(-Math.PI / 2);
  coverL.translate(-TYRE_W * 0.49, 0, 0);
  const coverR = new THREE.CircleGeometry(RIM_R, RADIAL);
  coverR.rotateY(Math.PI / 2);
  coverR.translate(TYRE_W * 0.49, 0, 0);
  const rim = mergeGeometries([rimBarrel, coverL, coverR], false) ?? rimBarrel;
  rimBarrel.dispose();
  coverL.dispose();
  coverR.dispose();

  const disc = new THREE.CylinderGeometry(0.16, 0.16, 0.03, 20);
  disc.rotateZ(Math.PI / 2);

  const shadow = new THREE.PlaneGeometry(1, 1);
  shadow.rotateX(-Math.PI / 2);

  wheelGeo = {
    tyre, rim, disc,
    flap: wingElement(WIDTH * 0.5, 0.19, 0.09, 0.02, 10),
    shadow,
  };
  return wheelGeo;
}

// ===========================================================================
// Assembly
// ===========================================================================

const bodyCache = new Map<string, THREE.BufferGeometry>();
const sharedMaterials: Record<string, THREE.Material> = {};

function material(key: string, make: () => THREE.Material): THREE.Material {
  const existing = sharedMaterials[key];
  if (existing) return existing;
  const m = make();
  sharedMaterials[key] = m;
  return m;
}

/** Bakes a list of parts down to one vertex-coloured geometry. */
function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const tmp = new THREE.Color();
  const prepared: THREE.BufferGeometry[] = [];

  for (const part of parts) {
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    if (geo !== part.geo) part.geo.dispose();

    tmp.setHex(part.colour);
    // Convert to linear-light before baking: the renderer works in linear space,
    // and hex colours are sRGB. Skipping this washes every livery out.
    tmp.convertSRGBToLinear();

    const count = geo.attributes.position.count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colours[i * 3] = tmp.r;
      colours[i * 3 + 1] = tmp.g;
      colours[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geo.deleteAttribute('uv');
    if (!geo.attributes.normal) geo.computeVertexNormals();
    prepared.push(geo);
  }

  const merged = mergeGeometries(prepared, false);
  for (const g of prepared) g.dispose();

  const result = merged ?? new THREE.BoxGeometry(1, 1, 1);
  result.computeBoundingSphere();
  return result;
}

/**
 * Merged bodywork for one livery, cached.
 *
 * `withDriver` is part of the cache key: the player's car omits the helmet from
 * the body so it can be drawn — and hidden — separately.
 */
function bodyGeometryFor(bodyColour: number, accentColour: number, withDriver: boolean): THREE.BufferGeometry {
  const key = bodyColour + ':' + accentColour + ':' + (withDriver ? 'd' : 'x');
  const cached = bodyCache.get(key);
  if (cached) return cached;
  const result = mergeParts(buildParts(bodyColour, accentColour, withDriver));
  bodyCache.set(key, result);
  return result;
}

/** The driver's head as a standalone geometry, cached per accent colour. */
function driverGeometryFor(accentColour: number): THREE.BufferGeometry {
  const key = 'driver:' + accentColour;
  const cached = bodyCache.get(key);
  if (cached) return cached;
  const result = mergeParts(driverParts(accentColour));
  bodyCache.set(key, result);
  return result;
}

/**
 * Builds one car.
 *
 * @param withCockpit build the cockpit furniture (halo-adjacent trim, steering
 *                    wheel, hands, mirror glass) and split the driver's head
 *                    into its own hideable mesh. Only worth doing for the car
 *                    the cockpit camera can actually be inside.
 */
export function buildCar(bodyColour: number, accentColour: number, withCockpit = false): CarVisual {
  const root = new THREE.Group();
  const w = wheels();

  // Physically-based materials. Metalness and roughness plus an environment map
  // are what produce the highlights that read as painted bodywork; a Lambert
  // material cannot, no matter how good the geometry is.
  // Glossy painted bodywork. Low roughness plus a strong environment intensity is
  // what produces the tight highlight that runs along a flank as the car turns —
  // the single most recognisable property of a real racing car's paint. Matte
  // settings make even good geometry look like unpainted resin.
  const bodyMat = material('body', () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.55,
    roughness: 0.19,
    envMapIntensity: 1.9,
  }));
  // Tyres are the one part that must stay matte; a shiny tyre looks like plastic.
  const rubber = material('rubber', () => new THREE.MeshStandardMaterial({
    color: 0x0d0e12,
    metalness: 0.0,
    roughness: 0.92,
    envMapIntensity: 0.35,
  }));
  const rimMat = material('rim', () => new THREE.MeshStandardMaterial({
    color: 0x2b2f36,
    metalness: 0.85,
    roughness: 0.3,
  }));
  const shadowMat = material('shadow', () => new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  }));

  const body = new THREE.Mesh(bodyGeometryFor(bodyColour, accentColour, !withCockpit), bodyMat);
  body.castShadow = true;
  root.add(body);

  // The head, and the cockpit furniture behind it, only for a car the cockpit
  // camera can occupy.
  let driverHead: THREE.Mesh | null = null;
  let cockpit: CockpitVisual | null = null;
  if (withCockpit) {
    driverHead = new THREE.Mesh(driverGeometryFor(accentColour), bodyMat);
    driverHead.castShadow = true;
    root.add(driverHead);

    cockpit = buildCockpit(accentColour);
    root.add(cockpit.root);
  }

  // Contact shadow: a cheap dark ellipse that grounds the car even with real
  // shadows disabled on low-power devices.
  const shadow = new THREE.Mesh(w.shadow, shadowMat);
  shadow.scale.set(2.3, 1, 5.2);
  shadow.position.y = 0.012;
  shadow.renderOrder = -1;
  root.add(shadow);

  // DRS flap on a pivot at its leading edge.
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColour, metalness: 0.55, roughness: 0.19, envMapIntensity: 1.9,
  });
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0, 1.10, -LENGTH * 0.435 + 0.10);
  const flap = new THREE.Mesh(w.flap, accentMat);
  flap.position.set(0, 0, -0.10);
  flapPivot.add(flap);
  root.add(flapPivot);

  const brakeGlow: THREE.Mesh[] = [];

  /**
   * Builds a wheel as steer group -> spin group -> meshes.
   * The nesting is required; see the note on CarVisual.
   */
  const makeWheel = (x: number, z: number): { steer: THREE.Group; spin: THREE.Group } => {
    const steer = new THREE.Group();
    steer.position.set(x, TYRE_R, z);

    const spin = new THREE.Group();
    steer.add(spin);

    const tyre = new THREE.Mesh(w.tyre, rubber);
    tyre.castShadow = true;
    spin.add(tyre);
    spin.add(new THREE.Mesh(w.rim, rimMat));

    // Brake disc glows under load. Unlit so it reads at night.
    const discMat = new THREE.MeshBasicMaterial({ color: 0x1a1210 });
    const disc = new THREE.Mesh(w.disc, discMat);
    disc.position.x = x > 0 ? -0.05 : 0.05;
    // On the steer group, not the spin group: a brake disc does rotate with the
    // wheel, but the glow is what matters and a static disc avoids strobing.
    steer.add(disc);
    brakeGlow.push(disc);

    root.add(steer);
    return { steer, spin };
  };

  const hubX = WIDTH * 0.5 - TYRE_W * 0.5;
  const frontZ = LENGTH * 0.29;
  const rearZ = -LENGTH * 0.27;

  const fl = makeWheel(-hubX, frontZ);
  const fr = makeWheel(hubX, frontZ);
  const rl = makeWheel(-hubX, rearZ);
  const rr = makeWheel(hubX, rearZ);

  return {
    root,
    frontLeftSteer: fl.steer,
    frontRightSteer: fr.steer,
    frontLeftSpin: fl.spin,
    frontRightSpin: fr.spin,
    rearLeftSpin: rl.spin,
    rearRightSpin: rr.spin,
    drsFlap: flapPivot,
    brakeGlow,
    shadow,
    driverHead,
    cockpit,
    setCockpitVisible(v: boolean): void {
      if (!cockpit) return;
      cockpit.setVisible(v);
      // The driver's head and the eye point are the same place, so exactly one
      // of them can exist at a time.
      if (driverHead) driverHead.visible = !v;
    },
    dispose(): void {
      accentMat.dispose();
      cockpit?.dispose();
      for (const d of brakeGlow) (d.material as THREE.Material).dispose();
    },
  };
}

export function disposeCarGeometryCache(): void {
  for (const g of bodyCache.values()) g.dispose();
  bodyCache.clear();
  if (wheelGeo) {
    wheelGeo.tyre.dispose();
    wheelGeo.rim.dispose();
    wheelGeo.disc.dispose();
    wheelGeo.flap.dispose();
    wheelGeo.shadow.dispose();
    wheelGeo = null;
  }
  for (const key of Object.keys(sharedMaterials)) {
    sharedMaterials[key].dispose();
    delete sharedMaterials[key];
  }
}
