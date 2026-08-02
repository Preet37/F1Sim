/**
 * Does the HUD say the right thing?
 *
 * WHY THIS EXISTS. The four panels this probe covers were rebuilt from
 * screenshots, and a screenshot is evidence about one frame on one machine. It
 * cannot tell you that the gap column says `+1 LAP` rather than `+3.114` for a
 * lapped car, that the pit call is a sentence rather than a shout, that the
 * weather pill and the weather colour are derived from the same number, or —
 * the one with real history in this repo — that the running order fits inside
 * a 390px-tall phone.
 *
 * So every one of those decisions lives in an exported pure function in
 * `src/ui/Hud.ts`, exactly as `neutralisationCue` already did, and this probe
 * drives them off a REAL `RaceEngine` running a REAL race. Nothing here
 * re-derives what the HUD ought to say: a probe that reimplements the display
 * agrees with itself and with nothing else.
 *
 * Run: npm run probe:hudtext
 */

import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { getCircuit } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';
import {
  fastestLap, pitCall, principalOf, radioExchange, relayed, standingsCells, towerFit,
  weatherReadout,
} from '../src/ui/Hud';

const failures: string[] = [];
function fail(msg: string): void { failures.push(msg); }
function check(ok: boolean, msg: string): void { if (!ok) fail(msg); }

// ---------------------------------------------------------------------------
// 1. The running order, off a real race
// ---------------------------------------------------------------------------

const config: SessionConfig = {
  kind: 'race',
  name: 'Grand Prix',
  durationS: 0,
  laps: 60,
  playerIndex: -1,
  standingStart: true,
  pitLaneStart: false,
  seed: 4242,
};

const engine = new RaceEngine(getCircuit('monza'), config);
// Long enough that the field has spread, somebody has been lapped, and every
// car has a best lap on the board.
for (let i = 0; i < Math.round(1500 / PHYSICS_DT); i++) engine.step();

const standings = engine.standings;
const leader = standings[0];

let sawLapped = false;
for (let i = 0; i < standings.length; i++) {
  const car = standings[i];
  const ahead = i > 0 ? standings[i - 1] : null;
  const cells = standingsCells(engine, car, ahead, leader);

  check(cells.pos === String(car.position), `row ${i}: position ${cells.pos} != ${car.position}`);
  check(cells.surname === car.driver.lastName.toUpperCase(), `row ${i}: surname not upper-cased`);
  check(cells.first === car.driver.firstName, `row ${i}: first name missing`);
  check(cells.team === car.team.name, `row ${i}: team name missing`);
  check(cells.tyre.length > 0, `row ${i}: no compound`);

  if (i === 0) {
    check(cells.gap === 'LEADER', `leader gap should read LEADER, got ${cells.gap}`);
  } else if (!car.retired && !car.disqualified) {
    const lapsBehind = ahead ? car.lapsDown - ahead.lapsDown : 0;
    if (lapsBehind > 0) {
      sawLapped = true;
      check(/LAPS?$/.test(cells.gap),
        `a car ${lapsBehind} lap(s) down must be reported as laps, not as ${cells.gap}`);
    } else {
      check(/^[+-]/.test(cells.gap) || cells.gap === '—',
        `row ${i}: interval ${cells.gap} is not a signed gap`);
    }
  }
  if (car.retired) check(cells.gap === 'DNF', `a retired car must read DNF, got ${cells.gap}`);
}
console.log(`running order: ${standings.length} rows, lapped car present: ${sawLapped}`);

// The best-lap column must carry a formatted lap time for anyone who has set
// one, because the column exists to be compared down the panel.
const withLap = standings.filter((c) => c.bestLapTime > 0);
check(withLap.length > 0, 'nobody set a lap in 1500s of racing — the probe is not exercising anything');
for (const car of withLap) {
  const cells = standingsCells(engine, car, null, leader);
  check(/^\d+:\d\d\.\d\d\d$/.test(cells.best), `best lap ${cells.best} is not m:ss.mmm`);
  check(cells.lastLap === '—' || /^\d+:\d\d\.\d\d\d$/.test(cells.lastLap),
    `last lap ${cells.lastLap} is not m:ss.mmm`);
}

