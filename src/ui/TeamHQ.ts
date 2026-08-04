import './career.css';
import './myteam.css';
import { escapeHtml, timingBoard, timingRow } from './TimingRow';
import { hex } from './LiveryEditor';
import type { Career } from '../career/Career';
import {
  AMBITION, COST_CAP_USD, DEPARTMENT_EFFECT, DEPARTMENT_IDS, DEPARTMENT_NAME,
  MAX_FACILITY_LEVEL, PIT_CREW_STEP_S, PIT_CREW_STEP_USD, breachSeverity,
  capSpent, facilityUpgradeCostUsd, ledgerExpenditure, ledgerIncome,
  upgradeSummary,
  type Ambition, type DepartmentId,
} from '../career/MyTeam';
import { drawMark } from '../render/LiveryDesign';
import { decisionList, newsFeed, type BriefingRoutes } from './Briefing';
import { performanceOf } from '../career/World';

/**
 * THE FACTORY, THE BOOKS AND THE TWO CONTRACTS.
 *
 * ---------------------------------------------------------------------------
 * THE ONE IDEA ON THIS SCREEN
 * ---------------------------------------------------------------------------
 *
 * Every screen in this game carries the sector rule under its header: three
 * segments whose widths are the real proportions of something — a circuit's
 * sector splits, a season's rounds. It is the house device for "here is a
 * quantity, and here is how much of it is behind you".
 *
 * My Team's version of that fact is money, and specifically the COST CAP, which
 * is the only constraint in the mode that cannot be got round by winning. So the
 * cap gauge is the same instrument reading a different quantity, in the same
 * place, on every screen where something can be committed — and on none where
 * nothing can. The paint shop does not have one, because paint is free and a
 * gauge there would be decoration.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY BUTTON CARRIES ITS OWN PRICE
 * ---------------------------------------------------------------------------
 *
 * A button that opens a dialog to tell you what it costs is a button you press
 * to find out. Every commission here states its price, its duration in ROUNDS —
 * not weeks, because rounds are the clock this career runs on — and its chance
 * of failing quality control, before it is pressed. The quality-control figure
 * in particular is not hidden behind a hint: it is the number department morale
 * exists to move, and a mechanic the player cannot see is a mechanic they will
 * experience as the game cheating.
 */

export interface TeamScreenOptions {
  career: Career;
  /** Called after anything that changes the save, so the caller can persist. */
  onChange: () => void;
}

/**
 * Mounts the whole factory screen, and repaints it IN PLACE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHY IT IS NOT `showTeamHQ()` CALLING ITSELF
 * ---------------------------------------------------------------------------
 *
 * The first version of this screen handled every button by rebuilding the whole
 * page — `page()` clears `screenRoot.innerHTML` and constructs it again — so
 * commissioning a project made the screen flash white, throw away the scroll
 * position and drop the player back at the top of a page they were halfway
 * down. Doing that on the busiest screen in the mode, on every single press,
 * IS the "jittery" complaint, and it was self-inflicted.
 *
 * So the screen is built once with stable containers, and a change repaints
 * only the containers whose contents can have changed, inside the existing
 * scroll box. The scroll position is then restored explicitly, because
 * commissioning a project genuinely changes the height of the plate above the
 * one you are looking at and the browser has no way to know what you were
 * reading.
 */
