import { headArt, headGeometry, type HeadOptions } from './Face';
import { complexionOf, type PersonLook } from './Look';

/**
 * Bodies.
 *
 * `Face.ts` draws a head in a 200-wide box with the chin pinned at y=168. This
 * hangs a body underneath it in the same box, running down to y=560, and the
 * whole thing is one `<g>` a scene can place with a single transform. So a press
 * conference is four transforms, a podium is three, and none of them has to know
 * anything about how a person is drawn.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BODY IS FOR
 * ---------------------------------------------------------------------------
 *
 * Not detail. At the size any of these appear, a body is doing exactly three
 * jobs and it is worth being disciplined about which:
 *
 *   · SCALE. It says how big the person is, which is the only way a viewer can
 *     tell a slight driver from a heavy principal once the heads are matched.
 *   · TEAM. It is the only large area of team colour on a screen full of faces.
 *     Twenty-two drivers in eleven liveries are sorted by their torsos.
 *   · POSE. Hands on a desk, arms at the sides, an arm raised — three poses, and
 *     between them they cover a press conference, a podium and a garage.
 *
 * Anatomy beyond that is spent money. There are no hands with fingers on them
 * anywhere in this file, because a five-fingered hand at forty pixels is five
 * pixels of noise and at two hundred it is the one thing that will look wrong.
 */

