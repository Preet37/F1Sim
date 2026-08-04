import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { swatchUV, swatchPixelRect, haloPaintForTeam } from '../src/render/Livery.js';
import { HALO_PAINT_MIN_NY } from '../src/render/CarMesh.js';
import { F1_2026 } from '../src/data/roster/f1-2026.js';

/**
 * DOES THE HALO HAVE AN OUTLINE? — issue #34.
 *
 * *"the halo is also floating atp?"*, and the first thing that had to be
 * settled was whether that is a geometry report. It is not: `probe:carrig`'s
 * bolted-joint section is volumetric and has NO tolerance in it — a genuine
 * joint measures zero rather than "within 10mm" — and the hoop, the pillar, the
 * pillar root and both mounts are all inside it at 146 parts in one cluster. So
 * this probe deliberately does not measure geometry. It measures the thing that
 * was actually wrong, which is PAINT.
 *
 * WHY A SEPARATE PROBE, and why none of the eight that already photograph this
 * object could have caught it:
 *
 *  - `probe:carrig` asks whether parts touch. It stays green through both the
 *    broken and the fixed halo and would have stayed green through any paint at
 *    all, which is why §7 said so in advance.
 *  - `probe:framing` projects `HALO_PATH` through the real camera rig and says
 *    where the hoop lands in the frame. Where it lands was never the complaint.
 *  - `probe:grade` measures median luma and contrast over a whole region
 *    against the user's own reference frames. A 1.4m arc 25 pixels thick is
 *    perhaps 1% of the frame and cannot move any of those four statistics.
 *  - `audit:car` and `audit:livery` write PNGs for a human to look at. §3.1:
 *    every visual claim in this project made from a screenshot has eventually
 *    turned out to be wrong.
 *
 * THE MEASUREMENT is the user's own words made into a number. *"Segments of it
 * disappear"* is a statement about the EDGE between the halo and what is behind
 * it, so that edge is what gets walked:
 *
 *  1. The real frame, through the real path — post chain, tone map, the
 *     resolution the scaler actually settled on, read back inside the animation
 *     frame that drew it. This is the picture a player is shown.
 *  2. A CROWN MASK. The painted band is extracted from the car's own merged
 *     geometry by its swatch UV — every triangle all three of whose vertices
 *     are pinned to the `halo` cell — and drawn emissive-white over a black
 *     scene. So it is exactly the triangles `CarMesh` painted, occlusion
 *     correct, with no second copy of where the halo is anywhere in this file.
 *  3. A CAR MASK, the same car whole. What is NOT in it, near the crown, is the
 *     world behind the halo rather than more car.
 *  4. Walk the crown's boundary. At each boundary pixel take the mean luma of
 *     the crown inside a small window and the mean luma of the true background
 *     inside the same window, and call that sample INVISIBLE if the two are
 *     within `VISIBLE_LEVELS` of each other. The reported number is the
 *     fraction of the outline that has no step across it — which is "the part
 *     of the halo that is not there", in per cent, and it is what the assertion
 *     is written on.
 *
 * A mean-versus-mean contrast is reported too and is deliberately NOT the rule.
 * It passes comfortably on a night frame where half the arc is against a black
 * sky and the other half against a floodlight, which is precisely the frame the
 * complaint came from.
 *
 * IT CAN GO RED, and this is the whole reason `?haloUnpainted=1` exists.
 * `HALO_BREAK=1` re-introduces issue #34 by giving the `halo` swatch back the
 * `trim` hardware black in colour and in surface finish, changing one texel of
 * the atlas and nothing else — same geometry, same UVs, same everything. Both
 * arms are run and the separation between them is where the bound comes from.
 *
 * Usage:
 *   npm run probe:halo
 *   HALO_BREAK=1 npm run probe:halo          # expected to FAIL — #34 put back
 *   HALO_ONLY=spa,monaco HALO_AMB=night npm run probe:halo
 *   HALO_PNG=1 npm run probe:halo            # write the frames and the masks
 *   HALO_VIEWPORT=390x844x2 npm run probe:halo
 */

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring',
  'spa', 'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];

const CIRCUIT_IDS = process.env.HALO_ONLY
  ? process.env.HALO_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

/**
 * Day AND night on every circuit, whatever the calendar says.
 *
 * The defect is "no silhouette against a dark background" and only two of the
 * eleven races are actually at night, so the ambience is forced on both sides
 * rather than taken from the circuit definition. It is also the harder half:
 * a black tube against a blue sky has an outline whatever it is painted.
 */
const AMBIENCES = (process.env.HALO_AMB ?? 'day,night')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The onboard modes, because that is where a halo is a halo.
 *
 * `driver` is the view from behind the visor and `cockpit` is the roll-hoop
 * pod; between them they are how this game is mostly played and they are the
 * two frames `reference/target/76.png` and `77.png` are. From `chase` the hoop
 * is twenty pixels of a car and against the car's own bodywork rather than
 * against the world, which is a different question and not the reported one.
 */
const MODES = (process.env.HALO_MODES ?? 'driver,cockpit')
  .split(',').map((s) => s.trim()).filter(Boolean);

const TIER = process.env.HALO_TIER ?? 'high';
const VIEWPORT = (() => {
  const v = process.env.HALO_VIEWPORT;
  if (!v) return null;
  const m = /^(\d+)x(\d+)(?:x([\d.]+))?$/.exec(v.trim());
  if (!m) throw new Error(`HALO_VIEWPORT must be WxH or WxHxDPR, got ${v}`);
  return { width: +m[1], height: +m[2], deviceScaleFactor: m[3] ? +m[3] : 1 };
})();

const BREAK = process.env.HALO_BREAK === '1';
const TAG = process.env.HALO_TAG ?? (BREAK ? 'broken' : 'shot');
const STEPS = Number(process.env.HALO_STEPS ?? 1800);
const SETTLE_MS = Number(process.env.HALO_SETTLE ?? 9000);
/** Entry index of the car the camera follows. Car 0 has nobody driving it. */
const FOCUS_CAR = Number(process.env.HALO_CAR ?? 6);

/**
 * Entry indices section 3 moves the camera to, on the first circuit only.
 *
 * A grid is two cars per team in team order, so even indices two apart are
 * different teams and this walks most of the field. It is stated as indices
 * rather than as team ids because what section 3 needs is a CAR to sit behind,
 * and the mapping from index to team is what it prints.
 */
