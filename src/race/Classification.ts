/**
 * Formatting for the classification a session ends on.
 *
 * Lives in its own module, away from the app shell, because the app shell boots
 * a whole game on import and this needs to be testable from a script. See
 * `npm run regress:results` and `npm run probe:qualiboard`.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a race and a Lap Time Classified
 * Session are classified by different things, and only one of them has a DNF in
 * it.
 *
 * The 2026 Sporting Regulations define a "Lap Time Classified Session" (LTCS)
 * as "any track running session during which the classification of the session
 * is determined based upon the time taken by a driver to complete a single lap.
 * Lap Time Classified Sessions include, but are not limited to, free practice
 * sessions, the sprint qualifying session and the qualifying session"
 * (Section B, Definitions). A race is classified on who covered the distance;
 * an LTCS is classified on a lap time and on nothing else.
 *
 * So there is no such thing as retiring from qualifying. Art. B2.4.3a orders
 * classified drivers purely by the best time each of them set, and Art. B2.4.3b
 * gives the ONLY three ways to fall out of the classification altogether:
 *
 *   i.   eliminated in Q1 with a best lap outside 107% of the fastest Q1 time,
 *        unless the Race Director declared the track wet;
 *   ii.  no lap time set in Q1 at all, or every lap time deleted;
 *   iii. disqualified from Qualifying by the stewards.
 *
 * Crashing is not on that list, and it could not be: the driver who set the
 * fastest lap of Q1 IS the 107% reference, so they clear (i) by definition and
 * clear (ii) by having set the lap. Once a time is on the board it belongs to
 * the driver whatever happens to the car afterwards.
 *
 * The bug this replaced was reported from a real session: the player set the
 * fastest lap of Q1 at Bahrain, a 1:49.758 drawn purple on the tower, put the
 * car in the barrier at Turn 4, and was shown "P20 — DNF". Both halves of that
 * were wrong. They were classified first in Q1 and through to Q2.
 */

/** The subset of a car the classification actually reads. */
export interface ClassifiedCar {
  position: number;
  retired: boolean;
  disqualified: boolean;
  bestLapTime: number;
  gapToLeader: number;
  lapsDown: number;
}

/**
 * How far down the classification a car is pushed for reasons other than pace.
 *
 * Lower sorts first. This is the whole of the "sort to the back" rule, in one
 * place, because it is a REGULATION and not a display detail — the live timing
 * tower, the results board and the grid all have to agree about it.
 *
 * Disqualification demotes in every session: Art. B2.4.3b.iii makes a driver
 * disqualified from Qualifying unclassified, and Art. B2.4.3b(B) puts those
 * drivers behind the ones unclassified for any other reason.
 *
 * Retirement demotes in a RACE and nowhere else. In a race a car that stops is
 * a car that did not cover the distance, so it is classified behind everyone
 * who did. In an LTCS there is no distance to cover — the classification is a
 * lap time, the lap time has already been set, and the car being in the barrier
 * does not un-set it (Art. B2.4.3a). Passing `isRace` false is what stops the
 * fastest driver in Q1 being sorted to twentieth by their own accident.
 */
export function classificationTier(
  car: { retired: boolean; disqualified: boolean },
  isRace: boolean,
): number {
  if (car.disqualified) return 2;
  if (car.retired && isRace) return 1;
  return 0;
}

/**
 * The leading result column: a gap in a race, a lap time everywhere else.
 *
 * The two halves are genuinely different questions. A race classifies on who
 * got there first, so the interesting number is the deficit to the winner. A
 * practice or qualifying session classifies on outright pace, so the interesting
 * number is the lap itself — there is no winner and no gap to the flag.
 *
 * This used to print the literal word WINNER for whoever was first, in every
 * session type. In a race that is fair enough. In FP2 it announced a winner of
 * free practice, and — worse — it did so in the column headed "Best", so the one
 * car whose lap time the player most wanted to see was the only car whose lap
 * time was replaced by a word.
 */
export function resultGapCell(car: ClassifiedCar, isRace: boolean): string {
  // DSQ everywhere: Art. B2.4.3b.iii makes a driver disqualified from
  // Qualifying unclassified, so it is a real outcome of an LTCS in a way that
  // retirement is not.
  if (car.disqualified) return 'DSQ';
  // DNF only in a race. This test used to sit above the `isRace` branch, which
  // is how a car that crashed out of Q1 after setting the fastest lap of the
  // session had its 1:49.758 replaced by the word DNF — in the one column that
  // exists to say how far off the pace a driver was, about the one driver who
  // was not off it at all. Qualifying has no DNF (Art. B2.4.3a-b); the lap
  // stands and the driver is classified on it.
  if (car.retired && isRace) return 'DNF';

  if (!isRace) {
    // Pace sessions: the deficit to the fastest car. The lap itself is in the
    // next column, so printing it here too would waste one of only seven columns
    // on a duplicate — which is what happened when this first stopped saying
    // WINNER. A timing screen exists to answer "by how much", and in practice
    // and qualifying that question is about pace, not about the flag.
    // Written as `> 0` rather than `<= 0` so a NaN lap time — which compares
    // false against everything — falls into the "no lap" branch rather than
    // sailing past a `<=` test and printing a gap for a car that never ran.
    if (car.position === 1) return car.bestLapTime > 0 ? 'FASTEST' : '—';
    if (!(car.bestLapTime > 0) || !Number.isFinite(car.gapToLeader)) return '--.---';
    return '+' + car.gapToLeader.toFixed(3);
  }

  if (car.position === 1) return 'WINNER';
  // A lapped car's gap is not a time anyone reads as a time. Twenty seconds and
  // a lap and twenty seconds look identical once you print them both in
  // seconds, and only one of them means the car is out of the fight.
  if (car.lapsDown >= 1) return '+' + car.lapsDown + (car.lapsDown === 1 ? ' LAP' : ' LAPS');
  if (!Number.isFinite(car.gapToLeader)) return '--.---';
  return '+' + car.gapToLeader.toFixed(3);
}

