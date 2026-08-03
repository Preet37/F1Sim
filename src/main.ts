import './ui/styles.css';

import { SimClock } from './core/SimClock';
import { formatLapTime, clamp } from './core/MathUtils';
import { RaceEngine, type SessionConfig, type SessionKind } from './race/RaceEngine';
import type { CarEntry } from './race/CarEntry';
import { bandOf, COMPONENT_IDS, COMPONENT_NAMES } from './race/DamageModel';
import {
  qualifyingBoardOrder, rankSegment, resolveSegment, resultGapCell,
  type SegmentEntrant,
} from './race/Classification';
import { CIRCUITS, getCircuit } from './data/tracks/circuits';
import { TEAMS, getTeam, DRIVERS, type Driver, type Team } from './data/teams';
import { Renderer } from './render/Renderer';
import {
  RESOLUTION_CHOICES, TIER_LABEL, normaliseTier,
  type GraphicsPref, type QualityTier,
} from './render/QualityTiers';
import { CarStage } from './render/CarStage';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from './render/CameraDirector';
import { setRubberLine } from './render/SurfaceDetail';
import { InputController, pitBindingHints } from './input/InputController';
import {
  describeButton, unboundButton, type ButtonAction, type ButtonRef,
} from './input/GamepadProfile';
import { Hud } from './ui/Hud';
import {
  cutLine, qualifyingStrip, splitName, timingBoard, timingRow, type TimingRowSpec,
} from './ui/TimingRow';
import { Career } from './career/Career';
import { TIER_CAR } from './career/World';
import { REAL_ROSTER } from './data/roster';
import {
  sortedStandings,
  type OffSeasonReport, type RoundResult, type SeasonSummary,
} from './career/Season';
import type { CareerEvent } from './career/Events';
import { needsWorldRebuild } from './career/SaveCodec';
import { playerIndexIn } from './career/Seat';
import { buildCareerCreate, type CreatedIdentity } from './ui/CareerCreate';
import { buildTeamCreate, type TeamCreateHandle } from './ui/TeamCreate';
import { buildLiveryEditor, type LiveryEditorHandle } from './ui/LiveryEditor';
import { capGauge, driverMarket, engineDeal, mountTeamHQ } from './ui/TeamHQ';
import { decisionList, newsFeed } from './ui/Briefing';
import { buildPreparation } from './ui/Preparation';
import { clearLiveryDesigns, registerLiveryDesign } from './render/Livery';
import { coerceDesign } from './render/LiveryDesign';
import { playerHelmet } from './career/CareerState';
import { buildPodium } from './ui/Podium';
import { buildPressConference, type PressQuestion } from './ui/PressConference';
import { buildGarage } from './ui/GarageScene';
import { IntroSequence, openingBeats } from './ui/IntroSequence';
import { driverCard } from './ui/DriverPortrait';
import { SaveManager, type GameSettings } from './career/SaveManager';
import { AudioEngine } from './audio/AudioEngine';
import { TeamRadio } from './audio/TeamRadio';
import { buildPaddock, PADDOCK_ORDER, type PaddockHandle } from './ui/Paddock';
import { circuitSvg, circuitLoadingArt } from './ui/CircuitArt';
import { buildSetupScreen, defaultSetupFor, setupSummary } from './ui/SetupScreen';
import { buildStrategyScreen } from './ui/StrategyScreen';
import { applyPlanToCar, plannedStrategy, startingCompound } from './race/Strategy';
import { driversForTeam } from './data/teams';
import { buildControllerScreen, type ControllerScreenHandle } from './ui/ControllerScreen';
import { applySetup, specForTeam, type CarSetup } from './physics/VehicleSpec';
import { DRY_COMPOUNDS, WET_COMPOUNDS, getCompound, type CompoundId } from './data/tires';
import {
  PRACTICE_SEGMENTS, RACE_DISTANCES, SESSION_LENGTHS,
  practiceSegmentsFor, qualifyingSegmentsFor, raceLapsFor, weekendSummary,
} from './race/WeekendFormat';
import { HeadlessSession } from './race/SessionSimulator';
import { AI_DIFFICULTIES } from './ai/AIVehicleController';
import { PauseMenu } from './ui/PauseMenu';
import { PitStopPrompt } from './ui/PitStopPrompt';
import { clearPitOrder } from './race/PitStop';
import { ProfileStore } from './profile/ProfileStore';
import { buildMainMenu, MENU_ICONS, type MenuTile } from './ui/MainMenu';
import { buildDriversScreen } from './ui/DriversScreen';
import { buildSettingsScreen, type SettingsTab, type SettingsTabId } from './ui/SettingsScreen';
import { applyIdentityColours, rigColours } from './ui/frontendKit';

/**
 * Application shell: screens, the game loop, and the wiring between the
 * simulation, the renderer, the input layer and the career.
 *
 * The loop is the important part. Physics advances in fixed 120Hz steps driven by
 * an accumulator, and rendering happens once per animation frame at whatever rate
 * the display gives. That separation is why a lap time is the same on a 60Hz phone
 * and a 144Hz monitor — without it, the simulation's behaviour would depend on the
 * hardware and lap records would be meaningless.
 */

type Screen =
  | 'menu'
  | 'intro'
  | 'career-create'
  | 'career-hub'
  | 'team-create'
  | 'team-hq'
  | 'session-select'
  | 'setup'
  | 'strategy'
  | 'briefing'
  | 'simulating'
  | 'paddock'
  | 'racing'
  | 'results'
  // The three set-piece scenes. Every one of them was built, was correct, and
  // had no import, no screen id and no button anywhere in this file — issues
  // #13 and #38. A screen id is what lets `probe:smoke` name them in its
  // required set, which is what stops them going quietly unreachable again.
  | 'podium'
  | 'presser'
  | 'garage'
  | 'event'
  | 'standings'
  | 'settings'
  | 'controller'
  | 'drivers'
  | 'driver-create';

/** The build, as the front page prints it. */
const VERSION = 'v0.1.0';

