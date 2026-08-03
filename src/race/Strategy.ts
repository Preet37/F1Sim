import { clamp, clamp01 } from '../core/MathUtils';
import { getCompound, WET_COMPOUNDS, type CompoundId } from '../data/tires';
import { RACE_PACE_SLIP_POWER, steadyGrip } from '../physics/TireModel';
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
 *   A WEATHER FORECAST. That is no longer true, and the paragraph that used to
 *   sit here said so plainly enough that it is worth recording what changed.
 *   `Weather` still decides privately what the sky will do, and the DRIVER
 *   still does not get to see it — but the pit wall does, because in the real
 *   sport the pit wall has the radar and the driver has a visor. That
 *   asymmetry now exists: `src/race/Weather.ts` owns a `Forecast` with a
 *   confidence and a real error, and the wall reads the forecast while the car
 *   reads the road. The crossover arithmetic the wall reasons with is BELOW,
 *   in this file, for exactly the reason the paragraph above gives about the
 *   strategy screen: a recommendation derived somewhere other than where the
 *   race derives its own answer is a recommendation the race will contradict.
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

/**
 * The plan this car will actually start the race on.
 *
 * ONE function, called by the screen that states the plan and by the code that
 * writes it onto the car. That is the whole reason it exists: the starting tyre
 * used to be asked for twice — once as a row of chips on the briefing page and
 * again as the first stint of a strategy card — and the two disagreed, because
 * `applyPlayerSetup` ran after `applyStrategy` and wrote the chip's answer over
 * the plan's. A player who picked a soft-start strategy and had never touched
 * the chips started on mediums, and nothing on any screen said so.
 *
 * The chips are gone. This is the answer, for the player and for their
 * team-mate, and `startingCompound` of what it returns is the tyre on the grid.
 *
 * `chosenId` is what the player picked, if they picked. Nobody picks for the
 * team-mate — see `StrategyScreen` — so their column passes nothing and gets
 * the strategist's own call, which is what their column says it is getting.
 */
