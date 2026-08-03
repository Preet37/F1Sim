import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import {
  TIER_PROFILES, applyOverrides, detectTier, normaliseGraphics, normaliseTier,
  resolveGraphics, type DeviceSignals, type GraphicsSettings, type QualityTier,
} from '../src/render/QualityTiers';
import { CIRCUITS } from '../src/data/tracks/circuits';

/**
 * DOES THE GRAPHICS SETTING REACH THE RENDERER?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PROBE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Issue #29, first line: `settings.quality` is read in `main.ts` and **assigned
 * nowhere**. That is the whole shape of the bug — a value that looks wired,
 * reads correctly, saves correctly, and never arrives. A screenshot cannot see
 * it. A unit test on `resolveGraphics` cannot see it either, because the
 * function was never the broken part.
 *
 * The only test that can see it is one that goes the whole way: write a
 * preference into the browser's own storage under the key `SaveManager` uses,
 * load the real `main.ts`, and then ask **the WebGL context** what it is doing.
 * Not `settings.quality`, not `renderer.features` — those are both upstream of
 * the wire and would agree with each other in a completely disconnected build.
 * The assertions below read:
 *
 *   - `gl.getContextAttributes().antialias`  — what the driver allocated
 *   - `renderer.shadowMap.enabled`           — three's own state
 *   - `post.composer !== null`               — whether a chain was allocated
 *   - `post.sceneSamples`                    — the composer target's samples
 *   - `getDrawingBufferSize()`               — the pixels being drawn
 *
 * PROVED IT CAN FAIL. Deleting the `graphics:` argument from the `new Renderer`
 * call in `main.ts` — the exact disconnection issue #29 describes — takes
 * section 2 from 24 ok to 12 FAIL, and section 3 from 8 ok to 6 FAIL. See the
 * PR body for the transcript.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not measure. It runs on swiftshader, and a software rasteriser says
 * nothing about frame time on a phone. `probe:renderperf` is the instrument
 * for cost; this one is the instrument for connectivity. Keeping them apart is
 * deliberate: a probe that needs a GPU is a probe nobody runs.
 *
 *   npm run probe:graphics
 *   GFX_CIRCUITS=1 npm run probe:graphics   # all eleven circuits too (slow)
 */

let failures = 0;
let checks = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  checks++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

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

const NAV_MS = Number(process.env.GFX_NAV_MS ?? 420_000);

const AUTO: GraphicsSettings = { post: 'auto', shadows: 'auto', msaa: 'auto', resolution: 'auto' };

// ===========================================================================
// 1. The decision, in node. No browser, no GL, no timing.
// ===========================================================================

console.log('\n1. What a tier means, and what a device is started on');

