import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs every circuit, from every angle, through the game's own renderer.
 *
 * WHY THIS EXISTS
 *
 * Three separate rendering complaints — scenery standing on the racing surface,
 * black lines and grain across the asphalt, a camera mode that ends up inside
 * geometry — were each investigated on one circuit, fixed there, and closed.
 * There are eleven circuits and they are not interchangeable: they differ in
 * `scenery` type (which picks the ground colour and the surface profile), in
 * `ambience` (which sets the exposure and the light rig), in elevation, in
 * banking, in width, and in whether they are walled streets or open parkland.
 * A fix verified on Bahrain is a fix verified on a flat, wide, unbanked desert
 * circuit at night, and says nothing about Spa in daylight through a forest.
 *
 * So this sweeps all eleven and captures, for each:
 *
 *   - a whole-circuit overview, to see the layout and anything standing in it
 *   - four overhead plan views around the lap, which is the view that makes a
 *     grandstand on the road unmistakable
 *   - six eye-level views on the racing line, which is the view the surface
 *     complaints are actually about
 *   - all seven camera modes, to catch a camera inside geometry or underground
 *
 * Everything is driven through `Renderer`, `RaceEngine` and the real
 * `WorldModel`. A bespoke viewer would prove nothing about the game.
 *
 * Output lands in `audit-out/` as full-size PNGs plus one contact sheet per
 * circuit and a browsable index.
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

/**
 * `AUDIT_ONLY=spa,monza` narrows the sweep while iterating on a fix.
 *
 * The default is, and stays, all eleven. Narrowing is for the minute after a
 * change; the sweep that decides whether something is fixed is the full one.
 */
const CIRCUIT_IDS = process.env.AUDIT_ONLY
  ? process.env.AUDIT_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

/** Fractions of the lap the plan views are taken at. */
const PLAN_FRACTIONS = [0.0, 0.25, 0.5, 0.75];
/** Fractions of the lap the eye-level views are taken at. */
const EYE_FRACTIONS = [0.0, 0.17, 0.34, 0.5, 0.67, 0.84];
/** Height above the road for a plan view, metres. */
const PLAN_HEIGHT_M = 130;

const OUT_DIR = resolve(process.cwd(), 'audit-out');

/** Where a stock Chrome lives. No browser is downloaded for this. */
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

interface CircuitInfo {
  id: string;
  name: string;
  scenery: string;
  ambience: string;
  lengthM: number;
  sceneryCount: number;
  obstacleCount: number;
}

interface Shot {
  label: string;
  file: string;
}

/** One circuit's entry in the sweep report. */
interface CircuitReport {
  info: CircuitInfo;
  shots: Shot[];
  errors: string[];
}

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

