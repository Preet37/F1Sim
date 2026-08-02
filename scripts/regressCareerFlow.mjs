/**
 * Regression: a career can be created, raced and ended in a real browser.
 *
 * WHY THIS NEEDS A BROWSER. Everything else about the career is verified
 * headlessly — `probe:season` runs a hundred career-years, `probe:save`
 * round-trips a decade, `probe:tiers` measures the cars. None of them touch a
 * single screen, and the screens are where a career mode actually breaks: a
 * field renamed in the state and not in the hub throws inside a click handler,
 * the exception never reaches a probe, and the player gets a blank page.
 *
 * So this drives the real thing: new career, look at the hub, simulate rounds
 * until the season is over, end the season, read the off-season report, and go
 * round again. It asserts on the DOM and on the absence of page errors, which
 * together are the only evidence that the wiring is real.
 *
 * Like `regress:exit`, it boots its own dev server and skips cleanly when
 * playwright is not installed.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run regress:career
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP — playwright is not installed.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const PORT = 5393;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', shutdown);

/**
 * Wait until the server actually answers, rather than until it says it will.
 *
 * Matching "ready in" on stdout is what the other browser harness does and it is
 * a race: vite prints its banner before the HTTP listener is reliably accepting,
 * so the first `page.goto` intermittently timed out and the whole test looked
 * like a career-mode failure when nothing was wrong with career mode at all.
 * Polling the URL is both simpler and honest about what is being waited for.
 */
{
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('vite did not answer on ' + PORT + ' in 45s');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const failures = [];
let lastScreen = '';
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) {
    failures.push(msg);
    // What was actually on screen. A bare FAIL from a browser test tells the
    // next person nothing at all.
    console.log('        screen: ' + lastScreen.replace(/\s+/g, ' ').slice(0, 260));
  }
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
/**
 * `reducedMotion` is not a nicety here, it is what makes this test possible.
 *
 * Every screen in this game runs a staggered entrance animation and the menu has
 * a car turning on a WebGL stage behind it, so Playwright's "wait until the
 * element is stable" check never settles and every click times out. The
 * interface honours `prefers-reduced-motion` properly — that is why this works —
 * and what is being tested is the wiring, not the easing.
 */
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text());
});

// `alert` blocks a headless page for ever. Accept everything and remember what
// it said, because a couple of these flows still speak through alerts.
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

/**
 * `?quality=low` is not optional here.
 *
 * `main.ts` documents this switch as existing for headless verification: the
 * software rasteriser cannot afford the shadow pass, and at the default quality
 * the render loop pegs the main thread hard enough that Playwright cannot even
 * resolve `body`. The test then reports a career-mode failure when the career is
 * perfectly fine and the browser is simply busy drawing.
 */
const URL = `http://localhost:${PORT}/?quality=low`;
await page.goto(URL, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForSelector('.screen .page', { timeout: 20000 });
} catch (e) {
  // A boot failure is the single most important thing this harness can report,
  // and a bare "selector not found" hides the exception that caused it.
  console.error('The game did not reach a screen. Page errors:');
  for (const err of pageErrors) console.error('  ' + err);
  console.error('Body was: ' + (await page.locator('body').innerHTML()).slice(0, 400));
  throw e;
}

const clickByText = async (selector, text) => {
  const target = page.locator(selector, { hasText: text }).first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  // Forced, because the software renderer keeps the compositor busy and the
  // stability check is not what this test is about.
  await target.click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(220);
};

/**
 * The screen's text, lower-cased.
 *
 * `innerText` applies CSS, and this interface sets `text-transform: uppercase`
 * on almost every label it draws — so asserting on "Championship" fails against
 * a screen that very clearly says CHAMPIONSHIP. Case-folding here rather than at
 * each call site, because every one of these assertions wants the same thing.
 */
const bodyText = async () => {
  lastScreen = await page.locator('.screen').innerText();
  return lastScreen.toLowerCase();
};

console.log('\nA CAREER CAN BE CREATED');

