import * as THREE from 'three';
import { CameraDirector, type CameraMode } from '../src/render/CameraDirector';
import {
  HALO_PATH, HALO_PILLAR, HALO_PILLAR_R, HALO_PILLAR_SQUASH, HALO_R, HALO_SQUASH,
  haloRadiusAt,
} from '../src/render/CarMesh';
import {
  DRIVER_EYE_Y, EYE_Y, MIRROR_X, MIRROR_Y, MIRROR_Z, mirrorPaneCorners, WHEEL_Y, WHEEL_Z,
} from '../src/render/CockpitMesh';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * Where the halo actually lands in the frame.
 *
 * The halo has been "fixed" four times and is still wrong, and the reason every
 * one of those passes failed is in the record: each was judged from a
 * screenshot, in words. "Too thick", "sticks out", "cooking me". None of them
 * produced a number, so none of them could be compared with the next one, and
 * twice a change made the framing worse in a way nobody could name.
 *
 * This measures it. The halo's centreline is exported from `CarMesh` — the same
 * array the mesh is swept along, so the measurement and the geometry cannot
 * drift apart — and swept through the REAL `CameraDirector`, on every circuit,
 * in every mode the halo appears in. What comes out is what the reference
 * footage is measured in:
 *
 *   - where the crown of the hoop sits, as a percentage of frame height
 *   - where each rail leaves the frame, and by which edge
 *   - how thick the rail reads, as a percentage of frame WIDTH
 *   - how much of the picture the halo occludes
 *   - and where the horizon, the helmet, the wheel and the mirrors land
 *
 * ASPECT RATIO IS A PARAMETER, not a detail. three.js takes a VERTICAL field of
 * view, so a 2.17:1 phone in landscape and a 16:9 desktop frame the same slice
 * of world top to bottom and the phone sees a fifth more of it across. Anything
 * quoted as a fraction of frame width is therefore a different number on the
 * two, and the reference — Monoposto, 1280x589 — is the phone shape.
 *
 * REFERENCE TARGETS. Measured off `reference/monoposto/f_0100.jpg`,
 * `f_0180.jpg` and `f_0250.jpg`, which are the same onboard at three points of
 * a lap, by overlaying a 64px grid and reading the halo off it:
 *
 *   halo crown, top edge      330..333 of 589   = 56.2% of frame height
 *   rail leaves the frame     bottom edge, x = 200..255 and 1025..1080
 *                                               = 16..20% and 80..84% of width
 *   rail thickness, vertical  44..48 px of 1280 = 3.4..3.8% of frame width
 *   horizon                   ~248 of 589       = 42% of frame height
 *   helmet crown, top edge    ~484 of 589       = 82% of frame height
 *
 * The tolerances below are wide on purpose. This is not trying to reproduce
 * another game frame for frame; it is trying to make the hoop read as a hoop —
 * arcing around the top of the car with its ends leaving through the BOTTOM of
 * the picture — rather than as two diagonals lying across the lower half and
 * running off the sides, which is what the complaint describes and what the
 * measurements below caught.
 */

