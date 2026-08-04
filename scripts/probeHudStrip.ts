/**
 * The race-control strip, measured against `reference/target/77.png` — #15.
 *
 * WHY THIS PROBE EXISTS, in PROJECT.md §7's own words: *"The work also needs a
 * measurement, and the model for it exists: `probe:tower` §5 measures where
 * each column of the running order sits as a fraction of the panel against
 * numbers taken off `68.png` itself. A `probe:hudstrip` doing the same against
 * `77.png` is what would stop this being settled by eye for a fourth time."*
 * This is that probe. #15 had been settled by eye three times — a rounded card
 * with a yellow edge, then a navy strip, then a navy strip with a prefix — and
 * each pass believed it had copied the reference.
 *
 * WHAT NO EXISTING PROBE COULD HAVE CAUGHT. `probe:hudtext` checks what
 * `raceControlCard` RETURNS and has passed for the whole life of #15, because
 * not one of the seven differences the reference names is a difference in the
 * words. `shoot:panels` checks that the card does not overlap anything, and a
 * card in the wrong colour overlaps nothing. `audit:circuits` writes a PNG for
 * a human, which is §3.1's definition of not measuring.
 *
 * WHERE THE NUMBERS COME FROM, all of them off the frame rather than off a
 * description of it. `reference/target/77.png` is 1200x673. The strip's edges
 * are hue and luma steps on a clean row above the type (y = 60) and a clean
 * column inside the left block (x = 345): x 336..863, y 53..137, so W = 528 and
 * H = 84. Each block's fraction is its own extent over that 528. The type
 * bands are the rows on which red ink and white ink appear over x = 445..800,
 * thresholded at (R > 120 and R - max(G,B) > 60) for red and min(RGB) > 150 for
 * white. `scripts/lib/png.ts` decodes the frame; nothing here is eyeballed.
 *
 * THE ONE THING MEASURED AS A PAIR, AND WHY. `.hud-control.tone-urgent` had no
 * styling in `styles.css` at all — `grep 'hud-control.tone'` returned nothing —
 * so a red flag drew identically to a track-limits note. That is a defect, not
 * a styling gap, and the obvious test for it is to grep the stylesheet for the
 * selector. `probe:halo` is the standing argument against that kind of test:
 * the metric that is obviously right is usually measuring the instrument. A
 * selector can exist and resolve to the same computed value; a rule can be
 * overridden by a media query; a custom property can fail to cascade into a
 * child. So §4 raises THE SAME MESSAGE at three severities in ONE page and
 * asserts the RESOLVED colours differ — the paired-arm shape, where everything
 * but the one variable is identical by construction.
 *
 * Run: npm run probe:hudstrip
 *   HUDSTRIP_BREAK=prefix|tone|seq|ground   puts one of #15's four back
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { RaiseOpts, StripReading } from '../audit/hudstrip';
import { decodePng } from './lib/png';

const failures: string[] = [];
function check(ok: boolean, msg: string): void {
  if (!ok) failures.push(msg);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
}

const BREAK = process.env.HUDSTRIP_BREAK ?? '';

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

// ===========================================================================
// The reference, measured rather than restated
// ===========================================================================

const REF_PATH = resolve(process.cwd(), 'reference', 'target', '77.png');

/**
 * The strip's own rectangle in `77.png`, found once and then used to derive
 * everything else.
 *
 * These four numbers are the only hand-placed ones in this file, and they are
 * hand-placed the way `probe:tower` §5's panel edges are: read off a clean scan
 * line and then CHECKED, below, by re-deriving the block boundaries from the
 * pixels inside them. If the frame is ever replaced, the check fails loudly
 * rather than the probe silently measuring the sky.
 */
const STRIP = { x0: 336, x1: 863, y0: 53, y1: 137 };

