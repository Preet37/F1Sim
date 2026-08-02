import * as THREE from 'three';
import { PartsBin, ball, chamferBox, chamferCylinder, limbGeometry, scaleWithNormals } from './ChamferKit';

/**
 * One person in team kit, built once and used two different ways.
 *
 * There are two populations of people in a pit lane and they have opposite
 * requirements, which is why this file exists rather than the figure living in
 * whichever module happened to need it first:
 *
 *   - the ones STANDING ABOUT. A hundred-odd of them along the row of garages
 *     and on the pit wall stands, never moving. They want to be merged into the
 *     paddock's one static buffer and then cost nothing at all, for ever.
 *
 *   - the ones WORKING. Twenty-one of them around one car, all moving, all
 *     doing different things, for about two and a half seconds. They want to be
 *     instanced and re-posed every frame — and there is only ever one such
 *     group, because only one car is being serviced in front of the player at a
 *     time.
 *
 * Both are the same person. So the figure is defined once, as a skeleton and a
 * set of rigid parts, and there are two ways of realising it: `mergeCrewFigure`
 * flattens it into a single geometry, and `crewPartGeometries` +
 * `writeCrewMatrices` drive an instanced rig. A change to the proportions
 * changes both, which is the whole point.
 *
 * WHY IT IS BUILT FROM BONES AND NOT BOXES
 *
 * "the people are like legos". A figure is read as a person by its silhouette
 * — a head about a seventh of the height, shoulders wider than hips, a waist
 * narrower than both, a gap between the legs, and limbs that BEND. Axis-aligned
 * boxes can only ever make a snowman, because the moment a knee bends the thigh
 * has to point somewhere that is not straight down. So a pose here is a list of
 * joint positions and the geometry is oriented to follow it, which is also what
 * makes the pose interpolable — and a crew that moves is the single largest
 * difference between a pit lane and a shop window.
 */

// ===========================================================================
// The skeleton
// ===========================================================================

/**
 * Bone lengths, metres. A 1.78m figure.
 *
 * FIXED, and that is load-bearing for the instanced path: a pose changes joint
 * ANGLES, never bone lengths, so each bone's geometry can be built once at its
 * true length and merely rotated into place. Scaling a capsule along its axis
 * to fit a varying length distorts its hemispherical ends, and an arm whose
 * elbow is an egg is worse than no arm.
 */
export const BONE = {
  thigh: 0.44,
  shin: 0.42,
  spine: 0.40,
  upperArm: 0.30,
  forearm: 0.28,
} as const;

/** Half the distance between the hip joints, metres. */
const HIP_HALF = 0.105;
/** Half the distance between the shoulder joints, metres. */
const SHOULDER_HALF = 0.21;

/**
 * A posed figure, as joint positions in its own frame.
 *
 * The frame: origin between the feet on the ground, +y up, +z the way the
 * figure faces. Everything downstream — the merge, the instanced rig, the props
 * in the hands — reads these and nothing else.
 */
export interface CrewJoints {
  hip: THREE.Vector3;
  knee: [THREE.Vector3, THREE.Vector3];
  ankle: [THREE.Vector3, THREE.Vector3];
  chest: THREE.Vector3;
  shoulder: [THREE.Vector3, THREE.Vector3];
  elbow: [THREE.Vector3, THREE.Vector3];
  hand: [THREE.Vector3, THREE.Vector3];
}

export function makeCrewJoints(): CrewJoints {
  return {
    hip: new THREE.Vector3(),
    knee: [new THREE.Vector3(), new THREE.Vector3()],
    ankle: [new THREE.Vector3(), new THREE.Vector3()],
    chest: new THREE.Vector3(),
    shoulder: [new THREE.Vector3(), new THREE.Vector3()],
    elbow: [new THREE.Vector3(), new THREE.Vector3()],
    hand: [new THREE.Vector3(), new THREE.Vector3()],
  };
}

/**
 * A posture, as the handful of angles that actually distinguish one from
 * another.
 *
 * Angles rather than positions, because angles interpolate into something that
 * still has the right bone lengths and positions do not: lerping a standing
 * figure towards a crouching one by its joint POSITIONS shortens its legs on
 * the way through.
 *
 * All angles in radians. Sign conventions, once:
 *
 *   `hipPitch`   swings the thigh FORWARD from hanging straight down
 *   `kneeBend`   folds the shin BACK from the thigh
 *   `spineLean`  tips the whole upper body FORWARD from upright
 *   `armPitch`   swings the upper arm FORWARD from hanging
 *   `elbowBend`  folds the forearm UP towards the shoulder
 *   `armSpread`  takes both arms out sideways
 */
