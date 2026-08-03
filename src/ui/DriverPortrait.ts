import {
  HELMET_FAMILIES, familyOf, hex, nationOf, visorOf,
  type HelmetDesign, type HelmetFamilyId,
} from '../career/Identity';

/**
 * The driver, drawn.
 *
 * ---------------------------------------------------------------------------
 * THE ARGUMENT FOR VECTOR ART, AND FOR A HELMET
 * ---------------------------------------------------------------------------
 *
 * `src/career/Identity.ts` explains why the protagonist of this career is a
 * helmet rather than a face. This file is why it is SVG rather than a fourth
 * WebGL scene:
 *
 *   · IT HAS TO WORK AT 36 PIXELS AND AT 420. The same drawing goes beside a
 *     name in a results row and on the podium. Vector art is the only form that
 *     is correct at both without two sets of assets.
 *   · IT LIVES IN THE DOM. Every screen in this game is DOM, and a canvas or a
 *     WebGL context per portrait would mean a second layout system, a second
 *     resize path, and a context budget that browsers actually enforce.
 *   · THE RACE IS ALREADY USING THE GPU. A career screen that competes with the
 *     simulation for it is a career screen that stutters.
 *   · IT IS SIX NUMBERS. The whole design round-trips through the save as a
 *     family id, three colours and a visor tint.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN
 * ---------------------------------------------------------------------------
 *
 * A three-quarter bust: shoulders in the race suit, the collar, the head-and-
 * neck support, and the helmet above it, looking off to the left of frame. The
 * three-quarter is deliberate — a helmet drawn straight on is a symmetrical
 * blob and reads as an icon, and a bust reads as a PERSON in a way a floating
 * helmet does not.
 *
 * Everything is in one 200x240 viewBox so the geometry can be reasoned about in
 * whole numbers, and the pattern families are all clipped to the shell, which
 * is what lets eight patterns share one silhouette.
 *
 * The lighting agrees with the rest of the interface: the key is above and to
 * the left, warm, as in `styles.css` — the hall these screens hang in. The
 * shell therefore carries a soft highlight up its front-left quarter and the
 * shadow falls to the lower right.
 */

const NS = 'http://www.w3.org/2000/svg';

// ===========================================================================
// The geometry
// ===========================================================================

/**
 * The shell.
 *
 * The first version of this was a closed egg and it read as a ball with
 * sunglasses on. What makes a shape a racing helmet rather than a head is the
 * CHIN BAR and the NOTCH above it: the bar juts forward and down at the front,
 * the brow overhangs, and between the two the outline steps back for the visor
 * aperture. Take the notch out and no amount of paint on it helps.
 *
 * Traced clockwise from the crown: over the top, down the back, under the jaw,
 * forward along the underside of the chin bar to its tip — the leftmost point
 * of the whole drawing — up the bar's front face, back at the notch, then up
 * the brow and home.
 */
const SHELL = 'M 98 15 C 142 15 176 47 179 90 C 182 122 168 143 140 150 '
  + 'C 122 154 102 153 88 149 C 62 142 38 132 26 118 '
  + 'C 19 110 18 100 24 93 C 29 86 35 83 43 81 '
  + 'C 37 74 34 64 36 55 C 43 33 64 17 98 15 Z';

/**
 * The aperture the visor sits in.
 *
 * Wide, and running almost to the front edge of the shell, because on a real
 * helmet the opening is most of the front. A small oval in the middle of the
 * face is a diving mask.
 */
const APERTURE = 'M 27 60 C 38 45 74 37 112 41 C 130 43 138 50 137 61 '
  + 'C 136 77 126 87 106 91 C 76 97 42 88 29 76 C 24 71 24 65 27 60 Z';

/**
 * The line where the chin bar meets the shell.
 *
 * One stroke, and it does more for the read than any of the paint: it is the
 * seam a full-face helmet has and the thing that stops the lower front being
 * an undifferentiated cheek.
 */
const BAR_SEAM = 'M 30 88 C 40 108 62 124 92 132';

/** The mouth vent, across the front of the chin bar. */
const CHIN_VENT = 'M 36 101 C 47 97 64 98 76 103 C 80 105 80 110 75 111 '
  + 'C 62 114 45 111 37 107 C 33 105 33 102 36 101 Z';

