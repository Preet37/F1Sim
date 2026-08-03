/**
 * Does a My Team career hold up over ten seasons, ten times over?
 *
 * WHY THIS EXISTS. `probe:season` already proves the world stays legal across a
 * hundred career-years, and it has caught real structural rot nobody would have
 * found by playing — empty seats after a poach, a driver promoted twice in one
 * winter, whole cohorts culled at once. My Team adds a second machine on top of
 * that one: a budget, a cost cap, a factory, three departments, an engine
 * contract and a second driver, all of which mutate the same world. Every one of
 * those is a place a career can quietly go wrong in its fourth season, three
 * hours into somebody's evening.
 *
 * The invariants, and why each one is here:
 *
 *   1. THE GRID SURVIVES A TWELFTH TEAM. Twenty-four cars, twelve teams, two
 *      drivers each, every season, in Formula 1 — and Formula 2 and Formula 3
 *      still intact beneath it. The player's entry is a new team in a world the
 *      transfer market runs over every winter, which is exactly the sort of
 *      thing that ends with somebody's second car quietly vanishing.
 *   2. THE BOOKS BALANCE. Cash is reconstructed from the itemised ledger every
 *      season and must agree with the balance the career is carrying. This is
 *      the only way an accounting bug is ever found: a career that leaks a
 *      million dollars a season looks completely normal for six seasons.
 *   3. THE CAP BINDS. A career that always spends maximally must actually be
 *      stopped by the cost cap rather than by running out of ideas, and a
 *      career that deliberately breaches must receive the penalty.
 *   4. EVERY DELIVERED UPGRADE MOVES A `TeamPerformance` FIELD, and fifty of
 *      them do not produce a runaway car. This is the assertion the whole mode
 *      exists to pass: if a project can be commissioned, paid for and delivered
 *      without `specForTeam` producing a different `VehicleSpec`, the management
 *      layer is a spreadsheet.
 *   5. MORALE HAS A MECHANICAL CONSEQUENCE. A department at 0 measurably costs
 *      more and fails quality control more often than one at 100, over many
 *      trials — not as a displayed number.
 *   6. THE ENGINE CHOICE REACHES THE CAR. Signing the most powerful unit
 *      produces more `icePowerW` than signing the least, through
 *      `performanceOf` and `specForTeam`.
 *   7. DEVELOPING WORKS. Over many careers, a team that develops climbs the
 *      constructors' table against one that never does.
 *
 * Run: npm run probe:myteam
 */

import { Rng } from '../src/core/MathUtils';
import { Career } from '../src/career/Career';
import {
  performanceOf, UPGRADE_LIMIT, type CareerWorld,
} from '../src/career/World';
import { seasonComplete, simulateRound, sortedStandings } from '../src/career/Season';
import { specForTeam } from '../src/physics/VehicleSpec';
import { getTeam } from '../src/data/teams';
import {
  AMBITION, COST_CAP_USD, DEPARTMENT_IDS, STARTING_BUDGET_USD, capSpent,
  ledgerExpenditure, ledgerIncome, projectCostUsd, qcFailureChance,
  type Ambition, type DepartmentId,
} from '../src/career/MyTeam';
import { TIER_ORDER } from '../src/data/roster';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

const seen = new Map<string, number>();
function checkOnce(ok: boolean, kind: string, msg: string): void {
  if (ok) return;
  const n = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, n);
  if (n <= 3) fail(msg);
  else if (n === 4) fail(`${kind}: ...and more`);
}

const CAREERS = 10;
const SEASONS = 10;

/** Founds a team from a seed, with a chosen supplier and a chosen team-mate. */
function found(seed: number, opts: { powerUnitId?: string; agent?: number } = {}): Career {
  const agents = Career.freeAgentsFor(seed);
  return Career.createMyTeam({
    firstName: 'Probe', lastName: 'Owner', nationality: 'United Kingdom',
    raceNumber: 47, seed,
    team: {
      name: 'Probe Racing', shortName: 'Probe', code: 'PRB',
      baseCountry: 'United Kingdom',
      colour: 0x0f4d35, accent: 0xe0a72c, trim: 0xe8e0d0,
      liveryFamily: 'halo', liveryFinish: 'satin', liveryMark: 3,
    },
    teammate: agents[opts.agent ?? 2],
    powerUnitId: opts.powerUnitId ?? 'redbull-ford',
  });
}

