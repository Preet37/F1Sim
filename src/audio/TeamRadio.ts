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
 * ONE RADIO, ONE SWITCH — AND THE SWITCH IS NOT THIS CLOCK
 * ===========================================================================
 *
 * There is exactly one spoken radio in this game and exactly one control for
 * it: `GameSettings.teamRadioVoice`, on the Audio tab. The HUD used to carry a
 * second implementation with a second off-switch of its own (a 🔊 pip on the
 * card, backed by `localStorage['f1sim.radioVoice']`), and the two of them
 * fought over `speechSynthesis` — a global singleton that both called
 * `cancel()` on, so whichever spoke second killed the other. That is gone.
 * `src/ui/Hud.ts` now listens to this class and nothing else.
 *
 * THE EVENT STREAM IS NOT THE AUDIO SWITCH. `speak` is accepted, `open`,
 * `speech`, `word` and `end` are all emitted, and the typewriter runs at the
 * pace the line would be spoken at, WHETHER OR NOT THE VOICE IS ON. Turning
 * the voice off has to leave a working radio card, because the card is the
 * feature and the voice is a garnish on it — an earlier version of this class
 * returned `null` from `speak` when disabled, and since disabled is the
 * default, a HUD driven off this clock would have shown no card at all.
 *
 * With the voice on, the clock comes from the synthesiser's own `boundary`
 * events (see below). With it off, it comes from `estimateSpeechMs` and
 * `runEstimatedClock` — the same schedule, measured against real speech by
 * `scripts/probeRadio.ts`. The card reads the same either way; only the sound
 * is missing.
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
 * ONE VOICE, AND IT IS MALE. Reported directly:
 *
 *   "we also need one voice and use the male one not the female one i don't
 *    like that one."
 *
 * This used to give each speaker its own `prefer` list, and on macOS that
 * resolved to four different voices — Daniel, Reed, Moira and Rishi — two of
 * which are female and one of which is a different accent again. Four people in
 * one garage is not what was asked for. Every speaker now resolves to the SAME
 * voice, chosen once from `MALE_VOICES`, and the four are separated by `rate`
 * and `pitch` alone.
 *
 * That separation is not a consolation prize: it is the only differentiation
 * that works on the platforms that matter least — a locked-down Android with
 * exactly one system voice was always going to sound like one person — so it
 * was already carrying the load everywhere except macOS. The values are set to
 * audibly different figures rather than to small tasteful offsets for that
 * reason.
 */
interface SpeakerProfile {
  rate: number;
  pitch: number;
  /** Ducking depth applied to the rest of the mix while this person talks. */
  duck: number;
}

const SPEAKERS: Record<RadioSpeaker, SpeakerProfile> = {
  // The race engineer. Unflappable, slightly quick because he is reading
  // numbers off a screen while the car is moving. He is the default and he says
  // most of what gets said, so he is the one at the natural rate and pitch.
  engineer: { rate: 1.08, pitch: 0.95, duck: 0.55 },
  // The team principal. Older, lower, slower — he is not in a hurry, and the
  // contrast with the engineer is the point.
  principal: { rate: 0.90, pitch: 0.74, duck: 0.6 },
  // Race control. Official and flat. It cannot be a different ACCENT any more
  // — there is one voice — so it is a different DELIVERY: dead level pitch and
  // an unhurried rate, which is what a read-out from an official channel
  // sounds like next to a man watching a car.
  control: { rate: 0.98, pitch: 1.00, duck: 0.65 },
  // The player's own driver, in a helmet at 300 km/h: quick and up in pitch,
  // which is what talking under load does to a voice.
  driver: { rate: 1.18, pitch: 1.12, duck: 0.5 },
};