{
  // The tier table is the contract every gate in `src/render/` now reads.
  check(TIER_PROFILES.low.post === false && TIER_PROFILES.low.shadows === false
    && TIER_PROFILES.low.msaa === false, 'low withholds post, shadows and MSAA');
  check(TIER_PROFILES.medium.post === true && TIER_PROFILES.medium.shadows === false
    && TIER_PROFILES.medium.msaa === false,
    'medium is the post chain WITHOUT shadows or MSAA',
    'the two most expensive items measured');
  check(TIER_PROFILES.high.post && TIER_PROFILES.high.shadows && TIER_PROFILES.high.msaa,
    'high is everything');
  check(TIER_PROFILES.medium.detail === 'high',
    'medium builds full-detail geometry',
    'segment counts and texture sizes are a build-time cost, not a per-frame one');

  // THE HEADLINE. Every one of these is a phone, and none of them may be
  // pinned at `low` by detection any more. The old rule was
  // `touchPrimary || cores <= 4 ? 'low' : 'high'`, which put all four there.
  const phones: [string, DeviceSignals][] = [
    ['iPhone (Safari clamps cores to 4, no deviceMemory)',
      { cores: 4, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 3 }],
    ['iPad (same clamp, larger screen)',
      { cores: 4, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 2 }],
    ['2026 Android, 8 cores, 8GB',
      { cores: 8, touchPrimary: true, deviceMemoryGb: 8, devicePixelRatio: 3 }],
    ['midrange Android, 6 cores, 4GB',
      { cores: 6, touchPrimary: true, deviceMemoryGb: 4, devicePixelRatio: 2.5 }],
  ];
  for (const [name, d] of phones) {
    const t = detectTier(d);
    check(t !== 'low', `${name} does not start on low`, `starts on ${t}`);
  }

  // And the devices that genuinely are small still are. A tier system that
  // promoted everything would be the same bug with the sign flipped.
  check(detectTier({ cores: 2, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 2 }) === 'low',
    'a device admitting to two cores starts on low');
  check(detectTier({ cores: 8, touchPrimary: true, deviceMemoryGb: 2, devicePixelRatio: 2 }) === 'low',
    'a device stating 2GB of memory starts on low');
  check(detectTier({ cores: 16, touchPrimary: false, deviceMemoryGb: 32, devicePixelRatio: 2 }) === 'high',
    'a desktop with sixteen cores starts on high');
  check(detectTier({ cores: 4, touchPrimary: false, deviceMemoryGb: 8, devicePixelRatio: 1 }) === 'medium',
    'a four-core laptop starts on medium, not low',
    'it used to get the same image as a 2015 phone');

  // Overrides are independent of the tier. This is the thing a binary tier
  // could not express at all.
  const lowPlusPost = resolveGraphics('low', { ...AUTO, post: 'on' },
    { cores: 4, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 3 });
  check(lowPlusPost.tier === 'low' && lowPlusPost.post && !lowPlusPost.shadows && !lowPlusPost.msaa,
    'post can be forced on at the low tier without dragging shadows or MSAA with it');
  const highNoShadow = resolveGraphics('high', { ...AUTO, shadows: 'off' },
    { cores: 16, touchPrimary: false, deviceMemoryGb: 32, devicePixelRatio: 2 });
  check(highNoShadow.tier === 'high' && highNoShadow.post && !highNoShadow.shadows,
    'shadows can be forced off at the high tier');

  // `auto` must survive being the default; a first run must not get worse.
  const autoPhone = resolveGraphics('auto', AUTO,
    { cores: 4, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 3 });
  check(autoPhone.adaptive, 'auto marks itself adaptive, so the renderer measures it');
  check(!resolveGraphics('low', AUTO, { cores: 4, touchPrimary: true, deviceMemoryGb: 0, devicePixelRatio: 3 }).adaptive,
    'a stated tier is not adaptive');

  // Normalisation. A NaN here reaches `setPixelRatio` and produces a
  // zero-by-zero drawing buffer with no error anywhere.
  for (const junk of [NaN, null, undefined, 'full', Infinity, -3, {}]) {
    const g = normaliseGraphics({ resolution: junk });
    const ok = g.resolution === 'auto' || (typeof g.resolution === 'number'
      && g.resolution >= 0.5 && g.resolution <= 1);
    check(ok, `a resolution of ${JSON.stringify(junk)} normalises to something drawable`,
      String(g.resolution));
  }
  check(normaliseTier('ultra') === 'auto' && normaliseTier('high') === 'high'
    && normaliseTier(undefined) === 'auto',
    'an unknown tier on disk falls back to auto');
  // Old saves hold only these three. There is no version bump, so they must
  // all still mean what they meant.
  for (const old of ['auto', 'low', 'high']) {
    check(normaliseTier(old) === old, `a save holding quality='${old}' still reads as '${old}'`);
  }

  // The adaptive pass must be able to reach the top from the bottom and back.
  const chain = applyOverrides('medium', 'medium', true, AUTO);
  check(chain.detectedTier === 'medium' && chain.tier === 'medium',
    'a promoted tier keeps the detected tier as a separate fact');
}

