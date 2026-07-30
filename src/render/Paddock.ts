import * as THREE from 'three';
import { PartsBin, chamferBox, chamferCylinder, quadXY, rand, structureMaterial } from './ChamferKit';
import { buildGrandstandGeometry, grandstandPreset } from './Grandstands';
import { TEAMS } from '../data/teams';
import {
  isPaddockGround,
  pitLaneGeometry,
  PIT_BAY_PITCH_M,
  PIT_ROW_ANCHOR_M,
  PIT_WALL_HEIGHT_M,
} from '../track/PitGeometry';
import { buildKeepOutField, MAIN_STAND_DEPTH_M, MAIN_STAND_WIDTH_M } from '../track/WorldObstacles';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * The paddock: pit garages, the pit building above them, team hospitality and
 * transporters behind, the crew standing at the boxes, and the main grandstand
 * facing the whole thing across the track.
 *
 * A session that starts in the garage opens looking at this, so it is the first
 * thing anyone sees. Before it existed the pit lane was a grey strip with cars
 * on it and open grass behind — which is not what a pit lane is. A pit lane is
 * a *street*: a wall on one side, a continuous two-storey building on the
 * other, ten open boxes lit from inside, equipment on the apron, and forty
 * people standing around in team kit. The buildings are the reason it feels
 * enclosed, and the people are the reason it feels occupied.
 *
 * Everything here is built once at session load and never moves, so it is all
 * merged down to a handful of draw calls:
 *
 *   1. every opaque structure in the paddock — garages, pit building,
 *      hospitality, transporters, equipment and the crew — as one merged,
 *      vertex-coloured buffer,
 *   2. the team boards, sharing one generated texture atlas,
 *   3. the glazing,
 *   4. the garage interior lights,
 *   5. the main grandstands, as one instanced mesh.
 *
 * The crew are merged rather than instanced deliberately. An InstancedMesh
 * would need one flat colour per figure, and a figure whose skin, helmet, boots
 * and overalls are all the same colour is a mannequin. Merging costs about a
 * megabyte for the whole pit lane and buys per-vertex colour, so the crew have
 * team overalls, dark boots and a head that is not the same colour as their
 * shirt. Draw-call cost is identical: one.
 */

export interface PaddockScene {
  root: THREE.Group;
  dispose(): void;
}

/**
 * Garage bay pitch: one bay per team, and a team runs two cars, so a bay is two
 * pit boxes wide. Taking it from the shared pit geometry rather than picking a
 * number is what puts the garage opening around the two cars that actually park
 * in it.
 */
const BAY_PITCH = PIT_BAY_PITCH_M;
/** Depth of a garage box from the opening to the back wall, metres. */
const BAY_DEPTH = 12.4;
/** Height of the garage opening's soffit, metres. */
const BAY_CLEAR = 4.4;
/** Ground-floor height of the pit building, metres. */
const FLOOR_H = 5.3;

const CONCRETE = 0xb0b4b9;
const CONCRETE_DARK = 0x6e737a;
const STEEL = 0x9aa2ac;
const STEEL_DARK = 0x3c424a;
const FLOOR = 0xc9ced4;
const TARMAC = 0x33363c;
const RUBBER = 0x141518;
const SKIN = [0xf0c8a0, 0xd9a273, 0xa9744c, 0x7a4f30];

/**
 * Re-exported for the circuit builder, which suppresses trackside furniture
 * along the paddock. It lives with the rest of the pit lane's plan now, so the
 * headless simulation can use it without pulling in Three.js.
 */
export { isPaddockGround };

/**
 * The team boards over each garage, as one texture atlas.
 *
 * One row per team, so all ten boards are a single draw call and a single
 * texture. Drawn in the visual language of a real pit-lane fascia: a flat field
 * of the team's colour, a hard accent flash, the entry code set large, and the
 * full name in condensed caps beside it.
 */
function makeTeamBoardAtlas(): THREE.Texture {
  const w = 512;
  const h = 96;
  const n = TEAMS.length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h * n;
  const ctx = canvas.getContext('2d')!;

  TEAMS.forEach((team, i) => {
    const y = i * h;
    const col = '#' + team.colour.toString(16).padStart(6, '0');
    const acc = '#' + team.accent.toString(16).padStart(6, '0');

    ctx.fillStyle = col;
    ctx.fillRect(0, y, w, h);

    // Accent flash across the right-hand third.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, w, h);
    ctx.clip();
    ctx.fillStyle = acc;
    ctx.beginPath();
    ctx.moveTo(w * 0.74, y);
    ctx.lineTo(w, y);
    ctx.lineTo(w, y + h);
    ctx.lineTo(w * 0.62, y + h);
    ctx.closePath();
    ctx.fill();
    // A shadow line under the top edge: fascias are extruded panels, and the
    // line is what says so.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y, w, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, y + h - 6, w, 6);
    ctx.restore();

    // Pick text colours that survive on either field.
    const lum = ((team.colour >> 16 & 255) * 0.299 + (team.colour >> 8 & 255) * 0.587 + (team.colour & 255) * 0.114) / 255;
    ctx.fillStyle = lum > 0.6 ? '#14171c' : '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '800 58px Helvetica, Arial, sans-serif';
    ctx.fillText(team.code, 22, y + h * 0.52);

    ctx.font = '700 34px Helvetica, Arial, sans-serif';
    let size = 34;
    const name = team.name.toUpperCase();
    while (ctx.measureText(name).width > w * 0.5 && size > 14) {
      size -= 1;
      ctx.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
    }
    ctx.fillText(name, 150, y + h * 0.54);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A board quad for team `index`, sized `w` x `h`, facing -Z in the local frame.
 *
 * The UVs run along -X because the board is read by someone standing in front
 * of it looking down +Z: in a right-handed frame that viewer's right hand
 * points along -X, so text laid out along +X comes out mirrored. This is the
 * same trap the trackside hoardings fell into.
 */
function boardQuad(index: number, w: number, h: number): THREE.BufferGeometry {
  const g = quadXY(w, h);
  const n = TEAMS.length;
  const v0 = 1 - (index + 1) / n;
  const v1 = 1 - index / n;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, v0, 1, v0, 1, v1,
    0, v0, 1, v1, 0, v1,
  ], 2));
  // quadXY faces +Z; turn it to face -Z. The turn is what puts u = 1 on the
  // reader's right; laying the UVs out mirrored *and* turning the quad cancels
  // out and prints the team's name backwards.
  g.rotateY(Math.PI);
  return g;
}

