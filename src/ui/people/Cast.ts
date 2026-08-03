import { look, lookFor, hashOf, type PersonLook, type PersonRole } from './Look';

/**
 * Who everybody is.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FILE EXISTS TO FIX
 * ---------------------------------------------------------------------------
 *
 * "why does it seem like the same person as the team principal for all the
 *  teams? that doesn't make sense."
 *
 * It did not, and it was worse than it looked. There were TWO faults stacked on
 * top of each other:
 *
 *   1. `Hud.principalSvg` drew one fixed silhouette — head, shoulders, headset,
 *      boom mic — and changed only the colour of the disc behind it. Eleven
 *      teams, one man.
 *   2. `Hud.PRINCIPALS` was keyed on the ids of the ten INVENTED teams this game
 *      shipped with — `apex`, `scuderia-rosso`, `meridian`. Career mode then
 *      replaced the grid with the real 2026 roster, whose ids are `mclaren`,
 *      `ferrari`, `red-bull`. Every lookup missed, every lookup fell through to
 *      the default, and every team's principal was literally named **"Pit
 *      wall"**. The player was not imagining the resemblance.
 *
 * So this file holds both halves — a name and a face — for every team in every
 * tier, and it never returns a shared fallback. An id it has never seen still
 * produces a specific person, because the alternative is how the bug happened.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRINCIPALS ARE INVENTED WHEN THE DRIVERS ARE REAL
 * ---------------------------------------------------------------------------
 *
 * `src/data/roster/` names the real 2026 grid, and the project's own rule
 * (documented there) is that it is the only module that names anything real. A
 * driver on an entry list is a matter of record. A team principal in this game
 * is something else: the press-conference system is going to put SENTENCES IN
 * THEIR MOUTH — opinions about your driving, about the board, about your
 * teammate — and attributing invented statements to a named living person is a
 * different act from listing them in a results table. It is also the one place
 * where getting it wrong is not a cosmetic problem.
 *
 * So the cast is fictional and the grid is real, and the two sit side by side
 * exactly as `teams.ts` and `roster/` already do.
 *
 * ONE LINE PER TEAM. If that call is ever reversed, it is eleven edits in the
 * table below and nothing else in the codebase has to move.
 */

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  /** As it is printed under the name. Sentence case. */
  role: string;
  nationality: string;
  look: PersonLook;
}

export function fullName(p: Person): string {
  return p.firstName + ' ' + p.lastName;
}

// ===========================================================================
// The authored cast
// ===========================================================================

/**
 * A principal, as five facts and the handful of look fields that make them
 * themselves.
 *
 * The rest of the twenty-one comes off the hash of their id, which is what
 * keeps these entries down to a line each. Author what is characteristic, let
 * the generator do the proportions.
 */
interface CastEntry {
  first: string;
  last: string;
  nat: string;
  role?: string;
  over: Partial<PersonLook>;
}

const cast = (
  first: string, last: string, nat: string, over: Partial<PersonLook>, role?: string,
): CastEntry => ({ first, last, nat, over, role });

/**
 * The eleven Formula 1 principals.
 *
 * Deliberately spread across the whole model, and checked by `probe:people`,
 * which fails the build if any two of them come within a distance of each
 * other. Reading down the column: bald, silver and swept, a bob, a full beard,
 * curls, shaved with a beard, a bun, a cap, glasses and volume, receding with a
 * moustache, tied back. Eleven silhouettes. That is the fix.
 */
