/**
 * What a pit crew figure is actually made of, measured off the triangles that
 * get drawn.
 *
 * WHY THIS IS NOT ALLOWED TO ASK THE RIG.
 *
 * The obvious way to test "are the twenty-one people different from each other"
 * is to compare their `CrewBuild` records, and that tests nothing: it asks the
 * randomiser whether it is random. The same trap took `probe:myteam` invariant 7
 * and `audit:livery`'s control shot, and #22 avoided it in the 2D path by
 * parsing the drawn polygons back out of the markup rather than asking the
 * `Body` rig. This is the 3D equivalent: it composes the SAME three things
 * `PitCrew.update` composes every frame —
 *
 *     crewPartGeometries(detail)   the geometry of each part
 *     writeCrewMatrices(joints)    where each instance of it goes
 *     crewPartColours(team, build) what colour each instance is drawn in
 *
 * — into the triangle soup one figure puts on the screen, and then measures that
 * and nothing else. If a "fix" changes the build record without changing what is
 * drawn, every number in here stays exactly where it was.
 *
 * It also means the probe covers the INSTANCED path, which is the one in the pit
 * lane. `mergeCrewFigure` is the same composition flattened for the paddock's
 * static buffer, and it is measured too so the two cannot drift.
 */

import * as THREE from 'three';
import {
  CREW_INSTANCES_PER_FIGURE, CREW_SLOT_PARTS,
  crewPartColours, crewPartGeometries, makeCrewJoints, makeCrewPartColours,
  poseCrew, writeCrewMatrices,
  type CrewBuild, type CrewDetail, type Posture,
} from '../../src/render/CrewFigure';

/** One figure, as drawn: world-space positions and resolved vertex colours. */
export interface DrawnFigure {
  /** 3 floats per vertex, 9 per triangle. */
  pos: Float32Array;
  /** 3 floats per vertex — the colour the fragment shader will resolve to. */
  col: Float32Array;
  /** Vertex count. */
  n: number;
}

/**
 * Composes one figure exactly as the instanced rig draws it.
 *
 * `vertexColors` multiplies the baked per-vertex weight by the per-instance
 * colour, so the drawn colour is `weight * slotColour` — resolved here, because
 * that product is the thing a player sees and the thing the flat-colour
 * assertion is about.
 */
export function drawCrewFigure(
  posture: Posture, build: CrewBuild, detail: CrewDetail,
  teamColour: THREE.ColorRepresentation,
): DrawnFigure {
  const parts = crewPartGeometries(detail);
  const joints = poseCrew(posture, makeCrewJoints(), build);
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < CREW_INSTANCES_PER_FIGURE; i++) mats.push(new THREE.Matrix4());
  writeCrewMatrices(joints, mats, build);
  const colours = crewPartColours(teamColour, build, makeCrewPartColours());

  let total = 0;
  for (const id of CREW_SLOT_PARTS) total += parts[id].getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);

  const v = new THREE.Vector3();
  let w = 0;
  for (let s = 0; s < CREW_SLOT_PARTS.length; s++) {
    const src = parts[CREW_SLOT_PARTS[s]];
    const p = src.getAttribute('position');
    const c = src.getAttribute('color') as THREE.BufferAttribute | undefined;
    const slot = colours[s];
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mats[s]);
      pos[w * 3] = v.x; pos[w * 3 + 1] = v.y; pos[w * 3 + 2] = v.z;
      const weight = c ? c.getX(i) : 1;
      col[w * 3] = slot.r * weight;
      col[w * 3 + 1] = slot.g * weight;
      col[w * 3 + 2] = slot.b * weight;
      w++;
    }
  }
  for (const id of new Set(CREW_SLOT_PARTS)) parts[id].dispose();
  return { pos, col, n: total };
}

/**
 * The same measurement, taken off an already-merged geometry.
 *
 * For `mergeCrewFigure`, the paddock's static path. Its vertex colours are
 * already resolved against the slot colour, so there is nothing to multiply.
 */
export function fromGeometry(g: THREE.BufferGeometry): DrawnFigure {
  const p = g.getAttribute('position');
  const c = g.getAttribute('color') as THREE.BufferAttribute | undefined;
  const pos = new Float32Array(p.count * 3);
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i);
    col[i * 3] = c ? c.getX(i) : 1;
    col[i * 3 + 1] = c ? c.getY(i) : 1;
    col[i * 3 + 2] = c ? c.getZ(i) : 1;
  }
  return { pos, col, n: p.count };
}