interface Target {
  /** Crown of the hoop, percentage of frame height. */
  crownPct: [number, number];
  /** Rail thickness, percentage of frame width. */
  thickPct: [number, number];
  /** The thickest the rail may read anywhere in shot, percentage of frame width. */
  thickMaxPct: number;
  /** Horizon, percentage of frame height. */
  horizonPct: [number, number];
  /** Fraction of the frame the halo may occlude, percent. */
  occludePct: [number, number];
  /**
   * Which edge of the frame the rails are SUPPOSED to leave by.
   *
   * This is a per-mode fact and it used to be a global rule, because until now
   * every mode this probe covered was outside the hoop looking at it. From
   * outside, a rail crossing the SIDE edge halfway up the frame is the "black
   * pipe running off the side of the screen" report and is a fault. From the
   * driver's own eye the hoop is AROUND the head, its rear mounts are behind
   * the eye entirely, and the rails necessarily pass out through the sides —
   * that is what the reference onboard shows and what makes it read as a ring
   * you are inside rather than an arch you are approaching. Asserting the
   * cockpit's rule there would fail a correct picture.
   */
  railExit: 'bottom' | 'side';
  /**
   * How far off centre a mirror pane may land, percentage of frame WIDTH.
   *
   * A mirror outside the frame is not a mirror. This is checked in BOTH frame
   * shapes, and the 16:9 one is the binding case: the vertical field of view is
   * shared, so the narrower frame pushes anything measured across the picture
   * further out.
   */
  mirrorMaxXPct: number;
  /**
   * How wide one pane reads, percentage of frame width.
   *
   * The number that decides whether a mirror is legible, and the one nobody
   * measured through four passes of "the mirrors don't work". A pane can be
   * correctly aimed, correctly fed and completely useless.
   */
  panePct: [number, number];
  /**
   * How much of a pane the hoop may lie across, percent.
   *
   * PER MODE, and the three numbers are a finding rather than a tuning. The
   * rear leg of a halo genuinely crosses the mirror line on a real car, and how
   * badly depends entirely on where the eye is: from the driver's own eye the
   * leg passes twelve degrees ABOVE the pane and covers none of it; from the
   * roll-hoop pod it covers a third; from the T-cam, 0.8m further back again,
   * it covers seven tenths. That last one is a mirror that mostly is not there,
   * and it is not fixable from this file — lowering the pane clears it for the
   * T-cam and buries it for the cockpit, which is written up at MIRROR_Y. It is
   * bounded here at what it currently is so that it cannot quietly get worse,
   * and it is the reason the driver's eye is the view to look in.
   */
  paneBlockedMaxPct: number;
  /** Top of the steering wheel rim, percentage of frame height. */
  wheelPct: [number, number];
}

/**
 * Per mode, because the two onboards are at different distances from the hoop
 * and a single thickness band would be wrong for one of them by construction.
 *
 * WHERE THESE SIT AGAINST THE REFERENCE, honestly: the reference rail reads at
 * 3.4-3.8 per cent of frame width and ours reads at 1.6-2.0 from the cockpit
 * and 1.2-1.5 from the T-cam. We are between a half and a third of it and are
 * NOT closing that gap by inflating the part: 42mm at the mounts tapering to
 * 30mm at the crown is the real article's section, and the reference's hoop is
 * either oversized or shot from much closer than any camera that can also see
 * over it. What was closed is the part that was actually wrong — the section
 * was being flattened along the one axis a driver sees it in (see HALO_SQUASH),
 * which had the crown reading at 15mm instead of 23.
 */
