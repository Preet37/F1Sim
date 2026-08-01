/**
 * Is the PLAYER held to the neutralised speed limit?
 *
 * `validate:flags` measures what the nineteen AI cars do about a safety car and
 * a VSC, and they obey it. It has never measured the twentieth. The player's
 * report is one sentence about both halves of that: "under safetycar and flags
 * and everything every car has to follow the speedlimit, it should auto put the
 * speed up."
 *
 *   EVERY car. A rule nineteen cars obey and the twentieth does not is not a
 *   rule, it is a handicap applied to the AI.
 *
 *   AUTOMATICALLY. The pit lane limit is applied FOR the player — the engine
 *   brakes for the entry and arms the limiter, because a limit the game presses
 *   the button for is a limit the game owes the driver an arrival at. Nothing
 *   did that for a neutralisation, and the delta is far harder to judge by eye
 *   than a pit entry: it is a minimum SECTOR TIME measured by the FIA ECU
 *   (2025 Sporting Regs Art. 55.7 and 56.5 / 2026 Section B Art. B5.13.2b and
 *   B5.12.2b), not a number on a speedometer, and the penalty for getting it
 *   wrong is five seconds.
 *
 * THE DRIVER. The game's own AI drives the player's car, exactly as
 * `probePitLimiter` does it and for the same reason: a throwaway driver that
 * cannot get round Parabolica fails the probe for reasons that have nothing to
 * do with flags. It is given one lie — `neutralised` is FALSE in the perception
 * it reads — so it does not lift for the safety car of its own accord. That is
 * not a handicap invented to make the test fail; it is precisely the player who
 * has not noticed the boards, and the whole question is whether the game holds
 * them anyway.
 *
 * Run: npm run probe:neutralplayer
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import type { CarEntry } from '../src/race/CarEntry';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { VehicleControls } from '../src/physics/VehiclePhysics';
import type { TrackSpline } from '../src/track/TrackSpline';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import { loopDelta } from '../src/core/MathUtils';
import { neutralisationCue } from '../src/ui/Hud';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }

const SEED_OFFSET = Number(process.env.NEUTRAL_PLAYER_SEED_OFFSET ?? 0) | 0;

/** A driver who does not know the safety car is out. */
class BlindDriver {
  private readonly ai: AIVehicleController;
  private readonly view: AIPerception;

  constructor(private readonly car: CarEntry, track: TrackSpline) {
    this.ai = new AIVehicleController(car.driver, track, 991, 'hard');
    this.view = { ...car.perception };
  }

  drive(dt: number, out: VehicleControls): void {
    Object.assign(this.view, this.car.perception);
    // The one lie. Everything else — the racing line, the corner speeds, the
    // cars around it — is the real thing.
    this.view.neutralised = false;
    this.view.neutralisedTargetMs = 0;
    this.view.neutralisedScale = 0;
    this.view.queueGapM = 0;
    this.view.queueAheadM = -1;
    this.view.safetyCarAheadM = -1;
    this.view.pitThisLap = false;

    const c = this.ai.update(dt, this.car.physics, this.car.s, this.car.lateral, this.view);
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.steer = c.steer;
    out.drsRequested = false;
    out.ersMode = c.ersMode;
    out.gearRequest = 0;
    out.reverse = false;
  }
}

interface Result {
  circuit: string;
  /** Samples taken while neutralised and out on the circuit. */
  samples: number;
  /** Of those, samples where the limiter was armed. */
  limited: number;
  /** Worst overshoot of the limiter's own setpoint once settled, km/h. */
  worstOverKph: number;
  /** Seconds spent meaningfully over the setpoint once settled. */
  overS: number;
  /** Samples taken under each regime, so a HUD claim is only made about one. */
  vscSamples: number;
  scSamples: number;
  /** Marshalling sectors the player completed, and how many were too quick. */
  sectors: number;
  sectorsTooQuick: number;
  /** Delta penalties and warnings issued to the player. */
  deltaBreaches: number;
  deltaPenalties: number;
  /** Mean pace, player and field, as a fraction of the racing line, per regime. */
  playerPace: [number, number];
  fieldPace: [number, number];
  /** Seconds spent under each regime. */
  vscS: number;
  scS: number;
  /** What the HUD said, the first time it said anything under each regime. */
  vscCue: string;
  scCue: string;
}

