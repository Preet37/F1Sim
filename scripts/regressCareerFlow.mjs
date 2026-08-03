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
  // Either surface counts as "the game booted": on a first run the opening
  // sequence is what is on screen, and it is skipped a few lines below.
  await page.waitForSelector('.screen .page, .intro', { timeout: 20000 });
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

/**
 * THE OPENING SEQUENCE, AND THE SKIP.
 *
 * Deliberately not suppressed with `?intro=0`, which exists for the harnesses
 * that are not testing it. The skip button is what stands between a new player
 * and fourteen seconds of titles they did not ask for, and a skip that quietly
 * stopped working is exactly the kind of failure nothing else here would catch.
 *
 * It is asserted to be present IMMEDIATELY, because "the skip appears after two
 * seconds" is the same defect as no skip at all.
 */
console.log('\nTHE OPENING SEQUENCE CAN BE SKIPPED');

{
  const intro = page.locator('.intro');
  if (await intro.count() > 0) {
    const skip = page.locator('.intro-skip');
    check(await skip.count() > 0, 'the skip button exists on the first frame');
    check(await skip.isVisible().catch(() => false), 'and it is visible');
    await skip.click({ force: true, noWaitAfter: true });
    await page.waitForTimeout(400);
    check(await page.locator('.intro').count() === 0, 'clicking it ends the sequence');
    check(pageErrors.length === 0,
      'the opening sequence threw nothing (' + pageErrors.join(' | ') + ')');
  } else {
    check(false, 'the opening sequence played on a first run');
  }
}
await page.waitForSelector('.screen .page', { timeout: 20000 });

/**
 * THE NAME.
 *
 * A name that appears nowhere in `src/data/roster/`, so every assertion below
 * is evidence that it came from the create screen and from nowhere else. This
 * is the browser half of `probe:identity`: that probe proves the name reaches
 * the simulation, and this proves it reaches the screens.
 */
const FIRST = 'Ondrej';
const LAST = 'Zdravkovic';

console.log('\nA CAREER CAN BE CREATED');

await clickByText('.menu-item', 'Start Career');
await page.waitForTimeout(300);
check((await bodyText()).includes('formula 3'),
  'the create screen names the tier the career starts in');
check(await page.locator('.sg-portrait .portrait').count() > 0,
  'there is a driver on the create screen, drawn');

// The name fields, then sign.
const inputs = page.locator('.screen .sg-field input');
check(await inputs.count() >= 2, 'the create screen asks for a name');
if (await inputs.count() >= 2) {
  await inputs.nth(0).fill(FIRST);
  await inputs.nth(1).fill(LAST);
  await page.waitForTimeout(150);
  // The code on the portrait is derived live from the surname. If this is
  // wrong, nothing downstream can be right.
  const code = (await page.locator('.sg-code').innerText().catch(() => '')).trim();
  check(code === 'ZDR', `the portrait's code follows the surname as it is typed (${code})`);
}
await clickByText('.btn', 'Take the seat');
await page.waitForTimeout(500);

let text = await bodyText();
check(text.includes(FIRST.toLowerCase()) && text.includes(LAST.toLowerCase()),
  'the hub shows the driver');
check(await page.locator('.dcard .portrait').count() > 0,
  'the hub shows the driver as a person, not only as a name');
check(/Round\s*1/i.test(text) || text.includes('next up'), 'the hub shows the next round');
check(text.includes('promotion'), 'the hub states the promotion rule the career runs on');
check(pageErrors.length === 0, 'creating a career threw nothing (' + pageErrors.join(' | ') + ')');

/**
 * A WEEKEND SURVIVES THE TAB BEING CLOSED.
 *
 * The session queue, how far through it the player was, and the grid qualifying
 * had built all used to live only as fields on the app shell — so qualifying on
 * the Saturday and closing the tab lost the qualifying. Started here rather
 * than driven, because the fault is in what is written to disk when a weekend
 * begins, and driving one under a software rasteriser costs a minute a session.
 */
console.log('\nA WEEKEND IN PROGRESS IS SAVED');

await clickByText('.btn', 'Race Weekend');
await page.waitForTimeout(400);
{
  const saved = await page.evaluate(() => {
    const c = window.__game?.career;
    const w = c?.state.weekendInProgress;
    return w ? { circuitId: w.circuitId, sessions: w.sessions.length, index: w.index } : null;
  });
  check(saved !== null, 'starting a weekend writes it into the career');
  check(saved !== null && saved.sessions > 0,
    `the session queue is on disk (${saved?.sessions} sessions)`);
}
// And it is still there after a reload, which is the whole point.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.screen .page', { timeout: 20000 });
await clickByText('.menu-item', 'Continue');
await page.waitForTimeout(500);
check((await bodyText()).includes('part-way through this weekend'),
  'the hub offers the weekend back after a reload');
