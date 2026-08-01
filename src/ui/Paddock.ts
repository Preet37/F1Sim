import { TEAMS, DRIVERS, type Team, type Driver } from '../data/teams';

/**
 * The paddock: every team, their car, their drivers and what the car is
 * actually good at.
 *
 * WHAT THIS USED TO BE, AND WHY IT CHANGED
 *
 * A grid of ten cards, each with a flat top-down SVG in the team's colours and
 * seven bars beside it. Everything on it was true and none of it was a car.
 * The old file's own comment defended the SVG on the grounds that "a second
 * WebGL context competing with the one running the race is a real cost on a
 * phone for a picture that sits still" — but the picture does not have to sit
 * still, the game has been building a proper lofted car mesh with a per-team
 * livery this whole time, and a screen whose entire subject is the machinery
 * ought to show the machinery.
 *
 * So: one team at a time, its real car turning slowly on a lit stage, and the
 * whole field one press away along the bottom. Nothing was traded for the
 * picture — every multiplier the card grid printed is still printed, against
 * the same scale, and the driver list is unchanged.
 *
 * The 3D is NOT owned here. This module builds the interface and reports which
 * team is showing; `main.ts` owns the `CarStage`, because it is the thing that
 * knows when a screen is being torn down and is therefore the only place a GL
 * context can be released reliably.
 */

/** The multipliers worth showing, and how to read them. */
interface Metric {
  label: string;
  /** Pulls the multiplier out of the team's performance record. */
  get: (t: Team) => number;
  /** Range the bar spans. Chosen to cover the grid's real spread, not 0..1. */
  min: number;
  max: number;
  /** True when a LOWER multiplier is better — drag, tyre wear, pit time. */
  inverted?: boolean;
  /** Formats the raw value for the numeric readout. */
  format: (v: number) => string;
}

const METRICS: Metric[] = [
  { label: 'Power', get: (t) => t.performance.powerMult, min: 0.9, max: 1.06, format: pct },
  { label: 'Downforce', get: (t) => t.performance.downforceMult, min: 0.88, max: 1.08, format: pct },
  { label: 'Drag', get: (t) => t.performance.dragMult, min: 0.92, max: 1.1, inverted: true, format: pct },
  { label: 'Grip', get: (t) => t.performance.mechanicalGripMult, min: 0.9, max: 1.06, format: pct },
  { label: 'Tyre life', get: (t) => t.performance.tireWearMult, min: 0.88, max: 1.14, inverted: true, format: pct },
  { label: 'Reliability', get: (t) => t.performance.failureRate, min: 0.02, max: 0.16, inverted: true, format: (v) => (v * 100).toFixed(1) + '%' },
  { label: 'Pit crew', get: (t) => t.performance.pitCrewTimeS, min: 2.2, max: 3.6, inverted: true, format: (v) => v.toFixed(2) + 's' },
];

function pct(v: number): string {
  // Multipliers read most naturally as a delta from the baseline car.
  const d = (v - 1) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
}

export function hexColour(colour: number): string {
  return '#' + colour.toString(16).padStart(6, '0');
}

/**
 * Rough relative luminance, for deciding whether a nameplate's text goes white
 * or black. A team running a near-white livery would otherwise put white type
 * on a white slab.
 */
function isLight(colour: number): boolean {
  const r = (colour >> 16) & 255, g = (colour >> 8) & 255, b = colour & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62;
}

/** Drivers for a team, in race-number order. */
function driversFor(teamId: string): Driver[] {
  return DRIVERS.filter((d) => d.teamId === teamId)
    .sort((a, b) => a.raceNumber - b.raceNumber);
}

/**
 * Rough championship-order ranking, so the paddock lists the front of the grid
 * first the way a real standings page would. Every term is a multiplier the
 * physics actually applies, weighted by how much lap time it is worth.
 */
function strengthOf(t: Team): number {
  const p = t.performance;
  return p.powerMult * 1.0 + p.downforceMult * 0.9 + p.mechanicalGripMult * 0.7
    - p.dragMult * 0.45 - p.tireWearMult * 0.3 - p.failureRate * 1.2;
}

/** Teams in championship order — the order the paddock walks in. */
export const PADDOCK_ORDER: Team[] = [...TEAMS].sort((a, b) => strengthOf(b) - strengthOf(a));

export interface PaddockOptions {
  /** Marks the player's own team, when there is a career running. */
  currentTeamId?: string;
  /** Team to open on. Defaults to the player's team, then to the front row. */
  initialTeamId?: string;
  /**
   * Called whenever the shown team changes, including once on build.
   *
   * This is how the 3D stage learns which livery to fit. The paddock does not
   * hold the renderer itself — see the file header.
   */
  onShow?: (team: Team) => void;
  /** Adds a commit button under the panels. Used if a career ever picks teams. */
  onSelect?: (teamId: string) => void;
  selectLabel?: string;
}

export interface PaddockHandle {
  /** Steps the shown team by `delta` places, wrapping at both ends. */
  step(delta: number): void;
  /** The team currently on the stage. */
  current(): Team;
}

/**
 * Builds the showcase into `parent` and returns a handle for driving it.
 *
 * The DOM is built ONCE. Walking the field rewrites text and class names on
 * the nodes already there and never reconstructs them, which matters because
 * a chevron held down is a navigation every 120ms and rebuilding four panels
 * that often is exactly the pattern that has cost this project frames before.
 */
