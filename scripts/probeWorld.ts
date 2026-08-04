/**
 * Checks that the world is a place rather than a backdrop.
 *
 * Three questions, all of which were answered "no" by the game as shipped:
 *
 *  1. Is every piece of scenery actually beside the circuit? Set dressing was
 *     placed at an offset from whichever node it was generated at, and a lap
 *     folds back on itself, so buildings routinely ended up standing on the
 *     road somewhere else — at Monaco with the player's car inside one.
 *  2. Is any of it solid? Nothing outside the track's own lateral limit was,
 *     so a car drove through buildings, grandstands and the pit wall without
 *     touching them.
 *  3. Is the thing that is DRAWN in the same place as the thing that was
 *     TESTED? This is the one that went unanswered, and it is the reason this
 *     file exists in its present form.
 *
 * ---------------------------------------------------------------------------
 * Why a probe could pass while a player looked at a grandstand on the road
 * ---------------------------------------------------------------------------
 *
 * Because it inspected `world.scenery` and `world.obstacles` — the two lists
 * the layout pass produces — and nothing else. Most of what a player can see
 * is in neither list:
 *
 *   * `buildPaddock` emits no `SceneryItem`s. It drew the garage row, the pit
 *     building, the media centre, the tarmac yard, hospitality and the
 *     transporters at fixed offsets behind the garage frontage.
 *   * `MarshalPosts` put a post at `halfWidth + 4.2` per marshalling sector.
 *   * `buildTrackMeshes` draws the armco, the catch fence and the hoardings
 *     from `world.barrierOffsets`, which is capped using a ±70m LAP-DISTANCE
 *     exclusion — so a fold-back closer than 70m along the lap is invisible to
 *     it and the wall goes straight across the other section's road.
 *   * The start/finish gantry and the braking marker boards use fixed offsets.
 *   * `buildTrackMeshes` allocates its instanced set dressing with
 *     `Math.max(1, n)` slots and sets `count = Math.max(1, n)`, so a circuit
 *     with none of a given kind still draws one instance — at the identity
 *     matrix, i.e. at the world origin, which on several circuits is the
 *     middle of the racing surface.
 *   * Even for scenery that IS in the list, `footprintOf` describes a
 *     grandstand as a box anchored at x ∈ [0, spanX] while
 *     `grandstandPreset('trackside', …)` builds geometry spanning local X
 *     -2.82..+10.59. Almost three metres of every stand is outside the
 *     rectangle that gets tested.
 *
 * So this stops asking the layout pass what it intended and measures the
 * triangles. It builds the real renderer-side scene for every circuit —
 * `buildPaddock`, `MarshalPosts`, `buildTrackMeshes`, `buildPitBoxMarker` —
 * walks every mesh in it, transforms every vertex (including every instance of
 * every `InstancedMesh`) into world space, and asks one question per vertex: is
 * this standing on the racing surface, at a height a car occupies?
 *
 * ---------------------------------------------------------------------------
 * Telling a building apart from the road it is standing on
 * ---------------------------------------------------------------------------
 *
 * The road, the kerbs, the white lines, the run-off and the pit lane all
 * legitimately lie on the racing surface, so a naive "is any triangle over the
 * road" test flags the circuit itself. Rather than matching on mesh names —
 * which would mean adding names to `src/render` for the benefit of a test, and
 * a test that depends on a name is a test a rename silently disables — the
 * discriminator is HEIGHT, measured against the local road surface directly
 * beneath the vertex:
 *
 *   * The road plane, its paint and its kerbs all lie within ~0.06m of the
 *     surface. Banking is accounted for, so Zandvoort's bowl does not read as
 *     2.6m of obstruction made out of its own asphalt.
 *   * Anything from 0.25m to 3.5m above the road is at a height a car's nose,
 *     sidepod, airbox or the driver's head occupies. That is an obstruction,
 *     whatever it is. The floor is raised, per node, by how far the road climbs
 *     over one node spacing — see `surfaceFloor`; on Eau Rouge that is the
 *     difference between measuring the world and measuring the node spacing.
 *   * Below the floor a vertex counts only if its normal is roughly HORIZONTAL —
 *     the foot of a wall, a post or a building standing on the road rather than
 *     a piece of road surface. This is what catches the base course of an armco
 *     laid across the racing line, and the vertical skirt the run-off verge
 *     drops to the ground plane where it crosses another section's road.
 *
 * ---------------------------------------------------------------------------
 * What this covers, and what it does not
 * ---------------------------------------------------------------------------
 *
 * COVERED: every triangle of `buildPaddock`, `MarshalPosts`, `FloodlightTowers`, `buildTrackMeshes`
 * (road, kerbs, paint, run-off, pit lane, armco and pit walls, catch fence,
 * hoardings, start/finish gantry, braking marker boards, ground plane and all
 * instanced set dressing) and `buildPitBoxMarker`.
 *
 * NOT COVERED, deliberately:
 *   * Cars, the racing-line ribbon, skid marks, particles and wreckage. They
 *     are supposed to be on the road.
 *   * Anything `Renderer` adds itself: sky, lights, post effects.
 *   * A structure whose vertices all fall OUTSIDE the 0.25–3.5m band while its
 *     faces cross it. A column with vertices only at y=0 and y=7.2 — the gantry
 *     uprights are exactly that — is caught only by the horizontal-normal rule
 *     at its foot. A face-level test would close this; nothing has needed it.
 *   * The pit lane as a keep-out. "Racing surface" here is the circuit
 *     centreline ± `width * 0.5`, which is the question being asked; a garage
 *     standing in its own pit lane is a different bug and a different probe.
 */

