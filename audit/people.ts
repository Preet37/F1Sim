import '../src/ui/career.css';
import '../src/ui/people/people.css';
import { faceSvg, type FaceOptions } from '../src/ui/people/Face';
import {
  COMPLEXIONS, HAIR_PIGMENTS, HAIR_STYLES, FACIAL_HAIR, EYEWEAR, HEADWEAR,
  look, lookFromSeed, type PersonLook,
} from '../src/ui/people/Look';

/**
 * Every person this game can draw, on one wall.
 *
 * The same argument `audit/career.ts` makes: a drawing cannot be verified by an
 * assertion. `probe:people` can prove that no two principals share a
 * silhouette; only a photograph can say whether either of them looks like a
 * person. So this is the design loop — move a control point, run
 * `npm run shoot:people`, look at eleven faces at once rather than at one.
 *
 * The contact sheet is deliberately unkind: every hair style on the same head,
 * every complexion on the same face, and the whole grid at 40 pixels, which is
 * where a drawing that only works at 300 falls apart.
 */

const app = document.getElementById('app') as HTMLElement;

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function cell(parent: HTMLElement, node: Node, caption: string): void {
  const c = el('div', 'audit-cell', parent);
  c.appendChild(node);
  el('div', 'audit-cap', c, caption);
}

/** One head, varied along a single axis, so the axis is what is being judged. */
function axis(
  title: string, note: string, items: readonly string[],
  make: (v: string, i: number) => PersonLook, extra: Partial<FaceOptions> = {},
): void {
  el('div', 'audit-label', app, title);
  if (note) el('div', 'audit-sub', app, note);
  const row = el('div', 'audit-row', app);
  for (const [i, v] of items.entries()) {
    cell(row, faceSvg(make(v, i), {
      size: 130, crop: 'head', uid: title.replace(/\W/g, '') + i, ...extra,
    }), v);
  }
}

/** The base head every axis varies from: unremarkable on purpose. */
const BASE: PersonLook = {
  ...lookFromSeed(7, 'principal'),
  complexion: 's3', hairPigment: 'brown', hair: 'crop', facialHair: 'none',
  eyewear: 'none', headwear: 'none', build: 0.5, height: 0.5,
  headWidth: 0.5, faceLength: 0.5, jaw: 0.5, chin: 0.5, brow: 0.45,
  eyeLine: 0.5, eyeSpacing: 0.5, nose: 0.5, noseWidth: 0.5, mouth: 0.5,
  lips: 0.5, cheek: 0.5, turn: 0.3, age: 0.35,
};

function sheet(): void {
  app.innerHTML = '';
  app.className = 'audit-sheet';
  const head = el('div', 'audit-head', app);
  el('div', 'audit-title', head, 'The cast');
  el('div', 'audit-sub', head,
    'One head, moved along one axis at a time. Key warm, above and left, as everywhere.');

  axis('Hair', 'The first thing that tells two people apart, and the widest axis in the model.',
    HAIR_STYLES, (v) => ({ ...BASE, hair: v as PersonLook['hair'] }));

  axis('Complexion', 'Three stops each: the lit plane, the material, the turned plane.',
    COMPLEXIONS.map((c) => c.id), (v) => ({ ...BASE, complexion: v }));

  axis('Hair colour', 'Grey is its own pigment, not a desaturation.',
    HAIR_PIGMENTS.map((h) => h.id), (v) => ({ ...BASE, hairPigment: v, hair: 'volume' }));

  axis('Beards', '', FACIAL_HAIR, (v) => ({ ...BASE, facialHair: v as PersonLook['facialHair'] }));

  axis('Glasses', 'The highest-value accessory in the set: hard, dark, and it survives 24 pixels.',
    EYEWEAR, (v) => ({ ...BASE, eyewear: v as PersonLook['eyewear'] }));

  axis('Headwear', 'The cap carries the team colour, so it does identity work as well as shape.',
    HEADWEAR, (v) => ({ ...BASE, headwear: v as PersonLook['headwear'] }),
    { team: '#ff7a1a', accent: '#111f4a' });

  axis('Turn', 'Features slide; the outline does not move. The far ear goes at 0.55.',
    ['-0.9', '-0.5', '-0.2', '0.2', '0.5', '0.9'],
    (v) => ({ ...BASE, turn: Number(v) }));

  axis('Age', 'Fold, under-eye line, heavier lid, and the hair greys independently.',
    ['0', '0.2', '0.4', '0.6', '0.8', '1'], (v) => ({ ...BASE, age: Number(v) }));

  axis('Jaw', 'Worth more than every facial feature put together.',
    ['0', '0.25', '0.5', '0.75', '1'], (v) => ({ ...BASE, jaw: Number(v) }));

  axis('Face length', 'The chin is anchored; the skull grows upward from it.',
    ['0', '0.35', '0.7', '1'], (v) => ({ ...BASE, faceLength: Number(v) }));

  axis('Brow', 'Overhang and brow weight together. High reads as heavy, and as older.',
    ['0', '0.35', '0.7', '1'], (v) => ({ ...BASE, brow: Number(v) }));

  // --- Busts, in team kit ---------------------------------------------------
  el('div', 'audit-label', app, 'Busts — in the team shirt');
  const row = el('div', 'audit-row', app);
  const kits: [string, string, string][] = [
    ['#ff7a1a', '#0d1218', 'Papaya'],
    ['#e11d2e', '#f2f3f5', 'Signal'],
    ['#11b3b3', '#14171c', 'Teal'],
    ['#111f4a', '#ffc61a', 'Midnight'],
    ['#0f7a45', '#f2f3f5', 'Green'],
    ['#59636f', '#ff7a1a', 'Gunmetal'],
  ];
  for (const [i, [suit, accent, name]] of kits.entries()) {
    cell(row, faceSvg(look('kit-' + i, 'principal'), {
      size: 170, crop: 'bust', suit, accent, team: suit, uid: 'kit' + i,
    }), name);
  }

  // --- Twenty strangers -----------------------------------------------------
  el('div', 'audit-label', app, 'Twenty from the hash');
  el('div', 'audit-sub', app,
    'Nobody authored these. If two of them are the same person, the model is too narrow.');
  const row2 = el('div', 'audit-row', app);
  for (let i = 0; i < 20; i++) {
    cell(row2, faceSvg(lookFromSeed(1000 + i * 977, 'journalist'), {
      size: 110, uid: 'st' + i,
    }), '');
  }

  // --- At row size ----------------------------------------------------------
  el('div', 'audit-label', app, 'At 40 pixels');
  el('div', 'audit-sub', app, 'Where a drawing that only works at 300 falls apart.');
  const row3 = el('div', 'audit-row tight', app);
  for (let i = 0; i < 22; i++) {
    cell(row3, faceSvg(lookFromSeed(1000 + i * 977, 'journalist'), {
      size: 40, uid: 'sm' + i,
    }), '');
  }
}

declare global {
  interface Window { __people: { show(name: string): boolean } }
}

const SCENES: Record<string, () => void> = { sheet };

window.__people = {
  show(name: string): boolean {
    const fn = SCENES[name];
    if (!fn) return false;
    fn();
    return true;
  },
};
sheet();