export function buildPaddock(parent: HTMLElement, opts: PaddockOptions = {}): PaddockHandle {
  const order = PADDOCK_ORDER;

  const root = document.createElement('div');
  root.className = 'showcase';
  parent.appendChild(root);

  // --- Head: the nameplate, and what the car has in the back of it ---------
  const head = document.createElement('div');
  head.className = 'showcase-head';
  root.appendChild(head);

  const plate = document.createElement('div');
  plate.className = 'nameplate';
  plate.innerHTML =
    '<span class="nameplate-rank"></span><span class="nameplate-name"></span>';
  head.appendChild(plate);
  const plateRank = plate.querySelector('.nameplate-rank') as HTMLElement;
  const plateName = plate.querySelector('.nameplate-name') as HTMLElement;

  const engine = document.createElement('div');
  engine.className = 'showcase-engine';
  head.appendChild(engine);

  // --- Panels: the car's numbers, and the two people who drive it ---------
  const panels = document.createElement('div');
  panels.className = 'showcase-panels';
  root.appendChild(panels);

  const perfPanel = document.createElement('div');
  perfPanel.className = 'showcase-panel';
  perfPanel.innerHTML = '<h3>Car</h3>' + METRICS.map(() => `
    <div class="perf-row">
      <span class="perf-label"></span>
      <span class="perf-track"><span class="perf-fill"></span></span>
      <span class="perf-value"></span>
    </div>`).join('');
  panels.appendChild(perfPanel);
  const perfRows = [...perfPanel.querySelectorAll('.perf-row')] as HTMLElement[];
  // Labels never change, so they are written once here rather than on show.
  perfRows.forEach((row, i) => {
    (row.querySelector('.perf-label') as HTMLElement).textContent = METRICS[i].label;
  });

  const driverPanel = document.createElement('div');
  driverPanel.className = 'showcase-panel';
  driverPanel.innerHTML = '<h3>Drivers</h3>';
  panels.appendChild(driverPanel);
  // Two rows: every team on this grid runs two cars, and a row that is empty
  // is hidden rather than removed so the DOM stays fixed.
  const driverRows = [0, 1].map(() => {
    const d = document.createElement('div');
    d.className = 'sc-driver';
    d.innerHTML =
      '<span class="sc-num"></span><span class="sc-code"></span>' +
      '<span class="sc-dname"></span><span class="sc-nat"></span>' +
      '<span class="sc-skill"></span>';
    driverPanel.appendChild(d);
    return d;
  });

  let commit: HTMLButtonElement | null = null;
  if (opts.onSelect) {
    commit = document.createElement('button');
    commit.type = 'button';
    commit.className = 'btn primary';
    commit.textContent = opts.selectLabel ?? 'Select';
    commit.addEventListener('click', () => opts.onSelect?.(order[index].id));
    root.appendChild(commit);
  }

  // --- The field, along the bottom ----------------------------------------
  const strip = document.createElement('div');
  strip.className = 'showcase-strip';
  root.appendChild(strip);
  const stripButtons = order.map((team, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'strip-team';
    b.style.setProperty('--team', hexColour(team.colour));
    b.setAttribute('aria-label', team.name);
    b.innerHTML =
      '<span class="strip-rank">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<span class="strip-code">' + team.code + '</span>';
    b.addEventListener('click', () => show(i));
    strip.appendChild(b);
    return b;
  });

  // --- Showing a team ------------------------------------------------------
  let index = Math.max(0, order.findIndex(
    (t) => t.id === (opts.initialTeamId ?? opts.currentTeamId)));

  function show(next: number): void {
    index = ((next % order.length) + order.length) % order.length;
    const team = order[index];
    const colour = hexColour(team.colour);

    // The team's colour drives the whole screen's chroma for as long as it is
    // the team on the stage: the nameplate, the bars, the driver codes and the
    // glow on the chevron blades all read it from here.
    root.style.setProperty('--team', colour);
    parent.style.setProperty('--team', colour);

    plate.classList.toggle('on-light', isLight(team.colour));
    plateRank.textContent = String(index + 1).padStart(2, '0');
    plateName.textContent = team.name;
    engine.innerHTML = team.engine.toUpperCase() +
      (team.id === opts.currentTeamId ? ' &middot; <b>YOUR TEAM</b>' : '');

    perfRows.forEach((row, i) => {
      const m = METRICS[i];
      const raw = m.get(team);
      const t = (raw - m.min) / (m.max - m.min);
      const norm = Math.max(0, Math.min(1, m.inverted ? 1 - t : t));
      (row.querySelector('.perf-fill') as HTMLElement).style.width = (norm * 100).toFixed(1) + '%';
      const value = row.querySelector('.perf-value') as HTMLElement;
      value.textContent = m.format(raw);
      // Green where the car is better than the baseline, yellow where it is
      // worse: the same two signals these colours carry everywhere else.
      value.className = 'perf-value ' + (norm >= 0.62 ? 'gain' : norm <= 0.3 ? 'loss' : '');
    });

    const drivers = driversFor(team.id);
    driverRows.forEach((row, i) => {
      const d = drivers[i];
      row.style.display = d ? '' : 'none';
      if (!d) return;
      (row.querySelector('.sc-num') as HTMLElement).textContent = String(d.raceNumber);
      const code = row.querySelector('.sc-code') as HTMLElement;
      code.textContent = d.code;
      code.style.color = isLight(team.colour) ? '#080b10' : '#fff';
      (row.querySelector('.sc-dname') as HTMLElement).textContent = d.firstName + ' ' + d.lastName;
      (row.querySelector('.sc-nat') as HTMLElement).textContent = d.nationality;
      (row.querySelector('.sc-skill') as HTMLElement).textContent = String(Math.round(d.skill * 100));
    });

    stripButtons.forEach((b, i) => {
      b.classList.toggle('is-current', i === index);
      b.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
    // Keep the selected band in view when the strip has to scroll.
    stripButtons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });

    opts.onShow?.(team);
  }

  show(index);

  return {
    step: (delta: number) => show(index + delta),
    current: () => order[index],
  };
}
