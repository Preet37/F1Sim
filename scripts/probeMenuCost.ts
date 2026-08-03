import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * WHAT THE LIVE MENU COSTS, AND THAT IT STOPS COSTING IT.
 *
 * The front page now renders a real car, a light rig and a reflection on its
 * own WebGL context, and that is a genuine expense on a machine that is about
 * to be asked for a race. Two things have to be true, and neither is provable
 * by looking at a screenshot:
 *
 *   1. THE MENU IS CHEAP ENOUGH TO SIT ON. It is a screen somebody reads for a
 *      minute at a time, so it draws at half the display's rate (`STAGE_FPS`)
 *      and the budget here is generous — but a menu that pegs a phone is a
 *      menu that heats it up before the session even starts.
 *
 *   2. IT COSTS NOTHING DURING A SESSION. This is the one that matters. A
 *      second GL context left alive behind a race is a render loop competing
 *      for the same GPU, and worse: browsers cap live contexts — Chrome at
 *      sixteen — and silently drop the OLDEST when the cap is passed, which
 *      would take out the context running the race rather than the one that
 *      leaked. `main.ts` funnels every screen build and every session start
 *      through `disposeStage` for exactly this reason. This asserts it, by
 *      counting the canvases that actually exist.
 *
 *   npm run probe:menucost
 */

const SECONDS = Number(process.env.MENU_SECONDS ?? 6);

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

let failures = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts the live GL canvases on the page, and the frame time the page sees.
 *
 * PASSED AS SOURCE, not as a function, which is what every other probe in this
 * directory does. The transpiler rewrites named inner functions to carry a
 * `__name` helper that exists in node and not in the page, so a closure handed
 * to `evaluate` dies with `__name is not defined` the moment it has a named
 * callback in it — which a requestAnimationFrame loop always does.
 */
async function measure(page: Page, seconds: number): Promise<{
  canvases: number; medianMs: number; frames: number;
}> {
  return await page.evaluate(`(async () => {
    const times = [];
    let last = performance.now();
    const deadline = last + ${seconds} * 1000;
    await new Promise((resolve) => {
      requestAnimationFrame(function step(t) {
        times.push(t - last);
        last = t;
        if (t < deadline) requestAnimationFrame(step);
        else resolve();
      });
    });
    times.sort((a, b) => a - b);
    return {
      // Every canvas in the document. The game's own is one; the stage adds a
      // second while a menu is up and must give it back.
      canvases: document.querySelectorAll('canvas').length,
      medianMs: times[Math.floor(times.length / 2)] || 0,
      frames: times.length,
    };
  })()`) as { canvases: number; medianMs: number; frames: number };
}

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const base = `http://127.0.0.1:${addr.port}/`;

  // HEADFUL, on the host GPU. Software GL says nothing useful about what a
  // menu costs, for the reason `probeRenderPerf` sets out at length.
  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 5 * 60_000,
    args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1280,800'],
  });
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\nThe menu');

  await page.goto(base + '?fresh=1&intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.screen .page', { timeout: 30000 });
  // Past the first-run driver screen, which has no 3D on it.
  const fields = await page.$$('.screen .sg-field input');
  if (fields.length >= 2) {
    await fields[0].click({ clickCount: 3 });
    await fields[0].type('Perf');
    await fields[1].click({ clickCount: 3 });
    await fields[1].type('Probe');
  }
  const start = await page.$$('.btn.primary');
  if (start.length > 0) await start[start.length - 1].click();
  await page.waitForSelector('.mm', { timeout: 30000 });
  await wait(1500);

  const menu = await measure(page, SECONDS);
  console.log(`     menu: ${menu.medianMs.toFixed(2)}ms median frame, `
    + `${menu.canvases} canvas(es), ${menu.frames} frames`);
  check(menu.canvases === 2,
    'the menu stands a car on a second canvas', String(menu.canvases));
  // 22ms is 45fps. The stage deliberately draws at half rate, so the page's own
  // frame loop should be nowhere near saturated by it.
  check(menu.medianMs < 22,
    'and the page still runs at better than 45fps while it does',
    menu.medianMs.toFixed(2) + 'ms');

  console.log('\nAnd during a session');

  // Straight into a race by deep link, which is the path every harness here
  // uses and the one a player takes out of the menu.
  await page.goto(base + '?circuit=bahrain&session=race&laps=2&intro=0',
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => (window as unknown as { __game?: { engine?: unknown } }).__game?.engine != null,
    { timeout: 120000 });
  await wait(3000);

  const race = await measure(page, SECONDS);
  console.log(`     race: ${race.medianMs.toFixed(2)}ms median frame, `
    + `${race.canvases} canvas(es), ${race.frames} frames`);
  check(race.canvases === 1,
    'THE MENU CANVAS IS GONE once a session is running', String(race.canvases));

  check(errors.length === 0, 'nothing threw (' + errors.join(' | ') + ')');

  await browser.close();
  await server.close();

  console.log('');
  if (failures > 0) {
    console.error(`probe:menucost — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('probe:menucost — the menu is live, and it hands the GPU back.');
}

main().catch((e) => { console.error(e); process.exit(1); });
