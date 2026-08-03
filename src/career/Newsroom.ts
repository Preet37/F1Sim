import { TIER_ORDER, type TierId } from '../data/roster';
import { TIER_CAR, findDriver, findTeam, type CareerWorld } from './World';
import { sortedStandings, type OffSeasonReport, type RoundResult, type SeasonState } from './Season';
import type { CareerState } from './CareerState';
import { AMBITION, DEPARTMENT_NAME, type DepartmentId } from './MyTeam';

/**
 * THE NEWSROOM.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS TO SOLVE
 * ---------------------------------------------------------------------------
 *
 * The verdict on career mode was not "it needs more systems", it was: "it's not
 * clear what's going on, what you're supposed to do, or how it works." That is a
 * legibility failure, and adding systems on top of an illegible one makes it
 * worse. A management game is a sequence of decisions with VISIBLE consequences;
 * where the consequence cannot be seen, the decision is noise.
 *
 * Career mode was already simulating an enormous amount that the player never
 * saw. Three championships run every season whether or not the player is in
 * them. Drivers retire, rookies come through, the transfer market moves people
 * between teams, hidden form drifts, and a factory delivers parts that change
 * the car. All of it happened; almost none of it was ever reported. The player
 * pressed "Race Weekend", got a table, and pressed it again.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 *
 * EVERY HEADLINE IS DERIVED FROM STATE THAT ALREADY EXISTS. Nothing here invents
 * an event, and nothing here is drawn from a pool of generic lines. A headline
 * about a race that did not happen is the fastest possible way to break the
 * illusion the rest of this work is trying to build — the moment the player
 * reads that somebody won a race they know somebody else won, every other number
 * on every other screen becomes suspect too.
 *
 * So a `Story` is a FACT PLUS A FRAMING. The fact is a driver id, a team id, a
 * position, a number of points, a delivered project. `probe:news` walks every
 * story generated across a hundred career-years and asserts that every id it
 * names exists in the world and that every figure it quotes matches the season
 * state it came from.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT, YET
 * ---------------------------------------------------------------------------
 *
 * This is the connective tissue, not the storyline. Press conferences, staff
 * with agendas, agencies and sponsor contracts are designed in
 * `docs/CAREER_MODE.md` and are NOT BUILT. What is built is the thing all of
 * them would have to sit on: a reporter that can say truthfully what the
 * simulation just did, to the player about themselves and about everybody else.
 */

/** How loudly a story is told, and where it is allowed to appear. */
export type StoryWeight = 'lead' | 'story' | 'brief';

/** What the story is about, which is also how it is coloured. */
export type StoryKind =
  | 'result'      // a race happened
  | 'championship'// the table moved
  | 'factory'     // a part arrived, or did not
  | 'money'       // the books
  | 'transfer'    // somebody moved
  | 'departure'   // somebody left the sport
  | 'rival'       // a story about a team that is not yours
  | 'warning';    // something the player has to act on

export interface Story {
  kind: StoryKind;
  weight: StoryWeight;
  /** The line itself. One sentence, in the register of a timing screen. */
  headline: string;
  /** The supporting sentence. Always a fact, never colour. */
  detail?: string;
  /** Ids this story names, so a probe can check every one of them exists. */
  about: { driverIds?: string[]; teamIds?: string[] };
  /** True when it is about the player or their team. */
  mine: boolean;
}

// ===========================================================================
// After a round
// ===========================================================================

export interface RoundDebriefInput {
  state: CareerState;
  result: RoundResult;
  /** Projects that reached the end of their schedule on this round. */
  deliveries: {
    department: DepartmentId;
    ambition: keyof typeof AMBITION;
    efficiency: boolean;
    passed: boolean;
    gain: number;
    costUsd: number;
  }[];
  /** Championship position before this round, so the movement can be reported. */
  positionBefore: number;
}

/**
 * What happened at the last round, told to the player.
 *
 * THE ANSWER TO "WHAT JUST HAPPENED". This is the first of the three questions
 * the player has to be able to answer at every moment; the other two — what am I
 * being asked to decide, and what happens next — are answered by
 * `nextDecisions` below and by the round card the hub already draws.
 *
 * Ordered by what a person would actually want to know first: their own result,
 * then their own factory, then the championship, then everybody else.
 */