interface RefMeasurement {
  /** Block edges as fractions of the strip's width, in order. */
  flagRight: number;
  badgeRight: number;
  bodyRight: number;
  /** Cap heights over the strip's height. */
  headlineCap: number;
  detailCap: number;
  /** Instruction lines counted in the frame. */
  detailLines: number;
  /** Headline lines counted in the frame. */
  headlineLines: number;
  /** The reference's red, its body ground, and its instruction white. */
  red: [number, number, number];
  ground: [number, number, number];
  ink: [number, number, number];
  /** True when the numeral in the right-hand block is darker than its ground. */
  numeralIsDark: boolean;
}

/**
 * Reads `77.png` and returns every number this probe asserts against.
 *
 * NOTHING IS HARD-CODED FROM THE PICTURE. A constant copied out of an image by
 * a person is a constant nobody can re-check, and this project has three
 * separate entries in §8 about numbers written down once and quoted for days
 * after they stopped being true. So the reference is decoded on every run and
 * the values are printed beside ours.
 */
function measureReference(): RefMeasurement {
  const r = decodePng(REF_PATH);
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * r.width + x) * 3;
    return [r.rgb[i], r.rgb[i + 1], r.rgb[i + 2]];
  };
  const W = STRIP.x1 - STRIP.x0;
  const H = STRIP.y1 - STRIP.y0;

  // The block boundaries, off a clean row above the type. "Red" is a hue test
  // rather than a luma one: the body ground and the flag device are both dark,
  // and only a hue test separates the coloured blocks from the black ones.
  const CLEAN_Y = STRIP.y0 + 7;
  const isRed = (c: [number, number, number]) => c[0] > 110 && c[0] - Math.max(c[1], c[2]) > 60;
  const runs: { red: boolean; x0: number; x1: number }[] = [];
  for (let x = STRIP.x0; x < STRIP.x1; x++) {
    const red = isRed(at(x, CLEAN_Y));
    const last = runs[runs.length - 1];
    if (last && last.red === red) last.x1 = x;
    else runs.push({ red, x0: x, x1: x });
  }
  const solid = runs.filter((s) => s.x1 - s.x0 > 8);
  if (solid.length !== 3 || !solid[0].red || solid[1].red || !solid[2].red) {
    throw new Error(
      `77.png does not scan as red|dark|red across the strip at y=${CLEAN_Y}: ` +
      JSON.stringify(solid.map((s) => `${s.red ? 'red' : 'dark'} ${s.x0}..${s.x1}`)) +
      ' — the strip rectangle in this probe no longer matches the frame');
    }
  const flagRight = (solid[0].x1 + 1 - STRIP.x0) / W;
  const bodyRight = (solid[2].x0 - STRIP.x0) / W;

  // The mark block's right edge: the darkest run inside the body, which is the
  // roundel's panel. It reads two levels darker than the message ground.
  let markEnd = solid[0].x1 + 1;
  const groundAt = (x: number) => at(x, CLEAN_Y).reduce((a, b) => a + b, 0) / 3;
  const bodyMean = groundAt(Math.round((solid[1].x0 + solid[2].x0) / 2));
  for (let x = solid[0].x1 + 3; x < solid[2].x0; x++) {
    if (groundAt(x) < bodyMean - 3) markEnd = x;
    else if (x - markEnd > 6) break;
  }
  const badgeRight = (markEnd + 1 - STRIP.x0) / W;

  // The type bands: rows carrying red ink and rows carrying white ink over the
  // message area, which give both the cap heights and the LINE COUNTS.
  const TX0 = 445;
  const TX1 = 800;
  const bands = (pick: (c: [number, number, number]) => boolean) => {
    const out: { y0: number; y1: number }[] = [];
    for (let y = STRIP.y0 + 6; y < STRIP.y1; y++) {
      let n = 0;
      for (let x = TX0; x < TX1; x++) if (pick(at(x, y))) n++;
      // A band is a run of rows with real ink in it. 20 pixels of a 355-pixel
      // scan is well above the antialiasing of a single glyph edge and well
      // below the lightest line in the frame (66).
      const on = n > 20;
      const last = out[out.length - 1];
      if (on && last && y - last.y1 <= 2) last.y1 = y;
      else if (on) out.push({ y0: y, y1: y });
    }
    return out.filter((b) => b.y1 - b.y0 >= 4);
  };
  const redBands = bands(isRed);
  const whiteBands = bands((c) => Math.min(...c) > 150);
  const capOf = (bs: { y0: number; y1: number }[]) =>
    bs.length === 0 ? 0 : bs.reduce((a, b) => a + (b.y1 - b.y0 + 1), 0) / bs.length;

  // The three colours, as the extreme of their own kind inside their own block.
  const extreme = (
    x0: number, x1: number, y0: number, y1: number,
    score: (c: [number, number, number]) => number,
  ): [number, number, number] => {
    let best: [number, number, number] = [0, 0, 0];
    let bs = -1e9;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const c = at(x, y);
        const s = score(c);
        if (s > bs) { bs = s; best = c; }
      }
    return best;
  };
  const redScore = (c: [number, number, number]) => c[0] - (c[1] + c[2]) / 2;
  const red = extreme(STRIP.x0 + 2, STRIP.x0 + 20, STRIP.y0 + 6, STRIP.y1 - 4, redScore);
  const ink = extreme(TX0, TX1, whiteBands[0]?.y0 ?? STRIP.y0, whiteBands[0]?.y1 ?? STRIP.y1,
    (c) => Math.min(...c));
  // The ground is the MODE of the message area on the clean row, not an
  // extreme: an extreme in a near-black block is the darkest antialiased pixel
  // of a glyph.
  const gs: [number, number, number][] = [];
  for (let x = markEnd + 6; x < solid[2].x0 - 2; x += 3) gs.push(at(x, CLEAN_Y));
  const ground: [number, number, number] = [0, 1, 2].map(
    (k) => Math.round(gs.reduce((a, c) => a + c[k], 0) / gs.length),
  ) as [number, number, number];

  // The numeral: is the ink in the right-hand block darker or lighter than the
  // block itself? PROJECT.md §7 and TESTING.md both recorded it as WHITE.
  const seqX0 = solid[2].x0 + 2;
  const seqX1 = STRIP.x1 - 2;
  let dark = 0;
  let light = 0;
  const blockLuma = at(seqX0 + 2, STRIP.y0 + 6).reduce((a, b) => a + b, 0) / 3;
  for (let y = STRIP.y0 + 6; y < STRIP.y1 - 4; y++)
    for (let x = seqX0; x < seqX1; x++) {
      const l = at(x, y).reduce((a, b) => a + b, 0) / 3;
      if (l < blockLuma - 40) dark++;
      if (l > blockLuma + 40) light++;
    }

  return {
    flagRight,
    badgeRight,
    bodyRight,
    headlineCap: capOf(redBands.filter((b) => b.y1 - b.y0 >= 6)) / H,
    detailCap: capOf(whiteBands) / H,
    detailLines: whiteBands.length,
    headlineLines: redBands.filter((b) => b.y1 - b.y0 >= 6).length,
    red,
    ground,
    ink,
    numeralIsDark: dark > light,
  };
}

