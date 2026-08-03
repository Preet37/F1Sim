import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * HIGH-FREQUENCY ENERGY ON THE ROAD, BY DEPTH — issue #48.
 *
 * The report is a Bahrain night frame in which the far and mid-distance asphalt
 * reads smooth and correct while the near field — roughly the bottom third —
 * is dense high-frequency speckle, with a visible transition band. The HUD read
 * 60fps, so it is not the frame rate: the SURFACE changes character with
 * distance, which is what a texture sampled past its own band limit does.
 *
 * WHY THIS EXISTS ALONGSIDE `probe:sharpness`
 *
 * `probe:sharpness` gained a grain metric for issue #29 — mean absolute
 * Laplacian of luma in six horizontal bands — but it is a REPORTER. It prints
 * the bands and exits 0 whatever they say, and it measures the WHOLE FRAME,
 * which mixes the sky, the barriers, the crowd and the car into a number that
 * is supposed to describe the road. PROJECT.md §3.2: a probe a broken feature
 * passes is worse than no probe. This one asserts, and it measures the asphalt
 * and nothing else.
 *
 * THE METRIC is deliberately identical to #29's so the two tables can be read
 * against each other: mean absolute Laplacian of luma, read back INSIDE the
 * animation frame that drew it (the context has no `preserveDrawingBuffer`, so
 * a `drawImage` on the next task gets an empty canvas), sampled at the canvas's
 * own pixels — which is the composited image including the upscale from
 * whatever the resolution scaler settled on. The Laplacian is blind to a smooth
 * gradient, which the lit road is, and maximal on single-pixel speckle, which
 * is what was reported.
 *
 * WHAT IS DIFFERENT, and it is the whole point:
 *
 *  1. THE SUPPORT IS THE ROAD. A second render of the same frame with the mesh
 *     named `ROAD_MESH_NAME` emissive-white and everything else black gives an
 *     occlusion-correct mask — the halo, the wheel, the car in front and the
 *     barriers all still write depth, so a pixel counts only if the asphalt is
 *     what is actually visible there. The mask is then ERODED by two pixels,
 *     because the silhouette of the road against the grass is a step edge and a
 *     Laplacian across it is enormous and says nothing about grain.
 *
 *  2. THE BANDS SPAN THE ROAD, not the frame. Bands 0..5 divide the road's own
 *     vertical extent in the frame, so band 0 is always the most distant
 *     asphalt on screen and band 5 always the nearest, on every circuit and in
 *     every camera mode. Fixed thirds of the frame put sky in band 0 at
 *     Silverstone and road in band 0 at Monaco, and the ratio then measures the
 *     circuit rather than the surface. The whole-frame fixed bands are reported
 *     too, unchanged, so #29's table stays comparable.
 *
 *  3. IT IS SHOT AT THE SCALE A PLAYER GETS. PROJECT.md §6: `audit:circuits`
 *     drives the renderer with a hard-coded `dt` of 1/60, so the resolution
 *     scaler never moves and "every audit PNG ever produced was shot at full
 *     resolution — the harness was photographing an image no player had ever
 *     seen." Grain is a sampling artefact and sampling is exactly what the
 *     scaler changes, so the real game loop is left alone until the scaler has
 *     settled, and the settled figure is what the shot is taken at.
 *
 * THERE ARE TWO ASSERTIONS and the second one exists because the first has a
 * blind spot that measurement found. Neither bound is a taste judgement.
 *
 *  - `near / mid` on the road, band 5 over band 2. Every band of the surface
 *    detail is faded out on its own screen-space footprint by `detailResolve`
 *    in `SurfaceDetail.ts` precisely so that no band is ever drawn at a
 *    frequency the pixel grid cannot carry; if that holds, high-frequency
 *    energy per pixel must not RISE as the asphalt comes closer, because the
 *    near field is where the footprint is smallest and every band is therefore
 *    inside its limit. A correctly band-limited road measures at or below 1.
 *  - THE LARGEST STEP BETWEEN ADJACENT BANDS, 1 through 5. The ratio above is
 *    two numbers and cannot see a defect that lifts the whole profile — see
 *    `BAND_STEP_MAX`, where an intermediate build that moved the aliasing from
 *    the bottom of the frame to the middle passed the first rule at 0.42. The
 *    user's own words for the artefact are *"a visible transition band"*, and
 *    a road inside its sampling limit everywhere does not have one.
 *
 * Usage:
 *   npm run probe:grain
 *   GRAIN_ONLY=bahrain GRAIN_TIERS=medium GRAIN_AMB=night npm run probe:grain
 *   GRAIN_SKIP_BUILD=1 GRAIN_ONLY=bahrain npm run probe:grain
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

