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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', async (d) => await d.dismiss());

// A long race, because the length of the race is the whole point.
await page.goto(`http://localhost:${PORT}/?quality=low&circuit=spa&session=race&laps=44&seed=5`,
  { waitUntil: 'load' });
await page.waitForTimeout(4500);

const st = () => page.evaluate(() => {
  const g = window.__game;
  const o = document.querySelector('.pause-overlay');
  return {
    screen: g.screen,
    paused: g.clock.paused,
    hasEngine: !!g.engine,
    overlayShown: !!o && getComputedStyle(o).display !== 'none',
    buttons: o ? [...o.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
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
      .find((e) => new RegExp(p, 'i').test(e.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  }, pattern);
  if (!clicked) check(false, `${what} — no such button on the pause menu`);
  return clicked;
};

console.log('\nRESUME PUTS THE PLAYER BACK ON TRACK');
await clickPauseButton('^resume$', 'clicking Resume');
await page.waitForTimeout(1200);
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
const title = await page.evaluate(() =>
  (document.querySelector('.screen .title')?.textContent || '').trim());
check(title.length > 0, `a real screen is showing ("${title}")`);

console.log('\nAND THE GAME STILL WORKS AFTERWARDS');
const before = await page.evaluate(() => {
  const r = window.__game.renderer.renderer;
  return { geometries: r.info.memory.geometries, textures: r.info.memory.textures };
});
await page.evaluate(() => {
  const g = window.__game;
  g.weekend = [g.sessionConfig('race', 'Grand Prix', 'monza', 0, 2)];
  g.weekendIndex = 0;
  g.beginSession('monza');
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
