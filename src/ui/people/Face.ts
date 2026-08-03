import {
  complexionOf, hairOf, type PersonLook,
} from './Look';

/**
 * A head, drawn by its light.
 *
 * `Look.ts` argues the register. This file is the geometry, and it has one rule
 * running through it:
 *
 *   NOTHING ON THIS FACE IS AN OUTLINE.
 *
 * There is exactly one closed contour in the drawing — the silhouette of the
 * skull — and every other feature is a plane that is either turned toward the
 * key or away from it. The nose is a shadow down its right side and a catch on
 * the bridge. The cheekbone is a lift. The eye socket is a band of shade with an
 * eye sitting inside it. The jaw is separated from the neck by the shadow it
 * casts, not by a line.
 *
 * This is not a stylistic preference, it is the mechanism that keeps a generated
 * face out of cartoon. A drawn line has a WEIGHT, and weight is a decision an
 * illustrator makes per face; a generator that picks it produces either a comic
 * or a technical drawing. A plane has no weight — it has an angle to the light,
 * and the light is fixed by `styles.css` for the whole interface. So the drawing
 * has one aesthetic parameter and it is not free.
 *
 * ---------------------------------------------------------------------------
 * THE LIGHT
 * ---------------------------------------------------------------------------
 *
 * Above and to the LEFT, warm, as everywhere else in this game. Which means, on
 * every face in it: forehead and the left cheekbone lit; the right side of the
 * nose, the right jaw and everything under the brow, the nose and the lower lip
 * in shade; and a hard shadow cast down the neck. A viewer never reads that
 * consciously and would read its absence instantly.
 *
 * Terminators are gradients with their two stops set close together rather than
 * hard edges or blur filters. Hard edges give a woodcut; an SVG blur filter is a
 * raster pass per portrait and there are up to fourteen portraits on the press
 * conference screen. Two stops eight percent apart cost nothing and land in
 * exactly the right place between the two.
 *
 * ---------------------------------------------------------------------------
 * TURN
 * ---------------------------------------------------------------------------
 *
 * The head turns by SLIDING ITS FEATURES, not by redrawing its outline. This is
 * not an approximation of a head turn, it is what a head turn actually looks
 * like at small angles: rotate a cylinder fifteen degrees and its silhouette is
 * unchanged while everything painted on it moves. The only outline consequence
 * is the far ear disappearing behind the cheek, which is one conditional.
 */

const NS = 'http://www.w3.org/2000/svg';

// ===========================================================================
// Geometry
// ===========================================================================

/**
 * Where everything is, in the 200-wide space every head is drawn in.
 *
 * The chin is anchored at a fixed y and the skull grows UPWARD from it, so a
 * long face and a short face share a jawline. Anchoring at the crown instead
 * would make a tall head look like it was sinking into its collar, and the
 * collar is the thing that has to stay put when several people share a desk.
 */
export interface HeadGeometry {
  /** Centre of the skull. Features are drawn about `fx`, not this. */
  cx: number;
  /** Centre of the FEATURES, after the turn. */
  fx: number;
  crownY: number;
  chinY: number;
  /** Crown to chin. Every other measurement is a fraction of it. */
  h: number;
  /** Half-width at the cheekbones, at the jaw angle, at the chin. */
  hw: number;
  jw: number;
  cw: number;
  browY: number;
  eyeY: number;
  /** Base of the nose. */
  noseY: number;
  mouthY: number;
  /** Half the distance between the pupils. */
  eyeSep: number;
  /** Top and bottom of the ears. */
  earTop: number;
  earBot: number;
  /** Where the neck meets the collar, and how wide it is. */
  neckY: number;
  neckHalf: number;
  turn: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const f1 = (n: number): string => n.toFixed(1);

export function headGeometry(look: PersonLook): HeadGeometry {
  const cx = 100;
  const chinY = 168;
  const h = lerp(116, 142, look.faceLength);
  const crownY = chinY - h;
  const hw = lerp(40, 50, look.headWidth);
  const jw = hw * lerp(0.60, 0.86, look.jaw);
  const cw = hw * lerp(0.25, 0.46, look.chin);

  // The eyes sit halfway down the head. That is the one proportion everybody
  // knows without knowing it, and the one a generated face gets wrong most
  // often — heads with the eyes too high read as children.
  const eyeY = crownY + h * lerp(0.455, 0.505, look.eyeLine);
  const browY = eyeY - h * (0.070 + look.brow * 0.028);
  const noseY = eyeY + h * lerp(0.185, 0.255, look.nose);
  const mouthY = noseY + (chinY - noseY) * lerp(0.33, 0.44, look.lips);

  return {
    cx,
    fx: cx + look.turn * hw * 0.20,
    crownY, chinY, h, hw, jw, cw,
    browY, eyeY, noseY, mouthY,
    eyeSep: hw * lerp(0.32, 0.41, look.eyeSpacing),
    earTop: browY + h * 0.02,
    earBot: noseY + h * 0.02,
    neckY: chinY + h * 0.155,
    neckHalf: hw * lerp(0.30, 0.44, look.build),
    turn: look.turn,
  };
}

/**
 * The silhouette, as one closed path.
 *
 * Traced down the RIGHT side from the crown to the chin and then mirrored, so
 * the skull is symmetric by construction and there is one set of numbers to
 * argue with rather than two. Six control points do the whole job: crown,
 * temple, cheekbone, the angle of the jaw, the corner of the chin, the chin.
 *
 * The angle of the jaw is the one that matters. It is what separates a square
 * head from a tapered one, it is the parameter a viewer reads as "heavy" or
 * "fine", and it is worth more than every facial feature combined.
 */
export function skullPath(g: HeadGeometry): string {
  const { cx, crownY: A, chinY: C, h: H, hw, jw, cw } = g;

  // [c1x, c1y, c2x, c2y, x, y] for the right half, crown to chin.
  const segs: number[][] = [
    [cx + hw * 0.80, A, cx + hw * 1.00, A + H * 0.13, cx + hw * 0.99, A + H * 0.32],
    [cx + hw * 1.005, A + H * 0.42, cx + hw, A + H * 0.46, cx + hw, A + H * 0.53],
    [cx + hw * 0.985, A + H * 0.63, cx + jw * 1.06, A + H * 0.67, cx + jw, A + H * 0.76],
    [cx + jw * 0.93, A + H * 0.87, cx + cw * 1.62, C - H * 0.05, cx, C],
  ];

  let d = `M ${f1(cx)} ${f1(A)}`;
  for (const s of segs) {
    d += ` C ${f1(s[0])} ${f1(s[1])} ${f1(s[2])} ${f1(s[3])} ${f1(s[4])} ${f1(s[5])}`;
  }
  // Back up the left side: the same segments reversed, with the handles swapped
  // and every x reflected about the centre.
  const m = (x: number): number => 2 * cx - x;
  const starts = [[cx, A], ...segs.map((s) => [s[4], s[5]])];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    d += ` C ${f1(m(s[2]))} ${f1(s[3])} ${f1(m(s[0]))} ${f1(s[1])} `
      + `${f1(m(starts[i][0]))} ${f1(starts[i][1])}`;
  }
  return d + ' Z';
}

// ===========================================================================
// Hair
// ===========================================================================

/**
 * A cap of hair over the skull.
 *
 * Built as the top of the silhouette pushed OUTWARD by `vol` and closed along a
 * hairline. Pushing the real outline outward rather than drawing an independent
 * blob is what keeps hair attached to the head it is on: a wide skull gets wide
 * hair, and a long one gets tall hair, without either being a parameter.
 *
 * `front` raises the mass over the forehead, which is the difference between
 * hair combed down and hair swept back. `part` slides the hairline's high point
 * sideways; at zero it is a symmetric hairline and at one it is a side parting.
 */
