import { clamp01, formatDelta, formatGap, formatLapTime, MS_TO_KPH } from '../core/MathUtils';
import { getCompound } from '../data/tires';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';
import type { InputController } from '../input/InputController';
import { bandOf, COMPONENT_NAMES, type ComponentId } from '../race/DamageModel';
import type { FlagSignal, RaceControlMessage, TeamNote } from '../race/RaceControlManager';
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

/**
 * One line of the running order.
 *
 * Six cells, in the shape a broadcast timing panel uses: a team-colour bar, the
 * position, the team's mark, the driver's name over their team's name, then the
 * gap and the best lap right-aligned in the figure face. The old row was a
 * three-letter code and a number — `HAL  +0.985` — which is all a 224px column
 * had space for, and which asks the viewer to have memorised twenty
 * abbreviations before the graphic tells them anything.
 *
 * `seen` is the whole performance story. Every cell is compared before it is
 * written, so a frame in which nothing overtakes anybody writes nothing at all
 * — and the mark, which is a five-element SVG, is only rebuilt when the car in
 * the row changes team, which happens once a session at most.
 */
interface Row {
  root: HTMLElement;
  bar: HTMLElement;
  pos: HTMLElement;
  mark: HTMLElement;
  first: HTMLElement;
  surname: HTMLElement;
  team: HTMLElement;
  gap: HTMLElement;
  best: HTMLElement;
  lastLap: HTMLElement;
  tyre: HTMLElement;
  seen: {
    pos: string; first: string; surname: string; team: string; tyre: string;
    gap: string; best: string; lastLap: string; markTeam: string; colour: string;
  };
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
  /** One pill per timing sector, under the map, showing that sector's flag. */
  private sectorFlagPills: HTMLElement[] = [];
  private readonly sectorFlagShown: FlagSignal[] = ['green', 'green', 'green'];

  private fuel!: HTMLElement;
  private fuelDelta!: HTMLElement;
  private lapCounter!: HTMLElement;
  private position!: HTMLElement;
  private sessionName!: HTMLElement;
  private fastestBar!: HTMLElement;
  private fastestFirst!: HTMLElement;
  private fastestWho!: HTMLElement;
  private fastestTime!: HTMLElement;
  private lapTime!: HTMLElement;
  private lastLap!: HTMLElement;
  private bestLap!: HTMLElement;
  private delta!: HTMLElement;
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

  private flagBanner!: HTMLElement;
  private cameraLabel!: HTMLElement;
  private diagnostics!: HTMLElement;

  // --- The left rail -------------------------------------------------------
  /** The bottom-anchored column the whole team side stacks into. */
  private notices!: HTMLElement;
  private alertStack!: HTMLElement;
  /**
   * Where the pit sheet lives, so it is laid out BY the rail rather than over
   * it. Public because the app shell owns the sheet — the sheet mutates the
   * car, which is not the instrument cluster's business — but the rail owns
   * where it sits.
   */
  pitSlot!: HTMLElement;
  /** True while the pit sheet is up, which changes what else the rail may show. */
  private pitSheetOpen = false;
  private pitCue!: HTMLElement;
  private pitCueText!: HTMLElement;
  private neutralCue!: HTMLElement;
  private neutralCueText!: HTMLElement;

  private radioCard!: HTMLElement;
  private radioMark!: HTMLElement;
  private radioDriver!: HTMLElement;
  private radioTurnsEl!: HTMLElement;
  private readonly radioTurnRows: HTMLElement[] = [];
  /** Timers for the card currently on screen, cleared when it is replaced. */
  private radioTimers: number[] = [];

  private weatherPanel!: HTMLElement;
  private weatherPill!: HTMLElement;
  private weatherTemps!: HTMLElement;

  /** Cards on screen, oldest first. */
  private alertCards: HTMLElement[] = [];
  /** The pit advice the pop-up last spoke, so it speaks once per change. */
  private lastAdvice = '';
  /** Signature of what is pinned to the rail, for `enforceRailBudget`. */
  private lastPinned = '';
  /** Which team the portraits and the radio mark were drawn for. */
  private markedTeam = '';
  /** Driver codes of the field — tokens `relayed` must leave in capitals. */
  private keepCaps = new Set<string>();
  /** Race-control state the radio card has already reacted to. */
  private lastNeutral = 'none';
  private lastSessionFlag = 'green';
  private radioPitShown = false;

  private tower!: HTMLElement;
  private startLights!: HTMLElement;
  private readonly startBulbs: HTMLElement[][] = [];
  /** Lights lit last frame, so each transition fires exactly once. */
  private litCount = -1;
  private rows: Row[] = [];

  private buttonBar!: HTMLElement;
  private cameraButton!: HTMLElement;
  private pitButton!: HTMLElement;
  private menuButton!: HTMLElement;

  private touchOverlay!: HTMLElement;
  private joystick!: HTMLElement;
  private joystickKnob!: HTMLElement;
  private throttlePad!: HTMLElement;
  private brakePad!: HTMLElement;
  private reversePad!: HTMLElement;

  /**
   * The last race-control bulletin relayed.
   *
   * Identity, not a count. The log is capped at sixty entries and SHIFTS when
   * it is full, so `messages.length` stops growing — and a HUD watching the
   * length silently stops relaying anything for the rest of a busy race. The
   * panel this replaced had that bug from the day it was written.
   */
  private lastMessage: RaceControlMessage | null = null;

  /**
   * How long a pop-up and a radio card stand before they leave, ms.
   *
   * A property rather than a constant for one reason, and it is worth stating
   * because it is a test seam in production code: a single headless screenshot
   * of a 1400x900 WebGL page under a software rasteriser takes several seconds,
   * which is long enough that a seven-second pop-up had come and gone before
   * the shutter closed. The sweep photographed a HUD with no notifications on
   * it and the notifications were working the whole time. The shoot harness
   * raises this; nothing else touches it.
   */
  alertDwellMs = ALERT_LIFE_MS;
  radioDwellMs = RADIO_LIFE_MS;

  /** Called when the on-screen camera button is used. */
  onCameraPressed: (() => void) | null = null;
  /** Called when the on-screen pit button is used. */
  onPitPressed: (() => void) | null = null;
  /** Called when the on-screen menu button is used. */
  onMenuPressed: (() => void) | null = null;

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
    wire(this.menuButton, () => this.onMenuPressed?.());
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
    this.tower.dataset.probe = 'tower';
    // A team-colour stripe down the edge: instantly identifies whose car you
    // are in, and it is how every broadcast graphic does it.
    this.teamStripe = this.el('hud-stripe', this.tower);

    // The header block. What a broadcast leaves on screen permanently is not
    // just the order — it is the session, the lap, and who holds the fastest
    // lap. The last of those was nowhere in this game: the purple was on the
    // sector tiles of the player's own panel and told you nothing about the
    // other nineteen cars.
    this.sessionName = this.el('tower-session', this.tower, '');
    const towerHead = this.el('tower-head', this.tower);
    this.position = this.el('tower-position', towerHead, 'P1');
    this.lapCounter = this.el('tower-lapcount', towerHead, 'LAP 1/50');

    // The fastest lap, in its own outlined capsule. Purple, because purple is
    // the outright best in this system and the fastest lap is the definition
    // of it — the same purple the holder's name is drawn in below.
    this.fastestBar = this.el('tower-fastest', this.tower);
    this.el('fastest-label', this.fastestBar, 'Fastest lap');
    this.el('fastest-dot', this.fastestBar, '·');
    this.fastestFirst = this.el('fastest-first', this.fastestBar, '');
    this.fastestWho = this.el('fastest-who', this.fastestBar, '');
    this.fastestTime = this.el('fastest-time', this.fastestBar, '');
    this.fastestBar.dataset.probe = 'fastest';

    // The column header. It shares its grid template with every row below it
    // through one custom property, so a column cannot drift from its label —
    // which is what a header row is for, and what two separately-tuned widths
    // would eventually undo.
    const cols = this.el('tower-cols', this.tower);
    for (const [cls, label] of [
      ['c-bar', ''], ['c-pos', 'P'], ['c-mark', ''], ['c-driver', 'Driver'],
      ['c-gap', 'Gap'], ['c-best', 'Best'], ['c-lap', 'Lap'], ['c-tyre', ''],
    ] as [string, string][]) {
      this.el('tower-col ' + cls, cols, label);
    }

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

    // A pill per timing sector under the map. The map itself is the precise
    // answer — it colours the actual corner — but at the size a HUD map runs on
    // a phone the difference between "sector 2 is yellow" and "sector 3 is
    // yellow" is a few pixels of hue on a thin line. These three pills are the
    // same information in the form the driver says it out loud, and they are
    // legible in peripheral vision, which the map is not.
    const flagRow = this.el('map-flags', this.mapPanel);
    for (let i = 0; i < 3; i++) {
      this.sectorFlagPills.push(this.el('map-flagpill flag-green', flagRow, 'S' + (i + 1)));
    }

    // --- Right column: the wheel display ----------------------------------
    //
    // "The speedometer is covering everything that's visible in this camera."
    // It was: a 470px pill across the bottom centre, which is exactly where the
    // road is in an onboard shot and where the car is in a chase one. The
    // reference broadcast HUD never puts anything there. It runs a single
    // column down the right edge — timing panel, then speed, gear, ERS and
    // battery under it — a tower down the left, small widgets in the corners,
    // and it leaves the whole middle and bottom of the screen alone.
    //
    // So this panel is now the second item in that right-hand column, directly
    // under the timing panel. Nothing was dropped to make it fit: every readout
    // that was on the pill is still here, re-flowed from one wide row into a
    // narrow stack. It also means there is no longer a stripped-down cockpit
    // variant, because a panel in the corner does not need one — see
    // `setCameraMode`.
    //
    // Laid out like a real steering-wheel dash rather than a games HUD: a big
    // gear numeral in its own disc on the left, the numeric readouts beside it,
    // and the shift lights across the top. The gear is the thing a driver
    // checks most often and the only item legible at a glance in peripheral
    // vision, which is why it gets the largest, highest-contrast element rather
    // than the speed.
    const bottom = this.el('hud-panel hud-wheel', this.root);

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

    this.drsBadge = this.el('hud-drs', wheelRow, 'DRS');

