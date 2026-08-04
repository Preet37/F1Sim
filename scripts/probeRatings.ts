/**
 * THE DRIVER RATINGS MODEL — does it move, does it predict, and do the screens
 * read it?
 *
 * ===========================================================================
 * WHY THIS PROBE IS THE FIRST THING #77 BUILT
 * ===========================================================================
 *
 * Issue #77 asks for six management screens out of `reference/target/`. Every
 * one of them is a view onto a driver rating, and there was no such thing in
 * this game before it. The failure mode is not that a screen throws — it is
 * that six screens render beautifully and none of the numbers on them are
 * connected to anything. `probe:smoke` cannot see that: a screen full of
 * fiction renders exactly as well as a screen full of fact.
 *
 * So this probe asserts the four things that would be false if the model were
 * decoration:
 *
 *   1. IT IS TOTAL. Every driver in every championship, plus a thousand
 *      generated ones, produces five finite ratings in 0..100 and an overall
 *      that is the documented weighted mean of them. No NaN, ever — a NaN in a
 *      rating is a bar of `NaN%` width, which CSS silently draws at zero.
 *   2. IT MOVES WITH RESULTS. Two identical careers, one that wins every race
 *      and one that retires from every race, must end up with different
 *      ratings, in the right directions, and a career that does not race must
 *      not move at all.
 *   3. IT PREDICTS. Between two drivers IN THE SAME CAR, the one with the
 *      higher RTG must finish ahead more often than not, over thousands of
 *      races. This is the assertion that stops the weighting being arbitrary:
 *      a rating nobody can win with is a rating.
 *   4. THE SCREENS READ IT. No file in `src/ui/` may read a raw driver
 *      attribute and turn it into a figure. Four of them did — three printed
 *      `skill × 100` as though it were a rating and none of them agreed with
 *      each other. That is `TIER_INFO.carPace` and the pit panel's four
 *      derivations of one fact, in a third place.
 *
 * NODE ONLY, AND NOT LOAD SENSITIVE. Everything here is arithmetic over the
 * real career engine. There is no browser, no GL context and no wall clock, so
 * it says the same thing on a busy machine — which PROJECT.md §8 records as the
 * single most expensive property a probe can lack.
 *
 * BREAK IT: `RATINGS_BREAK=static` puts the ratings back after every race, which
 * is what a decorative model looks like from the outside, and takes §2 red.
 * `RATINGS_BREAK=weights` moves the whole of the overall onto experience and
 * takes §3 red. §6 was proved red on this branch's own base without any switch
 * at all — it found four real violations and they are in the PR.
 *
 * §4's cap has NO break switch and that is stated rather than faked: `applyMove`
 * is the only writer of a driver attribute in the model, so the only way to
 * break the ceiling is to edit that function, and a switch that edited it would
 * be testing the switch.
 *
 * Run: npm run probe:ratings
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from '../src/core/MathUtils';
import { TIER_ORDER } from '../src/data/roster';
import { clearGrid } from '../src/data/teams';
import { Career } from '../src/career/Career';
import { encode, decode } from '../src/career/SaveCodec';
import { playerAsWorldDriver } from '../src/career/CareerState';
import { raceSeats, type WorldDriver } from '../src/career/World';
import { seasonComplete, simulateRound, type RoundResult } from '../src/career/Season';
import {
  ACCOLADES, RATING_KEYS, RTG_WEIGHT, accoladeProgress, acclaimOf, buyoutUsd,
  capsFor, emptyCareerRecord, experienceFromStarts, marketValueUsd, newContractGoal,
  overallRtg, ratingsFor, recognitionFor,
  type DriverRatings, type RatingKey,
} from '../src/career/DriverRatings';

type Break = '' | 'static' | 'weights';
const BREAK = (process.env.RATINGS_BREAK ?? '') as Break;

/**
 * `weights`: the whole of the overall moves onto experience.
 *
 * A legitimate runtime break rather than a synthetic one — `RTG_WEIGHT` is the
 * constant the model reads, and putting all of it on starts produces exactly
 * the failure this section exists to catch: a rating that is internally
 * consistent, sums to one, prints beautifully and predicts nothing.
 */
