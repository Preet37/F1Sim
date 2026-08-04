/**
 * Pulls real assets from the open-licensed web instead of rebuilding them.
 *
 * WHY THIS EXISTS. The user's instruction, verbatim:
 *
 *   "use all the resources in the world to help you like i shared in a previous
 *    prompt there was a bunch of online resources and githubs and asset places
 *    and files online as well. make your life easier by not redoing what
 *    already exists and just pulling information from everywhere."
 *
 * They are right, and the parts of the reference set that are *materials and
 * lighting* are exactly the parts that should never be authored by hand. A
 * hand-tuned asphalt shader will never look like photographed asphalt, and
 * `PROJECT.md` §6 already records what one wrong material number costs: painted
 * bodywork at metalness 0.26 — a physically impossible half-metal — was the
 * whole of the "blown out white plastic" look, and global exposure was never
 * the problem.
 *
 * THE LICENCE RULE, AND WHY IT IS NARROW. The user's stated end goal is a
 * publishable game (§1). §3 permits assets from online but only "permissively
 * licensed ones — CC0, public domain, or explicitly licensed for this use.
 * Record the licence and source of anything added."
 *
 * So this file only knows about sources that are CC0 or OFL — no attribution
 * required, no share-alike, no migration cost at release. Everything fetched
 * here can ship. Sources that are merely *free to download* (community
 * liveries carrying real sponsor marks, track meshes ripped from other games,
 * broadcast audio) are deliberately NOT here: they are fine on the user's own
 * machine while testing and they cannot ship, and mixing the two categories in
 * one pipeline is how the unshippable one ends up committed by accident.
 *
 * Output goes to `public/assets/`, which is gitignored for the same reason
 * `public/brand/` is (issue #36): the repository stays clean and shippable, and
 * a fresh clone regenerates by running this.
 *
 *   npx tsx scripts/fetchAssets.ts            # everything in the manifest
 *   npx tsx scripts/fetchAssets.ts hdri        # one group
 *   npx tsx scripts/fetchAssets.ts --list      # what is available, unfetched
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'public', 'assets');

interface Asset {
  /** Group, and the directory under `public/assets/`. */
  group: 'hdri' | 'materials' | 'fonts';
  /** Directory name for this asset. */
  id: string;
  /** Human name, for the licence record. */
  name: string;
  source: string;
  licence: 'CC0-1.0' | 'OFL-1.1';
  url: string;
  /** A zip that needs unpacking, and which members to keep. */
  zip?: { keep: RegExp };
  /** Where this is meant to be used, so a reader knows why it was fetched. */
  purpose: string;
}

/**
 * THE MANIFEST.
 *
 * Both URL patterns below were verified live before this file was written —
 * Poly Haven returned 5.4MB of Radiance HDR and ambientCG returned a 36MB zip.
 * They are stable, documented, public endpoints, not scraped ones.
 */
