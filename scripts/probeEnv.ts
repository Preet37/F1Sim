import { existsSync } from 'node:fs';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * IS THE THING WE SAY IS LIGHTING THE SCENE ACTUALLY LIGHTING THE SCENE?
 * Issue #78.
 *
 * Two claims land with that issue and both of them are, by construction,
 * capable of being false without anything visibly breaking:
 *
 *  1. **A captured CC0 sky is the environment map.** It is fetched over HTTP
 *     from `public/assets/hdri/`, which `.gitignore` excludes and
 *     `scripts/fetchAssets.ts` regenerates. `EnvProbe` installs the generated
 *     probe first and swaps the capture in when it arrives, and on a 404 it
 *     resolves `null` and says nothing — deliberately, because a clean clone
 *     must still light its scene. Every one of those decisions is right, and
 *     together they mean **a build where the HDRI never loaded looks fine, runs
 *     fine, and is indistinguishable from a success unless something asks.**
 *  2. **A night circuit has light masts.** They are gated on
 *     `track.def.ambience === 'night'` and every mast is placed by a walk
 *     against the keep-out field that is allowed to give up. A circuit where
 *     every walk failed builds a `FloodlightTowers` with a count of zero, adds
 *     an empty group to the scene, and throws nothing.
 *
 * PROJECT.md section 3.2: a probe a broken feature passes is worse than no
 * probe. This is the probe that asks.
 *
 * It runs the REAL built application in a real browser, not a unit harness,
 * because both claims are about what happens after a network fetch inside a
 * running session and neither is observable anywhere else.
 */

const CASES: { circuit: string; expectHdri: string; expectMasts: 'some' | 'none' }[] = [
  // Night, and the frame `reference/target/90.png` specifies. It expects the
  // GENERATED probe, not a capture: `EnvProbe.HDRI_FOR.night` is null on
  // purpose, because the only CC0 night sky in the fetched set is a rural
  // starfield and the analytic probe models a floodlight ring. Asserting the
  // generated probe here is what stops that decision being undone by accident.
  { circuit: 'bahrain', expectHdri: 'generated', expectMasts: 'some' },
  // Day, and the frame `reference/target/76.png` specifies.
  { circuit: 'zandvoort', expectHdri: 'hdri:partly_cloudy', expectMasts: 'none' },
  // A street circuit at night: the masts are expected to be FEW or none,
  // because a 36m tower does not fit beside a road with buildings on it, and
  // the probe records which rather than asserting a number it made up.
  { circuit: 'jeddah', expectHdri: 'generated', expectMasts: 'some' },
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
  if (process.env.ENV_SKIP_BUILD !== '1') {
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
    protocolTimeout: 10 * 60_000,
    defaultViewport: null,
    args: ['--window-size=900,600', '--hide-scrollbars'],
  });
  const page: Page = await browser.newPage();
  page.setDefaultTimeout(300_000);

  const results: { ok: boolean; line: string }[] = [];
  const say = (ok: boolean, line: string): void => {
    results.push({ ok, line });
  };

  console.log('\nWHAT IS LIGHTING THE SCENE\n');
  for (const c of CASES) {
    await page.goto(`${url}?circuit=${c.circuit}&session=race&rolling=1&laps=3&seed=7`, {
      waitUntil: 'load', timeout: 180_000,
    });
    await page.waitForFunction(
      "!!window.__game && window.__game.screen === 'racing'",
      { timeout: 300_000, polling: 250 },
    );
    if (c.expectHdri !== 'generated') {
      // The capture is a 5-7MB Radiance file decoded on the main thread and
      // then PMREM-filtered. Poll rather than guess a delay.
      await page.waitForFunction(
        "window.__game.renderer.environmentSource !== 'generated'",
        { timeout: 120_000, polling: 250 },
      ).catch(() => { /* reported below as a failure, not thrown here */ });
    } else {
      // Give a capture that should NOT arrive time to arrive anyway, so this
      // case can fail rather than pass by being asked too early.
      await new Promise((r) => setTimeout(r, 8000));
    }

    const got = await page.evaluate(`({
      env: window.__game.renderer.environmentSource,
      masts: window.__game.renderer.floodlightCount,
    })`) as { env: string; masts: number };

    console.log(`  ${c.circuit.padEnd(12)} environment ${got.env.padEnd(20)} masts ${got.masts}`);

    say(got.env === c.expectHdri,
      `${c.circuit}: environment is ${got.env} (want ${c.expectHdri})`);
    say(c.expectMasts === 'some' ? got.masts > 0 : got.masts === 0,
      `${c.circuit}: ${got.masts} light masts (want ${c.expectMasts === 'some' ? '> 0' : '0'})`);
  }

  console.log('');
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.line}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed} ok / ${failed} failed`);

  await browser.close();
  await server.close();
  if (failed) process.exit(1);
}

void main();
