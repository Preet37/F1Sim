import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';
import { PHYSICS_DT } from '../src/core/SimClock';
import { pitLaneGeometry } from '../src/track/PitGeometry';
import type { Obstacle } from '../src/track/WorldObstacles';
import type { CarEntry } from '../src/race/CarEntry';
import type { TrackSpline } from '../src/track/TrackSpline';

/**
 * Hunts for the class of bug that makes the simulation untrustworthy.
 *
 * The question this has to answer is "can a car end up on the wrong side of
 * something solid", and the previous version of this file could not answer it.
 * It reported a clean zero-metre overshoot on all eleven circuits while the
 * player was demonstrably parked behind an armco and a catch fence at
 * Silverstone, looking at the track through them. It was wrong in four ways at
 * once, and all four are worth naming because they are easy mistakes to make
 * again:
 *
 *  1. It only watched AI cars in a headless qualifying session. The AI does not
 *     drive at walls; a player does, and the bug only appears when something
 *     goes off deliberately and hard.
 *  2. It skipped any car with `inPitLane` set, so a car with a stuck pit flag
 *     was invisible to exactly the check meant to catch stuck cars.
 *  3. It measured containment as `|lateral| - (halfWidth + runoff)` — a
 *     SPLINE-RELATIVE quantity, using the same constant the containment code
 *     uses. A test written against the implementation's own model cannot see a
 *     bug in that model. And the bug WAS in that model: `lateral` is measured
 *     against the nearest spline node, and where a circuit folds back on itself
 *     the nearest node belongs to a different part of the lap, so a car sitting
 *     in the corridor between two barriers has a perfectly small lateral offset
 *     and reports zero overshoot.
 *  4. It only measured lateral distance, so any escape that was not lateral —
 *     past the pit wall, past the end of a barrier run, through a gap where the
 *     spline doubles back — did not register at all.
 *
 * What replaces it is a world-space test with no knowledge of how containment
 * is implemented: from wherever the car is, can it see any drivable ground
 * without a solid surface in the way? If it cannot, it is behind something it
 * should never have got behind. It also watches every step for the car's own
 * path crossing a solid surface, which catches a car passing THROUGH a wall
 * even if it ends up somewhere legal.
 *
 * And it drives adversarially: the player's car, full throttle into the
 * barrier at a spread of angles and speeds, at points all the way round every
 * circuit, plus the same from inside the pit lane.
 */

const SESSION_SECONDS = 220;
const STEPS_PER_SECOND = Math.round(1 / PHYSICS_DT);

/** Attack points round the lap for the adversarial run. */
const ATTACK_POINTS = 14;
/** Steering angles, as a fraction of full lock, tried at each point. */
const ATTACK_STEERS = [1, -1, 0.45] as const;
/** Entry speeds, m/s. */
const ATTACK_SPEEDS = [72, 38] as const;
/**
 * Entry speeds for the runs that start in the pit lane, m/s.
 *
 * Lower on purpose, and not a way of ducking the check. The pit lane is
 * speed-limited to 80 km/h and physically cannot be entered above about 130;
 * 110 km/h down the lane with the wheel on full lock is already far outside
 * anything the game can produce. Firing a car down it at 260 km/h tests the
 * behaviour of a teleport, not of a wall.
 */
const PIT_ATTACK_SPEEDS = [30, 15] as const;
/** How long each attack runs. */
const ATTACK_SECONDS = 3.2;

interface Issue {
  circuit: string;
  kind: string;
  detail: string;
}

const issues: Issue[] = [];

// ---------------------------------------------------------------------------
// World-space geometry
// ---------------------------------------------------------------------------

interface Seg { ax: number; az: number; bx: number; bz: number }

