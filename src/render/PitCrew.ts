import * as THREE from 'three';
import {
  CREW_INSTANCES_PER_FIGURE, CREW_PARTS, CREW_DETAIL_HIGH, CREW_DETAIL_LOW,
  POSTURES, blendPosture, crewPartGeometries, crewToolGeometries, makeCrewJoints,
  makePosture, poseCrew, writeCrewMatrices,
  type CrewJoints, type CrewPartId, type Posture,
} from './CrewFigure';
import {
  PIT_CREW, WHEEL_CORNERS,
  type CornerResult, type CrewStation, type PitStopProgress,
} from '../race/PitStop';
import { PIT_APRON_DEPTH_M, PIT_APRON_HEIGHT_M } from '../track/PitGeometry';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';

/**
 * The pit crew, doing a pit stop.
 *
 * Twenty-one people in the right places doing the right jobs at the right
 * moments, plus their guns, their wheels, their jacks and the light that
 * releases the driver. Driven entirely from `RaceEngine.pitStopOf` — the same
 * resolved stop the simulation is counting down — so what the player watches
 * and what the clock says are the same event. A wheel is fitted on screen at
 * the instant the model says that corner fitted it, and a corner that has a
 * cross-threaded nut is visibly the one everybody is waiting for.
 *
 * ===========================================================================
 * WHY THERE IS ONLY ONE OF THESE
 * ===========================================================================
 *
 * "insane amount of pit crews". There were a hundred and ten figures standing
 * in the pit lane — eleven at each of ten garages, in fixed poses, permanently,
 * whether or not anything was happening. That is not what a pit lane looks
 * like. Between stops a crew is INSIDE the garage; they come over the wall when
 * their car is on its way in and they go back afterwards. Nineteen boxes with a
 * full crew standing to attention in them is the loudest wrong note in the
 * scene, and it is also the expensive way to be wrong.
 *
 * So the paddock keeps a handful of people at each garage — the ones who really
 * are always there — and this module owns exactly ONE crew: the one working on
 * the car in front of you. It follows whichever car is being serviced, it is
 * hidden when none is, and while it is hidden it costs one visibility test.
 *
 * ===========================================================================
 * WHAT IT COSTS
 * ===========================================================================
 *
 * Five instanced meshes for the people — thigh, shin, torso, upper arm,
 * forearm; see `CrewFigure` for why those five — and three more for the guns,
 * the wheels and the jacks. Eight draw calls for the entire working crew, one
 * material for the lot, and 189 matrices written per frame only while a car is
 * actually in its box. Team colour is per-instance (`setColorAt`), which is
 * what lets one geometry serve any team with no rebuild.
 */

export interface PitCrewScene {
  root: THREE.Group;
  /** Poses the crew for this frame. Costs one branch when nothing is happening. */
  update(engine: RaceEngine): void;
  dispose(): void;
}

/**
 * How far up the lane the crew come over the wall, metres.
 *
 * A real crew is out and set well before the car arrives — the reference
 * photographs are all of a crew already kneeling in position with the box
 * empty. At the 80 km/h limit this is about six seconds, which is enough for
 * the player to see them waiting and know which box is theirs.
 */
const CREW_OUT_LEAD_M = 140;

/**
 * How far the jacks lift the car, metres.
 *
 * Enough to get the wheels clear of the ground and no more — a Formula 1 jack
 * raises the car about eight centimetres, which is all the tyre needs to come
 * off the hub. It lives here rather than in the renderer because the crew's
 * hands and the car's floor have to agree about it.
 */
export const PIT_JACK_LIFT_M = 0.08;

/** Height of the release light above the ground, metres. */
const LIGHT_H = 2.4;

/** Radius of a wheel at its centre height, metres. */
const WHEEL_RADIUS_M = 0.36;

const _m = new THREE.Matrix4();
const _fig = new THREE.Matrix4();
const _box = new THREE.Matrix4();
const _tool = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _colour = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const smooth = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
/** Smooth ramp from 0 to 1 across [a, b]. */
const ramp = (t: number, a: number, b: number): number => smooth((t - a) / (b - a || 1e-6));

/**
 * One crew member's live state.
 *
 * Position and posture are both animated, because half of what a stop looks
 * like is people MOVING between two places — the wheel-off man walking the used
 * tyre backwards out of the way, the wheel-on man stepping in with the new one.
 * A crew that changes pose without changing position reads as animatronics.
 */