if (BREAK === 'weights') {
  const w = RTG_WEIGHT as unknown as Record<RatingKey, number>;
  for (const k of RATING_KEYS) w[k] = 0;
  w.exp = 1;
}

const failures: string[] = [];
let checks = 0;
function check(ok: boolean, msg: string): void {
  checks++;
  if (!ok) failures.push(msg);
}
function section(name: string): void {
  console.log(`\n--- ${name} ---`);
}

// ===========================================================================
// 1. The projection is total
// ===========================================================================

section('1. the projection is total, and RTG is what it says it is');

{
  const career = Career.create({
    firstName: 'Ada', lastName: 'Renard', nationality: 'France', seed: 8080,
  });

  let drivers = 0;
  let lowest = 100;
  let highest = 0;
  for (const tier of TIER_ORDER) {
    for (const d of career.world.tiers[tier].drivers) {
      drivers++;
      const r = ratingsFor(d);
      for (const k of RATING_KEYS) {
        check(Number.isFinite(r[k]),
          `${d.id} ${tier}: ${k} is ${r[k]}, which draws a bar of NaN% width`);
        check(r[k] >= 0 && r[k] <= 100, `${d.id}: ${k} is ${r[k]}, outside 0..100`);
        check(Number.isInteger(r[k]), `${d.id}: ${k} is ${r[k]}, which is not a whole number`);
      }
      check(Number.isFinite(r.rtg) && r.rtg >= 0 && r.rtg <= 100,
        `${d.id}: rtg is ${r.rtg}`);
      // The overall is the documented weighted mean of the five and nothing
      // else. Recomputed here from `RTG_WEIGHT` rather than by calling
      // `overallRtg`, so a change to the function that leaves the constants
      // alone is caught.
      let want = 0;
      for (const k of RATING_KEYS) want += r[k] * RTG_WEIGHT[k];
      check(Math.round(want) === r.rtg,
        `${d.id}: rtg ${r.rtg} is not the weighted mean of its parts (${Math.round(want)})`);
      lowest = Math.min(lowest, r.rtg);
      highest = Math.max(highest, r.rtg);
    }
  }
  console.log(`${drivers} drivers across three championships: RTG ${lowest}..${highest}`);
  check(drivers > 50, `only ${drivers} drivers were rated`);
  // A grid where everybody is the same number is a grid with no information on
  // it, and it is what a broken projection looks like from the outside.
  check(highest - lowest >= 12,
    `every driver in the game rates between ${lowest} and ${highest}, a spread of `
    + `${highest - lowest} — a rating that cannot tell the grid apart is not a rating`);

  // The weights sum to one, which is the one arithmetic fact `86.png` pins
  // down: five 99s make a 99.
  const sum = RATING_KEYS.reduce((a, k) => a + RTG_WEIGHT[k], 0);
  check(Math.abs(sum - 1) < 1e-9, `the RTG weights sum to ${sum}, not 1`);
  const all99 = { exp: 99, rac: 99, awa: 99, pac: 99, foc: 99 } as Record<RatingKey, number>;
  check(overallRtg(all99) === 99,
    `five 99s make ${overallRtg(all99)} — reference/target/86.png says 99`);

  // Experience saturates: a rookie has none, a season is worth a lot, and the
  // two-hundredth race is worth almost nothing.
  check(Math.round(experienceFromStarts(0)) === 0, 'a driver with no starts has experience');
  check(experienceFromStarts(200) > experienceFromStarts(100),
    'experience does not rise with starts');
  const firstSeason = experienceFromStarts(22) - experienceFromStarts(0);
  const tenth = experienceFromStarts(220) - experienceFromStarts(198);
  console.log(`experience: a first season is worth ${firstSeason.toFixed(1)} points, `
    + `a tenth is worth ${tenth.toFixed(1)}`);
  check(firstSeason > tenth * 8,
    `a first season (${firstSeason.toFixed(1)}) is not worth far more than a tenth `
    + `(${tenth.toFixed(1)}) — experience is linear, which says a rookie's tenth race `
    + 'taught them as much as their first');
}

