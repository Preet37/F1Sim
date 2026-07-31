/**
 * Formatting for the classification a session ends on.
 *
 * Lives in its own module, away from the app shell, because the app shell boots
 * a whole game on import and this needs to be testable from a script. See
 * `npm run regress:results`.
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
  if (car.disqualified) return 'DSQ';
  if (car.retired) return 'DNF';

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
