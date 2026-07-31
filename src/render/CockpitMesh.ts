import * as THREE from 'three';
import { buildCarbonTexture } from './Livery';
import { creased, loft, section } from './Loft';

/**
 * Everything a driver actually sees from inside the car.
 *
 * A cockpit camera that is only a viewpoint is not a cockpit view. What makes an
 * onboard shot read as an onboard shot is the stuff that never moves relative to
 * your head: the halo arcing overhead, the wheel turning in your hands, the
 * mirrors twitching at the edge of vision, and the chassis framing the bottom of
 * the frame. Without them the "cockpit" is indistinguishable from a very low
 * bumper cam.
 *
 * All of this geometry is CAR-LOCAL — it is parented to the car root, so it
 * inherits the chassis' position, heading, roll and pitch for free — and it is
 * only ever attached to the player's car, and only made visible while the
 * cockpit camera is selected. Twenty cars' worth of steering wheels and gloves
 * would be a lot of triangles nobody can see.
 *
 * Coordinates: +x right, +y up, +z toward the nose. The origin is the contact
 * patch plane at the centre of the car.
 *
 * NOT to be confused with DriverMesh.ts, which is the other half of the same
 * problem: the driver's BODY as seen from outside — helmet, shoulders, HANS
 * collar, arms — merged into the shared shell so all twenty cars have someone
 * in them. This module is the reverse view, of one car, from one seat. The two
 * meet at the steering wheel, which both place, and which is why the wheel's
 * position, rake and grip points are defined here and imported there.
 */

/**
 * Driver's eye point, car-local. The camera sits exactly here in cockpit mode.
 *
 * This is not a free parameter. It is the eye socket of the modelled driver in
 * DriverMesh.ts, whose helmet is centred at y = 0.672 with a scaled vertical
 * radius of 0.156, so the shell runs from 0.516 to 0.828 and the eyes sit a
 * little above centre and forward of it. Set it by eye instead and the camera
 * ends up above the driver's head, looking over the top of the halo hoop
 * (apex y = 0.820) rather than through it — which is exactly what happened when
 * this was left at the old car's 0.86 after the body was rebuilt.
 */
/**
 * Up 40mm and back 25mm.
 *
 * Both directions buy road, and the order they were done in matters. Raising
 * the eye pushes everything below it — tub, mirrors, rim, front tyres — down
 * the frame, which is exactly what the "barely a third of the frame is road"
 * report is asking for. But it also brings the halo DOWN toward the horizon,
 * because the hoop passes above the sightline, and a hoop laid across the road
 * is worse than one in the sky. So the halo had to be raised and slimmed first
 * (see CarMesh); with its arc sitting at fifteen degrees instead of six there
 * is finally headroom to lift the eye without the hoop landing on the track.
 *
 * Moving back is free by comparison: it lengthens the distance to everything in
 * front — rim, dash, mirrors, halo — and angular size is what framing is made
 * of.
 *
 * Both stay well inside the modelled helmet shell, which runs 0.516..0.828 in
 * y and -0.145..0.185 in z, and the halo's crown at 0.882 is still above the
 * eye, so the view is still THROUGH the hoop rather than over the top of it.
 */
export const EYE_X = 0;
export const EYE_Y = 0.745;
export const EYE_Z = 0.075;

/**
 * Centre of the steering wheel, car-local, and its rake.
 *
 * Exported because DriverMesh puts the coarse wheel and the driver's hands in
 * the same place: the two have to agree exactly, or the detailed wheel drawn
 * for the onboard view sits somewhere other than the one every other camera
 * sees, and the driver's arms reach for empty air.
 */
/**
 * Height matters more than it looks. The cockpit coaming is at y = 0.578 and
 * the eye barely 0.13m above it, so anything much below the coaming line is
 * hidden behind the top of the tub from the driver's own seat. Sitting the
 * wheel's centre just under that line — which is also where a real car carries
 * it — is what puts the whole rim, and the display in the middle of it, in the
 * picture instead of just the top edge.
 *
 * Reach matters too: at 0.44m from the eye the rim filled two thirds of the
 * frame. Half a metre is both an arm's length and a sane framing, and with the
 * eye 25mm further back the rim now sits a full 0.50m away.
 *
 * Down 17mm as well. The reference onboard frames carry the wheel low enough
 * that the road behind it is continuous from the nose to the horizon; anything
 * higher and the rim cuts the road in half, which is half of why the bottom of
 * the frame read as a wall.
 */