export function roundDebrief(input: RoundDebriefInput): Story[] {
  const { state, result, deliveries } = input;
  const out: Story[] = [];
  const world = state.world;
  const tier = state.tier;
  const ts = state.season.tiers[tier];

  const name = (id: string): string => {
    if (id === state.playerDriverId) {
      return state.player.firstName + ' ' + state.player.lastName;
    }
    const d = findDriver(world, id);
    return d ? d.firstName + ' ' + d.lastName : id;
  };

  // --- Your race -----------------------------------------------------------
  const mine = result.order.indexOf(state.playerDriverId);
  const myPos = mine + 1;
  const retired = result.retired.includes(state.playerDriverId);
  const excluded = (result.disqualified ?? []).includes(state.playerDriverId);
  const winner = result.order[0];

  if (mine >= 0) {
    if (excluded) {
      out.push({
        kind: 'result', weight: 'lead', mine: true,
        headline: 'Excluded from the results',
        detail: 'The stewards have taken the result away. No points.',
        about: { driverIds: [state.playerDriverId] },
      });
    } else if (retired) {
      out.push({
        kind: 'result', weight: 'lead', mine: true,
        headline: 'Retired from the race',
        detail: `${name(winner)} won it. You scored nothing.`,
        about: { driverIds: [state.playerDriverId, winner] },
      });
    } else if (myPos === 1) {
      out.push({
        kind: 'result', weight: 'lead', mine: true,
        headline: 'You won',
        detail: `${TIER_CAR[tier].shortName}, round ${result.round + 1}`
          + (result.wetRace ? ', in the wet.' : '.'),
        about: { driverIds: [state.playerDriverId] },
      });
    } else if (myPos <= 3) {
      out.push({
        kind: 'result', weight: 'lead', mine: true,
        headline: `P${myPos}. On the podium`,
        detail: `${name(winner)} won.`,
        about: { driverIds: [state.playerDriverId, winner] },
      });
    } else {
      out.push({
        kind: 'result', weight: 'lead', mine: true,
        headline: `P${myPos}`,
        detail: `${name(winner)} won`
          + (result.wetRace ? ', in a wet race.' : '.'),
        about: { driverIds: [state.playerDriverId, winner] },
      });
    }
  }

  // Your team-mate, which is the comparison every driver is actually judged on.
  if (state.team) {
    const mateId = state.team.teammateDriverId;
    const theirs = result.order.indexOf(mateId);
    if (theirs >= 0 && mine >= 0 && mateId !== state.playerDriverId) {
      const beat = theirs > mine;
      out.push({
        kind: 'result', weight: 'brief', mine: true,
        headline: beat
          ? `You beat ${name(mateId)}`
          : `${name(mateId)} finished ahead of you`,
        detail: `P${myPos} against P${theirs + 1} in the same car.`,
        about: { driverIds: [state.playerDriverId, mateId] },
      });
    }
  }

  // --- Your factory --------------------------------------------------------
  for (const d of deliveries) {
    const dept = DEPARTMENT_NAME[d.department];
    if (d.passed) {
      out.push({
        kind: 'factory', weight: 'story', mine: true,
        headline: `${dept} delivered its ${AMBITION[d.ambition].name.toLowerCase()}`,
        detail: d.department === 'aero'
          ? (d.efficiency
            ? `About ${(d.gain * 100).toFixed(1)}% less drag. It is on the car now.`
            : `About ${(d.gain * 100).toFixed(1)}% more downforce, and the drag that `
              + 'comes with it. It is on the car now.')
          : d.department === 'chassis'
            ? `About ${(d.gain * 100).toFixed(1)}% more mechanical grip, and kinder on `
              + 'the tyres. It is on the car now.'
            : `About ${(d.gain * 100).toFixed(1)}% more power and deployment, and a `
              + 'little more reliable. It is on the car now.',
        about: { teamIds: [state.teamId] },
      });
    } else {
      out.push({
        kind: 'warning', weight: 'story', mine: true,
        headline: `${dept}'s part failed quality control`,
        detail: `$${(d.costUsd / 1e6).toFixed(1)}M spent and nothing on the car. `
          + 'A department that is unhappy fails more often — a factory visit between '
          + 'rounds is what fixes that.',
        about: { teamIds: [state.teamId] },
      });
    }
  }

  // --- The championship ----------------------------------------------------
  const table = sortedStandings(ts);
  const now = table.findIndex((e) => e.driverId === state.playerDriverId) + 1;
  if (now > 0 && input.positionBefore > 0 && now !== input.positionBefore) {
    const up = now < input.positionBefore;
    out.push({
      kind: 'championship', weight: 'story', mine: true,
      headline: up
        ? `Up to P${now} in the championship`
        : `Down to P${now} in the championship`,
      detail: `${table[now - 1]?.points ?? 0} points`
        + (tier !== 'F1'
          ? now <= 2
            ? '. The top two go up at the end of the season.'
            : `. P${now} is not a promotion; the top two go up.`
          : '.'),
      about: { driverIds: [state.playerDriverId] },
    });
  }

  // --- The rest of the paddock ---------------------------------------------
  out.push(...rivalStories(world, state.season, tier, state.playerDriverId, state.teamId));

  return out;
}

