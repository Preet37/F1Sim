import { buildStrategyScreen } from '../src/ui/StrategyScreen';
import { driversForTeam, getTeam } from '../src/data/teams';
import { getCircuit } from '../src/data/tracks/circuits';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { formatLapTime } from '../src/core/MathUtils';
import { cutLine, qualifyingStrip, timingBoard, timingRow } from '../src/ui/TimingRow';
import { PHYSICS_DT } from '../src/core/SimClock';
import { Hud, mirrorPaneBoxes } from '../src/ui/Hud';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import { PitStopPrompt } from '../src/ui/PitStopPrompt';

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
      radioReport(): Record<string, unknown>;
      railReport(): Record<string, unknown>;
      camera(mode: string): void;
      mirrorReport(mode: string): Record<string, unknown>;
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
let hudPrompt: PitStopPrompt | null = null;
let hudCar: ReturnType<RaceEngine['cars']['at']> | null = null;
/**
 * The stand-in for a human at the wheel.
 *
 * WITHOUT THIS THE HARNESS PHOTOGRAPHS A WRECK. The scene now runs with
 * `playerIndex: 6`, because the pit wall only ever asks the PLAYER a question
 * and a spectator harness can never exercise the two-way radio. But a player
 * car with no control input does not sit politely on the racing line — it is
 * stationary in a nineteen-car field, and by 150 seconds it has been retired.
 *
 * Every radio message is now gated on the driver's own state (see
 * `DriverState`), and the gate was correct to refuse: a retired driver is not
 * asked about the delta. So the harness was asking for a card the game is
 * right to withhold, and the fix belongs here rather than in the gate.
 */
let hudDriver: AIVehicleController | null = null;
let hudView: AIPerception | null = null;

/** Runs the session with the game's own AI at the player's wheel. */
function stepHud(steps: number): void {
  if (!hudEngine || !hudCar || !hudDriver || !hudView) return;
  for (let i = 0; i < steps; i++) {
    Object.assign(hudView, hudCar.perception);
    const c = hudDriver.update(PHYSICS_DT, hudCar.physics, hudCar.s, hudCar.lateral, hudView);
    const out = hudEngine.playerControls;
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.reverse = c.reverse;
    out.gearRequest = c.gearRequest;
    out.ersMode = c.ersMode;
    out.drsRequested = c.drsRequested;
    hudEngine.step();
  }
}

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
  hudCar.pitRequested = false;
  hudCar.damage.health.frontWingL = 1;
  hudPrompt?.close();
  hud.setPitSheetOpen(false);

  if (scene === 'pit-advice') hudCar.damage.health.frontWingL = 0.44;
  if (scene === 'safety-car') rc.neutralisation = 'safety-car';
  // THE RADIO CARD, ON ITS OWN AND WITH A QUESTION ON IT.
  //
  // Both of these are the sweep catching something a screenshot of another
  // scene cannot. `railReport` measures every box on the rail, and the radio
  // card is the one item `fitRail` is allowed to THROW AWAY when the band is
  // short — so a card that is too tall does not overlap anything and does not
  // clip anything. It simply never appears, silently, and the sweep passes.
  // The first version of the square card was 238px against a 262px band with a
  // live cue in it, and that is exactly what happened.
  //
  // `radio-ask` is the two-way case: the wall asking something with buttons
  // under it, which is the tallest the card ever gets.
  if (scene === 'radio') {
    // A TRANSITION, not a state. `updateRadioCard` fires on the EDGE — that is
    // the whole reason the card cannot cry wolf — so a scene that merely sets
    // `neutralisation` to what the previous scene already left it at raises
    // nothing at all. `rail-max` runs before this one and leaves a safety car
    // deployed, so the green frame has to be shown to the HUD first.
    hud.update(hudEngine, hudCar, hudInput, 60, 240);
    rc.neutralisation = 'safety-car';
  }
  if (scene === 'radio-ask') {
    // Through the real strategist, not by poking the card. The wall raises a
    // box call when the crossover arithmetic says the tyre on the car is
    // losing enough to pay for a stop — so the scene makes that true and lets
    // `PitWall.update` reach its own conclusion. A harness that fabricated the
    // question would photograph a card the game cannot actually produce.
    hudEngine.weather.forceRain(0.9, true);
    for (let i = 0; i < 900 && !hudEngine.pitWall?.awaitingAnswer; i++) stepHud(1);
  }
  if (scene === 'wet') hudEngine.weather.wetness = 0.55;
  if (scene === 'radio-burst') {
    rc.log('DEBRIS ON THE RACING LINE AT TURN 11', 'critical', hudEngine.time);
  }
  if (scene === 'in-box') {
    hudCar.inPitLane = true; hudCar.inPitBox = true; hudCar.pitBoxTimer = 2.4;
  }
  if (scene === 'pit-choice' || scene === 'rail-max') {
    hudCar.pitRequested = true;
    hudCar.damage.health.frontWingL = 0.44;
    hudCar.damage.health.frontWingR = 0.44;
    hudPrompt?.render(hudEngine, hudCar, {
      tyre: 'T', repair: 'F', confirm: 'ENTER', cancel: 'L',
    });
    hud.setPitSheetOpen(true);
  }

  // EVERYTHING AT ONCE. This is the case the rail has to be designed for, not
  // the quiet frame: a stop being chosen, race control filing a bulletin, the
  // pit wall reacting to damage, a neutralisation, and the radio card on top of
  // all of it. The reported fault — "also from ur tests i think its being
  // covered?" — is what this frame catches, and it catches it by MEASUREMENT in
  // `railReport`, not by anyone looking at the picture.
  if (scene === 'rail-max') {
    rc.neutralisation = 'safety-car';
    hudEngine.weather.wetness = 0.35;
    rc.log(
      'Contact between HAL and OKO', 'warning', hudEngine.time, -1,
      { notice: {
        parties: ['HAL', 'OKO'], where: 'TURN 1', offence: 'CONTACT', status: 'NOTED',
      } },
    );
    rc.log(
      hudCar.driver.code + ': front wing damage', 'warning', hudEngine.time, hudCar.index,
      { feed: 'team', team: { kind: 'damage', part: 'Front wing', health: 0.44 } },
    );
  }

  hud.update(hudEngine, hudCar, hudInput, 60, 240);
  if (hudCar.pitRequested && hudPrompt) {
    hudPrompt.render(hudEngine, hudCar, {
      tyre: 'T', repair: 'F', confirm: 'ENTER', cancel: 'L',
    });
    hud.setPitSheetOpen(true);
  }
}

