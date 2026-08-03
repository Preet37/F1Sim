/**
 * A pit stop, photographed.
 *
 * The pit lane was the one part of the world the circuit sweep never looked at.
 * Every shot it takes is of a car on the racing line, and the pit lane is
 * behind a wall on the other side of it — so the twenty painted boxes, the
 * garages, the crew and the release light have only ever been judged by reading
 * the code that builds them. That is how a hundred and ten people ended up
 * standing in fixed working poses at ten empty garages for the whole of every
 * race without anybody seeing it.
 *
 * `pitSetup` drives a car into its own box and leaves it there mid-stop,
 * `pitAdvance` walks the choreography, and `shootPit` looks at it from the
 * angles that matter: over the top, from the driver's seat, from up the lane
 * where a driver first has to pick their box out, and from across the pit wall
 * where the television camera is.
 *
 * A separate file from `audit.ts` because it is a separate sweep with its own
 * script, and because `audit.ts` is a thousand lines of somebody else's camera
 * work that this has no business being tangled into.
 */

import * as THREE from 'three';
import type { Renderer } from '../src/render/Renderer';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { loopDelta } from '../src/core/MathUtils';
import { PIT_CREW_SIZE } from '../src/race/PitStopChoreography';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';

/** Where the pit camera stands. */
export type PitView = 'overhead' | 'driver' | 'lane' | 'wall' | 'front';

export const PIT_VIEWS: readonly PitView[] = ['overhead', 'driver', 'lane', 'wall', 'front'];

export interface PitHarness {
  /** Loads a session and puts the player's car in its own box, mid-stop. */
  setup(circuitId: string): Promise<{ stationaryS: number; crew: number; reachedBox: boolean }>;
  /** Advances the stop by `seconds`. Returns seconds elapsed in the box. */
  advance(seconds: number): Promise<number>;
  /** Photographs the box from a named station. */
  shoot(view: PitView): Promise<string>;
  views: readonly PitView[];
}

/**
 * Builds the harness against an existing renderer.
 *
 * The renderer, the free camera and the frame/present/shoot plumbing all belong
 * to `audit.ts`; they are passed in rather than duplicated, so a pit shot goes
 * through exactly the same post chain, tone map and sharpen pass as every other
 * shot in the project. A viewer that builds its own scene proves nothing.
 */
