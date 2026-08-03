import * as THREE from 'three';
import type { TrackSpline } from '../track/TrackSpline';
import type { CarEntry } from '../race/CarEntry';
import {
  pitLaneGeometry,
  PIT_APRON_DEPTH_M,
  PIT_APRON_HEIGHT_M,
  PIT_GARAGE_SPACING_M,
} from '../track/PitGeometry';

/**
 * The player's own pit box, marked so it can be found at eighty km/h.
 *
 * A Formula 1 pit lane has twenty painted boxes and they are, deliberately,
 * almost identical: the crew tells the driver where to stop, and the driver
 * knows which garage is theirs because they have walked into it all weekend. A
 * player has neither. The circuit's painted boxes give them nothing at all to
 * distinguish theirs from the nineteen others they are about to drive past, so
 * the simulation was asking them to stop somewhere it had never shown them.
 *
 * This marks exactly one box — the player's — in their team's colours, and it
 * marks it in the four places a driver actually looks, in the order he looks at
 * them: a mast and a number board standing above the pit wall line, visible
 * from a hundred metres up the lane; chevrons on the ground leading in, picked
 * up while there is still road to slow in; the driver's own race number painted
 * across the box, which is the last confirmation before committing; and a stop
 * bar to bring the front wheels up to.
 *
 * The box POSITION is not computed here. It comes from `PitGeometry.boxS`, the
 * same function the circuit builder paints the boxes with, the paddock lays its
 * garages out from, and the race engine services the car at. The marker lands
 * on the paint, the paint is under the right garage, and the crew is at the
 * same metre, because all four read from one function.
 */

export interface PitBoxMarker {
  root: THREE.Group;
  /** Shows or hides the marker. */
  setVisible(on: boolean): void;
  dispose(): void;
}

/**
 * The board on its mast: how high it stands and how big it is.
 *
 * This replaced a pair of 4.2m pylons 300mm across standing at the two front
 * corners of the box with a crossbar between them — a gate the car drove
 * through. It read from up the lane, which was the point, and then it stood in
 * the middle of the pit stop: the near pylon filled a third of the frame from
 * the driver's seat, both of them were inside the space the wheel crew work in,
 * and the crossbar was directly over the car. A marker that hides the thing it
 * marks has stopped being a marker.
 *
 * One mast, on the FAST LANE side of the box and set back up the lane, is out
 * of the working area entirely and is the first thing in view on the approach
 * — which is where it is needed, because by the time the box is beside you the
 * stop is already missed.
 */
const MAST_H = 3.6;
const MAST_R = 0.055;
/** The number board: metres wide and tall. */
const BOARD_W = 1.05;
const BOARD_H = 1.35;
/** Chevrons laid up the working lane towards the box, and their spacing. */
const CHEVRONS = 6;
const CHEVRON_PITCH_M = 7;
const CHEVRON_LEN_M = 2.4;
const CHEVRON_W_M = 0.85;
/** How far the paint floats above the apron, to stay out of a z-fight. */
const PAINT_LIFT = 0.02;
/** Width of the painted lines, metres. */
const LINE_W = 0.3;

