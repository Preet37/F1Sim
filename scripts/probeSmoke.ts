/**
 * Walks the front end the way a player does, and fails on anything it throws
 * — AND on any screen it was supposed to reach and did not.
 *
 * WHY THIS EXISTS. Almost every serious defect in this project was found by the
 * user opening the game, pressing things, and sending back a screenshot. That
 * is a real testing method and nothing in `scripts/` reproduced it: every other
 * probe either drives the simulation with no UI at all, or reaches a session
 * through the `?circuit=` deep link, which is documented as going "past the
 * garage briefing" — i.e. past the entire front end. The menus, the career
 * screens and the settings pages had no automated coverage whatsoever.
 *
 * WHY IT WAS REWRITTEN — issue #62, and it is PROJECT.md §3.2 in its most
 * expensive form. The first version of this file reported
 *
 *     15 screens walked
 *     PASS — every reachable front-end screen renders and throws nothing.
 *
 * having walked ONE SCREEN AND ITS COLOUR SWATCHES. The line it printed as
 * `(main menu)` was not the main menu — it was the first-run driver screen,
 * because a browser with empty storage does not open on the menu — and the
 * fourteen under it are that same screen repainted.
 * `grep -icE "setting|driver|career|garage|paddock"` over a whole run's log
 * returned 0. Three separate decisions combined to produce that:
 *
 *   1. It booted with EMPTY storage, so it started in the first-run driver
 *      flow rather than on the main menu. There is one button out of that flow
 *      and every OTHER button on it repaints the helmet.
 *   2. It de-duplicated screens by their NAME — the label of the button that
 *      led to them. Thirteen liveries have thirteen different names and are
 *      one screen, so the frontier grew 14, 196, 2744… and never escaped.
 *   3. Nothing said which screens it was supposed to reach, so reaching none
 *      of them was indistinguishable from a pass.
 *
 * WHAT REPLACED EACH:
 *
 *   1. THE WALK STARTS FROM AN ESTABLISHED INSTALL. The first run is walked
 *      once — it is a real screen and it is the front door, so it stays under
 *      test — and then the driver it creates, and two careers, are made
 *      through the real buttons and captured as a storage SEED that every
 *      later boot is restored from. That is also the only way `Continue` and
 *      `Team HQ` can exist at all: both are conditional on a saved career, so
 *      no walk that starts from an empty browser can ever open either.
 *
 *   2. IDENTITY IS WHAT A SCREEN IS, NOT WHAT IT IS CALLED. See `identify()`.
 *      A screen is its own declared screen id (the shell's `Screen` union),
 *      plus the headings it prints, plus the SET of buttons on it. The helmet
 *      editor in thirteen colours is one identity because all three parts are
 *      identical; the eight settings tabs are eight identities because the
 *      panel heading and the controls under it differ. Nothing is keyed on the
 *      button that was clicked to get there, which is what made a colour
 *      swatch look like a new screen.
 *
 *   3. THERE IS A REQUIRED SET. `REQUIRED` below lists screens with the route
 *      to each, and a route that cannot be replayed, or lands on the wrong
 *      screen id, is a FAILURE. A probe that passes without opening Settings
 *      is the bug this file is fixing, so not opening Settings has to be red.
 *      The floor at the bottom is unchanged and still catches a game that
 *      never boots.
 *
 * WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: any button on the front end
 * throwing, any screen rendering blank, or any screen in `REQUIRED` becoming
 * unreachable. Proved by breaking `SettingsScreen` deliberately — see the PR
 * for issue #62 for the old probe's output and this one's on the same build.
 *
 * WHAT THIS DOES NOT COVER, deliberately:
 *   - Anything inside a running session. Buttons that launch one are listed in
 *     `NO_FOLLOW`; `probe:framing`, `probe:hudtext`, `shoot:panels` and
 *     `probe:qualiretire` own that side and drive a real engine to do it.
 *   - The retirement flow, for the same reason: it needs an accident, and
 *     `probe:qualiretire` stages one in a browser and asserts every string.
 *
 * WHAT IS NEW SINCE — issues #13 and #38. This list used to carry a third
 * entry: "the press conference and the garage scene, which have no route into
 * them at all", with a block at the bottom that re-measured their absence and
 * printed it. Both are routed now, along with the opening titles and the
 * podium, and all four are in `REQUIRED` — so the thing that was a printed
 * observation is an assertion, and the four screens that had been built and
 * abandoned cannot go quietly unreachable a second time.
 *
 * Run: npm run probe:smoke                        ~11 min on a quiet machine
 *   SMOKE_FREE_S=0  required set only, no free walk — and it is the whole of
 *                   what can go red. Use this one under load. Measured 240s at
 *                   load average 5 and 567s at 48: this runs a real browser
 *                   under a software rasteriser, so the figure is a statement
 *                   about the machine as much as about the probe.
 *   SMOKE_DEPTH=n   how deep the free walk goes past the required routes (2)
 *   SMOKE_SHOTS=0   skip screenshots
 *   SMOKE_MAX=n     hard ceiling on distinct screens (120)
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'smoke');
const MAIN_TS = resolve(process.cwd(), 'src', 'main.ts');
/** How deep the free walk goes BEYOND the required routes. */
const DEPTH = Number(process.env.SMOKE_DEPTH ?? 2);
/** A screen with fewer than this many rendered characters is treated as blank. */
const MIN_TEXT = 24;
const SHOTS = process.env.SMOKE_SHOTS !== '0';
/** Stops a pathological fan-out from ever costing 70 minutes again. */
const MAX_SCREENS = Number(process.env.SMOKE_MAX ?? 120);
/**
 * Wall-clock ceiling on the free walk, in seconds.
 *
 * The REQUIRED set is unconditional and runs before this — it is the part that
 * can go red, and it is not on a budget. What this bounds is the open-ended
 * exploration after it, because PROJECT.md §8 records that this project's
 * probes get killed under load, and a probe nobody can afford to run is a
 * probe that does not run. When it is hit, the run says so.
 */
