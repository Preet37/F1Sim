import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * The driver's-eye views, photographed and measured.
 *
 * `audit:circuits` sweeps everything and takes minutes per circuit, which is the
 * right tool for "is anything standing on the road" and the wrong one for
 * iterating on how the halo is framed. This shoots only the two views the halo
 * is in — cockpit and onboard T-cam — at BOTH aspect ratios that matter, plus a
 * blow-up of a mirror with a car parked behind so the reflection can be checked
 * rather than assumed, plus the frame cost of the mirror feeds.
 *
 * TWO ASPECT RATIOS, because the camera's field of view is vertical: a 2.17:1
 * phone in landscape and a 16:9 desktop see the same slice of world top to
 * bottom and a fifth more of it left to right. Every "how thick is the halo"
 * number is a fraction of frame WIDTH and is therefore a different number on
 * the two. The reference footage being matched against — Monoposto, 1280x589 —
 * is the phone shape, and so is the device the complaint came from.
 *
 * The measurements themselves are NOT taken here. Pixels off a rendered frame
 * cannot tell a halo from a barrier; `probe:framing` does the measuring from
 * the geometry, exactly, and this produces the pictures that show whether the
 * geometry's numbers mean what they claim.
 */

const DEFAULT_CIRCUITS = ['bahrain', 'monaco', 'spa', 'monza'];

const CIRCUIT_IDS = process.env.COCKPIT_ONLY
  ? process.env.COCKPIT_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CIRCUITS;

/** The two frame shapes. Phone-landscape first: it is the one complained about. */
const FRAMES: [string, number, number][] = [
  ['phone', 1280, 589],
  ['wide', 1280, 720],
];

/**
 * The three views that are inside the car, driver's eye first.
 *
 * It is the one the mirrors are readable in — the panes are 0.83m from the eye
 * rather than 1.52m and the hoop does not lie across them — so it is the one
 * whose mirror blow-ups are worth looking at first.
 */
const MODES = ['driver', 'cockpit', 'onboard-t'] as const;

const OUT_DIR = resolve(process.cwd(), 'cockpit-out');

interface Cost { ms: number; calls: number; triangles: number }

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

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