/**
 * Every box on the left rail, and whether any two of them collide.
 *
 * WHY THIS IS A MEASUREMENT AND NOT A SCREENSHOT. The reported fault was the
 * pit sheet drawn across the radio card, and then the radio card drawn under
 * two notification cards. Both are invisible in a still if you are looking at
 * the wrong corner, and both are trivially decidable from four numbers. So the
 * sweep computes the intersections and `shootPanels` fails on any of them.
 *
 * `intersects` uses a one-pixel tolerance because a shared border between two
 * stacked cards is not an overlap, and sub-pixel layout puts adjacent boxes a
 * few hundredths of a pixel into each other on a fractional device ratio.
 */
function railReport(): Record<string, unknown> {
  const root = hud?.root;
  if (!root) return {};

  const SELECTORS = [
    '.hud-tower', '.hud-radiocard', '.pitprompt', '.hud-neutral-cue', '.hud-pit-cue',
    '.hud-weather', '.hud-carstate', '.hud-damage', '.hud-gaps',
  ];
  interface Box { name: string; x: number; y: number; w: number; h: number }
  const boxes: Box[] = [];
  const add = (name: string, e: HTMLElement) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    boxes.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
  };
  for (const sel of SELECTORS) {
    const e = root.querySelector<HTMLElement>(sel);
    if (e) add(sel, e);
  }
  // Every card in the notice stack individually: two pop-ups that overlap each
  // other are the same fault as a pop-up over the radio card.
  const cards = root.querySelectorAll<HTMLElement>('.hud-alert, .hud-control');
  for (const [i, c] of [...cards].entries()) add('.card[' + i + ']', c);

  const overlaps: string[] = [];
  const T = 1;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > T && oy > T) {
        overlaps.push(a.name + ' x ' + b.name +
          ' by ' + Math.round(ox) + 'x' + Math.round(oy) + 'px');
      }
    }
  }

  // Clipping. A rail child whose box escapes the rail's band is a card the
  // driver reads half of, which is what "being covered" looked like.
  const rail = root.querySelector<HTMLElement>('.hud-notices');
  const clipped: string[] = [];
  if (rail) {
    const band = rail.getBoundingClientRect();
    for (const child of rail.children) {
      const e = child as HTMLElement;
      if (getComputedStyle(e).display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.height < 1) continue;
      if (r.top < band.top - T || r.bottom > band.bottom + T) {
        clipped.push(e.className.split(' ')[0] +
          ' out of the band by ' +
          Math.round(Math.max(band.top - r.top, r.bottom - band.bottom)) + 'px');
      }
    }
  }

  return {
    boxes: boxes.map((b) => b.name + ' [' +
      [b.x, b.y, b.w, b.h].map((v) => Math.round(v)).join(',') + ']'),
    overlaps,
    clipped,
  };
}