export interface Posture {
  /** Stance width multiplier: 1 is feet under the hips. */
  stance: number;
  hipPitch: number;
  kneeBend: number;
  spineLean: number;
  armPitch: number;
  elbowBend: number;
  armSpread: number;
  /** Squat: how far the hips drop below the height the legs would give. */
  crouch: number;
  /** Fore/aft offset of the whole figure's hips, metres. */
  shift: number;
}

/**
 * The postures the pit lane needs.
 *
 * Named for what the person is doing, because that is what the choreography
 * asks for. Everything else is produced by blending two of these.
 */
export const POSTURES = {
  /** Upright, arms at the sides. Somebody watching. */
  stand: {
    stance: 1, hipPitch: 0.02, kneeBend: 0.06, spineLean: 0.03,
    armPitch: 0.08, elbowBend: 0.34, armSpread: 0.08, crouch: 0, shift: 0,
  },
  /** Set and waiting: knees bent, weight forward, hands up ready. */
  ready: {
    stance: 1.30, hipPitch: 0.40, kneeBend: 0.82, spineLean: 0.38,
    armPitch: 0.55, elbowBend: 0.95, armSpread: 0.20, crouch: 0.10, shift: 0.02,
  },
  /**
   * Down over a wheel with the gun on the nut.
   *
   * The arms are nearly STRAIGHT and pointing down-forward, not bent out in
   * front. It is worth being exact about, because it is the pose twelve of the
   * twenty-one are in for most of the stop and it was the thing that made the
   * first version read as a crowd of zombies: with the shoulders at 0.81m and
   * the wheel nut at 0.36m about 0.35m forward, the arm has to run down at
   * about 37 degrees from vertical and it has to reach — an elbow folded to a
   * right angle puts the hands at chest height, waving.
   */
  gun: {
    stance: 1.55, hipPitch: 0.60, kneeBend: 1.45, spineLean: 1.15,
    armPitch: 0.62, elbowBend: 0.12, armSpread: 0.13, crouch: 0.30, shift: 0.06,
  },
  /** Holding a tyre against the chest, standing. */
  carry: {
    stance: 1.1, hipPitch: 0.05, kneeBend: 0.22, spineLean: 0.12,
    armPitch: 1.15, elbowBend: 1.05, armSpread: 0.30, crouch: 0.04, shift: 0,
  },
  /** Crouched with a tyre at hub height, about to push it on. */
  fit: {
    stance: 1.4, hipPitch: 0.55, kneeBend: 1.25, spineLean: 0.62,
    armPitch: 0.85, elbowBend: 0.42, armSpread: 0.32, crouch: 0.26, shift: 0.05,
  },
  /** Bent over a jack handle, both hands low and forward. */
  jack: {
    stance: 1.2, hipPitch: 0.30, kneeBend: 0.70, spineLean: 0.85,
    armPitch: 0.95, elbowBend: 0.22, armSpread: 0.09, crouch: 0.14, shift: 0.04,
  },
  /** Straightening up, driving the jack handle down. */
  jackUp: {
    stance: 1.25, hipPitch: 0.10, kneeBend: 0.35, spineLean: 0.30,
    armPitch: 0.38, elbowBend: 0.30, armSpread: 0.09, crouch: 0.02, shift: 0.02,
  },
  /** Sitting on a pit wall stand at a bank of screens. */
  sit: {
    stance: 1.15, hipPitch: 1.45, kneeBend: 1.5, spineLean: 0.12,
    armPitch: 0.72, elbowBend: 1.05, armSpread: 0.16, crouch: 0, shift: 0,
  },
} as const satisfies Record<string, Posture>;

export type PostureName = keyof typeof POSTURES;

/** Linear blend of two postures. `out` may alias neither input. */
export function blendPosture(a: Posture, b: Posture, t: number, out: Posture): Posture {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  out.stance = a.stance + (b.stance - a.stance) * k;
  out.hipPitch = a.hipPitch + (b.hipPitch - a.hipPitch) * k;
  out.kneeBend = a.kneeBend + (b.kneeBend - a.kneeBend) * k;
  out.spineLean = a.spineLean + (b.spineLean - a.spineLean) * k;
  out.armPitch = a.armPitch + (b.armPitch - a.armPitch) * k;
  out.elbowBend = a.elbowBend + (b.elbowBend - a.elbowBend) * k;
  out.armSpread = a.armSpread + (b.armSpread - a.armSpread) * k;
  out.crouch = a.crouch + (b.crouch - a.crouch) * k;
  out.shift = a.shift + (b.shift - a.shift) * k;
  return out;
}

