import { headArt, type HeadOptions } from './Face';
import { complexionOf, type PersonLook } from './Look';
import {
  buildRig, capsule, footPolygon, handPolygon, inset, polyPath,
  smoothClosed, thumbPolygon,
  type Bone, type Foot, type Hand, type Pose, type Rig,
} from './Body';

/**
 * Bodies.
 *
 * `Face.ts` draws a head in a 200-wide box with the chin pinned at y=168.
 * `Body.ts` hangs a SKELETON underneath it. This file paints that skeleton and
 * paints nothing else: every shape below the neck comes out of a bone, a hand,
 * a foot or the torso outline, and the whole figure is one `<g>` a scene places
 * with a single transform.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE OLD COMMENT HERE WAS WRONG
 * ---------------------------------------------------------------------------
 *
 * This file used to open with an argument for spending nothing below the neck:
 *
 *   > "Anatomy beyond that is spent money. There are no hands with fingers on
 *   >  them anywhere in this file, because a five-fingered hand at forty pixels
 *   >  is five pixels of noise."
 *
 * The premise is right and the conclusion was wrong, and three photographs
 * settle it. `hud-out/people/desktop-podium.png` on the build that comment
 * shipped with: a torso, and one constant-width stroke going up to a trophy.
 * `desktop-garage.png`: four torsos with no arms at all — the upper arms were
 * drawn in the suit colour BEHIND the torso and were therefore invisible.
 * `desktop-presser.png`: no hands anywhere, on a screen whose specification
 * (`reference/target/81.png`) has six of them on a desk in the middle of the
 * frame.
 *
 * Five separated fingers really are noise at forty pixels. A hand-shaped MASS
 * is not: it is what makes an arm terminate rather than stop. So there are
 * hands, they are four fingers as one mass with a thumb, and they are attached
 * to forearms which are attached to upper arms which are attached at the
 * shoulder — asserted, in `probe:people`, by reading the drawn polygons back.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BODY IS FOR
 * ---------------------------------------------------------------------------
 *
 *   · SCALE. It says how big the person is, which is the only way a viewer can
 *     tell a slight driver from a heavy principal once the heads are matched.
 *   · TEAM. It is the only large area of team colour on a screen full of faces.
 *   · POSE. Hands on a desk, arms at the sides, both arms up, arms folded,
 *     walking — five poses, and between them they cover a press conference, a
 *     podium, a garage and a paddock.
 *   · KIT. A race suit is not a coloured rectangle. It has a collar, a yoke
 *     across the shoulders, a seam down the flank, cuffs, a belt and blocks
 *     where sponsors go — and the blocks are ABSTRACT, because `PROJECT.md` §3
 *     permits real names as data and permits no reproduced artwork.
 */