const TARGETS: Record<string, Target> = {
  // The DRIVER'S OWN EYE, and it is a different photograph from the two below
  // rather than a tighter version of them. See `DRIVER_EYE_Y` in CockpitMesh.
  //
  // WHERE THESE COME FROM. The hoop's crown is 4.1 degrees above this eye and
  // its rear mounts are 0.47m BEHIND it, so the ring passes overhead and leaves
  // through the sides; the rim's top bar is 10.4 degrees below, so the wheel
  // lies along the bottom third with the gloves under it; and the panes are
  // 0.83m away instead of 1.52m, which is the whole reason this view is the one
  // the mirrors are readable in. The bands below are wide enough to survive
  // eleven circuits' worth of camber and crest and tight enough that the eye
  // cannot drift back out of the car without failing.
  //
  // The rail is thick here and that is honest: the nearest point of the hoop
  // passes 0.42m from the head, where 38mm of titanium subtends five degrees.
  // A driver's-eye view in which the halo is a hairline is a driver's-eye view
  // with the eye in the wrong place.
  driver: {
    crownPct: [30, 52],
    thickPct: [2.0, 7.0],
    thickMaxPct: 12.0,
    horizonPct: [40, 54],
    occludePct: [2.0, 16.0],
    railExit: 'side',
    // 99 means "the whole pane is inside the frame", because what is measured
    // is its OUTBOARD CORNER and 100 is the edge. On 16:9 that corner reaches
    // 93 to 97 per cent of frame width — hard against the edge, which is where
    // a real driver's-eye onboard carries a mirror, and as far in as it can
    // come without either widening the lens past a fisheye or moving the
    // mounting point, which is CarMesh's. Worst case Monza, 97. On the 2.17:1
    // phone the report came from it is 85 to 89, with the pane 6 to 8 per cent
    // of frame width across against the cockpit's 3.9 and the T-cam's 2.9.
    mirrorMaxXPct: 99,
    panePct: [4.0, 12.0],
    paneBlockedMaxPct: 25,
    wheelPct: [52, 76],
  },
  cockpit: {
    crownPct: [48, 70],
    thickPct: [1.4, 4.0],
    thickMaxPct: 6.0,
    horizonPct: [34, 50],
    occludePct: [1.0, 9.0],
    railExit: 'bottom',
    mirrorMaxXPct: 96,
    // Half the driver's, because the eye is nearly twice as far from the pane.
    panePct: [2.0, 7.0],
    paneBlockedMaxPct: 60,
    wheelPct: [62, 86],
  },
  'onboard-t': {
    crownPct: [50, 74],
    thickPct: [1.0, 3.0],
    thickMaxPct: 5.0,
    horizonPct: [34, 50],
    occludePct: [1.0, 7.0],
    railExit: 'bottom',
    mirrorMaxXPct: 96,
    panePct: [1.5, 6.0],
    paneBlockedMaxPct: 80,
    wheelPct: [64, 90],
  },
};

/** Frame shapes measured, and which one the tolerances are written against. */
const FRAMES: [string, number, number][] = [
  ['phone', 1280, 589],
  ['wide', 1280, 720],
];

/** The modes the halo is in shot for. */
const MODES: CameraMode[] = ['driver', 'cockpit', 'onboard-t'];

const config: SessionConfig = {
  kind: 'race',
  name: 'framing probe',
  durationS: 0,
  laps: 5,
  playerIndex: -1,
  standingStart: false,
  pitLaneStart: false,
  seed: 11,
};

/** Rasterisation grid. Wide enough that a 1% feature is ten cells across. */
const GRID_W = 640;

/**
 * The halo's centreline resampled, with the section half-extents at each point.
 *
 * Catmull-Rom, matching `tube`, so the sampled curve is the one the mesh is
 * swept along and not a polyline through the same control points — which
 * differs from it by several millimetres over the crown, where several
 * millimetres is a fifth of the section.
 */
function haloSamples(n: number): { p: THREE.Vector3; rx: number; ry: number }[] {
  const curve = new THREE.CatmullRomCurve3(
    HALO_PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'catmullrom', 0.5,
  );
  const out: { p: THREE.Vector3; rx: number; ry: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k = haloRadiusAt(t) * HALO_R;
    out.push({ p: curve.getPointAt(t), rx: k, ry: k * HALO_SQUASH });
  }
  return out;
}

function pillarSamples(n: number): { p: THREE.Vector3; rx: number; ry: number }[] {
  const a = new THREE.Vector3(...HALO_PILLAR[0]);
  const b = new THREE.Vector3(...HALO_PILLAR[1]);
  const out: { p: THREE.Vector3; rx: number; ry: number }[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({
      p: a.clone().lerp(b, i / n),
      rx: HALO_PILLAR_R * HALO_PILLAR_SQUASH,
      ry: HALO_PILLAR_R,
    });
  }
  return out;
}

/**
 * Car-local to world, for a car at (x, z) on the ground at `y`.
 *
 * The car's ATTITUDE is part of this, not a refinement of it. `Renderer` rolls
 * and pitches the car root by up to 3.4 and 2.9 degrees under load, and the
 * onboard cameras roll and pitch with it — so a probe that projected the halo
 * through a rolled camera onto a car it had assumed was level was measuring up
 * to 5.7 degrees of relative roll that is not in the picture. At the edge of a
 * wide frame that is several per cent of frame width, which is the difference
 * between a mirror this reports as inside the frame and one it reports as
 * outside it. The Euler order is the renderer's own, 'XYZ' on the car root.
 */
