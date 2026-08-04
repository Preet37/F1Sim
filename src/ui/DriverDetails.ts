import './driver.css';
import './people/people.css';
import { escapeHtml } from './TimingRow';
import { nationPlateSvg } from './DriverPortrait';
import { figureSvg } from './people/Figure';
import { lookFor } from './people/Look';
import { hex } from './LiveryEditor';
import { money } from './DriverMarketScreen';
import type { Career } from '../career/Career';
import { findTeam, type WorldDriver } from '../career/World';
import { getCircuit } from '../data/tracks/circuits';
import {
  RATING_CODE, RATING_EFFECT, RATING_KEYS, RATING_NAME, RECOGNITION_PERKS,
  ratingsFor,
  type AccoladeProgress, type DriverRatings, type RatingKey, type RatingSample,
} from '../career/DriverRatings';

/**
 * DRIVER DETAILS — `reference/target/83.png` and `85.png`, and the screens
 * their sub-tabs lead to (`84.png`, `86.png`, `87.png`).
 *
 * ===========================================================================
 * THE CHROME
 * ===========================================================================
 *
 * Two rows of tabs, exactly as both frames have them: six main tabs in heavy
 * uppercase with the active one solid red, then a strip of sub-tabs in a
 * red-tinted bar. Both are skewed parallelograms, which is the house device of
 * the whole reference set.
 *
 * THE MAIN TABS GO SOMEWHERE REAL OR THEY ARE DRAWN LOCKED. This game does not
 * have an F1 Manager "Specialists" page and inventing a button that opens
 * nothing is precisely the defect #62 and #13 are about — a screen that exists
 * on the page and not in the game. So a tab with no destination in THIS career
 * is drawn in the locked state with the reason on it, which is the same
 * treatment `engineDeal` gives a manufacturer that will not supply you.
 *
 * ===========================================================================
 * EVERY FIGURE ON THESE PAGES COMES FROM `Career`
 * ===========================================================================
 *
 * `career.ratings()`, `.ratingCaps()`, `.contractGoal()`, `.accolades()`,
 * `.recognition()`, `.ratingsState.history`. Not one of them is recomputed
 * here, and `probe:ratings` §6 fails the build if any file in `src/ui/` reads
 * a raw driver attribute — which four of them were doing before #77, three of
 * them printing `skill × 100` as though it were a rating and none of them
 * agreeing with each other.
 */

export type DetailTab =
  | 'contracts' | 'accolades' | 'rivals' | 'recognition' | 'graph' | 'comparison';

/** Sub-tab id, and the label the strip prints. Order is the reference's. */
export const DETAIL_TABS: readonly [DetailTab, string][] = [
  ['contracts', 'Contracts'],
  ['accolades', 'Accolades'],
  ['rivals', 'Rivals'],
  ['recognition', 'Recognition'],
  ['graph', 'Driver Ratings Graph'],
  ['comparison', 'Driver Rating Comparison'],
];

export interface DetailRoutes {
  /** OVERVIEW — the career hub. */
  overview: () => void;
  /** STANDINGS — the championship table. */
  standings: () => void;
  /** VEHICLE — car setup. */
  vehicle: () => void;
  /** R&D and SPECIALISTS — Team HQ. Null outside My Team. */
  factory: (() => void) | null;
  /** The driver market, which the comparison tab links back into. */
  market: () => void;
}

export interface DetailOptions {
  career: Career;
  tab: DetailTab;
  /** Who the comparison tab is comparing against. */
  compareTo: string | null;
  onTab: (tab: DetailTab) => void;
  onCompareTo: (driverId: string) => void;
  routes: DetailRoutes;
  /** Called after anything that changes the save. */
  onChange: () => void;
}