export function buildPitHarness(deps: {
  renderer: Renderer;
  freeCam: THREE.PerspectiveCamera;
  /** Renders one game frame for the current session. */
  frame(): void;
  /** Waits for the browser to present. */
  present(): Promise<void>;
  /** Draws through the free camera and reads the canvas back. */
  drawAndShoot(draw: () => void): string;
  renderFree(): void;
  /** Hands the newly built session back to the harness. */
  adopt(engine: RaceEngine, focus: CarEntry): void;
  current(): { engine: RaceEngine | null; focus: CarEntry | null };
}): PitHarness {
  return {
    views: PIT_VIEWS,

    async setup(circuitId: string) {
      const def = getCircuit(circuitId);
      const config: SessionConfig = {
        kind: 'race', name: 'pit audit', durationS: 0, laps: 8,
        playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 24601,
      };
      const engine = new RaceEngine(def, config);
      const player = engine.cars[0];
      deps.adopt(engine, player);
      deps.renderer.loadSession(engine, player);

      const track = engine.track;
      const pit = def.pitLane;
      // Everyone else stays out of the way: this is a photograph of one box.
      for (const car of engine.cars) if (car !== player) car.eliminated = true;

      // Driven in, not teleported in. `inPitLane` is set by taking the entry,
      // and a car that never took it is not in a pit stop — it is a car parked
      // on some paint, with no crew, no light and no clock.
      //
      // The run to the entry is driven by the game's own AI, exactly as
      // `probe:pitstop` does it and for the same reason: a hand-written
      // controller cannot get a Formula 1 car round the last corner before the
      // pit entry, and the first attempt at one put the car in the barrier at
      // every circuit. Inside the lane the AI hands over to a plain stopping
      // controller, because stopping on the marks is the thing being
      // photographed and it has to be commanded.
      const startS = (pit.entryS - 900 + track.length) % track.length;
      const i0 = track.indexAt(startS);
      const side = Math.sign(pit.lateralOffsetM) || -1;
      player.placeOnTrack(track, startS, track.lineOffset[i0], track.targetSpeed[i0]);
      engine.requestPit(player, true);

      const ai = new AIVehicleController(player.driver, track, 991, 'hard');
      const view: AIPerception = { ...player.perception };
      const c = engine.playerControls;
      let reachedBox = false;
      let handedOver = false;

      for (let i = 0; i < Math.round(180 / PHYSICS_DT); i++) {
        if (player.inPitLane && !handedOver) {
          handedOver = true;
          // The AI's pit-exit state drives a lane properly — hold the offset,
          // stay on the limiter — where its approach state would fight the
          // scripted stop below.
          ai.onPitStopComplete();
        }
        Object.assign(view, player.perception);
        view.pitThisLap = false;
        const a = ai.update(PHYSICS_DT, player.physics, player.s, player.lateral, view);
        c.throttle = a.throttle;
        c.brake = a.brake;
        c.steer = a.steer;
        c.reverse = a.reverse;
        c.gearRequest = a.gearRequest;
        c.ersMode = a.ersMode;
        c.drsRequested = a.drsRequested;
        c.pitLimiter = false;

        if (!player.inPitLane) {
          // Move over to the pit side on the run in. A car has to be on the pit
          // side of the road to be let in; the AI declines to do it because the
          // pit side is the outside of some of the corners leading to the
          // entry, so it is supplied here.
          const toEntry = loopDelta(player.s, pit.entryS, track.length);
          if (toEntry >= 0 && toEntry < 300) {
            const want = side * track.halfWidthAt(player.s) * 0.5;
            c.steer = Math.max(-1, Math.min(1, c.steer - (want - player.lateral) * 0.05));
          }
        } else {
          const raw = loopDelta(player.s, player.pitBoxS, track.length);
          const d = raw > track.length * 0.5 ? raw - track.length : raw;
          const v = player.physics.speedMs;
          const want = Math.min(24, Math.sqrt(2 * 4 * Math.max(d, 0)));
          c.throttle = v < want - 0.3 ? 0.35 : 0;
          c.brake = d <= 0.1 ? 1 : v > want + 0.3 ? Math.min(1, (v - want) / 3) : 0;
        }

        engine.step();
        if (player.retired) break;
        if (player.inPitBox) { reachedBox = true; break; }
      }
      for (let i = 0; i < 4; i++) { deps.frame(); await deps.present(); }

      const stop = engine.pitStopOf(player);
      return {
        stationaryS: stop.result ? stop.result.stationaryS : 0,
        crew: PIT_CREW_SIZE,
        reachedBox,
      };
    },

    async advance(seconds: number) {
      const { engine, focus } = deps.current();
      if (!engine || !focus) throw new Error('no session');
      const steps = Math.max(0, Math.round(seconds / PHYSICS_DT));
      for (let i = 0; i < steps; i++) engine.step();
      for (let i = 0; i < 3; i++) { deps.frame(); await deps.present(); }
      return engine.pitStopOf(focus).elapsedS;
    },

    async shoot(view: PitView) {
      const { engine, focus } = deps.current();
      if (!engine || !focus) throw new Error('no session');
      const track = engine.track;
      const car = focus;
      const idx = track.indexAt(car.s);
      const h = car.physics.heading;
      const px = car.physics.position.x;
      const pz = car.physics.position.y;
      const y = track.elevation[idx];
      // The car's own axes in the world: +z forward, +x across to its left.
      const fx = Math.sin(h), fz = Math.cos(h);
      const rx = Math.cos(h), rz = -Math.sin(h);
      // Which way is the pit wall, so a shot meant to be taken from over the
      // wall is not taken from inside the garage.
      const g = engine.pitGeom;
      const toWall = (rx * track.nx[idx] + rz * track.nz[idx]) * g.sign >= 0 ? -1 : 1;
      const at = (fwd: number, across: number, up: number): THREE.Vector3 =>
        new THREE.Vector3(px + fx * fwd + rx * across, y + up, pz + fz * fwd + rz * across);

      let eye: THREE.Vector3;
      let look: THREE.Vector3;
      let fov = 55;
      switch (view) {
        case 'overhead':
          // Out over the FAST LANE and looking back across the box, not
          // straight down from above it. The pit building's first floor
          // cantilevers over the working lane as a canopy, so a camera directly
          // over the car is inside the ceiling and photographs the underside of
          // a concrete slab — which is what the first version of this shot came
          // back as, on every circuit.
          eye = at(-2.5, toWall * 6.5, 8.5);
          look = at(0, 0, 0.6);
          fov = 52;
          break;
        case 'driver':
          // Where the driver's eyes are, looking down the lane at the light he
          // is waiting on.
          eye = at(0.5, 0, 1.05);
          look = at(28, 0, 0.7);
          fov = 62;
          break;
        case 'lane': {
          // Up the lane, which is where a driver has to pick their own box out
          // of twenty identical ones with enough road left to do it.
          //
          // Taken by walking BACK ALONG THE SPLINE rather than back along the
          // car's heading. They are not the same line: the car is stopped in
          // the working lane pointing wherever it came to rest, and fifty-five
          // metres of that heading in a straight line walked the camera clean
          // through the garage row and out into the desert behind the paddock —
          // every shot came back as a photograph of the back of the pit
          // building. The lane is a curve on a spline and the only way up it is
          // along the spline.
          const laneMag = (g.divider + g.laneInner) * 0.5;
          const eyeS = car.s - 55;
          const lookS = car.s + 8;
          const p0 = onLane(track, eyeS, g.sign * laneMag);
          const p1 = onLane(track, lookS, g.sign * laneMag * 0.9);
          eye = new THREE.Vector3(p0.x, p0.y + 1.25, p0.z);
          look = new THREE.Vector3(p1.x, p1.y + 1.0, p1.z);
          fov = 44;
          break;
        }
        case 'wall':
          // From over the pit wall: the television angle, and the one that
          // shows the whole crew at once.
          eye = at(-3.5, toWall * 9.5, 3.4);
          look = at(0.5, 0, 0.9);
          fov = 50;
          break;
        default:
          // Head on, from where the front jack man stands.
          eye = at(7.5, 0.4, 1.6);
          look = at(-0.5, 0, 0.8);
          fov = 55;
          break;
      }
      deps.freeCam.position.copy(eye);
      deps.freeCam.up.set(0, 1, 0);
      deps.freeCam.lookAt(look);
      deps.freeCam.fov = fov;
      deps.freeCam.updateProjectionMatrix();
      return deps.drawAndShoot(deps.renderFree);
    },
  };
}

/** A point on the pit lane at a lap distance and a signed lateral offset. */
function onLane(
  track: { length: number; count: number; px: Float32Array; pz: Float32Array;
    nx: Float32Array; nz: Float32Array; elevation: Float32Array;
    indexAt(s: number): number },
  s: number,
  lateral: number,
): { x: number; y: number; z: number } {
  const w = ((s % track.length) + track.length) % track.length;
  const i = track.indexAt(w);
  return {
    x: track.px[i] + track.nx[i] * lateral,
    y: track.elevation[i],
    z: track.pz[i] + track.nz[i] * lateral,
  };
}
