import './career.css';
import './myteam.css';
import { splitName, timingBoard, timingRow } from './TimingRow';
import {
  buildLiveryEditor, hex, type LiveryChoice, type LiveryEditorHandle,
} from './LiveryEditor';
import { money } from './TeamHQ';
import { NATIONS } from '../career/Identity';
import { FALLBACK_POWER_UNIT_ID } from '../data/roster';
import { Career } from '../career/Career';
import {
  COST_CAP_USD, STARTING_BUDGET_USD, defaultDepartments, engineOffers,
  factoryAnnualCostUsd,
} from '../career/MyTeam';
import { DEFAULT_LIVERY_DESIGN, drawMark, type LiveryDesign } from '../render/LiveryDesign';
import type { WorldDriver } from '../career/World';
import { ratingsFor } from '../career/DriverRatings';

/**
 * FOUNDING THE TEAM.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ONE SCREEN AND NOT FOUR
 * ---------------------------------------------------------------------------
 *
 * Naming the team, painting the car, signing an engine and hiring the second
 * driver are four decisions, and the obvious build is four steps with a Next
 * button. That would be wrong here for a specific reason: THEY ARE NOT
 * INDEPENDENT. The engine you can afford depends on the driver you signed,
 * because both come out of the same $150M and both sit outside the cost cap —
 * and the whole point of the mode is that the player feels that trade. A wizard
 * hides it behind a page turn.
 *
 * So it is one screen with the car standing in it, and the money remaining is
 * restated under every decision that spends it. It is the same two-column
 * layout as the paint shop because it IS the paint shop, extended: the livery
 * editor owns the car and the left column, and the contracts are appended
 * beneath the paint controls in the right one. The car being named, painted,
 * engined and crewed is one object on the screen the whole time.
 */

export interface CreatedTeam {
  name: string;
  shortName: string;
  code: string;
  baseCountry: string;
  colour: number;
  accent: number;
  design: LiveryDesign;
  powerUnitId: string;
  teammate: WorldDriver;
}

export interface TeamCreateOptions {
  seed: number;
  /** The player's own number and code, so the preview is their car. */
  number: number;
  driverCode: string;
  quality?: 'low' | 'high';
  onSubmit: (team: CreatedTeam) => void;
}

export interface TeamCreateHandle {
  submit(): void;
  dispose(): void;
}

const DEFAULT_NAME = 'Northgate Racing';