// ===========================================================================
// 2. IT MOVES WITH RESULTS
// ===========================================================================

section('2. the ratings move with results, in the right direction');

/**
 * Drives one career through a whole season with a HAND-BUILT result each
 * round, so the outcome is stated rather than rolled.
 *
 * `place` is the finishing position the player is put in; `retire` puts them
 * in the retirement list instead. Everybody else is filled in behind them in
 * a fixed order, so the only thing that differs between the two arms is what
 * the player did.
 */
function driveSeason(seed: number, opts: { place?: number; retire?: boolean; rounds?: number }): Career {
  const career = Career.create({
    firstName: 'Test', lastName: 'Subject', nationality: 'Italy', seed,
  });
  const rounds = opts.rounds ?? 9;
  for (let i = 0; i < rounds; i++) {
    if (seasonComplete(career.world, career.season, career.tier)) break;
    const field = raceSeats(career.world, career.tier).map((d) => d.id);
    const me = career.state.playerDriverId;
    const others = field.filter((id) => id !== me);
    const at = Math.max(0, Math.min(others.length, (opts.place ?? 1) - 1));
    const order = [...others.slice(0, at), me, ...others.slice(at)];
    const result: RoundResult = {
      round: career.season.tiers[career.tier].round,
      circuitId: career.currentCircuitId,
      order,
      retired: opts.retire ? [me] : [],
      poleDriverId: opts.place === 1 && !opts.retire ? me : others[0] ?? '',
      fastestLapDriverId: others[0] ?? '',
      wetRace: false,
      driven: true,
    };
    // `static`: the weekend is recorded and the driver is put back exactly as
    // they were. Every counter still moves, every chart point is still
    // appended, and the rating never changes — which is what a screen reading a
    // model nothing feeds looks like from the outside.
    const frozen = BREAK === 'static' ? { ...career.state.player } : null;
    career.recordPlayerRound(result);
    if (frozen) {
      career.state.player = frozen;
      career.syncPlayerIntoWorld();
    }
  }
  return career;
}