/** Renders the whole screen into `body`. */
export function buildDriverDetails(body: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;

  // --- The two tab rows -----------------------------------------------------
  const tabs = el('div', 'dd-tabs', body);
  mainTab(tabs, 'Overview', opts.routes.overview);
  mainTab(tabs, 'Specialists', opts.routes.factory,
    'The factory floor. A driver career does not have one.');
  mainTab(tabs, 'Driver Details', null, '', true);
  mainTab(tabs, 'R&D', opts.routes.factory,
    'Research and development. A driver career does not have one.');
  mainTab(tabs, 'Vehicle', opts.routes.vehicle);
  mainTab(tabs, 'Standings', opts.routes.standings);

  const strip = el('div', 'dd-subtabs', body);
  for (const [id, label] of DETAIL_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dd-subtab' + (id === opts.tab ? ' on' : '');
    const s = document.createElement('span');
    s.textContent = label;
    b.appendChild(s);
    b.addEventListener('click', () => opts.onTab(id));
    strip.appendChild(b);
  }

  // --- The stage: content left, driver right --------------------------------
  //
  // The comparison tab stands two drivers side by side and has no room for a
  // third figure, so it takes the whole width. Every other tab is the
  // reference's arrangement.
  const wide = opts.tab === 'comparison' || opts.tab === 'recognition';
  const stage = el('div', 'dd-stage' + (wide ? ' no-figure' : ''), body);
  const main = el('div', 'dd-main', stage);

  switch (opts.tab) {
    case 'contracts': contractsTab(main, opts); break;
    case 'accolades': accoladesTab(main, opts); break;
    case 'rivals': rivalsTab(main, opts); break;
    case 'recognition': recognitionTab(main, opts); break;
    case 'graph': graphTab(main, opts); break;
    case 'comparison': comparisonTab(main, opts); break;
  }

  if (!wide) {
    const team = findTeam(career.world, career.state.teamId);
    const art = el('div', 'dd-figure', stage);
    const fig = figureSvg(lookFor(career.state.playerDriverId, 'driver'), {
      uid: 'dd-player',
      suit: hex(team?.colour ?? 0x2b3440),
      accent: hex(team?.accent ?? 0xe8e0d0),
      team: hex(team?.colour ?? 0x2b3440),
      pose: opts.tab === 'accolades' ? 'folded' : 'standing',
      number: career.state.player.raceNumber,
      sponsors: true,
    });
    fig.setAttribute('class', 'person-figure');
    art.appendChild(fig);
    el('div', 'dd-figure-name', art,
      career.state.player.firstName + ' ' + career.state.player.lastName);
  }
}

function mainTab(
  parent: HTMLElement, label: string, go: (() => void) | null,
  lockedReason = '', active = false,
): void {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dd-tab' + (active ? ' on' : '') + (!active && !go ? ' is-locked' : '');
  const s = document.createElement('span');
  s.textContent = label;
  b.appendChild(s);
  if (go) b.addEventListener('click', go);
  else if (!active) { b.disabled = true; b.title = lockedReason; }
  parent.appendChild(b);
}

// ===========================================================================
// CONTRACTS — `85.png`
// ===========================================================================

function contractsTab(parent: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;
  const goal = career.contractGoal();
  const now = career.ratings();
  const grid = el('div', 'dd-contract', parent);

  // --- The goal card -------------------------------------------------------
  const left = el('div', 'dd-panel', grid);
  el('div', 'dd-goal-head', left, 'Contract Goals');
  const gap = goal.targetRtg - goal.signedRtg;
  el('div', 'dd-goal-title', left,
    gap > 0 ? `Increase rating by ${gap}` : 'Hold your rating');
  el('div', 'dd-goal-note', left,
    'The team expects you to reach your target by the end of this season.');

  const rows = el('div', 'dd-goal-rows', left);
  goalRow(rows, 'target', goal.targetRtg, 'Target');
  goalRow(rows, 'current', now.rtg, 'Current');
  goalRow(rows, 'retain', goal.retainRtg, 'Retain Seat');

  el('div', 'dd-goal-head', left, 'Contract Information');
  const rail = el('div', 'dd-rail', left);
  railItem(rail, 'Contract Performance', true, () => opts.onTab('contracts'));
  railItem(rail, 'Recognition', false, () => opts.onTab('recognition'));
  railItem(rail, 'Review Contract', false, () => opts.onTab('comparison'));
  // BREAK CONTRACT IS DRAWN AND DISABLED, which is what `85.png` shows. It is
  // greyed there too, and this career has no way to tear a contract up — so
  // the button says so on hover rather than being a live control that throws.
  const dead = railItem(rail, 'Break Contract', false, () => undefined);
  dead.disabled = true;
  dead.title = 'You cannot walk out of a contract in this career. '
    + 'Fall below the retain line and the team will do it for you.';

  el('div', 'dd-why', left,
    'The rating is the same number the simulation races. It moves after every '
    + 'weekend — pace against what the car was worth, racecraft against the '
    + 'other side of the garage, awareness for finishing and focus for '
    + 'delivering the result the car had in it.');

  // --- The chart -----------------------------------------------------------
  const right = el('div', 'dd-panel', grid);
  el('div', 'dd-panel-title', right, 'Contract Performance');
  el('div', 'dd-panel-sub', right, 'Driver Rating (RTG) progress over recent race weekends');
  ratingChart(right, {
    history: career.ratingsState.history,
    lines: [{ key: 'rtg', colour: 'var(--sig-white)' }],
    rules: [
      { at: goal.targetRtg, label: 'TARGET', cls: 'dd-chart-target' },
      { at: goal.retainRtg, label: 'RETAIN SEAT', cls: 'dd-chart-retain' },
    ],
    yLabel: 'Driver Rating',
  });
}