function hairCap(
  g: HeadGeometry, vol: number, front: number, part: number, dip: number,
): string {
  const { cx, crownY: A, h: H, hw } = g;
  const top = A - vol * 0.9 - front * 0.55;
  const side = hw + vol * 0.72;
  // The hairline: high at the parting, falling away to the temples.
  const lineY = A + H * (0.215 - front * 0.0009) + dip * H * 0.055;
  const px = cx + part * hw * 0.52;

  return `M ${f1(cx - side)} ${f1(A + H * 0.40)}`
    + ` C ${f1(cx - side)} ${f1(top + H * 0.10)} ${f1(cx - side * 0.66)} ${f1(top)} ${f1(cx)} ${f1(top)}`
    + ` C ${f1(cx + side * 0.66)} ${f1(top)} ${f1(cx + side)} ${f1(top + H * 0.10)} ${f1(cx + side)} ${f1(A + H * 0.40)}`
    // Down the right temple, in along the hairline to the parting, and back out.
    + ` C ${f1(cx + side * 0.98)} ${f1(A + H * 0.30)} ${f1(cx + hw * 0.86)} ${f1(lineY + H * 0.06)} ${f1(cx + hw * 0.70)} ${f1(lineY + H * 0.045)}`
    + ` C ${f1(cx + hw * 0.40)} ${f1(lineY - H * 0.012)} ${f1(px + hw * 0.22)} ${f1(lineY - H * 0.028)} ${f1(px)} ${f1(lineY - H * 0.03)}`
    + ` C ${f1(px - hw * 0.30)} ${f1(lineY - H * 0.022)} ${f1(cx - hw * 0.48)} ${f1(lineY + H * 0.01)} ${f1(cx - hw * 0.72)} ${f1(lineY + H * 0.05)}`
    + ` C ${f1(cx - hw * 0.88)} ${f1(lineY + H * 0.07)} ${f1(cx - side * 0.98)} ${f1(A + H * 0.30)} ${f1(cx - side)} ${f1(A + H * 0.40)} Z`;
}

/** A receding hairline: the same cap, with a deep notch cut at each temple. */
function recedingCap(g: HeadGeometry, vol: number, depth: number): string {
  const { cx, crownY: A, h: H, hw } = g;
  const top = A - vol * 0.85;
  const side = hw + vol * 0.68;
  const lineY = A + H * (0.20 + depth * 0.16);
  const peak = A + H * (0.17 + depth * 0.05);

  return `M ${f1(cx - side)} ${f1(A + H * 0.42)}`
    + ` C ${f1(cx - side)} ${f1(top + H * 0.10)} ${f1(cx - side * 0.66)} ${f1(top)} ${f1(cx)} ${f1(top)}`
    + ` C ${f1(cx + side * 0.66)} ${f1(top)} ${f1(cx + side)} ${f1(top + H * 0.10)} ${f1(cx + side)} ${f1(A + H * 0.42)}`
    + ` C ${f1(cx + side * 0.96)} ${f1(A + H * 0.32)} ${f1(cx + hw * 0.90)} ${f1(lineY)} ${f1(cx + hw * 0.62)} ${f1(lineY)}`
    // The widow's peak: in and UP to a point on the centreline, then out again.
    + ` C ${f1(cx + hw * 0.40)} ${f1(lineY - H * 0.01)} ${f1(cx + hw * 0.22)} ${f1(peak)} ${f1(cx)} ${f1(peak)}`
    + ` C ${f1(cx - hw * 0.22)} ${f1(peak)} ${f1(cx - hw * 0.40)} ${f1(lineY - H * 0.01)} ${f1(cx - hw * 0.62)} ${f1(lineY)}`
    + ` C ${f1(cx - hw * 0.90)} ${f1(lineY)} ${f1(cx - side * 0.96)} ${f1(A + H * 0.32)} ${f1(cx - side)} ${f1(A + H * 0.42)} Z`;
}

/** Curls: the cap's outer edge scalloped, so the silhouette is broken up. */
function curlEdge(g: HeadGeometry, vol: number): string {
  const { cx, crownY: A, h: H, hw } = g;
  const r = hw + vol * 0.75;
  let out = '';
  // Eleven lobes around the top half. Odd, and at slightly uneven radii, so the
  // edge does not read as a gear.
  for (let i = 0; i <= 11; i++) {
    const a = Math.PI * (1.06 - (i / 11) * 1.12);
    const rr = r * (0.94 + ((i * 7) % 5) * 0.026);
    const x = cx + Math.cos(a) * rr;
    const y = A + H * 0.40 - Math.sin(a) * (rr * 0.96);
    out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(vol * 0.46 + hw * 0.10)}"/>`;
  }
  return out;
}

// ===========================================================================
// The drawing
// ===========================================================================

export interface HeadArt {
  geom: HeadGeometry;
  /** Gradient and clip definitions. Goes in one shared `<defs>`. */
  defs: string;
  /** Hair and headwear that sit BEHIND the body. Drawn first. */
  back: string;
  /** The head itself, everything in front. */
  front: string;
}

export interface HeadOptions {
  /** Distinct per instance; a press conference has fourteen heads on it. */
  uid: string;
  /** Team colour, for a cap. */
  team?: string;
  /** Second team colour, for the cap's peak and panel. */
  accent?: string;
  /**
   * Drop the interior modelling and paint the whole head flat.
   *
   * For the crowd and the journalists' row: sixty faces in the middle distance
   * with eye sockets and nostrils on them is sixty thousand path nodes spent
   * where the viewer is looking at the panel. See `Figure.crowdBand`.
   */
  flat?: boolean;
}

/**
 * The head, as markup.
 *
 * MARKUP RATHER THAN ELEMENTS, which is the opposite of the choice
 * `DriverPortrait.ts` makes, and the reason is that nothing untrusted reaches
 * this function. A helmet design is three colours out of a save file and a save
 * file can be hand-edited; a `PersonLook` is either authored in this repository
 * or produced by `lookFromSeed`, every field is a number that has been through
 * `coerceLook`, and every colour is an index into a table declared here. Names
 * and questions — the values that DO come from outside — never touch this file;
 * they are set with `textContent` by the screens.
 */
