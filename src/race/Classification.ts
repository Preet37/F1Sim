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

import { formatGap } from '../core/MathUtils';

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

/** The subset of a car the LIVE timing tower reads for its gap column. */
export interface RunningCar {
  position: number;
  retired: boolean;
  disqualified: boolean;
  bestLapTime: number;
  /** Seconds behind the car directly ahead on the road. Races only. */
  interval: number;
  /** Seconds behind the LEADER. Races only, and what the board prints. */
  gapToLeader: number;
  /** Whole laps behind the leader. Races only. */
  lapsDown: number;
  /** On an out-lap: circulating, not being timed. */
  onOutLap?: boolean;
}

/**
 * The gap column of the LIVE timing tower, while the session is running.
 *
 * THERE IS NO LEADER IN QUALIFYING. This is the same rule `resultGapCell`
 * enforces on the results board, and the tower had its own copy of the logic
 * that had never been brought into line with it — so a qualifying segment
 * printed the word LEADER against the quickest car and DNF against a car in
 * the barrier, both of which are race language.
 *
 * A Lap Time Classified Session is "any track running session during which the
 * classification of the session is determined based upon the time taken by a
 * driver to complete a single lap" (Section B, Definitions). Nobody is racing
 * anybody in one. There is no first place on the road to be leading, no
 * interval to the car ahead worth reading, and — Art. B2.4.3a-b — no DNF: a
 * driver is classified on the best time they set, and the three routes out of
 * the classification are the 107% rule, no time in Q1 and disqualification.
 * What there is instead is a fastest lap and everybody's deficit to it, which
 * is the one number the column should carry.
 *
 * A RACE keeps every word of the race language, because in a race all of it is
 * true. Somebody is leading, a lapped car is out of the fight, and a car in the
 * barrier did not cover the distance.
 *
 * `ahead` is the car directly in front on the road, used only to work out
 * whether this car is a lap down on it. Null for the car at the front.
 */
export function liveGapCell(
  car: RunningCar,
  ahead: Pick<RunningCar, 'lapsDown'> | null,
  fastest: Pick<RunningCar, 'bestLapTime'>,
  isRace: boolean,
): string {
  // Disqualification is a real outcome of every session type — Art. B2.4.3b.iii
  // makes a driver disqualified from Qualifying unclassified — so it is read
  // before anything else in both halves.
  if (car.disqualified) return 'DSQ';

  // `Out Lap`, from the 2025 qualifying board in `reference/target/69.png`:
  // P1 reads `LAW  Out Lap  H` because the car is circulating and not being
  // timed, which is a fact about the next thirty seconds that a deficit does
  // not carry. A car IN the pit lane is NOT written here — the reference puts
  // that at the right-hand edge as a `P` marker beside the compound, which is
  // `statusBadges`' job, and leaves this column showing the figure.
  if (car.onOutLap && !(isRace && car.bestLapTime > 0)) return 'Out Lap';

  if (!isRace) {
    // Art. B2.4.3a: the lap has been set and the accident does not un-set it.
    // The car is out of the session; the driver is still in the classification,
    // and the column exists to say how far off the pace they were.
    //
    // NO TIME, in the reference board's own words, for a driver who has not
    // set one. This used to be an em dash, which is the typography of a cell
    // with nothing to put in it rather than a statement about the car — and
    // "has not set a lap yet" is a real, common and interesting state, not an
    // absence. It is most of a qualifying board in the first three minutes.
    if (!(car.bestLapTime > 0)) return car.retired ? 'OUT' : 'NO TIME';
    if (!(fastest.bestLapTime > 0)) return 'NO TIME';
    // `<= 0` rather than `=== 0` so that a car whose lap is the reference lap
    // reads FASTEST even if the caller passed a fastest car chosen a step
    // earlier — a tower that flickers between FASTEST and -0.001 is worse than
    // one that is a frame stale.
    const deficit = car.bestLapTime - fastest.bestLapTime;
    return deficit <= 0 ? 'FASTEST' : formatGap(deficit);
  }

  if (car.retired) return 'DNF';
  // `Leader`, which is what the reference board prints in the leader's own
  // row, in italic. It used to be relabelled `Interval` by the tower — a
  // column heading standing in a row of figures — and #76 says copy the
  // reference.
  if (car.position === 1) return 'Leader';
  const lapsBehind = car.lapsDown - (ahead?.lapsDown ?? 0);
  if (lapsBehind > 0) return '+' + lapsBehind + (lapsBehind === 1 ? ' LAP' : ' LAPS');
  // TO THE LEADER, NOT TO THE CAR AHEAD, and the user settled it themselves.
  // Their annotation over the reference board (`reference/target/67.png`)
  // reads: "The distance- the time between each driver from the leader! (some
  // leaderboards show how far the driver is from the driver in front of
  // them)". The board they annotated is the first kind — +1.230, +2.557,
  // +3.658, a column that only ever increases down the page — and the column
  // here was the second, which is why the numbers ran +0.070, +1.704, +0.526
  // and read as noise.
  return formatGap(car.gapToLeader);
}