/**
 * The voice, in order of preference. MALE, on every platform we ship to.
 *
 * There is no gender field on `SpeechSynthesisVoice`. The spec has `name`,
 * `lang`, `voiceURI`, `localService` and `default`, and that is the whole
 * interface — so "use the male one" cannot be expressed as a query and has to
 * be expressed as a LIST. This is that list, ordered so the best voice present
 * on each platform wins:
 *
 *   macOS / iOS      Daniel, Arthur, Oliver, Alex, Aaron, Reed, Gordon, Rishi
 *   Windows          Microsoft George, Ryan, Guy, David, Mark
 *   Chrome / Android Google UK English Male, and the network en-GB-x-gbb voices
 *
 * Names are matched exactly first and by prefix second, because Chrome reports
 * Apple's voices as "Daniel" on some versions and "Daniel (English (United
 * Kingdom)))" on others, and the same voice must not be missed over a suffix.
 */
const MALE_VOICES: readonly string[] = [
  'Daniel', 'Google UK English Male', 'Microsoft George', 'Microsoft Ryan',
  'Microsoft Guy', 'Arthur', 'Oliver', 'Gordon', 'Reed', 'Alex', 'Aaron',
  'Microsoft David', 'Microsoft Mark', 'Rishi', 'Lee', 'Tom', 'Rocko',
  'en-GB-Standard-B', 'en-gb-x-gbb', 'en-us-x-iom',
];

/**
 * Voices known to be female, so a FALLBACK cannot quietly land on one.
 *
 * The list above is a preference; this one is a prohibition, and it exists
 * because the two failure modes are not symmetric. Missing a male voice costs
 * an accent. Falling back onto a female voice is the specific thing that was
 * reported, and a fallback that can produce it is a fallback that will produce
 * it on somebody's machine.
 *
 * Where neither list matches — an unknown voice on an unknown platform — the
 * voice is used but `voiceReport().certainty` says `'unknown'`, because
 * claiming a voice is male on the strength of not recognising its name would be
 * a claim about something never measured. Where every candidate is on THIS
 * list, nothing is chosen at all and the system default is used, and the report
 * says so. `scripts/probeRadio.ts` prints the report on every run.
 */
const FEMALE_VOICES = new Set([
  'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'serena', 'kate',
  'allison', 'ava', 'susan', 'zoe', 'nicky', 'veena', 'isha', 'kathy',
  'princess', 'shelley', 'flo', 'grandma', 'martha', 'matilda', 'nathalie',
  'nora', 'anna', 'ellen', 'amelie', 'joana', 'luciana', 'melina', 'milena',
  'paulina', 'sara', 'yuna', 'ting-ting', 'mei-jia', 'kyoko', 'carmit',
  'damayanti', 'ioana', 'kanya', 'laila', 'lana', 'lesya', 'montse', 'zosia',
  'zuzana', 'sin-ji', 'alva', 'amira', 'satu', 'yelda',
  'microsoft zira', 'microsoft hazel', 'microsoft eva', 'microsoft linda',
  'microsoft heera', 'microsoft susan', 'microsoft catherine',
  'google us english', 'google uk english female',
]);

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

/**
 * A voice's name reduced to the token the lists are keyed on.
 *
 * Chrome reports the same Apple voice as "Daniel" and as
 * "Daniel (English (United Kingdom))" depending on version, so the parenthesised
 * part is dropped before matching. The Microsoft and Google names are multi-word
 * and are matched whole.
 */
