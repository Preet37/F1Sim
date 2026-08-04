import './driver.css';
import './people/people.css';
import { figureSvg } from './people/Figure';
import { lookFor } from './people/Look';
import {
  RATING_CODE, RATING_KEYS, RATING_NAME, levelToPoints,
  type DriverRatings, type RatingKey,
} from '../career/DriverRatings';

/**
 * THE RATINGS REVEAL — `reference/target/86.png`.
 *
 * The screen the whole of #77 is about, and the one that would have been
 * easiest to build as a lie. It is five numbers and a delta; every one of them
 * comes from `Career.ratingsReveal()`, which is `src/career/DriverRatings.ts`
 * projecting the same `WorldDriver` record the race engine is about to put on
 * a grid. Nothing here computes a rating, and `probe:ratings` §6 proves it by
 * refusing any file in `src/ui/` that reads a raw driver attribute.
 *
 * WHAT IS COPIED FROM THE FRAME, ITEM BY ITEM:
 *
 *   · The row of chevrons over an outlined `RATINGS` title, top centre, with
 *     the reached ones solid and the rest hollow — it is a progress marker
 *     through a sequence of end-of-weekend screens.
 *   · `99` in a size nothing else comes near, then `RTG` and `Overall Rating`
 *     stacked beside it, over a green rule.
 *   · Five rows: the three-letter code big, the word underneath it, the delta
 *     in green on the right of the middle column, `4856 / 4856` under that,
 *     and the value at the right in the second-largest size on the screen.
 *   · A thin progress line under each row's figures.
 *   · The driver, full height, hard left, at the height of the panel.
 *
 * WHAT IS NOT: the face. `86.png` is a likeness of a real driver and
 * PROJECT.md §3 permits real names as data and no reproduced likeness, so the
 * figure is `figureSvg` — the same body #22 built and the same one that stands
 * on the podium. The name beside it is real; the face approximates nobody.
 */

export interface RevealSpec {
  now: DriverRatings;
  previous: DriverRatings | null;
  caps: Record<RatingKey, number>;
  /** Change in development points since the last reveal. */
  deltaPoints: Record<RatingKey, number>;
  firstName: string;
  lastName: string;
  driverId: string;
  teamName: string;
  /** Team colours for the suit. */
  colour: string;
  accent: string;
  /** Round and calendar length, for the chevron strip. */
  round: number;
  rounds: number;
}

export function buildRatingsReveal(parent: HTMLElement, spec: RevealSpec): HTMLElement {
  const wrap = el('div', 'rv', parent);

  // --- The figure, hard left ------------------------------------------------
  const art = el('div', 'rv-art', wrap);
  const fig = figureSvg(lookFor(spec.driverId, 'driver'), {
    uid: 'rv-' + spec.driverId,
    suit: spec.colour,
    accent: spec.accent,
    team: spec.colour,
    pose: 'standing',
    sponsors: true,
  });
  fig.setAttribute('class', 'person-figure');
  art.appendChild(fig);

  const panel = el('div', '', wrap);

  // --- The chevron strip and the outlined title -----------------------------
  const chevrons = el('div', 'rv-chevrons', panel);
  const marks = Math.max(1, Math.min(9, spec.rounds));
  const lit = Math.max(1, Math.round((spec.round / Math.max(1, spec.rounds)) * marks));
  for (let i = 0; i < marks; i++) el('i', i < lit ? 'on' : '', chevrons);
  el('div', 'rv-title', panel, 'Ratings');

  // --- The overall ----------------------------------------------------------
  const overall = el('div', 'rv-overall', panel);
  el('div', 'rv-overall-fig', overall, String(spec.now.rtg));
  const oText = el('div', '', overall);
  el('div', 'rv-overall-code', oText, 'RTG');
  el('div', 'rv-overall-name', oText, 'Overall Rating');

  // --- The five -------------------------------------------------------------
  const rows = el('div', 'rv-rows', panel);
  for (const k of RATING_KEYS) {
    const row = el('div', 'rv-row', rows);

    const left = el('div', '', row);
    el('div', 'rv-code', left, RATING_CODE[k]);
    el('div', 'rv-name', left, RATING_NAME[k]);

    const mid = el('div', 'rv-mid', row);
    const d = spec.deltaPoints[k];
    // The reference prints `+8,171` with a thousands separator and `+0` when
    // nothing moved, in grey rather than green — a delta of zero is not a gain
    // and colouring it as one is how a screen starts congratulating people for
    // standing still.
    const delta = el('div', 'rv-delta' + (d > 0 ? '' : d < 0 ? ' down' : ' none'), mid);
    delta.textContent = (d > 0 ? '+' : d < 0 ? '−' : '+') + group(Math.abs(d));

    const cap = Math.max(1, levelToPoints(spec.caps[k]));
    const at = Math.min(cap, levelToPoints(spec.now[k]));
    const points = el('div', 'rv-points', mid);
    points.innerHTML = '<b>' + group(at) + '</b> / ' + group(cap);

    const was = spec.previous ? spec.previous[k] : spec.now[k];
    const value = el('div', 'rv-value' + (spec.now[k] > was ? ' up' : ''), row);
    value.textContent = String(spec.now[k]);

    // THE TRACK IS THE ROW'S, not the middle column's. `86.png` runs it the
    // whole width under the code, the figures and the value alike.
    const track = el('div', 'rv-track', row);
    (el('i', '', track) as HTMLElement).style.width = ((at / cap) * 100).toFixed(1) + '%';
  }

  return wrap;
}

/** `8171` -> `8,171`. The reference's own separator. */
function group(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