/** Everything this probe knows how to say about one drawn figure. */
export interface FigureAnatomy {
  /** Head to heel, metres — the bounding box, not a claim about a skeleton. */
  heightM: number;
  /** Across, metres. */
  widthM: number;
  /** Fore and aft, metres. */
  depthM: number;
  /**
   * Total triangle area, m². A build measure that no pose can fake: bending a
   * figure moves its surface about and does not create any.
   */
  areaM2: number;
  /**
   * Left/right disagreement in the fore-aft direction, metres.
   *
   * The figure is cut into 20 horizontal bands; in each band with geometry on
   * both sides of x = 0 the mean z of each side is taken, and this is the
   * largest difference. A MIRROR-SYMMETRIC POSE SCORES EXACTLY ZERO, which is
   * what every crew figure in this game scored before #24.
   */
  asymZM: number;
  /** Mean height of the left half against the right, metres. Symmetric ⇒ 0. */
  asymYM: number;
  /**
   * How far BACK each leg reaches along the ground, metres — the rearmost point
   * of each side's geometry in the bottom third of the figure.
   *
   * This is how "one knee down" is found in the DRAWING rather than read off
   * the rig, and it took two wrong metrics to get to. The first looked for the
   * forward-most low point on each side, on the theory that the knee is the
   * front of a bent leg: true of a leg that is bent, and useless here, because
   * the kneeling leg's shin lies BACKWARD and its forward-most low point is the
   * thigh. The second took the mean height of each leg's material, which failed
   * for a subtler reason worth keeping — a folded leg and a standing leg have
   * almost the SAME mean height (0.238m against 0.248m at Monza's crew), they
   * just have it in completely different places.
   *
   * What actually distinguishes a kneel, and what a viewer sees, is that one
   * shin is lying along the floor pointing behind the figure and the other is
   * not. That is a fore-aft measurement at ankle height and nothing else.
   *
   * A mirror-symmetric pose gives the two sides identical values, bit for bit.
   */
  legAftM: [number, number];
  /**
   * How many distinct CHROMATICITIES the figure is drawn in.
   *
   * Chromaticity and not colour, and the distinction is the whole point: the
   * per-vertex weight multiplies the instance colour, so five weights of one
   * team colour are five brightnesses of ONE hue. That is a uniform, and it
   * measured 1 on every figure in the pit lane. A kit with a contrasting sleeve
   * or a white helmet measures more.
   */
  chromas: number;
  /** The chromaticity buckets themselves, for reporting. */
  chromaKeys: string[];
  /**
   * WHERE the colours are, as the dominant chromaticity of each of the 20
   * horizontal bands.
   *
   * A set of colours is not a kit. Two people can both be wearing the team's
   * colour and a charcoal and look completely different depending on which
   * parts are which — sleeves against shins against helmet — and a set cannot
   * tell them apart. This can, and it is still nothing but the drawing: the
   * band a colour lands in is where a viewer sees it.
   */
  bandChroma: string;
}

const BANDS = 20;

export function measureFigure(f: DrawnFigure): FigureAnatomy {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < f.n; i++) {
    const x = f.pos[i * 3], y = f.pos[i * 3 + 1], z = f.pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const heightM = maxY - minY;

  // Triangle area.
  let areaM2 = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t + 2 < f.n; t += 3) {
    a.fromArray(f.pos, t * 3);
    b.fromArray(f.pos, (t + 1) * 3);
    c.fromArray(f.pos, (t + 2) * 3);
    ab.subVectors(b, a); ac.subVectors(c, a);
    areaM2 += ab.cross(ac).length() * 0.5;
  }

  // Left/right, banded.
  const zSum = [new Float64Array(BANDS), new Float64Array(BANDS)];
  const zCount = [new Float64Array(BANDS), new Float64Array(BANDS)];
  let ySumL = 0, ySumR = 0, nL = 0, nR = 0;
  const legAft = [Infinity, Infinity];
  const legTop = minY + heightM * 0.33;
  const bandTally: Map<string, number>[] = [];
  for (let k = 0; k < BANDS; k++) bandTally.push(new Map());

  const chroma = (i: number): string => {
    const r = f.col[i * 3], g = f.col[i * 3 + 1], bl = f.col[i * 3 + 2];
    const sum = r + g + bl;
    if (sum < 1e-4) return 'black';
    return Math.round(r / sum * 25) + '/' + Math.round(g / sum * 25) +
      '/' + Math.round(bl / sum * 25);
  };

  const keys = new Set<string>();
  for (let i = 0; i < f.n; i++) {
    const x = f.pos[i * 3], y = f.pos[i * 3 + 1], z = f.pos[i * 3 + 2];
    const band = Math.min(BANDS - 1, Math.max(0, Math.floor((y - minY) / heightM * BANDS)));
    const key = chroma(i);
    keys.add(key);
    bandTally[band].set(key, (bandTally[band].get(key) ?? 0) + 1);
    if (Math.abs(x) < 0.03) continue;
    const s = x < 0 ? 0 : 1;
    zSum[s][band] += z; zCount[s][band]++;
    if (s === 0) { ySumL += y; nL++; } else { ySumR += y; nR++; }
    if (y < legTop && z < legAft[s]) legAft[s] = z;
  }
  let asymZM = 0;
  for (let k = 0; k < BANDS; k++) {
    if (zCount[0][k] < 8 || zCount[1][k] < 8) continue;
    const d = Math.abs(zSum[0][k] / zCount[0][k] - zSum[1][k] / zCount[1][k]);
    if (d > asymZM) asymZM = d;
  }
  const asymYM = Math.abs((nL ? ySumL / nL : 0) - (nR ? ySumR / nR : 0));
  const legAftM: [number, number] = [
    Number.isFinite(legAft[0]) ? legAft[0] : 0,
    Number.isFinite(legAft[1]) ? legAft[1] : 0,
  ];

  const bandChroma = bandTally.map((t) => {
    let best = '-';
    let bestN = 0;
    for (const [k, v] of t) if (v > bestN) { bestN = v; best = k; }
    return best;
  }).join(' ');

  return {
    heightM, widthM: maxX - minX, depthM: maxZ - minZ, areaM2,
    asymZM, asymYM, legAftM,
    chromas: keys.size, chromaKeys: [...keys].sort(), bandChroma,
  };
}

/**
 * A person's identity, as a string, from the DRAWING alone.
 *
 * Two figures with the same signature are the same figure on screen. Rounded to
 * a centimetre of stature, a hundredth of a square metre of surface and a
 * centimetre of asymmetry, plus the palette — all of it coarse enough that a
 * difference nobody could see does not count as a difference.
 */
export function figureSignature(m: FigureAnatomy): string {
  return [
    m.heightM.toFixed(2), m.areaM2.toFixed(2), m.asymZM.toFixed(2),
    m.legAftM[0].toFixed(2), m.legAftM[1].toFixed(2), m.bandChroma,
  ].join('|');
}