export function mountTeamHQ(
  body: HTMLElement, opts: TeamScreenOptions & { routes: BriefingRoutes },
): { refresh(): void } {
  const { career } = opts;

  const decisionsHost = el('div', '', body);
  const identityHost = el('div', '', body);
  const gaugeHost = el('div', '', body);
  el('div', 'section-title', body, 'The factory');
  const factoryHost = el('div', '', body);
  el('div', 'section-title', body, 'The books');
  const ledgerHost = el('div', '', body);
  el('div', 'section-title', body, 'The paddock');
  const newsHost = el('div', '', body);

  /** The page's own scroll box. `page()` puts the body inside it. */
  const scroller = (): HTMLElement | null => {
    let n: HTMLElement | null = body;
    while (n) {
      if (n.scrollHeight > n.clientHeight + 1) return n;
      n = n.parentElement;
    }
    return null;
  };

  const paint = (inner: { career: Career; onChange: () => void }): void => {
    decisionsHost.innerHTML = '';
    decisionList(decisionsHost, career, opts.routes);
    identityHost.innerHTML = '';
    teamIdentity(identityHost, career);
    gaugeHost.innerHTML = '';
    capGauge(gaugeHost, career);
    factoryHost.innerHTML = '';
    factoryFloor(factoryHost, inner);
    ledgerHost.innerHTML = '';
    ledgerStrip(ledgerHost, career);
    newsHost.innerHTML = '';
    newsFeed(newsHost, career, 6);
  };

  const refresh = (): void => {
    const box = scroller();
    const at = box?.scrollTop ?? 0;
    opts.onChange();
    paint({ career, onChange: refresh });
    if (box) box.scrollTop = at;
  };

  paint({ career, onChange: refresh });
  return { refresh };
}

// ===========================================================================
// The cost cap gauge
// ===========================================================================

/**
 * The signature instrument. Committed, remaining, and — only if it exists —
 * the overspend.
 *
 * The bar's segments are the real dollar proportions. When a career is inside
 * the cap there is no red anywhere on this screen, which is the entire reason
 * the red means something on the day it appears.
 */
export function capGauge(parent: HTMLElement, career: Career): HTMLElement {
  const t = career.myTeam;
  const g = el('div', 'capgauge', parent);
  if (!t) return g;

  const committed = career.capCommittedUsd();
  const headroom = career.capHeadroomUsd();
  const over = Math.max(0, -headroom);
  const severity = breachSeverity(committed);

  const head = el('div', 'capgauge-head', g);
  el('div', 'capgauge-label', head, 'Cost cap');
  el('div', 'capgauge-value', head, '$' + money(Math.min(committed, COST_CAP_USD)));
  el('div', 'capgauge-of', head, 'of $' + money(COST_CAP_USD) + ' committed');
  const cash = el('div', 'capgauge-cash' + (t.cashUsd < 0 ? ' broke' : ''), head);
  cash.innerHTML = 'In the bank <b>$' + escapeHtml(money(t.cashUsd)) + '</b>';

  const bar = el('div', 'capgauge-bar', g);
  const total = Math.max(COST_CAP_USD, committed);
  const seg = (cls: string, value: number) => {
    if (value <= 0) return;
    const s = el('span', cls, bar);
    s.style.flex = String(value / total);
  };
  seg('spent', Math.min(committed, COST_CAP_USD));
  seg('free', Math.max(0, headroom));
  seg('over', over);

  const note = el('div',
    'capgauge-note' + (severity === 'major' ? ' bad' : severity === 'minor' ? ' warn' : ''), g);
  if (severity === 'none') {
    note.textContent = '$' + money(headroom) + ' left to commit this season. '
      + 'Salaries and the engine deal sit outside the cap.';
  } else {
    note.textContent = '$' + money(over) + ' past the cap. '
      + 'The audit runs at the end of the season.';
  }
  return g;
}

// ===========================================================================
// The ledger
// ===========================================================================

export function ledgerStrip(parent: HTMLElement, career: Career): void {
  const t = career.myTeam;
  if (!t) return;
  const l = t.ledger;
  const strip = el('div', 'ledger', parent);

  const cell = (
    label: string, value: number, kind: 'income' | 'cost', capped: boolean, note: string,
  ) => {
    const c = el('div', 'ledger-cell ' + kind + (capped ? ' capped' : ''), strip);
    el('div', 'ledger-label', c, label);
    el('div', 'ledger-value', c, (kind === 'income' ? '+$' : '−$') + money(value));
    el('div', 'ledger-note', c, note);
  };

  cell('Prize money', l.prizeUsd, 'income', false, 'paid at the end of the season');
  cell('Commercial', l.commercialUsd, 'income', false, 'grows with your fan rating');
  cell('Development', l.developmentUsd, 'cost', true, 'under the cap');
  cell('Staff', l.staffUsd, 'cost', true, 'under the cap');
  cell('Facilities', l.facilityUsd, 'cost', true, 'under the cap');
  cell('Salaries', l.salariesUsd, 'cost', false, 'outside the cap');
  cell('Engine', l.engineUsd, 'cost', false, 'outside the cap');

  const net = ledgerIncome(l) - ledgerExpenditure(l);
  el('div', 'mt-why', parent,
    `This season: $${money(ledgerIncome(l))} in, $${money(ledgerExpenditure(l))} out, `
    + `${net >= 0 ? 'a surplus' : 'a shortfall'} of $${money(Math.abs(net))}. `
    + `$${money(capSpent(l))} of it counts against the cap.`);
}

