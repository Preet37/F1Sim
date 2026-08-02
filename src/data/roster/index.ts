import { F1_2026 } from './f1-2026';
import { F2_2026, F3_2026 } from './junior';
import type { RosterTier, TierId } from './types';

export type { RosterTeam, RosterDriver, RosterTier, TierId } from './types';
export { POWER_UNITS, getPowerUnit, powerUnitFor, type PowerUnit } from './powerUnits';
export { F1_2026 } from './f1-2026';
export { F2_2026, F3_2026 } from './junior';

/**
 * The whole real-world roster, and the only surface anything outside this
 * directory is allowed to import.
 *
 * SWAPPING IT OUT. Write a second module exporting a `Roster` of the same shape
 * with fictional entrants, and change the one import in `src/career/World.ts`.
 * Nothing else in the codebase names a real team or driver, so that edit is the
 * entire job — which is the point, because the real names are the one thing that
 * would have to go if this were ever published rather than played at home.
 *
 * `src/data/teams.ts` keeps its own fictional grid, which is what Quick Race and
 * every one of the twenty-five existing probes still measure against. Career
 * mode installs the roster over the top of it and takes it down again on exit,
 * so nothing already validated moves by a millisecond.
 */
export interface Roster {
  /** Season the roster describes. Careers start here. */
  season: number;
  tiers: Record<TierId, RosterTier>;
}

export const REAL_ROSTER: Roster = {
  season: 2026,
  tiers: { F1: F1_2026, F2: F2_2026, F3: F3_2026 },
};

/** The tiers, bottom to top. The order promotion walks. */
export const TIER_ORDER: readonly TierId[] = ['F3', 'F2', 'F1'];

export function tierAbove(tier: TierId): TierId | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

export function rosterFor(tier: TierId, roster: Roster = REAL_ROSTER): RosterTier {
  return roster.tiers[tier];
}
