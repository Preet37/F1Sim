import * as THREE from 'three';
import {
  PartsBin, chamferBox, chamferCylinder, quadXY, rand, structureMaterial,
} from './ChamferKit';
import {
  CREW_DETAIL_HIGH, CREW_DETAIL_LOW, POSTURES, mergeCrewFigure,
  type CrewDetail, type PostureName,
} from './CrewFigure';
import { buildGrandstandGeometry, grandstandPreset } from './Grandstands';
import { TEAMS } from '../data/teams';
import { getCompound } from '../data/tires';
import {
  isPaddockGround,
  pitLaneGeometry,
  PIT_BAY_PITCH_M,
  PIT_WALL_HEIGHT_M,
} from '../track/PitGeometry';
import { buildKeepOutField, CAR_REACH_M } from '../track/WorldObstacles';
import type { WorldModel } from '../track/WorldObstacles';
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
 * Tessellation for the whole paddock, chosen once per session.
 *
 * Module-level rather than threaded, because the paddock is assembled by about
 * thirty small builders and every one of them would otherwise have to carry a
 * parameter it makes no other use of. `buildPaddock` sets this before it builds
 * anything and the whole assembly is synchronous, so there is no window in
 * which two tiers could be live at once.
 *
 * Before this existed the quality tier controlled the crowd COUNT and nothing
 * else — every radial segment and every chamfer in the file was a literal, so
 * the high tier rendered exactly the same faceting as a phone did.
 */
interface PaddockDetail {
  /** Radial segments on a lathe: tyres, drums, poles, wheels. */
  round: number;
  /** Chamfer applied to the small parts that used to have none, in metres. */
  trim: number;
  /** How finely the people are tessellated. */
  crew: CrewDetail;
}

const DETAIL_HIGH: PaddockDetail = { round: 20, trim: 0.012, crew: CREW_DETAIL_HIGH };
const DETAIL_LOW: PaddockDetail = { round: 8, trim: 0, crew: CREW_DETAIL_LOW };
let D: PaddockDetail = DETAIL_HIGH;

/**
 * The figure the paddock's standing population is built from.
 *
 * Delegated to `CrewFigure`, which the WORKING crew also uses. There used to be
 * a second, separate figure in this file — its own skeleton, its own
 * proportions, its own limb primitive — and two people modelled twice is two
 * people who diverge: a fix to one silently left the other as it was. The one
 * that mattered was that these were the figures a player actually looks at, and
 * the ones being maintained were the others.
 *
 * Everything here is merged into the paddock's single static buffer, so a bay
 * with three people in it costs three people's triangles and no draw calls at
 * all. That is the entire reason there are two ways to build the same figure.
 */
function crewGeometry(overalls: number, pose: PostureName, seed = 0): THREE.BufferGeometry {
  // A little scatter in the posture, so ten bays are not ten identical people.
  // The seed is deterministic — the paddock must look the same on every load.
  const p = { ...POSTURES[pose] };
  const r = rand(overalls * 0.017 + seed * 3.1 + 7);
  p.spineLean += (r - 0.5) * 0.16;
  p.armPitch += (rand(seed * 1.7 + 3) - 0.5) * 0.3;
  p.armSpread += (rand(seed * 2.3 + 11) - 0.5) * 0.12;
  p.stance += (rand(seed * 0.9 + 5) - 0.5) * 0.2;
  return mergeCrewFigure(p, overalls, D.crew);
}

