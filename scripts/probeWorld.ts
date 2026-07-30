import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { TrackSpline } from '../src/track/TrackSpline';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { buildWorldModel, buildKeepOutField, footprintOf, KeepOutField } from '../src/track/WorldObstacles';
import { PHYSICS_DT } from '../src/core/SimClock';
import { bandOf } from '../src/race/DamageModel';

/**
 * Checks that the world is a place rather than a backdrop.
 *
 * Two questions, both of which were answered "no" by the game as shipped:
 *
 *  1. Is every piece of scenery actually beside the circuit? Set dressing was
 *     placed at an offset from whichever node it was generated at, and a lap
 *     folds back on itself, so buildings routinely ended up standing on the
 *     road somewhere else — at Monaco with the player's car inside one.
 *  2. Is any of it solid? Nothing outside the track's own lateral limit was,
 *     so a car drove through buildings, grandstands and the pit wall without
 *     touching them.
 *
 * The clearance test here is deliberately stricter than "does not overlap": a
 * building has to be clear of the racing surface by enough that a car pinned
 * against the barrier still cannot reach it, because a wall the driver can see
 * through the windscreen but never touch is the same bug in a nicer disguise.
 */

interface Issue {
  circuit: string;
  detail: string;
}

const issues: Issue[] = [];

/** Distance a car's outermost collision disc reaches beyond the barrier line. */
const CAR_REACH_M = 1.0;

for (const def of CIRCUITS) {
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const keepOut = buildKeepOutField(track);
  const runoff = def.scenery === 'street' ? 2.5 : 14;

  // --- 1. Nothing is built on the road ------------------------------------
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
  // The pit wall and the walls down the entry and exit roads are now real
  // objects a car bounces off, so a metre of one of them poking through the
  // track edge is no longer a cosmetic problem — it is a wall in the middle of
  // the road that every car on the lead lap drives into.
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

  console.log(
    def.id.padEnd(13) +
    `scenery=${String(world.scenery.length).padStart(4)}  ` +
    `solid=${String(world.obstacles.obstacles.length).padStart(4)}  ` +
    `tightest=${worstMargin === Infinity ? 'n/a' : worstMargin.toFixed(1) + 'm'}`,
  );
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
