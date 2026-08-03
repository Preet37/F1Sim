import './people.css';
import { headArt } from './Face';
import { headGeometry } from './Face';
import { principalFor, personFor, fullName, type Person } from './Cast';
import type { PersonRole } from './Look';

/**
 * The principal, on a disc.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DROP-IN, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `Hud.principalSvg(team)` returns a 48-unit disc in the team's colour with a
 * fixed pictogram silhouette on it, and it is called from two places:
 *
 *   src/ui/Hud.ts:1674          the radio card the principal talks through
 *   src/ui/StrategyScreen.ts:55 the strategy screen's speech bubble
 *
 * `principalDiscSvg` has the same shape — a function of a team, returning an
 * `SVGSVGElement` with a `0 0 48 48` viewBox — so switching either call site is
 * changing which module the name is imported from. It needs the team's `id` as
 * well as its colour, which both call sites already have, because a portrait of
 * a specific person requires knowing which person.
 *
 * `Hud.ts` belongs to another agent in this round of work and is deliberately
 * not touched. The swap is two lines and it is written out in the report.
 */

const NS = 'http://www.w3.org/2000/svg';

function hexOf(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/** Rec. 709 relative luminance, as `Hud.ts` computes it. */
function luminanceOf(c: number): number {
  return (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
}

export interface DiscOptions {
  /** Viewport units. The disc is square. Default 48, as the HUD's is. */
  size?: number;
  uid?: string;
  /** Draw them with a headset on, whatever their record says. Pit wall only. */
  headset?: boolean;
}

let uid = 0;

/**
 * A person's head, cropped to a disc in a team colour.
 *
 * The head is scaled so it fills three-quarters of the disc's height and is
 * anchored near the top, which puts the eyes on the horizontal centre line. A
 * portrait centred on the geometric middle of a circle always looks like it is
 * sinking, because a head's visual mass is above its centre.
 */
export function personDiscSvg(
  person: Person, colour: number, opts: DiscOptions = {},
): SVGSVGElement {
  const id = opts.uid ?? 'pd' + (++uid);
  const look = opts.headset
    ? { ...person.look, headwear: 'headset' as const }
    : person.look;
  const g = headGeometry(look);
  const art = headArt(look, { uid: id, team: hexOf(colour), accent: '#0d1218' });

  const s = (48 * 0.74) / g.h;
  const tx = 24 - 100 * s;
  const ty = 48 * 0.115 - g.crownY * s;

  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('class', 'person-disc');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', fullName(person) + ', ' + person.role);
  if (opts.size) {
    svg.setAttribute('width', String(opts.size));
    svg.setAttribute('height', String(opts.size));
  }

  // The shoulders are the team's colour and the disc is a shade of it, so the
  // person reads as standing INSIDE a team-coloured field rather than as a
  // sticker on top of one.
  const dark = luminanceOf(colour) > 0.5;
  svg.innerHTML = `<defs>
  <clipPath id="${id}-disc"><circle cx="24" cy="24" r="24"/></clipPath>
  ${art.defs}
</defs>
<circle cx="24" cy="24" r="24" fill="${hexOf(colour)}"/>
<circle cx="24" cy="24" r="24" fill="${dark ? '#000' : '#fff'}" opacity="0.13"/>
<g clip-path="url(#${id}-disc)">
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})">
    ${art.back}
    <path fill="${hexOf(colour)}" d="M -60 ${g.chinY + g.h * 0.10} L 260 ${g.chinY + g.h * 0.10} L 260 700 L -60 700 Z"/>
    <path fill="rgba(0,0,0,0.30)" d="M -60 ${g.chinY + g.h * 0.34} L 260 ${g.chinY + g.h * 0.34} L 260 700 L -60 700 Z"/>
    ${art.front}
  </g>
</g>
<circle cx="24" cy="24" r="23" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/>`;
  return svg;
}

/**
 * The disc, for a team.
 *
 * Signature-compatible with `Hud.principalSvg` except that it also reads `id`.
 */
export function principalDiscSvg(
  team: { id: string; colour: number }, opts: DiscOptions = {},
): SVGSVGElement {
  return personDiscSvg(principalFor(team.id), team.colour, opts);
}

export interface PrincipalCardSpec {
  teamId: string;
  colour: number;
  /** Pixel width of the disc. */
  size?: number;
  /** Overrides "Team principal". */
  role?: string;
  headset?: boolean;
}

/**
 * Face, name, role — the unit a screen drops in when somebody is about to
 * speak. The radio card, the signing screen, the off-season report.
 */
export function principalCard(parent: HTMLElement, spec: PrincipalCardSpec): HTMLElement {
  const p = principalFor(spec.teamId);
  const size = spec.size ?? 44;

  const card = document.createElement('div');
  card.className = 'pcard';

  const face = document.createElement('div');
  face.className = 'pcard-face';
  face.style.width = size + 'px';
  face.style.height = size + 'px';
  face.appendChild(principalDiscSvg({ id: spec.teamId, colour: spec.colour }, {
    size, uid: 'pcard-' + spec.teamId, headset: spec.headset,
  }));
  card.appendChild(face);

  const text = document.createElement('div');
  text.className = 'pcard-text';
  const name = document.createElement('div');
  name.className = 'pcard-name';
  name.textContent = fullName(p);
  const role = document.createElement('div');
  role.className = 'pcard-role';
  role.textContent = spec.role ?? p.role;
  text.append(name, role);
  card.appendChild(text);

  parent.appendChild(card);
  return card;
}

/** The same card for anybody who is not a principal: a journalist, a marshal. */
export function personCard(
  parent: HTMLElement, id: string, roleKind: PersonRole, colour: number, size = 44,
): HTMLElement {
  const p = personFor(id, roleKind);
  const card = document.createElement('div');
  card.className = 'pcard';
  const face = document.createElement('div');
  face.className = 'pcard-face';
  face.style.width = size + 'px';
  face.style.height = size + 'px';
  face.appendChild(personDiscSvg(p, colour, { size, uid: 'pc-' + id }));
  card.appendChild(face);
  const text = document.createElement('div');
  text.className = 'pcard-text';
  const name = document.createElement('div');
  name.className = 'pcard-name';
  name.textContent = fullName(p);
  const role = document.createElement('div');
  role.className = 'pcard-role';
  role.textContent = p.role;
  text.append(name, role);
  card.appendChild(text);
  parent.appendChild(card);
  return card;
}
