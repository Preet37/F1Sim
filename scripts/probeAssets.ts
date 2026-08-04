import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import {
  SLOT_EXTENSIONS, TEAM_SLOTS, SHARED_SLOTS, SHARED_DIR,
  slotCandidates, brandRoot, brandManifestUrl,
} from '../src/render/BrandAssets';

/**
 * The asset-slot loader, measured. Issue #36.
 *
 * WHAT THIS EXISTS TO PROVE, in the order the issue asks for it:
 *
 *  1. RESOLUTION ORDER. `public/brand/<team-id>/<slot>.png|webp|svg`, first hit
 *     wins, plus a non-team-scoped `shared/` for materials, LUTs and
 *     environment maps. Asserted in Node with no browser, which is why
 *     `BrandAssets.ts` imports neither three.js nor the DOM at module scope.
 *
 *  2. THE FALLBACK IS SILENT AND COSTS NOTHING. A slot with no file must
 *     produce no console output and no network request beyond the single
 *     manifest fetch, and asking for it twice must produce no request at all.
 *
 *  3. THE SHIPPABILITY GUARANTEE, WHICH IS THE WHOLE POINT. Three arms in ONE
 *     GL context: no file, file present, file removed again. The middle arm
 *     must be VISIBLY different and the third must be BYTE-IDENTICAL to the
 *     first. Byte-identical, not "looks the same" — the two shots are sha256'd,
 *     the same way `audit:livery` hashes its control against `audit:car`.
 *
 *     Running all three in one context is deliberate. Separate page loads would
 *     leave "and the two GL contexts agreed" as an unstated premise of the
 *     result, which is exactly the class of hidden assumption PROJECT.md §3.2
 *     is about.
 *
 *  4. IT CAN GO RED. `ASSETS_BREAK=root` points the loader at a directory that
 *     has no manifest and no artwork while the file is on disk. Every §3
 *     override assertion must then fail, and the byte-identity assertion must
 *     still pass — because a loader that finds nothing is exactly the shipped
 *     state.
 *
 * SAFETY. This probe writes and deletes ONE directory —
 * `public/brand/__probe__/` — and nothing else, ever. `public/brand/` is
 * gitignored and is where the user's own artwork goes; a probe that cleaned it
 * out to get a known-good baseline would be a probe that destroys the thing it
 * exists to support. The probe team id is not a team, so no artwork the user
 * drops in can collide with it.
 *
 * Run: npm run probe:assets
 */

const PROBE_TEAM = '__probe__';
const BRAND_DIR = resolve(process.cwd(), 'public', 'brand');
const PROBE_DIR = resolve(BRAND_DIR, PROBE_TEAM);
/** The views the three arms are compared on. Cheap, and they see the badge. */
const VIEWS = ['top', 'hero', 'side'] as const;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let ok = 0;
const failures: string[] = [];

