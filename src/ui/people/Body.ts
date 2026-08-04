import { headGeometry, type HeadGeometry } from './Face';
import type { PersonLook } from './Look';

/**
 * The skeleton.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `Figure.ts` used to draw a body by writing path strings straight out of a
 * handful of ratios. Three things came out of that and all three shipped:
 *
 *   · The podium's raised arm was ONE ROUND-CAPPED STROKE of constant width
 *     that started in the middle of the chest. No elbow, no wrist, no hand
 *     joined to anything — the hand was a separate ellipse placed at a
 *     hard-coded offset, and the trophy at a second hard-coded offset near it.
 *     Move the shoulder and all three drift apart silently.
 *   · The garage crew had an upper arm and nothing below it, drawn in the suit
 *     colour BEHIND the torso, so it was invisible: armless torsos.
 *   · Nothing could be asserted. A path string is not a body, and a probe
 *     reading one can only check it for `NaN`.
 *
 * So the body is now a RIG: joints with positions, bones between them with a
 * width at each end, hands and feet at the ends of the chains, and a grip frame
 * per hand that a held object is placed by. `Figure.ts` draws the rig and draws
 * nothing that is not in it. `probe:people` reads the DRAWN POLYGONS back out
 * of the markup and checks that they overlap where the rig says a joint is —
 * so a hand that is not attached to a forearm cannot pass, whatever the rig
 * claims.
 *
 * ---------------------------------------------------------------------------
 * PROPORTION
 * ---------------------------------------------------------------------------
 *
 * Everything is a multiple of H, the crown-to-chin height of that person's own
 * head, so a long-faced heavy principal and a slight driver are the same body
 * plan at different sizes. The canon is the seven-and-a-half-head figure, and
 * the stations below are measured off it from the crown:
 *
 *     crown 0 · chin 1.00 · shoulder 1.30 · waist 2.45 · hip 3.55
 *     knee 5.10 · ankle 6.95 · floor 7.25
 *
 * The head half of that (`headGeometry`) is fixed: chin at y=168 in a 200-wide
 * box. This file continues downward from it, which is why every station below
 * is written relative to `shoulderY` rather than to the top of the box.
 *
 * ---------------------------------------------------------------------------
 * POSE
 * ---------------------------------------------------------------------------
 *
 * A pose is joint ANGLES, not path coordinates. `standing`, `walking`,
 * `raised` and `applaud` are one table of numbers each; `seated` is the one
 * exception and it is solved rather than posed, because a press conference has
 * a desk in it at a stated height and the hands have to land ON it — see
 * `seatedArm`.
 *
 * Angles are degrees from straight down, positive swinging AWAY from the
 * body's centreline and negative swinging ACROSS it. So 0 is a hanging arm, 90
 * is out sideways, 180 is straight up, -120 is a forearm folded up across the
 * chest — and the same number works for both sides, because `step` applies the
 * side. The first version of this table negated the right-hand column as well,
 * which mirrored it twice: every "outward" number came out pointing inward and
 * a standing figure's two hands met at the crotch.
 */

// ===========================================================================
// Primitives
// ===========================================================================

export interface P { x: number; y: number }

/** A bone: a tapered segment from `a` to `b`, `wa` wide at `a`, `wb` at `b`. */
export interface Bone {
  id: string;
  a: P;
  b: P;
  wa: number;
  wb: number;
  /** 'l' is frame-left (the person's right). */
  side: 'l' | 'r';
  /** Drawn behind the torso. The far arm of a turned figure, and the far leg. */
  behind: boolean;
}

/** Where a held object is gripped, and which way the fist points. */
export interface Grip {
  x: number;
  y: number;
  /** Degrees, 0 = the object stands upright out of the fist. */
  angle: number;
}

export interface Hand {
  id: string;
  c: P;
  /** Along the forearm, degrees from straight down. */
  angle: number;
  len: number;
  wid: number;
  side: 'l' | 'r';
  behind: boolean;
  /** A flat hand resting on a surface rather than a loose fist. */
  flat: boolean;
  grip: Grip;
}

export interface Foot {
  id: string;
  c: P;
  len: number;
  hgt: number;
  side: 'l' | 'r';
  behind: boolean;
  /** Degrees the boot points; positive turns the toe outward. */
  angle: number;
}

export type Pose = 'seated' | 'standing' | 'raised' | 'applaud' | 'walking';