// ---------------------------------------------------------------------------
// 1. The grid survives a twelfth team
// ---------------------------------------------------------------------------

function checkGrid(world: CareerWorld, where: string): void {
  for (const tier of TIER_ORDER) {
    const state = world.tiers[tier];
    const expectedTeams = tier === 'F1' ? 12 : tier === 'F2' ? 11 : 10;
    checkOnce(state.teams.length === expectedTeams, 'team-count',
      `${where}: ${tier} has ${state.teams.length} teams, expected ${expectedTeams}`);

    const perTeam = new Map<string, number>();
    for (const d of state.drivers) {
      if (d.reserve || d.retired) continue;
      perTeam.set(d.teamId, (perTeam.get(d.teamId) ?? 0) + 1);
    }
    for (const t of state.teams) {
      const n = perTeam.get(t.id) ?? 0;
      checkOnce(n === 2, 'team-seats',
        `${where}: ${tier}/${t.id} has ${n} race drivers, expected 2`);
    }

    const ids = new Set<string>();
    for (const d of state.drivers) {
      checkOnce(!ids.has(d.id), 'duplicate-driver',
        `${where}: ${tier} lists ${d.id} twice`);
      ids.add(d.id);
    }
  }
}

/** Every multiplier still inside a sane envelope after a career of building. */
function checkEnvelope(career: Career, where: string): void {
  const team = career.myTeamRecord();
  if (!team) { fail(`${where}: the player's team is not in the world`); return; }
  const p = performanceOf(team);
  for (const [k, v] of Object.entries(p)) {
    checkOnce(Number.isFinite(v) && v > 0, 'perf-finite',
      `${where}: performance.${k} = ${v}`);
  }
  // Generous, and deliberately so: this is a guard against a runaway, not a
  // balance opinion. A car 40% beyond the reference in any single term is not a
  // strong car, it is a bug.
  checkOnce(p.powerMult < 1.4, 'runaway-power', `${where}: powerMult ${p.powerMult.toFixed(3)}`);
  checkOnce(p.downforceMult < 1.4, 'runaway-df', `${where}: downforceMult ${p.downforceMult.toFixed(3)}`);
  checkOnce(p.mechanicalGripMult < 1.4, 'runaway-grip', `${where}: gripMult ${p.mechanicalGripMult.toFixed(3)}`);
  checkOnce(p.dragMult > 0.5, 'runaway-drag', `${where}: dragMult ${p.dragMult.toFixed(3)}`);
  checkOnce(p.pitCrewTimeS >= 1.9, 'runaway-pit', `${where}: pitCrewTimeS ${p.pitCrewTimeS.toFixed(2)}`);
  checkOnce(p.failureRate >= 0, 'runaway-fail', `${where}: failureRate ${p.failureRate}`);

  const up = team.upgrades;
  if (up) {
    for (const [k, limit] of Object.entries(UPGRADE_LIMIT)) {
      const v = up[k as keyof typeof up];
      checkOnce(v <= limit + 1e-9, 'upgrade-limit',
        `${where}: upgrades.${k} = ${v.toFixed(4)} past its ${limit} ceiling`);
    }
  }
}

// ---------------------------------------------------------------------------
// The careers
// ---------------------------------------------------------------------------

let projectsStarted = 0;
let projectsDelivered = 0;
let projectsFailedQc = 0;
let capBoundSeasons = 0;
let breaches = 0;

