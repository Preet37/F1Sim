import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPLEXIONS, HAIR_PIGMENTS, HAIR_STYLES, FACIAL_HAIR, EYEWEAR, HEADWEAR,
  coerceLook, lookFor, lookFromSeed, lookDistance,
  type PersonLook, type PersonRole,
} from '../src/ui/people/Look';
import { headGeometry, skullPath } from '../src/ui/people/Face';
import { figureArt } from '../src/ui/people/Figure';
import { buildRig, polyPath, type Pose } from '../src/ui/people/Body';
import {
  area, inside, overlap, parsePolygon, parts, pt, widthAcross,
  type Pt, type Shape,
} from './lib/figureGeom';
import { legacyBodyArt, legacyTorsoPolygon, type LegacyPose } from './lib/legacyFigure';
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
 * ---------------------------------------------------------------------------
 * AND SINCE #22, THE BODY — WHICH IS NOT ARITHMETIC
 * ---------------------------------------------------------------------------
 *
 * Everything above is distance between records. None of it could say anything
 * at all about the thing the user rejected below the neck, and the proof of
 * that is that all 537 of those checks passed on a build whose podium arm was
 * one constant-width stroke with no hand on it and whose garage crew were
 * armless torsos.
 *
 * A body needs different assertions, and they are about SHAPES SHARING AREA
 * rather than about numbers being far apart:
 *
 *   - a hand exists, and it overlaps the forearm it is on
 *   - a forearm overlaps its upper arm at the elbow
 *   - an upper arm overlaps the torso at the shoulder, but is not BURIED in
 *     it, which is the whole of "the garage crew are armless torsos"
 *   - a held object's grip is inside the hand holding it
 *   - nothing is a bare rectangle: every limb is a filled shape that measurably
 *     narrows from one end to the other, and a `fill="none"` stroke is not a
 *     limb
 *
 * All of it is measured off the MARKUP - the string the browser is handed -
 * rather than off the rig that generated it, because a probe that asks the rig
 * whether it agrees with itself is the probe this project keeps writing by
 * accident. See `scripts/lib/figureGeom.ts`.
 *
 *   npm run probe:people
 *   PEOPLE_LEGACY=1 npm run probe:people   # the body as it shipped, measured
 *   PEOPLE_BREAK=hands|detach|stick|bury|grip npm run probe:people
 */

const SRC_DIR = join(process.cwd(), 'src');

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

section('The cast is WIRED IN, not merely present');

/**
 * The trap this project keeps falling into, asserted.
 *
 * PROJECT.md §6: the intro sequence and the podium were both built and the user
 * has never seen either, because nothing routes to them. Four thousand lines of
 * people that only `audit/people.ts` imports is the same failure, and every
 * check above it passes happily in that state — `principalFor` returns eleven
 * distinct principals whether or not a screen ever calls it.
 *
 * So this section does not ask what the cast CAN do. It asks what the running
 * game actually draws, by reading the source of the screens. It is deliberately
 * a text check: the thing being guarded against is somebody quietly changing an
 * import back, and an import is text.
 */
