import { DRY_COMPOUNDS, WET_COMPOUNDS, getCompound, type CompoundId } from '../data/tires';
import type { CarEntry } from './CarEntry';
import type { RaceEngine } from './RaceEngine';

/**
 * The pit stop the player is about to make, as a value.
 *
 * WHY THIS FILE EXISTS. The stop used to be described in four places that each
 * worked it out again:
 *
 *   - the tile row, from whatever `refreshSelection` last wrote onto a class
 *     list when a click happened;
 *   - the note above it, from `pitBriefing`, which computed the crew's answer
 *     by DELETING the driver's instruction off the car and putting it back;
 *   - the status line under it, from `chosen ?? briefing.compound`;
 *   - and the stop itself, from a private `chooseCompoundForStint`.
 *
 * Four derivations of one fact is four chances to disagree, and they did: the
 * panel read "the engineers would fit hard", the status line read "hard", the
 * soft tile was drawn as chosen, and the car came out on softs. Three answers
 * to "what am I getting", none of them the one the driver had given.
 *
 * So there is now one answer — `RaceEngine.compoundForStint`, the function the
 * stop actually calls — and this file turns it, plus the car's own state, into
 * the complete text and selection state of the panel. `pitSheet` is pure and
 * total: everything the panel draws is in its return value, so the panel can be
 * a render of it rather than a memory of past clicks. A tile cannot be selected
 * unless the engine agrees that tile is what the crew will fit.
 *
 * The three mutators below are the ONLY way the choice changes, and they are
 * shared by the pointer, the keyboard, the gamepad and the touchscreen. A
 * device that could set the choice by another route would be a device that can
 * put the panel and the car out of step again.
 */

/** What the driver has said about the front wing. */
export type RepairChoice = 'crew' | 'change' | 'keep';

export interface PitTile {
  id: CompoundId;
  code: string;
  name: string;
  /** Livery colour of the compound, as a CSS hex string. */
  colour: string;
  /** This dry compound has already been run, so it does not satisfy the rule. */
  used: boolean;
  /** The crew will fit this one. Exactly one tile is ever selected. */
  selected: boolean;
  /** True when this is the crew's own recommendation. */
  recommended: boolean;
}

export interface PitRepairOption {
  value: RepairChoice;
  label: string;
  selected: boolean;
}

export interface PitSheet {
  /** The compound the crew fits if the car reaches its box now. The one value. */
  fitting: CompoundId;
  /** True when the nose comes off at this stop. */
  repairing: boolean;
  /** True when `fitting` is the driver's instruction rather than the crew's. */
  byDriver: boolean;
  tiles: PitTile[];
  repairs: PitRepairOption[];
  /** The crew's recommendation, in the principal's voice. */
  note: string;
  /** Front-wing condition, e.g. `FRONT WING 44%`. */
  wingLabel: string;
  /** Where the stop has got to: called, in the lane, stationary. */
  status: string;
  /**
   * The one thing that can lose the race, or ''. Never a nag: this is only set
   * when reaching the flag on the current instruction is a disqualification.
   */
  warning: string;
}

/**
 * The compounds worth offering here.
 *
 * Wets appear only when they are a real option. A dry Bahrain race that lists
 * WET as one of five equal choices is inviting a mistake that costs the race,
 * for no gain — and on a keyboard it is two extra presses between the driver
 * and the tyre they wanted.
 */
export function offeredCompounds(engine: RaceEngine, car: CarEntry): CompoundId[] {
  const wetsRelevant = engine.weather.wetness > 0.12 || engine.weather.hasRained;
  const list: CompoundId[] = [...DRY_COMPOUNDS];
  if (wetsRelevant) list.push(...WET_COMPOUNDS);
  // A compound already on the car for this stop stays offered even if the
  // conditions have since dried, so the selection can never point at a tile
  // that is not on screen.
  const chosen = car.pitCompoundRequest;
  if (chosen && !list.includes(chosen)) list.push(chosen);
  return list;
}

