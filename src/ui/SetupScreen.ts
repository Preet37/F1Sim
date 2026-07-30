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
 * coefficient changes, and the estimated top speed in the bar pinned to the top
 * of the page changes with it, because both are computed from the same spec the
 * car will be built from. That is why the derived readout is here, and why it
 * is pinned: it is the proof the setup reached the car, and proof you have to
 * scroll to find is proof nobody sees.
 *
 * Every control on the sheet moves at least one number in that bar. That is a
 * design constraint, not a coincidence — a slider whose effect the receipt
 * cannot show is a slider the player has no way to reason about.
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
function dragLimitedMs(spec: VehicleSpec): number {
  return Math.cbrt((peakPowerW(spec) * spec.driveEfficiency) / spec.cdBase) * 0.96;
}

/** Road speed at the limiter in top gear, km/h. */
function topGearSpeedKph(spec: VehicleSpec): number {
  const ratio = spec.gearRatios[spec.gearRatios.length - 1];
  return ((spec.redlineRpm / 9.5493 / ratio) * spec.tireRadiusM * 3.6);
}

/**
 * The top speed the car will actually see, m/s.
 *
 * Whichever runs out first: the drag the wing is making, or the limiter in top
 * gear. Quoting only the drag limit was why the gearing slider appeared to do
 * nothing to the headline number — gear a car short enough and it hits the rev
 * limiter long before it runs out of power, which is exactly the mistake the
 * slider exists to let you make.
 */
function topSpeedMs(spec: VehicleSpec): number {
  return Math.min(dragLimitedMs(spec), topGearSpeedKph(spec) / 3.6);
}

/** Which limit is binding, for the caption under the top-speed number. */
function topSpeedLimiter(spec: VehicleSpec): string {
  return dragLimitedMs(spec) <= topGearSpeedKph(spec) / 3.6 ? 'drag limited' : 'on the limiter';
}

/** Steady-state lateral g at a given speed, from downforce and weight. */
function lateralG(spec: VehicleSpec, speedMs: number, massKg: number): number {
  const load = massKg * 9.81 + spec.clBase * speedMs * speedMs;
  return (spec.baseMu * load) / (massKg * 9.81);
}

/**
 * Braking limit and the axle that gives up first, at a reference speed.
 *
 * This is the cell that makes the brake bias slider mean something. An axle
 * locks when the braking force asked of it exceeds the grip its load can
 * supply, and both sides of that move: the bias decides the share of force each
 * axle is asked for, while weight transfer under braking loads the front and
 * unloads the rear, and downforce adds load to both in the aero split.
 *
 * Front locks when     bias*m*a = mu*(Wf + aeroF*DF + m*a*h/L)
 * Rear locks when  (1-bias)*m*a = mu*(Wr + (1-aeroF)*DF - m*a*h/L)
 *
 * Solve each for the deceleration `a` at which it happens; the smaller one is
 * the limit, and its axle is the one that locks. Bias the brakes far enough
 * forward and the front term goes negative — the front can never out-grip the
 * force it is given, which is the front-lock understeer every driver knows.
 */
function brakingLimit(spec: VehicleSpec, speedMs: number, massKg: number): { g: number; axle: string } {
  const g = 9.81;
  const L = spec.wheelbaseM;
  const h = spec.cogHeightM;
  const df = spec.clBase * speedMs * speedMs;
  // cogToFrontM is the distance from the CoG to the front axle, so the front
  // carries the fraction of static weight that sits behind it.
  const frontStatic = (L - spec.cogToFrontM) / L;
  const wf = frontStatic * massKg * g + spec.aeroBalanceFront * df;
  const wr = (1 - frontStatic) * massKg * g + (1 - spec.aeroBalanceFront) * df;
  const b = spec.brakeBalanceFront;
  const mu = spec.baseMu;

  const frontDen = b * massKg - mu * massKg * h / L;
  const aFront = frontDen > 1e-6 ? (mu * wf) / frontDen : Infinity;
  const aRear = (mu * wr) / ((1 - b) * massKg + mu * massKg * h / L);

  // Report the grip limit, not the smaller of that and what the calipers can
  // physically apply. Clamping to the pedal would flatten the readout across
  // most of the bias range and put the slider straight back where it started —
  // apparently doing nothing. The pedal ceiling is worth saying, so it goes in
  // the caption instead.
  const limit = Math.min(aFront, aRear);
  const aPad = spec.maxBrakeForceN / massKg;
  const axle =
    aPad < limit ? 'pedal runs out at ' + (aPad / g).toFixed(2) + 'g'
    : aFront < aRear ? 'fronts lock first' : 'rears lock first';
  return { g: limit / g, axle };
}

