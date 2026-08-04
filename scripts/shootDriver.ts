import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs issue #77's six screens BY DRIVING THE REAL APP.
 *
 * Not a harness page with the components mounted on it, for the same reason
 * `shoot:myteam` is not: almost everything that can be wrong with these screens
 * is wrong in the wiring rather than in the markup — a chart with no history
 * because the round hook never ran, a rating that is the same on every screen
 * because nothing moved it, a tab that renders and does not route. A harness
 * would photograph every one of those as working.
 *
 * So it founds a career through the real buttons, RACES THREE ROUNDS so the
 * contract chart has a line and the accolade counters have something in them,
 * and then walks the six screens.
 *
 * The shots go beside `reference/target/83.png`, `84`, `85`, `86`, `87`, `88`
 * in the pull request. PROJECT.md §3.1: every visual claim made from a
 * screenshot in this project has eventually turned out to be wrong, so the PR
 * carries the pair and lets a reader check rather than a sentence claiming a
 * resemblance.
 *
 * The reference frames are 1920x1080, so the desktop viewport is 1920x1080 —
 * comparing a 1440-wide capture against a 1920-wide frame is comparing two
 * different layouts.
 *
 *   npm run shoot:driver
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'driver');

const VIEWPORTS = [
  // The reference set's own size. Anything else is not a comparison.
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'portrait', width: 390, height: 844 },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickText(page: Page, text: string): Promise<boolean> {
  return await page.evaluate((t: string) => {
    const nodes = [...document.querySelectorAll(
      'button, .menu-item, .trow, .dd-subtab, .dd-tab, .dm-row, .dd-rail-item')];
    const hit = nodes.find((n) => (n.textContent ?? '').trim() === t)
      ?? nodes.find((n) => (n.textContent ?? '').includes(t));
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center' });
    (hit as HTMLElement).click();
    return true;
  }, text);
}

/** What the shell says it is showing. The same key `probe:smoke` reads. */
async function heading(page: Page): Promise<string> {
  return await page.evaluate(() =>
    (document.querySelector('.page-title')?.textContent ?? '').trim());
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 10 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ],
  });

  const errors: string[] = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.createBrowserContext();
    const page: Page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${vp.name} pageerror: ${(e as Error).message}`));
    // An event choice ends in `alert(...)`, which suspends the page until it
    // is answered. Puppeteer does not answer one on its own.
    page.on('dialog', (d) => { void d.dismiss(); });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/favicon/.test(m.location().url ?? '')) return;
      errors.push(`${vp.name} console: ${m.text()}`);
    });
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    await page.goto(url + '?fresh=1&intro=0', { waitUntil: 'load', timeout: 120_000 });
    await page.waitForSelector('.page', { timeout: 120_000 });
    await sleep(900);

    const shot = async (name: string) => {
      await sleep(700);
      const file = `${vp.name}-${name}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: vp.name === 'portrait',
      });
      console.log('  ' + file);
    };
    const step = async (text: string, what: string) => {
      const ok = await clickText(page, text);
      if (!ok) { errors.push(`${vp.name}: could not reach "${text}" (${what})`); return false; }
      await sleep(1300);
      return true;
    };

    if (await clickText(page, 'Start driving')) await sleep(900);
    // NAMED STEPS. The front page says `Start Career` on a first run and
    // `New Career` once a driver exists, and `?fresh=1` guarantees the first
    // of those — but both are tried rather than assumed, because a blind
    // click on the primary action of the front page is a click into whatever
    // tile happens to be first, which is how `shoot:myteam` once walked into
    // a career it was not photographing.
    if (!await step('Start Career', 'the create screen')
      && !await step('New Career', 'the create screen')) {
      await page.close(); await context.close(); continue;
    }
    if (!await step('Take the seat', 'founding the career')) {
      await page.close(); await context.close(); continue;
    }
    await sleep(1600);

    // ------------------------------------------------------------------
    // RACE THREE ROUNDS FIRST.
    //
    // A contract chart with no history is a correct picture of a career that
    // has not raced, and it is not the picture `85.png` specifies. So the
    // sweep simulates three rounds through the real button, which also walks
    // the ratings reveal on the way back — the route `afterRace` puts it on.
    // ------------------------------------------------------------------
    for (let i = 0; i < 3; i++) {
      if (!await step('Simulate Race', 'simulating a round')) break;
      await sleep(2200);
      if (i === 0 && (await heading(page)) === 'Ratings') await shot('86-ratings-reveal');
      // Walk whatever the race produced — podium, reveal, press room, event —
      // back to the hub. Each of these is one primary action.
      for (let guard = 0; guard < 6; guard++) {
        const done = await page.evaluate(() =>
          (document.querySelector('.statusrail-where')?.textContent ?? '').trim() === 'Career');
        if (done) break;
        // A paddock event is a `.choice` div with no action bar under it, so
        // a loop that only knows about `.btn.primary` sits on it forever —
        // which is exactly where this sweep first stopped, on "Academy
        // Development Day", with every screen after it unreachable.
        const advanced = await page.evaluate(() => {
          const b = document.querySelector('.actionbar .btn.primary')
            ?? document.querySelector('.choice');
          if (!(b instanceof HTMLElement)) return false;
          b.click();
          return true;
        });
        if (!advanced) break;
        await sleep(1500);
      }
    }

    await shot('00-hub');

    if (!await step('Driver Details', 'driver details')) { await page.close(); await context.close(); continue; }
    await shot('85-contracts');
    if (await step('Accolades', 'the accolades tab')) await shot('83-accolades');
    if (await step('Rivals', 'the rivals tab')) await shot('90-rivals');
    if (await step('Recognition', 'the recognition tab')) await shot('84-recognition');
    if (await step('Driver Ratings Graph', 'the graph tab')) await shot('91-ratings-graph');
    if (await step('Driver Rating Comparison', 'the comparison tab')) await shot('87-comparison');
    if (await step('Driver Market', 'the market')) await shot('88-market');
    // Sorted the way `88.png` is sorted, with a row selected.
    if (await clickText(page, 'Rating')) { await sleep(1200); await shot('88b-market-by-rating'); }

    // The reveal on demand, so it is photographed even when the race route
    // above did not land on it.
    if (await step('Driver Details', 'back to details')) {
      if (await step('Ratings', 'the reveal')) await shot('86b-ratings-reveal');
    }

    await page.close();
    await context.close();
  }

  await browser.close();
  await server.close();

  console.log('\nshot to ' + OUT);
  console.log('Compare against reference/target/83,84,85,86,87,88.png at the same scale.');
  if (errors.length > 0) {
    console.error('\nProblems:');
    for (const e of [...new Set(errors)]) console.error('  ' + e);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
