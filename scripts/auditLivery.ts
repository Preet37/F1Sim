import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { LIVERY_FAMILIES } from '../src/render/LiveryDesign';

/**
 * Photographs every pattern family on the real car.
 *
 * WHY THIS AND NOT A UNIT TEST. A livery is a picture. There is no assertion
 * that can tell you whether a chevron set looks like a chevron set or like a
 * fence, and the whole reason the previous painter had one design was that
 * nobody could see the alternatives without building them. So the six families
 * are built through the game's own `buildCar`, lit by the game's own
 * `EnvProbe`, and written out as PNGs at the range a garage shot holds the car.
 *
 * It reuses `audit/car.html` — the same harness `npm run audit:car` drives —
 * for the same reason that one reuses `buildCar`: a bespoke viewer proves
 * nothing about the game.
 *
 * Output lands in `audit-out/livery/`.
 *
 * WHAT IT ASSERTS, as opposed to what it photographs. Pictures are for a human;
 * the one thing here that a machine can and must check is that the EXISTING
 * 2026 grid was not repainted. `control` is built with no design at all, so it
 * is by definition the same car `audit:car` shoots as `day-high`, and the two
 * PNGs have to be byte-identical. That claim used to be written in a comment
 * and never checked — the script exited 0 on everything short of a page crash,
 * which for a rewritten `Livery.ts` (+662 lines) meant the only protection the
 * real grid had was somebody opening two files and looking at them.
 *
 * It now hashes both and fails on a difference, and fails on a page error, so
 * the exit code means something.
 *
 * Needs `npm run audit:car` to have been run on this tree first; that is what
 * writes the reference. `CAR_TAG` selects which run to compare against, exactly
 * as it does in `audit:car`, so `CAR_TAG=before` compares this tree's livery
 * work against a car shot before it.
 *
 * Run: npm run audit:car && npm run audit:livery
 */

const OUT_DIR = resolve(process.cwd(), 'audit-out', 'livery');
/** Where `audit:car` left the car this one must not have changed. */
const CAR_DIR = resolve(process.cwd(), 'audit-out', 'car', process.env.CAR_TAG ?? 'now');
/** The views `control` is shot from that `audit:car` also shoots. */
const CONTROL_VIEWS = ['hero', 'side', 'top'] as const;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

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

/**
 * One palette for every family, so the comparison is about ARRANGEMENT.
 *
 * Racing green, gold, ivory: a three-colour scheme where the trim is doing real
 * work and would be missed if it were not there, which is the property the
 * whole exercise is testing.
 */
const BASE = 0x0f4d35;
const ACCENT = 0xe0a72c;
const TRIM = 0xe8e0d0;

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

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
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1400,900',
    ],
  });

  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`error: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction('!!window.__car', { timeout: 120_000 });

  const shoot = async (name: string, view: string) => {
    const data = await page.evaluate(
      (v: string) => (window as never as {
        __car: { shoot(n: string): Promise<string> }
      }).__car.shoot(v), view) as string;
    await writePng(resolve(OUT_DIR, `${name}--${view}.png`), data);
  };

  const build = (opts: unknown) => page.evaluate(
    (o: unknown) => (window as never as {
      __car: { build(o: unknown): Promise<unknown> }
    }).__car.build(o), opts);

  // --- The control: no design at all ---------------------------------------
  //
  // Identical build options to `audit:car`'s `day-high`, so this shot must be
  // the same bytes. If it is not, the family work has moved a car on the
  // existing grid, which is the one thing it was not allowed to do.
  process.stdout.write('control  ');
  await build({ quality: 'high', ambience: 'day', compound: 'soft' });
  for (const view of CONTROL_VIEWS) {
    await shoot('control', view);
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // --- Every family, one palette, three angles -----------------------------
  for (const family of LIVERY_FAMILIES) {
    process.stdout.write(family.id.padEnd(9));
    await build({
      quality: 'high', ambience: 'day', compound: 'soft',
      colour: BASE, accent: ACCENT,
      design: { family: family.id, trim: TRIM, finish: 'satin', mark: 3 },
    });
    for (const view of ['hero', 'side', 'top']) {
      await shoot(family.id, view);
      process.stdout.write('.');
    }
    process.stdout.write('\n');
  }

  // --- Every finish, on the family the finish matters most on ---------------
  for (const finish of ['gloss', 'satin', 'matte'] as const) {
    process.stdout.write(('finish-' + finish).padEnd(9));
    await build({
      quality: 'high', ambience: 'day', compound: 'soft',
      colour: 0x10161f, accent: 0xc8102e,
      design: { family: 'halo', trim: 0xf2f5f9, finish, mark: 6 },
    });
    for (const view of ['hero', 'side']) {
      await shoot('finish-' + finish, view);
      process.stdout.write('.');
    }
    process.stdout.write('\n');
  }

  await browser.close();
  await server.close();

  console.log(`\n-> ${OUT_DIR}`);

  // --- THE ASSERTION -------------------------------------------------------
  const failures: string[] = [];

  if (!existsSync(CAR_DIR)) {
    failures.push(`no reference car in ${CAR_DIR} — run \`npm run audit:car\` on this `
      + 'tree first. Without it nothing here is checked and the existing grid is '
      + 'unprotected, which is the state this audit was in.');
  } else {
    for (const view of CONTROL_VIEWS) {
      const mine = resolve(OUT_DIR, `control--${view}.png`);
      const theirs = resolve(CAR_DIR, `day-high--${view}.png`);
      if (!existsSync(theirs)) {
        failures.push(`${theirs} is missing, so control--${view} was not checked`);
        continue;
      }
      const a = sha256(await readFile(mine));
      const b = sha256(await readFile(theirs));
      if (a === b) {
        console.log(`  control--${view} == audit:car day-high--${view}  ${a.slice(0, 8)}`);
      } else {
        failures.push(`control--${view} is NOT the car audit:car shoots: `
          + `${a.slice(0, 12)} vs ${b.slice(0, 12)}. The livery work has repainted a `
          + 'team on the existing 2026 grid.');
      }
    }
  }

  if (errors.length) {
    console.log('console output:');
    for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ' + e);
    failures.push(`${new Set(errors).size} distinct page error(s) while shooting`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\naudit:livery OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
