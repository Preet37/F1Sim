import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import {
  AUTO_DEMOTE_MS, AUTO_LATCH_AFTER_DEMOTIONS, AUTO_PROMOTE_AFTER_S, AUTO_PROMOTE_MS,
  AUTO_VERDICT_S, AutoTierPolicy, tierNoticeFor,
  type AutoTierMove, type QualityTier,
} from '../src/render/QualityTiers';

/**
 * DOES THE PICTURE COME BACK? Issue #73.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 *
 * > *"everything is very grainy again and like you can't really see anything
 * > in front of you to a high quality its pixelated and idk why its like
 * > that"*
 *
 * Six headless Chromes were running on the reporting user's machine, at load
 * average measured between 17 and 148, while they played. Their frame time
 * rose. The resolution scaler gave up pixels first, which is correct and is
 * the ordering `AUTO_DEMOTE_MS` exists to guarantee. Then `updateAutoTier`
 * did this:
 *
 *     if (med > AUTO_DEMOTE_MS && this.resolutionScale <= MIN_SCALE + 1e-6) {
 *       const down = tierBelow(this.features.tier);
 *       if (!down) return;
 *       this.autoLatchedCeiling = this.features.tier;   // never tried again
 *       this.moveTier(down);
 *     }
 *
 * `high` -> `medium`, latching `high` out. Then `medium` -> `low`, latching
 * `medium` out. And the promotion path refused to undo either:
 *
 *     if (!up || up === this.autoLatchedCeiling) return;
 *
 * They finished the session on `low`, which #29 itself measured at **20.3
 * horizon / 63.6 mid-distance grain against `high`'s 1.2 / 14.8 — 16x and 4.3x
 * more speckle** (PROJECT.md §6). The load went away; the picture did not come
 * back; nothing on screen said it had happened.
 *
 * Two independent faults, and the fix needs both:
 *
 *   1. **One window's evidence.** `med` is a trimmed mean over 45 frames —
 *      about three quarters of a second. That is what a permanent decision was
 *      taken on.
 *   2. **A one-way latch.** The FIRST failure of a tier retired it for the
 *      rest of the page load.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROBE DOES, AND WHY IT IS BUILT THE WAY IT IS
 * ---------------------------------------------------------------------------
 *
 * §1-§4 drive the REAL decision — `AutoTierPolicy` in `QualityTiers.ts`, the
 * same object the renderer holds — off synthetic frame costs, in node, with no
 * GL. That is possible only because the rule was moved out of `Renderer` into a
 * module of its own, which is the `RenderPose.ts` precedent (PROJECT.md §6,
 * issue #54): a probe that reimplements the rule it is checking proves nothing.
 *
 * §5 and §6 then close the gap that leaves, because a policy object nothing
 * calls would pass §1-§4 perfectly. §5 loads the real game in a real browser
 * and drives `Renderer.feedFrameCost` — the real policy, the real `moveTier`,
 * the real `applyResolved` — then reads **the GL context**, exactly as
 * `probe:graphics` does: `shadowMap.enabled`, whether a composer was
 * allocated, the context's `antialias`. A tier that "came back" without the
 * shadow map coming back with it has not come back.
 *
 * §6 asserts by source inspection that `Renderer.ts` holds no second copy of
 * the decision, so §1-§4 cannot drift away from what ships.
 *
 * PROVED IT GOES RED. Restoring the old rule verbatim inside
 * `AutoTierPolicy.update` — demote on one window, latch on the first failure —
 * takes this from 41 ok / 0 failed to 27 ok / 14 failed, and the first line of
 * the transcript is the user's session:
 *
 *     FAIL  the tier comes back when the load goes away  — stuck on low
 *
 * Run: npm run probe:autotier
 *      AUTOTIER_SKIP_BROWSER=1 npm run probe:autotier   # §1-§4 and §6 only
 */

let failures = 0;
let checks = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  checks++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// ===========================================================================
// The harness: a session, in seconds, with a stated frame cost.
// ===========================================================================

/**
 * Where the resolution scaler has got to, as the two facts the policy reads.
 *
 * Booleans rather than a scale, deliberately. The derivation from
 * `resolutionScale` lives in `Renderer.updateAutoTier` and is measured in §5
 * against the live renderer; restating it here would be a second copy of the
 * thing under test, which is the mistake this whole file is about.
 */
