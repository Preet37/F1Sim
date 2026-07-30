/**
 * Reference-car calibration sweep.
 *
 * The speed-profile solver in TrackSpline models an idealised car: perfect line,
 * perfect shifts, no thermal limit. Its absolute pace therefore depends on four
 * parameters — peak tire friction, downforce coefficient, braking friction and
 * power. This script grid-searches them to minimise RMS error between the solved
 * reference lap and the real pole time across every circuit.
 *
 * The point is not to make one track match. It is to find whether a SINGLE set
 * of physical parameters fits ALL eleven circuits at once. If it does, the
 * layouts are geometrically consistent with each other and with reality. If one
 * track stubbornly refuses to fit while the rest do, that track's geometry is
 * wrong — which is far more informative than any single lap time.
 *
 * Run: npm run calibrate
 */

import { CIRCUITS } from '../src/data/tracks/circuits';
import { TrackSpline, type SpeedSolverParams } from '../src/track/TrackSpline';

/** Aero package endpoints swept over, interpolated by each circuit's demand. */
interface Sweep {
  mu: number; maxBrakeForceN: number; powerW: number;
  clLow: number; clHigh: number; cdLow: number; cdHigh: number;
}

function paramsFor(sw: Sweep, demand: number): SpeedSolverParams {
  const d = Math.max(0, Math.min(1, demand));
  return {
    mu: sw.mu,
    maxBrakeForceN: sw.maxBrakeForceN,
    massKg: 850,
    powerW: sw.powerW,
    cl: sw.clLow + (sw.clHigh - sw.clLow) * d,
    cd: sw.cdLow + (sw.cdHigh - sw.cdLow) * d,
    maxSpeedMs: 103,
  };
}

interface Result {
  sweep: Sweep;
  rms: number;
  bias: number;
  worst: number;
  worstId: string;
  perTrack: { id: string; errPct: number }[];
}

// Geometry and racing line are independent of the car parameters, so build each
// circuit's spline once and re-solve only the speed profile per candidate.
const SPLINES = CIRCUITS.map((def) => ({ def, spline: new TrackSpline(def) }));

function evaluate(sw: Sweep): Result {
  let sumSq = 0;
  let sum = 0;
  let worst = 0;
  let worstId = '';
  const perTrack: { id: string; errPct: number }[] = [];

  for (const { def, spline } of SPLINES) {
    const lap = spline.resolveSpeedProfile(paramsFor(sw, def.downforceDemand));
    const errPct = ((lap - def.referencePoleTimeS) / def.referencePoleTimeS) * 100;
    sumSq += errPct * errPct;
    sum += errPct;
    perTrack.push({ id: def.id, errPct });
    if (Math.abs(errPct) > Math.abs(worst)) {
      worst = errPct;
      worstId = def.id;
    }
  }

  return {
    sweep: sw,
    rms: Math.sqrt(sumSq / CIRCUITS.length),
    bias: sum / CIRCUITS.length,
    worst,
    worstId,
    perTrack,
  };
}

const MU = [1.62, 1.70, 1.78, 1.86];
const CL_LOW = [2.1, 2.4, 2.7];
const CL_HIGH = [3.6, 3.9, 4.2, 4.5];
const CD_LOW = [0.50, 0.58, 0.66];
const CD_HIGH = [0.92, 1.05, 1.18];
const BRAKE = [36_000, 42_000, 48_000, 54_000];
const POWER = [600_000, 660_000, 720_000];

let best: Result | null = null;
let evaluated = 0;
const total = MU.length * CL_LOW.length * CL_HIGH.length * CD_LOW.length * CD_HIGH.length * BRAKE.length * POWER.length;

console.log('');
console.log('sweeping ' + total + ' parameter sets across ' + CIRCUITS.length + ' circuits...');

for (const mu of MU) {
  for (const clLow of CL_LOW) {
    for (const clHigh of CL_HIGH) {
      for (const cdLow of CD_LOW) {
        for (const cdHigh of CD_HIGH) {
          for (const maxBrakeForceN of BRAKE) {
            for (const powerW of POWER) {
              const r = evaluate({ mu, maxBrakeForceN, powerW, clLow, clHigh, cdLow, cdHigh });
              evaluated++;
              if (!best || r.rms < best.rms) best = r;
            }
          }
        }
      }
    }
  }
}

if (!best) {
  console.log('no result');
  process.exit(1);
}

console.log('evaluated ' + evaluated + ' sets');
console.log('');
console.log('BEST FIT');
console.log('  mu       ' + best.sweep.mu);
console.log('  brakeF   ' + best.sweep.maxBrakeForceN);
console.log('  powerW   ' + best.sweep.powerW);
console.log('  clLow    ' + best.sweep.clLow + '   clHigh  ' + best.sweep.clHigh);
console.log('  cdLow    ' + best.sweep.cdLow + '   cdHigh  ' + best.sweep.cdHigh);
console.log('');
console.log('  RMS error  ' + best.rms.toFixed(2) + '%');
console.log('  mean bias  ' + (best.bias >= 0 ? '+' : '') + best.bias.toFixed(2) + '%');
console.log('  worst      ' + best.worstId + ' ' + (best.worst >= 0 ? '+' : '') + best.worst.toFixed(1) + '%');
console.log('');
console.log('PER-TRACK RESIDUALS (a lone outlier means that layout is wrong)');
for (const t of best.perTrack.slice().sort((a, b) => a.errPct - b.errPct)) {
  const bar = t.errPct >= 0
    ? ' '.repeat(12) + '#'.repeat(Math.min(24, Math.round(t.errPct * 2)))
    : ' '.repeat(Math.max(0, 12 - Math.round(-t.errPct * 2))) + '#'.repeat(Math.min(12, Math.round(-t.errPct * 2)));
  console.log('  ' + t.id.padEnd(14) + (t.errPct >= 0 ? '+' : '') + t.errPct.toFixed(1).padStart(5) + '%  ' + bar);
}
console.log('');