/**
 * What the other two championships and the rest of the grid have been doing.
 *
 * THIS IS THE POINT OF SIMULATING THEM. Three championships have been running
 * every season since the season spine was built, and the player has never had a
 * single word about any of them unless they went looking at a standings table.
 * A season that is inhabited is one where somebody else's story reaches you
 * without being asked for.
 */
function rivalStories(
  world: CareerWorld, season: SeasonState, myTier: TierId,
  playerDriverId: string, myTeamId: string,
): Story[] {
  const out: Story[] = [];

  /**
   * NOTHING IS SAID BEFORE ANYBODY HAS SCORED.
   *
   * "Renzo Quintero leads the championship — 0 points" is a true sentence and it
   * is worthless, and a feed that opens a season with two of them teaches the
   * player that the feed is wallpaper. A story has to carry information as well
   * as being correct; where the table is still empty there is no information in
   * it, so there is no story.
   */
  const scored = sortedStandings(season.tiers[myTier])[0]?.points ?? 0;

  // The leader of the player's own championship, when it is not them.
  const mine = sortedStandings(season.tiers[myTier]);
  if (scored > 0 && mine.length > 1 && mine[0].driverId !== playerDriverId) {
    const leader = findDriver(world, mine[0].driverId);
    const gap = mine[0].points
      - (mine.find((e) => e.driverId === playerDriverId)?.points ?? 0);
    if (leader) {
      out.push({
        kind: 'rival', weight: 'brief', mine: false,
        headline: `${leader.firstName} ${leader.lastName} leads the championship`,
        detail: `${mine[0].points} points`
          + (gap > 0 ? `, ${gap} clear of you.` : '.'),
        about: { driverIds: [leader.id], teamIds: [leader.teamId] },
      });
    }
  }

  // The constructors' fight, which is the story a team owner is actually in.
  const cons = Object.entries(season.tiers[myTier].constructorPoints)
    .sort((a, b) => b[1] - a[1]);
  const myIndex = cons.findIndex(([id]) => id === myTeamId);
  if (myIndex > 0 && cons[myIndex - 1][1] > 0) {
    const ahead = cons[myIndex - 1];
    const aheadTeam = findTeam(world, ahead[0]);
    if (aheadTeam) {
      out.push({
        kind: 'rival', weight: 'brief', mine: false,
        headline: `${aheadTeam.name} are the team directly ahead of you`,
        detail: `${ahead[1]} constructors' points against your ${cons[myIndex][1]}.`,
        about: { teamIds: [aheadTeam.id] },
      });
    }
  }

  // The championships the player is not in. One line each, and only when there
  // is something to say — a leader who is actually leading.
  for (const tier of TIER_ORDER) {
    if (tier === myTier) continue;
    const table = sortedStandings(season.tiers[tier]);
    if (table.length === 0 || table[0].points === 0) continue;
    const leader = findDriver(world, table[0].driverId);
    if (!leader) continue;
    const margin = table[0].points - (table[1]?.points ?? 0);
    out.push({
      kind: 'rival', weight: 'brief', mine: false,
      headline: `${leader.firstName} ${leader.lastName} leads ${TIER_CAR[tier].shortName}`,
      detail: margin > 0
        ? `${table[0].points} points, ${margin} clear.`
        : `${table[0].points} points, level at the top.`,
      about: { driverIds: [leader.id], teamIds: [leader.teamId] },
    });
  }

  return out;
}

