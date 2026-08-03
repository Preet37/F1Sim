import { RadioChain, SPEECH_LEAD_MS, SQUELCH_CLOSE_MS } from './RadioChain';
import { clamp, clamp01 } from '../core/MathUtils';

/**
 * Team radio: the voice, the queue, and the clock the HUD types to.
 *
 * `RadioChain` is the sound of the link. This is everything else — who is
 * talking, whether they should be talking at all by the time their turn comes
 * round, and when each word lands so the radio card's typewriter can be driven
 * off the same clock as the speech.
 *
 * ===========================================================================
 * THE ONE MEASUREMENT THAT DICTATES THE DESIGN
 * ===========================================================================
 *
 * `onstart` DOES NOT MEAN THE FIRST WORD IS AUDIBLE. Measured in Chrome on
 * macOS, speaking "Box box. Soft on the left. Confirm you are coming in this
 * lap." at rate 1.1:
 *
 *     onstart              t = 129 ms
 *     boundary "Box"       t = 1258 ms      <-- the first word actually starts
 *     boundary "lap"       t = 4798 ms
 *     onend                t = 5097 ms
 *
 * `onstart` fires when Chrome hands the utterance to the operating system's
 * speech service, which is 1.1 SECONDS before the audio begins. A typewriter
 * started on `onstart` would run more than a second ahead of the voice for a
 * five-second line — which is precisely the failure that makes a subtitle feel
 * fake, and it would have been invisible to anyone testing by eye on a short
 * line.
 *
 * So `boundary` events are the clock, not `onstart`, and this class does not
 * emit its `speech` event until the first boundary arrives. Boundaries carry
 * `charIndex` and `charLength`, so the HUD can reveal exactly the characters
 * that have been uttered.
 *
 * Where boundaries never come — some Android TTS engines and some individual
 * voices do not report them — a grace period expires and an estimated schedule
 * takes over. The estimator is calibrated against real speech by
 * `scripts/probeRadio.ts` rather than guessed at, and it only ever runs the
 * text FORWARD: snapping a typewriter backwards to meet a late boundary looks
 * worse than being slightly off.
 *
 * ===========================================================================
 * FOR WHOEVER IS WRITING THE LINES
 * ===========================================================================
 *
 *  - Keep a line under about 90 characters. Chrome has a long-standing bug
 *    where utterances past roughly 15 seconds are cut off; 90 characters is
 *    about 7 seconds, which is comfortably clear of it and is also about as
 *    long as anybody says one thing on a real radio.
 *  - Write numbers as words where the reading matters. "P3" is read correctly;
 *    "1:23.456" is read as a disaster. "One twenty three point four" is not.
 *  - Initialisms are read letter by letter, which is what you want: VSC, DRS
 *    and ERS all come out right. Do not write them lower case.
 *  - Full stops and commas are the only reliable pause. Em dashes and ellipses
 *    are silently dropped by some voices and read aloud by others.
 *  - Every line gets a key-up squelch after it, so lines do not need to end on
 *    a sign-off word. "Box box" is a complete transmission.
 */

// --- Speakers --------------------------------------------------------------

export type RadioSpeaker = 'engineer' | 'principal' | 'control' | 'driver';

/**
 * How each person sounds.
 *
 * `prefer` is matched against `SpeechSynthesisVoice.name` in order, so the
 * first name present on the platform wins. The lists are deliberately long and
 * cross-platform: macOS and iOS ship Daniel and Moira, Windows ships the
 * Microsoft voices, Android and desktop Chrome ship the Google ones. When none
 * of them exist — or when the platform offers exactly one voice, which is the
 * common case on locked-down Android — `rate` and `pitch` alone still separate
 * the four speakers, which is why they are set to audibly different values
 * rather than to small tasteful offsets.
 */
interface SpeakerProfile {
  prefer: readonly string[];
  rate: number;
  pitch: number;
  /** Ducking depth applied to the rest of the mix while this person talks. */
  duck: number;
}