export const WHEEL_X = 0;
export const WHEEL_Y = 0.548;
export const WHEEL_Z = 0.575;
/** Rake of the wheel: the top is tipped back toward the driver. */
export const WHEEL_TILT = -0.45;

/** Where the hands grip the rim, in wheel-local x. */
export const GRIP_X = 0.122;

const WHEEL_HALF_W = 0.138;
const WHEEL_HALF_H = 0.100;

/**
 * Mirror mounts, car-local (right-hand side; the left is mirrored in x).
 *
 * Shared with CarMesh, which builds the stalk and the housing into the shell so
 * that all twenty cars have mirrors, and leaves the reflective pane to this
 * module because only one car is ever looked out of.
 */
/**
 * Further out and further forward than they were, and lower.
 *
 * A mirror 0.79m from the eye at 37 degrees off axis lands exactly on the edge
 * of the frame, where a 105mm pod subtends nearly eight degrees and reads as a
 * slab pushing into the picture. Carried forward to 0.79 in z and out to 0.505
 * it sits at 33 degrees and 0.87m — still comfortably inside a driver's useful
 * field, still where a real car mounts them, and a fifth smaller on screen.
 */
export const MIRROR_X = 0.505;
export const MIRROR_Y = 0.604;
export const MIRROR_Z = 0.790;
/** Front face of the housing, where the glass sits. */
export const MIRROR_GLASS_Z = 0.769;

export interface CockpitState {
  /** Road-wheel angle in radians. The rim turns by RACK_RATIO times this. */
  steerRad: number;
  gearLabel: string;
  speedKph: number;
  rpmFraction: number;
  drsOpen: boolean;
  ersPercent: number;
}

/**
 * Steering rack ratio.
 *
 * A real F1 rack is roughly 3:1 — a little under a full turn lock to lock for
 * about ±20 degrees of road wheel. Turning the rim by the road-wheel angle, as
 * a naive implementation does, makes the driver look like they are steering with
 * their fingertips.
 */
export const RACK_RATIO = 3;

export interface CockpitVisual {
  root: THREE.Group;
  setVisible(v: boolean): void;
  update(state: CockpitState): void;
  dispose(): void;
}

// ===========================================================================
// Small geometry helpers
// ===========================================================================

/**
 * Segment counts for everything in here.
 *
 * NOTHING else in the scene is viewed from this range. The wheel rim sits
 * 540mm from the eye and fills a third of the frame, so a 23mm grip at ten
 * segments is a visible decagon and an eight-sided steering column is a
 * visible octagon — counts that are entirely reasonable on a wishbone two
 * metres away are not reasonable here. These are deliberately the largest
 * numbers in the project, and they are affordable because exactly one car in
 * the field is ever built with a cockpit.
 */
const SEG = {
  /** Round sections: grips, the column, knobs, the wrist cuff. */
  round: 24,
  /** Curve resolution on the extruded wheel rim outline. */
  rimCurve: 20,
  /** Rings around a lofted bolster or dash. */
  loftRing: 24,
  /** Ring spacing along a lofted bolster, metres. */
  loftStep: 0.04,
  /** Sphere segments on the palm. */
  palmW: 24,
  palmH: 16,
  /** Capsule cap segments and radial segments on a finger. */
  fingerCap: 5,
  fingerRadial: 14,
};

/**
 * Scales a geometry and corrects its normals for the scale.
 *
 * `scale` moves the positions and leaves the normals, so a squashed sphere
 * lights as if it were still round. A normal transforms by the INVERSE scale.
 */
function scaledNormals(
  geo: THREE.BufferGeometry, sx: number, sy: number, sz: number,
): THREE.BufferGeometry {
  geo.scale(sx, sy, sz);
  const n = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!n) return geo;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i) / sx, y = n.getY(i) / sy, z = n.getZ(i) / sz;
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / len, y / len, z / len);
  }
  n.needsUpdate = true;
  return geo;
}

/** A capsule-ish strut between two car-local points. */
function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1 = r0,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, SEG.round, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/**
 * A block with every edge rounded — a grip flash, a shift paddle, a switch cap.
 *
 * These were `BoxGeometry`. A box has infinitely sharp edges and nothing at
 * this range does; the corner radius is what puts a curved highlight on the
 * part and tells the eye it is a moulded object of a particular size. `w` runs
 * x, `h` runs y, `d` runs z, and `r` is the corner radius.
 */
