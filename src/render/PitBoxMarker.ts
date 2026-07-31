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
 * This marks exactly one box — the player's — in their team's colours, with a
 * stop bar to bring the front wheels up to and a pair of pylons tall enough to
 * be seen over the pit wall from up the lane, rather than only once the car is
 * already level with the box and too late to stop.
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

/** How far the pylons stand above the apron, metres. */
const PYLON_H = 4.2;
const PYLON_R = 0.15;
/** Height of the crossbar between them. */
const BAR_H = 0.55;
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

  // The gate: two posts and a crossbar over the mouth of the box.
  //
  // A marking on the floor of a pit lane is invisible from a hundred metres up
  // the lane at eighty km/h, which is precisely where the driver needs to start
  // aiming for it. Something standing up, above the pit wall line, is not — and
  // the posts were 2.6m of 8.5cm pole, which at that distance is a hair.
  const pylonGeo = new THREE.CylinderGeometry(PYLON_R, PYLON_R * 1.35, PYLON_H, 10);
  disposables.push(pylonGeo);
  const feet: THREE.Vector3[] = [];
  for (const s of [boxS - half, boxS + half]) {
    const base = W(s, inner - 0.15, PIT_APRON_HEIGHT_M);
    const pylon = new THREE.Mesh(pylonGeo, accentMat);
    pylon.position.set(base.x, base.y + PYLON_H * 0.5, base.z);
    root.add(pylon);
    feet.push(base);
  }
  if (feet.length === 2) {
    const barGeo = new THREE.BoxGeometry(feet[0].distanceTo(feet[1]), BAR_H, 0.16);
    disposables.push(barGeo);
    const bar = new THREE.Mesh(barGeo, teamMat);
    bar.position.set(
      (feet[0].x + feet[1].x) * 0.5,
      (feet[0].y + feet[1].y) * 0.5 + PYLON_H - BAR_H * 0.5,
      (feet[0].z + feet[1].z) * 0.5,
    );
    bar.lookAt(feet[1].x, bar.position.y, feet[1].z);
    bar.rotateY(Math.PI / 2);
    root.add(bar);
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