const f1 = (n: number): string => n.toFixed(1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export type { Pose } from './Body';

export interface FigureOptions extends HeadOptions {
  /** The shirt or race suit. The team's. */
  suit: string;
  /** Collar, cuffs, the yoke and the flash down the flank. */
  accent: string;
  pose?: Pose;
  /** A race number on the chest. Drivers only. */
  number?: number;
  /**
   * A trophy in the raised hand. `raised` pose only.
   *
   * Three metals, and they are the only place in this interface where gold,
   * silver and bronze appear — the five signal colours mean what they mean and
   * a podium is not a signal.
   */
  trophy?: 'gold' | 'silver' | 'bronze';
  /** A bottle of champagne in the other hand. `raised` only. */
  champagne?: boolean;
  /**
   * Where the desk crosses a seated figure, in figure space. The scene passes
   * the number it is going to draw the desk at; omit it and the figure picks
   * its own, and the scene reads it back off `art.rig.deskY` — which is what
   * `PressConference.ts` does, because it is the only way the desk it draws and
   * the hands resting on it can be the same number for every build.
   */
  deskY?: number;
  /**
   * Sponsor blocks on the chest. Abstract rectangles, never artwork. Off for
   * team staff, who wear a polo shirt rather than a race suit.
   */
  sponsors?: boolean;
}

const TROPHY_METAL: Readonly<Record<string, [string, string, string]>> = {
  // [body, catch, shade]
  gold: ['#c99a2e', '#ffe9a8', '#7d5a12'],
  silver: ['#a9b2bc', '#eef3f8', '#606a75'],
  bronze: ['#a1642f', '#e0a86a', '#5f3616'],
};

export interface FigureArt {
  defs: string;
  /** One `<g>`, ready to be placed by a transform. */
  markup: string;
  /**
   * The part of the figure that must be painted AFTER the scene's furniture:
   * the hands and forearms of a seated person, which lie on top of the desk.
   * Empty for every other pose. A scene that ignores it gets a person sitting
   * behind a desk with their arms inside it, which is what shipped.
   */
  overlay: string;
  /** The skeleton this was drawn from. Scenes use it to place props. */
  rig: Rig;
}

// ===========================================================================
// Painting a bone
// ===========================================================================

/**
 * One limb.
 *
 * A filled tapered polygon, a shadow down its far side and a highlight up its
 * near one, both clipped to the limb itself so nothing leaks. `data-part`,
 * `data-a` and `data-b` are what `probe:people` reads: the part's identity and
 * the two joints it claims to run between. It then measures the polygon and
 * checks the claim.
 */
function boneArt(b: Bone, uid: string, fill: string, opts: {
  cuff?: string;
  yoke?: string;
}): string {
  const poly = capsule(b.a, b.b, b.wa, b.wb);
  const clip = `${uid}-c-${b.id}`;
  const w = (b.wa + b.wb) / 2;
  let out = `<clipPath id="${clip}"><path d="${polyPath(poly)}"/></clipPath>`;
  out += `<path data-part="${b.id}" data-a="${f1(b.a.x)},${f1(b.a.y)}"`
    + ` data-b="${f1(b.b.x)},${f1(b.b.y)}" fill="${fill}" d="${polyPath(poly)}"/>`;
  out += `<g clip-path="url(#${clip})">`
    + `<path fill="rgba(0,0,0,0.24)" d="${polyPath(inset(poly, 1, w * 0.58, w * 0.16))}"/>`
    + `<path fill="rgba(255,255,255,0.10)" d="${polyPath(inset(poly, 1, -w * 0.66, -w * 0.12))}"/>`;
  if (opts.yoke) {
    // The shoulder seam, as a SEAM: a thin band ACROSS the sleeve, not a cap
    // over the top of it. Two versions of this shipped as a shoulder pad —
    // a filled cap at 42% of the upper arm, then one at 20% — and at build 1
    // with an orange accent they were pauldrons. A garment seam is a line.
    // ACROSS the sleeve, not along it. A capsule at 6% of the limb's length is
    // shorter than its own end caps, so it comes out as a DISC — which is
    // exactly what shipped twice: a pale pauldron on every shoulder, orange at
    // build 1. This is a quad perpendicular to the bone, clipped to it.
    const t = 0.22;
    const dx = b.b.x - b.a.x;
    const dy = b.b.y - b.a.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    const c = { x: b.a.x + ux * L * t, y: b.a.y + uy * L * t };
    const half = b.wa * 0.80;
    const th = Math.max(1.2, L * 0.045);
    out += `<path fill="${opts.yoke}" opacity="0.60" d="${polyPath([
      { x: c.x - uy * half - ux * th, y: c.y + ux * half - uy * th },
      { x: c.x + uy * half - ux * th, y: c.y - ux * half - uy * th },
      { x: c.x + uy * half + ux * th, y: c.y - ux * half + uy * th },
      { x: c.x - uy * half + ux * th, y: c.y + ux * half + uy * th },
    ])}"/>`;
  }
  if (opts.cuff) {
    const c = capsule(
      { x: lerp(b.a.x, b.b.x, 0.86), y: lerp(b.a.y, b.b.y, 0.86) },
      { x: lerp(b.a.x, b.b.x, 1.04), y: lerp(b.a.y, b.b.y, 1.04) },
      b.wb * 1.10, b.wb * 1.10);
    out += `<path fill="${opts.cuff}" opacity="0.95" d="${polyPath(c)}"/>`;
  }
  out += '</g>';
  return out;
}

/** A hand: the thumb lobe first, the palm mass over it, then one crease. */
function handArt(h: Hand, uid: string, skin: { base: string; shade: string; lift: string }): string {
  const palm = handPolygon(h);
  const thumb = thumbPolygon(h);
  const clip = `${uid}-c-${h.id}`;
  return `<clipPath id="${clip}"><path d="${polyPath(palm)}"/></clipPath>`
    + `<path data-part="${h.id}-thumb" fill="${skin.base}" d="${polyPath(thumb)}"/>`
    + `<path data-part="${h.id}" data-c="${f1(h.c.x)},${f1(h.c.y)}"`
    + ` data-grip="${f1(h.grip.x)},${f1(h.grip.y)}"`
    + ` fill="${skin.base}" d="${polyPath(palm)}"/>`
    + `<g clip-path="url(#${clip})">`
    + `<path fill="${skin.shade}" opacity="0.34" d="${polyPath(inset(palm, 1, h.wid * 0.40, h.wid * 0.14))}"/>`
    + `<path fill="${skin.lift}" opacity="0.32" d="${polyPath(inset(palm, 0.74, -h.wid * 0.16, -h.wid * 0.12))}"/>`
    + '</g>';
}

/** A boot. Dark, with the team's flash across the instep. */
function footArt(f: Foot, uid: string, accent: string): string {
  const poly = footPolygon(f);
  const clip = `${uid}-c-${f.id}`;
  return `<clipPath id="${clip}"><path d="${polyPath(poly)}"/></clipPath>`
    + `<path data-part="${f.id}" data-c="${f1(f.c.x)},${f1(f.c.y)}"`
    + ` fill="#12161d" d="${polyPath(poly)}"/>`
    + `<g clip-path="url(#${clip})">`
    + `<path fill="${accent}" opacity="0.85" d="${polyPath(
      inset(poly, 0.46, -f.len * 0.06, -f.hgt * 0.30))}"/>`
    + `<path fill="rgba(255,255,255,0.10)" d="${polyPath(inset(poly, 1, 0, -f.hgt * 0.62))}"/>`
    + '</g>';
}

// ===========================================================================
// The suit
// ===========================================================================

/**
 * The race suit, on the torso.
 *
 * Everything here is clipped to the torso outline, so no panel, seam or block
 * can end up floating beside the body — which is the failure mode of drawing
 * decals at fractions of a bounding box, and it is how the old chest number
 * ended up half off the shoulder on a narrow build.
 *
 * The sponsor blocks are deliberately BLANK rectangles. `reference/target/81.png`
 * is covered in real wordmarks and `PROJECT.md` §3 permits none of them; what
 * reads at these sizes is the rhythm of light blocks on a coloured suit, not
 * the words in them.
 */
function suitArt(rig: Rig, uid: string, opts: FigureOptions): string {
  const { cx, H, sh, hipHalf, shoulderY, waistY, hipY } = rig;
  const clip = `${uid}-c-torso`;
  const acc = opts.accent;
  let out = `<clipPath id="${clip}"><path d="${polyPath(rig.torso)}"/></clipPath>`;
  out += `<path data-part="torso" fill="${opts.suit}" d="${polyPath(rig.torso)}"/>`;
  out += `<g clip-path="url(#${clip})">`;
  // Form: the cloth gradient, then the shadow under the far arm.
  out += `<path fill="url(#${uid}-cloth)" d="${polyPath(rig.torso)}"/>`;

  // The yoke: a panel across the shoulders in the second colour, the single
  // most recognisable feature of a race suit after its colour.
  const yokeY = shoulderY + H * 0.20;
  out += `<path fill="${acc}" opacity="0.92" d="${polyPath(smoothClosed([
    { x: cx - sh * 1.10, y: shoulderY - H * 0.30 },
    { x: cx + sh * 1.10, y: shoulderY - H * 0.30 },
    { x: cx + sh * 1.02, y: yokeY },
    { x: cx + sh * 0.34, y: yokeY - H * 0.16 },
    { x: cx - sh * 0.34, y: yokeY - H * 0.16 },
    { x: cx - sh * 1.02, y: yokeY },
  ], 4, 0.22))}"/>`;

  // The collar: the suit's zip band round the neck, over the yoke.
  const nh = rig.g.neckHalf;
  out += `<path fill="#12161d" opacity="0.9" d="${polyPath(smoothClosed([
    { x: cx - nh * 1.5, y: shoulderY - H * 0.20 },
    { x: cx + nh * 1.5, y: shoulderY - H * 0.20 },
    { x: cx + nh * 1.9, y: shoulderY + H * 0.14 },
    { x: cx, y: shoulderY + H * 0.30 },
    { x: cx - nh * 1.9, y: shoulderY + H * 0.14 },
  ], 4, 0.3))}"/>`;
  out += `<path fill="none" stroke="${acc}" stroke-width="${f1(H * 0.026)}"`
    + ` d="M ${f1(cx)} ${f1(shoulderY + H * 0.26)} L ${f1(cx)} ${f1(waistY + H * 0.30)}"/>`;

  // The seam down each flank, and the belt.
  for (const s of [-1, 1]) {
    out += `<path fill="${acc}" opacity="0.80" d="${polyPath([
      { x: cx + s * sh * 0.93, y: shoulderY + H * 0.50 },
      { x: cx + s * sh * 0.79, y: shoulderY + H * 0.50 },
      { x: cx + s * hipHalf * 0.80, y: hipY + H * 0.14 },
      { x: cx + s * hipHalf * 0.98, y: hipY + H * 0.14 },
    ])}"/>`;
  }
  out += `<rect x="${f1(cx - sh * 1.2)}" y="${f1(waistY + H * 0.34)}"`
    + ` width="${f1(sh * 2.4)}" height="${f1(H * 0.20)}" fill="#12161d" opacity="0.66"/>`;

  if (opts.sponsors !== false) {
    // Three blocks: one across the chest and two smaller under it. The chest
    // block is where every team in the sport puts its title partner, and the
    // rhythm is what says "race suit" rather than "jumper".
    const by = shoulderY + H * 0.62;
    out += `<rect x="${f1(cx - sh * 0.48)}" y="${f1(by)}" width="${f1(sh * 0.96)}"`
      + ` height="${f1(H * 0.20)}" rx="${f1(H * 0.025)}" fill="#eef2f7" opacity="0.88"/>`;
    out += `<rect x="${f1(cx - sh * 0.44)}" y="${f1(by + H * 0.055)}" width="${f1(sh * 0.88)}"`
      + ` height="${f1(H * 0.09)}" rx="${f1(H * 0.015)}" fill="#1a222c" opacity="0.30"/>`;
    for (const s of [-1, 1]) {
      out += `<rect x="${f1(cx + s * sh * 0.36 - sh * 0.16)}" y="${f1(by + H * 0.34)}"`
        + ` width="${f1(sh * 0.32)}" height="${f1(H * 0.12)}" rx="${f1(H * 0.015)}"`
        + ` fill="${acc}" opacity="0.80"/>`;
    }
    out += `<rect x="${f1(cx - sh * 0.24)}" y="${f1(waistY - H * 0.22)}"`
      + ` width="${f1(sh * 0.48)}" height="${f1(H * 0.11)}" rx="${f1(H * 0.015)}"`
      + ` fill="#eef2f7" opacity="0.50"/>`;
  }

  if (opts.number !== undefined) {
    const y = waistY + H * 0.60;
    out += `<rect x="${f1(cx - sh * 0.34)}" y="${f1(y)}" width="${f1(sh * 0.68)}"`
      + ` height="${f1(H * 0.30)}" rx="${f1(H * 0.03)}" fill="rgba(6,8,11,0.46)"/>`
      + `<text x="${f1(cx)}" y="${f1(y + H * 0.235)}" text-anchor="middle"`
      + ` class="fig-number" fill="${opts.accent}">${String(opts.number)}</text>`;
  }

  // The turned side of the body, last, over everything.
  out += `<path fill="rgba(0,0,0,0.26)" d="${polyPath(
    inset(rig.torso, 1, sh * 0.72, 0))}"/>`;
  out += '</g>';
  return out;
}

/** The legs, in the same suit, with a stripe down the outside of each. */
function legArt(rig: Rig, uid: string, opts: FigureOptions, behind: boolean): string {
  let out = '';
  for (const b of rig.bones) {
    if (!b.id.startsWith('leg-') || b.behind !== behind) continue;
    out += boneArt(b, uid, opts.suit, b.id.endsWith('shin') ? { cuff: opts.accent } : {});
  }
  for (const f of rig.feet) {
    if (f.behind !== behind) continue;
    out += footArt(f, uid, opts.accent);
  }
  return out;
}

/** The arms, and the hands on the ends of them. */
function armArt(
  rig: Rig, uid: string, opts: FigureOptions,
  skin: { base: string; shade: string; lift: string }, behind: boolean,
): string {
  let out = '';
  for (const b of rig.bones) {
    if (!b.id.startsWith('arm-') || b.behind !== behind) continue;
    out += boneArt(b, uid, opts.suit, b.id.endsWith('upper')
      ? { yoke: opts.accent }
      : { cuff: opts.accent });
  }
  for (const h of rig.hands) {
    if (h.behind !== behind) continue;
    out += handArt(h, uid, skin);
  }
  return out;
}

// ===========================================================================
// The figure
// ===========================================================================

/**
 * A person with a body, as markup.
 *
 * The draw order is the order a painter would use and it is not negotiable:
 * anything behind the body (long hair, the far arm, the far leg), then the
 * torso, then the near limbs, then whatever is being held, then the head. Get
 * it wrong and the shoulders sit on top of the jaw — or, as this file managed
 * before, the arms sit behind the chest and vanish.
 */
export function figureArt(look: PersonLook, opts: FigureOptions): FigureArt {
  const pose = opts.pose ?? 'seated';
  const rig = buildRig(look, { pose, deskY: opts.deskY });
  const g = rig.g;
  const head = headArt(look, opts);
  const skin = complexionOf(look.complexion);
  const uid = opts.uid;

  const cx = g.cx;
  const shoulderY = rig.shoulderY;

  // --- Neck and its shadow -------------------------------------------------
  const neck = `<path data-part="neck" fill="${skin.base}" d="`
    + `M ${f1(cx - g.neckHalf)} ${f1(g.chinY - g.h * 0.10)} L ${f1(cx + g.neckHalf)} ${f1(g.chinY - g.h * 0.10)}`
    + ` C ${f1(cx + g.neckHalf * 1.1)} ${f1(g.neckY)} ${f1(cx + g.neckHalf * 1.3)} ${f1(g.neckY + g.h * 0.06)} ${f1(cx + g.neckHalf * 1.45)} ${f1(shoulderY + 6)}`
    + ` L ${f1(cx - g.neckHalf * 1.45)} ${f1(shoulderY + 6)}`
    + ` C ${f1(cx - g.neckHalf * 1.3)} ${f1(g.neckY + g.h * 0.06)} ${f1(cx - g.neckHalf * 1.1)} ${f1(g.neckY)} ${f1(cx - g.neckHalf)} ${f1(g.chinY - g.h * 0.10)} Z"/>`
    + `<path fill="${skin.shade}" opacity="0.55" d="`
    + `M ${f1(cx - g.neckHalf * 1.02)} ${f1(g.chinY - g.h * 0.10)}`
    + ` C ${f1(cx - g.jw * 0.55)} ${f1(g.chinY + g.h * 0.07)} ${f1(cx + g.jw * 0.55)} ${f1(g.chinY + g.h * 0.07)} ${f1(cx + g.neckHalf * 1.02)} ${f1(g.chinY - g.h * 0.10)}`
    + ` L ${f1(cx + g.neckHalf * 1.1)} ${f1(g.neckY)} L ${f1(cx - g.neckHalf * 1.1)} ${f1(g.neckY)} Z"/>`;

  const torso = suitArt(rig, uid, opts);

  const defs = head.defs
    + `<linearGradient id="${uid}-cloth" gradientUnits="userSpaceOnUse"`
    + ` x1="${f1(cx - rig.sh)}" y1="${f1(shoulderY)}" x2="${f1(cx + rig.sh)}" y2="${f1(rig.hipY)}">`
    + `<stop offset="0%" stop-color="#fff" stop-opacity="0.14"/>`
    + `<stop offset="42%" stop-color="#fff" stop-opacity="0"/>`
    + `<stop offset="100%" stop-color="#000" stop-opacity="0.30"/></linearGradient>`;

  // A seated person's forearms and hands lie ON the desk. The scene draws the
  // desk between `markup` and `overlay`.
  if (pose === 'seated') {
    let over = '';
    let body = '';
    for (const b of rig.bones) {
      if (b.id.endsWith('-fore')) over += boneArt(b, uid, opts.suit, { cuff: opts.accent });
      else if (b.id.startsWith('arm-')) body += boneArt(b, uid, opts.suit, { yoke: opts.accent });
    }
    for (const h of rig.hands) over += handArt(h, uid, skin);
    return {
      defs,
      markup: `<g>${head.back}${body}${neck}${torso}${head.front}</g>`,
      overlay: `<g>${over}</g>`,
      rig,
    };
  }

  const behind = legArt(rig, uid, opts, true) + armArt(rig, uid, opts, skin, true);
  const frontLegs = legArt(rig, uid, opts, false);
  const frontArms = armArt(rig, uid, opts, skin, false);
  const props = propArt(rig, opts);

  return {
    defs,
    markup: `<g>${head.back}${behind}${neck}${torso}${frontLegs}${frontArms}`
      + `${props}${head.front}</g>`,
    overlay: '',
    rig,
  };
}

// ===========================================================================
// Things people hold
// ===========================================================================

/**
 * Whatever is in the hands.
 *
 * Placed at the GRIP, which is a point on the hand's own axis, and rotated to
 * the hand's own angle. The trophy used to be positioned by a formula that
 * happened to land near where a formula in a different function had put a hand;
 * moving the shoulder moved one and not the other, and `probe:people` now
 * asserts the overlap rather than trusting either.
 */
function propArt(rig: Rig, opts: FigureOptions): string {
  if (rig.pose !== 'raised') return '';
  let out = '';
  const left = rig.hands.find((h) => h.side === 'l');
  const right = rig.hands.find((h) => h.side === 'r');
  if (opts.trophy && left) {
    out += `<g transform="translate(${f1(left.grip.x)} ${f1(left.grip.y)}) `
      + `rotate(${f1(-left.grip.angle * 0.16)})" data-part="held-trophy" `
      + `data-at="${f1(left.grip.x)},${f1(left.grip.y)}">`
      + trophy(rig.H * 0.30, opts.trophy) + '</g>';
  }
  if (opts.champagne && right) {
    out += `<g transform="translate(${f1(right.grip.x)} ${f1(right.grip.y)}) `
      + `rotate(${f1(-right.grip.angle * 0.16)})" data-part="held-bottle" `
      + `data-at="${f1(right.grip.x)},${f1(right.grip.y)}">`
      + bottle(rig.H * 0.22, opts.accent) + '</g>';
  }
  return out;
}

/**
 * A cup, drawn about the origin with the STEM IN THE FIST.
 *
 * Bowl, stem, base, two handles. Four shapes, and it is unmistakable at thirty
 * pixels because a trophy is one of about six silhouettes every person alive
 * can name instantly. The catch light is on the upper left, as everything else
 * in this game is.
 */
function trophy(r: number, metal: 'gold' | 'silver' | 'bronze'): string {
  const [body, lift, shade] = TROPHY_METAL[metal];
  // The fist is at 0,0 and holds the stem; the bowl is above it.
  const base = r * 0.55;
  const top = -r * 2.9;
  return `<g>`
    + `<path fill="none" stroke="${body}" stroke-width="${f1(r * 0.20)}" d="`
    + `M ${f1(-r * 0.78)} ${f1(top + r * 0.30)} C ${f1(-r * 1.55)} ${f1(top + r * 0.45)} ${f1(-r * 1.45)} ${f1(top + r * 1.25)} ${f1(-r * 0.66)} ${f1(top + r * 1.20)}`
    + `M ${f1(r * 0.78)} ${f1(top + r * 0.30)} C ${f1(r * 1.55)} ${f1(top + r * 0.45)} ${f1(r * 1.45)} ${f1(top + r * 1.25)} ${f1(r * 0.66)} ${f1(top + r * 1.20)}"/>`
    + `<path fill="${body}" d="`
    + `M ${f1(-r * 0.86)} ${f1(top)} L ${f1(r * 0.86)} ${f1(top)}`
    + ` C ${f1(r * 0.80)} ${f1(top + r * 1.35)} ${f1(r * 0.36)} ${f1(top + r * 1.62)} 0 ${f1(top + r * 1.66)}`
    + ` C ${f1(-r * 0.36)} ${f1(top + r * 1.62)} ${f1(-r * 0.80)} ${f1(top + r * 1.35)} ${f1(-r * 0.86)} ${f1(top)} Z"/>`
    + `<path fill="${lift}" opacity="0.55" d="`
    + `M ${f1(-r * 0.80)} ${f1(top + r * 0.06)} C ${f1(-r * 0.72)} ${f1(top + r * 1.05)} ${f1(-r * 0.48)} ${f1(top + r * 1.38)} ${f1(-r * 0.30)} ${f1(top + r * 1.50)}`
    + ` C ${f1(-r * 0.58)} ${f1(top + r * 1.22)} ${f1(-r * 0.62)} ${f1(top + r * 0.60)} ${f1(-r * 0.58)} ${f1(top + r * 0.06)} Z"/>`
    + `<rect x="${f1(-r * 0.94)}" y="${f1(top - r * 0.14)}" width="${f1(r * 1.88)}" `
    + `height="${f1(r * 0.20)}" rx="${f1(r * 0.06)}" fill="${lift}"/>`
    + `<rect x="${f1(-r * 0.17)}" y="${f1(top + r * 1.62)}" width="${f1(r * 0.34)}" `
    + `height="${f1(base - top - r * 1.62)}" fill="${shade}"/>`
    + `<rect x="${f1(-r * 0.60)}" y="${f1(base)}" width="${f1(r * 1.20)}" `
    + `height="${f1(r * 0.26)}" rx="${f1(r * 0.05)}" fill="${body}"/>`
    + `</g>`;
}

/** A magnum, held by the neck. Green glass, a foil top, a plain label. */
function bottle(r: number, accent: string): string {
  const h = r * 6.2;
  return `<g>`
    + `<path fill="#173b21" d="`
    + `M ${f1(-r * 0.34)} ${f1(-r * 0.9)} L ${f1(r * 0.34)} ${f1(-r * 0.9)}`
    + ` L ${f1(r * 0.34)} ${f1(r * 0.6)} C ${f1(r * 0.36)} ${f1(r * 1.5)} ${f1(r)} ${f1(r * 1.9)} ${f1(r)} ${f1(r * 2.8)}`
    + ` L ${f1(r)} ${f1(h)} C ${f1(r)} ${f1(h + r * 0.4)} ${f1(-r)} ${f1(h + r * 0.4)} ${f1(-r)} ${f1(h)}`
    + ` L ${f1(-r)} ${f1(r * 2.8)} C ${f1(-r)} ${f1(r * 1.9)} ${f1(-r * 0.36)} ${f1(r * 1.5)} ${f1(-r * 0.34)} ${f1(r * 0.6)} Z"/>`
    + `<path fill="rgba(255,255,255,0.16)" d="`
    + `M ${f1(-r * 0.72)} ${f1(r * 3.0)} L ${f1(-r * 0.42)} ${f1(r * 3.0)}`
    + ` L ${f1(-r * 0.42)} ${f1(h - r * 0.3)} L ${f1(-r * 0.72)} ${f1(h - r * 0.3)} Z"/>`
    + `<rect x="${f1(-r * 0.40)}" y="${f1(-r * 1.5)}" width="${f1(r * 0.80)}"`
    + ` height="${f1(r * 0.75)}" fill="${accent}"/>`
    + `<rect x="${f1(-r * 0.94)}" y="${f1(r * 3.5)}" width="${f1(r * 1.88)}"`
    + ` height="${f1(r * 1.9)}" rx="${f1(r * 0.1)}" fill="#e9e2cd"/>`
    + `<rect x="${f1(-r * 0.68)}" y="${f1(r * 4.0)}" width="${f1(r * 1.36)}"`
    + ` height="${f1(r * 0.34)}" fill="${accent}" opacity="0.8"/>`
    + `</g>`;
}

// ===========================================================================
// As an element
// ===========================================================================

/**
 * A figure, as an element, framed to whatever it is doing.
 *
 * The frame comes from the rig rather than from a constant, because a raised
 * arm goes a head above the crown and a seated figure does not: one viewBox for
 * both would either crop the trophy or float the panel in white space.
 */
export function figureSvg(
  look: PersonLook, opts: FigureOptions & { size?: number },
): SVGSVGElement {
  const art = figureArt(look, opts);
  const rig = art.rig;
  const top = rig.frameTop;
  const bottom = rig.frameBottom;
  // Wide enough for a raised arm and a trophy, whichever side they are on.
  let left = 0;
  let right = 200;
  for (const h of rig.hands) {
    left = Math.min(left, h.c.x - h.len * 1.4);
    right = Math.max(right, h.c.x + h.len * 1.4);
  }
  for (const f of rig.feet) {
    left = Math.min(left, f.c.x - f.len * 1.2);
    right = Math.max(right, f.c.x + f.len * 1.2);
  }
  const width = right - left;
  const height = bottom - top;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `${f1(left)} ${f1(top)} ${f1(width)} ${f1(height)}`);
  svg.setAttribute('class', 'person-figure');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');
  if (opts.size) {
    svg.setAttribute('width', String(opts.size));
    svg.setAttribute('height', String(Math.round(opts.size * (height / width))));
  }
  svg.innerHTML = `<defs>${art.defs}</defs>${art.markup}${art.overlay}`;
  return svg;
}