const FREE_WALK_S = Number(process.env.SMOKE_FREE_S ?? 420);
/**
 * How long a press is given before the walk looks at what it did.
 *
 * Short on purpose, and it is safe to be short for the question the walk asks
 * of a press: `setScreen` and `page()` both run INSIDE the click handler, so a
 * button that navigates has already navigated by the time `click` returns and
 * the screen id is right immediately. What needs longer is the picture — a
 * second GL context mounting a car — and that is settled for separately in
 * `record`, which is the only place a screenshot or a character count is
 * taken. Conflating the two is what made the old walk sleep 850ms on each of
 * sixty helmet swatches.
 */
const CLICK_SETTLE_MS = Number(process.env.SMOKE_CLICK_MS ?? 300);
/** Extra settling before a screen is photographed and measured. */
const RECORD_SETTLE_MS = Number(process.env.SMOKE_RECORD_MS ?? 700);

/**
 * Buttons the walk records but does not follow.
 *
 * Two kinds only, and both are cheap to justify:
 *   - it starts a driving session, which is another probe's ground and costs
 *     a track build, twenty cars and a physics warm-up;
 *   - it plays the sixteen-second opening titles, which `regress:career`
 *     already clicks through on the real skip button.
 * Everything else on the front end is followed.
 */
const NO_FOLLOW = [
  /^Confirm — to the grid$/,
  /^To the Garage$/,
  /^Watch /,
  /^Skip /,
  /^Practice Only$/,
  /^Simulate Race$/,
  /^Opening titles$/,
];

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('no Chrome found; set CHROME_PATH');
}

const failures: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

interface Button { label: string; index: number }

interface Snapshot {
  /** The shell's own `Screen` id. The screen saying what it is. */
  screen: string;
  /** The headings the page prints — `page()`'s tab and title, the status rail. */
  tab: string;
  title: string;
  where: string;
  /** The settings screen's panel heading, which is the open tab. */
  panel: string;
  buttons: Button[];
  text: string;
}

/**
 * Everything the walk needs about the screen on the page right now.
 *
 * `window.__game.screen` is read directly. It is `private` in TypeScript,
 * which is a compile-time idea and nothing at all at runtime, so this needs no
 * hook in `src/` — and it is the screen's own declaration of what it is rather
 * than this probe's guess, which is the whole point of it being in the key.
 */
const SNAPSHOT = `(() => {
  const g = window.__game;
  const t = (sel) => {
    const e = document.querySelector(sel);
    return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '';
  };
  const bs = Array.from(document.querySelectorAll('button')).map((b, i) => ({
    index: i,
    // A tile on the front page is a button holding a name, a figure and a
    // sentence, so its text reads "Start CareerF3 -> F2 -> F1Sign for a junior
    // team...". Kept whole rather than guessed at — the walk matches on a
    // PREFIX, which is the part a person would call the button. The aria-label
    // is the fallback for the icon-only controls (the gear, the back arrow,
    // the paddock chevrons), which have no text at all and were invisible to
    // the old walk for that reason.
    label: ((b.textContent || '').replace(/\\s+/g, ' ').trim()
      || (b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()).slice(0, 90),
    visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
    disabled: b.disabled,
  })).filter((b) => b.visible && !b.disabled && b.label.length > 0);
  return {
    screen: g && typeof g.screen === 'string' ? g.screen : '?',
    tab: t('.tab'),
    title: t('.page-title'),
    where: t('.statusrail-where'),
    panel: t('.set-panel-head'),
    buttons: bs,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim(),
  };
})()`;

/**
 * WHAT A SCREEN IS.
 *
 * Three parts, and each one is carrying a specific failure mode:
 *
 *   the shell's screen id      — a livery swatch does not change it, so it
 *                                cannot masquerade as somewhere new;
 *   the headings it prints     — `team-hq`, the paint shop, the engine deal
 *                                and the driver market are four screens under
 *                                ONE screen id, and only the heading separates
 *                                them. Likewise the eight settings tabs;
 *   the set of buttons on it   — sorted and de-duplicated, so a list whose
 *                                rows are reordered is the same screen, while
 *                                a screen that gained or lost a control is
 *                                not. This is what stops a genuinely new
 *                                screen being collapsed into an old one when
 *                                it happens to share an id and a title.
 *
 * The button LABEL that was clicked to arrive appears nowhere in the key. That
 * is the entire bug in issue #62: thirteen colours of one screen had thirteen
 * names, so a name-keyed walk saw thirteen screens.
 */
function identify(s: Snapshot): string {
  const labels = [...new Set(s.buttons.map((b) => b.label))].sort();
  // Separators that no label contains, so two different screens cannot be
  // pushed into one key by their text happening to abut.
  return [s.screen, s.where, s.tab, s.title, s.panel, labels.join(' ~ ')].join(' // ');
}

