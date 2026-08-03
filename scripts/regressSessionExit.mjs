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
 *
 * ---------------------------------------------------------------------------
 * WHY THE WAITS BELOW ARE CONDITIONS RATHER THAN DURATIONS — issue #25
 * ---------------------------------------------------------------------------
 *
 * This file spent months reporting a working pause menu as six failures:
 *
 *     the simulation is paused / a pause menu is on screen ... /
 *     the pause menu offers Resume / the pause menu offers a way out /
 *     clicking Resume — no such button on the pause menu /
 *     time is moving again (0.0666... -> 0.0666...)
 *
 * All six are ONE cascade and none of them is about pausing. It drives Chrome
 * under a software rasteriser, where a frame of this game costs a large
 * fraction of a second, and a keyboard event is consumed on a frame boundary.
 * Every wait here used to be a fixed sleep sized for a quiet machine, so on a
 * busy one the `Escape` had not been through a frame yet when the first
 * assertion ran — not paused, therefore no overlay, therefore no Resume
 * button, therefore the click failed, therefore the clock never stopped.
 * Reproduced on demand on 2026-08-03: 16 of 16 at load average 6–9, and
 * exactly the six failures above at load average 28, on the same commit.
 *
 * NOTHING HERE IS LOOSENED. Every assertion is the assertion it always was.
 * What changed is that the harness now waits for the state it is about to
 * assert on, up to a generous finite deadline derived from the frame period it
 * MEASURES on the machine it is running on, instead of guessing at a number of
 * milliseconds. A build with a broken Resume button still fails, and fails at
 * the deadline rather than immediately — see `waitUntil`.
 *
 * The "paused time really stands still" check got STRICTER in the process. It
 * used to sleep 1500ms and compare, which on a loaded machine is less than one
 * frame — so it would have passed a build that had stopped drawing entirely,
 * which is the exact hang this whole regression exists to rule out. It now
 * counts the frames the page actually painted during the window and requires
 * that several happened while the clock did not move.
 *
 * ---------------------------------------------------------------------------
 * AND THE DEV SERVER NO LONGER WATCHES THE FILES
 * ---------------------------------------------------------------------------
 *
 * It used to spawn `npx vite` with the project's ordinary configuration, which
 * means HMR. An edit to anything under `src/` while the run was in flight
 * full-reloaded the page and the run died on an UNCAUGHT exception —
 * `Cannot read properties of undefined (reading 'screen')`, or `Execution
 * context was destroyed` — with no assertion output and a non-zero exit that
 * looks exactly like a real failure. Measured twice in five consecutive runs
 * on 2026-08-03. `probe:smoke` already builds its server with `hmr: false,
 * watch: null` for this reason; so does this one now, which also disposes of
 * the free-port dance and the "vite did not start in 60s" timeout.
 */