// ===========================================================================
// The crowd
// ===========================================================================

export interface CrowdOptions {
  /** Width of the band, in the scene's own units. */
  width: number;
  /** Baseline the heads sit above. */
  baseY: number;
  /** Head radius. Everything else is derived from it. */
  headR: number;
  /** How many. */
  count: number;
  /** Seed, so the same crowd is the same crowd every time. */
  seed: number;
  /** Fill. A crowd is a value, not a set of people. */
  fill: string;
  /** A rim of the key light along the top of each head. */
  rim?: string;
  /** Jitter in depth, 0..1. */
  depth?: number;
}

/**
 * A row of people, as a value.
 *
 * NO FACES. This is the single largest saving in the whole module and the one
 * that lets a press conference have thirty people in it: a head in the middle
 * distance is an oval and a pair of shoulders, and every one of them drawn with
 * eye sockets and a nose would be thirty thousand path nodes spent behind the
 * thing the viewer is actually looking at. Varying only the height, the width
 * and the spacing is enough — a crowd reads as a crowd because its silhouette is
 * irregular, not because its members have features.
 *
 * The rim is what stops it being a stencil: one arc of the key light over the
 * top of each head, and the row sits in a room rather than being cut out of it.
 */
export function crowdBand(opts: CrowdOptions): string {
  const { width, baseY, headR: r, count, fill } = opts;
  const depth = opts.depth ?? 0.35;
  let h = (opts.seed ^ 0x2545f491) >>> 0;
  const rand = (): number => {
    h = (Math.imul(h ^ (h >>> 15), h | 1) ^ (h + 0x6d2b79f5)) >>> 0;
    return (h >>> 8) / 0x1000000;
  };

  let out = `<g fill="${fill}">`;
  let rim = '';
  const step = width / Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const near = 1 - rand() * depth;
    const rr = r * near;
    const x = step * i + (rand() - 0.5) * step * 0.55;
    const y = baseY - rr * (0.2 + rand() * 0.5);
    const sw = rr * (1.75 + rand() * 0.7);
    out += `<path d="M ${f1(x - sw)} ${f1(baseY + rr * 3)} `
      + `C ${f1(x - sw)} ${f1(y + rr * 1.5)} ${f1(x - rr * 1.15)} ${f1(y + rr * 0.9)} ${f1(x - rr * 0.95)} ${f1(y + rr * 0.75)} `
      + `L ${f1(x + rr * 0.95)} ${f1(y + rr * 0.75)} `
      + `C ${f1(x + rr * 1.15)} ${f1(y + rr * 0.9)} ${f1(x + sw)} ${f1(y + rr * 1.5)} ${f1(x + sw)} ${f1(baseY + rr * 3)} Z"/>`
      + `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(rr * 0.86)}" ry="${f1(rr)}"/>`;
    if (opts.rim) {
      rim += `<path d="M ${f1(x - rr * 0.80)} ${f1(y - rr * 0.42)} `
        + `A ${f1(rr * 0.86)} ${f1(rr)} 0 0 1 ${f1(x + rr * 0.10)} ${f1(y - rr * 0.98)}"/>`;
    }
  }
  out += '</g>';
  if (opts.rim) {
    out += `<g fill="none" stroke="${opts.rim}" stroke-width="${f1(r * 0.13)}" `
      + `stroke-linecap="round" opacity="0.55">${rim}</g>`;
  }
  return out;
}
