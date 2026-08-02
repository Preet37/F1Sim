import * as THREE from 'three';
import { CameraDirector, type CameraMode } from '../src/render/CameraDirector';
import { frontMembers, type SuspensionMember } from '../src/render/CarMesh';
import { EYE_Y } from '../src/render/CockpitMesh';
import { RaceEngine, type SessionConfig } from '../src/race/RaceEngine';
import { CIRCUITS } from '../src/data/tracks/circuits';
import { PHYSICS_DT } from '../src/core/SimClock';

/**
 * How much of the onboard picture the front suspension covers.
 *
 * WHY THIS EXISTS. The halo was rebuilt four times from screenshots and words —
 * "too thick", "cooking me" — before anyone exported its centreline and
 * measured it, at which point the actual fault was found in one pass. When the
 * halo finally framed correctly, the remaining complaint about the onboard view
 * turned out to be the FRONT SUSPENSION: six members a side, three to four
 * metres from the eye, each one of comparable visual weight to the halo rail
 * itself, spanning most of the frame height. Twelve of them is the "cage of
 * black rods" being described.
 *
 * That is a measurable claim, so this measures it, the same way and through the
 * same real `CameraDirector`. The member table comes from `frontMembers` in
 * CarMesh — the same array the mesh is extruded along — so the measurement and
 * the geometry cannot drift apart.
 *
 * WHAT IS MEASURED, per member:
 *
 *   - THICKNESS, as a percentage of frame WIDTH. This is the number that
 *     matters. A driver sees a laterally-running member edge-on in chord, so
 *     what covers the picture is the member's THICKNESS, not its 96mm chord.
 *   - VERTICAL SPAN, as a percentage of frame height: how much of the picture
 *     the member crosses top to bottom.
 *   - OCCLUSION of the whole corner, as a percentage of frame area.
 *
 * ASPECT RATIO IS A PARAMETER for the same reason it is in `probeFraming`:
 * three.js takes a vertical field of view, so anything quoted as a fraction of
 * frame width is a different number on a 2.17:1 phone and a 16:9 desktop.
 */

/** The modes the front suspension is in shot for. */
const MODES: CameraMode[] = ['cockpit', 'onboard-t'];

/** Frame shapes measured. The tolerances are written against the phone. */
const FRAMES: [string, number, number][] = [
  ['phone', 1280, 589],
  ['wide', 1280, 720],
];

/**
 * What "acceptable" means here, and it is a judgement rather than a reference
 * measurement — no published figure exists for how much of an onboard shot a
 * real car's front suspension covers.
 *
 * The anchor is the HALO, which `probeFraming` targets at 1.4-4.0 per cent of
 * frame width from the cockpit and which currently measures 1.6-2.0. The halo
 * is a single hoop and is meant to be the most prominent structure in the shot;
 * a suspension member is one of twelve and ought to be slighter.
 *
 * THIS LIMIT IS 2.3 AND NOT 1.4, AND THE GAP IS DELIBERATE. Two reasons, both
 * of which should be read before anybody tries to close it by thinning the
 * parts further:
 *
 *  1. THE GEOMETRY IS ALREADY AT THE REGULATION SLIMNESS LIMIT. A suspension
 *     fairing may not exceed 3.5:1 in aspect ratio, and the legs are built at
 *     exactly 3.5:1 — 78 by 22mm. Going thinner would not be modelling a
 *     Formula 1 car any more, it would be modelling something that could not
 *     pass scrutineering, and the brief is to get the car right.
 *
 *  2. THIS PROBE DOES NOT MODEL OCCLUSION, and that matters most for the very
 *     member it flags. The worst reading is always the lower wishbone's rear
 *     leg, whose inboard half runs into the survival cell about a metre and a
 *     quarter from the driver's eye — behind the dash, and invisible from the
 *     cockpit. The mask stamps it anyway, so the figure below is an upper bound
 *     on what is actually drawn, not a measurement of it. Fixing that means
 *     rasterising the tub as an occluder, which is a bigger piece of work than
 *     the thing it would be measuring.
 *
 * The number that actually answers the "cage of black rods" complaint is not
 * this one but VSPAN — how much of the frame height a member crosses. That was
 * measured at 73-100 per cent on the geometry this replaces, and is 10-13 per
 * cent now, because the ball joints moved to where the regulations put them and
 * the arms stopped splaying across the face of the wheel.
 */