function check(cond: boolean, label: string): void {
  if (cond) { ok++; console.log(`  ok   ${label}`); } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
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

function bytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

// ===========================================================================
// 1 — Resolution order, in Node
// ===========================================================================

function section1(): void {
  console.log('\n§1  RESOLUTION ORDER — no browser, no network');

  check(brandRoot() === '/brand/', `the brand root is /brand/ (got ${brandRoot()})`);
  check(
    brandManifestUrl() === '/brand/manifest.json',
    `the manifest is at /brand/manifest.json (got ${brandManifestUrl()})`,
  );
  check(
    SLOT_EXTENSIONS.join(',') === 'png,webp,svg',
    `extensions are tried png, webp, svg in that order (got ${SLOT_EXTENSIONS.join(',')})`,
  );

  const badge = slotCandidates('ferrari', 'badge');
  check(
    badge.join(' | ') === 'ferrari/badge.png | ferrari/badge.webp | ferrari/badge.svg',
    `a team badge resolves through ${badge.join(', ')}`,
  );

  for (const slot of TEAM_SLOTS) {
    const c = slotCandidates('mclaren', slot);
    check(
      c.length === 3 && c[0] === `mclaren/${slot}.png`,
      `team slot "${slot}" resolves under the team directory (${c[0]})`,
    );
  }
  check(
    TEAM_SLOTS.includes('badge') && TEAM_SLOTS.includes('sponsor')
    && TEAM_SLOTS.includes('portrait') && TEAM_SLOTS.includes('livery'),
    `the four team slots the issue names all exist (${TEAM_SLOTS.join(', ')})`,
  );

  for (const slot of SHARED_SLOTS) {
    const c = slotCandidates(SHARED_DIR, slot);
    check(
      c[0] === `shared/${slot}.png`,
      `shared slot "${slot}" is NOT team-scoped (${c[0]})`,
    );
  }
  check(
    slotCandidates(SHARED_DIR, 'material')[0] !== slotCandidates('ferrari', 'material')[0],
    'a shared asset and a team asset of the same name resolve to different paths',
  );
}

// ===========================================================================
// 2..4 — The browser arms
// ===========================================================================

interface Arm {
  label: string;
  hashes: Record<string, string>;
  shots: Record<string, string>;
}

async function main(): Promise<void> {
  const breakMode = process.env.ASSETS_BREAK ?? '';
  if (breakMode) console.log(`\n*** ASSETS_BREAK=${breakMode} — this run is EXPECTED to fail ***`);

  section1();

  // The probe owns `public/brand/__probe__/` and nothing else under it.
  const brandDirPreexisted = existsSync(BRAND_DIR);
  await rm(PROBE_DIR, { recursive: true, force: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const origin = `http://127.0.0.1:${addr.port}`;

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

  /** Every request the page made for anything under a brand root. */
  const brandRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/(brand|not-brand)[/-]/.test(u) || /\/(brand|not-brand)\//.test(u)) {
      brandRequests.push(u.slice(origin.length));
    }
  });

  const brandResponses: string[] = [];
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/brand')) return;
    brandResponses.push(`${r.status()} ${u.slice(origin.length)}`);
  });

  page.on('requestfailed', (r) => {
    if (!r.url().includes('/brand')) return;
    brandResponses.push(`FAILED(${r.failure()?.errorText}) ${r.url().slice(origin.length)}`);
  });

  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${(e as Error).message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/favicon/.test(m.location().url ?? '')) return;
    consoleErrors.push(`${m.text()} (${m.location().url ?? 'no url'})`);
  });

  try {
    await page.goto(`${origin}/audit/car.html`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('!!window.__car', { timeout: 120_000 });

    type CarApi = {
      build(o: unknown): Promise<unknown>;
      shoot(v: string): Promise<string>;
      resetBrand(root?: string): void;
      brand(): {
        root: string;
        manifest: string[] | null;
        slots: { key: string; path: string | null }[];
        undecodable: string[];
      };
    };
    const car = () => (window as never as { __car: CarApi }).__car;

    const build = (opts: unknown) =>
      page.evaluate((o: unknown) => (window as never as { __car: CarApi }).__car.build(o), opts);
    const reset = (root?: string) =>
      page.evaluate((r?: string) => (window as never as { __car: CarApi }).__car.resetBrand(r), root);
    const state = () =>
      page.evaluate(() => (window as never as { __car: CarApi }).__car.brand());
    void car;

    const shoot = async (label: string): Promise<Arm> => {
      const hashes: Record<string, string> = {};
      const shots: Record<string, string> = {};
      for (const v of VIEWS) {
        const data = await page.evaluate(
          (view: string) => (window as never as { __car: CarApi }).__car.shoot(view), v,
        ) as string;
        shots[v] = data;
        hashes[v] = sha256(bytes(data));
      }
      return { label, hashes, shots };
    };

    // A fixed palette, so the only thing that moves between arms is the slot.
    const BASE = { quality: 'high', ambience: 'day', colour: 0x0f4d35, accent: 0xe0a72c } as const;

    // ---------------------------------------------------------------------
    // §2 — the fallback costs one request and says nothing
    // ---------------------------------------------------------------------
    console.log('\n§2  THE FALLBACK — no file on disk');

    // WARM-UP, AND IT IS NOT CEREMONY. `CarMesh` loads the carbon-weave normal
    // map out of `public/textures/` with a `TextureLoader`, which is
    // asynchronous and which nothing in `buildCar` waits for — so the FIRST car
    // ever built in a page is drawn without it and every car after it is drawn
    // with it. Two builds of the identical car therefore differ, and a
    // byte-identity assertion that started at the first build would be
    // measuring texture arrival rather than asset slots. Caught by this probe's
    // own §2 self-check on the first run, which is the only reason it is known.
    brandRequests.length = 0;
    await build({ ...BASE, team: PROBE_TEAM });
    await shoot('warm-up');

    const manifestHits = brandRequests.filter((u) => u.endsWith('/manifest.json'));
    const assetHits = brandRequests.filter((u) => !u.endsWith('/manifest.json'));
    check(
      manifestHits.length === 1,
      `the loader asks for the manifest exactly once (${manifestHits.length}: ${manifestHits.join(', ') || 'none'})`,
    );
    check(
      assetHits.length === 0,
      `a slot with no file costs ZERO requests (${assetHits.length}: ${assetHits.join(', ') || 'none'})`,
    );
    check(
      consoleErrors.length === 0,
      `the fallback is silent — no console output (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' / ')})`,
    );

    const s0 = await state();
    check(
      s0.slots.length >= TEAM_SLOTS.length
      && s0.slots.every((x) => x.key.startsWith(PROBE_TEAM + '/') ? x.path === null : true),
      `every slot for a team with no artwork resolved to nothing (${s0.slots.map((x) => x.key + '=' + (x.path ?? 'none')).join(', ')})`,
    );

    // Asking again must touch the network not at all: the negative answer is
    // cached for the life of the page. This is the anti-storm assertion.
    brandRequests.length = 0;
    await build({ ...BASE, team: PROBE_TEAM });
    const armNone = await shoot('no-file');
    check(
      brandRequests.length === 0,
      `a second build issues NO further brand requests (${brandRequests.length}: ${brandRequests.join(', ') || 'none'})`,
    );

    await build({ ...BASE, team: PROBE_TEAM });
    const armNoneAgain = await shoot('no-file-again');
    check(
      VIEWS.every((v) => armNoneAgain.hashes[v] === armNone.hashes[v]),
      'rebuilding the same car with no artwork is byte-identical to the previous build',
    );

    // ---------------------------------------------------------------------
    // §3 — drop a file in
    // ---------------------------------------------------------------------
    console.log('\n§3  THE OVERRIDE — one badge dropped into public/brand/__probe__/');

    // Generated in the page and written from here, so the probe needs no PNG
    // encoder and no dependency. Magenta on white: a hue that appears nowhere
    // in this palette, on a ground that appears nowhere on this car, so a
    // pixel of it in the shot cannot have come from anything else.
    const badgePng = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#ff00c8';
      g.beginPath();
      g.arc(128, 128, 112, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#00ffd0';
      g.fillRect(48, 112, 160, 32);
      return c.toDataURL('image/png');
    });
    await mkdir(PROBE_DIR, { recursive: true });
    await writeFile(resolve(PROBE_DIR, 'badge.png'), bytes(badgePng));
    check(existsSync(resolve(PROBE_DIR, 'badge.png')), 'badge.png is on disk');

    brandRequests.length = 0;
    // `root` is the break seam: a directory with no manifest and no artwork.
    await reset(breakMode === 'root' ? '/not-brand/' : '/brand/');
    await build({
      ...BASE, team: PROBE_TEAM,
      ...(breakMode === 'root' ? { brandRoot: '/not-brand/' } : {}),
    });
    const armFile = await shoot('with-file');

    const s1 = await state();
    console.log(`  loader state: root=${s1.root} manifest=[${(s1.manifest ?? []).join(', ')}] `
      + `slots=[${s1.slots.map((x) => x.key + '=' + (x.path ?? 'none')).join(', ')}]`);
    console.log(`  brand requests this arm: ${brandRequests.join(', ') || 'none'}`);
    console.log(`  brand responses so far: ${brandResponses.join(' | ') || 'none'}`);
    const wire = await page.evaluate(async (u: string) => {
      const r = await fetch(u, { cache: 'no-cache' });
      const buf = await r.arrayBuffer();
      const head = [...new Uint8Array(buf).slice(0, 8)].join(',');
      const loaded = await new Promise<string>((done) => {
        const i = new Image();
        i.onload = () => done(`ok ${i.naturalWidth}x${i.naturalHeight}`);
        i.onerror = (e) => done('onerror ' + String(e));
        i.src = u;
      });
      return { status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength, head, loaded };
    }, `/brand/${PROBE_TEAM}/badge.png`);
    console.log(`  wire: ${JSON.stringify(wire)}`);
    check(
      s1.undecodable.length === 0,
      `nothing the manifest listed failed to decode (${s1.undecodable.join(', ') || 'none'})`,
    );
    const badgeSlot = s1.slots.find((x) => x.key === `${PROBE_TEAM}/badge`);
    check(
      badgeSlot?.path === `${PROBE_TEAM}/badge.png`,
      `the badge slot resolved to ${PROBE_TEAM}/badge.png (got ${badgeSlot?.path ?? 'nothing'})`,
    );
    check(
      (s1.manifest ?? []).includes(`${PROBE_TEAM}/badge.png`),
      `the manifest lists the dropped-in file (${(s1.manifest ?? []).length} file(s) under ${s1.root})`,
    );
    check(
      VIEWS.some((v) => armFile.hashes[v] !== armNone.hashes[v]),
      'the override CHANGED the render — the file on disk reaches the car',
    );

    // Where, and by how much. A hash difference says something moved; this says
    // the badge's own colour is on the car and that it is where a badge goes.
    // NOTE ON THE SHAPE OF THIS FUNCTION. No named function bindings inside it:
    // `tsx` compiles with esbuild's `keepNames`, which rewrites every named
    // function and const-arrow into a `__name(fn, '...')` call, and `__name` is
    // a module-local helper that does not exist inside the page. A helper
    // extracted for readability here fails at runtime with
    // `ReferenceError: __name is not defined`, which is a confusing way to
    // discover a build-tool detail.
    const diff = await page.evaluate(async (a: string, b: string) => {
      const ia = await new Promise<HTMLImageElement>((r) => {
        const i = new Image(); i.onload = () => r(i); i.src = a;
      });
      const ib = await new Promise<HTMLImageElement>((r) => {
        const i = new Image(); i.onload = () => r(i); i.src = b;
      });
      const cv = document.createElement('canvas');
      cv.width = ia.width; cv.height = ia.height;
      const g = cv.getContext('2d')!;
      g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, cv.width, cv.height).data;
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, cv.width, cv.height).data;
      let changed = 0;
      let magentaA = 0;
      let magentaB = 0;
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (let i = 0, p = 0; i < da.length; i += 4, p++) {
        if (da[i] > 110 && da[i + 2] > 80
          && da[i + 1] < da[i] * 0.55 && da[i + 1] < da[i + 2] * 0.85) magentaA++;
        if (db[i] > 110 && db[i + 2] > 80
          && db[i + 1] < db[i] * 0.55 && db[i + 1] < db[i + 2] * 0.85) magentaB++;
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) {
          changed++;
          const x = p % cv.width, y = (p / cv.width) | 0;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      return {
        changed, total: cv.width * cv.height, magentaA, magentaB,
        box: changed ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
        w: cv.width, h: cv.height,
      };
    }, armNone.shots.top, armFile.shots.top);

    console.log(`  overhead view: ${diff.changed} of ${diff.total} px changed, `
      + `badge-hue pixels ${diff.magentaA} -> ${diff.magentaB}, `
      + `bbox ${diff.box.join(',')} in ${diff.w}x${diff.h}`);
    check(
      diff.magentaA === 0,
      `the badge's own hue appears NOWHERE on the generated car (${diff.magentaA} px)`,
    );
    check(
      diff.magentaB > 200,
      `the badge's own hue is on the car once the file is there (${diff.magentaB} px)`,
    );

    // ---------------------------------------------------------------------
    // §4 — take it away again. THE SHIPPABILITY GUARANTEE.
    // ---------------------------------------------------------------------
    console.log('\n§4  DELETING public/brand/__probe__/ RETURNS THE RENDER TO BYTE-IDENTICAL');

    await rm(PROBE_DIR, { recursive: true, force: true });
    check(!existsSync(PROBE_DIR), 'the directory is gone');

    await reset('/brand/');
    await build({ ...BASE, team: PROBE_TEAM });
    const armGone = await shoot('file-removed');

    for (const v of VIEWS) {
      check(
        armGone.hashes[v] === armNone.hashes[v],
        `${v}: byte-identical to the generated car `
        + `(${armGone.hashes[v].slice(0, 12)} vs ${armNone.hashes[v].slice(0, 12)})`,
      );
    }

    const s2 = await state();
    check(
      (s2.manifest ?? []).every((f) => !f.startsWith(PROBE_TEAM + '/')),
      'the manifest no longer lists anything for the probe team',
    );

    // And the manifest endpoint itself, when there is no artwork at all. Only
    // asserted on a tree that had no `public/brand/` before this run, because
    // otherwise the user's own files are legitimately in it.
    if (!brandDirPreexisted) {
      const left = existsSync(BRAND_DIR) ? await readdir(BRAND_DIR) : [];
      if (left.length === 0) await rm(BRAND_DIR, { recursive: true, force: true });
      const body = await page.evaluate(async (u: string) => {
        const r = await fetch(u, { cache: 'no-cache' });
        return { status: r.status, text: await r.text() };
      }, '/brand/manifest.json');
      check(
        body.status === 200,
        `with no public/brand/ at all the manifest still answers 200 (got ${body.status})`,
      );
      check(
        body.text.replace(/\s/g, '') === '{"files":[]}',
        `...with an empty list, so nothing 404s and nothing is logged (got ${body.text.slice(0, 80)})`,
      );
    } else {
      console.log('  --   public/brand/ pre-existed on this tree; '
        + 'the empty-directory case is not asserted (the user\'s artwork is in it)');
    }

    check(
      consoleErrors.length === 0,
      `nothing was logged to the console for the whole run (${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' / ')})`,
    );
  } finally {
    await rm(PROBE_DIR, { recursive: true, force: true });
    if (!brandDirPreexisted && existsSync(BRAND_DIR)) {
      const left = await readdir(BRAND_DIR);
      if (left.length === 0) await rm(BRAND_DIR, { recursive: true, force: true });
    }
    await browser.close();
    await server.close();
  }

  console.log(`\n${ok} ok / ${failures.length} failed`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  if (failures.length > 0) process.exit(1);
  console.log('PASS — the asset slots resolve, fall back silently, and deleting them '
    + 'returns the render to byte-identical.');
}

main().catch((e) => { console.error(e); process.exit(1); });
