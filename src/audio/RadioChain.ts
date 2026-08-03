import { noiseBuffer } from './Noise';
import { clamp, clamp01 } from '../core/MathUtils';

/**
 * The pit-to-car radio link, as a WebAudio graph.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT TOUCH — read this before changing anything
 * ===========================================================================
 *
 * The voice in a team radio transmission comes from `speechSynthesis`, and
 * `speechSynthesis` output CANNOT BE ROUTED INTO WEBAUDIO. This is not a gap in
 * our implementation, it is the shape of the platform, and it was established
 * by probing a real browser rather than by reading a blog post — see
 * `scripts/probeRadio.ts`, which asserts it on every run so that the day a
 * browser does expose a stream, this file's design assumption fails loudly
 * instead of quietly staying pessimistic forever.
 *
 * What the probe found, in Chrome 1xx on macOS:
 *
 *   SpeechSynthesisUtterance.prototype  text, lang, voice, volume, rate, pitch,
 *                                       onstart, onend, onerror, onpause,
 *                                       onresume, onmark, onboundary
 *   speechSynthesis (prototype)         pending, speaking, paused, cancel,
 *                                       getVoices, pause, resume, speak
 *
 * There is no `audioNode`, no `stream`, no `destination`, no `sinkId`. The
 * utterance is handed to the operating system's speech service (SAPI, or
 * AVSpeechSynthesizer on macOS and iOS, or the Android TTS engine) and that
 * service mixes into the output device somewhere below the browser's audio
 * graph. `getDisplayMedia({ audio: true })` could in principle capture the tab
 * and feed it back in, but it needs a permission prompt and a picker every
 * session and it would capture the engine along with the voice, which is worse
 * than useless — the engine would come back through the band-pass too.
 *
 * SO: THIS CHAIN NEVER CARRIES THE VOICE. It carries everything around the
 * voice. The band-pass, the saturation and the limiter shape the noise bed and
 * the squelch, not the words.
 *
 * That sounds like a defeat and mostly is not, because of what a listener
 * actually keys on. Squelch is the single loudest signal that a sound is a
 * radio transmission — the "kssht" at the end of a message is more diagnostic
 * than the band-limiting is, and it is entirely ours to synthesise. The bed
 * sits under the voice for the whole transmission and, by psychoacoustic
 * masking, genuinely takes some of the cleanliness off it. The engine ducking
 * is what an intercom does. Those three carry most of the illusion.
 *
 * What we do NOT get is a band-limited voice. The words themselves stay
 * full-bandwidth, and no amount of work in this file changes that. The honest
 * summary is in the report attached to this change: the result reads as
 * "a voice on a radio" rather than "a screen reader", but it does not read as
 * "a 1970s VHF link", and it never will while the platform is shaped this way.
 *
 * ===========================================================================
 * THE CHAIN
 * ===========================================================================
 *
 *   noise ──► bedGain ──┐
 *   squelch bursts ─────┼──► HP×3 ──► LP×3 ──► saturate ──► limit ──► out
 *   flutter LFO ────────┘      (the 300 Hz – 3.4 kHz link band)
 *
 * Every stage is scheduled against an absolute time passed in by the caller,
 * never against `ctx.currentTime` read inside this file. That is what lets
 * `scripts/probeRadio.ts` render the identical graph into an
 * `OfflineAudioContext` and measure it. A chain that can only be evaluated by
 * listening to it is a chain nobody can safely change.
 */

// --- The link band ---------------------------------------------------------

/** Bottom of the voice band a real narrow-band link passes, Hz. */
export const BAND_LOW_HZ = 300;
/** Top of it. 3.4 kHz is the classic telephony/comms ceiling. */
export const BAND_HIGH_HZ = 3400;
/** Second-order sections cascaded at each end. Three is 36 dB/octave. */
export const BAND_ORDER = 3;

