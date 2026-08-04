/**
 * Is the front wing endplate PAINTED — issue #8.
 *
 *   "the front wing and the front is so big versus the back wing is super
 *    tiny."
 *
 * AND IT IS NOT BIG. `probe:carrig` and the Appendix 1 block in `CarMesh.ts`
 * both say so: 1950mm of span and 689mm of chord are the regulation numbers,
 * and the plate's outer skin sits at 975mm, which is the wing's own limit. The
 * issue's own second paragraph is the real complaint: *"The problem is mass,
 * not size: three of four elements plus a 660x410mm endplate each side are
 * near-black, so from above it is the largest dark object on the car."*
 *
 * WHY THIS IS A NEW PROBE AND NOT A LINE IN AN OLD ONE. Three harnesses
 * already look at this part and none of them could catch this. `probe:carrig`
 * asks whether the wing's parts touch and measures its slot gaps — it is green
 * through both the painted and the unpainted version, because it is a geometry
 * question and this is not. `audit:car` writes a `frontWing` PNG for a human to
 * look at, which is PROJECT.md §3.1's definition of not measuring.
 * `probe:grade` takes four statistics over a whole frame and the plate is well
 * under one per cent of it.
 *
 * THE METRIC, AND THE REASON IT IS NOT THE OBVIOUS ONE. `probe:halo` spent a
 * whole pass establishing that an absolute luma floor on a painted part is a
 * bar fitted to the brightest livery on the grid: it separated the arms
 * perfectly on one car and then found three cars, correctly painted, that could
 * not reach it. So this ships the same answer — A PAIRED ARM. The frame is
 * drawn twice in one session, once as it ships and once with the `wingpaint`
 * cell of the REAL atlas overwritten by the REAL `carbon` cell, colour map and
 * surface map both, and the plate is measured in each. Livery, circuit,
 * ambience, exposure, tone curve and camera are identical between the arms by
 * construction, so what is left is the paint. On a build carrying #8 the two
 * texels are the same texel and the lift is 0.0 exactly.
 *
 * TWO CHANNELS, NOT ONE, AND THAT IS THE ONE THING THIS ADDS TO THE HALO'S
 * METHOD. #34's write-up ends on a measured failure: *"luma is blind to hue by
 * construction"* — `monaco day driver` has LESS luma contrast painted than
 * unpainted, because an orange halo lands on the same luma as a mid-grey city.
 * The complaint here is about MASS OF NEAR-BLACK, and near-black is a statement
 * about both channels at once: carbon is `#0f1115`, luma 17 and chroma 6, and
 * every team colour on the grid is above it in at least one. So the lift is
 * measured in luma AND in chroma, both bounded, and the row prints both. A
 * paint that raises one and not the other is reported rather than passed.
 *
 * Run: npm run probe:frontwing
 *   WING_BREAK=1        drives `?wingUnpainted=1` — the real `swatchColour`
 *                       path, not this probe's repaint — and must go red
 *   WING_CIRCUITS=a,b   a shorter sweep
 *   WING_PNG=1          write the frames and the masks to `hud-out/frontwing`
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { swatchUV, swatchPixelRect, wingPaintForTeam } from '../src/render/Livery';
import { WING_PAINT_MIN_NX } from '../src/render/CarMesh';
import { TEAMS } from '../src/data/teams';

const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, msg: string): void {
  if (!ok) failures.push(msg);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
}

const BREAK = process.env.WING_BREAK === '1';
const SAVE_PNG = process.env.WING_PNG === '1';
const SHOT_DIR = resolve(process.cwd(), 'hud-out', 'frontwing');

const ALL_CIRCUITS = [
  'bahrain', 'jeddah', 'monaco', 'silverstone', 'redbullring', 'spa',
  'zandvoort', 'monza', 'suzuka', 'cota', 'interlagos',
];
const CIRCUITS = process.env.WING_CIRCUITS
  ? process.env.WING_CIRCUITS.split(',').map((s) => s.trim()).filter(Boolean)
  : ALL_CIRCUITS;

/**
 * The cameras, and the reason all four are here rather than one.
 *
 * `chase` is what the player actually drives in and it is the view #8 is
 * phrased from — *"from above"*. `drone` is the other elevated one. `tv` and
 * `trackside` are the broadcast lenses and are the two that see the OUTER face
 * of the endplate square on. Reporting only the broadcast pair would flatter a
 * fix nobody driving ever sees; reporting only `chase` would hide the half of
 * the fix that only shows from the side. Every camera's number is printed,
 * including the ones that turn out not to see the wing at all — which is a
 * finding rather than a gap, and it is the finding that made this pass paint
 * the elements as well as the plate.
 */
