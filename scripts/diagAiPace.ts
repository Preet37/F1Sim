/**
 * Where the AI's lap time goes — issue #1, and the circuit-specific half of #30.
 *
 * `probe:racesweep` reports one number per race (`fastest lap / reference lap`)
 * and that number is a SUM of at least three independent deficits. Reporting the
 * sum is why the item has stayed open: 1.43 is not a thing that can be fixed,
 * it is three things stacked, and until they are separated any change to one of
 * them moves the total by an amount nobody can attribute.
 *
 * This splits it into four columns that multiply back to the total:
 *
 *   REF     the solved reference lap — `TrackSpline.referenceLapTime`, the number
 *           `probe:racesweep` divides by. Solved for `REFERENCE_CAR`: mu 1.86,
 *           850kg, per-circuit aero from `solverParamsFor`.
 *   CAR     the SAME solver re-run with the parameters of a car that actually
 *           exists on the grid — `specForTeam` × `applySetup`, mu 1.70 × the
 *           compound, dry 798kg plus its fuel.
 *   ACHV    the same again, with mu multiplied by `ACHIEVABLE_GRIP_FRACTION`.
 *           **This is the floor, and CAR is not**, which is the correction that
 *           made this whole diagnostic worth writing. CAR still evaluates the
 *           solver's closed form, and that closed form assumes a point mass
 *           reaching `mu * N`; `probe:envelope` measures the vehicle model
 *           delivering 0.777 of it, flat across the calendar. So CAR flatters
 *           the car by about the same amount the reference does and the two
 *           nearly cancel — which is exactly how "the real car is FASTER than
 *           the reference" comes out of the CAR column and is not true.
 *           A perfect driver cannot beat ACHV.
 *   SOLO    what one AI car alone on an empty circuit actually laps in. The gap
 *           from CAR is the controller: how close it dares run to its own limit
 *           and how accurately it tracks the line.
 *   RACE    the fastest lap of a full 20-car 5-lap race — `probe:racesweep`'s own
 *           measurement. The gap from SOLO is traffic, fuel and the start.
 *
 * Also reports OFF, the off-track excursion count for the solo car, because #30
 * is two assertions and the second one has to be attributed too: a lone car that
 * goes off is a tracking failure, and a lone car that does not means the 113
 * excursions at Monaco are a racing-in-traffic phenomenon.
 *
 * Deterministic and node-only: no browser, no wall-clock deadline anywhere, so
 * unlike the browser probes it says the same thing under load (PROJECT.md §8).
 *
 * Run: npx tsx scripts/diagAiPace.ts [--race]
 */
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { DRIVERS, TEAMS } from '../src/data/teams';
import { TrackSpline, type SpeedSolverParams } from '../src/track/TrackSpline';
import {
  specForTeam, applySetup, baselineSetupFor, BASE_F1_SPEC, ACHIEVABLE_GRIP_FRACTION,
} from '../src/physics/VehicleSpec';
import { VehiclePhysics } from '../src/physics/VehiclePhysics';
import { raceFuelLoadL } from '../src/physics/FuelPlan';

const WITH_RACE = process.argv.includes('--race');
const LAPS = 5;

/**
 * Solver parameters for a real car on this circuit.
 *
 * Everything comes from the same two functions the race engine builds its cars
 * with, so this cannot drift from what is on the grid. The one judgement call is
 * the tyre grip multiplier, taken from a fresh `VehiclePhysics` on the compound
 * a race starts on rather than assumed to be 1.
 */
function realCarParams(def: (typeof CIRCUITS)[number], fuelL: number): SpeedSolverParams {
  const team = TEAMS[0];
  const setup = baselineSetupFor(def.downforceDemand, fuelL);
  const spec = applySetup(specForTeam(team.performance), setup);
  const car = new VehiclePhysics(spec, 'medium');
  const grip = Math.min(car.frontTires.grip, car.rearTires.grip);
  return {
    mu: spec.baseMu * grip,
    maxBrakeForceN: spec.maxBrakeForceN,
    massKg: spec.dryMassKg + fuelL * spec.fuelDensity,
    powerW: spec.icePowerW + spec.ersPowerW,
    cl: spec.clBase,
    cd: spec.cdBase,
    maxSpeedMs: 103,
  };
}

interface Row {
  id: string;
  demand: number;
  ref: number;
  car: number;
  achv: number;
  solo: number;
  soloOff: number;
  race: number;
  raceOff: number;
}

const rows: Row[] = [];

