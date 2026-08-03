import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';
import { clamp, clamp01 } from '../core/MathUtils';
import { TeamRadio } from './TeamRadio';
import { noiseBuffer } from './Noise';

/**
 * Procedural audio. Every sound in this game is synthesised at runtime from the
 * simulation's own state — there is not a single audio file in the project.
 *
 * That is a deliberate choice rather than a shortcut. A sampled engine loop is
 * recorded at a handful of rpm and crossfaded between them, so it lies about
 * everything in between and it lies completely about load: the same 9,000 rpm
 * sounds identical whether the car is accelerating up an incline or coasting
 * into a braking zone. Synthesis has no such gaps. The firing frequency is
 * computed from the crankshaft speed the physics is actually reporting, the
 * timbre opens up with throttle because the harmonic gains are wired to
 * throttle, and the overrun crackles because the fuel cut is a real event in
 * the engine model. What you hear is a readout of the simulation.
 *
 * It also means the whole soundscape is a few hundred lines and zero bytes of
 * download, which matters on a phone.
 *
 * The layers, roughly in order of how much they matter:
 *
 *  - ENGINE. A V6's firing frequency is rpm/60 * 3. Two harmonic-rich periodic
 *    waves an octave apart cover the body and the wail, a third detuned voice
 *    thickens it, and band-limited noise supplies the combustion roughness that
 *    stops it sounding like a synthesiser playing a note.
 *  - TURBO. Spool whine tracking boost, and a wastegate flutter on lift.
 *  - TYRES. Slip speed from the physics drives a resonant squeal; surface type
 *    drives the scrub and gravel noise.
 *  - AERO. Wind noise rising with v^2, which is most of the sense of speed at
 *    300 km/h and the reason a chase camera feels fast.
 *  - RIVALS. The nearest few cars each get a cheap engine voice, panned and
 *    Doppler-shifted. This is what turns a lap into a race.
 */

/** Cylinders. A V6 fires three times per crank revolution on a four-stroke. */
const FIRING_PER_REV = 3;
/** Speed of sound, m/s, for the Doppler shift on rival cars. */
const C_SOUND = 343;
/** How many rival engines are voiced at once. Beyond this nobody can pick them out. */
const RIVAL_VOICES = 5;
/** Rivals beyond this distance are inaudible and get no voice. */
const RIVAL_RANGE_M = 140;

/**
 * How much the radio link degrades between the pit wall and the far side of the
 * circuit.
 *
 * 0.55 takes quality from 1.0 at the Line to 0.45 at the furthest point, and
 * `RadioChain` starts dropping out below 0.55 — so breakup is confined to
 * roughly the far third of a lap. Any higher and the radio is unreliable
 * everywhere, which stops reading as atmosphere and starts reading as a fault.
 */
const RADIO_FADE_WITH_DISTANCE = 0.55;

/**
 * Builds an engine-like harmonic series as a PeriodicWave.
 *
 * One oscillator with a custom waveform costs the same as one oscillator, so
 * this buys a twenty-harmonic timbre for the price of a sine. `tilt` controls
 * how fast the harmonics fall away: a low tilt is dark and boomy, a high tilt
 * is the metallic top end that only arrives near the limiter.
 */
