/**
 * The safety car, drawn.
 *
 * WHAT ONE ACTUALLY LOOKS LIKE. Not a Formula 1 car — that is the first thing
 * the player said and it is the whole design brief: "you have to look up how
 * safety cars look like and design and create one". Every safety car the sport
 * has used is a road-going performance coupé, and the proportions are what make
 * it read as one at a glance and from a long way away, because that is the only
 * distance the player ever sees it from:
 *
 *   IT IS TALL AND IT HAS A ROOF. An F1 car is 0.95m to the top of the halo and
 *   has open wheels; this is 1.3m to the roof with a cabin on top of it and the
 *   wheels inside the bodywork. Silhouette alone tells them apart at 200 metres.
 *   IT IS SHORT AND WIDE. About 4.8m long against an F1 car's 5.6, and about
 *   2.0m across the arches — so it is a stubbier, blockier shape.
 *   THE CABIN IS SET BACK. A long bonnet, a windscreen raked back over the front
 *   axle, and a fastback roofline falling to a short tail. That front-mid-engine
 *   coupé proportion is the single strongest cue.
 *   IT HAS ARCHES, not wings. Bulges over each wheel rather than an aerofoil in
 *   front of it.
 *   AND IT HAS THE LIGHT BAR, which is the thing that says what it is. A bar
 *   across the roof with amber lamps that flash — the "orange lights" of 2026
 *   Section B Art. B5.13.1 / 2025 Sporting Regs Art. 55.6, whose going out is
 *   itself a signal (B5.13.6 / Art. 55.15) — and a green lamp used to order
 *   specific cars past (B5.13.2c-i, B5.13.4a and B5.13.4c / Art. 55.8a, 55.9
 *   and 55.14).
 *
 * NO REAL MANUFACTURER. The project has never used one and does not start here:
 * the teams in `src/data/teams.ts` are invented, the trackside brands in
 * `Signage.ts` are invented, and nothing is downloaded. This car carries the
 * game's own officials' identity — see `SAFETY_CAR_LIVERY` — and its shape is
 * drawn from the class of car rather than from any particular one.
 *
 * HOW IT IS BUILT. `Loft.ts` for the curved forms and `ChamferKit.ts` for the
 * boxes, merged into ONE vertex-coloured geometry through `PartsBin`, which is
 * one draw call for the entire vehicle. That matters: twenty-two cars already
 * run at once and the game holds about fifty frames a second, so a twenty-third
 * vehicle has to cost a draw call and not twenty. The two pipelines carry
 * different vertex attributes and `mergeGeometries` will not cross them — see
 * the note at the head of `ChamferKit.ts` — so every lofted piece has its `uv`
 * stripped on the way in.
 *
 * The lamps are the exception and are a second and third draw call, because a
 * light panel emits rather than reflects and has to be `MeshBasicMaterial` with
 * tone mapping off, exactly as `MarshalPost.ts` does it.
 */

import * as THREE from 'three';
import { loft, section, type Section } from './Loft';
import { chamferBox, chamferCylinder, PartsBin, structureMaterial } from './ChamferKit';

/**
 * The officials' identity.
 *
 * Invented, like everything else in this project that could otherwise have been
 * somebody's trade mark. A safety car is not a competitor and must not read as
 * one, so it is deliberately outside the ten teams' colour space: silver-white
 * bodywork with a dark green flash, which no team in `src/data/teams.ts` uses.
 */
export const SAFETY_CAR_LIVERY = {
  body: 0xdfe3e8,
  accent: 0x14563a,
  glass: 0x11151c,
  trim: 0x1b1f26,
  rim: 0x9aa3ad,
  tyre: 0x131518,
  amber: 0xff8a12,
  green: 0x35d16a,
  lampOff: 0x161a20,
};

/** Overall dimensions, metres. A road car's, not a Formula 1 car's. */
const LENGTH = 4.80;
const HALF_WIDTH = 0.99;
const ROOF_Y = 1.30;
const NOSE_Z = LENGTH * 0.5;
const TAIL_Z = -LENGTH * 0.5;
/** Wheelbase 2.72m, so the axles sit here. */
const FRONT_AXLE_Z = 1.36;
const REAR_AXLE_Z = -1.36;
const WHEEL_R = 0.35;
const WHEEL_W = 0.30;
/** Underside of the floor. A road car sits far higher than a racing car. */
const FLOOR_Y = 0.13;