// ===========================================================================
// The factory
// ===========================================================================

/**
 * The three departments.
 *
 * Each plate answers the four questions that decide whether to commission
 * anything here: how good is the building, how many people are in it, how do
 * they feel, and are they already busy. Morale is on a meter rather than as a
 * bare number because a figure out of a hundred needs its scale, and it is
 * banded green/yellow/red like every other health figure in the game.
 */
export function factoryFloor(parent: HTMLElement, opts: TeamScreenOptions): void {
  const { career } = opts;
  const t = career.myTeam;
  const team = career.myTeamRecord();
  if (!t || !team) return;

  const grid = el('div', 'depts', parent);
  for (const id of DEPARTMENT_IDS) departmentPlate(grid, id, opts);

  // --- The pit crew --------------------------------------------------------
  //
  // Not a department and not a project: it is people, and it is bought in
  // steps. It lands on `pitCrewTimeS`, which `PitStop.ts` uses as the stationary
  // time and `Strategy.ts` already prices when it works out how many stops to
  // make — so six hundredths is a real decision about race strategy and not a
  // statistic.
  const crew = el('div', 'dept', grid);
  crew.style.setProperty('--dept', 'var(--sig-white, #cdd6e2)');
  const crewHead = el('div', 'dept-head', crew);
  el('div', 'dept-name', crewHead, 'Pit crew');
  el('div', 'dept-effect', crew, 'Stationary time, which decides how many stops you can afford');
  const figs = el('div', 'dept-figs', crew);
  // The figure the physics will actually use, read back through the same
  // function `CarEntry` reads it through — not the stored constant.
  fig(figs, 'Stop', performanceOf(team).pitCrewTimeS.toFixed(2) + 's');
  fig(figs, 'Trained off', (team.upgrades?.pitCrew ?? 0).toFixed(2) + 's');
  const crewActions = el('div', 'dept-actions', crew);
  const crewReason = el('div', 'mt-reason', crew);
  actionButton(crewActions, {
    label: 'Train the crew',
    price: '$' + money(PIT_CREW_STEP_USD) + ' · −' + PIT_CREW_STEP_S.toFixed(2) + 's',
    check: career.canCommit(PIT_CREW_STEP_USD, { underCap: true }),
    onClick: () => commit(
      (o) => career.investInPitCrew(o), crewReason, 'The crew is quicker.', opts.onChange),
  });
}

