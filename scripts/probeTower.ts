/**
 * The timing tower, measured after layout — issues #17 and #35.
 *
 * TWO DEFECTS ON ONE PANEL, AND THEY ARE NOT THE SAME DEFECT. The user
 * reported both:
 *
 *   #17  "why can I only see like 4 cars on the leaderboard, where is
 *         everyone and all the cars?"      — how many ROWS are drawn.
 *   #35  "why are you waiting on me to display their times?"
 *                                          — what is inside the rows that are.
 *
 * Fixing one does not fix the other, so this probe keeps two sections and two
 * sets of numbers.
 *
 * WHY IT IS A BROWSER PROBE. Everything already written about this panel is a
 * check of a pure function, and both faults survive every one of them.
 * `probe:hudtext` §1b puts an idle player in a qualifying session and asserts
 * `standingsCells` returns a formatted lap time for all nineteen rivals — and
 * it passes, and has passed for the whole life of #35, because the string was
 * never missing. The cell it goes into was collapsed to zero pixels. In the
 * same way `towerFit` can return twenty rows while the panel draws four,
 * because the row count the player sees is decided after the mirror band, the
 * pit sheet and the media queries have had their say. Both facts are
 * properties of the laid-out document, so this measures the laid-out document:
 * real `Hud`, real `RaceEngine`, real stylesheet, `getBoundingClientRect`.
 *
 * Run: npm run probe:tower
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { TowerOpen, TowerReading } from '../audit/tower';
import { towerRailFloorPx } from '../src/ui/Hud';

const failures: string[] = [];
function check(ok: boolean, msg: string): void {
  if (!ok) failures.push(msg);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
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

/**
 * The viewports the panel has to work on.
 *
 * The laptop is in here because it is the shape the row count collapses on —
 * 800 CSS pixels of height against a fixed reservation of 500 — and because it
 * is the commonest desktop screen there is.
 */
const VIEWPORTS: { name: string; w: number; h: number }[] = [
  { name: 'desktop 1400x900', w: 1400, h: 900 },
  { name: 'laptop 1280x800', w: 1280, h: 800 },
  { name: 'portrait phone 390x844', w: 390, h: 844 },
  { name: 'landscape phone 844x390', w: 844, h: 390 },
];

/**
 * The cameras, because three of the seven put the car's own mirrors in shot
 * and the HUD lifts off the bottom of the frame when they do. That lift is
 * subtracted from the running order and from nothing else.
 */
const CAMERAS = ['chase', 'cockpit', 'driver'];

/**
 * WHEN A MISSING CAR IS THE PANEL'S FAULT.
 *
 * Not a tolerance: an exact question. If a car is missing from the board, then
 * drawing ONE more row must overrun the room the panel has — otherwise that
 * car was dropped by a rule rather than by geometry, which is the whole of
 * #17. Measured with the flag band out, because that is the tallest the panel
 * ever is and the row count is reserved against it.
 */
function oneMoreRowWouldOverrun(bottomBanded: number, rowH: number, floor: number): boolean {
  return bottomBanded + rowH + CHROME_SLACK_PX > floor;
}

/**
 * What the panel's own reservation is allowed to be wrong by, in pixels.
 *
 * `towerFit` reserves the LARGER of its measured chrome and its modelled
 * constant, because the measurement arrives a frame late and the thing under
 * this panel is the radio card — see the note there. That asymmetry can leave
 * up to about half a row unused, and this is the allowance for it. It is not a
 * tolerance on the fault: the fault this section exists to catch measured
 * 182–269 pixels of unused rail with nine to fifteen cars missing.
 */
const CHROME_SLACK_PX = 12;

/** Where the board's own portrait is written, for the comparison in the PR. */
const SHOT_DIR = resolve(process.cwd(), 'hud-out', 'tower');

/**
 * What the rail below the tower must keep for itself.
 *
 * Imported from the HUD rather than restated, because a probe that carries its
 * own copy of the number it is checking agrees with itself and with nothing
 * else. It is the smallest the radio card may be squeezed to before `fitRail`
 * throws it away instead, plus the rail's own top mask, plus the gap under the
 * tower — the floor, not the worst case. The cues that sit under it appear
 * when the session gives them a reason to and are measured directly when
 * they do.
 */
