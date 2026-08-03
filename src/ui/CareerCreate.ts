import './career.css';
import { driverPortraitSvg, nationPlateSvg } from './DriverPortrait';
import { escapeHtml } from './TimingRow';
import {
  HELMET_FAMILIES, HELMET_PIGMENTS, NATIONS, VISORS,
  availableNumbers, defaultHelmet, driverCode, hex, nationOf,
  type HelmetDesign, type HelmetFamilyId, type VisorTint,
} from '../career/Identity';

/**
 * The front door: making the driver whose career this is.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG WITH THE SCREEN THIS REPLACES
 * ---------------------------------------------------------------------------
 *
 * It was three text fields, three fact boxes, a car render and a button, and
 * the verdict on it was "super ugly, super vague, pretty garbage". The specific
 * failure underneath that is worth naming, because it is not a styling problem:
 * THE SCREEN STATED THE RULES OF THE MODE INSTEAD OF PUTTING YOU IN IT. Three
 * boxes reading "Starting tier / Promotion / Calendar" are a manual page. You
 * typed a name into a box, and then never saw it again — which was true in a
 * deeper sense than anybody realised, because the name was not reaching the
 * simulation at all (see `src/career/Seat.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS INSTEAD
 * ---------------------------------------------------------------------------
 *
 * A driver, standing on the left, who changes as you make them. Type a surname
 * and the three letters on the timing tower change with it. Pick a country and
 * the plate under the portrait changes. Choose a pattern and the helmet is
 * repainted. The whole screen is one live object plus the controls that shape
 * it, which is the difference between filling in a form and making somebody.
 *
 * THE HELMET IS THE SIGNATURE. It is the only thing in this game whose colour
 * the player chooses, and it is the reason the career has a face at all — see
 * `src/career/Identity.ts` for why a helmet and not a face. Everything else on
 * this screen is deliberately quiet so that the one loud thing is the one the
 * player made.
 *
 * The rules of the mode have not been deleted; they have been moved to where
 * they are a consequence rather than a syllabus. "The seat" says which team is
 * offering, what the car is, and that the top two go up — as facts about the
 * thing being signed for, at the moment of signing it.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE
 * ---------------------------------------------------------------------------
 *
 * `main.ts` is being worked in by several people at once and this is four
 * hundred lines of screen. It takes a container and returns a reader for what
 * the player chose; `main.ts` keeps the page chassis, the car stage and the
 * button, which is about twenty lines. It also means `audit/career.html` can
 * photograph the real screen without booting a renderer and an audio engine.
 */

export interface CreatedIdentity {
  firstName: string;
  lastName: string;
  nationality: string;
  raceNumber: number;
  helmet: HelmetDesign;
}

export interface CareerCreateOptions {
  /** Numbers already on the grid this player is joining. */
  takenNumbers?: Iterable<number>;
  /** Seed for the opening helmet, so two careers do not start identical. */
  seed?: number;
  /** The seat being offered: team name, colours, championship. */
  seat: {
    teamName: string;
    tierName: string;
    rounds: number;
    colour: number;
    accent: number;
  };
  /** Called whenever anything changes, so the caller can repaint a car stage. */
  onChange?: (id: CreatedIdentity) => void;
  /** Called when the player commits. */
  onSubmit: (id: CreatedIdentity) => void;
}

export interface CareerCreateHandle {
  /** What the player has chosen, right now. */
  identity(): CreatedIdentity;
  /** Commits, as the page's own action button does. */
  submit(): void;
}

const DEFAULT_FIRST = 'Alex';
const DEFAULT_LAST = 'Carter';