function departmentPlate(
  parent: HTMLElement, id: DepartmentId, opts: TeamScreenOptions,
): void {
  const { career } = opts;
  const t = career.myTeam!;
  const dept = t.departments[id];
  const project = t.projects.find((p) => p.department === id);

  const plate = el('div', 'dept', parent);
  plate.style.setProperty('--dept', DEPARTMENT_COLOUR[id]);

  const head = el('div', 'dept-head', plate);
  el('div', 'dept-name', head, DEPARTMENT_NAME[id]);
  el('div', 'dept-effect', plate, DEPARTMENT_EFFECT[id]);

  // The facility, counted rather than written as a fraction.
  const fac = el('div', 'dept-facility', plate);
  const steps = el('div', 'dept-steps', fac);
  for (let i = 1; i <= MAX_FACILITY_LEVEL; i++) {
    el('i', i <= dept.level ? 'on' : '', steps);
  }
  el('div', 'dept-facility-label', fac, 'Facility ' + dept.level);

  const figs = el('div', 'dept-figs', plate);
  fig(figs, 'Staff', String(dept.staff));
  fig(figs, 'Morale', String(Math.round(dept.morale)), dept.morale);

  // What they are building.
  const projectBox = el('div', 'dept-project', plate);
  if (project) {
    el('div', 'dept-project-name', projectBox,
      AMBITION[project.ambition].name + (project.efficiency ? ' · efficiency' : ''));
    el('div', 'dept-project-when', projectBox,
      project.roundsLeft === 1
        ? 'Delivers after the next round'
        : 'Delivers in ' + project.roundsLeft + ' rounds');
  } else {
    el('div', 'dept-project-idle', projectBox, 'Idle. Nothing in the wind tunnel.');
  }

  const actions = el('div', 'dept-actions', plate);
  const reason = el('div', 'mt-reason', plate);

  if (project) {
    actionButton(actions, {
      label: 'Cancel',
      price: 'half of $' + money(project.costUsd) + ' back · no cap back',
      check: { ok: true, overCap: false, reason: '' },
      onClick: () => { career.cancelProject(project.id); opts.onChange(); },
    });
  } else {
    for (const ambition of ['refinement', 'development', 'concept'] as Ambition[]) {
      const quote = career.quoteProject(id, ambition, false);
      actionButton(actions, {
        label: AMBITION[ambition].name,
        price: '$' + money(quote.costUsd) + ' · ' + quote.rounds + ' rnd · '
          + Math.round(quote.qcFailure * 100) + '% fail',
        check: career.canCommit(quote.costUsd, { underCap: true }),
        title: AMBITION[ambition].note + ' Delivers about +'
          + (quote.gain * 100).toFixed(1) + '% if it passes.',
        onClick: () => commit(
          (o) => career.startProject(id, ambition, false, o),
          reason, 'Commissioned.', opts.onChange),
      });
    }
    if (id === 'aero') {
      // The one place the player says which side of the aero trade they want.
      const quote = career.quoteProject('aero', 'development', true);
      actionButton(actions, {
        label: 'Efficiency',
        price: '$' + money(quote.costUsd) + ' · ' + quote.rounds + ' rnd · drag',
        check: career.canCommit(quote.costUsd, { underCap: true }),
        title: 'Takes drag off the car without adding downforce. Worth more at '
          + 'Monza than at Monaco, and it costs more because it is harder to find.',
        onClick: () => commit(
          (o) => career.startProject('aero', 'development', true, o),
          reason, 'Commissioned.', opts.onChange),
      });
    }
  }

  const more = el('div', 'dept-actions', plate);
  actionButton(more, {
    label: '+10 staff',
    price: 'wages, under the cap',
    check: { ok: true, overCap: false, reason: '' },
    small: true,
    onClick: () => commit(
      (o) => career.changeStaff(id, 10, o), reason, 'Ten more people.', opts.onChange),
  });
  actionButton(more, {
    label: '−10 staff',
    price: 'and they will feel it',
    check: { ok: true, overCap: false, reason: '' },
    small: true,
    onClick: () => commit(
      (o) => career.changeStaff(id, -10, o), reason,
      'Ten people let go. Morale is down.', opts.onChange),
  });
  if (dept.level < MAX_FACILITY_LEVEL) {
    const cost = facilityUpgradeCostUsd(dept.level);
    actionButton(more, {
      label: 'Build level ' + (dept.level + 1),
      price: '$' + money(cost),
      check: career.canCommit(cost, { underCap: true }),
      small: true,
      title: 'A better facility makes projects quicker and less likely to fail '
        + 'quality control, and the department will be pleased about it.',
      onClick: () => commit(
        (o) => career.upgradeFacility(id, o), reason, 'Ground broken.', opts.onChange),
    });
  }
}

/** One colour per department, so the plates are told apart before being read. */
const DEPARTMENT_COLOUR: Record<DepartmentId, string> = {
  aero: 'var(--sig-purple, #b18cf0)',
  chassis: 'var(--sig-green, #4fd48a)',
  powertrain: 'var(--sig-yellow, #f2c14e)',
};