export interface Rig {
  pose: Pose;
  g: HeadGeometry;
  /** Head height. The unit everything else is in. */
  H: number;
  cx: number;
  shoulderY: number;
  /** Half the shoulder width, and half the hip width. */
  sh: number;
  hipHalf: number;
  waistY: number;
  hipY: number;
  /** The sole. Where a standing figure meets the ground. */
  floorY: number;
  /** The closed torso outline, as drawn. */
  torso: P[];
  bones: Bone[];
  hands: Hand[];
  feet: Foot[];
  /** Where a desk crosses the figure. `seated` only; NaN otherwise. */
  deskY: number;
  /**
   * The bottom of the frame this pose wants. A standing figure is cut at the
   * floor; a seated one at the desk; a podium figure below the knee.
   */
  frameBottom: number;
  /** The top of the frame, which a raised arm pushes above the crown. */
  frameTop: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const RAD = Math.PI / 180;

/** A point `len` from `o`, at `deg` from straight down, swung by `side`. */
function step(o: P, deg: number, len: number, side: number): P {
  return {
    x: o.x + side * Math.sin(deg * RAD) * len,
    y: o.y + Math.cos(deg * RAD) * len,
  };
}

// ===========================================================================
// Polygons — what is actually drawn, and what the probe measures
// ===========================================================================

/**
 * A tapered capsule, as an explicit closed polygon.
 *
 * NOT A STROKE. The old raised arm was `stroke-width="..."` on a curve, and a
 * stroke has exactly one width along its whole length — which is the geometric
 * definition of the thing the user rejected. A limb narrows from shoulder to
 * elbow and from elbow to wrist, and the taper is most of what separates an arm
 * from a stick. `probe:people` measures the drawn width at five stations and
 * fails a limb whose narrow end is more than 92% of its wide end.
 *
 * The ends are semicircular caps, which is what makes two bones sharing a joint
 * overlap into one continuous limb whatever the angle between them.
 */
export function capsule(a: P, b: P, wa: number, wb: number, seg = 12): P[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  // Normal, pointing to the left of a→b.
  const nx = -uy;
  const ny = ux;
  const ra = wa / 2;
  const rb = wb / 2;
  const out: P[] = [];
  const base = Math.atan2(ny, nx);
  // Cap at `a`, swung the long way round behind it.
  for (let i = 0; i <= seg; i++) {
    const t = base + Math.PI * (i / seg);
    out.push({ x: a.x + Math.cos(t) * ra, y: a.y + Math.sin(t) * ra });
  }
  // Cap at `b`.
  for (let i = 0; i <= seg; i++) {
    const t = base - Math.PI + Math.PI * (i / seg);
    out.push({ x: b.x + Math.cos(t) * rb, y: b.y + Math.sin(t) * rb });
  }
  return out;
}

/**
 * A closed outline through a ring of control points.
 *
 * Centripetal Catmull-Rom, sampled. The output is a POLYGON rather than a set
 * of cubics on purpose: what the probe measures is then exactly what the
 * renderer fills, with no flattening error in between, and point-in-polygon is
 * the only geometry primitive the probe needs.
 */
export function smoothClosed(pts: readonly P[], per = 6, tension = 0.5): P[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < per; s++) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const m1x = tension * (p2.x - p0.x);
      const m1y = tension * (p2.y - p0.y);
      const m2x = tension * (p3.x - p1.x);
      const m2y = tension * (p3.y - p1.y);
      out.push({
        x: (2 * t3 - 3 * t2 + 1) * p1.x + (t3 - 2 * t2 + t) * m1x
          + (-2 * t3 + 3 * t2) * p2.x + (t3 - t2) * m2x,
        y: (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * m1y
          + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * m2y,
      });
    }
  }
  return out;
}

/**
 * A hand.
 *
 * Four fingers as ONE mass with three shallow notches in the end of it, and a
 * thumb as a separate lobe off the side. That is the whole anatomy, and the
 * ratio behind it is the one that matters at these sizes: a hand is about
 * three quarters the length of the face and the palm is half of that.
 *
 * The module's original comment argued for no hands at all — *"a five-fingered
 * hand at forty pixels is five pixels of noise"* — and it was half right. Five
 * separated fingers are noise. A hand-shaped MASS is not optional: it is what
 * makes an arm terminate rather than stop, and `reference/target/81.png` puts
 * six of them on a desk in the middle of the frame.
 */