export function makePosture(): Posture {
  return { ...POSTURES.stand };
}

/**
 * Forward kinematics: a posture becomes a set of joint positions.
 *
 * Built from the FEET UP, which is the only order that keeps a crouching figure
 * standing on the ground. Solving downwards from a fixed hip height instead
 * puts the feet through the floor the moment the knees bend, and that single
 * mistake is most of what makes a low-effort crowd look like it is wading.
 */
export function poseCrew(p: Posture, out: CrewJoints): CrewJoints {
  // Thigh direction: down, tipped forward by hipPitch.
  const tx = Math.sin(p.hipPitch);
  const ty = -Math.cos(p.hipPitch);
  // Shin direction: the thigh's, folded back by kneeBend.
  const shinAngle = p.hipPitch - p.kneeBend;
  const sx = Math.sin(shinAngle);
  const sy = -Math.cos(shinAngle);

  // Where the hips end up if the ankles are on the ground.
  const hipY = -(BONE.thigh * ty + BONE.shin * sy) - p.crouch * 0.12;
  const hipZ = p.shift;

  out.hip.set(0, hipY, hipZ);
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const hx = side * HIP_HALF * p.stance;
    out.knee[s].set(hx + side * 0.02, hipY + BONE.thigh * ty, hipZ + BONE.thigh * tx);
    out.ankle[s].set(
      out.knee[s].x + side * 0.01,
      out.knee[s].y + BONE.shin * sy,
      out.knee[s].z + BONE.shin * sx,
    );
  }

  // Spine: up from the hips, tipped forward.
  const cx = Math.sin(p.spineLean);
  const cy = Math.cos(p.spineLean);
  out.chest.set(0, hipY + BONE.spine * cy, hipZ + BONE.spine * cx);

  // Shoulders sit across the top of the chest, in the chest's own frame, so
  // they tip with it.
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    out.shoulder[s].set(
      side * SHOULDER_HALF,
      out.chest.y + 0.115 * cy,
      out.chest.z + 0.115 * cx,
    );
    // Arms hang from the shoulder and swing forward in the WORLD frame, not
    // the chest's: a man folded over a wheel has his arms hanging straight
    // down to it, not sticking out horizontally in line with his back.
    const ax = Math.sin(p.armPitch);
    const ay = -Math.cos(p.armPitch);
    const spread = side * p.armSpread;
    out.elbow[s].set(
      out.shoulder[s].x + spread * BONE.upperArm,
      out.shoulder[s].y + ay * BONE.upperArm,
      out.shoulder[s].z + ax * BONE.upperArm,
    );
    const fa = p.armPitch + p.elbowBend;
    const fx = Math.sin(fa);
    const fy = -Math.cos(fa);
    out.hand[s].set(
      out.elbow[s].x + spread * BONE.forearm * 0.4,
      out.elbow[s].y + fy * BONE.forearm,
      out.elbow[s].z + fx * BONE.forearm,
    );
  }
  return out;
}

// ===========================================================================
// Geometry
// ===========================================================================

/** How finely the figure is tessellated. */
export interface CrewDetail {
  limb: number;
  head: number;
  round: number;
}

export const CREW_DETAIL_HIGH: CrewDetail = { limb: 9, head: 14, round: 16 };
export const CREW_DETAIL_LOW: CrewDetail = { limb: 4, head: 6, round: 8 };

/**
 * The rigid parts a figure is made of, and how many of each it has.
 *
 * Five, not fifteen, and the merges are chosen by what actually articulates:
 *
 *   - the FOOT is merged into the shin, because an ankle barely flexes and
 *     nobody has ever noticed one on a pit crew;
 *   - the GLOVE is merged into the forearm for the same reason;
 *   - the HEAD, NECK and HELMET are merged into the torso, because everyone
 *     over the wall is wearing a full-face helmet and a helmet does not turn
 *     independently of the shoulders at this distance. It also means no skin is
 *     drawn anywhere, which is what lets the whole figure be one instanced
 *     colour.
 *
 * Eight instances per figure across five draw calls is what makes twenty-one
 * animated people affordable.
 */