import * as THREE from 'three';
import { installCanvasStub } from './lib/domStub';
import { GROUND_MESH_NAME } from '../src/render/Terrain';
import type { TrackSpline as TrackSplineT } from '../src/track/TrackSpline';
import type { WorldModel } from '../src/track/WorldObstacles';
import type { SessionConfig } from '../src/race/RaceEngine';

// The renderer paints its signage, hoardings and fence textures into canvases
// as it builds. None of that is measured here, but it has to succeed before the
// geometry exists — hence the stub, installed BEFORE the render modules load.
// That ordering is the reason they are loaded dynamically: a static `import` is
// hoisted above this call and would run their module bodies first.
installCanvasStub();

const { TrackSpline } = await import('../src/track/TrackSpline');
const { CIRCUITS } = await import('../src/data/tracks/circuits');
const {
  buildWorldModel, buildKeepOutField, footprintOf, KeepOutField,
} = await import('../src/track/WorldObstacles');
const { RaceEngine } = await import('../src/race/RaceEngine');
const { PHYSICS_DT } = await import('../src/core/SimClock');
const { bandOf } = await import('../src/race/DamageModel');
const { buildPaddock } = await import('../src/render/Paddock');
const { MarshalPosts } = await import('../src/render/MarshalPost');
const { FloodlightTowers } = await import('../src/render/FloodlightTowers');
const { buildTrackMeshes } = await import('../src/render/TrackMesh');
const { buildPitBoxMarker } = await import('../src/render/PitBoxMarker');
const { CarEntry } = await import('../src/race/CarEntry');
const { RaceControlManager } = await import('../src/race/RaceControlManager');
const { TEAMS, driversForTeam } = await import('../src/data/teams');

interface Issue {
  circuit: string;
  detail: string;
}

const issues: Issue[] = [];

/** Distance a car's outermost collision disc reaches beyond the barrier line. */
const CAR_REACH_M = 1.0;


// ===========================================================================
// The racing surface, at a resolution a single vertex can be tested against
// ===========================================================================

/**
 * How far past a node its slab reaches, as a fraction of the node spacing.
 * Slightly over a half so consecutive slabs overlap rather than leaving a
 * hairline gap where the centreline turns.
 */
const SLAB_OVERLAP = 0.6;
/**
 * Window along the lap inside which the road may be the one you stand beside.
 *
 * Four node spacings, not the seventy metres `barrierOffsets` uses. Measured
 * against slab rectangles, a barrier `d` metres off the edge at node i is
 * exactly `d` from node i's own rectangle and further from its neighbours', so
 * the stretch you are standing beside needs no exclusion to pass — which means
 * the window only has to cover the handful of nodes whose rectangles you are
 * literally alongside, and everything else can be measured. Anything wider
 * starts excusing the case that matters: a barrier on the inside of a hairpin
 * standing on the road sixty metres round the apex.
 */
const SAME_ROAD_LAP_M = 12;
/** How much of that lap distance must be covered in a straight line for it. */
const SAME_ROAD_CHORD_RATIO = 0.55;

/**
 * Height band, above the local road surface, that a car occupies.
 *
 * The floor sits above the kerbs (which crown at 0.059m) and the paint
 * (0.035m), so the circuit's own surfaces drop out without being named. The
 * ceiling is a car plus a margin — the gantry beam at 6.9m is over the road and
 * is meant to be.
 */
const OBSTRUCTION_LOW_M = 0.25;
const OBSTRUCTION_HIGH_M = 3.5;
/**
 * The floor is raised, per node, by how much the road climbs over one node
 * spacing.
 *
 * The surfaces that legitimately lie on the road do not all take their height
 * from the same place: the pit lane resolves its elevation to the NEAREST node
 * rather than interpolating between them, so on Eau Rouge — 8.7% over 3m nodes
 * — a perfectly correct piece of pit road is drawn a quarter of a metre above
 * the racing surface it merges into. Measuring that as a step in the road is
 * measuring the node spacing, not the world. Adding the local gradient to the
 * floor makes the test as tolerant as the drawing is coarse, and no more: on
 * flat ground it changes nothing at all.
 */
function surfaceFloor(step: number): number {
  return OBSTRUCTION_LOW_M + step;
}
/**
 * How far below the band a vertex may sit and still count, IF its face is
 * roughly vertical: the foot of a wall or a post, i.e. geometry standing on the
 * road rather than being the road.
 */
const FOOTING_LOW_M = -0.35;
/** Above this |normal.y| the face is a surface, not a wall. */
const FOOTING_NORMAL_Y = 0.6;