const f1 = (n: number): string => n.toFixed(1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The floor of the figure box. Everything below the frame is cropped by it. */
export const FIGURE_BOTTOM = 560;

export type Pose = 'seated' | 'standing' | 'raised';

export interface FigureOptions extends HeadOptions {
  /** The shirt or race suit. The team's. */
  suit: string;
  /** Collar, cuffs and the flash down the placket. */
  accent: string;
  pose?: Pose;
  /** A race number on the chest. Drivers only. */
  number?: number;
}

export interface FigureArt {
  defs: string;
  /** One `<g>`, ready to be placed by a transform. */
  markup: string;
}

/**
 * A person with a body, as markup.
 *
 * The draw order is the order a painter would use and it is not negotiable:
 * anything behind the body (long hair), then the arms that are behind the
 * torso, then the torso, then the near arm, then the head. Get it wrong and the
 * shoulders sit on top of the jaw.
 */
export function figureArt(look: PersonLook, opts: FigureOptions): FigureArt {
  const g = headGeometry(look);
  const head = headArt(look, opts);
  const skin = complexionOf(look.complexion);
  const pose = opts.pose ?? 'seated';

  const cx = g.cx;
  const shoulderY = g.chinY + g.h * 0.30;
  // Shoulders are about twice as wide as the skull on anybody, and the whole
  // range from slight to heavy is the last quarter of that.
  const sh = g.hw * lerp(1.85, 2.75, look.build);
  const hip = sh * lerp(0.80, 0.96, look.build);
  const armW = g.hw * lerp(0.42, 0.62, look.build);

  // --- Neck and its shadow -------------------------------------------------
  const neck = `<path fill="${skin.base}" d="`
    + `M ${f1(cx - g.neckHalf)} ${f1(g.chinY - g.h * 0.10)} L ${f1(cx + g.neckHalf)} ${f1(g.chinY - g.h * 0.10)}`
    + ` C ${f1(cx + g.neckHalf * 1.1)} ${f1(g.neckY)} ${f1(cx + g.neckHalf * 1.3)} ${f1(g.neckY + g.h * 0.06)} ${f1(cx + g.neckHalf * 1.45)} ${f1(shoulderY + 6)}`
    + ` L ${f1(cx - g.neckHalf * 1.45)} ${f1(shoulderY + 6)}`
    + ` C ${f1(cx - g.neckHalf * 1.3)} ${f1(g.neckY + g.h * 0.06)} ${f1(cx - g.neckHalf * 1.1)} ${f1(g.neckY)} ${f1(cx - g.neckHalf)} ${f1(g.chinY - g.h * 0.10)} Z"/>`
    + `<path fill="${skin.shade}" opacity="0.55" d="`
    + `M ${f1(cx - g.neckHalf * 1.02)} ${f1(g.chinY - g.h * 0.10)}`
    + ` C ${f1(cx - g.jw * 0.55)} ${f1(g.chinY + g.h * 0.07)} ${f1(cx + g.jw * 0.55)} ${f1(g.chinY + g.h * 0.07)} ${f1(cx + g.neckHalf * 1.02)} ${f1(g.chinY - g.h * 0.10)}`
    + ` L ${f1(cx + g.neckHalf * 1.1)} ${f1(g.neckY)} L ${f1(cx - g.neckHalf * 1.1)} ${f1(g.neckY)} Z"/>`;

  // --- Torso ---------------------------------------------------------------
  // The trapezius, then a nearly vertical side. A torso drawn as a trapezium
  // from shoulder to hip is a shopping bag; the line has to leave the neck at a
  // slope and turn over at the point of the shoulder.
  const torso = `<path fill="${opts.suit}" d="`
    + `M ${f1(cx - g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx - sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx - sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx - sh)} ${f1(shoulderY + g.h * 0.14)}`
    + ` L ${f1(cx - hip)} ${f1(FIGURE_BOTTOM)} L ${f1(cx + hip)} ${f1(FIGURE_BOTTOM)}`
    + ` L ${f1(cx + sh)} ${f1(shoulderY + g.h * 0.14)}`
    + ` C ${f1(cx + sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx + sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx + g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx + g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)} Z"/>`
    // The same key across the shirt as across the face.
    + `<path fill="url(#${opts.uid}-cloth)" d="`
    + `M ${f1(cx - sh)} ${f1(shoulderY + g.h * 0.14)} L ${f1(cx - hip)} ${f1(FIGURE_BOTTOM)}`
    + ` L ${f1(cx + hip)} ${f1(FIGURE_BOTTOM)} L ${f1(cx + sh)} ${f1(shoulderY + g.h * 0.14)}`
    + ` C ${f1(cx + sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx + sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx + g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx + g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx - sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx - sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx - sh)} ${f1(shoulderY + g.h * 0.14)} Z"/>`
    // The collar, and a flash down the placket. Two strokes of the team's
    // second colour, and they are what stop a shirt being a rectangle.
    + `<path fill="none" stroke="${opts.accent}" stroke-width="${f1(g.h * 0.038)}" stroke-linecap="round" d="`
    + `M ${f1(cx - g.neckHalf * 1.6)} ${f1(shoulderY - g.h * 0.05)}`
    + ` C ${f1(cx - g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.055)} ${f1(cx + g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.055)} ${f1(cx + g.neckHalf * 1.6)} ${f1(shoulderY - g.h * 0.05)}"/>`
    + `<path fill="${opts.accent}" opacity="0.85" d="`
    + `M ${f1(cx - sh * 0.98)} ${f1(shoulderY + g.h * 0.16)} L ${f1(cx - sh * 0.80)} ${f1(shoulderY + g.h * 0.15)}`
    + ` L ${f1(cx - hip * 0.80)} ${f1(FIGURE_BOTTOM)} L ${f1(cx - hip * 0.99)} ${f1(FIGURE_BOTTOM)} Z"/>`;

  // --- Arms ----------------------------------------------------------------
  const arms = armsFor(pose, cx, sh, hip, armW, shoulderY, g.h, opts, skin);

  const number = opts.number === undefined ? '' : chestNumber(cx, sh, shoulderY, g.h, opts);

  const defs = head.defs
    + `<linearGradient id="${opts.uid}-cloth" gradientUnits="userSpaceOnUse"`
    + ` x1="${f1(cx - sh)}" y1="${f1(shoulderY)}" x2="${f1(cx + sh)}" y2="${f1(FIGURE_BOTTOM)}">`
    + `<stop offset="0%" stop-color="#fff" stop-opacity="0.12"/>`
    + `<stop offset="42%" stop-color="#fff" stop-opacity="0"/>`
    + `<stop offset="100%" stop-color="#000" stop-opacity="0.34"/></linearGradient>`;

  return {
    defs,
    markup: `<g>${head.back}${arms.behind}${neck}${torso}${number}${arms.front}${head.front}</g>`,
  };
}

/**
 * Arms, in three poses.
 *
 * `seated` puts the forearms forward onto a desk, which is where every hand at
 * every press conference in the sport's history has been. `standing` hangs them.
 * `raised` lifts the near one, for a podium.
 *
 * The upper arm goes BEHIND the torso and the forearm in front of it, which is
 * one line of ordering and the entire difference between an arm attached at the
 * shoulder and an arm stuck onto the ribs.
 */
function armsFor(
  pose: Pose, cx: number, sh: number, hip: number, armW: number,
  shoulderY: number, H: number, opts: FigureOptions,
  skin: { base: string; shade: string; lift: string },
): { behind: string; front: string } {
  const top = shoulderY + H * 0.04;
  const elbow = shoulderY + H * 0.46;
  const upper = (s: number): string =>
    `<path fill="${opts.suit}" d="`
    + `M ${f1(cx + s * (sh - armW * 0.2))} ${f1(top)}`
    + ` C ${f1(cx + s * (sh + armW * 0.30))} ${f1(top + H * 0.10)} ${f1(cx + s * (sh + armW * 0.22))} ${f1(elbow - H * 0.06)} ${f1(cx + s * (sh + armW * 0.02))} ${f1(elbow)}`
    + ` L ${f1(cx + s * (sh - armW * 1.05))} ${f1(elbow)}`
    + ` C ${f1(cx + s * (sh - armW * 1.02))} ${f1(elbow - H * 0.12)} ${f1(cx + s * (sh - armW * 0.9))} ${f1(top + H * 0.08)} ${f1(cx + s * (sh - armW * 0.9))} ${f1(top)} Z"/>`
    + `<path fill="rgba(0,0,0,0.22)" d="`
    + `M ${f1(cx + s * (sh - armW * 1.05))} ${f1(top + H * 0.02)} L ${f1(cx + s * (sh - armW * 0.75))} ${f1(top + H * 0.02)}`
    + ` L ${f1(cx + s * (sh - armW * 0.72))} ${f1(elbow)} L ${f1(cx + s * (sh - armW * 1.05))} ${f1(elbow)} Z"/>`;

  if (pose === 'standing') {
    return { behind: upper(-1) + upper(1), front: '' };
  }

  if (pose === 'raised') {
    // One arm up. Not a wave: the elbow stays low and the forearm goes up and
    // slightly out, which is what somebody acknowledging a grandstand does.
    const hx = cx - sh * 0.78;
    return {
      behind: upper(1),
      front: `<path fill="${opts.suit}" d="`
        + `M ${f1(cx - sh + armW * 0.1)} ${f1(top)} L ${f1(cx - sh - armW * 0.95)} ${f1(top + H * 0.05)}`
        + ` C ${f1(cx - sh - armW * 1.5)} ${f1(top + H * 0.26)} ${f1(hx - armW * 1.9)} ${f1(top - H * 0.36)} ${f1(hx - armW * 1.35)} ${f1(top - H * 0.72)}`
        + ` L ${f1(hx - armW * 0.35)} ${f1(top - H * 0.66)}`
        + ` C ${f1(hx - armW * 0.7)} ${f1(top - H * 0.28)} ${f1(cx - sh + armW * 0.3)} ${f1(top + H * 0.22)} ${f1(cx - sh + armW * 0.1)} ${f1(top)} Z"/>`
        + `<ellipse cx="${f1(hx - armW * 0.85)}" cy="${f1(top - H * 0.80)}" rx="${f1(armW * 0.62)}" `
        + `ry="${f1(armW * 0.74)}" fill="${skin.base}"/>`
        + `<ellipse cx="${f1(hx - armW * 1.05)}" cy="${f1(top - H * 0.86)}" rx="${f1(armW * 0.34)}" `
        + `ry="${f1(armW * 0.40)}" fill="${skin.lift}" opacity="0.4"/>`,
    };
  }

  // Seated: forearms forward, hands loosely together on the desk.
  const deskY = shoulderY + H * 0.62;
  const fore = (s: number): string =>
    `<path fill="${opts.suit}" d="`
    + `M ${f1(cx + s * (sh + armW * 0.06))} ${f1(elbow - armW * 0.55)}`
    + ` C ${f1(cx + s * (sh * 0.72))} ${f1(deskY - armW * 1.0)} ${f1(cx + s * (sh * 0.34))} ${f1(deskY - armW * 0.9)} ${f1(cx + s * hip * 0.20)} ${f1(deskY - armW * 0.62)}`
    + ` L ${f1(cx + s * hip * 0.20)} ${f1(deskY + armW * 0.30)}`
    + ` C ${f1(cx + s * (sh * 0.40))} ${f1(deskY + armW * 0.30)} ${f1(cx + s * (sh * 0.86))} ${f1(deskY - armW * 0.10)} ${f1(cx + s * (sh + armW * 0.06))} ${f1(elbow + armW * 0.62)} Z"/>`
    // The cuff, and the hand beyond it.
    + `<path fill="${opts.accent}" opacity="0.9" d="`
    + `M ${f1(cx + s * hip * 0.34)} ${f1(deskY - armW * 0.68)} L ${f1(cx + s * hip * 0.20)} ${f1(deskY - armW * 0.62)}`
    + ` L ${f1(cx + s * hip * 0.20)} ${f1(deskY + armW * 0.30)} L ${f1(cx + s * hip * 0.34)} ${f1(deskY + armW * 0.26)} Z"/>`
    + `<ellipse cx="${f1(cx + s * hip * 0.10)}" cy="${f1(deskY - armW * 0.16)}" rx="${f1(armW * 0.66)}" `
    + `ry="${f1(armW * 0.46)}" fill="${skin.base}"/>`;

  return { behind: upper(-1) + upper(1), front: fore(-1) + fore(1) };
}

/** The race number, on the chest of a suit. */
function chestNumber(
  cx: number, sh: number, shoulderY: number, H: number, opts: FigureOptions,
): string {
  const y = shoulderY + H * 0.30;
  return `<rect x="${f1(cx - sh * 0.30)}" y="${f1(y)}" width="${f1(sh * 0.60)}" `
    + `height="${f1(H * 0.24)}" rx="${f1(H * 0.02)}" fill="rgba(6,8,11,0.42)"/>`
    + `<text x="${f1(cx)}" y="${f1(y + H * 0.185)}" text-anchor="middle" `
    + `class="fig-number" fill="${opts.accent}">${String(opts.number)}</text>`;
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