// ===========================================================================
// The winter
// ===========================================================================

/**
 * The off-season, as news.
 *
 * `runOffSeason` already returns everything that happened — promotions,
 * retirements, signings, rookies — and until now it was rendered as a list of
 * ids on one screen and then thrown away. These are the events that make a
 * career's fifth season different from its first, so they are the ones most
 * worth reporting properly.
 */
export function offSeasonStories(
  state: CareerState, report: OffSeasonReport,
): Story[] {
  const world = state.world;
  const out: Story[] = [];
  const name = (id: string): string => {
    if (id === state.playerDriverId) {
      return state.player.firstName + ' ' + state.player.lastName;
    }
    const d = findDriver(world, id);
    return d ? d.firstName + ' ' + d.lastName : id;
  };
  const teamName = (id: string): string => findTeam(world, id)?.name ?? id;

  for (const c of report.champions) {
    out.push({
      kind: 'championship', weight: c.tier === state.tier ? 'lead' : 'story',
      mine: c.driverId === state.playerDriverId,
      headline: `${name(c.driverId)} is the ${TIER_CAR[c.tier].shortName} champion`,
      detail: teamName(c.teamId) + '.',
      about: { driverIds: [c.driverId], teamIds: [c.teamId] },
    });
  }

  for (const p of report.promotions) {
    // A promotion that found no seat is reported honestly as one that did not
    // happen, because `fillSeats` records it that way rather than pretending.
    if (p.to === p.from) {
      out.push({
        kind: 'transfer', weight: 'brief',
        mine: p.driverId === state.playerDriverId,
        headline: `${name(p.driverId)} finished P${p.championshipPosition} and found no seat`,
        detail: `Stays in ${TIER_CAR[p.from].shortName}.`,
        about: { driverIds: [p.driverId] },
      });
      continue;
    }
    out.push({
      kind: 'transfer',
      weight: p.driverId === state.playerDriverId ? 'lead' : 'story',
      mine: p.driverId === state.playerDriverId,
      headline: `${name(p.driverId)} moves up to ${TIER_CAR[p.to].shortName}`,
      detail: `${teamName(p.toTeamId)}, after finishing P${p.championshipPosition} `
        + `in ${TIER_CAR[p.from].shortName}.`,
      about: { driverIds: [p.driverId], teamIds: [p.toTeamId] },
    });
  }

  for (const s of report.signings) {
    out.push({
      kind: 'transfer', weight: 'brief',
      mine: s.teamId === state.teamId,
      headline: `${name(s.driverId)} signs for ${teamName(s.teamId)}`,
      detail: s.previousTeamId
        ? `From ${teamName(s.previousTeamId)}.`
        : 'A new deal.',
      about: { driverIds: [s.driverId], teamIds: [s.teamId, s.previousTeamId] },
    });
  }

  for (const d of report.departures) {
    out.push({
      kind: 'departure', weight: 'brief', mine: false,
      headline: d.reason === 'retired'
        ? `${name(d.driverId)} retires`
        : `${name(d.driverId)} loses their seat`,
      detail: d.reason === 'retired'
        ? 'That is the end of a career.'
        : 'No drive for next season.',
      about: { driverIds: [d.driverId] },
    });
  }

  if (report.rookies.length > 0) {
    const first = report.rookies[0];
    out.push({
      kind: 'transfer', weight: 'brief', mine: false,
      headline: report.rookies.length === 1
        ? `${name(first)} steps up from karting`
        : `${report.rookies.length} rookies join the junior grids`,
      detail: report.rookies.length === 1
        ? 'A Formula 3 debut.'
        : `Starting with ${name(first)}.`,
      about: { driverIds: report.rookies },
    });
  }

  return out;
}