function goalRow(parent: HTMLElement, kind: string, value: number, label: string): void {
  const row = el('div', 'dd-goal-row ' + kind, parent);
  el('div', 'dd-goal-fig', row, String(value));
  el('div', 'dd-goal-label', row, label);
}

function railItem(
  parent: HTMLElement, label: string, on: boolean, onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dd-rail-item' + (on ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

// ===========================================================================
// THE CHART
// ===========================================================================

interface ChartSpec {
  history: readonly RatingSample[];
  lines: { key: RatingKey | 'rtg'; colour: string; name?: string }[];
  rules?: { at: number; label: string; cls: string }[];
  yLabel: string;
}

/**
 * The rating line over race weekends.
 *
 * ONE FUNCTION FOR BOTH CHARTS on this screen — the contract line (`85.png`)
 * and the five-attribute graph — because they are the same picture with a
 * different set of series, and two of them would be two things to keep in step
 * with the history.
 *
 * The y-range is derived from the DATA AND THE RULES TOGETHER. `85.png` runs
 * 60–70 with the retain line at 62 and the target at 69, i.e. the window is
 * chosen so both rules are inside it — a chart that scaled to the data alone
 * would push the target rule off the top of the frame on the day the driver is
 * furthest from meeting it, which is the day it matters most.
 */
function ratingChart(parent: HTMLElement, spec: ChartSpec): void {
  const host = el('div', 'dd-chart', parent);
  const n = spec.history.length;
  if (n === 0) {
    el('div', 'dd-chart-empty', host,
      'No race weekends yet. The line starts after your first race.');
    return;
  }

  const values: number[] = [];
  for (const s of spec.history) for (const l of spec.lines) values.push(s[l.key]);
  for (const r of spec.rules ?? []) values.push(r.at);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 2) / 5) * 5);
  const hi = Math.min(100, Math.ceil((Math.max(...values) + 2) / 5) * 5);
  const span = Math.max(1, hi - lo);

  const W = 720;
  const H = 300;
  const padL = 56;
  const padR = 14;
  const padT = 12;
  const padB = 18;
  const x = (i: number): number =>
    padL + (n === 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number): number => padT + (1 - (v - lo) / span) * (H - padT - padB);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', spec.yLabel + ' over recent race weekends');

  let out = `<rect class="dd-chart-frame" x="${padL}" y="${padT}" `
    + `width="${W - padL - padR}" height="${H - padT - padB}"/>`;

  // Ticks: the top and the bottom of the window, as `85.png` labels 70 and 60.
  for (const v of [hi, lo + Math.round(span / 2), lo]) {
    out += `<line class="dd-chart-grid" x1="${padL}" y1="${y(v).toFixed(1)}" `
      + `x2="${W - padR}" y2="${y(v).toFixed(1)}"/>`
      + `<text class="dd-chart-tick" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" `
      + `text-anchor="end">${v}</text>`;
  }

  // The named rules, with their label sitting on the line as the frame does it.
  for (const r of spec.rules ?? []) {
    if (r.at < lo || r.at > hi) continue;
    const ry = y(r.at).toFixed(1);
    out += `<line class="${r.cls}" x1="${padL + 4}" y1="${ry}" x2="${W - padR - 4}" y2="${ry}"/>`
      + `<text class="dd-chart-rulelabel" x="${W / 2}" y="${(y(r.at) - 7).toFixed(1)}" `
      + `text-anchor="middle">${escapeHtml(r.label)}</text>`;
  }

  for (const l of spec.lines) {
    const d = spec.history
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(s[l.key]).toFixed(1)}`)
      .join(' ');
    out += `<path class="dd-chart-line" style="stroke:${l.colour}" d="${d}"/>`;
  }

  // The axis title, rotated up the left edge, exactly as the frame has it.
  out += `<text class="dd-chart-axis" transform="translate(16 ${H / 2}) rotate(-90)" `
    + `text-anchor="middle">${escapeHtml(spec.yLabel)}</text>`;

  svg.innerHTML = out;
  host.appendChild(svg);

  // The x-axis: a nation plate and its three letters per weekend.
  const axis = el('div', 'dd-chart-x', host);
  axis.style.paddingLeft = ((padL / W) * 100).toFixed(2) + '%';
  axis.style.paddingRight = ((padR / W) * 100).toFixed(2) + '%';
  for (const s of spec.history) {
    const item = el('div', 'dd-chart-x-item', axis);
    const circuit = safeCircuit(s.circuitId);
    item.appendChild(nationPlateSvg(circuit.country));
    el('div', 'dd-chart-x-code', item, circuit.code);
  }
  el('div', 'dd-chart-xlabel', host, 'Race weekend');

  if (spec.lines.length > 1) {
    const legend = el('div', 'dd-legend', host);
    for (const l of spec.lines) {
      const item = el('div', 'dd-legend-item', legend);
      const sw = el('span', 'dd-legend-swatch', item);
      sw.style.setProperty('--c', l.colour);
      el('span', '', item, l.name ?? l.key.toUpperCase());
    }
  }
}

/**
 * A circuit's country and its three letters, without throwing on an id this
 * build no longer has.
 *
 * A career carries its own calendar in the save, so a rating sample can name a
 * circuit that a later build has removed. `getCircuit` throws on an unknown
 * id, and a chart that throws takes the whole screen with it.
 */
function safeCircuit(id: string): { country: string; code: string } {
  try {
    const c = getCircuit(id);
    return { country: c.country, code: c.countryCode.slice(0, 3).toUpperCase() };
  } catch {
    return { country: '', code: id.slice(0, 3).toUpperCase() };
  }
}

// ===========================================================================
// ACCOLADES — `83.png`
// ===========================================================================

function accoladesTab(parent: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;
  const all = career.accolades();
  const selected = all[accoladeIndex] ?? all[0];
  if (!selected) return;

  const panel = el('div', 'dd-panel', parent);

  const head = el('div', 'dd-acc-head', panel);
  head.appendChild(accoladeGlyph(selected, 46));
  el('div', 'dd-acc-name', head, selected.accolade.name);

  el('div', 'dd-acc-count', panel,
    `${selected.count}/${selected.target}  |  TIER ${selected.tier}`);
  el('div', 'dd-acc-note', panel, selected.accolade.note);

  const enhance = el('div', 'dd-acc-enhance', panel);
  el('div', 'dd-acc-enhance-head', enhance, 'Complete this Accolade to enhance your:');
  const what = el('div', 'dd-acc-enhance-what', enhance);
  what.innerHTML = escapeHtml(title(RATING_CODE[selected.accolade.enhances]))
    + ' <i>| ' + escapeHtml(RATING_NAME[selected.accolade.enhances]) + '</i>';

  const cards = el('div', 'dd-acc-cards', panel);
  for (const [i, a] of all.entries()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'dd-acc-card' + (i === accoladeIndex ? ' on' : '')
      + (a.complete ? ' done' : '');
    card.addEventListener('click', () => { accoladeIndex = i; opts.onTab('accolades'); });
    cards.appendChild(card);

    // The green fills from the bottom by how far through the tier the counter
    // is. `83.png` uses exactly this and it is the whole reason a card is
    // readable before any of its figures are.
    const fill = el('div', 'dd-acc-card-fill', card);
    fill.style.height = (a.fraction * 100).toFixed(1) + '%';

    const art = el('div', 'dd-acc-card-art', card);
    art.appendChild(accoladeGlyph(a, 74));
    el('div', 'dd-acc-card-name', card, a.accolade.name.toUpperCase());
    el('div', 'dd-acc-card-tier', card, a.complete ? 'COMPLETE' : 'TIER ' + a.tier);
    el('div', 'dd-acc-card-fig', card, a.count + '/' + a.target);
  }

  el('div', 'dd-why', panel,
    'Every one of these is a lifetime counter kept by the career itself, and '
    + 'completing a tier lifts the attribute named above it. They are counted '
    + 'race by race — a season summary records a position and points and '
    + 'nothing else, so podiums across past seasons cannot be recovered '
    + 'afterwards and are not guessed at.');
}

/** Which card the page is showing. Held here so a repaint keeps the choice. */
let accoladeIndex = 0;

/**
 * The device on an accolade card.
 *
 * `83.png` draws five: a chevron in a home plate, a fluted shield, a diamond,
 * a monogram and a numeral. They are geometric marks, drawn here rather than
 * loaded, for the same reason `MARK_DEVICES` in `LiveryDesign.ts` are — §3
 * permits no reproduced artwork and a generated mark ships.
 */
function accoladeGlyph(a: AccoladeProgress, size: number): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const fill = '#4ea8e8';
  const dark = '#1d4d75';

  let d = '';
  switch (a.accolade.glyph) {
    case 'chevron':
      d = `<path d="M8 82 V38 L50 8 L92 38 V82 Z" fill="${dark}"/>`
        + `<path d="M50 26 L84 56 H16 Z" fill="${fill}"/>`
        + `<rect x="16" y="64" width="68" height="10" fill="${fill}"/>`;
      break;
    case 'shield':
      d = `<path d="M12 14 H88 V60 L50 92 L12 60 Z" fill="${dark}"/>`;
      for (let i = 0; i < 5; i++) {
        d += `<rect x="${20 + i * 13}" y="26" width="7" height="${34 + (i === 2 ? 14 : 0)}" fill="${fill}"/>`;
      }
      break;
    case 'diamond':
      d = `<path d="M14 20 H86 V44 L50 88 L14 44 Z" fill="${dark}"/>`
        + `<path d="M24 30 H76 L50 74 Z" fill="${fill}"/>`
        + `<path d="M24 30 L50 48 L76 30" fill="none" stroke="${dark}" stroke-width="4"/>`;
      break;
    case 'points':
      d = `<circle cx="50" cy="50" r="40" fill="${dark}"/>`
        + `<path d="M36 78 V26 H56 A15 15 0 0 1 56 56 H36" fill="none" `
        + `stroke="${fill}" stroke-width="9"/>`;
      break;
    case 'five':
      d = `<rect x="12" y="12" width="76" height="76" rx="8" fill="${dark}"/>`
        + `<path d="M64 28 H40 V50 H58 A12 12 0 0 1 58 74 H38" fill="none" `
        + `stroke="${fill}" stroke-width="9" stroke-linecap="round"/>`;
      break;
  }
  svg.innerHTML = d;
  return svg;
}

// ===========================================================================
// RIVALS — reaches `Career.declareRivalry`, which nothing could
// ===========================================================================

/**
 * `Career.declareRivalry` has been implemented, documented and reachable from
 * nowhere — PROJECT.md §7 lists it beside `spendPrepSlot`. It raises the heat
 * on a rivalry and marks it declared, and a declared rivalry is what the
 * newsroom and the press conference read. This tab is the button.
 */
function rivalsTab(parent: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;
  const panel = el('div', 'dd-panel', parent);
  el('div', 'dd-panel-title', panel, 'Rivals');
  el('div', 'dd-panel-sub', panel,
    'Heat rises when you finish near each other and cools when you do not');

  const rivalries = career.state.narrative.rivalries;
  if (rivalries.length === 0) {
    el('div', 'dd-chart-empty', panel, 'Nobody has taken an interest in you yet.');
  }

  for (const r of rivalries) {
    const d = career.world.tiers[career.tier].drivers.find((x) => x.id === r.driverId)
      ?? findAnywhere(career, r.driverId);
    const row = el('div', 'dd-rival', panel);
    row.style.setProperty('--heat',
      r.heat > 75 ? 'var(--sig-red)' : r.heat > 50 ? 'var(--sig-yellow)' : 'var(--ink-3)');

    const text = el('div', '', row);
    el('div', 'dd-rival-name', text,
      d ? d.firstName + ' ' + d.lastName : career.displayName(r.driverId));
    const rating = d ? ratingsFor(d).rtg : null;
    el('div', 'dd-rival-note', text,
      (rating !== null ? rating + ' RTG · ' : '')
      + r.state + (r.declared ? ' · declared' : ''));
    const meter = el('div', 'dd-rival-meter', text);
    (el('span', '', meter) as HTMLElement).style.width = r.heat.toFixed(0) + '%';

    const right = el('div', '', row);
    const h2h = el('div', 'dd-rival-h2h', right);
    h2h.textContent = r.wonAgainst + ' – ' + r.lostTo;
    el('i', '', h2h, 'HEAD TO HEAD');
    if (!r.declared) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';
      b.textContent = 'Declare';
      b.addEventListener('click', () => {
        career.declareRivalry(r.driverId);
        opts.onChange();
        opts.onTab('rivals');
      });
      right.appendChild(b);
    }
  }

  el('div', 'dd-why', panel,
    'Declaring a rivalry raises the heat on it and marks it, which is what the '
    + 'newsroom and the press room read when they decide what this season is '
    + 'about.');
}

function findAnywhere(career: Career, id: string): WorldDriver | undefined {
  for (const tier of ['F1', 'F2', 'F3'] as const) {
    const d = career.world.tiers[tier].drivers.find((x) => x.id === id);
    if (d) return d;
  }
  return undefined;
}

// ===========================================================================
// RECOGNITION — `84.png`
// ===========================================================================

function recognitionTab(parent: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;
  const panel = el('div', 'dd-panel', parent);
  el('div', 'dd-panel-title', panel, 'Recognition');

  const rec = career.recognition();
  if (!rec) {
    el('div', 'dd-chart-empty', panel,
      'Recognition is a split with the other side of the garage, and you do not '
      + 'have one at the moment.');
    return;
  }

  const mine = career.ratings();
  const theirs = ratingsFor(rec.teammate);
  const team = findTeam(career.world, career.state.teamId);
  const suit = hex(team?.colour ?? 0x2b3440);
  const accent = hex(team?.accent ?? 0xe8e0d0);

  // Two figures, head to head, with the panel between them — the frame's own
  // arrangement, and the reason `figureSvg` had to exist before this screen.
  const head2head = el('div', 'dd-compare', panel);
  faceOff(head2head, career.state.playerDriverId, suit, accent, 'me');

  const middle = el('div', '', head2head);

  const heads = el('div', 'dd-rec-heads', middle);
  el('div', 'mine', heads,
    career.state.player.firstName + ' ' + career.state.player.lastName.toUpperCase());
  el('div', 'theirs', heads,
    rec.teammate.firstName + ' ' + rec.teammate.lastName.toUpperCase());

  const bar = el('div', 'dd-rec-bar', middle);
  const a = el('div', 'dd-rec-seg mine', bar);
  a.style.flex = String(Math.max(0.08, rec.mine / 100));
  a.innerHTML = Math.round(rec.mine) + '<sup>%</sup>';
  const b = el('div', 'dd-rec-seg theirs', bar);
  b.style.flex = String(Math.max(0.08, rec.theirs / 100));
  b.innerHTML = Math.round(rec.theirs) + '<sup>%</sup>';

  const chips = el('div', 'dd-rec-chips', middle);
  const left = el('div', 'dd-rec-chipset', chips);
  chip(left, mine.rtg, 'RTG');
  chip(left, mine.foc, 'FOC');
  const right = el('div', 'dd-rec-chipset', chips);
  chip(right, theirs.foc, 'FOC');
  chip(right, theirs.rtg, 'RTG');

  el('div', 'dd-rec-bonus', middle, `Inc. ${rec.bonusPct.toFixed(0)}% Bonus`);

  // --- The perk ladder -----------------------------------------------------
  const perks = el('div', 'dd-perks', middle);
  const perkHead = el('div', 'dd-perk-head', perks);
  el('div', '', perkHead, 'Perk');
  el('div', '', perkHead, 'Recognition');
  for (const p of RECOGNITION_PERKS) {
    const on = rec.mine >= p.at;
    const row = el('div', 'dd-perk' + (on ? ' on' : ''), perks);
    el('div', '', row, p.name + ':');
    const at = el('div', 'dd-perk-at', row);
    at.innerHTML = '<span>' + (on ? '⌃⌃' : '⌃') + '</span>' + p.at + '%';
  }

  const breakdown = el('div', 'dd-rec-breakdown', middle);
  for (const line of rec.breakdown) {
    const row = el('div', 'dd-rec-breakdown-row', breakdown);
    el('div', '', row, line.label);
    const v = el('b', '', row);
    v.textContent = line.pct.toFixed(2) + '%';
  }

  faceOff(head2head, rec.teammate.id, suit, accent, 'them');

  // --- The one control on this page, and it reaches `spendPrepSlot` --------
  const actions = el('div', 'dm-actions', middle);
  const reason = el('div', 'dm-reason', middle);
  const meet = document.createElement('button');
  meet.type = 'button';
  meet.className = 'btn ghost';
  meet.textContent = 'A morning at the factory  ·  1 slot';
  meet.disabled = career.state.prepSlotsLeft <= 0;
  meet.addEventListener('click', () => {
    const r = career.takeMeeting();
    reason.textContent = r.reason;
    reason.classList.toggle('ok', r.ok);
    if (r.ok) { opts.onChange(); opts.onTab('recognition'); }
  });
  actions.appendChild(meet);

  el('div', 'dd-why', middle,
    'The split is your rating against the other car, plus the four bonuses '
    + 'below it. A morning at the factory spends a preparation slot, lifts every '
    + 'department\'s morale — which is what an upgrade costs and whether it '
    + 'passes quality control — and they notice you were there.');
}

function faceOff(
  parent: HTMLElement, driverId: string, suit: string, accent: string, uid: string,
): void {
  const art = el('div', 'dd-figure', parent);
  const fig = figureSvg(lookFor(driverId, 'driver'), {
    uid: 'rec-' + uid,
    suit, accent, team: suit,
    pose: 'folded',
    sponsors: true,
  });
  fig.setAttribute('class', 'person-figure');
  art.appendChild(fig);
}

function chip(parent: HTMLElement, value: number, code: string): void {
  const c = el('div', 'dd-rec-chip', parent);
  el('b', '', c, String(value));
  el('span', '', c, code);
}

// ===========================================================================
// THE RATINGS GRAPH — every attribute over the same weekends
// ===========================================================================

const SERIES_COLOUR: Record<RatingKey | 'rtg', string> = {
  rtg: 'var(--sig-white)',
  pac: 'var(--sig-red)',
  rac: 'var(--sig-yellow)',
  awa: 'var(--sig-green)',
  foc: '#b18cf0',
  exp: '#4ea8e8',
};

function graphTab(parent: HTMLElement, opts: DetailOptions): void {
  const panel = el('div', 'dd-panel', parent);
  el('div', 'dd-panel-title', panel, 'Driver Ratings Graph');
  el('div', 'dd-panel-sub', panel, 'Every attribute over recent race weekends');
  ratingChart(panel, {
    history: opts.career.ratingsState.history,
    lines: [
      { key: 'rtg', colour: SERIES_COLOUR.rtg, name: 'RTG' },
      ...RATING_KEYS.map((k) => ({
        key: k, colour: SERIES_COLOUR[k], name: RATING_CODE[k],
      })),
    ],
    yLabel: 'Rating',
  });
  el('div', 'dd-why', panel,
    'One point per race weekend, kept for the last thirty. The whole of the '
    + 'career\'s rating history is thirty samples on purpose: a save has a '
    + 'browser quota and this is the only thing on these screens that would '
    + 'otherwise grow without a bound.');
}

// ===========================================================================
// THE COMPARISON — `87.png`
// ===========================================================================

function comparisonTab(parent: HTMLElement, opts: DetailOptions): void {
  const { career } = opts;
  const market = career.market('rating');
  const me = market.find((r) => r.isPlayer);
  const themId = opts.compareTo
    ?? career.teammate()?.id
    ?? market.find((r) => !r.isPlayer)?.driver.id
    ?? null;
  const them = market.find((r) => r.driver.id === themId);

  const panel = el('div', 'dd-panel', parent);
  el('div', 'dd-panel-title', panel, 'Driver Rating Comparison');
  if (!me || !them) {
    el('div', 'dd-chart-empty', panel, 'There is nobody to compare against.');
    return;
  }

  const grid = el('div', 'dd-compare', panel);
  compareCard(grid, me.driver, me.ratings, me.caps, me.marketValueUsd, me.buyoutUsd, career, true);

  // --- The middle column: the radar, then the bars ------------------------
  const middle = el('div', '', grid);
  el('div', 'dd-panel-sub', middle, 'Statistics');
  middle.appendChild(radar(me.ratings, them.ratings));

  const bars = el('div', 'dd-bars', middle);
  // `87.png` lists Experience, Racecraft, Awareness, Pace in that order, with
  // the delta in brackets — the difference between the two drivers, not a
  // change over time.
  for (const k of ['exp', 'rac', 'awa', 'pac'] as RatingKey[]) {
    const row = el('div', 'dd-bar-row', bars);
    const head = el('div', 'dd-bar-head', row);
    el('div', 'dd-bar-name', head, RATING_NAME[k]);
    const figs = el('div', 'dd-bar-figs', head);
    figs.textContent = String(them.ratings[k]);
    const diff = them.ratings[k] - me.ratings[k];
    const delta = el('span', 'dd-bar-delta' + (diff < 0 ? ' down' : ''), figs);
    delta.textContent = '(' + (diff >= 0 ? '+' : '−') + Math.abs(diff) + ')';
    const track = el('div', 'dd-bar-track', row);
    (el('i', '', track) as HTMLElement).style.width = me.ratings[k] + '%';
    const over = el('i', 'over', track) as HTMLElement;
    over.style.width = '0%';
    void over;
  }

  const pick = el('div', 'dm-actions', middle);
  for (const row of market.filter((r) => !r.isPlayer).slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost' + (row.driver.id === themId ? ' primary' : '');
    b.textContent = row.driver.lastName;
    b.addEventListener('click', () => opts.onCompareTo(row.driver.id));
    pick.appendChild(b);
  }
  const toMarket = document.createElement('button');
  toMarket.type = 'button';
  toMarket.className = 'btn ghost';
  toMarket.textContent = 'The whole market';
  toMarket.addEventListener('click', opts.routes.market);
  pick.appendChild(toMarket);

  compareCard(grid, them.driver, them.ratings, them.caps,
    them.marketValueUsd, them.buyoutUsd, career, false);
}

function compareCard(
  parent: HTMLElement, d: WorldDriver, r: DriverRatings, caps: Record<RatingKey, number>,
  value: number, buyout: number, career: Career, mine: boolean,
): void {
  const team = findTeam(career.world, d.teamId);
  const card = el('div', 'dd-cmp-card', parent);
  card.style.setProperty('--edge', mine ? 'var(--sig-red)' : hex(team?.colour ?? 0x5a6673));

  const nat = el('div', 'dd-cmp-nat', card);
  nat.appendChild(nationPlateSvg(d.nationality));
  const names = el('div', '', nat);
  el('div', 'dd-cmp-first', names, d.firstName);
  el('div', 'dd-cmp-last', names, d.lastName);

  const rating = el('div', 'dd-cmp-rating', card);
  rating.textContent = 'RATING ' + r.rtg;

  const attrs = el('div', 'dd-cmp-attrs', card);
  for (const k of ['exp', 'rac', 'awa', 'pac'] as RatingKey[]) {
    const head = Math.max(0, caps[k] - r[k]);
    const line = el('div', 'dd-cmp-attr' + (head > 0 ? ' gain' : ''), attrs);
    el('div', 'dd-cmp-attr-delta', line, head > 0 ? '+' + head : '—');
    el('div', 'dd-cmp-attr-name', line, title(RATING_CODE[k]));
    el('div', 'dd-cmp-attr-value', line, String(r[k]));
  }
  const foc = el('div', 'dd-cmp-foc', card);
  el('div', 'dd-cmp-attr-delta', foc, '');
  el('div', 'dd-cmp-attr-name', foc, 'Foc');
  el('div', 'dd-cmp-attr-value', foc, String(r.foc));

  const money$ = el('div', 'dd-cmp-money', card);
  const v = el('div', 'dd-cmp-value', money$);
  v.textContent = money(value);
  el('span', '', v, 'Market Value');
  const pair = el('div', 'dd-cmp-pair', money$);
  pairFig(pair, money(d.salaryUsd), 'Base Salary');
  pairFig(pair, money(buyout), 'Buyout');

  el('div', 'dd-why', card, RATING_EFFECT.pac);
}

function pairFig(parent: HTMLElement, value: string, label: string): void {
  const box = el('div', '', parent);
  el('div', 'dd-cmp-pair-fig', box, value);
  el('div', 'dd-cmp-pair-label', box, label);
}

/**
 * The pentagon.
 *
 * `87.png` draws a five-sided web with four of its vertices labelled — AWA at
 * the top, PAC right, EXP bottom, RAC left. The fifth is the driver's focus,
 * which the frame shows separately as a chip. This draws all five vertices and
 * labels the four the frame labels, so the shape is the frame's shape and no
 * axis is unaccounted for.
 */
function radar(mine: DriverRatings, theirs: DriverRatings): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const S = 280;
  const c = S / 2;
  const R = S * 0.36;
  const AXES: { key: RatingKey; label: string | null }[] = [
    { key: 'awa', label: 'AWA' },
    { key: 'pac', label: 'PAC' },
    { key: 'exp', label: 'EXP' },
    { key: 'foc', label: null },
    { key: 'rac', label: 'RAC' },
  ];
  const point = (i: number, v: number): [number, number] => {
    const a = -Math.PI / 2 + (i / AXES.length) * Math.PI * 2;
    const r = (Math.max(4, v) / 100) * R;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r];
  };
  const poly = (r: DriverRatings): string =>
    AXES.map((ax, i) => point(i, r[ax.key]).map((n) => n.toFixed(1)).join(' ')).join(' L ');

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('class', 'dd-radar');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Attribute comparison');

  let out = '';
  for (const ring of [1, 0.66, 0.33]) {
    const d = AXES.map((_, i) => point(i, ring * 100).map((n) => n.toFixed(1)).join(' ')).join(' L ');
    out += `<path class="dd-radar-web" d="M ${d} Z"/>`;
  }
  for (let i = 0; i < AXES.length; i++) {
    const [x, y] = point(i, 100);
    out += `<line class="dd-radar-web" x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  }
  out += `<path class="dd-radar-them" d="M ${poly(theirs)} Z"/>`;
  out += `<path class="dd-radar-me" d="M ${poly(mine)} Z"/>`;
  for (const [i, ax] of AXES.entries()) {
    if (!ax.label) continue;
    const [x, y] = point(i, 122);
    out += `<circle cx="${point(i, 104)[0].toFixed(1)}" cy="${point(i, 104)[1].toFixed(1)}" `
      + `r="5" fill="#e6edf6"/>`
      + `<text class="dd-radar-label" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" `
      + `text-anchor="middle">${ax.label}</text>`;
  }
  svg.innerHTML = out;
  return svg;
}

// ===========================================================================

function title(code: string): string {
  return code.charAt(0) + code.slice(1).toLowerCase();
}

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