function run(circuit: string, laps: number, seed: number, assist: boolean): Result {
  const def = getCircuit(circuit);
  const config: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps,
    playerIndex: 0, standingStart: true, pitLaneStart: false, seed,
  };
  const engine = new RaceEngine(def, config);
  engine.neutralisationAssist = assist;
  const rc = engine.raceControl;
  const player = engine.cars[config.playerIndex];
  const driver = new BlindDriver(player, engine.track);
  const c = engine.playerControls;

  const r: Result = {
    circuit, samples: 0, limited: 0, worstOverKph: 0, overS: 0,
    vscSamples: 0, scSamples: 0,
    sectors: 0, sectorsTooQuick: 0, deltaBreaches: 0, deltaPenalties: 0,
    playerPace: [0, 0], fieldPace: [0, 0], vscS: 0, scS: 0, vscCue: '', scCue: '',
  };
  /**
   * When the current regime came out.
   *
   * A limiter is a speed cap, not a teleport — the pit one is held to exactly
   * the same standard, and it is given a whole braking zone to arrive in. A car
   * doing 300 km/h when the boards light up is thirty metres a second over the
   * delta through no fault of anybody's, and the honest question is whether it
   * is HELD at the limit, not whether it was never above it. So the arrival is
   * excluded and everything after it is judged.
   */
  let regimeSince = -1;
  let regimeWas = 'none';
  const ARRIVAL_S = 6;
  // Indexed by regime: 0 = VSC, 1 = safety car. Never pooled, because the two
  // impose different paces and a player who spends a VSC period out of the
  // queue would otherwise be compared against a field measured under a safety
  // car — which is not a comparison of anything.
  const playerPaceSum = [0, 0], playerPaceN = [0, 0];
  const fieldPaceSum = [0, 0], fieldPaceN = [0, 0];

  /** The marshalling sector the player is timing, and how long it has taken. */
  let sectorIndex = -1;
  let sectorTime = 0;
  let sectorClean = false;

  let victim: CarEntry | null = null;
  let staged = 0;
  /** Which incident to stage next: a VSC case, then a safety car case. */
  let stage = 0;

  const maxSteps = Math.round(laps * def.referencePoleTimeS * 4 / PHYSICS_DT);

  for (let step = 0; step < maxSteps && !engine.over; step++) {
    driver.drive(PHYSICS_DT, c);
    engine.step();

    // --- Stage two incidents: one slow-corner (VSC), one flat-out (SC) -----
    if (stage < 2 && !victim && engine.time > 45 + stage * 5 &&
        rc.neutralisation === 'none' && rc.activeIncidents === 0) {
      const running = engine.standings.filter(
        (x) => !x.retired && !x.inPitLane && !x.isPlayer);
      const cand = running[running.length - 1];
      if (cand) {
        victim = cand;
        staged = engine.time;
        const s = stagePoint(engine.track, stage === 1);
        cand.retire('Probe: staged incident', engine.time);
        cand.s = s;
        cand.lateral = engine.track.halfWidthAt(s) + 1.6;
        cand.physics.velocity.set(0, 0);
        cand.physics.localVelX = 0;
        cand.physics.localVelY = 0;
        stage++;
      }
    }
    // Hold the marshals back so the neutralisation lasts long enough to be a
    // measurement rather than a sample. The same lever `validate:flags` uses.
    if (victim && engine.time - staged < 150) {
      victim.recovery.workRemainingS = Math.max(victim.recovery.workRemainingS, 60);
      victim.recovery.elapsedS = 0;
    } else if (victim && engine.time - staged >= 150) {
      victim = null;
    }

    for (const m of rc.messages) {
      if (m.carIndex !== player.index) continue;
      if (/below the delta/i.test(m.text) && /penalty/i.test(m.text)) {
        r.deltaPenalties = Math.max(r.deltaPenalties, player.penalties.filter(
          (p) => /delta/i.test(p.reason)).length);
      }
    }
    r.deltaBreaches = player.deltaBreaches;

    const neutral = rc.neutralisation !== 'none';
    if (rc.neutralisation !== regimeWas) {
      regimeWas = rc.neutralisation;
      regimeSince = engine.time;
    }
    if (neutral) {
      if (rc.neutralisation === 'vsc') r.vscS += PHYSICS_DT; else r.scS += PHYSICS_DT;
    }

    // --- The limiter -------------------------------------------------------
    if (neutral && !player.inPitLane && !player.retired && engine.started) {
      r.samples++;
      const settled = engine.time - regimeSince > ARRIVAL_S;
      const limit = player.appliedControls.speedLimitMs;
      if (limit > 0) {
        r.limited++;
        const over = (player.physics.speedMs - limit) * 3.6;
        if (settled) {
          if (over > r.worstOverKph) r.worstOverKph = over;
          if (over > 10) r.overS += PHYSICS_DT;
        }
      }

      // PACE, compared only between cars that are all under the same
      // obligation. A car more than the maximum gap behind the one in front is
      // REQUIRED to close it (Art. 55.7 / B5.13.2b) and is entitled to run
      // quicker while it does, so its speed is not a sample of the queue's
      // pace — for the player or for anybody else. Filtering one side and not
      // the other would compare a car catching up against a queue that is not.
      const queued = (x: CarEntry): boolean => {
        if (x.mustUnlap) return false;
        const g = x.perception.queueAheadM;
        if (rc.neutralisation === 'vsc') {
          // Under a VSC nobody queues — the gaps are held as they were
          // (Art. 56.5 / B5.12.2b asks for the delta, not for a formation) —
          // so a car running nose-to-tail is driving to the car in front
          // rather than to the pace, and its speed says nothing about the
          // limit. It matters at Monaco, where twenty cars at VSC pace on a
          // 3.3km lap end up three metres apart whether anybody meant them to
          // or not, and the whole field then reads at a third of the delta.
          return g < 0 || g > 25;
        }
        return g >= 0 && g <= rc.maxQueueGapM;
      };
      const reg = rc.neutralisation === 'vsc' ? 0 : 1;
      const idx = engine.track.indexAt(player.s);
      const target = engine.track.targetSpeed[idx];
      if (target > 1 && queued(player)) {
        playerPaceSum[reg] += player.physics.speedMs / target;
        playerPaceN[reg]++;
      }
      for (const other of engine.cars) {
        if (other.isPlayer || other.retired || other.inPitLane) continue;
        if (!queued(other)) continue;
        const t = engine.track.targetSpeed[engine.track.indexAt(other.s)];
        if (t > 1) { fieldPaceSum[reg] += other.physics.speedMs / t; fieldPaceN[reg]++; }
      }

      // The cue in STEADY STATE, not on the frame the boards lit up. Race
      // control is evaluated after the cars in a step, so on the very first
      // neutralised frame the limiter has not been armed yet and the HUD is
      // correctly still saying nothing about it.
      const cue = settled ? neutralisationCue(engine, player) : null;
      if (cue) {
        if (rc.neutralisation === 'vsc') { r.vscCue = cue.text; r.vscSamples++; }
        else { r.scCue = cue.text; r.scSamples++; }
      }
    }

    // --- Marshalling sector times, judged the way race control judges them --
    const sec = rc.sectorIndexAt(player.s);
    if (sec !== sectorIndex) {
      if (sectorClean && sectorTime > 0.5) {
        r.sectors++;
        if (sectorTime < rc.minimumSectorTimeS) r.sectorsTooQuick++;
      }
      sectorClean = sectorIndex >= 0 && neutral && !player.inPitLane && !player.mustUnlap;
      sectorIndex = sec;
      sectorTime = 0;
    }
    sectorTime += PHYSICS_DT;
    if (!neutral || player.inPitLane || player.mustUnlap) sectorClean = false;
  }

  for (let i = 0; i < 2; i++) {
    r.playerPace[i] = playerPaceN[i] > 200 ? playerPaceSum[i] / playerPaceN[i] : 0;
    r.fieldPace[i] = fieldPaceN[i] > 200 ? fieldPaceSum[i] / fieldPaceN[i] : 0;
  }
  return r;
}

