import { clamp01, formatDelta, formatGap, formatLapTime, MS_TO_KPH } from '../core/MathUtils';
import { getCompound } from '../data/tires';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';
import type { InputController } from '../input/InputController';
import { bandOf, COMPONENT_NAMES, type ComponentId } from '../race/DamageModel';
import { TrackMap } from './TrackMap';

/**
 * Telemetry HUD, timing tower, team radio and touch overlay.
 *
 * Built from DOM elements rather than drawn into the canvas. A racing HUD is
 * mostly text that changes every frame, and the browser's text rasteriser is
 * faster and sharper than anything reasonable to draw in WebGL — and it scales
 * correctly on a high-DPI phone for free.
 *
 * The performance rule that matters: every element is created ONCE and only its
 * text content or a CSS custom property is touched per frame. Rebuilding the
 * timing tower's markup each frame would cause layout thrash and dominate the
 * frame budget. Values are also compared before writing, because assigning
 * identical text still invalidates layout in some browsers.
 */

interface Row {
  root: HTMLElement;
  pos: HTMLElement;
  code: HTMLElement;
  team: HTMLElement;
  gap: HTMLElement;
  tyre: HTMLElement;
  lastText: { pos: string; code: string; gap: string; tyre: string };
}

/** What the start gantry did this frame. */
export type StartLightEvent =
  | { kind: 'none' }
  | { kind: 'light'; index: number }
  | { kind: 'go' };

export class Hud {
  readonly root: HTMLElement;

  private speed!: HTMLElement;
  private gear!: HTMLElement;
  private rpmFill!: HTMLElement;
  private rpmValue!: HTMLElement;
  private drsBadge!: HTMLElement;
  private ersFill!: HTMLElement;
  private ersBadge!: HTMLElement;
  private ersMode!: HTMLElement;
  private ersPercent!: HTMLElement;

  /** Damage panel: one SVG part per component. */
  private damagePanel!: HTMLElement;
  private readonly damageParts = new Map<ComponentId, SVGElement>();
  private damageSummary!: HTMLElement;

  /** Sector tiles, top right: one per sector, coloured by the rules above. */
  private sectorCells: HTMLElement[] = [];
  private sectorTimes: HTMLElement[] = [];
  /**
   * The driver's slowest time in each sector this session, and the last
   * completed value seen, so each sector is folded in exactly once.
   */
  private readonly worstSector = [0, 0, 0];
  private readonly seenSector = [0, 0, 0];

  /** The session the accumulated state belongs to. */
  private lastEngine: RaceEngine | null = null;
  /** Circuit map, rebuilt when the session changes. */
  private mapPanel!: HTMLElement;
  private mapHolder!: HTMLElement;
  private mapTitle!: HTMLElement;
  private map: TrackMap | null = null;

  private fuel!: HTMLElement;
  private fuelDelta!: HTMLElement;
  private lapCounter!: HTMLElement;
  private position!: HTMLElement;
  private lapTime!: HTMLElement;
  private lastLap!: HTMLElement;
  private bestLap!: HTMLElement;
  private delta!: HTMLElement;
  private gapsPanel!: HTMLElement;
  private gapAhead!: HTMLElement;
  private gapBehind!: HTMLElement;
  private leds: HTMLElement[] = [];
  private deltaBar!: HTMLElement;
  private deltaFill!: HTMLElement;
  private helpOverlay!: HTMLElement;
  private teamStripe!: HTMLElement;

  private tyreCompound!: HTMLElement;
  private tyreWearFront!: HTMLElement;
  private tyreWearRear!: HTMLElement;
  private tyreTempFront!: HTMLElement;
  private tyreTempRear!: HTMLElement;

  private conditions!: HTMLElement;
  private flagBanner!: HTMLElement;
  private radioFeed!: HTMLElement;
  private cameraLabel!: HTMLElement;
  private diagnostics!: HTMLElement;

  private wheelPanel!: HTMLElement;
  private tower!: HTMLElement;
  private startLights!: HTMLElement;
  private readonly startBulbs: HTMLElement[][] = [];
  /** Lights lit last frame, so each transition fires exactly once. */
  private litCount = -1;
  private rows: Row[] = [];

  private buttonBar!: HTMLElement;
  private cameraButton!: HTMLElement;
  private pitButton!: HTMLElement;

  private touchOverlay!: HTMLElement;
  private joystick!: HTMLElement;
  private joystickKnob!: HTMLElement;
  private throttlePad!: HTMLElement;
  private brakePad!: HTMLElement;
  private reversePad!: HTMLElement;

  /** Radio messages already shown, so each appears once. */
  private shownMessages = 0;
  private radioEntries: HTMLElement[] = [];

  /** Called when the on-screen camera button is used. */
  onCameraPressed: (() => void) | null = null;
  /** Called when the on-screen pit button is used. */
  onPitPressed: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.build();
    parent.appendChild(this.root);

