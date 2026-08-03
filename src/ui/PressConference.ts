import './people/people.css';
import { figureArt } from './people/Figure';
import { crowdBand } from './people/Figure';
import { faceSvg } from './people/Face';
import { lookFor, type PersonLook } from './people/Look';
import { journalistsFor, personFor, type Journalist } from './people/Cast';
import { driverPortraitSvg } from './DriverPortrait';
import { hex, helmetForDriver, type HelmetDesign } from '../career/Identity';

/**
 * The press conference.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PLAYER ASKED FOR
 * ---------------------------------------------------------------------------
 *
 * "renders of the players at the game like for press conferencing and all of
 *  that." It is the headline request of the whole people brief, and
 *  `docs/CAREER_MODE.md` independently calls it "the signature screen and the
 *  only one that gets the lit stage outside a results moment: a face, a
 *  question, and three answers whose consequences are stated plainly."
 *
 * This file is the room. The career system owns the questions, the answers and
 * what they cost; it hands them in through `PressConferenceSpec` and gets a
 * callback per answer. Nothing in here knows what morale is.
 *
 * ---------------------------------------------------------------------------
 * THE COMPOSITION, AND WHY IT IS A PHOTOGRAPH RATHER THAN A ROW OF PORTRAITS
 * ---------------------------------------------------------------------------
 *
 * Three layers in depth, and the whole thing lives or dies on the third:
 *
 *   1. THE BACKDROP. A step-and-repeat board. This is the single most
 *      recognisable object in the sport's media architecture — the wall of
 *      repeated marks behind every driver who has ever answered a question — and
 *      it is free, because it is TYPE. It carries the championship's own name
 *      and the round, set in the display face the rest of the interface uses.
 *      No real sponsor artwork anywhere, which `CAREER_MODE.md` calls out as
 *      precisely the layer to leave off.
 *   2. THE PANEL. Two to four people behind a desk, hands on it, a microphone
 *      each, a name plate each, and — the detail that ties this screen to the
 *      rest of the career — THEIR OWN HELMET sitting on the desk beside them,
 *      drawn by `DriverPortrait.ts` from the same six numbers the player chose
 *      on the create screen. It is the one object that says the person in the
 *      middle of this room is you.
 *   3. THE FOREGROUND. The backs of journalists' heads, cropped by the bottom
 *      edge, black, with one rim of the key light. Cost: about forty path nodes
 *      for the whole row. Take it away and this is three portraits on a
 *      wallpaper; leave it in and the viewer is sitting in the fourth row.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 *
 * One inline SVG, no filters, no animation, no WebGL context, nothing on a
 * timer. It is DOM, it is painted once, and it cannot run during a session
 * because a session does not open it. Measured numbers are in the report.
 */

// ===========================================================================
// The contract with the career system
// ===========================================================================

export interface PressPanelist {
  /** Driver id, or whatever the career calls the player. */
  id: string;
  firstName: string;
  lastName: string;
  /** Three-letter code, for the name plate. */
  code?: string;
  teamName: string;
  colour: number;
  accent: number;
  isPlayer?: boolean;
  raceNumber?: number;
  /**
   * The player's designed helmet. Omitted for the AI, which derives one from
   * its id exactly as the podium already does.
   */
  helmet?: HelmetDesign;
  /** Overrides the generated face. Almost never needed. */
  look?: PersonLook;
}

export type AnswerTone = 'warm' | 'cool' | 'sharp' | 'hot';

export interface PressEffect {
  /** "Chassis morale", "Fan rating", "Rivalry with Norris". */
  label: string;
  /** Rendered as +8 / -6, coloured. Omit for an effect with no number. */
  value?: number;
}

export interface PressAnswer {
  id: string;
  text: string;
  /**
   * The colour of the rail down the leading edge.
   *
   * It is the interface's existing signal vocabulary and it means what it means
   * everywhere else: green is the generous answer, white the neutral one,
   * yellow the pointed one, red the one that burns something down.
   */
  tone?: AnswerTone;
  /** Stated plainly. Not a hover, not a tooltip. */
  effects?: readonly PressEffect[];
  /** Greyed, with the reason, for an answer this career cannot give. */
  unavailable?: string;
}