/**
 * The circuit's drivable surface, as one oriented rectangle per centreline node.
 *
 * NOT the disc-per-node model `KeepOutField` uses. A disc of radius `halfWidth`
 * reaches half a track width PAST its node longitudinally and cuts the corner
 * on the inside of an apex, and at per-vertex resolution that shows up as the
 * circuit's own asphalt being reported as an obstruction over its own road: the
 * disc for a node at the bottom of a descent reaches under the road at the top
 * of it, and the height difference between the two does the rest. A slab
 * `nodeM` long and `width` wide is the same quad `buildTrackMeshes` draws
 * between the same two nodes, so the answer is about the drawn road, and the
 * penetration figure is a true lateral depth rather than a distance to a circle.
 *
 * Every node is registered in every cell its slab's bounding box touches, so a
 * point whose own cell is empty is provably off the road and is rejected with a
 * single hash lookup. That rejection is what makes a per-vertex test over a
 * whole circuit's geometry affordable — the overwhelming majority of the
 * world's triangles are nowhere near the road.
 */
class RoadField {
  private static readonly CELL = 8;

  private readonly bins = new Map<number, number[]>();
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly nx: Float32Array;
  private readonly nz: Float32Array;
  private readonly tx: Float32Array;
  private readonly tz: Float32Array;
  private readonly hw: Float64Array;
  private readonly elev: Float32Array;
  private readonly tanBank: Float64Array;
  /** Largest elevation change to either neighbour; see `surfaceFloor`. */
  private readonly elevStep: Float64Array;
  private readonly dist: Float32Array;
  private readonly count: number;
  private readonly nodeM: number;
  readonly lapLength: number;

  /**
   * Result of the last `probe`, written in place so the per-vertex walk does
   * not allocate.
   *
   * `body` is a vertex in the band a car's bodywork occupies and is always an
   * obstruction; `foot` is one at road level, which is an obstruction only if
   * its face is vertical — a decision the caller makes from the normal. Both
   * are ≤ 0, and 0 means "nothing found". `S` is the lap distance of the piece
   * of road being stood on, which is what makes a failure findable in-game.
   */
  readonly hit = { bodyPen: 0, bodyS: 0, bodyDy: 0, footPen: 0, footS: 0, footDy: 0 };

  constructor(track: TrackSplineT) {
    this.count = track.count;
    this.px = track.px;
    this.pz = track.pz;
    this.nx = track.nx;
    this.nz = track.nz;
    this.tx = track.tx;
    this.tz = track.tz;
    this.elev = track.elevation;
    this.dist = track.dist;
    this.lapLength = track.length;
    this.nodeM = track.length / track.count;
    this.hw = new Float64Array(track.count);
    this.tanBank = new Float64Array(track.count);
    this.elevStep = new Float64Array(track.count);

    for (let i = 0; i < track.count; i++) {
      const p = (i - 1 + track.count) % track.count;
      const n = (i + 1) % track.count;
      this.elevStep[i] = Math.max(
        Math.abs(track.elevation[n] - track.elevation[i]),
        Math.abs(track.elevation[i] - track.elevation[p]),
      );
    }

    const c = RoadField.CELL;
    for (let i = 0; i < track.count; i++) {
      const hw = track.width[i] * 0.5;
      this.hw[i] = hw;
      this.tanBank[i] = track.banking[i] !== 0 ? Math.tan(track.banking[i]) : 0;
      // Registered over the slab's full reach in both axes, whatever its yaw,
      // so a point inside the slab always lands in a cell the node is in. That
      // is what makes the empty-cell rejection a proof rather than a guess.
      const reach = hw + this.nodeM * SLAB_OVERLAP;
      const x = track.px[i], z = track.pz[i];
      const g0x = Math.floor((x - reach) / c), g1x = Math.floor((x + reach) / c);
      const g0z = Math.floor((z - reach) / c), g1z = Math.floor((z + reach) / c);
      for (let gx = g0x; gx <= g1x; gx++) {
        for (let gz = g0z; gz <= g1z; gz++) {
          const key = RoadField.key(gx, gz);
          const bin = this.bins.get(key);
          if (bin) bin.push(i);
          else this.bins.set(key, [i]);
        }
      }
    }
  }

  private static key(gx: number, gz: number): number {
    return (gx * 73856093) ^ (gz * 19349663);
  }

  /**
   * Tests one world-space point against the racing surface, into `this.hit`.
   * Returns false when the point is over no part of the road at all.
   *
   * A point can be over more than one piece of road — a circuit that crosses
   * itself has two, at different heights — so every containing slab is
   * considered and the point is measured against THAT slab's surface. Suzuka's
   * crossover is the case that matters: the bridge deck is metres over the road
   * below it and is not an obstruction; the same deck two metres up would be.
   */
  probe(x: number, y: number, z: number): boolean {
    const hit = this.hit;
    hit.bodyPen = 0;
    hit.footPen = 0;

    const bin = this.bins.get(RoadField.key(
      Math.floor(x / RoadField.CELL), Math.floor(z / RoadField.CELL),
    ));
    if (!bin) return false;

    const halfSlab = this.nodeM * SLAB_OVERLAP;
    for (const i of bin) {
      const dx = x - this.px[i];
      const dz = z - this.pz[i];
      const along = dx * this.tx[i] + dz * this.tz[i];
      if (along < -halfSlab || along > halfSlab) continue;
      const lat = dx * this.nx[i] + dz * this.nz[i];
      const pen = Math.abs(lat) - this.hw[i];
      if (pen >= 0) continue;

      // Road height under the point: this node's elevation, tilted by the
      // banking across the section and interpolated along it. Without the
      // banking term a steeply banked corner reads as metres of obstruction
      // made out of its own asphalt.
      const j = along >= 0
        ? (i + 1) % this.count
        : (i - 1 + this.count) % this.count;
      const f = Math.min(1, Math.abs(along) / this.nodeM);
      const roadY = this.elev[i] + (this.elev[j] - this.elev[i]) * f - lat * this.tanBank[i];
      const dy = y - roadY;

      const low = surfaceFloor(this.elevStep[i]);
      if (dy >= low && dy <= OBSTRUCTION_HIGH_M) {
        if (pen < hit.bodyPen) { hit.bodyPen = pen; hit.bodyS = this.dist[i]; hit.bodyDy = dy; }
      } else if (dy > FOOTING_LOW_M && dy < low) {
        if (pen < hit.footPen) { hit.footPen = pen; hit.footS = this.dist[i]; hit.footDy = dy; }
      }
    }
    return hit.bodyPen < 0 || hit.footPen < 0;
  }