/** The rear aero spoiler every modern helmet carries. */
const SPOILER = 'M 154 124 C 168 125 178 131 181 140 C 172 141 159 139 148 134 Z';

/** The brow ridge, over the aperture. */
const BROW = 'M 33 58 C 45 44 76 37 110 41 C 126 43 133 48 133 56';

/** The crown vents. */
const CROWN_VENT = 'M 84 22 C 98 18 114 19 126 25 C 118 30 98 31 86 27 Z';

/**
 * The bust: shoulders, collar and the head-and-neck support.
 *
 * The first version was a semicircle, which is the silhouette of the generic
 * "user account" glyph and therefore the one shape this drawing must not be.
 * Real shoulders have a trapezius that rises to the neck, a deltoid that turns
 * over at the top of the arm, and sides that are nearly vertical — and they run
 * OUT of the frame. A bust that ends inside the picture reads as a bust; a bust
 * cropped by the frame reads as somebody standing there.
 */
const SHOULDERS = 'M -22 250 L -22 202 C -4 184 22 173 54 167 '
  + 'C 70 164 80 161 87 155 L 115 155 C 122 161 132 164 148 167 '
  + 'C 180 173 204 184 222 202 L 222 250 Z';
/**
 * The neck, drawn behind everything.
 *
 * Its absence was the fault in the first bust: the jaw ended, the shoulders
 * began, and the hall showed through the gap, so the helmet floated above a
 * mound. A head has to be attached to something.
 */
const NECK = 'M 78 120 L 122 120 L 126 170 L 74 170 Z';
/** The head-and-neck support, over the shoulders and under the helmet. */
const HANS = 'M 64 172 C 66 150 79 141 100 141 C 121 141 134 150 136 172 '
  + 'C 117 178 83 178 64 172 Z';
/** The suit collar, zipped high, as a driver's is. */
const COLLAR = 'M 76 158 C 83 147 117 147 124 158 C 115 167 85 167 76 158 Z';

// ===========================================================================
// The pattern families
// ===========================================================================

/**
 * Each family, as the paint that goes on the shell.
 *
 * All of them are clipped to the shell outline, which is why every one can be
 * drawn as a simple stroke or wedge and still come out following the curve of
 * the helmet. `stripe` is the player's second colour and `trim` their third.
 */
function patternFor(family: HelmetFamilyId, stripe: string, trim: string): string {
  switch (family) {
    case 'centreline':
      // Brow, over the crown, down the back. Two strokes, the trim wider
      // beneath, which is how a real centre stripe is lined.
      return `<path d="M 28 78 C 44 22 132 4 182 82" fill="none" stroke="${trim}" stroke-width="36"/>`
        + `<path d="M 28 78 C 44 22 132 4 182 82" fill="none" stroke="${stripe}" stroke-width="27"/>`;

    case 'quarters':
      // A diagonal split. The lower-front quarter takes the second colour, so
      // the chin bar is the loud part and the crown stays quiet.
      return `<path d="M -10 250 L -10 100 C 60 126 142 134 210 112 L 210 250 Z" fill="${stripe}"/>`
        + `<path d="M -10 100 C 60 126 142 134 210 112" fill="none" stroke="${trim}" stroke-width="5"/>`;

    case 'chevron': {
      // Arrowheads over the temple, pointing forward. Three, tightening as
      // they go back, which is what gives them their sense of speed.
      let out = '';
      for (const [i, x] of [162, 138, 114].entries()) {
        out += `<path d="M ${x} 26 L ${x - 36} 62 L ${x} 98" fill="none" stroke="${
          i === 1 ? trim : stripe}" stroke-width="13" stroke-linecap="square"/>`;
      }
      return out;
    }

    case 'halo':
      // A band around the shell, riding on the brow.
      return `<path d="M 24 60 C 58 26 132 22 184 72" fill="none" stroke="${stripe}" stroke-width="26"/>`
        + `<path d="M 22 45 C 56 11 134 7 186 57" fill="none" stroke="${trim}" stroke-width="5"/>`;

    case 'blade':
      // A wedge swept back from the visor, thickening as it goes.
      return `<path d="M 30 92 C 92 88 152 104 188 134 L 188 96 C 148 68 84 58 32 70 Z" fill="${stripe}"/>`
        + `<path d="M 32 70 C 84 58 148 68 188 96" fill="none" stroke="${trim}" stroke-width="4"/>`;

    case 'starburst': {
      // Rays off a point at the crown. Six, unevenly spread — an even fan
      // reads as a pie chart.
      let out = '';
      const cx = 100, cy = 26;
      for (const a of [92, 118, 144, 168, 194, 226]) {
        const r = (a * Math.PI) / 180;
        const x = cx + Math.cos(r) * 220, y = cy + Math.sin(r) * 220;
        out += `<path d="M ${cx} ${cy} L ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" `
          + `stroke="${stripe}" stroke-width="16"/>`;
      }
      out += `<circle cx="${cx}" cy="${cy}" r="14" fill="${trim}"/>`;
      return out;
    }

    case 'bands': {
      // Three stripes low on the shell, following the jaw.
      let out = '';
      for (const [i, y] of [0, 13, 26].entries()) {
        out += `<path d="M 22 ${96 + y} C 70 ${124 + y} 144 ${130 + y} 190 ${106 + y}" `
          + `fill="none" stroke="${i === 1 ? trim : stripe}" stroke-width="9"/>`;
      }
      return out;
    }

    case 'plain':
    default:
      return '';
  }
}

