import { clamp01, formatDelta, formatGap, formatLapTime, MS_TO_KPH } from '../core/MathUtils';
import { getCompound } from '../data/tires';
import { liveGapCell } from '../race/Classification';
import type { RaceEngine } from '../race/RaceEngine';
import type { CarEntry } from '../race/CarEntry';
import type { InputController } from '../input/InputController';
import { bandOf, COMPONENT_NAMES, type ComponentId } from '../race/DamageModel';
import type {
  FlagSignal, RaceControlMessage, RaceNotice, TeamNote,
} from '../race/RaceControlManager';
import { TrackMap } from './TrackMap';
import {
  TeamRadio, type RadioEvent, type RadioSpeaker, type RadioTurnSpec,
} from '../audio/TeamRadio';

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
  /** The car's own best lap. Drawn only in a Lap Time Classified Session. */
  time: HTMLElement;
  gap: HTMLElement;
  tyre: HTMLElement;
  badges: HTMLElement;
  seen: {
    pos: string; code: string; tyre: string; gap: string; time: string;
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
  private gearMode!: HTMLElement;
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

  // --- The radio, and the clock the card types to --------------------------
  /**
   * THE ONE RADIO.
   *
   * This class used to own a second one — `RadioVoice`, a private
   * `speechSynthesis` client with its own 🔊 pip and its own
   * `localStorage['f1sim.radioVoice']` flag — beside `TeamRadio`, which is the
   * real one. Two implementations of one feature, two off-switches for it, and
   * both of them calling `cancel()` on the same global synthesiser, so
   * whichever spoke second silenced the other. Deleted. The switch is
   * `GameSettings.teamRadioVoice` on the Audio tab of Settings, and this is the
   * only client.
   *
   * The typewriter is driven off this object's `word` events rather than off an
   * interval of its own, which is the seam the previous version of this file
   * left open in `speechRate`'s note: *"when the radio audio lands, the thing
   * to do is write the utterance's real duration here."* That turned out to be
   * the wrong shape of answer — a rate is a guess about a line, and a
   * `boundary` event is the synthesiser telling us which characters it has
   * actually said. So there is no rate any more. There is one clock.
   *
   * Injected where there is one to inject — `main.ts` hands over the
   * `AudioEngine`'s instance, which is the one attached to the mix and the only
   * one that can make a sound. A HUD built by a probe harness with no audio
   * engine gets one of its own instead, silent but with the same clock, so the
   * card types at the right pace everywhere and there is never a second
   * typewriter implementation for the no-audio case.
   */
  private radio: TeamRadio;
  /** Non-null only while the HUD is running on a radio it made itself. */
  private ownRadio: TeamRadio | null;
  private unsubscribeRadio: (() => void) | null = null;
  /** Transmission id -> which row of the card it is being typed into. */
  private radioRowOf = new Map<number, number>();
  /** Transmissions of the exchange on screen that have not ended yet. */
  private radioPending = new Set<number>();
  /** Whether the card on screen is holding for an answer. */
  private radioAsking = false;
  /**
   * Whether there is a transmission the card is currently carrying.
   *
   * Separate from whether the card is DISPLAYED, because those are now two
   * different things: `fitRail` parks the card when the rail's band is too
   * short for it and `sizeRadioCard` brings it back when the band grows, and
   * neither of them is allowed to decide that the transmission is over. Only
   * the dwell and a replacement do that.
   */
  private radioLive = false;

  // --- The answer affordance ------------------------------------------------
  /**
   * The row of buttons, and the question they belong to.
   *
   * GENERAL, AND DRIVEN FROM OUTSIDE. There is nothing about tyres or pit stops
   * in any of this: a `RadioQuestion` is an id, two labels, a clock and a
   * function that takes a boolean. The HUD does not know what it is asking, and
   * that is the point — `engine.pitWall` is one source, the stewards will be a
   * second, and neither of them has to be special-cased here to become one.
   */
  private radioChoice!: HTMLElement;
  private radioAsk!: HTMLElement;
  private radioYes!: HTMLElement;
  private radioNo!: HTMLElement;
  private radioClock!: HTMLElement;
  /** The question on screen, or null. */
  private question: RadioQuestion | null = null;
  /** The last question id offered, so the card is raised once per call. */
  private questionShown = 0;

  private weatherPanel!: HTMLElement;
  private weatherPill!: HTMLElement;
  private weatherTemps!: HTMLElement;

  /** The noticeboard, top centre. Race control and nothing else. */
  private controlStack!: HTMLElement;
  /** Bulletins on the noticeboard, oldest first. */
  private controlCards: HTMLElement[] = [];
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
  /** Driver code to car number, for the official banner's `44 (HAM)` form. */
  private carNumbers = new Map<string, number>();
  /** Race-control state the radio card has already reacted to. */
  private lastNeutral = 'none';
  private lastSessionFlag = 'green';
  private radioPitShown = false;
  /** The ending phase already announced, so each step of it fires once. */
  private lastEndingPhase = 'none';
  /** True once the driver has been told they are under the delta this period. */
  private deltaShown = false;

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

  constructor(parent: HTMLElement, radio?: TeamRadio) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.ownRadio = radio ? null : new TeamRadio();
    this.radio = radio ?? (this.ownRadio as TeamRadio);
    this.build();
    parent.appendChild(this.root);
    this.unsubscribeRadio = this.radio.addListener((ev) => this.onRadioEvent(ev));

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
    wire(this.radioYes, () => this.answerRadio(true));
    wire(this.radioNo, () => this.answerRadio(false));
  }

  /**
   * Points the card at the radio that can actually make a sound.
   *
   * The app shell owns the `AudioEngine`, which owns the one `TeamRadio` that
   * is attached to the mix; the HUD is built before audio has been unlocked, so
   * it starts on a silent one of its own and is handed the real one here. The
   * throwaway is disposed rather than left holding timers.
   */
  useRadio(radio: TeamRadio): void {
    if (radio === this.radio) return;
    this.unsubscribeRadio?.();
    this.hideRadioCard(true);
    this.ownRadio?.dispose();
    this.ownRadio = null;
    this.radio = radio;
    this.unsubscribeRadio = radio.addListener((ev) => this.onRadioEvent(ev));
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
      ['c-time', 'Best'], ['c-gap', 'Gap'], ['c-tyre', ''], ['c-badge', ''],
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

    // The gear disc, and under it which gearbox the player is driving.
    //
    // Issue #45: a number key used to be a permanent, invisible mode change —
    // press 4 on a menu and the car was in manual for the rest of the session
    // with nothing anywhere on screen saying so. The mode is now a caption on
    // the one element a driver already looks at, which is the least a mode can
    // cost and still be a mode. It sits in the gap under the numeral inside the
    // 58px disc rather than taking a new box, so no other panel moves.
    const gearCol = this.el('hud-gearcol', wheelRow);
    const gearDisc = this.el('hud-geardisc', gearCol);
    this.gear = this.el('hud-gear', gearDisc, 'N');
    this.gearMode = this.el('hud-gearmode', gearCol, 'AUTO');

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

    // --- The noticeboard, top centre --------------------------------------
    //
    // TWO VOICES, TWO PLACES. "The FIA doesn't say shit but give notifications,
    // the rest of the stuff happens between the team principal and the driver."
    // Race control is a noticeboard — flags, incidents, verdicts, session state
    // — impersonal, terse, addressed to nobody. The pit wall is a person who
    // knows this driver. They were already drawn as two different systems; they
    // are now in two different parts of the frame, which is where a broadcast
    // puts them and is the difference between a split you can see and a split
    // you have to read.
    //
    // The top centre is free because the flag left it: see `updateFlag`. It is
    // the one band of the picture every camera in this game is pointing at sky
    // in, and a bulletin is the one thing that has to be seen by somebody who
    // is looking at the road.
    this.controlStack = this.el('hud-controls', this.root);
    this.controlStack.dataset.probe = 'controls';

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
      // The gearbox. Both lines are here because issue #45 was, in the end, a
      // documentation failure as much as a code one: the number keys latched
      // manual mode permanently and the only way out was a `0` that appeared
      // in no menu, on no screen and in no help text.
      '<span class="k">1&ndash;8</span><span>Select a gear (switches to manual)</span>' +
      '<span class="k">G</span><span>Gearbox: automatic / manual</span>' +
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
    // There is no voice switch here any more. There used to be — a 🔊 pip in
    // this header, on the argument that the moment somebody wants the radio to
    // stop talking is the moment it is talking — and it was the second of two
    // independent off-switches for one feature, the other being in Settings.
    // Two switches for one thing is worse than an inconvenient one, so the
    // Settings row is the survivor: it is the one that persists with the rest
    // of the player's settings rather than in a `localStorage` flag of its own,
    // and it is the one whose click can prime the speech engine for iOS.
    this.el('radio-rule', this.radioCard);

    // THE WAVEFORM, behind the words, in the team's colour at low alpha.
    //
    // It is the one thing on the plate that says AUDIO rather than text, and
    // that is the whole job: without it a card of quoted capitals is a caption,
    // and the reference plate is unmistakably a recording. Drawn as SVG in the
    // game's own geometry, built once, and never touched again — it does not
    // animate, because a waveform that dances to nothing is a lie about a
    // signal the game does not have, and because this sits behind live text
    // that is already being written a character at a time.
    this.radioCard.appendChild(waveformSvg());

    this.radioTurnsEl = this.el('radio-turns', this.radioCard);
    // Four slots, built once. The card is square now rather than a letterbox,
    // and a square carries the whole argument rather than the last two lines of
    // it — which is what makes it read as a transmission instead of a caption.
    // Creating elements inside an event handler that fires under a safety car
    // is how a frame gets dropped at the worst possible moment.
    for (let i = 0; i < RADIO_TURNS_SHOWN; i++) {
      const turn = this.el('radio-turn', this.radioTurnsEl);
      turn.style.display = 'none';
      this.radioTurnRows.push(turn);
    }

    // --- The answer ------------------------------------------------------
    //
    // "the conversation between the team and me should go two ways right not
    //  just one?"
    //
    // Built once and hidden, because the alternative is creating three buttons
    // inside the frame a strategy call arrives — which is a frame that already
    // has a neutralisation, twenty cars and a relayout in it.
    this.radioChoice = this.el('radio-choice', this.radioCard);
    this.radioChoice.style.display = 'none';
    this.radioAsk = this.el('radio-ask', this.radioChoice, '');
    const buttons = this.el('radio-buttons', this.radioChoice);
    this.radioYes = this.el('radio-btn is-yes', buttons, 'YES');
    this.radioNo = this.el('radio-btn is-no', buttons, 'NO');
    // The clock, drawn as a draining rule rather than as a number: an offer with
    // a countdown on it reads as a quiz, and this is a man asking a question.
    this.radioClock = this.el('radio-clock', this.radioChoice);

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
      // The car's own best lap. Zero-width in a race — see `.hud-tower.is-timed`
      // — and the whole point of the panel in a session that is about lap times.
      const time = this.el('tower-time', root, '');
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
        root, bar, pos, mark, code, time, gap, tyre, badges,
        seen: {
          pos: '', code: '', tyre: '', gap: '', time: '',
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
      for (const c of this.controlCards.slice()) this.dismissControl(c, true);
      // The field's driver codes, so `relayed` knows which three-letter words
      // are people. Built once per session; the field does not change inside
      // one, and guessing instead turns "the" into a driver.
      this.keepCaps = new Set(engine.cars.map((c) => c.driver.code));
      // And the code-to-number table the official banner needs. Race control
      // names a car by its NUMBER with the code in brackets — `CARS 44 (HAM)
      // AND 1 (VER)` — and the notice carries only the code, so the banner
      // resolves it here. Built once per session for the same reason.
      this.carNumbers = new Map(engine.cars.map((c) => [c.driver.code, c.driver.raceNumber]));
    }

    // --- Speed, gear, rpm -------------------------------------------------
    setText(this.speed, Math.round(p.speedKph).toString());
    const gearLabel = p.inReverse ? 'R'
      : p.speedMs < 0.6 && player.appliedControls.throttle < 0.02 ? 'N'
      : String(p.gear);
    setText(this.gear, gearLabel);
    setClass(this.gear, 'hud-gear' + (p.inReverse ? ' reverse' : ''));
    // Which gearbox, straight off the input layer rather than off a copy — a
    // second source of truth for a mode is how the mode goes invisible again.
    const manual = input.gearMode === 'manual';
    setText(this.gearMode, manual ? 'MANUAL' : 'AUTO');
    setClass(this.gearMode, 'hud-gearmode' + (manual ? ' manual' : ''));

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
    // THE TOWER GIVES WAY TO A DECISION, on every viewport and not only on the
    // short ones. Now that a full-height desktop draws all twenty cars, the
    // running order is 533 pixels tall — and the pit sheet is 250 more, in the
    // same column, with the two live cues under it. It fitted before only
    // because the tower was capped at fourteen rows. Eight rows is the leader,
    // the fight and the player; the other twelve can wait for the few seconds
    // a tyre choice takes.
    const capped = this.pitSheetOpen ? Math.min(fit.rows, PIT_OPEN_ROWS) : fit.rows;
    const shown = squeezed ? 0 : Math.min(standings.length, capped);
    this.ensureRows(shown);

    // Which cars get a row, when there are not enough rows for everybody. See
    // `towerWindow` — retirements go first, and the player sits two thirds down
    // their own window so most of what they can see is the road ahead.
    const win = towerWindow(standings, shown, standings.indexOf(player));
    const pinLeader = win.pinLeader;

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
      // `towerWindow` has already resolved the pin and the drop-outs, so this
      // is a straight index into the order it chose.
      const at = win.rows[i] ?? -1;
      const car = i < shown && at >= 0 ? standings[at] : undefined;
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
      // A LAP TIME BELONGS TO THE CAR THAT SET IT. Written from that car's own
      // `bestLapTime` and nothing else, so it appears the moment they cross the
      // line whatever the player is doing — which is the whole of the reported
      // fault: "why are you waiting on me to display their times that they did
      // at other laps?"
      if (seen.time !== cells.best) { row.time.textContent = cells.best; seen.time = cells.best; }
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
        // The quickest lap of the session, so the time column is purple on the
        // one row that holds it — the sport's own rule, which is why the column
        // needs no legend.
        + (sessionBest > 0 && car.bestLapTime === sessionBest ? ' is-best' : '')
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
    // A Lap Time Classified Session gets the lap-time column; a race does not.
    // One class write per session, not per frame.
    const timed = engine.config.kind !== 'race';
    const shape = shown + '|' + (this.flagBandShown ? 'f' : '') + (timed ? 't' : '');
    if (shape !== this.lastTowerShape) {
      this.lastTowerShape = shape;
      this.tower.classList.toggle('is-timed', timed);
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
    // WHAT THE DRIVER IS ACTUALLY DOING, read once. Every team line below is
    // gated on it and a line that fails the gate is dropped rather than held —
    // see `DriverState` for why a radio that catches up is worse than one that
    // missed something.
    const state = driverState(engine, player);
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
        if (!noteAllowed(m.team, state)) continue;
        const said = teamLine(m.team, this.teamContext(engine, player, about!));
        this.pushAlert(player, said.line, '', said.tone);
      } else {
        // Unstructured text has no declared precondition, so it gets the
        // blanket one: a retired driver is told nothing further about a race
        // they are no longer in.
        if (state.retired) continue;
        this.pushAlert(
          player, relayed(m.text, this.keepCaps), '',
          m.severity === 'critical' ? 'urgent' : m.severity === 'warning' ? 'warn' : 'info',
        );
      }
    }
    if (messages.length > 0) this.lastMessage = messages[messages.length - 1];

    // The pit call speaks once, when the advice changes — not on every frame
    // it holds. The persistent card below carries it for as long as it stands.
    // A pit call is an instruction to a car that can still reach the pit lane.
    const advice = !state.running || player.pitRequested
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
      // The player's own given name, whatever they typed into the career's
      // creation screen. It survives the whole chain — profile, world driver,
      // engine entry — so the principal can simply use it.
      firstName: player.driver.firstName,
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
    // THE BAND'S OWN HEIGHT IS IN THE KEY, and it is the fix for a whole family
    // of one-frame-late failures. Everything else here is a proxy for "the rail
    // has changed shape", and every proxy has a case it misses: the cue that
    // appears in the same frame as the card, the tower's rail-top written after
    // the card was measured, a safe-area inset arriving late on a phone. The
    // band is the thing the budget is actually divided from, so measuring it is
    // both the honest key and one `getBoundingClientRect` on one element.
    const band = Math.round(this.notices.getBoundingClientRect().height);
    const key = this.neutralCue.style.display + '|' + this.pitCue.style.display + '|' +
      this.radioCard.style.display + '|' + (this.pitSheetOpen ? 'pit' : '') + '|' +
      this.lastTowerShape + '|' + window.innerWidth + 'x' + window.innerHeight +
      '|' + this.mirrorFloor + '|' + band;
    if (key === this.lastPinned) return;
    this.lastPinned = key;
    // A card the rail took away when it was short, put back now the band has
    // grown — a driver who glanced in a mirror mid-transmission gets the rest
    // of it. Ordered before `fitRail` so the restored card is measured with
    // everything else rather than on the next change.
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
    // BEFORE EVICTING ANYTHING, MAKE THE CARD FIT. See `sizeRadioCard`. This
    // is ordered first deliberately: the eviction below is correct as a last
    // resort and was wrong as a first one, and the difference between the two
    // was a player who could not see any of their radio at all.
    this.sizeRadioCard();
    // Bounded so a card taller than the whole band cannot spin here.
    for (let guard = 0; guard < 8; guard++) {
      if (this.railOverflowPx() <= 0) return;
      if (this.alertCards.length > 0) {
        this.dismissAlert(this.alertCards[0], true);
        continue;
      }
      if (this.radioCard.style.display !== 'none') {
        // PARKED, not destroyed. The card is the one item on this rail that is
        // atmosphere rather than instruction, so it is the first thing to go
        // when the band is short — but it comes back when the band does, which
        // is what `sizeRadioCard` handles at the top of this function. It used
        // to be evicted outright, and a player who glanced in a mirror
        // mid-transmission lost the rest of it permanently.
        setStyle(this.radioCard, 'display', 'none');
        continue;
      }
      return;
    }
  }

  /**
   * Sizes the radio card to the room the rail actually has.
   *
   *   "that text box i told u to make it a square and make it bigger its so
   *    hard to read"
   *   "also i cant see any of the messages bruh"
   *
   * THE SECOND ONE IS THE BUG AND IT WAS ALREADY MEASURED. `shoot:panels` has
   * been reporting *"the radio card is not on screen in a 248px band"* on
   * desktop and *"in a 348px band"* in portrait as a known failure, and the
   * cause is arithmetic: the card is 176px, the neutralisation cue is 45, the
   * pit cue is 30 and two gaps are 16, which is 267 pixels of content in a 248
   * pixel band. `fitRail` is permitted to throw the radio card away when the
   * rail overruns — it is the one item on the rail that is atmosphere rather
   * than instruction — so nineteen pixels of overflow deleted the whole
   * feature, silently, and the player saw nothing.
   *
   * NINETEEN PIXELS SMALLER IS LEGIBLE. NOT THERE IS NOT. So the card is sized
   * to what is left after everything that cannot be evicted has taken its
   * share, floored at `RADIO_CARD_MIN_PX` — a header, a rule and two turns,
   * below which it stops being worth drawing — and capped at the size the
   * stylesheet asks for, which is the square. It only ever shrinks below that
   * when the alternative is disappearing.
   *
   * The WIDTH follows the height at the plate's own aspect so the shape
   * survives: a card that shrinks in one axis only becomes the letterbox this
   * whole pass replaced, and `shoot:panels` fails that too — correctly.
   *
   * One `getBoundingClientRect` per rail change, in the same pass `fitRail`
   * was already making.
   */
  private sizeRadioCard(): void {
    // A card that was never raised, or one the dwell has taken away for good.
    if (!this.radioLive) return;
    const cs = getComputedStyle(this.radioCard);
    const maxH = parseFloat(cs.getPropertyValue('--radio-h-max'));
    const maxW = parseFloat(cs.getPropertyValue('--radio-w-max'));
    // A viewport whose stylesheet does not ask for a fixed plate — the
    // landscape phone, where the card is deliberately a letterbox whose height
    // is its content. Nothing to size.
    if (!(maxH > 0) || !(maxW > 0)) return;

    const band = this.notices.getBoundingClientRect().height;
    if (band <= 0) return;
    const gap = parseFloat(getComputedStyle(this.notices).rowGap) || 0;
    // THE CARD IS COUNTED WHETHER OR NOT IT IS CURRENTLY SHOWING, and that is
    // load-bearing rather than tidy. `room` has to be INVARIANT to the card's
    // own parked state or this function oscillates: a parked card is one fewer
    // flex child, so it is one fewer `gap`, so `room` is a few pixels larger
    // while parked than while shown. With the band sitting between the two
    // values the card unparks, is re-measured, no longer fits, parks, changes
    // the `enforceRailBudget` key, and comes straight back — for ever, one flip
    // per frame. Excluding only its HEIGHT and never its slot removes the loop
    // by construction.
    let others = 0;
    let n = 0;
    for (const child of this.notices.children) {
      const e = child as HTMLElement;
      if (e === this.radioCard) { n++; continue; }
      const h = e.getBoundingClientRect().height;
      if (h < 1) continue;
      n++;
      others += h;
    }
    // THE MASK COMES OFF THE TOP. `.hud-notices` fades its first 28 pixels to
    // transparent so a clipped stack reads as "there is more above this"
    // rather than as a rendering fault — and the radio card is the TOPMOST
    // child, so a card sized into the full band has its own header sitting in
    // that fade. That is half of "i cant see any of the messages": the card
    // was on screen and its first line was being faded out.
    //
    // It also buys back the eight pixels the rail's own top overlaps the
    // running order by, which `shoot:panels` reports as
    // `.hud-tower x .hud-radiocard by 186x8px` the moment the rail is full
    // enough to reach up there.
    const room = band - others - (n > 1 ? (n - 1) * gap : 0) - RAIL_MASK_PX;

    // PARKED, NOT DESTROYED — and this is the second half of "i cant see any
    // of the messages".
    //
    // The band's foot rises by up to a third of the viewport the moment the
    // camera picks up the mirrors, so in portrait a card raised in a 348 pixel
    // band was being measured a fraction of a second later in a seventy pixel
    // one, thrown out, and never seen again — `shoot:panels` reported exactly
    // that as "the radio card is not on screen in a 348px band", in a band it
    // fits in three times over. Restoring it was tried once before and
    // withdrawn because the restore and the eviction were two measurements of
    // a band that moved under both of them, and they raced.
    //
    // They cannot race now. The card's height is a FUNCTION of the room left
    // by the children that cannot be evicted, so restoring it and then sizing
    // it can only ever produce a card that fits: `others + gaps + h` is at
    // most `band - RAIL_MASK_PX`, so the loop in `fitRail` finds no overflow
    // and does not park it again. Below the floor it stays parked, which is
    // the landscape phone and is a measured trade rather than a bug.
    if (room < RADIO_CARD_MIN_PX) {
      if (this.radioCard.style.display !== 'none') {
        setStyle(this.radioCard, 'display', 'none');
      }
      return;
    }
    if (this.radioCard.style.display === 'none') {
      setStyle(this.radioCard, 'display', 'block');
    }

    const h = Math.max(RADIO_CARD_MIN_PX, Math.min(maxH, room));
    const w = Math.min(maxW, h * (maxW / maxH));
    this.radioCard.style.setProperty('--radio-h', h.toFixed(1) + 'px');
    this.radioCard.style.setProperty('--radio-w', w.toFixed(1) + 'px');
    // The header's type follows the plate — see `.radio-head` in styles.css.
    // At 129 of a wanted 176 the driver's surname at full size no longer fits
    // the narrower card and wraps mid-word, which reads as a broken graphic
    // rather than as a small one. The TURNS are deliberately not scaled: the
    // complaint was that the words were hard to read.
    this.radioCard.style.setProperty('--radio-scale', (h / maxH).toFixed(3));
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

  /**
   * The pit wall saying one thing.
   *
   * ONE RADIO, ONE LOOK. This used to build a completely different object: a
   * chat bubble with a circular avatar, `MARCO VIDAL` on one line and `Team
   * principal` under it in sentence case, sitting on the same rail as the
   * broadcast plate.
   *
   *   "why are there two different types of radio messages happening, I can't
   *    tell the difference?"
   *
   * They could not tell the difference because there was not one to tell. Both
   * were the player's own pit wall, on the player's own team channel, saying
   * the player's own team's business — rendered in two visual languages that
   * shared no type, no colour and no shape. The bubble also carried a face and
   * a name the plate did not, which made the two look like two different
   * PEOPLE as well as two different systems.
   *
   * So there is one card now, and this is a transmission with a single turn in
   * it. The tone survives as the card's accent; the chip is dropped, because a
   * chip is a status string and this is somebody talking.
   *
   * The rail therefore carries ONE radio card, which is also what a radio is:
   * two people cannot transmit at once, and a stack of three simultaneous
   * transmissions was never a thing that could happen.
   */
  private pushAlert(player: CarEntry, line: string, _chip: string, tone: AlertTone): void {
    this.raiseCard(player, [{ who: 'wall', line }], tone, false);
  }

  /**
   * A race-control bulletin, as the official strip.
   *
   *   "this doesn't look good, I showed you an image of the FIA, you should
   *    replicate that font and color and completely."
   *
   * The reference is unambiguous and what was here matched none of it. This was
   * a dark ROUNDED CARD with a yellow bar down its left edge, a `RACE CONTROL`
   * chip on its own line, the incident under it, and the facts under that —
   * three stacked blocks in a rounded rectangle, which is the shape of a
   * notification and not of an official notice.
   *
   * The real thing is a HORIZONTAL STRIP across the top of the picture:
   *
   *     ┌──────┬──────────────────────────────────────────────────┐
   *     │ ⬤    │ RACE CONTROL: TURN 8 INCIDENT INVOLVING CARS      │
   *     │ mark │ 44 (HAM) AND 1 (VER)                              │
   *     │      │ NOTED - IMPEDING                                  │
   *     └──────┴──────────────────────────────────────────────────┘
   *
   * Squared corners, no rounding anywhere. A darker navy block on the left
   * carrying the governing body's mark, then the message area. `RACE CONTROL:`
   * in bold and the incident CONTINUING ON THE SAME LINE — not a chip above it
   * — with the facts on a smaller second line. White on navy, condensed, tight,
   * uppercase, and no accent bar of any colour.
   *
   * THE MARK IS THIS GAME'S OWN. The FIA roundel is a trademark and is not
   * reproduced; `governingMarkSvg` draws the game's own governing-body device
   * in the same position at the same weight, which is the substitution the
   * whole of this repo's signage already makes.
   *
   * The DECISION variant keeps its segmented form — a penalty has changed the
   * result and has to be unmissable — but it is now built on the same strip,
   * with the same mark block, so the two states read as one system.
   */
  private pushControlCard(m: RaceControlMessage, about: CarEntry | undefined): void {
    const c = raceControlCard(m, this.carNumbers);
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
      const badge = this.el('control-seg control-badge', card);
      badge.appendChild(governingMarkSvg());
      const pen = this.el('control-seg control-penalty', card);
      for (const line of c.penalty) this.el('control-penline', pen, line);
      const who = this.el('control-seg control-driver', card);
      this.el('control-first', who, about.driver.firstName);
      this.el('control-last', who, about.driver.lastName.toUpperCase());
      const mark = this.el('control-teammark', who);
      mark.appendChild(teamMarkSvg(about.team));
      this.el('control-bang', card, '!');
      this.mountControl(card);
      return;
    }

    // A NOTE. The official strip: the mark block, then one run of text that
    // opens `RACE CONTROL:` in bold and carries straight on into the incident.
    card.className = 'hud-control tone-' + c.tone + ' entering';
    const badge = this.el('control-badge', card);
    badge.appendChild(governingMarkSvg());
    const body = this.el('control-body', card);
    const line = this.el('control-headline', body);
    // Two elements rather than an interpolated string, so nothing that came out
    // of a roster or a save is ever written as markup.
    const label = document.createElement('b');
    label.className = 'control-label';
    label.textContent = 'RACE CONTROL: ';
    line.appendChild(label);
    line.appendChild(document.createTextNode(c.headline));
    if (c.detail) this.el('control-detail', body, c.detail);
    this.mountControl(card);
  }

  /**
   * Puts a bulletin on the noticeboard.
   *
   * Its own stack, its own budget and its own dwell. Two at a time, because the
   * board is over the road and a third card is a third of the picture — and
   * because two is what race control ever has running at once in practice: an
   * incident and the decision that follows it.
   */
  private mountControl(card: HTMLElement): void {
    // IN PORTRAIT THERE IS NO TOP CENTRE. The running order and the timing
    // panel take a 390-pixel frame between them, the wheel dash and the gap
    // readout take the strip under them, and what is left at the top of the
    // picture is a 38-pixel gutter. So on that one shape the board goes back
    // into the rail where it was, and the two voices stay apart by look — no
    // face, a hard official label, capitals — rather than by place.
    if (window.innerWidth <= 620 && window.innerHeight > window.innerWidth) {
      this.mountCard(card);
      return;
    }
    this.controlStack.appendChild(card);
    this.controlCards.push(card);
    enterNextFrame(card);
    window.setTimeout(() => this.dismissControl(card), this.alertDwellMs);
    while (this.controlCards.length > MAX_CONTROL_CARDS) {
      this.dismissControl(this.controlCards[0], true);
    }
  }

  private dismissControl(card: HTMLElement, now = false): void {
    const i = this.controlCards.indexOf(card);
    if (i < 0) return;
    this.controlCards.splice(i, 1);
    if (now) { card.remove(); return; }
    card.classList.add('leaving');
    window.setTimeout(() => card.remove(), 420);
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
   * whenever there is something to nag about; this is a moment. Each moment is
   * an engine event with an EDGE, not a line on a timer, so the card cannot cry
   * wolf — and the ordering below is a priority ordering, because two of them
   * can land on the same frame and the card only carries one.
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

    // A QUESTION OUTRANKS EVERYTHING, because it is the only thing on this card
    // with a deadline attached to it and the only one the player can act on.
    // The source is passed in from outside — see `radioQuestion` — so this
    // block contains no knowledge of what is being asked.
    this.updateQuestion(engine, player);

    if (rc.neutralisation !== this.lastNeutral) {
      const was = this.lastNeutral;
      this.lastNeutral = rc.neutralisation;
      if (was === 'none' && rc.neutralisation === 'safety-car') {
        this.showRadioCard(player, {
          kind: 'safety-car',
          position: player.position,
          // What the neutralisation has actually cost them, which is the
          // question every driver asks and none of them can answer from the
          // cockpit: the lead they had over the car behind is now nothing.
          lostS: player.perception.behind?.gapS ?? 0,
        });
      } else if (was === 'none' && rc.neutralisation === 'vsc') {
        this.showRadioCard(player, {
          kind: 'vsc',
          position: player.position,
          // WHERE, which is the whole of what the driver is asking. A car
          // stopped two corners in front of them is a different race from one
          // stopped on the other side of the circuit, and the marshal posts
          // cannot tell them which.
          where: incidentPlace(engine),
        });
      }
    }

    // THE ENDING, which had no announcement at all.
    //
    //   "when there is an end to the VSC or SC there has to be a notification up
    //    top saying vsc ending green flag next lap etc etc. follow the rules."
    //
    // The rules are followed in `RaceControlManager.endingPhase`, which names
    // the four phases and cites the article each one comes from. This is the
    // radio half of it; the top-centre banner is `updateEndingBanner`.
    const phase = rc.endingPhase;
    if (phase !== this.lastEndingPhase) {
      this.lastEndingPhase = phase;
      if (phase !== 'none') {
        this.showRadioCard(player, {
          kind: 'neutral-ending', phase, mustUnlap: player.mustUnlap,
        });
      }
    }

    // The driver's own number against the delta, once a sector under the
    // neutralisation has actually produced one. See the `delta` moment for why
    // this is not said at the deployment.
    if (rc.neutralisation !== 'none' && !player.mustUnlap && !player.inPitLane) {
      const margin = player.deltaSectorTime - rc.minimumSectorTimeS;
      const bad = margin < 0 && player.deltaSectorTime > 0.5;
      if (bad && !this.deltaShown) {
        this.deltaShown = true;
        this.showRadioCard(player, {
          kind: 'delta', marginS: margin, breaches: player.deltaBreaches,
        });
      }
    } else {
      this.deltaShown = false;
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

  /**
   * Puts a question on the card, and takes it off again when it lapses.
   *
   * THE TWO CLOCKS. A call has an expiry and a button has a finger, and they
   * race — `PitWall.answer` returns `'lapsed'` on a stale id precisely because
   * of it. So this never assumes the question it is drawing is still live: the
   * expiry is re-read every frame from the source, and `answerRadio` believes
   * the return value rather than the button that was pressed.
   *
   * Runs at 50fps and writes nothing on a frame where the id and the whole
   * second have not moved, which is every frame but about fifty a race.
   */
  private updateQuestion(engine: RaceEngine, player: CarEntry): void {
    const q = radioQuestion(engine);

    if (!q) {
      // The offer went away without an answer. Say so — a question that
      // produces silence is a question the player learns to ignore, because
      // nothing they did or did not do had any effect.
      if (this.question) {
        const stale = this.question;
        this.question = null;
        setStyle(this.radioChoice, 'display', 'none');
        this.raiseCard(player, replyExchange('lapsed', stale.compound), 'info', false);
      }
      return;
    }

    if (q.id !== this.questionShown) {
      this.questionShown = q.id;
      this.question = q;
      this.showRadioCard(player, {
        kind: 'call',
        message: q.message, reason: q.reason, question: q.ask,
        compound: q.compound, callId: q.id,
      });
      return;
    }

    // Same question, still live: only the clock moves. Written as a custom
    // property so the drain is a compositor animation rather than a layout.
    this.question = q;
    if (this.radioChoice.style.display !== 'none') {
      const left = Math.max(0, Math.min(1, q.expiresInS / Math.max(q.windowS, 1)));
      const pct = (left * 100).toFixed(0) + '%';
      if (this.radioClock.style.width !== pct) {
        setStyle(this.radioClock, 'width', pct);
      }
    }
  }

  /**
   * The driver's answer.
   *
   * Believes the OUTCOME, not the press. If the call expired between the touch
   * starting and this running, `answer` says `'lapsed'` and the wall says the
   * lapsed line — which is the honest thing to show somebody whose finger was
   * a tenth of a second late, and much better than a card that acknowledges a
   * stop that is not going to happen.
   */
  private answerRadio(yes: boolean): void {
    const q = this.question;
    const engine = this.lastEngine;
    if (!q || !engine) return;
    this.question = null;
    setStyle(this.radioChoice, 'display', 'none');
    const outcome = q.answer(yes);
    const player = engine.playerCar;
    if (!player) return;
    this.raiseCard(player, replyExchange(outcome, q.compound), 'info', false);
  }

  /** A moment, in its own words. */
  private showRadioCard(player: CarEntry, moment: RadioMoment): void {
    // THE GATE. Nothing reaches the card without a precondition on this car's
    // own state having been declared and met — see `MOMENT_VALID`. A driver in
    // a barrier is not asking for a delta, and the wall is not giving them one.
    if (this.lastEngine && !momentAllowed(moment, driverState(this.lastEngine, player))) {
      return;
    }
    const asking = moment.kind === 'call' && moment.question.length > 0;
    if (asking && moment.kind === 'call') {
      setText(this.radioAsk, moment.question);
      setText(this.radioYes, this.question?.yesLabel ?? 'YES');
      setText(this.radioNo, this.question?.noLabel ?? 'NO');
    }
    this.raiseCard(
      player, radioExchange(moment),
      moment.kind === 'call' && moment.callId > 0 ? 'warn' : 'info',
      asking,
    );
  }

  /**
   * THE ONE CARD. Every word the player's own team says reaches the screen
   * through here — a strategy call, a gap, a penalty, a safety car, a
   * retirement, and the single-sentence pop-ups that used to be a separate
   * widget with a face on it. One channel, one look.
   *
   * WHETHER IT FITS IS MEASURED, at the end of this function, by `fitRail` —
   * the band's foot rises by up to a third of the viewport under the mirror
   * cameras and its head follows the running order, so no rule written in
   * viewport pixels is right in every combination.
   *
   * It stands down entirely while a stop is being chosen. The driver has a
   * decision in front of them with a deadline measured in corners; the rail is
   * not tall enough to carry both.
   */
  private raiseCard(
    player: CarEntry, ex: RadioTurn[], tone: AlertTone, asking: boolean,
  ): void {
    if (this.pitSheetOpen) return;
    if (ex.length === 0) return;
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;
    // Whatever was being said is over. `cancelAll` ends the live transmission
    // and empties the queue, so the card that is about to be raised cannot have
    // the previous one's words typed into it.
    this.radioRowOf.clear();
    this.radioPending.clear();
    this.radio.cancelAll();

    if (this.markedTeam !== player.team.id) {
      this.radioMark.textContent = '';
      this.radioMark.appendChild(teamMarkSvg(player.team));
      this.markedTeam = player.team.id;
    }
    // The team's colour is the card's colour: the surname, the waveform behind
    // it and every one of the driver's own lines are all drawn from this one
    // property, so a data swap that changes the roster changes the card without
    // touching a line of this file.
    this.radioCard.style.setProperty(
      '--team', '#' + player.team.colour.toString(16).padStart(6, '0'),
    );
    setText(this.radioDriver, player.driver.lastName);
    setClass(this.radioCard, 'hud-radiocard tone-' + tone);

    this.radioLive = true;
    this.radioAsking = asking;
    if (asking) {
      setStyle(this.radioClock, 'width', '100%');
      setStyle(this.radioChoice, 'display', 'block');
    } else {
      setStyle(this.radioChoice, 'display', 'none');
    }

    this.typeExchange(ex);

    this.radioCard.classList.remove('leaving');
    this.radioCard.classList.add('entering');
    setStyle(this.radioCard, 'display', 'block');
    enterNextFrame(this.radioCard);
    this.fitRail();

    // THE DWELL STARTS WHEN THE TALKING STOPS, not when the card appears — see
    // `armDwell`. A card that starts its eight seconds at the moment it is
    // raised was correct while the typewriter ran at a fixed 45 characters a
    // second and every exchange was over in three; it is wrong now that the
    // words arrive at the pace they are spoken, because a four-turn exchange
    // takes about twelve seconds to say and the card would have left before the
    // last man finished his sentence. `armDwell` is called from the `end` of
    // the last transmission.
    //
    // The exception is a card with nobody talking on it at all, which is what
    // an exchange the radio declined leaves behind: arm it now or it never
    // leaves.
    if (this.radioPending.size === 0) this.armDwell();
  }

  /**
   * Starts the card's countdown. Called once the last word has been said.
   *
   * A question stands for as long as the offer does — its own clock, not the
   * card's — because taking the buttons away underneath somebody who is still
   * deciding is exactly the fault the two-clock note is about.
   */
  private armDwell(): void {
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;
    const dwell = this.radioAsking ? Math.max(this.radioDwellMs, 20_000) : this.radioDwellMs;
    this.radioTimers.push(window.setTimeout(() => {
      this.radioCard.classList.add('leaving');
      this.radioTimers.push(window.setTimeout(() => this.hideRadioCard(true), 440));
    }, dwell));
  }

  /**
   * Broadcasts the driver's retirement, in place of the modal that used to.
   *
   * Public because the app shell owns what happens to a session and the HUD
   * owns what the radio says — the shell decides the race is over for this
   * driver and asks for it to be said. `hold` keeps the card up rather than
   * dwelling it away, because a transmission that vanishes leaves a player
   * looking at a corner control with no idea why it appeared.
   *
   * `ruling` overrides the OFFICIAL half only, and exists because "RETIRED" is
   * race language. Qualifying is a Lap Time Classified Session and has no DNF
   * in it — Art. B2.4.3b lists the only three routes out of the classification
   * and an accident is on none of them. What actually happens to that driver is
   * Art. B4.3.2: no further part in the session, every place their lap earned
   * intact. Race control would not word those two the same way, so the caller
   * that knows which session this is supplies the wording. Omitted, the race's
   * own ruling stands and nothing on the race path changes.
   */
  sayRetirement(
    player: CarEntry, reason: string, lap: number,
    ruling?: { text: string; offence: string; status: string },
  ): void {
    // 1. THE PRINCIPAL, FIRST, AS A PERSON. "Are you okay?" — before the cause,
    //    before the classification, before anything. See the `retired` case in
    //    `radioExchange`.
    this.showRadioCard(player, { kind: 'retired', reason, lap });
    // No dwell on this one. The race the driver is no longer in carries on
    // behind it, and the only thing that takes the card away is the player
    // deciding what to do next.
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;

    // 2. RACE CONTROL, SECOND, IN ITS OWN VOICE. The ruling is not the team's
    //    to make and not the team's to word: a retirement is an official fact
    //    about the classification, so it goes on the official strip at the top
    //    of the picture in the same treatment every other ruling gets.
    //
    //    Synthesised here rather than filed by the engine because it is a
    //    PRESENTATION of a fact the engine already recorded — `car.retired` and
    //    `retirementReason` — and filing a second bulletin for it would put the
    //    same event on the log twice.
    this.pushControlCard({
      time: 0,
      text: ruling ? ruling.text : 'CAR ' + player.driver.raceNumber + ' RETIRED',
      severity: 'critical',
      carIndex: player.index,
      feed: 'race-control',
      notice: {
        parties: [player.driver.code],
        where: 'LAP ' + lap,
        offence: ruling ? ruling.offence : 'CAR RETIRED',
        // Not a penalty, so it does not take the segmented decision strip —
        // `isDecision` reads this and correctly says no. It is a note.
        status: ruling ? ruling.status : reason.toUpperCase(),
      },
    }, player);
  }

  /**
   * Puts the HUD into the state of a driver who is out of the race.
   *
   * The timing panel goes: lap time, delta and sector times for a car that is
   * in a barrier are three readouts of nothing, and they are in the top-right
   * corner, which is where the driver is now being asked to make a decision.
   */
  setRetired(v: boolean): void {
    this.root.classList.toggle('is-retired', v);
  }

  /**
   * Hands the exchange to the radio, which types it back one word at a time.
   *
   * "make it more animated like typing/scrolling animation of the text. and
   *  maybe we can get a voice saying what the thing says."
   * "you have to type it out in a typewriter animation as well as say what it
   *  actually says like volume wise."
   *
   * WHY TYPING IS THE RIGHT ANIMATION HERE rather than a fade or a slide: a
   * radio transmission arrives OVER TIME. Somebody is speaking and you are
   * hearing the end of the sentence after the beginning of it, and that is the
   * only thing that separates a transmission from a caption. A card that
   * appears whole is a subtitle.
   *
   * THERE IS NO TIMER IN THIS FUNCTION, AND THAT IS THE WHOLE CHANGE. It used
   * to run a 66 ms `setInterval` at a fixed 45 characters a second and fire the
   * voice once, at `at === 0`, per turn — two clocks, started together and free
   * to drift, with the voice's own clock the one nobody could see. Measured,
   * `speechSynthesis` does not even begin making a sound until about 1.1 s
   * after `onstart`, so the typewriter ran a second and a bit ahead of the
   * words for the whole of the first line. Now the synthesiser reports which
   * characters it has said, in `boundary` events, and `TeamRadio` forwards them
   * as `word`. The reveal cannot drift from the voice because it IS the voice.
   *
   * With the voice switched off — the default — the same events arrive from
   * `TeamRadio`'s estimated clock, which is calibrated against real speech by
   * `scripts/probeRadio.ts`. The card types at the pace the line would be
   * spoken at whether or not anybody is speaking it.
   *
   * `Hud.update` never touches any of this.
   */
  private typeExchange(ex: RadioTurn[]): void {
    const rows = this.radioTurnRows;
    const shown = ex.slice(0, rows.length);
    for (const [i, row] of rows.entries()) {
      const turn = shown[i];
      if (!turn) { setStyle(row, 'display', 'none'); continue; }
      setStyle(row, 'display', 'block');
      setClass(row, 'radio-turn is-' + turn.who);
      row.textContent = '';
    }

    // Somebody who has asked for less motion gets the whole transmission at
    // once. The words are the content; the typing is the atmosphere. The voice
    // still runs — reduced motion is a statement about movement, not about
    // sound — so the exchange is still queued; the rows are simply filled up
    // front and the `word` events land on text that is already there.
    const still = prefersReducedMotion();
    if (still) {
      for (const [i, row] of rows.entries()) {
        const turn = shown[i];
        if (turn) row.textContent = '“' + turn.line + '”';
      }
    }

    // `speakExchange` is what keeps a four-turn conversation together: the
    // turns share a tag and a priority, so a safety car either supersedes the
    // whole exchange or waits for it, and no third party can land in the middle
    // of two people talking.
    // `voiced: false` on the driver's half. The card shows it, the clock paces
    // it, nothing says it — see `RadioSpeakOptions.voiced`, and the player's
    // own reasoning: "you don't need to be saying what the driver says".
    const ids = this.radio.speakExchange(
      shown.map(radioTurnSpec),
      { priority: 0, tag: 'hud-card' },
    );
    this.radioRowOf.clear();
    this.radioPending.clear();
    for (const [i, id] of ids.entries()) {
      this.radioRowOf.set(id, i);
      this.radioPending.add(id);
    }
    this.radioReveal = still ? 'whole' : 'typed';

    // A TURN THE RADIO DECLINED STILL HAS TO READ. `speak` returns null when
    // the tab is hidden, so a card raised in a backgrounded tab would type
    // nothing and then sit there for its whole dwell as four empty rows when
    // the player came back. Anything without a transmission behind it is
    // revealed whole, which is the same backstop `end` provides for a turn that
    // produced no words.
    if (ids.length < shown.length) {
      for (const [i, row] of rows.entries()) {
        const turn = shown[i];
        if (turn && i >= ids.length) row.textContent = '“' + turn.line + '”';
      }
    }
  }

  /** Whether the rows are being typed or were filled up front. */
  private radioReveal: 'typed' | 'whole' = 'typed';

  /**
   * THE CLOCK, arriving.
   *
   * One listener for the whole card. `word` carries the character range the
   * synthesiser has actually uttered, so the reveal is a `slice` of the line at
   * exactly the point the voice has reached; `end` reveals the rest, which is
   * the backstop for the real cases that produce no words at all — a platform
   * with no `boundary` events, or a turn cut off by something more urgent.
   */
  private onRadioEvent(ev: RadioEvent): void {
    const row = this.radioRowOf.get(ev.transmission.id);
    if (row === undefined) return;
    const el = this.radioTurnRows[row];
    if (!el) return;
    const line = ev.transmission.text;

    if (ev.type === 'word' && this.radioReveal === 'typed') {
      const to = Math.min(line.length, ev.charIndex + ev.charLength);
      el.textContent = '“' + line.slice(0, to) + (to < line.length ? '' : '”');
      return;
    }
    if (ev.type === 'end') {
      // Whole line, whatever the words did or did not say.
      el.textContent = '“' + line + '”';
      this.radioPending.delete(ev.transmission.id);
      this.radioRowOf.delete(ev.transmission.id);
      // The last man has stopped talking. Now the card may start counting down.
      if (this.radioPending.size === 0) this.armDwell();
    }
  }

  private hideRadioCard(now = false): void {
    if (!now) { this.radioCard.classList.add('leaving'); return; }
    for (const t of this.radioTimers) window.clearTimeout(t);
    this.radioTimers.length = 0;
    this.radioRowOf.clear();
    this.radioPending.clear();
    this.radio.cancelAll();
    this.question = null;
    this.radioAsking = false;
    this.radioLive = false;
    setStyle(this.radioChoice, 'display', 'none');
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
 * MEASURED, NOT DESIGNED — AND AUTHORED, NOT GENERATED. Every number is the
 * envelope of `mirrorPaneCorners` projected through the real `CameraDirector`
 * on all eleven circuits, in both frame shapes (2.17:1 and 16:9), with the head
 * at rest AND turned to the stops — a driver looking through a corner swings
 * the outside pane most of the way to the frame edge, and a keep-out that
 * ignored that would be clear only on the straights.
 *
 * But the table is WRITTEN DOWN rather than computed at load. `probe:framing`
 * re-measures the geometry every run and fails if a pane escapes the rectangle
 * declared for it; a table derived from the thing it is checking would always
 * agree with it and would check nothing. The rectangle is a contract the layout
 * is built against, and it is supposed to be able to be wrong.
 *
 * IT HAS ALREADY CAUGHT ONE. These numbers were first written against a mirror
 * housing that was lofted widest 30mm in FRONT of the glass and narrowest at
 * it, which left the driver an aperture of 77x37mm. Rebuilt widest and flattest
 * at the glass, the pane went from 74x32mm to 150x46mm — 2.9x the reflective
 * area, and 150mm is the FIA's own minimum reflective width. The panes now read
 * 13 to 19.5 per cent of frame width in the driver's eye against 6 to 9.7
 * before, and the probe failed on fifteen escapes across four circuits until
 * this table was re-measured against the mesh that exists.
 *
 * A one-point margin is added to each measured edge, for the circuits and
 * chassis attitudes that are not in the twelve-sample sweep. The outboard edges
 * of the driver's panes run off the frame entirely at full lock, so they are
 * declared at the frame edge and the probe clamps to it.
 */
export const MIRROR_PANES: Readonly<Record<MirrorView, readonly PaneRect[]>> = {
  // The driver's own eye: the panes are nearest and largest here, a fifth of
  // the frame across, and both reach the frame edge under head turn.
  // Widened once more for banking. `carGroundY` used to ignore it, so the car
  // -- and every camera riding it -- sat at the centreline's height while the
  // asphalt beneath was banked. Correcting that moved the eye, and with it the
  // panes: COTA escaped this table by 2.8 points outboard in the driver's eye
  // and 3.7 in the cockpit. Measured again with the correction in, and widened
  // to enclose it rather than trimmed to admit it -- the rectangle is only
  // worth anything while it is allowed to be wrong, and this is the second time
  // it has been.
  driver: [
    { x0: 0, y0: 69.5, x1: 27.0, y1: 90.5 },
    { x0: 69.0, y0: 68.5, x1: 100, y1: 93.0 },
  ],
  // The roll-hoop pod, 0.2m behind and above the eye: the panes pull inboard
  // and drop down the frame.
  cockpit: [
    { x0: 2.0, y0: 77.5, x1: 37.0, y1: 94.0 },
    { x0: 60.0, y0: 76.5, x1: 93.5, y1: 95.0 },
  ],
  // The T-cam, 0.8m further back again. Small, low and close to the centre.
  'onboard-t': [
    { x0: 22.0, y0: 81.5, x1: 36.5, y1: 90.5 },
    { x0: 64.0, y0: 81.5, x1: 78.5, y1: 91.5 },
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

/**
 * How many bulletins the noticeboard carries at once.
 *
 * Two. The board sits over the road, so a third card is a third of the picture
 * — and two is what race control ever has running in practice: an incident, and
 * the decision that follows it.
 */
const MAX_CONTROL_CARDS = 2;

/** How long a pop-up and a radio card stand before they leave, ms. */
const ALERT_LIFE_MS = 7200;
const RADIO_LIFE_MS = 8000;

/**
 * How many turns of an exchange the in-race card shows.
 *
 * FOUR NOW, AND THAT IS THE WHOLE POINT OF THE CARD BEING SQUARE. It was two,
 * because the card was a letterbox and two short turns was what fitted in it —
 * which meant the card could only ever show the end of an argument, and an
 * exchange whose opening is missing is not an exchange. A driver pushing back
 * and being overruled is four turns; the card is now shaped to carry four.
 */
const RADIO_TURNS_SHOWN = 4;

/**
 * The smallest the radio card may be squeezed to before it is evicted instead.
 *
 * A header, the rule, and two turns of two lines each at the desktop metrics:
 * 22 + 11 + 4 x 13 + 20 of padding is 105, so 104 is the floor and anything
 * under it is a plate with the words cut off, which is not worth the rail it
 * stands on. See `Hud.sizeRadioCard` — above this the card SHRINKS, below it
 * `fitRail` throws it away as it always did.
 */
const RADIO_CARD_MIN_PX = 104;

/**
 * Who each half of an exchange sounds like.
 *
 * The card tells the two apart by COLOUR — the driver in his team's colour, the
 * pit wall in white — and colour does not survive being spoken, so out loud
 * they are told apart by voice, rate and pitch. `TeamRadio.SPEAKERS` owns those
 * three; this is the only thing the HUD has to know about them.
 *
 * There is no typewriter tick constant here any more. The reveal is driven by
 * `RadioEvent.word`, which carries the character range the synthesiser has
 * actually said — see `Hud.typeExchange`.
 */
const SPEAKER_OF: Record<'driver' | 'wall', RadioSpeaker> = {
  driver: 'driver',
  wall: 'engineer',
};

/**
 * One turn of the card, as the radio wants it.
 *
 * Exported and pure so `probe:hudtext` can assert the WIRING rather than the
 * capability. `TeamRadio` supports unvoiced transmissions and `probe:radio`
 * measures that support; neither of them says anything about whether this file
 * actually asks for one. A one-line regression here — `voiced: true`, or the
 * flag dropped in a refactor — would put a synthesised stranger back on the
 * player's own replies and pass both probes.
 */
export function radioTurnSpec(turn: RadioTurn): RadioTurnSpec {
  return {
    speaker: SPEAKER_OF[turn.who],
    text: turn.line,
    // "you don't need to be saying what the driver says ykwim?"
    voiced: turn.who !== 'driver',
  };
}

/**
 * The rail's top fade, in pixels.
 *
 * `.hud-notices` masks its first 28 pixels to transparent so that a stack too
 * tall for its band reads as "there is more above this" instead of as a card
 * sheared off by an invisible edge. Anything allocated into it is read three
 * quarters of, so it is not room and nothing may be sized into it.
 */
const RAIL_MASK_PX = 28;

/**
 * Slack subtracted from the rail's band before it is divided into cards.
 *
 * The gaps between the rail's children plus the top of the mask.
 */
const RAIL_GAPS_PX = RAIL_MASK_PX + 8;

/**
 * The shortest a pop-up is ever laid out at, in pixels.
 *
 * Measured off the compact form: on a landscape phone the card is a name and
 * two clamped lines with no portrait, and it comes out at 55. Anything shorter
 * than this is not a card that fits, it is a card that is about to be clipped.
 */
const MIN_CARD_PX = 58;

/**
 * Rows the running order keeps while a stop is being chosen.
 *
 * The pit sheet is a decision with a deadline measured in corners and it lives
 * in the same column as the tower. Eight rows is the leader, the fight and the
 * player, which is what a driver deciding on a tyre actually needs to see.
 */
const PIT_OPEN_ROWS = 8;

/** Whether the player has asked the system for less movement. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ===========================================================================
// THE ANSWER
// ===========================================================================

/**
 * A question the driver can answer, in the only terms the HUD understands.
 *
 * DELIBERATELY IGNORANT. There is no tyre, no compound decision and no strategy
 * in this shape — an id, some words, two labels, a clock and a function that
 * takes a boolean. The HUD draws it and hands back yes or no; what that means
 * is entirely the business of whoever supplied it.
 *
 * That is what makes the affordance general rather than a pit-stop feature with
 * buttons on it. `engine.pitWall` is the first source; the stewards' cede-the-
 * position remedy is the obvious second, and adding it means writing one more
 * branch in `radioQuestion` and nothing at all in the card.
 */
export interface RadioQuestion {
  /** The owning system's own id. Answering a stale one must be safe. */
  id: number;
  /** What the wall said, before the question. */
  message: string;
  /** Why, in one line. */
  reason: string;
  /** The question itself. */
  ask: string;
  yesLabel: string;
  noLabel: string;
  /** Named in the reply, when the answer involves one. */
  compound: string;
  /** Seconds left on the offer. */
  expiresInS: number;
  /** The offer's full window, so the clock can be drawn as a fraction. */
  windowS: number;
  /** Answers it. The return value is the truth; the button press is not. */
  answer(yes: boolean): 'yes' | 'no' | 'lapsed';
}

/**
 * The question currently outstanding, from whichever system has one.
 *
 * The whole of the coupling between the HUD's answer affordance and the
 * simulation, in one function. Pure of the DOM, so a probe can assert that a
 * pit wall with a question outstanding produces a question with the same id.
 */
export function radioQuestion(engine: RaceEngine): RadioQuestion | null {
  const wall = engine.pitWall;
  if (!wall || !wall.awaitingAnswer) return null;
  const call = wall.pending;
  if (!call || call.question === null) return null;
  const compound = call.compound ? getCompound(call.compound).name : '';
  return {
    id: call.id,
    message: call.message,
    reason: call.reason,
    ask: call.question,
    // The labels say what will HAPPEN, not "yes" and "no": a driver reading a
    // card in peripheral vision at 300km/h should not have to reconstruct which
    // way round the question was phrased.
    yesLabel: call.action === 'box' ? 'BOX' : 'STAY OUT',
    noLabel: call.action === 'box' ? 'STAY OUT' : 'BOX',
    compound,
    expiresInS: call.expiresInS,
    windowS: PIT_OFFER_WINDOW_S,
    // Routed through the engine rather than straight to the wall so the answer
    // and the reply land on the same log the question came from. See
    // `RaceEngine.answerPitWall`.
    answer: (yes: boolean) => engine.answerPitWall(call.id, yes),
  };
}

/**
 * The offer window, for drawing the clock as a fraction of itself.
 *
 * Duplicated from `PitWall.OFFER_WINDOW_S` rather than exported from it,
 * because it is used here only to scale a bar: being a couple of seconds out
 * makes the drain very slightly wrong and nothing else. Exporting a strategy
 * constant so a progress bar can divide by it would be the worse trade.
 */
const PIT_OFFER_WINDOW_S = 55;

/**
 * Where the incident that caused a neutralisation is.
 *
 * The driver asks "what is it?" and the honest answer names a place. Race
 * control's own log is where that lives — the yellow was raised with the corner
 * in it — so this reads the most recent bulletin backwards rather than
 * inventing a location the simulation does not have.
 */
function incidentPlace(engine: RaceEngine): string {
  const msgs = engine.raceControl.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const where = msgs[i].notice?.where;
    if (where) return where.toLowerCase();
  }
  return 'the far side of the circuit';
}

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
  // 22 rather than 26 on a desktop. Four pixels a row is three more cars, and
  // a broadcast tower row is tighter than this one was.
  const rowH = compact ? 17 : 20;
  // The panel's own header block and column rule, PLUS the whole rail beneath
  // it: the notice stack, the weather bug and the car state. This number is
  // the reason the tower is not simply "as many rows as fit" — the rest of
  // the left rail has to exist somewhere, and a tower sized to the viewport
  // grows straight down through the pit instruction.
  //
  // IT CAME DOWN BY A HUNDRED AND EIGHTY PIXELS, from two changes in the same
  // pass. The rail used to reserve room for a stack of up to two principal's
  // cards ON TOP OF the broadcast plate, and now carries exactly one card,
  // because two people cannot transmit on one radio at once. And the tyre,
  // fuel and weather panels have moved out of this column entirely, into the
  // CAR column on the right where they belong — see `.hud-carstate`. Both are
  // pixels handed straight back to the running order, which is what pays for
  // "why can I only see like 4 cars on the leaderboard".
  // The compact figure is unchanged: on a phone the tyre and weather panels are
  // repositioned by their own media queries rather than by this column, so
  // moving them on a desktop bought the phone nothing.
  const reserved = compact ? 260 : 500;
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
  // THE CEILINGS WENT UP because the reported fault was the ceiling.
  //
  //   "why can I only see like 4 cars on the leaderboard, where is everyone
  //    and all the cars?"
  //
  // Twenty on a desktop is the whole field, so a full-height screen now
  // windows nothing at all — which is the only arrangement that cannot hide
  // the fight. Twelve on a phone is half again what it was.
  return {
    rows: Math.max(min, Math.min(fits, compact ? 12 : 20)),
    compact,
  };
}

/**
 * Which cars the tower draws, when it cannot draw all of them.
 *
 * THE REPORTED FAULT, and it is worth being exact about it because the
 * behaviour it replaces is defensible in principle and failed completely in
 * practice. The window centred itself on the player and pinned the leader
 * above it. Running eighteenth of twenty in eight rows, that produced P1, a
 * dashed break, and P14 to P20 — and in the screenshot it was reported from,
 * six of those seven were marked `Out`. The player could see the leader, five
 * retirements and one moving car.
 *
 * Two things are wrong there and only one of them is the row count.
 *
 * A RETIRED CAR IS NOT PART OF THE FIGHT. It holds its classified position and
 * belongs on a results screen, but it cannot be raced, caught or lost to, and
 * spending a scarce row on it to tell the driver something that will still be
 * true in twenty laps is the worst trade this panel can make. So when the
 * window is short, retirements are the first thing dropped from it.
 *
 * AND THE FIGHT IS AHEAD. Centring the window puts as many rows behind the
 * player as in front, which is even-handed and wrong: the cars a driver can do
 * something about are the ones they are catching. The player now sits two
 * thirds of the way down their own window, so most of what they can see is
 * road they might make up.
 *
 * Pure and exported so `probe:hudtext` can put a player at the back of a field
 * of wrecks and assert what they are shown.
 */
export function towerWindow(
  standings: readonly { retired: boolean }[], shown: number, playerIdx: number,
): { rows: number[]; pinLeader: boolean } {
  const n = standings.length;
  if (shown >= n) {
    return { rows: Array.from({ length: n }, (_, i) => i), pinLeader: false };
  }
  if (shown <= 0) return { rows: [], pinLeader: false };

  // The cars worth a row: everybody still running, plus the player, who keeps
  // theirs whatever has happened to them.
  const live: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!standings[i].retired || i === playerIdx) live.push(i);
  }
  // If dropping the retirements is not enough to fit, or there is nobody
  // running at all, fall back to the whole order — a short tower of wrecks is
  // still better than an empty one.
  const pool = live.length >= Math.min(shown, 2) ? live : Array.from({ length: n }, (_, i) => i);

  const at = Math.max(0, pool.indexOf(playerIdx));
  if (pool.length <= shown) return { rows: pool, pinLeader: false };

  // The player two thirds down, so most of the window is the road ahead.
  const behind = Math.max(1, Math.round(shown / 3));
  let from = Math.max(0, Math.min(at - (shown - behind), pool.length - shown));
  // The leader is pinned whenever the window has scrolled off them, because
  // "who is winning" is the one question this panel must always answer.
  const pinLeader = from > 0;
  if (pinLeader) {
    const rest = shown - 1;
    from = Math.max(1, Math.min(at - (rest - behind), pool.length - rest));
    return { rows: [pool[0], ...pool.slice(from, from + rest)], pinLeader: true };
  }
  return { rows: pool.slice(from, from + shown), pinLeader: false };
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
  // THE RULE COMES FROM `liveGapCell` AND IS NOT REIMPLEMENTED HERE. It carries
  // the distinction between a race and a Lap Time Classified Session — there is
  // no leader in qualifying, only a fastest lap and everybody's deficit to it —
  // and it cites the articles for both. The tower had its own copy of that
  // arithmetic and the two disagreed, which is how `LEADER` came to be printed
  // during a qualifying session.
  //
  // What is left here is PRESENTATION, and it is two words. `Interval` because
  // the leader's cell names the column rather than restating a position the
  // number beside it already gives — every other row in that column is a
  // figure, so a word there reads as the heading it is. `Out` because the row
  // is already dimmed and already at the foot of the order, and three capitals
  // of jargon on top of that is the panel saying the same thing three times.
  const ruled = liveGapCell(car, ahead, leader, engine.config.kind === 'race');
  const gap = ruled === 'LEADER' ? 'Interval'
    : ruled === 'DNF' || ruled === 'OUT' ? 'Out'
    : ruled;

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
 * THIS USED TO BE A TABLE HERE, AND THE TABLE WAS ISSUE #18. It was keyed on
 * the ids of the ten INVENTED teams the game shipped with — `apex`,
 * `scuderia-rosso`, `meridian`. Career mode then replaces the grid with the real
 * 2026 roster, whose ids are `mclaren`, `ferrari`, `red-bull`, so every lookup a
 * career player could ever make missed, fell through to the default, and named
 * their principal the literal string **"Pit wall"** — behind the one shared
 * silhouette `principalSvg` draws. Two teams, ten teams, forty-two teams: the
 * same person every time. The player was not imagining it.
 *
 * The cast now lives in `people/Cast.ts`, which holds a principal for every team
 * in every tier INCLUDING those same ten legacy ids (Marco Vidal and the rest
 * are still there, unchanged, so an old save does not lose its principal), and
 * which never returns a shared fallback — an id it has never seen still produces
 * a specific named person off the generator. There is no "Pit wall" string left
 * in the codebase to fall through to.
 */
export { principalNameOf as principalOf } from './people/Cast';

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

// ===========================================================================
// THE GATE
// ===========================================================================

/**
 * What the driver is actually doing, at the moment something wants to be said.
 *
 *   "make sure that the radio messages that are happening are reasonable and
 *    intelligent. like if you crashed the fucking car you're not the one asking
 *    about VSC and your principal isn't saying maintain the delta, that's
 *    fucking retarded."
 *
 * THE FAULT WAS STRUCTURAL AND IT IS WORTH NAMING PRECISELY. Every message in
 * this HUD was selected from a WORLD EVENT — a virtual safety car was deployed,
 * so play the virtual safety car exchange — with no reference at all to the
 * state of the car it was being sent to. The event was true. The message was
 * addressed to somebody who was not in a position to receive it.
 *
 * That is a whole class of fault rather than two bad lines, and it produces the
 * same absurdity every time the player's race diverges from the world's: a
 * driver in a barrier being asked for a delta; a pit wall watching its own car
 * burn and answering with the minimum sector time; a strategy question with two
 * buttons on it put to somebody who can no longer press either.
 *
 * So nothing is said without a precondition on THIS car. And a message whose
 * precondition fails is DROPPED, not queued — there is no correct later moment
 * to tell a retired driver about the delta, and a radio that catches up on what
 * it could not say is worse than one that missed it.
 */
export interface DriverState {
  /** On the circuit, in the session, able to act on an instruction. */
  running: boolean;
  /** The car is out. Nothing about the race is addressed to them again. */
  retired: boolean;
  /** In the pit lane or the box — most instructions do not apply. */
  inPitLane: boolean;
  /** Something is broken enough to change what is worth saying. */
  damaged: boolean;
  /** The chequered flag has been shown. */
  sessionOver: boolean;
}

/** Reads the state off the car, so nothing else has to know how. */
export function driverState(engine: RaceEngine, car: CarEntry): DriverState {
  const over = engine.raceControl.sessionFlag === 'chequered' || car.finished;
  return {
    retired: car.retired,
    inPitLane: car.inPitLane,
    damaged: car.damage.worst().health < 0.7,
    sessionOver: over,
    running: !car.retired && !car.inPitLane && !over,
  };
}

/**
 * When each kind of transmission is worth sending.
 *
 * A `Record` KEYED ON THE UNION rather than a switch with a default, and that
 * is the load-bearing decision in this file: TypeScript will not compile a new
 * `RadioMoment` kind until somebody has written down when it is valid. The
 * point of the exercise is not to fix the two lines that were reported, it is
 * to make the next line impossible to add without answering the question.
 */
const MOMENT_VALID: Readonly<Record<RadioMoment['kind'], (s: DriverState) => boolean>> = {
  // Strategy, neutralisations and the delta are all instructions about a race
  // the driver is still in. Every one of them is nonsense to a car in a
  // barrier, and the delta is nonsense to a car in the pit lane as well —
  // Art. 55.7 and 56.5 apply on the circuit.
  pit: (s) => s.running,
  'safety-car': (s) => !s.retired && !s.sessionOver,
  vsc: (s) => !s.retired && !s.sessionOver,
  delta: (s) => s.running,
  'neutral-ending': (s) => !s.retired && !s.sessionOver,
  // The question with buttons on it. Hardest gate of the lot, because a
  // question put to somebody who cannot act on it is worse than silence: they
  // are being asked to make a decision the game will then ignore.
  call: (s) => s.running,
  // The flag is addressed to whoever took it. A driver who retired on lap
  // four did not take it and is not being congratulated on a finish.
  chequered: (s) => !s.retired,
  damage: (s) => !s.retired,
  // The only one that is valid PRECISELY BECAUSE the car is gone.
  retired: (s) => s.retired,
};

/** Whether this moment should reach the driver at all. */
export function momentAllowed(m: RadioMoment, s: DriverState): boolean {
  return MOMENT_VALID[m.kind](s);
}

/**
 * The same gate for the pit wall's single-sentence traffic.
 *
 * Keyed on the union for the same reason. The split is mostly one question:
 * does this line ask the driver to DO something? A retired driver can be told
 * their team-mate is out, because that is news about the team; they cannot be
 * told to look after their tyres.
 */
const NOTE_VALID: Readonly<Record<TeamNote['kind'], (s: DriverState) => boolean>> = {
  // What happened to a car. Still true, and still worth hearing, whoever it
  // happened to — including a driver who has just retired hearing about it.
  off: () => true,
  damage: () => true,
  retired: () => true,
  failure: () => true,
  stranded: () => true,
  recovered: () => true,
  stop: (s) => !s.retired,
  'penalty-served': (s) => !s.retired,
  // Pit-lane procedure, addressed to a car on its way in.
  'pit-closed': (s) => !s.retired,
  'pit-missed': (s) => !s.retired,
  'pit-fast': (s) => !s.retired,
  // The pit wall's own traffic: all of it is about a race in progress, and
  // none of it survives the car stopping.
  gap: (s) => s.running,
  tyres: (s) => s.running,
  weather: (s) => !s.retired && !s.sessionOver,
  position: (s) => !s.retired,
  fuel: (s) => s.running,
  call: (s) => s.running,
  reply: (s) => !s.retired,
  // A penalty outlives the car it was given to — it is charged at the flag
  // (Art. B1.9.5b) and changes the classification — so a retired driver is
  // still told. The place to hand back is not: there is nobody to hand it to.
  penalty: () => true,
  cede: (s) => s.running,
};

export function noteAllowed(n: TeamNote, s: DriverState): boolean {
  return NOTE_VALID[n.kind](s);
}

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
export function raceControlCard(
  m: RaceControlMessage, numbers?: ReadonlyMap<string, number>,
): {
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
    // THE OFFICIAL WORDING, which names a car by its NUMBER with the code in
    // brackets: `TURN 8 INCIDENT INVOLVING CARS 44 (HAM) AND 1 (VER)`. Race
    // control does not identify a driver by their surname — the entry list is
    // numbers, and the number is what is on the car. The bracketed code is the
    // broadcast's own concession to people who have not learnt twenty numbers.
    //
    // Falls back to the bare codes when the caller has no number table, which
    // is what every existing test and the panel harness pass.
    headline: officialParties(n, numbers),
    detail: [n.where, n.offence, n.status].filter((s) => s.length > 0).join(' · '),
    tone,
    penalty: isDecision(n.status) ? twoLines(n.status) : [],
  };
}

/**
 * How race control names the cars in a notice.
 *
 * `INCIDENT INVOLVING CARS 44 (HAM) AND 1 (VER)` where the place is known and
 * there is more than one party, `CAR 44 (HAM)` where there is one, and the bare
 * codes where the field is not available to resolve numbers from.
 */
function officialParties(
  n: RaceNotice, numbers?: ReadonlyMap<string, number>,
): string {
  const named = n.parties.map((code) => {
    const no = numbers?.get(code);
    return no === undefined ? code : no + ' (' + code + ')';
  });
  if (!numbers) return n.parties.join(', ') + ' INCIDENT';
  const cars = named.length === 1
    ? 'CAR ' + named[0]
    : 'CARS ' + named.slice(0, -1).join(', ') + ' AND ' + named[named.length - 1];
  // The place leads when there is one, exactly as the wide broadcast variant
  // sets it: `TURN 8 INCIDENT INVOLVING CARS …`.
  return (n.where ? n.where + ' ' : '') + 'INCIDENT INVOLVING ' + cars;
}

/** A status that has changed the result, as opposed to one that is a note. */
function isDecision(status: string): boolean {
  // GIVE THE POSITION BACK is a decision even though it is not a penalty.
  //
  // It is the stewards' remedy under Art. B1.8.6 — the driver hands the place
  // back and the matter ends, and if they do not it becomes five seconds. So it
  // is the single most consequential thing race control can say to a driver
  // mid-race, and without it here the banner never raised for it: the notice
  // appeared as an ordinary line and the player had no reason to read it as an
  // instruction they had a deadline to obey.
  return /PENALTY|DISQUALIFIED|DELETED|BLACK AND WHITE|GIVE THE POSITION BACK/.test(status);
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
  /**
   * The player's own given name.
   *
   * Because a principal uses it, and because the game HAS it — the career's
   * creation screen asks for it and carries it all the way to `driver.firstName`
   * on the car. A pit wall that has been given a driver's name and addresses
   * them as nobody is a pit wall that reads as a rules engine.
   */
  firstName: string;
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
 * and, later, pointing at a virtual safety car exchange that read
 * `"VSC? GIVE ME THE DELTA." / "HOLD THE MINIMUM IN EVERY SECTOR."`:
 *
 * "whats this bullshit of holding the minimum every sector. make the radios
 *  legit and smart, think of it like a genuine interaction."
 *
 * BOTH COMPLAINTS ARE THE SAME COMPLAINT AND IT IS WORTH BEING PRECISE ABOUT
 * WHY, because "hold the minimum in every sector" is not wrong. It is exactly
 * what Art. 56.5 requires. It is a rule restatement, and a rule restatement is
 * the one category of true statement that is guaranteed to be worthless on a
 * radio: the driver is already obeying the rule, so it is the thing they most
 * certainly know. What they cannot see is their own number against it. Real
 * neutralisation radio is "delta positive", "you're plus one-two, that's good",
 * "you're negative, lift" — the same subject, the half the driver does not have.
 *
 * So there is one rule here and every line in this file is written against it:
 *
 *   SAY THE THING THE DRIVER DOES NOT ALREADY KNOW.
 *
 * Which rules out, permanently: restating a regulation they are obeying;
 * narrating a number that is on their own dashboard; and describing what just
 * happened to them, because they were there. What is left is measurement,
 * consequence and decision — and those are what a real engineer's radio is
 * almost entirely made of.
 *
 * Three things follow from it.
 *
 * BE SPECIFIC WITH THE GAME'S OWN STATE. A line naming a number is a person; a
 * line naming a category is a status string. The simulation knows the gap, the
 * rate it is closing at, the lap the rain lands on, the laps left in the tyre,
 * the deadline on a handed-back place — so every one of those appears as a
 * figure and never as "significant" or "critical".
 *
 * PEOPLE UNDER PRESSURE ARE TERSE. Most of these are one clause and a decision.
 * Nothing here is a paragraph, because it is being read by somebody at 300km/h
 * and, since `Hud` now speaks the line aloud, heard by somebody at 300km/h.
 * Anything that would be absurd read out loud is the wrong line.
 *
 * FIT THE MOMENT. A neutralisation is procedural. A wing failure is urgent.
 * Losing a place to your own team-mate is political, and cannot be said in the
 * words used for losing one to a stranger.
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

    // =======================================================================
    // The pit wall's own traffic
    // =======================================================================
    //
    // Everything above is an accident report. Everything below is the ordinary
    // run of a race, and it is the half that was missing — which is why the
    // team channel could go a whole twenty-minute race without speaking, and
    // why a channel that only carries accidents cannot be made to go two ways.

    case 'gap': {
      // THE RATE, NOT THE GAP. A gap is in the mirror. A gap closing at two
      // tenths a lap is three laps of arithmetic, and it is the number that
      // decides whether the driver has to do anything about it.
      const rate = Math.abs(note.perLapS).toFixed(1);
      const laps = Math.max(1, Math.ceil(note.gapS / Math.max(Math.abs(note.perLapS), 0.01)));
      if (note.behind) {
        return {
          line: name(ctx) + ', ' + note.who + ' is ' + note.gapS.toFixed(1) +
            ' behind and taking ' + rate + ' a lap out of you. He is on you in ' + laps + '.',
          tone: 'warn',
        };
      }
      return {
        line: 'You are ' + note.gapS.toFixed(1) + ' off ' + note.who + ' and closing ' +
          rate + ' a lap. That is him in ' + laps + ' laps if you hold this.',
        tone: 'go',
      };
    }

    case 'penalty':
      // The user's own example, almost to the word: "you have received a 5
      // second penalty, Bob, for track limits — we will serve that at the next
      // pit". Race control has already said WHAT it is on its own feed; the
      // half the team owns is what the team is going to do about it.
      return note.whenServed === 'now'
        ? {
          line: 'Drive-through for you, ' + name(ctx) + ', ' + note.offence.toLowerCase() +
            '. You have 3 laps to take it and we are taking it now.',
          tone: 'urgent',
        }
        : {
          line: note.seconds + ' second penalty, ' + name(ctx) + ', ' +
            note.offence.toLowerCase() + '. We serve it ' + note.whenServed + '.',
          tone: 'urgent',
        };

    case 'cede':
      // The deadline is the whole content. That a place has to go back is on
      // the official banner; how long there is to do it is not anywhere.
      return {
        line: 'Give the place back to ' + note.who + '. You have ' + note.withinS +
          ' seconds before they make it five.',
        tone: 'urgent',
      };

    case 'weather':
      // "predicted to rain at lap 3-7, change of strategy, box for inters" —
      // the driver can see the sky. What they cannot see is the radar mapped
      // onto their own lap counter, or what the team has decided to do with it.
      return note.wet
        ? {
          line: 'Rain on the radar, laps ' + note.fromLap + ' to ' + note.toLap +
            ', about ' + note.minutes + ' minutes out. We are going to ' + note.plan +
            (note.confidence < 0.7 ? ' — not certain on it yet.' : '. Stay out until we call it.'),
          tone: 'warn',
        }
        : {
          line: 'It dries from lap ' + note.fromLap + '. ' + note.minutes +
            ' minutes and we put you on ' + note.plan + '. Nurse what you have until then.',
          tone: 'info',
        };

    case 'call':
      // The strategist's own words, which already carry their reasoning. The
      // question, if there is one, is asked by the card rather than said here —
      // a line that ends in a question the pop-up cannot answer is worse than
      // no line, and this pop-up cannot answer anything.
      return {
        line: note.message + ' ' + note.reason,
        tone: note.urgent ? 'urgent' : 'info',
      };

    case 'reply':
      // "the driver could be like 'no stay out' and they be like 'copy, box
      // next lap'." The wall does not sulk and it does not go silent — that is
      // the case that reads as a bug rather than as a decision.
      return note.outcome === 'yes'
        ? {
          line: 'Copy that. Box this lap, ' + (note.compound || 'same tyre') + ' on the left.',
          tone: 'go',
        }
        : note.outcome === 'no'
          ? { line: 'Copy, box next lap. We will hold the crew.', tone: 'info' }
          : { line: 'No answer, so we leave it. Coming back to you next lap.', tone: 'info' };

    case 'tyres': {
      // The wear bar is on the driver's own screen. How many laps are in it,
      // and what each of those laps costs, is not — both come off a wear rate
      // the car never displays.
      const drop = note.dropOffS.toFixed(1);
      return note.lapsLeft <= 2
        ? {
          line: 'The ' + note.axle + 's are done — ' + drop +
            ' a lap and nothing left. Window is now.',
          tone: 'urgent',
        }
        : {
          line: 'About ' + note.lapsLeft + ' good laps in the ' + note.axle +
            's, costing ' + drop + ' a lap. Start thinking about it.',
          tone: 'warn',
        };
    }

    case 'position':
      // Losing a place to a stranger is racing. Losing it to the car the same
      // people built is politics, and the two cannot be said in the same words.
      if (note.teammate) {
        return note.gained
          ? {
            line: 'That is ' + note.who + ' done, and it stays clean. P' +
              note.position + '. Nothing more said about it.',
            tone: 'go',
          }
          : {
            line: note.who + ' is past and that puts you P' + note.position +
              '. I know, ' + name(ctx) + '. No team orders this early — take it back.',
            tone: 'warn',
          };
      }
      return note.gained
        ? {
          line: 'P' + note.position + '. ' + note.who +
            ' is behind you now — get out of his range before the straight.',
          tone: 'go',
        }
        : {
          line: 'That is ' + note.who + ' through. P' + note.position +
            '. Stay in his mirrors, we get it back at the stop.',
          tone: 'warn',
        };

    case 'fuel':
      // A margin the fuel readout does not carry: litres are on the dash, laps
      // are not, and laps are what the driver has to act on.
      return {
        line: 'You are ' + Math.abs(note.marginLaps).toFixed(1) +
          ' laps short on fuel. Lift and coast into the slow corners from here.',
        tone: 'warn',
      };
  }
}