/** The fastest, or slowest, point on the lap that is not in the pit lane. */
function stagePoint(t: TrackSpline, fast: boolean): number {
  let best = 0;
  let bestScore = fast ? -Infinity : Infinity;
  for (let i = 0; i < t.count; i += 4) {
    const v = t.targetSpeed[i];
    const s = (i / t.count) * t.length;
    const pit = t.def.pitLane;
    const fromEntry = loopDelta(pit.entryS, s, t.length);
    if (fromEntry >= 0 && fromEntry < t.length * 0.5 && loopDelta(s, pit.exitS, t.length) >= 0) {
      continue;
    }
    if (fast ? v > bestScore : v < bestScore) { bestScore = v; best = s; }
  }
  return best;
}

// ===========================================================================

console.log('\nTHE PLAYER UNDER A NEUTRALISATION — a driver who has not seen the boards');
console.log(
  '  ' + 'CIRCUIT'.padEnd(14) + 'VSC'.padStart(7) + 'SC'.padStart(7) +
  'LIMITER'.padStart(9) + 'OVER'.padStart(9) + 'OVER 10k'.padStart(10) + 'SECTORS'.padStart(9) +
  'TOO QUICK'.padStart(11) + 'DELTA PENALTIES'.padStart(17),
);

const CIRCUITS = ['monza', 'silverstone', 'monaco', 'bahrain'];
const results: Result[] = [];
/** The same scenarios with the assist switched off, as a control. */
const controls: Result[] = [];
for (let i = 0; i < CIRCUITS.length; i++) {
  const seed = 91000 + i * 13 + SEED_OFFSET;
  controls.push(run(CIRCUITS[i], 8, seed, false));
  const r = run(CIRCUITS[i], 8, seed, true);
  results.push(r);
  console.log(
    '  ' + r.circuit.padEnd(14) +
    (r.vscS.toFixed(0) + 's').padStart(7) + (r.scS.toFixed(0) + 's').padStart(7) +
    (r.samples > 0 ? (100 * r.limited / r.samples).toFixed(0) + '%' : '--').padStart(9) +
    (r.worstOverKph.toFixed(1) + 'k').padStart(9) +
    (r.overS.toFixed(1) + 's').padStart(10) +
    String(r.sectors).padStart(9) + String(r.sectorsTooQuick).padStart(11) +
    String(r.deltaPenalties).padStart(17),
  );
}

