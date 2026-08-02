import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';
import { buildWorldModel } from '../src/track/WorldObstacles';
import { computeShoulders, STREET_RUNOFF_W, RUNOFF_W } from '../src/render/TrackMesh';

/**
 * Photographs the GROUND BESIDE THE ROAD on every circuit, at the two places
 * where a fault in it would show worst.
 *
 * `audit:corners` covers this too, and it is the right place for it — but it
 * also drives an accident, photographs the debris, and takes eight views per
 * corner, and under software GL a survey shot with the whole circuit in frame
 * costs minutes. A before-and-after of one specific defect across eleven
 * circuits needs to run twice, and twice five hours is not a proposition.
 *
 * So this takes four frames per circuit and nothing else:
 *
 *   TIGHTEST CORNER, which is the situation in the screenshots — the outside of
 *   a slow corner, where the barrier stands furthest back and there is most
 *   ground beside the road to look at.
 *
 *   HIGHEST POINT of the lap with room beside it, which is where the drop from
 *   the racing surface to the world beyond it was largest.
 *
 * Both stations are chosen in Node from the track data alone — curvature,
 * elevation and `computeShoulders`, none of which this change touches — so the
 * same two cameras are used before and after and the pictures can be laid side
 * by side.
 *
 * Run: OUT=before npm run audit:shoulders
 */

const OUT_TAG = process.env.OUT ?? 'shoulders';
const CIRCUIT_IDS = process.env.AUDIT_ONLY
  ? process.env.AUDIT_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : CIRCUITS.map((c) => c.id);

const OUT_DIR = resolve(process.cwd(), 'audit-out', OUT_TAG);

interface Api {
  __audit: {
    load(c: string): Promise<unknown>;
    shootShoulder(f: number, side: -1 | 1): Promise<string>;
    shootAcross(f: number, side: -1 | 1): Promise<string>;
  };
}

interface Station { name: string; fraction: number; side: -1 | 1; note: string }