function voiceKey(name: string): string {
  return name.replace(/\s*\(.*$/, '').trim().toLowerCase();
}

// --- Timing ----------------------------------------------------------------

/**
 * How long to wait for a `boundary` event before falling back, while it is
 * still unknown whether this platform sends them at all.
 *
 * Generous, because the cost of the two mistakes is wildly asymmetric. Falling
 * back too early on a platform that DOES send boundaries starts the typewriter
 * ahead of the voice, which is the exact failure this whole design exists to
 * avoid. Falling back too late costs a late first line, once.
 *
 * It has to be generous because the lead is a cold-start effect and is not
 * stable: measured across runs on the same machine, the gap between `onstart`
 * and the first boundary was 918, 1030, 1959 and 2419 ms for the first
 * utterance of the session, and around 105 ms for every one after it. Any fixed
 * threshold tight enough to be useful is loose enough to be wrong sometimes,
 * which is why this is only used until the answer is known.
 */
const BOUNDARY_GRACE_UNKNOWN_MS = 4000;

/**
 * The same wait once we have established this platform does not send
 * boundaries. Short, because there is nothing to wait for.
 */
const BOUNDARY_GRACE_KNOWN_MS = 250;

/**
 * Characters per second of speech at rate 1.0, for the fallback clock.
 *
 * Calibrated against real speech across four lines of different lengths and
 * punctuation, measured from the FIRST BOUNDARY to `onend` — not from
 * `onstart`, which is what makes this number honest. An earlier version of it
 * was fitted to an `onstart`-to-`onend` span and was therefore 30% slow,
 * because that span includes the second or so the OS speech service spends
 * warming up before it makes any sound. Measuring the wrong interval and
 * fitting a constant to it is how a plausible number gets into a codebase.
 *
 * Measured, at rate 1.08 (characters, sentence stops, spoken ms):
 *
 *    62, 3, 3840      16.1 c/s      39, 1, 1971      19.8 c/s
 *    69, 3, 4309      16.0 c/s      10, 0,  630      15.9 c/s
 *
 * Three of the four cluster at 16 c/s at rate 1.08; the short conversational
 * one runs faster. 16.8 c/s plus 100 ms per stop fits all four within 14%.
 * `scripts/probeRadio.ts` re-measures on every run and fails past 25%.
 */
export const SPEECH_CHARS_PER_SEC = 16.8;
/** Extra time a sentence-ending stop adds, ms at rate 1.0. */
export const SPEECH_SENTENCE_PAUSE_MS = 100;

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
  /**
   * Whether this line is SAID OUT LOUD. Default true.
   *
   * `false` runs the whole transmission — the events, the typewriter clock,
   * the timing — with no voice and no squelch behind it. The card types the
   * line at the pace it would have been spoken at, and nothing is audible.
   *
   * WHAT IT IS FOR, in the player's own words:
   *
   *   "i just atp wouldn't say anything for the audio if its a conversation
   *    because you don't need to be saying what the driver says ykwim?"
   *
   * The driver is the player. Hearing a synthesised stranger say your own
   * replies back to you is the one part of this that cannot be improved by a
   * better voice, and every real onboard has the same asymmetry: the pit wall
   * arrives over the radio and the driver's own half is just... you. So
   * `src/ui/Hud.ts` marks every `driver` turn unvoiced.
   *
   * NOT THE SAME AS SKIPPING THE TURN, and that distinction is the whole
   * reason this is a flag on a real transmission rather than a `continue` in
   * the HUD. A reply takes time to say. If the card snapped through the silent
   * turns it would type the wall's line at a speaking pace and then flick
   * instantly through the answer, which reads as a bug. The estimated clock
   * paces it exactly as if it were being spoken, off the same schedule the
   * voice would have used.
   */
  voiced?: boolean;
}

