/**
 * The player stops in Q1. What does the game do to them, and to the other
 * nineteen?
 *
 * Two questions, one scenario, because they are the same defect seen from two
 * sides — issue #33 and the note appended to it.
 *
 * 1. PRESENTATION. A full-screen `SESSION OVER` panel, blurred, with the clock
 *    stopped behind it. Reported five times:
 *
 *      "why is this shit back I thought we said to not have this retirement
 *       bullshit??"
 *      "don't do this shit. just have the team radio in some message and then
 *       top right corner or smth just be like continue and then once the user
 *       presses continue you can check the stats and shit."
 *
 *    So: the principal on the radio, race control on the FIA strip, CONTINUE
 *    and SEE OUT in a corner, nothing full-screen, nothing blurred, and the
 *    session still running.
 *
 * 2. CLASSIFICATION. "even tho I DNF doesn't mean that the rest weren't able to
 *    get a time classification." Whichever way the player leaves, the other
 *    cars must end up with real times.
 *
 * THIS MEASURES GEOMETRY, NOT CLASS NAMES. `getBoundingClientRect` against the
 * viewport, and the computed `backdrop-filter` of everything on screen. A probe
 * that looked for `.retire-overlay` by name would go green the moment somebody
 * reintroduced the same thing under a different selector, which is exactly the
 * failure mode PROJECT.md §4 keeps finding.
 *
 * Needs a browser. Boots its own dev server on a free port, like `regress:exit`.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run probe:qualiretire
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

async function freePort() {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PORT = Number(process.env.PROBE_QUALIRETIRE_PORT || await freePort());
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', shutdown);

await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`vite did not start in 60s on port ${PORT}`)), 60000);
  server.stdout.on('data', (b) => {
    const s = String(b);
    if (s.includes('ready in') || s.includes(`:${PORT}`)) { clearTimeout(timer); resolve(); }
  });
  server.on('error', reject);
});
await new Promise((r) => setTimeout(r, 800));

const failures = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', args: launchArgs });
} catch {
  browser = await chromium.launch({ args: launchArgs });
}
const VIEW = { width: 1280, height: 800 };
const page = await browser.newPage({ viewport: VIEW });
page.setDefaultNavigationTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', async (d) => await d.dismiss());

// Warm the dev server on the menus before the circuit build. See `regress:exit`
// for why this is not part of the test.
await page.goto(`http://localhost:${PORT}/?intro=0`, { waitUntil: 'load', timeout: 120_000 });
await page.goto(`http://localhost:${PORT}/?quality=low&circuit=bahrain&session=qualifying&intro=0`,
  { waitUntil: 'load', timeout: 120_000 });
await page.waitForTimeout(3000);

// ===========================================================================
// The scenario, built through the game's own entry points
// ===========================================================================
//
// A real Q1 — a knockout segment with a cut, not the deep link's undifferentiated
// "Qualifying" — because `qualifyingPhase` and `advancing` are what carry the
// Art. B4.3.2 and "Q2: outside the cut" content this is here to protect.
console.log('\nQ1 AT BAHRAIN, AND THE PLAYER PUTS IT IN THE GRAVEL');
await page.evaluate(() => {
  const g = window.__game;
  g.weekend = [g.sessionConfig('qualifying', 'Q1', 'bahrain', 720, 0, {
    qualifyingPhase: 1, advancing: 15, seed: 4001,
  })];
  g.weekendIndex = 0;
  g.qualifyingGrid = [];
  g.qualifyingSurvivors = [];
  g.qualifyingBarred = [];
  g.launchSession('bahrain');
});
await page.waitForTimeout(6000);

const started = await page.evaluate(() => ({
  screen: window.__game.screen,
  runners: window.__game.engine?.participants.length ?? 0,
}));
check(started.screen === 'racing' && started.runners === 20,
  `Q1 is running with ${started.runners} cars (screen "${started.screen}")`);

// RECORD WHAT IS SAID, NOT WHAT HAPPENS TO STILL BE ON SCREEN.
//
// Both voices are transient by design — the radio card dwells for 8s, a race
// control card for 7.2s, and the stack holds two. Sampling the DOM at some
// arbitrary later moment therefore asks "is it still up", which is not the
// question. This records every distinct card that mounts from the accident
// onward, so the assertion is "race control filed this ruling", which is what
// issue #33 actually asks for.
await page.evaluate(() => {
  const w = window;
  w.__said = { controls: [], radio: [] };
  const push = (arr, t) => { if (t && !arr.includes(t)) arr.push(t); };
  const text = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const record = () => {
    for (const e of document.querySelectorAll('.hud-control')) push(w.__said.controls, text(e));
    for (const e of document.querySelectorAll('.hud-alerts .hud-control')) push(w.__said.controls, text(e));
    const r = document.querySelector('.hud-radiocard');
    if (r && getComputedStyle(r).display !== 'none') push(w.__said.radio, text(r));
  };
  // Both, because the typewriter mutates character data on a node that is
  // already in the tree and the cards mount as children.
  new MutationObserver(record).observe(document.getElementById('app'),
    { subtree: true, childList: true, characterData: true, attributes: true });
  w.__saidTick = setInterval(record, 100);
});

// The accident, exactly as the screenshot reported it. `retire` is the engine's
// own entry point, so this is the state a real gravel trap produces.
const playerNumber = await page.evaluate(() => {
  const g = window.__game;
  g.engine.playerCar.retire('Beached in the gravel', g.engine.time, 0.85);
  // THE 2.6-SECOND DELAY IS NOT WHAT THIS PROBE IS TESTING, and it is charged
  // in SESSION time. `Game.RETIREMENT_DELAY_S` exists so the player gets to
  // watch the accident happen before anything is said, which is right and
  // stays. But under a software rasteriser this session advances at roughly a
  // hundredth of realtime on a loaded machine — measured, 0.06s of session in
  // 4s of wall clock — so waiting it out costs minutes and, at load average 93,
  // blew a 120-second budget and failed every assertion downstream for a reason
  // that had nothing to do with the code under test. Backdating the stamp the
  // delay is measured from satisfies it on the next frame. Everything the probe
  // actually asserts happens after it.
  g.retiredAt = -1e6;
  return g.engine.playerCar.driver.raceNumber;
});

// WAIT FOR THE PRESENTATION, DO NOT GUESS AT IT.
//
// A fixed nine-second wait reached the assertions with 1.0s of session on the
// clock and the retirement not yet raised. Every check then failed for the
// wrong reason, and worse, the two phrased in the negative ("nothing has taken
// the screen over", "race control did not call it a retirement") PASSED on the
// very build this probe exists to fail. A probe a broken feature passes is
// worse than no probe; this polls the shell's own flag instead.
const shown = await waitFor(
  () => page.evaluate(() => window.__game.retirementShown === true),
  120_000, 'the retirement to be raised');
check(shown, 'the game said something about the accident');
// One more beat for the rAF that reveals the bar.
await page.waitForTimeout(1500);

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await page.waitForTimeout(500);
  }
  console.log(`  (gave up waiting ${ms}ms for ${what})`);
  return false;
}

// ===========================================================================
// 1. What is on the screen
// ===========================================================================
console.log('\nWHAT THE PLAYER IS LOOKING AT');

const scene = await page.evaluate(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const area = vw * vh;
  const visible = (e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  // The canvas is the game, not something covering it.
  const all = [...document.querySelectorAll('#app *')]
    .filter((e) => e.tagName !== 'CANVAS').filter(visible);

  // A TAKEOVER, defined by what it does rather than by what it is called: an
  // element that covers most of the viewport AND swallows the pointer. The HUD
  // is full-bleed and must not count — it is `pointer-events: none` by
  // construction, which is precisely the difference.
  const takeovers = all.filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width * r.height < area * 0.6) return false;
    const s = getComputedStyle(e);
    if (s.pointerEvents === 'none') return false;
    // Only things that paint. A transparent positioning wrapper is not a modal.
    return s.backgroundImage !== 'none'
      || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent')
      || /blur/.test(s.backdropFilter || '');
  }).map((e) => ({
    cls: e.className, w: Math.round(e.getBoundingClientRect().width),
    h: Math.round(e.getBoundingClientRect().height),
    bg: getComputedStyle(e).backgroundColor,
  }));

  // BLURRING THE GAME is not the same as being frosted. Every HUD panel in
  // this project is `backdrop-filter: blur(14px)` and always has been — a
  // 200x90 frosted tile over the road is the visual language, not the
  // complaint. What the user is objecting to is the CIRCUIT going soft behind
  // a card, so the threshold is area: anything blurring more than 40% of the
  // viewport is blurring the game.
  const blurred = all.filter((e) => {
    const f = getComputedStyle(e).backdropFilter;
    if (!f || f === 'none' || !/blur/.test(f)) return false;
    const r = e.getBoundingClientRect();
    return r.width * r.height >= area * 0.4;
  }).map((e) => ({ cls: e.className, filter: getComputedStyle(e).backdropFilter }));

  const bar = document.querySelector('.retirebar');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const labels = bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];

  // The two voices, by the classes the HUD actually gives them.
  const said = window.__said;
  return {
    said,
    vw, vh, takeovers, blurred, labels,
    hudText: (document.querySelector('.hud')?.textContent || '').replace(/\s+/g, ' '),
    bar: barRect && {
      x: Math.round(barRect.x), y: Math.round(barRect.y),
      w: Math.round(barRect.width), h: Math.round(barRect.height),
      areaPct: +((barRect.width * barRect.height) / area * 100).toFixed(2),
    },
    paused: window.__game.clock.paused,
    simTime: window.__game.engine?.time ?? null,
  };
});

check(scene.takeovers.length === 0,
  `nothing has taken the screen over (${scene.takeovers.length}: ` +
  `${scene.takeovers.map((t) => `${t.cls} ${t.w}x${t.h} ${t.bg}`).join(' | ')})`);
check(scene.blurred.length === 0,
  `nothing is blurring the game behind it (${scene.blurred.map((b) => b.cls + ' ' + b.filter).join(' | ')})`);
check(scene.bar !== null, 'the retirement controls are on screen');
if (scene.bar) {
  check(scene.bar.x + scene.bar.w > scene.vw * 0.5 && scene.bar.y < scene.vh * 0.25,
    `the controls are in the top-right corner (x=${scene.bar.x}+${scene.bar.w} of ${scene.vw}, y=${scene.bar.y})`);
  check(scene.bar.areaPct < 8,
    `the controls take a corner, not the screen (${scene.bar.areaPct}% of the viewport)`);
}
check(scene.labels.some((l) => /^continue$/i.test(l)),
  `CONTINUE is one of the corner controls (found: ${JSON.stringify(scene.labels)})`);
check(scene.labels.some((l) => /see out/i.test(l)),
  `SEE OUT is one of the corner controls (found: ${JSON.stringify(scene.labels)})`);
// 1. THE PRINCIPAL, FIRST, AS A PERSON. Not "a card appeared" — the words. The
//    exchange this game gives a retirement opens "Are you okay? Talk to me."
//    and that ordering is the whole of the two-voice design.
const radioText = scene.said.radio.join(' ');
check(scene.said.radio.length > 0,
  'the principal has spoken — a radio transmission was raised');
check(/are you okay/i.test(radioText),
  `the principal asked after the driver before anything else ("${radioText.slice(0, 120)}")`);

// 2. RACE CONTROL, SECOND, and in a Lap Time Classified Session the ruling is
//    not "retired". Art. B2.4.3b's three routes out of the classification are
//    the 107% rule, no time in Q1 and disqualification; an accident is on none
//    of them. Art. B4.3.2 is what actually applies.
const stripText = scene.said.controls.join(' | ').toUpperCase();
check(scene.said.controls.length > 0,
  'race control filed something on the FIA strip');
check(/NO FURTHER PART/.test(stripText),
  `race control ruled under Art. B4.3.2 on the strip ("${stripText.slice(0, 200)}")`);
// Scoped to THIS driver's card, and gated on that card existing, so it cannot
// pass by nothing having been said — and cannot fail because some other car's
// bulletin legitimately used the word.
const mine = scene.said.controls.filter((t) => t.includes(String(playerNumber))
  || /NO FURTHER PART/i.test(t));
check(mine.length > 0 && !/\bRETIRED\b/i.test(mine.join(' ')),
  `race control did not call this driver's qualifying accident a retirement ` +
  `("${mine.join(' | ').slice(0, 200)}")`);

console.log('\nTHE SESSION IS STILL RUNNING BEHIND IT');
check(!scene.paused, 'the clock was not stopped by the player stopping');
await page.waitForTimeout(4000);
const later = await page.evaluate(() => window.__game.engine?.time ?? null);
check(later > scene.simTime,
  `the other nineteen are still running (${scene.simTime?.toFixed(2)} -> ${later?.toFixed(2)})`);

// ===========================================================================
// 2. The numbers, on request
// ===========================================================================
console.log('\nCONTINUE SHOWS THE NUMBERS, AND THEY ARE STILL THE REGULATION ONES');

await page.evaluate(() => {
  [...document.querySelectorAll('.retirebar button')]
    .find((b) => /^continue$/i.test(b.textContent.trim()))?.click();
});
await page.waitForTimeout(1200);

const sheet = await page.evaluate(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const el = document.querySelector('.retire-sheet');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    areaPct: +((r.width * r.height) / (vw * vh) * 100).toFixed(1),
    right: Math.round(r.x + r.width), vw,
    blurred: getComputedStyle(el).backdropFilter,
    paused: window.__game.clock.paused,
    buttons: [...el.querySelectorAll('button')].map((b) => b.textContent.trim()),
  };
});

check(sheet !== null, 'Continue opened the numbers');
if (sheet) {
  check(sheet.areaPct < 45,
    `the numbers are a sheet, not a takeover (${sheet.areaPct}% of the viewport)`);
  check(sheet.right > sheet.vw * 0.6, 'the sheet is anchored to the corner the controls are in');
  check(!/blur/.test(sheet.blurred || ''), 'the sheet does not blur the game behind it');
  check(!sheet.paused, 'opening the numbers did not stop the session');

  // EVERY PIECE OF REGULATION CONTENT FROM THE OLD PANEL. This is the half of
  // the issue that is easy to lose: the panel had to go, the facts on it did
  // not. Art. B2.4.3a classifies on the lap set — so "no time set" against a
  // provisional position is correct and not a contradiction.
  const t = sheet.text;
  check(/no further part in qualifying/i.test(t),
    'Art. B4.3.2 — "no further part in qualifying" — survived');
  check(/keep every place your lap earned/i.test(t),
    'the LTCS promise — you keep the places your lap earned — survived');
  check(/As it stands/i.test(t) && /P\d+ of \d+ in Q1/i.test(t),
    `the provisional position survived ("${(t.match(/As it stands.{0,40}/i) || [''])[0]}")`);
  check(/Your best lap|Fastest lap of the session/i.test(t), 'the best-lap fact survived');
  check(/Rest of qualifying/i.test(t) && /No further part/i.test(t),
    'the "rest of qualifying" fact survived');
  check(/Q2/.test(t) && /(Through, on this order|Outside the cut)/i.test(t),
    'whether the driver is through to Q2 survived');
  check(/Worst damage/i.test(t), 'the damage report survived');
  check(/Where/i.test(t), 'where it happened survived');
}

// ===========================================================================
// 3. Whichever way they leave, the other cars get a classification
// ===========================================================================
//
// "even tho I DNF doesn't mean that the rest weren't able to get a time
// classification, just make the simulation up or something, ykwim"
console.log('\nTHE OTHER NINETEEN GET A REAL CLASSIFICATION');

const atLeaving = await page.evaluate(() => {
  const e = window.__game.engine;
  return {
    time: e.time,
    withTime: e.participants.filter((c) => c.bestLapTime > 0).length,
    runners: e.participants.length,
  };
});
console.log(`  at the moment the player asks: ${atLeaving.withTime}/${atLeaving.runners} ` +
  `cars have a lap, t=${atLeaving.time.toFixed(0)}s`);

const ranOut = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.retire-sheet button')]
    .find((e) => /run it out|skip to the result/i.test(e.textContent.trim()));
  if (!b) return false;
  b.click();
  return true;
});
check(ranOut, 'the sheet offers a way to the result');

// The run-out is frame-sliced at ~26ms a frame under a software rasteriser that
// is also drawing nothing, so it is fast — but "fast" on a loaded machine is
// still tens of seconds. Poll rather than guess.
// Nothing was clicked, so there is nothing to wait for — do not spend three
// minutes polling a screen that is never going to change.
const deadline = Date.now() + (ranOut ? 180_000 : 5_000);
let landed = null;
while (Date.now() < deadline) {
  landed = await page.evaluate(() => ({
    screen: window.__game.screen,
    time: window.__game.engine?.time ?? null,
    withTime: window.__game.engine
      ? window.__game.engine.participants.filter((c) => c.bestLapTime > 0).length : 0,
    runners: window.__game.engine?.participants.length ?? 0,
  }));
  if (landed.screen === 'results') break;
  await page.waitForTimeout(1000);
}

check(landed.screen === 'results',
  `the classification was published (screen "${landed.screen}")`);
console.log(`  at the classification: ${landed.withTime}/${landed.runners} cars have a lap, ` +
  `t=${landed.time?.toFixed(0)}s`);
// Nineteen of twenty. The twentieth is the player, who is in the gravel — and
// "no time set" for them is the correct LTCS outcome, not a missing result.
check(landed.withTime >= landed.runners - 1,
  `every car that was still running set a time (${landed.withTime} of ${landed.runners})`);
check(landed.time > atLeaving.time + 60,
  `the session was run on rather than truncated ` +
  `(t=${atLeaving.time.toFixed(0)}s -> ${landed.time?.toFixed(0)}s)`);

// And the board the player is actually looking at says the same thing. Read
// off the rendered timing board rather than off the engine, because the whole
// class of bug this issue belongs to is a screen disagreeing with the model
// it is drawing.
const board = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.screen .tboard .trow')];
  return {
    rows: rows.length,
    // The first figures column of a qualifying board is the best lap.
    noTime: rows.filter((r) => {
      const cell = r.querySelector('.t-fig');
      return !cell || !/\d:\d\d/.test(cell.textContent || '');
    }).length,
    sample: rows.slice(0, 3).map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim()),
  };
});
check(board.rows >= 20, `the published board lists the whole field (${board.rows} rows)`);
check(board.rows > 0 && board.noTime <= 1,
  `the published board shows a lap time for everyone but the driver who stopped ` +
  `(${board.noTime} of ${board.rows} rows without one) — sample: ${JSON.stringify(board.sample)}`);

// ===========================================================================
// 4. And the race case, which was fixed first, still holds
// ===========================================================================
//
// Issue #16. The race retirement was moved to the radio before qualifying was,
// and this asserts it rather than assuming it — the whole reason #33 exists is
// that one of the two got left behind, and nobody noticed for four requests.
console.log('\nTHE RACE CASE (#16) STILL HOLDS');

await page.evaluate(() => {
  const g = window.__game;
  g.weekend = [g.sessionConfig('race', 'Grand Prix', 'bahrain', 0, 8, { seed: 4101 })];
  g.weekendIndex = 0;
  g.launchSession('bahrain');
});
await page.waitForTimeout(7000);
await page.evaluate(() => {
  const g = window.__game;
  g.engine.playerCar.retire('Accident damage', g.engine.time, 0.9);
  g.retiredAt = -1e6; // See the note on the qualifying case.
});
const raceShown = await waitFor(
  () => page.evaluate(() => window.__game.retirementShown === true),
  120_000, 'the race retirement to be raised');
check(raceShown, 'the game said something about the race accident');
await page.waitForTimeout(1500);

const raceScene = await page.evaluate(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const area = vw * vh;
  const visible = (e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const all = [...document.querySelectorAll('#app *')]
    .filter((e) => e.tagName !== 'CANVAS').filter(visible);
  const blurred = all.filter((e) => {
    const f = getComputedStyle(e).backdropFilter;
    if (!f || f === 'none' || !/blur/.test(f)) return false;
    const r = e.getBoundingClientRect();
    return r.width * r.height >= area * 0.4;
  }).map((e) => e.className);
  const takeovers = all.filter((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    if (r.width * r.height < area * 0.6 || s.pointerEvents === 'none') return false;
    return s.backgroundImage !== 'none'
      || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent')
      || /blur/.test(s.backdropFilter || '');
  }).map((e) => e.className);
  const bar = document.querySelector('.retirebar');
  const r = bar?.getBoundingClientRect();
  return {
    takeovers, blurred, vw, vh,
    labels: bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
    corner: r ? (r.x + r.width > vw * 0.5 && r.y < vh * 0.25) : false,
    paused: window.__game.clock.paused,
    lap: window.__game.engine?.standings?.[0]?.lap ?? null,
    laps: window.__game.engine?.config.laps ?? null,
  };
});

check(raceScene.takeovers.length === 0,
  `a race retirement takes nothing over (${raceScene.takeovers.join(' | ')})`);
check(raceScene.blurred.length === 0,
  `a race retirement blurs nothing (${raceScene.blurred.join(' | ')})`);
check(raceScene.labels.some((l) => /^continue$/i.test(l)) &&
  raceScene.labels.some((l) => /watch the race/i.test(l)),
  `the race's two corner controls are there (${JSON.stringify(raceScene.labels)})`);
check(raceScene.corner, 'the race controls are in the top-right corner');
check(!raceScene.paused, 'a race retirement does not stop the race');

// ===========================================================================
// 5. AND `CONTINUE` PUBLISHES A RACE THAT WAS ACTUALLY RUN (issue #56)
// ===========================================================================
//
// This section used to be the two lines below it: a `console.log` of the
// leader's lap against the race distance, printed and deliberately not
// asserted, with the note "pressing Continue classifies the race from here."
// It did — `Continue` called `Game.finishSession` on the spot, which reads
// `engine.standings` (the live running order of a Grand Prix the other
// nineteen cars are still in the middle of) and hands it to
// `recordPlayerRound` as the round's result.
//
// Issue #56 asked for exactly this: "turn that print into an assertion when
// this is fixed." So the print stays — the lap the player stopped on is the
// thing that makes the assertion mean something — and the assertions sit under
// it. They are on the ENGINE'S OWN STATE at the moment the classification
// screen appears, not on the button or on the screen, because the defect was
// never in the presentation: what was published was a real screen showing a
// race that had not happened.
console.log(`  the player stopped with the leader on lap ${raceScene.lap} of ` +
  `${raceScene.laps}; Continue must not classify the race from here`);

check(raceScene.lap !== null && raceScene.laps !== null && raceScene.lap <= raceScene.laps,
  `the race really is still running when Continue becomes available ` +
  `(leader on lap ${raceScene.lap} of ${raceScene.laps}) — otherwise this section ` +
  'proves nothing');

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.retirebar button')]
    .find((x) => /^continue$/i.test((x.textContent || '').trim()));
  if (b) b.click();
});

// It must go to the run-out FIRST. A jump straight to the classification is the
// bug, and it is the fast path, so this is checked before the slow wait below —
// otherwise a build that classified instantly would satisfy the final state
// checks by accident on a race short enough to be already over.
const wentToRunOut = await waitFor(
  () => page.evaluate(() => window.__game.screen === 'simulating'),
  20_000, 'the race to be run out to the flag');
check(wentToRunOut,
  'Continue runs the race out to the flag rather than classifying it where it stood');

const gotClassification = await waitFor(
  () => page.evaluate(() => window.__game.screen === 'results'),
  420_000, 'the classification of the run-out race');
check(gotClassification, 'the run-out reaches the classification screen');

const published = await page.evaluate(() => {
  const e = window.__game.engine;
  if (!e) return null;
  const laps = e.config.laps;
  return {
    over: e.over,
    raceFinished: e.raceControl.raceFinished,
    laps,
    leaderLap: Math.max(...e.cars.map((c) => c.lap)),
    wentTheDistance: e.cars.filter((c) => c.lap > laps).length,
    unresolved: e.cars.filter((c) => !c.finished && !c.retired).length,
    cars: e.cars.length,
    playerRetired: !!e.playerCar?.retired,
  };
});

check(!!published && published.over,
  `the race the classification is taken from reached its own end ` +
  `(over=${published?.over})`);
check(!!published && published.raceFinished,
  'the chequered flag came out before the classification was published');
check(!!published && published.leaderLap > published.laps,
  `the winner covered the full distance ` +
  `(leader on lap ${published?.leaderLap} of ${published?.laps})`);
// The leader alone is not enough — the whole point of #56 is the OTHER cars.
check(!!published && published.wentTheDistance >= Math.ceil(published.cars * 0.5),
  `the field covered the distance, not just the winner ` +
  `(${published?.wentTheDistance} of ${published?.cars} completed ${published?.laps} laps)`);
check(!!published && published.unresolved === 0,
  `every car is either a classified finisher or a retirement ` +
  `(${published?.unresolved} of ${published?.cars} are neither)`);
// And running it out did not quietly give the player their race back.
check(!!published && published.playerRetired,
  'the player is still retired in the classification they published');

check(pageErrors.length === 0, `no uncaught page errors (${pageErrors.slice(0, 3).join(' | ')})`);

await browser.close();
shutdown();

console.log('');
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('A qualifying accident is a radio message and a corner control, and the ' +
  'other cars still get their times.');
process.exit(0);