/**
 * The heading a screen prints, which is how a person would name it.
 *
 * Load-bearing beyond the log: `team-hq` is FIVE screens under one screen id —
 * the factory, the paint shop, the engine deal, the driver market and the
 * between-rounds preparation page — and this is the only thing that tells them
 * apart. A required route that only checked the screen id would pass with all
 * five collapsed onto the factory.
 */
function heading(s: Snapshot): string {
  return s.panel || s.title || s.where || s.tab;
}

/** How a screen is printed in the log and named on disk. */
function describe(s: Snapshot): string {
  const h = heading(s);
  return h && h !== s.screen ? `${s.screen} · ${h}` : s.screen;
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 70) || 'screen';
}

/**
 * A required screen and the route to it, in button labels from the main menu.
 *
 * `screen` is the shell id the route must land on. Getting somewhere is not
 * the test — getting to the RIGHT somewhere is, because several of these
 * routes silently fall back to another screen when a precondition is missing
 * (`showTeamHQ` returns to the hub without a My Team career; `showCareerHub`
 * returns to the menu without a career at all). A route that lands on the
 * fallback and is scored as "reached" is the same class of bug as the one this
 * file is fixing.
 */
interface Route { name: string; path: string[]; screen: string; expect?: string }

/** Label on the rail, and the heading the panel prints when it is open. */
const SETTINGS_TABS: [string, string][] = [
  ['Opposition', 'Opposition'],
  ['Driving', 'Driving and assists'],
  ['Controls', 'Controls'],
  ['Camera', 'Camera'],
  ['Audio', 'Audio'],
  ['Video', 'Video'],
  ['Weekend', 'Race weekend'],
  ['This device', 'This device'],
];

const REQUIRED: Route[] = [
  { name: 'Main menu', path: [], screen: 'menu' },
  { name: 'Settings', path: ['Settings'], screen: 'settings' },
  ...SETTINGS_TABS.map(([label, panelHeading]): Route => ({
    name: `Settings — ${label}`,
    path: ['Settings', label],
    screen: 'settings',
    expect: panelHeading,
  })),
  {
    name: 'Controller setup',
    path: ['Settings', 'Controls', 'Controller setup'],
    screen: 'controller',
    expect: 'Controller',
  },
  { name: 'Driver rack', path: ['Drivers'], screen: 'drivers' },
  { name: 'New driver', path: ['Drivers', 'New driver'], screen: 'driver-create' },
  { name: 'Career create', path: ['New Career'], screen: 'career-create' },
  { name: 'My Team create', path: ['My Team'], screen: 'career-create' },
  { name: 'Team create', path: ['My Team', 'Next: the team'], screen: 'team-create' },
  { name: 'Paddock', path: ['Paddock'], screen: 'paddock' },
  { name: 'Quick Race — session select', path: ['Quick Race'], screen: 'session-select' },
  { name: 'Car setup', path: ['Quick Race', 'Car Setup'], screen: 'setup' },
  { name: 'Briefing (Grand Prix)', path: ['Quick Race', 'Grand Prix'], screen: 'briefing' },
  { name: 'Strategy', path: ['Quick Race', 'Grand Prix', 'Race Strategy'], screen: 'strategy' },
  { name: 'Continue — career hub', path: ['Continue'], screen: 'career-hub' },
  { name: 'Standings', path: ['Continue', 'Standings'], screen: 'standings' },
  // All four report the screen id `team-hq`, so `expect` is what proves the
  // route reached the ROOM it names rather than falling back to the factory.
  {
    name: 'Team HQ', path: ['Continue', 'Team HQ'],
    screen: 'team-hq', expect: 'Team HQ',
  },
  {
    name: 'Paint shop', path: ['Continue', 'Team HQ', 'Paint shop'],
    screen: 'team-hq', expect: 'Paint shop',
  },
  {
    name: 'Engine deal', path: ['Continue', 'Team HQ', 'Engine deal'],
    screen: 'team-hq', expect: 'Engine deal',
  },
  { name: 'Race weekend briefing', path: ['Continue', 'Race Weekend'], screen: 'briefing' },

  // ---------------------------------------------------------------------
  // ISSUE #77 — the driver, as the management screens see them
  // ---------------------------------------------------------------------
  //
  // Nine routes for three screen ids, and the reason there are nine is the
  // reason there are eight settings routes: `driver-details` is ONE shell id
  // carrying six sub-tabs, and a required route that only checked the id would
  // pass with all six collapsed onto Contracts. `expect` is the sub-tab's own
  // heading, which `showDriverDetails` puts in `.page-title`.
  //
  // Every one of these is a view onto `src/career/DriverRatings.ts`. They are
  // in this list on the day they were written rather than after somebody
  // noticed they had gone — which is the whole of what #13, #38 and #62 cost.
  //
  // `Driver market` MOVED. It used to be `team-hq` / "The second car", the My
  // Team signing board. There is one market now, at its own screen id, doing
  // both jobs — see the note where `TeamHQ.driverMarket` was.
  { name: 'Driver market', path: ['Continue', 'Driver Market'], screen: 'driver-market' },
  {
    name: 'Driver details — Contracts', path: ['Continue', 'Driver Details'],
    screen: 'driver-details', expect: 'Contracts',
  },
  {
    name: 'Driver details — Accolades', path: ['Continue', 'Driver Details', 'Accolades'],
    screen: 'driver-details', expect: 'Accolades',
  },
  {
    name: 'Driver details — Rivals', path: ['Continue', 'Driver Details', 'Rivals'],
    screen: 'driver-details', expect: 'Rivals',
  },
  {
    name: 'Driver details — Recognition',
    path: ['Continue', 'Driver Details', 'Recognition'],
    screen: 'driver-details', expect: 'Recognition',
  },
  {
    name: 'Driver details — Ratings graph',
    path: ['Continue', 'Driver Details', 'Driver Ratings Graph'],
    screen: 'driver-details', expect: 'Driver Ratings Graph',
  },
  {
    name: 'Driver details — Comparison',
    path: ['Continue', 'Driver Details', 'Driver Rating Comparison'],
    screen: 'driver-details', expect: 'Driver Rating Comparison',
  },
  { name: 'Ratings reveal', path: ['Continue', 'Driver Details', 'Ratings'], screen: 'ratings' },

  // ---------------------------------------------------------------------
  // THE FOUR SET-PIECES — issues #13 and #38, and the reason they are here
  // ---------------------------------------------------------------------
  //
  // Every one of these was BUILT, was CORRECT, and could not be got to. The
  // intro was first-run-only behind a flag set on the player's very first
  // load; the podium fired only at the foot of a classification you had to
  // drive a whole race to see; `PressConference.ts` and `GarageScene.ts` had
  // no import, no screen id and no button anywhere in `src/main.ts` and their
  // only executor in the entire repository was `npm run shoot:people`.
  //
  // Routing them is a morning's work. Keeping them routed is the actual bug,
  // and it is what these four lines are for: unreachable is now RED, by name,
  // in the probe that walks the front end the way a player does. The version
  // of this file that shipped with issue #62 listed the press conference and
  // the garage under "what this does not cover" and re-measured their absence
  // as a printed note. That note is now an assertion.
  //
  // `Opening titles` and `Simulate Race` are both in `NO_FOLLOW` so the free
  // walk does not spend sixteen seconds of titles or a whole simulated race on
  // every pass. `walkTo` does not consult `NO_FOLLOW` — a required route is a
  // deliberate route — so these still open them.
  // No `expect` on three of the four: `expect` exists for routes that share a
  // screen id with a fallback they could silently land on instead (the four
  // rooms of `team-hq`, the eight settings tabs). These four ids are their own
  // and nothing else in the shell reports them, so the id IS the assertion —
  // and the podium and the garage title themselves after the circuit and the
  // team, which vary by career and by where the paddock carousel was left.
  { name: 'Opening titles', path: ['Opening titles'], screen: 'intro' },
  { name: 'Podium', path: ['Continue', 'Simulate Race'], screen: 'podium' },
  {
    name: 'Press conference', path: ['Continue', 'Simulate Race', 'Press conference'],
    screen: 'presser', expect: 'Press conference',
  },
  { name: 'Garage', path: ['Paddock', 'Into the garage'], screen: 'garage' },
];

