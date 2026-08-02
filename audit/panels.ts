import { buildStrategyScreen } from '../src/ui/StrategyScreen';
import { driversForTeam, getTeam } from '../src/data/teams';
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { formatLapTime } from '../src/core/MathUtils';
import { cutLine, qualifyingStrip, timingBoard, timingRow } from '../src/ui/TimingRow';
import { PHYSICS_DT } from '../src/core/SimClock';
import { Hud } from '../src/ui/Hud';

/**
 * The full-screen panels, without the game around them.
 *
 * `audit/hud.html` needs a whole circuit built before it can photograph
 * anything, which costs minutes under a software rasteriser and is entirely
 * wasted on a page that is drawn while nothing is being simulated. This one
 * mounts the real panel into the real screen chassis and nothing else, so a
 * sweep of it is seconds rather than an afternoon.
 *
 * The chassis markup is a copy of what `Main.page()` emits. That is the one
 * duplication here and it is deliberate: reaching `Main` means booting a
 * career, a renderer and an audio engine to look at a stylesheet.
 */

declare global {
  interface Window {
    __panels: {
      show(name: string, teamId: string, circuitId: string): void;
      board(kind: string): Promise<void>;
      hud(scene: string): Promise<void>;
      hudReport(): Record<string, unknown>;
    };
  }
}

const app = document.getElementById('app') as HTMLElement;

function chassis(
  tab: string, title: string, sub: string,
  primaryLabel = 'Confirm — to the grid',
): HTMLElement {
  app.innerHTML = '';
  const screen = document.createElement('div');
  screen.className = 'screen';
  app.appendChild(screen);
  const page = div('page', screen);

  const rail = div('statusrail', page);
  div('statusrail-mark', rail).innerHTML = 'F1<b>SIM</b>';
  div('statusrail-sep s1', rail).textContent = '/';
  div('statusrail-where', rail).textContent = tab;
  div('statusrail-spacer', rail);
  div('statusrail-live', rail).textContent = 'Live';

  const bar = div('topbar', page);
  div('navback-gap', bar);
  const titles = div('topbar-titles', bar);
  div('tab', titles).textContent = tab;
  const h = document.createElement('h1');
  h.className = 'page-title';
  h.textContent = title;
  titles.appendChild(h);
  div('page-sub', titles).textContent = sub;

  const body = div('page-body', page);
  const actions = div('actionbar', page);
  const ghost = document.createElement('button');
  ghost.className = 'btn ghost';
  ghost.textContent = 'Car Setup';
  actions.appendChild(ghost);
  div('actionbar-spacer', actions);
  const primary = document.createElement('button');
  primary.className = 'btn primary';
  primary.textContent = primaryLabel;
  actions.appendChild(primary);
  return body;
}

function div(cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}

/**
 * The HUD, over a flat backdrop, with no renderer at all.
 *
 * `RaceEngine` needs no WebGL — the spline, the world model and twenty AI cars
 * are pure arithmetic — so a HUD question can be answered in seconds here
 * instead of in the ten minutes a circuit takes to BUILD under a software
 * rasteriser in `audit/hud.html`. That page is still the one that answers "does
 * this read over a night race in the rain"; this one answers "is the panel
 * there at all", which is the question that costs the most iterations.
 */
let hudEngine: RaceEngine | null = null;
let hud: Hud | null = null;
let hudCar: ReturnType<RaceEngine['cars']['at']> | null = null;

const hudInput = {
  ersMode: 'balanced', showTouchOverlay: false, joystickActive: false,
  joystickCentreX: 0, joystickCentreY: 0, joystickOffset: { x: 0, y: 0, radius: 60 },
  throttleHeld: false, brakeHeld: false, reverseTouchHeld: false,
} as never;