const TEAM_CARS = (process.env.HALO_CARS ?? '0,2,4,8,10,12,14,16,18')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const OUT_DIR = resolve(process.cwd(), 'halo-out', TAG);
const SAVE_PNG = process.env.HALO_PNG === '1';

/**
 * How big a luma step counts as an edge somebody can see, in display levels.
 *
 * 6 of 255 — about 2.4 per cent. Deliberately generous, because the claim being
 * made when a sample is called invisible is a strong one and it should be hard
 * to make it wrongly. A step of 6 levels on a moving image, on a tube twenty
 * pixels across, at the contrast this renderer's ACES curve leaves in the
 * shadows, is at the edge of what a viewer resolves at all. Nothing below this
 * is claimed to be invisible; everything below it is claimed to be UNRELIABLE,
 * which is exactly what "segments of it disappear" describes.
 */
const VISIBLE_LEVELS = Number(process.env.HALO_VISIBLE ?? 6);

/**
 * THE BOUND: how much brighter the halo draws than the SAME halo in the same
 * frame with the hardware black put back, in display levels.
 *
 * TWO EARLIER RULES WERE MEASURED AND BOTH WERE WRONG, and that is worth the
 * space, because what was wrong with them is what PROJECT.md §3.2 is about.
 *
 * THE FIRST was the complaint restated: *"segments of it disappear"* is a
 * statement about the EDGE, so bound the fraction of the outline with no step
 * across it. That was written first, at 20 per cent, and the full sweep of both
 * arms says it is the WRONG RULE — not too tight, not too loose, wrong:
 *
 *   fraction of the outline with no visible step   fixed          broken
 *   mean over 44 configurations                    2.3%           6.6%
 *   worst configuration                            26.3%          33.8%
 *   configurations over a 20% bar                  1 of 44        4 of 44
 *
 * The means separate by 2.9x and no row-wise bar separates them at all. The row
 * that settles it is `monaco day driver`: PAINTED it measures 26.3% with the
 * halo at luma 82.6 against a background of 72.4, and UNPAINTED it measures
 * 7.7% with the halo at 13.8 against 83.8. Monaco in daylight is a mid-grey
 * city, an orange halo lands on the same luma as the buildings behind it, and a
 * BLACK one has a stronger luma edge there than a painted one does. That is a
 * true measurement and it is not a defect: what makes a painted halo read on
 * that frame is hue, and luma is blind to hue by construction.
 *
 * THE SECOND was the defect as §7 states it — *"painted `trim` `0x1e222a`, luma
 * 34/255"* — as an absolute floor on the halo's rendered luma. It separates the
 * two arms perfectly:
 *
 *   halo luma, over the same 44 configurations       fixed         broken
 *   lowest                                           81.2          1.6
 *   highest                                          183.0         70.3
 *
 * and 75 sits in the 10.9-level gap between them. It is still the wrong rule,
 * and section 3 is what found out: all 44 of those rows are the same car. Move
 * the camera to nine other cars on the same grid and three of them are painted
 * exactly as the reference says and draw at 57.6, 51.5 and 44.0, because they
 * are a purple, a navy and a dark red. **A dark car has a dark halo** —
 * `90.png`'s Aston is one — and a floor set off the brightest livery on the
 * grid would have forced three liveries to be bleached to satisfy an
 * instrument. Reported as a column, never asserted.
 *
 * WHAT IS ASSERTED is the paired difference: the frame is drawn twice, once as
 * it ships and once with the halo cell of the real atlas overwritten by the
 * real trim cell, and the halo's luma is read from both. Everything that could
 * move a luma other than the paint — livery, circuit, ambience, exposure, tone
 * curve, camera — is identical between the two arms by construction, so what is
 * left is the paint. On a build carrying issue #34 the two texels are already
 * the same texel and the difference is EXACTLY ZERO, which is as certain as a
 * red result gets.
 *
 * 3 DISPLAY LEVELS, AND IT IS A NOISE FLOOR RATHER THAN A QUALITY BAR. That
 * distinction is the honest part and it should not be edited away.
 *
 * The two arms are the SAME frame with one texel different, so there is no
 * drift, no reseeding and no sampling noise between them: on a build carrying
 * issue #34 the lift is 0.0 exactly, and 3 is above anything filtering and
 * rounding can manufacture. So the assertion is "the halo is this car's own
 * paint and not the shared hardware black", which is precisely what #34 was,
 * and it is red with certainty on the defect.
 *
 * IT IS NOT A CLAIM THAT THE PAINT BUYS A SILHOUETTE, and the sweep is what
 * forced that retreat. A bound of 20 was tried and three cars on the grid fail
 * it while being painted exactly as the reference says: `#6b2d8f` lifts 12.7,
 * `#0e3b5c` lifts 4.7, `#7a1020` lifts 8.1. Those are a purple, a navy and a
 * dark red, and a dark car's halo IS nearly as dark as a black one — `90.png`'s
 * Aston is a dark green halo on a dark green car. Raising the bound to fail
 * them would not be a stricter probe, it would be a probe demanding that three
 * liveries be bleached; and setting the bound just under them would be a number
 * fitted to the answer, which is the thing §3.3 is about. They are counted and
 * printed as a residual instead — see `DARK_LIVERY_LIFT` — and PROJECT.md §7
 * carries the open question.
 *
 * NEVER RAISE IT — PROJECT.md §3.3.
 */
const HALO_LIFT_MIN = Number(process.env.HALO_MIN_LIFT ?? 3);

/**
 * A lift under this is REPORTED as a dark-livery residual, and asserts nothing.
 *
 * See `HALO_LIFT_MIN` for why the bound is a noise floor rather than this. A
 * car whose body colour is a dark navy or a dark red has a halo that is nearly
 * as dark as the hardware black, because it IS nearly as dark — and that is the
 * reference's own answer, not a defect in this code. The count is printed every
 * run so that the question "should a dark body take its accent instead" stays
 * visible rather than being buried in a bound.
 */
const DARK_LIVERY_LIFT = Number(process.env.HALO_DARK_LIFT ?? 20);