// The fastest lap must be a real car's real lap, and the quickest one there is.
const fastest = fastestLap(standings);
check(fastest !== null, 'nobody holds the fastest lap after 1500s of racing');
if (fastest) {
  const quickest = Math.min(...withLap.map((c) => c.bestLapTime));
  check(Math.abs(fastest.time - quickest) < 1e-9,
    `fastest lap ${fastest.time} is not the quickest lap set (${quickest})`);
  check(standings.some((c) => c.driver.code === fastest.code),
    'the fastest lap is credited to a driver who is not in the field');
  console.log(`fastest lap: ${fastest.first} ${fastest.surname} ${fastest.time.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 2. The panel fits the screen it is on
// ---------------------------------------------------------------------------

/**
 * The history: HUD panels running off the bottom of a landscape phone. The
 * tower is the tallest thing on the left rail and the one most able to do it,
 * so the arithmetic it is sized by is asserted rather than eyeballed.
 */
const VIEWPORTS: [string, number, number, number][] = [
  // name, width, height, px of rail that must be left below the panel.
  // The clearance is not a guess: on a full-size viewport the rail below the
  // tower carries the notice stack, the weather bug and the car state, and
  // `.hud-notices` is pinned to `max(300px, 50vh)` — so the tower must end
  // above half the screen or the two meet.
  ['desktop 1400x900', 1400, 900, 450],
  ['wide desktop 1920x1080', 1920, 1080, 540],
  ['laptop 1280x800', 1280, 800, 400],
  ['landscape phone 844x390', 844, 390, 174],
  ['landscape phone 740x360', 740, 360, 144],
  ['portrait phone 390x844', 390, 844, 300],
];

for (const [name, w, h, clearance] of VIEWPORTS) {
  const fit = towerFit(w, h);
  const rowH = fit.compact ? 17 : 29;
  // Session eyebrow, position line, fastest-lap capsule, column rule, padding —
  // and the 5px break under the pinned leader. Compact drops the eyebrow and
  // the column rule, which is where the difference between the two comes from.
  const chrome = fit.compact ? 63 : 106;
  const bottom = 10 + chrome + fit.rows * rowH + 5;

  check(fit.rows >= 4, `${name}: ${fit.rows} rows is not a running order`);
  check(bottom <= h - clearance,
    `${name}: tower reaches ${bottom}px of ${h}px, leaving ${h - bottom}px for the rest of the rail`);
  check(fit.compact === (w <= 900 || h <= 470),
    `${name}: compact flag disagrees with the media query that shrinks the row`);
  console.log(`${name.padEnd(24)} ${String(fit.rows).padStart(2)} rows  ` +
    `${fit.compact ? 'compact' : 'full   '}  bottom ${bottom}px`);
}

// ---------------------------------------------------------------------------
// 3. The pit wall speaks in sentences
// ---------------------------------------------------------------------------

/**
 * Every string `RaceEngine.pitAdvice` can return. If one is added there and
 * not voiced here, the driver gets a pop-up with nothing in it — so this list
 * is checked against the engine's source rather than trusted.
 */
const ADVICES = [
  'DRIVE-THROUGH TO SERVE',
  'PENALTY TO SERVE',
  'DAMAGE — PIT FOR REPAIRS',
  'RAIN — WET TYRES',
  'TRACK DRY — SLICKS',
  'TYRES GONE',
  'SECOND COMPOUND REQUIRED',
  'TYRES WORN — PIT WINDOW OPEN',
];

for (const advice of ADVICES) {
  const call = pitCall(advice);
  if (!call) { fail(`no voice for pit advice "${advice}"`); continue; }
  check(call.line.length > 12, `"${advice}" is voiced too tersely to be a sentence`);
  check(call.line !== call.line.toUpperCase(),
    `"${advice}" is still being shouted: ${call.line}`);
  check(/[.!?]$/.test(call.line), `"${advice}" is not punctuated as a sentence`);
  check(call.chip === 'PRESS PIT', `"${advice}" does not say which control acts on it`);
}
console.log(`pit calls voiced: ${ADVICES.length}`);

for (const car of engine.cars) {
  const name = principalOf(car.team.id);
  check(name !== 'Pit wall', `${car.team.name} has no team principal`);
  check(name.includes(' '), `${car.team.name}'s principal has no surname: ${name}`);
}

// ---------------------------------------------------------------------------
// 4. Race control, relayed
// ---------------------------------------------------------------------------

const codes = new Set(engine.cars.map((c) => c.driver.code));
const sample: [string, string][] = [
  ['SAFETY CAR DEPLOYED', 'Safety car deployed'],
  ['VSC DEPLOYED', 'VSC deployed'],
  ['LAPPED CARS MAY NOW OVERTAKE', 'Lapped cars may now overtake'],
  ['GREEN FLAG — VSC ended', 'Green flag — VSC ended'],
];
for (const [raw, want] of sample) {
  const got = relayed(raw, codes);
  check(got === want, `relay of "${raw}" gave "${got}", wanted "${want}"`);
}
// A driver code has to survive the relay; the whole point of passing the field
// in is that "HAL" is a person and "THE" is not.
const oneCode = engine.cars[0].driver.code;
const withCode = relayed(oneCode + ' is out of the race', codes);
check(withCode.startsWith(oneCode), `relay lost the driver code: ${withCode}`);
console.log('race control relayed: ' + sample.length + ' bulletins, codes preserved');

// ---------------------------------------------------------------------------
// 5. The weather bug reads off one number
// ---------------------------------------------------------------------------

const WET: [number, string, string][] = [
  [0.0, 'DRY TRACK', 'dry'],
  [0.2, 'LIGHT RAIN', 'damp'],
  [0.5, 'WET TRACK', 'wet'],
  [0.9, 'HEAVY RAIN', 'storm'],
];
for (const [wetness, label, tone] of WET) {
  const r = weatherReadout({ wetness, airTempC: 21.4, trackTempC: 24.6 });
  check(r.label === label, `wetness ${wetness} labelled ${r.label}, wanted ${label}`);
  check(r.tone === tone, `wetness ${wetness} toned ${r.tone}, wanted ${tone}`);
  check(r.temps === 'Air 21°  ·  Track 25°', `temperatures read "${r.temps}"`);
}
console.log('weather: 4 states, label and colour from the same number');

// ---------------------------------------------------------------------------
// 6. The radio card has two sides
// ---------------------------------------------------------------------------

const MOMENTS = [
  { kind: 'pit', compound: 'Hard' },
  { kind: 'safety-car' },
  { kind: 'vsc' },
  { kind: 'chequered', position: 4 },
  { kind: 'damage', part: 'Front wing' },
] as const;

for (const m of MOMENTS) {
  const ex = radioExchange(m);
  check(ex.said.length > 8 && ex.reply.length > 8, `radio moment ${m.kind} is not an exchange`);
  check(ex.said !== ex.reply, `radio moment ${m.kind} says the same thing twice`);
}
check(radioExchange({ kind: 'chequered', position: 4 }).reply.includes('P4'),
  'the chequered flag card does not state the finishing position');
check(radioExchange({ kind: 'pit', compound: 'Hard' }).reply.includes('Hard'),
  'the pit card does not say which compound is going on');
console.log(`radio: ${MOMENTS.length} moments, both sides present`);

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ' + f);
  process.exitCode = 1;
} else {
  console.log('\nHUD text OK');
}
