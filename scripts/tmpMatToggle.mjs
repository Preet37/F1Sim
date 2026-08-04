// Scratch: flips the four material corrections between their pre-#36 values and
// the corrected ones, so `audit:car` can be run on both without a second
// checkout. Deleted before the PR.
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2]; // 'before' | 'after'
const swaps = [
  ['src/render/TyreTexture.ts',
    "rimFace: { colour: '#232529', rough: 0.62, metal: 0.02 }",
    "rimFace: { colour: '#232529', rough: 0.62, metal: 0.10 }"],
  ['src/render/TyreTexture.ts',
    "rimSpoke: { colour: '#3c4149', rough: 0.44, metal: 0.02 }",
    "rimSpoke: { colour: '#3c4149', rough: 0.44, metal: 0.25 }"],
  ['src/render/TyreTexture.ts',
    "rimLip: { colour: '#b9bec4', rough: 0.42, metal: 1.0 }",
    "rimLip: { colour: '#6e747c', rough: 0.42, metal: 0.40 }"],
  ['src/render/TyreTexture.ts',
    "hub: { colour: '#b0b4b8', rough: 0.34, metal: 1.0 }",
    "hub: { colour: '#4a4f57', rough: 0.34, metal: 0.60 }"],
  ['src/render/TyreTexture.ts',
    "disc: { colour: '#2e2b28', rough: 0.72, metal: 0.02 }",
    "disc: { colour: '#2e2b28', rough: 0.72, metal: 0.05 }"],
  ['src/render/TyreTexture.ts',
    "discFace: { colour: '#3a3632', rough: 0.66, metal: 0.02 }",
    "discFace: { colour: '#3a3632', rough: 0.66, metal: 0.05 }"],
  ['src/render/TyreTexture.ts',
    "caliper: { colour: '#9d7c46', rough: 0.45, metal: 1.0 }",
    "caliper: { colour: '#57402c', rough: 0.45, metal: 0.55 }"],
  ['src/render/TyreTexture.ts',
    "inner: { colour: '#101216', rough: 0.80, metal: 0.02 }",
    "inner: { colour: '#101216', rough: 0.80, metal: 0.10 }"],
  ['src/render/Livery.ts', 'trim: [0.42, 0.02]', 'trim: [0.42, 0.10]'],
  ['src/render/Livery.ts', "'rgb(0,84,5)'", "'rgb(0,84,13)'"],
  ['src/render/CockpitMesh.ts',
    'color: accentColour, metalness: 0.02, roughness: 0.5',
    'color: accentColour, metalness: 0.2, roughness: 0.5'],
];

let n = 0;
for (const [file, after, before] of swaps) {
  const from = dir === 'before' ? after : before;
  const to = dir === 'before' ? before : after;
  const s = readFileSync(file, 'utf8');
  if (!s.includes(from)) { console.log(`MISS ${file}: ${from}`); continue; }
  writeFileSync(file, s.split(from).join(to));
  n++;
}
console.log(`${dir}: ${n}/${swaps.length} applied`);
