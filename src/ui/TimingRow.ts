import { teamMarkSvg } from './Hud';

/**
 * The timing row: the unit every ranked list in this game is built out of.
 *
 *     ▐  P   (●)   Viktor HALVORSEN        26      —      2×
 *                  Apex Racing
 *
 * A livery bar, a position, the team's own generated mark, the driver's name
 * with the surname carrying the weight, their team beneath it, then figures in
 * right-aligned monospaced columns whose digits line up down the page.
 * Everything in this sport is a ranked order, so everything in these menus is
 * a list of these — a grid of cards would throw the order away, which is the
 * one thing the order is for.
 *
 * WHY IT CHANGED. The row used to be `P ▐ CODE NAME · fig fig tag`: a
 * three-letter abbreviation and one line of name, identical whether it was
 * carrying a championship, a race classification or a list of circuits. That
 * is a row for somebody who has already memorised twenty drivers. The in-race
 * running order was rebuilt around the broadcast row first, and leaving these
 * boards behind meant the order you read at 300km/h and the order you read
 * thirty seconds later were two different graphics about the same twenty
 * people. They are one graphic at two sizes now.
 *
 * The three-letter code is demoted rather than dropped: on a driver row the
 * mark and the surname carry the identification, and on the boards that are
 * NOT driver lists — the season's form, where the "code" is a country — it
 * still prints, in the mark's slot, because that is what that column means
 * there.
 *
 * WHY THIS IS A MODULE and not three private methods on `Game`. The panel
 * harness photographs these boards, and a harness that reproduces the markup
 * is a harness that agrees with itself: the shots would keep looking right
 * through any change that broke the real screen. Reaching `Game` means booting
 * a career, a renderer and an audio engine to look at a stylesheet, so the row
 * moved out to where both can have it. The pictures are of the real thing.
 */

export interface TimingRowSpec {
  pos?: string;
  colour?: string;
  code?: string;
  name: string;
  note?: string;
  /** The team, for the generated mark. Driver rows only. */
  team?: { id: string; colour: number; accent: number };
  /** Given name, set light. Falls back to `name` when absent. */
  first?: string;
  /** Surname, set heavy and in capitals. */
  last?: string;
  /** Right-aligned figures. `cls` is one of dim/best/gain/loss/out/none. */
  figs?: { text: string; cls?: string }[];
  tag?: { text: string; cls?: string };
  state?: 'me' | 'selected' | 'out' | 'best' | 'through' | 'knocked';
  index?: number;
  onClick?: () => void;
}

export function timingRow(parent: HTMLElement, r: TimingRowSpec): HTMLElement {
  const row = document.createElement(r.onClick ? 'button' : 'div');
  row.className = 'trow' + (r.state ? ' is-' + r.state : '');
  if (r.index !== undefined) row.style.setProperty('--i', String(r.index));
  if (r.onClick) (row as HTMLButtonElement).type = 'button';

  let html = '<span class="t-bar"' +
    (r.colour ? ' style="background:' + escapeHtml(r.colour) + '"' : '') + '></span>';
  html += '<span class="t-pos">' + escapeHtml(r.pos ?? '') + '</span>';
  // The mark cell carries a drawn badge on a driver row and a short code on the
  // boards where that column means something else. Either way the cell exists,
  // so the columns beside it cannot shift between boards.
  html += '<span class="t-mark">' +
    (r.team ? '' : '<span class="t-code">' + escapeHtml(r.code ?? '') + '</span>') +
    '</span>';

  html += '<span class="t-who">';
  if (r.last) {
    html += '<span class="t-name">' +
      (r.first ? '<i class="t-first">' + escapeHtml(r.first) + '</i>' : '') +
      '<b class="t-last">' + escapeHtml(r.last) + '</b></span>';
  } else {
    html += '<span class="t-name"><b class="t-last plain">' + escapeHtml(r.name) + '</b></span>';
  }
  if (r.note) html += '<span class="t-team">' + escapeHtml(r.note) + '</span>';
  html += '</span>';

  for (const f of r.figs ?? []) {
    html += '<span class="t-fig ' + (f.cls ?? '') + '">' + escapeHtml(f.text) + '</span>';
  }
  // Keep the grid's column count stable whether or not a row has figures.
  for (let i = (r.figs ?? []).length; i < 2; i++) html += '<span class="t-fig"></span>';
  html += r.tag
    ? '<span class="t-tag"><span class="tag ' + (r.tag.cls ?? '') + '">' +
      escapeHtml(r.tag.text) + '</span></span>'
    : '<span class="t-tag"></span>';
  row.innerHTML = html;

  // The mark is appended as SVG rather than written into the markup above, so
  // nothing that came out of a career save is ever interpolated as HTML.
  if (r.team) {
    const mark = row.querySelector('.t-mark');
    if (mark) mark.appendChild(teamMarkSvg(r.team));
  }

  if (r.onClick) row.addEventListener('click', r.onClick);
  parent.appendChild(row);
  return row;
}

