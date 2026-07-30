import { clamp, clamp01, Rng } from '../core/MathUtils';
import { CIRCUITS } from '../data/tracks/circuits';
import { DRIVERS, TEAMS, getTeam, type Driver } from '../data/teams';
import eventData from './events.json';

/**
 * Career mode: the ladder from a junior series to a Formula 1 world championship.
 *
 * The design decision that matters here is that the career layer does not simulate
 * lap times of its own. When the player is in a session, the real physics runs;
 * when the player skips a session or a rival's race needs a result, the outcome is
 * produced from the same team and driver attributes the physics reads. There is
 * therefore only one model of how fast a car is, so a skipped race and a driven
 * race give consistent answers.
 *
 * Narrative events are data (events.json), not code: conditions gate when an event
 * can fire and consequences mutate career state, so adding a storyline is a data
 * edit.
 */

export type Tier = 'F3' | 'F2' | 'F1';

export const TIER_INFO: Record<Tier, { name: string; rounds: number; carPace: number; fieldSkill: number }> = {
  // carPace scales the vehicle spec's power and downforce for the tier: an F3 car
  // is meaningfully slower than an F1 car, so lap times differ correctly.
  F3: { name: 'Formula 3', rounds: 9, carPace: 0.72, fieldSkill: 0.72 },
  F2: { name: 'Formula 2', rounds: 12, carPace: 0.84, fieldSkill: 0.8 },
  F1: { name: 'Formula 1', rounds: 11, carPace: 1.0, fieldSkill: 0.88 },
};

/** Points for positions 1..10, plus a point for fastest lap. */
const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export interface PlayerDriver {
  firstName: string;
  lastName: string;
  code: string;
  nationality: string;
  raceNumber: number;

  skill: number;
  aggression: number;
  consistency: number;
  tyreManagement: number;
  wetSkill: number;
  racecraft: number;
  experience: number;
  age: number;
}

export interface CareerFlags {
  [key: string]: boolean;
}

export interface StaffMember {
  role: 'strategist' | 'aerodynamicist' | 'coach';
  quality: number;
}

export interface RivalryState {
  driverId: string;
  score: number;
  state: 'none' | 'cordial' | 'hostile' | 'feud';
}

export interface ChampionshipEntry {
  driverId: string;
  /** Blank for the player. */
  teamId: string;
  points: number;
  wins: number;
  podiums: number;
  poles: number;
  fastestLaps: number;
  dnfs: number;
}

export interface SeasonResult {
  round: number;
  circuitId: string;
  /** Driver ids in finishing order. 'PLAYER' marks the player. */
  order: string[];
  playerPosition: number;
  playerPoints: number;
  poleDriverId: string;
  fastestLapDriverId: string;
  wetRace: boolean;
}

/** The entire savable career state. */
export interface CareerState {
  saveVersion: number;
  createdAt: string;
  player: PlayerDriver;

  tier: Tier;
  teamId: string;
  seasonYear: number;
  /** 0-based index into the tier's calendar. */
  round: number;

  money: number;
  reputation: number;
  teamMorale: number;
  teamTrust: number;
  pressureLevel: number;
  contractYears: number;
  carDevelopment: number;

  staff: StaffMember[];
  rivalries: RivalryState[];
  flags: CareerFlags;

  /** Standings for the tier the player is currently in. */
  standings: ChampionshipEntry[];
  /** Constructor points by team id. */
  constructorPoints: Record<string, number>;
  results: SeasonResult[];

  /** Championships won, for the career summary. */
  titles: { year: number; tier: Tier; type: 'drivers' | 'constructors' }[];

  /** Events already fired, so `onceEver` works. */
  firedEvents: string[];
  /** Random seed, so a career is reproducible. */
  seed: number;
}

// ===========================================================================
// Narrative events
// ===========================================================================

interface EventCondition {
  minRoundInSeason?: number;
  maxRoundInSeason?: number;
  tiers?: string[];
  minReputation?: number;
  minRivalryScore?: number;
  minChampionshipPosition?: number;
  maxChampionshipPosition?: number;
  minFinishPosition?: number;
  maxFinishPosition?: number;
  requiresRaceResult?: boolean;
  requiresWetRace?: boolean;
  teammateAhead?: boolean;
  onceEver?: boolean;
}

interface Consequence {
  type: string;
  value?: number;
  key?: string;
  target?: string;
  state?: string;
  role?: string;
  quality?: number;
  text?: string;
}

export interface EventChoice {
  choiceText: string;
  hint?: string;
  consequences: Consequence[];
}

