import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the real HUD over the real renderer.
 *
 * `audit:circuits` sweeps the WORLD and leaves the HUD out on purpose. This is
 * the other half: the same headless Chrome and the same Vite server, pointed at
 * `audit/hud.html`, which mounts the game's own `Hud` over the game's own
 * `Renderer`. Every shot is the actual product, not a mock of it.
 *
 * Three axes, because a HUD panel fails on any of them independently:
 *
 *   LIGHT     a bright daytime circuit and a night one. A panel that reads on
 *             Bahrain at night can vanish on Silverstone at noon.
 *   VIEWPORT  a desktop window and a landscape phone. This repo has a history
 *             of HUD panels running off the bottom of a 390px-tall screen.
 *   STATE     the panels only exist in a state — a safety car, a pit call, a
 *             burst of race control. Waiting for one to happen is not a method,
 *             so `audit/hud.ts` forces them.
 *
 * Output lands in `hud-out/<tag>/`, plus a contact index. Nothing here asserts;
 * it produces evidence. `probe:hudtext` is where the assertions live.
 *
 *   SHOOT_TAG=before npm run shoot:hud     name the run
 *   SHOOT_SCENES=clear,safety-car          narrow it while iterating
 */

const OUT_ROOT = resolve(process.cwd(), 'hud-out');
const TAG = process.env.SHOOT_TAG ?? 'shot';

/** Bahrain runs at night; Silverstone is the bright daytime case. */
const CIRCUITS = (process.env.SHOOT_CIRCUITS ?? 'silverstone,bahrain').split(',');

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  { name: 'phone', width: 844, height: 390 },
];

/** Which forced states to shoot. Every panel appears in at least one. */
const SCENES = (process.env.SHOOT_SCENES ?? 'clear,pit-advice,safety-car,wet,radio-burst,in-box')
  .split(',');

/** Camera modes shot for the occlusion check, on the desktop viewport only. */
const CAMERAS = (process.env.SHOOT_CAMERAS ?? 'chase,cockpit,bumper,tv,drone,trackside')
  .split(',').filter(Boolean);

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

interface Shot { label: string; file: string; }

/**
 * Console errors the BROWSER makes, not the page.
 *
 * Chrome asks every document for `/favicon.ico` whether or not one is
 * referenced, and neither harness page has one — so the sweep failed on every
 * run it has ever made, including the completely clean ones. A script that
 * always exits non-zero is a script whose exit code nobody reads any more,
 * which is worse than having no check at all. Everything else stays fatal.
 */
/**
 * Decided on the URL that failed, not on the message.
 *
 * The console text is identical for a missing favicon and a missing module —
 * "Failed to load resource: the server responded with a status of 404" — and
 * does not name the resource, so no text rule can separate them. An earlier
 * version tried, by excluding messages mentioning `.ts`/`.js`/`.css`; since
 * the extension never appears in the text either, that test was always true
 * and the filter swallowed every 404 there is, including the one case this
 * sweep exists to catch. `m.location().url` is the field that distinguishes.
 */
function isBrowserNoise(url: string): boolean {
  return /\/favicon\.ico(\?|$)/.test(url);
}

async function main(): Promise<void> {
  const outDir = resolve(OUT_ROOT, TAG);
  await mkdir(outDir, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/hud.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new',
      '--no-sandbox',
      '--hide-scrollbars',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--window-size=1400,900',
    ],
  });

  const shots: Shot[] = [];
  const errors: string[] = [];

  /**
   * The page, and the ability to get it back.
   *
   * A renderer process driving swiftshader for twenty minutes and being
   * screenshotted a hundred times does occasionally die, and it did — halfway
   * through the first circuit, taking the sweep with it. A sweep that has to
   * be babysat is a sweep nobody runs, so a dead target is treated as a cost
   * (rebuild the circuit) rather than as a failure.
   */
  let page!: Page;
  let built = '';

  const openPage = async (): Promise<void> => {
    page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !isBrowserNoise(m.location().url ?? '')) {
        errors.push(`console: ${m.text()}`);
      }
    });
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('!!window.__hudShoot', { timeout: 120_000 });
    built = '';
  };

  const build = async (circuit: string): Promise<void> => {
    if (built === circuit) return;
    await page.evaluate((c: string) => window.__hudShoot.load(c), circuit);
    built = circuit;
  };

  /** Runs a step; on a dead target, rebuilds everything and runs it once more. */
  const guarded = async (circuit: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Target closed|Session closed|detached/i.test(msg)) throw e;
      errors.push(`target died, rebuilding ${circuit}: ${msg}`);
      process.stdout.write(' [target died, rebuilding] ');
      try { await page.close(); } catch { /* already gone */ }
      await openPage();
      await build(circuit);
      await step();
    }
  };

  await openPage();

  const take = async (label: string): Promise<void> => {
    const file = `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    await page.screenshot({ path: resolve(outDir, file) as `${string}.png` });
    shots.push({ label, file });
  };

  // Circuits outermost: building one under a software rasteriser is the
  // expensive part of this sweep by two orders of magnitude, so it happens
  // once and every viewport is photographed off the same build.
  for (const circuit of CIRCUITS) {
    process.stdout.write(`${circuit.padEnd(13)} building…`);
    await guarded(circuit, () => build(circuit));

    for (const vp of VIEWPORTS) {
      for (const scene of SCENES) {
        await guarded(circuit, async () => {
          await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
          await page.evaluate((s: string) => window.__hudShoot.scene(s as never), scene);
          await page.evaluate(() => window.__hudShoot.repaint());
          await take(`${vp.name} ${circuit} ${scene}`);
          if (process.env.SHOOT_REPORT) {
            const t = await page.evaluate(() => window.__hudShoot.readText());
            console.log(`\n  ${vp.name}/${scene}: ${JSON.stringify(t)}`);
          }
        });
      }
    }

    // Camera sweep, on the desktop viewport: is anything sitting on the road
    // in any view? This is the check the whole left-rail move exists to pass.
    for (const cam of CAMERAS) {
      await guarded(circuit, async () => {
        await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
        await page.evaluate(() => window.__hudShoot.scene('clear' as never));
        await page.evaluate((c: string) => window.__hudShoot.camera(c as never), cam);
        await page.evaluate(() => window.__hudShoot.advance(1.2));
        await take(`desktop ${circuit} cam-${cam}`);
      });
    }
    await guarded(circuit, () => page.evaluate(() => window.__hudShoot.camera('chase' as never)));
    process.stdout.write(' done\n');
  }
  await page.close();

  await writeFile(resolve(outDir, 'index.html'), indexPage(TAG, shots), 'utf8');
  await browser.close();
  await server.close();

  console.log(`\nwrote ${outDir}/index.html  (${shots.length} shots)`);
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  }
}

function indexPage(tag: string, shots: Shot[]): string {
  const cards = shots.map((s) =>
    `<figure><img src="${s.file}" loading="lazy"><figcaption>${s.label}</figcaption></figure>`).join('\n');
  return `<!DOCTYPE html><meta charset="utf-8"><title>HUD — ${tag}</title>
<style>
  body { background:#0b0f14; color:#dfe6ef; font:13px/1.4 ui-monospace,monospace; margin:20px; }
  h1 { font-size:15px; letter-spacing:.14em; text-transform:uppercase; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(460px,1fr)); gap:16px; }
  figure { margin:0; }
  img { width:100%; display:block; border:1px solid #2a3542; border-radius:4px; }
  figcaption { padding:6px 2px; color:#8fa0b4; }
</style>
<h1>HUD — ${tag}</h1>
<div class="grid">${cards}</div>`;
}

void main();