// ===========================================================================
// The engine deal
// ===========================================================================

/**
 * Five suppliers, ranked on the numbers that reach the car.
 *
 * A ranked order, so it is `timingBoard` and not a grid of cards — the ranking
 * IS the information. Power and deployment are shown as percentages of the
 * reference car because that is literally what they are: `powerMult` multiplies
 * `icePowerW` and `ersMult` multiplies `ersPowerW` in `specForTeam`, and the
 * difference between the top and bottom of this list is worth about three
 * tenths of a second a lap.
 */
export function engineDeal(parent: HTMLElement, opts: TeamScreenOptions): void {
  const { career } = opts;
  const t = career.myTeam;
  if (!t) return;

  el('div', 'mt-why', parent,
    'Power and deployment multiply the spec the physics integrates, and the '
    + 'failure rate is the chance per race of not finishing. A manufacturer will '
    + 'not talk to a team whose reputation is too low, and some do not supply '
    + 'customers at all yet.');

  const board = timingBoard(parent, ['Supplier', 'Manufacturer', 'Power', 'Deploy', '']);
  const offers = career.engineOffers().slice()
    .sort((a, b) => (b.powerMult + b.ersMult) - (a.powerMult + a.ersMult));
  const reason = el('div', 'mt-reason', parent);

  for (const [i, o] of offers.entries()) {
    const current = o.unit.id === t.powerUnitId;
    const row = timingRow(board, {
      pos: String(i + 1),
      code: o.unit.shortName.slice(0, 3).toUpperCase(),
      name: o.unit.shortName,
      last: o.unit.shortName.toUpperCase(),
      note: o.reason
        + (o.costUsd > 0 ? ' · $' + money(o.costUsd) + ' a season' : ' · no fee')
        + ' · ' + (o.failureRate * 100).toFixed(1) + '% chance of a failure per race',
      figs: [
        { text: pct(o.powerMult), cls: o.powerMult >= 1.02 ? 'best' : '' },
        { text: pct(o.ersMult), cls: o.ersMult >= 1.03 ? 'best' : '' },
      ],
      // SIX CHARACTERS AT THE OUTSIDE. The tag cell in `timingRow` is sized for
      // a status word — P, DNF, PIT — and an eight-character string in it runs
      // straight under the figure column beside it.
      tag: current
        ? { text: 'YOURS', cls: 'green' }
        : !o.available
          ? { text: 'LOCKED' }
          : { text: o.costUsd > 0 ? '$' + Math.round(o.costUsd / 1e6) + 'M' : 'WORKS' },
      index: i,
      onClick: current || !o.available ? undefined : () => {
        const r = career.signPowerUnit(o.unit.id);
        reason.textContent = r.ok
          ? `Signed with ${o.unit.shortName}. It is in the car from the next session.`
          : r.reason;
        reason.classList.toggle('ok', r.ok);
        if (r.ok) opts.onChange();
      },
    });
    if (current) row.classList.add('is-current');
    if (!o.available) row.classList.add('is-locked');
  }
}

// ===========================================================================
// The driver market — MOVED, not copied
// ===========================================================================
//
// This file used to hold a `driverMarket` of its own: twelve `timingRow`s with
// a column headed "Pace" printing `skill * 100`. Three things were wrong with
// it and only the third mattered.
//
//   · It is not `reference/target/88.png`, which is what issue #77 asks for.
//   · `skill * 100` is not a rating. It was one of the four sites
//     `probe:ratings` §6 found where a screen invented its own figure out of a
//     raw driver attribute, and no two of the four agreed with each other.
//   · Building the reference's table BESIDE it would have left the game with
//     two driver markets disagreeing about what a driver is worth, which is
//     `TIER_INFO.carPace` and the pit panel's four derivations of one fact in
//     a third place.
//
// So there is one market now — `src/ui/DriverMarketScreen.ts`, reading
// `Career.market()` — and it does both jobs: a driver career opens it to see
// where they stand, a My Team career opens the same screen and signs the
// second car from it. `probe:smoke`'s required route for `Driver market` now
// names the screen id `driver-market` rather than `team-hq`.