const CIRCUIT_IDS = process.env.GRAIN_ONLY
  ? process.env.GRAIN_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

const TIERS = (process.env.GRAIN_TIERS ?? 'low,medium,high')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Day AND night, on every circuit, whatever the circuit's own time of day is.
 *
 * `ambience` is a property of the circuit definition — only Bahrain and Jeddah
 * are night races — but a grain artefact is a property of the SHADER, and the
 * night rig is a different lighting problem entirely: the specular term is most
 * of what a floodlit surface is, so a normal-map artefact that is invisible at
 * noon can dominate under lights. The reporter's frame is a night frame. So the
 * ambience is forced on both sides for every circuit rather than taking what
 * the calendar happens to give.
 */
const AMBIENCES = (process.env.GRAIN_AMB ?? 'day,night')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MODES = (process.env.GRAIN_MODES ?? 'cockpit,chase').split(',').map((s) => s.trim());

/**
 * `GRAIN_VIEWPORT=390x844x2` — CSS size and device pixel ratio to emulate.
 *
 * The reporting device is a phone, and grain is a SAMPLING artefact, so the
 * pixel count is not a detail of the harness — it is half the physics. A phone
 * in portrait is 390x844 CSS and the renderer caps its pixel ratio at 2, so it
 * draws about 1.3 megapixels against this window's four: every world footprint
 * per pixel is correspondingly larger, and `detailResolve` fades every band out
 * nearer to the camera as a result. Measuring only at desktop geometry would be
 * `audit:circuits`' hard-coded `dt` in a different costume — an image no player
 * has been shown.
 *
 * This emulates the geometry only. It cannot make an M-series GPU into a
 * phone's, and nothing here should be read as if it could.
 */
const VIEWPORT = (() => {
  const v = process.env.GRAIN_VIEWPORT;
  if (!v) return null;
  const m = /^(\d+)x(\d+)(?:x([\d.]+))?$/.exec(v.trim());
  if (!m) throw new Error(`GRAIN_VIEWPORT must be WxH or WxHxDPR, got ${v}`);
  return { width: +m[1], height: +m[2], deviceScaleFactor: m[3] ? +m[3] : 1 };
})();
const TAG = process.env.GRAIN_TAG ?? 'shot';
const STEPS = Number(process.env.GRAIN_STEPS ?? 1800);
const SETTLE_MS = Number(process.env.GRAIN_SETTLE ?? 9000);
/** Entry index of the car the camera follows. Car 0 has nobody driving it. */
const FOCUS_CAR = Number(process.env.GRAIN_CAR ?? 6);
const OUT_DIR = resolve(process.cwd(), 'grain-out', TAG);
/** Write a PNG per configuration. Off by default: 66 shots is 66 files. */
const SAVE_PNG = process.env.GRAIN_PNG === '1';

/**
 * The bound on near/mid high-frequency energy on the asphalt.
 *
 * See the header. A road whose detail bands are all inside their sampling
 * limit cannot get noisier as it approaches, so the honest bound is 1. This
 * sits above it to leave room for the aggregate tint that near asphalt
 * genuinely resolves and distant asphalt genuinely cannot — that is real
 * surface detail, not aliasing, and it is worth having.
 *
 * NEVER RAISE THIS. PROJECT.md §3.3. If a number moves, find out why.
 */
const NEAR_OVER_MID_MAX = Number(process.env.GRAIN_MAX ?? 1.60);

