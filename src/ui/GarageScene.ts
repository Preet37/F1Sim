import './people/people.css';
import { figureArt, crowdBand } from './people/Figure';
import { principalFor } from './people/Cast';
import { lookFor } from './people/Look';

/**
 * The garage.
 *
 * The screens that are about JOINING a team — the signing, the contract, the
 * off-season move — have never had anywhere to happen. They are lists of
 * numbers with a team name at the top, and the moment a career is supposed to
 * turn on is a table row changing colour.
 *
 * This is the place. A bay under the grandstand: the shutter up, the team's
 * colour across the back wall, a strip light along the ceiling that is the same
 * warm key as everything else, a rack of tyres, and PEOPLE — the principal
 * standing where a principal stands, with the crew working behind him.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN IT
 * ---------------------------------------------------------------------------
 *
 * THE CAR. `CarStage.ts` already mounts a lit, rotating, reflected car on its
 * own canvas, it is already used by the paddock screen, and `CAREER_MODE.md`
 * commits the livery editor to previewing on that same object. Drawing a second
 * flat car here would be a second representation of the one thing in this game
 * that already has a canonical one, and the two would drift apart within a
 * week. The bay is deliberately built with the CAR-SHAPED HOLE in the middle of
 * it, so a screen can put the real stage in front of this backdrop.
 *
 * Cost: one inline SVG, no filters, no animation. Same as the press room.
 */

const NS = 'http://www.w3.org/2000/svg';

const W = 1200;
const H = 675;
/** The floor line. Everything above is wall, below is garage floor. */
const FLOOR = 452;
/** The bench the crew work at. It is also what crops them. */
const BENCH_Y = 556;

export interface GarageSpec {
  teamId: string;
  teamName: string;
  colour: number;
  accent: number;
  /** How many crew are in the bay. Two or three reads as a garage; eight is a queue. */
  crew?: number;
  /** Stable, so the bay is the same bay each time it opens. */
  seed?: number;
  /** Draw the principal, front and left. */
  principal?: boolean;
}

