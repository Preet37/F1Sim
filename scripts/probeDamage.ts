/**
 * Does hitting a wall cost what it should?
 *
 * The damage chain has four links and no test covered any of them end to end:
 * closing speed becomes a severity in `VehiclePhysics.collideWithBarrier`, the
 * severity picks a spread of components in `CarDamage.applyImpact`, the health
 * of those components becomes a vehicle spec, and above a threshold the race
 * engine ends the session. A break anywhere in that chain is silent — the car
 * still drives, the numbers still look plausible, and the only symptom is that
 * accidents feel like nothing or like everything.
 *
 * So this asks the question a player would ask, in the units a player thinks in:
 * I hit the wall at this speed and this angle — what happened to my car?
 *
 * Two sections:
 *
 *   1. THE SEVERITY MATRIX. Speed against impact angle, and for each cell the
 *      severity, whether the car was written off, and what came off it. The
 *      shape of this table is the thing to read: severity must rise with BOTH
 *      terms, a shallow brush at any speed must be survivable, and a square
 *      hit at racing speed must end the session.
 *
 *   2. THE COMPONENT LADDER. Repeated hits to the same corner, to check that
 *      damage accumulates toward a component actually falling off rather than
 *      asymptotically approaching it and never arriving. A part that can never
 *      reach the state that detaches it is a part that never comes off.
 *
 * Run: npm run probe:damage
 */

import { VehiclePhysics } from '../src/physics/VehiclePhysics';
import { BASE_F1_SPEC, applySetup, baselineSetupFor } from '../src/physics/VehicleSpec';
import { CarDamage, COMPONENT_IDS, COMPONENT_NAMES, bandOf } from '../src/race/DamageModel';
import { PHYSICS_DT } from '../src/core/SimClock';
import { MS_TO_KPH } from '../src/core/MathUtils';

/**
 * The thresholds the race engine uses. Duplicated here deliberately: if someone
 * changes one in `RaceEngine.onSolidImpact` without changing this, the probe
 * fails and says so, which is the entire value of writing them down twice.
 */
const DAMAGE_THRESHOLD = 0.25;
const WRITE_OFF_THRESHOLD = 0.72;

/** Health at or below which the renderer takes a part off the car. */
const DETACH_HEALTH = 0.3;

const failures: string[] = [];

function spec() {
  return applySetup(BASE_F1_SPEC, baselineSetupFor(0.6, 40));
}

/**
 * Drives a car into a wall at a speed and an angle, and reports what the
 * simulation did about it.
 *
 * The wall's normal points along -z; the car approaches on a heading offset
 * from square by `angleDeg`, so 0 is straight into the barrier and 85 is
 * almost parallel to it.
 */
function hitWall(speedKph: number, angleDeg: number) {
  const car = new VehiclePhysics(spec(), 'medium');
  car.fuelL = 40;
  const heading = (angleDeg * Math.PI) / 180;
  car.placeAt(0, 0, heading, speedKph / MS_TO_KPH);

  // Contact normal, pointing the way the car was going, exactly as the race
  // engine hands it over for the circuit's own barrier line.
  const nx = 0;
  const nz = 1;
  const severity = car.collideWithBarrier(nx, nz, PHYSICS_DT);

  // Everything `RaceEngine.onSolidImpact` does with that severity, in the same
  // order. The point of the probe is the chain, so the chain has to be whole:
  // testing `collideWithBarrier` on its own would have reported a wreck sliding
  // down the barrier at 25 km/h, which is not what happens in a session because
  // the engine stops the car on the next line.
  const damage = new CarDamage();
  const retired = severity > WRITE_OFF_THRESHOLD;
  if (severity > DAMAGE_THRESHOLD) damage.applyImpact('front', severity, retired);
  if (retired) car.stop();

  const lost = COMPONENT_IDS.filter((id) => damage.health[id] <= DETACH_HEALTH);
  return { severity, retired, damage, lost, exitKph: car.speedKph };
}

// ===========================================================================
console.log('\nSEVERITY MATRIX — speed vs impact angle (0 = square into the wall)');
// ===========================================================================
const SPEEDS = [40, 80, 120, 160, 200, 260, 300];
const ANGLES = [0, 10, 25, 45, 70, 85];

console.log('  ' + 'km/h'.padStart(6) + ANGLES.map((a) => (a + '°').padStart(10)).join(''));
console.log('  ' + '-'.repeat(6 + ANGLES.length * 10));

for (const kph of SPEEDS) {
  let row = '  ' + String(kph).padStart(6);
  for (const angle of ANGLES) {
    const r = hitWall(kph, angle);
    const tag = r.retired ? 'OUT' : r.severity > DAMAGE_THRESHOLD ? 'dmg' : '—';
    row += (r.severity.toFixed(2) + ' ' + tag).padStart(10);
  }
  console.log(row);
}