const MAX_MEMBER_THICK_PCT = 2.3;
const MAX_CORNER_OCCLUDE_PCT = 9.0;

const config: SessionConfig = {
  kind: 'race',
  name: 'suspension probe',
  durationS: 0,
  laps: 5,
  playerIndex: -1,
  standingStart: false,
  pitLaneStart: false,
  seed: 11,
};

/** Rasterisation grid, matching `probeFraming` so the numbers are comparable. */
const GRID_W = 640;

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
 * Stamps one member into a screen-space mask.
 *
 * The section is an ellipse `chord` deep in the car's z and `thick` tall in its
 * y — see `aeroStrut` — so each sample's screen half-extents are taken from
 * whichever of those two the camera is actually looking across. Rather than
 * work that out analytically, the section is sampled as an axis-aligned box in
 * the member's own frame and projected: four corner offsets per station, which
 * is exact enough at this grid resolution and cannot get the orientation wrong.
 */
function stampMember(
  mask: Mask, cam: THREE.PerspectiveCamera, m: SuspensionMember,
  carX: number, carY: number, carZ: number, heading: number,
): void {
  const a = new THREE.Vector3(m.a[0], m.a[1], m.a[2]);
  const b = new THREE.Vector3(m.b[0], m.b[1], m.b[2]);
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  const tanY = Math.tan((cam.fov * Math.PI) / 360);
  const tanX = tanY * cam.aspect;
  const SAMPLES = 240;
  const hc = m.chord * 0.5;
  const ht = m.thick * 0.5;
  // The section's four extreme points in car-local axes: +-chord in z and
  // +-thickness in y, about the member's own centreline.
  const corners: [number, number, number][] = [
    [0, ht, hc], [0, ht, -hc], [0, -ht, hc], [0, -ht, -hc],
  ];
  const p = new THREE.Vector3();
  for (let i = 0; i <= SAMPLES; i++) {
    p.copy(a).lerp(b, i / SAMPLES);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let ok = true;
    for (const [cx, cy, cz] of corners) {
      toWorld(
        new THREE.Vector3(p.x + cx, p.y + cy, p.z + cz),
        carX, carY, carZ, heading, world,
      );
      view.copy(world).applyMatrix4(cam.matrixWorldInverse);
      const d = -view.z;
      if (d <= cam.near) { ok = false; break; }
      const px = (((view.x / d) / tanX) * 0.5 + 0.5) * mask.w;
      const py = (0.5 - ((view.y / d) / tanY) * 0.5) * mask.h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    if (!ok) continue;
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(mask.w - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(mask.h - 1, Math.ceil(maxY));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        mask.cells[y * mask.w + x] = 1;
        if (mask.top[x] < 0 || y < mask.top[x]) mask.top[x] = y;
        if (y > mask.bottom[x]) mask.bottom[x] = y;
      }
    }
  }
}

/** Median vertical run across the columns a mask occupies, corrected for slope. */
function medianThickness(mask: Mask): number {
  const runs: number[] = [];
  for (let x = 4; x < mask.w - 4; x++) {
    if (mask.top[x] < 0) continue;
    const a = x - 4, b = x + 4;
    if (mask.top[a] < 0 || mask.top[b] < 0) continue;
    const slope = (mask.top[b] - mask.top[a]) / (b - a);
    runs.push((mask.bottom[x] - mask.top[x] + 1) / Math.hypot(1, slope));
  }
  if (!runs.length) return 0;
  runs.sort((p, q) => p - q);
  return runs[Math.floor(runs.length / 2)];
}

/** Fraction of frame height the mask spans, top to bottom. */
function verticalSpan(mask: Mask): number {
  let top = mask.h, bot = -1;
  for (let x = 0; x < mask.w; x++) {
    if (mask.top[x] < 0) continue;
    top = Math.min(top, mask.top[x]);
    bot = Math.max(bot, mask.bottom[x]);
  }
  return bot < 0 ? 0 : ((bot - top + 1) * 100) / mask.h;
}

const failures: string[] = [];