  /**
   * Shortest distance from a point to the racing surface, ignoring whatever
   * stretch of it the caller is standing beside.
   *
   * Distance to the slab RECTANGLE, not to a disc. Measured against discs, a
   * barrier two metres off the edge of a straight reads as standing on the road
   * half a track-width further along and every barrier on every circuit fails;
   * the rectangle is the road.
   *
   * `KeepOutField.clearanceAt` answers the same question with a ±70m
   * LAP-DISTANCE exclusion, and that is the bug this exists to catch: at a
   * fold-back the road seventy metres further round the lap is fifteen metres
   * away in space, so the exclusion hides precisely the conflict it is being
   * asked about. The exclusion here is geometric — a node is "the road you are
   * standing beside" only if it is close along the lap AND the straight-line
   * distance to it has kept up with the distance travelled along the lap. A
   * section that has doubled back covers 70m of lap in 15m of ground, fails the
   * second half of that test, and is measured.
   *
   * The 0.55 ratio corresponds to a section that has turned through about 137°;
   * anything straighter than that inside the window is the same piece of road.
   */
  foldBackClearance(
    x: number, z: number, fromX: number, fromZ: number, fromS: number, cap: number,
  ): number {
    const c = RoadField.CELL;
    const g0x = Math.floor((x - cap) / c), g1x = Math.floor((x + cap) / c);
    const g0z = Math.floor((z - cap) / c), g1z = Math.floor((z + cap) / c);
    const halfSlab = this.nodeM * SLAB_OVERLAP;
    let best = cap;
    const seen = new Set<number>();
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const bin = this.bins.get(RoadField.key(gx, gz));
        if (!bin) continue;
        for (const i of bin) {
          if (seen.has(i)) continue;
          seen.add(i);
          let ds = Math.abs(this.dist[i] - fromS);
          if (ds > this.lapLength * 0.5) ds = this.lapLength - ds;
          if (ds <= SAME_ROAD_LAP_M) {
            const chord = Math.hypot(this.px[i] - fromX, this.pz[i] - fromZ);
            if (chord >= SAME_ROAD_CHORD_RATIO * ds) continue;
          }
          const dx = x - this.px[i];
          const dz = z - this.pz[i];
          const along = Math.abs(dx * this.tx[i] + dz * this.tz[i]) - halfSlab;
          const lat = Math.abs(dx * this.nx[i] + dz * this.nz[i]) - this.hw[i];
          const oa = along > 0 ? along : 0;
          const ol = lat > 0 ? lat : 0;
          // Inside the rectangle both overhangs are zero; the signed answer is
          // then the larger (least negative) of the two, i.e. how far in it is.
          const d = (oa === 0 && ol === 0) ? Math.max(along, lat) : Math.hypot(oa, ol);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

// ===========================================================================
// Walking the drawn scene
// ===========================================================================

/**
 * Penetration, in metres, at which an intrusion is reported as a failure.
 *
 * Not zero: consecutive slabs overlap slightly at their ends, and the drawn
 * quads join two nodes with a straight edge where the slab uses each node's own
 * normal, so the two disagree by a few centimetres on the inside of a tight
 * corner. A probe that fails on its own discretisation is noise.
 */
const FAIL_PENETRATION_M = 0.10;

/**
 * Cap on vertices sampled per mesh; beyond it the walk strides.
 *
 * Set high enough that NOTHING strides today — the largest mesh on the calendar
 * is Zandvoort's merged paddock at a little over a million vertices, and the
 * whole calendar checks in ten seconds at full resolution. It is a guard
 * against a future mesh large enough to make the probe too slow to run, not a
 * sampling scheme in use: at 400_000 the same run reported the same failures
 * with the same depths but only a third of Zandvoort's offending vertices, and
 * an undercounted vertex total is a worse report for no gain worth having.
 */
const MAX_SAMPLES_PER_MESH = 4_000_000;

interface SourceStat {
  /** Vertices found standing on the racing surface. */
  verts: number;
  /** Deepest intrusion, in metres. Negative — more negative is worse. */
  worst: number;
  /** Where the worst one is, so the report can be walked to in-game. */
  at: { x: number; y: number; z: number; s: number; dy: number } | null;
}

type Stats = Map<string, SourceStat>;

/**
 * `PROBE_WORLD_DUMP=<circuit id>` lists every offending vertex for one circuit.
 *
 * A summary says a wall is on the road; the dump says which wall. The 51
 * vertices Suzuka reports are a specific band at a specific height along a
 * specific stretch, and reading them is how you find out whether you are
 * looking at the trackside armco, the pit wall or something else merged into
 * the same strip.
 */
const DUMP_CIRCUIT = process.env.PROBE_WORLD_DUMP ?? '';
let dumping = false;

function record(
  stats: Stats, source: string, pen: number, s: number, dy: number,
  x: number, y: number, z: number,
): void {
  let stat = stats.get(source);
  if (!stat) { stat = { verts: 0, worst: 0, at: null }; stats.set(source, stat); }
  stat.verts++;
  if (pen < stat.worst) { stat.worst = pen; stat.at = { x, y, z, s, dy }; }
  if (dumping) {
    console.log(
      `    ${source.padEnd(17)} x=${x.toFixed(1)} y=${y.toFixed(2)} z=${z.toFixed(1)} ` +
      `pen=${pen.toFixed(2)} dy=${dy.toFixed(2)} onRoadAtS=${s.toFixed(0)}`,
    );
  }
}

const vTmp = new THREE.Vector3();
const nTmp = new THREE.Vector3();
const mTmp = new THREE.Matrix4();

/**
 * Walks every mesh under `root`, transforms every vertex into world space and
 * records the ones standing on the racing surface at car height.
 *
 * Instanced meshes are expanded: the per-instance matrix is composed with the
 * object's world matrix, so the fifty grandstands an `InstancedMesh` draws are
 * fifty tested footprints rather than one untested prototype. That expansion is
 * not an optimisation detail — it is the only way to see an instance that was
 * never written to and is therefore drawn at the identity matrix.
 *
 * Very large merged buffers are sampled with a stride so the whole calendar
 * checks in a few seconds. The stride is per mesh and keeps the sample at
 * `MAX_SAMPLES_PER_MESH`; in practice only the merged paddock and the circuit's
 * surface strips reach it, and both are dense enough that a stride of two or
 * three cannot step over a whole building.
 */
function scanTree(
  root: THREE.Object3D, field: RoadField, stats: Stats,
  label: (o: THREE.Object3D) => string,
): void {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;

    const inst = (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh
      ? (mesh as THREE.InstancedMesh) : null;
    const copies = inst ? inst.count : 1;
    const stride = Math.max(1, Math.ceil((pos.count * copies) / MAX_SAMPLES_PER_MESH));
    const source = label(mesh);
    const hit = field.hit;

    for (let c = 0; c < copies; c++) {
      if (inst) {
        inst.getMatrixAt(c, mTmp);
        mTmp.premultiply(mesh.matrixWorld);
      } else {
        mTmp.copy(mesh.matrixWorld);
      }
      for (let k = 0; k < pos.count; k += stride) {
        vTmp.fromBufferAttribute(pos, k).applyMatrix4(mTmp);
        if (!field.probe(vTmp.x, vTmp.y, vTmp.z)) continue;
        let pen = hit.bodyPen;
        let s = hit.bodyS;
        let dy = hit.bodyDy;
        if (pen === 0 && nrm) {
          // At road level: only a vertical face is an obstruction. A horizontal
          // one is the road, the run-off, a kerb or a painted line.
          nTmp.fromBufferAttribute(nrm, k).transformDirection(mTmp);
          if (Math.abs(nTmp.y) < FOOTING_NORMAL_Y) {
            pen = hit.footPen; s = hit.footS; dy = hit.footDy;
          }
        }
        if (pen === 0) continue;
        record(stats, source, pen, s, dy, vTmp.x, vTmp.y, vTmp.z);
      }
    }
  });
}

/**
 * Names the direct children of `buildTrackMeshes`'s root, from their own name
 * where they have one and from what they ARE where they do not.
 *
 * Every discriminator is observable on the object:
 *   * the ground carries `GROUND_MESH_NAME`. It used to be identified as "the
 *     only mesh with four vertices", which was true while the world beyond the
 *     circuit was a single quad and stopped being true the moment it became a
 *     height field: the ground fell through to the last rule in the list and
 *     was reported as BRAKING BOARDS standing on the racing surface, tens of
 *     thousands of vertices of them. An identification that depends on a mesh
 *     staying trivial is not an identification;
 *   * the only `Group` is the start/finish gantry;
 *   * the only `InstancedMesh`es are the set dressing;
 *   * the catch fence is the only alpha-tested material;
 *   * the surface strips are the only vertex-coloured ones, and exactly two of
 *     them are double-sided — `addMesh` is called with `doubleSided` true for
 *     the verge and for the walls, and false for every other surface. They are
 *     told apart by the order they are added in, which is the one discriminator
 *     here that a reordering could invert. It would swap two labels and change
 *     no verdict: the vertices are measured either way, and the dump below
 *     prints their coordinates.
 *
 *     Each of those two is a merge of several things and is named for all of
 *     them rather than claiming a precision the merge does not allow:
 *     `verge/skirt` is the ground strip out to the barrier line plus the
 *     vertical skirt that closes it down to the ground plane, and
 *     `barrier/pit-wall` is the trackside armco, the street-circuit concrete
 *     and both pit walls;
 *   * of the two remaining textured meshes, the hoardings are added before the
 *     gantry and the braking boards after it.
 */
function labelCircuitChildren(root: THREE.Group): Map<string, string> {
  const byUuid = new Map<string, string>();
  let seenGantry = false;
  let doubleSidedStrips = 0;
  for (const child of root.children) {
    const mesh = child as THREE.Mesh;
    const isMesh = (mesh as unknown as { isMesh?: boolean }).isMesh === true;
    const mat = isMesh ? (mesh.material as THREE.MeshStandardMaterial) : null;
    let label: string;
    if (child.name === GROUND_MESH_NAME) {
      label = 'ground';
    } else if (!isMesh) {
      label = 'gantry';
      seenGantry = true;
    } else if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) {
      label = 'scenery';
    } else if (mat && mat.alphaTest > 0) {
      label = 'catch-fence';
    } else if (mat && mat.vertexColors) {
      label = mat.side === THREE.DoubleSide
        ? (doubleSidedStrips++ === 0 ? 'verge/skirt' : 'barrier/pit-wall')
        : 'track-surface';
    } else {
      label = seenGantry ? 'marker-boards' : 'hoardings';
    }
    child.traverse((o) => byUuid.set(o.uuid, label));
  }
  return byUuid;
}

// ===========================================================================
// The barrier line, re-tested without the exclusion that hides fold-backs
// ===========================================================================

/** Clearance a barrier must keep from any other part of the circuit. */
const BARRIER_ROAD_CLEARANCE_M = 2.0;
/**
 * Slack on that clearance before it is called a failure.
 *
 * `barrierOffsets` searches outward in one-metre steps and measures against
 * discs; this measures against rectangles. The two agree to a few centimetres,
 * and a barrier that clears by 1.95m where the rule says 2.00m is the two
 * models disagreeing, not a wall on the road. Standing ON the road is reported
 * regardless of this.
 */
const BARRIER_TIGHT_TOLERANCE_M = 0.25;

interface BarrierReport {
  /** Nodes whose drawn barrier stands ON another part of the racing surface. */
  onRoad: number;
  /** Nodes clear of it, but by less than the required margin. */
  tight: number;
  /** Worst clearance found, metres. Negative means over the road. */
  worst: number;
  worstAt: { s: number; side: number } | null;
}

function checkBarrierLine(
  track: TrackSplineT, world: WorldModel, field: RoadField,
): BarrierReport {
  const out: BarrierReport = { onRoad: 0, tight: 0, worst: Infinity, worstAt: null };
  for (const side of [-1, 1] as const) {
    const arr = side > 0 ? world.barrierOffsets.left : world.barrierOffsets.right;
    for (let i = 0; i < track.count; i++) {
      const off = arr[i];
      if (off <= 0) continue;   // no barrier drawn here at all
      const hw = track.width[i] * 0.5;
      const lat = side * (hw + off);
      const x = track.px[i] + track.nx[i] * lat;
      const z = track.pz[i] + track.nz[i] * lat;
      const clear = field.foldBackClearance(
        x, z, track.px[i], track.pz[i], track.dist[i], BARRIER_ROAD_CLEARANCE_M + 2,
      );
      if (clear < 0) out.onRoad++;
      else if (clear < BARRIER_ROAD_CLEARANCE_M - BARRIER_TIGHT_TOLERANCE_M) out.tight++;
      if (clear < out.worst) { out.worst = clear; out.worstAt = { s: track.dist[i], side }; }
    }
  }
  return out;
}

// ===========================================================================
// Per circuit
// ===========================================================================

interface Row {
  id: string;
  scenery: number;
  solid: number;
  tightest: number;
  worst: number;
  verts: number;
  source: string;
  barrier: BarrierReport;
}

const rows: Row[] = [];
const detail: string[] = [];
let pitBoxCovered = true;

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const keepOut = buildKeepOutField(track);
  const runoff = def.scenery === 'street' ? 2.5 : 14;