export function handPolygon(h: Hand): P[] {
  const s = h.side === 'l' ? -1 : 1;
  const c = h.c;
  const L = h.len;
  const W = h.wid * (h.flat ? 1.16 : 1.0);
  const a = h.angle;
  // Local frame: `along` runs from wrist to fingertip, `across` to the thumb.
  const al = { x: s * Math.sin(a * RAD), y: Math.cos(a * RAD) };
  const ac = { x: -al.y * s, y: al.x * s };
  const at = (u: number, v: number): P => ({
    x: c.x + al.x * u + ac.x * v * s,
    y: c.y + al.y * u + ac.y * v * s,
  });
  const w = W / 2;
  const pts: P[] = [
    at(-L * 0.50, -w * 0.82),            // wrist, thumb side
    at(-L * 0.16, -w * 1.02),
    at(L * 0.02, -w * 1.26),             // knuckle of the index
    at(L * 0.30, -w * 1.16),
    at(L * 0.46, -w * 0.74),             // fingertips
    at(L * 0.50, -w * 0.16),
    at(L * 0.44, w * 0.40),
    at(L * 0.30, w * 0.86),
    at(L * 0.04, w * 1.00),              // little-finger side
    at(-L * 0.22, w * 0.92),
    at(-L * 0.48, w * 0.70),
  ];
  const body = smoothClosed(pts, 4, 0.42);
  // The thumb: a lobe off the index side, angled forward. Drawn as part of the
  // same polygon by splicing a capsule's hull into it would be fussier than it
  // is worth — it is a separate closed shape in the same colour, and the probe
  // treats the hand as the union of the two by taking the larger.
  return body;
}

/** The thumb, as its own lobe. Same fill, drawn under the palm. */
export function thumbPolygon(h: Hand): P[] {
  const s = h.side === 'l' ? -1 : 1;
  const a = h.angle;
  const al = { x: s * Math.sin(a * RAD), y: Math.cos(a * RAD) };
  const ac = { x: -al.y * s, y: al.x * s };
  const at = (u: number, v: number): P => ({
    x: h.c.x + al.x * u + ac.x * v * s,
    y: h.c.y + al.y * u + ac.y * v * s,
  });
  const w = h.wid / 2;
  const root = at(-h.len * 0.30, -w * 0.55);
  const tip = at(h.len * (h.flat ? 0.16 : 0.06), -w * (h.flat ? 1.85 : 1.55));
  return capsule(root, tip, h.wid * 0.50, h.wid * 0.36, 8);
}

/** A boot. Flat sole, a rounded toe, and an ankle cuff. */
export function footPolygon(f: Foot): P[] {
  const s = f.side === 'l' ? -1 : 1;
  const toe = s * Math.cos(f.angle * RAD) * f.len;
  const heel = -toe * 0.34;
  const y0 = f.c.y - f.hgt;
  const y1 = f.c.y;
  return smoothClosed([
    { x: f.c.x + heel * 0.9, y: y0 - f.hgt * 0.55 },
    { x: f.c.x + toe * 0.34, y: y0 - f.hgt * 0.35 },
    { x: f.c.x + toe * 0.86, y: y0 + f.hgt * 0.32 },
    { x: f.c.x + toe, y: y1 - f.hgt * 0.10 },
    { x: f.c.x + toe * 0.96, y: y1 },
    { x: f.c.x + heel, y: y1 },
    { x: f.c.x + heel * 1.06, y: y1 - f.hgt * 0.45 },
  ], 4, 0.34);
}

// ===========================================================================
// The rig
// ===========================================================================

/**
 * How each pose holds itself.
 *
 * `[shoulder, elbow]` and `[hip, knee]` are degrees from straight down; the
 * elbow and knee numbers are ADDED to the segment above them, so a bend is a
 * bend whatever the shoulder is doing. `l` is frame-left.
 */
interface PoseSpec {
  armL: [number, number];
  armR: [number, number];
  legL: [number, number];
  legR: [number, number];
  /** Which arm is drawn behind the torso. Neither, on a front-on figure. */
  behindArm?: 'l' | 'r';
  behindLeg?: 'l' | 'r';
  legs: boolean;
  /** The hand is open and flat rather than a loose fist. */
  flatHands?: boolean;
}