const SPEAKERS: Record<RadioSpeaker, SpeakerProfile> = {
  // The race engineer. British, unflappable, slightly quick because he is
  // reading numbers off a screen while the car is moving.
  engineer: {
    prefer: ['Daniel', 'Google UK English Male', 'Microsoft George', 'Microsoft Ryan',
      'Arthur', 'Oliver', 'Rocko (English (United Kingdom))', 'Microsoft David'],
    rate: 1.08, pitch: 0.95, duck: 0.55,
  },
  // The team principal. Older, lower, slower — he is not in a hurry and the
  // contrast with the engineer is the point.
  principal: {
    prefer: ['Microsoft David', 'Arthur', 'Reed (English (United Kingdom))', 'Daniel',
      'Google UK English Male', 'Rocko (English (United States))'],
    rate: 0.90, pitch: 0.75, duck: 0.6,
  },
  // Race control. Official, flat, and deliberately not one of the team's own
  // voices — a different accent does more than any amount of processing to say
  // "this is not your garage talking".
  control: {
    prefer: ['Moira', 'Tessa', 'Karen', 'Microsoft Zira', 'Google US English',
      'Samantha', 'Shelley (English (United Kingdom))'],
    rate: 1.0, pitch: 1.02, duck: 0.65,
  },
  // The player's own driver, in a helmet at 300 km/h.
  driver: {
    prefer: ['Rishi', 'Alex', 'Microsoft Mark', 'Google US English', 'Karen',
      'Samantha', 'Flo (English (United States))'],
    rate: 1.15, pitch: 1.08, duck: 0.5,
  },
};

/**
 * Voices that exist on macOS and iOS and must never be chosen.
 *
 * `getVoices()` returns Apple's novelty voices alongside the real ones and
 * gives no flag to tell them apart — `localService` is true for all of them.
 * "Bells" sings. "Zarvox" is a robot. "Bad News" reads everything as a funeral
 * dirge. Any of them landing on the race engineer would be the single worst
 * thing in the game, and it would happen on whichever machine happened to sort
 * them differently, so it is not enough to rely on the preference list
 * matching first.
 */
const DENIED_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'deranged', 'fred', 'good news', 'hysterical', 'jester', 'junior', 'kathy',
  'organ', 'pipe organ', 'princess', 'ralph', 'superstar', 'trinoids',
  'whisper', 'wobble', 'zarvox',
]);

// --- Timing ----------------------------------------------------------------

/**
 * How long to wait for a `boundary` event before deciding this platform does
 * not send them.
 *
 * Measured worst case on macOS Chrome is 1.13 s between `onstart` and the first
 * boundary. Two seconds clears that with margin without leaving the card
 * sitting blank for an embarrassing length of time when boundaries really are
 * absent.
 */
const BOUNDARY_GRACE_MS = 2000;

/**
 * Characters per second of speech at rate 1.0, for the fallback clock.
 *
 * Calibrated against real speech, not guessed: 62 characters in 4.97 s at
 * rate 1.1, with three sentence-ending stops. That solves to 12.8 characters
 * per second plus 180 ms per full stop, which predicts that line at 4.89 s
 * against 4.97 s measured — 1.6% low. `scripts/probeRadio.ts` re-measures this
 * against live speech on every run and fails if the estimator drifts past 20%,
 * because the fallback typewriter is only as good as this number.
 */
export const SPEECH_CHARS_PER_SEC = 12.8;
/** Extra time a sentence-ending stop adds, ms at rate 1.0. */
export const SPEECH_SENTENCE_PAUSE_MS = 180;

/** Longest line we will hand to the synthesiser. See the note on Chrome above. */
const MAX_LINE_CHARS = 220;

/** Default lifetime of a queued message before it is thrown away unspoken. */
const DEFAULT_TTL_MS = 8000;

/**
 * Chrome will not reliably start an utterance queued in the same task as a
 * `cancel()`. Waiting a beat costs nothing and avoids a wedged synthesiser,
 * which presents as the radio going permanently silent mid-race.
 */
const CANCEL_SETTLE_MS = 70;

/**
 * Predicts how long a line takes to say, ms.
 *
 * Exported so the harness can check it against real speech and so the HUD can
 * size a card before a word has been spoken.
 */
