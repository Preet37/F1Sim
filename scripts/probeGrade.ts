import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodePng, encodePng, crop, resize, type Raster } from './lib/png';
import { lookStats, grainBands, fmtStats, type LookStats } from './lib/imageStats';

/**
 * THE IN-RACE PICTURE, MEASURED AGAINST THE REFERENCE FRAMES. Issue #78.
 *
 * The user's instruction, recorded in `reference/target/INDEX.md`:
 *
 *   "every image that I attached, i want that to that quality, the way that is,
 *    the way it looks, everything that I showed you and shared with you I want
 *    you to do it that way."
 *
 * and PROJECT.md section 2: reference images are specifications, not
 * inspiration. This probe is what turns that from a matter of opinion into a
 * matter of arithmetic.
 *
 * WHAT IT DOES NOT DO, SAID FIRST SO NOBODY MISREADS THE OUTPUT. It does not
 * measure resemblance. Two frames of different circuits from different games
 * will never correlate pixel to pixel and any number claiming they do would be
 * a number about framing. What it measures is the four properties that
 * constitute "the look" independent of what is in shot — where the mid tone
 * sits, how far the tones spread, how saturated they are, and which way the
 * white balance leans — over a stated region of each frame. A frame that
 * matches on all four still might not look like the reference; a frame that
 * misses on them certainly does not.
 *
 * EVERY BAR IS THE REFERENCE FRAME ITSELF, plus a tolerance. Nothing here is
 * derived from what our renderer happens to produce — see `TOL` for what the
 * first version of that got wrong and how it was caught. For the record, the
 * specification measures:
 *
 *   76 WORLD  p50  81  rms 57.1  sat 0.253  warm -17.0
 *   90 ROAD   p50 107  rms 48.8  sat 0.126  warm  +6.4
 *   90 SKY    p50 106  rms 30.6  sat 0.060  warm  +3.0
 *   71 WORLD  p50  89  rms 51.7  sat 0.146  warm  +1.1
 *
 * Usage:
 *   npm run probe:grade                    # judge sharp-out/after
 *   GRADE_TAG=before npm run probe:grade   # judge a different shoot
 *   GRADE_REF=1 npm run probe:grade        # measure the reference set alone
 */

const TAG = process.env.GRADE_TAG ?? 'after';
const SHOT_DIR = resolve(process.cwd(), 'sharp-out', TAG);
const REF_DIR = resolve(process.cwd(), 'reference', 'target');
const OUT_DIR = resolve(process.cwd(), 'grade-out');

/** A fractional window of a frame: x0, y0, x1, y1 in 0..1. */
type Window = [number, number, number, number];

interface Pair {
  name: string;
  /** Prefix of the shot filename in `sharp-out/<tag>`, before the scale suffix. */
  shot: string;
  reference: string;
  /**
   * The region of each frame the comparison is made over, as a fraction of the
   * frame. Two windows, because the reference frames are grabs at whatever
   * aspect their game ran at and ours are 1600x1000 browser screenshots, so the
   * same fractional box does not select the same content in both. Each is
   * chosen to select the SAME THING — see `why`.
   */
  ourWindow: Window;
  refWindow: Window;
  why: string;
}

/**
 * The four comparisons. Each names a reference frame from `INDEX.md` and the
 * shot from `probe:sharpness` taken under the conditions closest to it.
 *
 * `probe:sharpness` is the harness rather than `audit:circuits`, and PROJECT.md
 * section 6 is why: the audit drives the renderer at a hard-coded dt of 1/60, so
 * the dynamic resolution scaler never moves and every PNG it has ever produced
 * was shot at full resolution — "the harness was photographing an image no
 * player had ever seen". These shots are the browser's own screenshot of the
 * composited page at whatever scale the real scaler settled on, upscale
 * included.
 */
const PAIRS: Pair[] = [
  {
    name: 'zandvoort day / 76.png',
    shot: 'zandvoort-cockpit',
    reference: '76.png',
    // Above the bodywork, below the top banner, right of the timing tower. In
    // both frames this band is sky, grandstand, barrier and road — the whole
    // in-race picture with none of the HUD and none of the car we are sitting
    // in.
    ourWindow: [0.195, 0.118, 1.0, 0.597],
    refWindow: [0.195, 0.118, 1.0, 0.597],
    why: 'world band above the halo: sky, stands, barriers, asphalt',
  },
  {
    name: 'bahrain night ROAD / 90.png',
    shot: 'bahrain-chase',
    reference: '90.png',
    ourWindow: [0.0, 0.50, 1.0, 0.86],
    refWindow: [0.0, 0.45, 0.60, 0.80],
    why: 'the floodlit asphalt itself — the surface the night look lives on',
  },
  {
    name: 'bahrain night SKY / 90.png',
    shot: 'bahrain-chase',
    reference: '90.png',
    ourWindow: [0.0, 0.02, 1.0, 0.40],
    refWindow: [0.0, 0.02, 1.0, 0.42],
    why: 'sky, floodlight masts and grandstands above the horizon',
  },
  {
    name: 'monza day / 71.png (the floor)',
    shot: 'monza-cockpit',
    reference: '71.png',
    ourWindow: [0.15, 0.12, 0.99, 0.55],
    refWindow: [0.15, 0.12, 0.99, 0.55],
    why: 'the 2005 game the user calls the floor, not the ceiling',
  },
];