// ===========================================================================
// The drawing
// ===========================================================================

export interface PortraitOptions {
  /** Race suit colour. The team's, so a driver is visibly ON a team. */
  suit?: number;
  /** Collar and chest flash. */
  accent?: number;
  /** Drawn on the chest patch when present. */
  number?: number;
  /** Helmet only, with no bust under it. For a row, a chip, a small slot. */
  bust?: boolean;
  /** Pixel size of the square the drawing fills. */
  size?: number;
  /** A distinct gradient id per instance; several portraits share a page. */
  uid?: string;
}

let uidCounter = 0;

/**
 * A driver, as an SVG element ready to be appended.
 *
 * Returns an element rather than markup because none of the values that reach
 * it are trusted — a helmet colour comes out of a save file and a save file can
 * be hand-edited — and the numbers are written into attributes rather than
 * interpolated into a document.
 */
export function driverPortraitSvg(
  helmet: HelmetDesign, opts: PortraitOptions = {},
): SVGSVGElement {
  const bust = opts.bust !== false;
  const uid = opts.uid ?? 'dp' + (++uidCounter);
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', bust ? '0 24 200 216' : '12 6 178 152');
  svg.setAttribute('class', 'portrait' + (bust ? '' : ' portrait-helmet'));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    familyOf(helmet.family).name + ' helmet, ' + visorOf(helmet.visor).name + ' visor');
  if (opts.size) {
    svg.setAttribute('width', String(opts.size));
    svg.setAttribute('height', String(Math.round(opts.size * (bust ? 1.08 : 0.92))));
  }

  const base = hex(helmet.base);
  const stripe = hex(helmet.stripe);
  const trim = hex(helmet.trim);
  const visor = visorOf(helmet.visor);
  const suit = hex(opts.suit ?? 0x1d252f);
  const accent = hex(opts.accent ?? helmet.stripe);

  svg.innerHTML = `
<defs>
  <clipPath id="${uid}-shell"><path d="${SHELL}"/></clipPath>
  <clipPath id="${uid}-visor"><path d="${APERTURE}"/></clipPath>
  <clipPath id="${uid}-shoulders"><path d="${SHOULDERS}"/></clipPath>
  <!-- The key light: warm, above and to the left, exactly as the hall these
       screens hang in is lit. A LINEAR gradient, not a radial: a radial
       centred on the shell is what makes a drawn object read as a sphere, and
       the first version of this looked like a billiard ball. -->
  <linearGradient id="${uid}-key" x1="0.12" y1="0" x2="0.9" y2="1">
    <stop offset="0%" stop-color="#fff" stop-opacity="0.26"/>
    <stop offset="38%" stop-color="#fff" stop-opacity="0.05"/>
    <stop offset="72%" stop-color="#000" stop-opacity="0.16"/>
    <stop offset="100%" stop-color="#000" stop-opacity="0.42"/>
  </linearGradient>
  <linearGradient id="${uid}-suit" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0%" stop-color="#fff" stop-opacity="0.14"/>
    <stop offset="100%" stop-color="#000" stop-opacity="0.38"/>
  </linearGradient>
  <linearGradient id="${uid}-sheen" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${visor.sheen}"/>
    <stop offset="52%" stop-color="${visor.sheen}" stop-opacity="0"/>
  </linearGradient>
</defs>
${bust ? `
<g class="portrait-bust">
  <path d="${NECK}" fill="#0d1319"/>
  <path d="${SHOULDERS}" fill="${suit}"/>
  <path d="${SHOULDERS}" fill="url(#${uid}-suit)"/>
  <!-- The team's flash across the shoulder seam. -->
  <path d="M 52 168 C 70 165 80 162 87 156 L 115 156 C 122 162 132 165 150 168"
        fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>
  <!-- The helmet's own shadow, cast down over the shoulders and clipped to
       them. Without it the head is pasted on rather than sitting there; free,
       it reads as a floating disc, which is what the first version did. -->
  <g clip-path="url(#${uid}-shoulders)">
    <ellipse cx="100" cy="140" rx="62" ry="34" fill="rgba(6,8,11,0.5)"/>
  </g>
  <path d="${HANS}" fill="#0b0f14"/>
  <path d="${COLLAR}" fill="#1a222c"/>
