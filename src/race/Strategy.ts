import { clamp } from '../core/MathUtils';
import { getCompound, type CompoundId } from '../data/tires';
import type { Team } from '../data/teams';
import type { Driver } from '../data/teams';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import type { StintPlan } from './CarEntry';

/**
 * The tyre plan, as a thing both the AI and the player can be shown.
 *
 * WHY THIS FILE EXISTS. The simulation has always planned a stint sequence for
 * every car — `RaceEngine.planStrategies` — and it was private, unnamed and
 * invisible. Twenty cars arrived at a stop on a lap chosen by a formula nobody
 * outside that method could see, the player's car got a plan it was never told
 * about and could not change, and the one strategic decision in a Grand Prix
 * was made for them off screen.
 *
 * So the model moved here and the engine now calls into it. That direction
 * matters: the strategy screen does not get its own copy of the arithmetic. If
 * it did, the recommendation on the screen and the stop the car actually makes
 * would drift apart within a week, and a strategist that recommends something
 * the race then contradicts is worse than no strategist at all.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. Everything below is derived from data the
 * simulation already uses to run the race:
 *
 *   tyre life        `TireCompound.wearRate`, the team's `tireWearMult`, the
 *                    circuit's `surfaceAbrasion`, and the driver's own
 *                    `tyreManagement` — the exact expression the engine used
 *                    before this file existed.
 *   pit loss         `PitLane.transitLossS` (authored per circuit, 8.2s at Spa
 *                    to 10.8s at Monaco) plus the team's `pitCrewTimeS`. Both
 *                    were already in the data; the first was read by nothing.
 *   distance         the session's own lap count.
 *
 * What is NOT here, and is deliberately absent rather than invented:
 *
 *   A LAP-TIME MODEL. Nothing in this game converts grip, fuel mass and
 *   compound into a predicted lap time, so no option carries a "this is 4.2s
 *   faster over the race" claim. Two stops buys grip and costs a pit loss, and
 *   the honest way to say that is to state both quantities and let the driver
 *   weigh them. A fabricated delta would look far more authoritative and be
 *   worth nothing.
 *
 *   A WEATHER FORECAST. `Weather` decides in its constructor whether it will
 *   rain, and that roll is private — correctly, because a driver who knows is
 *   not making a decision. The only honest pre-race number is the circuit's
 *   `rainChance`, and that is what the screen shows: a risk, not a forecast.
 */

/** How long each dry compound lasts here, in laps, before the cliff. */
export interface StintLife {
  soft: number;
  medium: number;
  hard: number;
}

/**
 * Laps of useful life per compound for one car on one circuit.
 *
 * The medium is the reference and the other two are ratios of it, which is how
 * the engine has always expressed it. The clamp is what keeps a low-abrasion
 * circuit from producing a tyre that outlasts the race and a high-abrasion one
 * from producing a four-lap stint.
 */
export function stintLife(team: Team, driver: Driver, track: TrackDefinition): StintLife {
  const wearMult = team.performance.tireWearMult * track.surfaceAbrasion;
  const medium = clamp(30 / wearMult * (0.85 + driver.tyreManagement * 0.3), 12, 46);
  return { soft: medium * 0.66, medium, hard: medium * 1.45 };
}

/**
 * What a stop costs, in seconds, against staying out.
 *
 * Two real numbers added together: the circuit's own pit-lane delta, and the
 * team's crew. Neither is a guess and neither is new — `transitLossS` has been
 * authored for all eleven circuits since the day they were built and was read
 * by nothing at all until this screen asked for it.
 */
export function pitLossS(team: Team, track: TrackDefinition): number {
  return track.pitLane.transitLossS + team.performance.pitCrewTimeS;
}

/** One stint of a plan, as the screen draws it. */
export interface Stint {
  compound: CompoundId;
  /** Laps this stint is expected to run. */
  laps: number;
  /** The lap the stop at the END of this stint falls on; -1 for the last. */
  pitOnLap: number;
}

export interface StrategyOption {
  id: string;
  /** RECOMMENDED / BALANCED / AGGRESSIVE — the card's own label. */
  label: string;
  stops: number;
  stints: Stint[];
  /** Why the strategist would say this, in one sentence. */
  why: string;
  /** Total time in the pit lane over the race, seconds. */
  pitCostS: number;
  /** How much of each stint's life the plan actually asks for, 0..1+. */
  strain: number;
}

