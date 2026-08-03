/**
 * Which car in the entry list the human is driving.
 *
 * One function, in its own module, because it is the answer to the single worst
 * bug this career mode has had and the only way to keep it fixed is for the
 * probe and the game to call the SAME code rather than two copies of it.
 *
 * `SessionConfig.playerIndex` is an index into the entry list. Every session
 * config in `main.ts` was built with it hard-coded to zero, which is correct
 * outside a career — a quick race field is the static grid and the player is
 * `DRIVERS[0]` — and wrong inside one.
 *
 * A career field is `Career.grid()`: every seat in the championship, in TEAM
 * order, because the pit lane paints two boxes in front of each garage and the
 * paddock is built from the same anchor. A rookie starts at the weakest team,
 * which is the last team in that order, so the player's own entry is index
 * nineteen of twenty. Index zero belongs to the first driver of the strongest
 * team.
 *
 * So the human drove somebody else's car, under somebody else's name, number,
 * nationality and colours, for the whole of career mode, while their own driver
 * record sat at the back of the grid being driven by the AI. That is what
 * "I can change my name on the front page, but that doesn't change anything
 * else that's happening in the qualifying, the actual runs at all" was. It was
 * never a display bug — the name was absent because the driver was.
 *
 * It compounded: knockout qualifying keys its grid on `isPlayer ? 'PLAYER'`,
 * and in a career the player's real driver id IS `'PLAYER'`, so two different
 * cars reported the same key into the same grid array.
 */

/** The minimum a field entry has to be for a seat to be found in it. */
export interface Seatable {
  id: string;
}

/**
 * The index of the player's own car in a field, or 0 when there is no career.
 *
 * Falls back to zero rather than to -1 on a miss, because -1 means "nobody is
 * driving" to `RaceEngine` and a player handed a session with no car at all is
 * a worse failure than a player handed the wrong one. A miss should be
 * impossible — `Career.grid()` always contains the player — and `probe:identity`
 * asserts that it is.
 */
export function playerIndexIn(
  field: readonly Seatable[] | undefined, playerDriverId: string,
): number {
  if (!field || field.length === 0) return 0;
  const i = field.findIndex((d) => d.id === playerDriverId);
  return i >= 0 ? i : 0;
}
