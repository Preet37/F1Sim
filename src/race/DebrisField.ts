import {
  MARSHAL_REACH_BASE_S,
  MARSHAL_REACH_PER_M_S,
  RECOVERY_BACKSTOP_S,
} from './Recovery';

/**
 * The carbon on the circuit, and who is going to pick it up.
 *
 * WHY THIS IS IN THE RACE LAYER AND NOT IN THE RENDERER
 *
 * Debris used to be purely a rendering effect: `Renderer.drainImpacts` threw
 * shards into an `InstancedMesh` and the only thing that ever took them away
 * again was `Wreckage.clearOwner`, called when the car they came off was
 * RECOVERED. A car that loses a sidepod and keeps racing is never recovered, so
 * its bodywork stayed on the road until the session ended. Six contact events
 * in two laps left six permanent piles of it, which is the "why are there blue
 * pieces everywhere" report, and no amount of retinting them fixes a piece of
 * carbon that never goes away.
 *
 * The fix is not a lifetime. In the sport, debris on the racing line is an
 * incident: a marshal post shows a yellow, somebody walks out and collects it,
 * and the sector goes green again when they are back behind the barrier. That
 * is a sequence this project already models — for cars, in `Recovery.ts`, and
 * the flags in `RaceControlManager` — and the reason the ledger lives here
 * rather than in the renderer is that flags change how the race is DRIVEN. A
 * headless simulation and a rendered one have to produce the same race, so the
 * thing that raises the flag cannot live in the half of the program that only
 * exists when there is a screen.
 *
 * WHAT DECIDES HOW LONG A PILE LASTS. Where it landed, and nothing else:
 *
 *   ON THE RACING SURFACE it is a hazard. The post covering it shows a yellow,
 *   marshals are sent, and they collect it — under the local yellow, because a
 *   piece of bodywork is picked up by hand and does not need a crane or a
 *   closed circuit. Half a minute or so, which is what it looks like on
 *   television.
 *
 *   IN THE RUN-OFF it is nobody's priority. It stays where it is until the race
 *   is neutralised for something else and the marshals have time for it, which
 *   is also what really happens — the outside of a fast corner accumulates
 *   carbon over a race distance and it is swept up afterwards.
 *
 * Neither branch is a timer chosen to look right. The backstop is, and it is
 * the same backstop `Recovery` has and for the same reason: an operation whose
 * precondition never arrives must still finish, or a yellow flag outlives the
 * race.
 */

/**
 * How far beyond the white line a piece still counts as being on the racing
 * surface, metres.
 *
 * Half a car's width. A shard sitting on the line itself is one a car will
 * touch, and race control does not distinguish between "on the paint" and "just
 * inside it" — this is the same judgement `RaceControlManager` makes about a
 * car that has run wide.
 */
export const DEBRIS_ON_SURFACE_MARGIN_M = 0.9;

/** Seconds a marshal spends collecting one piece of bodywork by hand. */
export const DEBRIS_COLLECT_S = 14;

/**
 * The most piles the ledger tracks at once.
 *
 * Bounded for the same reason the instanced mesh is: a first-corner accident
 * involving the whole field must not be able to grow this without limit. The
 * oldest pile is dropped when the cap is reached, and the renderer is told, so
 * the two never disagree about what is on the circuit.
 */
export const DEBRIS_MAX_PILES = 48;

export type DebrisPhase = 'reported' | 'reaching' | 'collecting' | 'clear';

/**
 * One part's worth of bodywork on the ground, and the operation to remove it.
 *
 * A pile, not a shard. The renderer draws several pieces per pile — a wing does
 * not break into one thing — but the marshals walk to a place once and pick up
 * what is there, so the operation is per place.
 */
export class DebrisPile {
  /** Identity, so the renderer can retire exactly this pile's shards. */
  readonly id: number;

  /** Lap distance the pile lies at, metres. */
  readonly s: number;
  /** Signed lateral offset from the centreline, positive to the left, metres. */
  readonly lateralM: number;
  /** True while it is where the cars run. */
  readonly onSurface: boolean;
  /** Which car shed it, so a recovery takes its bodywork with it. */
  readonly ownerIndex: number;

  /** World position of the shed point, handed straight to the renderer. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The car's velocity when it let go — debris lands ahead of a moving car. */
  readonly vx: number;
  readonly vz: number;
  /** Bounding size of the part it came off, metres. */
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** How many pieces it broke into. */
  readonly pieces: number;
  /**
   * What shed it: 0 for loose carbon off a contact, otherwise the index in
   * `BODY_PART_IDS` plus one.
   *
   * A number rather than the part id, because `BodyPartId` names a piece of the
   * car's MESH as well as a piece of the car, and the ledger has no business
   * depending on a mesh. The renderer uses it to start the shards at the point
   * the part was bolted to rather than at the car's centre.
   */
  readonly source: number;

  /** True once it has been collected. */
  done = false;

  /** Seconds since it landed. */
  elapsedS = 0;
  /** Marshal travel still to run, seconds. */
  reachRemainingS: number;
  /** Collection still to run once they are at it, seconds. */
  workRemainingS: number;