for (let c = 0; c < CAREERS; c++) {
  const seed = 4000 + c * 7919;
  const career = found(seed);
  const rng = new Rng(seed ^ 0x2ab41f09);

  check(career.grid().length === 24,
    `career ${c}: the Formula 1 grid is ${career.grid().length} cars, expected 24`);
  checkGrid(career.world, `career ${c} season 0`);

  const openingCash = career.myTeam!.cashUsd;
  check(openingCash < STARTING_BUDGET_USD,
    `career ${c}: the opening bill was never charged — still $${openingCash}`);

  for (let s = 0; s < SEASONS; s++) {
    const where = `career ${c} season ${s} (${career.season.year})`;
    const t = career.myTeam!;

    // Spend the way somebody trying to build a team would: commission whatever
    // the cap and the bank will carry, in every department, all season.
    let guard = 0;
    const cashAtStart = t.cashUsd;
    const ledgerAtStart = { ...t.ledger };

    while (!seasonComplete(career.world, career.season, career.tier) && guard++ < 40) {
      for (const dept of DEPARTMENT_IDS) {
        // Biggest first, so the cap is genuinely tested rather than nibbled at.
        for (const a of ['concept', 'development', 'refinement'] as Ambition[]) {
          const r = career.startProject(dept, a);
          if (r.ok) { projectsStarted++; break; }
        }
      }
      const delivered = career.recordPlayerRound(
        simulateRound(career.world, career.season, career.tier, rng));
      for (const d of delivered) {
        projectsDelivered++;
        if (!d.passed) projectsFailedQc++;
      }
      checkEnvelope(career, where + ' mid-season');
    }

    // --- 2. The books balance -------------------------------------------
    //
    // Reconstructed rather than trusted: cash at the end of the season must be
    // cash at the start plus everything the ledger says came in, less
    // everything it says went out. Cancelled projects refund half, so the
    // reconstruction is a bound rather than an equality — but a career that
    // leaks money fails it in one season, and a career that mints it fails the
    // other side.
    const inSeason = ledgerIncome(t.ledger) - ledgerIncome(ledgerAtStart);
    const outSeason = ledgerExpenditure(t.ledger) - ledgerExpenditure(ledgerAtStart);
    const expected = cashAtStart + inSeason - outSeason;
    checkOnce(Math.abs(t.cashUsd - expected) < 1_000_000, 'ledger-balance',
      `${where}: cash is $${(t.cashUsd / 1e6).toFixed(2)}M, the ledger says `
      + `$${(expected / 1e6).toFixed(2)}M`);

    // --- 3. The cap binds ------------------------------------------------
    const committed = capSpent(t.ledger);
    checkOnce(committed <= COST_CAP_USD * 1.06, 'cap-blown',
      `${where}: committed $${(committed / 1e6).toFixed(1)}M against a `
      + `$${(COST_CAP_USD / 1e6).toFixed(0)}M cap without being stopped`);
    if (career.capHeadroomUsd() < 12_000_000) capBoundSeasons++;
    if (committed > COST_CAP_USD) breaches++;

    checkEnvelope(career, where + ' end of season');

    const report = career.endSeason();
    check(report.team !== null, `${where}: no team report from the off-season`);
    if (report.team) {
      checkOnce(report.team.prizeUsd > 0, 'no-prize',
        `${where}: the constructors' prize was $${report.team.prizeUsd}`);
      checkOnce(report.team.constructorPosition >= 1 && report.team.constructorPosition <= 12,
        'prize-position',
        `${where}: constructors' position ${report.team.constructorPosition}`);
    }

    // The new season starts with a fresh cap and a charged bill.
    checkOnce(capSpent(career.myTeam!.ledger) > 0, 'no-opening-bill',
      `${where}: the next season's fixed bill was not charged`);
    checkOnce(career.myTeam!.projects.length === 0, 'projects-carried',
      `${where}: unfinished projects survived the off-season`);

    checkGrid(career.world, where + ' (after the off-season)');
    check(career.grid().length === 24,
      `${where}: the grid came out of the off-season with ${career.grid().length} cars`);
  }
}

console.log(`${CAREERS} My Team careers x ${SEASONS} seasons`);
console.log(`projects: ${projectsStarted} commissioned, ${projectsDelivered} delivered, `
  + `${projectsFailedQc} failed QC (${(projectsFailedQc / Math.max(1, projectsDelivered) * 100).toFixed(1)}%)`);