const F1_CAST: Readonly<Record<string, CastEntry>> = {
  mclaren: cast('Duncan', 'Reith', 'United Kingdom', {
    hair: 'bald', eyewear: 'rect', headwear: 'none', age: 0.58, build: 0.62, complexion: 's2',
    facialHair: 'none', jaw: 0.82, headWidth: 0.72, turn: 0.34,
  }),
  ferrari: cast('Elena', 'Brambilla', 'Italy', {
    hair: 'side', hairPigment: 'jet', age: 0.42, build: 0.34, complexion: 's3',
    facialHair: 'none', eyewear: 'none', headwear: 'none', jaw: 0.32, faceLength: 0.42, turn: -0.42,
  }),
  'red-bull': cast('Wolfgang', 'Reiter', 'Austria', {
    hair: 'swept', hairPigment: 'silver', headwear: 'none', age: 0.74, build: 0.55, complexion: 's1',
    facialHair: 'none', eyewear: 'thin', brow: 0.72, jaw: 0.66, turn: 0.5,
  }),
  mercedes: cast('Katrin', 'Vosseler', 'Germany', {
    hair: 'tied', hairPigment: 'pepper', headwear: 'none', age: 0.5, build: 0.4, complexion: 's2',
    eyewear: 'rect', facialHair: 'none', faceLength: 0.66, turn: -0.28,
  }),
  'aston-martin': cast('Miles', 'Fenwick', 'United Kingdom', {
    hair: 'receding', hairPigment: 'steel', facialHair: 'full', headwear: 'none', age: 0.82,
    build: 0.78, complexion: 's2', eyewear: 'none', jaw: 0.88, turn: 0.22,
  }),
  williams: cast('Siân', 'Merrick', 'United Kingdom', {
    hair: 'curls', hairPigment: 'chestnut', headwear: 'none', age: 0.36, build: 0.36, complexion: 's1',
    facialHair: 'none', eyewear: 'none', headWidth: 0.4, turn: 0.62,
  }),
  'racing-bulls': cast('Nino', 'Carbone', 'Italy', {
    hair: 'shaved', hairPigment: 'jet', facialHair: 'beard', headwear: 'none', age: 0.3,
    build: 0.58, complexion: 's4', eyewear: 'none', jaw: 0.76, turn: -0.5,
  }),
  audi: cast('Lena', 'Brunner', 'Switzerland', {
    hair: 'bun', hairPigment: 'blond', headwear: 'none', age: 0.44, build: 0.32, complexion: 's1',
    facialHair: 'none', eyewear: 'round', faceLength: 0.34, turn: 0.4,
  }),
  alpine: cast('Théo', 'Marchand', 'France', {
    hair: 'volume', hairPigment: 'dark', facialHair: 'stubble', headwear: 'none', age: 0.4,
    build: 0.48, complexion: 's5', eyewear: 'none', headWidth: 0.68, turn: -0.34,
  }),
  haas: cast('Dale', 'Ostrander', 'United States', {
    hair: 'crop', hairPigment: 'sand', headwear: 'cap', facialHair: 'moustache',
    age: 0.66, build: 0.86, complexion: 's2', eyewear: 'none', jaw: 0.9, turn: 0.3,
  }),
  cadillac: cast('Marisol', 'Vega', 'United States', {
    hair: 'long', hairPigment: 'jet', headwear: 'none', age: 0.48, build: 0.42, complexion: 's6',
    facialHair: 'none', eyewear: 'none', faceLength: 0.56, turn: -0.6,
  }),
};

/**
 * The ten invented teams the game shipped with.
 *
 * Still reachable: Quick Race runs them, and a save made before career mode
 * installed the real grid still has them in it. The names are the ones that
 * were already in `Hud.ts`, because a player who has been racing for Apex for a
 * month should not find that Marco Vidal has been replaced by a stranger.
 */
const LEGACY_CAST: Readonly<Record<string, CastEntry>> = {
  apex: cast('Marco', 'Vidal', 'Italy', {
    hair: 'crop', hairPigment: 'pepper', age: 0.55, build: 0.6, complexion: 's4',
    facialHair: 'stubble', eyewear: 'none', turn: 0.36,
  }),
  'scuderia-rosso': cast('Elena', 'Brambilla', 'Italy', {
    hair: 'side', hairPigment: 'jet', age: 0.42, build: 0.34, complexion: 's3',
    facialHair: 'none', turn: -0.42,
  }),
  meridian: cast('Tom', 'Ashcroft', 'United Kingdom', {
    hair: 'receding', hairPigment: 'sand', age: 0.6, build: 0.72, complexion: 's1',
    facialHair: 'none', eyewear: 'rect', turn: 0.2,
  }),
  albion: cast('Rhys', 'Gallagher', 'Ireland', {
    hair: 'volume', hairPigment: 'ginger', age: 0.34, build: 0.5, complexion: 's1',
    facialHair: 'beard', turn: -0.5,
  }),
  aurora: cast('Ingrid', 'Sandell', 'Sweden', {
    hair: 'tied', hairPigment: 'blond', age: 0.4, build: 0.34, complexion: 's1',
    facialHair: 'none', turn: 0.5,
  }),
  vantage: cast('Cato', 'Brenner', 'Norway', {
    hair: 'bald', hairPigment: 'steel', age: 0.7, build: 0.8, complexion: 's2',
    facialHair: 'full', turn: 0.26,
  }),
  northstar: cast('Dana', 'Whitlock', 'United States', {
    hair: 'bun', hairPigment: 'brown', age: 0.46, build: 0.4, complexion: 's5',
    facialHair: 'none', eyewear: 'thin', turn: -0.3,
  }),
  lumen: cast('Sofia', 'Reyes', 'Mexico', {
    hair: 'long', hairPigment: 'dark', age: 0.36, build: 0.36, complexion: 's5',
    facialHair: 'none', turn: 0.58,
  }),
  kestrel: cast('Anders', 'Vike', 'Denmark', {
    hair: 'shaved', hairPigment: 'silver', age: 0.66, build: 0.56, complexion: 's1',
    facialHair: 'goatee', eyewear: 'round', turn: -0.36,
  }),
  brava: cast('Nino', 'Carbone', 'Italy', {
    hair: 'swept', hairPigment: 'jet', age: 0.32, build: 0.58, complexion: 's4',
    facialHair: 'stubble', turn: 0.44,
  }),
};