</g>` : ''}
<!-- In a bust the head is set down INTO the shoulders and a touch smaller. Sat
     at full size on top of them it reads as a mascot: a big head balanced on a
     body. Scaled about its own centre, so the geometry above stays in whole
     numbers and only this one transform knows about the framing. -->
<g class="portrait-head"${bust ? ' transform="translate(11 21) scale(0.89)"' : ''}>
  <path d="${SHELL}" fill="${base}"/>
  <g clip-path="url(#${uid}-shell)">${patternFor(helmet.family, stripe, trim)}</g>
  <!-- The aperture: a ring of trim, then the visor itself, then one streak of
       specular across it. A visor with no highlight on it reads as a hole. -->
  <path d="${APERTURE}" fill="${trim}" transform="translate(-3 -3) scale(1.031)"/>
  <path d="${APERTURE}" fill="${visor.fill}"/>
  <g clip-path="url(#${uid}-visor)">
    <path d="M 24 96 L 88 36 L 116 36 L 52 104 Z" fill="url(#${uid}-sheen)"/>
  </g>
  <path d="${BROW}" fill="none" stroke="rgba(6,8,11,0.30)" stroke-width="4"/>
  <path d="${BAR_SEAM}" fill="none" stroke="rgba(6,8,11,0.34)" stroke-width="3"/>
  <path d="${CHIN_VENT}" fill="#0b0f14" opacity="0.86"/>
  <path d="${CROWN_VENT}" fill="#0b0f14" opacity="0.42"/>
  <path d="${SPOILER}" fill="${trim}"/>
  <path d="${SHELL}" fill="url(#${uid}-key)"/>
  <path d="${SHELL}" fill="none" stroke="rgba(6,8,11,0.6)" stroke-width="2"/>
</g>`;

  // The chest patch. Appended rather than interpolated so a race number from a
  // save is never markup.
  if (bust && opts.number !== undefined) {
    const g = document.createElementNS(NS, 'g');
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', '20'); plate.setAttribute('y', '198');
    plate.setAttribute('width', '44'); plate.setAttribute('height', '30');
    plate.setAttribute('rx', '4');
    plate.setAttribute('fill', 'rgba(6,8,11,0.55)');
    g.appendChild(plate);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '42'); t.setAttribute('y', '221');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'portrait-number');
    t.textContent = String(opts.number);
    g.appendChild(t);
    svg.appendChild(g);
  }

  return svg;
}