export function buildPitBoxMarker(track: TrackSpline, player: CarEntry): PitBoxMarker {
  const root = new THREE.Group();
  root.name = 'player-pit-box';

  const g = pitLaneGeometry(track.def, track.length);
  const sgn = g.sign;
  const boxS = player.pitBoxS;
  const count = track.count;
  const nodeM = track.length / count;

  /**
   * World position for a distance along the lap, a lateral MAGNITUDE, and a
   * height above the road.
   *
   * Same construction the circuit builder uses for the pit lane paint —
   * including the banking term — so the marker sits on the surface rather than
   * hovering over it or sinking into it on a banked or undulating pit lane.
   */
  const W = (s: number, mag: number, dy: number): THREE.Vector3 => {
    const w = ((s % track.length) + track.length) % track.length;
    const f = w / nodeM;
    const i = Math.floor(f) % count;
    const j = (i + 1) % count;
    const t = f - Math.floor(f);
    const lat = sgn * mag;
    const cx = track.px[i] + (track.px[j] - track.px[i]) * t;
    const cz = track.pz[i] + (track.pz[j] - track.pz[i]) * t;
    const nx = track.nx[i] + (track.nx[j] - track.nx[i]) * t;
    const nz = track.nz[i] + (track.nz[j] - track.nz[i]) * t;
    const ey = track.elevation[i] + (track.elevation[j] - track.elevation[i]) * t;
    const bank = track.banking[i];
    const y = ey + (bank !== 0 ? -lat * Math.tan(bank) : 0) + dy;
    return new THREE.Vector3(cx + nx * lat, y, cz + nz * lat);
  };

  const disposables: { dispose(): void }[] = [];

  const teamMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(player.team.colour),
    roughness: 0.55, metalness: 0.03,
    emissive: new THREE.Color(player.team.colour), emissiveIntensity: 0.4,
    side: THREE.DoubleSide,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(player.team.accent),
    roughness: 0.45, metalness: 0.05,
    emissive: new THREE.Color(player.team.accent), emissiveIntensity: 0.75,
    side: THREE.DoubleSide,
  });
  disposables.push(teamMat, accentMat);

  // The marking goes on the garage apron, which stands proud of the working
  // lane. Paint laid at road level disappears underneath that step.
  const yPaint = PIT_APRON_HEIGHT_M + PAINT_LIFT;
  const inner = g.garageFace - PIT_APRON_DEPTH_M + 0.25;
  const outer = g.garageFace - 0.45;
  const half = PIT_GARAGE_SPACING_M * 0.5 - 0.6;

  const verts: number[] = [];
  const accentVerts: number[] = [];
  const chevronVerts: number[] = [];

  /** A flat quad between two distances and two lateral magnitudes. */
  const quad = (
    into: number[], s0: number, s1: number, m0: number, m1: number, dy: number,
  ): void => {
    const a = W(s0, m0, dy);
    const b = W(s0, m1, dy);
    const c = W(s1, m1, dy);
    const d = W(s1, m0, dy);
    into.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    into.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };

  // The box outline: two sides and a back, in the team's primary colour.
  quad(verts, boxS - half, boxS - half + LINE_W, inner, outer, yPaint);
  quad(verts, boxS + half - LINE_W, boxS + half, inner, outer, yPaint);
  quad(verts, boxS - half, boxS + half, outer - LINE_W, outer, yPaint);

  // The stop bar: the one line that actually has to be hit, so it is the
  // accent colour and it sits marginally higher to read cleanly over the
  // outline where they meet.
  quad(accentVerts, boxS + 0.9, boxS + 1.5, inner + 0.35, outer - LINE_W, yPaint + 0.005);

  const mkMesh = (data: number[], mat: THREE.Material): void => {
    if (data.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data, 3));
    geo.computeVertexNormals();
    disposables.push(geo);
    root.add(new THREE.Mesh(geo, mat));
  };
  mkMesh(verts, teamMat);
  mkMesh(accentVerts, accentMat);

  // Chevrons up the working lane, pointing in.
  //
  // Paint inside the box tells a driver nothing until he is level with it, and
  // by then the stop is missed. This is the cue he picks up first: a run of
  // arrows laid up the lane towards the box, starting far enough back to be in
  // view while there is still room to slow and pull across.
  const chevIn = g.divider + 0.4;
  const chevOut = g.garageFace - 0.4;
  const chevMid = (chevIn + chevOut) * 0.5;
  for (let k = 1; k <= CHEVRONS; k++) {
    const s0 = boxS - half - k * CHEVRON_PITCH_M;
    const tip = s0 + CHEVRON_LEN_M;
    for (const [m0, m1] of [[chevIn, chevMid], [chevOut, chevMid]] as [number, number][]) {
      const a = W(s0, m0, yPaint);
      const b = W(s0 + CHEVRON_W_M, m0, yPaint);
      const c = W(tip + CHEVRON_W_M, m1, yPaint);
      const d = W(tip, m1, yPaint);
      chevronVerts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      chevronVerts.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
  }
  mkMesh(chevronVerts, accentMat);

  // The driver's own race number, painted in the box.
  //
  // This is what a real pit box has and what the game did not: every box on the
  // grid carries its car's number on the ground, big enough to read from the
  // fast lane, because a driver arriving at eighty km/h is counting boxes and
  // needs the last confirmation without turning his head. "I also dont really
  // know where my pit is" is exactly that missing confirmation.
  const numberTex = makeNumberTexture(player.driver.raceNumber, player.team.colour, player.team.accent);
  const numberMat = new THREE.MeshStandardMaterial({
    map: numberTex, transparent: true, roughness: 0.7, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  disposables.push(numberTex, numberMat);
  {
    // Just UP-LANE of the box, and SQUARE.
    //
    // Both matter. Painted inside the box it spends the whole stop underneath
    // the car, which is the only part of the stop when a driver might want to
    // check it; and stretched to fill the box it is 8.6m long by 1.6m wide,
    // which turns a two-digit number into an unreadable blue smear — that is
    // exactly what the first attempt produced.
    const size = Math.min(outer - inner - 0.9, 2.0);
    const centre = boxS - half - size * 0.5 - 0.6;
    const n0 = centre - size * 0.5;
    const n1 = centre + size * 0.5;
    const m0 = (inner + outer) * 0.5 - size * 0.5;
    const m1 = (inner + outer) * 0.5 + size * 0.5;
    const a = W(n1, m0, yPaint + 0.004);
    const b = W(n1, m1, yPaint + 0.004);
    const c = W(n0, m1, yPaint + 0.004);
    const d = W(n0, m0, yPaint + 0.004);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
      a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
    ], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 0, 1, 0, 1, 1,
      0, 0, 1, 1, 0, 1,
    ], 2));
    geo.computeVertexNormals();
    disposables.push(geo);
    root.add(new THREE.Mesh(geo, numberMat));
  }

  // The mast, and the board on it.
  //
  // Paint on the floor of a pit lane is invisible from a hundred metres back at
  // eighty km/h, which is precisely where the driver has to start aiming for the
  // box. Something standing up, above the line of the pit wall, is not.
  //
  // It stands on the FAST LANE side and set back up the lane, clear of the
  // twenty-one people who are about to be working in the box — see the note on
  // `MAST_H` for what the previous arrangement did to the view.
  {
    const mastGeo = new THREE.CylinderGeometry(MAST_R, MAST_R * 1.3, MAST_H, 12);
    disposables.push(mastGeo);
    const base = W(boxS - half - 1.1, g.divider + 0.35, PIT_APRON_HEIGHT_M * 0.5);
    const mast = new THREE.Mesh(mastGeo, accentMat);
    mast.position.set(base.x, base.y + MAST_H * 0.5, base.z);
    root.add(mast);

    // The board faces back up the lane, at the driver.
    const up = W(boxS - half - 1.1 - 0.5, g.divider + 0.35, 0);
    const geo = new THREE.PlaneGeometry(BOARD_W, BOARD_H);
    disposables.push(geo);
    const board = new THREE.Mesh(geo, numberMat);
    board.position.set(base.x, base.y + MAST_H - BOARD_H * 0.55, base.z);
    board.lookAt(up.x, board.position.y, up.z);
    root.add(board);
  }

  return {
    root,
    setVisible(on: boolean): void { root.visible = on; },
    dispose(): void {
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
}

/**
 * The driver's race number, as a texture.
 *
 * Drawn rather than modelled because a numeral built from geometry is either
 * unreadable or expensive, and this one has to be legible on the ground from
 * fifty metres and on a board a metre across from a hundred. A 256x256 canvas
 * is a few kilobytes and one material shared between the two.
 *
 * The number is set in the TEAM's accent on a field of its primary colour, with
 * a hard outline — the same treatment a real pit box gets, and the reason the
 * whole marker reads as "this box belongs to that team" rather than as a decal.
 */
function makeNumberTexture(number: number, colour: number, accent: number): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const primary = '#' + colour.toString(16).padStart(6, '0');
  const acc = '#' + accent.toString(16).padStart(6, '0');

  ctx.clearRect(0, 0, size, size);
  // A rounded plate rather than a full square: a hard rectangle of team colour
  // on the ground reads as a missing texture, a plate reads as paint.
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fillStyle = primary;
  ctx.fill();

  const text = String(number);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let px = 190;
  ctx.font = '900 ' + px + 'px Helvetica, Arial, sans-serif';
  while (ctx.measureText(text).width > size * 0.78 && px > 40) {
    px -= 6;
    ctx.font = '900 ' + px + 'px Helvetica, Arial, sans-serif';
  }
  ctx.lineWidth = px * 0.09;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(text, size / 2, size * 0.54);
  ctx.fillStyle = acc;
  ctx.fillText(text, size / 2, size * 0.54);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