/**
 * One pit crew member, built once and merged wherever one is needed.
 *
 * Proportions are the whole job. A figure is read as a person by its
 * *silhouette*: a head roughly one seventh of the height, shoulders wider than
 * the hips, a gap between the legs, and arms that hang away from the body.
 * Any of those wrong and it reads as a bollard, no matter how many triangles
 * are spent on it. This costs about 150.
 */
function crewGeometry(overalls: number, kneeling: boolean): THREE.BufferGeometry {
  const bin = new PartsBin();
  const dark = 0x23262b;
  const skin = SKIN[Math.floor(rand(overalls * 0.017 + (kneeling ? 3 : 7)) * SKIN.length) % SKIN.length];
  const scale = kneeling ? 0.62 : 1;

  // Legs, slightly apart.
  const leg = chamferBox(0.17, 0.86 * scale, 0.2, 0);
  bin.add(leg, overalls, -0.11, 0.43 * scale, 0);
  bin.add(leg, overalls, 0.11, 0.43 * scale, 0);
  leg.dispose();

  // Boots.
  const boot = chamferBox(0.19, 0.12, 0.3, 0);
  bin.add(boot, dark, -0.11, 0.06, 0.04);
  bin.add(boot, dark, 0.11, 0.06, 0.04);
  boot.dispose();

  // Torso: wider at the shoulders than at the waist, which is most of what
  // makes the silhouette human.
  const hips = chamferBox(0.36, 0.26, 0.24, 0.05);
  bin.add(hips, overalls, 0, 0.86 * scale + 0.12, 0);
  hips.dispose();
  const chest = chamferBox(0.44, 0.44, 0.26, 0.05);
  bin.add(chest, overalls, 0, 0.86 * scale + 0.44, 0);
  chest.dispose();

  const shoulderY = 0.86 * scale + 0.6;
  // Arms, hanging slightly out from the body and angled forward.
  const arm = chamferBox(0.13, 0.56, 0.15, 0);
  const m = new THREE.Matrix4();
  for (const s of [-1, 1]) {
    m.makeRotationZ(s * 0.16);
    m.setPosition(s * 0.3, shoulderY - 0.32, 0.03);
    bin.addAt(arm, overalls, m);
  }
  arm.dispose();
  const glove = chamferBox(0.12, 0.14, 0.14, 0);
  bin.add(glove, dark, -0.34, shoulderY - 0.64, 0.05);
  bin.add(glove, dark, 0.34, shoulderY - 0.64, 0.05);
  glove.dispose();

  // Neck and head. An icosahedron is 20 triangles and reads as a head far
  // better than a box does, because it has no edge running down the face.
  const neck = chamferBox(0.13, 0.08, 0.13, 0);
  bin.add(neck, skin, 0, shoulderY + 0.06, 0);
  neck.dispose();
  const head = new THREE.IcosahedronGeometry(0.115, 0);
  head.deleteAttribute('uv');
  head.scale(0.95, 1.15, 1.0);
  head.translate(0, shoulderY + 0.2, 0);
  bin.addRaw(head, skin);
  // Cap or helmet, in team colour.
  const cap = chamferBox(0.23, 0.075, 0.24, 0);
  bin.add(cap, overalls, 0, shoulderY + 0.3, 0.01);
  cap.dispose();
  // A peak, so the head has a front.
  const peak = chamferBox(0.2, 0.04, 0.1, 0);
  bin.add(peak, overalls, 0, shoulderY + 0.28, -0.15);
  peak.dispose();

  return bin.merge() ?? chamferBox(0.4, 1.7, 0.3, 0.05);
}

/** A stack of tyres, as they sit at the back of every garage. */
function tyreStack(bin: PartsBin, x: number, y: number, z: number, n: number, band: number): void {
  const tyre = chamferCylinder(0.36, 0.31, 8, 0.05);
  const stripe = chamferCylinder(0.362, 0.06, 8, 0.02);
  for (let i = 0; i < n; i++) {
    const yy = y + 0.155 + i * 0.325;
    bin.add(tyre, RUBBER, x, yy, z);
    bin.add(stripe, band, x, yy + 0.1, z);
  }
  tyre.dispose();
  stripe.dispose();
}

