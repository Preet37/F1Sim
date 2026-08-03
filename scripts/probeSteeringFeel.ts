/**
 * Steering feel: three candidates, one ruler, one table.
 *
 * WHAT THIS IS FOR. Issue #46 localised the swerve to the input path and stopped
 * there on purpose: *"this is a feel decision and should not be taken
 * unilaterally in the same PR that built the ruler."* This probe is how the
 * decision gets taken from measurements instead of from adjectives. It sweeps
 * all three candidate fixes across the SAME lanes `probe:handling` §5 uses, with
 * the same driver, the same car and the same analogue-wheel control arm, and
 * prints one row per configuration.
 *
 *   1. SLOW THE RETURN  — `keyboardCentreRate` 5.5 (today) / 4.5 / 3.4 / 2.8
 *   2. SLOW THE RAMP    — `keyboardSteerRate`  3.4 (today) / 2.8 / 2.2 / 1.7
 *   3. PUBLISH THE MEAN — the frame reports the mean lock it held rather than
 *                         the value it ended on
 *   and the combinations, because the sweep is what says whether one is enough.
 *
 * EVERY CANDIDATE IS CHARGED FOR WHAT IT COSTS. A slower spring is a slower
 * direction change, so the lane set gains a CHICANE — a sinusoidal centreline
 * asking for a stated peak g and reversing every half period — and the report
 * carries the latency to reach a corner's lock, the time to full lock, and the
 * time to complete a flick from full lock to the same lock the other way. A
 * candidate that fixes the sawtooth by making the car unable to change direction
 * is not a fix, and without the chicane and the flick timing this probe could
 * not tell the difference.
 *
 * NO BARS ARE MOVED HERE. `probe:handling` owns the bars — never leaves the
 * road, and settled wander inside a car's width — and they are quoted, not
 * redefined (PROJECT.md §3.3). This file reports; `probe:handling` judges.
 *
 * Run: npm run probe:steeringfeel
 */

import {
  driveLane, radiusForG, steerStepResponse, tapOnce, weaveForG, type Lane,
} from './lib/keyboardRig';
import type { InputConfig } from '../src/input/InputController';
import {
  DEFAULT_STEERING_FEEL, STEERING_FEELS, STEERING_FEEL_IDS,
} from '../src/input/SteeringFeel';

// ===========================================================================
// The lanes — `probe:handling` §5's six, plus the chicane it did not have
// ===========================================================================

interface LaneCase {
  label: string;
  lane: Lane;
  kph: number;
  startOffsetM: number;
  /** Chicane lanes are reported separately: they measure the opposite cost. */
  flick: boolean;
}

/**
 * The chicane, and why it is these three numbers.
 *
 * 180 km/h through a 90m sinusoid asking 1.2g at its peaks: the lane reverses
 * every 45m, which at 50 m/s is a direction change every 0.90s, and it moves
 * +/-0.97m under the car. Suzuka's esses are in this neighbourhood.
 *
 * CHOSEN AGAINST TWO REQUIREMENTS, both measured (`scripts/diagChicane.ts`
 * swept 36 combinations of speed, peak g and period):
 *
 *  (a) THE CONTROL ARM MUST HOLD IT. A lane the analogue wheel cannot track is a
 *      measurement of the driver model, not of the input path. The first draft
 *      of this lane — 1.5g, 150m period — left the WHEEL arm swinging 5.0m, and
 *      every candidate scored a ratio near 1.0 because both arms were failing
 *      for the same reason. Here the wheel arm holds 1.26m.
 *  (b) IT MUST CATCH A LAZY WHEEL. Deliberately over-slowing the RACK to 1.7
 *      units/s takes the keyboard arm from 1.67m to 2.64m and through the 2.0m
 *      bar, while over-slowing the RETURN to 1.7 costs 0.11m. That asymmetry is
 *      itself a finding — a slow return is nearly free in a direction change and
 *      a slow ramp is not — and a lane that could not show it would be
 *      decoration.
 */
const CHICANE_KPH = 180;
const CHICANE_G = 1.2;
const CHICANE_PERIOD_M = 90;