// ===========================================================================
// The identity block
// ===========================================================================

/** The team's name, mark and colours, as one plate. Used at the top of the HQ. */
export function teamIdentity(parent: HTMLElement, career: Career): void {
  const t = career.myTeam;
  const team = career.myTeamRecord();
  if (!t || !team) return;

  const block = el('div', 'mt-identity', parent);
  block.style.setProperty('--team', hex(t.colour));

  const markHost = el('div', 'mt-identity-mark', block);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 76;
  markHost.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (t.liveryMark >= 0) {
      drawMark(ctx, 38, 38, 72, t.liveryMark, hex(t.colour), hex(t.accent));
    } else {
      ctx.fillStyle = hex(t.colour);
      ctx.beginPath();
      ctx.arc(38, 38, 36, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const text = el('div', 'mt-identity-text', block);
  el('div', 'mt-identity-name', text, t.name);
  el('div', 'mt-identity-sub', text,
    t.baseCountry + ' · ' + upgradeSummary(team.upgrades));
  el('div', 'mt-identity-code', block, t.code);
}

// ===========================================================================
// Small builders
// ===========================================================================

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function fig(parent: HTMLElement, label: string, value: string, meter?: number): void {
  const f = el('div', 'dept-fig', parent);
  el('div', 'dept-fig-label', f, label);
  el('div', 'dept-fig-value', f, value);
  if (meter !== undefined) {
    const m = el('div', 'dept-meter', f);
    const s = el('span', meter >= 60 ? 'good' : meter >= 30 ? 'warn' : 'bad', m);
    s.style.width = Math.max(0, Math.min(100, meter)) + '%';
  }
}

interface ActionSpec {
  label: string;
  price: string;
  check: { ok: boolean; overCap: boolean; reason: string };
  onClick: () => void;
  title?: string;
  small?: boolean;
}

/**
 * Runs a commitment, and asks before breaking the cost cap.
 *
 * THE CONFIRMATION NAMES THE PENALTY. A dialog that says "are you sure?" is a
 * dialog people click through; one that says "40 constructors' points and no
 * development for the first three rounds of next season" is a decision. The
 * career refuses an over-cap commitment outright unless `allowBreach` is
 * passed, so this is the only route past it and there is no way to breach the
 * cap by accident.
 */
function commit(
  run: (opts: { allowBreach?: boolean }) => { ok: boolean; reason: string; needsConfirmation?: boolean },
  reason: HTMLElement, success: string, onChange: () => void,
): void {
  let r = run({});
  if (!r.ok && r.needsConfirmation) {
    if (!confirm(r.reason + '\n\nCommit anyway?')) {
      reason.textContent = 'Left inside the cap.';
      reason.classList.remove('ok');
      return;
    }
    r = run({ allowBreach: true });
  }
  reason.textContent = r.ok ? success : r.reason;
  reason.classList.toggle('ok', r.ok);
  if (r.ok) onChange();
}

function actionButton(parent: HTMLElement, spec: ActionSpec): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mt-btn' + (spec.check.overCap ? ' over' : '') + (spec.small ? ' small' : '');
  b.disabled = !spec.check.ok;
  if (spec.title) b.title = spec.title;
  else if (!spec.check.ok) b.title = spec.check.reason;
  b.innerHTML = '<b>' + escapeHtml(spec.label) + '</b>'
    + '<i>' + escapeHtml(spec.check.overCap ? 'OVER THE CAP · ' + spec.price : spec.price) + '</i>';
  b.addEventListener('click', spec.onClick);
  parent.appendChild(b);
  return b;
}

/** Dollars as millions to one decimal, which is the only unit this mode uses. */
export function money(usd: number): string {
  const m = usd / 1e6;
  return (m < 0 ? '−' : '') + Math.abs(m).toFixed(1) + 'M';
}

function pct(mult: number): string {
  return (mult * 100).toFixed(1) + '%';
}