/**
 * Every HUD box against the mirror panes, and whether any of them collides.
 *
 * THE SAME TREATMENT THE RAIL GETS, and for the same reason. The mirrors had
 * been mounted sideways since they were written; on the frame they were fixed,
 * the weather bug was lying across the left pane in the driver's eye and the
 * tyre panel across it in the cockpit. That is a fix that does not land, and it
 * is four numbers to decide — so it is decided here rather than by looking at a
 * screenshot of the wrong corner.
 *
 * The pane boxes come from `mirrorPaneBoxes`, which is the same table the
 * stylesheet lays the bottom band out against, so the picture and the assertion
 * cannot disagree.
 */
function mirrorReport(mode: string): Record<string, unknown> {
  const root = hud?.root;
  if (!root) return {};
  const panes = mirrorPaneBoxes(mode, window.innerWidth, window.innerHeight);
  if (panes.length === 0) return { panes: [], overlaps: [] };

  interface Box { name: string; x: number; y: number; w: number; h: number }
  const boxes: Box[] = [];
  const add = (name: string, e: HTMLElement) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    boxes.push({ name, x: r.x, y: r.y, w: r.width, h: r.height });
  };
  for (const child of root.children) {
    const e = child as HTMLElement;
    const cls = e.className.split(' ').filter((c) => c !== 'hud-panel')[0] ?? '';
    // The touch overlay and the help sheet are full-screen by construction —
    // the first is a hit region with nothing drawn in it, and the second is a
    // modal the player has asked for and is not driving under.
    if (cls === 'hud-touch' || cls === 'hud-help') continue;
    add('.' + cls, e);
  }
  // The rail's children individually as well as the rail's own band: a card
  // may slide out of the band's foot even when the band itself is clear.
  for (const c of root.querySelectorAll<HTMLElement>('.hud-alert, .hud-control, .hud-radiocard, .hud-pit-cue, .hud-neutral-cue')) {
    add('.' + c.className.split(' ')[0], c);
  }

  const overlaps: string[] = [];
  const T = 1;
  for (const p of panes) {
    for (const b of boxes) {
      const ox = Math.min(p.x + p.w, b.x + b.w) - Math.max(p.x, b.x);
      const oy = Math.min(p.y + p.h, b.y + b.h) - Math.max(p.y, b.y);
      if (ox > T && oy > T) {
        overlaps.push(b.name + ' over ' + p.name +
          ' by ' + Math.round(ox) + 'x' + Math.round(oy) + 'px');
      }
    }
  }
  return {
    panes: panes.map((p) => p.name + ' [' +
      [p.x, p.y, p.w, p.h].map((v) => Math.round(v)).join(',') + ']'),
    boxes: boxes.map((b) => b.name + ' [' +
      [b.x, b.y, b.w, b.h].map((v) => Math.round(v)).join(',') + ']'),
    overlaps,
  };
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
    // The screen chassis animates in — status rail, header, body and action
    // bar on a staggered `rise`, and the rows after them. Two hundred
    // milliseconds photographed a championship board with a grey title and no
    // rows in it at all, which looks exactly like a board that failed to
    // build. Wait for the whole sequence, then a frame.
    await new Promise((r) => window.setTimeout(r, 1200));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },

  async hud(scene: string): Promise<void> {
    if (!hudEngine) {
      app.innerHTML = '';
      app.style.background =
        'linear-gradient(160deg, #4a5c70 0%, #6d7f92 42%, #3d4a58 42.2%, #2b333d 100%)';
      app.style.position = 'fixed';
      app.style.inset = '0';
      // A PLAYER CAR, not a spectator's. The pit wall only ever asks the
      // player a question — `updatePitWalls` skips every other car — so a
      // harness with `playerIndex: -1` can photograph the radio card but can
      // never photograph the two-way half of it, which is the half that was
      // just built.
      const config: SessionConfig = {
        kind: 'race', name: 'Grand Prix', durationS: 0, laps: 57,
        playerIndex: 6, standingStart: false, pitLaneStart: false, seed: 90210,
      };
      hudEngine = new RaceEngine(getCircuit('monza'), config);
      hudCar = hudEngine.cars[6];
      hud = new Hud(app);
      hudPrompt = new PitStopPrompt(hud.pitSlot);
      hud.setVisible(true);
      hud.setHelpVisible(false);
      hudDriver = new AIVehicleController(hudCar.driver, hudEngine.track, 991, 'hard');
      hudView = { ...hudCar.perception };
      stepHud(Math.round(150 / PHYSICS_DT));
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
    out.alertCount = root.querySelectorAll('.hud-alert, .hud-control').length;
    return out;
  },

  /**
   * Is the radio card actually on screen, and what shape is it?
   *
   * ITS OWN REPORT BECAUSE ITS OWN FAILURE IS INVISIBLE TO THE OTHERS. Every
   * other check on this rail is an overlap or a clip, and the radio card is
   * the one item `fitRail` is permitted to throw away rather than let overrun
   * the band. A card too tall for the band therefore produces a perfectly
   * clean sweep in which the card simply is not there — which is what the
   * first square version did, at 238px against a 262px band.
   */
  radioReport(): Record<string, unknown> {
    const root = hud?.root;
    if (!root) return {};
    const card = root.querySelector<HTMLElement>('.hud-radiocard');
    if (!card) return { shown: false, why: 'no element' };
    const cs = getComputedStyle(card);
    const r = card.getBoundingClientRect();
    const choice = card.querySelector<HTMLElement>('.radio-choice');
    const rail = root.querySelector<HTMLElement>('.hud-notices');
    const band = rail ? rail.getBoundingClientRect() : null;
    const turns = [...card.querySelectorAll<HTMLElement>('.radio-turn')]
      .filter((t) => getComputedStyle(t).display !== 'none');
    return {
      shown: cs.display !== 'none' && r.height > 1,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      // 1.0 is a perfect square. The card is allowed to be taller than wide —
      // text of unknown length is the content — but a ratio over about 1.6 is
      // the letterbox this pass replaced.
      ratio: r.width > 0 ? Number((r.height / r.width).toFixed(2)) : 0,
      asking: !!choice && getComputedStyle(choice).display !== 'none',
      turns: turns.length,
      // The band it had to fit in, because "not on screen" has exactly two
      // causes — it was never raised, or `fitRail` measured it and threw it out
      // — and they need completely different fixes.
      band: band ? Math.round(band.height) : 0,
      used: rail ? [...rail.children]
        .map((c) => (c as HTMLElement).className.split(' ')[0] + ':' +
          Math.round((c as HTMLElement).getBoundingClientRect().height))
        .join(' ') : '',
      neutral: !!hudEngine && hudEngine.raceControl.neutralisation,
      text: (card.textContent ?? '').slice(0, 120),
    };
  },

  railReport,

  /**
   * Points the HUD at a camera, exactly as `Main.cycleCamera` does.
   *
   * Then repaints, because the running order's ROW COUNT depends on the camera
   * — `towerFit` takes the mirror band as a parameter and drops to four rows
   * under it — and a report taken before the next frame would measure a
   * fourteen-row tower in a layout that has been sized for four.
   */
  camera(mode: string): void {
    hud?.setCameraMode(mode);
    if (hud && hudEngine && hudCar) hud.update(hudEngine, hudCar, hudInput, 60, 240);
  },

  mirrorReport,

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
