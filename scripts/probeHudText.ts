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
  radioExchange, relayed, repairableInBox, standingsCells, teamLine, towerFit, weatherReadout,
} from '../src/ui/Hud';
import { COMPONENT_IDS } from '../src/race/DamageModel';
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
// 6. The radio card is an argument, not a notification
// ---------------------------------------------------------------------------
//
// A radio clip is worth broadcasting because somebody is being overruled on it:
// the driver pushes back, the wall insists. So each moment has to be a real
// back-and-forth — both voices, alternating, more than once — and not a
// question with an answer stapled to it.

const MOMENTS = [
  { kind: 'pit', compound: 'Hard', lapsLeft: 20, reason: 'strategy' },
  { kind: 'safety-car' },
  { kind: 'vsc' },
  { kind: 'chequered', position: 4 },
  { kind: 'damage', part: 'Front wing' },
] as const;

for (const m of MOMENTS) {
  const turns = radioExchange(m);
  check(turns.length >= 2, `radio moment ${m.kind} has ${turns.length} turn(s), not an exchange`);
  check(turns.some((t) => t.who === 'driver') && turns.some((t) => t.who === 'wall'),
    `radio moment ${m.kind} is only one voice`);
  // Alternating: the card draws the driver on one side and the wall on the
  // other, so two turns from the same speaker in a row would read as one line
  // that wrapped rather than as two people.
  for (let i = 1; i < turns.length; i++) {
    check(turns[i].who !== turns[i - 1].who,
      `radio moment ${m.kind}: turns ${i - 1} and ${i} are both the ${turns[i].who}`);
  }
  for (const t of turns) {
    check(t.line.length > 6, `radio moment ${m.kind}: "${t.line}" is not a line of speech`);
    // Signage, not speech. `OFF TRACK — YELLOW FLAG` is what this card used to
    // print; a capitalised token with a dash after it is the shape of a status
    // string and never the shape of something a person said.
    check(!/^[A-Z0-9 ]{3,} — /.test(t.line),
      `radio moment ${m.kind}: "${t.line}" reads as a status string`);
  }
  check(new Set(turns.map((t) => t.line)).size === turns.length,
    `radio moment ${m.kind} repeats itself`);
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
console.log(`radio: ${MOMENTS.length} exchanges, ${MOMENTS.length * 4} turns, both voices alternating`);

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
for (let i = 0; i < Math.round(1200 / PHYSICS_DT); i++) routeEngine.step();
const me = routeEngine.cars[0];

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
const ALL_NOTES: TeamNote[] = [
  { kind: 'off', corner: 'Eau Rouge', hit: 'the barrier', heavy: true },
  { kind: 'off', corner: 'Les Combes', hit: '', heavy: false },
  { kind: 'damage', part: 'Rear suspension', health: 0.35 },
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
const spoken = new Set<string>();
for (const note of ALL_NOTES) {
  for (const mate of [false, true]) {
    const said = teamLine(note, {
      mate, surname: 'Halvorsen', position: 6, lapsLeft: 14, rival: 'KOV', rivalGapS: 2.3,
    });
    check(said.line.length > 12, `${note.kind}/${mate ? 'mate' : 'self'}: too short to be speech`);
    check(/[.?!]$/.test(said.line),
      `${note.kind}/${mate ? 'mate' : 'self'}: not a sentence — "${said.line}"`);
    check(!/^[A-Z0-9 ]{3,} — /.test(said.line),
      `${note.kind}/${mate ? 'mate' : 'self'}: reads as signage — "${said.line}"`);
    // A line about the team-mate has to name them, or the player cannot tell
    // which of the two cars it is about.
    if (mate) {
      check(said.line.includes('Halvorsen'),
        `${note.kind}: a line about the team-mate does not name them — "${said.line}"`);
    }
    spoken.add(said.line);
  }
}
check(spoken.size === ALL_NOTES.length * 2,
  `${ALL_NOTES.length * 2} team lines produced ${spoken.size} distinct sentences`);
// The one line the game knows enough to be genuinely specific on.
const stop = teamLine({ kind: 'stop', compound: 'Hard' }, {
  mate: false, surname: 'Halvorsen', position: 6, lapsLeft: 14, rival: 'KOV', rivalGapS: 2.3,
});
check(stop.line.includes('P6') && stop.line.includes('KOV') && stop.line.includes('14'),
  `the stop call is not specific: "${stop.line}"`);
console.log(`team voice: ${spoken.size} distinct lines across ${ALL_NOTES.length} events`);
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
  const wing = pitCall('DAMAGE — PIT FOR REPAIRS', { part: 'Front wing', repairable: true });
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
