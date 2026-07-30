import './setup.css';

import { applySetup, specForTeam, baselineSetupFor, type CarSetup, type VehicleSpec } from '../physics/VehicleSpec';
import { DRY_COMPOUNDS, WET_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { Team } from '../data/teams';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';

/**
 * The car setup sheet.
 *
 * Every control here writes into a `CarSetup`, which `applySetup` turns into the
 * actual `VehicleSpec` the physics integrates. There is no cosmetic slider on
 * this screen and no hidden "setup rating" — move the wing and the drag
 * coefficient changes, and the estimated top speed at the bottom of the page
 * changes with it, because both are computed from the same spec the car will be
 * built from. That is why the derived readout is here: it is the proof the
 * setup reached the car.
 *
 * Each parameter carries its trade-off in one line, because a setup screen
 * without them is a screen of numbers nobody can act on. The trade-offs are not
 * flavour text either — they describe what the model will actually do.
 */

/** One adjustable parameter, and how it reads. */
interface Param {
  key: keyof CarSetup;
  name: string;
  min: number;
  max: number;
  step: number;
  /** Labels for the two ends of the travel. */
  lowLabel: string;
  highLabel: string;
  /** The real value, in real units. */
  format: (v: number) => string;
  /** The one line that tells the player what they are giving up. */
  trade: string;
}

const PARAMS: Param[] = [
  {
    key: 'downforceLevel',
    name: 'Wing level',
    min: 0, max: 1, step: 0.05,
    lowLabel: 'Monza skinny', highLabel: 'Monaco maximum',
    format: (v) => (v * 100).toFixed(0) + '%',
    trade: 'More wing means more downforce and more grip through every corner — but downforce ' +
      'costs drag, and drag costs top speed on the straights. Trim it out at Monza; wind it on at Monaco.',
  },
  {
    key: 'aeroBalance',
    name: 'Aero balance',
    min: -1, max: 1, step: 0.1,
    lowLabel: 'Rearward · stable', highLabel: 'Forward · pointy',
    format: (v) => (v === 0 ? 'neutral' : (v > 0 ? 'front +' : 'rear +') + Math.abs(v * 100).toFixed(0) + '%'),
    trade: 'Shifting downforce forward gives the front axle more load, so the car turns in harder — ' +
      'at the cost of a rear that has less and will step out under power. Only bites at speed.',
  },
  {
    key: 'suspensionBalance',
    name: 'Anti-roll bars',
    min: -1, max: 1, step: 0.1,
    lowLabel: 'Stiff rear', highLabel: 'Stiff front',
    format: (v) => (v === 0 ? 'balanced' : (v > 0 ? 'front +' : 'rear +') + Math.abs(v * 100).toFixed(0) + '%'),
    trade: 'The mechanical version of aero balance, and it works at every speed rather than only at high ' +
      'ones. A stiffer axle transfers more load and therefore loses more grip — so a stiff FRONT bar ' +
      'means understeer, a stiff rear bar means a car that rotates and can snap.',
  },
  {
    key: 'diffLock',
    name: 'Differential lock',
    min: 0, max: 1, step: 0.05,
    lowLabel: 'Open', highLabel: 'Locked',
    format: (v) => (v * 100).toFixed(0) + '%',
    trade: 'A locked diff ties the rear wheels together, which resists rotation: stability and traction ' +
      'on corner exit, understeer and scrub on the way in. Unlock it for a slow, tight circuit.',
  },
  {
    key: 'brakeBias',
    name: 'Brake bias',
    min: 0.5, max: 0.68, step: 0.01,
    lowLabel: 'Rearward', highLabel: 'Forward',
    format: (v) => (v * 100).toFixed(0) + '% front',
    trade: 'Forward bias is stable under braking but locks the fronts first, and a locked front means ' +
      'going straight on. Move it rearward for turn-in on the brakes, and risk locking a rear and spinning.',
  },
  {
    key: 'gearing',
    name: 'Gear ratios',
    min: 0, max: 1, step: 0.05,
    lowLabel: 'Short · acceleration', highLabel: 'Long · top speed',
    format: (v) => (v < 0.34 ? 'short' : v > 0.66 ? 'long' : 'medium') + ' (' + (v * 100).toFixed(0) + ')',
    trade: 'Short gears accelerate harder out of slow corners but hit the limiter early on a long straight. ' +
      'Long gears reach a higher top speed and feel lazy off a hairpin.',
  },
];

export interface SetupScreenOptions {
  setup: CarSetup;
  compound: CompoundId;
  team: Team;
  track: TrackDefinition;
  /** True when the session is expected to be wet, so inters and wets are offered. */
  offerWets: boolean;
  onChange: (setup: CarSetup, compound: CompoundId) => void;
}

/**
 * Peak power, W. The setup screen quotes a top speed, and quoting one that
 * ignores the hybrid would be off by a good 20km/h.
 */
function peakPowerW(spec: VehicleSpec): number {
  return spec.icePowerW + spec.ersPowerW;
}

/**
 * Drag-limited top speed, m/s.
 *
 * At terminal velocity the drag force equals the tractive force, and tractive
 * force is power over speed: cd*v^2 = P*eff/v, so v = cbrt(P*eff/cd). Rolling
 * resistance shaves a little off, which the 0.96 accounts for.
 */
function topSpeedMs(spec: VehicleSpec): number {
  return Math.cbrt((peakPowerW(spec) * spec.driveEfficiency) / spec.cdBase) * 0.96;
}

/** Steady-state lateral g at a given speed, from downforce and weight. */
function lateralG(spec: VehicleSpec, speedMs: number, massKg: number): number {
  const load = massKg * 9.81 + spec.clBase * speedMs * speedMs;
  return (spec.baseMu * load) / (massKg * 9.81);
}

/** Road speed at the limiter in top gear, km/h. */
function topGearSpeedKph(spec: VehicleSpec): number {
  const ratio = spec.gearRatios[spec.gearRatios.length - 1];
  return ((spec.redlineRpm / 9.5493 / ratio) * spec.tireRadiusM * 3.6);
}

/**
 * Formats a value against the engineers' baseline, and says whether the change
 * is a gain or a cost. `better` is the direction that helps: top speed wants to
 * go up, drag wants to go down.
 */
function fmtDelta(now: number, ref: number, unit: string, better: 'up' | 'down'): [string, string] {
  const d = now - ref;
  if (Math.abs(d) < Math.abs(ref) * 0.002) return ['baseline', 'flat'];
  // Enough decimals that a coefficient of 0.83 and a top speed of 340 both read
  // as a real number rather than as "+0.0".
  const dp = Math.abs(ref) >= 50 ? 0 : Math.abs(ref) >= 2 ? 2 : 3;
  const gain = better === 'up' ? d > 0 : d < 0;
  return [(d > 0 ? '+' : '') + d.toFixed(dp) + unit + ' vs baseline', gain ? 'gain' : 'cost'];
}

/**
 * Builds the setup sheet into `parent`.
 *
 * The readouts update in place as the sliders move rather than the screen being
 * rebuilt — rebuilding would destroy the slider the player is currently
 * dragging, which on a touchscreen means the control fights back.
 */
export function buildSetupScreen(parent: HTMLElement, opts: SetupScreenOptions): void {
  const el = (tag: string, cls: string, p: HTMLElement, text = ''): HTMLElement => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text) d.textContent = text;
    p.appendChild(d);
    return d;
  };

  const setup = opts.setup;
  let compound = opts.compound;
  const teamSpec = specForTeam(opts.team.performance);
  // The circuit's own recommendation, so every delta is measured against the
  // setup the engineers would have handed you.
  const refSpec = applySetup(teamSpec, baselineSetupFor(opts.track.downforceDemand, setup.fuelLoadL));
  const mass = teamSpec.dryMassKg + setup.fuelLoadL * teamSpec.fuelDensity;

  /** Everything that has to be redrawn when a value changes. */
  const refresh: (() => void)[] = [];
  const changed = () => {
    for (const fn of refresh) fn();
    opts.onChange(setup, compound);
  };

  // --- Sliders -------------------------------------------------------------
  el('div', 'section-title', parent, 'Chassis and aero');
  const list = el('div', 'setup-list', parent);

  for (const p of PARAMS) {
    const item = el('div', 'setup-item', list);
    const head = el('div', 'setup-head', item);
    el('div', 'setup-name', head, p.name);
    const readout = el('div', 'setup-value', head, p.format(setup[p.key] as number));

    const row = el('div', 'setup-slider-row', item);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'setup-slider';
    slider.min = String(p.min);
    slider.max = String(p.max);
    slider.step = String(p.step);
    slider.value = String(setup[p.key]);
    slider.setAttribute('aria-label', p.name);

    // Floating-point steps accumulate error over enough nudges (0.05 twenty
    // times is not 1.0), so every write is snapped back to the grid.
    const set = (v: number) => {
      const clamped = Math.min(p.max, Math.max(p.min, v));
      (setup[p.key] as number) = Math.round(clamped / p.step) * p.step;
      slider.value = String(setup[p.key]);
      changed();
    };

    const stepper = (label: string, dir: number) => {
      const b = document.createElement('button');
      b.className = 'setup-step';
      b.textContent = label;
      b.setAttribute('aria-label', p.name + (dir > 0 ? ' up' : ' down'));
      b.addEventListener('click', () => set((setup[p.key] as number) + dir * p.step));
      row.appendChild(b);
    };

    stepper('−', -1);
    slider.addEventListener('input', () => {
      (setup[p.key] as number) = Number(slider.value);
      changed();
    });
    row.appendChild(slider);
    stepper('+', 1);

    const ends = el('div', 'setup-ends', item);
    el('span', '', ends, p.lowLabel);
    el('span', '', ends, p.highLabel);

    el('div', 'setup-trade', item, p.trade);

    refresh.push(() => { readout.textContent = p.format(setup[p.key] as number); });
  }

  // --- Tyres ---------------------------------------------------------------
  el('div', 'section-title', parent, 'Starting tyre compound');
  const tyres = el('div', 'card-grid', parent);
  const offered = opts.offerWets ? [...DRY_COMPOUNDS, ...WET_COMPOUNDS] : DRY_COMPOUNDS;

  for (const id of offered) {
    const c = getCompound(id);
    const card = el('div', 'card', tyres);
    const name = el('div', 'card-name', card);
    const dot = document.createElement('span');
    dot.className = 'setup-tyre-dot';
    dot.style.background = '#' + c.colour.toString(16).padStart(6, '0');
    name.appendChild(dot);
    name.appendChild(document.createTextNode(c.name));
    el('div', 'card-meta', card,
      'grip x' + c.peakGrip.toFixed(2) + ' · wear x' + c.wearRate.toFixed(2) +
      ' · window ' + c.optimalTempMinC + '-' + c.optimalTempMaxC + '°C');
    el('div', 'card-stat', card,
      c.isWetWeather
        ? 'Only on a wet track — overheats and destroys itself on a dry one'
        : c.wearRate > 1.2 ? 'Fastest, but the shortest stint'
        : c.wearRate < 0.8 ? 'Slowest, but it will run and run'
        : 'The compromise: quick enough, and it lasts');
    card.addEventListener('click', () => { compound = id; changed(); });
    refresh.push(() => card.classList.toggle('selected', compound === id));
  }

  // --- Derived readout -----------------------------------------------------
  //
  // This is the receipt. Every number is computed from the spec `applySetup`
  // produced, so if the setup did not reach the car these would not move.
  el('div', 'section-title', parent, 'What this setup gives you');
  const derived = el('div', 'setup-derived', parent);

  const cell = (label: string, read: () => [string, [string, string] | null]) => {
    const d = el('div', 'setup-derived-cell', derived);
    el('div', 'setup-derived-label', d, label);
    const value = el('div', 'setup-derived-value', d);
    const delta = el('div', 'setup-derived-delta', d);
    refresh.push(() => {
      const [v, dd] = read();
      value.textContent = v;
      delta.textContent = dd ? dd[0] : '';
      delta.className = 'setup-derived-delta ' + (dd ? dd[1] : 'flat');
    });
  };

  const live = () => applySetup(teamSpec, setup);

  cell('Top speed', () => {
    const v = topSpeedMs(live()) * 3.6;
    return [v.toFixed(0) + ' km/h', fmtDelta(v, topSpeedMs(refSpec) * 3.6, ' km/h', 'up')];
  });
  cell('Cornering at 250', () => {
    const g = lateralG(live(), 250 / 3.6, mass);
    return [g.toFixed(2) + ' g', fmtDelta(g, lateralG(refSpec, 250 / 3.6, mass), 'g', 'up')];
  });
  cell('Downforce coeff.', () =>
    [live().clBase.toFixed(2), fmtDelta(live().clBase, refSpec.clBase, '', 'up')]);
  cell('Drag coeff.', () =>
    [live().cdBase.toFixed(3), fmtDelta(live().cdBase, refSpec.cdBase, '', 'down')]);
  cell('Aero balance', () => [(live().aeroBalanceFront * 100).toFixed(1) + '% front', null]);
  cell('8th gear', () => [topGearSpeedKph(live()).toFixed(0) + ' km/h', null]);
  cell('Front cornering', () => [live().corneringStiffnessFront.toFixed(2) + ' /rad', null]);
  cell('Rear cornering', () => [live().corneringStiffnessRear.toFixed(2) + ' /rad', null]);

  const advice = el('div', 'setup-trade', parent);
  advice.style.marginTop = '10px';
  advice.textContent =
    opts.track.name + ' wants about ' + (opts.track.downforceDemand * 100).toFixed(0) +
    '% wing — that is what the engineers set as the baseline every delta above is measured from. ' +
    'Going lower buys straight-line speed and costs you in the corners; going higher does the reverse.';

  // Paint every readout once, so the page is correct before anything is touched.
  for (const fn of refresh) fn();
}

/** The setup the engineers would hand you for a circuit. */
export function defaultSetupFor(track: TrackDefinition, fuelL = 100): CarSetup {
  return baselineSetupFor(track.downforceDemand, fuelL);
}