export interface CareerEvent {
  eventId: string;
  title: string;
  speaker: string;
  category: string;
  weight: number;
  conditions: EventCondition;
  promptText: string;
  choices: EventChoice[];
}

interface EventFile {
  schemaVersion: number;
  events: CareerEvent[];
}

/** Context an event's conditions are evaluated against. */
export interface EventContext {
  lastFinishPosition?: number;
  wetRace?: boolean;
  teammateAhead?: boolean;
}

/**
 * Loads and selects narrative events.
 *
 * Kept separate from the career state so it can be tested on its own and so the
 * JSON can be swapped or extended without touching career logic.
 */
export class CareerEventManager {
  private readonly events: CareerEvent[];

  constructor(file: EventFile = eventData as EventFile) {
    if (file.schemaVersion !== 1) {
      throw new Error('Unsupported career event schema: ' + file.schemaVersion);
    }
    this.events = file.events;
  }

  /** Every event, for the validation script. */
  get all(): readonly CareerEvent[] {
    return this.events;
  }

  /** Events whose conditions are currently satisfied. */
  eligible(state: CareerState, ctx: EventContext): CareerEvent[] {
    const out: CareerEvent[] = [];
    for (const ev of this.events) {
      if (this.matches(ev, state, ctx)) out.push(ev);
    }
    return out;
  }

  /** Picks one eligible event by weight, or null if none apply. */
  pick(state: CareerState, ctx: EventContext, rng: Rng): CareerEvent | null {
    const pool = this.eligible(state, ctx);
    if (pool.length === 0) return null;

    let total = 0;
    for (const e of pool) total += e.weight;
    let roll = rng.next() * total;
    for (const e of pool) {
      roll -= e.weight;
      if (roll <= 0) return e;
    }
    return pool[pool.length - 1];
  }

  private matches(ev: CareerEvent, state: CareerState, ctx: EventContext): boolean {
    const c = ev.conditions;

    if (c.onceEver && state.firedEvents.includes(ev.eventId)) return false;
    if (c.tiers && !c.tiers.includes(state.tier)) return false;

    const round = state.round + 1;
    if (c.minRoundInSeason !== undefined && round < c.minRoundInSeason) return false;
    if (c.maxRoundInSeason !== undefined && round > c.maxRoundInSeason) return false;

    if (c.minReputation !== undefined && state.reputation < c.minReputation) return false;

    if (c.minRivalryScore !== undefined) {
      let best = 0;
      for (const r of state.rivalries) best = Math.max(best, r.score);
      if (best < c.minRivalryScore) return false;
    }

    if (c.minChampionshipPosition !== undefined || c.maxChampionshipPosition !== undefined) {
      const pos = playerChampionshipPosition(state);
      if (c.minChampionshipPosition !== undefined && pos < c.minChampionshipPosition) return false;
      if (c.maxChampionshipPosition !== undefined && pos > c.maxChampionshipPosition) return false;
    }

    if (c.requiresRaceResult && ctx.lastFinishPosition === undefined) return false;
    if (c.minFinishPosition !== undefined) {
      if (ctx.lastFinishPosition === undefined || ctx.lastFinishPosition < c.minFinishPosition) return false;
    }
    if (c.maxFinishPosition !== undefined) {
      if (ctx.lastFinishPosition === undefined || ctx.lastFinishPosition > c.maxFinishPosition) return false;
    }
    if (c.requiresWetRace && !ctx.wetRace) return false;
    if (c.teammateAhead !== undefined && ctx.teammateAhead !== c.teammateAhead) return false;

    return true;
  }