async function main(): Promise<void> {
  // Only the circuits about to be swept are cleared.
  //
  // `AUDIT_ONLY` exists so a fix can be checked on one circuit without waiting
  // for eleven, and wiping the whole directory made it useless for that: it
  // destroyed the eleven-circuit grid the one circuit was meant to be compared
  // against, which costs an hour to get back and is discovered immediately
  // afterwards. Everything not being re-shot is carried through untouched —
  // index included — so a sweep can also be finished in pieces when the
  // machine is too busy to do it in one go.
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of CIRCUIT_IDS) {
    await rm(resolve(OUT_DIR, id), { recursive: true, force: true });
  }

  const server: ViteDevServer = await createServer({
    // Hot reloading and file watching are off, and that is not a performance
    // tweak. A sweep takes long enough that it will normally be running while
    // someone is editing the thing it is photographing, and an HMR update
    // replaces `window.__audit` underneath an in-flight call — so the sweep does
    // not fail, it simply stops, forever, part way through a circuit. It did
    // exactly that twice before the cause was obvious.
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/index.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    // The CDP call timeout, which is NOT what `page.setDefaultTimeout` below
    // sets — that one governs `waitFor*`, and an `evaluate` is neither. The
    // default is three minutes, and a single camera shot on a busy machine
    // exceeds it: software rendering is CPU-bound, so anything else running on
    // the box slows a shot in proportion. What that looked like was the sweep
    // dying part way through Monaco with a `Runtime.callFunctionOn timed out`,
    // having thrown away the eight circuits it had not reached yet.
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new',
      '--no-sandbox',
      '--hide-scrollbars',
      // Software GL. Slower than the host GPU and worth it: the audit has to
      // produce the same picture on every machine that runs it, and a driver
      // difference in the middle of a rendering investigation is a whole day
      // of chasing something that was never there.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // Software rendering makes a full circuit build genuinely slow, and a silent
  // hang here is indistinguishable from a slow circuit. Generous, but finite.
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__audit', { timeout: 120_000 });

  const modes: string[] = await page.evaluate('window.__audit.cameraModes.slice()') as string[];

  const report: CircuitReport[] = [];

  for (const id of CIRCUIT_IDS) {
    const before = errors.length;
    process.stdout.write(`${id.padEnd(13)}`);
    const dir = resolve(OUT_DIR, id);
    await mkdir(dir, { recursive: true });

    const info = await page.evaluate(
      (c: string) => (window as never as { __audit: { load(c: string): Promise<CircuitInfo> } }).__audit.load(c),
      id,
    ) as CircuitInfo;

    const shots: Shot[] = [];

    // The full-size PNG goes straight to disk and is never handed back into the
    // page; the page keeps its own downscaled thumbnail for the contact sheet.
    // Shipping eighteen 1280x720 base64 PNGs back across the CDP boundary and
    // then in again to be composited is about 25MB a circuit, and it wedged the
    // browser on the fourth one.
    const take = async (label: string, data: string): Promise<void> => {
      const file = `${id}/${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      await writePng(resolve(OUT_DIR, file), data);
      shots.push({ label, file });
      await page.evaluate(
        (t: string) => (window as never as { __audit: { label(t: string): void } }).__audit.label(t),
        label,
      );
    };

    await take('overview', await page.evaluate('window.__audit.shootOverview()') as string);
    for (const f of PLAN_FRACTIONS) {
      const d = await page.evaluate(
        (a: [number, number]) => (window as never as { __audit: { shootPlan(f: number, h: number): Promise<string> } })
          .__audit.shootPlan(a[0], a[1]),
        [f, PLAN_HEIGHT_M] as [number, number],
      ) as string;
      await take(`plan ${Math.round(f * 100)}%`, d);
    }
    for (const f of EYE_FRACTIONS) {
      const d = await page.evaluate(
        (a: number) => (window as never as { __audit: { shootEye(f: number): Promise<string> } }).__audit.shootEye(a),
        f,
      ) as string;
      await take(`eye ${Math.round(f * 100)}%`, d);
    }
    for (const m of modes) {
      const d = await page.evaluate(
        (a: string) => (window as never as { __audit: { shootMode(m: string): Promise<string> } }).__audit.shootMode(a),
        m,
      ) as string;
      await take(`cam ${m}`, d);
    }

    const sheetData = await page.evaluate('window.__audit.contact(6)') as string;
    await writePng(resolve(OUT_DIR, `${id}/_contact.jpg`), sheetData);

    const mine = errors.slice(before);
    report.push({ info, shots, errors: mine });
    process.stdout.write(
      `${info.scenery.padEnd(10)} ${info.ambience.padEnd(6)} ` +
      `${(info.lengthM / 1000).toFixed(2)}km  scenery=${String(info.sceneryCount).padStart(4)} ` +
      `solid=${String(info.obstacleCount).padStart(5)}  shots=${shots.length}` +
      (mine.length ? `  ERRORS=${mine.length}` : '') + '\n',
    );
  }

  // Merged with whatever a previous sweep left, so a one-circuit run updates
  // the grid instead of replacing it with a grid of one.
  const merged = mergeReport(report);
  await writeFile(resolve(OUT_DIR, 'index.html'), indexPage(merged), 'utf8');
  await writeFile(resolve(OUT_DIR, 'report.json'), JSON.stringify(merged, null, 2), 'utf8');

  await browser.close();
  await server.close();

  console.log(`\nwrote ${OUT_DIR}/index.html`);
  const bad = report.filter((r) => r.errors.length > 0);
  if (bad.length > 0) {
    console.log('\nPAGE ERRORS:');
    for (const r of bad) for (const e of r.errors) console.log(`  ${r.info.id}: ${e}`);
    process.exitCode = 1;
  }
}

/**
 * Folds this run's circuits into the last run's report, in calendar order.
 *
 * Anything swept now wins; anything not swept is carried through untouched, so
 * the index keeps showing the circuits whose PNGs are still on disk.
 */
function mergeReport(fresh: CircuitReport[]): CircuitReport[] {
  let prior: CircuitReport[] = [];
  try {
    prior = JSON.parse(readFileSync(resolve(OUT_DIR, 'report.json'), 'utf8')) as CircuitReport[];
  } catch {
    // No previous sweep, or an unreadable one. Either way, this run is the report.
  }
  const byId = new Map<string, CircuitReport>();
  for (const r of prior) byId.set(r.info.id, r);
  for (const r of fresh) byId.set(r.info.id, r);
  return ALL_CIRCUITS.map((id) => byId.get(id)).filter((r): r is CircuitReport => !!r);
}

function indexPage(
  report: CircuitReport[],
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sections = report.map((r) => `
  <section id="${esc(r.info.id)}">
    <h2>${esc(r.info.name)} <small>${esc(r.info.id)} · ${esc(r.info.scenery)} · ${esc(r.info.ambience)}
      · ${(r.info.lengthM / 1000).toFixed(2)}km · ${r.info.sceneryCount} scenery · ${r.info.obstacleCount} solid</small></h2>
    ${r.errors.length ? `<p class="err">${r.errors.map(esc).join('<br>')}</p>` : ''}
    <p><a href="${esc(r.info.id)}/_contact.jpg">contact sheet</a></p>
    <div class="grid">
      ${r.shots.map((s) => `<figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}" alt="${esc(s.label)}"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('\n      ')}
    </div>
  </section>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>circuit render audit</title>
<style>
 body{background:#0d0f12;color:#dfe3e8;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:20px} h2{font-size:16px;margin:32px 0 4px;border-bottom:1px solid #2a2f36;padding-bottom:6px}
 small{color:#8b939d;font-weight:400}
 nav a{color:#7fc4ff;margin-right:12px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
 figure{margin:0} img{width:100%;display:block;border:1px solid #2a2f36;background:#000}
 figcaption{color:#9aa3ad;font:12px ui-monospace,monospace;padding:3px 0}
 .err{color:#ff8f8f;font:12px ui-monospace,monospace}
 a{color:#7fc4ff}
</style></head><body>
<h1>circuit render audit</h1>
<nav>${report.map((r) => `<a href="#${esc(r.info.id)}">${esc(r.info.id)}</a>`).join('')}</nav>
${sections}
</body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