export type CrewPartId = 'thigh' | 'shin' | 'torso' | 'upperArm' | 'forearm';

export const CREW_PARTS: readonly CrewPartId[] = ['thigh', 'shin', 'torso', 'upperArm', 'forearm'];

/** How many of each part one figure has. */
export const CREW_PART_COUNT: Record<CrewPartId, number> = {
  thigh: 2, shin: 2, torso: 1, upperArm: 2, forearm: 2,
};

/** Total instances one figure occupies. */
export const CREW_INSTANCES_PER_FIGURE = 9;

/**
 * Vertex-colour weights.
 *
 * Every part is drawn in the TEAM's colour, multiplied by the weight baked into
 * its vertices — `instanceColor` and `vertexColors` multiply in the shader, so
 * one instanced colour per figure plus a per-vertex weight gives boots, gloves,
 * a visor and a bib panel without a second material or a second draw call.
 *
 * It is also how real team kit looks: the boots are not black, they are a very
 * dark version of the team's own colour, and so are the gloves.
 */
const W_KIT = 1.0;
const W_PANEL = 0.62;
const W_DARK = 0.16;
const W_VISOR = 0.05;
const W_HELMET = 0.88;

/**
 * A weight as a colour `PartsBin` will accept.
 *
 * `PartsBin.add` takes a `ColorRepresentation`, and a bare number there is read
 * as a HEX — `0.95` becomes `Math.floor(0.95)` becomes black. Every part of
 * every figure came out black the first time round for exactly that reason.
 * A `Color` is passed by value into the vertex attribute immediately, so one
 * scratch instance is enough.
 */
const _w = new THREE.Color();
const wt = (weight: number): THREE.Color => _w.setScalar(weight);

/**
 * A capsule of the given length lying along +Y, centred on the origin.
 *
 * Slightly longer than the bone so consecutive segments overlap at the joint
 * and a bent knee has no gap in it.
 */
function bone(len: number, radius: number, deep: number, detail: CrewDetail): THREE.BufferGeometry {
  const g = limbGeometry(radius, Math.max(0.01, len * 1.06 - radius * 2), detail.limb, 2);
  if (Math.abs(deep - radius) > 1e-6) scaleWithNormals(g, 1, 1, deep / radius);
  return g;
}

/** The five part geometries, vertex-coloured, built once. */
export function crewPartGeometries(detail: CrewDetail): Record<CrewPartId, THREE.BufferGeometry> {
  const mk = (build: (bin: PartsBin) => void): THREE.BufferGeometry => {
    const bin = new PartsBin();
    build(bin);
    return bin.merge() ?? chamferBox(0.1, 0.1, 0.1, 0);
  };

  return {
    thigh: mk((bin) => {
      const g = bone(BONE.thigh, 0.071, 0.086, detail);
      bin.addRaw(g, wt(W_KIT));
    }),
    shin: mk((bin) => {
      const g = bone(BONE.shin, 0.059, 0.071, detail);
      bin.addRaw(g, wt(W_KIT));
      // The boot, at the bottom of the shin and pointing the way the figure
      // faces. The shin's own frame has +Y along the bone, so this is placed in
      // that frame and rides with it.
      const shoe = chamferBox(0.115, 0.085, 0.28, 0.02);
      bin.add(shoe, wt(W_DARK), 0, -BONE.shin * 0.5 - 0.01, 0.07);
      shoe.dispose();
    }),
    torso: mk((bin) => {
      // Built in the SPINE's frame: +Y from hip to chest, origin at the middle
      // of the spine. Everything above the chest is rigid with it.
      const half = BONE.spine * 0.5;
      const pelvis = chamferBox(0.33, 0.21, 0.235, 0.04);
      bin.add(pelvis, wt(W_KIT), 0, -half + 0.06, 0);
      pelvis.dispose();
      const waist = bone(BONE.spine * 0.72, 0.135, 0.098, detail);
      bin.addRaw(waist, wt(W_KIT));
      const chest = chamferBox(0.42, 0.31, 0.245, 0.05);
      bin.add(chest, wt(W_KIT), 0, half - 0.06, 0);
      chest.dispose();
      // The bib panel across the chest of every set of racing overalls.
      const bib = chamferBox(0.29, 0.17, 0.02, 0);
      bin.add(bib, wt(W_PANEL), 0, half - 0.05, 0.135);
      bib.dispose();
      // Shoulder caps, so the arms do not appear to start inside the chest.
      const cap = chamferBox(0.135, 0.15, 0.2, 0.04);
      for (const s of [-1, 1]) bin.add(cap, wt(W_KIT), s * SHOULDER_HALF, half - 0.02, 0);
      cap.dispose();
      // Neck, then the helmet. There is no head: it is inside the helmet and
      // nobody over the wall takes theirs off.
      const neck = chamferBox(0.115, 0.10, 0.115, 0.02);
      bin.add(neck, wt(W_DARK), 0, half + 0.05, 0.005);
      neck.dispose();
      const shell = scaleWithNormals(ball(0.133, detail.head), 1.0, 1.07, 1.03);
      shell.translate(0, half + 0.20, 0.01);
      bin.addRaw(shell, wt(W_HELMET));
      const visor = chamferBox(0.205, 0.08, 0.115, 0.02);
      bin.add(visor, wt(W_VISOR), 0, half + 0.195, 0.105);
      visor.dispose();
    }),
    upperArm: mk((bin) => {
      bin.addRaw(bone(BONE.upperArm, 0.054, 0.060, detail), wt(W_KIT));
    }),
    forearm: mk((bin) => {
      bin.addRaw(bone(BONE.forearm, 0.045, 0.050, detail), wt(W_KIT));
      const glove = chamferBox(0.10, 0.125, 0.115, 0.025);
      bin.add(glove, wt(W_DARK), 0, -BONE.forearm * 0.5 - 0.03, 0.01);
      glove.dispose();
    }),
  };
}