const SRC = SRC_DIR;

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourcesUnder(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const ALL_SRC = sourcesUnder(SRC);

// 1. The screen the player actually reaches before every race.
const strat = readFileSync(join(SRC, 'ui', 'StrategyScreen.ts'), 'utf8');
ok(/principalDiscSvg\s*\(/.test(strat),
  'the strategy screen draws a PERSON, not the fixed pictogram',
  'StrategyScreen.ts does not call principalDiscSvg');
ok(/principalNameOf\s*\(/.test(strat),
  'the strategy screen names the principal from the cast');

// 2. `Hud.principalSvg` is the one-silhouette drawer that caused the complaint.
//    It takes only a colour, so it CANNOT draw a specific person — any call to
//    it anywhere is the bug, by construction.
for (const f of ALL_SRC) {
  if (f.includes('/ui/people/')) continue;             // the comments explaining it
  if (f.endsWith('/ui/Hud.ts')) continue;              // its own declaration
  const s = readFileSync(f, 'utf8');
  ok(!/[^a-zA-Z]principalSvg\s*\(/.test(s),
    `${f.slice(SRC.length + 1)} does not draw the one-silhouette principal`);
}

// 3. The fallback string itself. It only ever existed as a `??` default in
//    `Hud.ts`; if it reappears as one, the bug has been reintroduced wholesale.
for (const f of ALL_SRC) {
  const s = readFileSync(f, 'utf8');
  ok(!/\?\?\s*'Pit wall'/.test(s) && !/\?\?\s*"Pit wall"/.test(s),
    `${f.slice(SRC.length + 1)} has no "Pit wall" fallback`);
}


// ===========================================================================
// The body
// ===========================================================================

section('Anatomy - every limb, measured off the drawing');

/**
 * How a figure is damaged, for the "prove it goes red" runs.
 *
 * These are applied to the MARKUP, after it is generated and before it is
 * measured, so each one simulates a drawing defect rather than a rig defect —
 * which is the only kind of proof worth having when the thing under test is
 * what ends up on the screen. `PEOPLE_BREAK=` picks one.
 */
type Break = '' | 'hands' | 'detach' | 'stick' | 'bury' | 'grip';
const BREAK = (process.env.PEOPLE_BREAK ?? '') as Break;
const LEGACY = process.env.PEOPLE_LEGACY === '1';

function mapPolys(markup: string, ids: RegExp, f: (p: Pt[]) => Pt[]): string {
  return markup.replace(/<path\b[^>]*?\/>/g, (el) => {
    const id = /data-part="([^"]+)"/.exec(el);
    if (!id || !ids.test(id[1])) return el;
    const d = /\sd="([^"]*)"/.exec(el);
    if (!d) return el;
    const poly = parsePolygon(d[1]);
    if (!poly) return el;
    return el.replace(d[0], ' d="' + polyPath(f(poly)) + '"');
  });
}