// ===========================================================================
// The generator, for everybody who is not in the table
// ===========================================================================

/**
 * Names for the people nobody wrote down.
 *
 * Thirty-two team ids exist across three tiers, more arrive whenever somebody
 * edits a roster, and a career invents teams of its own. Authoring a principal
 * for every one of them is a job nobody would keep up with, and the failure mode
 * of not doing it is the bug at the top of this file. So there is a generator,
 * and it is the DEFAULT rather than the exception.
 *
 * The pools are deliberately international and deliberately ordinary. Nothing
 * here is drawn from a list of real motorsport figures; they are the kind of
 * names a phone book is full of, which is the point — a principal called
 * "Storm Blackwood" tells the player they are reading generated text.
 */
const GIVEN = [
  'Adele', 'Adrian', 'Alba', 'Anders', 'Anouk', 'Arne', 'Beatriz', 'Bruno',
  'Camille', 'Carlos', 'Cecilia', 'Damien', 'Dario', 'Delphine', 'Eduardo',
  'Elias', 'Emiko', 'Enzo', 'Esther', 'Fabien', 'Farida', 'Felix', 'Gabriela',
  'Gerrit', 'Gustav', 'Hana', 'Helena', 'Ignacio', 'Ines', 'Ivo', 'Jasper',
  'Joanna', 'Jonas', 'Karel', 'Katja', 'Kwame', 'Lars', 'Laurent', 'Lena',
  'Leon', 'Lucia', 'Magnus', 'Malik', 'Margot', 'Mateo', 'Maya', 'Nadia',
  'Nils', 'Nuria', 'Olivier', 'Otto', 'Paula', 'Pieter', 'Rafael', 'Ravi',
  'Renata', 'Ruben', 'Sanne', 'Silvia', 'Simone', 'Sofia', 'Stefan', 'Takumi',
  'Tessa', 'Thomas', 'Tomas', 'Valerie', 'Viktor', 'Yuki', 'Zara',
];

const FAMILY = [
  'Abrahams', 'Almeida', 'Andersen', 'Baptista', 'Barros', 'Bergqvist',
  'Blomqvist', 'Bocelli', 'Brandt', 'Caldeira', 'Castellan', 'Chevalier',
  'Cortese', 'Dahlberg', 'Delacroix', 'Doorn', 'Duarte', 'Eriksen', 'Falkner',
  'Ferreira', 'Fontaine', 'Gallardo', 'Garnier', 'Haugen', 'Hendriks',
  'Herrera', 'Ibarra', 'Janssen', 'Kaufmann', 'Keresztes', 'Kirchner',
  'Kovacs', 'Laurens', 'Lindholm', 'Maartens', 'Marchetti', 'Mbeki',
  'Molnar', 'Moreau', 'Nakamura', 'Navarro', 'Nordin', 'Okafor', 'Olsen',
  'Pereira', 'Petrova', 'Quintana', 'Reinholt', 'Ricci', 'Rosales', 'Sandberg',
  'Schuurman', 'Serrano', 'Sorensen', 'Steenkamp', 'Tavares', 'Terzi',
  'Vanhoutte', 'Varga', 'Vasilev', 'Verhoeven', 'Vicente', 'Vondracek',
  'Wagner', 'Weiss', 'Wijnand', 'Zaman', 'Zielinski',
];

