/**
 * Regression: a session the player has started must be one they can leave.
 *
 * The bug this locks down
 * -----------------------
 * There was no way out of a session. `P` and `Escape` toggled `clock.paused`,
 * which froze the simulation and drew nothing at all — indistinguishable from a
 * hang — and no screen, button or key led back to the menus. Once a fifty-seven
 * lap Grand Prix had started the only exits were driving all fifty-seven laps or
 * reloading the page, which throws away the career save's in-progress weekend.
 *
 * What this test would fail on
 * ----------------------------
 * Any build where pausing does not visibly pause, where the pause menu offers no
 * way out, where abandoning leaves the engine or the renderer's session behind,
 * or where the game cannot start a fresh session afterwards. The last of those
 * is what makes this more than a screenshot test.
 *
 * This one needs a browser, so unlike the other harnesses it is not part of the
 * default `npm run validate`. It boots its own dev server.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run regress:exit
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

const PORT = 5391;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', shutdown);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite did not start in 40s')), 40000);
  server.stdout.on('data', (b) => {
    if (String(b).includes('ready in') || String(b).includes(`:${PORT}`)) { clearTimeout(timer); resolve(); }
  });
  server.on('error', reject);
});
await new Promise((r) => setTimeout(r, 800));

const failures = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

// Software GL, because CI has no GPU and the point of this test is the DOM.
const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
let browser;
try {
  // Prefer the system Chrome, so `npx playwright install` is not required.
  browser = await chromium.launch({ channel: 'chrome', args: launchArgs });
} catch {
  browser = await chromium.launch({ args: launchArgs });
}
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
// Playwright's default navigation timeout is thirty seconds. Booting this game
// means building a circuit's geometry, its world model and its racing line
// under a software rasteriser, and on a machine that is also running a sweep
// that takes longer than thirty seconds — at which point this regression fails
// on a stopwatch rather than on the behaviour it exists to protect. Generous,
// and still finite.
page.setDefaultNavigationTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', async (d) => await d.dismiss());

// Warm the dev server first, on the menus rather than on a circuit.
//
// This is not the test. The dev server transforms every module in the project
// on the first request for it, and doing that while software-GL is building a
// seven-kilometre circuit put the timed navigation below at 28 to 32 seconds
// against a 30-second default — so the suite passed or failed on how busy the
// machine was, which is not a property of the code under test. Warmed, the
// real navigation lands under twenty.
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 120_000 });

// A long race, because the length of the race is the whole point.
await page.goto(`http://localhost:${PORT}/?quality=low&circuit=spa&session=race&laps=44&seed=5`,
  { waitUntil: 'load', timeout: 120_000 });
await page.waitForTimeout(4500);

const st = () => page.evaluate(() => {
  const g = window.__game;
  const o = document.querySelector('.pause-overlay');
  return {
    screen: g.screen,
    paused: g.clock.paused,
    hasEngine: !!g.engine,
    overlayShown: !!o && getComputedStyle(o).display !== 'none',
    // The label, not the whole button. A pause-menu entry now carries a label
    // and a line of explanatory meta in separate spans, so `textContent` on the
    // button reads "ResumeBack to the car" — which no test looking for "Resume"
    // will ever match, on a menu that offers Resume perfectly well.
    buttons: o ? [...o.querySelectorAll('button')].map((b) =>
      (b.querySelector('.pause-btn-label') ?? b).textContent.trim()) : [],
    simTime: g.engine?.time ?? null,
  };
});

console.log('\nA 44-LAP GRAND PRIX IS UNDER WAY');
const running = await st();
check(running.screen === 'racing' && running.hasEngine, 'the session is running');
check(!running.overlayShown, 'nothing is covering the track while racing');

console.log('\nPAUSE MUST SHOW ITSELF');
await page.keyboard.press('Escape');
// The software rasteriser runs a handful of frames a second, and the key is
// consumed on a frame boundary.
await page.waitForTimeout(3000);
const paused = await st();
check(paused.paused, 'the simulation is paused');
check(paused.overlayShown, 'a pause menu is on screen, so the game does not look hung');
check(paused.buttons.includes('Resume'), 'the pause menu offers Resume');
check(paused.buttons.some((b) => /abandon|quit|exit/i.test(b)), 'the pause menu offers a way out');

const t1 = (await st()).simTime;
await page.waitForTimeout(1500);
const t2 = (await st()).simTime;
check(t1 === t2, `paused time really stands still (${t1} -> ${t2})`);

/** Clicks a pause-menu button, reporting a failure rather than throwing when
 *  the button this whole test is about does not exist. */
