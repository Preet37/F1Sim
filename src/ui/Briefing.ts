import './briefing.css';
import type { Career } from '../career/Career';
import type { Decision, Story } from '../career/Newsroom';

/**
 * WHAT JUST HAPPENED, AND WHAT YOU ARE BEING ASKED TO DECIDE.
 *
 * Two blocks, and between them they answer the two questions the career mode
 * was failing to answer at all. They go at the TOP of a screen, above the
 * instruments, because a management screen that opens on nine figures and no
 * next action is one people close.
 *
 * WHY THE DECISIONS COME FIRST AND THE NEWS SECOND. A player arriving at the hub
 * wants to know what to do more than what happened — the result is already known
 * from the race they just drove. Reversing the two was the first thing tried and
 * it read as a newspaper with a job list underneath it.
 *
 * Both are pure renderers over `src/career/Newsroom.ts`, which derives every
 * line from state that already exists. Nothing on this screen is authored copy
 * about an event that did not occur.
 */

export interface BriefingRoutes {
  hub?: () => void;
  hq?: () => void;
  market?: () => void;
  engine?: () => void;
  livery?: () => void;
  prep?: () => void;
}

/**
 * The open decisions, most urgent first.
 *
 * When there are none it says so rather than rendering nothing, because an empty
 * space where a list was is indistinguishable from a list that failed to load.
 */
export function decisionList(
  parent: HTMLElement, career: Career, routes: BriefingRoutes,
): void {
  const decisions = career.decisions();
  if (decisions.length === 0) {
    el('div', 'decisions-clear', parent,
      'Nothing is waiting on you. The factory is busy, the money is fine, and '
      + 'the next thing to do is drive.');
    return;
  }

  const list = el('div', 'decisions', parent);
  for (const d of decisions) {
    const row = el('div', 'decision ' + d.urgency, list);
    const text = el('div', 'decision-text', row);
    el('div', 'decision-label', text, d.label);
    el('div', 'decision-why', text, d.why);

    const go = routes[d.screen];
    if (go) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'decision-go';
      b.textContent = labelFor(d);
      b.addEventListener('click', go);
      row.appendChild(b);
    }
  }
}

/** The verb on the button, which names the screen it opens. */
function labelFor(d: Decision): string {
  switch (d.screen) {
    case 'hq': return 'The factory';
    case 'market': return 'The market';
    case 'engine': return 'Suppliers';
    case 'livery': return 'Paint shop';
    case 'prep': return 'Prepare';
    default: return 'Open';
  }
}

/**
 * The feed.
 *
 * `limit` exists because the paddock generates more true statements than anybody
 * wants to read: on a hub the useful number is about six, and on a dedicated
 * screen it is all of them. Ordered by weight rather than by time, so the thing
 * that matters most is the thing at the top.
 */
export function newsFeed(
  parent: HTMLElement, career: Career, limit = 8,
): void {
  const stories = career.stories();
  if (stories.length === 0) return;

  const weight = (s: Story): number =>
    s.weight === 'lead' ? 0 : s.weight === 'story' ? 1 : 2;
  const ordered = stories.slice().sort((a, b) =>
    weight(a) - weight(b) || (a.mine === b.mine ? 0 : a.mine ? -1 : 1));

  const feed = el('div', 'news', parent);
  for (const s of ordered.slice(0, limit)) {
    const item = el('div',
      'newsitem k-' + s.kind + (s.mine ? ' mine' : '') + ' ' + s.weight, feed);
    el('div', 'newsitem-kind', item, KIND_LABEL[s.kind]);
    const body = el('div', 'newsitem-body', item);
    el('div', 'newsitem-head', body, s.headline);
    if (s.detail) el('div', 'newsitem-detail', body, s.detail);
  }
}

/** The column on the left of every line. Six words at most, all of them nouns. */
const KIND_LABEL: Record<Story['kind'], string> = {
  result: 'Result',
  championship: 'Standings',
  factory: 'Factory',
  money: 'Money',
  transfer: 'Paddock',
  departure: 'Paddock',
  rival: 'Elsewhere',
  warning: 'Warning',
};

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