    // The HUD is pointer-events:none so it never blocks the driving surface;
    // these two controls opt back in.
    const wire = (el: HTMLElement, handler: () => void) => {
      el.style.pointerEvents = 'auto';
      const fire = (e: Event) => { e.preventDefault(); e.stopPropagation(); handler(); };
      el.addEventListener('click', fire);
      el.addEventListener('touchstart', fire, { passive: false });
    };
    wire(this.cameraButton, () => this.onCameraPressed?.());
    wire(this.pitButton, () => this.onPitPressed?.());
  }

  private el(cls: string, parent: HTMLElement, text = ''): HTMLElement {
    const d = document.createElement('div');
    d.className = cls;
    if (text) d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  private build(): void {
    // --- Top left: the driver tower ---------------------------------------
    //
    // Position, code, tyre and gap, leader picked out, with the lap count in
    // the header — the graphic a broadcast leaves on screen permanently,
    // because it is the only one that answers "what is happening in the race".
    this.tower = this.el('hud-panel hud-tower', this.root);
    const towerHead = this.el('tower-head', this.tower);
    // A team-colour stripe down the edge: instantly identifies whose car you
    // are in, and it is how every broadcast graphic does it.
    this.teamStripe = this.el('hud-stripe', this.tower);
    this.position = this.el('tower-position', towerHead, 'P1');
    this.lapCounter = this.el('tower-lapcount', towerHead, 'LAP 1/50');

    // --- Top right: sectors and lap times ----------------------------------
    this.buildTimingPanel();

    // --- Start lights -------------------------------------------------------
    // Five red lights illuminate one per second, then all go out together.
    // The release is the lights going OUT, not a green — getting this wrong is
    // the fastest way to tell someone you have never watched a Grand Prix.
    this.startLights = this.el('hud-startlights hidden', this.root);
    for (let i = 0; i < 5; i++) {
      const col = this.el('hud-lightcol', this.startLights);
      // Two bulbs per column, as on the real gantry.
      this.startBulbs.push([
        this.el('hud-bulb', col),
        this.el('hud-bulb', col),
      ]);
    }

    // --- Bottom right: the circuit map ------------------------------------
    // Built lazily, once the session's track is known.
    this.mapPanel = this.el('hud-panel hud-map', this.root);
    this.mapTitle = this.el('map-title', this.mapPanel, '');
    this.mapHolder = this.el('map-holder', this.mapPanel);

    // --- Bottom centre: the wheel display ---------------------------------
    //
    // Laid out like a real steering-wheel dash rather than a games HUD: a big
    // gear numeral in its own disc on the left, the numeric readouts in a row
    // beside it, and the shift lights curving across the top. The gear is the
    // thing a driver checks most often and the only item legible at a glance
    // in peripheral vision, which is why it gets the largest, highest-contrast
    // element rather than the speed.
    const bottom = this.el('hud-panel hud-wheel', this.root);
    this.wheelPanel = bottom;

    // Shift lights across the top edge. Green to amber to red, then flashing
    // at the limiter — you learn the position of the light you shift on, which
    // is faster to read than any bar.
    const ledRow = this.el('hud-leds', bottom);
    for (let i = 0; i < 15; i++) {
      this.leds.push(this.el('hud-led', ledRow));
    }

    const wheelRow = this.el('hud-wheelrow', bottom);

    const gearDisc = this.el('hud-geardisc', wheelRow);
    this.gear = this.el('hud-gear', gearDisc, 'N');

    const stats = this.el('hud-wheelstats', wheelRow);
    const speedCell = this.el('hud-cell', stats);
    this.el('hud-celllabel', speedCell, 'KMH');
    this.speed = this.el('hud-cellvalue', speedCell, '0');
    const rpmCell = this.el('hud-cell', stats);
    this.el('hud-celllabel', rpmCell, 'RPM');
    this.rpmValue = this.el('hud-cellvalue', rpmCell, '0');

    // ERS mode doubles as its own badge: the mode letter is what the driver
    // actually switches, so it reads as a button rather than a caption.
    this.ersBadge = this.el('hud-ersbadge', stats);
    this.ersMode = this.el('hud-ersmodetext', this.ersBadge, 'ERS (B)');
    this.ersPercent = this.el('hud-erspercent', this.ersBadge, '0%');

    this.drsBadge = this.el('hud-drs', wheelRow, 'DRS');

    // The rpm bar sits under everything as a thin trace, and the ERS store
    // beside it — both are continuous quantities, so a bar is the right form.
    const bars = this.el('hud-wheelbars', bottom);
    const rpmBar = this.el('hud-rpmbar', bars);
    this.rpmFill = this.el('hud-rpmfill', rpmBar);
    const ersRow = this.el('hud-ersrow', bars);
    this.el('hud-erslabel', ersRow, 'ERS');
    const ersBar = this.el('hud-ersbar', ersRow);
    this.ersFill = this.el('hud-ersfill', ersBar);

    // --- Bottom left: tyres and fuel --------------------------------------
    const carPanel = this.el('hud-panel hud-carstate', this.root);
    const tyreHeader = this.el('hud-tyreheader', carPanel);
    this.tyreCompound = this.el('hud-compound', tyreHeader, 'MEDIUM');

    const tyreGrid = this.el('hud-tyregrid', carPanel);
    const fWrap = this.el('hud-tyrewrap', tyreGrid);
    this.el('hud-tyrelabel', fWrap, 'FRONT');
    const fBar = this.el('hud-tyrebar', fWrap);
    this.tyreWearFront = this.el('hud-tyrefill', fBar);
    this.tyreTempFront = this.el('hud-tyretemp', fWrap, '--°');

    const rWrap = this.el('hud-tyrewrap', tyreGrid);
    this.el('hud-tyrelabel', rWrap, 'REAR');
    const rBar = this.el('hud-tyrebar', rWrap);
    this.tyreWearRear = this.el('hud-tyrefill', rBar);
    this.tyreTempRear = this.el('hud-tyretemp', rWrap, '--°');

    const fuelRow = this.el('hud-fuelrow', carPanel);
    this.fuel = this.el('hud-fuel', fuelRow, 'FUEL --.-L');
    this.fuelDelta = this.el('hud-fueldelta', fuelRow, '');

    // --- Damage panel -------------------------------------------------------
    this.buildDamagePanel();

    // --- Gaps -------------------------------------------------------------
    const gaps = this.el('hud-panel hud-gaps', this.root);
    this.gapsPanel = gaps;
    this.gapAhead = this.el('hud-gapahead', gaps, '');
    this.gapBehind = this.el('hud-gapbehind', gaps, '');

    // --- Conditions and flags ---------------------------------------------
    this.conditions = this.el('hud-panel hud-conditions', this.root, '');
    this.flagBanner = this.el('hud-flag', this.root, '');
    this.flagBanner.style.display = 'none';

    // --- Radio ------------------------------------------------------------
    this.radioFeed = this.el('hud-radio', this.root);

    // --- Camera + diagnostics ---------------------------------------------
    // Real buttons, not just a keyboard hint. The camera was bound to the `C` key
    // only, which is unusable on a phone and undiscoverable anywhere.
    this.buttonBar = this.el('hud-buttons', this.root);
    this.cameraButton = this.el('hud-btn', this.buttonBar, 'CAM');
    this.pitButton = this.el('hud-btn', this.buttonBar, 'PIT');
    this.cameraLabel = this.el('hud-camera', this.root, 'Chase');
    this.diagnostics = this.el('hud-diag', this.root, '');

    // --- Controls help ----------------------------------------------------
    // Shown for the first few seconds of a session and on H. Needing to ask how
    // to brake is a UI failure, not a player failure.
    this.helpOverlay = this.el('hud-help', this.root);
    this.helpOverlay.innerHTML =
      '<div class="help-title">CONTROLS</div>' +
      '<div class="help-grid">' +
      '<span class="k">&uarr; / W</span><span>Accelerate</span>' +
      '<span class="k">B / Space</span><span>Brake</span>' +
      '<span class="k">&darr;</span><span>Brake, then reverse when stopped</span>' +
      '<span class="k">&larr; &rarr;</span><span>Steer</span>' +
      '<span class="k">Shift</span><span>DRS (when available)</span>' +
      '<span class="k">E</span><span>ERS mode</span>' +
      '<span class="k">C</span><span>Camera</span>' +
      '<span class="k">L</span><span>Request pit stop</span>' +
      '<span class="k">P</span><span>Pause</span>' +
      '<span class="k">R</span><span>Racing line</span>' +
      '<span class="k">H</span><span>Toggle this help</span>' +
      '</div>';

    // --- Touch overlay ----------------------------------------------------
    this.touchOverlay = this.el('hud-touch', this.root);
    this.touchOverlay.style.display = 'none';
    this.joystick = this.el('touch-joystick', this.touchOverlay);
    this.joystickKnob = this.el('touch-knob', this.joystick);
    this.brakePad = this.el('touch-pad touch-brake', this.touchOverlay, 'BRAKE');
    this.throttlePad = this.el('touch-pad touch-throttle', this.touchOverlay, 'THROTTLE');
    this.reversePad = this.el('touch-pad touch-reverse', this.touchOverlay, 'REV');
  }

  /** Builds the timing tower rows once, sized to the field. */
  private ensureRows(n: number): void {
    while (this.rows.length < n) {
      const root = this.el('tower-row', this.tower);
      const pos = this.el('tower-pos', root, '');
      const team = this.el('tower-team', root, '');
      const code = this.el('tower-code', root, '');
      const tyre = this.el('tower-tyre', root, '');
      const gap = this.el('tower-gap', root, '');
      this.rows.push({
        root, pos, code, team, gap, tyre,
        lastText: { pos: '', code: '', gap: '', tyre: '' },
      });
    }
  }

  /**
   * Updates every readout. Called once per rendered frame.
   * Writes only values that changed.
   */
  /**
   * A top-down car diagram, one shape per damaged component.
   *
   * Drawn as inline SVG rather than as a grid of labelled bars because damage
   * is fundamentally spatial: "front left" means something instantly on a
   * picture of a car and needs reading on a list. Each shape carries the id of
   * the component it represents, so the update loop only rewrites a fill colour
   * and never touches layout.
   */
  private buildDamagePanel(): void {
    this.damagePanel = this.el('hud-panel hud-damage', this.root);
    this.el('hud-damagetitle', this.damagePanel, 'CAR');

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 170');
    svg.setAttribute('class', 'hud-damagesvg');
    this.damagePanel.appendChild(svg);

    // A part is a rounded rect or polygon in car-space: nose at the top,
    // gearbox at the bottom, mirroring the view a pit wall screen would show.
    const part = (id: ComponentId, tag: 'rect' | 'polygon', attrs: Record<string, string>) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      e.setAttribute('class', 'dmg-part');
      svg.appendChild(e);
      this.damageParts.set(id, e);
    };

    // Chassis spine — not a component, just context so the parts read as a car.
    const spine = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: '43', y: '26', width: '14', height: '96', rx: '5' })) {
      spine.setAttribute(k, v);
    }
    spine.setAttribute('class', 'dmg-chassis');
    svg.appendChild(spine);

    part('frontWingL', 'rect', { x: '8', y: '8', width: '32', height: '13', rx: '3' });
    part('frontWingR', 'rect', { x: '60', y: '8', width: '32', height: '13', rx: '3' });
    part('suspFL', 'rect', { x: '10', y: '28', width: '20', height: '22', rx: '4' });
    part('suspFR', 'rect', { x: '70', y: '28', width: '20', height: '22', rx: '4' });
    part('sidepodL', 'rect', { x: '16', y: '66', width: '24', height: '44', rx: '6' });
    part('sidepodR', 'rect', { x: '60', y: '66', width: '24', height: '44', rx: '6' });
    part('floor', 'rect', { x: '38', y: '74', width: '24', height: '46', rx: '5' });
    part('engine', 'rect', { x: '40', y: '112', width: '20', height: '20', rx: '4' });
    part('suspRL', 'rect', { x: '8', y: '122', width: '22', height: '26', rx: '4' });
    part('suspRR', 'rect', { x: '70', y: '122', width: '22', height: '26', rx: '4' });
    part('gearbox', 'rect', { x: '42', y: '134', width: '16', height: '14', rx: '3' });
    part('rearWing', 'rect', { x: '20', y: '150', width: '60', height: '12', rx: '3' });

    this.damageSummary = this.el('hud-damagesummary', this.damagePanel, 'OK');
  }

  /**
   * Sectors and lap times, top right.
   *
   * Three sector tiles across the top, the lap in progress underneath in the
   * largest type on the screen, then last and best. Colour on the tiles carries
   * the entire verdict, which is why the times themselves can stay small: the
   * driver reads the colour at a glance mid-corner and the number only on the
   * straight.
   */
  private buildTimingPanel(): void {
    const panel = this.el('hud-panel hud-timing', this.root);

    const row = this.el('timing-sectors', panel);
    for (let i = 0; i < 3; i++) {
      const cell = this.el('timing-sector', row);
      this.el('timing-sectorname', cell, 'S' + (i + 1));
      this.sectorCells.push(cell);
      this.sectorTimes.push(this.el('timing-sectortime', cell, '--.---'));
    }

    this.lapTime = this.el('timing-lap', panel, '0:00.000');

    const small = this.el('timing-small', panel);
    const lastWrap = this.el('timing-item', small);
    this.el('timing-label', lastWrap, 'LAST');
    this.lastLap = this.el('timing-value', lastWrap, '--:--.---');
    const bestWrap = this.el('timing-item', small);
    this.el('timing-label', bestWrap, 'BEST');
    this.bestLap = this.el('timing-value best', bestWrap, '--:--.---');

    // A signed bar for the delta. A number alone tells you the size of the gap;
    // a bar growing left or right of centre tells you instantly which side of
    // your best lap you are on, without reading anything.
    this.delta = this.el('timing-delta', panel, '');
    this.deltaBar = this.el('hud-deltabar', panel);
    this.deltaFill = this.el('hud-deltafill', this.deltaBar);
  }

  /**
   * Colours the three sector tiles.
   *
   * The rules, in priority order:
   *
   *   PURPLE  fastest anyone in the field has managed in that sector
   *   GREEN   the driver's own fastest of the session
   *   RED     the driver's own SLOWEST of the session
   *   YELLOW  anything else — slower than their best, but not their worst
   *
   * Purple outranks green because a sector can be both, and the field-wide
   * record is the more interesting fact. Green outranks red for the same
   * reason it does on a first flying lap, when the one time set is
   * simultaneously the fastest and the slowest.
   *
   * The driver's slowest is not tracked anywhere in the simulation — best
   * sectors are, worst are not — so it is accumulated here, off completed
   * sector times as they appear.
   */
  private updateTiming(engine: RaceEngine, player: CarEntry): void {
    const active = player.currentSectorIndex;

    for (let i = 0; i < 3; i++) {
      // A sector completes into `currentSectors`; watching that array catches
      // every completed sector exactly once, including the last one, which is
      // closed out by the line crossing rather than by a boundary.
      const done = player.currentSectors[i];
      if (done > 1 && done !== this.seenSector[i]) {
        this.seenSector[i] = done;
        if (done > this.worstSector[i]) this.worstSector[i] = done;
      }

      // Show the sector being driven live, the rest as last set.
      let time: number;
      let live = false;
      if (i === active) {
        time = player.currentSectorElapsed(engine.time);
        live = true;
      } else {
        time = player.currentSectors[i] > 0 ? player.currentSectors[i] : player.lastSectors[i];
      }

      setText(this.sectorTimes[i], time > 0 ? time.toFixed(3) : '--.---');

      let cls = 'timing-sector';
      if (live) cls += ' live';
      else if (time > 0) {
        const best = player.bestSectors[i];
        const worst = this.worstSector[i];
        if (engine.isSessionBestSector(i, time)) cls += ' purple';
        else if (best > 0 && time <= best + 1e-4) cls += ' green';
        else if (worst > 0 && time >= worst - 1e-4) cls += ' red';
        else cls += ' yellow';
      }
      setClass(this.sectorCells[i], cls);
    }
  }

  /**
   * Colours each part of the car diagram by its component's health.
   *
   * Writes only a class per part, and only when the band changes. Health moves
   * continuously under kerb wear, so writing a fresh fill colour every frame
   * would touch twelve SVG elements sixty times a second for a difference
   * nobody can see; four discrete bands are all the eye resolves anyway.
   */
  private updateDamage(player: CarEntry): void {
    const d = player.damage;
    for (const [id, el] of this.damageParts) {
      const cls = 'dmg-part dmg-' + bandOf(d.health[id]);
      if (el.getAttribute('class') !== cls) el.setAttribute('class', cls);
    }

    // The summary names the single worst part, because that is the decision the
    // driver actually has to make — whether this is worth pitting for.
    const worst = d.worst();
    const band = bandOf(worst.health);
    const text = band === 'ok'
      ? 'OK'
      : COMPONENT_NAMES[worst.id].toUpperCase() + '  ' + Math.round(worst.health * 100) + '%';
    setText(this.damageSummary, text);
    setClass(this.damageSummary, 'hud-damagesummary dmg-text-' + band);
  }

  /**
   * Builds or rebuilds the circuit map when the session's track changes.
   *
   * It cannot be built with the rest of the HUD: the HUD outlives sessions and
   * exists before any circuit has been chosen, and it is bound to a specific
   * set of cars. Rebuilding costs one pass over the spline, once per session.
   */
  private updateMap(engine: RaceEngine): void {
    if (!this.map) {
      this.mapHolder.textContent = '';
      this.map = new TrackMap(engine.track, engine.cars);
      this.mapHolder.appendChild(this.map.root);
      setText(this.mapTitle, engine.track.def.name.toUpperCase());
    }
    this.map.update();
  }

  /**
   * Drives the start gantry.
   *
   * Returns an event rather than a state so the caller can fire the beep and
   * the flash on exactly the frame they happen, without keeping its own copy of
   * the sequence's progress and risking the two drifting apart.
   *
   * @param remaining seconds until the lights go out
   */
  updateStartLights(remaining: number, started: boolean): StartLightEvent {
    if (started || remaining <= 0) {
      const wasCounting = this.litCount >= 0;
      if (wasCounting) {
        this.startLights.classList.add('hidden');
        this.litCount = -1;
        // The release is the lights going OUT, not a green light. Getting that
        // wrong is the fastest way to tell someone you have never watched a
        // Grand Prix.
        return { kind: 'go' };
      }
      return { kind: 'none' };
    }

    this.startLights.classList.remove('hidden');
    // Counting down from five: one more light every second.
    //
    // Indexed off elapsed time, not off `ceil(remaining)`. The latter is a
    // one-second-late off-by-one — it leaves the gantry dark for the first
    // second and the fifth light never comes on at all, because `remaining`
    // reaches zero while its ceiling is still 1.
    const elapsed = 5 - remaining;
    const lit = Math.min(5, Math.max(0, Math.floor(elapsed) + 1));
    if (lit === this.litCount) return { kind: 'none' };

    for (let i = 0; i < 5; i++) {
      const on = i < lit;
      for (const bulb of this.startBulbs[i]) {
        setClass(bulb, 'hud-bulb' + (on ? ' on' : ''));
      }
    }
    const lighting = lit > this.litCount && lit > 0;
    this.litCount = lit;
    return lighting ? { kind: 'light', index: lit } : { kind: 'none' };
  }

  update(engine: RaceEngine, player: CarEntry, input: InputController, fps: number, drawCalls: number): void {
    const p = player.physics;

    // A new session resets everything the HUD accumulates itself. The HUD
    // outlives sessions — it is built once, with the page — so without this a
    // qualifying run's slowest sector would still be colouring tiles in the
    // race that follows.
    if (engine !== this.lastEngine) {
      this.lastEngine = engine;
      this.worstSector[0] = this.worstSector[1] = this.worstSector[2] = 0;
      this.seenSector[0] = this.seenSector[1] = this.seenSector[2] = 0;
      this.shownMessages = 0;
      this.map = null;
    }

    // --- Speed, gear, rpm -------------------------------------------------
    setText(this.speed, Math.round(p.speedKph).toString());
    const gearLabel = p.inReverse ? 'R'
      : p.speedMs < 0.6 && player.appliedControls.throttle < 0.02 ? 'N'
      : String(p.gear);
    setText(this.gear, gearLabel);
    setClass(this.gear, 'hud-gear' + (p.inReverse ? ' reverse' : ''));

    setStyle(this.rpmFill, 'width', (p.rpmFraction * 100).toFixed(1) + '%');
    const rpmClass = p.rpmFraction > 0.965 ? 'hud-rpmfill rpm-red'
      : p.rpmFraction > 0.87 ? 'hud-rpmfill rpm-amber' : 'hud-rpmfill';
    setClass(this.rpmFill, rpmClass);

    // Shift lights: green up to 80%, amber to 94%, red beyond, all flashing at
    // the limiter — the pattern a real wheel uses.
    const frac = p.rpmFraction;
    const lit = Math.round(clamp01((frac - 0.45) / 0.55) * this.leds.length);
    const limiter = frac > 0.985;
    const flashOn = limiter && (Math.floor(performance.now() / 70) & 1) === 0;
    for (let i = 0; i < this.leds.length; i++) {
      const on = limiter ? flashOn : i < lit;
      const band = i < 7 ? 'g' : i < 12 ? 'a' : 'r';
      setClass(this.leds[i], 'hud-led led-' + band + (on ? ' on' : ''));
    }

    // --- DRS --------------------------------------------------------------
    const drsClass = p.drsOpen ? 'hud-drs drs-open'
      : p.drsAvailable ? 'hud-drs drs-armed' : 'hud-drs';
    setClass(this.drsBadge, drsClass);

    setText(this.rpmValue, Math.round(p.rpm).toString());

    // --- ERS --------------------------------------------------------------
    setStyle(this.ersFill, 'width', (p.ersChargePercent * 100).toFixed(1) + '%');
    // Single-letter mode, as on the wheel: H(arvest), B(alanced), P(ush),
    // O(vertake). The full word does not fit and is not what the driver reads.
    const mode = input.ersMode.toUpperCase();
    setText(this.ersMode, 'ERS (' + mode.charAt(0) + ')');
    setText(this.ersPercent, Math.round(p.ersChargePercent * 100) + '%');
    setClass(this.ersBadge, 'hud-ersbadge ers-' + input.ersMode);

    // --- Fuel -------------------------------------------------------------
    setText(this.fuel, 'FUEL ' + p.fuelRemaining.toFixed(1) + 'L');
    // Laps of fuel remaining versus laps of race remaining: the number a real
    // driver is actually given, because it says whether they must save.
    const lapsLeft = engine.lapsRemaining;
    const perLap = fuelPerLap(player, engine);
    if (perLap > 0.05 && lapsLeft > 0) {
      const lapsOfFuel = p.fuelRemaining / perLap;
      const margin = lapsOfFuel - lapsLeft;
      setText(this.fuelDelta, (margin >= 0 ? '+' : '') + margin.toFixed(1) + ' LAPS');
      setClass(this.fuelDelta, margin < 0 ? 'hud-fueldelta bad' : 'hud-fueldelta good');
    } else {
      setText(this.fuelDelta, '');
    }

    // --- Tyres ------------------------------------------------------------
    const compound = getCompound(player.compound);
    setText(this.tyreCompound, compound.name.toUpperCase());
    setStyle(this.tyreCompound, 'color', '#' + compound.colour.toString(16).padStart(6, '0'));

    setStyle(this.tyreWearFront, 'width', (clamp01(p.frontTires.wear) * 100).toFixed(0) + '%');
    setStyle(this.tyreWearRear, 'width', (clamp01(p.rearTires.wear) * 100).toFixed(0) + '%');
    setClass(this.tyreWearFront, 'hud-tyrefill ' + wearClass(p.frontTires.wear));
    setClass(this.tyreWearRear, 'hud-tyrefill ' + wearClass(p.rearTires.wear));
    setText(this.tyreTempFront, Math.round(p.frontTires.tempC) + '°');
    setText(this.tyreTempRear, Math.round(p.rearTires.tempC) + '°');
    setClass(this.tyreTempFront, 'hud-tyretemp ' + tempClass(p.frontTires.thermalBalance));
    setClass(this.tyreTempRear, 'hud-tyretemp ' + tempClass(p.rearTires.thermalBalance));

    // --- Position and timing ---------------------------------------------
    setText(this.position, 'P' + player.position);
    setStyle(this.teamStripe, 'background',
      '#' + player.team.colour.toString(16).padStart(6, '0'));
    const totalLaps = engine.config.laps || engine.track.def.raceLaps;
    if (engine.config.kind === 'race') {
      setText(this.lapCounter, 'LAP ' + Math.min(player.lap + 1, totalLaps) + '/' + totalLaps);
    } else {
      const remaining = Math.max(0, engine.config.durationS - engine.time);
      setText(this.lapCounter, engine.config.name + '  ' + formatClock(remaining));
    }

    setText(this.lapTime, formatLapTime(player.currentLapTime(engine.time)));
    setText(this.lastLap, formatLapTime(player.lastLapTime));
    setText(this.bestLap, formatLapTime(player.bestLapTime));

    // Delta to the player's own best, which is the number that tells you whether
    // the lap in progress is any good.
    if (player.bestLapTime > 0 && player.lap > 0) {
      const projected = player.currentLapTime(engine.time) - progressFraction(player, engine) * player.bestLapTime;
      setText(this.delta, formatDelta(projected));
      setClass(this.delta, 'timing-delta ' + (projected <= 0 ? 'good' : 'bad'));
      // Bar grows from the centre; +/- 1.5s spans the full half-width.
      const mag = Math.min(Math.abs(projected) / 1.5, 1) * 50;
      setStyle(this.deltaFill, 'width', mag.toFixed(1) + '%');
      setStyle(this.deltaFill, 'left', projected <= 0 ? (50 - mag).toFixed(1) + '%' : '50%');
      setClass(this.deltaFill, 'hud-deltafill ' + (projected <= 0 ? 'good' : 'bad'));
      setStyle(this.deltaBar, 'opacity', '1');
    } else {
      setText(this.delta, '');
      setStyle(this.deltaBar, 'opacity', '0');
    }

    this.updateTiming(engine, player);
    this.updateDamage(player);
    this.updateMap(engine);

    // --- Gaps -------------------------------------------------------------
    const ahead = player.perception.ahead;
    const behind = player.perception.behind;
    setText(this.gapAhead, ahead ? '▲ ' + formatGap(ahead.gapS) : '▲ —');
    setText(this.gapBehind, behind ? '▼ ' + formatGap(behind.gapS) : '▼ —');

    // --- Conditions -------------------------------------------------------
    setText(
      this.conditions,
      engine.weather.label + '   AIR ' + Math.round(engine.weather.airTempC) +
      '°   TRACK ' + Math.round(engine.weather.trackTempC) + '°',
    );

    // --- Flags ------------------------------------------------------------
    this.updateFlag(engine, player);

    // --- Timing tower -----------------------------------------------------
    this.updateTower(engine, player);

    // --- Radio ------------------------------------------------------------
    this.updateRadio(engine);

    // --- Camera and diagnostics ------------------------------------------
    setText(this.cameraLabel, engine.config.name);
    // Read the latch on the car, not the perception buffer: the engine rewrites
    // that buffer every physics step and the player's request never survived
    // in it, so the button never lit even when the call had been made.
    setClass(this.pitButton, 'hud-btn' + (player.pitRequested || player.inPitLane ? ' armed' : ''));
    setText(this.diagnostics, Math.round(fps) + ' fps · ' + drawCalls + ' calls');

    // --- Touch overlay ----------------------------------------------------
    this.updateTouch(input);
  }

  private updateFlag(engine: RaceEngine, player: CarEntry): void {
    const rc = engine.raceControl;
    let text = '';
    let cls = 'hud-flag';

    if (!engine.started) {
      text = engine.startLights > 0 ? 'LIGHTS OUT IN ' + Math.ceil(engine.startLights) : 'GO';
      cls = 'hud-flag flag-start';
    } else if (rc.sessionFlag === 'chequered') {
      text = 'CHEQUERED FLAG';
      cls = 'hud-flag flag-chequered';
    } else if (rc.sessionFlag === 'red') {
      text = 'RED FLAG';
      cls = 'hud-flag flag-red';
    } else if (rc.neutralisation === 'safety-car') {
      text = 'SAFETY CAR';
      cls = 'hud-flag flag-sc';
    } else if (rc.neutralisation === 'vsc') {
      text = 'VIRTUAL SAFETY CAR';
      cls = 'hud-flag flag-vsc';
    } else if (player.blueFlag) {
      text = 'BLUE FLAG — LET THEM BY';
      cls = 'hud-flag flag-blue';
    } else {
      const local = rc.flagAt(player.s);
      if (local === 'double-yellow') { text = 'DOUBLE YELLOW'; cls = 'hud-flag flag-yellow'; }
      else if (local === 'yellow') { text = 'YELLOW FLAG'; cls = 'hud-flag flag-yellow'; }
    }

    // In the pit lane, the one thing the driver needs is how far it is to their
    // own box. The box is marked on the road, but a distance is what turns
    // "somewhere along here" into "brake now", and it is what the crew would be
    // saying on the radio.
    if (player.inPitLane && !player.servicedThisVisit && !player.pitTransitOnly) {
      const d = player.perception.pitBoxAheadM;
      if (player.inPitBox) {
        text = 'IN THE BOX — ' + player.pitBoxTimer.toFixed(1) + 's';
        cls = 'hud-flag flag-start';
      } else if (d >= 0) {
        text = 'YOUR BOX  ' + Math.round(d) + 'm';
        cls = 'hud-flag flag-start';
      }
    }

    // Penalties take precedence — the player needs to know immediately.
    const pen = player.penalties[player.penalties.length - 1];
    if (!text && pen && !pen.served && pen.kind === 'drive-through') {
      text = 'DRIVE THROUGH PENALTY';
      cls = 'hud-flag flag-red';
    }
    if (player.disqualified) { text = 'DISQUALIFIED'; cls = 'hud-flag flag-red'; }

    if (text) {
      setText(this.flagBanner, text);
      setClass(this.flagBanner, cls);
      setStyle(this.flagBanner, 'display', 'block');
    } else {
      setStyle(this.flagBanner, 'display', 'none');
    }
  }

  private updateTower(engine: RaceEngine, player: CarEntry): void {
    const standings = engine.standings;
    // Show as much of the field as the viewport can actually hold, and a window
    // around the player when it cannot hold much. Height matters as much as
    // width: a 20-row tower does not fit in the 390px of a landscape iPhone,
    // and it used to overflow the viewport.
    const rowH = 19;
    const fits = Math.floor((window.innerHeight - 150) / rowH);
    const compact = window.innerWidth < 900 || fits < 10;
    const shown = compact
      ? Math.max(5, Math.min(fits, 7))
      : Math.min(standings.length, fits, 20);
    this.ensureRows(shown);

    let start = 0;
    if (compact) {
      const idx = standings.indexOf(player);
      start = Math.max(0, Math.min(idx - 3, standings.length - shown));
    }

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      // Rows are only ever created, never destroyed, so a window that has been
      // made shorter has more of them than it can now fit. Hiding the surplus
      // is what keeps the tower inside the viewport after a resize.
      const car = i < shown ? standings[start + i] : undefined;
      if (!car) {
        setStyle(row.root, 'display', 'none');
        continue;
      }
      setStyle(row.root, 'display', 'flex');

      const posText = String(car.position);
      // A car a lap or more down is reported as such, the way a broadcast tower
      // does it. Showing it as "+3.114" instead is not a rounding difference —
      // it says the car is three seconds off the one ahead when it is a whole
      // lap off, and it turned the bottom half of the tower into a close battle
      // that was not happening.
      const ahead = start + i > 0 ? standings[start + i - 1] : null;
      const lapsBehind = ahead ? car.lapsDown - ahead.lapsDown : 0;
      const gapText = car.retired ? 'DNF'
        : car.disqualified ? 'DSQ'
        : car.position === 1 ? 'LEADER'
        : engine.config.kind !== 'race'
          ? (car.bestLapTime > 0 ? formatLapTime(car.bestLapTime) : '--')
        : lapsBehind > 0 ? '+' + lapsBehind + (lapsBehind === 1 ? ' LAP' : ' LAPS')
        : formatGap(car.interval);
      const tyreText = getCompound(car.compound).code;

      if (row.lastText.pos !== posText) { row.pos.textContent = posText; row.lastText.pos = posText; }
      if (row.lastText.code !== car.driver.code) { row.code.textContent = car.driver.code; row.lastText.code = car.driver.code; }
      if (row.lastText.gap !== gapText) { row.gap.textContent = gapText; row.lastText.gap = gapText; }
      if (row.lastText.tyre !== tyreText) {
        row.tyre.textContent = tyreText;
        row.tyre.style.background = '#' + getCompound(car.compound).colour.toString(16).padStart(6, '0');
        row.lastText.tyre = tyreText;
      }
      row.team.style.background = '#' + car.team.colour.toString(16).padStart(6, '0');
      // The leader gets its own treatment, as it does on a broadcast tower:
      // whoever is winning is the one fact the graphic exists to convey.
      setClass(row.root, 'tower-row'
        + (car.position === 1 ? ' is-leader' : '')
        + (car === player ? ' is-player' : '')
        + (car.retired ? ' is-out' : ''));
    }
  }

  private updateRadio(engine: RaceEngine): void {
    const messages = engine.raceControl.messages;
    if (messages.length <= this.shownMessages) {
      // The log is bounded and shifts; resync if it wrapped.
      if (messages.length < this.shownMessages) this.shownMessages = messages.length;
      return;
    }

    for (let i = this.shownMessages; i < messages.length; i++) {
      const m = messages[i];
      const entry = document.createElement('div');
      entry.className = 'radio-entry sev-' + m.severity;
      entry.textContent = m.text;
      this.radioFeed.appendChild(entry);
      this.radioEntries.push(entry);

      // Fade and remove after a few seconds. Removing keeps the DOM small.
      window.setTimeout(() => {
        entry.classList.add('fading');
        window.setTimeout(() => {
          entry.remove();
          const idx = this.radioEntries.indexOf(entry);
          if (idx >= 0) this.radioEntries.splice(idx, 1);
        }, 600);
      }, 5200);
    }
    this.shownMessages = messages.length;

    // Hard cap, in case of a burst.
    while (this.radioEntries.length > 5) {
      const old = this.radioEntries.shift();
      old?.remove();
    }
  }

  private updateTouch(input: InputController): void {
    if (!input.showTouchOverlay) {
      setStyle(this.touchOverlay, 'display', 'none');
      return;
    }
    setStyle(this.touchOverlay, 'display', 'block');

    if (input.joystickActive) {
      setStyle(this.joystick, 'display', 'block');
      setStyle(this.joystick, 'left', input.joystickCentreX + 'px');
      setStyle(this.joystick, 'top', input.joystickCentreY + 'px');
      const o = input.joystickOffset;
      const clampedX = Math.max(-o.radius, Math.min(o.radius, o.x));
      setStyle(this.joystickKnob, 'transform', 'translate(' + clampedX + 'px, 0)');
      setStyle(this.joystick, 'width', o.radius * 2 + 'px');
    } else {
      setStyle(this.joystick, 'display', 'none');
    }

    setClass(this.throttlePad, 'touch-pad touch-throttle' + (input.throttleHeld ? ' active' : ''));
    setClass(this.brakePad, 'touch-pad touch-brake' + (input.brakeHeld ? ' active' : ''));
    setClass(this.reversePad, 'touch-pad touch-reverse' + (input.reverseTouchHeld ? ' active' : ''));
  }

  /** Shows the current camera mode on the button. */
  setCameraLabel(label: string): void {
    setText(this.cameraButton, label.toUpperCase());
  }

  /**
   * Tells the HUD which camera is live.
   *
   * The only thing this changes is the bottom-centre wheel display, which is
   * hidden in the cockpit: the car has a real steering wheel with a real dash
   * on it there, and the panel sits directly on top of it showing the same
   * three numbers.
   */
  setCameraMode(mode: string): void {
    const inCockpit = mode === 'cockpit';
    if (inCockpit === this.cockpitView) return;
    this.cockpitView = inCockpit;
    setStyle(this.wheelPanel, 'display', inCockpit ? 'none' : 'flex');
    setClass(this.gapsPanel, 'hud-panel hud-gaps' + (inCockpit ? ' cockpit' : ''));
  }
  private cockpitView = false;

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
  }

  /** Shows or hides the controls overlay. */
  setHelpVisible(v: boolean): void {
    this.helpOverlay.classList.toggle('visible', v);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Writes text only when it changed.
 * Assigning identical textContent still marks the node dirty in some engines, and
 * this HUD touches ~60 nodes a frame.
 */
function setText(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

function setClass(el: HTMLElement, value: string): void {
  if (el.className !== value) el.className = value;
}

function setStyle(el: HTMLElement, prop: string, value: string): void {
  // Direct assignment rather than setProperty: these are camelCase CSSOM names
  // ('display', 'width'), and setProperty expects hyphenated CSS names.
  const style = el.style as unknown as Record<string, string>;
  if (style[prop] !== value) style[prop] = value;
}

function wearClass(wear: number): string {
  return wear < 0.25 ? 'critical' : wear < 0.42 ? 'warn' : 'ok';
}

function tempClass(balance: number): string {
  if (balance > 1.15) return 'hot';
  if (balance < -1) return 'cold';
  return 'ideal';
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return m + ':' + (s < 10 ? '0' + s : s);
}

/** How far through the current lap the car is, 0..1. */
function progressFraction(car: CarEntry, engine: RaceEngine): number {
  return clamp01(car.s / engine.track.length);
}

/** Fuel used per lap, from what has actually been burned so far. */
function fuelPerLap(car: CarEntry, engine: RaceEngine): number {
  const laps = car.lap + progressFraction(car, engine);
  if (laps < 0.4) return 0;
  const used = car.setup.fuelLoadL - car.physics.fuelRemaining;
  return used / laps;
}

/** Exposed for the standings screen. */
export { formatLapTime, formatGap, MS_TO_KPH };
