import { getCompound } from '../data/tires';
import type { Driver, Team } from '../data/teams';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';
import {
  pitLossS, stintLife, strategyOptions, strategySummary, type StrategyOption,
} from '../race/Strategy';
import { principalOf, principalSvg, teamMarkSvg, weatherGlyphSvg } from './Hud';

/**
 * The race plan, before the lights.
 *
 * WHAT THIS IS FOR. The simulation has always chosen a tyre strategy for every
 * car including the player's — one stop or two, on which laps, on which
 * compounds — and it did it in a private method during the engine's
 * constructor and never mentioned it. The single largest decision in a Grand
 * Prix was made for the player off screen. This is where it gets made on
 * screen, by them, for both of their team's cars.
 *
 * WHAT IT IS NOT. It is not a fantasy. Every number on this page is read off
 * the same model the race then runs: tyre life from the compound's wear rate,
 * the team's `tireWearMult` and the circuit's abrasion; pit loss from the
 * circuit's own pit-lane delta and the team's crew time. See `Strategy.ts` for
 * the two things that are deliberately absent — a predicted lap-time delta and
 * a weather forecast — and why inventing either would be worse than the gap.
 *
 * THE SHAPE. A principal's call across the top, the conditions beside it, then
 * one column per car in the team, each a stack of strategy cards showing the
 * stint sequence as tyres and pit windows. The card is the row: label, stop
 * count, then compound → window → compound left to right, which is how a pit
 * wall draws a race and how a viewer reads one.
 */

export interface StrategyScreenOptions {
  team: Team;
  /** The two drivers of the team, the player first. */
  drivers: readonly Driver[];
  /** Which of `drivers` the player is. */
  playerIndex: number;
  track: TrackDefinition;
  laps: number;
  /** Chosen option id per driver, by driver id. */
  chosen: Record<string, string>;
  onChoose: (driverId: string, optionId: string) => void;
}

export function buildStrategyScreen(parent: HTMLElement, opts: StrategyScreenOptions): void {
  const { team, drivers, track, laps } = opts;

  // --- The principal's call ----------------------------------------------
  const head = el('div', 'strat-head', parent);

  const speaker = el('div', 'strat-speaker', head);
  const portrait = el('div', 'strat-portrait', speaker);
  portrait.appendChild(principalSvg(team));
  const bubble = el('div', 'strat-bubble', speaker);
  el('div', 'strat-who', bubble, principalOf(team.id) + ' · Team principal');
  el('div', 'strat-say', bubble, principalLine(team, drivers, track, laps));

  // --- Conditions ---------------------------------------------------------
  //
  // Headed RISK, not FORECAST, and that word is the honest part. `Weather`
  // decides in its constructor whether it will rain this session and keeps
  // that roll private — correctly, because a driver who already knows is not
  // making a decision. The only real pre-race number is the circuit's own
  // rain chance, so that is the number shown.
  const wx = el('div', 'strat-weather', head);
  el('div', 'strat-weather-label', wx, 'Conditions');
  const wxBody = el('div', 'strat-weather-body', wx);
  const glyph = el('div', 'strat-weather-glyph ' + (track.rainChance > 0.25 ? 'is-wet' : 'is-dry'), wxBody);
  glyph.appendChild(weatherGlyphSvg());
  const wxText = el('div', '', wxBody);
  el('div', 'strat-weather-word', wxText,
    track.rainChance > 0.25 ? 'RAIN LIKELY' : track.rainChance > 0.08 ? 'RAIN POSSIBLE' : 'DRY EXPECTED');
  el('div', 'strat-weather-temps', wxText,
    'Air ' + Math.round(track.baseAirTempC) + '°  |  Track ' + Math.round(track.baseTrackTempC) + '°' +
    '  |  Rain risk ' + Math.round(track.rainChance * 100) + '%');

  // --- One column per car -------------------------------------------------
  const cols = el('div', 'strat-cols', parent);
  for (const [i, driver] of drivers.entries()) {
    const col = el('div', 'strat-col', cols);

    const colHead = el('div', 'strat-colhead', col);
    const mark = el('div', 'strat-mark', colHead);
    mark.appendChild(teamMarkSvg(team));
    const who = el('div', 'strat-driver', colHead);
    el('span', 'strat-driver-first', who, driver.firstName);
    el('span', 'strat-driver-last', who, driver.lastName.toUpperCase());
    el('div', 'strat-carno', colHead, '#' + driver.raceNumber);
    if (i === opts.playerIndex) el('div', 'strat-you', colHead, 'You');

    const life = stintLife(team, driver, track);
    el('div', 'strat-label', col, 'Tyre strategy');
    el('div', 'strat-life', col,
      'Medium lasts ~' + Math.round(life.medium) + ' laps for ' + driver.lastName +
      ' here · a stop costs ' + pitLossS(team, track).toFixed(1) + 's');

    const options = strategyOptions(team, driver, track, laps);
    const cards: HTMLElement[] = [];
    for (const option of options) {
      const card = strategyCard(col, option, laps);
      cards.push(card);
      card.addEventListener('click', () => {
        opts.onChoose(driver.id, option.id);
        for (const [j, c] of cards.entries()) {
          c.classList.toggle('selected', options[j].id === option.id);
        }
      });
    }
    const picked = opts.chosen[driver.id] ?? options.find((o) => o.label === 'RECOMMENDED')?.id;
    for (const [j, c] of cards.entries()) c.classList.toggle('selected', options[j].id === picked);
  }
}

