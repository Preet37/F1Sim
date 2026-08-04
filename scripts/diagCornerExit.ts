/**
 * Corner exit, and what `tractionLimitFraction` is really doing — issue #1.
 *
 * PROJECT.md §7 ends the AI-pace decomposition here: `SOLO/ACHV = 1.1658` is the
 * controller's own 16.6%, it is not the commitment scale and it is not the AI
 * aiming low, and `tractionLimitFraction` reads 0.10-0.55 through a whole
 * Silverstone corner exit with the AI's throttle tracking it exactly. That is
 * physically the right SHAPE — an F1 car in second gear genuinely cannot use
 * full throttle — so the question this script exists to answer is not "is the
 * AI traction-limited" but "is it traction-limited at the RIGHT NUMBER".
 *
 * It asks that two ways, and neither of them assumes an answer:
 *
 *   denom      `tractionLimitFraction` is `maxForce / atFullThrottle`, so with
 *              `maxForce` recoverable from the published `capRearN` and
 *              `rearLateralN` the getter's own denominator can be read back out
 *              of its return value. That is compared against the physics'
 *              `driveForceFullN`, which `step()` writes from the SAME
 *              expression it uses for the force it actually applies.
 *
 *   used       how much of the rear axle's grip circle the tire is really
 *              spending, `hypot(rearLongitudinalN, rearLateralN) / capRearN`.
 *              A car that is genuinely at the traction limit sits at 1.00 here.
 *              A car held under a limit that is too low does not.
 *
 * "Corner exit" is taken from the solver's own speed profile rather than from
 * anything about the car: every local minimum of `track.targetSpeed` is an apex,
 * and the EXIT_M metres after it is an exit.
 *
 * Run: npx tsx scripts/diagCornerExit.ts [circuitId|all]
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS } from '../src/data/teams';

/** How far past an apex still counts as the exit, metres. */
const EXIT_M = 150;

const ARG = process.argv[2] ?? 'silverstone';
const list = ARG === 'all' ? CIRCUITS : CIRCUITS.filter((c) => c.id === ARG);
if (!list.length) { console.log('no such circuit: ' + ARG); process.exit(1); }

interface Row {
  id: string;
  n: number;
  thr: number;
  tract: number;
  denomRatio: number;
  honest: number;
  used: number;
  atLimit: number;
  deliv: number;
  cut: number;
  lapS: number;
  refS: number;
}
const rows: Row[] = [];

for (const def of list) {
  const cfg: SessionConfig = {
    kind: 'practice', name: 'FP', durationS: 900, laps: 0,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 11,
  };
  const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
  const track = engine.track;
  const car = engine.cars[0];

  // Apexes: local minima of the solver's own target speed.
  const count = track.count;
  const ds = track.length / count;
  const apex: boolean[] = new Array(count).fill(false);
  const win = Math.max(2, Math.round(25 / ds));
  for (let i = 0; i < count; i++) {
    const v = track.targetSpeed[i];
    let min = true;
    for (let k = -win; k <= win && min; k++) {
      if (k === 0) continue;
      if (track.targetSpeed[(i + k + count) % count] < v) min = false;
    }
    if (min) apex[i] = true;
  }
  /** Distance from `s` back to the nearest apex, metres, or Infinity. */
  const sinceApex = (s: number): number => {
    const i = track.indexAt(s);
    for (let k = 0; k <= Math.round(EXIT_M / ds); k++) {
      if (apex[(i - k + count) % count]) return k * ds;
    }
    return Infinity;
  };

  // Settle for a lap, then record the second.
  while (!engine.over && car.lap < 1 && !car.retired) engine.step();
  const startLap = car.lap;

  let n = 0, sThr = 0, sTract = 0, sDenom = 0, sHonest = 0, sUsed = 0, atLimit = 0;
  let sDeliv = 0, nDeliv = 0, cut = 0;
  while (!engine.over && car.lap === startLap && !car.retired) {
    engine.step();
    const p = car.physics;
    const ai = car.ai;
    if (!ai) break;
    if (ai.controls.brake > 0.02) continue;
    if (sinceApex(car.s) > EXIT_M) continue;

    const cap = p.capRearN;
    if (cap <= 1) continue;
    const remSq = cap * cap - p.rearLateralN * p.rearLateralN;
    const maxForce = remSq > 0 ? Math.sqrt(remSq) : 0;
    const tract = p.tractionLimitFraction;
    // The getter's own denominator, read back out of its return value. Only
    // meaningful where the clamp is not biting.
    if (tract <= 0.021 || tract >= 0.999 || maxForce <= 1) continue;
    const denomShipped = maxForce / tract;
    const denomTrue = p.driveForceFullN;
    if (denomTrue <= 1) continue;

    n++;
    sThr += ai.controls.throttle;
    sTract += tract;
    sDenom += denomShipped / denomTrue;
    sHonest += Math.min(1, maxForce / denomTrue);
    sUsed += Math.hypot(p.rearLongitudinalN, p.rearLateralN) / cap;
    if (ai.controls.throttle >= tract * 1.02) atLimit++;

    // Did the rear axle actually receive the pedal the controller asked for?
    // Anything under 1.000 is the drivetrain, not the controller: turbo lag on
    // the way up, or the ignition cut of an upshift.
    const demanded = ai.controls.throttle * denomTrue;
    if (demanded > 1) {
      sDeliv += Math.max(0, p.rearLongitudinalN) / demanded;
      nDeliv++;
      if (p.rearLongitudinalN < demanded * 0.1) cut++;
    }
  }

  if (!n) continue;
  rows.push({
    id: def.id, n,
    thr: sThr / n, tract: sTract / n,
    denomRatio: sDenom / n, honest: sHonest / n, used: sUsed / n,
    atLimit: atLimit / n,
    deliv: nDeliv ? sDeliv / nDeliv : 0, cut: nDeliv ? cut / nDeliv : 0,
    lapS: car.bestLapTime, refS: track.referenceLapTime,
  });
}