  /**
   * Applies a choice's consequences to the career state.
   * Returns any radio/flavour lines to show the player.
   */
  applyChoice(state: CareerState, ev: CareerEvent, choiceIndex: number): string[] {
    const choice = ev.choices[choiceIndex];
    if (!choice) return [];
    const messages: string[] = [];

    if (!state.firedEvents.includes(ev.eventId)) state.firedEvents.push(ev.eventId);

    for (const c of choice.consequences) {
      const v = c.value ?? 0;
      switch (c.type) {
        case 'teamMorale': state.teamMorale = clamp(state.teamMorale + v, 0, 100); break;
        case 'teamTrust': state.teamTrust = clamp(state.teamTrust + v, 0, 100); break;
        case 'playerReputation': state.reputation = clamp(state.reputation + v, 0, 100); break;
        case 'pressureLevel': state.pressureLevel = clamp(state.pressureLevel + v, 0, 100); break;
        case 'money': state.money += v; break;
        case 'contractYears': state.contractYears = Math.max(0, state.contractYears + v); break;
        case 'carDevelopment': state.carDevelopment = clamp(state.carDevelopment + v, -0.2, 0.3); break;

        // Driver attributes are the payoff for development choices, so they are
        // permanent and small — a career's worth of them adds up to a real driver.
        case 'skill': state.player.skill = clamp01(state.player.skill + v); break;
        case 'aggression': state.player.aggression = clamp01(state.player.aggression + v); break;
        case 'consistency': state.player.consistency = clamp01(state.player.consistency + v); break;
        case 'tyreManagement': state.player.tyreManagement = clamp01(state.player.tyreManagement + v); break;
        case 'wetSkill': state.player.wetSkill = clamp01(state.player.wetSkill + v); break;
        case 'racecraft': state.player.racecraft = clamp01(state.player.racecraft + v); break;

        case 'championshipPoints': {
          const me = state.standings.find((s) => s.driverId === 'PLAYER');
          if (me) me.points = Math.max(0, me.points + v);
          break;
        }

        case 'rivalryScore': {
          const r = topRivalry(state);
          if (r) r.score = clamp(r.score + v, 0, 100);
          break;
        }
        case 'setRivalryState': {
          const r = c.target === 'teammate' ? teammateRivalry(state) : topRivalry(state);
          if (r && c.state) r.state = c.state as RivalryState['state'];
          break;
        }

        case 'hireStaff':
          if (c.role) {
            state.staff.push({ role: c.role as StaffMember['role'], quality: c.quality ?? 0.7 });
          }
          break;

        case 'flag':
          if (c.key) state.flags[c.key] = c.value !== undefined ? Boolean(c.value) : true;
          break;

        case 'promoteToF1':
          state.flags.promotedToF1 = true;
          break;

        case 'radio':
          if (c.text) messages.push(c.text);
          break;

        default:
          // Unknown consequence types are ignored rather than thrown: the JSON is
          // content, and a typo in content should not crash a career.
          break;
      }
    }

    return messages;
  }
}

function topRivalry(state: CareerState): RivalryState | undefined {
  let best: RivalryState | undefined;
  for (const r of state.rivalries) {
    if (!best || r.score > best.score) best = r;
  }
  return best;
}

function teammateRivalry(state: CareerState): RivalryState | undefined {
  const mates = DRIVERS.filter((d) => d.teamId === state.teamId);
  for (const m of mates) {
    const r = state.rivalries.find((x) => x.driverId === m.id);
    if (r) return r;
  }
  return topRivalry(state);
}

export function playerChampionshipPosition(state: CareerState): number {
  const sorted = state.standings.slice().sort((a, b) => b.points - a.points || b.wins - a.wins);
  return sorted.findIndex((s) => s.driverId === 'PLAYER') + 1;
}

// ===========================================================================
// Career engine
// ===========================================================================

export class CareerEngine {
  state: CareerState;
  readonly eventManager = new CareerEventManager();
  private rng: Rng;

  constructor(state: CareerState) {
    this.state = state;
    this.rng = new Rng(state.seed ^ 0x2f6a1b3c);
  }

  /** Creates a fresh career: an academy driver starting in Formula 3. */
  static create(
    firstName: string,
    lastName: string,
    nationality: string,
    seed = Math.floor(Date.now() % 2147483647),
  ): CareerEngine {
    const code = lastName.slice(0, 3).toUpperCase().padEnd(3, 'X');
    // Starting team is the weakest F3 outfit: a career should begin at the bottom.
    const startTeam = TEAMS[TEAMS.length - 1].id;

    const player: PlayerDriver = {
      firstName, lastName, code, nationality,
      raceNumber: 47,
      // A junior with obvious potential and nothing proven.
      skill: 0.74,
      aggression: 0.62,
      consistency: 0.66,
      tyreManagement: 0.6,
      wetSkill: 0.66,
      racecraft: 0.63,
      experience: 0,
      age: 18,
    };

    const state: CareerState = {
      saveVersion: 1,
      createdAt: new Date().toISOString(),
      player,
      tier: 'F3',
      teamId: startTeam,
      seasonYear: 2026,
      round: 0,
      money: 250_000,
      reputation: 12,
      teamMorale: 60,
      teamTrust: 50,
      pressureLevel: 20,
      contractYears: 1,
      carDevelopment: 0,
      staff: [],
      rivalries: [],
      flags: {},
      standings: [],
      constructorPoints: {},
      results: [],
      titles: [],
      firedEvents: [],
      seed,
    };

    const engine = new CareerEngine(state);
    engine.startSeason();
    return engine;
  }