/** One selectable plan: label, stop count, and the stint sequence. */
function strategyCard(parent: HTMLElement, option: StrategyOption, laps: number): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'strat-card tone-' + toneOf(option);
  parent.appendChild(card);

  const top = el('div', 'strat-card-top', card);
  el('div', 'strat-card-label', top, option.label);
  el('div', 'strat-card-stops', top, option.stops + (option.stops === 1 ? ' STOP' : ' STOPS'));

  const run = el('div', 'strat-run', card);
  for (const stint of option.stints) {
    const c = getCompound(stint.compound);
    const leg = el('div', 'strat-leg', run);
    const disc = el('div', 'strat-tyre', leg);
    disc.style.setProperty('--compound', '#' + c.colour.toString(16).padStart(6, '0'));
    el('span', '', disc, c.code);
    el('div', 'strat-leg-name', leg, c.name.toUpperCase());
    el('div', 'strat-leg-laps', leg, stint.laps + ' laps');

    if (stint.pitOnLap > 0) {
      const win = el('div', 'strat-window', run);
      el('div', 'strat-window-label', win, 'Pit window');
      el('div', 'strat-window-rule', win);
      const from = Math.max(1, stint.pitOnLap - 2);
      const to = Math.min(laps - 1, stint.pitOnLap + 2);
      el('div', 'strat-window-laps', win, 'LAPS ' + from + '–' + to);
    }
  }

  el('div', 'strat-card-why', card, option.why);
  el('div', 'strat-card-cost', card, strategySummary(option));
  if (option.strain > 1) {
    el('div', 'strat-card-warn', card,
      'Asks ' + Math.round(option.strain * 100) + '% of a stint’s life — the last laps will be on a dead tyre.');
  }
  return card;
}

function toneOf(o: StrategyOption): string {
  return o.label === 'RECOMMENDED' ? 'go' : o.label === 'RISKY' ? 'warn' : 'flat';
}

/**
 * What the principal says about this race.
 *
 * Derived, not written: which of the two drivers is harder on a tyre, and
 * whether this circuit's abrasion makes the distance a one-stop or not. The
 * point of a character giving the call is that the call has a reason.
 */
function principalLine(
  team: Team, drivers: readonly Driver[], track: TrackDefinition, laps: number,
): string {
  const best = strategyOptions(team, drivers[0], track, laps)
    .find((o) => o.label === 'RECOMMENDED');
  const life = stintLife(team, drivers[0], track);
  const stops = best ? best.stops : 1;
  const laps10 = Math.round(life.medium);

  // The verdict is on the tyre LIFE, not on the abrasion coefficient. A high
  // abrasion figure on a short lap is still thirty laps of medium, and a
  // principal who says "this surface eats tyres — about 32 laps on a medium"
  // in one breath is not somebody a driver listens to twice.
  const surface = laps10 < 20
    ? 'This surface is brutal — about ' + laps10 + ' laps on a medium and then it is gone. '
    : laps10 < 30
      ? 'The mediums are good for about ' + laps10 + ' laps here before they go away. '
      : 'Kind enough on the tyres: about ' + laps10 + ' laps on a medium. ';

  return surface + (stops === 1
    ? 'I believe the one-stop is the right call for both cars. Look after the rears and it comes to us.'
    : 'I want ' + stops + ' stops on both cars. We give up track position twice and take it back on grip.');
}

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