function hexOf(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/**
 * The bay, as an element.
 *
 * Returns an `<svg>` a screen can size however it likes. The team name is set
 * with `textContent` rather than interpolated, for the usual reason.
 */
export function garageSvg(spec: GarageSpec): SVGSVGElement {
  const seed = spec.seed ?? 7;
  const team = hexOf(spec.colour);
  const accent = hexOf(spec.accent);
  const crewCount = Math.max(0, Math.min(4, spec.crew ?? 2));

  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'garage-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'The ' + spec.teamName + ' garage.');

  // --- The people ----------------------------------------------------------
  // Placed on the floor, back to front. The crew stand deeper in the bay and
  // are therefore SMALLER — the one cue that makes a flat drawing a room.
  let defs = '';
  let back = '';
  let front = '';

  // THE CREW HAD NO ARMS. Until #22 every one of these was `standing`, which
  // drew an upper arm and nothing below it, in the suit colour, BEHIND the
  // torso — so what `desktop-garage.png` showed was four armless torsos. They
  // are whole people now: two poses, hands, legs, boots, and the bench cropping
  // them at the shin the way a real bench does.
  const CREW_POSES = ['standing', 'walking', 'folded'] as const;
  for (let i = 0; i < crewCount; i++) {
    const uid = 'gc' + i;
    const look = lookFor(spec.teamId + ':crew:' + i, 'crew');
    const art = figureArt(look, {
      uid, suit: team, accent, team, sponsors: false,
      pose: CREW_POSES[i % CREW_POSES.length],
    });
    defs += art.defs;
    const s = 0.27 + ((i * 7) % 3) * 0.020;
    const x = 400 + i * 205 + ((i * 13) % 5) * 12;
    // Their soles land BEHIND the bench, so the bench crops them at the thigh
    // and nobody is standing in a hole. The number comes off the rig rather
    // than off a constant, because a tall person's feet are further from their
    // shoulders than a short one's — that constant is what put the old crew's
    // shoulders at the bench top with everything else out of frame.
    const sole = 500 + ((i * 5) % 3) * 9;
    const ty = sole - art.rig.floorY * s;
    back += `<ellipse cx="${x}" cy="${sole}" rx="${(74 * s).toFixed(1)}" `
      + `ry="${(12 * s).toFixed(1)}" fill="#04070b" opacity="0.5"/>`
      + `<g transform="translate(${(x - 100 * s).toFixed(1)} ${ty.toFixed(1)}) `
      + `scale(${s.toFixed(3)})" opacity="0.95">${art.markup}</g>`;
  }

  if (spec.principal !== false) {
    const p = principalFor(spec.teamId);
    const art = figureArt(p.look, {
      uid: 'gp', suit: team, accent, team, pose: 'standing', sponsors: false,
    });
    defs += art.defs;
    // Front and left, standing on the near floor in front of the bench, WHOLE:
    // this is the biggest figure in the frame, it is the one the screen is
    // about, and it used to run off the bottom edge at the waist.
    const s = 0.50;
    const ty = H - 26 - art.rig.floorY * s;
    front += `<ellipse cx="212" cy="${H - 24}" rx="${(80 * s).toFixed(1)}" `
      + `ry="${(12 * s).toFixed(1)}" fill="#04070b" opacity="0.55"/>`
      + `<g transform="translate(${(212 - 100 * s).toFixed(1)} ${ty.toFixed(1)}) `
      + `scale(${s.toFixed(3)})">${art.markup}</g>`;
  }

  svg.innerHTML = `
<defs>
  <linearGradient id="gar-wall" x1="0.2" y1="0" x2="0.9" y2="1">
    <stop offset="0%" stop-color="#1e2732"/>
    <stop offset="60%" stop-color="#121922"/>
    <stop offset="100%" stop-color="#0a0e14"/>
  </linearGradient>
  <linearGradient id="gar-floor" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#1a222c"/>
    <stop offset="100%" stop-color="#080b10"/>
  </linearGradient>
  <!-- The strip light. One warm bar and the pool it throws down the back wall:
       the entire lighting rig of a real garage, and the reason a bay reads as
       lit from above rather than as a flat colour. -->
  <linearGradient id="gar-pool" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="rgb(255,222,178)" stop-opacity="0.20"/>
    <stop offset="46%" stop-color="rgb(255,222,178)" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="rgb(255,222,178)" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gar-band" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${team}" stop-opacity="0.95"/>
    <stop offset="72%" stop-color="${team}" stop-opacity="0.72"/>
    <stop offset="100%" stop-color="${team}" stop-opacity="0.35"/>
  </linearGradient>
  ${defs}
</defs>

<rect x="0" y="0" width="${W}" height="${FLOOR}" fill="url(#gar-wall)"/>
<rect x="0" y="0" width="${W}" height="${FLOOR}" fill="url(#gar-pool)"/>

<!-- The shutter, rolled up into its housing across the top of the bay. -->
<rect x="0" y="0" width="${W}" height="74" fill="#0c1219"/>
${Array.from({ length: 9 }, (_, i) =>
    `<rect x="0" y="${8 + i * 7}" width="${W}" height="3.4" fill="#19222c"/>`).join('')}
<rect x="0" y="72" width="${W}" height="5" fill="#2b3746"/>
<rect x="0" y="77" width="${W}" height="10" fill="url(#gar-pool)"/>

<!-- The team's band across the back wall. The one large area of team colour,
     and the thing that makes this bay theirs. -->
<rect x="0" y="150" width="${W}" height="66" fill="url(#gar-band)"/>
<rect x="0" y="150" width="${W}" height="3" fill="#fff" opacity="0.16"/>
<rect x="0" y="216" width="${W}" height="3" fill="#000" opacity="0.34"/>

<!-- Panel joins down the back wall. Vertical lines at an honest spacing are
     what stop a large flat rectangle reading as a background colour. -->
<g stroke="rgba(255,255,255,0.045)" stroke-width="2">
${Array.from({ length: 8 }, (_, i) =>
    `<path d="M ${(i + 1) * 133} 86 L ${(i + 1) * 133} ${FLOOR}"/>`).join('')}
</g>

<!-- The tool wall on the right: drawers, a bench, a monitor. -->
<rect x="880" y="252" width="300" height="118" rx="3" fill="#141b24" stroke="rgba(255,255,255,0.07)"/>
${Array.from({ length: 4 }, (_, i) =>
    `<rect x="892" y="${262 + i * 28}" width="276" height="20" rx="2" fill="#1b232e"/>`
    + `<rect x="1010" y="${269 + i * 28}" width="40" height="5" rx="2.5" fill="#2c3644"/>`).join('')}
<rect x="912" y="176" width="150" height="66" rx="3" fill="#080c11" stroke="rgba(255,255,255,0.10)"/>
<rect x="920" y="184" width="134" height="50" fill="#0d151d"/>
${Array.from({ length: 5 }, (_, i) =>
    `<rect x="926" y="${192 + i * 9}" width="${40 + ((i * 37) % 80)}" height="3.4" fill="${accent}" opacity="${(0.7 - i * 0.1).toFixed(2)}"/>`).join('')}

<!-- Tyres, stacked. Four discs and a rim: unmistakable, and the only object in
     a garage that needs no explanation at all. -->
<g>
${Array.from({ length: 4 }, (_, i) =>
    `<rect x="${556 + (i % 2) * 7}" y="${FLOOR - 46 - i * 42}" width="158" height="44" rx="21" fill="#0b0f14"/>`
    + `<path d="M ${562 + (i % 2) * 7} ${FLOOR - 40 - i * 42} a 21 21 0 0 1 18 -6 h 118" `
    + `fill="none" stroke="#38424f" stroke-width="3.5" stroke-linecap="round"/>`
    + `<rect x="${596 + (i % 2) * 7}" y="${FLOOR - 34 - i * 42}" width="70" height="6" rx="3" `
    + `fill="${i % 2 === 0 ? accent : '#4a5666'}" opacity="0.9"/>`).join('')}
<ellipse cx="638" cy="${FLOOR + 2}" rx="86" ry="12" fill="#04070b" opacity="0.55"/>
</g>

<rect x="0" y="${FLOOR}" width="${W}" height="${H - FLOOR}" fill="url(#gar-floor)"/>
<rect x="0" y="${FLOOR}" width="${W}" height="2" fill="#3a4655" opacity="0.5"/>
<!-- The floor's reflection of the band. A garage floor is a gloss epoxy and it
     throws the wall back at you; without this the floor is a grey rectangle. -->
<rect x="0" y="${FLOOR + 4}" width="${W}" height="34" fill="${team}" opacity="0.10"/>

${back}
<!-- The bench. A slab with a lit top edge, the same recipe as every panel in
     the base stylesheet, and the thing the crew are cropped by. -->
<rect x="-10" y="${BENCH_Y}" width="${W + 20}" height="${H - BENCH_Y}" fill="#141b25"/>
<rect x="-10" y="${BENCH_Y}" width="${W + 20}" height="4" fill="#425064" opacity="0.7"/>
<rect x="-10" y="${BENCH_Y + 4}" width="${W + 20}" height="10" fill="#0b1016" opacity="0.55"/>
<rect x="-10" y="${BENCH_Y + 26}" width="${W + 20}" height="3" fill="${team}" opacity="0.55"/>
${front}`;

  // The bay's name, on the wall. Appended, because a team name is data.
  const label = document.createElementNS(NS, 'text');
  label.setAttribute('x', '840');
  label.setAttribute('y', '196');
  label.setAttribute('text-anchor', 'end');
  label.setAttribute('class', 'gar-name');
  label.textContent = spec.teamName.toUpperCase();
  svg.appendChild(label);

  // The pit lane beyond the bay, seen past the figures: a suggestion of people
  // outside. Cheap, and it stops the bay reading as a sealed box.
  const beyond = document.createElementNS(NS, 'g');
  beyond.setAttribute('opacity', '0.5');
  beyond.innerHTML = crowdBand({
    width: 420, baseY: H + 30, headR: 44, count: 4,
    seed: seed ^ 0x77, fill: '#04070b', rim: 'rgba(255,222,178,0.30)', depth: 0.2,
  });
  beyond.setAttribute('transform', `translate(${W - 420} 0)`);
  svg.appendChild(beyond);

  return svg;
}

/** The bay in a bordered plate, ready to drop into a page body. */
export function buildGarage(parent: HTMLElement, spec: GarageSpec): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'garage';
  wrap.appendChild(garageSvg(spec));
  parent.appendChild(wrap);
  return wrap;
}
