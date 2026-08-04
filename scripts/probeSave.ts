/**
 * Can a career survive the game changing underneath it?
 *
 * WHY THIS EXISTS. A career runs for ten or more seasons across many hours and
 * many builds. The save is therefore not a serialisation detail — it is the
 * contract the career keeps with its own past, and every way of breaking it is
 * silent. Nobody discovers a save bug during a race. They discover it when they
 * open the tab the next evening and fifteen hours are gone.
 *
 * So this asserts the four things that actually go wrong:
 *
 *   1. IT ROUND-TRIPS. Byte-identical, at creation and after ten seasons. If
 *      encoding then decoding then encoding does not produce the same string,
 *      something in the career is not plain data — a Map, a Date, a class, an
 *      undefined where a number is expected — and it will be lost.
 *   2. AN OLD SAVE MIGRATES. A real version 1 career, in the shape the previous
 *      build actually wrote, walks the ladder and comes out playable with its
 *      driver intact.
 *   3. A NEWER SAVE'S FIELDS SURVIVE. Keys this build has never heard of are
 *      preserved through a load and written back out, so playing on a newer
 *      build and then opening the career on an older one does not delete
 *      anything.
 *   4. GARBAGE IS REFUSED, WITH A REASON. Truncated, empty, non-JSON and foreign
 *      JSON all fail cleanly and distinguishably, because "from a newer build"
 *      and "not a save at all" need different things said to the player.
 *
 * Run: npm run probe:save
 */

import { Rng } from '../src/core/MathUtils';
import { TIER_ORDER } from '../src/data/roster';
import { clearGrid } from '../src/data/teams';
import { Career } from '../src/career/Career';
import { SAVE_VERSION, type CareerState } from '../src/career/CareerState';
import { decode, encode, needsWorldRebuild } from '../src/career/SaveCodec';
import { recordRound, seasonComplete, simulateRound } from '../src/career/Season';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

// ---------------------------------------------------------------------------
// 1. Round-tripping
// ---------------------------------------------------------------------------

function roundTrips(state: CareerState, where: string): CareerState | null {
  const first = encode(state);
  const decoded = decode(first);
  if (!decoded.ok) {
    fail(`${where}: a career this build just wrote failed to load (${decoded.reason})`);
    return null;
  }
  const second = encode(decoded.state);
  check(first === second,
    `${where}: encode -> decode -> encode is not stable, so something in the ` +
    'career is not plain data and is being lost on every save');
  return decoded.state;
}

{
  const career = Career.create({
    firstName: 'Alex', lastName: 'Bergqvist', nationality: 'Sweden', seed: 4242,
  });
  roundTrips(career.state, 'a fresh career');

  // Size, because localStorage has a quota and a career that outgrows it stops
  // saving at exactly the point it has become worth keeping.
  const bytes = encode(career.state).length;
  console.log(`fresh career: ${(bytes / 1024).toFixed(1)} KB`);
  check(bytes < 512 * 1024,
    `a fresh career is ${(bytes / 1024).toFixed(0)} KB, which is too much for a quota`);
}

// A career with ten seasons of history behind it — the one that actually has to
// survive, and the one a fresh-save test would never catch a problem in.
{
  const career = Career.create({
    firstName: 'Rosa', lastName: 'Delacroix', nationality: 'France', seed: 99,
  });
  const rng = new Rng(7);

  for (let s = 0; s < 10; s++) {
    const tier = career.tier;
    let guard = 0;
    while (!seasonComplete(career.world, career.season, tier)) {
      const result = simulateRound(career.world, career.season, tier, rng);
      career.recordPlayerRound(result);
      if (++guard > 40) break;
    }
    career.endSeason();
    if (career.state.endedReason) break;
  }

  const bytes = encode(career.state).length;
  console.log(`ten-season career: ${(bytes / 1024).toFixed(1)} KB, ` +
    `${career.state.history.length} seasons of history, ` +
    `tier ${career.tier}, ${career.state.world.tiers.F1.drivers.length} F1 drivers on file`);

  check(bytes < 512 * 1024,
    `a ten-season career is ${(bytes / 1024).toFixed(0)} KB, which is too much for a quota`);

  const back = roundTrips(career.state, 'a ten-season career');
  if (back) {
    // The contents, not just the bytes: a stable round trip of the WRONG data
    // would pass the check above.
    check(back.history.length === career.state.history.length,
      'history was lost in a round trip');
    check(back.tier === career.tier, 'the tier changed in a round trip');
    check(back.player.skill === career.state.player.skill,
      'the driver changed in a round trip');
    for (const tier of TIER_ORDER) {
      check(back.world.tiers[tier].drivers.length === career.state.world.tiers[tier].drivers.length,
        `${tier} lost drivers in a round trip`);
      check(back.world.tiers[tier].teams.length === career.state.world.tiers[tier].teams.length,
        `${tier} lost teams in a round trip`);
    }

    // And it must still RUN. A save that loads and then cannot be played is a
    // save that has not worked.
    const revived = new Career(back);
    const rng2 = new Rng(11);
    const before = revived.season.tiers[revived.tier].round;
    if (!seasonComplete(revived.world, revived.season, revived.tier)) {
      recordRound(revived.season, revived.tier,
        simulateRound(revived.world, revived.season, revived.tier, rng2));
      check(revived.season.tiers[revived.tier].round === before + 1,
        'a revived career could not run another round');
    }
  }
}

