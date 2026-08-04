/**
 * WHERE on the lap the AI loses its time — the second half of the issue #1 split.
 *
 * `diagAiPace.ts` establishes that the deficit is the controller and not the car
 * (CAR/REF 0.964 — the real car is quicker than the reference car the sweep
 * divides by) and `tuneAI.ts commitment` establishes that the commitment scale
 * is worth only about six of the twenty-five points. This finds the rest by
 * walking one flying lap and comparing the speed the car achieved at every node
 * against the reference profile's speed at that node, binned by what the node IS.
 *
 * The bins are chosen so that each one names a different mechanism:
 *
 *   STRAIGHT    reference speed high and curvature negligible. A deficit here is
 *               power, drag, gearing or DRS — nothing to do with cornering.
 *   BRAKING     reference speed is falling steeply into a corner. A deficit here
 *               is braking too early, which is the classic AI time loss and is
 *               invisible in a corner-speed measurement because the car arrives
 *               at the apex at exactly the right speed having wasted the entry.
 *   APEX        reference speed at a local minimum. A deficit here is commitment.
 *   EXIT        reference speed rising out of a corner. A deficit here is
 *               traction limiting or throttle application.
 *
 * Run: npx tsx scripts/diagPaceProfile.ts [circuitId ...]
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';

const WANT = process.argv.slice(2);
const LIST = WANT.length ? CIRCUITS.filter((c) => WANT.includes(c.id)) : CIRCUITS;

type Bin = 'STRAIGHT' | 'BRAKING' | 'APEX' | 'EXIT';

interface Acc {
  n: number;
  sumRatio: number;
  sumWant: number;
  refTime: number;
  wantTime: number;
  gotTime: number;
}

for (const def of LIST) {
  const cfg: SessionConfig = {
    kind: 'practice', name: 'FP', durationS: 900, laps: 0,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 11,
  };
  const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
  const track = engine.track;
  const c = engine.cars[0];
  const count = track.count;

  // Best speed seen at each node over the run, so one dirty lap does not decide
  // the profile. The car is alone on the circuit, so "best" is simply the lap it
  // was tidiest on. `want` is what the controller was ASKING for at the same
  // node — the real `speedTargetAt`, published by the controller rather than
  // recomputed here, so this cannot pass while the rule it claims to measure is
  // broken.
  const best = new Float64Array(count);
  const want = new Float64Array(count);

  while (!engine.over && c.lap < 5 && !c.retired) {
    engine.step();
    const i = track.indexAt(c.s);
    const v = c.physics.speedMs;
    if (v > best[i]) best[i] = v;
    const t = c.ai ? c.ai.lastTargetSpeedMs : 0;
    if (t > want[i]) want[i] = t;
  }

  const ds = track.length / count;
  const blank = (): Acc => ({ n: 0, sumRatio: 0, sumWant: 0, refTime: 0, wantTime: 0, gotTime: 0 });
  const bins: Record<Bin, Acc> = {
    STRAIGHT: blank(), BRAKING: blank(), APEX: blank(), EXIT: blank(),
  };

  const look = Math.max(1, Math.round(25 / ds));
  for (let i = 0; i < count; i++) {
    const ref = track.targetSpeed[i];
    const got = best[i];
    if (ref <= 1 || got <= 0.5) continue;
    const ahead = track.targetSpeed[(i + look) % count];
    const behind = track.targetSpeed[(i - look + count) % count];
    const k = Math.abs(track.lineCurvature[i]);

    let bin: Bin;
    if (ref - ahead > 6) bin = 'BRAKING';
    else if (ahead - ref > 6) bin = 'EXIT';
    else if (k > 1 / 400 && ref <= behind && ref <= ahead) bin = 'APEX';
    else if (k < 1 / 900) bin = 'STRAIGHT';
    else bin = 'APEX';

    const b = bins[bin];
    const w = Math.min(want[i] > 0 ? want[i] : ref, ref * 4);
    b.n++;
    b.sumRatio += got / ref;
    b.sumWant += w / ref;
    b.refTime += ds / ref;
    b.wantTime += ds / Math.max(w, 1);
    b.gotTime += ds / got;
  }

  const lap = c.bestLapTime;
  console.log('');
  console.log(def.id.toUpperCase() + '   ref ' + track.referenceLapTime.toFixed(2) +
    's   best lap ' + lap.toFixed(2) + 's   ' +
    ((lap / track.referenceLapTime) * 100).toFixed(1) + '%');
  console.log('   bin        nodes   want/ref   got/ref   AIMED LOW   MISSED IT   total');
  for (const k of ['STRAIGHT', 'BRAKING', 'APEX', 'EXIT'] as Bin[]) {
    const b = bins[k];
    if (!b.n) continue;
    // The two halves of the deficit, in seconds, and they add up: the time the
    // controller gave away by asking for less than the reference, and the time
    // it gave away by not getting what it asked for.
    const aimed = b.wantTime - b.refTime;
    const missed = b.gotTime - b.wantTime;
    console.log('   ' + k.padEnd(10) +
      String(b.n).padStart(6) + '   ' +
      (b.sumWant / b.n).toFixed(3).padStart(8) + '  ' +
      (b.sumRatio / b.n).toFixed(3).padStart(8) + '   ' +
      (aimed.toFixed(2) + 's').padStart(9) + '   ' +
      (missed.toFixed(2) + 's').padStart(9) + '   ' +
      ((b.gotTime - b.refTime).toFixed(2) + 's').padStart(7));
  }
  const sumA = (['STRAIGHT', 'BRAKING', 'APEX', 'EXIT'] as Bin[])
    .reduce((a, k) => a + (bins[k].wantTime - bins[k].refTime), 0);
  const sumM = (['STRAIGHT', 'BRAKING', 'APEX', 'EXIT'] as Bin[])
    .reduce((a, k) => a + (bins[k].gotTime - bins[k].wantTime), 0);
  console.log('   ' + 'TOTAL'.padEnd(10) + ' '.repeat(6) + '   ' + ' '.repeat(8) + '  ' +
    ' '.repeat(8) + '   ' + (sumA.toFixed(2) + 's').padStart(9) + '   ' +
    (sumM.toFixed(2) + 's').padStart(9) + '   ' +
    ((sumA + sumM).toFixed(2) + 's').padStart(7));
}
console.log('');