export function estimateSpeechMs(text: string, rate = 1): number {
  const stops = (text.match(/[.!?]/g) ?? []).length;
  const base = (text.length / SPEECH_CHARS_PER_SEC) * 1000
    + stops * SPEECH_SENTENCE_PAUSE_MS;
  return Math.max(350, base / clamp(rate, 0.25, 4));
}

// --- Public shape ----------------------------------------------------------

export interface RadioSpeakOptions {
  /** Who is talking. Default `engineer`. */
  speaker?: RadioSpeaker;
  /**
   * Higher wins. A queued message of higher priority jumps the queue; one of
   * strictly higher priority than what is currently being said cuts it off.
   */
  priority?: number;
  /**
   * How long this message stays worth saying, ms. A message that has not
   * STARTED by then is dropped rather than queued behind whatever is running.
   * Short for anything about a gap or a position; long for a flag.
   */
  ttlMs?: number;
  /**
   * Messages sharing a tag replace one another in the queue. Use it for
   * anything that supersedes itself — "gap to the car ahead" should never be
   * in the queue twice with two different numbers.
   */
  tag?: string;
}

export interface RadioTransmission {
  readonly id: number;
  readonly text: string;
  readonly speaker: RadioSpeaker;
  /** ms between the key-down squelch and the first word. */
  readonly leadMs: number;
  /** Best estimate of the spoken duration, ms. Not authoritative — words are. */
  readonly estimatedMs: number;
}

export type RadioEndReason = 'complete' | 'cancelled' | 'error' | 'stale' | 'hidden';

/**
 * What the HUD listens to.
 *
 *   open    the transmitter keys. Show the card; the squelch is already
 *           playing. NOTHING HAS BEEN SAID YET — do not start typing here.
 *   speech  the first word is now audible. Start the typewriter.
 *   word    reveal up to `charIndex + charLength`. `estimated` is false when
 *           this came from a real `boundary` event and true when it came from
 *           the fallback clock.
 *   end     the transmission is over, for the reason given. The key-up squelch
 *           is playing over the next ~130 ms, so a card that lingers briefly
 *           here is correct rather than late.
 */
export type RadioEvent =
  | { type: 'open'; transmission: RadioTransmission }
  | { type: 'speech'; transmission: RadioTransmission }
  | {
      type: 'word'; transmission: RadioTransmission;
      charIndex: number; charLength: number; estimated: boolean;
    }
  | { type: 'end'; transmission: RadioTransmission; reason: RadioEndReason };

export type RadioListener = (ev: RadioEvent) => void;

/** One line in a multi-turn exchange. */
export interface RadioTurnSpec {
  speaker: RadioSpeaker;
  text: string;
}

interface QueueItem {
  transmission: RadioTransmission;
  priority: number;
  expiresAt: number;
  tag?: string;
}

/** Ducking hook, supplied by whoever owns the rest of the mix. */
export type DuckFn = (depth: number, seconds: number) => void;

export class TeamRadio {
  private ctx: BaseAudioContext | null = null;
  private chain: RadioChain | null = null;
  private duckFn: DuckFn | null = null;

  private enabled = false;
  private volume = 1;

  private readonly queue: QueueItem[] = [];
  private readonly listeners = new Set<RadioListener>();

  private active: RadioTransmission | null = null;
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private activePriority = -Infinity;
  private nextId = 1;

  /** Timers belonging to the current transmission, cleared together. */
  private timers: number[] = [];
  private sawBoundary = false;
  private speechStarted = false;
  private lastCharEnd = 0;

  private voices: SpeechSynthesisVoice[] = [];
  private resolved = new Map<RadioSpeaker, SpeechSynthesisVoice | null>();
  private voicesReady = false;