function damage(markup: string, H: number, cx: number): string {
  switch (BREAK) {
    case 'hands':
      // The garage's own defect: an arm that stops.
      return markup.replace(/<(path|ellipse)\b[^>]*?data-part="hand-[lr]"[^>]*?\/>/g, '');
    case 'detach':
      // The forearm and the hand drift off the elbow, which is what happens
      // the moment a hand is placed by a formula instead of by a joint.
      return mapPolys(markup, /^(arm-[lr]-fore|hand-[lr])$/,
        (poly) => poly.map((p) => ({ x: p.x + H * 0.55, y: p.y + H * 0.30 })));
    case 'stick':
      // Every arm re-drawn at ONE width: the podium's stroke, as a polygon.
      return mapPolys(markup, /^arm-[lr]-(upper|fore)$/, (poly) => {
        let sx = 0;
        let sy = 0;
        for (const p of poly) { sx += p.x; sy += p.y; }
        const c = { x: sx / poly.length, y: sy / poly.length };
        let ax = 0;
        let ay = 0;
        for (const p of poly) {
          const dx = p.x - c.x;
          const dy = p.y - c.y;
          if (Math.hypot(dx, dy) > Math.hypot(ax, ay)) { ax = dx; ay = dy; }
        }
        const L = Math.hypot(ax, ay) || 1;
        const ux = ax / L;
        const uy = ay / L;
        const w = H * 0.16;
        return poly.map((p) => {
          const t = (p.x - c.x) * ux + (p.y - c.y) * uy;
          const sgn = (p.x - c.x) * -uy + (p.y - c.y) * ux >= 0 ? 1 : -1;
          return { x: c.x + ux * t - uy * w * sgn, y: c.y + uy * t + ux * w * sgn };
        });
      });
    case 'bury': {
      // The shipped defect, exactly: the arms are pulled inside the torso AND
      // moved into the layer painted BEFORE it. Nothing is missing; nothing is
      // visible either.
      const shrunk = mapPolys(markup, /^arm-[lr]-(upper|fore)$/,
        (poly) => poly.map((p) => ({ x: cx + (p.x - cx) * 0.22, y: p.y })));
      const arms: string[] = [];
      const rest = shrunk.replace(/<path\b[^>]*?data-part="arm-[lr]-(?:upper|fore)"[^>]*?\/>/g,
        (el) => { arms.push(el); return ''; });
      return rest.replace('<path data-part="torso"', arms.join('') + '<path data-part="torso"');
    }
    case 'grip':
      // The trophy floats off the hand.
      return markup.replace(/(data-part="held-[a-z]+"[^>]*data-at=")([-\d.]+),([-\d.]+)"/g,
        (_m, head: string, x: string, y: string) => head + x + ',' + (Number(y) - H * 2.4) + '"');
    default:
      return markup;
  }
}

/**
 * Eight people, and they are chosen rather than sampled.
 *
 * The extremes of `build` and `height` are in because those two are the only
 * `PersonLook` fields the body reads, and a joint that meets on the average
 * body and misses on a heavy one is a bug nobody would find by looking at the
 * average.
 */
const BODIES: { id: string; look: PersonLook }[] = [
  { id: 'slight-short', look: { ...lookFromSeed(11, 'driver'), build: 0, height: 0 } },
  { id: 'slight-tall', look: { ...lookFromSeed(23, 'driver'), build: 0, height: 1 } },
  { id: 'heavy-short', look: { ...lookFromSeed(37, 'principal'), build: 1, height: 0 } },
  { id: 'heavy-tall', look: { ...lookFromSeed(53, 'principal'), build: 1, height: 1 } },
  { id: 'median', look: { ...lookFromSeed(71, 'driver'), build: 0.5, height: 0.5 } },
  { id: 'norris', look: lookFor('norris', 'driver') },
  { id: 'crew', look: lookFor('williams:crew:0', 'crew') },
  { id: 'principal', look: principalFor('ferrari').look },
];

const ALL_POSES: Pose[] = ['seated', 'standing', 'raised', 'folded', 'walking'];
const LEGACY_POSES: LegacyPose[] = ['seated', 'standing', 'raised'];

interface BodyUnderTest {
  shapes: Map<string, Shape>;
  torso?: Pt[];
  H: number;
  legs: boolean;
}

function bodyFor(look: PersonLook, pose: Pose): BodyUnderTest | undefined {
  const geo = headGeometry(look);
  const H = geo.h;
  const cx = geo.cx;
  if (LEGACY) {
    if (!LEGACY_POSES.includes(pose as LegacyPose)) return undefined;
    const markup = legacyBodyArt(look, {
      uid: 'lg', suit: '#1868db', accent: '#f2f3f5',
      pose: pose as LegacyPose, trophy: pose === 'raised' ? 'gold' : undefined,
    });
    return {
      shapes: parts(damage(markup, H, cx)),
      torso: legacyTorsoPolygon(look),
      H,
      // The shipped body had no legs in any pose. That is not a break; it is
      // the state of the art on `main`.
      legs: false,
    };
  }
  const art = figureArt(look, {
    uid: 'an', suit: '#1868db', accent: '#f2f3f5', team: '#1868db',
    pose, number: 27,
    trophy: pose === 'raised' ? 'gold' : undefined,
    champagne: pose === 'raised',
  });
  const shapes = parts(damage(art.markup + art.overlay, H, cx));
  return {
    shapes,
    torso: shapes.get('torso')?.poly,
    H,
    legs: pose !== 'seated',
  };
}

/** Names every pose must draw, plus the leg chain when it has legs. */
function required(legs: boolean): string[] {
  const base = ['torso', 'neck',
    'arm-l-upper', 'arm-l-fore', 'arm-r-upper', 'arm-r-fore', 'hand-l', 'hand-r'];
  return legs
    ? [...base, 'leg-l-thigh', 'leg-l-shin', 'leg-r-thigh', 'leg-r-shin', 'foot-l', 'foot-r']
    : base;
}

/**
 * The bars.
 *
 * Every one of them is a fraction of the part's OWN area, so none of them
 * moves when a person gets bigger. They are deliberately loose: the question is
 * not whether the elbow is beautifully placed, it is whether the two halves of
 * an arm are the same arm.
 */
const JOINED = 0.02;      // a joint shares at least 2% of the smaller part
const NOT_BURIED = 0.30;  // at least 30% of a limb is OUTSIDE the torso
const TAPER = 0.92;       // the narrow end is at most 92% of the wide end

let poseRows = 0;
const beforeBody = checks;

for (const pose of ALL_POSES) {
  for (const b of BODIES) {
    const body = bodyFor(b.look, pose);
    if (!body) continue;
    poseRows += 1;
    const where = `${pose}/${b.id}`;
    const S = body.shapes;
    const H = body.H;

    // 1. EVERY PART IS DRAWN. The shipped garage crew fail here on four names.
    for (const name of required(body.legs)) {
      const sh = S.get(name);
      ok(sh !== undefined, `${where}: draws ${name}`, 'no element carries that data-part');
      if (sh) {
        ok(!/NaN/.test(sh.raw), `${where}: ${name} has no NaN in it`);
        ok((sh.poly?.length ?? 0) >= 3 && area(sh.poly ?? []) > 0,
          `${where}: ${name} is a shape with area`,
          sh.attrs.fill === 'none'
            ? 'fill="none" - it is a STROKE, and a stroke has one width for its whole length'
            : 'no fillable outline');
      }
    }

    const torso = body.torso;
    if (!torso) continue;
    const torsoArea = area(torso);

    // 2. THE CHAINS. Shoulder to elbow to wrist, and hip to knee to ankle.
    //    Each link is two DRAWN shapes sharing area, which is the only
    //    definition of "attached" a drawing can be held to.
    const chains: [string, string][] = [
      ['arm-l-upper', 'arm-l-fore'], ['arm-l-fore', 'hand-l'],
      ['arm-r-upper', 'arm-r-fore'], ['arm-r-fore', 'hand-r'],
    ];
    if (body.legs) {
      chains.push(['leg-l-thigh', 'leg-l-shin'], ['leg-l-shin', 'foot-l'],
        ['leg-r-thigh', 'leg-r-shin'], ['leg-r-shin', 'foot-r']);
    }
    for (const [aName, bName] of chains) {
      const A = S.get(aName)?.poly;
      const B = S.get(bName)?.poly;
      if (!A || !B) {
        ok(false, `${where}: ${bName} is joined to ${aName}`, 'one of them is not drawn');
        continue;
      }
      const share = overlap(A, B);
      const small = Math.min(area(A), area(B));
      ok(share >= small * JOINED, `${where}: ${bName} is joined to ${aName}`,
        `they share ${(share / Math.max(1e-6, small) * 100).toFixed(1)}% of the smaller part`
        + ` (bar ${(JOINED * 100).toFixed(0)}%)`);
    }

    // 3. THE SHOULDER AND THE HIP, against the torso.
    const roots: [string, string][] = [
      ['arm-l-upper', 'shoulder'], ['arm-r-upper', 'shoulder'],
    ];
    if (body.legs) roots.push(['leg-l-thigh', 'hip'], ['leg-r-thigh', 'hip']);
    for (const [name, joint] of roots) {
      const sh = S.get(name);
      const A = sh?.poly;
      if (!A) {
        ok(false, `${where}: ${name} is attached at the ${joint}`, 'not drawn');
        continue;
      }
      const share = overlap(A, torso);
      ok(share >= area(A) * JOINED, `${where}: ${name} is attached at the ${joint}`,
        `${(share / Math.max(1e-6, area(A)) * 100).toFixed(1)}% shared with the torso`);
      const a = pt(sh?.attrs['data-a']);
      if (a) {
        ok(inside(a, torso), `${where}: ${name}'s ${joint} joint is inside the torso`,
          `${a.x.toFixed(1)},${a.y.toFixed(1)} is outside it`);
      }
    }

    // 4. NOT BURIED — the measurement that catches an armless torso.
    //
    //    An arm can be drawn, be correctly attached, and still be invisible.
    //    That is not a hypothetical: `standing` on the shipped body returned
    //    `{ behind: upper(-1) + upper(1), front: '' }`, so both upper arms
    //    were painted and then the torso was painted over them in the same
    //    suit colour. `desktop-garage.png` is four torsos with no arms.
    //
    //    So visibility is TWO things and it takes either. A limb painted AFTER
    //    the torso occludes it and is visible whatever it overlaps — folded
    //    arms genuinely lie across the chest. A limb painted BEFORE the torso
    //    is only visible in the part of it that sticks out.
    const torsoAt = S.get('torso')?.at ?? 0;
    for (const name of ['arm-l-upper', 'arm-l-fore', 'arm-r-upper', 'arm-r-fore']) {
      const sh = S.get(name);
      if (!sh?.poly) continue;
      const out = 1 - overlap(sh.poly, torso) / Math.max(1e-6, area(sh.poly));
      const inFront = sh.at > torsoAt;
      ok(inFront || out >= NOT_BURIED, `${where}: ${name} can be seen`,
        `painted BEFORE the torso and only ${(out * 100).toFixed(1)}% of it is outside it `
        + `(bar ${(NOT_BURIED * 100).toFixed(0)}%)`);
    }

    // 5. NOT A BARE RECTANGLE. A limb tapers; a stick does not. Measured
    //    ACROSS the drawn polygon at two stations on its own declared axis.
    const limbs = ['arm-l-upper', 'arm-l-fore', 'arm-r-upper', 'arm-r-fore',
      ...(body.legs ? ['leg-l-thigh', 'leg-l-shin', 'leg-r-thigh', 'leg-r-shin'] : [])];
    for (const name of limbs) {
      const sh = S.get(name);
      if (!sh) continue;
      ok(sh.attrs.fill !== undefined && sh.attrs.fill !== 'none',
        `${where}: ${name} is a filled shape, not a stroke`,
        `fill="${sh.attrs.fill ?? '(none set)'}" stroke-width="${sh.attrs['stroke-width'] ?? '-'}"`);
      const A = sh.poly;
      const a = pt(sh.attrs['data-a']);
      const bb = pt(sh.attrs['data-b']);
      if (!A || !a || !bb) continue;
      const w0 = widthAcross(A, a, bb, 0.15);
      const w1 = widthAcross(A, a, bb, 0.85);
      const ratio = Math.min(w0, w1) / Math.max(1e-6, Math.max(w0, w1));
      ok(ratio <= TAPER, `${where}: ${name} tapers`,
        `${w0.toFixed(1)} wide at the top, ${w1.toFixed(1)} at the bottom `
        + `(ratio ${ratio.toFixed(3)}, bar ${TAPER})`);
    }

    // 6. HANDS ARE HAND-SIZED. Against the head, which is the one thing on a
    //    figure a viewer has an absolute sense of the scale of.
    for (const name of ['hand-l', 'hand-r']) {
      const A = S.get(name)?.poly;
      if (!A) continue;
      const rel = area(A) / (H * H);
      ok(rel >= 0.03 && rel <= 0.40, `${where}: ${name} is hand-sized`,
        `${rel.toFixed(3)} of a head squared`);
    }

    // 7. WHAT THEY ARE HOLDING IS IN THE HAND.
    if (pose === 'raised') {
      const held: [string, string][] = LEGACY
        ? [['held-trophy', 'hand-l']]
        : [['held-trophy', 'hand-l'], ['held-bottle', 'hand-r']];
      for (const [obj, hand] of held) {
        const g = S.get(obj);
        const A = S.get(hand)?.poly;
        ok(g !== undefined && A !== undefined, `${where}: ${obj} is drawn in ${hand}`,
          g ? 'the hand is not drawn' : 'the object is not drawn');
        if (!g || !A) continue;
        const at = pt(g.attrs['data-at']);
        ok(at !== undefined && inside(at, A), `${where}: ${obj} is gripped BY ${hand}`,
          at ? `its grip is at ${at.x.toFixed(1)},${at.y.toFixed(1)}, outside the hand`
            : 'no grip declared');
        if (at && g.bbox) {
          // The object's own drawn body has to reach the grip, or it is a
          // picture of a trophy hovering above a fist.
          const box = g.bbox;
          const local = g.attrs.transform === undefined
            ? { x: at.x, y: at.y }
            : { x: 0, y: 0 };
          ok(box.x0 <= local.x + 2 && box.x1 >= local.x - 2
            && box.y0 <= local.y + 2 && box.y1 >= local.y - 2,
          `${where}: ${obj} is drawn AROUND the grip, not above it`,
          `its own extent is x ${box.x0.toFixed(1)}..${box.x1.toFixed(1)}, `
            + `y ${box.y0.toFixed(1)}..${box.y1.toFixed(1)} against a grip at `
            + `${local.x.toFixed(1)},${local.y.toFixed(1)}`);
        }
      }
    }

    // 8. THE FIGURE IS A FIGURE. Limbs have to be a real share of it, or a
    //    torso with two twigs on it passes everything above.
    let limbArea = 0;
    for (const name of limbs) limbArea += area(S.get(name)?.poly ?? []);
    ok(limbArea >= torsoArea * (body.legs ? 0.45 : 0.10),
      `${where}: the limbs are a real part of the body`,
      `limbs ${limbArea.toFixed(0)} against a torso of ${torsoArea.toFixed(0)}`);
  }
}
console.log(`  ${poseRows} figures, ${checks - beforeBody} checks`
  + (LEGACY ? '  --  PEOPLE_LEGACY: the body as it shipped at 5ac0a09' : '')
  + (BREAK ? `  --  PEOPLE_BREAK=${BREAK}` : ''));

section('The desk layer, and the poses the scenes ask for');

/**
 * A seated figure's hands go IN FRONT of the furniture.
 *
 * `figureArt` returns them separately for that reason, and the press room
 * paints them after the desk. If `overlay` ever comes back empty for a seated
 * figure, the hands are inside the desk again and the screen is back to what
 * `hud-out/people/desktop-presser.png` showed before #22: a panel of people
 * with no hands.
 */
for (const b of BODIES.slice(0, 4)) {
  const art = figureArt(b.look, {
    uid: 'ov', suit: '#1868db', accent: '#f2f3f5', team: '#1868db', pose: 'seated',
  });
  const over = parts(art.overlay);
  ok(over.has('hand-l') && over.has('hand-r'),
    `${b.id}: a seated figure's hands are in the layer drawn OVER the desk`);
  ok(over.has('arm-l-fore') && over.has('arm-r-fore'),
    `${b.id}: so are the forearms they are on`);
  const rig = buildRig(b.look, { pose: 'seated' });
  const hand = rig.hands[0];
  ok(hand.c.y < rig.deskY, `${b.id}: the hands rest ON the desk, not under it`,
    `hand at y=${hand.c.y.toFixed(1)}, desk at ${rig.deskY.toFixed(1)}`);
  ok(rig.deskY - hand.c.y < headGeometry(b.look).h * 0.30,
    `${b.id}: and they are ON it rather than floating above it`,
    `${(rig.deskY - hand.c.y).toFixed(1)} above the desk`);
}

// The scenes have to ask for a pose that has arms in it, and they have to draw
// the layer the figure hands back. Both are text checks for the same reason the
// 'cast is WIRED IN' section is: what is guarded against is somebody quietly
// putting an import or an argument back.
const pressSrc = readFileSync(join(SRC_DIR, 'ui', 'PressConference.ts'), 'utf8');
ok(/art\.overlay/.test(pressSrc),
  'the press room paints the figure layer that goes over the desk');
ok(pressSrc.indexOf('+ onDesk') > pressSrc.indexOf('url(#pc-desk)'),
  'and it paints it AFTER the desk, not before');
ok(/art\.rig\.deskY/.test(pressSrc),
  'the press room puts the desk where each figure says its desk is');

const podSrc = readFileSync(join(SRC_DIR, 'ui', 'Podium.ts'), 'utf8');
ok(/pose:\s*'raised'/.test(podSrc), 'the podium draws the raised pose');
ok(/trophy:/.test(podSrc), 'and puts a trophy in the hand');

const garSrc = readFileSync(join(SRC_DIR, 'ui', 'GarageScene.ts'), 'utf8');
ok(/art\.rig\.floorY/.test(garSrc),
  'the garage stands its people on the floor by their own rig, not by a constant');
ok(!/FIGURE_SPAN/.test(garSrc),
  'and the fixed 560-unit figure box it used to place them by is gone');

// ===========================================================================

console.log('\n' + '='.repeat(56));
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