const CAMERAS = ['chase', 'drone', 'tv', 'trackside'];
const AMBIENCES = ['day', 'night'];

/**
 * The bound, and it is a NOISE FLOOR rather than a quality bar.
 *
 * Three display levels, exactly as `probe:halo`'s is, and for the same measured
 * reason: the paired arm's own numerical noise is what sets it. Two draws of
 * the same scene with one texel changed differ by nothing except that texel,
 * and the residual spread measured over the broken arm — where the two texels
 * are identical and the true lift is zero — is what this has under it. A bar
 * set high enough to fail a dark livery would be a bar demanding that liveries
 * be bleached to satisfy an instrument (§3.3), so dark liveries are COUNTED and
 * PRINTED as a residual instead.
 */
const LIFT_MIN = 3;
/** Below this the paint is reported as buying very little. Not asserted. */
const DARK_LIFT = 20;
/**
 * The two measurement-failure guards, and neither is a tolerance on the paint.
 *
 * A row is asserted only when the camera can see both the OBJECT and some of
 * the CHANGE. Below `MIN_WING_PIXELS` the front wing is not in the picture at
 * all; below `MIN_PAINTED_PIXELS` it is, but none of the surfaces this pass
 * repainted are — from directly behind a car you see the outboard tips of the
 * wing edge-on and its undersides, and no amount of paint on an upper surface
 * or an outer face can change a picture that does not contain either.
 *
 * BOTH KINDS OF ROW ARE PRINTED IN FULL AND COUNTED IN THE SUMMARY, because
 * "the player's default camera sees 0.04% of a frame of front wing and none of
 * it painted" is the single most useful thing this probe measured and burying
 * it in a skip would be the exact failure PROJECT.md §3.2 is about.
 */
const MIN_WING_PIXELS = 300;
const MIN_PAINTED_PIXELS = 150;

const [WING_U, WING_V] = swatchUV('wingpaint');
// A UNIT sheet: the page multiplies by the atlas's real edge, which is 512 on
// the high tier and 256 on the low one. A probe that guessed 512 would measure
// a quarter of the wrong cell on a phone.
const WING_CELL = swatchPixelRect('wingpaint', 1);
const CARBON_CELL = swatchPixelRect('carbon', 1);

/**
 * Installed once per page. Everything runs inside one animation frame: draw the
 * real frame, draw it again with the cell swapped, then two masks, then put
 * everything back. The context has no `preserveDrawingBuffer`, so the drawing
 * buffer only holds what was drawn for the rest of the current task.
 *
 * Every three.js class below is taken off a live object rather than
 * constructed by name — a production bundle has no `THREE` on `window` and no
 * class names left. Same discipline as `probe:halo` and `probe:grain`.
 */
