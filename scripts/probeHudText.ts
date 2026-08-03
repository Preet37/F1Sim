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
  fastestLap, lapClock, messageRoute, pitCall, pitReason, principalOf, raceControlCard,
  pitCueText, radioExchange, relayed, repairableInBox, replyExchange, standingsCells,
  teamLine, towerFit, towerWindow, weatherReadout,
} from '../src/ui/Hud';
import { COMPONENT_IDS } from '../src/race/DamageModel';
import { AIVehicleController, type AIPerception } from '../src/ai/AIVehicleController';
import type { RaceControlMessage, TeamNote } from '../src/race/RaceControlManager';

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
  check(cells.code === car.driver.code.toUpperCase(), `row ${i}: code not upper-cased`);
  check(cells.surname === car.driver.lastName.toUpperCase(), `row ${i}: surname not upper-cased`);
  check(cells.first === car.driver.firstName, `row ${i}: first name missing`);
  check(cells.team === car.team.name, `row ${i}: team name missing`);
  check(cells.tyre.length > 0, `row ${i}: no compound`);

  if (i === 0) {
    // The leader's cell names the COLUMN. Every other row in it is a figure,
    // so a word there reads as the heading it is — and restating "leader" beside
    // a position that already says 1 is the panel saying it twice.
    check(cells.gap === 'Interval', `leader gap should read Interval, got ${cells.gap}`);
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
  // `Out`, not `DNF`. The row is already dimmed and already at the foot of the
  // order; three capitals of jargon on top of that is the third statement of the
  // same fact.
  if (car.retired) check(cells.gap === 'Out', `a retired car must read Out, got ${cells.gap}`);
}
console.log(`running order: ${standings.length} rows, lapped car present: ${sawLapped}`);

// ---------------------------------------------------------------------------
// 1b. Other cars' times do not wait for the player's
// ---------------------------------------------------------------------------
//
// "if other cars have completed their lap and I haven't, you should still be
//  showing their times?? why are you waiting on me to display their times that
//  they did at other laps?"
//
// A lap time belongs to the car that set it. The tower's whole job is to show
// what everybody else is doing WHILE you are still out there, so a player who
// has not completed a lap — the first lap of any race, and the whole of a
// session they crashed out of early — must still see the times of cars that
// have. This drives a qualifying session in which the player never moves and
// asserts the panel about the nineteen cars that did.
{
  const idleConfig: SessionConfig = {
    kind: 'qualifying', name: 'Q1', durationS: 900, laps: 0,
    // ON THE CIRCUIT RATHER THAN IN THE GARAGE, and the reason is a bug rather
    // than a preference: with `pitLaneStart: true` and no control input, all
    // twenty cars are still in the pit lane after ten minutes. The idle player
    // blocks the lane and nothing gets out — the same "the AI will not pass a
    // stationary car" fault that froze the routing race above, in its second
    // location. Reported; not fixed here, because it belongs to the AI.
    playerIndex: 0, standingStart: false, pitLaneStart: false,
    seed: 77, qualifyingPhase: 1, advancing: 15,
  };
  const idle = new RaceEngine(getCircuit('monza'), idleConfig);
  // Not a single control input: the player never moves off their slot while the
  // other nineteen run the session.
  for (let i = 0; i < Math.round(600 / PHYSICS_DT) && !idle.over; i++) idle.step();

  const me = idle.cars[0];
  check(!(me.bestLapTime > 0), 'the idle player set a lap — the probe is not testing anything');
  const others = idle.standings.filter((c) => c !== me && c.bestLapTime > 0);
  check(others.length > 0,
    'no other car set a lap in ten minutes — the probe is not testing anything');

  const quickest = idle.standings.find((c) => c.bestLapTime > 0)!;
  let shown = 0;
  for (const car of others) {
    const cells = standingsCells(idle, car, null, quickest);
    check(/^\d+:\d\d\.\d\d\d$/.test(cells.best),
      `${car.driver.code} set ${car.bestLapTime.toFixed(3)} and the tower shows "${cells.best}"`);
    // And the gap column, which is what the tower actually draws: a deficit to
    // the quickest lap of the session, computed between two OTHER cars and
    // owing nothing to the player.
    check(cells.gap !== '—' && cells.gap !== 'Out',
      `${car.driver.code} has a lap and the tower's gap column reads "${cells.gap}"`);
    shown++;
  }
  // The player's own row is the honest exception: they have no time, so they
  // have no gap. That must not be contagious.
  const mine = standingsCells(idle, me, null, quickest);
  check(mine.best === '—', `a driver with no lap shows a best of "${mine.best}"`);
  console.log(`idle player: ${shown} of ${idle.cars.length - 1} rivals' times shown ` +
    'while the player has none');

  // The fastest-lap strip is the same question asked about one car, and it is
  // the one the player is most likely to notice missing.
  const fast = fastestLap(idle.standings);
  check(fast !== null && fast.time > 0,
    'no fastest lap is credited while the player has not set one');
}

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
  //
  // The clearance is not a guess. It is what the rail beneath the tower has to
  // carry, and it came DOWN in the pass that moved the tyre, fuel and weather
  // panels into the right-hand car column: what is left below the running
  // order is the radio card (198px), the two live cues (30 each), the gaps
  // between them, and the rail's own bottom offset clear of the mirror band.
  ['desktop 1400x900', 1400, 900, 366],
  ['wide desktop 1920x1080', 1920, 1080, 366],
  ['laptop 1280x800', 1280, 800, 366],
  ['landscape phone 844x390', 844, 390, 174],
  ['landscape phone 740x360', 740, 360, 144],
  ['portrait phone 390x844', 390, 844, 300],
];

