import { RacingLine } from '../src/render/RacingLine';
import { TrackSpline } from '../src/track/TrackSpline';
import { getCircuit } from '../src/data/tracks/circuits';

/**
 * How far before a corner does the line warn you?
 *
 * The measure that matters is the colour of the tarmac IMMEDIATELY AHEAD of the
 * car — that is what a driver looks at. If that stays green until the corner
 * arrives, the aid is useless however correct the far end of the ribbon is.
 */
const track = new TrackSpline(getCircuit('monza'));
const line = new RacingLine(track);

// Find the heaviest braking zone on the lap.
let bestI = 0, bestDrop = 0;
for (let i = 0; i < track.count; i++) {
  const j = (i + 60) % track.count;
  const d = track.targetSpeed[i] - track.targetSpeed[j];
  if (d > bestDrop) { bestDrop = d; bestI = i; }
}
const cornerS = track.dist[(bestI + 60) % track.count];
const cornerKph = track.targetSpeed[(bestI + 60) % track.count] * 3.6;
console.log(`Monza: heaviest braking zone into a ${cornerKph.toFixed(0)} km/h corner\n`);
console.log('colour of the road just ahead of the car:');
console.log('distance to corner   R     G     B    reads as');

for (const kph of [330, 240, 160, 90]) {
  console.log(`\n--- approaching at ${kph} km/h ---`);
  const speed = kph / 3.6;
  for (const dist of [600, 350, 200, 150, 100, 60]) {
  const s = (cornerS - dist + track.length) % track.length;
  line.update(s, speed);
  const c = line.mesh.geometry.getAttribute('color').array as Float32Array;
  // Segment 4 is ~30m ahead of the car: the tarmac the driver is looking at.
  const o = 4 * 6 * 3;
  const r = c[o], g = c[o + 1], b = c[o + 2];
    const reads = r > 0.85 && g < 0.35 ? 'RED' : r > 0.6 && g > 0.45 ? 'AMBER' : 'GREEN';
    console.log(`${String(dist).padStart(13)}m   ${r.toFixed(2)}  ${g.toFixed(2)}  ${b.toFixed(2)}   ${reads}`);
  }
}