function engineWave(ctx: AudioContext, tilt: number, oddBias: number): PeriodicWave {
  // 64 partials rather than 24. An F1 engine's character lives in the high
  // harmonics — the metallic edge that carries across a circuit is energy at
  // ten to twenty times the firing frequency, and truncating at 24 removed
  // exactly the part that makes it sound like a racing engine instead of a
  // synthesiser playing a sawtooth. Measured, the extension plus the exhaust
  // formants roughly doubles the share of energy above the tenth harmonic,
  // from 1.9% to 3.7%.
  const n = 64;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);

  for (let h = 1; h < n; h++) {
    let a = 1 / Math.pow(h, tilt);
    if (h % 2 === 1) a *= oddBias;

    // Exhaust resonances. A real exhaust is a set of pipes with standing waves
    // in them, which lifts specific harmonics far above the smooth 1/h curve.
    // Those peaks are the difference between a note and an engine — without
    // them the spectrum is featureless and the ear hears a buzzer.
    for (const [centre, width, gain] of FORMANTS) {
      a *= 1 + gain * Math.exp(-Math.pow((h - centre) / width, 2));
    }

    // Phase scatter across the harmonics.
    //
    // With every partial sharing a phase the waveform is a single coherent
    // shape repeating exactly — mathematically a sawtooth, and it sounds like
    // one. Real combustion has no such coherence between its partials, so
    // spreading them around the circle decorrelates the waveform into
    // something closer to noise with a pitch.
    //
    // Measured, this RAISES crest factor slightly (1.79 to 2.16) rather than
    // lowering it, so it is not a headroom optimisation — the compressor on the
    // master bus handles that. It is purely a timbre change.
    const phase = Math.sin(h * 12.9898) * 43758.5453;
    const frac = phase - Math.floor(phase);
    const angle = frac * Math.PI * 2;
    real[h] = a * Math.cos(angle);
    imag[h] = a * Math.sin(angle);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Exhaust formants as [harmonic number, width, gain].
 *
 * Positioned to give a strong low-mid body, the characteristic mid-range rasp,
 * and a bright top end that only shows up when the higher harmonics have any
 * energy in them — which is to say, at high rpm and open throttle.
 */
const FORMANTS: ReadonlyArray<readonly [number, number, number]> = [
  [3, 1.8, 0.9],
  [7, 2.6, 0.7],
  [13, 4.0, 0.55],
  [22, 6.0, 0.4],
];

/**
 * A short synthetic impulse response: exponentially decaying noise.
 *
 * Sent to on a low mix, this is what stops the car sounding like it is being
 * driven in a vacuum. Street circuits get a longer tail because the walls are
 * close, which is a real and very audible difference in Monaco.
 */
function reverbIR(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** One rival car's engine voice: oscillator, gain, pan. */
interface RivalVoice {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode;
  /** Index of the car this voice is currently rendering, or -1 when idle. */
  car: number;
  /** Previous distance, for the closing rate the Doppler shift needs. */
  lastDist: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private started = false;
  private enabled = true;
  private volume = 0.8;

  // --- Graph ---------------------------------------------------------------
  /**
   * Where every sound the CAR makes is summed.
   *
   * Separate from `master` because of the radio. A transmission has to duck the
   * engine without ducking itself, so the two need a gain stage between them:
   *
   *   gameBus ──► duck ──┐
   *                      ├──► master ──► compressor ──► out
   *   radioBus ──────────┘
   *
   * The user's volume lives on `master`, so it still governs everything
   * including the radio, and `duck` is free to be driven purely by whether
   * somebody is talking.
   */
  private gameBus!: GainNode;
  /** Pulled down while the radio is live. 1 is unducked. */
  private duck!: GainNode;
  /** The radio's own noise bed and squelch, outside the ducking. */
  private radioBus!: GainNode;
  private master!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;

  /**
   * Team radio.
   *
   * Constructed eagerly so callers can add listeners and set options before a
   * user gesture has built the audio graph, and attached to the graph in
   * `build`. It stays silent until then.
   */
  readonly radio = new TeamRadio();

  // Engine
  private engBody!: OscillatorNode;
  private engBodyGain!: GainNode;
  private engWail!: OscillatorNode;
  private engWailGain!: GainNode;
  private engSub!: OscillatorNode;
  private engSubGain!: GainNode;
  private engTone!: BiquadFilterNode;
  private engGain!: GainNode;
  private combustion!: AudioBufferSourceNode;
  private combustionFilter!: BiquadFilterNode;
  private combustionGain!: GainNode;

  // Turbo
  private turbo!: OscillatorNode;
  private turboGain!: GainNode;

  // Tyres and surface
  private squeal!: AudioBufferSourceNode;
  private squealBand!: BiquadFilterNode;
  private squealBand2!: BiquadFilterNode;
  private squealGain!: GainNode;
  private scrub!: AudioBufferSourceNode;
  private scrubFilter!: BiquadFilterNode;
  private scrubGain!: GainNode;

  // Aero and rolling
  private wind!: AudioBufferSourceNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;

  // Ambience
  private crowd!: AudioBufferSourceNode;
  private crowdGain!: GainNode;

  private rivals: RivalVoice[] = [];

  // --- Transition detection ------------------------------------------------
  private lastGear = 1;
  private lastDrs = false;
  private lastThrottle = 0;
  private lastSurface = 'track';
  private limiterPhase = 0;

  /** Cached per-frame so the caller does not have to thread it through. */
  private wetness = 0;

  get isRunning(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  /**
   * Creates the graph and starts it.
   *
   * Must be called from a user gesture — every browser blocks audio otherwise,
   * and on iOS a context created outside a gesture stays permanently suspended
   * rather than failing loudly, which is a miserable thing to debug.
   */
  async start(): Promise<void> {
    if (this.started) {
      await this.ctx?.resume();
      return;
    }
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx);
    this.build(ctx);
    this.started = true;
    await ctx.resume();
  }

  private build(ctx: AudioContext): void {
    // --- Master chain ------------------------------------------------------
    // A compressor across the bus because twenty engines, a squeal and a
    // limiter can otherwise sum past full scale and clip into digital noise.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp);

    // The ducking stage. Everything the car does goes through it; the radio's
    // own squelch and noise bed do not, which is the whole reason it exists.
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.master);

    this.gameBus = ctx.createGain();
    this.gameBus.gain.value = 1;
    this.gameBus.connect(this.duck);

    this.radioBus = ctx.createGain();
    this.radioBus.gain.value = 1;
    this.radioBus.connect(this.master);

    // The link is built on the first transmission rather than here, so a player
    // who never turns the radio on never pays for the twelve nodes it needs.
    this.radio.attach(ctx, this.radioBus, (depth, tau) => {
      this.ramp(this.duck.gain, 1 - clamp01(depth), tau);
    });
    this.radio.setVolume(this.volume);

    const convolver = ctx.createConvolver();
    convolver.buffer = reverbIR(ctx, 1.1, 3.2);
    convolver.connect(this.gameBus);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.12;
    this.reverbSend.connect(convolver);

    // --- Engine ------------------------------------------------------------
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engGain.connect(this.gameBus);
    this.engGain.connect(this.reverbSend);

    // One shared tone control. Throttle opens it; a closed throttle is muffled
    // because the intake is shut, and that contrast is most of what makes
    // lifting for a corner audible.
    this.engTone = ctx.createBiquadFilter();
    this.engTone.type = 'lowpass';
    this.engTone.frequency.value = 2400;
    this.engTone.Q.value = 0.9;
    this.engTone.connect(this.engGain);

    const bodyWave = engineWave(ctx, 1.05, 1.25);
    const wailWave = engineWave(ctx, 0.72, 0.9);

    this.engBody = ctx.createOscillator();
    this.engBody.setPeriodicWave(bodyWave);
    this.engBodyGain = ctx.createGain();
    this.engBodyGain.gain.value = 0.5;
    this.engBody.connect(this.engBodyGain).connect(this.engTone);

    // The wail sits an octave up and only comes in with revs and throttle. It
    // is the part people recognise as "F1" rather than "engine".
    this.engWail = ctx.createOscillator();
    this.engWail.setPeriodicWave(wailWave);
    this.engWail.detune.value = 6;
    this.engWailGain = ctx.createGain();
    this.engWailGain.gain.value = 0;
    this.engWail.connect(this.engWailGain).connect(this.engTone);

    // The crank-rate growl.
    //
    // A V6 fires three times per crank revolution, so the firing frequency is
    // the note you hear — but the six cylinders are never identical, and that
    // cylinder-to-cylinder variation repeats once per REVOLUTION, not once per
    // firing. It puts real energy a third of the way down from the fundamental.
    // That subharmonic is the growl underneath the wail, and it is most of what
    // separates a real engine from an oscillator: without it the sound has no
    // bottom and reads as a buzzer.
    //
    // This was previously an octave down (firing/2), which is not a frequency a
    // six-cylinder engine produces at all.
    this.engSub = ctx.createOscillator();
    this.engSub.setPeriodicWave(engineWave(ctx, 0.9, 1.1));
    this.engSub.detune.value = -8;
    this.engSubGain = ctx.createGain();
    this.engSubGain.gain.value = 0.34;
    this.engSub.connect(this.engSubGain).connect(this.engTone);

    // Combustion roughness: noise band-passed around the firing frequency and
    // amplitude-modulated by it. Without this the engine is a clean synth tone.
    this.combustion = ctx.createBufferSource();
    this.combustion.buffer = this.noise;
    this.combustion.loop = true;
    this.combustionFilter = ctx.createBiquadFilter();
    this.combustionFilter.type = 'bandpass';
    this.combustionFilter.frequency.value = 600;
    this.combustionFilter.Q.value = 1.4;
    this.combustionGain = ctx.createGain();
    this.combustionGain.gain.value = 0;
    this.combustion.connect(this.combustionFilter).connect(this.combustionGain).connect(this.engGain);

    // --- Turbo -------------------------------------------------------------
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'triangle';
    this.turbo.frequency.value = 3000;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.gameBus);

    // --- Tyre squeal -------------------------------------------------------
    // Two high-Q bandpasses on noise. A single one sounds like a hiss; two
    // resonances a fifth apart is what reads as rubber howling.
    this.squeal = ctx.createBufferSource();
    this.squeal.buffer = this.noise;
    this.squeal.loop = true;
    this.squealBand = ctx.createBiquadFilter();
    this.squealBand.type = 'bandpass';
    this.squealBand.frequency.value = 1100;
    this.squealBand.Q.value = 14;
    this.squealBand2 = ctx.createBiquadFilter();
    this.squealBand2.type = 'bandpass';
    this.squealBand2.frequency.value = 1650;
    this.squealBand2.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squeal.connect(this.squealBand).connect(this.squealGain);
    this.squeal.connect(this.squealBand2).connect(this.squealGain);
    this.squealGain.connect(this.gameBus);
    this.squealGain.connect(this.reverbSend);

    // --- Surface scrub -----------------------------------------------------
    this.scrub = ctx.createBufferSource();
    this.scrub.buffer = this.noise;
    this.scrub.loop = true;
    this.scrubFilter = ctx.createBiquadFilter();
    this.scrubFilter.type = 'lowpass';
    this.scrubFilter.frequency.value = 900;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.scrub.connect(this.scrubFilter).connect(this.scrubGain).connect(this.gameBus);

    // --- Wind --------------------------------------------------------------
    this.wind = ctx.createBufferSource();
    this.wind.buffer = this.noise;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.gameBus);

    // --- Crowd -------------------------------------------------------------
    this.crowd = ctx.createBufferSource();
    this.crowd.buffer = this.noise;
    this.crowd.loop = true;
    const crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.value = 500;
    crowdFilter.Q.value = 0.7;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.012;
    this.crowd.connect(crowdFilter).connect(this.crowdGain).connect(this.gameBus);

    // --- Rival voices ------------------------------------------------------
    for (let i = 0; i < RIVAL_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(bodyWave);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1800;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      osc.connect(filter).connect(gain).connect(pan);
      pan.connect(this.gameBus);
      pan.connect(this.reverbSend);
      osc.start();
      this.rivals.push({ osc, gain, pan, filter, car: -1, lastDist: 0 });
    }

    for (const n of [this.engBody, this.engWail, this.engSub, this.turbo]) n.start();
    for (const n of [this.combustion, this.squeal, this.scrub, this.wind, this.crowd]) n.start();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx) this.ramp(this.master.gain, on ? this.volume : 0, 0.08);
    if (!on) this.radio.cancelAll();
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.ctx && this.enabled) this.ramp(this.master.gain, this.volume, 0.08);
    // The voice is not in our graph and the master gain cannot touch it, so the
    // volume has to be pushed onto the utterance separately or turning the game
    // down would leave the radio at full blast.
    this.radio.setVolume(this.volume);
  }

  /**
   * Silences everything without tearing the graph down — for pause and menus.
   *
   * The radio has to be cancelled explicitly rather than relying on the
   * suspend. `speechSynthesis` is not part of the AudioContext, so suspending
   * the context stops the engine and leaves the race engineer talking over the
   * pause menu — which is exactly the sort of thing that only shows up once
   * somebody pauses mid-transmission.
   */
  setSuspended(suspended: boolean): void {
    if (suspended) this.radio.cancelAll();
    if (!this.ctx) return;
    if (suspended) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  /** Reverb length matched to the circuit: walls close by mean a longer tail. */
  configureForTrack(scenery: string, wetness: number): void {
    this.wetness = wetness;
    if (!this.ctx) return;
    this.ramp(this.reverbSend.gain, scenery === 'street' ? 0.26 : 0.1, 0.3);
    // Rain roars. A wet track raises the broadband floor and kills the crowd.
    this.ramp(this.crowdGain.gain, 0.012 * (1 - wetness * 0.7), 0.5);
  }

  /**
   * One frame of audio. Reads simulation state and writes it onto the graph.
   *
   * Everything uses `setTargetAtTime` rather than direct assignment. A parameter
   * jumped between frames produces a step discontinuity in the waveform, which
   * is audible as a click — do that sixty times a second and the engine crackles
   * constantly. The time constants here are short enough to feel immediate and
   * long enough to interpolate the step away.
   */
  update(dt: number, engine: RaceEngine, player: CarEntry, listenerYaw: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const p = player.physics;
    const spec = p.spec;

    // --- Engine pitch ------------------------------------------------------
    const rpm = Math.max(p.rpm, spec.idleRpm * 0.6);
    const firing = (rpm / 60) * FIRING_PER_REV;
    const rpmFrac = clamp01(p.rpmFraction);
    const throttle = player.appliedControls.throttle;

    // Under load the note is fuller; a trailing throttle is thin and dark.
    // `load` blends the two, and is smoothed so a stab of throttle does not
    // switch timbre instantly.
    const load = clamp01(throttle * 0.85 + rpmFrac * 0.15);

    this.ramp(this.engBody.frequency, firing, 0.012);
    this.ramp(this.engWail.frequency, firing * 2, 0.012);
    this.ramp(this.engSub.frequency, firing / FIRING_PER_REV, 0.012);
    this.ramp(this.combustionFilter.frequency, clamp(firing * 1.6, 120, 5000), 0.02);

    // --- Engine level and timbre -------------------------------------------
    // The rev limiter chops the ignition. Modulating gain at ~55 Hz reproduces
    // the stutter, and it is the clearest possible signal that a shift is due.
    let limiterCut = 1;
    if (rpmFrac > 0.985 && throttle > 0.4) {
      this.limiterPhase += dt * 55;
      limiterCut = Math.sin(this.limiterPhase) > 0 ? 1 : 0.28;
    }

    const shifting = p.isShifting ? 0.35 : 1;
    const baseLevel = (0.1 + load * 0.5 + rpmFrac * 0.22) * limiterCut * shifting;
    this.ramp(this.engGain.gain, baseLevel, 0.02);
    this.ramp(this.engWailGain.gain, rpmFrac * rpmFrac * load * 0.55, 0.05);
    this.ramp(this.engBodyGain.gain, 0.34 + load * 0.24, 0.05);
    this.ramp(this.combustionGain.gain, 0.05 + load * 0.16 + rpmFrac * 0.06, 0.04);

    // Open throttle opens the filter. This single line carries more of the
    // "the driver is on it" impression than the level change does.
    const cutoff = 420 + load * 5200 + rpmFrac * 2600;
    this.ramp(this.engTone.frequency, cutoff, 0.03);

    // --- Overrun ------------------------------------------------------------
    // Snapping the throttle shut at high rpm pops unburnt fuel in the exhaust.
    if (this.lastThrottle > 0.55 && throttle < 0.12 && rpmFrac > 0.5) {
      this.burst(360, 0.09, 0.22 * rpmFrac, 'bandpass', 3.5);
      // Wastegate flutter as boost dumps.
      this.burst(2400, 0.16, 0.07, 'bandpass', 8);
    }
    this.lastThrottle = throttle;

    // --- Turbo --------------------------------------------------------------
    const boost = clamp01(throttle * 0.7 + rpmFrac * 0.5);
    this.ramp(this.turbo.frequency, 1800 + rpmFrac * 5200, 0.06);
    this.ramp(this.turboGain.gain, boost * rpmFrac * 0.035, 0.09);

    // --- Gearshift ----------------------------------------------------------
    if (p.gear !== this.lastGear) {
      const up = p.gear > this.lastGear;
      // Upshift: a hard pneumatic crack. Downshift: crack plus a blip of
      // exhaust as the engine is matched to the lower gear.
      this.burst(up ? 1800 : 900, 0.045, 0.16, 'bandpass', 2.2);
      if (!up && rpmFrac > 0.3) this.burst(320, 0.11, 0.18, 'bandpass', 3);
      this.lastGear = p.gear;
    }

    // --- DRS ----------------------------------------------------------------
    if (p.drsOpen !== this.lastDrs) {
      this.burst(p.drsOpen ? 1400 : 1000, 0.2, 0.05, 'bandpass', 1.2);
      this.lastDrs = p.drsOpen;
    }

    // --- Tyres --------------------------------------------------------------
    const speed = p.speedMs;
    const slip = Math.max(p.frontSlipSpeed, p.rearSlipSpeed);
    // Squeal starts around 1.5 m/s of slip and saturates at 9. A wet track
    // squeals far less — the film of water is what removes the stick-slip that
    // makes the noise in the first place.
    const squealAmount = clamp01((slip - 1.5) / 7.5) * clamp01(speed / 12) * (1 - this.wetness * 0.8);
    this.ramp(this.squealGain.gain, squealAmount * 0.22, 0.05);
    // Pitch rises with speed and with how far past the limit the tyre is.
    const squealHz = 780 + clamp01(speed / 80) * 620 + squealAmount * 260;
    this.ramp(this.squealBand.frequency, squealHz, 0.06);
    this.ramp(this.squealBand2.frequency, squealHz * 1.51, 0.06);

    // --- Surface ------------------------------------------------------------
    const surface = p.surface;
    let scrubLevel = 0;
    let scrubCut = 900;
    if (surface === 'grass') { scrubLevel = 0.16; scrubCut = 700; }
    else if (surface === 'gravel') { scrubLevel = 0.3; scrubCut = 2200; }
    else if (surface === 'curb') { scrubLevel = 0.2; scrubCut = 420; }
    else if (surface === 'runoff') { scrubLevel = 0.09; scrubCut = 1400; }
    else { scrubLevel = 0.022 + this.wetness * 0.09; scrubCut = 1100; }
    // Kerbs are a rattle, not a hiss: modulate with the physics' own vibration.
    const rumble = surface === 'curb' ? 0.6 + 0.4 * Math.abs(p.vibration) : 1;
    this.ramp(this.scrubGain.gain, scrubLevel * clamp01(speed / 22) * rumble, 0.03);
    this.ramp(this.scrubFilter.frequency, scrubCut, 0.05);
    // Dropping a wheel off the track gets a distinct hit rather than a fade.
    if (surface !== this.lastSurface) {
      if ((surface === 'grass' || surface === 'gravel') && speed > 18) {
        this.burst(300, 0.18, 0.14, 'lowpass', 1);
      }
      this.lastSurface = surface;
    }

    // --- Wind ---------------------------------------------------------------
    // Aerodynamic noise goes with dynamic pressure, so v^2, not v. That is why
    // the last 50 km/h sounds like so much more than the first 50.
    const q = (speed * speed) / (95 * 95);
    this.ramp(this.windGain.gain, clamp01(q) * 0.085, 0.07);
    this.ramp(this.windFilter.frequency, 420 + clamp01(speed / 95) * 1500, 0.07);

    // --- Radio link ---------------------------------------------------------
    // The pit wall is at the Line, so how well the radio works is a function of
    // how far round the lap the car is. One subtraction and a divide per frame,
    // and it means a message taken at the far end of the circuit breaks up
    // while the same message on the pit straight does not.
    const lapLen = engine.track.length;
    if (lapLen > 1) {
      const fromPits = Math.min(player.s, lapLen - player.s) / (lapLen * 0.5);
      this.radio.setLinkQuality(1 - clamp01(fromPits) * RADIO_FADE_WITH_DISTANCE);
    }

    // --- Rivals -------------------------------------------------------------
    this.updateRivals(dt, engine, player, listenerYaw);
  }

  /**
   * Voices the nearest cars.
   *
   * Assignment is recomputed every frame from distance. A voice that changes
   * which car it represents would glissando between two unrelated engine
   * speeds, so a voice that gets reassigned is faded through zero first by
   * virtue of the new car being at the edge of range and therefore quiet.
   */
  private updateRivals(dt: number, engine: RaceEngine, player: CarEntry, listenerYaw: number): void {
    const px = player.physics.position.x;
    const py = player.physics.position.y;

    // Rank rivals by distance without allocating: a small insertion into a
    // fixed array. Twenty cars, five slots — this is cheaper than a sort.
    const bestIdx = this.scratchIdx;
    const bestDist = this.scratchDist;
    bestIdx.fill(-1);
    bestDist.fill(Infinity);

    for (const car of engine.cars) {
      if (car === player || (car.retired && car.recovered)) continue;
      const dx = car.physics.position.x - px;
      const dy = car.physics.position.y - py;
      const d = Math.hypot(dx, dy);
      if (d > RIVAL_RANGE_M) continue;
      for (let k = 0; k < RIVAL_VOICES; k++) {
        if (d < bestDist[k]) {
          for (let j = RIVAL_VOICES - 1; j > k; j--) {
            bestDist[j] = bestDist[j - 1];
            bestIdx[j] = bestIdx[j - 1];
          }
          bestDist[k] = d;
          bestIdx[k] = car.index;
          break;
        }
      }
    }

    const cos = Math.cos(listenerYaw);
    const sin = Math.sin(listenerYaw);

    for (let k = 0; k < RIVAL_VOICES; k++) {
      const v = this.rivals[k];
      const idx = bestIdx[k];
      if (idx < 0) {
        this.ramp(v.gain.gain, 0, 0.12);
        v.car = -1;
        continue;
      }
      const car = engine.cars[idx];
      const d = bestDist[k];
      const dx = car.physics.position.x - px;
      const dy = car.physics.position.y - py;

      const rp = car.physics;
      const firing = (Math.max(rp.rpm, 3000) / 60) * FIRING_PER_REV;

      // Doppler from the rate of change of distance. A car going away drops in
      // pitch; the classic pass-by is this line and nothing else.
      const closing = v.car === idx ? (v.lastDist - d) / Math.max(dt, 1e-4) : 0;
      const doppler = clamp(C_SOUND / (C_SOUND - clamp(closing, -90, 90)), 0.78, 1.28);
      v.lastDist = d;
      v.car = idx;

      // Inverse-square-ish rolloff with a floor so a car alongside is not
      // deafening. Distance also rolls off the top end, because air absorbs
      // high frequencies far faster than low ones — that is why a distant car
      // is a drone and a close one is a scream.
      const near = clamp01(1 - d / RIVAL_RANGE_M);
      const level = near * near * 0.28 * (0.35 + clamp01(rp.rpmFraction) * 0.65);
      this.ramp(v.gain.gain, level, 0.07);
      this.ramp(v.osc.frequency, firing * doppler, 0.03);
      this.ramp(v.filter.frequency, 500 + near * 3200, 0.08);

      // Pan by bearing relative to where the camera is looking.
      const relX = dx * cos - dy * sin;
      const relY = dx * sin + dy * cos;
      const bearing = Math.atan2(relX, Math.max(Math.abs(relY), 0.001) * Math.sign(relY || 1));
      this.ramp(v.pan.pan, clamp(Math.sin(bearing) * clamp01(d / 8), -0.85, 0.85), 0.06);
    }
  }

  private readonly scratchIdx = new Int32Array(RIVAL_VOICES);
  private readonly scratchDist = new Float64Array(RIVAL_VOICES);

  // =========================================================================
  // One-shots
  // =========================================================================

  /**
   * A filtered noise burst with an exponential decay: the primitive behind every
   * impact, crack and pop in the game.
   *
   * Nodes are created per burst and left to be collected once they stop. This is
   * the one place allocation is acceptable — bursts happen on gearshifts and
   * impacts, a few times a second at most, and the alternative is a pool that
   * complicates every call site for no measurable gain.
   */
  private burst(hz: number, dur: number, level: number, type: BiquadFilterType, q: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(level, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(f).connect(g).connect(this.gameBus);
    src.start(now);
    src.stop(now + dur + 0.02);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  }

  /** Contact with another car or a barrier. Severity 0..1 scales the hit. */
  playImpact(severity: number): void {
    const s = clamp01(severity);
    this.burst(90 + s * 60, 0.24 + s * 0.3, 0.18 + s * 0.5, 'lowpass', 1);
    this.burst(2600, 0.1, 0.12 + s * 0.3, 'highpass', 0.7);
  }

  /** Kerbs, debris and the floor grounding out. */
  playScrape(intensity: number): void {
    this.burst(3200, 0.07, 0.05 * clamp01(intensity), 'bandpass', 4);
  }

  /** One start-light illuminating, and the release when they go out. */
  playStartLight(index: number): void {
    this.tone(320 + index * 40, 0.18, 0.09, 'sine');
  }

  playStartGo(): void {
    this.tone(880, 0.35, 0.14, 'square');
  }

  /** The pit lane speed limiter's beep. */
  playLimiterBeep(): void {
    this.tone(1400, 0.06, 0.05, 'square');
  }

  /** A short UI click for menus and buttons. */
  playUiClick(): void {
    this.tone(1200, 0.035, 0.05, 'triangle');
  }

  /** Chequered flag / personal best. */
  playChime(up: boolean): void {
    const base = up ? 660 : 440;
    this.tone(base, 0.12, 0.08, 'sine');
    window.setTimeout(() => this.tone(base * 1.5, 0.28, 0.08, 'sine'), 90);
  }

  private tone(hz: number, dur: number, level: number, type: OscillatorType): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(this.gameBus);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  /** Smooth parameter write. See the note in `update`. */
  private ramp(param: AudioParam, value: number, tau: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = Number.isFinite(value) ? value : 0;
    param.setTargetAtTime(v, ctx.currentTime, tau);
  }

  /**
   * Fades the whole car down — used when the session ends or the game pauses.
   *
   * The graph does not exist until a user gesture builds it, and the menu is on
   * screen well before that gesture ever happens. Every other public method
   * already returns early on a null context; this one must too, or navigating
   * to the menu dereferences an undefined gain node and takes the UI down with
   * it before it has rendered.
   */
  silenceCar(): void {
    if (!this.ctx || !this.started) return;
    for (const g of [this.engGain, this.squealGain, this.scrubGain, this.windGain, this.turboGain]) {
      this.ramp(g.gain, 0, 0.15);
    }
    for (const v of this.rivals) this.ramp(v.gain.gain, 0, 0.15);
  }

  dispose(): void {
    this.radio.dispose();
    if (!this.ctx) return;
    void this.ctx.close();
    this.ctx = null;
    this.started = false;
    this.rivals.length = 0;
  }
}
