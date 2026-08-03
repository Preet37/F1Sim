import {
  COMPLEXIONS, HAIR_PIGMENTS, HAIR_STYLES, FACIAL_HAIR, EYEWEAR, HEADWEAR,
  coerceLook, lookFor, lookFromSeed, lookDistance,
  type PersonLook, type PersonRole,
} from '../src/ui/people/Look';
import { headGeometry, skullPath } from '../src/ui/people/Face';
import { principalFor, principalNameOf, personFor, journalistsFor, fullName } from '../src/ui/people/Cast';
import { F1_2026 } from '../src/data/roster/f1-2026';
import { F2_2026, F3_2026 } from '../src/data/roster/junior';

/**
 * The people, asserted.
 *
 * A drawing cannot be verified by a probe — `shoot:people` exists for that. What
 * CAN be verified is the thing the complaint was actually about:
 *
 *   "why does it seem like the same person as the team principal for all the
 *    teams? that doesn't make sense."
 *
 * That is a statement about DISTANCE between records, and distance is arithmetic.
 * So this probe holds the line the fix established: every team in every tier has
 * a principal, no two of them are the same name, no two of them are within a
 * threshold of each other in the look model, and nobody anywhere is called "Pit
 * wall".
 *
 *   npm run probe:people
 */

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ''): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error('  FAIL  ' + what + (detail ? '  —  ' + detail : ''));
}

function section(title: string): void {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
}

// ===========================================================================

section('Every team has a principal, and they are all different people');

const ALL_TEAMS = [
  ...F1_2026.teams.map((t) => ({ tier: 'F1', id: t.id, name: t.shortName })),
  ...F2_2026.teams.map((t) => ({ tier: 'F2', id: t.id, name: t.shortName })),
  ...F3_2026.teams.map((t) => ({ tier: 'F3', id: t.id, name: t.shortName })),
  // The ten the game shipped with, still reachable from Quick Race and from a
  // save made before career mode installed the real grid.
  ...['apex', 'scuderia-rosso', 'meridian', 'albion', 'aurora', 'vantage',
    'northstar', 'lumen', 'kestrel', 'brava']
    .map((id) => ({ tier: 'legacy', id, name: id })),
];

console.log(`  ${ALL_TEAMS.length} teams across three tiers plus the legacy grid`);

const names = new Map<string, string>();
for (const t of ALL_TEAMS) {
  const p = principalFor(t.id);
  const n = fullName(p);
  ok(n.trim().length > 3, `${t.id} has a principal with a name`, n);
  // THE BUG, ASSERTED. `Hud.principalOf` returned this string for every team on
  // the real grid, because its table was keyed on the invented ids.
  ok(n !== 'Pit wall', `${t.id}'s principal is a person, not "Pit wall"`);
  ok(p.role.length > 0, `${t.id}'s principal has a role`);
  const clash = names.get(n);
  ok(clash === undefined, `${t.id}'s principal has a unique name`, clash ? `also ${clash}` : '');
  names.set(n, t.id);
}

// The drop-in used by the HUD and the strategy screen.
for (const t of ALL_TEAMS.slice(0, 6)) {
  ok(principalNameOf(t.id) === fullName(principalFor(t.id)),
    `principalNameOf agrees with principalFor for ${t.id}`);
}

section('No two principals look alike');

/**
 * The threshold.
 *
 * `lookDistance` weights silhouette, then value, then furniture, then build —
 * the order a viewer actually sorts people in. 0.30 is one whole hair style
 * apart, which is the least that reads as two different people across a room.
 * The eleven Formula 1 principals are authored, so they are held to a higher
 * bar than the generated ones.
 */
const MIN_F1 = 0.30;
const MIN_ANY = 0.12;

let worstF1 = { d: 9, a: '', b: '' };
const f1Ids = F1_2026.teams.map((t) => t.id);
for (let i = 0; i < f1Ids.length; i++) {
  for (let j = i + 1; j < f1Ids.length; j++) {
    const d = lookDistance(principalFor(f1Ids[i]).look, principalFor(f1Ids[j]).look);
    if (d < worstF1.d) worstF1 = { d, a: f1Ids[i], b: f1Ids[j] };
    ok(d >= MIN_F1, `${f1Ids[i]} and ${f1Ids[j]} are visibly different principals`,
      `distance ${d.toFixed(3)} < ${MIN_F1}`);
  }
}
console.log(`  closest pair on the Formula 1 grid: ${worstF1.a} / ${worstF1.b}`
  + ` at ${worstF1.d.toFixed(3)}`);

