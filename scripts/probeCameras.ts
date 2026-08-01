import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CameraDirector, CAMERA_MODES, type CameraMode } from '../src/render/CameraDirector';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import type { Obstacle } from '../src/track/WorldObstacles';

/**
 * Does any camera end up inside the world?
 *
 * The report that produced this was specific: at Spa the drone camera fills the
 * frame with blue geometry, apparently from inside a building. It is worth
 * saying what that blue is — the paddock's glazing is 0x1e3947, a dark blue,
 * and it is the largest continuous surface on the inside of the pit building.
 *
 * The camera rig has no knowledge of the world. The drone orbits the car at a
 * fixed 10.5m radius and 4.6m up, the chase camera sits at a fixed distance
 * behind, the trackside camera picks an anchor beside the road — and none of
 * them asks whether the place they have chosen is inside something. Down a pit
 * straight, 10.5m to the side of a car is inside the pit wall and then inside
 * the garages; at a hairpin it is through the barrier on the outside.
 *
 * That was invisible until the world became solid. Buildings, grandstands and
 * the barrier line are all real collision geometry now, so "the camera is
 * inside an object" is a question with an exact answer, and this asks it: every
 * camera mode, driven by the real `CameraDirector`, on all eleven circuits, for
 * ninety seconds of racing each.
 *
 * This probe measures; it does not fix. The fix belongs in `CameraDirector`,
 * and the material for it is already in `engine.world.obstacles` — the same
 * broadphase the cars collide against, which answers "what is at this point"
 * in a few microseconds. A camera that finds itself inside something should be
 * drawn in toward the car until it is not.
 */

interface Hit {
  mode: CameraMode;
  /** How far inside the object the camera got, metres. */
  depth: number;
  kind: string;
  s: number;
}

/**
 * Signed distance from a point to an oriented box, in plan. Negative inside.
 *
 * Plan only, and that is the honest scope: the obstacle model is a set of
 * extruded boxes with no height on them, because a car has no height either.
 * A camera 4.6m up that is inside a building's footprint is inside the building
 * — every structure in this world is taller than that — but a camera inside a
 * BARRIER's footprint at 4.6m is over the top of it and sees fine. Barrier and
 * pit-wall hits are therefore reported separately below.
 */
function planDepth(o: Obstacle, x: number, z: number): number {
  const dx = o.x - x;
  const dz = o.z - z;
  const lx = Math.abs(dx * o.cos - dz * o.sin) - o.halfX;
  const lz = Math.abs(dx * o.sin + dz * o.cos) - o.halfZ;
  return Math.max(lx, lz);
}

/** Height of each obstacle kind, metres — what the plan box actually stands for. */
const HEIGHT: Record<string, number> = {
  building: 40,
  grandstand: 14,
  barrier: 1.5,
  pitwall: 1.4,
};

const config: SessionConfig = {
  kind: 'race',
  name: 'camera probe',
  durationS: 0,
  laps: 5,
  playerIndex: -1,
  standingStart: false,
  pitLaneStart: false,
  seed: 11,
};

/** Seconds of racing each mode is followed for. */
const WATCH_S = 90;
/** How far below the road a camera may dip before it counts as underground. */
const UNDERGROUND_M = 1.5;

const scratch: number[] = [];
const failures: string[] = [];

console.log('Every camera mode, on every circuit, checked against the solid world.\n');
console.log(
  'circuit'.padEnd(14) + 'mode'.padEnd(12) + 'inside'.padEnd(12) +
  'depth'.padStart(8) + '  at',
);

for (const def of CIRCUITS) {
  const engine = new RaceEngine(def, config);
  // Away from the grid and up to racing speed.
  for (let i = 0; i < Math.round(20 / PHYSICS_DT); i++) engine.step();
  const car = engine.cars[0];

  const hits: Hit[] = [];
  let underground = 0;

  for (const mode of CAMERA_MODES) {
    const dir = new CameraDirector(16 / 9);
    dir.setMode(mode);
    let worst: Hit | null = null;

    for (let step = 0; step < Math.round(WATCH_S / PHYSICS_DT); step++) {
      engine.step();
      // 15Hz. Finer than it needs to be for a camera that damps into place
      // over tenths of a second, and cheap — but not so coarse that a clip
      // lasting half a second falls between two samples, which at 6Hz it did.
      if (step % 8 !== 0) continue;
      dir.update(1 / 60, car, engine.track, engine.world);
      const p = dir.camera.position;

      const roadY = engine.track.elevation[engine.track.indexAt(car.s)];
      if (p.y < roadY - UNDERGROUND_M) underground++;

      engine.world.obstacles.query(p.x, p.z, 1, scratch);
      for (const i of scratch) {
        const o = engine.world.obstacles.obstacles[i];
        // Over the top of it is not inside it.
        if (p.y - roadY > (HEIGHT[o.kind] ?? 3)) continue;
        const d = planDepth(o, p.x, p.z);
        if (d < 0 && (!worst || d < worst.depth)) {
          worst = { mode, depth: d, kind: o.kind, s: car.s };
        }
      }
    }
    if (worst) hits.push(worst);
  }

  if (hits.length === 0 && underground === 0) {
    console.log(def.id.padEnd(14) + 'clear');
    continue;
  }
  for (const h of hits) {
    console.log(
      def.id.padEnd(14) + h.mode.padEnd(12) + h.kind.padEnd(12) +
      `${(-h.depth).toFixed(1)}m`.padStart(8) + `  s=${h.s.toFixed(0)}m`,
    );
    failures.push(
      `${def.id}: the ${h.mode} camera goes ${(-h.depth).toFixed(1)}m inside a ` +
      `${h.kind} at s=${h.s.toFixed(0)}m`,
    );
  }
  if (underground > 0) {
    console.log(def.id.padEnd(14) + `${underground} samples below the road surface`);
    failures.push(`${def.id}: a camera went underground on ${underground} samples`);
  }
}

console.log('');
if (failures.length === 0) {
  console.log('PASS — no camera ends up inside the world on any circuit');
} else {
  console.log('FAILURES — the camera rig does not know the world is solid:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log(
    '\nThe fix is in CameraDirector, not in the geometry: the objects being\n' +
    'clipped are legitimately where they are. `engine.world.obstacles` already\n' +
    'answers "what is at this point"; a camera that lands inside something\n' +
    'should be drawn in toward the car until it does not.',
  );
  process.exitCode = 1;
}