// ===========================================================================
// 2 & 3. The wire, in a browser, read off the GL context.
// ===========================================================================

const SETTINGS_KEY = 'f1sim.settings';

interface GlState {
  tier: string;
  featPost: boolean; featShadows: boolean; featMsaa: boolean; featDetail: string;
  featMaxRes: number;
  /** Real state, not the settings object. */
  glAntialias: boolean;
  shadowMapEnabled: boolean;
  sunCastsShadow: boolean;
  composerAllocated: boolean;
  postEnabled: boolean;
  sceneSamples: number;
  pixelRatio: number;
  bufferW: number; bufferH: number;
  cssW: number; cssH: number;
  dpr: number;
  storedQuality: string;
  storedGraphics: string;
}

const READ_GL = `(() => {
  const g = window.__game;
  const r = g.renderer;
  const f = r.features;
  const gl = r.renderer.getContext();
  const attrs = gl.getContextAttributes() || {};
  const stored = JSON.parse(localStorage.getItem('${SETTINGS_KEY}') || '{}');
  return {
    tier: f.tier,
    featPost: !!f.post, featShadows: !!f.shadows, featMsaa: !!f.msaa,
    featDetail: f.detail, featMaxRes: f.maxResolutionScale,
    glAntialias: !!attrs.antialias,
    shadowMapEnabled: !!r.renderer.shadowMap.enabled,
    sunCastsShadow: !!r.sun.castShadow,
    composerAllocated: !!r.post.composer,
    postEnabled: !!r.post.enabled,
    sceneSamples: r.post.sceneSamples,
    pixelRatio: r.renderer.getPixelRatio(),
    bufferW: gl.drawingBufferWidth, bufferH: gl.drawingBufferHeight,
    cssW: r.canvas ? r.canvas.clientWidth : 0, cssH: r.canvas ? r.canvas.clientHeight : 0,
    dpr: window.devicePixelRatio || 1,
    storedQuality: String(stored.quality),
    storedGraphics: JSON.stringify(stored.graphics || null),
  };
})()`;

/**
 * Loads the game with a given settings object already in localStorage.
 *
 * THE SCRIPT IS REMOVED AGAIN, and that is not tidiness. `evaluateOnNewDocument`
 * registrations ACCUMULATE and every one of them runs on every subsequent
 * navigation, in registration order. Leaving them stacked meant the "first
 * run" case's `removeItem` fired on every load after it — so section 5's
 * reload found an empty store, fell back to `auto`, and reported a failure
 * that was entirely this harness's. Which is precisely the failure mode
 * PROJECT.md §3.2 warns about with the sign flipped: a probe reporting red for
 * a reason that is not the product's is as bad as one reporting green for a
 * broken feature, because the next person spends a day on the wrong thing.
 */