/**
 * Restores the storage seed before the app's first line runs.
 *
 * Carried in `window.name` because that is the one thing that survives a
 * same-tab navigation without a round trip. The alternative is loading the
 * origin once to write `localStorage` and then loading it AGAIN to boot the
 * game, which is two full app boots per screen under software GL — and that is
 * a large part of why the old probe took over an hour.
 *
 * Module scope so it can be installed on a replacement tab as well as on the
 * first one. It closes over nothing: it is serialised into the page and reads
 * `window.name` there.
 */
function restoreSeed(): void {
  try {
    localStorage.clear();
    sessionStorage.clear();
    const raw = window.name;
    if (raw && raw.startsWith('{')) {
      const seed = JSON.parse(raw) as Record<string, string>;
      for (const k of Object.keys(seed)) localStorage.setItem(k, seed[k]);
    }
  } catch { /* a browser blocking storage is a case the game handles */ }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await mkdir(OUT_DIR, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  // `?intro=0` skips the title sequence. `regress:career` deliberately clicks
  // the real skip button instead, so that path is already covered; walking the
  // menus behind fourteen seconds of titles on every reload is not worth it.
  const origin = `http://127.0.0.1:${addr.port}/`;
  const url = `${origin}?intro=0`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 10 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars',
      // Software GL so this runs anywhere and on any machine load. This probe
      // is about whether the UI works, not about frame time — `probe:renderperf`
      // owns that and runs on the real GPU.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1440,900',
    ],
  });

  let errors: string[] = [];
  const asked: string[] = [];
  const alerts: string[] = [];

  /**
   * A tab, wired up.
   *
   * `let` rather than `const`, and a factory rather than a literal, because
   * the recovery below has to be able to throw the tab away and open another.
   * Everything a walk needs is re-installed here so a replacement tab is
   * indistinguishable from the original: the viewport, the error collectors
   * and the dialog handler. A replacement that quietly lost the dialog handler
   * would hang on the first `confirm()` it met.
   */
  let page: Page;
  async function openTab(): Promise<Page> {
    const p: Page = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    p.setDefaultTimeout(120_000);
    p.on('pageerror', (e) => errors.push(`uncaught: ${String(e)}`));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Chrome requests /favicon.ico from every document whether one is
      // referenced or not. Matched on the URL, because the message text is the
      // same for a missing icon and a missing module.
      if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
      errors.push(`console.error: ${m.text()}`);
    });
    p.on('dialog', (d) => {
      const line = `${d.type()}: ${d.message().replace(/\s+/g, ' ').slice(0, 110)}`;
      (d.type() === 'alert' ? alerts : asked).push(line);
      void d.dismiss().catch(() => { /* already gone */ });
    });
    await p.evaluateOnNewDocument(restoreSeed);
    return p;
  }
  page = await openTab();

  let seed: Record<string, string> = {};
  /** Cold boots of the game. The unit this probe's wall clock is made of. */
  let boots = 0;

  async function boot(): Promise<void> {
    boots++;
    // `window.name` only survives a SAME-ORIGIN navigation, so the seed has to
    // be written from a document already on the app's origin. That costs one
    // extra load on the very first boot, when the seed is empty anyway.
    if (!page.url().startsWith(origin)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    }
    await page.evaluate((s: string) => { window.name = s; }, JSON.stringify(seed));
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(
      '!!window.__game && document.querySelectorAll("button").length > 0',
      { timeout: 120_000 },
    );
    await new Promise((r) => setTimeout(r, 900));
  }

  /**
   * The tab going away under the walk — a renderer crash, not a screen.
   *
   * It happens: this runs on a software rasteriser, `audit-out` runs are taken
   * on a machine with other agents on it, and PROJECT.md §8 records that this
   * project's probes get killed under load. Losing the run at screen 40 of 60
   * loses the whole run's evidence, so the walk recovers and carries on — but
   * it is COUNTED, and a path that dies TWICE is reported as a failure,
   * because that is no longer load, that is the screen.
   */
  const crashedAt = new Map<string, number>();
  let crashedHere = false;

  function pageGone(e: unknown): boolean {
    return /detached|Target closed|Session closed|Execution context|crashed/i
      .test(String(e));
  }

  /**
   * THE RECOVERY HAS TO SURVIVE THE THING IT IS RECOVERING FROM.
   *
   * This used to be one `await boot()`, and `boot()` starts with
   * `page.url()` and `page.evaluate` on the tab that has just died — so when
   * the tab was genuinely gone rather than merely reloading, the recovery
   * threw `Attempted to use detached Frame` from inside the catch block that
   * was handling the first crash, and the exception escaped every handler and
   * ended the process. Measured on 2026-08-03 at load average 40: a run that
   * had already produced its finding died before it could print the failure
   * list, which is precisely the failure mode issue #25 was about in
   * `regress:exit` — a harness turning a result into a stack trace.
   *
   * So: reboot in the tab we have, and if the tab itself is unusable, throw it
   * away and open another. The walk's whole state lives in this process, not
   * in the tab, so a replacement costs one cold boot and nothing else.
   */
  async function noteCrash(path: string[], e: unknown): Promise<void> {
    const where = path.join(' > ') || '(main menu)';
    const n = (crashedAt.get(where) ?? 0) + 1;
    crashedAt.set(where, n);
    crashedHere = true;
    console.log(`  BROWSER GONE at [${where}] (${String(e).slice(0, 70)}) — rebooting`);
    if (n > 1) {
      failures.push(`the page died TWICE while walking [${where}] — that is the `
        + 'screen rather than the machine');
    }
    here = null;
    try {
      await boot();
      return;
    } catch (again) {
      if (!pageGone(again)) throw again;
      console.log(`  the tab itself is gone (${String(again).slice(0, 60)}) — opening a new one`);
    }
    try { await page.close(); } catch { /* it is already gone; that is the point */ }
    page = await openTab();
    await boot();
  }

  /** Where the walk believes it is, for crash reporting. */
  let atPath: string[] = [];

  async function snap(): Promise<Snapshot> {
    try {
      return await page.evaluate(SNAPSHOT) as Snapshot;
    } catch (e) {
      if (!pageGone(e)) throw e;
      await noteCrash(atPath, e);
      return await page.evaluate(SNAPSHOT) as Snapshot;
    }
  }

  /**
   * Clicks a button by its label. False if no such button is on the screen.
   *
   * Exact first, then prefix, because a menu tile's text is its name followed
   * by its figure and its description and nobody calls that button by all
   * three. Exact wins so that a route naming a whole label can never be
   * hijacked by a longer one that starts the same way.
   */
  async function click(label: string, settleMs = CLICK_SETTLE_MS): Promise<boolean> {
    const s = await snap();
    const target = s.buttons.find((b) => b.label === label)
      ?? s.buttons.find((b) => b.label.startsWith(label));
    if (!target) return false;
    try {
      await page.evaluate((i: number) => {
        const bs = Array.from(document.querySelectorAll('button'));
        (bs[i] as HTMLButtonElement).click();
      }, target.index);
    } catch (e) {
      if (!pageGone(e)) throw e;
      await noteCrash(atPath, e);
      return false;
    }
    await new Promise((r) => setTimeout(r, settleMs));
    return true;
  }

  /**
   * The path currently standing on the page, so a route that extends it can be
   * clicked onward rather than replayed from a cold boot.
   *
   * Forward reuse only. "Go back" is itself a button under test and a walk
   * that ascended through it would go blind the moment it broke — that is the
   * original file's reasoning and it was right. What changes is that going
   * FORWARD from where we already are costs nothing and is exactly what a
   * player does.
   */
  let here: string[] | null = null;

  async function walkTo(path: string[]): Promise<boolean> {
    atPath = path;
    let from = 0;
    if (here && here.length <= path.length && here.every((l, i) => path[i] === l)) {
      from = here.length;
    } else {
      await boot();
      here = [];
    }
    for (let i = from; i < path.length; i++) {
      if (!await click(path[i])) { here = null; return false; }
      here = path.slice(0, i + 1);
    }
    return true;
  }

  const seen = new Map<string, string>();
  const order: string[] = [];
  const reachedIds = new Set<string>();
  let screens = 0;

  /** Records the screen on the page: identity, shot, blank test, error test. */
  async function record(prefix: string, path: string[]): Promise<Snapshot & { key: string }> {
    // The one place the walk waits for the picture rather than for the DOM.
    await new Promise((r) => setTimeout(r, RECORD_SETTLE_MS));
    const s = await snap();
    const key = identify(s);
    const label = describe(s);
    const first = !seen.has(key);
    if (first) { seen.set(key, label); order.push(label); screens++; }
    // Two DIFFERENT screens can print the same heading — the career hub of an
    // F1 career and of an F3 one are not the same screen and are both walked —
    // so the second one on disk gets a suffix rather than overwriting the
    // first. Silently overwriting is how a contact sheet ends up with fewer
    // pictures than the run had screens.
    const sameName = order.filter((o) => o === label).length;
    const shotName = sameName > 1 ? `${label}_${sameName}` : label;
    reachedIds.add(s.screen);
    if (SHOTS && first) {
      // A shot is evidence, not an assertion: a tab that died mid-capture has
      // already been reported by `snap`, and losing the run over the PNG would
      // throw away everything the walk had proved up to here.
      try {
        await page.screenshot({
          path: resolve(OUT_DIR, `${slug(shotName)}.png`) as `${string}.png`,
        });
      } catch (e) {
        if (!pageGone(e)) throw e;
        await noteCrash(path, e);
      }
    }
    const via = path.length ? path.join(' > ') : '(main menu)';
    console.log(`${prefix}${label}  [${s.buttons.length} buttons, ${s.text.length} chars`
      + `${first ? '' : ', seen'}${errors.length ? `, ${errors.length} ERRORS` : ''}]`
      + (path.length ? `   via ${via}` : ''));
    check(errors.length === 0,
      `"${label}" (via ${via}) threw: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
    check(s.text.length >= MIN_TEXT,
      `"${label}" (via ${via}) renders a blank screen (${s.text.length} characters)`);
    errors = [];
    return { ...s, key };
  }

  // =======================================================================
  // 1. The first run, and the seed everything else is walked from
  // =======================================================================
  //
  // Storage is empty here, so this IS the first-run flow the old probe got
  // stuck in — walked once, on purpose, because it is the front door. Then the
  // driver and the two careers behind `Continue` and `Team HQ` are created
  // through the real buttons, and the storage they leave behind is the seed.
  console.log('\nThe first run');
  await boot();
  here = [];
  const firstRun = await record('  ', []);
  check(firstRun.screen === 'driver-create',
    `a browser with empty storage should open the driver flow, not "${firstRun.screen}"`);

  // THE COLLAPSE, MEASURED IN PLACE. Every one of the thirteen liveries and
  // "Paint me another" is clicked here, and every one must come back as the
  // SAME identity. This is the assertion issue #62 is really about: if a
  // repaint ever starts reading as a new screen again, the walk goes back to
  // enumerating colour permutations, and this goes red before it does.
  const firstRunKey = identify(firstRun);
  let repaints = 0;
  for (const b of firstRun.buttons) {
    if (b.label === 'Start driving') continue;
    if (!await click(b.label)) continue;
    repaints++;
    check(identify(await snap()) === firstRunKey,
      `"${b.label}" on the driver screen reads as a DIFFERENT screen — the walk `
      + 'would enumerate livery permutations again (issue #62)');
  }
  console.log(`  ${repaints} repaint controls on the driver screen, all one identity`);
  check(repaints >= 10,
    `only ${repaints} controls on the driver screen — has it changed shape?`);
  check(errors.length === 0,
    'the driver screen threw while being painted: '
    + [...new Set(errors)].slice(0, 3).join(' | '));
  errors = [];

  check(await click('Start driving'), '"Start driving" is not on the first-run screen');
  let s = await snap();
  check(s.screen === 'menu',
    `"Start driving" should land on the main menu, landed on "${s.screen}"`);

  // A career, so `Continue` exists — and a My Team career, because `Team HQ`
  // is conditional on one and is otherwise a screen no walk can ever open.
  const seeds: [string, string[]][] = [
    ['career', ['Start Career', 'Take the seat']],
    ['My Team career', ['My Team', 'Next: the team', 'Enter the championship']],
  ];
  for (const [name, steps] of seeds) {
    for (const step of steps) {
      check(await click(step), `seeding a ${name}: "${step}" was not on the screen`);
    }
    s = await snap();
    check(s.screen === 'career-hub',
      `seeding a ${name} should land on the career hub, landed on "${s.screen}"`);
    // Back to the front page for the next one. This is the one place the walk
    // moves backwards, and it is a seeding step rather than an assertion.
    await page.evaluate(() => {
      const g = (window as unknown as { __game?: { showMenu?(): void } }).__game;
      g?.showMenu?.();
    });
    await new Promise((r) => setTimeout(r, 500));
  }

  seed = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out[k] = localStorage.getItem(k) ?? '';
    }
    return out;
  });
  check(Object.keys(seed).length > 0,
    'nothing was written to storage by creating a driver and two careers');
  console.log(`  seeded ${Object.keys(seed).length} storage keys — `
    + 'one driver, one career, one My Team career');
  here = null;
  errors = [];

  // Phase timing, printed because this probe's whole cost is cold boots and
  // the next person to make it cheaper needs to know which phase spends them.
  const stamp = (phase: string, from: number): number => {
    console.log(`  [${phase}: ${((Date.now() - from) / 1000).toFixed(1)}s, `
      + `${boots} boots so far]`);
    return Date.now();
  };
  let phaseFrom = stamp('first run', startedAt);

  // =======================================================================
  // 2. The required set — the part that makes a missing screen RED
  // =======================================================================
  console.log('\nRequired screens');
  // Sorted so shared prefixes are adjacent, which lets `walkTo` click onward
  // from where it already is instead of rebooting the game.
  const routes = [...REQUIRED]
    .sort((a, b) => a.path.join(' > ').localeCompare(b.path.join(' > ')));
  const reachedRoutes = new Set<string>();
  for (const route of routes) {
    if (!await walkTo(route.path)) {
      failures.push(`REQUIRED "${route.name}" is UNREACHABLE: the route `
        + `[${route.path.join(' > ') || 'main menu'}] broke — a button on it is gone`);
      console.log(`  MISSING   ${route.name}   [${route.path.join(' > ')}]`);
      // Whatever the broken route threw belongs to the broken route, not to
      // the next screen that happens to be recorded. Without this, a settings
      // screen that throws is reported a second time against the main menu.
      errors = [];
      continue;
    }
    const shot = await record('  ', route.path);
    if (shot.screen !== route.screen) {
      failures.push(`REQUIRED "${route.name}" landed on screen "${shot.screen}", `
        + `expected "${route.screen}" — the route fell through to a fallback`);
      continue;
    }
    // Compared against the screen's own heading rather than against
    // `innerText`, which is the RENDERED text and therefore carries
    // `text-transform` — the settings rail is upper-cased in CSS, so every one
    // of these matched nothing on the first attempt. Case-insensitive for the
    // same reason.
    if (route.expect
      && heading(shot).toLowerCase() !== route.expect.toLowerCase()) {
      failures.push(`REQUIRED "${route.name}" opened "${route.screen}" but it reads `
        + `"${heading(shot)}", expected "${route.expect}"`);
      continue;
    }
    reachedRoutes.add(route.name);
  }

  phaseFrom = stamp('required set', phaseFrom);

  // =======================================================================
  // 3. The free walk — everything the required set did not name
  // =======================================================================
  //
  // TWO RULES, and between them they are the whole cost fix.
  //
  // EXPAND A SCREEN ONCE, BY WHAT IT IS. The children of a screen already
  // expanded are the children already expanded, whatever path reached it — so
  // the frontier is bounded by how many distinct screens the front end has,
  // not by how many ways there are to arrive at one. That is the difference
  // between 14 -> 196 -> 2744 and a walk that terminates.
  //
  // PRESS THE BUTTON WHERE YOU ARE STANDING, and only pay for a reload if it
  // went somewhere. Most buttons on this front end do not navigate — they
  // repaint a helmet, flip a switch, step a carousel. The old walk could not
  // tell the difference and paid a full cold boot to discover each one; here a
  // press that leaves the identity unchanged costs one click, and only a press
  // that genuinely moved costs a boot to come back from. On the driver screen
  // that is 60-odd clicks instead of 60-odd boots.
  //
  // Descent is depth-first for the same reason: after a button that DID
  // navigate we are already standing on the child, so it is walked there and
  // then rather than being queued and replayed from the front page.
  console.log('\nThe free walk');
  const expanded = new Set<string>();
  const freeWalkEndsAt = Date.now() + FREE_WALK_S * 1000;
  let outOfBudget = false;

  async function explore(path: string[], depth: number): Promise<void> {
    // We are standing on `path` already — that is this function's contract.
    const shot = await record('  '.repeat(depth + 1), path);
    if (expanded.has(shot.key) || depth >= DEPTH) return;
    expanded.add(shot.key);
    for (const b of shot.buttons) {
      if (screens >= MAX_SCREENS) return;
      if (Date.now() >= freeWalkEndsAt) { outOfBudget = true; return; }
      if (path.includes(b.label)) continue;
      if (NO_FOLLOW.some((re) => re.test(b.label))) continue;
      // Back to this screen for the next button. Free when the last press was
      // a repaint, a reload when it navigated.
      if (!await walkTo(path)) return;
      crashedHere = false;
      if (!await click(b.label)) continue;
      const after = await snap();
      // A crash puts the walk back on the front page, so neither "it stayed"
      // nor "it moved" is true of the screen in front of us. Give up on this
      // button; the next iteration's `walkTo` replays the path from scratch.
      if (crashedHere) { errors = []; continue; }
      if (identify(after) === shot.key) {
        // A repaint, not a door — a switch, a swatch, a carousel step. It is
        // still a control that was pressed, so it still has to not throw, and
        // this is the only place in the walk that presses one. Attributed to
        // the button rather than being left to land on whatever screen is
        // recorded next.
        check(errors.length === 0, `pressing "${b.label}" on "${describe(shot)}" threw: `
          + [...new Set(errors)].slice(0, 3).join(' | '));
        errors = [];
        continue;
      }
      here = [...path, b.label];
      await explore([...path, b.label], depth + 1);
    }
  }

  await walkTo([]);
  await explore([], 0);
  if (outOfBudget) {
    console.log(`  (the free walk stopped at its ${FREE_WALK_S}s budget — the `
      + 'required set above is unconditional and ran in full)');
  }
  stamp('free walk', phaseFrom);

  // =======================================================================
  // 4. Coverage, printed as a measurement rather than asserted
  // =======================================================================
  //
  // The list of screens that EXIST comes out of `src/main.ts`'s own `Screen`
  // union, so it cannot drift from the shell. Anything in it the walk never
  // reached is printed. Only the required ones are failures — a screen that
  // genuinely needs a running session is not a hole in this probe, it is
  // another probe's ground, and saying which is the honest report.
  const src = await readFile(MAIN_TS, 'utf8');
  const union = /^type Screen =([\s\S]*?);$/m.exec(src);
  const declared = union ? [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]) : [];
  check(declared.length > 0, 'could not read the `Screen` union out of src/main.ts');
  const requiredIds = new Set(REQUIRED.map((r) => r.screen));

  console.log('\nScreens the shell declares, and whether the walk opened them');
  for (const id of declared) {
    const hit = reachedIds.has(id);
    console.log(`  ${hit ? 'walked  ' : 'NOT SEEN'}  ${id}`
      + (!hit && requiredIds.has(id) ? '   <-- REQUIRED' : ''));
    if (!hit && requiredIds.has(id)) {
      failures.push(`screen "${id}" is in the required set and the walk never opened it`);
    }
  }

  console.log('\nRequired routes: '
    + `${reachedRoutes.size} of ${REQUIRED.length} reached`);
  for (const route of REQUIRED) {
    if (!reachedRoutes.has(route.name)) console.log(`  NOT REACHED  ${route.name}`);
  }

  // ISSUE #38, NOW AN ASSERTION RATHER THAN A NOTE.
  //
  // This block used to print which of the set-piece modules `src/main.ts` did
  // not import, and printing is all it did. The import is the cheapest half of
  // being reachable and it is not the half that was broken — the routes above
  // are what prove a player can get there — but it is a real precondition and
  // it costs one `grep` of the shell, so it is checked rather than reported.
  // A module the shell has stopped importing is a route that is about to go.
  const setPieces = ['PressConference', 'GarageScene', 'Podium', 'IntroSequence'];
  const unrouted = setPieces.filter((m) => !new RegExp(`ui/${m}'`).test(src));
  console.log('\nIssue #38 — the set-piece modules, and whether the shell imports them');
  for (const m of setPieces) {
    console.log(`  ${unrouted.includes(m) ? 'UNROUTED' : 'imported'}  src/ui/${m}.ts`);
  }
  check(unrouted.length === 0,
    `src/main.ts imports none of [${unrouted.join(', ')}] — ${unrouted.length === 1
      ? 'that module is' : 'those modules are'} back to being code only a `
    + 'screenshot harness executes (issue #38)');

  await writeFile(resolve(OUT_DIR, 'walk.txt'),
    order.join('\n')
    + '\n\ndeclared but never opened: '
    + declared.filter((id) => !reachedIds.has(id)).join(', ') + '\n', 'utf8');

  // THE FLOOR. Everything above is vacuously satisfied by a game that never
  // boots — zero screens visited means zero assertions evaluated. It is raised
  // from 6 to 20 because 15 is exactly what the broken walk reported.
  check(screens >= 20,
    `only ${screens} distinct screens were reachable — the front end did not boot`);
  if (asked.length > 0) {
    console.log('\nThe walk was asked to confirm, and answered no:');
    for (const a of [...new Set(asked)]) console.log(`  ${a}`);
  }
  check(alerts.length === 0,
    `the walk raised ${alerts.length} alert(s) — on this front end an alert is a `
    + `career refusing to load or a save migrating: ${alerts.slice(0, 3).join(' | ')}`);
  if (crashedAt.size > 0) {
    console.log('\nThe browser went away and was rebooted, at:');
    for (const [where, n] of crashedAt) console.log(`  ${n}x  ${where}`);
  }

  await browser.close();
  await server.close();

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${screens} distinct screens walked in ${secs}s over ${boots} cold boots; `
    + `${reachedIds.size} of ${declared.length} declared screen ids reached; `
    + `${reachedRoutes.size} of ${REQUIRED.length} required routes; `
    + `shots in ${OUT_DIR}`);
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    for (const f of [...new Set(failures)]) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nPASS — every required front-end screen opened, '
      + 'and every screen reached renders and throws nothing.');
  }
}

main().catch((e) => {
  console.error(e);
  // AND THEN ACTUALLY STOP. Setting `exitCode` alone left the vite server
  // listening and the browser open — both are created inside `main` and
  // neither is closed on the error path — so node had nothing to exit for and
  // a crashed run HUNG rather than failing. Measured on 2026-08-03: a run that
  // had already printed its finding sat there until it was killed by hand.
  // Puppeteer kills the browser it launched on process exit.
  process.exit(1);
});
