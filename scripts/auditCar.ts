import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the CAR, close up, through the game's own `buildCar`.
 *
 * `npm run audit:circuits` shoots the world at race-camera distance, where the
 * whole car is a hundred pixels across. Every complaint that has ever been
 * raised about the car itself lives inside those hundred pixels: tread lines on
 * a slick, a rim with nothing behind it, suspension members that do not
 * describe a wishbone, a rear wing with no flap. This sweep photographs each of
 * those at the range a garage shot holds them, in all three ambiences, at both
 * detail tiers, and writes the measured vertex and draw-call cost next to them
 * so a change that fixes the look and halves the frame rate cannot be shipped
 * by accident.
 *
 * Output lands in `audit-out/car/`.
 */

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'car');

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

interface Stats {
  quality: string;
  drawCalls: number;
  triangles: number;
  vertices: number;
  parts: { name: string; verts: number; tris: number }[];
}

/**
 * `CAR_ONLY=hero,rimClose` narrows the sweep while iterating.
 * `CAR_TAG=before` writes into `audit-out/car/before/` so two runs can be
 * compared side by side rather than one overwriting the other.
 */
const ONLY = process.env.CAR_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const TAG = process.env.CAR_TAG ?? 'now';

async function writePng(path: string, dataUrl: string): Promise<void> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  await writeFile(path, Buffer.from(b64, 'base64'));
}

async function main(): Promise<void> {
  const dir = resolve(OUT_DIR, TAG);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/car.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 20 * 60_000,
    args: [
      '--headless=new', '--no-sandbox', '--hide-scrollbars',
      // Software GL, so the picture is the same on every machine. See the note
      // in auditCircuits.ts.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    const t = m.text();
    // 'warn', not 'warning' — puppeteer's ConsoleMessageType has no 'warning'
    // member, so this comparison was constantly false and the audit has never
    // recorded a single console warning in its life.
    if (m.type() === 'error' || m.type() === 'warn') errors.push(`${m.type()}: ${t}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__car', { timeout: 120_000 });

  const views: string[] = await page.evaluate('window.__car.views.slice()') as string[];
  const wanted = ONLY ? views.filter((v) => ONLY.includes(v)) : views;

  const lines: string[] = [];
  const record: Record<string, Stats> = {};

  /** One build configuration, and the views taken from it. */
  const passes = [
    { tag: 'day-high', opts: { quality: 'high', ambience: 'day', compound: 'soft' }, views: wanted },
    { tag: 'night-high', opts: { quality: 'high', ambience: 'night', compound: 'medium' }, views: wanted.filter((v) => ['hero', 'rear34', 'side', 'rimClose', 'rearWing'].includes(v)) },
    { tag: 'dusk-high', opts: { quality: 'high', ambience: 'dusk', compound: 'hard' }, views: wanted.filter((v) => ['hero', 'rear34', 'side'].includes(v)) },
    { tag: 'drs-open', opts: { quality: 'high', ambience: 'day', compound: 'soft', drs: 1 }, views: wanted.filter((v) => ['rearWing', 'rearWingSide', 'frontWing', 'rear34', 'top'].includes(v)) },
    { tag: 'steer', opts: { quality: 'high', ambience: 'day', compound: 'soft', steer: 0.32 }, views: wanted.filter((v) => ['susFront', 'wheelFront', 'front', 'top'].includes(v)) },
    { tag: 'day-low', opts: { quality: 'low', ambience: 'day', compound: 'soft' }, views: wanted.filter((v) => ['hero', 'rear34', 'rimClose', 'rearWing'].includes(v)) },
  ] as const;

  for (const pass of passes) {
    process.stdout.write(`${pass.tag.padEnd(12)}`);
    const stats = await page.evaluate(
      (o: unknown) => (window as never as { __car: { build(o: unknown): Promise<Stats> } }).__car.build(o),
      pass.opts,
    ) as Stats;
    record[pass.tag] = stats;
    for (const v of pass.views) {
      const data = await page.evaluate(
        (name: string) => (window as never as { __car: { shoot(n: string): Promise<string> } }).__car.shoot(name),
        v,
      ) as string;
      await writePng(resolve(dir, `${pass.tag}--${v}.png`), data);
      process.stdout.write('.');
    }
    const s = await page.evaluate('window.__car.stats()') as Stats;
    record[pass.tag] = s;
    process.stdout.write(` ${s.drawCalls} calls, ${s.triangles} tris, ${s.vertices} verts\n`);
  }

  lines.push('# car audit — measured cost');
  lines.push('');
  lines.push('Per CAR, per frame. `draw calls` counts the visible meshes under the car');
  lines.push('root; `triangles` sums them per instance, so the four wheels are counted');
  lines.push('four times. `unique vertices` is the memory cost, which the whole field');
  lines.push('shares one copy of.');
  lines.push('');
  lines.push('| pass | draw calls | triangles drawn | unique vertices |');
  lines.push('| --- | --- | --- | --- |');
  for (const [tag, s] of Object.entries(record)) {
    lines.push(`| ${tag} | ${s.drawCalls} | ${s.triangles} | ${s.vertices} |`);
  }
  lines.push('');
  const high = record['day-high'];
  if (high) {
    lines.push('## high tier, per-geometry breakdown (unique geometries only)');
    lines.push('');
    lines.push('| mesh | vertices | triangles |');
    lines.push('| --- | --- | --- |');
    for (const p of high.parts) lines.push(`| ${p.name} | ${p.verts} | ${p.tris} |`);
  }
  if (errors.length) {
    lines.push('');
    lines.push('## console');
    lines.push('');
    for (const e of [...new Set(errors)]) lines.push(`- ${e}`);
  }
  await writeFile(resolve(dir, 'cost.md'), lines.join('\n'), 'utf8');

  console.log(`\n${wanted.length} views -> ${dir}`);
  if (errors.length) {
    console.log('console output:');
    for (const e of [...new Set(errors)].slice(0, 40)) console.log(`  ${e}`);
  }

  await browser.close();
  await server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