const OUT_OF_PIXELS = { atMinScale: true, atCeiling: false };
const ROOM_TO_SPARE = { atMinScale: false, atCeiling: true };
/** Neither: the scaler is somewhere in the middle, working. */
const WORKING = { atMinScale: false, atCeiling: false };

/** A frame rate that is fine. 62fps. */
const EASY_MS = 16.1;
/** A frame rate that is not. 25fps — comfortably over `AUTO_DEMOTE_MS`. */
const HARD_MS = 40;

class Session {
  tier: QualityTier;
  readonly moves: AutoTierMove[] = [];
  readonly notices: string[] = [];
  readonly policy: AutoTierPolicy;

  constructor(start: QualityTier) {
    this.tier = start;
    this.policy = new AutoTierPolicy(start);
  }

  /** Runs `seconds` of wall clock at 60fps with a stated cost and scaler state. */
  run(seconds: number, costMs: number, scaler: { atMinScale: boolean; atCeiling: boolean }): this {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      const m = this.policy.update(this.tier, { dt, costMs, ...scaler });
      if (!m) continue;
      this.tier = m.to;
      this.moves.push(m);
      const n = tierNoticeFor(m);
      if (n) this.notices.push(n.text);
    }
    return this;
  }

  get path(): string {
    return [this.moves.length ? this.moves[0].from : this.tier, ...this.moves.map((m) => m.to)]
      .join(' -> ');
  }
}

// ===========================================================================
// 1. THE USER'S SESSION. The headline, and the assertion that was red.
// ===========================================================================

console.log('\n1. The session the bug was reported from: load arrives, then leaves');

{
  // A machine on `high`, playing normally, when six headless Chromes start.
  const s = new Session('high');
  s.run(30, EASY_MS, ROOM_TO_SPARE);
  check(s.tier === 'high' && s.moves.length === 0,
    'thirty comfortable seconds on the top tier move nothing',
    `on ${s.tier}`);

  // The load arrives. The scaler gives up pixels first — that is `DROP_MS`
  // sitting below `AUTO_DEMOTE_MS` and it is not this pass's business — and
  // once it is out of pixels the tier is the only thing left to give.
  s.run(60, HARD_MS, OUT_OF_PIXELS);
  check(s.tier === 'low', 'sustained trouble at minimum resolution walks the tier down',
    s.path);
  check(s.moves.length === 2 && s.moves.every((m) => m.dir === 'down'),
    'it walks down one step at a time, not two at once',
    `${s.moves.length} moves`);
  check(s.moves.every((m) => m.evidenceS >= AUTO_VERDICT_S - 1 / 60),
    `every demotion carried at least ${AUTO_VERDICT_S}s of unbroken evidence`,
    s.moves.map((m) => `${m.from}->${m.to} on ${m.evidenceS.toFixed(2)}s`).join(', '));
  check(s.moves.every((m) => !m.latched),
    'NEITHER tier is latched out — one failure is bad luck, not a verdict');
  check(s.notices.length === 2 && s.notices.every((n) => /reduced/.test(n)),
    'the player was told, both times',
    JSON.stringify(s.notices[0]));

  // ---------------------------------------------------------------------
  // THE ASSERTION THIS PROBE EXISTS FOR. The other agents finish, the load
  // disappears, and nothing about the device has changed since it was holding
  // `high` a minute ago.
  // ---------------------------------------------------------------------
  const before = s.tier;
  s.run(120, EASY_MS, ROOM_TO_SPARE);
  check(s.tier === 'high', 'THE TIER COMES BACK WHEN THE LOAD GOES AWAY',
    `${before} -> ${s.tier}`);
  check(s.moves.filter((m) => m.dir === 'up').length === 2,
    'it climbs back one step at a time as well');
  check(s.notices.some((n) => /back to High/.test(n)),
    'and the player is told the picture is back',
    JSON.stringify(s.notices[s.notices.length - 1]));

  // How long the round trip took, printed rather than asserted: it is a
  // consequence of `AUTO_PROMOTE_AFTER_S`, not a target.
  console.log(`        path: ${s.path}`);
}

// ===========================================================================
// 2. A TRANSIENT IS NOT A VERDICT
// ===========================================================================