await clickByText('.menu-item', 'Start Career');
await page.waitForTimeout(300);
check((await bodyText()).includes('formula 3'),
  'the create screen names the tier the career starts in');

// The name fields, then begin.
const inputs = page.locator('.screen .field input');
if (await inputs.count() >= 2) {
  await inputs.nth(0).fill('Probe');
  await inputs.nth(1).fill('Tester');
}
await clickByText('.btn', 'Begin Career');
await page.waitForTimeout(500);

let text = await bodyText();
check(text.includes('probe') && text.includes('tester'), 'the hub shows the driver');
check(/Round\s*1/i.test(text) || text.includes('next up'), 'the hub shows the next round');
check(text.includes('promotion'), 'the hub states the promotion rule the career runs on');
check(pageErrors.length === 0, 'creating a career threw nothing (' + pageErrors.join(' | ') + ')');

console.log('\nTHE CHAMPIONSHIP TABLE IS REAL');

await clickByText('.btn', 'Standings');
await page.waitForTimeout(350);
text = await bodyText();
const rowCount = await page.locator('.trow').count();
check(rowCount >= 18, `the championship table has a full grid in it (${rowCount} rows)`);
check(text.includes('championship'), 'the standings screen is the standings screen');
check(pageErrors.length === 0, 'the standings screen threw nothing (' + pageErrors.join(' | ') + ')');

await clickByText('.navback', '');
await page.waitForTimeout(300);

console.log('\nA SEASON CAN BE RUN TO ITS END');

let simulated = 0;
for (let i = 0; i < 30; i++) {
  const sim = page.locator('.btn', { hasText: 'Simulate Race' }).first();
  if (await sim.count() === 0 || !(await sim.isVisible().catch(() => false))) break;
  await sim.click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(260);
  simulated++;

  // A narrative event may interrupt. Answer it and carry on.
  const choice = page.locator('.choice').first();
  if (await choice.count() > 0 && await choice.isVisible().catch(() => false)) {
    await choice.click({ force: true, noWaitAfter: true });
    await page.waitForTimeout(260);
  }
}
check(simulated >= 8, `a whole season could be simulated from the hub (${simulated} rounds)`);
check(pageErrors.length === 0, 'simulating a season threw nothing (' + pageErrors.join(' | ') + ')');

text = await bodyText();
check(text.includes('season complete') || text.includes('end season'),
  'the hub notices the season has finished');

console.log('\nTHE OFF-SEASON REPORTS WHAT HAPPENED');

await clickByText('.btn', 'End Season');
await page.waitForTimeout(600);
text = await bodyText();
check(text.includes('champions'), 'the off-season names the champions');
check(text.includes('formula 1') && text.includes('formula 3'),
  'it reports every tier, not only the one the player is in');
check(/promoted|season over|champion/.test(text), 'it states the outcome for the player');
check(pageErrors.length === 0, 'the off-season threw nothing (' + pageErrors.join(' | ') + ')');

console.log('\nAND THE NEXT SEASON STARTS');

const next = page.locator('.btn.primary').first();
await next.click({ force: true, noWaitAfter: true });
await page.waitForTimeout(450);
text = await bodyText();
check(/Round\s*1/i.test(text) || text.includes('next up'),
  'the new season opens on its first round');
check(pageErrors.length === 0, 'starting the next season threw nothing (' + pageErrors.join(' | ') + ')');

console.log('\nTHE CAREER SURVIVES A RELOAD');

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.screen .page', { timeout: 20000 });
await page.waitForTimeout(400);
await clickByText('.menu-item', 'Continue');
await page.waitForTimeout(600);
text = await bodyText();
check(text.includes('probe') && text.includes('tester'),
  'the saved career loads back with its driver');
check(!dialogs.some((d) => /could not be loaded|damaged/i.test(d)),
  'loading it raised no error dialog (' + dialogs.join(' | ') + ')');
check(pageErrors.length === 0, 'reloading threw nothing (' + pageErrors.join(' | ') + ')');

await browser.close();
shutdown();

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nA career can be created, raced, ended and reloaded.');