import process from 'node:process';
import { createServer } from 'vite';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP — playwright is not installed.');
  console.log('  npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

// The dev server, in this process.
//
// `port: 0` lets the OS pick, which is what makes several agents in parallel
// worktrees able to run this at once — the old hardcoded 5391 with
// `--strictPort` meant exactly one copy per machine, and every other copy died
// with a message about vite not starting that sent two separate investigations
// chasing machine load. Owning the server rather than spawning `npx vite` also
// removes the port handover race, the "did it print `ready in`" sniffing, and
// — the one that actually cost runs — the file watcher. See the header.
const server = await createServer({
  server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
  logLevel: 'warn',
});
await server.listen();
const addr = server.httpServer?.address();
if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
const PORT = addr.port;
const shutdown = () => { try { void server.close(); } catch { /* already gone */ } };
process.on('exit', shutdown);

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

/**
 * The state, read from the page, tolerant of the page not being there.
 *
 * Two separate things used to throw out of here and take the whole run with
 * them: `window.__game` being undefined because the document had been replaced
 * under us, and Playwright's own "Execution context was destroyed". Both are
 * reported as a snapshot with `alive: false` so an assertion can fail on them
 * with a sentence, instead of the process dying with a stack trace and an exit
 * code indistinguishable from a real regression.
 */
const readState = () => page.evaluate(() => {
  const g = window.__game;
  const o = document.querySelector('.pause-overlay');
  if (!g) return { alive: false, screen: '(no game on the page)', buttons: [], simTime: null };
  return {
    alive: true,
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

/** One read, retried, because a lost execution context is not a verdict. */
const st = async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readState();
    } catch (e) {
      if (attempt >= 2) {
        return {
          alive: false, screen: `(page unreachable: ${String(e).slice(0, 60)})`,
          paused: false, hasEngine: false, overlayShown: false,
          buttons: [], simTime: null,
        };
      }
      await page.waitForTimeout(400);
    }
  }
};

/**
 * How many frames the page paints in `ms`, and it is the unit everything here
 * is measured in.
 *
 * A key press is consumed on a frame boundary and the simulation advances on
 * one, so "how long should I wait" has exactly one honest answer on a machine
 * whose frame period is unknown and swings by an order of magnitude with load:
 * ask the machine. Under swiftshader on a quiet box this is 15–30 frames a
 * second; at load average 28 it has been measured at barely one.
 */
const framesIn = (ms) => page.evaluate((d) => new Promise((res) => {
  const t0 = performance.now();
  let n = 0;
  const tick = () => {
    n++;
    if (performance.now() - t0 >= d) res(n);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), ms).catch(() => 0);

/**
 * Waits for the state this test is about to assert on, up to a deadline.
 *
 * This is the whole of the issue #25 fix and it loosens nothing: the caller
 * still asserts exactly what it always asserted, on the state as it stands
 * when this returns. A build where Resume genuinely does not work reaches the
 * deadline and fails, in `WAIT_MS` rather than instantly; a build that works
 * on a machine painting one frame a second now passes, which it did not.
 */
const waitUntil = async (want, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await st();
    if (s.alive && want(s)) return s;
    if (Date.now() >= deadline) return s;
    await page.waitForTimeout(200);
  }
};

console.log('\nA 44-LAP GRAND PRIX IS UNDER WAY');
const running = await waitUntil((s) => s.screen === 'racing' && s.hasEngine, 60_000);
check(running.screen === 'racing' && running.hasEngine, 'the session is running');
check(!running.overlayShown, 'nothing is covering the track while racing');

// THE MACHINE, MEASURED, before anything is asserted about it. Every deadline
// below is derived from this and every one of them is also floored, so a fast
// box still gets a sane wait and a crawling one gets the time it needs.
const framesPerSecond = (await framesIn(2000)) / 2;
const frameMs = framesPerSecond > 0 ? 1000 / framesPerSecond : 2000;
console.log(`  the page is painting ${framesPerSecond.toFixed(1)} frames a second `
  + `(${frameMs.toFixed(0)}ms a frame) under this machine's current load`);
/** Generous, finite, and a multiple of a frame rather than a guess. */
const WAIT_MS = Math.min(120_000, Math.max(8_000, frameMs * 40));

console.log('\nPAUSE MUST SHOW ITSELF');
await page.keyboard.press('Escape');
// The key is consumed on a frame boundary, so this waits for the frame rather
// than for a number of milliseconds somebody picked on a quiet machine.
const paused = await waitUntil((s) => s.paused && s.overlayShown, WAIT_MS);
check(paused.paused, 'the simulation is paused');
check(paused.overlayShown, 'a pause menu is on screen, so the game does not look hung');
check(paused.buttons.includes('Resume'), 'the pause menu offers Resume');
check(paused.buttons.some((b) => /abandon|quit|exit/i.test(b)), 'the pause menu offers a way out');

// STANDING STILL IS ONLY MEANINGFUL IF THE PAGE IS STILL DRAWING.
//
// This used to sleep 1500ms and compare two clock readings, which at one frame
// a second is less than one frame — so it would have passed a build that had
// stopped painting altogether, which is the hang this whole regression exists
// to rule out. It now counts the frames the page actually painted during the
// window and requires several of them alongside a clock that did not move.
const t1 = (await st()).simTime;
const stillWindow = Math.max(1500, frameMs * 6);
const framesWhilePaused = await framesIn(stillWindow);
const t2 = (await st()).simTime;
check(t1 === t2, `paused time really stands still (${t1} -> ${t2})`);
check(framesWhilePaused >= 3,
  `the paused game is still being drawn (${framesWhilePaused} frames in `
  + `${Math.round(stillWindow)}ms — a paused game that stops painting is a hang)`);

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
// The clock moving again is the assertion; how long the machine takes to draw
// the frame that moves it is not. Waits for the clock to pass the reading it
// was frozen at, and fails at the deadline if it never does.
const resumed = await waitUntil(
  (s) => !s.paused && !s.overlayShown && s.simTime > t2, WAIT_MS);
check(!resumed.paused && !resumed.overlayShown, 'the overlay is gone and the clock is running');
check(resumed.simTime > t2, `time is moving again (${t2} -> ${resumed.simTime})`);

console.log('\nABANDONING RETURNS TO THE MENUS AND CLEANS UP');
await page.keyboard.press('Escape');
await waitUntil((s) => s.paused && s.overlayShown, WAIT_MS);
await clickPauseButton('abandon|quit|exit', 'clicking the way out');
const quit = await waitUntil((s) => s.screen !== 'racing' && !s.hasEngine, WAIT_MS);
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
const again = await waitUntil((s) => s.screen === 'racing' && s.hasEngine, WAIT_MS);
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
