import { DRY_COMPOUNDS, WET_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { CarEntry } from '../race/CarEntry';
import type { RaceEngine } from '../race/RaceEngine';

/**
 * The pit stop, made a decision instead of a surprise.
 *
 * Before this, pressing PIT meant driving down the lane and finding out
 * afterwards what had been bolted on. The compound came from
 * `chooseCompoundForStint` — the AI strategist's function, which has no concept
 * of what the player wanted — and the front wing was replaced or not by a rule
 * the player could not see, costing them nine seconds they had not agreed to.
 * Tyre choice is the biggest strategic lever in a Grand Prix and the player's
 * was the one car in the field that could not pull it.
 *
 * Design constraints that shaped this
 *
 * It does NOT pause the race. A pit stop happens at racing speed and the whole
 * point of calling it a lap early is that the decision is made while driving.
 * Freezing the world to show a menu would be a different game, and would make a
 * safety-car stop — the one where the timing genuinely matters — impossible to
 * get right.
 *
 * So it has to be usable at 300 km/h with one thumb: five large targets in a
 * row, no scrolling, no nested pages, and a default already selected so a driver
 * who ignores it entirely still gets a sensible stop. It sits on the left, clear
 * of the wheel display and the timing panel, and it closes itself the moment the
 * car is released.
 *
 * Every number on it is read from `RaceEngine.pitBriefing`, which runs the same
 * functions the stop itself runs. It cannot describe a stop the engine would not
 * perform.
 */

export class PitStopPrompt {
  readonly root: HTMLElement;

  private readonly headline: HTMLElement;
  private readonly note: HTMLElement;
  private readonly tyreRow: HTMLElement;
  private readonly noseRow: HTMLElement;
  private readonly status: HTMLElement;

  private car: CarEntry | null = null;
  private shown = false;
  /** Compound chips currently built, so the row is only rebuilt when it changes. */
  private builtFor = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pitprompt hidden';
    // The HUD is pointer-events:none so it never blocks the driving surface.
    // This panel opts back in — but only the panel, not the space around it.
    this.root.style.pointerEvents = 'auto';

    const head = document.createElement('div');
    head.className = 'pitprompt-head';
    this.root.appendChild(head);
    this.headline = document.createElement('div');
    this.headline.className = 'pitprompt-title';
    this.headline.textContent = 'PIT STOP';
    head.appendChild(this.headline);

    this.note = document.createElement('div');
    this.note.className = 'pitprompt-note';
    this.root.appendChild(this.note);

    this.tyreRow = document.createElement('div');
    this.tyreRow.className = 'pitprompt-tyres';
    this.root.appendChild(this.tyreRow);

    this.noseRow = document.createElement('div');
    this.noseRow.className = 'pitprompt-nose';
    this.root.appendChild(this.noseRow);

    this.status = document.createElement('div');
    this.status.className = 'pitprompt-status';
    this.root.appendChild(this.status);

    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  /**
   * Opens the sheet for a stop that is about to happen.
   *
   * Safe to call repeatedly — it rebuilds only when the situation has actually
   * changed, because rebuilding a row of buttons under a thumb that is on one of
   * them is how a tap gets eaten.
   */
  open(engine: RaceEngine, car: CarEntry): void {
    this.car = car;
    const b = engine.pitBriefing(car);

    // Wet-weather tyres are only offered when they are a real option. A dry
    // Bahrain race that lists "WET" as one of five equal choices is inviting a
    // mistake that costs the race, for no gain.
    const wetsRelevant = engine.weather.wetness > 0.12 || engine.weather.hasRained;
    const key = [
      b.compound, wetsRelevant, b.secondCompoundRequired,
      b.dryUsed.join('/'), b.noseChangeAdvised,
    ].join('|');
    if (key !== this.builtFor) {
      this.builtFor = key;
      this.build(engine, car, wetsRelevant);
    }

    this.root.classList.remove('hidden');
    this.shown = true;
  }

  close(): void {
    this.root.classList.add('hidden');
    this.shown = false;
    this.builtFor = '';
    this.car = null;
  }

  private build(engine: RaceEngine, car: CarEntry, wetsRelevant: boolean): void {
    const b = engine.pitBriefing(car);

    this.note.textContent = b.secondCompoundRequired
      ? 'You still owe a second dry compound — reach the flag without one and it is a disqualification.'
      : b.lapsRemaining > 0
        ? b.lapsRemaining + ' laps left · the engineers would fit ' + getCompound(b.compound).name.toLowerCase()
        : 'The engineers would fit ' + getCompound(b.compound).name.toLowerCase();

    // --- Tyres ------------------------------------------------------------
    this.tyreRow.textContent = '';
    const offered: CompoundId[] = wetsRelevant
      ? [...DRY_COMPOUNDS, ...WET_COMPOUNDS]
      : [...DRY_COMPOUNDS];

    for (const id of offered) {
      const c = getCompound(id);
      const chip = document.createElement('button');
      chip.className = 'pitchip';
      chip.style.setProperty('--chip', '#' + c.colour.toString(16).padStart(6, '0'));

      const code = document.createElement('span');
      code.className = 'pitchip-code';
      code.textContent = c.code;
      chip.appendChild(code);

      const name = document.createElement('span');
      name.className = 'pitchip-name';
      name.textContent = c.name;
      chip.appendChild(name);

      // A used dry compound is marked, because the two-compound rule is about
      // which ones you have ALREADY had — the single most common way to be
      // disqualified is fitting the same tyre twice without noticing.
      if (b.dryUsed.includes(id)) {
        const used = document.createElement('span');
        used.className = 'pitchip-used';
        used.textContent = 'used';
        chip.appendChild(used);
      }

      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        car.pitCompoundRequest = id;
        this.refreshSelection();
      });
      this.tyreRow.appendChild(chip);
      chipsById.set(chip, id);
    }

    // --- Nose -------------------------------------------------------------
    this.noseRow.textContent = '';
    const wingPct = Math.round(b.frontWing * 100);
    const label = document.createElement('div');
    label.className = 'pitprompt-noselabel';
    label.textContent = 'FRONT WING ' + wingPct + '%';
    this.noseRow.appendChild(label);

    const mk = (text: string, value: boolean | null) => {
      const btn = document.createElement('button');
      btn.className = 'pitnose';
      btn.textContent = text;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        car.pitNoseChangeRequest = value;
        this.refreshSelection();
      });
      this.noseRow.appendChild(btn);
      noseById.set(btn, value);
    };
    mk('CREW', null);
    mk('CHANGE +' + b.noseChangeCostS.toFixed(0) + 's', true);
    mk('KEEP', false);

    this.refreshSelection();
  }

  /** Marks the selected chips. Cheap — it only writes class names. */
  private refreshSelection(): void {
    const car = this.car;
    if (!car) return;
    for (const chip of this.tyreRow.children) {
      const id = chipsById.get(chip as HTMLElement);
      const on = id !== undefined && car.pitCompoundRequest === id;
      (chip as HTMLElement).classList.toggle('selected', on);
    }
    for (const btn of this.noseRow.children) {
      if (!noseById.has(btn as HTMLElement)) continue;
      const v = noseById.get(btn as HTMLElement)!;
      (btn as HTMLElement).classList.toggle('selected', car.pitNoseChangeRequest === v);
    }
  }

  /** Live line at the bottom: where the stop has got to. */
  update(engine: RaceEngine, car: CarEntry): void {
    if (!this.shown) return;
    const chosen = car.pitCompoundRequest;
    const b = engine.pitBriefing(car);
    const fitting = chosen ?? b.compound;

    let text: string;
    if (car.inPitBox) {
      text = 'STATIONARY — ' + car.pitBoxTimer.toFixed(1) + 's · fitting ' +
        getCompound(car.compound).name.toLowerCase();
    } else if (car.inPitLane) {
      const d = car.perception.pitBoxAheadM;
      text = (d >= 0 ? 'BOX IN ' + Math.round(d) + 'm' : 'BOX AHEAD') +
        ' · ' + getCompound(fitting).name.toLowerCase() +
        (car.pitNoseChangeRequest ?? b.noseChangeAdvised ? ' + new nose' : '');
    } else {
      text = 'BOX THIS LAP · ' + getCompound(fitting).name.toLowerCase() +
        (chosen ? ' (your call)' : ' (engineers)');
    }
    if (this.status.textContent !== text) this.status.textContent = text;
  }
}

// Selection maps live outside the class so a rebuilt row does not strand the
// old entries: the elements are discarded with the row, and a WeakMap lets the
// garbage collector take them with it.
const chipsById = new WeakMap<Element, CompoundId>();
const noseById = new WeakMap<Element, boolean | null>();