  // --- 1. Nothing is built on the road, per the layout pass ---------------
  let onRoad = 0;
  let worstMargin = Infinity;
  for (const item of world.scenery) {
    const f = footprintOf(item);
    // Walk the margin down until the footprint is clear, so the report says how
    // much room the tightest object actually has.
    let clear = 0;
    for (let m = 40; m >= 0; m -= 0.5) {
      if (keepOut.clearOfBox(f.x, f.z, f.cos, f.sin, f.halfX, f.halfZ, m)) {
        clear = m;
        break;
      }
    }
    if (clear < worstMargin) worstMargin = clear;
    if (clear <= 0) onRoad++;
  }

  if (onRoad > 0) {
    issues.push({ circuit: def.id, detail: `${onRoad} scenery objects standing on the circuit` });
  }
  if (worstMargin < runoff + CAR_REACH_M) {
    issues.push({
      circuit: def.id,
      detail: `closest scenery is ${worstMargin.toFixed(1)}m from the road — ` +
        `inside the ${(runoff + CAR_REACH_M).toFixed(1)}m a car can reach`,
    });
  }

  // --- 2. Nothing SOLID is on the racing surface --------------------------
  // The pit wall and the walls down the entry and exit roads are real objects a
  // car bounces off, so a metre of one of them poking through the track edge is
  // not a cosmetic problem — it is a wall in the middle of the road that every
  // car on the lead lap drives into.
  const roadOnly = new KeepOutField();
  for (let i = 0; i < track.count; i++) {
    roadOnly.add(track.px[i], track.pz[i], track.width[i] * 0.5);
  }
  let solidOnRoad = 0;
  for (const o of world.obstacles.obstacles) {
    if (!roadOnly.clearOfBox(o.x, o.z, o.cos, o.sin, o.halfX, o.halfZ, 0)) solidOnRoad++;
  }
  if (solidOnRoad > 0) {
    issues.push({ circuit: def.id, detail: `${solidOnRoad} solid objects standing on the racing surface` });
  }