/**
 * The largest step allowed between two ADJACENT road bands, bands 1 to 5.
 *
 * The second assertion, and it exists because the first one has a blind spot
 * that was found by measurement rather than by reasoning. `near/mid` is the
 * reported symptom, but it is a ratio of two bands and it cannot see a defect
 * that lifts the WHOLE profile: an intermediate build with the band limit in
 * place but `detailResolve`'s ramp still at its old, past-Nyquist setting
 * measured 2.1 1.6 7.6 7.5 5.0 3.2 — the aliasing had simply moved from the
 * bottom of the frame to the middle — and near/mid read 0.42, which is a PASS.
 * That build is worse than the one that was shipped in the bands the user can
 * see most of, and the headline number said it was fine.
 *
 * The user's own description is what the second rule is written from: *"a
 * visible transition band"*. A road whose detail is inside its sampling limit
 * everywhere has no such band — its high-frequency energy varies smoothly with
 * depth, because the footprint does. So no adjacent pair may differ by more
 * than this. On the intermediate build the 1.6 -> 7.6 step is 4.75 and on the
 * build the issue was filed against the 2.2 -> 12.2 step is 5.55.
 *
 * Band 0 is excluded. It is the asphalt at the horizon, where the post chain's
 * ambient occlusion lands and where #29 already measured and documented what
 * the tiers do; it is not the road surface's own band limit and it is not what
 * this probe is about.
 *
 * NEVER RAISE EITHER OF THESE. PROJECT.md §3.3.
 */
const BAND_STEP_MAX = Number(process.env.GRAIN_STEP_MAX ?? 2.20);

/**
 * Bands with less road in them than this are not measured.
 *
 * A band holding a few hundred pixels of asphalt seen edge-on through the halo
 * is a sample of the halo's anti-aliasing, not of the road.
 */
const MIN_BAND_PIXELS = 1500;

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

/**
 * Installed once per page. Everything below runs inside one animation frame:
 * draw the real frame, read it, draw the mask over it, read that, put the
 * materials back. Two reads of the same canvas in one task, which is the only
 * time the drawing buffer is guaranteed to still hold what was drawn.
 */
