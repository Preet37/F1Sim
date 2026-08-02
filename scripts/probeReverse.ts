import * as THREE from 'three';
import { CameraDirector, CAMERA_MODES, type CameraMode } from '../src/render/CameraDirector';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * "The backup camera is jittering when I try to back up."
 *
 * Jitter is not a matter of opinion: it is the camera changing direction, at
 * speed, on alternate frames. A camera that is damping into a new position
 * turns steadily — the sign of its angular velocity is constant for the whole
 * move — and one that is oscillating changes that sign several times a second
 * while going nowhere. So this drives the player's car backwards through the
 * real physics, runs the real `CameraDirector` at 60fps over it, and counts
 * REVERSALS: frames where the camera's yaw rate changes sign with meaningful
 * speed on both sides of the change.
 *
 * It also rocks the car through a standstill in both directions, because that
 * is where a threshold on speed does its damage and it is what a player does
 * when they are trying to get out of a gravel trap.
 *
 * Run: npm run probe:reverse
 */

/** How fast the yaw has to be moving either side of a sign change to count. */
const REVERSAL_RATE_DEG = 0.35;
/** Reversals per second above which the camera is oscillating rather than moving. */
const MAX_REVERSALS_PER_S = 2.0;
/**
 * The most the camera may swing in one frame at 60fps, degrees, once the car
 * has SETTLED into a direction of travel.
 *
 * Not during the changeover. Taking up reverse legitimately swings a following
 * camera half a turn round the car, and at a damping rate of 9 that is about
 * ten degrees on the first frame of the move — so a limit that applied through
 * the changeover would either have to be ten, which is far too loose to catch
 * anything, or would fail on a camera move that is supposed to happen. The
 * blackout below is one second either side of every change in the direction the
 * car is travelling, and outside it four degrees a frame is already 240 a
 * second, which is more than any settled camera has business doing.
 */
const MAX_STEP_DEG = 4;
/** How long after a change of travel direction the swing limit is suspended. */
const CHANGEOVER_S = 1.0;

const FRAME_DT = 1 / 60;
const STEPS_PER_FRAME = Math.max(1, Math.round(FRAME_DT / PHYSICS_DT));

const config: SessionConfig = {
  kind: 'race',
  name: 'reverse probe',
  durationS: 0,
  laps: 5,
  playerIndex: 0,
  standingStart: true,
  pitLaneStart: false,
  seed: 11,
};

interface Result {
  mode: CameraMode;
  reversalsPerS: number;
  maxStepDeg: number;
}

/**
 * Yaw of the camera's view direction IN THE CAR'S OWN FRAME, radians.
 *
 * Relative, not absolute, and that is the difference between measuring jitter
 * and measuring the world. A car that has spun is rotating at several hundred
 * degrees a second and a following camera rotates with it — nine degrees a
 * frame of perfectly correct camera work. What a player calls jitter is the
 * camera moving with respect to the CAR, which is this.
 */
