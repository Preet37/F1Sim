import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page, type ElementHandle } from 'puppeteer-core';

/**
 * Photographs the front of house.
 *
 * The menu, the drivers rack, the settings tabs and the opening sequence are
 * the screens whose whole job is to look like something, and no assertion can
 * tell you whether they do. A probe can say the four tiles exist; it cannot say
 * that the car is behind them, that the light rig is lit in the right colour,
 * or that the title fits on a phone held sideways. So this is the design loop:
 * change something, run this, look.
 *
 * It runs the REAL app rather than an audit page, because half of what is being
 * looked at is a WebGL car standing behind the interface, and a static sheet
 * cannot have one.
 *
 *   npm run shoot:frontend
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'frontend');

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  // A phone held sideways: the hardest case, and the one the front page has to
  // fit into without scrolling.
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Clicks the first element matching a selector whose text contains `text`. */
async function clickText(page: Page, selector: string, text: string): Promise<boolean> {
  const handle = await page.evaluateHandle((sel: string, want: string) => {
    const all = [...document.querySelectorAll(sel)];
    return all.find((e) => (e.textContent ?? '').toLowerCase().includes(want.toLowerCase())) ?? null;
  }, selector, text);
  // `asElement()` is typed as `ElementHandle<Node>`, and `click()` needs an
  // `Element`. The evaluate above only ever returns things matched by a CSS
  // selector, so it is an Element in fact — the cast states what the query
  // already guarantees and cannot state in its own type.
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) return false;
  await el.click();
  await wait(420);
  return true;
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
  const base = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 5 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage',
      // The car is real WebGL and there is no GPU in here.
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    ],
  });

  const errors: string[] = [];

  for (const vp of VIEWPORTS) {
    const page: Page = await browser.newPage();
    page.on('pageerror', (e: Error) => errors.push(`${vp.name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${vp.name}: console ${m.text()}`);
    });
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });

    const shot = async (name: string) => {
      await page.screenshot({ path: `${OUT}/${vp.name}-${name}.png` as `${string}.png` });
      console.log(`  ${vp.name}-${name}.png`);
    };

    // --- A GENUINELY FIRST RUN -------------------------------------------
    // `?fresh=1` empties the profile index before anything is drawn, which is
    // the only honest way to photograph a first run.
    await page.goto(base + '?fresh=1&quality=low&introslow=8', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.intro, .screen .page', { timeout: 30000 });
    // Back to back, with no waits between. Under the software rasteriser a
    // single screenshot costs seconds, so any wait added here lands the second
    // frame after the sequence has already finished — which is how the first
    // version of this harness photographed the menu and labelled it "intro".
    await shot('01-intro-open');
    await shot('02-intro-mid');
    await shot('03-intro-late');
    // Skip the rest, which is also the check that the button works.
    await page.click('.intro-skip').catch(() => {});
    await page.waitForSelector('.screen .page', { timeout: 20000 });
    await wait(500);
    await shot('04-first-run-driver');

    // Make the driver, which is what lights the front end.
    const inputs = await page.$$('.screen .sg-field input');
    if (inputs.length >= 2) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type('Nadia');
      await inputs[1].click({ clickCount: 3 });
      await inputs[1].type('Okonkwo');
    }
    await wait(300);
    await shot('05-driver-made');
    await clickText(page, '.btn', 'Start driving');
    await page.waitForSelector('.mm', { timeout: 20000 });
    await wait(1600);
    await shot('06-menu');

    // --- THE REST OF THE FRONT END ---------------------------------------
    await clickText(page, '.mm-link', 'Drivers');
    await wait(700);
    await shot('07-drivers');
    await clickText(page, '.navback', '');
    await wait(600);

    await page.click('.mm-gear').catch(() => {});
    await page.waitForSelector('.set', { timeout: 20000 });
    await wait(500);
    await shot('08-settings-opposition');
    await clickText(page, '.set-tab', 'Driving');
    await shot('09-settings-driving');
    await clickText(page, '.set-tab', 'Audio');
    await shot('10-settings-audio');
    await clickText(page, '.set-tab', 'This device');
    await shot('11-settings-device');
    await clickText(page, '.set-tab', 'Weekend');
    await shot('12-settings-weekend');

    await page.close();
  }

  await browser.close();
  await server.close();

  if (errors.length > 0) {
    console.error('\nPage errors:');
    for (const e of [...new Set(errors)]) console.error('  ' + e);
    process.exit(1);
  }
  console.log('\nWritten to ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