function roundedBlock(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const round = Math.max(0.1, Math.min(0.9, (r * 2) / Math.max(1e-4, Math.min(w, h))));
  // The two end caps are inset by the radius and blended in, so the ends are
  // rounded too rather than being flat discs on a rounded bar.
  const inset = Math.min(r, d * 0.4);
  return loft([
    section(-d / 2, w / 2 - inset * 0.7, -h / 2 + inset * 0.7, h / 2 - inset * 0.7, Math.min(1, round + 0.25)),
    section(-d / 2 + inset, w / 2, -h / 2, h / 2, round),
    section(d / 2 - inset, w / 2, -h / 2, h / 2, round),
    section(d / 2, w / 2 - inset * 0.7, -h / 2 + inset * 0.7, h / 2 - inset * 0.7, Math.min(1, round + 0.25)),
  ], SEG.loftRing);
}

function roundedRect(
  path: THREE.Shape | THREE.Path,
  x: number, y: number, w: number, h: number, r: number,
): void {
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
}

// ===========================================================================
// The wheel's own dash display
// ===========================================================================

/**
 * The little screen in the middle of the wheel.
 *
 * Drawn into a canvas rather than assembled from meshes: it is a screen, so a
 * texture is not a cheat, and fifteen individually-lit LED quads would cost more
 * than the whole rest of the cockpit. Redrawn only when a displayed value
 * actually changes, which at a steady speed is a handful of times a second.
 */