console.log('');
for (const r of results) {
  for (let i = 0; i < 2; i++) {
    if (r.playerPace[i] <= 0 || r.fieldPace[i] <= 0) continue;
    console.log(
      '  ' + r.circuit.padEnd(14) + (i === 0 ? 'VSC ' : 'SC  ') +
      'player ' + (r.playerPace[i] * 100).toFixed(1) +
      '% of the racing line, field ' + (r.fieldPace[i] * 100).toFixed(1) +
      '%  (x' + (r.playerPace[i] / r.fieldPace[i]).toFixed(2) + ')',
    );
  }
}
console.log('');
console.log('  WITH THE ASSIST OFF — the same seed, the same driver, the same safety car');
for (let i = 0; i < controls.length; i++) {
  const c = controls[i];
  console.log(
    '  ' + c.circuit.padEnd(14) +
    String(c.sectorsTooQuick).padStart(4) + ' of ' + String(c.sectors).padStart(4) +
    ' marshalling sectors under the FIA minimum, ' +
    c.deltaPenalties + ' delta penalties',
  );
}

console.log('');
for (const r of results) {
  if (r.vscCue) console.log('  HUD, ' + r.circuit.padEnd(12) + 'VSC:  ' + r.vscCue);
  if (r.scCue) console.log('  HUD, ' + r.circuit.padEnd(12) + 'SC:   ' + r.scCue);
}

// --- Assertions ------------------------------------------------------------

// 0. The control has to show a problem, or the rest of this proves nothing.
//    A probe whose "before" also passes is measuring something that was never
//    broken.
{
  const breaches = controls.reduce((a, c) => a + c.sectorsTooQuick, 0);
  const penalties = controls.reduce((a, c) => a + c.deltaPenalties, 0);
  if (breaches === 0 && penalties === 0) {
    fail('with the assist switched off the player broke the delta nowhere — the control is not ' +
      'reproducing the defect, so nothing below is evidence of anything');
  }
}