export interface SafetyCarVisual {
  root: THREE.Group;
  /** Wheel groups, so they spin and the fronts steer. */
  wheelSpin: THREE.Object3D[];
  wheelSteer: THREE.Object3D[];
  /**
   * Advances the lamps.
   *
   * @param dt seconds
   * @param orange the orange lights are illuminated (B5.13.1 / Art. 55.6)
   * @param green the green light is illuminated to order cars past
   *        (B5.13.2c-i / Art. 55.8a)
   */
  setLights(dt: number, orange: boolean, green: boolean): void;
  dispose(): void;
}

/** Strips the uv a `Loft` piece carries so it can merge with the boxes. */
function unwrapped(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  return geo;
}

/**
 * The lower body: floor, sills, arches and the tail, as one lofted solid.
 *
 * Sections run nose to tail. The waist — where the body's widest point sits —
 * is low and the shoulders are square, which is what gives a road car its
 * slab-sided look next to an F1 car's tapered tub.
 */
function lowerSections(): Section[] {
  const w = HALF_WIDTH;
  return [
    // Nose: low, narrow, and rounded off. The splitter is a separate box.
    section(NOSE_Z, w * 0.72, FLOOR_Y + 0.06, 0.60, 0.55),
    section(NOSE_Z - 0.35, w * 0.88, FLOOR_Y, 0.72, 0.45),
    // Over the front axle: the arch swells the body out to full width.
    section(FRONT_AXLE_Z + 0.30, w * 0.99, FLOOR_Y, 0.80, 0.35),
    section(FRONT_AXLE_Z, w, FLOOR_Y, 0.82, 0.30),
    // Bonnet shut line, body drawn in at the doors.
    section(FRONT_AXLE_Z - 0.55, w * 0.94, FLOOR_Y, 0.84, 0.28),
    section(0.20, w * 0.93, FLOOR_Y, 0.86, 0.26),
    // Rear arch, wider again — a rear-drive coupé is broadest here.
    section(REAR_AXLE_Z + 0.45, w * 0.99, FLOOR_Y, 0.88, 0.30),
    section(REAR_AXLE_Z, w, FLOOR_Y, 0.88, 0.32),
    // Short tail, cut off square.
    section(REAR_AXLE_Z - 0.60, w * 0.95, FLOOR_Y + 0.02, 0.86, 0.36),
    section(TAIL_Z, w * 0.80, FLOOR_Y + 0.12, 0.80, 0.50),
  ];
}

/**
 * The greenhouse: windscreen, roof and rear screen.
 *
 * A separate loft sitting on the shoulder line, because the cabin's plan shape
 * is nothing like the body's — it is far narrower, and the roof falls away
 * behind the driver in a way a single set of sections through the whole car
 * cannot describe.
 */
function cabinSections(): Section[] {
  const w = HALF_WIDTH;
  return [
    // Base of the windscreen, just behind the front axle.
    section(FRONT_AXLE_Z - 0.35, w * 0.68, 0.80, 0.86, 0.5),
    section(FRONT_AXLE_Z - 0.75, w * 0.72, 0.82, ROOF_Y - 0.10, 0.45),
    // Roof, over the driver.
    section(FRONT_AXLE_Z - 1.15, w * 0.74, 0.84, ROOF_Y, 0.40),
    section(-0.55, w * 0.74, 0.84, ROOF_Y, 0.40),
    // Fastback: the roof falls into the rear deck rather than stopping.
    section(REAR_AXLE_Z + 0.10, w * 0.72, 0.86, ROOF_Y - 0.14, 0.42),
    section(REAR_AXLE_Z - 0.35, w * 0.62, 0.87, 0.98, 0.50),
  ];
}

