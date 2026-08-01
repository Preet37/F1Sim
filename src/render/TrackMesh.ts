import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chamferBox } from './ChamferKit';
import {
  makeGantryTexture, makeHoardingTexture, makeMarkerTexture,
  BOARD_WIDTH_M, HOARDING_BOARDS,
} from './Signage';
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
import type { SceneryItem, WorldModel } from '../track/WorldObstacles';
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

/**
 * Height of painted markings above the local road surface, in metres.
 *
 * Exported so a probe can find the paint in the built geometry without having
 * to guess at it — the edge line has to be tested for where it actually IS,
 * not for where the code that draws it says it should be.
 */
export const PAINT_HEIGHT_M = Y_LINE;

/**
 * Width of the white line at the edge of the racing surface, in metres.
 *
 * The line is painted INBOARD of `track.width * 0.5`, so its OUTER edge lies
 * exactly on the half-width the simulation and race control use. That is the
 * regulation boundary — the line itself is part of the track — and it is why
 * `RaceControlManager.checkTrackLimits` can compare against `halfWidthAt`
 * directly with no offset of its own.
 */
export const EDGE_LINE_WIDTH_M = 0.14;

/**
 * Clearance small trackside furniture keeps from every part of the circuit.
 *
 * Deliberately tight. A gantry post and a braking board are meant to be beside
 * the road — pushing them behind the run-off would make the boards unreadable
 * and put the start/finish gantry in a field. This is enough that a car pinned
 * against the barrier cannot reach them, and no more.
 */
const FURNITURE_CLEARANCE_M = 1.2;