const resume = page.locator('.btn', { hasText: 'Resume Weekend' }).first();
check(await resume.count() > 0, 'there is a way to resume it');
await resume.click({ force: true, noWaitAfter: true });
await page.waitForTimeout(500);
check((await bodyText()).includes('garage') || (await bodyText()).includes('practice'),
  'resuming puts the weekend back on screen');
// Leave it again, so the season loop below is not standing in a garage.
await clickByText('.navback', '');
await page.waitForTimeout(400);
check(pageErrors.length === 0,
  'saving and resuming a weekend threw nothing (' + pageErrors.join(' | ') + ')');

console.log('\nTHE CHAMPIONSHIP TABLE IS REAL');

await clickByText('.btn', 'Standings');
await page.waitForTimeout(350);
text = await bodyText();
const rowCount = await page.locator('.trow').count();
check(rowCount >= 18, `the championship table has a full grid in it (${rowCount} rows)`);
check(text.includes('championship'), 'the standings screen is the standings screen');
// THE ASSERTION THIS WHOLE HARNESS EXISTS FOR. The championship the player is
// in has to contain the player, under the name they typed.
check(text.includes(LAST.toLowerCase()),
  'the player is in the championship table under their own name');
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

/**
 * THE RESULTS ARE WRITTEN, AND THEY ARE THE PLAYER'S.
 *
 * Read from the career itself rather than scraped off a screen, because the
 * question is whether the RESULT exists in the state that gets saved — a hub
 * that renders a round it did not record is exactly the failure this is looking
 * for. `window.__game` is already exposed for `regress:exit`.
 */
{
  const recorded = await page.evaluate(() => {
    const c = window.__game?.career;
    if (!c) return null;
    const ts = c.state.season.tiers[c.state.tier];
    return {
      rounds: ts.results.length,
      inEvery: ts.results.every((r) => r.order.includes(c.state.playerDriverId)),
      name: c.state.player.firstName + ' ' + c.state.player.lastName,
      points: ts.standings.find((e) => e.driverId === c.state.playerDriverId)?.points ?? -1,
    };
  });
  check(recorded !== null, 'the career is reachable from the page');
  if (recorded) {
    check(recorded.rounds >= 8, `every round is recorded in the season (${recorded.rounds})`);
    check(recorded.inEvery, 'the player is in the classification of every one of them');
    check(recorded.name === FIRST + ' ' + LAST,
      `the career holds the typed name (${recorded.name})`);
    check(recorded.points >= 0, 'the player has a standings row with points in it');
  }
}

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

// What the career held before the reload, to compare against afterwards. A
// reload that loses a season's results is the failure, and "the hub still says
// my name" does not detect it.
const before = await page.evaluate(() => {
  const c = window.__game?.career;
  if (!c) return null;
  return {
    year: c.state.season.year,
    tier: c.state.tier,
    teamId: c.state.teamId,
    history: c.state.history.length,
    code: c.state.player.code,
    number: c.state.player.raceNumber,
    nationality: c.state.player.nationality,
    helmet: JSON.stringify(c.state.player.helmet ?? null),
  };
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.screen .page', { timeout: 20000 });
await page.waitForTimeout(400);
check(await page.locator('.intro').count() === 0,
  'the opening sequence does not play a second time');
await clickByText('.menu-item', 'Continue');
await page.waitForTimeout(600);
text = await bodyText();
check(text.includes(FIRST.toLowerCase()) && text.includes(LAST.toLowerCase()),
  'the saved career loads back with its driver');
check(!dialogs.some((d) => /could not be loaded|damaged/i.test(d)),
  'loading it raised no error dialog (' + dialogs.join(' | ') + ')');

const after = await page.evaluate(() => {
  const c = window.__game?.career;
  if (!c) return null;
  return {
    year: c.state.season.year,
    tier: c.state.tier,
    teamId: c.state.teamId,
    history: c.state.history.length,
    code: c.state.player.code,
    number: c.state.player.raceNumber,
    nationality: c.state.player.nationality,
    helmet: JSON.stringify(c.state.player.helmet ?? null),
  };
});
check(before !== null && after !== null, 'both sides of the reload could be read');
if (before && after) {
  for (const key of Object.keys(before)) {
    check(before[key] === after[key],
      `${key} survives the reload (${before[key]} -> ${after[key]})`);
  }
}
check(pageErrors.length === 0, 'reloading threw nothing (' + pageErrors.join(' | ') + ')');

await browser.close();
shutdown();

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nA career can be created, raced, ended and reloaded.');