export function buildCareerCreate(
  root: HTMLElement, opts: CareerCreateOptions,
): CareerCreateHandle {
  const seed = opts.seed ?? ((Math.random() * 0x7fffffff) | 0);
  const numbers = availableNumbers(opts.takenNumbers ?? []);

  const state: CreatedIdentity = {
    firstName: DEFAULT_FIRST,
    lastName: DEFAULT_LAST,
    nationality: 'United Kingdom',
    raceNumber: numbers.includes(47) ? 47 : (numbers[0] ?? 47),
    helmet: defaultHelmet(seed),
  };

  root.classList.add('signing');

  // =========================================================================
  // Left: the driver, live
  // =========================================================================

  const showcase = el('div', 'sg-showcase', root);
  const plinth = el('div', 'sg-plinth', showcase);
  const portraitHost = el('div', 'sg-portrait', plinth);

  const idcard = el('div', 'sg-idcard', showcase);
  const codeEl = el('div', 'sg-code', idcard);
  const nameEl = el('div', 'sg-name', idcard);
  const belowName = el('div', 'sg-below', idcard);
  const natHost = el('div', 'sg-nat', belowName);
  const numEl = el('div', 'sg-num', belowName);

  // =========================================================================
  // Right: the controls
  // =========================================================================

  const panel = el('div', 'sg-panel', root);

  // --- You ---------------------------------------------------------------
  section(panel, 'You', 'The name that goes on the timing tower.');
  const names = el('div', 'sg-fields', panel);
  const first = textField(names, 'Given name', DEFAULT_FIRST, (v) => {
    state.firstName = v; repaint();
  });
  const last = textField(names, 'Surname', DEFAULT_LAST, (v) => {
    state.lastName = v; repaint();
  });

  const picks = el('div', 'sg-fields', panel);
  // A LIST, NOT A TEXT BOX. A typed nationality is a string nothing downstream
  // can use; a chosen one carries the three-letter code the boards print.
  selectField(picks, 'Nationality', NATIONS.map((n) => [n.name, n.name]),
    state.nationality, (v) => { state.nationality = v; repaint(); });
  selectField(picks, 'Race number',
    numbers.map((n) => [String(n), String(n)]),
    String(state.raceNumber), (v) => { state.raceNumber = Number(v); repaint(); });

  // --- The helmet --------------------------------------------------------
  section(panel, 'Your helmet',
    'The one thing on this grid that is yours. Drivers design their own.');

  const familyRow = el('div', 'sg-families', panel);
  const familyButtons = new Map<HelmetFamilyId, HTMLElement>();
  for (const f of HELMET_FAMILIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sg-family';
    b.title = f.note;
    b.setAttribute('aria-label', f.name + '. ' + f.note);
    const art = el('span', 'sg-family-art', b);
    el('span', 'sg-family-name', b, f.name);
    b.addEventListener('click', () => { state.helmet.family = f.id; repaint(); });
    familyRow.appendChild(b);
    familyButtons.set(f.id, b);
    // The swatch is the real drawing at chip size, so what is on the button is
    // exactly what lands on the helmet.
    art.appendChild(driverPortraitSvg(
      { ...state.helmet, family: f.id }, { bust: false, uid: 'fam-' + f.id }));
  }
  const familyNote = el('div', 'sg-note', panel);

  const paints = el('div', 'sg-paints', panel);
  const pigmentRows: { key: 'base' | 'stripe' | 'trim'; swatches: HTMLElement[] }[] = [];
  for (const [key, label] of [
    ['base', 'Shell'], ['stripe', 'Pattern'], ['trim', 'Trim'],
  ] as const) {
    const row = el('div', 'sg-paintrow', paints);
    el('div', 'sg-paintlabel', row, label);
    const strip = el('div', 'sg-pigments', row);
    const swatches: HTMLElement[] = [];
    for (const p of HELMET_PIGMENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sg-pigment';
      b.style.setProperty('--pig', hex(p.hex));
      b.title = p.name;
      b.setAttribute('aria-label', label + ': ' + p.name);
      b.addEventListener('click', () => { state.helmet[key] = p.hex; repaint(); });
      strip.appendChild(b);
      swatches.push(b);
    }
    pigmentRows.push({ key, swatches });
  }

  const visorRow = el('div', 'sg-paintrow', paints);
  el('div', 'sg-paintlabel', visorRow, 'Visor');
  const visorStrip = el('div', 'sg-visors', visorRow);
  const visorButtons = new Map<VisorTint, HTMLElement>();
  for (const v of VISORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sg-visor';
    b.textContent = v.name;
    b.style.setProperty('--visor', v.fill);
    b.addEventListener('click', () => { state.helmet.visor = v.id; repaint(); });
    visorStrip.appendChild(b);
    visorButtons.set(v.id, b);
  }

  const dice = document.createElement('button');
  dice.type = 'button';
  dice.className = 'sg-dice';
  dice.textContent = 'Paint me another';
  dice.addEventListener('click', () => {
    state.helmet = defaultHelmet((Math.random() * 0x7fffffff) | 0);
    repaint();
  });
  paints.appendChild(dice);

  // --- The seat ----------------------------------------------------------
  section(panel, 'The seat', 'What is actually on offer, and what it is worth.');
  const seat = el('div', 'sg-seat', panel);
  seat.style.setProperty('--team', hex(opts.seat.colour));
  const seatHead = el('div', 'sg-seat-head', seat);
  el('div', 'sg-seat-team', seatHead, opts.seat.teamName);
  el('div', 'sg-seat-tier', seatHead, opts.seat.tierName);
  const seatFacts = el('div', 'sg-seat-facts', seat);
  fact(seatFacts, 'Calendar', opts.seat.rounds + ' rounds');
  fact(seatFacts, 'To go up', 'Finish in the top two');
  fact(seatFacts, 'If you do not', 'Four seasons here and the seat is gone');
  el('div', 'sg-seat-line', seat,
    'It is the slowest car in the championship. Every driver who has ever '
    + 'reached Formula 1 started somewhere like it.');

  // =========================================================================
  // Painting
  // =========================================================================

  function repaint(): void {
    const code = driverCode(state.lastName || DEFAULT_LAST);
    const nation = nationOf(state.nationality);

    portraitHost.innerHTML = '';
    portraitHost.appendChild(driverPortraitSvg(state.helmet, {
      suit: opts.seat.colour,
      accent: opts.seat.accent,
      number: state.raceNumber,
      uid: 'signing',
    }));

    codeEl.textContent = code;
    // Given name light, surname heavy — the broadcast register the whole game
    // sets names in. See `timingRow`.
    nameEl.innerHTML =
      '<i>' + escapeHtml(state.firstName || DEFAULT_FIRST) + '</i>'
      + '<b>' + escapeHtml((state.lastName || DEFAULT_LAST).toUpperCase()) + '</b>';
    natHost.innerHTML = '';
    natHost.appendChild(nationPlateSvg(state.nationality));
    el('span', 'sg-natname', natHost, nation.name);
    numEl.textContent = String(state.raceNumber);

    // The player's own colour, published to the screen. The one colour in this
    // game that means "you" rather than meaning a fact about a lap.
    root.style.setProperty('--me', hex(state.helmet.base));
    root.style.setProperty('--me-2', hex(state.helmet.stripe));

    for (const [id, b] of familyButtons) {
      b.classList.toggle('on', id === state.helmet.family);
      const art = b.querySelector('.sg-family-art');
      if (art) {
        art.innerHTML = '';
        art.appendChild(driverPortraitSvg(
          { ...state.helmet, family: id }, { bust: false, uid: 'fam-' + id }));
      }
    }
    familyNote.textContent =
      HELMET_FAMILIES.find((f) => f.id === state.helmet.family)?.note ?? '';

    for (const row of pigmentRows) {
      for (const [i, b] of row.swatches.entries()) {
        b.classList.toggle('on', HELMET_PIGMENTS[i].hex === state.helmet[row.key]);
      }
    }
    for (const [id, b] of visorButtons) b.classList.toggle('on', id === state.helmet.visor);

    opts.onChange?.({ ...state, helmet: { ...state.helmet } });
  }

  repaint();

  // Enter, from either name field, signs. A screen whose whole job is one
  // decision should not need the mouse to make it.
  for (const f of [first, last]) {
    f.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });
  }

  function submit(): void {
    opts.onSubmit({
      firstName: state.firstName.trim() || DEFAULT_FIRST,
      lastName: state.lastName.trim() || DEFAULT_LAST,
      nationality: state.nationality,
      raceNumber: state.raceNumber,
      helmet: { ...state.helmet },
    });
  }

  return {
    identity: () => ({ ...state, helmet: { ...state.helmet } }),
    submit,
  };
}

