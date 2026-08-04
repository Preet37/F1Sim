import { headGeometry } from '../../src/ui/people/Face';
import { complexionOf, type PersonLook } from '../../src/ui/people/Look';

/**
 * THE BODY AS IT SHIPPED, so the new probe can be proved red on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHY IT IS IN `scripts/`
 * ---------------------------------------------------------------------------
 *
 * PROJECT.md §3.2: *a probe a broken feature passes is worse than no probe*,
 * and the way this project settles that is by breaking the feature and
 * watching the probe go red. For issue #22 the broken feature is not a line
 * somebody can comment out — it is the whole body drawing that was on `main`
 * at `5ac0a09`, and the honest question is "what does the new anatomy section
 * say about the podium arms the user rejected?"
 *
 * So this is `src/ui/people/Figure.ts`'s `armsFor`, `handOf`, `trophy` and the
 * torso, taken VERBATIM from `git show 5ac0a09:src/ui/people/Figure.ts` —
 * every ratio, every control point, every draw order — with exactly one change:
 * the shapes that exist have been given the `data-part` attribute the probe
 * looks for. Nothing has been made worse. The shapes that are MISSING (there is
 * no forearm in `standing`, no hand on either side of it, no leg anywhere, and
 * no second arm on the podium below the elbow) are missing because they were
 * missing, and their absence is what the probe reports.
 *
 * It is here rather than in `src/` because it is a fixture: no screen imports
 * it, it is compiled by `tsconfig.scripts.json`, and it exists to be measured.
 *
 * `PEOPLE_LEGACY=1 npm run probe:people` runs the anatomy section against it.
 */