{
  const before = ratingsFor(playerAsWorldDriver(
    Career.create({ firstName: 'T', lastName: 'S', nationality: 'Italy', seed: 4242 }).state));

  const winner = driveSeason(4242, { place: 1 });
  const loser = driveSeason(4242, { place: 20 });
  const wreck = driveSeason(4242, { retire: true });
  const idle = Career.create({ firstName: 'T', lastName: 'S', nationality: 'Italy', seed: 4242 });

  const w = winner.ratings();
  const l = loser.ratings();
  const x = wreck.ratings();
  const i = idle.ratings();

  console.log(`start           RTG ${before.rtg}  pac ${before.pac} rac ${before.rac} `
    + `awa ${before.awa} foc ${before.foc} exp ${before.exp}`);
  console.log(`won everything  RTG ${w.rtg}  pac ${w.pac} rac ${w.rac} awa ${w.awa} `
    + `foc ${w.foc} exp ${w.exp}`);
  console.log(`finished last   RTG ${l.rtg}  pac ${l.pac} rac ${l.rac} awa ${l.awa} `
    + `foc ${l.foc} exp ${l.exp}`);
  console.log(`retired always  RTG ${x.rtg}  pac ${x.pac} rac ${x.rac} awa ${x.awa} `
    + `foc ${x.foc} exp ${x.exp}`);
  console.log(`never raced     RTG ${i.rtg}`);

  // THE HEADLINE. A season of winning and a season of retiring must not
  // produce the same driver.
  check(w.rtg > x.rtg,
    `a season of wins rates ${w.rtg} and a season of retirements rates ${x.rtg} — `
    + 'the ratings do not move with results');
  check(w.rtg > l.rtg,
    `winning every race (${w.rtg}) does not rate above finishing last every race (${l.rtg})`);
  check(w.pac > before.pac,
    `winning every race left pace at ${w.pac}, from ${before.pac}`);
  check(x.foc < w.foc,
    `retiring from every race left focus at ${x.foc} against a winner's ${w.foc}`);
  check(x.awa < w.awa,
    `retiring from every race left awareness at ${x.awa} against a winner's ${w.awa}`);

  // Experience counts starts, and a retirement is still a start.
  check(w.exp > before.exp, 'a season of racing did not move experience');
  check(x.exp > before.exp, 'a retirement is not a race start');
  check(winner.starts() === 9, `nine rounds produced ${winner.starts()} starts`);
  check(wreck.starts() === 9, `nine retirements produced ${wreck.starts()} starts`);

  // A career that has not raced must not have moved. This is the arm that
  // catches a model which drifts on its own.
  check(i.rtg === before.rtg,
    `a career that never raced moved from ${before.rtg} to ${i.rtg}`);

  // The chart has a point per weekend, in order, and nothing else.
  const hist = winner.ratingsState.history;
  check(hist.length === 9, `nine rounds produced ${hist.length} chart samples`);
  check(hist.every((s, n) => n === 0 || s.round >= hist[n - 1].round),
    'the ratings history is not in round order, so the chart would zig-zag backwards');
  check(hist[hist.length - 1].rtg === w.rtg,
    `the last chart point (${hist[hist.length - 1]?.rtg}) is not the current rating (${w.rtg})`);

  // A DRIVER CAREER HAS A TEAM-MATE, and three things read one: the racecraft
  // term, the recognition split and the comparison screen's default opponent.
  // `Career.teammate` returned null for every driver career there had ever
  // been, so all three were dead and the recognition screen told a Formula 3
  // rookie they did not have one. Found in a screenshot, not in the code.
  const mate = winner.teammate();
  check(mate !== null,
    'a driver career has no team-mate, so the racecraft term and the recognition '
    + 'split are both reading nothing');
  check(mate === null || mate.teamId === winner.state.teamId,
    'the team-mate is at a different team from the player');
  check(winner.recognition() !== null,
    'a driver career cannot see its recognition split');
  check(hist.every((s) => s.circuitId.length > 0),
    'a chart sample has no circuit, so the x-axis would have a blank flag on it');

  // The lifetime counters the accolades count.
  const rec = winner.ratingsState.record;
  console.log(`winner's record: ${rec.starts} starts, ${rec.wins} wins, `
    + `${rec.podiums} podiums, ${rec.top10} top tens, ${rec.points} points`);
  check(rec.wins === 9, `nine wins were recorded as ${rec.wins}`);
  check(rec.podiums === 9, `nine podiums were recorded as ${rec.podiums}`);
  check(rec.points > 0, 'nine wins scored no championship points');
  check(wreck.ratingsState.record.dnfs === 9,
    `nine retirements were recorded as ${wreck.ratingsState.record.dnfs} DNFs`);
  check(wreck.ratingsState.record.wins === 0, 'a retirement was recorded as a win');
}

// ===========================================================================
// 3. IT PREDICTS — the assertion that stops the weighting being arbitrary
// ===========================================================================

section('3. between two drivers in the SAME car, the higher rating wins more');

