import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeGantryTexture, makeHoardingTexture, makeMarkerTexture } from './Signage';
import { isPaddockGround } from './Paddock';
import { buildGrandstandGeometry, grandstandPreset } from './Grandstands';
import { SurfaceDetail, SURFACES, type SurfaceProfile } from './SurfaceDetail';
import {
  pitLaneGeometry,
  PIT_ENTRY_LEAD_M,
  PIT_EXIT_JOIN_M,
  PIT_EXIT_MERGE_M,
  PIT_APRON_DEPTH_M,
  PIT_APRON_HEIGHT_M,
  PIT_GARAGE_COUNT,
  PIT_GARAGE_SPACING_M,
  PIT_WALL_HEIGHT_M,
} from '../track/PitGeometry';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Builds the circuit's geometry once, at session load.
 *
 * Everything is generated from the same TrackSpline the simulation drives on, so
 * what you see is exactly what the physics uses — the kerb you can see is the kerb
 * that costs you 15% of your lateral grip, and the white line you can see is the
 * one race control measures track limits against.
 *
 * All surfaces are merged into a handful of meshes with vertex colours rather than
 * one mesh per segment. A 7km circuit at 3m resolution is 2300 segments; as
 * separate objects that is 2300 draw calls and a mobile GPU will not do it. Merged,
 * the whole circuit is five draw calls.
 */

export interface TrackMeshes {
  /** Everything static: asphalt, kerbs, run-off, grass, walls, scenery. */
  root: THREE.Group;
  /** Disposes every geometry and material this created. */
  dispose(): void;
}

/** Vertical offsets, in metres, to avoid z-fighting between coplanar surfaces. */
const Y_GROUND = -0.02;
const Y_RUNOFF = 0.0;
const Y_ROAD = 0.02;
const Y_LINE = 0.035;
const Y_KERB = 0.055;

const COLOUR = {
  asphalt: new THREE.Color(0x1d1e20),
  asphaltDark: new THREE.Color(0x181a1c),
  runoff: new THREE.Color(0x4f4034),
  whiteLine: new THREE.Color(0xd8dade),
  kerbA: new THREE.Color(0xc8353c),
  kerbB: new THREE.Color(0xe8e8ea),
  grass: new THREE.Color(0x2c4526),
  desert: new THREE.Color(0x8a7355),
  gravel: new THREE.Color(0x9a9285),
  wall: new THREE.Color(0x9aa0a8),
  /** Painted stripe along the top of a street circuit's wall. */
  wallStripe: new THREE.Color(0xd8dce2),
  /** Concrete footing under the armco, and the fence rail above it. */
  wallBase: new THREE.Color(0x6f757e),
  /** Galvanised steel: bright, slightly blue, and it catches the sun. */
  armco: new THREE.Color(0xb9c0c9),
  /** The shadowed gap between the two rails. */
  armcoGap: new THREE.Color(0x2a2e35),
  pit: new THREE.Color(0x33363c),
  startLine: new THREE.Color(0xe8e8ea),
  /** Pit wall: painted white concrete under a sponsor band. */
  pitWallFace: new THREE.Color(0xd7dade),
  pitWallBand: new THREE.Color(0xa2242c),
  pitWallTop: new THREE.Color(0xb6bbc1),
  /** Pit-lane edge kerbing. Blue down the wall, green round the entry road. */
  pitKerbBlue: new THREE.Color(0x1d4fa0),
  pitKerbGreen: new THREE.Color(0x1b7a42),
  /** The stop bar inside a pit box: yellow, so it reads against the asphalt. */
  pitBoxMark: new THREE.Color(0xd8c23a),
};

/** Scenery ground colour by circuit type. */
function groundColour(scenery: string): THREE.Color {
  switch (scenery) {
    case 'desert': return COLOUR.desert;
    case 'street': return new THREE.Color(0x4a4d54);
    case 'coastal': return new THREE.Color(0x6d6a55);
    case 'forest': return new THREE.Color(0x2b4527);
    default: return COLOUR.grass;
  }
}

/**
 * Accumulates triangles with vertex colours into one buffer.
 * Building typed arrays up front and filling them beats pushing onto JS arrays
 * for a mesh this size.
 */
class StripBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colours: number[] = [];

  /** Adds a quad as two triangles, with a flat colour and an up-facing normal. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    colour: THREE.Color,
  ): void {
    // Triangle winding: (a,b,c) and (a,c,d), counter-clockwise seen from above.
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, colour);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, colour);
  }

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    colour: THREE.Color,
  ): void {
    // Face normal from the cross product, so sloped surfaces light correctly.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) this.normals.push(nx, ny, nz);
    for (let i = 0; i < 3; i++) this.colours.push(colour.r, colour.g, colour.b);
  }

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  build(): THREE.BufferGeometry | null {
    if (this.positions.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    g.computeBoundingSphere();
    return g;
  }
}

export function buildTrackMeshes(track: TrackSpline, quality: 'low' | 'high'): TrackMeshes {
  const root = new THREE.Group();
  root.name = 'circuit';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const count = track.count;
  // Step in nodes. At 3m per node, a step of 2 gives 6m quads — plenty for a
  // stylised look and it halves the triangle count on mobile.
  const step = quality === 'low' ? 3 : 2;

  // One instance shared by every surface, so the whole circuit samples the same
  // two textures and adjacent surfaces line up with no seam between them.
  const detail = new SurfaceDetail();

  const road = new StripBuilder();
  const kerbs = new StripBuilder();
  const lines = new StripBuilder();
  const runoff = new StripBuilder();
  const walls = new StripBuilder();
  const pit = new StripBuilder();

  const KERB_W = 0.9;
  const LINE_W = 0.14;
  const RUNOFF_W = 9;
  const WALL_H = 1.5;

  // The pit lane's full plan and cross-section, derived once and shared by
  // everything below — the lane surface, its paint, its walls, and the decision
  // about which pieces of ordinary trackside furniture have to give way to it.
  const pitGeom = pitLaneGeometry(track.def, track.length);
  /**
   * True where the pit lane occupies the ground on this side of the circuit.
   *
   * The run-off, barrier, fencing, hoardings and set dressing are all laid down
   * blindly at a fixed offset from the track edge for the whole lap. Along the
   * pits that puts an armco through the middle of the fast lane and a strip of
   * gravel-brown run-off where the apron should be.
   */
  const pitSideAt = (node: number, side: -1 | 1): boolean => {
    if (side !== pitGeom.sign) return false;
    // Only the lane's working length, not its tapered ends. Over the taper the
    // circuit's own run-off and barrier are still the right thing to see beside
    // the entry and exit roads — suppressing them there leaves the track edge
    // running straight into open grass.
    const u = pitGeom.u(track.dist[node]);
    return u > pitGeom.entryOpenU - 25 && u < pitGeom.exitU + 25;
  };

  /** World position at (node, lateral, height). */
  const px = (i: number, lat: number) => track.px[i] + track.nx[i] * lat;
  const pz = (i: number, lat: number) => track.pz[i] + track.nz[i] * lat;
  const py = (i: number, lat: number) => {
    // Banking tilts the surface about the track's centreline.
    const bank = track.banking[i];
    return track.elevation[i] + (bank !== 0 ? -lat * Math.tan(bank) : 0);
  };

  for (let a = 0; a < count; a += step) {
    const b = (a + step) % count;

    const hwA = track.width[a] * 0.5;
    const hwB = track.width[b] * 0.5;

    // --- Asphalt ---------------------------------------------------------
    // Alternate the shade slightly every few segments so the surface reads as
    // asphalt rather than a flat colour, without any texture memory.
    const shade = ((a / step) & 3) === 0 ? COLOUR.asphaltDark : COLOUR.asphalt;
    road.quad(
      px(a, -hwA), py(a, -hwA) + Y_ROAD, pz(a, -hwA),
      px(b, -hwB), py(b, -hwB) + Y_ROAD, pz(b, -hwB),
      px(b, hwB), py(b, hwB) + Y_ROAD, pz(b, hwB),
      px(a, hwA), py(a, hwA) + Y_ROAD, pz(a, hwA),
      shade,
    );

    // --- White lines at the track edge ------------------------------------
    for (const side of [-1, 1] as const) {
      const inA = side * (hwA - LINE_W);
      const inB = side * (hwB - LINE_W);
      const outA = side * hwA;
      const outB = side * hwB;
      lines.quad(
        px(a, inA), py(a, inA) + Y_LINE, pz(a, inA),
        px(b, inB), py(b, inB) + Y_LINE, pz(b, inB),
        px(b, outB), py(b, outB) + Y_LINE, pz(b, outB),
        px(a, outA), py(a, outA) + Y_LINE, pz(a, outA),
        COLOUR.whiteLine,
      );
    }

    // --- Kerbs -------------------------------------------------------------
    // Three surfaces per kerb rather than one flat strip: an inner ramp up from
    // the asphalt, a flat crown, and an outer fall to the run-off. A single flat
    // quad reads as a painted stripe; the raised crown reads as a real kerb and
    // catches the light differently as the car passes, which is a large part of
    // what makes an apex legible.
    const kerbColour = ((a / step) & 1) === 0 ? COLOUR.kerbA : COLOUR.kerbB;
    const buildKerb = (sign: number) => {
      const inner = sign * hwA;
      const innerB = sign * hwB;
      const crownIn = sign * (hwA + KERB_W * 0.3);
      const crownInB = sign * (hwB + KERB_W * 0.3);
      const crownOut = sign * (hwA + KERB_W * 0.85);
      const crownOutB = sign * (hwB + KERB_W * 0.85);
      const outer = sign * (hwA + KERB_W * 1.25);
      const outerB = sign * (hwB + KERB_W * 1.25);

      const wind = sign > 0;
      const q = (
        l0: number, y0: number, l1: number, y1: number,
      ) => {
        // Consistent winding per side so faces point upward.
        if (wind) {
          kerbs.quad(
            px(a, l0), py(a, l0) + y0, pz(a, l0),
            px(b, l0 === inner ? innerB : l0 === crownIn ? crownInB : l0 === crownOut ? crownOutB : outerB), py(b, l0) + y0, pz(b, l0 === inner ? innerB : l0 === crownIn ? crownInB : l0 === crownOut ? crownOutB : outerB),
            px(b, l1 === inner ? innerB : l1 === crownIn ? crownInB : l1 === crownOut ? crownOutB : outerB), py(b, l1) + y1, pz(b, l1 === inner ? innerB : l1 === crownIn ? crownInB : l1 === crownOut ? crownOutB : outerB),
            px(a, l1), py(a, l1) + y1, pz(a, l1),
            kerbColour,
          );
        } else {
          kerbs.quad(
            px(a, l1), py(a, l1) + y1, pz(a, l1),
            px(b, l1 === inner ? innerB : l1 === crownIn ? crownInB : l1 === crownOut ? crownOutB : outerB), py(b, l1) + y1, pz(b, l1 === inner ? innerB : l1 === crownIn ? crownInB : l1 === crownOut ? crownOutB : outerB),
            px(b, l0 === inner ? innerB : l0 === crownIn ? crownInB : l0 === crownOut ? crownOutB : outerB), py(b, l0) + y0, pz(b, l0 === inner ? innerB : l0 === crownIn ? crownInB : l0 === crownOut ? crownOutB : outerB),
            px(a, l0), py(a, l0) + y0, pz(a, l0),
            kerbColour,
          );
        }
      };

      q(inner, Y_ROAD, crownIn, Y_KERB);          // ramp up
      q(crownIn, Y_KERB, crownOut, Y_KERB);       // flat crown
      q(crownOut, Y_KERB, outer, Y_RUNOFF);       // fall away
    };

    // Lateral is positive to the driver's LEFT.
    if (track.isCurbLeft[a] && track.isCurbLeft[b]) buildKerb(1);
    if (track.isCurbRight[a] && track.isCurbRight[b]) buildKerb(-1);

    // --- Run-off ----------------------------------------------------------
    const isStreet = track.def.scenery === 'street';
    const runoffW = isStreet ? 2.2 : RUNOFF_W;
    const runoffColour = isStreet ? COLOUR.pit : COLOUR.runoff;
    for (const side of [-1, 1] as const) {
      const iA = side * (hwA + KERB_W * 0.5);
      const iB = side * (hwB + KERB_W * 0.5);
      const oA = side * (hwA + runoffW);
      const oB = side * (hwB + runoffW);
      if (side < 0) {
        runoff.quad(
          px(a, oA), py(a, oA) + Y_RUNOFF, pz(a, oA),
          px(b, oB), py(b, oB) + Y_RUNOFF, pz(b, oB),
          px(b, iB), py(b, iB) + Y_RUNOFF, pz(b, iB),
          px(a, iA), py(a, iA) + Y_RUNOFF, pz(a, iA),
          runoffColour,
        );
      } else {
        runoff.quad(
          px(a, iA), py(a, iA) + Y_RUNOFF, pz(a, iA),
          px(b, iB), py(b, iB) + Y_RUNOFF, pz(b, iB),
          px(b, oB), py(b, oB) + Y_RUNOFF, pz(b, oB),
          px(a, oA), py(a, oA) + Y_RUNOFF, pz(a, oA),
          runoffColour,
        );
      }
    }

    // --- Barriers ----------------------------------------------------------
    //
    // Placed exactly where RaceEngine.enforceBarriers puts them, so a barrier
    // you can see is a barrier you actually hit.
    //
    // Built as real trackside furniture rather than as one flat slab. A permanent
    // circuit runs steel armco — a concrete base, two or three horizontal rails
    // with a gap between them, and posts at intervals — with debris fencing
    // above it. Those horizontal lines streaming past are a large part of the
    // sensation of speed, and the gap between the rails is what lets you see
    // through to the run-off and the crowd beyond. A solid wall reads as a
    // corridor; this reads as a circuit.
    //
    // Street circuits get a solid concrete wall instead, because that is what
    // they actually use and it is why they punish a mistake so much harder.
    const barrierOffset = isStreet ? 2.5 : 14;
    for (const side of [-1, 1] as const) {
      // Along the pits the pit wall and the garages are the boundary.
      if (isPaddockGround(track, a, side) || pitSideAt(a, side)) continue;
      const oA = side * (hwA + barrierOffset);
      const oB = side * (hwB + barrierOffset);
      const yA = py(a, oA) + Y_RUNOFF;
      const yB = py(b, oB) + Y_RUNOFF;

      /**
       * One vertical band of barrier, from y0 to y1 above the ground.
       * Wound so the face toward the track is the front face on both sides.
       */
      const band = (y0: number, y1: number, colour: THREE.Color) => {
        if (side > 0) {
          walls.quad(
            px(a, oA), yA + y0, pz(a, oA),
            px(b, oB), yB + y0, pz(b, oB),
            px(b, oB), yB + y1, pz(b, oB),
            px(a, oA), yA + y1, pz(a, oA),
            colour,
          );
        } else {
          walls.quad(
            px(a, oA), yA + y1, pz(a, oA),
            px(b, oB), yB + y1, pz(b, oB),
            px(b, oB), yB + y0, pz(b, oB),
            px(a, oA), yA + y0, pz(a, oA),
            colour,
          );
        }
      };

      if (isStreet) {
        // Solid concrete, with a painted stripe along the top edge the way a
        // real street circuit marks its walls.
        band(0, WALL_H * 0.86, COLOUR.wall);
        band(WALL_H * 0.86, WALL_H, COLOUR.wallStripe);
      } else {
        // Concrete footing, then armco: lower rail, gap, upper rail.
        band(0, 0.30, COLOUR.wallBase);
        band(0.30, 0.62, COLOUR.armco);
        band(0.62, 0.74, COLOUR.armcoGap);
        band(0.74, 1.06, COLOUR.armco);
        // The fence itself is drawn separately as a transparent mesh; this is
        // the dark rail it is bolted to.
        band(1.06, WALL_H, COLOUR.wallBase);
      }
    }
  }

  // --- Pit lane ------------------------------------------------------------
  //
  // The lane used to be a flat grey ribbon laid between the pit-entry and
  // pit-exit distances: the same width from end to end, no wall, no paint, and
  // both ends simply stopping in the middle of the run-off. Driving it, the
  // circuit was to one side, an invisible barrier to the other, and there was
  // no visible point at which you had joined or left it.
  //
  // A real pit lane is a piece of road with a plan. It leaves the circuit at a
  // marked split, it is separated from the racing surface by a wall for its
  // whole working length, it is divided down the middle by a painted line, and
  // it rejoins over a blend line that converges onto the track edge. All of
  // that is geometry, not decoration — it is what tells a driver where the lane
  // begins, which half of it he may drive on, and where he is allowed to put
  // the car back on the circuit.
  //
  // Everything is written in the lane's own frame: `u` metres from the split,
  // and a MAGNITUDE from the centreline that `pitGeom.sign` puts on the correct
  // side. That is what makes the same code build a left-hand pit lane and a
  // right-hand one without a reflected, inside-out copy of itself.
  {
    const g = pitGeom;
    const sgn = g.sign;

    const idxAt = (u: number) => track.indexAt(g.splitS + u);
    const hwAt = (u: number) => track.width[idxAt(u)] * 0.5;
    const edges = (u: number) => g.edgesAt(u, hwAt(u));

    /** A point in the lane's frame: node, lateral magnitude, height above road. */
    const P = (i: number, m: number, dy: number): [number, number, number] => {
      const lat = sgn * m;
      return [px(i, lat), py(i, lat) + dy, pz(i, lat)];
    };
    const quadP = (
      b: StripBuilder,
      p0: [number, number, number], p1: [number, number, number],
      p2: [number, number, number], p3: [number, number, number],
      colour: THREE.Color,
    ): void => b.quad(
      p0[0], p0[1], p0[2], p1[0], p1[1], p1[2],
      p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], colour,
    );

    /**
     * A horizontal strip running along the lane between two magnitudes.
     *
     * The road, paint and kerb meshes are all single-sided, so the winding has
     * to put the smaller SIGNED lateral first. On a right-hand pit lane the
     * larger magnitude is the smaller signed value, and getting this backwards
     * does not produce a wrong-looking lane — it produces no lane at all,
     * because every triangle faces the ground.
     */
    const strip = (
      b: StripBuilder, u0: number, u1: number,
      in0: number, in1: number, out0: number, out1: number,
      y: number, colour: THREE.Color,
    ): void => {
      if (Math.abs(out0 - in0) < 0.01 && Math.abs(out1 - in1) < 0.01) return;
      const i0 = idxAt(u0);
      const i1 = idxAt(u1);
      if (sgn > 0) {
        quadP(b, P(i0, in0, y), P(i1, in1, y), P(i1, out1, y), P(i0, out0, y), colour);
      } else {
        quadP(b, P(i0, out0, y), P(i1, out1, y), P(i1, in1, y), P(i0, in0, y), colour);
      }
    };

    /** A quad with four independent (u, magnitude) corners — for hatching. */
    const patch = (
      b: StripBuilder, corners: readonly [number, number][], y: number, colour: THREE.Color,
    ): void => {
      const p = corners.map(([u, m]) => P(idxAt(u), m, y)) as [number, number, number][];
      if (sgn > 0) quadP(b, p[0], p[1], p[2], p[3], colour);
      else quadP(b, p[3], p[2], p[1], p[0], colour);
    };

    /** A transverse bar across the lane, `len` metres of it. */
    const bar = (
      b: StripBuilder, uc: number, len: number, m0: number, m1: number,
      y: number, colour: THREE.Color,
    ): void => strip(b, uc - len * 0.5, uc + len * 0.5, m0, m0, m1, m1, y, colour);

    /** Subdivides a run of lane so it follows the spline round a curve. */
    const run = (
      u0: number, u1: number, seg: number,
      fn: (a: number, b: number, k: number) => void,
    ): void => {
      const n = Math.max(1, Math.ceil((u1 - u0) / seg));
      const d = (u1 - u0) / n;
      for (let k = 0; k < n; k++) fn(u0 + k * d, u0 + (k + 1) * d, k);
    };

    /** A vertical slab standing on the lane, tapering between two magnitudes. */
    const slab = (
      u0: number, u1: number, mA0: number, mA1: number, mB0: number, mB1: number,
      y0: number, y1: number, face: THREE.Color, lid: THREE.Color,
    ): void => {
      const i0 = idxAt(u0);
      const i1 = idxAt(u1);
      quadP(walls, P(i0, mA0, y0), P(i1, mA1, y0), P(i1, mA1, y1), P(i0, mA0, y1), face);
      quadP(walls, P(i0, mB0, y0), P(i1, mB1, y0), P(i1, mB1, y1), P(i0, mB0, y1), face);
      quadP(walls, P(i0, mA0, y1), P(i1, mA1, y1), P(i1, mB1, y1), P(i0, mB0, y1), lid);
    };

    // --- The road surface --------------------------------------------------
    // Asphalt, the same asphalt as the circuit, with the apron between the
    // track edge and the wall carried in the same pass so there is never a
    // sliver of untextured ground between the two.
    run(0, g.totalU, 4, (a, b2, k) => {
      const ea = edges(a);
      const eb = edges(b2);
      const hwa = Math.min(hwAt(a), ea.inner);
      const hwb = Math.min(hwAt(b2), eb.inner);
      strip(pit, a, b2, hwa, hwb, ea.inner, eb.inner, Y_ROAD, COLOUR.asphaltDark);
      strip(pit, a, b2, ea.inner, eb.inner, ea.outer, eb.outer, Y_ROAD,
        (k & 3) === 0 ? COLOUR.asphaltDark : COLOUR.asphalt);
    });

    // --- Painted kerbing ---------------------------------------------------
    // Blue and white down the foot of the pit wall, green and white round the
    // outside of the entry and exit roads. Both are what a real pit lane uses,
    // and both are doing a job: the blue marks the edge of the fast lane, and
    // the green marks the edge of a road that is no longer the circuit.
    run(g.entryOpenU, g.exitU, 2.4, (a, b2, k) => {
      strip(kerbs, a, b2, g.laneInner + 0.75, g.laneInner + 0.75, g.laneInner + 1.35,
        g.laneInner + 1.35, Y_LINE + 0.004,
        (k & 1) === 0 ? COLOUR.pitKerbBlue : COLOUR.kerbB);
    });
    const outerKerb = (u0: number, u1: number): void => run(u0, u1, 2.4, (a, b2, k) => {
      const ea = edges(a);
      const eb = edges(b2);
      if (ea.outer - hwAt(a) < 1.8 || eb.outer - hwAt(b2) < 1.8) return;
      strip(kerbs, a, b2, ea.outer - 0.85, eb.outer - 0.85, ea.outer, eb.outer,
        Y_LINE + 0.004, (k & 1) === 0 ? COLOUR.pitKerbGreen : COLOUR.kerbB);
    });
    outerKerb(0, g.entryOpenU);
    outerKerb(g.exitU, g.exitU + PIT_EXIT_MERGE_M);

    // --- The pit entry -----------------------------------------------------
    // The lane peels away from the circuit as a wedge, bounded by a bold solid
    // line, with the widening triangle behind it filled with chevron hatching.
    // Before this there was nothing at all at the entry: the lane simply
    // existed, 16 metres to one side, with no road connecting it to the track.
    run(0, g.entryOpenU, 5, (a, b2) => {
      const ea = edges(a);
      const eb = edges(b2);
      strip(lines, a, b2, ea.inner, eb.inner, ea.inner + 0.34, eb.inner + 0.34,
        Y_LINE, COLOUR.whiteLine);
    });
    const hatchZone = (u0: number, u1: number, every: number): void => {
      for (let u = u0; u < u1; u += every) {
        const e = edges(u);
        const hw = hwAt(u);
        const gap = e.inner - hw - 0.8;
        if (gap < 1.2) continue;
        const skew = Math.min(gap * 0.85, 7);
        patch(lines, [
          [u, hw + 0.4], [u + 2.1, hw + 0.4],
          [u + 2.1 + skew, e.inner - 0.4], [u + skew, e.inner - 0.4],
        ], Y_LINE, COLOUR.whiteLine);
      }
    };
    hatchZone(8, g.entryOpenU - 6, 5);

    // --- The pit exit ------------------------------------------------------
    // The exit road runs on beyond the pit-exit line, converges onto the track
    // edge, and only then narrows away. The solid white blend line follows its
    // inner edge the whole way: the line a rejoining car must not cross, and
    // the visual answer to "where does the pit lane become the circuit again".
    run(g.exitU, g.exitU + PIT_EXIT_MERGE_M * 0.94, 5, (a, b2) => {
      const ea = edges(a);
      const eb = edges(b2);
      strip(lines, a, b2, ea.inner, eb.inner, ea.inner + 0.34, eb.inner + 0.34,
        Y_LINE, COLOUR.whiteLine);
    });
    hatchZone(g.exitU + 6, g.exitU + PIT_EXIT_JOIN_M - 8, 5);

    // --- The speed-limit lines ---------------------------------------------
    // The two lines the limiter is measured between. Bold, full width, and
    // exactly at `entryS` and `exitS`, so the mark you cross is the mark the
    // simulation switches the limiter on and off at.
    for (const u of [PIT_ENTRY_LEAD_M, g.exitU]) {
      const e = edges(u);
      bar(lines, u, 0.55, Math.min(hwAt(u), e.inner) + 0.15, e.outer - 0.15,
        Y_LINE + 0.001, COLOUR.whiteLine);
    }

    // --- The fast lane / working lane divider ------------------------------
    run(g.workingStartU, g.workingEndU, 6, (a, b2) => {
      strip(lines, a, b2, g.divider, g.divider, g.divider + 0.16, g.divider + 0.16,
        Y_LINE, COLOUR.whiteLine);
    });

    // --- Pit boxes ---------------------------------------------------------
    // One marked box per car, in the working lane, laid out from the same
    // anchor the paddock builds its garages from — so the box, the garage
    // behind it and the car parked in it all coincide.
    const boxHalf = PIT_GARAGE_SPACING_M * 0.5 - 0.5;
    for (let slot = 0; slot < PIT_GARAGE_COUNT; slot++) {
      const uu = g.u(g.boxS(slot));
      if (uu < g.workingStartU || uu > g.workingEndU) continue;
      // The box straddles the step at the garage mouth, so each marking is laid
      // in two pieces: one on the working lane's asphalt and one on the apron
      // above it. Painting the whole thing at road level puts most of it
      // underneath the apron, where it cannot be seen at all.
      const apronEdge = g.garageFace - PIT_APRON_DEPTH_M;
      const apronY = PIT_APRON_HEIGHT_M + 0.015;
      const sideLine = (u: number): void => {
        bar(lines, u, 0.16, g.divider + 0.25, apronEdge - 0.05, Y_LINE, COLOUR.whiteLine);
        bar(lines, u, 0.16, apronEdge + 0.05, g.garageFace - 0.45, apronY, COLOUR.whiteLine);
      };
      sideLine(uu - boxHalf);
      sideLine(uu + boxHalf);
      // The stop position: the bar the front wheels are brought up to.
      bar(lines, uu + 1.2, 0.5, apronEdge + 0.3, g.garageFace - 1.0, apronY,
        COLOUR.pitBoxMark);
    }

    // --- The pit wall ------------------------------------------------------
    // The paddock builds the wall, the team stands and the garages along the
    // row of bays. Outside the row the lane still needs separating from the
    // circuit, so the wall is carried on to the pit entry at one end and to the
    // pit exit at the other, and the outer edge of the entry and exit roads
    // gets a wall of its own.
    const walledFrom = g.entryOpenU;
    const walledTo = g.exitU;
    const wallA = g.wallMag - g.wallThick * 0.5;
    const wallB = g.wallMag + g.wallThick * 0.5;
    run(walledFrom, walledTo, 6, (a, b2) => {
      const s = g.splitS + (a + b2) * 0.5;
      // Skip the stretch the paddock has already walled, so the two do not
      // fight over the same cubic metre.
      if (isPaddockGround(track, track.indexAt(s), sgn as -1 | 1)) return;
      slab(a, b2, wallA, wallA, wallB, wallB, 0, PIT_WALL_HEIGHT_M * 0.62,
        COLOUR.pitWallFace, COLOUR.pitWallFace);
      slab(a, b2, wallA, wallA, wallB, wallB, PIT_WALL_HEIGHT_M * 0.62, PIT_WALL_HEIGHT_M,
        COLOUR.pitWallBand, COLOUR.pitWallTop);
    });

    const outerWall = (u0: number, u1: number): void => run(u0, u1, 6, (a, b2) => {
      const ea = edges(a);
      const eb = edges(b2);
      // Only where the road is genuinely clear of the circuit: a wall that
      // followed the wedge all the way in would end up standing on the racing
      // surface.
      if (ea.outer - hwAt(a) < 4 || eb.outer - hwAt(b2) < 4) return;
      slab(a, b2, ea.outer, eb.outer, ea.outer + 0.4, eb.outer + 0.4, 0, 1.1,
        COLOUR.wall, COLOUR.wallStripe);
    });
    outerWall(0, g.workingStartU);
    outerWall(g.workingEndU, g.exitU + PIT_EXIT_MERGE_M);
  }

  // --- Start/finish line ---------------------------------------------------
  // Markers must span at least a couple of nodes. Asking for a 1.2m-long quad
  // when nodes are 3m apart resolves both ends to the SAME node index, so the
  // quad is degenerate and nothing renders — the start line and every DRS marker
  // were silently invisible.
  const NODE_M = track.length / track.count;
  const markerLen = NODE_M * 2;
  {
    const grid = new StripBuilder();
    const i0 = track.indexAt(0);
    const i1 = track.indexAt(markerLen);
    const hw = track.width[i0] * 0.5;
    grid.quad(
      px(i0, -hw), py(i0, -hw) + Y_LINE, pz(i0, -hw),
      px(i1, -hw), py(i1, -hw) + Y_LINE, pz(i1, -hw),
      px(i1, hw), py(i1, hw) + Y_LINE, pz(i1, hw),
      px(i0, hw), py(i0, hw) + Y_LINE, pz(i0, hw),
      COLOUR.startLine,
    );
    addMesh(root, grid, false, geometries, materials, detail, SURFACES.paint);
  }

  // --- DRS zone markers ----------------------------------------------------
  {
    const marks = new StripBuilder();
    const teal = new THREE.Color(0x1fb6c9);
    for (const zone of track.def.drsZones) {
      for (const s of [zone.detectionS, zone.startS]) {
        const i0 = track.indexAt(s);
        const i1 = track.indexAt(s + markerLen);
        const hw = track.width[i0] * 0.5;
        marks.quad(
          px(i0, -hw), py(i0, -hw) + Y_LINE, pz(i0, -hw),
          px(i1, -hw), py(i1, -hw) + Y_LINE, pz(i1, -hw),
          px(i1, hw), py(i1, hw) + Y_LINE, pz(i1, hw),
          px(i0, hw), py(i0, hw) + Y_LINE, pz(i0, hw),
          teal,
        );
      }
    }
    addMesh(root, marks, false, geometries, materials, detail, SURFACES.paint);
  }

  addMesh(root, road, false, geometries, materials, detail, SURFACES.asphalt);
  addMesh(root, lines, false, geometries, materials, detail, SURFACES.paint);
  addMesh(root, kerbs, false, geometries, materials, detail, SURFACES.kerb);
  addMesh(root, runoff, false, geometries, materials, detail, SURFACES.runoff);
  addMesh(root, pit, false, geometries, materials, detail, SURFACES.asphalt);
  addMesh(root, walls, true, geometries, materials, detail, SURFACES.wall);

  // --- Catch fencing -------------------------------------------------------
  //
  // The debris fence above the armco. Drawn as a transparent alpha-tested mesh
  // with a generated wire-mesh texture, so you see the crowd and the run-off
  // *through* it — which is the whole point of a fence and the reason a circuit
  // feels open rather than walled in.
  //
  // Alpha test rather than alpha blend: a blended fence needs sorting against
  // everything behind it and flickers as the camera moves, whereas a cutout
  // writes depth normally and costs nothing.
  if (track.def.scenery !== 'street') {
    const FENCE_BOTTOM = 1.5;
    const FENCE_TOP = 5.4;
    const barrierOffset = 14;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const fenceStep = Math.max(step, 2);

    for (let a2 = 0; a2 < count; a2 += fenceStep) {
      const b2 = (a2 + fenceStep) % count;
      const hwA2 = track.width[a2] * 0.5;
      const hwB2 = track.width[b2] * 0.5;
      // UV runs with distance so the mesh keeps a constant real-world size
      // instead of stretching around corners.
      const uA = track.dist[a2] / 4;
      const uB = uA + (fenceStep * (track.length / count)) / 4;

      for (const side of [-1, 1] as const) {
        if (isPaddockGround(track, a2, side) || pitSideAt(a2, side)) continue;
        const oA = side * (hwA2 + barrierOffset);
        const oB = side * (hwB2 + barrierOffset);
        const yA = py(a2, oA) + Y_RUNOFF;
        const yB = py(b2, oB) + Y_RUNOFF;
        const x0 = px(a2, oA), z0 = pz(a2, oA);
        const x1 = px(b2, oB), z1 = pz(b2, oB);
        const nx = -track.nx[a2] * side;
        const nz = -track.nz[a2] * side;

        const quad = side > 0
          ? [[x0, yA + FENCE_BOTTOM, z0, uA, 1], [x1, yB + FENCE_BOTTOM, z1, uB, 1], [x1, yB + FENCE_TOP, z1, uB, 0],
             [x0, yA + FENCE_BOTTOM, z0, uA, 1], [x1, yB + FENCE_TOP, z1, uB, 0], [x0, yA + FENCE_TOP, z0, uA, 0]]
          : [[x0, yA + FENCE_TOP, z0, uA, 0], [x1, yB + FENCE_TOP, z1, uB, 0], [x1, yB + FENCE_BOTTOM, z1, uB, 1],
             [x0, yA + FENCE_TOP, z0, uA, 0], [x1, yB + FENCE_BOTTOM, z1, uB, 1], [x0, yA + FENCE_BOTTOM, z0, uA, 1]];

        for (const v of quad) {
          positions.push(v[0], v[1], v[2]);
          normals.push(nx, 0, nz);
          uvs.push(v[3], v[4]);
        }
      }
    }

    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.computeBoundingSphere();

      const tex = makeFenceTexture();
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        alphaMap: tex,
        transparent: false,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.75,
        metalness: 0.25,
        color: 0x2f4a38,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      // Fencing does not need to catch or cast shadows; it would only produce
      // a shimmering moire on the run-off for no readable gain.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      root.add(mesh);
      geometries.push(geo);
      materials.push(mat);
      textures.push(tex);
    }
  }

  // --- Trackside hoardings -------------------------------------------------
  // A continuous ribbon along the barrier line, UV-mapped by distance so the
  // repeating texture shows a different board every ~11m. One draw call for the
  // whole circuit's signage.
  {
    const isStreetHoard = track.def.scenery === 'street';
    const barrierOffset = isStreetHoard ? 2.5 : 14;
    const BOARD_H = 1.05;
    const BOARD_EVERY_M = 11;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    const hoardStep = Math.max(step, 2);
    for (let a2 = 0; a2 < count; a2 += hoardStep) {
      const b2 = (a2 + hoardStep) % count;
      const hwA2 = track.width[a2] * 0.5;
      const hwB2 = track.width[b2] * 0.5;
      const uA = track.dist[a2] / BOARD_EVERY_M;
      const uB = (track.dist[a2] + hoardStep * (track.length / count)) / BOARD_EVERY_M;

      for (const side of [-1, 1] as const) {
        if (isPaddockGround(track, a2, side) || pitSideAt(a2, side)) continue;
        const oA = side * (hwA2 + barrierOffset - 0.05);
        const oB = side * (hwB2 + barrierOffset - 0.05);
        const yA = py(a2, oA) + Y_RUNOFF;
        const yB = py(b2, oB) + Y_RUNOFF;

        const x0 = px(a2, oA), z0 = pz(a2, oA);
        const x1 = px(b2, oB), z1 = pz(b2, oB);
        // Face inward, toward the racing surface.
        const nx = -track.nx[a2] * side;
        const nz = -track.nz[a2] * side;

        // NOTE: the sponsor text currently renders mirrored on the hoardings.
        // It is not these UVs — negating U here provably reaches the browser
        // and changes nothing on screen, so the flip is happening somewhere
        // else in this ribbon's construction. Left as-is rather than patched
        // blind; see the README's known issues.
        //
        // Two triangles, wound so the inward face is front-facing on each side.
        const v = side > 0
          ? [[x0, yA, z0, uA, 1], [x1, yB, z1, uB, 1], [x1, yB + BOARD_H, z1, uB, 0],
             [x0, yA, z0, uA, 1], [x1, yB + BOARD_H, z1, uB, 0], [x0, yA + BOARD_H, z0, uA, 0]]
          : [[x0, yA + BOARD_H, z0, uA, 0], [x1, yB + BOARD_H, z1, uB, 0], [x1, yB, z1, uB, 1],
             [x0, yA + BOARD_H, z0, uA, 0], [x1, yB, z1, uB, 1], [x0, yA, z0, uA, 1]];

        for (const p of v) {
          positions.push(p[0], p[1], p[2]);
          normals.push(nx, 0, nz);
          uvs.push(p[3], p[4]);
        }
      }
    }

    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      const tex = makeHoardingTexture();
      const mat = new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      root.add(mesh);
      geometries.push(geo);
      materials.push(mat);
      textures.push(tex);
    }
  }

  // --- Start/finish gantry -------------------------------------------------
  // A physical structure over the line. It is the single clearest signal of where
  // a lap begins and ends, and a circuit without one looks like a closed road.
  {
    const i0 = track.indexAt(0);
    const hw = track.width[i0] * 0.5;
    const y = track.elevation[i0];
    const heading = Math.atan2(track.tx[i0], track.tz[i0]);

    const group = new THREE.Group();
    const postGeo = new THREE.BoxGeometry(0.55, 7.2, 0.55);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.6, metalness: 0.35 });
    for (const side of [-1, 1] as const) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(side * (hw + 1.6), 3.6, 0);
      group.add(post);
    }

    const beamGeo = new THREE.BoxGeometry((hw + 1.6) * 2, 1.5, 0.5);
    const gantryTex = makeGantryTexture(track.def.name);
    const beamMat = new THREE.MeshStandardMaterial({
      map: gantryTex, roughness: 0.5, metalness: 0.2,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(0, 6.9, 0);
    group.add(beam);

    group.position.set(track.px[i0], y, track.pz[i0]);
    group.rotation.y = heading;
    root.add(group);
    geometries.push(postGeo, beamGeo);
    materials.push(postMat, beamMat);
    textures.push(gantryTex);
  }

  // --- Braking distance markers -------------------------------------------
  // The 150/100/50 boards on the approach to every named corner. They are what a
  // driver actually uses to find a braking point, so they are functional, not
  // decoration.
  if (track.def.corners && track.def.corners.length > 0) {
    const markerTex = makeMarkerTexture();
    const markerMat = new THREE.MeshStandardMaterial({
      map: markerTex, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
    });
    const distances = [150, 100, 50];
    const boards: THREE.BufferGeometry[] = [];

    for (const corner of track.def.corners) {
      // Only for corners slow enough to need a marker board.
      const ci = track.indexAt(corner.s);
      if (track.targetSpeed[ci] > 52) continue;

      for (let d = 0; d < distances.length; d++) {
        const s = corner.s - distances[d];
        const i = track.indexAt(s);
        const hw = track.width[i] * 0.5;
        const isStreetM = track.def.scenery === 'street';
        const lat = -(hw + (isStreetM ? 1.4 : 4.2));

        const g = new THREE.PlaneGeometry(1.0, 1.0);
        // Each board uses the matching third of the stacked texture.
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) {
          uv.setY(k, (uv.getY(k) + (2 - d)) / 3);
        }
        uv.needsUpdate = true;

        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0), Math.atan2(track.tx[i], track.tz[i]),
        );
        m.compose(
          new THREE.Vector3(
            track.px[i] + track.nx[i] * lat,
            track.elevation[i] + 0.85,
            track.pz[i] + track.nz[i] * lat,
          ),
          q,
          new THREE.Vector3(1, 1, 1),
        );
        g.applyMatrix4(m);
        boards.push(g);
      }
    }

    if (boards.length > 0) {
      const merged = mergeGeometries(boards, false);
      for (const g of boards) g.dispose();
      if (merged) {
        const mesh = new THREE.Mesh(merged, markerMat);
        mesh.frustumCulled = false;
        root.add(mesh);
        geometries.push(merged);
      }
    }
    materials.push(markerMat);
    textures.push(markerTex);
  }

  // --- Ground plane --------------------------------------------------------
  {
    const b = track.bounds();
    // Generous padding: looking down a 1km straight, a plane that stops 400m past
    // the circuit shows its own edge as a hard horizon line. This has to extend
    // beyond the fog's far distance, not beyond the track.
    const pad = 6000;
    const w = b.maxX - b.minX + pad * 2;
    const d = b.maxZ - b.minZ + pad * 2;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: groundColour(track.def.scenery), roughness: 0.95, metalness: 0,
    });
    // The ground is the single largest surface in the scene, so it is also the
    // one where a flat colour is most obvious.
    detail.apply(mat, track.def.scenery === 'desert' ? SURFACES.runoff : SURFACES.grass);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((b.minX + b.maxX) * 0.5, Y_GROUND - 0.6, (b.minZ + b.maxZ) * 0.5);
    mesh.receiveShadow = false;
    root.add(mesh);
    geometries.push(geo);
    materials.push(mat);
  }

  // --- Set dressing --------------------------------------------------------
  // Cheap instanced blocks along the outside of the circuit. They exist to give
  // the eye something to measure speed against, which matters far more for the
  // sensation of speed than any amount of surface detail.
  {
    const dressing = buildSceneryInstances(track, quality);
    if (dressing) {
      for (const m of dressing.meshes) root.add(m);
      geometries.push(...dressing.geometries);
      materials.push(...dressing.materials);
    }
  }

  return {
    root,
    dispose(): void {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      detail.dispose();
      root.clear();
    },
  };
}