// ---------------------------------------------------------------------------
// 2. A version 1 career migrates
// ---------------------------------------------------------------------------

{
  // The shape the previous build actually wrote. Deliberately hand-written
  // rather than generated, because the point is to test against the real thing
  // rather than against this build's idea of it.
  const v1 = {
    saveVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    player: {
      firstName: 'Sam', lastName: 'Whitlock', code: 'WHI', nationality: 'Ireland',
      raceNumber: 47, skill: 0.81, aggression: 0.7, consistency: 0.78,
      tyreManagement: 0.72, wetSkill: 0.74, racecraft: 0.76, experience: 3, age: 21,
    },
    tier: 'F2', teamId: 'brava', seasonYear: 2029, round: 5,
    money: 250000, reputation: 55, teamMorale: 61, teamTrust: 50,
    pressureLevel: 33, contractYears: 1, carDevelopment: 0.04,
    staff: [{ role: 'aerodynamicist', quality: 0.7 }],
    rivalries: [{ driverId: 'v-halvorsen', score: 44, state: 'hostile' }],
    flags: { metTheBoss: true },
    standings: [{ driverId: 'PLAYER', teamId: 'brava', points: 48, wins: 1, podiums: 2, poles: 0, fastestLaps: 1, dnfs: 1 }],
    constructorPoints: { brava: 48 },
    results: [],
    titles: [{ year: 2028, tier: 'F3', type: 'drivers' }],
    firedEvents: ['mid-season-contract-drama'],
    seed: 12345,
  };

  const r = decode(JSON.stringify(v1));
  if (!r.ok) {
    fail(`a version 1 career was refused (${r.reason}) — every existing career would be lost`);
  } else {
    check(r.migratedFrom === 1, 'the migration did not report which version it came from');
    check(r.state.saveVersion === SAVE_VERSION,
      `migration left the save at version ${r.state.saveVersion}`);

    // What must survive: who the player is, and what they had achieved.
    check(r.state.player.firstName === 'Sam' && r.state.player.lastName === 'Whitlock',
      'the driver did not survive the migration');
    check(r.state.player.skill === 0.81, 'the driver\'s ability did not survive the migration');
    check(r.state.player.experience === 3, 'the driver\'s experience did not survive');
    check(r.state.narrative.reputation === 55, 'reputation did not survive the migration');
    check(r.state.narrative.flags.metTheBoss === true, 'story flags did not survive');
    check(r.state.narrative.firedEvents.includes('mid-season-contract-drama'),
      'fired events did not survive, so a once-only event could fire twice');

    // The world genuinely cannot be reconstructed — a version 1 save does not
    // know Formula 2 existed — so the codec must SAY so rather than hand back a
    // half-built career.
    check(needsWorldRebuild(r.state),
      'a version 1 save claimed to have a world, which it cannot have');

    // And the rebuild must produce something playable.
    const rebuilt = Career.create({
      firstName: r.state.player.firstName,
      lastName: r.state.player.lastName,
      nationality: r.state.player.nationality,
      seed: 12345,
    });
    rebuilt.state.player = r.state.player;
    rebuilt.state.narrative = r.state.narrative;
    rebuilt.syncPlayerIntoWorld();
    check(rebuilt.grid().length > 0, 'a rebuilt version 1 career has no grid');
    roundTrips(rebuilt.state, 'a migrated version 1 career');
  }

  // Idempotence: migrating an already-migrated save must be a no-op, because a
  // save can be loaded and re-saved any number of times.
  const once = decode(JSON.stringify(v1));
  if (once.ok) {
    const twice = decode(encode(once.state));
    check(twice.ok, 'a migrated career could not be loaded again');
    if (twice.ok) {
      check(encode(twice.state) === encode(once.state),
        'migrating twice produced a different career, so the ladder is not idempotent');
    }
  }
}

