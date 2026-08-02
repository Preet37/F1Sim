import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * How much carbon a race actually puts on the circuit, and what it costs.
 *
 * Two numbers matter and they pull against each other. Debris has to be
 * TEMPORARY, which needs the marshals to be sent, which needs a flag; and the
 * flag has to be RARE, because a yellow slows the whole field and a race where
 * every wheel-to-wheel rub raises one is a race nobody can run flat. The first
 * pass at this raised a flag for every pile on the racing surface and took the
 * calendar's yellow-sector occupancy high enough to break `validate:flags` —
 * green reference laps got slower, and a safety car lap stopped being x1.6 a
 * green one because the green ones were no longer green.
 *
 * So the rule is now about SIZE: a wing or a sidepod lying on the road is a
 * hazard and gets a post; the scatter a contact leaves is picked up when the
 * marshals next have the circuit, which is what really happens.
 *
 * Run: npm run probe:debris
 */

const CIRCUITS = ['monza', 'bahrain', 'monaco', 'spa'];
const RACE_S = 900;

const failures: string[] = [];

console.log(
  'circuit     race    piles  on-surface  flagged   sectors yellow   peak live piles',
);

for (const id of CIRCUITS) {
  const def = getCircuit(id);
  const cfg: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 12,
    playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 7,
  };
  const engine = new RaceEngine(def, cfg);
  const rc = engine.raceControl;

  const seen = new Set<number>();
  let spawned = 0;
  let onSurface = 0;
  let flagged = 0;
  let peak = 0;
  let yellowSectorSamples = 0;
  let samples = 0;

  const steps = Math.round(RACE_S / PHYSICS_DT);
  for (let i = 0; i < steps && !engine.over; i++) {
    engine.step();
    for (const p of engine.debris.piles) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      spawned++;
      if (p.onSurface) onSurface++;
      if (p.signal !== null) flagged++;
    }
    if (engine.debris.piles.length > peak) peak = engine.debris.piles.length;
    // Sampled at 2Hz. What is being measured is occupancy, not transitions.
    if (i % 60 === 0) {
      samples++;
      for (let k = 0; k < rc.marshalSectorCount; k++) {
        if (rc.sectorFlags[k] !== 'green') yellowSectorSamples++;
      }
    }
  }

  const occupancy = 100 * yellowSectorSamples / (samples * rc.marshalSectorCount);
  console.log(
    id.padEnd(12) + `${engine.time.toFixed(0)}s`.padStart(6) +
    String(spawned).padStart(9) + String(onSurface).padStart(12) +
    String(flagged).padStart(9) + `${occupancy.toFixed(1)}%`.padStart(16) +
    String(peak).padStart(18),
  );

  // A sanity bound, not a regulation. Marshalling sectors under a flag for
  // more than a fifth of a race is a race that is never green, and
  // `validate:flags` will already be measuring green laps that are not.
  if (occupancy > 22) {
    failures.push(
      `${id}: marshalling sectors under a flag ${occupancy.toFixed(1)}% of the race`,
    );
  }
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('Debris is bounded, and flagging it does not swallow the race.\n');
}