console.log(`cap: ${capBoundSeasons} seasons ran within $12M of the ceiling, ${breaches} breached it`);

/**
 * A LOWER BOUND, NOT A TARGET.
 *
 * Each department holds one project at a time and a concept takes eight or nine
 * rounds of an eleven-round season, so the ceiling for a team that only ever
 * commissions concepts — which is what this probe does, deliberately, to test
 * the cap — is three deliveries a season. The gap between what is commissioned
 * and what is delivered is projects written off unfinished at the end of a
 * season, which is real and is why the screen prints how many rounds are left.
 *
 * What this asserts is only that the factory is not stalled: at least one
 * project a season reaches the car. The rate itself is printed rather than
 * asserted, so a balance change shows up as a number to look at rather than as
 * a red test.
 */
check(projectsDelivered > CAREERS * SEASONS,
  `only ${projectsDelivered} projects delivered across ${CAREERS * SEASONS} seasons — `
  + 'the factory is stalled');
console.log(`written off unfinished at a season boundary: `
  + `${projectsStarted - projectsDelivered} of ${projectsStarted}`);
check(projectsFailedQc > 0,
  'no project ever failed quality control, so the mechanic is not reachable');
check(breaches === 0,
  `${breaches} seasons crossed the cost cap without a confirmation — the gate is open`);

// ---------------------------------------------------------------------------
// 3b. The cap binds a team that can afford to ignore it
// ---------------------------------------------------------------------------
//
// SEPARATE FROM THE CAREERS ABOVE, AND IT HAS TO BE. A new constructor is
// limited by CASH for its first seasons — that is the intended shape of the
// mode, and it is why the ten careers above almost never touch the ceiling. The
// question the cap has to answer is what happens to a team that has money: it
// must be stopped, and it must be stopped by the cap and not by the bank.
{
  const career = found(31337);
  career.myTeam!.cashUsd = 2_000_000_000;
  let commissioned = 0;
  let refusal = '';
  let confirmable = false;
  for (let i = 0; i < 60; i++) {
    let placed = false;
    for (const dept of DEPARTMENT_IDS) {
      const r = career.startProject(dept, 'concept');
      if (r.ok) { commissioned++; placed = true; career.myTeam!.projects = []; }
      else if (r.needsConfirmation) { refusal = r.reason; confirmable = true; }
    }
    if (!placed) break;
  }
  check(confirmable,
    'a team with two billion dollars was never stopped by the cost cap');
  check(capSpent(career.myTeam!.ledger) <= COST_CAP_USD,
    `the cap was crossed anyway: $${(capSpent(career.myTeam!.ledger) / 1e6).toFixed(1)}M`);
  console.log(`rich team: ${commissioned} concepts before the cap said no — ${refusal}`);
}

// ---------------------------------------------------------------------------
// 4. A delivered upgrade changes the car the physics builds
// ---------------------------------------------------------------------------

