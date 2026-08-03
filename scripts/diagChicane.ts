/**
 * How the flick lane in `probe:handling` §5 was chosen — the working, kept.
 *
 * A lane added to a probe is a bar somebody will later be held to, so it has to
 * be chosen against stated requirements rather than picked and hoped for. This
 * file is the sweep that chose it, kept so the choice can be re-examined instead
 * of taken on trust.
 *
 * TWO REQUIREMENTS.
 *
 *  (a) THE ANALOGUE ARM MUST HOLD IT. The whole rig rests on the wheel arm being
 *      a control: if the continuous-steering driver cannot track a lane, then a
 *      difference between the arms is a fact about the driver model and not
 *      about the input path. Section 1 sweeps speed x peak g x period and prints
 *      the wheel arm's own error so this can be read off rather than assumed.
 *      It is not a formality — the first draft of the lane (1.5g, 150m period,
 *      180 km/h) left the WHEEL arm swinging 5.0m and every candidate scored a
 *      ratio near 1.0 because both arms were failing for the same reason.
 *
 *  (b) IT MUST CATCH A LAZY WHEEL. The flick lane exists to stop a candidate
 *      buying calm by making the wheel too slow to change direction. Section 2
 *      therefore flies the shortlist plus two DELIBERATELY over-slowed
 *      configurations down each candidate lane, and a lane that cannot separate
 *      them is decoration.
 *
 * The answer, and it was not the expected one: over-slowing the RACK to 1.7
 * units/s takes the chosen lane from 1.67m to 2.64m and through the 2.0m bar,
 * while over-slowing the RETURN to 1.7 costs 0.11m. A slow return is nearly free
 * in a direction change, because pressing the opposite key ramps straight
 * through centre at the rack rate and never consults the return rate at all.
 *
 * Run: npm run diag:chicane
 */
import { driveLane, weaveForG } from './lib/keyboardRig';
import type { InputConfig } from '../src/input/InputController';

const COMMON = { durationS: 26, framePeriodMs: 1000 / 60, startOffsetM: 0, captureS: 10, departM: 20 };

// ===========================================================================
// 1. Can the analogue arm hold it?
// ===========================================================================

console.log('\n1. CAN THE CONTROL ARM HOLD IT?  (analogue wheel, same driver)');
console.log('  A lane whose wheel-arm swing is large is a lane that measures the driver');
console.log('  model. The keyboard columns are the SHIPPED default, for scale.');
console.log('');
console.log('  kph     g   period   wheel swing   wheel rms   kb swing   kb rms   ratio   amp');
console.log('  ' + '-'.repeat(84));
for (const kph of [180, 220, 260]) {
  for (const g of [0.8, 1.2, 1.6]) {
    for (const period of [70, 90, 110, 140]) {
      const lane = weaveForG(kph, g, period);
      const common = { ...COMMON, lane, speedKph: kph };
      const w = driveLane({ ...common, keyboard: false });
      const kb = driveLane({ ...common });
      const ratio = w.swingM > 1e-3 ? kb.swingM / w.swingM : Infinity;
      console.log(
        '  ' + String(kph).padStart(3) + g.toFixed(1).padStart(6) + String(period).padStart(8)
        + (w.departed ? '           dep' : w.swingM.toFixed(2).padStart(14))
        + w.rmsErrM.toFixed(2).padStart(12)
        + (kb.departed ? '        dep' : kb.swingM.toFixed(2).padStart(11))
        + kb.rmsErrM.toFixed(2).padStart(9)
        + (Number.isFinite(ratio) ? ratio.toFixed(1).padStart(8) : '      --')
        + `   ${lane.weaveAmpM!.toFixed(2)}m`,
      );
    }
  }
}

// ===========================================================================
// 2. Does it separate a lazy wheel from a calm one?
// ===========================================================================

/**
 * Every configuration is written out IN FULL, all three fields, deliberately.
 *
 * A `{}` here would mean "whatever ships", and the whole point of the two BREAK
 * rows is to be measured against the feel they are a break OF. When the shipped
 * default changed from `classic` to `settled` a partial config silently changed
 * what the break inherited and moved every number in this table — which is the
 * same class of mistake as a probe that reads a settings object instead of the
 * thing the settings are supposed to control.
 */
function cfg(rack: number, ret: number, publish: 'end' | 'mean'): Partial<InputConfig> {
  return {
    keyboardSteerRate: rack, keyboardCentreRate: ret, keyboardSteerPublish: publish,
  };
}

const CANDS: { name: string; cfg: Partial<InputConfig> }[] = [
  { name: 'classic 3.4/5.5 end', cfg: cfg(3.4, 5.5, 'end') },
  { name: 'settled 3.4/2.8 mean', cfg: cfg(3.4, 2.8, 'mean') },
  { name: 'calm 3.4/2.2 mean', cfg: cfg(3.4, 2.2, 'mean') },
  // The two deliberate over-slows, each holding everything else at CLASSIC so
  // the cost is attributable to the one number that moved.
  { name: 'BREAK return 1.7', cfg: cfg(3.4, 1.7, 'end') },
  { name: 'BREAK rack 1.7', cfg: cfg(1.7, 5.5, 'end') },
];

const LANES = [
  { kph: 180, g: 1.2, period: 90, chosen: true },
  { kph: 180, g: 1.6, period: 90, chosen: false },
  { kph: 220, g: 1.6, period: 90, chosen: false },
  { kph: 180, g: 1.2, period: 110, chosen: false },
];

console.log('\n\n2. DOES IT CATCH A LAZY WHEEL?  (bar is probe:handling §5\'s 2.0m)');
for (const L of LANES) {
  const lane = weaveForG(L.kph, L.g, L.period);
  const common = { ...COMMON, lane, speedKph: L.kph };
  const w = driveLane({ ...common, keyboard: false });
  console.log(`\n  ${L.chosen ? '>>> CHOSEN <<< ' : ''}chicane ${L.g}g at ${L.kph} km/h, `
    + `period ${L.period}m (amp ${lane.weaveAmpM!.toFixed(2)}m, reversal every `
    + `${((L.period / 2) / (L.kph / 3.6)).toFixed(2)}s)`);
  console.log(`  wheel arm: swing ${w.swingM.toFixed(2)}m  rms ${w.rmsErrM.toFixed(2)}m`
    + (w.departed ? '  DEPARTED' : ''));
  console.log('    candidate               kb swing   kb rms   ratio');
  for (const c of CANDS) {
    const kb = driveLane({ ...common, inputConfig: c.cfg });
    const ratio = w.swingM > 1e-3 ? kb.swingM / w.swingM : Infinity;
    console.log('    ' + c.name.padEnd(22)
      + (kb.departed ? '       dep' : kb.swingM.toFixed(2).padStart(10))
      + kb.rmsErrM.toFixed(2).padStart(9)
      + (Number.isFinite(ratio) ? ratio.toFixed(2).padStart(8) : '      --'));
  }
}
console.log('');