const MEASURE_SRC = String.raw`(() => {
  const g = window.__game;
  const state = { black: null, white: null, plate: null, meshes: null, atlas: null };

  const luma = (d, p) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  /**
   * Chroma as max-minus-min over the three channels.
   *
   * The cheap, monotone stand-in for saturation, and the right one here: the
   * question is "is this pixel a colour or a near-neutral", carbon is
   * \`#0f1115\` at chroma 6, and every candidate paint on the grid is a
   * saturated hue. A perceptual measure (CIE C*) would order the same pairs the
   * same way and would need a colour-space conversion per pixel over a
   * megapixel buffer, twice a row.
   */
  const chroma = (d, p) => Math.max(d[p], d[p+1], d[p+2]) - Math.min(d[p], d[p+1], d[p+2]);

  const EPS = 1e-4;

  /**
   * EVERY mesh whose UVs reach the wingpaint swatch, not the first one.
   *
   * This is the one place the halo's code could not be copied. \`probe:halo\`
   * takes the first hit because the crown lives on the car's single merged
   * shell; the endplate does not — the front wing is its own merged mesh in the
   * damage-part set (\`bodyParts.frontWing\`), because a car can lose it. A
   * search that stopped at the first hit would find whichever of shell and
   * front wing the traversal reached first, and on a car with an undamaged wing
   * that is the shell, which carries no wingpaint UVs at all.
   */
  const findPlates = (root) => {
    const hits = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      const uv = o.geometry.attributes && o.geometry.attributes.uv;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!uv || !mat || !mat.map || !mat.map.image) return;
      let n = 0;
      for (let i = 0; i < uv.count; i++) {
        if (Math.abs(uv.getX(i) - ${WING_U}) < EPS
          && Math.abs(uv.getY(i) - ${WING_V}) < EPS) { n++; if (n > 8) break; }
      }
      if (n > 8) hits.push({ mesh: o, material: mat });
    });
    return hits.length ? hits : null;
  };

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
   * A copy of the atlas that is black everywhere except the wingpaint cell.
   *
   * Used as the map on an UNLIT material, so what lights up is exactly the
   * texels the plate's painted half samples — including the anti-aliased edge
   * of the paint line. Inset by two texels so bilinear filtering at the cell
   * boundary cannot leak white onto the \`carbon\` cell next door, which is
   * every other part of the wing.
   *
   * IT HAS TO BE THE UNLIT CLASS. \`probe:halo\` found this the hard way: a
   * physically-based material with its colour set to black still carries the
   * dielectric Fresnel term, and under a night rig it reflected about four per
   * cent of a bright environment back over the mask threshold on every
   * up-facing surface in frame.
   */
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
      ${WING_CELL.x} * size + INSET, ${WING_CELL.y} * size + INSET,
      ${WING_CELL.w} * size - 2 * INSET, ${WING_CELL.h} * size - 2 * INSET,
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
    state.plate = new Ctor({
      color: 0xffffff, map: maskTexture(mat), fog: false, toneMapped: false,
    });
    return true;
  };

  /** Occlusion-correct: everything still writes depth. */
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
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
        if (m[yy * w + xx]) { hit = 1; break; }
      }
      o[y * w + x] = hit;
    }
    return o;
  };
  const erode = (m, w, h, r) => {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= h || xx >= w || !m[yy * w + xx]) { all = 0; break; }
      }
      o[y * w + x] = all;
    }
    return o;
  };

  const px = (cell, size) => ({
    x: Math.round(cell.x * size), y: Math.round(cell.y * size),
    w: Math.round(cell.w * size), h: Math.round(cell.h * size),
  });
  /**
   * THE PAIRED ARM. Overwrites the wingpaint cell of the REAL atlas with the
   * REAL carbon cell's texel and hands back its own undo.
   *
   * The replacement colour is READ OUT OF THE CARBON CELL rather than written
   * here, so a probe that outlives a change to \`0x0f1115\` cannot keep passing
   * against a stale constant. The surface map goes with the colour map: finish
   * and colour are two textures sampled through the same UV, and swapping only
   * one would leave a second difference between the arms in the one place there
   * must be exactly one.
   */
  const repaintFromCarbon = (tex) => {
    if (!tex || !tex.image || !tex.image.getContext) return null;
    const cvs = tex.image;
    const c2 = cvs.getContext('2d', { willReadFrequently: true });
    const size = cvs.width;
    const plate = px({ x: ${WING_CELL.x}, y: ${WING_CELL.y},
      w: ${WING_CELL.w}, h: ${WING_CELL.h} }, size);
    const carbon = px({ x: ${CARBON_CELL.x}, y: ${CARBON_CELL.y},
      w: ${CARBON_CELL.w}, h: ${CARBON_CELL.h} }, size);
    const before = c2.getImageData(plate.x, plate.y, plate.w, plate.h);
    const t = c2.getImageData(
      carbon.x + (carbon.w >> 1), carbon.y + (carbon.h >> 1), 1, 1).data;
    c2.fillStyle = 'rgb(' + t[0] + ',' + t[1] + ',' + t[2] + ')';
    c2.fillRect(plate.x, plate.y, plate.w, plate.h);
    tex.needsUpdate = true;
    return () => { c2.putImageData(before, plate.x, plate.y); tex.needsUpdate = true; };
  };

  /**
   * Forget which meshes the plate was found on.
   *
   * Section 3 moves the camera to another team's car and every car has its own
   * merged wing. Without this the mask keeps pointing at the first car's
   * geometry and measures a vehicle that is no longer in front of the camera —
   * a mask that is stale rather than empty, which does not announce itself.
   */
  g.__wingReset = () => { state.meshes = null; };

  g.__wingMeasure = () => new Promise((res) => {
    requestAnimationFrame(() => {
      const scene = g.renderer.scene;
      const cam = g.renderer.director.camera;
      const idx = g.engine.cars.indexOf(g.__focus);
      const visual = g.renderer.carVisuals[idx];
      if (!visual) { res({ error: 'no car visual for the focus car' }); return; }

      if (!state.meshes) state.meshes = findPlates(visual.root);
      if (!state.meshes) {
        res({ error: 'no mesh on the car has UVs at the wingpaint swatch — the'
          + ' endplate is not painted, or the swatch layout moved' });
        return;
      }
      if (!materials(scene, state.meshes[0].material)) {
        res({ error: 'no unlit material anywhere in the scene to build the mask'
          + ' out of — see findBasicCtor' });
        return;
      }

      const src = document.querySelector('canvas');
      const w = src.width, h = src.height;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });

      // Eight frames before every read, and the same eight before each arm:
      // the post chain's exposure adapts, and a frame taken straight after a
      // texture changed is measured part way through the adaptation.
      const drawN = (n) => {
        for (let i = 0; i < n; i++) g.renderer.render(1 / 60, 1, g.engine, g.__focus);
      };

      // FREEZE THE CAMERA FOR THE DURATION OF THE PAIR, and this is not a
      // convenience — it is what makes the paired arm paired at all.
      //
      // \`Renderer.render\` calls \`director.update(dt, ...)\` every frame, and
      // three of the four camera modes here are time-based: \`drone\` orbits,
      // \`tv\` and \`trackside\` pan. So the eight settling frames between the
      // two reads MOVE THE LENS, and the difference between the arms then
      // contains a camera move as well as the paint. Measured, on the broken
      // arm where the true lift is zero by construction: luma came back
      // 4.1-5.7 instead of 0, which is most of the way to the fixed arm's 6.6
      // at Silverstone in daylight. The chroma channel was clean at
      // -4.2..+2.6 because a small camera move changes shading far more than
      // it changes hue — which is the same asymmetry #34 found from the other
      // side, and it is a reason to fix the instrument rather than to trust
      // whichever channel happened to survive it.
      //
      // Stubbed on the PROTOTYPE, like \`updateResolutionScale\` above, so the
      // real \`Renderer.render\` path is otherwise untouched.
      const dirProto = Object.getPrototypeOf(g.renderer.director);
      const realUpdate = dirProto.update;
      dirProto.update = function () {};
      const unfreeze = () => { dirProto.update = realUpdate; };

      drawN(8);
      cx.drawImage(src, 0, 0);
      const img = cx.getImageData(0, 0, w, h).data;

      const mat0 = state.meshes[0].material;
      const undoColour = repaintFromCarbon(mat0.map);
      const undoSurface = repaintFromCarbon(mat0.roughnessMap || mat0.metalnessMap);
      let imgBare = null;
      if (undoColour) {
        drawN(8);
        cx.drawImage(src, 0, 0);
        imgBare = cx.getImageData(0, 0, w, h).data;
        undoColour();
        if (undoSurface) undoSurface();
        // Back to where the painted arm was, so the masks below are taken
        // against the same exposure the first read saw.
        drawN(8);
      }

      const gl = g.renderer.renderer;
      beginMask(scene, gl);
      const plateOnly = new Map();
      for (const m of state.meshes) plateOnly.set(m.mesh, state.plate);
      let saved = blackout(scene, plateOnly);
      gl.render(scene, cam);
      restore(saved);
      cx.drawImage(src, 0, 0);
      const plateMask = binary(cx.getImageData(0, 0, w, h).data, w, h);
      // THE WHOLE ASSEMBLY, not just its painted half — and this is the mask
      // the assertion is on. Only the front wing's own merged meshes carry
      // wingpaint UVs, so the meshes already found ARE the assembly: every
      // element, both endplates, both footplates, the flicks and the
      // diveplanes. The question #8 asks is whether the WING reads dark, and
      // the painted half alone cannot answer it — a fix that lights up its own
      // mask and leaves the object as dark as it was would pass.
      const wingWhite = new Map();
      for (const m of state.meshes) wingWhite.set(m.mesh, state.white);
      saved = blackout(scene, wingWhite);
      gl.render(scene, cam);
      restore(saved);
      cx.drawImage(src, 0, 0);
      const wingMask = binary(cx.getImageData(0, 0, w, h).data, w, h);
      const carWhite = new Map();
      visual.root.traverse((o) => { if (o.material) carWhite.set(o, state.white); });
      saved = blackout(scene, carWhite);
      gl.render(scene, cam);
      restore(saved);
      cx.drawImage(src, 0, 0);
      const carMask = binary(cx.getImageData(0, 0, w, h).data, w, h);
      endMask(scene, gl);

      // Erode the plate by one pixel so a partially covered edge texel — half
      // plate, half whatever is behind it — is not counted as plate. Dilate the
      // car by two so nothing within two pixels of the car's own silhouette is
      // counted as background.
      const plateIn = erode(plateMask, w, h, 1);
      const wingIn = erode(wingMask, w, h, 1);
      const carOut = dilate(carMask, w, h, 2);
      const near = dilate(wingMask, w, h, 8);
      let pN = 0;
      let wL = 0, wC = 0, wN = 0, bL = 0, bC = 0, bN = 0, uL = 0, uC = 0;
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        if (plateIn[i]) pN++;
        if (wingIn[i]) {
          wL += luma(img, p); wC += chroma(img, p); wN++;
          if (imgBare) { uL += luma(imgBare, p); uC += chroma(imgBare, p); }
        } else if (near[i] && !carOut[i]) { bL += luma(img, p); bC += chroma(img, p); bN++; }
      }

      unfreeze();

      let dump = null;
      if (${SAVE_PNG ? 'true' : 'false'}) {
        cx.drawImage(src, 0, 0);
        dump = cv.toDataURL('image/png');
      }

      res({
        width: w, height: h,
        meshes: state.meshes.length,
        wingPixels: wN,
        platePixels: pN,
        paintedFraction: wN ? pN / wN : null,
        wingLuma: wN ? wL / wN : null,
        wingChroma: wN ? wC / wN : null,
        bareLuma: (wN && imgBare) ? uL / wN : null,
        bareChroma: (wN && imgBare) ? uC / wN : null,
        bgLuma: bN ? bL / bN : null,
        bgChroma: bN ? bC / bN : null,
        bgPixels: bN,
        frameFraction: wN / (w * h),
        dump: dump,
      });
    });
  });
})()`;