const MEASURE_SRC = String.raw`(() => {
  const g = window.__game;

  /** Occlusion-correct road mask: white asphalt, black everything else. */
  const maskState = { white: null, black: null };
  const buildMaskMaterials = (road) => {
    if (maskState.white) return;
    const Ctor = (Array.isArray(road.material) ? road.material[0] : road.material).constructor;
    // Emissive rather than colour: emissive is not touched by the lighting, by
    // the vertex colours the road carries, or by the shadow map, so the mask is
    // a hard binary whatever the ambience is doing.
    maskState.white = new Ctor({ color: 0x000000, emissive: 0xffffff, fog: false });
    maskState.black = new Ctor({ color: 0x000000, emissive: 0x000000, fog: false });
  };

  const swapIn = (scene, road) => {
    const saved = [];
    scene.traverse((o) => {
      if (!o.material) return;
      saved.push([o, o.material]);
      o.material = (o === road) ? maskState.white : maskState.black;
    });
    return saved;
  };
  const swapOut = (saved) => { for (const pair of saved) pair[0].material = pair[1]; };

  const luma = (d, p) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];

  /** Mean absolute Laplacian of luma over the given predicate, per band. */
  const bandsOver = (img, w, h, rows, nbands, ok) => {
    const out = [], counts = [];
    for (let b = 0; b < nbands; b++) {
      const y0 = Math.max(1, Math.floor(rows.y0 + (rows.span * b) / nbands));
      const y1 = Math.min(h - 2, Math.floor(rows.y0 + (rows.span * (b + 1)) / nbands));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!ok(x, y)) continue;
          const i = (y * w + x) * 4;
          const c = luma(img, i);
          const lap = 4 * c - luma(img, i - 4) - luma(img, i + 4)
            - luma(img, i - w * 4) - luma(img, i + w * 4);
          sum += Math.abs(lap); n++;
        }
      }
      out.push(n ? sum / n : 0);
      counts.push(n);
    }
    return { bands: out, counts: counts };
  };

  g.__grainMeasure = (nbands) => new Promise((res) => {
    requestAnimationFrame(() => {
      const scene = g.renderer.scene;
      const cam = g.renderer.director.camera;
      const road = scene.getObjectByName('road-asphalt');
      if (!road) { res({ error: 'no mesh named road-asphalt in the scene' }); return; }
      buildMaskMaterials(road);

      const src = document.querySelector('canvas');
      const w = src.width, h = src.height;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });

      // 1. The real frame, through the real path: post chain, tone map, the lot.
      g.renderer.render(1 / 60, 1, g.engine, g.__focus);
      cx.drawImage(src, 0, 0);
      const img = cx.getImageData(0, 0, w, h).data;

      // 2. The same camera, same instant, as a mask. Straight through the
      //    WebGLRenderer so the bloom does not smear the silhouette.
      const saved = swapIn(scene, road);
      g.renderer.renderer.render(scene, cam);
      swapOut(saved);
      cx.clearRect(0, 0, w, h);
      cx.drawImage(src, 0, 0);
      const maskImg = cx.getImageData(0, 0, w, h).data;

      // Binary, then eroded by ERODE pixels. The silhouette of the asphalt
      // against the grass, the kerb and the car in front is a step edge; a
      // Laplacian laid across one measures the edge, not the surface.
      const ERODE = 2;
      const raw = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        raw[i] = luma(maskImg, p) > 110 ? 1 : 0;
      }
      const mask = new Uint8Array(w * h);
      for (let y = ERODE; y < h - ERODE; y++) {
        for (let x = ERODE; x < w - ERODE; x++) {
          let all = 1;
          for (let dy = -ERODE; dy <= ERODE && all; dy++) {
            for (let dx = -ERODE; dx <= ERODE; dx++) {
              if (!raw[(y + dy) * w + (x + dx)]) { all = 0; break; }
            }
          }
          mask[y * w + x] = all;
        }
      }

      let total = 0, minY = h, maxY = -1;
      for (let y = 0; y < h; y++) {
        let rowN = 0;
        for (let x = 0; x < w; x++) if (mask[y * w + x]) rowN++;
        if (rowN > 0) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        total += rowN;
      }
      if (maxY < 0 || total < 5000) {
        res({ error: 'road-asphalt covers ' + total + 'px of the frame' });
        return;
      }

      // Road bands span the ROAD's extent; frame bands span the frame, which is
      // what #29 measured and what keeps its table comparable.
      const roadRes = bandsOver(img, w, h, { y0: minY, span: maxY - minY }, nbands,
        (x, y) => mask[y * w + x] === 1);
      const frameRes = bandsOver(img, w, h, { y0: 0, span: h }, nbands, () => true);

      res({
        width: w, height: h,
        roadPixels: total, roadTop: minY, roadBottom: maxY,
        road: roadRes.bands, roadCounts: roadRes.counts,
        frame: frameRes.bands,
      });
    });
  });
})()`;

