import * as THREE from 'three';
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
  asphalt: new THREE.Color(0x2a2d33),
  asphaltDark: new THREE.Color(0x23262b),
  runoff: new THREE.Color(0x4a3f38),
  whiteLine: new THREE.Color(0xd8dade),
  kerbA: new THREE.Color(0xc8353c),
  kerbB: new THREE.Color(0xe8e8ea),
  grass: new THREE.Color(0x35502f),
  desert: new THREE.Color(0x8a7355),
  gravel: new THREE.Color(0x9a9285),
  wall: new THREE.Color(0x53575e),
  pit: new THREE.Color(0x33363c),
  startLine: new THREE.Color(0xe8e8ea),
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

  const count = track.count;
  // Step in nodes. At 3m per node, a step of 2 gives 6m quads — plenty for a
  // stylised look and it halves the triangle count on mobile.
  const step = quality === 'low' ? 3 : 2;

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
    // Red/white in blocks, which is both correct and gives a strong motion cue.
    const kerbColour = ((a / step) & 1) === 0 ? COLOUR.kerbA : COLOUR.kerbB;
    if (track.isCurbLeft[a] && track.isCurbLeft[b]) {
      // Left-hand side of the track is negative lateral.
      const iA = -hwA, oA = -(hwA + KERB_W);
      const iB = -hwB, oB = -(hwB + KERB_W);
      kerbs.quad(
        px(a, iA), py(a, iA) + Y_KERB, pz(a, iA),
        px(b, iB), py(b, iB) + Y_KERB, pz(b, iB),
        px(b, oB), py(b, oB) + Y_RUNOFF, pz(b, oB),
        px(a, oA), py(a, oA) + Y_RUNOFF, pz(a, oA),
        kerbColour,
      );
    }
    if (track.isCurbRight[a] && track.isCurbRight[b]) {
      const iA = hwA, oA = hwA + KERB_W;
      const iB = hwB, oB = hwB + KERB_W;
      kerbs.quad(
        px(a, oA), py(a, oA) + Y_RUNOFF, pz(a, oA),
        px(b, oB), py(b, oB) + Y_RUNOFF, pz(b, oB),
        px(b, iB), py(b, iB) + Y_KERB, pz(b, iB),
        px(a, iA), py(a, iA) + Y_KERB, pz(a, iA),
        kerbColour,
      );
    }

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

    // --- Barrier walls -----------------------------------------------------
    // Placed exactly where RaceEngine.enforceBarriers puts them, so a wall you
    // can see is a wall you actually hit.
    const barrierOffset = isStreet ? 2.5 : 14;
    for (const side of [-1, 1] as const) {
      const oA = side * (hwA + barrierOffset);
      const oB = side * (hwB + barrierOffset);
      const yA = py(a, oA) + Y_RUNOFF;
      const yB = py(b, oB) + Y_RUNOFF;
      if (side > 0) {
        walls.quad(
          px(a, oA), yA, pz(a, oA),
          px(b, oB), yB, pz(b, oB),
          px(b, oB), yB + WALL_H, pz(b, oB),
          px(a, oA), yA + WALL_H, pz(a, oA),
          COLOUR.wall,
        );
      } else {
        walls.quad(
          px(a, oA), yA + WALL_H, pz(a, oA),
          px(b, oB), yB + WALL_H, pz(b, oB),
          px(b, oB), yB, pz(b, oB),
          px(a, oA), yA, pz(a, oA),
          COLOUR.wall,
        );
      }
    }
  }

  // --- Pit lane ------------------------------------------------------------
  {
    const def = track.def;
    const lane = def.pitLane;
    const laneHalf = 6;
    const from = lane.entryS;
    const toRaw = lane.exitS < from ? lane.exitS + track.length : lane.exitS;
    const pitStep = 8;
    for (let s = from; s < toRaw; s += pitStep) {
      const a = track.indexAt(s);
      const b = track.indexAt(s + pitStep);
      const o = lane.lateralOffsetM;
      pit.quad(
        px(a, o - laneHalf), py(a, o - laneHalf) + Y_ROAD, pz(a, o - laneHalf),
        px(b, o - laneHalf), py(b, o - laneHalf) + Y_ROAD, pz(b, o - laneHalf),
        px(b, o + laneHalf), py(b, o + laneHalf) + Y_ROAD, pz(b, o + laneHalf),
        px(a, o + laneHalf), py(a, o + laneHalf) + Y_ROAD, pz(a, o + laneHalf),
        COLOUR.pit,
      );
    }
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
    addMesh(root, grid, false, geometries, materials);
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
    addMesh(root, marks, false, geometries, materials);
  }

  addMesh(root, road, false, geometries, materials);
  addMesh(root, lines, false, geometries, materials);
  addMesh(root, kerbs, false, geometries, materials);
  addMesh(root, runoff, false, geometries, materials);
  addMesh(root, pit, false, geometries, materials);
  addMesh(root, walls, true, geometries, materials);

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
    const mat = new THREE.MeshLambertMaterial({ color: groundColour(track.def.scenery) });
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
      root.add(dressing.mesh);
      geometries.push(dressing.geometry);
      materials.push(dressing.material);
    }
  }

  return {
    root,
    dispose(): void {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
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
): void {
  const geo = builder.build();
  if (!geo) return;
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // one object spanning the whole circuit
  root.add(mesh);
  geometries.push(geo);
  materials.push(mat);
}

/**
 * Trees, grandstands and marker blocks as a single InstancedMesh.
 *
 * One instanced draw call for several hundred objects. Placed outside the barrier
 * line so they never obstruct the racing surface, and skipped where the circuit
 * is a street layout (buildings are handled by the wall geometry there).
 */
function buildSceneryInstances(
  track: TrackSpline,
  quality: 'low' | 'high',
): { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry; material: THREE.Material } | null {
  const spacing = quality === 'low' ? 120 : 70;
  const total = Math.floor(track.length / spacing) * 2;
  if (total <= 0) return null;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: false, color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  const scenery = track.def.scenery;
  const isStreet = scenery === 'street';
  const barrier = isStreet ? 2.5 : 14;

  let n = 0;
  for (let k = 0; n < total; k++) {
    const s = (k * spacing) % track.length;
    const i = track.indexAt(s);
    const hw = track.width[i] * 0.5;

    for (const side of [-1, 1] as const) {
      if (n >= total) break;
      // Deterministic pseudo-random from the index: no RNG state, and the
      // scenery is identical every time the circuit loads.
      const h = (Math.sin(k * 12.9898 + side * 78.233) * 43758.5453) % 1;
      const r = Math.abs(h);

      const dist = barrier + 6 + r * 26;
      const lat = side * (hw + dist);
      const x = track.px[i] + track.nx[i] * lat;
      const z = track.pz[i] + track.nz[i] * lat;
      const groundY = track.elevation[i];

      let height: number;
      let width: number;
      if (isStreet) {
        height = 12 + r * 26;
        width = 8 + r * 10;
        colour.setHSL(0.6, 0.05, 0.28 + r * 0.16);
      } else if (scenery === 'desert') {
        height = 2 + r * 3;
        width = 3 + r * 4;
        colour.setHSL(0.09, 0.25, 0.42 + r * 0.12);
      } else if (scenery === 'stadium' && r > 0.6) {
        height = 9 + r * 8;
        width = 14 + r * 10;
        colour.setHSL(0.58, 0.12, 0.35);
      } else {
        // Trees: a tall thin block reads convincingly at speed.
        height = 7 + r * 11;
        width = 2.5 + r * 2.5;
        colour.setHSL(0.28, 0.35, 0.16 + r * 0.12);
      }

      pos.set(x, groundY + height * 0.5, z);
      scale.set(width, height, width);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, colour);
      n++;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return { mesh, geometry: geo, material: mat };
}