const clickPauseButton = async (pattern, what) => {
  const clicked = await page.evaluate((p) => {
    const b = [...document.querySelectorAll('.pause-overlay button')]
      .find((e) => new RegExp(p, 'i').test(
        ((e.querySelector('.pause-btn-label') ?? e).textContent || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  }, pattern);
  if (!clicked) check(false, `${what} — no such button on the pause menu`);
  return clicked;
};

console.log('\nRESUME PUTS THE PLAYER BACK ON TRACK');
await clickPauseButton('^resume$', 'clicking Resume');
// Long enough for the clock to move on a software rasteriser that is sharing
// the machine. 1200ms was a handful of frames on a quiet box and none at all on
// a busy one, which made this assertion fail for reasons that had nothing to do
// with pausing.
await page.waitForTimeout(4000);
const resumed = await st();
check(!resumed.paused && !resumed.overlayShown, 'the overlay is gone and the clock is running');
check(resumed.simTime > t2, `time is moving again (${t2} -> ${resumed.simTime})`);

console.log('\nABANDONING RETURNS TO THE MENUS AND CLEANS UP');
await page.keyboard.press('Escape');
await page.waitForTimeout(3000);
await clickPauseButton('abandon|quit|exit', 'clicking the way out');
await page.waitForTimeout(2000);
const quit = await st();
check(quit.screen !== 'racing', `the player is off the track (screen "${quit.screen}")`);
check(!quit.hasEngine, 'the session engine has been released');
check(!quit.overlayShown, 'the pause menu is not stranded over the menus');
check(!quit.paused, 'the clock is not left paused');
// "Did we land somewhere real" is a question about the screen layer, not about
// any particular heading, and it has to be asked that way.
//
// This assertion has now been broken twice by front-end work that was perfectly
// correct: first it looked for `.title`, which the redesign retired, and then
// for `.wordmark`, which the menu rebuild retired in turn. Both times it
// reported an empty string for a menu that was rendering fine. So it now asks
// the only thing that is actually invariant — the screen layer is visible and
// has content in it — and reports the first heading it can find purely as a
// label, without depending on one existing.
const landed = await page.evaluate(() => {
  const root = document.querySelector('.screen');
  if (!root || root.classList.contains('hidden')) return { ok: false, label: '(screen layer hidden)' };
  const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
  const heading = ['.page-title', '.wordmark', '.title', 'h1', '.section-title']
    .map((s) => (root.querySelector(s)?.textContent || '').trim())
    .find((t) => t.length > 0);
  return { ok: text.length > 20, label: heading || text.slice(0, 40) };
});
check(landed.ok, `a real screen is showing ("${landed.label}")`);

console.log('\nAND THE GAME STILL WORKS AFTERWARDS');
const before = await page.evaluate(() => {
  const r = window.__game.renderer.renderer;
  return { geometries: r.info.memory.geometries, textures: r.info.memory.textures };
});
await page.evaluate(() => {
  const g = window.__game;
  g.weekend = [g.sessionConfig('race', 'Grand Prix', 'monza', 0, 2)];
  g.weekendIndex = 0;
  // The method that puts a session on track has been called both
  // `beginSession` and `launchSession`. This test is about whether the game
  // still works after abandoning one, not about what that method is called
  // this week, so it takes whichever is there and says so plainly if neither
  // is — a missing entry point should read as a broken test, not as a broken
  // game.
  const start = g.launchSession ?? g.beginSession;
  if (typeof start !== 'function') throw new Error('no launchSession/beginSession on the game');
  start.call(g, 'monza');
});
await page.waitForTimeout(4000);
const again = await st();
check(again.screen === 'racing' && again.hasEngine, 'a new session starts after abandoning one');
check(again.simTime !== null && again.simTime < 30, `the new session starts from zero (t=${again.simTime})`);

await page.evaluate(() => {
  const g = window.__game;
  g.renderer.unloadSession();
  g.engine = null;
  g.showMenu();
});
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
  const r = window.__game.renderer.renderer;
  return { geometries: r.info.memory.geometries, textures: r.info.memory.textures };
});
console.log(`  GPU resources at menu: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
check(after.geometries <= before.geometries && after.textures <= before.textures,
  'abandoning and re-entering a session does not leak geometries or textures');

check(pageErrors.length === 0, `no uncaught page errors (${pageErrors.slice(0, 3).join(' | ')})`);

await browser.close();
shutdown();

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('A session can be paused, seen to be paused, and left.');
process.exit(0);
