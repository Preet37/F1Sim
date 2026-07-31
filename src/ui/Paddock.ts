import { TEAMS, DRIVERS, type Team, type Driver } from '../data/teams';

/**
 * The paddock: every team, their car, their drivers and what the car is
 * actually good at.
 *
 * The performance bars are not decoration. Each one reads a multiplier that the
 * physics applies directly through `specForTeam` — power scales the engine's
 * peak watts, downforce scales the lift coefficient, drag scales the drag
 * coefficient. So a team shown as strong on power and heavy on drag really will
 * out-drag the field down the Monza straights and really will lose that time
 * again through the Suzuka esses, with no per-circuit special-casing anywhere.
 * The paddock is a readout of the simulation, not a brochure.
 *
 * The car is drawn as an SVG top-down silhouette in the team's own livery
 * rather than as a 3D preview. A second WebGL context competing with the one
 * running the race is a real cost on a phone for a picture that sits still, and
 * an SVG scales perfectly at any density for nothing.
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

function hex(colour: number): string {
  return '#' + colour.toString(16).padStart(6, '0');
}

/**
 * A top-down F1 car in a team's livery.
 *
 * One path per major body area so the accent colour lands where a real livery
 * puts it — nose flash, engine cover spine, wing endplates — instead of tinting
 * the whole car and making every team look identical but differently coloured.
 */
function carSvg(team: Team): string {
  const base = hex(team.colour);
  const accent = hex(team.accent);
  // Several teams run a near-black accent, which vanishes against a dark card.
  // Wheels and outlines therefore use fixed neutrals, and the accent is only
  // ever painted on top of the livery colour where it is guaranteed to read.
  return `
<svg viewBox="0 0 104 250" class="pad-car" aria-hidden="true">
  <!-- Rear wing: widest element on the car, and the first thing that reads. -->
  <rect x="6" y="222" width="92" height="17" rx="3" fill="${base}"/>
  <rect x="6" y="222" width="92" height="6" rx="3" fill="${accent}"/>
  <rect x="6" y="214" width="8" height="30" rx="2" fill="${base}"/>
  <rect x="90" y="214" width="8" height="30" rx="2" fill="${base}"/>

  <!-- Rear wheels -->
  <rect x="2" y="168" width="26" height="46" rx="6" fill="#16181d" stroke="#3a3f49" stroke-width="1.5"/>
  <rect x="76" y="168" width="26" height="46" rx="6" fill="#16181d" stroke="#3a3f49" stroke-width="1.5"/>

  <!-- Floor and sidepods: the big body masses. -->
  <path d="M28 104 L46 96 L46 204 L28 196 Z" fill="${base}"/>
  <path d="M76 104 L58 96 L58 204 L76 196 Z" fill="${base}"/>
  <rect x="40" y="150" width="24" height="58" rx="6" fill="${base}"/>

  <!-- Engine cover spine, in the accent. -->
  <rect x="42" y="86" width="20" height="122" rx="9" fill="${base}"/>
  <rect x="48" y="92" width="8" height="110" rx="4" fill="${accent}"/>

  <!-- Halo and cockpit -->
  <ellipse cx="52" cy="112" rx="12" ry="10" fill="none" stroke="#22262e" stroke-width="4"/>
  <circle cx="52" cy="112" r="5" fill="#101318"/>

  <!-- Front wheels -->
  <rect x="4" y="52" width="24" height="42" rx="6" fill="#16181d" stroke="#3a3f49" stroke-width="1.5"/>
  <rect x="76" y="52" width="24" height="42" rx="6" fill="#16181d" stroke="#3a3f49" stroke-width="1.5"/>
  <rect x="27" y="70" width="16" height="3" fill="#39404b"/>
  <rect x="61" y="70" width="16" height="3" fill="#39404b"/>

  <!-- Nose, tapering to the front wing. -->
  <path d="M44 30 L60 30 L58 96 L46 96 Z" fill="${base}"/>
  <path d="M47 34 L57 34 L56 70 L48 70 Z" fill="${accent}"/>

  <!-- Front wing -->
  <rect x="4" y="10" width="96" height="18" rx="3" fill="${base}"/>
  <rect x="4" y="22" width="96" height="6" rx="3" fill="${accent}"/>
  <rect x="4" y="6" width="7" height="26" rx="2" fill="${base}"/>
  <rect x="93" y="6" width="7" height="26" rx="2" fill="${base}"/>
</svg>`;
}

