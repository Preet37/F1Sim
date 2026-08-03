import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the full-screen panels.
 *
 * Separate from `shoot:hud` because the cost profile is completely different:
 * a HUD shot needs a circuit built under a software rasteriser and takes
 * minutes, and these pages have no 3D in them at all. Keeping them apart means
 * the panel sweep can be run after every tweak, which is what a design pass
 * actually needs.
 */

const OUT = resolve(process.cwd(), 'hud-out', process.env.SHOOT_TAG ?? 'panels');

const SHOTS: [string, string, string][] = [
  // panel, team, circuit — a low-abrasion circuit and an abrasive one, so the
  // strategist's recommendation is visibly different between the two shots.
  ['strategy', 'albion', 'silverstone'],
  ['strategy', 'apex', 'monaco'],
  ['strategy', 'brava', 'bahrain'],
];

const VIEWPORTS = [
  { name: 'desktop', width: 1400, height: 900 },
  { name: 'phone', width: 844, height: 390 },
  { name: 'portrait', width: 390, height: 844 },
];

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

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/panels.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 5 * 60_000,
    args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });

  const page: Page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  // Chrome asks every document for a favicon it has not been offered, and the
  // resulting 404 made this sweep exit non-zero on every clean run. See the
  // same note in `shootHud.ts`.
  //
  // Matched on the URL that failed, NOT on the message. The message for a
  // missing favicon and for a missing module are the same string — "Failed to
  // load resource: the server responded with a status of 404" — so a text
  // filter broad enough to catch the favicon also silently swallows a module
  // that did not load, which is precisely the failure this sweep exists to
  // catch. `m.location().url` is the one field that tells them apart.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('!!window.__panels', { timeout: 60_000 });

  // The HUD, over a flat backdrop and with no renderer — see `audit/panels.ts`.
  // This is the fast loop: "is the panel there, and where", answered in seconds
  // instead of the ten minutes a real circuit build costs.
  const HUD_SCENES = (process.env.SHOOT_SCENES
    ?? 'clear,pit-advice,safety-car,wet,in-box,pit-choice,rail-max,radio,radio-ask').split(',');

  // THE OVERLAP CHECK, and it is an assertion rather than a picture.
  //
  // Two faults were reported here in a row — the pit sheet drawn across the
  // radio card, and then the radio card drawn under two notification cards —
  // and both are invisible in a still if you are looking at the wrong corner
  // while being trivially decidable from four numbers. So every viewport and
  // every scene is measured, `rail-max` turns everything on at once, and any
  // intersection or anything escaping the rail's band fails the sweep.
  const railFailures: string[] = [];

  // THE MIRROR CHECK, and it is the second thing in this game the HUD is not
  // allowed to stand on. The mirrors had been mounted 78.6 degrees out of roll
  // since they were written; on the frame they were fixed, the weather bug was
  // lying across the left pane in the driver's eye and the tyre panel across it
  // in the cockpit — so on a landscape phone the player could not see one of
  // their own mirrors in either roll-hoop view. Same method as the rail: the
  // panes are boxes, the HUD is boxes, and an intersection fails the sweep.
  const MIRROR_MODES = ['driver', 'cockpit', 'onboard-t'];
  const mirrorFailures: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    for (const scene of HUD_SCENES) {
      await page.evaluate((s: string) => window.__panels.hud(s), scene);
      const file = `${vp.name}-hud-${scene}.png`;
      await page.screenshot({ path: resolve(OUT, file) as `${string}.png` });

      for (const mode of MIRROR_MODES) {
        await page.evaluate((m: string) => window.__panels.camera(m), mode);
        const mirrors = await page.evaluate(
          (m: string) => window.__panels.mirrorReport(m), mode,
        ) as { panes: string[]; boxes: string[]; overlaps: string[] };
        for (const o of mirrors.overlaps) {
          mirrorFailures.push(`${vp.name}/${scene}/${mode}: ${o}`);
        }
        if (mirrors.overlaps.length > 0 && vp.name === 'desktop' && scene === 'rail-max') {
          console.log('      panes: ' + mirrors.panes.join('  '));
        }
        // The rail's own guarantee has to survive the relayout, not just the
        // mirrors': lifting the whole bottom band by 274 pixels is exactly the
        // kind of move that stacks two panels on each other somewhere else.
        const railHere = await page.evaluate(() => window.__panels.railReport()) as {
          boxes: string[]; overlaps: string[]; clipped: string[];
        };
        for (const o of railHere.overlaps) {
          railFailures.push(`${vp.name}/${scene}/${mode}: overlap ${o}`);
        }
        for (const c of railHere.clipped) {
          railFailures.push(`${vp.name}/${scene}/${mode}: clipped ${c}`);
        }
      }
      // Back to a camera with no glass in it, so the rail is measured in the
      // layout the rest of this sweep photographs.
      await page.evaluate(() => window.__panels.camera('chase'));

      // THE RADIO CARD HAS TO BE THERE, and this is the one assertion the
      // overlap checks cannot make. `fitRail` is allowed to throw the card away
      // when the band is short, so a card too tall for the band produces a
      // perfectly clean sweep with no card in it. Only the scenes that raise
      // one are checked, and `radio-ask` additionally has to carry the buttons.
      if (scene === 'radio' || scene === 'radio-ask') {
        const r = await page.evaluate(() => window.__panels.radioReport()) as {
          shown: boolean; ratio: number; asking: boolean; turns: number; box: number[];
        };
        // A landscape phone under a safety car has a 94-pixel band with two
        // live cues in it, and no card fits in what is left. That is a measured
        // trade rather than a bug — the cues carry an instruction and the card
        // carries atmosphere — so it is exempted by BAND SIZE rather than by
        // viewport name, which keeps the assertion honest on a phone that does
        // have room.
        if (!r.shown && r.band > 150) {
          railFailures.push(
            `${vp.name}/${scene}: the radio card is not on screen in a ${r.band}px band`);
        } else if (r.shown && r.ratio < 0.8 && vp.name !== 'phone') {
          // The letterbox this pass replaced. Not asserted on a landscape
          // phone, where the band is 94px and the card is deliberately flat.
          railFailures.push(
            `${vp.name}/${scene}: the radio card is a letterbox, ratio ${r.ratio}`);
        }
        // Desktop only. On a phone and in portrait the rail is short enough
        // that a strategy call can be replaced by a neutralisation before the
        // shutter opens, and asserting on which of two live cards won a race
        // between two engine events is asserting on a coin toss.
        if (scene === 'radio-ask' && vp.name === 'desktop' && r.shown && !r.asking) {
          railFailures.push(`${vp.name}/${scene}: the wall asked and the card has no answer on it`);
        }
        console.log(`      radio ${vp.name}/${scene}: ` + JSON.stringify(r));
      }

      const rail = await page.evaluate(() => window.__panels.railReport()) as {
        boxes: string[]; overlaps: string[]; clipped: string[];
      };
      for (const o of rail.overlaps) railFailures.push(`${vp.name}/${scene}: overlap ${o}`);
      for (const c of rail.clipped) railFailures.push(`${vp.name}/${scene}: clipped ${c}`);

      const verdict = rail.overlaps.length === 0 && rail.clipped.length === 0
        ? 'no overlap'
        : `${rail.overlaps.length} overlap(s), ${rail.clipped.length} clipped`;
      if (vp.name === 'desktop') {
        const report = await page.evaluate(() => window.__panels.hudReport());
        console.log('  ' + file + '  ' + verdict + '  ' + JSON.stringify(report));
      } else {
        console.log('  ' + file + '  ' + verdict);
      }
      if (rail.overlaps.length > 0 || rail.clipped.length > 0) {
        console.log('      boxes: ' + rail.boxes.join('  '));
      }
    }
  }
  // The HUD leaves its own root in the page; the panel shots need it gone.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!window.__panels', { timeout: 60_000 });

  // The three full-screen boards: championship, race classification, and a
  // knockout qualifying segment with its cut line.
  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    for (const kind of ['champ', 'classification', 'qualifying']) {
      await page.evaluate((k: string) => window.__panels.board(k), kind);
      const file = `${vp.name}-board-${kind}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: vp.name === 'portrait',
      });
      console.log('  ' + file);
    }
  }

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    for (const [panel, team, circuit] of SHOTS) {
      await page.evaluate(
        (a: [string, string, string]) => window.__panels.show(a[0], a[1], a[2]),
        [panel, team, circuit] as [string, string, string],
      );
      await new Promise((r) => setTimeout(r, 250));
      const file = `${vp.name}-${panel}-${team}-${circuit}.png`;
      await page.screenshot({
        path: resolve(OUT, file) as `${string}.png`,
        fullPage: vp.name === 'portrait',
      });
      console.log('  ' + file);
    }
  }

  await browser.close();
  await server.close();
  console.log(`\nwrote ${OUT}`);
  if (railFailures.length) {
    console.log(`\n${railFailures.length} rail layout failure(s) — nothing on the rail may`);
    console.log('cover anything else, in any viewport, in any combination:');
    const seenRail = new Set<string>();
    for (const f of railFailures) {
      const key = f.slice(f.indexOf(':'));
      if (seenRail.has(key)) continue;
      seenRail.add(key);
      console.log('  ' + f);
    }
    process.exitCode = 1;
  } else {
    console.log('rail: nothing overlaps anything, all viewports, all scenes');
  }
  if (mirrorFailures.length) {
    console.log(`\n${mirrorFailures.length} mirror layout failure(s) — nothing in the HUD may`);
    console.log('cover a mirror pane, in any viewport, in any camera that has glass in it:');
    // One line per distinct complaint: the same widget over the same pane on
    // three viewports is one thing to fix, not three.
    const seen = new Set<string>();
    for (const f of mirrorFailures) {
      const key = f.slice(f.indexOf(':'));
      if (seen.has(key)) continue;
      seen.add(key);
      console.log('  ' + f);
    }
    process.exitCode = 1;
  } else {
    console.log('mirrors: nothing covers a pane, all viewports, all onboard cameras');
  }
  if (errors.length) {
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  }
}

void main();