/** The four edges of an obstacle's footprint, as line segments. */
function edgesOf(o: Obstacle): Seg[] {
  // Local +X is (cos, -sin), local +Z is (sin, cos).
  const ux = o.cos * o.halfX;
  const uz = -o.sin * o.halfX;
  const vx = o.sin * o.halfZ;
  const vz = o.cos * o.halfZ;
  const c = [
    [o.x - ux - vx, o.z - uz - vz],
    [o.x + ux - vx, o.z + uz - vz],
    [o.x + ux + vx, o.z + uz + vz],
    [o.x - ux + vx, o.z - uz + vz],
  ];
  const out: Seg[] = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    out.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1] });
  }
  return out;
}

/** Do two segments cross? Standard orientation test. */
function crosses(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * A coarse grid over the solid segments, so a line-of-sight test does not have
 * to walk several thousand of them.
 */
class SegmentGrid {
  private static readonly CELL = 24;
  private readonly bins = new Map<number, number[]>();
  constructor(readonly segs: Seg[]) {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const g0x = Math.floor(Math.min(s.ax, s.bx) / SegmentGrid.CELL);
      const g1x = Math.floor(Math.max(s.ax, s.bx) / SegmentGrid.CELL);
      const g0z = Math.floor(Math.min(s.az, s.bz) / SegmentGrid.CELL);
      const g1z = Math.floor(Math.max(s.az, s.bz) / SegmentGrid.CELL);
      for (let gx = g0x; gx <= g1x; gx++) {
        for (let gz = g0z; gz <= g1z; gz++) {
          const k = SegmentGrid.key(gx, gz);
          const bin = this.bins.get(k);
          if (bin) bin.push(i);
          else this.bins.set(k, [i]);
        }
      }
    }
  }
  private static key(gx: number, gz: number): number {
    return (gx * 73856093) ^ (gz * 19349663);
  }
  /** True when the segment (ax,az)-(bx,bz) crosses any solid surface. */
  blocked(ax: number, az: number, bx: number, bz: number): boolean {
    const c = SegmentGrid.CELL;
    const g0x = Math.floor(Math.min(ax, bx) / c);
    const g1x = Math.floor(Math.max(ax, bx) / c);
    const g0z = Math.floor(Math.min(az, bz) / c);
    const g1z = Math.floor(Math.max(az, bz) / c);
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const bin = this.bins.get(SegmentGrid.key(gx, gz));
        if (!bin) continue;
        for (const i of bin) {
          const s = this.segs[i];
          if (crosses(ax, az, bx, bz, s.ax, s.az, s.bx, s.bz)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * The nearest point of drivable ground to a world position, and whether it can
 * be reached in a straight line without passing through anything solid.
 */
function makeContainmentTest(engine: RaceEngine) {
  const track: TrackSpline = engine.track;
  const solid: Seg[] = [];
  for (const o of engine.world.obstacles.obstacles) solid.push(...edgesOf(o));
  const grid = new SegmentGrid(solid);

  // Pit-lane centreline samples, so a car legitimately in the lane is judged
  // against the lane and not against the circuit on the far side of the wall.
  const g = pitLaneGeometry(track.def, track.length);
  const lane: { x: number; z: number }[] = [];
  for (let u = 0; u <= g.totalU; u += 4) {
    const i = track.indexAt(g.splitS + u);
    const e = g.edgesAt(u, track.width[i] * 0.5);
    const lat = g.sign * (e.inner + e.outer) * 0.5;
    lane.push({ x: track.px[i] + track.nx[i] * lat, z: track.pz[i] + track.nz[i] * lat });
  }

  /** Nearest point on the racing surface, by a full global scan. */
  const roadTarget = (x: number, z: number): { x: number; z: number; d: number } => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < track.count; i++) {
      const dx = track.px[i] - x;
      const dz = track.pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    const dx = x - track.px[bi];
    const dz = z - track.pz[bi];
    const hw = track.width[bi] * 0.5 - 0.6;
    let lat = dx * track.nx[bi] + dz * track.nz[bi];
    lat = Math.max(-hw, Math.min(hw, lat));
    const tx = track.px[bi] + track.nx[bi] * lat;
    const tz = track.pz[bi] + track.nz[bi] * lat;
    return { x: tx, z: tz, d: Math.hypot(x - tx, z - tz) };
  };

  const laneTarget = (x: number, z: number): { x: number; z: number; d: number } => {
    let best = lane[0];
    let bd = Infinity;
    for (const p of lane) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return { x: best.x, z: best.z, d: Math.sqrt(bd) };
  };

  return {
    grid,
    /**
     * True when there is something solid between this position and every piece
     * of ground a car is allowed to be on.
     */
    offside(x: number, z: number): { bad: boolean; distance: number } {
      const road = roadTarget(x, z);
      if (road.d < 1.0) return { bad: false, distance: road.d };
      if (!grid.blocked(x, z, road.x, road.z)) return { bad: false, distance: road.d };
      const pit = laneTarget(x, z);
      if (pit.d < 1.0) return { bad: false, distance: pit.d };
      if (!grid.blocked(x, z, pit.x, pit.z)) return { bad: false, distance: pit.d };
      return { bad: true, distance: Math.min(road.d, pit.d) };
    },
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** A compact field: the adversarial run does not need twenty cars. */
const ATTACK_FIELD = DRIVERS.slice(0, 6);

for (const def of CIRCUITS) {
  // =========================================================================
  // 1. A full AI session: nothing non-finite, no impossible times.
  // =========================================================================
  const config: SessionConfig = {
    kind: 'qualifying',
    name: 'probe',
    durationS: SESSION_SECONDS,
    laps: 0,
    playerIndex: -1,
    standingStart: false,
    pitLaneStart: true,
    seed: 20260730,
  };
  const engine = new RaceEngine(def, config);
  const contain = makeContainmentTest(engine);

  // =========================================================================
  // 0. Is the world itself a trap?
  // =========================================================================
  //
  // Before asking whether a car can get somewhere it should not, ask whether
  // the ground a car is ALLOWED to be on is enclosed correctly. Every point
  // inside the containment envelope — the road, the kerbs, the run-off out to
  // the barrier line — has to be able to see the racing surface without a wall
  // in the way. If it cannot, the car does not have to escape anything: it is
  // driving legally into a place that has an armco and a debris fence between
  // it and the circuit, and the screenshot looks identical either way.
  //
  // This is a purely geometric check with no simulation in it at all, and it
  // is the one that catches a barrier laid across another part of the lap.
  // The envelope stops a metre short of the barrier line on each side, since a
  // point ON the wall is trivially "behind" it. Everything strictly inside has
  // to have a clear view out.
  let trapped = 0;
  let sampled = 0;
  let trappedWorst = 0;
  let trappedAt = '';
  for (let i = 0; i < engine.track.count; i += 2) {
    const hw = engine.track.width[i] * 0.5;
    const offL = engine.world.barrierOffsets.left[i];
    const offR = engine.world.barrierOffsets.right[i];
    const hi = offL > 0 ? hw + offL - 1 : hw - 1;
    const lo = offR > 0 ? -(hw + offR - 1) : -(hw - 1);
    for (let lat = lo; lat <= hi; lat += 1.5) {
      const x = engine.track.px[i] + engine.track.nx[i] * lat;
      const z = engine.track.pz[i] + engine.track.nz[i] * lat;
      sampled++;
      const r = contain.offside(x, z);
      if (!r.bad) continue;
      trapped++;
      if (Math.abs(lat) > trappedWorst) {
        trappedWorst = Math.abs(lat);
        trappedAt = `s=${engine.track.dist[i].toFixed(0)}m lateral=${lat.toFixed(1)}m`;
      }
    }
  }
  // A tolerance, not a free pass.
  //
  // Where two sections of circuit run twenty metres apart, one section's
  // barrier legitimately stands in the other's run-off and the far corner of
  // that run-off is enclosed. That pocket is real, and it is also UNREACHABLE:
  // the barrier chain is closed and solid, so a car cannot get into it without
  // passing through a wall, which the `tunnelled` and `offside` checks below
  // assert it never does. What matters is the SCALE. Before the barrier line
  // was made clearance-aware this ran at 2-7% of the envelope on every circuit
  // — hundreds of square metres of run-off walled off from the road, which is
  // exactly the strip the player's car was found parked on. Anything above
  // half a percent means the barrier is being laid across the circuit again.
  const trappedFraction = sampled > 0 ? trapped / sampled : 0;
  if (trappedFraction > 0.005) {
    issues.push({
      circuit: def.id, kind: 'walled-in',
      detail: `${(trappedFraction * 100).toFixed(2)}% of the containment envelope ` +
        `(${trapped} points) has a solid surface between it and the circuit ` +
        `(worst ${trappedAt})`,
    });
  }

  let nonFinite = 0;
  let worstOffside = 0;
  let offsideCar = '';

  for (let t = 0; t < SESSION_SECONDS; t++) {
    for (let i = 0; i < STEPS_PER_SECOND; i++) engine.step();

    for (const car of engine.cars) {
      const p = car.physics;
      if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y) ||
          !Number.isFinite(p.velocity.x) || !Number.isFinite(car.s)) {
        nonFinite++;
        continue;
      }
      // Every car, retired or not, in the pit lane or not. A car that has been
      // written off against a wall is still supposed to be on the correct side
      // of it, and a stuck pit flag must not be able to hide anything.
      const r = contain.offside(p.position.x, p.position.y);
      if (r.bad && r.distance > worstOffside) {
        worstOffside = r.distance;
        offsideCar = car.driver.code;
      }
    }
  }

  if (nonFinite > 0) {
    issues.push({ circuit: def.id, kind: 'non-finite', detail: `${nonFinite} non-finite car states` });
  }
  if (worstOffside > 0) {
    issues.push({
      circuit: def.id, kind: 'offside',
      detail: `${offsideCar} came to rest behind a solid surface, ${worstOffside.toFixed(0)}m from any road`,
    });
  }

  const reference = engine.track.referenceLapTime;
  for (const car of engine.cars) {
    for (let i = 0; i < 3; i++) {
      const st = car.bestSectors[i];
      if (st > 0 && st < 1) {
        issues.push({
          circuit: def.id, kind: 'sector',
          detail: `${car.driver.code} S${i + 1} = ${st.toFixed(3)}s`,
        });
      }
    }
    if (car.bestLapTime > 0 && car.bestLapTime < reference * 0.75) {
      issues.push({
        circuit: def.id, kind: 'lap',
        detail: `${car.driver.code} lap ${car.bestLapTime.toFixed(2)}s vs reference ${reference.toFixed(2)}s`,
      });
    }
  }
  const laps = engine.cars.filter((c) => c.bestLapTime > 0).length;

  // =========================================================================
  // 2. Adversarial: the PLAYER, driving at the wall on purpose.
  // =========================================================================
  const attack = new RaceEngine(def, {
    kind: 'practice',
    name: 'attack',
    durationS: 100000,
    laps: 0,
    playerIndex: 0,
    standingStart: false,
    pitLaneStart: false,
    seed: 4242,
  }, ATTACK_FIELD);
  const atk = makeContainmentTest(attack);
  const player: CarEntry = attack.playerCar!;

  // Put the rest of the field somewhere it cannot interfere with the samples.
  for (const car of attack.cars) {
    if (car !== player) car.retire('parked for the probe', 0);
  }
  attack.started = true;

  let attackWorst = 0;
  let attackDetail = '';
  let tunnelled = 0;
  const attackSteps = Math.round(ATTACK_SECONDS / PHYSICS_DT);

  for (let k = 0; k < ATTACK_POINTS; k++) {
    const s0 = (k / ATTACK_POINTS) * attack.track.length;
    for (const steer of ATTACK_STEERS) {
      for (let v = 0; v < ATTACK_SPEEDS.length; v++) {
        for (const lane of [0, 1] as const) {
          const speed = lane === 1 ? PIT_ATTACK_SPEEDS[v] : ATTACK_SPEEDS[v];
          const idx = attack.track.indexAt(s0);
          const heading = Math.atan2(attack.track.tx[idx], attack.track.tz[idx]);
          const inPit = lane === 1;
          // Only start in the lane where the lane actually is. Dropping a car
          // at the nominal pit offset anywhere else on a street circuit spawns
          // it on the far side of the wall, which is a bug in the test rather
          // than in the game.
          const pg = pitLaneGeometry(def, attack.track.length);
          const u = pg.u(s0);
          if (inPit && u > pg.exitU) continue;
          const e = pg.edgesAt(u, attack.track.width[idx] * 0.5);
          const lat = inPit ? pg.sign * (e.inner + e.outer) * 0.5 : 0;

          player.retired = false;
          player.finished = false;
          player.inPitLane = inPit;
          player.inPitBox = false;
          player.stuckTimer = 0;
          player.recoveryTimer = 0;
          player.damage.repair();
          player.physics.spec = player.physics.baseSpec;
          player.physics.position.set(
            attack.track.px[idx] + attack.track.nx[idx] * lat,
            attack.track.pz[idx] + attack.track.nz[idx] * lat,
          );
          player.physics.heading = heading;
          player.physics.yawRate = 0;
          player.physics.velocity.set(
            Math.sin(heading) * speed, Math.cos(heading) * speed,
          );
          player.physics.syncLocalVelocity();
          player.projection.index = idx;
          player.updateProjection(attack.track);

          attack.playerControls.throttle = 1;
          attack.playerControls.brake = 0;
          attack.playerControls.steer = steer;
          attack.playerControls.reverse = false;
          attack.playerControls.pitLimiter = false;

          let px = player.physics.position.x;
          let pz = player.physics.position.y;
          for (let step = 0; step < attackSteps; step++) {
            attack.step();
            const x = player.physics.position.x;
            const z = player.physics.position.y;
            if (!Number.isFinite(x) || !Number.isFinite(z)) { nonFinite++; break; }

            // Did the car's own path pass through something solid?
            if (atk.grid.blocked(px, pz, x, z)) tunnelled++;
            px = x;
            pz = z;

            const r = atk.offside(x, z);
            if (r.bad && r.distance > attackWorst) {
              attackWorst = r.distance;
              attackDetail =
                `s=${s0.toFixed(0)}m steer=${steer} v=${speed}m/s ` +
                `${inPit ? 'from the pit lane' : 'from the track'}`;
            }
          }
        }
      }
    }
  }

  if (attackWorst > 0) {
    issues.push({
      circuit: def.id, kind: 'escaped',
      detail: `player got behind a solid surface (${attackWorst.toFixed(0)}m from any road) — ${attackDetail}`,
    });
  }
  if (tunnelled > 0) {
    issues.push({
      circuit: def.id, kind: 'tunnelled',
      detail: `${tunnelled} steps in which the car's path crossed a solid surface`,
    });
  }

  const flag = attackWorst > 0 || worstOffside > 0 || tunnelled > 0 ||
    trappedFraction > 0.005 ? '  *** FAIL ***' : '';
  console.log(
    `${def.id.padEnd(13)} lapsSet=${String(laps).padStart(2)}/20  ` +
    `walledIn=${(trappedFraction * 100).toFixed(2)}%  ` +
    `aiOffside=${worstOffside.toFixed(1)}m  ` +
    `playerOffside=${attackWorst.toFixed(1)}m  ` +
    `throughWalls=${tunnelled}${flag}`,
  );
}

console.log('');
if (issues.length === 0) {
  console.log('PASS — no integrity failures');
  process.exit(0);
}
const byKind = new Map<string, Issue[]>();
for (const i of issues) {
  if (!byKind.has(i.kind)) byKind.set(i.kind, []);
  byKind.get(i.kind)!.push(i);
}
for (const [kind, list] of byKind) {
  console.log(`${kind.toUpperCase()} (${list.length}):`);
  for (const i of list.slice(0, 6)) console.log(`  ${i.circuit}: ${i.detail}`);
  if (list.length > 6) console.log(`  ... and ${list.length - 6} more`);
}
process.exit(1);
