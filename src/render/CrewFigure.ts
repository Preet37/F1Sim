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

/** How high off the ground a kneeling knee sits, metres — the pad plus the leg. */
const KNEE_GROUND_M = 0.11;

// ===========================================================================
// One particular person
// ===========================================================================

/**
 * WHY THIS EXISTS, AND IT IS THE SECOND HALF OF "the people are like legos".
 *
 * The first half was the torso, and it was fixed: three chamfered boxes became
 * oval sections with ball shoulders and a wrapped visor. It did not answer the
 * complaint, because **all twenty-one of them were the same build in one flat
 * team colour, standing in mirror-symmetric poses.** Twenty-one copies of one
 * good figure is a shelf of one good figure, and a shelf of identical figures is
 * what a box of Lego actually is — the giveaway is not that a piece is blocky,
 * it is that every piece is the same piece.
 *
 * A crew reads as twenty-one people when three things are true, and they are the
 * three fields below:
 *
 *   - they are not all the same SIZE. `reference/target/89.png` is two people in
 *     race kit standing next to each other and the first thing it shows is that
 *     one is taller and heavier than the other;
 *   - they are not all wearing the same flat colour. Real kit is a team colour
 *     with a contrasting yoke, sleeves and helmet — the same picture again;
 *   - and they are not all standing symmetrically. Every reference photograph of
 *     a crew waiting for a car has somebody down on ONE knee.
 *
 * All three are carried per figure with **no extra geometry and no extra draw
 * call**: size and girth ride in the per-part instance MATRIX, colour rides in
 * the per-part instance COLOUR, and the kneeling side is a pose parameter. The
 * cost of twenty-one different people is therefore the same as the cost of
 * twenty-one identical ones, which is the only reason it is affordable to do at
 * all.
 */
export interface CrewBuild {
  /** Overall stature as a multiple of the 1.78m reference figure. */
  height: number;
  /** Trunk and limb girth, radially. 1 is the reference figure. */
  girth: number;
  /** Which knee goes down when a posture calls for one: -1 left, +1 right. */
  kneelSide: -1 | 1;
  /** Radians of fore/aft difference between this person's two arms. */
  armBias: number;
  /** This person's contrast colour: 0 charcoal, 1 off-white. */
  accent: 0 | 1;
  /** Does the accent go on the sleeves? */
  accentSleeves: boolean;
  /** Does it go on the lower legs? */
  accentLegs: boolean;
  /** 0 team colour, 1 the accent, 2 the other neutral — the helmet. */
  helmet: 0 | 1 | 2;
}

/**
 * The reference figure: average build, symmetric, and every part of it the one
 * team colour.
 *
 * This is EXACTLY what every crew member was before this file learned about
 * builds — one size, one flat colour, both knees at the same height — which is
 * what makes it the right default for a caller that does not care and the right
 * control arm for a probe that does. `CREW_LEGACY=1 npm run probe:pitcrew`
 * feeds this to all twenty-one and fails 11 anatomy checks.
 */
export const CREW_BUILD_STOCK: CrewBuild = {
  height: 1, girth: 1, kneelSide: 1, armBias: 0,
  accent: 0, accentSleeves: false, accentLegs: false, helmet: 0,
};