for (const [name, w, h, clearance] of VIEWPORTS) {
  const fit = towerFit(w, h);
  const rowH = fit.compact ? 17 : 20;
  // Header, flag band, column rule, the fastest-lap strip along the foot, the
  // panel's padding, and the 5px break under the pinned leader. Compact drops
  // the circuit name and the column rule, which is where the difference between
  // the two comes from.
  //
  // MEASURED WITH THE FLAG BAND OUT, which is the tallest the panel ever is.
  // A budget written for the quiet frame is a budget that overflows on the one
  // frame the driver most needs the panel to be readable.
  const chrome = fit.compact ? 76 : 118;
  const bottom = 10 + chrome + fit.rows * rowH + 5;

  check(fit.rows >= 4, `${name}: ${fit.rows} rows is not a running order`);
  check(bottom <= h - clearance,
    `${name}: tower reaches ${bottom}px of ${h}px, leaving ${h - bottom}px for the rest of the rail`);
  check(fit.compact === (w <= 900 || h <= 470),
    `${name}: compact flag disagrees with the media query that shrinks the row`);
  console.log(`${name.padEnd(24)} ${String(fit.rows).padStart(2)} rows  ` +
    `${fit.compact ? 'compact' : 'full   '}  bottom ${bottom}px`);
}
// A DESKTOP SHOWS THE WHOLE FIELD. Once it does, there is no window at all and
// there is nothing left for a window to hide.
check(towerFit(1400, 900).rows >= 20,
  `a 1400x900 desktop shows ${towerFit(1400, 900).rows} of 20 cars`);

// ---------------------------------------------------------------------------
// 2b. The window, with the player at the back of a field of wrecks
// ---------------------------------------------------------------------------
//
// "why can I only see like 4 cars on the leaderboard, where is everyone and all
//  the cars?" — reported from a screenshot showing P1, a break, and P14 to P20,
// of which six were marked `Out`. The player was eighteenth. This is that exact
// situation: twenty cars, the six behind the player retired, eight rows.