export interface PressQuestion {
  id: string;
  text: string;
  /** Who asked. Generated from the round's seed when omitted. */
  askedBy?: { name: string; outlet: string; look?: PersonLook };
  answers: readonly PressAnswer[];
}

export interface PressConferenceSpec {
  circuitName: string;
  tierName: string;
  /** Printed across the backdrop. Defaults to the tier. */
  seriesName?: string;
  /** "Round 4", "Post-race". Printed on the desk. */
  round?: string;
  /** Two to four. More than four and nobody's face is bigger than a stamp. */
  panel: readonly PressPanelist[];
  /** Anything at all, so the room is the same room every time it is opened. */
  seed?: number;
  questions: readonly PressQuestion[];
  /** Called as each answer is taken. The career applies the consequences. */
  onAnswer?(question: PressQuestion, answer: PressAnswer, index: number): void;
  /** Called after the last question is answered. */
  onDone?(): void;
}

export interface PressConferenceHandle {
  el: HTMLElement;
  /** Advances without an answer. Returns false when there is nothing left. */
  next(): boolean;
  destroy(): void;
}

// ===========================================================================
// The room
// ===========================================================================

const NS = 'http://www.w3.org/2000/svg';

/** The stage is 21:9, because a press conference is a wide shot. */
const W = 1260;
const H = 540;
/** The top of the desk. Everything above it is people; below it is furniture. */
const DESK_Y = 368;

/**
 * How big each person is drawn, by how many of them there are.
 *
 * A fixed scale gives four people who overlap or two people marooned at the
 * edges of the frame. The rule is the one a camera operator uses: fill the
 * frame with the panel, whatever the panel is.
 */
function panelScale(n: number): number {
  if (n <= 1) return 1.30;
  if (n === 2) return 1.12;
  if (n === 3) return 0.96;
  return 0.82;
}

/**
 * The backdrop.
 *
 * A step-and-repeat board: the same wordmark, in rows, each row offset by half
 * a step, low contrast, with the light falling off toward the edges of the
 * frame. It is the sport's own media wallpaper and it costs one text element per
 * repeat.
 *
 * The text is appended as elements rather than interpolated, because the series
 * name and the round come from a career and a career comes from a save file.
 */
function backdrop(host: SVGElement, series: string, round: string): void {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('clip-path', 'url(#pc-wall)');
  // The step has to clear the mark, and the mark is a string nobody here has
  // measured. Estimating from its length is exact enough and costs no layout:
  // the alternative is a hidden measuring pass per open.
  const stepX = Math.max(190, series.length * 10.5 + 110);
  const stepY = 46;
  for (let row = 0; row * stepY < DESK_Y + 40; row++) {
    const y = 34 + row * stepY;
    const offset = (row % 2) * (stepX / 2) - stepX * 0.35;
    for (let col = -1; col * stepX + offset < W + stepX; col++) {
      const x = col * stepX + offset;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(y));
      t.setAttribute('class', 'pc-wall-mark');
      t.textContent = series;
      g.appendChild(t);
      // The chevron between repeats: the game's own device, not a logo.
      const c = document.createElementNS(NS, 'path');
      c.setAttribute('d', `M ${x - 20} ${y - 9} l 7 4.5 l -7 4.5`);
      c.setAttribute('class', 'pc-wall-tick');
      g.appendChild(c);
    }
  }
  host.appendChild(g);

  if (round) {
    const r = document.createElementNS(NS, 'text');
    r.setAttribute('x', String(W - 26));
    r.setAttribute('y', '46');
    r.setAttribute('text-anchor', 'end');
    r.setAttribute('class', 'pc-round');
    r.textContent = round;
    host.appendChild(r);
  }
}