function hudScene(scene: string): void {
  if (!hudEngine || !hudCar || !hud) return;
  const rc = hudEngine.raceControl;
  rc.sessionFlag = 'green';
  rc.neutralisation = 'none';
  hudEngine.weather.wetness = 0.02;
  hudCar.inPitLane = false;
  hudCar.inPitBox = false;
  hudCar.damage.health.frontWingL = 1;

  if (scene === 'pit-advice') hudCar.damage.health.frontWingL = 0.44;
  if (scene === 'safety-car') rc.neutralisation = 'safety-car';
  if (scene === 'wet') hudEngine.weather.wetness = 0.55;
  if (scene === 'radio-burst') {
    rc.log('DEBRIS ON THE RACING LINE AT TURN 11', 'critical', hudEngine.time);
  }
  if (scene === 'in-box') {
    hudCar.inPitLane = true; hudCar.inPitBox = true; hudCar.pitBoxTimer = 2.4;
  }
  hud.update(hudEngine, hudCar, hudInput, 60, 240);
}

/**
 * The three full-screen boards, off a real session.
 *
 * Every row here is built by the game's own `timingRow` / `timingBoard` /
 * `cutLine` / `qualifyingStrip` — the same functions `Main` calls — so these
 * shots are evidence about the product rather than about this file. The only
 * thing reproduced is the page chassis, and that is bounded: a wrong chassis is
 * obvious in the picture, a wrong row would not be.
 */
async function buildBoard(kind: string): Promise<void> {
  const circuit = getCircuit('silverstone');
  const isQuali = kind === 'qualifying';
  const config: SessionConfig = {
    kind: isQuali ? 'qualifying' : 'race',
    name: isQuali ? 'Qualifying 2' : 'Grand Prix',
    durationS: isQuali ? 900 : 0,
    laps: isQuali ? 12 : 20,
    playerIndex: -1,
    standingStart: !isQuali,
    pitLaneStart: false,
    seed: 4242,
    ...(isQuali
      ? { qualifyingPhase: 2 as const, advancing: 10, participants: [...Array(15).keys()] }
      : {}),
  };
  const e = new RaceEngine(circuit, config);
  for (let i = 0; i < Math.round(900 / PHYSICS_DT) && !e.over; i++) e.step();

  const body = chassis(
    'Race weekend · ' + circuit.name,
    kind === 'champ' ? 'Championship' : 'Classification',
    kind === 'champ' ? '2026 · after 8 rounds'
      : circuit.officialName + ' · ' + e.weather.label,
    kind === 'champ' ? 'Back to the paddock' : 'Continue',
  );

  if (isQuali) qualifyingStrip(body, 2);

  const head = div('section-title', body);
  head.textContent = kind === 'champ' ? 'Drivers'
    : isQuali ? 'Qualifying' : 'Race classification';

  const cols = kind === 'champ'
    ? ['P', 'Driver', 'Points', 'Gap', 'Won']
    : isQuali ? ['P', 'Driver', 'Best Lap', 'Gap', '']
      : ['P', 'Driver', 'Best Lap', 'Gap', 'Stops'];
  const board = timingBoard(body, cols);
  board.classList.add(kind === 'champ' ? 'tboard-champ'
    : isQuali ? 'tboard-quali' : 'tboard-class');

  const runners = e.participants.slice().sort((a, b) =>
    (a.bestLapTime > 0 ? a.bestLapTime : Infinity) - (b.bestLapTime > 0 ? b.bestLapTime : Infinity));
  const out = e.standings.filter((c) => c.eliminated);
  const order = isQuali ? [...runners, ...out] : e.standings;
  const lead = order[0];

  order.forEach((car, i) => {
    const knocked = isQuali && car.eliminated;
    const through = isQuali && !knocked && i < 10;
    const figA = kind === 'champ' ? String(Math.max(0, 240 - i * 17))
      : car.bestLapTime > 0 ? formatLapTime(car.bestLapTime) : '--:--.---';
    const figB = kind === 'champ' ? (i === 0 ? '—' : '-' + i * 17)
      : i === 0 ? 'FASTEST'
        : car.bestLapTime > 0 && lead.bestLapTime > 0
          ? '+' + (car.bestLapTime - lead.bestLapTime).toFixed(3) : 'NO TIME';

    timingRow(board, {
      pos: String(i + 1),
      colour: hex(car.team.colour),
      team: car.team,
      code: car.driver.code,
      name: car.driver.firstName + ' ' + car.driver.lastName,
      first: car.driver.firstName,
      last: car.driver.lastName.toUpperCase(),
      note: car.team.name,
      index: i,
      figs: [
        { text: figA, cls: i === 0 && kind !== 'champ' ? 'best' : '' },
        { text: figB, cls: i === 0 ? 'best' : figB === 'NO TIME' ? 'none' : 'dim' },
      ],
      tag: isQuali
        ? (knocked ? { text: 'Q1', cls: 'out' }
          : through ? { text: 'Through', cls: 'go' } : { text: 'Out', cls: 'warn' })
        : kind === 'champ'
          ? (i < 3 ? { text: 3 - i + '×', cls: 'best' } : undefined)
          : { text: '2 stops' },
      state: i === 3 ? 'me' : knocked ? 'knocked' : through ? 'through'
        : i === 0 ? 'best' : undefined,
    });

    if (isQuali && i === 9) cutLine(board, '10 advance to Q3');
    if (isQuali && out.length > 0 && i === runners.length - 1) {
      cutLine(board, 'Already out — grid slots ' + (runners.length + 1) + '–' + order.length, true);
    }
  });
}

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }

window.__panels = {
  async board(kind: string): Promise<void> {
    await buildBoard(kind);
    await new Promise((r) => window.setTimeout(r, 200));
  },

  async hud(scene: string): Promise<void> {
    if (!hudEngine) {
      app.innerHTML = '';
      app.style.background =
        'linear-gradient(160deg, #4a5c70 0%, #6d7f92 42%, #3d4a58 42.2%, #2b333d 100%)';
      app.style.position = 'fixed';
      app.style.inset = '0';
      const config: SessionConfig = {
        kind: 'race', name: 'Grand Prix', durationS: 0, laps: 57,
        playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 90210,
      };
      hudEngine = new RaceEngine(getCircuit('monza'), config);
      hudCar = hudEngine.cars[6];
      hud = new Hud(app);
      hud.setVisible(true);
      hud.setHelpVisible(false);
      for (let i = 0; i < Math.round(150 / PHYSICS_DT); i++) hudEngine.step();
    }
    hudScene(scene);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => window.setTimeout(r, 700));
  },

  /** What the HUD is actually showing, measured rather than photographed. */
  hudReport(): Record<string, unknown> {
    const root = hud?.root;
    if (!root) return {};
    const out: Record<string, unknown> = {};
    for (const sel of ['.hud-alert', '.hud-radiocard', '.hud-pit-cue', '.hud-weather', '.hud-tower']) {
      const e = root.querySelector<HTMLElement>(sel);
      if (!e) { out[sel] = 'missing'; continue; }
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      out[sel] = {
        cls: e.className,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        opacity: cs.opacity, display: cs.display, transform: cs.transform,
        text: (e.textContent ?? '').slice(0, 90),
      };
    }
    out.alertCount = root.querySelectorAll('.hud-alert').length;
    return out;
  },

  show(name: string, teamId: string, circuitId: string): void {
    const team = getTeam(teamId);
    const circuit = getCircuit(circuitId);
    if (name !== 'strategy') return;
    const drivers = driversForTeam(teamId);
    const body = chassis(
      'Race weekend · ' + circuit.name, 'Race Setup',
      'The plan for both cars, over ' + circuit.raceLaps + ' laps',
    );
    const panel = div('strategy', body);
    buildStrategyScreen(panel, {
      team,
      drivers,
      playerIndex: 0,
      track: circuit,
      laps: circuit.raceLaps,
      chosen: {},
      onChoose: () => {},
    });
  },
};