// ---------------------------------------------------------------------------
// 3. A newer build's fields survive
// ---------------------------------------------------------------------------

{
  const career = Career.create({
    firstName: 'Ines', lastName: 'Ferrante', nationality: 'Italy', seed: 5150,
  });
  const raw = JSON.parse(encode(career.state)) as Record<string, unknown>;

  // Pretend a later build added two things and bumped the minor version.
  raw.saveMinor = 99;
  raw.academyProgramme = { tier: 'gold', mentorId: 'alonso' };
  raw.helmetDesign = 7;

  const r = decode(JSON.stringify(raw));
  check(r.ok, 'a save from a newer MINOR version was refused, which costs a career for nothing');
  if (r.ok) {
    const written = JSON.parse(encode(r.state)) as Record<string, unknown>;
    check(JSON.stringify(written.academyProgramme) === JSON.stringify(raw.academyProgramme),
      'a field written by a newer build was dropped on save');
    check(written.helmetDesign === 7,
      'a scalar written by a newer build was dropped on save');
    // And the career still works.
    check(r.state.player.firstName === 'Ines', 'the career itself did not survive');
  }

  // A newer MAJOR version, though, is refused — and says why.
  raw.saveVersion = SAVE_VERSION + 5;
  const future = decode(JSON.stringify(raw));
  check(!future.ok && future.reason === 'from-the-future',
    'a save from a newer major version was accepted, which would corrupt it slowly');
}

// ---------------------------------------------------------------------------
// 3b. A MY TEAM career round-trips, field for field
// ---------------------------------------------------------------------------
//
// WHY IT NEEDS ITS OWN CASE. Everything above round-trips a driver career,
// whose `state.team` is null — so the entire `MyTeamState` block was outside
// the probe. That block is where the mode's money, factory and paint live, it
// gained nine fields and lost two while `SaveCodec.ts` was not touched at all,
// and every one of them is silent when it goes: a missing `ledger` is a career
// whose cost cap resets, a missing `liveryMark` is somebody else's car in the
// garage.
//
// Checked NAME BY NAME rather than by comparing the two objects, because the
// failure mode is one field, and "the objects differ" is not a report anybody
// can act on.

{
  const agents = Career.freeAgentsFor(31337);
  const career = Career.createMyTeam({
    firstName: 'Ines', lastName: 'Moreau', nationality: 'France',
    raceNumber: 12, seed: 31337,
    team: {
      name: 'Moreau Racing', shortName: 'Moreau', code: 'MOR',
      baseCountry: 'France',
      colour: 0x0f4d35, accent: 0xe0a72c, trim: 0xe8e0d0,
      liveryFamily: 'halo', liveryFinish: 'satin', liveryMark: 3,
    },
    teammate: agents[2],
    powerUnitId: 'ferrari-pu',
  });

  // Give every field something distinguishable to lose: a project in the
  // factory, money moved on every ledger line, a facility built, a ban served.
  career.startProject('aero', 'concept');
  career.startProject('chassis', 'development');
  career.upgradeFacility('powertrain');
  career.changeStaff('aero', 20);
  const t0 = career.myTeam!;
  t0.ledger.prizeUsd = 44_000_000;
  t0.ledger.fineUsd = 3_500_000;
  t0.developmentBanRounds = 2;
  t0.pointsDeducted = 17;

  const back = roundTrips(career.state, 'a My Team career');
  if (back) {
    const b = back.team;
    check(b !== null, 'a My Team career came back with no team at all');
    if (b) {
      const a = t0;
      const same = (name: string, x: unknown, y: unknown): void =>
        check(JSON.stringify(x) === JSON.stringify(y),
          `MyTeamState.${name} did not survive a round trip: `
          + `${JSON.stringify(x)} -> ${JSON.stringify(y)}`);

      same('teamId', a.teamId, b.teamId);
      same('name', a.name, b.name);
      same('shortName', a.shortName, b.shortName);
      same('code', a.code, b.code);
      same('baseCountry', a.baseCountry, b.baseCountry);
      same('colour', a.colour, b.colour);
      same('accent', a.accent, b.accent);
      same('trim', a.trim, b.trim);
      same('liveryFamily', a.liveryFamily, b.liveryFamily);
      same('liveryFinish', a.liveryFinish, b.liveryFinish);
      same('liveryMark', a.liveryMark, b.liveryMark);
      same('cashUsd', a.cashUsd, b.cashUsd);
      same('ledger', a.ledger, b.ledger);
      same('departments', a.departments, b.departments);
      same('projects', a.projects, b.projects);
      same('nextProjectId', a.nextProjectId, b.nextProjectId);
      same('powerUnitId', a.powerUnitId, b.powerUnitId);
      same('powerUnitYearsLeft', a.powerUnitYearsLeft, b.powerUnitYearsLeft);
      same('teammateDriverId', a.teammateDriverId, b.teammateDriverId);
      same('developmentBanRounds', a.developmentBanRounds, b.developmentBanRounds);
      same('pointsDeducted', a.pointsDeducted, b.pointsDeducted);

      // Every ledger line by name, because the cost cap is summed from three of
      // them and a lost line is a cap that silently grows.
      for (const line of Object.keys(a.ledger) as (keyof typeof a.ledger)[]) {
        check(b.ledger?.[line] === a.ledger[line],
          `ledger.${line} was $${a.ledger[line]} and came back $${b.ledger?.[line]}`);
      }
      check(a.projects.length > 0, 'the probe founded a team with nothing in the factory');
      console.log(`My Team career: ${a.projects.length} projects, `
        + `${Object.keys(a.ledger).length} ledger lines, `
        + `${(encode(career.state).length / 1024).toFixed(1)} KB, all fields survived`);

      // And it must still run as a My Team career, not merely decode as one.
      const revived = new Career(back);
      check(revived.myTeam !== null && revived.myTeam !== undefined,
        'a revived My Team career has no team');
      check(revived.myTeamRecord() !== undefined,
        "a revived My Team career's entry is not in the world");
    }
  }
}