/**
 * Reported beside the lift, and NOT the rule. It was the rule for one run.
 *
 * An absolute floor of 75 separated the two arms perfectly on the car the
 * camera happened to be behind (a McLaren orange: broken 1.6..70.3, fixed
 * 81.2..183.0), and section 3 then took the same shot behind nine other cars on
 * the same grid and found three that are painted exactly as the reference says
 * and still cannot reach it — a purple `#6b2d8f` at 57.6, a navy `#0e3b5c` at
 * 51.5 and a dark red `#7a1020` at 44.0. A dark car has a dark halo; `90.png`'s
 * Aston is a dark green one. **The bound was wrong, not the paint**, and an
 * absolute floor would have forced the paint rule to bleach three liveries to
 * satisfy an instrument. Kept as a reported column because it is the number §7
 * stated the defect in.
 */
const HALO_LUMA_REPORT_AT = Number(process.env.HALO_MIN_LUMA ?? 75);

/**
 * Reported beside it, and deliberately not a rule. See `HALO_LUMA_MIN` for the
 * table that took it out of the assertion.
 */
const INVISIBLE_REPORT_AT = Number(process.env.HALO_MAX ?? 0.20);

/**
 * A row with less crown than this in the frame is a measurement failure, not a
 * pass.
 *
 * The failure mode this is here for is the whole point of it: a mask that comes
 * back empty — a camera looking the wrong way, a car that retired, a swatch
 * whose UV moved — produces zero invisible samples out of zero, which is a
 * fraction of zero, which passes. §3.2.
 */
const MIN_CROWN_PIXELS = 250;
const MIN_EDGE_SAMPLES = 60;

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('no Chrome found; set CHROME_PATH');
}

const [HALO_U, HALO_V] = swatchUV('halo');
/**
 * The halo cell as a fraction of the atlas, so the page can paint it at
 * whatever size the atlas actually came out. `swatchPixelRect` is asked for a
 * unit sheet and the page multiplies by the real edge — the alternative is the
 * probe guessing 512 and being silently wrong on the low tier's 256.
 */
const HALO_CELL = swatchPixelRect('halo', 1);
/** Its neighbour, whose texel is the hardware black the paired arm paints with. */
const TRIM_CELL = swatchPixelRect('trim', 1);

/**
 * Installed once per page. Everything runs inside one animation frame: draw the
 * real frame, read it, draw two masks over it, read those, put the materials
 * back. Three reads of the same canvas in one task, which is the only time the
 * drawing buffer is guaranteed to still hold what was drawn — the context has
 * no `preserveDrawingBuffer`.
 */
