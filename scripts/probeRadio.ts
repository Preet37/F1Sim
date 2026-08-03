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
 *   SILENT     that with the voice switched OFF — which is the default, and is
 *              therefore what nearly every player has — the event stream still
 *              runs and the radio card still types. The event stream and the
 *              audio switch are two different things and this is what says so.
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
 *              still calibrated — three utterances a line, median taken, every
 *              sample printed, because a single sample of a short line measures
 *              the speech service's mood rather than the constant.
 *   VOICES     that ONE MALE voice is chosen, that it is the same one every
 *              time, and that it came off the preference list rather than off
 *              the front of whatever `getVoices()` happened to return.
 *   API        the event contract the HUD types against — including the ONE
 *              CLAIM the whole design rests on, that `speech` is emitted on the
 *              first `boundary` and not on `onstart`; the interrupt path, which
 *              must wait for the key-up tail before keying down again; and
 *              `speakExchange`, which is what the HUD calls for every card.
 *
 *   npm run probe:radio
 *   RADIO_HEADFUL=1 npm run probe:radio     watch it, and hear it
 *   RADIO_ALLOW_NO_VOICES=1 …               accept a run on a machine with no
 *                                           system voices. Without it, no
 *                                           voices is a FAILURE — see below.
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
  page.on('pageerror', (e) => pageErrors.push((e as Error).message));
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

  // --------------------------------------------------------- THE SILENT PATH
  // FIRST, because it is the shipped default and because it needs no voices.
  // The radio ships OFF. If the event stream were gated on the audio switch —
  // and it was, `speak()` returned null when disabled — the radio card would
  // never appear for the overwhelming majority of players, and every check
  // below this one would still be green because they all turn the voice on.
  console.log('\nSILENT — the card with the voice switched off, which is the default');
  const silent = await page.evaluate(() => window.RADIO_PROBE.exerciseSilent());
  const silentWords = silent.events.filter((e) => e.type === 'word');
  const silentEnds = silent.events.filter((e) => e.type === 'end');
  check(silent.exchangeIds.length === 2, 'exchange accepted with the voice off',
    `${silent.exchangeIds.length} of 2 turns queued`);
  check(silent.events.some((e) => e.type === 'open'), 'open still emitted',
    `${silent.events.filter((e) => e.type === 'open').length} transmissions opened`);
  check(silentWords.length > 0, 'typewriter still has a clock',
    `${silentWords.length} word events, all from the estimated schedule`);
  check(silentWords.every((e) => e.est === true), 'and they are the estimated ones',
    `${silentWords.filter((e) => e.est).length} of ${silentWords.length} estimated`);
  check(silentEnds.length === 2, 'and every turn ends',
    `${silentEnds.length} of 2 ended, reasons: ${silentEnds.map((e) => e.reason).join(', ')}`);
  if (silent.exchangeIds.length === 2) {
    const firstEnd = silent.events.find(
      (e) => e.id === silent.exchangeIds[0] && e.type === 'end');
    const secondOpen = silent.events.find(
      (e) => e.id === silent.exchangeIds[1] && e.type === 'open');
    const span = silent.events.filter((e) => e.type === 'end').at(-1)?.atMs ?? 0;
    console.log(`        the whole exchange took ${span} ms of card time`);
    if (firstEnd && secondOpen) {
      console.log(`        turn 2 keyed down ${secondOpen.atMs - firstEnd.atMs} ms after turn 1 ended`);
    }
  }

  // ------------------------------------------------------------------ SPEECH
  console.log('\nSPEECH — the clock the HUD types to');
  const voiceCount = await page.evaluate(() => window.RADIO_PROBE.waitForVoices());
  console.log(`        ${voiceCount} voices after waiting for enumeration`);

  if (voiceCount === 0) {
    // NOT A QUIET SKIP. This used to `continue` past the entire SPEECH, VOICES
    // and API section and then print "radio: all checks passed" — a green run
    // that had measured nothing about the half of this feature that involves a
    // voice. A probe that reports success for work it did not do is worse than
    // no probe, so the absence of voices is now a FAILURE unless the operator
    // says otherwise, and says so on the command line where it is visible.
    const allowed = !!process.env.RADIO_ALLOW_NO_VOICES;
    check(allowed, 'a voice to measure',
      allowed
        ? 'none on this machine; RADIO_ALLOW_NO_VOICES is set, so the SPEECH, '
          + 'VOICES and API sections below were NOT RUN'
        : 'this browser reports no voices at all, so the boundary clock, the '
          + 'voice assignment and the whole event contract went UNMEASURED. '
          + 'Run on a machine with system voices, or set RADIO_ALLOW_NO_VOICES=1 '
          + 'to accept an unmeasured run.');
    if (allowed) notes.push('SPEECH / VOICES / API were skipped: no voices on this machine');
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

    // EACH LINE THREE TIMES, AND THE MEDIAN.
    //
    // NOT A LOOSENED TOLERANCE — the bar below is still 25%,
    // `SPEECH_CHARS_PER_SEC` is untouched, and the number this produces is
    // LOWER than the single-sample one, not higher. It is a better measurement
    // of the same quantity, and taking it showed what the noise actually was.
    //
    // Single-sample runs of "Understood" measured 427, 630 and 735 ms on an
    // idle machine — +-25% against a 25% bar, so the check flapped red on a
    // healthy tree. Three samples in a row measure 606 / 609 / 615. The spread
    // was never in the estimator and never in the speech rate: it is the FIRST
    // utterance after the synthesiser has been idle, the same cold start that
    // makes `onstart` lead the first word by 1.9 s once and 105 ms thereafter,
    // and which `BOUNDARY_GRACE_UNKNOWN_MS` already exists to survive. One
    // sample of a ten-character line is mostly that overhead; the median of
    // three outvotes it.
    //
    // Every sample is printed, so the spread stays visible rather than being
    // collapsed into a number that looks more certain than it is. A check that
    // goes red on four runs in ten of a healthy tree teaches people to ignore
    // it, which is the same damage as a check that cannot go red at all.
    const REPEATS = 3;
    for (const text of lines) {
      const samples: SpeechTiming[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const t: SpeechTiming = await page.evaluate(
          (x) => window.RADIO_PROBE.measureSpeechTiming(x, 1.08), text,
        );
        if (t.ok) samples.push(t);
      }
      if (!samples.length) {
        notes.push(`speech did not complete for "${text.slice(0, 24)}..."`);
        continue;
      }
      for (const t of samples) {
        boundaries += t.boundaryCount;
        const lead = t.firstBoundaryMs - t.onstartMs;
        if (t.boundaryCount > 0 && lead > leadSeen) leadSeen = lead;
      }
      const spans = samples.map((t) => t.measuredMs).sort((a, b) => a - b);
      const median = spans[Math.floor(spans.length / 2)];
      const estimate = samples[0].estimateMs;
      const err = Math.abs(estimate - median) / Math.max(median, 1);
      if (err > worstErr) worstErr = err;
      const first = samples[0];
      console.log(`        "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`);
      console.log(`          onstart ${first.onstartMs}, first word ${first.firstBoundaryMs}, `
        + `end ${first.onendMs}, ${first.boundaryCount} words`);
      console.log(`          spoken ${spans.join(' / ')} ms (median ${median}), `
        + `estimated ${Math.round(estimate)} ms (${(err * 100).toFixed(1)}% off the median)`);
    }

    check(boundaries > 0, 'boundary events fire', `${boundaries} word events across ${lines.length} lines`);
    // NOT A CHECK. This was `check(true, 'onstart leads the first word by', ...)`
    // — a hardcoded pass that printed a four-figure number and could not go red
    // on any value of it, including zero. It is a MEASUREMENT, so it is printed
    // as one. What is actually asserted about it is in the API section below:
    // that `speech` is emitted on the first boundary rather than on `onstart`,
    // which is the thing this number makes matter.
    if (leadSeen >= 0) {
      console.log(`        onstart leads the first audible word by up to ${leadSeen} ms`);
      if (leadSeen > 250) {
        console.log('        A typewriter started on onstart would run that far ahead of '
          + 'the voice; TeamRadio emits `speech` on the first boundary for this reason, '
          + 'and the API section asserts that it still does.');
      }
    }
    check(worstErr < 0.25, 'fallback clock still calibrated',
      `worst line ${(worstErr * 100).toFixed(1)}% off`);

    // ---------------------------------------------------------------- VOICES
    //
    // ONE VOICE, AND MALE. Reported by the player, in those words, after
    // hearing four different people — two of them women — in one garage:
    //
    //   "we also need one voice and use the male one not the female one i
    //    don't like that one."
    //
    // This section used to assert the opposite: `distinct >= 3`, "speakers are
    // distinguishable", which the old per-speaker preference lists passed by
    // producing exactly the thing that was then complained about. The check is
    // now inverted, and the reason it is worth writing down is that the old one
    // was not wrong on its own terms — it was measuring a decision nobody had
    // checked with the person who has to listen to it.
    console.log('\nVOICES — one voice, and it has to be the male one');
    const vr = await page.evaluate(() => window.RADIO_PROBE.voiceReport());
    const who = await page.evaluate(() => window.RADIO_PROBE.describeVoices());
    console.log(`        chosen:     ${vr.name} ${vr.lang} `
      + `(certainty: ${vr.certainty}, from ${vr.candidates} voices)`);
    for (const [speaker, desc] of Object.entries(who)) {
      console.log(`        ${speaker.padEnd(10)} ${desc}`);
    }
    const names = Object.values(who).map((d) => d.split(' [')[0]);
    const distinct = new Set(names).size;
    check(distinct === 1, 'every speaker uses the same voice',
      `${distinct} distinct voice(s) across 4 speakers: ${[...new Set(names)].join(', ')}`);
    // The four are still four people, and with one voice the ONLY thing left
    // making them four is rate and pitch — so those must actually differ.
    const rates = new Set(Object.values(who).map((d) => d.slice(d.indexOf('rate='))));
    check(rates.size === 4, 'and is separated by rate and pitch',
      `${rates.size} distinct rate/pitch pairs of 4 speakers`);

    // The voice must not be one we know to be female. `certainty` says how the
    // choice was arrived at, and only 'male' means it came off the preference
    // list; 'unknown' is an unrecognised voice on an unrecognised platform and
    // is reported rather than hidden, because claiming it is male would be a
    // claim about something never measured.
    const female = /\b(samantha|victoria|karen|moira|tessa|fiona|serena|kate|allison|ava|susan|zoe|nicky|veena|isha|shelley|flo|martha|matilda|nathalie|nora|zira|hazel|eva|linda|heera|catherine)\b/i;
    check(!female.test(String(vr.name)), 'and it is not a known female voice',
      `${vr.name}, certainty '${vr.certainty}'`);
    check(vr.certainty === 'male', 'and it came off the male preference list',
      vr.certainty === 'male'
        ? `${vr.name} is on MALE_VOICES`
        : `certainty is '${vr.certainty}' — MALE_VOICES matched nothing among the `
          + `${vr.candidates} voices this platform offers, so THE RADIO IS SILENT `
          + 'even with the setting on. That is deliberate: a voice picked because '
          + 'it happened to be first is how a female voice gets in, and the player '
          + "has asked twice for it not to. Add this platform's male voice to "
          + 'MALE_VOICES.');
    // A voice that changes between transmissions is a worse fault than any
    // particular voice. Four resolutions, two instances, one answer.
    check(vr.stable === true, 'and it is the same voice every time',
      (vr.resolutions as string[]).join(' / '));

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

    // ------------------------------------------- THE CLAIM THE DESIGN RESTS ON
    //
    // "emit `speech` on the first `boundary`, never on `onstart`". Everything
    // in `TeamRadio` is arranged around that one sentence and NOTHING TESTED
    // IT: the ordering checks above pass either way, because `onstart` precedes
    // the first word too, and the only other mention of it was a `check(true,
    // ...)` that printed a number it could not fail on.
    //
    // `speech` and the first real `word` are emitted from the same synchronous
    // block inside `markSpeechStarted`/`onboundary`, so their timestamps must
    // be a task apart at most. `onstart` fires roughly a second earlier — this
    // run measured it at the number printed in the SPEECH section above — so
    // moving `markSpeechStarted` into `onstart` puts three figures between
    // them and this goes red naming the gap.
    const SAME_TASK_MS = 50;
    let worstGap = -1;
    let checked = 0;
    let missing = 0;
    for (const id of [...ex.spokenIds, ...ex.exchangeIds]) {
      const mine = evs.filter((e) => e.id === id);
      const speech = mine.find((e) => e.type === 'speech');
      const firstReal = mine.find((e) => e.type === 'word' && e.est === false);
      // A transmission whose words all came from the fallback clock says
      // nothing about the boundary path and is not evidence either way.
      if (!speech || !firstReal) { missing++; continue; }
      checked++;
      const gap = firstReal.atMs - speech.atMs;
      if (gap > worstGap) worstGap = gap;
    }
    if (checked === 0) {
      check(false, 'speech lands on the first boundary',
        `no transmission produced a real boundary word (${missing} ran on the `
        + 'estimated clock), so the claim this whole class is built on went '
        + 'unmeasured. This is the boundary-less-platform path; it is a valid '
        + 'state for the CODE and not a valid state for the PROBE.');
    } else {
      check(worstGap >= 0 && worstGap < SAME_TASK_MS,
        'speech lands on the first boundary',
        `worst gap between \`speech\` and the first real word: ${worstGap} ms `
        + `across ${checked} transmission(s), bar ${SAME_TASK_MS} ms. `
        + `\`onstart\` is ${leadSeen} ms earlier than that word.`);
    }

    // ------------------------------------------------------------- INTERRUPT
    //
    // Never exercised before this. Two things are being asserted: that a
    // higher-priority call really does cut the engineer off, and that it does
    // not key down on top of his key-up.
    //
    // `RadioChain.open` begins with `cancelScheduledValues(at)`, which deletes
    // every ramp at or after `at` — including the swell `close()` scheduled
    // microseconds earlier if the two land on the same context time. That swell
    // is the "kssht", which is the single most diagnostic sound in the whole
    // effect. `TeamRadio.finish` arms a guard for exactly this and the
    // interrupt path used to run straight past it.
    const cEnd = evs.find((e) => e.id === ex.interruptedId && e.type === 'end');
    const dOpen = evs.find((e) => e.id === ex.interrupterId && e.type === 'open');
    check(ex.interrupterId !== null && cEnd?.reason === 'cancelled',
      'urgent call cuts the engineer off', `interrupted transmission ended '${cEnd?.reason}'`);
    if (cEnd && dOpen) {
      const gap = dOpen.atMs - cEnd.atMs;
      check(gap >= constants.SQUELCH_CLOSE_MS,
        'and waits for the key-up tail',
        `${gap} ms between the interrupted end and the interrupter's key-down, `
        + `against a ${constants.SQUELCH_CLOSE_MS} ms squelch tail`);
    } else {
      check(false, 'and waits for the key-up tail', 'the interrupt never happened');
    }

    // -------------------------------------------------------------- EXCHANGE
    //
    // `speakExchange` is what the HUD calls for every card, and it was dead
    // code with no caller and no test.
    const exOpens = ex.exchangeIds.map((id) => evs.find((e) => e.id === id && e.type === 'open'));
    const exEnds = ex.exchangeIds.map((id) => evs.find((e) => e.id === id && e.type === 'end'));
    check(ex.exchangeIds.length === 2, 'exchange queued as two transmissions',
      `${ex.exchangeIds.length} turns`);
    check(exEnds.every((e) => e !== undefined), 'both turns of the exchange ran',
      `${exEnds.filter(Boolean).length} of ${ex.exchangeIds.length} ended`);
    if (exEnds[0] && exOpens[1]) {
      const gap = exOpens[1].atMs - exEnds[0].atMs;
      check(gap >= constants.SQUELCH_CLOSE_MS, 'and the turns do not run together',
        `${gap} ms between one speaker finishing and the next keying down`);
    }

    // ------------------------------------------------- THE DRIVER'S OWN HALF
    //
    //   "i just atp wouldn't say anything for the audio if its a conversation
    //    because you don't need to be saying what the driver says ykwim?"
    //
    // The driver is the player, so his replies are never said out loud. But
    // they are still TRANSMISSIONS: the card types them at the pace they would
    // have been spoken at, because an exchange that flicks instantly through
    // one side of itself reads as a fault. So the check is not "no events" —
    // it is that the words arrived and every one of them came from the
    // estimated clock rather than from a synthesiser.
    if (ex.exchangeIds.length === 2) {
      const wallWords = evs.filter((e) => e.id === ex.exchangeIds[0] && e.type === 'word');
      const drvWords = evs.filter((e) => e.id === ex.exchangeIds[1] && e.type === 'word');
      const drvOpen = evs.find((e) => e.id === ex.exchangeIds[1] && e.type === 'open');
      const drvEnd = evs.find((e) => e.id === ex.exchangeIds[1] && e.type === 'end');
      check(drvWords.length > 0 && drvWords.every((e) => e.est === true),
        "the driver's half is typed but not spoken",
        `${drvWords.length} word events, ${drvWords.filter((e) => e.est).length} estimated`);
      check(wallWords.some((e) => e.est === false), "and the wall's half still is",
        `${wallWords.filter((e) => e.est === false).length} of ${wallWords.length} `
        + 'words from real boundaries');
      if (drvOpen && drvEnd) {
        // "Understood, box this lap." at the driver's rate is about 1.3 s of
        // speech; anything near zero means the reply was skipped rather than
        // paced, which is the failure this whole flag exists to avoid.
        const span = drvEnd.atMs - drvOpen.atMs;
        check(span > 600, 'and it takes as long as saying it would',
          `${span} ms from key-down to end for a ${'Understood, box this lap.'.length}-character reply`);
      }
    }
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
