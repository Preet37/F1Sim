import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the REAL game, in a real browser, exactly as the player sees it.
 *
 * WHY THIS EXISTS ALONGSIDE `audit:circuits`
 *
 * The audit harness drives `Renderer` with a fixed `dt` of 1/60, which makes the
 * dynamic resolution scaler compute exactly 60fps and therefore never move. Its
 * PNGs are all shot at `resolutionScale = 1`. The game on a real machine settles
 * at 0.5 within two seconds and stays there, so the audit has been photographing
 * an image no player has ever been shown. This takes the browser's own
 * screenshot of the composited page instead: the upscale from the drawing buffer
 * to the display is included, because that upscale is the thing being judged.
 *
 * The scale is observed by letting the real game loop run first, and only then
 * is the loop taken over so the same frame comes back before and after a change.
 *
 * Usage:
 *   npx tsx scripts/probeSharpness.ts
 *   SHARP_ONLY=bahrain,spa SHARP_TAG=after npx tsx scripts/probeSharpness.ts
 *   SHARP_SCALES=0.5,1 npx tsx scripts/probeSharpness.ts
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

const CIRCUIT_IDS = process.env.SHARP_ONLY
  ? process.env.SHARP_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

/** Empty means "whatever the game itself settles on", which is the point. */
const FORCED_SCALES = (process.env.SHARP_SCALES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(Number);

const MODES = (process.env.SHARP_MODES ?? 'cockpit,chase').split(',').map((s) => s.trim());
const TAG = process.env.SHARP_TAG ?? 'shot';
const STEPS = Number(process.env.SHARP_STEPS ?? 5400);
const SETTLE_MS = Number(process.env.SHARP_SETTLE ?? 12000);
const HIDE_HUD = process.env.SHARP_HUD !== '1';
/** Entry index of the car the camera follows. Car 0 has nobody driving it. */
const FOCUS_CAR = Number(process.env.SHARP_CAR ?? 6);
const OUT_DIR = resolve(process.cwd(), 'sharp-out', TAG);

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

interface ShotRecord {
  file: string;
  circuit: string;
  mode: string;
  settledScale: number;
  shotScale: number;
  buffer: string;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  if (process.env.SHARP_SKIP_BUILD !== '1') {
    console.log('building...');
    await build({ logLevel: 'warn' });
  }
  const server: PreviewServer = await preview({
    preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn',
  });
  const addr = server.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 20 * 60_000,
    defaultViewport: null,
    args: [
      '--window-size=1600,1000', '--window-position=0,0', '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const page: Page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  await page.bringToFront();

  const manifest: ShotRecord[] = [];

  for (const id of CIRCUIT_IDS) {
    await page.goto(`${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7`, {
      waitUntil: 'load', timeout: 180_000,
    });
    await page.waitForFunction(
      "!!window.__game && window.__game.screen === 'racing'",
      { timeout: 300_000, polling: 250 },
    );

    // Let the game run normally first, purely to find out what the dynamic
    // resolution scaler settles on. That number is the whole point of the
    // exercise and it can only be observed by letting the real loop run with
    // real frame times.
    // Stop simulated time BEFORE the settle period, not after it.
    //
    // The renderer keeps drawing with a paused clock, which is all the
    // resolution scaler needs, but the physics no longer advances — so the
    // number of steps the world has taken when it is photographed does not
    // depend on how many frames the machine happened to manage during the
    // settle. Without this the "before" and "after" runs photographed
    // different cars in different places, and the comparison was worthless.
    await page.evaluate('window.__game.clock.paused = true');
    process.stdout.write(`${id}: racing, settling... `);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const settled = await page.evaluate('window.__game.renderer.resolutionScale') as number;
    process.stdout.write(`scale=${settled.toFixed(2)}, stepping ${STEPS}... `);

    // Now take the game's own loop out of the picture and drive the renderer
    // directly, so the shot is reproducible. Left to itself the deep-linked
    // player car has nobody driving it, and by the time the scene is worth
    // photographing it is parked against a barrier under a virtual safety car.
    await page.evaluate(`(() => {
      const g = window.__game;
      cancelAnimationFrame(g.rafHandle);
      for (let i = 0; i < ${STEPS}; i++) { g.engine.step(); if (g.engine.over) break; }
      // By ENTRY index, not by championship position. Position depends on the
      // race, and two builds being compared must be looking at the same car.
      g.__focus = g.engine.cars.find((c, i) => i >= ${FOCUS_CAR} && !c.retired)
        || g.engine.cars.find((c) => !c.retired) || g.engine.cars[0];
      Object.getPrototypeOf(g.renderer).updateResolutionScale = function () {};
      g.__spin = false;
      g.__draw = (n) => new Promise((res) => {
        const tick = () => {
          g.renderer.render(1 / 60, 1, g.engine, g.__focus);
          if (n-- > 0 && !g.__stop) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
    })()`);

    process.stdout.write('stepped\n');

    if (HIDE_HUD) {
      // The HUD is DOM, drawn by the compositor at full device resolution
      // whatever the WebGL buffer is doing. Leaving it in a sharpness
      // measurement would mean measuring the crispness of the text overlay and
      // calling it the crispness of the render.
      await page.evaluate(`(() => {
        const canvas = document.querySelector('canvas');
        const keep = new Set();
        for (let n = canvas; n; n = n.parentElement) keep.add(n);
        const walk = (el) => {
          for (const child of Array.from(el.children)) {
            if (child === canvas) continue;
            if (keep.has(child)) walk(child);
            else child.style.display = 'none';
          }
        };
        walk(document.body);
      })()`);
    }

    for (const mode of MODES) {
      await page.evaluate(`window.__game.renderer.director.setMode(${JSON.stringify(mode)})`);
      const scales = FORCED_SCALES.length ? FORCED_SCALES : [settled];
      for (const s of scales) {
        await page.evaluate(`(() => {
          const r = window.__game.renderer;
          r.resolutionScale = ${s}; r.resize();
        })()`);
        // Enough frames for the camera rig to damp onto its anchor.
        await page.evaluate('window.__game.__stop = false');
        await page.evaluate('window.__game.__draw(90)');
        const state = await page.evaluate(`(() => {
          const r = window.__game.renderer;
          const c = r.renderer.getContext();
          return { scale: r.resolutionScale, buf: c.drawingBufferWidth + 'x' + c.drawingBufferHeight };
        })()`) as { scale: number; buf: string };
        const box = await page.evaluate(`(() => {
          const r = document.querySelector('canvas').getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`) as { x: number; y: number; width: number; height: number };
        const name = `${id}-${mode}-s${s.toFixed(2)}.png`;
        // Keep drawing while the screenshot is taken: the context has no
        // preserveDrawingBuffer, so a canvas that has stopped drawing can be
        // captured empty.
        const drawing = page.evaluate('window.__game.__draw(100000)').catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
        const png = await page.screenshot({ clip: box, type: 'png' });
        await page.evaluate('window.__game.__stop = true');
        await drawing;
        await writeFile(resolve(OUT_DIR, name), png);
        manifest.push({
          file: name, circuit: id, mode,
          settledScale: settled, shotScale: state.scale, buffer: state.buf,
        });
        console.log(
          `${name.padEnd(32)} settled=${settled.toFixed(2)} ` +
          `shot=${state.scale.toFixed(2)} buffer=${state.buf}`,
        );
      }
    }
  }

  await writeFile(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await browser.close();
  await server.close();
  console.log(`\nwrote ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
