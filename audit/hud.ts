import { Renderer } from '../src/render/Renderer';
import { type CameraMode } from '../src/render/CameraDirector';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { Hud } from '../src/ui/Hud';
import type { CarEntry } from '../src/race/CarEntry';

/**
 * The browser half of `npm run shoot:hud`.
 *
 * `audit/index.html` photographs the WORLD and deliberately leaves the HUD out
 * of it — it drives `Renderer` alone. That is the right scope for a rendering
 * sweep and the wrong one for a UI change: the whole question about a HUD panel
 * is what it looks like ON TOP of a live circuit at night, in the rain, with a
 * safety car out, on a landscape phone. So this page is the same idea pointed
 * at the other layer: the REAL `Hud`, over the REAL `Renderer`, driving the
 * REAL `RaceEngine`, with the game's own stylesheet linked.
 *
 * It adds one thing the game cannot give a screenshot: `scene()`, which forces
 * the engine into a state a panel only appears in. Waiting for a safety car to
 * happen by itself is not a verification method.
 */

declare global {
  interface Window {
    __hudShoot: HudShootApi;
  }
}

interface HudShootApi {
  load(circuitId: string): Promise<void>;
  camera(mode: CameraMode): void;
  scene(name: SceneName): void;
  /** Runs the simulation forward, then paints one frame of HUD. */
  advance(seconds: number): Promise<void>;
  /** Repaints the HUD without advancing time — for a state just forced. */
  repaint(): Promise<void>;
  scenes: readonly SceneName[];
  /** Everything the HUD is currently saying, for text assertions. */
  readText(): Record<string, string>;
}

type SceneName =
  | 'clear'
  | 'pit-advice'
  | 'in-box'
  | 'safety-car'
  | 'yellow'
  | 'chequered'
  | 'wet'
  | 'radio-burst';

const SCENES: readonly SceneName[] = [
  'clear', 'pit-advice', 'in-box', 'safety-car', 'yellow', 'chequered', 'wet', 'radio-burst',
];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const app = document.getElementById('app') as HTMLElement;

const renderer = new Renderer({ canvas, quality: 'low' });
renderer.resize();

const hud = new Hud(app);
hud.setVisible(true);
// The controls card covers the middle of the screen for the first seconds of a
// session and is not what any of these shots are about.
hud.setHelpVisible(false);

let engine: RaceEngine | null = null;
let player: CarEntry | null = null;

/** Everything `Hud.update` reads off the input controller, and nothing else. */
const input = {
  ersMode: 'balanced',
  showTouchOverlay: false,
  joystickActive: false,
  joystickCentreX: 0,
  joystickCentreY: 0,
  joystickOffset: { x: 0, y: 0, radius: 60 },
  throttleHeld: false,
  brakeHeld: false,
  reverseTouchHeld: false,
} as never;

/** Which car the HUD is pointed at. Mid-field, so the gaps read both ways. */
const FOCUS_INDEX = 6;

const config: SessionConfig = {
  kind: 'race',
  name: 'Grand Prix',
  durationS: 0,
  laps: 57,
  // Every car is driven by the game's own AI, including the one the HUD is
  // pointed at. A `playerIndex` reserves that car for a human, and a human who
  // never touches the controls parks it on the grid and is retired inside two
  // minutes — which is exactly what the first run of this harness photographed.
  playerIndex: -1,
  standingStart: false,
  pitLaneStart: false,
  seed: 90210,
};

/**
 * A continuous draw loop.
 *
 * `page.screenshot` reads the composited surface rather than the WebGL drawing
 * buffer, so unlike the world audit there is no `preserveDrawingBuffer` dance
 * to do — but the compositor only has a frame if something keeps drawing one.
 */