  private onVoicesChanged = (): void => { this.refreshVoices(); };
  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.hidden) this.cancelAll('hidden');
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Whether this browser can speak at all.
   *
   * Checked rather than assumed: `speechSynthesis` is absent in some embedded
   * webviews and present-but-voiceless in others, and the difference between
   * those two is only visible after `getVoices()` has had time to populate.
   */
  static get supported(): boolean {
    return typeof window !== 'undefined'
      && typeof window.speechSynthesis !== 'undefined'
      && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  /**
   * Connects the link to the mix. Called once the AudioContext exists, which is
   * to say once a user gesture has unlocked audio.
   */
  attach(ctx: BaseAudioContext, destination: AudioNode, duck: DuckFn): void {
    if (this.chain) return;
    this.ctx = ctx;
    this.chain = new RadioChain(ctx, destination);
    this.duckFn = duck;
    if (TeamRadio.supported) {
      this.refreshVoices();
      // getVoices() is asynchronous on every platform and SLOW on macOS Chrome:
      // measured, it returned an empty array for 2.5 seconds after page load
      // and then 180 voices at once. Resolving voices eagerly at construction
      // would therefore pick nothing on exactly the platform with the best
      // voices, so resolution is deferred and re-run when the list arrives.
      window.speechSynthesis.addEventListener?.('voiceschanged', this.onVoicesChanged);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  get attached(): boolean { return this.chain !== null; }
  get isTransmitting(): boolean { return this.active !== null; }
  get queueLength(): number { return this.queue.length; }

  /**
   * Off by default. A synthesised voice is a matter of taste in a way that an
   * engine note is not, and the honest assessment of this feature is that it is
   * good but not unarguably good — so it is the player's call, not ours.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.cancelAll('cancelled');
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Follows the master volume so "Off" in settings silences the voice too. */
  setVolume(v: number): void {
    this.volume = clamp01(v);
  }

  /**
   * Link quality, 0..1, from the car's distance to the pit wall. Below about
   * 0.55 transmissions start breaking up.
   */
  setLinkQuality(q: number): void {
    this.chain?.setLinkQuality(q);
  }

  addListener(fn: RadioListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  private refreshVoices(): void {
    if (!TeamRadio.supported) return;
    const all = window.speechSynthesis.getVoices();
    if (!all.length) return;
    this.voices = all;
    this.voicesReady = true;
    this.resolved.clear();
  }

  /**
   * Picks a voice for a speaker, or null to mean "use the system default and
   * lean entirely on rate and pitch".
   */
  private voiceFor(speaker: RadioSpeaker): SpeechSynthesisVoice | null {
    if (!this.voicesReady) this.refreshVoices();
    const cached = this.resolved.get(speaker);
    if (cached !== undefined) return cached;

    const profile = SPEAKERS[speaker];
    const usable = this.voices.filter((v) => !DENIED_VOICES.has(v.name.trim().toLowerCase()));
    const english = usable.filter((v) => v.lang.toLowerCase().startsWith('en'));
    const pool = english.length ? english : usable;

    let chosen: SpeechSynthesisVoice | null = null;
    for (const want of profile.prefer) {
      const hit = pool.find((v) => v.name === want)
        ?? pool.find((v) => v.name.toLowerCase().startsWith(want.toLowerCase()));
      if (hit) { chosen = hit; break; }
    }

    // Nothing preferred is installed. Spread the speakers across whatever this
    // platform does have, by index, so that four speakers on a machine with
    // four usable voices still get four different ones instead of all landing
    // on the default.
    if (!chosen && pool.length) {
      const order: RadioSpeaker[] = ['engineer', 'principal', 'control', 'driver'];
      const local = pool.filter((v) => v.localService);
      const spread = local.length >= 2 ? local : pool;
      chosen = spread[order.indexOf(speaker) % spread.length] ?? null;
    }

    this.resolved.set(speaker, chosen);
    return chosen;
  }

  /** Diagnostics for the probe: who ended up sounding like what. */
  describeVoices(): Record<RadioSpeaker, string> {
    const out = {} as Record<RadioSpeaker, string>;
    for (const s of Object.keys(SPEAKERS) as RadioSpeaker[]) {
      const v = this.voiceFor(s);
      const p = SPEAKERS[s];
      out[s] = `${v ? v.name + ' [' + v.lang + ']' : '(system default)'} rate=${p.rate} pitch=${p.pitch}`;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  /**
   * Queues one transmission. Returns its id, or null if it was not accepted.
   *
   * Not accepted covers: the radio is off, the browser cannot speak, the tab is
   * hidden, or an identically tagged message is already waiting and this one
   * replaced it.
   */
  speak(text: string, opts: RadioSpeakOptions = {}): number | null {
    if (!this.enabled || !this.chain || !TeamRadio.supported) return null;
    if (typeof document !== 'undefined' && document.hidden) return null;

    const clean = text.trim().slice(0, MAX_LINE_CHARS);
    if (!clean) return null;

    const speaker = opts.speaker ?? 'engineer';
    const priority = opts.priority ?? 0;
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

    const transmission: RadioTransmission = {
      id: this.nextId++,
      text: clean,
      speaker,
      leadMs: SPEECH_LEAD_MS,
      estimatedMs: estimateSpeechMs(clean, SPEAKERS[speaker].rate),
    };

    const item: QueueItem = {
      transmission,
      priority,
      expiresAt: now() + ttl,
      tag: opts.tag,
    };

    // A tagged message supersedes its own older self rather than joining it.
    if (opts.tag) {
      const at = this.queue.findIndex((q) => q.tag === opts.tag);
      if (at >= 0) this.queue.splice(at, 1);
    }

    // Insert by priority, stable within a priority so equals stay in order.
    let at = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < priority) { at = i; break; }
    }
    this.queue.splice(at, 0, item);

    // Cut off something less important. Equal priority never interrupts —
    // stepping on the engineer mid-sentence to say something no more urgent is
    // worse than waiting the two seconds.
    if (this.active && priority > this.activePriority) {
      this.stopActive('cancelled');
    }
    this.pump();
    return transmission.id;
  }

  /**
   * Queues a whole exchange — the driver asks, the wall answers — as separate
   * transmissions, each with its own squelch at both ends.
   *
   * They share a tag and a priority, so the exchange either supersedes an older
   * exchange in full or does not, and the turns cannot be split apart by
   * something arriving in the middle of them.
   */
  speakExchange(turns: readonly RadioTurnSpec[], opts: RadioSpeakOptions = {}): number[] {
    const ids: number[] = [];
    // The tail of a long exchange is stale by the time it would be reached, so
    // each turn gets a lifetime that grows with its position: turn four is
    // allowed to wait for the three in front of it, and no longer.
    let budget = opts.ttlMs ?? DEFAULT_TTL_MS;
    for (const [i, turn] of turns.entries()) {
      const id = this.speak(turn.text, {
        ...opts,
        speaker: turn.speaker,
        ttlMs: budget,
        tag: opts.tag ? `${opts.tag}#${i}` : undefined,
      });
      if (id !== null) ids.push(id);
      budget += estimateSpeechMs(turn.text, SPEAKERS[turn.speaker].rate)
        + SPEECH_LEAD_MS + SQUELCH_CLOSE_MS;
    }
    return ids;
  }

  /** Stops everything now: current transmission and everything waiting. */
  cancelAll(reason: RadioEndReason = 'cancelled'): void {
    for (const item of this.queue) this.emit({ type: 'end', transmission: item.transmission, reason });
    this.queue.length = 0;
    if (this.active) this.stopActive(reason);
  }

  /**
   * Starts the next message that is still worth saying.
   *
   * THE POINT OF THIS FUNCTION IS THE DROPPING, not the starting. A radio call
   * about a gap that closed four corners ago is worse than silence, so anything
   * whose lifetime ran out while it waited is thrown away here rather than
   * spoken late. A backlog is never drained.
   */
  private pump(): void {
    if (this.active || !this.chain || !this.enabled) return;
    if (typeof document !== 'undefined' && document.hidden) { this.cancelAll('hidden'); return; }

    const t = now();
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.expiresAt <= t) {
        this.queue.shift();
        this.emit({ type: 'end', transmission: item.transmission, reason: 'stale' });
        continue;
      }
      this.queue.shift();
      this.begin(item);
      return;
    }
  }

  private begin(item: QueueItem): void {
    const chain = this.chain;
    const ctx = this.ctx;
    if (!chain || !ctx) return;

    const transmission = item.transmission;
    const profile = SPEAKERS[transmission.speaker];
    this.active = transmission;
    this.activePriority = item.priority;
    this.sawBoundary = false;
    this.speechStarted = false;
    this.lastCharEnd = 0;

    // --- Key down ----------------------------------------------------------
    const at = ctx.currentTime;
    chain.open(at);
    this.duckFn?.(profile.duck, 0.06);

    // A poor link breaks the message up. The dropouts are scheduled up front
    // against the ESTIMATED length, because the real length is not known until
    // the synthesiser has finished — and a dropout scheduled late would land
    // after the squelch and sound like a separate glitch.
    const q = chain.quality;
    if (q < 0.55) {
      const severity = clamp01((0.55 - q) / 0.55);
      const span = transmission.estimatedMs / 1000;
      const count = Math.min(3, 1 + Math.floor(severity * 3));
      for (let i = 0; i < count; i++) {
        const frac = (i + 0.7) / (count + 0.4);
        chain.dropout(at + SPEECH_LEAD_MS / 1000 + span * frac, severity);
      }
    }

    this.emit({ type: 'open', transmission });

    // --- Speech ------------------------------------------------------------
    // Delayed by the squelch lead so the operator keys up before talking.
    this.after(SPEECH_LEAD_MS, () => this.utter(transmission, profile));
  }

  private utter(transmission: RadioTransmission, profile: SpeakerProfile): void {
    if (this.active !== transmission) return;
    const synth = window.speechSynthesis;

    // Chrome leaves the synthesiser wedged if a `speak` is issued in the same
    // task as a `cancel`, and a wedged synthesiser means a silent radio for the
    // rest of the session. Clearing first and speaking a beat later is cheap
    // insurance against a failure whose symptom is indistinguishable from the
    // feature being switched off.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      this.after(CANCEL_SETTLE_MS, () => this.utterNow(transmission, profile));
      return;
    }
    this.utterNow(transmission, profile);
  }

  private utterNow(transmission: RadioTransmission, profile: SpeakerProfile): void {
    if (this.active !== transmission) return;

    const u = new SpeechSynthesisUtterance(transmission.text);
    const voice = this.voiceFor(transmission.speaker);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = profile.rate;
    u.pitch = profile.pitch;
    u.volume = this.volume;
    this.activeUtterance = u;

    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (this.active !== transmission) return;
      // Some engines report sentence boundaries as well as word ones. Only the
      // word events are useful for a typewriter, and a sentence event would
      // rewind the reveal to the start of the sentence.
      if (ev.name && ev.name !== 'word') return;
      if (!this.sawBoundary) {
        this.sawBoundary = true;
        this.clearTimers();
        this.markSpeechStarted(transmission);
      }
      const charIndex = ev.charIndex ?? 0;
      const charLength = ev.charLength || this.wordLengthAt(transmission.text, charIndex);
      // Never move the reveal backwards; see the header note.
      if (charIndex + charLength <= this.lastCharEnd) return;
      this.lastCharEnd = charIndex + charLength;
      this.emit({ type: 'word', transmission, charIndex, charLength, estimated: false });
    };

    u.onend = () => { if (this.active === transmission) this.finish('complete'); };
    u.onerror = (ev: SpeechSynthesisErrorEvent) => {
      if (this.active !== transmission) return;
      // `interrupted` and `canceled` are our own doing and are already
      // accounted for by whoever called cancel.
      this.finish(ev.error === 'interrupted' || ev.error === 'canceled' ? 'cancelled' : 'error');
    };

    // If no boundary arrives, this platform does not send them; fall back.
    this.after(BOUNDARY_GRACE_MS, () => {
      if (this.active !== transmission || this.sawBoundary) return;
      this.markSpeechStarted(transmission);
      this.runEstimatedClock(transmission, BOUNDARY_GRACE_MS);
    });

    // Last resort. If neither `onend` nor `onerror` ever fires — which Chrome
    // does under memory pressure and some Android engines do routinely — the
    // radio would sit permanently "transmitting" and no further message would
    // ever play. Ending on a generous watchdog is the difference between one
    // lost line and a dead feature.
    this.after(transmission.estimatedMs + 6000, () => {
      if (this.active === transmission) this.finish('error');
    });

    window.speechSynthesis.speak(u);
  }

  private markSpeechStarted(transmission: RadioTransmission): void {
    if (this.speechStarted) return;
    this.speechStarted = true;
    this.emit({ type: 'speech', transmission });
  }

  /**
   * The fallback typewriter clock, for platforms with no boundary events.
   *
   * Words are spread across the remaining estimated time in proportion to their
   * length, which is a better model than an even split because "a" and
   * "understood" do not take the same time to say. `elapsed` is however long
   * was already burned waiting for a boundary that never came; the schedule is
   * compressed into what is left rather than starting from zero and running
   * past the end of the speech.
   */
  private runEstimatedClock(transmission: RadioTransmission, elapsedMs: number): void {
    const text = transmission.text;
    const words: { index: number; length: number }[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) words.push({ index: m.index, length: m[0].length });
    if (!words.length) return;

    const remaining = Math.max(transmission.estimatedMs * 0.5, transmission.estimatedMs - elapsedMs);
    const totalChars = words.reduce((s, w) => s + w.length, 0) || 1;

    let acc = 0;
    for (const w of words) {
      const at = (acc / totalChars) * remaining;
      acc += w.length;
      this.after(at, () => {
        if (this.active !== transmission) return;
        if (this.sawBoundary) return;
        if (w.index + w.length <= this.lastCharEnd) return;
        this.lastCharEnd = w.index + w.length;
        this.emit({
          type: 'word', transmission,
          charIndex: w.index, charLength: w.length, estimated: true,
        });
      });
    }
  }

  /** Length of the word starting at `at`, for engines that omit charLength. */
  private wordLengthAt(text: string, at: number): number {
    let end = at;
    while (end < text.length && !/\s/.test(text[end])) end++;
    return Math.max(1, end - at);
  }

  /** Ends the current transmission and lets the queue move on. */
  private finish(reason: RadioEndReason): void {
    const transmission = this.active;
    if (!transmission) return;
    this.clearTimers();
    this.active = null;
    this.activeUtterance = null;
    this.activePriority = -Infinity;

    const ctx = this.ctx;
    if (this.chain && ctx) this.chain.close(ctx.currentTime);
    // Restored on the key-up squelch rather than after it: the engine coming
    // back while the "kssht" is still going is exactly what an intercom does,
    // and waiting for silence leaves an audible hole.
    this.duckFn?.(0, 0.18);

    this.emit({ type: 'end', transmission, reason });

    // The next message starts after the squelch tail so two transmissions never
    // overlap and the key-up of one is not buried under the key-down of the
    // next.
    this.after(SQUELCH_CLOSE_MS + 90, () => this.pump(), true);
  }

  private stopActive(reason: RadioEndReason): void {
    if (!this.active) return;
    if (TeamRadio.supported && this.activeUtterance) {
      // Detach first: `cancel()` fires `onerror`/`onend` on the utterance and
      // we have already decided why this is ending.
      this.activeUtterance.onend = null;
      this.activeUtterance.onerror = null;
      this.activeUtterance.onboundary = null;
      window.speechSynthesis.cancel();
    }
    this.finish(reason);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * A timer belonging to the current transmission.
   *
   * `keep` marks the one timer that must survive the transmission ending — the
   * pump that starts the next message. Everything else is cancelled the moment
   * the transmission it belongs to is over, so a word event from a message that
   * was cut off can never land on top of the message that replaced it.
   */
  private after(ms: number, fn: () => void, keep = false): void {
    const id = window.setTimeout(fn, Math.max(0, ms));
    if (!keep) this.timers.push(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
  }

  private emit(ev: RadioEvent): void {
    for (const fn of this.listeners) {
      // One listener throwing must not take the audio down with it, nor stop
      // the other listeners from hearing about the transmission.
      try { fn(ev); } catch { /* a HUD fault is not an audio fault */ }
    }
  }

  dispose(): void {
    this.cancelAll('cancelled');
    this.clearTimers();
    this.listeners.clear();
    if (TeamRadio.supported) {
      window.speechSynthesis.removeEventListener?.('voiceschanged', this.onVoicesChanged);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.chain?.dispose();
    this.chain = null;
    this.ctx = null;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
