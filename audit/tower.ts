import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { Hud } from '../src/ui/Hud';
import type { CarEntry } from '../src/race/CarEntry';
import { createWorld, installWorld, raceSeats, toDriver } from '../src/career/World';
import type { Driver } from '../src/data/teams';

/**
 * The browser half of `npm run probe:tower` — issues #17 and #35.
 *
 * WHY A PAGE AND NOT A NODE PROBE. Both defects are about what the running
 * order DRAWS, and every existing check of it is a check of a pure function.
 * `probe:hudtext` already asserts that `standingsCells` returns a lap time for
 * every car that has set one, and it has passed throughout the life of issue
 * #35 — because the string was never the problem. The row that would have
 * printed it was zero pixels wide, or the row was not drawn at all. Those two
 * facts exist only after layout, so this harness runs the REAL `Hud` against
 * the REAL `RaceEngine` with the game's own stylesheet linked, and the probe
 * measures `getBoundingClientRect` on what came out.
 *
 * NO RENDERER. `audit/hud.ts` drives one because it takes photographs of the
 * HUD over a circuit; this asks only what the DOM says and where it is, so
 * building a track mesh under a software rasteriser would cost minutes a
 * viewport and change no measurement. Everything else — the Hud instance, the
 * engine, the stylesheet, the media queries — is the shipping article.
 */

declare global {
  interface Window {
    __tower: TowerApi;
  }
}

export interface TowerOpen {
  kind: 'race' | 'qualifying' | 'practice';
  circuit: string;
  /** Session seconds to simulate before the reading is taken. */
  seconds: number;
  seed?: number;
  laps?: number;
  durationS?: number;
  playerIndex?: number;
  pitLaneStart?: boolean;
  standingStart?: boolean;
  /** Field size, for the row-count sweep. Defaults to the roster's own. */
  cars?: number;
  qualifyingPhase?: 1 | 2 | 3;
  advancing?: number;
}

interface RowReading {
  pos: string;
  code: string;
  /** The lap-time cell's text, and whether it occupies any pixels. */
  time: string;
  timeW: number;
  timeVisible: boolean;
  gap: string;
  gapW: number;
  cls: string;
  top: number;
  height: number;
  /** How far the row's own cells reach past the panel's right edge. */
  overflow: number;
  /** The driver-code cell: its width, and how much of the code is cut off. */
  codeW: number;
  codeClipped: number;
  /** The team mark: drawn, and how big. `reference/target/68.png` has one. */
  markDrawn: boolean;
  /** The compound letter at the right-hand edge. */
  tyre: string;
  tyreVisible: boolean;
  /** `Leader` is italic in the reference. */
  gapItalic: boolean;
  /** The badge column's class suffix — fastest lap, `P`, penalty, chequer. */
  badges: string;
}

export interface TowerReading {
  kind: string;
  /** Cars in the session. */
  field: number;
  /** Rows the tower is actually drawing. */
  shown: number;
  rows: RowReading[];
  /** The engine's own truth about every car, in standings order. */
  truth: { code: string; best: number; lap: number; retired: boolean; player: boolean }[];
  player: { code: string; lap: number; best: number; retired: boolean };
  /** Geometry, in CSS pixels. */
  viewport: { w: number; h: number };
  tower: { top: number; bottom: number; left: number; width: number };
  /** The notice rail beneath the tower — its band, and what is pinned in it. */
  rail: { top: number; bottom: number; occupiedTop: number; pinned: string[] };
  /** Top of the mirror band as a pixel row, or 0 when the camera shows none. */
  mirrorTopPx: number;
  /** The tower's own column template, so a collapsed column is visible. */
  cols: string;
  timed: boolean;
  fastest: string;
  pitSheetOpen: boolean;
}

interface TowerApi {
  open(o: TowerOpen): Promise<void>;
  camera(mode: string): void;
  /** Raises or clears the flag band, which is the tallest the panel ever is. */
  flagBand(on: boolean): void;
  advance(seconds: number): Promise<void>;
  paint(): Promise<void>;
  read(): TowerReading;
}

const app = document.getElementById('app') as HTMLElement;
const hud = new Hud(app);
hud.setVisible(true);
hud.setHelpVisible(false);
// The cards are transient by design and this harness measures a still frame;
// a dwell that expires between the paint and the read is a measurement of the
// timeout rather than of the layout.
hud.alertDwellMs = 10 * 60_000;
hud.radioDwellMs = 10 * 60_000;