// ===========================================================================
// Placing the parts
// ===========================================================================

const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Orients a part whose geometry lies along +Y, centred, so that its -Y end sits
 * at `from` and it points towards `to`.
 *
 * The part keeps its own length — only its direction and its midpoint come from
 * the joints. See the note on `BONE`.
 *
 * ALWAYS CALLED BOTTOM-END FIRST, and it matters. `setFromUnitVectors` produces
 * the shortest-arc rotation, which for a direction near +Y is nearly the
 * identity and leaves the part's own +Z pointing the way the figure faces — so
 * the boot baked into the shin points forwards and the glove baked into the
 * forearm sits on the back of the hand. Called the other way round the
 * direction is near -Y, which is the degenerate antiparallel case: the rotation
 * axis is arbitrary, and every boot in the pit lane ends up facing a different
 * random direction.
 */
function boneMatrix(
  from: THREE.Vector3, to: THREE.Vector3, len: number, out: THREE.Matrix4,
): THREE.Matrix4 {
  _d.subVectors(to, from);
  const d = _d.length();
  if (d < 1e-5) {
    out.makeTranslation(from.x, from.y, from.z);
    return out;
  }
  _d.divideScalar(d);
  _q.setFromUnitVectors(_up, _d);
  _a.copy(from).addScaledVector(_d, len * 0.5);
  out.compose(_a, _q, _one);
  return out;
}

/**
 * Writes one figure's part transforms.
 *
 * `out` is filled in a FIXED ORDER — thigh L, thigh R, shin L, shin R, torso,
 * upper arm L, upper arm R, forearm L, forearm R — which is the order
 * `CREW_PARTS` and `CREW_PART_COUNT` describe and the order the instanced rig
 * indexes by. Nine matrices, written into caller-owned objects: this runs for
 * twenty-one figures every frame and must not allocate.
 */
export function writeCrewMatrices(j: CrewJoints, out: THREE.Matrix4[]): void {
  boneMatrix(j.knee[0], j.hip, BONE.thigh, out[0]);
  boneMatrix(j.knee[1], j.hip, BONE.thigh, out[1]);
  boneMatrix(j.ankle[0], j.knee[0], BONE.shin, out[2]);
  boneMatrix(j.ankle[1], j.knee[1], BONE.shin, out[3]);
  boneMatrix(j.hip, j.chest, BONE.spine, out[4]);
  boneMatrix(j.elbow[0], j.shoulder[0], BONE.upperArm, out[5]);
  boneMatrix(j.elbow[1], j.shoulder[1], BONE.upperArm, out[6]);
  boneMatrix(j.hand[0], j.elbow[0], BONE.forearm, out[7]);
  boneMatrix(j.hand[1], j.elbow[1], BONE.forearm, out[8]);
}

/**
 * The same figure, flattened into one geometry in the team's colour.
 *
 * For the crowd of people who never move. The vertex-colour weights above are
 * resolved against the team colour here, so a merged figure comes out with the
 * same boots, gloves and visor as an instanced one.
 */
