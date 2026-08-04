import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Photographs the safety car. The browser half is `audit/materials.ts`.
 *
 * `npm run shoot:safetycar` — four stations, written to
 * `audit-out/safetycar/<tag>/`. `SC_TAG=before` names the run so a before and
 * an after can sit side by side.
 *
 * It also reports the MEAN LEVEL of the bodywork region of each shot, because
 * "the paint looks better" is exactly the class of claim PROJECT.md section 3.1
 * exists to forbid. The region is a fixed box on the flank in the `side` view;
 * it is a number that moves when the BRDF moves and it is quoted rather than
 * eyeballed.
 */

const TAG = process.env.SC_TAG ?? 'shot';
const OUT = resolve(process.cwd(), 'audit-out', 'safetycar', TAG);
const VIEWS = ['hero', 'side', 'front34', 'roof'];

function chromePath(): string {
  const c = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((p): p is string => !!p);
  for (const p of c) if (existsSync(p)) return p;
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
  page.on('pageerror', (e) => console.log(`  pageerror: ${(e as Error).message}`));

  try {
    await page.goto(`${origin}/audit/materials.html`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('!!window.__materials', { timeout: 120_000 });
    await page.evaluate(() => window.__materials.build('high'));
    // The captured sky arrives asynchronously; shooting before it lands would
    // photograph the generated probe and the two runs would not be comparable.
    await new Promise((r) => setTimeout(r, 15_000));

    for (const v of VIEWS) {
      const data = await page.evaluate((view: string) => window.__materials.shoot(view), v) as string;
      await writeFile(resolve(OUT, `${v}.png`), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));

      // A fixed box on the near flank of the `side` view, and the whole frame
      // otherwise. Reported per channel: a half-metal tints its specular with
      // the surface's own hue, so the CHANNEL SPREAD is the thing that moves,
      // not only the level.
      const stat = await page.evaluate(async (d: string, isSide: boolean) => {
        const img = await new Promise<HTMLImageElement>((r) => {
          const i = new Image(); i.onload = () => r(i); i.src = d;
        });
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        const g = cv.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const x0 = isSide ? 430 : 0, y0 = isSide ? 330 : 0;
        const w = isSide ? 420 : cv.width, h = isSide ? 110 : cv.height;
        const px = g.getImageData(x0, y0, w, h).data;
        let r = 0, gg = 0, b = 0;
        for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
        const n = px.length / 4;
        return [r / n, gg / n, b / n];
      }, data, v === 'side');
      console.log(`  ${v.padEnd(8)} mean RGB ${stat.map((x) => x.toFixed(1)).join(' / ')}`
        + `   spread ${(Math.max(...stat) - Math.min(...stat)).toFixed(1)}`);
    }
    console.log(`\nwrote ${OUT}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
