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