export function headArt(look: PersonLook, opts: HeadOptions): HeadArt {
  const g = headGeometry(look);
  const uid = opts.uid;
  const skin = complexionOf(look.complexion);
  const hair = hairOf(look.hairPigment);
  const skull = skullPath(g);
  const { cx, fx, crownY: A, chinY: C, h: H, hw, jw, browY, eyeY, noseY, mouthY, eyeSep } = g;

  // -- Definitions --------------------------------------------------------
  // The two stops of every terminator sit 20% apart on the light axis. Closer
  // and the face is a woodcut; further and it is an airbrush.
  // USER SPACE, NOT BOUNDING BOX. The first version of this declared the
  // gradients in objectBoundingBox units on a rectangle covering the whole
  // canvas, which put the terminator across the CANVAS rather than across the
  // head — every face came out evenly lit and read as a vinyl sticker. A
  // gradient that models a form has to be anchored to the form.
  const lightX = cx - hw * 1.10;
  const lightY = A - H * 0.18;
  const defs = `
<clipPath id="${uid}-skull"><path d="${skull}"/></clipPath>
<linearGradient id="${uid}-form" gradientUnits="userSpaceOnUse"
  x1="${f1(cx - hw * 0.95)}" y1="${f1(A + H * 0.10)}"
  x2="${f1(cx + hw * 1.05)}" y2="${f1(C + H * 0.02)}">
  <stop offset="26%" stop-color="${skin.shade}" stop-opacity="0"/>
  <stop offset="56%" stop-color="${skin.shade}" stop-opacity="0.30"/>
  <stop offset="82%" stop-color="${skin.shade}" stop-opacity="0.78"/>
  <stop offset="100%" stop-color="${skin.shade}" stop-opacity="1"/>
</linearGradient>
<radialGradient id="${uid}-lift" gradientUnits="userSpaceOnUse"
  cx="${f1(cx - hw * 0.34)}" cy="${f1(A + H * 0.22)}" r="${f1(hw * 1.30)}">
  <stop offset="0%" stop-color="${skin.lift}" stop-opacity="0.92"/>
  <stop offset="58%" stop-color="${skin.lift}" stop-opacity="0.26"/>
  <stop offset="100%" stop-color="${skin.lift}" stop-opacity="0"/>
</radialGradient>
<linearGradient id="${uid}-hair" gradientUnits="userSpaceOnUse"
  x1="${f1(lightX)}" y1="${f1(lightY)}"
  x2="${f1(cx + hw * 1.2)}" y2="${f1(C)}">
  <stop offset="0%" stop-color="${hair.lift}"/>
  <stop offset="34%" stop-color="${hair.base}"/>
  <stop offset="100%" stop-color="${hair.base}"/>
</linearGradient>`;

  // -- Hair, behind -------------------------------------------------------
  let back = '';
  const vol = hairVolume(look.hair, hw);
  if (look.hair === 'long') {
    // Two masses falling past the jaw, outside the silhouette, behind the head.
    back += `<path fill="url(#${uid}-hair)" d="`
      + `M ${f1(cx - hw * 0.95)} ${f1(A + H * 0.18)}`
      + ` C ${f1(cx - hw - vol)} ${f1(A + H * 0.5)} ${f1(cx - hw - vol * 1.1)} ${f1(C + H * 0.10)} ${f1(cx - hw * 0.82)} ${f1(C + H * 0.30)}`
      + ` L ${f1(cx - hw * 0.30)} ${f1(C + H * 0.22)}`
      + ` C ${f1(cx - hw * 0.66)} ${f1(C - H * 0.02)} ${f1(cx - hw * 0.80)} ${f1(A + H * 0.52)} ${f1(cx - hw * 0.62)} ${f1(A + H * 0.20)} Z`
      + `M ${f1(cx + hw * 0.95)} ${f1(A + H * 0.18)}`
      + ` C ${f1(cx + hw + vol)} ${f1(A + H * 0.5)} ${f1(cx + hw + vol * 1.1)} ${f1(C + H * 0.10)} ${f1(cx + hw * 0.82)} ${f1(C + H * 0.30)}`
      + ` L ${f1(cx + hw * 0.30)} ${f1(C + H * 0.22)}`
      + ` C ${f1(cx + hw * 0.66)} ${f1(C - H * 0.02)} ${f1(cx + hw * 0.80)} ${f1(A + H * 0.52)} ${f1(cx + hw * 0.62)} ${f1(A + H * 0.20)} Z"/>`;
  } else if (look.hair === 'bun') {
    back += `<circle cx="${f1(cx + g.turn * hw * 0.5)}" cy="${f1(A + H * 0.06)}" `
      + `r="${f1(hw * 0.30)}" fill="url(#${uid}-hair)"/>`;
  } else if (look.hair === 'tied') {
    back += `<path fill="url(#${uid}-hair)" d="`
      + `M ${f1(cx - hw * 0.2)} ${f1(A + H * 0.24)} L ${f1(cx + hw * 0.2)} ${f1(A + H * 0.24)}`
      + ` C ${f1(cx + hw * 0.5)} ${f1(A + H * 0.62)} ${f1(cx + hw * 0.42)} ${f1(C - H * 0.02)} ${f1(cx + hw * 0.10)} ${f1(C + H * 0.08)}`
      + ` C ${f1(cx - hw * 0.10)} ${f1(C - H * 0.06)} ${f1(cx - hw * 0.16)} ${f1(A + H * 0.60)} ${f1(cx - hw * 0.2)} ${f1(A + H * 0.24)} Z"/>`;
  }

  // -- Ears ---------------------------------------------------------------
  // The far one goes behind the cheek as the head turns. It is one conditional
  // and it is most of what sells the turn.
  const ear = (sx: number): string => {
    const x = cx + sx * hw * 0.93;
    const ry = (g.earBot - g.earTop) * 0.44;
    const cy = (g.earTop + g.earBot) / 2;
    return `<ellipse cx="${f1(x)}" cy="${f1(cy)}" `
      + `rx="${f1(hw * 0.115)}" ry="${f1(ry)}" fill="${skin.base}"/>`
      + `<ellipse cx="${f1(x + sx * hw * 0.03)}" cy="${f1(cy + ry * 0.08)}" `
      + `rx="${f1(hw * 0.055)}" ry="${f1(ry * 0.52)}" fill="${skin.shade}" opacity="0.55"/>`;
  };
  let ears = '';
  if (look.turn > -0.55) ears += ear(-1);
  if (look.turn < 0.55) ears += ear(1);

  // -- The head -----------------------------------------------------------
  let front = ears;
  front += `<path d="${skull}" fill="${skin.base}"/>`;

  const inner: string[] = [];
  // Form: the lit plane and the turned plane, in that order.
  inner.push(`<rect x="0" y="0" width="200" height="240" fill="url(#${uid}-lift)"/>`);
  inner.push(`<rect x="0" y="0" width="200" height="240" fill="url(#${uid}-form)"/>`);

  if (!opts.flat) {
    // The eye sockets. One band of shade under the brow across both eyes — a
    // real socket is a continuous recess and drawing two separate patches is
    // what gives generated faces their raccoon look.
    inner.push(`<path fill="${skin.shade}" opacity="0.34" d="`
      + `M ${f1(fx - eyeSep * 2.0)} ${f1(browY + H * 0.01)}`
      + ` C ${f1(fx - eyeSep * 0.6)} ${f1(browY - H * 0.02)} ${f1(fx + eyeSep * 0.6)} ${f1(browY - H * 0.02)} ${f1(fx + eyeSep * 2.0)} ${f1(browY + H * 0.01)}`
      + ` C ${f1(fx + eyeSep * 1.9)} ${f1(eyeY + H * 0.055)} ${f1(fx + eyeSep * 0.4)} ${f1(eyeY + H * 0.05)} ${f1(fx)} ${f1(eyeY + H * 0.035)}`
      + ` C ${f1(fx - eyeSep * 0.4)} ${f1(eyeY + H * 0.05)} ${f1(fx - eyeSep * 1.9)} ${f1(eyeY + H * 0.055)} ${f1(fx - eyeSep * 2.0)} ${f1(browY + H * 0.01)} Z"/>`);

    // The cheekbone catch, on the lit side only.
    inner.push(`<ellipse cx="${f1(fx - hw * 0.50)}" cy="${f1(eyeY + H * 0.10)}" `
      + `rx="${f1(hw * 0.26)}" ry="${f1(H * 0.075 * (0.6 + look.cheek * 0.8))}" `
      + `fill="${skin.lift}" opacity="${(0.16 + look.cheek * 0.22).toFixed(2)}" `
      + `transform="rotate(-18 ${f1(fx - hw * 0.50)} ${f1(eyeY + H * 0.10)})"/>`);

    inner.push(nose(g, look, skin));
    inner.push(eyes(g, look, skin, hair, uid));
    inner.push(mouth(g, look, skin));

    if (look.age > 0.42) {
      // The nasolabial fold, and one line under the eye. Two strokes, and they
      // are the entire difference between thirty-five and sixty.
      const a = (look.age - 0.42) * 1.4;
      inner.push(`<path fill="none" stroke="${skin.shade}" stroke-linecap="round" `
        + `stroke-width="${f1(H * 0.012)}" opacity="${(a * 0.55).toFixed(2)}" d="`
        + `M ${f1(fx - hw * 0.30)} ${f1(noseY - H * 0.01)} C ${f1(fx - hw * 0.40)} ${f1(noseY + H * 0.06)} ${f1(fx - hw * 0.44)} ${f1(mouthY + H * 0.01)} ${f1(fx - hw * 0.34)} ${f1(mouthY + H * 0.035)}`
        + `M ${f1(fx + hw * 0.30)} ${f1(noseY - H * 0.01)} C ${f1(fx + hw * 0.40)} ${f1(noseY + H * 0.06)} ${f1(fx + hw * 0.44)} ${f1(mouthY + H * 0.01)} ${f1(fx + hw * 0.34)} ${f1(mouthY + H * 0.035)}"/>`);
      inner.push(`<path fill="none" stroke="${skin.shade}" stroke-linecap="round" `
        + `stroke-width="${f1(H * 0.008)}" opacity="${(a * 0.4).toFixed(2)}" d="`
        + `M ${f1(fx - eyeSep * 1.45)} ${f1(eyeY + H * 0.045)} Q ${f1(fx - eyeSep)} ${f1(eyeY + H * 0.065)} ${f1(fx - eyeSep * 0.55)} ${f1(eyeY + H * 0.045)}`
        + `M ${f1(fx + eyeSep * 0.55)} ${f1(eyeY + H * 0.045)} Q ${f1(fx + eyeSep)} ${f1(eyeY + H * 0.065)} ${f1(fx + eyeSep * 1.45)} ${f1(eyeY + H * 0.045)}"/>`);
    }
  }

  // The jaw's own shadow, thrown down and to the right onto the neck. Drawn
  // inside the skull clip as its underside, and again outside it by `Figure`.
  inner.push(`<path fill="${skin.shade}" opacity="0.17" d="`
    + `M ${f1(cx - jw)} ${f1(C - H * 0.10)} C ${f1(cx - jw * 0.5)} ${f1(C + H * 0.06)} ${f1(cx + jw * 0.5)} ${f1(C + H * 0.06)} ${f1(cx + jw)} ${f1(C - H * 0.14)}`
    + ` L ${f1(cx + jw)} ${f1(C + H * 0.2)} L ${f1(cx - jw)} ${f1(C + H * 0.2)} Z"/>`);

  front += `<g clip-path="url(#${uid}-skull)">${inner.join('')}</g>`;

  // -- Facial hair --------------------------------------------------------
  if (!opts.flat) front += facialHair(g, look, hair, uid);

  // -- Hair, in front -----------------------------------------------------
  front += hairFront(g, look, hair, uid, vol);

  // -- Eyewear ------------------------------------------------------------
  if (!opts.flat) front += eyewear(g, look);

  // -- Headwear -----------------------------------------------------------
  front += headwear(g, look, opts);

  return { geom: g, defs, back, front };
}