const MEASURE_SRC = String.raw`(() => {
  const g = window.__game;

  /**
   * NOTHING HERE CONSTRUCTS A three.js CLASS BY NAME.
   *
   * A production build has no THREE on \`window\` and its class names are
   * whatever the minifier chose, so every constructor below is taken off an
   * object the scene already holds — the same discipline \`probe:grain\` uses
   * for its road mask. Two live objects are enough: the shell's material gives
   * the material class, and the livery atlas it carries gives the texture class.
   */
  const state = { black: null, white: null, crown: null, shell: null };

  const luma = (d, p) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];

  const EPS = 1e-4;
  /**
   * The shell is the mesh whose UVs actually reach the halo swatch.
   *
   * Not "the biggest mesh" and not "the one with a map": the question being
   * asked is which object carries the painted crown, and the answer is a
   * property of the UVs, so that is what gets looked at. It also means this
   * returns null — loudly — if the crown is not painted at all, rather than
   * quietly measuring a wheel.
   */
  const findShell = (root) => {
    let hit = null;
    root.traverse((o) => {
      if (hit || !o.isMesh || !o.geometry) return;
      const uv = o.geometry.attributes && o.geometry.attributes.uv;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!uv || !mat || !mat.map || !mat.map.image) return;
      let n = 0;
      for (let i = 0; i < uv.count; i++) {
        if (Math.abs(uv.getX(i) - ${HALO_U}) < EPS
          && Math.abs(uv.getY(i) - ${HALO_V}) < EPS) { n++; if (n > 8) break; }
      }
      if (n > 8) hit = { mesh: o, material: mat };
    });
    return hit;
  };

  /**
   * A copy of the atlas that is black everywhere except the halo cell.
   *
   * Used as an EMISSIVE map, so what lights up is exactly the texels the crown
   * samples — including the anti-aliased edge of the paint line, which a
   * triangle-level mask would have had to round one way or the other. The cell
   * is inset by two texels so that bilinear filtering at the cell boundary
   * cannot leak white onto the \`trim\` cell next door and paint the fairing.
   */
  /**
   * The one material class in the scene that is not lit — and it has to be
   * that one, which the first version of this probe learnt the hard way.
   *
   * A mask built out of the SHELL's class (a lit, physically-based material)
   * with its colour set to black is not black. It still carries the dielectric
   * Fresnel term, so it reflects about four per cent of the environment, and
   * under Bahrain's night rig — floodlights, a raised tone-mapping exposure and
   * a bright captured sky — four per cent of the environment came back over the
   * mask's own 110-level threshold on every up-facing surface in the frame.
   * The measurement then reported a "crown" of 368,725 pixels where the same
   * camera in daylight saw 89,396, and it was measuring the paddock.
   *
   * A basic material has no lighting term at all, so \`color x map\` is exactly
   * what lands in the buffer whatever the ambience is doing. \`toneMapped\` off
   * for the same reason: the mask is a coverage value, not a colour, and a
   * filmic curve applied to a binary is a binary with soft edges at best.
   *
   * Found by duck-typing rather than by class name: a production bundle is
   * minified, so \`constructor.name\` is whatever the minifier chose, while
   * three.js's own \`isMeshBasicMaterial\` is a property assignment and survives.
   * The contact shadow under every car is one, so the scene always has one.
   */
  const findBasicCtor = (scene) => {
    let ctor = null;
    scene.traverse((o) => {
      if (ctor || !o.material) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.isMeshBasicMaterial) ctor = m.constructor;
    });
    return ctor;
  };

  /**
   * Repaints the halo cell of the REAL atlas with the REAL trim cell's texel,
   * and hands back the undo.
   *
   * THIS IS THE PAIRED ARM, and it is the whole assertion. Measuring the halo's
   * absolute luma works for exactly one livery: the first version of this probe
   * bounded it at 75 of 255 off a McLaren, and section 3 immediately found
   * three cars on the same grid — a purple at 57.6, a navy at 51.5 and a dark
   * red at 44.0 — that are painted correctly in their own colours and cannot
   * reach it. A dark car has a dark halo and that is what the reference shows.
   *
   * So the question is not "is the halo bright" but "is the halo the CAR'S
   * PAINT rather than the shared hardware black", and that is answered by
   * drawing the same frame twice with one texel of the atlas different. Every
   * other thing that could move a luma — the ambience, the exposure, the tone
   * curve, the camera, the circuit, the livery — is identical between the two,
   * so the difference is the paint and nothing else. On a build with issue #34
   * in it the two texels are already equal and the difference is EXACTLY ZERO
   * by construction, which is as red as a probe can go.
   *
   * The replacement colour is READ OUT OF THE TRIM CELL rather than written
   * here. \`0x1e222a\` appears in \`Livery.ts\` once, and a probe that restates it
   * is a probe that keeps passing after somebody changes it.
   *
   * The surface map goes with it. Colour and finish are two textures sampled
   * through the same UV, and swapping only the colour would leave the crown
   * with the bodywork's gloss — a second difference between the arms, in the
   * one place where there must be exactly one.
   */
  const px = (cell, size) => ({
    x: Math.round(cell.x * size), y: Math.round(cell.y * size),
    w: Math.round(cell.w * size), h: Math.round(cell.h * size),
  });
  const repaintCellFromTrim = (tex) => {
    if (!tex || !tex.image || !tex.image.getContext) return null;
    const cvs = tex.image;
    const c2 = cvs.getContext('2d', { willReadFrequently: true });
    const size = cvs.width;
    const halo = px({ x: ${HALO_CELL.x}, y: ${HALO_CELL.y},
      w: ${HALO_CELL.w}, h: ${HALO_CELL.h} }, size);
    const trim = px({ x: ${TRIM_CELL.x}, y: ${TRIM_CELL.y},
      w: ${TRIM_CELL.w}, h: ${TRIM_CELL.h} }, size);
    const before = c2.getImageData(halo.x, halo.y, halo.w, halo.h);
    const t = c2.getImageData(
      trim.x + (trim.w >> 1), trim.y + (trim.h >> 1), 1, 1).data;
    c2.fillStyle = 'rgb(' + t[0] + ',' + t[1] + ',' + t[2] + ')';
    c2.fillRect(halo.x, halo.y, halo.w, halo.h);
    tex.needsUpdate = true;
    return () => { c2.putImageData(before, halo.x, halo.y); tex.needsUpdate = true; };
  };

  const maskTexture = (mat) => {
    const size = mat.map.image.width || mat.map.image.naturalWidth;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const cx = c.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, size, size);
    cx.fillStyle = '#fff';
    const INSET = 2;
    cx.fillRect(
      ${HALO_CELL.x} * size + INSET, ${HALO_CELL.y} * size + INSET,
      ${HALO_CELL.w} * size - 2 * INSET, ${HALO_CELL.h} * size - 2 * INSET,
    );
    const TexCtor = mat.map.constructor;
    const t = new TexCtor(c);
    t.flipY = mat.map.flipY;
    t.colorSpace = mat.map.colorSpace;
    t.wrapS = mat.map.wrapS;
    t.wrapT = mat.map.wrapT;
    t.needsUpdate = true;
    return t;
  };

  const materials = (scene, mat) => {
    if (state.black) return true;
    const Ctor = findBasicCtor(scene);
    if (!Ctor) return false;
    state.black = new Ctor({ color: 0x000000, fog: false, toneMapped: false });
    state.white = new Ctor({ color: 0xffffff, fog: false, toneMapped: false });
    // \`color x map\`: white where the halo cell is, black everywhere else, and
    // the paint line's own anti-aliasing carried through rather than rounded.
    state.crown = new Ctor({
      color: 0xffffff, map: maskTexture(mat), fog: false, toneMapped: false,
    });
    return true;
  };

  /**
   * Swaps every material in the scene for a flat black one, except the meshes
   * named. Everything still writes depth, so the mask is occlusion correct: a
   * crown texel hidden behind the mirror housing or the driver's hand does not
   * count as halo, which is the whole reason this is a render and not a
   * projection.
   */
  const blackout = (scene, special) => {
    const saved = [];
    scene.traverse((o) => {
      if (!o.material) return;
      saved.push([o, o.material]);
      const s = special.get(o);
      o.material = s || state.black;
    });
    return saved;
  };
  const restore = (saved) => { for (const p of saved) p[0].material = p[1]; };

  /**
   * Puts the GL renderer into a known state for a mask pass, and back after.
   *
   * Three things the real frame leaves behind would each quietly ruin a mask,
   * and none of them announces itself: a \`scene.background\` is drawn by the
   * clear and would put the sky straight into the mask; \`autoClear\` is turned
   * off around the mirror passes, so a mask would COMPOSITE OVER the finished
   * frame and every bright pixel in it would read as halo; and the render
   * target may still be a mirror's. All three are saved and restored.
   */
  const maskState = { bg: null, autoClear: true, target: null };
  const beginMask = (scene, r) => {
    maskState.bg = scene.background;
    maskState.autoClear = r.autoClear;
    maskState.target = r.getRenderTarget();
    scene.background = null;
    r.autoClear = true;
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 1);
  };
  const endMask = (scene, r) => {
    scene.background = maskState.bg;
    r.autoClear = maskState.autoClear;
    r.setRenderTarget(maskState.target);
  };

  const binary = (img, w, h) => {
    const m = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) m[i] = luma(img, p) > 110 ? 1 : 0;
    return m;
  };
  const dilate = (m, w, h, r) => {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          o[yy * w + xx] = 1;
        }
      }
    }
    return o;
  };
  const erode = (m, w, h, r) => {
    const o = new Uint8Array(w * h);
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!m[(y + dy) * w + (x + dx)]) { all = 0; break; }
        }
      }
      o[y * w + x] = all;
    }
    return o;
  };

  /**
   * Forget which mesh the crown was found on.
   *
   * Section 3 moves the camera to another team's car, and every car has its own
   * merged shell. Without this the mask would keep pointing at the first car's
   * geometry and the measurement would silently be of a vehicle that is no
   * longer in front of the camera — a mask that is stale rather than empty,
   * which is the kind that does not announce itself.
   */
  g.__haloReset = () => { state.shell = null; };

  g.__haloMeasure = () => new Promise((res) => {
    requestAnimationFrame(() => {
      const scene = g.renderer.scene;
      const cam = g.renderer.director.camera;
      const idx = g.engine.cars.indexOf(g.__focus);
      const visual = g.renderer.carVisuals[idx];
      if (!visual) { res({ error: 'no car visual for the focus car' }); return; }

      if (!state.shell) state.shell = findShell(visual.root);
      if (!state.shell) {
        res({ error: 'no mesh on the car has UVs at the halo swatch —'
          + ' the crown is not painted, or the swatch layout moved' });
        return;
      }
      if (!materials(scene, state.shell.material)) {
        res({ error: 'no unlit material anywhere in the scene to build the'
          + ' mask out of — see findBasicCtor' });
        return;
      }

      const src = document.querySelector('canvas');
      const w = src.width, h = src.height;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });

      // Eight frames before every read, and the same eight before each arm.
      // The post chain's exposure adapts over time, so a single frame taken
      // straight after a texture changed is measured part way through the
      // adaptation — and the two arms would then differ by how far the
      // exposure had got as well as by the paint.
      const drawN = (n) => {
        for (let i = 0; i < n; i++) g.renderer.render(1 / 60, 1, g.engine, g.__focus);
      };

      // 1. The real frame, through the real path.
      drawN(8);
      cx.drawImage(src, 0, 0);
      const img = cx.getImageData(0, 0, w, h).data;

      // 1b. THE SAME FRAME with the halo cell put back to the hardware black —
      //     the paired arm. See \`repaintCellFromTrim\`.
      const shellMat = state.shell.material;
      const undoColour = repaintCellFromTrim(shellMat.map);
      const undoSurface = repaintCellFromTrim(
        shellMat.roughnessMap || shellMat.metalnessMap);
      let imgUnpainted = null;
      if (undoColour) {
        drawN(8);
        cx.drawImage(src, 0, 0);
        imgUnpainted = cx.getImageData(0, 0, w, h).data;
        undoColour();
        if (undoSurface) undoSurface();
        // Back to where the painted arm was, so the masks below are taken
        // against the same exposure the first read saw.
        drawN(8);
      }

      // 2. The crown alone, white, over a black scene that still writes depth.
      //    Straight through the WebGLRenderer, so the bloom does not smear the
      //    silhouette the whole measurement is about.
      const gl = g.renderer.renderer;
      beginMask(scene, gl);

      const crownOnly = new Map([[state.shell.mesh, state.crown]]);
      let saved = blackout(scene, crownOnly);
      gl.render(scene, cam);
      restore(saved);
      cx.clearRect(0, 0, w, h);
      cx.drawImage(src, 0, 0);
      const crownMask = binary(cx.getImageData(0, 0, w, h).data, w, h);

      // 3. The whole car, white. Anything near the crown that is not in this is
      //    the world behind the halo rather than more car.
      const carWhite = new Map();
      visual.root.traverse((o) => { if (o.material) carWhite.set(o, state.white); });
      saved = blackout(scene, carWhite);
      gl.render(scene, cam);
      restore(saved);
      cx.clearRect(0, 0, w, h);
      cx.drawImage(src, 0, 0);
      const carMask = binary(cx.getImageData(0, 0, w, h).data, w, h);

      endMask(scene, gl);

      let crownPixels = 0;
      for (let i = 0; i < w * h; i++) crownPixels += crownMask[i];
      if (crownPixels < ${MIN_CROWN_PIXELS}) {
        res({ error: 'the painted crown covers ' + crownPixels + 'px of the frame' });
        return;
      }

      // Eroded crown: the edge itself is anti-aliased and is a blend of the
      // halo and what is behind it, so a pixel on the boundary is evidence for
      // neither side. Dilated car: the same, from the other direction.
      const crownIn = erode(crownMask, w, h, 1);
      const carOut = dilate(carMask, w, h, 2);

      let cSum = 0, cN = 0, bSum = 0, bN = 0, uSum = 0;
      const near = dilate(crownMask, w, h, 6);
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        if (crownIn[i]) {
          cSum += luma(img, p); cN++;
          if (imgUnpainted) uSum += luma(imgUnpainted, p);
        } else if (near[i] && !carOut[i]) { bSum += luma(img, p); bN++; }
      }

      // The edge walk. R is the window half-width: big enough to hold both
      // sides of a 2-3px anti-aliased boundary plus some of each surface,
      // small enough that "the background" is local to the sample.
      const R = 3;
      let scanned = 0, invisible = 0, worst = 1e9;
      const perEdge = [];
      for (let y = R + 1; y < h - R - 1; y++) {
        for (let x = R + 1; x < w - R - 1; x++) {
          const i = y * w + x;
          if (!crownMask[i]) continue;
          // Boundary only.
          if (crownMask[i - 1] && crownMask[i + 1]
            && crownMask[i - w] && crownMask[i + w]) continue;
          let cs = 0, cc = 0, bs = 0, bc = 0;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const j = (y + dy) * w + (x + dx);
              const p = j * 4;
              if (crownIn[j]) { cs += luma(img, p); cc++; }
              else if (!carOut[j]) { bs += luma(img, p); bc++; }
            }
          }
          if (cc < 3 || bc < 4) continue;
          const d = Math.abs(cs / cc - bs / bc);
          scanned++;
          if (d < ${VISIBLE_LEVELS}) invisible++;
          if (d < worst) worst = d;
          perEdge.push(d);
        }
      }
      /**
       * The masks, painted back over the frame, for a human to check.
       *
       * §3.1 says the numbers are the evidence and the image is the sanity
       * check, and this is the sanity check: the first version of this probe
       * produced a perfectly reasonable-looking table while its "crown" covered
       * a quarter of the paddock. Red is what is being called halo, green is
       * the rest of the car, blue is what is being called the background.
       */
      let dump = null;
      if (${SAVE_PNG ? 'true' : 'false'}) {
        const out = cx.createImageData(w, h);
        for (let i = 0, p = 0; i < w * h; i++, p += 4) {
          const base = luma(img, p) * 0.45;
          out.data[p] = base; out.data[p + 1] = base; out.data[p + 2] = base;
          out.data[p + 3] = 255;
          if (crownMask[i]) { out.data[p] = 255; out.data[p + 1] = 40; out.data[p + 2] = 40; }
          else if (carMask[i]) { out.data[p + 1] = Math.min(255, base + 90); }
          else if (near[i]) { out.data[p + 2] = Math.min(255, base + 120); }
        }
        cx.putImageData(out, 0, 0);
        dump = cv.toDataURL('image/png');
      }

      perEdge.sort((a, b) => a - b);
      const pct = (q) => perEdge.length ? perEdge[Math.min(perEdge.length - 1,
        Math.floor(q * perEdge.length))] : null;

      res({
        width: w, height: h,
        crownPixels: crownPixels,
        crownLuma: cN ? cSum / cN : null,
        unpaintedLuma: (cN && imgUnpainted) ? uSum / cN : null,
        bgLuma: bN ? bSum / bN : null,
        bgPixels: bN,
        scanned: scanned,
        invisible: invisible,
        edgeMin: perEdge.length ? worst : null,
        edgeP10: pct(0.10),
        edgeMedian: pct(0.50),
        dump: dump,
      });
    });
  });
})()`;

