import * as THREE from 'three';
import { buildKeepOutField } from '../track/WorldObstacles';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * The light masts at a night circuit.
 *
 * WHY THIS EXISTS. Put `reference/target/90.png` — Bahrain at night, which the
 * user supplied as the lighting specification — beside our own Bahrain frame at
 * the same scale and the largest single difference is not colour and not
 * material response. It is that **their sky is full of floodlight masts and
 * ours is empty**. Fifteen of them are visible in that frame, running away down
 * the pit straight and around the far side of the circuit, and each one is a
 * bright point with a visible pole under it. Ours had none, anywhere, on either
 * night circuit.
 *
 * What the renderer had instead was a ring of fourteen hot sources baked into
 * the ENVIRONMENT PROBE (`EnvProbe.ts`, `PALETTES.night.floodlights`), which
 * puts the specular streaks on the cars that a floodlit circuit should have and
 * is entirely correct as far as it goes. It just has no geometry attached, so
 * the cars were being lit by lamps that did not exist in the world. That is the
 * same shape of defect as issue #29's mirrors: the effect was modelled, and the
 * thing producing it was not drawn.
 *
 * WHAT THESE DO AND DO NOT DO. They are drawn, and they bloom, and that is all.
 * **They cast no light.** Twenty to fifty real `PointLight`s would be twenty to
 * fifty extra shader variants and forward-lighting iterations on a renderer
 * whose post chain is already 71% of the frame (PROJECT.md section 6), and the
 * aggregate illumination they would produce is ALREADY modelled and tuned — it
 * is the hemisphere light at intensity 1.85 that `applyAmbience` sets for night,
 * whose own comment explains that a floodlit circuit is lit by "two hundred
 * lamps from every direction at once, so the DIRECTIONAL component of it is
 * weak". Adding real lights would double-count it. This is set dressing for a
 * lighting model that was already there, and saying so plainly is better than
 * implying the scene is lit by these.
 *
 * COST. Three `InstancedMesh` draws for the whole circuit — mast, head frame,
 * lamps — regardless of how many masts there are.
 */

/**
 * Mast height, metres. Bahrain's are a little over 40m to the lamp deck; this
 * is short of that because the head sits on top rather than partway down.
 */
const MAST_H = 36;
/** Width of the lamp deck across the mast. */
const HEAD_W = 7.0;
/** Lamps per mast — two rows of four, which is what reads at distance. */
const LAMPS_PER_HEAD = 8;
/** Roughly every this many metres of lap distance, per side. */
const SPACING_M = 115;
/**
 * Clearance from anything drivable, metres.
 *
 * Much larger than a marshal post's 1.5m, and for the opposite reason: a marshal
 * post is meant to be close enough to read and a light mast is a structure that
 * would be behind the debris fence and the run-off on any real circuit. It is
 * also the reason these cannot simply be placed at a fixed offset — at Monaco
 * and Jeddah the "run-off" at one point on the lap is the road again at another,
 * which is the bug `buildKeepOutField` exists for.
 */
const MAST_CLEARANCE_M = 4.0;

/**
 * Lamp radiance, in linear light.
 *
 * Above `BLOOM_THRESHOLD` in `PostFX.ts`, which is 1.55 plus 0.35 of night bias
 * — so 1.90 — because a lamp that does not clear the threshold does not bloom,
 * and an unbloomed lamp at 400m is one aliasing pixel rather than a light.
 * `THREE.Color` holds values above 1 perfectly well; what it must NOT do is go
 * through an sRGB decode, hence `setRGB` with an explicit colour space.
 */
const LAMP_RADIANCE = new THREE.Color().setRGB(3.4, 3.25, 2.85, THREE.LinearSRGBColorSpace);

export class FloodlightTowers {
  readonly root = new THREE.Group();
  /** How many masts were actually placed. Read by the probe. */
  readonly count: number;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly meshes: THREE.InstancedMesh[] = [];