export interface RadioTransmission {
  readonly id: number;
  readonly text: string;
  readonly speaker: RadioSpeaker;
  /** ms between the key-down squelch and the first word. */
  readonly leadMs: number;
  /** Best estimate of the spoken duration, ms. Not authoritative — words are. */
  readonly estimatedMs: number;
  /** Whether this line is said out loud. See `RadioSpeakOptions.voiced`. */
  readonly voiced: boolean;
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
 *
 * THE LISTENER MUST REVEAL THE WHOLE LINE ON `end`, whatever the word events
 * did or did not say. There are real cases with no word events at all — a short
 * line on a platform that turns out not to send boundaries, or a message cut
 * off by something more urgent — and a typewriter that only ever advances on
 * `word` would leave those half-typed on screen. `end` is the backstop.
 */
type RadioEventBody =
  | { type: 'open'; transmission: RadioTransmission }
  | { type: 'speech'; transmission: RadioTransmission }
  | {
      type: 'word'; transmission: RadioTransmission;
      charIndex: number; charLength: number; estimated: boolean;
    }
  | { type: 'end'; transmission: RadioTransmission; reason: RadioEndReason };

/**
 * Every event carries `atMs`, a `performance.now()` reading taken as it is
 * emitted.
 *
 * NOT DECORATION, AND NOT FOR THE HUD — which never reads it. It exists so the
 * central claim of this file can be ASSERTED rather than asserted-about.
 * "`speech` is emitted on the first `boundary`, never on `onstart`" is the one
 * measurement the whole design rests on, and without timestamps the only thing
 * a test can check is the ORDER of the events — which is identical either way,
 * because `onstart` also precedes the first word. Moving `markSpeechStarted`
 * into `onstart` reintroduces a 1.1-second desync between the voice and the
 * typewriter and leaves every ordering check green.
 *
 * With timestamps, `scripts/probeRadio.ts` can require that `speech` and the
 * first real boundary land in the SAME TASK — they are emitted from the same
 * synchronous block, so anything more than a few milliseconds apart means
 * somebody moved one of them. See the SPEECH section of that probe.
 */
export type RadioEvent = RadioEventBody & { atMs: number };

export type RadioListener = (ev: RadioEvent) => void;

/** One line in a multi-turn exchange. */
export interface RadioTurnSpec {
  speaker: RadioSpeaker;
  text: string;
  /** See `RadioSpeakOptions.voiced`. Default true. */
  voiced?: boolean;
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
  private destination: AudioNode | null = null;
  private chain: RadioChain | null = null;
  private duckFn: DuckFn | null = null;

  private enabled = false;
  private volume = 1;
  /** Held here so it survives being set before the chain is built. */
  private linkQuality = 1;

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
  /** Whether the current transmission was actually handed to the synthesiser. */
  private spoke = false;
  private lastCharEnd = 0;
  /** True while the chain is keyed for the current transmission. */
  private chainOpen = false;
  /**
   * Wall-clock time before which nothing new may key down.
   *
   * Armed by `finish` and read by `pump`. See the note in `pump`.
   */
  private pumpNotBefore = 0;

  /**
   * Whether this platform sends `boundary` events, learned rather than assumed.
   *
   * Asked once and remembered, because the question cannot be answered by
   * feature detection: `onboundary` is present on the utterance prototype in
   * every browser, including the ones that never fire it. The only way to know
   * is to speak something and see.
   */
  private boundarySupport: 'unknown' | 'yes' | 'no' = 'unknown';