const COLOUR = {
  // Asphalt's real albedo is around 0.10, which is sRGB 0x58 — not the near
  // black it is usually guessed at. The previous 0x1d survived daylight only
  // because a 2.6-intensity sun was compensating for it; under floodlights it
  // collapsed to a void with a car floating over it, while the reference
  // footage has night asphalt sitting at a comfortable mid grey. Dry road that
  // has been rubbered in is darker than fresh, hence still under 0x40.
  asphalt: new THREE.Color(0x44464b),
  asphaltDark: new THREE.Color(0x3b3d42),
  /** Scratch for the along-track shade drift; never read directly. */
  asphaltMix: new THREE.Color(),
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
  /** Box outline on the pale garage apron, where white would vanish. */
  pitBoxEdge: new THREE.Color(0x24272c),
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

  /**
   * Adds a ground quad, with each of its two triangles wound to face UP.
   *
   * Backface culling reads the WINDING, not the normal: three.js draws these
   * meshes with `side: FrontSide`, and a front face is one whose vertices run
   * counter-clockwise as seen from the camera. `tri` below flips the stored
   * normal so the lighting is right either way, which is exactly what makes a
   * wrongly wound quad so hard to spot — it is not mis-lit, it is absent.
   *
   * Two things produce a wrongly wound ground quad here.
   *
   * The first is writing the corners out in a fixed order on both sides of the
   * car. Inner-then-outer runs the signed lateral coordinate upward on the left
   * and downward on the right, so the same code that draws the left-hand white
   * line deletes the right-hand one.
   *
   * The second cannot be fixed by ordering at all: where a corner's radius is
   * smaller than the track's half width — COTA's turn 11 is, at fifteen metres
   * of road round a hairpin — the inner edge of the road sweeps BACKWARDS, and
   * the quad folds into a bowtie whose two triangles genuinely face opposite
   * ways. Deciding per triangle is the only thing that covers both, and the
   * cost is one cross product on a mesh built once at load.
   */
  quadFlat(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    colour: THREE.Color,
  ): void {
    this.triUp(ax, ay, az, bx, by, bz, cx, cy, cz, colour);
    this.triUp(ax, ay, az, cx, cy, cz, dx, dy, dz, colour);
  }

  private triUp(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    colour: THREE.Color,
  ): void {
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (up >= 0) this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, colour);
    else this.tri(ax, ay, az, cx, cy, cz, bx, by, bz, colour);
  }

  /**
   * Adds a quad with an explicit normal at each corner.
   *
   * The face-normal path below is right for flat road surfaces and wrong for
   * anything with curvature in its cross-section: a kerb whose crown and outer
   * roll are genuinely curved gets a hard shading step at every facet if each
   * triangle carries its own normal, which is exactly what made the old
   * three-quad kerb read as a folded strip of card. Supplying the analytic
   * normal of the swept profile instead is the same trick as a smoothing group,
   * and the profile marks its own creases so the inner lip stays sharp.
   */
  quadSmooth(
    ax: number, ay: number, az: number, an: readonly number[],
    bx: number, by: number, bz: number, bn: readonly number[],
    cx: number, cy: number, cz: number, cn: readonly number[],
    dx: number, dy: number, dz: number, dn: readonly number[],
    colour: THREE.Color,
  ): void {
    const push = (
      x: number, y: number, z: number, n: readonly number[],
    ) => {
      this.positions.push(x, y, z);
      this.normals.push(n[0], n[1], n[2]);
      this.colours.push(colour.r, colour.g, colour.b);
    };
    push(ax, ay, az, an); push(bx, by, bz, bn); push(cx, cy, cz, cn);
    push(ax, ay, az, an); push(cx, cy, cz, cn); push(dx, dy, dz, dn);
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

export function buildTrackMeshes(
  track: TrackSpline,
  quality: 'low' | 'high',
  world: WorldModel,
): TrackMeshes {
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
  const LINE_W = EDGE_LINE_WIDTH_M;
  const RUNOFF_W = 9;
  const WALL_H = 1.5;

  // The pit lane's full plan and cross-section, derived once and shared by
  // everything below — the lane surface, its paint, its walls, and the decision
  // about which pieces of ordinary trackside furniture have to give way to it.
  const pitGeom = pitLaneGeometry(track.def, track.length);

  /**
   * How far off the track edge the barrier, the fencing and the hoardings
   * stand at this node — or 0 where the pit lane and the paddock take over.
   *
   * Read from the world model rather than derived here. The simulation collides
   * against this same line, and a barrier that is drawn in a different place
   * from the one a car bounces off is precisely the bug that let cars end up on
   * the far side of the fence.
   */
  const barrierAt = (node: number, side: -1 | 1): number =>
    (side > 0 ? world.barrierOffsets.left : world.barrierOffsets.right)[node];

  /**
   * Pushes a piece of trackside furniture out until it is off the circuit.
   *
   * The gantry and the braking boards were placed at a fixed offset from the
   * local node — the same mistake the set dressing was fixed for, left in two
   * places because they are small. Small does not help: a 7.2m gantry post
   * 1.6m off the edge of a street circuit, or a marker board 1.4m off it, sits
   * inside the run-off, and wherever the lap folds back that run-off is another
   * piece of road.
   *
   * @param i     node the object is anchored at
   * @param side  which side of the road, +1 left
   * @param from  starting distance beyond the track edge
   * @param halfX half extent across the road
   * @param halfZ half extent along it
   * @returns the signed lateral offset to use
   */
  const clearLateral = (
    i: number, side: -1 | 1, from: number, halfX: number, halfZ: number,
  ): number => {
    const hw = track.width[i] * 0.5;
    for (let attempt = 0; attempt < 8; attempt++) {
      const lat = side * (hw + from + attempt * 2);
      const x = track.px[i] + track.nx[i] * lat;
      const z = track.pz[i] + track.nz[i] * lat;
      if (world.keepOut.clearOfBox(
        x, z, track.tz[i], track.tx[i], halfX, halfZ, FURNITURE_CLEARANCE_M,
      )) return lat;
    }
    return side * (hw + from);
  };

  /** World position at (node, lateral, height). */
  const px = (i: number, lat: number) => track.px[i] + track.nx[i] * lat;
  const pz = (i: number, lat: number) => track.pz[i] + track.nz[i] * lat;
  const py = (i: number, lat: number) => {
    // Banking tilts the surface about the track's centreline.
    const bank = track.banking[i];
    return track.elevation[i] + (bank !== 0 ? -lat * Math.tan(bank) : 0);
  };

  // =========================================================================
  // Kerbs
  // =========================================================================
  //
  // A kerb was three flat quads: a ramp, a flat top, a fall. That is a folded
  // strip of card, and it read as one — the two folds are the only lines on it,
  // both dead straight, and the "crown" is a painted stripe lying at a constant
  // 55mm. A real kerb is an extruded concrete section: a chamfer where it meets
  // the asphalt so a car can ride it, a domed crown, and a rolled outer edge
  // falling away to the run-off. That section is the entire reason a kerb reads
  // as a solid object — the highlight travelling along the roll is what gives
  // it thickness, and it is the same highlight on every kerb at every circuit.
  //
  // Offsets are metres outboard of the white line; heights are metres above the
  // run-off plane. `hard` splits the normal so a crease stays a crease.
  const KERB_PROFILE: readonly { off: number; y: number; hard?: boolean }[] = [
    { off: 0.000, y: Y_ROAD, hard: true },
    { off: 0.055, y: Y_ROAD + 0.008 },
    { off: 0.155, y: Y_KERB * 0.50 },
    { off: 0.275, y: Y_KERB * 0.89 },
    { off: 0.410, y: Y_KERB * 1.00 },
    { off: 0.620, y: Y_KERB * 1.07 },
    { off: 0.830, y: Y_KERB * 0.99 },
    { off: 0.945, y: Y_KERB * 0.77 },
    { off: 1.045, y: Y_KERB * 0.37 },
    { off: 1.115, y: Y_RUNOFF + 0.007 },
    // A whisker above the run-off plane rather than exactly on it, so the two
    // surfaces meet without sharing a coplanar edge to fight over.
    { off: 1.185, y: Y_RUNOFF + 0.0015, hard: true },
  ];

  /**
   * Per-segment cross-section normals, in (outboard, up).
   *
   * Averaged across a joint unless one of its ends is marked hard, which is
   * what makes the crown and the outer roll shade as curves and leaves the lip
   * against the asphalt as an edge.
   */
  const KERB_SEG = (() => {
    const n = KERB_PROFILE.length - 1;
    const face: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const doff = KERB_PROFILE[i + 1].off - KERB_PROFILE[i].off;
      const dy = KERB_PROFILE[i + 1].y - KERB_PROFILE[i].y;
      const len = Math.hypot(doff, dy) || 1;
      face.push([-dy / len, doff / len]);
    }
    const blend = (u: [number, number], v: [number, number]): [number, number] => {
      const x = u[0] + v[0], y = u[1] + v[1];
      const len = Math.hypot(x, y) || 1;
      return [x / len, y / len];
    };
    return face.map((f, i) => ({
      face: f,
      n0: i > 0 && !KERB_PROFILE[i].hard ? blend(f, face[i - 1]) : f,
      n1: i < n - 1 && !KERB_PROFILE[i + 1].hard ? blend(f, face[i + 1]) : f,
    }));
  })();

  /**
   * Longitudinal stations per node step.
   *
   * The old kerb inherited the road's 6m quads, so its red and white bands were
   * six metres long — three times a real one, which is why they read as painted
   * blocks rather than as kerbing. Subdivided to about a metre, which is both
   * the right band length and enough resolution for the section to follow a
   * corner instead of chording across it.
   */
  const KERB_SUB = quality === 'low' ? 2 : Math.max(2, Math.round((step * (track.length / count)) / 1.0));

  /**
   * Interpolated track frame between two nodes.
   *
   * Walks the NODE polyline from `a` to `b` rather than the straight chord
   * between them, which matters because `b` is `step` nodes further on and the
   * nodes in between are the circuit. `TrackSpline.project` measures a car's
   * lateral position against that same polyline, so a surface built on it is
   * built on exactly the boundary race control judges against; a surface built
   * on the chord is not. At six metres a chord across a hairpin cuts nearly a
   * quarter of a metre inside the real edge, and the white line drawn on it
   * showed the driver a limit a quarter of a metre tighter than the one being
   * enforced.
   *
   * Subdividing alone did not fix that — the old version lerped a to b directly,
   * so every substep landed on the same chord and the kerb's own claim to
   * "follow a corner instead of chording across it" was not true either.
   */
  const frameLerp = (a: number, b: number, f: number) => {
    const span = ((b - a) % count + count) % count || count;
    const u = f * span;
    const k = Math.min(span - 1, Math.floor(u));
    const t = u - k;
    const i = (a + k) % count;
    const j = (i + 1) % count;
    const g = 1 - t;
    let nx = track.nx[i] * g + track.nx[j] * t;
    let nz = track.nz[i] * g + track.nz[j] * t;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    return {
      x: track.px[i] * g + track.px[j] * t,
      z: track.pz[i] * g + track.pz[j] * t,
      nx, nz,
      elev: track.elevation[i] * g + track.elevation[j] * t,
      bank: track.banking[i] * g + track.banking[j] * t,
      hw: (track.width[i] * g + track.width[j] * t) * 0.5,
    };
  };

  /** World position at a frame station and a signed lateral offset. */
  const framePt = (
    s: ReturnType<typeof frameLerp>, lat: number, dy: number,
  ): readonly [number, number, number] => [
    s.x + s.nx * lat,
    s.elev + (s.bank !== 0 ? -lat * Math.tan(s.bank) : 0) + dy,
    s.z + s.nz * lat,
  ];

  /** Sweeps the kerb section from node `a` to node `b` on one side. */
  const sweepKerb = (a: number, b: number, sign: 1 | -1): void => {
    const colourA = ((a / step) & 1) === 0 ? 0 : 1;
    for (let k = 0; k < KERB_SUB; k++) {
      const f0 = k / KERB_SUB;
      const f1 = (k + 1) / KERB_SUB;
      const s0 = frameLerp(a, b, f0);
      const s1 = frameLerp(a, b, f1);
      // Bands alternate along the kerb, continuing the parity of the node step
      // so two adjacent steps never put two reds side by side.
      const band = (colourA * KERB_SUB + k) & 1;
      const colour = band === 0 ? COLOUR.kerbA : COLOUR.kerbB;

      // World position and outboard/up basis at one station and one offset.
      const at = (s: ReturnType<typeof frameLerp>, off: number, y: number) => {
        const lat = sign * (s.hw + off);
        return [
          s.x + s.nx * lat,
          s.elev + (s.bank !== 0 ? -lat * Math.tan(s.bank) : 0) + y,
          s.z + s.nz * lat,
        ] as const;
      };
      // Outboard direction in world, for turning the 2D section normal into 3D.
      const outX = s0.nx * sign, outZ = s0.nz * sign;
      const nrm = (n: readonly [number, number]) =>
        [outX * n[0], n[1], outZ * n[0]] as const;

      for (let i = 0; i < KERB_SEG.length; i++) {
        const p0 = KERB_PROFILE[i];
        const p1 = KERB_PROFILE[i + 1];
        const n0 = nrm(KERB_SEG[i].n0);
        const n1 = nrm(KERB_SEG[i].n1);
        const a0 = at(s0, p0.off, p0.y);
        const b0 = at(s1, p0.off, p0.y);
        const b1 = at(s1, p1.off, p1.y);
        const a1 = at(s0, p1.off, p1.y);
        // Wound so the outward face is front-facing on either side of the car.
        if (sign > 0) {
          kerbs.quadSmooth(
            a0[0], a0[1], a0[2], n0, b0[0], b0[1], b0[2], n0,
            b1[0], b1[1], b1[2], n1, a1[0], a1[1], a1[2], n1, colour,
          );
        } else {
          kerbs.quadSmooth(
            a1[0], a1[1], a1[2], n1, b1[0], b1[1], b1[2], n1,
            b0[0], b0[1], b0[2], n0, a0[0], a0[1], a0[2], n0, colour,
          );
        }
      }
    }
  };

  for (let a = 0; a < count; a += step) {
    const b = (a + step) % count;

    const hwA = track.width[a] * 0.5;
    const hwB = track.width[b] * 0.5;

    // --- Asphalt ---------------------------------------------------------
    // A slow, irregular drift in shade along the circuit, so the surface reads
    // as asphalt of varying age rather than as a flat colour.
    //
    // This used to darken every fourth quad, which put a hard-edged transverse
    // band across the full width of the road at an exactly regular 24 metre
    // pitch. Regular is the problem: nothing in a real road surface repeats on
    // a fixed interval, so the eye reads the bands as a rendering artefact
    // rather than as resurfacing — a stripe marching up the track in every
    // chase and onboard shot. It was invisible only because the asphalt used to
    // be so dark that a 5-level difference had nowhere to show; lifting the
    // albedo to something realistic exposed it immediately.
    //
    // Two incommensurate sinusoids give an aperiodic wander instead, and the
    // per-quad step is small enough to be a gradient rather than an edge. The
    // hard-edged patch repairs a real circuit does have are already handled,
    // and handled better, by SurfaceDetail's noise-thresholded patch field,
    // which produces blobs with genuine boundaries in world space.
    const drift = 0.5 + 0.5 * Math.sin(a * 0.0143) * Math.sin(a * 0.0067 + 1.7);
    const shade = COLOUR.asphaltMix.copy(COLOUR.asphaltDark).lerp(COLOUR.asphalt, drift);

    // The asphalt and the white lines at its edge are swept together, one
    // sub-quad per NODE rather than one per step, so both land on the polyline
    // the simulation measures against. See `frameLerp`: a single six-metre quad
    // chords across the node in the middle of it, and at a hairpin that put the
    // painted limit a quarter of a metre inside the enforced one.
    //
    // The extra triangles are the cheapest in the scene — two per node for the
    // road and four for the paint, against eleven profile segments per node,
    // per side, for the kerb sitting immediately outboard of them. Measured in
    // the browser, the whole circuit mesh grows 2.0% at Spa, 2.4% at COTA and
    // 5.6% at Monaco, which is the shortest lap and therefore the one where the
    // road is the largest share of it. Draw calls are unchanged at 94.
    for (let k = 0; k < step; k++) {
      const s0 = frameLerp(a, b, k / step);
      const s1 = frameLerp(a, b, (k + 1) / step);

      const r00 = framePt(s0, -s0.hw, Y_ROAD), r01 = framePt(s1, -s1.hw, Y_ROAD);
      const r11 = framePt(s1, s1.hw, Y_ROAD), r10 = framePt(s0, s0.hw, Y_ROAD);
      road.quadFlat(
        r00[0], r00[1], r00[2], r01[0], r01[1], r01[2],
        r11[0], r11[1], r11[2], r10[0], r10[1], r10[2],
        shade,
      );

      // --- White lines at the track edge ----------------------------------
      //
      // Painted inboard of the half-width, so the OUTER edge of the paint is
      // exactly `halfWidthAt` — the regulation boundary, and the one
      // `RaceControlManager.checkTrackLimits` judges against.
      //
      // Emitted through `quadFlat`, which decides the winding rather than
      // trusting this loop to get it right on both sides. That is not caution:
      // writing the corners inner-then-outer, as the previous version did, is
      // correct on the left and backwards on the right, and the right-hand line
      // was consequently generated on all eleven circuits and drawn on none of
      // them. See `quadFlat`.
      for (const side of [-1, 1] as const) {
        const i0 = side * (s0.hw - LINE_W), i1 = side * (s1.hw - LINE_W);
        const o0 = side * s0.hw, o1 = side * s1.hw;
        const a0 = framePt(s0, i0, Y_LINE), a1 = framePt(s1, i1, Y_LINE);
        const b1 = framePt(s1, o1, Y_LINE), b0 = framePt(s0, o0, Y_LINE);
        lines.quadFlat(
          a0[0], a0[1], a0[2], a1[0], a1[1], a1[2],
          b1[0], b1[1], b1[2], b0[0], b0[1], b0[2],
          COLOUR.whiteLine,
        );
      }
    }

    // --- Kerbs -------------------------------------------------------------
    // Lateral is positive to the driver's LEFT.
    if (track.isCurbLeft[a] && track.isCurbLeft[b]) sweepKerb(a, b, 1);
    if (track.isCurbRight[a] && track.isCurbRight[b]) sweepKerb(a, b, -1);

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
    for (const side of [-1, 1] as const) {
      // Along the pits the pit wall and the garages are the boundary, and where
      // the circuit doubles back on itself the barrier is pulled in so it does
      // not stand on the other section's road.
      const offA = barrierAt(a, side);
      const offB = barrierAt(b, side);
      if (offA <= 0 || offB <= 0) continue;
      const oA = side * (hwA + offA);
      const oB = side * (hwB + offB);
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

    const nodeM = track.length / count;
    const hwAt = (u: number) => track.width[track.indexAt(g.splitS + u)] * 0.5;
    const edges = (u: number) => g.edgesAt(u, hwAt(u));

    /**
     * World position at a lane parameter and a lateral magnitude, interpolated
     * BETWEEN nodes.
     *
     * Resolving to the nearest node instead — which is what the rest of this
     * file does, because everything else is built node by node — collapses any
     * feature shorter than the ~3m node spacing to zero length. Every
     * transverse marking in a pit lane is shorter than that: the speed-limit
     * lines, the box outlines and the stop bars are all a few centimetres of
     * paint across the lane, and every one of them came out as a degenerate
     * quad that rendered as nothing at all.
     */
    const W = (u: number, m: number, dy: number): [number, number, number] => {
      const w = ((g.splitS + u) % track.length + track.length) % track.length;
      const f = w / nodeM;
      const i = Math.floor(f) % count;
      const j = (i + 1) % count;
      const t = f - Math.floor(f);
      const lat = sgn * m;
      const cx = track.px[i] + (track.px[j] - track.px[i]) * t;
      const cz = track.pz[i] + (track.pz[j] - track.pz[i]) * t;
      const nx = track.nx[i] + (track.nx[j] - track.nx[i]) * t;
      const nz = track.nz[i] + (track.nz[j] - track.nz[i]) * t;
      const ey = track.elevation[i] + (track.elevation[j] - track.elevation[i]) * t;
      const bank = track.banking[i];
      const y = ey + (bank !== 0 ? -lat * Math.tan(bank) : 0) + dy;
      return [cx + nx * lat, y, cz + nz * lat];
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
      if (sgn > 0) {
        quadP(b, W(u0, in0, y), W(u1, in1, y), W(u1, out1, y), W(u0, out0, y), colour);
      } else {
        quadP(b, W(u0, out0, y), W(u1, out1, y), W(u1, in1, y), W(u0, in0, y), colour);
      }
    };

    /** A quad with four independent (u, magnitude) corners — for hatching. */
    const patch = (
      b: StripBuilder, corners: readonly [number, number][], y: number, colour: THREE.Color,
    ): void => {
      const p = corners.map(([u, m]) => W(u, m, y));
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
      quadP(walls, W(u0, mA0, y0), W(u1, mA1, y0), W(u1, mA1, y1), W(u0, mA0, y1), face);
      quadP(walls, W(u0, mB0, y0), W(u1, mB1, y0), W(u1, mB1, y1), W(u0, mB0, y1), face);
      quadP(walls, W(u0, mA0, y1), W(u1, mA1, y1), W(u1, mB1, y1), W(u0, mB0, y1), lid);
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
      // Same aperiodic drift as the circuit; see the note there for why the
      // regular every-fourth-quad version had to go.
      const podDrift = 0.5 + 0.5 * Math.sin(k * 0.31) * Math.sin(k * 0.13 + 1.7);
      strip(pit, a, b2, ea.inner, eb.inner, ea.outer, eb.outer, Y_ROAD,
        COLOUR.asphaltMix.copy(COLOUR.asphaltDark).lerp(COLOUR.asphalt, podDrift));
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
        bar(lines, u, 0.18, g.divider + 0.25, apronEdge - 0.05, Y_LINE, COLOUR.whiteLine);
        // Dark on the apron rather than white. The apron is pale concrete
        // under a bright sky and blows out to near-white in the tone map, and
        // white paint on white concrete is not a marking.
        bar(lines, u, 0.22, apronEdge + 0.05, g.garageFace - 0.45, apronY, COLOUR.pitBoxEdge);
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
        const offA = barrierAt(a2, side);
        const offB = barrierAt(b2, side);
        if (offA <= 0 || offB <= 0) continue;
        const oA = side * (hwA2 + offA);
        const oB = side * (hwB2 + offB);
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
        alphaTest: FENCE_ALPHA_TEST,
        // The other half of the fence fix, and it is free.
        //
        // Alpha to coverage turns the one-bit cutout into a multisample
        // coverage mask, so a wire that covers a third of a pixel shades a
        // third of that pixel's samples instead of all or none of it. The high
        // tier already renders into a 4x MSAA target for the composer and the
        // low tier asks for an antialiased canvas, so the samples this needs
        // are already being paid for; without it, coverage-preserving mips
        // stop the fence strobing but leave every wire edge hard.
        alphaToCoverage: true,
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
    const BOARD_H = 1.05;
    // The distance over which the whole strip texture repeats: one board's real
    // width times the number of boards in it. Derived rather than guessed,
    // because the guess (11 metres for twelve boards) made every board narrower
    // than it was tall.
    const BOARD_EVERY_M = BOARD_WIDTH_M * HOARDING_BOARDS;

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
        const offA = barrierAt(a2, side);
        const offB = barrierAt(b2, side);
        if (offA <= 0 || offB <= 0) continue;
        const oA = side * (hwA2 + offA - 0.05);
        const oB = side * (hwB2 + offB - 0.05);
        const yA = py(a2, oA) + Y_RUNOFF;
        const yB = py(b2, oB) + Y_RUNOFF;

        const x0 = px(a2, oA), z0 = pz(a2, oA);
        const x1 = px(b2, oB), z1 = pz(b2, oB);
        // Face inward, toward the racing surface.
        const nx = -track.nx[a2] * side;
        const nz = -track.nz[a2] * side;

        // The two barriers face opposite ways, so a u that increases with
        // distance runs left-to-right across one of them and right-to-left
        // across the other — and the one it runs backwards across renders every
        // sponsor name mirrored. Negating u for that side is the fix.
        //
        // An earlier attempt at this concluded the UVs were not responsible,
        // because negating u appeared to change nothing. It does change
        // something: what it does not change is the OVERALL look of a long
        // strip of repeating coloured boards, which is identical whichever
        // direction you traverse it. The difference is only legible in the
        // letterforms, and at the resolution the strip used to be drawn at
        // there were no legible letterforms to check.
        const fA = side > 0 ? uA : -uA;
        const fB = side > 0 ? uB : -uB;

        // v runs 1 at the TOP of the board and 0 at the bottom, and getting that
        // the wrong way round is what was still left of the mirrored-signage bug
        // after the u fix above.
        //
        // three uploads a CanvasTexture with flipY on, so v=1 is the top row of
        // the canvas as it was drawn. The strip is drawn with the sponsor's name
        // across the upper half and the plinth band along the bottom. Mapping
        // v=1 to the board's bottom edge therefore hung every board upside down
        // — and upside-down text is mirrored text plus a vertical flip, which at
        // a glance is indistinguishable from the horizontal mirroring the u fix
        // had just dealt with. That is why negating u looked like it had not
        // worked, and why negating it the other way looked like it had: one of
        // the two mirrorings cancelled and the other did not.
        //
        // Two triangles, wound so the inward face is front-facing on each side.
        const v = side > 0
          ? [[x0, yA, z0, fA, 0], [x1, yB, z1, fB, 0], [x1, yB + BOARD_H, z1, fB, 1],
             [x0, yA, z0, fA, 0], [x1, yB + BOARD_H, z1, fB, 1], [x0, yA + BOARD_H, z0, fA, 1]]
          : [[x0, yA + BOARD_H, z0, fA, 1], [x1, yB + BOARD_H, z1, fB, 1], [x1, yB, z1, fB, 0],
             [x0, yA + BOARD_H, z0, fA, 1], [x1, yB, z1, fB, 0], [x0, yA, z0, fA, 0]];

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
      const tex = makeHoardingTexture(quality);
      // The hoardings measured 2.8 display levels of shimmer under a
      // third-of-a-pixel camera move, second only to the fence, and for a
      // duller reason: they are a 6144-pixel-wide strip of high-contrast
      // lettering seen almost edge-on down the length of a straight, and the
      // texture was going out at the default anisotropy of one. A trilinear
      // sample of a footprint stretched thirty to one reads a handful of texels
      // out of hundreds and picks a different handful every frame.
      tex.anisotropy = 16;
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
    const y = track.elevation[i0];
    const heading = Math.atan2(track.tx[i0], track.tz[i0]);

    const group = new THREE.Group();
    const postGeo = chamferBox(0.55, 7.2, 0.55, 0.05);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.6, metalness: 0.35 });
    // Each post pushed out independently until it is off the circuit, then the
    // beam spanned across whichever pair that produced. The beam itself is
    // seven metres up and cannot be hit; the posts are the part a car reaches.
    const postLat = {
      left: clearLateral(i0, 1, 1.6, 0.28, 0.28),
      right: clearLateral(i0, -1, 1.6, 0.28, 0.28),
    };
    for (const side of [-1, 1] as const) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(side > 0 ? postLat.left : postLat.right, 3.6, 0);
      group.add(post);
    }

    const beamGeo = new THREE.BoxGeometry(postLat.left - postLat.right, 1.5, 0.5);
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
        const isStreetM = track.def.scenery === 'street';
        // Outside of the corner, which is where a real board goes: the inside
        // is where the cars are. Positive curvature is a right turn, whose
        // outside is the track's left — positive lateral.
        const side: -1 | 1 = track.curvature[ci] > 0 ? 1 : -1;
        const lat = clearLateral(i, side, isStreetM ? 1.4 : 4.2, 0.15, 0.5);

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
    const dressing = buildSceneryInstances(track, quality, world.scenery);
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
 * Set dressing: trees, grandstands and city blocks as instanced meshes.
 *
 * The first version used boxes, which read exactly as boxes — pale green slabs
 * standing in a field. Scenery is what the eye measures speed against, so it has
 * to at least resolve as *objects* rather than as geometry.
 *
 * Three instanced meshes means three draw calls for several hundred objects. A
 * tree is a trunk plus two offset cones, which is enough to read as a tree in
 * peripheral vision at 300 km/h, and that is the only place it is ever seen.
 *
 * WHERE each object goes is not decided here. It is decided by
 * `buildSceneryLayout`, which tests every candidate footprint against the whole
 * circuit — because this function used to pick a lateral offset from the local
 * node and never look further, and a closed loop that folds back on itself will
 * happily put that offset on top of the road somewhere else. At Monaco that
 * meant a thirty-metre building standing across the racing surface with the
 * player's car inside it. The layout also has to be shared with the simulation,
 * which collides against these objects, and the only way for the drawing and
 * the colliding to agree is for both to read the same list.
 */
function buildSceneryInstances(
  track: TrackSpline,
  quality: 'low' | 'high',
  items: readonly SceneryItem[],
): { meshes: THREE.InstancedMesh[]; geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } | null {
  if (items.length === 0) return null;

  const scenery = track.def.scenery;
  const isStreet = scenery === 'street';

  // --- Tree: trunk plus two staggered cones -------------------------------
  // A six-sided trunk and eight-sided cones are hexagonal and octagonal from
  // any angle, and there are hundreds of them lining every circuit, so the
  // faceting repeats across the whole background. One geometry, instanced, so
  // the extra segments are paid for once.
  const treeSeg = quality === 'low' ? 6 : 12;
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 2.6, treeSeg);
  trunk.translate(0, 1.3, 0);
  const canopyLow = new THREE.ConeGeometry(1.9, 4.2, treeSeg + 2);
  canopyLow.translate(0, 3.6, 0);
  const canopyHigh = new THREE.ConeGeometry(1.35, 3.4, treeSeg + 2);
  canopyHigh.translate(0, 5.6, 0);
  const treeMerged = mergeGeometries([trunk, canopyLow, canopyHigh], false)
    ?? new THREE.ConeGeometry(2, 6, treeSeg + 2);
  trunk.dispose();
  canopyLow.dispose();
  canopyHigh.dispose();
  // Angle-based, not `computeVertexNormals`: the merge is non-indexed, so
  // recomputing could only give per-face normals and the trunk and both canopy
  // cones came out flat-shaded. Smoothing round each one and leaving the joins
  // between them hard is what a smoothing group would do.
  const treeGeo = toCreasedNormals(treeMerged, (50 * Math.PI) / 180);

  // --- Grandstand: a raked seating deck, a cantilever roof, and a crowd ----
  // Vertex-coloured, so one instanced mesh covers every stand on the circuit
  // and each still has seats, steelwork and several hundred people in it.
  const standGeo = buildGrandstandGeometry(grandstandPreset('trackside', quality, 11));

  // --- Building, for street circuits --------------------------------------
  // A unit cube, scaled per instance. Chamfered on the unit, so a 20m block
  // gets a proportionate reveal at its corners — a raw box silhouette against
  // the sky is the single most obvious tell there is, and on a street circuit
  // these are most of the horizon.
  const buildingGeo = quality === 'low'
    ? new THREE.BoxGeometry(1, 1, 1)
    : chamferBox(1, 1, 1, 0.012);

  const treeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const standMat = new THREE.MeshStandardMaterial({
    roughness: 0.75, metalness: 0.05, vertexColors: true,
  });
  const buildingMat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });

  let treeSlots = 0;
  let standSlots = 0;
  let buildingSlots = 0;
  for (const item of items) {
    if (item.kind === 'tree') treeSlots++;
    else if (item.kind === 'grandstand') standSlots++;
    // The main stands are in the same list — they have to be, so that the
    // simulation collides with them — but the paddock draws them, from a much
    // larger preset. Skipped here rather than filtered out of the list, because
    // the list is the world and this is only one of the two things that read it.
    else if (item.kind === 'mainstand') continue;
    else buildingSlots++;
  }

  const trees = new THREE.InstancedMesh(treeGeo, treeMat, Math.max(1, treeSlots));
  const stands = new THREE.InstancedMesh(standGeo, standMat, Math.max(1, standSlots));
  const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, Math.max(1, buildingSlots));
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

  for (const item of items) {
    if (item.kind === 'mainstand') continue;
    quat.setFromAxisAngle(up, item.yaw);

    if (item.kind === 'building') {
      // The box geometry is a unit cube centred on its origin, so it is lifted
      // by half its height to stand on the ground.
      pos.set(item.x, item.y + item.height * 0.5, item.z);
      scale.set(item.spanX, item.height, item.spanZ);
      matrix.compose(pos, quat, scale);
      buildings.setMatrixAt(buildingN, matrix);
      colour.setHSL(0.58 + item.h2 * 0.05, 0.06, 0.24 + item.h * 0.2);
      buildings.setColorAt(buildingN, colour);
      buildingN++;
      continue;
    }

    if (item.kind === 'grandstand') {
      pos.set(item.x, item.y, item.z);
      scale.set(1, 1, 1);
      matrix.compose(pos, quat, scale);
      stands.setMatrixAt(standN, matrix);
      // Near-white: the stand carries its own colours per vertex, and an
      // instance tint multiplies them, so anything darker greys out the crowd.
      colour.setHSL(0.58, 0.05, 0.86 + item.h * 0.1);
      stands.setColorAt(standN, colour);
      standN++;
      continue;
    }

    // The tree geometry is authored around a canopy radius of 1.9m, so the
    // layout's footprint and this scale have to be derived from the same
    // number — see `buildSceneryLayout`.
    const size = scenery === 'desert' ? 0.5 + item.h * 0.4 : 0.8 + item.h * 0.85;
    pos.set(item.x, item.y, item.z);
    scale.set(size, size * (0.85 + item.h2 * 0.5), size);
    matrix.compose(pos, quat, scale);
    trees.setMatrixAt(treeN, matrix);
    if (scenery === 'desert') colour.setHSL(0.11, 0.3, 0.32 + item.h2 * 0.1);
    else if (scenery === 'forest') colour.setHSL(0.31, 0.42, 0.13 + item.h2 * 0.09);
    else colour.setHSL(0.28, 0.38, 0.15 + item.h2 * 0.12);
    trees.setColorAt(treeN, colour);
    treeN++;
  }

  trees.count = Math.max(1, treeN);
  stands.count = Math.max(1, standN);
  buildings.count = Math.max(1, buildingN);
  for (const m of [trees, stands, buildings]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  const meshes: THREE.InstancedMesh[] = [trees, stands];
  if (isStreet && buildingN > 0) meshes.push(buildings);

  return {
    meshes,
    geometries: [treeGeo, standGeo, buildingGeo],
    materials: [treeMat, standMat, buildingMat],
  };
}