{
  // The car is controlled by construction: both drivers are team-mates, so
  // `performanceOf` returns one record for both and the only thing left is the
  // driver. Anything else would be measuring the grid.
  const career = Career.create({
    firstName: 'Control', lastName: 'Arm', nationality: 'Germany', seed: 1234,
  });
  const rng = new Rng(77);

  let pairs = 0;
  let higherAhead = 0;
  let sameRating = 0;

  for (let race = 0; race < 400; race++) {
    for (const tier of TIER_ORDER) {
      const result = simulateRound(career.world, career.season, tier, rng);
      const byTeam = new Map<string, WorldDriver[]>();
      for (const d of raceSeats(career.world, tier)) {
        const list = byTeam.get(d.teamId) ?? [];
        list.push(d);
        byTeam.set(d.teamId, list);
      }
      for (const mates of byTeam.values()) {
        if (mates.length !== 2) continue;
        const [a, b] = mates;
        const ra = ratingsFor(a).rtg;
        const rb = ratingsFor(b).rtg;
        if (ra === rb) { sameRating++; continue; }
        const pa = result.order.indexOf(a.id);
        const pb = result.order.indexOf(b.id);
        if (pa < 0 || pb < 0) continue;
        pairs++;
        const better = ra > rb ? a.id : b.id;
        const betterPos = better === a.id ? pa : pb;
        const otherPos = better === a.id ? pb : pa;
        if (betterPos < otherPos) higherAhead++;
      }
    }
  }

  const rate = pairs > 0 ? higherAhead / pairs : 0;
  console.log(`${pairs} team-mate pairs over 1,200 simulated races `
    + `(${sameRating} tied on rating and skipped): the higher-rated driver `
    + `finished ahead ${(rate * 100).toFixed(1)}% of the time`);
  check(pairs > 3000, `only ${pairs} comparable pairs — not enough to say anything`);
  // 50% is a coin. The bar is deliberately not 90%: two team-mates within a
  // couple of rating points of each other genuinely do swap places, and a
  // model that made the higher-rated one win nine times in ten would be
  // describing a sport nobody watches.
  check(rate >= 0.60,
    `the higher-rated team-mate finished ahead only ${(rate * 100).toFixed(1)}% of the time — `
    + 'the rating does not predict the result, so the weighting is arbitrary');
}

// ===========================================================================
// 4. Caps bind
// ===========================================================================

section('4. a cap is a ceiling, not a suggestion');

{
  // Thirty seasons of nothing but wins. Every attribute must stop at its own
  // cap and none may pass it — an uncapped model draws a progress bar past the
  // end of its own track.
  let career = driveSeason(31337, { place: 1, rounds: 9 });
  for (let s = 0; s < 30; s++) {
    career.endSeason();
    if (career.state.endedReason) break;
    const rounds = career.calendar.length;
    for (let i = 0; i < rounds; i++) {
      if (seasonComplete(career.world, career.season, career.tier)) break;
      const field = raceSeats(career.world, career.tier).map((d) => d.id);
      const me = career.state.playerDriverId;
      const others = field.filter((id) => id !== me);
      career.recordPlayerRound({
        round: career.season.tiers[career.tier].round,
        circuitId: career.currentCircuitId,
        order: [me, ...others],
        retired: [],
        poleDriverId: me,
        fastestLapDriverId: me,
        wetRace: false,
        driven: true,
      });
    }
  }

  const now = career.ratings();
  const caps = career.ratingCaps();
  console.log(`after ${career.starts()} race starts of nothing but wins: `
    + RATING_KEYS.map((k) => `${k} ${now[k]}/${caps[k]}`).join('  ') + `  RTG ${now.rtg}`);
  for (const k of RATING_KEYS) {
    check(now[k] <= caps[k],
      `${k} reached ${now[k]} against a cap of ${caps[k]} — the ceiling does not bind`);
  }
  check(career.starts() > 100, `thirty seasons produced only ${career.starts()} starts`);
  // And the history stays bounded, because the save has a quota.
  check(career.ratingsState.history.length <= 30,
    `the ratings history grew to ${career.ratingsState.history.length} samples, unbounded`);

  // A cap is never below the driver it caps.
  for (const tier of TIER_ORDER) {
    for (const d of career.world.tiers[tier].drivers) {
      const r = ratingsFor(d);
      const c = capsFor(d, career.state.seed);
      for (const k of RATING_KEYS) {
        check(c[k] >= r[k],
          `${d.id}: ${k} is ${r[k]} against a cap of ${c[k]} — a bar past its own end`);
      }
    }
  }
}

// ===========================================================================
// 5. Everything the screens print is total
// ===========================================================================

section('5. market, accolades and recognition are total');