export function buildTeamCreate(
  root: HTMLElement, opts: TeamCreateOptions,
): TeamCreateHandle {
  const agents = Career.freeAgentsFor(opts.seed);
  // A brand-new constructor has nothing to its name, so reputation is the
  // starting 20 — which is exactly why the strongest manufacturers will not
  // talk to it yet and the newest programme will.
  const offers = engineOffers('myteam', 2026, 20);

  const state = {
    name: DEFAULT_NAME,
    shortName: 'Northgate',
    code: 'NGR',
    baseCountry: 'United Kingdom',
    // The fallback id comes out of `src/data/roster/`, which is the swappable
    // IP boundary PROJECT.md §3 asks be kept. Naming a real manufacturer here
    // would put one outside it.
    powerUnitId: offers.find((o) => o.available)?.unit.id ?? FALLBACK_POWER_UNIT_ID,
    teammate: agents[0],
  };

  /**
   * The livery, as of the last change.
   *
   * HELD RATHER THAN READ BACK OFF THE EDITOR, and that is not a style
   * preference. `buildLiveryEditor` paints itself once during construction and
   * fires `onChange` from inside that first paint — before it has returned, so
   * before `editor` is bound. Reading `editor.choice()` from the callback threw
   * a temporal-dead-zone error that took the whole create screen down with it,
   * which is precisely the class of fault `shoot:myteam` exists to catch,
   * because it is invisible to the type checker and invisible to any harness
   * that mounts the components separately.
   */
  /**
   * False until everything this screen paints exists.
   *
   * A plain flag rather than a null check on any one element, because the whole
   * right-hand column is declared with `const` BELOW the editor and every one
   * of those bindings is in its temporal dead zone during the editor's first
   * paint — so "check whether it exists yet" is itself the error. The flag is
   * declared before the editor, which is the only way to ask the question.
   */
  let ready = false;

  let livery: LiveryChoice = {
    colour: 0x0f4d35,
    accent: 0xe0a72c,
    design: { ...DEFAULT_LIVERY_DESIGN, family: 'halo', trim: 0xe8e0d0, mark: 3 },
  };

  const editor: LiveryEditorHandle = buildLiveryEditor(root, {
    initial: livery,
    number: opts.number,
    code: opts.driverCode,
    quality: opts.quality,
    onChange: (choice) => { livery = choice; repaintIdentity(); },
  });
  const panel = editor.panel;

  // =========================================================================
  // Who you are
  // =========================================================================
  //
  // ABOVE the paint controls, because the name comes first — but appended after
  // them and moved, so the livery editor's own construction order is untouched.
  const identityHost = document.createElement('div');
  panel.insertBefore(identityHost, panel.firstChild);

  section(identityHost, 'The team', 'The name that goes on the entry list and the timing tower.');
  const names = el('div', 'sg-fields', identityHost);
  textField(names, 'Full name', state.name, (v) => {
    state.name = v;
    // The short name follows the full one until somebody edits it directly,
    // which is what stops a screen full of fields from being four things to
    // fill in when it is really one.
    if (!shortEdited) {
      state.shortName = v.split(/\s+/)[0] || v;
      shortInput.value = state.shortName;
    }
    if (!codeEdited) {
      state.code = autoCode(v);
      codeInput.value = state.code;
    }
    repaintIdentity();
  });
  let shortEdited = false;
  const shortInput = textField(names, 'Short name', state.shortName, (v) => {
    shortEdited = true; state.shortName = v; repaintIdentity();
  });
  let codeEdited = false;
  const codeInput = textField(names, 'Code', state.code, (v) => {
    codeEdited = true; state.code = v.toUpperCase().slice(0, 3); repaintIdentity();
  });
  codeInput.maxLength = 3;
  selectField(names, 'Base', NATIONS.map((n) => [n.name, n.name]), state.baseCountry,
    (v) => { state.baseCountry = v; repaintIdentity(); });

  const identityBlock = el('div', 'mt-identity', identityHost);
  const identityMarkHost = el('div', 'mt-identity-mark', identityBlock);
  const identityText = el('div', 'mt-identity-text', identityBlock);
  const identityName = el('div', 'mt-identity-name', identityText);
  const identitySub = el('div', 'mt-identity-sub', identityText);
  const identityCode = el('div', 'mt-identity-code', identityBlock);

  // =========================================================================
  // The engine
  // =========================================================================

  section(panel, 'The engine',
    'It multiplies the power and the deployment of the car the physics builds, '
    + 'and it adds to the chance of not finishing. Outside the cost cap.');
  const engineBoard = timingBoard(panel, ['#', 'Manufacturer', 'Power', 'Deploy', 'A season']);
  const engineRows: { id: string; row: HTMLElement }[] = [];
  const ranked = offers.slice().sort((a, b) => (b.powerMult + b.ersMult) - (a.powerMult + a.ersMult));
  for (const [i, o] of ranked.entries()) {
    const row = timingRow(engineBoard, {
      pos: String(i + 1),
      code: o.unit.shortName.slice(0, 3).toUpperCase(),
      name: o.unit.shortName,
      last: o.unit.shortName.toUpperCase(),
      note: o.reason + ' · $' + money(o.costUsd) + ' a season · '
        + (o.failureRate * 100).toFixed(1) + '% chance of a failure per race',
      figs: [
        { text: (o.powerMult * 100).toFixed(1) + '%', cls: o.powerMult >= 1.02 ? 'best' : '' },
        { text: (o.ersMult * 100).toFixed(1) + '%', cls: o.ersMult >= 1.03 ? 'best' : '' },
      ],
      // Short: the tag cell sits immediately beside the figure column and an
      // eight-character string overruns it.
      tag: o.available
        ? { text: o.costUsd > 0 ? '$' + Math.round(o.costUsd / 1e6) + 'M' : 'WORKS' }
        : { text: 'LOCKED' },
      index: i,
      onClick: o.available ? () => { state.powerUnitId = o.unit.id; repaintChoices(); } : undefined,
    });
    if (!o.available) row.classList.add('is-locked');
    engineRows.push({ id: o.unit.id, row });
  }

  // =========================================================================
  // The second car
  // =========================================================================

  section(panel, 'The second car',
    'A real driver in this world. They qualify on merit, race the same physics '
    + 'and score constructors’ points. Their salary is outside the cap.');
  const driverBoard = timingBoard(panel, ['#', 'Free agent', 'RTG', 'Exp', 'Asking']);
  const driverRows: { id: string; row: HTMLElement }[] = [];
  for (const [i, d] of agents.entries()) {
    const n = splitName(d.firstName + ' ' + d.lastName);
    const row = timingRow(driverBoard, {
      pos: String(i + 1),
      code: d.code,
      name: d.firstName + ' ' + d.lastName,
      first: n.first, last: n.last,
      note: d.nationality + ' · age ' + d.age + ' · '
        + (d.experience === 0 ? 'a rookie' : d.experience + ' seasons'),
      // The driver's RATING, from the one model that decides what one is.
      figs: [
        { text: String(ratingsFor(d).rtg), cls: ratingsFor(d).rtg >= 78 ? 'best' : '' },
        { text: String(ratingsFor(d).exp) },
      ],
      tag: { text: '$' + money(d.salaryUsd) },
      index: i,
      onClick: () => { state.teammate = d; repaintChoices(); },
    });
    driverRows.push({ id: d.id, row });
  }

  // =========================================================================
  // The money
  // =========================================================================

  section(panel, 'The money', 'What you are starting with, and what it has to cover.');
  const moneyBox = el('div', 'capgauge', panel);
  const moneyHead = el('div', 'capgauge-head', moneyBox);
  el('div', 'capgauge-label', moneyHead, 'Founding capital');
  el('div', 'capgauge-value', moneyHead, '$' + money(STARTING_BUDGET_USD));
  el('div', 'capgauge-of', moneyHead, 'cost cap $' + money(COST_CAP_USD) + ' a season');
  const moneyNote = el('div', 'capgauge-note', moneyBox);

  // =========================================================================
  // Painting
  // =========================================================================

  function repaintIdentity(): void {
    // Everything below is created after the editor, so the editor's own first
    // paint reaches this before any of it exists. Nothing to repaint yet.
    if (!ready) return;
    const choice = livery;
    identityBlock.style.setProperty('--team', hex(choice.colour));
    identityName.textContent = state.name || DEFAULT_NAME;
    identitySub.textContent = state.baseCountry + ' · entering the '
      + 'FIA Formula One World Championship as the twelfth team';
    identityCode.textContent = state.code || 'TBC';

    identityMarkHost.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 76;
    identityMarkHost.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      if (choice.design.mark >= 0) {
        drawMark(ctx, 38, 38, 72, choice.design.mark, hex(choice.colour), hex(choice.accent));
      } else {
        ctx.fillStyle = hex(choice.colour);
        ctx.beginPath();
        ctx.arc(38, 38, 36, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    repaintChoices();
  }

  function repaintChoices(): void {
    for (const { id, row } of engineRows) {
      row.classList.toggle('is-current', id === state.powerUnitId);
    }
    for (const { id, row } of driverRows) {
      row.classList.toggle('is-current', id === state.teammate.id);
    }

    // The one number that makes the two contracts a single decision: what the
    // first season's fixed bill leaves for building anything.
    const factory = factoryAnnualCostUsd(defaultDepartments());
    const engine = offers.find((o) => o.unit.id === state.powerUnitId)?.costUsd ?? 0;
    const fixed = factory.staffUsd + factory.facilityUsd + engine + state.teammate.salaryUsd;
    const left = STARTING_BUDGET_USD - fixed;
    const capLeft = COST_CAP_USD - factory.staffUsd - factory.facilityUsd;
    moneyNote.textContent =
      `Your first season's fixed bill is $${money(fixed)} — $${money(factory.staffUsd)} of wages, `
      + `$${money(factory.facilityUsd)} of facilities, $${money(engine)} for the engine and `
      + `$${money(state.teammate.salaryUsd)} for ${state.teammate.lastName}. `
      + `That leaves $${money(left)} in the bank to develop with, against $${money(capLeft)} `
      + 'of cost-cap headroom. Cash is what limits you in the first seasons; the cap is what '
      + 'limits you once the sport starts paying you.';
    moneyNote.className = 'capgauge-note' + (left < 20_000_000 ? ' warn' : '');
  }

  ready = true;
  repaintIdentity();

  return {
    submit(): void {
      const choice = editor.choice();
      livery = choice;
      opts.onSubmit({
        name: state.name.trim() || DEFAULT_NAME,
        shortName: state.shortName.trim() || state.name.trim() || DEFAULT_NAME,
        code: (state.code.trim() || autoCode(state.name)).toUpperCase().slice(0, 3),
        baseCountry: state.baseCountry,
        colour: choice.colour,
        accent: choice.accent,
        design: choice.design,
        powerUnitId: state.powerUnitId,
        teammate: state.teammate,
      });
    },
    dispose(): void { editor.dispose(); },
  };
}

// ===========================================================================
// Small builders
// ===========================================================================

/** Three letters from a team name, the way an entry list abbreviates one. */
function autoCode(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'TBC';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase().padEnd(3, 'X');
  return (words[0][0] + words[1][0] + (words[2]?.[0] ?? words[0][1] ?? 'X'))
    .toUpperCase().padEnd(3, 'X');
}

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

function textField(
  parent: HTMLElement, label: string, value: string, onInput: (v: string) => void,
): HTMLInputElement {
  const f = el('div', 'sg-field', parent);
  const id = 'mt-' + label.replace(/\W+/g, '-').toLowerCase();
  const l = document.createElement('label');
  l.textContent = label;
  l.htmlFor = id;
  f.appendChild(l);
  const i = document.createElement('input');
  i.id = id;
  i.type = 'text';
  i.value = value;
  i.maxLength = 28;
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
  const id = 'mt-' + label.replace(/\W+/g, '-').toLowerCase();
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