// ---------------------------------------------------------------------------
// 3c. THE RATINGS BLOCK round-trips, field for field — issue #77
// ---------------------------------------------------------------------------
//
// WHY IT NEEDS ITS OWN CASE, and it is the same argument the My Team block
// needed. `state.ratings` is four things a projection cannot recover: the
// rating at the last reveal, the rating after each past weekend, the goal the
// team set at signing, and the lifetime counters the accolades count. Every
// one of them is silent when it goes:
//
//   · `history` missing is a contract chart calling `.length` on `undefined`.
//   · one missing counter in `record` is an accolade bar of `NaN%` width,
//     which CSS quietly draws at zero — so the screen tells somebody with 86
//     race starts that they have none, and never throws.
//   · `contract` missing is a career opening on a target it has already
//     missed, through no act of the player's.
//
// Checked NAME BY NAME rather than by comparing objects, because the failure
// mode is one field and "the objects differ" is not a report anybody can act
// on.

{
  const career = Career.create({
    firstName: 'Nadia', lastName: 'Ferreira', nationality: 'Portugal', seed: 7707,
  });
  const rng = new Rng(23);
  // Race a season, so there is a history, a set of counters and a moved rating
  // to lose rather than an empty block that round-trips by being empty.
  let guard = 0;
  while (!seasonComplete(career.world, career.season, career.tier)) {
    career.recordPlayerRound(simulateRound(career.world, career.season, career.tier, rng));
    if (++guard > 40) break;
  }
  career.markRatingsRevealed();
  career.takeMeeting();

  const a = career.ratingsState;
  check(a.history.length > 0, 'the probe raced a season and recorded no ratings history');
  check(a.record.starts > 0, 'the probe raced a season and recorded no race starts');

  const back = roundTrips(career.state, 'a career with ratings');
  if (back) {
    const b = back.ratings;
    check(b !== undefined, 'the ratings block did not survive a round trip at all');
    if (b) {
      const same = (name: string, x: unknown, y: unknown): void =>
        check(JSON.stringify(x) === JSON.stringify(y),
          `RatingsState.${name} did not survive a round trip: `
          + `${JSON.stringify(x)} -> ${JSON.stringify(y)}`);

      same('lastRevealed', a.lastRevealed, b.lastRevealed);
      same('history', a.history, b.history);
      same('contract', a.contract, b.contract);
      same('record', a.record, b.record);
      same('recognition', a.recognition, b.recognition);

      // Every lifetime counter by name. One of them is one accolade.
      for (const key of Object.keys(a.record) as (keyof typeof a.record)[]) {
        check(b.record?.[key] === a.record[key],
          `record.${key} was ${a.record[key]} and came back ${b.record?.[key]}`);
      }
      // And every field of the goal, because the retain line decides whether
      // a career says the seat is at risk.
      for (const key of Object.keys(a.contract) as (keyof typeof a.contract)[]) {
        check(b.contract?.[key] === a.contract[key],
          `contract.${key} was ${a.contract[key]} and came back ${b.contract?.[key]}`);
      }
      console.log(`ratings: ${a.history.length} chart samples, `
        + `${Object.keys(a.record).length} lifetime counters, `
        + `target ${a.contract.targetRtg} / retain ${a.contract.retainRtg}, all survived`);
    }
  }

  // A save written before the model existed. It must LOAD, and it must load
  // with a goal it can meet — not one it has already failed.
  const raw = JSON.parse(encode(career.state)) as Record<string, unknown>;
  delete raw.ratings;
  const old = decode(JSON.stringify(raw));
  check(old.ok, 'a career written before the ratings model existed was refused');
  if (old.ok) {
    const r = old.state.ratings;
    check(r !== undefined, 'backfill did not give a pre-#77 career a ratings block');
    check(Array.isArray(r?.history) && r.history.length === 0,
      'backfill invented a rating history a pre-#77 career never had');
    check(Number.isFinite(r?.contract.targetRtg), 'a backfilled contract target is NaN');
    check(Number.isFinite(r?.contract.retainRtg), 'a backfilled retain line is NaN');
    for (const key of Object.keys(a.record) as (keyof typeof a.record)[]) {
      check(Number.isFinite(r?.record[key]),
        `backfill left record.${key} as ${r?.record[key]}, which draws a bar of NaN% width`);
    }
    const revived = new Career(old.state);
    check(revived.contractGoal().targetRtg >= revived.ratings().rtg,
      'a pre-#77 career opened on a contract it had already failed');
    check(revived.accolades().every((p) => Number.isFinite(p.fraction)),
      'a pre-#77 career draws an accolade bar of NaN% width');
  }

  // And a save with the block PRESENT but a counter missing — the shape a
  // build one minor version behind writes.
  const partial = JSON.parse(encode(career.state)) as Record<string, unknown>;
  const block = partial.ratings as Record<string, Record<string, unknown>>;
  delete block.record.podiums;
  delete block.contract.retainRtg;
  const patched = decode(JSON.stringify(partial));
  check(patched.ok, 'a career missing one ratings field was refused');
  if (patched.ok) {
    check(patched.state.ratings?.record.podiums === 0,
      'a missing lifetime counter came back undefined, which is NaN in an accolade');
    check(Number.isFinite(patched.state.ratings?.contract.retainRtg),
      'a missing retain line came back undefined, so the seat-at-risk rule stops binding');
  }
}