  private voices: SpeechSynthesisVoice[] = [];
  private voicesReady = false;
  /**
   * THE voice — one, shared by all four speakers. See `voiceFor`.
   *
   * `voiceResolved` is separate from `voice !== null` because null is a real
   * answer: it means "no male voice on this platform, use the system default",
   * and re-running the search every transmission to arrive at null again would
   * be work for nothing.
   */
  private voice: SpeechSynthesisVoice | null = null;
  private voiceResolved = false;
  private voiceCertainty: 'male' | 'none' | 'no-voices' = 'no-voices';

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
   *
   * DOES NOT BUILD THE CHAIN. `RadioChain` is twelve nodes including six
   * biquads, a 2× oversampled WaveShaper, a compressor, a looping noise source
   * and an oscillator, and this feature is OFF BY DEFAULT — so building it here
   * put all of that in the render graph of every session ever played, for a
   * player who had never asked for it. It is built on the first `setEnabled`
   * instead, which is a settings click and therefore has a whole frame to
   * spare, and once built it stays: rebuilding per transmission would move the
   * allocation into the middle of a race, which is the more expensive mistake.
   */
  attach(ctx: BaseAudioContext, destination: AudioNode, duck: DuckFn): void {
    if (this.destination) return;
    this.ctx = ctx;
    this.destination = destination;
    this.duckFn = duck;
    if (this.enabled) this.ensureChain();
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

  /** Builds the link's nodes, once, the first time anybody wants a sound. */
  private ensureChain(): RadioChain | null {
    if (this.chain) return this.chain;
    const ctx = this.ctx;
    const destination = this.destination;
    if (!ctx || !destination) return null;
    this.chain = new RadioChain(ctx, destination);
    this.chain.setLinkQuality(this.linkQuality);
    return this.chain;
  }

  /**
   * Off by default. A synthesised voice is a matter of taste in a way that an
   * engine note is not, and the honest assessment of this feature is that it is
   * good but not unarguably good — so it is the player's call, not ours.
   *
   * THIS IS THE AUDIO SWITCH AND NOTHING ELSE. Turning it off silences the
   * voice, the squelch and the noise bed; it does not stop transmissions being
   * queued, does not stop the events, and does not take the radio card off the
   * screen. A message already being spoken carries on typing on the estimated
   * clock rather than vanishing mid-sentence.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.ensureChain();
    else this.silenceActive();
  }

  get isEnabled(): boolean { return this.enabled; }

  /**
   * Spends a user gesture on unlocking the speech engine.
   *
   * WHY THIS EXISTS: iOS SAFARI. WebKit requires user activation before
   * `speechSynthesis.speak()` will produce sound, and every call this class
   * makes is from a `setTimeout` — deliberately, because the words have to
   * follow the key-down squelch by `SPEECH_LEAD_MS` — which is outside the
   * activation window. Left alone, the radio would be silent on iOS and would
   * look exactly like the setting not working.
   *
   * The Settings toggle click IS a gesture, so it is spent here on a silent,
   * near-instant utterance whose only purpose is to be the first `speak()` of
   * the session and to happen inside activation. Everything after it inherits
   * the unlocked engine.
   *
   * HONESTY, because this is a claim about a platform: this has NOT been run on
   * real iOS hardware. It is written from WebKit's documented activation rule
   * and from the same priming pattern the AudioContext unlock in `main.ts`
   * uses. On a platform that does not need it, it costs one inaudible
   * utterance. See PROJECT.md §7 — it is listed there as untested.
   */
  primeSpeech(): void {
    if (!TeamRadio.supported) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      // Rate 10 rather than 1 so it is over before the player's finger is off
      // the switch; a primer that occupies the synthesiser is a primer that
      // delays the first real line.
      u.rate = 10;
      window.speechSynthesis.speak(u);
    } catch { /* a browser that refuses the primer will refuse the radio too */ }
  }

  /** Follows the master volume so "Off" in settings silences the voice too. */
  setVolume(v: number): void {
    this.volume = clamp01(v);
  }

  /**
   * Link quality, 0..1, from the car's distance to the pit wall. Below about
   * 0.55 transmissions start breaking up.
   */
  setLinkQuality(q: number): void {
    this.linkQuality = clamp01(q);
    this.chain?.setLinkQuality(this.linkQuality);
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
    // The list arriving late is the normal case on macOS Chrome — measured, it
    // was empty for 2.5 s after load and then held 180 voices. Anything decided
    // before that was decided on no information, so it is decided again.
    this.voiceResolved = false;
  }

