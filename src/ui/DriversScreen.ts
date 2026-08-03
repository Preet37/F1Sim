import './frontend.css';
import { button, el, nameBlock, recordCells } from './frontendKit';
import { driverPortraitSvg, nationPlateSvg } from './DriverPortrait';
import { hex } from '../career/Identity';
import type { CareerRecord, CareerSummary, DriverProfile } from '../profile/ProfileStore';

/**
 * THE DRIVERS ON THIS DEVICE.
 *
 * ---------------------------------------------------------------------------
 * THIS IS WHAT "LOG OUT" MEANS HERE, AND THE SCREEN SAYS SO
 * ---------------------------------------------------------------------------
 *
 * The question was: "rn it seems that i am logging in with Preet Karia
 * somehow, but in the future how would we do that... do I need to logout
 * someway or some form?"
 *
 * There is no server. There is no account. Nothing about this game has ever
 * left the device it is played on, and a "Sign out" button on a front end with
 * no session behind it would be a straightforward lie — the sort that costs
 * you the player's trust in everything else the interface tells them.
 *
 * So the two operations offered are the two that are real:
 *
 *   SWITCH DRIVER   stop playing as this person, start playing as that one.
 *   DELETE DRIVER   remove them and every career they ran, from this browser.
 *
 * And the screen states the situation in one sentence at the top rather than
 * making anybody infer it. If an account arrives later, this screen gains a
 * third operation and loses nothing — `ProfileStore` is already the only thing
 * that knows where a driver is kept.
 *
 * ---------------------------------------------------------------------------
 * THE RACK
 * ---------------------------------------------------------------------------
 *
 * One card per driver, each wearing their own helmet, each lit in their own
 * colour, with their record along the bottom. That is deliberately the same
 * furniture the podium and the timing rows use: a driver is a driver whether
 * they are on a rostrum or in a list of save games.
 */

export interface DriverRow {
  profile: DriverProfile;
  record: CareerRecord;
  active: boolean;
}

export interface DriversScreenSpec {
  drivers: DriverRow[];
  /** How a tier id reads. Supplied so this module needs no career import. */
  tierName: (tier: string) => string;
  onPlayAs: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  /** Opens a specific career belonging to a specific driver. */
  onOpenCareer: (profileId: string, careerId: string) => void;
  /** True when nothing written here survives a reload. */
  ephemeral: boolean;
}

export function buildDriversScreen(root: HTMLElement, spec: DriversScreenSpec): void {
  const note = el('div', 'drv-note', root);
  el('b', '', note, 'There is no account, and nothing here leaves this device. ');
  note.append(document.createTextNode(
    spec.ephemeral
      ? 'This browser is also blocking storage, so a driver made now will be gone '
        + 'when the tab closes. Everything else works normally.'
      : 'A driver is stored in this browser along with every career they have run. '
        + 'Switching driver is how you hand the game to somebody else; deleting one '
        + 'removes them and their careers for good.'));

  const rack = el('div', 'drv-rack', root);

  for (const row of spec.drivers) {
    const p = row.profile;
    const card = button('drv-card' + (row.active ? ' on' : ''), rack,
      () => (row.active ? spec.onEdit(p.id) : spec.onPlayAs(p.id)));
    card.style.setProperty('--card-me', hex(p.helmet.base));
    card.style.setProperty('--card-wash',
      'color-mix(in srgb, ' + hex(p.helmet.base) + ' 16%, transparent)');
    card.setAttribute('aria-label',
      (row.active ? 'Currently playing as ' : 'Play as ')
      + p.firstName + ' ' + p.lastName);

    const art = el('div', 'drv-art', card);
    art.appendChild(driverPortraitSvg(p.helmet, { uid: 'rack-' + p.id, number: p.raceNumber }));

    const body = el('div', '', card);
    const code = el('div', 'drv-code', body);
    const plate = nationPlateSvg(p.nationality);
    plate.setAttribute('width', '22');
    plate.style.verticalAlign = '-4px';
    plate.style.marginRight = '7px';
    code.appendChild(plate);
    code.append(document.createTextNode(p.code + ' · #' + p.raceNumber));
    nameBlock(body, 'drv-name', p);

    const stats = el('div', 'drv-stats', body);
    for (const cell of recordCells(row.record)) {
      const s = el('div', 'drv-stat' + (cell.none ? ' none' : ''), stats);
      el('div', 'drv-stat-label', s, cell.label);
      el('div', 'drv-stat-value', s, cell.value);
    }

    // The careers, listed under the driver who ran them. This is the second
    // half of "more than one save": a driver can have several, and every one
    // of them is openable from here rather than only the most recent.
    if (p.careers.length > 0) {
      const list = el('div', 'drv-careers', body);
      for (const c of p.careers) {
        careerRow(list, c, spec.tierName, () => spec.onOpenCareer(p.id, c.id));
      }
    }

    const actions = el('div', 'drv-actions', body);
    if (!row.active) {
      const play = button('btn primary', actions, () => spec.onPlayAs(p.id));
      play.textContent = 'Play as ' + p.firstName;
    } else {
      const edit = button('btn', actions, () => spec.onEdit(p.id));
      edit.textContent = 'Edit driver';
    }
    const del = button('btn danger', actions, () => spec.onDelete(p.id));
    del.textContent = 'Delete';
    // The card itself is a button, so the buttons inside it must not also fire
    // it. Without this, "Delete" would delete the driver AND switch to them.
    for (const b of [...actions.querySelectorAll('button')]) {
      b.addEventListener('click', (e) => e.stopPropagation());
    }
    for (const b of [...(body.querySelectorAll('.drv-career'))]) {
      b.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  const add = button('drv-new', rack, spec.onCreate);
  add.append(document.createTextNode('New driver'));
  el('span', '', add,
    'A different name, a different helmet, and a ladder of their own to climb.');
}

function careerRow(
  parent: HTMLElement, c: CareerSummary,
  tierName: (t: string) => string, onOpen: () => void,
): void {
  const b = button('drv-career', parent, onOpen);
  el('b', '', b, tierName(c.tier));
  el('span', 'grow', b, ' ' + c.seasonYear + ' · Round ' + (c.round + 1));
  el('span', '', b, c.record.wins > 0
    ? c.record.wins + (c.record.wins === 1 ? ' win' : ' wins')
    : c.record.starts + (c.record.starts === 1 ? ' start' : ' starts'));
}