function toWorld(
  local: THREE.Vector3, x: number, y: number, z: number, h: number, out: THREE.Vector3,
  roll = 0, pitch = 0,
): THREE.Vector3 {
  out.copy(local);
  if (roll !== 0 || pitch !== 0) out.applyEuler(new THREE.Euler(pitch, 0, roll, 'XYZ'));
  const s = Math.sin(h), c = Math.cos(h);
  return out.set(
    x + out.x * c + out.z * s,
    y + out.y,
    z - out.x * s + out.z * c,
  );
}

interface Mask {
  w: number;
  h: number;
  cells: Uint8Array;
  /** Screen-space bounding rows per column, for thickness and edge crossings. */
  top: Int16Array;
  bottom: Int16Array;
}

function newMask(w: number, h: number): Mask {
  return {
    w, h,
    cells: new Uint8Array(w * h),
    top: new Int16Array(w).fill(-1),
    bottom: new Int16Array(w).fill(-1),
  };
}

/**
 * Stamps a swept section into a screen-space mask.
 *
 * Each sample becomes an axis-aligned ellipse: the hoop's section is a circle
 * of radius r flattened to 0.58r in the car's own y (see `tube`), so its screen
 * half-extents are r across and 0.58r up whichever way the tube is running.
 * Anything behind the eye, or nearer than the near plane, is dropped — a point
 * behind the camera projects to a mirrored position in front of it and would
 * otherwise stamp a phantom hoop in the opposite corner of the frame.
 */
function stamp(
  mask: Mask, cam: THREE.PerspectiveCamera,
  samples: { p: THREE.Vector3; rx: number; ry: number }[],
  carX: number, carY: number, carZ: number, heading: number,
  roll: number, pitch: number,
): void {
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  const tanY = Math.tan((cam.fov * Math.PI) / 360);
  const tanX = tanY * cam.aspect;
  for (const s of samples) {
    toWorld(s.p, carX, carY, carZ, heading, world, roll, pitch);
    view.copy(world).applyMatrix4(cam.matrixWorldInverse);
    const d = -view.z;
    if (d <= cam.near) continue;
    const ndcX = (view.x / d) / tanX;
    const ndcY = (view.y / d) / tanY;
    const halfX = (s.rx / d) / tanX;
    const halfY = (s.ry / d) / tanY;
    const px = (ndcX * 0.5 + 0.5) * mask.w;
    const py = (0.5 - ndcY * 0.5) * mask.h;
    const rw = halfX * 0.5 * mask.w;
    const rh = halfY * 0.5 * mask.h;
    const x0 = Math.max(0, Math.floor(px - rw));
    const x1 = Math.min(mask.w - 1, Math.ceil(px + rw));
    const y0 = Math.max(0, Math.floor(py - rh));
    const y1 = Math.min(mask.h - 1, Math.ceil(py + rh));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const u = (x + 0.5 - px) / Math.max(rw, 0.5);
        const v = (y + 0.5 - py) / Math.max(rh, 0.5);
        if (u * u + v * v > 1) continue;
        mask.cells[y * mask.w + x] = 1;
        if (mask.top[x] < 0 || y < mask.top[x]) mask.top[x] = y;
        if (y > mask.bottom[x]) mask.bottom[x] = y;
      }
    }
  }
}

/** Where a point lands, as percentages of frame width and height. */
function project(
  cam: THREE.PerspectiveCamera, local: THREE.Vector3,
  carX: number, carY: number, carZ: number, heading: number,
  roll: number, pitch: number,
): { xPct: number; yPct: number; inFrame: boolean } | null {
  const world = new THREE.Vector3();
  toWorld(local, carX, carY, carZ, heading, world, roll, pitch);
  const view = world.clone().applyMatrix4(cam.matrixWorldInverse);
  const d = -view.z;
  if (d <= cam.near) return null;
  const tanY = Math.tan((cam.fov * Math.PI) / 360);
  const ndcX = (view.x / d) / (tanY * cam.aspect);
  const ndcY = (view.y / d) / tanY;
  return {
    xPct: (ndcX * 0.5 + 0.5) * 100,
    yPct: (0.5 - ndcY * 0.5) * 100,
    inFrame: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
  };
}