async function main(): Promise<void> {
  // Only the circuits about to be swept are cleared, so a mirrors-only run does
  // not throw away the framing shots it is meant to sit beside.
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of CIRCUIT_IDS) {
    if (process.env.COCKPIT_MIRRORS_ONLY) break;
    await rm(resolve(OUT_DIR, id), { recursive: true, force: true });
  }

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/index.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // The headless browser asks for a favicon the audit page does not have, on
    // every run, forever. A probe whose exit code is decided by that is a probe
    // whose exit code means nothing.
    const t = m.text();
    if (m.type() === 'error' && !t.includes('favicon') && !t.includes('404')) {
      errors.push(`console: ${t}`);
    }
  });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__audit', { timeout: 120_000 });

  const rows: string[] = [];

  for (const id of CIRCUIT_IDS) {
    process.stdout.write(`${id.padEnd(13)}`);
    const dir = resolve(OUT_DIR, id);
    await mkdir(dir, { recursive: true });
    await page.evaluate(`window.__audit.load(${JSON.stringify(id)})`);

    // `COCKPIT_MIRRORS_ONLY=1` skips the framing shots and goes straight to the
    // mirror proof. A full-frame shot under SwiftShader takes minutes; when the
    // question is only whether the panes have traffic in them, the six framing
    // shots are half an hour of pictures already taken.
    if (!process.env.COCKPIT_MIRRORS_ONLY) {
      for (const [frameName, w, h] of FRAMES) {
        await page.evaluate(`window.__audit.setFrame(${w}, ${h})`);
        for (const mode of MODES) {
          const png = await page.evaluate(
            `window.__audit.shootMode(${JSON.stringify(mode)})`,
          ) as string;
          await writePng(resolve(dir, `${frameName}-${mode}.png`), png);
        }
      }
    }

    // --- The mirror proof -------------------------------------------------
    // A car is put ten metres back and two metres over, which is where one sits
    // when it is lining a move up, and the mirror on that side is blown up. If
    // the pane is showing sky, or showing the road ahead, or showing the car on
    // the wrong side of the pane, this is where it is visible.
    //
    // +2 along the car's local +x, which is the side of the car that appears on
    // the LEFT of the screen — see `placeBehind` for why those are two separate
    // facts — so the blow-up below takes the left half of the frame.
    await page.evaluate(`window.__audit.setFrame(1280, 589)`);
    await page.evaluate(`window.__audit.placeBehind(10, 2)`);
    for (const mode of MODES) {
      if (!process.env.COCKPIT_MIRRORS_ONLY) {
        const png = await page.evaluate(
          `window.__audit.shootMode(${JSON.stringify(mode)})`,
        ) as string;
        await writePng(resolve(dir, `mirror-${mode}.png`), png);
      }
      // Both panes, found by projection and blown up about eight times, because
      // "there is a car in it" is not a question a sixty-pixel pane answers at
      // 1:1. The near one should have the rival in it and the far one should
      // not, which is also a check that the two are not showing the same feed.
      for (const [name, side] of [['near', 1], ['far', -1]] as const) {
        if (!process.env.COCKPIT_MIRRORS_ONLY) {
          const zoom = await page.evaluate(
            `window.__audit.shootMirror(${JSON.stringify(mode)}, ${side}, 200)`,
          ) as string;
          await writePng(resolve(dir, `mirror-${name}-${mode}.png`), zoom);
        }
        // And the feed itself, off the render target, with nothing in front of
        // it. The pane is a few dozen pixels across with the halo over part of
        // it; a photograph of the pane says whether you can SEE the mirror, and
        // this says whether the mirror is showing the car that is behind.
        const feed = await page.evaluate(
          `window.__audit.mirrorFeed(${JSON.stringify(mode)}, ${side})`,
        ) as string;
        await writePng(resolve(dir, `feed-${name}-${mode}.png`), feed);
      }
    }

    // --- Frame cost -------------------------------------------------------
    // Only on the first circuit. Under SwiftShader a timed frame takes seconds,
    // and the interesting number — how many draw calls and triangles a mirror
    // feed adds — does not vary from circuit to circuit in any way that eleven
    // measurements would reveal and four would not.
    if (id === CIRCUIT_IDS[0]) {
      const driver = await page.evaluate(`window.__audit.costMode('driver', 6)`) as Cost;
      const cockpit = await page.evaluate(`window.__audit.costMode('cockpit', 6)`) as Cost;
      const onboard = await page.evaluate(`window.__audit.costMode('onboard-t', 6)`) as Cost;
      const chase = await page.evaluate(`window.__audit.costMode('chase', 6)`) as Cost;
      for (const [name, c] of [
        ['chase (no mirrors)', chase], ['driver', driver],
        ['cockpit', cockpit], ['onboard-t', onboard],
      ] as const) {
        rows.push(
          `${name.padEnd(20)} ${c.calls.toFixed(0).padStart(5)} draw calls  ` +
          `${(c.triangles / 1000).toFixed(0).padStart(5)}k triangles  ${c.ms.toFixed(0).padStart(5)}ms`,
        );
      }
      rows.push(
        `mirror feed adds     ${(cockpit.calls - chase.calls).toFixed(0).padStart(5)} draw calls  ` +
        `${((cockpit.triangles - chase.triangles) / 1000).toFixed(0).padStart(5)}k triangles  ` +
        `${(cockpit.ms - chase.ms).toFixed(0).padStart(5)}ms  (high tier, one pane per frame)`,
      );
      rows.push(
        `driver's eye adds    ${(driver.calls - chase.calls).toFixed(0).padStart(5)} draw calls  ` +
        `${((driver.triangles - chase.triangles) / 1000).toFixed(0).padStart(5)}k triangles  ` +
        `${(driver.ms - chase.ms).toFixed(0).padStart(5)}ms  (mirrors AND cockpit interior)`,
      );
    }
    process.stdout.write('shot 8\n');
  }

  await browser.close();
  await server.close();

  console.log('');
  for (const r of rows) console.log(r);
  console.log(`\nwrote ${OUT_DIR}`);
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
