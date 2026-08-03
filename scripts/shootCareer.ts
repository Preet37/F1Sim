import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the career screens.
 *
 * The portrait is drawn, and a drawing cannot be verified by a probe: an
 * assertion can say that eight paths were emitted and cannot say that the
 * helmet looks like a helmet. So this is the design loop — change a curve, run
 * this, look. It is seconds, because none of these screens has any 3D in them.
 *
 *   npm run shoot:career
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'career');

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  { name: 'phone', width: 844, height: 390 },
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

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/career.html`;

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
    // See `shootPanels.ts`: matched on the URL, because the message for a
    // missing favicon and a missing module are the same string.
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('!!window.__career', { timeout: 60_000 });

  const SCENES = (process.env.SHOOT_CAREER ?? 'sheet,create,podium,hub').split(',');

  for (const scene of SCENES) {
    for (const vp of VIEWPORTS) {
      // The portrait sheet is a reference contact sheet, not a screen; it only
      // needs the one wide shot.
      if (scene === 'sheet' && vp.name !== 'desktop') continue;
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      const ok = await page.evaluate(
        (s: string) => window.__career.show(s), scene) as boolean;
      if (!ok) { console.log('  (no scene "' + scene + '")'); break; }
      await new Promise((r) => setTimeout(r, 200));
      const file = `${vp.name}-${scene}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: scene === 'sheet' || vp.name === 'portrait',
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