/**
 * Builds the whole paddock for a circuit.
 *
 * `quality` halves the crowd, the crew and the tyre stacks and drops the
 * transporters, because on a phone the paddock is 30% of the frame for the
 * first ten seconds of a session and nothing after that.
 */
export function buildPaddock(track: TrackSpline, quality: 'low' | 'high'): PaddockScene {
  const root = new THREE.Group();
  root.name = 'paddock';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const low = quality === 'low';

  const lane = track.def.pitLane;
  // The pit complex's cross-section, shared with the circuit builder and the
  // race engine: where the wall stands, where the fast lane runs, and where the
  // garage frontage is. Building the garages off the same numbers is what keeps
  // the opening lined up with the box the car actually stops in.
  const pit = pitLaneGeometry(track.def, track.length);
  /** +1 if the pit lane is left of the centreline, -1 if right. */
  const dir = pit.sign;
  /** Local z of the pit wall's centre: negative, because it is track-side. */
  const wallZ = pit.wallMag - pit.garageFace;

  // Bins are per material, and there are only four of them for the whole
  // paddock.
  const solid = new PartsBin();
  const boards = new PartsBin();
  const glass = new PartsBin();
  const lights = new PartsBin();

  /**
   * The frame for a structure standing beside the pit lane at lap distance `s`.
   *
   *   +X runs along the lane, +Y is up, +Z points away from the track.
   *
   * `-dir` on the tangent keeps the basis right-handed whichever side of the
   * circuit the pit lane is on; without it the basis is a reflection on
   * right-hand pit lanes, every triangle winds backwards, and the entire
   * paddock renders inside-out.
   */
  const frameAt = (s: number, lateral: number): THREE.Matrix4 => {
    const i = track.indexAt(s);
    const tx = track.tx[i], tz = track.tz[i];
    const nx = track.nx[i], nz = track.nz[i];
    const ox = track.px[i] + nx * lateral;
    const oz = track.pz[i] + nz * lateral;
    const m = new THREE.Matrix4();
    m.set(
      -dir * tx, 0, dir * nx, ox,
      0, 1, 0, track.elevation[i],
      -dir * tz, 0, dir * nz, oz,
      0, 0, 0, 1,
    );
    return m;
  };

  // ---------------------------------------------------------------------------
  // Garage row
  // ---------------------------------------------------------------------------
  //
  // One bay per team, centred on that team's two pit boxes, so the car you are
  // sitting in at a garage start is sitting in its own team's garage.
  const teams = TEAMS;
  const bayCount = teams.length;
  const boardTex = makeTeamBoardAtlas();
  const frontLat = dir * pit.garageFace;
  /**
   * Lap distance of the centre of team `k`'s bay: the midpoint of the team's
   * two pit boxes, off the same anchor the painted boxes are laid out from.
   */
  const bayS = (k: number) => lane.boxS + PIT_ROW_ANCHOR_M - k * BAY_PITCH;

  for (let k = 0; k < bayCount; k++) {
    const team = teams[k];
    const s = bayS(k);
    const m = frameAt(s, frontLat);
    const bay = new PartsBin();
    const bayGlass = new PartsBin();
    const bayBoards = new PartsBin();
    const bayLights = new PartsBin();

    const colour = new THREE.Color(team.colour);
    const accent = new THREE.Color(team.accent);
    const wallDark = colour.clone().multiplyScalar(0.42);
    const half = BAY_PITCH / 2;
    const z0 = 0;                      // garage opening, on the frontage line
    const z1 = z0 + BAY_DEPTH;         // back wall

    // The concrete apron in front of the boxes, standing a few centimetres
    // proud of the working lane, which is what the step at a garage mouth
    // actually is.
    const apron = chamferBox(BAY_PITCH, 0.14, 3.4, 0.04);
    bay.add(apron, 0x8f959c, 0, 0.05, -1.6);
    apron.dispose();

    // Garage floor: pale epoxy, and it reads as *lit* because everything else
    // around it is dark.
    const floor = chamferBox(BAY_PITCH - 2.2, 0.12, BAY_DEPTH, 0.03);
    bay.add(floor, FLOOR, 0, 0.06, (z0 + z1) * 0.5);
    floor.dispose();

    // Dividing piers between bays.
    const pier = chamferBox(1.1, FLOOR_H, BAY_DEPTH + 0.6, 0.08);
    bay.add(pier, CONCRETE_DARK, -half + 0.55, FLOOR_H * 0.5, (z0 + z1) * 0.5);
    bay.add(pier, CONCRETE_DARK, half - 0.55, FLOOR_H * 0.5, (z0 + z1) * 0.5);
    pier.dispose();

    // Side walls, in the team's colour, so the inside of the box is liveried.
    const sideWall = chamferBox(0.25, BAY_CLEAR, BAY_DEPTH, 0.04);
    bay.add(sideWall, wallDark, -half + 1.2, BAY_CLEAR * 0.5, (z0 + z1) * 0.5);
    bay.add(sideWall, wallDark, half - 1.2, BAY_CLEAR * 0.5, (z0 + z1) * 0.5);
    sideWall.dispose();

    // Back wall and its livery panel.
    const back = chamferBox(BAY_PITCH - 2.2, FLOOR_H, 0.4, 0.05);
    bay.add(back, wallDark, 0, FLOOR_H * 0.5, z1 + 0.2);
    back.dispose();
    const stripe = chamferBox(BAY_PITCH - 3.4, 0.5, 0.1, 0);
    bay.add(stripe, accent.getHex(), 0, 3.7, z1 - 0.05);
    stripe.dispose();
    // The livery panel on the back wall of the box, facing out into the lane.
    bayBoards.addAt(boardQuad(k, 9.5, 1.6), 0xffffff,
      new THREE.Matrix4().makeTranslation(0, 2.5, z1 - 0.15));

    // Soffit over the box, and the header beam carrying the fascia.
    const soffit = chamferBox(BAY_PITCH - 2.2, 0.3, BAY_DEPTH + 0.4, 0.05);
    bay.add(soffit, 0xdfe3e8, 0, BAY_CLEAR + 0.15, (z0 + z1) * 0.5);
    soffit.dispose();
    const header = chamferBox(BAY_PITCH, FLOOR_H - BAY_CLEAR, 1.5, 0.09);
    bay.add(header, colour.getHex(), 0, (FLOOR_H + BAY_CLEAR) * 0.5, z0 - 0.3);
    header.dispose();

    // The team board on the header.
    bayBoards.addAt(boardQuad(k, 17.5, 0.72), 0xffffff,
      new THREE.Matrix4().makeTranslation(0, (FLOOR_H + BAY_CLEAR) * 0.5, z0 - 1.06));

    // Roller shutter housing across the top of the opening.
    const shutter = chamferCylinder(0.34, BAY_PITCH - 2.6, 8, 0.05);
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    bay.addAt(shutter, STEEL_DARK, new THREE.Matrix4().makeTranslation(0, BAY_CLEAR - 0.25, z0 + 0.35).multiply(rot));
    shutter.dispose();

    // Strip lights in the ceiling. Unlit geometry, so they glow through the
    // bloom pass and make the box read as an interior rather than a recess.
    const strip = chamferBox(BAY_PITCH - 6, 0.1, 0.34, 0);
    bayLights.add(strip, 0xfff3d8, 0, BAY_CLEAR - 0.08, z0 + 3.2);
    bayLights.add(strip, 0xfff3d8, 0, BAY_CLEAR - 0.08, z0 + 8.4);
    strip.dispose();

    // --- Kit inside the box ------------------------------------------------
    // Benches down both sides with monitors above them.
    const bench = chamferBox(0.9, 0.95, 6.5, 0);
    bay.add(bench, 0x2b2f36, -half + 1.9, 0.55, z0 + 5.5);
    bay.add(bench, 0x2b2f36, half - 1.9, 0.55, z0 + 5.5);
    bench.dispose();
    const monitor = chamferBox(0.08, 0.5, 0.85, 0);
    for (let i = 0; i < 3; i++) {
      bayGlass.add(monitor, 0x0a1a26, -half + 1.5, 2.1, z0 + 3.6 + i * 1.7);
      bayGlass.add(monitor, 0x0a1a26, half - 1.5, 2.1, z0 + 3.6 + i * 1.7);
    }
    monitor.dispose();

    // A spare chassis on stands under a cover. The strongest single cue that
    // a garage is a garage and not an alcove: something car-shaped, up off
    // the floor, with the crew's kit around it.
    if (!low) {
      const cover = chamferBox(1.85, 0.62, 4.6, 0.12);
      bay.add(cover, 0xdfe3e8, 5.6, 1.05, z0 + 6.4);
      cover.dispose();
      const nose = chamferBox(1.1, 0.34, 1.5, 0.1);
      bay.add(nose, accent.getHex(), 5.6, 0.98, z0 + 3.6);
      nose.dispose();
      const stand = chamferBox(0.5, 0.75, 0.5, 0);
      for (const dz of [-1.7, 1.7]) {
        bay.add(stand, STEEL_DARK, 5.6, 0.37, z0 + 6.4 + dz);
      }
      stand.dispose();
    }

    // Tool chest and the wheel-gun trolley.
    const chest = chamferBox(1.9, 1.0, 0.75, 0.05);
    bay.add(chest, accent.getHex(), -half + 3.4, 0.6, z1 - 1.0);
    bay.add(chest, 0x8d939b, half - 3.4, 0.6, z1 - 1.0);
    chest.dispose();

    // Tyre stacks at the back of the box, the compound bands showing.
    const stacks = low ? 2 : 3;
    const bands = [0xd42a2a, 0xe3d33a, 0xf0f0f0, 0x2aa5d4];
    for (let t = 0; t < stacks; t++) {
      tyreStack(
        bay,
        -half + 3.0 + t * 1.05,
        0.12,
        z1 - 2.6,
        low ? 2 : 3,
        bands[t % bands.length],
      );
    }

    // --- Kit out on the apron ----------------------------------------------
    // Kept clear of the two pit boxes, which sit at x = ±5.5 with a car in
    // each of them: equipment parked inside a box would be inside a car.
    const trolley = chamferBox(1.6, 0.85, 0.7, 0.05);
    bay.add(trolley, colour.getHex(), -10.2, 0.5, -1.2);
    bay.add(trolley, colour.getHex(), 10.2, 0.5, -1.2);
    trolley.dispose();
    const jack = chamferBox(0.3, 0.16, 1.8, 0);
    bay.add(jack, accent.getHex(), -0.9, 0.15, -1.4);
    bay.add(jack, accent.getHex(), 0.9, 0.15, -1.4);
    jack.dispose();
    const gun = chamferBox(0.7, 0.5, 0.5, 0.05);
    bay.add(gun, 0xd8dade, 0, 0.3, -0.5);
    gun.dispose();

    // --- Crew ---------------------------------------------------------------
    // Standing at the box, mostly facing out into the lane, the way a crew
    // waits: two by the trolley, a couple at the wall, one kneeling over a
    // wheel.
    // The two pit boxes are at x = ±5.5 and a car is 5m long, so the crew
    // stand at the ends of the bay and in the gap between the two cars.
    const spots: [number, number, boolean][] = [
      [-10.4, -2.3, false], [-8.6, -0.7, true], [0.2, -1.9, false],
      [8.7, -0.9, true], [10.3, -2.4, false],
    ];
    const crewN = low ? 3 : spots.length;
    for (let c = 0; c < crewN; c++) {
      const [sx, sz, kneel] = spots[c];
      const r1 = rand(k * 31.7 + c * 5.3);
      const fig = crewGeometry(team.colour, kneel);
      const fm = new THREE.Matrix4()
        .makeRotationY(Math.PI + (r1 - 0.5) * 1.6)
        .setPosition(sx + (r1 - 0.5) * 0.8, 0.1, sz);
      const placed = fig.clone().applyMatrix4(fm);
      fig.dispose();
      bay.addPrepared(placed);
    }

    // --- The team's timing stand on the pit wall -----------------------------
    //
    // The wall itself belongs to the circuit's pit-lane surface; what sits on
    // top of it is the team's, and it is one of the most recognisable objects
    // at a Grand Prix: a two-tier gantry in the team's colours with the
    // engineers on the top deck facing the track.
    const standBase = chamferBox(6.4, 0.5, 2.2, 0.06);
    bay.add(standBase, STEEL_DARK, -1.5, PIT_WALL_HEIGHT_M + 0.3, wallZ + 1.4);
    standBase.dispose();
    const standDeck = chamferBox(6.6, 0.25, 2.3, 0.05);
    bay.add(standDeck, colour.getHex(), -1.5, PIT_WALL_HEIGHT_M + 1.5, wallZ + 1.4);
    standDeck.dispose();
    const standRoof = chamferBox(7.0, 0.28, 2.6, 0.07);
    bay.add(standRoof, colour.clone().multiplyScalar(0.55).getHex(), -1.5, PIT_WALL_HEIGHT_M + 3.3, wallZ + 1.4);
    standRoof.dispose();
    const standPost = chamferBox(0.16, PIT_WALL_HEIGHT_M + 3.2, 0.16, 0);
    for (const sx of [-4.4, 1.4]) {
      bay.add(standPost, STEEL, sx, (PIT_WALL_HEIGHT_M + 3.2) * 0.5, wallZ + 0.4);
      bay.add(standPost, STEEL, sx, (PIT_WALL_HEIGHT_M + 3.2) * 0.5, wallZ + 2.4);
    }
    standPost.dispose();
    const standScreen = chamferBox(5.6, 0.7, 0.12, 0);
    bayGlass.add(standScreen, 0x0d2430, -1.5, PIT_WALL_HEIGHT_M + 2.25, wallZ + 0.45);
    standScreen.dispose();

    // Engineers on the stand, and one crew member out at the wall.
    if (!low) {
      for (let e = 0; e < 3; e++) {
        const fig = crewGeometry(team.colour, false);
        const fm = new THREE.Matrix4()
          .makeRotationY(Math.PI)
          .setPosition(-3.6 + e * 1.8, PIT_WALL_HEIGHT_M + 1.62, wallZ + 1.9);
        const placed = fig.clone().applyMatrix4(fm);
        fig.dispose();
        bay.addPrepared(placed);
      }
      const fig = crewGeometry(team.colour, false);
      const fm = new THREE.Matrix4().makeRotationY(0.4).setPosition(4.0, 0.1, wallZ + 1.4);
      const placed = fig.clone().applyMatrix4(fm);
      fig.dispose();
      bay.addPrepared(placed);
    }

    // Transform the finished bay into world space.
    const mergeInto = (from: PartsBin, to: PartsBin) => {
      const g = from.merge();
      if (g) {
        g.applyMatrix4(m);
        to.addPrepared(g);
      }
    };
    mergeInto(bay, solid);
    mergeInto(bayGlass, glass);
    mergeInto(bayBoards, boards);
    mergeInto(bayLights, lights);
  }

  // ---------------------------------------------------------------------------
  // Pit building: the storey above the garages
  // ---------------------------------------------------------------------------
  //
  // Built as one continuous run rather than per bay, because that is what it is
  // — the boxes are the ground floor of a single building, and the continuity
  // of the parapet and the glazing along its whole length is exactly what says
  // "pit complex" instead of "ten sheds".
  {
    const upper = new PartsBin();
    const upperGlass = new PartsBin();
    const segLen = BAY_PITCH;
    const y0 = FLOOR_H;
    const storey = 3.9;

    for (let k = 0; k < bayCount; k++) {
      const s = bayS(k);
      const m = frameAt(s, frontLat);
      const seg = new PartsBin();
      const segGlass = new PartsBin();
      const segLights = new PartsBin();

      // Floor slab, cantilevered forward over the apron as a canopy.
      const slab = chamferBox(segLen, 0.55, BAY_DEPTH + 5.4, 0.07);
      seg.add(slab, CONCRETE, 0, y0 + 0.27, BAY_DEPTH * 0.5 - 0.6);
      slab.dispose();
      // A soffit under it. The canopy hangs over the lane at eye level for
      // most of the opening seconds of a session, and a bare slab underside
      // lit only by bounce comes back as a blank white ceiling filling the
      // top of the frame.
      const soffitPanel = chamferBox(segLen - 0.3, 0.14, BAY_DEPTH + 5.0, 0);
      seg.add(soffitPanel, 0x7d848c, 0, y0 - 0.06, BAY_DEPTH * 0.5 - 0.6);
      soffitPanel.dispose();
      const downlight = chamferBox(segLen - 5, 0.06, 0.3, 0);
      segLights.add(downlight, 0xfff0d4, 0, y0 - 0.14, -1.4);
      downlight.dispose();

      // Glazed front wall, set back behind a balcony.
      const balconyZ = 1.0;
      const glazing = chamferBox(segLen - 0.4, storey - 0.9, 0.16, 0);
      segGlass.add(glazing, 0x24404f, 0, y0 + 0.55 + (storey - 0.9) * 0.5, balconyZ + 2.4);
      glazing.dispose();
      const mullion = chamferBox(0.16, storey - 0.9, 0.3, 0);
      for (let i = 0; i <= 7; i++) {
        seg.add(mullion, STEEL, (i / 7 - 0.5) * (segLen - 0.6), y0 + 0.55 + (storey - 0.9) * 0.5, balconyZ + 2.4);
      }
      mullion.dispose();

      // Balcony railing along the front edge.
      const rail = chamferBox(segLen, 0.09, 0.09, 0);
      seg.add(rail, STEEL, 0, y0 + 1.55, balconyZ - 1.5);
      seg.add(rail, STEEL, 0, y0 + 1.05, balconyZ - 1.5);
      rail.dispose();
      const post = chamferBox(0.09, 1.1, 0.09, 0);
      for (let i = 0; i <= 10; i++) {
        seg.add(post, STEEL, (i / 10 - 0.5) * (segLen - 0.2), y0 + 1.1, balconyZ - 1.5);
      }
      post.dispose();

      // Parapet and cornice: the top edge of the building, chamfered, with a
      // shadow gap under it. Cheap, and it is what stops the roofline reading
      // as a cut in the sky.
      const cornice = chamferBox(segLen, 0.4, BAY_DEPTH + 5.6, 0.08);
      seg.add(cornice, CONCRETE, 0, y0 + storey + 0.75, BAY_DEPTH * 0.5 - 0.7);
      cornice.dispose();
      const parapet = chamferBox(segLen, 0.95, 0.3, 0.06);
      seg.add(parapet, 0xdadde1, 0, y0 + storey + 1.4, balconyZ - 1.7);
      parapet.dispose();
      const gap = chamferBox(segLen, 0.22, 0.22, 0);
      seg.add(gap, STEEL_DARK, 0, y0 + storey + 0.45, balconyZ - 1.65);
      gap.dispose();

      // --- Roof ---------------------------------------------------------
      // Seen from the grandstand opposite, the roof is a third of the
      // building's visible area, and a bare slab up there undoes the
      // articulation everywhere else. Plant, ducting and a handrail run
      // along it, and a media centre stands over the middle bays: real
      // circuits put race control and the press on the top floor above the
      // start line, and the step in the roofline is the pit complex's one
      // landmark from anywhere on the lap.
      const roofY = y0 + storey + 0.95;
      if (k % 2 === 1) {
        const plant = chamferBox(3.2, 1.1, 2.4, 0.08);
        seg.add(plant, 0x8d939b, -3.5, roofY + 0.55, 9.5);
        plant.dispose();
        const duct = chamferBox(0.9, 0.7, 5.5, 0.06);
        seg.add(duct, 0xb6bcc2, 3.2, roofY + 0.35, 7.5);
        duct.dispose();
      }
      const railTop = chamferBox(segLen, 0.07, 0.07, 0);
      seg.add(railTop, STEEL, 0, roofY + 1.0, BAY_DEPTH + 4.0);
      railTop.dispose();
      const railPost = chamferBox(0.07, 1.0, 0.07, 0);
      for (let i = 0; i <= 6; i++) {
        seg.add(railPost, STEEL, (i / 6 - 0.5) * (segLen - 0.3), roofY + 0.5, BAY_DEPTH + 4.0);
      }
      railPost.dispose();

      if (k === 4 || k === 5) {
        const towerH = 4.6;
        const shell = chamferBox(segLen, towerH, 11.5, 0.12);
        seg.add(shell, 0xd7dae0, 0, roofY + towerH * 0.5, 4.2);
        shell.dispose();
        const towerGlass = chamferBox(segLen - 0.5, 2.3, 0.2, 0);
        segGlass.add(towerGlass, 0x24404f, 0, roofY + 2.5, -1.5);
        towerGlass.dispose();
        const brow = chamferBox(segLen + 0.6, 0.42, 12.4, 0.1);
        seg.add(brow, 0x8f959c, 0, roofY + towerH + 0.2, 4.2);
        brow.dispose();
        const mast = chamferBox(0.18, 5.5, 0.18, 0);
        seg.add(mast, STEEL_DARK, k === 4 ? -8 : 8, roofY + towerH + 2.9, 8.5);
        mast.dispose();
      }

      const g = seg.merge();
      if (g) { g.applyMatrix4(m); upper.addPrepared(g); }
      const gg = segGlass.merge();
      if (gg) { gg.applyMatrix4(m); upperGlass.addPrepared(gg); }
      const gl = segLights.merge();
      if (gl) { gl.applyMatrix4(m); lights.addPrepared(gl); }
    }

    const g = upper.merge();
    if (g) solid.addPrepared(g);
    const gg = upperGlass.merge();
    if (gg) glass.addPrepared(gg);
  }

  // ---------------------------------------------------------------------------
  // Paddock behind the pit building
  // ---------------------------------------------------------------------------
  {
    const back = new PartsBin();
    const backGlass = new PartsBin();
    const rowLen = BAY_PITCH * bayCount;
    const centreS = lane.boxS + PIT_ROW_ANCHOR_M - ((bayCount - 1) * BAY_PITCH) / 2;
    const m = frameAt(centreS, frontLat);

    // The paddock apron itself: tarmac, with a painted edge line.
    const yard = chamferBox(rowLen + 40, 0.1, 62, 0.05);
    back.add(yard, TARMAC, 0, 0.03, BAY_DEPTH + 38);
    yard.dispose();

    // Hospitality units, one per team: a two-storey motorhome with a glazed
    // ground floor and an awning over a terrace.
    for (let k = 0; k < bayCount; k++) {
      const team = teams[k];
      const colour = new THREE.Color(team.colour);
      const x = (k - (bayCount - 1) / 2) * BAY_PITCH;
      const z = BAY_DEPTH + 22;
      const unit = new PartsBin();

      const body = chamferBox(16.5, 7.2, 9.5, 0.14);
      unit.add(body, colour.clone().multiplyScalar(0.5).getHex(), 0, 3.6, 0);
      body.dispose();
      const band = chamferBox(16.7, 0.7, 9.7, 0.06);
      unit.add(band, colour.getHex(), 0, 4.0, 0);
      band.dispose();
      const roof = chamferBox(17.2, 0.45, 10.2, 0.09);
      unit.add(roof, 0xd2d6da, 0, 7.35, 0);
      roof.dispose();

      // Glazing front and back: a hospitality unit is mostly window, and the
      // back of it is what the whole paddock looks at.
      const win = chamferBox(14.5, 2.0, 0.2, 0);
      backGlass.add(win, 0x1e3947, x, 1.9, z - 4.85);
      backGlass.add(win, 0x1e3947, x, 5.5, z - 4.85);
      backGlass.add(win, 0x1e3947, x, 5.5, z + 4.85);
      win.dispose();

      // Roof terrace: a handrail round the edge, the plant every one of these
      // carries, and a pair of parasols.
      const rrail = chamferBox(17.0, 0.06, 0.06, 0);
      unit.add(rrail, STEEL, 0, 8.5, -5.0);
      unit.add(rrail, STEEL, 0, 8.5, 5.0);
      rrail.dispose();
      const rpost = chamferBox(0.06, 0.9, 0.06, 0);
      for (let i = 0; i <= 8; i++) {
        const rx = (i / 8 - 0.5) * 16.6;
        unit.add(rpost, STEEL, rx, 8.05, -5.0);
        unit.add(rpost, STEEL, rx, 8.05, 5.0);
      }
      rpost.dispose();
      const ac = chamferBox(2.2, 0.8, 1.6, 0.06);
      unit.add(ac, 0x9aa0a6, -5.5, 7.95, 2.4);
      unit.add(ac, 0x9aa0a6, 5.5, 7.95, 2.4);
      ac.dispose();
      const parasol = chamferCylinder(1.5, 0.12, 8, 0.05);
      const stem = chamferBox(0.09, 2.2, 0.09, 0);
      for (const px3 of [-4, 4]) {
        unit.add(parasol, 0xf2f4f6, px3, 9.6, -1.5);
        unit.add(stem, STEEL_DARK, px3, 8.7, -1.5);
      }
      parasol.dispose();
      stem.dispose();

      // Terrace: an awning on posts, with a couple of parasols and tables.
      const awning = chamferBox(15, 0.22, 5.5, 0.07);
      unit.add(awning, 0xe6e9ec, 0, 3.6, -7.4);
      awning.dispose();
      const apost = chamferBox(0.16, 3.5, 0.16, 0);
      for (const px2 of [-7, -2.3, 2.3, 7]) unit.add(apost, STEEL, px2, 1.75, -9.9);
      apost.dispose();
      const table = chamferCylinder(0.5, 0.06, 8, 0.02);
      const leg = chamferBox(0.09, 0.72, 0.09, 0);
      for (let t = 0; t < 3; t++) {
        const tx2 = -5 + t * 5;
        unit.add(table, 0xdfe3e8, tx2, 0.78, -8.4);
        unit.add(leg, STEEL_DARK, tx2, 0.36, -8.4);
      }
      table.dispose();
      leg.dispose();

      const g = unit.merge();
      if (g) {
        g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, 0, z));
        back.addPrepared(g);
      }
    }

    // Transporters, backed up in a row at the far side of the paddock.
    if (!low) {
      for (let k = 0; k < bayCount; k++) {
        const team = teams[k];
        const x = (k - (bayCount - 1) / 2) * BAY_PITCH + 4;
        const z = BAY_DEPTH + 46;
        const truck = new PartsBin();
        const trailer = chamferBox(2.6, 3.4, 13.6, 0.1);
        truck.add(trailer, 0xe8ebee, 0, 2.4, 0);
        trailer.dispose();
        const livery = chamferBox(2.65, 1.5, 13.0, 0);
        truck.add(livery, team.colour, 0, 2.9, 0);
        livery.dispose();
        const cab = chamferBox(2.5, 2.6, 2.6, 0.12);
        truck.add(cab, team.colour, 0, 1.9, 8.1);
        cab.dispose();
        const wheel = chamferCylinder(0.52, 0.32, 6, 0.05);
        const wrot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
        for (const wz of [-5.2, -3.9, 6.2, 8.6]) {
          for (const wx of [-1.25, 1.25]) {
            truck.addAt(wheel, RUBBER, new THREE.Matrix4().makeTranslation(wx, 0.52, wz).multiply(wrot));
          }
        }
        wheel.dispose();
        const g = truck.merge();
        if (g) {
          g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI * 0.5).setPosition(x, 0, z));
          back.addPrepared(g);
        }
      }
    }

    const g = back.merge();
    if (g) { g.applyMatrix4(m); solid.addPrepared(g); }
    const gg = backGlass.merge();
    if (gg) { gg.applyMatrix4(m); glass.addPrepared(gg); }
  }

  // ---------------------------------------------------------------------------
  // Publish the merged meshes
  // ---------------------------------------------------------------------------
  const publish = (bin: PartsBin, mat: THREE.Material) => {
    // Tracked for disposal whether or not it ends up on screen: a material
    // created and then dropped because its bin was empty still holds a GL
    // program.
    materials.push(mat);
    const geo = bin.merge();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    root.add(mesh);
    geometries.push(geo);
  };

  publish(solid, structureMaterial({ roughness: 0.78, metalness: 0.1 }));
  publish(glass, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.14, metalness: 0.7,
  }));
  const boardMat = new THREE.MeshBasicMaterial({ map: boardTex, side: THREE.DoubleSide });
  publish(boards, boardMat);
  textures.push(boardTex);
  publish(lights, new THREE.MeshBasicMaterial({ vertexColors: true }));

  // ---------------------------------------------------------------------------
  // Main grandstands, facing the pits across the track
  // ---------------------------------------------------------------------------
  {
    const opts = grandstandPreset('main', quality, 3);
    const geo = buildGrandstandGeometry(opts);
    const stands = 3;
    const mat = structureMaterial({ roughness: 0.8, metalness: 0.06 });
    const mesh = new THREE.InstancedMesh(geo, mat, stands);
    const rowCentre = lane.boxS + PIT_ROW_ANCHOR_M - ((bayCount - 1) * BAY_PITCH) / 2;
    const m = new THREE.Matrix4();
    // The pit straight is not the only piece of circuit near the pit straight.
    // On a street circuit the lap folds back on itself within a few dozen
    // metres, so a 74m stand placed blindly opposite the pits can land across
    // another part of the road. Same test as the set dressing uses.
    const keepOut = buildKeepOutField(track);
    const margin = (track.def.scenery === 'street' ? 2.5 : 14) + 2;
    let placed = 0;
    for (let i = 0; i < stands; i++) {
      const s = rowCentre + (i - (stands - 1) / 2) * (opts.width + 6);
      const idx = track.indexAt(s);
      const hw = track.width[idx] * 0.5;
      // Opposite side of the circuit from the pit lane.
      const side = -dir;
      const tx = track.tx[idx], tz = track.tz[idx];
      const nx = track.nx[idx], nz = track.nz[idx];
      // The stand is anchored at its front barrier and built backwards, so the
      // box that describes it sits half a depth further out.
      const cos = side * nx;
      const sin = -side * nz;
      let lateral = 0;
      let clear = false;
      for (let attempt = 0; attempt < 8 && !clear; attempt++) {
        lateral = side * (hw + 17 + attempt * 8);
        const cxw = track.px[idx] + nx * lateral + cos * MAIN_STAND_DEPTH_M * 0.5;
        const czw = track.pz[idx] + nz * lateral - sin * MAIN_STAND_DEPTH_M * 0.5;
        clear = keepOut.clearOfBox(
          cxw, czw, cos, sin,
          MAIN_STAND_DEPTH_M * 0.5, MAIN_STAND_WIDTH_M * 0.5, margin,
        );
      }
      if (!clear) continue;
      // Local +X away from the track, +Z along it; `side` on both keeps the
      // basis right-handed on either side of the circuit.
      m.set(
        side * nx, 0, side * tx, track.px[idx] + nx * lateral,
        0, 1, 0, track.elevation[idx],
        side * nz, 0, side * tz, track.pz[idx] + nz * lateral,
        0, 0, 0, 1,
      );
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    root.add(mesh);
    geometries.push(geo);
    materials.push(mat);
  }

  return {
    root,
    dispose(): void {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      root.clear();
    },
  };
}
