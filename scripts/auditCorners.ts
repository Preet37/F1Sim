import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs CORNERS, and photographs debris, on every circuit.
 *
 * `audit:circuits` shoots six eye-level views at fixed fractions of the lap.
 * That is the right sampling for "is there scenery standing on the road", and
 * the wrong one for two questions that are both about a specific place:
 *
 *   - what a KERB looks like, which needs a camera near it rather than a
 *     hundred metres up the road from it at driver eye height, and which needs
 *     to be pointed at an actual apex rather than at whatever piece of road
 *     lands on 17% of the lap;
 *   - what DEBRIS looks like once it is on the road, which needs there to be
 *     some, which means the accident has to be caused rather than waited for.
 *
 * So this picks the tightest corners on each circuit off the curvature, stands
 * at them, and also drops a debris field and looks down at it. Same page, same
 * renderer, same engine as the main sweep.
 *
 * Output lands in `audit-out/corners/`.
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

const CIRCUIT_IDS = process.env.AUDIT_ONLY
  ? process.env.AUDIT_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

/** How many corners per circuit get the full treatment. */
const CORNERS = Number(process.env.AUDIT_CORNERS ?? 2);

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'corners');

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

interface CornerInfo { fraction: number; radiusM: number; side: -1 | 1 }
interface TrackStats {
  kerbLeft: number; kerbRight: number; kerbEither: number;
  under400: number; under250: number; under120: number;
  halfWidthM: number; debris: number; drawCalls: number; triangles: number;
}

/** The page's own API, as this side needs to see it. */
interface Api {
  __audit: {
    load(c: string): Promise<unknown>;
    corners(n: number): CornerInfo[];
    shootEye(f: number): Promise<string>;
    shootEyeAids(f: number): Promise<string>;
    shootKerb(f: number, side: -1 | 1): Promise<string>;
    shootDebris(f: number, h: number): Promise<string>;
    focusFraction(): number;
  };
}

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  for (const id of CIRCUIT_IDS) await rm(resolve(OUT_DIR, id), { recursive: true, force: true });

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

  /**
   * A fresh page per circuit.
   *
   * Not tidiness. Software-rendered WebGL under swiftshader loses its context
   * somewhere around the third circuit in one page: the canvas comes back
   * uniformly white, `toDataURL` returns a 20KB blank PNG, and the next
   * `evaluate` never resolves — so the sweep does not fail, it stops, having
   * silently written a blank frame as evidence. A page per circuit costs one
   * reload and removes the failure mode entirely.
   */
  const openPage = async (): Promise<Page> => {
    const p2: Page = await browser.newPage();
    // Brought to front, and it is not cosmetic: `present()` in the page waits on
    // `requestAnimationFrame`, and Chrome throttles rAF in a BACKGROUND tab to
    // the point of never firing. A new tab that opens behind the browser's own
    // initial about:blank therefore hangs in `load()` forever, having written
    // nothing — which looks exactly like a slow circuit.
    await p2.bringToFront();
    await p2.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    p2.setDefaultTimeout(240_000);
    p2.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await p2.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await p2.waitForFunction('!!window.__audit', { timeout: 120_000 });
    return p2;
  };

  const rows: string[] = [];
  const sections: string[] = [];

  for (const id of CIRCUIT_IDS) {
    process.stdout.write(`${id.padEnd(13)}`);
    const page = await openPage();
    const dir = resolve(OUT_DIR, id);
    await mkdir(dir, { recursive: true });

    await page.evaluate(
      (c: string) => (window as never as Api).__audit.load(c), id);
    const stats = await page.evaluate('window.__audit.measure()') as TrackStats;
    const corners = await page.evaluate(
      (n: number) => (window as never as Api).__audit.corners(n), CORNERS,
    ) as CornerInfo[];

    const shots: { label: string; file: string }[] = [];
    const take = async (label: string, data: string): Promise<void> => {
      const file = `${id}/${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      await writePng(resolve(OUT_DIR, file), data);
      shots.push({ label, file });
    };

    for (let c = 0; c < corners.length; c++) {
      const k = corners[c];
      const tag = `c${c}-r${Math.round(k.radiusM)}m`;
      await take(`${tag} eye`, await page.evaluate(
        (f: number) => (window as never as Api).__audit.shootEye(f), k.fraction) as string);
      await take(`${tag} eye+aids`, await page.evaluate(
        (f: number) => (window as never as Api).__audit.shootEyeAids(f), k.fraction) as string);
      await take(`${tag} kerb in`, await page.evaluate(
        (a: [number, -1 | 1]) => (window as never as Api).__audit.shootKerb(a[0], a[1]),
        [k.fraction, k.side] as [number, -1 | 1]) as string);
      await take(`${tag} kerb out`, await page.evaluate(
        (a: [number, -1 | 1]) => (window as never as Api).__audit.shootKerb(a[0], a[1]),
        [k.fraction, -k.side as -1 | 1] as [number, -1 | 1]) as string);
    }

    // Debris. Six impacts, which is what the reported race had in two laps.
    await page.evaluate('window.__audit.crash(6, 0.7)');
    const after = await page.evaluate('window.__audit.measure()') as TrackStats;
    const f0 = await page.evaluate('window.__audit.focusFraction()') as number;
    await take('debris plan 22m', await page.evaluate(
      (f: number) => (window as never as Api).__audit.shootDebris(f, 22), f0) as string);
    await take('debris eye', await page.evaluate(
      (f: number) => (window as never as Api).__audit.shootEye(f), f0) as string);

    rows.push(
      `${id.padEnd(13)} kerb L/R/any ${pct(stats.kerbLeft)}/${pct(stats.kerbRight)}/${pct(stats.kerbEither)} ` +
      `  R<400 ${pct(stats.under400)}  R<250 ${pct(stats.under250)}  R<120 ${pct(stats.under120)} ` +
      `  hw ${stats.halfWidthM.toFixed(1)}m  debris ${after.debris}` +
      `  calls ${stats.drawCalls}  tris ${(stats.triangles / 1000).toFixed(0)}k` +
      `  tightest ${corners.map((c) => `${Math.round(c.radiusM)}m`).join(',')}`,
    );
    process.stdout.write(rows[rows.length - 1].slice(13) + '\n');

    sections.push(`<section id="${id}"><h2>${id}</h2><pre>${rows[rows.length - 1]}</pre>
    <div class="grid">${shots.map((s) => `<figure><a href="${s.file}"><img loading="lazy" src="${s.file}"></a><figcaption>${s.label}</figcaption></figure>`).join('')}</div></section>`);
    await page.close();
  }

  await writeFile(resolve(OUT_DIR, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>corner audit</title><style>
 body{background:#0d0f12;color:#dfe3e8;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h2{font-size:16px;margin:32px 0 4px;border-bottom:1px solid #2a2f36}
 pre{color:#9aa3ad;font:12px ui-monospace,monospace}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
 figure{margin:0} img{width:100%;display:block;border:1px solid #2a2f36}
 figcaption{color:#9aa3ad;font:12px ui-monospace,monospace}
 a{color:#7fc4ff}</style></head><body><h1>corner audit</h1>
<nav>${CIRCUIT_IDS.map((i) => `<a href="#${i}">${i}</a> `).join('')}</nav>
<pre>${rows.join('\n')}</pre>${sections.join('\n')}</body></html>`, 'utf8');

  await browser.close();
  await server.close();
  console.log(`\nwrote ${OUT_DIR}/index.html`);
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log(`  ${e}`);
    process.exitCode = 1;
  }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0).padStart(3)}%`;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