const railFloorFor = towerRailFloorPx;

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/tower.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 10 * 60_000,
    args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });
  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: unknown) => { errors.push(`pageerror: ${String(e)}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__tower', { timeout: 120_000 });

  const open = async (o: TowerOpen): Promise<TowerReading> => {
    await page.evaluate((arg: TowerOpen) => window.__tower.open(arg), o);
    return await page.evaluate(() => window.__tower.read()) as TowerReading;
  };
  const camera = async (mode: string): Promise<TowerReading> => {
    await page.evaluate((m: string) => window.__tower.camera(m), mode);
    await page.evaluate(() => window.__tower.paint());
    return await page.evaluate(() => window.__tower.read()) as TowerReading;
  };
  const reread = async (): Promise<TowerReading> => {
    await page.evaluate(() => window.__tower.paint());
    return await page.evaluate(() => window.__tower.read()) as TowerReading;
  };

  // =========================================================================
  // 1. #35 — a lap time belongs to the car that set it
  // =========================================================================
  //
  // The player is in their garage with the engine running and has completed
  // nothing. The other nineteen are on the circuit setting times. Every one of
  // those times must be on the board, drawn, in the frame — in all three
  // session kinds, because `Classification.ts` splits a Lap Time Classified
  // Session from a race and the two reach the tower by different routes.
  console.log('\n1. THE RIVALS\' TIMES, WITH THE PLAYER AT ZERO LAPS');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

  // THE PLAYER IS THE LAST CAR IN THE GARAGE, and that is not a preference.
  // With an idle player in the FIRST box, no car in the field ever leaves the
  // pit lane — measured, 0 of 20 out of the lane after fifteen minutes at
  // Monza, in both practice and qualifying. That is a real defect and it
  // belongs to the AI's pit-lane behaviour, not to the tower; putting the
  // player in the last box releases the other nineteen ahead of them and
  // isolates the question this section is asking.
  const SESSIONS: { kind: 'race' | 'qualifying' | 'practice'; circuit: string; seconds: number;
    o?: Partial<TowerOpen> }[] = [
    { kind: 'qualifying', circuit: 'monza', seconds: 420,
      o: { qualifyingPhase: 1, advancing: 15, durationS: 1080, playerIndex: 19 } },
    { kind: 'practice', circuit: 'bahrain', seconds: 480, o: { playerIndex: 19 } },
    // A race the player never gets away from the line in: standing start, no
    // throttle. The field disappears up the road and completes laps; the
    // player completes none. This is the first lap of every race the user has
    // ever run, held still so it can be measured.
    { kind: 'race', circuit: 'monza', seconds: 420,
      o: { standingStart: true, pitLaneStart: false, laps: 30 } },
  ];

  // Both frame shapes. The compact stylesheet writes its own column template
  // for the row, so a column that exists on a desktop can be missing from a
  // phone entirely — and the reporting device is a phone.
  const TIME_VIEWPORTS = [
    { name: 'desktop 1400x900', w: 1400, h: 900 },
    { name: 'portrait phone 390x844', w: 390, h: 844 },
  ];

  for (const vp of TIME_VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    for (const s of SESSIONS) {
      const r = await open({ kind: s.kind, circuit: s.circuit, seconds: s.seconds, ...s.o });
      const rivalsTimed = r.truth.filter((c) => !c.player && c.best > 0);
      const where = `${vp.name}/${s.kind}`;
      console.log(`\n  ${where} at ${s.circuit}: player lap ${r.player.lap}, ` +
        `best ${r.player.best.toFixed(3)}, retired ${r.player.retired}; ` +
        `${rivalsTimed.length} of ${r.field - 1} rivals timed; ` +
        `${r.shown} rows drawn; is-timed ${r.timed}`);
      console.log(`  cols: ${r.cols}`);

      check(!(r.player.best > 0),
        `${where}: the player set a lap (${r.player.best.toFixed(3)}) — ` +
        'the scenario is not testing anything');
      check(rivalsTimed.length >= 5,
        `${where}: only ${rivalsTimed.length} rivals set a time in ${s.seconds}s — ` +
        'the scenario is not testing anything');

      // Every drawn row whose car has a time must show that time, in pixels.
      const drawn = r.rows.filter((row) => row.code !== r.player.code);
      let withTime = 0;
      const blank: string[] = [];
      for (const row of drawn) {
        const car = r.truth.find((c) => c.code === row.code);
        if (!car || !(car.best > 0)) continue;
        withTime++;
        const shows = row.timeVisible && /^\d+:\d\d\.\d\d\d$/.test(row.time.trim());
        if (!shows) {
          blank.push(`${row.code} set ${car.best.toFixed(3)}, cell "${row.time}" ` +
            `at ${row.timeW}px wide`);
        }
      }
      check(withTime > 0, `${where}: no drawn row belongs to a car with a time`);
      // THE BOARD HAS A LAP-TIME COLUMN IN A LAP TIME CLASSIFIED SESSION, and
      // only where the panel is wide enough for the reference's five columns
      // plus a sixth. A compact panel is 176-232px and does not have the room:
      // the seven columns it does have are exactly the five the reference
      // names plus the livery bar and the badge, and the lap time is what
      // leaves. So the assertion follows the column, and where there is no
      // column the figure in the GAP cell has to be the car's own.
      const hasTimeColumn = r.timed && vp.w > 900 && vp.h > 470;
      if (!hasTimeColumn) {
        // REPORTED, NOT ASSERTED, and the reason is a conflict between two of
        // the user's own instructions rather than a tolerance. The race board
        // in `reference/target/68.png` is position, team mark, code, gap,
        // compound — there is no lap-time column in it, and the instruction
        // about that image is "copy this!!! don't change shit from it". So the
        // column is not drawn in a race, and every rival's lap time is still
        // missing from a race board, which is what #35 reports. A column was
        // built, measured and taken back out; the issue stays open with this
        // number on it and the user arbitrates.
        console.log(`  REPORTED (#35, open): ${blank.length} of ${withTime} rows on this ` +
          'board carry a lap time the car set in a cell the board has no column for');
        // What the race board MUST do is show every car its own figure, per
        // car, owing nothing to the player — which is the half of #35 that is
        // decidable without contradicting the reference.
        const noFigure = drawn.filter((row) => row.gap.trim() === '' || row.gapW < 1).length;
        check(noFigure === 0,
          `${where}: ${noFigure} rows have no figure in the gap column while the ` +
          'player has completed no lap');
      } else {
        check(blank.length === 0,
          `${where}: ${blank.length} of ${withTime} drawn rows withhold a time that was set` +
          (blank.length ? ` — e.g. ${blank[0]}` : ''));
      }

      // The row is a grid and the panel is a fixed width: a column added to a
      // template that has no room for it does not show a time, it pushes
      // somebody else's name out of the panel. Nothing may overhang.
      const overhang = r.rows.filter((row) => row.timeW > 0 && !row.timeVisible).length;
      check(overhang === 0,
        `${where}: ${overhang} lap-time cells are laid out outside the panel`);
      const spill = Math.max(0, ...r.rows.map((row) => row.overflow));
      check(spill === 0,
        `${where}: the row template overruns the panel by ${spill}px`);
      // The driver's code is the identification on a row that has no room for
      // a name. A column too narrow for it cuts letters off, silently.
      const clipped = r.rows.filter((row) => row.codeClipped > 0);
      check(clipped.length === 0,
        `${where}: ${clipped.length} driver codes are cut off — ` +
        `worst ${Math.max(0, ...r.rows.map((row) => row.codeClipped))}px in a ` +
        `${r.rows[0]?.codeW ?? 0}px column`);

      // The fastest-lap strip is the same question asked about one car, and it
      // is the one a player notices missing first.
      check(/\d+:\d\d\.\d\d\d/.test(r.fastest),
        `${where}: the fastest-lap strip reads "${r.fastest.trim()}" while ` +
        `${rivalsTimed.length} rivals have set laps`);
    }
  }

  // =========================================================================
  // 2. #17 — how many cars are on the board
  // =========================================================================
  //
  // The rule asserted here is not a row count. It is that a car is only ever
  // missing from the running order because there is no pixel left to draw it
  // on: if the tower stops short of the room it has by more than one row while
  // cars are missing, something dropped them, and that something is the bug.
  console.log('\n2. THE ROW COUNT, AGAINST THE ROOM THE PANEL HAS');
  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    const first = await open({ kind: 'race', circuit: 'monza', seconds: 240, laps: 60,
      standingStart: false, pitLaneStart: false });
    void first;
    for (const cam of CAMERAS) {
      const r = await camera(cam);
      // The same panel with its flag band out, which is the tallest it ever
      // is. The row count is reserved against THIS height, not against the
      // quiet frame, because a safety car is the moment a driver most needs
      // the running order and the worst moment for it to be sitting on the
      // radio.
      await page.evaluate(() => window.__tower.flagBand(true));
      const banded = await reread();
      await page.evaluate(() => window.__tower.flagBand(false));
      await reread();
      // The floor the panel is competing with: whatever the rail is actually
      // carrying, or the rail's own minimum when it is carrying nothing, and
      // the mirror band when the camera has one.
      // THE LIMIT IS THE RAIL'S OWN MEASURED FOOT, not the bottom of the
      // screen. `.hud-notices` stops 86px above the foot on a desktop, 196 in
      // portrait, and rises again by the whole mirror band when the camera has
      // glass in it — so the panel's budget is the band's foot, and a probe
      // that measured against the viewport would demand rows there is no room
      // for.
      const floorPx = railFloorFor(r.viewport.h, r.viewport.w, r.mirrorTopPx);
      const railFloor = r.rail.pinned.length > 0
        ? r.rail.occupiedTop
        : r.rail.bottom - floorPx;
      // Measured on the BANDED panel in both directions, because that is the
      // height the row count is reserved against: asking the quiet frame
      // whether it wasted a row would count the flag band's own 39 pixels as
      // waste and demand a row that a safety car would then push into the rail.
      const unused = Math.round(railFloor - banded.tower.bottom);
      const rowH = r.rows.length > 0 ? r.rows[0].height : 20;
      const couldFit = Math.floor(Math.max(0, unused) / rowH);
      console.log(`  ${vp.name.padEnd(24)} ${cam.padEnd(8)} ` +
        `${String(r.shown).padStart(2)}/${r.field} rows  row ${rowH}px  ` +
        `tower ${r.tower.top}–${r.tower.bottom} (${banded.tower.bottom} banded)  ` +
        `floor ${Math.round(railFloor)}  ` +
        `unused ${unused}px (~${couldFit} rows)  band +${banded.tower.bottom - r.tower.bottom}px  rail [${r.rail.pinned.join(' ')}]`);
      check(r.shown === r.field
        || oneMoreRowWouldOverrun(banded.tower.bottom, rowH, railFloor),
        `${vp.name}/${cam}: ${r.shown} of ${r.field} cars on the board with ` +
        `${unused}px of unused rail beneath it — room for ~${couldFit} more`);
      // THE BOARD DOES NOT SKIP — issue #76, and the assertion is one line.
      //
      //   "also the leader board has 1st place and then 7-20th why not how the
      //    whole fucking leaderboard bro"
      //
      // Positions down the drawn rows must increment by exactly one. A pinned
      // leader over a window that has scrolled off them fails this, which is
      // what the user photographed; so does dropping a retirement out of the
      // middle of the order.
      const drawnPos = r.rows.map((row) => Number(row.pos));
      const skips = drawnPos.filter((p, i) => i > 0 && p !== drawnPos[i - 1] + 1);
      check(skips.length === 0,
        `${vp.name}/${cam}: the board skips ${skips.length} place(s) — ` +
        drawnPos.join(','));
      // Whatever else happens, the player's own row is on the board. A tower
      // that drops the driver reading it has answered no question at all.
      check(r.rows.some((row) => row.cls.includes('is-player')),
        `${vp.name}/${cam}: the player's own row is not on the board`);
      // And the panel may not stand on the mirrors or run off the screen.
      const bottomLimit = r.rail.bottom;
      check(r.tower.bottom <= bottomLimit,
        `${vp.name}/${cam}: the tower reaches ${r.tower.bottom}px past a limit of ` +
        `${Math.round(bottomLimit)}px`);
      // THE OTHER SIDE OF THE SAME ASSERTION, and it is what stops "show more
      // cars" turning into "stand on the radio". Whatever the running order
      // takes, the rail keeps its floor: enough band for the smallest radio
      // card `sizeRadioCard` will draw, plus the mask nothing may be laid out
      // into. `shoot:panels` fails if a card is missing from a band that had
      // room for one, and this is the arithmetic that keeps it fed. Measured
      // with the flag band OUT, because that is the tallest the panel gets.
      //
      // Exempt at the panel's own four-row minimum, and only there: a
      // landscape phone in the driver's eye has 267px of column for a running
      // order and a rail, and `towerFit` spends it on four cars rather than on
      // an empty panel. That trade is older than this work and the numbers are
      // unchanged by it — 4 rows, tower bottom 138px, before and after.
      const atFloor = r.shown <= 4;
      check(atFloor || bottomLimit - banded.tower.bottom >= floorPx - 1,
        `${vp.name}/${cam}: with the flag band out the tower leaves the rail ` +
        `${Math.round(bottomLimit - banded.tower.bottom)}px against a floor of ` +
        `${floorPx}px`);
    }
    await camera('chase');
  }

  // =========================================================================
  // 3. #17 — field sizes
  // =========================================================================
  //
  // `probe:fieldsize` proves the SIMULATION runs at 20, 22 and 24 cars. This
  // asks the panel the same question: a grid that grew must appear on the
  // board, not be silently truncated at the size the panel was written for.
  console.log('\n3. FIELD SIZES, ON A FULL-HEIGHT DESKTOP');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  for (const cars of [18, 20, 22, 24]) {
    const r = await open({ kind: 'race', circuit: 'monza', seconds: 180, laps: 60,
      standingStart: false, pitLaneStart: false, cars });
    const railFloor = r.rail.pinned.length > 0 ? r.rail.occupiedTop
      : r.rail.bottom - railFloorFor(r.viewport.h, r.viewport.w, 0);
    const unused = Math.round(railFloor - r.tower.bottom);
    console.log(`  ${cars} cars: ${r.shown} rows drawn, field ${r.field}, ` +
      `unused ${unused}px`);
    check(r.field === cars, `field of ${cars} produced ${r.field} participants`);
    check(r.shown === r.field
      || oneMoreRowWouldOverrun(r.tower.bottom, r.rows[0]?.height ?? 20, railFloor),
      `${cars} cars: ${r.shown} rows with ${unused}px unused beneath the tower`);
  }

  // =========================================================================
  // 4. #76 — the row the reference draws
  // =========================================================================
  //
  // `reference/target/68.png`, row one: `1  <Ferrari mark>  LEC  Leader  M`.
  // Five things, in that order, and the user's instruction about the image is
  // "copy this!!! don't change shit from it". This asserts the five are on
  // every drawn row, in pixels, in a race and in qualifying.
  //
  // WHAT IT DELIBERATELY DOES NOT ASSERT: the type, the scale and the header.
  // The board in the reference is a phone-height panel in F1's own proprietary
  // face, and matching its metrics is the open half of #76 — see the PR. A
  // probe that claimed the copy was complete would be worse than no probe.
  console.log('\n4. THE ROW THE REFERENCE DRAWS');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  for (const s of [
    { kind: 'race' as const, circuit: 'monza', seconds: 300,
      o: { standingStart: false, pitLaneStart: false, laps: 60 } },
    { kind: 'qualifying' as const, circuit: 'monza', seconds: 420,
      o: { qualifyingPhase: 1 as const, advancing: 15, durationS: 1080, playerIndex: 19 } },
  ]) {
    const r = await open({ kind: s.kind, circuit: s.circuit, seconds: s.seconds, ...s.o });
    const noMark = r.rows.filter((row) => !row.markDrawn).length;
    const noCode = r.rows.filter((row) => !/^[A-Z]{2,4}$/.test(row.code.trim())).length;
    const noTyre = r.rows.filter((row) => !row.tyreVisible || row.tyre.trim() === '').length;
    const noGap = r.rows.filter((row) => row.gap.trim() === '' || row.gapW < 1).length;
    const noPos = r.rows.filter((row) => !/^\d+$/.test(row.pos.trim())).length;
    console.log(`  ${s.kind}: ${r.shown} rows — ` +
      `${r.rows.slice(0, 3).map((row) => `${row.pos} ${row.code} ${row.gap} ${row.tyre}`)
        .join(' | ')}`);
    check(noPos === 0, `${s.kind}: ${noPos} rows have no position number`);
    check(noMark === 0, `${s.kind}: ${noMark} rows have no team mark drawn`);
    check(noCode === 0, `${s.kind}: ${noCode} rows have no three-letter code`);
    check(noGap === 0, `${s.kind}: ${noGap} rows have nothing in the gap column`);
    const gapCol = Math.min(...r.rows.map((row) => row.gapW));
    check(gapCol > 20,
      `${s.kind}: the gap column is ${gapCol}px wide — the figures are not drawn`);
    check(noTyre === 0, `${s.kind}: ${noTyre} rows have no compound letter`);
    // The leader's own cell, in the reference's own word and slant.
    const first = r.rows[0];
    if (s.kind === 'race') {
      check(first.gap.trim() === 'Leader',
        `the leader's cell reads "${first.gap.trim()}" and the reference says Leader`);
      check(first.gapItalic, 'the leader\'s cell is not italic');
    }
    // NO TIME, which is the state the board used to draw as an em dash — the
    // 2024 board in `reference/target/69.png` is eleven rows of it.
    const noTime = r.rows.filter((row) => row.gap.trim() === 'NO TIME').length;
    const dashes = r.rows.filter((row) => row.gap.trim() === '—').length;
    check(dashes === 0, `${s.kind}: ${dashes} rows say "—" where the reference says NO TIME`);
    if (s.kind === 'qualifying') {
      console.log(`  qualifying: ${noTime} rows read NO TIME, ` +
        `${r.rows.filter((row) => row.badges.includes('has-pit')).length} carry the P marker`);
    }
  }

  // A picture of the board at real size, for the comparison against
  // `reference/target/68.png` that PROJECT.md §3.1 asks for. Written rather
  // than described: every visual claim in this project that was made from a
  // sentence has eventually turned out to be wrong.
  {
    await mkdir(SHOT_DIR, { recursive: true });
    for (const shot of [
      { name: 'race-desktop', w: 1400, h: 900,
        o: { kind: 'race' as const, circuit: 'monza', seconds: 300, laps: 57,
          standingStart: false, pitLaneStart: false } },
      { name: 'race-portrait', w: 390, h: 844,
        o: { kind: 'race' as const, circuit: 'monza', seconds: 300, laps: 57,
          standingStart: false, pitLaneStart: false } },
      { name: 'qualifying-desktop', w: 1400, h: 900,
        o: { kind: 'qualifying' as const, circuit: 'monza', seconds: 300,
          qualifyingPhase: 1 as const, advancing: 15, durationS: 1080, playerIndex: 19 } },
    ]) {
      await page.setViewport({ width: shot.w, height: shot.h, deviceScaleFactor: 2 });
      const r = await open(shot.o);
      await page.screenshot({
        path: resolve(SHOT_DIR, `${shot.name}.png`) as `${string}.png`,
        clip: {
          x: r.tower.left - 4, y: r.tower.top - 4,
          width: r.tower.width + 8, height: r.tower.bottom - r.tower.top + 8,
        },
      });
      console.log(`  wrote ${shot.name}.png — ${r.shown} rows, ` +
        `${r.tower.width}x${r.tower.bottom - r.tower.top}px`);
    }
  }

  await browser.close();
  await server.close();

  if (errors.length > 0) {
    console.log('\nPAGE ERRORS');
    for (const e of errors) console.log('  ' + e);
  }
  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ` +
    `${failures.length} failure(s)`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1);
}

void main();