const POSES: Readonly<Record<Exclude<Pose, 'seated'>, PoseSpec>> = {
  // Arms hang, not quite straight and not quite parallel — a person standing
  // still is never symmetric, and the three degrees between the two sides is
  // the whole difference between a person and a mannequin.
  standing: {
    armL: [15, 5], armR: [12, 8],
    legL: [3, -2], legR: [-2.5, -1.5],
    legs: true,
  },
  // Mid-stride, the near leg forward, one arm swinging across the body.
  // `reference/target/89.png`.
  walking: {
    armL: [18, 3], armR: [11, 13],
    legL: [11, -8], legR: [-10, 15],
    legs: true, behindLeg: 'r',
  },
  // Both arms up. `reference/target/82.png`: the winner has both hands above
  // his head, and one arm up with the other hanging is a man hailing a taxi.
  raised: {
    armL: [168, 8], armR: [165, 11],
    legL: [5, -3], legR: [-4, -2],
    legs: true,
  },
  // Applauding: upper arms almost vertical, forearms folded UP AND ACROSS so
  // the hands meet in front of the chest — what second and third are doing in
  // 82.png while the winner has his arms up. The forearm angle is negative
  // because it crosses the centreline.
  applaud: {
    armL: [9, -132], armR: [8, -128],
    legL: [4, -2], legR: [-3, -2],
    legs: true, flatHands: true,
  },
};

export interface RigOptions {
  pose?: Pose;
  /**
   * Where the desk top is, in figure space. `seated` only. Defaults to the
   * station this file derives, which is what `PressConference.ts` reads back
   * so that the desk it draws and the hands resting on it are the same number.
   */
  deskY?: number;
}

/**
 * The station a seated figure's desk sits at, for that person's head.
 *
 * `PressConference.ts` reads this back and places the desk it draws on the same
 * number, per person, which is the whole fix for six hands that were behind a
 * slab: the desk used to be at a hard-coded 281.9 while the hands were placed
 * off each person's own head height, so they agreed for exactly one build.
 *
 * A tall person's shoulders are further above a desk than a short one's, so the
 * offset shrinks with `height` and the panel ends up with people of visibly
 * different sizes sitting at one desk.
 */
export function seatedDeskY(look: PersonLook): number {
  const g = headGeometry(look);
  return g.chinY + g.h * 0.30 + g.h * lerp(1.02, 1.26, look.height);
}

/** The sole of a standing figure, for that person. */
export function figureFloorY(look: PersonLook): number {
  return buildRig(look, { pose: 'standing' }).floorY;
}

/**
 * The rig, for one person in one pose.
 *
 * Pure geometry. No colours, no markup, no DOM — which is what lets
 * `probe:people` build ten thousand of these in node and check every joint.
 */