// ===========================================================================
// What you are being asked to decide
// ===========================================================================

export interface Decision {
  /** One line, in the imperative. What to do. */
  label: string;
  /** Why it matters, stated as a consequence rather than as a hint. */
  why: string;
  /** How urgent, which decides the order and the colour. */
  urgency: 'now' | 'soon' | 'idle';
  /** Which screen answers it. The caller routes it. */
  screen: 'hub' | 'hq' | 'market' | 'engine' | 'livery' | 'prep';
}

/**
 * THE ANSWER TO "WHAT AM I SUPPOSED TO DO".
 *
 * A management screen that shows a player nine numbers and no next action is a
 * screen they will leave. This reads the actual state of the career and returns
 * the decisions that are genuinely open right now, most urgent first — an idle
 * department, an unspent preparation slot, a cost cap about to be missed, a
 * team-mate whose contract is up, cash running out.
 *
 * Every entry names a consequence rather than a rule. "Aerodynamics is idle" is
 * a fact; "Aerodynamics is idle — nothing is being built for the car" is a
 * decision.
 */
export function openDecisions(state: CareerState, roundsLeft: number): Decision[] {
  const out: Decision[] = [];

  if (state.prepSlotsLeft > 0) {
    out.push({
      label: `Spend ${state.prepSlotsLeft} preparation `
        + (state.prepSlotsLeft === 1 ? 'slot' : 'slots'),
      why: 'Training moves a driver attribute the simulation reads. A factory '
        + 'visit raises department morale, which cuts what the next upgrade costs '
        + 'and how often it fails.',
      urgency: 'now',
      screen: 'prep',
    });
  }

  const t = state.team;
  if (t) {
    const idle = (['aero', 'chassis', 'powertrain'] as DepartmentId[])
      .filter((d) => !t.projects.some((p) => p.department === d));
    if (idle.length > 0 && t.developmentBanRounds <= 0) {
      out.push({
        label: idle.length === 3
          ? 'The whole factory is idle'
          : `${idle.map((d) => DEPARTMENT_NAME[d]).join(' and ')} `
            + (idle.length === 1 ? 'is' : 'are') + ' idle',
        why: 'Nothing is being built for the car. A project started now delivers '
          + 'before the end of the season; one started much later does not.',
        urgency: roundsLeft > 3 ? 'now' : 'soon',
        screen: 'hq',
      });
    }

    if (t.developmentBanRounds > 0) {
      out.push({
        label: `Development ban: ${t.developmentBanRounds} more `
          + (t.developmentBanRounds === 1 ? 'round' : 'rounds'),
        why: 'Nothing can be commissioned until it is served. It was the price of '
          + 'last season’s cost-cap breach.',
        urgency: 'soon',
        screen: 'hq',
      });
    }

    if (t.cashUsd < 15_000_000) {
      out.push({
        label: 'The bank is nearly empty',
        why: `$${(t.cashUsd / 1e6).toFixed(1)}M left. Prize money arrives at the end of `
          + 'the season; commercial income arrives every round and grows with your '
          + 'fan rating.',
        urgency: t.cashUsd < 0 ? 'now' : 'soon',
        screen: 'hq',
      });
    }

    if (t.powerUnitYearsLeft <= 0) {
      out.push({
        label: 'Your engine deal is up',
        why: 'A different manufacturer is a different power figure and a different '
          + 'chance of not finishing. Reputation decides who will talk to you.',
        urgency: 'soon',
        screen: 'engine',
      });
    }
  }

  if (state.tier !== 'F1' && !state.team) {
    out.push({
      label: 'Finish in the top two to go up',
      why: 'That is the whole rule. Third is not a promotion, and four seasons in '
        + 'the same championship without one costs you the seat.',
      urgency: 'idle',
      screen: 'hub',
    });
  }

  return out.sort((a, b) => rank(a.urgency) - rank(b.urgency));
}

function rank(u: Decision['urgency']): number {
  return u === 'now' ? 0 : u === 'soon' ? 1 : 2;
}