function hairVolume(style: PersonLook['hair'], hw: number): number {
  switch (style) {
    case 'bald': return 0;
    case 'shaved': return hw * 0.03;
    case 'crop': return hw * 0.10;
    case 'receding': return hw * 0.10;
    case 'side': return hw * 0.17;
    case 'swept': return hw * 0.20;
    case 'volume': return hw * 0.30;
    case 'curls': return hw * 0.30;
    case 'long': return hw * 0.24;
    case 'tied': return hw * 0.12;
    case 'bun': return hw * 0.13;
    default: return hw * 0.12;
  }
}

function hairFront(
  g: HeadGeometry, look: PersonLook, hair: { base: string; lift: string },
  uid: string, vol: number,
): string {
  const fill = `url(#${uid}-hair)`;
  const { cx, crownY: A, h: H, hw } = g;

  switch (look.hair) {
    case 'bald':
      // Not nothing: a band of very short hair around the sides and back, which
      // is what a bald head over forty actually is, plus the sheen the key puts
      // on a scalp. A head with neither reads as an egg.
      return `<g clip-path="url(#${uid}-skull)"><path fill="${hair.base}" opacity="0.9" d="`
        + `M ${f1(cx - hw * 1.06)} ${f1(A + H * 0.24)} C ${f1(cx - hw * 1.10)} ${f1(A + H * 0.52)} ${f1(cx - hw * 0.96)} ${f1(A + H * 0.64)} ${f1(cx - hw * 0.84)} ${f1(A + H * 0.68)}`
        + ` C ${f1(cx - hw * 0.86)} ${f1(A + H * 0.50)} ${f1(cx - hw * 0.84)} ${f1(A + H * 0.34)} ${f1(cx - hw * 0.78)} ${f1(A + H * 0.26)} Z`
        + `M ${f1(cx + hw * 1.06)} ${f1(A + H * 0.24)} C ${f1(cx + hw * 1.10)} ${f1(A + H * 0.52)} ${f1(cx + hw * 0.96)} ${f1(A + H * 0.64)} ${f1(cx + hw * 0.84)} ${f1(A + H * 0.68)}`
        + ` C ${f1(cx + hw * 0.86)} ${f1(A + H * 0.50)} ${f1(cx + hw * 0.84)} ${f1(A + H * 0.34)} ${f1(cx + hw * 0.78)} ${f1(A + H * 0.26)} Z"/></g>`
        + `<ellipse cx="${f1(cx - hw * 0.30)}" cy="${f1(A + H * 0.10)}" rx="${f1(hw * 0.30)}" `
        + `ry="${f1(H * 0.075)}" fill="#fff" opacity="0.10" transform="rotate(-20 ${f1(cx - hw * 0.30)} ${f1(A + H * 0.10)})"/>`;

    case 'receding':
      return `<path fill="${fill}" d="${recedingCap(g, vol, 0.55 + look.age * 0.35)}"/>`;

    case 'curls':
      return `<g fill="${fill}">${curlEdge(g, vol)}`
        + `<path d="${hairCap(g, vol * 0.7, 0, 0, 0)}"/></g>`;

    case 'swept':
      // The mass rises above the crown at the FRONT and falls away behind.
      return `<path fill="${fill}" d="${hairCap(g, vol, vol * 1.5, 0.25, -0.35)}"/>`;

    case 'side':
      return `<path fill="${fill}" d="${hairCap(g, vol, vol * 0.4, 0.85, 0)}"/>`
        // The parting itself: one shade line where the mass splits.
        + `<path fill="none" stroke="${hair.base}" stroke-width="${f1(hw * 0.05)}" opacity="0.7" d="`
        + `M ${f1(cx + hw * 0.44)} ${f1(A + H * 0.20)} C ${f1(cx + hw * 0.30)} ${f1(A + H * 0.08)} ${f1(cx + hw * 0.10)} ${f1(A + H * 0.02)} ${f1(cx - hw * 0.10)} ${f1(A + H * 0.01)}"/>`;

    case 'shaved':
      return `<path fill="${hair.base}" opacity="0.80" d="${hairCap(g, vol, 0, 0, 0.10)}"/>`;

    case 'long':
    case 'tied':
    case 'bun':
    case 'crop':
    case 'volume':
    default:
      return `<path fill="${fill}" d="${hairCap(g, vol, vol * 0.25, 0.2, 0)}"/>`;
  }
}

/**
 * The nose: a shadow, a catch and two nostrils. No outline anywhere.
 *
 * The shadow runs down the side AWAY from the key and turns under the tip; the
 * catch runs down the bridge on the lit side. Together they are a nose. An
 * outlined nose is a clown's.
 */