export function buildRig(look: PersonLook, opts: RigOptions = {}): Rig {
  const pose: Pose = opts.pose ?? 'seated';
  const g = headGeometry(look);
  const H = g.h;
  const cx = g.cx;
  const shoulderY = g.chinY + H * 0.30;

  // Shoulders are about twice as wide as the skull on anybody, and the whole
  // range from slight to heavy is the last quarter of that. Unchanged from the
  // original body — it was the one ratio in it that was right.
  const sh = g.hw * lerp(1.80, 2.46, look.build);
  const hipHalf = sh * lerp(0.78, 0.94, look.build);
  const girth = lerp(0.84, 1.26, look.build);
  const legScale = lerp(0.93, 1.07, look.height);

  const waistY = shoulderY + H * 1.15;
  const hipY = shoulderY + H * 2.25;

  const upperLen = H * 1.05;
  const foreLen = H * 1.05;
  const handLen = H * 0.66;
  const handWid = H * 0.275 * girth;
  const thighLen = H * 1.55 * legScale;
  const shinLen = H * 1.85 * legScale;
  const footLen = H * 0.60;
  const footHgt = H * 0.20;

  const bones: Bone[] = [];
  const hands: Hand[] = [];
  const feet: Foot[] = [];

  const shoulderOf = (side: 'l' | 'r'): P => ({
    x: cx + (side === 'l' ? -1 : 1) * sh * 0.84,
    y: shoulderY + H * 0.14,
  });
  const hipOf = (side: 'l' | 'r'): P => ({
    x: cx + (side === 'l' ? -1 : 1) * hipHalf * 0.50,
    y: hipY - H * 0.06,
  });

  const deskY = pose === 'seated' ? (opts.deskY ?? seatedDeskY(look)) : NaN;

  // --- Arms ----------------------------------------------------------------
  const spec = pose === 'seated' ? null : POSES[pose];

  for (const side of ['l', 'r'] as const) {
    const s = side === 'l' ? -1 : 1;
    const S = shoulderOf(side);
    // NEVER BEHIND THE TORSO unless the pose asks for it. `standing` used to
    // put the right arm behind, and on a front-on figure with the arms down
    // that hid it completely — which is the whole of "the garage crew are
    // armless torsos". A pose has to ask, and only a turned one should.
    const behind = spec ? spec.behindArm === side : false;
    let E: P;
    let Wp: P;
    let handAngle: number;
    let flat = false;

    if (spec) {
      const [a0, a1] = side === 'l' ? spec.armL : spec.armR;
      const sa = a0;
      const sb = a0 + a1;
      E = step(S, sa, upperLen, s);
      Wp = step(E, sb, foreLen, s);
      handAngle = sb;
      flat = spec.flatHands === true;
    } else {
      // Seated, and SOLVED rather than posed: the hand has to land on the desk
      // at a stated height whatever this person's build is, because the desk is
      // a real object drawn by the scene at that y. Posing it with an angle
      // put the hands somewhere near the desk for the average build and under
      // it for everybody else — which is exactly what shipped, and why
      // `desktop-presser.png` had six hands hidden behind a slab.
      const r = seatedArm(S, cx, s, deskY, hipHalf, upperLen, foreLen, handLen, H);
      E = r.elbow;
      Wp = r.wrist;
      handAngle = r.angle;
      flat = true;
    }

    bones.push({
      id: `arm-${side}-upper`, a: S, b: E,
      wa: H * 0.42 * girth, wb: H * 0.31 * girth, side, behind,
    });
    bones.push({
      id: `arm-${side}-fore`, a: E, b: Wp,
      wa: H * 0.30 * girth, wb: H * 0.215 * girth, side, behind,
    });

    // The hand's CENTRE sits half a hand beyond the wrist, along the forearm.
    // Placing it AT the wrist is how the old figure ended up with a hand that
    // overlapped the cuff and read as a swelling.
    const hc = step(Wp, handAngle, handLen * 0.42, s);
    hands.push({
      id: `hand-${side}`, c: hc, angle: handAngle, len: handLen, wid: handWid,
      side, behind, flat,
      // The fist grips a third of the way along the hand, and whatever it holds
      // stands up out of it along the hand's own axis.
      grip: {
        x: step(Wp, handAngle, handLen * 0.30, s).x,
        y: step(Wp, handAngle, handLen * 0.30, s).y,
        angle: handAngle,
      },
    });
  }

  // --- Legs ----------------------------------------------------------------
  const legs = spec ? spec.legs : false;
  if (legs && spec) {
    for (const side of ['l', 'r'] as const) {
      const s = side === 'l' ? -1 : 1;
      const Hp = hipOf(side);
      const [b0, b1] = side === 'l' ? spec.legL : spec.legR;
      const sa = b0;
      const sb = b0 + b1;
      const K = step(Hp, sa, thighLen, s);
      const A = step(K, sb, shinLen, s);
      const behind = spec.behindLeg === side;
      bones.push({
        id: `leg-${side}-thigh`, a: Hp, b: K,
        wa: H * 0.58 * girth, wb: H * 0.40 * girth, side, behind,
      });
      bones.push({
        id: `leg-${side}-shin`, a: K, b: A,
        wa: H * 0.38 * girth, wb: H * 0.235 * girth, side, behind,
      });
      feet.push({
        id: `foot-${side}`, c: { x: A.x, y: A.y + footHgt * 0.62 },
        len: footLen, hgt: footHgt, side, behind, angle: 8,
      });
    }
  }

  // The floor is the lowest sole, so a figure with one leg forward still
  // stands ON something rather than hovering over it.
  const floorY = feet.length > 0
    ? Math.max(...feet.map((f) => f.c.y))
    : hipY + thighLen + shinLen + footHgt * 0.62;

  // --- Torso ---------------------------------------------------------------
  const torso = torsoOutline(cx, g, sh, hipHalf, shoulderY, waistY, hipY, H);

  // --- Framing -------------------------------------------------------------
  let frameTop = g.crownY - g.hw * 0.62;
  for (const h of hands) frameTop = Math.min(frameTop, h.c.y - h.len * 0.9);
  for (const b of bones) frameTop = Math.min(frameTop, b.a.y - b.wa, b.b.y - b.wb);
  // Room above the highest hand for whatever is in it.
  if (pose === 'raised') frameTop -= H * 0.95;

  const frameBottom = pose === 'seated'
    ? deskY + H * 0.34
    : pose === 'raised'
      // Below the knee. A podium step is not tall enough to show a whole
      // person and cutting at the waist makes a skittle of them.
      ? shoulderY + H * 4.20
      : floorY + H * 0.10;

  return {
    pose, g, H, cx, shoulderY, sh, hipHalf, waistY, hipY, floorY,
    torso, bones, hands, feet, deskY, frameBottom, frameTop,
  };
}