{
  const career = found(99);
  const team = career.myTeamRecord()!;
  const before = specForTeam(performanceOf(team));

  // Force a delivery: commission, then clear the quality-control roll so this
  // measures the mechanism rather than the dice.
  const started = career.startProject('aero', 'concept');
  check(started.ok, 'an aero concept could not be commissioned from a fresh team: ' + started.reason);
  if (started.project) started.project.willFailQc = false;
  const chassis = career.startProject('chassis', 'concept');
  if (chassis.project) chassis.project.willFailQc = false;
  const power = career.startProject('powertrain', 'concept');
  if (power.project) power.project.willFailQc = false;

  const rng = new Rng(1234);
  for (let i = 0; i < 12 && !seasonComplete(career.world, career.season, career.tier); i++) {
    career.recordPlayerRound(simulateRound(career.world, career.season, career.tier, rng));
  }

  const after = specForTeam(performanceOf(team));
  check(after.clBase > before.clBase,
    `an aero project delivered and clBase did not move: ${before.clBase} -> ${after.clBase}`);
  check(after.cdBase > before.cdBase,
    'downforce arrived without any drag, so the aero trade-off is not modelled');
  check(after.baseMu > before.baseMu,
    `a chassis project delivered and baseMu did not move: ${before.baseMu} -> ${after.baseMu}`);
  check(after.icePowerW > before.icePowerW,
    `a powertrain project delivered and icePowerW did not move: `
    + `${before.icePowerW} -> ${after.icePowerW}`);

  // AND IT REACHES `getTeam`, which is what `RaceEngine` actually calls. A world
  // mutated without the overlay being reinstalled is an upgrade the physics
  // never sees, and that is the exact bug this whole design exists to prevent.
  const overlay = getTeam(team.id).performance;
  check(Math.abs(overlay.downforceMult - performanceOf(team).downforceMult) < 1e-9,
    'the grid overlay is stale: getTeam() disagrees with performanceOf() after an upgrade');

  console.log('one concept each: clBase '
    + before.clBase.toFixed(3) + ' -> ' + after.clBase.toFixed(3)
    + ', icePowerW ' + Math.round(before.icePowerW) + ' -> ' + Math.round(after.icePowerW)
    + ', baseMu ' + before.baseMu.toFixed(4) + ' -> ' + after.baseMu.toFixed(4));
}

// ---------------------------------------------------------------------------
// 5. Morale has a mechanical consequence
// ---------------------------------------------------------------------------