for (const r of results) {
  if (r.samples < 500) {
    fail(`${r.circuit}: only ${r.samples} samples under a neutralisation — nothing was measured`);
    continue;
  }

  // 1. AUTOMATIC. The limiter is armed for the player, without them asking.
  const armed = r.limited / r.samples;
  if (armed < 0.98) {
    fail(`${r.circuit}: the neutralised limiter was armed for only ${(armed * 100).toFixed(0)}% ` +
      `of the time the player spent out on a neutralised circuit`);
  }

  // 2. It actually limits. A cap enforced by braking is allowed the arrival —
  //    the pit limiter gets a whole braking zone for the same reason — but once
  //    settled the car has to be AT the limit, not near it.
  //
  //    Brief excursions are allowed and are not a defect. The setpoint moves
  //    with the road and with the car in front, so it can step down — a car
  //    ahead braking for a chicane moves it several metres a second in one
  //    step — and a limiter is an engine cut bounded to a g, not a teleport.
  //    What would not be allowed is a car that lives above the limit, which is
  //    what a player with no assist at all does for the whole neutralisation.
  const neutralS = r.vscS + r.scS;
  if (r.overS > neutralS * 0.03) {
    fail(`${r.circuit}: the player spent ${r.overS.toFixed(1)}s of ${neutralS.toFixed(0)}s more ` +
      `than 10 km/h over the limiter's own setpoint after the field had settled — it is not ` +
      `holding the car`);
  }
  if (r.worstOverKph > 45) {
    fail(`${r.circuit}: the player reached ${r.worstOverKph.toFixed(0)} km/h over the limiter's ` +
      `setpoint well after the boards came out`);
  }

  // 3. And the thing the limit EXISTS to satisfy: the FIA ECU minimum time in
  //    every marshalling sector (Art. 55.7 and 56.5 / B5.13.2b and B5.12.2b).
  if (r.sectorsTooQuick > 0) {
    fail(`${r.circuit}: the player completed ${r.sectorsTooQuick} of ${r.sectors} marshalling ` +
      `sectors under the FIA minimum time`);
  }
  if (r.deltaPenalties > 0) {
    fail(`${r.circuit}: the player collected ${r.deltaPenalties} delta penalties while the game ` +
      `was supposed to be applying the limit for them`);
  }

  // 4. EVERY car. Judged against the CONTROL rather than against an absolute
  //    threshold, because how close the field runs to the delta is a property
  //    of the AI and of the circuit — at Monaco it is conservative enough that
  //    a player driving exactly to the limit still reads quicker than the mean
  //    — and what is being asserted here is that the assist closes most of the
  //    gap between a player who is not limited at all and the field around
  //    them.
  //
  //    And only where the control actually misbehaved. At Monaco an unlimited
  //    player breaks the delta in none of 134 marshalling sectors, because the
  //    ECU minimum is derived from a global cap and a lap of Monaco is slower
  //    than that cap almost everywhere — there is no defect there to close, and
  //    asserting that the assist closed one would be asserting noise.
  const control = controls.find((c) => c.circuit === r.circuit);
  if (control && control.sectorsTooQuick === 0) continue;
  for (let i = 0; i < 2 && control; i++) {
    if (r.playerPace[i] <= 0 || r.fieldPace[i] <= 0) continue;
    if (control.playerPace[i] <= 0 || control.fieldPace[i] <= 0) continue;
    const before = control.playerPace[i] / control.fieldPace[i];
    const after = r.playerPace[i] / r.fieldPace[i];
    if (before <= 1.05) continue;
    const closed = (before - after) / (before - 1);
    if (closed < 0.6) {
      fail(`${r.circuit}: under ${i === 0 ? 'the VSC' : 'the safety car'} an unlimited player ` +
        `ran at x${before.toFixed(2)} the field's pace and a limited one still runs at ` +
        `x${after.toFixed(2)} — the assist closed only ${(closed * 100).toFixed(0)}% of it`);
    }
  }

  // 5. The HUD says what is being enforced and what the target is.
  if (r.vscSamples > 200) {
    if (!/MIN SECTOR/i.test(r.vscCue)) {
      fail(`${r.circuit}: under a VSC the HUD said "${r.vscCue}" — it must give the minimum ` +
        `sector time, which is what Art. 56.5 / B5.12.2b actually requires`);
    }
    if (!/LIMITER/i.test(r.vscCue)) {
      fail(`${r.circuit}: the HUD did not say the limiter was on under the VSC while it was ` +
        `holding the car`);
    }
  }
  if (r.scSamples > 200) {
    if (!/GAP/i.test(r.scCue)) {
      fail(`${r.circuit}: under the safety car the HUD said "${r.scCue}" — it must give the gap ` +
        `to the car ahead and the maximum, which is what Art. 55.7 / B5.13.2b requires`);
    }
    if (!/LIMITER/i.test(r.scCue)) {
      fail(`${r.circuit}: the HUD did not say the limiter was on under the safety car while it ` +
        `was holding the car`);
    }
  }
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('The player is held to the neutralised limit, automatically, and told why.\n');
}