/**
 * The strategies worth offering for this car, this circuit, this distance.
 *
 * Three of them, always in the same order, so the cards do not move about
 * between circuits: a one-stop, a two-stop, and an aggressive two-stop that
 * starts on the soft. Which one carries the RECOMMENDED label is decided by
 * the tyre model — whether the distance can actually be covered in two stints
 * of this car's tyre life — and that is the same test the engine's own planner
 * makes.
 *
 * `strain` is the number the recommendation turns on: the fraction of a
 * compound's useful life each stint asks for. Above 1.0 the plan is running
 * tyres past the cliff and the lap times fall away; the strategist will not
 * recommend one of those, and the card says so.
 */
export function strategyOptions(
  team: Team, driver: Driver, track: TrackDefinition, laps: number,
): StrategyOption[] {
  const life = stintLife(team, driver, track);
  const loss = pitLossS(team, track);

  const build = (
    id: string, compounds: CompoundId[], fractions: number[], why: string,
  ): StrategyOption => {
    // Stops are placed by splitting the distance in the proportions given, then
    // rounded onto laps that exist. A one-lap race has no room for a stop and
    // the clamp is what stops the plan asking for lap zero.
    const stints: Stint[] = [];
    let used = 0;
    let strain = 0;
    for (let i = 0; i < compounds.length; i++) {
      const isLast = i === compounds.length - 1;
      const want = isLast ? laps - used : Math.round(laps * fractions[i]);
      const len = Math.max(1, want);
      const pitOnLap = isLast ? -1 : clamp(used + len, 1, Math.max(1, laps - 1));
      stints.push({ compound: compounds[i], laps: len, pitOnLap });
      used = pitOnLap > 0 ? pitOnLap : laps;
      strain = Math.max(strain, len / lifeOf(life, compounds[i]));
    }
    return {
      id, label: '', stops: compounds.length - 1, stints, why,
      pitCostS: (compounds.length - 1) * loss,
      strain,
    };
  };

  const options = [
    build('one-stop', ['medium', 'hard'], [0.42], 'Fewest stops, longest stints. The hard will carry it if you look after it.'),
    build('two-stop', ['medium', 'hard', 'medium'], [0.32, 0.34], 'Fresh rubber twice. Costs a second stop and buys grip everywhere else.'),
    build('aggressive', ['soft', 'medium', 'hard'], [0.22, 0.38], 'Soft off the line for track position, then convert. Hardest on the tyres.'),
  ];

  // The recommendation: the cheapest plan that does not ask a tyre to go past
  // its cliff. If every plan does — a very abrasive circuit, or a long race —
  // the least strained one wins, and its card says what it is asking for.
  const within = options.filter((o) => o.strain <= 1);
  const pick = within.length > 0
    ? within.reduce((a, b) => (a.pitCostS <= b.pitCostS ? a : b))
    : options.reduce((a, b) => (a.strain <= b.strain ? a : b));

  for (const o of options) {
    o.label = o === pick ? 'RECOMMENDED'
      : o.id === 'aggressive' ? 'AGGRESSIVE'
      : o.strain > 1 ? 'RISKY' : 'BALANCED';
  }
  return options;
}

function lifeOf(life: StintLife, c: CompoundId): number {
  return c === 'soft' ? life.soft : c === 'hard' ? life.hard : life.medium;
}

/** The option, in the form `CarEntry.plan` is written in. */
export function planFor(option: StrategyOption): StintPlan[] {
  return option.stints.map((s) => ({ compound: s.compound, pitOnLap: s.pitOnLap }));
}

/** The compound a plan starts on — what the car is fitted with on the grid. */
export function startingCompound(option: StrategyOption): CompoundId {
  return option.stints[0].compound;
}

/**
 * A one-line summary of a plan, for a card's foot and for probes.
 *
 * Exported and pure for the same reason `neutralisationCue` is: this is what
 * the player is told a strategy costs, and a probe that re-derives it is a
 * probe that agrees with itself.
 */
export function strategySummary(option: StrategyOption): string {
  const names = option.stints.map((s) => getCompound(s.compound).name.toUpperCase()).join(' → ');
  return names + '  ·  ' + option.stops + (option.stops === 1 ? ' stop' : ' stops') +
    '  ·  ' + option.pitCostS.toFixed(1) + 's in the pit lane';
}