function nose(
  g: HeadGeometry, look: PersonLook, skin: { base: string; lift: string; shade: string },
): string {
  const { fx, eyeY, noseY, h: H, hw } = g;
  const w = hw * (0.115 + look.noseWidth * 0.085);
  const bridge = eyeY - H * 0.01;
  return `<path fill="${skin.shade}" opacity="0.30" d="`
    + `M ${f1(fx + w * 0.24)} ${f1(bridge + (noseY - bridge) * 0.10)}`
    + ` C ${f1(fx + w * 0.52)} ${f1(bridge + (noseY - bridge) * 0.50)} ${f1(fx + w * 0.95)} ${f1(noseY - H * 0.035)} ${f1(fx + w * 1.05)} ${f1(noseY)}`
    + ` C ${f1(fx + w * 0.7)} ${f1(noseY + H * 0.022)} ${f1(fx - w * 0.7)} ${f1(noseY + H * 0.022)} ${f1(fx - w * 1.0)} ${f1(noseY)}`
    + ` C ${f1(fx - w * 0.5)} ${f1(noseY - H * 0.012)} ${f1(fx - w * 0.1)} ${f1(noseY - H * 0.03)} ${f1(fx + w * 0.24)} ${f1(bridge + (noseY - bridge) * 0.10)} Z"/>`
    + `<path fill="none" stroke="${skin.lift}" stroke-linecap="round" opacity="0.26" `
    + `stroke-width="${f1(w * 0.30)}" d="`
    + `M ${f1(fx - w * 0.22)} ${f1(bridge + (noseY - bridge) * 0.30)} `
    + `C ${f1(fx - w * 0.30)} ${f1(bridge + (noseY - bridge) * 0.62)} ${f1(fx - w * 0.34)} ${f1(noseY - H * 0.045)} ${f1(fx - w * 0.12)} ${f1(noseY - H * 0.022)}"/>`
    // The ball of the nose: one small catch where it turns toward the key.
    + `<ellipse cx="${f1(fx - w * 0.22)}" cy="${f1(noseY - H * 0.022)}" rx="${f1(w * 0.30)}" `
    + `ry="${f1(w * 0.22)}" fill="${skin.lift}" opacity="0.34"/>`
    + `<ellipse cx="${f1(fx - w * 0.62)}" cy="${f1(noseY + H * 0.002)}" rx="${f1(w * 0.17)}" `
    + `ry="${f1(w * 0.12)}" fill="${skin.shade}" opacity="0.62"/>`
    + `<ellipse cx="${f1(fx + w * 0.66)}" cy="${f1(noseY + H * 0.002)}" rx="${f1(w * 0.17)}" `
    + `ry="${f1(w * 0.12)}" fill="${skin.shade}" opacity="0.62"/>`;
}

/**
 * The eyes, and the brows over them.
 *
 * A sclera in white is what makes a drawn eye look startled — a real eye in a
 * lit face is never brighter than the forehead, because it sits at the bottom
 * of a socket. So the white here is the complexion's own light stop knocked
 * back, the top third is under the lid's shadow, and the catchlight is a single
 * dot on the upper LEFT of the iris, agreeing with the key.
 *
 * The brows carry more identity than the eyes do and are drawn heavier: a
 * stroke whose weight, arch and length all come off the look.
 */
function eyes(
  g: HeadGeometry, look: PersonLook,
  skin: { base: string; lift: string; shade: string },
  hair: { base: string; lift: string }, uid: string,
): string {
  const { fx, eyeY, browY, h: H, hw } = g;
  const w = hw * 0.22;
  const openness = 1 - look.age * 0.30;
  const hgt = w * 0.50 * openness;
  let out = '';

  for (const s of [-1, 1] as const) {
    const x = fx + s * g.eyeSep;
    const id = `${uid}-eye${s < 0 ? 'l' : 'r'}`;
    // The eye opening, as an almond. Wider at the outer corner, which is what
    // makes an eye an eye rather than a lens.
    const d = `M ${f1(x - w)} ${f1(eyeY + hgt * 0.10)}`
      + ` C ${f1(x - w * 0.55)} ${f1(eyeY - hgt)} ${f1(x + w * 0.55)} ${f1(eyeY - hgt)} ${f1(x + w)} ${f1(eyeY + hgt * 0.10)}`
      + ` C ${f1(x + w * 0.55)} ${f1(eyeY + hgt * 1.05)} ${f1(x - w * 0.55)} ${f1(eyeY + hgt * 1.05)} ${f1(x - w)} ${f1(eyeY + hgt * 0.10)} Z`;
    out += `<clipPath id="${id}"><path d="${d}"/></clipPath>`;
    out += `<path d="${d}" fill="${skin.lift}" opacity="0.62"/>`;
    out += `<g clip-path="url(#${id})">`
      // Iris, then pupil, then the lid shadow over the top third.
      + `<circle cx="${f1(x + look.turn * w * 0.30)}" cy="${f1(eyeY + hgt * 0.05)}" r="${f1(w * 0.46)}" fill="#4a3a2c"/>`
      + `<circle cx="${f1(x + look.turn * w * 0.30)}" cy="${f1(eyeY + hgt * 0.05)}" r="${f1(w * 0.22)}" fill="#140f0b"/>`
      + `<circle cx="${f1(x + look.turn * w * 0.30 - w * 0.20)}" cy="${f1(eyeY - hgt * 0.20)}" r="${f1(w * 0.10)}" fill="#fff" opacity="0.85"/>`
      + `<rect x="${f1(x - w)}" y="${f1(eyeY - hgt * 1.2)}" width="${f1(w * 2)}" height="${f1(hgt * 0.95)}" fill="${skin.shade}" opacity="0.5"/>`
      + `</g>`;
    // The lash line: the top edge, weighted. Not an outline of the eye — only
    // the upper arc, which is where a real lid is dark.
    out += `<path fill="none" stroke="#2b211a" stroke-opacity="0.72" stroke-linecap="round" `
      + `stroke-width="${f1(w * 0.16)}" d="`
      + `M ${f1(x - w * 0.94)} ${f1(eyeY + hgt * 0.04)} C ${f1(x - w * 0.5)} ${f1(eyeY - hgt * 0.92)} ${f1(x + w * 0.5)} ${f1(eyeY - hgt * 0.92)} ${f1(x + w * 0.94)} ${f1(eyeY + hgt * 0.04)}"/>`;

    // The brow.
    const bw = w * (1.22 + look.brow * 0.30);
    const arch = H * (0.018 + (1 - look.brow) * 0.020);
    const lift = s < 0 ? 0 : H * 0.004;
    out += `<path fill="none" stroke="${hair.base}" stroke-linecap="round" opacity="0.92" `
      + `stroke-width="${f1(H * (0.011 + look.brow * 0.011))}" d="`
      + `M ${f1(x - bw)} ${f1(browY + arch * 0.55 + lift)}`
      + ` C ${f1(x - bw * 0.45)} ${f1(browY - arch + lift)} ${f1(x + bw * 0.35)} ${f1(browY - arch * 0.85 + lift)} ${f1(x + bw)} ${f1(browY + arch * 0.30 + lift)}"/>`;
  }
  return out;
}