const MANIFEST: Asset[] = [
  // ---------------------------------------------------------------- lighting
  //
  // The single highest-value thing on this list. An image-based environment is
  // what makes carbon fibre read as carbon fibre and paint read as paint,
  // because a PBR material is only as good as what it has to reflect. Right now
  // the scene lights from analytic lights alone, which is why metal and clear
  // coat look flat against the reference frames in `reference/target/`.
  {
    group: 'hdri', id: 'partly_cloudy', name: 'Kloofendal 48d Partly Cloudy (Pure Sky)',
    source: 'https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky', licence: 'CC0-1.0',
    url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
    purpose: 'Daylight environment. Matches the overcast key in reference/target/76.png.',
  },
  {
    group: 'hdri', id: 'overcast', name: 'Kloppenheim 02 (Pure Sky)',
    source: 'https://polyhaven.com/a/kloppenheim_02_puresky', licence: 'CC0-1.0',
    url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloppenheim_02_puresky_2k.hdr',
    purpose: 'Flat overcast, the broadcast default.',
  },
  {
    group: 'hdri', id: 'night', name: 'Dikhololo Night',
    source: 'https://polyhaven.com/a/dikhololo_night', licence: 'CC0-1.0',
    url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/dikhololo_night_2k.hdr',
    purpose: 'Night races. reference/target/90.png is Bahrain under floodlights.',
  },
  {
    group: 'hdri', id: 'sunset', name: 'Venice Sunset',
    source: 'https://polyhaven.com/a/venice_sunset', licence: 'CC0-1.0',
    url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/venice_sunset_2k.hdr',
    purpose: 'Late-afternoon sessions.',
  },

  // --------------------------------------------------------------- materials
  //
  // Only the five maps three.js actually binds are kept: map, normalMap,
  // roughnessMap, aoMap, displacementMap. ambientCG ships ~15 files per asset
  // including .blend and .usdc, and NormalDX as well as NormalGL — three.js
  // wants GL (green up). Keeping the lot would put ~70MB per material on disk
  // for no benefit.
  {
    group: 'materials', id: 'asphalt', name: 'Asphalt033',
    source: 'https://ambientcg.com/a/Asphalt033', licence: 'CC0-1.0',
    url: 'https://ambientcg.com/get?file=Asphalt033_2K-JPG.zip',
    zip: { keep: /_(Color|NormalGL|Roughness|AmbientOcclusion|Displacement)\.(jpg|png)$/i },
    purpose: 'The racing surface. Issue #48 — the near-field reads as static.',
  },
  {
    group: 'materials', id: 'concrete', name: 'Concrete034',
    source: 'https://ambientcg.com/a/Concrete034', licence: 'CC0-1.0',
    url: 'https://ambientcg.com/get?file=Concrete034_2K-JPG.zip',
    zip: { keep: /_(Color|NormalGL|Roughness|AmbientOcclusion)\.(jpg|png)$/i },
    purpose: 'Run-off, pit lane, barrier bases, grandstand structure.',
  },
  {
    group: 'materials', id: 'carbon', name: 'Fabric063 (carbon weave)',
    source: 'https://ambientcg.com/a/Fabric063', licence: 'CC0-1.0',
    url: 'https://ambientcg.com/get?file=Fabric063_2K-JPG.zip',
    zip: { keep: /_(Color|NormalGL|Roughness)\.(jpg|png)$/i },
    purpose: 'Carbon bodywork weave under clear coat. §6 records 1.35m2 of '
      + 'near-black carbon reading as heavy on the front wing (#8).',
  },
  {
    group: 'materials', id: 'grass', name: 'Grass004',
    source: 'https://ambientcg.com/a/Grass004', licence: 'CC0-1.0',
    url: 'https://ambientcg.com/get?file=Grass004_2K-JPG.zip',
    zip: { keep: /_(Color|NormalGL|Roughness)\.(jpg|png)$/i },
    purpose: 'Verges and infield.',
  },
  {
    group: 'materials', id: 'gravel', name: 'Gravel023',
    source: 'https://ambientcg.com/a/Gravel023', licence: 'CC0-1.0',
    url: 'https://ambientcg.com/get?file=Gravel023_2K-JPG.zip',
    zip: { keep: /_(Color|NormalGL|Roughness)\.(jpg|png)$/i },
    purpose: 'Gravel traps. The player spends real time in these (#26).',
  },

  // ------------------------------------------------------------------- fonts
  //
  // Formula 1's own typeface is proprietary and is NOT fetched here. Titillium
  // Web is the closest open face and is what most F1 fan projects use; it is
  // OFL, so it ships. Naming a team is different from reproducing its
  // trademark, and the same reasoning applies to type.
  {
    group: 'fonts', id: 'titillium', name: 'Titillium Web',
    source: 'https://fonts.google.com/specimen/Titillium+Web', licence: 'OFL-1.1',
    url: 'https://github.com/google/fonts/raw/main/ofl/titilliumweb/TitilliumWeb-Regular.ttf',
    purpose: 'Timing tower and HUD. Nearest open face to the broadcast board '
      + 'in reference/target/68.png. NOT the F1 typeface.',
  },
  {
    group: 'fonts', id: 'titillium-bold', name: 'Titillium Web Bold',
    source: 'https://fonts.google.com/specimen/Titillium+Web', licence: 'OFL-1.1',
    url: 'https://github.com/google/fonts/raw/main/ofl/titilliumweb/TitilliumWeb-Bold.ttf',
    purpose: 'Driver codes and positions on the timing tower.',
  },
];

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function fetchTo(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return (await stat(dest)).size;
}

