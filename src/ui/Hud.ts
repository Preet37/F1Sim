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
 * Seven cells, in the order a broadcast timing panel puts them: a team-colour
 * bar, the position — in a filled red cell for the leader — the team's own
 * generated mark in its livery colour, the three-letter code in heavy white
 * caps, the gap, the tyre compound as a single colour-coded letter, and the
 * status badges in a column of their own.
 *
 * THE BADGE COLUMN IS THE POINT OF THIS PASS. "You can see who has set the
 * fastest lap, who's got a penalty, who's out, what tire compounds etc." —
 * four facts about twenty cars, all of them on one panel, none of them needing
 * a word. A purple square with a stopwatch is the fastest lap, a red square
 * with an exclamation is a penalty — the same glyph the penalty banner ends
 * with, deliberately, so the two read as one system — and a chequered square is
 * a car that has finished. A retired car keeps its place at the foot of the
 * order with the whole row dimmed and `Out` where the gap was.
 *
 * WHY THE CODE AND NOT THE NAME. The row this replaces set the driver's given
 * name and surname over their team's name, on the argument that an
 * abbreviation means nothing to somebody who has not learnt the field. What it
 * cost was the rest of the row: three lines of type in a 336-pixel panel
 * leaves no column for the tyre, none for the badges, and half the field's
 * worth of rows. The identification is not gone — it has moved to the mark
 * beside the code, which is in the team's own livery colour, and the two
 * together are what a broadcast tower identifies a car by.
 *
 * `seen` is the whole performance story. Every cell is compared before it is
 * written, so a frame in which nothing overtakes anybody writes nothing at all
 * — and the mark, which is a five-element SVG, is only rebuilt when the car in
 * the row changes team, which happens once a session at most. The badges are
 * three elements whose display is toggled off one diffed string, so a car
 * taking the fastest lap costs one comparison and one class write.
 */