/** Alpha threshold for the catch fence. Shared with its mip chain; see below. */
const FENCE_ALPHA_TEST = 0.45;

/**
 * Mip chain for an alpha-tested texture that keeps the same amount of stuff
 * ALIVE at every level.
 *
 * This is the fix for "the entire circuit seems very grainy", and it is worth
 * setting out why, because two previous passes went after the ambient occlusion
 * taps and the grade pass's dither instead and neither made any difference.
 *
 * Measured: freeze the world, pin the camera, render, yaw by a third of a pixel,
 * render again, and take the RMS difference per region in display levels. That
 * is what "grainy" is — the picture is clean in a still and boils the moment
 * anything moves. On a chase frame at Monza:
 *
 *   catch fence   11.4      hiding the fence: 0.15
 *   hoardings      2.8
 *   far asphalt    2.7
 *   grass          1.8
 *   near asphalt   0.4
 *   sky            0.1
 *
 * and turning off the AO taps changed the fence figure from 11.43 to 11.42,
 * the dither changed nothing at all, and turning off FXAA made everything
 * WORSE. The fence was three quarters of the whole effect on its own.
 *
 * The mechanism is the standard alpha-test one. A box-filtered mip of a thin
 * wire grid converges toward the grid's mean coverage — about a quarter here —
 * which is below the 0.45 threshold, so at distance almost every texel fails
 * the test and the surviving ones sit right on the boundary. Every sub-pixel
 * camera movement flips a different set of them. The fence does not fade with
 * distance, it strobes.
 *
 * The fix, from Castano's work on alpha-tested foliage, is to rescale each mip
 * level so that the FRACTION of its texels passing the threshold matches level
 * zero. A binary search on the scale is exact enough in a dozen iterations and
 * runs once, at texture build time. The wire then keeps its apparent density
 * all the way to the horizon instead of dissolving, and because no texel is
 * left balanced on the threshold there is nothing to flip.
 */