const LANE_CASES: LaneCase[] = [
  { label: 'straight', lane: { radiusM: Infinity }, kph: 120, startOffsetM: 2, flick: false },
  { label: 'straight', lane: { radiusM: Infinity }, kph: 200, startOffsetM: 2, flick: false },
  { label: 'straight', lane: { radiusM: Infinity }, kph: 280, startOffsetM: 2, flick: false },
  { label: 'corner 1.2g', lane: { radiusM: radiusForG(120, 1.2) }, kph: 120, startOffsetM: 0, flick: false },
  { label: 'corner 2.0g', lane: { radiusM: radiusForG(200, 2.0) }, kph: 200, startOffsetM: 0, flick: false },
  { label: 'corner 2.6g', lane: { radiusM: radiusForG(280, 2.6) }, kph: 280, startOffsetM: 0, flick: false },
  {
    label: 'chicane 1.5g',
    lane: weaveForG(CHICANE_KPH, CHICANE_G, CHICANE_PERIOD_M),
    kph: CHICANE_KPH, startOffsetM: 0, flick: true,
  },
];

/** Quoted from `probe:handling`, not redefined here. */
const SWING_BAR_M = 2.0;
const DEPART_BAR_M = 20;
const SETTLE_S = 10;
const DURATION_S = 26;

/** The steady lock a 2.0g corner at 200 km/h needs — issue #46's own number. */
const CORNER_LOCK = 0.253;

// ===========================================================================
// The configurations under test
// ===========================================================================

interface Candidate {
  /** Which of the three mechanisms this row belongs to. */
  family: string;
  name: string;
  cfg: Partial<InputConfig>;
}

/**
 * Every configuration is written out IN FULL, all three fields.
 *
 * A partial config inherits whatever ships, so the moment one of these
 * candidates BECAME what ships, a `{}` baseline row silently stopped being the
 * baseline and every "today" number in the table moved. Writing all three fields
 * makes the sweep independent of its own outcome, which is the only way a
 * comparison table survives the decision it was made to inform.
 */
function cfg(rack: number, ret: number, publish: 'end' | 'mean'): Partial<InputConfig> {
  return {
    keyboardSteerRate: rack, keyboardCentreRate: ret, keyboardSteerPublish: publish,
  };
}

const CANDIDATES: Candidate[] = [
  { family: 'baseline', name: 'today  3.4/5.5 end', cfg: cfg(3.4, 5.5, 'end') },

  // 1. Slow the return-to-centre.
  { family: '1 return', name: 'ret 4.5           ', cfg: cfg(3.4, 4.5, 'end') },
  { family: '1 return', name: 'ret 3.4 symmetric ', cfg: cfg(3.4, 3.4, 'end') },
  { family: '1 return', name: 'ret 2.8           ', cfg: cfg(3.4, 2.8, 'end') },
  { family: '1 return', name: 'ret 2.2           ', cfg: cfg(3.4, 2.2, 'end') },

  // 2. Slow the ramp. Same proportional span as the return sweep: 5.5 -> 2.8 is
  //    x0.51, so 3.4 -> 1.7 is the matching bottom end.
  { family: '2 ramp  ', name: 'ramp 2.8          ', cfg: cfg(2.8, 5.5, 'end') },
  { family: '2 ramp  ', name: 'ramp 2.2          ', cfg: cfg(2.2, 5.5, 'end') },
  { family: '2 ramp  ', name: 'ramp 1.7          ', cfg: cfg(1.7, 5.5, 'end') },

  // 3. Publish the time-weighted mean lock over the frame.
  { family: '3 mean  ', name: 'mean lock         ', cfg: cfg(3.4, 5.5, 'mean') },

  // Combinations — the brief asks whether one is enough, and the only way to
  // answer is to measure the pairs.
  { family: '1+3     ', name: 'ret 4.5 + mean    ', cfg: cfg(3.4, 4.5, 'mean') },
  { family: '1+3     ', name: 'ret 3.4 + mean    ', cfg: cfg(3.4, 3.4, 'mean') },
  { family: '1+3     ', name: 'ret 2.8 + mean [D]', cfg: cfg(3.4, 2.8, 'mean') },
  { family: '1+3     ', name: 'ret 2.5 + mean    ', cfg: cfg(3.4, 2.5, 'mean') },
  { family: '1+3     ', name: 'ret 2.2 + mean    ', cfg: cfg(3.4, 2.2, 'mean') },
  { family: '2+3     ', name: 'ramp 2.2 + mean   ', cfg: cfg(2.2, 5.5, 'mean') },
];

