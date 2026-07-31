import { RaceEngine, type SessionConfig } from './RaceEngine';
import type { CarEntry } from './CarEntry';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import type { Driver } from '../data/teams';

/**
 * Simulating a session the player chose not to drive.
 *
 * The point of this file is that a skipped session is the SAME session. It is
 * not a lookup table, not a shuffle of the championship order and not a
 * statistical model fitted to one: it is the actual `RaceEngine`, with the same
 * twenty cars, the same circuit, the same tyres and the same race control,
 * stepped as fast as the machine will go with nothing drawn. A grid produced
 * this way is a grid those drivers really earned, and the qualifying gaps in it
 * are the gaps their cars really produce — which is the only way a skipped Q1
 * can hand a trustworthy result to a race the player does intend to drive.
 *
 * Two things make that affordable.
 *
 * The first is that rendering is most of the per-frame cost, and there is none
 * here. Measured on this machine, a nine-minute qualifying segment at Bahrain
 * runs in 5.6 seconds of wall clock — around 60x realtime.
 *
 * The second is the early exit. A qualifying segment exists to rank cars on
 * their best lap, and once every car has completed an out-lap and two timed
 * laps, another six minutes of circulating almost never changes the order. So
 * the simulation stops there rather than running the clock down, which is what
 * turns a 540-second segment into roughly 340 seconds of simulation. The
 * remaining time is not skipped in a race: a race has to reach its own end.
 *
 * The work is handed out in wall-clock slices so the page can paint a progress
 * bar between them. Running it in one synchronous burst would freeze the tab for
 * the whole of those five seconds with no indication that anything was
 * happening, which is indistinguishable from a crash.
 */

/** A classification produced without the player driving. */
export interface SimulatedSessionResult {
  /** Driver ids in classified order. The player's own id is 'PLAYER'. */
  order: string[];
  /** Best lap per driver id, seconds. Zero where no lap was set. */
  bestLaps: Map<string, number>;
  /** Seconds of session simulated. */
  simSeconds: number;
  /** Wall-clock milliseconds spent. */
  wallMs: number;
}

/** Timed laps every car needs before a qualifying segment can be cut short. */
const QUALIFYING_TIMED_LAPS = 2;

export class HeadlessSession {
  readonly engine: RaceEngine;
  private readonly playerDriverId: string;
  private wallMs = 0;
  private finished = false;

  constructor(
    def: TrackDefinition,
    config: SessionConfig,
    field: Driver[] | undefined,
    playerDriverId: string,
  ) {
    // playerIndex -1 means every car in the field is driven by the AI,
    // including the player's own entry — which is the whole point: the car
    // still has the player's driver record, their team and their skill, so the
    // result is what that driver would plausibly have done. A car with no
    // controller at all would simply sit in its garage and qualify last.
    this.engine = new RaceEngine(def, { ...config, playerIndex: -1 }, field);
    this.playerDriverId = playerDriverId;
  }

  get done(): boolean {
    return this.finished || this.engine.over;
  }

  /**
   * How far through, 0..1.
   *
   * Reported against whichever of the two termination conditions is nearer, so
   * the bar does not sit at 40% and then jump to done when the early exit fires.
   */
  get progress(): number {
    const e = this.engine;
    if (this.done) return 1;
    if (e.config.kind === 'race') {
      const laps = e.config.laps || e.track.def.raceLaps;
      const leader = e.standings[0];
      return clamp01(leader ? (leader.lap + leader.s / e.track.length) / laps : 0);
    }
    const byClock = e.config.durationS > 0 ? e.time / e.config.durationS : 0;
    return clamp01(Math.max(byClock, this.classifiedFraction()));
  }

  /** Fraction of the field that has a lap time and has run enough of them. */
  private classifiedFraction(): number {
    const cars = this.engine.participants;
    if (cars.length === 0) return 1;
    let ready = 0;
    for (const c of cars) {
      if (c.retired || (c.bestLapTime > 0 && c.lap >= QUALIFYING_TIMED_LAPS + 1)) ready++;
    }
    return ready / cars.length;
  }

  /**
   * Steps the simulation for up to `budgetMs` of wall clock.
   *
   * The step count between clock reads is deliberately coarse. `performance.now`
   * is not free, and checking it after every 8ms physics step would spend a
   * measurable slice of the budget asking what time it is.
   */
  advance(budgetMs: number): void {
    if (this.done) return;
    const t0 = performance.now();
    const e = this.engine;
    const canExitEarly = e.config.kind !== 'race';

    for (;;) {
      for (let i = 0; i < 240 && !e.over; i++) e.step();
      if (e.over) break;
      if (canExitEarly && this.classifiedFraction() >= 1) {
        this.finished = true;
        break;
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
    this.wallMs += performance.now() - t0;
  }

  /** Runs to completion in one go. For headless probes, not for the UI. */
  runToCompletion(): SimulatedSessionResult {
    while (!this.done) this.advance(1e9);
    return this.result();
  }

  /** The classification, with the player's entry named 'PLAYER'. */
  result(): SimulatedSessionResult {
    const e = this.engine;
    const id = (c: CarEntry) => (c.driver.id === this.playerDriverId ? 'PLAYER' : c.driver.id);

    // Qualifying and practice classify on best lap; a race classifies on the
    // engine's own standings, which already account for laps, penalties and
    // retirements.
    const ranked = e.config.kind === 'race'
      ? e.standings.slice()
      : e.participants.slice().sort((a, b) => {
          const at = a.bestLapTime > 0 ? a.bestLapTime : Infinity;
          const bt = b.bestLapTime > 0 ? b.bestLapTime : Infinity;
          return at - bt;
        });

    const bestLaps = new Map<string, number>();
    for (const c of e.cars) bestLaps.set(id(c), c.bestLapTime);

    return {
      order: ranked.map(id),
      bestLaps,
      simSeconds: e.time,
      wallMs: this.wallMs,
    };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