  /** The calendar for the current tier. */
  get calendar(): string[] {
    const rounds = TIER_INFO[this.state.tier].rounds;
    // Junior series race at a subset of the circuits.
    return CIRCUITS.slice(0, rounds).map((c) => c.id);
  }

  get currentCircuitId(): string {
    const cal = this.calendar;
    return cal[Math.min(this.state.round, cal.length - 1)];
  }

  get seasonComplete(): boolean {
    return this.state.round >= this.calendar.length;
  }

  /** Resets standings for a new season in the current tier. */
  startSeason(): void {
    const s = this.state;
    s.round = 0;
    s.results = [];
    s.standings = [];
    s.constructorPoints = {};

    // The player plus a field of rivals drawn from the driver pool.
    s.standings.push({
      driverId: 'PLAYER', teamId: s.teamId, points: 0,
      wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 0,
    });

    for (const d of this.fieldForTier()) {
      s.standings.push({
        driverId: d.id, teamId: d.teamId, points: 0,
        wins: 0, podiums: 0, poles: 0, fastestLaps: 0, dnfs: 0,
      });
    }
    for (const t of TEAMS) s.constructorPoints[t.id] = 0;

    // Seed rivalries with the drivers most likely to be fighting the player.
    if (s.rivalries.length === 0) {
      for (const d of this.fieldForTier().slice(0, 4)) {
        s.rivalries.push({ driverId: d.id, score: this.rng.range(10, 35), state: 'none' });
      }
    }
  }

  /**
   * The field the player races against in the current tier.
   *
   * F1 uses the full grid; the junior series use a subset, with their skills
   * scaled down by the tier so a promotion is a genuine step up in competition.
   */
  fieldForTier(): Driver[] {
    const s = this.state;
    if (s.tier === 'F1') {
      // In F1 the player replaces one driver at their team.
      return DRIVERS.filter((d) => d.teamId !== s.teamId || DRIVERS.filter((x) => x.teamId === s.teamId)[0] === d);
    }
    const size = s.tier === 'F2' ? 15 : 13;
    return DRIVERS.slice(0, size);
  }

  /** Effective skill of a rival in this tier. */
  rivalSkill(d: Driver): number {
    const tier = TIER_INFO[this.state.tier];
    // Junior fields are less uniformly excellent, so spread widens as skill falls.
    return clamp01(d.skill * tier.fieldSkill + 0.12);
  }

  /** The player's driver record, in the same shape the sim uses. */
  playerAsDriver(): Driver {
    const p = this.state.player;
    // Pressure erodes consistency: a driver under contract pressure makes more
    // mistakes, and that is modelled rather than narrated.
    const pressurePenalty = (this.state.pressureLevel / 100) * 0.08;
    return {
      id: 'PLAYER',
      firstName: p.firstName,
      lastName: p.lastName,
      code: p.code,
      raceNumber: p.raceNumber,
      nationality: p.nationality,
      teamId: this.state.teamId,
      skill: p.skill,
      aggression: p.aggression,
      consistency: clamp01(p.consistency - pressurePenalty),
      tyreManagement: p.tyreManagement,
      wetSkill: p.wetSkill,
      racecraft: p.racecraft,
      experience: p.experience,
      age: p.age,
    };
  }

  /**
   * Records a race result and advances the calendar.
   *
   * `order` is driver ids in finishing order, with 'PLAYER' for the player. This
   * is called with the real simulation's classification when the player drives,
   * and with a simulated one when they skip — the same function either way, so
   * standings cannot diverge between the two paths.
   */
  recordResult(result: SeasonResult): void {
    const s = this.state;

    for (let i = 0; i < result.order.length; i++) {
      const id = result.order[i];
      const entry = s.standings.find((e) => e.driverId === id);
      if (!entry) continue;
      const pts = i < POINTS.length ? POINTS[i] : 0;
      entry.points += pts;
      if (i === 0) entry.wins++;
      if (i < 3) entry.podiums++;
      if (id === result.poleDriverId) entry.poles++;
      if (id === result.fastestLapDriverId) {
        entry.fastestLaps++;
        // A point for the fastest lap, only inside the top ten.
        if (i < 10) entry.points += 1;
      }
      const teamId = entry.teamId;
      if (teamId) s.constructorPoints[teamId] = (s.constructorPoints[teamId] ?? 0) + pts;
    }

    s.results.push(result);

    // Reputation and morale follow results, which is what makes a good season
    // feel like momentum rather than a number going up.
    const pos = result.playerPosition;
    const fieldSize = result.order.length;
    const relative = 1 - (pos - 1) / Math.max(fieldSize - 1, 1);
    s.reputation = clamp(s.reputation + (relative - 0.45) * 9, 0, 100);
    s.teamMorale = clamp(s.teamMorale + (relative - 0.4) * 11, 0, 100);
    s.pressureLevel = clamp(s.pressureLevel - (relative - 0.5) * 12, 0, 100);

    // Rivalries intensify when a rival finishes just around the player.
    for (const r of s.rivalries) {
      const rivalPos = result.order.indexOf(r.driverId) + 1;
      if (rivalPos === 0) continue;
      const gap = Math.abs(rivalPos - pos);
      if (gap <= 2) r.score = clamp(r.score + 6, 0, 100);
      else r.score = clamp(r.score - 1, 0, 100);
    }

    s.round++;
  }

