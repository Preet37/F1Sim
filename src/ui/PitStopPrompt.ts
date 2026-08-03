import { type CompoundId } from '../data/tires';
import type { CarEntry } from '../race/CarEntry';
import {
  cyclePitCompound, pitSheet, setPitCompound, setPitRepair, togglePitRepair,
  type PitSheet, type RepairChoice,
} from '../race/PitStop';
import type { RaceEngine } from '../race/RaceEngine';
import type { PitBindingHints } from '../input/InputController';

/**
 * The pit stop, made a decision instead of a surprise.
 *
 * Before this, pressing PIT meant driving down the lane and finding out
 * afterwards what had been bolted on. Tyre choice is the biggest strategic
 * lever in a Grand Prix and the player's was the one car in the field that
 * could not pull it.
 *
 * THREE THINGS SHAPED THIS FILE, AND ALL THREE ARE FAULTS IT USED TO HAVE.
 *
 * 1. IT IS A RENDER, NOT A MEMORY. Every string and every highlight comes from
 *    one call to `pitSheet`, which reads the engine. The old version toggled a
 *    `selected` class inside a click handler and computed its status line
 *    separately, so the tile that looked chosen and the tyre that was going on
 *    the car were two different facts kept in step by hand — and they came
 *    apart. Nothing in this file decides what the stop is; it draws what the
 *    engine says the stop is.
 *
 * 2. IT IS OPERABLE WITHOUT A POINTER. "How is the user supposed to choose the
 *    tire compound when they are racing? I can't just move my cursor and click
 *    something." Correct. The keyboard, the gamepad and a wheel all drive it
 *    through `InputController`, the same layer the throttle arrives on, and the
 *    bindings are printed on the panel because a control nobody can find is not
 *    a control. The tiles remain tappable for a touchscreen.
 *
 * 3. IT LIVES IN THE RAIL. It used to be absolutely positioned over the left of
 *    the screen and drew straight across the top of the radio card. It is now a
 *    child of the notice column, so the layout engine — not a pair of hand-tuned
 *    `bottom` values — guarantees the two stack.
 *
 * It does NOT pause the race. A pit stop happens at racing speed and the whole
 * point of calling it a lap early is that the decision is made while driving.
 */

export class PitStopPrompt {
  readonly root: HTMLElement;

  /** Called when the driver waves the stop off from the panel. */
  onCancel: (() => void) | null = null;

  private readonly note: HTMLElement;
  private readonly tyreRow: HTMLElement;
  private readonly noseLabel: HTMLElement;
  private readonly noseRow: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly status: HTMLElement;
  private readonly hintRow: HTMLElement;
  private readonly confirmBtn: HTMLElement;
  private readonly cancelBtn: HTMLElement;

  private car: CarEntry | null = null;
  private shown = false;
  /** The compound ids the row is currently built for, so it rebuilds rarely. */
  private builtFor = '';
  private hintFor = '';