/** Everything the pit panel prints, derived from the engine, not remembered. */
export function pitSheet(engine: RaceEngine, car: CarEntry): PitSheet {
  const briefing = engine.pitBriefing(car);
  const fitting = engine.compoundForStint(car);
  const repairing = engine.noseChangeForStop(car);
  const byDriver = car.pitCompoundRequest !== null;
  const offered = offeredCompounds(engine, car);

  const tiles: PitTile[] = offered.map((id) => {
    const c = getCompound(id);
    return {
      id,
      code: c.code,
      name: c.name,
      colour: '#' + c.colour.toString(16).padStart(6, '0'),
      used: briefing.dryUsed.includes(id),
      selected: id === fitting,
      recommended: id === briefing.compound,
    };
  });

  const crewWants = getCompound(briefing.compound).name.toLowerCase();
  const note = briefing.lapsRemaining > 0
    ? briefing.lapsRemaining + ' laps left. We would go ' + crewWants + '.'
    : 'We would go ' + crewWants + '.';

  // The disqualification, and only the disqualification. `secondCompoundRequired`
  // says the rule is still outstanding; what matters is whether THIS stop — the
  // one being chosen right now — settles it. A driver who has run mediums and
  // is fitting mediums on the last stop is about to lose the result, and the
  // engine will not stop them, so the sheet has to say it.
  const warning = briefing.secondCompoundRequired && briefing.dryUsed.includes(fitting)
    ? 'You have run ' + getCompound(fitting).name.toLowerCase() +
      ' already — take a different dry compound or we are disqualified at the flag.'
    : '';

  const repairs: PitRepairOption[] = [
    { value: 'crew', label: 'CREW', selected: car.pitNoseChangeRequest === null },
    {
      value: 'change',
      label: briefing.noseChangeCostS >= 1
        ? 'NEW NOSE +' + Math.round(briefing.noseChangeCostS) + 's'
        : 'NEW NOSE',
      selected: car.pitNoseChangeRequest === true,
    },
    { value: 'keep', label: 'RUN IT', selected: car.pitNoseChangeRequest === false },
  ];

  return {
    fitting,
    repairing,
    byDriver,
    tiles,
    repairs,
    note,
    wingLabel: 'FRONT WING ' + Math.round(briefing.frontWing * 100) + '%',
    status: pitStatus(car, fitting, repairing),
    warning,
  };
}

/** Where the stop has got to, in the words the driver needs at that moment. */
function pitStatus(car: CarEntry, fitting: CompoundId, repairing: boolean): string {
  const tyre = getCompound(car.compound).name.toLowerCase();
  if (car.inPitBox) {
    return 'STATIONARY ' + car.pitBoxTimer.toFixed(1) + 's · ' + tyre + ' going on';
  }
  const wants = getCompound(fitting).name.toLowerCase();
  if (car.inPitLane) {
    const d = car.perception.pitBoxAheadM;
    return (d >= 0 ? 'BOX IN ' + Math.round(d) + 'm' : 'BOX AHEAD') +
      ' · ' + wants + (repairing ? ' + new nose' : '');
  }
  return 'BOX THIS LAP · ' + wants + (repairing ? ' + new nose' : '');
}

// ===========================================================================
// The three mutators
// ===========================================================================

/** Fits what the driver asked for. `null` hands the call back to the crew. */
export function setPitCompound(car: CarEntry, id: CompoundId | null): void {
  car.pitCompoundRequest = id;
}

/**
 * Steps the choice one tyre along the row.
 *
 * It steps from what is CURRENTLY GOING ON THE CAR, not from the last thing the
 * driver pressed. Those are the same once the driver has chosen, and different
 * before it — and starting from the crew's tyre is what makes the first press
 * of the button move the selection by one visible tile instead of jumping to
 * the end of the row.
 */
export function cyclePitCompound(engine: RaceEngine, car: CarEntry, dir: number): void {
  const offered = offeredCompounds(engine, car);
  if (offered.length === 0) return;
  const from = offered.indexOf(engine.compoundForStint(car));
  const step = dir >= 0 ? 1 : -1;
  const next = ((from < 0 ? 0 : from) + step + offered.length) % offered.length;
  car.pitCompoundRequest = offered[next];
}

/**
 * The front wing, as a decision the driver has made.
 *
 * Two states, not three. `crew` is the state of never having been asked, and a
 * button that cycles back into it would be a button that un-decides — the
 * driver would press it once too often and hand a nine-second call back to a
 * rule they cannot see. Once touched, it is theirs.
 */
export function togglePitRepair(engine: RaceEngine, car: CarEntry): void {
  car.pitNoseChangeRequest = !engine.noseChangeForStop(car);
}

/** Explicitly, for a pointer on a labelled control. */
export function setPitRepair(car: CarEntry, choice: RepairChoice): void {
  car.pitNoseChangeRequest = choice === 'crew' ? null : choice === 'change';
}

/** Wipes the driver's instructions. Called when the stop is waved off. */
export function clearPitOrder(car: CarEntry): void {
  car.pitCompoundRequest = null;
  car.pitNoseChangeRequest = null;
}