// ===========================================================================

const F = (n: number, w = 6, d = 2): string =>
  (Number.isFinite(n) ? n.toFixed(d) : '  --').padStart(w);

interface LaneOutcome {
  swing: number;
  rms: number;
  wheelSwing: number;
  ratio: number;
  departed: boolean;
}

/**
 * EVERY LANE IS FLOWN AT THREE FRAME RATES, and this is not decoration.
 *
 * The thing being measured is a LIMIT CYCLE, and a limit cycle sits on a knife
 * edge: the first draft of this sweep ran at 60fps alone and produced a
 * non-monotonic column in which a symmetric wheel was WORSE than today's
 * asymmetric one at 2.0g (9.13m against 7.67m) while a slightly slower one was
 * better by a factor of nine. Re-flown at 30 and 144fps the same three
 * configurations reorder completely. A candidate chosen off one frame rate would
 * have been chosen off noise.
 *
 * There is also a mechanism here rather than only variance. The frame's
 * zero-order hold is a low-pass filter on the sawtooth whose corner frequency IS
 * the frame rate, so a fast machine delivers MORE of the sawtooth to the tyres
 * than a slow one — which is why 144fps is the worst column for almost every
 * row, and why the mean-lock candidate (an exact anti-alias of the same signal)
 * does most of its work at low frame rates and little at 144.
 */
const FRAME_RATES = [30, 60, 144];

/**
 * The analogue arm, run ONCE per lane per frame rate.
 *
 * It writes `controls.steer` directly and has no ramp for a candidate to
 * change, so it is the same run for every row. Running it per candidate would
 * cost fourteen times the time and produce fourteen identical columns.
 */
const wheelArm = new Map<string, { swing: number; departed: boolean }>();

function laneKey(c: LaneCase, fps = 60): string { return `${c.label}@${c.kph}@${fps}`; }

function common(c: LaneCase, fps = 60) {
  return {
    lane: c.lane, speedKph: c.kph, durationS: DURATION_S, framePeriodMs: 1000 / fps,
    startOffsetM: c.startOffsetM, captureS: SETTLE_S, departM: DEPART_BAR_M,
  };
}

console.log('\nSTEERING FEEL — candidate sweep (issue #46)');
console.log('The car is unchanged in every row. Only the keyboard is swept.\n');

for (const c of LANE_CASES) {
  for (const fps of FRAME_RATES) {
    const w = driveLane({ ...common(c, fps), keyboard: false });
    wheelArm.set(laneKey(c, fps), { swing: w.swingM, departed: w.departed });
  }
}

console.log('  analogue-wheel control arm (identical for every candidate)');
console.log('  lane            kph' + FRAME_RATES.map((f) => `${f}fps`.padStart(10)).join(''));
console.log('  ' + '-'.repeat(18 + 10 * FRAME_RATES.length));
for (const c of LANE_CASES) {
  console.log('  ' + c.label.padEnd(14) + String(c.kph).padStart(4)
    + FRAME_RATES.map((f) => {
      const w = wheelArm.get(laneKey(c, f))!;
      return (w.departed ? 'LEFT' : w.swing.toFixed(2)).padStart(10);
    }).join(''));
}

// ===========================================================================