/** The mouth: a shadow line, an upper-lip shade and a lower-lip catch. */
function mouth(
  g: HeadGeometry, look: PersonLook, skin: { base: string; lift: string; shade: string },
): string {
  const { fx, mouthY, h: H, hw } = g;
  const w = hw * (0.28 + look.mouth * 0.14);
  const t = H * (0.012 + look.lips * 0.011);
  return `<path fill="none" stroke="#57342b" stroke-opacity="0.74" stroke-linecap="round" `
    + `stroke-width="${f1(t)}" d="`
    + `M ${f1(fx - w)} ${f1(mouthY - H * 0.004)} C ${f1(fx - w * 0.35)} ${f1(mouthY + H * 0.012)} ${f1(fx + w * 0.35)} ${f1(mouthY + H * 0.012)} ${f1(fx + w)} ${f1(mouthY - H * 0.004)}"/>`
    + `<path fill="${skin.lift}" opacity="0.34" d="`
    + `M ${f1(fx - w * 0.78)} ${f1(mouthY + H * 0.014)} C ${f1(fx - w * 0.3)} ${f1(mouthY + H * 0.038)} ${f1(fx + w * 0.3)} ${f1(mouthY + H * 0.038)} ${f1(fx + w * 0.78)} ${f1(mouthY + H * 0.014)}`
    + ` C ${f1(fx + w * 0.3)} ${f1(mouthY + H * 0.020)} ${f1(fx - w * 0.3)} ${f1(mouthY + H * 0.020)} ${f1(fx - w * 0.78)} ${f1(mouthY + H * 0.014)} Z"/>`
    + `<path fill="${skin.shade}" opacity="0.26" d="`
    + `M ${f1(fx - w * 0.55)} ${f1(mouthY + H * 0.045)} C ${f1(fx - w * 0.2)} ${f1(mouthY + H * 0.062)} ${f1(fx + w * 0.2)} ${f1(mouthY + H * 0.062)} ${f1(fx + w * 0.55)} ${f1(mouthY + H * 0.045)}`
    + ` C ${f1(fx + w * 0.2)} ${f1(mouthY + H * 0.052)} ${f1(fx - w * 0.2)} ${f1(mouthY + H * 0.052)} ${f1(fx - w * 0.55)} ${f1(mouthY + H * 0.045)} Z"/>`;
}

/**
 * Beards.
 *
 * Clipped to the skull for everything except a full beard, which is allowed to
 * break the silhouette — that is the whole reason to have one in the set. A
 * beard that stays inside the head outline changes the face's value and not its
 * shape, and shape is what the eye sorts people by.
 */
function facialHair(
  g: HeadGeometry, look: PersonLook, hair: { base: string; lift: string }, uid: string,
): string {
  const { cx, fx, chinY: C, noseY, mouthY, h: H, hw, jw } = g;
  if (look.facialHair === 'none') return '';

  const moustache = `<path fill="${hair.base}" opacity="0.86" d="`
    + `M ${f1(fx - hw * 0.24)} ${f1(mouthY - H * 0.028)}`
    + ` C ${f1(fx - hw * 0.10)} ${f1(mouthY - H * 0.044)} ${f1(fx + hw * 0.10)} ${f1(mouthY - H * 0.044)} ${f1(fx + hw * 0.24)} ${f1(mouthY - H * 0.028)}`
    + ` C ${f1(fx + hw * 0.20)} ${f1(mouthY - H * 0.012)} ${f1(fx - hw * 0.20)} ${f1(mouthY - H * 0.012)} ${f1(fx - hw * 0.24)} ${f1(mouthY - H * 0.028)} Z"/>`;

  const chinPatch = `<path fill="${hair.base}" opacity="0.86" d="`
    + `M ${f1(fx - hw * 0.16)} ${f1(mouthY + H * 0.052)}`
    + ` C ${f1(fx - hw * 0.17)} ${f1(C - H * 0.055)} ${f1(fx + hw * 0.17)} ${f1(C - H * 0.055)} ${f1(fx + hw * 0.16)} ${f1(mouthY + H * 0.052)}`
    + ` C ${f1(fx + hw * 0.07)} ${f1(mouthY + H * 0.034)} ${f1(fx - hw * 0.07)} ${f1(mouthY + H * 0.034)} ${f1(fx - hw * 0.16)} ${f1(mouthY + H * 0.052)} Z"/>`;

  switch (look.facialHair) {
    case 'stubble':
      // A wash over the beard area, not a shape. Opacity does the whole job.
      return `<g clip-path="url(#${uid}-skull)"><path fill="${hair.base}" opacity="0.26" d="`
        + `M ${f1(cx - jw * 1.02)} ${f1(noseY - H * 0.02)}`
        + ` C ${f1(cx - jw)} ${f1(C + H * 0.02)} ${f1(cx + jw)} ${f1(C + H * 0.02)} ${f1(cx + jw * 1.02)} ${f1(noseY - H * 0.02)}`
        + ` L ${f1(cx + jw * 1.02)} ${f1(C + H * 0.1)} L ${f1(cx - jw * 1.02)} ${f1(C + H * 0.1)} Z"/></g>`
        + moustache.replace('0.92', '0.22');

    case 'moustache':
      return moustache;

    case 'goatee':
      return moustache + chinPatch;

    case 'beard':
      // Jaw-following, inside the silhouette: sideburns to chin.
      return `<g clip-path="url(#${uid}-skull)"><path fill="${hair.base}" opacity="0.94" d="`
        + `M ${f1(cx - hw * 1.02)} ${f1(g.earTop)}`
        + ` C ${f1(cx - hw * 1.02)} ${f1(C - H * 0.02)} ${f1(cx + hw * 1.02)} ${f1(C - H * 0.02)} ${f1(cx + hw * 1.02)} ${f1(g.earTop)}`
        + ` L ${f1(cx + hw * 1.02)} ${f1(C + H * 0.2)} L ${f1(cx - hw * 1.02)} ${f1(C + H * 0.2)} Z"/>`
        // The bare upper lip and the mouth cut back out of it.
        + `<path fill="none" d="M0 0"/></g>`
        + moustache;

    case 'full':
    default:
      // Breaks the silhouette, on purpose.
      return `<path fill="url(#${uid}-hair)" d="`
        + `M ${f1(cx - hw * 1.00)} ${f1(g.earTop + H * 0.04)}`
        + ` C ${f1(cx - hw * 1.14)} ${f1(C - H * 0.02)} ${f1(cx - hw * 0.66)} ${f1(C + H * 0.20)} ${f1(cx)} ${f1(C + H * 0.22)}`
        + ` C ${f1(cx + hw * 0.66)} ${f1(C + H * 0.20)} ${f1(cx + hw * 1.14)} ${f1(C - H * 0.02)} ${f1(cx + hw * 1.00)} ${f1(g.earTop + H * 0.04)}`
        + ` C ${f1(cx + hw * 0.9)} ${f1(noseY + H * 0.02)} ${f1(cx + hw * 0.5)} ${f1(mouthY - H * 0.05)} ${f1(fx + hw * 0.30)} ${f1(mouthY - H * 0.03)}`
        + ` C ${f1(fx)} ${f1(mouthY - H * 0.055)} ${f1(fx)} ${f1(mouthY - H * 0.055)} ${f1(fx - hw * 0.30)} ${f1(mouthY - H * 0.03)}`
        + ` C ${f1(cx - hw * 0.5)} ${f1(mouthY - H * 0.05)} ${f1(cx - hw * 0.9)} ${f1(noseY + H * 0.02)} ${f1(cx - hw * 1.00)} ${f1(g.earTop + H * 0.04)} Z"/>`;
  }
}

