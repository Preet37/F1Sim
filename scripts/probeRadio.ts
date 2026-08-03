import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

/**
 * Measures the team radio instead of judging it by ear.
 *
 * There is precedent for needing this. The engine timbre work in
 * `src/audio/AudioEngine.ts` carried a comment claiming the phase scatter
 * lowered crest factor; measuring it showed the opposite (1.79 to 2.16), and
 * the comment now says so. Audio is the easiest part of a codebase to be
 * confidently wrong about, because the only feedback is an opinion formed
 * through whatever laptop speaker happened to be nearby.
 *
 * So this renders the real `RadioChain` through the real WebAudio in real
 * Chrome — see `audit/radio.ts` for why not a Node reimplementation — and
 * asserts:
 *
 *   PLATFORM   that synthesised speech still cannot be routed into WebAudio.
 *              The entire design is built around that being true and it should
 *              fail loudly the day it stops being true, rather than staying
 *              pessimistic forever out of habit.
 *   BAND       that the measured -3 dB points are at 300 Hz and 3.4 kHz, not
 *              merely that filters with those numbers written on them exist.
 *              Six cascaded sections put the real edge 40% away from the
 *              nominal corner, which is the kind of thing that survives review
 *              precisely because the constants look right.
 *   LEVELS     peak, RMS and crest, and that nothing clips.
 *   SQUELCH    that there are two bursts, that the key-up one is the louder,
 *              and that the bed between them sits well under both. This is the
 *              detail the whole effect rests on.
 *   DROPOUT    that a poor link actually produces silence, and how much.
 *   SPEECH     that boundary events exist, how far `onstart` leads the first
 *              audible word, and whether the fallback clock's estimator is
 *              still calibrated.
 *   VOICES     that the four speakers resolve to distinct, non-novelty voices.
 *
 *   npm run probe:radio
 *   RADIO_HEADFUL=1 npm run probe:radio     watch it, and hear it
 */

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

interface ResponsePoint { hz: number; db: number; }
interface TransmissionMeasurement {
  envelope: number[]; peak: number; rms: number; crest: number;
  envelopeHz: number; openAtMs: number; closeAtMs: number; totalMs: number;
}
interface SpeechTiming {
  ok: boolean; reason: string; onstartMs: number; firstBoundaryMs: number;
  lastBoundaryMs: number; onendMs: number; boundaryCount: number;
  estimateMs: number; measuredMs: number;
}

const failures: string[] = [];
const notes: string[] = [];

function check(ok: boolean, label: string, detail: string): void {
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
}

/** Linear interpolation to find where a response curve crosses `targetDb`. */
function crossing(points: ResponsePoint[], targetDb: number, rising: boolean): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const crossed = rising
      ? a.db < targetDb && b.db >= targetDb
      : a.db >= targetDb && b.db < targetDb;
    if (!crossed) continue;
    const t = (targetDb - a.db) / (b.db - a.db);
    // Interpolate in log frequency; the curve is a filter skirt, not a line.
    return Math.exp(Math.log(a.hz) + t * (Math.log(b.hz) - Math.log(a.hz)));
  }
  return NaN;
}

function dbAt(points: ResponsePoint[], hz: number): number {
  let best = points[0];
  for (const p of points) if (Math.abs(Math.log(p.hz / hz)) < Math.abs(Math.log(best.hz / hz))) best = p;
  return best.db;
}

/** Highest envelope value in a window, and where it was, ms. */
function peakIn(env: number[], fromMs: number, toMs: number): { v: number; at: number } {
  let v = 0;
  let at = fromMs;
  for (let i = Math.max(0, Math.floor(fromMs)); i < Math.min(env.length, Math.ceil(toMs)); i++) {
    if (env[i] > v) { v = env[i]; at = i; }
  }
  return { v, at };
}

function meanIn(env: number[], fromMs: number, toMs: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, Math.floor(fromMs)); i < Math.min(env.length, Math.ceil(toMs)); i++) {
    s += env[i];
    n++;
  }
  return n ? s / n : 0;
}

