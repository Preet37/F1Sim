import {
  RadioChain, BAND_LOW_HZ, BAND_HIGH_HZ, BAND_ORDER, CASCADE_EDGE_FACTOR,
  SQUELCH_OPEN_MS, SQUELCH_CLOSE_MS, SPEECH_LEAD_MS, BED_LEVEL,
} from '../src/audio/RadioChain';
import { estimateSpeechMs, TeamRadio } from '../src/audio/TeamRadio';

/**
 * Renders the REAL radio chain into an OfflineAudioContext so it can be
 * measured instead of admired.
 *
 * The point of doing this in a browser rather than reimplementing the filters
 * in Node is that a reimplementation is a second thing that can be wrong, and
 * a test that agrees with your own model of a biquad tells you nothing about
 * the biquad the browser will actually run. Everything here instantiates
 * `RadioChain` exactly as `TeamRadio` does, at the same sample rate, through
 * the same WebAudio implementation that ships the game.
 *
 * The Node side (`scripts/probeRadio.ts`) owns all the asserting. This file
 * only produces numbers.
 */

const SR = 48000;

export interface ResponsePoint { hz: number; db: number; }

/**
 * Magnitude response of the chain, dB, normalised to its own in-band plateau.
 *
 * One short offline render per frequency. The drive level is deliberately tiny
 * (0.02, which the saturation lifts to about 0.053 and the limiter's -20 dB
 * threshold therefore never sees) so that what is being measured is the FILTER
 * and not the compressor's gain reduction. Measuring a band-pass through an
 * engaged limiter would flatten exactly the skirts we care about.
 */
export async function measureResponse(freqs: number[]): Promise<ResponsePoint[]> {
  const out: ResponsePoint[] = [];
  for (const hz of freqs) {
    const dur = 0.25;
    const ctx = new OfflineAudioContext(1, Math.floor(SR * dur), SR);
    const chain = new RadioChain(ctx, ctx.destination, { level: 1 });
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = 0.02;
    osc.connect(g).connect(chain.input);
    osc.start(0);
    osc.stop(dur);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    // Second half only: the cascade needs time to settle, and at 300 Hz a
    // six-section filter's transient is a good fraction of a tenth of a second.
    let sum = 0;
    const from = Math.floor(d.length / 2);
    for (let i = from; i < d.length; i++) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / (d.length - from));
    out.push({ hz, db: 20 * Math.log10(Math.max(rms, 1e-12)) });
  }
  const peak = Math.max(...out.map((p) => p.db));
  return out.map((p) => ({ hz: p.hz, db: p.db - peak }));
}

export interface TransmissionMeasurement {
  /** Peak absolute sample per millisecond. */
  envelope: number[];
  peak: number;
  rms: number;
  crest: number;
  /** Sample rate of the envelope, always 1000 Hz. */
  envelopeHz: number;
  openAtMs: number;
  closeAtMs: number;
  totalMs: number;
}

/**
 * A whole transmission with nothing said in it.
 *
 * The voice is not in this graph and cannot be — see the header of
 * `RadioChain` — so what gets rendered is the squelch at both ends and the bed
 * in between, which is precisely the part we are responsible for. `speechSec`
 * stands in for how long somebody would have been talking.
 */
export async function measureTransmission(
  speechSec: number, quality = 1, dropoutAtSec: number | null = null,
): Promise<TransmissionMeasurement> {
  const openAt = 0.05;
  const closeAt = openAt + SPEECH_LEAD_MS / 1000 + speechSec;
  const total = closeAt + SQUELCH_CLOSE_MS / 1000 + 0.15;

  const ctx = new OfflineAudioContext(1, Math.ceil(SR * total), SR);
  const chain = new RadioChain(ctx, ctx.destination, { level: 1 });
  chain.setLinkQuality(quality);
  chain.open(openAt);
  if (dropoutAtSec !== null) chain.dropout(openAt + dropoutAtSec, 1 - quality);
  chain.close(closeAt);

  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);

  const blocks = Math.floor(total * 1000);
  const per = Math.floor(SR / 1000);
  const envelope = new Array<number>(blocks).fill(0);
  let peak = 0;
  let sum = 0;
  for (let b = 0; b < blocks; b++) {
    let m = 0;
    for (let i = b * per; i < (b + 1) * per && i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > m) m = a;
      sum += d[i] * d[i];
    }
    envelope[b] = m;
    if (m > peak) peak = m;
  }
  const rms = Math.sqrt(sum / d.length);
  return {
    envelope, peak, rms,
    crest: rms > 0 ? peak / rms : 0,
    envelopeHz: 1000,
    openAtMs: openAt * 1000,
    closeAtMs: closeAt * 1000,
    totalMs: total * 1000,
  };
}