export function buildSafetyCar(quality: 'low' | 'high' = 'high'): SafetyCarVisual {
  const hi = quality === 'high';
  const seg = hi ? 20 : 12;
  const L = SAFETY_CAR_LIVERY;
  const root = new THREE.Group();
  const bin = new PartsBin();

  // --- Body ----------------------------------------------------------------
  bin.addRaw(unwrapped(loft(lowerSections(), seg, true, hi ? 0.10 : 0)), L.body);
  bin.addRaw(unwrapped(loft(cabinSections(), seg, true, hi ? 0.10 : 0)), L.glass);

  // The roof panel over the glass, so the cabin is not a fishbowl. A thin shell
  // sitting a couple of centimetres proud of the lofted greenhouse.
  bin.add(chamferBox(HALF_WIDTH * 1.42, 0.06, 1.70, 0.03), L.body,
    0, ROOF_Y + 0.005, FRONT_AXLE_Z - 1.05);

  // Splitter and rear diffuser: the two flat black planes that read as a
  // performance car's aero even in silhouette.
  bin.add(chamferBox(HALF_WIDTH * 1.78, 0.05, 0.36, 0.02), L.trim,
    0, FLOOR_Y + 0.04, NOSE_Z - 0.10);
  bin.add(chamferBox(HALF_WIDTH * 1.70, 0.07, 0.44, 0.02), L.trim,
    0, FLOOR_Y + 0.06, TAIL_Z + 0.18);

  // Grille and the black mask around it.
  bin.add(chamferBox(HALF_WIDTH * 1.16, 0.26, 0.10, 0.03), L.trim,
    0, 0.52, NOSE_Z - 0.02);

  // Sills, along the bottom of the doors.
  for (const side of [1, -1]) {
    bin.add(chamferBox(0.10, 0.12, 2.10, 0.03), L.trim,
      side * HALF_WIDTH * 0.97, FLOOR_Y + 0.05, 0.05);
    // Mirror on a stalk.
    bin.add(chamferBox(0.20, 0.09, 0.10, 0.03), L.body,
      side * (HALF_WIDTH * 0.92), 0.90, FRONT_AXLE_Z - 0.62);
  }

  // The accent flash down the flanks — the game's own officials' colour, and
  // the only thing on the car that is a livery rather than a shape.
  for (const side of [1, -1]) {
    bin.add(chamferBox(0.02, 0.13, 3.10, 0.01), L.accent,
      side * (HALF_WIDTH * 1.005), 0.60, -0.10);
  }

  // --- Rear wing -----------------------------------------------------------
  // A road car's fixed spoiler: one plane on two end plates, sitting on the
  // boot rather than on a pylon a metre above it.
  bin.add(chamferBox(HALF_WIDTH * 1.62, 0.05, 0.30, 0.02), L.trim,
    0, 1.02, TAIL_Z + 0.42);
  for (const side of [1, -1]) {
    bin.add(chamferBox(0.04, 0.20, 0.26, 0.02), L.trim,
      side * HALF_WIDTH * 0.80, 0.92, TAIL_Z + 0.42);
  }

  // --- Lamps that are paint, not light ------------------------------------
  // Headlight and tail-light glass. These are dark trim rather than emissive:
  // the only lights on this car that emit are the ones on the roof, and giving
  // the headlamps the same treatment would drown them.
  for (const side of [1, -1]) {
    bin.add(chamferBox(0.34, 0.11, 0.08, 0.02), L.rim,
      side * HALF_WIDTH * 0.58, 0.70, NOSE_Z - 0.14);
    bin.add(chamferBox(0.30, 0.10, 0.06, 0.02), 0x8c1a1a,
      side * HALF_WIDTH * 0.60, 0.80, TAIL_Z + 0.06);
  }

  // --- Wheels --------------------------------------------------------------
  const wheelSpin: THREE.Object3D[] = [];
  const wheelSteer: THREE.Object3D[] = [];
  const tyreGeo = chamferCylinder(WHEEL_R, WHEEL_W, hi ? 22 : 12, 0.05);
  const rimGeo = chamferCylinder(WHEEL_R * 0.62, WHEEL_W * 1.02, hi ? 18 : 10, 0.02);

  for (const [z, front] of [[FRONT_AXLE_Z, true], [REAR_AXLE_Z, false]] as [number, boolean][]) {
    for (const side of [1, -1]) {
      const steer = new THREE.Group();
      steer.position.set(side * (HALF_WIDTH - WHEEL_W * 0.42), WHEEL_R, z);
      const spin = new THREE.Group();
      steer.add(spin);
      root.add(steer);
      if (front) wheelSteer.push(steer);
      wheelSpin.push(spin);

      // `chamferCylinder` builds about Y, so the wheel is rolled onto its side.
      // Tyre and rim only. A road wheel's spokes are invisible at any distance
      // this car is ever seen from — it is never the camera's subject — and five
      // struts per wheel is twenty struts for nothing.
      const wb = new PartsBin();
      wb.add(tyreGeo, L.tyre, 0, 0, 0);
      wb.add(rimGeo, L.rim, 0, 0, 0);
      const merged = wb.merge();
      if (merged) {
        merged.rotateZ(Math.PI * 0.5);
        const mesh = new THREE.Mesh(merged, structureMaterial({ roughness: 0.85, metalness: 0.15 }));
        mesh.castShadow = false;
        spin.add(mesh);
      }
    }
  }
  tyreGeo.dispose();
  rimGeo.dispose();

  // --- The body, merged ----------------------------------------------------
  const body = bin.merge();
  const bodyMat = structureMaterial({ roughness: 0.38, metalness: 0.35 });
  if (body) {
    const mesh = new THREE.Mesh(body, bodyMat);
    root.add(mesh);
  }

  // --- The light bar -------------------------------------------------------
  //
  // `MeshBasicMaterial` with `toneMapped: false`, which is what `MarshalPost.ts`
  // uses and for the reason its header gives: a light panel emits, it does not
  // reflect, and staying above the ACES roll-off is what lets the bloom find it.
  //
  // The bar itself is a dark plinth with four lenses in it — two amber outboard,
  // which is what is lit while the car is deployed, and a green one at the back
  // for the pass signal.
  const barY = ROOF_Y + 0.09;
  const barZ = FRONT_AXLE_Z - 1.00;
  // Not through the bin: it needs a plain colour rather than a vertex-coloured
  // one, and one small mesh is cheaper than teaching the bin about it.
  const plinth = new THREE.Mesh(
    chamferBox(1.10, 0.07, 0.16, 0.02),
    new THREE.MeshStandardMaterial({
      color: SAFETY_CAR_LIVERY.trim, roughness: 0.8, metalness: 0.1,
    }),
  );
  plinth.position.set(0, barY, barZ);
  root.add(plinth);

  const amberMat = new THREE.MeshBasicMaterial({ toneMapped: false, color: L.lampOff });
  const greenMat = new THREE.MeshBasicMaterial({ toneMapped: false, color: L.lampOff });
  const lensGeo = new THREE.BoxGeometry(0.24, 0.06, 0.14);
  const lenses: THREE.Mesh[] = [];
  for (const x of [-0.40, 0.40]) {
    const m = new THREE.Mesh(lensGeo, amberMat);
    m.position.set(x, barY + 0.005, barZ);
    root.add(m);
    lenses.push(m);
  }
  const greenLens = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.06, 0.10), greenMat);
  greenLens.position.set(0, barY + 0.005, barZ - 0.05);
  root.add(greenLens);

  // Flash rate. Fast enough to read as a warning beacon and slow enough not to
  // strobe: real bar lamps run at two to three flashes a second per side, and
  // the two sides alternate, which is what makes it look like a light bar
  // rather than a pair of bulbs.
  const FLASH_HZ = 2.4;
  let phase = 0;
  const amberOn = new THREE.Color(L.amber);
  const greenOn = new THREE.Color(L.green);
  const off = new THREE.Color(L.lampOff);

  const setLights = (dt: number, orange: boolean, green: boolean): void => {
    phase = (phase + dt * FLASH_HZ) % 1;
    // Alternating halves: the left pair is lit for the first half of the cycle
    // and the right pair for the second. One material each would be two more
    // draw calls, so the two lenses share a material and the alternation is
    // done by moving the whole bar's colour between the two peaks — which at
    // this size and distance is indistinguishable and costs nothing.
    const lit = orange && phase < 0.5;
    (lenses[0].material as THREE.MeshBasicMaterial).color.copy(lit ? amberOn : off);
    greenMat.color.copy(green ? greenOn : off);
  };

  return {
    root,
    wheelSpin,
    wheelSteer,
    setLights,
    dispose(): void {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) for (const x of mat) x.dispose();
        else if (mat) mat.dispose();
      });
    },
  };
}