  // The circuit still has to look like a circuit. A layout pass that solves
  // "nothing on the road" by placing nothing at all is not a fix.
  const expected = Math.floor(track.length / 55) * 0.5;
  if (world.scenery.length < expected) {
    issues.push({
      circuit: def.id,
      detail: `only ${world.scenery.length} scenery objects for ${(track.length / 1000).toFixed(1)}km`,
    });
  }

  // --- 3. THE GEOMETRY THAT IS ACTUALLY DRAWN -----------------------------
  const field = new RoadField(track);
  const stats: Stats = new Map();
  dumping = DUMP_CIRCUIT === def.id;
  if (dumping) console.log(`\n  every offending vertex at ${def.id}:`);

  const paddock = buildPaddock(track, 'high', world);
  scanTree(paddock.root, field, stats, () => 'paddock');
  paddock.dispose();

  // The post count comes from race control, exactly as `Renderer` takes it, so
  // the probe tests the posts the game builds rather than a number of its own.
  const posts = new MarshalPosts(track, new RaceControlManager(track).marshalSectorCount);
  scanTree(posts.root, field, stats, () => 'marshal');
  posts.dispose();

  // Light masts, at the two circuits that race under lights. Added with the
  // masts themselves (issue #78) rather than afterwards, because this file's
  // own header is a list of renderer-side builders that were NOT in this scan
  // and were therefore drawing on the road unchecked — adding a thirty-six
  // metre steel column to the world without adding it here would have been the
  // next entry on that list. `Renderer` gates on the same property.
  if (def.ambience === 'night') {
    const masts = new FloodlightTowers(track);
    scanTree(masts.root, field, stats, () => 'floodlight');
    masts.dispose();
  }