/** The horizon: the direction the camera is looking, flattened to level. */
function horizonPct(cam: THREE.PerspectiveCamera): number {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const level = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
  const view = level.applyQuaternion(cam.quaternion.clone().invert());
  const d = -view.z;
  if (d <= 0) return NaN;
  const ndcY = (view.y / d) / Math.tan((cam.fov * Math.PI) / 360);
  return (0.5 - ndcY * 0.5) * 100;
}

interface Measured {
  crownPct: number;
  crownXPct: number;
  thickPct: number;
  thickMaxPct: number;
  occludePct: number;
  /** Which edge each rail leaves by, and where. */
  exits: string[];
  pillarWidthPct: number;
  horizon: number;
  helmet: string;
  wheel: string;
  /** Top of the steering wheel rim, percentage of frame height. */
  wheelPct: number;
  /** Named by which side of the SCREEN they land on; see `placeBehind`. */
  mirrorScreenL: string;
  mirrorScreenR: string;
  /** The further of the two panes from the centre, percentage of frame width. */
  mirrorOffPct: number;
  /** How wide the wider pane reads, percentage of frame width. */
  panePct: number;
  /** How much of a pane the halo lies across, percent. */
  paneBlockedPct: number;
}

function measure(
  cam: THREE.PerspectiveCamera, rest: THREE.PerspectiveCamera, w: number, h: number,
  carX: number, carY: number, carZ: number, heading: number,
  roll: number, pitch: number,
): Measured {
  const gw = GRID_W;
  const gh = Math.round((GRID_W * h) / w);
  const hoop = newMask(gw, gh);
  stamp(hoop, cam, haloSamples(900), carX, carY, carZ, heading, roll, pitch);
  const pillar = newMask(gw, gh);
  stamp(pillar, cam, pillarSamples(200), carX, carY, carZ, heading, roll, pitch);

  let filled = 0;
  for (let i = 0; i < hoop.cells.length; i++) if (hoop.cells[i]) filled++;
  for (let i = 0; i < pillar.cells.length; i++) if (pillar.cells[i] && !hoop.cells[i]) filled++;

  // Crown: the highest cell of the hoop anywhere in frame.
  let crownY = gh, crownX = -1;
  for (let x = 0; x < gw; x++) {
    if (hoop.top[x] >= 0 && hoop.top[x] < crownY) { crownY = hoop.top[x]; crownX = x; }
  }

  // Thickness: the median vertical run over the columns the hoop occupies,
  // multiplied by the cosine of the local slope so a diagonal rail is measured
  // across itself rather than down the frame.
  const runs: number[] = [];
  for (let x = 4; x < gw - 4; x++) {
    if (hoop.top[x] < 0) continue;
    const run = hoop.bottom[x] - hoop.top[x] + 1;
    // Local slope of the top edge, over eight columns.
    let a = x - 4, b = x + 4;
    if (hoop.top[a] < 0 || hoop.top[b] < 0) continue;
    const slope = (hoop.top[b] - hoop.top[a]) / (b - a);
    runs.push(run / Math.hypot(1, slope));
  }
  runs.sort((p, q) => p - q);
  const thick = runs.length ? runs[Math.floor(runs.length / 2)] : 0;
  // The median is the honest description of the rail; the WORST is what makes
  // it read as a pipe. The old T-cam sat 0.35m from the rails and its median
  // was a modest 1.0 per cent while its thickest visible point was five times
  // that, and it is the thickest point the eye is complaining about.
  const thickMax = runs.length ? runs[runs.length - 1] : 0;

  // Where the rails leave. Walk out from the crown to each side and report the
  // last column the hoop occupies and whether it is against a frame edge.
  const exits: string[] = [];
  for (const dir of [-1, 1]) {
    let x = crownX;
    let last = crownX;
    while (x > 0 && x < gw - 1) {
      x += dir;
      if (hoop.top[x] < 0) break;
      last = x;
    }
    // Leaving through the side is only a fault if it happens ABOVE the bottom
    // eighth of the frame. A rail that clips the very corner on the way out is
    // still a rail going down and out of the picture, which is what the
    // reference does; one that crosses the side edge halfway up the frame is
    // the "black pipe running off the edge of the screen" being complained
    // about, and the two have to be told apart.
    const atSide = (last <= 1 || last >= gw - 2) && hoop.bottom[last] < gh * 0.88;
    const atCorner = last <= 1 || last >= gw - 2;
    const atBottom = hoop.bottom[last] >= gh - 2;
    const where = atSide ? 'SIDE' : atCorner ? 'corner' : atBottom ? 'bottom' : 'stops';
    exits.push(`${where}@x=${((100 * last) / gw).toFixed(0)}%,y=${((100 * hoop.bottom[last]) / gh).toFixed(0)}%`);
  }

  let pw = 0;
  for (let x = 0; x < gw; x++) if (pillar.top[x] >= 0) pw++;

  const at = (v: THREE.Vector3): string => {
    const r = project(cam, v, carX, carY, carZ, heading, roll, pitch);
    if (!r) return 'behind';
    return `${r.xPct.toFixed(0)},${r.yPct.toFixed(0)}${r.inFrame ? '' : '*'}`;
  };

  // --- The mirrors, as areas rather than as points -------------------------
  //
  // The pane's four corners, from the same function the mesh is built with, so
  // this cannot describe a mirror the game does not have. What comes out is the
  // only pair of numbers that decides whether a mirror is usable: how wide it
  // reads, and how much of it the hoop is lying across.
  let panePct = 0;
  let mirrorOffPct = 0;
  let paneBlockedPct = 0;
  for (const side of [1, -1] as const) {
    const corners = mirrorPaneCorners(side);
    // Where it lands is measured with the head STRAIGHT — see `headTurn` — and
    // how big it reads and how much of it the hoop covers are measured through
    // the live camera, because those two do not depend on where the head is
    // pointing and the occlusion very much does depend on the real geometry.
    const restPts = corners.map((c) => project(rest, c, carX, carY, carZ, heading, roll, pitch));
    const pts = corners.map((c) => project(cam, c, carX, carY, carZ, heading, roll, pitch));
    if (pts.some((p) => p === null) || restPts.some((p) => p === null)) continue;
    const xs = pts.map((p) => p!.xPct);
    const ys = pts.map((p) => p!.yPct);
    const wide = Math.max(...xs) - Math.min(...xs);
    if (wide > panePct) panePct = wide;
    const restXs = restPts.map((p) => p!.xPct);
    const cx = (Math.max(...restXs) + Math.min(...restXs)) * 0.5;
    mirrorOffPct = Math.max(mirrorOffPct, Math.max(cx, 100 - cx));

    // How much of the pane's bounding box the hoop's mask covers. Coarse — it
    // is a rectangle against a rasterised silhouette — but it is the same
    // question the eye asks, and a pane that is half black is half a mirror.
    const gx0 = Math.max(0, Math.floor((Math.min(...xs) / 100) * gw));
    const gx1 = Math.min(gw - 1, Math.ceil((Math.max(...xs) / 100) * gw));
    const gy0 = Math.max(0, Math.floor((Math.min(...ys) / 100) * gh));
    const gy1 = Math.min(gh - 1, Math.ceil((Math.max(...ys) / 100) * gh));
    let cells = 0, blocked = 0;
    for (let x = gx0; x <= gx1; x++) {
      for (let y = gy0; y <= gy1; y++) {
        cells++;
        if (hoop.cells[y * gw + x]) blocked++;
      }
    }
    if (cells > 0) paneBlockedPct = Math.max(paneBlockedPct, (100 * blocked) / cells);
  }

  const rimTop = project(
    cam, new THREE.Vector3(0, WHEEL_Y + 0.100, WHEEL_Z), carX, carY, carZ, heading,
    roll, pitch,
  );

  return {
    crownPct: (100 * crownY) / gh,
    crownXPct: (100 * crownX) / gw,
    thickPct: (100 * thick) / gw,
    thickMaxPct: (100 * thickMax) / gw,
    occludePct: (100 * filled) / (gw * gh),
    exits,
    pillarWidthPct: (100 * pw) / gw,
    horizon: horizonPct(cam),
    // The helmet's crown, from DriverMesh: centre 0.672, scaled radius 0.156.
    helmet: at(new THREE.Vector3(0, 0.828, 0)),
    wheel: at(new THREE.Vector3(0, WHEEL_Y + 0.100, WHEEL_Z)),
    wheelPct: rimTop ? rimTop.yPct : NaN,
    mirrorScreenL: at(new THREE.Vector3(MIRROR_X, MIRROR_Y, MIRROR_Z)),
    mirrorScreenR: at(new THREE.Vector3(-MIRROR_X, MIRROR_Y, MIRROR_Z)),
    mirrorOffPct,
    panePct,
    paneBlockedPct,
  };
}

