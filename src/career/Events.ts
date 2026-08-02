import { clamp, clamp01, Rng } from '../core/MathUtils';
import eventData from './events.json';
import type { CareerState } from './CareerState';
import type { Career } from './Career';

/**
 * Narrative events: the paddock talking to the player between races.
 *
 * Events are DATA, not code (`events.json`), so adding a storyline is a content
 * edit. Conditions gate when one can fire; consequences mutate the career.
 *
 * This is the same design the previous `CareerEventManager` had and it was
 * right — what changed underneath it is the career state, which now has three
 * championships, a world of its own and a narrative block instead of a flat bag
 * of numbers. So the condition and consequence handlers are rewritten against
 * the new shape while the JSON schema is left alone, which means every event
 * already written still works.
 */

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

/** What just happened, for the conditions to look at. */
export interface EventContext {
  lastFinishPosition?: number;
  wetRace?: boolean;
  teammateAhead?: boolean;
}

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

  eligible(career: Career, ctx: EventContext): CareerEvent[] {
    return this.events.filter((ev) => this.matches(ev, career, ctx));
  }

  /** Picks one eligible event by weight, or null if none apply. */
  pick(career: Career, ctx: EventContext, rng: Rng): CareerEvent | null {
    const pool = this.eligible(career, ctx);
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

  private matches(ev: CareerEvent, career: Career, ctx: EventContext): boolean {
    const c = ev.conditions;
    const s = career.state;

    if (c.onceEver && s.narrative.firedEvents.includes(ev.eventId)) return false;
    if (c.tiers && !c.tiers.includes(s.tier)) return false;

    const round = career.round + 1;
    if (c.minRoundInSeason !== undefined && round < c.minRoundInSeason) return false;
    if (c.maxRoundInSeason !== undefined && round > c.maxRoundInSeason) return false;

    if (c.minReputation !== undefined && s.narrative.reputation < c.minReputation) return false;

    if (c.minRivalryScore !== undefined) {
      let best = 0;
      for (const r of s.narrative.rivalries) best = Math.max(best, r.heat);
      if (best < c.minRivalryScore) return false;
    }

    if (c.minChampionshipPosition !== undefined || c.maxChampionshipPosition !== undefined) {
      const pos = career.championshipPosition;
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
   * Applies a choice, returning any radio lines to show.
   *
   * Unknown consequence types are IGNORED rather than thrown. The JSON is
   * content, and a typo in content should cost the player a line of dialogue,
   * not a career.
   */
  applyChoice(career: Career, ev: CareerEvent, choiceIndex: number): string[] {
    const s: CareerState = career.state;
    const choice = ev.choices[choiceIndex];
    if (!choice) return [];
    const messages: string[] = [];

    if (!s.narrative.firedEvents.includes(ev.eventId)) {
      s.narrative.firedEvents.push(ev.eventId);
    }

    for (const c of choice.consequences) {
      const v = c.value ?? 0;
      switch (c.type) {
        case 'playerReputation':
          s.narrative.reputation = clamp(s.narrative.reputation + v, 0, 100);
          break;
        case 'fanRating':
          s.narrative.fanRating = clamp(s.narrative.fanRating + v, 0, 100);
          break;
        case 'pressureLevel':
          s.narrative.pressure = clamp(s.narrative.pressure + v, 0, 100);
          break;
        case 'contractYears':
          s.contractYears = Math.max(0, s.contractYears + v);
          break;

        // Morale is now per department rather than one number for the whole
        // team, because that is what the press-conference mechanic needs. An
        // event that names no department moves all of them, so events written
        // against the old single-morale model still do something sensible.
        case 'teamMorale':
        case 'departmentMorale': {
          const keys = c.target ? [c.target] : Object.keys(s.narrative.departmentMorale);
          for (const k of keys) {
            s.narrative.departmentMorale[k] = clamp(
              (s.narrative.departmentMorale[k] ?? 60) + v, 0, 100);
          }
          break;
        }

        case 'money':
          if (s.team) s.team.cashUsd += v;
          break;

        // Driver attributes are the payoff for development choices, so they are
        // permanent and small — a career's worth of them adds up to a driver.
        case 'skill': s.player.skill = clamp01(s.player.skill + v); break;
        case 'aggression': s.player.aggression = clamp01(s.player.aggression + v); break;
        case 'consistency': s.player.consistency = clamp01(s.player.consistency + v); break;
        case 'tyreManagement': s.player.tyreManagement = clamp01(s.player.tyreManagement + v); break;
        case 'wetSkill': s.player.wetSkill = clamp01(s.player.wetSkill + v); break;
        case 'racecraft': s.player.racecraft = clamp01(s.player.racecraft + v); break;

        case 'championshipPoints': {
          const ts = s.season.tiers[s.tier];
          const me = ts?.standings.find((e) => e.driverId === s.playerDriverId);
          if (me) me.points = Math.max(0, me.points + v);
          break;
        }

        case 'rivalryScore': {
          const r = topRivalry(s);
          if (r) r.heat = clamp(r.heat + v, 0, 100);
          break;
        }
        case 'setRivalryState': {
          const r = topRivalry(s);
          if (r && c.state) r.state = c.state as typeof r.state;
          break;
        }

        case 'flag':
          if (c.key) s.narrative.flags[c.key] = c.value !== undefined ? Boolean(c.value) : true;
          break;

        case 'radio':
          if (c.text) messages.push(c.text);
          break;

        default:
          // See the note above. Content typos are not career-ending.
          break;
      }
    }

    // Anything that moved a driver attribute has to reach the world's copy of
    // the player, or the grid keeps racing the version of them from before the
    // conversation.
    career.syncPlayerIntoWorld();
    return messages;
  }
}

function topRivalry(s: CareerState): CareerState['narrative']['rivalries'][number] | undefined {
  let best: CareerState['narrative']['rivalries'][number] | undefined;
  for (const r of s.narrative.rivalries) {
    if (!best || r.heat > best.heat) best = r;
  }
  return best;
}
