import './driver.css';
import './people/people.css';
import { escapeHtml } from './TimingRow';
import { nationPlateSvg } from './DriverPortrait';
import { figureSvg } from './people/Figure';
import { lookFor } from './people/Look';
import { hex } from './LiveryEditor';
import type { Career } from '../career/Career';
import { findTeam } from '../career/World';
import {
  ACCLAIM_MAX, RATING_CODE,
  type MarketEntry, type MarketSort, type RatingKey,
} from '../career/DriverRatings';

/**
 * THE DRIVER MARKET — `reference/target/88.png`.
 *
 * ===========================================================================
 * WHY THERE IS ONLY ONE OF THESE
 * ===========================================================================
 *
 * There was already a driver market: `TeamHQ.driverMarket`, the My Team
 * signing screen, a `timingBoard` of twelve rows printing `skill × 100` in a
 * column headed "Pace". It was one of the four places `probe:ratings` §6 found
 * a screen inventing its own rating out of a raw attribute, and it is not
 * `88.png`.
 *
 * Building the reference's table beside it would have left the game with two
 * driver markets disagreeing about what a driver is worth — which is
 * `TIER_INFO.carPace` and the pit panel's four derivations of one fact, again.
 * So this REPLACES it: one market, reading `Career.market()`, doing both jobs.
 * A driver career opens it to see where they stand; a My Team career opens the
 * same screen and can sign the second car from it.
 *
 * ===========================================================================
 * WHAT IS COPIED
 * ===========================================================================
 *
 *   · The columns and their order: DRIVER, TEAM, ACCLAIM, MKT. VALUE, RATING.
 *   · Sortable headers, with a marker on the one in force.
 *   · The driver cell: nation, forename in sentence case, SURNAME in capitals.
 *   · The team cell: a flash of the team's own colour, then the name.
 *   · Acclaim as a figure and a run of skewed blocks.
 *   · Money as `$10.55m`, lower-case m, two decimals when it needs them.
 *   · The selected row INVERTED — white plate, dark type.
 *   · The player's own row pinned under a red rule at the foot of the table.
 *   · A detail card down the right: nation, name, acclaim, `93 RATING`, the
 *     four attributes with their headroom, `98 Foc` on its own green plate,
 *     market value, base salary, buyout, and the driver at full height.
 *
 * The flags are `nationPlateSvg` and the face is generated; both departures are
 * argued at the head of `driver.css`.
 */

export interface MarketOptions {
  career: Career;
  sort: MarketSort;
  /** Driver id of the selected row. */
  selected: string | null;
  onSort: (sort: MarketSort) => void;
  onSelect: (driverId: string) => void;
  /** Opens the head-to-head comparison against this driver. */
  onCompare: (driverId: string) => void;
  /** Called after a signing, so the caller can persist and repaint. */
  onChange: () => void;
}

const COLUMNS: [MarketSort, string, boolean][] = [
  ['name', 'Driver', false],
  ['team', 'Team', false],
  ['acclaim', 'Acclaim', true],
  ['value', 'Mkt. Value', true],
  ['rating', 'Rating', true],
];

export function buildDriverMarket(parent: HTMLElement, opts: MarketOptions): void {
  const { career } = opts;
  const rows = career.market(opts.sort);
  const me = rows.find((r) => r.isPlayer) ?? null;
  const selected = rows.find((r) => r.driver.id === opts.selected) ?? me ?? rows[0] ?? null;

  const stage = el('div', 'dm-stage', parent);
  const left = el('div', '', stage);

  const table = el('div', 'dm-table', left);
  const head = el('div', 'dm-head', table);
  for (const [key, label, num] of COLUMNS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-col' + (num ? ' num' : '') + (opts.sort === key ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => opts.onSort(key));
    head.appendChild(b);
  }

  for (const row of rows) {
    if (row.isPlayer) continue;
    marketRow(table, row, career, row.driver.id === selected?.driver.id, opts);
  }

  // THE PLAYER'S OWN ROW, PINNED UNDER A RED RULE. `88.png` does exactly this:
  // the same driver appears once in the sorted table and again below the cut,
  // so "where am I in this list" never needs scrolling for.
  if (me) {
    el('div', 'dm-cut', table);
    marketRow(table, me, career, me.driver.id === selected?.driver.id, opts).classList.add('me');
  }

  // --- The card ------------------------------------------------------------
  const cardHost = el('div', '', stage);
  if (selected) marketCard(cardHost, selected, career, opts);
}