/** Drivers for a team, in race-number order. */
function driversFor(teamId: string): Driver[] {
  return DRIVERS.filter((d) => d.teamId === teamId)
    .sort((a, b) => a.raceNumber - b.raceNumber);
}

/**
 * Rough championship-order ranking, so the paddock lists the front of the grid
 * first the way a real standings page would.
 *
 * Weighted toward the terms that dominate lap time. This is a presentation
 * ordering only — nothing in the simulation reads it.
 */
function strengthOf(t: Team): number {
  const p = t.performance;
  return p.powerMult * 1.0
    + p.downforceMult * 1.0
    + p.mechanicalGripMult * 0.8
    - p.dragMult * 0.5
    - p.tireWearMult * 0.25
    - p.failureRate * 1.5;
}

export interface PaddockOptions {
  /** Called when the player picks a team, if the screen is being used to choose. */
  onSelect?: (teamId: string) => void;
  /** Highlights the player's current team. */
  currentTeamId?: string;
  /** Label for the action button on each card. */
  selectLabel?: string;
}

/**
 * Builds the paddock into `parent`.
 *
 * Pure DOM construction with no per-frame work: the paddock is a static screen,
 * so it is built once on navigation and then simply sits there.
 */
export function buildPaddock(parent: HTMLElement, opts: PaddockOptions = {}): void {
  const grid = document.createElement('div');
  grid.className = 'paddock-grid';
  parent.appendChild(grid);

  const ordered = [...TEAMS].sort((a, b) => strengthOf(b) - strengthOf(a));

  ordered.forEach((team, rank) => {
    const card = document.createElement('div');
    card.className = 'paddock-card' + (team.id === opts.currentTeamId ? ' current' : '');
    // The livery colour drives the card's own accents, so each team's panel is
    // recognisable before any text is read.
    card.style.setProperty('--team', hex(team.colour));
    card.style.setProperty('--team-accent', hex(team.accent));
    grid.appendChild(card);

    const drivers = driversFor(team.id);

    const metricRows = METRICS.map((m) => {
      const raw = m.get(team);
      // Normalise into 0..1 where 1 is always "good", whichever way the
      // underlying multiplier runs.
      const t = (raw - m.min) / (m.max - m.min);
      const norm = Math.max(0, Math.min(1, m.inverted ? 1 - t : t));
      return `
        <div class="pad-metric">
          <span class="pad-metric-label">${m.label}</span>
          <span class="pad-bar"><span class="pad-bar-fill" style="width:${(norm * 100).toFixed(1)}%"></span></span>
          <span class="pad-metric-value">${m.format(raw)}</span>
        </div>`;
    }).join('');

    const driverRows = drivers.map((d) => `
      <div class="pad-driver">
        <span class="pad-num">${d.raceNumber}</span>
        <span class="pad-dcode">${d.code}</span>
        <span class="pad-dname">${d.firstName} ${d.lastName}</span>
        <span class="pad-nat">${d.nationality}</span>
        <span class="pad-skill">${Math.round(d.skill * 100)}</span>
      </div>`).join('');

    // The header is the garage nameplate: the constructors' position, the team,
    // its engine and its three-letter code, over a band of the livery colour.
    // A team should be identifiable from the band alone, before any text.
    card.innerHTML = `
      <div class="pad-plate">
        <span class="pad-rank">${String(rank + 1).padStart(2, '0')}</span>
        <div class="pad-titles">
          <div class="pad-team">${team.name}</div>
          <div class="pad-engine">${team.engine}${team.id === opts.currentTeamId ? ' · your team' : ''}</div>
        </div>
        <span class="pad-code">${team.code}</span>
      </div>
      <div class="pad-body">
        <div class="pad-bay">${carSvg(team)}</div>
        <div class="pad-metrics">${metricRows}</div>
      </div>
      <div class="pad-drivers">${driverRows}</div>`;

    if (opts.onSelect) {
      const btn = document.createElement('button');
      btn.className = 'btn pad-select';
      btn.textContent = opts.selectLabel ?? 'Select';
      btn.addEventListener('click', () => opts.onSelect?.(team.id));
      card.appendChild(btn);
    }
  });
}