/** Frames, arms, and one streak of reflection so the lenses are glass. */
function eyewear(g: HeadGeometry, look: PersonLook): string {
  if (look.eyewear === 'none') return '';
  const { fx, eyeY, h: H, hw, cx } = g;
  const w = g.eyeSep * 0.98;
  const hgt = look.eyewear === 'shades' ? H * 0.052 : H * 0.042;
  const stroke = look.eyewear === 'thin' ? H * 0.006 : H * 0.011;
  const rx = look.eyewear === 'round' ? w : w * 0.30;
  const ink = '#12161c';
  let out = '';

  for (const s of [-1, 1] as const) {
    const x = fx + s * g.eyeSep;
    if (look.eyewear === 'shades') {
      out += `<rect x="${f1(x - w)}" y="${f1(eyeY - hgt)}" width="${f1(w * 2)}" `
        + `height="${f1(hgt * 2)}" rx="${f1(H * 0.014)}" fill="#0f1319" opacity="0.94"/>`
        + `<path d="M ${f1(x - w * 0.8)} ${f1(eyeY + hgt * 0.7)} L ${f1(x - w * 0.1)} ${f1(eyeY - hgt * 0.8)} `
        + `L ${f1(x + w * 0.25)} ${f1(eyeY - hgt * 0.8)} L ${f1(x - w * 0.45)} ${f1(eyeY + hgt * 0.7)} Z" `
        + `fill="#fff" opacity="0.16"/>`;
    } else {
      out += `<rect x="${f1(x - w)}" y="${f1(eyeY - hgt)}" width="${f1(w * 2)}" `
        + `height="${f1(hgt * 2)}" rx="${f1(rx)}" fill="#eaf2ff" fill-opacity="0.07" `
        + `stroke="${ink}" stroke-opacity="0.88" stroke-width="${f1(stroke)}"/>`
        + `<path d="M ${f1(x - w * 0.7)} ${f1(eyeY + hgt * 0.6)} L ${f1(x + w * 0.1)} ${f1(eyeY - hgt * 0.7)}" `
        + `stroke="#fff" stroke-opacity="0.22" stroke-width="${f1(H * 0.010)}"/>`;
    }
    // The arm, back to the ear.
    out += `<path d="M ${f1(x + s * w)} ${f1(eyeY - hgt * 0.35)} L ${f1(cx + s * hw * 1.0)} ${f1(g.earTop + H * 0.02)}" `
      + `stroke="${ink}" stroke-opacity="0.8" stroke-width="${f1(stroke)}" fill="none"/>`;
  }
  // The bridge.
  out += `<path d="M ${f1(fx - g.eyeSep + w)} ${f1(eyeY - hgt * 0.4)} L ${f1(fx + g.eyeSep - w)} ${f1(eyeY - hgt * 0.4)}" `
    + `stroke="${ink}" stroke-opacity="0.88" stroke-width="${f1(stroke)}" fill="none"/>`;
  return out;
}

/**
 * The cap and the headset.
 *
 * The cap takes the TEAM's colour, which is why it is worth having: it is the
 * paddock uniform, and it makes a crew member legible as belonging to somebody
 * from across the garage. Peak forward, peak backward, and a headset over
 * either — four silhouettes off one shape.
 */
function headwear(g: HeadGeometry, look: PersonLook, opts: HeadOptions): string {
  const { cx, crownY: A, h: H, hw } = g;
  const team = opts.team ?? '#2b3440';
  const accent = opts.accent ?? '#0d1218';
  const wantsCap = look.headwear === 'cap' || look.headwear === 'capBack'
    || look.headwear === 'capHeadset';
  const wantsSet = look.headwear === 'headset' || look.headwear === 'capHeadset';
  let out = '';

  if (wantsCap) {
    // The peak points forward or back, and it is the whole difference between
    // the two silhouettes: a crown alone is a beanie.
    const s = look.headwear === 'capBack' ? -1 : 1;
    const brim = A + H * 0.155;
    const top = A - H * 0.075;
    const w = hw * 1.06;

    // The crown, as a proper dome sitting ON the skull: the sides come down
    // past the temples and the band closes flat across the brow.
    out += `<path fill="${team}" d="`
      + `M ${f1(cx - w)} ${f1(brim)}`
      + ` C ${f1(cx - w)} ${f1(top + H * 0.02)} ${f1(cx - w * 0.62)} ${f1(top)} ${f1(cx)} ${f1(top)}`
      + ` C ${f1(cx + w * 0.62)} ${f1(top)} ${f1(cx + w)} ${f1(top + H * 0.02)} ${f1(cx + w)} ${f1(brim)}`
      + ` C ${f1(cx + w * 0.5)} ${f1(brim + H * 0.022)} ${f1(cx - w * 0.5)} ${f1(brim + H * 0.022)} ${f1(cx - w)} ${f1(brim)} Z"/>`
      // The peak. Drawn on the right and mirrored for a backwards cap, so both
      // silhouettes come off one path.
      + `<g transform="${s < 0 ? `translate(${f1(2 * cx)} 0) scale(-1 1)` : ''}">`
      + `<path fill="${accent}" d="`
      + `M ${f1(cx - w * 0.72)} ${f1(brim + H * 0.004)}`
      + ` C ${f1(cx - w * 0.30)} ${f1(brim + H * 0.10)} ${f1(cx + w * 0.55)} ${f1(brim + H * 0.115)} ${f1(cx + w * 1.34)} ${f1(brim + H * 0.058)}`
      + ` C ${f1(cx + w * 1.10)} ${f1(brim + H * 0.008)} ${f1(cx + w * 0.55)} ${f1(brim - H * 0.012)} ${f1(cx - w * 0.72)} ${f1(brim + H * 0.004)} Z"/></g>`
      // The band across the brow, one shade darker than the crown, and the
      // panel seam. Both are what make it cloth rather than a hemisphere.
      + `<path fill="rgba(0,0,0,0.22)" d="`
      + `M ${f1(cx - w)} ${f1(brim)} C ${f1(cx - w * 0.5)} ${f1(brim + H * 0.022)} ${f1(cx + w * 0.5)} ${f1(brim + H * 0.022)} ${f1(cx + w)} ${f1(brim)}`
      + ` L ${f1(cx + w * 0.995)} ${f1(brim - H * 0.032)} C ${f1(cx + w * 0.5)} ${f1(brim - H * 0.012)} ${f1(cx - w * 0.5)} ${f1(brim - H * 0.012)} ${f1(cx - w * 0.995)} ${f1(brim - H * 0.032)} Z"/>`
      + `<path fill="none" stroke="rgba(0,0,0,0.24)" stroke-width="${f1(H * 0.006)}" d="`
      + `M ${f1(cx)} ${f1(top)} L ${f1(cx)} ${f1(brim - H * 0.02)}"/>`
      // The key's catch on the upper-left panel.
      + `<path fill="#fff" opacity="0.13" d="`
      + `M ${f1(cx - w * 0.98)} ${f1(brim - H * 0.03)} C ${f1(cx - w * 0.96)} ${f1(top + H * 0.03)} ${f1(cx - w * 0.5)} ${f1(top + H * 0.004)} ${f1(cx - w * 0.10)} ${f1(top + H * 0.002)}`
      + ` C ${f1(cx - w * 0.55)} ${f1(top + H * 0.055)} ${f1(cx - w * 0.80)} ${f1(brim - H * 0.075)} ${f1(cx - w * 0.98)} ${f1(brim - H * 0.03)} Z"/>`;
  }

  if (wantsSet) {
    const ink = '#161b22';
    out += `<path fill="none" stroke="${ink}" stroke-width="${f1(H * 0.026)}" stroke-linecap="round" d="`
      + `M ${f1(cx - hw * 1.02)} ${f1(A + H * 0.30)} C ${f1(cx - hw * 0.9)} ${f1(A - H * 0.06)} ${f1(cx + hw * 0.9)} ${f1(A - H * 0.06)} ${f1(cx + hw * 1.02)} ${f1(A + H * 0.30)}"/>`
      + `<rect x="${f1(cx - hw * 1.20)}" y="${f1(g.earTop - H * 0.02)}" width="${f1(hw * 0.30)}" `
      + `height="${f1(H * 0.16)}" rx="${f1(hw * 0.12)}" fill="${ink}"/>`
      + `<rect x="${f1(cx + hw * 0.90)}" y="${f1(g.earTop - H * 0.02)}" width="${f1(hw * 0.30)}" `
      + `height="${f1(H * 0.16)}" rx="${f1(hw * 0.12)}" fill="${ink}"/>`
      // The boom, down to the corner of the mouth.
      + `<path fill="none" stroke="${ink}" stroke-width="${f1(H * 0.013)}" stroke-linecap="round" d="`
      + `M ${f1(cx - hw * 1.02)} ${f1(g.earBot - H * 0.01)} C ${f1(cx - hw * 1.00)} ${f1(g.mouthY)} ${f1(cx - hw * 0.86)} ${f1(g.mouthY + H * 0.03)} ${f1(cx - hw * 0.52)} ${f1(g.mouthY + H * 0.02)}"/>`
      + `<circle cx="${f1(cx - hw * 0.48)}" cy="${f1(g.mouthY + H * 0.02)}" r="${f1(hw * 0.07)}" fill="${ink}"/>`;
  }
  return out;
}