/** The subset of a car the qualifying board reads. */
export interface QualifyingCar {
  bestLapTime: number;
}

/**
 * One qualifying segment's runners, ranked by their best lap of it.
 *
 * No lap set goes to the back of the queue.
 *
 * THE BUG THIS PREVENTS. `RaceEngine.standings` ranks every car on best lap,
 * and after Q1 that is the wrong order for a qualifying board: a car knocked
 * out in Q1 keeps its Q1 lap, which is routinely quicker than a survivor's
 * first run in Q2, so the two interleave and the board reads as though somebody
 * eliminated is still in the fight. The segment has its own order and this is
 * it.
 *
 * Shared between the grid resolution and the results board on purpose. The
 * board exists to tell the player what just happened to the grid; a second sort
 * on the screen side would be a second implementation of knockout qualifying,
 * and the two would disagree the first time either was touched — leaving the
 * screen confidently wrong about the one thing it is for.
 */
export function rankSegment<T extends QualifyingCar>(runners: readonly T[]): T[] {
  return runners.slice().sort((a, b) => {
    const at = a.bestLapTime > 0 ? a.bestLapTime : Infinity;
    const bt = b.bestLapTime > 0 ? b.bestLapTime : Infinity;
    return at - bt;
  });
}

/**
 * Where the cut falls, and what sits below it.
 *
 * Returns the runners in order, the index the cut line is drawn after, and the
 * cars already knocked out in an earlier segment — which belong on the board
 * beneath everyone still running, holding the grid slots they earned, rather
 * than interleaved by a lap time they set in a different session.
 */
export function qualifyingBoardOrder<T extends QualifyingCar & { eliminated: boolean;
  eliminatedInPhase: number }>(
  participants: readonly T[], allCars: readonly T[], advancing: number | undefined,
): { runners: T[]; alreadyOut: T[]; cutAfter: number } {
  const runners = rankSegment(participants);
  const alreadyOut = allCars.filter((c) => c.eliminated)
    .sort((a, b) => b.eliminatedInPhase - a.eliminatedInPhase);
  // A cut only exists when somebody is actually being knocked out, and only
  // when there are more runners than places. Q3 has neither.
  const cutAfter = advancing !== undefined && advancing < runners.length ? advancing : -1;
  return { runners, alreadyOut, cutAfter };
}

// ===========================================================================
// The knockout itself
// ===========================================================================

/** One car's standing at the end of a segment, as the knockout reads it. */
export interface SegmentEntrant {
  /** Stable identity across segments. The player's entry is 'PLAYER'. */
  id: string;
  /**
   * True if this car's session ended in the hands of the marshals.
   *
   * Art. B4.3.2: "Any driver whose F1 Car stops in any area other than the Pit
   * Lane during Sprint Qualifying or Qualifying and receives physical
   * assistance will not be permitted to take any further part in that session."
   */
  retired: boolean;
}

/** What one segment did to the grid and to the entry list for the next one. */
export interface SegmentResolution {
  /** This segment's classification, fastest first, no-lap cars last. */
  order: string[];
  /**
   * Cars entered in the NEXT segment. Art. B2.4.2a-b: the slowest are
   * "prohibited from taking any further part", the rest are "permitted on the
   * track" in the period that follows.
   */
  survivors: string[];
  /** Knocked out here. They take the grid slots from `advancing` downwards. */
  knockedOut: string[];
  /**
   * Survivors who are entered in the next segment but may not run in it.
   *
   * These are Art. B4.3.2's cars. They are still entered and still classified —
   * the regulation bars the driver from taking further PART, it does not strike
   * them from the entry list, and Art. B2.4.3b does not make them unclassified.
   * So they are ranked in the next segment among the cars that set no time,
   * under Art. B2.4.3a.v(C), "any driver who failed to leave the pits during
   * the period".
   *
   * This is the difference between a grid slot of P15 and a grid slot of P20,
   * and it is the whole reason a crash in Q1 is not the end of a weekend.
   */
  barred: string[];
}

/**
 * Turns one segment's runners into a grid decision.
 *
 * `entrants` must already be in this segment's classification order — that is
 * `rankSegment`'s job, and doing it here as well would be a second
 * implementation of the one sort the grid and the board both depend on.
 *
 * `advancing` is undefined for Q3, where nobody is knocked out and the whole
 * order simply fills the front of the grid.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never consults `retired` to decide
 * who advances. A retirement is not a qualifying result (Art. B2.4.3a-b); the
 * only thing it decides is whether the driver may run again, which is what
 * `barred` carries. A car that retires having topped the segment advances at
 * the top of the survivor list exactly like a car that drove back to its
 * garage.
 */
export function resolveSegment(
  entrants: readonly SegmentEntrant[],
  advancing: number | undefined,
): SegmentResolution {
  const order = entrants.map((e) => e.id);
  if (advancing === undefined || order.length <= advancing) {
    return {
      order,
      survivors: order.slice(),
      knockedOut: [],
      barred: entrants.filter((e) => e.retired).map((e) => e.id),
    };
  }
  const survivors = entrants.slice(0, advancing);
  return {
    order,
    survivors: survivors.map((e) => e.id),
    knockedOut: entrants.slice(advancing).map((e) => e.id),
    // Only survivors can be barred from anything: a car already knocked out has
    // no further segment to be kept out of.
    barred: survivors.filter((e) => e.retired).map((e) => e.id),
  };
}
