/**
 * The shape of a Grand Prix weekend.
 *
 * Kept here rather than inline in the app shell so the headless probes can test
 * the format that actually ships. A qualifying segment that is too short to
 * complete an out-lap plus a flying lap classifies nobody, and that is a bug
 * you want a script to catch rather than a player.
 *
 * Durations are compressed from the real 18/15/12 minutes, but every segment is
 * sized against the real constraint: the last car released from the garage must
 * have time to serve the pit lane, complete an out-lap, and then set at least
 * two representative flying laps.
 *
 *   last release          ~23s   (19 cars at GARAGE_RELEASE_GAP_S apart)
 *   pit transit           ~30s   at the 80 km/h limit
 *   out-lap to the line   ~90s   a full lap of a long circuit
 *   ------------------------------------------------------------------
 *   first flying lap starts around 145s
 *
 * So a segment needs roughly 145s plus two laps. The values below clear that
 * with margin on the longest circuit on the calendar.
 */

export interface QualifyingSegment {
  phase: 1 | 2 | 3;
  name: string;
  durationS: number;
  /** Cars surviving to the next segment. Undefined for Q3. */
  advancing?: number;
}

export const QUALIFYING_SEGMENTS: readonly QualifyingSegment[] = [
  { phase: 1, name: 'Q1', durationS: 540, advancing: 15 },
  { phase: 2, name: 'Q2', durationS: 480, advancing: 10 },
  { phase: 3, name: 'Q3', durationS: 420 },
];

export interface PracticeSegment {
  name: string;
  durationS: number;
}

export const PRACTICE_SEGMENTS: readonly PracticeSegment[] = [
  { name: 'FP1', durationS: 420 },
  { name: 'FP2', durationS: 420 },
  { name: 'FP3', durationS: 360 },
];

// ===========================================================================
// How long the player wants the weekend to be
// ===========================================================================

/**
 * Race distance, as a fraction of the real one.
 *
 * The percentages are the ones the sport itself uses: a Sprint is a shade under
 * a third and is conventionally quoted as 100km, and "50% distance" is the
 * standard short-race option every racing game has had for twenty years because
 * it is the shortest distance at which a one-stop strategy still exists. Below
 * about a quarter distance the tyres never fall off and the race stops being a
 * strategy problem at all, which is why the shortest preset is 25% rather than
 * something smaller.
 */
export type RaceDistanceId = 'quarter' | 'half' | 'full' | 'custom';

export interface RaceDistanceOption {
  id: RaceDistanceId;
  label: string;
  fraction: number;
  blurb: string;
}

export const RACE_DISTANCES: readonly RaceDistanceOption[] = [
  { id: 'quarter', label: '25%', fraction: 0.25, blurb: 'Sprint length. One stint, no strategy.' },
  { id: 'half', label: '50%', fraction: 0.5, blurb: 'A real one-stop race in about half the time.' },
  { id: 'full', label: '100%', fraction: 1, blurb: 'The full Grand Prix distance.' },
  { id: 'custom', label: 'Custom', fraction: 0, blurb: 'Pick the lap count yourself.' },
];

/**
 * How long practice and qualifying run.
 *
 * NOT a free multiplier. A qualifying segment has a hard floor set by the
 * physics of the session, spelled out at the top of this file: the last car
 * released has to serve the pit lane, complete an out-lap and then set a
 * representative flying lap. Cut below that and the segment classifies nobody,
 * the grid is decided by the order the cars happened to leave the garage, and
 * the player has been handed a setting whose only effect is to break qualifying.
 *
 * So the scale is applied and then clamped against that floor, per circuit,
 * because the floor at Monaco is not the floor at Monza.
 */
export type SessionLengthId = 'brief' | 'short' | 'full';

export interface SessionLengthOption {
  id: SessionLengthId;
  label: string;
  scale: number;
  blurb: string;
}

export const SESSION_LENGTHS: readonly SessionLengthOption[] = [
  { id: 'brief', label: 'Brief', scale: 0.5, blurb: 'The shortest that still classifies everyone.' },
  { id: 'short', label: 'Short', scale: 0.75, blurb: 'Time for a couple of runs.' },
  { id: 'full', label: 'Standard', scale: 1, blurb: 'The full compressed format.' },
];