  /**
   * THE voice. One, for the whole game, and MALE.
   *
   *   "we also need one voice and use the male one not the female one i don't
   *    like that one."
   *   "also like i said get rid of the female voice. only keep the male voice."
   *
   * Said twice, the second time unprompted and with "like i said" in front of
   * it. So this is not a preference to be balanced against having a voice at
   * all: **a null return means NOTHING IS SPOKEN.** `begin` reads it and runs
   * the transmission on the silent clock — the card still types, at the pace
   * the line would have been said at, and nobody hears a stranger.
   *
   * WHAT WAS WRONG WITH THE OBVIOUS FALLBACK. The first version of this took
   * "the first voice that is not on the known-female list" when `MALE_VOICES`
   * matched nothing. That is exactly the mechanism that lets a female voice in:
   * `FEMALE_VOICES` is a list of names somebody typed, `getVoices()` is
   * platform-dependent and unbounded, and "whatever came first" on an unknown
   * platform is a coin toss dressed up as a rule. There is no guess any more.
   * Either a name off `MALE_VOICES` is present, or the radio does not speak.
   *
   * THE COST IS NAMED RATHER THAN HIDDEN: on a platform whose male voices are
   * all called something not on that list, the spoken radio is silent even with
   * the setting on. `voiceReport().certainty` says `'none'`, `probe:radio`
   * prints it and fails, and the fix is to add that platform's voice to the
   * list — one line, in a list written for exactly that.
   *
   * Resolved once and cached: a race engineer who is a different man each time
   * he keys up is worse than any individual choice of man. The cache is only
   * armed once `getVoices()` has actually returned something, because on macOS
   * Chrome it returns an empty array for the first 2.5 seconds and caching that
   * would mean permanent silence on the platform with the best voices.
   */
  private voiceFor(): SpeechSynthesisVoice | null {
    if (!this.voicesReady) this.refreshVoices();
    if (this.voiceResolved) return this.voice;

    if (!this.voices.length) {
      // Not an answer, just an absence. Do NOT arm the cache — `voiceschanged`
      // or the next call will try again.
      this.voiceCertainty = 'no-voices';
      return null;
    }
    this.voiceResolved = true;

    const usable = this.voices.filter((v) => !DENIED_VOICES.has(voiceKey(v.name)));
    const english = usable.filter((v) => v.lang.toLowerCase().startsWith('en'));
    const pool = english.length ? english : usable;

    // The preference list, exact name first and prefix second. Nothing else.
    for (const want of MALE_VOICES) {
      const hit = pool.find((v) => v.name === want)
        ?? pool.find((v) => voiceKey(v.name) === want.toLowerCase())
        ?? pool.find((v) => v.name.toLowerCase().startsWith(want.toLowerCase()));
      // A name on the male list that is ALSO on the female list is a name
      // somebody has got wrong. Refuse it rather than resolve the contradiction
      // silently in favour of speaking.
      if (hit && !FEMALE_VOICES.has(voiceKey(hit.name))) {
        this.voice = hit;
        this.voiceCertainty = 'male';
        return this.voice;
      }
    }

    // Nothing on the list is installed. Silence, and say so.
    this.voice = null;
    this.voiceCertainty = 'none';
    return null;
  }

  /**
   * What the voice search actually found, for the probe and for the report.
   *
   * EXISTS SO THE CLAIM CAN BE CHECKED. "one male voice" is a promise about
   * every platform this game runs on, and it is made from a hard-coded list of
   * names because `SpeechSynthesisVoice` carries no gender. A list of names is
   * exactly the kind of thing that is right on the machine it was written on
   * and wrong everywhere else, so what it resolved to is reported rather than
   * assumed. `scripts/probeRadio.ts` prints it and fails if it is female.
   */
  voiceReport(): { name: string; lang: string; certainty: string; candidates: number } {
    const v = this.voiceFor();
    return {
      name: v ? v.name : '(silent — no male voice)',
      lang: v ? v.lang : '',
      certainty: this.voiceCertainty,
      candidates: this.voices.length,
    };
  }