function coveragePreservingMips(
  base: Uint8Array, size: number, threshold: number,
): { data: Uint8Array; width: number; height: number }[] {
  const cut = threshold * 255;
  const coverage = (d: Uint8Array, scale: number) => {
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] * scale > cut) n++;
    return n / (d.length / 4);
  };

  const levels: { data: Uint8Array; width: number; height: number }[] = [];
  let cur = base;
  let w = size, h = size;
  levels.push({ data: cur, width: w, height: h });
  const target = coverage(cur, 1);

  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(2 * y, h - 1) * w;
      const y1 = Math.min(2 * y + 1, h - 1) * w;
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(2 * x, w - 1);
        const x1 = Math.min(2 * x + 1, w - 1);
        const o = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) {
          next[o + c] = (cur[(y0 + x0) * 4 + c] + cur[(y0 + x1) * 4 + c]
            + cur[(y1 + x0) * 4 + c] + cur[(y1 + x1) * 4 + c] + 2) >> 2;
        }
      }
    }
    // Smallest scale that keeps level zero's coverage. Bounded above so a
    // 1x1 level, whose coverage is either 0 or 1, cannot run away.
    let lo = 1, hi = 24;
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) * 0.5;
      if (coverage(next, mid) < target) lo = mid; else hi = mid;
    }
    const s = (lo + hi) * 0.5;
    for (let i = 0; i < next.length; i++) next[i] = Math.min(255, Math.round(next[i] * s));

    levels.push({ data: next, width: nw, height: nh });
    cur = next; w = nw; h = nh;
  }
  return levels;
}