/** Everything the player chose about the shape of this weekend. */
export interface WeekendOptions {
  raceDistance: RaceDistanceId;
  /** Lap count when `raceDistance` is 'custom'. */
  customLaps: number;
  sessionLength: SessionLengthId;
  /** How many practice sessions to run, 0-3. */
  practiceCount: number;
  /** False to go straight to the grid on championship order. */
  runQualifying: boolean;
}

export const DEFAULT_WEEKEND_OPTIONS: WeekendOptions = {
  raceDistance: 'full',
  customLaps: 10,
  sessionLength: 'full',
  practiceCount: 3,
  runQualifying: true,
};

/** Race laps for a circuit under these options. Never below 3. */
export function raceLapsFor(fullDistanceLaps: number, opts: WeekendOptions): number {
  if (opts.raceDistance === 'custom') {
    return Math.max(1, Math.min(200, Math.round(opts.customLaps)));
  }
  const f = RACE_DISTANCES.find((d) => d.id === opts.raceDistance)?.fraction ?? 1;
  return Math.max(3, Math.round(fullDistanceLaps * f));
}

/**
 * The shortest a qualifying segment can be on this circuit and still work.
 *
 * The arithmetic at the top of this file, made a function of the circuit rather
 * than a constant: release the field, serve the pit lane, run an out-lap, then
 * one flying lap with enough margin that a car caught behind traffic on the
 * out-lap still gets one in. The reference pole time is the lap length in
 * seconds; an out-lap on cold tyres behind the field is comfortably slower than
 * that, hence the 1.35.
 */
export function minimumQualifyingDurationS(referencePoleTimeS: number): number {
  const release = 23;
  const pitTransit = 30;
  const outLap = referencePoleTimeS * 1.35;
  const flyingLaps = referencePoleTimeS * 1.15 * 2;
  return Math.ceil(release + pitTransit + outLap + flyingLaps);
}

/** Qualifying segments at the player's chosen length, floored so they still work. */
export function qualifyingSegmentsFor(
  opts: WeekendOptions,
  referencePoleTimeS: number,
): QualifyingSegment[] {
  const scale = SESSION_LENGTHS.find((s) => s.id === opts.sessionLength)?.scale ?? 1;
  const floor = minimumQualifyingDurationS(referencePoleTimeS);
  return QUALIFYING_SEGMENTS.map((q) => ({
    ...q,
    durationS: Math.max(floor, Math.round(q.durationS * scale)),
  }));
}

/**
 * Practice segments at the player's chosen length and count.
 *
 * Practice has no floor worth enforcing — a two-minute practice session is
 * short, but it is not broken, because nothing downstream consumes its result.
 * It is capped below only so a session cannot be zero-length.
 */
export function practiceSegmentsFor(opts: WeekendOptions): PracticeSegment[] {
  const scale = SESSION_LENGTHS.find((s) => s.id === opts.sessionLength)?.scale ?? 1;
  return PRACTICE_SEGMENTS
    .slice(0, Math.max(0, Math.min(3, Math.round(opts.practiceCount))))
    .map((p) => ({ ...p, durationS: Math.max(120, Math.round(p.durationS * scale)) }));
}

/** A one-line description of the weekend these options produce. */
export function weekendSummary(
  opts: WeekendOptions,
  fullDistanceLaps: number,
  referencePoleTimeS: number,
): string {
  const practice = practiceSegmentsFor(opts);
  const parts: string[] = [];
  parts.push(practice.length === 0 ? 'no practice' : practice.length + ' practice');
  if (opts.runQualifying) {
    const q = qualifyingSegmentsFor(opts, referencePoleTimeS);
    parts.push('Q1-Q3 (' + Math.round(q[0].durationS / 60) + '-' +
      Math.round(q[1].durationS / 60) + '-' + Math.round(q[2].durationS / 60) + ' min)');
  } else {
    parts.push('no qualifying');
  }
  parts.push(raceLapsFor(fullDistanceLaps, opts) + ' lap race');
  return parts.join(' · ');
}