console.log('\n2. Short trouble is absorbed, not judged');

{
  // The exact shape of the old bug: one window's worth of a slow frame time.
  // `frameCostMs` is a trimmed mean over 45 frames, so this is what the old
  // rule took a permanent decision on.
  const s = new Session('high').run(30, EASY_MS, ROOM_TO_SPARE);
  s.run(0.75, HARD_MS, OUT_OF_PIXELS);
  check(s.tier === 'high' && s.moves.length === 0,
    'one frame-cost window of trouble does not move the tier',
    `0.75s at ${HARD_MS}ms, on ${s.tier}`);

  const s2 = new Session('high').run(30, EASY_MS, ROOM_TO_SPARE);
  s2.run(AUTO_VERDICT_S - 0.5, HARD_MS, OUT_OF_PIXELS);
  check(s2.tier === 'high' && s2.moves.length === 0,
    `${(AUTO_VERDICT_S - 0.5).toFixed(1)}s of trouble — just under the window — does not move it`);
  s2.run(1, HARD_MS, OUT_OF_PIXELS);
  check(s2.tier === 'medium', 'and half a second more does', s2.path);

  // Broken trouble is not trouble. A machine that is bad, fine, bad, fine has
  // not proved anything; the scaler is the instrument for that.
  const s3 = new Session('high').run(30, EASY_MS, ROOM_TO_SPARE);
  for (let i = 0; i < 20; i++) {
    s3.run(AUTO_VERDICT_S - 1, HARD_MS, OUT_OF_PIXELS);
    s3.run(0.2, EASY_MS, WORKING);
  }
  check(s3.tier === 'high' && s3.moves.length === 0,
    'twenty five-second bursts of trouble, each broken by a fifth of a second of calm, move nothing',
    'the window is CONTINUOUS trouble, and any comfortable frame resets it');

  // And the ordering the whole tier system rests on: pixels before picture.
  // Trouble while the scaler still has room to give is the scaler's problem.
  const s4 = new Session('high').run(60, HARD_MS, WORKING);
  check(s4.tier === 'high' && s4.moves.length === 0,
    'a minute of trouble while the scaler still has pixels to give does not touch the tier',
    'the resolution scaler gets first refusal — see AUTO_DEMOTE_MS');
}

// ===========================================================================
// 3. A VERDICT IS A VERDICT
// ===========================================================================

console.log('\n3. Repeated failure still latches — the oscillation guard survives');

{
  // A device that genuinely cannot hold `high`. Each attempt costs the player
  // a shader recompile (`applyResolved` marks every material `needsUpdate`
  // when the shadow map moves), so this must be BOUNDED.
  const s = new Session('high');
  const stalls: string[] = [];
  for (let i = 0; i < 12; i++) {
    s.run(60, HARD_MS, OUT_OF_PIXELS);
    s.run(60, EASY_MS, ROOM_TO_SPARE);
    stalls.push(s.tier);
  }
  const intoHigh = s.moves.filter((m) => m.to === 'high').length;
  check(intoHigh <= AUTO_LATCH_AFTER_DEMOTIONS - 1,
    `twelve alternating cycles promote into 'high' at most ${AUTO_LATCH_AFTER_DEMOTIONS - 1} time(s)`,
    `${intoHigh} promotions into high across ${s.moves.length} moves`);
  const r = s.policy.report();
  check(r.latchedCeiling === 'high' || r.latchedCeiling === 'medium',
    'the tier that kept failing is latched out',
    `latched at '${r.latchedCeiling}'`);
  check(s.moves.length < 12,
    'the pass stops moving rather than flapping for the whole session',
    `${s.moves.length} tier changes in twelve cycles`);

  // The second failure is what does it, and not the first. One demotion at a
  // time here — `AUTO_VERDICT_S + 1` of trouble is exactly one — because sixty
  // seconds of it walks all the way to the floor and latches two tiers, which
  // is correct behaviour but tests two things at once.
  const t = latchHigh();
  check(t.policy.report().demotionsFrom.high === 2, 'high has now failed twice',
    `${t.policy.report().demotionsFrom.high} demotions from high`);
  check(t.policy.report().latchedCeiling === 'high',
    'after the SECOND failure of high, high is latched');
  const at = t.tier;
  const movesBefore = t.moves.length;
  t.run(600, EASY_MS, ROOM_TO_SPARE);
  check(t.tier !== 'high' && !t.moves.slice(movesBefore).some((m) => m.to === 'high'),
    'ten minutes of perfect frames afterwards do not get it back',
    `settled on '${t.tier}' from '${at}'`);
}