  /**
   * Simulates a race the player skipped, or the rivals' result when the player
   * drives only part of a weekend.
   *
   * Uses the same team performance multipliers the physics uses, so a skipped race
   * produces the same kind of result the simulation would.
   */
  simulateRace(circuitId: string, wetRace: boolean): SeasonResult {
    const s = this.state;
    const field = this.fieldForTier();

    interface Runner { id: string; score: number; }
    const runners: Runner[] = [];

    const paceOf = (skill: number, wet: number, teamId: string, careTyres: number): number => {
      const team = getTeam(teamId);
      const p = team.performance;
      const carPace = (p.powerMult + p.downforceMult + p.mechanicalGripMult) / 3 + s.carDevelopment;
      const driverPace = wetRace ? wet : skill;
      // Weighted the way real results behave: the car matters more than the
      // driver, but a great driver in a poor car still beats a poor driver in a
      // good one sometimes.
      return carPace * 0.62 + driverPace * 0.38 + careTyres * 0.04;
    };

    const player = this.playerAsDriver();
    runners.push({
      id: 'PLAYER',
      score: paceOf(player.skill, player.wetSkill, s.teamId, player.tyreManagement)
        + this.rng.gaussian(0, 0.03),
    });

    for (const d of field) {
      const skill = this.rivalSkill(d);
      runners.push({
        id: d.id,
        score: paceOf(skill, clamp01(d.wetSkill * TIER_INFO[s.tier].fieldSkill + 0.12), d.teamId, d.tyreManagement)
          + this.rng.gaussian(0, 0.035),
      });
    }

    // Retirements.
    const finishers: Runner[] = [];
    const retirements: Runner[] = [];
    for (const r of runners) {
      const teamId = r.id === 'PLAYER' ? s.teamId : (DRIVERS.find((d) => d.id === r.id)?.teamId ?? s.teamId);
      const rate = getTeam(teamId).performance.failureRate;
      if (this.rng.chance(rate)) retirements.push(r);
      else finishers.push(r);
    }

    finishers.sort((a, b) => b.score - a.score);
    const order = [...finishers.map((r) => r.id), ...retirements.map((r) => r.id)];

    const playerPosition = order.indexOf('PLAYER') + 1;
    const playerPoints = playerPosition <= POINTS.length ? POINTS[playerPosition - 1] : 0;

    return {
      round: s.round,
      circuitId,
      order,
      playerPosition,
      playerPoints,
      poleDriverId: finishers.length > 0 ? finishers[0].id : 'PLAYER',
      fastestLapDriverId: finishers.length > 1 ? finishers[this.rng.int(0, Math.min(3, finishers.length))].id : 'PLAYER',
      wetRace,
    };
  }