const failures: string[] = [];

console.log(
  'Where the halo lands in the frame, measured off the geometry the mesh is built from,\n' +
  'and how big the mirrors read, measured off the panes the mesh is built from.\n' +
  `Roll-hoop eye ${EYE_Y.toFixed(3)}m; driver's eye ${DRIVER_EYE_Y.toFixed(3)}m.\n` +
  'Reference (Monoposto, 1280x589) for the ROLL-HOOP onboards: crown 56% of frame\n' +
  'height, rails leave through the BOTTOM at 16-20% and 80-84% of width, rail 3.4-3.8%\n' +
  'of frame width thick, horizon 42%, helmet crown 82%.\n' +
  "For the DRIVER's eye the hoop is around the head rather than in front of it, so the\n" +
  'rails are required to leave through the SIDES and the crown sits well above centre.\n',
);
console.log(
  'circuit'.padEnd(13) + 'frame'.padEnd(7) + 'mode'.padEnd(11) +
  'crown'.padStart(7) + 'thick'.padStart(7) + 'occl'.padStart(6) +
  'horiz'.padStart(7) + '  rail exits'.padEnd(34) + 'helmet'.padStart(9) + 'wheel'.padStart(9) +
  'mirror<'.padStart(9) + 'mirror>'.padStart(9) + 'pane'.padStart(7) + 'over'.padStart(6) +
  'edge'.padStart(7),
);