/**
 * What this browser actually exposes.
 *
 * Asserted on every run, because the whole design rests on the answer being
 * "nothing". If a browser ever grows a way to route synthesised speech into
 * WebAudio, this is what notices — and the right response would be to rebuild
 * the chain around the voice rather than around it.
 */
export function probeSpeechApi(): Record<string, unknown> {
  const supported = typeof speechSynthesis !== 'undefined';
  const utterKeys = supported ? Object.getOwnPropertyNames(SpeechSynthesisUtterance.prototype) : [];
  const synthKeys = supported ? Object.getOwnPropertyNames(Object.getPrototypeOf(speechSynthesis)) : [];
  const routing = [...utterKeys, ...synthKeys].filter(
    (k) => /stream|audionode|output|destination|sink|capture|mediastream/i.test(k),
  );
  return {
    supported,
    utterKeys,
    synthKeys,
    routingHooks: routing,
    hasBoundary: utterKeys.includes('onboundary'),
    voiceCount: supported ? speechSynthesis.getVoices().length : 0,
  };
}

/** Waits for `getVoices()` to populate, which on macOS Chrome takes seconds. */
export function waitForVoices(timeoutMs = 6000): Promise<number> {
  return new Promise((res) => {
    const t0 = performance.now();
    const tick = (): void => {
      const n = speechSynthesis.getVoices().length;
      if (n > 0 || performance.now() - t0 > timeoutMs) return res(n);
      setTimeout(tick, 150);
    };
    tick();
  });
}

export interface SpeechTiming {
  ok: boolean;
  reason: string;
  onstartMs: number;
  firstBoundaryMs: number;
  lastBoundaryMs: number;
  onendMs: number;
  boundaryCount: number;
  /** What `estimateSpeechMs` predicted, for comparison with the real thing. */
  estimateMs: number;
  /** Real audible span: first boundary to onend. */
  measuredMs: number;
}

/**
 * Speaks a real line and times it.
 *
 * This is the calibration behind the fallback typewriter clock, and the check
 * on the claim that `onstart` fires long before any sound.
 */
export function measureSpeechTiming(text: string, rate: number): Promise<SpeechTiming> {
  return new Promise((res) => {
    const r: SpeechTiming = {
      ok: false, reason: '', onstartMs: -1, firstBoundaryMs: -1, lastBoundaryMs: -1,
      onendMs: -1, boundaryCount: 0, estimateMs: estimateSpeechMs(text, rate), measuredMs: -1,
    };
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    const t0 = performance.now();
    const at = (): number => Math.round(performance.now() - t0);
    u.onstart = () => { r.onstartMs = at(); };
    u.onboundary = (ev) => {
      if (ev.name && ev.name !== 'word') return;
      r.boundaryCount++;
      if (r.firstBoundaryMs < 0) r.firstBoundaryMs = at();
      r.lastBoundaryMs = at();
    };
    u.onend = () => {
      r.onendMs = at();
      r.measuredMs = r.firstBoundaryMs >= 0 ? r.onendMs - r.firstBoundaryMs : r.onendMs - r.onstartMs;
      r.ok = true;
      r.reason = 'end';
      res(r);
    };
    u.onerror = (ev) => { r.reason = 'error:' + ev.error; res(r); };
    setTimeout(() => { if (!r.ok) { r.reason = r.reason || 'timeout'; res(r); } }, 25000);
    speechSynthesis.speak(u);
  });
}