console.log('');
console.log('Corner exits (' + EXIT_M + 'm past every apex in the solved profile), one AI car, empty circuit');
console.log('');
console.log('  circuit        n     thr   tract   denom   honest    used  at-lim   deliv     cut   lap/ref');
for (const r of rows) {
  console.log(
    '  ' + r.id.padEnd(13) +
    String(r.n).padStart(4) + '  ' +
    r.thr.toFixed(3).padStart(6) + '  ' +
    r.tract.toFixed(3).padStart(6) + '  ' +
    r.denomRatio.toFixed(3).padStart(6) + '  ' +
    r.honest.toFixed(3).padStart(6) + '  ' +
    r.used.toFixed(3).padStart(6) + '  ' +
    r.atLimit.toFixed(3).padStart(6) + '  ' +
    r.deliv.toFixed(3).padStart(6) + '  ' +
    r.cut.toFixed(3).padStart(6) + '  ' +
    (r.refS > 0 ? (r.lapS / r.refS).toFixed(4) : '  -   ').padStart(7));
}
const mean = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0) / rows.length;
console.log('');
console.log('  thr     the AI\'s throttle');
console.log('  tract   tractionLimitFraction as shipped');
console.log('  denom   the getter\'s own atFullThrottle over the physics\' driveForceFullN.');
console.log('          1.000 means the getter is dividing by the force the drivetrain');
console.log('          really delivers. Above 1.000 the permitted throttle is too SMALL,');
console.log('          by exactly that factor.');
console.log('  honest  what tractionLimitFraction would read against driveForceFullN');
console.log('  used    fraction of the rear grip circle the tire is actually spending.');
console.log('          A car really at its traction limit reads 1.000 here.');
console.log('  at-lim  fraction of exit samples where the AI is ON the limit, not under it');
console.log('  deliv   rear longitudinal force delivered over the force the pedal asked');
console.log('          for. Under 1.000 is the DRIVETRAIN, not the controller: turbo lag');
console.log('          on the way up and the ignition cut of an upshift');
console.log('  cut     fraction of exit samples delivering under a tenth of the demand,');
console.log('          i.e. the car is in a shift');
console.log('');
console.log('  MEAN over ' + rows.length + ' circuits:  denom ' + mean((r) => r.denomRatio).toFixed(4) +
  '   tract ' + mean((r) => r.tract).toFixed(4) +
  ' -> honest ' + mean((r) => r.honest).toFixed(4) +
  '   used ' + mean((r) => r.used).toFixed(4) +
  '   at-lim ' + mean((r) => r.atLimit).toFixed(3) +
  '   deliv ' + mean((r) => r.deliv).toFixed(3) +
  '   cut ' + mean((r) => r.cut).toFixed(3));
console.log('');