  const meshes = buildTrackMeshes(track, 'high', world);
  const labels = labelCircuitChildren(meshes.root);
  scanTree(meshes.root, field, stats, (o) => labels.get(o.uuid) ?? 'circuit');
  meshes.dispose();

  try {
    const team = TEAMS[0];
    const driver = driversForTeam(team.id)[0];
    const player = new CarEntry(0, driver, team, track, true, 1, 100, 'medium');
    const box = buildPitBoxMarker(track, player);
    scanTree(box.root, field, stats, () => 'pit-box');
    box.dispose();
  } catch (err) {
    if (pitBoxCovered) console.log(`note: pit box marker skipped — ${(err as Error).message}`);
    pitBoxCovered = false;
  }

  // --- 4. The barrier line, without the fold-back blind spot --------------
  const barrier = checkBarrierLine(track, world, field);

  // --- Roll up ------------------------------------------------------------
  let worst = 0;
  let worstSource = '';
  let verts = 0;
  const offenders: string[] = [];
  const sorted = [...stats.entries()].sort((a, b) => a[1].worst - b[1].worst);
  for (const [source, stat] of sorted) {
    verts += stat.verts;
    if (stat.worst < worst) { worst = stat.worst; worstSource = source; }
    if (stat.worst <= -FAIL_PENETRATION_M) {
      offenders.push(`${source} ${stat.worst.toFixed(2)}m deep (${stat.verts} vertices)`);
      if (stat.at) {
        detail.push(
          `  ${def.id} / ${source}: worst vertex at x=${stat.at.x.toFixed(1)} ` +
          `y=${stat.at.y.toFixed(1)} z=${stat.at.z.toFixed(1)} — ` +
          `${(-stat.worst).toFixed(2)}m inside the edge of the road at s=${stat.at.s.toFixed(0)}m, ` +
          `${stat.at.dy.toFixed(2)}m above it`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    issues.push({
      circuit: def.id,
      detail: `drawn geometry standing on the racing surface — ${offenders.join('; ')}`,
    });
  }

  if (barrier.onRoad > 0) {
    issues.push({
      circuit: def.id,
      detail: `${barrier.onRoad} drawn barrier nodes stand on another part of the circuit ` +
        `(worst ${barrier.worst.toFixed(2)}m` +
        (barrier.worstAt
          ? ` at s=${barrier.worstAt.s.toFixed(0)}m, ${barrier.worstAt.side > 0 ? 'left' : 'right'}`
          : '') +
        `) — the ±${SAME_ROAD_LAP_M}m lap-distance exclusion in barrierOffsets hides these`,
    });
  } else if (barrier.tight > 0) {
    issues.push({
      circuit: def.id,
      detail: `${barrier.tight} drawn barrier nodes are within ` +
        `${BARRIER_ROAD_CLEARANCE_M}m of another part of the circuit ` +
        `(worst ${barrier.worst.toFixed(2)}m` +
        (barrier.worstAt
          ? ` at s=${barrier.worstAt.s.toFixed(0)}m, ${barrier.worstAt.side > 0 ? 'left' : 'right'}`
          : '') + ')',
    });
  }

  rows.push({
    id: def.id,
    scenery: world.scenery.length,
    solid: world.obstacles.obstacles.length,
    tightest: worstMargin,
    worst,
    verts,
    source: worstSource || '-',
    barrier,
  });
}

// ===========================================================================
// Report
// ===========================================================================

console.log('DRAWN GEOMETRY vs THE RACING SURFACE');
console.log(
  'circuit'.padEnd(13) + 'scenery'.padStart(8) + 'solid'.padStart(7) +
  'tightest'.padStart(10) + 'worst'.padStart(9) + 'verts'.padStart(8) +
  '  offender'.padEnd(20) + 'barrier on/tight/worst',
);
for (const r of rows) {
  console.log(
    r.id.padEnd(13) +
    String(r.scenery).padStart(8) +
    String(r.solid).padStart(7) +
    (r.tightest === Infinity ? 'n/a' : r.tightest.toFixed(1) + 'm').padStart(10) +
    (r.worst < 0 ? r.worst.toFixed(2) + 'm' : 'clear').padStart(9) +
    String(r.verts).padStart(8) +
    ('  ' + r.source).padEnd(20) +
    `${r.barrier.onRoad}/${r.barrier.tight}/` +
    (r.barrier.worst === Infinity ? 'n/a' : r.barrier.worst.toFixed(2) + 'm'),
  );
}
console.log(
  '\nworst   deepest drawn vertex inside the edge of the racing surface, at a\n' +
  `        height between ${OBSTRUCTION_LOW_M}m (plus the local gradient) and ` +
  `${OBSTRUCTION_HIGH_M}m above the\n        road, or at road level on a vertical face.\n` +
  'barrier drawn barrier nodes standing on / within ' +
  `${BARRIER_ROAD_CLEARANCE_M}m of ANOTHER part of the\n` +
  '        circuit, measured without the lap-distance exclusion that hides fold-backs.\n' +
  'sources paddock, marshal and pit-box are whole builders; inside buildTrackMeshes,\n' +
  '        track-surface = road/kerbs/paint/run-off/pit lane, verge/skirt = the ground\n' +
  '        strip out to the barrier line and the vertical skirt under it,\n' +
  '        barrier/pit-wall = armco, street wall and pit walls, then catch-fence,\n' +
  '        hoardings, gantry, marker-boards, ground and scenery (instanced\n' +
  '        set dressing). Run with PROBE_WORLD_DUMP=<circuit> for every vertex.',
);
if (!pitBoxCovered) console.log('(pit box marker NOT covered — see note above)');
if (detail.length > 0) {
  console.log('\nwhere:');
  for (const d of detail) console.log(d);
}

// ---------------------------------------------------------------------------
// A heavy impact has to end the session
// ---------------------------------------------------------------------------

{
  const def = CIRCUITS.find((c) => c.id === 'monaco')!;
  const config: SessionConfig = {
    kind: 'race',
    name: 'probe',
    durationS: 0,
    laps: 5,
    playerIndex: -1,
    standingStart: false,
    pitLaneStart: false,
    seed: 7,
  };
  const engine = new RaceEngine(def, config);
  // Let the field roll away from the grid, then aim one car squarely at the
  // wall at racing speed.
  for (let i = 0; i < Math.round(4 / PHYSICS_DT); i++) engine.step();

  const car = engine.cars.find((c) => !c.retired)!;
  const idx = engine.track.indexAt(car.s);
  const speed = 55; // ~200 km/h
  car.physics.velocity.set(engine.track.nx[idx] * speed, engine.track.nz[idx] * speed);
  car.physics.heading = Math.atan2(engine.track.nx[idx], engine.track.nz[idx]);
  car.physics.syncLocalVelocity();

  const before = { ...car.damage.health };
  for (let i = 0; i < Math.round(2 / PHYSICS_DT) && !car.retired; i++) engine.step();

  const worst = Math.min(...Object.values(car.damage.health));
  const anyWorse = Object.keys(before).some(
    (k) => car.damage.health[k as keyof typeof car.damage.health] <
      before[k as keyof typeof before] - 0.001,
  );

  console.log(
    `\nheavy impact: retired=${car.retired} reason="${car.retirementReason ?? ''}" ` +
    `worstComponent=${worst.toFixed(2)} (${bandOf(worst)}) damageRecorded=${anyWorse}`,
  );
  if (!car.retired) issues.push({ circuit: 'monaco', detail: 'a 200km/h square hit did not end the session' });
  if (!anyWorse) issues.push({ circuit: 'monaco', detail: 'a 200km/h square hit recorded no damage' });
}

console.log('');
if (issues.length === 0) {
  console.log('PASS — the world is solid and nothing is built on the circuit');
} else {
  console.log('FAILURES:');
  for (const i of issues) console.log(`  - ${i.circuit}: ${i.detail}`);
  process.exitCode = 1;
}