/**
 * The driver's given name, or a form of address that works without one.
 *
 * A career driver always has one; a quick race off the fictional roster does
 * too. The fallback exists because a save from before the creation screen
 * carried a name would otherwise produce `", Sainz is 1.8 behind"`.
 */
function name(ctx: TeamContext): string {
  return ctx.firstName || 'mate';
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
  /** A safety car, with what it has just cost the driver in seconds. */
  | { kind: 'safety-car'; position: number; lostS: number }
  /** A VSC, with the cause the driver could not see and where it happened. */
  | { kind: 'vsc'; position: number; where: string }
  /**
   * The driver's own standing against the delta.
   *
   * SEPARATE FROM THE DEPLOYMENT ON PURPOSE, and this split is the fix for the
   * line the whole pass was reported over. At the moment a neutralisation is
   * called the driver has no number yet, so there is nothing to say about one;
   * a card that speaks then can only restate the rule, which is what
   * `"HOLD THE MINIMUM IN EVERY SECTOR"` was. The number exists a sector later,
   * and that is when it is worth a transmission.
   */
  | { kind: 'delta'; marginS: number; breaches: number }
  /**
   * A neutralisation ending, in the phase the regulations define for it.
   *
   * See `RaceControlManager.endingPhase` for the articles. The driver knows a
   * neutralisation is running; what they cannot see from the cockpit is which
   * step of the ending procedure it has reached, and every step changes what
   * they are required to do.
   */
  | {
    kind: 'neutral-ending';
    phase: 'vsc-ending' | 'unlapping' | 'sc-in' | 'hold-line';
    mustUnlap: boolean;
  }
  | { kind: 'chequered'; position: number }
  | { kind: 'damage'; part: string }
  /**
   * The driver's race being over, said by the principal rather than by a modal.
   *
   *   "why do we still have this thing, I thought we talked about, remove the
   *    retired. its just a radio message about you having to retire and then
   *    top right continue or watch the race."
   *
   * Third time of asking. A full-screen `RETIRED` panel with a damage breakdown
   * on it is the game stopping to file a report about something the player has
   * just watched happen, and it lands about two seconds after the accident —
   * which is the moment they most want to be looking at their own car in the
   * barrier. The information is not wrong; it is being volunteered instead of
   * offered. So the wall says it, and the stats wait to be asked for.
   */
  | { kind: 'retired'; reason: string; lap: number }
  /**
   * The strategist, asking something with an answer attached.
   *
   * The only moment in the game where the card carries buttons. The turns are
   * the wall's half; the driver's half is the button they press, and what the
   * wall says back to it comes from `replyExchange`.
   */
  | {
    kind: 'call';
    message: string; reason: string; question: string; compound: string;
    callId: number;
  };

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

/**
 * ===========================================================================
 * WHY THE RADIO KEPT SAYING THE SAME THING
 * ===========================================================================
 *
 *   "also the radio messages have to vary why is it always the same message?"
 *   "Also still seems like you have the same statement when something happens,
 *    we need to vary it up, like once you gotta ask if they okay or maybe
 *    another time, u say like better luck next time, or like im sorry we'll
 *    have to retrire the car here."
 *
 * THE CAUSE WAS NOT A SEEDED RANDOM RETURNING THE SAME INDEX, and it was not
 * one message crowding the queue. It was simpler and worse than either: THERE
 * WAS NO SELECTION AT ALL. `radioExchange` was a switch in which every branch
 * returned one hard-coded array — a search for `Math.random`, a seed or an
 * index anywhere in it returned nothing — so the pool for each situation was
 * of size one and there was nothing to choose between. Every retirement in the
 * game's history said "Are you okay? Talk to me.", because that was the only
 * thing it could say.
 *
 * That is why BOTH halves are fixed here and neither alone would have looked
 * fixed: `pickExchange` is the selection, and the arrays below are the pool.
 *
 * THE VARIANTS ARE DIFFERENT REGISTERS, NOT SYNONYMS. The player's three
 * examples for a retirement are concern, consolation and the call itself made
 * apologetically — three different things a person might say, not three ways
 * of phrasing one. A pool of paraphrases would read as a thesaurus and would
 * have been the wrong fix.
 */

/**
 * Which variant each situation is on. Keyed by situation, not by moment.
 *
 * ROTATES RATHER THAN RANDOMISES, because random repeats. Three variants
 * chosen uniformly give the same line twice in a row one time in three, which
 * is exactly the complaint, and a player who hears it twice concludes there is
 * one line whatever the pool actually holds. Cycling guarantees a run of N
 * before anything comes round again.
 */
const variantCursor = new Map<string, number>();

/**
 * Where each situation's cycle starts, so two sessions do not open identically.
 *
 * Random once per page load rather than per pick: within a session the rotation
 * is what stops repeats, and between sessions this is what stops the game
 * always greeting a new player with the same first line.
 */
let variantSeed = Math.floor(Math.random() * 0x7fffffff);

/**
 * Fixes the rotation, for a harness that needs the same words twice.
 *
 * Exported for probes and screenshot sweeps. Nothing in `src/` calls it: a
 * game with a deterministic radio is the bug this whole section is about.
 */
export function setRadioVariantSeed(n: number): void {
  variantSeed = n >>> 0;
  variantCursor.clear();
}

/** How many authored variants a situation has. For the probe. */
export function radioVariantCount(key: string): number {
  return VARIANT_COUNTS[key] ?? 0;
}

/** The next variant for `key`, never the one before it. */
function pickExchange(key: string, options: readonly RadioTurn[][]): RadioTurn[] {
  VARIANT_COUNTS[key] = options.length;
  if (options.length <= 1) return options[0] ?? [];
  const prev = variantCursor.get(key);
  const next = prev === undefined
    ? variantSeed % options.length
    : (prev + 1) % options.length;
  variantCursor.set(key, next);
  return options[next];
}

/** Filled in as situations are reached, so the probe can count the pool. */
const VARIANT_COUNTS: Record<string, number> = {};

const wall = (line: string): RadioTurn => ({ who: 'wall', line });
const drv = (line: string): RadioTurn => ({ who: 'driver', line });

export function radioExchange(m: RadioMoment): RadioTurn[] {
  switch (m.kind) {
    case 'pit': {
      // The wall's closing line is the same in every case because it is the
      // only instruction: box, and this is what is going on. What changes is
      // what the driver says first, and it may only claim what is true.
      //
      // EVERY VARIANT ALTERNATES AND ENDS ON `box`. That is not a stylistic
      // choice: the card draws the driver in his team's colour and the wall in
      // white and labels neither, so two turns from the same speaker in a row
      // read as one line that wrapped. `probe:hudtext` fails on it, and it now
      // fails on it for every variant rather than for whichever one the
      // rotation happened to be on.
      const box = wall('Box box. ' + m.compound + ' on the left.');
      const laps = m.lapsLeft > 0 ? 'And box, ' + m.lapsLeft + ' laps.' : 'And box, box.';
      const toGo = m.lapsLeft > 0 ? m.lapsLeft + ' laps to go.' : 'These are the last laps.';
      switch (m.reason) {
        case 'tyres':
          return pickExchange('pit:tyres', [
            [
              drv('These rears are going away. How many more?'),
              wall(laps),
              drv('I can hold on a bit longer.'),
              box,
            ],
            [
              drv('I can feel the rears going on entry.'),
              wall('They are done — it is costing you four tenths a lap. ' + laps),
              drv('Understood.'),
              box,
            ],
            [
              drv('I have got nothing left out of the slow corners.'),
              wall('That is the rears. We have to take new ones. ' + laps),
              drv('Right. Your call.'),
              box,
            ],
          ]);
        case 'damage':
          return pickExchange('pit:damage', [
            [
              drv('Something is not right with the car.'),
              wall('We can see it. Box this lap and we fix it. ' + laps),
              drv('How much is that going to cost me?'),
              box,
            ],
            [
              drv('It is driveable, but it moves around under braking.'),
              wall('We see the damage on the data. It will not last. ' + laps),
              drv('Your call.'),
              box,
            ],
            [
              drv('Did I pick something up back there?'),
              wall('You did, and it is not going to hold together. ' + laps),
              drv('Right. Coming in.'),
              box,
            ],
          ]);
        case 'weather':
          return pickExchange('pit:weather', [
            [
              drv('I am on the wrong tyre out here.'),
              wall('Agreed. Box box, we are changing you over. ' + laps),
              drv('Is anyone else coming in?'),
              box,
            ],
            [
              drv('I have no grip anywhere on this tyre.'),
              wall('Conditions have moved past it. Changing you over. ' + laps),
              drv('About time.'),
              box,
            ],
            [
              drv('It is getting worse every lap out here.'),
              wall('We can see it on the radar. The crossover is now. ' + laps),
              drv('Copy.'),
              box,
            ],
          ]);
        case 'penalty':
          return pickExchange('pit:penalty', [
            [
              drv('What is the penalty for?'),
              wall('We argue about it later. Serve it this lap. ' + laps),
              drv('That is not on me.'),
              box,
            ],
            [
              drv('Are we appealing this?'),
              wall('After the flag. Right now we serve it with the stop. ' + laps),
              drv('Understood. Not happy about it.'),
              box,
            ],
            [
              drv('Do I have to take it now?'),
              wall('Stewards have confirmed it. Serve it and we move on. ' + laps),
              drv('Copy.'),
              box,
            ],
          ]);
        case 'strategy':
          return pickExchange('pit:strategy', [
            [
              drv('My tyres are okay — can I extend? How many laps left?'),
              wall(laps),
              drv("I don't wanna stop."),
              box,
            ],
            [
              drv('How are we looking on strategy?'),
              wall('This is our window, and ' + toGo + ' ' + laps),
              drv('I am quick on these.'),
              box,
            ],
            [
              drv('Do I have to come in now?'),
              wall('Miss this and we come out in traffic. ' + laps),
              drv('Then let us take it.'),
              box,
            ],
          ]);
      }
    }
    // A NEUTRALISATION IS PROCEDURAL, so the exchange is short and it is about
    // the two things the driver in the car genuinely does not have: what caused
    // it, and what it has done to their race.
    case 'safety-car': {
      const cost = m.lostS >= 0.5
        ? 'Your ' + m.lostS.toFixed(1) + ' seconds is gone — everybody is together.'
        : 'Close up, ten car lengths.';
      return pickExchange('safety-car', [
        [
          drv('Safety car — what have we got?'),
          wall('Car off, marshals on the track. ' + cost),
          drv('And we restart where?'),
          wall('P' + m.position + '. Nothing lost on track position.'),
        ],
        [
          wall('Safety car, safety car. There is a car in the barrier.'),
          drv('Anyone hurt?'),
          wall('He is out and walking. ' + cost),
          drv('Copy. Still P' + m.position + ', then.'),
        ],
        [
          wall('Safety car deployed. Get behind it and mind the cold tyres.'),
          drv('What happened?'),
          wall('Incident on track. ' + cost + ' You hold P' + m.position + '.'),
          drv('Copy that.'),
        ],
      ]);
    }

    case 'vsc':
      // THE LINE THIS WHOLE PASS WAS REPORTED OVER used to sit here, and it was
      // `"HOLD THE MINIMUM IN EVERY SECTOR"` — a restatement of Art. 56.5 to a
      // driver who is at that moment obeying Art. 56.5. What they cannot see is
      // what has happened and what it costs them, which is what they now ask
      // for and what they now get. Their own number is a separate moment,
      // because at this one it does not exist yet.
      return pickExchange('vsc', [
        [
          drv('What have we got?'),
          wall('Car stopped at ' + m.where + '. Marshals are recovering it.'),
          drv('Am I losing anything?'),
          wall('No. Everyone is on the same delta. You hold P' + m.position + '.'),
        ],
        [
          wall('Virtual safety car. Car stopped at ' + m.where + '.'),
          drv('Is it in a dangerous place?'),
          wall('Off the line, but they want people out there. Nobody gains.'),
          drv('Understood. Still P' + m.position + '.'),
        ],
        [
          wall('VSC, VSC. Recovery at ' + m.where + ' — steady through there.'),
          drv('What does it do to the order?'),
          wall('Nothing. Unchanged, P' + m.position + ', the field is frozen.'),
        ],
      ]);

    // The driver's own number, once there is one. The user's own example of
    // what this should sound like: "delta positive", "you're plus one-two,
    // that's good", "you're negative, lift".
    case 'delta':
      if (m.marginS >= 0) {
        return pickExchange('delta:+', [
          [
            drv('Give me the delta.'),
            wall('Positive. You are plus ' + m.marginS.toFixed(1) + '.'),
            drv('Happy with that?'),
            wall('Very. Hold exactly that and do not chase it.'),
          ],
          [
            wall('Delta positive, plus ' + m.marginS.toFixed(1) + '. Good number.'),
            drv('I will sit here then.'),
            wall('Do. There is nothing to win and a penalty to lose.'),
          ],
        ]);
      }
      return pickExchange('delta:-', [
        [
          wall('You are negative — minus ' + Math.abs(m.marginS).toFixed(1) + '. Lift.'),
          drv('Lifting.'),
          wall(m.breaches > 0
            ? 'That is ' + m.breaches + ' against you. One more and they penalise it.'
            : 'Stay above it now. They only give you one.'),
        ],
        [
          wall('Delta negative, minus ' + Math.abs(m.marginS).toFixed(1) + '. Lift now.'),
          drv('Coming back to it.'),
          wall(m.breaches > 0
            ? 'You have ' + m.breaches + ' of these now. They act on the next one.'
            : 'Get it back before the line and we say no more about it.'),
        ],
      ]);

    // THE ENDING. Every phase below is a specific instruction in the
    // regulations and each one changes what the driver has to do; see
    // `RaceControlManager.endingPhase` for the articles.
    case 'neutral-ending':
      switch (m.phase) {
        case 'vsc-ending':
          // Art. 56.7 / B5.12.4. The wall may say a green is coming and must
          // not say when — the window is drawn at random inside ten to fifteen
          // seconds precisely so the restart cannot be timed.
          return pickExchange('ending:vsc', [
            [
              wall('VSC ending. VSC ending.'),
              drv('How long?'),
              wall('They will not tell us. Temperature into the tyres now.'),
            ],
            [
              wall('Green is coming. We get no countdown, so be ready for it.'),
              drv('Understood. Building temperature.'),
              wall('Good. Watch the man in front, not the boards.'),
            ],
          ]);
        case 'unlapping':
          // Art. 55.14 / B5.13.4c, and the two halves of it are opposite
          // instructions to two halves of the field.
          return m.mustUnlap
            ? pickExchange('ending:unlap-go', [
              [
                wall('You are cleared to unlap. Go now, get round the queue.'),
                drv('All the way to the back?'),
                wall('All the way. Safety car is in at the end of the next lap.'),
              ],
              [
                wall('Lapped cars may overtake. That is you — go, and quickly.'),
                drv('On it, going now.'),
                wall('Rejoin the back of the train before the safety car comes in.'),
              ],
            ])
            : pickExchange('ending:unlap-hold', [
              [
                wall('Lapped cars coming through. Let them go, do not fight it.'),
                drv('And the restart?'),
                wall('End of the next lap. Start building your gap now.'),
              ],
              [
                wall('Blue cars will come past. They are entitled to, leave them.'),
                drv('Copy that.'),
                wall('Once they are gone it is one more lap and we go racing.'),
              ],
            ]);
        case 'sc-in':
          // Art. 55.12 / B5.13.5c, and Art. 55.15 / B5.13.6 for what happens
          // the moment the lights go out.
          return pickExchange('ending:sc-in', [
            [
              wall('Safety car in this lap. Safety car in this lap.'),
              drv('Copy that.'),
              wall('Leader takes the pace from the lights. Get your gap now.'),
            ],
            [
              wall('Safety car is in at the end of this lap. Wake the tyres up.'),
              drv('Working on them.'),
              wall('Brakes too. The first corner will be busy.'),
            ],
          ]);
        case 'hold-line':
          // Art. 55.8 / B5.13.2c. Green is showing but the obligation runs per
          // car until each has crossed the Line, which is the fact a driver
          // looking at a green flag has no way of holding on to.
          return pickExchange('ending:hold-line', [
            [
              wall('Green, green — but no overtaking until you cross the Line.'),
              drv('And after that?'),
              wall('After that it is on. Go.'),
            ],
            [
              wall('Track is green. You may not pass anybody before the Line.'),
              drv('Understood, waiting for the Line.'),
              wall('Then it is racing. Have the tyres ready for it.'),
            ],
          ]);
      }
      break;

    case 'chequered':
      return pickExchange('chequered', [
        [
          drv("That's the flag. Where did we finish?"),
          wall('P' + m.position + '. Well driven.'),
          drv('We had more than that in it.'),
          wall('Bring it home. Cool the tyres on the in-lap.'),
        ],
        [
          wall('Chequered flag, chequered flag. P' + m.position + '.'),
          drv('Thank you, lads. Good car today.'),
          wall('Good drive. Bring it back to us in one piece.'),
        ],
        [
          wall('That is the flag. You finish P' + m.position + '.'),
          drv('Copy. Anything on the car?'),
          wall('Nothing. Lift and coast on the in-lap and we will look.'),
        ],
      ]);

    case 'damage':
      return pickExchange('damage', [
        [
          drv('Something let go — I can feel it in the high speed.'),
          wall(m.part + ' has taken a hit. Numbers are still good.'),
          drv('It does not feel good.'),
          wall('Keep going. We are watching it.'),
        ],
        [
          wall('We are seeing something on the ' + m.part + '. How does it feel?'),
          drv('Loose. It moves around under braking.'),
          wall('Understood. Stay off the kerbs and we will watch it.'),
        ],
        [
          drv('Did you see that? Something hit me.'),
          wall(m.part + ', and it has cost you a little downforce.'),
          drv('Can I keep going?'),
          wall('For now. We tell you the moment that changes.'),
        ],
      ]);

    // FOUR REGISTERS, and they are the player's own examples:
    //
    //   "like once you gotta ask if they okay or maybe another time, u say
    //    like better luck next time, or like im sorry we'll have to retrire
    //    the car here."
    //
    // Concern, consolation, and the call itself made apologetically — three
    // different things a person says, not three phrasings of one. The fourth
    // is the shortest and the most urgent, for a car that is still moving.
    case 'retired':
      // THE FIRST THING A TEAM SAYS IS NOT ABOUT THE CAR.
      //
      //   "the principal should be asking 'are you okay?' or something along
      //    those lines, and then obviously like the FIA notif you can do
      //    something similar and be like 'unfortunately you have to retire'."
      //
      // Which is exactly the two-voice split this HUD already has, and it falls
      // out of it rather than needing a special case. The human question is the
      // TEAM's; the ruling is RACE CONTROL's, in its own impersonal register,
      // on the official strip — see `Hud.sayRetirement`.
      //
      // Nothing in any variant mentions points, classification or the rest of
      // the season. The driver is still in the car.
      return pickExchange('retired', [
        [
          wall('Are you okay? Talk to me.'),
          drv("I'm okay. I'm okay."),
          wall('Good. Kill the switches and get out of the car.'),
          drv('Copy. Sorry, lads.'),
        ],
        [
          wall('I am sorry — we have to retire the car here.'),
          drv('Understood. Nothing I could have done.'),
          wall('Nothing on you at all. Switches off and step out.'),
          drv('Copy that.'),
        ],
        [
          wall('That is our race done. Better luck next time out.'),
          drv('I know. Sorry, lads.'),
          wall('Do not be. Get out and we will pick it up on Monday.'),
          drv('Copy, understood.'),
        ],
        [
          wall('Stop the car. Stop the car.'),
          drv('Stopping now.'),
          wall('Are you hurt anywhere?'),
          drv('No. I am fine.'),
        ],
      ]);

    // The strategist's case, and the only one that leaves the last word to the
    // driver — because the card gives them buttons and the last word is theirs.
    // No variants: both lines come from `PitWall`, which wrote them about this
    // particular stop. Varying somebody else's words would be inventing facts.
    case 'call':
      return [wall(m.message), wall(m.reason)];
  }
  return [];
}

/**
 * What the wall says once the driver has answered — or has not.
 *
 * "not all of them have to be interactive but some should be like 'we think we
 *  should box this lap, box box' and the driver could be like 'no stay out' and
 *  they be like 'copy, box next lap'."
 *
 * That last clause is the whole reason this function exists as its own thing.
 * A question that produces silence when it is declined is a question the player
 * learns to ignore, because nothing they did had any effect. The wall answers
 * every outcome, including the one where nobody answered at all — an offer has
 * a clock on it and a driver busy in traffic is a real thing that happens, so
 * lapsing is a decision too and gets a reply of its own.
 *
 * Varied on the same rotation as everything else, and this is the one the
 * player meets most often in a race: a stop is offered several times over a
 * distance and the reply used to be word for word identical every time.
 *
 * EVERY `no` VARIANT STILL PROMISES NEXT LAP, because that is the content the
 * user asked for by name and not a turn of phrase — `probe:hudtext` requires it
 * of all of them.
 */
export function replyExchange(
  outcome: 'yes' | 'no' | 'lapsed', compound: string,
): RadioTurn[] {
  const onLeft = compound ? compound + ' on the left.' : 'Crew are out.';
  switch (outcome) {
    case 'yes':
      return pickExchange('reply:yes', [
        [
          drv('Yeah, agreed. Coming in.'),
          wall('Box box. ' + onLeft),
        ],
        [
          drv('Copy, box this lap.'),
          wall('Understood, crew are out. ' + onLeft),
        ],
        [
          drv('Happy with that. Box.'),
          wall('Box box, box box. ' + onLeft),
        ],
      ]);
    case 'no':
      return pickExchange('reply:no', [
        [
          drv('Negative, staying out.'),
          wall('Copy, box next lap. Crew stay ready.'),
        ],
        [
          drv('No, I want to stay out.'),
          wall('Understood. Box next lap if the numbers still stand.'),
        ],
        [
          drv('Not yet. Give me a couple more.'),
          wall('Copy that — we box next lap instead. Crew stand by.'),
        ],
      ]);
    case 'lapsed':
      return pickExchange('reply:lapsed', [
        [
          wall('No answer, so we hold.'),
          wall('Same call next lap if the numbers stand.'),
        ],
        [
          wall('We did not hear you, so nothing has changed.'),
          wall('Crew stay ready. We will put it to you again.'),
        ],
      ]);
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
/**
 * The governing body's mark, for the left block of the race-control strip.
 *
 * THE SUBSTITUTION. The reference strip carries the FIA roundel in a navy block
 * at its left edge, and the FIA roundel is a trademark. So this is the game's
 * own device in the same place at the same weight: a ring, a horizontal bar
 * across it, and a chequered quadrant — the three ideas an officiating mark in
 * this sport is made of, in geometry nobody owns. It is the same substitution
 * every other badge in this repo makes, including the team marks beside it.
 *
 * White on the strip's navy, because the strip is white on navy throughout and
 * a mark in a second colour would be the one thing on it asking for attention.
 */
export function governingMarkSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-label', 'Race control');
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.appendChild(e);
    return e;
  };
  add('circle', {
    cx: '16', cy: '16', r: '13.2',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2',
  });
  // The bar. An officiating mark in motorsport is a wheel with a horizon
  // through it; this is that idea and no more of it.
  add('rect', { x: '4.6', y: '14.2', width: '22.8', height: '3.6', fill: 'currentColor' });
  // The chequer, one quadrant, four squares. The flag is the sport's own
  // universal sign for a decision having been made.
  const s = 3.1;
  for (const [cx, cy] of [[16.9, 5.6], [23.1, 5.6], [16.9, 11.8], [23.1, 11.8]]) {
    if ((cx > 20) === (cy > 8)) continue;
    add('rect', {
      x: String(cx), y: String(cy), width: String(s), height: String(s),
      fill: 'currentColor',
    });
  }
  add('rect', { x: '16.9', y: '5.6', width: String(s), height: String(s), fill: 'currentColor' });
  add('rect', { x: '20.0', y: '8.7', width: String(s), height: String(s), fill: 'currentColor' });
  return svg;
}

/**
 * The waveform behind the radio card's words.
 *
 * A transmission is AUDIO, and a plate of quoted capitals with nothing behind
 * it is a caption of one. The broadcast reference has a trace running under the
 * text and it is the single element that makes the card read as a recording
 * rather than as a subtitle.
 *
 * STATIC, and deliberately. An animated waveform would be dancing to a signal
 * this game does not have — there is no audio stream behind these words, only a
 * speech synthesiser that may be switched off — and a meter that moves when
 * nothing is being measured is a decorative lie. It is also drawn behind text
 * that is already being written a character at a time, and two things moving in
 * the same 200 pixels is one too many.
 *
 * Generated rather than drawn: 46 bars whose heights come from a fixed sum of
 * three sines, which gives the irregular clustering of speech rather than the
 * even comb of a synthesised tone. Deterministic, so it is the same trace every
 * time and never reads as data.
 */
export function waveformSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'radio-wave');
  svg.setAttribute('viewBox', '0 0 200 44');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const bars = 46;
  for (let i = 0; i < bars; i++) {
    const t = i / bars;
    // Three incommensurate frequencies: speech has no period, and a single
    // sine reads immediately as a test tone.
    const a = Math.sin(t * 31.4) * 0.5 + Math.sin(t * 12.9 + 1.7) * 0.32
      + Math.sin(t * 57.1 + 0.4) * 0.18;
    const h = Math.max(1.5, Math.abs(a) * 20 + 1.5);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', (i * (200 / bars) + 0.8).toFixed(2));
    r.setAttribute('y', (22 - h).toFixed(2));
    r.setAttribute('width', (200 / bars - 1.6).toFixed(2));
    r.setAttribute('height', (h * 2).toFixed(2));
    r.setAttribute('rx', '0.8');
    svg.appendChild(r);
  }
  return svg;
}

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