/**
 * The seated arm.
 *
 * Two constraints and one free parameter. The hand must sit on the desk at
 * `deskY`, pointing forward and slightly inward as every hand on a press desk
 * does; the shoulder is where it is. The elbow is placed on the arc the upper
 * arm can reach, as far out and down as it goes without the forearm having to
 * be longer than it is — and when the desk is close enough that the forearm
 * would have slack, the arm FORESHORTENS instead, which is what a forearm
 * pointing at the camera does.
 */
function seatedArm(
  S: P, cx: number, s: number, deskY: number, hipHalf: number,
  upperLen: number, foreLen: number, handLen: number, H: number,
): { elbow: P; wrist: P; angle: number } {
  // Where the heel of the hand rests. Inboard of the shoulder, because a
  // person at a desk brings their hands together rather than splaying them.
  const target: P = {
    x: cx + s * hipHalf * 0.98,
    y: deskY - H * 0.055,
  };
  // The upper arm hangs out and slightly back.
  const elbow = step(S, 19, upperLen * 0.92, s);
  const dx = target.x - elbow.x;
  const dy = target.y - elbow.y;
  const d = Math.hypot(dx, dy) || 1;
  // The forearm cannot stretch. If the desk is further than it reaches, drop
  // the elbow toward the target until it does.
  let E = elbow;
  if (d > foreLen) {
    const k = (d - foreLen) / d;
    E = { x: elbow.x + dx * k, y: elbow.y + dy * k };
  }
  const wrist: P = {
    x: target.x - (target.x - E.x) * (handLen * 0.42) / Math.max(1, Math.hypot(target.x - E.x, target.y - E.y)),
    y: target.y - (target.y - E.y) * (handLen * 0.42) / Math.max(1, Math.hypot(target.x - E.x, target.y - E.y)),
  };
  const angle = Math.atan2(s * (target.x - E.x), target.y - E.y) / RAD;
  return { elbow: E, wrist, angle };
}

/**
 * The torso outline.
 *
 * The trapezius, then the point of the shoulder, then a nearly vertical side
 * into the waist and out again over the hip. The original comment on this shape
 * is still right and is kept: *a torso drawn as a trapezium from shoulder to
 * hip is a shopping bag; the line has to leave the neck at a slope and turn
 * over at the point of the shoulder.* What is new is that it ends at the HIP
 * rather than running off the bottom of the box, because there are legs under
 * it now.
 */
function torsoOutline(
  cx: number, g: HeadGeometry, sh: number, hipHalf: number,
  shoulderY: number, waistY: number, hipY: number, H: number,
): P[] {
  const nh = g.neckHalf;
  const half: [number, number][] = [
    [nh * 1.30, shoulderY - H * 0.10],   // base of the neck
    [sh * 0.54, shoulderY - H * 0.055],  // trapezius
    [sh * 0.95, shoulderY + H * 0.10],   // the point of the shoulder
    [sh * 0.90, shoulderY + H * 0.52],   // armpit
    [hipHalf * 0.94, waistY],            // waist
    [hipHalf * 1.00, hipY - H * 0.42],   // hip
    [hipHalf * 0.90, hipY + H * 0.10],   // outside of the seat
  ];
  const right = half.map(([dx, y]) => ({ x: cx + dx, y }));
  const left = half.map(([dx, y]) => ({ x: cx - dx, y })).reverse();
  const crotch = { x: cx, y: hipY - H * 0.02 };
  return smoothClosed([...right, crotch, ...left], 5, 0.36);
}

// ===========================================================================
// Serialising
// ===========================================================================

/** A polygon as an SVG path. Absolute, closed, and nothing but M/L/Z. */
export function polyPath(pts: readonly P[]): string {
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  return d + ' Z';
}

/** Shrinks a polygon toward its centroid. Used for the shading inlays. */
export function inset(pts: readonly P[], k: number, dx = 0, dy = 0): P[] {
  let sx = 0;
  let sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const c = { x: sx / pts.length, y: sy / pts.length };
  return pts.map((p) => ({
    x: c.x + (p.x - c.x) * k + dx,
    y: c.y + (p.y - c.y) * k + dy,
  }));
}