interface Row {
  circuit: string;
  ambience: string;
  tier: string;
  mode: string;
  settledScale: number;
  buffer: string;
  features: string;
  road: number[];
  roadCounts: number[];
  frame: number[];
  nearOverMid: number | null;
  /** Largest ratio between adjacent road bands 1..5. Issue #48. */
  bandStep: number | null;
  ok: boolean;
  note: string;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  if (process.env.GRAIN_SKIP_BUILD !== '1') {
    console.log('building...');
    await build({ logLevel: 'warn' });
  }
  const server: PreviewServer = await preview({
    preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn',
  });
  const addr = server.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 20 * 60_000,
    defaultViewport: null,
    args: [
      '--window-size=1600,1000', '--window-position=0,0', '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const page: Page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  await page.bringToFront();
  if (VIEWPORT) {
    await page.setViewport(VIEWPORT);
    console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}`
      + ` @ dpr ${VIEWPORT.deviceScaleFactor}`);
  }

  const rows: Row[] = [];

  for (const id of CIRCUIT_IDS) {
    for (const tier of TIERS) {
      // A page load per tier, not a live `setGraphics`. MSAA is an attribute of
      // the GL CONTEXT when the post chain is off, and a context attribute
      // cannot be changed without a new context — `Renderer.setGraphics` says
      // so itself rather than pretending. Reloading is the only way to be sure
      // the tier under measurement is the tier that drew the frame.
      await page.goto(
        `${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7&quality=${tier}`,
        { waitUntil: 'load', timeout: 180_000 },
      );
      await page.waitForFunction(
        "!!window.__game && window.__game.screen === 'racing'",
        { timeout: 300_000, polling: 250 },
      );

      // Let the real loop run so the dynamic resolution scaler settles, with
      // simulated time paused so the world does not depend on how many frames
      // the machine happened to manage. See probeSharpness.
      await page.evaluate('window.__game.clock.paused = true');
      process.stdout.write(`${id} ${tier}: settling... `);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const settled = await page.evaluate(
        'window.__game.renderer.resolutionScale') as number;
      process.stdout.write(`scale=${settled.toFixed(2)}, stepping... `);

      await page.evaluate(`(() => {
        const g = window.__game;
        cancelAnimationFrame(g.rafHandle);
        for (let i = 0; i < ${STEPS}; i++) { g.engine.step(); if (g.engine.over) break; }
        g.__focus = g.engine.cars.find((c, i) => i >= ${FOCUS_CAR} && !c.retired)
          || g.engine.cars.find((c) => !c.retired) || g.engine.cars[0];
        // The scaler is frozen from here: the shot is taken at what it settled
        // on, and nothing after this point is allowed to move it.
        Object.getPrototypeOf(g.renderer).updateResolutionScale = function () {};
        g.__stop = false;
        g.__draw = (n) => new Promise((res) => {
          const tick = () => {
            g.renderer.render(1 / 60, 1, g.engine, g.__focus);
            if (n-- > 0 && !g.__stop) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
      })()`);
      process.stdout.write('stepped\n');
      await page.evaluate(MEASURE_SRC);

      for (const amb of AMBIENCES) {
        // `applyAmbience` reads the circuit definition, so the definition is
        // what gets changed. Private in TypeScript only; it is on the prototype
        // at runtime, and driving the REAL one is the whole point — a probe
        // that re-implements the night rig measures its own copy.
        await page.evaluate(`(() => {
          const g = window.__game;
          g.engine.track.def.ambience = ${JSON.stringify(amb)};
          Object.getPrototypeOf(g.renderer).applyAmbience.call(g.renderer, g.engine);
        })()`);

        for (const mode of MODES) {
          await page.evaluate(
            `window.__game.renderer.director.setMode(${JSON.stringify(mode)})`);
          // Enough frames for the camera rig to damp onto its anchor and for
          // the exposure and the environment probe to catch up with the light.
          await page.evaluate('window.__game.__stop = false');
          await page.evaluate('window.__game.__draw(120)');

          const feat = await page.evaluate(
            '(() => { const f = window.__game.renderer.features;'
            + ' return f.tier + (f.post ? "+post" : "") + (f.shadows ? "+shadow" : "")'
            + ' + (f.msaa ? "+msaa" : ""); })()') as string;
          const buf = await page.evaluate(`(() => {
            const c = window.__game.renderer.renderer.getContext();
            return c.drawingBufferWidth + 'x' + c.drawingBufferHeight;
          })()`) as string;

          const m = await page.evaluate('window.__game.__grainMeasure(6)') as {
            error?: string;
            road?: number[]; roadCounts?: number[]; frame?: number[];
            roadPixels?: number;
          };

          if (SAVE_PNG) {
            const box = await page.evaluate(`(() => {
              const r = document.querySelector('canvas').getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()`) as { x: number; y: number; width: number; height: number };
            const drawing = page.evaluate('window.__game.__draw(100000)')
              .catch(() => undefined);
            await new Promise((r) => setTimeout(r, 300));
            const png = await page.screenshot({ clip: box, type: 'png' });
            await page.evaluate('window.__game.__stop = true');
            await drawing;
            await writeFile(resolve(OUT_DIR, `${id}-${amb}-${tier}-${mode}.png`), png);
          }

          const label = `${id} ${amb} ${tier} ${mode}`;
          if (m.error || !m.road) {
            rows.push({
              circuit: id, ambience: amb, tier, mode,
              settledScale: settled, buffer: buf, features: feat,
              road: [], roadCounts: [], frame: [],
              nearOverMid: null, bandStep: null, ok: false,
              note: m.error ?? 'no measurement',
            });
            console.log(`  ${label.padEnd(38)} FAIL — ${m.error ?? 'no measurement'}`);
            continue;
          }

          const road = m.road.map((v) => Number(v.toFixed(2)));
          const counts = m.roadCounts ?? [];
          const near = road[5];
          const mid = road[2];
          const usable = (counts[5] ?? 0) >= MIN_BAND_PIXELS
            && (counts[2] ?? 0) >= MIN_BAND_PIXELS && mid > 0;
          const ratio = usable ? Number((near / mid).toFixed(2)) : null;

          // The visible transition band: the largest step between adjacent
          // road bands, over bands 1..5. See `BAND_STEP_MAX`.
          let step = 0;
          let stepAt = '';
          for (let b = 1; b < 5; b++) {
            if ((counts[b] ?? 0) < MIN_BAND_PIXELS) continue;
            if ((counts[b + 1] ?? 0) < MIN_BAND_PIXELS) continue;
            const lo = Math.min(road[b], road[b + 1]);
            const hi = Math.max(road[b], road[b + 1]);
            if (lo <= 0) continue;
            const s = hi / lo;
            if (s > step) { step = s; stepAt = `${b}->${b + 1}`; }
          }
          const stepRatio = step > 0 ? Number(step.toFixed(2)) : null;

          const notes: string[] = [];
          if (ratio !== null && ratio > NEAR_OVER_MID_MAX) {
            notes.push(`near-field asphalt is ${ratio.toFixed(2)}x the mid-distance`
              + ` (bound ${NEAR_OVER_MID_MAX.toFixed(2)})`);
          }
          if (stepRatio !== null && stepRatio > BAND_STEP_MAX) {
            notes.push(`transition band at ${stepAt}: ${stepRatio.toFixed(2)}x`
              + ` between adjacent depth bands (bound ${BAND_STEP_MAX.toFixed(2)})`);
          }
          if (ratio === null && stepRatio === null) {
            notes.push(`too little asphalt to measure`
              + ` (band 2 ${counts[2] ?? 0}px, band 5 ${counts[5] ?? 0}px)`);
          }
          const ok = !notes.some((n) => n.startsWith('near-field')
            || n.startsWith('transition'));
          const note = notes.join('; ');

          rows.push({
            circuit: id, ambience: amb, tier, mode,
            settledScale: settled, buffer: buf, features: feat,
            road, roadCounts: counts,
            frame: (m.frame ?? []).map((v) => Number(v.toFixed(2))),
            nearOverMid: ratio, bandStep: stepRatio, ok, note,
          });

          console.log(
            `  ${label.padEnd(38)} ${ok ? 'ok  ' : 'FAIL'} `
            + `near/mid=${ratio === null ? ' n/a' : ratio.toFixed(2)}`
            + ` step=${stepRatio === null ? ' n/a' : stepRatio.toFixed(2)}`
            + `  road far->near: ${road.map((v) => v.toFixed(1).padStart(5)).join(' ')}`
            + `  [${feat} scale=${settled.toFixed(2)} ${buf}]`,
          );
          if (note && !ok) console.log(`       ${note}`);
        }
      }
    }
  }

  await writeFile(resolve(OUT_DIR, 'manifest.json'),
    JSON.stringify({
      nearOverMidMax: NEAR_OVER_MID_MAX, bandStepMax: BAND_STEP_MAX, rows,
    }, null, 2), 'utf8');
  await browser.close();
  await server.close();

  const failed = rows.filter((r) => !r.ok);
  console.log('\n=== ROAD GRAIN BY DEPTH — issue #48 ===');
  console.log('mean |Laplacian| of luma, road pixels only, banded over the'
    + " road's own extent in the frame");
  console.log(`bounds: near-field <= ${NEAR_OVER_MID_MAX.toFixed(2)}x the`
    + ` mid-distance; no adjacent depth bands differing by more than`
    + ` ${BAND_STEP_MAX.toFixed(2)}x`);
  console.log(`${rows.length - failed.length} ok / ${failed.length} failed`);
  for (const r of failed) {
    console.log(`  FAIL ${r.circuit} ${r.ambience} ${r.tier} ${r.mode}: ${r.note}`);
  }
  console.log(`\nwrote ${OUT_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
