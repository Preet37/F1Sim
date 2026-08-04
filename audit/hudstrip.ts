import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { Hud } from '../src/ui/Hud';

/**
 * The browser half of `npm run probe:hudstrip` — issue #15.
 *
 * WHY IT IS A BROWSER PROBE AND NOT A STRING CHECK. `probe:hudtext` already
 * asserts what `raceControlCard` returns and passed through the entire life of
 * #15, because none of the seven differences the reference names is a
 * difference in the words. They are a colour, a ground, a block that is not
 * drawn, and a severity class with no rule behind it. Every one of them is a
 * property of the LAID-OUT DOCUMENT, so this measures the laid-out document —
 * real `Hud`, real `RaceEngine`, the game's own stylesheet,
 * `getBoundingClientRect` and `getComputedStyle`. It is the same method
 * `probe:tower` §5 uses against `68.png`, which is the model PROJECT.md §7
 * named for this work.
 *
 * NO RENDERER. `RaceEngine` needs no WebGL — the spline, the world model and
 * twenty AI cars are arithmetic — and the strip is DOM. A page that built a
 * circuit under a software rasteriser to look at a stylesheet would cost
 * minutes a run for nothing.
 */

declare global {
  interface Window {
    __strip: {
      /** Files one bulletin at the given severity and paints the HUD. */
      raise(o: RaiseOpts): Promise<void>;
      /** Everything about the strip that can be measured after layout. */
      read(): StripReading;
    };
  }
}

export interface RaiseOpts {
  severity: 'info' | 'warning' | 'critical';
  text: string;
  /** Structured notice, or absent for a session-wide bulletin such as a flag. */
  notice?: { parties: string[]; where: string; offence: string; status: string };
}

export interface BoxReading {
  /** Present in the document at a non-zero size. */
  shown: boolean;
  /** Left and right edges as a fraction of the strip's own width. */
  left: number;
  right: number;
  /** Resolved background, `rgb(...)`. */
  bg: string;
  /** Resolved foreground, `rgb(...)`. */
  fg: string;
  text: string;
  /** Font size in px, and the cap height it implies for this face. */
  sizePx: number;
}

export interface StripReading {
  found: boolean;
  /** The strip's own box, in CSS pixels. */
  w: number;
  h: number;
  /** The whole strip's text content, for the prefix assertion. */
  text: string;
  /** The plate's own ground. */
  ground: string;
  /** The class list, so the tone can be named in a failure message. */
  cls: string;
  flag: BoxReading;
  badge: BoxReading;
  body: BoxReading;
  seq: BoxReading;
  headline: BoxReading;
  /** One entry per instruction line, in order. */
  details: BoxReading[];
  /** Cards currently on the noticeboard. */
  cards: number;
}

const app = document.getElementById('app') as HTMLElement;
app.style.background =
  'linear-gradient(160deg, #4a5c70 0%, #6d7f92 42%, #3d4a58 42.2%, #2b333d 100%)';
app.style.position = 'fixed';
app.style.inset = '0';

// Monza and a race, because the strip is the same on every circuit and the
// cheapest circuit to build is the one that answers the question fastest. The
// player is in the field so `Hud.update` takes the normal path.
const config: SessionConfig = {
  kind: 'race', name: 'Grand Prix', durationS: 0, laps: 57,
  playerIndex: 6, standingStart: false, pitLaneStart: false, seed: 90210,
};
const engine = new RaceEngine(getCircuit('monza'), config);
const car = engine.cars[6];
const hud = new Hud(app);
hud.setVisible(true);
hud.setHelpVisible(false);
// The dwell is a wall-clock timer in the real HUD and this harness has to be
// able to read a card that is still there. Long enough that nothing expires
// mid-measurement; the timer itself is not what is under test.
hud.alertDwellMs = 10 * 60_000;

const input = {
  ersMode: 'balanced', gearMode: 'auto', showTouchOverlay: false, joystickActive: false,
  joystickCentreX: 0, joystickCentreY: 0, joystickOffset: { x: 0, y: 0, radius: 60 },
  throttleHeld: false, brakeHeld: false, reverseTouchHeld: false,
} as never;