interface Row {
  circuit: string;
  ambience: string;
  mode: string;
  team: string;
  settledScale: number;
  buffer: string;
  crownPixels: number;
  crownLuma: number | null;
  unpaintedLuma: number | null;
  lift: number | null;
  bgLuma: number | null;
  contrast: number | null;
  scanned: number;
  invisible: number;
  invisibleFraction: number | null;
  edgeP10: number | null;
  edgeMedian: number | null;
  ok: boolean;
  note: string;
}

function f(v: number | null, w = 6, d = 1): string {
  return v === null ? 'n/a'.padStart(w) : v.toFixed(d).padStart(w);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // ---------------------------------------------------------------------
  // Section 1, node only: every team on the grid gets a paint, and it is the
  // team's own. Eleven browser sessions to establish that would be an hour of
  // Chrome to answer a question that is a pure function.
  // ---------------------------------------------------------------------
  console.log('=== 1. THE PAINT, PER TEAM — the rule, not a frame ===');
  console.log(`the halo crown is the team's own body colour unless that colour`
    + ` is darker than the hardware it replaces (relative luminance 0.132)`);
  console.log('  team              body      L      halo      L   source');
  let paintFail = 0;
  for (const t of F1_2026.teams) {
    const p = haloPaintForTeam(t.colour, t.accent);
    const src = p.colour === t.colour ? 'body' : 'accent/lift';
    // The one thing worth asserting here: no car ends up with the near-black
    // the defect was. Anything at or below the hardware's own luminance is the
    // same non-silhouette under a different name.
    const ok = p.luminance > 0.132;
    if (!ok) paintFail++;
    console.log(`  ${t.id.padEnd(16)} #${t.colour.toString(16).padStart(6, '0')}`
      + ` ${p.bodyLuminance.toFixed(3)}  #${p.colour.toString(16).padStart(6, '0')}`
      + ` ${p.luminance.toFixed(3)}   ${src}${ok ? '' : '   <-- STILL NEAR-BLACK'}`);
  }
  console.log(`  ${F1_2026.teams.length - paintFail} of ${F1_2026.teams.length}`
    + ` teams carry a halo brighter than the hardware black it replaced`);
  console.log(`  paint line at n_y >= ${HALO_PAINT_MIN_NY.toFixed(2)}`
    + ' of the section normal (see HALO_PAINT_MIN_NY)\n');

  if (BREAK) {
    console.log('*** HALO_BREAK=1 — issue #34 has been put back on purpose.'
      + ' This run is EXPECTED to fail. ***\n');
  }

  if (process.env.HALO_SKIP_BUILD !== '1') {
    console.log('building...');
    await build({ logLevel: 'warn' });
  }
  const server: PreviewServer = await preview({
    preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn',
  });
  const addr = server.httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    protocolTimeout: 20 * 60_000,
    defaultViewport: null,
    args: [
      '--window-size=1600,1000', '--window-position=0,0', '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const page: Page = await browser.newPage();
  page.setDefaultTimeout(300_000);
  await page.bringToFront();
  if (VIEWPORT) {
    await page.setViewport(VIEWPORT);
    console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}`
      + ` @ dpr ${VIEWPORT.deviceScaleFactor}`);
  }

  const rows: Row[] = [];
  /** Measurements whose lift is real but small. Reported, never asserted. */
  const dark: string[] = [];
  const teamRows: {
    car: number; team: string; colour: string;
    luma: number | null; lift: number | null; ok: boolean;
  }[] = [];

  console.log('=== 2. THE HALO, IN A FINISHED FRAME ===');
  for (const id of CIRCUIT_IDS) {
    const q = `${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7`
      + `&quality=${TIER}${BREAK ? '&haloUnpainted=1' : ''}`;
    await page.goto(q, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(
      "!!window.__game && window.__game.screen === 'racing'",
      { timeout: 300_000, polling: 250 },
    );

    // The real loop runs so the resolution scaler settles, with simulated time
    // paused so the world does not depend on how many frames the machine
    // managed. The shot is then taken at what the scaler settled on — the same
    // discipline `probe:grain` and `probe:sharpness` follow, and for the same
    // reason: a picture taken at full resolution is a picture no player saw.
    await page.evaluate('window.__game.clock.paused = true');
    process.stdout.write(`${id}: settling... `);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const settled = await page.evaluate(
      'window.__game.renderer.resolutionScale') as number;
    process.stdout.write(`scale=${settled.toFixed(2)}, stepping... `);

    await page.evaluate(`(() => {
      const g = window.__game;
      cancelAnimationFrame(g.rafHandle);
      for (let i = 0; i < ${STEPS}; i++) { g.engine.step(); if (g.engine.over) break; }
      g.__focus = g.engine.cars.find((c, i) => i >= ${FOCUS_CAR} && !c.retired)
        || g.engine.cars.find((c) => !c.retired) || g.engine.cars[0];
      Object.getPrototypeOf(g.renderer).updateResolutionScale = function () {};
      g.__stop = false;
      g.__draw = (n) => new Promise((res) => {
        const tick = () => {
          g.renderer.render(1 / 60, 1, g.engine, g.__focus);
          if (n-- > 0 && !g.__stop) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
    })()`);
    process.stdout.write('stepped\n');

    await page.evaluate(MEASURE_SRC);

    const team = await page.evaluate(
      '(() => { const t = window.__game.__focus.team;'
      + ' return t.shortName || t.name || t.id; })()') as string;

    for (const amb of AMBIENCES) {
      await page.evaluate(`(() => {
        const g = window.__game;
        g.engine.track.def.ambience = ${JSON.stringify(amb)};
        Object.getPrototypeOf(g.renderer).applyAmbience.call(g.renderer, g.engine);
      })()`);

      for (const mode of MODES) {
        await page.evaluate(
          `window.__game.renderer.director.setMode(${JSON.stringify(mode)})`);
        await page.evaluate('window.__game.__stop = false');
        await page.evaluate('window.__game.__draw(120)');

        const buf = await page.evaluate(`(() => {
          const c = window.__game.renderer.renderer.getContext();
          return c.drawingBufferWidth + 'x' + c.drawingBufferHeight;
        })()`) as string;

        const m = await page.evaluate('window.__game.__haloMeasure()') as {
          error?: string;
          crownPixels?: number; crownLuma?: number | null;
          unpaintedLuma?: number | null; bgLuma?: number | null;
          scanned?: number; invisible?: number;
          edgeP10?: number | null; edgeMedian?: number | null; dump?: string | null;
        };

        if (m.dump) {
          await writeFile(
            resolve(OUT_DIR, `${id}-${amb}-${mode}--mask.png`),
            Buffer.from(m.dump.split(',')[1], 'base64'),
          );
        }

        if (SAVE_PNG) {
          const box = await page.evaluate(`(() => {
            const r = document.querySelector('canvas').getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })()`) as { x: number; y: number; width: number; height: number };
          const drawing = page.evaluate('window.__game.__draw(100000)')
            .catch(() => undefined);
          await new Promise((r) => setTimeout(r, 300));
          const png = await page.screenshot({ clip: box, type: 'png' });
          await page.evaluate('window.__game.__stop = true');
          await drawing;
          await writeFile(resolve(OUT_DIR, `${id}-${amb}-${mode}.png`), png);
        }

        const label = `${id} ${amb} ${mode}`;
        if (m.error) {
          rows.push({
            circuit: id, ambience: amb, mode, team, settledScale: settled,
            buffer: buf, crownPixels: 0, crownLuma: null, unpaintedLuma: null,
            lift: null, bgLuma: null,
            contrast: null, scanned: 0, invisible: 0, invisibleFraction: null,
            edgeP10: null, edgeMedian: null, ok: false, note: m.error,
          });
          console.log(`  ${label.padEnd(30)} FAIL — ${m.error}`);
          continue;
        }

        const scanned = m.scanned ?? 0;
        const invisible = m.invisible ?? 0;
        const contrast = m.crownLuma !== null && m.crownLuma !== undefined
          && m.bgLuma !== null && m.bgLuma !== undefined
          ? Math.abs(m.crownLuma - m.bgLuma) : null;

        const notes: string[] = [];
        let frac: number | null = null;
        if (scanned < MIN_EDGE_SAMPLES) {
          notes.push(`only ${scanned} of the halo's outline was against the`
            + ` world rather than against the car — nothing to measure`);
        } else {
          frac = invisible / scanned;
        }
        // THE ASSERTION. See `HALO_LIFT_MIN` for why it is the paired
        // difference and not the two rules that were measured before it.
        const lift = (m.crownLuma !== null && m.crownLuma !== undefined
          && m.unpaintedLuma !== null && m.unpaintedLuma !== undefined)
          ? m.crownLuma - m.unpaintedLuma : null;
        if (lift === null) {
          notes.push('the paired arm produced nothing — the atlas could not be'
            + ' repainted, so there is no unpainted frame to measure against');
        } else if (lift < DARK_LIVERY_LIFT) {
          dark.push(`${id} ${amb} ${mode}: ${lift.toFixed(1)}`);
        }
        if (lift !== null && lift < HALO_LIFT_MIN) {
          notes.push(`the halo draws only ${lift.toFixed(1)} display levels`
            + ` brighter than the hardware black it replaced`
            + ` (bound ${HALO_LIFT_MIN}; ${(m.crownLuma as number).toFixed(1)}`
            + ` against ${(m.unpaintedLuma as number).toFixed(1)})`);
        }
        const ok = notes.length === 0;

        rows.push({
          circuit: id, ambience: amb, mode, team, settledScale: settled,
          buffer: buf, crownPixels: m.crownPixels ?? 0,
          crownLuma: m.crownLuma ?? null, unpaintedLuma: m.unpaintedLuma ?? null,
          lift, bgLuma: m.bgLuma ?? null, contrast,
          scanned, invisible, invisibleFraction: frac,
          edgeP10: m.edgeP10 ?? null, edgeMedian: m.edgeMedian ?? null,
          ok, note: notes.join('; '),
        });

        console.log(
          `  ${label.padEnd(30)} ${ok ? 'ok  ' : 'FAIL'}`
          + ` lift=${f(lift)}  halo=${f(m.crownLuma ?? null)}`
          + ` unpainted=${f(m.unpaintedLuma ?? null)} bg=${f(m.bgLuma ?? null)}`
          + ` gone=${frac === null ? '  n/a' : (frac * 100).toFixed(1).padStart(5)}%`
          + ` edge p10=${f(m.edgeP10 ?? null, 5)}`
          + `  [${m.crownPixels}px crown, ${scanned} edge samples]`,
        );
        if (frac !== null && frac > INVISIBLE_REPORT_AT) {
          console.log(`       note: ${(frac * 100).toFixed(1)}% of this outline`
            + ' has no luma step across it — reported, never asserted, and'
            + ' HALO_LUMA_MIN says why');
        }
        if (!ok) console.log(`       ${notes.join('; ')}`);
      }
    }

    // ------------------------------------------------------------------
    // Section 3, once, on the first circuit: the SAME measurement with the
    // camera moved to other teams' cars.
    //
    // Sections 1 and 2 have a hole between them and this is what closes it.
    // Section 1 is the rule and covers all eleven teams, but it is arithmetic
    // on a hex triple. Section 2 is a real frame and covers eleven circuits,
    // but the camera sits behind ONE car all the way through, so a livery
    // whose body colour is dark enough to draw badly would never appear in it.
    // Ferrari and Audi are 0.206 and 0.198 of relative luminance against this
    // car's 0.571, and a bound met by the brightest team on the grid says
    // nothing whatever about the darkest.
    // ------------------------------------------------------------------
    if (id === CIRCUIT_IDS[0]) {
      console.log('\n=== 3. OTHER TEAMS, SAME FRAME ===');
      await page.evaluate(
        `window.__game.renderer.director.setMode(${JSON.stringify(MODES[0])})`);
      for (const idx of TEAM_CARS) {
        const moved = await page.evaluate(`(() => {
          const g = window.__game;
          const car = g.engine.cars[${idx}];
          if (!car || car.retired) return null;
          g.__focus = car;
          g.__haloReset();
          const t = car.team;
          return (t.shortName || t.name || t.id) + '|'
            + '#' + t.colour.toString(16).padStart(6, '0');
        })()`) as string | null;
        if (!moved) { console.log(`  car ${idx}: retired or absent`); continue; }
        const [tname, tcol] = moved.split('|');
        await page.evaluate('window.__game.__stop = false');
        await page.evaluate('window.__game.__draw(120)');
        const m = await page.evaluate('window.__game.__haloMeasure()') as {
          error?: string; crownLuma?: number | null;
          unpaintedLuma?: number | null; bgLuma?: number | null;
        };
        const tl = (m.crownLuma !== null && m.crownLuma !== undefined
          && m.unpaintedLuma !== null && m.unpaintedLuma !== undefined)
          ? m.crownLuma - m.unpaintedLuma : null;
        if (m.error || tl === null) {
          teamRows.push({
            car: idx, team: tname, colour: tcol, luma: m.crownLuma ?? null,
            lift: null, ok: false,
          });
          console.log(`  car ${idx} ${tname.padEnd(14)} ${tcol}  FAIL — ${m.error ?? 'no paired arm'}`);
          continue;
        }
        const tok = tl >= HALO_LIFT_MIN;
        if (tl < DARK_LIVERY_LIFT) dark.push(`${tname} ${tcol}: ${tl.toFixed(1)}`);
        teamRows.push({
          car: idx, team: tname, colour: tcol, luma: m.crownLuma ?? null,
          lift: tl, ok: tok,
        });
        console.log(`  car ${idx} ${tname.padEnd(14)} ${tcol}`
          + `  lift ${tl.toFixed(1).padStart(6)}`
          + `  halo ${f(m.crownLuma ?? null)} unpainted ${f(m.unpaintedLuma ?? null)}`
          + `  ${tok ? 'ok' : 'FAIL — under ' + HALO_LIFT_MIN}`
          + `${(m.crownLuma as number) < HALO_LUMA_REPORT_AT ? '   (dark livery: draws under ' + HALO_LUMA_REPORT_AT + ', reported not asserted)' : ''}`);
      }
      console.log('');
    }
  }

  await writeFile(resolve(OUT_DIR, 'manifest.json'), JSON.stringify({
    broken: BREAK, liftMin: HALO_LIFT_MIN, visibleLevels: VISIBLE_LEVELS,
    haloSwatchUV: [HALO_U, HALO_V], paintMinNormalY: HALO_PAINT_MIN_NY,
    rows, teamRows,
  }, null, 2), 'utf8');
  await browser.close();
  await server.close();

  const failed = rows.filter((r) => !r.ok);
  const teamFailed = teamRows.filter((r) => !r.ok);
  const lifts = rows.map((r) => r.lift).filter((v): v is number => v !== null)
    .concat(teamRows.map((r) => r.lift).filter((v): v is number => v !== null));
  const lumas = rows.map((r) => r.crownLuma).filter((v): v is number => v !== null);
  const measured = rows.filter((r) => r.invisibleFraction !== null);
  const worstEdge = measured.length
    ? measured.reduce((a, b) =>
      (b.invisibleFraction as number) > (a.invisibleFraction as number) ? b : a)
    : null;
  const meanEdge = measured.length
    ? measured.reduce((s, r) => s + (r.invisibleFraction as number), 0) / measured.length
    : null;

  console.log('\n=== HALO SILHOUETTE — issue #34 ===');
  console.log('ASSERTED: the halo draws at least'
    + ` ${HALO_LIFT_MIN} display levels brighter than the same halo in the same`
    + ' frame with the hardware black put back');
  if (lifts.length) {
    console.log(`  lift over ${lifts.length} measurements:`
      + ` ${Math.min(...lifts).toFixed(1)} .. ${Math.max(...lifts).toFixed(1)}`);
  }
  if (lumas.length) {
    console.log('REPORTED, never asserted: the halo\'s absolute luma —'
      + ` ${Math.min(...lumas).toFixed(1)} .. ${Math.max(...lumas).toFixed(1)}`
      + ` over ${lumas.length} configurations. A dark livery has a dark halo;`
      + ' see HALO_LUMA_REPORT_AT');
  }
  console.log('REPORTED, never asserted: the fraction of the outline with no'
    + ` luma step across it (< ${VISIBLE_LEVELS} display levels)`);
  if (meanEdge !== null) console.log(`  mean:  ${(meanEdge * 100).toFixed(1)}%`);
  if (worstEdge) {
    console.log(`  worst: ${((worstEdge.invisibleFraction as number) * 100).toFixed(1)}%`
      + ` (${worstEdge.circuit} ${worstEdge.ambience} ${worstEdge.mode})`);
  }
  if (dark.length) {
    console.log(`RESIDUAL, reported: ${dark.length} of`
      + ` ${rows.length + teamRows.length} measurements lift by under`
      + ` ${DARK_LIVERY_LIFT} display levels — a dark livery has a dark halo,`
      + ' and whether a dark body should take its accent instead is a look'
      + ' decision nobody has taken (PROJECT.md §7, issue #34)');
    for (const d of dark) console.log(`    ${d}`);
  }
  console.log(`${rows.length - failed.length} ok / ${failed.length} failed`
    + `, plus ${teamRows.length - teamFailed.length} ok /`
    + ` ${teamFailed.length} failed across teams`);
  for (const r of failed) {
    console.log(`  FAIL ${r.circuit} ${r.ambience} ${r.mode}: ${r.note}`);
  }
  for (const r of teamFailed) {
    console.log(`  FAIL team ${r.team} (${r.colour}): lift`
      + ` ${r.lift === null ? 'n/a' : r.lift.toFixed(1)}, bound ${HALO_LIFT_MIN}`);
  }
  console.log(`\nwrote ${OUT_DIR}`);
  if (failed.length || teamFailed.length || paintFail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