function camYaw(cam: THREE.PerspectiveCamera, v: THREE.Vector3, heading: number): number {
  cam.getWorldDirection(v);
  return Math.atan2(v.x, v.z) - heading;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * One manoeuvre: brake to a stop, hold reverse, stop again, pull forward.
 *
 * Deliberately the whole sequence rather than just the reversing part. The
 * camera has to swing round as the car takes up reverse and swing back as it
 * pulls away, and both of those are large, legitimate movements; the fault
 * being looked for is oscillation ON TOP of them, so the probe has to watch
 * through them rather than around them.
 */
function drive(engine: RaceEngine, dirs: Map<CameraMode, CameraDirector>): Map<CameraMode, Result> {
  const car = engine.playerCar!;
  const c = engine.playerControls;
  const last = new Map<CameraMode, { yaw: number; rate: number }>();
  const reversals = new Map<CameraMode, number>();
  const maxStep = new Map<CameraMode, number>();
  const v = new THREE.Vector3();
  const blackouts = new Map<CameraMode, number>();
  for (const m of dirs.keys()) { reversals.set(m, 0); maxStep.set(m, 0); }

  // seconds, what the driver is doing, and how hard they are steering.
  //
  // STEERING IS NOT DECORATION HERE. Backing out of a gravel trap or off a
  // barrier means sawing at the wheel, and the lateral velocity that produces
  // is exactly the quantity a slip-angle term reads. Driven in a straight line
  // the fault below does not appear at all: the first version of this script
  // had no steering in it and reported the camera as clean.
  //
  // A steer of NaN means "saw the wheel", at about two cycles a second, which
  // is what a player does when they are trying to get a car pointing the right
  // way again. It drives the car's lateral velocity through zero repeatedly,
  // and that zero crossing is the thing being hunted: a slip-angle term that is
  // sitting on its clamp flips from one end of it to the other every time.
  const SAW = NaN;
  const script: [number, Partial<typeof c>, number][] = [
    [2.0, { throttle: 0.6, brake: 0, reverse: false }, 0],
    [2.0, { throttle: 0, brake: 1, reverse: false }, 0],
    [4.0, { throttle: 0.7, brake: 0, reverse: true }, SAW],
    [1.5, { throttle: 0, brake: 1, reverse: true }, -0.2],
    [2.5, { throttle: 0.6, brake: 0, reverse: false }, 0.3],
    // And the nasty one: hold reverse throttle against the brake, so the car
    // creeps and stalls repeatedly through zero while being sawed at.
    [4.0, { throttle: 0.35, brake: 0.35, reverse: true }, SAW],
  ];

  let frames = 0;
  for (const [seconds, controls, steer] of script) {
    Object.assign(c, controls);
    for (let f = 0; f < Math.round(seconds / FRAME_DT); f++) {
      c.steer = Number.isNaN(steer)
        ? Math.sin(frames * FRAME_DT * Math.PI * 4) * 0.8
        : steer;
      for (let s = 0; s < STEPS_PER_FRAME; s++) engine.step();
      frames++;

      const ph = car.physics;

      for (const [mode, dir] of dirs) {
        const before = dir.reverseBlend;
        dir.update(FRAME_DT, car, engine.track, engine.world);
        // Is this rig deliberately swinging round the car? Asked of the rig
        // itself, per mode, rather than inferred from the car — see
        // `reverseBlend`. The blackout runs on for a second afterwards because
        // the swing arrives at the camera through the position smoothing and
        // outlasts the blend that caused it.
        const swinging = Math.abs(dir.reverseBlend - before) > 0.002;
        const key = mode;
        if (swinging) blackouts.set(key, CHANGEOVER_S);
        const blackout = Math.max(0, (blackouts.get(key) ?? 0) - FRAME_DT);
        blackouts.set(key, blackout);
        const yaw = camYaw(dir.camera, v, ph.heading);
        const prev = last.get(mode);
        if (prev) {
          const rate = wrap(yaw - prev.yaw);
          const deg = Math.abs(rate) * 180 / Math.PI;
          if (blackout <= 0 && deg > (maxStep.get(mode) ?? 0)) maxStep.set(mode, deg);
          const prevDeg = Math.abs(prev.rate) * 180 / Math.PI;
          if (
            prev.rate * rate < 0 &&
            deg > REVERSAL_RATE_DEG && prevDeg > REVERSAL_RATE_DEG
          ) {
            reversals.set(mode, (reversals.get(mode) ?? 0) + 1);
          }
          last.set(mode, { yaw, rate });
        } else {
          last.set(mode, { yaw, rate: 0 });
        }
      }
    }
  }

  const seconds = frames * FRAME_DT;
  const out = new Map<CameraMode, Result>();
  for (const mode of dirs.keys()) {
    out.set(mode, {
      mode,
      reversalsPerS: (reversals.get(mode) ?? 0) / seconds,
      maxStepDeg: maxStep.get(mode) ?? 0,
    });
  }
  return out;
}

const failures: string[] = [];

console.log(
  'Reversing, on every circuit, through the real physics and the real camera rig.\n' +
  'A camera that is damping turns steadily; one that is oscillating changes the\n' +
  'sign of its yaw rate several times a second while going nowhere.\n',
);
console.log(
  'circuit'.padEnd(13) +
  CAMERA_MODES.map((m) => m.padStart(12)).join('') + '   (reversals/s)',
);

for (const def of CIRCUITS) {
  const engine = new RaceEngine(def, config);
  // Off the line and up to a working speed before anything is measured.
  for (let i = 0; i < Math.round(6 / PHYSICS_DT); i++) {
    engine.playerControls.throttle = 0.8;
    engine.step();
  }
  const dirs = new Map<CameraMode, CameraDirector>();
  for (const m of CAMERA_MODES) {
    const d = new CameraDirector(16 / 9);
    d.setMode(m);
    dirs.set(m, d);
  }
  const res = drive(engine, dirs);

  const cells: string[] = [];
  for (const m of CAMERA_MODES) {
    const r = res.get(m)!;
    // The trackside camera is EXEMPT from the swing limit, and only from that
    // one. It is a row of fixed cameras that hand the car over to each other,
    // so a 150-degree change in one frame is a CUT — the thing that camera
    // exists to do — and not a jitter. Its reversal count is still checked,
    // because a camera that is cutting back and forth is a fault in any mode.
    const cuts = m === 'trackside';
    const bad = r.reversalsPerS > MAX_REVERSALS_PER_S || (!cuts && r.maxStepDeg > MAX_STEP_DEG);
    cells.push(`${r.reversalsPerS.toFixed(1)}/${r.maxStepDeg.toFixed(0)}${bad ? '*' : ' '}`.padStart(12));
    if (r.reversalsPerS > MAX_REVERSALS_PER_S) {
      failures.push(
        `${def.id} ${m}: the camera changes direction ${r.reversalsPerS.toFixed(1)} times a ` +
        `second while the car is reversing`,
      );
    }
    if (!cuts && r.maxStepDeg > MAX_STEP_DEG) {
      failures.push(
        `${def.id} ${m}: the camera swings ${r.maxStepDeg.toFixed(0)} degrees in one frame`,
      );
    }
  }
  console.log(def.id.padEnd(13) + cells.join(''));
}

console.log('\n  cell = reversals per second / worst single-frame swing in degrees\n');
if (failures.length === 0) {
  console.log('PASS — no camera oscillates while the car is reversing');
} else {
  console.log(`FAILURES (${failures.length}):`);
  const seen = new Set<string>();
  for (const f of failures) {
    const key = f.slice(f.indexOf(' '));
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  - ${f}`);
  }
  process.exitCode = 1;
}