const f1 = (n: number): string => n.toFixed(1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** VERBATIM. The floor of the old fixed figure box. */
const FIGURE_BOTTOM = 560;

export type LegacyPose = 'seated' | 'standing' | 'raised';

const TROPHY_METAL: Readonly<Record<string, [string, string, string]>> = {
  gold: ['#c99a2e', '#ffe9a8', '#7d5a12'],
  silver: ['#a9b2bc', '#eef3f8', '#606a75'],
  bronze: ['#a1642f', '#e0a86a', '#5f3616'],
};

export interface LegacyOptions {
  uid: string;
  suit: string;
  accent: string;
  pose?: LegacyPose;
  trophy?: 'gold' | 'silver' | 'bronze';
}

/**
 * The old body, as markup. Head omitted — the head was never the problem.
 *
 * Draw order VERBATIM from the original:
 *   `${head.back}${arms.behind}${neck}${torso}${number}${arms.front}${head.front}`
 * which is the line that made the garage crew armless: `arms.behind` is
 * painted, and then the torso is painted over the top of it.
 */
export function legacyBodyArt(look: PersonLook, opts: LegacyOptions): string {
  const g = headGeometry(look);
  const skin = complexionOf(look.complexion);
  const pose = opts.pose ?? 'seated';

  const cx = g.cx;
  const shoulderY = g.chinY + g.h * 0.30;
  const sh = g.hw * lerp(1.85, 2.75, look.build);
  const hip = sh * lerp(0.80, 0.96, look.build);
  const armW = g.hw * lerp(0.50, 0.72, look.build);

  // --- Torso — VERBATIM, tagged ---------------------------------------------
  const torso = `<path data-part="torso" fill="${opts.suit}" d="`
    + `M ${f1(cx - g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx - sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx - sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx - sh)} ${f1(shoulderY + g.h * 0.14)}`
    + ` L ${f1(cx - hip)} ${f1(FIGURE_BOTTOM)} L ${f1(cx + hip)} ${f1(FIGURE_BOTTOM)}`
    + ` L ${f1(cx + sh)} ${f1(shoulderY + g.h * 0.14)}`
    + ` C ${f1(cx + sh * 0.94)} ${f1(shoulderY + g.h * 0.02)} ${f1(cx + sh * 0.55)} ${f1(shoulderY - g.h * 0.045)} ${f1(cx + g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)}`
    + ` C ${f1(cx + g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 0.9)} ${f1(shoulderY + g.h * 0.035)} ${f1(cx - g.neckHalf * 1.5)} ${f1(shoulderY - g.h * 0.055)} Z"/>`;

  const arms = armsFor(pose, cx, sh, hip, armW, shoulderY, g.h, opts, skin);
  return arms.behind + torso + arms.front;
}

/**
 * The old torso, as a polygon the probe can measure.
 *
 * The drawn torso is a cubic path and the probe only parses polygons, so this
 * is the same outline sampled — the four control points it actually turns on,
 * plus the straight sides. It is deliberately GENEROUS to the old build: a
 * flattened cubic is never wider than its hull, so every "the arm is buried
 * inside the torso" measurement below is an understatement of the old figure's
 * problem, not an exaggeration.
 */
export function legacyTorsoPolygon(look: PersonLook): { x: number; y: number }[] {
  const g = headGeometry(look);
  const cx = g.cx;
  const shoulderY = g.chinY + g.h * 0.30;
  const sh = g.hw * lerp(1.85, 2.75, look.build);
  const hip = sh * lerp(0.80, 0.96, look.build);
  return [
    { x: cx - g.neckHalf * 1.5, y: shoulderY - g.h * 0.055 },
    { x: cx - sh, y: shoulderY + g.h * 0.14 },
    { x: cx - hip, y: FIGURE_BOTTOM },
    { x: cx + hip, y: FIGURE_BOTTOM },
    { x: cx + sh, y: shoulderY + g.h * 0.14 },
    { x: cx + g.neckHalf * 1.5, y: shoulderY - g.h * 0.055 },
  ];
}

/**
 * VERBATIM `armsFor`, with `data-part` added.
 *
 * Read it before trusting any summary of it:
 *   · `standing` returns `{ behind: upper(-1) + upper(1), front: '' }`. Two
 *     upper arms, BEHIND the torso, and nothing at all below the elbow.
 *   · `raised` returns one `upper(1)` behind the torso, and in front of it a
 *     single `fill="none" stroke=...` path from inside the chest to the hand.
 *   · `seated` is the only pose that ever had a forearm or a hand.
 */
function armsFor(
  pose: LegacyPose, cx: number, sh: number, hip: number, armW: number,
  shoulderY: number, H: number, opts: LegacyOptions,
  skin: { base: string; shade: string; lift: string },
): { behind: string; front: string } {
  const top = shoulderY + H * 0.04;
  const elbow = shoulderY + H * 0.46;
  const upper = (s: number): string =>
    `<path data-part="arm-${s < 0 ? 'l' : 'r'}-upper"`
    + ` data-a="${f1(cx + s * (sh - armW * 0.2))},${f1(top)}"`
    + ` data-b="${f1(cx + s * (sh + armW * 0.02))},${f1(elbow)}"`
    + ` fill="${opts.suit}" d="`
    + `M ${f1(cx + s * (sh - armW * 0.2))} ${f1(top)}`
    + ` C ${f1(cx + s * (sh + armW * 0.30))} ${f1(top + H * 0.10)} ${f1(cx + s * (sh + armW * 0.22))} ${f1(elbow - H * 0.06)} ${f1(cx + s * (sh + armW * 0.02))} ${f1(elbow)}`
    + ` L ${f1(cx + s * (sh - armW * 1.05))} ${f1(elbow)}`
    + ` C ${f1(cx + s * (sh - armW * 1.02))} ${f1(elbow - H * 0.12)} ${f1(cx + s * (sh - armW * 0.9))} ${f1(top + H * 0.08)} ${f1(cx + s * (sh - armW * 0.9))} ${f1(top)} Z"/>`;

  if (pose === 'standing') {
    return { behind: upper(-1) + upper(1), front: '' };
  }

  if (pose === 'raised') {
    const h = handOf(cx, sh, armW, shoulderY, H);
    const sx = cx - sh * 0.62;
    const sy = top + H * 0.10;
    const ex = cx - sh * 1.06;
    const ey = top - H * 0.16;
    const arm = `M ${f1(sx)} ${f1(sy)} C ${f1(ex + armW * 0.4)} ${f1(sy - H * 0.06)} `
      + `${f1(ex)} ${f1(ey + H * 0.10)} ${f1(ex)} ${f1(ey)} `
      + `C ${f1(ex)} ${f1(ey - H * 0.22)} ${f1(h.x - armW * 0.2)} ${f1(h.y + armW * 2.4)} ${f1(h.x)} ${f1(h.y + armW * 0.9)}`;
    return {
      behind: upper(1),
      front: `<path data-part="arm-l-upper" data-a="${f1(sx)},${f1(sy)}"`
        + ` data-b="${f1(h.x)},${f1(h.y + armW * 0.9)}"`
        + ` fill="none" stroke="${opts.suit}" stroke-linecap="round" `
        + `stroke-linejoin="round" stroke-width="${f1(armW * 1.45)}" d="${arm}"/>`
        + (opts.trophy
          ? `<g data-part="held-trophy" data-at="${f1(h.x)},${f1(h.y)}">`
            + trophy(h.x, h.y, armW, opts.trophy) + '</g>'
          : '')
        + `<ellipse data-part="hand-l" data-c="${f1(h.x)},${f1(h.y)}"`
        + ` cx="${f1(h.x)}" cy="${f1(h.y)}" rx="${f1(armW * 0.62)}" `
        + `ry="${f1(armW * 0.74)}" fill="${skin.base}"/>`,
    };
  }

  const deskY = shoulderY + H * 0.62;
  const fore = (s: number): string =>
    `<path data-part="arm-${s < 0 ? 'l' : 'r'}-fore"`
    + ` data-a="${f1(cx + s * (sh + armW * 0.06))},${f1(elbow)}"`
    + ` data-b="${f1(cx + s * hip * 0.20)},${f1(deskY - armW * 0.16)}"`
    + ` fill="${opts.suit}" d="`
    + `M ${f1(cx + s * (sh + armW * 0.06))} ${f1(elbow - armW * 0.55)}`
    + ` C ${f1(cx + s * (sh * 0.72))} ${f1(deskY - armW * 1.0)} ${f1(cx + s * (sh * 0.34))} ${f1(deskY - armW * 0.9)} ${f1(cx + s * hip * 0.20)} ${f1(deskY - armW * 0.62)}`
    + ` L ${f1(cx + s * hip * 0.20)} ${f1(deskY + armW * 0.30)}`
    + ` C ${f1(cx + s * (sh * 0.40))} ${f1(deskY + armW * 0.30)} ${f1(cx + s * (sh * 0.86))} ${f1(deskY - armW * 0.10)} ${f1(cx + s * (sh + armW * 0.06))} ${f1(elbow + armW * 0.62)} Z"/>`
    + `<ellipse data-part="hand-${s < 0 ? 'l' : 'r'}"`
    + ` data-c="${f1(cx + s * hip * 0.10)},${f1(deskY - armW * 0.16)}"`
    + ` cx="${f1(cx + s * hip * 0.10)}" cy="${f1(deskY - armW * 0.16)}" rx="${f1(armW * 0.66)}" `
    + `ry="${f1(armW * 0.46)}" fill="${skin.base}"/>`;

  return { behind: upper(-1) + upper(1), front: fore(-1) + fore(1) };
}

/** VERBATIM. Where the raised hand ends up. */
function handOf(
  cx: number, sh: number, armW: number, shoulderY: number, H: number,
): { x: number; y: number } {
  return { x: cx - sh * 0.78 - armW * 0.85, y: shoulderY + H * 0.04 - H * 0.80 };
}

/** VERBATIM. */
function trophy(
  x: number, y: number, armW: number, metal: 'gold' | 'silver' | 'bronze',
): string {
  const [body, , shade] = TROPHY_METAL[metal];
  const r = armW * 1.05;
  const top = y - r * 2.6;
  return `<g>`
    + `<path fill="none" stroke="${body}" stroke-width="${f1(r * 0.20)}" d="`
    + `M ${f1(x - r * 0.78)} ${f1(top + r * 0.30)} C ${f1(x - r * 1.55)} ${f1(top + r * 0.45)} ${f1(x - r * 1.45)} ${f1(top + r * 1.25)} ${f1(x - r * 0.66)} ${f1(top + r * 1.20)}`
    + `M ${f1(x + r * 0.78)} ${f1(top + r * 0.30)} C ${f1(x + r * 1.55)} ${f1(top + r * 0.45)} ${f1(x + r * 1.45)} ${f1(top + r * 1.25)} ${f1(x + r * 0.66)} ${f1(top + r * 1.20)}"/>`
    + `<path fill="${body}" d="`
    + `M ${f1(x - r * 0.86)} ${f1(top)} L ${f1(x + r * 0.86)} ${f1(top)}`
    + ` C ${f1(x + r * 0.80)} ${f1(top + r * 1.35)} ${f1(x + r * 0.36)} ${f1(top + r * 1.62)} ${f1(x)} ${f1(top + r * 1.66)}`
    + ` C ${f1(x - r * 0.36)} ${f1(top + r * 1.62)} ${f1(x - r * 0.80)} ${f1(top + r * 1.35)} ${f1(x - r * 0.86)} ${f1(top)} Z"/>`
    + `<rect x="${f1(x - r * 0.15)}" y="${f1(top + r * 1.60)}" width="${f1(r * 0.30)}" `
    + `height="${f1(r * 0.45)}" fill="${shade}"/>`
    + `<rect x="${f1(x - r * 0.55)}" y="${f1(top + r * 2.02)}" width="${f1(r * 1.10)}" `
    + `height="${f1(r * 0.24)}" rx="${f1(r * 0.05)}" fill="${body}"/>`
    + `</g>`;
}