/** Deterministic pseudo-random in 0..1. Same generator as `ChamferKit.rand`. */
function r1(seed: number): number {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * One person, from a seed.
 *
 * Deterministic, because the twenty-one people at your garage have to be the
 * same twenty-one people every time you come down the pit lane — a crew that
 * reshuffles its bodies between stops is worse than a crew of clones.
 *
 * The ranges are real adult ranges rather than decorative ones: 1.67m to 1.89m
 * of stature is roughly the 5th to the 95th percentile of adult men, and it is
 * chosen to be visible at the distance the player actually sees a pit box from.
 * Half a percent of variation is a rounding error nobody can see, and this file
 * has to be able to prove the difference.
 */
export function crewBuild(seed: number): CrewBuild {
  const a = r1(seed * 3.7 + 1.3);
  const b = r1(seed * 5.1 + 8.9);
  const c = r1(seed * 2.3 + 17.4);
  const d = r1(seed * 7.9 + 4.1);
  return {
    height: 0.94 + a * 0.12,
    // Girth is correlated with height but not determined by it, which is what
    // stops the tall ones all being the thin ones.
    girth: 0.90 + b * 0.22 + (a - 0.5) * 0.06,
    kneelSide: c < 0.5 ? -1 : 1,
    armBias: (d - 0.5) * 0.34,
    accent: r1(seed * 9.7 + 21.3) < 0.7 ? 0 : 1,
    accentSleeves: r1(seed * 11.3 + 2.7) < 0.55,
    accentLegs: r1(seed * 4.3 + 31.9) < 0.6,
    helmet: (Math.floor(r1(seed * 13.1 + 6.5) * 3) % 3) as 0 | 1 | 2,
  };
}

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
  /**
   * How far ONE knee goes down to the ground, 0..1.
   *
   * A magnitude and not a side: which knee is a property of the PERSON
   * (`CrewBuild.kneelSide`), not of the job they are doing, so four gunmen in
   * the same posture are not four people kneeling on the same knee. Keeping it
   * unsigned is also what lets `blendPosture` interpolate it — lerping a
   * left-kneel towards a right-kneel through zero would stand the figure up in
   * the middle of a transition, which is not a thing a person does.
   *
   * At 1 the knee is on the ground, the shin lies back along it, and the other
   * foot is flat and forward. That is the pose in every reference photograph of
   * a crew set and waiting, and until now no figure in the pit lane had it.
   */
  kneel: number;
  /**
   * Radians of fore/aft difference between the two arms, before the person's
   * own `armBias` is added.
   *
   * Both arms swung to exactly the same angle is the other half of what makes a
   * figure read as a mannequin, and it is free to fix.
   */
  asymArm: number;
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
    kneel: 0, asymArm: 0.14,
  },
  /**
   * Set and waiting: down on the haunches, weight forward, hands up ready.
   *
   * Properly low. Every reference photograph of a pit crew waiting for a car is
   * of people CROUCHED — often on one knee, hands already out at the height the
   * wheel will be — and a crew standing about upright in the box reads as a
   * group of people who have wandered over to watch. The first version of this
   * was a shallow knee bend and it photographed as exactly that.
   *
   * ONE KNEE DOWN, since #24. "often on one knee" was already written here and
   * the pose did not do it: `poseCrew` solved one leg and mirrored it, so both
   * knees were always at the same height and a row of crouching figures read as
   * a row of the same crouching figure. Now the trailing knee is on the ground
   * and the leading foot is flat, which is what the photographs show and is also
   * why one is different from the next — the side is the person's.
   */
  ready: {
    stance: 1.35, hipPitch: 0.62, kneeBend: 1.30, spineLean: 0.66,
    armPitch: 0.70, elbowBend: 0.75, armSpread: 0.22, crouch: 0.26, shift: 0.05,
    kneel: 0.85, asymArm: 0.10,
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
    kneel: 0.72, asymArm: 0.06,
  },
  /** Holding a tyre against the chest, standing. */
  carry: {
    stance: 1.1, hipPitch: 0.05, kneeBend: 0.22, spineLean: 0.12,
    armPitch: 1.15, elbowBend: 1.05, armSpread: 0.30, crouch: 0.04, shift: 0,
    kneel: 0, asymArm: 0.08,
  },
  /** Crouched with a tyre at hub height, about to push it on. */
  fit: {
    stance: 1.4, hipPitch: 0.55, kneeBend: 1.25, spineLean: 0.62,
    armPitch: 0.85, elbowBend: 0.42, armSpread: 0.32, crouch: 0.26, shift: 0.05,
    kneel: 0.55, asymArm: 0.12,
  },
  /** Bent over a jack handle, both hands low and forward. */
  jack: {
    stance: 1.2, hipPitch: 0.30, kneeBend: 0.70, spineLean: 0.85,
    armPitch: 0.95, elbowBend: 0.22, armSpread: 0.09, crouch: 0.14, shift: 0.04,
    kneel: 0.30, asymArm: 0.05,
  },
  /** Straightening up, driving the jack handle down. */
  jackUp: {
    stance: 1.25, hipPitch: 0.10, kneeBend: 0.35, spineLean: 0.30,
    armPitch: 0.38, elbowBend: 0.30, armSpread: 0.09, crouch: 0.02, shift: 0.02,
    kneel: 0.06, asymArm: 0.05,
  },
  /** Sitting on a pit wall stand at a bank of screens. */
  sit: {
    stance: 1.15, hipPitch: 1.45, kneeBend: 1.5, spineLean: 0.12,
    armPitch: 0.72, elbowBend: 1.05, armSpread: 0.16, crouch: 0, shift: 0,
    kneel: 0, asymArm: 0.18,
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
  out.kneel = a.kneel + (b.kneel - a.kneel) * k;
  out.asymArm = a.asymArm + (b.asymArm - a.asymArm) * k;
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
export function poseCrew(
  p: Posture, out: CrewJoints, build: CrewBuild = CREW_BUILD_STOCK,
): CrewJoints {
  // This person's own bones. Stature is a scale on the SKELETON rather than on
  // the finished figure, so a taller person's shoulders are further apart and
  // their hands reach further, which is the whole of why they look like a
  // different person rather than like the same person drawn bigger.
  const h = build.height;
  const thighL = BONE.thigh * h;
  const shinL = BONE.shin * h;
  const spineL = BONE.spine * h;
  const upperL = BONE.upperArm * h;
  const foreL = BONE.forearm * h;

  // Where the hips end up if BOTH feet are on the ground, which is where they
  // used to end up unconditionally.
  const ty0 = -Math.cos(p.hipPitch);
  const sy0 = -Math.cos(p.hipPitch - p.kneeBend);
  const hipStand = -(thighL * ty0 + shinL * sy0) - p.crouch * 0.12 * h;

  // ...and where they have to be for a knee to be ON THE GROUND, which is a
  // thigh's length above it. THE HIPS COME DOWN TO THE KNEE, not the other way
  // round, and getting that backwards is what made the first attempt at this
  // pose fail: `ready` sits with its hips 0.65m up and a thigh is 0.44m long, so
  // asking the thigh to reach a knee at 0.11m was asking for 0.54m out of 0.44
  // and the solver clamped, hung the thigh straight down, and left the knee
  // 10cm in the air on every figure. A person going down on one knee lowers
  // their whole body; the pit crew are not doing a trick with one leg.
  const kneel = Math.max(0, Math.min(1, p.kneel));
  const hipKneel = thighL + KNEE_GROUND_M * h;
  const hipY = hipStand + (Math.min(hipStand, hipKneel) - hipStand) * kneel;
  const hipZ = p.shift * h;

  out.hip.set(0, hipY, hipZ);

  // The SUPPORT leg then has to be RE-SOLVED, because the hips have moved and
  // its foot still has to be flat on the ground. Its hip angle is the posture's
  // — that is the character of the pose and it is kept — and the knee folds to
  // whatever puts the ankle at y = 0:
  //
  //   ankle.y = hipY + thigh*ty + shin*sy = 0,  sy = -cos(hipPitch - kneeBend)
  //
  // solved for `kneeBend`. Unreachable configurations clamp to a straight leg,
  // which is the honest degenerate answer rather than a foot through the floor.
  const supportCos = Math.max(-1, Math.min(1, (hipY + thighL * ty0) / shinL));
  const supportBend = p.hipPitch + Math.acos(supportCos);

  // The KNEELING leg, solved to put its knee ON the ground rather than posed by
  // eye. Two conditions, in this order:
  //
  //   - the knee is at `KNEE_GROUND_M`: cos(hipPitch) = (hipY - kneeY) / thigh,
  //     which the hip drop above has now made reachable;
  //   - and the shin runs BACK along the ground from it, which in this file's
  //     convention is `shinAngle = -pi/2`, i.e. `kneeBend = hipPitch + pi/2`.
  //
  // Solved rather than authored because the answer depends on the crouch, on
  // the stature, and on which posture is being blended into which — three
  // things a hand-written angle cannot track, and the reason the pose stayed
  // symmetric for as long as it did.
  const kneelReach = Math.max(0.02, hipY - KNEE_GROUND_M * h);
  const kneelHip = Math.acos(Math.max(-1, Math.min(1, kneelReach / thighL)));
  const kneelBend = kneelHip + Math.PI / 2;

  // What a leg does if it is NOT the one going down: the posture's own bend,
  // taken towards the re-solved one as the hips drop. At `kneel = 0` this is
  // the posture's bend exactly, which is why every non-kneeling posture in this
  // file is bit-for-bit what it was.
  const standBend = p.kneeBend + (supportBend - p.kneeBend) * kneel;

  const kneelSide = build.kneelSide > 0 ? 1 : 0;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const k = s === kneelSide ? kneel : 0;
    const hp = p.hipPitch + (kneelHip - p.hipPitch) * k;
    const kb = standBend + (kneelBend - standBend) * k;
    const ltx = Math.sin(hp);
    const lty = -Math.cos(hp);
    const sa = hp - kb;
    const lsx = Math.sin(sa);
    const lsy = -Math.cos(sa);
    const hx = side * HIP_HALF * p.stance * h;
    out.knee[s].set(hx + side * 0.02 * h, hipY + thighL * lty, hipZ + thighL * ltx);
    out.ankle[s].set(
      out.knee[s].x + side * 0.01 * h,
      out.knee[s].y + shinL * lsy,
      out.knee[s].z + shinL * lsx,
    );
  }

  // Spine: up from the hips, tipped forward.
  const cx = Math.sin(p.spineLean);
  const cy = Math.cos(p.spineLean);
  out.chest.set(0, hipY + spineL * cy, hipZ + spineL * cx);

  // Shoulders sit across the top of the chest, in the chest's own frame, so
  // they tip with it.
  //
  // `h * girth` and NOT some other blend of the two, and it is not a taste
  // decision: the torso geometry carries a BALL at ±SHOULDER_HALF and the
  // instanced torso is scaled by exactly `h * girth` across, so this is where
  // that ball ends up. Anything else and the arm starts outside the joint it is
  // meant to come out of — a centimetre and a half of daylight at the shoulder
  // on the tallest figure, which was in the first version of this.
  const span = SHOULDER_HALF * h * build.girth;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    out.shoulder[s].set(
      side * span,
      out.chest.y + 0.115 * h * cy,
      out.chest.z + 0.115 * h * cx,
    );
    // Arms hang from the shoulder and swing forward in the WORLD frame, not
    // the chest's: a man folded over a wheel has his arms hanging straight
    // down to it, not sticking out horizontally in line with his back.
    //
    // ...and the two arms are NOT at the same angle. `asymArm` is the posture's
    // own difference, `armBias` is this person's; both are applied with opposite
    // signs to the two sides, so no figure has two arms doing the same thing and
    // no two figures have the same difference.
    const swing = p.armPitch + side * (p.asymArm + build.armBias) * 0.5;
    const ax = Math.sin(swing);
    const ay = -Math.cos(swing);
    const spread = side * p.armSpread;
    out.elbow[s].set(
      out.shoulder[s].x + spread * upperL,
      out.shoulder[s].y + ay * upperL,
      out.shoulder[s].z + ax * upperL,
    );
    const fa = swing + p.elbowBend;
    const fx = Math.sin(fa);
    const fy = -Math.cos(fa);
    out.hand[s].set(
      out.elbow[s].x + spread * foreL * 0.4,
      out.elbow[s].y + fy * foreL,
      out.elbow[s].z + fx * foreL,
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
 *   - the HEAD, NECK, HELMET and VISOR are ONE part of their own. They used to
 *     be merged into the torso, and that was what made per-person girth
 *     impossible: the torso's instance scale is how a heavier person is drawn,
 *     and with the helmet inside it a heavier person also got a bigger head.
 *     A head is the single most size-sensitive thing on a figure, and twelve per
 *     cent of one is visible from across a pit lane. Split out, it costs one
 *     more draw call for the whole crew and it buys both the girth and a helmet
 *     that is not obliged to be the same colour as the overalls.
 *
 * Ten instances per figure across six draw calls is what makes twenty-one
 * animated, individually built people affordable.
 */
export type CrewPartId = 'thigh' | 'shin' | 'torso' | 'head' | 'upperArm' | 'forearm';

export const CREW_PARTS: readonly CrewPartId[] =
  ['thigh', 'shin', 'torso', 'head', 'upperArm', 'forearm'];

/** How many of each part one figure has. */
export const CREW_PART_COUNT: Record<CrewPartId, number> = {
  thigh: 2, shin: 2, torso: 1, head: 1, upperArm: 2, forearm: 2,
};

/** Total instances one figure occupies. */
export const CREW_INSTANCES_PER_FIGURE = 10;

/**
 * The order `writeCrewMatrices` fills, and the order the instanced rig indexes.
 *
 * Exported because two other files and a probe all have to agree about it, and
 * three copies of a nine-element list is three chances to be one out.
 */
export const CREW_SLOT_PARTS: readonly CrewPartId[] = [
  'thigh', 'thigh', 'shin', 'shin', 'torso', 'head',
  'upperArm', 'upperArm', 'forearm', 'forearm',
];

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
 * The colours a figure's ten instance slots are drawn in.
 *
 * ONE INSTANCE COLOUR PER PART, not one per figure, and that is the whole of the
 * "flat team colour" half of the complaint. `vertexColors` multiplies the baked
 * weight by the instance colour, so the weight can only ever produce a DARKER OR
 * LIGHTER VERSION OF THE SAME HUE — twenty-one people in five shades of one
 * colour, which is a uniform and not a kit. Real race kit, and
 * `reference/target/89.png` is two examples of it side by side, is a team colour
 * with a CONTRASTING yoke and sleeves and a helmet that need not match either.
 *
 * The instance colour is already allocated and already written once per team, so
 * this costs nothing: it writes ten different colours where it used to write the
 * same one ten times.
 *
 * Team identity survives because the TORSO and the THIGHS are always the team's
 * colour and they are most of the figure's area. Only the sleeves, the shins and
 * the helmet vary, which is exactly what varies on a real crew.
 */
const _t = new THREE.Color();
const _acc = new THREE.Color();
/**
 * The light neutral.
 *
 * NOT white. Photographed in the pit lane at 0.82 it read as bare bone rather
 * than as a light panel on a suit — an arm brighter than the garage floor stops
 * being fabric. 0.60 sits it below the concrete and above the charcoal, which
 * is where a light grey suit panel actually sits.
 */
const _pale = new THREE.Color(0.60, 0.60, 0.58);

export function crewPartColours(
  teamColour: THREE.ColorRepresentation, build: CrewBuild, out: THREE.Color[],
): THREE.Color[] {
  _t.set(teamColour);
  // The two neutrals a race suit is actually trimmed in: a charcoal (kept
  // slightly warm rather than pure grey, so it does not read as a hole in the
  // figure under a night sky) and an off-white. Which one is this person's is
  // their own; where it goes is their own too.
  _acc.setRGB(0.13, 0.125, 0.135);
  const accent = build.accent === 0 ? _acc : _pale;
  const other = build.accent === 0 ? _pale : _acc;
  const sleeve = build.accentSleeves ? accent : _t;
  const shin = build.accentLegs ? accent : _t;
  const helmet = build.helmet === 0 ? _t : build.helmet === 1 ? accent : other;
  // thigh L, thigh R, shin L, shin R, torso, head, upper L, upper R, fore L, fore R
  out[0].copy(_t); out[1].copy(_t);
  out[2].copy(shin); out[3].copy(shin);
  out[4].copy(_t);
  out[5].copy(helmet);
  out[6].copy(sleeve); out[7].copy(sleeve);
  out[8].copy(sleeve); out[9].copy(sleeve);
  return out;
}

/** Ten scratch colours, for callers that do not want to allocate. */
export function makeCrewPartColours(): THREE.Color[] {
  return Array.from({ length: CREW_INSTANCES_PER_FIGURE }, () => new THREE.Color());
}

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
      // NO BOXES. A torso is the largest single piece of a figure and it is
      // what the eye reads first, so a chamfered slab there is the whole of
      // "obv forget about the lego people" no matter how good the limbs are:
      // capsule arms hanging off a rectangle still make a rectangle with arms.
      //
      // So the trunk is three OVAL sections — pelvis, waist, chest — each a
      // capsule squashed across and stretched wide, which is what a human trunk
      // actually is in section: wider than it is deep, rounded everywhere, and
      // tapered at the waist. The taper IS the silhouette. Costs about ninety
      // triangles more than the boxes did, on nine figures' worth of instances.
      const half = BONE.spine * 0.5;
      const oval = (
        len: number, wide: number, deep: number, y: number, z = 0,
      ): void => {
        const g = limbGeometry(wide * 0.5, Math.max(0.01, len - wide), detail.limb, 3);
        scaleWithNormals(g, 1, 1, deep / wide);
        g.translate(0, y, z);
        bin.addRaw(g, wt(W_KIT));
      };
      // Hips: short and wide. Chest: taller, wider still, and deeper.
      oval(0.24, 0.33, 0.235, -half + 0.07);
      oval(BONE.spine * 0.70, 0.245, 0.185, 0);
      oval(0.30, 0.40, 0.255, half - 0.05);
      // The bib panel across the chest of every set of racing overalls, curved
      // onto it rather than laid flat, so it reads as fabric and not a badge.
      const bib = limbGeometry(0.145, 0.02, detail.limb, 2);
      scaleWithNormals(bib, 1, 1, 0.16);
      bib.rotateX(Math.PI / 2);
      bib.translate(0, half - 0.05, 0.10);
      bin.addRaw(bib, wt(W_PANEL));
      // Shoulder caps: balls, so the arm comes out of a joint rather than out
      // of the corner of a block.
      const cap = ball(0.088, detail.head);
      for (const s of [-1, 1]) bin.add(cap, wt(W_KIT), s * SHOULDER_HALF, half - 0.02, 0);
      cap.dispose();
      // The neck stub stays with the torso so the collar is never a floating
      // ring when a heavier person's trunk is scaled wider than their head.
      const neck = limbGeometry(0.058, 0.06, detail.limb, 2);
      neck.translate(0, half + 0.045, 0.005);
      bin.addRaw(neck, wt(W_DARK));
    }),
    // The helmet, as its own part, centred on its own origin. There is no head
    // inside it: everyone over the wall is wearing a full-face helmet and
    // nobody takes theirs off, which is also what keeps skin out of the figure
    // entirely and lets the whole thing be instance-coloured.
    head: mk((bin) => {
      const shell = scaleWithNormals(ball(0.133, detail.head), 1.0, 1.07, 1.03);
      bin.addRaw(shell, wt(W_HELMET));
      // The visor: a band wrapped round the front of the shell rather than a
      // slab stuck on it. Same reason as the bib.
      const visor = scaleWithNormals(ball(0.136, detail.head), 1.0, 0.30, 1.03);
      visor.translate(0, 0.005, 0.002);
      bin.addRaw(visor, wt(W_VISOR));
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
const _scale = new THREE.Vector3(1, 1, 1);

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
  girth = 1,
): THREE.Matrix4 {
  _d.subVectors(to, from);
  const d = _d.length();
  if (d < 1e-5) {
    out.makeTranslation(from.x, from.y, from.z);
    return out;
  }
  _d.divideScalar(d);
  _q.setFromUnitVectors(_up, _d);
  // Span, not the nominal length: with a stature scale on the skeleton the two
  // are no longer the same number, and a part placed by the nominal length
  // stops reaching its own joints the moment a person is not 1.78m tall.
  _a.copy(from).addScaledVector(_d, d * 0.5);
  // Scale in the PART's own frame — along the bone for stature, across it for
  // girth — which composes as T·R·S and therefore cannot shear. A non-uniform
  // scale applied outside the rotation would, and a sheared forearm is worse
  // than a plain one.
  _scale.set(girth, d / Math.max(len, 1e-6), girth);
  out.compose(_a, _q, _scale);
  return out;
}

/**
 * Writes one figure's part transforms.
 *
 * `out` is filled in the order `CREW_SLOT_PARTS` states — thigh L, thigh R,
 * shin L, shin R, torso, head, upper arm L, upper arm R, forearm L, forearm R —
 * which is the order `CREW_PART_COUNT` describes and the order the instanced rig
 * indexes by. Ten matrices, written into caller-owned objects: this runs for
 * twenty-one figures every frame and must not allocate.
 *
 * `build` is where a person's girth arrives: it is a scale in each PART's own
 * frame, so it costs nothing at all — no second geometry, no second draw call,
 * no second material. The trunk carries slightly more of it than the limbs
 * because that is where the difference between two builds actually shows.
 */
export function writeCrewMatrices(
  j: CrewJoints, out: THREE.Matrix4[], build: CrewBuild = CREW_BUILD_STOCK,
): void {
  // Every radial scale carries the STATURE as well as the girth. A taller
  // person is a wider person at the same build, and — more importantly — the
  // torso's own across-scale is what puts its shoulder balls where `poseCrew`
  // has just put the shoulder joints. The two have to be the same product.
  const g = build.girth * build.height;
  const limb = build.height * (1 + (build.girth - 1) * 0.75);
  boneMatrix(j.knee[0], j.hip, BONE.thigh, out[0], limb);
  boneMatrix(j.knee[1], j.hip, BONE.thigh, out[1], limb);
  boneMatrix(j.ankle[0], j.knee[0], BONE.shin, out[2], limb);
  boneMatrix(j.ankle[1], j.knee[1], BONE.shin, out[3], limb);
  boneMatrix(j.hip, j.chest, BONE.spine, out[4], g);
  // The helmet: on top of the spine, carried by the spine's own direction, and
  // scaled by STATURE ONLY. A wider person does not have a wider head, and the
  // whole reason this is a separate part is that while it lived inside the
  // torso it had no choice.
  _d.subVectors(j.chest, j.hip);
  const spineLen = _d.length() || 1;
  _d.divideScalar(spineLen);
  _q.setFromUnitVectors(_up, _d);
  _a.copy(j.chest).addScaledVector(_d, 0.20 * build.height);
  _scale.setScalar(build.height);
  out[5].compose(_a, _q, _scale);
  boneMatrix(j.elbow[0], j.shoulder[0], BONE.upperArm, out[6], limb);
  boneMatrix(j.elbow[1], j.shoulder[1], BONE.upperArm, out[7], limb);
  boneMatrix(j.hand[0], j.elbow[0], BONE.forearm, out[8], limb);
  boneMatrix(j.hand[1], j.elbow[1], BONE.forearm, out[9], limb);
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
  build: CrewBuild = CREW_BUILD_STOCK,
): THREE.BufferGeometry {
  const parts = crewPartGeometries(detail);
  const joints = poseCrew(posture, makeCrewJoints(), build);
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < CREW_INSTANCES_PER_FIGURE; i++) mats.push(new THREE.Matrix4());
  writeCrewMatrices(joints, mats, build);

  const colours = crewPartColours(overalls, build, makeCrewPartColours());
  const bin = new PartsBin();
  const tmp = new THREE.Color();
  for (let i = 0; i < CREW_SLOT_PARTS.length; i++) {
    const src = parts[CREW_SLOT_PARTS[i]];
    const g = src.clone();
    g.applyMatrix4(mats[i]);
    // Resolve the weight against this SLOT's colour. The instanced path leaves
    // this to the shader; here there is no instance colour to multiply by, and
    // it has to be the slot's rather than the figure's or a merged mechanic
    // loses the contrasting sleeves an instanced one has.
    const attr = g.getAttribute('color');
    if (attr) {
      for (let v = 0; v < attr.count; v++) {
        const w = attr.getX(v);
        tmp.copy(colours[i]).multiplyScalar(w);
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