interface Row {
  cand: Candidate;
  lanes: Map<string, LaneOutcome>;
  /**
   * Worst settled wander over the six `probe:handling` §5 lanes, with a
   * DEPARTURE counted as infinite rather than dropped.
   *
   * Dropping it was the first draft and it was backwards: a candidate whose
   * worst lane left the road scored better than one whose worst lane merely
   * wandered, because leaving the road removed the row from the maximum. A
   * departure is the worse outcome and has to sort as the worse outcome.
   */
  worstSwing: number;
  worstSwingAt: string;
  /**
   * The corners and the straights, separately.
   *
   * They turn out to be two different floors and merging them hides the whole
   * comparison. Every one of the fourteen configurations wanders 2.6-3.3m on the
   * 280 km/h STRAIGHT and no candidate moves it, while the corner column moves
   * by a factor of sixty between the best and the worst. A single "worst lane"
   * number is therefore the straight in every row and says nothing.
   */
  worstCorner: number;
  worstStraight: number;
  /** Worst kb/wheel swing ratio over the CORNER lanes that held. */
  worstRatio: number;
  /** How many of the six §5 lanes left the road. */
  departures: number;
  held26: boolean;
  chicaneRms: number;
  chicaneSwing: number;
  chicaneRatio: number;
  chicaneDeparted: boolean;
  step: ReturnType<typeof steerStepResponse>;
  /** Step response at 30 and 144fps, to show how much of the cost is the frame. */
  step30: ReturnType<typeof steerStepResponse>;
  step144: ReturnType<typeof steerStepResponse>;
  /** The 30ms press, in metres, at 15fps and its 15..144fps spread. */
  tap30At15M: number;
  tapWorstSpreadPct: number;
  tapAnyDead: boolean;
}

const rows: Row[] = [];

for (const cand of CANDIDATES) {
  const lanes = new Map<string, LaneOutcome>();
  let worstSwing = 0;
  let worstSwingAt = '';
  let worstCorner = 0;
  let worstStraight = 0;
  let worstRatio = 0;
  let departures = 0;
  let held26 = true;

  for (const c of LANE_CASES) {
    for (const fps of FRAME_RATES) {
      const kb = driveLane({ ...common(c, fps), inputConfig: cand.cfg });
      const w = wheelArm.get(laneKey(c, fps))!;
      const ratio = w.swing > 1e-3 ? kb.swingM / w.swing : Infinity;
      lanes.set(laneKey(c, fps), {
        swing: kb.swingM, rms: kb.rmsErrM, wheelSwing: w.swing, ratio, departed: kb.departed,
      });
      if (c.label === 'corner 2.6g' && kb.departed) held26 = false;
      if (!c.flick) {
        const straight = c.label === 'straight';
        if (kb.departed) {
          departures++;
          worstSwing = Infinity;
          if (straight) worstStraight = Infinity; else worstCorner = Infinity;
          if (worstSwingAt === '') worstSwingAt = `${c.label} ${c.kph} @${fps}fps (left)`;
        } else {
          if (kb.swingM > worstSwing) {
            worstSwing = kb.swingM; worstSwingAt = `${c.label} ${c.kph} @${fps}fps`;
          }
          if (straight) worstStraight = Math.max(worstStraight, kb.swingM);
          else {
            worstCorner = Math.max(worstCorner, kb.swingM);
            if (Number.isFinite(ratio) && ratio > worstRatio) worstRatio = ratio;
          }
        }
      }
    }
  }

  /** Worst chicane outcome across the three frame rates. */
  const chicRuns = FRAME_RATES.map((f) => lanes.get(laneKey(LANE_CASES[6], f))!);
  const chic: LaneOutcome = chicRuns.reduce((a, b) =>
    (b.departed || (!a.departed && b.swing > a.swing)) ? b : a);

  // The cost, at the speed the 2.0g corner is measured at. Three frame rates,
  // because half of the mean-lock candidate's cost IS half a frame and quoting
  // it at 60fps alone would hide how it moves.
  const step = steerStepResponse({
    speedKph: 200, targetLock: CORNER_LOCK, inputConfig: cand.cfg,
  });
  const step30 = steerStepResponse({
    speedKph: 200, targetLock: CORNER_LOCK, framePeriodMs: 1000 / 30, inputConfig: cand.cfg,
  });
  const step144 = steerStepResponse({
    speedKph: 200, targetLock: CORNER_LOCK, framePeriodMs: 1000 / 144, inputConfig: cand.cfg,
  });

  // The frame-rate half: a 30ms press, in metres, at four frame rates.
  let tapAnyDead = false;
  let tapWorstSpreadPct = 0;
  let tap30At15M = 0;
  for (const kph of [100, 200, 300]) {
    for (const ms of [30, 80, 160]) {
      const vals = [15, 30, 60, 144].map((fps) => tapOnce({
        speedKph: kph, tapMs: ms, framePeriodMs: 1000 / fps, inputConfig: cand.cfg,
      }).lateral1sM);
      if (kph === 200 && ms === 30) tap30At15M = vals[0];
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      if (lo < 1e-3) tapAnyDead = true;
      else tapWorstSpreadPct = Math.max(tapWorstSpreadPct, ((hi - lo) / lo) * 100);
    }
  }

  rows.push({
    cand, lanes, worstSwing, worstSwingAt, worstCorner, worstStraight,
    worstRatio, departures, held26,
    chicaneRms: chic.rms, chicaneSwing: chic.swing,
    chicaneRatio: chic.ratio, chicaneDeparted: chic.departed,
    step, step30, step144, tap30At15M, tapWorstSpreadPct, tapAnyDead,
  });
  process.stdout.write(`  measured ${cand.name.trim()}\n`);
}