class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly loading: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly loadingArt: HTMLElement;

  private renderer!: Renderer;
  private readonly input = new InputController();
  private readonly clock = new SimClock();
  private readonly saves = new SaveManager();
  /**
   * WHO IS PLAYING. The only thing on this shell that answers that.
   *
   * Every screen asks this object rather than reading storage, which is what
   * makes an account possible later without touching a screen. It wraps
   * `saves` for careers, so a career is never written through one path and
   * indexed through another. See `src/profile/ProfileStore.ts`.
   */
  private readonly profiles = new ProfileStore({ saves: this.saves });
  private readonly audio = new AudioEngine();
  private hud!: Hud;

  private engine: RaceEngine | null = null;
  private career: Career | null = null;
  /**
   * A paint shop or team-creation screen currently on the page.
   *
   * It owns its own GL context, so it has to be released on the way out of the
   * screen exactly the way `this.stage` is. `page()` is the choke point every
   * screen build passes through, so that is where it is torn down.
   */
  private paintShop: { dispose(): void } | null = null;
  /** The opening sequence, while it is on screen. */
  private intro: IntroSequence | null = null;
  private careerId = 'slot1';
  private settings: GameSettings;

  private screen: Screen = 'menu';
  private screenRoot!: HTMLElement;

  /**
   * Which settings tab is open.
   *
   * On the shell rather than inside the screen because the screen is rebuilt
   * from scratch after every change — that is how a toggle repaints — and a
   * tab held inside it would snap back to the first one every time anybody
   * touched a switch.
   */
  private settingsTab: SettingsTabId = 'opposition';
  /**
   * What the last graphics change could NOT apply on the spot. Video tab only.
   *
   * Held across the repaint because the screen is rebuilt from scratch after
   * every change, so the answer `setGraphics` gave would otherwise be gone
   * before it could be read.
   */
  private pendingVideo: { needsReload: boolean; needsNewSession: boolean } | null = null;

  /**
   * The car standing on the reveal stage behind a menu, or null.
   *
   * Owned here rather than by the screens that show it, because this is the
   * only object that knows when a screen is being torn down, and a second
   * WebGL context is the one resource in this application that absolutely
   * must not be leaked. Browsers cap live contexts — Chrome at sixteen — and
   * silently kill the OLDEST when the cap is passed, which would take out the
   * one running the race rather than the one that leaked. So there is exactly
   * one choke point: `page()` disposes any stage before it rebuilds a screen,
   * and `setScreen` disposes it again on the way into a session. Both are
   * idempotent, and every screen in the game passes through both.
   */
  private stage: CarStage | null = null;

  /** Session queue for a race weekend. */
  private weekend: SessionConfig[] = [];
  private weekendIndex = 0;
  /** Circuit chosen for a one-off session outside career mode. */
  private quickCircuitId = CIRCUITS[0].id;

  /**
   * The player's car setup, and the circuit it was chosen for.
   *
   * Null means "use whatever the engineers would set", which is what the AI
   * gets. It is cleared when the player moves to a different circuit, because a
   * Monaco wing level at Monza is not a choice anyone meant to make.
   */
  private playerSetup: CarSetup | null = null;
  private playerSetupCircuitId = '';
  private playerCompound: CompoundId | null = null;
  /**
   * The tyre plan chosen on the strategy screen, by driver id — the player's
   * car and their team-mate's.
   *
   * Kept on `Main` rather than on the engine for the same reason the setup is:
   * the engine does not exist yet when the choice is made, and it is rebuilt
   * for every session. `applyPlayerSetup` is the single funnel that writes all
   * of it onto real cars.
   */
  private playerStrategy: Record<string, string> = {};
  private playerStrategyCircuitId = '';

  private rafHandle = 0;
  /** Controls card starts visible each session, then fades out. */
  private helpVisible = false;
  private helpShownAt = 0;

  /**
   * The controller page, while it is open.
   *
   * It has to be driven from the game loop rather than from a timer of its own:
   * its bars show what the device is reporting, and a second clock would drift
   * against the one the input layer samples on, so the bars would visibly lag
   * the hands moving the control.
   */
  private controllerScreen: ControllerScreenHandle | null = null;

  /** The pause menu, and the pit stop sheet. Both live over the racing screen. */
  private pauseMenu!: PauseMenu;
  private pitPrompt!: PitStopPrompt;
  /**
   * The session currently being simulated instead of driven, or null.
   *
   * Held on the game rather than inside `skipSession` because the loop drives
   * it: a skip is stepped in wall-clock slices between animation frames so the
   * progress bar can actually paint, and a promise chain that owns its own
   * `setTimeout` would keep running after the player navigated away.
   */
  private skipping: {
    session: HeadlessSession;
    /** Which entry of `this.weekend` is being simulated. */
    index: number;
    label: HTMLElement;
    bar: HTMLElement;
    detail: HTMLElement;
    startedAt: number;
    cancelled: boolean;
    /**
     * True when the player is WATCHING rather than skipping.
     *
     * Same simulation, different thing to have happened. A skip is a session
     * the player declined; this is a session they are not allowed to drive —
     * knocked out, or barred by Art. B4.3.2 — and it is the only way they get
     * to see it at all. Calling it "Simulating" in that case is what produced
     * "Q3 was then simulated like I didn't even get to race": the player had
     * just pressed a button that said WATCH.
     */
    watching: boolean;
  } | null = null;

  /**
   * A session the player has stopped in, being run out to its flag.
   *
   * The sibling of `skipping`, and deliberately not the same thing. A skip
   * builds a fresh `HeadlessSession` because there is nothing to carry over;
   * this one steps THE LIVE ENGINE, because half the session has already
   * happened and the times already on the board are the ones that count.
   */
  private runningOut: {
    label: HTMLElement;
    bar: HTMLElement;
    detail: HTMLElement;
    startedAt: number;
    /** Session time when the player stopped, for the progress bar's origin. */
    fromTime: number;
    then: () => void;
    cancelled: boolean;
  } | null = null;

  constructor() {
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.loading = document.getElementById('loading') as HTMLElement;
    this.loadingText = document.getElementById('loading-text') as HTMLElement;
    this.loadingArt = document.getElementById('loading-art') as HTMLElement;
    this.settings = this.saves.loadSettings();
    // The dead switch. `Hud.RadioVoice` kept its own on/off flag here, outside
    // the settings file, and it was the second of two independent controls for
    // one feature. Both it and the class are gone; the key is removed rather
    // than merely ignored so that a stale value on an existing install cannot
    // be resurrected by anybody who finds the string in this file's history and
    // reads it "for backwards compatibility". `GameSettings.teamRadioVoice` is
    // the only memory the spoken radio has.
    try { localStorage.removeItem('f1sim.radioVoice'); } catch { /* private mode */ }
  }

  async start(): Promise<void> {
    // ?quality=low|medium|high overrides both the saved setting and detection.
    // Needed for headless verification, where the software rasteriser cannot
    // afford the shadow pass, and useful for anyone whose device is misdetected.
    // `?post=`, `?shadows=`, `?msaa=` and `?res=` do the same for the
    // individual switches, which is what `probe:graphics` drives.
    const qs = new URLSearchParams(window.location.search);
    const forced = normaliseTier(qs.get('quality'));
    const pref = (k: string): GraphicsPref => {
      const v = qs.get(k);
      return v === 'on' || v === '1' ? 'on' : v === 'off' || v === '0' ? 'off' : 'auto';
    };
    const res = Number(qs.get('res'));

    this.renderer = new Renderer({
      canvas: this.canvas,
      // A query tier beats the saved one; `auto` in both means auto.
      quality: qs.has('quality') ? forced : this.settings.quality,
      graphics: {
        post: qs.has('post') ? pref('post') : this.settings.graphics.post,
        shadows: qs.has('shadows') ? pref('shadows') : this.settings.graphics.shadows,
        msaa: qs.has('msaa') ? pref('msaa') : this.settings.graphics.msaa,
        resolution: Number.isFinite(res) && res > 0 ? res : this.settings.graphics.resolution,
      },
    });
    // The adaptive pass moves the tier during a session, so the Video tab has
    // to be told rather than assumed — otherwise the "Running now" readout is
    // stale exactly when it is most interesting.
    this.renderer.onQualityChange = () => {
      if (this.screen === 'settings') this.showSettings();
    };

    // ONE RADIO. The HUD's typewriter and the spoken voice are the same object,
    // so the words on the card and the words in the air cannot drift apart and
    // there is only one thing to switch off. `AudioEngine` owns it because it
    // owns the mix the transmission ducks; the HUD is the only listener.
    this.hud = new Hud(document.getElementById('app') as HTMLElement, this.audio.radio);
    this.hud.setVisible(false);
    this.hud.onCameraPressed = () => this.cycleCamera();
    // The pit call is a latch on the CAR, not a value written into the
    // perception buffer. The engine rebuilds that buffer from the strategy on
    // every physics step, and the strategy has no opinion about the player, so
    // a request written there was erased within eight milliseconds — the player
    // could never pit at all, on any lap, in any session.
    this.hud.onPitPressed = () => this.togglePitRequest();
    this.hud.onMenuPressed = () => this.openPauseMenu();

    const app = document.getElementById('app') as HTMLElement;
    this.pauseMenu = new PauseMenu(app);
    // Into the HUD's notice rail, not over it. The rail lays its children out;
    // the shell owns what the sheet DOES, because the sheet mutates the car and
    // that is not the instrument cluster's business.
    this.pitPrompt = new PitStopPrompt(this.hud.pitSlot);
    this.pitPrompt.onCancel = () => {
      if (this.engine?.playerCar?.pitRequested) this.togglePitRequest();
    };

    this.screenRoot = document.createElement('div');
    this.screenRoot.className = 'screen';
    (document.getElementById('app') as HTMLElement).appendChild(this.screenRoot);

    // Audio cannot be created before a user gesture — every browser blocks it,
    // and on iOS a context built outside one stays silently suspended forever
    // rather than throwing. So the first touch, click or keypress anywhere
    // brings it up, and it only ever needs to happen once.
    const unlockAudio = () => {
      void this.audio.start().then(() => {
        this.audio.setVolume(this.settings.masterVolume);
        this.audio.setEnabled(this.settings.masterVolume > 0);
        this.audio.radio.setEnabled(this.settings.teamRadioVoice);
      });
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    window.addEventListener('touchstart', unlockAudio);

    // Backgrounding the tab should not leave an engine screaming in a tab the
    // player has navigated away from.
    document.addEventListener('visibilitychange', () => {
      this.audio.setSuspended(document.hidden || this.screen !== 'racing');
    });

    this.input.attach(this.canvas);
    this.input.config.speedSensitiveSteering = this.settings.speedSensitiveSteering;
    this.input.config.tractionAssist = this.settings.tractionAssist;
    this.input.config.brakingAssist = this.settings.brakingAssist;

    // Shared by reference on purpose: the controller screen edits this object
    // and the input layer reads it every frame, so a change on the screen is
    // live on the next poll with no apply step in between.
    this.input.gamepadSettings = this.settings.gamepad;
    this.input.gamepads.preferredSignature = this.settings.gamepad.activeSignature;
    // A device appearing or disappearing changes what Settings should say about
    // it, so redraw if the player happens to be looking at that page.
    this.input.gamepads.onDevicesChanged = () => {
      if (this.screen === 'settings') this.showSettings();
    };

    window.addEventListener('resize', () => this.renderer.resize());
    // iOS fires orientationchange before the viewport has settled.
    window.addEventListener('orientationchange', () => {
      window.setTimeout(() => this.renderer.resize(), 240);
    });

    this.setLoading(false);

    // Deep link, e.g. ?circuit=monza&session=race&laps=3
    //
    // Exists so a session can be launched without navigating the menus, which is
    // what makes automated and headless verification of the actual racing possible
    // — screenshotting the menu proves very little.
    const deepLink = this.parseDeepLink();
    if (deepLink) {
      this.quickCircuitId = deepLink.circuitId;
      this.weekend = [deepLink.config];
      this.weekendIndex = 0;
      // A deep link is used for headless verification and to jump straight into a
      // session, so it goes past the garage briefing rather than through it.
      this.launchSession(deepLink.circuitId);
    } else {
      this.openFrontDoor();
    }

    this.loop(performance.now());
  }

  /** Reads ?circuit=&session=&laps= from the URL, if present and valid. */
  private parseDeepLink(): { circuitId: string; config: SessionConfig } | null {
    const q = new URLSearchParams(window.location.search);
    const circuitId = q.get('circuit');
    if (!circuitId) return null;
    if (!CIRCUITS.some((c) => c.id === circuitId)) return null;

    const kindParam = (q.get('session') ?? 'race').toLowerCase();
    const kind: SessionKind =
      kindParam === 'practice' ? 'practice' :
      kindParam === 'qualifying' ? 'qualifying' : 'race';

    const def = getCircuit(circuitId);
    const laps = kind === 'race'
      ? clamp(Number(q.get('laps') ?? def.raceLaps) || def.raceLaps, 1, 100)
      : 0;
    const durationS = kind === 'race' ? 0 : clamp(Number(q.get('duration') ?? 600) || 600, 30, 5400);

    const name = kind === 'race' ? 'Grand Prix' : kind === 'qualifying' ? 'Qualifying' : 'Free Practice';
    const seedParam = Number(q.get('seed'));
    const config: SessionConfig = {
      kind, name, durationS, laps,
      playerIndex: 0,
      standingStart: kind === 'race' && q.get('rolling') !== '1',
      // A deep link is used for headless verification and for jumping straight
      // into a session; honour the same garage-start rule as the menus, but let
      // ?pit=0 skip the out-lap when a test wants the car on track immediately.
      pitLaneStart: kind !== 'race' && q.get('pit') !== '0',
      seed: Number.isFinite(seedParam) && seedParam !== 0 ? seedParam : (Math.random() * 0x7fffffff) | 0,
    };
    return { circuitId, config };
  }

  /** Cycles the camera and persists the choice. Used by both the key and the button. */
  private cycleCamera(): void {
    const mode = this.renderer.director.cycleMode();
    this.settings.cameraMode = mode;
    this.saves.saveSettings(this.settings);
    this.hud.setCameraLabel(this.renderer.director.modeLabel);
    this.hud.setCameraMode(mode);
  }

  /**
   * The loading screen.
   *
   * When the circuit is known it draws itself while the session is built —
   * the surveyed outline the physics is about to run on, traced by a red line
   * over a kerb-striped bar. A spinner says "wait"; this says what you are
   * waiting for, which is a lap of Suzuka.
   */
  private setLoading(on: boolean, text = 'BUILDING CIRCUIT', circuitId?: string): void {
    this.loadingText.textContent = text;
    this.loadingArt.replaceChildren();
    if (on && circuitId) {
      const art = circuitLoadingArt(getCircuit(circuitId));
      this.loadingArt.appendChild(art);
      // The dash length has to be the path's own length or the trace either
      // stops short or finishes early. It is only measurable once the element
      // is in the document, which is why it happens here and not in CircuitArt.
      const draw = art.querySelector('.ca-draw') as SVGPathElement | null;
      if (draw && typeof draw.getTotalLength === 'function') {
        const len = draw.getTotalLength();
        draw.style.setProperty('--lap-length', String(len));
        draw.style.strokeDasharray = String(len);
      }
    }
    this.loading.classList.toggle('hidden', !on);
  }

  // =======================================================================
  // Screens
  // =======================================================================

  private setScreen(s: Screen): void {
    // Leaving the controller page releases the input layer, which that page
    // holds suspended while a binding or calibration is in progress. Without
    // this, walking away mid-bind would leave the gamepad dead until reload.
    if (this.screen === 'controller' && s !== 'controller') {
      this.controllerScreen?.dispose();
      this.controllerScreen = null;
    }
    // Same reasoning for the opening sequence: it owns a GL context and a
    // frame loop, and anything that navigates away from it — a deep link, a
    // reload of the screen, an error — has to take them back.
    if (this.screen === 'intro' && s !== 'intro') {
      this.intro?.dispose();
      this.intro = null;
    }
    this.screen = s;
    const inSession = s === 'racing';
    this.screenRoot.classList.toggle('hidden', inSession);
    this.hud.setVisible(inSession);
    // Keys are driving inputs only while there is a car to drive. `attach` runs
    // once at startup and its window listener is live on every screen, so
    // without this a digit pressed on the career page selected a gear and an `E`
    // changed the ERS mode, silently, for the session that had not started yet.
    // That is the route by which issue #45 was reached — "trying to run
    // something on the careers page". Everything this object produces is already
    // read only while `screen === 'racing'`, so nothing else changes.
    this.input.enabled = inSession;
    // The pause menu belongs to the track and to nothing else. Leaving without
    // clearing it would strand a modal over the menus.
    if (!inSession && this.pauseMenu?.visible) {
      this.pauseMenu.hide();
      this.clock.paused = false;
    }
    // The retirement controls belong to the track for the same reason. They no
    // longer pause the clock, but `dismissRetirement` still puts it back to
    // running, which is the state a screen change has to leave behind.
    if (!inSession && (this.retireOverlay || this.retireStatus)) this.dismissRetirement();
    // Leaving the track cuts the car but keeps the context alive, so returning
    // to a session does not have to rebuild the whole graph.
    // A stage rendering behind a hidden menu is a GL context and a render loop
    // burning frames the player cannot see, while the race needs every one.
    if (inSession) this.disposeStage();
    if (!inSession) {
      this.audio.silenceCar();
      // A rumble effect outlives the frame that started it, so a controller
      // left buzzing on the results screen is a real possibility.
      this.input.stopForceFeedback();
    }
  }

  /**
   * Stands a car on the reveal stage behind the current screen.
   *
   * `mode` is where the car goes, not how it is drawn: `right` puts it in the
   * right-hand two thirds with the interface beside it, `full` gives it the
   * whole frame with the interface floating over it. The box is a CSS one and
   * the camera frames the car to whatever box it is given, so a phone in
   * portrait — where the same class resolves to a band across the top — needs
   * no second code path here.
   *
   * Returns the stage so a screen can re-fit a different livery on it, which
   * is what walking the paddock does: rebuilding the whole stage per press
   * would take and drop a GL context ten times while somebody browses.
   */
  private mountStage(
    mode: 'right' | 'full' | 'panel' | 'hero',
    livery: { colour: number; accent: number; number?: number; code?: string },
    into?: HTMLElement,
    /**
     * The light rig behind the car — the player's own helmet colours. Omitted
     * on the working screens, where a room full of coloured light would be
     * decoration standing next to a page of figures.
     */
    room?: { streaks?: readonly number[] },
  ): CarStage | null {
    this.disposeStage();
    // The stage is a luxury, not a feature: if anything about it fails —
    // a refused context, a driver that will not allocate the shadow map — the
    // menus have to carry on exactly as they did without it.
    try {
      const stage = new CarStage({
        ...livery,
        quality: this.renderer.menuQuality,
        // A car turning on the spot forever is precisely the continuous
        // motion this setting exists to switch off. Parked at the three-
        // quarter angle instead, and the render loop never starts.
        still: matchMedia('(prefers-reduced-motion: reduce)').matches,
        streaks: room?.streaks,
      });
      // `panel` stands the car inside a box on the page — a garage bay in the
      // flow of a dense screen. The other two hang it behind the whole screen.
      // Same canvas and same camera either way; only the box differs.
      const host = this.el('div', 'stage stage-' + mode, into ?? this.screenRoot);
      if (!into) {
        // Placed behind the page, which `page()` has already appended.
        this.screenRoot.insertBefore(host, this.screenRoot.firstChild);
        this.screenRoot.classList.add('lit');
      }
      stage.mount(host);
      this.el('div', 'stage-veil', host);
      this.stage = stage;
      return stage;
    } catch (err) {
      console.warn('Car stage unavailable; menus continue without it.', err);
      this.stage = null;
      return null;
    }
  }

  /** Releases the stage's context, loop and observer. Safe to call any time. */
  private disposeStage(): void {
    this.stage?.dispose();
    this.stage = null;
  }

  private el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text) d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  private button(label: string, parent: HTMLElement, onClick: () => void, cls = 'btn'): HTMLElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  /**
   * The chassis every screen is built on.
   *
   * A header carrying the breadcrumb tab, the title and a short column of
   * figures; a scrolling body; and an action bar pinned to the bottom edge. The
   * point of pinning the action bar is not decoration: "Race Weekend" used to
   * sit at the end of a page that ran past the fold on a laptop and a thousand
   * pixels past it on a phone, so the one thing the screen existed to offer was
   * the one thing you had to go looking for.
   *
   * Going back is a chevron in the top-left corner, in the same place on every
   * screen, rather than a grey button of the same size and colour as four
   * others in a row at the bottom.
   */
  private page(opts: {
    tab?: string;
    title?: string;
    titleHtml?: string;
    sub?: string;
    back?: () => void;
    meta?: [string, string][];
    /** Where you are, for the status rail. Defaults to the screen's own tab. */
    where?: string;
    /**
     * The sector rule under the header.
     *
     * Three segments whose widths are the real proportions of something: a
     * circuit's two sector splits, a season's rounds, a weekend's sessions.
     * `at` is how far through we are, 0-3. Omitted on screens where there is
     * genuinely nothing to proportion, in which case no rule is drawn — a
     * decorative one would be exactly the stripe this replaced.
     */
    rule?: { parts: number[]; at?: number; best?: boolean };
  }): { body: HTMLElement; actions: HTMLElement } {
    // Clearing `innerHTML` would orphan the stage's canvas while its GL
    // context, its render loop and its resize observer all carried on. This is
    // the choke point every screen build passes through, so it is where the
    // stage is released.
    this.disposeStage();
    this.paintShop?.dispose();
    this.paintShop = null;
    this.screenRoot.innerHTML = '';
    this.screenRoot.classList.remove('lit');
    // The front of house corrects three of this chassis's decisions — it does
    // not scroll, it does not print the wordmark twice, and its car stands in
    // a band rather than over the whole frame. Both classes are cleared here
    // and set by the screens that want them, so no working screen can inherit
    // them by being built after one.
    this.screenRoot.classList.remove('frontdoor', 'is-menu');
    const page = this.el('div', 'page', this.screenRoot);

    this.statusRail(page, opts.where ?? opts.tab ?? '');

    if (opts.tab || opts.title || opts.back) {
      const bar = this.el('div', 'topbar', page);

      if (opts.back) {
        const back = document.createElement('button');
        back.className = 'navback';
        back.type = 'button';
        back.setAttribute('aria-label', 'Back');
        back.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
          'stroke-linecap="square"><path d="M15 4 L7 12 L15 20"/></svg>';
        back.addEventListener('click', opts.back);
        bar.appendChild(back);
      } else {
        // Keeps the title column in the same place whether or not there is a
        // way back, so the title does not jump sideways between screens.
        this.el('div', 'navback-gap', bar);
      }

      const titles = this.el('div', 'topbar-titles', bar);
      if (opts.tab) this.el('div', 'tab', titles, opts.tab);
      if (opts.title || opts.titleHtml) {
        const t = this.el('h1', 'page-title', titles);
        if (opts.titleHtml) t.innerHTML = opts.titleHtml;
        else t.textContent = opts.title ?? '';
      }
      if (opts.sub) this.el('div', 'page-sub', titles, opts.sub);

      const meta = this.el('div', 'topbar-meta', bar);
      for (const [label, value] of opts.meta ?? []) {
        const item = this.el('div', 'meta-item', meta);
        this.el('div', 'meta-label', item, label);
        this.el('div', 'meta-value', item, value);
      }

    }

    if (opts.rule) this.sectorRule(page, opts.rule);

    const body = this.el('div', 'page-body', page);
    const actions = this.el('div', 'actionbar', page);
    return { body, actions };
  }

  /**
   * The strip along the top of every screen.
   *
   * A timing monitor tells you what it is showing and whether it is showing it
   * now, before it shows you anything. The right-hand end reads the state of
   * the career, so the answer to "where am I in this game" is on every screen
   * rather than only on the hub.
   */
  private statusRail(page: HTMLElement, where: string): void {
    const rail = this.el('div', 'statusrail', page);
    const mark = this.el('div', 'statusrail-mark', rail);
    mark.innerHTML = 'F1<b>SIM</b>';

    if (where) {
      this.el('div', 'statusrail-sep s1', rail, '/');
      this.el('div', 'statusrail-where', rail, where);
    }

    this.el('div', 'statusrail-spacer', rail);

    const career = this.career;
    if (career) {
      this.el('div', 'statusrail-state', rail,
        TIER_CAR[career.tier].shortName +
        ' · R' + Math.min(career.round + 1, career.calendar.length) +
        '/' + career.calendar.length + ' · P' + career.championshipPosition);
      this.el('div', 'statusrail-sep', rail, '/');
    }
    this.el('div', 'statusrail-live', rail, 'Live');
  }

  /**
   * The sector rule: three segments in the slot the kerb rule used to hold.
   *
   * The difference is that these have widths. A circuit's segments are its
   * actual sector splits, so Monaco's rule and Spa's rule are different
   * shapes, and the proportions are the ones the timing panel will score in
   * during the session. Nothing here is drawn unless a real number set it.
   */
  private sectorRule(page: HTMLElement, rule: { parts: number[]; at?: number; best?: boolean }): void {
    const el = this.el('div', 'sectorrule', page);
    const total = rule.parts.reduce((a, b) => a + b, 0) || 1;
    for (const [i, part] of rule.parts.entries()) {
      const seg = this.el('span', '', el);
      seg.style.flex = String(part / total);
      const at = rule.at ?? 0;
      if (i < at) seg.className = rule.best ? 'best' : 'done';
      else if (i === at) seg.className = 'live';
    }
  }

  /** The three sector proportions of a circuit, as the rule wants them. */
  private circuitRule(def: ReturnType<typeof getCircuit>, at = 0): { parts: number[]; at: number } {
    return {
      parts: [
        def.sector1EndS,
        def.sector2EndS - def.sector1EndS,
        def.lengthM - def.sector2EndS,
      ],
      at,
    };
  }

  /**
   * The timing row, the board it sits in, and the cut line across it.
   *
   * The implementations moved to `src/ui/TimingRow.ts` so the panel harness
   * can photograph the REAL row rather than a reproduction of it — see the
   * note at the head of that file. These stay as methods because every screen
   * in here calls them as ones, and a screen is not the place to be reminded
   * where a helper lives.
   */
  private trow(parent: HTMLElement, r: TimingRowSpec): HTMLElement {
    return timingRow(parent, r);
  }

  private board(parent: HTMLElement, cols: string[]): HTMLElement {
    return timingBoard(parent, cols);
  }

  private cutLine(parent: HTMLElement, label: string, past = false): HTMLElement {
    return cutLine(parent, label, past);
  }

  /** Pushes everything added after it to the right-hand end of the action bar. */
  private spacer(actions: HTMLElement): void {
    this.el('div', 'actionbar-spacer', actions);
  }

  /**
   * A circuit as a card: its own surveyed outline, then the three numbers that
   * decide whether you want to drive it.
   *
   * The map is the point. Eleven cards reading "5.807 km · 53 laps" are eleven
   * rows of a table; eleven outlines are eleven circuits, and the figure-of-
   * eight is recognisable from across the room.
   */
  private circuitCard(
    parent: HTMLElement,
    def: ReturnType<typeof getCircuit>,
    opts: { selected?: boolean; onClick?: () => void; round?: number; index?: number } = {},
  ): HTMLElement {
    const card = this.el('div', 'circuit-card' + (opts.selected ? ' selected' : ''), parent);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    if (opts.index !== undefined) card.style.setProperty('--i', String(opts.index));

    card.innerHTML =
      '<div class="cc-map">' +
      (opts.round !== undefined
        ? '<span class="cc-round">R' + String(opts.round).padStart(2, '0') + '</span>'
        : '') +
      '<span class="cc-code">' + escapeHtml(def.countryCode) + '</span>' +
      circuitSvg(def) +
      '</div>' +
      '<div class="cc-body">' +
      '<div class="cc-name">' + escapeHtml(def.name) + '</div>' +
      '<div class="cc-where">' + escapeHtml(def.city + ', ' + def.country) + '</div>' +
      '<div class="cc-strip">' +
      '<div class="cc-cell"><div class="cc-cell-label">Length</div>' +
      '<div class="cc-cell-value">' + (def.lengthM / 1000).toFixed(3) + ' km</div></div>' +
      '<div class="cc-cell"><div class="cc-cell-label">Laps</div>' +
      '<div class="cc-cell-value">' + def.raceLaps + '</div></div>' +
      '<div class="cc-cell"><div class="cc-cell-label">Pole</div>' +
      '<div class="cc-cell-value record">' + formatLapTime(def.referencePoleTimeS) + '</div></div>' +
      '</div></div>';

    if (opts.onClick) {
      card.addEventListener('click', opts.onClick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          opts.onClick?.();
        }
      });
    }
    return card;
  }

  // =======================================================================
  // The front door
  // =======================================================================

  /**
   * WHAT SOMEBODY SEES WHEN THEY OPEN THIS FOR THE FIRST TIME.
   *
   * Three states, and every one of them was broken before:
   *
   *   NOBODY HAS EVER PLAYED HERE. The titles run, and then the game asks who
   *     is driving. It does not open on a menu that greets a stranger by a
   *     name it does not have, and it does not open on a form with a wordmark
   *     over it. This is the path that had no code at all: the game simply
   *     showed the menu, and the menu showed whatever name happened to be in
   *     the most recent career.
   *
   *   A DRIVER EXISTS AND HAS NOT SEEN THE TITLES. They run once, for them.
   *     The flag used to be one per browser, set in 2026 and never cleared, so
   *     every driver made afterwards on this machine was skipped past the one
   *     piece of cinema in the game — which is exactly what happened, and why
   *     the person who commissioned it had never seen it.
   *
   *   A DRIVER EXISTS AND HAS SEEN THEM. Straight to the menu.
   *
   * `?intro=0` suppresses the sequence, for a harness booting the MENU rather
   * than a session. `?fresh=1` clears the whole front end, which is how the
   * first-run path is tested without hand-emptying storage.
   */
  private openFrontDoor(): void {
    const q = new URLSearchParams(window.location.search);
    if (q.get('fresh') === '1') this.profiles.removeAll();

    const allowIntro = q.get('intro') !== '0';
    const profile = this.profiles.active;

    if (!profile) {
      // Nobody. Titles, then the one question the game has to ask.
      if (allowIntro) this.playIntro(() => this.showDriverCreate({ firstRun: true }));
      else this.showDriverCreate({ firstRun: true });
      return;
    }
    if (allowIntro && !profile.introSeen) {
      this.playIntro(() => this.showMenu());
      return;
    }
    this.showMenu();
  }

  /**
   * Plays the opening sequence.
   *
   * The flag is written the moment it STARTS rather than when it ends, so a
   * player who skips it, closes the tab, or reloads mid-sequence is never shown
   * it a second time. Being made to sit through — or skip past — an opening
   * twice is the specific thing that makes people resent them.
   *
   * It is also replayable from the menu, from the drivers rack, and by URL,
   * because an opening that can only ever be seen once is an opening most of
   * the people it was made for will never see at all.
   */
  private playIntro(after: () => void): void {
    this.settings.introSeen = true;
    this.saves.saveSettings(this.settings);
    const active = this.profiles.active;
    if (active) this.profiles.noteIntroSeen(active.id);

    this.setScreen('intro');
    // The menu leaves a car stage of its own behind it, and two GL contexts for
    // two cars is one more than any browser should be asked for.
    this.disposeStage();
    this.screenRoot.innerHTML = '';

    // The real Formula 1 grid's colours for the walk, then the Formula 3 team
    // the player is about to be offered. The last car standing in the light is
    // the one they are actually given.
    const f1 = REAL_ROSTER.tiers.F1.teams;
    const f3 = REAL_ROSTER.tiers.F3.teams;
    const rookie = f3[f3.length - 1];

    const done = (): void => {
      this.intro = null;
      after();
    };
    this.intro = new IntroSequence({
      host: document.getElementById('app') as HTMLElement,
      beats: openingBeats(
        { colour: rookie.colour, accent: rookie.accent, code: rookie.code },
        f1.map((t) => ({ colour: t.colour, accent: t.accent, code: t.code })),
      ),
      durationS: 16.5,
      // `?introslow=6` stretches the sequence so the screenshot harness can
      // catch a frame of it. See `IntroOptions.timeScale`.
      timeScale: Number(
        new URLSearchParams(window.location.search).get('introslow')) || 1,
      quality: this.renderer.menuQuality,
      // The rig behind the car in the rain is the player's own colours when
      // there is a player, and cold sodium when there is not — which is what a
      // first run looks like, because there is nobody to light it for yet.
      streaks: rigColours(active?.helmet ?? null),
      onDone: done,
    });
  }

  /**
   * The front page. See `src/ui/MainMenu.ts` for what it is and why.
   *
   * What stays here is what the shell owns: the car standing behind it, the
   * figures read out of the save, and where every button goes.
   */
  private showMenu(): void {
    this.setScreen('menu');
    const profile = this.profiles.active;
    const current = this.profiles.currentCareer();
    const { body } = this.page({ where: 'Main Menu' });
    this.screenRoot.classList.add('frontdoor', 'is-menu');

    // The player's own colours, published to the screen. Everything lit on the
    // front end is lit in them; with no driver yet the hall stays unlit.
    applyIdentityColours(this.screenRoot, profile?.helmet ?? null);

    // WHICH CAR. With a career running it is the one in your garage; without
    // one it is the machine at the front of the grid — the thing you are about
    // to go and try to beat. Either way it stands in a rig of light built from
    // the helmet the player designed.
    const showTeam = this.career ? getTeam(this.career.state.teamId) : PADDOCK_ORDER[0];
    const showDriver = DRIVERS.find((d) => d.teamId === showTeam.id);

    const tiles: MenuTile[] = [];

    if (current) {
      tiles.push({
        name: 'Continue',
        figure: tierLabel(current.tier) + ' · Round ' + (current.round + 1),
        description: 'Pick your career back up where you left it',
        lead: true,
        onSelect: () => this.openCareer(current.id),
      });
    }
    tiles.push({
      name: current ? 'New Career' : 'Start Career',
      figure: 'F3 → F2 → F1',
      description: 'Sign for a junior team and race for a Formula 1 seat',
      lead: !current,
      onSelect: () => this.showCareerCreate(),
    });
    // The second door into a career, and it is a tile rather than a link
    // because it is a mode and not a setting: you found the constructor, you
    // drive for it, and everything the factory builds reaches the car through
    // `TeamPerformance`. See `src/career/MyTeam.ts`.
    tiles.push({
      name: 'My Team',
      figure: '$150M',
      description: 'Own the outfit and drive for it. Twelfth on the grid, nothing built yet',
      onSelect: () => this.showCareerCreate('myteam'),
    });
    tiles.push({
      name: 'Quick Race',
      figure: CIRCUITS.length + ' circuits',
      description: 'Any circuit, any session, straight to the grid',
      onSelect: () => this.showSessionSelect(true),
    });
    tiles.push({
      name: 'Paddock',
      figure: TEAMS.length + ' teams',
      description: 'Every team, every car and what it is good at',
      onSelect: () => this.showPaddock(),
    });

    buildMainMenu(body, {
      profile,
      standing: current
        ? tierLabel(current.tier) + ' · R' + (current.round + 1)
        : 'No career yet',
      onIdentity: () => this.showDrivers(),
      onSettings: () => this.showSettings(),
      tiles,
      links: [
        {
          label: profile ? 'Drivers' : 'Create a driver',
          icon: MENU_ICONS.drivers,
          onSelect: () => this.showDrivers(),
        },
        {
          label: 'Opening titles',
          icon: MENU_ICONS.film,
          onSelect: () => this.playIntro(() => this.showMenu()),
        },
        {
          label: 'Settings',
          icon: MENU_ICONS.gauge,
          onSelect: () => this.showSettings(),
        },
      ],
      version: VERSION,
      warning: this.profiles.isEphemeral
        ? 'This browser is blocking storage, so a driver and a career will not '
          + 'survive a reload. Everything else works normally.'
        : undefined,
      blurb: current
        ? {
          label: 'Career in progress',
          text: 'A full physics simulation, ' + CIRCUITS.length + ' surveyed circuits, '
            + 'and a ladder that starts in the slowest car on the grid.',
        }
        : {
          label: 'Formula 3 to Formula 1',
          text: 'Every number on every screen is one the car actually uses. '
            + 'Finish in the top two and you go up.',
        },
    });

    // THE CAR GOES INSIDE THE LAYOUT, not behind the viewport.
    //
    // Every other screen hangs the stage off the screen's own edges with a
    // percentage box, which is right where the car IS the screen. Here it is
    // one band of a composition that also has a title above it and four grid
    // slots below, and a viewport-relative box needed a media query per
    // breakpoint and still left the car floating in a hole on a tall phone.
    // Mounted into the hero element, the camera frames itself to whatever box
    // the layout gave it, at every aspect, with nothing to keep in step.
    const hero = body.querySelector('.mm-hero');
    if (hero instanceof HTMLElement) {
      this.mountStage('hero', {
        colour: showTeam.colour,
        accent: showTeam.accent,
        number: profile?.raceNumber ?? showDriver?.raceNumber,
        code: profile?.code ?? showDriver?.code,
      }, hero, { streaks: rigColours(profile?.helmet ?? null) });
      // The pool of light on the floor belongs to the screen behind the car,
      // and this is one of the two screens in the game that is a moment.
      this.screenRoot.classList.add('lit');
    }
  }

  /**
   * Opens a career by its save id, with the reasons a save can refuse.
   *
   * One funnel, because there are now three doors into a career — Continue, a
   * career listed under a driver on the rack, and switching to a driver who
   * has one — and three copies of the migration and error handling would be
   * three places for them to drift apart.
   */
  /**
   * Takes on a career, and tells the painter what its team's car looks like.
   *
   * THE LIVERY REGISTRATION IS THE POINT OF THIS EXISTING. A My Team save holds
   * its pattern family, trim colour, finish and mark, and `CarMesh` — which
   * knows a team only as two colours — looks the design up in a registry keyed
   * on that colour pair. So it has to be registered before any car is built,
   * and there are three places a career arrives from: created, loaded from the
   * menu, and rebuilt from a version-1 save. All three come through here, so
   * none of them can forget.
   */
  private adoptCareer(career: Career, id: string): void {
    this.career = career;
    this.careerId = id;
    clearLiveryDesigns();
    const t = career.state.team;
    if (t) {
      registerLiveryDesign(t.colour, t.accent, coerceDesign({
        family: t.liveryFamily as never,
        trim: t.trim,
        finish: t.liveryFinish,
        mark: t.liveryMark,
      }));
    }
  }

  /**
   * Puts the career in memory down, and the paint with it.
   *
   * Switching driver, deleting a driver or abandoning a career leaves a My
   * Team livery registered against a colour pair that nobody on the grid owns
   * any more. `CarMesh` knows a team only as two colours, so the next career
   * that happens to share them would be painted in somebody else's design.
   */
  private dropCareer(): void {
    this.career = null;
    clearLiveryDesigns();
  }

  private openCareer(careerId: string): void {
    const result = this.profiles.loadCareer(careerId);
    if (!result.ok) {
      // The reason matters: a save from a newer build is a completely
      // different situation from a corrupt file, and telling somebody their
      // career is gone when it is merely from tomorrow's build is the worst
      // possible version of this message.
      alert(loadFailureMessage(result));
      return;
    }
    if (needsWorldRebuild(result.state)) {
      // A career from before the ladder existed. The driver survives; the
      // three championships around them cannot be reconstructed, because the
      // save predates their existence. See SaveCodec's migration note.
      const rebuilt = Career.create({
        firstName: result.state.player.firstName,
        lastName: result.state.player.lastName,
        nationality: result.state.player.nationality,
        raceNumber: result.state.player.raceNumber,
        seed: result.state.seed,
      });
      rebuilt.state.player = result.state.player;
      rebuilt.state.narrative = result.state.narrative;
      rebuilt.state.history = result.state.history;
      rebuilt.syncPlayerIntoWorld();
      this.adoptCareer(rebuilt, careerId);
      alert('This career was started before the Formula 3 and Formula 2 '
        + 'championships existed. Your driver has been carried over; the '
        + 'season around them has been rebuilt.');
    } else {
      this.adoptCareer(new Career(result.state), careerId);
    }
    this.profiles.touchCareer(careerId);
    this.showCareerHub();
  }

  // =======================================================================
  // Drivers
  // =======================================================================

  /**
   * The rack of drivers on this device.
   *
   * See `src/ui/DriversScreen.ts` for why "switch" and "delete" rather than
   * "sign out".
   */
  private showDrivers(): void {
    this.setScreen('drivers');
    const active = this.profiles.active;
    const { body, actions } = this.page({
      tab: 'Main Menu',
      where: 'Drivers',
      title: 'Drivers',
      sub: 'Who is playing, and everyone else who plays on this device.',
      back: () => this.showMenu(),
    });
    this.screenRoot.classList.add('frontdoor');
    applyIdentityColours(this.screenRoot, active?.helmet ?? null);

    buildDriversScreen(body, {
      drivers: this.profiles.list().map((p) => ({
        profile: p,
        record: this.profiles.record(p.id),
        active: p.id === active?.id,
      })),
      tierName: (t) => tierLabel(t),
      ephemeral: this.profiles.isEphemeral,
      onPlayAs: (id) => {
        this.profiles.setActive(id);
        // The career in memory belonged to the driver who is no longer
        // playing. Leaving it loaded is how one driver's championship ends up
        // on another driver's front page.
        this.dropCareer();
        this.forgetWeekend();
        this.showMenu();
      },
      onEdit: (id) => this.showDriverCreate({ editing: id }),
      onDelete: (id) => {
        const p = this.profiles.get(id);
        if (!p) return;
        const careers = p.careers.length;
        const ok = confirm(
          'Delete ' + p.firstName + ' ' + p.lastName
          + (careers > 0
            ? ' and ' + (careers === 1 ? 'their career' : 'all ' + careers + ' of their careers')
            : '')
          + '? This cannot be undone.');
        if (!ok) return;
        if (this.profiles.active?.id === id) {
          this.dropCareer();
          this.forgetWeekend();
        }
        this.profiles.remove(id);
        if (this.profiles.active) this.showDrivers();
        else this.showDriverCreate({ firstRun: true });
      },
      onCreate: () => this.showDriverCreate({}),
      onOpenCareer: (profileId, careerId) => {
        if (profileId !== this.profiles.active?.id) {
          this.profiles.setActive(profileId);
          this.dropCareer();
          this.forgetWeekend();
        }
        this.openCareer(careerId);
      },
    });

    this.spacer(actions);
    this.button('New driver', actions, () => this.showDriverCreate({}), 'btn primary');
  }

  /**
   * Making a driver — the first screen of a first run, and the editor after.
   *
   * IT IS THE SIGNING SCREEN, not a second form that happens to ask the same
   * questions. `CareerCreate` already builds a driver you can see, in the
   * register the whole game sets names in, and having two screens that both
   * make a person would guarantee they drifted apart. What changes is the
   * frame around it: on a first run it says welcome and the button says "Start
   * driving"; from the rack it says edit and the button says "Save driver".
   */
  private showDriverCreate(opts: { firstRun?: boolean; editing?: string }): void {
    this.setScreen('driver-create');
    const editing = opts.editing ? this.profiles.get(opts.editing) : null;
    const first = opts.firstRun === true;

    const { body, actions } = this.page({
      tab: first ? '' : 'Drivers',
      where: first ? 'Welcome' : 'Driver',
      title: editing ? 'Edit driver' : first ? 'Who is driving?' : 'New driver',
      sub: editing
        ? 'Your name, your country, your number and your helmet. Careers you have '
          + 'already run keep the name they were run under.'
        : first
          ? 'Nothing has been played on this browser yet. Make a driver and the game '
            + 'is theirs — their name on the timing tower, their helmet in the car, '
            + 'their record on the front page. There is no account and nothing leaves '
            + 'this device.'
          : 'A second driver, with their own helmet, their own record and their own '
            + 'run at the ladder.',
      back: first ? undefined : () => this.showDrivers(),
    });
    this.screenRoot.classList.add('frontdoor');
    applyIdentityColours(this.screenRoot, editing?.helmet ?? null);

    // The seat this driver would be offered, so the panel on the right is
    // about something real rather than empty. Read from the roster so the
    // screen and the career cannot disagree about which team it is.
    const f3 = REAL_ROSTER.tiers.F3;
    const startTeam = f3.teams[f3.teams.length - 1];

    const create = buildCareerCreate(body, {
      seat: {
        teamName: startTeam.name,
        tierName: TIER_CAR.F3.name,
        rounds: f3.calendar.length,
        colour: startTeam.colour,
        accent: startTeam.accent,
      },
      takenNumbers: f3.drivers.map((d) => d.raceNumber),
      // No seat panel: this screen is making a person, not signing a contract.
      // The contract is `showCareerCreate`, and it is a different question.
      showSeat: false,
      initial: editing
        ? {
          firstName: editing.firstName,
          lastName: editing.lastName,
          nationality: editing.nationality,
          raceNumber: editing.raceNumber,
          helmet: editing.helmet,
        }
        : undefined,
      // The room behind the interface is relit as the helmet is painted, which
      // is the whole argument for the accent being the player's colour: you
      // can watch the front end become yours while you are making it.
      onChange: (id) => applyIdentityColours(this.screenRoot, id.helmet),
      onSubmit: (id) => {
        if (editing) {
          this.profiles.update(editing.id, {
            firstName: id.firstName,
            lastName: id.lastName,
            nationality: id.nationality,
            raceNumber: id.raceNumber,
            helmet: id.helmet,
          });
          this.showDrivers();
          return;
        }
        this.profiles.create(id);
        // A driver made on a machine that has already been shown the titles is
        // not made to watch them again.
        if (this.settings.introSeen) this.profiles.noteIntroSeen(this.profiles.active!.id);
        this.dropCareer();
        this.forgetWeekend();
        this.showMenu();
      },
    });

    this.spacer(actions);
    this.button(editing ? 'Save driver' : first ? 'Start driving' : 'Create driver',
      actions, () => create.submit(), 'btn primary');
  }
  /**
   * Signing on: the driver, and — in My Team — the driver before the team.
   *
   * ONE SCREEN, TWO CONTRACTS. `mode` decides whether the seat on the right is
   * the worst car in Formula 3 or an entry the player is about to found, and
   * whether "next" goes to the championship or to `showTeamCreate`. Splitting
   * it in two would mean two copies of the identity form, which is exactly how
   * the helmet on the timing tower and the helmet in the car used to disagree.
   */
  private showCareerCreate(mode: 'driver' | 'myteam' = 'driver'): void {
    this.setScreen('career-create');
    const owner = mode === 'myteam';
    const me = this.profiles.active;
    const { body, actions } = this.page({
      tab: 'Main Menu',
      where: owner ? 'My Team' : 'New Career',
      title: owner ? 'My Team' : 'New Career',
      sub: owner
        ? 'You are the owner and the lead driver. First, the driver.'
        : me
          ? 'One seat is open in Formula 3. It is the worst one on the grid, and it '
            + 'is yours if you want it. You are signing as ' + me.firstName + ' '
            + me.lastName + ' — change anything here and your driver changes with it.'
          : 'One seat is open in Formula 3. It is the worst one on the grid, '
            + 'and it is yours if you want it.',
      back: () => this.showMenu(),
      // The three tiers, as the three sectors of a career.
      rule: owner ? { parts: [1, 1, 1], at: 0 } : { parts: [9, 12, 11], at: 0 },
    });

    // The seat a rookie is actually offered: the weakest Formula 3 team, which
    // is exactly what `Career.create` hands them. Read from the roster rather
    // than named here, so the screen and the career cannot disagree about which
    // team is on the other end of the contract. An owner-driver is joining
    // Formula 1 as their own twelfth entry, so the grid they are measured
    // against — and the numbers already taken on it — is that one.
    const f3 = REAL_ROSTER.tiers.F3;
    const f1 = REAL_ROSTER.tiers.F1;
    const startTeam = f3.teams[f3.teams.length - 1];

    const create = buildCareerCreate(body, {
      seat: owner
        ? {
          teamName: 'Your own team',
          tierName: TIER_CAR.F1.name,
          rounds: f1.calendar.length,
          colour: 0x0f4d35,
          accent: 0xe0a72c,
        }
        : {
          teamName: startTeam.name,
          tierName: TIER_CAR.F3.name,
          rounds: f3.calendar.length,
          colour: startTeam.colour,
          accent: startTeam.accent,
        },
      // Numbers already on this grid. Choosing 22 and then discovering in the
      // first session that somebody else has it is not a discovery anybody
      // enjoys.
      takenNumbers: (owner ? f1 : f3).drivers.map((d) => d.raceNumber),
      // PREFILLED FROM THE DRIVER WHO IS PLAYING. A player who made a helmet
      // ten minutes ago and is now told to make one again has been asked the
      // same question twice, and the second answer is the one that ends up on
      // the timing tower — so the two used to be able to disagree.
      initial: me
        ? {
          firstName: me.firstName,
          lastName: me.lastName,
          nationality: me.nationality,
          raceNumber: me.raceNumber,
          helmet: me.helmet,
        }
        : undefined,
      onChange: (id) => applyIdentityColours(this.screenRoot, id.helmet),
      onSubmit: (id) => {
        // A career always belongs to a driver. Somebody who reached this screen
        // without one — an old deep link, a cleared profile index — gets one
        // made from what they just typed rather than an orphaned save.
        if (!this.profiles.active) this.profiles.create(id);
        // The team is founded on the next screen, and the career with it. The
        // driver has already been filed above, so an owner who backs out still
        // keeps the person they just made.
        if (owner) { this.showTeamCreate(id); return; }
        this.adoptCareer(Career.create({
          firstName: id.firstName,
          lastName: id.lastName,
          nationality: id.nationality,
          raceNumber: id.raceNumber,
          helmet: id.helmet,
        }), 'career-' + Date.now().toString(36));
        this.profiles.saveCareer(this.careerId, this.career!.state);
        this.showCareerHub();
      },
    });

    applyIdentityColours(this.screenRoot, me?.helmet ?? null);
    this.spacer(actions);
    this.button(owner ? 'Next: the team' : 'Take the seat', actions,
      () => create.submit(), 'btn primary');
  }

  /**
   * Founding the constructor: name, livery, engine and the second car.
   *
   * The whole screen is `src/ui/TeamCreate.ts`. What stays here is the page
   * chassis and the one button, exactly as with the driver's create screen —
   * and the disposal, because the screen owns a GL context of its own and
   * `page()` is the only place that knows a screen is being replaced.
   */
  private showTeamCreate(id: CreatedIdentity): void {
    this.setScreen('team-create');
    const seed = Math.floor(Date.now() % 2147483647);
    const { body, actions } = this.page({
      tab: 'My Team',
      where: 'My Team',
      title: 'Found the team',
      sub: 'Name it, paint it, sign an engine and fill the second seat. '
        + 'Everything here is spent out of the same $150M.',
      back: () => this.showCareerCreate('myteam'),
      rule: { parts: [1, 1, 1], at: 0 },
    });

    const create: TeamCreateHandle = buildTeamCreate(body, {
      seed,
      number: id.raceNumber,
      driverCode: id.lastName.slice(0, 3).toUpperCase(),
      quality: this.renderer.menuQuality,
      onSubmit: (team) => {
        const career = Career.createMyTeam({
          firstName: id.firstName,
          lastName: id.lastName,
          nationality: id.nationality,
          raceNumber: id.raceNumber,
          helmet: id.helmet,
          seed,
          team: {
            name: team.name,
            shortName: team.shortName,
            code: team.code,
            baseCountry: team.baseCountry,
            colour: team.colour,
            accent: team.accent,
            trim: team.design.trim,
            liveryFamily: team.design.family,
            liveryFinish: team.design.finish,
            liveryMark: team.design.mark,
          },
          teammate: team.teammate,
          powerUnitId: team.powerUnitId,
        });
        this.adoptCareer(career, 'career-' + Date.now().toString(36));
        this.profiles.saveCareer(this.careerId, career.state);
        this.showCareerHub();
      },
    });
    this.paintShop = create;

    this.spacer(actions);
    this.button('Enter the championship', actions, () => create.submit(), 'btn primary');
  }

  /**
   * The factory: the cost cap, the books, three departments and the pit crew.
   *
   * Every commission on it moves a `TeamPerformance` field. See
   * `src/career/MyTeam.ts` for the chain from a button here to `clBase`.
   */
  private showTeamHQ(): void {
    const career = this.career;
    if (!career?.myTeam) { this.showCareerHub(); return; }
    this.setScreen('team-hq');
    const t = career.myTeam;

    const { body, actions } = this.page({
      tab: t.name,
      where: 'Team HQ',
      title: 'Team HQ',
      sub: 'What the factory is building, and what it is costing you.',
      back: () => this.showCareerHub(),
      meta: [
        ['Round', Math.min(career.round + 1, career.calendar.length)
          + ' / ' + career.calendar.length],
        ['Bank', '$' + (t.cashUsd / 1e6).toFixed(1) + 'M'],
      ],
      rule: {
        parts: [
          Math.max(0, career.round), 1,
          Math.max(0, career.calendar.length - career.round - 1),
        ],
        at: 1,
      },
    });

    // MOUNTED ONCE AND REPAINTED IN PLACE. Rebuilding the page on every button
    // press — which is what this did first — flashes the screen and throws the
    // scroll position away on the busiest page in the mode. See `mountTeamHQ`.
    mountTeamHQ(body, {
      career,
      onChange: () => this.profiles.saveCareer(this.careerId, career.state),
      routes: {
        hq: () => this.showTeamHQ(),
        engine: () => this.showEngineDeal(),
        market: () => this.showDriverMarket(),
        prep: () => this.showPreparation(),
        hub: () => this.showCareerHub(),
      },
    });

    this.button('Paint shop', actions, () => this.showLiveryEditor(), 'btn ghost');
    this.button('Engine deal', actions, () => this.showEngineDeal(), 'btn ghost');
    this.button('Driver market', actions, () => this.showDriverMarket(), 'btn ghost');
    this.spacer(actions);
    this.button('Back to the hub', actions, () => this.showCareerHub(), 'btn primary');
  }

  /**
   * Preparation between rounds.
   *
   * `Career.spendPrepSlot` has been implemented and documented and reachable
   * from nowhere. Every branch of it moves something the simulation reads — a
   * driver attribute the AI's own model uses, a department morale that decides
   * what an upgrade costs and whether it passes quality control, a fan rating
   * that decides commercial income — and none of it could be touched by
   * anybody playing.
   */
  private showPreparation(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('team-hq');
    const { body, actions } = this.page({
      tab: TIER_CAR[career.tier].shortName,
      where: 'Preparation',
      title: 'Between rounds',
      sub: career.state.prepSlotsLeft + ' '
        + (career.state.prepSlotsLeft === 1 ? 'slot' : 'slots')
        + ' before the next race. Every one of these moves a number the car uses.',
      back: () => this.showCareerHub(),
      rule: {
        parts: [
          Math.max(0, career.round), 1,
          Math.max(0, career.calendar.length - career.round - 1),
        ],
        at: 1,
      },
    });

    // Mounted once and repainted in place, for the same reason Team HQ is:
    // rebuilding the page on every press flashes the screen and throws the
    // scroll away.
    const prep = buildPreparation(body, {
      career,
      onChange: () => {
        this.profiles.saveCareer(this.careerId, career.state);
        prep.refresh();
        slots.textContent = career.state.prepSlotsLeft + ' left';
      },
    });
    const slots = this.el('div', 'mt-why', body, career.state.prepSlotsLeft + ' left');

    this.spacer(actions);
    this.button('Back to the hub', actions, () => this.showCareerHub(), 'btn primary');
  }

  /** Five suppliers, ranked on the numbers that reach the car. */
  private showEngineDeal(): void {
    const career = this.career;
    if (!career?.myTeam) { this.showCareerHub(); return; }
    this.setScreen('team-hq');
    const { body, actions } = this.page({
      tab: career.myTeam.name,
      where: 'Engine deal',
      title: 'Engine deal',
      sub: 'Five manufacturers. Straight-line speed, deployment and reliability.',
      back: () => this.showTeamHQ(),
    });
    capGauge(body, career);
    engineDeal(body, {
      career,
      onChange: () => {
        this.profiles.saveCareer(this.careerId, career.state);
        this.showEngineDeal();
      },
    });
    this.spacer(actions);
    this.button('Back to the factory', actions, () => this.showTeamHQ(), 'btn primary');
  }

  /** Who could drive the second car. Real drivers, in this save's world. */
  private showDriverMarket(): void {
    const career = this.career;
    if (!career?.myTeam) { this.showCareerHub(); return; }
    this.setScreen('team-hq');
    const { body, actions } = this.page({
      tab: career.myTeam.name,
      where: 'Driver market',
      title: 'The second car',
      sub: 'They race the same physics you do, and they score for the team.',
      back: () => this.showTeamHQ(),
    });
    capGauge(body, career);
    driverMarket(body, {
      career,
      onChange: () => {
        this.profiles.saveCareer(this.careerId, career.state);
        this.showDriverMarket();
      },
    });
    this.spacer(actions);
    this.button('Back to the factory', actions, () => this.showTeamHQ(), 'btn primary');
  }

  /**
   * The paint shop.
   *
   * NO CAP GAUGE ON THIS SCREEN. Paint is not a development cost, and putting a
   * money instrument on the one screen where nothing is spent would make it
   * decoration everywhere else.
   */
  private showLiveryEditor(): void {
    const career = this.career;
    const t = career?.myTeam;
    if (!career || !t) { this.showCareerHub(); return; }
    this.setScreen('team-hq');
    const { body, actions } = this.page({
      tab: t.name,
      where: 'Paint shop',
      title: 'Paint shop',
      sub: 'Six patterns, three colours, three finishes and a mark. '
        + 'The car on the left is the one that goes racing.',
      back: () => this.showTeamHQ(),
    });

    const editor: LiveryEditorHandle = buildLiveryEditor(body, {
      initial: {
        colour: t.colour,
        accent: t.accent,
        design: coerceDesign({
          family: t.liveryFamily as never,
          trim: t.trim,
          finish: t.liveryFinish,
          mark: t.liveryMark,
        }),
      },
      number: career.state.player.raceNumber,
      code: career.state.player.code,
      quality: this.renderer.menuQuality,
    });
    this.paintShop = editor;

    this.spacer(actions);
    this.button('Paint it', actions, () => {
      const choice = editor.choice();
      career.applyLivery({
        colour: choice.colour,
        accent: choice.accent,
        trim: choice.design.trim,
        family: choice.design.family,
        finish: choice.design.finish,
        mark: choice.design.mark,
      });
      registerLiveryDesign(choice.colour, choice.accent, choice.design);
      this.profiles.saveCareer(this.careerId, career.state);
      this.showTeamHQ();
    }, 'btn primary');
  }

  private showCareerHub(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    this.setScreen('career-hub');
    const s = career.state;
    const team = getTeam(s.teamId);
    const ts = s.season.tiers[s.tier];
    const standings = sortedStandings(ts);
    const mine = standings.find((e) => e.driverId === s.playerDriverId);
    const champPos = Math.max(1, career.championshipPosition);
    const round = Math.min(career.round + 1, career.calendar.length);

    const { body, actions } = this.page({
      tab: TIER_CAR[s.tier].shortName + ' · ' + s.season.year,
      where: 'Career',
      title: s.player.firstName + ' ' + s.player.lastName,
      sub: team.name + ' · ' + s.player.nationality,
      back: () => this.showMenu(),
      meta: [
        ['Round', round + ' / ' + career.calendar.length],
        ['Points', String(mine?.points ?? 0)],
      ],
      // The season, in three parts: rounds done, the round in hand, the rest.
      rule: {
        parts: [
          Math.max(0, career.round),
          1,
          Math.max(0, career.calendar.length - career.round - 1),
        ],
        at: 1,
      },
    });

    // YOU, before your car.
    //
    // The hub used to open on a garage bay and six columns of figures, and a
    // career about a person had no person anywhere in it — "there is no figure,
    // there is no person, and there's no rendering happening of an actual
    // person". The card is the same driver the create screen made and the same
    // one that stands on the podium, so the protagonist is continuous across
    // the mode instead of being a string in a page title.
    driverCard(body, {
      helmet: playerHelmet(s),
      firstName: s.player.firstName,
      lastName: s.player.lastName,
      code: s.player.code,
      nationality: s.player.nationality,
      raceNumber: s.player.raceNumber,
      teamName: team.name,
      colour: team.colour,
      accent: team.accent,
      note: TIER_CAR[s.tier].name + ' · ' + s.season.year
        + ' · round ' + round + ' of ' + career.calendar.length,
    });

    // WHAT JUST HAPPENED, AND WHAT YOU ARE BEING ASKED TO DECIDE.
    //
    // Above the instruments, deliberately. The verdict on this mode was that it
    // is not clear what is going on or what you are supposed to do, and the hub
    // was the specific place that was true: it opened on six meters and a form
    // table, and everything the simulation had just done — a part delivered, a
    // championship position lost, a rival signed somebody, an idle factory —
    // went unreported. Both blocks are generated from state that already
    // exists; see `src/career/Newsroom.ts`.
    decisionList(body, career, {
      hq: () => this.showTeamHQ(),
      engine: () => this.showEngineDeal(),
      market: () => this.showDriverMarket(),
      prep: () => this.showPreparation(),
    });
    newsFeed(body, career, 5);

    // Your own car, in your own garage.
    //
    // A BAY on the page rather than a backdrop behind the whole screen: the
    // hub is the densest page in the game — six figures, a form table, the
    // next round and a setup summary — and a full-height car standing behind
    // all of that is a collision, not a composition. Bounded, it is the one
    // picture on a page of numbers.
    const bay = this.el('div', 'garagebay', body);
    const bayInfo = this.el('div', 'garagebay-info', bay);
    const plate = this.el('div', 'nameplate', bayInfo);
    plate.style.setProperty('--team', hexColour(team.colour));
    plate.innerHTML =
      '<span class="nameplate-rank">' + s.player.raceNumber + '</span>' +
      '<span class="nameplate-name">' + escapeHtml(team.name) + '</span>';
    // In Formula 1 the engine is a supply deal worth naming. In the junior
    // formulae it is spec, so `team.engine` is already the championship's name
    // and printing both gave "Formula 3 · Formula 3 · your car".
    this.el('div', 'garagebay-line', bayInfo,
      s.tier === 'F1'
        ? team.engine + ' · ' + TIER_CAR[s.tier].shortName + ' · your car'
        : TIER_CAR[s.tier].shortName + ' · spec chassis · your car');

    this.mountStage('panel', {
      colour: team.colour,
      accent: team.accent,
      number: s.player.raceNumber,
      code: s.player.code,
    }, bay);

    // --- Driver and team state -------------------------------------------
    const seasonHead = this.el('div', 'section-title', body, 'Season so far');
    this.el('span', 'section-count', seasonHead,
      career.round + ' of ' + career.calendar.length + ' run');
    const statGrid = this.el('div', 'stat-grid', body);
    let statIndex = 0;
    const stat = (
      name: string, value: string, meta = '',
      opts: { hero?: boolean; meter?: number; band?: string } = {},
    ) => {
      const c = this.el('div',
        'stat' + (opts.hero ? ' hero' : '') + (opts.band ? ' ' + opts.band : ''), statGrid);
      c.style.setProperty('--i', String(statIndex++));
      this.el('div', 'stat-label', c, name);
      this.el('div', 'stat-value', c, value);
      if (meta) this.el('div', 'stat-meta', c, meta);
      // A 0..100 figure gets a meter, because "62" means nothing without the
      // scale and "out of 100" printed six times is six wasted lines.
      if (opts.meter !== undefined) {
        const m = this.el('div', 'stat-meter', c);
        const fill = this.el('span', opts.band ?? '', m);
        fill.style.width = clamp(opts.meter, 0, 100) + '%';
      }
    };
    // Bands read the same way everywhere: green is healthy, yellow is a
    // warning, red is trouble.
    const band = (v: number, invert = false) => {
      const x = invert ? 100 - v : v;
      return x >= 60 ? 'good' : x >= 30 ? 'warn' : 'bad';
    };

    const leading = champPos === 1 && (mine?.points ?? 0) > 0;
    stat('Championship', 'P' + champPos,
      (mine?.points ?? 0) + ' pts · ' + (mine?.wins ?? 0) + ' wins',
      leading ? { hero: true } : { hero: true, band: champPos <= 3 ? 'good' : 'plain' });
    const n = s.narrative;
    // Promotion is the only figure that matters in a junior season, so it is
    // stated as a fact rather than left to be inferred from a table.
    if (s.tier !== 'F1') {
      const up = champPos <= 2;
      stat('Promotion', up ? 'IN' : 'OUT',
        up ? 'top two go up at the end of the season'
          : 'P' + champPos + ' — the top two go up',
        { band: up ? 'good' : 'warn' });
    }
    stat('Reputation', String(Math.round(n.reputation)), 'better seats open above 60',
      { meter: n.reputation, band: band(n.reputation) });
    stat('Fans', String(Math.round(n.fanRating)), 'what the sport thinks of you',
      { meter: n.fanRating, band: band(n.fanRating) });
    // Pressure is the one figure where high is bad, so its band is inverted
    // and a high number goes red rather than green. It is not decoration: it is
    // subtracted from consistency in the car the physics actually builds.
    stat('Pressure', String(Math.round(n.pressure)), 'costs you consistency',
      { meter: n.pressure, band: band(n.pressure, true) });
    stat('Pace', (s.player.skill * 100).toFixed(0),
      'consistency ' + (s.player.consistency * 100).toFixed(0),
      { meter: s.player.skill * 100, band: band(s.player.skill * 100) });
    // An owner-driver has no contract to run down — they own the seat — so the
    // slot says what is actually true of them rather than printing the sentinel
    // the career stores to mean "never expires".
    if (career.myTeam) {
      stat('Contract', 'Owner',
        'you own ' + career.myTeam.shortName + ' and drive for it');
    } else {
      stat('Contract', s.contractYears + (s.contractYears === 1 ? ' year' : ' years'),
        s.seasonsInTier + ' ' + (s.seasonsInTier === 1 ? 'season' : 'seasons') +
        ' in ' + TIER_CAR[s.tier].shortName);
    }

    // --- Form -------------------------------------------------------------
    // The rounds already run, as a timesheet. This is the most characteristic
    // data the career holds and it was previously thrown away — the hub knew
    // every finishing position of the season and printed none of them.
    if (ts.results.length > 0) {
      const formHead = this.el('div', 'section-title', body, 'Form');
      this.el('span', 'section-count', formHead, ts.results.length + ' rounds');
      const b = this.board(body, ['Rnd', 'Circuit', 'Finish', 'Points', '']);
      b.classList.add('tboard-form');
      const pointsTable = TIER_CAR[s.tier].points;
      for (const [i, r] of ts.results.entries()) {
        const def = getCircuit(r.circuitId);
        const idx = r.order.indexOf(s.playerDriverId);
        const p = idx + 1;
        const dnf = r.retired.includes(s.playerDriverId);
        const pts = !dnf && idx >= 0 && idx < pointsTable.length ? pointsTable[idx] : 0;
        this.trow(b, {
          pos: String(r.round + 1),
          colour: hexColour(team.colour),
          code: def.countryCode,
          name: def.name,
          index: i,
          figs: [
            {
              text: dnf ? 'DNF' : 'P' + p,
              cls: dnf ? 'bad' : p === 1 ? 'best' : p <= 3 ? 'gain' : p <= 10 ? '' : 'dim',
            },
            { text: String(pts), cls: pts > 0 ? '' : 'none' },
          ],
          tag: r.fastestLapDriverId === s.playerDriverId
            ? { text: 'FL', cls: 'best' }
            : r.wetRace ? { text: 'Wet', cls: 'warn' } : undefined,
          state: !dnf && p === 1 ? 'best' : undefined,
        });
      }
    }

    // Honours: every championship the player has won, across every tier. Read
    // from the career's own history rather than from a separate titles list, so
    // it cannot disagree with what actually happened.
    const titles = s.history.filter(
      (h) => h.playerTier && h.championByTier[h.playerTier] === s.playerDriverId);
    if (titles.length > 0) {
      this.el('div', 'section-title', body, 'Honours');
      const t = this.el('div', 'stat-grid', body);
      for (const title of titles) {
        const c = this.el('div', 'stat hero', t);
        this.el('div', 'stat-label', c, String(title.year));
        this.el('div', 'stat-value', c,
          TIER_CAR[title.playerTier as keyof typeof TIER_CAR].shortName);
        this.el('div', 'stat-meta', c, "Drivers' Champion");
      }
    }

    // --- Next round -------------------------------------------------------
    if (career.seasonComplete) {
      this.el('div', 'section-title', body, 'Season complete');
      this.el('div', 'notice', body,
        'Every round has been run. Close the season to take your promotion, your ' +
        'contract offers and next year’s calendar.');

      if (career.myTeam) {
        this.button('Team HQ', actions, () => this.showTeamHQ(), 'btn ghost');
      }
      this.button('Standings', actions, () => this.showStandings(), 'btn ghost');
      this.spacer(actions);
      this.button('End Season', actions, () => {
        const before = career.tier;
        const outcome = career.endSeason();
        this.profiles.saveCareer(this.careerId, career.state);
        this.showOffSeason(before, outcome);
      }, 'btn primary');
      return;
    }

    const circuit = getCircuit(career.currentCircuitId);
    this.el('div', 'section-title', body, 'Round ' + round + ' — next up');

    const round1 = this.el('div', 'round-card', body);
    const art = this.el('div', 'round-map', round1);
    art.innerHTML = circuitSvg(circuit);
    const rtext = this.el('div', 'round-text', round1);
    this.el('div', 'round-name', rtext, circuit.name);
    this.el('div', 'round-official', rtext, circuit.officialName + ' · ' + circuit.city + ', ' + circuit.country);
    const rfacts = this.el('div', 'round-facts', rtext);
    const fact = (label: string, value: string) => {
      const f = this.el('div', 'round-fact', rfacts);
      this.el('div', 'cc-cell-label', f, label);
      this.el('div', 'cc-cell-value', f, value);
    };
    fact('Distance', (circuit.lengthM / 1000).toFixed(3) + ' km × ' + circuit.raceLaps);
    fact('Corners', String(circuit.corners?.length ?? 0));
    fact('Pole', formatLapTime(circuit.referencePoleTimeS));
    fact('Rain risk', Math.round(circuit.rainChance * 100) + '%');

    this.garageCard(body, circuit.id, () => this.showCareerHub());
    this.weekendLengthControls(body, circuit.id, () => this.showCareerHub());

    // A weekend left part-way through. Offered before anything else, because a
    // player who qualified on Saturday and came back on Sunday is looking for
    // exactly one thing, and the alternative — starting the weekend again —
    // would throw the grid they earned away.
    const resumable = this.resumableWeekend();
    if (resumable) {
      const next = (this.career?.state.weekendInProgress?.sessions[resumable.index] as
        SessionConfig | undefined)?.name ?? 'the next session';
      this.el('div', 'notice', body,
        'You are part-way through this weekend. ' + next + ' is next, and the '
        + 'grid qualifying has built so far is still yours.');
      this.button('Resume Weekend', actions, () => this.resumeWeekend(), 'btn ghost');
    }

    if (career.myTeam) {
      this.button('Team HQ', actions, () => this.showTeamHQ(), 'btn ghost');
    }
    this.button('Standings', actions, () => this.showStandings(), 'btn ghost');
    this.button('Practice Only', actions, () => {
      this.weekend = [this.sessionConfig('practice', 'Practice', circuit.id, 600, 0)];
      this.weekendIndex = 0;
      this.showBriefing(circuit.id);
    }, 'btn ghost');
    this.button('Simulate Race', actions, () => {
      const wet = Math.random() < circuit.rainChance;
      const result = career.simulatePlayerRound({ wet });
      career.recordPlayerRound(result);
      this.profiles.saveCareer(this.careerId, career.state);
      // The rostrum, then the press room, then whatever the paddock had to
      // say. Simulating a round used to jump from this button straight to a
      // narrative event, which is why a career player could run a whole
      // season without the podium screen ever being built once.
      this.showPodium(result, () => this.afterRace(result));
    }, 'btn ghost');
    this.spacer(actions);
    this.button('Race Weekend', actions, () => this.startWeekend(circuit.id), 'btn primary');
  }

  private showStandings(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('standings');

    const s = career.state;
    const rows = sortedStandings(s.season.tiers[s.tier]);
    const leader = rows[0];
    const done = career.round;
    const { body } = this.page({
      tab: TIER_CAR[s.tier].shortName,
      where: 'Championship',
      title: 'Championship',
      sub: s.season.year + ' · ' + (done === 0
        ? 'before the first round'
        : 'after ' + done + (done === 1 ? ' round' : ' rounds')),
      back: () => this.showCareerHub(),
      meta: leader ? [['Leader', career.displayName(leader.driverId)]] : [],
      rule: {
        parts: [Math.max(0, done), 1, Math.max(0, career.calendar.length - done - 1)],
        at: 1,
      },
    });

    // The gap to the lead is the number a championship table is read for, and
    // it was the one number the old table did not have.
    const topPoints = leader?.points ?? 0;
    const b = this.board(body, ['P', 'Driver', 'Points', 'Gap', 'Won']);
    b.classList.add('tboard-champ');
    for (const [i, e] of rows.entries()) {
      const team = e.teamId ? getTeam(e.teamId) : null;
      const me = e.driverId === s.playerDriverId;
      const gap = topPoints - e.points;
      const name = splitName(career.displayName(e.driverId));
      this.trow(b, {
        pos: String(i + 1),
        colour: team ? hexColour(team.colour) : undefined,
        team: team ?? undefined,
        code: career.displayCode(e.driverId),
        name: career.displayName(e.driverId),
        first: name.first,
        last: name.last,
        note: team ? team.name : undefined,
        index: i,
        figs: [
          { text: String(e.points), cls: e.points > 0 ? '' : 'none' },
          i === 0
            ? { text: '—', cls: 'best' }
            : { text: gap === 0 ? 'level' : '-' + gap, cls: 'dim' },
        ],
        tag: e.wins > 0 ? { text: e.wins + '×', cls: 'best' } : undefined,
        state: me ? 'me' : i === 0 ? 'best' : undefined,
      });
    }
  }

  private showSessionSelect(quick: boolean): void {
    this.setScreen('session-select');
    const circuit = getCircuit(this.quickCircuitId);

    const { body } = this.page({
      tab: quick && !this.career ? 'Quick Race' : 'Race Weekend',
      where: circuit.name,
      title: circuit.name,
      sub: circuit.officialName + ' · ' + circuit.city + ', ' + circuit.country,
      back: () => (this.career ? this.showCareerHub() : this.showMenu()),
      meta: [
        ['Lap', (circuit.lengthM / 1000).toFixed(3) + ' km'],
        ['Pole', formatLapTime(circuit.referencePoleTimeS)],
      ],
      // This circuit's own sector splits — so Monaco's rule and Spa's rule
      // are visibly different shapes.
      rule: this.circuitRule(circuit),
    });

    // The circuit itself, at the size it deserves: this is the decision the
    // screen is about, and the shape of the place tells you more about the
    // session ahead than any of the figures beside it.
    const hero = this.el('div', 'circuit-hero', body);
    const map = this.el('div', 'circuit-hero-map', hero);
    map.innerHTML = circuitSvg(circuit, { weight: 4.4 });
    const facts = this.el('div', 'circuit-hero-facts', hero);
    const fact = (label: string, value: string) => {
      const f = this.el('div', 'round-fact', facts);
      this.el('div', 'cc-cell-label', f, label);
      this.el('div', 'cc-cell-value', f, value);
    };
    fact('Grand Prix', circuit.raceLaps + ' laps');
    fact('Corners', String(circuit.corners?.length ?? 0));
    fact('Direction', circuit.clockwise ? 'Clockwise' : 'Anti-clockwise');
    fact('DRS zones', String(circuit.drsZones.length));
    fact('Downforce', circuit.downforceDemand >= 0.66 ? 'High'
      : circuit.downforceDemand >= 0.4 ? 'Medium' : 'Low');
    fact('Rain risk', Math.round(circuit.rainChance * 100) + '%');

    // The garage before the session, because the setup is a decision you make
    // about the car and then go and drive — not an afterthought at the bottom
    // of the page.
    this.garageCard(body, circuit.id, () => this.showSessionSelect(quick));

    // The sessions, as a board. A session has a length and a distance, and
    // those are the two figures you choose between — so they get columns
    // rather than being buried in a sentence on a card.
    this.el('div', 'section-title', body, 'Choose a session');
    const sessions = this.board(body, ['', 'Session', 'Runs for', 'Distance', '']);
    sessions.classList.add('tboard-sessions');

    const mins = (s: number) => Math.round(s / 60) + ' min';
    const lapsOf = (n: number) => n + ' laps · ' + ((circuit.lengthM * n) / 1000).toFixed(0) + ' km';
    let sIndex = 0;

    const option = (
      name: string, runsFor: string, distance: string,
      make: () => SessionConfig[], tag?: { text: string; cls?: string },
    ) => {
      this.trow(sessions, {
        name,
        index: sIndex++,
        figs: [
          { text: runsFor, cls: 'dim' },
          { text: distance },
        ],
        tag,
        onClick: () => {
          this.resetQualifying();
          this.weekend = make();
          this.weekendIndex = 0;
          // The briefing, not the session. Picking a session is choosing what
          // to do; it is not the same act as being ready to drive, and the
          // grid slot, the weather and the tyres allocated are all things you
          // want to have seen BEFORE the lights.
          this.showBriefing(circuit.id);
        },
      });
    };

    // Lengths come from the weekend settings rather than the format's own
    // constants, so the figures in these columns are the figures the session
    // will actually run to. A row that says 22 min and then runs 18 is worse
    // than no figure at all.
    const opts = this.settings.weekend;
    const raceLaps = raceLapsFor(circuit.raceLaps, opts);
    const quali = qualifyingSegmentsFor(opts, circuit.referencePoleTimeS);
    const practice = practiceSegmentsFor(opts);
    const practiceS = practice[0]?.durationS ?? 600;
    const sprintLaps = Math.max(5, Math.round(circuit.raceLaps * 0.25));
    const qualTotal = quali.reduce((a, q) => a + q.durationS, 0);
    const practiceTotal = practice.reduce((a, p) => a + p.durationS, 0);

    option('Free Practice', mins(practiceS), 'Open running',
      () => [this.sessionConfig('practice', 'Free Practice', circuit.id, practiceS, 0)]);
    option('Qualifying', mins(qualTotal), 'Q1 · Q2 · Q3',
      () => quali.map((q) =>
        this.sessionConfig('qualifying', q.name, circuit.id, q.durationS, 0,
          { qualifyingPhase: q.phase, advancing: q.advancing })),
      { text: 'Knockout', cls: 'warn' });
    option('Sprint Race', '—', lapsOf(sprintLaps),
      () => [this.sessionConfig('race', 'Sprint', circuit.id, 0, sprintLaps)]);
    option('Grand Prix', '—', lapsOf(raceLaps),
      () => [this.sessionConfig('race', 'Grand Prix', circuit.id, 0, raceLaps)],
      raceLaps === circuit.raceLaps
        ? { text: 'Full', cls: 'go' }
        : { text: Math.round((raceLaps / circuit.raceLaps) * 100) + '%', cls: 'warn' });
    option('Full Weekend', mins(practiceTotal + qualTotal), 'FP1-3 · Q · Race',
      () => this.weekendSessions(circuit.id),
      { text: 'All', cls: 'best' });

    // How long all of the above is, and the way to change it. Directly under
    // the board it governs, so the columns visibly move when it changes.
    this.weekendLengthControls(body, circuit.id, () => this.showSessionSelect(quick));

    const elseHead = this.el('div', 'section-title', body, 'Race somewhere else');
    this.el('span', 'section-count', elseHead, CIRCUITS.length + ' circuits');
    const other = this.el('div', 'grid-circuits', body);
    for (const [i, c] of CIRCUITS.entries()) {
      this.circuitCard(other, c, {
        selected: c.id === circuit.id,
        round: i + 1,
        index: i,
        onClick: () => {
          this.quickCircuitId = c.id;
          this.showSessionSelect(quick);
        },
      });
    }
  }

  /** The team whose car the player is driving. */
  private playerTeam(): Team {
    return getTeam(this.career ? this.career.state.teamId : DRIVERS[0].teamId);
  }

  /**
   * The player's setup for a circuit, creating the engineers' baseline if there
   * is not one yet.
   *
   * A setup carried over from a different circuit is not a choice, it is a
   * leftover, so moving circuits starts again from that circuit's baseline. A
   * Monaco wing level at Monza is not something anyone meant to select.
   */
  private ensureSetup(circuitId: string): CarSetup {
    if (!this.playerSetup || this.playerSetupCircuitId !== circuitId) {
      this.playerSetup = defaultSetupFor(getCircuit(circuitId));
      this.playerSetupCircuitId = circuitId;
    }
    return this.playerSetup;
  }

  /**
   * The garage banner: what the car is currently set up to do, and the way in
   * to change it.
   *
   * This exists because the setup sheet was previously a secondary button in a
   * row at the very bottom of the session screen, below the whole circuit list
   * — off the bottom of a laptop screen, and something you had to go looking
   * for. A player who never found it never knew the car had a setup at all.
   *
   * Putting the resulting numbers on the way in fixes both halves of that: the
   * page is now unmissable, and the setup stops being a menu and becomes a
   * stated property of the car you are about to drive. The numbers come from
   * the same `applySetup` the physics runs, so this card is the first place the
   * chain from slider to car is visible.
   */
  private garageCard(parent: HTMLElement, circuitId: string, back: () => void): void {
    const circuit = getCircuit(circuitId);
    const setup = this.ensureSetup(circuitId);
    // The same expression the setup sheet and the briefing use, so the tyre
    // named on this card is the tyre the car will be on.
    const compound = this.raceStartCompound(circuitId) ?? this.playerCompound ?? 'medium';
    const s = setupSummary(this.playerTeam(), circuit, setup, compound);

    this.el('div', 'section-title', parent, 'Your car');
    const card = this.el('div', 'garage-card', parent);

    const text = this.el('div', 'garage-text', card);
    const head = this.el('div', 'garage-head', text);
    this.el('span', '', head, this.playerTeam().name + ' · ' + circuit.name);
    this.el('span', 'garage-tag' + (s.modified ? ' modified' : ''), head,
      s.modified ? 'your setup' : 'engineers’ baseline');
    this.el('div', 'garage-headline', text, s.headline);
    this.el('div', 'garage-detail', text, s.detail);

    this.button('Car Setup', this.el('div', 'garage-action', card),
      () => this.showSetup(circuitId, back));
  }

  /**
   * The car setup sheet, reachable before a session starts.
   *
   * Everything on it writes into `this.playerSetup`, which `launchSession` feeds
   * through `applySetup` into the player's car. Nothing is applied to a session
   * already in progress — a real setup change means going back to the garage,
   * and mutating the spec of a car mid-lap would invalidate the lap it is on.
   */
  /**
   * The tyre the player's race starts on, or null when this weekend's current
   * session is not a race.
   *
   * One expression, called by every screen that MENTIONS the grid tyre —
   * briefing, garage card, setup sheet — so that mentioning it cannot become
   * a second way of setting it. `plannedStrategy` falls back to the
   * strategist's recommendation, so this is right before the player has ever
   * opened the strategy page.
   */
  private raceStartCompound(circuitId: string): CompoundId | null {
    const config = this.weekend[this.weekendIndex];
    if (!config || config.kind !== 'race') return null;
    const circuit = getCircuit(circuitId);
    const plan = plannedStrategy(
      this.playerTeam(), this.playerDriverRecord(), circuit,
      config.laps || circuit.raceLaps,
      this.playerStrategyCircuitId === circuitId
        ? this.playerStrategy[this.playerDriverId()]
        : undefined,
    );
    return startingCompound(plan);
  }

  private showSetup(circuitId: string, back: () => void): void {
    const circuit = getCircuit(circuitId);
    const setup = this.ensureSetup(circuitId);

    this.setScreen('setup');
    const { body, actions } = this.page({
      tab: 'Garage · ' + circuit.name,
      where: 'Garage',
      rule: this.circuitRule(circuit),
      title: 'Car Setup',
      sub: 'Every slider changes a number the physics integrates, not a rating. ' +
        'The readout at the top is what the car will actually do.',
      back,
      meta: [
        ['Team', this.playerTeam().shortName],
        ['Downforce', circuit.downforceDemand >= 0.66 ? 'High'
          : circuit.downforceDemand >= 0.4 ? 'Medium' : 'Low'],
      ],
    });

    // For a race the grid tyre belongs to the strategy page and this sheet
    // states it. Asking a third time here is a third answer to one question.
    const raceStart = this.raceStartCompound(circuitId);

    buildSetupScreen(body, {
      setup,
      compound: raceStart ?? this.playerCompound ?? 'medium',
      team: this.playerTeam(),
      track: circuit,
      offerWets: circuit.rainChance > 0.08,
      compoundLocked: raceStart !== null,
      // The sheet updates its own readouts as the sliders move; this only has
      // to remember the choice. Re-rendering the screen from here would destroy
      // the slider mid-drag.
      onChange: (setup, compound) => {
        this.playerSetup = setup;
        this.playerCompound = compound;
      },
    });

    this.button('Reset to baseline', actions, () => {
      this.playerSetup = defaultSetupFor(circuit);
      this.playerCompound = null;
      this.showSetup(circuitId, back);
    }, 'btn ghost');
    this.spacer(actions);
    this.button('Done', actions, back, 'btn primary');
  }

  /**
   * The paddock: every team, its car and its drivers.
   *
   * Read-only outside a career. Inside one it also marks the player's current
   * team, which turns it into a way of sizing up the machinery you are actually
   * racing against rather than just a roster.
   */
  private showPaddock(): void {
    this.setScreen('paddock');
    // No title and no prose: the car IS the title, and a paragraph laid over
    // a photograph of it would be the one thing on the screen asking to be
    // read instead of looked at. What the screen means is said by the
    // nameplate and by the bars, both of which are shorter than a sentence.
    const { body, actions } = this.page({
      tab: 'Main Menu',
      where: 'Paddock',
      back: () => this.showMenu(),
    });
    body.classList.add('showcase-body');

    const stage = this.mountStage('full', {
      colour: PADDOCK_ORDER[0].colour,
      accent: PADDOCK_ORDER[0].accent,
    });

    const handle: PaddockHandle = buildPaddock(body, {
      currentTeamId: this.career?.state.teamId,
      // Every change of team refits the livery on the car already standing
      // there. `buildCar` shares geometry and materials through its own cache,
      // so this is one livery canvas and nothing else.
      onShow: (team) => {
        const drivers = DRIVERS.filter((d) => d.teamId === team.id)
          .sort((a, b) => a.raceNumber - b.raceNumber);
        stage?.setLivery({
          colour: team.colour,
          accent: team.accent,
          number: drivers[0]?.raceNumber,
          code: drivers[0]?.code,
        });
      },
    });

    // Walking the field. The blades are anchored to the page rather than to
    // the scrolling body, so they stay under the thumb wherever the panels
    // have been scrolled to.
    const page = this.screenRoot.querySelector('.page') as HTMLElement;
    const blade = (dir: -1 | 1, label: string, d: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chev chev-' + (dir < 0 ? 'prev' : 'next');
      b.setAttribute('aria-label', label);
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="square"><path d="' + d + '"/></svg>';
      b.addEventListener('click', () => handle.step(dir));
      page.appendChild(b);
    };
    blade(-1, 'Previous team', 'M15 4 L7 12 L15 20');
    blade(1, 'Next team', 'M9 4 L17 12 L9 20');

    // The arrow keys walk the grid too. On a screen whose whole job is left
    // and right, the keyboard should not have to hunt for the blades. The
    // listener hangs off the page, which is thrown away on navigation — on
    // `screenRoot`, which is not, it would accumulate one per visit.
    page.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); handle.step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); handle.step(1); }
    });

    // INTO THE BAY. `GarageScene` is drawn with a car-shaped hole in the
    // middle of it precisely so a real `CarStage` can stand in front of it,
    // and the paddock is the one screen in the game that already has a team
    // selected and a car built for it. Whichever team is on the stage is the
    // team whose garage this opens.
    this.button('Into the garage', actions,
      () => this.showGarage(handle.current().id), 'btn ghost');
    this.spacer(actions);
    this.button('Quick Race', actions, () => this.showSessionSelect(true), 'btn primary');
  }

  /**
   * THE GARAGE BAY — issue #38.
   *
   * `src/ui/GarageScene.ts` was 236 lines that only `npm run shoot:people` had
   * ever executed: no import, no screen id and no button anywhere in this file.
   * It is the bay under the grandstand — shutter up, the team's colour across
   * the back wall, the principal standing where a principal stands and the
   * crew working behind him — and it was built with a deliberate CAR-SHAPED
   * HOLE so that the canonical `CarStage` could stand in it rather than a
   * second, flat, drifting drawing of the same car. That is what happens here.
   *
   * Reached from the paddock, for the team standing on the paddock's stage.
   * `probe:smoke` walks that route as a required screen.
   */
  private showGarage(teamId: string): void {
    this.setScreen('garage');
    const team = getTeam(teamId);
    const drivers = DRIVERS.filter((d) => d.teamId === team.id)
      .sort((a, b) => a.raceNumber - b.raceNumber);
    const { body, actions } = this.page({
      tab: 'Paddock',
      where: 'Garage',
      title: team.name,
      sub: 'The bay, the crew and the car that comes out of it.',
      back: () => this.showPaddock(),
    });

    const bay = buildGarage(body, {
      teamId: team.id,
      teamName: team.name,
      colour: team.colour,
      accent: team.accent,
      crew: 3,
      principal: true,
      // Stable, so a team's bay is the same bay every time it is opened.
      seed: team.id.length * 31 + team.colour,
    });
    // The hole in the middle of the drawing, as a positioned box. `.garage` is
    // already `position: relative`, so the stage's own `inset` rule lands
    // inside the bay rather than behind the page.
    const hole = this.el('div', 'garage-car', bay);
    this.mountStage('panel', {
      colour: team.colour,
      accent: team.accent,
      number: drivers[0]?.raceNumber,
      code: drivers[0]?.code,
    }, hole);

    this.spacer(actions);
    this.button('Back to the paddock', actions, () => this.showPaddock(), 'btn primary');
  }

  /**
   * SETTINGS — eight tabs, and everything the game holds is under one of them.
   *
   * See `src/ui/SettingsScreen.ts` for why a rail rather than a scroll. What
   * lives here is the wiring: which setting each control reads and writes, and
   * what has to happen live as well as be saved. Two rules run through all of
   * it:
   *
   *   EVERY CHANGE IS SAVED AT ONCE. No Apply, no Cancel.
   *   EVERY CHANGE THAT CAN BE APPLIED LIVE IS. A camera picked here moves the
   *     camera now; a difficulty picked here reaches the cars in the session
   *     that is already running. A setting that needs a restart to take effect
   *     is a setting the player will believe is broken.
   *
   * @param back where Back goes. Supplied when Settings was opened from the
   * pause menu, so a player changing an assist mid-session lands back in the
   * session rather than at the main menu with the race thrown away.
   */
  private showSettings(back?: () => void): void {
    this.setScreen('settings');
    const { body, actions } = this.page({
      tab: back ? 'Session' : 'Main Menu',
      where: 'Settings',
      title: 'Settings',
      sub: 'Every change here is saved and applied the moment you make it.',
      back: () => (back ? back() : this.career ? this.showCareerHub() : this.showMenu()),
    });
    this.screenRoot.classList.add('frontdoor');
    applyIdentityColours(this.screenRoot, this.profiles.active?.helmet ?? null);

    const save = () => this.saves.saveSettings(this.settings);
    const repaint = () => this.showSettings(back);
    const s = this.settings;

    const tabs: SettingsTab[] = [
      {
        id: 'opposition',
        label: 'Opposition',
        title: 'Opposition',
        note: 'How hard the other nineteen cars are to race. It is the setting '
          + 'that changes this game most.',
        build: (panel, k) => {
          k.choice(panel, {
            name: 'Difficulty',
            value: s.aiDifficulty,
            options: (['easy', 'medium', 'hard'] as const).map((id) => ({
              id, label: AI_DIFFICULTIES[id].label, note: AI_DIFFICULTIES[id].blurb,
            })),
            onChange: (id) => {
              s.aiDifficulty = id;
              // Applied live as well as saved, so a player who changes it
              // mid-weekend sees it immediately instead of wondering whether
              // it took.
              for (const car of this.engine?.cars ?? []) car.ai?.setDifficulty(id);
              save();
              repaint();
            },
          });
          k.block(panel, {
            head: 'What it changes',
            line: 'The pace the field runs at, how hard they defend, and how often '
              + 'they make a mistake you can use.',
            note: 'It does not change your car. Every tier of this ladder gives you '
              + 'the machine your team can afford and nothing else.',
          });
        },
      },
      {
        id: 'driving',
        label: 'Driving',
        title: 'Driving and assists',
        note: 'Assists are off by default. The car is the same either way — an '
          + 'assist limits what your input can ask for, it does not change the machine.',
        build: (panel, k) => {
          k.toggle(panel, {
            name: 'Speed-sensitive steering',
            note: 'Reduces lock as speed rises, as a real rack does.',
            value: s.speedSensitiveSteering,
            onChange: (v) => {
              s.speedSensitiveSteering = v;
              this.input.config.speedSensitiveSteering = v;
              save(); repaint();
            },
          });
          k.toggle(panel, {
            name: 'Traction assist',
            note: 'Caps the throttle at the rear axle grip limit.',
            value: s.tractionAssist,
            onChange: (v) => {
              s.tractionAssist = v;
              this.input.config.tractionAssist = v;
              save(); repaint();
            },
          });
          k.toggle(panel, {
            name: 'Braking assist',
            note: 'Prevents locking the fronts.',
            value: s.brakingAssist,
            onChange: (v) => {
              s.brakingAssist = v;
              this.input.config.brakingAssist = v;
              save(); repaint();
            },
          });
          k.toggle(panel, {
            name: 'Racing line',
            note: 'The optimal line on the track, coloured green to red by '
              + 'approach speed.',
            value: s.racingLine,
            onChange: (v) => {
              s.racingLine = v;
              this.renderer.setRacingLineVisible(v);
              save(); repaint();
            },
          });
        },
      },
      {
        id: 'controls',
        label: 'Controls',
        title: 'Controls',
        note: 'A gamepad or a wheel needs binding and calibrating; a keyboard '
          + 'needs neither, so it is listed rather than configured.',
        build: (panel, k) => {
          const pads = this.input.gamepads.list();
          k.block(panel, {
            head: pads.length === 0 ? 'No controller detected'
              : pads.length === 1 ? '1 device' : pads.length + ' devices',
            line: pads.length > 0 ? pads[0].id : 'Keyboard and touch',
            note: pads.length > 0
              ? 'Bind every control, calibrate the axes and pedals, shape the '
                + 'steering curve, and set up rumble.'
              : 'Connect a gamepad or wheel and press a button on it — browsers hide '
                + 'a controller from a page until it has been used. Keyboard and '
                + 'touch keep working either way.',
          });
          const row = k.el('div', 'drv-actions', panel);
          const open = k.button('btn primary', row, () => this.showControllerSetup());
          open.textContent = 'Controller setup';

          if (this.input.touchAvailable) {
            k.toggle(panel, {
              name: 'Tilt steering',
              note: 'Steer by tilting the phone. Needs permission from the browser.',
              value: this.input.tiltEnabled,
              onChange: (v) => {
                void (async () => {
                  if (!v) {
                    this.input.disableTilt();
                    s.tiltSteering = false;
                  } else {
                    const ok = await this.input.enableTilt();
                    s.tiltSteering = ok;
                    if (!ok) alert('Device orientation is not available or was declined.');
                  }
                  save(); repaint();
                })();
              },
            });
          }

          k.el('div', 'set-panel-note', panel, 'Keyboard');
          const keys = k.el('div', 'opt-keys', panel);
          const KEYS: [string, string][] = [
            ['↑ / W', 'Accelerate'],
            ['B / Space', 'Brake'],
            ['↓', 'Brake, then reverse when stopped'],
            ['← →', 'Steer'],
            ['Shift', 'DRS, where it is available'],
            ['E', 'Cycle ERS mode'],
            ['C', 'Change camera'],
            ['L', 'Call yourself into the pits'],
            ['P', 'Pause'],
            ['R', 'Show the racing line'],
            ['H', 'Show the controls in a session'],
          ];
          for (const [key, what] of KEYS) {
            const r = k.el('div', 'opt-key', keys);
            k.el('kbd', '', r, key);
            k.el('span', '', r, what);
          }
          if (this.input.touchAvailable) {
            k.el('div', 'opt-block-note', panel,
              'On a touchscreen the pedals and the steering pad appear over the '
              + 'track once a session starts.');
          }
        },
      },
      {
        id: 'camera',
        label: 'Camera',
        title: 'Camera',
        note: 'Where you sit. Changed here or with C at any point in a session.',
        build: (panel, k) => {
          k.choice(panel, {
            name: 'View',
            value: s.cameraMode,
            options: CAMERA_MODES.map((m) => ({ id: m as string, label: CAMERA_LABELS[m] })),
            onChange: (mode) => {
              s.cameraMode = mode;
              this.renderer.director.setMode(mode as CameraMode);
              save(); repaint();
            },
          });
        },
      },
      {
        id: 'audio',
        label: 'Audio',
        title: 'Audio',
        note: 'One engine, one set of tyres, and the pit wall. Nothing here is a '
          + 'recording; the engine note is synthesised from the crank speed.',
        build: (panel, k) => {
          k.slider(panel, {
            name: 'Master volume',
            note: 'Zero silences the game entirely.',
            value: Math.round(s.masterVolume * 100),
            min: 0, max: 100, step: 5,
            onInput: (v) => {
              // Live while the thumb moves, because a volume you cannot hear
              // while you set it is a volume you cannot set.
              this.audio.setVolume(v / 100);
              this.audio.setEnabled(v > 0);
            },
            onCommit: (v) => {
              s.masterVolume = v / 100;
              this.audio.setVolume(s.masterVolume);
              this.audio.setEnabled(s.masterVolume > 0);
              if (s.masterVolume > 0) this.audio.playUiClick();
              save();
            },
          });
          // THE ONE SWITCH FOR THE SPOKEN RADIO. There used to be a second one
          // — a 🔊 pip on the radio card itself, backed by its own
          // `localStorage` flag and its own `speechSynthesis` client — and two
          // off-switches for one feature is the complaint this whole piece of
          // work exists to answer. The card's pip is gone; this row is the
          // feature's only control and `GameSettings.teamRadioVoice` its only
          // memory.
          //
          // It sits under Audio rather than in its own tab because it is a
          // sound, but it is deliberately a separate row from the volume
          // slider: everything else in the mix is synthesised from the
          // simulation and this is the operating system's own voice, which
          // cannot be routed through WebAudio and therefore cannot be
          // processed on the way past. See `src/audio/RadioChain`.
          //
          // TURNING IT ON IS A USER GESTURE, and that matters on iOS. WebKit
          // requires user activation before `speechSynthesis.speak()` will
          // make a sound, and every call the radio makes afterwards is from a
          // `setTimeout` — outside activation. `primeSpeech()` spends this
          // click on a silent utterance so the engine is unlocked before the
          // first transmission. See `TeamRadio.primeSpeech`.
          if (TeamRadio.supported) {
            k.toggle(panel, {
              name: 'Spoken team radio',
              note: 'Reads the pit wall and your driver aloud, in your device’s '
                + 'own voice. The radio card types either way.',
              value: s.teamRadioVoice,
              onChange: (v) => {
                s.teamRadioVoice = v;
                if (v) this.audio.radio.primeSpeech();
                this.audio.radio.setEnabled(v);
                if (s.masterVolume > 0) this.audio.playUiClick();
                save(); repaint();
              },
            });
          }
        },
      },
      {
        id: 'video',
        label: 'Video',
        title: 'Video',
        note: 'What the renderer is allowed to spend. Auto starts from what the '
          + 'device says and then measures what it can actually hold; the four '
          + 'switches below override the tier one item at a time.',
        // ISSUE #29. What was here offered `auto | low | high` and said a change
        // needed a new session. Both halves were wrong: two tiers cannot
        // describe a phone — `low` withheld the post chain, the shadow map, MSAA
        // and half the geometry as one indivisible decision, and every
        // touch-primary device got it — and three of the four are changeable
        // where you stand. Everything here goes through `Renderer.setGraphics`,
        // which returns what it could not apply, and this screen says so rather
        // than claiming a change that has not happened.
        build: (panel, k) => {
          const r = this.renderer;
          const f = r.features;
          // Pushes the whole preference state at the renderer. Idempotent, so
          // every control can call the same function.
          const push = () => {
            const applied = r.setGraphics(s.quality, s.graphics);
            save();
            this.pendingVideo = applied;
            repaint();
          };
          k.choice(panel, {
            name: 'Quality',
            value: s.quality,
            options: [
              {
                id: 'auto' as const, label: 'Auto',
                note: 'Starts from what the device reports and then measures it. '
                  + 'A browser will not say how fast a phone is — every iPhone '
                  + 'reports the same core count — so this watches the frame '
                  + 'time instead and moves up or down on what it finds.',
              },
              {
                id: 'low' as const, label: 'Low',
                note: 'No post-processing, no shadows, no antialiasing, fewer '
                  + 'particles and simpler geometry. For a device that is '
                  + 'struggling.',
              },
              {
                id: 'medium' as const, label: 'Medium',
                note: 'Full geometry and the post-processing chain — bloom, the '
                  + 'colour grade and contact shading — without the shadow map '
                  + 'or antialiasing, which are the two most expensive items.',
              },
              {
                id: 'high' as const, label: 'High',
                note: 'Everything: shadows, antialiasing, the full post chain and '
                  + 'the complete weather effects.',
              },
            ],
            onChange: (v) => { s.quality = v as 'auto' | QualityTier; push(); },
          });

          // The four switches. Each is `auto` — follow the tier — or forced.
          const sw = (
            name: string, key: 'post' | 'shadows' | 'msaa', on: boolean, note: string,
          ) => {
            k.choice(panel, {
              name,
              value: s.graphics[key],
              options: [
                { id: 'auto' as const, label: 'Auto', note: note + ' Following the tier: currently ' + (on ? 'on' : 'off') + '.' },
                { id: 'on' as const, label: 'On', note },
                { id: 'off' as const, label: 'Off', note },
              ],
              onChange: (v) => { s.graphics[key] = v as GraphicsPref; push(); },
            });
          };
          sw('Post-processing', 'post', f.post,
            'Bloom, the colour grade and contact occlusion. Four full-screen '
            + 'passes over the drawing buffer.');
          sw('Shadows', 'shadows', f.shadows,
            'Real sun shadows. Draws the scene a second time into a depth map '
            + 'every frame.');
          sw('Antialiasing', 'msaa', f.msaa,
            'Four-sample MSAA on the geometry edges. This one is an attribute '
            + 'of the graphics context and only changes when the page reloads.');

          k.choice(panel, {
            name: 'Resolution limit',
            value: s.graphics.resolution === 'auto' ? 'auto' : String(s.graphics.resolution),
            options: [
              {
                id: 'auto', label: 'Auto',
                note: 'Up to full resolution; the renderer lowers it on its own '
                  + 'when frames get slow and raises it again when they do not.',
              },
              ...RESOLUTION_CHOICES.map((v) => ({
                id: String(v),
                label: Math.round(v * 100) + '%',
                note: 'Never draw above ' + Math.round(v * 100) + '% of the native '
                  + 'resolution. The renderer may still go below it.',
              })),
            ],
            onChange: (v) => {
              s.graphics.resolution = v === 'auto' ? 'auto' : Number(v);
              push();
            },
          });

          const pend = this.pendingVideo;
          k.block(panel, {
            head: 'Running now',
            line: TIER_LABEL[f.tier]
              + (f.adaptive ? ' — auto, measured' : ' — set by you')
              + '  ·  post ' + (f.post ? 'on' : 'off')
              + '  ·  shadows ' + (f.shadows ? 'on' : 'off')
              + '  ·  AA ' + (f.msaa ? 'on' : 'off')
              + '  ·  ' + Math.round(r.resolutionScale * 100) + '% of '
              + Math.round(f.maxResolutionScale * 100) + '%',
            note: pend?.needsReload
              ? 'Antialiasing changes when the page is reloaded — it is fixed '
                + 'when the graphics context is created and cannot be moved on a '
                + 'live one. Everything else on this page is already in effect.'
              : pend?.needsNewSession
                ? 'The tier is in effect; the extra geometry detail arrives with '
                  + 'the next session, because the circuit and the cars are built '
                  + 'once and rebuilding them here would stall for seconds.'
                : 'In effect now. The post chain, the shadows and the resolution '
                  + 'limit all change without ending the session.',
          });
        },
      },
      {
        id: 'weekend',
        label: 'Weekend',
        title: 'Race weekend',
        note: 'How long a weekend runs. A preference about your evening rather '
          + 'than a fact about your championship, so it is kept here and not in '
          + 'the save.',
        build: (panel, k) => {
          const w = s.weekend;
          const c = getCircuit(this.career?.calendar[this.career.round] ?? this.quickCircuitId);
          k.choice(panel, {
            name: 'Race distance',
            value: w.raceDistance,
            options: RACE_DISTANCES.filter((d) => d.id !== 'custom').map((d) => ({
              id: d.id,
              label: d.label,
              note: d.blurb + ' — ' + raceLapsFor(c.raceLaps, { ...w, raceDistance: d.id })
                + ' laps at ' + c.name + '.',
            })),
            onChange: (v) => { w.raceDistance = v; save(); repaint(); },
          });
          k.choice(panel, {
            name: 'Session length',
            value: w.sessionLength,
            options: SESSION_LENGTHS.map((l) => ({ id: l.id, label: l.label, note: l.blurb })),
            onChange: (v) => { w.sessionLength = v; save(); repaint(); },
          });
          k.choice(panel, {
            name: 'Practice',
            value: String(w.practiceCount),
            options: [0, 1, 2, 3].map((n) => ({
              id: String(n),
              label: n === 0 ? 'None' : String(n),
              note: n === 0 ? 'Straight to qualifying.'
                : PRACTICE_SEGMENTS.slice(0, n).map((p) => p.name).join(', ') + '.',
            })),
            onChange: (v) => { w.practiceCount = Number(v); save(); repaint(); },
          });
          k.toggle(panel, {
            name: 'Run qualifying',
            note: w.runQualifying
              ? 'Q1, Q2 and Q3 decide the grid.'
              : 'The race starts from the championship order.',
            value: w.runQualifying,
            onChange: (v) => { w.runQualifying = v; save(); repaint(); },
          });
          k.block(panel, {
            head: 'A weekend at ' + c.name,
            line: weekendSummary(w, c.raceLaps, c.referencePoleTimeS),
          });
        },
      },
      {
        id: 'device',
        label: 'This device',
        title: 'This device',
        note: 'Where the game keeps what you have done, and how to get rid of it.',
        build: (panel, k) => {
          const drivers = this.profiles.list();
          const careers = drivers.reduce((n, p) => n + p.careers.length, 0);
          k.block(panel, {
            head: 'Storage',
            line: this.profiles.isEphemeral
              ? 'Blocked by this browser'
              : drivers.length + (drivers.length === 1 ? ' driver' : ' drivers')
                + ', ' + careers + (careers === 1 ? ' career' : ' careers'),
            note: this.profiles.isEphemeral
              ? 'Private browsing or a storage policy is preventing writes, so '
                + 'nothing you do now will survive a reload. Everything else works.'
              : 'Everything is in this browser. There is no account, no server and '
                + 'no network call — which is also why the game works offline.',
          });
          const row = k.el('div', 'drv-actions', panel);
          const manage = k.button('btn', row, () => this.showDrivers());
          manage.textContent = 'Manage drivers';
          const titles = k.button('btn', row, () => this.playIntro(() => this.showSettings(back)));
          titles.textContent = 'Play the opening titles';
          const wipe = k.button('btn danger', row, () => {
            if (!confirm('Delete every driver and every career stored in this browser? '
              + 'This cannot be undone.')) return;
            this.profiles.removeAll();
            this.dropCareer();
            this.forgetWeekend();
            this.showDriverCreate({ firstRun: true });
          });
          wipe.textContent = 'Erase everything';

          k.block(panel, {
            head: 'Build',
            line: 'F1SIM ' + VERSION,
            note: CIRCUITS.length + ' surveyed circuits, ' + TEAMS.length + ' teams, '
              + 'a 120Hz fixed-step vehicle model and a three-tier career. '
              + 'No team badge, sponsor artwork or driver likeness is reproduced.',
          });
        },
      },
    ];

    buildSettingsScreen(body, {
      tabs,
      active: tabs.some((t) => t.id === this.settingsTab) ? this.settingsTab : 'opposition',
      onTab: (id) => { this.settingsTab = id; repaint(); },
    });

    this.spacer(actions);
    this.button('Done', actions,
      () => (back ? back() : this.career ? this.showCareerHub() : this.showMenu()),
      'btn primary');
  }
  /**
   * The controller setup and calibration page.
   *
   * Everything on it writes straight into `this.settings.gamepad`, which is the
   * same object `InputController` reads its profile out of every frame — so a
   * deadzone moved here changes the steering on the very next poll, with no
   * apply step and nothing to forget to press. The screen is persisted on every
   * change rather than on exit, because a controller configuration that is lost
   * when the tab is closed is worse than no configuration at all.
   */
  private showControllerSetup(): void {
    this.setScreen('controller');
    const { body, actions } = this.page({
      tab: 'Settings',
      where: 'Controller',
      title: 'Controller',
      sub: 'Bindings, calibration and steering feel — for a gamepad or a wheel. ' +
        'Every bar on this page is live.',
      back: () => this.showSettings(),
    });

    this.controllerScreen = buildControllerScreen(body, {
      input: this.input,
      settings: this.settings.gamepad,
      onChange: () => this.saves.saveSettings(this.settings),
    });

    this.spacer(actions);
    this.button('Done', actions, () => this.showSettings());
  }

  // =======================================================================
  // Sessions
  // =======================================================================

  private sessionConfig(
    kind: SessionKind, name: string, circuitId: string,
    durationS: number, laps: number,
    extra: Partial<SessionConfig> = {},
  ): SessionConfig {
    void circuitId;
    return {
      kind, name, durationS, laps,
      playerIndex: 0,
      standingStart: kind === 'race',
      // Everything that is not a race start begins in the garage and leaves
      // down the pit lane, which is how a real practice or qualifying session
      // works. Only a race or a sprint forms up on the grid.
      pitLaneStart: kind !== 'race',
      // The opposition's level, chosen in Settings. Applied at construction, so
      // it takes effect from the next session rather than mid-lap.
      aiDifficulty: this.settings.aiDifficulty,
      seed: (Math.random() * 0x7fffffff) | 0,
      ...extra,
    };
  }

  /**
   * A full Grand Prix weekend in the real format.
   *
   * Three practice sessions, then knockout qualifying, then the race. The
   * qualifying segments are the part that matters: Q1 runs the whole field and
   * knocks out the slowest five, Q2 runs the surviving fifteen and knocks out
   * five more, and Q3 is a ten-car shootout for pole. Eliminated cars keep the
   * grid slots they earned, filled in from the back — so the final grid is Q3
   * order on rows one to five, then the Q2 casualties, then the Q1 casualties.
   *
   * Segment lengths follow the real ones: 18, 15 and 12 minutes, compressed
   * here because nobody wants to sit through 45 minutes of qualifying, but the
   * proportions and the knockout counts are the genuine article.
   */
  private weekendSessions(circuitId: string): SessionConfig[] {
    const c = getCircuit(circuitId);
    const opts = this.settings.weekend;
    const sessions: SessionConfig[] = [];

    // The lengths are the player's, but they are not taken on trust: a
    // qualifying segment is floored at whatever this circuit needs to classify
    // the field, because a Q1 too short to get everyone across the line does not
    // produce a shorter grid, it produces a grid decided by garage release
    // order. See `minimumQualifyingDurationS`.
    for (const fp of practiceSegmentsFor(opts)) {
      sessions.push(this.sessionConfig('practice', fp.name, circuitId, fp.durationS, 0));
    }
    if (opts.runQualifying) {
      for (const q of qualifyingSegmentsFor(opts, c.referencePoleTimeS)) {
        sessions.push(this.sessionConfig('qualifying', q.name, circuitId, q.durationS, 0,
          { qualifyingPhase: q.phase, advancing: q.advancing }));
      }
    }
    sessions.push(this.sessionConfig('race', 'Grand Prix', circuitId, 0,
      raceLapsFor(c.raceLaps, opts)));
    return sessions;
  }

  /**
   * The weekend-length controls.
   *
   * On the session screen rather than buried in Settings, because it is a
   * decision about the session you are about to start — "I have twenty minutes
   * tonight" is not a preference, it is the reason you are at this screen — and
   * because a player who cannot find it sits through a 57-lap Grand Prix they
   * did not want.
   */
  private weekendLengthControls(parent: HTMLElement, circuitId: string, back: () => void): void {
    const c = getCircuit(circuitId);
    const opts = this.settings.weekend;
    const commit = () => {
      this.saves.saveSettings(this.settings);
      back();
    };

    this.el('div', 'section-title', parent, 'Weekend length');
    this.el('div', 'card-meta', parent,
      weekendSummary(opts, c.raceLaps, c.referencePoleTimeS));

    // --- Race distance ----------------------------------------------------
    const dg = this.el('div', 'card-grid', parent);
    for (const d of RACE_DISTANCES) {
      const selected = opts.raceDistance === d.id;
      const card = this.el('div', 'card' + (selected ? ' selected' : ''), dg);
      this.el('div', 'card-name', card,
        d.id === 'custom' ? 'Custom' : d.label + ' — ' + raceLapsFor(c.raceLaps, {
          ...opts, raceDistance: d.id,
        }) + ' laps');
      this.el('div', 'card-meta', card, d.blurb);
      card.addEventListener('click', () => {
        opts.raceDistance = d.id;
        commit();
      });
    }

    if (opts.raceDistance === 'custom') {
      const field = this.el('div', 'field', parent);
      const label = document.createElement('label');
      label.textContent = 'Race laps (1–' + c.raceLaps + '+)';
      field.appendChild(label);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = '200';
      input.value = String(opts.customLaps);
      // On 'change', not 'input': re-rendering the screen on every keystroke
      // destroys the field the player is typing into.
      input.addEventListener('change', () => {
        opts.customLaps = clamp(Number(input.value) || 1, 1, 200);
        commit();
      });
      field.appendChild(input);
    }

    // --- Practice and qualifying -----------------------------------------
    this.el('div', 'section-title', parent, 'Practice and qualifying');
    const lg = this.el('div', 'card-grid', parent);
    for (const l of SESSION_LENGTHS) {
      const selected = opts.sessionLength === l.id;
      const q = qualifyingSegmentsFor({ ...opts, sessionLength: l.id }, c.referencePoleTimeS);
      const card = this.el('div', 'card' + (selected ? ' selected' : ''), lg);
      this.el('div', 'card-name', card, l.label);
      this.el('div', 'card-meta', card, l.blurb);
      this.el('div', 'card-stat', card,
        'Q1 ' + Math.round(q[0].durationS / 60) + ' min · FP ' +
        Math.round((practiceSegmentsFor({ ...opts, sessionLength: l.id })[0]?.durationS ?? 0) / 60) +
        ' min');
      card.addEventListener('click', () => {
        opts.sessionLength = l.id;
        commit();
      });
    }

    const cg = this.el('div', 'card-grid', parent);
    for (const n of [0, 1, 2, 3]) {
      const selected = opts.practiceCount === n;
      const card = this.el('div', 'card' + (selected ? ' selected' : ''), cg);
      this.el('div', 'card-name', card, n === 0 ? 'No practice' : n + ' practice');
      this.el('div', 'card-meta', card,
        n === 0 ? 'Straight to qualifying' : PRACTICE_SEGMENTS.slice(0, n).map((p) => p.name).join(', '));
      card.addEventListener('click', () => {
        opts.practiceCount = n;
        commit();
      });
    }

    const qg = this.el('div', 'card-grid', parent);
    for (const on of [true, false]) {
      const selected = opts.runQualifying === on;
      const card = this.el('div', 'card' + (selected ? ' selected' : ''), qg);
      this.el('div', 'card-name', card, on ? 'Run qualifying' : 'Skip qualifying');
      this.el('div', 'card-meta', card, on
        ? 'Q1, Q2 and Q3 decide the grid'
        : 'Start the race from the championship order');
      card.addEventListener('click', () => {
        opts.runQualifying = on;
        commit();
      });
    }
  }

  /**
   * Grid order built up across the qualifying segments.
   *
   * Index 0 is pole. Filled from the back as cars are knocked out, so by the
   * time Q3 finishes the whole grid is determined.
   */
  private qualifyingGrid: string[] = [];
  /**
   * Driver ids still in the qualifying fight.
   *
   * Kept so the results screen can say who advanced, and so a segment that
   * ends with nobody having set a lap still has a defined survivor set.
   */
  private qualifyingSurvivors: string[] = [];
  /**
   * Drivers who may take no further part in this qualifying session.
   *
   * Art. B4.3.2: a car that stops away from the pit lane and receives physical
   * assistance is out for the rest of the SESSION, and Q1/Q2/Q3 are three
   * periods of one session (Art. B2.4.2). So this accumulates across segments
   * and is only cleared by a new weekend.
   *
   * They are still entered and still classified. Being on this list costs a
   * driver the laps they would have set in the segments they miss and nothing
   * else — not the laps they have already set, and not their place in the
   * classification those laps earned.
   */
  private qualifyingBarred: string[] = [];

  /** Clears qualifying state at the start of a weekend. */
  private resetQualifying(): void {
    this.qualifyingGrid = [];
    this.qualifyingSurvivors = [];
    this.qualifyingBarred = [];
  }

  private startWeekend(circuitId: string): void {
    this.resetQualifying();
    this.weekend = this.weekendSessions(circuitId);
    this.weekendIndex = 0;
    this.rememberWeekend(circuitId);
    this.showBriefing(circuitId);
  }

  // =======================================================================
  // A weekend that survives the tab being closed
  // =======================================================================

  /**
   * Writes the weekend in progress into the career, and saves.
   *
   * The session queue, how far through it we are, and the grid qualifying has
   * built so far all lived only as fields on this object. So a player who
   * qualified on Saturday and closed the tab lost the qualifying: the career
   * reopened at the hub with the round unrun and everything the game had told
   * them about that weekend gone. "The results, the saves, everything has to be
   * there. It has to be saved."
   *
   * Called at every point the weekend moves — started, a session finished, a
   * qualifying segment resolved — because the only save frequency that is
   * actually correct for something a browser tab can close at any moment is
   * "after every change".
   */
  private rememberWeekend(circuitId: string): void {
    const career = this.career;
    if (!career) return;
    career.state.weekendInProgress = {
      circuitId,
      round: career.round,
      index: this.weekendIndex,
      sessions: this.weekend as unknown[],
      qualifyingGrid: [...this.qualifyingGrid],
      qualifyingSurvivors: [...this.qualifyingSurvivors],
      qualifyingBarred: [...this.qualifyingBarred],
    };
    this.profiles.saveCareer(this.careerId, career.state);
  }

  /** The weekend is over, or was abandoned. Nothing left to come back to. */
  private forgetWeekend(): void {
    const career = this.career;
    if (!career || !career.state.weekendInProgress) return;
    delete career.state.weekendInProgress;
    this.profiles.saveCareer(this.careerId, career.state);
  }

  /**
   * The weekend this career can be resumed into, if there is one.
   *
   * Guarded on the ROUND rather than only on existence: a weekend recorded
   * against round three is meaningless once round three has been scored and the
   * career has moved on, and resuming into it would run a round twice.
   */
  private resumableWeekend(): { circuitId: string; index: number } | null {
    const career = this.career;
    const w = career?.state.weekendInProgress;
    if (!career || !w) return null;
    if (w.round !== career.round) return null;
    if (!Array.isArray(w.sessions) || w.sessions.length === 0) return null;
    if (w.index >= w.sessions.length) return null;
    if (!CIRCUITS.some((c) => c.id === w.circuitId)) return null;
    return { circuitId: w.circuitId, index: w.index };
  }

  /** Puts a saved weekend back on screen where the player left it. */
  private resumeWeekend(): void {
    const career = this.career;
    const w = career?.state.weekendInProgress;
    if (!career || !w) { this.showCareerHub(); return; }
    this.weekend = w.sessions as SessionConfig[];
    this.weekendIndex = w.index;
    this.qualifyingGrid = [...w.qualifyingGrid];
    this.qualifyingSurvivors = [...w.qualifyingSurvivors];
    this.qualifyingBarred = [...w.qualifyingBarred];
    this.showBriefing(w.circuitId);
  }

  /**
   * Applies the result of one qualifying segment.
   *
   * Cars are ranked on their best lap of the segment; anyone without a lap goes
   * to the back. The slowest are knocked out and take the LAST available grid
   * slots, which is why the grid fills from the rear as qualifying progresses:
   * the Q1 casualties are locked into 16th-20th before Q2 has even started.
   *
   * The survivors are carried into the next segment through `participants`, so
   * Q2 runs fifteen cars and Q3 runs ten — the track is progressively emptier,
   * exactly as it is in reality.
   *
   * A retirement is not consulted anywhere in that. Art. B2.4.3a classifies a
   * driver on the best time they set and nothing else, so a car that put itself
   * in the barrier having topped the segment advances at the top of the
   * survivor list. What its accident DOES cost it is the right to run again
   * (Art. B4.3.2), which is carried separately in `qualifyingBarred`.
   */
  private resolveQualifyingSegment(
    engine: RaceEngine,
    phase: 1 | 2 | 3,
    advancing: number | undefined,
  ): void {
    const idOf = (c: CarEntry) => (c.isPlayer ? 'PLAYER' : c.driver.id);
    const ranked = this.rankSegment(engine);

    const indexById = new Map<string, number>();
    for (const c of engine.cars) indexById.set(idOf(c), c.index);
    this.applyQualifyingOrder(
      ranked.map((c) => ({ id: idOf(c), retired: c.retired })), indexById, advancing);
    void phase;
  }

  /**
   * This qualifying segment's runners, ranked by their best lap of it.
   *
   * No lap set goes to the back of the queue. Shared between the grid
   * resolution and the results board on purpose: the board exists to tell the
   * player what just happened to the grid, and a second sort here would be a
   * second implementation of knockout qualifying — the two would disagree the
   * first time either was touched, and the screen would be confidently wrong
   * about the one thing it is for.
   */
  private rankSegment(engine: RaceEngine): CarEntry[] {
    return rankSegment(engine.participants);
  }

  /**
   * Turns one segment's finishing order into grid slots and a survivor list.
   *
   * Split out from `resolveQualifyingSegment` so a segment the player SKIPPED
   * lands in exactly the same place as one they drove. A skip that took a
   * different path to the grid would be a second implementation of knockout
   * qualifying, and the two would disagree the first time either was touched.
   */
  private applyQualifyingOrder(
    ranked: readonly SegmentEntrant[],
    indexById: Map<string, number>,
    advancing: number | undefined,
  ): void {
    const outcome = resolveSegment(ranked, advancing);

    // Anyone the marshals had to recover is out for the rest of the SESSION,
    // not just for the segment they crashed in (Art. B4.3.2 with B2.4.2), so
    // the list accumulates rather than being replaced.
    for (const id of outcome.barred) {
      if (!this.qualifyingBarred.includes(id)) this.qualifyingBarred.push(id);
    }

    if (outcome.knockedOut.length === 0) {
      // Q3, or a segment nobody was knocked out of: this order fills the front
      // of the grid.
      for (let i = 0; i < outcome.order.length; i++) {
        this.qualifyingGrid[i] = outcome.order[i];
      }
      this.qualifyingSurvivors = outcome.survivors;
      return;
    }

    // Eliminated cars fill the grid from the back, fastest of them highest.
    // With 20 cars and 15 advancing, that is slots 16-20.
    const advanced = outcome.survivors.length;
    for (let i = 0; i < outcome.knockedOut.length; i++) {
      this.qualifyingGrid[advanced + i] = outcome.knockedOut[i];
    }

    this.qualifyingSurvivors = outcome.survivors;

    // Restrict the next segment to the survivors — and, within them, name the
    // ones who are entered but cannot run. They stay in `participants` on
    // purpose: they are classified in the segment they sit out, at the bottom
    // of it, which is what puts a Q1 crash on the fifteenth grid slot rather
    // than the twentieth.
    const next = this.weekend[this.weekendIndex + 1];
    if (next && next.kind === 'qualifying') {
      const toIndex = (id: string) => indexById.get(id);
      next.participants = outcome.survivors
        .map(toIndex)
        .filter((i): i is number => i !== undefined);
      next.withdrawn = this.qualifyingBarred
        .map(toIndex)
        .filter((i): i is number => i !== undefined);
    }
  }

  /**
   * The garage, before every session.
   *
   * This is where the sessions now START. Every session in this game already
   * begins with the car in its garage and the driver waiting to be released —
   * `pitLaneStart` has been true for practice and qualifying all along — but
   * the two decisions a driver actually makes in that garage, the setup and the
   * tyre they go out on, were somewhere else entirely. The setup was a button on
   * a different screen, and the starting tyre could not be chosen at all for a
   * race: it was hard-coded to mediums in `RaceEngine`'s constructor.
   *
   * So the sheet is not a menu you may visit, it is the step between choosing a
   * session and driving it. It is also the only place a skip belongs: "I do not
   * want to sit through this one" is a decision made looking at the session, not
   * three screens earlier.
   */
  private showBriefing(circuitId: string): void {
    const config = this.weekend[this.weekendIndex];
    if (!config) { this.afterWeekend(); return; }

    const circuit = getCircuit(circuitId);
    const isRace = config.kind === 'race';
    this.setScreen('briefing');

    const length = isRace
      ? (config.laps || circuit.raceLaps) + ' laps'
      : Math.round(config.durationS / 60) + ' minutes';

    const { body, actions } = this.page({
      tab: circuit.name,
      title: config.name,
      sub: isRace
        ? 'Grid up. What you start on decides what you have left for the stop.'
        : 'In the garage, waiting to be released. Set the car up before you go out.',
      back: () => this.afterWeekend(),
      meta: [
        ['Length', length],
        ['Session', this.weekend.length > 1
          ? (this.weekendIndex + 1) + ' of ' + this.weekend.length
          : 'one-off'],
      ],
    });

    // Where in the weekend this sits, so a player can see what is still to come
    // and what a skip would cost them.
    if (this.weekend.length > 1) {
      const strip = this.el('div', 'weekend-strip', body);
      for (const [i, entry] of this.weekend.entries()) {
        const cls = i < this.weekendIndex ? 'weekend-step done'
          : i === this.weekendIndex ? 'weekend-step current' : 'weekend-step';
        this.el('div', cls, strip, entry.name);
      }
    }

    // --- Can the player go out at all? -------------------------------------
    //
    // Art. B4.3.2 again. If the marshals recovered this car in an earlier
    // segment the driver takes no further part in qualifying, so the session
    // this screen is offering is one they are entered in and cannot drive. That
    // has to be said HERE, before they press the button — a car that sits in
    // its garage for nine minutes with the controls doing nothing is exactly
    // the failure this game already had once, reported as "it just poof gone".
    const barred = config.kind === 'qualifying'
      && this.qualifyingBarred.includes('PLAYER');

    // ...and whether they are ENTERED in it at all, which is a different
    // question with a different answer and used to be conflated with the first.
    //
    // Art. B2.4.2a-b knocks the slowest drivers out and they are "prohibited
    // from taking any further part"; Art. B4.3.2 bars a recovered driver from
    // running while leaving the entry standing. A driver can be both, and after
    // a crash in Q2 usually is: barred from running, and then knocked out of
    // Q2 for the no-time it produced. Telling them they were "still entered in
    // Q3 and still classified in it" was then simply false — Q3 is ten other
    // cars, and this driver's grid slot was settled when Q2 ended.
    const phase = config.kind === 'qualifying' ? (config.qualifyingPhase ?? 1) : 0;
    // Q1 has no previous segment to have been knocked out of.
    const enteredInSegment = phase <= 1 || this.qualifyingSurvivors.includes('PLAYER');
    const gridSlot = this.qualifyingGrid.indexOf('PLAYER') + 1;

    if (barred && enteredInSegment) {
      this.el('div', 'notice', body,
        'Your car is still in the garage. The marshals recovered it earlier in ' +
        'qualifying, so under the regulations you take no further part in the ' +
        'session — but you are still entered in ' + config.name + ' and still ' +
        'classified in it. You keep every place your lap times have earned; ' +
        'what you cannot do is improve on them.');
    } else if (!enteredInSegment) {
      this.el('div', 'notice', body,
        'Your qualifying is over. You were knocked out in Q' + (phase - 1) + ', so ' +
        config.name + ' is run by the cars that got through it and nothing in it ' +
        'can move you' +
        (gridSlot > 0 ? ' — you start the Grand Prix from P' + gridSlot + '.' : '.') +
        ' You can watch it decide the rows in front of you.');
    }

    // --- The car ----------------------------------------------------------
    // The car you are about to be released in, in the garage it is sitting in.
    // The screen's own first line is "in the garage, waiting to be released" —
    // this is the only screen in the game where showing the machine is
    // literally what the copy already says is happening.
    const bTeam = this.playerTeam();
    // The career's player, or — outside a career — whoever the team's first
    // car belongs to, which is the driver the quick-race grid actually seats
    // the player in.
    const bSeat = this.career
      ? this.career.state.player
      : DRIVERS.find((d) => d.teamId === bTeam.id);
    const bNumber = bSeat?.raceNumber;
    const bCode = bSeat?.code;
    const bay = this.el('div', 'garagebay', body);
    const bayInfo = this.el('div', 'garagebay-info', bay);
    const bplate = this.el('div', 'nameplate', bayInfo);
    bplate.style.setProperty('--team', hexColour(bTeam.colour));
    bplate.innerHTML =
      '<span class="nameplate-rank">' + (bNumber ?? '') + '</span>' +
      '<span class="nameplate-name">' + escapeHtml(bTeam.name) + '</span>';
    this.el('div', 'garagebay-line', bayInfo,
      config.name + ' · ' + circuit.name + ' · ' + TIER_CAR[this.career?.tier ?? 'F1'].shortName);
    this.mountStage('panel', {
      colour: bTeam.colour,
      accent: bTeam.accent,
      number: bNumber,
      code: bCode,
    }, bay);


    this.garageCard(body, circuitId, () => this.showBriefing(circuitId));

    // --- The tyre you go out on ------------------------------------------
    //
    // A RACE DOES NOT ASK HERE. It used to, and then asked again on the next
    // page as the first stint of a strategy \u2014 "so lets say I choose mediums,
    // then i get a tire strategy? why do I need to do it twice?" \u2014 and the two
    // answers were not even wired together: `applyPlayerSetup` ran after
    // `applyStrategy` and wrote this row of chips over the plan's first stint,
    // so the chips silently won and the strategy was a lie about the grid.
    //
    // The strategy page keeps the question, because that is where the choice
    // has consequences a player can read: the stint length, the stop lap, what
    // is left for the second compound. So a race gets a statement here and the
    // decision one page later. Practice and qualifying still ask, because they
    // have no strategy page \u2014 there is no stint plan to make in a session that
    // is three laps of your own.
    if (isRace) {
      const start = getCompound(this.raceStartCompound(circuitId) ?? 'medium');
      this.el('div', 'section-title', body, 'Starting tyre');
      this.el('div', 'card-meta', body,
        'Set by your race strategy, on the next page. You go to the grid on ' +
        start.name.toUpperCase() + ' \u2014 a dry race must be finished on two ' +
        'different dry compounds, so that decides what is left for the stop.');
    } else {
      this.el('div', 'section-title', body, 'Tyre for your first run');
      this.el('div', 'card-meta', body,
        'Softs are quickest for one lap and last a handful of them.');

      const wetsLikely = circuit.rainChance > 0.08;
      const offered: CompoundId[] = wetsLikely
        ? [...DRY_COMPOUNDS, ...WET_COMPOUNDS]
        : [...DRY_COMPOUNDS];
      const chosen = this.playerCompound ?? 'soft';

      const tyres = this.el('div', 'tyre-row', body);
      for (const id of offered) {
        const c = getCompound(id);
        const chip = this.el('div', 'tyre-chip' + (id === chosen ? ' selected' : ''), tyres);
        chip.style.setProperty('--chip', hexColour(c.colour));
        this.el('div', 'tyre-chip-code', chip, c.code);
        this.el('div', 'tyre-chip-name', chip, c.name);
        this.el('div', 'tyre-chip-meta', chip,
          'grip x' + c.peakGrip.toFixed(2) + ' \u00b7 wear x' + c.wearRate.toFixed(2));
        chip.addEventListener('click', () => {
          this.playerCompound = id;
          this.showBriefing(circuitId);
        });
      }
    }

    // --- Go, or do not go -------------------------------------------------
    this.button('Car Setup', actions,
      () => this.showSetup(circuitId, () => this.showBriefing(circuitId)), 'btn ghost');
    // Skipping the race is offered too, because "I want the result without
    // driving 57 laps" is the same request as skipping FP2, just more expensive
    // to honour.
    this.button('Skip ' + config.name, actions, () => this.skipSession(circuitId), 'btn ghost');
    this.spacer(actions);
    if (barred || !enteredInSegment) {
      // Nothing to drive, so the primary action is the one that gets the
      // player to the other side of a session they are only a spectator in.
      // "To the Garage" would open a cockpit that does not respond.
      //
      // `watching` is passed on: the session is run the same way a skip is, but
      // the player did not choose to miss it, and the screens it produces say
      // so. A button that says WATCH followed by a screen that says SIMULATING
      // is the whole of "Q3 was then simulated like I didn't even get to race".
      this.button('Watch ' + config.name + ' from the garage', actions,
        () => this.skipSession(circuitId, true), 'btn primary');
      return;
    }
    // A race goes via the pit wall. Practice and qualifying do not: there is
    // no stint plan to make when the session is three laps of your own.
    this.button(isRace ? 'Race Strategy' : 'To the Garage', actions,
      () => (isRace ? this.showStrategy(circuitId) : this.launchSession(circuitId)), 'btn primary');
  }

  /**
   * The race plan, before the lights.
   *
   * THE GAP THIS CLOSES. `RaceEngine.planStrategies` has always written a stint
   * sequence onto every car in the constructor, the player's included, and
   * nothing ever showed it or let them change it — the largest decision in a
   * Grand Prix was made for them off screen. This screen makes it, for both of
   * the team's cars, and `applyStrategy` writes the answer onto the real
   * `CarEntry.plan` so the race runs what was chosen.
   *
   * It sits between the briefing and the grid for races only. There is no stint
   * plan to make in a practice session.
   */
  private showStrategy(circuitId: string): void {
    const config = this.weekend[this.weekendIndex];
    const circuit = getCircuit(circuitId);
    if (!config) { this.afterWeekend(); return; }

    // A plan is about a circuit and a distance. Carrying Monaco's two-stop to
    // Monza is not a choice anyone meant to make, exactly as with the setup.
    if (this.playerStrategyCircuitId !== circuitId) {
      this.playerStrategyCircuitId = circuitId;
      this.playerStrategy = {};
    }

    const team = this.playerTeam();
    const playerId = this.playerDriverId();
    const mates = driversForTeam(team.id);
    const me = mates.find((d) => d.id === playerId) ?? mates[0];
    const drivers = [me, ...mates.filter((d) => d.id !== me.id)];
    const laps = config.laps || circuit.raceLaps;

    const { body, actions } = this.page({
      tab: 'Race weekend · ' + circuit.name,
      title: 'Race Setup',
      sub: 'The plan for both cars, over ' + laps + ' laps',
      back: () => this.showBriefing(circuitId),
      meta: [['Laps', String(laps)], ['Pit limit', circuit.pitLane.speedLimitKph + ' km/h']],
      rule: this.circuitRule(circuit, 2),
    });

    const panel = this.el('div', 'strategy', body);
    buildStrategyScreen(panel, {
      team,
      drivers,
      playerIndex: 0,
      track: circuit,
      laps,
      chosen: this.playerStrategy,
      onChoose: (driverId, optionId) => { this.playerStrategy[driverId] = optionId; },
    });

    this.button('Car Setup', actions,
      () => this.showSetup(circuitId, () => this.showStrategy(circuitId)), 'btn ghost');
    this.spacer(actions);
    this.button('Confirm — to the grid', actions,
      () => this.launchSession(circuitId), 'btn primary');
    this.setScreen('strategy');
  }

  /**
   * Writes the plans onto the real cars, and with them the tyres on the grid.
   *
   * Both cars. A team principal who sets a strategy for one car and lets the
   * engine roll dice for the other is not running a team, and the team-mate's
   * plan is the one that decides whether they are in the way on lap thirty —
   * which is why their column on the strategy page states it. What the player
   * does not do is CHOOSE it; `plannedStrategy` with no chosen id returns the
   * strategist's own call, and that is the same call the column printed.
   *
   * This is now the only writer of a race's starting compound. It used to share
   * the job with `applyPlayerSetup`, which ran afterwards and overwrote it from
   * a separate row of chips on the briefing page — so the plan on screen and
   * the tyre on the grid were two answers to one question, and the chips won
   * silently. The chips are gone and this runs unopposed.
   */
  private applyStrategy(engine: RaceEngine): void {
    if (engine.config.kind !== 'race') return;
    const car = engine.playerCar;
    if (!car) return;
    const laps = engine.config.laps || engine.track.def.raceLaps;

    for (const entry of engine.cars) {
      if (entry.team.id !== car.team.id) continue;
      const option = plannedStrategy(
        entry.team, entry.driver, engine.track.def, laps,
        entry === car ? this.playerStrategy[entry.driver.id] : undefined,
      );

      applyPlanToCar(entry, option, engine.weather.trackTempC + 40);
    }
  }

  /** Where to go when a weekend runs out of sessions, or is abandoned. */
  private afterWeekend(): void {
    this.forgetWeekend();
    if (this.career) this.showCareerHub();
    else this.showMenu();
  }

  /**
   * The twenty drivers for a session, in grid order.
   *
   * Shared by the session the player drives and the one they skip, because a
   * skipped Q1 has to hand its grid to a race the player might well drive — and
   * if the two built their fields differently, the grid would be a list of
   * drivers who were never in the session that produced it.
   */
  private fieldFor(config: SessionConfig): Driver[] | undefined {
    // In career mode the player's entry replaces a grid slot with their own
    // driver record, so the sim races the career driver rather than a stand-in.
    let field: Driver[] | undefined;
    if (this.career) {
      // The whole championship's grid, in team order, with the player's own
      // record in their seat. Team order matters: the pit geometry lays two
      // boxes in front of each garage and builds the paddock from the same
      // anchor, so a grid ordered any other way puts cars in front of somebody
      // else's garage.
      field = this.career.grid();
    }

    // A race that follows qualifying lines up in the order qualifying
    // produced. The engine builds the grid from the field's array order, so
    // sorting the field here IS setting the grid.
    if (config.kind === 'race' && this.qualifyingGrid.length > 0) {
      const base = field ?? DRIVERS.slice();
      const playerId = this.playerDriverId();
      const rank = (d: Driver) => {
        const key = d.id === playerId ? 'PLAYER' : d.id;
        const i = this.qualifyingGrid.indexOf(key);
        // Anyone with no qualifying slot starts behind those who have one.
        return i < 0 ? this.qualifyingGrid.length + base.indexOf(d) : i;
      };
      field = base.slice().sort((a, b) => rank(a) - rank(b));
    }
    return field;
  }

  /**
   * Puts the player in their OWN car.
   *
   * `SessionConfig.playerIndex` is the index into the entry list of the car the
   * human drives, and every config in this file was built with it hard-coded to
   * zero. Outside a career that is right by construction: the quick-race field
   * is the static grid and the player is `DRIVERS[0]`, entry zero.
   *
   * Inside a career it was wrong, and it was the bug behind "I can change my
   * name on the front page, but that doesn't change anything else". A career
   * field is `Career.grid()` — every seat in the championship, IN TEAM ORDER,
   * because the pit boxes are laid out from that order. A rookie starts at the
   * weakest team, which is the last team in that order, so the player's own
   * entry is index NINETEEN of twenty. Index zero is the first driver of the
   * strongest team. The human was therefore driving somebody else's car, under
   * somebody else's name, number, nationality and colours, while their own
   * driver record sat at the back being driven by the AI — and both cars
   * reported themselves to qualifying as 'PLAYER', because one was flagged
   * `isPlayer` and the other genuinely had that id.
   *
   * Called after `fieldFor`, never before: a race sorts the field into
   * qualifying order, which moves the player again. The search itself lives in
   * `src/career/Seat.ts` so `probe:identity` asserts the shipped function
   * rather than a copy of it.
   */
  private seatPlayer(config: SessionConfig, field: readonly Driver[] | undefined): void {
    config.playerIndex = playerIndexIn(field, this.playerDriverId());
  }

  /** The driver id the player is racing under, career or not. */
  private playerDriverId(): string {
    return this.career ? this.career.playerAsDriver().id : DRIVERS[0].id;
  }

  /**
   * The player's own driver record — their tyre management, which is half of
   * how long a stint lasts, so the plan quoted on the briefing page is the plan
   * the strategy page will offer rather than a generic one.
   */
  private playerDriverRecord(): Driver {
    return this.career ? this.career.playerAsDriver() : DRIVERS[0];
  }

  // =======================================================================
  // Skipping a session
  // =======================================================================

  /**
   * Simulates the queued session instead of driving it.
   *
   * "Sometimes it takes forever and I want to go quicker" is a request for the
   * result without the ninety minutes, and the honest way to grant it is to run
   * the session — the same engine, the same twenty cars, the same circuit — with
   * nothing drawn. See `SessionSimulator` for why that is affordable and where
   * the early exit comes from.
   *
   * Practice is the exception, and it is skipped for free: nothing downstream
   * consumes a practice classification, so simulating one would be five seconds
   * spent producing a number the game then throws away.
   */
  private skipSession(circuitId: string, watching = false): void {
    const config = this.weekend[this.weekendIndex];
    if (!config) { this.afterWeekend(); return; }

    // A session the player DECLINED can be waved through; one they are WATCHING
    // cannot. Practice is the only session nothing downstream consumes, so it
    // is the only one worth not running — but a player sitting out Q3 has asked
    // to see Q3, and skipping straight past it is the complaint.
    if (config.kind === 'practice' && !watching) {
      this.advanceWeekend(circuitId);
      return;
    }

    const def = getCircuit(circuitId);
    const session = new HeadlessSession(def, config, this.fieldFor(config), this.playerDriverId());

    this.setScreen('simulating');
    const { body, actions } = this.page({
      tab: def.name,
      // The player is not skipping this one. They pressed a button that said
      // WATCH, and being shown a screen headed "Simulating" is what made a
      // session they were barred from feel like a session the game took off
      // them — "Q3 was then simulated like I didn't even get to race".
      title: watching ? 'Watching ' + config.name : 'Simulating ' + config.name,
      sub: watching
        ? 'You take no further part in this one, so it runs without you — at ' +
          'full simulation, with the same cars on the same circuit. Every lap ' +
          'below is one they really set, and the classification at the end is ' +
          'the real one.'
        : 'The same session, run at full simulation with nothing drawn. The ' +
          'result is what those twenty cars actually did, not a guess.',
    });

    const bar = this.el('div', 'sim-bar', body);
    const fill = this.el('div', 'sim-fill', bar);
    const label = this.el('div', 'sim-label', body, '0%');
    const detail = this.el('div', 'sim-detail', body, '');

    this.button('Cancel', actions, () => {
      if (this.skipping) this.skipping.cancelled = true;
      this.skipping = null;
      this.showBriefing(circuitId);
    }, 'btn ghost');

    this.skipping = {
      session,
      index: this.weekendIndex,
      label,
      bar: fill,
      detail,
      startedAt: performance.now(),
      cancelled: false,
      watching,
    };
  }

  /**
   * Drives a skip forward by one animation frame's worth of simulation.
   *
   * The 26ms slice is chosen against what the screen is doing rather than
   * against the frame budget: this screen is a progress bar and nothing else, so
   * spending most of the frame simulating is the right trade. A 16ms slice would
   * hold 60fps on a bar with nothing to animate, and take 60% longer.
   */
  private stepSkip(circuitId: string): void {
    const skip = this.skipping;
    if (!skip || skip.cancelled) return;

    skip.session.advance(26);

    const p = skip.session.progress;
    skip.bar.style.width = (p * 100).toFixed(1) + '%';
    const elapsed = (performance.now() - skip.startedAt) / 1000;
    skip.label.textContent = Math.round(p * 100) + '%';
    skip.detail.textContent =
      skip.session.engine.time.toFixed(0) + 's of session simulated in ' +
      elapsed.toFixed(1) + 's · ' +
      (elapsed > 0.5 ? (skip.session.engine.time / elapsed).toFixed(0) + 'x realtime' : '');

    if (!skip.session.done) return;

    const result = skip.session.result();
    const config = this.weekend[skip.index];
    this.skipping = null;

    if (config && config.kind === 'qualifying' && config.qualifyingPhase) {
      const indexById = new Map<string, number>();
      const playerId = this.playerDriverId();
      for (const c of skip.session.engine.cars) {
        indexById.set(c.driver.id === playerId ? 'PLAYER' : c.driver.id, c.index);
      }
      // A skipped segment reaches the grid through exactly the same call a
      // driven one does, retirements and all — including Art. B4.3.2, so a car
      // the simulation put in the barrier is barred from the rest of qualifying
      // whether or not the player watched it happen.
      const wrecked = new Set(result.retired);
      this.applyQualifyingOrder(
        result.order.map((id) => ({ id, retired: wrecked.has(id) })),
        indexById, config.advancing);
    }

    // A skipped race still has to feed the career, or the round never happened.
    if (config && config.kind === 'race' && this.career) {
      this.recordSimulatedRace(circuitId, result.order, skip.session);
      return;
    }

    this.showSkipResult(
      circuitId, config?.name ?? 'Session', result, skip.session, skip.watching);
  }

  /** The classification of a session the player did not drive. */
  private showSkipResult(
    circuitId: string,
    name: string,
    result: { order: string[]; bestLaps: Map<string, number>; simSeconds: number; wallMs: number },
    session: HeadlessSession,
    watching = false,
  ): void {
    this.setScreen('results');
    const def = getCircuit(circuitId);
    const config = this.weekend[this.weekendIndex];

    const { body, actions } = this.page({
      tab: def.name,
      // A session the player was not permitted to drive has a RESULT, not a
      // simulation. Heading it "Simulated" told a driver who had just sat out
      // Q3 under Art. B4.3.2 that the thing they watched had not really
      // happened \u2014 when it decides the front five rows of the grid they start
      // from.
      title: watching ? name + ' \u2014 Result' : name + ' \u2014 Simulated',
      sub: config?.kind === 'qualifying' && config.advancing !== undefined
        ? this.qualifyingSurvivors.length + ' advance, ' +
          (result.order.length - this.qualifyingSurvivors.length) + ' eliminated'
        : 'Classification in full.',
      meta: [
        ['Simulated', result.simSeconds.toFixed(0) + 's'],
        ['Took', (result.wallMs / 1000).toFixed(1) + 's'],
      ],
    });

    const byId = new Map(session.engine.cars.map((c) => [
      c.driver.id === this.playerDriverId() ? 'PLAYER' : c.driver.id, c,
    ]));

    const wrap = this.el('div', 'table-wrap', body);
    const table = document.createElement('table');
    table.className = 'standings';
    table.innerHTML =
      '<thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Best Lap</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const [i, id] of result.order.entries()) {
      const car = byId.get(id);
      const tr = document.createElement('tr');
      if (id === 'PLAYER') tr.className = 'me';
      const chip = car
        ? '<span class="team-chip" style="background:' + hexColour(car.team.colour) + '"></span>'
        : '';
      tr.innerHTML =
        '<td class="pos">' + (i + 1) + '</td>' +
        '<td>' + chip + escapeHtml(car ? car.driver.firstName + ' ' + car.driver.lastName : id) + '</td>' +
        '<td>' + escapeHtml(car ? car.team.shortName : '\u2014') + '</td>' +
        '<td class="num">' + formatLapTime(result.bestLaps.get(id) ?? 0) + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    this.spacer(actions);
    this.button('Continue', actions, () => this.advanceWeekend(circuitId), 'btn primary');
  }

  // =======================================================================
  // Running a session out after the player has stopped in it
  // =======================================================================

  /**
   * Runs the session the player is out of on to its flag, then classifies it.
   *
   *   "also like even tho I DNF doesn't mean that the rest weren't able to get
   *    a time classification, just make the simulation up or something, ykwim"
   *
   * THE BUG. `Skip to the result` used to call `finishSession` on the spot,
   * which ranks `engine.participants` on their best lap *at that instant*. A
   * driver who stops early therefore published a classification of a session
   * that had not happened yet. Measured, 720s Q1 at Bahrain, seed 4001, player
   * retired at t=90s: **0 of 20 cars had a lap time**, so `rankSegment` fell
   * through to its no-time ordering and the grid was garage release order.
   * Stepping that same engine on to the flag instead gives **19 of the 20 a
   * time** — everyone bar the driver who stopped — off 4 to 5 timed laps each.
   * Nothing about the other cars was ever broken; the button simply did not let
   * them finish.
   *
   * WHAT "MAKE THE SIMULATION UP" IS AND IS NOT. It is permission to not sit
   * through the remaining nine minutes. It is not permission to invent times:
   * the simulation already knows how fast every car is, so the honest reading
   * is to let it finish. This steps the real engine with the real cars and
   * draws nothing, which is the same trade `SessionSimulator` documents and
   * measured here at ~27x realtime on a loaded machine.
   *
   * Frame-sliced rather than run in one burst for the reason given there: five
   * seconds of a frozen tab with nothing on screen is indistinguishable from a
   * crash.
   */
  private runOutToTheFlag(then: () => void): void {
    const engine = this.engine;
    if (!engine) { then(); return; }
    // Already at the flag — a player who watched the clock down and then asked
    // for the result should not be shown a progress bar that is instantly full.
    if (engine.over) { then(); return; }

    const def = engine.track.def;
    this.setScreen('simulating');
    const { body, actions } = this.page({
      tab: def.name,
      title: 'Running out ' + engine.config.name,
      // Said plainly, because it is the thing the player asked to be told: you
      // are out, they are not, and the result waits for them.
      sub: 'You are out of this one, the other cars are not. The rest of ' +
        engine.config.name + ' is being run at full simulation — the same cars ' +
        'on the same circuit, with nothing drawn — so the classification you ' +
        'get is the one they really produce.',
    });

    const bar = this.el('div', 'sim-bar', body);
    const fill = this.el('div', 'sim-fill', bar);
    const label = this.el('div', 'sim-label', body, '0%');
    const detail = this.el('div', 'sim-detail', body, '');

    // Cancelling puts the player back on track rather than into the menus: they
    // asked for the result, not to leave the weekend.
    this.button('Watch it instead', actions, () => {
      if (this.runningOut) this.runningOut.cancelled = true;
      this.runningOut = null;
      this.spectating = true;
      this.setScreen('racing');
    }, 'btn ghost');

    this.runningOut = {
      label, bar: fill, detail,
      startedAt: performance.now(),
      fromTime: engine.time,
      then,
      cancelled: false,
    };
  }

  /**
   * How much of what this session exists to decide has been decided, 0..1.
   *
   * The same two conditions `HeadlessSession` uses, against the live engine:
   * the clock, or every runner having a time and enough laps behind it. A
   * qualifying segment exists to rank cars on their best lap, and once everyone
   * has had their runs another six minutes of circulating almost never changes
   * the order — so the run-out stops there rather than grinding the clock down.
   * A race has to reach its own end and gets no early exit.
   */
  private runOutProgress(engine: RaceEngine): number {
    const byClock = engine.config.durationS > 0 ? engine.time / engine.config.durationS : 0;
    if (engine.config.kind === 'race') return clamp(byClock, 0, 1);
    const cars = engine.participants;
    if (cars.length === 0) return 1;
    let ready = 0;
    for (const c of cars) {
      // A car that has stopped or been withdrawn (Art. B4.3.2) is never going
      // to set another lap, so waiting for it would hold the exit open for the
      // whole segment — including, always, the player's own.
      if (c.retired || c.withdrawn || (c.bestLapTime > 0 && c.lap >= 3)) ready++;
    }
    return clamp(Math.max(byClock, ready / cars.length), 0, 1);
  }

  /** One animation frame's worth of running the session out. */
  private stepRunOut(): void {
    const run = this.runningOut;
    const engine = this.engine;
    if (!run || run.cancelled || !engine) return;

    // The same 26ms slice `stepSkip` uses, and for the same reason: this screen
    // is a progress bar and nothing else, so spending most of the frame
    // simulating is the right trade.
    const t0 = performance.now();
    let done = engine.over;
    while (!done && performance.now() - t0 < 26) {
      for (let i = 0; i < 240 && !engine.over; i++) engine.step();
      done = engine.over || this.runOutProgress(engine) >= 1;
    }

    const p = this.runOutProgress(engine);
    run.bar.style.width = (p * 100).toFixed(1) + '%';
    run.label.textContent = Math.round(p * 100) + '%';
    const elapsed = (performance.now() - run.startedAt) / 1000;
    const simmed = engine.time - run.fromTime;
    run.detail.textContent =
      simmed.toFixed(0) + 's of ' + engine.config.name + ' run in ' + elapsed.toFixed(1) + 's' +
      (elapsed > 0.5 ? ' · ' + (simmed / elapsed).toFixed(0) + 'x realtime' : '');

    if (!done) return;
    this.runningOut = null;
    run.then();
  }

  /** Feeds a skipped race into the career the same way a driven one is. */
  private recordSimulatedRace(circuitId: string, order: string[], session: HeadlessSession): void {
    const career = this.career;
    if (!career) { this.advanceWeekend(circuitId); return; }

    const engine = session.engine;
    const fl = engine.fastestLap();
    const result: RoundResult = {
      round: career.round,
      circuitId,
      order,
      // Retirement and exclusion are separate outcomes under the 2026 rules and
      // the engine models both, so the championship is told about both. A
      // disqualified driver scores nothing but has not had a DNF.
      retired: engine.cars.filter((c) => c.retired && !c.disqualified).map((c) => c.driver.id),
      disqualified: engine.cars.filter((c) => c.disqualified).map((c) => c.driver.id),
      poleDriverId: order[0] ?? career.state.playerDriverId,
      fastestLapDriverId: fl ? fl.car.driver.id : (order[0] ?? ''),
      wetRace: engine.weather.hasRained,
      driven: false,
    };
    career.recordPlayerRound(result);
    this.profiles.saveCareer(this.careerId, career.state);
    this.showSkipResult(circuitId, 'Grand Prix',
      { order, bestLaps: session.result().bestLaps, simSeconds: engine.time, wallMs: session.result().wallMs },
      session);
  }

  /** Moves to the next session of the weekend, or leaves it. */
  private advanceWeekend(circuitId: string): void {
    this.weekendIndex++;
    if (this.weekendIndex < this.weekend.length) {
      this.rememberWeekend(circuitId);
      this.showBriefing(circuitId);
    } else {
      this.afterWeekend();
    }
  }

  /** Builds the engine and loads the renderer for the queued session. */
  private launchSession(circuitId: string): void {
    const config = this.weekend[this.weekendIndex];
    if (!config) { this.afterWeekend(); return; }

    // `Restart session` is reachable from the retirement sheet and from the
    // pause menu, and either can be pressed while the previous session is being
    // run out. The frame after this one would otherwise step the new engine
    // under the old session's progress bar.
    if (this.runningOut) this.runningOut.cancelled = true;
    this.runningOut = null;

    this.setLoading(true, getCircuit(circuitId).name + ' — ' + config.name, circuitId);

    // Yield a frame so the loading screen paints before the synchronous build,
    // which takes a few hundred milliseconds for the racing line solve.
    window.requestAnimationFrame(() => {
      const def = getCircuit(circuitId);
      const field = this.fieldFor(config);
      this.seatPlayer(config, field);

      this.engine = new RaceEngine(def, config, field);
      // `?wet=0.8` forces the sky and soaks the road before the lights go out.
      //
      // Weather is stochastic, and a screenshot, a frame-time measurement or a
      // bug report that depends on it raining is otherwise a matter of hunting
      // for a seed — which measures the seed. The road still responds through
      // the ordinary drying model from that starting point, so what is shot or
      // timed is the real thing and not a special case. Only read from a deep
      // link, so nothing in the game can reach it.
      const wetParam = Number(new URLSearchParams(window.location.search).get('wet'));
      if (Number.isFinite(wetParam) && wetParam > 0) {
        this.engine.weather.forceRain(clamp(wetParam, 0, 1), true);
      }
      this.applyStrategy(this.engine);
      this.applyPlayerSetup(this.engine);
      // A fresh session is a fresh chance to crash.
      this.retirementShown = false;
      this.spectating = false;
      this.retiredAt = 0;
      // The rubbered-in racing line, rasterised from this circuit's spline into
      // the shared surface map. Done before the track mesh is built so the
      // asphalt has it the first frame it is drawn.
      // ...and, from the same call, where water collects on it. The drainage
      // field is the simulation's own, derived from this circuit's elevation,
      // so the puddle the player can see and the puddle the car aquaplanes in
      // are the same puddle.
      setRubberLine(this.engine.track, this.engine.weather.surface.drainage);
      this.renderer.loadSession(this.engine);
    this.renderer.setRacingLineVisible(this.settings.racingLine);
      this.audio.configureForTrack(def.scenery, this.engine.weather.wetness);
      this.audio.setSuspended(false);
      this.renderer.director.setMode(this.settings.cameraMode as CameraMode);
      this.hud.setCameraLabel(this.renderer.director.modeLabel);
      this.hud.setCameraMode(this.renderer.director.mode);
      // Show the controls at the start of every session.
      this.helpVisible = true;
      this.helpShownAt = performance.now();
      this.hud.setHelpVisible(true);
      this.clock.reset();
      this.clock.paused = false;
      this.setLoading(false);
      this.setScreen('racing');
    });
  }

  /**
   * Hands the player's chosen setup to the car the engine just built.
   *
   * The engine gives every car the engineers' baseline for the circuit, which is
   * what the AI runs. If the player has been to the setup screen, their sheet
   * replaces it here — rebuilding the spec through the same `applySetup` the
   * baseline went through, so the two are directly comparable and the player is
   * genuinely racing the car they configured.
   *
   * Fuel is deliberately NOT taken from the sheet: the session decides it (a
   * race is fuelled for the distance, qualifying runs light), and letting the
   * setup screen override that would let a player start a Grand Prix on fumes.
   */
  private applyPlayerSetup(engine: RaceEngine): void {
    const car = engine.playerCar;
    const setup = this.playerSetup;
    if (!car || !setup) return;

    car.setup = { ...setup, fuelLoadL: car.setup.fuelLoadL };
    const spec = applySetup(specForTeam(car.team.performance), car.setup);
    car.physics.setSpec(spec);

    // A RACE'S starting tyre is not this screen's to set. It is the first stint
    // of the strategy, written by `applyStrategy`, which runs immediately
    // before this — and this used to run afterwards and overwrite it from a
    // separate chip row, which is how a player who chose a soft-start strategy
    // could arrive on the grid on mediums with nothing telling them so. Outside
    // a race there is no plan, and the choice is genuinely this one.
    if (this.playerCompound && engine.config.kind !== 'race') {
      car.compound = this.playerCompound;
      car.usedCompounds.length = 0;
      car.usedCompounds.push(this.playerCompound);
      // Fitted, not just recorded — the tire model owns the grip curve, the
      // wear rate and the temperature window that the compound selects.
      car.physics.frontTires.fit(this.playerCompound, 80);
      car.physics.rearTires.fit(this.playerCompound, 80);
    }

    if (import.meta.env?.DEV) {
      const baseline = applySetup(specForTeam(car.team.performance), car.setup);
      console.info(
        '[setup] player car rebuilt: cl=' + spec.clBase.toFixed(3) +
        ' cd=' + spec.cdBase.toFixed(3) +
        ' aeroFront=' + spec.aeroBalanceFront.toFixed(3) +
        ' brakeFront=' + spec.brakeBalanceFront.toFixed(2) +
        ' top gear=' + baseline.gearRatios[7].toFixed(2) +
        ' tyre=' + car.compound,
      );
    }
  }

  /**
   * Calls the player in, or waves off the call.
   *
   * Also reports it on the radio, because a pit call the driver cannot see the
   * state of is a pit call they will press twice.
   */
  private togglePitRequest(): void {
    const engine = this.engine;
    const car = engine?.playerCar;
    if (!engine || !car) return;
    const on = !car.pitRequested;
    engine.requestPit(car, on);
    engine.raceControl.log(
      on ? 'Box this lap — your box is ready'
        : 'Stay out, stay out',
      'info', engine.time, car.index,
      { feed: 'team' },
    );

    // Calling for a stop is the moment to decide what the stop IS. Cancelling
    // it puts the sheet away — a tyre choice for a stop that is not happening is
    // a panel taking up the left of the screen for nothing. The sheet itself is
    // opened by `updatePitPrompt` off the car's state on the next frame, so
    // there is one place that decides whether it is on screen.
    if (!on) {
      clearPitOrder(car);
      this.pitPrompt.close();
      this.hud.setPitSheetOpen(false);
    }
  }

  // =======================================================================
  // Pause and abandon
  // =======================================================================

  /**
   * The pause menu.
   *
   * This exists because there was no way out of a session. Pause froze the
   * simulation and drew nothing, so the game looked like it had hung, and the
   * only routes back to the menu were finishing the session or reloading the
   * page — a fifty-seven lap Grand Prix with the exit disabled.
   *
   * It is built here, in the app shell, rather than in the HUD, because the HUD
   * is the instrument cluster of a car that is being driven and this is the
   * question of whether to keep driving it at all. It also means the overlay
   * survives independently of whatever the HUD is doing.
   */
  /**
   * What the pause menu offers, rebuilt each time it opens.
   *
   * The menu itself lives in `ui/PauseMenu`; what belongs HERE is the set of
   * things it can do, because every one of them is a decision about the app's
   * state rather than about the card on screen — restarting rebuilds the
   * session, settings has to know where to come back to, and quitting throws a
   * weekend away.
   *
   * Resume and Abandon were the whole menu before this. Restart is here because
   * the commonest reason to reach for pause mid-session is that the last thirty
   * seconds went badly, and the only remedy on offer was to abandon the weekend.
   * Settings is here because assists and difficulty are exactly what a player
   * wants to change when a session is going wrong, and reaching them through the
   * main menu meant throwing the session away to get to them.
   */
  private setPaused(paused: boolean): void {
    // Only meaningful on track. Pausing the menu would be an odd thing to offer.
    if (paused && this.screen !== 'racing') return;
    this.clock.paused = paused;
    this.audio.setSuspended(paused || this.screen !== 'racing');

    if (!paused) { this.pauseMenu.hide(); return; }

    const engine = this.engine;
    if (!engine) return;
    const player = engine.playerCar;
    const circuitId = engine.track.def.id;
    const rc = engine.raceControl;

    // The flag state is on the card because it is the thing a player pausing
    // mid-incident most needs to remember when they come back.
    const flag =
      rc.sessionFlag === 'red' ? 'Red flag'
      : rc.neutralisation === 'safety-car' ? 'Safety car'
      : rc.neutralisation === 'vsc' ? 'Virtual safety car'
      : player
        ? 'Sector ' + (Math.floor((player.s / engine.track.length) * 3) + 1) + ' ' +
          rc.signalAt(player.s).replace('-', ' ')
        : 'Green';

    const totalLaps = engine.config.laps || engine.track.def.raceLaps;
    const status = player
      ? 'P' + player.position + ' of ' + engine.cars.length +
        (engine.config.kind === 'race'
          ? ' \u00b7 lap ' + Math.min(player.lap + 1, totalLaps) + '/' + totalLaps
          : ' \u00b7 best ' + formatLapTime(player.bestLapTime)) +
        ' \u00b7 ' + flag
      : flag;

    this.pauseMenu.show(
      {
        sessionName: engine.config.name,
        circuitName: engine.track.def.name,
        status,
        quitWarning: engine.config.kind === 'race' && this.career
          ? 'Abandon the race \u2014 no points, no result'
          : undefined,
      },
      {
        onResume: () => this.setPaused(false),
        onRestart: () => {
          this.setPaused(false);
          this.renderer.unloadSession();
          this.engine = null;
          this.pitPrompt.close();
          this.hud.setPitSheetOpen(false);
          this.launchSession(circuitId);
        },
        onSettings: () => {
          // The menu is hidden rather than dismissed, so Back from Settings
          // returns to the paused session instead of to the main menu.
          this.pauseMenu.hide();
          this.showSettings(() => {
            this.setScreen('racing');
            this.setPaused(true);
          });
        },
        onQuit: () => this.abandonSession(),
      },
    );
  }

  /** Opens the pause menu. Wired to the HUD button and to `P`/`Escape`. */
  private openPauseMenu(): void {
    this.setPaused(true);
  }

  private closePauseMenu(): void {
    this.setPaused(false);
  }

  // =======================================================================
  // Retirement
  // =======================================================================

  /**
   * Tells the player their session is over, and why.
   *
   * This screen exists because there was nothing here at all. A car written off
   * against a barrier was retired by the race engine, marked recovered on the
   * same frame, and stopped being drawn — so from the driver's seat the entire
   * experience of ending your race was that the world went quiet and the car
   * disappeared. No message, no classification, no way forward; the player was
   * left holding a controller that no longer did anything, on a circuit they
   * were no longer on. Reported twice, in the player's own words: "it just poof
   * gone."
   *
   * What it says is modelled on what actually happens to a driver. They are
   * told it is over, they are told what broke, and then they are asked what
   * they want to do next. The three answers are the three real ones: leave,
   * take the session again, or stay and watch the race you are no longer in.
   */
  private retireOverlay: HTMLElement | null = null;
  /**
   * The numbers, when the player has asked for them.
   *
   * Separate from `retireOverlay` because they are two different things with
   * two different lifetimes: the corner bar stands from the accident until the
   * player decides, and this appears and disappears underneath it as often as
   * they press `Continue`.
   */
  private retireStatus: HTMLElement | null = null;
  /** True once the overlay has been raised for the current session. */
  private retirementShown = false;
  /** Set when the player dismisses the overlay to keep watching. */
  private spectating = false;
  /** Session time at which the player's car retired, for the delay. */
  private retiredAt = 0;

  /**
   * Seconds between the accident and the screen.
   *
   * Not zero, and the reason is the whole point of this piece of work. The
   * moment of the crash is the moment the player most wants to see: the car
   * spearing into the barrier, the wing going over the top of it, the pieces
   * coming to rest. Covering that with a modal instantly is a second way of
   * taking the accident away from them. The delay is long enough to watch it
   * happen and short enough that nobody wonders whether the game has hung.
   */
  private static readonly RETIREMENT_DELAY_S = 2.6;

  private updateRetirement(engine: RaceEngine, player: CarEntry): void {
    if (!player.retired) {
      // A new session, or a car that has not yet come to grief.
      this.retirementShown = false;
      this.spectating = false;
      this.retiredAt = 0;
      this.hud.setRetired(false);
      return;
    }
    if (this.retirementShown || this.spectating) return;
    if (this.retiredAt === 0) this.retiredAt = engine.time;
    if (engine.time - this.retiredAt < Game.RETIREMENT_DELAY_S) return;

    this.retirementShown = true;
    this.retireOnTheRadio(engine, player);
  }

  /**
   * A race ending on the radio, with the decision in the corner.
   *
   *   "why do we still have this thing, I thought we talked about, remove the
   *    retired. its just a radio message about you having to retire and then
   *    top right continue or watch the race, and once the user presses continue
   *    the stats show up."
   *
   * Asked three times. What was there was a full-screen modal carrying the
   * cause, the worst component, the corner, the lap, the classification and a
   * bar chart of twelve damaged parts — filed at the player about two seconds
   * after an accident they were in, over the top of the car they most wanted to
   * be looking at. None of it is wrong and all of it is unasked for.
   *
   * So the shape is inverted. The principal says the one thing that matters
   * over the radio, the two decisions a retired driver actually has sit in the
   * top-right corner, and every number waits until `Continue` is pressed —
   * which lands on the same classification screen the end of a race lands on,
   * so there is one results screen in the game rather than two.
   *
   * THE CLOCK IS NOT PAUSED. The modal paused it, which froze nineteen cars
   * mid-race behind a card about the twentieth. `Watch the race` was offered by
   * a screen that had already stopped the race.
   *
   * QUALIFYING AND PRACTICE COME THROUGH HERE TOO, as of issue #33. They were
   * deliberately left on the full-screen panel because that panel had just been
   * rewritten against the 2026 regulations and the content was right. Issue #33
   * records that as a routing error rather than a decision: the user asked five
   * times for the takeover to go, and they meant everywhere. Not one word of the
   * regulation content was dropped — it moved. The principal says it, race
   * control rules on it (Art. B4.3.2, worded for a Lap Time Classified Session
   * rather than for a race), and every number waits in a corner sheet until
   * `Continue` is pressed. See `showRetirementStatus`.
   */
  private retireOnTheRadio(engine: RaceEngine, player: CarEntry): void {
    this.retireOverlay?.remove();
    this.retireStatus?.remove();
    this.retireStatus = null;

    // THE PIT SHEET GOES BEFORE ANYBODY SPEAKS, and this is a real bug rather
    // than tidiness. `Hud.raiseCard` opens with `if (this.pitSheetOpen) return`
    // — correctly, because "the radio stuff is being covered by the pit
    // options" is one of the reported complaints this HUD was built to answer.
    // But `updatePitPrompt` runs AFTER `updateRetirement` in the frame loop, so
    // on the frame the accident is announced the sheet is still open from the
    // previous one, and the principal's transmission was dropped on the floor.
    //
    // Measured: `probe:qualiretire` went red on "the principal has spoken — a
    // radio card is up" with everything else about the corner controls green.
    // It shows up in qualifying and not in a race because every practice and
    // qualifying session STARTS IN THE GARAGE — `pitLaneStart` — so
    // `pitDecisionPending` is true from the first frame and the sheet is
    // genuinely up when a driver goes off on their out-lap.
    //
    // Closing it is also simply right. A car in the gravel has no stop to make,
    // and `pitDecisionPending` says so itself the moment `retired` is set.
    this.pitPrompt.close();
    this.hud.setPitSheetOpen(false);
    this.hud.setRetired(true);

    const isRace = engine.config.kind === 'race';
    const phase = engine.config.qualifyingPhase;
    const isQualifying = engine.config.kind === 'qualifying' && !!phase;
    const reason = player.retirementReason || 'the car is beyond use';

    this.hud.sayRetirement(
      player, reason, player.lap + 1,
      // Race control's own words, and they are not the race's words. A driver
      // who stops in Q1 is not retired from anything: Art. B2.4.3a classifies
      // them on the lap they set and Art. B2.4.3b's three routes out of the
      // classification are the 107% rule, no time in Q1 and disqualification.
      // What the recovery costs them is Art. B4.3.2 — no further part in THE
      // SESSION, and Q1/Q2/Q3 are three periods of one session (Art. B2.4.2).
      isRace ? undefined : {
        text: 'CAR ' + player.driver.raceNumber + ' — NO FURTHER PART',
        offence: isQualifying ? 'RECOVERED — ART. B4.3.2' : 'CAR RECOVERED',
        status: (isQualifying ? 'NO FURTHER PART IN QUALIFYING' : 'SESSION OVER')
          + ' · ' + reason.toUpperCase(),
      },
    );

    const bar = this.el('div', 'retirebar', document.getElementById('app') as HTMLElement);
    // The two answers a driver in a barrier actually has. Named as the thing
    // that happens: `Continue` goes to the numbers, watching keeps the cameras
    // running on the session that is still going on around them.
    const act = (label: string, cls: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
    };
    if (isRace) {
      act('Continue', 'primary', () => {
        this.dismissRetirement();
        this.finishSession();
      });
      act('Watch the race', 'ghost', () => {
        this.spectating = true;
        this.dismissRetirement();
      });
    } else {
      // "once the user presses continue you can check the stats and shit" —
      // so Continue opens the numbers rather than ending anything. In an LTCS
      // there is nothing to end: nineteen other cars are still setting times
      // and the classification is provisional until they stop.
      act('Continue', 'primary', () => this.showRetirementStatus(engine, player));
      act(isQualifying ? 'See out ' + engine.config.name : 'See out the session',
        'ghost', () => {
          this.spectating = true;
          this.dismissRetirement();
        });
    }

    this.retireOverlay = bar;
    window.requestAnimationFrame(() => bar.classList.add('shown'));
  }

  /**
   * The numbers, on request, in the corner — never over the top of the game.
   *
   *   "why is this shit back I thought we said to not have this retirement
   *    bullshit??"
   *
   * Asked five times. What this replaces is a full-bleed, blurred, CLOCK-PAUSING
   * takeover headed SESSION OVER, filed at the player two seconds after an
   * accident they were in. Every fact on it was correct — that is the trap this
   * screen kept falling into, and why it survived four previous requests to
   * remove it. Correct content in a presentation nobody asked for is still the
   * wrong screen.
   *
   * So EVERY STRING SURVIVES and the frame around them does not. No overlay
   * element, no backdrop, no blur, no pause: a sheet pinned under the corner
   * controls, the width of a phone's short edge, with the session running
   * behind it. That last part is not cosmetic. In an LTCS the session is NOT
   * over — only the player's part in it is — and the old panel proved it by
   * freezing nineteen other cars mid-run behind a card about the twentieth.
   */
  private showRetirementStatus(engine: RaceEngine, player: CarEntry): void {
    // Second press closes it. The corner control is the only way in and out, so
    // it has to work in both directions or `Continue` becomes a one-way door
    // onto a sheet with no obvious dismissal.
    if (this.retireStatus) {
      this.retireStatus.remove();
      this.retireStatus = null;
      return;
    }

    // WHICH SESSION THIS IS, which is the whole of what this screen got wrong.
    //
    // A race and a Lap Time Classified Session end differently for a driver who
    // stops, and this screen used to speak only the race's language: RETIRED,
    // "better luck next time", "CLASSIFIED: P20 — DNF", END SESSION. Shown to a
    // player who had just set the fastest lap of Q1 that is four false
    // statements in a row. Their session was over, but their lap was not
    // deleted, they were not classified twentieth, they were not out of the
    // weekend, and there was nothing to wish them better luck about — they were
    // provisionally quickest of the twenty.
    //
    // A race never reaches this sheet — `retireOnTheRadio` answers the race on
    // the radio and sends `Continue` straight to the classification — so the
    // race's own words are not restated here. They were, in an `isRace` branch
    // that had been unreachable since issue #16, which is the `TIER_INFO.carPace`
    // pattern §6 has caught twice.
    const phase = engine.config.qualifyingPhase;
    const isQualifying = engine.config.kind === 'qualifying' && !!phase;

    // Where the driver stands in the segment they were running, on the SAME
    // sort the board and the grid use — so this screen cannot disagree with the
    // classification the player sees ninety seconds later.
    const segment = rankSegment(engine.participants);
    const row = segment.indexOf(player) + 1;
    const advancing = engine.config.advancing;
    const inTheCut = advancing === undefined || (row > 0 && row <= advancing);
    const hasLap = player.bestLapTime > 0;
    const fastestOfAll = engine.fastestLap();
    const mineIsFastest = hasLap && !!fastestOfAll && fastestOfAll.car === player;

    // THE SHEET IS THE CARD, with no overlay wrapping it. The element that used
    // to sit around this one was `inset: 0` with a radial scrim and a 2px
    // backdrop blur, and it is the whole of what the user has been asking to
    // remove — the card inside it was never the complaint.
    const card = document.createElement('div');
    card.className = 'retire-sheet';
    this.el('div', 'retire-flag', card);
    const body = this.el('div', 'retire-body', card);

    this.el('div', 'retire-tag', body, engine.config.name + ' · ' + engine.track.def.name);
    // The headline is the fact the driver most needs and, in a practice or
    // qualifying session, it is not the accident. The accident is on the screen
    // behind this one — which is now literally true, because there is nothing
    // between this sheet and the circuit. What they cannot see is whether the
    // lap survived it.
    this.el('div', 'retire-title is-standing', body,
      hasLap ? 'Your lap stands' : 'Session over');

    // The player's own words for what this screen should say. It acknowledges
    // the accident before it explains it, because that is the order a person
    // needs those two things in.
    const lede = this.el('div', 'retire-lede', body);
    const reason = escapeHtml(player.retirementReason || 'the car is beyond use');
    if (hasLap) {
      // Qualifying is not a race and has no DNF in it: Art. B2.4.3a classifies
      // a driver on the best time they set, and Art. B2.4.3b's three routes out
      // of the classification are the 107% rule, no time in Q1 and
      // disqualification. An accident is none of them.
      lede.innerHTML =
        'Your ' + escapeHtml(engine.config.name) + ' is over — <strong>' + reason +
        '</strong>. The lap is not: a ' +
        (isQualifying ? 'qualifying' : 'practice') + ' session is classified on ' +
        'the time you set, so your <strong>' + formatLapTime(player.bestLapTime) +
        '</strong> stays on the board' +
        (mineIsFastest ? ' — and it is still the quickest of the session.' : '.');
    } else {
      lede.innerHTML =
        'Your ' + escapeHtml(engine.config.name) + ' is over — <strong>' + reason +
        '</strong>. You had not set a representative lap, so there is no time to keep.';
    }

    const worst = player.damage.worst();
    // What happens NEXT, which for a practice or qualifying session is the
    // interesting part and used to be missing entirely.
    this.el('div', 'retire-sub', body,
      isQualifying
        // Art. B4.3.2: a car that stops away from the pit lane and receives
        // physical assistance takes no further part in THE SESSION — and Q1,
        // Q2 and Q3 are three periods of one session (Art. B2.4.2), so the
        // rest of qualifying is gone however quickly the crew work.
        ? 'The marshals have to recover the car, so under the regulations you take ' +
          'no further part in qualifying — but you keep every place your lap earned. ' +
          'The crew have until the race to rebuild it.'
        : 'The crew take the car back to the garage and start rebuilding it. ' +
          'Nothing downstream depends on a practice result; what this costs you is ' +
          'the running, not a grid slot.');

    // --- The facts ---------------------------------------------------------
    const facts = this.el('div', 'retire-facts', body);
    const fact = (label: string, value: string, tone = '') => {
      const row2 = this.el('div', 'retire-fact', facts);
      this.el('div', 'retire-fact-label', row2, label);
      this.el('div', 'retire-fact-value' + (tone ? ' ' + tone : ''), row2, value);
    };

    fact('Cause', player.retirementReason || 'Accident', 'is-bad');
    fact('Worst damage', COMPONENT_NAMES[worst.id], bandOf(worst.health) === 'critical' ? 'is-bad' : 'is-warn');
    // Corners have names on the circuits that have them; everywhere else, the
    // sector. "On circuit" told the player something they already knew.
    fact('Where', engine.track.cornerNameAt(player.s)
      || 'Sector ' + (player.currentSectorIndex + 1));

    // The lap first, because it is the thing that survived.
    fact(mineIsFastest ? 'Fastest lap of the session' : 'Your best lap',
      hasLap ? formatLapTime(player.bestLapTime) : 'No time set',
      hasLap ? (mineIsFastest ? 'is-hero' : '') : 'is-warn');
    // "As it stands", not "Classified": the session is still running behind
    // this card and cars still on the circuit can take the place off them.
    // Claiming a final position here would be the same species of lie as
    // claiming a DNF. It is now literally running — this sheet no longer
    // pauses the clock — so the wording and the behaviour finally agree.
    fact('As it stands',
      row > 0 ? 'P' + row + ' of ' + segment.length + ' in ' + engine.config.name
        : engine.config.name,
      row === 1 ? 'is-hero' : '');
    if (isQualifying && advancing !== undefined && phase) {
      fact('Q' + (phase + 1),
        inTheCut ? 'Through, on this order' : 'Outside the cut',
        inTheCut ? 'is-good' : 'is-warn');
    }
    // The cost of the accident, stated as the one thing it actually costs
    // (Art. B4.3.2) — and only where there is something left to be barred
    // from. In Q3 there is no rest of qualifying, so saying the driver takes
    // no further part in it would be technically true and completely useless.
    if (isQualifying && phase && phase < 3) {
      fact('Rest of qualifying', 'No further part', 'is-warn');
    }

    // --- What broke --------------------------------------------------------
    // Only the parts that took damage, worst first. A list of twelve components
    // that all read 100% is a list nobody reads.
    const hurt = COMPONENT_IDS
      .filter((id) => player.damage.health[id] < 0.995)
      .sort((a, b) => player.damage.health[a] - player.damage.health[b])
      .slice(0, 6);
    if (hurt.length > 0) {
      const parts = this.el('div', 'retire-parts', body);
      for (const id of hurt) {
        const health = player.damage.health[id];
        const row = this.el('div', 'retire-part', parts);
        this.el('div', 'retire-part-name', row, COMPONENT_NAMES[id]);
        const bar = this.el('div', 'retire-part-bar', row);
        const fill = this.el('div', 'retire-part-fill', bar);
        const band = bandOf(health);
        fill.style.width = Math.round(health * 100) + '%';
        fill.style.background =
          band === 'critical' ? 'var(--race-red-hi)'
          : band === 'damaged' ? 'var(--amber)'
          : band === 'worn' ? '#9fb0c4' : 'var(--mint)';
        this.el('div', 'retire-part-pct', row, Math.round(health * 100) + '%');
      }
    }

    // --- Where to go next --------------------------------------------------
    const actions = this.el('div', 'retire-actions', body);
    const act = (label: string, cls: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
    };

    // In an LTCS the session is NOT over — only the player's part in it is.
    // Nineteen other cars are still setting times, and the classification this
    // sheet has just quoted is provisional until they stop. So the primary
    // action is to let the session reach its flag, which is both what really
    // happens to a driver watching from the garage and the only path that
    // produces an honest result.
    //
    // "End session" as a primary action was race language, and it was worse
    // than wrong here: it froze the other cars' running mid-run and then
    // published the truncated order as the segment's classification.
    act(isQualifying ? 'See out ' + engine.config.name : 'See out the session',
      'primary', () => {
        this.spectating = true;
        this.dismissRetirement();
      });

    // AND SO IS THIS ONE, NOW.
    //
    //   "also like even tho I DNF doesn't mean that the rest weren't able to
    //    get a time classification, just make the simulation up or something,
    //    ykwim"
    //
    // Which is simply true of the sport, and this button used to deny it. It
    // called `finishSession` on the spot, so the order it published was
    // whatever the board happened to read at the moment of the accident.
    // Measured on a 720s Q1 at Bahrain with the player retired at t=90s:
    // **0 of 20 cars had set a lap**, so the grid it produced was garage
    // release order wearing a classification's clothes. Run on to the flag from
    // that same state and 19 of the 20 have a time — everyone except the driver
    // who stopped. The other cars were never the problem.
    //
    // So it runs the remainder rather than truncating it. Not invented numbers:
    // the same engine, the same twenty cars, stepped with nothing drawn. See
    // `runOutToTheFlag`.
    act('Run it out to the flag', 'secondary', () => {
      this.dismissRetirement();
      this.runOutToTheFlag(() => this.finishSession());
    });
    act('Restart session', 'secondary', () => {
      const id = engine.track.def.id;
      this.dismissRetirement();
      this.launchSession(id);
    });
    act(this.career ? 'Back to the paddock' : 'Back to the menu', 'ghost', () => {
      this.dismissRetirement();
      this.abandonSession();
    });

    this.el('div', 'retire-hint', body,
      'The other nineteen keep running either way. Seeing it out watches them do it with ' +
      'the cameras on the leaders; running it out simulates the rest of ' +
      engine.config.name + ' at full speed. Both publish the same classification.');

    (document.getElementById('app') as HTMLElement).appendChild(card);
    this.retireStatus = card;
    // One frame before the class goes on, so the transition has a start state
    // to run from rather than being applied to an element that was born visible.
    window.requestAnimationFrame(() => card.classList.add('shown'));
  }

  private dismissRetirement(): void {
    this.retireOverlay?.remove();
    this.retireOverlay = null;
    this.retireStatus?.remove();
    this.retireStatus = null;
    this.hud.setRetired(false);
    // NOTHING ON THIS PATH PAUSES ANY MORE. The practice/qualifying card used
    // to, and unpausing here was the counterweight to it. Both are gone: a
    // retirement stops the player, not the session. Left in place because it is
    // still the state this has to leave — a session resumed frozen is the
    // failure this guards, and the pause menu is reachable from a corner bar.
    this.clock.paused = false;
    this.audio.setSuspended(false);
  }

  /**
   * Leaves a session that is still running.
   *
   * The session is thrown away rather than classified: the player did not
   * complete it, so recording a result for it would put a fictitious finishing
   * position into a career. A weekend abandoned part-way is abandoned whole,
   * which is why the queue is cleared as well as the engine.
   */
  private abandonSession(): void {
    this.dismissRetirement();
    // A run-out in flight is stepping the engine this is about to release.
    if (this.runningOut) this.runningOut.cancelled = true;
    this.runningOut = null;
    this.retirementShown = false;
    this.spectating = false;
    this.setPaused(false);
    this.pitPrompt.close();
    this.hud.setPitSheetOpen(false);
    this.renderer.unloadSession();
    this.engine = null;
    this.weekend = [];
    this.weekendIndex = 0;
    this.resetQualifying();
    // A weekend abandoned part-way is abandoned whole — including the copy on
    // disk, or the hub would offer to resume something the player just walked
    // out of.
    this.forgetWeekend();
    if (this.career) this.showCareerHub(); else this.showMenu();
  }

  private finishSession(): void {
    const engine = this.engine;
    if (!engine) return;

    const config = engine.config;
    const player = engine.playerCar;

    // A race result feeds the career; practice and qualifying do not.
    if (config.kind === 'race' && this.career && player) {
      // The player's own driver id is whatever the career gave them, and the
      // engine already races them under it — so no translation is needed, and
      // the previous version's 'PLAYER' remapping was a source of drift between
      // the driven path and the simulated one.
      const order = engine.standings.map((c) => c.driver.id);
      const fl = engine.fastestLap();
      const result: RoundResult = {
        round: this.career.round,
        circuitId: engine.track.def.id,
        order,
        // Retirement and exclusion are separate outcomes under the 2026 rules
        // and the engine models both, so the championship is told about both. A
        // disqualified driver scores nothing but has not had a DNF.
        retired: engine.cars.filter((c) => c.retired && !c.disqualified).map((c) => c.driver.id),
        disqualified: engine.cars.filter((c) => c.disqualified).map((c) => c.driver.id),
        poleDriverId: this.qualifyingGrid[0] ?? order[0] ?? '',
        fastestLapDriverId: fl ? fl.car.driver.id : (order[0] ?? ''),
        wetRace: engine.weather.hasRained,
        driven: true,
      };
      this.career.recordPlayerRound(result);
      this.profiles.saveCareer(this.careerId, this.career.state);
      // The press room is OFFERED rather than imposed. A driven race already
      // ends on the classification with the rostrum at the head of it, and a
      // mandatory screen between the flag and the paddock every single round
      // is the kind of thing players learn to click through without reading.
      this.showResults(
        () => this.afterRace(result),
        () => this.showPresser(result, () => this.afterRace(result)),
      );
      return;
    }

    // Knockout qualifying: work out who survives, who is out, and where the
    // eliminated cars sit on the final grid.
    if (config.kind === 'qualifying' && config.qualifyingPhase) {
      this.resolveQualifyingSegment(engine, config.qualifyingPhase, config.advancing);
    }

    this.weekendIndex++;
    if (this.weekendIndex < this.weekend.length) {
      // The grid this segment just built, and the fact that it has been run,
      // both belong on disk before the player is shown anything: closing the
      // tab on a results screen is how somebody leaves a weekend.
      this.rememberWeekend(engine.track.def.id);
      this.showResults(() => this.showBriefing(engine.track.def.id));
    } else {
      this.forgetWeekend();
      this.showResults(() => (this.career ? this.showCareerHub() : this.showMenu()));
    }
  }

  /**
   * @param presser opens the post-race press conference, when there is a
   * career round for the room to be about. Omitted for practice, qualifying
   * and every quick race, none of which the press turn up to.
   */
  private showResults(onContinue: () => void, presser?: () => void): void {
    const engine = this.engine;
    if (!engine) { onContinue(); return; }

    this.setScreen('results');
    const isRace = engine.config.kind === 'race';
    const player = engine.playerCar;
    const fastest = engine.fastestLap();

    const { body, actions } = this.page({
      tab: engine.config.name,
      where: engine.track.def.name,
      title: 'Classification',
      sub: engine.track.def.officialName + ' · ' + engine.weather.label,
      meta: [
        ['Session', engine.config.name],
        // The cars that took part in THIS segment, not the whole entry list.
        //
        // `standings` is every car entered for the weekend, so a Q2 board
        // headed itself "Runners 20" while the list two inches below it
        // correctly said "15 running" — the same screen contradicting itself
        // about the one number the knockout is about. Q2 and Q3 run a reduced
        // field and `participants` is what the engine itself places on track.
        ['Runners', String(engine.participants.length)],
      ],
      // The session is over, so all three sectors are done.
      rule: { ...this.circuitRule(engine.track.def), at: 3 },
    });

    // THE PODIUM, after every race.
    //
    // IT USED TO BE GATED ON A CAREER, and the argument for that — "a quick
    // race has no season for the result to mean anything in" — turned out to
    // be the reason nobody had ever seen it. The person who commissioned this
    // screen had been driving qualifying sessions for weeks: "I have yet to
    // see the in game renders at all about the podiums." A ceremony that
    // almost never fires is a ceremony that was not built.
    //
    // A podium is what happens at the end of a motor race, in a career or not.
    // The career still gets the part that needs one — the tier's name on it —
    // and a quick race simply omits that. See `src/ui/Podium.ts`.
    if (isRace && engine.standings.length > 0) {
      const s = this.career?.state ?? null;
      const meId = s?.playerDriverId ?? player?.driver.id ?? '';
      buildPodium(body, {
        top3: engine.standings.slice(0, 3).map((c) => ({
          driverId: c.driver.id,
          firstName: c.driver.firstName,
          lastName: c.driver.lastName,
          teamName: c.team.shortName,
          colour: c.team.colour,
          accent: c.team.accent,
          gap: c.position === 1 ? ''
            : c.lapsDown > 0 ? '+' + c.lapsDown + (c.lapsDown === 1 ? ' lap' : ' laps')
            : '+' + c.gapToLeader.toFixed(3),
          isPlayer: c.driver.id === meId,
          // The player's own designed helmet — from the career if there is one,
          // and otherwise from the driver on this device, so a quick race puts
          // the right head on the rostrum too. Everybody else's is derived from
          // their driver id, so the whole grid has one and none of it is stored.
          helmet: c.driver.id === meId
            ? (s ? playerHelmet(s) : this.profiles.active?.helmet)
            : undefined,
        })),
        playerPosition: player && !player.retired ? player.position : 0,
        circuitName: engine.track.def.name,
        tierName: this.career ? TIER_CAR[this.career.tier].shortName : '',
      });
    }

    // The player's own result first, because that is the question they are
    // asking the screen. The classification below answers everything else.
    if (player) {
      const grid = this.el('div', 'stat-grid', body);
      let tIndex = 0;
      const tile = (label: string, value: string, meta = '', cls = '') => {
        const s = this.el('div', 'stat' + (cls ? ' ' + cls : ''), grid);
        s.style.setProperty('--i', String(tIndex++));
        this.el('div', 'stat-label', s, label);
        this.el('div', 'stat-value', s, value);
        if (meta) this.el('div', 'stat-meta', s, meta);
      };
      // Each session kind gets its own words. "You qualified P1 — won it" is
      // what the old wording would have printed after a practice session.
      const kind = engine.config.kind;
      const headline =
        kind === 'race' ? 'You finished'
        : kind === 'qualifying' ? 'You qualified'
        : 'You ended up';
      const topNote =
        kind === 'race' ? 'Won it'
        : kind === 'qualifying' ? 'Pole position'
        : 'Quickest of the lot';
      // A DNF is a race outcome and only a race outcome. In practice and
      // qualifying the driver is classified on their lap (Art. B2.4.3a) — the
      // accident cost them the rest of the session, not the position — so the
      // headline tile shows the position they actually hold and the accident
      // goes in the meta line under it, where it belongs.
      const dnf = player.retired && kind === 'race';
      // The headline tile is scored the way every other figure in the game
      // is: purple for the outright best, green for a good day, red for a
      // retirement. It cannot be purple just for being the headline.
      const outcome =
        dnf ? 'bad'
        : player.position === 1 ? 'hero'
        : player.position <= 3 ? 'good'
        : '';
      tile(headline,
        dnf ? 'DNF' : 'P' + player.position,
        dnf ? player.retirementReason
          : player.retired ? player.retirementReason + ' — the lap still counts'
          : player.position === 1 ? topNote : 'of ' + engine.standings.length + ' cars',
        outcome);

      const mineIsFastest = fastest ? fastest.car.isPlayer : false;
      tile('Your best lap',
        player.bestLapTime > 0 ? formatLapTime(player.bestLapTime) : '--:--.---',
        player.pitStops + (player.pitStops === 1 ? ' stop' : ' stops'),
        mineIsFastest ? 'hero' : '');
      if (fastest && !mineIsFastest) {
        tile('Fastest lap', formatLapTime(fastest.time),
          fastest.car.driver.firstName + ' ' + fastest.car.driver.lastName, 'hero');
      }
      if (isRace && !player.retired && player.position > 1) {
        tile('Gap to the win', '+' + player.gapToLeader.toFixed(3) + 's',
          engine.standings[0].driver.lastName + ' took it');
      }
    }

    // --- Qualifying: a segment, not a flat list ---------------------------
    //
    // `engine.standings` ranks every car on its best lap, and after Q1 that is
    // the wrong board: a car knocked out in Q1 keeps its Q1 lap, which can be
    // quicker than a survivor's slow first run in Q2, so the two interleave
    // and the list reads as though somebody eliminated is still in the fight.
    // The segment's own runners come first, ranked by `rankSegment` — the SAME
    // function that decides the grid — and the cars already out sit beneath
    // them, holding the slots they earned.
    const phase = engine.config.qualifyingPhase;
    const isQualifying = engine.config.kind === 'qualifying' && !!phase;
    const advancing = isQualifying ? engine.config.advancing : undefined;
    const qOrder = isQualifying
      ? qualifyingBoardOrder(engine.participants, engine.standings, advancing)
      : { runners: [] as CarEntry[], alreadyOut: [] as CarEntry[], cutAfter: -1 };
    const runners = qOrder.runners;
    const alreadyOut = qOrder.alreadyOut;

    // The segment strip: which part of qualifying this was, and where it sits
    // in the three. The sector rule already carries "how far through the lap";
    // this carries "how far through the session", which is the fact a knockout
    // format has and a practice session does not.
    if (isQualifying && phase) {
      qualifyingStrip(body, phase);
    }

    // After a knockout segment, say plainly who went through and who is out.
    // A bare classification does not communicate that five cars just had their
    // weekend decided.
    if (phase && engine.config.advancing !== undefined) {
      const out = engine.participants.length - this.qualifyingSurvivors.length;
      this.el('div', 'notice', body,
        `${this.qualifyingSurvivors.length} cars go through to Q${phase + 1}. ${out} are out, ` +
        'and keep the grid slots they have just earned.');
    } else if (phase === 3) {
      this.el('div', 'notice', body, 'Q3 is done. That is the front of the grid decided.');
    }

    const classHead = this.el('div', 'section-title', body,
      isRace ? 'Race classification' : isQualifying ? 'Qualifying' : 'Timesheet');
    this.el('span', 'section-count', classHead,
      isQualifying ? runners.length + ' running' : engine.standings.length + ' cars');

    // The classification, as the timing board it is. The fastest lap of the
    // session is purple, everything else is white — the sport's own rule, so
    // the board needs no legend.
    const bestOfAll = fastest?.time ?? 0;
    const board = this.board(body, isRace
      ? ['P', 'Driver', 'Best Lap', 'Gap', 'Stops']
      : ['P', 'Driver', 'Best Lap', 'Gap', '']);
    board.classList.add(isQualifying ? 'tboard-quali' : 'tboard-class');

    // In qualifying the board is the SEGMENT, not the whole field: the cars
    // that went out in Q1 are not competing in Q2 and ranking them together on
    // best lap puts a knocked-out car above a survivor, which is exactly what
    // the old flat list did. So this segment's runners come first, in this
    // segment's order, and the cars already out sit beneath them holding the
    // grid slots they have earned.
    const order = isQualifying ? [...runners, ...alreadyOut] : engine.standings;
    const segmentLeader = isQualifying ? runners[0] : engine.standings[0];

    for (const [i, car] of order.entries()) {
      const notes: string[] = [];
      if (car.disqualified) notes.push('DSQ');
      // A retirement is worth noting in any session — it explains why a car
      // that was quick stopped being quick — but in an LTCS it must not
      // out-rank the tag that says whether the driver went through, because
      // that is the one the board exists to communicate and the accident does
      // not change it.
      else if (car.retired && isRace) notes.push(car.retirementReason);
      if (car.penaltySeconds > 0) notes.push('+' + car.penaltySeconds + 's');
      if (car.trackLimitStrikes > 0) notes.push(car.trackLimitStrikes + ' limits');

      const hasLap = car.bestLapTime > 0;
      const isFastest = hasLap && bestOfAll > 0 && Math.abs(car.bestLapTime - bestOfAll) < 1e-6;
      const out = isQualifying && car.eliminated;
      const through = isQualifying && !out && advancing !== undefined && i < advancing;

      // In qualifying the gap that matters is to the quickest lap of the
      // segment, not the race-classification gap — nobody is racing anybody.
      const gap = isQualifying
        ? (!hasLap ? 'NO TIME'
          : i === 0 && !out ? 'FASTEST'
          : segmentLeader && segmentLeader.bestLapTime > 0
            ? '+' + (car.bestLapTime - segmentLeader.bestLapTime).toFixed(3)
            : '—')
        : resultGapCell(car, isRace);

      const tag = notes.length ? { text: notes[0], cls: 'out' }
        : out ? { text: 'Q' + car.eliminatedInPhase, cls: 'out' }
        : through ? { text: 'Through', cls: 'go' }
        : isQualifying && advancing !== undefined ? { text: 'Out', cls: 'warn' }
        : !isQualifying && car.pitStops > 0
          ? { text: car.pitStops + ' stop' + (car.pitStops === 1 ? '' : 's') }
          : undefined;

      this.trow(board, {
        // A dash means "this car has no classified position". Disqualification
        // earns one (Art. B2.4.3b.iii makes the driver unclassified); a
        // retirement earns one in a race, where the car did not cover the
        // distance. In practice or qualifying it earns nothing — the driver is
        // classified on the lap they set, so the row keeps its number. Printing
        // a dash beside the fastest lap of Q1 was the same lie as printing DNF
        // next to it.
        pos: car.disqualified || (car.retired && isRace)
          ? '—'
          : String(isQualifying ? i + 1 : car.position),
        colour: hexColour(car.team.colour),
        team: car.team,
        code: car.driver.code,
        name: car.driver.firstName + ' ' + car.driver.lastName,
        first: car.driver.firstName,
        last: car.driver.lastName.toUpperCase(),
        note: car.team.name,
        index: i,
        figs: [
          hasLap
            ? { text: formatLapTime(car.bestLapTime), cls: isFastest ? 'best' : '' }
            : { text: '--:--.---', cls: 'none' },
          { text: gap, cls: gap === 'WINNER' || gap === 'FASTEST' ? 'best'
            : gap === 'NO TIME' ? 'none'
            : gap.startsWith('+') ? 'dim' : 'none' },
        ],
        tag,
        state: car.isPlayer ? 'me'
          : out ? 'knocked'
          : car.disqualified || (car.retired && isRace) ? 'out'
          : through ? 'through'
          : (!isQualifying && car.position === 1) || (isQualifying && i === 0) ? 'best'
          : undefined,
      });

      // The line across the board, drawn where the weekend is decided.
      if (isQualifying && qOrder.cutAfter > 0 && i === qOrder.cutAfter - 1) {
        this.cutLine(board, qOrder.cutAfter + ' advance to Q' + ((phase ?? 1) + 1));
      }
      if (isQualifying && alreadyOut.length > 0 && i === runners.length - 1) {
        // Quiet, because this one is not a decision being made now: these cars
        // were knocked out in an earlier segment and are on the board only so
        // the grid reads whole.
        this.cutLine(board, 'Already out — grid slots ' +
          (runners.length + 1) + '–' + order.length, true);
      }
    }

    if (presser) {
      this.button('Press conference', actions, () => {
        this.renderer.unloadSession();
        this.engine = null;
        presser();
      }, 'btn ghost');
    }
    this.spacer(actions);
    this.button('Continue', actions, () => {
      this.renderer.unloadSession();
      this.engine = null;
      onContinue();
    }, 'btn primary');
  }

  /**
   * The winter, as a sequence of beats rather than an alert box.
   *
   * This is the payoff for running three championships instead of one. The
   * player does not just find out whether THEY were promoted — they find out who
   * won Formula 3, which two drivers came up behind them, who retired, and who
   * moved where. None of it is invented for the screen: every line is read from
   * the report the off-season actually produced.
   */
  private showOffSeason(
    fromTier: string,
    outcome: { report: OffSeasonReport; summary: SeasonSummary; promoted: boolean },
  ): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('career-hub');

    const { report, summary, promoted } = outcome;
    const wonTitle = summary.playerTier
      && report.champions.find((c) => c.tier === summary.playerTier)?.driverId
        === career.state.playerDriverId;

    const { body, actions } = this.page({
      tab: summary.year + ' season',
      where: 'Off-season',
      title: wonTitle ? 'Champion' : promoted ? 'Promoted' : 'Season over',
      sub: 'P' + summary.playerPosition + ' in ' +
        TIER_CAR[fromTier as keyof typeof TIER_CAR].shortName +
        ' · ' + summary.playerPoints + ' points',
      back: () => this.showCareerHub(),
    });

    // The player's own outcome, stated first and plainly.
    const lead = this.el('div', 'notice', body);
    lead.textContent = promoted
      ? 'Top two. You move up to ' + TIER_CAR[career.tier].shortName + ' with ' +
        career.teamNameOf(career.state.teamId) + ' next season.'
      : career.state.endedReason
        ? career.state.endedReason
        : 'The top two moved up. You did not, so you stay in ' +
          TIER_CAR[career.tier].shortName + ' for another year.';

    // Champions, all three tiers.
    this.el('div', 'section-title', body, 'Champions');
    const champs = this.el('div', 'stat-grid', body);
    for (const c of report.champions) {
      const card = this.el('div', 'stat hero', champs);
      this.el('div', 'stat-label', card, TIER_CAR[c.tier].shortName);
      this.el('div', 'stat-value', card, career.displayName(c.driverId));
      this.el('div', 'stat-meta', card, career.teamNameOf(c.teamId));
    }

    // Who came up, and from where.
    const moves = report.promotions.filter((p) => p.to !== p.from);
    if (moves.length > 0) {
      const head = this.el('div', 'section-title', body, 'Promoted');
      this.el('span', 'section-count', head, moves.length + ' drivers');
      const b = this.board(body, ['', 'Driver', 'From', 'To', '']);
      b.classList.add('tboard-form');
      for (const [i, p] of moves.entries()) {
        const mine = p.driverId === career.state.playerDriverId;
        this.trow(b, {
          pos: String(p.championshipPosition),
          colour: hexColour(getTeam(p.toTeamId).colour),
          code: TIER_CAR[p.to].shortName.replace('Formula ', 'F'),
          name: career.displayName(p.driverId),
          index: i,
          figs: [
            { text: TIER_CAR[p.from].shortName.replace('Formula ', 'F'), cls: 'dim' },
            { text: career.teamNameOf(p.toTeamId), cls: '' },
          ],
          state: mine ? 'me' : undefined,
        });
      }
    }

    if (report.departures.length > 0) {
      const head = this.el('div', 'section-title', body, 'Left the sport');
      this.el('span', 'section-count', head, report.departures.length + ' drivers');
      const list = this.el('div', 'notice', body);
      list.textContent = report.departures
        .map((d) => career.displayName(d.driverId) +
          (d.reason === 'retired' ? ' (retired)' : ' (dropped)'))
        .join(' · ');
    }

    if (report.signings.length > 0) {
      const head = this.el('div', 'section-title', body, 'Silly season');
      this.el('span', 'section-count', head, report.signings.length + ' moves');
      const b = this.board(body, ['', 'Driver', 'From', 'To', '']);
      b.classList.add('tboard-form');
      for (const [i, sg] of report.signings.slice(0, 12).entries()) {
        this.trow(b, {
          pos: '',
          colour: hexColour(getTeam(sg.teamId).colour),
          code: TIER_CAR[sg.tier].shortName.replace('Formula ', 'F'),
          name: career.displayName(sg.driverId),
          index: i,
          figs: [
            { text: career.teamNameOf(sg.previousTeamId), cls: 'dim' },
            { text: career.teamNameOf(sg.teamId), cls: '' },
          ],
        });
      }
    }

    this.spacer(actions);
    if (career.state.endedReason) {
      this.button('Career over', actions, () => this.showCareerOver(), 'btn primary');
    } else {
      this.button('Start ' + career.state.season.year, actions,
        () => this.showCareerHub(), 'btn primary');
    }
  }

  /** The end of the road. Stated once, honestly, with the career's own numbers. */
  private showCareerOver(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('career-hub');

    const s = career.state;
    const wins = s.history.filter(
      (h) => h.playerTier && h.championByTier[h.playerTier] === s.playerDriverId).length;

    const { body, actions } = this.page({
      tab: 'Career',
      where: 'Career',
      title: s.player.firstName + ' ' + s.player.lastName,
      sub: s.history.length + ' seasons · ' + wins +
        (wins === 1 ? ' championship' : ' championships'),
      back: () => this.showMenu(),
    });

    this.el('div', 'notice', body, s.endedReason ?? 'The career has ended.');

    if (s.history.length > 0) {
      this.el('div', 'section-title', body, 'Every season');
      const b = this.board(body, ['Year', 'Championship', 'Finish', 'Points', '']);
      b.classList.add('tboard-form');
      for (const [i, h] of s.history.entries()) {
        const tier = h.playerTier ? TIER_CAR[h.playerTier].shortName : '—';
        const champ = h.playerTier && h.championByTier[h.playerTier] === s.playerDriverId;
        this.trow(b, {
          pos: String(h.year),
          colour: hexColour(getTeam(h.playerTeamId).colour),
          code: tier.replace('Formula ', 'F'),
          name: career.teamNameOf(h.playerTeamId),
          index: i,
          figs: [
            {
              text: 'P' + h.playerPosition,
              cls: h.playerPosition === 1 ? 'best' : h.playerPosition <= 3 ? 'gain' : 'dim',
            },
            { text: String(h.playerPoints), cls: h.playerPoints > 0 ? '' : 'none' },
          ],
          tag: champ ? { text: 'WDC', cls: 'best' } : undefined,
          state: champ ? 'best' : undefined,
        });
      }
    }

    this.spacer(actions);
    this.button('New career', actions, () => this.showCareerCreate(), 'btn primary');
  }

  // =======================================================================
  // The rostrum and the press room — issues #13 and #38
  // =======================================================================
  //
  // WHAT WAS WRONG. `src/ui/Podium.ts` fired only at the foot of a
  // classification the player had to drive a whole race to reach;
  // `src/ui/PressConference.ts` fired nowhere at all — 540 lines whose only
  // executor was `npm run shoot:people`. The person who commissioned both said
  // so himself: *"I have yet to see the in game renders at all about the
  // podiums, the career starts."*
  //
  // WHAT A PLAYER PRESSES NOW. The order of the real Sunday: chequered flag,
  // rostrum, press room, paddock. `Simulate Race` on the career hub used to
  // jump straight from the button to a narrative event; it now goes through
  // the ceremony it just earned. Both screens carry `onContinue` rather than
  // deciding where to go, so the one place that knows what comes after a race
  // is still `afterRace`.
  //
  // Both are reachable in two clicks from the front page — `Continue` >
  // `Simulate Race` — which is what lets `probe:smoke` hold them in its
  // required set. A driven race reaches the same two screens from the
  // classification's action bar.

  /**
   * The rostrum for a round the career has just recorded.
   *
   * The classification screen keeps its own inline podium and is untouched:
   * this is the ceremony BEFORE the timing sheet, not a second copy of it.
   */
  private showPodium(result: RoundResult, onContinue: () => void): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('podium');

    const s = career.state;
    const circuit = getCircuit(result.circuitId);
    const grid = career.grid();
    const me = s.playerDriverId;
    const myIndex = result.order.indexOf(me);
    const retired = result.retired.includes(me);

    const { body, actions } = this.page({
      tab: TIER_CAR[s.tier].shortName + ' · Round ' + (result.round + 1),
      where: 'Podium',
      title: circuit.name,
      sub: circuit.officialName + ' · the rostrum',
      // No `back`: a ceremony you can reverse out of into the round it was for
      // is a ceremony that has not happened. The way on is the action bar.
      meta: [['Round', result.round + 1 + ' / ' + career.calendar.length]],
    });

    buildPodium(body, {
      top3: result.order.slice(0, 3).map((id, i) => {
        const d = grid.find((g) => g.id === id);
        const team = d ? getTeam(d.teamId) : getTeam(s.teamId);
        const name = splitName(career.displayName(id));
        return {
          driverId: id,
          firstName: name.first,
          lastName: name.last,
          teamName: team.shortName,
          colour: team.colour,
          accent: team.accent,
          // A simulated round records an order and not a gap, so the rostrum
          // prints the position rather than inventing a time to three decimal
          // places that no part of the simulation produced.
          gap: i === 0 ? '' : 'P' + (i + 1),
          isPlayer: id === me,
          helmet: id === me ? playerHelmet(s) : undefined,
        };
      }),
      playerPosition: retired || myIndex < 0 ? 0 : myIndex + 1,
      circuitName: circuit.name,
      tierName: TIER_CAR[s.tier].shortName,
    });

    this.button('Press conference', actions,
      () => this.showPresser(result, onContinue), 'btn ghost');
    this.spacer(actions);
    this.button('Continue', actions, onContinue, 'btn primary');
  }

  /**
   * The post-race press conference for a round the career has recorded.
   *
   * The panel is who the regulations put on it — the top three — with the
   * player added when they are not among them, because a press conference the
   * protagonist is not in is a cutscene. The questions are generated from what
   * actually happened in the round rather than being a fixed script, so the
   * room is asking about the race that was just run.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO: apply consequences. `PressAnswer`
   * carries an `effects` list and `PressConferenceSpec` an `onAnswer` hook, and
   * a reputation model behind them is career-system work that belongs with the
   * publicist and the agencies §7 records as not built. The effects shown here
   * are the ones the scene was authored to display; nothing reads them back.
   * Routing the room is this change; furnishing it is not.
   */
  private showPresser(result: RoundResult, onContinue: () => void): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('presser');

    const s = career.state;
    const circuit = getCircuit(result.circuitId);
    const grid = career.grid();
    const me = s.playerDriverId;
    const myIndex = result.order.indexOf(me);
    const myPos = result.retired.includes(me) || myIndex < 0 ? 0 : myIndex + 1;
    const winner = result.order[0];
    const winnerName = winner ? career.displayName(winner) : 'the winner';

    const { body, actions } = this.page({
      tab: circuit.name + ' · Round ' + (result.round + 1),
      where: 'Press conference',
      title: 'Press conference',
      sub: 'Post-race · ' + TIER_CAR[s.tier].name,
    });

    // Two to four, says the scene's own contract — more than four and nobody's
    // face is bigger than a stamp. The top three, and the player in place of
    // third when they finished off the rostrum.
    const panelIds = result.order.slice(0, 3);
    if (myPos === 0 || myPos > 3) panelIds[2] = me;

    const questions: PressQuestion[] = [];
    if (myPos === 1) {
      questions.push({
        id: 'won',
        text: 'You led that from the front. Was it as comfortable as it looked?',
        answers: [
          {
            id: 'won-warm', tone: 'warm',
            text: 'The car was in a window all weekend. That is the factory, not me.',
            effects: [{ label: 'Chassis morale', value: 9 }],
          },
          {
            id: 'won-cool', tone: 'cool',
            text: 'It is never comfortable. You just do not show it on the radio.',
          },
          {
            id: 'won-hot', tone: 'hot',
            text: 'Nobody had anything for us. I would not read too much into the gap.',
            effects: [{ label: 'Fan rating', value: -4 }],
          },
        ],
      });
    } else if (myPos > 0) {
      questions.push({
        id: 'placed',
        text: 'P' + myPos + ', and ' + winnerName + ' took it. What was missing?',
        answers: [
          {
            id: 'placed-warm', tone: 'warm',
            text: 'They were quicker today. We take the points and go again.',
            effects: [{ label: 'Team trust', value: 6 }],
          },
          {
            id: 'placed-sharp', tone: 'sharp',
            text: 'Pace was there. We lost it in the window we chose to stop in.',
            effects: [{ label: 'Strategy morale', value: -7 }],
          },
          {
            id: 'placed-cool', tone: 'cool',
            text: 'A tenth here and a tenth there. That is the whole of it.',
          },
        ],
      });
    } else {
      questions.push({
        id: 'out',
        text: 'You did not see the flag. Talk us through it.',
        answers: [
          {
            id: 'out-warm', tone: 'warm',
            text: 'My mistake, and the crew had built me a good car. That hurts more.',
            effects: [{ label: 'Chassis morale', value: 7 }, { label: 'Pressure', value: 5 }],
          },
          {
            id: 'out-cool', tone: 'cool',
            text: 'We will look at the data before I say anything I cannot support.',
          },
          {
            id: 'out-hot', tone: 'hot',
            text: 'Ask the car. I was a passenger from the moment it let go.',
            effects: [{ label: 'Team trust', value: -9 }, { label: 'Fan rating', value: 5 }],
          },
        ],
      });
    }
    questions.push({
      id: 'season',
      text: result.wetRace
        ? 'That is the second wet race the championship has had. Does it suit this car?'
        : 'Where does that leave you with ' + Math.max(
          0, career.calendar.length - result.round - 1) + ' rounds still to run?',
      answers: [
        {
          id: 'season-cool', tone: 'cool',
          text: 'We are racing the calendar, not the weekend. Nothing changes.',
        },
        {
          id: 'season-warm', tone: 'warm',
          text: 'The people upstairs have given me a car that is getting better. '
            + 'That is all I need.',
          effects: [{ label: 'Factory morale', value: 8 }],
        },
        {
          id: 'season-sharp', tone: 'sharp',
          text: 'If we bring what we have been promised, we are in this.',
          effects: [{ label: 'Pressure', value: 6 }],
        },
      ],
    });

    buildPressConference(body, {
      circuitName: circuit.name,
      tierName: TIER_CAR[s.tier].name,
      seriesName: TIER_CAR[s.tier].shortName,
      round: 'Round ' + (result.round + 1) + ' · Post-race',
      // Stable, so the room, the journalists and their faces are the same room
      // every time this round is opened.
      seed: s.season.year * 100 + result.round,
      panel: panelIds.filter((id): id is string => !!id).map((id) => {
        const d = grid.find((g) => g.id === id);
        const team = d ? getTeam(d.teamId) : getTeam(s.teamId);
        const name = splitName(career.displayName(id));
        return {
          id,
          firstName: name.first,
          lastName: name.last,
          code: career.displayCode(id),
          teamName: team.shortName,
          colour: team.colour,
          accent: team.accent,
          isPlayer: id === me,
          raceNumber: d?.raceNumber,
          helmet: id === me ? playerHelmet(s) : undefined,
        };
      }),
      questions,
    });

    this.spacer(actions);
    this.button('Continue', actions, onContinue, 'btn primary');
  }

  /** After a race, offer a narrative event if one is eligible. */
  private afterRace(result: RoundResult): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    if (career.state.endedReason) { this.showCareerOver(); return; }

    const me = career.state.playerDriverId;
    const myIndex = result.order.indexOf(me);
    // Whether the teammate finished ahead is a real condition several events
    // read, and it used to be hard-coded false — so every event that asked
    // about the teammate was unreachable.
    const mateId = career.grid().find(
      (d) => d.teamId === career.state.teamId && d.id !== me)?.id;
    const mateIndex = mateId ? result.order.indexOf(mateId) : -1;

    const ev = career.drawEvent({
      lastFinishPosition: myIndex >= 0 ? myIndex + 1 : undefined,
      wetRace: result.wetRace,
      teammateAhead: mateIndex >= 0 && myIndex >= 0 && mateIndex < myIndex,
    });

    if (ev) {
      this.showEvent(ev);
    } else {
      this.showCareerHub();
    }
  }

  private showEvent(ev: CareerEvent): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    this.setScreen('event');
    const { body } = this.page({
      tab: 'Paddock · ' + career.state.season.year,
      where: 'Team radio',
      title: ev.title,
    });

    const prompt = this.el('div', 'event-prompt', body);
    this.el('div', 'event-speaker', prompt, ev.speaker);
    this.el('div', '', prompt, ev.promptText);

    this.el('div', 'section-title', body, 'What do you say?');
    ev.choices.forEach((choice, i) => {
      const c = this.el('div', 'choice', body);
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      this.el('div', 'choice-text', c, choice.choiceText);
      if (choice.hint) this.el('div', 'choice-hint', c, choice.hint);
      const answer = () => {
        const messages = career.applyEventChoice(ev, i);
        this.profiles.saveCareer(this.careerId, career.state);
        if (messages.length > 0) alert(messages.join('\n\n'));
        this.showCareerHub();
      };
      c.addEventListener('click', answer);
      c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); answer(); }
      });
    });
  }

  // =======================================================================
  // Game loop
  // =======================================================================

  private loop = (now: number): void => {
    this.rafHandle = window.requestAnimationFrame(this.loop);

    // Advance the fixed-step physics. The accumulator returns how many 120Hz
    // steps this frame is worth, which is what keeps the simulation's behaviour
    // independent of display refresh rate.
    const steps = this.clock.advance(now);
    const engine = this.engine;

    // The controller page reads the device every frame. It is the only screen
    // outside a session that needs the loop, and it needs it for the same
    // reason the session does: it is displaying live hardware.
    if (this.screen === 'controller') this.controllerScreen?.tick();

    if (engine && this.screen === 'racing') {
      const player = engine.playerCar;

      if (player) {
        // Player input runs once per frame, not per physics step: it is sampled
        // from hardware at frame rate and interpolating it would be inventing data.
        this.input.update(
          this.clock.frameDt,
          engine.playerControls,
          player.physics.speedMs,
          player.physics.brakeLimitFraction,
          player.physics.tractionLimitFraction,
        );

        if (this.input.cameraCyclePressed) this.cycleCamera();
        if (this.input.helpToggled) {
          this.helpVisible = !this.helpVisible;
          this.helpShownAt = performance.now();
          this.hud.setHelpVisible(this.helpVisible);
        }
        // Auto-hide on WALL-CLOCK time, not simulation time. On a device slow
        // enough that the sim runs behind realtime, sim time would leave the card
        // up for far longer than the player expects.
        if (this.helpVisible && performance.now() - this.helpShownAt > 6500) {
          this.helpVisible = false;
          this.hud.setHelpVisible(false);
        }
        if (this.input.racingLineToggled) {
          this.settings.racingLine = !this.settings.racingLine;
          this.renderer.setRacingLineVisible(this.settings.racingLine);
          this.saves.saveSettings(this.settings);
        }
        // `P` and `Escape` open and close the MENU rather than silently
        // toggling the clock. A pause that stops the world and shows nothing is
        // indistinguishable from the game having hung, which is what it looked
        // like before there was a menu to put here.
        if (this.input.pausePressed) {
          if (this.pauseMenu.visible) this.closePauseMenu();
          else this.openPauseMenu();
        }
        if (this.input.pitRequestToggled) this.togglePitRequest();

        // The pit sheet, operated without letting go of the wheel.
        //
        // These three do nothing at all unless the sheet is up — the prompt
        // itself checks — so they are free to sit on keys and D-pad buttons a
        // driver's hand is already near. That is the whole point: a stop is
        // chosen at 300 km/h with a lap and a half of warning, and a panel that
        // needs a cursor is a panel nobody can use while racing.
        if (this.input.pitTyreCyclePressed) this.pitPrompt.cycleTyre(engine, 1);
        if (this.input.pitRepairTogglePressed) this.pitPrompt.toggleRepair(engine);
        if (this.input.pitConfirmPressed) this.pitPrompt.confirm();

        // The manual selector follows the gearbox.
        //
        // A sequential selector's position IS the gear — there is nowhere else
        // for it to be — and after issue #45 the gearbox can move on its own
        // even in manual, because the limiter backstop in `VehiclePhysics`
        // upshifts a car that has run out of revs whatever mode it is in. Left
        // unsynced, the request would still name the gear the driver picked ten
        // seconds ago, so asking for it AGAIN would be no change at all and do
        // nothing. Written after `input.update` has already published this
        // frame's press, and keystrokes cannot interleave with a synchronous
        // frame, so this can never overwrite an input the player has just made.
        if (this.input.gearMode === 'manual') {
          this.input.gearRequest = Math.max(1, player.physics.gear);
        }

        // Paddle shifts. Resolved here rather than in the input layer because
        // "one gear up" only means something against the gear the gearbox is
        // actually in, and this is the only place that knows it. A paddle means
        // manual from here on — there is no automatic gearbox in the real sport
        // — which `selectGear` records and the HUD prints, and `G` or `0` gives
        // the automatic back. The old comment here claimed selecting 1st cleared
        // the manual request "the same way the 0 key does"; it never did.
        // `clamp(from - 1, 1, 8)` from first gear is first gear, so the only way
        // out was a key that appeared in no help text.
        if (this.input.shiftUpPressed || this.input.shiftDownPressed) {
          const dir = this.input.shiftUpPressed ? 1 : -1;
          const from = this.input.gearRequest > 0
            ? this.input.gearRequest
            : Math.max(1, player.physics.gear);
          this.input.selectGear(clamp(from + dir, 1, 8));
          engine.playerControls.gearRequest = this.input.gearRequest;
        }

        // Rumble, driven from the physics rather than from canned effects.
        this.input.updateForceFeedback(
          player.physics.vibration,
          player.physics.wheelsLocked,
          player.physics.wheelSpin,
          player.physics.speedMs,
        );
      }

      for (let i = 0; i < steps; i++) {
        engine.step();
        if (engine.over) break;
      }

      // Raise the retirement screen once the player's car is out. Checked after
      // the physics has run, so `retirementReason` and the damage report the
      // screen prints are the ones the accident actually produced.
      if (player) this.updateRetirement(engine, player);

      // Who the cameras follow. A retired player is no longer driving, so the
      // director follows the race instead — otherwise "watch the rest" would be
      // three minutes of a stationary wreck.
      const focus = player && !(player.retired && this.spectating)
        ? player
        : engine.standings.find((c) => !c.retired) ?? engine.standings[0] ?? player;
      if (!focus) return;
      // The alpha the clock has been computing since it was written and nobody
      // ever asked for. Without it every car on the circuit is drawn at the last
      // completed 120Hz step, and because a frame is almost never a whole number
      // of steps, the field advances in a 2-2-3-2-3 stagger — visible as jitter
      // on every car except the player's, whose camera staggers with it. See
      // `Renderer.updateRenderPoses`.
      this.renderer.render(this.clock.frameDt, this.clock.interpolationAlpha, engine, focus);

      // Audio is driven from the focused car and panned around the camera, so a
      // trackside or drone camera hears the scene from where it is standing
      // rather than from inside the cockpit.
      this.audio.update(
        this.clock.frameDt,
        engine,
        focus,
        this.renderer.director.camera.rotation.y,
      );

      if (player) {
        this.hud.update(engine, player, this.input, this.renderer.fps, this.renderer.drawCalls);
        this.updatePitPrompt(engine, player);

        // The start sequence. The HUD owns the gantry's state and reports the
        // transitions, so the beep, the flash and the bulb all happen on the
        // same frame instead of three near-misses.
        const light = this.hud.updateStartLights(engine.startLights, engine.started);
        if (light.kind === 'light') {
          this.audio.playStartLight(light.index);
        } else if (light.kind === 'go') {
          this.audio.playStartGo();
          // A brief warm bloom on the release. Small — this should register as
          // adrenaline, not as a cutscene.
          this.renderer.flash(0.22, 3.2, 0xffe9c0);
        }
      }

      if (engine.over) this.finishSession();
    }

    // A session being simulated rather than driven gets the frame instead.
    if (this.skipping && this.screen === 'simulating') {
      this.stepSkip(this.skipping.session.engine.track.def.id);
    }
    // ...and so does one the player has stopped in and asked to see the end of.
    // Distinct from the branch above because that one steps a session that was
    // never driven and this one steps the one on the canvas.
    if (this.runningOut && this.screen === 'simulating') this.stepRunOut();

    this.input.endFrame();
  };

  /**
   * Opens and closes the pit sheet as the stop happens.
   *
   * Driven from the car's own state rather than from the button press, because
   * the player is not the only thing that puts them in the pit lane: a
   * drive-through penalty, a damaged nose, or simply missing the entry and
   * coming round again all change what the stop is going to be, and the sheet
   * has to follow the car.
   */
  private updatePitPrompt(engine: RaceEngine, player: CarEntry): void {
    // Whether there is a decision to be made is the ENGINE's question, and it
    // answers it: `pitDecisionPending`. This used to be a condition written out
    // here that began `config.kind === 'race'`, so the sheet never appeared in
    // practice or qualifying — "whenever I am pitting no matter what session is
    // I should be asked". A stop in FP2 is where the tyre you are going to
    // qualify on gets chosen and where a damaged wing gets replaced, and the
    // compound was being picked for the player by the race strategist's
    // function in a session that has no strategy.
    const relevant = engine.pitDecisionPending(player);

    if (relevant) {
      this.pitPrompt.render(
        engine, player,
        pitBindingHints(this.input.lastSource, (a) => describeButton(this.activeButtonRef(a))),
      );
    } else if (this.pitPrompt.visible) {
      this.pitPrompt.close();
    }
    this.hud.setPitSheetOpen(this.pitPrompt.visible);
  }

  /** The live binding for one action on whichever device is in the player's hands. */
  private activeButtonRef(action: ButtonAction): ButtonRef {
    const profile = this.input.gamepads.profileFor(this.input.gamepadSettings);
    return profile ? profile.buttons[action] : unboundButton();
  }

  stop(): void {
    window.cancelAnimationFrame(this.rafHandle);
    this.input.detach();
    this.renderer.dispose();
  }
}

