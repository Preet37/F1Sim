import { buildStrategyScreen } from '../src/ui/StrategyScreen';
import { driversForTeam, getTeam } from '../src/data/teams';
import { getCircuit } from '../src/data/tracks/circuits';

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
  interface Window { __panels: { show(name: string, teamId: string, circuitId: string): void } }
}

const app = document.getElementById('app') as HTMLElement;

function chassis(tab: string, title: string, sub: string): HTMLElement {
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
  primary.textContent = 'Confirm — to the grid';
  actions.appendChild(primary);
  return body;
}

function div(cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}

window.__panels = {
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
