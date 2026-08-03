import './frontend.css';
import { button, el, helmetChip } from './frontendKit';
import type { DriverProfile } from '../profile/ProfileStore';

/**
 * THE FRONT PAGE.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPLACES, AND WHY THAT ONE WAS WRONG
 * ---------------------------------------------------------------------------
 *
 * The old front page was a column of six list rows and a grid of eleven
 * circuit cards on a scrolling page, with a car behind it. Everything on it
 * was true and none of it was a front page: it opened on a table of contents,
 * it scrolled, and it greeted the player by a name that had come out of a form
 * they filled in a year ago as though they had signed in somewhere.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 *
 * One screenful, in four bands, and it never scrolls:
 *
 *   WHO      the identity chip, top left, with the player's own helmet on it.
 *            It is a button, because being able to stop being this person is
 *            the thing the front page was missing.
 *   WHAT     the wordmark, centred, sheared eight degrees like every nameplate
 *            in this game and every pit-lane sign in the sport.
 *   THE CAR  a hole in the middle of the interface, through which a real,
 *            lit, turning car is rendered by `CarStage` — standing in a rig of
 *            coloured light built from the player's own helmet colours.
 *   DO       four grid slots, and under each one a figure read from the save.
 *
 * The calendar moved to Quick Race, where choosing a circuit is the question
 * being asked. On the front page it was eleven cards of furniture below the
 * fold that nobody scrolled to.
 *
 * `.menu-item` keeps its class name because the browser regression clicks it
 * by name, and a button that a test can no longer find is a button that can
 * silently stop working.
 */

export interface MenuTile {
  /** The label. `Continue` and `Start Career` are load-bearing: the browser
   *  regression clicks them by text. */
  name: string;
  /** One figure out of the save. Not a tagline. */
  figure: string;
  /** What it does, for a screen reader and for the tooltip. */
  description: string;
  /** Exactly one tile is the lead. It is lit from the start. */
  lead?: boolean;
  onSelect: () => void;
}

export interface MenuLink {
  label: string;
  /** An inline SVG path, drawn at 24x24. */
  icon?: string;
  onSelect: () => void;
}

export interface MainMenuSpec {
  /** Who is playing, or null on a first run before anybody exists. */
  profile: DriverProfile | null;
  /** The line under the name: their code, number and where their career is. */
  standing: string;
  /** Opens the drivers rack. */
  onIdentity: () => void;
  onSettings: () => void;
  tiles: MenuTile[];
  links: MenuLink[];
  version: string;
  /** Shown when storage is blocked, and only then. */
  warning?: string;
  /** The lower third, under the car. Two lines: a label and a sentence. */
  blurb: { label: string; text: string };
}

export function buildMainMenu(root: HTMLElement, spec: MainMenuSpec): void {
  root.classList.add('mm');

  // --- Who, what, and the way out ----------------------------------------
  const top = el('div', 'mm-top', root);

  const chip = button('idchip', top, spec.onIdentity);
  chip.setAttribute('aria-label', spec.profile
    ? 'Playing as ' + spec.profile.firstName + ' ' + spec.profile.lastName
      + '. Switch or add a driver.'
    : 'No driver on this device. Create one.');
  if (spec.profile) {
    helmetChip(chip, spec.profile.helmet, 'idchip');
  } else {
    // The empty slot. A dashed ring rather than a stock avatar, because a
    // placeholder face is a lie about there being somebody there.
    const art = el('span', 'idchip-art', chip);
    art.style.boxShadow = '0 0 0 1px var(--line-2) inset';
    art.textContent = '+';
    art.style.font = '700 18px var(--font-data)';
    art.style.color = 'var(--ink-3)';
  }
  const text = el('div', 'idchip-text', chip);
  el('div', 'idchip-name', text,
    spec.profile ? spec.profile.firstName + ' ' + spec.profile.lastName : 'No driver yet');
  const line = el('div', 'idchip-line', text);
  if (spec.profile) {
    el('b', '', line, spec.profile.code);
    el('span', 'sep', line, '·');
    line.append(document.createTextNode('#' + spec.profile.raceNumber));
    el('span', 'sep', line, '·');
    line.append(document.createTextNode(spec.standing));
  } else {
    line.textContent = 'Tap to make one';
  }

  const title = el('div', 'mm-title', top);
  title.append(document.createTextNode('F1'));
  el('i', '', title, 'SIM');
  el('u', '', title, 'Formula Simulation');

  const right = el('div', 'mm-right', top);
  el('div', 'mm-version', right, spec.version);
  const gear = button('mm-gear', right, spec.onSettings);
  gear.setAttribute('aria-label', 'Settings');
  gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M12 2.6v2.1M12 19.3v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5'
    + 'M2.6 12h2.1M19.3 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5"/></svg>';

  // --- The car ------------------------------------------------------------
  // Empty on purpose: the car is a GL canvas behind the whole screen, and this
  // is the gap in the interface it is seen through.
  const hero = el('div', 'mm-hero', root);
  const blurb = el('div', 'mm-blurb', hero);
  el('b', '', blurb, spec.blurb.label);
  blurb.append(document.createTextNode(spec.blurb.text));

  if (spec.warning) el('div', 'mm-warn', hero, spec.warning);

  // --- The four grid slots ------------------------------------------------
  const tiles = el('div', 'mm-tiles', root);
  for (const t of spec.tiles) {
    const b = button('menu-item' + (t.lead ? ' lead' : ''), tiles, t.onSelect);
    b.title = t.description;
    el('span', 'menu-name', b, t.name);
    el('span', 'menu-fig', b, t.figure);
    el('span', 'menu-desc', b, t.description);
  }

  // --- Everything else ----------------------------------------------------
  const second = el('div', 'mm-second', root);
  for (const l of spec.links) {
    const b = button('mm-link', second, l.onSelect);
    if (l.icon) {
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + l.icon + '</svg>';
    }
    b.append(document.createTextNode(l.label));
  }
}

/** The icons the secondary row uses. Drawn, never downloaded. */
export const MENU_ICONS = {
  drivers: '<circle cx="12" cy="8" r="3.4"/><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>'
    + '<path d="M8 5v14M16 5v14M3 12h18"/>',
  paddock: '<path d="M3 20V8l9-4 9 4v12"/><path d="M9 20v-6h6v6"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4.2-5.4"/>',
} as const;
