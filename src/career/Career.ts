import { Rng, clamp01 } from '../core/MathUtils';
import { getTeam, type Driver } from '../data/teams';
import { REAL_ROSTER, TIER_ORDER, type TierId } from '../data/roster';
import {
  TIER_CAR, createWorld, findDriver, findTeam, installWorld, raceSeats,
  toDriver, transfer,
  type CareerWorld, type WorldDriver,
} from './World';
import {
  circuitFor, positionOf, recordRound, runOffSeason, seasonComplete,
  settleGrid, simulateRound, sortedStandings, startSeason,
  type OffSeasonReport, type RoundResult, type SeasonState, type SeasonSummary,
} from './Season';
import {
  SAVE_MINOR, SAVE_VERSION, playerAsWorldDriver, playerStanding,
  type CareerMode, type CareerState, type PlayerProfile,
} from './CareerState';
import {
  CareerEventManager, type CareerEvent, type EventContext,
} from './Events';

/**
 * The career, as one object the rest of the game talks to.
 *
 * It owns three things that have to stay consistent with one another and were
 * previously scattered: the WORLD (who exists), the SEASON (what has happened),
 * and the PLAYER (where they are in it). Every operation that touches more than
 * one of those lives here, because the bugs in a career mode are almost entirely
 * bugs where two of the three disagreed.
 *
 * It also owns the grid overlay. `installWorld` puts this career's teams and
 * drivers behind `getTeam`/`getDriver`, which is how a decision made in a menu
 * reaches the car the physics integrates. The overlay is installed on load and
 * on creation, and it is the caller's job to take it down when leaving career
 * mode — `Career.dispose()`.
 */
export class Career {
  readonly state: CareerState;
  private rng: Rng;

  constructor(state: CareerState) {
    this.state = state;
    this.rng = new Rng(state.seed ^ 0x2f6a1b3c);
    installWorld(state.world);
  }

  // =======================================================================
  // Creation
  // =======================================================================

  /**
   * Starts a career.
   *
   * A driver career begins in Formula 3 with the weakest team on the grid, which
   * is where a rookie with no results actually starts. The player REPLACES a
   * driver rather than being added as a twenty-first car, because the grid size
   * is what the pit lane paints and what every probe measures; the driver they
   * replace becomes a reserve rather than being deleted, so the world stays
   * whole and the transfer market can give them a seat again later.
   */
  static create(opts: {
    firstName: string;
    lastName: string;
    nationality: string;
    raceNumber?: number;
    mode?: CareerMode;
    seed?: number;
  }): Career {
    const seed = opts.seed ?? Math.floor(Date.now() % 2147483647);
    const world = createWorld(seed, REAL_ROSTER);
    const rng = new Rng(seed ^ 0x11f0a7d3);

    const code = opts.lastName.slice(0, 3).toUpperCase().padEnd(3, 'X');
    const player: PlayerProfile = {
      firstName: opts.firstName,
      lastName: opts.lastName,
      code,
      nationality: opts.nationality,
      raceNumber: opts.raceNumber ?? 47,
      // A junior with obvious potential and nothing proven. Deliberately below
      // the Formula 3 field's median, so the first season is a fight.
      skill: 0.70,
      aggression: 0.68,
      consistency: 0.64,
      tyreManagement: 0.62,
      wetSkill: 0.68,
      racecraft: 0.63,
      experience: 0,
      age: 18,
    };

    // The weakest Formula 3 team, which is the seat a rookie with no results is
    // actually offered.
    const f3 = world.tiers.F3;
    const startTeam = f3.teams[f3.teams.length - 1];

    const state: CareerState = {
      saveVersion: SAVE_VERSION,
      saveMinor: SAVE_MINOR,
      createdAt: new Date().toISOString(),
      seed,
      mode: opts.mode ?? 'driver',
      player,
      playerDriverId: 'PLAYER',
      tier: 'F3',
      teamId: startTeam.id,
      contractYears: 2,
      seasonsInTier: 0,
      world,
      // Replaced immediately below, once the player is in the world.
      season: { year: world.season, tiers: {} as SeasonState['tiers'] },
      history: [],
      narrative: {
        fanRating: 8,
        reputation: 10,
        pressure: 20,
        departmentMorale: {},
        rivalries: [],
        flags: {},
        firedEvents: [],
      },
      team: null,
      prepSlotsLeft: 2,
    };

    // Take a seat by displacing the weakest driver at that team, who becomes a
    // reserve rather than disappearing.
    const seatHolders = f3.drivers.filter((d) => d.teamId === startTeam.id && !d.reserve);
    const displaced = seatHolders.sort((a, b) => a.skill - b.skill)[0];
    if (displaced) displaced.reserve = true;
    f3.drivers.push(playerAsWorldDriver(state));

    const career = new Career(state);
    career.state.season = startSeason(world);
    career.seedRivalries(rng);
    return career;
  }

