import './frontend.css';
import { hex, type HelmetDesign } from '../career/Identity';
import { driverPortraitSvg } from './DriverPortrait';
import type { DriverProfile } from '../profile/ProfileStore';

/**
 * The small shared pieces of the front of house.
 *
 * Three screens — the menu, the drivers rack and the settings — are built from
 * the same handful of parts, and a slider that behaves differently on two of
 * them is the sort of thing nobody reports and everybody notices. So the parts
 * live here, once.
 *
 * Everything below returns a real element rather than a string of markup. None
 * of the values that reach these functions is trusted: a driver's name was
 * typed by a person and a helmet colour came out of a file that can be
 * hand-edited, and neither is going anywhere near `innerHTML`.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent: HTMLElement, text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export function button(
  cls: string, parent: HTMLElement, onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

/**
 * Publishes the player's own colours onto a screen.
 *
 * THE ONE PLACE `--me` IS SET, so a screen cannot end up half lit. Passing
 * null puts the front end back to the unlit tungsten it wears before there is
 * anybody to light it for — which is what a genuine first run looks like.
 */
export function applyIdentityColours(root: HTMLElement, helmet: HelmetDesign | null): void {
  if (!helmet) {
    root.style.removeProperty('--me');
    root.style.removeProperty('--me-2');
    return;
  }
  root.style.setProperty('--me', hex(helmet.base));
  root.style.setProperty('--me-2', hex(helmet.stripe));
}

/**
 * The two colours the light rig behind the car is built from.
 *
 * The shell and the pattern, unless they are the same colour — a plain helmet
 * in one pigment would give a rig of one colour and no depth at all — in which
 * case the trim stands in for the second.
 */
export function rigColours(helmet: HelmetDesign | null): number[] {
  if (!helmet) return [];
  const second = helmet.stripe === helmet.base ? helmet.trim : helmet.stripe;
  return [helmet.base, second];
}

/** The helmet, at chip size, in a lit disc. */
export function helmetChip(parent: HTMLElement, helmet: HelmetDesign, uid: string): HTMLElement {
  const art = el('span', 'idchip-art', parent);
  art.appendChild(driverPortraitSvg(helmet, { bust: false, uid }));
  return art;
}

/**
 * A driver's name in the broadcast register: given name light, surname heavy.
 *
 * The same treatment as the timing row and the signing screen, because they
 * are the same person and a name that is set three ways is three people.
 */
export function nameBlock(parent: HTMLElement, cls: string, p: {
  firstName: string; lastName: string;
}): HTMLElement {
  const box = el('div', cls, parent);
  el('i', '', box, p.firstName);
  el('b', '', box, p.lastName.toUpperCase());
  return box;
}

/** An on/off row. Returns nothing; the caller repaints. */
export function optSwitch(parent: HTMLElement, spec: {
  name: string; note?: string; value: boolean; onChange: (v: boolean) => void;
}): void {
  const row = el('div', 'opt', parent);
  const label = el('div', 'opt-label', row);
  el('div', 'opt-name', label, spec.name);
  if (spec.note) el('div', 'opt-note', label, spec.note);
  const control = el('div', 'opt-control', row);
  const pip = button('opt-pip', control, () => spec.onChange(!spec.value));
  pip.setAttribute('role', 'switch');
  pip.setAttribute('aria-checked', spec.value ? 'true' : 'false');
  pip.setAttribute('aria-label', spec.name);
  el('div', 'opt-state', control, spec.value ? 'On' : 'Off');
}

/** A row of two to four named values, one of them chosen. */
export function optChoice<T extends string>(parent: HTMLElement, spec: {
  name: string; note?: string; value: T;
  options: readonly { id: T; label: string; note?: string }[];
  onChange: (v: T) => void;
}): void {
  const row = el('div', 'opt', parent);
  const label = el('div', 'opt-label', row);
  el('div', 'opt-name', label, spec.name);
  const chosen = spec.options.find((o) => o.id === spec.value);
  // The note under the label describes the CHOSEN value where the options
  // carry their own descriptions, so the explanation is of what is actually
  // set rather than of the whole list.
  const note = chosen?.note ?? spec.note;
  if (note) el('div', 'opt-note', label, note);
  const control = el('div', 'opt-control', row);
  const strip = el('div', 'opt-choices', control);
  for (const o of spec.options) {
    const b = button('opt-choice' + (o.id === spec.value ? ' on' : ''), strip,
      () => spec.onChange(o.id));
    b.textContent = o.label;
    b.setAttribute('aria-pressed', o.id === spec.value ? 'true' : 'false');
  }
}