/**
 * A session that has failed `high` twice and therefore has it latched.
 *
 * The retry in the middle needs the DOUBLED comfort window — a tier that has
 * failed once is not handed back after eight seconds — so this is also the
 * shortest honest demonstration of `promoteAfterS`.
 */
function latchHigh(): Session {
  const t = new Session('high');
  t.run(AUTO_VERDICT_S + 1, HARD_MS, OUT_OF_PIXELS);
  check(t.tier === 'medium' && t.policy.report().latchedCeiling === null,
    'after ONE failure of high, the tier moved and nothing is latched', t.path);
  t.run(AUTO_PROMOTE_AFTER_S * 2 + 1, EASY_MS, ROOM_TO_SPARE);
  check(t.tier === 'high', 'high is retried', t.path);
  t.run(AUTO_VERDICT_S + 1, HARD_MS, OUT_OF_PIXELS);
  return t;
}

// ===========================================================================
// 4. ESCALATING PROOF, AND THE SETTINGS OVERRIDE
// ===========================================================================

console.log('\n4. What a retry costs, and what the player can override');

{
  const p = new AutoTierPolicy('high');
  check(p.promoteAfterS('high') === AUTO_PROMOTE_AFTER_S,
    `an untried tier needs ${AUTO_PROMOTE_AFTER_S}s of comfort`);

  const s = new Session('high').run(60, HARD_MS, OUT_OF_PIXELS);
  check(s.policy.promoteAfterS('high') === AUTO_PROMOTE_AFTER_S * 2,
    'a tier that has failed once needs twice as much comfort to be retried',
    `${s.policy.promoteAfterS('high')}s`);
  // Which means the first retry is NOT taken at the eight-second mark.
  const s2 = new Session('high').run(60, HARD_MS, OUT_OF_PIXELS);
  const downTo = s2.tier;
  s2.run(AUTO_PROMOTE_AFTER_S + 1, EASY_MS, ROOM_TO_SPARE);
  check(s2.tier === downTo, `still on '${downTo}' after ${AUTO_PROMOTE_AFTER_S + 1}s of comfort`);
  s2.run(AUTO_PROMOTE_AFTER_S + 1, EASY_MS, ROOM_TO_SPARE);
  check(s2.tier !== downTo, 'and promoted once the doubled window is met', s2.path);

  // The player outranks every measurement above.
  const s3 = latchHigh();
  check(s3.policy.report().latchedCeiling === 'high', 'a latch is in place');
  s3.policy.playerChose('high');
  s3.tier = 'high';
  const r = s3.policy.report();
  check(r.latchedCeiling === null && r.demotionsFrom.high === 0 && r.demotionsFrom.medium === 0,
    'setting a tier by hand clears the latch and the demotion counts',
    'the player is looking at the screen; the measurement is not');

  // Wording. The notice is the part of this the player actually sees.
  const down: AutoTierMove = {
    dir: 'down', from: 'high', to: 'medium', latched: false, evidenceS: 6, restored: false,
  };
  const n = tierNoticeFor(down)!;
  check(/reduced/i.test(n.text) && /frame rate/i.test(n.text) && /Medium/.test(n.text),
    'the demotion notice names what happened and why', JSON.stringify(n.text));
  check(/Settings/.test(n.hint) && /Video/.test(n.hint),
    'and gives the route to change it', JSON.stringify(n.hint));
  check(/go back up on its own/.test(tierNoticeFor(down)!.hint),
    'an unlatched demotion says it is temporary');
  check(!/go back up on its own/.test(tierNoticeFor({ ...down, latched: true })!.hint),
    'a latched one does not promise something it will not do');
  check(tierNoticeFor({ dir: 'up', from: 'low', to: 'medium', latched: false, evidenceS: 8, restored: false }) === null,
    'a routine promotion is not announced — auto doing its job quietly is the design');

  // Thresholds are still the measured ones. Nothing here loosened anything.
  check(AUTO_DEMOTE_MS === 24 && AUTO_PROMOTE_MS === 16.9 && AUTO_PROMOTE_AFTER_S === 8,
    'the measured thresholds are untouched by this work',
    `demote>${AUTO_DEMOTE_MS}ms promote<${AUTO_PROMOTE_MS}ms after ${AUTO_PROMOTE_AFTER_S}s`);
}