// ---------------------------------------------------------------------------
// 4. Garbage is refused, distinguishably
// ---------------------------------------------------------------------------

{
  const cases: [string, string | null, string][] = [
    ['nothing at all', null, 'empty'],
    ['an empty string', '', 'empty'],
    ['not JSON', 'this is not a save', 'unparseable'],
    ['truncated JSON', '{"saveVersion":2,"player":{"firstNam', 'unparseable'],
    ['JSON that is not a career', '{"hello":"world"}', 'not-a-career'],
    ['an array', '[1,2,3]', 'not-a-career'],
    ['null', 'null', 'not-a-career'],
    ['a career with no player', '{"saveVersion":2}', 'not-a-career'],
  ];

  for (const [what, text, expected] of cases) {
    const r = decode(text);
    check(!r.ok, `${what} was accepted as a career`);
    if (!r.ok) {
      check(r.reason === expected,
        `${what} failed with "${r.reason}", expected "${expected}"`);
    }
  }

  // A save with a plausible shape but nonsense values should LOAD. Refusing it
  // would tell somebody their career is gone over a rounding error, and the game
  // can survive one silly number far better than it can survive that.
  const odd = decode(JSON.stringify({
    saveVersion: 2, player: { firstName: 'Odd', skill: 5 }, tier: 'F9',
  }));
  check(odd.ok, 'a structurally valid career with odd values was refused');
  if (odd.ok) {
    check(odd.state.narrative !== undefined,
      'backfill did not give a sparse save its narrative state');
    check(odd.state.history !== undefined, 'backfill did not give a sparse save its history');
    check(odd.state.prepSlotsLeft !== undefined, 'backfill left a number undefined');
  }
}

clearGrid();

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nprobe:save OK');