/** A board: a column header, then rows. */
export function timingBoard(parent: HTMLElement, cols: string[]): HTMLElement {
  const b = div('tboard', parent);
  const head = div('tboard-head', b);
  head.innerHTML =
    '<span></span>' +
    '<span>' + escapeHtml(cols[0] ?? '') + '</span>' +
    '<span></span>' +
    '<span>' + escapeHtml(cols[1] ?? '') + '</span>' +
    '<span class="t-fig">' + escapeHtml(cols[2] ?? '') + '</span>' +
    '<span class="t-fig">' + escapeHtml(cols[3] ?? '') + '</span>' +
    '<span class="t-tag">' + escapeHtml(cols[4] ?? '') + '</span>';
  return b;
}

/**
 * The cut line.
 *
 * Knockout qualifying has a fact in it that a ranked list cannot express: the
 * boundary between the cars that go through and the cars whose weekend has
 * just been decided. On a real timing screen it is a line across the board, so
 * it is a line across the board here — labelled, because a rule on its own
 * tells you only that something happens here and not what.
 */
export function cutLine(parent: HTMLElement, label: string, past = false): HTMLElement {
  const cut = div('tcut' + (past ? ' past' : ''), parent);
  div('tcut-rule', cut);
  const l = div('tcut-label', cut);
  l.textContent = label;
  div('tcut-rule', cut);
  return cut;
}

/**
 * The segment strip: which part of qualifying this was, and where it sits in
 * the three.
 *
 * The sector rule under every page header already carries "how far through the
 * lap"; this carries "how far through the session", which is a fact a knockout
 * format has and a practice session does not. Without it a Q2 classification
 * and a Q3 classification are the same screen with different numbers on it.
 */
export function qualifyingStrip(parent: HTMLElement, phase: 1 | 2 | 3): HTMLElement {
  const strip = div('qstrip', parent);
  for (const q of [1, 2, 3] as const) {
    const seg = div('qstrip-seg' + (q < phase ? ' done' : q === phase ? ' live' : ''), strip);
    const name = div('qstrip-name', seg);
    name.textContent = 'Q' + q;
    const note = div('qstrip-note', seg);
    note.textContent = q < phase ? 'complete' : q === phase ? 'just run' : 'to come';
  }
  return strip;
}

/**
 * Splits a display name into a given name and a surname.
 *
 * The championship holds names as one string — the career's own `displayName`,
 * which for the player is whatever they typed — so the broadcast row has to
 * take them apart to set the surname heavy. Everything before the last space
 * is the given name; a single word is all surname, which is the right answer
 * for a mononym and for an initialised name alike.
 */
export function splitName(full: string): { first: string; last: string } {
  const at = full.trim().lastIndexOf(' ');
  if (at <= 0) return { first: '', last: full.trim().toUpperCase() };
  return { first: full.slice(0, at), last: full.slice(at + 1).toUpperCase() };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function div(cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}