  /** Removes this career's grid, returning the game to the static one. */
  dispose(): void {
    // Deliberately not `clearGrid()` here — the caller decides, because leaving
    // career mode and starting a Quick Race are the same transition and only
    // `main.ts` knows which one is happening.
  }

  // =======================================================================
  // Where are we?
  // =======================================================================

  get world(): CareerWorld { return this.state.world; }
  get season(): SeasonState { return this.state.season; }
  get tier(): TierId { return this.state.tier; }

  get calendar(): readonly string[] {
    return this.state.world.tiers[this.state.tier].calendar;
  }

  get round(): number {
    return this.state.season.tiers[this.state.tier].round;
  }

  get currentCircuitId(): string {
    return circuitFor(this.state.world, this.state.season, this.state.tier);
  }

  get seasonComplete(): boolean {
    return seasonComplete(this.state.world, this.state.season, this.state.tier);
  }

  get tierName(): string {
    return TIER_CAR[this.state.tier].shortName;
  }

  get championshipPosition(): number {
    return positionOf(this.state.season.tiers[this.state.tier], this.state.playerDriverId);
  }

  standing(): { points: number; position: number } {
    return playerStanding(this.state);
  }

  /** The player's driver record, refreshed from the profile. */
  playerAsDriver(): Driver {
    return toDriver(playerAsWorldDriver(this.state));
  }

  /**
   * The full grid for the player's tier, in team order, with the player in it.
   *
   * This is what `main.ts` hands to `RaceEngine`. The player's record is rebuilt
   * from the profile each time rather than read from the world, so training and
   * pressure applied since the last save are actually in the car.
   */
  grid(): Driver[] {
    const seats = raceSeats(this.state.world, this.state.tier);
    return seats.map((d) =>
      d.id === this.state.playerDriverId ? this.playerAsDriver() : toDriver(d));
  }

  /** The team the player currently drives for, as the simulation sees it. */
  playerTeam(): ReturnType<typeof getTeam> {
    return getTeam(this.state.teamId);
  }

  // =======================================================================
  // Running a round
  // =======================================================================

  /**
   * Records the player's round and resolves the same round in the other two
   * championships.
   *
   * The other tiers are advanced HERE rather than lazily at the end of the
   * season, so that a career the player quits halfway through still has three
   * championships in a consistent state, and so that a promotion the player
   * reads about is one that has already happened rather than one computed
   * retroactively.
   */
  recordPlayerRound(result: RoundResult): void {
    recordRound(this.state.season, this.state.tier, result);
    this.advanceOtherTiers();
    this.updateRivalries(result);
    this.state.prepSlotsLeft = this.prepSlotsForNextRound();
  }

  /** Resolves the player's round on paper, for a race they chose to skip. */
  simulatePlayerRound(opts: { wet?: boolean } = {}): RoundResult {
    return simulateRound(this.state.world, this.state.season, this.state.tier, this.rng, opts);
  }

  /**
   * Keeps the two championships the player is not in level with the one they
   * are, by rounds completed as a fraction of the calendar.
   *
   * Fractional rather than round-for-round because the calendars are different
   * lengths — Formula 3 runs nine rounds and Formula 2 twelve — so "the same
   * round" is not a meaningful thing to keep in step. What has to be true is
   * that all three finish together.
   */
  private advanceOtherTiers(): void {
    const mine = this.state.season.tiers[this.state.tier];
    const myProgress = mine.round / Math.max(1, this.calendar.length);

    for (const tier of TIER_ORDER) {
      if (tier === this.state.tier) continue;
      const cal = this.state.world.tiers[tier].calendar.length;
      const target = Math.round(myProgress * cal);
      let guard = 0;
      while (this.state.season.tiers[tier].round < target
        && !seasonComplete(this.state.world, this.state.season, tier)) {
        recordRound(this.state.season, tier,
          simulateRound(this.state.world, this.state.season, tier, this.rng));
        if (++guard > 60) break;
      }
    }
  }