// ===========================================================================
// Small builders
// ===========================================================================

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function section(parent: HTMLElement, title: string, note: string): void {
  const h = el('div', 'sg-section', parent);
  el('div', 'sg-section-title', h, title);
  el('div', 'sg-section-note', h, note);
}

function fact(parent: HTMLElement, label: string, value: string): void {
  const f = el('div', 'sg-fact', parent);
  el('div', 'sg-fact-label', f, label);
  el('div', 'sg-fact-value', f, value);
}

function textField(
  parent: HTMLElement, label: string, value: string, onInput: (v: string) => void,
): HTMLInputElement {
  const f = el('div', 'sg-field', parent);
  const id = 'sg-' + label.replace(/\W+/g, '-').toLowerCase();
  const l = document.createElement('label');
  l.textContent = label;
  l.htmlFor = id;
  f.appendChild(l);
  const i = document.createElement('input');
  i.id = id;
  i.type = 'text';
  i.value = value;
  i.maxLength = 24;
  // Named off, so a password manager and a mobile autocomplete leave them be.
  i.autocomplete = 'off';
  i.spellcheck = false;
  i.addEventListener('input', () => onInput(i.value));
  f.appendChild(i);
  return i;
}

function selectField(
  parent: HTMLElement, label: string, options: [string, string][],
  value: string, onChange: (v: string) => void,
): HTMLSelectElement {
  const f = el('div', 'sg-field', parent);
  const id = 'sg-' + label.replace(/\W+/g, '-').toLowerCase();
  const l = document.createElement('label');
  l.textContent = label;
  l.htmlFor = id;
  f.appendChild(l);
  const s = document.createElement('select');
  s.id = id;
  for (const [v, text] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    s.appendChild(o);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  f.appendChild(s);
  return s;
}