/**
 * Handling balance: how much of the cornering work each axle can do, against
 * how much it is asked to do.
 *
 * Two things decide it and this combines both, because on a real car they trade
 * against each other. The aero term is the front axle's share of total vertical
 * load measured against the 45% share of lateral force a bicycle model demands
 * of it. The mechanical term is the ratio of the axles' cornering stiffnesses,
 * which is what the anti-roll bars and the differential move.
 *
 * Positive is a car that rotates, negative is a car that pushes.
 */
function balanceIndex(spec: VehicleSpec, speedMs: number, massKg: number): number {
  const df = spec.clBase * speedMs * speedMs;
  const weight = massKg * 9.81;
  const frontCapacity = (spec.aeroBalanceFront * df + 0.45 * weight) / (df + weight);
  const aeroTerm = frontCapacity / 0.45 - 1;
  const mechTerm = spec.corneringStiffnessFront / spec.corneringStiffnessRear - 1;
  return (aeroTerm * 0.6 + mechTerm * 0.4) * 100;
}

function balanceWord(idx: number): string {
  if (idx > 2.5) return 'loose · rotates';
  if (idx > 0.7) return 'pointy';
  if (idx < -2.5) return 'strong understeer';
  if (idx < -0.7) return 'stable · pushes';
  return 'neutral';
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

  // --- Derived readout -----------------------------------------------------
  //
  // This is the receipt, and it is built FIRST and pinned to the top of the
  // scroller on purpose. It used to live at the bottom of the page, below six
  // sliders and three tyre cards — about 690px down a 945px document. Every
  // number in it did update, but on any real screen you could not see it while
  // your hand was on a slider, so the honest player experience was moving a
  // control and watching nothing happen. A readout you have to scroll away from
  // the control to read is a readout that does not exist.
  //
  // Every number is computed from the spec `applySetup` produced, so if the
  // setup did not reach the car these would not move.
  const receipt = el('div', 'setup-receipt', parent);
  const rhead = el('div', 'setup-receipt-head', receipt);
  el('span', '', rhead, 'What this setup gives you');
  el('span', 'setup-receipt-live', rhead, 'updates as you move a control');
  const derived = el('div', 'setup-derived', receipt);

  /**
   * One readout cell. It remembers what it last showed so a value that actually
   * moved can flash — with eight numbers on screen, a silent re-render of two
   * of them is easy to miss.
   */
  const cell = (label: string, read: () => [string, string, string]) => {
    const d = el('div', 'setup-derived-cell', derived);
    el('div', 'setup-derived-label', d, label);
    const value = el('div', 'setup-derived-value', d);
    const delta = el('div', 'setup-derived-delta', d);
    let last = '';
    refresh.push(() => {
      const [v, dText, dClass] = read();
      if (v !== last) {
        if (last !== '') {
          d.classList.remove('bump');
          // Forcing layout restarts the animation; without it a second change
          // inside the animation's own duration would not replay it.
          void d.offsetWidth;
          d.classList.add('bump');
        }
        last = v;
      }
      value.textContent = v;
      delta.textContent = dText;
      delta.className = 'setup-derived-delta ' + dClass;
    });
  };

  const live = () => applySetup(teamSpec, setup);

  cell('Top speed', () => {
    const spec = live();
    const v = topSpeedMs(spec) * 3.6;
    const [t, c] = fmtDelta(v, topSpeedMs(refSpec) * 3.6, ' km/h', 'up');
    return [v.toFixed(0) + ' km/h', topSpeedLimiter(spec) + ' · ' + t, c];
  });
  cell('Cornering at 250', () => {
    const g = lateralG(live(), 250 / 3.6, mass);
    const [t, c] = fmtDelta(g, lateralG(refSpec, 250 / 3.6, mass), 'g', 'up');
    return [g.toFixed(2) + ' g', t, c];
  });
  cell('Braking limit', () => {
    const b = brakingLimit(live(), 250 / 3.6, mass);
    const [, c] = fmtDelta(b.g, brakingLimit(refSpec, 250 / 3.6, mass).g, 'g', 'up');
    return [b.g.toFixed(2) + ' g', b.axle, c];
  });
  cell('Balance', () => {
    const i = balanceIndex(live(), 200 / 3.6, mass);
    return [(i > 0 ? '+' : '') + i.toFixed(1), balanceWord(i), 'flat'];
  });
  cell('Downforce coeff.', () => {
    const [t, c] = fmtDelta(live().clBase, refSpec.clBase, '', 'up');
    return [live().clBase.toFixed(2), t, c];
  });
  cell('Drag coeff.', () => {
    const [t, c] = fmtDelta(live().cdBase, refSpec.cdBase, '', 'down');
    return [live().cdBase.toFixed(3), t, c];
  });
  cell('Limiter in 8th', () => {
    const v = topGearSpeedKph(live());
    const [t, c] = fmtDelta(v, topGearSpeedKph(refSpec), ' km/h', 'up');
    return [v.toFixed(0) + ' km/h', t, c];
  });
  cell('Tyre', () => {
    const c = getCompound(compound);
    return [c.name, 'grip x' + c.peakGrip.toFixed(2) + ' · wear x' + c.wearRate.toFixed(2), 'flat'];
  });

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

  const advice = el('div', 'setup-trade', parent);
  advice.style.marginTop = '10px';
  advice.textContent =
    opts.track.name + ' wants about ' + (opts.track.downforceDemand * 100).toFixed(0) +
    '% wing — that is what the engineers set as the baseline every delta in the bar at the top of ' +
    'this page is measured against. Going lower buys straight-line speed and costs you in the ' +
    'corners; going higher does the reverse.';

  // Paint every readout once, so the page is correct before anything is touched.
  for (const fn of refresh) fn();
}

