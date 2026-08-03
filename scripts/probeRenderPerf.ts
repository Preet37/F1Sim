import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Measures what the player is ACTUALLY shown, on a real GPU.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `audit:circuits`
 *
 * `audit:circuits` drives the same renderer, but it drives it with a hard-coded
 * `dt` of 1/60 and it runs on swiftshader. Both matter here:
 *
 *   - A fixed 1/60 makes `Renderer.updateResolutionScale` compute exactly 60fps
 *     every time, which is neither below 59 nor above 68, so the dynamic
 *     resolution scaler NEVER MOVES in the audit. Every audit PNG this project
 *     has produced was therefore shot at `resolutionScale = 1`, whatever the
 *     game was doing on a real machine.
 *   - Software GL says nothing about frame time on the player's hardware.
 *
 * So this drives the real `main.ts` game, through its `?circuit=` deep link, in
 * a HEADFUL Chrome on the host GPU, and samples the renderer's own state every
 * frame: the scale the scaler settled on, the drawing-buffer size that produced,
 * and the frame time that drove it.
 *
 * Usage:
 *   npx tsx scripts/probeRenderPerf.ts
 *   PERF_ONLY=bahrain,spa PERF_SECONDS=20 npx tsx scripts/probeRenderPerf.ts
 *   PERF_ONLY=monaco PERF_ABLATE=1 npx tsx scripts/probeRenderPerf.ts
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

const CIRCUIT_IDS = process.env.PERF_ONLY
  ? process.env.PERF_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

const SECONDS = Number(process.env.PERF_SECONDS ?? 14);
const WARMUP_MS = Number(process.env.PERF_WARMUP ?? 6000);
const PAIR = process.env.PERF_PAIR ?? '';
const CAMERA = process.env.PERF_CAMERA ?? '';
const OUT_DIR = resolve(process.cwd(), 'perf-out');

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

interface Sample {
  t: number;
  dt: number;
  scale: number;
  bw: number;
  bh: number;
  calls: number;
  tris: number;
}

interface Stats {
  frames: number;
  meanFps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  scaleFirst: number;
  scaleLast: number;
  scaleMin: number;
  scaleMean: number;
  bufferFirst: string;
  bufferLast: string;
  cssSize: string;
  dpr: number;
  callsMean: number;
  trisMean: number;
  pixelsFraction: number;
  /** `t=<seconds since sampling began> scale=<value>`, one entry per change. */
  scaleTrace: string[];
  perSecond: string;
  /** GPU time for the whole of Renderer.render, from timer queries. */
  gpuFrames: number;
  gpuMedianMs: number;
  gpuP90Ms: number;
}

