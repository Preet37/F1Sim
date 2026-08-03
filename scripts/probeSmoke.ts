/**
 * Walks the front end the way a player does, and fails on anything it throws.
 *
 * WHY THIS EXISTS. Almost every serious defect in this project was found by the
 * user opening the game, pressing things, and sending back a screenshot. That
 * is a real testing method and nothing in `scripts/` reproduced it: every other
 * probe either drives the simulation with no UI at all, or reaches a session
 * through the `?circuit=` deep link, which is documented as going "past the
 * garage briefing" — i.e. past the entire front end. The menus, the career
 * screens and the settings pages had no automated coverage whatsoever.
 *
 * So this boots the REAL `main.ts` in a real browser with EMPTY storage — a
 * first-time player — and breadth-first walks the buttons it finds, to a bounded
 * depth, screenshotting each screen and recording:
 *
 *   - uncaught exceptions and unhandled promise rejections
 *   - `console.error`
 *   - screens that render but are visibly EMPTY (a button that leads nowhere)
 *   - buttons that throw when clicked
 *
 * WHAT WOULD HAVE TO BREAK FOR THIS TO FAIL: any button on the front end
 * throwing, or leading to a blank screen. It cannot be satisfied by a game that
 * never boots, because a boot failure produces zero visited screens and the
 * floor below catches that.
 *
 * Run: npm run probe:smoke
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'smoke');
/** How deep to walk from the main menu. 2 covers menu -> screen -> sub-screen. */
const DEPTH = Number(process.env.SMOKE_DEPTH ?? 2);
/** A screen with fewer than this many rendered characters is treated as blank. */
const MIN_TEXT = 24;

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

/** The clickable buttons on the screen right now, in document order. */
const LIST_BUTTONS = `(() => {
  const bs = Array.from(document.querySelectorAll('button'));
  return bs.map((b, i) => ({
    index: i,
    label: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
    disabled: b.disabled,
  })).filter((b) => b.visible && !b.disabled && b.label.length > 0);
})()`;

/** Visible text on the screen, for the blank-screen test. */
const SCREEN_TEXT = `(document.body.innerText || '').replace(/\\s+/g, ' ').trim()`;

async function main(): Promise<void> {
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
  const url = `http://127.0.0.1:${addr.port}/?intro=0`;

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

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120_000);

  let errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`uncaught: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chrome requests /favicon.ico from every document whether one is
    // referenced or not. Matched on the URL, because the message text is the
    // same for a missing icon and a missing module.
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console.error: ${m.text()}`);
  });

  /** Re-open the game from scratch, as a first-time player. */
  async function fresh(): Promise<void> {
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.evaluate('localStorage.clear(); sessionStorage.clear();');
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('!!window.__game', { timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 1500));
  }

  /**
   * Replays a click path from a fresh boot. Paths are replayed rather than
   * navigated back through, because "go back" is itself a button under test and
   * a walk that relied on it would go blind the moment it broke.
   */
  async function walkTo(path: string[]): Promise<boolean> {
    await fresh();
    for (const label of path) {
      const buttons = await page.evaluate(LIST_BUTTONS) as Button[];
      const target = buttons.find((b) => b.label === label);
      if (!target) return false;
      await page.evaluate((i: number) => {
        const bs = Array.from(document.querySelectorAll('button'));
        (bs[i] as HTMLButtonElement).click();
      }, target.index);
      await new Promise((r) => setTimeout(r, 1200));
    }
    return true;
  }

  const visited = new Set<string>();
  let screens = 0;
  let frontier: string[][] = [[]];

  for (let depth = 0; depth <= DEPTH; depth++) {
    const next: string[][] = [];
    for (const path of frontier) {
      const key = path.join(' > ') || '(main menu)';
      if (visited.has(key)) continue;
      visited.add(key);

      errors = [];
      const reached = await walkTo(path);
      if (!reached) {
        failures.push(`"${key}": the path could not be replayed — a button on it vanished`);
        continue;
      }
      screens++;

      const text = await page.evaluate(SCREEN_TEXT) as string;
      const buttons = await page.evaluate(LIST_BUTTONS) as Button[];
      const shot = key.replace(/[^a-z0-9]+/gi, '_').slice(0, 80) || 'main_menu';
      await page.screenshot({ path: resolve(OUT_DIR, `${shot}.png`) as `${string}.png` });

      console.log(`${'  '.repeat(depth)}${key}  [${buttons.length} buttons, ` +
        `${text.length} chars${errors.length ? `, ${errors.length} ERRORS` : ''}]`);

      check(errors.length === 0,
        `"${key}" threw: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
      check(text.length >= MIN_TEXT,
        `"${key}" renders a blank screen (${text.length} characters of visible text)`);

      if (depth < DEPTH) {
        for (const b of buttons) {
          // Do not follow a button whose label repeats one already on the path:
          // that is a tab or a toggle re-entering the same screen.
          if (path.includes(b.label)) continue;
          next.push([...path, b.label]);
        }
      }
    }
    frontier = next;
  }

  await writeFile(resolve(OUT_DIR, 'walk.txt'), [...visited].join('\n'), 'utf8');

  // THE FLOOR. Everything above is vacuously satisfied by a game that never
  // boots — zero screens visited means zero assertions evaluated.
  check(screens >= 6,
    `only ${screens} screens were reachable from the main menu — the front end did not boot`);

  await browser.close();
  await server.close();

  console.log(`\n${screens} screens walked, shots in ${OUT_DIR}`);
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    for (const f of [...new Set(failures)]) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nPASS — every reachable front-end screen renders and throws nothing.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