// ===========================================================================
// Per-lane detail
// ===========================================================================

const header = '  candidate             ' + LANE_CASES.map((c) =>
  (c.label.split(' ')[0].slice(0, 4) + ' ' + c.kph).padStart(9)).join('');

for (const fps of FRAME_RATES) {
  console.log(`\n\nPER-LANE KEYBOARD SWING AT ${fps}fps, metres peak-to-peak after `
    + SETTLE_S + 's of settling');
  console.log('  "dep" = left the lane by more than ' + DEPART_BAR_M + 'm. Bar is '
    + SWING_BAR_M.toFixed(1) + 'm (probe:handling §5, unchanged).');
  console.log('');
  console.log(header);
  console.log('  ' + '-'.repeat(22 + 9 * LANE_CASES.length));
  for (const r of rows) {
    const cells = LANE_CASES.map((c) => {
      const o = r.lanes.get(laneKey(c, fps))!;
      return (o.departed ? 'dep' : o.swing.toFixed(2)).padStart(9);
    }).join('');
    console.log('  ' + r.cand.name.padEnd(22) + cells);
  }
}

console.log('\n\nWORST OVER THE THREE FRAME RATES (kb swing / wheel swing at the same rate)');
console.log('  The ratio is the price of the digital input path on that lane.');
console.log(header);
console.log('  ' + '-'.repeat(22 + 9 * LANE_CASES.length));
for (const r of rows) {
  const cells = LANE_CASES.map((c) => {
    const runs = FRAME_RATES.map((f) => r.lanes.get(laneKey(c, f))!);
    if (runs.some((o) => o.departed)) return 'dep'.padStart(9);
    const worst = runs.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    return (Number.isFinite(worst.ratio) ? worst.ratio.toFixed(1) : '--').padStart(9);
  }).join('');
  console.log('  ' + r.cand.name.padEnd(22) + cells);
}

// ===========================================================================
// The comparison table
// ===========================================================================

console.log('\n\nTHE COMPARISON — one row per candidate');
console.log('  Every lane number is the WORST over 30, 60 and 144fps.');
console.log('  corner : worst settled peak-to-peak over the three CORNER lanes, metres (bar '
  + SWING_BAR_M.toFixed(1) + ')');
console.log('  strt   : the same over the three STRAIGHTS — a floor no candidate moves');
console.log('  ratio  : worst kb/wheel swing ratio over the corner lanes');
console.log('  2.6g   : does the keyboard driver keep the 2.6g/280 km/h corner at every rate');
console.log('  lat90  : key-down to 90% of a 2.0g corner lock reaching the car, ms @60fps');
console.log('  full   : key-down to full lock, ms');
console.log('  flick  : full right lock to 90% of that lock the other way, ms');
console.log('  chic   : worst peak-to-peak through the '
  + CHICANE_G.toFixed(1) + 'g chicane, metres (wheel arm '
  + Math.max(...FRAME_RATES.map((f) => wheelArm.get(laneKey(LANE_CASES[6], f))!.swing)).toFixed(2)
  + 'm)');