for (const def of CIRCUITS) {
  // REF: the number racesweep divides by, from an untouched spline.
  const refSpline = new TrackSpline(def);
  const ref = refSpline.referenceLapTime;

  // CAR: same geometry, same racing line, real car's numbers. A THROWAWAY
  // spline, because `resolveSpeedProfile` overwrites `targetSpeed` in place and
  // the AI reads that array every step.
  // The same litres `RaceEngine` puts in for a race of this length. The SOLO
  // run is a practice session, which is fuelled at a flat 40L, so the two
  // columns are not on the same fuel — that is stated rather than hidden, and
  // the CAR column is deliberately fuelled as the RACE column is, since it is
  // the race the sweep measures.
  const fuelL = raceFuelLoadL(LAPS, ref, BASE_F1_SPEC.fuelCapacityL);
  const carSpline = new TrackSpline(def);
  const params = realCarParams(def, fuelL);
  const carLap = carSpline.resolveSpeedProfile(params);

  // ACHV: the same, at the grip the vehicle model actually produces.
  const achvSpline = new TrackSpline(def);
  const achvLap = achvSpline.resolveSpeedProfile({
    ...params, mu: params.mu * ACHIEVABLE_GRIP_FRACTION,
  });

  // SOLO: one car, empty circuit, five laps.
  const cfg: SessionConfig = {
    kind: 'practice', name: 'FP', durationS: 900, laps: 0,
    playerIndex: -1, standingStart: false, pitLaneStart: false, seed: 11,
  };
  const engine = new RaceEngine(def, cfg, [DRIVERS[0]]);
  const c = engine.cars[0];
  let soloOff = 0;
  let wasOff = false;
  while (!engine.over && c.lap < LAPS + 1 && !c.retired) {
    engine.step();
    const o = Math.abs(c.lateral) > engine.track.halfWidthAt(c.s) + 1.5 && !c.inPitLane;
    if (o && !wasOff) soloOff++;
    wasOff = o;
  }
  const solo = c.bestLapTime;

  let race = 0;
  let raceOff = 0;
  if (WITH_RACE) {
    const rcfg: SessionConfig = {
      kind: 'race', name: 'Grand Prix', durationS: 0, laps: LAPS,
      playerIndex: -1, standingStart: true, pitLaneStart: false, seed: 20260729,
    };
    const re = new RaceEngine(def, rcfg);
    const off = new Map<number, boolean>();
    let steps = 0;
    const max = Math.round((LAPS * def.referencePoleTimeS * 3.2) / (1 / 120));
    while (!re.over && steps < max) {
      re.step();
      steps++;
      if (steps % 12 === 0) {
        for (const car of re.cars) {
          const o = Math.abs(car.lateral) > re.track.halfWidthAt(car.s) + 1.5 && !car.inPitLane;
          if (o && !off.get(car.index)) raceOff++;
          off.set(car.index, o);
        }
      }
    }
    const fl = re.fastestLap();
    race = fl ? fl.time : 0;
  }

  rows.push({
    id: def.id, demand: def.downforceDemand, ref,
    car: carLap, achv: achvLap, solo, soloOff, race, raceOff,
  });
}

const pct = (a: number, b: number) => (b > 0 && a > 0 ? ((a / b) * 100).toFixed(1) : '--');

console.log('');
console.log('AI PACE DECOMPOSITION — every column is a lap time in seconds,');
console.log('every %% is that column over REF. REF is what probe:racesweep divides by.');
console.log('');
console.log('  circuit        df    REF      CAR         ACHV         SOLO         OFF   ' +
  (WITH_RACE ? 'RACE         OFF' : ''));
for (const r of rows) {
  console.log(
    '  ' + r.id.padEnd(13) +
    r.demand.toFixed(2).padStart(4) + '  ' +
    r.ref.toFixed(2).padStart(7) + '  ' +
    r.car.toFixed(2).padStart(7) + ' ' + (pct(r.car, r.ref) + '%').padStart(7) + '  ' +
    r.achv.toFixed(2).padStart(7) + ' ' + (pct(r.achv, r.ref) + '%').padStart(7) + '  ' +
    r.solo.toFixed(2).padStart(7) + ' ' + (pct(r.solo, r.ref) + '%').padStart(7) + '  ' +
    String(r.soloOff).padStart(4) + '  ' +
    (WITH_RACE
      ? r.race.toFixed(2).padStart(7) + ' ' + (pct(r.race, r.ref) + '%').padStart(7) + '  ' +
        String(r.raceOff).padStart(4)
      : ''));
}

const mean = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
console.log('');
console.log('  mean CAR/REF   ' + mean((r) => r.car / r.ref).toFixed(4) +
  '   <- the same closed form, this car\'s parameters. NOT a floor.');
console.log('  mean ACHV/REF  ' + mean((r) => r.achv / r.ref).toFixed(4) +
  '   <- THE FLOOR. Nobody can drive faster than this.');
console.log('  mean SOLO/ACHV ' + mean((r) => r.solo / r.achv).toFixed(4) +
  '   <- the controller, and this is the only part src/ai/ owns');
console.log('  mean SOLO/REF  ' + mean((r) => r.solo / r.ref).toFixed(4));
if (WITH_RACE) {
  console.log('  mean RACE/SOLO ' + mean((r) => (r.solo > 0 ? r.race / r.solo : 1)).toFixed(4) +
    '   <- traffic, fuel and the start');
  console.log('  mean RACE/REF  ' + mean((r) => r.race / r.ref).toFixed(4));
}
console.log('  solo off-track ' + rows.reduce((a, r) => a + r.soloOff, 0) +
  ' over ' + rows.length + ' circuits');
console.log('');
