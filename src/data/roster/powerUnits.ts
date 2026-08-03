/**
 * Power-unit manufacturers, 2026 regulations.
 *
 * THE BOUNDARY. This file, and the rest of `src/data/roster/`, is the only place
 * in the codebase that names anything real. Everything downstream consumes the
 * generic `PowerUnit` interface, so replacing the real grid with a fictional one
 * is a matter of writing a second module with the same exports. See
 * `docs/CAREER_MODE.md` section 0 for the rule this enforces: names are used,
 * marks are not — no logo, badge or wordmark is reproduced anywhere.
 *
 * WHAT THE NUMBERS ARE. `powerMult`, `ersMult` and `reliability` are multipliers
 * on the base F1 spec in exactly the sense `specForTeam` means them, so a power
 * unit is not a label on a menu: choosing one changes `icePowerW` and `ersPowerW`
 * on the car the physics integrates, and it shows up in a speed trap.
 *
 * They are this project's estimates, not published figures — nobody publishes
 * 2026 power-unit outputs — chosen so the resulting championship order is
 * plausible and the spread between the best and worst unit is worth about the
 * three tenths a lap that an engine advantage is historically worth.
 *
 * The 2026 formula splits output far more evenly between the combustion engine
 * and the electrical side than the previous one did, which is why `ersMult`
 * carries more weight here than it would have for a 2022-spec car.
 */

export interface PowerUnit {
  id: string;
  /** Manufacturer name as it appears on an entry list. */
  name: string;
  /** Short form for the timing tower and the car's engine line. */
  shortName: string;

  /** Multiplies the base spec's internal-combustion power. */
  powerMult: number;
  /** Multiplies the base spec's MGU-K deployment power. */
  ersMult: number;
  /**
   * Contribution to the team's per-race terminal failure probability.
   *
   * Added to the chassis's own failure rate rather than multiplying it, because
   * a power unit failure and a gearbox failure are independent events and a
   * reliable chassis cannot rescue an unreliable engine.
   */
  failureRate: number;

  /** Cost of a customer supply deal, per season, in dollars. */
  costPerSeasonUsd: number;

  /**
   * Team id of the works entry, or null for a supplier with no team of its own.
   *
   * A works team is served first: it gets the current specification, and
   * customers get it a season late if the manufacturer is protecting an
   * advantage. That is modelled by `customerPenalty`.
   */
  worksTeamId: string | null;
  /** Fraction of the works performance a customer actually receives. */
  customerPenalty: number;

  /**
   * Reputation a team needs before this manufacturer will discuss a deal.
   *
   * The reason a struggling team cannot simply buy the best engine, and the
   * reason the engine choice is a consequence of the rest of the career rather
   * than a free pick on a menu.
   */
  minReputation: number;

  /** Season this manufacturer will supply customers from. */
  customersFrom: number;

  /**
   * How the unit develops over a career.
   *
   * A new programme starts behind and catches up; an established one is already
   * near its ceiling. Applied each off-season, so the right deal in season one
   * is not the right deal in season six.
   */
  developmentRate: number;
}

export const POWER_UNITS: readonly PowerUnit[] = [
  {
    id: 'mercedes-pu',
    name: 'Mercedes-AMG High Performance Powertrains',
    shortName: 'Mercedes',
    // The strongest all-round unit and the most expensive: good peak power, the
    // best deployment, and the reliability of a programme that has been at this
    // since 2014.
    powerMult: 1.030, ersMult: 1.045, failureRate: 0.022,
    costPerSeasonUsd: 21_000_000,
    worksTeamId: 'mercedes', customerPenalty: 0.994,
    minReputation: 45, customersFrom: 2026, developmentRate: 0.72,
  },
  {
    id: 'ferrari-pu',
    name: 'Ferrari',
    shortName: 'Ferrari',
    // Highest peak power on the grid and it costs them: a hotter, thirstier unit
    // that fails more often. Historically the accurate shape of this engine.
    powerMult: 1.042, ersMult: 1.010, failureRate: 0.040,
    costPerSeasonUsd: 19_500_000,
    worksTeamId: 'ferrari', customerPenalty: 0.992,
    minReputation: 35, customersFrom: 2026, developmentRate: 0.78,
  },
  {
    id: 'redbull-ford',
    name: 'Red Bull Ford Powertrains',
    shortName: 'RB Ford',
    // A first-year programme. Strong on the electrical side, where the 2026
    // rules put half the output, and unreliable in the way every new
    // manufacturer's first unit is. The highest development rate on the grid,
    // so a career that starts here is a bet that pays off around season three.
    powerMult: 0.996, ersMult: 1.035, failureRate: 0.062,
    costPerSeasonUsd: 16_000_000,
    worksTeamId: 'red-bull', customerPenalty: 0.998,
    minReputation: 30, customersFrom: 2026, developmentRate: 0.92,
  },
  {
    id: 'honda-pu',
    name: 'Honda Racing Corporation',
    shortName: 'Honda',
    // The reliability benchmark, with a modest peak. A team that finishes every
    // race with this unit will out-score a faster one that does not.
    powerMult: 1.008, ersMult: 1.020, failureRate: 0.018,
    costPerSeasonUsd: 17_500_000,
    // Honda's 2026 works relationship is with Aston Martin.
    worksTeamId: 'aston-martin', customerPenalty: 0.995,
    minReputation: 40, customersFrom: 2026, developmentRate: 0.68,
  },
  {
    id: 'audi-pu',
    name: 'Audi Formula Racing',
    shortName: 'Audi',
    // Works-only at first, which is the real arrangement and also the most
    // interesting one for a career: the best available customer deal changes
    // when Audi opens its doors, and the player has to be ready for it.
    powerMult: 0.988, ersMult: 1.008, failureRate: 0.055,
    costPerSeasonUsd: 15_000_000,
    worksTeamId: 'audi', customerPenalty: 0.996,
    minReputation: 55, customersFrom: 2029, developmentRate: 0.88,
  },
];

const BY_ID = new Map(POWER_UNITS.map((p) => [p.id, p]));

export function getPowerUnit(id: string): PowerUnit {
  const p = BY_ID.get(id);
  if (!p) throw new Error('Unknown power unit: ' + id);
  return p;
}

/**
 * The supplier a screen falls back to when no offer is open.
 *
 * IT LIVES HERE BECAUSE THIS DIRECTORY IS THE IP BOUNDARY. PROJECT.md §3 keeps
 * every real 2026 team, driver and manufacturer name inside `src/data/roster/`
 * so swapping the whole lot for fictional ones is one import; a screen in
 * `src/ui/` that names `'redbull-ford'` in a fallback puts a real manufacturer
 * outside that boundary and quietly makes the swap a two-place edit. Derived
 * from the list rather than written out again, so it cannot name a unit that
 * does not exist and it survives the roster being replaced wholesale.
 */
export const FALLBACK_POWER_UNIT_ID: string = POWER_UNITS[0].id;

/**
 * The effective multipliers a team gets from its supply deal.
 *
 * Split out from the record itself because a works team and a customer running
 * the same manufacturer do not get the same engine, and the difference has to be
 * applied somewhere the physics can see it.
 */
export function powerUnitFor(
  unit: PowerUnit, teamId: string,
): { powerMult: number; ersMult: number; failureRate: number } {
  const works = unit.worksTeamId === teamId;
  const k = works ? 1 : unit.customerPenalty;
  return {
    powerMult: unit.powerMult * k,
    ersMult: unit.ersMult * k,
    // A customer also gets the older reliability fixes later.
    failureRate: unit.failureRate * (works ? 1 : 1.12),
  };
}