console.log('  30ms   : a 30ms press at 15fps, metres at 1s (0.000 = deleted)');
console.log('');
console.log('  candidate             corner    strt    ratio   2.6g    lat90    full   flick     chic    30ms  spread');
console.log('  ' + '-'.repeat(108));
for (const r of rows) {
  console.log(
    '  ' + r.cand.name.padEnd(22)
    + (Number.isFinite(r.worstCorner) ? F(r.worstCorner, 6, 2) : '   off')
    + (Number.isFinite(r.worstStraight) ? F(r.worstStraight, 8, 2) : '     off')
    + F(r.worstRatio, 9, 1)
    + '   ' + (r.held26 ? ' held' : ' LEFT')
    + F(r.step.toTargetMs, 9, 0)
    + F(r.step.toFullMs, 8, 0)
    + F(r.step.flickMs, 8, 0)
    + (r.chicaneDeparted ? '      dep' : F(r.chicaneSwing, 9, 2))
    + F(r.tap30At15M, 8, 3)
    + (r.tapAnyDead ? '    dead' : F(r.tapWorstSpreadPct, 7, 1) + '%'),
  );
}
console.log('  "off" = at least one of the six §5 lanes left the road; the worst lane is');
console.log('  named in the column below.');
console.log('');
console.log('  candidate             departures   worst lane');
console.log('  ' + '-'.repeat(56));
for (const r of rows) {
  console.log('  ' + r.cand.name.padEnd(22) + String(r.departures).padStart(8)
    + '     ' + r.worstSwingAt);
}

console.log('\n  release: full lock back to centre, ms — the other half of the flick');
console.log('  latency at three frame rates, to separate the candidate from the frame');
console.log('  candidate             release   lat90@30  lat90@60  lat90@144  flick@30  flick@144');
console.log('  ' + '-'.repeat(88));
for (const r of rows) {
  console.log('  ' + r.cand.name.padEnd(22) + F(r.step.releaseMs, 7, 0)
    + F(r.step30.toTargetMs, 11, 0) + F(r.step.toTargetMs, 10, 0) + F(r.step144.toTargetMs, 11, 0)
    + F(r.step30.flickMs, 10, 0) + F(r.step144.flickMs, 11, 0));
}

console.log('\n  ROBUSTNESS: the 2.0g/200 km/h corner, the headline case, at each rate.');
console.log('  A limit cycle sits on a knife edge. A candidate that only wins at 60fps');
console.log('  has not won.');
console.log('  candidate           ' + FRAME_RATES.map((f) => `${f}fps`.padStart(10)).join(''));
console.log('  ' + '-'.repeat(22 + 10 * FRAME_RATES.length));
for (const r of rows) {
  console.log('  ' + r.cand.name.padEnd(22) + FRAME_RATES.map((f) => {
    const o = r.lanes.get(laneKey(LANE_CASES[4], f))!;
    return (o.departed ? 'dep' : o.swing.toFixed(2)).padStart(10);
  }).join(''));
}

// ===========================================================================
// What ships
// ===========================================================================

console.log('\n\nWHAT THE SHIPPED PRESETS ARE (src/input/SteeringFeel.ts)');
console.log('  [D] marks the default a new player gets. Every one of these is a row above.');
for (const id of STEERING_FEEL_IDS) {
  const f = STEERING_FEELS[id];
  console.log(`  ${(f.id === DEFAULT_STEERING_FEEL ? '[D] ' : '    ') + f.id.padEnd(12)} `
    + `ramp ${f.keyboardSteerRate.toFixed(1)}  return ${f.keyboardCentreRate.toFixed(1)}  `
    + `publish ${f.keyboardSteerPublish.padEnd(5)}  ${f.label}`);
}
console.log('');
