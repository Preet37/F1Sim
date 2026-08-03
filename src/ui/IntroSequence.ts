import './career.css';
import { CarStage, type StageLook } from '../render/CarStage';

/**
 * The opening sequence.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is IN-ENGINE, which was the requirement — "yeah render the game scenes
 * like rendered in engine yourself". Every frame is the real car: the same
 * `buildCar` geometry the race puts on the track, the same generated livery
 * canvas, the same filmic tone mapping, the same `RainCurtain` shader the wet
 * race draws its weather with. Nothing here is a video, a still, or a drawing
 * of a car.
 *
 * IT IS NOW WET, AND IT MOVES. The first version of this was a car parked in a
 * dry hall with the type changing over it, and the verdict on the whole front
 * end — "this isn't how a game UI looks like" — applied to it as much as to
 * the menu. A title sequence is a piece of DIRECTION: a subject, weather, and
 * a camera that cuts. So the car now stands in the rain at night, in a rig of
 * coloured light that runs down the wet ground in front of it, and the camera
 * cuts between five framings and eases into each one — head on, down the
 * flank, over the rear wing, at kerb height — with a slow dolly drift laid
 * over the top so no shot is ever dead still.
 *
 * IT IS STILL NOT A FLY-THROUGH OF A CIRCUIT, and that remains a decision
 * rather than a shortfall. Building a circuit costs a racing-line solve and
 * several hundred milliseconds of geometry, and the one thing an opening
 * sequence must never do is make somebody wait to be allowed to start.
 * `CarStage` is up in one frame and runs at thirty. What it gained instead is
 * everything the rain and the camera give, for one extra draw call.
 *
 * ---------------------------------------------------------------------------
 * THE SKIP IS PART OF THE DESIGN, NOT AN ESCAPE HATCH
 * ---------------------------------------------------------------------------
 *
 * The button is in the bottom right FROM THE FIRST FRAME — not faded in after
 * two seconds, which is the thing that makes people hate opening sequences.
 * Escape, Enter and Space skip it, and so does any gamepad button, which is
 * polled because a gamepad does not raise keyboard events.
 *
 * It plays ONCE. After the first run a flag is set and the game goes straight
 * to the menu; the menu keeps a way to play it again for anybody who wants it.
 *
 * `prefers-reduced-motion` gets the whole thing as one still card with the car
 * parked at the three-quarter angle — `CarStage` already honours the setting by
 * stopping its turntable — and no timed beats at all. That is a real
 * alternative rather than a degraded one: the sequence's content is four
 * sentences, and somebody who cannot watch them arrive can read them at once.
 */

export interface IntroBeat {
  /** Seconds from the start of the sequence. */
  at: number;
  /** The line, in the display face. */
  title: string;
  /** The line under it, in prose. */
  sub?: string;
  /** Livery to swap the car to as this beat opens. */
  livery?: { colour: number; accent: number; number?: number; code?: string };
  /** Where the camera goes for this beat. The cut; the ease is the stage's. */
  look?: StageLook;
  /**
   * The last beat, which is the title card.
   *
   * It gets the wordmark rather than a line of copy, because a title sequence
   * that never says the name of the thing is a mood board.
   */
  card?: boolean;
}

export interface IntroOptions {
  /** Where the sequence mounts. Usually the screen root. */
  host: HTMLElement;
  beats: readonly IntroBeat[];
  /** Total run time. The last beat holds until this. */
  durationS: number;
  quality?: 'low' | 'high';
  /**
   * The colours of the light rig behind the car — the player's own helmet.
   * Empty on a genuine first run, where there is nobody to light it for yet
   * and the rain is lit by nothing but the rim.
   */
  streaks?: readonly number[];
  /** Called once, whether the sequence ran out or was skipped. */
  onDone: (skipped: boolean) => void;
}

export class IntroSequence {
  private readonly root: HTMLElement;
  private readonly opts: IntroOptions;
  private stage: CarStage | null = null;
  private raf = 0;
  private startedAt = 0;
  private beatIndex = -1;
  private done = false;
  private readonly reduced: boolean;