{
  const career = Career.create({
    firstName: 'Nina', lastName: 'Halstead', nationality: 'United Kingdom', seed: 606,
  });

  for (const sort of ['acclaim', 'value', 'rating', 'name', 'team'] as const) {
    const rows = career.market(sort);
    check(rows.length > 0, `the market sorted by ${sort} is empty`);
    for (const row of rows) {
      check(Number.isFinite(row.marketValueUsd) && row.marketValueUsd >= 0,
        `${row.driver.id}: market value is ${row.marketValueUsd}`);
      check(Number.isFinite(row.buyoutUsd) && row.buyoutUsd >= 0,
        `${row.driver.id}: buyout is ${row.buyoutUsd}`);
      check(row.acclaim >= 0 && row.acclaim <= 20,
        `${row.driver.id}: acclaim is ${row.acclaim}, outside 0..20`);
      check(row.teamName.length > 0, `${row.driver.id} has no team name in the market`);
    }
    // The sort is a sort.
    if (sort === 'rating') {
      check(rows.every((r, n) => n === 0 || rows[n - 1].ratings.rtg >= r.ratings.rtg),
        'the market sorted by rating is not in rating order');
    }
    if (sort === 'value') {
      check(rows.every((r, n) => n === 0 || rows[n - 1].marketValueUsd >= r.marketValueUsd),
        'the market sorted by value is not in value order');
    }
    if (sort === 'acclaim') {
      check(rows.every((r, n) => n === 0 || rows[n - 1].acclaim >= r.acclaim),
        'the market sorted by acclaim is not in acclaim order');
    }
  }
  const me = career.market().find((r) => r.isPlayer);
  check(me !== undefined, 'the player is not in their own market');

  // Value rises with rating, holding everything else fixed. This is what makes
  // the market a consequence of the ratings model rather than a second one.
  const base = career.world.tiers.F3.drivers[0];
  const cheap = marketValueUsd({ ...base, skill: 0.55, racecraft: 0.55 },
    ratingsFor({ ...base, skill: 0.55, racecraft: 0.55 }));
  const dear = marketValueUsd({ ...base, skill: 0.95, racecraft: 0.95 },
    ratingsFor({ ...base, skill: 0.95, racecraft: 0.95 }));
  console.log(`market value: a 0.55-skill driver $${(cheap / 1e6).toFixed(2)}M, `
    + `a 0.95-skill driver $${(dear / 1e6).toFixed(2)}M`);
  check(dear > cheap, 'a better driver is not worth more, so market value ignores the rating');
  check(acclaimOf({ ...base, experience: 12 }, ratingsFor({ ...base, experience: 12 }))
    >= acclaimOf({ ...base, experience: 0 }, ratingsFor({ ...base, experience: 0 })),
    'a long career does not raise acclaim');
  check(buyoutUsd({ ...base, contractYears: 0 }) === 0,
    'a contract that has already expired costs money to break');

  // Accolades: every tier boundary behaves, and nothing divides by zero.
  const rec = emptyCareerRecord();
  for (const a of ACCOLADES) {
    const empty = accoladeProgress(a, rec);
    check(empty.tier === 1 && empty.count === 0 && empty.fraction === 0,
      `${a.name} on an empty career reads tier ${empty.tier}, ${empty.fraction}`);
    // Every counter at a million, so whichever one this accolade reads is past
    // its last tier. Which counter it is, is the accolade's own business.
    const full = { ...rec };
    for (const k of Object.keys(full) as (keyof typeof full)[]) full[k] = 1e6;
    const done = accoladeProgress(a, full);
    check(done.complete, `${a.name} is not complete at a million`);
    check(done.fraction === 1, `${a.name} at a million reads ${done.fraction} complete`);
    check(RATING_KEYS.includes(a.enhances), `${a.name} enhances "${a.enhances}", which is not a rating`);
  }
  check(new Set(ACCOLADES.map((a) => a.enhances)).size === RATING_KEYS.length,
    'the five accolades do not enhance five different attributes, so one is unreachable');

  // Recognition always sums to 100 and is never NaN.
  for (const mine of [10, 50, 99]) {
    for (const theirs of [10, 50, 99]) {
      const r = recognitionFor({
        mine: { rtg: mine } as DriverRatings,
        theirs: { rtg: theirs } as DriverRatings,
        seasonsAtTeam: 4, contractYears: 3, meetings: 6, academyChoice: true,
      });
      check(Math.abs(r.mine + r.theirs - 100) < 1e-9,
        `recognition ${mine} v ${theirs} sums to ${r.mine + r.theirs}`);
      check(Number.isFinite(r.mine), `recognition ${mine} v ${theirs} is NaN`);
      check(r.breakdown.length === 4,
        `the recognition breakdown has ${r.breakdown.length} lines; reference/target/84.png has 4`);
    }
  }
  const zero = recognitionFor({
    mine: { rtg: 0 } as DriverRatings, theirs: { rtg: 0 } as DriverRatings,
    seasonsAtTeam: 0, contractYears: 0, meetings: 0, academyChoice: false,
  });
  check(Number.isFinite(zero.mine), 'two unrated drivers divide recognition by zero');

  // The contract goal is a goal: above where you are, and a retain line below.
  const goal = career.contractGoal();
  console.log(`contract: target ${goal.targetRtg}, current ${career.ratings().rtg}, `
    + `retain ${goal.retainRtg}`);
  check(goal.targetRtg > goal.retainRtg, 'the retain line is above the target');
  check(goal.targetRtg >= career.ratings().rtg,
    `a fresh contract targets ${goal.targetRtg} against a current ${career.ratings().rtg}`);

  /**
   * AND THE GOAL MUST NOT BE MET BY TURNING UP.
   *
   * The first screenshot of the finished Contracts screen showed a target of
   * 60 beside a current of 62 — beaten by two points after THREE races,
   * because the target was a flat `rtg + 1` from the reference frame and most
   * of a rookie's first three races is the experience curve. A contract goal
   * a player passes before the fourth round of their first season is not a
   * goal, and no screenshot of it can be a picture of `85.png`.
   *
   * So: a rookie's target must survive a third of a season of winning, and a
   * driver at their ceiling must still only be asked for one point.
   */
  {
    const rookie = driveSeason(2468, { place: 1, rounds: 3 });
    const g = rookie.contractGoal();
    console.log(`after three wins from a standing start: target ${g.targetRtg}, `
      + `current ${rookie.ratings().rtg}, asked for +${g.targetRtg - g.signedRtg}`);
    check(g.targetRtg > rookie.ratings().rtg,
      `a rookie's season target (${g.targetRtg}) was passed in three races `
      + `(now ${rookie.ratings().rtg}) — the target is not a goal`);

    // A driver with nothing left to give is asked for one point, which is the
    // reference frame's own number.
    const maxed = { exp: 100, rac: 90, awa: 90, pac: 90, foc: 90 } as Record<RatingKey, number>;
    const tight = newContractGoal(90, 2026, maxed);
    check(tight.targetRtg === 91,
      `a driver at their ceiling is asked for +${tight.targetRtg - 90}; `
      + 'reference/target/85.png asks for +1');
  }
}

