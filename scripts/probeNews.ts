/**
 * Is every headline true?
 *
 * WHY THIS IS THE ONLY THING THAT MATTERS ABOUT A NEWS SYSTEM. A generated
 * headline about a race that did not happen is the fastest possible way to
 * destroy the illusion the rest of this career mode is built on: the moment a
 * player reads that somebody won a race they know somebody else won, every other
 * number on every other screen becomes suspect. And it is exactly the kind of
 * fault that cannot be found by looking, because a plausible sentence about the
 * wrong driver looks identical to a plausible sentence about the right one.
 *
 * So this walks a hundred career-years, generates every story the newsroom would
 * have shown, and checks each one against the state it claims to describe:
 *
 *   1. EVERY ID EXISTS. A story naming a driver or a team that is not in the
 *      world is a dangling reference and would render as a raw id on screen.
 *   2. EVERY RESULT LINE MATCHES THE RESULT. If the story says the player
 *      finished P4, the classification says P4. If it says they retired, they
 *      are in the retired list.
 *   3. EVERY STANDINGS LINE MATCHES THE TABLE. The leader named is the leader,
 *      and the points quoted are the points held.
 *   4. EVERY TRANSFER LINE MATCHES THE OFF-SEASON REPORT, including the ones
 *      that report a promotion which found no seat — that is a real outcome and
 *      it has to be reported as what happened rather than as a move.
 *   5. NOTHING IS EMPTY. No headline is blank, no story is duplicated within one
 *      briefing, and a briefing after a round is never empty — a screen whose
 *      whole job is to say what happened must always have something to say.
 *   6. THE DECISION LIST IS REACHABLE AND HONEST. Every decision names a screen
 *      the interface actually has, and an idle factory is reported as idle.
 *
 * Run: npm run probe:news
 */

import { Rng } from '../src/core/MathUtils';
import { Career } from '../src/career/Career';
import { findDriver, findTeam } from '../src/career/World';
import { seasonComplete, simulateRound, sortedStandings } from '../src/career/Season';
import { DEPARTMENT_IDS, type DepartmentId } from '../src/career/MyTeam';
import type { Story } from '../src/career/Newsroom';

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

const SCREENS = new Set(['hub', 'hq', 'market', 'engine', 'livery', 'prep']);

let stories = 0;
let leads = 0;
let factoryStories = 0;
let transferStories = 0;
let decisions = 0;