/**
 * The bars: how far each number may sit from THE REFERENCE FRAME FOR THAT PAIR.
 *
 * THE FIRST VERSION OF THIS WAS AN ABSOLUTE RANGE PER METRIC AND IT WAS WRONG,
 * which is worth recording rather than quietly replacing. Those ranges were
 * derived from four world-and-road crops — saturation 0.10..0.32, median
 * 70..125 — and then applied unchanged to a fifth region of a different kind,
 * the night SKY. A night sky is nearly colourless: `90.png`'s measures 0.060,
 * so **the specification failed the bar taken from it**. A bar the reference
 * itself cannot pass is not measuring the thing it claims to.
 *
 * Per-pair tolerances fix that and are also simply the right shape for the
 * task, which is "copy this frame", not "land inside a range". They are
 * TIGHTER than the absolute ranges almost everywhere: the old median bar
 * allowed 55 code values of drift at Zandvoort and this allows 25.
 *
 * DO NOT WIDEN THESE TO MAKE A RUN PASS. PROJECT.md section 3.3: two agents
 * have been sent back for exactly that and both times the investigation found
 * something real. Widening the metric definition because the SPECIFICATION
 * failed it, as above, is a different act from widening it because our output
 * did — and the test of which one is happening is whether the reference passes
 * afterwards. It does: `GRADE_REF=1` reports every pair at zero error by
 * construction.
 */
const TOL = {
  /** Median luma, code values. 25 of 255 is a little under a tenth of range. */
  p50: 25,
  /** RMS contrast, code values. */
  rms: 10,
  /** Mean HSV saturation. */
  sat: 0.06,
  /** mean(R) - mean(B), code values. */
  warmth: 12,
};

function findShot(prefix: string): string | null {
  if (!existsSync(SHOT_DIR)) return null;
  const hit = readdirSync(SHOT_DIR)
    .filter((f) => f.startsWith(`${prefix}-s`) && f.endsWith('.png'))
    .sort();
  return hit.length ? resolve(SHOT_DIR, hit[hit.length - 1]) : null;
}

function windowOf(img: Raster, w: Window): Raster {
  return crop(img, w[0] * img.width, w[1] * img.height,
    (w[2] - w[0]) * img.width, (w[3] - w[1]) * img.height);
}

/**
 * Reference and result at the SAME SCALE, one above the other, for the PR.
 *
 * PROJECT.md section 3.1 and `INDEX.md` step 3 both ask for this specifically:
 * a comparison a reader can check beats a sentence claiming a resemblance.
 * Both panels are resampled to one common width so that "same scale" is true
 * rather than asserted.
 */
async function writeSideBySide(name: string, ours: Raster, ref: Raster): Promise<void> {
  const W = 1100;
  const GAP = 8;
  const a = resize(ref, W, Math.round((ref.height / ref.width) * W));
  const b = resize(ours, W, Math.round((ours.height / ours.width) * W));
  const H = a.height + GAP + b.height;
  const out = new Uint8Array(W * H * 3);
  out.fill(24);
  out.set(a.rgb, 0);
  out.set(b.rgb, (a.height + GAP) * W * 3);
  const file = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  await writeFile(resolve(OUT_DIR, file), encodePng({ width: W, height: H, rgb: out }));
}

function checkNear(
  label: string,
  r: [boolean, string],
  results: { ok: boolean; line: string }[],
): void {
  results.push({ ok: r[0], line: `${r[0] ? 'ok  ' : 'FAIL'}  ${label} — ${r[1]}` });
}


/**
 * OUR OWN before against our own after, same crop, same scale, one file.
 *
 * `GRADE_AB=before,after2 npm run probe:grade`
 *
 * This exists because of where the comparison has to be READ. The full
 * reference-against-result panels this probe also writes have a frame from a
 * commercial F1 game as their top half, and `Preet37/F1Sim` is a public
 * repository — `reference/` is gitignored for that reason as much as for its
 * size (PROJECT.md §9), and committing the panels into the repo to embed them
 * in a pull request would walk straight through that boundary for the sake of
 * a picture. The user's stated goal is a publishable game and §3 is built
 * around keeping the IP surface swappable, so this writes the half that is
 * unambiguously ours and can be published, and the reference comparison stays
 * a one-command regeneration on a machine that has the frames.
 */
