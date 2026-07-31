import * as THREE from 'three';
import { buildCarbonTexture } from './Livery';

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
export const EYE_X = 0;
export const EYE_Y = 0.705;
export const EYE_Z = 0.100;

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
 * frame. 0.54m is both an arm's length and a sane framing.
 */
export const WHEEL_X = 0;
export const WHEEL_Y = 0.565;
export const WHEEL_Z = 0.540;
/** Rake of the wheel: the top is tipped back toward the driver. */
export const WHEEL_TILT = -0.45;

/** Where the hands grip the rim, in wheel-local x. */
export const GRIP_X = 0.128;

const WHEEL_HALF_W = 0.145;
const WHEEL_HALF_H = 0.105;

/**
 * Mirror mounts, car-local (right-hand side; the left is mirrored in x).
 *
 * Shared with CarMesh, which builds the stalk and the housing into the shell so
 * that all twenty cars have mirrors, and leaves the reflective pane to this
 * module because only one car is ever looked out of.
 */
export const MIRROR_X = 0.478;
export const MIRROR_Y = 0.618;
export const MIRROR_Z = 0.735;
/** Front face of the housing, where the glass sits. */
export const MIRROR_GLASS_Z = 0.714;

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

/** A capsule-ish strut between two car-local points. */
function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r0: number, r1 = r0,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(r1, r0, len, 8, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
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
  for (const side of [-1, 1] as const) {
    const pad = new THREE.BoxGeometry(0.075, 0.055, 0.62);
    pad.translate(side * 0.30, 0.580, 0.13);
    add(pad, carbon);
  }
  // Dash bulkhead ahead of the driver, where the column comes through. The tub
  // has necked down to a rim height of about 0.556 by here.
  {
    const dash = new THREE.BoxGeometry(0.50, 0.06, 0.10);
    dash.translate(0, 0.556, 0.70);
    add(dash, carbon);
    // Steering column, running forward and down from the back of the wheel.
    add(strut(0, 0.565, 0.572, 0, 0.556, 0.68, 0.030), carbon);
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
    const glass = new THREE.PlaneGeometry(0.092, 0.050);
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
    roundedRect(shape, -WHEEL_HALF_W, -WHEEL_HALF_H, WHEEL_HALF_W * 2, WHEEL_HALF_H * 2, 0.044);
    const holeL = new THREE.Path();
    roundedRect(holeL, -0.113, -0.058, 0.070, 0.116, 0.026);
    const holeR = new THREE.Path();
    roundedRect(holeR, 0.043, -0.058, 0.070, 0.116, 0.026);
    shape.holes.push(holeL, holeR);

    const rim = new THREE.ExtrudeGeometry(shape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.006,
      bevelSegments: 2,
      curveSegments: 8,
    });
    rim.translate(0, 0, -0.015);
    add(rim, carbon, wheelSpin);

    // Rubber grips over the two uprights, with an accent flash at the top of
    // each — the same trick a real team uses to mark the straight-ahead point.
    for (const side of [-1, 1] as const) {
      const grip = new THREE.CylinderGeometry(0.023, 0.023, 0.118, 10);
      grip.translate(side * GRIP_X, -0.004, 0);
      add(grip, rubberGrip, wheelSpin);
      const flash = new THREE.BoxGeometry(0.048, 0.014, 0.048);
      flash.translate(side * GRIP_X, 0.062, 0);
      add(flash, accent, wheelSpin);
    }
    // Straight-ahead marker at 12 o'clock.
    {
      const mark = new THREE.BoxGeometry(0.022, 0.013, 0.034);
      mark.translate(0, 0.098, -0.012);
      add(mark, accent, wheelSpin);
    }

    // Shift paddles, on the far side of the rim from the driver.
    for (const side of [-1, 1] as const) {
      const paddle = new THREE.BoxGeometry(0.016, 0.078, 0.055);
      paddle.translate(side * 0.094, -0.005, 0.042);
      const p = add(paddle, carbon, wheelSpin);
      p.rotation.y = side * 0.22;
    }

    // The display, facing the driver (-z in wheel space).
    // Sits proud of the rim's bevelled face, or the extrusion swallows it.
    const dashPlane = new THREE.PlaneGeometry(0.082, 0.046);
    dashPlane.rotateY(Math.PI);
    dashPlane.translate(0, 0.020, -0.026);
    const dashMat = mat(new THREE.MeshBasicMaterial({ map: dash.texture, toneMapped: false }));
    add(dashPlane, dashMat, wheelSpin);

    // A row of rotary switches under the screen, because a bare panel looks
    // like a placeholder and these cost four triangles each.
    for (let i = 0; i < 3; i++) {
      const knob = new THREE.CylinderGeometry(0.011, 0.013, 0.014, 8);
      knob.rotateX(Math.PI / 2);
      knob.translate(-0.03 + i * 0.03, -0.056, -0.021);
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
    const palm = new THREE.SphereGeometry(0.037, 12, 10);
    palm.scale(0.80, 1.30, 1.05);
    palm.translate(side * 0.014, 0.002, -0.020);
    add(palm, glove, hand);

    // Fingers curling over the front of the rim.
    for (let i = 0; i < 4; i++) {
      const f = new THREE.CapsuleGeometry(0.0085, 0.028, 3, 6);
      f.rotateZ(Math.PI / 2);
      f.rotateY(side * 0.30);
      f.translate(side * -0.008, 0.031 - i * 0.021, 0.016);
      add(f, glove, hand);
    }
    // Thumb, hooked over the inside face.
    {
      const t = new THREE.CapsuleGeometry(0.0095, 0.024, 3, 6);
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
      const cuff = new THREE.CylinderGeometry(0.031, 0.033, 0.028, 10);
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