/**
 * Where to place each section's corner so the CASCADE lands on the band edge.
 *
 * A biquad at Q=0.7071 is -3 dB at its own corner, so three of them in series
 * are -9 dB there, and the cascade's real -3 dB point sits well away from the
 * number written on the filter. Setting all three to 300 Hz would put the
 * measured edge at 420 Hz and the band would be visibly wrong in the probe.
 *
 * For N cascaded second-order Butterworth sections the -3 dB point moves by
 * (1 / (2^(1/N) - 1))^(1/4). For N=3 that is 1.4006, so the high-pass sections
 * go at 300/1.4006 = 214 Hz and the low-pass ones at 3400*1.4006 = 4762 Hz.
 * `probeRadio` measures the result and fails if the edges are not where this
 * comment claims.
 */
export const CASCADE_EDGE_FACTOR = Math.pow(1 / (Math.pow(2, 1 / BAND_ORDER) - 1), 0.25);

// --- Squelch ---------------------------------------------------------------

/**
 * Key-down. Short, because the transmitting radio locks the carrier almost at
 * once — this is the click and the little rush before the link settles.
 */
export const SQUELCH_OPEN_MS = 55;
/**
 * Key-up: the "kssht". Longer and louder than the key-down, because when the
 * carrier drops the receiver's gate opens onto full-scale hiss for the moment
 * before it mutes. THIS IS THE SOUND PEOPLE RECOGNISE. Shorten it and the whole
 * effect stops reading as a radio.
 */
export const SQUELCH_CLOSE_MS = 130;
/** Peak level of the key-down burst, linear. */
export const SQUELCH_OPEN_LEVEL = 0.30;
/** Peak level of the key-up burst. Deliberately the loudest thing in the chain. */
export const SQUELCH_CLOSE_LEVEL = 0.55;

/**
 * How long after key-down the first word should be spoken, ms.
 *
 * A real operator presses the key, the link comes up, and then they talk. Words
 * that start on the same millisecond as the squelch sound like a sample being
 * triggered rather than someone speaking. This is also the number the HUD's
 * typewriter uses to know when to start typing — see `TeamRadio`.
 */
export const SPEECH_LEAD_MS = 170;

// --- Noise bed -------------------------------------------------------------

/** Steady link hiss under the voice, linear. Low: it is a bed, not a feature. */
export const BED_LEVEL = 0.055;
/** How fast the bed comes up and goes away, seconds. */
export const BED_FADE_S = 0.05;
/** Depth of the slow amplitude flutter on the bed, 0..1 of BED_LEVEL. */
export const BED_FLUTTER = 0.35;
/** Flutter rate, Hz. Slow enough to read as an unsteady link, not as tremolo. */
export const BED_FLUTTER_HZ = 3.7;

// --- Saturation and limiting ----------------------------------------------

/** Soft-clip drive. Higher is grittier; past about 6 it becomes fuzz. */
export const SATURATION_DRIVE = 2.6;

/**
 * Builds the soft-clip transfer curve for the WaveShaper.
 *
 * `tanh` normalised so full scale in is full scale out. A hard `Math.sign`
 * clipper would be cheaper and sound like a broken speaker; the point of
 * saturation here is the low-order harmonic grit a cheap transmitter adds, and
 * that comes from the KNEE, not from the clipping.
 */
export function saturationCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  // Explicitly `Float32Array<ArrayBuffer>` rather than a bare `Float32Array`.
  // Since TypeScript 5.7 the typed arrays are generic in their backing buffer
  // and the bare name widens to `ArrayBufferLike`, which includes
  // `SharedArrayBuffer` — and `WaveShaperNode.curve` will not accept that.
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = Math.max(0.001, drive);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Limiter. Hard ratio and a fast attack: a radio link does not breathe. */
export const LIMIT_THRESHOLD_DB = -20;
export const LIMIT_RATIO = 14;
export const LIMIT_KNEE_DB = 2;
export const LIMIT_ATTACK_S = 0.002;
export const LIMIT_RELEASE_S = 0.09;

/** Output trim, so the radio sits under the engine rather than over it. */
export const OUTPUT_LEVEL = 0.85;

/**
 * Link quality below which dropouts start, and how bad they get.
 *
 * Driven from the car's distance to the pit wall by `AudioEngine`, so a message
 * taken on the far side of the circuit breaks up and one taken on the pit
 * straight does not. This is a real thing that happens and it costs one number
 * per frame to simulate.
 */
