import * as THREE from 'three';
import { CameraDirector, type CameraMode } from '../src/render/CameraDirector';
import {
  HALO_PATH, HALO_PILLAR, HALO_PILLAR_R, HALO_PILLAR_SQUASH, HALO_R, HALO_SQUASH,
  haloRadiusAt,
} from '../src/render/CarMesh';
import {
  DRIVER_EYE_Y, EYE_Y, MIRROR_X, MIRROR_Y, MIRROR_Z, mirrorPaneCorners,
  WHEEL_Y, WHEEL_Z,
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
   * Which edge the rails are expected to leave the frame by.
   *
   * 'bottom' for the two roll-hoop cameras, which stand behind and above the
   * hoop and see it as an arc with both ends running down out of the picture;
   * a rail crossing the SIDE edge halfway up the frame is the "black pipe
   * running off the edge of the screen" complaint and is a fault.
   *
   * 'side' for the driver's eye, where the SAME fault would be the assertion
   * inverted. The hoop passes BESIDE the driver's head and its mounts are
   * behind him, so its rails necessarily leave through the sides — and a
   * driver's-eye view whose rails ran out of the bottom of the frame would mean
   * the camera had climbed back out onto the fairing.
   */
  railsExit: 'bottom' | 'side';
  /**
   * Where the halo's crown must sit relative to the HORIZON.
   *
   * The single number that says which of the two families of onboard this is,
   * and the one thing about the driver's-eye view that cannot be got by moving
   * an existing camera. From a pod above the driver you look DOWN over the
   * hoop and its crown is below the horizon; from the seat you look UP at it
   * and it arcs across the sky. Crown percentages alone cannot express that,
   * because both numbers move together when the pitch changes.
   */
  crownVsHorizon: 'above' | 'below';
  /**
   * Whether the whole of both mirror panes has to be inside the frame, and how
   * much of each must be clear of the halo.
   *
   * A MIRROR THAT IS CROPPED OR COVERED IS INDISTINGUISHABLE FROM A BROKEN ONE,
   * which is the whole of the second half of the report this probe was extended
   * for. Null where a mode is not held to it.
   */
  mirrorClearPct: number | null;
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
  cockpit: {
    crownPct: [48, 70],
    thickPct: [1.4, 4.0],
    thickMaxPct: 6.0,
    horizonPct: [34, 50],
    occludePct: [1.0, 9.0],
    railsExit: 'bottom',
    crownVsHorizon: 'below',
    mirrorClearPct: null,
  },
  'onboard-t': {
    crownPct: [50, 74],
    thickPct: [1.0, 3.0],
    thickMaxPct: 5.0,
    horizonPct: [34, 50],
    occludePct: [1.0, 7.0],
    railsExit: 'bottom',
    crownVsHorizon: 'below',
    mirrorClearPct: null,
  },
  /**
   * The driver's own eyes.
   *
   * THESE ARE NOT THE MONOPOSTO NUMBERS AND MUST NOT BE. The reference set is
   * 286 frames of one camera — a pod behind and above the helmet, with the
   * crown of the driver's own helmet in the bottom of the picture — and it is
   * the camera `cockpit` and `onboard-t` already reproduce. A driver cannot see
   * his own helmet, so no frame in that set shows what this mode shows and no
   * tolerance can be lifted from it.
   *
   * What CAN be lifted from it is the pair of things the reference proves about
   * this car at this scale — where a horizon belongs in a racing frame, and how
   * thick a halo rail reads when you are close to it — and those are the two
   * bands below that overlap the reference at all. The rest is solved from the
   * geometry:
   *
   *   halo crown       ABOVE the horizon, 18-34% of frame height. From an eye
   *                    at 0.720 the crown at 0.812 is 8.4 degrees UP, and on a
   *                    58-degree lens pitched 4 down the topmost cell of the
   *                    hoop lands around a quarter of the way down the frame.
   *   rail thickness   2.0-4.2% of frame width. The reference reads 3.4-3.8,
   *                    and this is the FIRST camera in the project that gets
   *                    there honestly rather than by inflating the part: the
   *                    crown is 0.62m from the eye instead of 1.15m, so a 30mm
   *                    blade subtends what a 30mm blade should.
   *   horizon          40-48%. The reference carries it at 42.
   *   occlusion        up to 16%, against the roll hoop's 9. More of the frame
   *                    is halo because more of the halo is in the frame — from
   *                    the seat the hoop wraps past both ears — and this is the
   *                    honest cost of the view rather than a defect in it.
   *   mirrors          both panes wholly in frame, and 92% of each clear of the
   *                    halo. See `mirrorClearPct`: from the roll hoop the rear
   *                    leg of the hoop lies across the pane and leaves 44-62%
   *                    of it, and that is most of why the mirrors have never
   *                    read as working.
   */
  driver: {
    crownPct: [18, 34],
    thickPct: [2.0, 4.2],
    thickMaxPct: 6.5,
    horizonPct: [40, 48],
    occludePct: [1.0, 16.0],
    railsExit: 'side',
    crownVsHorizon: 'above',
    mirrorClearPct: 92,
  },
};