  constructor(track: TrackSpline) {
    // One mast per spacing interval per side, alternating sides so a driver
    // looking down a straight sees them staggered rather than in one file.
    const n = Math.max(6, Math.floor(track.length / SPACING_M));

    // A six-sided tapered column. A real mast is a steel lattice; at the
    // distances these are ever seen from — the nearest is 20m off the road and
    // most are hundreds of metres away — a lattice is sub-pixel and costs
    // several thousand triangles per mast to be invisible.
    const mastGeo = new THREE.CylinderGeometry(0.40, 1.05, MAST_H, 6, 1, true);
    const headGeo = new THREE.BoxGeometry(HEAD_W, 0.45, 0.8);
    const lampGeo = new THREE.BoxGeometry(0.85, 0.55, 0.34);
    this.geometries.push(mastGeo, headGeo, lampGeo);

    const steel = new THREE.MeshStandardMaterial({
      color: 0x9aa2ad, roughness: 0.72, metalness: 0.55,
    });
    const lampMat = new THREE.MeshBasicMaterial({
      color: LAMP_RADIANCE,
      // Irrelevant on the post-processed path — `OutputPass` tone-maps the whole
      // buffer at the end, so a per-material opt-out cannot reach it — but
      // correct on the `low` tier, where the chain is skipped and the renderer
      // tone-maps in the material's own shader. Without it a lamp on a phone is
      // the same white as a kerb.
      toneMapped: false,
      fog: false,
    });
    this.materials.push(steel, lampMat);

    const masts = new THREE.InstancedMesh(mastGeo, steel, n);
    const heads = new THREE.InstancedMesh(headGeo, steel, n);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, n * LAMPS_PER_HEAD);
    // Every one of these is tall enough to be visible from most of the lap, and
    // an instanced mesh is culled as one object against a bounding sphere that
    // would have to span the circuit anyway.
    for (const m of [masts, heads, lamps]) {
      m.frustumCulled = false;
      this.meshes.push(m);
      this.root.add(m);
    }

    const keepOut = buildKeepOutField(track);
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const euler = new THREE.Euler();

    let placed = 0;
    let lampIdx = 0;
    for (let i = 0; i < n; i++) {
      const s = (i / n) * track.length;
      const idx = track.indexAt(s);
      const half = track.width[idx] * 0.5;
      // Alternate sides. On the outside of a corner where there is one, because
      // that is where the room is; `lineOffset` gives the inside for free.
      const side = (i % 2 === 0 ? 1 : -1) * (Math.sign(track.lineOffset[idx]) || 1);

      // The same outward walk the marshal posts and the set dressing use,
      // against the same field, so that no two fixtures can disagree about
      // where the circuit is.
      let off: number | null = null;
      for (let attempt = 0; attempt < 14; attempt++) {
        const lat = (half + 12 + attempt * 4) * side;
        const cx = track.px[idx] + track.nx[idx] * lat;
        const cz = track.pz[idx] + track.nz[idx] * lat;
        if (keepOut.clearOfBox(
          cx, cz, track.tz[idx], track.tx[idx], HEAD_W * 0.5, 1.2, MAST_CLEARANCE_M,
        )) {
          off = lat;
          break;
        }
      }
      // A mast that cannot be placed clear of the circuit is not placed. On a
      // street circuit that is most of them, which is correct: Monaco and
      // Jeddah have no room for a 36m mast beside the road and do not have any.
      if (off === null) continue;

      const x = track.px[idx] + track.nx[idx] * off;
      const z = track.pz[idx] + track.nz[idx] * off;
      const y = track.elevationAt(s);

      // The lamp deck runs ACROSS the road, so its lamps face down the circuit
      // rather than presenting the deck edge-on from every camera.
      const heading = Math.atan2(track.tx[idx], track.tz[idx]);
      euler.set(0, heading, 0);
      q.setFromEuler(euler);

      pos.set(x, y + MAST_H * 0.5, z);
      mat.compose(pos, q, one);
      masts.setMatrixAt(placed, mat);

      pos.set(x, y + MAST_H + 0.2, z);
      mat.compose(pos, q, one);
      heads.setMatrixAt(placed, mat);

      for (let l = 0; l < LAMPS_PER_HEAD; l++) {
        const col = l % 4;
        const row = l < 4 ? 0 : 1;
        const across = (col - 1.5) * (HEAD_W / 4.4);
        // (cos h, -sin h) is where the head box's own local +X points after a
        // yaw of `heading`, so the lamps lie along the deck rather than merely
        // near it. Deriving it from the rotation instead of from `track.nx`
        // means the two cannot drift apart if the head's orientation changes.
        pos.set(
          x + Math.cos(heading) * across,
          y + MAST_H + 0.55 + row * 0.62,
          z - Math.sin(heading) * across,
        );
        mat.compose(pos, q, one);
        lamps.setMatrixAt(lampIdx++, mat);
      }
      placed++;
    }

    // Instances that were never placed would otherwise draw at the identity
    // matrix, which is a 36m steel column at the world origin — the exact bug
    // PROJECT.md section 6 records for the grandstands ("a grandstand was drawn
    // at the world origin on every circuit"), and at Jeddah the world origin is
    // on the road.
    masts.count = placed;
    heads.count = placed;
    lamps.count = lampIdx;
    this.count = placed;

    masts.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const m of this.meshes) m.dispose();
  }
}