/** The two places on a circuit this is interested in. */
function stations(id: string): Station[] {
  const def = CIRCUITS.find((c) => c.id === id)!;
  const track = new TrackSpline(def);
  const world = buildWorldModel(track);
  const runoffW = def.scenery === 'street' ? STREET_RUNOFF_W : RUNOFF_W;
  const sh = computeShoulders(track, world, runoffW);

  // Outside of the corner: positive curvature is a right turn, whose outside is
  // the track's left, which is positive lateral.
  const outside = (i: number): -1 | 1 => (track.curvature[i] > 0 ? 1 : -1);
  const room = (i: number, side: -1 | 1) => (side > 0 ? sh.left : sh.right)[i];

  // Only where there is genuinely ground beside the road to photograph: a
  // station whose shoulder has been cut back to nothing shows a barrier and no
  // ground at all. Measured against THIS circuit's own run-off width, because a
  // street circuit's shoulder is a couple of metres by design — a flat 10m bar
  // excluded every node of Monaco and Jeddah and silently fell back to node 0,
  // which is the start/finish line and not a corner.
  const enough = Math.min(10, runoffW);

  let tight = -1;
  let tightR = Infinity;
  let high = -1;
  let highY = -Infinity;
  for (let i = 0; i < track.count; i++) {
    const k = Math.abs(track.curvature[i]);
    const r = k > 0 ? 1 / k : Infinity;
    const side = outside(i);
    if (room(i, side) < enough) continue;
    if (r < tightR) { tightR = r; tight = i; }
    if (track.elevation[i] > highY) { highY = track.elevation[i]; high = i; }
  }
  if (tight < 0) { tight = 0; tightR = Infinity; }
  if (high < 0) { high = 0; highY = track.elevation[0]; }

  return [
    {
      name: 'tightest',
      fraction: track.dist[tight] / track.length,
      side: outside(tight),
      note: `R${tightR.toFixed(0)}m at s=${track.dist[tight].toFixed(0)}m, `
        + `elev ${track.elevation[tight].toFixed(1)}m, `
        + `shoulder ${room(tight, outside(tight)).toFixed(1)}m`,
    },
    {
      name: 'highest',
      fraction: track.dist[high] / track.length,
      side: outside(high),
      note: `elev ${highY.toFixed(1)}m at s=${track.dist[high].toFixed(0)}m, `
        + `shoulder ${room(high, outside(high)).toFixed(1)}m`,
    },
  ];
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

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

async function main(): Promise<void> {
  // Only this run's own circuits are cleared, so an `AUDIT_ONLY` re-run of the
  // one that fell over does not throw away the ten that worked. Eleven circuits
  // is two hours of software rendering.
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of CIRCUIT_IDS) {
    for (const f of await readdir(OUT_DIR)) {
      if (f.startsWith(`${id}-`)) await rm(resolve(OUT_DIR, f), { force: true });
    }
  }

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
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const errors: string[] = [];
  /** Caption per file, for the shots this run took. */
  const captions = new Map<string, string>();

  // A fresh page per circuit: software-rendered WebGL loses its context after
  // enough work in one, and when it does the canvas comes back uniformly white
  // and is written to disk as evidence.
  for (const id of CIRCUIT_IDS) {
    process.stdout.write(`${id.padEnd(13)}`);
    const page: Page = await browser.newPage();
    // Brought to front, and NOT by closing the other tabs. Chrome throttles a
    // background tab's frame callbacks to a standstill, and the first attempt
    // at guaranteeing this page was not one closed every other target —
    // including the browser's own initial about:blank. Chrome exits when its
    // last target goes, so the browser quietly died after the ninth circuit and
    // the tenth came back "Failed to open a new tab". The throttle is handled
    // where it belongs, in `present()`, which now races a timer.
    await page.bringToFront();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(20 * 60_000);
    page.on('pageerror', (e) => errors.push(`${id} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) {
        errors.push(`${id} console: ${m.text()}`);
      }
    });
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 300_000 });
      await page.waitForFunction('!!window.__audit', { timeout: 300_000 });
      await page.evaluate((c: string) => (window as never as Api).__audit.load(c), id);

      const shots: { label: string; file: string }[] = [];
      for (const st of stations(id)) {
        const arg = [st.fraction, st.side] as [number, -1 | 1];
        for (const view of ['shootShoulder', 'shootAcross'] as const) {
          const data = await page.evaluate(
            (a: [number, -1 | 1, 'shootShoulder' | 'shootAcross']) =>
              (window as never as Api).__audit[a[2]](a[0], a[1]),
            [...arg, view] as [number, -1 | 1, typeof view],
          ) as string;
          const file = `${id}-${st.name}-${view === 'shootShoulder' ? 'survey' : 'close'}.png`;
          await writePng(resolve(OUT_DIR, file), data);
          shots.push({ label: `${st.name} ${view === 'shootShoulder' ? 'survey' : 'close'} — ${st.note}`, file });
          process.stdout.write('.');
        }
      }
      for (const s of shots) captions.set(s.file, s.label);
      process.stdout.write(' ok\n');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${id}: ${msg}`);
      process.stdout.write(` FAILED: ${msg.split('\n')[0]}\n`);
    }
    await page.close().catch(() => { /* context already gone */ });
  }

  // The index is built from what is ON DISK rather than from what this run
  // took, so re-shooting one circuit after a browser crash still produces a
  // page with all eleven on it.
  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.png')).sort();
  const byCircuit = new Map<string, string[]>();
  for (const f of files) {
    const id = f.slice(0, f.indexOf('-'));
    const list = byCircuit.get(id);
    if (list) list.push(f); else byCircuit.set(id, [f]);
  }
  const sections = [...byCircuit].map(([id, list]) =>
    `<section><h2>${id}</h2><div class="grid">${list.map(
      (f) => `<figure><a href="${f}"><img loading="lazy" src="${f}"></a>`
        + `<figcaption>${captions.get(f) ?? f.replace(/\.png$/, '')}</figcaption></figure>`,
    ).join('')}</div></section>`);

  await writeFile(resolve(OUT_DIR, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ground beside the road — ${OUT_TAG}</title><style>
 body{background:#0d0f12;color:#dfe3e8;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h2{font-size:16px;margin:32px 0 4px;border-bottom:1px solid #2a2f36}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:10px}
 figure{margin:0} img{width:100%;display:block;border:1px solid #2a2f36}
 figcaption{color:#9aa3ad;font:12px ui-monospace,monospace}
 a{color:#7fc4ff}</style></head><body><h1>ground beside the road — ${OUT_TAG}</h1>
${sections.join('\n')}</body></html>`, 'utf8');

  await browser.close();
  await server.close();
  console.log(`\nwrote ${OUT_DIR}/index.html`);
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