    // ERS mode doubles as its own badge: the mode letter is what the driver
    // actually switches, so it reads as a button rather than a caption.
    //
    // Its own row rather than a third cell beside the speed and the rpm: in a
    // 244px column three cells and a DRS badge on one line leaves each of them
    // about fifty pixels, and a readout squeezed to fifty pixels is a readout
    // nobody reads.
    this.ersBadge = this.el('hud-ersbadge', bottom);
    this.ersMode = this.el('hud-ersmodetext', this.ersBadge, 'ERS (B)');
    this.ersPercent = this.el('hud-erspercent', this.ersBadge, '0%');

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
    this.gapAhead = this.el('hud-gapahead', gaps, '');
    this.gapBehind = this.el('hud-gapbehind', gaps, '');

    // --- Weather bug -------------------------------------------------------
    this.buildWeather();

    // --- Flag --------------------------------------------------------------
    // The one graphic still allowed in the middle of the frame, and only
    // because it has been moved hard against the TOP edge, where every camera
    // in this game is looking at sky. A flag is the single loudest thing race
    // control can say and it earns the centre column; nothing else does.
    this.flagBanner = this.el('hud-flag', this.root, '');
    this.flagBanner.dataset.probe = 'flag';
    this.flagBanner.style.display = 'none';

    // --- The left rail -----------------------------------------------------
    this.buildNotices();

    // --- Camera + diagnostics ---------------------------------------------
    // Real buttons, not just a keyboard hint. The camera was bound to the `C` key
    // only, which is unusable on a phone and undiscoverable anywhere.
    this.buttonBar = this.el('hud-buttons', this.root);
    this.cameraButton = this.el('hud-btn', this.buttonBar, 'CAM');
    this.pitButton = this.el('hud-btn', this.buttonBar, 'PIT');
    // The way out. `P`/`Escape` already paused the simulation, but on a phone
    // there is no Escape key, and a pause with nothing on screen is
    // indistinguishable from the game having frozen.
    this.menuButton = this.el('hud-btn', this.buttonBar, 'MENU');
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
      '<span class="k">L</span><span>Request pit stop, or wave it off</span>' +
      '<span class="k">T</span><span>Pit sheet: next tyre</span>' +
      '<span class="k">F</span><span>Pit sheet: front wing</span>' +
      '<span class="k">Enter</span><span>Pit sheet: confirm</span>' +
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

  /**
   * The weather bug.
   *
   * It replaces a line of grey monospace across the top centre of the screen
   * that read `Dry AIR 18° TRACK 28°` — every fact present, none of them
   * legible at 200km/h, and standing in the middle of the frame while it
   * failed. Same three facts, in the shape a broadcast uses: a drawn sky, the
   * condition in a solid pill, the two temperatures under it.
   */
  private buildWeather(): void {
    this.weatherPanel = this.el('hud-weather is-dry', this.root);
    this.weatherPanel.dataset.probe = 'weather';
    const glyph = this.el('weather-glyph', this.weatherPanel);
    glyph.appendChild(weatherGlyphSvg());
    const body = this.el('weather-body', this.weatherPanel);
    this.weatherPill = this.el('weather-pill', body, 'DRY TRACK');
    this.weatherTemps = this.el('weather-temps', body, '');
  }

  /**
   * The notice stack: the pit wall's whole side of the conversation.
   *
   * Anchored at its BOTTOM edge, so it grows upward into empty sky rather than
   * downward over the car-state panel. The order of the children is the point:
   * the two LIVE cards — the pit line and the neutralisation line, which carry
   * numbers that change every frame — are last, so they hold a fixed position
   * on the screen that a driver can learn. Everything transient stacks above
   * them. A pop-up that shoves the distance-to-your-box two lines down the
   * instant it appears is a pop-up that costs you the pit entry.
   */
  private buildNotices(): void {
    this.notices = this.el('hud-notices', this.root);

    // --- The radio card, top of the stack ---------------------------------
    //
    // THE BROADCAST CARD, not the social-media one. A television radio clip is
    // a compact three-line plate, and that is what belongs on screen while
    // somebody is driving: the driver's SURNAME in his team's colour, hard
    // caps, right-aligned, with RADIO under it in white and the team's mark
    // beside it; an accent rule in the team colour; then the words themselves,
    // quoted, in heavy caps.
    //
    // THE COLOUR IS THE ATTRIBUTION and it is the only attribution there is:
    // the DRIVER speaks in his team's colour, the PIT WALL speaks in white.
    // Nothing is labelled, because a broadcast never labels them.
    //
    // The mark is this game's own generated geometry keyed to the team, in the
    // team's own colour. No real badge is reproduced.
    this.radioCard = this.el('hud-radiocard', this.notices);
    this.radioCard.dataset.probe = 'radio';
    this.radioCard.style.display = 'none';

    const head = this.el('radio-head', this.radioCard);
    this.radioMark = this.el('radio-mark', head);
    const who = this.el('radio-who', head);
    this.radioDriver = this.el('radio-driver', who, '');
    this.el('radio-title', who, 'Radio');
    this.el('radio-rule', this.radioCard);

    this.radioTurnsEl = this.el('radio-turns', this.radioCard);
    // Two slots, built once. The full exchange is longer — see `radioExchange`,
    // which keeps the whole argument — but a card three lines tall carries the
    // push-back and the answer, and that pair IS the argument in its shortest
    // honest form. Creating elements inside an event handler that fires under a
    // safety car is how a frame gets dropped at the worst possible moment.
    for (let i = 0; i < RADIO_TURNS_SHOWN; i++) {
      const turn = this.el('radio-turn', this.radioTurnsEl);
      turn.style.display = 'none';
      this.radioTurnRows.push(turn);
    }

    // --- Transient pop-ups ------------------------------------------------
    this.alertStack = this.el('hud-alerts', this.notices);
    this.alertStack.dataset.probe = 'alerts';

    // --- The pit sheet ----------------------------------------------------
    //
    // A slot in the column rather than a panel floating over it. The sheet used
    // to be absolutely positioned at `left: 10px; bottom: 150px`, which put it
    // straight across the top-left corner of the radio card — the portrait and
    // half the principal's name behind an opaque panel — on every viewport at
    // once. Two boxes given fixed coordinates on the same edge will eventually
    // collide; two flex children of one column cannot.
    //
    // Below the pop-ups and above the live cues: it is a decision, so it wants
    // the stable position nearest the cues, and it outranks anything transient.
    this.pitSlot = this.el('hud-pitslot', this.notices);
    this.pitSlot.dataset.probe = 'pitslot';

    // --- The two live cards, pinned to the bottom -------------------------
    this.neutralCue = this.el('hud-neutral-cue', this.notices);
    this.el('cue-tag', this.neutralCue, 'Control');
    this.neutralCueText = this.el('cue-text', this.neutralCue, '');
    this.neutralCue.dataset.probe = 'neutral';
    this.neutralCue.style.display = 'none';

    this.pitCue = this.el('hud-pit-cue', this.notices);
    this.el('cue-tag', this.pitCue, 'Pit');
    this.pitCueText = this.el('cue-text', this.pitCue, '');
    this.pitCue.dataset.probe = 'pit';
    this.pitCue.style.display = 'none';
  }

