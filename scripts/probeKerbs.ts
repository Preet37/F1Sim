import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline } from '../src/track/TrackSpline';

/**
 * How much of each lap is kerbed, and how tight the corners actually are.
 *
 * Kerbing is derived from curvature — every node tighter than a threshold
 * radius gets a kerb on the inside of the corner — which saves authoring about
 * nineteen hundred flags per circuit and is right in principle. What it is not
 * is self-checking: the threshold was 400m, nobody had measured what fraction
 * of a lap that produces, and the answer turned out to be between a third and
 * two thirds. A real circuit kerbs its apexes and its exits, which is nothing
 * like two thirds of the lap, and a lap that is more kerb than road is a large
 * part of why the corners looked wrong.
 *
 * This prints the number, per circuit, so the threshold is a measurement rather
 * than a guess. `runs` is the count of separate stretches of kerb around the
 * lap: a real circuit has roughly one or two per corner (an apex kerb, an exit
 * kerb) and the figure should land near twice the corner count, not near ten
 * times it.
 *
 * Run: npm run probe:kerbs
 */

console.log('circuit        length  kerbL kerbR kerbAny   R<400 R<250 R<150  R<80   runs  corners');
const totals = { any: 0, n: 0 };
for (const def of CIRCUITS) {
  const t = new TrackSpline(def);
  const n = t.count;
  let kl = 0, kr = 0, ke = 0, a400 = 0, a250 = 0, a150 = 0, a80 = 0;
  for (let i = 0; i < n; i++) {
    if (t.isCurbLeft[i]) kl++;
    if (t.isCurbRight[i]) kr++;
    if (t.isCurbLeft[i] || t.isCurbRight[i]) ke++;
    const r = t.curvature[i] !== 0 ? 1 / Math.abs(t.curvature[i]) : Infinity;
    if (r < 400) a400++;
    if (r < 250) a250++;
    if (r < 150) a150++;
    if (r < 80) a80++;
  }
  let runs = 0;
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const cur = t.isCurbLeft[i] || t.isCurbRight[i];
    const prev = t.isCurbLeft[p] || t.isCurbRight[p];
    if (cur && !prev) runs++;
  }
  const named = new Set<string>();
  for (let i = 0; i < n; i++) {
    const name = t.cornerNameAt(t.dist[i]);
    if (name) named.add(name);
  }
  const pct = (x: number) => (100 * x / n).toFixed(0).padStart(5) + '%';
  console.log(
    def.id.padEnd(13) + (t.length / 1000).toFixed(2) + 'km' +
    pct(kl) + pct(kr) + pct(ke) + '  ' + pct(a400) + pct(a250) + pct(a150) + pct(a80) +
    String(runs).padStart(7) + String(named.size).padStart(9),
  );
  totals.any += ke / n;
  totals.n++;
}
console.log('\nmean kerbed fraction of a lap: ' + (100 * totals.any / totals.n).toFixed(1) + '%');