interface Measure {
  error?: string;
  width: number;
  height: number;
  meshes: number;
  /** Visible pixels of the WHOLE front wing assembly. The assertion is on this. */
  wingPixels: number;
  /** Of those, how many are on a surface this pass painted. */
  platePixels: number;
  paintedFraction: number | null;
  wingLuma: number | null;
  wingChroma: number | null;
  bareLuma: number | null;
  bareChroma: number | null;
  bgLuma: number | null;
  bgChroma: number | null;
  bgPixels: number;
  frameFraction: number;
  dump: string | null;
}

function f(v: number | null, w = 6, d = 1): string {
  return v === null ? 'n/a'.padStart(w) : v.toFixed(d).padStart(w);
}

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

async function main(): Promise<void> {
  // =========================================================================
  // 1. THE PAINT RULE, FOR EVERY TEAM, IN NODE
  // =========================================================================
  //
  // No browser and no frame: `wingPaintForTeam` is the rule itself, exported
  // from `Livery.ts` so this cannot hold a copy of it. The question it answers
  // is the one the halo's §1 answers — a paint darker than the bare part it
  // goes over is not a paint — and that is what puts a team on its accent.
  console.log('\n1. THE PAINT RULE, ALL TEAMS (node)');
  console.log(`   the paint line is |n.x| >= ${WING_PAINT_MIN_NX} outboard ` +
    `(${(Math.acos(WING_PAINT_MIN_NX) * 180 / Math.PI).toFixed(0)}° off outboard)`);
  let paintFail = false;
  for (const t of TEAMS) {
    const p = wingPaintForTeam(t.colour, t.accent);
    const ok = p.luminance > p.carbonLuminance;
    const onAccent = p.colour !== t.colour;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${t.id.padEnd(14)} ` +
      `body #${t.colour.toString(16).padStart(6, '0')} (lum ${p.bodyLuminance.toFixed(3)}) ` +
      `-> paint #${p.colour.toString(16).padStart(6, '0')} (lum ${p.luminance.toFixed(3)})` +
      `${onAccent ? '  [on its accent]' : ''}`);
    if (!ok) { paintFail = true; failures.push(`${t.id}: the endplate paint is no lighter than the carbon it covers`); }
  }
  console.log(`  carbon it replaces: luminance ` +
    `${wingPaintForTeam(0, 0).carbonLuminance.toFixed(3)}`);

  // =========================================================================
  // 2. THE PAINTED FRACTION OF THE PLATE, IN A REAL FRAME
  // =========================================================================
  const server: ViteDevServer = await createServer({
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('vite gave no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    protocolTimeout: 15 * 60_000,
    args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
  });

  interface Row {
    circuit: string; ambience: string; mode: string;
    wingPixels: number; platePixels: number; paintedFraction: number | null;
    frameFraction: number;
    wingLuma: number | null; bareLuma: number | null; lumaLift: number | null;
    wingChroma: number | null; bareChroma: number | null; chromaLift: number | null;
    bgLuma: number | null; bgChroma: number | null;
    ok: boolean; note: string;
  }
  const rows: Row[] = [];
  const dark: string[] = [];

  console.log(`\n2. THE PLATE IN A FINISHED FRAME — ${CIRCUITS.length} circuits x ` +
    `${AMBIENCES.length} ambiences x ${CAMERAS.length} cameras` +
    `${BREAK ? '  (WING_BREAK=1: ?wingUnpainted=1)' : ''}`);
  if (SAVE_PNG) await mkdir(SHOT_DIR, { recursive: true });

  for (const id of CIRCUITS) {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const errs: string[] = [];
    page.on('pageerror', (e: unknown) => { errs.push(String(e)); });
    const q = `${url}?circuit=${id}&session=race&rolling=1&laps=5&seed=7&quality=high`
      + (BREAK ? '&wingUnpainted=1' : '');
    await page.goto(q, { waitUntil: 'load', timeout: 240_000 });
    await page.waitForFunction(
      "!!window.__game && window.__game.screen === 'racing'",
      { timeout: 420_000, polling: 250 });
    await page.evaluate('window.__game.clock.paused = true');
    const settled = await page.evaluate('window.__game.renderer.resolutionScale') as number;

    await page.evaluate(`(() => {
      const g = window.__game;
      cancelAnimationFrame(g.rafHandle);
      for (let i = 0; i < 600; i++) { g.engine.step(); if (g.engine.over) break; }
      g.__focus = g.engine.cars.find((c) => !c.retired) || g.engine.cars[0];
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
    await page.evaluate(MEASURE_SRC);

    for (const amb of AMBIENCES) {
      await page.evaluate(`(() => {
        const g = window.__game;
        g.engine.track.def.ambience = ${JSON.stringify(amb)};
        Object.getPrototypeOf(g.renderer).applyAmbience.call(g.renderer, g.engine);
      })()`);
      for (const mode of CAMERAS) {
        await page.evaluate(
          `window.__game.renderer.director.setMode(${JSON.stringify(mode)})`);
        await page.evaluate('window.__game.__stop = false');
        await page.evaluate('window.__game.__draw(120)');
        await page.evaluate('window.__game.__stop = true');
        const m = await page.evaluate('window.__game.__wingMeasure()') as Measure;

        const where = `${id} ${amb} ${mode}`;
        if (m.error) {
          rows.push({
            circuit: id, ambience: amb, mode, wingPixels: 0, platePixels: 0,
            paintedFraction: null, frameFraction: 0,
            wingLuma: null, bareLuma: null, lumaLift: null,
            wingChroma: null, bareChroma: null, chromaLift: null,
            bgLuma: null, bgChroma: null, ok: false, note: m.error,
          });
          failures.push(`${where}: ${m.error}`);
          continue;
        }
        const lumaLift = m.wingLuma !== null && m.bareLuma !== null
          ? m.wingLuma - m.bareLuma : null;
        const chromaLift = m.wingChroma !== null && m.bareChroma !== null
          ? m.wingChroma - m.bareChroma : null;
        const rowNotes: string[] = [];

        // THE MEASUREMENT-FAILED GUARD, and it is not a tolerance on the paint.
        // Too few wing pixels means the camera cannot see the front wing at
        // all — a fact about the lens, not about the livery — so the row is
        // REPORTED and skipped rather than failed.
        if (m.wingPixels < MIN_WING_PIXELS || m.platePixels < MIN_PAINTED_PIXELS) {
          const why = m.wingPixels < MIN_WING_PIXELS
            ? `only ${m.wingPixels}px of front wing in frame`
            : `${m.wingPixels}px of front wing in frame and ${m.platePixels}px of it painted`;
          rows.push({
            circuit: id, ambience: amb, mode, wingPixels: m.wingPixels,
            platePixels: m.platePixels, paintedFraction: m.paintedFraction,
            frameFraction: m.frameFraction,
            wingLuma: m.wingLuma, bareLuma: m.bareLuma, lumaLift,
            wingChroma: m.wingChroma, bareChroma: m.bareChroma, chromaLift,
            bgLuma: m.bgLuma, bgChroma: m.bgChroma, ok: true,
            note: `${why} — not measured`,
          });
          notes.push(`${where}: ${why}`);
          continue;
        }
        if (lumaLift === null || chromaLift === null) {
          rowNotes.push('the paired arm produced nothing — the atlas could not be'
            + ' repainted, so there is no bare frame to measure against');
        } else {
          if (lumaLift < LIFT_MIN) {
            rowNotes.push(`the front wing lifts ${lumaLift.toFixed(1)} display levels of `
              + `LUMA over the carbon it replaces, against a ${LIFT_MIN}-level noise floor`);
          }
          if (chromaLift < LIFT_MIN) {
            rowNotes.push(`the front wing lifts ${chromaLift.toFixed(1)} levels of CHROMA `
              + `over the carbon it replaces, against a ${LIFT_MIN}-level noise floor — `
              + 'the paint is there and it is still a neutral');
          }
          if (lumaLift < DARK_LIFT || chromaLift < DARK_LIFT) {
            dark.push(`${where}: luma ${lumaLift.toFixed(1)}, chroma ${chromaLift.toFixed(1)}`);
          }
        }
        const ok = rowNotes.length === 0;
        for (const n of rowNotes) failures.push(`${where}: ${n}`);
        rows.push({
          circuit: id, ambience: amb, mode, wingPixels: m.wingPixels,
          platePixels: m.platePixels, paintedFraction: m.paintedFraction,
          frameFraction: m.frameFraction,
          wingLuma: m.wingLuma, bareLuma: m.bareLuma, lumaLift,
          wingChroma: m.wingChroma, bareChroma: m.bareChroma, chromaLift,
          bgLuma: m.bgLuma, bgChroma: m.bgChroma, ok, note: '',
        });
        if (SAVE_PNG && m.dump) {
          await writeFile(resolve(SHOT_DIR, `${id}-${amb}-${mode}.png`),
            Buffer.from(m.dump.split(',')[1], 'base64'));
        }
      }
    }
    console.log(`  ${id} (resolution scale ${settled.toFixed(2)})` +
      (errs.length ? `  ${errs.length} page errors` : ''));
    for (const e of errs) failures.push(`${id}: pageerror: ${e}`);
    await page.close();
  }

  console.log('\n  circuit      amb    camera       wing px paint%  frame%   luma  bare  ' +
    ' LIFT  chroma bare  LIFT   bg L/C');
  for (const r of rows) {
    console.log(`  ${r.circuit.padEnd(12)} ${r.ambience.padEnd(6)} ${r.mode.padEnd(11)} ` +
      `${String(r.wingPixels).padStart(8)} ` +
      `${(r.paintedFraction === null ? '  n/a' : (r.paintedFraction * 100).toFixed(1)).padStart(6)} ` +
      `${(r.frameFraction * 100).toFixed(3).padStart(7)} ` +
      `${f(r.wingLuma, 6, 1)}${f(r.bareLuma, 6, 1)}${f(r.lumaLift, 6, 1)} ` +
      `${f(r.wingChroma, 6, 1)}${f(r.bareChroma, 6, 1)}${f(r.chromaLift, 6, 1)}  ` +
      `${f(r.bgLuma, 5, 0)}/${f(r.bgChroma, 4, 0)}` +
      (r.note ? `   ${r.note}` : ''));
  }

  const measured = rows.filter((r) => r.lumaLift !== null && !r.note);
  const lifts = measured.map((r) => r.lumaLift!).sort((a, b) => a - b);
  const clifts = measured.map((r) => r.chromaLift!).sort((a, b) => a - b);
  console.log('');
  console.log(`  ${measured.length} of ${rows.length} rows measured; ` +
    `${rows.length - measured.length} had too little of the wing, or of the paint, in frame`);
  if (lifts.length) {
    console.log(`  LUMA lift   ${lifts[0].toFixed(1)} .. ${lifts[lifts.length - 1].toFixed(1)}` +
      `  median ${lifts[lifts.length >> 1].toFixed(1)}`);
    console.log(`  CHROMA lift ${clifts[0].toFixed(1)} .. ${clifts[clifts.length - 1].toFixed(1)}` +
      `  median ${clifts[clifts.length >> 1].toFixed(1)}`);
  }
  for (const r of rows) if (!r.ok && !r.note) check(false, `${r.circuit} ${r.ambience} ${r.mode}`);

  // =========================================================================
  // 3. NINE OTHER TEAMS' CARS, ON THE SAME GRID
  // =========================================================================
  //
  // Straight out of `probe:halo`'s own hard-won lesson: 44 rows behind ONE car
  // says nothing about the darkest livery on the grid, and a bound met by the
  // brightest is a bound that would demand three liveries be bleached. So the
  // camera moves to nine other cars in the same session and asserts the same
  // noise floor on each.
  console.log('\n3. THE SAME FRAME, BEHIND NINE OTHER TEAMS\' CARS');
  {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const q = `${url}?circuit=silverstone&session=race&rolling=1&laps=5&seed=7&quality=high`
      + (BREAK ? '&wingUnpainted=1' : '');
    await page.goto(q, { waitUntil: 'load', timeout: 240_000 });
    await page.waitForFunction(
      "!!window.__game && window.__game.screen === 'racing'",
      { timeout: 420_000, polling: 250 });
    await page.evaluate('window.__game.clock.paused = true');
    await page.evaluate(`(() => {
      const g = window.__game;
      cancelAnimationFrame(g.rafHandle);
      for (let i = 0; i < 600; i++) { g.engine.step(); if (g.engine.over) break; }
      Object.getPrototypeOf(g.renderer).updateResolutionScale = function () {};
      g.__draw = (n) => new Promise((res) => {
        const tick = () => {
          g.renderer.render(1 / 60, 1, g.engine, g.__focus);
          if (n-- > 0 && !g.__stop) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
    })()`);
    await page.evaluate(MEASURE_SRC);
    // `drone`, not `tv`: §2 measured the whole wing at ~150px from the broadcast
    // lenses, which is too little of the object to say anything about eleven
    // liveries. `drone` puts 14,000-20,000px of it in frame.
    await page.evaluate('window.__game.renderer.director.setMode("drone")');

    const teams = await page.evaluate(`(() => {
      const seen = new Map();
      for (const c of window.__game.engine.cars) {
        if (!c.retired && !seen.has(c.team.id)) seen.set(c.team.id, c.index);
      }
      return [...seen.entries()].slice(0, 10);
    })()`) as [string, number][];

    for (const [teamId, index] of teams) {
      await page.evaluate(`(() => {
        const g = window.__game;
        g.__focus = g.engine.cars[${index}];
        g.__wingReset();
      })()`);
      await page.evaluate('window.__game.__stop = false');
      await page.evaluate('window.__game.__draw(120)');
      await page.evaluate('window.__game.__stop = true');
      const m = await page.evaluate('window.__game.__wingMeasure()') as Measure;
      if (m.error) { check(false, `${teamId}: ${m.error}`); continue; }
      const lift = m.wingLuma !== null && m.bareLuma !== null ? m.wingLuma - m.bareLuma : null;
      const cl = m.wingChroma !== null && m.bareChroma !== null
        ? m.wingChroma - m.bareChroma : null;
      if (m.wingPixels < MIN_WING_PIXELS || m.platePixels < MIN_PAINTED_PIXELS) {
        console.log(`  ${teamId.padEnd(14)} ${m.wingPixels}px of front wing, ` +
          `${m.platePixels}px painted — not measured`);
        notes.push(`${teamId}: ${m.wingPixels}px of front wing, ${m.platePixels}px painted`);
        continue;
      }
      console.log(`  ${teamId.padEnd(14)} ${String(m.wingPixels).padStart(6)}px, ` +
        `${((m.paintedFraction ?? 0) * 100).toFixed(1)}% painted  ` +
        `luma ${f(m.wingLuma)} vs ${f(m.bareLuma)} lift ${f(lift)}  ` +
        `chroma ${f(m.wingChroma)} vs ${f(m.bareChroma)} lift ${f(cl)}`);
      check(lift !== null && lift >= LIFT_MIN && cl !== null && cl >= LIFT_MIN,
        `${teamId}: the front wing lifts ${f(lift)} luma and ${f(cl)} chroma over the ` +
        `carbon it replaces, against a ${LIFT_MIN}-level noise floor`);
      if (lift !== null && cl !== null && (lift < DARK_LIFT || cl < DARK_LIFT)) {
        dark.push(`${teamId}: luma ${lift.toFixed(1)}, chroma ${cl.toFixed(1)}`);
      }
    }
    await page.close();
  }

  await browser.close();
  await server.close();

  // =========================================================================
  console.log('');
  if (dark.length) {
    console.log(`REPORTED, NOT FAILED — ${dark.length} measurements lift by under ` +
      `${DARK_LIFT} in one channel. A dark livery gets a dark endplate, which is what a ` +
      'dark car\'s endplate looks like; a bar set above these is a bar demanding that ' +
      'those liveries be bleached (PROJECT.md §3.3).');
    for (const d of dark.slice(0, 12)) console.log('  ' + d);
    if (dark.length > 12) console.log(`  ... and ${dark.length - 12} more`);
  }
  if (notes.length) {
    console.log(`\nREPORTED, NOT FAILED — ${notes.length} views cannot see this fix, and ` +
      'that is the honest limit of it. Two different reasons, and both are findings:');
    console.log('  - `chase`, the player\'s DEFAULT camera, sees about 340px of front wing ' +
      'on a 1280x720 frame (0.04%) and NONE of it is a surface this paints: from directly ' +
      'behind a car what is in shot is the outboard tips edge-on and the undersides. #8\'s ' +
      '"from above it is the largest dark object on the car" is a `drone`/garage/paddock ' +
      'observation, not a chase-camera one, and that is where this pass is measured.');
    console.log('  - `tv` and `trackside` put the car far enough away that the whole wing ' +
      'is ~150px. They see the endplate\'s outer face square on and there is not enough ' +
      'of it to measure.');
    for (const n of notes.slice(0, 8)) console.log('  ' + n);
    if (notes.length > 8) console.log(`  ... and ${notes.length - 8} more`);
  }

  console.log('');
  if (failures.length === 0 && !paintFail) {
    console.log(`PASS — the front wing endplate's outer face carries the team's own paint, ` +
      'measured as a paired difference against the carbon it replaces, in luma and in chroma.');
  } else {
    console.log(`${failures.length} failed:`);
    for (const x of failures) console.log('  - ' + x);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