  /**
   * Gamepad buttons held at the moment the sequence opened.
   *
   * Recorded so that the press that STARTED the game does not immediately skip
   * the sequence it started. A gamepad has no key-up event to wait for and the
   * button is still down a frame later.
   */
  private gamepadArmed = false;

  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly barFill: HTMLElement;


  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      this.finish(true);
    }
  };

  constructor(opts: IntroOptions) {
    this.opts = opts;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.root = document.createElement('div');
    this.root.className = 'intro' + (this.reduced ? ' intro-still' : '');
    opts.host.appendChild(this.root);

    // The car, behind everything.
    const stageHost = document.createElement('div');
    stageHost.className = 'intro-stage';
    this.root.appendChild(stageHost);

    const first = opts.beats[0]?.livery ?? { colour: 0x1f56d6, accent: 0xffc61a };
    try {
      this.stage = new CarStage({
        ...first,
        quality: opts.quality ?? 'high',
        still: this.reduced,
        set: 'wet',
        streaks: opts.streaks,
        look: opts.beats[0]?.look ?? 'nose',
      });
      this.stage.setDrift(true);
      this.stage.mount(stageHost);
    } catch (err) {
      // A refused GL context must not be able to lock somebody out of the game
      // behind a sequence that will not play.
      console.warn('Intro stage unavailable; the sequence plays as type only.', err);
      this.stage = null;
    }

    // The type, over it.
    const copy = document.createElement('div');
    copy.className = 'intro-copy';
    this.root.appendChild(copy);
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'intro-title';
    this.subEl = document.createElement('div');
    this.subEl.className = 'intro-sub';
    copy.append(this.titleEl, this.subEl);

    // The skip. First child of the controls so it is in the tab order before
    // anything else, and present in the DOM from this frame.
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'intro-skip';
    skip.innerHTML = '<span>Skip</span><kbd>ESC</kbd>'
      + '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="2.4" stroke-linecap="square">'
      + '<path d="M5 5 L13 12 L5 19"/><path d="M17 5 L17 19"/></svg>';
    skip.addEventListener('click', () => this.finish(true));
    this.root.appendChild(skip);
    // Focused, so the very first Tab, Enter or d-pad press lands on the one
    // control the sequence has. `preventScroll` because focusing a fixed
    // element at the bottom of a full-bleed layer scrolls the page under it on
    // iOS, which shifts the whole picture up by the height of the button.
    skip.focus({ preventScroll: true });

    const bar = document.createElement('div');
    bar.className = 'intro-bar';
    this.barFill = document.createElement('span');
    bar.appendChild(this.barFill);
    this.root.appendChild(bar);

    window.addEventListener('keydown', this.onKey);

    if (this.reduced) {
      // Every line at once, and no clock. See the note at the head of the file.
      this.titleEl.textContent = opts.beats[opts.beats.length - 1]?.title ?? '';
      this.subEl.textContent = opts.beats.map((b) => b.sub).filter(Boolean).join(' ');
      this.root.classList.add('shown');
      skip.querySelector('span')!.textContent = 'Continue';
      this.barFill.style.width = '100%';
      return;
    }

    this.startedAt = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    if (this.done) return;
    const t = (now - this.startedAt) / 1000;

    // Advance to the latest beat whose moment has passed. A loop rather than an
    // index step, so a tab that was in the background and comes back a beat and
    // a half late lands on the right one instead of running the sequence out.
    let want = -1;
    for (const [i, b] of this.opts.beats.entries()) if (t >= b.at) want = i;
    if (want !== this.beatIndex && want >= 0) {
      this.beatIndex = want;
      this.showBeat(this.opts.beats[want]);
    }

    this.barFill.style.width = Math.min(100, (t / this.opts.durationS) * 100) + '%';
    this.pollGamepad();

    if (t >= this.opts.durationS) { this.finish(false); return; }
    this.raf = requestAnimationFrame(this.tick);
  };

  private showBeat(beat: IntroBeat): void {
    if (beat.livery) this.stage?.setLivery(beat.livery);
    // THE CUT. The look changes here, on the beat; the ease between looks
    // belongs to the stage, which is the only thing that knows about frames.
    if (beat.look) this.stage?.setLook(beat.look);
    // Retriggering the entrance means removing the class, forcing a reflow and
    // adding it back; without the reflow the browser coalesces the two and the
    // animation never restarts.
    this.root.classList.remove('shown');
    void this.root.offsetWidth;
    // The title card is set differently from the lines that lead to it: bigger,
    // centred, and with the wordmark's own hollow qualifier. It is the only
    // beat that is a logo rather than a sentence.
    this.root.classList.toggle('intro-card', beat.card === true);
    if (beat.card) {
      this.titleEl.textContent = '';
      this.titleEl.append(document.createTextNode('F1'));
      const i = document.createElement('i');
      i.textContent = 'SIM';
      this.titleEl.appendChild(i);
    } else {
      this.titleEl.textContent = beat.title;
    }
    this.subEl.textContent = beat.sub ?? '';
    this.root.classList.add('shown');
  }

  /**
   * Any gamepad button skips.
   *
   * Polled rather than listened for, because the Gamepad API has no button
   * events. `gamepadArmed` waits for a frame in which NOTHING is held before it
   * will accept a press, so the button that launched the game does not skip the
   * sequence that launch produced.
   */
  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let anyDown = false;
    for (const pad of pads) {
      if (!pad) continue;
      for (const b of pad.buttons) if (b.pressed) { anyDown = true; break; }
      if (anyDown) break;
    }
    if (!anyDown) { this.gamepadArmed = true; return; }
    if (this.gamepadArmed) this.finish(true);
  }

  private finish(skipped: boolean): void {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.stage?.dispose();
    this.stage = null;
    this.root.remove();
    this.opts.onDone(skipped);
  }

  /** Ends the sequence from outside — a back button, a screen change. */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    this.stage?.dispose();
    this.stage = null;
    this.root.remove();
  }
}