/** The subset of a car the qualifying board reads. */
export interface QualifyingCar {
  bestLapTime: number;
  /** True once the car left the pit lane in this period. */
  leftThePits?: boolean;
  /** True once the car began a flying lap in this period. */
  startedFlyingLap?: boolean;
}

/**
 * Which of Art. B2.4.3a.v's three groups a driver without a time falls into.
 *
 * "If more than one driver fails to set a lap time during Q2 or Q3 they will be
 * arranged in the following order: (A) Any driver who attempted to set a lap
 * time by starting a flying lap. (B) Any driver who failed to start a flying
 * lap. (C) Any driver who failed to leave the pits during the period."
 *
 * Lower sorts first, so this returns 0, 1, 2 in that order. It matters far more
 * than a tie-break between two anonymous slow cars sounds like it should: a
 * driver barred from the rest of qualifying under Art. B4.3.2 never leaves the
 * garage, so they are always in group (C), and every other driver who failed to
 * set a time in that period is therefore classified ahead of them. Sorting the
 * no-time cars arbitrarily instead was worth a grid slot either way.
 */
export function noTimeGroup(car: QualifyingCar): number {
  if (car.startedFlyingLap) return 0;
  if (car.leftThePits) return 1;
  return 2;
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
 *
 * "The back of the queue" is not one place. Art. B2.4.3a.v splits the drivers
 * who set no time into three groups — attempted a flying lap, never started
 * one, never left the pits — and orders them in that order, and only then falls
 * back on where they were classified in the previous period. `noTimeGroup` is
 * the first half of that; the second half is `runners` arriving in the previous
 * period's order, which the sort preserves because it is stable. That is why
 * `RaceEngine.participants` hands its cars back in the order the last segment
 * classified them rather than in car-number order.
 */
export function rankSegment<T extends QualifyingCar>(runners: readonly T[]): T[] {
  return runners.slice().sort((a, b) => {
    const at = a.bestLapTime > 0 ? a.bestLapTime : Infinity;
    const bt = b.bestLapTime > 0 ? b.bestLapTime : Infinity;
    if (at !== bt) return at - bt;
    // Both set a time and it was identical, or — far more often — neither set
    // one at all. Art. B2.4.3a.iv settles the first case on which was set
    // first, which stability already gives us; Art. B2.4.3a.v settles the
    // second.
    if (at === Infinity) return noTimeGroup(a) - noTimeGroup(b);
    return 0;
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
   *
   * WHY NOT JUST REPAIR THE CAR IN THE SEVEN-MINUTE BREAK. Because Art. B4.3.2
   * is about the driver, not the car: once the marshals have touched it the
   * entry takes no further part however quickly the crew work. The repair
   * question is real, but it is a question about the RACE, and it has a
   * counter-intuitive answer worth recording here so nobody re-derives the
   * wrong one:
   *
   *   Qualifying is under parc fermé throughout. Art. B3.5.1b — "each F1 Car
   *   will be deemed to be in parc fermé from the time ... at which it leaves
   *   the Pit Lane for the first time during Qualifying until the start of the
   *   Race". Not from the end of qualifying: from the car's first run in Q1.
   *
   * Under it the crew may still put the car back together — Art. B3.5.4 lets a
   * competitor change a broken or damaged part during Qualifying without asking
   * the Technical Delegate first, provided the part is like-for-like and the
   * broken one stays in view of the scrutineer, and Appendix B2 lists the rest
   * of the permitted work. What they may NOT do is change the setup: Art.
   * B3.5.3a makes the driver start the Race from the Pit Lane if they do.
   *
   * So a wrecked car is rebuilt for Sunday, on the setup it crashed on. This
   * game does not model a pit-lane start, so that consequence is not yet
   * enforceable here; the rule is written down so the next person to reach for
   * it does not have to find it twice.
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
