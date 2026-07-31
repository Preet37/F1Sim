import './ui/styles.css';

import { SimClock } from './core/SimClock';
import { formatLapTime, clamp } from './core/MathUtils';
import { RaceEngine, type SessionConfig, type SessionKind } from './race/RaceEngine';
import type { CarEntry } from './race/CarEntry';
import { resultGapCell } from './race/Classification';
import { CIRCUITS, getCircuit } from './data/tracks/circuits';
import { TEAMS, getTeam, DRIVERS, type Driver, type Team } from './data/teams';
import { Renderer } from './render/Renderer';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from './render/CameraDirector';
import { setRubberLine } from './render/SurfaceDetail';
import { InputController } from './input/InputController';
import { Hud } from './ui/Hud';
import { CareerEngine, TIER_INFO, type CareerEvent, type SeasonResult } from './career/CareerEngine';
import { SaveManager, type GameSettings } from './career/SaveManager';
import { AudioEngine } from './audio/AudioEngine';
import { buildPaddock } from './ui/Paddock';
import { circuitSvg, circuitLoadingArt } from './ui/CircuitArt';
import { buildSetupScreen, defaultSetupFor, setupSummary } from './ui/SetupScreen';
import { buildControllerScreen, type ControllerScreenHandle } from './ui/ControllerScreen';
import { applySetup, specForTeam, type CarSetup } from './physics/VehicleSpec';
import type { CompoundId } from './data/tires';
import { PRACTICE_SEGMENTS, QUALIFYING_SEGMENTS } from './race/WeekendFormat';
import { AI_DIFFICULTIES } from './ai/AIVehicleController';

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
  | 'career-create'
  | 'career-hub'
  | 'session-select'
  | 'setup'
  | 'paddock'
  | 'racing'
  | 'results'
  | 'event'
  | 'standings'
  | 'settings'
  | 'controller';