function box(e: HTMLElement | null, strip: DOMRect): BoxReading {
  if (!e) return { shown: false, left: 0, right: 0, bg: '', fg: '', text: '', sizePx: 0 };
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return {
    shown: r.width > 0.5 && r.height > 0.5 && cs.display !== 'none',
    // A FRACTION OF THE STRIP, never a pixel count. The reference is a
    // 528-pixel strip in a 1200-wide broadcast frame and ours is 420 in a
    // 1400-wide one; pixels do not compare and where a block sits does. Same
    // reasoning as `probe:tower` §5.
    left: strip.width > 0 ? (r.left - strip.left) / strip.width : 0,
    right: strip.width > 0 ? (r.right - strip.left) / strip.width : 0,
    bg: cs.backgroundColor,
    fg: cs.color,
    text: (e.textContent ?? '').trim(),
    sizePx: parseFloat(cs.fontSize),
  };
}

// ONE WARM-UP FRAME BEFORE ANYTHING IS RAISED, and it is not ceremony.
// `Hud.update` treats a change of engine as a new session and sets
// `lastMessage` to whatever is already at the end of the log — everything
// before the HUD was pointed at the session is history, deliberately. A
// harness that logged its bulletin first and updated second would have it
// swallowed as history and would measure an empty noticeboard, which is
// exactly what this page did on its first run.
hud.update(engine, car, input, 60, 240);

/** Monotonic mount order, so `read` can find the newest card. */
let stamp = 0;

window.__strip = {
  async raise(o: RaiseOpts): Promise<void> {
    // THROUGH THE REAL LOG, not by poking the card. `RaceControlManager.log`
    // is what the engine calls, `Hud.update` is what drains it, and
    // `pushControlCard` is what draws it — a harness that built the element
    // itself would be measuring its own markup.
    engine.raceControl.log(o.text, o.severity, engine.time, -1, o.notice ? {
      notice: o.notice,
    } : undefined);
    hud.update(engine, car, input, 60, 240);
    // STAMP THE NEW CARDS. `read` has to return the card this call raised, and
    // "the last one in document order" is not it: the noticeboard is built
    // before the left rail, so a bulletin `Hud.mountControl` sends to the rail
    // — which it does on a portrait phone, deliberately — sorts AFTER every
    // later bulletin on the noticeboard. Measured: two consecutive raises both
    // read back the same stale rail card from an earlier viewport, and the
    // sequence number looked like it was not counting.
    for (const c of document.querySelectorAll<HTMLElement>('.hud-control')) {
      if (!c.dataset.stripSeq) c.dataset.stripSeq = String(++stamp);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The card enters on a transform transition. Reading the box mid-flight
    // measures the animation rather than the layout, so wait it out — the
    // stylesheet's own duration is 0.36s.
    await new Promise((r) => window.setTimeout(r, 520));
  },

  read(): StripReading {
    const root = hud.root;
    const all = [...root.querySelectorAll<HTMLElement>('.hud-control')];
    // The most recently mounted, by the stamp `raise` writes — never by
    // document order. See the note there.
    const el = all.reduce<HTMLElement | null>(
      (best, c) => (!best || Number(c.dataset.stripSeq ?? 0) > Number(best.dataset.stripSeq ?? 0)
        ? c : best), null);
    if (!el) {
      const empty = box(null, new DOMRect());
      return {
        found: false, w: 0, h: 0, text: '', ground: '', cls: '',
        flag: empty, badge: empty, body: empty, seq: empty, headline: empty,
        details: [], cards: 0,
      };
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const q = (sel: string) => box(el.querySelector<HTMLElement>(sel), r);
    return {
      found: true,
      w: r.width,
      h: r.height,
      text: (el.textContent ?? '').trim(),
      ground: cs.backgroundColor,
      cls: el.className,
      flag: q('.control-flag'),
      badge: q('.control-badge'),
      body: q('.control-body'),
      seq: q('.control-seq'),
      headline: q('.control-headline'),
      details: [...el.querySelectorAll<HTMLElement>('.control-detail')].map((d) => box(d, r)),
      cards: all.length,
    };
  },
};