{
  const spec = AMBITION.concept;
  const cheap = projectCostUsd(spec, 'aero', 100, false);
  const dear = projectCostUsd(spec, 'aero', 0, false);
  check(dear > cheap * 1.5,
    `a department at 0 morale charges $${(dear / 1e6).toFixed(1)}M against `
    + `$${(cheap / 1e6).toFixed(1)}M at 100 — not enough of a difference to be a mechanic`);

  const happy = qcFailureChance(spec, { level: 3, staff: 120, morale: 100 });
  const sullen = qcFailureChance(spec, { level: 3, staff: 120, morale: 0 });
  check(sullen > happy * 1.8,
    `quality control fails ${(sullen * 100).toFixed(1)}% of the time at 0 morale against `
    + `${(happy * 100).toFixed(1)}% at 100 — morale is not doing enough`);

  // And a facility genuinely helps.
  const shed = qcFailureChance(spec, { level: 1, staff: 120, morale: 50 });
  const palace = qcFailureChance(spec, { level: 5, staff: 120, morale: 50 });
  check(palace < shed * 0.7,
    `a level 5 facility fails ${(palace * 100).toFixed(1)}% against a level 1's `
    + `${(shed * 100).toFixed(1)}%`);

  console.log(`morale: cost $${(cheap / 1e6).toFixed(1)}M at 100 vs $${(dear / 1e6).toFixed(1)}M at 0; `
    + `QC ${(happy * 100).toFixed(0)}% vs ${(sullen * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
// 6. The engine choice reaches the car
// ---------------------------------------------------------------------------

{
  const strong = found(77, { powerUnitId: 'ferrari-pu' });
  const weak = found(77, { powerUnitId: 'audi-pu' });
  // Audi is works-only until 2029, so a fresh team cannot legally hold it — but
  // the point of the measurement is the multiplier chain, and founding with a
  // supplier bypasses the availability gate the way the create screen would not.
  const a = specForTeam(performanceOf(strong.myTeamRecord()!));
  const b = specForTeam(performanceOf(weak.myTeamRecord()!));
  check(a.icePowerW > b.icePowerW,
    `Ferrari produced ${Math.round(a.icePowerW)}W against Audi's ${Math.round(b.icePowerW)}W`);
  check(performanceOf(strong.myTeamRecord()!).failureRate
    !== performanceOf(weak.myTeamRecord()!).failureRate,
    'two different power units produced the same failure rate');
  console.log(`engine: Ferrari ${Math.round(a.icePowerW / 1000)}kW vs `
    + `Audi ${Math.round(b.icePowerW / 1000)}kW`);

  // Signing a new deal mid-career has to move the car too, and has to reach the
  // overlay `RaceEngine` reads.
  const before = getTeam('myteam').performance.powerMult;
  weak.state.narrative.reputation = 90;
  weak.state.season.year = 2030;
  const r = weak.signPowerUnit('ferrari-pu');
  check(r.ok, 'a reputable team in 2030 could not sign Ferrari: ' + r.reason);
  const after = getTeam('myteam').performance.powerMult;
  check(after > before,
    `signing a stronger engine did not change the overlay: ${before} -> ${after}`);
}

// ---------------------------------------------------------------------------
// 7. Developing works
// ---------------------------------------------------------------------------

{
  const REPS = 8;
  let developedPoints = 0;
  let idlePoints = 0;

  for (let i = 0; i < REPS; i++) {
    for (const develop of [true, false]) {
      const career = found(2000 + i * 331);
      const rng = new Rng(7000 + i);
      for (let s = 0; s < 4; s++) {
        let guard = 0;
        while (!seasonComplete(career.world, career.season, career.tier) && guard++ < 40) {
          if (develop) {
            for (const dept of DEPARTMENT_IDS) {
              for (const a of ['development', 'refinement'] as Ambition[]) {
                if (career.startProject(dept as DepartmentId, a).ok) break;
              }
            }
          }
          career.recordPlayerRound(
            simulateRound(career.world, career.season, career.tier, rng));
        }
        if (s < 3) career.endSeason();
      }
      const points = career.season.tiers.F1.constructorPoints.myteam ?? 0;
      if (develop) developedPoints += points; else idlePoints += points;
    }
  }

  console.log(`development: ${(developedPoints / REPS).toFixed(1)} constructors' points in the `
    + `fourth season against ${(idlePoints / REPS).toFixed(1)} for a team that never built anything`);
  check(developedPoints > idlePoints,
    `a team that developed for four seasons scored ${developedPoints} against an idle team's `
    + `${idlePoints} — building the car is not worth doing`);
}

// ---------------------------------------------------------------------------
// 8. A deliberate breach is actually punished
// ---------------------------------------------------------------------------

{
  const career = found(555);
  const t = career.myTeam!;
  // Straight past the cap, deliberately, the way the confirmation dialog lets a
  // player do it. Cash is topped up so the refusal is the CAP and not the bank.
  t.cashUsd = 500_000_000;
  let guard = 0;
  while (capSpent(t.ledger) <= COST_CAP_USD * 1.10 && guard++ < 200) {
    // `allowBreach`, which is what the screen passes after a confirmation
    // naming the penalty. Without it the career refuses, which is the subject of
    // the check above rather than of this one.
    const r = career.startProject('aero', 'concept', false, { allowBreach: true });
    if (!r.ok) { career.cancelProject(t.projects[0]?.id ?? ''); continue; }
    // Deliver instantly so the department is free to take another.
    t.projects = [];
  }
  check(capSpent(t.ledger) > COST_CAP_USD,
    'a career that spent without limit never got past the cap');

  const pointsBefore = career.season.tiers.F1.constructorPoints.myteam ?? 0;
  const rng = new Rng(4242);
  let g = 0;
  while (!seasonComplete(career.world, career.season, career.tier) && g++ < 40) {
    career.recordPlayerRound(simulateRound(career.world, career.season, career.tier, rng));
  }
  const report = career.endSeason();
  check(report.team!.penalty.severity !== 'none',
    'a career that spent 10% past the cap was not penalised');
  check(report.team!.penalty.pointsDeducted > 0,
    'a cap breach cost no constructors’ points');
  check(career.myTeam!.developmentBanRounds > 0,
    'a major cap breach carried no development ban into the next season');
  console.log('breach: ' + report.team!.penalty.summary
    + ` (constructors' points before the audit: ${pointsBefore})`);

  // And the ban actually stops a project being commissioned.
  const banned = career.startProject('aero', 'refinement');
  check(!banned.ok, 'a development ban did not stop a project being commissioned');
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:myteam OK');