function marketRow(
  parent: HTMLElement, row: MarketEntry, career: Career, on: boolean, opts: MarketOptions,
): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dm-row' + (on ? ' on' : '');
  b.addEventListener('click', () => opts.onSelect(row.driver.id));
  parent.appendChild(b);

  const driver = el('div', 'dm-driver', b);
  driver.appendChild(nationPlateSvg(row.driver.nationality));
  const name = el('div', 'dm-driver-name', driver);
  name.innerHTML = escapeHtml(row.driver.firstName) + ' <b>'
    + escapeHtml(row.driver.lastName.toUpperCase()) + '</b>';

  const team = el('div', 'dm-team', b);
  const world = findTeam(career.world, row.driver.teamId);
  const flash = el('span', 'dm-team-flash', team);
  flash.style.setProperty('--team', hex(world?.colour ?? 0x5a6673));
  el('div', 'dm-team-name', team, row.teamName);

  const acclaim = el('div', 'dm-acclaim', b);
  el('div', 'dm-acclaim-fig', acclaim, String(row.acclaim));
  const bar = el('div', 'dm-acclaim-bar', acclaim);
  // Five blocks over a 0..20 scale, so one block is four points of acclaim and
  // the whole grid fits in the width the reference gives it.
  const lit = Math.round((row.acclaim / ACCLAIM_MAX) * 5);
  for (let i = 0; i < 5; i++) el('i', i < lit ? 'on' : '', bar);

  el('div', 'dm-value', b, money(row.marketValueUsd));
  el('div', 'dm-rating', b, String(row.ratings.rtg));
  return b;
}

/**
 * The detail card.
 *
 * The attribute chips carry the HEADROOM to the driver's own cap rather than a
 * change since last week, because that is the number a team signing somebody
 * actually wants: `88.png` shows `+10` beside every attribute on a 21-year-old
 * and the reference's own reading of it is potential. It comes from
 * `Career`'s caps, which are fixed per driver for the whole career — see
 * `capsFor`, and the note there about why the first version of it could never
 * bind.
 */