/** A stack of tyres, as they sit at the back of every garage. */
function tyreStack(bin: PartsBin, x: number, y: number, z: number, n: number, band: number): void {
  const tyre = chamferCylinder(0.36, 0.31, D.round, 0.05);
  const stripe = chamferCylinder(0.362, 0.06, D.round, 0.02);
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
export function buildPaddock(
  track: TrackSpline, quality: 'low' | 'high', world: WorldModel,
): PaddockScene {
  const root = new THREE.Group();
  root.name = 'paddock';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const low = quality === 'low';
  // Set before anything is built; see the note on PaddockDetail.
  D = low ? DETAIL_LOW : DETAIL_HIGH;

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
  const bayS = (k: number) => pit.rowAnchorS - k * BAY_PITCH;

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
    const stripe = chamferBox(BAY_PITCH - 3.4, 0.5, 0.1, D.trim);
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
    const shutter = chamferCylinder(0.34, BAY_PITCH - 2.6, D.round, 0.05);
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    bay.addAt(shutter, STEEL_DARK, new THREE.Matrix4().makeTranslation(0, BAY_CLEAR - 0.25, z0 + 0.35).multiply(rot));
    shutter.dispose();

    // Strip lights in the ceiling. Unlit geometry, so they glow through the
    // bloom pass and make the box read as an interior rather than a recess.
    const strip = chamferBox(BAY_PITCH - 6, 0.1, 0.34, D.trim);
    bayLights.add(strip, 0xfff3d8, 0, BAY_CLEAR - 0.08, z0 + 3.2);
    bayLights.add(strip, 0xfff3d8, 0, BAY_CLEAR - 0.08, z0 + 8.4);
    strip.dispose();

    // --- Kit inside the box ------------------------------------------------
    // Benches down both sides with monitors above them.
    const bench = chamferBox(0.9, 0.95, 6.5, D.trim);
    bay.add(bench, 0x2b2f36, -half + 1.9, 0.55, z0 + 5.5);
    bay.add(bench, 0x2b2f36, half - 1.9, 0.55, z0 + 5.5);
    bench.dispose();
    const monitor = chamferBox(0.08, 0.5, 0.85, D.trim);
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
      const stand = chamferBox(0.5, 0.75, 0.5, D.trim);
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
    //
    // Read from the compound table rather than eyeballed. These four literals
    // used to be near-misses of the real values, so a stack in the garage was a
    // slightly different red from the sidewall on the car and the dot in the
    // timing tower — three shades of "soft" on one screen.
    const stacks = low ? 2 : 3;
    const bands = (['soft', 'medium', 'hard', 'wet'] as const).map((id) => getCompound(id).colour);
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
    //
    // Trolleys at the ends of the bay and NOTHING between them. The two pit
    // boxes sit at x = ±5.5 with a car in each, and a jack and a wheel gun used
    // to be parked permanently on the paint between them at every one of the
    // ten garages — twenty jacks lying in the road with nobody near them, all
    // race. The jacks and the guns belong to the crew, and the crew are in
    // `PitCrew.ts` now, so they arrive when the car does and leave with it.
    const trolley = chamferBox(1.6, 0.85, 0.7, 0.05);
    bay.add(trolley, colour.getHex(), -10.2, 0.5, -1.2);
    bay.add(trolley, colour.getHex(), 10.2, 0.5, -1.2);
    trolley.dispose();
    // The gantry the release light hangs off, one per box. The lamp itself
    // belongs to the working crew — it is the one thing in a pit box that
    // changes — but the post is furniture and stands there all weekend.
    const lightPost = chamferBox(0.14, 2.4, 0.14, D.trim);
    bay.add(lightPost, STEEL_DARK, -5.5 - 2.0, 1.2, -2.6);
    bay.add(lightPost, STEEL_DARK, 5.5 - 2.0, 1.2, -2.6);
    lightPost.dispose();

    // --- Who is actually standing here -------------------------------------
    //
    // "insane amount of pit crews", and they were right twice over.
    //
    // There were eleven figures at every one of the ten garages — a hundred and
    // ten people — and seven of each eleven were arranged AROUND THE PIT BOXES
    // in working poses: crouched over wheel guns, shouldering tyres, bent over
    // jacks. Twenty crews performing a pit stop on twenty cars that were not
    // there, for the whole race. It is not what a pit lane looks like and it is
    // not what a pit crew does: between stops the crew is inside the garage,
    // and they come over the wall when their car is on its way in.
    //
    // So what is left here is the people who really are always there — a couple
    // of mechanics inside the box, and the engineers on the pit wall stand —
    // and the twenty-one who do the work arrive with the car. See `PitCrew.ts`.
    const inside: [number, number, PostureName, number][] = [
      [-6.2, 3.4, 'stand', 0.35],
      [6.6, 4.1, 'stand', -0.5],
      [-half + 3.6, z1 - 2.2, 'ready', 2.4],
    ];
    const crewN = low ? 1 : inside.length;
    for (let c = 0; c < crewN; c++) {
      const [sx, sz, pose, heading] = inside[c];
      const r1 = rand(k * 31.7 + c * 5.3);
      const fig = crewGeometry(team.colour, pose, k * 7 + c);
      const fm = new THREE.Matrix4()
        // The figure faces its own +Z and the pit lane is at -Z — the garage
        // runs back into the building — so the half turn is what has a mechanic
        // looking out of the box rather than at the back wall.
        .makeRotationY(Math.PI + heading + (r1 - 0.5) * 0.4)
        .setPosition(sx + (r1 - 0.5) * 0.6, 0.12, sz);
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
    const standPost = chamferBox(0.16, PIT_WALL_HEIGHT_M + 3.2, 0.16, D.trim);
    for (const sx of [-4.4, 1.4]) {
      bay.add(standPost, STEEL, sx, (PIT_WALL_HEIGHT_M + 3.2) * 0.5, wallZ + 0.4);
      bay.add(standPost, STEEL, sx, (PIT_WALL_HEIGHT_M + 3.2) * 0.5, wallZ + 2.4);
    }
    standPost.dispose();
    const standScreen = chamferBox(5.6, 0.7, 0.12, D.trim);
    bayGlass.add(standScreen, 0x0d2430, -1.5, PIT_WALL_HEIGHT_M + 2.25, wallZ + 0.45);
    standScreen.dispose();

    // Engineers sitting along the stand facing the track, and one crew member
    // out at the wall. Seated is not a detail: a row of standing figures on a
    // gantry reads as spectators, and the whole point of a pit wall stand is
    // that the people on it are sitting at a bank of screens.
    if (!low) {
      for (let e = 0; e < 3; e++) {
        const fig = crewGeometry(team.colour, 'sit', k * 3 + e);
        const fm = new THREE.Matrix4()
          .makeRotationY(Math.PI)
          // The deck's top face, so the seated figure's hips land on it.
          .setPosition(-3.6 + e * 1.8, PIT_WALL_HEIGHT_M + 1.62, wallZ + 2.0);
        const placed = fig.clone().applyMatrix4(fm);
        fig.dispose();
        bay.addPrepared(placed);
      }
      const fig = crewGeometry(team.colour, 'stand', k * 5 + 2);
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
      const soffitPanel = chamferBox(segLen - 0.3, 0.14, BAY_DEPTH + 5.0, D.trim);
      seg.add(soffitPanel, 0x7d848c, 0, y0 - 0.06, BAY_DEPTH * 0.5 - 0.6);
      soffitPanel.dispose();
      const downlight = chamferBox(segLen - 5, 0.06, 0.3, D.trim);
      segLights.add(downlight, 0xfff0d4, 0, y0 - 0.14, -1.4);
      downlight.dispose();

      // Glazed front wall, set back behind a balcony.
      const balconyZ = 1.0;
      const glazing = chamferBox(segLen - 0.4, storey - 0.9, 0.16, D.trim);
      segGlass.add(glazing, 0x24404f, 0, y0 + 0.55 + (storey - 0.9) * 0.5, balconyZ + 2.4);
      glazing.dispose();
      const mullion = chamferBox(0.16, storey - 0.9, 0.3, D.trim);
      for (let i = 0; i <= 7; i++) {
        seg.add(mullion, STEEL, (i / 7 - 0.5) * (segLen - 0.6), y0 + 0.55 + (storey - 0.9) * 0.5, balconyZ + 2.4);
      }
      mullion.dispose();

      // Balcony railing along the front edge.
      const rail = chamferBox(segLen, 0.09, 0.09, D.trim);
      seg.add(rail, STEEL, 0, y0 + 1.55, balconyZ - 1.5);
      seg.add(rail, STEEL, 0, y0 + 1.05, balconyZ - 1.5);
      rail.dispose();
      const post = chamferBox(0.09, 1.1, 0.09, D.trim);
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
      const gap = chamferBox(segLen, 0.22, 0.22, D.trim);
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
      // The handrail runs along the BACK EDGE OF THE ROOF DECK, and where that
      // edge is comes from the deck rather than from a number of its own.
      //
      // It used to be at BAY_DEPTH + 4.0, which is 1.9m beyond the deck: the
      // cornice is `BAY_DEPTH + 5.6` deep centred at `BAY_DEPTH * 0.5 - 0.7`,
      // so the roof stops at BAY_DEPTH + 2.1 and the railing was hanging in
      // mid-air behind the building. Invisible from the pit straight, which is
      // where the pit complex is normally looked at from — and at Zandvoort the
      // circuit climbs into the dunes behind the paddock and passes the pit
      // building at roof height, so those floating posts were the 445 vertices
      // `validate:world` reported standing on the racing surface at s=858m.
      const roofBackZ = BAY_DEPTH * 0.5 - 0.7 + (BAY_DEPTH + 5.6) * 0.5;
      const railZ = roofBackZ - 0.25;
      const railTop = chamferBox(segLen, 0.07, 0.07, D.trim);
      seg.add(railTop, STEEL, 0, roofY + 1.0, railZ);
      railTop.dispose();
      const railPost = chamferBox(0.07, 1.0, 0.07, D.trim);
      for (let i = 0; i <= 6; i++) {
        seg.add(railPost, STEEL, (i / 6 - 0.5) * (segLen - 0.3), roofY + 0.5, railZ);
      }
      railPost.dispose();

      if (k === 4 || k === 5) {
        const towerH = 4.6;
        const shell = chamferBox(segLen, towerH, 11.5, 0.12);
        seg.add(shell, 0xd7dae0, 0, roofY + towerH * 0.5, 4.2);
        shell.dispose();
        const towerGlass = chamferBox(segLen - 0.5, 2.3, 0.2, D.trim);
        segGlass.add(towerGlass, 0x24404f, 0, roofY + 2.5, -1.5);
        towerGlass.dispose();
        const brow = chamferBox(segLen + 0.6, 0.42, 12.4, 0.1);
        seg.add(brow, 0x8f959c, 0, roofY + towerH + 0.2, 4.2);
        brow.dispose();
        const mast = chamferBox(0.18, 5.5, 0.18, D.trim);
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
    const centreS = pit.rowAnchorS - ((bayCount - 1) * BAY_PITCH) / 2;
    const m = frameAt(centreS, frontLat);

    // -----------------------------------------------------------------------
    // Everything from here back has to be checked against the circuit.
    //
    // The paddock is laid out in one rigid frame taken at the middle of the pit
    // straight, and it reaches eighty metres behind the garage face. That is
    // fine on a permanent circuit built round a paddock. It is not fine on a
    // lap that folds back on itself: at Monaco the road behind the pits is
    // inside that eighty metres, so the yard, the hospitality units and the
    // transporters were laid straight across it — five metres of them on the
    // racing surface, between ground level and nine metres up, which is exactly
    // the height a car occupies. Nothing tested it and nothing collided with
    // it, so cars drove through the back of the paddock every lap.
    //
    // Interlagos and Zandvoort had the same defect in less obvious forms: at
    // Interlagos the transporters hang eleven to sixteen metres ABOVE a piece
    // of road, which cannot be hit but reads as a row of articulated lorries
    // parked in the sky over the circuit.
    //
    // So each structure back here is now tested where it will actually stand
    // and dropped if it stands on the road — the same rule `buildSceneryLayout`
    // applies to a grandstand, applied to the largest structures in the game.
    // -----------------------------------------------------------------------
    const backKeepOut = buildKeepOutField(track);
    const backMargin = (track.def.scenery === 'street' ? 2.5 : 14) + CAR_REACH_M;
    const centreIdx = track.indexAt(centreS);
    // The paddock frame's axes as `clearOfBox` wants them: its local +X runs
    // along the pit lane, which is the box's "along track" axis, and its local
    // +Z runs away from the circuit, which is the box's "across" axis.
    const backCos = -dir * track.tz[centreIdx];
    const backSin = -dir * track.tx[centreIdx];

    /** True when a box in paddock-local plan coordinates is clear of the lap. */
    const backClear = (
      localX: number, localZ: number, halfAlong: number, halfDeep: number,
    ): boolean => {
      const v = new THREE.Vector3(localX, 0, localZ).applyMatrix4(m);
      return backKeepOut.clearOfBox(
        v.x, v.z, backCos, backSin, halfDeep, halfAlong, backMargin,
      );
    };

    // The paddock apron itself: tarmac, with a painted edge line.
    //
    // Shortened rather than dropped where it will not fit. A paddock with no
    // ground under it is a worse artefact than a shallow one, and the apron is
    // the only piece back here whose size is free to give.
    const YARD_DEEP_M = 62;
    let yardDepth = YARD_DEEP_M;
    while (yardDepth > 8 && !backClear(0, BAY_DEPTH + 7 + yardDepth * 0.5, (rowLen + 40) * 0.5, yardDepth * 0.5)) {
      yardDepth -= 4;
    }
    if (yardDepth > 8) {
      const yard = chamferBox(rowLen + 40, 0.1, yardDepth, 0.05);
      back.add(yard, TARMAC, 0, 0.03, BAY_DEPTH + 7 + yardDepth * 0.5);
      yard.dispose();
    }

    // Hospitality units, one per team: a two-storey motorhome with a glazed
    // ground floor and an awning over a terrace.
    for (let k = 0; k < bayCount; k++) {
      const team = teams[k];
      const colour = new THREE.Color(team.colour);
      const x = (k - (bayCount - 1) / 2) * BAY_PITCH;
      const z = BAY_DEPTH + 22;
      // The unit is 17.2m along the lane and reaches from its terrace awning at
      // z-9.9 to its glazing at z+4.85 — so it is centred 2.5m short of `z` and
      // is 14.75m deep. Tested as it is built, not as a nominal block.
      if (!backClear(x, z - 2.5, 8.6, 7.4)) continue;
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
      const win = chamferBox(14.5, 2.0, 0.2, D.trim);
      backGlass.add(win, 0x1e3947, x, 1.9, z - 4.85);
      backGlass.add(win, 0x1e3947, x, 5.5, z - 4.85);
      backGlass.add(win, 0x1e3947, x, 5.5, z + 4.85);
      win.dispose();

      // Roof terrace: a handrail round the edge, the plant every one of these
      // carries, and a pair of parasols.
      const rrail = chamferBox(17.0, 0.06, 0.06, D.trim);
      unit.add(rrail, STEEL, 0, 8.5, -5.0);
      unit.add(rrail, STEEL, 0, 8.5, 5.0);
      rrail.dispose();
      const rpost = chamferBox(0.06, 0.9, 0.06, D.trim);
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
      const parasol = chamferCylinder(1.5, 0.12, D.round, 0.05);
      const stem = chamferBox(0.09, 2.2, 0.09, D.trim);
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
      const apost = chamferBox(0.16, 3.5, 0.16, D.trim);
      for (const px2 of [-7, -2.3, 2.3, 7]) unit.add(apost, STEEL, px2, 1.75, -9.9);
      apost.dispose();
      const table = chamferCylinder(0.5, 0.06, D.round, 0.02);
      const leg = chamferBox(0.09, 0.72, 0.09, D.trim);
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
        // Rotated a quarter turn, so the 13.6m trailer plus its cab lies ALONG
        // the lane and the 2.6m width runs back from it.
        if (!backClear(x, z, 8.8, 1.6)) continue;
        const truck = new PartsBin();
        const trailer = chamferBox(2.6, 3.4, 13.6, 0.1);
        truck.add(trailer, 0xe8ebee, 0, 2.4, 0);
        trailer.dispose();
        const livery = chamferBox(2.65, 1.5, 13.0, D.trim);
        truck.add(livery, team.colour, 0, 2.9, 0);
        livery.dispose();
        const cab = chamferBox(2.5, 2.6, 2.6, 0.12);
        truck.add(cab, team.colour, 0, 1.9, 8.1);
        cab.dispose();
        const wheel = chamferCylinder(0.52, 0.32, D.round, 0.05);
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
    // WHERE they stand is not decided here any more.
    //
    // It used to be, and that was the bug: the paddock placed three
    // seventy-four-metre grandstands, tested them against the circuit, drew
    // them, and told nothing else in the game they existed. They were the
    // largest structures on every circuit and not one of them was solid, so a
    // car that ran wide opposite the pits went through the main grandstand and
    // out the other side. The layout lives in `buildMainStands` now, in the
    // world model both the renderer and the race engine read.
    const items = world.scenery.filter((it) => it.kind === 'mainstand');
    const opts = grandstandPreset('main', quality, 3);
    const geo = buildGrandstandGeometry(opts);
    const mat = structureMaterial({ roughness: 0.8, metalness: 0.06 });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
    const m = new THREE.Matrix4();
    let placed = 0;
    for (const item of items) {
      // The item's yaw is the stand's own heading; rebuild the basis from it so
      // the drawn stand sits exactly on the box that was tested and is collided.
      // Local +X away from the track, +Z along it.
      const c = Math.cos(item.yaw);
      const sn = Math.sin(item.yaw);
      m.set(
        c, 0, sn, item.x,
        0, 1, 0, item.y,
        -sn, 0, c, item.z,
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
