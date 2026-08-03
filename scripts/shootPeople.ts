import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs every person and every room they appear in.
 *
 * The same instrument as `shoot:career` and `audit:car`, pointed at the cast.
 * The reason it exists rather than one screenshot: a face is not judged, it is
 * COMPARED. Eleven principals each look fine on their own and the complaint that
 * started this work — "why does it seem like the same person as the team
 * principal for all the teams" — is only visible when all eleven are on one
 * wall. So the default run is a contact sheet, and the scenes come after it.
 *
 *   npm run shoot:people
 *   SHOOT_PEOPLE=principals npm run shoot:people
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'people');

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  { name: 'phone', width: 844, height: 390 },
  { name: 'portrait', width: 390, height: 844 },
];

/** The sheets are reference walls, not screens: one wide shot each. */
const SHEETS = new Set(['sheet', 'principals', 'roles']);

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

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/people.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 5 * 60_000,
    args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });

  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('!!window.__people', { timeout: 60_000 });

  const SCENES = (process.env.SHOOT_PEOPLE
    ?? 'sheet,principals,roles,presser,podium,garage').split(',');

  for (const scene of SCENES) {
    for (const vp of VIEWPORTS) {
      if (SHEETS.has(scene) && vp.name !== 'desktop') continue;
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      const ok = await page.evaluate(
        (s: string) => window.__people.show(s), scene) as boolean;
      if (!ok) { console.log('  (no scene "' + scene + '")'); break; }
      // The fonts are two subsets and they load asynchronously; a portrait shot
      // before they arrive is a portrait of the fallback face.
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 220));
      const file = `${vp.name}-${scene}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: SHEETS.has(scene) || vp.name === 'portrait',
      });
      console.log('  ' + file);
    }
  }

  await browser.close();
  await server.close();

  if (errors.length > 0) {
    console.error('\nPage errors:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('\nshot to ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