/** One microphone: a stalk off the desk and a capsule on the end of it. */
function microphone(x: number, lean: number): string {
  const top = DESK_Y - 66;
  const hx = x + lean * 26;
  return `<ellipse cx="${x}" cy="${DESK_Y - 1}" rx="15" ry="4" fill="#0d1218"/>`
    + `<g stroke="#0f141b" fill="none" stroke-width="6" stroke-linecap="round">`
    + `<path d="M ${x} ${DESK_Y - 4} C ${x + lean * 2} ${DESK_Y - 34} ${hx - lean * 2} ${top + 26} ${hx} ${top + 8}"/></g>`
    + `<g stroke="#9aa7b6" stroke-opacity="0.45" fill="none" stroke-width="1.6" stroke-linecap="round">`
    + `<path d="M ${x - 1.6} ${DESK_Y - 6} C ${x + lean * 2} ${DESK_Y - 34} ${hx - lean * 2} ${top + 26} ${hx - 1.6} ${top + 10}"/></g>`
    + `<ellipse cx="${hx}" cy="${top}" rx="10" ry="14" fill="#12171f" `
    + `stroke="#8f9bab" stroke-opacity="0.5" stroke-width="2" `
    + `transform="rotate(${lean * 18} ${hx} ${top})"/>`
    + `<ellipse cx="${hx - 3}" cy="${top - 4}" rx="3.6" ry="5.4" fill="#cfd8e4" opacity="0.3"/>`;
}

/**
 * Builds the stage.
 *
 * Returns the `<svg>`; the caller decides what box it lives in. It is fully
 * self-contained so that a screen that only wants the picture — a results
 * banner, a career-hub teaser — can use it without any of the question
 * machinery below.
 */