  private readonly tiles = new Map<HTMLElement, CompoundId>();
  private readonly noseButtons: { el: HTMLElement; value: RepairChoice; label: HTMLElement }[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pitprompt hidden';

    const head = el('pitprompt-head', this.root);
    el('pitprompt-title', head, 'PIT STOP');
    this.cancelBtn = el('pitprompt-wave', head, 'STAY OUT');
    tap(this.cancelBtn, () => this.onCancel?.());

    this.note = el('pitprompt-note', this.root);
    this.tyreRow = el('pitprompt-tyres', this.root);

    this.noseLabel = el('pitprompt-noselabel', this.root, 'FRONT WING');
    this.noseRow = el('pitprompt-nose', this.root);

    this.warning = el('pitprompt-warn', this.root);
    this.warning.style.display = 'none';

    this.status = el('pitprompt-status', this.root);

    const foot = el('pitprompt-foot', this.root);
    this.hintRow = el('pitprompt-hints', foot);
    this.confirmBtn = el('pitprompt-confirm', foot, 'CONFIRM');
    tap(this.confirmBtn, () => this.flashConfirm());

    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  /**
   * Draws the sheet for the stop that is about to happen.
   *
   * Safe on every frame: the tile row is rebuilt only when the set of compounds
   * on offer changes, and everything else is a guarded text or class write.
   * `Hud.update` runs at 60fps beside twenty simulated cars, so this cannot
   * allocate or reflow per frame.
   */
  render(engine: RaceEngine, car: CarEntry, hints: PitBindingHints): void {
    this.car = car;
    const sheet = pitSheet(engine, car);

    const key = sheet.tiles.map((t) => t.id).join('/');
    if (key !== this.builtFor) {
      this.builtFor = key;
      this.buildTiles(sheet);
    }
    const hintKey = hints.tyre + '|' + hints.repair + '|' + hints.confirm + '|' + hints.cancel;
    if (hintKey !== this.hintFor) {
      this.hintFor = hintKey;
      this.buildHints(hints);
    }

    setText(this.note, sheet.note);
    setText(this.noseLabel, sheet.wingLabel);
    setText(this.status, sheet.status);

    for (const [element, id] of this.tiles) {
      const tile = sheet.tiles.find((t) => t.id === id);
      if (!tile) continue;
      setClass(element, 'pitchip'
        + (tile.selected ? ' selected' : '')
        + (tile.used ? ' is-used' : '')
        + (tile.recommended ? ' is-crew' : ''));
    }
    for (const b of this.noseButtons) {
      const opt = sheet.repairs.find((r) => r.value === b.value);
      setClass(b.el, 'pitnose' + (opt?.selected ? ' selected' : ''));
      if (opt) setText(b.label, opt.label);
    }

    setStyle(this.warning, 'display', sheet.warning ? 'block' : 'none');
    if (sheet.warning) setText(this.warning, sheet.warning);

    this.root.classList.remove('hidden');
    this.shown = true;
  }

  close(): void {
    this.root.classList.add('hidden');
    this.shown = false;
    this.car = null;
  }

  /**
   * The three controls, from whichever device the player is holding.
   *
   * Routed through here rather than read off the panel so a gamepad, a wheel, a
   * keyboard and a tap all mutate the choice by the same three functions.
   */
  cycleTyre(engine: RaceEngine, dir = 1): void {
    if (!this.shown || !this.car) return;
    cyclePitCompound(engine, this.car, dir);
  }

  toggleRepair(engine: RaceEngine): void {
    if (!this.shown || !this.car) return;
    togglePitRepair(engine, this.car);
  }

  /**
   * Confirm.
   *
   * The stop is already latched — the driver pressed PIT to open this — so
   * confirming does not change the car. What it does is end the interaction:
   * the panel acknowledges, and the driver can stop thinking about it. Making
   * it change state as well would mean a driver who never pressed it got no
   * stop, which is the opposite of the point.
   */
  confirm(): void {
    if (!this.shown) return;
    this.flashConfirm();
  }

  private flashConfirm(): void {
    this.root.classList.remove('confirmed');
    // Reflow between the two writes, or the class never leaves and comes back
    // and the animation does not run a second time.
    void this.root.offsetWidth;
    this.root.classList.add('confirmed');
  }

  private buildTiles(sheet: PitSheet): void {
    this.tyreRow.textContent = '';
    this.tiles.clear();
    for (const tile of sheet.tiles) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pitchip';
      chip.style.setProperty('--chip', tile.colour);
      el('pitchip-code', chip, tile.code);
      el('pitchip-name', chip, tile.name);
      // A used dry compound is marked because the two-compound rule is about
      // which ones you have ALREADY had, and fitting the same tyre twice
      // without noticing is the commonest way to be disqualified.
      el('pitchip-used', chip, 'used');
      tap(chip, () => { if (this.car) setPitCompound(this.car, tile.id); });
      this.tyreRow.appendChild(chip);
      this.tiles.set(chip, tile.id);
    }

    if (this.noseButtons.length === 0) {
      for (const opt of sheet.repairs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pitnose';
        const label = el('pitnose-label', b, opt.label);
        tap(b, () => { if (this.car) setPitRepair(this.car, opt.value); });
        this.noseRow.appendChild(b);
        this.noseButtons.push({ el: b, value: opt.value, label });
      }
    }
  }

  private buildHints(hints: PitBindingHints): void {
    this.hintRow.textContent = '';
    const pairs: [string, string][] = [
      [hints.tyre, 'tyre'],
      [hints.repair, 'wing'],
      [hints.cancel, 'stay out'],
    ];
    for (const [key, what] of pairs) {
      const h = el('pithint', this.hintRow);
      el('pithint-key', h, key);
      el('pithint-what', h, what);
    }
  }
}

function el(cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text) d.textContent = text;
  parent.appendChild(d);
  return d;
}

/**
 * A control inside a `pointer-events: none` HUD.
 *
 * Both events are bound, and `touchstart` calls `preventDefault` so the browser
 * does not follow it with a synthesised click — a tyre choice that fires twice
 * cycles straight past the tyre the driver wanted.
 */
function tap(element: HTMLElement, handler: () => void): void {
  element.style.pointerEvents = 'auto';
  const fire = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
  element.addEventListener('click', fire);
  element.addEventListener('touchstart', fire, { passive: false });
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}
function setClass(element: HTMLElement, value: string): void {
  if (element.className !== value) element.className = value;
}
function setStyle(element: HTMLElement, prop: string, value: string): void {
  const style = element.style as unknown as Record<string, string>;
  if (style[prop] !== value) style[prop] = value;
}