/** The setup the engineers would hand you for a circuit. */
export function defaultSetupFor(track: TrackDefinition, fuelL = 100): CarSetup {
  return baselineSetupFor(track.downforceDemand, fuelL);
}

/**
 * A one-line description of what a setup does to the car, for the garage card
 * on the session-select and career screens.
 *
 * It runs the same `applySetup` the sheet and the car do, so the numbers a
 * player sees before they ever open the setup page are the numbers they will
 * drive. That is the whole point of putting it on the way in: the setup stops
 * being a menu you might find and becomes a visible property of your car.
 */
export function setupSummary(
  team: Team,
  track: TrackDefinition,
  setup: CarSetup,
  compound: CompoundId,
): { headline: string; detail: string; modified: boolean } {
  const spec = applySetup(specForTeam(team.performance), setup);
  const base = baselineSetupFor(track.downforceDemand, setup.fuelLoadL);
  const mass = spec.dryMassKg + setup.fuelLoadL * spec.fuelDensity;
  const modified = (Object.keys(base) as (keyof CarSetup)[])
    .some((k) => Math.abs(setup[k] - base[k]) > 1e-6);

  return {
    headline:
      (setup.downforceLevel * 100).toFixed(0) + '% wing · ' +
      (topSpeedMs(spec) * 3.6).toFixed(0) + ' km/h · ' +
      lateralG(spec, 250 / 3.6, mass).toFixed(2) + 'g at 250',
    detail:
      getCompound(compound).name + ' tyres · brakes ' + (setup.brakeBias * 100).toFixed(0) +
      '% front (' + brakingLimit(spec, 250 / 3.6, mass).axle + ') · ' +
      balanceWord(balanceIndex(spec, 200 / 3.6, mass)),
    modified,
  };
}