  /** Two slots between rounds, three when the calendar leaves a longer gap. */
  private prepSlotsForNextRound(): number {
    return this.round % 3 === 0 ? 3 : 2;
  }

  // =======================================================================
  // The off-season
  // =======================================================================

  /**
   * Ends the season and moves the career into the next one.
   *
   * Every championship is finished first, so a player who skipped nothing and a
   * player who simulated everything reach the same off-season. Then the world's
   * own off-season runs — promotions, retirements, the market, development — and
   * only afterwards is the player placed, using the same rules.
   */
  endSeason(): { report: OffSeasonReport; summary: SeasonSummary; promoted: boolean } {
    const s = this.state;

    // Finish anything outstanding, in every tier.
    for (const tier of TIER_ORDER) {
      let guard = 0;
      while (!seasonComplete(s.world, s.season, tier)) {
        recordRound(s.season, tier, simulateRound(s.world, s.season, tier, this.rng));
        if (++guard > 60) break;
      }
    }

    const myTable = sortedStandings(s.season.tiers[s.tier]);
    const myPosition = myTable.findIndex((e) => e.driverId === s.playerDriverId) + 1;
    const myPoints = myTable.find((e) => e.driverId === s.playerDriverId)?.points ?? 0;
    const wasTier = s.tier;

    const report = runOffSeason(s.world, s.season, this.rng, {
      playerDriverId: s.playerDriverId,
    });

    // --- The player goes through the same rules -----------------------------
    const promoted = this.placePlayer(myPosition, report);

    // The player has just moved, after the market closed. If they were promoted
    // they took a seat out of the tier below with them, and somebody has to fill
    // it — otherwise that championship runs a car short for a whole season, in
    // exactly the years the player did well.
    if (promoted) {
      const extra = settleGrid(s.world, this.rng, s.playerDriverId);
      report.rookies.push(...extra.rookies);
      report.signings.push(...extra.signings);
    }

    const summary: SeasonSummary = {
      year: s.season.year,
      championByTier: Object.fromEntries(report.champions.map((c) => [c.tier, c.driverId])),
      constructorByTier: Object.fromEntries(
        report.constructorChampions.map((c) => [c.tier, c.teamId])),
      playerTier: wasTier,
      playerPosition: myPosition,
      playerPoints: myPoints,
      playerTeamId: s.teamId,
      promoted,
    };
    s.history.push(summary);

    // Age the player alongside everybody else.
    s.player.age++;
    s.player.experience++;
    this.developPlayer();

    s.season = startSeason(s.world);
    s.prepSlotsLeft = 3;
    installWorld(s.world);
    return { report, summary, promoted };
  }

  /**
   * Puts the player in a seat for next season.
   *
   * THE SAME RULE AS EVERYBODY ELSE: top two in the championship go up. There is
   * no reputation gate and no discretion, which is exactly what was wrong with
   * the version this replaces — it promoted the player on
   * `won || (position <= 3 && reputation > 40)` and never promoted anyone else
   * at all.
   *
   * Which seat, though, is a market question, and the answer is the best team in
   * the new tier that has a seat open. A champion arrives before a runner-up and
   * therefore gets the better of what is available, without either being
   * scripted.
   */
  private placePlayer(position: number, report: OffSeasonReport): boolean {
    const s = this.state;
    const above = s.tier === 'F3' ? 'F2' : s.tier === 'F2' ? 'F1' : null;
    const goingUp = position > 0 && position <= 2 && above !== null;

    if (goingUp && above) {
      const seat = this.bestOpenSeat(above);
      if (seat) {
        this.moveSelfTo(above, seat);
        s.seasonsInTier = 0;
        s.contractYears = above === 'F1' ? 2 : 1;
        report.promotions.push({
          driverId: s.playerDriverId, from: s.history.length > 0 ? s.tier : s.tier,
          to: above, toTeamId: seat, championshipPosition: position,
        });
        s.tier = above;
        s.teamId = seat;
        this.state.narrative.reputation = Math.min(100, this.state.narrative.reputation + 18);
        return true;
      }
      // Promoted with nowhere to go. Real, and it stays in the same tier.
    }

    s.seasonsInTier++;
    s.contractYears = Math.max(0, s.contractYears - 1);

    /**
     * Four seasons in a junior tier without getting out of it and the seat goes.
     *
     * FOUR, NOT THREE. The first version of this was three, and `probe:save`
     * showed what that actually meant: a career simulated with no training at
     * all ended in Formula 3 in its third season, every time. A rookie starts
     * below the field on purpose — the premise is working your way up — and
     * three seasons is not enough runway to close that gap even playing well.
     *
     * It still has to bite, or the ladder has no stakes and a player can sit in
     * Formula 3 for fifteen years. Four seasons is roughly one wasted year of
     * grace, which is the shape of the real thing.
     */
    if (s.tier !== 'F1' && s.seasonsInTier >= 4 && s.contractYears <= 0) {
      s.endedReason = `Dropped after ${s.seasonsInTier} seasons in ${TIER_CAR[s.tier].shortName} ` +
        'without a promotion.';
    }
    return false;
  }

