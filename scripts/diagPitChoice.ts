/**
 * WHICH of the driver's two instructions kills the stop?
 *
 * `probe:pitstop` fails six of seven cases, and the one that passes differs
 * from the six in BOTH variables: it asks for no compound and leaves the wing
 * to the crew. So the probe proves a stop is being lost and proves nothing at
 * all about why — compound, wing, or the combination are indistinguishable in
 * its output, and a fix aimed at the wrong one would look like it worked.
 *
 * This separates them. Four arms over the same drive:
 *
 *   neither     — no compound, no wing instruction   (the passing case)
 *   compound    — a compound, wing left to the crew
 *   repair      — no compound, an explicit wing call
 *   both        — the failing case
 *
 * Everything else is held identical: same circuit, same seed, same damaged
 * nose, and the SAME DRIVER — `probe:pitstop`'s own `ProbeDriver`, imported
 * rather than reimplemented. That last part is not fussiness. The first attempt
 * at this diagnostic wrote its own crude driver, which put the car in the
 * barrier before the pit entry in all four arms, so every arm reported "no
 * stop" for a reason that had nothing to do with the question. A diagnostic
 * that cannot get the car to the pit lane distinguishes nothing.
 *
 * Run: npx tsx scripts/diagPitChoice.ts
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { setPitCompound, setPitRepair } from '../src/race/PitStop';
import { ProbeDriver } from './lib/pitDriver';

interface Arm {
  label: string;
  compound: 'hard' | null;
  repair: 'crew' | 'change';
}

const ARMS: Arm[] = [
  { label: 'neither ', compound: null, repair: 'crew' },
  { label: 'compound', compound: 'hard', repair: 'crew' },
  { label: 'repair  ', compound: null, repair: 'change' },
  { label: 'both    ', compound: 'hard', repair: 'change' },
];

interface Outcome {
  /** Was the pit request still standing one step after it was made? */
  survivedFirstStep: boolean;
  /** The step at which the request was cleared, or -1. */
  clearedAtStep: number;
  reachedLane: boolean;
  reachedBox: boolean;
  stops: number;
  retired: boolean;
}

function run(arm: Arm): Outcome {
  const def = getCircuit('silverstone');
  const config: SessionConfig = {
    kind: 'race', name: 'diag', durationS: 0, laps: 20,
    playerIndex: 0, standingStart: false, pitLaneStart: false, seed: 24601,
  };
  const engine = new RaceEngine(def, config);
  const track = engine.track;
  const pit = def.pitLane;
  const player = engine.cars[0];
  for (const car of engine.cars) if (car !== player) car.eliminated = true;

  const startS = (pit.entryS - 900 + track.length) % track.length;
  const idx = track.indexAt(startS);
  player.placeOnTrack(track, startS, track.lineOffset[idx], track.targetSpeed[idx]);
  player.damage.health.frontWingL = 0.5;
  player.damage.health.frontWingR = 0.5;
  player.physics.spec = player.damage.applyTo(player.physics.baseSpec);

  engine.requestPit(player, true);
  if (arm.compound !== null) setPitCompound(player, arm.compound);
  setPitRepair(player, arm.repair);

  const driver = new ProbeDriver(player, track);
  const controls = engine.playerControls;
  const out: Outcome = {
    survivedFirstStep: false, clearedAtStep: -1,
    reachedLane: false, reachedBox: false, stops: 0, retired: false,
  };

  const steps = Math.round(200 / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    driver.drive(PHYSICS_DT, controls);
    engine.step();
    if (i === 0) out.survivedFirstStep = player.pitRequested;
    if (out.clearedAtStep < 0 && !player.pitRequested && player.pitStops === 0
        && !player.inPitLane) {
      out.clearedAtStep = i;
    }
    if (player.inPitLane) out.reachedLane = true;
    if (player.inPitBox) out.reachedBox = true;
    if (player.retired) { out.retired = true; break; }
    if (player.pitStops > 0) { out.stops = player.pitStops; break; }
  }
  return out;
}

console.log('\nWhich instruction loses the stop?  (silverstone, seed 24601)\n');
console.log('  arm        request survives step 1   cleared at   lane   box   stops   retired');
for (const arm of ARMS) {
  const r = run(arm);
  console.log(
    '  ' + arm.label +
    '   ' + (r.survivedFirstStep ? 'yes' : 'NO ').padEnd(20) +
    ' ' + (r.clearedAtStep < 0 ? '   -' : String(r.clearedAtStep).padStart(4)) +
    '       ' + (r.reachedLane ? 'yes' : 'no ') +
    '   ' + (r.reachedBox ? 'yes' : 'no ') +
    '     ' + r.stops +
    '       ' + (r.retired ? 'yes' : 'no'),
  );
}
console.log('');