{
  const field = Array.from({ length: 20 }, (_, i) => ({ retired: i >= 14 }));
  const me = 17;
  const win = towerWindow(field, 8, me);
  check(win.rows.length === 8, `the window drew ${win.rows.length} of 8 rows`);
  check(win.rows.includes(me), 'the window does not contain the player');
  check(win.pinLeader && win.rows[0] === 0, 'the leader is not pinned above the window');
  // The whole point: a scarce row does not go to a car that cannot be raced.
  const wrecks = win.rows.filter((i) => field[i].retired && i !== me).length;
  check(wrecks === 0,
    `${wrecks} of 8 rows went to retired cars while the player was racing`);
  // And most of what is shown is the road ahead rather than the road behind.
  const ahead = win.rows.filter((i) => i < me).length;
  check(ahead >= 5, `only ${ahead} of the 8 rows are cars the player can catch`);
  console.log(`tower window: P18 of 20 with 6 wrecks behind → rows ` +
    win.rows.map((i) => i + 1).join(', '));
}
// A field that fits is drawn whole, in order, with nothing pinned.
{
  const field = Array.from({ length: 20 }, () => ({ retired: false }));
  const win = towerWindow(field, 20, 17);
  check(!win.pinLeader && win.rows.length === 20 && win.rows[0] === 0 && win.rows[19] === 19,
    'a tower with room for the whole field still windows it');
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

  // The live cue beside it is an instrument rather than a person, so capitals
  // are right — but it may not say the same word three times, which is what
  // `DAMAGE — PIT FOR REPAIRS — PRESS PIT` did.
  const cue = pitCueText(advice);
  check(cue.endsWith('· PRESS PIT'), `the cue for "${advice}" does not name the control`);
  check(cue.split(/\s+/).length <= 7, `the cue "${cue}" is too long to read at speed`);
  const pits = cue.toLowerCase().match(/\bpit\b/g) ?? [];
  check(pits.length <= 1, `the cue "${cue}" says "pit" ${pits.length} times`);
  check(!cue.includes(' — '), `the cue "${cue}" still carries the log's dash`);
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
// 6. The radio card is an argument, not a notification
// ---------------------------------------------------------------------------
//
// A radio clip is worth broadcasting because somebody is being overruled on it:
// the driver pushes back, the wall insists. So each moment has to be a real
// back-and-forth — both voices, alternating, more than once — and not a
// question with an answer stapled to it.

const MOMENTS = [
  { kind: 'pit', compound: 'Hard', lapsLeft: 20, reason: 'strategy' },
  { kind: 'safety-car', position: 5, lostS: 3.2 },
  { kind: 'vsc', position: 5, where: 'turn 4' },
  { kind: 'delta', marginS: 1.2, breaches: 0 },
  { kind: 'delta', marginS: -0.4, breaches: 1 },
  { kind: 'neutral-ending', phase: 'vsc-ending', mustUnlap: false },
  { kind: 'neutral-ending', phase: 'unlapping', mustUnlap: true },
  { kind: 'neutral-ending', phase: 'unlapping', mustUnlap: false },
  { kind: 'neutral-ending', phase: 'sc-in', mustUnlap: false },
  { kind: 'neutral-ending', phase: 'hold-line', mustUnlap: false },
  { kind: 'chequered', position: 4 },
  { kind: 'damage', part: 'Front wing' },
] as const;

for (const m of MOMENTS) {
  const turns = radioExchange(m);
  const label = m.kind === 'neutral-ending' ? m.kind + '/' + m.phase : m.kind;
  check(turns.length >= 2, `radio moment ${label} has ${turns.length} turn(s), not an exchange`);
  check(turns.some((t) => t.who === 'driver') && turns.some((t) => t.who === 'wall'),
    `radio moment ${label} is only one voice`);
  // Alternating: the card draws the driver on one side and the wall on the
  // other, so two turns from the same speaker in a row would read as one line
  // that wrapped rather than as two people.
  for (let i = 1; i < turns.length; i++) {
    check(turns[i].who !== turns[i - 1].who,
      `radio moment ${label}: turns ${i - 1} and ${i} are both the ${turns[i].who}`);
  }
  for (const t of turns) {
    check(t.line.length > 6, `radio moment ${label}: "${t.line}" is not a line of speech`);
    // Signage, not speech. `OFF TRACK — YELLOW FLAG` is what this card used to
    // print; a capitalised token with a dash after it is the shape of a status
    // string and never the shape of something a person said.
    check(!/^[A-Z0-9 ]{3,} — /.test(t.line),
      `radio moment ${label}: "${t.line}" reads as a status string`);
    // Written for the EAR now as well as the eye — `Hud` speaks these aloud —
    // so nothing may be longer than somebody says in one breath.
    check(t.line.length < 110, `radio moment ${label}: "${t.line}" is too long to be said`);
  }
  check(new Set(turns.map((t) => t.line)).size === turns.length,
    `radio moment ${label} repeats itself`);
}
const chequered = radioExchange({ kind: 'chequered', position: 4 });
check(chequered.some((t) => t.line.includes('P4')),
  'the chequered flag card does not state the finishing position');
const boxCall = radioExchange({
  kind: 'pit', compound: 'Hard', lapsLeft: 20, reason: 'strategy',
});
check(boxCall.some((t) => t.line.includes('Hard')),
  'the pit card does not say which compound is going on');
check(boxCall.some((t) => t.line.includes('20')),
  'the pit card knows how many laps are left and does not say so');

// THE LINE THIS WAS ALL REPORTED OVER. The virtual safety car exchange used to
// read `"VSC? GIVE ME THE DELTA." / "HOLD THE MINIMUM IN EVERY SECTOR."` —
// correct information formatted as a restatement of Art. 56.5 to a driver who
// is at that moment obeying Art. 56.5.
//
//   "whats this bullshit of holding the minimum every sector."
//
// Asserted as a shape rather than as a blocklist of that one sentence, because
// the failure is a category: a radio line whose content is the rule is a radio
// line with nothing in it. Anything a driver could have recited from the
// regulations before the transmission started is the same fault wearing
// different words.
for (const m of MOMENTS) {
  for (const t of radioExchange(m)) {
    check(!/\b(minimum|delta) in (every|each) sector\b/i.test(t.line),
      `${m.kind} restates the regulation instead of giving a number: "${t.line}"`);
    check(!/\byou must\b|\bdrivers must\b|\bis required to\b/i.test(t.line),
      `${m.kind} reads as a rulebook: "${t.line}"`);
  }
}
// And the positive form: a neutralisation exchange has to carry a FIGURE, which
// is the half of the subject the driver does not have.
for (const m of MOMENTS) {
  if (m.kind !== 'vsc' && m.kind !== 'safety-car' && m.kind !== 'delta') continue;
  const said = radioExchange(m).map((t) => t.line).join(' ');
  check(/\d/.test(said),
    `the ${m.kind} exchange names no number: "${said}"`);
}
// The delta card says which way round it is, in the driver's own terms.
check(radioExchange({ kind: 'delta', marginS: 1.2, breaches: 0 })
  .some((t) => /positive/i.test(t.line) && t.line.includes('1.2')),
  'a healthy delta is not reported as a positive margin');
check(radioExchange({ kind: 'delta', marginS: -0.4, breaches: 1 })
  .some((t) => /negative/i.test(t.line) && /lift/i.test(t.line)),
  'a delta breach does not tell the driver to lift');

// THE TWO-WAY HALF. A declined instruction has to produce a reply, and the
// reply the user asked for by name: "the driver could be like 'no stay out' and
// they be like 'copy, box next lap'".
for (const outcome of ['yes', 'no', 'lapsed'] as const) {
  const turns = replyExchange(outcome, 'Hard');
  check(turns.length >= 2, `the wall's reply to "${outcome}" is not an exchange`);
  for (const t of turns) {
    check(t.line.length > 6, `reply/${outcome}: "${t.line}" is not a line of speech`);
  }
}
check(replyExchange('no', 'Hard').some((t) => /box next lap/i.test(t.line)),
  'declining the stop does not bring the wall back with a next-lap call');
check(replyExchange('lapsed', 'Hard').some((t) => t.who === 'wall'),
  'an offer that lapsed under the driver leaves the wall silent');
check(new Set([
  ...replyExchange('yes', 'Hard').map((t) => t.line),
  ...replyExchange('no', 'Hard').map((t) => t.line),
  ...replyExchange('lapsed', 'Hard').map((t) => t.line),
]).size === 6, 'the three answers do not produce three distinct replies');

console.log(`radio: ${MOMENTS.length} exchanges, both voices alternating, ` +
  '3 answered outcomes');

// ---------------------------------------------------------------------------
// 7. Two channels, and the filter is ownership
// ---------------------------------------------------------------------------
//
// "the team principal should only be talking about the team related stuff ...
//  nobody will ever say this person's suspension broke or this broke, that is a
//  team only conversation so if they are not part of the users team then they
//  shouldn't be getting those notifs."
//
// The whole log used to be read out by the player's own principal, so a
// stranger's excursion arrived as `MARCO VIDAL · TEAM PRINCIPAL — "Yellow flag
// — HAL off at sector 2"`. This asserts the routing on a REAL race's messages:
// every bulletin the engine files, classified by which car it names.

const ROUTE_CONFIG: SessionConfig = {
  kind: 'race', name: 'Grand Prix', durationS: 0, laps: 40,
  playerIndex: 0, standingStart: true, pitLaneStart: false, seed: 1337,
};
const routeEngine = new RaceEngine(getCircuit('spa'), ROUTE_CONFIG);
const routeTrack = routeEngine.track;
const me = routeEngine.cars[0];

/**
 * THE PLAYER'S CAR HAS TO BE DRIVEN, and for twenty months it was not.
 *
 * This is why `no team-owned bulletin was filed in a 20-minute race` failed, and
 * the failure was real in a way nobody had got to the bottom of. The probe set
 * `playerIndex: 0` and then never supplied a control input, so car zero sat on
 * its grid slot — twelve metres short of the Line — for the whole twenty
 * minutes. The AI behind it will not pass a stationary car on the racing line,
 * so the entire field queued up behind it and stopped: measured, twenty cars at
 * 0.0 m/s from t≈235s to the end, leader on lap 1, zero pit stops, zero contact,
 * zero damage. Every `feed: 'team'` bulletin in the engine hangs off a stop or a
 * component breaking, and neither can happen in a race where nothing moves.
 *
 * So the assertion was correct, the engine was innocent, and the race was not a
 * race. It is one now: the game's own AI drives the player's car, exactly as
 * `probePitStop` and `probePitLimiter` already do, and for the same reason —
 * anything that cannot get round the circuit fails for reasons that have
 * nothing to do with what is being measured.
 *
 * THE DEADLOCK ITSELF IS A SEPARATE, REAL BUG and it is not fixed here, because
 * it belongs to the AI rather than to the HUD. A human who spins on the pit
 * straight and stops will freeze the whole race, and once a safety car period
 * has ended it is unrecoverable: `holdUntilLine` (Art. 55.8) is cleared only by
 * crossing the Line, and nobody can cross a Line that a parked car is sitting
 * on. Reported rather than patched.
 */
const routeDriver = new AIVehicleController(me.driver, routeTrack, 991, 'hard');
const routeView: AIPerception = { ...me.perception };
for (let i = 0; i < Math.round(1200 / PHYSICS_DT); i++) {
  Object.assign(routeView, me.perception);
  const c = routeDriver.update(PHYSICS_DT, me.physics, me.s, me.lateral, routeView);
  const out = routeEngine.playerControls;
  out.throttle = c.throttle;
  out.brake = c.brake;
  out.steer = c.steer;
  out.reverse = c.reverse;
  out.gearRequest = c.gearRequest;
  out.ersMode = c.ersMode;
  out.drsRequested = c.drsRequested;
  routeEngine.step();
}
// The premise of everything below: this has to have been a race. A silent team
// channel in a field that never moved says nothing about the team channel.
check(routeEngine.standings[0].lap >= 4,
  `the routing race never ran — leader reached lap ${routeEngine.standings[0].lap}`);
check(me.lap >= 3, `the player's car never ran — ${me.lap} laps in twenty minutes`);

let toControl = 0;
let toTeam = 0;
let dropped = 0;
let sawForeignTeamNote = false;
for (const m of routeEngine.raceControl.messages) {
  const about = m.carIndex >= 0 ? routeEngine.cars[m.carIndex] : undefined;
  const ours = about !== undefined && about.team.id === me.team.id;
  const route = messageRoute(m, ours);

  if (route === 'team') {
    toTeam++;
    // THE assertion. Nothing on the team channel may be about a car that is
    // not one of the team's two.
    if (!ours) sawForeignTeamNote = true;
    if (m.team) {
      const said = teamLine(m.team, {
        mate: about !== me, surname: about!.driver.lastName,
        firstName: me.driver.firstName,
        position: me.position, lapsLeft: 12, rival: 'KOV', rivalGapS: 1.4,
      });
      check(said.line.length > 12, `team note ${m.team.kind} is too short to be speech`);
      // A principal reacts, instructs or judges. He does not read out a status
      // string, and a dash-joined fragment is exactly what he was doing.
      check(!/^[A-Z ]+ — /.test(said.line),
        `team note ${m.team.kind} reads as signage: "${said.line}"`);
      check(/[.?!]$/.test(said.line),
        `team note ${m.team.kind} is not a sentence: "${said.line}"`);
    }
  } else if (route === 'race-control') {
    toControl++;
    const card = raceControlCard(m);
    check(card.headline.length > 0, `a race-control bulletin has no headline: "${m.text}"`);
    check(card.headline === card.headline.toUpperCase(),
      `race control is not speaking officially: "${card.headline}"`);
    if (m.notice && m.notice.parties.length > 0) {
      // The reference banner's second line: where, what, and what is being
      // done about it. A notice with parties and no detail is half a bulletin.
      check(card.detail.length > 0,
        `an incident naming ${m.notice.parties.join(', ')} carries no detail line`);
      check(card.detail.includes(m.notice.status),
        `the bulletin does not state its status "${m.notice.status}"`);
      check(card.headline.includes(m.notice.parties[0]),
        `the bulletin does not name ${m.notice.parties[0]}`);
    }
  } else {
    dropped++;
    check(m.feed === 'team' && !ours,
      `a bulletin was dropped that was not a foreign team matter: "${m.text}"`);
  }
}
check(!sawForeignTeamNote,
  "a car outside the player's team reached the team channel");

// Every team note, said about the player and about their team-mate. Driven off
// the union rather than off whatever this seed happened to produce, so a note
// that is never raised in a clean race still has to be a sentence.
/**
 * Notes about a CAR, which happen to the player and to their team-mate alike.
 * Both variants exist and both have to be a sentence.
 */
const SHARED_NOTES: TeamNote[] = [
  { kind: 'off', corner: 'Eau Rouge', hit: 'the barrier', heavy: true },
  { kind: 'off', corner: 'Les Combes', hit: '', heavy: false },
  { kind: 'damage', part: 'Rear suspension (R)', health: 0.35 },
  { kind: 'damage', part: 'Floor', health: 0.8 },
  { kind: 'retired', reason: 'terminal damage' },
  { kind: 'failure', cause: 'Power unit failure' },
  { kind: 'stranded' },
  { kind: 'recovered' },
  { kind: 'stop', compound: 'Hard' },
  { kind: 'pit-closed' },
  { kind: 'pit-missed' },
  { kind: 'pit-fast' },
  { kind: 'penalty-served' },
];

/**
 * The pit wall's own traffic, which is only ever about the player's own race.
 *
 * SPLIT OUT FROM THE ABOVE ON PURPOSE. These are filed against the player's car
 * by `RaceEngineer` and no other, so a team-mate variant of "you are two laps
 * short on fuel" is not a line that was never written — it is a line that would
 * be a lie. Forcing a surname into one to satisfy a loop is how a test starts
 * shaping the product badly.
 */
const OWN_NOTES: TeamNote[] = [
  { kind: 'gap', who: 'Halvorsen', gapS: 1.8, perLapS: -0.24, behind: true },
  { kind: 'gap', who: 'Halvorsen', gapS: 2.4, perLapS: -0.31, behind: false },
  { kind: 'penalty', seconds: 5, offence: 'Track limits at Turn 9', whenServed: 'at the stop' },
  { kind: 'penalty', seconds: 0, offence: 'Pit lane speeding', whenServed: 'now' },
  { kind: 'cede', who: 'Halvorsen', withinS: 22 },
  {
    kind: 'weather', wet: true, minutes: 4, fromLap: 12, toLap: 16,
    confidence: 0.82, plan: 'inters',
  },
  {
    kind: 'weather', wet: false, minutes: 6, fromLap: 30, toLap: 35,
    confidence: 0.6, plan: 'slicks',
  },
  {
    kind: 'call', message: 'We think Hard is the tyre for the next 18 laps.',
    reason: '0.4s a lap on this tyre, 21.0s for the stop.',
    compound: 'Hard', question: 'Box this lap?', callId: 3, urgent: false,
  },
  { kind: 'reply', outcome: 'yes', compound: 'Hard' },
  { kind: 'reply', outcome: 'no', compound: 'Hard' },
  { kind: 'reply', outcome: 'lapsed', compound: 'Hard' },
  { kind: 'tyres', lapsLeft: 6, dropOffS: 0.8, axle: 'rear' },
  { kind: 'tyres', lapsLeft: 1, dropOffS: 1.6, axle: 'front' },
  { kind: 'position', gained: false, position: 7, who: 'Halvorsen', teammate: true },
  { kind: 'position', gained: true, position: 6, who: 'Halvorsen', teammate: true },
  { kind: 'position', gained: false, position: 7, who: 'Kovacs', teammate: false },
  { kind: 'position', gained: true, position: 6, who: 'Kovacs', teammate: false },
  { kind: 'fuel', marginLaps: -1.4 },
];

const CTX = {
  surname: 'Halvorsen', firstName: 'Marcus',
  position: 6, lapsLeft: 14, rival: 'KOV', rivalGapS: 2.3,
};

const spoken = new Set<string>();
function assertSpeech(note: TeamNote, mate: boolean): void {
  const said = teamLine(note, { ...CTX, mate });
  const tag = `${note.kind}/${mate ? 'mate' : 'self'}`;
  check(said.line.length > 12, `${tag}: too short to be speech`);
  check(/[.?!]$/.test(said.line), `${tag}: not a sentence — "${said.line}"`);
  check(!/^[A-Z0-9 ]{3,} — /.test(said.line), `${tag}: reads as signage — "${said.line}"`);
  check(!/\([LR]\)/i.test(said.line),
    `${tag}: says a side marker out loud — "${said.line}"`);
  // Written for the ear as well as the eye. `Hud` speaks these aloud.
  check(said.line.length < 165, `${tag}: too long to be said in one breath — "${said.line}"`);
  spoken.add(said.line);
}

for (const note of SHARED_NOTES) {
  for (const mate of [false, true]) {
    assertSpeech(note, mate);
    // A line about the team-mate has to name them, or the player cannot tell
    // which of the two cars it is about.
    if (mate) {
      const said = teamLine(note, { ...CTX, mate: true });
      check(said.line.includes('Halvorsen'),
        `${note.kind}: a line about the team-mate does not name them — "${said.line}"`);
    }
  }
}
for (const note of OWN_NOTES) assertSpeech(note, false);

check(spoken.size === SHARED_NOTES.length * 2 + OWN_NOTES.length,
  `${SHARED_NOTES.length * 2 + OWN_NOTES.length} team lines produced ` +
  `${spoken.size} distinct sentences`);

// THE RULE THE WHOLE VOICE IS WRITTEN AGAINST: say the thing the driver does
// not already know. Enforced as "the pit wall's own traffic names a figure",
// because the failure mode is a line that states a CATEGORY — "significant
// wear", "a penalty has been applied", "rain is expected" — and every one of
// those is something the driver either already knows or cannot act on.
for (const note of OWN_NOTES) {
  if (note.kind === 'reply' || note.kind === 'call') continue;
  const said = teamLine(note, { ...CTX, mate: false });
  check(/\d/.test(said.line),
    `${note.kind} states a category instead of a number: "${said.line}"`);
}

// The three lines the game knows enough to be genuinely specific on, checked
// against the numbers they were given rather than against a shape.
const stop = teamLine({ kind: 'stop', compound: 'Hard' }, { ...CTX, mate: false });
check(stop.line.includes('P6') && stop.line.includes('KOV') && stop.line.includes('14'),
  `the stop call is not specific: "${stop.line}"`);

// The user's own example, almost verbatim: "you have received a 5 second
// penalty, Bob, for track limits — we will serve that at the next pit".
const pen = teamLine(
  { kind: 'penalty', seconds: 5, offence: 'Track limits at Turn 9', whenServed: 'at the stop' },
  { ...CTX, mate: false },
);
check(pen.line.includes('5') && pen.line.includes('Marcus')
  && /track limits/i.test(pen.line) && /at the stop/i.test(pen.line),
  `the penalty call does not name the seconds, the driver, the offence and the plan: "${pen.line}"`);

// And: "predicted to rain at lap 3-7, change of strategy, box for inters".
const wx = teamLine(
  {
    kind: 'weather', wet: true, minutes: 4, fromLap: 12, toLap: 16,
    confidence: 0.82, plan: 'inters',
  },
  { ...CTX, mate: false },
);
check(wx.line.includes('12') && wx.line.includes('16') && /inters/i.test(wx.line),
  `the forecast call does not give the laps and the plan: "${wx.line}"`);

// A gap line has to carry the RATE, not just the gap. The gap is in the mirror;
// the rate is three laps of arithmetic the driver cannot do at 300km/h.
const gap = teamLine(
  { kind: 'gap', who: 'Halvorsen', gapS: 1.8, perLapS: -0.24, behind: true },
  { ...CTX, mate: false },
);
check(gap.line.includes('1.8') && gap.line.includes('0.2') && gap.line.includes('Halvorsen'),
  `the gap call does not carry who, how far and how fast: "${gap.line}"`);

// Losing a place to your own team-mate is political and cannot be said in the
// words used for losing one to a stranger.
const toMate = teamLine(
  { kind: 'position', gained: false, position: 7, who: 'Halvorsen', teammate: true },
  { ...CTX, mate: false },
).line;
const toRival = teamLine(
  { kind: 'position', gained: false, position: 7, who: 'Kovacs', teammate: false },
  { ...CTX, mate: false },
).line;
check(toMate !== toRival.replace('Kovacs', 'Halvorsen'),
  'losing a place to the team-mate is said in the same words as losing it to a stranger');

console.log(`team voice: ${spoken.size} distinct lines across ` +
  `${SHARED_NOTES.length + OWN_NOTES.length} events`);
check(toControl > 0, 'race control never spoke in a 20-minute race');
check(toTeam + dropped > 0, 'no team-owned bulletin was filed in a 20-minute race');
console.log(`channels: ${toControl} to race control, ${toTeam} to the team, ` +
  `${dropped} dropped as somebody else's business`);

// And the specific pair from the screenshot, checked directly: a rival off at
// a corner, and a rival's suspension. Neither may reach the principal.
{
  const rival = routeEngine.cars.find((c) => c.team.id !== me.team.id)!;
  const yellow: RaceControlMessage = {
    time: 0, text: 'Yellow flag — ' + rival.driver.code + ' off at sector 2',
    severity: 'warning', carIndex: rival.index, feed: 'either',
    notice: {
      parties: [rival.driver.code], where: 'SECTOR 2',
      offence: 'CAR OFF TRACK', status: 'YELLOW FLAG',
    },
    team: { kind: 'off', corner: 'sector 2', hit: '', heavy: false },
  };
  check(messageRoute(yellow, false) === 'race-control',
    "a rival's excursion must be race control, not the pit wall");
  check(messageRoute(yellow, true) === 'team',
    "the player's own excursion must come from their own pit wall");

  const suspension: RaceControlMessage = {
    time: 0, text: rival.driver.code + ': rear suspension damage',
    severity: 'warning', carIndex: rival.index, feed: 'team',
    team: { kind: 'damage', part: 'Rear suspension', health: 0.4 },
  };
  check(messageRoute(suspension, false) === 'none',
    "a rival's suspension damage must not be shown at all");
  check(messageRoute(suspension, true) === 'team',
    "the team's own suspension damage must reach the pit wall");

  const banner = raceControlCard(yellow);
  check(banner.headline === rival.driver.code + ' INCIDENT',
    `the incident banner reads "${banner.headline}"`);
  check(banner.detail === 'SECTOR 2 · CAR OFF TRACK · YELLOW FLAG',
    `the incident detail reads "${banner.detail}"`);
  check(banner.penalty.length === 0, 'a note was drawn as a decision');
  console.log(`race control banner: "${banner.headline}" / "${banner.detail}"`);
}

// Race control's two states: NOTED, and then DECIDED. A note is a banner of
// facts; a decision is the strip with the sentence set large across it, and it
// has to break onto the two lines a broadcast sets it on.
const DECISIONS: [string, string[]][] = [
  ['5 SECOND TIME PENALTY', ['5 SECOND', 'TIME PENALTY']],
  ['10 SECOND TIME PENALTY', ['10 SECOND', 'TIME PENALTY']],
  ['DRIVE-THROUGH PENALTY', ['DRIVE-THROUGH', 'PENALTY']],
  ['LAP TIME DELETED', ['LAP TIME', 'DELETED']],
  ['BLACK AND WHITE FLAG', ['BLACK AND', 'WHITE FLAG']],
  ['DISQUALIFIED', ['DISQUALIFIED']],
];
for (const [status, want] of DECISIONS) {
  const decided = raceControlCard({
    time: 0, text: 'x', severity: 'critical', carIndex: 0, feed: 'race-control',
    notice: { parties: ['HAL'], where: 'TURN 1', offence: 'CONTACT', status },
  });
  check(decided.penalty.join('/') === want.join('/'),
    `"${status}" sets as ${JSON.stringify(decided.penalty)}, wanted ${JSON.stringify(want)}`);
}
for (const status of ['NOTED', 'UNDER INVESTIGATION', 'YELLOW FLAG', 'WARNING 2 OF 3']) {
  const noted = raceControlCard({
    time: 0, text: 'x', severity: 'warning', carIndex: 0, feed: 'race-control',
    notice: { parties: ['HAL'], where: 'TURN 1', offence: 'CONTACT', status },
  });
  check(noted.penalty.length === 0, `"${status}" was drawn as a decision`);
}
console.log(`race control decisions: ${DECISIONS.length} penalties set on two lines`);

// ---------------------------------------------------------------------------
// 8. Nothing narrates a race that is not one
// ---------------------------------------------------------------------------
//
// "when I start qualifying, why am I being told to box?? that is so confusing?"
//
// Every session in this game except the race starts in the GARAGE, so
// `inPitLane` is true on the first frame of practice and of every qualifying
// segment — and the radio card keyed on it. The game opened Q1 by telling the
// driver, on new softs at 74 degrees, that he had nothing left on the rears.
//
// A screenshot sweep cannot catch a message that fires on frame one and is gone
// eight seconds later. This drives the opening of each session kind and asserts
// what the panel says and which moments are even reachable.

for (const kind of ['practice', 'qualifying', 'race'] as const) {
  const cfg: SessionConfig = {
    kind,
    name: kind === 'race' ? 'Grand Prix' : kind === 'qualifying' ? 'Q1' : 'Practice',
    durationS: kind === 'race' ? 0 : 900,
    laps: kind === 'race' ? 50 : 0,
    playerIndex: 0,
    standingStart: kind === 'race',
    pitLaneStart: kind !== 'race',
    seed: 55,
  };
  const eng = new RaceEngine(getCircuit('silverstone'), cfg);
  const car = eng.cars[0];

  // The first frame, which is where the fault was.
  const first = lapClock(eng, car);
  if (kind !== 'race') {
    check(car.inPitLane,
      `${kind}: this session is supposed to start in the garage and does not`);
    // OUT LAP, not a stopwatch. The lap out of the garage is the out-lap from
    // the moment the car is placed in it — the engine has already set
    // `onOutLap` — and that is the word the driver asked to see there.
    check(!first.timed && first.text === 'OUT LAP',
      `${kind}: the clock reads "${first.text}" leaving the garage, not OUT LAP`);
  }

  // Thirty seconds of it. `pitAdvice` is what raises the principal's pop-up,
  // and there are no strategy stops in a session that is three laps of your
  // own — so outside a race it must never speak at all.
  let advised = 0;
  let sawOutLap = false;
  for (let i = 0; i < Math.round(30 / PHYSICS_DT); i++) {
    eng.step();
    if (eng.pitAdvice(car) !== null) advised++;
    const clock = lapClock(eng, car);
    if (clock.text === 'OUT LAP') sawOutLap = true;
    // A clock that is running is a claim the lap will be classified.
    if (clock.timed) {
      check(!car.onOutLap && !car.inPitLane,
        `${kind}: the lap clock is running on an out-lap or in the pit lane`);
    }
  }
  if (kind !== 'race') {
    check(advised === 0,
      `${kind}: the pit wall gave ${advised} steps of pit advice in a session with no stops`);
    check(sawOutLap,
      `${kind}: the car left the garage and the clock never said OUT LAP`);
  }
  console.log(`${kind.padEnd(11)} opens on "${first.text}", ` +
    `out-lap shown: ${sawOutLap}, pit advice: ${advised > 0 ? 'yes' : 'none'}`);
}

// And the exchange itself may not assert something the car contradicts. A stop
// for a broken front wing on fresh tyres must not open with a tyre complaint.
{
  const cfg: SessionConfig = {
    kind: 'race', name: 'Grand Prix', durationS: 0, laps: 50,
    playerIndex: 0, standingStart: true, pitLaneStart: false, seed: 8,
  };
  const eng = new RaceEngine(getCircuit('silverstone'), cfg);
  const car = eng.cars[0];
  for (let i = 0; i < Math.round(60 / PHYSICS_DT); i++) eng.step();

  car.damage.health.frontWingL = 0.3;
  car.damage.health.frontWingR = 0.3;
  check(pitReason(eng, car) === 'damage',
    `a stop with a broken wing was reasoned as "${pitReason(eng, car)}"`);
  const damaged = radioExchange({
    kind: 'pit', compound: 'Hard', lapsLeft: 30, reason: 'damage',
  });
  for (const t of damaged) {
    check(!/tyre|rear|extend/i.test(t.line),
      `a wing stop claims something about the tyres: "${t.line}"`);
  }

  car.damage.health.frontWingL = 1;
  car.damage.health.frontWingR = 1;
  check(pitReason(eng, car) !== 'damage', 'an undamaged car was reasoned as a damage stop');
  check(pitReason(eng, car) !== 'tyres',
    'a car on fresh tyres was reasoned as a tyre stop — the wear is on the same screen');

  // Every reason gets its own exchange, and no two are the same words.
  const openings = new Set<string>();
  for (const reason of ['tyres', 'damage', 'weather', 'penalty', 'strategy'] as const) {
    const turns = radioExchange({ kind: 'pit', compound: 'Hard', lapsLeft: 12, reason });
    check(turns[0].who === 'driver', `the ${reason} exchange does not open with the driver`);
    openings.add(turns[0].line);
  }
  check(openings.size === 5, `five pit reasons produced ${openings.size} distinct openings`);
  console.log(`pit radio: 5 reasons, 5 distinct exchanges, none claiming what is not true`);
}

// The damage pop-up must not promise a part the crew is not going to fit.
{
  // The name as the diagram writes it, with the side on it — which is what the
  // caller actually passes and what produced "the front wing (l) has gone".
  const wing = pitCall('DAMAGE — PIT FOR REPAIRS', { part: 'Front wing (L)', repairable: true });
  check(wing !== null && !/\(/.test(wing.line),
    `the spoken line still carries the diagram's side marker: "${wing?.line}"`);
  check(wing !== null && /new one/.test(wing.line),
    `a repairable wing is not offered a replacement: "${wing?.line}"`);
  const floor = pitCall('DAMAGE — PIT FOR REPAIRS', { part: 'Floor', repairable: false });
  check(floor !== null && /cannot fix/.test(floor.line),
    `a cracked floor is being promised a repair: "${floor?.line}"`);
  check(floor !== null && !/nose|wing/i.test(floor.line),
    `a floor problem is being described as a wing: "${floor?.line}"`);
  for (const id of COMPONENT_IDS) {
    const ok = repairableInBox(id);
    check(ok === (id === 'frontWingL' || id === 'frontWingR' || id === 'sidepodL' || id === 'sidepodR'),
      `${id} is on the wrong side of what a pit crew can change`);
  }
  console.log('damage call: names the part it will actually fit');
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ' + f);
  process.exitCode = 1;
} else {
  console.log('\nHUD text OK');
}