  constructor(init: {
    id: number; s: number; lateralM: number; onSurface: boolean; ownerIndex: number;
    x: number; y: number; z: number; vx: number; vz: number;
    sizeX: number; sizeY: number; sizeZ: number; pieces: number; source: number;
    offRoadM: number;
  }) {
    this.id = init.id;
    this.s = init.s;
    this.lateralM = init.lateralM;
    this.onSurface = init.onSurface;
    this.ownerIndex = init.ownerIndex;
    this.x = init.x; this.y = init.y; this.z = init.z;
    this.vx = init.vx; this.vz = init.vz;
    this.sizeX = init.sizeX; this.sizeY = init.sizeY; this.sizeZ = init.sizeZ;
    this.pieces = init.pieces;
    this.source = init.source;
    // The same walk `Recovery` costs, from the same constants: the marshals
    // come from their own post whether what they are collecting is a car or a
    // wing endplate.
    this.reachRemainingS =
      MARSHAL_REACH_BASE_S + Math.max(init.offRoadM, 0) * MARSHAL_REACH_PER_M_S;
    this.workRemainingS = DEBRIS_COLLECT_S;
  }

  /**
   * Runs the operation for one step.
   *
   * @param neutralised true while the race is under a safety car or VSC, which
   *        is the only time anybody goes out for the carbon in the run-off
   * @returns true on the step the pile is finally gone
   */
  advance(dt: number, neutralised: boolean): boolean {
    if (this.done) return false;
    this.elapsedS += dt;

    // Off the racing surface, nothing happens at all until the race is slowed
    // down for something else. This is the whole of "run-off debris persists":
    // it is not a longer timer, it is an operation with a precondition that may
    // simply never arrive during the race.
    if (!this.onSurface && !neutralised) return this.checkBackstop();

    if (this.reachRemainingS > 0) {
      this.reachRemainingS -= dt;
      if (this.reachRemainingS > 0) return this.checkBackstop();
      this.reachRemainingS = 0;
    }

    this.workRemainingS -= dt;
    if (this.workRemainingS <= 0) {
      this.workRemainingS = 0;
      this.done = true;
      return true;
    }
    return this.checkBackstop();
  }

  private checkBackstop(): boolean {
    if (this.elapsedS < RECOVERY_BACKSTOP_S) return false;
    this.reachRemainingS = 0;
    this.workRemainingS = 0;
    this.done = true;
    return true;
  }

  get phase(): DebrisPhase {
    if (this.done) return 'clear';
    if (!this.onSurface) return 'reported';
    return this.reachRemainingS > 0 ? 'reaching' : 'collecting';
  }

  /**
   * What the posts covering this pile display.
   *
   * A single waved yellow, and never a double: a hazard beside or on the track
   * with marshals attending to it is ISC Appendix H Art. 2.5.5b's first case,
   * and the second case — the one that warrants a double — is a hazard
   * "wholly or partly blocking the track". A wing endplate is not blocking the
   * track. This is also why debris on its own never counts toward a safety car:
   * the article that deploys one is about people in immediate physical danger,
   * and a marshal picking up carbon under a local yellow is the routine
   * alternative to that, not a case of it.
   */
  get signal(): 'yellow' | null {
    return this.done || !this.onSurface ? null : 'yellow';
  }
}

/** Everything currently lying on the circuit. */
export class DebrisField {
  /** Piles that have not yet been collected. */
  readonly piles: DebrisPile[] = [];

  /**
   * Piles created since the renderer last looked, and piles removed since.
   *
   * Two queues rather than the renderer diffing the list every frame. The
   * renderer has to do something at each end — build shards for a new pile,
   * retire the shards of a gone one — and both are edges, not states.
   */
  readonly spawned: DebrisPile[] = [];
  readonly removed: number[] = [];

  private nextId = 1;

  reset(): void {
    this.piles.length = 0;
    this.spawned.length = 0;
    this.removed.length = 0;
    this.nextId = 1;
  }

  /**
   * Records a part's worth of bodywork on the ground.
   *
   * @param offRoadM metres beyond the white line; negative on the road
   */
  add(init: {
    s: number; lateralM: number; ownerIndex: number;
    x: number; y: number; z: number; vx: number; vz: number;
    sizeX: number; sizeY: number; sizeZ: number; pieces: number; source: number;
    offRoadM: number;
  }): DebrisPile {
    const pile = new DebrisPile({
      ...init,
      id: this.nextId++,
      onSurface: init.offRoadM < DEBRIS_ON_SURFACE_MARGIN_M,
    });
    this.piles.push(pile);
    this.spawned.push(pile);
    // Oldest first, so a pile-up cannot grow the ledger without bound and the
    // thing that gets dropped is the one that has already been looked at.
    while (this.piles.length > DEBRIS_MAX_PILES) {
      const gone = this.piles.shift()!;
      gone.done = true;
      this.removed.push(gone.id);
    }
    return pile;
  }

  /** Runs every outstanding operation for one step. */
  advance(dt: number, neutralised: boolean): DebrisPile[] {
    const collected: DebrisPile[] = [];
    for (let i = this.piles.length - 1; i >= 0; i--) {
      const pile = this.piles[i];
      if (pile.advance(dt, neutralised)) {
        collected.push(pile);
        this.piles.splice(i, 1);
        this.removed.push(pile.id);
      }
    }
    return collected;
  }

  /**
   * Sweeps up everything one car left, because that car has been recovered.
   *
   * A crane lifts the wreck and the marshals sweep after it: a corner race
   * control has declared clear does not still have half a front wing on the
   * racing line. This is the one path that was already right, kept.
   */
  clearOwner(ownerIndex: number): void {
    for (let i = this.piles.length - 1; i >= 0; i--) {
      if (this.piles[i].ownerIndex !== ownerIndex) continue;
      this.piles[i].done = true;
      this.removed.push(this.piles[i].id);
      this.piles.splice(i, 1);
    }
  }

  /** How many piles are lying where the cars run. */
  get onSurfaceCount(): number {
    let n = 0;
    for (const p of this.piles) if (p.onSurface) n++;
    return n;
  }
}
