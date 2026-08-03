import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs a circuit dry and wet, in daylight and at night.
 *
 * WHY IT IS ITS OWN SCRIPT. `shoot:hud` photographs the HUD over a stub
 * renderer in `audit/hud.html`; this has to photograph the WORLD, through the
 * real game, with real weather, because the whole claim being checked is that
 * the road looks different when it rains. Nothing about that is visible in a
 * HUD harness.
 *
 * It also does the one thing no assertion in `probeWeather` can do: it proves
 * the shaders COMPILE. Every wet-weather term added to `SurfaceDetail` and to
 * the grade pass is injected GLSL, three.js reports a compile failure as a
 * console error and then silently draws nothing, and a probe running under node
 * has no GL context to find out. So every console error and page error is
 * collected and the script exits non-zero on any of them.
 *
 * A production build and `vite preview`, not the dev server, for the same
 * reason `probeRenderPerf` uses one: a dev-server module stall would show up as
 * a black frame and be blamed on the renderer.
 *
 *   npm run shoot:weather
 *   SHOOT_CIRCUITS=spa,bahrain npm run shoot:weather
 */

const OUT_ROOT = resolve(process.cwd(), 'weather-out');

/** Spa is the daylight case; Bahrain is the floodlit one. */
const CIRCUITS = (process.env.SHOOT_CIRCUITS ?? 'spa,bahrain').split(',');

/** Water depths to shoot. 0 is the control — it must look exactly as it did. */
const WETNESS = (process.env.SHOOT_WETNESS ?? '0,0.45,0.95').split(',').map(Number);

/**
 * Seconds of racing before the shutter.
 *
 * Long enough for the field to be spread out and moving, for spray to have
 * built up behind the cars, and for the resolution scaler to have settled. A
 * frame grabbed on the formation lap shows a stationary grid in the rain, which
 * is the one wet scene with no spray in it.
 */
const SETTLE_S = Number(process.env.SHOOT_SETTLE ?? 26);

const CAMERAS = (process.env.SHOOT_CAMERAS ?? 'chase,tv').split(',');

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

/** See `shootHud.ts`: Chrome asks for a favicon nobody has. */
function isBrowserNoise(url: string): boolean {
  return /\/favicon\.ico(\?|$)/.test(url);
}

interface Shot { label: string; file: string; note: string; }

async function main(): Promise<void> {
  await mkdir(OUT_ROOT, { recursive: true });

  await build({ logLevel: 'warn' });
  const server: PreviewServer = await preview({
    preview: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  const addr = server.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const base = `http://127.0.0.1:${addr.port}/`;

  // Headful and on the real GPU. Swiftshader would compile the shaders too, but
  // it would not tell us what they LOOK like — and the point of this script is
  // a picture somebody can judge.
  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 10 * 60_000,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1400,880',
    ],
  });

  const shots: Shot[] = [];
  const errors: string[] = [];

  for (const circuit of CIRCUITS) {
    for (const wet of WETNESS) {
      for (const cam of CAMERAS) {
        const page: Page = await browser.newPage();
        page.setDefaultTimeout(180_000);
        page.on('pageerror', (e) => errors.push(`${circuit} wet=${wet}: pageerror: ${e.message}`));
        page.on('console', (m) => {
          if (m.type() === 'error' && !isBrowserNoise(m.location().url ?? '')) {
            errors.push(`${circuit} wet=${wet}: console: ${m.text()}`);
          }
        });
        await page.setViewport({ width: 1400, height: 880, deviceScaleFactor: 2 });

        const url = `${base}?circuit=${circuit}&session=race&rolling=1&laps=5&seed=7&wet=${wet}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          '!!window.__game && window.__game.screen === "racing"', { timeout: 180_000 },
        );
        // The camera is set through the director rather than through the URL,
        // because there is no camera deep-link and adding one for a screenshot
        // script would be a game feature nobody asked for.
        await page.evaluate(`window.__game.renderer.director.setMode(${JSON.stringify(cam)})`);

        // Let the race run so the field spreads out and the spray builds.
        await new Promise((r) => setTimeout(r, SETTLE_S * 1000));

        // NOBODY IS DRIVING THE PLAYER'S CAR, so it is rear-ended within a lap
        // and a full-screen RETIRED dialog covers the circuit — which is what
        // the first run of this script photographed twelve times. Spectating is
        // the game's own answer to a retirement and it keeps the session
        // running with the cameras on the leaders, which is the shot wanted
        // here anyway.
        await page.evaluate(`(() => {
          const g = window.__game;
          if (g.retirementShown || (g.engine.playerCar && g.engine.playerCar.retired)) {
            g.spectating = true;
            if (typeof g.dismissRetirement === 'function') g.dismissRetirement();
          }
        })()`);
        await new Promise((r) => setTimeout(r, 6000));

        // What the simulation thinks, recorded alongside the picture so a shot
        // that looks dry can be told apart from a shot of a dry track.
        const state = await page.evaluate(`(() => {
          const e = window.__game && window.__game.engine;
          if (!e) return null;
          const w = e.weather;
          return {
            wetness: w.wetness, rain: w.rainRate, label: w.label,
            line: w.surface.meanLineWater, off: w.surface.meanOffWater,
            peak: w.surface.peakWater, trackTempC: w.trackTempC,
            scale: window.__game.renderer ? window.__game.renderer.resolutionScale : -1,
            fps: window.__game.renderer ? Math.round(window.__game.renderer.fps) : -1,
          };
        })()`) as Record<string, number | string> | null;

        const label = `${circuit}-wet${String(wet).replace('.', '')}-${cam}`;
        const file = resolve(OUT_ROOT, label + '.png');
        await page.screenshot({ path: file as `${string}.png` });
        const note = state
          ? `wetness ${Number(state.wetness).toFixed(3)} (${state.label}), rain ${Number(state.rain).toFixed(2)}, ` +
            `line ${Number(state.line).toFixed(3)} / off ${Number(state.off).toFixed(3)}, ` +
            `peak ${Number(state.peak).toFixed(3)}, track ${Number(state.trackTempC).toFixed(0)}C, ` +
            `${state.fps}fps at scale ${state.scale}`
          : 'no engine state';
        shots.push({ label, file, note });
        console.log(`  ${label.padEnd(30)} ${note}`);
        await page.close();
      }
    }
  }

  await browser.close();
  await server.close();

  const index = shots.map((s) =>
    `<figure><img src="${s.label}.png" style="width:100%"><figcaption>` +
    `<b>${s.label}</b><br>${s.note}</figcaption></figure>`).join('\n');
  await writeFile(resolve(OUT_ROOT, 'index.html'),
    `<style>body{background:#111;color:#ddd;font:13px system-ui;margin:0;padding:16px}` +
    `figure{margin:0 0 24px}figcaption{padding:6px 0}</style>` + index);

  console.log(`\n${shots.length} shots in ${OUT_ROOT}`);
  if (errors.length > 0) {
    console.log('\nBROWSER ERRORS (a shader that fails to compile shows up here ' +
      'and nowhere else):');
    for (const e of errors.slice(0, 30)) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('no console or page errors — every injected shader compiled');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