class WheelDash {
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private lastKey = '';

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 176;
    this.ctx = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw({
      steerRad: 0, gearLabel: 'N', speedKph: 0, rpmFraction: 0,
      drsOpen: false, ersPercent: 0,
    });
  }

  update(s: CockpitState): void {
    const lit = Math.round(clamp01((s.rpmFraction - 0.45) / 0.55) * 15);
    const key = s.gearLabel + '|' + Math.round(s.speedKph) + '|' + lit + '|' +
      (s.drsOpen ? '1' : '0') + '|' + Math.round(s.ersPercent * 10);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(s);
    this.texture.needsUpdate = true;
  }

  private draw(s: CockpitState): void {
    const c = this.ctx;
    const W = 320, H = 176;

    c.fillStyle = '#05070b';
    c.fillRect(0, 0, W, H);

    // Shift lights across the top: green, amber, red, flashing at the limiter.
    const frac = s.rpmFraction;
    const lit = Math.round(clamp01((frac - 0.45) / 0.55) * 15);
    const limiter = frac > 0.985;
    for (let i = 0; i < 15; i++) {
      const on = limiter ? true : i < lit;
      const band = i < 7 ? '#2ee36a' : i < 12 ? '#ffb02e' : '#ff3b3b';
      c.fillStyle = on ? (limiter ? '#ffffff' : band) : '#161a21';
      const x = 12 + i * 19.6;
      c.fillRect(x, 10, 15, 13);
    }

    // Gear, centre and enormous — the one thing read in peripheral vision.
    c.fillStyle = '#ffffff';
    c.font = '700 92px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(s.gearLabel, W * 0.5, 96);

    // Speed on the left, ERS store on the right.
    c.font = '700 34px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'left';
    c.fillStyle = '#dfe6f2';
    c.fillText(String(Math.round(s.speedKph)), 12, 92);
    c.font = '700 15px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#7d879a';
    c.fillText('KMH', 12, 116);

    c.textAlign = 'right';
    c.font = '700 30px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#ffd83d';
    c.fillText(Math.round(s.ersPercent * 100) + '%', W - 12, 92);
    c.font = '700 15px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillStyle = '#7d879a';
    c.fillText('ERS', W - 12, 116);

    // DRS bar along the bottom.
    c.fillStyle = s.drsOpen ? '#3ddc84' : '#141821';
    c.fillRect(12, 138, W - 24, 26);
    c.fillStyle = s.drsOpen ? '#06210f' : '#3c4655';
    c.font = '800 17px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText('D R S', W * 0.5, 152);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ===========================================================================
// Assembly
// ===========================================================================

/**
 * Builds the cockpit furniture for one car.
 *
 * @param accentColour the team's accent, used for the glove cuffs and the wheel
 *                     grip flashes so the view is liveried like the car is.
 */
export function buildCockpit(accentColour: number): CockpitVisual {
  const root = new THREE.Group();
  root.name = 'cockpit';
  root.visible = false;
  // Never let the cockpit cast shadows onto the road: it is inches from the
  // camera and would produce a large, obviously wrong smear on the track.
  root.matrixAutoUpdate = true;

  const owned: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const track = <T extends THREE.BufferGeometry>(g: T): T => { owned.push(g); return g; };
  const mat = <T extends THREE.Material>(m: T): T => { materials.push(m); return m; };

  // The cockpit surround, the wheel frame and the dash are all bare laminate,
  // and they are the surfaces closest to the camera in the view most of the
  // game is played from. A flat dark grey at half a metre reads as painted
  // board; the weave is what makes it read as a moulded composite tub.
  //
  // Metalness 0.05, not 0.35. Carbon is resin over black cloth. At a third
  // metallic it borrows the environment's colour and comes out looking like
  // sandblasted aluminium, which is exactly what the cockpit used to look like.
  const carbonWeave = buildCarbonTexture();
  // Box and cylinder UVs run 0..1 per face whatever the face's real size, so
  // the repeat is a compromise across parts from 50mm to 600mm across. Four
  // tiles of an eight-cell weave puts the cell somewhere between 1.5 and 20mm,
  // which reads correctly over the whole range at cockpit distance.
  carbonWeave.map.repeat.set(4, 4);
  carbonWeave.surface.repeat.set(4, 4);
  const carbon = mat(new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: carbonWeave.map,
    roughnessMap: carbonWeave.surface,
    metalnessMap: carbonWeave.surface,
    // Well under 1, because the cockpit is a hole. The environment probe is a
    // full sphere of unoccluded sky and floodlight, and a tub whose opening is
    // a slot between the halo and the rim sees almost none of it — applying the
    // probe at full strength put a blown white highlight across the dash and
    // the wheel that no real onboard shot has. Screen-space AO cannot correct
    // this: it darkens the diffuse result, not the specular lobe.
    metalness: 1, roughness: 1, envMapIntensity: 0.45,
  }));
  const rubberGrip = mat(new THREE.MeshStandardMaterial({
    color: 0x0a0b0e, metalness: 0.0, roughness: 0.88, envMapIntensity: 0.4,
  }));
  const glove = mat(new THREE.MeshStandardMaterial({
    color: 0x1b1e26, metalness: 0.0, roughness: 0.72, envMapIntensity: 0.6,
  }));
  const accent = mat(new THREE.MeshStandardMaterial({
    color: accentColour, metalness: 0.2, roughness: 0.5, envMapIntensity: 0.9,
  }));
  // A mirror is a mirror because it reflects: a fully metallic, near-zero
  // roughness surface picks up the environment map and reads instantly as glass,
  // where a flat grey quad reads as a sticker.
  const mirrorGlass = mat(new THREE.MeshStandardMaterial({
    color: 0xc8d2e0, metalness: 1.0, roughness: 0.045, envMapIntensity: 2.4,
  }));

  const add = (geo: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = root): THREE.Mesh => {
    const m = new THREE.Mesh(track(geo), material);
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  };

  // --- Cockpit rim padding ------------------------------------------------
  // The dark bolsters either side of the driver. They occupy the bottom corners
  // of the frame and are most of what makes the view feel enclosed.
  //
  // Heights here follow the monocoque in CarMesh, whose cockpit opening has its
  // rim at y = 0.572..0.596 over this stretch. The pads stand a couple of
  // centimetres proud of it, as padding does.
  // Padding is padding: it is upholstery over foam and it has no sharp edge
  // anywhere on it. As a box it occupied the bottom corners of the frame with
  // two dead-straight highlights, which is the first thing the eye reads in an
  // onboard shot. Lofted with a strongly rounded section, tapering forward, as
  // the coaming does.
  for (const side of [-1, 1] as const) {
    const pad = loft([
      section(0.440, 0.0330, 0.5525, 0.6045, 0.80),
      section(0.240, 0.0375, 0.5525, 0.6075, 0.80),
      section(-0.020, 0.0375, 0.5525, 0.6075, 0.78),
      section(-0.180, 0.0300, 0.5550, 0.6000, 0.85),
    ], SEG.loftRing, true, SEG.loftStep);
    pad.translate(side * 0.30, 0, 0);
    add(pad, carbon);
  }
  // Dash bulkhead ahead of the driver, where the column comes through. The tub
  // has necked down to a rim height of about 0.556 by here.
  {
    // Twelve millimetres lower at the lip than it was. The tub has necked down
    // to a rim height of about 0.556 here, so a bulkhead topping out at 0.574
    // still stands proud of it the way a real dash lip does — and every
    // millimetre taken off the top of it is a millimetre of road handed back at
    // the bottom of the frame, which is the whole exercise.
    const dash = loft([
      section(0.650, 0.250, 0.522, 0.574, 0.45),
      section(0.700, 0.250, 0.522, 0.574, 0.42),
      section(0.750, 0.238, 0.525, 0.571, 0.55),
    ], SEG.loftRing, true, SEG.loftStep);
    add(dash, carbon);
    // Steering column, running forward and down from the back of the wheel.
    add(strut(0, 0.548, 0.607, 0, 0.552, 0.70, 0.026), carbon);
  }

  // --- Mirrors ------------------------------------------------------------
  // The stalk and the housing are part of the shell (see CarMesh) because every
  // car needs them. What only the driver needs is the reflection: a fully
  // metallic, near-zero-roughness pane picks up the environment map and reads
  // instantly as glass, where the shell's flat dark swatch reads as a sticker.
  // It is laid a couple of millimetres proud of the shell's pane so it wins the
  // depth test without z-fighting.
  for (const side of [-1, 1] as const) {
    // The glass faces back and inward, at the driver's eye. The plane's own
    // normal is +z, so the mesh rotation alone turns it round — rotating the
    // geometry as well would flip it back and cull it.
    const glass = new THREE.PlaneGeometry(0.100, 0.038);
    const g = add(glass, mirrorGlass);
    g.position.set(side * MIRROR_X, MIRROR_Y, MIRROR_GLASS_Z - 0.003);
    g.rotation.y = Math.PI + side * 0.30;
  }

  // --- Steering wheel -----------------------------------------------------
  // pivot holds the position and rake; spin is the only thing that rotates with
  // steering input, so the rake never contaminates the steering axis.
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(WHEEL_X, WHEEL_Y, WHEEL_Z);
  wheelPivot.rotation.x = WHEEL_TILT;
  root.add(wheelPivot);

  const wheelSpin = new THREE.Group();
  wheelPivot.add(wheelSpin);

  const dash = new WheelDash();

  {
    // A modern F1 wheel is a squared-off frame, not a circle: two vertical
    // grips, a broad centre column carrying the display, and flat top and
    // bottom bars. Two rounded-rect holes cut in a rounded-rect outline give
    // exactly that silhouette in one extrusion.
    const shape = new THREE.Shape();
    roundedRect(shape, -WHEEL_HALF_W, -WHEEL_HALF_H, WHEEL_HALF_W * 2, WHEEL_HALF_H * 2, 0.042);
    const holeL = new THREE.Path();
    roundedRect(holeL, -0.107, -0.055, 0.067, 0.110, 0.025);
    const holeR = new THREE.Path();
    roundedRect(holeR, 0.040, -0.055, 0.067, 0.110, 0.025);
    shape.holes.push(holeL, holeR);

    const rim = new THREE.ExtrudeGeometry(shape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.006,
      bevelSegments: 4,
      curveSegments: SEG.rimCurve,
    });
    rim.translate(0, 0, -0.015);
    // ExtrudeGeometry is non-indexed and normals it. Every rounded corner of
    // the outline and of the two cut-outs therefore came out as a fan of flat
    // facets: the wheel had a visibly polygonal edge from twenty inches away,
    // and adding curve segments alone would only have made it a finer polygon.
    // Angle-based smoothing averages across the corner radii and leaves the
    // 90-degree meeting of the face and the edge hard, which is exactly what a
    // smoothing group is for.
    add(creased(rim, 32), carbon, wheelSpin);

    // Rubber grips over the two uprights, with an accent flash at the top of
    // each — the same trick a real team uses to mark the straight-ahead point.
    for (const side of [-1, 1] as const) {
      const grip = new THREE.CylinderGeometry(0.022, 0.022, 0.112, SEG.round);
      grip.translate(side * GRIP_X, -0.004, 0);
      add(grip, rubberGrip, wheelSpin);
      const flash = roundedBlock(0.046, 0.013, 0.046, 0.005);
      flash.translate(side * GRIP_X, 0.059, 0);
      add(flash, accent, wheelSpin);
    }
    // Straight-ahead marker at 12 o'clock.
    {
      const mark = roundedBlock(0.021, 0.012, 0.032, 0.004);
      mark.translate(0, 0.093, -0.012);
      add(mark, accent, wheelSpin);
    }

    // Shift paddles, on the far side of the rim from the driver.
    for (const side of [-1, 1] as const) {
      const paddle = roundedBlock(0.015, 0.074, 0.052, 0.006);
      paddle.translate(side * 0.089, -0.005, 0.042);
      const p = add(paddle, carbon, wheelSpin);
      p.rotation.y = side * 0.22;
    }

    // The display, facing the driver (-z in wheel space).
    // Sits proud of the rim's bevelled face, or the extrusion swallows it.
    const dashPlane = new THREE.PlaneGeometry(0.078, 0.044);
    dashPlane.rotateY(Math.PI);
    dashPlane.translate(0, 0.019, -0.026);
    const dashMat = mat(new THREE.MeshBasicMaterial({ map: dash.texture, toneMapped: false }));
    add(dashPlane, dashMat, wheelSpin);

    // A row of rotary switches under the screen, because a bare panel looks
    // like a placeholder and these cost four triangles each.
    for (let i = 0; i < 3; i++) {
      const knob = new THREE.CylinderGeometry(0.011, 0.013, 0.014, SEG.round);
      knob.rotateX(Math.PI / 2);
      knob.translate(-0.029 + i * 0.029, -0.053, -0.021);
      add(knob, rubberGrip, wheelSpin);
    }
  }

  // --- Hands --------------------------------------------------------------
  // Parented to the spin group: a driver's hands do not slide around the rim in
  // the ninety degrees of lock an F1 car has, so they turn with it.
  for (const side of [-1, 1] as const) {
    const hand = new THREE.Group();
    hand.position.set(side * GRIP_X, -0.005, 0);
    wheelSpin.add(hand);

    // Palm, wrapped around the back of the grip rather than stuck to the side
    // of it — a hand on a wheel is mostly behind the rim, with only the
    // knuckles showing in front.
    const palm = scaledNormals(
      new THREE.SphereGeometry(0.037, SEG.palmW, SEG.palmH), 0.80, 1.30, 1.05,
    );
    palm.translate(side * 0.014, 0.002, -0.020);
    add(palm, glove, hand);

    // Fingers curling over the front of the rim.
    for (let i = 0; i < 4; i++) {
      const f = new THREE.CapsuleGeometry(0.0085, 0.028, SEG.fingerCap, SEG.fingerRadial);
      f.rotateZ(Math.PI / 2);
      f.rotateY(side * 0.30);
      f.translate(side * -0.008, 0.031 - i * 0.021, 0.016);
      add(f, glove, hand);
    }
    // Thumb, hooked over the inside face.
    {
      const t = new THREE.CapsuleGeometry(0.0095, 0.024, SEG.fingerCap, SEG.fingerRadial);
      t.rotateX(Math.PI / 2);
      t.rotateY(side * -0.55);
      t.translate(side * -0.014, 0.036, -0.010);
      add(t, glove, hand);
    }
    // Cuff at the wrist. The forearm behind it is NOT built here: DriverMesh
    // already runs a real arm from the shoulder to this exact point for every
    // car on the grid, and a second one starting at the wrist reads as a third
    // limb.
    {
      const cuff = new THREE.CylinderGeometry(0.031, 0.033, 0.028, SEG.round);
      cuff.rotateX(Math.PI / 2);
      cuff.rotateZ(side * 0.34);
      cuff.translate(side * 0.034, -0.038, -0.042);
      add(cuff, accent, hand);
    }
  }

  // The halo, the roll hoop and the driver's own body are NOT built here. They
  // live on the shared shell (see CarMesh and DriverMesh), because they have to
  // be there for the outside views anyway, and two of anything in the same place
  // would z-fight. What the cockpit adds is only what nobody can see from
  // outside: a mirror that actually reflects, a wheel with a live dash, and the
  // hands on it.

  const dashRef = dash;

  return {
    root,
    setVisible(v: boolean): void {
      if (root.visible !== v) root.visible = v;
    },
    update(state: CockpitState): void {
      if (!root.visible) return;
      // 3:1 rack, signed to match the road wheels.
      //
      // The road wheels take `rotation.y = -steer`, which points them at a
      // heading of (car heading - steer): a positive steer input is a RIGHT
      // turn. The wheel's own +z axis points at the nose, so the driver is
      // looking down it, and a positive rotation about it carries the rim's
      // twelve o'clock to the driver's right. Same sign, therefore, as the
      // steer input itself.
      wheelSpin.rotation.z = state.steerRad * RACK_RATIO;
      dashRef.update(state);
    },
    dispose(): void {
      for (const g of owned) g.dispose();
      for (const m of materials) m.dispose();
      dashRef.dispose();
    },
  };
}
