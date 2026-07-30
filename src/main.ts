import './ui/styles.css';

import { SimClock } from './core/SimClock';
import { formatLapTime, clamp } from './core/MathUtils';
import { RaceEngine, type SessionConfig, type SessionKind } from './race/RaceEngine';
import type { CarEntry } from './race/CarEntry';
import { CIRCUITS, getCircuit } from './data/tracks/circuits';
import { TEAMS, getTeam, DRIVERS, type Driver, type Team } from './data/teams';
import { Renderer } from './render/Renderer';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from './render/CameraDirector';
import { InputController } from './input/InputController';
import { Hud } from './ui/Hud';
import { CareerEngine, TIER_INFO, type CareerEvent, type SeasonResult } from './career/CareerEngine';
import { SaveManager, type GameSettings } from './career/SaveManager';
import { AudioEngine } from './audio/AudioEngine';
import { buildPaddock } from './ui/Paddock';
import { buildSetupScreen, defaultSetupFor } from './ui/SetupScreen';
import { applySetup, specForTeam, type CarSetup } from './physics/VehicleSpec';
import type { CompoundId } from './data/tires';
import { PRACTICE_SEGMENTS, QUALIFYING_SEGMENTS } from './race/WeekendFormat';

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
  | 'settings';

class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly loading: HTMLElement;
  private readonly loadingText: HTMLElement;

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

  constructor() {
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.loading = document.getElementById('loading') as HTMLElement;
    this.loadingText = document.getElementById('loading-text') as HTMLElement;
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
    this.hud.onPitPressed = () => {
      const p = this.engine?.playerCar;
      if (p) p.perception.pitThisLap = !p.perception.pitThisLap;
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

  private setLoading(on: boolean, text = 'BUILDING CIRCUIT'): void {
    this.loadingText.textContent = text;
    this.loading.classList.toggle('hidden', !on);
  }

  // =======================================================================
  // Screens
  // =======================================================================

  private setScreen(s: Screen): void {
    this.screen = s;
    const inSession = s === 'racing';
    this.screenRoot.classList.toggle('hidden', inSession);
    this.hud.setVisible(inSession);
    // Leaving the track cuts the car but keeps the context alive, so returning
    // to a session does not have to rebuild the whole graph.
    if (!inSession) this.audio.silenceCar();
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

  private showMenu(): void {
    this.setScreen('menu');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);

    const title = this.el('div', 'title', inner);
    title.innerHTML = 'F1<span class="acc">SIM</span>';
    this.el('div', 'subtitle', inner,
      'Full-simulation Formula racing · driver academy to world champion');

    const recent = this.saves.mostRecent();
    const row = this.el('div', 'btn-row', inner);

    if (recent) {
      this.button('Continue Career', row, () => {
        const state = this.saves.load(recent.id);
        if (!state) {
          alert('That save could not be loaded.');
          return;
        }
        this.careerId = recent.id;
        this.career = new CareerEngine(state);
        this.showCareerHub();
      });
    }
    this.button(recent ? 'New Career' : 'Start Career', row, () => this.showCareerCreate(),
      recent ? 'btn secondary' : 'btn');
    this.button('Quick Race', row, () => this.showSessionSelect(true), 'btn secondary');
    this.button('Paddock', row, () => this.showPaddock(), 'btn secondary');
    this.button('Settings', row, () => this.showSettings(), 'btn secondary');

    if (this.saves.isEphemeral) {
      const warn = this.el('div', 'card-meta', inner,
        'Storage is unavailable in this browser mode — progress will not survive a reload.');
      warn.style.marginTop = '14px';
    }

    // Circuit list, so the front page shows what is actually in the game.
    this.el('div', 'section-title', inner, 'Circuits');
    const grid = this.el('div', 'card-grid', inner);
    for (const c of CIRCUITS) {
      const card = this.el('div', 'card', grid);
      this.el('div', 'card-name', card, c.name);
      this.el('div', 'card-meta', card, c.officialName + ' · ' + c.country);
      this.el('div', 'card-stat', card,
        (c.lengthM / 1000).toFixed(3) + ' km · ' + c.raceLaps + ' laps · pole ' +
        formatLapTime(c.referencePoleTimeS));
      card.addEventListener('click', () => {
        this.quickCircuitId = c.id;
        this.showSessionSelect(true);
      });
    }
  }

  private showCareerCreate(): void {
    this.setScreen('career-create');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, 'New Career');
    this.el('div', 'subtitle', inner,
      'You start in Formula 3 with a junior team. Earn a Formula 1 seat, then a championship.');

    const form = this.el('div', 'row', inner);
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

    const row = this.el('div', 'btn-row', inner);
    this.button('Begin', row, () => {
      const f = first.value.trim() || 'Alex';
      const l = last.value.trim() || 'Carter';
      this.career = CareerEngine.create(f, l, nat.value.trim() || 'United Kingdom');
      this.careerId = 'career-' + Date.now().toString(36);
      this.saves.save(this.careerId, this.career.state);
      this.showCareerHub();
    });
    this.button('Back', row, () => this.showMenu(), 'btn secondary');
  }

  private showCareerHub(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }

    this.setScreen('career-hub');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    const s = career.state;
    const team = getTeam(s.teamId);

    this.el('div', 'title', inner, s.player.firstName + ' ' + s.player.lastName);
    this.el('div', 'subtitle', inner,
      TIER_INFO[s.tier].name + ' · ' + team.name + ' · ' + s.seasonYear +
      ' · Round ' + Math.min(s.round + 1, career.calendar.length) + ' of ' + career.calendar.length);

    // --- Driver and team state -------------------------------------------
    this.el('div', 'section-title', inner, 'Status');
    const statGrid = this.el('div', 'card-grid', inner);
    const stat = (name: string, value: string, meta = '') => {
      const c = this.el('div', 'card', statGrid);
      this.el('div', 'card-meta', c, name);
      this.el('div', 'card-name', c, value);
      if (meta) this.el('div', 'card-stat', c, meta);
    };
    stat('Championship', 'P' + Math.max(1, career.sortedStandings().findIndex((e) => e.driverId === 'PLAYER') + 1),
      (career.sortedStandings().find((e) => e.driverId === 'PLAYER')?.points ?? 0) + ' pts');
    stat('Reputation', Math.round(s.reputation) + '/100');
    stat('Team morale', Math.round(s.teamMorale) + '/100');
    stat('Pressure', Math.round(s.pressureLevel) + '/100');
    stat('Pace', (s.player.skill * 100).toFixed(0) + '/100', 'consistency ' + (s.player.consistency * 100).toFixed(0));
    stat('Budget', '£' + (s.money / 1000).toFixed(0) + 'k',
      s.contractYears + (s.contractYears === 1 ? ' year left' : ' years left'));

    if (s.titles.length > 0) {
      this.el('div', 'section-title', inner, 'Honours');
      const t = this.el('div', 'card-grid', inner);
      for (const title of s.titles) {
        const c = this.el('div', 'card selected', t);
        this.el('div', 'card-name', c, title.year + ' ' + TIER_INFO[title.tier].name);
        this.el('div', 'card-meta', c, title.type === 'drivers' ? "Drivers' Champion" : "Constructors' Champion");
      }
    }

    // --- Next round -------------------------------------------------------
    if (career.seasonComplete) {
      this.el('div', 'section-title', inner, 'Season complete');
      const row = this.el('div', 'btn-row', inner);
      this.button('End Season', row, () => {
        const outcome = career.endSeason();
        this.saves.save(this.careerId, career.state);
        alert(outcome.summary);
        this.showCareerHub();
      });
      this.button('Standings', row, () => this.showStandings(), 'btn secondary');
      return;
    }

    const circuit = getCircuit(career.currentCircuitId);
    this.el('div', 'section-title', inner, 'Next round');
    const rc = this.el('div', 'card selected', inner);
    this.el('div', 'card-name', rc, circuit.name + ' — ' + circuit.officialName);
    this.el('div', 'card-meta', rc, circuit.city + ', ' + circuit.country);
    this.el('div', 'card-stat', rc,
      (circuit.lengthM / 1000).toFixed(3) + ' km · ' + circuit.raceLaps + ' laps · ' +
      circuit.corners?.length + ' named corners');

    const row = this.el('div', 'btn-row', inner);
    this.button('Race Weekend', row, () => this.startWeekend(circuit.id));
    this.button('Car Setup', row, () => this.showSetup(circuit.id, () => this.showCareerHub()), 'btn secondary');
    this.button('Practice Only', row, () => {
      this.weekend = [this.sessionConfig('practice', 'Practice', circuit.id, 600, 0)];
      this.weekendIndex = 0;
      this.beginSession(circuit.id);
    }, 'btn secondary');
    this.button('Simulate Race', row, () => {
      const wet = Math.random() < circuit.rainChance;
      const result = career.simulateRace(circuit.id, wet);
      career.recordResult(result);
      this.saves.save(this.careerId, career.state);
      this.afterRace(result);
    }, 'btn secondary');
    this.button('Standings', row, () => this.showStandings(), 'btn secondary');
    this.button('Main Menu', row, () => this.showMenu(), 'btn secondary');
  }

  private showStandings(): void {
    const career = this.career;
    if (!career) { this.showMenu(); return; }
    this.setScreen('standings');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, 'Championship');
    this.el('div', 'subtitle', inner, TIER_INFO[career.state.tier].name + ' · ' + career.state.seasonYear);

    const table = document.createElement('table');
    table.className = 'standings';
    table.innerHTML =
      '<thead><tr><th>Pos</th><th>Driver</th><th>Team</th>' +
      '<th class="num">Pts</th><th class="num">Wins</th><th class="num">Podiums</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const [i, e] of career.sortedStandings().entries()) {
      const tr = document.createElement('tr');
      if (e.driverId === 'PLAYER') tr.className = 'me';
      const teamName = e.teamId ? getTeam(e.teamId).shortName : '—';
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td>' + escapeHtml(career.displayName(e)) + '</td>' +
        '<td>' + escapeHtml(teamName) + '</td>' +
        '<td class="num">' + e.points + '</td>' +
        '<td class="num">' + e.wins + '</td>' +
        '<td class="num">' + e.podiums + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    inner.appendChild(table);

    const row = this.el('div', 'btn-row', inner);
    this.button('Back', row, () => this.showCareerHub(), 'btn secondary');
  }

  private showSessionSelect(quick: boolean): void {
    this.setScreen('session-select');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    const circuit = getCircuit(this.quickCircuitId);

    this.el('div', 'title', inner, circuit.name);
    this.el('div', 'subtitle', inner, circuit.officialName + ' · ' + circuit.city);

    this.el('div', 'section-title', inner, 'Session');
    const grid = this.el('div', 'card-grid', inner);

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

    this.el('div', 'section-title', inner, 'Circuit');
    const other = this.el('div', 'card-grid', inner);
    for (const c of CIRCUITS) {
      const card = this.el('div', 'card' + (c.id === circuit.id ? ' selected' : ''), other);
      this.el('div', 'card-name', card, c.name);
      this.el('div', 'card-meta', card, c.country);
      card.addEventListener('click', () => {
        this.quickCircuitId = c.id;
        this.showSessionSelect(quick);
      });
    }

    const row = this.el('div', 'btn-row', inner);
    this.button('Car Setup', row, () => this.showSetup(circuit.id, () => this.showSessionSelect(quick)),
      'btn secondary');
    this.button('Back', row, () => (this.career ? this.showCareerHub() : this.showMenu()), 'btn secondary');
  }

  /** The team whose car the player is driving. */
  private playerTeam(): Team {
    return getTeam(this.career ? this.career.state.teamId : DRIVERS[0].teamId);
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

    // A setup carried over from a different circuit is not a choice, it is a
    // leftover. Start again from the engineers' baseline for this track.
    if (!this.playerSetup || this.playerSetupCircuitId !== circuitId) {
      this.playerSetup = defaultSetupFor(circuit);
      this.playerSetupCircuitId = circuitId;
    }

    this.setScreen('setup');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, 'Car Setup');
    this.el('div', 'subtitle', inner,
      circuit.name + ' · ' + this.playerTeam().name +
      ' — every slider changes a number the physics integrates, not a rating');

    buildSetupScreen(inner, {
      setup: this.playerSetup,
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

    const row = this.el('div', 'btn-row', inner);
    this.button('Done', row, back);
    this.button('Reset to baseline', row, () => {
      this.playerSetup = defaultSetupFor(circuit);
      this.playerCompound = null;
      this.showSetup(circuitId, back);
    }, 'btn secondary');
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
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, 'Paddock');
    this.el('div', 'subtitle', inner,
      'Every bar reads a multiplier the physics applies directly — these cars really are different.');

    buildPaddock(inner, {
      currentTeamId: this.career?.state.teamId,
    });

    this.button('Back', inner, () => this.showMenu(), 'btn secondary');
  }

  private showSettings(): void {
    this.setScreen('settings');
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, 'Settings');
    this.el('div', 'subtitle', inner, 'Assists are off by default. The car is the same either way.');

    const toggle = (label: string, meta: string, get: () => boolean, set: (v: boolean) => void) => {
      const c = this.el('div', 'card' + (get() ? ' selected' : ''), grid);
      this.el('div', 'card-name', c, label);
      this.el('div', 'card-meta', c, meta);
      this.el('div', 'card-stat', c, get() ? 'ON' : 'OFF');
      c.addEventListener('click', () => {
        set(!get());
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    };

    this.el('div', 'section-title', inner, 'Driving');
    const grid = this.el('div', 'card-grid', inner);
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

    this.el('div', 'section-title', inner, 'Audio');
    const ag = this.el('div', 'card-grid', inner);
    // Five steps rather than a slider: a slider is fiddly on a phone and nobody
    // needs finer resolution than this on a master volume.
    for (const [label, value] of [['Off', 0], ['Quiet', 0.35], ['Normal', 0.7], ['Loud', 1]] as const) {
      const selected = Math.abs(this.settings.masterVolume - value) < 0.03;
      const c = this.el('div', 'card' + (selected ? ' selected' : ''), ag);
      this.el('div', 'card-name', c, label);
      this.el('div', 'card-stat', c, Math.round(value * 100) + '%');
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
      this.el('div', 'section-title', inner, 'Mobile');
      const mg = this.el('div', 'card-grid', inner);
      const c = this.el('div', 'card' + (this.input.tiltEnabled ? ' selected' : ''), mg);
      this.el('div', 'card-name', c, 'Tilt steering');
      this.el('div', 'card-meta', c, 'Steer by tilting the phone (needs permission)');
      this.el('div', 'card-stat', c, this.input.tiltEnabled ? 'ON' : 'OFF');
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

    this.el('div', 'section-title', inner, 'Camera');
    const cams = this.el('div', 'card-grid', inner);
    for (const mode of CAMERA_MODES) {
      const c = this.el('div', 'card' + (this.settings.cameraMode === mode ? ' selected' : ''), cams);
      this.el('div', 'card-name', c, CAMERA_LABELS[mode]);
      c.addEventListener('click', () => {
        this.settings.cameraMode = mode;
        this.renderer.director.setMode(mode as CameraMode);
        this.saves.saveSettings(this.settings);
        this.showSettings();
      });
    }

    const row = this.el('div', 'btn-row', inner);
    this.button('Back', row, () => (this.career ? this.showCareerHub() : this.showMenu()), 'btn secondary');
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

    this.setLoading(true, 'BUILDING ' + getCircuit(circuitId).name.toUpperCase());

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
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, engine.config.name + ' — Result');
    this.el('div', 'subtitle', inner,
      engine.track.def.officialName + ' · ' + engine.weather.label);

    // After a knockout segment, say plainly who went through and who is out.
    // A bare classification does not communicate that five cars just had their
    // weekend decided.
    const phase = engine.config.qualifyingPhase;
    if (phase && engine.config.advancing !== undefined) {
      const out = engine.participants.length - this.qualifyingSurvivors.length;
      this.el('div', 'section-title', inner,
        `Q${phase} — ${this.qualifyingSurvivors.length} advance to Q${phase + 1}, ${out} eliminated`);
    } else if (phase === 3) {
      this.el('div', 'section-title', inner, 'Q3 — pole position decided');
    }

    const table = document.createElement('table');
    table.className = 'standings';
    const isRace = engine.config.kind === 'race';
    table.innerHTML =
      '<thead><tr><th>Pos</th><th>Driver</th><th>Team</th>' +
      '<th class="num">' + (isRace ? 'Gap' : 'Best') + '</th>' +
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

      const gapCell = car.retired ? 'DNF'
        : car.position === 1 ? 'WINNER'
        : isRace ? '+' + car.gapToLeader.toFixed(3)
        : formatLapTime(car.bestLapTime);

      tr.innerHTML =
        '<td>' + car.position + '</td>' +
        '<td>' + escapeHtml(car.driver.firstName + ' ' + car.driver.lastName) + '</td>' +
        '<td>' + escapeHtml(car.team.shortName) + '</td>' +
        '<td class="num">' + gapCell + '</td>' +
        '<td class="num">' + formatLapTime(car.bestLapTime) + '</td>' +
        '<td class="num">' + car.pitStops + '</td>' +
        '<td>' + escapeHtml(notes.join(', ')) + '</td>';
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    inner.appendChild(table);

    const row = this.el('div', 'btn-row', inner);
    this.button('Continue', row, () => {
      this.renderer.unloadSession();
      this.engine = null;
      onContinue();
    });
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
    this.screenRoot.innerHTML = '';
    const inner = this.el('div', 'screen-inner', this.screenRoot);
    this.el('div', 'title', inner, ev.title);

    const prompt = this.el('div', 'event-prompt', inner);
    this.el('div', 'event-speaker', prompt, ev.speaker.toUpperCase());
    this.el('div', '', prompt, ev.promptText);

    ev.choices.forEach((choice, i) => {
      const c = this.el('div', 'choice', inner);
      this.el('div', 'choice-text', c, choice.choiceText);
      if (choice.hint) this.el('div', 'choice-hint', c, choice.hint);
      c.addEventListener('click', () => {
        const messages = career.applyEventChoice(ev, i);
        this.saves.save(this.careerId, career.state);
        if (messages.length > 0) alert(messages.join('\n\n'));
        this.showCareerHub();
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
        if (this.input.pausePressed) {
          this.clock.paused = !this.clock.paused;
          this.audio.setSuspended(this.clock.paused);
        }
        if (this.input.pitRequestToggled) {
          player.perception.pitThisLap = !player.perception.pitThisLap;
        }
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
void TEAMS;
void clamp;