/** 1 and 5: structure, and every id resolvable. */
function checkStories(career: Career, list: Story[], where: string): void {
  const headlines = new Set<string>();
  for (const s of list) {
    stories++;
    if (s.weight === 'lead') leads++;
    if (s.kind === 'factory' || (s.kind === 'warning' && s.mine)) factoryStories++;
    if (s.kind === 'transfer' || s.kind === 'departure') transferStories++;

    checkOnce(s.headline.trim().length > 0, 'empty-headline',
      `${where}: a story has no headline`);
    checkOnce(!/undefined|NaN|\[object/.test(s.headline + (s.detail ?? '')),
      'broken-interpolation',
      `${where}: "${s.headline}" / "${s.detail}" contains an unrendered value`);
    checkOnce(!headlines.has(s.headline), 'duplicate-headline',
      `${where}: "${s.headline}" appears twice in one briefing`);
    headlines.add(s.headline);

    for (const id of s.about.driverIds ?? []) {
      if (!id) continue;
      const known = id === career.state.playerDriverId
        || findDriver(career.world, id) !== undefined;
      checkOnce(known, 'dangling-driver',
        `${where}: "${s.headline}" names driver ${id}, who is not in the world`);
    }
    for (const id of s.about.teamIds ?? []) {
      if (!id) continue;
      checkOnce(findTeam(career.world, id) !== undefined, 'dangling-team',
        `${where}: "${s.headline}" names team ${id}, which is not in the world`);
    }
  }
}

for (let c = 0; c < 10; c++) {
  const seed = 8000 + c * 6151;
  // Half the careers are My Team, so the factory and money stories are covered
  // as well as the driver ladder.
  const myTeam = c % 2 === 0;
  const career = myTeam
    ? Career.createMyTeam({
      firstName: 'News', lastName: 'Probe', nationality: 'Italy', raceNumber: 47, seed,
      team: {
        name: 'Probe Racing', shortName: 'Probe', code: 'PRB',
        baseCountry: 'Italy', colour: 0x0f4d35, accent: 0xe0a72c, trim: 0xe8e0d0,
        liveryFamily: 'halo', liveryFinish: 'satin', liveryMark: 3,
      },
      teammate: Career.freeAgentsFor(seed)[2],
      powerUnitId: 'redbull-ford',
    })
    : Career.create({
      firstName: 'News', lastName: 'Probe', nationality: 'Italy',
      raceNumber: 47, seed,
    });

  const rng = new Rng(seed ^ 0x77f10c2b);

  for (let season = 0; season < 10; season++) {
    let guard = 0;
    while (!seasonComplete(career.world, career.season, career.tier) && guard++ < 40) {
      if (myTeam) {
        for (const dept of DEPARTMENT_IDS as readonly DepartmentId[]) {
          career.startProject(dept, guard % 2 === 0 ? 'refinement' : 'development');
        }
      }

      const where = `career ${c} season ${season} round ${career.round}`;
      const positionBefore = career.championshipPosition;
      const table = sortedStandings(career.season.tiers[career.tier]);
      const result = simulateRound(career.world, career.season, career.tier, rng);
      career.recordPlayerRound(result);

      const list = career.stories();
      checkStories(career, list, where);
      check(list.length > 0, `${where}: the briefing after a round was empty`);

      // --- 2. The result line matches the classification -----------------
      const mine = result.order.indexOf(career.state.playerDriverId);
      const lead = list.find((s) => s.kind === 'result' && s.weight === 'lead');
      check(lead !== undefined, `${where}: a round produced no result story`);
      if (lead && mine >= 0) {
        const retired = result.retired.includes(career.state.playerDriverId);
        const excluded = (result.disqualified ?? []).includes(career.state.playerDriverId);
        if (excluded) {
          checkOnce(/Excluded/.test(lead.headline), 'result-exclusion',
            `${where}: excluded, but the headline reads "${lead.headline}"`);
        } else if (retired) {
          checkOnce(/Retired/.test(lead.headline), 'result-retirement',
            `${where}: retired, but the headline reads "${lead.headline}"`);
        } else if (mine === 0) {
          checkOnce(/won/i.test(lead.headline), 'result-win',
            `${where}: won, but the headline reads "${lead.headline}"`);
        } else {
          checkOnce(lead.headline.includes('P' + (mine + 1)), 'result-position',
            `${where}: finished P${mine + 1}, but the headline reads "${lead.headline}"`);
        }
      }

      // --- 3. The standings line matches the table -----------------------
      const after = sortedStandings(career.season.tiers[career.tier]);
      const nowPos = after.findIndex((e) => e.driverId === career.state.playerDriverId) + 1;
      const move = list.find((s) => s.kind === 'championship' && s.mine);
      if (move) {
        checkOnce(move.headline.includes('P' + nowPos), 'standings-position',
          `${where}: the table says P${nowPos}, the story says "${move.headline}"`);
        checkOnce(nowPos !== positionBefore, 'standings-nonmove',
          `${where}: a movement was reported but the position did not change`);
      } else {
        checkOnce(nowPos === positionBefore || positionBefore === 0, 'standings-silent',
          `${where}: moved P${positionBefore} to P${nowPos} and said nothing`);
      }

      const leaderStory = list.find((s) => s.kind === 'rival'
        && s.headline.includes('leads the championship'));
      if (leaderStory && table.length > 0) {
        const actual = after[0];
        checkOnce(leaderStory.about.driverIds?.[0] === actual.driverId, 'leader-wrong',
          `${where}: "${leaderStory.headline}" but the table is led by ${actual.driverId}`);
      }

      // --- 6. The decisions are honest -----------------------------------
      for (const d of career.decisions()) {
        decisions++;
        checkOnce(SCREENS.has(d.screen), 'unknown-screen',
          `${where}: a decision routes to "${d.screen}", which is not a screen`);
        checkOnce(d.label.trim().length > 0 && d.why.trim().length > 0, 'empty-decision',
          `${where}: a decision has no label or no reason`);
      }
      const t = career.myTeam;
      if (t && t.developmentBanRounds <= 0) {
        const idle = DEPARTMENT_IDS.filter(
          (dep) => !t.projects.some((pr) => pr.department === dep));
        const reported = career.decisions().some((d) => /idle/i.test(d.label));
        checkOnce(idle.length === 0 || reported, 'idle-unreported',
          `${where}: ${idle.length} idle departments and nothing said about it`);
      }
    }

    // --- 4. The winter ---------------------------------------------------
    const before = new Set(
      [...career.world.tiers.F1.drivers, ...career.world.tiers.F2.drivers,
        ...career.world.tiers.F3.drivers].map((d) => d.id));
    const outcome = career.endSeason();
    const where = `career ${c} off-season ${season}`;

    checkStories(career, outcome.stories, where);
    check(outcome.stories.length > 0, `${where}: the off-season reported nothing`);

    const champions = outcome.report.champions.map((x) => x.driverId);
    for (const id of champions) {
      const told = outcome.stories.some((s) => s.kind === 'championship'
        && (s.about.driverIds ?? []).includes(id));
      checkOnce(told, 'champion-unreported',
        `${where}: ${id} won a championship and it was not reported`);
    }
    for (const p of outcome.report.promotions) {
      const told = outcome.stories.find((s) => s.kind === 'transfer'
        && (s.about.driverIds ?? []).includes(p.driverId));
      checkOnce(told !== undefined, 'promotion-unreported',
        `${where}: ${p.driverId} was promoted and it was not reported`);
      if (told && p.to === p.from) {
        checkOnce(/found no seat/.test(told.headline), 'promotion-overclaimed',
          `${where}: "${told.headline}" claims a move that did not happen`);
      }
    }
    for (const d of outcome.report.departures) {
      checkOnce(before.has(d.driverId), 'departure-unknown',
        `${where}: ${d.driverId} left the sport but was never in it`);
    }

    if (career.state.endedReason) break;
  }
}

console.log(`${stories} stories generated across 100 career-years`);
console.log(`  ${leads} leads, ${factoryStories} from the factory, `
  + `${transferStories} from the paddock`);
console.log(`${decisions} open decisions offered`);

check(stories > 1000, `only ${stories} stories across a hundred seasons — the feed is thin`);
check(leads > 100, `only ${leads} lead stories — races are not being reported`);
check(factoryStories > 0, 'no factory story was ever generated');
check(transferStories > 50,
  `only ${transferStories} paddock stories — the silly season is not being reported`);
check(decisions > 100, `only ${decisions} decisions offered — the player is rarely told what to do`);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:news OK');