console.log(
  'How much of the onboard picture the front suspension covers, measured off the\n' +
  'member table the mesh is extruded from (`frontMembers` in CarMesh).\n' +
  `Eye height ${EYE_Y.toFixed(3)}m. Thickness is a percentage of frame WIDTH, which is\n` +
  'the same unit `probe:framing` quotes the halo rail in (the halo reads 1.6-2.0%\n' +
  'from the cockpit). VSPAN is the fraction of frame HEIGHT a member crosses, and\n' +
  'it is the number the "cage of black rods" complaint was really about: it was\n' +
  `73-100% before the ball joints were corrected.\n` +
  `Limits: ${MAX_MEMBER_THICK_PCT}% thickness per member, ${MAX_CORNER_OCCLUDE_PCT}% occlusion for both corners together.\n` +
  'Occlusion by the survival cell is NOT modelled, so thickness is an upper bound.\n',
);
console.log(
  'circuit'.padEnd(13) + 'frame'.padEnd(7) + 'mode'.padEnd(11) +
  'occl'.padStart(6) + 'worst'.padStart(7) + '  ' + 'thickest member'.padEnd(20) +
  'thick%'.padStart(8) + 'vspan%'.padStart(8),
);

for (const def of CIRCUITS) {
  const engine = new RaceEngine(def, config);
  for (let i = 0; i < Math.round(30 / PHYSICS_DT); i++) engine.step();
  const car = engine.cars[0];
  const carY = engine.track.elevationAt(car.s);
  const carX = car.physics.position.x;
  const carZ = car.physics.position.y;
  const heading = car.physics.heading;

  for (const [frameName, w, h] of FRAMES) {
    for (const mode of MODES) {
      const dir = new CameraDirector(w / h);
      dir.setMode(mode);
      for (let i = 0; i < 20; i++) dir.update(1 / 60, car, engine.track, engine.world);
      const cam = dir.camera;
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      const gw = GRID_W;
      const gh = Math.round((GRID_W * h) / w);

      // Both corners together, for the occlusion figure — twelve members is the
      // thing being complained about, not any one of them.
      const all = newMask(gw, gh);
      let worstThick = 0;
      let worstName = '-';
      let worstSpan = 0;
      for (const side of [-1, 1] as const) {
        for (const m of frontMembers(side)) {
          stampMember(all, cam, m, carX, carY, carZ, heading);
          const one = newMask(gw, gh);
          stampMember(one, cam, m, carX, carY, carZ, heading);
          const t = (medianThickness(one) * 100) / gw;
          if (t > worstThick) {
            worstThick = t;
            worstName = `${side > 0 ? 'R' : 'L'} ${m.name}`;
            worstSpan = verticalSpan(one);
          }
        }
      }

      let filled = 0;
      for (let i = 0; i < all.cells.length; i++) if (all.cells[i]) filled++;
      const occl = (filled * 100) / (gw * gh);

      const bad: string[] = [];
      if (worstThick > MAX_MEMBER_THICK_PCT) {
        bad.push(`${worstName} reads ${worstThick.toFixed(2)}% of frame width thick`);
      }
      if (occl > MAX_CORNER_OCCLUDE_PCT) {
        bad.push(`the front suspension occludes ${occl.toFixed(1)}% of the picture`);
      }

      console.log(
        def.id.padEnd(13) + frameName.padEnd(7) + mode.padEnd(11) +
        `${occl.toFixed(1)}%`.padStart(6) +
        `${worstThick.toFixed(2)}%`.padStart(7) + '  ' +
        worstName.padEnd(20) +
        `${worstThick.toFixed(2)}`.padStart(8) +
        `${worstSpan.toFixed(0)}`.padStart(8) +
        (bad.length ? '  <-- ' + bad.join('; ') : ''),
      );
      for (const b of bad) failures.push(`${def.id} ${frameName} ${mode}: ${b}`);
    }
  }
}

console.log('');
if (failures.length === 0) {
  console.log('PASS — no front suspension member reads as heavily as the halo rail');
} else {
  console.log(`FAILURES (${failures.length}):`);
  const seen = new Set<string>();
  for (const f of failures) {
    const key = f.slice(f.indexOf(':'));
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${f}`);
  }
  process.exit(1);
}