let worstAll = { d: 9, a: '', b: '' };
for (let i = 0; i < ALL_TEAMS.length; i++) {
  for (let j = i + 1; j < ALL_TEAMS.length; j++) {
    const d = lookDistance(principalFor(ALL_TEAMS[i].id).look, principalFor(ALL_TEAMS[j].id).look);
    if (d < worstAll.d) worstAll = { d, a: ALL_TEAMS[i].id, b: ALL_TEAMS[j].id };
  }
}
ok(worstAll.d >= MIN_ANY, 'no two principals anywhere are near-identical',
  `${worstAll.a} / ${worstAll.b} at ${worstAll.d.toFixed(3)}`);
console.log(`  closest pair anywhere: ${worstAll.a} / ${worstAll.b} at ${worstAll.d.toFixed(3)}`);

section('The generator spreads');

/**
 * A thousand strangers, and how much of the model they actually reach.
 *
 * A generator that technically has eleven hair styles but picks one of them
 * ninety percent of the time produces a paddock of clones, and the arithmetic
 * above would not catch it because it only compares principals. This checks the
 * distribution.
 */
const N = 1000;
const looks: PersonLook[] = [];
for (let i = 0; i < N; i++) looks.push(lookFromSeed(i * 7919 + 13, 'guest'));

const hairSeen = new Set(looks.map((l) => l.hair));
const skinSeen = new Set(looks.map((l) => l.complexion));
const beardSeen = new Set(looks.map((l) => l.facialHair));
ok(hairSeen.size === HAIR_STYLES.length, 'every hair style is reachable',
  `${hairSeen.size}/${HAIR_STYLES.length}`);
ok(skinSeen.size === COMPLEXIONS.length, 'every complexion is reachable',
  `${skinSeen.size}/${COMPLEXIONS.length}`);
ok(beardSeen.size === FACIAL_HAIR.length, 'every beard is reachable',
  `${beardSeen.size}/${FACIAL_HAIR.length}`);