/**
 * A name for an id.
 *
 * Two independent draws off the same hash, decorrelated by different constants,
 * so `dams-f2` and `hitech-f2` do not both come out as Nils somebody.
 */
function generatedName(id: string): { first: string; last: string } {
  const h = hashOf(id);
  return {
    first: GIVEN[h % GIVEN.length],
    // The parentheses matter: `>>>` binds looser than `%`, so without them this
    // is `h >>> (0 % n)`, the index is four billion, and every surname is
    // `undefined`.
    last: FAMILY[(Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % FAMILY.length],
  };
}

// ===========================================================================
// The lookups
// ===========================================================================

const PRINCIPAL_CACHE = new Map<string, Person>();

/**
 * The person who runs a team.
 *
 * NEVER returns a shared fallback and never returns undefined. Whatever id is
 * handed in — a real team, an invented one, a team the player created for My
 * Team, an id from a save file written by a version that has not been built yet
 * — a specific principal comes back. That is the property whose absence
 * produced eleven identical "Pit wall" principals, and it is worth more than
 * any amount of authored detail.
 */
export function principalFor(teamId: string): Person {
  const hit = PRINCIPAL_CACHE.get(teamId);
  if (hit) return hit;

  const entry = F1_CAST[teamId] ?? LEGACY_CAST[teamId];
  const id = 'principal:' + teamId;
  let p: Person;
  if (entry) {
    p = {
      id,
      firstName: entry.first,
      lastName: entry.last,
      role: entry.role ?? 'Team principal',
      nationality: entry.nat,
      look: look(id, 'principal', entry.over),
    };
  } else {
    const n = generatedName(id);
    p = {
      id,
      firstName: n.first,
      lastName: n.last,
      role: 'Team principal',
      // Unknown, and honestly so: the plate falls back to the FIA code rather
      // than claiming a nationality nobody wrote down.
      nationality: '',
      look: lookFor(id, 'principal'),
    };
  }
  PRINCIPAL_CACHE.set(teamId, p);
  return p;
}

/**
 * The principal's name, for a byline.
 *
 * A DROP-IN for `Hud.principalOf`, with the same signature and the same return
 * type, so the two call sites in `Hud.ts` and `StrategyScreen.ts` are a one-line
 * import change each. It differs in exactly one way: it is never "Pit wall".
 */
export function principalNameOf(teamId: string): string {
  return fullName(principalFor(teamId));
}

const PERSON_CACHE = new Map<string, Person>();

/**
 * Anybody else: a journalist, a marshal, a photographer, a mechanic.
 *
 * Same contract as `principalFor` — deterministic from the id, cached, never
 * stored in a save, never shared between two ids.
 */
export function personFor(id: string, role: PersonRole = 'guest'): Person {
  const key = role + ':' + id;
  const hit = PERSON_CACHE.get(key);
  if (hit) return hit;
  const n = generatedName(key);
  const p: Person = {
    id: key,
    firstName: n.first,
    lastName: n.last,
    role: ROLE_TITLES[role],
    nationality: '',
    look: lookFor(key, role),
  };
  PERSON_CACHE.set(key, p);
  return p;
}

const ROLE_TITLES: Readonly<Record<PersonRole, string>> = {
  principal: 'Team principal',
  driver: 'Driver',
  journalist: 'Paddock press',
  crew: 'Race team',
  official: 'Race control',
  guest: 'Paddock',
};

/**
 * A room full of journalists.
 *
 * The outlets are invented, for the same reason the sponsors in
 * `docs/CAREER_MODE.md` are: a masthead is a wordmark. They are also written to
 * sound like the trade rather than like a newspaper — a press room is wire
 * services, a handful of specialist sites and two broadcasters, and it is the
 * one detail that makes the room read as a paddock rather than as a town hall.
 */
const OUTLETS = [
  'Pitlane Wire', 'Apex Report', 'Racing Digest', 'The Slipstream',
  'Grid Report', 'Chicane', 'Motor Weekly', 'Sector Three', 'Paddock Notes',
  'Full Course', 'Undercut', 'The Long Run',
];

export interface Journalist extends Person {
  outlet: string;
}

export function journalistsFor(seed: string, count: number): Journalist[] {
  const out: Journalist[] = [];
  for (let i = 0; i < count; i++) {
    const p = personFor(seed + ':press:' + i, 'journalist');
    out.push({ ...p, outlet: OUTLETS[hashOf(p.id) % OUTLETS.length] });
  }
  return out;
}