/** Frame shapes measured, and which one the tolerances are written against. */
const FRAMES: [string, number, number][] = [
  ['phone', 1280, 589],
  ['wide', 1280, 720],
];

/** The modes the halo is in shot for. */
const MODES: CameraMode[] = ['cockpit', 'driver', 'onboard-t'];

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

/** Car-local to world, for a car at (x, z) on the ground at `y` heading `h`. */
function toWorld(
  local: THREE.Vector3, x: number, y: number, z: number, h: number, out: THREE.Vector3,
): THREE.Vector3 {
  const s = Math.sin(h), c = Math.cos(h);
  return out.set(
    x + local.x * c + local.z * s,
    y + local.y,
    z - local.x * s + local.z * c,
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
): void {
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  const tanY = Math.tan((cam.fov * Math.PI) / 360);
  const tanX = tanY * cam.aspect;
  for (const s of samples) {
    toWorld(s.p, carX, carY, carZ, heading, world);
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
): { xPct: number; yPct: number; inFrame: boolean } | null {
  const world = new THREE.Vector3();
  toWorld(local, carX, carY, carZ, heading, world);
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

/**
 * How much of one mirror pane a driver can actually use.
 *
 * The pane's four corners are taken from `mirrorPaneCorners` — the same
 * function the renderer builds the mesh with, so the measurement and the
 * geometry cannot drift apart — projected, and the bounding box walked cell by
 * cell against the halo's mask.
 *
 * TWO SEPARATE WAYS A MIRROR FAILS, and they need separate numbers because
 * they have completely different fixes: it can be off the edge of the picture,
 * which is a field-of-view problem, or it can be behind a black tube, which is
 * a geometry problem. `inFrame` is the first and `clear` the second.
 *
 * The halo is treated as opaque wherever it covers the pane. That is
 * conservative — a rail BEHIND the pane would be occluded by it rather than the
 * other way round — but at both onboard eye points the leg that crosses the
 * mirror line is nearer to the eye than the mirror is, so at these eye points
 * it is also simply true.
 */
function measureMirror(
  hoop: Mask, pillar: Mask, cam: THREE.PerspectiveCamera,
  corners: THREE.Vector3[],
  carX: number, carY: number, carZ: number, heading: number,
): { inFrame: boolean; clearPct: number; widthPct: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  let allInFrame = true;
  for (const c of corners) {
    const r = project(cam, c, carX, carY, carZ, heading);
    if (!r) return { inFrame: false, clearPct: 0, widthPct: 0 };
    if (!r.inFrame) allInFrame = false;
    xs.push(r.xPct);
    ys.push(r.yPct);
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);

  const cx0 = Math.max(0, Math.floor((x0 / 100) * hoop.w));
  const cx1 = Math.min(hoop.w - 1, Math.ceil((x1 / 100) * hoop.w));
  const cy0 = Math.max(0, Math.floor((y0 / 100) * hoop.h));
  const cy1 = Math.min(hoop.h - 1, Math.ceil((y1 / 100) * hoop.h));
  let total = 0, covered = 0;
  for (let x = cx0; x <= cx1; x++) {
    for (let y = cy0; y <= cy1; y++) {
      total++;
      if (hoop.cells[y * hoop.w + x] || pillar.cells[y * pillar.w + x]) covered++;
    }
  }
  return {
    inFrame: allInFrame,
    clearPct: total ? (100 * (total - covered)) / total : 0,
    widthPct: x1 - x0,
  };
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
  /** Named by which side of the SCREEN they land on; see `placeBehind`. */
  mirrorScreenL: string;
  mirrorScreenR: string;
  /** Both panes wholly inside the frame. */
  mirrorsInFrame: boolean;
  /** The worse of the two panes: percentage of it not behind the halo. */
  mirrorClearPct: number;
  /** The worse of the two panes: how wide it reads, percentage of frame width. */
  mirrorWidthPct: number;
}

function measure(
  cam: THREE.PerspectiveCamera, w: number, h: number,
  carX: number, carY: number, carZ: number, heading: number,
  eye: 'pod' | 'driver',
  /**
   * The same camera with the driver's head turn undone, which is the state the
   * mirrors — and ONLY the mirrors — are judged in. See `CameraDirector.headTurn`.
   */
  levelCam: THREE.PerspectiveCamera,
): Measured {
  const gw = GRID_W;
  const gh = Math.round((GRID_W * h) / w);
  const hoop = newMask(gw, gh);
  stamp(hoop, cam, haloSamples(900), carX, carY, carZ, heading);
  const pillar = newMask(gw, gh);
  stamp(pillar, cam, pillarSamples(200), carX, carY, carZ, heading);
  const levelHoop = newMask(gw, gh);
  stamp(levelHoop, levelCam, haloSamples(900), carX, carY, carZ, heading);
  const levelPillar = newMask(gw, gh);
  stamp(levelPillar, levelCam, pillarSamples(200), carX, carY, carZ, heading);

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
    // fifth of the frame. A rail that clips the very corner on the way out is
    // still a rail going down and out of the picture, which is what the
    // reference does; one that crosses the side edge halfway up the frame is
    // the "black pipe running off the edge of the screen" being complained
    // about, and the two have to be told apart.
    //
    // A FIFTH, NOT AN EIGHTH, and the change came with the settling loop below
    // rather than with any change to the car. Reading the rig after twenty
    // frames caught the cockpit lens four degrees narrower than it ever is in
    // play; reading it settled opens it to where it belongs and carries the
    // rails out to the frame edge two per cent lower, at 82 to 88 per cent of
    // frame height. That is still a rail on its way out through the bottom
    // corner — the thing this deliberately permits — and the old threshold
    // called it a pipe purely because it had been calibrated against a lens
    // nobody sees. The fault it exists to catch had rails leaving at 50 to 60
    // per cent and is nowhere near either number.
    const atSide = (last <= 1 || last >= gw - 2) && hoop.bottom[last] < gh * 0.80;
    const atCorner = last <= 1 || last >= gw - 2;
    const atBottom = hoop.bottom[last] >= gh - 2;
    const where = atSide ? 'SIDE' : atCorner ? 'corner' : atBottom ? 'bottom' : 'stops';
    exits.push(`${where}@x=${((100 * last) / gw).toFixed(0)}%,y=${((100 * hoop.bottom[last]) / gh).toFixed(0)}%`);
  }

  let pw = 0;
  for (let x = 0; x < gw; x++) if (pillar.top[x] >= 0) pw++;

  const at = (v: THREE.Vector3): string => {
    const r = project(cam, v, carX, carY, carZ, heading);
    if (!r) return 'behind';
    return `${r.xPct.toFixed(0)},${r.yPct.toFixed(0)}${r.inFrame ? '' : '*'}`;
  };

  const mirrors = ([1, -1] as const).map((side) => measureMirror(
    levelHoop, levelPillar, levelCam, mirrorPaneCorners(side, eye),
    carX, carY, carZ, heading,
  ));

  return {
    mirrorsInFrame: mirrors.every((m) => m.inFrame),
    mirrorClearPct: Math.min(...mirrors.map((m) => m.clearPct)),
    mirrorWidthPct: Math.min(...mirrors.map((m) => m.widthPct)),
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
    mirrorScreenL: at(new THREE.Vector3(MIRROR_X, MIRROR_Y, MIRROR_Z)),
    mirrorScreenR: at(new THREE.Vector3(-MIRROR_X, MIRROR_Y, MIRROR_Z)),
  };
}

const failures: string[] = [];

console.log(
  'Where the halo lands in the frame, measured off the geometry the mesh is built from.\n' +
  `Roll-hoop eye ${EYE_Y.toFixed(3)}m, driver's eye ${DRIVER_EYE_Y.toFixed(3)}m. Reference\n` +
  '(Monoposto, 1280x589): crown 56% of frame height, rails leave through the BOTTOM at\n' +
  '16-20% and 80-84% of width, rail 3.4-3.8% of frame width thick, horizon 42%, helmet\n' +
  "crown 82%. The reference is the ROLL-HOOP camera; the driver's eye has no reference\n" +
  'frame because no camera in that set is behind a visor. See TARGETS.driver.\n',
);
console.log(
  'circuit'.padEnd(13) + 'frame'.padEnd(7) + 'mode'.padEnd(11) +
  'crown'.padStart(7) + 'thick'.padStart(7) + 'occl'.padStart(6) +
  'horiz'.padStart(7) + '  rail exits'.padEnd(34) + 'helmet'.padStart(9) + 'wheel'.padStart(9) +
  'mirror<'.padStart(9) + 'mirror>'.padStart(9) + 'mirW'.padStart(7) + 'mirClr'.padStart(8),
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
      // Let the rig SETTLE before it is read. Two seconds, not a third of one.
      //
      // Twenty frames was measuring the transition rather than the camera, and
      // it hid the fault it was written to catch. Every rig here starts at the
      // chase camera's 39-degree lens and damps toward its own at a rate of 4,
      // so after twenty frames it has covered 74 per cent of the distance — for
      // the two roll-hoop cameras that is a degree or two and invisible, and
      // for the driver's eye at 58 it is four degrees of lens still to come.
      // The mirrors sit at the very edge of that frame, and four degrees is the
      // difference between the pane being inside it and being cropped by it.
      // Both answers were measurements of the same geometry; only one of them
      // was a measurement of what a player sees.
      for (let i = 0; i < 120; i++) dir.update(1 / 60, car, engine.track, engine.world);
      const cam = dir.camera;
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      // The same camera with the head straight, for the mirrors. The onboard
      // rigs compose their orientation as a YXZ Euler whose y term is
      // `heading + headYaw + PI`, so undoing the turn is one subtraction and
      // does not have to guess at anything.
      const levelCam = cam.clone();
      levelCam.rotation.y -= dir.headTurn;
      levelCam.updateMatrixWorld(true);
      levelCam.matrixWorldInverse.copy(levelCam.matrixWorld).invert();

      const TARGET = TARGETS[mode];
      const m = measure(
        cam, w, h, car.physics.position.x, carY, car.physics.position.y, car.physics.heading,
        mode === 'driver' ? 'driver' : 'pod', levelCam,
      );

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
      if (TARGET.railsExit === 'bottom') {
        for (const e of m.exits) {
          if (e.startsWith('SIDE')) bad.push(`a rail runs off the SIDE of the frame (${e})`);
        }
      } else {
        // The inverse assertion. See `Target.railsExit`: from the driver's seat
        // the hoop passes beside his head, so a rail running out of the BOTTOM
        // of the frame means the eye has climbed back onto the fairing.
        for (const e of m.exits) {
          if (e.startsWith('bottom')) {
            bad.push(`a rail runs off the BOTTOM of the frame from the driver's eye (${e})`);
          }
        }
      }
      if (TARGET.crownVsHorizon === 'above' && m.crownPct >= m.horizon) {
        bad.push(
          `the halo crowns at ${m.crownPct.toFixed(0)}% and the horizon is at ` +
          `${m.horizon.toFixed(0)}%: the hoop is not arcing over the horizon`,
        );
      }
      if (TARGET.crownVsHorizon === 'below' && m.crownPct <= m.horizon) {
        bad.push(
          `the halo crowns at ${m.crownPct.toFixed(0)}% above the horizon at ` +
          `${m.horizon.toFixed(0)}%: the camera is under the hoop, not over it`,
        );
      }
      if (TARGET.mirrorClearPct !== null) {
        if (!m.mirrorsInFrame) {
          bad.push('a mirror pane is cropped by the edge of the frame');
        }
        if (m.mirrorClearPct < TARGET.mirrorClearPct) {
          bad.push(
            `only ${m.mirrorClearPct.toFixed(0)}% of a mirror pane is clear of the halo`,
          );
        }
      }

      console.log(
        def.id.padEnd(13) + frameName.padEnd(7) + mode.padEnd(11) +
        `${m.crownPct.toFixed(0)}%`.padStart(7) +
        `${m.thickPct.toFixed(1)}%`.padStart(7) +
        `${m.thickMaxPct.toFixed(1)}%`.padStart(7) +
        `${m.occludePct.toFixed(1)}%`.padStart(6) +
        `${m.horizon.toFixed(0)}%`.padStart(7) + '  ' +
        m.exits.join(' ').padEnd(32) +
        m.helmet.padStart(9) + m.wheel.padStart(9) +
        m.mirrorScreenL.padStart(9) + m.mirrorScreenR.padStart(9) +
        `${m.mirrorWidthPct.toFixed(1)}%`.padStart(7) +
        `${m.mirrorClearPct.toFixed(0)}%${m.mirrorsInFrame ? '' : '!'}`.padStart(8) +
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