// ===========================================================================
// 6. No second copy of the rule in the renderer.
//    (Numbered after §5 in the transcript; run here because it needs no browser.)
// ===========================================================================

const sourceChecks = async (): Promise<void> => {
  console.log('\n6. The renderer holds no second copy of the decision');
  const src = await readFile(resolve(process.cwd(), 'src/render/Renderer.ts'), 'utf8');
  check(!/autoLatchedCeiling/.test(src),
    "the one-way latch field is gone from Renderer.ts",
    'it is `AutoTierPolicy`\'s business now, and it counts rather than latching on the first failure');
  check(/this\.autoTier\.update\(/.test(src),
    'updateAutoTier delegates to the real policy');
  check(!/AUTO_DEMOTE_MS/.test(src) && !/AUTO_PROMOTE_AFTER_S/.test(src),
    'no tier threshold is compared against in Renderer.ts',
    'so §1-§4 above cannot drift away from what ships');
  check(/features\.adaptive/.test(src),
    'the adaptive gate is still the first thing updateAutoTier reads',
    'a stated tier must never be moved by measurement');
};

// ===========================================================================
// 5. The real renderer, in a browser, read off the GL context.
// ===========================================================================

const SETTINGS_KEY = 'f1sim.settings';
const NAV_MS = Number(process.env.AUTOTIER_NAV_MS ?? 420_000);

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

interface GlState {
  tier: string;
  shadowMapEnabled: boolean;
  sunCastsShadow: boolean;
  composerAllocated: boolean;
  adaptive: boolean;
  detectedTier: string;
  latchedCeiling: string | null;
  notice: string | null;
}

/**
 * `feedFrameCost` is the real `updateAutoTier`, so this is the real policy,
 * the real `moveTier`, the real `applyResolved` and the real notice. Only the
 * frame cost is stated instead of measured — a probe cannot arrange for a
 * machine to be genuinely in trouble, and certainly not repeatably.
 */
const DRIVE = (seconds: number, costMs: number, scale: number) => `(() => {
  const r = window.__game.renderer;
  r.resolutionScale = ${scale};
  const dt = 1 / 60;
  for (let i = 0; i < ${Math.round(seconds * 60)}; i++) r.feedFrameCost(dt, ${costMs});
  const f = r.features;
  const el = document.querySelector('.render-tier-notice');
  return {
    tier: f.tier,
    shadowMapEnabled: !!r.renderer.shadowMap.enabled,
    sunCastsShadow: !!r.sun.castShadow,
    composerAllocated: !!r.post.composer,
    adaptive: !!f.adaptive,
    detectedTier: f.detectedTier,
    latchedCeiling: r.autoTier.report().latchedCeiling,
    notice: el && el.style.opacity === '1' ? el.textContent : null,
  };
})()`;

async function browserSection(): Promise<void> {
  console.log('\n5. The real renderer, driven through the real path, read off the GL context');

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
      // Software GL. Nothing here is a timing measurement — every frame cost
      // is stated — so a rasteriser that behaves identically on every machine
      // is exactly what is wanted, and this probe is therefore not load
      // sensitive at all. See PROJECT.md §6 on `probe:renderperf`, which is.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=900,600',
    ],
  });
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e: unknown) => errors.push(`pageerror: ${String(e)}`));

  // The detected tier must not depend on whatever box this is run on, so the
  // one signal `detectTier` reads on a desktop is pinned. Sixteen cores is a
  // machine that starts on `high`, which is where the reported session started.
  const load = async (settings: Record<string, unknown>): Promise<void> => {
    const pin = await page.evaluateOnNewDocument(`
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 16 });
      try { localStorage.setItem(${JSON.stringify(SETTINGS_KEY)},
        ${JSON.stringify(JSON.stringify(settings))}); } catch (e) {}
    `);
    await page.goto(url, { waitUntil: 'load', timeout: NAV_MS });
    await page.waitForFunction('!!window.__game && !!window.__game.renderer',
      { timeout: NAV_MS, polling: 100 });
    await page.removeScriptToEvaluateOnNewDocument(pin.identifier);
  };
  const drive = async (s: number, ms: number, scale: number): Promise<GlState> =>
    await page.evaluate(DRIVE(s, ms, scale)) as GlState;

  // -------------------------------------------------------------------------
  console.log('  --- stored quality=\'auto\' on a machine that detects as high ---');
  await load({ quality: 'auto', graphics: { post: 'auto', shadows: 'auto', msaa: 'auto', resolution: 'auto' } });

  const start = await drive(1, EASY_MS, 1.0);
  check(start.tier === 'high' && start.adaptive,
    'the session starts on high, adaptively', `${start.tier} adaptive=${start.adaptive}`);
  check(start.shadowMapEnabled && start.sunCastsShadow && start.composerAllocated,
    'and the GL context agrees: shadow map on, sun casting, composer allocated');

  // The load arrives. `resolutionScale = 0.5` is the scaler already out of
  // pixels — the state the tier is only allowed to act in.
  const down = await drive(60, HARD_MS, 0.5);
  check(down.tier === 'low', 'sustained trouble at MIN_SCALE walks the real renderer down to low',
    `on '${down.tier}'`);
  check(!down.shadowMapEnabled && !down.sunCastsShadow && !down.composerAllocated,
    'and the GL context followed it down — shadow map off, composer freed',
    'a tier that moved without the context moving has not moved');
  check(down.latchedCeiling === null, 'nothing was latched on the way down');
  check(down.notice !== null && /reduced/i.test(down.notice ?? ''),
    'the player was told, on screen', JSON.stringify(down.notice));

  // The load goes away.
  const back = await drive(180, EASY_MS, 1.0);
  check(back.tier === 'high', 'THE REAL RENDERER GETS BACK TO HIGH', `on '${back.tier}'`);
  check(back.shadowMapEnabled && back.sunCastsShadow && back.composerAllocated,
    'and the GL context came back with it — shadow map on, composer allocated');
  check(back.notice !== null && /back to High/.test(back.notice ?? ''),
    'and the player was told the picture is back', JSON.stringify(back.notice));

  // -------------------------------------------------------------------------
  console.log('  --- stored quality=\'high\': a tier chosen in Settings ---');
  await load({ quality: 'high', graphics: { post: 'auto', shadows: 'auto', msaa: 'auto', resolution: 'auto' } });
  const stated = await drive(1, EASY_MS, 1.0);
  check(stated.tier === 'high' && !stated.adaptive,
    'a stated tier is not adaptive', `adaptive=${stated.adaptive}`);
  const spiked = await drive(300, HARD_MS, 0.5);
  check(spiked.tier === 'high',
    'FIVE MINUTES of trouble at minimum resolution do not move a tier chosen by hand',
    `still '${spiked.tier}'`);
  check(spiked.shadowMapEnabled && spiked.composerAllocated,
    'and nothing in the GL context moved either');
  check(spiked.notice === null, 'and the player is not told about a change that did not happen');

  // The same, one tier up from the floor, so the failure mode "it had nowhere
  // to go anyway" cannot be what is passing this.
  await load({ quality: 'medium', graphics: { post: 'auto', shadows: 'auto', msaa: 'auto', resolution: 'auto' } });
  const med = await drive(300, HARD_MS, 0.5);
  check(med.tier === 'medium' && !med.adaptive && med.composerAllocated,
    'a stated `medium` survives the same spike with its post chain intact',
    `on '${med.tier}', composer=${med.composerAllocated}`);

  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));

  await browser.close();
  await server.close();
}

// ===========================================================================

async function main(): Promise<void> {
  await sourceChecks();
  if (process.env.AUTOTIER_SKIP_BROWSER === '1') {
    console.log('\n5. SKIPPED (AUTOTIER_SKIP_BROWSER=1) — the browser section did not run.');
  } else {
    await browserSection();
  }
  console.log(`\n${checks - failures} ok / ${failures} failed`);
  if (failures > 0) {
    console.log('\nA tier the player did not choose, that does not come back, is issue #73.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