for (const def of CIRCUITS) {
  const engine = new RaceEngine(def, config);
  for (let i = 0; i < Math.round(30 / PHYSICS_DT); i++) engine.step();
  const car = engine.cars[0];
  const carY = engine.track.elevationAt(car.s);

  for (const [frameName, w, h] of FRAMES) {
    for (const mode of MODES) {
      const dir = new CameraDirector(w / h);
      dir.setMode(mode);
      // Let the rig settle exactly as it does in the game before it is read.
      for (let i = 0; i < 20; i++) dir.update(1 / 60, car, engine.track, engine.world);
      const cam = dir.camera;
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      // The same camera with the head put straight, for the resting framing.
      const rest = cam.clone();
      rest.rotation.y -= dir.headTurn;
      rest.updateMatrixWorld(true);
      rest.matrixWorldInverse.copy(rest.matrixWorld).invert();

      const m = measure(
        cam, rest, w, h,
        car.physics.position.x, carY, car.physics.position.y, car.physics.heading,
        dir.chassisRoll, dir.chassisPitch,
      );

      const TARGET = TARGETS[mode];
      const bad: string[] = [];
      if (m.crownPct < TARGET.crownPct[0] || m.crownPct > TARGET.crownPct[1]) {
        bad.push(`crown at ${m.crownPct.toFixed(0)}% of frame height`);
      }
      if (m.thickPct < TARGET.thickPct[0] || m.thickPct > TARGET.thickPct[1]) {
        bad.push(`rail reads ${m.thickPct.toFixed(1)}% of frame width thick`);
      }
      if (m.thickMaxPct > TARGET.thickMaxPct) {
        bad.push(`rail swells to ${m.thickMaxPct.toFixed(1)}% of frame width somewhere in shot`);
      }
      if (m.occludePct > TARGET.occludePct[1]) {
        bad.push(`halo occludes ${m.occludePct.toFixed(1)}% of the picture`);
      }
      if (m.horizon < TARGET.horizonPct[0] || m.horizon > TARGET.horizonPct[1]) {
        bad.push(`horizon at ${m.horizon.toFixed(0)}% of frame height`);
      }
      // Rails leaving by the side are the fault in the two modes that look AT
      // the hoop and the requirement in the one that sits inside it.
      if (TARGET.railExit === 'bottom') {
        for (const e of m.exits) {
          if (e.startsWith('SIDE')) bad.push(`a rail runs off the SIDE of the frame (${e})`);
        }
      } else if (!m.exits.some((e) => e.startsWith('SIDE') || e.startsWith('corner'))) {
        bad.push(
          `neither rail reaches the side of the frame (${m.exits.join(' ')}) — the hoop is ` +
          'in front of the eye rather than around it',
        );
      }

      // --- The mirrors --------------------------------------------------
      if (m.mirrorOffPct > TARGET.mirrorMaxXPct) {
        bad.push(`a mirror lands at ${m.mirrorOffPct.toFixed(0)}% of frame width`);
      }
      if (m.panePct < TARGET.panePct[0] || m.panePct > TARGET.panePct[1]) {
        bad.push(`a mirror pane reads ${m.panePct.toFixed(1)}% of frame width across`);
      }
      if (m.paneBlockedPct > TARGET.paneBlockedMaxPct) {
        bad.push(`the halo lies across ${m.paneBlockedPct.toFixed(0)}% of a mirror`);
      }
      if (m.wheelPct < TARGET.wheelPct[0] || m.wheelPct > TARGET.wheelPct[1]) {
        bad.push(`the wheel rim tops out at ${m.wheelPct.toFixed(0)}% of frame height`);
      }

      console.log(
        def.id.padEnd(13) + frameName.padEnd(7) + mode.padEnd(11) +
        `${m.crownPct.toFixed(0)}%`.padStart(7) +
        `${m.thickPct.toFixed(1)}%`.padStart(7) +
        `${m.thickMaxPct.toFixed(1)}%`.padStart(7) +
        `${m.occludePct.toFixed(1)}%`.padStart(6) +
        `${m.horizon.toFixed(0)}%`.padStart(7) + '  ' +
        m.exits.join(' ').padEnd(32) +
        m.helmet.padStart(9) + m.wheel.padStart(9) + m.mirrorScreenL.padStart(9) + m.mirrorScreenR.padStart(9) +
        `${m.panePct.toFixed(1)}%`.padStart(7) + `${m.paneBlockedPct.toFixed(0)}%`.padStart(6) +
        `${m.mirrorOffPct.toFixed(0)}%`.padStart(7) +
        (bad.length ? '  <-- ' + bad.join('; ') : ''),
      );
      for (const b of bad) failures.push(`${def.id} ${frameName} ${mode}: ${b}`);
    }
  }
}

console.log('');
if (failures.length === 0) {
  console.log('PASS — the halo frames as a hoop on every circuit, in both frame shapes');
} else {
  console.log(`FAILURES (${failures.length}):`);
  const seen = new Set<string>();
  for (const f of failures) {
    // One line per distinct complaint, with the circuits that produce it.
    const key = f.slice(f.indexOf(':'));
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  - ${f}`);
  }
  process.exitCode = 1;
}