interface Member {
  station: CrewStation;
  /** Index into `WHEEL_CORNERS` for the twelve on the wheels, or -1. */
  corner: number;
  joints: CrewJoints;
  mats: THREE.Matrix4[];
  /** Per-figure phase, so nobody breathes in time with anybody else. */
  phase: number;
}

/** How many of each part one figure has, and where it starts in its nine. */
const PER_FIGURE: Record<CrewPartId, number> = {
  thigh: 2, shin: 2, torso: 1, upperArm: 2, forearm: 2,
};
const SLOT_BASE: Record<CrewPartId, number> = {
  thigh: 0, shin: 2, torso: 4, upperArm: 5, forearm: 7,
};

export function buildPitCrew(quality: 'low' | 'high'): PitCrewScene {
  const root = new THREE.Group();
  root.name = 'pit-crew';
  root.visible = false;

  const detail = quality === 'low' ? CREW_DETAIL_LOW : CREW_DETAIL_HIGH;
  const parts = crewPartGeometries(detail);
  const tools = crewToolGeometries(detail);

  const disposables: { dispose(): void }[] = [
    ...CREW_PARTS.map((id) => parts[id]), tools.gun, tools.tyre, tools.jack,
  ];

  const kit = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0.04,
  });
  const metal = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.34, metalness: 0.55,
  });
  const rubber = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0,
  });
  disposables.push(kit, metal, rubber);

  const members: Member[] = PIT_CREW.map((station, i) => ({
    station,
    corner: station.corner ? WHEEL_CORNERS.indexOf(station.corner) : -1,
    joints: makeCrewJoints(),
    mats: Array.from({ length: CREW_INSTANCES_PER_FIGURE }, () => new THREE.Matrix4()),
    phase: (i * 0.6180339) % 1,
  }));
  const n = members.length;

  // --- The people ---------------------------------------------------------
  //
  // One instanced mesh per part type, holding that part for every figure. Slot
  // 2i and 2i+1 of the `thigh` mesh are figure i's left and right thighs.
  const limbs = {} as Record<CrewPartId, THREE.InstancedMesh>;
  for (const id of CREW_PARTS) {
    const mesh = new THREE.InstancedMesh(parts[id], kit, n * PER_FIGURE[id]);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Culled by the group, not per mesh. The rig is a few metres across and it
    // moves every frame; recomputing a bounding sphere over 189 instances would
    // cost more than the culling saves, and a stale one hides the crew.
    mesh.frustumCulled = false;
    limbs[id] = mesh;
    root.add(mesh);
  }

  // --- What they are holding ----------------------------------------------
  const guns = new THREE.InstancedMesh(tools.gun, metal, 4);
  // Eight wheels: the four coming off and the four going on, corner-indexed —
  // slots 0-3 are the used tyres, 4-7 the new ones.
  const wheels = new THREE.InstancedMesh(tools.tyre, rubber, 8);
  const jacks = new THREE.InstancedMesh(tools.jack, metal, 2);
  for (const mesh of [guns, wheels, jacks]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    root.add(mesh);
  }

  // --- The release light --------------------------------------------------
  //
  // The thing the driver is actually looking at. A modern stop is released by a
  // light: each gun reports when its nut is tight, the system goes green on its
  // own, and the driver leaves on the light rather than on a man with a board.
  // So it is drawn, it is unlit geometry so it carries through the bloom pass,
  // and it is the only thing in the box that changes colour.
  const lampGeo = new THREE.SphereGeometry(0.12, 12, 8);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x351008, toneMapped: false });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x24282e, roughness: 0.55 });
  const mastGeo = new THREE.CylinderGeometry(0.036, 0.05, LIGHT_H, 8);
  const headGeo = new THREE.BoxGeometry(0.30, 0.36, 0.16);
  const gantry = new THREE.Group();
  const mast = new THREE.Mesh(mastGeo, mastMat);
  mast.position.y = LIGHT_H * 0.5;
  const head = new THREE.Mesh(headGeo, mastMat);
  head.position.y = LIGHT_H;
  const lamp = new THREE.Mesh(lampGeo, lampMat);
  lamp.position.set(0, LIGHT_H, -0.10);
  gantry.add(mast, head, lamp);
  root.add(gantry);
  disposables.push(lampGeo, lampMat, mastGeo, mastMat, headGeo);

  const blend = makePosture();
  let colouredFor = '';

  /**
   * The car whose stop is worth drawing.
   *
   * The player's, whenever the player is in the lane and still owes a stop or
   * is in the middle of one — that is the stop they are living through, and the
   * crew waiting at their box is half of the answer to "where is my pit".
   * Failing that, any car actually stationary in a box: an AI stop happening in
   * front of you is worth seeing, and it is the same rig at a different place.
   */
  function focusCar(engine: RaceEngine): CarEntry | null {
    const player = engine.playerCar;
    if (player && !player.retired && player.inPitLane && !player.pitTransitOnly &&
        (player.inPitBox || !player.servicedThisVisit)) {
      return player;
    }
    for (const car of engine.cars) if (car.inPitBox) return car;
    return null;
  }

  return {
    root,

    update(engine: RaceEngine): void {
      const car = focusCar(engine);
      if (!car) {
        root.visible = false;
        return;
      }

      const view = engine.pitStopOf(car);
      const working = car.inPitBox;
      const boxAhead = car.perception.pitBoxAheadM;
      const approaching = !working && boxAhead >= 0 && boxAhead < CREW_OUT_LEAD_M;
      if (!approaching && !working) {
        root.visible = false;
        return;
      }
      root.visible = true;

      // The box's frame, taken from the CAR and not from the painted marks: the
      // crew work on the car where it actually stopped, which is the whole
      // reason stopping off the marks costs time. While the car is still
      // arriving the frame is the marks themselves, so the crew are set up at
      // the box rather than walking down the lane alongside the car.
      const track = engine.track;
      const idx = track.indexAt(working ? car.s : car.pitBoxS);
      const g = engine.pitGeom;
      const workingMag = (g.divider + g.garageFace) * 0.5;
      let px: number;
      let pz: number;
      let heading: number;
      let carMag: number;
      if (working) {
        px = car.physics.position.x;
        pz = car.physics.position.y;
        heading = car.physics.heading;
        carMag = Math.abs(car.lateral);
      } else {
        const lat = g.sign * workingMag;
        px = track.px[idx] + track.nx[idx] * lat;
        pz = track.pz[idx] + track.nz[idx] * lat;
        heading = Math.atan2(track.tx[idx], track.tz[idx]);
        carMag = workingMag;
      }
      const baseY = track.elevation[idx];
      const sinH = Math.sin(heading);
      const cosH = Math.cos(heading);
      _box.set(
        cosH, 0, sinH, px,
        0, 1, 0, baseY,
        -sinH, 0, cosH, pz,
        0, 0, 0, 1,
      );

      // Which way the crew frame's +x runs relative to the garages.
      //
      // Local +x maps to world (cos h, -sin h). Whether that increases or
      // decreases the distance from the centreline depends on the circuit's
      // normal convention and on which side the pit lane is, so it is measured
      // rather than assumed — get it wrong and every crew member on the garage
      // side is standing in the fast lane instead.
      const outward = (cosH * track.nx[idx] - sinH * track.nz[idx]) * g.sign >= 0 ? 1 : -1;
      const apronFrom = g.garageFace - PIT_APRON_DEPTH_M;

      const prog: PitStopProgress | null = view.result ? view.progress : null;
      const done: readonly CornerResult[] | null = view.result ? view.result.corners : null;
      const t = view.elapsedS;

      for (let i = 0; i < n; i++) {
        const m = members[i];
        const st = m.station;
        const ci = m.corner;
        const cp = prog && ci >= 0 ? prog.corners[ci] : null;
        const doneS = done && ci >= 0 ? done[ci].doneS : 0;

        let a: Posture = POSTURES.ready;
        let b: Posture = POSTURES.ready;
        let k = 0;
        let dx = 0;
        let dz = 0;

        switch (st.role) {
          case 'gun': {
            // On the nut from the moment the car is up until this corner's gun
            // reports, then off it and back out of the way.
            const on = cp ? ramp(t, 0.08, 0.28) * (1 - ramp(t, doneS, doneS + 0.22)) : 0;
            a = POSTURES.ready; b = POSTURES.gun; k = on;
            dx = -on * 0.32;
            break;
          }
          case 'wheel-off': {
            // Takes the used wheel and walks it clear.
            const pull = cp ? smooth(cp.removing) : 0;
            const clear = cp ? ramp(t, doneS - 0.8, doneS) : 0;
            a = POSTURES.ready; b = POSTURES.fit;
            k = pull * (1 - clear);
            dx = -pull * 0.28 + clear * 0.60;
            dz = -clear * 0.80;
            break;
          }
          case 'wheel-on': {
            // Holds the new wheel, steps in with it, steps back out.
            const fit = cp ? smooth(cp.fitting) : 0;
            const back = cp ? ramp(t, doneS - 0.4, doneS + 0.15) : 0;
            a = POSTURES.carry; b = POSTURES.fit;
            k = fit * (1 - back);
            dx = -fit * 0.42 + back * 0.66;
            dz = back * 0.60;
            break;
          }
          case 'front-jack':
          case 'rear-jack': {
            // In as the car arrives, lever down to lift it, hold it there, and
            // out as it drops. `jack` is bent over the handle, `jackUp` is the
            // moment of straightening to drive the lever down.
            const lift = prog ? prog.jack : 0;
            a = POSTURES.jack; b = POSTURES.jackUp; k = 1 - lift;
            // Stood off the car's line until it has actually stopped, because
            // the front jack man's own rule is that he steps in front of a car
            // that is no longer moving.
            dz = working ? 0 : (st.role === 'front-jack' ? 1.1 : -1.1);
            break;
          }
          case 'spare-jack':
            a = POSTURES.stand; b = POSTURES.ready; k = working ? 0.4 : 0.1;
            break;
          case 'stabiliser':
            // Hands on the sidepod once the car is up and the guns are pulling.
            a = POSTURES.ready; b = POSTURES.jack; k = prog ? prog.jack * 0.5 : 0;
            break;
          case 'front-wing': {
            // Steadying the wing all stop; down on it properly only when it is
            // being changed.
            const nose = prog ? prog.nose : 0;
            a = POSTURES.ready; b = POSTURES.fit;
            k = view.result?.noseChange ? smooth(Math.sin(nose * Math.PI)) : 0.12;
            break;
          }
          default:
            // The spotter, up on his feet and looking down the lane.
            a = POSTURES.stand; b = POSTURES.ready; k = 0.2;
            break;
        }

        // A breath of idle motion, so nobody is a statue between tasks. Two
        // centimetres of hip height and a degree of lean — small, and the
        // difference between a crew and a display of mannequins.
        const idle = Math.sin((t + m.phase * 6.2832) * 2.1) * 0.5 + 0.5;
        blendPosture(a, b, k, blend);
        blend.crouch += idle * 0.022;
        blend.spineLean += idle * 0.016;
        poseCrew(blend, m.joints);
        writeCrewMatrices(m.joints, m.mats);

        // The stations are authored in the GARAGE FRAME: +x is towards the
        // garages, whichever side of the car that turns out to be. `outward`
        // mirrors the whole plan into the car's own frame, headings included —
        // a reflection of the layout, applied as a rigid transform per figure,
        // so no geometry is drawn inside out. Without it the spare jack men and
        // the spotter stand out in the fast lane on half the calendar, which is
        // the one place in a pit lane where nobody stands.
        const lx = (st.x + dx) * outward;
        const lz = st.z + dz;
        // Feet on the garage apron where the apron is, so the crew on the
        // garage side are not sunk twelve centimetres into a concrete step.
        const mag = carMag + lx * outward;
        const lift = mag > apronFrom ? PIT_APRON_HEIGHT_M : 0;

        _fig.makeRotationY(st.heading * outward);
        _fig.setPosition(lx, lift, lz);
        _fig.premultiply(_box);

        for (let q = 0; q < CREW_INSTANCES_PER_FIGURE; q++) m.mats[q].premultiply(_fig);
        for (const id of CREW_PARTS) {
          const base = SLOT_BASE[id];
          for (let q = 0; q < PER_FIGURE[id]; q++) {
            limbs[id].setMatrixAt(i * PER_FIGURE[id] + q, m.mats[base + q]);
          }
        }

        // --- Equipment ----------------------------------------------------
        if (ci >= 0) {
          const hub = hubOf(ci, outward);
          if (st.role === 'gun') {
            // In the hands, angled down at the nut. The hand joint is in the
            // figure's own frame, so the figure's matrix carries it.
            const hand = m.joints.hand[0];
            _tool.makeRotationX(-0.75);
            _tool.setPosition(hand.x, hand.y, hand.z + 0.06);
            guns.setMatrixAt(ci, _tool.premultiply(_fig));
          } else if (st.role === 'wheel-off') {
            // The used tyre: at the hub while it is being pulled, then in the
            // carrier's hands as he walks it back, then gone.
            const pull = cp ? smooth(cp.removing) : 0;
            if (pull <= 0.02 || (cp && cp.tightening > 0.9)) {
              wheels.setMatrixAt(ci, ZERO);
            } else {
              // Interpolate from the hub out to chest height in the carrier's
              // hands. `dx`/`dz` already carry him backwards.
              _pos.set(
                hub.x + (lx - hub.x) * pull,
                WHEEL_RADIUS_M + lift + pull * 0.42,
                hub.z + (lz - hub.z) * pull,
              );
              _tool.identity().setPosition(_pos.x, _pos.y, _pos.z);
              wheels.setMatrixAt(ci, _tool.premultiply(_box));
            }
          } else if (st.role === 'wheel-on') {
            // The new tyre: held at the carrier's chest, then swung onto the
            // hub, then it is the car's and this stops drawing it.
            const fit = cp ? smooth(cp.fitting) : 0;
            const fitted = cp ? cp.tightening > 0.05 : false;
            if (fitted) {
              wheels.setMatrixAt(4 + ci, ZERO);
            } else {
              const startX = st.x * outward;
              _pos.set(
                startX + (hub.x - startX) * fit,
                WHEEL_RADIUS_M + lift + (1 - fit) * 0.40,
                st.z + (hub.z - st.z) * fit,
              );
              _tool.identity().setPosition(_pos.x, _pos.y, _pos.z);
              wheels.setMatrixAt(4 + ci, _tool.premultiply(_box));
            }
          }
        } else if (st.role === 'front-jack' || st.role === 'rear-jack') {
          // The jack lies on the ground with its handle running back to the
          // operator's hands; the geometry is modelled that way round, so it
          // simply rides the figure's own transform.
          _tool.identity().setPosition(0, 0.14, 0);
          jacks.setMatrixAt(st.role === 'front-jack' ? 0 : 1, _tool.premultiply(_fig));
        }
      }

      for (const id of CREW_PARTS) limbs[id].instanceMatrix.needsUpdate = true;
      guns.instanceMatrix.needsUpdate = true;
      wheels.instanceMatrix.needsUpdate = true;
      jacks.instanceMatrix.needsUpdate = true;

      // Team colour, once per team rather than once per frame.
      if (colouredFor !== car.team.id) {
        colouredFor = car.team.id;
        _colour.set(car.team.colour);
        for (const id of CREW_PARTS) {
          const mesh = limbs[id];
          for (let k = 0; k < mesh.count; k++) mesh.setColorAt(k, _colour);
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      }

      // --- The light ------------------------------------------------------
      //
      // Four metres ahead of the car and just off its centreline, which is
      // where a driver waiting to be released is already looking: straight down
      // the lane he is about to rejoin, over his own nose. Set out in the fast
      // lane instead it is behind him and to one side, which is the one place
      // it is no use at all.
      _m.identity().setPosition(0.85 * outward, 0, 4.4).premultiply(_box);
      gantry.position.setFromMatrixPosition(_m);
      gantry.rotation.y = heading;
      const colour = prog && prog.green ? 0x22ff44 : working ? 0xff2010 : 0x3a1208;
      if (lampMat.color.getHex() !== colour) lampMat.color.setHex(colour);
    },

    dispose(): void {
      for (const d of disposables) d.dispose();
      root.clear();
    },
  };
}

/** Half-track and axle positions of the car the crew are working on, metres. */
const HUB = [
  { x: 0.86, z: 1.72 },   // FL
  { x: -0.86, z: 1.72 },  // FR
  { x: 0.86, z: -1.68 },  // RL
  { x: -0.86, z: -1.68 }, // RR
];

const _hub = { x: 0, z: 0 };

function hubOf(corner: number, outward: number): { x: number; z: number } {
  const h = HUB[corner] ?? HUB[0];
  _hub.x = h.x * outward;
  _hub.z = h.z;
  return _hub;
}