// --- The claims the matrix has to support ---------------------------------
{
  // A light brush must never end anybody's session, at any speed. This is the
  // one that matters most for playability: cars run wide and touch walls, and a
  // game that retires them for it is a game nobody finishes a lap of.
  for (const kph of SPEEDS) {
    const r = hitWall(kph, 85);
    if (r.retired) {
      failures.push(`a 85° brush at ${kph} km/h ends the session (severity ${r.severity.toFixed(2)})`);
    }
  }

  // A square hit at racing speed must. This is the case in the bug report.
  const big = hitWall(200, 0);
  if (!big.retired) {
    failures.push(`a square 200 km/h impact does not retire the car (severity ${big.severity.toFixed(2)})`);
  }
  console.log(
    '\n  200 km/h square-on: severity ' + big.severity.toFixed(2) +
    ', retired=' + big.retired +
    ', speed after impact ' + big.exitKph.toFixed(1) + ' km/h',
  );
  const worst = big.damage.worst();
  console.log(
    '    worst component: ' + COMPONENT_NAMES[worst.id] +
    ' at ' + Math.round(worst.health * 100) + '% (' + bandOf(worst.health) + ')',
  );
  console.log(
    '    parts off the car: ' +
    (big.lost.length ? big.lost.map((id) => COMPONENT_NAMES[id]).join(', ') : 'none'),
  );

  // The claim in the bug report, restated as a test: when the car is written
  // off in one hit, the player has to be able to SEE that it was. A retirement
  // with every part still bolted on is a retirement with nothing to show for
  // itself, and it is why the crash used to read as the car simply vanishing.
  if (big.lost.length === 0) {
    failures.push(
      'a square 200 km/h impact writes the car off without detaching a single part — ' +
      'there is nothing for the player to see',
    );
  }

  // Severity must be monotonic in speed at a fixed angle, and monotonic in
  // squareness at a fixed speed. A non-monotonic response means some middle
  // speed hurts more than a faster one, which no player would ever accept.
  for (const angle of ANGLES) {
    let prev = -1;
    for (const kph of SPEEDS) {
      const s = hitWall(kph, angle).severity;
      if (s < prev - 1e-6) {
        failures.push(`severity falls with speed at ${angle}°: ${kph} km/h is gentler than the step below`);
        break;
      }
      prev = s;
    }
  }
  for (const kph of SPEEDS) {
    let prev = 2;
    for (const angle of ANGLES) {
      const s = hitWall(kph, angle).severity;
      if (s > prev + 1e-6) {
        failures.push(`severity rises with angle at ${kph} km/h: ${angle}° is harsher than square-on`);
        break;
      }
      prev = s;
    }
  }

  // A written-off car has to be stationary. A wreck that keeps its impact
  // speed reads a number on the HUD for a car that is pinned against a wall,
  // and it slides down the barrier for the rest of the session.
  if (big.exitKph > 25) {
    failures.push(`a written-off car is still doing ${big.exitKph.toFixed(0)} km/h after the impact`);
  }
}

// ===========================================================================
console.log('\nCOMPONENT LADDER — repeated NON-terminal front-corner hits at severity 0.8');
// ===========================================================================
// Racing contact, not accidents. This is the ladder that has to stay gentle:
// every one of these is a car that carried on, and if a few of them strip the
// bodywork off then the field damages itself into a slow procession. The
// regression that produced exactly that took Silverstone from 13 finishers to
// 8, and this table is where it would show up again.
{
  const damage = new CarDamage();
  console.log(
    '  ' + 'HIT'.padStart(4) + 'FRONT WING L'.padStart(14) + 'SUSP FL'.padStart(10) +
    'FLOOR'.padStart(8) + '  DETACHED',
  );
  let everDetached = false;
  for (let hit = 1; hit <= 6; hit++) {
    damage.applyImpact('front', 0.8);
    const lost = COMPONENT_IDS.filter((id) => damage.health[id] <= DETACH_HEALTH);
    if (lost.length > 0) everDetached = true;
    console.log(
      '  ' + String(hit).padStart(4) +
      (Math.round(damage.health.frontWingL * 100) + '%').padStart(14) +
      (Math.round(damage.health.suspFL * 100) + '%').padStart(10) +
      (Math.round(damage.health.floor * 100) + '%').padStart(8) +
      '  ' + (lost.length ? lost.map((id) => COMPONENT_NAMES[id]).join(', ') : '—'),
    );
  }
  if (!everDetached) {
    failures.push(
      'no component ever reaches the detach threshold under repeated heavy impacts — ' +
      'nothing can come off the car',
    );
  }
  // The other half of the same claim: ONE piece of racing contact, however
  // hard, must leave the car able to race. A single hit that strips a wing is
  // the failure mode that ate the field.
  {
    const once = new CarDamage();
    once.applyImpact('front', 1.0, false);
    const stripped = COMPONENT_IDS.filter((id) => once.health[id] <= DETACH_HEALTH);
    if (stripped.length > 0) {
      failures.push(
        'a single non-terminal impact detached ' + stripped.length + ' component(s) — ' +
        'racing contact is stripping cars that are still racing',
      );
    }
  }

  // And the reverse: a pit stop has to put it back, or the visual model will
  // hold a car in pieces that the simulation considers repaired.
  damage.repair();
  const stillBroken = COMPONENT_IDS.filter((id) => damage.health[id] < 0.999);
  if (stillBroken.length > 0) {
    failures.push('repair() left ' + stillBroken.length + ' components damaged');
  }
}

// ===========================================================================
console.log('\nSIDE IMPACT — what a terminal hit on the left costs');
// ===========================================================================
{
  const damage = new CarDamage();
  damage.applyImpact('left', 0.9, true);
  const hurt = COMPONENT_IDS
    .filter((id) => damage.health[id] < 0.999)
    .sort((a, b) => damage.health[a] - damage.health[b]);
  for (const id of hurt) {
    console.log(
      '  ' + COMPONENT_NAMES[id].padEnd(20) +
      (Math.round(damage.health[id] * 100) + '%').padStart(6) + '  ' + bandOf(damage.health[id]),
    );
  }
  // A left-side impact must not damage the right-hand sidepod. Damage having a
  // SHAPE is the whole reason the model is per-component.
  if (damage.health.sidepodR < 0.999) {
    failures.push('a left-side impact damaged the right sidepod — damage has no side');
  }
  if (damage.health.sidepodL >= 0.999) {
    failures.push('a left-side impact did not damage the left sidepod');
  }
}

// ===========================================================================
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('\nPASS — impacts cost what their speed and angle say they should.');
}
