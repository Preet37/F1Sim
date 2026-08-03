import '../src/ui/career.css';
import { driverPortraitSvg, nationPlateSvg } from '../src/ui/DriverPortrait';
import { buildCareerCreate } from '../src/ui/CareerCreate';
import { buildPodium } from '../src/ui/Podium';
import { IntroSequence, openingBeats } from '../src/ui/IntroSequence';
import {
  HELMET_FAMILIES, HELMET_PIGMENTS, VISORS, defaultHelmet, helmetForDriver,
  type HelmetDesign,
} from '../src/career/Identity';

/**
 * The career screens, without the game around them.
 *
 * Same reasoning as `audit/panels.ts`: reaching `Main` means booting a career,
 * a renderer and an audio engine to look at a drawing. This mounts the real
 * modules and nothing else, so the loop between changing a curve and seeing it
 * is a second rather than a minute.
 *
 *   npm run shoot:career
 */

declare global {
  interface Window {
    __career: {
      /** Renders a scene. False when there is no scene by that name. */
      show(name: string): boolean;
    };
  }
}

const app = document.getElementById('app') as HTMLElement;

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

/** Every pattern family, plus a range of palettes and both sizes. */
function sheet(): void {
  app.innerHTML = '';
  app.className = 'audit-sheet';

  const head = el('div', 'audit-head', app);
  el('div', 'audit-title', head, 'Driver portrait');
  el('div', 'audit-sub', head, 'Eight pattern families, three palettes, bust and helmet-only.');

  // --- Every family, one palette -----------------------------------------
  el('div', 'audit-label', app, 'Families — chalk on cobalt');
  const row1 = el('div', 'audit-row', app);
  for (const f of HELMET_FAMILIES) {
    const cell = el('div', 'audit-cell', row1);
    const design: HelmetDesign = {
      family: f.id, base: 0x1f56d6, stripe: 0xf2f3f5, trim: 0x14171c, visor: 'dark',
    };
    cell.appendChild(driverPortraitSvg(design, { bust: false, size: 150 }));
    el('div', 'audit-cap', cell, f.name);
  }

  // --- Busts, on team colours --------------------------------------------
  el('div', 'audit-label', app, 'Busts — in the race suit');
  const row2 = el('div', 'audit-row', app);
  const suits: [number, number, string][] = [
    [0xe11d2e, 0xffc61a, 'Signal'],
    [0x0f7a45, 0xf2f3f5, 'Green'],
    [0x111f4a, 0x11b3b3, 'Midnight'],
    [0x59636f, 0xff7a1a, 'Gunmetal'],
    [0xf2f3f5, 0x14171c, 'Chalk'],
  ];
  for (const [i, [suit, accent, name]] of suits.entries()) {
    const cell = el('div', 'audit-cell', row2);
    cell.appendChild(driverPortraitSvg(defaultHelmet(1000 + i * 37), {
      suit, accent, number: 2 + i * 11, size: 190,
    }));
    el('div', 'audit-cap', cell, name);
  }

  // --- Visors --------------------------------------------------------------
  el('div', 'audit-label', app, 'Visors');
  const row3 = el('div', 'audit-row', app);
  for (const v of VISORS) {
    const cell = el('div', 'audit-cell', row3);
    cell.appendChild(driverPortraitSvg({
      family: 'blade', base: 0x14171c, stripe: 0xff7a1a, trim: 0xf2f3f5, visor: v.id,
    }, { bust: false, size: 150 }));
    el('div', 'audit-cap', cell, v.name);
  }

  // --- At row size ---------------------------------------------------------
  el('div', 'audit-label', app, 'At the size a results row uses');
  const row4 = el('div', 'audit-row tight', app);
  for (let i = 0; i < 14; i++) {
    const cell = el('div', 'audit-cell', row4);
    cell.appendChild(driverPortraitSvg(helmetForDriver('driver-' + i), { bust: false, size: 40 }));
  }

  // --- Nation plates -------------------------------------------------------
  el('div', 'audit-label', app, 'Nationality plates');
  const row5 = el('div', 'audit-row tight', app);
  for (const n of ['United Kingdom', 'Italy', 'Japan', 'Brazil', 'Czechia', 'Netherlands',
    'Australia', 'United States', 'Atlantis']) {
    const cell = el('div', 'audit-cell', row5);
    const p = nationPlateSvg(n);
    p.setAttribute('width', '48');
    cell.appendChild(p);
  }

  // --- The pigments --------------------------------------------------------
  el('div', 'audit-label', app, 'Pigments');
  const row6 = el('div', 'audit-row tight', app);
  for (const p of HELMET_PIGMENTS) {
    const cell = el('div', 'audit-cell', row6);
    const sw = el('div', 'audit-pigment', cell);
    sw.style.background = '#' + p.hex.toString(16).padStart(6, '0');
    el('div', 'audit-cap', cell, p.name);
  }
}