function pct(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

function summarise(samples: Sample[], css: { w: number; h: number; dpr: number }): Stats {
  const dts = samples.map((s) => s.dt).filter((d) => d > 0 && d < 1000);
  const scales = samples.map((s) => s.scale);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const nativePixels = css.w * css.dpr * css.h * css.dpr;
  return {
    frames: samples.length,
    meanFps: dts.length ? 1000 / (dts.reduce((a, b) => a + b, 0) / dts.length) : 0,
    medianFrameMs: pct(dts, 0.5),
    p95FrameMs: pct(dts, 0.95),
    scaleFirst: first.scale,
    scaleLast: last.scale,
    scaleMin: Math.min(...scales),
    scaleMean: scales.reduce((a, b) => a + b, 0) / scales.length,
    bufferFirst: `${first.bw}x${first.bh}`,
    bufferLast: `${last.bw}x${last.bh}`,
    cssSize: `${css.w}x${css.h}`,
    dpr: css.dpr,
    callsMean: samples.reduce((a, b) => a + b.calls, 0) / samples.length,
    trisMean: samples.reduce((a, b) => a + b.tris, 0) / samples.length,
    pixelsFraction: (last.bw * last.bh) / nativePixels,
    scaleTrace: trace(samples),
    perSecond: perSecond(samples),
    gpuFrames: 0,
    gpuMedianMs: 0,
    gpuP90Ms: 0,
  };
}

/** Frames counted in each whole second of the window. The shape, not the mean. */
function perSecond(samples: Sample[]): string {
  const t0 = samples[0].t;
  const buckets: number[] = [];
  for (const s of samples) {
    const k = Math.floor((s.t - t0) / 1000);
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  return buckets.map((n) => String(n ?? 0)).join(' ');
}

function trace(samples: Sample[]): string[] {
  const t0 = samples[0].t;
  const out: string[] = [];
  let prev = NaN;
  for (const s of samples) {
    if (s.scale === prev) continue;
    prev = s.scale;
    out.push(`t=${((s.t - t0) / 1000).toFixed(2)}s scale=${s.scale.toFixed(2)} buf=${s.bw}x${s.bh}`);
  }
  return out;
}

/**
 * Installed in the page: records the renderer's real per-frame state.
 *
 * It reads `drawingBufferWidth/Height` off the live GL context rather than
 * recomputing it from the scale, because the whole question is what the GPU is
 * actually being asked to fill.
 */
const RECORDER_SRC = `
(() => {
  let samples = [];
  let gpuMs = [];
  let running = false;
  let last = 0;
  let tag = '';

  // GPU-side timing, via EXT_disjoint_timer_query_webgl2, wrapped around the
  // whole of Renderer.render.
  //
  // This is here because wall-clock frame time on this machine is not a
  // measurement of the renderer — it is a measurement of whatever else the
  // machine happens to be doing, and the first ablation sweep run here came
  // back with "shadows off" SLOWER than "shadows on", which is not a result,
  // it is contention. GPU time is scheduled on a different processor from the
  // contention and survives it.
  const g0 = window.__game;
  const gl = g0.renderer.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const proto = Object.getPrototypeOf(g0.renderer);
  if (ext && !proto.__origRender) {
    proto.__origRender = proto.render;
    let inflight = null;
    proto.render = function (...a) {
      let q = null;
      if (running && !inflight) {
        q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      }
      proto.__origRender.apply(this, a);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); inflight = q; }
      if (inflight && gl.getQueryParameter(inflight, gl.QUERY_RESULT_AVAILABLE)) {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (!disjoint) gpuMs.push([tag, gl.getQueryParameter(inflight, gl.QUERY_RESULT) / 1e6]);
        gl.deleteQuery(inflight);
        inflight = null;
      }
    };
  }

  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    const g = window.__game;
    if (!g || !g.renderer) { last = now; return; }
    const ctx = g.renderer.renderer.getContext();
    samples.push({
      t: now,
      dt: now - last,
      scale: g.renderer.resolutionScale,
      bw: ctx.drawingBufferWidth,
      bh: ctx.drawingBufferHeight,
      calls: g.renderer.drawCalls,
      tris: g.renderer.triangleCount,
    });
    last = now;
  }
  window.__perf = {
    start() { samples = []; gpuMs = []; running = true; last = performance.now(); requestAnimationFrame(loop); },
    stop() { running = false; return { samples, gpuMs }; },
    setTag(t) { tag = t; },
    read() { return gpuMs; },
  };
})();
`;

async function gpuInfo(page: Page): Promise<string> {
  return await page.evaluate(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const timer = !!(gl.getExtension('EXT_disjoint_timer_query_webgl2') || gl.getExtension('EXT_disjoint_timer_query'));
    return r + '  |  gpu timer queries: ' + timer + '  |  dpr ' + devicePixelRatio;
  })()`) as string;
}

async function runOnce(page: Page, url: string, id: string, tweak?: string): Promise<Stats> {
  await page.goto(`${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7${WET_QUERY}`, {
    waitUntil: 'load', timeout: 180_000,
  });
  await page.waitForFunction(
    "!!window.__game && window.__game.screen === 'racing'",
    { timeout: 300_000, polling: 250 },
  );
  if (CAMERA) await page.evaluate(`window.__game.renderer.director.setMode(${JSON.stringify(CAMERA)})`);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  if (tweak) await page.evaluate(tweak);
  await page.evaluate(RECORDER_SRC);
  await page.evaluate('window.__perf.start()');
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const res = await page.evaluate('window.__perf.stop()') as { samples: Sample[]; gpuMs: [string, number][] };
  const samples = res.samples;
  const css = await page.evaluate(`(() => {
    const c = document.querySelector('canvas');
    return { w: c.clientWidth, h: c.clientHeight, dpr: window.devicePixelRatio };
  })()`) as { w: number; h: number; dpr: number };
  if (samples.length < 10) throw new Error(`${id}: only ${samples.length} frames sampled`);
  const out = summarise(samples.slice(2), css);
  const g = res.gpuMs.map((x) => x[1]);
  out.gpuFrames = g.length;
  out.gpuMedianMs = pct(g, 0.5);
  out.gpuP90Ms = pct(g, 0.9);
  return out;
}

function row(label: string, s: Stats): string {
  return [
    label.padEnd(16),
    `gpu ${s.gpuMedianMs.toFixed(2).padStart(6)}ms (p90 ${s.gpuP90Ms.toFixed(2).padStart(6)}ms, n=${String(s.gpuFrames).padStart(4)})`,
    `${s.meanFps.toFixed(1).padStart(5)}fps`,
    `cpu+gpu med ${s.medianFrameMs.toFixed(1).padStart(5)}ms`,
    `scale ${s.scaleFirst.toFixed(2)}->${s.scaleLast.toFixed(2)}(min ${s.scaleMin.toFixed(2)})`,
    `buf ${s.bufferLast.padStart(9)} of ${s.cssSize}@${s.dpr}`,
    `px ${(s.pixelsFraction * 100).toFixed(0)}%`,
    `calls ${s.callsMean.toFixed(0)}`,
    `tris ${(s.trisMean / 1000).toFixed(0)}k`,
  ].join('  ');
}

/**
 * Paired A/B factors, toggled INSIDE one running session.
 *
 * The first attempt at this was a list of one-shot ablations, each in its own
 * page load, compared against a single baseline. On this machine that produced
 * "shadows off is 2x slower than shadows on" and a baseline that measured
 * 32ms at the start of the sweep and 63ms at the end. The machine was running
 * a 3D game and a browser of its own alongside; the sweep was measuring the
 * contention, not the renderer.
 *
 * So each factor is toggled back and forth every `PHASE_MS` for many cycles
 * within one session, and the two states are compared cycle by cycle. Drift
 * that affects both arms equally — which is what contention does — cancels.
 * Anything left is the factor.
 *
 * Every toggle here is reversible and free of shader recompilation, which is
 * why shadows are toggled through `shadowMap.autoUpdate` (skip re-rendering the
 * cascade) rather than `shadowMap.enabled` (recompile every material in the
 * scene, twice a second, forever).
 */
const PASS = (i: number, on: boolean): string =>
  `(() => { const c = window.__game.renderer.post.composer; if (c) c.passes[${i}].enabled = ${on}; })()`;

const BLOOM_AT = (f: number): string =>
  `(() => { const r = window.__game.renderer; const c = r.renderer.getContext();
     r.post.bloom.setSize(c.drawingBufferWidth * ${f}, c.drawingBufferHeight * ${f}); })()`;

const SET_SCALE = (v: number): string =>
  `(() => { const r = window.__game.renderer; r.resolutionScale = ${v}; r.resize(); })()`;

interface Factor { name: string; a: string; b: string; aLabel: string; bLabel: string }

const FACTORS: Record<string, Factor> = {
  res: {
    name: 'render resolution',
    aLabel: 'scale 1.00', a: SET_SCALE(1),
    bLabel: 'scale 0.50', b: SET_SCALE(0.5),
  },
  res75: {
    name: 'render resolution',
    aLabel: 'scale 1.00', a: SET_SCALE(1),
    bLabel: 'scale 0.75', b: SET_SCALE(0.75),
  },
  // Pass order is RenderPass, bloom, grade, OutputPass. See `PostFX`.
  bloom: {
    name: 'bloom pyramid',
    aLabel: 'bloom on', a: PASS(1, true),
    bLabel: 'bloom off', b: PASS(1, false),
  },
  grade: {
    name: 'grade + AO pass',
    aLabel: 'grade on', a: PASS(2, true),
    bLabel: 'grade off', b: PASS(2, false),
  },
  output: {
    name: 'tone map / sRGB pass',
    aLabel: 'output on', a: PASS(3, true),
    bLabel: 'output off', b: PASS(3, false),
  },
  bloomres: {
    name: 'bloom chain resolution',
    aLabel: 'bloom @1/2', a: BLOOM_AT(0.5),
    bLabel: 'bloom @1/4', b: BLOOM_AT(0.25),
  },
  post: {
    name: 'whole post chain',
    aLabel: 'post on', a: '(() => { const p = window.__game.renderer.post; p.__saved = p.__saved || p.composer; p.composer = p.__saved; })()',
    bLabel: 'post off', b: '(() => { const p = window.__game.renderer.post; p.__saved = p.__saved || p.composer; p.composer = null; })()',
  },
  shadow: {
    name: 'shadow map re-render',
    aLabel: 'shadows live', a: '(() => { const r = window.__game.renderer.renderer; r.shadowMap.autoUpdate = true; })()',
    bLabel: 'shadows frozen', b: '(() => { const r = window.__game.renderer.renderer; r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false; })()',
  },
};

/**
 * `PERF_WET=0.95` soaks the circuit before measuring.
 *
 * Rain is the most expensive weather this renderer draws — spray from
 * twenty-two cars, a rain volume, and a road that has stopped being matte —
 * and it is stochastic, so measuring it by waiting for a seed to rain measures
 * the seed. The deep link forces it; see `?wet=` in `main.ts`.
 */
const WET_QUERY = process.env.PERF_WET ? `&wet=${Number(process.env.PERF_WET)}` : '';

const PHASE_MS = Number(process.env.PERF_PHASE ?? 1500);
const CYCLES = Number(process.env.PERF_CYCLES ?? 12);

/** Median of the paired per-cycle differences: robust, and drift-free. */
function median(a: number[]): number { return pct(a, 0.5); }

async function pairedRun(page: Page, url: string, id: string, f: Factor): Promise<string> {
  await page.goto(`${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7${WET_QUERY}`, {
    waitUntil: 'load', timeout: 180_000,
  });
  await page.waitForFunction(
    "!!window.__game && window.__game.screen === 'racing'",
    { timeout: 300_000, polling: 250 },
  );
  // Freeze the scaler for the whole run: it would otherwise chase every toggle
  // and change the resolution underneath the factor being measured.
  await page.evaluate("(() => { const r = window.__game.renderer; Object.getPrototypeOf(r).updateResolutionScale = function () {}; })()");
  if (CAMERA) await page.evaluate(`window.__game.renderer.director.setMode(${JSON.stringify(CAMERA)})`);
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  await page.evaluate(RECORDER_SRC);
  await page.evaluate('window.__perf.start()');

  const aByCycle: number[][] = [];
  const bByCycle: number[][] = [];
  for (let c = 0; c < CYCLES; c++) {
    for (const [arm, js, store] of [['a', f.a, aByCycle], ['b', f.b, bByCycle]] as const) {
      await page.evaluate(js);
      // The toggle itself can cost a frame (a resize reallocates targets), so
      // the first 250ms of each phase is thrown away.
      await page.evaluate(`window.__perf.setTag('warm')`);
      await new Promise((r) => setTimeout(r, 250));
      await page.evaluate(`window.__perf.setTag('${arm}${c}')`);
      await new Promise((r) => setTimeout(r, PHASE_MS));
      store.push([]);
    }
  }
  const raw = await page.evaluate('window.__perf.stop()') as { gpuMs: [string, number][] };
  const byTag = new Map<string, number[]>();
  for (const [t, ms] of raw.gpuMs) {
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t)!.push(ms);
  }
  const diffs: number[] = [];
  const aAll: number[] = [];
  const bAll: number[] = [];
  for (let c = 0; c < CYCLES; c++) {
    const A = byTag.get('a' + c) ?? [];
    const B = byTag.get('b' + c) ?? [];
    if (A.length < 3 || B.length < 3) continue;
    aAll.push(...A);
    bAll.push(...B);
    diffs.push(median(A) - median(B));
  }
  if (diffs.length === 0) return `${id}: no usable cycles`;
  const d = median(diffs);
  return [
    id.padEnd(13),
    f.name.padEnd(22),
    `${f.aLabel} ${median(aAll).toFixed(2).padStart(6)}ms`,
    `${f.bLabel} ${median(bAll).toFixed(2).padStart(6)}ms`,
    `paired delta ${d >= 0 ? '+' : ''}${d.toFixed(2)}ms`,
    `(${diffs.length} cycles, spread ${pct(diffs, 0.1).toFixed(2)}..${pct(diffs, 0.9).toFixed(2)})`,
  ].join('  ');
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // A PRODUCTION build, served by `vite preview`, not the dev server.
  //
  // The dev server ships every module unbundled and un-minified and compiles
  // some of them on demand, which puts multi-hundred-millisecond stalls into
  // the first seconds of a session. Those stalls are real, but they are the dev
  // server's, not the game's, and they land exactly where the resolution
  // scaler is making its decision — so measuring against dev would blame the
  // renderer for vite.
  if (process.env.PERF_SKIP_BUILD !== '1') {
    console.log('building...');
    await build({ logLevel: 'warn' });
  }
  const server: PreviewServer = await preview({
    preview: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  const addr = server.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  // HEADFUL, and no swiftshader flags. A headless/software run would measure a
  // machine nobody plays on. The window has to stay un-throttled or every
  // number here is a measurement of Chrome's background throttler.
  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 20 * 60_000,
    defaultViewport: null,
    args: [
      '--window-size=1600,1000',
      '--window-position=0,0',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });

  const page: Page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  await page.bringToFront();

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  // Chrome asks every document for `/favicon.ico` whether one is referenced or
  // not, and this probe has no icon to give it — so a clean run reported a page
  // error every time. Matched on the failing URL rather than the message: the
  // text is the same for a missing icon and a missing module, so only the URL
  // separates browser noise from the thing worth failing on.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/\/favicon\.ico(\?|$)/.test(m.location().url ?? '')) return;
    errors.push(`console: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  console.log('GPU: ' + await gpuInfo(page));
  console.log(`sampling ${SECONDS}s per run after ${WARMUP_MS}ms warmup` + (CAMERA ? `, camera=${CAMERA}` : ''));
  console.log('');

  const out: Record<string, Stats> = {};

  if (PAIR) {
    const names = PAIR.split(',').map((x) => x.trim()).filter(Boolean);
    console.log(`paired A/B: ${CYCLES} cycles x ${PHASE_MS}ms per arm\n`);
    for (const id of CIRCUIT_IDS) {
      for (const n of names) {
        const f = FACTORS[n];
        if (!f) throw new Error(`unknown factor ${n}; have ${Object.keys(FACTORS).join(',')}`);
        console.log(await pairedRun(page, url, id, f));
      }
    }
  } else {
    for (const id of CIRCUIT_IDS) {
      const s = await runOnce(page, url, id);
      out[id] = s;
      console.log(row(id, s));
      if (process.env.PERF_TRACE === '1') {
        for (const l of s.scaleTrace) console.log('    ' + l);
        console.log('    fps/s: ' + s.perSecond);
      }
    }
  }

  if (!PAIR) {
    await writeFile(resolve(OUT_DIR, 'perf.json'), JSON.stringify(out, null, 2), 'utf8');
  }
  await browser.close();
  await server.close();

  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of new Set(errors)) console.log('  ' + e);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