function addMesh(
  root: THREE.Group,
  builder: StripBuilder,
  doubleSided: boolean,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  detail: SurfaceDetail,
  profile: SurfaceProfile,
): void {
  const geo = builder.build();
  if (!geo) return;
  // Standard rather than Lambert: the road picks up the environment probe, which
  // is what stops asphalt reading as flat paint next to a reflective car.
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  // Projected grain, roughness break-up and a bump. Without this every surface
  // is a single flat colour over hundreds of square metres, which no amount of
  // lighting or post-processing disguises.
  detail.apply(mat, profile);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // one object spanning the whole circuit
  root.add(mesh);
  geometries.push(geo);
  materials.push(mat);
}

/**
 * Set dressing: trees and grandstands as instanced meshes.
 *
 * The first version used boxes, which read exactly as boxes — pale green slabs
 * standing in a field. Scenery is what the eye measures speed against, so it has
 * to at least resolve as *objects* rather than as geometry.
 *
 * Two instanced meshes (one tree, one grandstand) means two draw calls for several
 * hundred objects. A tree is a trunk plus two offset cones, which is enough to read
 * as a tree in peripheral vision at 300 km/h, and that is the only place it is ever
 * seen.
 */
function buildSceneryInstances(
  track: TrackSpline,
  quality: 'low' | 'high',
): { meshes: THREE.InstancedMesh[]; geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } | null {
  const spacing = quality === 'low' ? 90 : 55;
  const slots = Math.floor(track.length / spacing) * 2;
  if (slots <= 0) return null;

  const scenery = track.def.scenery;
  const isStreet = scenery === 'street';
  const barrier = isStreet ? 2.5 : 14;
  const pitGeom = pitLaneGeometry(track.def, track.length);

  // --- Tree: trunk plus two staggered cones -------------------------------
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 2.6, 6);
  trunk.translate(0, 1.3, 0);
  const canopyLow = new THREE.ConeGeometry(1.9, 4.2, 8);
  canopyLow.translate(0, 3.6, 0);
  const canopyHigh = new THREE.ConeGeometry(1.35, 3.4, 8);
  canopyHigh.translate(0, 5.6, 0);
  const treeGeo = mergeGeometries([trunk, canopyLow, canopyHigh], false)
    ?? new THREE.ConeGeometry(2, 6, 8);
  trunk.dispose();
  canopyLow.dispose();
  canopyHigh.dispose();
  treeGeo.computeVertexNormals();

  // --- Grandstand: a raked seating deck, a cantilever roof, and a crowd ----
  // Vertex-coloured, so one instanced mesh covers every stand on the circuit
  // and each still has seats, steelwork and several hundred people in it.
  const standGeo = buildGrandstandGeometry(grandstandPreset('trackside', quality, 11));

  // --- Building, for street circuits --------------------------------------
  const buildingGeo = new THREE.BoxGeometry(1, 1, 1);

  const treeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const standMat = new THREE.MeshStandardMaterial({
    roughness: 0.75, metalness: 0.05, vertexColors: true,
  });
  const buildingMat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });

  const trees = new THREE.InstancedMesh(treeGeo, treeMat, slots);
  const stands = new THREE.InstancedMesh(standGeo, standMat, Math.max(1, Math.floor(slots * 0.16)));
  const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, isStreet ? slots : 1);
  for (const m of [trees, stands, buildings]) m.frustumCulled = false;

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  let treeN = 0;
  let standN = 0;
  let buildingN = 0;

  for (let k = 0; treeN + standN + buildingN < slots * 1.5; k++) {
    const s = (k * spacing) % track.length;
    if (k * spacing > track.length) break;
    const i = track.indexAt(s);
    const hw = track.width[i] * 0.5;
    const groundY = track.elevation[i];
    const heading = Math.atan2(track.tx[i], track.tz[i]);

    for (const side of [-1, 1] as const) {
      // Nothing gets planted in the paddock, or in the pit lane.
      if (isPaddockGround(track, i, side)) continue;
      if (side === pitGeom.sign && pitGeom.covers(track.dist[i])) continue;
      // Deterministic pseudo-random from the index: identical every load, and no
      // RNG state to thread through.
      const h = Math.abs((Math.sin(k * 12.9898 + side * 78.233) * 43758.5453) % 1);
      const h2 = Math.abs((Math.sin(k * 39.3468 + side * 11.135) * 24634.6345) % 1);

      const lat = side * (hw + barrier + 5 + h * 24);
      const x = track.px[i] + track.nx[i] * lat;
      const z = track.pz[i] + track.nz[i] * lat;

      if (isStreet && buildingN < buildings.count) {
        const height = 11 + h * 30;
        const w = 9 + h2 * 12;
        pos.set(x, groundY + height * 0.5, z);
        scale.set(w, height, w * 0.85);
        quat.setFromAxisAngle(up, heading);
        matrix.compose(pos, quat, scale);
        buildings.setMatrixAt(buildingN, matrix);
        colour.setHSL(0.58 + h2 * 0.05, 0.06, 0.24 + h * 0.2);
        buildings.setColorAt(buildingN, colour);
        buildingN++;
        continue;
      }

      // A grandstand on the straights, where a real circuit puts them, and
      // close to the track so it frames the road.
      const fast = track.targetSpeed[i] > 62;
      if (fast && h2 > 0.72 && standN < stands.count) {
        const standLat = side * (hw + barrier + 9);
        pos.set(
          track.px[i] + track.nx[i] * standLat,
          groundY,
          track.pz[i] + track.nz[i] * standLat,
        );
        scale.set(1, 1, 1);
        // Face the track.
        quat.setFromAxisAngle(up, heading + (side > 0 ? 0 : Math.PI));
        matrix.compose(pos, quat, scale);
        stands.setMatrixAt(standN, matrix);
        // Near-white: the stand carries its own colours per vertex now, and an
        // instance tint multiplies them, so anything darker greys out the crowd.
        colour.setHSL(0.58, 0.05, 0.86 + h * 0.1);
        stands.setColorAt(standN, colour);
        standN++;
        continue;
      }

      if (treeN < trees.count) {
        const size = scenery === 'desert' ? 0.5 + h * 0.4 : 0.8 + h * 0.85;
        pos.set(x, groundY, z);
        scale.set(size, size * (0.85 + h2 * 0.5), size);
        quat.setFromAxisAngle(up, h * 6.283);
        matrix.compose(pos, quat, scale);
        trees.setMatrixAt(treeN, matrix);
        if (scenery === 'desert') colour.setHSL(0.11, 0.3, 0.32 + h2 * 0.1);
        else if (scenery === 'forest') colour.setHSL(0.31, 0.42, 0.13 + h2 * 0.09);
        else colour.setHSL(0.28, 0.38, 0.15 + h2 * 0.12);
        trees.setColorAt(treeN, colour);
        treeN++;
      }
    }
  }

  trees.count = Math.max(1, treeN);
  stands.count = Math.max(1, standN);
  buildings.count = Math.max(1, buildingN);
  for (const m of [trees, stands, buildings]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  const meshes: THREE.InstancedMesh[] = [trees, stands];
  if (isStreet) meshes.push(buildings);

  return {
    meshes,
    geometries: [treeGeo, standGeo, buildingGeo],
    materials: [treeMat, standMat, buildingMat],
  };
}


/**
 * A wire-mesh texture for the catch fencing: a grid of thin wires with posts.
 *
 * White on black, used as both the colour map and the alpha map, with the
 * material's own colour tinting it green. Generating it means the wire gauge
 * can be tuned to stay visible at speed — too fine and the fence disappears
 * into aliasing shimmer, too coarse and it reads as a net.
 */
function makeFenceTexture(): THREE.Texture {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);

  // The diamond weave of real chain-link.
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = -S; i < S * 2; i += 16) {
    g.moveTo(i, 0);
    g.lineTo(i + S, S);
    g.moveTo(i + S, 0);
    g.lineTo(i, S);
  }
  g.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Mipmapping a thin wire grid averages it into grey mush at distance, which
  // turns the fence into a translucent haze. Anisotropy keeps it legible at the
  // glancing angles a fence is almost always seen at.
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