/**
 * A wire-mesh texture for the catch fencing: a grid of thin wires with posts.
 *
 * White on black, used as both the colour map and the alpha map, with the
 * material's own colour tinting it green. Generating it means the wire gauge
 * can be tuned to stay visible at speed — too fine and the fence disappears
 * into aliasing shimmer, too coarse and it reads as a net.
 *
 * The mip chain is built by hand rather than by the driver; see
 * `coveragePreservingMips` for the reason, which is the largest single source
 * of shimmer anywhere in the game.
 */
function makeFenceTexture(): THREE.Texture {
  // 256, not 64. The wire gauge below is expressed as a fraction of S so the
  // fence looks identical — but at 64 pixels an alpha-tested diagonal is a
  // visible staircase on the largest surface in almost every frame, and a
  // staircase reads as "blocky" for exactly the same reason a facet does.
  // One texture for the whole circuit, so this costs 256KB.
  const S = 512;
  // Six diamonds per tile rather than four. One tile covers four metres of
  // barrier, so the old pitch made every link a metre across — which is not a
  // catch fence, it is a cargo net, and at that size its stepped diagonals were
  // the most obviously pixelated thing in the frame. The wire keeps the same
  // fraction of the opening it had, so it is no more prone to shimmering at
  // speed than before.
  const PITCH = S / 6;
  const GAUGE = PITCH * 0.13;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);

  // The diamond weave of real chain-link.
  g.strokeStyle = '#fff';
  g.lineWidth = GAUGE;
  g.beginPath();
  for (let i = -S; i < S * 2; i += PITCH) {
    g.moveTo(i, 0);
    g.lineTo(i + S, S);
    g.moveTo(i + S, 0);
    g.lineTo(i, S);
  }
  g.stroke();

  const src = g.getImageData(0, 0, S, S).data;
  const levels = coveragePreservingMips(new Uint8Array(src), S, FENCE_ALPHA_TEST);

  const tex = new THREE.DataTexture(levels[0].data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  // The chain is supplied, not generated: the driver's box filter is exactly
  // what produces the strobing this replaces.
  tex.generateMipmaps = false;
  tex.mipmaps = levels;
  // 16, not 8. A fence is seen at a glancing angle from almost every camera in
  // the game, and its footprint is stretched twenty to one along the barrier.
  // three clamps this to whatever the GPU actually offers.
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}