export const DROPOUT_ONSET_QUALITY = 0.55;
/** Longest a single dropout lasts, seconds. */
export const DROPOUT_MAX_S = 0.22;

export interface RadioChainOptions {
  /** Overall trim, linear. */
  level?: number;
  /** Steady bed level, linear. */
  bedLevel?: number;
}

/**
 * One instance of the link. Built once and reused for every transmission —
 * nothing here is allocated per message except the two squelch bursts, which
 * follow the same create-and-let-go pattern as `AudioEngine.burst`.
 */
export class RadioChain {
  private readonly ctx: BaseAudioContext;
  private readonly noise: AudioBuffer;

  /** Where the squelch bursts and the bed are summed, pre-band-pass. */
  readonly input: GainNode;
  /** Post-limiter output. The caller connects this wherever it belongs. */
  readonly output: GainNode;

  private readonly bedSource: AudioBufferSourceNode;
  private readonly bedGain: GainNode;
  private readonly flutter: OscillatorNode;
  private readonly flutterGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly sections: BiquadFilterNode[] = [];

  private readonly bedLevel: number;
  private linkQuality = 1;
  private disposed = false;

  constructor(ctx: BaseAudioContext, destination: AudioNode, opts: RadioChainOptions = {}) {
    this.ctx = ctx;
    this.bedLevel = opts.bedLevel ?? BED_LEVEL;
    this.noise = noiseBuffer(ctx);

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    // --- The band ----------------------------------------------------------
    // Cascaded rather than one filter with a high Q. A single resonant band-pass
    // rings, and a ringing band-pass on a noise bed sounds like a whistle rather
    // than like a link. Flat in the band, steep outside it, is what we want.
    let node: AudioNode = this.input;
    for (let i = 0; i < BAND_ORDER; i++) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = BAND_LOW_HZ / CASCADE_EDGE_FACTOR;
      hp.Q.value = Math.SQRT1_2;
      node = node.connect(hp);
      this.sections.push(hp);
    }
    for (let i = 0; i < BAND_ORDER; i++) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = BAND_HIGH_HZ * CASCADE_EDGE_FACTOR;
      lp.Q.value = Math.SQRT1_2;
      node = node.connect(lp);
      this.sections.push(lp);
    }

    // --- Saturation --------------------------------------------------------
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(SATURATION_DRIVE);
    // 2x oversampling. Without it the curve's own harmonics alias back down
    // into the band as inharmonic junk, which is audible on a noise bed as a
    // metallic edge that no radio has.
    shaper.oversample = '2x';
    node = node.connect(shaper);

    // --- Limiting ----------------------------------------------------------
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_THRESHOLD_DB;
    this.limiter.ratio.value = LIMIT_RATIO;
    this.limiter.knee.value = LIMIT_KNEE_DB;
    this.limiter.attack.value = LIMIT_ATTACK_S;
    this.limiter.release.value = LIMIT_RELEASE_S;
    node = node.connect(this.limiter);

    this.output = ctx.createGain();
    this.output.gain.value = opts.level ?? OUTPUT_LEVEL;
    node.connect(this.output);
    this.output.connect(destination);

    // --- Bed ---------------------------------------------------------------
    this.bedSource = ctx.createBufferSource();
    this.bedSource.buffer = this.noise;
    this.bedSource.loop = true;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    this.bedSource.connect(this.bedGain).connect(this.input);

    // A slow wobble on the bed. A perfectly steady hiss is the giveaway that a
    // noise floor was generated rather than received; real links drift.
    this.flutter = ctx.createOscillator();
    this.flutter.type = 'sine';
    this.flutter.frequency.value = BED_FLUTTER_HZ;
    this.flutterGain = ctx.createGain();
    this.flutterGain.gain.value = 0;
    this.flutter.connect(this.flutterGain).connect(this.bedGain.gain);

    this.bedSource.start(0);
    this.flutter.start(0);
  }

  /**
   * How good the link is, 0..1. Below `DROPOUT_ONSET_QUALITY` transmissions
   * start breaking up. Set from the car's position, not from a timer.
   */
  setLinkQuality(q: number): void {
    this.linkQuality = clamp01(q);
  }

  get quality(): number {
    return this.linkQuality;
  }

  /**
   * Keys the transmitter at `at`. Returns the time the first word should be
   * spoken — `at + SPEECH_LEAD_MS`, in context time.
   */
  open(at: number): number {
    if (this.disposed) return at;
    const bed = this.bedLevel * (1 + (1 - this.linkQuality) * 1.6);
    this.bedGain.gain.cancelScheduledValues(at);
    this.bedGain.gain.setValueAtTime(0, at);
    this.bedGain.gain.linearRampToValueAtTime(bed, at + BED_FADE_S);
    this.flutterGain.gain.cancelScheduledValues(at);
    this.flutterGain.gain.setValueAtTime(0, at);
    this.flutterGain.gain.linearRampToValueAtTime(bed * BED_FLUTTER, at + BED_FADE_S);
    this.burst(at, SQUELCH_OPEN_MS / 1000, SQUELCH_OPEN_LEVEL);
    return at + SPEECH_LEAD_MS / 1000;
  }

  /**
   * Unkeys at `at`. Returns the time the chain is silent again, which is what
   * the queue uses to schedule the next transmission without overlapping.
   */
  close(at: number): number {
    if (this.disposed) return at;
    const tail = SQUELCH_CLOSE_MS / 1000;
    // The bed rides UP into the key-up burst rather than fading out under it.
    // Losing the carrier opens the receiver's gate onto whatever is on the
    // channel, which is louder than the link was, and that swell is half of why
    // the "kssht" reads as an ending rather than as a glitch.
    this.bedGain.gain.cancelScheduledValues(at);
    this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, at);
    this.bedGain.gain.linearRampToValueAtTime(this.bedLevel * 2.2, at + tail * 0.45);
    this.bedGain.gain.linearRampToValueAtTime(0, at + tail);
    this.flutterGain.gain.cancelScheduledValues(at);
    this.flutterGain.gain.setValueAtTime(this.flutterGain.gain.value, at);
    this.flutterGain.gain.linearRampToValueAtTime(0, at + tail);
    this.burst(at, tail, SQUELCH_CLOSE_LEVEL);
    return at + tail + 0.02;
  }

  /**
   * A break in the link: the bed jumps, then everything cuts for a moment.
   *
   * Scheduled explicitly rather than run off a timer so the offline harness can
   * measure the gate depth. `severity` 0..1.
   */
  dropout(at: number, severity: number): number {
    if (this.disposed) return at;
    const s = clamp01(severity);
    const dur = clamp(DROPOUT_MAX_S * (0.35 + s * 0.65), 0.04, DROPOUT_MAX_S);
    const g = this.bedGain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    // Carrier lost: the receiver's AGC winds up onto open-channel noise...
    g.linearRampToValueAtTime(this.bedLevel * 3, at + 0.012);
    // ...and then the squelch gate slams, which is the actual silence.
    g.linearRampToValueAtTime(0, at + 0.03);
    g.setValueAtTime(0, at + dur);
    g.linearRampToValueAtTime(this.bedLevel * (1 + (1 - this.linkQuality) * 1.6), at + dur + 0.03);
    return at + dur + 0.03;
  }

  /**
   * Filtered noise burst with an exponential tail — the squelch primitive.
   *
   * Two nodes per burst, two bursts per transmission. That is four allocations
   * for a message that lasts several seconds, which is nothing next to the
   * per-frame budget this runs inside.
   */
  private burst(at: number, dur: number, level: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    // Start each burst at a different point in the buffer, or every squelch in
    // the session is bit-identical and the ear notices within about three.
    const offset = (at * 7.3) % Math.max(0.001, this.noise.duration - dur - 0.01);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(g).connect(this.input);
    src.start(at, offset);
    src.stop(at + dur + 0.02);
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.bedSource.stop(); } catch { /* already stopped */ }
    try { this.flutter.stop(); } catch { /* already stopped */ }
    this.bedSource.disconnect();
    this.flutterGain.disconnect();
    this.flutter.disconnect();
    this.bedGain.disconnect();
    for (const s of this.sections) s.disconnect();
    this.limiter.disconnect();
    this.input.disconnect();
    this.output.disconnect();
  }
}