/**
 * The signing screen, in the real page chassis.
 *
 * The chassis markup is a copy of what `Main.page()` emits — the same one
 * duplication `audit/panels.ts` makes and for the same reason: reaching `Main`
 * means booting a career, a renderer and an audio engine to look at a
 * stylesheet.
 */
function create(): void {
  app.innerHTML = '';
  app.className = '';
  const screen = el('div', 'screen', app);
  const page = el('div', 'page', screen);
  const rail = el('div', 'statusrail', page);
  el('div', 'statusrail-mark', rail).innerHTML = 'F1<b>SIM</b>';
  el('div', 'statusrail-sep s1', rail, '/');
  el('div', 'statusrail-where', rail, 'New Career');
  el('div', 'statusrail-spacer', rail);
  el('div', 'statusrail-live', rail, 'Live');

  const bar = el('div', 'topbar', page);
  el('div', 'navback-gap', bar);
  const titles = el('div', 'topbar-titles', bar);
  el('div', 'tab', titles, 'Main Menu');
  el('h1', 'page-title', titles, 'New Career');
  el('div', 'page-sub', titles,
    'One seat is open in Formula 3. It is the worst one on the grid, and it is '
    + 'yours if you want it.');
  el('div', 'topbar-meta', bar);

  const rule = el('div', 'sectorrule', page);
  for (const [i, part] of [9, 12, 11].entries()) {
    const seg = el('span', i === 0 ? 'live' : '', rule);
    seg.style.flex = String(part / 32);
  }

  const body = el('div', 'page-body', page);
  const actions = el('div', 'actionbar', page);

  const handle = buildCareerCreate(body, {
    seed: 4242,
    takenNumbers: [1, 4, 12, 22, 44, 63, 81],
    seat: {
      teamName: 'AIX Racing',
      tierName: 'Formula 3',
      rounds: 9,
      colour: 0x1f56d6,
      accent: 0xffc61a,
    },
    onSubmit: (id) => console.log('signed', id),
  });

  const b = document.createElement('button');
  b.className = 'btn primary';
  b.textContent = 'Take the seat';
  b.addEventListener('click', () => handle.submit());
  actions.appendChild(el('div', 'spacer', actions));
  actions.appendChild(b);
}

/** The podium, with the player on the second step and on the top one. */
function podium(): void {
  app.innerHTML = '';
  app.className = '';
  const screen = el('div', 'screen', app);
  const page = el('div', 'page', screen);
  const bar = el('div', 'topbar', page);
  el('div', 'navback-gap', bar);
  const titles = el('div', 'topbar-titles', bar);
  el('div', 'tab', titles, 'Grand Prix');
  el('h1', 'page-title', titles, 'Classification');
  const body = el('div', 'page-body', page);

  const field = [
    { id: 'PLAYER', first: 'Ondrej', last: 'Zdravkovic', team: 'AIX', c: 0x1f56d6, a: 0xffc61a },
    { id: 'ai-1', first: 'Théophile', last: 'Naël', team: 'Campos', c: 0xe11d2e, a: 0xf2f3f5 },
    { id: 'ai-2', first: 'Kaito', last: 'Yamashita', team: 'Prema', c: 0x0f7a45, a: 0x14171c },
  ];
  for (const winner of [0, 1]) {
    const order = winner === 0 ? [0, 1, 2] : [1, 0, 2];
    buildPodium(body, {
      top3: order.map((i, pos) => ({
        driverId: field[i].id,
        firstName: field[i].first,
        lastName: field[i].last,
        teamName: field[i].team,
        colour: field[i].c,
        accent: field[i].a,
        gap: pos === 0 ? '' : '+' + (pos * 4.281).toFixed(3),
        isPlayer: field[i].id === 'PLAYER',
        helmet: field[i].id === 'PLAYER'
          ? { family: 'blade' as const, base: 0xff7a1a, stripe: 0x111f4a, trim: 0xf2f3f5, visor: 'gold' as const }
          : undefined,
      })),
      playerPosition: order.indexOf(0) + 1,
      circuitName: 'Monza',
      tierName: 'Formula 3',
    });
  }
}

/** The opening sequence, held on its last beat. */
function intro(): void {
  app.innerHTML = '';
  app.className = '';
  new IntroSequence({
    host: app,
    beats: openingBeats(
      { colour: 0x1f56d6, accent: 0xffc61a, code: 'AIX' },
      [
        { colour: 0xe11d2e, accent: 0xf2f3f5, code: 'FER' },
        { colour: 0x11b3b3, accent: 0x14171c, code: 'MER' },
        { colour: 0x111f4a, accent: 0xffc61a, code: 'RBR' },
      ],
    ),
    durationS: 13.6,
    quality: 'low',
    onDone: () => console.log('intro done'),
  });
}

const SCENES: Record<string, () => void> = { sheet, create, podium, intro };

window.__career = {
  show(name: string): boolean {
    const fn = SCENES[name];
    if (!fn) return false;
    fn();
    return true;
  },
};
sheet();