  /** Diagnostics for the probe: who ended up sounding like what. */
  describeVoices(): Record<RadioSpeaker, string> {
    const out = {} as Record<RadioSpeaker, string>;
    const v = this.voiceFor();
    for (const s of Object.keys(SPEAKERS) as RadioSpeaker[]) {
      const p = SPEAKERS[s];
      out[s] = `${v ? v.name + ' [' + v.lang + ']' : '(silent — no male voice)'} rate=${p.rate} pitch=${p.pitch}`;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  /**
   * Queues one transmission. Returns its id, or null if it was not accepted.
   *
   * NOT GATED ON THE VOICE SETTING, and that is the point — see the header.
   * A transmission is a thing that happens in the race; whether it is spoken
   * aloud is a preference about the sound. The card, the typewriter and the
   * events run either way.
   *
   * Not accepted covers exactly two things: the line is empty, or the tab is
   * hidden and there is nobody to show it to.
   */
  speak(text: string, opts: RadioSpeakOptions = {}): number | null {
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
      voiced: opts.voiced !== false,
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
    //
    // `stopActive` runs `finish`, which keys the transmitter DOWN at
    // `ctx.currentTime` and arms `pumpNotBefore`. The `pump` below therefore
    // declines and the one `finish` scheduled starts the interrupting message
    // after the key-up tail — which is the whole point. Without that guard the
    // interrupt ran `RadioChain.open` at the same context time as the `close`
    // before it, and `open`'s `cancelScheduledValues(at)` wipes every ramp at
    // or after `at`: the entire key-up swell, deleted. Silently, on the path a
    // driver hears most — a safety car cutting off a strategy call.
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
        voiced: turn.voiced ?? opts.voiced,
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
    if (this.active) return;
    // THE SQUELCH GUARD. Nothing may key down until the last key-up has had its
    // tail. `finish` arms this and schedules the pump that clears it, so every
    // caller here — a new `speak`, a turn of a `speakExchange`, an interrupt —
    // is held behind the same 220 ms whether it knows about it or not.
    if (now() < this.pumpNotBefore) return;
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
    const transmission = item.transmission;
    const profile = SPEAKERS[transmission.speaker];
    this.active = transmission;
    this.activePriority = item.priority;
    this.sawBoundary = false;
    this.speechStarted = false;
    this.lastCharEnd = 0;
    this.chainOpen = false;
    this.spoke = false;

    // --- The audio half, which only exists when the player asked for it -----
    //
    // `transmission.voiced` is the second gate, and it is not the same gate.
    // The setting is the player's; this one is the LINE's — the driver's own
    // replies are never said aloud, because the driver is the player. An
    // unvoiced line gets no squelch either: two bursts of hiss with nothing
    // between them is not a transmission, it is a fault.
    const voice = this.enabled && TeamRadio.supported && transmission.voiced
      && this.voiceFor() !== null;
    const chain = voice ? this.ensureChain() : null;
    const ctx = this.ctx;
    if (chain && ctx) {
      const at = ctx.currentTime;
      chain.open(at);
      this.chainOpen = true;
      this.duckFn?.(profile.duck, 0.06);

      // A poor link breaks the message up. The dropouts are scheduled up front
      // against the ESTIMATED length, because the real length is not known
      // until the synthesiser has finished — and a dropout scheduled late would
      // land after the squelch and sound like a separate glitch.
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
    }

    // --- The event half, which always runs ---------------------------------
    this.emit({ type: 'open', transmission });

    // Delayed by the squelch lead so the operator keys up before talking. The
    // silent path waits the same beat, so a card raised with the voice off has
    // the same rhythm as one raised with it on — the point of the whole design
    // is that the two agree.
    this.after(SPEECH_LEAD_MS, () => {
      if (this.active !== transmission) return;
      if (this.chainOpen && voice) this.utter(transmission, profile);
      else this.runSilentTransmission(transmission, 0);
    });
  }

  /**
   * A transmission with no voice behind it: the estimated clock, and an ending.
   *
   * Used three ways — the voice is switched off, the browser cannot speak at
   * all, and the player switches the voice off mid-sentence. In every case the
   * card must keep typing at the pace the words would have been said, and must
   * finish, because the HUD's dwell begins at `end`.
   */
  private runSilentTransmission(t: RadioTransmission, elapsedMs: number): void {
    // Cleared so `runEstimatedClock`'s guard lets it run: a transmission that
    // was speaking and is now not has already seen boundaries, and they are no
    // longer coming.
    this.sawBoundary = false;
    this.markSpeechStarted(t);
    const remaining = this.runEstimatedClock(t, elapsedMs);
    this.after(remaining + 120, () => {
      if (this.active === t) this.finish('complete');
    });
  }

  /**
   * Stops the sound without stopping the transmission.
   *
   * The player has turned the voice off while somebody is talking. Cutting the
   * card off with them would be the wrong reading of that switch — they asked
   * for quiet, not for the radio to stop working — so the words carry on at the
   * pace they were being spoken at.
   */
  private silenceActive(): void {
    const t = this.active;
    if (this.activeUtterance && TeamRadio.supported) {
      this.activeUtterance.onend = null;
      this.activeUtterance.onerror = null;
      this.activeUtterance.onboundary = null;
      window.speechSynthesis.cancel();
      this.activeUtterance = null;
    }
    this.closeChain();
    if (!t) return;
    // Whatever has already been revealed stays revealed; the clock picks up
    // from there rather than restarting the line.
    const done = t.text.length ? this.lastCharEnd / t.text.length : 1;
    this.clearTimers();
    this.runSilentTransmission(t, t.estimatedMs * clamp01(done));
  }

  /** Keys the transmitter up, if it was ever keyed down. */
  private closeChain(): void {
    if (!this.chainOpen) return;
    this.chainOpen = false;
    const ctx = this.ctx;
    if (this.chain && ctx) this.chain.close(ctx.currentTime);
    // Restored on the key-up squelch rather than after it: the engine coming
    // back while the "kssht" is still going is exactly what an intercom does,
    // and waiting for silence leaves an audible hole.
    this.duckFn?.(0, 0.18);
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
    const voice = this.voiceFor();
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
        this.boundarySupport = 'yes';
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
    const grace = this.boundarySupport === 'no'
      ? BOUNDARY_GRACE_KNOWN_MS
      : BOUNDARY_GRACE_UNKNOWN_MS;
    this.after(grace, () => {
      if (this.active !== transmission || this.sawBoundary) return;
      this.boundarySupport = 'no';
      this.markSpeechStarted(transmission);
      this.runEstimatedClock(transmission, grace);
    });

    // Last resort. If neither `onend` nor `onerror` ever fires — which Chrome
    // does under memory pressure and some Android engines do routinely — the
    // radio would sit permanently "transmitting" and no further message would
    // ever play. Ending on a generous watchdog is the difference between one
    // lost line and a dead feature.
    this.after(transmission.estimatedMs + 6000, () => {
      if (this.active === transmission) this.finish('error');
    });

    this.spoke = true;
    window.speechSynthesis.speak(u);
  }

  /**
   * Emits `speech` — "the first word is audible now, start typing".
   *
   * CALLED FROM THE FIRST `boundary` AND NEVER FROM `onstart`. That single
   * choice is the whole reason this class exists rather than the HUD calling
   * `speechSynthesis.speak` itself, and it is asserted, not merely commented:
   * `scripts/probeRadio.ts` reads `RadioEvent.atMs` and fails if `speech` and
   * the first real `word` are not emitted in the same task. Moving this call
   * into `onstart` puts them 1.1 s apart and the probe goes red naming the
   * number.
   */
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
  private runEstimatedClock(transmission: RadioTransmission, elapsedMs: number): number {
    const text = transmission.text;
    const remaining = Math.max(transmission.estimatedMs * 0.5, transmission.estimatedMs - elapsedMs);
    const words: { index: number; length: number }[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) words.push({ index: m.index, length: m[0].length });
    if (!words.length) return remaining;

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
    return remaining;
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

    // A transmission that ran to completion without ever reporting a word is
    // proof this platform does not send boundaries, and it is the ONLY proof
    // available for a short line: "Understood." is over in 630 ms, so the
    // four-second grace that would otherwise have established it never gets to
    // run. Without this, a boundary-less platform whose lines are all short
    // would stay 'unknown' forever and never fall back at all.
    //
    // `spoke` is what keeps that inference honest. A transmission that ran with
    // the voice switched off also completes with no boundaries, and it says
    // NOTHING about the platform — concluding 'no' from it would poison the
    // grace period for every line spoken after the player turned the voice on.
    if (reason === 'complete' && this.spoke && !this.sawBoundary
      && this.boundarySupport === 'unknown') {
      this.boundarySupport = 'no';
    }

    this.clearTimers();
    this.active = null;
    this.activeUtterance = null;
    this.activePriority = -Infinity;

    this.closeChain();

    this.emit({ type: 'end', transmission, reason });

    // The next message starts after the squelch tail so two transmissions never
    // overlap and the key-up of one is not buried under the key-down of the
    // next. Both halves matter: the timer starts it, and `pumpNotBefore` stops
    // anything else starting it sooner.
    this.pumpNotBefore = now() + SQUELCH_CLOSE_MS + 90;
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

  private emit(body: RadioEventBody): void {
    const ev = { ...body, atMs: now() } as RadioEvent;
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