class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly loading: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly loadingArt: HTMLElement;

  private renderer!: Renderer;
  private readonly input = new InputController();
  private readonly clock = new SimClock();
  private readonly saves = new SaveManager();
  private readonly audio = new AudioEngine();
  private hud!: Hud;

  private engine: RaceEngine | null = null;
  private career: CareerEngine | null = null;
  private careerId = 'slot1';
  private settings: GameSettings;

  private screen: Screen = 'menu';
  private screenRoot!: HTMLElement;

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

  constructor() {
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.loading = document.getElementById('loading') as HTMLElement;
    this.loadingText = document.getElementById('loading-text') as HTMLElement;
    this.loadingArt = document.getElementById('loading-art') as HTMLElement;
    this.settings = this.saves.loadSettings();
  }

  async start(): Promise<void> {
    // ?quality=low|high overrides both the saved setting and auto-detection.
    // Needed for headless verification, where the software rasteriser cannot
    // afford the shadow pass, and useful for anyone whose device is misdetected.
    const qs = new URLSearchParams(window.location.search).get('quality');
    const forced = qs === 'low' || qs === 'high' ? qs : undefined;
    const setting = this.settings.quality === 'auto' ? undefined : this.settings.quality;

    this.renderer = new Renderer({
      canvas: this.canvas,
      quality: forced ?? setting,
    });

    this.hud = new Hud(document.getElementById('app') as HTMLElement);
    this.hud.setVisible(false);
    this.hud.onCameraPressed = () => this.cycleCamera();
    // The pit call is a latch on the CAR, not a value written into the
    // perception buffer. The engine rebuilds that buffer from the strategy on
    // every physics step, and the strategy has no opinion about the player, so
    // a request written there was erased within eight milliseconds — the player
    // could never pit at all, on any lap, in any session.
    this.hud.onPitPressed = () => this.togglePitRequest();

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
      this.beginSession(deepLink.circuitId);
    } else {
      this.showMenu();
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
    this.screen = s;
    const inSession = s === 'racing';
    this.screenRoot.classList.toggle('hidden', inSession);
    this.hud.setVisible(inSession);
    // The pause menu belongs to the track and to nothing else. Leaving without
    // clearing it would strand a modal over the menus.
    if (!inSession && this.pauseOverlay) {
      this.pauseOverlay.classList.add('hidden');
      this.pauseOverlay.style.display = 'none';
      this.clock.paused = false;
    }
    // Leaving the track cuts the car but keeps the context alive, so returning
    // to a session does not have to rebuild the whole graph.
    if (!inSession) {
      this.audio.silenceCar();
      // A rumble effect outlives the frame that started it, so a controller
      // left buzzing on the results screen is a real possibility.
      this.input.stopForceFeedback();
    }
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
  }): { body: HTMLElement; actions: HTMLElement } {
    this.screenRoot.innerHTML = '';
    const page = this.el('div', 'page', this.screenRoot);

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

      this.el('div', 'kerb-rule', page);
    }

    const body = this.el('div', 'page-body', page);
    const actions = this.el('div', 'actionbar', page);
    return { body, actions };
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
    opts: { selected?: boolean; onClick?: () => void } = {},
  ): HTMLElement {
    const card = this.el('div', 'circuit-card' + (opts.selected ? ' selected' : ''), parent);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    card.innerHTML =
      '<div class="cc-map">' +
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

  private showMenu(): void {
    this.setScreen('menu');
    const { body } = this.page({});

    const hero = this.el('div', 'hero', body);
    const mark = this.el('div', 'wordmark', hero);
    mark.innerHTML = 'F1<span class="acc">SIM</span>';

    const line = this.el('div', 'hero-line', hero);
    this.el('div', 'hero-kerb', line);
    this.el('div', '', line,
      'A full physics simulation, eleven real circuits and a career that starts ' +
      'in Formula 3. Every number on every screen is one the car actually uses.');

    const recent = this.saves.mostRecent();
    const actions = this.el('div', 'menu-actions', hero);

    let index = 0;
    const entry = (name: string, desc: string, onClick: () => void, lead = false) => {
      index++;
      const b = document.createElement('button');
      b.className = 'menu-item' + (lead ? ' lead' : '');
      b.type = 'button';
      b.innerHTML =
        '<span class="menu-index">' + String(index).padStart(2, '0') + '</span>' +
        '<span class="menu-name">' + escapeHtml(name) + '</span>' +
        '<span class="menu-desc">' + escapeHtml(desc) + '</span>';
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };

    if (recent) {
      entry('Continue', 'Pick your career back up where you left it', () => {
        const state = this.saves.load(recent.id);
        if (!state) {
          alert('That save could not be loaded.');
          return;
        }
        this.careerId = recent.id;
        this.career = new CareerEngine(state);
        this.showCareerHub();
      }, true);
    }
    entry(recent ? 'New Career' : 'Start Career',
      'Sign for a junior team and race for a Formula 1 seat',
      () => this.showCareerCreate(), !recent);
    entry('Quick Race', 'Any circuit, any session, straight to the grid',
      () => this.showSessionSelect(true));
    entry('Paddock', 'Every team, every car and what it is good at',
      () => this.showPaddock());
    entry('Settings', 'Assists, opposition, camera and audio',
      () => this.showSettings());

    if (this.saves.isEphemeral) {
      this.el('div', 'notice', body,
        'This browser is blocking storage, so a career will not survive a reload. ' +
        'Everything else works normally.');
    }

    // The circuit list, so the front page shows what is actually in the game.
    this.el('div', 'section-title', body, 'Circuits');
    const grid = this.el('div', 'grid-circuits', body);
    for (const c of CIRCUITS) {
      this.circuitCard(grid, c, {
        onClick: () => {
          this.quickCircuitId = c.id;
          this.showSessionSelect(true);
        },
      });
    }
  }

  private showCareerCreate(): void {
    this.setScreen('career-create');
    const { body, actions } = this.page({
      tab: 'Main Menu',
      title: 'New Career',
      sub: 'You start in Formula 3 with a junior team. Earn a Formula 1 seat, then a championship.',
      back: () => this.showMenu(),
    });

    this.el('div', 'section-title', body, 'Driver');
    const form = this.el('div', 'row', body);
    const mk = (label: string, value: string): HTMLInputElement => {
      const f = this.el('div', 'field', form);
      const l = document.createElement('label');
      l.textContent = label;
      f.appendChild(l);
      const i = document.createElement('input');
      i.value = value;
      f.appendChild(i);
      return i;
    };
    const first = mk('First name', 'Alex');
    const last = mk('Last name', 'Carter');
    const nat = mk('Nationality', 'United Kingdom');

    this.el('div', 'section-title', body, 'What happens next');
    const grid = this.el('div', 'stat-grid', body);
    const step = (label: string, value: string, meta: string) => {
      const s = this.el('div', 'stat', grid);
      this.el('div', 'stat-label', s, label);
      this.el('div', 'stat-value', s, value);
      this.el('div', 'stat-meta', s, meta);
    };
    step('Starting tier', TIER_INFO.F3.name, 'A junior seat, and a car to match');
    step('Calendar', TIER_INFO.F3.rounds + ' rounds', 'One season to prove yourself');
    step('Promotion', 'On results', 'Reputation opens the door to F2, then F1');

    this.spacer(actions);
    this.button('Begin Career', actions, () => {
      const f = first.value.trim() || 'Alex';
      const l = last.value.trim() || 'Carter';
      this.career = CareerEngine.create(f, l, nat.value.trim() || 'United Kingdom');
      this.careerId = 'career-' + Date.now().toString(36);
      this.saves.save(this.careerId, this.career.state);
      this.showCareerHub();
    }, 'btn primary');
  }

  private showCareerHub(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    this.setScreen('career-hub');
    const s = career.state;
    const team = getTeam(s.teamId);
    const standings = career.sortedStandings();
    const mine = standings.find((e) => e.driverId === 'PLAYER');
    const champPos = Math.max(1, standings.findIndex((e) => e.driverId === 'PLAYER') + 1);
    const round = Math.min(s.round + 1, career.calendar.length);

    const { body, actions } = this.page({
      tab: TIER_INFO[s.tier].name + ' · ' + s.seasonYear,
      title: s.player.firstName + ' ' + s.player.lastName,
      sub: team.name + ' · ' + s.player.nationality,
      back: () => this.showMenu(),
      meta: [
        ['Round', round + ' / ' + career.calendar.length],
        ['Points', String(mine?.points ?? 0)],
      ],
    });

    // --- Driver and team state -------------------------------------------
    this.el('div', 'section-title', body, 'Season so far');
    const statGrid = this.el('div', 'stat-grid', body);
    const stat = (name: string, value: string, meta = '', hero = false) => {
      const c = this.el('div', 'stat' + (hero ? ' hero' : ''), statGrid);
      this.el('div', 'stat-label', c, name);
      this.el('div', 'stat-value', c, value);
      if (meta) this.el('div', 'stat-meta', c, meta);
    };
    stat('Championship', 'P' + champPos,
      (mine?.points ?? 0) + ' pts · ' + (mine?.wins ?? 0) + ' wins', true);
    stat('Reputation', Math.round(s.reputation) + '', 'out of 100');
    stat('Team morale', Math.round(s.teamMorale) + '', 'out of 100');
    stat('Pressure', Math.round(s.pressureLevel) + '', 'out of 100');
    stat('Pace', (s.player.skill * 100).toFixed(0) + '',
      'consistency ' + (s.player.consistency * 100).toFixed(0));
    stat('Budget', '£' + (s.money / 1000).toFixed(0) + 'k',
      s.contractYears + (s.contractYears === 1 ? ' year on the contract' : ' years on the contract'));

    if (s.titles.length > 0) {
      this.el('div', 'section-title', body, 'Honours');
      const t = this.el('div', 'stat-grid', body);
      for (const title of s.titles) {
        const c = this.el('div', 'stat hero', t);
        this.el('div', 'stat-label', c, String(title.year));
        this.el('div', 'stat-value', c, TIER_INFO[title.tier].name);
        this.el('div', 'stat-meta', c,
          title.type === 'drivers' ? "Drivers' Champion" : "Constructors' Champion");
      }
    }

    // --- Next round -------------------------------------------------------
    if (career.seasonComplete) {
      this.el('div', 'section-title', body, 'Season complete');
      this.el('div', 'notice', body,
        'Every round has been run. Close the season to take your promotion, your ' +
        'contract offers and next year’s calendar.');

      this.button('Standings', actions, () => this.showStandings(), 'btn ghost');
      this.spacer(actions);
      this.button('End Season', actions, () => {
        const outcome = career.endSeason();
        this.saves.save(this.careerId, career.state);
        alert(outcome.summary);
        this.showCareerHub();
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

    this.button('Standings', actions, () => this.showStandings(), 'btn ghost');
    this.button('Practice Only', actions, () => {
      this.weekend = [this.sessionConfig('practice', 'Practice', circuit.id, 600, 0)];
      this.weekendIndex = 0;
      this.beginSession(circuit.id);
    }, 'btn ghost');
    this.button('Simulate Race', actions, () => {
      const wet = Math.random() < circuit.rainChance;
      const result = career.simulateRace(circuit.id, wet);
      career.recordResult(result);
      this.saves.save(this.careerId, career.state);
      this.afterRace(result);
    }, 'btn ghost');
    this.spacer(actions);
    this.button('Race Weekend', actions, () => this.startWeekend(circuit.id), 'btn primary');
  }

  private showStandings(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('standings');

    const rows = career.sortedStandings();
    const leader = rows[0];
    const { body } = this.page({
      tab: TIER_INFO[career.state.tier].name,
      title: 'Championship',
      sub: career.state.seasonYear + ' · ' + (career.state.round === 0
        ? 'before the first round'
        : 'after ' + career.state.round + (career.state.round === 1 ? ' round' : ' rounds')),
      back: () => this.showCareerHub(),
      meta: leader ? [['Leader', career.displayName(leader)]] : [],
    });

    const wrap = this.el('div', 'table-wrap', body);
    const table = document.createElement('table');
    table.className = 'standings';
    table.innerHTML =
      '<thead><tr><th>Pos</th><th>Driver</th><th>Team</th>' +
      '<th class="num">Pts</th><th class="num">Wins</th><th class="num">Podiums</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const [i, e] of rows.entries()) {
      const tr = document.createElement('tr');
      if (e.driverId === 'PLAYER') tr.className = 'me';
      const team = e.teamId ? getTeam(e.teamId) : null;
      const chip = team
        ? '<span class="team-chip" style="background:' + hexColour(team.colour) + '"></span>'
        : '';
      tr.innerHTML =
        '<td class="pos">' + (i + 1) + '</td>' +
        '<td>' + chip + escapeHtml(career.displayName(e)) + '</td>' +
        '<td>' + escapeHtml(team ? team.shortName : '—') + '</td>' +
        '<td class="num">' + e.points + '</td>' +
        '<td class="num">' + e.wins + '</td>' +
        '<td class="num">' + e.podiums + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  private showSessionSelect(quick: boolean): void {
    this.setScreen('session-select');
    const circuit = getCircuit(this.quickCircuitId);

    const { body } = this.page({
      tab: quick && !this.career ? 'Quick Race' : 'Race Weekend',
      title: circuit.name,
      sub: circuit.officialName + ' · ' + circuit.city + ', ' + circuit.country,
      back: () => (this.career ? this.showCareerHub() : this.showMenu()),
      meta: [
        ['Lap', (circuit.lengthM / 1000).toFixed(3) + ' km'],
        ['Pole', formatLapTime(circuit.referencePoleTimeS)],
      ],
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

    this.el('div', 'section-title', body, 'Choose a session');
    const grid = this.el('div', 'card-grid', body);

    const option = (name: string, meta: string, make: () => SessionConfig[]) => {
      const c = this.el('div', 'card', grid);
      this.el('div', 'card-name', c, name);
      this.el('div', 'card-meta', c, meta);
      c.addEventListener('click', () => {
        this.resetQualifying();
        this.weekend = make();
        this.weekendIndex = 0;
        this.beginSession(circuit.id);
      });
    };

    option('Free Practice', '10 minutes, learn the circuit',
      () => [this.sessionConfig('practice', 'Free Practice', circuit.id, 600, 0)]);
    option('Qualifying', 'Q1, Q2 and Q3 knockout for grid position',
      () => QUALIFYING_SEGMENTS.map((q) =>
        this.sessionConfig('qualifying', q.name, circuit.id, q.durationS, 0,
          { qualifyingPhase: q.phase, advancing: q.advancing })));
    option('Sprint Race', '25% distance, standing start',
      () => [this.sessionConfig('race', 'Sprint', circuit.id, 0, Math.max(5, Math.round(circuit.raceLaps * 0.25)))]);
    option('Grand Prix', circuit.raceLaps + ' laps, full distance',
      () => [this.sessionConfig('race', 'Grand Prix', circuit.id, 0, circuit.raceLaps)]);
    option('Full Weekend', 'Three practice sessions, Q1-Q2-Q3, then the race',
      () => this.weekendSessions(circuit.id));

    this.el('div', 'section-title', body, 'Race somewhere else');
    const other = this.el('div', 'grid-circuits', body);
    for (const c of CIRCUITS) {
      this.circuitCard(other, c, {
        selected: c.id === circuit.id,
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
    const compound = this.playerCompound ?? 'medium';
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
   * Everything on it writes into `this.playerSetup`, which `beginSession` feeds
   * through `applySetup` into the player's car. Nothing is applied to a session
   * already in progress — a real setup change means going back to the garage,
   * and mutating the spec of a car mid-lap would invalidate the lap it is on.
   */
  private showSetup(circuitId: string, back: () => void): void {
    const circuit = getCircuit(circuitId);
    const setup = this.ensureSetup(circuitId);

    this.setScreen('setup');
    const { body, actions } = this.page({
      tab: 'Garage · ' + circuit.name,
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

    buildSetupScreen(body, {
      setup,
      compound: this.playerCompound ?? 'medium',
      team: this.playerTeam(),
      track: circuit,
      offerWets: circuit.rainChance > 0.08,
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
    const { body } = this.page({
      tab: 'Main Menu',
      title: 'The Paddock',
      sub: 'Every bar reads a multiplier the physics applies directly. These cars really ' +
        'are different, and the order below is the order they should finish in.',
      back: () => this.showMenu(),
      meta: [['Teams', String(TEAMS.length)], ['Drivers', String(DRIVERS.length)]],
    });

    buildPaddock(body, {
      currentTeamId: this.career?.state.teamId,
    });
  }

  private showSettings(): void {
    this.setScreen('settings');
    const { body } = this.page({
      tab: 'Main Menu',
      title: 'Settings',
      sub: 'Assists are off by default. The car is the same either way — an assist ' +
        'limits what your input can ask for, it does not change the machine.',
      back: () => (this.career ? this.showCareerHub() : this.showMenu()),
    });

    const toggle = (label: string, meta: string, get: () => boolean, set: (v: boolean) => void) => {
      const c = this.el('div', 'card' + (get() ? ' selected' : ''), grid);
      this.el('div', 'card-state', c, get() ? 'On' : 'Off');
      this.el('div', 'card-name', c, label);
      this.el('div', 'card-meta', c, meta);
      c.addEventListener('click', () => {
        set(!get());
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    };

    // --- Opposition -------------------------------------------------------
    // First, because it is the setting that changes the game most and the one
    // a player is most likely to be looking for.
    this.el('div', 'section-title', body, 'Opposition');
    const dg = this.el('div', 'card-grid', body);
    for (const id of ['easy', 'medium', 'hard'] as const) {
      const level = AI_DIFFICULTIES[id];
      const selected = this.settings.aiDifficulty === id;
      const c = this.el('div', 'card' + (selected ? ' selected' : ''), dg);
      if (selected) this.el('div', 'card-state', c, 'Racing');
      this.el('div', 'card-name', c, level.label);
      this.el('div', 'card-meta', c, level.blurb);
      c.addEventListener('click', () => {
        this.settings.aiDifficulty = id;
        // Applied live as well as saved, so a player who changes it mid-weekend
        // sees it immediately instead of wondering whether it took.
        for (const car of this.engine?.cars ?? []) car.ai?.setDifficulty(id);
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    }

    this.el('div', 'section-title', body, 'Driving');
    const grid = this.el('div', 'card-grid', body);
    toggle('Speed-sensitive steering', 'Reduces lock at speed, as a real rack does',
      () => this.settings.speedSensitiveSteering,
      (v) => { this.settings.speedSensitiveSteering = v; this.input.config.speedSensitiveSteering = v; });
    toggle('Traction assist', 'Caps throttle at the rear axle grip limit',
      () => this.settings.tractionAssist,
      (v) => { this.settings.tractionAssist = v; this.input.config.tractionAssist = v; });
    toggle('Racing line', 'Optimal line, coloured green to red by approach speed',
      () => this.settings.racingLine,
      (v) => { this.settings.racingLine = v; this.renderer.setRacingLineVisible(v); });
    toggle('Braking assist', 'Prevents locking the fronts',
      () => this.settings.brakingAssist,
      (v) => { this.settings.brakingAssist = v; this.input.config.brakingAssist = v; });

    this.el('div', 'section-title', body, 'Volume');
    const ag = this.el('div', 'card-grid', body);
    // Four steps rather than a slider: a slider is fiddly on a phone and nobody
    // needs finer resolution than this on a master volume.
    for (const [label, value] of [['Off', 0], ['Quiet', 0.35], ['Normal', 0.7], ['Loud', 1]] as const) {
      const selected = Math.abs(this.settings.masterVolume - value) < 0.03;
      const c = this.el('div', 'card' + (selected ? ' selected' : ''), ag);
      this.el('div', 'card-state', c, Math.round(value * 100) + '%');
      this.el('div', 'card-name', c, label);
      c.addEventListener('click', () => {
        this.settings.masterVolume = value;
        this.audio.setVolume(value);
        this.audio.setEnabled(value > 0);
        if (value > 0) this.audio.playUiClick();
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    }

    if (this.input.touchAvailable) {
      this.el('div', 'section-title', body, 'On a phone');
      const mg = this.el('div', 'card-grid', body);
      const c = this.el('div', 'card' + (this.input.tiltEnabled ? ' selected' : ''), mg);
      this.el('div', 'card-state', c, this.input.tiltEnabled ? 'On' : 'Off');
      this.el('div', 'card-name', c, 'Tilt steering');
      this.el('div', 'card-meta', c, 'Steer by tilting the phone. Needs permission.');
      c.addEventListener('click', async () => {
        if (this.input.tiltEnabled) {
          this.input.disableTilt();
          this.settings.tiltSteering = false;
        } else {
          const ok = await this.input.enableTilt();
          this.settings.tiltSteering = ok;
          if (!ok) alert('Device orientation is not available or was declined.');
        }
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    }

    this.el('div', 'section-title', body, 'Camera');
    const cams = this.el('div', 'card-grid', body);
    for (const mode of CAMERA_MODES) {
      const selected = this.settings.cameraMode === mode;
      const c = this.el('div', 'card' + (selected ? ' selected' : ''), cams);
      if (selected) this.el('div', 'card-state', c, 'In use');
      this.el('div', 'card-name', c, CAMERA_LABELS[mode]);
      c.addEventListener('click', () => {
        this.settings.cameraMode = mode;
        this.renderer.director.setMode(mode as CameraMode);
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    }

    // --- Controls ---------------------------------------------------------
    // One section, not two. A gamepad and a keyboard are the same question —
    // "how do I drive this" — and splitting them into a "Controller" page and a
    // "Controls" key map gave the player two places to look and no way to guess
    // which held the thing they wanted. The banner is the single entry point to
    // the real binding and calibration screen; the key map below it is the
    // reference for the keyboard, which needs no setup and so needs no page.
    this.el('div', 'section-title', body, 'Controls');

    const pads = this.input.gamepads.list();
    const padCard = this.el('div', 'garage-card', body);
    const padText = this.el('div', 'garage-text', padCard);
    const padHead = this.el('div', 'garage-head', padText);
    this.el('span', '', padHead, 'Gamepad and wheel');
    this.el('span', 'garage-tag' + (pads.length > 0 ? ' modified' : ''), padHead,
      pads.length === 0 ? 'none connected'
        : pads.length === 1 ? '1 device' : pads.length + ' devices');
    this.el('div', 'garage-headline', padText,
      pads.length > 0 ? pads[0].id : 'No controller detected');
    this.el('div', 'garage-detail', padText,
      pads.length > 0
        ? 'Bind every control, calibrate the axes and pedals, shape the steering curve, and set up rumble.'
        : 'Connect a gamepad or wheel and press a button on it — browsers hide a controller from a page ' +
          'until it has been used. Keyboard and touch keep working either way.');
    this.button('Controller Setup', this.el('div', 'garage-action', padCard),
      () => this.showControllerSetup());

    this.el('div', 'section-title', body, 'Keyboard');
    const keys = this.el('div', 'keymap', body);
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
      const r = this.el('div', 'keymap-row', keys);
      this.el('kbd', 'keymap-key', r, key);
      this.el('span', 'keymap-what', r, what);
    }
    if (this.input.touchAvailable) {
      this.el('div', 'card-meta', body,
        'On a touchscreen the pedals and the steering pad appear over the track once ' +
        'a session starts.');
    }
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
    const sessions: SessionConfig[] = [];

    for (const fp of PRACTICE_SEGMENTS) {
      sessions.push(this.sessionConfig('practice', fp.name, circuitId, fp.durationS, 0));
    }
    for (const q of QUALIFYING_SEGMENTS) {
      sessions.push(this.sessionConfig('qualifying', q.name, circuitId, q.durationS, 0,
        { qualifyingPhase: q.phase, advancing: q.advancing }));
    }
    sessions.push(this.sessionConfig('race', 'Grand Prix', circuitId, 0, c.raceLaps));
    return sessions;
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

  /** Clears qualifying state at the start of a weekend. */
  private resetQualifying(): void {
    this.qualifyingGrid = [];
    this.qualifyingSurvivors = [];
  }

  private startWeekend(circuitId: string): void {
    this.resetQualifying();
    this.weekend = this.weekendSessions(circuitId);
    this.weekendIndex = 0;
    this.beginSession(circuitId);
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
   */
  private resolveQualifyingSegment(
    engine: RaceEngine,
    phase: 1 | 2 | 3,
    advancing: number | undefined,
  ): void {
    const idOf = (c: CarEntry) => (c.isPlayer ? 'PLAYER' : c.driver.id);

    // Rank this segment's runners by best lap. No lap set = back of the queue.
    const ranked = engine.participants
      .slice()
      .sort((a, b) => {
        const at = a.bestLapTime > 0 ? a.bestLapTime : Infinity;
        const bt = b.bestLapTime > 0 ? b.bestLapTime : Infinity;
        return at - bt;
      });

    if (advancing === undefined || ranked.length <= advancing) {
      // Q3, or a segment nobody was knocked out of: this order fills the front
      // of the grid.
      for (let i = 0; i < ranked.length; i++) this.qualifyingGrid[i] = idOf(ranked[i]);
      this.qualifyingSurvivors = ranked.map(idOf);
      return;
    }

    const survivors = ranked.slice(0, advancing);
    const knockedOut = ranked.slice(advancing);

    // Eliminated cars fill the grid from the back, fastest of them highest.
    // With 20 cars and 15 advancing, that is slots 16-20.
    for (let i = 0; i < knockedOut.length; i++) {
      const slot = advancing + i;
      this.qualifyingGrid[slot] = idOf(knockedOut[i]);
    }

    this.qualifyingSurvivors = survivors.map(idOf);

    // Restrict the next segment to the survivors.
    const next = this.weekend[this.weekendIndex + 1];
    if (next && next.kind === 'qualifying') {
      next.participants = survivors.map((c) => c.index);
    }
    void phase;
  }

  /** Builds the engine and loads the renderer for the queued session. */
  private beginSession(circuitId: string): void {
    const config = this.weekend[this.weekendIndex];
    if (!config) { this.showCareerHub(); return; }

    this.setLoading(true, getCircuit(circuitId).name + ' — ' + config.name, circuitId);

    // Yield a frame so the loading screen paints before the synchronous build,
    // which takes a few hundred milliseconds for the racing line solve.
    window.requestAnimationFrame(() => {
      const def = getCircuit(circuitId);

      // In career mode the player's entry replaces a grid slot with their own
      // driver record, so the sim races the career driver rather than a stand-in.
      let field = undefined;
      if (this.career) {
        const player = this.career.playerAsDriver();
        const rivals = this.career.fieldForTier().filter((d) => d.teamId !== player.teamId).slice(0, 19);
        field = [player, ...rivals];
      }

      // A race that follows qualifying lines up in the order qualifying
      // produced. The engine builds the grid from the field's array order, so
      // sorting the field here IS setting the grid.
      if (config.kind === 'race' && this.qualifyingGrid.length > 0) {
        const base = field ?? DRIVERS.slice();
        const playerId = this.career?.playerAsDriver().id;
        const rank = (d: Driver) => {
          const key = d.id === playerId ? 'PLAYER' : d.id;
          const i = this.qualifyingGrid.indexOf(key);
          // Anyone with no qualifying slot starts behind those who have one.
          return i < 0 ? this.qualifyingGrid.length + base.indexOf(d) : i;
        };
        field = base.slice().sort((a, b) => rank(a) - rank(b));
      }

      this.engine = new RaceEngine(def, config, field);
      this.applyPlayerSetup(this.engine);
      // The rubbered-in racing line, rasterised from this circuit's spline into
      // the shared surface map. Done before the track mesh is built so the
      // asphalt has it the first frame it is drawn.
      setRubberLine(this.engine.track);
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

    if (this.playerCompound) {
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
      on ? 'Box this lap — your box is ' + car.driver.code + "'s, in the " +
        car.team.name + ' garage'
        : 'Stay out, stay out',
      'info', engine.time, car.index,
    );
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
  private pauseOverlay: HTMLElement | null = null;

  private buildPauseOverlay(): HTMLElement {
    const o = document.createElement('div');
    o.className = 'pause-overlay hidden';
    // Styled inline so the overlay is self-contained and cannot be knocked out
    // by a change to the HUD stylesheet.
    o.style.cssText =
      'position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(4,6,10,0.78);backdrop-filter:blur(3px);';

    const card = document.createElement('div');
    card.style.cssText =
      'display:flex;flex-direction:column;gap:12px;align-items:stretch;min-width:min(280px,80vw);' +
      'padding:22px 26px;border-radius:14px;background:rgba(12,15,21,0.96);' +
      'border:1px solid rgba(255,255,255,0.12);box-shadow:0 18px 60px rgba(0,0,0,0.6);' +
      'font-family:inherit;color:#e9edf4;text-align:center;';
    o.appendChild(card);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:20px;letter-spacing:0.16em;text-transform:uppercase;opacity:0.9;';
    title.textContent = 'Paused';
    card.appendChild(title);

    this.pauseSubtitle = document.createElement('div');
    this.pauseSubtitle.style.cssText = 'font-size:12px;opacity:0.6;margin-bottom:6px;';
    card.appendChild(this.pauseSubtitle);

    const mk = (label: string, onClick: () => void, primary: boolean) => {
      const b = document.createElement('button');
      b.className = primary ? 'btn' : 'btn secondary';
      b.textContent = label;
      b.addEventListener('click', onClick);
      card.appendChild(b);
      return b;
    };
    mk('Resume', () => this.setPaused(false), true);
    mk('Abandon session', () => this.abandonSession(), false);

    (document.getElementById('app') as HTMLElement).appendChild(o);
    return o;
  }

  private pauseSubtitle: HTMLElement | null = null;

  private setPaused(paused: boolean): void {
    // Only meaningful on track. Pausing the menu would be an odd thing to offer.
    if (paused && this.screen !== 'racing') return;
    this.clock.paused = paused;
    this.audio.setSuspended(paused);
    if (!this.pauseOverlay) this.pauseOverlay = this.buildPauseOverlay();
    if (this.pauseSubtitle && this.engine) {
      this.pauseSubtitle.textContent =
        this.engine.config.name + ' · ' + this.engine.track.def.name;
    }
    this.pauseOverlay.classList.toggle('hidden', !paused);
    this.pauseOverlay.style.display = paused ? 'flex' : 'none';
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
    this.setPaused(false);
    this.renderer.unloadSession();
    this.engine = null;
    this.weekend = [];
    this.weekendIndex = 0;
    this.resetQualifying();
    if (this.career) this.showCareerHub(); else this.showMenu();
  }

  private finishSession(): void {
    const engine = this.engine;
    if (!engine) return;

    const config = engine.config;
    const player = engine.playerCar;

    // A race result feeds the career; practice and qualifying do not.
    if (config.kind === 'race' && this.career && player) {
      const order = engine.standings.map((c) => (c.isPlayer ? 'PLAYER' : c.driver.id));
      const fl = engine.fastestLap();
      const result: SeasonResult = {
        round: this.career.state.round,
        circuitId: engine.track.def.id,
        order,
        playerPosition: player.position,
        playerPoints: 0,
        poleDriverId: order[0] ?? 'PLAYER',
        fastestLapDriverId: fl ? (fl.car.isPlayer ? 'PLAYER' : fl.car.driver.id) : 'PLAYER',
        wetRace: engine.weather.hasRained,
      };
      this.career.recordResult(result);
      this.saves.save(this.careerId, this.career.state);
      this.showResults(() => this.afterRace(result));
      return;
    }

    // Knockout qualifying: work out who survives, who is out, and where the
    // eliminated cars sit on the final grid.
    if (config.kind === 'qualifying' && config.qualifyingPhase) {
      this.resolveQualifyingSegment(engine, config.qualifyingPhase, config.advancing);
    }

    this.weekendIndex++;
    if (this.weekendIndex < this.weekend.length) {
      this.showResults(() => this.beginSession(engine.track.def.id));
    } else {
      this.showResults(() => (this.career ? this.showCareerHub() : this.showMenu()));
    }
  }

  private showResults(onContinue: () => void): void {
    const engine = this.engine;
    if (!engine) { onContinue(); return; }

    this.setScreen('results');
    const isRace = engine.config.kind === 'race';
    const player = engine.playerCar;
    const fastest = engine.fastestLap();

    const { body, actions } = this.page({
      tab: engine.config.name,
      title: 'Classification',
      sub: engine.track.def.officialName + ' · ' + engine.weather.label,
      meta: [
        ['Session', engine.config.name],
        ['Runners', String(engine.standings.length)],
      ],
    });

    // The player's own result first, because that is the question they are
    // asking the screen. The classification below answers everything else.
    if (player) {
      const grid = this.el('div', 'stat-grid', body);
      const tile = (label: string, value: string, meta = '', hero = false) => {
        const s = this.el('div', 'stat' + (hero ? ' hero' : ''), grid);
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
      tile(headline,
        player.retired ? 'DNF' : 'P' + player.position,
        player.retired ? player.retirementReason
          : player.position === 1 ? topNote : 'of ' + engine.standings.length + ' cars',
        true);
      tile('Your best lap', formatLapTime(player.bestLapTime),
        player.pitStops + (player.pitStops === 1 ? ' stop' : ' stops'));
      if (fastest) {
        tile('Fastest lap', formatLapTime(fastest.time),
          fastest.car.driver.firstName + ' ' + fastest.car.driver.lastName);
      }
      if (isRace && !player.retired && player.position > 1) {
        tile('Gap to the win', '+' + player.gapToLeader.toFixed(3) + 's',
          engine.standings[0].driver.lastName + ' took it');
      }
    }

    // After a knockout segment, say plainly who went through and who is out.
    // A bare classification does not communicate that five cars just had their
    // weekend decided.
    const phase = engine.config.qualifyingPhase;
    if (phase && engine.config.advancing !== undefined) {
      const out = engine.participants.length - this.qualifyingSurvivors.length;
      this.el('div', 'notice', body,
        `${this.qualifyingSurvivors.length} cars go through to Q${phase + 1}. ${out} are out, ` +
        'and keep the grid slots they have just earned.');
    } else if (phase === 3) {
      this.el('div', 'notice', body, 'Q3 is done. That is the front of the grid decided.');
    }

    this.el('div', 'section-title', body, isRace ? 'Race classification' : 'Timesheet');

    const wrap = this.el('div', 'table-wrap', body);
    const table = document.createElement('table');
    table.className = 'standings';
    table.innerHTML =
      '<thead><tr><th>Pos</th><th>Driver</th><th>Team</th>' +
      '<th class="num">Gap</th>' +
      '<th class="num">Best Lap</th><th class="num">Stops</th><th>Notes</th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const car of engine.standings) {
      const tr = document.createElement('tr');
      if (car.isPlayer) tr.className = 'me';
      const notes: string[] = [];
      if (car.retired) notes.push(car.retirementReason);
      if (car.disqualified) notes.push('DSQ');
      if (car.penaltySeconds > 0) notes.push('+' + car.penaltySeconds + 's');
      if (car.trackLimitStrikes > 0) notes.push(car.trackLimitStrikes + ' limits');

      const gapCell = resultGapCell(car, isRace);

      tr.innerHTML =
        '<td class="pos">' + car.position + '</td>' +
        '<td><span class="team-chip" style="background:' + hexColour(car.team.colour) + '"></span>' +
        escapeHtml(car.driver.firstName + ' ' + car.driver.lastName) + '</td>' +
        '<td>' + escapeHtml(car.team.shortName) + '</td>' +
        '<td class="num">' + gapCell + '</td>' +
        '<td class="num">' + formatLapTime(car.bestLapTime) + '</td>' +
        '<td class="num">' + car.pitStops + '</td>' +
        '<td>' + (notes.length ? '<span class="pill bad">' + escapeHtml(notes.join(', ')) + '</span>' : '') + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    this.spacer(actions);
    this.button('Continue', actions, () => {
      this.renderer.unloadSession();
      this.engine = null;
      onContinue();
    }, 'btn primary');
  }

  /** After a race, offer a narrative event if one is eligible. */
  private afterRace(result: SeasonResult): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    const ev = career.drawEvent({
      lastFinishPosition: result.playerPosition,
      wetRace: result.wetRace,
      teammateAhead: false,
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
      tab: 'Paddock · ' + career.state.seasonYear,
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
        this.saves.save(this.careerId, career.state);
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
        if (this.input.pausePressed) this.setPaused(!this.clock.paused);
        if (this.input.pitRequestToggled) this.togglePitRequest();

        // Paddle shifts. Resolved here rather than in the input layer because
        // "one gear up" only means something against the gear the gearbox is
        // actually in, and this is the only place that knows it. Selecting 1st
        // clears the manual request the same way the 0 key does, so a player
        // who wants the automatic back does not have to find another control.
        if (this.input.shiftUpPressed || this.input.shiftDownPressed) {
          const dir = this.input.shiftUpPressed ? 1 : -1;
          const from = this.input.gearRequest > 0
            ? this.input.gearRequest
            : Math.max(1, player.physics.gear);
          this.input.gearRequest = clamp(from + dir, 1, 8);
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

      const focus = player ?? engine.standings[0];
      this.renderer.render(this.clock.frameDt, engine, focus);

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

    this.input.endFrame();
  };

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