  /** The best team in a tier with a seat going spare. */
  private bestOpenSeat(tier: TierId): string | null {
    const state = this.state.world.tiers[tier];
    const ranked = state.teams.slice().sort((a, b) => {
      const rate = (t: typeof a) =>
        t.chassis.downforceMult + t.chassis.mechanicalGripMult - t.chassis.dragMult + t.form;
      return rate(b) - rate(a);
    });
    for (const team of ranked) {
      const held = state.drivers.filter(
        (d) => d.teamId === team.id && !d.reserve && !d.retired).length;
      if (held < 2) return team.id;
    }
    // Nothing open. Take the weakest team's weakest seat, displacing them to
    // reserve — the same thing that happens to the driver the player replaced at
    // the very start, and a real outcome for a champion nobody wanted.
    const worst = ranked[ranked.length - 1];
    const holder = state.drivers
      .filter((d) => d.teamId === worst.id && !d.reserve && !d.retired)
      .sort((a, b) => a.skill - b.skill)[0];
    if (holder) {
      holder.reserve = true;
      return worst.id;
    }
    return null;
  }

  /** Moves the player's world record into a new tier and team. */
  private moveSelfTo(tier: TierId, teamId: string): void {
    const s = this.state;
    const existing = findDriver(s.world, s.playerDriverId);
    if (existing) {
      transfer(s.world, s.playerDriverId, teamId, tier);
    } else {
      const rec = playerAsWorldDriver(s);
      rec.tier = tier;
      rec.teamId = teamId;
      s.world.tiers[tier].drivers.push(rec);
    }
  }

  /**
   * A season of racing makes the player better.
   *
   * The same curve every other driver is on — see `ageDrivers` — so the player
   * is not on a privileged development track. What the player has that the AI
   * does not is the preparation slots between rounds, which is where a career's
   * choices actually show up in the driver.
   */
  private developPlayer(): void {
    const p = this.state.player;
    if (p.age <= 26) {
      p.skill = clamp01(p.skill + 0.013);
      p.consistency = clamp01(p.consistency + 0.017);
      p.racecraft = clamp01(p.racecraft + 0.015);
      p.tyreManagement = clamp01(p.tyreManagement + 0.012);
    } else if (p.age <= 33) {
      p.consistency = clamp01(p.consistency + 0.005);
      p.racecraft = clamp01(p.racecraft + 0.006);
    } else {
      p.skill = clamp01(p.skill - 0.012);
    }
    this.syncPlayerIntoWorld();
  }

  /**
   * Writes the player's profile back into the world's copy of their record.
   *
   * The world holds a `WorldDriver` for the player so that the transfer market,
   * the standings and `raceSeats` all see them as one of the field. That copy is
   * derived, not authoritative — the profile is — so it has to be refreshed
   * whenever the profile changes, or the player trains all season and the grid
   * keeps racing last year's version of them.
   */
  syncPlayerIntoWorld(): void {
    const s = this.state;
    const rec = findDriver(s.world, s.playerDriverId);
    if (!rec) return;
    const fresh = playerAsWorldDriver(s);
    Object.assign(rec, fresh, { tier: rec.tier, teamId: rec.teamId });
  }

  // =======================================================================
  // Preparation between rounds
  // =======================================================================