function loop(): void {
  if (engine && player) renderer.render(1 / 60, engine, player);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// The sweep photographs a desktop window and a landscape phone from the SAME
// page, because building a circuit under a software rasteriser costs minutes
// and building each one twice doubles the sweep for nothing. Resizing the
// viewport is only equivalent to loading at that size if the renderer is told,
// which the game does from its own resize handler and this page has to as well.
window.addEventListener('resize', () => renderer.resize());

function present(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function paint(): void {
  if (!engine || !player) return;
  hud.update(engine, player, input, 60, 240);
  hud.updateStartLights(engine.startLights, engine.started);
}

const api: HudShootApi = {
  scenes: SCENES,

  async load(circuitId: string): Promise<void> {
    const def = getCircuit(circuitId);
    engine = new RaceEngine(def, config);
    player = engine.cars[FOCUS_INDEX];
    renderer.loadSession(engine);
    hud.setCameraLabel(renderer.director.modeLabel);
    hud.setCameraMode(renderer.director.mode);
    // Enough racing that the field has spread, tyres have worn and every
    // timing readout has real numbers in it. A HUD photographed on lap zero is
    // a HUD full of dashes.
    for (let i = 0; i < Math.round(150 / PHYSICS_DT); i++) engine.step();
    paint();
    await present();
  },

  camera(mode: CameraMode): void {
    renderer.director.setMode(mode);
    hud.setCameraLabel(renderer.director.modeLabel);
    hud.setCameraMode(mode);
  },

  scene(name: SceneName): void {
    if (!engine || !player) return;
    const rc = engine.raceControl;

    // Reset EVERYTHING the last scene forced, not just some of it. Damage and
    // the pit-lane latch used to survive from one scene into the next, which
    // makes a shot a picture of every scene run before it — and, worse, hides
    // the pop-ups: the pit call fires on a CHANGE of advice, and an advice
    // left standing by the previous scene never changes.
    rc.sessionFlag = 'green';
    rc.neutralisation = 'none';
    for (let i = 0; i < rc.sectorFlags.length; i++) rc.sectorFlags[i] = 'green';
    engine.weather.wetness = 0.02;
    engine.weather.airTempC = engine.track.def.baseAirTempC;
    engine.weather.trackTempC = engine.track.def.baseTrackTempC;
    player.pitRequested = false;
    player.inPitLane = false;
    player.inPitBox = false;
    player.damage.health.frontWingL = 1;

    switch (name) {
      case 'pit-advice':
        // The exact case the complaint was about: DAMAGE — PIT FOR REPAIRS.
        player.damage.health.frontWingL = 0.44;
        break;
      case 'in-box':
        player.inPitLane = true;
        player.inPitBox = true;
        player.pitBoxTimer = 2.4;
        break;
      case 'safety-car':
        rc.neutralisation = 'safety-car';
        break;
      case 'yellow':
        rc.sectorFlags[1] = 'yellow';
        break;
      case 'chequered':
        rc.sessionFlag = 'chequered';
        break;
      case 'wet':
        engine.weather.wetness = 0.55;
        engine.weather.airTempC = 18;
        engine.weather.trackTempC = 21;
        break;
      case 'radio-burst':
        rc.log('YELLOW FLAG IN SECTOR 2 — INCIDENT AT TURN 8', 'warning', engine.time);
        rc.log('CAR 24 UNDER INVESTIGATION FOR TRACK LIMITS', 'info', engine.time);
        rc.log('DEBRIS ON THE RACING LINE AT TURN 11', 'critical', engine.time);
        break;
      default:
        break;
    }
    paint();
  },

  async advance(seconds: number): Promise<void> {
    if (!engine) return;
    for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) engine.step();
    paint();
    await present();
  },

  async repaint(): Promise<void> {
    paint();
    await present();
    // The notification cards slide in over about a third of a second. A shot
    // taken two frames after the state changed photographs them half arrived,
    // which is a picture of the transition rather than of the design.
    await new Promise((r) => window.setTimeout(r, 600));
    await present();
  },

  readText(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const el of Array.from(hud.root.querySelectorAll<HTMLElement>('[data-probe]'))) {
      const key = el.dataset.probe as string;
      const hidden = el.offsetParent === null && el.style.display === 'none';
      out[key] = hidden ? '' : (el.textContent ?? '');
    }
    return out;
  },
};

window.__hudShoot = api;