/** A team's livery colour as a CSS hex string. */
function hexColour(colour: number): string {
  return '#' + colour.toString(16).padStart(6, '0');
}

/**
 * A save slot records its tier as a plain string; this names it.
 *
 * Tolerant of anything, because the slot index is written by whatever build made
 * the save and the menu must not throw over a tier it has never heard of.
 */
function tierLabel(tier: string): string {
  return TIER_CAR[tier as keyof typeof TIER_CAR]?.shortName ?? tier;
}

/**
 * Why a career would not load, in words worth showing somebody.
 *
 * The distinction is the point. "This save is from a newer version of the game"
 * asks the player to update; "this file is not a career" asks them to check what
 * they imported. Collapsing both into "that save could not be loaded" — which is
 * what this used to say, because `load` returned a bare null — leaves the one
 * person whose career is entirely fine with no idea that it is.
 */
function loadFailureMessage(r: { reason: string; version?: number }): string {
  switch (r.reason) {
    case 'from-the-future':
      return 'This career was saved by a newer version of the game (save format ' +
        r.version + '). Update to open it — it has not been damaged.';
    case 'unparseable':
      return 'That save file is damaged and could not be read.';
    case 'not-a-career':
      return 'That file is not a career save.';
    default:
      return 'That save could not be found.';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Guard against a WebGL context failure so the player sees a message rather than
// a blank page.
try {
  const game = new Game();
  void game.start();
  (window as unknown as { __game: Game }).__game = game;
} catch (err) {
  const el = document.getElementById('loading');
  if (el) {
    el.classList.remove('hidden');
    el.textContent = 'This browser could not start WebGL. ' + String(err);
  }
  console.error(err);
}

// Keep unused imports honest.
void clamp;