  /**
   * Ends the season: awards titles, handles promotion and contracts, ages the
   * driver, and rolls the calendar over.
   */
  endSeason(): { promoted: boolean; championship: boolean; summary: string } {
    const s = this.state;
    const sorted = s.standings.slice().sort((a, b) => b.points - a.points || b.wins - a.wins);
    const pos = sorted.findIndex((e) => e.driverId === 'PLAYER') + 1;
    const won = pos === 1;

    if (won) {
      s.titles.push({ year: s.seasonYear, tier: s.tier, type: 'drivers' });
      s.reputation = clamp(s.reputation + 22, 0, 100);
    }

    // Constructors' title, for the team the player drives for.
    const teamRanked = Object.entries(s.constructorPoints).sort((a, b) => b[1] - a[1]);
    if (teamRanked.length > 0 && teamRanked[0][0] === s.teamId) {
      s.titles.push({ year: s.seasonYear, tier: s.tier, type: 'constructors' });
    }

    let promoted = false;
    const summaryParts: string[] = [];
    summaryParts.push(`P${pos} in the ${TIER_INFO[s.tier].name} championship`);
    if (won) summaryParts.push('CHAMPION');

    // --- Promotion ---------------------------------------------------------
    // Earned by results and reputation, not by time served.
    if (s.tier === 'F3' && (won || (pos <= 3 && s.reputation > 40))) {
      s.tier = 'F2';
      promoted = true;
      s.teamId = TEAMS[Math.max(0, TEAMS.length - 4)].id;
      summaryParts.push('Promoted to Formula 2');
    } else if (s.tier === 'F2' && (s.flags.promotedToF1 || won || (pos <= 2 && s.reputation > 60))) {
      s.tier = 'F1';
      promoted = true;
      // The seat available is proportionate to reputation: earn a better one.
      const tierIndex = s.reputation > 85 ? 3 : s.reputation > 70 ? 6 : TEAMS.length - 2;
      s.teamId = TEAMS[clamp(tierIndex, 0, TEAMS.length - 1)].id;
      summaryParts.push('Promoted to Formula 1 with ' + getTeam(s.teamId).name);
      delete s.flags.promotedToF1;
    } else if (s.tier === 'F1') {
      // Move up or down the grid based on the season.
      const teamIndex = TEAMS.findIndex((t) => t.id === s.teamId);
      if (won || (pos <= 3 && s.reputation > 75)) {
        const better = clamp(teamIndex - 2, 0, TEAMS.length - 1);
        if (better !== teamIndex) {
          s.teamId = TEAMS[better].id;
          summaryParts.push('Signed for ' + getTeam(s.teamId).name);
        }
      } else if (pos > 14 && s.reputation < 35) {
        const worse = clamp(teamIndex + 1, 0, TEAMS.length - 1);
        if (worse !== teamIndex) {
          s.teamId = TEAMS[worse].id;
          summaryParts.push('Moved to ' + getTeam(s.teamId).name);
        }
      }
    }

    // --- Season roll -------------------------------------------------------
    s.seasonYear++;
    s.player.experience++;
    s.player.age++;
    s.contractYears = Math.max(0, s.contractYears - 1);

    // Experience raises consistency and racecraft; peak years then a decline.
    const age = s.player.age;
    if (age < 27) {
      s.player.skill = clamp01(s.player.skill + 0.012);
      s.player.consistency = clamp01(s.player.consistency + 0.016);
      s.player.racecraft = clamp01(s.player.racecraft + 0.014);
    } else if (age < 33) {
      s.player.consistency = clamp01(s.player.consistency + 0.006);
      s.player.racecraft = clamp01(s.player.racecraft + 0.006);
    } else {
      s.player.skill = clamp01(s.player.skill - 0.01);
    }

    // Car development from staff carries into next season.
    for (const st of s.staff) {
      if (st.role === 'aerodynamicist') s.carDevelopment = clamp(s.carDevelopment + st.quality * 0.02, -0.2, 0.3);
    }

    this.startSeason();
    return { promoted, championship: won, summary: summaryParts.join(' · ') };
  }

  /** Sorted standings, for the UI. */
  sortedStandings(): ChampionshipEntry[] {
    return this.state.standings.slice().sort((a, b) => b.points - a.points || b.wins - a.wins);
  }

  /** Display name for a standings entry. */
  displayName(entry: ChampionshipEntry): string {
    if (entry.driverId === 'PLAYER') {
      return this.state.player.firstName + ' ' + this.state.player.lastName;
    }
    const d = DRIVERS.find((x) => x.id === entry.driverId);
    return d ? d.firstName + ' ' + d.lastName : entry.driverId;
  }

  displayCode(entry: ChampionshipEntry): string {
    if (entry.driverId === 'PLAYER') return this.state.player.code;
    return DRIVERS.find((x) => x.id === entry.driverId)?.code ?? '???';
  }

  /** Picks a narrative event for the current moment, if any. */
  drawEvent(ctx: EventContext): CareerEvent | null {
    return this.eventManager.pick(this.state, ctx, this.rng);
  }

  applyEventChoice(ev: CareerEvent, choiceIndex: number): string[] {
    return this.eventManager.applyChoice(this.state, ev, choiceIndex);
  }
}