export interface ExerciseResult {
  events: { type: string; id: number; speaker?: string; reason?: string; ci?: number; est?: boolean }[];
  spokenIds: number[];
  droppedStale: boolean;
}

/**
 * Drives the real `TeamRadio` against a real AudioContext, end to end.
 *
 * Everything else in this file measures a part. This exercises the contract the
 * HUD actually consumes — that `open` precedes `speech`, that `speech` precedes
 * any word, that words only ever move forwards, that `end` is last, and that
 * two transmissions never interleave. Those are the properties the typewriter
 * relies on, and none of them is visible in a rendered buffer.
 *
 * It also checks the dropping. A message given a one-millisecond lifetime while
 * another is being spoken must never be heard.
 */
export async function exerciseRadio(): Promise<ExerciseResult> {
  const { TeamRadio: TR } = await import('../src/audio/TeamRadio');
  const ctx = new AudioContext();
  await ctx.resume();
  const radio = new TR();
  const out: ExerciseResult = { events: [], spokenIds: [], droppedStale: false };

  radio.attach(ctx, ctx.destination, () => { /* ducking is measured elsewhere */ });
  radio.setEnabled(true);
  radio.setVolume(1);

  radio.addListener((ev) => {
    const base = { type: ev.type, id: ev.transmission.id, speaker: ev.transmission.speaker };
    if (ev.type === 'word') out.events.push({ ...base, ci: ev.charIndex, est: ev.estimated });
    else if (ev.type === 'end') out.events.push({ ...base, reason: ev.reason });
    else out.events.push(base);
  });

  const a = radio.speak('Box box this lap.', { speaker: 'engineer' });
  // Queued behind `a` with a lifetime it cannot possibly survive: by the time
  // `a` has finished this is long dead and must be dropped unspoken.
  const stale = radio.speak('Gap is now four tenths.', { speaker: 'engineer', ttlMs: 1 });
  const b = radio.speak('Understood.', { speaker: 'driver' });
  if (a !== null) out.spokenIds.push(a);
  if (b !== null) out.spokenIds.push(b);

  await new Promise<void>((res) => {
    const t0 = performance.now();
    const tick = (): void => {
      const done = out.events.filter((e) => e.type === 'end' && e.reason === 'complete').length;
      if (done >= 2 || performance.now() - t0 > 20000) return res();
      setTimeout(tick, 100);
    };
    tick();
  });

  out.droppedStale = out.events.some(
    (e) => e.id === stale && e.type === 'end' && e.reason === 'stale',
  ) && !out.events.some((e) => e.id === stale && e.type === 'speech');

  radio.dispose();
  await ctx.close();
  return out;
}

/** Which voice each speaker resolved to on this platform. */
export function describeVoices(): Record<string, string> {
  const radio = new TeamRadio();
  const ctx = new OfflineAudioContext(1, 128, SR);
  radio.attach(ctx, ctx.destination, () => { /* no ducking in a probe */ });
  return radio.describeVoices();
}

export const CONSTANTS = {
  BAND_LOW_HZ, BAND_HIGH_HZ, BAND_ORDER, CASCADE_EDGE_FACTOR,
  SQUELCH_OPEN_MS, SQUELCH_CLOSE_MS, SPEECH_LEAD_MS, BED_LEVEL,
};

declare global {
  interface Window {
    RADIO_PROBE: {
      measureResponse: typeof measureResponse;
      measureTransmission: typeof measureTransmission;
      probeSpeechApi: typeof probeSpeechApi;
      waitForVoices: typeof waitForVoices;
      measureSpeechTiming: typeof measureSpeechTiming;
      describeVoices: typeof describeVoices;
      exerciseRadio: typeof exerciseRadio;
      CONSTANTS: typeof CONSTANTS;
    };
  }
}

window.RADIO_PROBE = {
  measureResponse, measureTransmission, probeSpeechApi, waitForVoices,
  measureSpeechTiming, describeVoices, exerciseRadio, CONSTANTS,
};