async function fetchAsset(a: Asset): Promise<{ bytes: number; files: number }> {
  const dir = join(OUT, a.group, a.id);

  if (!a.zip) {
    const ext = a.url.slice(a.url.lastIndexOf('.'));
    const bytes = await fetchTo(a.url, join(dir, a.id + ext));
    return { bytes, files: 1 };
  }

  // Unpack, keep only what three.js binds, drop the rest.
  const tmp = join(OUT, '.tmp', a.id);
  await mkdir(tmp, { recursive: true });
  const zip = join(tmp, 'a.zip');
  await fetchTo(a.url, zip);
  await run('unzip', ['-o', '-q', zip, '-d', tmp]);

  await mkdir(dir, { recursive: true });
  let bytes = 0, files = 0;
  for (const f of await readdir(tmp)) {
    if (!a.zip.keep.test(f)) continue;
    const src = join(tmp, f);
    await run('cp', [src, join(dir, f)]);
    bytes += (await stat(join(dir, f))).size;
    files += 1;
  }
  await rm(join(OUT, '.tmp'), { recursive: true, force: true });
  if (files === 0) throw new Error(`${a.id}: zip contained nothing matching ${a.zip.keep}`);
  return { bytes, files };
}

/**
 * The licence record §3 asks for, regenerated from the manifest so it cannot
 * drift from what is actually on disk.
 */
async function writeLicences(fetched: Asset[]): Promise<void> {
  const rows = fetched.map((a) =>
    `| \`${a.group}/${a.id}\` | ${a.name} | ${a.licence} | ${a.source} |`).join('\n');
  await writeFile(join(OUT, 'LICENSES.md'),
    `# Fetched assets\n\n`
    + `Generated by \`scripts/fetchAssets.ts\`. Every entry is CC0 or OFL: no attribution\n`
    + `required, no share-alike, nothing to renegotiate before release.\n\n`
    + `This directory is gitignored. Re-fetch with \`npx tsx scripts/fetchAssets.ts\`.\n\n`
    + `| path | asset | licence | source |\n|---|---|---|---|\n${rows}\n`);
}

const args = process.argv.slice(2);

if (args.includes('--list')) {
  for (const a of MANIFEST) {
    console.log(`  ${a.group}/${a.id.padEnd(16)} ${a.licence.padEnd(9)} ${a.purpose}`);
  }
  process.exit(0);
}

const groups = args.filter((s) => !s.startsWith('-'));
const wanted = groups.length ? MANIFEST.filter((a) => groups.includes(a.group)) : MANIFEST;

console.log(`\nFetching ${wanted.length} assets into public/assets/\n`);

let ok = 0, failed = 0, total = 0;
const done: Asset[] = [];

for (const a of wanted) {
  const dir = join(OUT, a.group, a.id);
  if (await exists(dir) && (await readdir(dir)).length > 0) {
    console.log(`  skip  ${a.group}/${a.id} — already present`);
    done.push(a); ok += 1;
    continue;
  }
  try {
    const { bytes, files } = await fetchAsset(a);
    total += bytes;
    console.log(`  ok    ${a.group}/${a.id.padEnd(16)} ${files} file(s), ${(bytes / 1e6).toFixed(1)} MB  [${a.licence}]`);
    done.push(a); ok += 1;
  } catch (e) {
    console.error(`  FAIL  ${a.group}/${a.id} — ${(e as Error).message}`);
    failed += 1;
  }
}

if (done.length) await writeLicences(done);

console.log(`\n${ok} ok, ${failed} failed, ${(total / 1e6).toFixed(1)} MB fetched this run.`);
console.log(`Licences recorded in public/assets/LICENSES.md\n`);
if (failed) process.exitCode = 1;
