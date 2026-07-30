import './ui/styles.css';

import { SimClock } from './core/SimClock';
import { formatLapTime, clamp } from './core/MathUtils';
import { RaceEngine, type SessionConfig, type SessionKind } from './race/RaceEngine';
import { CIRCUITS, getCircuit } from './data/tracks/circuits';
import { TEAMS, getTeam } from './data/teams';
import { Renderer } from './render/Renderer';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from './render/CameraDirector';
import { InputController } from './input/InputController';
import { Hud } from './ui/Hud';
import { CareerEngine, TIER_INFO, type CareerEvent, type SeasonResult } from './career/CareerEngine';
import { SaveManager, type GameSettings } from './career/SaveManager';

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

  private rafHandle = 0;

  constructor() {
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.loading = document.getElementById('loading') as HTMLElement;
    this.loadingText = document.getElementById('loading-text') as HTMLElement;
    this.settings = this.saves.loadSettings();
  }

  async start(): Promise<void> {
    this.renderer = new Renderer({
      canvas: this.canvas,
      quality: this.settings.quality === 'auto' ? undefined : this.settings.quality,
    });

    this.hud = new Hud(document.getElementById('app') as HTMLElement);
    this.hud.setVisible(false);

    this.screenRoot = document.createElement('div');
    this.screenRoot.className = 'screen';
    (document.getElementById('app') as HTMLElement).appendChild(this.screenRoot);

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
      seed: Number.isFinite(seedParam) && seedParam !== 0 ? seedParam : (Math.random() * 0x7fffffff) | 0,
    };
    return { circuitId, config };
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
        this.weekend = make();
        this.weekendIndex = 0;
        this.beginSession(circuit.id);
      });
    };

    option('Free Practice', '10 minutes, learn the circuit',
      () => [this.sessionConfig('practice', 'Free Practice', circuit.id, 600, 0)]);
    option('Qualifying', 'One 12-minute session for grid position',
      () => [this.sessionConfig('qualifying', 'Qualifying', circuit.id, 720, 0)]);
    option('Sprint Race', '25% distance, standing start',
      () => [this.sessionConfig('race', 'Sprint', circuit.id, 0, Math.max(5, Math.round(circuit.raceLaps * 0.25)))]);
    option('Grand Prix', circuit.raceLaps + ' laps, full distance',
      () => [this.sessionConfig('race', 'Grand Prix', circuit.id, 0, circuit.raceLaps)]);
    option('Full Weekend', 'Practice, qualifying and the race',
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
    this.button('Back', row, () => (this.career ? this.showCareerHub() : this.showMenu()), 'btn secondary');
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
    toggle('Braking assist', 'Prevents locking the fronts',
      () => this.settings.brakingAssist,
      (v) => { this.settings.brakingAssist = v; this.input.config.brakingAssist = v; });

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
  ): SessionConfig {
    void circuitId;
    return {
      kind, name, durationS, laps,
      playerIndex: 0,
      standingStart: kind === 'race',
      seed: (Math.random() * 0x7fffffff) | 0,
    };
  }

  private weekendSessions(circuitId: string): SessionConfig[] {
    const c = getCircuit(circuitId);
    return [
      this.sessionConfig('practice', 'FP1', circuitId, 480, 0),
      this.sessionConfig('qualifying', 'Qualifying', circuitId, 600, 0),
      this.sessionConfig('race', 'Grand Prix', circuitId, 0, c.raceLaps),
    ];
  }

  private startWeekend(circuitId: string): void {
    this.weekend = this.weekendSessions(circuitId);
    this.weekendIndex = 0;
    this.beginSession(circuitId);
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

      this.engine = new RaceEngine(def, config, field);
      this.renderer.loadSession(this.engine);
      this.renderer.director.setMode(this.settings.cameraMode as CameraMode);
      this.clock.reset();
      this.clock.paused = false;
      this.setLoading(false);
      this.setScreen('racing');
    });
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

        if (this.input.cameraCyclePressed) {
          const mode = this.renderer.director.cycleMode();
          this.settings.cameraMode = mode;
          this.saves.saveSettings(this.settings);
        }
        if (this.input.pausePressed) {
          this.clock.paused = !this.clock.paused;
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
      if (player) {
        this.hud.update(engine, player, this.input, this.renderer.fps, this.renderer.drawCalls);
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