interface Row {
  root: HTMLElement;
  bar: HTMLElement;
  pos: HTMLElement;
  mark: HTMLElement;
  code: HTMLElement;
  gap: HTMLElement;
  tyre: HTMLElement;
  badges: HTMLElement;
  seen: {
    pos: string; code: string; tyre: string; gap: string;
    markTeam: string; colour: string; badges: string; state: string;
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
  private lapTotal!: HTMLElement;
  private lapBlock!: HTMLElement;
  private sessionName!: HTMLElement;
  private rowsBox!: HTMLElement;
  /** The flag band under the tower's header, and its two lines. */
  private flagBand!: HTMLElement;
  private flagBandLabel!: HTMLElement;
  private flagBandCause!: HTMLElement;
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
  /**
   * The tower's shape — row count and whether the flag band is out.
   *
   * The only two things that change its HEIGHT, and the rail below it is laid
   * out against that height. Kept as a string so one compare covers both and
   * `Hud.update` measures nothing on the frames where neither has moved.
   */
  private lastTowerShape = '';
  private flagBandShown = false;

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

    // --- The header -------------------------------------------------------
    //
    // The series mark, then the lap. Two facts and no more: a broadcast tower
    // header says which championship you are watching and how far through the
    // race it is, and the lap is the one number on the whole panel that is read
    // from across a room, so it is set big and the total is set small beside
    // it.
    //
    // The mark is this game's own, and it is the only wordmark anywhere in the
    // HUD. No real series mark is reproduced.
    const towerHead = this.el('tower-head', this.tower);
    this.el('tower-series', towerHead).innerHTML = 'F1<b>SIM</b>';
    this.sessionName = this.el('tower-session', towerHead, '');
    const lapBlock = this.el('tower-lapblock', towerHead);
    this.lapBlock = lapBlock;
    this.el('tower-lapword', lapBlock, 'LAP');
    this.lapCounter = this.el('tower-lapnow', lapBlock, '1');
    this.el('tower-lapbar', lapBlock, '/');
    this.lapTotal = this.el('tower-laptotal', lapBlock, '50');

    // --- The flag band ----------------------------------------------------
    //
    // WHERE FLAG STATE BELONGS, and it took two complaints to get here. A
    // yellow flag used to be a strip across the top centre of the frame, over
    // the road, in the one place every camera in this game is pointed. It is
    // race control talking about the session, and the panel that says what the
    // session is doing is this one — so the flag is a full-width band directly
    // under the header, in the flag's own colour, with a second line naming the
    // cause. The centre of the frame keeps exactly one thing: the start.
    this.flagBand = this.el('tower-flagband', this.tower);
    this.flagBand.dataset.probe = 'flag';
    this.flagBandLabel = this.el('flagband-label', this.flagBand, '');
    this.flagBandCause = this.el('flagband-cause', this.flagBand, '');
    this.flagBand.style.display = 'none';

    // The column header. It shares its grid template with every row below it
    // through one custom property, so a column cannot drift from its label —
    // which is what a header row is for, and what two separately-tuned widths
    // would eventually undo.
    const cols = this.el('tower-cols', this.tower);
    for (const [cls, label] of [
      ['c-bar', ''], ['c-pos', 'P'], ['c-mark', ''], ['c-code', 'Driver'],
      ['c-gap', 'Gap'], ['c-tyre', ''], ['c-badge', ''],
    ] as [string, string][]) {
      this.el('tower-col ' + cls, cols, label);
    }

    // The rows get a box of their own so the fastest-lap strip can sit under
    // them: rows are appended as the field is sized, and a footer appended
    // before them would end up in the middle of the order.
    this.rowsBox = this.el('tower-rows', this.tower);

    // The fastest lap, along the foot of the panel. The badge in the order
    // above says WHO holds it, which is what the eye wants mid-corner; this
    // says what it is, which is the number you read on the straight. Purple,
    // because purple is the outright best in this system and the fastest lap is
    // the definition of it.
    this.fastestBar = this.el('tower-fastest', this.tower);
    this.el('fastest-label', this.fastestBar, 'Fastest lap');
    this.fastestFirst = this.el('fastest-first', this.fastestBar, '');
    this.fastestWho = this.el('fastest-who', this.fastestBar, '');
    this.fastestTime = this.el('fastest-time', this.fastestBar, '');
    this.fastestBar.dataset.probe = 'fastest';

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

    // --- The start ----------------------------------------------------------
    // The one graphic still allowed in the middle of the frame, and the only
    // one that has ever earned it: five red lights and the count to them. Every
    // flag this used to carry is a band across the top of the running order
    // now — see `updateFlag`.
    this.flagBanner = this.el('hud-flag', this.root, '');
    // `start`, not `flag`: the flags moved into the tower band, which carries
    // the `flag` token now. This element is the countdown and nothing else.
    this.flagBanner.dataset.probe = 'start';
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
      const root = this.el('tower-row', this.rowsBox);
      const bar = this.el('tower-bar', root);
      const pos = this.el('tower-pos', root, '');
      const mark = this.el('tower-mark', root);
      const code = this.el('tower-code', root, '');
      const gap = this.el('tower-gap', root, '');
      const tyre = this.el('tower-tyre', root, '');
      // Three badges, built once and shown by class. Creating an element in the
      // frame a car takes the fastest lap is a layout in the frame something
      // interesting happened, which is the worst frame to spend one in.
      const badges = this.el('tower-badges', root);
      this.el('tbadge tb-fast', badges).appendChild(stopwatchSvg());
      this.el('tbadge tb-pen', badges, '!');
      this.el('tbadge tb-fin', badges).appendChild(chequerSvg());
      this.rows.push({
        root, bar, pos, mark, code, gap, tyre, badges,
        seen: {
          pos: '', code: '', tyre: '', gap: '',
          markTeam: '', colour: '', badges: '', state: '',
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
    setStyle(this.teamStripe, 'background',
      '#' + player.team.colour.toString(16).padStart(6, '0'));
    setText(this.sessionName, engine.track.def.name.toUpperCase());
    const totalLaps = engine.config.laps || engine.track.def.raceLaps;
    if (engine.config.kind === 'race') {
      setText(this.lapCounter, String(Math.min(player.lap + 1, totalLaps)));
      setText(this.lapTotal, String(totalLaps));
      setClass(this.lapBlock, 'tower-lapblock');
    } else {
      // A practice or qualifying session is a clock, not a lap count. The big
      // slot carries whichever of the two this session is measured in, so the
      // number read from across a room is always the one that matters.
      const remaining = Math.max(0, engine.config.durationS - engine.time);
      setText(this.lapCounter, formatClock(remaining));
      setText(this.lapTotal, '');
      setClass(this.lapBlock, 'tower-lapblock is-clock');
    }

    const clock = lapClock(engine, player);
    setText(this.lapTime, clock.text);
    setClass(this.lapTime, 'timing-lap' + (clock.timed ? '' : ' is-untimed'));
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

  /**
   * The flag, in the tower — and the start, in the middle of the frame.
   *
   * THE COMPLAINT, TWICE. A yellow flag used to be a strip across the top
   * centre of the picture. That is the one place every camera in this game is
   * pointed, and a flag is not a thing that happens for a second and goes: it
   * stands for as long as the hazard does, so it stood on the road for as long
   * as the hazard did.
   *
   * A flag is race control talking about the SESSION, and the panel that says
   * what the session is doing is the running order. So it is a band across the
   * top of the tower now, in the flag's own colour, with a second line naming
   * the cause — because a driver shown a yellow wants to know what is round the
   * corner, and `YELLOW FLAG` alone does not say.
   *
   * The centre column keeps exactly one graphic, and it is the one thing that
   * has to be in the middle of the frame because it is the thing you are
   * looking at the middle of the frame for: the start.
   */
  private updateFlag(engine: RaceEngine, player: CarEntry): void {
    if (!engine.started) {
      const text = engine.startLights > 0
        ? 'LIGHTS OUT IN ' + Math.ceil(engine.startLights) : 'GO';
      setText(this.flagBanner, text);
      setClass(this.flagBanner, 'hud-flag flag-start');
      setStyle(this.flagBanner, 'display', 'block');
    } else {
      setStyle(this.flagBanner, 'display', 'none');
    }

    const band = flagBandState(engine, player);
    if (band) {
      setText(this.flagBandLabel, band.label);
      setText(this.flagBandCause, band.cause);
      setClass(this.flagBand, 'tower-flagband fb-' + band.tone);
      setStyle(this.flagBand, 'display', 'flex');
    } else {
      setStyle(this.flagBand, 'display', 'none');
    }
    // The band changes the panel's height, and the notice rail below it is laid
    // out against that height. See the shape check at the end of `updateTower`.
    this.flagBandShown = band !== null;
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
      // The cue is an instrument, not the principal — capitals belong here, and
      // it stays up for as long as the reason stands. What it must not do is
      // print the advice string twice over: `DAMAGE — PIT FOR REPAIRS — PRESS
      // PIT` says "pit" three times in five words. The reason, then the
      // control, and nothing between them.
      if (advice) { text = pitCueText(advice); cls += ' cue-warn'; }
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
    const fit = towerFit(window.innerWidth, window.innerHeight, this.mirrorFloorPx);
    // THE TOWER GIVES WAY TO THE PIT SHEET on a short screen. 390 pixels of
    // height leaves the notice rail a 94-pixel band between the running order
    // and the tyre panel, and no arrangement of a tyre choice and a wing choice
    // fits in 94. So while a stop is being chosen the order drops its rows and
    // keeps its header — the lap count, your position, the fastest lap — and
    // the rail takes the space back for the few seconds the decision takes.
    //
    // Decided HERE rather than in the stylesheet because the row's `display` is
    // written inline by the loop below, and an inline style beats any rule a
    // media query can offer. The tower's own row count is the only honest place
    // to say "no rows".
    // ...and under the mirror cameras for the same reason: the band the rail
    // has left, once it has lifted clear of the glass, is not one a tyre
    // choice and a wing choice fit in either.
    const squeezed = this.pitSheetOpen &&
      (window.innerHeight <= 470 || this.mirrorFloor > 0);
    const shown = squeezed ? 0 : Math.min(standings.length, fit.rows);
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
      if (seen.code !== cells.code) { row.code.textContent = cells.code; seen.code = cells.code; }
      if (seen.gap !== cells.gap) { row.gap.textContent = cells.gap; seen.gap = cells.gap; }
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

      // The badge column: three facts, three squares, one diffed string.
      const badges = statusBadges(car, sessionBest);
      if (seen.badges !== badges) {
        setClass(row.badges, 'tower-badges' + badges);
        seen.badges = badges;
      }

      // A rule under the pinned leader, because the row below it is not the
      // car behind it. A list that silently skips eight places is a lie.
      const state = 'tower-row'
        + (pinLeader && i === 0 ? ' is-pinned' : '')
        + (car.position === 1 ? ' is-leader' : '')
        + (car === player ? ' is-player' : '')
        + (car.retired || car.disqualified ? ' is-out' : '');
      if (seen.state !== state) { row.root.className = state; seen.state = state; }
    }

    // WHERE THE RAIL STARTS. The notice rail used to begin at half the
    // viewport height, which is a guess about where the running order ends —
    // and it is wrong the moment the tower changes size, which it now does
    // whenever the camera picks up the mirrors. So the tower measures itself
    // and the rail is laid out against the answer.
    //
    // One layout read, on the frames where the row count or the flag band has
    // actually changed. `Hud.update` does not measure anything.
    const shape = shown + '|' + (this.flagBandShown ? 'f' : '');
    if (shape !== this.lastTowerShape) {
      this.lastTowerShape = shape;
      const bottom = Math.round(this.tower.getBoundingClientRect().bottom);
      if (bottom > 0) this.root.style.setProperty('--rail-top', bottom + 8 + 'px');
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
      const worst = player.damage.worst();
      const call = advice
        ? pitCall(advice, {
          part: COMPONENT_NAMES[worst.id],
          repairable: repairableInBox(worst.id),
        })
        : null;
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
      this.fitRail();
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
    // The viewport is in the key because a rotation changes the band without
    // changing anything on it, and a rail that only re-checks itself when a
    // card arrives is a rail that stays wrong until the next message.
    const key = this.neutralCue.style.display + '|' + this.pitCue.style.display + '|' +
      this.radioCard.style.display + '|' + (this.pitSheetOpen ? 'pit' : '') + '|' +
      this.lastTowerShape + '|' + window.innerWidth + 'x' + window.innerHeight +
      '|' + this.mirrorFloor;
    if (key === this.lastPinned) return;
    this.lastPinned = key;
    this.fitRail();
  }

  /**
   * Empties the rail until what is in it fits the band it has.
   *
   * THE BUDGET, MEASURED RATHER THAN PREDICTED. `maxAlerts` divides the band by
   * the shortest a card is ever laid out at, which is a good estimate and was
   * the right answer while the band was a fixed strip. It is not one any more:
   * the band's foot rises by up to a third of the viewport when the camera
   * picks up the mirrors, and its head now follows the running order, so the
   * two ends move independently and an estimate is wrong in both directions.
   * This asks the browser what actually fits.
   *
   * The eviction order is the priority order. The oldest pop-up goes first —
   * it is the one already read — and the radio card after them, because it is
   * the one item on the rail that is atmosphere rather than instruction. The
   * two live cues and the pit sheet are never evicted: a cue is the state of
   * the race and the sheet is a decision with a deadline.
   *
   * One layout read per rail CHANGE. `Hud.update` reaches this through
   * `enforceRailBudget`, which compares a string first and returns.
   */
  private fitRail(): void {
    // A STOP BEING CHOSEN TAKES THE RAIL. The sheet is a decision with a
    // deadline measured in corners and a pop-up over it is the fault this
    // whole arrangement exists to prevent, so the pop-ups go whether or not
    // they would have fitted beside it.
    if (this.pitSheetOpen) {
      for (const c of this.alertCards.slice()) this.dismissAlert(c, true);
    }
    // Bounded so a card taller than the whole band cannot spin here.
    for (let guard = 0; guard < 8; guard++) {
      if (this.railOverflowPx() <= 0) return;
      if (this.alertCards.length > 0) {
        this.dismissAlert(this.alertCards[0], true);
        continue;
      }
      if (this.radioCard.style.display !== 'none') {
        this.hideRadioCard(true);
        continue;
      }
      return;
    }
  }

  /** How far the rail's contents overrun its band, pixels. */
  private railOverflowPx(): number {
    const band = this.notices.getBoundingClientRect().height;
    // Before the first layout — in a probe, or on the frame the HUD is built —
    // there is nothing to measure and nothing has been shown yet.
    if (band <= 0) return 0;
    const gap = parseFloat(getComputedStyle(this.notices).rowGap) || 0;
    let used = 0;
    let n = 0;
    for (const child of this.notices.children) {
      const e = child as HTMLElement;
      // Fractional, not `offsetHeight`. Four or five children each rounded
      // down to the pixel is several pixels of slack that is not there, which
      // is exactly the margin a card overflows a band by.
      const h = e.getBoundingClientRect().height;
      if (h < 1) continue;
      used += h;
      n++;
    }
    if (n > 1) used += (n - 1) * gap;
    return used - band;
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

    this.fitRail();
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

    // A card that was admitted into a tall band and is still standing in a
    // short one. Rotating a phone, calling for a stop mid-clip, or changing to
    // a camera with the mirrors in it all shrink the band under a card that is
    // already up — and a condition tested only on the way in is not a
    // condition. The size case is handled by `fitRail`, which measures; this is
    // the one rule that is not about size.
    if (this.radioCard.style.display !== 'none' && this.pitSheetOpen) {
      this.hideRadioCard(true);
    }

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

    // BEING IN THE PIT LANE IS NOT THE SAME EVENT AS BEING CALLED IN, and
    // conflating them opened every session in this game by telling the driver
    // his rear tyres were finished.
    //
    //   "when I start qualifying, why am I being told to box?? that is so
    //    confusing?"
    //
    // Practice, qualifying and any pit-lane start begin with the car in its
    // garage, so `inPitLane` is true on the FIRST FRAME of the session — and
    // the latch fired there, on brand-new tyres at 74°, on the out-lap of Q1.
    //
    // The moment worth broadcasting is the wall calling the driver in: he has
    // asked for a stop and is still on track on his way to the entry. Leaving
    // the garage is the opposite event and gets no card at all, because a card
    // that fires at the start of every session is noise by the second one.
    //
    // Gated to a race as well. There are no strategy stops in a session that is
    // three laps of your own, and `planStrategies` has always known that —
    // this layer did not.
    const calledIn = engine.config.kind === 'race' && player.pitRequested && !player.inPitLane;
    if (calledIn && !this.radioPitShown) {
      this.radioPitShown = true;
      const totalLaps = engine.config.laps || engine.track.def.raceLaps;
      this.showRadioCard(player, {
        kind: 'pit',
        compound: getCompound(player.compound).name,
        lapsLeft: Math.max(0, totalLaps - player.lap),
        // Why the stop is happening, read off the car at the moment the call is
        // made. The old card asserted "I've got nothing left on the rears"
        // whatever the reason — a lie on a lap-3 stop for a broken wing, and
        // the wear it was lying about is printed on the same screen.
        reason: pitReason(engine, player),
      });
    } else if (!player.pitRequested) {
      this.radioPitShown = false;
    }
  }

  private showRadioCard(player: CarEntry, moment: RadioMoment): void {
    // WHETHER IT FITS IS MEASURED, at the end of this function, by `fitRail` —
    // the band's foot rises by up to a third of the viewport under the mirror
    // cameras and its head follows the running order, so no rule written in
    // viewport pixels is right in every combination. The card is the one item
    // on the rail that is atmosphere rather than instruction, so it is the
    // first thing evicted when the answer is no.
    //
    // It stands down entirely while a stop is being chosen. The driver has
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
    // The eviction the reported overlap came from, and it is measured now
    // rather than estimated: `maxAlerts` divides a band whose two ends both
    // move. See `fitRail`.
    this.fitRail();

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
   * WHAT IT DOES CHANGE, and the exception is the mirrors. Three of the eight
   * cameras have the car's own mirrors in shot, and a mirror is not decoration
   * — it is the only way to see a car that is about to be alongside. The HUD
   * therefore treats the panes exactly as it treats the racing surface: as part
   * of the frame it is not allowed to stand on. `MIRROR_PANES` says where they
   * land, `mirrorBand` reduces that to the corridor between them, and the three
   * custom properties written here are what the stylesheet lays the bottom band
   * out against. Every other camera clears the flag and the HUD spreads back
   * out.
   *
   * One attribute and three properties per camera CHANGE, which happens when a
   * player presses the camera button. Nothing here runs per frame.
   */
  setCameraMode(mode: string): void {
    this.cockpitView = mode === 'cockpit';
    const band = mirrorBand(mode);
    this.mirrorFloor = band ? (100 - band.top) / 100 : 0;
    if (this.root.dataset.camera !== mode) this.root.dataset.camera = mode;
    if (band) {
      this.root.dataset.mirrors = 'yes';
      this.root.style.setProperty('--mirror-l', band.left.toFixed(1) + '%');
      this.root.style.setProperty('--mirror-r', (100 - band.right).toFixed(1) + '%');
      this.root.style.setProperty('--mirror-top', band.top.toFixed(1) + '%');
      this.root.style.setProperty('--mirror-bottom', (100 - band.top).toFixed(1) + '%');
    } else {
      delete this.root.dataset.mirrors;
      for (const p of ['--mirror-l', '--mirror-r', '--mirror-top', '--mirror-bottom']) {
        this.root.style.removeProperty(p);
      }
    }
  }
  /** Which camera is live. Read by nothing yet; see `setCameraMode`. */
  cockpitView = false;
  /** Height of the mirror band as a fraction of the viewport, 0 when none. */
  private mirrorFloor = 0;
  /** The same, in pixels, for `towerFit`. */
  private get mirrorFloorPx(): number {
    return this.mirrorFloor * window.innerHeight;
  }

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
// THE MIRRORS
// ===========================================================================

/**
 * The three cameras that have the car's own mirrors in shot.
 *
 * `bumper`, `chase`, `tv`, `drone` and `trackside` are outside the cockpit or
 * ahead of it and see no glass at all, so the HUD has the whole frame in those.
 */
export type MirrorView = 'driver' | 'cockpit' | 'onboard-t';

export interface PaneRect {
  /** Percentages of frame width and height, top-left origin. */
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * WHERE THE MIRROR PANES LAND, per camera, as percentages of the frame.
 *
 * THE FAULT THIS FIXES. The mirrors were mounted 78.6 degrees out of roll from
 * the day they were written and were only just made to work. On the frame they
 * started working, the weather bug was lying across the left pane in the
 * driver's eye and the tyre panel across it in the cockpit — so on a landscape
 * phone the player could not see one of their own mirrors in either roll-hoop
 * view, and the fix that had just landed was invisible.
 *
 * A mirror is not decoration. It is the only way to see a car that is about to
 * be alongside, and it is therefore part of the frame the HUD must keep clear
 * in exactly the sense the racing surface is. The non-overlap guarantee used to
 * cover only the left notice rail; these rectangles extend it to the glass.
 *
 * MEASURED, NOT DESIGNED. Every number is the envelope of `mirrorPaneCorners`
 * projected through the real `CameraDirector` on all eleven circuits, in both
 * frame shapes (2.17:1 and 16:9), with the head at rest AND turned to the stops
 * — a driver looking through a corner swings the outside pane most of the way
 * to the frame edge, and a keep-out that ignored that would be clear only on
 * the straights. `probe:framing` re-measures the geometry every run and fails
 * if a pane escapes the rectangle declared for it, so a change to the mirror
 * mount cannot silently invalidate the layout below.
 *
 * A one-point margin is added to each measured edge, for the circuits and
 * chassis attitudes that are not in the twelve-sample sweep.
 */
export const MIRROR_PANES: Readonly<Record<MirrorView, readonly PaneRect[]>> = {
  // The driver's own eye: the panes are nearest and largest here, and the left
  // one reaches the frame edge in the 16:9 shape.
  driver: [
    { x0: 0, y0: 70.5, x1: 20.0, y1: 88.5 },
    { x0: 71.5, y0: 69.5, x1: 100, y1: 91.0 },
  ],
  // The roll-hoop pod, 0.2m behind and above the eye: the panes pull inboard
  // and drop down the frame.
  cockpit: [
    { x0: 5.0, y0: 78.5, x1: 31.0, y1: 93.0 },
    { x0: 62.0, y0: 77.5, x1: 86.0, y1: 94.0 },
  ],
  // The T-cam, 0.8m further back again. Small, low and close to the centre.
  'onboard-t': [
    { x0: 24.0, y0: 82.5, x1: 35.0, y1: 89.5 },
    { x0: 66.0, y0: 82.5, x1: 76.5, y1: 90.5 },
  ],
};

/**
 * The corridor the HUD may use low in the frame, derived from the panes.
 *
 * ONE NUMBER EACH, and it is deliberately blunter than the rectangles it comes
 * from: above `top` the HUD has the whole width, and below it the HUD has
 * `left` to `right` and nothing outside them. A stylesheet cannot express "this
 * box may be in the bottom-left corner as long as it is not in that rectangle",
 * and a rule that cannot be expressed is a rule that gets broken by the next
 * media query. A corridor is one comparison per edge and it is conservative in
 * the safe direction.
 *
 * Derived rather than declared so the corridor cannot drift from the panes.
 */
export function mirrorBand(
  mode: string,
): { left: number; right: number; top: number } | null {
  const panes = MIRROR_PANES[mode as MirrorView] as readonly PaneRect[] | undefined;
  if (!panes) return null;
  let left = 0;
  let right = 100;
  let top = 100;
  for (const p of panes) {
    // Which side of the frame a pane is on decides which edge it pushes.
    if (p.x0 + p.x1 < 100) left = Math.max(left, p.x1);
    else right = Math.min(right, p.x0);
    top = Math.min(top, p.y0);
  }
  return { left, right, top };
}

/**
 * The panes as pixel boxes, for a harness that measures the real DOM.
 *
 * `shoot:panels` walks every HUD box against these and fails on any
 * intersection, which is the same treatment the notice rail already gets. The
 * conversion lives here rather than in the harness so the picture and the
 * assertion are reading one table.
 */
export function mirrorPaneBoxes(
  mode: string, w: number, h: number,
): { name: string; x: number; y: number; w: number; h: number }[] {
  const panes = MIRROR_PANES[mode as MirrorView] as readonly PaneRect[] | undefined;
  if (!panes) return [];
  return panes.map((p, i) => ({
    name: 'mirror[' + (p.x0 + p.x1 < 100 ? 'L' : 'R') + i + ']',
    x: (p.x0 / 100) * w,
    y: (p.y0 / 100) * h,
    w: ((p.x1 - p.x0) / 100) * w,
    h: ((p.y1 - p.y0) / 100) * h,
  }));
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
export function towerFit(
  w: number, h: number, floorPx = 0,
): { rows: number; compact: boolean } {
  // Written the same way round as the media query that shrinks the row —
  // `@media (max-width: 900px), (max-height: 470px)`. If these two ever
  // disagree the panel is measured for one row height and drawn at another,
  // which is exactly how a tower ends up hanging off the bottom of a phone.
  const compact = w <= 900 || h <= 470;
  const rowH = compact ? 17 : 26;
  // The panel's own header block and column rule, PLUS the whole rail beneath
  // it: the notice stack, the weather bug and the car state. This number is
  // the reason the tower is not simply "as many rows as fit" — the rest of
  // the left rail has to exist somewhere, and a tower sized to the viewport
  // grows straight down through the pit instruction.
  const reserved = compact ? 260 : 570;
  const fits = Math.floor((h - floorPx - reserved) / rowH);
  // THE FLOOR IS THE MIRRORS. In the three cameras that have the car's own
  // glass in shot the bottom of the frame is not the HUD's to use — see
  // `MIRROR_PANES` — so the whole left column lifts by the height of the band
  // and the running order is what pays for it. Four rows is the floor there
  // rather than six: a tower that keeps six rows on a landscape phone standing
  // on a 119-pixel mirror band leaves the notice rail forty pixels, and forty
  // pixels is not a rail. The other sixteen cars can wait for a straight; the
  // car about to be alongside cannot.
  const min = floorPx > 0 ? 4 : compact ? 4 : 6;
  return {
    rows: Math.max(min, Math.min(fits, compact ? 8 : 14)),
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
  pos: string; code: string; first: string; surname: string; team: string;
  tyre: string; gap: string; best: string; lastLap: string;
} {
  const lapsBehind = ahead ? car.lapsDown - ahead.lapsDown : 0;
  // `Out`, not `DNF`. The row is already dimmed and already at the foot of the
  // order; three capitals of jargon on top of that is the panel saying the same
  // thing three times. A broadcast tower says the car is out and moves on.
  const gap = car.retired ? 'Out'
    : car.disqualified ? 'DSQ'
    // The leader's cell names the COLUMN rather than restating the position the
    // number beside it already gives. Every other row is a figure, so a word
    // there reads as the heading it is.
    : car.position === 1 ? 'Interval'
    : engine.config.kind !== 'race'
      ? (car.bestLapTime > 0 && leader.bestLapTime > 0
        ? formatGap(car.bestLapTime - leader.bestLapTime) : '—')
    : lapsBehind > 0 ? '+' + lapsBehind + (lapsBehind === 1 ? ' LAP' : ' LAPS')
    : formatGap(car.interval);

  return {
    pos: String(car.position),
    code: car.driver.code.toUpperCase(),
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
 * Which status badges a car is carrying, as a class suffix.
 *
 * Three facts the running order has always known and never shown: who holds the
 * fastest lap, who has something to serve, and who has finished. Returned as a
 * string of classes rather than as booleans so the row can diff the whole
 * column in one compare — twenty rows times sixty frames is not a place to
 * touch three elements each.
 *
 * Pure and exported so `probe:hudtext` can assert what the panel claims about a
 * car against what the engine says about it.
 */
export function statusBadges(car: CarEntry, sessionBest: number): string {
  let out = '';
  if (sessionBest > 0 && car.bestLapTime === sessionBest) out += ' has-fast';
  // Anything not yet served, and any time already added to the race result. A
  // five-second penalty is served at the stop and is a fact about the classified
  // order from the moment it is issued.
  if (car.penaltySeconds > 0 || car.penalties.some((p) => !p.served)) out += ' has-pen';
  if (car.finished) out += ' has-fin';
  return out;
}

/**
 * What the flag band says, and what colour it is.
 *
 * PRECEDENCE IS THE WHOLE OF THIS FUNCTION. Several of these can be true at
 * once — a car can be disqualified under a safety car while a yellow is out in
 * the sector it is in — and a band that showed the wrong one would be worse
 * than no band. The order is: what has happened to YOU, then what has happened
 * to the session, then what is round the next corner. A driver who has been
 * disqualified does not need to be told about a yellow.
 *
 * The second line names the cause, because a driver shown a yellow wants to
 * know what is round the corner and `YELLOW FLAG` on its own does not say.
 *
 * Pure and exported so a probe can assert the band against the race control it
 * is reading, rather than against a reimplementation of it.
 */
export function flagBandState(
  engine: RaceEngine, player: CarEntry,
): { label: string; cause: string; tone: string } | null {
  const rc = engine.raceControl;

  if (player.disqualified) {
    return { label: 'DISQUALIFIED', cause: 'BLACK FLAG', tone: 'black' };
  }
  const pen = player.penalties[player.penalties.length - 1];
  if (pen && !pen.served && pen.kind === 'drive-through') {
    return { label: 'DRIVE THROUGH', cause: 'PENALTY TO SERVE', tone: 'red' };
  }

  if (rc.sessionFlag === 'chequered') {
    return { label: 'CHEQUERED FLAG', cause: 'SESSION OVER', tone: 'chequered' };
  }
  if (rc.sessionFlag === 'red') {
    return { label: 'RED FLAG', cause: 'SESSION STOPPED', tone: 'red' };
  }
  if (rc.neutralisation === 'safety-car') {
    return { label: 'SAFETY CAR', cause: 'FIELD NEUTRALISED', tone: 'yellow' };
  }
  if (rc.neutralisation === 'vsc') {
    return { label: 'VIRTUAL SAFETY CAR', cause: 'DELTA TIME ENFORCED', tone: 'yellow' };
  }
  if (player.blueFlag) {
    return { label: 'BLUE FLAG', cause: 'LET THE LEADERS BY', tone: 'blue' };
  }

  const local = rc.flagAt(player.s);
  if (local === 'double-yellow') {
    return { label: 'DOUBLE YELLOW', cause: 'HAZARD ON THE RACING LINE', tone: 'yellow' };
  }
  if (local === 'yellow') {
    return { label: 'YELLOW FLAG', cause: 'TRACK HAZARD', tone: 'yellow' };
  }
  return null;
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
 * What the big lap clock says.
 *
 * A RUNNING CLOCK IS A CLAIM THAT THE LAP IS BEING TIMED, and on an out-lap it
 * is not. Every session in this game except the race starts in the garage, so
 * the first lap is always an out-lap — and the panel ran a stopwatch through
 * it, reaching `0:55.392` on a lap the engine was always going to discard.
 * "the first lap is always the out lap, it should display that on the thing."
 *
 * Nothing new is computed. `CarEntry.onOutLap` is the flag the engine itself
 * uses to refuse to classify the crossing; this reads the same flag. The in-lap
 * is the mirror case and gets the same treatment, because a driver on the way
 * to the pit entry is not setting a time either.
 *
 * Pure and exported so a probe can assert what is on the clock in each session
 * without photographing it.
 */
export function lapClock(
  engine: RaceEngine, player: CarEntry,
): { text: string; timed: boolean } {
  if (player.onOutLap) return { text: 'OUT LAP', timed: false };
  // Called in and still on track: this lap ends in the pit lane.
  if (player.pitRequested && !player.inPitLane) return { text: 'IN LAP', timed: false };
  if (player.inPitLane) return { text: 'PIT LANE', timed: false };
  return { text: formatLapTime(player.currentLapTime(engine.time)), timed: true };
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
export function pitCall(
  advice: string, damage?: { part: string; repairable: boolean },
): { line: string; chip: string; tone: AlertTone } | null {
  const v = PIT_VOICE[advice];
  if (!v) return null;
  // The damage call used to promise a new nose whatever was actually broken.
  // `pitAdvice` fires on the WORST component and the crew can only reach the
  // nose and the sidepods, so a car with a cracked floor was being told it
  // would get a front wing — a claim the damage diagram beside it disproves.
  if (advice === 'DAMAGE — PIT FOR REPAIRS' && damage) {
    const part = spokenPart(damage.part);
    return {
      line: damage.repairable
        ? 'The ' + part + ' has gone. Box this lap and we put a new one on.'
        : 'There is ' + part + ' damage and we cannot fix that in the stop. ' +
          'Box and we take what we can off the car.',
      chip: 'PRESS PIT',
      tone: v.tone,
    };
  }
  return { line: v.line, chip: 'PRESS PIT', tone: v.tone };
}

/** What the crew can actually change in three seconds. Everything else stays. */
export function repairableInBox(id: ComponentId): boolean {
  return id === 'frontWingL' || id === 'frontWingR' || id === 'sidepodL' || id === 'sidepodR';
}

/**
 * A component's name as a person says it.
 *
 * `COMPONENT_NAMES` marks the side — `Front wing (L)` — because the damage
 * diagram has two of most things and has to say which. Speech does not: nobody
 * on a pit wall has ever said "the front wing (l) has gone", which is exactly
 * what came out of the first version of this. The side is dropped and the
 * sentence keeps the part.
 */
export function spokenPart(name: string): string {
  return name.replace(/\s*\([LR]\)\s*$/, '').toLowerCase();
}

export type AlertTone = 'info' | 'warn' | 'urgent' | 'go';

/**
 * The live pit cue: the reason, then the control.
 *
 * Six words at most, because this one is read in peripheral vision at 300km/h
 * and it stands for as long as the reason does. It is the one place raw
 * capitals are correct — it is an instrument, not a person — but it still may
 * not repeat itself, and `DAMAGE — PIT FOR REPAIRS — PRESS PIT` said "pit"
 * three times in five words.
 */
export function pitCueText(advice: string): string {
  return (PIT_CUE[advice] ?? advice) + ' · PRESS PIT';
}

const PIT_CUE: Readonly<Record<string, string>> = {
  'DRIVE-THROUGH TO SERVE': 'DRIVE-THROUGH TO SERVE',
  'PENALTY TO SERVE': 'PENALTY TO SERVE',
  'DAMAGE — PIT FOR REPAIRS': 'DAMAGE ON THE CAR',
  'RAIN — WET TYRES': 'RAIN · WETS',
  'TRACK DRY — SLICKS': 'TRACK DRYING · SLICKS',
  'TYRES GONE': 'TYRES GONE',
  'SECOND COMPOUND REQUIRED': 'SECOND COMPOUND OWED',
  'TYRES WORN — PIT WINDOW OPEN': 'WINDOW OPEN',
};

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
      const part = spokenPart(note.part);
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
/**
 * Why a driver is being called in.
 *
 * It exists because the card used to assert a fact the simulation could
 * contradict: every pit exchange opened `"I've got nothing left on the rears"`,
 * including on a lap-3 stop for a broken front wing with the tyre wear bars
 * sitting at 90% two inches away on the same screen. A radio line that the HUD
 * beside it disproves is worse than no radio line.
 *
 * So the reason is read off the car at the moment the call is made, and each
 * one gets an exchange that only claims what is true.
 */
export type PitReason = 'tyres' | 'damage' | 'weather' | 'penalty' | 'strategy';

export type RadioMoment =
  | { kind: 'pit'; compound: string; lapsLeft: number; reason: PitReason }
  | { kind: 'safety-car' }
  | { kind: 'vsc' }
  | { kind: 'chequered'; position: number }
  | { kind: 'damage'; part: string };

/**
 * What the car itself says is wrong, in the order a pit wall would weigh it.
 *
 * Exported and pure so a probe can assert that a stop on fresh tyres is never
 * described as a tyre stop.
 */
export function pitReason(engine: RaceEngine, player: CarEntry): PitReason {
  if (player.pendingServePenalty() !== null) return 'penalty';
  if (player.damage.worst().health < 0.7) return 'damage';
  const onSlicks = !getCompound(player.compound).isWetWeather;
  if (engine.weather.wetness > 0.4 && onSlicks) return 'weather';
  if (engine.weather.wetness < 0.12 && !onSlicks) return 'weather';
  if (player.physics.rearTires.wear < 0.45) return 'tyres';
  return 'strategy';
}

export interface RadioTurn {
  who: 'driver' | 'wall';
  line: string;
}

export function radioExchange(m: RadioMoment): RadioTurn[] {
  switch (m.kind) {
    case 'pit': {
      // The wall's closing line is the same in every case because it is the
      // only instruction: box, and this is what is going on. What changes is
      // what the driver says first, and it may only claim what is true.
      const box: RadioTurn = { who: 'wall', line: 'Box box. ' + m.compound + ' on the left.' };
      const laps = m.lapsLeft > 0 ? 'And box, ' + m.lapsLeft + ' laps.' : 'And box, box.';
      switch (m.reason) {
        case 'tyres':
          return [
            { who: 'driver', line: 'These rears are going away. How many more?' },
            { who: 'wall', line: laps },
            { who: 'driver', line: 'I can hold on a bit longer.' },
            box,
          ];
        case 'damage':
          return [
            { who: 'driver', line: 'Something is not right with the car.' },
            { who: 'wall', line: 'We can see it. Box this lap and we fix it.' },
            { who: 'driver', line: 'How much is that going to cost me?' },
            box,
          ];
        case 'weather':
          return [
            { who: 'driver', line: 'I am on the wrong tyre out here.' },
            { who: 'wall', line: 'Agreed. Box box, we are changing you over.' },
            { who: 'driver', line: 'Is anyone else coming in?' },
            box,
          ];
        case 'penalty':
          return [
            { who: 'driver', line: 'What is the penalty for?' },
            { who: 'wall', line: 'We argue about it later. Serve it this lap.' },
            { who: 'driver', line: 'That is not on me.' },
            box,
          ];
        case 'strategy':
          return [
            { who: 'driver', line: 'My tyres are okay — can I extend? How many laps left?' },
            { who: 'wall', line: laps },
            { who: 'driver', line: "I don't wanna stop." },
            box,
          ];
      }
    }
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
 * The stopwatch, drawn.
 *
 * The fastest lap's badge. A watch rather than a letter because the badge is
 * eleven pixels across in the running order and a glyph at that size is read as
 * a shape, not as type — and because the purple square already says which of
 * the four things it is. Crown, bezel and a hand at ten past.
 */
export function stopwatchSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
  };
  add('rect', { x: '9.4', y: '1.6', width: '5.2', height: '2.6', rx: '1.1', fill: 'currentColor' });
  add('circle', {
    cx: '12', cy: '14', r: '8', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2.4',
  });
  add('path', {
    d: 'M12 14 L12 9.2 M12 14 L15.4 15.8', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round',
  });
  return svg;
}

/**
 * The chequered flag, drawn.
 *
 * A car that has taken the flag. Four squares rather than a waving flag on a
 * pole: at badge size a flag is a smudge and a two-by-two chequer is
 * unmistakable, which is the whole job of a square eleven pixels across.
 */
export function chequerSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y] of [[3, 3], [12.5, 12.5]] as [number, number][]) {
    const e = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({
      x: String(x), y: String(y), width: '8.5', height: '8.5', fill: 'currentColor',
    })) e.setAttribute(k, v);
    svg.appendChild(e);
  }
  return svg;
}

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