export function pressRoomSvg(spec: PressConferenceSpec): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pc-room');
  svg.setAttribute('role', 'img');
  const panel = spec.panel.slice(0, 4);
  svg.setAttribute('aria-label',
    'Press conference at ' + spec.circuitName + ', '
    + panel.map((p) => p.firstName + ' ' + p.lastName).join(', ') + ' on the panel.');

  const seed = spec.seed ?? 1;
  const s = panelScale(panel.length);
  // Everyone's hands land on the desk, whatever their scale, because the desk
  // is a real object and they are all sitting at it.
  const deskContact = 205 + 124 * 0.62;
  const ty = DESK_Y - deskContact * s;

  let defs = '';
  let people = '';
  const slots: number[] = [];

  for (const [i, p] of panel.entries()) {
    const cx = W * ((i + 0.5) / panel.length);
    slots.push(cx);
    const uid = 'pc' + i;
    const look = p.look ?? lookFor(p.id, 'driver');
    const art = figureArt(look, {
      uid,
      suit: hex(p.colour),
      accent: hex(p.accent),
      team: hex(p.colour),
      pose: 'seated',
      number: p.raceNumber,
    });
    defs += art.defs;
    // Each person is one transform. The 100 is the centre of the figure box.
    people += `<g transform="translate(${(cx - 100 * s).toFixed(1)} ${ty.toFixed(1)}) `
      + `scale(${s.toFixed(3)})">${art.markup}</g>`;
  }

  svg.innerHTML = `
<defs>
  <clipPath id="pc-wall"><rect x="0" y="0" width="${W}" height="${DESK_Y}"/></clipPath>
  <!-- The room's own light: warm, above and left, exactly as everywhere else,
       falling off into the corners. It is what stops a flat board reading as a
       sheet of paper. -->
  <radialGradient id="pc-pool" cx="0.34" cy="0.10" r="0.95">
    <stop offset="0%" stop-color="#2a3442"/>
    <stop offset="52%" stop-color="#151c25"/>
    <stop offset="100%" stop-color="#080b10"/>
  </radialGradient>
  <linearGradient id="pc-desk" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#33404f"/>
    <stop offset="10%" stop-color="#25303c"/>
    <stop offset="100%" stop-color="#18212b"/>
  </linearGradient>
  <linearGradient id="pc-fg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#05070a" stop-opacity="0.7"/>
    <stop offset="100%" stop-color="#05070a"/>
  </linearGradient>
  ${defs}
</defs>
<rect x="0" y="0" width="${W}" height="${H}" fill="url(#pc-pool)"/>`;

  backdrop(svg, spec.seriesName || spec.tierName, spec.round ?? '');

  // The panel, then the desk over the front of it, then the foreground.
  const rest = document.createElementNS(NS, 'g');
  rest.innerHTML = people
    // The desk. A slab with a lit top edge and a dark face, which is the whole
    // recipe every panel in `styles.css` already uses.
    + `<rect x="-20" y="${DESK_Y}" width="${W + 40}" height="${H - DESK_Y}" fill="url(#pc-desk)"/>`
    + `<rect x="-20" y="${DESK_Y}" width="${W + 40}" height="2.5" fill="#5d6b7d" opacity="0.55"/>`
    + slots.map((x, i) => microphone(x - 14, i % 2 === 0 ? 1 : -1)).join('');
  svg.appendChild(rest);

  // The name plates and the helmets: appended, because a name is a string from
  // a save and a helmet is three colours from one.
  for (const [i, p] of panel.entries()) {
    const cx = slots[i];
    const plate = document.createElementNS(NS, 'g');
    plate.setAttribute('transform', `translate(${(cx - 96).toFixed(1)} ${DESK_Y + 20})`);
    const bg = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({
      x: '0', y: '0', width: '192', height: '46', rx: '2',
      fill: '#0c1117', stroke: hex(p.colour), 'stroke-opacity': '0.85', 'stroke-width': '2',
    })) bg.setAttribute(k, v);
    plate.appendChild(bg);
    const bar = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({
      x: '0', y: '0', width: '6', height: '46', fill: hex(p.colour),
    })) bar.setAttribute(k, v);
    plate.appendChild(bar);

    const name = document.createElementNS(NS, 'text');
    name.setAttribute('x', '16');
    name.setAttribute('y', '25');
    name.setAttribute('class', 'pc-plate-name');
    name.textContent = p.lastName.toUpperCase();
    plate.appendChild(name);

    const team = document.createElementNS(NS, 'text');
    team.setAttribute('x', '16');
    team.setAttribute('y', '39');
    team.setAttribute('class', 'pc-plate-team');
    team.textContent = p.teamName;
    plate.appendChild(team);
    svg.appendChild(plate);

    // The helmet on the desk. THE detail: it is the object the player designed,
    // drawn by the same code that drew it on the create screen, sitting in front
    // of them in a room full of cameras.
    const helmet = driverPortraitSvg(p.helmet ?? helmetForDriver(p.id), {
      bust: false, uid: 'pch' + i,
    });
    helmet.setAttribute('x', String(cx + 104));
    helmet.setAttribute('y', String(DESK_Y - 62));
    helmet.setAttribute('width', '86');
    helmet.setAttribute('height', '74');
    svg.appendChild(helmet);
  }

  // The foreground. Last, over everything, cropped by the frame.
  const fg = document.createElementNS(NS, 'g');
  fg.innerHTML =
    // Two cameras held up in the row. Hard-edged black boxes: the one shape that
    // says "press" without a single logo on it. Drawn FIRST, so the heads in
    // front of them overlap — which is what puts them in the row rather than on
    // a shelf.
    `<g fill="#05070a">`
    + `<rect x="-8" y="${H - 104}" width="94" height="58" rx="5"/>`
    + `<rect x="70" y="${H - 92}" width="36" height="32" rx="16"/>`
    + `<rect x="24" y="${H - 48}" width="26" height="60"/>`
    + `<rect x="1176" y="${H - 92}" width="86" height="52" rx="5"/>`
    + `<rect x="1170" y="${H - 84}" width="30" height="28" rx="14"/>`
    + `<rect x="1206" y="${H - 42}" width="22" height="54"/>`
    + `</g>`
    // One rim of the key along the top of each body, so they are objects in
    // this room rather than holes cut out of it.
    + `<g fill="none" stroke="rgba(255,222,178,0.42)" stroke-width="2.5">`
    + `<path d="M -8 ${H - 104} h 94"/><path d="M 1176 ${H - 92} h 86"/></g>`
    + crowdBand({
      width: W + 160, baseY: H + 12, headR: 56, count: 7,
      seed: seed ^ 0x51ed, fill: '#03050a', rim: 'rgba(255, 222, 178, 0.55)', depth: 0.26,
    });
  svg.appendChild(fg);
  return svg;
}

// ===========================================================================
// The screen
// ===========================================================================

/**
 * The whole thing: the room, a question, and the answers.
 *
 * One question at a time. A press conference that put all three on the screen
 * would be a form, and the reason this is the signature screen is that it is a
 * conversation — you say a thing, it lands, somebody else asks the next one.
 */