/**
 * A slider with the value in the handle.
 *
 * `onInput` fires while the thumb is moving so the thing being adjusted
 * responds — a volume that only changes when you let go is unusable — and
 * `onCommit` fires once at the end, which is where a save belongs. Repainting
 * the whole screen on every pixel of a drag would destroy the element being
 * dragged, which is exactly what the old settings screen did to its inputs.
 */
export function optSlider(parent: HTMLElement, spec: {
  name: string; note?: string;
  value: number; min: number; max: number; step: number;
  /** Turns the raw number into what goes in the handle. */
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
}): void {
  const row = el('div', 'opt', parent);
  const label = el('div', 'opt-label', row);
  el('div', 'opt-name', label, spec.name);
  if (spec.note) el('div', 'opt-note', label, spec.note);
  const control = el('div', 'opt-control', row);
  const box = el('div', 'opt-slider', control);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  input.setAttribute('aria-label', spec.name);
  box.appendChild(input);
  const readout = el('b', '', box);

  const paint = (v: number) => {
    const pct = (v - spec.min) / Math.max(1e-6, spec.max - spec.min);
    box.style.setProperty('--pct', (pct * 100).toFixed(2) + '%');
    readout.textContent = spec.format ? spec.format(v) : String(Math.round(v));
    input.setAttribute('aria-valuetext', readout.textContent);
  };
  paint(spec.value);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    spec.onInput(v);
  });
  for (const ev of ['change', 'pointerup', 'keyup'] as const) {
    input.addEventListener(ev, () => spec.onCommit(Number(input.value)));
  }
}

/** A block of prose or a device readout inside a settings panel. */
export function optBlock(parent: HTMLElement, spec: {
  head: string; line: string; note?: string;
}): HTMLElement {
  const box = el('div', 'opt-block', parent);
  el('div', 'opt-block-head', box, spec.head);
  el('div', 'opt-block-line', box, spec.line);
  if (spec.note) el('div', 'opt-block-note', box, spec.note);
  return box;
}

/**
 * How a career reads in one line: the tier, the year and the round.
 *
 * Shared so the menu tile, the drivers rack and the career list all describe
 * the same save the same way.
 */
export function careerLine(c: {
  tier: string; seasonYear: number; round: number;
}, tierName: (t: string) => string): string {
  return tierName(c.tier) + ' · ' + c.seasonYear + ' · Round ' + (c.round + 1);
}

/** "3 wins", "1 win", "No wins" — never "1 wins" and never a bare zero. */
export function count(n: number, one: string, many: string, none: string): string {
  if (n <= 0) return none;
  return n + ' ' + (n === 1 ? one : many);
}

/** A driver's record as label/value pairs, for the rack and the chip. */
export function recordCells(r: {
  starts: number; wins: number; podiums: number; poles: number;
  bestFinish: number; titles: number;
}): { label: string; value: string; none: boolean }[] {
  return [
    { label: 'Starts', value: String(r.starts), none: r.starts === 0 },
    { label: 'Wins', value: String(r.wins), none: r.wins === 0 },
    { label: 'Podiums', value: String(r.podiums), none: r.podiums === 0 },
    {
      label: 'Best',
      value: r.bestFinish > 0 ? 'P' + r.bestFinish : '—',
      none: r.bestFinish === 0,
    },
    { label: 'Titles', value: String(r.titles), none: r.titles === 0 },
  ];
}

/** The line under a driver's name on the identity chip. */
export function profileLine(
  p: DriverProfile, current: { tier: string; round: number } | null,
  tierName: (t: string) => string,
): { code: string; number: number; where: string } {
  return {
    code: p.code,
    number: p.raceNumber,
    where: current ? tierName(current.tier) + ' · R' + (current.round + 1) : 'No career',
  };
}