export function mergeCrewFigure(
  posture: Posture, overalls: number, detail: CrewDetail,
): THREE.BufferGeometry {
  const parts = crewPartGeometries(detail);
  const joints = poseCrew(posture, makeCrewJoints());
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < CREW_INSTANCES_PER_FIGURE; i++) mats.push(new THREE.Matrix4());
  writeCrewMatrices(joints, mats);

  const order: CrewPartId[] = [
    'thigh', 'thigh', 'shin', 'shin', 'torso', 'upperArm', 'upperArm', 'forearm', 'forearm',
  ];
  const bin = new PartsBin();
  const col = new THREE.Color(overalls);
  const tmp = new THREE.Color();
  for (let i = 0; i < order.length; i++) {
    const src = parts[order[i]];
    const g = src.clone();
    g.applyMatrix4(mats[i]);
    // Resolve the weight against the team colour. The instanced path leaves
    // this to the shader; here there is no instance colour to multiply by.
    const attr = g.getAttribute('color');
    if (attr) {
      for (let v = 0; v < attr.count; v++) {
        const w = attr.getX(v);
        tmp.copy(col).multiplyScalar(w);
        attr.setXYZ(v, tmp.r, tmp.g, tmp.b);
      }
      attr.needsUpdate = true;
    }
    bin.addPrepared(g);
  }
  for (const id of CREW_PARTS) parts[id].dispose();
  return bin.merge() ?? chamferBox(0.4, 1.7, 0.3, 0.05);
}

// ===========================================================================
// Equipment
// ===========================================================================

/**
 * The three things a crew holds, as geometries lying in a hand's frame.
 *
 * Instanced alongside the people. A wheel gun is the single most recognisable
 * object at a pit stop after the car itself, and four of them going at once is
 * most of what a stop LOOKS like.
 */
export function crewToolGeometries(detail: CrewDetail): {
  gun: THREE.BufferGeometry;
  tyre: THREE.BufferGeometry;
  jack: THREE.BufferGeometry;
} {
  // The gun: body, grip and the long socket that goes on the nut. Modelled
  // pointing along +Z, origin at the hands.
  const gunBin = new PartsBin();
  const body = chamferBox(0.15, 0.17, 0.28, 0.03);
  gunBin.add(body, wt(0.95), 0, 0.02, 0.02);
  body.dispose();
  const grip = chamferBox(0.09, 0.16, 0.10, 0.025);
  gunBin.add(grip, wt(0.3), 0, -0.12, -0.02);
  grip.dispose();
  const socket = chamferCylinder(0.048, 0.34, detail.round, 0.015);
  gunBin.addAt(socket, wt(0.55),
    new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.02, 0.31));
  socket.dispose();
  const hose = chamferCylinder(0.028, 0.5, detail.round, 0.01);
  gunBin.addAt(hose, wt(0.2),
    new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, -0.06, -0.32));
  hose.dispose();

  // The tyre: a 720mm slick on a rim, axis along X so it rolls the right way
  // when it is held at a hub.
  const tyreBin = new PartsBin();
  const rubber = chamferCylinder(0.36, 0.34, detail.round, 0.05);
  tyreBin.addAt(rubber, wt(0.06), new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  rubber.dispose();
  const rim = chamferCylinder(0.202, 0.35, detail.round, 0.02);
  tyreBin.addAt(rim, wt(0.75), new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  rim.dispose();

  // The jack: a long handle with the lifting arm and the nose hook on the end.
  const jackBin = new PartsBin();
  const handle = chamferCylinder(0.032, 1.65, detail.round, 0.012);
  jackBin.addAt(handle, wt(0.9),
    new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 0.8));
  handle.dispose();
  const arm = chamferBox(0.5, 0.07, 0.09, 0.02);
  jackBin.add(arm, wt(0.9), 0, -0.02, 1.6);
  arm.dispose();
  const wheelG = chamferCylinder(0.075, 0.05, detail.round, 0.01);
  for (const s of [-1, 1]) {
    jackBin.addAt(wheelG, wt(0.25),
      new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(s * 0.24, -0.06, 1.6));
  }
  wheelG.dispose();

  return {
    gun: gunBin.merge() ?? chamferBox(0.1, 0.1, 0.1, 0),
    tyre: tyreBin.merge() ?? chamferBox(0.1, 0.1, 0.1, 0),
    jack: jackBin.merge() ?? chamferBox(0.1, 0.1, 0.1, 0),
  };
}