function marketCard(
  parent: HTMLElement, row: MarketEntry, career: Career, opts: MarketOptions,
): void {
  const card = el('div', 'dm-card', parent);
  const world = findTeam(career.world, row.driver.teamId);
  card.style.setProperty('--edge', hex(world?.colour ?? 0x5a6673));

  const nat = el('div', 'dd-cmp-nat', card);
  nat.appendChild(nationPlateSvg(row.driver.nationality));
  const names = el('div', '', nat);
  el('div', 'dd-cmp-first', names, row.driver.firstName);
  el('div', 'dd-cmp-last', names, row.driver.lastName);

  const acclaim = el('div', 'dm-acclaim', card);
  el('div', 'dm-acclaim-fig', acclaim, String(row.acclaim));
  const bar = el('div', 'dm-acclaim-bar', acclaim);
  const lit = Math.round((row.acclaim / ACCLAIM_MAX) * 5);
  for (let i = 0; i < 5; i++) el('i', i < lit ? 'on' : '', bar);

  const rating = el('div', 'dd-cmp-rating', card);
  rating.textContent = String(row.ratings.rtg);
  el('span', '', rating, 'RATING');

  const attrs = el('div', 'dd-cmp-attrs', card);
  for (const k of ['exp', 'rac', 'awa', 'pac'] as RatingKey[]) {
    const head = Math.max(0, row.caps[k] - row.ratings[k]);
    const line = el('div', 'dd-cmp-attr' + (head > 0 ? ' gain' : ''), attrs);
    el('div', 'dd-cmp-attr-value', line, String(row.ratings[k]));
    el('div', 'dd-cmp-attr-name', line, title(RATING_CODE[k]));
    el('div', 'dd-cmp-attr-delta', line, head > 0 ? '+' + head : '—');
  }
  const foc = el('div', 'dd-cmp-foc', card);
  el('div', 'dd-cmp-attr-value', foc, String(row.ratings.foc));
  el('div', 'dd-cmp-attr-name', foc, 'Foc');
  el('div', 'dd-cmp-attr-delta', foc, focFace(row.ratings.foc));

  const money$ = el('div', 'dd-cmp-money', card);
  const value = el('div', 'dd-cmp-value', money$);
  value.textContent = money(row.marketValueUsd);
  el('span', '', value, 'Market Value');
  const pair = el('div', 'dd-cmp-pair', money$);
  figure(pair, money(row.driver.salaryUsd), 'Base Salary');
  figure(pair, money(row.buyoutUsd), 'Buyout');

  // The figure, at the height the card gives it.
  const art = el('div', 'dd-figure', card);
  const fig = figureSvg(lookFor(row.driver.id, 'driver'), {
    uid: 'dm-' + row.driver.id,
    suit: hex(world?.colour ?? 0x2b3440),
    accent: hex(world?.accent ?? 0xe8e0d0),
    team: hex(world?.colour ?? 0x2b3440),
    pose: 'folded',
    sponsors: true,
  });
  fig.setAttribute('class', 'person-figure');
  art.appendChild(fig);

  const actions = el('div', 'dm-actions', card);
  const reason = el('div', 'dm-reason', card);

  if (!row.isPlayer) {
    action(actions, 'Compare', () => opts.onCompare(row.driver.id));
  }

  // SIGNING, only where signing is a thing. A driver career cannot hire
  // anybody, and a button that says it can is worse than no button.
  const t = career.myTeam;
  if (t && !row.isPlayer && row.driver.id !== t.teammateDriverId) {
    const check = career.canCommit(row.driver.salaryUsd, { underCap: false });
    const b = action(actions, 'Sign for the second car', () => {
      const r = career.signTeammate(row.driver);
      reason.textContent = r.ok
        ? `${row.driver.firstName} ${row.driver.lastName} is in the second car.`
        : r.reason;
      reason.classList.toggle('ok', r.ok);
      if (r.ok) opts.onChange();
    });
    b.disabled = !check.ok;
    if (!check.ok) b.title = check.reason;
  } else if (t && row.driver.id === t.teammateDriverId) {
    reason.textContent = 'Already in your second car.';
  }
}

function figure(parent: HTMLElement, value: string, label: string): void {
  const box = el('div', '', parent);
  el('div', 'dd-cmp-pair-fig', box, value);
  el('div', 'dd-cmp-pair-label', box, label);
}

function action(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost';
  b.textContent = label;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

/**
 * `$10.55m`, the reference's own format.
 *
 * Lower-case `m`, two decimals only where they carry information — `88.png`
 * has `$9m`, `$9.05m` and `$10.55m` in one column, so a fixed two decimals
 * would print `$9.00m` where the frame prints `$9m`.
 */
export function money(usd: number): string {
  const m = usd / 1e6;
  if (usd === 0) return '$0';
  if (m >= 1) {
    const s = m.toFixed(2).replace(/\.?0+$/, '');
    return '$' + s + 'm';
  }
  const k = usd / 1e3;
  return '$' + (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
}

/** A smiling, level or unhappy face for focus, as `87.png` and `88.png` do. */
function focFace(foc: number): string {
  return foc >= 80 ? '☺' : foc >= 55 ? '•' : '☹';
}

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