async function withStoredSettings<T>(
  page: Page, settings: Record<string, unknown> | null, body: () => Promise<T>,
): Promise<T> {
  const js = settings === null
    ? `try { localStorage.removeItem(${JSON.stringify(SETTINGS_KEY)}); } catch (e) {}`
    : `try { localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(JSON.stringify(settings))}); } catch (e) {}`;
  const handle = await page.evaluateOnNewDocument(js);
  try {
    return await body();
  } finally {
    await page.removeScriptToEvaluateOnNewDocument(handle.identifier);
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction('!!window.__game && !!window.__game.renderer',
    { timeout: NAV_MS, polling: 100 });
}

async function loadWith(
  page: Page, url: string, settings: Record<string, unknown>, query = '',
): Promise<GlState> {
  // Written under the key `SaveManager` actually uses, BEFORE the app loads.
  // Setting it after load and reloading would work too; this way the very
  // first `new Renderer` sees it, which is the moment the bug lived in.
  return await withStoredSettings(page, settings, async () => {
    // Generous, and finite. A deep-linked circuit build under swiftshader is
    // genuinely slow and gets slower in proportion to whatever else is on the
    // box; `GFX_NAV_MS` is there so a contended machine can be given room
    // without anybody being tempted to loosen an assertion instead.
    await page.goto(url + query, { waitUntil: 'load', timeout: NAV_MS });
    await settle(page);
    return await page.evaluate(READ_GL) as GlState;
  });
}

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars',
      // Software GL. This probe asserts what was ALLOCATED, never how fast it
      // is, so a rasteriser that behaves the same on every machine is exactly
      // what is wanted here.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=900,600',
    ],
  });
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });

  // -------------------------------------------------------------------------
  console.log('\n2. A stored tier reaches the GL context');
  // -------------------------------------------------------------------------

  const seen: Record<string, GlState> = {};
  for (const tier of ['low', 'medium', 'high'] as QualityTier[]) {
    const st = await loadWith(page, url, { quality: tier, graphics: AUTO });
    seen[tier] = st;
    const want = TIER_PROFILES[tier];
    console.log(`  --- stored quality='${tier}' ---`);
    check(st.tier === tier, `the renderer is on '${tier}'`, `reports '${st.tier}'`);
    check(st.composerAllocated === want.post && st.postEnabled === want.post,
      `the post chain is ${want.post ? 'allocated' : 'not allocated'}`,
      `composer=${st.composerAllocated}`);
    check(st.shadowMapEnabled === want.shadows && st.sunCastsShadow === want.shadows,
      `three's shadow map is ${want.shadows ? 'on' : 'off'} and the sun ${want.shadows ? 'casts' : 'does not cast'}`,
      `shadowMap=${st.shadowMapEnabled} sun=${st.sunCastsShadow}`);
    check(st.glAntialias === want.msaa,
      `the GL context was allocated with antialias=${want.msaa}`,
      `driver reports ${st.glAntialias}`);
    // The other home of MSAA. When the chain is on, the context attribute is
    // dead and this is the number that costs bandwidth.
    check(want.post ? st.sceneSamples === (want.msaa ? 4 : 0) : st.sceneSamples === 0,
      `the composer's scene target has ${want.post && want.msaa ? '4' : '0'} samples`,
      `sceneSamples=${st.sceneSamples}`);
    check(st.featDetail === want.detail, `the mesh detail level is '${want.detail}'`);
  }

  // The three must not be the same picture. This is the assertion that a
  // build with the setting disconnected cannot pass however it is written.
  const sig = (s: GlState) => `${s.postEnabled}/${s.shadowMapEnabled}/${s.glAntialias}`;
  check(new Set(['low', 'medium', 'high'].map((t) => sig(seen[t]))).size === 3,
    'the three tiers produce three different GL configurations',
    ['low', 'medium', 'high'].map((t) => `${t}=${sig(seen[t])}`).join('  '));

  // -------------------------------------------------------------------------
  console.log('\n3. Each switch overrides the tier on its own');
  // -------------------------------------------------------------------------

  {
    const st = await loadWith(page, url,
      { quality: 'low', graphics: { ...AUTO, post: 'on' } });
    check(st.tier === 'low' && st.postEnabled,
      'post forced ON at the low tier gives a low tier WITH a post chain',
      `tier=${st.tier} post=${st.postEnabled}`);
    check(!st.shadowMapEnabled && !st.glAntialias,
      'and does not drag shadows or MSAA along with it');
    check(st.sceneSamples === 0,
      'and the chain it allocated is not multisampled',
      `sceneSamples=${st.sceneSamples}`);
  }
  {
    const st = await loadWith(page, url,
      { quality: 'high', graphics: { ...AUTO, shadows: 'off' } });
    check(st.tier === 'high' && !st.shadowMapEnabled && !st.sunCastsShadow,
      'shadows forced OFF at the high tier reach three and the light',
      `shadowMap=${st.shadowMapEnabled}`);
    check(st.postEnabled && st.glAntialias,
      'and the rest of the high tier is untouched');
  }
  {
    const st = await loadWith(page, url,
      { quality: 'high', graphics: { ...AUTO, msaa: 'off' } });
    check(!st.glAntialias && st.sceneSamples === 0,
      'MSAA forced OFF reaches BOTH homes: the context and the composer target',
      `attrs=${st.glAntialias} sceneSamples=${st.sceneSamples}`);
  }
  {
    // The one that reaches the drawing buffer. A ceiling of 0.5 must halve the
    // pixel ratio the very first frame, not two seconds into the session when
    // the scaler first speaks.
    const st = await loadWith(page, url,
      { quality: 'high', graphics: { ...AUTO, resolution: 0.5 } });
    const expect = Math.min(st.dpr, 2.5) * 0.5;
    check(Math.abs(st.pixelRatio - expect) < 1e-3,
      'a 50% resolution limit halves the pixel ratio from the first frame',
      `pixelRatio=${st.pixelRatio.toFixed(3)} expected ${expect.toFixed(3)}`);
    check(Math.abs(st.bufferW - st.cssW * expect) <= 2,
      'and the drawing buffer really is that many pixels wide',
      `${st.bufferW} for a ${st.cssW}px canvas`);
  }

  // -------------------------------------------------------------------------
  console.log('\n4. A first run is still auto, and auto is not low');
  // -------------------------------------------------------------------------

  await withStoredSettings(page, null, async () => {
    // Nothing in storage at all: the state a new player is in.
    await page.goto(url, { waitUntil: 'load', timeout: NAV_MS });
    await settle(page);
    const st = await page.evaluate(READ_GL) as GlState;
    check(st.tier !== 'low',
      'a browser with no settings at all does not start on the lowest tier',
      `starts on '${st.tier}'`);
    const adaptive = await page.evaluate('window.__game.renderer.features.adaptive');
    check(adaptive === true, 'and it is adaptive, so the device gets measured');
  });

  // -------------------------------------------------------------------------
  console.log('\n4b. `auto` actually moves the tier when the frames say so');
  // -------------------------------------------------------------------------

  {
    // THE PART OF `auto` A WIRE TEST CANNOT SEE. Everything above proves a
    // stated preference arrives; none of it proves the half of `auto` that is
    // supposed to make a stated preference unnecessary. Since detection is
    // deliberately timid — a phone starts at `medium`, not `high` — a broken
    // promotion would leave every phone one tier short forever and every
    // assertion above would still be green.
    //
    // `updateAutoTier` is driven directly with a frame cost rather than by
    // waiting for the machine to produce one. Waiting would make this probe a
    // measurement of the machine it happens to run on, which under swiftshader
    // is a machine that can never promote anything.
    await loadWith(page, url, { quality: 'auto', graphics: AUTO });
    const drive = (tier: string, med: number, seconds: number) => `(() => {
      const r = window.__game.renderer;
      // Put it on a known tier, adaptive, with the resolution scaler at its
      // ceiling — which is one of the three conditions for a promotion.
      r.applyResolved(Object.assign({}, r.features, {
        tier: ${JSON.stringify(tier)},
        post: ${JSON.stringify(tier)} !== 'low',
        shadows: ${JSON.stringify(tier)} === 'high',
        msaa: false, adaptive: true,
      }));
      r.resolutionScale = 1; r.climbCeiling = 1;
      r.sessionTime = 1000; r.lastTierMoveAt = -1e9; r.comfortableFor = 0;
      for (let i = 0; i < ${seconds} * 60; i++) r.updateAutoTier(1 / 60, ${med});
      return r.features.tier;
    })()`;

    const promoted = await page.evaluate(drive('low', 12, 12));
    check(promoted === 'medium',
      'twelve seconds of 12ms frames at the ceiling promotes low -> medium',
      `ended on '${promoted}'`);

    const notYet = await page.evaluate(drive('low', 12, 4));
    check(notYet === 'low',
      'four seconds is not enough — a promotion needs 8s of evidence',
      `ended on '${notYet}'`);

    const tooSlow = await page.evaluate(drive('low', 18, 30));
    check(tooSlow === 'low',
      'thirty seconds of 18ms frames does NOT promote',
      `18ms is under the display's 16.7ms budget but over AUTO_PROMOTE_MS; ended on '${tooSlow}'`);

    // Demotion only once the resolution scaler has given up, because giving up
    // pixels is measurably cheaper AND cleaner than giving up the chain.
    const heldAtCeiling = await page.evaluate(`(() => {
      const r = window.__game.renderer;
      r.applyResolved(Object.assign({}, r.features, {
        tier: 'high', post: true, shadows: false, msaa: false, adaptive: true,
      }));
      r.resolutionScale = 1; r.climbCeiling = 1;
      r.sessionTime = 1000; r.lastTierMoveAt = -1e9;
      for (let i = 0; i < 1800; i++) r.updateAutoTier(1 / 60, 40);
      return r.features.tier;
    })()`);
    check(heldAtCeiling === 'high',
      '40ms frames do NOT cost a tier while the resolution scaler still has room',
      `ended on '${heldAtCeiling}'`);

    const demoted = await page.evaluate(`(() => {
      const r = window.__game.renderer;
      r.applyResolved(Object.assign({}, r.features, {
        tier: 'high', post: true, shadows: false, msaa: false, adaptive: true,
      }));
      r.resolutionScale = 0.5; r.climbCeiling = 0.5;
      r.sessionTime = 1000; r.lastTierMoveAt = -1e9;
      const seen = [];
      for (let i = 0; i < 3600; i++) {
        r.sessionTime += 1 / 60;
        r.updateAutoTier(1 / 60, 40);
        if (seen[seen.length - 1] !== r.features.tier) seen.push(r.features.tier);
      }
      return seen.join('>');
    })()`);
    check(demoted === 'high>medium>low',
      '40ms frames WITH the scaler at its floor walk the tier all the way down',
      `saw ${demoted}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n5. The Settings screen changes it, live, and it persists');
  // -------------------------------------------------------------------------

  {
    // Through the REAL screen, by clicking the real buttons. The issue is as
    // much "there is no in-game way to ask" as it is "the value never
    // arrives", and only the DOM can answer the first half.
    await page.evaluate("window.__game.showSettings()");
    await page.waitForFunction("!!document.querySelector('.set-rail')", { timeout: 30_000 });
    const opened = await page.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.set-tab'));
      const v = tabs.find((b) => b.textContent.trim() === 'Video');
      if (!v) return false;
      v.click();
      return true;
    })()`);
    check(opened === true, 'there is a Video tab on the settings rail');

    const before = await page.evaluate(READ_GL) as GlState;
    const clicked = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.opt'));
      const row = rows.find((r) => (r.querySelector('.opt-name') || {}).textContent === 'Quality');
      if (!row) return 'no Quality row';
      const b = Array.from(row.querySelectorAll('.opt-choice'))
        .find((x) => x.textContent.trim() === 'Medium');
      if (!b) return 'no Medium button';
      b.click();
      return 'ok';
    })()`);
    check(clicked === 'ok', 'the Quality row offers Medium', String(clicked));

    const after = await page.evaluate(READ_GL) as GlState;
    check(after.tier === 'medium',
      'clicking Medium moves the renderer to medium THERE AND THEN',
      `${before.tier} -> ${after.tier}`);
    check(after.postEnabled && after.composerAllocated,
      'and the post chain was allocated without reloading anything');
    check(after.storedQuality === 'medium',
      'and it was written to storage under the key SaveManager reads',
      `stored quality=${after.storedQuality}`);

    // Now a switch, on the same screen, on top of the tier.
    const sw = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.opt'));
      const row = rows.find((r) => (r.querySelector('.opt-name') || {}).textContent === 'Shadows');
      if (!row) return 'no Shadows row';
      const b = Array.from(row.querySelectorAll('.opt-choice'))
        .find((x) => x.textContent.trim() === 'On');
      if (!b) return 'no On button';
      b.click();
      return 'ok';
    })()`);
    check(sw === 'ok', 'the Video tab has an independent Shadows switch', String(sw));
    const withShadow = await page.evaluate(READ_GL) as GlState;
    check(withShadow.shadowMapEnabled && withShadow.sunCastsShadow,
      'forcing shadows on at medium reaches three without ending the session',
      `shadowMap=${withShadow.shadowMapEnabled}`);
    check(withShadow.tier === 'medium',
      'and the tier itself did not move');
    check(/"shadows":"on"/.test(withShadow.storedGraphics),
      'and the override persisted', withShadow.storedGraphics);

    // Survives a reload. The spread-over-defaults path in `loadSettings` is
    // where a new nested field usually goes missing.
    await page.goto(url, { waitUntil: 'load', timeout: NAV_MS });
    await settle(page);
    const reloaded = await page.evaluate(READ_GL) as GlState;
    check(reloaded.tier === 'medium' && reloaded.shadowMapEnabled,
      'and both survive a reload',
      `tier=${reloaded.tier} shadows=${reloaded.shadowMapEnabled}`);
  }

  // -------------------------------------------------------------------------
  // 6. Eleven circuits. Every rendering fix in this project's history was
  // verified on one and shipped broken on the rest (PROJECT.md §3.5).
  // -------------------------------------------------------------------------

  if (process.env.GFX_CIRCUITS === '1') {
    console.log('\n6. The tier survives a session build, on all eleven circuits');
    let timedOut = 0;
    for (const c of CIRCUITS) {
      // ONE CIRCUIT'S HARNESS TIMEOUT MUST NOT DELETE THE OTHER TEN. Building a
      // circuit under swiftshader on a machine that is already running other
      // agents took Monaco past three minutes and threw out of `main`, so the
      // run reported two circuits and an exception — which is exactly the
      // "verified on one circuit" failure this section exists to prevent,
      // arriving by a different route. A circuit that cannot be loaded is
      // reported as a failure with its reason, and the sweep carries on.
      try {
        await loadWith(page, url, { quality: 'medium', graphics: AUTO },
          `?circuit=${c.id}&session=practice&duration=60`);
        await page.waitForFunction("window.__game.screen === 'racing'",
          { timeout: 300_000, polling: 250 });
      } catch (e) {
        timedOut++;
        check(false, `${c.id}: the session could not be loaded to be checked`,
          String(e).split('\n')[0]);
        continue;
      }
      const live = await page.evaluate(READ_GL) as GlState;
      check(live.tier === 'medium' && live.postEnabled && live.featDetail === 'high'
        && !live.shadowMapEnabled,
        `${c.id}: medium survives building the circuit`,
        `tier=${live.tier} post=${live.postEnabled} detail=${live.featDetail} shadows=${live.shadowMapEnabled}`);
    }
    if (timedOut > 0) {
      console.log(`\n  NOTE: ${timedOut} circuit(s) never finished loading. Under software`);
      console.log('  GL that is usually the machine rather than the renderer — check the');
      console.log('  load average and re-run before reading it as a defect.');
    }
  } else {
    console.log('\n6. Eleven circuits — skipped. Set GFX_CIRCUITS=1 to run.');
  }

  await browser.close();
  await server.close();

  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of new Set(errors)) console.log('  ' + e);
    // A page error during a graphics probe is very often the graphics probe's
    // subject — a disposed texture, a feedback loop, a target that was rebuilt
    // at the wrong size — so it fails rather than being printed and ignored.
    failures += new Set(errors).size;
  }

  console.log(`\n${checks - failures} ok, ${failures} failed, ${checks} checks\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