// ===========================================================================
// 5b. The ratings survive a save
// ===========================================================================

section('5b. the model survives a round trip, and a save that has never seen it');

{
  const career = driveSeason(9001, { place: 3, rounds: 9 });
  career.markRatingsRevealed();
  const back = decode(encode(career.state));
  check(back.ok, 'a career with ratings in it failed to load');
  if (back.ok) {
    const r = back.state.ratings;
    check(r !== undefined, 'the ratings block did not survive a round trip');
    check(r?.history.length === career.ratingsState.history.length,
      `the chart came back with ${r?.history.length} of `
      + `${career.ratingsState.history.length} points`);
    check(r?.record.starts === career.starts(),
      `race starts came back as ${r?.record.starts}, not ${career.starts()}`);
    check(r?.lastRevealed?.rtg === career.ratings().rtg,
      'the last revealed rating did not survive, so the next reveal shows the wrong delta');
    check(JSON.stringify(r?.contract) === JSON.stringify(career.contractGoal()),
      'the contract goal did not survive a round trip');
  }

  // A career written before #77 existed: no `ratings` key at all. It must open,
  // and it must open with a goal it can meet rather than one it has missed.
  const raw = JSON.parse(encode(career.state)) as Record<string, unknown>;
  delete raw.ratings;
  const old = decode(JSON.stringify(raw));
  check(old.ok, 'a career written before the ratings model was refused');
  if (old.ok) {
    const revived = new Career(old.state);
    const goal = revived.contractGoal();
    check(Number.isFinite(goal.targetRtg), 'a backfilled contract target is NaN');
    check(goal.targetRtg >= revived.ratings().rtg,
      `a pre-#77 career opened on a contract it has already failed `
      + `(target ${goal.targetRtg}, current ${revived.ratings().rtg})`);
    check(revived.ratingsState.history.length === 0,
      'a pre-#77 career invented a rating history it never had');
    check(revived.accolades().every((a) => Number.isFinite(a.fraction)),
      'a pre-#77 career draws an accolade bar of NaN% width');
    check(revived.market().length > 0, 'a pre-#77 career has no driver market');
  }
}