export function plannedStrategy(
  team: Team, driver: Driver, track: TrackDefinition, laps: number, chosenId?: string,
): StrategyOption {
  const options = strategyOptions(team, driver, track, laps);
  return options.find((o) => o.id === chosenId)
    ?? options.find((o) => o.label === 'RECOMMENDED')
    ?? options[0];
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
 * Writes a plan onto a car, tyres included.
 *
 * Here rather than inline in the app shell because it is the step where the
 * screen's promise becomes the car's state, and a probe has to be able to run
 * exactly it. Fitting the tyres is not decoration: a plan whose first stint is
 * a soft has to be sitting on softs when the lights go out, or it is not that
 * plan — and the tyre model, not the `compound` field, owns the grip curve and
 * the wear rate that make it one.
 */
export function applyPlanToCar(
  car: {
    plan: StintPlan[];
    targetPitLap: number;
    compound: CompoundId;
    usedCompounds: CompoundId[];
    physics: { frontTires: { fit(c: CompoundId, t: number): void };
      rearTires: { fit(c: CompoundId, t: number): void } };
  },
  option: StrategyOption,
  blanketTempC: number,
): void {
  car.plan = planFor(option);
  car.targetPitLap = car.plan[0].pitOnLap;
  const start = startingCompound(option);
  car.compound = start;
  car.usedCompounds.length = 0;
  car.usedCompounds.push(start);
  car.physics.frontTires.fit(start, blanketTempC);
  car.physics.rearTires.fit(start, blanketTempC);
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

// ===========================================================================
// The wet crossover
// ===========================================================================
//
// WHY IT LIVES HERE. Before this section the race engine decided the crossover
// with two magic numbers written inline in two different methods —
// `wetness > 0.4` meant fit wets, `wetness < 0.12` meant fit slicks — and the
// strategy screen knew nothing about either. That is the exact failure mode
// this file was created to end, and it had simply been reintroduced under a
// different name. So the crossover moved here, and the engine, the AI and the
// pit wall all call into it.
//
// The numbers themselves are no longer written down at all. They are SOLVED,
// from the tyre model the race actually runs, by asking a question with one
// right answer: at this water depth, which compound has the most grip? A
// crossover is the water depth at which the answer changes, and a bisection
// finds it. If somebody re-tunes `wetGripCurve` in `data/tires.ts` the
// crossover moves on its own and every consumer moves with it, which is the
// only arrangement under which the recommendation and the race cannot
// disagree.

/**
 * Lap time relative to the same car on the same track with perfect grip.
 *
 * A lap is largely cornering and braking, both of which scale with the square
 * root of the friction coefficient, plus full-throttle running which does not
 * scale with grip at all. So lap time goes as grip^(-EXPONENT) with the
 * exponent somewhere below the 0.5 a wholly grip-limited lap would give.
 *
 * MEASURED, not chosen. `probeWeather` section 2 re-solves the circuit's own
 * speed profile at a spread of grip multipliers, fits the exponent to the lap
 * times that come out, and fails if this constant is not within 0.04 of the
 * fit. 0.40 is what Silverstone fits; it says a 10% grip loss costs about 4.3%
 * of a lap, which at Spa is around 4.5 seconds.
 *
 * Note that this number does NOT move any crossover. A crossover is where two
 * compounds have equal pace, `pace = grip^-k` is monotone in grip for any
 * positive k, so the crossing point is a property of the grip curves alone.
 * What the exponent sets is the SIZE of the loss the strategist quotes, which
 * is what the break-even calculation and the driver's decision turn on.
 */
export const LAP_TIME_GRIP_EXPONENT = 0.40;

/**
 * Relative lap time on this compound at this water depth. Lower is faster.
 *
 * 1.0 would be the pace of a tyre at perfect grip; every real number is above
 * it. Only DIFFERENCES between two compounds evaluated at the same wetness are
 * meaningful — the absolute value is not a prediction of anybody's lap time,
 * and the file header's objection to fabricated deltas still stands. What has
 * changed is that a compound comparison at a fixed water depth is a comparison
 * of two grip numbers from the same model, which is a real quantity.
 */
export function relativePace(
  compound: CompoundId, wetness: number, trackTempC: number,
  slipPower = RACE_PACE_SLIP_POWER,
): number {
  const grip = steadyGrip(getCompound(compound), trackTempC, wetness, slipPower);
  return Math.pow(Math.max(grip, 1e-3), -LAP_TIME_GRIP_EXPONENT);
}

/**
 * Seconds per lap `a` gives away to `b` at this water depth.
 *
 * Positive means `a` is slower. Needs a reference lap time because the pace
 * model is dimensionless; pass the circuit's own `referencePoleTimeS` and the
 * answer is in seconds of that circuit's lap.
 */
export function paceDeltaS(
  a: CompoundId, b: CompoundId, wetness: number, trackTempC: number, refLapS: number,
): number {
  return (relativePace(a, wetness, trackTempC) - relativePace(b, wetness, trackTempC)) * refLapS;
}

/**
 * The water depth at which `b` becomes faster than `a`.
 *
 * Bisection on the pace difference over [0, 1]. Returns null when the two never
 * cross in that range, which is the honest answer for a pair like soft/medium
 * whose wet curves are near-parallel.
 */
export function crossoverWetness(
  a: CompoundId, b: CompoundId, trackTempC: number,
): number | null {
  const f = (w: number): number =>
    relativePace(a, w, trackTempC) - relativePace(b, w, trackTempC);
  let lo = 0, hi = 1;
  const flo = f(lo), fhi = f(hi);
  if (flo === 0) return 0;
  // Same sign at both ends: one compound is faster everywhere in between.
  if (flo > 0 === fhi > 0) return null;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (f(mid) > 0 === flo > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Every compound, in the order the pit wall would read them out.
 *
 * The full set a car is entitled to under 2025 Sporting Regs Art. 30.5(a):
 * thirteen sets of dry-weather tyres in the three specifications nominated for
 * the event, four sets of intermediates and three sets of wets. This game does
 * not model set counts, so the practical effect of the article here is only
 * that all five are always available — which is what this list says.
 */
export const ALL_COMPOUNDS: readonly CompoundId[] =
  ['soft', 'medium', 'hard', 'intermediate', 'wet'];

/**
 * The compound that is quickest right now, over everything available.
 *
 * `available` exists because the answer is not always free. A car that has used
 * one dry compound and must use a second before the flag cannot be told the
 * fastest tyre is the one it is already on — see `compoundsAvailableTo`.
 */
export function fastestCompound(
  wetness: number, trackTempC: number, available: readonly CompoundId[] = ALL_COMPOUNDS,
): CompoundId {
  let best = available[0];
  let bestPace = Infinity;
  for (const c of available) {
    const p = relativePace(c, wetness, trackTempC);
    if (p < bestPace) { bestPace = p; best = c; }
  }
  return best;
}

/**
 * How wet it has to get before a slick-shod car is losing real time.
 *
 * Not a constant: it is the crossover between the medium — the middle dry
 * compound, and the one a car is most likely to be on when the rain arrives —
 * and the intermediate, solved at this track temperature. On a hot track the
 * slick keeps working slightly longer, and the inter is closer to overheating,
 * and both of those fall out of the solve rather than being written in.
 */
export function slickToInterWetness(trackTempC: number): number {
  return crossoverWetness('medium', 'intermediate', trackTempC) ?? 0.5;
}

/** And the second crossover, intermediate to full wet. */
export function interToWetWetness(trackTempC: number): number {
  return crossoverWetness('intermediate', 'wet', trackTempC) ?? 0.8;
}

/** True for the two wet-weather specifications. */
export function isWetCompound(c: CompoundId): boolean {
  return (WET_COMPOUNDS as readonly CompoundId[]).includes(c);
}

/**
 * The tyre the CONDITIONS call for, as opposed to the tyre that is quickest.
 *
 * THE DISTINCTION IS THE WHOLE POINT AND GETTING IT WRONG IS EXPENSIVE. The
 * first version of this section did not have this function, and the engine
 * asked `fastestCompound` whether it should stop. On a dry track the honest
 * answer to that question is "yes, fit softs" — a new soft has more grip than
 * a medium, at every moment, for ever — so every car pitted the instant its
 * tyres were fitted. `probeStrategy` measured the field's first stop landing a
 * median of FOURTEEN laps before the lap its own plan named, and said so.
 *
 * The lesson is that "which compound is quickest right now" and "am I on the
 * right tyre" are different questions. The second one is about the WEATHER, and
 * the answer to it is a tyre family: slicks, intermediates, or full wets. Which
 * slick is a question about tyre life over a stint, it is answered by
 * `strategyOptions` at the top of this file, and it is none of the crossover's
 * business.
 *
 * `dryPreference` is the slick this car would be running if it were dry — its
 * plan's next stint, normally — so that a car told to come in for slicks is
 * told to come in for the slick its strategy actually wants.
 */
export function conditionsCompound(
  wetness: number, trackTempC: number, dryPreference: CompoundId = 'medium',
): CompoundId {
  if (wetness >= interToWetWetness(trackTempC)) return 'wet';
  if (wetness >= slickToInterWetness(trackTempC)) return 'intermediate';
  return isWetCompound(dryPreference) ? 'medium' : dryPreference;
}

/**
 * The two tyres a crossover decision is actually between: the one on the car,
 * and the one the conditions want.
 *
 * Restricting the candidate set is what keeps `crossoverCase` answering the
 * weather question. When the car is already on the right family the set has one
 * member, the loss is zero, and no stop is recommended — which is the correct
 * behaviour on a dry track and is what the whole of a dry Grand Prix relies on.
 */
export function crossoverCandidates(
  current: CompoundId, wetness: number, trackTempC: number,
  dryPreference: CompoundId, available: readonly CompoundId[],
): CompoundId[] {
  const want = conditionsCompound(wetness, trackTempC, dryPreference);
  if (want === current) return [current];
  if (available.includes(want)) return [current, want];
  // The tyre the conditions want is barred by the two-compound rule. Anything
  // legal in the same family will do — a hard instead of a medium costs a
  // fraction of what the wrong family costs, and a disqualification costs the
  // race.
  const sameFamily = available.filter((c) => isWetCompound(c) === isWetCompound(want));
  return sameFamily.length > 0 ? [current, sameFamily[0]] : [current];
}

// ---------------------------------------------------------------------------
// The decision, as opposed to the arithmetic
// ---------------------------------------------------------------------------

/** What the pit wall is weighing when it decides whether to call a car in. */
export interface CrossoverCase {
  /** The tyre the car is on now. */
  current: CompoundId;
  /** The tyre the arithmetic says is quickest for the conditions. */
  best: CompoundId;
  /** Seconds a lap the current tyre is giving away. Zero if it is the best. */
  lossPerLapS: number;
  /** Seconds the stop itself costs. */
  pitCostS: number;
  /**
   * Laps before the stop has paid for itself at the current loss rate.
   * Infinite when the current tyre is not losing anything.
   */
  breakEvenLaps: number;
  /** Laps of the race left to run. */
  lapsRemaining: number;
  /** True when the stop pays for itself, with margin, inside that distance. */
  worthIt: boolean;
}

/**
 * Margin required on a stop before a strategist will call it.
 *
 * A stop is also a RISK — an unsafe release, a wheel gun that sticks, traffic
 * on the out-lap, a lap of cold tyres — and none of those are modelled by the
 * arithmetic above. Requiring the sums to be comfortably rather than marginally
 * in favour is the cheapest honest way to represent a cost you have not
 * modelled, and it is why a real strategist does not pit for a tenth.
 */
const STOP_MARGIN = 1.5;

/**
 * Whether changing tyres is worth the stop, given conditions and distance left.
 *
 * THIS IS THE WHOLE DECISION, and it is deliberately a comparison of two
 * quantities the driver can be told out loud: what the wrong tyre costs per
 * lap, and what the stop costs once. Pitting too early on a drying track loses
 * time because the inter is about to be the wrong tyre; pitting too late in the
 * wet loses whatever `lossPerLapS` says, every lap, until you do. Both costs
 * are real and neither is hidden from the player.
 */
export function crossoverCase(
  current: CompoundId, wetness: number, trackTempC: number, refLapS: number,
  pitCostS: number, lapsRemaining: number, available: readonly CompoundId[] = ALL_COMPOUNDS,
): CrossoverCase {
  const best = fastestCompound(wetness, trackTempC, available);
  const lossPerLapS = Math.max(0, paceDeltaS(current, best, wetness, trackTempC, refLapS));
  const breakEvenLaps = lossPerLapS > 1e-4 ? pitCostS / lossPerLapS : Infinity;
  return {
    current, best, lossPerLapS, pitCostS, breakEvenLaps, lapsRemaining,
    worthIt: best !== current && breakEvenLaps * STOP_MARGIN <= lapsRemaining,
  };
}

/**
 * The same decision against where the track is GOING rather than where it is —
 * which is the only version of it a pit wall would ever actually make.
 *
 * `wetnessIn` is what the wall expects in `horizonLaps` time. Averaging the
 * loss over the interval between now and then is what stops the wall calling a
 * car in for intermediates two laps before the track dries, and it is what lets
 * it call a car in BEFORE the rain rather than after: a track that is dry now
 * and soaked in three laps has a large average loss on slicks even though the
 * loss right now is zero. That is the entire value of having a forecast.
 */
export function forecastCrossoverCase(
  current: CompoundId, wetnessNow: number, wetnessIn: number, horizonLaps: number,
  trackTempC: number, refLapS: number, pitCostS: number, lapsRemaining: number,
  available: readonly CompoundId[] = ALL_COMPOUNDS,
): CrossoverCase {
  // Sampled rather than averaged between the endpoints: the pace curves have a
  // knee in them where a compound falls out of its temperature window, and a
  // two-point average straddling that knee is wrong in the one place it
  // matters.
  const SAMPLES = 5;
  const meanPace = (c: CompoundId): number => {
    let sum = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const w = clamp01(wetnessNow + (wetnessIn - wetnessNow) * (i / (SAMPLES - 1)));
      sum += relativePace(c, w, trackTempC);
    }
    return sum / SAMPLES;
  };

  let best = available[0];
  let bestPace = Infinity;
  for (const c of available) {
    const p = meanPace(c);
    if (p < bestPace) { bestPace = p; best = c; }
  }
  const lossPerLapS = Math.max(0, (meanPace(current) - bestPace) * refLapS);
  const breakEvenLaps = lossPerLapS > 1e-4 ? pitCostS / lossPerLapS : Infinity;
  // The horizon caps the credit a change can be given. A stop that only pays
  // off after the wall's own forecast runs out is a stop made on no
  // information at all.
  const usableLaps = Math.min(lapsRemaining, Math.max(horizonLaps, 1) + lapsRemaining * 0.5);
  return {
    current, best, lossPerLapS, pitCostS, breakEvenLaps, lapsRemaining,
    worthIt: best !== current && breakEvenLaps * STOP_MARGIN <= usableLaps,
  };
}

/**
 * True when the two-compound rule still has to be satisfied.
 *
 * 2025 Sporting Regs Art. 30.5(e): a driver must use at least two different
 * specifications of dry-weather tyre during a race. Art. 30.5(f) disapplies it
 * when the race is declared wet — which this simulation tracks as `hasRained`,
 * because a race in which wet-weather tyres were genuinely the right tyre is a
 * race the stewards would have declared wet.
 *
 * Here rather than in race control because it is a constraint on the STRATEGY,
 * not a penalty. The point is to satisfy it without ever being penalised, and
 * the code that plans a stop is the code that has to know.
 */
export function mustChangeDryCompound(
  usedDryCompounds: readonly CompoundId[], hasRained: boolean, lapsRemaining: number,
  marginLaps: number,
): boolean {
  if (hasRained) return false;
  if (lapsRemaining > marginLaps) return false;
  return new Set(usedDryCompounds).size < 2;
}

/** Compounds this car may fit without breaking the two-compound rule at the flag. */
export function compoundsAvailableTo(
  usedDryCompounds: readonly CompoundId[], hasRained: boolean, lapsRemaining: number,
  marginLaps: number,
): CompoundId[] {
  if (!mustChangeDryCompound(usedDryCompounds, hasRained, lapsRemaining, marginLaps)) {
    return [...ALL_COMPOUNDS];
  }
  // A wet-weather tyre satisfies the requirement by disapplying it
  // (Art. 30.5(f)), so wets stay on the list; what comes off is the dry
  // compounds this car has already used.
  const used = new Set(usedDryCompounds);
  return ALL_COMPOUNDS.filter((c) => getCompound(c).isWetWeather || !used.has(c));
}