export function buildPressConference(
  parent: HTMLElement, spec: PressConferenceSpec,
): PressConferenceHandle {
  const root = document.createElement('div');
  root.className = 'presser';
  parent.appendChild(root);

  const room = document.createElement('div');
  room.className = 'presser-room';
  room.appendChild(pressRoomSvg(spec));
  root.appendChild(room);

  const step = document.createElement('div');
  step.className = 'presser-step';
  root.appendChild(step);

  const ask = document.createElement('div');
  ask.className = 'presser-ask';
  root.appendChild(ask);

  const answers = document.createElement('div');
  answers.className = 'presser-answers';
  root.appendChild(answers);

  const room3 = journalistsFor(String(spec.seed ?? 1) + spec.circuitName, spec.questions.length);
  let index = 0;

  function render(): void {
    const q = spec.questions[index];
    ask.replaceChildren();
    answers.replaceChildren();
    if (!q) {
      step.textContent = 'Media session complete';
      const done = document.createElement('div');
      done.className = 'presser-picked';
      done.textContent = 'That is the room done with you. '
        + 'What was said here reaches the factory before you do.';
      answers.appendChild(done);
      return;
    }

    step.textContent = `Question ${index + 1} of ${spec.questions.length} · `
      + `${spec.circuitName} · ${spec.tierName}`;

    // Who is asking. A named journalist when the career supplied one, otherwise
    // one of this round's own room — the same person every time it is opened.
    const j: { name: string; outlet: string; look: PersonLook } = q.askedBy
      ? {
        name: q.askedBy.name,
        outlet: q.askedBy.outlet,
        look: q.askedBy.look ?? lookFor(q.askedBy.name, 'journalist'),
      }
      : askerFrom(room3[index] ?? room3[0]);

    const facewrap = document.createElement('div');
    facewrap.className = 'presser-ask-face';
    facewrap.appendChild(faceSvg(j.look, { crop: 'bust', uid: 'ask' + index, size: 46 }));
    ask.appendChild(facewrap);

    const body = document.createElement('div');
    body.className = 'presser-ask-body';
    const who = document.createElement('div');
    who.className = 'presser-ask-who';
    const b = document.createElement('b');
    b.textContent = j.name;
    who.append(b, document.createTextNode(' · ' + j.outlet));
    body.appendChild(who);
    const text = document.createElement('div');
    text.className = 'presser-q';
    text.textContent = q.text;
    body.appendChild(text);
    ask.appendChild(body);

    for (const a of q.answers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'presser-answer tone-' + (a.tone ?? 'cool');
      const line = document.createElement('div');
      line.textContent = a.text;
      btn.appendChild(line);

      if (a.effects && a.effects.length > 0) {
        const cost = document.createElement('div');
        cost.className = 'presser-cost';
        for (const e of a.effects) {
          const chip = document.createElement('span');
          if (e.value !== undefined) {
            chip.className = e.value >= 0 ? 'up' : 'down';
            chip.textContent = (e.value >= 0 ? '+' : '') + e.value + ' ' + e.label;
          } else {
            chip.textContent = e.label;
          }
          cost.appendChild(chip);
        }
        btn.appendChild(cost);
      }

      if (a.unavailable) {
        btn.disabled = true;
        const why = document.createElement('div');
        why.className = 'presser-cost';
        why.textContent = a.unavailable;
        btn.appendChild(why);
      } else {
        btn.addEventListener('click', () => {
          spec.onAnswer?.(q, a, index);
          index += 1;
          render();
          if (index >= spec.questions.length) spec.onDone?.();
        });
      }
      answers.appendChild(btn);
    }
  }

  render();

  return {
    el: root,
    next(): boolean {
      if (index >= spec.questions.length) return false;
      index += 1;
      render();
      if (index >= spec.questions.length) spec.onDone?.();
      return true;
    },
    destroy(): void { root.remove(); },
  };
}

function askerFrom(j: Journalist | undefined): { name: string; outlet: string; look: PersonLook } {
  const p = j ?? personFor('press:fallback', 'journalist');
  return {
    name: p.firstName + ' ' + p.lastName,
    outlet: (p as Journalist).outlet ?? 'Paddock press',
    look: p.look,
  };
}