  /** Builds the timing tower rows once, sized to the field. */
  private ensureRows(n: number): void {
    while (this.rows.length < n) {
      const root = this.el('tower-row', this.tower);
      const bar = this.el('tower-bar', root);
      const pos = this.el('tower-pos', root, '');
      const mark = this.el('tower-mark', root);
      const who = this.el('tower-who', root);
      const nameLine = this.el('tower-name', who);
      const first = this.el('tower-first', nameLine, '');
      const surname = this.el('tower-surname', nameLine, '');
      const sub = this.el('tower-sub', who);
      const team = this.el('tower-team', sub, '');
      const gap = this.el('tower-gap', root, '');
      const best = this.el('tower-best', root, '');
      const lastLap = this.el('tower-lastlap', root, '');
      const tyre = this.el('tower-tyre', root, '');
      this.rows.push({
        root, bar, pos, mark, first, surname, team, gap, best, lastLap, tyre,
        seen: {
          pos: '', first: '', surname: '', team: '', tyre: '',
          gap: '', best: '', lastLap: '', markTeam: '', colour: '',
        },
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
    const rc = engine.raceControl;
    if (!this.map) {
      this.mapHolder.textContent = '';
      this.map = new TrackMap(engine.track, engine.cars, rc.marshalSectorCount);
      this.mapHolder.appendChild(this.map.root);
      setText(this.mapTitle, engine.track.def.name.toUpperCase());
    }
    this.map.update(rc);

    // The three pills. Read from the same `signalBetween` the map's own sector
    // chips use, so the pill and the chip cannot disagree.
    const s1 = engine.track.def.sector1EndS;
    const s2 = engine.track.def.sector2EndS;
    const bounds: [number, number][] = [[0, s1], [s1, s2], [s2, engine.track.length]];
    for (let i = 0; i < 3; i++) {
      const sig = rc.signalBetween(bounds[i][0], bounds[i][1]);
      if (sig !== this.sectorFlagShown[i]) {
        this.sectorFlagShown[i] = sig;
        setClass(this.sectorFlagPills[i], 'map-flagpill flag-' + sig);
        setText(this.sectorFlagPills[i], SECTOR_PILL_TEXT[sig].replace('#', String(i + 1)));
      }
    }
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
      // Everything already in the log belongs to the session that just ended,
      // or to the part of this one that happened before the HUD was pointed at
      // it. Neither is news.
      const log = engine.raceControl.messages;
      this.lastMessage = log.length > 0 ? log[log.length - 1] : null;
      this.map = null;
      this.lastAdvice = '';
      this.lastNeutral = 'none';
      this.lastSessionFlag = 'green';
      this.radioPitShown = false;
      this.hideRadioCard(true);
      for (const c of this.alertCards.slice()) this.dismissAlert(c, true);
      // The field's driver codes, so `relayed` knows which three-letter words
      // are people. Built once per session; the field does not change inside
      // one, and guessing instead turns "the" into a driver.
      this.keepCaps = new Set(engine.cars.map((c) => c.driver.code));
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
    setText(this.sessionName, engine.config.name.toUpperCase() + ' · ' + engine.track.def.name.toUpperCase());
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

    // --- Weather ----------------------------------------------------------
    this.updateWeather(engine);

    // --- Flags ------------------------------------------------------------
    this.updateFlag(engine, player);

    // --- Timing tower -----------------------------------------------------
    this.updateTower(engine, player);

    // --- The left rail ----------------------------------------------------
    this.updatePitCue(engine, player);
    this.updateNeutralCue(engine, player);
    this.updateAlerts(engine, player);
    this.updateRadioCard(engine, player);
    this.enforceRailBudget();

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

  /** The weather bug: one class and two strings, both diffed. */
  private updateWeather(engine: RaceEngine): void {
    const w = weatherReadout(engine.weather);
    setText(this.weatherPill, w.label);
    setClass(this.weatherPill, 'weather-pill wx-' + w.tone);
    setText(this.weatherTemps, w.temps);
    setClass(this.weatherPanel, 'hud-weather is-' + w.tone);
  }

  /**
   * The pit line: when to come in, where the box is, and what the limiter is
   * doing.
   *
   * All three were missing or unreadable. Nothing anywhere prompted the player
   * to pit — the strategist knows, the tyre model knows, the damage model knows,
   * and the one car never told was the player's. The box distance was written
   * into a banner the team radio covers. And nothing said whether the limiter
   * was engaged. "That pitstop logic is fucked, I don't even know when to pit or
   * where to be at" is a fair reading of that.
   *
   * It has not lost anything by moving off the middle of the screen. This is
   * still the PERSISTENT statement — it holds for as long as the fact holds,
   * so a driver who misses the pop-up has not lost the instruction. The pop-up
   * is the attention on top of it, not a replacement for it.
   */
  private updatePitCue(engine: RaceEngine, player: CarEntry): void {
    let text = '';
    let cls = 'hud-pit-cue';

    if (player.inPitLane) {
      const limiter = player.appliedControls.pitLimiter ? 'LIMITER ON' : 'LIMITER OFF';
      if (player.inPitBox) {
        text = 'IN THE BOX — ' + player.pitBoxTimer.toFixed(1) + 's';
        cls += ' cue-box';
      } else if (player.servicedThisVisit) {
        text = 'PIT EXIT · ' + limiter;
        cls += ' cue-live';
      } else if (player.pitTransitOnly) {
        text = 'SERVING DRIVE-THROUGH · ' + limiter;
        cls += ' cue-warn';
      } else {
        const d = player.perception.pitBoxAheadM;
        text = (d >= 0 ? 'YOUR BOX ' + Math.round(d) + 'm' : 'YOUR BOX AHEAD') + ' · ' + limiter;
        cls += ' cue-live';
      }
    } else if (player.pitRequested) {
      text = 'PIT CONFIRMED — BOX THIS LAP';
      cls += ' cue-live';
    } else {
      const advice = engine.pitAdvice(player);
      if (advice) { text = advice + ' — PRESS PIT'; cls += ' cue-warn'; }
      else {
        const planned = plannedStopCue(engine, player);
        if (planned) { text = planned; cls += ' cue-live'; }
      }
    }

    if (text) {
      setText(this.pitCueText, text);
      setClass(this.pitCue, cls);
      setStyle(this.pitCue, 'display', 'flex');
    } else {
      setStyle(this.pitCue, 'display', 'none');
    }
  }

  private updateNeutralCue(engine: RaceEngine, player: CarEntry): void {
    const cue = neutralisationCue(engine, player);
    if (!cue) {
      setStyle(this.neutralCue, 'display', 'none');
      return;
    }
    setText(this.neutralCueText, cue.text);
    setClass(this.neutralCue, cue.cls);
    setStyle(this.neutralCue, 'display', 'flex');
  }

  /**
   * The running order.
   *
   * Rebuilt around the broadcast row: colour bar, position, the team's own
   * generated mark, the driver's name over their team's, then the gap and the
   * best lap in right-aligned figures. The panel it replaces fitted twenty
   * three-letter codes into 224 pixels, which is a dense and complete answer
   * to a question nobody asked — you cannot read twenty rows at 300km/h, and
   * `MBE +0.235` only means anything to somebody who has already learnt the
   * abbreviations. Fourteen legible rows beat twenty illegible ones.
   *
   * The row count is bounded rather than "as many as fit" for a second reason:
   * everything else the team says lives in the same left rail, and a tower
   * that grows to the bottom of the viewport is a tower standing on the pit
   * instruction.
   */
  private updateTower(engine: RaceEngine, player: CarEntry): void {
    const standings = engine.standings;
    const fit = towerFit(window.innerWidth, window.innerHeight);
    const shown = Math.min(standings.length, fit.rows);
    this.ensureRows(shown);

    // A window around the player whenever the whole field does not fit — being
    // shown P1 to P14 while you are running sixteenth is a graphic about
    // somebody else's race — and the LEADER pinned to the top of it whenever
    // that window has moved off them. "See who hit the fastest lap, and the
    // race leaders" is the whole job of this panel, and a window that scrolls
    // past P1 answers neither. Broadcast towers do exactly this.
    let start = 0;
    let pinLeader = false;
    if (shown < standings.length) {
      const idx = standings.indexOf(player);
      start = Math.max(0, Math.min(idx - Math.floor(shown / 2), standings.length - shown));
      if (start > 0) {
        pinLeader = true;
        const rest = shown - 1;
        start = Math.max(1, Math.min(idx - Math.floor(rest / 2), standings.length - rest));
      }
    }

    // Who holds the fastest lap, and what it is. One pass over twenty cars and
    // no allocation — cheaper than the string compares it saves downstream.
    const fastest = fastestLap(standings);
    const sessionBest = fastest ? fastest.time : 0;
    if (fastest) {
      setText(this.fastestFirst, fastest.first);
      setText(this.fastestWho, fastest.surname);
      setText(this.fastestTime, formatLapTime(fastest.time));
      setStyle(this.fastestBar, 'display', 'flex');
    } else {
      setStyle(this.fastestBar, 'display', 'none');
    }

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      // Rows are only ever created, never destroyed, so a window that has been
      // made shorter has more of them than it can now fit. Hiding the surplus
      // is what keeps the tower inside the viewport after a resize.
      // With the leader pinned, row zero is P1 and everything below it is the
      // window, shifted by one.
      const at = pinLeader ? (i === 0 ? 0 : start + i - 1) : start + i;
      const car = i < shown ? standings[at] : undefined;
      if (!car) {
        setStyle(row.root, 'display', 'none');
        continue;
      }
      setStyle(row.root, 'display', 'grid');

      // The car actually ahead on the road, which is what an interval is
      // measured to — not the row above, which may be the pinned leader with
      // half the field between them.
      const ahead = at > 0 ? standings[at - 1] : null;
      const cells = standingsCells(engine, car, ahead, standings[0]);
      const seen = row.seen;

      if (seen.pos !== cells.pos) { row.pos.textContent = cells.pos; seen.pos = cells.pos; }
      if (seen.first !== cells.first) { row.first.textContent = cells.first; seen.first = cells.first; }
      if (seen.surname !== cells.surname) { row.surname.textContent = cells.surname; seen.surname = cells.surname; }
      if (seen.team !== cells.team) { row.team.textContent = cells.team; seen.team = cells.team; }
      if (seen.gap !== cells.gap) { row.gap.textContent = cells.gap; seen.gap = cells.gap; }
      if (seen.best !== cells.best) { row.best.textContent = cells.best; seen.best = cells.best; }
      if (seen.lastLap !== cells.lastLap) { row.lastLap.textContent = cells.lastLap; seen.lastLap = cells.lastLap; }
      if (seen.tyre !== cells.tyre) {
        row.tyre.textContent = cells.tyre;
        row.tyre.style.color = '#' + getCompound(car.compound).colour.toString(16).padStart(6, '0');
        seen.tyre = cells.tyre;
      }

      const colour = '#' + car.team.colour.toString(16).padStart(6, '0');
      if (seen.colour !== colour) { row.bar.style.background = colour; seen.colour = colour; }
      // The mark is a five-element SVG. It is rebuilt when the car in this row
      // changes team — once a session at most — and never per frame.
      if (seen.markTeam !== car.team.id) {
        row.mark.textContent = '';
        row.mark.appendChild(teamMarkSvg(car.team));
        seen.markTeam = car.team.id;
      }

      // Purple is the outright best in this system, and both of these are one:
      // the position at the head of the order, and the fastest lap anyone has
      // set. Nothing else in the tower is coloured.
      // A rule under the pinned leader, because the row below it is not the
      // car behind it. A list that silently skips eight places is a lie.
      setClass(row.root, 'tower-row'
        + (pinLeader && i === 0 ? ' is-pinned' : '')
        + (car.position === 1 ? ' is-leader' : '')
        + (car === player ? ' is-player' : '')
        + (car.retired || car.disqualified ? ' is-out' : '')
        + (sessionBest > 0 && car.bestLapTime === sessionBest ? ' is-fastest' : ''));
    }
  }

  /**
   * The feed, split in two.
   *
   * TWO SOURCES AND TWO VOICES, which is the whole of this pass. Race control
   * is official, impersonal and about anybody; the pit wall is a person who
   * knows the driver and talks only about the two cars in the team's garage.
   * Which one speaks is decided by `messageRoute` on ownership, and a third
   * party's damage is shown by neither.
   *
   * Both are events: this fires on a CHANGE and does nothing at all on the
   * ninety-nine frames out of a hundred where the situation is the same.
   */
  private updateAlerts(engine: RaceEngine, player: CarEntry): void {
    const messages = engine.raceControl.messages;
    // Where to resume. If the last bulletin relayed has been shifted off the
    // end of the log, everything between then and now is gone — so pick up
    // from as much of the tail as the stack can show rather than replaying a
    // race's worth of history at somebody who has been away from the screen.
    let from = 0;
    if (this.lastMessage) {
      const i = messages.lastIndexOf(this.lastMessage);
      from = i >= 0 ? i + 1 : Math.max(0, messages.length - this.maxAlerts());
    }
    for (let i = from; i < messages.length; i++) {
      const m = messages[i];
      const about = m.carIndex >= 0 ? engine.cars[m.carIndex] : undefined;
      const ours = about !== undefined && about.team.id === player.team.id;
      const route = messageRoute(m, ours);
      if (route === 'none') continue;

      if (route === 'race-control') {
        this.pushControlCard(m, about);
        continue;
      }
      // The team's own. A structured note is spoken by the principal; anything
      // without one — a pit call the shell logged in plain words — is relayed
      // as it stands rather than being dropped.
      if (m.team) {
        const said = teamLine(m.team, this.teamContext(engine, player, about!));
        this.pushAlert(player, said.line, '', said.tone);
      } else {
        this.pushAlert(
          player, relayed(m.text, this.keepCaps), '',
          m.severity === 'critical' ? 'urgent' : m.severity === 'warning' ? 'warn' : 'info',
        );
      }
    }
    if (messages.length > 0) this.lastMessage = messages[messages.length - 1];

    // The pit call speaks once, when the advice changes — not on every frame
    // it holds. The persistent card below carries it for as long as it stands.
    const advice = player.inPitLane || player.pitRequested
      ? '' : (engine.pitAdvice(player) ?? '');
    if (advice !== this.lastAdvice) {
      this.lastAdvice = advice;
      const call = advice ? pitCall(advice) : null;
      if (call) this.pushAlert(player, call.line, call.chip, call.tone);
    }
  }

  /**
   * What the pit wall knows at the moment it speaks.
   *
   * Read off the engine rather than remembered, so a line about the car ahead
   * names the car that is actually ahead. This runs once per MESSAGE, not once
   * per frame — a `find` over twenty cars in an event handler is free; the same
   * `find` at 60fps would not be.
   */
  private teamContext(engine: RaceEngine, player: CarEntry, about: CarEntry): TeamContext {
    const totalLaps = engine.config.laps || engine.track.def.raceLaps;
    // The car ahead ON THE ROAD, from the same perception buffer the gap panel
    // draws, and only when it is close enough to be a race rather than a dot on
    // the horizon. A principal does not name a car eleven seconds up.
    const ahead = player.perception.ahead;
    const near = ahead !== null && ahead.gapS < 8;
    return {
      mate: about !== player,
      surname: about.driver.lastName,
      position: player.position,
      lapsLeft: engine.config.kind === 'race' ? Math.max(0, totalLaps - player.lap) : 0,
      rival: near ? engine.cars[ahead.index]?.driver.code ?? '' : '',
      rivalGapS: near ? ahead.gapS : 0,
    };
  }

  /**
   * How many pop-ups may stand at once.
   *
   * One on a screen 390px tall, and one while a radio card is up: the rail is
   * a fixed band and everything in it is competing for the same 300 pixels.
   * Two pop-ups on top of a radio card push the card's whole header out of the
   * band, which leaves a driver reading half of a reply to a question they can
   * no longer see.
   */
  /**
   * How many pop-ups may stand at once.
   *
   * MEASURED, not guessed from a breakpoint. Every previous version of this was
   * a rule of thumb about screen height — "one below 560px", "two if the radio
   * card is down" — and every one of them was wrong on some combination,
   * because what actually decides it is how much of the band the PINNED items
   * have already taken. A landscape phone under a safety car with a planned
   * stop showing has two live cues in a 94-pixel band and no room for anything
   * at all; the same phone with one cue has room for exactly one card. Both
   * numbers fall out of the same subtraction.
   *
   * The layout reads cost one reflow per MESSAGE, not per frame. `Hud.update`
   * never calls this.
   */
  private maxAlerts(): number {
    // While a stop is being chosen the rail carries the sheet and the
    // neutralisation cue and NOTHING else. The sheet is a decision with a
    // deadline; a pop-up over it is the fault this pass exists to fix.
    if (this.pitSheetOpen) return 0;

    const band = this.notices.clientHeight;
    // Before the first layout — in a probe, or on the frame the HUD is built —
    // there is no band to measure. Fall back to one, which is safe everywhere.
    if (band <= 0) return 1;

    const pinned = this.neutralCue.offsetHeight + this.pitCue.offsetHeight
      + (this.radioCard.style.display === 'none' ? 0 : this.radioCard.offsetHeight);
    // Gaps between the rail's children, and the mask's fade at the top, which
    // eats the first 28px of anything that reaches it.
    const room = band - pinned - RAIL_GAPS_PX;
    if (room < MIN_CARD_PX) return 0;
    return Math.min(2, Math.floor(room / MIN_CARD_PX));
  }

  /**
   * Tells the rail the pit sheet is up.
   *
   * Two consequences, both about the same sixty pixels: the radio card stands
   * down — it is atmosphere and the sheet is an instruction — and the pop-up
   * budget shrinks. The class is what the stylesheet keys the compact layout
   * off, so the two halves of the decision are made in one place.
   */
  setPitSheetOpen(open: boolean): void {
    if (open === this.pitSheetOpen) return;
    this.pitSheetOpen = open;
    this.notices.classList.toggle('has-pit', open);
    // On the ROOT as well, because on a landscape phone the sheet cannot fit
    // in the band the running order leaves it — 56 pixels — and the tower is
    // what has to give. It keeps its header (the lap count, your position, the
    // fastest lap) and drops its rows for the few seconds the decision takes.
    // The other nineteen cars can wait; the stop cannot.
    this.root.classList.toggle('pit-open', open);
    if (open) {
      this.hideRadioCard(true);
      while (this.alertCards.length > this.maxAlerts()) {
        this.dismissAlert(this.alertCards[0], true);
      }
    }
  }

  /**
   * Re-checks the pop-up budget when what is PINNED to the rail changes.
   *
   * This is the bug behind both reported overlaps and it is the same bug twice.
   * The budget was only ever consulted at the moment a card was pushed, so a
   * card admitted into a quiet rail stayed after a safety car put a second live
   * cue underneath it — or after the radio card came up — and the stack then
   * ran out through the top of the band and over the running order. A budget
   * that is only enforced on the way in is not a budget.
   *
   * Runs every frame and costs a string compare on four `display` values. The
   * expensive part — `maxAlerts`, which measures — only runs on the frames
   * where that string has actually changed, which is a handful per race.
   */
  private enforceRailBudget(): void {
    const key = this.neutralCue.style.display + '|' + this.pitCue.style.display + '|' +
      this.radioCard.style.display + '|' + (this.pitSheetOpen ? 'pit' : '');
    if (key === this.lastPinned) return;
    this.lastPinned = key;
    while (this.alertCards.length > this.maxAlerts()) {
      this.dismissAlert(this.alertCards[0], true);
    }
  }

  private pushAlert(player: CarEntry, line: string, chip: string, tone: AlertTone): void {
    const card = document.createElement('div');
    card.className = 'hud-alert tone-' + tone + ' entering';

    const portrait = this.el('alert-portrait', card);
    portrait.appendChild(principalSvg(player.team));
    const body = this.el('alert-body', card);
    const who = this.el('alert-who', body);
    this.el('alert-name', who, principalOf(player.team.id));
    this.el('alert-role', who, 'Team principal');
    this.el('alert-line', body, line);
    if (chip) this.el('alert-chip', body, chip);

    this.mountCard(card);
  }

  /**
   * A race-control bulletin.
   *
   * The same stack as the principal's card, deliberately: they compete for the
   * same sixty pixels and giving each its own column would mean two things
   * pinned to one edge, which is the fault this whole pass is fixing. What they
   * do not share is a look. No face, no name, a hard official label, capitals,
   * and the four facts on a second line — a driver should never have to work
   * out which of the two is talking.
   */
  private pushControlCard(m: RaceControlMessage, about: CarEntry | undefined): void {
    const c = raceControlCard(m);
    const card = document.createElement('div');

    // A DECISION. The segmented strip: the authority, the sentence in red
    // across the middle, who it is against, and the same exclamation glyph the
    // running order puts against a penalised car — which is what ties the
    // banner and the tower together.
    if (c.penalty.length > 0 && about) {
      card.className = 'hud-control is-penalty tone-urgent entering';
      // The surname takes the team's colour, exactly as it does on the radio
      // card and in the running order. One property, so a change of roster
      // recolours every one of them at once.
      card.style.setProperty('--team', '#' + about.team.colour.toString(16).padStart(6, '0'));
      this.el('control-seg control-mark', card, 'RACE CONTROL');
      const pen = this.el('control-seg control-penalty', card);
      for (const line of c.penalty) this.el('control-penline', pen, line);
      const who = this.el('control-seg control-driver', card);
      this.el('control-first', who, about.driver.firstName);
      this.el('control-last', who, about.driver.lastName.toUpperCase());
      const mark = this.el('control-teammark', who);
      mark.appendChild(teamMarkSvg(about.team));
      this.el('control-bang', card, '!');
      this.mountCard(card);
      return;
    }

    // A NOTE. The banner of facts.
    card.className = 'hud-control tone-' + c.tone + ' entering';
    const head = this.el('control-head', card);
    this.el('control-mark', head, 'RACE CONTROL');
    this.el('control-headline', card, c.headline);
    if (c.detail) this.el('control-detail', card, c.detail);
    this.mountCard(card);
  }

  /** Shared entry animation, dwell and eviction for both kinds of card. */
  private mountCard(card: HTMLElement): void {
    this.alertStack.appendChild(card);
    this.alertCards.push(card);

    // Two frames before the entry state comes off, so the transition has a
    // start to run from. Transform and opacity only: those two are the ones a
    // compositor can animate without asking the layout engine for help, which
    // matters in a game that has been reported at 30fps.
    enterNextFrame(card);
    window.setTimeout(() => this.dismissAlert(card), this.alertDwellMs);

    while (this.alertCards.length > this.maxAlerts()) {
      this.dismissAlert(this.alertCards[0], true);
    }
  }

  private dismissAlert(card: HTMLElement, now = false): void {
    const i = this.alertCards.indexOf(card);
    if (i < 0) return;
    this.alertCards.splice(i, 1);
    if (now) { card.remove(); return; }
    card.classList.add('leaving');
    window.setTimeout(() => card.remove(), 420);
  }

  /**
   * The radio card.
   *
   * Deliberately rare. The pop-up above is the pit wall nagging and it fires
   * whenever there is something to nag about; this is a moment, and there are
   * four of them — the stop being called, the safety car, the virtual safety
   * car, and the flag. Each is an engine event with an edge, not a line on a
   * timer, so the card cannot cry wolf.
   */
  private updateRadioCard(engine: RaceEngine, player: CarEntry): void {
    const rc = engine.raceControl;

    if (rc.neutralisation !== this.lastNeutral) {
      const was = this.lastNeutral;
      this.lastNeutral = rc.neutralisation;
      if (was === 'none' && rc.neutralisation === 'safety-car') {
        this.showRadioCard(player, { kind: 'safety-car' });
      } else if (was === 'none' && rc.neutralisation === 'vsc') {
        this.showRadioCard(player, { kind: 'vsc' });
      }
    }

    if (rc.sessionFlag !== this.lastSessionFlag) {
      this.lastSessionFlag = rc.sessionFlag;
      if (rc.sessionFlag === 'chequered') {
        this.showRadioCard(player, { kind: 'chequered', position: player.position });
      }
    }

    const pitting = player.pitRequested || player.inPitLane;
    if (pitting && !this.radioPitShown) {
      this.radioPitShown = true;
      const totalLaps = engine.config.laps || engine.track.def.raceLaps;
      this.showRadioCard(player, {
        kind: 'pit',
        compound: getCompound(player.compound).name,
        lapsLeft: engine.config.kind === 'race' ? Math.max(0, totalLaps - player.lap) : 0,
      });
    } else if (!pitting) {
      this.radioPitShown = false;
    }
  }

  private showRadioCard(player: CarEntry, moment: RadioMoment): void {
    // 390 pixels of height carries the running order, the live cues, the
    // weather and the car state, and that is the whole budget. The radio card
    // is the one item on the rail that is atmosphere rather than instruction,
    // so it is the one that goes.
    if (window.innerHeight <= 470) return;
    // And it stands down entirely while a stop is being chosen. The driver has
    // a decision in front of them with a deadline measured in corners; the rail
    // is not tall enough to carry both, and covering the decision with the
    // atmosphere is the fault this whole pass exists to fix.
    if (this.pitSheetOpen) return;
    const ex = radioExchange(moment);
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;

    if (this.markedTeam !== player.team.id) {
      this.radioMark.textContent = '';
      this.radioMark.appendChild(teamMarkSvg(player.team));
      this.markedTeam = player.team.id;
    }
    // The team's colour is the card's colour: the surname, the number, the
    // waveform behind it and every one of the driver's own lines are all drawn
    // from this one property, so a data swap that changes the roster changes
    // the card without touching a line of this file.
    this.radioCard.style.setProperty(
      '--team', '#' + player.team.colour.toString(16).padStart(6, '0'),
    );
    setText(this.radioDriver, player.driver.lastName);

    for (const [i, row] of this.radioTurnRows.entries()) {
      const turn = ex[i];
      if (!turn) { setStyle(row, 'display', 'none'); continue; }
      setStyle(row, 'display', 'block');
      setClass(row, 'radio-turn is-' + turn.who);
      setText(row, '“' + turn.line + '”');
    }

    this.radioCard.classList.remove('leaving');
    this.radioCard.classList.add('entering');
    setStyle(this.radioCard, 'display', 'block');
    enterNextFrame(this.radioCard);

    // The eviction the reported overlap came from. `maxAlerts` drops to one the
    // moment this card is up, but two pop-ups already standing were never
    // re-counted — so a safety car arriving after two notifications left three
    // cards in a band with room for two, and the radio card was the one pushed
    // out through the top of the mask. The budget is now enforced when the
    // budget CHANGES, not only when something new is pushed. Ordered after the
    // display write because `maxAlerts` reads it.
    while (this.alertCards.length > this.maxAlerts()) {
      this.dismissAlert(this.alertCards[0], true);
    }

    this.radioTimers.push(window.setTimeout(() => {
      this.radioCard.classList.add('leaving');
      this.radioTimers.push(window.setTimeout(() => this.hideRadioCard(true), 440));
    }, this.radioDwellMs));
  }

  private hideRadioCard(now = false): void {
    if (!now) { this.radioCard.classList.add('leaving'); return; }
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;
    this.radioCard.classList.remove('entering', 'leaving');
    setStyle(this.radioCard, 'display', 'none');
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
   * This used to swap the wheel display for a stripped-down version in the
   * cockpit — gear, speed and rpm only — because the full panel sat across the
   * bottom centre of the frame, on top of the road and on top of the modelled
   * wheel, and something had to give. Halving it was the least bad option
   * available while it was there at all.
   *
   * It is not there any more. In the right-hand column the panel is clear of
   * the road in every camera, so there is nothing to trade away and the cockpit
   * now gets the SAME readouts as every other view — including the shift
   * lights, the ERS store and DRS, which the cockpit used to lose. Keeping one
   * layout for all cameras is also the point of a fixed HUD: a readout that
   * moves or disappears when the camera changes is a readout you have to go
   * looking for.
   *
   * Kept as a hook — the camera mode is a thing the HUD is entitled to know —
   * but it no longer changes the layout.
   */
  setCameraMode(mode: string): void {
    this.cockpitView = mode === 'cockpit';
  }
  /** Which camera is live. Read by nothing yet; see `setCameraMode`. */
  cockpitView = false;

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

/**
 * What each sector pill says. `#` is replaced with the sector number.
 *
 * A green sector says only its own name — a HUD that shouts "S1 GREEN" three
 * times a lap at a driver trains them to stop reading it. A sector with
 * something in it says what.
 */
const SECTOR_PILL_TEXT: Record<FlagSignal, string> = {
  green: 'S#',
  yellow: 'S# YEL',
  'double-yellow': 'S# 2YEL',
  red: 'S# RED',
  vsc: 'S# VSC',
  'safety-car': 'S# SC',
  chequered: 'S#',
};

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

/**
 * What the HUD tells the driver about a neutralisation.
 *
 * THE PROBLEM THIS SOLVES. The banner above already says SAFETY CAR or VIRTUAL
 * SAFETY CAR. That is the flag, and the flag is not the instruction. The
 * instruction is a number, and under a VSC it is a number no driver could
 * possibly infer from a speedometer: "drivers must stay above the minimum time
 * set by the FIA ECU at least once in each marshalling sector" — 2025 Sporting
 * Regulations Art. 56.5 / 2026 Section B Art. B5.12.2b, and identically for the
 * safety car in Art. 55.7 / B5.13.2b. A minimum SECTOR TIME. Under the safety
 * car there is a second, different number: the queue forms up "no more than ten
 * (10) car lengths apart" (Art. 55.7 / B5.13.2b), which is a distance to the
 * car in front. Two regimes, two obligations, and the HUD used to state
 * neither.
 *
 * So this reports, for whichever regime is in force, the obligation and the
 * driver's current standing against it — and says LIMITER ON while the game is
 * holding the car to it, exactly as the pit cue does, because a driver whose
 * throttle stops working is owed an explanation.
 *
 * Pure and exported so `probe:neutralplayer` can assert on the real text rather
 * than on a reimplementation of it.
 */
export function neutralisationCue(
  engine: RaceEngine, player: CarEntry,
): { text: string; cls: string } | null {
  const rc = engine.raceControl;
  if (rc.neutralisation === 'none' || player.retired || player.inPitLane) return null;

  const limiter = player.appliedControls.speedLimitMs > 0
    ? 'LIMITER ON ' + Math.round(player.appliedControls.speedLimitMs * MS_TO_KPH) + ' KM/H'
    : 'LIFT';

  // A car told to unlap itself is under the opposite instruction and must not
  // be shown a delta it is required to ignore. Art. 55.14 / B5.13.4c.
  if (player.mustUnlap) {
    return { text: 'LAPPED CARS MAY OVERTAKE — PASS THE QUEUE', cls: 'hud-neutral-cue cue-go' };
  }

  if (rc.neutralisation === 'safety-car') {
    // The gap, and the maximum. `queueAheadM` is to whatever is actually in
    // front in the queue, which for the leader is the safety car itself.
    const gap = player.perception.queueAheadM;
    const max = rc.maxQueueGapM;
    const gapText = gap >= 0 ? Math.round(gap) + 'm' : '—';
    const over = gap >= 0 && gap > max;
    return {
      text: limiter + ' · GAP ' + gapText + ' / MAX ' + Math.round(max) + 'm' +
        (over ? ' · CLOSE UP' : ''),
      cls: 'hud-neutral-cue ' + (over ? 'cue-warn' : 'cue-live'),
    };
  }

  // VSC: the minimum sector time, and how the sector in progress is going.
  const minimum = rc.minimumSectorTimeS;
  const sofar = player.deltaSectorTime;
  const behind = sofar >= minimum;
  return {
    text: limiter + ' · MIN SECTOR ' + minimum.toFixed(2) + 's · YOU ' + sofar.toFixed(2) + 's',
    cls: 'hud-neutral-cue ' + (behind || sofar < 0.4 ? 'cue-live' : 'cue-warn'),
  };
}
// ===========================================================================
// THE RUNNING ORDER
// ===========================================================================

/** How long a pop-up and a radio card stand before they leave, ms. */
const ALERT_LIFE_MS = 7200;
const RADIO_LIFE_MS = 8000;

/**
 * How many turns of an exchange the in-race card shows.
 *
 * Two, because the broadcast card is a three-line plate and two short turns is
 * what fits in it. `radioExchange` returns the whole argument — a longer form
 * belongs in a replay or a post-session review, where there is room for it —
 * and the first two turns are the push-back and the answer, which is the
 * argument in its shortest honest form.
 */
const RADIO_TURNS_SHOWN = 2;

/**
 * Slack subtracted from the rail's band before it is divided into cards.
 *
 * The gaps between the rail's children plus the top of the mask, which fades
 * the first 28 pixels of whatever reaches it. A card allocated into that fade
 * is a card the driver reads three quarters of.
 */
const RAIL_GAPS_PX = 36;

/**
 * The shortest a pop-up is ever laid out at, in pixels.
 *
 * Measured off the compact form: on a landscape phone the card is a name and
 * two clamped lines with no portrait, and it comes out at 55. Anything shorter
 * than this is not a card that fits, it is a card that is about to be clipped.
 */
const MIN_CARD_PX = 58;

/**
 * Takes a card out of its entry state on the frame after next.
 *
 * A transition needs a start state that has been through a style resolution,
 * so the class cannot come off in the same frame it went on. Two frames is the
 * cheap, reliable way to get one; a forced reflow would also work and would
 * cost a layout in the middle of a race.
 */
function enterNextFrame(card: HTMLElement): void {
  // Called by name, not through a local alias. `const raf = requestAnimationFrame`
  // then `raf(fn)` invokes it with an undefined receiver, which browsers reject
  // with "Illegal invocation" — and the throw takes the whole HUD update with
  // it, so the card is left in its entry state and never appears at all. That
  // is precisely what the first sweep photographed: no pop-ups, anywhere.
  if (typeof requestAnimationFrame !== 'function') { card.classList.remove('entering'); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('entering')));
}

/**
 * How many rows the tower shows, and whether they are the single-line kind.
 *
 * Bounded at both ends and on purpose. The floor stops a short viewport
 * showing two cars, which answers nothing. The ceiling is the interesting one:
 * the left rail also carries the weather, the car state and the pit
 * instruction, and a tower sized to "everything that fits" grows straight
 * through them. Fourteen rows is what is left after that reservation on a
 * 900px screen, and it is more of the field than anyone reads at speed.
 *
 * Pure, and exported, so `probe:hudtext` can assert the landscape-phone case —
 * this repo has a history of HUD panels running off the bottom of a 390px
 * screen — without standing up a browser to measure it.
 */
export function towerFit(w: number, h: number): { rows: number; compact: boolean } {
  // Written the same way round as the media query that shrinks the row —
  // `@media (max-width: 900px), (max-height: 470px)`. If these two ever
  // disagree the panel is measured for one row height and drawn at another,
  // which is exactly how a tower ends up hanging off the bottom of a phone.
  const compact = w <= 900 || h <= 470;
  const rowH = compact ? 17 : 29;
  // The panel's own header block and column rule, PLUS the whole rail beneath
  // it: the notice stack, the weather bug and the car state. This number is
  // the reason the tower is not simply "as many rows as fit" — the rest of
  // the left rail has to exist somewhere, and a tower sized to the viewport
  // grows straight down through the pit instruction.
  const reserved = compact ? 240 : 554;
  const fits = Math.floor((h - reserved) / rowH);
  return {
    rows: Math.max(compact ? 4 : 6, Math.min(fits, compact ? 8 : 14)),
    compact,
  };
}

/**
 * One row of the running order, as text.
 *
 * Pure and exported for the same reason `neutralisationCue` is: a probe that
 * re-derives what the gap column ought to say is a probe that agrees with
 * itself and with nothing else.
 *
 * The gap column is the only subtle one. A car a lap or more down is reported
 * as such, the way a broadcast tower does it — showing it as `+3.114` is not a
 * rounding difference, it says the car is three seconds off the one ahead when
 * it is a whole lap off, and it turned the bottom half of the tower into a
 * close battle that was not happening. Outside a race there are no intervals
 * worth the name, so the column becomes the deficit to the quickest lap set.
 */
export function standingsCells(
  engine: RaceEngine, car: CarEntry, ahead: CarEntry | null, leader: CarEntry,
): {
  pos: string; first: string; surname: string; team: string;
  tyre: string; gap: string; best: string; lastLap: string;
} {
  const lapsBehind = ahead ? car.lapsDown - ahead.lapsDown : 0;
  const gap = car.retired ? 'DNF'
    : car.disqualified ? 'DSQ'
    : car.position === 1 ? 'LEADER'
    : engine.config.kind !== 'race'
      ? (car.bestLapTime > 0 && leader.bestLapTime > 0
        ? formatGap(car.bestLapTime - leader.bestLapTime) : '—')
    : lapsBehind > 0 ? '+' + lapsBehind + (lapsBehind === 1 ? ' LAP' : ' LAPS')
    : formatGap(car.interval);

  return {
    pos: String(car.position),
    first: car.driver.firstName,
    surname: car.driver.lastName.toUpperCase(),
    team: car.team.name,
    tyre: getCompound(car.compound).code,
    gap,
    best: car.bestLapTime > 0 ? formatLapTime(car.bestLapTime) : '—',
    lastLap: car.lastLapTime > 0 ? formatLapTime(car.lastLapTime) : '—',
  };
}

/**
 * The stop the plan asks for, once it is close enough to matter.
 *
 * THE GAP THIS CLOSES. Every car in this game has had a stint plan since the
 * engine was written — compounds and the laps to stop on — and the player's
 * car was given one it was never told about. Now that the plan is chosen on
 * the race-setup screen, the driver is owed the other half of it: which lap
 * the pit wall is expecting them, and what is going on the car.
 *
 * Six laps out, and not before. A line that reads PLANNED STOP LAP 34 for
 * thirty-three laps is a line nobody reads on lap thirty-four.
 *
 * Pure and exported so `probe:strategy` can assert what the driver is shown
 * against the plan the engine is actually running.
 */
export function plannedStopCue(engine: RaceEngine, player: CarEntry): string | null {
  if (engine.config.kind !== 'race') return null;
  if (player.retired || player.finished || player.inPitLane) return null;
  const lap = player.targetPitLap;
  if (lap <= 0) return null;
  const away = lap - (player.lap + 1);
  if (away < 0 || away > 5) return null;

  const next = player.plan[player.pitStops + 1];
  const onto = next ? getCompound(next.compound).name.toUpperCase() : null;
  const when = away === 0 ? 'PLANNED STOP THIS LAP' : 'PLANNED STOP LAP ' + lap;
  return onto ? when + ' · ' + onto : when;
}

/**
 * Who holds the fastest lap of the session.
 *
 * The one fact a broadcast keeps on screen that this game had nowhere: the
 * purple lived on the player's own sector tiles and said nothing about the
 * other nineteen cars. Returns null before anybody has set a lap, which is a
 * real state — the first three minutes of every session.
 */
export function fastestLap(
  standings: readonly CarEntry[],
): { code: string; first: string; surname: string; time: number } | null {
  let best: CarEntry | null = null;
  for (const c of standings) {
    if (c.bestLapTime > 0 && (!best || c.bestLapTime < best.bestLapTime)) best = c;
  }
  if (!best) return null;
  return {
    code: best.driver.code,
    first: best.driver.firstName,
    surname: best.driver.lastName.toUpperCase(),
    time: best.bestLapTime,
  };
}

// ===========================================================================
// THE PIT WALL'S VOICE
// ===========================================================================

/**
 * Who speaks for each team.
 *
 * Invented people for invented teams — the same rule the grid itself follows,
 * and the reason there is not a real name, badge or trademark anywhere in this
 * file. From where the driver sits this is a cast of one: you only ever hear
 * your own team principal, and their job is to tell you things you would
 * rather not hear.
 */
const PRINCIPALS: Readonly<Record<string, string>> = {
  apex: 'Marco Vidal',
  'scuderia-rosso': 'Elena Brambilla',
  meridian: 'Tom Ashcroft',
  albion: 'Rhys Gallagher',
  aurora: 'Ingrid Sandell',
  vantage: 'Cato Brenner',
  northstar: 'Dana Whitlock',
  lumen: 'Sofia Reyes',
  kestrel: 'Anders Vike',
  brava: 'Nino Carbone',
};

/** The team principal's name, for the notification's byline. */
export function principalOf(teamId: string): string {
  return PRINCIPALS[teamId] ?? 'Pit wall';
}

/**
 * The pit call, said by a person.
 *
 * `RaceEngine.pitAdvice` returns machine text — `DAMAGE — PIT FOR REPAIRS` —
 * and the HUD used to set it in 22px capitals across the horizontal centre of
 * the screen. Two things were wrong with that and only one of them was the
 * position. Shouted capitals are how a warning light talks; a team principal
 * says "there's damage on the car, box this lap and we'll put a new nose on".
 * Same fact, and the second one gets read once instead of skimmed twenty
 * times and then ignored.
 *
 * `chip` is the control that acts on it, because a message that tells you what
 * is wrong and not what to press is half a message.
 *
 * Pure and exported so `probe:hudtext` can assert on the sentence the driver
 * is actually shown rather than on a reimplementation of it.
 */
export function pitCall(advice: string): { line: string; chip: string; tone: AlertTone } | null {
  const v = PIT_VOICE[advice];
  if (!v) return null;
  return { line: v.line, chip: 'PRESS PIT', tone: v.tone };
}

export type AlertTone = 'info' | 'warn' | 'urgent' | 'go';

const PIT_VOICE: Readonly<Record<string, { line: string; tone: AlertTone }>> = {
  'DRIVE-THROUGH TO SERVE': {
    line: 'Drive-through penalty. Take it this lap — through the pit lane, no stopping.',
    tone: 'urgent',
  },
  'PENALTY TO SERVE': {
    line: 'You have a penalty to serve. Box, and we take it at the stop.',
    tone: 'urgent',
  },
  'DAMAGE — PIT FOR REPAIRS': {
    line: "There's damage on the car. Box this lap and we'll put a new nose on.",
    tone: 'urgent',
  },
  'RAIN — WET TYRES': {
    line: "Rain's here and you're on slicks. Box for wets.",
    tone: 'urgent',
  },
  'TRACK DRY — SLICKS': {
    line: "Track's drying out. Box for slicks whenever you're ready.",
    tone: 'warn',
  },
  'TYRES GONE': {
    line: "Those tyres are finished. Box now — you're losing a second a lap.",
    tone: 'urgent',
  },
  'SECOND COMPOUND REQUIRED': {
    line: 'You still owe us a second compound. Box before the flag or we lose the result.',
    tone: 'warn',
  },
  'TYRES WORN — PIT WINDOW OPEN': {
    line: "Pit window's open and the rears are going off. Your call.",
    tone: 'info',
  },
};

// ===========================================================================
// TWO VOICES
// ===========================================================================

/**
 * Which card, if any, a bulletin gets.
 *
 * THE FILTER IS OWNERSHIP, and this is where it is applied, because this is the
 * only layer that knows which car the player is in. `RaceControlManager` says
 * what KIND of event it is; this says whether it is any of the player's
 * business and, if so, who says it.
 *
 * Before this, everything in the log went through the player's own team
 * principal, so a stranger's excursion arrived as `MARCO VIDAL · TEAM PRINCIPAL
 * — "Yellow flag — HAL off at sector 2"` and a stranger's track-limits warning
 * arrived the same way. Neither is a team matter. A third party's suspension
 * failure is now dropped on the floor, which is where it belongs.
 */
export function messageRoute(
  m: RaceControlMessage, ours: boolean,
): 'race-control' | 'team' | 'none' {
  if (m.feed === 'race-control') return 'race-control';
  if (m.feed === 'team') return ours ? 'team' : 'none';
  // 'either': the officials note somebody else's accident, your own pit wall
  // reacts to yours. One event, one card, and never both — the rail is sixty
  // pixels tall on a landscape phone and the second card evicts the first.
  return ours ? 'team' : 'race-control';
}

/**
 * A race-control bulletin, in race control's own shape.
 *
 * The reference is a broadcast banner: `RACE CONTROL: <DRIVER>, <DRIVER>
 * INCIDENT` on one line, `TURN 1 · IMPEDING · NOTED` on the next. The parties,
 * the location, the offence and the status — four facts, no verb, no opinion.
 * That is what an official notice is, and it is the opposite register to the
 * principal's card sitting next to it in the same rail. The two are meant to
 * look like two different systems talking, because they are.
 *
 * A bulletin with no structured notice — a flag, a safety car, the chequered —
 * has no parties and no detail, so it prints as its own headline. `SAFETY CAR
 * DEPLOYED` needs nothing added to it.
 */
export function raceControlCard(m: RaceControlMessage): {
  headline: string;
  detail: string;
  tone: AlertTone;
  /**
   * The two lines of a DECISION, or empty for a note.
   *
   * Race control has two states and a broadcast draws them differently. An
   * investigation is a banner of facts — `RACE CONTROL: A, B INCIDENT` over
   * `TURN 1 · CONTACT · NOTED`. A decision is a horizontal strip of segments
   * with the sentence itself set large in red across the middle of it:
   * `5 SECOND` / `TIME PENALTY`. Same channel, same voice, two states, and the
   * second one has to be unmissable because it has changed the result.
   */
  penalty: string[];
} {
  const tone: AlertTone =
    m.severity === 'critical' ? 'urgent' : m.severity === 'warning' ? 'warn' : 'info';
  const n = m.notice;
  if (!n || n.parties.length === 0) {
    return {
      headline: (n ? n.offence : m.text).toUpperCase(),
      detail: n ? n.status : '',
      tone,
      penalty: [],
    };
  }
  return {
    headline: n.parties.join(', ') + ' INCIDENT',
    detail: [n.where, n.offence, n.status].filter((s) => s.length > 0).join(' · '),
    tone,
    penalty: isDecision(n.status) ? twoLines(n.status) : [],
  };
}

/** A status that has changed the result, as opposed to one that is a note. */
function isDecision(status: string): boolean {
  return /PENALTY|DISQUALIFIED|DELETED|BLACK AND WHITE/.test(status);
}

/**
 * A penalty split across two lines, as the banner sets it.
 *
 * Split at the word boundary nearest the middle by character count, which puts
 * `5 SECOND / TIME PENALTY` and `DRIVE-THROUGH / PENALTY` and `LAP TIME /
 * DELETED` where a designer would put them, and leaves a single word alone.
 */
function twoLines(status: string): string[] {
  const words = status.split(' ');
  if (words.length < 2) return [status];
  let best = 1;
  let bestGap = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    if (Math.abs(a - b) < bestGap) { bestGap = Math.abs(a - b); best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** What the pit wall knows when it speaks, so the line can be specific. */
export interface TeamContext {
  /** True when the event is about the team-mate rather than the player. */
  mate: boolean;
  /** The driver the note is about, by surname. */
  surname: string;
  /** The player's own position, for a line about their race. */
  position: number;
  /** Laps left in the race, or 0 when it does not apply. */
  lapsLeft: number;
  /** Code of the car the player is racing, or '' when there is nobody near. */
  rival: string;
  /** Gap to that car, seconds. */
  rivalGapS: number;
}

/**
 * The pit wall, talking like a person who knows the driver.
 *
 * "my team principal should be smart right like why the fuck is he saying
 *  retarded shit. like if im in an accident or off the track my principal
 *  shouldn't be saying 'off track - yellow flag' bro should be like acting like
 *  a team principal?"
 *
 * Correct, and the fault was structural: the card was printing the race-control
 * LOG, which is signage. A principal does not read signage out. He reacts, he
 * instructs, he makes a judgement, and he does it in about ten words because
 * the man he is talking to is doing 300 km/h.
 *
 * Two rules held throughout. Every line is speech — a reaction, an instruction
 * or a judgement, never a status string with a dash in it. And every line is as
 * specific as the game's own state allows: which corner, which part, which
 * tyre, how many laps, who is closing. A generic line is a line the driver
 * learns to ignore.
 *
 * Pure and exported so `probe:hudtext` can assert on the sentence rather than
 * on a reimplementation of it.
 */
export function teamLine(
  note: TeamNote, ctx: TeamContext,
): { line: string; tone: AlertTone } {
  const who = ctx.surname;
  switch (note.kind) {
    case 'off':
      if (ctx.mate) {
        return {
          line: who + "'s off at " + note.corner + '. Yellows through there — lift and stay clean.',
          tone: 'warn',
        };
      }
      return note.heavy
        ? { line: 'Big one at ' + note.corner + '. Are you okay? Talk to me.', tone: 'urgent' }
        : {
          line: 'Alright, that is fine, we go again. Nothing broken from here — rebuild the lap.',
          tone: 'warn',
        };

    case 'damage': {
      const part = note.part.toLowerCase();
      if (ctx.mate) {
        return { line: who + ' has ' + part + ' damage. Their pace is going to fall away.', tone: 'info' };
      }
      return note.health < 0.5
        ? {
          line: 'That has hurt the ' + part + '. Box this lap — you are not finishing on that.',
          tone: 'urgent',
        }
        : {
          line: 'Some ' + part + ' damage. Numbers are still good, keep going and we watch it.',
          tone: 'warn',
        };
    }

    case 'retired':
      return ctx.mate
        ? { line: who + ' is out — ' + note.reason + '. You are the car now.', tone: 'warn' }
        : { line: 'That is us done. Nothing in that for you — we go again in two weeks.', tone: 'urgent' };

    case 'failure':
      return ctx.mate
        ? { line: who + ' has stopped, ' + note.cause.toLowerCase() + '. Watch your own temperatures.', tone: 'warn' }
        : { line: note.cause + '. Stop the car, kill the switches. Sorry.', tone: 'urgent' };

    case 'stranded':
      return ctx.mate
        ? { line: who + ' is beached and out. Marshals are on it — expect yellows.', tone: 'warn' }
        : { line: 'You are stuck. Leave it, get out of the car, keep the barrier between you and the track.', tone: 'urgent' };

    case 'recovered':
      return ctx.mate
        ? { line: who + "'s car is away and the sector is green again.", tone: 'info' }
        : { line: 'They have your car away. Sector is green.', tone: 'info' };

    case 'stop':
      if (ctx.mate) {
        return { line: who + ' is out of the box on the ' + note.compound.toLowerCase() + '.', tone: 'info' };
      }
      // The one line where the game knows enough to be genuinely useful, so it
      // says all of it: what went on, where it put you, and what the job is.
      return {
        line: 'Good stop. ' + note.compound + 's on, you rejoin P' + ctx.position +
          (ctx.rival ? ' with ' + ctx.rival + ' ' + ctx.rivalGapS.toFixed(1) + ' up the road.' : '.') +
          (ctx.lapsLeft > 0 ? ' ' + ctx.lapsLeft + ' to go — get your head down.' : ''),
        tone: 'go',
      };

    // The four pit-lane notes. They are about a car that is being called in, so
    // the team-mate's version names them and the player's does not — a driver
    // does not need to be told which car he is in.
    case 'pit-closed':
      return ctx.mate
        ? { line: 'They have closed the entry on ' + who + '. They stay out a lap.', tone: 'info' }
        : { line: 'Stay out, stay out. Pit entry is closed, we go again next lap.', tone: 'warn' };
    case 'pit-missed':
      return ctx.mate
        ? { line: who + ' went past the entry. They come round again.', tone: 'info' }
        : { line: 'You went past the entry. Round again, same call, same tyre.', tone: 'warn' };
    case 'pit-fast':
      return ctx.mate
        ? { line: who + ' was too quick for the entry and got waved past.', tone: 'info' }
        : { line: 'Too quick for the entry, they will not take you. Round again.', tone: 'warn' };
    case 'penalty-served':
      return ctx.mate
        ? { line: who + ' has served their penalty. That is them clear.', tone: 'info' }
        : { line: 'Penalty served, that is behind us. Now go and take it back.', tone: 'go' };
  }
}

/**
 * A race-control bulletin, relayed rather than shouted.
 *
 * Half the log is already written as a sentence — "HAL into the barrier at
 * Copse" — and half is signage in capitals: `SAFETY CAR DEPLOYED`, `LAPPED
 * CARS MAY NOW OVERTAKE`. Printed side by side in the same feed they read as
 * two different systems talking, so the capitals are brought down to the same
 * register as everything else.
 *
 * `keep` is the set of tokens that stay in capitals — the driver codes of the
 * field, and the abbreviations the sport actually says as letters. It is
 * passed in rather than guessed because a three-letter word is a driver code
 * or an English word depending entirely on who is in the race, and guessing
 * turns "the" into a driver.
 */
export function relayed(text: string, keep: ReadonlySet<string>): string {
  const words = text.split(' ').map((w) => {
    const bare = w.replace(/[^A-Za-z0-9]/g, '');
    if (keep.has(bare) || FIXED_CAPS.has(bare)) return w;
    if (!/[A-Z]/.test(w)) return w;
    return w === w.toUpperCase() ? w.toLowerCase() : w;
  });
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Abbreviations the sport says as letters, so they survive the relay. */
const FIXED_CAPS = new Set([
  'VSC', 'SC', 'DRS', 'ERS', 'FIA', 'DNF', 'DSQ', 'GP', 'S1', 'S2', 'S3',
]);

/**
 * A radio exchange: an argument between two people who disagree.
 *
 * THIS IS NOT A NOTIFICATION AND THE DIFFERENCE IS THE WHOLE POINT. The
 * reference broadcasts read `"MY TYRES ARE OK, CAN I EXTEND? HOW MANY MORE LAPS
 * LEFT?"` — `"AND BOX, 20 LAPS"` — `"I DON'T WANNA STOP"` — `"BOX BOX"`, and
 * `"WHAT? I WAS AHEAD, MATE."` — `"MY ADVICE IS TO LET IT THROUGH"` — `"I WAS
 * AHEAD"` — `"THAT'S THE RULES"`. The driver pushes back. The wall insists. The
 * card is worth putting on screen because somebody is being overruled on it.
 *
 * So an exchange is a LIST OF TURNS rather than a question and an answer. The
 * card alternates them down the page — the driver's own words in his team's
 * colour on one side, the pit wall's in white on the other — and the alignment
 * plus the colour is the attribution, which is why no turn carries a label.
 *
 * Deliberately rare: five engine events fire it, each a moment a real
 * broadcast would actually play, and each an edge rather than a timer.
 */
export type RadioMoment =
  | { kind: 'pit'; compound: string; lapsLeft: number }
  | { kind: 'safety-car' }
  | { kind: 'vsc' }
  | { kind: 'chequered'; position: number }
  | { kind: 'damage'; part: string };

export interface RadioTurn {
  who: 'driver' | 'wall';
  line: string;
}

export function radioExchange(m: RadioMoment): RadioTurn[] {
  switch (m.kind) {
    case 'pit':
      return [
        { who: 'driver', line: 'My tyres are okay — can I extend? How many laps left?' },
        {
          who: 'wall',
          line: m.lapsLeft > 0 ? 'And box, ' + m.lapsLeft + ' laps.' : 'And box, box.',
        },
        { who: 'driver', line: "I don't wanna stop." },
        { who: 'wall', line: 'Box box. ' + m.compound + ' on the left.' },
      ];
    case 'safety-car':
      return [
        { who: 'driver', line: 'Confirm safety car?' },
        { who: 'wall', line: 'Affirm. Delta positive, close up to the car ahead.' },
        { who: 'driver', line: 'How much is this costing me?' },
        { who: 'wall', line: 'Nothing. Everyone is behind the same car.' },
      ];
    case 'vsc':
      return [
        { who: 'driver', line: 'VSC? Give me the delta.' },
        { who: 'wall', line: 'Hold the minimum in every sector.' },
        { who: 'driver', line: 'I am well up on it.' },
        { who: 'wall', line: 'Then back off. We lose the lot if you go under.' },
      ];
    case 'chequered':
      return [
        { who: 'driver', line: "That's the flag. Where did we finish?" },
        { who: 'wall', line: 'P' + m.position + '. Well driven.' },
        { who: 'driver', line: 'We had more than that in it.' },
        { who: 'wall', line: 'Bring it home. Cool the tyres on the in-lap.' },
      ];
    case 'damage':
      return [
        { who: 'driver', line: 'Something let go — I can feel it in the high speed.' },
        { who: 'wall', line: m.part + ' has taken a hit. Numbers are still good.' },
        { who: 'driver', line: 'It does not feel good.' },
        { who: 'wall', line: 'Keep going. We are watching it.' },
      ];
  }
}

// ===========================================================================
// THE WEATHER BUG
// ===========================================================================

export type WeatherTone = 'dry' | 'damp' | 'wet' | 'storm';

/**
 * What the weather bug says.
 *
 * The label is the engine's own verdict on `wetness`, in the words a pit wall
 * uses, and the tone is the same verdict as a colour. Both come from one
 * number, which is why they cannot disagree.
 */
export function weatherReadout(
  w: { wetness: number; airTempC: number; trackTempC: number },
): { label: string; tone: WeatherTone; temps: string } {
  const tone: WeatherTone = w.wetness < 0.05 ? 'dry'
    : w.wetness < 0.35 ? 'damp'
    : w.wetness < 0.7 ? 'wet' : 'storm';
  const label = tone === 'dry' ? 'DRY TRACK'
    : tone === 'damp' ? 'LIGHT RAIN'
    : tone === 'wet' ? 'WET TRACK' : 'HEAVY RAIN';
  const temps = 'Air ' + Math.round(w.airTempC) + '°  ·  Track ' + Math.round(w.trackTempC) + '°';
  return { label, tone, temps };
}

// ===========================================================================
// TEAM MARKS
// ===========================================================================

/**
 * A team's mark: a disc in its livery colour carrying one geometric device in
 * its accent.
 *
 * Every list of drivers in this game has had exactly one piece of team
 * identity on it — a three-pixel colour bar — and three of the ten teams are
 * within a hue of another one at that size. The reference this panel is built
 * against uses a circular badge per team, and this game cannot borrow those:
 * they are real constructors' marks. So the marks are GENERATED, from data the
 * team already carries. Ten devices, assigned by a hash of the team id, drawn
 * in the accent over the primary. Two teams can share a colour or share a
 * device; they cannot share both.
 *
 * Everything is sized to a 24-unit box and kept inside a radius of 10 so no
 * clip path is needed — a clip path means a unique id per instance, and there
 * is one of these per timing row.
 */
export function teamMarkSvg(team: { id: string; colour: number; accent: number }): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const primary = hexOf(team.colour);
  const accent = hexOf(team.accent);

  const disc = document.createElementNS(NS, 'circle');
  disc.setAttribute('cx', '12');
  disc.setAttribute('cy', '12');
  disc.setAttribute('r', '12');
  disc.setAttribute('fill', primary);
  svg.appendChild(disc);

  for (const spec of DEVICES[hashOf(team.id) % DEVICES.length]) {
    const e = document.createElementNS(NS, spec.tag);
    for (const [k, v] of Object.entries(spec.attrs)) e.setAttribute(k, v);
    // `#a` is the accent, `#p` the primary — so a device can cut a hole in the
    // disc as well as sit on it.
    if (spec.attrs.fill === '#a') e.setAttribute('fill', accent);
    if (spec.attrs.fill === '#p') e.setAttribute('fill', primary);
    if (spec.attrs.stroke === '#a') e.setAttribute('stroke', accent);
    svg.appendChild(e);
  }

  // A hairline so the disc separates from a pale sky as well as from a panel.
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '11.2');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'rgba(255,255,255,0.26)');
  ring.setAttribute('stroke-width', '1.4');
  svg.appendChild(ring);

  return svg;
}

interface DeviceSpec { tag: 'path' | 'rect' | 'circle'; attrs: Record<string, string>; }

/** Ten devices. Order is fixed: changing it re-badges the whole grid. */
const DEVICES: readonly (readonly DeviceSpec[])[] = [
  // chevron
  [{ tag: 'path', attrs: { d: 'M9 6.5 L15.5 12 L9 17.5', fill: 'none', stroke: '#a', 'stroke-width': '3.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }],
  // bar
  [{ tag: 'rect', attrs: { x: '3', y: '9.8', width: '18', height: '4.4', rx: '1', fill: '#a' } }],
  // half disc
  [{ tag: 'path', attrs: { d: 'M12 0 A12 12 0 0 1 12 24 Z', fill: '#a' } }],
  // ring
  [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '6.4', fill: 'none', stroke: '#a', 'stroke-width': '3.2' } }],
  // triangle
  [{ tag: 'path', attrs: { d: 'M12 4.6 L18.6 17.2 L5.4 17.2 Z', fill: '#a' } }],
  // twin bars
  [
    { tag: 'rect', attrs: { x: '5.5', y: '6.4', width: '4', height: '11.2', rx: '1.4', fill: '#a' } },
    { tag: 'rect', attrs: { x: '14.5', y: '6.4', width: '4', height: '11.2', rx: '1.4', fill: '#a' } },
  ],
  // dot
  [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '5.2', fill: '#a' } }],
  // saltire
  [{ tag: 'path', attrs: { d: 'M7.4 7.4 L16.6 16.6 M16.6 7.4 L7.4 16.6', fill: 'none', stroke: '#a', 'stroke-width': '3.2', 'stroke-linecap': 'round' } }],
  // crescent
  [
    { tag: 'circle', attrs: { cx: '11', cy: '12', r: '8', fill: '#a' } },
    { tag: 'circle', attrs: { cx: '15.6', cy: '12', r: '7', fill: '#p' } },
  ],
  // quarters
  [
    { tag: 'rect', attrs: { x: '12', y: '4', width: '7', height: '8', fill: '#a' } },
    { tag: 'rect', attrs: { x: '5', y: '12', width: '7', height: '8', fill: '#a' } },
  ],
];

/**
 * The team principal, drawn.
 *
 * A bust in silhouette — head, shoulders, headset, boom mic — on a disc in the
 * team's colour. It is the only face in this game, which is the point: the
 * notification it heads is the only thing on screen that is a person talking
 * rather than a machine reporting, and a portrait says that before a word is
 * read.
 *
 * The silhouette's ink is picked off the disc's luminance rather than fixed,
 * because this grid runs from a #0e3b5c navy to a #9aa5b1 grey and a fixed ink
 * disappears into one end of that or the other.
 */
export function principalSvg(team: { colour: number }): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');

  const ink = luminanceOf(team.colour) > 0.5 ? '#0a0e14' : '#eaf1fa';
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
  };

  add('circle', { cx: '24', cy: '24', r: '24', fill: hexOf(team.colour) });
  // Shoulders. The two arcs follow the disc's own edge, so the bust reads as
  // cropped by the frame rather than as a shape floating inside it.
  add('path', {
    d: 'M24 27.5c-8.6 0-15 4.8-16.7 11.9A24 24 0 0 0 24 48a24 24 0 0 0 16.7-8.6C39 32.3 32.6 27.5 24 27.5z',
    fill: ink,
  });
  add('circle', { cx: '24', cy: '19', r: '8.3', fill: ink });
  // Headset: band over the crown, a cup at each ear, boom to the mouth.
  add('path', { d: 'M13.4 20.2a10.6 10.6 0 0 1 21.2 0', fill: 'none', stroke: ink, 'stroke-width': '3' });
  add('rect', { x: '10.2', y: '18.4', width: '5.2', height: '7.8', rx: '2.6', fill: ink });
  add('rect', { x: '32.6', y: '18.4', width: '5.2', height: '7.8', rx: '2.6', fill: ink });
  add('path', {
    d: 'M13.2 26.4c0 5.2 3.8 8.4 8.6 8.8', fill: 'none', stroke: ink,
    'stroke-width': '2.2', 'stroke-linecap': 'round',
  });
  add('circle', { cx: '24', cy: '24', r: '23', fill: 'none', stroke: 'rgba(255,255,255,0.22)', 'stroke-width': '1.6' });
  return svg;
}

/**
 * The sky, drawn.
 *
 * A cloud, a sun behind it, and three rain strokes. Every element is present
 * in every state and shown or hidden by a class on the panel, so changing the
 * weather costs one class write rather than a rebuild — and nothing here
 * animates. A HUD in a game that has been reported at 30fps does not get to
 * spend a compositor layer on falling raindrops.
 */
export function weatherGlyphSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');

  const add = (tag: string, attrs: Record<string, string>, cls?: string) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (cls) e.setAttribute('class', cls);
    svg.appendChild(e);
    return e;
  };

  add('circle', { cx: '21.5', cy: '9.5', r: '5.4', fill: '#fff' }, 'wx-sun');
  add('path', {
    d: 'M9.6 20.5a5.4 5.4 0 0 1 .5-10.8 7.4 7.4 0 0 1 14 1.6 4.6 4.6 0 0 1-.8 9.2z',
    fill: '#fff',
  }, 'wx-cloud');
  const drops = add('g', { stroke: '#fff', 'stroke-width': '2.1', 'stroke-linecap': 'round' }, 'wx-drops');
  for (const [x, y] of [[11, 23], [16, 23.5], [21, 23]] as [number, number][]) {
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', `M${x} ${y} L${x - 2.4} ${y + 6}`);
    drops.appendChild(line);
  }
  return svg;
}

function hexOf(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

/** Rec. 709 relative luminance, 0..1. */
function luminanceOf(c: number): number {
  const r = ((c >> 16) & 0xff) / 255;
  const g = ((c >> 8) & 0xff) / 255;
  const b = (c & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** FNV-1a, so a team's device is the same on every machine and every run. */
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
