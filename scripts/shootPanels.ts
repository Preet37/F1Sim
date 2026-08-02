import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the full-screen panels.
 *
 * Separate from `shoot:hud` because the cost profile is completely different:
 * a HUD shot needs a circuit built under a software rasteriser and takes
 * minutes, and these pages have no 3D in them at all. Keeping them apart means
 * the panel sweep can be run after every tweak, which is what a design pass
 * actually needs.
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'panels');

const SHOTS: [string, string, string][] = [
  // panel, team, circuit — a low-abrasion circuit and an abrasive one, so the
  // strategist's recommendation is visibly different between the two shots.
  ['strategy', 'albion', 'silverstone'],
  ['strategy', 'apex', 'monaco'],
  ['strategy', 'brava', 'bahrain'],
];

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
  const url = `http://127.0.0.1:${addr.port}/audit/panels.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 5 * 60_000,
    args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });

  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('!!window.__panels', { timeout: 60_000 });

  // The HUD, over a flat backdrop and with no renderer — see `audit/panels.ts`.
  // This is the fast loop: "is the panel there, and where", answered in seconds
  // instead of the ten minutes a real circuit build costs.
  const HUD_SCENES = (process.env.SHOOT_SCENES ?? 'clear,pit-advice,safety-car,wet,in-box').split(',');
  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    for (const scene of HUD_SCENES) {
      await page.evaluate((s: string) => window.__panels.hud(s), scene);
      const file = `${vp.name}-hud-${scene}.png`;
      await page.screenshot({ path: resolve(OUT, file) as `${string}.png` });
      if (vp.name === 'desktop') {
        const report = await page.evaluate(() => window.__panels.hudReport());
        console.log('  ' + file + '  ' + JSON.stringify(report));
      } else {
        console.log('  ' + file);
      }
    }
  }
  // The HUD leaves its own root in the page; the panel shots need it gone.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!window.__panels', { timeout: 60_000 });

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    for (const [panel, team, circuit] of SHOTS) {
      await page.evaluate(
        (a: [string, string, string]) => window.__panels.show(a[0], a[1], a[2]),
        [panel, team, circuit] as [string, string, string],
      );
      await new Promise((r) => setTimeout(r, 250));
      const file = `${vp.name}-${panel}-${team}-${circuit}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: vp.name === 'portrait',
      });
      console.log('  ' + file);
    }
  }

  await browser.close();
  await server.close();
  console.log(`\nwrote ${OUT}`);
  if (errors.length) {
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  }
}

void main();