// No single option may take more than a quarter of the population.
for (const [label, key, set] of [
  ['hair', 'hair', HAIR_STYLES],
  ['complexion', 'complexion', COMPLEXIONS.map((c) => c.id)],
  ['hair pigment', 'hairPigment', HAIR_PIGMENTS.map((h) => h.id)],
  ['eyewear', 'eyewear', EYEWEAR],
  ['headwear', 'headwear', HEADWEAR],
] as [string, keyof PersonLook, readonly string[]][]) {
  const counts = new Map<string, number>();
  for (const l of looks) {
    const v = String(l[key]);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let top = { v: '', n: 0 };
  for (const [v, n] of counts) if (n > top.n) top = { v, n };
  const share = top.n / N;
  // Small sets legitimately concentrate; the bar scales with how many options
  // there are, and it is generous — 2.6x an even split.
  const bar = Math.min(0.62, 2.6 / set.length);
  ok(share <= bar, `${label} does not collapse onto one value`,
    `${top.v} takes ${(share * 100).toFixed(1)}% (bar ${(bar * 100).toFixed(0)}%)`);
}

// How far apart two random strangers are, on average.
let sum = 0;
let pairs = 0;
let identical = 0;
for (let i = 0; i < 300; i++) {
  for (let j = i + 1; j < 300; j++) {
    const d = lookDistance(looks[i], looks[j]);
    sum += d; pairs += 1;
    if (d < 0.05) identical += 1;
  }
}
console.log(`  mean distance between two strangers: ${(sum / pairs).toFixed(3)}`);
console.log(`  near-identical pairs in ${pairs}: ${identical}`);
ok(sum / pairs > 0.40, 'two strangers are usually visibly different people',
  (sum / pairs).toFixed(3));
ok(identical / pairs < 0.004, 'near-identical pairs are rare',
  `${((identical / pairs) * 100).toFixed(3)}%`);

section('Determinism, and nothing stored');

for (const id of ['norris', 'hamilton', 'PLAYER', 'a-driver-nobody-has-ever-seen']) {
  const a = lookFor(id, 'driver');
  const b = lookFor(id, 'driver');
  ok(JSON.stringify(a) === JSON.stringify(b), `${id} is the same person twice running`);
  // Roles genuinely produce different people from the same id — a driver and a
  // journalist called the same thing are not the same face.
  const j = lookFor(id, 'journalist');
  ok(JSON.stringify(a) !== JSON.stringify(j), `${id} as a driver differs from ${id} as press`);
}

const room = journalistsFor('monza:8', 5);
const room2 = journalistsFor('monza:8', 5);
ok(room.length === 5, 'a press room has the requested number of journalists');
ok(room.every((r, i) => r.id === room2[i].id), 'the same round produces the same room');
ok(new Set(room.map((r) => r.id)).size === 5, 'no journalist appears twice in one room');
ok(room.every((r) => r.outlet.length > 0), 'every journalist has an outlet');

section('Garbage in');

/**
 * `coerceLook` is the boundary.
 *
 * A `PersonLook` is not in the save today, but `PressPanelist.look` and
 * `PodiumEntry.look` are both public overrides, and anything a public override
 * accepts will eventually arrive from somewhere that did not read this file.
 */
const JUNK: unknown[] = [
  null, undefined, 42, 'a string', [], {},
  { hair: 'mullet', complexion: 'chartreuse' },
  { build: NaN, age: Infinity, turn: -99, headWidth: 'wide' },
  { hair: null, eyewear: 0, headwear: [], facialHair: {} },
  JSON.parse('{"turn": 1e400}'),
];
for (const [i, junk] of JUNK.entries()) {
  const l = coerceLook(junk, 1234, 'principal');
  const numeric: (keyof PersonLook)[] = [
    'build', 'height', 'headWidth', 'faceLength', 'jaw', 'chin', 'brow', 'eyeLine',
    'eyeSpacing', 'nose', 'noseWidth', 'mouth', 'lips', 'cheek', 'age',
  ];
  let clean = Number.isFinite(l.turn) && l.turn >= -1 && l.turn <= 1;
  for (const k of numeric) {
    const v = l[k] as number;
    if (!Number.isFinite(v) || v < 0 || v > 1) clean = false;
  }
  ok(clean, `junk #${i} coerces to a legal look`);
  ok(HAIR_STYLES.includes(l.hair), `junk #${i} coerces to a real hair style`);
  ok(COMPLEXIONS.some((c) => c.id === l.complexion), `junk #${i} coerces to a real complexion`);

  // And it has to be DRAWABLE: the geometry must come out finite, or the path
  // string contains "NaN" and the whole portrait silently disappears.
  const g = headGeometry(l);
  const d = skullPath(g);
  ok(!d.includes('NaN'), `junk #${i} produces a drawable skull`);
  ok(g.chinY > g.crownY && g.hw > 0, `junk #${i} produces a sane head`);
}

section('Every look in the model is drawable');

/**
 * The whole cross-product of the categorical fields, at the extremes of the
 * numeric ones.
 *
 * 11 hair x 6 beards x 5 glasses x 5 headwear is 1650 combinations, and the
 * failure they are looking for is a path that comes out with a NaN in it —
 * which does not throw, does not log, and renders as nothing at all. That
 * failure mode is why this is exhaustive rather than sampled.
 */
let drawn = 0;
const EXTREMES = [0, 1];
for (const hair of HAIR_STYLES) {
  for (const facialHair of FACIAL_HAIR) {
    for (const eyewear of EYEWEAR) {
      for (const headwear of HEADWEAR) {
        for (const e of EXTREMES) {
          const l: PersonLook = {
            ...lookFromSeed(99, 'guest'),
            hair, facialHair, eyewear, headwear,
            build: e, height: e, headWidth: e, faceLength: e, jaw: e, chin: e,
            brow: e, eyeLine: e, eyeSpacing: e, nose: e, noseWidth: e, mouth: e,
            lips: e, cheek: e, age: e, turn: e === 0 ? -1 : 1,
          };
          const g = headGeometry(l);
          const d = skullPath(g);
          if (d.includes('NaN') || !Number.isFinite(g.eyeY) || g.hw <= 0) {
            ok(false, `drawable: ${hair}/${facialHair}/${eyewear}/${headwear} at ${e}`);
          }
          drawn += 1;
        }
      }
    }
  }
}
checks += 1;
console.log(`  ${drawn} combinations, all drawable`);

section('The cast covers every role');

const ROLES: PersonRole[] = ['principal', 'driver', 'journalist', 'crew', 'official', 'guest'];
for (const r of ROLES) {
  const p = personFor('probe-' + r, r);
  ok(fullName(p).trim().length > 3, `role ${r} produces a named person`, fullName(p));
  ok(p.role.length > 0, `role ${r} produces a title`, p.role);
  const g = headGeometry(p.look);
  ok(!skullPath(g).includes('NaN'), `role ${r} produces a drawable head`);
}

// ===========================================================================

console.log('\n' + '='.repeat(56));
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