// ===========================================================================
// 6. THE SCREENS READ THE MODEL
// ===========================================================================

section('6. no screen derives a rating of its own');

/**
 * The rule, stated once: a file in `src/ui/` may not read a raw driver
 * attribute. Those six numbers are what the ratings model is a projection OF,
 * and a screen that reads one is a screen inventing a second rating.
 *
 * Measured by source inspection rather than by asking the screens, because a
 * screen that agrees with itself is exactly what this project keeps building
 * by accident (PROJECT.md §3.2).
 *
 * `Hud.ts` is exempt and the exemption is narrow and named: it is the in-race
 * panel, it belongs to another agent's work, and the attributes it reads are
 * the engine's per-lap ones rather than a driver's career profile.
 */
{
  const RAW = /\.(skill|racecraft|tyreManagement|wetSkill|consistency|aggression)\b/g;
  const EXEMPT = new Set(['Hud.ts']);
  const uiDir = join(process.cwd(), 'src', 'ui');
  const offences: string[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      if (EXEMPT.has(entry.name)) continue;
      scanned++;
      const src = readFileSync(path, 'utf8');
      for (const [n, line] of src.split('\n').entries()) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        const hits = line.match(RAW);
        if (hits) offences.push(`${entry.name}:${n + 1}  ${line.trim()}`);
      }
    }
  };
  walk(uiDir);

  console.log(`${scanned} screen modules scanned, ${offences.length} raw driver `
    + 'attribute reads');
  for (const o of offences) console.log('   ' + o);
  check(offences.length === 0,
    `${offences.length} screen(s) read a raw driver attribute instead of the ratings `
    + 'model, which is a second rating that nothing keeps in step with the first');

  // And the screens that show a rating must actually import the model. An
  // absence of raw reads is also what an empty file looks like.
  // `TeamHQ.ts` is deliberately NOT on this list. It used to carry a driver
  // market of its own and no longer does — there is one market now, at its own
  // screen id — so the factory screen shows no driver's numbers at all and a
  // rule requiring it to import the model would be a rule requiring a dead
  // import.
  const READERS = [
    'DriverDetails.ts', 'DriverMarketScreen.ts', 'RatingsReveal.ts',
    'Paddock.ts', 'TeamCreate.ts',
  ];
  for (const name of READERS) {
    let src = '';
    try { src = readFileSync(join(uiDir, name), 'utf8'); } catch { src = ''; }
    check(src.length > 0, `${name} does not exist, so #77's screens are not all here`);
    check(src.includes("from '../career/DriverRatings'") || src.includes("from './DriverRatings'")
      || src.includes('DriverRatings'),
      `${name} shows a driver's numbers and does not import the ratings model`);
  }
}

// ===========================================================================

clearGrid();

console.log(`\n${checks} checks`
  + (BREAK ? `   --   RATINGS_BREAK=${BREAK}` : ''));
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('probe:ratings OK — the model moves with results, predicts them, '
  + 'and the screens read it.');
