/**
 * Photographs a pit stop, on the real renderer, from five stations and through
 * the whole choreography.
 *
 * `npm run audit:circuits` has never once looked at the pit lane. Every shot it
 * takes is of a car on the racing line, and the pit lane is behind a wall on
 * the other side of the circuit — which is how a hundred and ten crew members
 * came to be standing in fixed working poses at ten empty garages for the whole
 * of every race without anybody noticing.
 *
 * This drives the game's own engine and renderer, puts the PLAYER's car in its
 * own box, and walks the stop: the crew set and waiting, the jacks lifting, the
 * wheels off, the wheels on, the car dropping, the light going green. Five
 * camera stations at each moment, including one from up the lane — because
 * "I also dont really know where my pit is" is a question about a picture taken
 * from sixty metres back, not from on top of the box.
 *
 * Run:  npm run audit:pitlane
 *       AUDIT_ONLY=monaco npm run audit:pitlane
 *
 * Output: audit-out/pitlane/<circuit>/*.png and an index.html.
 */

import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Circuits swept. A pit lane is a per-circuit object: its length, its width */
/** and how much of it fits between the entry and the exit all differ. */
const ALL = ['bahrain', 'monaco', 'monza', 'spa', 'suzuka'];
const ONLY = process.env.AUDIT_ONLY;
const CIRCUITS = ONLY ? ONLY.split(',').map((s) => s.trim()) : ALL;

/**
 * Moments in the stop, as seconds after the car came to rest.
 *
 * Chosen to land on the things that have to be true rather than at even
 * intervals: the crew set before anything moves, the jacks up, the middle of
 * the wheel change, and the release. `-1` is the special case — the crew
 * waiting at an empty box while the car is still coming down the lane, which is
 * what every reference photograph of a pit stop is actually of.
 */
const MOMENTS: { label: string; atS: number }[] = [
  { label: 'set', atS: 0.02 },
  { label: 'jacked', atS: 0.30 },
  { label: 'wheels off', atS: 0.95 },
  { label: 'wheels on', atS: 1.55 },
  { label: 'released', atS: 3.2 },
];

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'pitlane');

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

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

interface Shot { label: string; file: string }

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of CIRCUITS) await rm(resolve(OUT_DIR, id), { recursive: true, force: true });

  const server: ViteDevServer = await createServer({
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
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars',
      // Software GL, so the picture is the same on every machine that runs it.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__audit', { timeout: 120_000 });

  const views = await page.evaluate('window.__audit.pit.views.slice()') as string[];
  const report: { id: string; shots: Shot[]; stationaryS: number; errors: string[] }[] = [];

  for (const id of CIRCUITS) {
    const before = errors.length;
    process.stdout.write(id.padEnd(13));
    const dir = resolve(OUT_DIR, id);
    await mkdir(dir, { recursive: true });
    const shots: Shot[] = [];

    const info = await page.evaluate(
      (c: string) => (window as never as {
        __audit: { pit: { setup(c: string): Promise<{ stationaryS: number; crew: number; reachedBox: boolean }> } };
      }).__audit.pit.setup(c),
      id,
    ) as { stationaryS: number; crew: number; reachedBox: boolean };

    if (!info.reachedBox) {
      process.stdout.write('  NEVER REACHED ITS BOX\n');
      report.push({ id, shots, stationaryS: 0, errors: ['car never reached its pit box'] });
      continue;
    }

    const take = async (label: string, data: string): Promise<void> => {
      const file = `${id}/${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      await writePng(resolve(OUT_DIR, file), data);
      shots.push({ label, file });
    };

    let at = 0;
    for (const moment of MOMENTS) {
      const step = Math.max(0, moment.atS - at);
      at = await page.evaluate(
        (s: number) => (window as never as {
          __audit: { pit: { advance(s: number): Promise<number> } };
        }).__audit.pit.advance(s),
        step,
      ) as number;
      for (const v of views) {
        const d = await page.evaluate(
          (a: string) => (window as never as {
            __audit: { pit: { shoot(v: string): Promise<string> } };
          }).__audit.pit.shoot(a),
          v,
        ) as string;
        await take(`${moment.label} ${v}`, d);
      }
    }

    const mine = errors.slice(before);
    report.push({ id, shots, stationaryS: info.stationaryS, errors: mine });
    process.stdout.write(
      `crew=${info.crew}  stationary=${info.stationaryS.toFixed(2)}s  shots=${shots.length}` +
      (mine.length ? `  ERRORS=${mine.length}` : '') + '\n',
    );
  }

  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

  const html = `<!doctype html><meta charset="utf-8"><title>Pit lane sweep</title>
<style>
  body { background:#101216; color:#e8ebef; font:14px/1.5 -apple-system,Segoe UI,sans-serif; margin:24px; }
  h2 { margin:32px 0 4px; font-size:20px; }
  .meta { color:#8d959f; margin-bottom:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; }
  figure { margin:0; }
  img { width:100%; display:block; border-radius:4px; background:#000; }
  figcaption { color:#aeb6c0; font-size:12px; padding-top:4px; }
  .err { color:#ff8a70; }
</style>
<h1>Pit lane</h1>
${report.map((r) => `<h2>${esc(r.id)}</h2>
<div class="meta">stationary ${r.stationaryS.toFixed(2)}s${r.errors.length ? ` &middot; <span class="err">${r.errors.length} error(s)</span>` : ''}</div>
${r.errors.map((e) => `<div class="err">${esc(e)}</div>`).join('')}
<div class="grid">
  ${r.shots.map((s) => `<figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}" alt="${esc(s.label)}"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('\n  ')}
</div>`).join('\n')}`;
  await writeFile(resolve(OUT_DIR, 'index.html'), html);

  await browser.close();
  await server.close();

  console.log(`\nwrote ${resolve(OUT_DIR, 'index.html')}`);
  const bad = report.filter((r) => r.errors.length > 0);
  if (bad.length > 0) {
    console.log(`${bad.length} circuit(s) reported errors:`);
    for (const r of bad) for (const e of r.errors) console.log(`  ${r.id}: ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
