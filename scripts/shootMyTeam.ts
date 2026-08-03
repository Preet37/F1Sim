import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the My Team screens by DRIVING THE REAL APP.
 *
 * Not a harness page with the components mounted on it. These four screens are
 * the first thing in this project that spends money, changes a car and then
 * races it, and almost everything that can be wrong with them is wrong in the
 * wiring rather than in the markup — a livery that is not registered before the
 * cars are built, a GL context that is not released when the screen changes, a
 * button that saves but does not repaint. A harness would photograph all of
 * those as working.
 *
 * So it boots the game, clicks Main Menu → My Team, fills the create screen in,
 * founds the team and walks the factory. If any of it cannot be reached, the
 * shot is missing and the script says which.
 *
 *   npm run shoot:myteam
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'myteam');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 960 },
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

/** Clicks the first button whose visible text matches. Returns false if absent. */
async function clickText(page: Page, text: string): Promise<boolean> {
  return await page.evaluate((t: string) => {
    const nodes = [...document.querySelectorAll('button, .menu-item, .trow')];
    const hit = nodes.find((n) => (n.textContent ?? '').includes(t));
    if (!hit) return false;
    // A phone viewport puts most of the menu below the fold, and an element
    // that is not in view is not one Chrome will dispatch a click to.
    hit.scrollIntoView({ block: 'center' });
    (hit as HTMLElement).click();
    return true;
  }, text);
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
    // A FRESH CONTEXT PER VIEWPORT. Sharing one means the second run finds the
    // career the first one created in `localStorage` and boots straight into
    // the hub instead of the menu — which is correct behaviour for the game and
    // useless for a screenshot sweep.
    const context = await browser.createBrowserContext();
    const page: Page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${vp.name} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/favicon/.test(m.location().url ?? '')) return;
      errors.push(`${vp.name} console: ${m.text()}`);
    });
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    // The shell boots a renderer and may show an intro; wait for a menu.
    await page.waitForSelector('.page', { timeout: 90_000 });
    await sleep(900);
    // Skip anything covering the menu on the first run.
    for (const t of ['SKIP', 'Skip', 'Continue', 'Begin']) {
      if (await clickText(page, t)) await sleep(500);
    }

    const shot = async (name: string) => {
      await sleep(700);
      const file = `${vp.name}-${name}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: vp.name === 'portrait',
      });
      console.log('  ' + file);
    };

    const step = async (label: string, text: string) => {
      const ok = await clickText(page, text);
      if (!ok) { errors.push(`${vp.name}: could not reach "${text}" (${label})`); return false; }
      await sleep(1400);
      return true;
    };

    await shot('00-menu');
    if (!await step('menu', 'My Team')) { await page.close(); await context.close(); continue; }
    await shot('01-driver');
    if (!await step('driver', 'Next: the team')) { await page.close(); await context.close(); continue; }
    await shot('02-found');
    // Try a family and a colour, so the shot is not the default design.
    await page.evaluate(() => {
      const fams = [...document.querySelectorAll('.ps-family')];
      (fams[4] as HTMLElement | undefined)?.click();
    });
    await sleep(900);
    await shot('03-found-split');
    if (!await step('found', 'Enter the championship')) { await page.close(); await context.close(); continue; }
    await shot('04-hub');
    if (!await step('hub', 'Team HQ')) { await page.close(); await context.close(); continue; }
    await shot('05-hq');
    if (await step('hq', 'Engine deal')) await shot('06-engine');
    if (await step('engine', 'Back to the factory')) {
      if (await step('hq', 'Driver market')) await shot('07-market');
      if (await step('market', 'Back to the factory')) {
        if (await step('hq', 'Paint shop')) await shot('08-paint');
      }
    }
    await page.close();
    await context.close();
  }

  await browser.close();
  await server.close();

  console.log('\nshot to ' + OUT);
  if (errors.length > 0) {
    console.error('\nProblems:');
    for (const e of [...new Set(errors)]) console.error('  ' + e);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