/** Longest run, ms, where the envelope stays under `level`. */
function longestQuietRun(env: number[], fromMs: number, toMs: number, level: number): number {
  let best = 0;
  let run = 0;
  for (let i = Math.max(0, Math.floor(fromMs)); i < Math.min(env.length, Math.ceil(toMs)); i++) {
    if (env[i] < level) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}

async function main(): Promise<void> {
  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/audit/radio.html`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: process.env.RADIO_HEADFUL ? false : 'shell',
    protocolTimeout: 5 * 60_000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const page: Page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.RADIO_PROBE !== undefined', { timeout: 30_000 });

  if (pageErrors.length) {
    console.error('page errors:\n  ' + pageErrors.join('\n  '));
    process.exitCode = 1;
    await browser.close();
    await server.close();
    return;
  }

  const constants = await page.evaluate(() => window.RADIO_PROBE.CONSTANTS);

  // ---------------------------------------------------------------- PLATFORM
  console.log('\nPLATFORM — what the browser will and will not let us do');
  const api = await page.evaluate(() => window.RADIO_PROBE.probeSpeechApi());
  const routing = api.routingHooks as string[];
  check(api.supported === true, 'speechSynthesis present', String(api.supported));
  check(
    routing.length === 0,
    'no speech->WebAudio routing',
    routing.length === 0
      ? 'confirmed: utterance exposes no stream, node, sink or destination'
      : `FOUND ${routing.join(', ')} — GOOD NEWS. The voice can now be processed; `
        + 'RadioChain should be rebuilt to carry it rather than to sit around it.',
  );
  check(api.hasBoundary === true, 'boundary events on utterance', String(api.hasBoundary));
  console.log(`        utterance:  ${(api.utterKeys as string[]).join(', ')}`);
  console.log(`        synthesis:  ${(api.synthKeys as string[]).join(', ')}`);

  // -------------------------------------------------------------------- BAND
  console.log('\nBAND — where the link band actually is, not where it is labelled');
  const freqs: number[] = [];
  for (let i = 0; i <= 72; i++) freqs.push(40 * Math.pow(12000 / 40, i / 72));
  const response: ResponsePoint[] = await page.evaluate(
    (f) => window.RADIO_PROBE.measureResponse(f), freqs,
  );

  const lowEdge = crossing(response, -3, true);
  const highEdge = crossing(response, -3, false);
  const lowTol = Math.abs(lowEdge - constants.BAND_LOW_HZ) / constants.BAND_LOW_HZ;
  const highTol = Math.abs(highEdge - constants.BAND_HIGH_HZ) / constants.BAND_HIGH_HZ;

  check(lowTol < 0.12, 'low edge at 300 Hz',
    `measured -3 dB at ${lowEdge.toFixed(0)} Hz (${(lowTol * 100).toFixed(1)}% off)`);
  check(highTol < 0.12, 'high edge at 3.4 kHz',
    `measured -3 dB at ${highEdge.toFixed(0)} Hz (${(highTol * 100).toFixed(1)}% off)`);

  const at100 = dbAt(response, 100);
  const at8k = dbAt(response, 8000);
  check(at100 < -24, 'stopband below the band', `${at100.toFixed(1)} dB at 100 Hz`);
  check(at8k < -24, 'stopband above the band', `${at8k.toFixed(1)} dB at 8 kHz`);

  const inBand = response.filter((p) => p.hz >= 600 && p.hz <= 2400);
  const ripple = Math.max(...inBand.map((p) => p.db)) - Math.min(...inBand.map((p) => p.db));
  check(ripple < 3, 'flat in the passband', `${ripple.toFixed(2)} dB ripple, 600 Hz - 2.4 kHz`);

  console.log('        response, dB relative to passband:');
  for (const hz of [100, 200, 300, 500, 1000, 2000, 3400, 5000, 8000]) {
    const db = dbAt(response, hz);
    const bar = '#'.repeat(Math.max(0, Math.round(40 + db / 1.6)));
    console.log(`          ${String(hz).padStart(5)} Hz  ${db.toFixed(1).padStart(7)}  ${bar}`);
  }

  // ------------------------------------------------------------- TRANSMISSION
  console.log('\nSQUELCH AND LEVELS — a clean four-second transmission');
  const tx: TransmissionMeasurement = await page.evaluate(
    () => window.RADIO_PROBE.measureTransmission(4, 1, null),
  );

  check(tx.peak <= 1, 'no clipping', `peak ${tx.peak.toFixed(3)}`);
  check(tx.peak > 0.05, 'audible at all', `peak ${tx.peak.toFixed(3)}, rms ${tx.rms.toFixed(4)}`);
  console.log(`        crest factor ${tx.crest.toFixed(2)}`);

  const open = peakIn(tx.envelope, tx.openAtMs - 5, tx.openAtMs + constants.SQUELCH_OPEN_MS + 20);
  const close = peakIn(tx.envelope, tx.closeAtMs - 5, tx.closeAtMs + constants.SQUELCH_CLOSE_MS + 20);
  const bedMean = meanIn(tx.envelope, tx.openAtMs + 400, tx.closeAtMs - 400);
  const preSilence = peakIn(tx.envelope, 0, tx.openAtMs - 5);
  const postSilence = peakIn(tx.envelope, tx.closeAtMs + constants.SQUELCH_CLOSE_MS + 40, tx.totalMs);

  check(open.v > bedMean * 2, 'key-down burst present',
    `${open.v.toFixed(3)} at ${open.at} ms vs bed ${bedMean.toFixed(4)}`);
  check(close.v > bedMean * 2, 'key-up burst present',
    `${close.v.toFixed(3)} at ${close.at} ms`);
  check(close.v > open.v, 'key-up is the louder of the two',
    `key-up ${close.v.toFixed(3)} vs key-down ${open.v.toFixed(3)} `
    + `(${(20 * Math.log10(close.v / Math.max(open.v, 1e-9))).toFixed(1)} dB)`);
  check(bedMean > 0.0005, 'noise bed audible under the voice', `mean ${bedMean.toFixed(5)}`);
  check(bedMean < open.v * 0.5, 'bed stays a bed', `bed is ${(bedMean / open.v * 100).toFixed(1)}% of key-down`);
  check(preSilence.v < 0.002, 'silent before key-down', `peak ${preSilence.v.toFixed(5)}`);
  check(postSilence.v < 0.002, 'silent after key-up', `peak ${postSilence.v.toFixed(5)}`);

  // A coarse picture of the envelope, because a number cannot show a shape.
  console.log('        envelope (50 ms per column, # = 0.05 peak):');
  let line = '        ';
  for (let ms = 0; ms < tx.totalMs; ms += 50) {
    const v = peakIn(tx.envelope, ms, ms + 50).v;
    line += v > 0.4 ? 'W' : v > 0.2 ? 'M' : v > 0.05 ? '#' : v > 0.005 ? '.' : ' ';
  }
  console.log(line + '|');

  // ----------------------------------------------------------------- DROPOUT
  console.log('\nDROPOUT — what a bad link does');
  const bad: TransmissionMeasurement = await page.evaluate(
    () => window.RADIO_PROBE.measureTransmission(4, 0.15, 1.5),
  );
  const badBed = meanIn(bad.envelope, bad.openAtMs + 400, bad.openAtMs + 1300);
  const quiet = longestQuietRun(bad.envelope, bad.openAtMs + 1400, bad.openAtMs + 2200, 0.0005);
  check(quiet >= 40, 'link actually drops out', `${quiet} ms of silence mid-transmission`);
  check(badBed > bedMean, 'poor link is noisier', `bed ${badBed.toFixed(5)} vs ${bedMean.toFixed(5)} on a good link`);

  // ------------------------------------------------------------------ SPEECH
  console.log('\nSPEECH — the clock the HUD types to');
  const voiceCount = await page.evaluate(() => window.RADIO_PROBE.waitForVoices());
  console.log(`        ${voiceCount} voices after waiting for enumeration`);

  if (voiceCount === 0) {
    notes.push('no voices on this machine; speech timing not measured');
    console.log('        skipped: this browser reports no voices at all');
  } else {
    // Several lines of different shapes, because one line calibrates a constant
    // to itself. A short instruction, a long one, and one with no punctuation
    // at all exercise the sentence-pause term independently of the length term.
    const lines = [
      'Box box. Soft on the left. Confirm you are coming in this lap.',
      'Gap to the car behind is one point two.',
      'Safety car safety car. Delta positive. Close up to the car ahead now.',
      'Understood',
    ];
    let worstErr = 0;
    let leadSeen = -1;
    let boundaries = 0;

    for (const text of lines) {
      const timing: SpeechTiming = await page.evaluate(
        (t) => window.RADIO_PROBE.measureSpeechTiming(t, 1.08), text,
      );
      if (!timing.ok) {
        notes.push(`speech did not complete for "${text.slice(0, 24)}...": ${timing.reason}`);
        continue;
      }
      boundaries += timing.boundaryCount;
      const lead = timing.firstBoundaryMs - timing.onstartMs;
      if (timing.boundaryCount > 0 && lead > leadSeen) leadSeen = lead;
      const err = Math.abs(timing.estimateMs - timing.measuredMs) / Math.max(timing.measuredMs, 1);
      if (err > worstErr) worstErr = err;
      console.log(`        "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`);
      console.log(`          onstart ${timing.onstartMs}, first word ${timing.firstBoundaryMs}, `
        + `end ${timing.onendMs}, ${timing.boundaryCount} words`);
      console.log(`          spoken ${timing.measuredMs} ms, estimated ${Math.round(timing.estimateMs)} ms `
        + `(${(err * 100).toFixed(1)}% off)`);
    }

    check(boundaries > 0, 'boundary events fire', `${boundaries} word events across ${lines.length} lines`);
    if (leadSeen >= 0) {
      check(true, 'onstart leads the first word by', `${leadSeen} ms`);
      if (leadSeen > 250) {
        console.log(`        NOTE: onstart leads the first audible word by up to ${leadSeen} ms. `
          + 'A typewriter started on onstart would run that far ahead of the voice; '
          + 'TeamRadio emits its `speech` event on the first boundary for this reason.');
      }
    }
    check(worstErr < 0.25, 'fallback clock still calibrated',
      `worst line ${(worstErr * 100).toFixed(1)}% off`);

    // ---------------------------------------------------------------- VOICES
    console.log('\nVOICES — who ends up sounding like whom');
    const who = await page.evaluate(() => window.RADIO_PROBE.describeVoices());
    for (const [speaker, desc] of Object.entries(who)) {
      console.log(`        ${speaker.padEnd(10)} ${desc}`);
    }
    const names = Object.values(who).map((d) => d.split(' [')[0]);
    const distinct = new Set(names).size;
    // On a platform with plenty of voices the speakers must not collapse onto
    // one. On a platform with one voice they necessarily do, and rate/pitch is
    // the whole differentiation — which is why this only asserts when there is
    // a choice to be made.
    if (voiceCount >= 8) {
      check(distinct >= 3, 'speakers are distinguishable', `${distinct} distinct voices of 4 speakers`);
    } else {
      notes.push(`only ${voiceCount} voices; speakers separated by rate and pitch alone`);
    }
    const denied = /\b(bells|boing|zarvox|trinoids|bubbles|cellos|jester|organ|whisper|wobble|bad news|albert|fred|ralph)\b/i;
    check(!names.some((n) => denied.test(n)), 'no novelty voices chosen', names.join(', '));

    // ------------------------------------------------------ END TO END
    console.log('\nAPI — the event contract the HUD types against');
    const ex = await page.evaluate(() => window.RADIO_PROBE.exerciseRadio());
    const evs = ex.events;

    // Per transmission: open, then speech, then words, then end, in that order.
    let ordered = true;
    let monotonic = true;
    let interleaved = false;
    let live: number | null = null;
    for (const id of ex.spokenIds) {
      const mine = evs.filter((e) => e.id === id);
      const iOpen = mine.findIndex((e) => e.type === 'open');
      const iSpeech = mine.findIndex((e) => e.type === 'speech');
      const iWord = mine.findIndex((e) => e.type === 'word');
      const iEnd = mine.findIndex((e) => e.type === 'end');
      if (iOpen !== 0) ordered = false;
      if (iSpeech >= 0 && iSpeech < iOpen) ordered = false;
      if (iWord >= 0 && iSpeech >= 0 && iWord < iSpeech) ordered = false;
      if (iEnd >= 0 && iEnd !== mine.length - 1) ordered = false;
      let last = -1;
      for (const e of mine) {
        if (e.type !== 'word') continue;
        if ((e.ci ?? 0) < last) monotonic = false;
        last = e.ci ?? 0;
      }
    }
    // Nothing from a second transmission may appear between another's open/end.
    for (const e of evs) {
      if (e.type === 'open') { if (live !== null) interleaved = true; live = e.id; }
      else if (e.type === 'end' && e.id === live) live = null;
      else if (live !== null && e.id !== live) interleaved = true;
    }

    check(ex.spokenIds.length === 2, 'both messages accepted', `${ex.spokenIds.length} of 2`);
    check(ordered, 'open -> speech -> word -> end', 'per-transmission order holds');
    check(monotonic, 'words only move forwards', 'charIndex never rewinds');
    check(!interleaved, 'transmissions never overlap', 'no event from one inside another');
    check(ex.droppedStale, 'stale message dropped unspoken',
      'a message whose lifetime expired while queued was never spoken');
    const wordCount = evs.filter((e) => e.type === 'word').length;
    const estimated = evs.filter((e) => e.type === 'word' && e.est).length;
    console.log(`        ${evs.length} events, ${wordCount} words `
      + `(${estimated} from the fallback clock, ${wordCount - estimated} from real boundaries)`);
  }

  await browser.close();
  await server.close();

  console.log('');
  for (const n of notes) console.log(`note: ${n}`);
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('radio: all checks passed');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