/** Everything `Hud.update` reads off the input controller, and nothing else. */
const input = {
  ersMode: 'balanced',
  showTouchOverlay: false,
  joystickActive: false,
  joystickCentreX: 0,
  joystickCentreY: 0,
  joystickOffset: { x: 0, y: 0, radius: 60 },
  throttleHeld: false,
  brakeHeld: false,
  reverseTouchHeld: false,
} as never;

let engine: RaceEngine | null = null;
let player: CarEntry | null = null;

// The career's own world, for the field-size sweep. Installed once: it is what
// `raceSeats` reads and what `probe:fieldsize` builds its grids from.
const world = createWorld(31415);
installWorld(world);

function present(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * One frame of HUD, wired the way the shell wires it.
 *
 * `main.ts` re-asks the engine every frame whether a stop is being chosen and
 * hands the answer to the HUD, and the tower's row count depends on it. A
 * harness that skipped that line would measure a tower the game never draws.
 */
function paint(): void {
  if (!engine || !player) return;
  hud.setPitSheetOpen(engine.pitDecisionPending(player));
  hud.update(engine, player, input, 60, 240);
}

const api: TowerApi = {
  async open(o: TowerOpen): Promise<void> {
    const config: SessionConfig = {
      kind: o.kind,
      name: o.kind === 'race' ? 'Grand Prix' : o.kind === 'qualifying' ? 'Q1' : 'Practice',
      durationS: o.durationS ?? (o.kind === 'race' ? 0 : 1800),
      laps: o.laps ?? (o.kind === 'race' ? 60 : 0),
      // THE PLAYER IS THE POINT. Every scenario here is "the player has done
      // nothing yet and the field has", so the car the HUD is pointed at is a
      // player's car with no controls written to it, exactly as it would be
      // for somebody who has not moved.
      playerIndex: o.playerIndex ?? 0,
      standingStart: o.standingStart ?? false,
      pitLaneStart: o.pitLaneStart ?? o.kind !== 'race',
      seed: o.seed ?? 4242,
      qualifyingPhase: o.qualifyingPhase,
      advancing: o.advancing,
    };
    // A bigger grid is a bigger DRIVER LIST, not a subset of a twenty-car one —
    // the same construction `probe:fieldsize` uses, topping up from the tier
    // below, which is what a twelfth constructor would do to the grid.
    let field: Driver[] | undefined;
    if (o.cars !== undefined) {
      const pool = [...raceSeats(world, 'F1'), ...raceSeats(world, 'F2')];
      field = pool.slice(0, o.cars).map(toDriver);
    }
    engine = new RaceEngine(getCircuit(o.circuit), config, field);
    player = engine.cars[config.playerIndex];
    const steps = Math.round(o.seconds / PHYSICS_DT);
    // Sliced so the page stays responsive and the run does not trip the
    // protocol timeout on a long warm-up.
    for (let i = 0; i < steps; i += 2400) {
      for (let j = 0; j < Math.min(2400, steps - i); j++) engine.step();
      await new Promise((r) => setTimeout(r, 0));
    }
    paint();
    await present();
  },

  camera(mode: string): void {
    hud.setCameraMode(mode);
    paint();
  },

  /**
   * The flag band, which is what makes the panel as tall as it ever gets.
   *
   * A budget written for the quiet frame is a budget that overflows on the one
   * frame the driver most needs the panel to be readable, so the row count has
   * to be reserved against the band being out rather than against it being
   * away. Raised through race control's own state, so the band drawn is the
   * band the game draws.
   */
  flagBand(on: boolean): void {
    if (!engine) return;
    engine.raceControl.neutralisation = on ? 'safety-car' : 'none';
    paint();
  },

  async advance(seconds: number): Promise<void> {
    if (!engine) return;
    for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) engine.step();
    paint();
    await present();
  },

  async paint(): Promise<void> {
    paint();
    await present();
  },

  read(): TowerReading {
    if (!engine || !player) throw new Error('no session');
    const tower = hud.root.querySelector<HTMLElement>('.hud-tower')!;
    const notices = hud.root.querySelector<HTMLElement>('.hud-notices')!;
    const tr = tower.getBoundingClientRect();
    const nr = notices.getBoundingClientRect();

    const rows: RowReading[] = [];
    for (const el of Array.from(tower.querySelectorAll<HTMLElement>('.tower-row'))) {
      if (getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      const time = el.querySelector<HTMLElement>('.tower-time');
      const gap = el.querySelector<HTMLElement>('.tower-gap');
      const timeBox = time ? time.getBoundingClientRect() : null;
      const timeStyle = time ? getComputedStyle(time) : null;
      rows.push({
        pos: el.querySelector<HTMLElement>('.tower-pos')?.textContent ?? '',
        code: el.querySelector<HTMLElement>('.tower-code')?.textContent ?? '',
        time: time?.textContent ?? '',
        timeW: timeBox ? Math.round(timeBox.width * 10) / 10 : 0,
        // DRAWN, not present. A cell with the right string in it and no width
        // is the whole of issue #35, and `textContent` cannot tell them apart.
        timeVisible: !!timeBox && timeBox.width > 1 && timeBox.height > 1 &&
          timeStyle!.display !== 'none' && timeStyle!.visibility !== 'hidden' &&
          Number(timeStyle!.opacity) > 0.05 &&
          timeBox.right <= tr.right + 0.5 && timeBox.left >= tr.left - 0.5,
        gap: gap?.textContent ?? '',
        gapW: gap ? Math.round(gap.getBoundingClientRect().width * 10) / 10 : 0,
        cls: el.className,
        top: Math.round(r.top),
        height: Math.round(r.height * 10) / 10,
        // A grid template wider than the panel does not shrink: it pushes its
        // last columns out through the right-hand edge, where they are drawn
        // over whatever else is there or clipped away entirely. The row's own
        // scroll width against its client width is that overrun exactly.
        overflow: Math.max(0, el.scrollWidth - el.clientWidth),
        codeW: Math.round((el.querySelector<HTMLElement>('.tower-code')
          ?.getBoundingClientRect().width ?? 0) * 10) / 10,
        markDrawn: (() => {
          const m = el.querySelector<HTMLElement>('.tower-mark');
          if (!m || getComputedStyle(m).display === 'none') return false;
          const b = m.getBoundingClientRect();
          return !!m.querySelector('svg') && b.width > 1 && b.height > 1;
        })(),
        tyre: el.querySelector<HTMLElement>('.tower-tyre')?.textContent ?? '',
        tyreVisible: (() => {
          const t = el.querySelector<HTMLElement>('.tower-tyre');
          if (!t || getComputedStyle(t).display === 'none') return false;
          const b = t.getBoundingClientRect();
          return b.width > 1 && b.right <= tr.right + 0.5;
        })(),
        gapItalic: gap ? getComputedStyle(gap).fontStyle === 'italic' : false,
        badges: el.querySelector<HTMLElement>('.tower-badges')?.className ?? '',
        // `.tower-code` is `overflow: hidden`, so a column too narrow for a
        // three-letter code does not wrap or shrink it — it cuts letters off
        // the end, silently.
        codeClipped: (() => {
          const c = el.querySelector<HTMLElement>('.tower-code');
          return c ? Math.max(0, c.scrollWidth - c.clientWidth) : 0;
        })(),
      });
    }

    // What is pinned in the rail, and where the highest of it starts. That is
    // the floor the running order is actually competing with, as opposed to
    // the fixed reservation `towerFit` subtracts.
    const pinned: string[] = [];
    let occupiedTop = nr.bottom;
    for (const el of Array.from(notices.children) as HTMLElement[]) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.height < 1) continue;
      pinned.push(el.className.split(' ')[0] + '@' + Math.round(r.top) + '+' + Math.round(r.height));
      occupiedTop = Math.min(occupiedTop, r.top);
    }

    const mirrorTop = getComputedStyle(hud.root).getPropertyValue('--mirror-top').trim();
    const mirrorTopPx = mirrorTop.endsWith('%')
      ? (parseFloat(mirrorTop) / 100) * window.innerHeight : 0;

    return {
      kind: engine.config.kind,
      field: engine.participants.length,
      shown: rows.length,
      rows,
      truth: engine.standings.map((c) => ({
        code: c.driver.code.toUpperCase(),
        best: c.bestLapTime,
        lap: c.lap,
        retired: c.retired,
        player: c === player,
      })),
      player: {
        code: player.driver.code.toUpperCase(),
        lap: player.lap,
        best: player.bestLapTime,
        retired: player.retired,
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      tower: {
        top: Math.round(tr.top), bottom: Math.round(tr.bottom),
        left: Math.round(tr.left), width: Math.round(tr.width),
      },
      rail: {
        top: Math.round(nr.top), bottom: Math.round(nr.bottom),
        occupiedTop: Math.round(occupiedTop), pinned,
      },
      mirrorTopPx: Math.round(mirrorTopPx),
      cols: getComputedStyle(tower).getPropertyValue('--tower-cols').trim(),
      timed: tower.classList.contains('is-timed'),
      fastest: hud.root.querySelector<HTMLElement>('.tower-fastest')?.textContent ?? '',
      pitSheetOpen: engine.pitDecisionPending(player),
    };
  },
};

window.__tower = api;