  /**
   * Spends a preparation slot.
   *
   * These are the answer to "what do you do between races", and every one of
   * them reaches something the simulation reads: training moves a driver
   * attribute the AI's own model uses, a factory visit moves department morale
   * which decides what an upgrade costs, and a media day moves fan rating which
   * decides which sponsors will talk.
   */
  spendPrepSlot(kind: 'train' | 'simulator' | 'media' | 'factory' | 'sponsor',
    attribute?: keyof PlayerProfile): boolean {
    const s = this.state;
    if (s.prepSlotsLeft <= 0) return false;
    s.prepSlotsLeft--;

    switch (kind) {
      case 'train': {
        const key = attribute ?? 'skill';
        const v = s.player[key];
        if (typeof v === 'number') {
          // Diminishing returns: the closer to the ceiling, the less a week buys.
          const headroom = 1 - v;
          (s.player[key] as number) = clamp01(v + 0.004 + headroom * 0.012);
        }
        break;
      }
      case 'simulator':
        s.narrative.flags.simulatorPrepared = true;
        break;
      case 'media':
        s.narrative.fanRating = Math.min(100, s.narrative.fanRating + 4);
        for (const k of Object.keys(s.narrative.departmentMorale)) {
          s.narrative.departmentMorale[k] = Math.max(0, s.narrative.departmentMorale[k] - 2);
        }
        break;
      case 'factory':
        for (const k of Object.keys(s.narrative.departmentMorale)) {
          s.narrative.departmentMorale[k] = Math.min(100, s.narrative.departmentMorale[k] + 5);
        }
        break;
      case 'sponsor':
        if (s.team) s.team.cashUsd += 750_000;
        break;
    }

    this.syncPlayerIntoWorld();
    return true;
  }

  // =======================================================================
  // Rivalries
  // =======================================================================

  private seedRivalries(rng: Rng): void {
    const field = raceSeats(this.state.world, this.state.tier)
      .filter((d) => d.id !== this.state.playerDriverId);
    // The two quickest in the tier, plus the teammate: the drivers the player
    // will actually be measured against.
    const ranked = field.slice().sort((a, b) => b.skill - a.skill).slice(0, 2);
    const mate = field.find((d) => d.teamId === this.state.teamId);
    const set = new Set<WorldDriver>(ranked);
    if (mate) set.add(mate);

    for (const d of set) {
      this.state.narrative.rivalries.push({
        driverId: d.id,
        heat: rng.range(10, 30),
        state: 'none',
        declared: false,
        wonAgainst: 0,
        lostTo: 0,
      });
    }
  }

  private updateRivalries(result: RoundResult): void {
    const s = this.state;
    const mine = result.order.indexOf(s.playerDriverId);
    if (mine < 0) return;

    for (const r of s.narrative.rivalries) {
      const theirs = result.order.indexOf(r.driverId);
      if (theirs < 0) continue;
      if (theirs > mine) r.wonAgainst++; else r.lostTo++;

      // Heat rises when they finish near each other and cools when they do not,
      // so a rivalry is something that develops out of racing rather than being
      // announced.
      const gap = Math.abs(theirs - mine);
      r.heat = Math.max(0, Math.min(100, r.heat + (gap <= 2 ? 7 : -2)));
      if (r.heat > 75) r.state = 'feud';
      else if (r.heat > 50) r.state = 'hostile';
      else if (r.heat > 25) r.state = 'cordial';
      else r.state = 'none';
    }
  }

  /** Names a driver as a declared rival, which raises what beating them is worth. */
  declareRivalry(driverId: string): void {
    const existing = this.state.narrative.rivalries.find((r) => r.driverId === driverId);
    if (existing) {
      existing.declared = true;
      existing.heat = Math.max(existing.heat, 55);
      return;
    }
    this.state.narrative.rivalries.push({
      driverId, heat: 55, state: 'hostile', declared: true, wonAgainst: 0, lostTo: 0,
    });
  }

  // =======================================================================
  // Narrative events
  // =======================================================================

  private readonly events = new CareerEventManager();

  /** Picks an event for this moment, or null when nothing applies. */
  drawEvent(ctx: EventContext): CareerEvent | null {
    return this.events.pick(this, ctx, this.rng);
  }

  applyEventChoice(ev: CareerEvent, choiceIndex: number): string[] {
    return this.events.applyChoice(this, ev, choiceIndex);
  }

  // =======================================================================
  // Display helpers
  // =======================================================================

  displayName(driverId: string): string {
    if (driverId === this.state.playerDriverId) {
      return this.state.player.firstName + ' ' + this.state.player.lastName;
    }
    const d = findDriver(this.state.world, driverId);
    return d ? d.firstName + ' ' + d.lastName : driverId;
  }

  displayCode(driverId: string): string {
    if (driverId === this.state.playerDriverId) return this.state.player.code;
    return findDriver(this.state.world, driverId)?.code ?? '???';
  }

  teamNameOf(teamId: string): string {
    return findTeam(this.state.world, teamId)?.name ?? teamId;
  }
}