async function writeBeforeAfter(): Promise<void> {
  const [beforeTag, afterTag] = (process.env.GRADE_AB ?? '').split(',').map((s) => s.trim());
  const dirOf = (t: string): string => resolve(process.cwd(), 'sharp-out', t);
  const pick = (dir: string, prefix: string): string | null => {
    if (!existsSync(dir)) return null;
    const hit = readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix}-s`) && f.endsWith('.png')).sort();
    return hit.length ? resolve(dir, hit[hit.length - 1]) : null;
  };

  console.log(`OUR OWN FRAME, ${beforeTag} above ${afterTag}, same crop and scale\n`);
  for (const p of PAIRS) {
    const a = pick(dirOf(beforeTag), p.shot);
    const b = pick(dirOf(afterTag), p.shot);
    if (!a || !b) {
      console.log(`  ${p.name}: SKIPPED — need ${p.shot} in both shoots`);
      continue;
    }
    const wasImg = windowOf(decodePng(a), p.ourWindow);
    const nowImg = windowOf(decodePng(b), p.ourWindow);
    const was = lookStats(wasImg);
    const now = lookStats(nowImg);
    console.log(`  ${p.name}`);
    console.log(`      ${beforeTag.padEnd(8)} ${fmtStats(was)}`);
    console.log(`      ${afterTag.padEnd(8)} ${fmtStats(now)}`);
    const W = 1100;
    const GAP = 8;
    const t = resize(wasImg, W, Math.round((wasImg.height / wasImg.width) * W));
    const u = resize(nowImg, W, Math.round((nowImg.height / nowImg.width) * W));
    const H = t.height + GAP + u.height;
    const out = new Uint8Array(W * H * 3);
    out.fill(24);
    out.set(t.rgb, 0);
    out.set(u.rgb, (t.height + GAP) * W * 3);
    // Named for the PAIR, not the shot: two pairs share the `bahrain-chase`
    // frame and differ only in which band of it they read.
    const file = `ab-${p.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    await writeFile(resolve(OUT_DIR, file), encodePng({ width: W, height: H, rgb: out }));
    console.log(`      -> ${file}\n`);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  if (process.env.GRADE_AB) {
    await writeBeforeAfter();
    return;
  }

  if (process.env.GRADE_REF === '1') {
    console.log('THE REFERENCE SET, measured. These are where the bars come from.\n');
    for (const p of PAIRS) {
      const ref = windowOf(decodePng(resolve(REF_DIR, p.reference)), p.refWindow);
      console.log(`  ${p.reference.padEnd(8)} ${fmtStats(lookStats(ref))}`);
      console.log(`           ${p.why}`);
    }
    return;
  }

  console.log(`THE IN-RACE PICTURE vs reference/target/  —  shots: sharp-out/${TAG}\n`);
  const results: { ok: boolean; line: string }[] = [];
  let compared = 0;

  for (const p of PAIRS) {
    const shotPath = findShot(p.shot);
    const refPath = resolve(REF_DIR, p.reference);
    if (!shotPath) {
      console.log(`  ${p.name}\n      SKIPPED — no ${p.shot}-s*.png in sharp-out/${TAG}\n`);
      continue;
    }
    if (!existsSync(refPath)) {
      console.log(`  ${p.name}\n      SKIPPED — reference/ is gitignored and ${p.reference} is absent\n`);
      continue;
    }
    compared++;

    const ours = windowOf(decodePng(shotPath), p.ourWindow);
    const ref = windowOf(decodePng(refPath), p.refWindow);
    const o: LookStats = lookStats(ours);
    const r: LookStats = lookStats(ref);
    const night = p.name.includes('night');

    console.log(`  ${p.name}`);
    console.log(`      ${p.why}`);
    console.log(`      ref   ${fmtStats(r)}`);
    console.log(`      ours  ${fmtStats(o)}`);
    console.log(`      band  ${grainBands(ours, 6).map((v) => v.toFixed(1).padStart(6)).join(' ')}  (ours)`);
    console.log(`      band  ${grainBands(ref, 6).map((v) => v.toFixed(1).padStart(6)).join(' ')}  (ref)`);
    console.log('');

    const near = (got: number, want: number, tol: number, dp: number): [boolean, string] => [
      Math.abs(got - want) <= tol,
      `${got.toFixed(dp)} against ${want.toFixed(dp)}, off by ${Math.abs(got - want).toFixed(dp)} (tolerance ${tol})`,
    ];
    checkNear(`${p.name}: exposure  `, near(o.p50, r.p50, TOL.p50, 0), results);
    checkNear(`${p.name}: contrast  `, near(o.rms, r.rms, TOL.rms, 1), results);
    checkNear(`${p.name}: saturation`, near(o.sat, r.sat, TOL.sat, 3), results);
    checkNear(`${p.name}: balance   `, near(o.warmth, r.warmth, TOL.warmth, 1), results);
    void night;

    await writeSideBySide(p.name, ours, ref);
  }

  if (!compared) {
    console.log('NOTHING COMPARED. Run `npm run probe:sharpness` first, and note that');
    console.log('`reference/` is gitignored — a fresh clone has no specification to');
    console.log('measure against and this probe can only report that, not pass.');
    process.exit(1);
  }

  console.log('');
  for (const r of results) console.log(`  ${r.line}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed} ok / ${failed} failed`);
  console.log(`  side-by-sides written to ${OUT_DIR}`);
  if (failed) process.exit(1);
}

void main();