/**
 * The nationality plate: a three-letter code over the flag's two colours.
 *
 * NOT A DRAWING OF THE FLAG. Half the flags on a Formula 1 grid have a canton,
 * a cross or a coat of arms in them, and an approximated flag is worse than no
 * flag — it is visibly the wrong flag. What a timing board actually shows is
 * three letters, so that is what this shows, standing on the country's own two
 * colours so it is identifiable at a glance as well as readable.
 */
export function nationPlateSvg(nationality: string): SVGSVGElement {
  const n = nationOf(nationality);
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 48 32');
  svg.setAttribute('class', 'natplate');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', n.name);

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '48'); bg.setAttribute('height', '32');
  bg.setAttribute('rx', '3');
  bg.setAttribute('fill', hex(n.colours[0]));
  svg.appendChild(bg);

  const band = document.createElementNS(NS, 'rect');
  band.setAttribute('x', '0'); band.setAttribute('y', '24');
  band.setAttribute('width', '48'); band.setAttribute('height', '8');
  band.setAttribute('fill', hex(n.colours[1]));
  svg.appendChild(band);

  const shade = document.createElementNS(NS, 'rect');
  shade.setAttribute('x', '0'); shade.setAttribute('y', '0');
  shade.setAttribute('width', '48'); shade.setAttribute('height', '24');
  shade.setAttribute('fill', 'rgba(6,8,11,0.42)');
  svg.appendChild(shade);

  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', '24'); t.setAttribute('y', '18');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('class', 'natplate-code');
  t.textContent = n.code;
  svg.appendChild(t);
  return svg;
}

/** Every family, at chip size, for the designer to pick from. */
export function helmetSwatches(): { id: HelmetFamilyId; name: string; note: string }[] {
  return HELMET_FAMILIES.map((f) => ({ id: f.id, name: f.name, note: f.note }));
}

// ===========================================================================
// The card
// ===========================================================================

export interface DriverCardSpec {
  helmet: HelmetDesign;
  firstName: string;
  lastName: string;
  code: string;
  nationality: string;
  raceNumber: number;
  /** Team name and colours, for the suit and the strip under the name. */
  teamName: string;
  colour: number;
  accent: number;
  /** One line under the team. The championship, the round, the contract. */
  note?: string;
}

/**
 * The player, as a card.
 *
 * The unit that carries a person from screen to screen: the hub, the podium,
 * the winner's panel on a results board. Deliberately the same three registers
 * as the rest of the interface — the surname heavy and wide, the code and the
 * number in the figure face, the team in prose — so a driver reads as one more
 * thing on a timing monitor rather than as an avatar bolted onto it.
 */
export function driverCard(parent: HTMLElement, spec: DriverCardSpec): HTMLElement {
  const card = document.createElement('div');
  card.className = 'dcard';
  card.style.setProperty('--team', hex(spec.colour));
  card.style.setProperty('--me', hex(spec.helmet.base));

  const art = document.createElement('div');
  art.className = 'dcard-art';
  art.appendChild(driverPortraitSvg(spec.helmet, {
    suit: spec.colour, accent: spec.accent, uid: 'card-' + spec.code,
  }));
  card.appendChild(art);

  const text = document.createElement('div');
  text.className = 'dcard-text';
  const code = document.createElement('div');
  code.className = 'dcard-code';
  code.textContent = spec.code;
  text.appendChild(code);

  const name = document.createElement('div');
  name.className = 'dcard-name';
  const given = document.createElement('i');
  given.textContent = spec.firstName;
  const family = document.createElement('b');
  family.textContent = spec.lastName.toUpperCase();
  name.append(given, family);
  text.appendChild(name);

  const foot = document.createElement('div');
  foot.className = 'dcard-foot';
  foot.appendChild(nationPlateSvg(spec.nationality));
  const team = document.createElement('span');
  team.className = 'dcard-team';
  team.textContent = spec.teamName;
  foot.appendChild(team);
  const num = document.createElement('span');
  num.className = 'dcard-num';
  num.textContent = String(spec.raceNumber);
  foot.appendChild(num);
  text.appendChild(foot);

  if (spec.note) {
    const note = document.createElement('div');
    note.className = 'dcard-note';
    note.textContent = spec.note;
    text.appendChild(note);
  }

  card.appendChild(text);
  parent.appendChild(card);
  return card;
}