// ===========================================================================
// Colour helpers
// ===========================================================================

function rgb(css: string): [number, number, number] | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const luma = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Chroma as max-minus-min, which is what "is this a colour or a grey" asks. */
const chroma = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);
/** Hue in degrees, or -1 for an achromatic sample. */
function hue(c: [number, number, number]): number {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return -1;
  const d = mx - mn;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
/** Smallest angle between two hues, degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
const fmt = (c: [number, number, number] | null) =>
  c ? `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : '—';

// ===========================================================================

/** The bulletin `77.png` itself is a frame of: a red flag, with instructions. */
const RED_FLAG: RaiseOpts = {
  severity: 'critical',
  text: 'RED FLAG — SESSION SUSPENDED',
  notice: {
    parties: [], where: '',
    offence: 'RED FLAG RACE SUSPENDED, CARS TO LINE UP IN PIT LANE',
    status: 'DO NOT EXCEED DELTA PACE',
  },
};

/** An ordinary incident note, which is what the game files most of. */
const INCIDENT: RaiseOpts = {
  severity: 'warning',
  text: 'Contact between HAL and OKO',
  notice: { parties: ['HAL', 'OKO'], where: 'TURN 1', offence: 'CONTACT', status: 'NOTED' },
};

/**
 * The frame shapes the strip is drawn on.
 *
 * The landscape phone is here because the noticeboard has its own width there
 * (`min(300px, 100vw - 560px)`), and the portrait phone is DELIBERATELY not:
 * `Hud.mountControl` puts the strip into the left rail on that one shape,
 * which is a documented decision and a different graphic. §5 asserts that it
 * still happens rather than pretending the strip is there.
 */
const VIEWPORTS = [
  { name: 'desktop 1400x900', w: 1400, h: 900 },
  { name: 'laptop 1280x800', w: 1280, h: 800 },
  { name: 'landscape phone 844x390', w: 844, h: 390 },
];

async function main(): Promise<void> {
  if (!existsSync(REF_PATH)) {
    console.log(`\nreference/target/77.png is not on disk (${REF_PATH}).`);
    console.log('`reference/` is gitignored, so a fresh clone has no specification to');
    console.log('measure against and this probe can only say so — it cannot pass.');
    process.exitCode = 1;
    return;
  }

  const ref = measureReference();
  console.log('\nTHE REFERENCE, decoded from reference/target/77.png this run');
  console.log(`  strip            ${STRIP.x1 - STRIP.x0} x ${STRIP.y1 - STRIP.y0}px ` +
    `at (${STRIP.x0}, ${STRIP.y0}) in a 1200x673 frame`);
  console.log(`  flag block ends  ${ref.flagRight.toFixed(3)} of the strip's width`);
  console.log(`  mark block ends  ${ref.badgeRight.toFixed(3)}`);
  console.log(`  body ends        ${ref.bodyRight.toFixed(3)}`);
  console.log(`  headline         ${ref.headlineLines} lines, ` +
    `cap ${(ref.headlineCap * 100).toFixed(1)}% of the strip's height, ${fmt(ref.red)}`);
  console.log(`  instructions     ${ref.detailLines} lines, ` +
    `cap ${(ref.detailCap * 100).toFixed(1)}%, ${fmt(ref.ink)}`);
  console.log(`  body ground      ${fmt(ref.ground)}  (luma ${luma(ref.ground).toFixed(1)})`);
  console.log(`  numeral          ${ref.numeralIsDark ? 'DARK on the block' : 'LIGHT on the block'}` +
    `  — PROJECT.md §7 and TESTING.md both recorded this as a WHITE numeral`);

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/hudstrip.html`;

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
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
  await page.waitForFunction('!!window.__strip', { timeout: 180_000 });

  // The break switches. Each one puts ONE of #15's four load-bearing faults
  // back, in the page, through a stylesheet override or a DOM edit — so the
  // assertion that catches it is proved to be able to go red without anybody
  // editing `src/`.
  if (BREAK) {
    console.log(`\nHUDSTRIP_BREAK=${BREAK} — putting one of #15's faults back`);
    await page.evaluate((mode: string) => {
      const s = document.createElement('style');
      if (mode === 'tone') {
        // The defect exactly: the tone class exists on the element and styles
        // nothing, so all three severities resolve identically.
        s.textContent = '.hud-control.tone-urgent, .hud-control.tone-warn,' +
          '.hud-control.tone-info { --strip: #c8ccd4 !important; }';
      } else if (mode === 'ground') {
        s.textContent = '.hud-control { background: #0a1738 !important; }';
      } else if (mode === 'seq') {
        s.textContent = '.control-seq { display: none !important; }';
      }
      document.head.appendChild(s);
      if (mode === 'prefix') {
        // Re-open every headline with the words the reference does not have.
        const obs = new MutationObserver(() => {
          for (const h of document.querySelectorAll('.control-headline')) {
            if (!/^RACE CONTROL:/.test(h.textContent ?? '')) {
              h.textContent = 'RACE CONTROL: ' + h.textContent;
            }
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
      }
    }, BREAK);
  }

  const raise = async (o: RaiseOpts): Promise<StripReading> => {
    await page.evaluate((arg: RaiseOpts) => window.__strip.raise(arg), o);
    return await page.evaluate(() => window.__strip.read()) as StripReading;
  };

  // =========================================================================
  // 1. THE FOUR BLOCKS, WHERE THE REFERENCE PUTS THEM
  // =========================================================================
  //
  // Scale-free: the reference's strip is 528 CSS pixels of a 1200-wide frame
  // and ours is 420 of a 1400-wide one. Pixels do not compare; the fraction of
  // the strip a block occupies does. Tolerance is +/- 0.030 of the strip's
  // width, which on our 420px strip is 12.6px — narrower than the block being
  // placed, so a block in the wrong place cannot pass.
  const TOL = 0.030;
  console.log('\n1. THE FOUR BLOCKS, AGAINST reference/target/77.png');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const r1 = await raise(RED_FLAG);
  check(r1.found, 'no `.hud-control` was drawn at all');
  if (!r1.found) { await finish(browser, server, errors); return; }
  console.log(`  strip ${r1.w.toFixed(0)} x ${r1.h.toFixed(0)}px, class "${r1.cls.trim()}"`);

  const edges: [string, number, number][] = [
    ['flag block right ', r1.flag.right, ref.flagRight],
    ['mark block right ', r1.badge.right, ref.badgeRight],
    ['message right    ', r1.body.right, ref.bodyRight],
  ];
  for (const [name, got, want] of edges) {
    console.log(`  ${name} ours ${got.toFixed(3)}  reference ${want.toFixed(3)}  ` +
      `delta ${(got - want >= 0 ? '+' : '') + (got - want).toFixed(3)}`);
    check(Math.abs(got - want) <= TOL,
      `${name.trim()} is at ${got.toFixed(3)} of the strip and the reference has it ` +
      `at ${want.toFixed(3)} (tolerance ${TOL})`);
  }
  check(r1.flag.shown, 'there is no flag block — the reference opens the strip with one');
  check(r1.badge.shown, 'there is no mark block');
  check(r1.seq.shown,
    'THERE IS NO RIGHT-HAND BLOCK. The reference ends the strip with a coloured ' +
    'block carrying the message number and §7 recorded ours as "absent"');
  check(Math.abs(r1.flag.left) <= 0.02,
    `the flag block starts at ${r1.flag.left.toFixed(3)} of the strip rather than flush ` +
    'at its left edge — the reference butts all four blocks with no inset');
  check(Math.abs(r1.seq.right - 1) <= 0.02,
    `the numeral block ends at ${r1.seq.right.toFixed(3)} rather than flush at the ` +
    "strip's right edge");

  // =========================================================================
  // 2. THE PREFIX, WHICH THE REFERENCE DOES NOT HAVE
  // =========================================================================
  console.log('\n2. THE WORDING');
  console.log(`  headline: "${r1.headline.text}"`);
  console.log(`  details:  ${JSON.stringify(r1.details.map((d) => d.text))}`);
  check(!/RACE CONTROL/i.test(r1.text),
    `the strip reads "${r1.text.slice(0, 60)}" — the reference opens on the MESSAGE ` +
    'and has no `RACE CONTROL:` prefix anywhere on it (§7, row "the prefix")');

  // ONE FACT PER LINE. The reference's own bulletin has two instructions and
  // sets them on two lines; ours has three fields (`where`, `offence`,
  // `status`) and has to set them on three. The assertion is therefore that
  // the drawn line count EQUALS the number of non-empty fields, which is what
  // "one per line" means and which a joined string can never satisfy — it is
  // always exactly one element however many facts are in it.
  const rInc = await raise(INCIDENT);
  const want = [INCIDENT.notice!.where, INCIDENT.notice!.offence, INCIDENT.notice!.status]
    .filter((s) => s.length > 0);
  console.log(`  a 3-field incident draws ${rInc.details.length} instruction line(s): ` +
    JSON.stringify(rInc.details.map((d) => d.text)));
  check(rInc.details.length === want.length,
    `an incident carrying ${want.length} facts is drawn as ${rInc.details.length} ` +
    `instruction element(s). The reference sets ${ref.detailLines} facts on ` +
    `${ref.detailLines} lines; ours joined them with ' · ' into one`);
  check(!rInc.details.some((d) => d.text.includes('·')),
    'an instruction line still carries a ` · ` separator — the reference stacks them');
  check(rInc.details.map((d) => d.text).join('|') === want.join('|'),
    `the instruction lines read ${JSON.stringify(rInc.details.map((d) => d.text))} and the ` +
    `fields are ${JSON.stringify(want)} — same facts, same order`);

  // =========================================================================
  // 3. THE COLOUR SYSTEM
  // =========================================================================
  //
  // Hue rather than luma, because `probe:halo` established at length that luma
  // is blind to hue: a red headline and a white one can sit at the same
  // luminance and a luma test would call them the same. The bound is 25
  // degrees, which separates red from yellow (60 degrees away) and from any
  // grey (which has no hue at all and is caught by the chroma floor instead).
  console.log('\n3. THE COLOUR SYSTEM');
  const refRed = ref.red;
  const HUE_TOL = 25;
  const head = rgb(r1.headline.fg);
  const flagBg = rgb(r1.flag.bg);
  const seqBg = rgb(r1.seq.bg);
  const ground = rgb(r1.ground);
  const detailFg = r1.details.length ? rgb(r1.details[0].fg) : null;
  console.log(`  reference red  ${fmt(refRed)}  hue ${hue(refRed).toFixed(0)}°  ` +
    `chroma ${chroma(refRed).toFixed(0)}`);
  for (const [name, got] of [
    ['headline    ', head], ['flag block  ', flagBg], ['numeral block', seqBg],
  ] as [string, [number, number, number] | null][]) {
    const h = got ? hue(got) : -1;
    console.log(`  ${name}  ours ${fmt(got)}  hue ${h < 0 ? 'none' : h.toFixed(0) + '°'}  ` +
      `chroma ${got ? chroma(got).toFixed(0) : '—'}`);
    check(!!got && chroma(got) > 60 && hueGap(hue(got), hue(refRed)) <= HUE_TOL,
      `${name.trim()} on a CRITICAL bulletin is ${fmt(got)} and the reference's is ` +
      `${fmt(refRed)} — a red flag has to be red (hue within ${HUE_TOL}°, chroma over 60)`);
  }
  check(!!detailFg && chroma(detailFg) < 24 && luma(detailFg) > 200,
    `the instruction lines are ${fmt(detailFg)} and the reference sets them white ` +
    `(${fmt(ref.ink)}) — they were 72% white, which is a caption`);
  console.log(`  body ground    ours ${fmt(ground)} luma ${ground ? luma(ground).toFixed(1) : '—'}` +
    `  reference ${fmt(ref.ground)} luma ${luma(ref.ground).toFixed(1)}`);
  check(!!ground && chroma(ground) <= 14 && luma(ground) < luma(ref.ground) + 14,
    `the message ground is ${fmt(ground)} and the reference's is ${fmt(ref.ground)} — ` +
    'a NEUTRAL near-black. This drew #0a1738, a navy, which is the single most ' +
    'visible error on the strip');

  // THE NUMERAL, WHICH IS NOT WHITE. Measured off the reference above rather
  // than taken from §7, which recorded it wrongly.
  const seqInk = rgb(r1.seq.fg);
  console.log(`  numeral ink    ours ${fmt(seqInk)} luma ${seqInk ? luma(seqInk).toFixed(1) : '—'}` +
    `  reference: ${ref.numeralIsDark ? 'darker' : 'lighter'} than its block`);
  check(!!seqInk && !!seqBg && (luma(seqInk) < luma(seqBg)) === ref.numeralIsDark,
    `the numeral is ${fmt(seqInk)} on a ${fmt(seqBg)} block and the reference draws it ` +
    `${ref.numeralIsDark ? 'DARK on the colour' : 'LIGHT on the colour'}`);
  check(/^\d+$/.test(r1.seq.text),
    `the right-hand block reads "${r1.seq.text}" and the reference puts a numeral in it`);

  // =========================================================================
  // 4. THE SEVERITY, AS A PAIRED ARM — the one real defect on §7's list
  // =========================================================================
  //
  // Three bulletins with IDENTICAL text, in ONE page, at one viewport,
  // differing only in `severity`. Everything the resolved colour depends on —
  // the stylesheet, the cascade, the viewport, the media query, the custom
  // property chain — is the same between the arms by construction, so what is
  // left is the tone. On a build carrying #15 all three resolve to the same
  // string and this section is 0 for 3.
  console.log('\n4. THE SEVERITY, PAIRED — the same message at three severities');
  const tones: { sev: RaiseOpts['severity']; want: string }[] = [
    { sev: 'critical', want: 'urgent' },
    { sev: 'warning', want: 'warn' },
    { sev: 'info', want: 'info' },
  ];
  const seen: { sev: string; cls: string; head: string; flag: string }[] = [];
  for (const t of tones) {
    const rr = await raise({
      severity: t.sev,
      text: 'TRACK LIMITS AT TURN 4',
      notice: { parties: [], where: '', offence: 'TRACK LIMITS AT TURN 4', status: 'NOTED' },
    });
    console.log(`  ${t.sev.padEnd(9)} class "${rr.cls.trim()}"  headline ${rr.headline.fg}  ` +
      `flag block ${rr.flag.bg}`);
    check(rr.cls.includes('tone-' + t.want),
      `a ${t.sev} bulletin carries class "${rr.cls.trim()}" and not tone-${t.want}`);
    seen.push({ sev: t.sev, cls: rr.cls, head: rr.headline.fg, flag: rr.flag.bg });
  }
  const urgent = seen[0];
  for (const other of seen.slice(1)) {
    check(urgent.head !== other.head,
      `a CRITICAL bulletin's headline resolves to ${urgent.head} and a ${other.sev} one to ` +
      `${other.head} — THE SAME COLOUR. This is #15's fourth row: the tone classes are ` +
      'set on the element and styled nowhere, so a red flag draws identically to a note');
    check(urgent.flag !== other.flag,
      `a CRITICAL bulletin's flag block resolves to ${urgent.flag} and a ${other.sev} one ` +
      `to ${other.flag} — the same colour`);
  }
  // And the direction, not merely the difference: urgent must be the reference's
  // red, and a bulletin that is only information must not be.
  const uh = rgb(urgent.head);
  const ih = rgb(seen[2].head);
  check(!!uh && hueGap(hue(uh), hue(refRed)) <= HUE_TOL,
    `the urgent tone is ${fmt(uh)}, not the reference's red`);
  check(!!ih && chroma(ih) < 40,
    `an INFORMATION bulletin draws its headline in ${fmt(ih)} — a coloured headline on a ` +
    'note spends the one signal the strip has');

  // =========================================================================
  // 5. THE TYPE, AND THE SHAPE, ON EVERY FRAME THE STRIP IS DRAWN ON
  // =========================================================================
  console.log('\n5. THE TYPE AND THE BLOCKS, ON EVERY FRAME SHAPE');
  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
    const rr = await raise(RED_FLAG);
    if (!rr.found) { check(false, `${vp.name}: no strip was drawn`); continue; }
    const ratio = rr.details.length ? rr.details[0].sizePx / rr.headline.sizePx : 0;
    console.log(`  ${vp.name}: strip ${rr.w.toFixed(0)}x${rr.h.toFixed(0)}  ` +
      `headline ${rr.headline.sizePx}px  detail ${rr.details[0]?.sizePx ?? 0}px  ` +
      `ratio ${ratio.toFixed(2)}  blocks ` +
      `${rr.flag.right.toFixed(3)}/${rr.badge.right.toFixed(3)}/${rr.body.right.toFixed(3)}`);
    // The size relationship, which is what makes the reference's instructions
    // read as instructions rather than as a footnote: cap 11 against 12.5.
    const REF_RATIO = ref.detailCap / ref.headlineCap;
    check(ratio > REF_RATIO - 0.14 && ratio < REF_RATIO + 0.14,
      `${vp.name}: the instruction type is ${ratio.toFixed(2)} of the headline and the ` +
      `reference has it at ${REF_RATIO.toFixed(2)} (11px of cap against 12.5)`);
    for (const [name, got, want] of [
      ['flag', rr.flag.right, ref.flagRight],
      ['mark', rr.badge.right, ref.badgeRight],
      ['body', rr.body.right, ref.bodyRight],
    ] as [string, number, number][]) {
      check(Math.abs(got - want) <= TOL,
        `${vp.name}: the ${name} block ends at ${got.toFixed(3)} against the reference's ` +
        `${want.toFixed(3)}`);
    }
    check(rr.seq.shown && rr.flag.shown && rr.badge.shown,
      `${vp.name}: a block is missing (flag ${rr.flag.shown}, mark ${rr.badge.shown}, ` +
      `numeral ${rr.seq.shown})`);
  }

  // THE PORTRAIT PHONE, WHICH IS A DIFFERENT GRAPHIC AND SAYS SO.
  // `Hud.mountControl` puts the bulletin into the left rail on a narrow
  // portrait frame — a documented decision, because there is a 38-pixel gutter
  // at the top of that shape and no top centre to put a banner in. Asserted so
  // that a change which quietly stopped it happening shows up here rather than
  // as a bulletin drawn off the side of a phone.
  console.log('\n5b. THE PORTRAIT PHONE — the rail, deliberately');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const rp = await raise(INCIDENT);
  const inRail = await page.evaluate(
    () => !!document.querySelector('.hud-alerts .hud-control'));
  console.log(`  strip present ${rp.found}, in the rail ${inRail}`);
  check(rp.found && inRail,
    'on a portrait phone the bulletin is not in the left rail — `Hud.mountControl` puts ' +
    'it there deliberately, because that frame has no top centre');

  // =========================================================================
  // 6. THE SEQUENCE NUMBER COUNTS
  // =========================================================================
  console.log('\n6. THE MESSAGE NUMBER');
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const a = await raise(INCIDENT);
  const b = await raise(INCIDENT);
  console.log(`  consecutive bulletins numbered "${a.seq.text}" then "${b.seq.text}"`);
  check(/^\d+$/.test(a.seq.text) && /^\d+$/.test(b.seq.text) &&
    Number(b.seq.text) === Number(a.seq.text) + 1,
    `two consecutive bulletins are numbered "${a.seq.text}" and "${b.seq.text}" — the ` +
    "reference's numeral is the message's place in the session's run of them");

  await finish(browser, server, errors);
}

async function finish(
  browser: Browser, server: ViteDevServer, errors: string[],
): Promise<void> {
  for (const e of errors) check(false, e);
  await browser.close();
  await server.close();
  console.log('');
  if (failures.length === 0) {
    console.log('PASS — the race-control strip matches reference/target/77.png ' +
      'element by element, and its severity draws.');
  } else {
    console.log(`${failures.length} failed:`);
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