// ===========================================================================
// The convenience wrapper
// ===========================================================================

export interface FaceOptions extends Partial<HeadOptions> {
  /** Pixel width. Height follows the crop. */
  size?: number;
  /** How much shoulder to include. 0 is the head alone. */
  crop?: 'head' | 'bust';
  /** Race suit or team shirt, for a bust. */
  suit?: string;
  accent?: string;
}

let uidCounter = 0;

/**
 * A head, as an element ready to append.
 *
 * The small unit: a byline, a row, a chip. For anything with a body in it use
 * `Figure.ts`, which composes the same `headArt` onto a torso.
 */
export function faceSvg(look: PersonLook, opts: FaceOptions = {}): SVGSVGElement {
  const uid = opts.uid ?? 'fa' + (++uidCounter);
  const bust = opts.crop !== 'head';
  const art = headArt(look, { uid, team: opts.team, accent: opts.accent, flat: opts.flat });
  const g = art.geom;
  const suit = opts.suit ?? '#1d252f';
  const accent = opts.accent ?? 'rgba(0,0,0,0.34)';
  const skin = complexionOf(look.complexion);

  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  const top = g.crownY - g.hw * 0.55;
  const height = bust ? 236 - top : (g.neckY - 4) - top;
  svg.setAttribute('viewBox', `18 ${f1(top)} 164 ${f1(height)}`);
  svg.setAttribute('class', 'person-face');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-hidden', 'true');
  if (opts.size) {
    svg.setAttribute('width', String(opts.size));
    svg.setAttribute('height', String(Math.round(opts.size * (height / 164))));
  }

  svg.innerHTML = `<defs>${art.defs}</defs>${art.back}`
    + (bust ? bustArt(g, look, suit, accent, skin) : '')
    + art.front;
  return svg;
}

/**
 * Neck, shoulders and collar.
 *
 * Two things were wrong with the first version and both of them were
 * proportion. The neck ran forty units from the jaw to the collar, which is a
 * giraffe; and the shoulders started so low in the frame that only their top
 * twenty units were visible, which is a bowling pin. A bust is roughly
 * two-thirds head and one-third shoulder, the neck is about a sixth of the head
 * height, and the shoulders are twice as wide as the skull. Those three numbers
 * are the whole of it.
 *
 * The order matters: neck first, then the shirt over it, then the collar. Drawn
 * the other way round the shirt is worn under the neck.
 */
function bustArt(
  g: HeadGeometry, look: PersonLook, suit: string, accent: string,
  skin: { base: string; shade: string; lift: string },
): string {
  const { cx, chinY: C, h: H, jw, neckY, neckHalf } = g;
  const shoulderY = C + H * 0.30;
  const half = g.hw * (1.85 + look.build * 0.95);
  const jawShade = C + H * 0.02;

  return `<path fill="${skin.base}" d="`
    + `M ${f1(cx - neckHalf)} ${f1(C - H * 0.10)} L ${f1(cx + neckHalf)} ${f1(C - H * 0.10)}`
    + ` C ${f1(cx + neckHalf * 1.06)} ${f1(neckY)} ${f1(cx + neckHalf * 1.25)} ${f1(neckY + H * 0.06)} ${f1(cx + neckHalf * 1.4)} ${f1(shoulderY)}`
    + ` L ${f1(cx - neckHalf * 1.4)} ${f1(shoulderY)}`
    + ` C ${f1(cx - neckHalf * 1.25)} ${f1(neckY + H * 0.06)} ${f1(cx - neckHalf * 1.06)} ${f1(neckY)} ${f1(cx - neckHalf)} ${f1(C - H * 0.10)} Z"/>`
    // The head's own shadow on the neck. The single strongest cue that the head
    // is in front of the body rather than pasted onto it.
    + `<path fill="${skin.shade}" opacity="0.55" d="`
    + `M ${f1(cx - neckHalf * 1.02)} ${f1(C - H * 0.10)}`
    + ` C ${f1(cx - jw * 0.55)} ${f1(jawShade + H * 0.05)} ${f1(cx + jw * 0.55)} ${f1(jawShade + H * 0.05)} ${f1(cx + neckHalf * 1.02)} ${f1(C - H * 0.10)}`
    + ` L ${f1(cx + neckHalf * 1.06)} ${f1(neckY)} L ${f1(cx - neckHalf * 1.06)} ${f1(neckY)} Z"/>`
    // The shirt. Shoulders that run OUT of the frame, as `DriverPortrait` also
    // insists: a bust that ends inside the picture is a bust, and a bust
    // cropped by the frame is somebody standing there.
    + `<path fill="${suit}" d="`
    + `M ${f1(cx - half)} 240 L ${f1(cx - half)} ${f1(shoulderY + H * 0.10)}`
    + ` C ${f1(cx - half * 0.70)} ${f1(shoulderY - H * 0.02)} ${f1(cx - neckHalf * 2.0)} ${f1(shoulderY - H * 0.05)} ${f1(cx - neckHalf * 1.35)} ${f1(shoulderY - H * 0.06)}`
    + ` C ${f1(cx - neckHalf * 0.9)} ${f1(shoulderY + H * 0.02)} ${f1(cx + neckHalf * 0.9)} ${f1(shoulderY + H * 0.02)} ${f1(cx + neckHalf * 1.35)} ${f1(shoulderY - H * 0.06)}`
    + ` C ${f1(cx + neckHalf * 2.0)} ${f1(shoulderY - H * 0.05)} ${f1(cx + half * 0.70)} ${f1(shoulderY - H * 0.02)} ${f1(cx + half)} ${f1(shoulderY + H * 0.10)} L ${f1(cx + half)} 240 Z"/>`
    // The same warm key across the shirt, so it belongs to the same room.
    + `<path fill="#fff" opacity="0.07" d="`
    + `M ${f1(cx - half)} 240 L ${f1(cx - half)} ${f1(shoulderY + H * 0.10)}`
    + ` C ${f1(cx - half * 0.70)} ${f1(shoulderY - H * 0.02)} ${f1(cx - neckHalf * 2.0)} ${f1(shoulderY - H * 0.05)} ${f1(cx - neckHalf * 1.35)} ${f1(shoulderY - H * 0.06)}`
    + ` L ${f1(cx - neckHalf * 1.35)} 240 Z"/>`
    // The collar: a band in the team's second colour, following the neckline.
    + `<path fill="none" stroke="${accent}" stroke-width="${f1(H * 0.030)}" stroke-linecap="round" d="`
    + `M ${f1(cx - neckHalf * 1.45)} ${f1(shoulderY - H * 0.045)}`
    + ` C ${f1(cx - neckHalf * 0.9)} ${f1(shoulderY + H * 0.045)} ${f1(cx + neckHalf * 0.9)} ${f1(shoulderY + H * 0.045)} ${f1(cx + neckHalf * 1.45)} ${f1(shoulderY - H * 0.045)}"/>`;
}