/**
 * The sequence itself.
 *
 * Four beats, and the copy is doing one job: making the smallness of the seat
 * on the next screen mean something. It does not explain the mode, list its
 * features or welcome anybody — the create screen already says what the seat
 * is, and a title sequence that reads like a manual is the thing the previous
 * create screen was criticised for.
 *
 * The liveries are three real Formula 1 teams' colours and then the Formula 3
 * team the player is actually about to sign for, so the last car standing in
 * the light is the one they are given.
 */
export function openingBeats(
  rookie: { colour: number; accent: number; code: string },
  grid: readonly { colour: number; accent: number; code: string }[],
): IntroBeat[] {
  const walk = grid.slice(0, 3);
  return [
    {
      at: 0,
      // Head on, in the rain, before anything is said. The first shot of a
      // title sequence should be the subject and nothing else.
      look: 'nose',
      title: 'Twenty seats',
      sub: 'Every one of them belongs to somebody else.',
      livery: { ...walk[0], number: 1 },
    },
    {
      at: 3.6,
      // Down the flank. The car changes colour on the cut, which is the point
      // of the beat: these are different people's cars.
      look: 'flank',
      title: 'They open one at a time',
      sub: 'A retirement, a bad season, a contract nobody renewed.',
      livery: { ...(walk[1] ?? walk[0]), number: 16 },
    },
    {
      at: 7.2,
      look: 'wing',
      title: 'And they open at the bottom',
      sub: 'Formula 3, the slowest car on the grid, and nine rounds to prove it wrong.',
      livery: { ...(walk[2] ?? walk[0]), number: 4 },
    },
    {
      at: 10.6,
      // Kerb height, and the last livery change: the car standing in the light
      // now is the one the player is about to be handed.
      look: 'low',
      title: 'This one is yours',
      sub: 'Take it.',
      livery: { colour: rookie.colour, accent: rookie.accent, number: 47, code: rookie.code },
    },
    {
      at: 13.8,
      // The title card, on the launch angle. The sequence has spent thirteen
      // seconds earning the right to say its own name.
      look: 'hero',
      card: true,
      title: 'F1SIM',
      sub: 'Formula 3 to Formula 1, one seat at a time.',
    },
  ];
}
