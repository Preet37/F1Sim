import * as THREE from 'three';
import { carbonWeaveMap } from './DetailMaps';

/**
 * The pieces that end up on the road after an accident.
 *
 * This is deliberately NOT the spark shower. `ParticleSystem.emitImpact` throws
 * a burst of bright, short-lived points at the moment of contact and they are
 * gone in half a second, which is right for the flash of an impact and wrong for
 * what an impact leaves behind. Carbon fibre does not evaporate: a front wing
 * that comes off is lying on the road on the next lap, and drivers get told
 * about it over the radio. A crash the track forgets one second later is a crash
 * that did not happen, and that is most of what the "poof gone" complaint was
 * about.
 *
 * COST. One InstancedMesh, one geometry, one material: the whole debris field is
 * a single draw call however many pieces are on the ground. That is the reason
 * for the instanced form rather than a mesh per shard — twenty cars in a first
 * corner pile-up can generate a lot of bodywork, and a draw call per piece would
 * cost more than the accident.
 *
 * Pieces are recycled oldest-first once the cap is reached, so the field is
 * bounded no matter how long the session runs or how badly it goes.
 *
 * MOTION. Shards get a ballistic arc, a bounce, and then they go to sleep. A
 * sleeping shard costs nothing per frame — its matrix is already in the buffer
 * and is never written again — which is what makes a hundred permanent pieces
 * affordable. The ground height is captured when the piece is spawned rather
 * than sampled as it flies: debris travels a few metres, the road does not
 * change height appreciably over that, and it saves a spline projection per
 * piece per frame.
 */

/** Gravity, m/s². Real, because the arc reads wrong at anything else. */
const G = 9.81;

/** How much of the impact speed a piece keeps when it hits the road. */
const BOUNCE = 0.28;

/** Ground friction applied per bounce, so pieces skid and then stop. */
const SKID = 0.62;

/** Below this speed a piece touching the road is done moving. */
const SLEEP_SPEED = 0.35;

/**
 * The largest a single piece of loose bodywork gets, metres.
 *
 * Shard size used to be a fraction of the PART, uncapped, and a front wing is
 * two metres across — so losing one put two-metre flat panels on the road, and
 * at a glance a rectangle that size lying on the asphalt does not read as
 * debris at all, it reads as a texture bug. Real carbon breaks small: the
 * biggest recognisable thing that usually survives a wing failure is an
 * endplate, and half a metre is generous for that.
 */
const MAX_SHARD_M = 0.55;

/**
 * How dark the painted face is against the team's own colour.
 *
 * A livery colour is chosen to read on a car under television lighting at 300
 * km/h; the same value on a 30cm panel lying flat on grey asphalt is a
 * fluorescent rectangle, which is exactly the "blue pieces everywhere"
 * complaint. Real painted carbon is a dark, low-chroma version of the team
 * colour with a satin lacquer over it, so the tint is pulled most of the way
 * toward the carbon underneath and the SHEEN is left to do the work of telling
 * you what it is.
 */
const PAINT_DARKEN = 0.34;

/**
 * Base colour of the unpainted side, before the per-instance tint.
 *
 * Not zero. A face at literally black takes no light at all and reads as a hole
 * in the road; woven carbon under lacquer is a very dark grey with a strong
 * specular, which is what this plus the roughness below produce.
 */
const CARBON = 0.055;

interface Shard {
  /** World position. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Road height under this piece, captured at spawn. */
  groundY: number;
  /** Orientation, integrated from the spin below while it is in the air. */
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
  /** Half-thickness, so a settled piece rests ON the road rather than in it. */
  rest: number;
  /** True once it has stopped and its matrix no longer needs writing. */
  asleep: boolean;
  /** Whether it settles painted side up. Decided at spawn, applied on landing. */
  faceUp: boolean;
  /** False for a slot that has never been used. */
  live: boolean;
  /**
   * Which pile in the simulation's ledger this shard belongs to.
   *
   * The renderer no longer decides how long a piece of carbon stays on the
   * circuit — `RaceEngine.debris` does, because that decision raises a yellow
   * flag and a flag changes how the race is driven. This is the handle the
   * ledger retires a pile by. See `src/race/DebrisField.ts`.
   */
  pile: number;
}

export class Wreckage {
  readonly mesh: THREE.InstancedMesh;

  private readonly shards: Shard[] = [];
  private readonly cap: number;
  /** Next slot to overwrite once the field is full. */
  private next = 0;
  private used = 0;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly colour = new THREE.Color();

  constructor(cap = 120) {
    this.cap = cap;

    // A unit box, scaled per instance. A shard of bodywork is a flat panel, and
    // a box scaled thin on one axis is exactly that for a tenth of the vertices
    // a bevelled one would cost.
    const geometry = new THREE.BoxGeometry(1, 1, 1);

    // --- One painted face, five carbon ones ---------------------------------
    //
    // Bodywork is a carbon laminate with paint on the OUTSIDE only. The inner
    // face, and every broken edge, is bare weave — so a piece lying on the road
    // shows the livery if it happens to have landed the right way up and shows
    // black if it has not, and the edges are black either way. Painting all six
    // faces a flat saturated team colour is what makes the old debris read as
    // coloured paper: a real shard is mostly black with one bright side.
    //
    // Done with a vertex colour rather than six materials or a texture atlas,
    // because three.js multiplies the vertex colour by the per-instance colour —
    // so one geometry and one material still paint every team's carbon, and the
    // whole field stays a single draw call.
    //
    // `BoxGeometry` lays its faces out +x, -x, +y, -y, +z, -z, four vertices
    // each. Vertices 8..11 are the +y face; that is the painted one.
    const faceColours = new Float32Array(24 * 3);
    for (let v = 0; v < 24; v++) {
      const painted = v >= 8 && v < 12;
      const c = painted ? 1 : CARBON;
      faceColours[v * 3] = c;
      faceColours[v * 3 + 1] = c;
      faceColours[v * 3 + 2] = c;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(faceColours, 3));

    // The weave itself. Cloned rather than shared, because the car samples the
    // same image through a uv set measured in metres and this samples it
    // through a box unwrap — the two want different repeats, and mutating the
    // cached texture would retile every carbon surface on the car.
    const weave = carbonWeaveMap();
    let normalMap: THREE.Texture | null = null;
    if (weave) {
      normalMap = weave.clone();
      normalMap.needsUpdate = true;
      normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
      // Twill at roughly a centimetre over a typical shard face. Fine enough to
      // read as woven at arm's length and coarse enough to survive the mip
      // chain from a car going past at speed.
      normalMap.repeat.set(22, 22);
    }

    const material = new THREE.MeshStandardMaterial({
      // The per-vertex face mask above, multiplied by the per-instance livery
      // tint. One material, every team, one draw call.
      vertexColors: true,
      // Lacquered carbon, not matte plastic. The old 0.72 gave a shard no
      // highlight at all, and a highlight travelling along a piece as the
      // camera passes it is most of what says "this is a hard, curved, painted
      // object" rather than "this is a coloured quad".
      roughness: 0.38,
      metalness: 0.18,
      ...(normalMap ? { normalMap } : {}),
    });
    if (normalMap) material.normalScale.set(0.7, 0.7);

    this.mesh = new THREE.InstancedMesh(geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    // Debris is scattered over the whole circuit, so a frustum test against one
    // bounding sphere around all of it is always true and merely costs time.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;

    for (let i = 0; i < cap; i++) {
      this.shards.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        groundY: 0, rx: 0, ry: 0, rz: 0, sx: 0.1, sy: 0.02, sz: 0.1,
        rest: 0.01, asleep: true, live: false, faceUp: true, pile: -1,
      });
    }
  }

  /**
   * Throws a part's worth of debris.
   *
   * @param sizeX,sizeY,sizeZ the bounding size of the part that came off, so a
   *        front wing leaves wide flat panels and a sidepod leaves big ones
   * @param velocity the car's velocity at the moment it let go, which is what
   *        makes debris land AHEAD of a car that was still moving
   * @param count how many pieces the part breaks into
   * @param pile  the simulation ledger's id for this piece of bodywork, so
   *        `clearPile` can retire it when the marshals have collected it
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vz: number,
    sizeX: number, sizeY: number, sizeZ: number,
    colour: number,
    groundY: number,
    count: number,
    pile: number,
  ): void {
    // The painted face, darkened and de-chroma'd off the team's own colour.
    // Computed once per pile rather than once per shard: every piece of one
    // wing was the same paint.
    this.colour.setHex(colour);
    this.colour.multiplyScalar(PAINT_DARKEN);

    for (let i = 0; i < count; i++) {
      const s = this.shards[this.next];
      const slot = this.next;
      this.next = (this.next + 1) % this.cap;
      if (this.used < this.cap) this.used++;
      this.mesh.count = this.used;

      // Spread the pieces over the volume the part occupied, so they do not all
      // leave from a single point.
      s.x = x + (Math.random() - 0.5) * sizeX * 0.7;
      s.y = y + 0.15 + Math.random() * Math.max(sizeY, 0.15) * 0.6;
      s.z = z + (Math.random() - 0.5) * sizeZ * 0.7;
      s.groundY = groundY;

      // Carried forward by the car, plus a scatter. The forward term dominates,
      // because a wing that comes off at 200 km/h is still doing 200 km/h.
      const a = Math.random() * Math.PI * 2;
      const scatter = 1.5 + Math.random() * 4.5;
      s.vx = vx * (0.55 + Math.random() * 0.35) + Math.cos(a) * scatter;
      s.vz = vz * (0.55 + Math.random() * 0.35) + Math.sin(a) * scatter;
      s.vy = 1.2 + Math.random() * 3.4;

      s.rx = Math.random() * Math.PI * 2;
      s.ry = Math.random() * Math.PI * 2;
      s.rz = Math.random() * Math.PI * 2;

      // Roughly panel-shaped: a fraction of the part in plan, thin, and CAPPED.
      // Without the cap a two-metre front wing put two-metre rectangles on the
      // road, which is what a texture bug looks like rather than what carbon
      // looks like. See `MAX_SHARD_M`.
      const k = 0.18 + Math.random() * 0.26;
      s.sx = Math.min(MAX_SHARD_M, Math.max(0.05, sizeX * k * (0.5 + Math.random())));
      s.sz = Math.min(MAX_SHARD_M, Math.max(0.05, sizeZ * k * (0.5 + Math.random())));
      // 4-14mm. A carbon skin is 2-3mm and a shard of one carries a little of
      // its own curvature; anything thicker reads as a block of wood.
      s.sy = 0.004 + Math.random() * 0.010;
      s.rest = s.sy * 0.5;

      s.asleep = false;
      s.live = true;
      s.pile = pile;
      // Which way up it will finish. A piece of bodywork lands painted side up
      // or painted side down with no particular preference, and a field where
      // every single shard shows the livery is a field of coloured paper. Half
      // of them are decided here and enforced when the piece settles.
      s.faceUp = Math.random() < 0.5;

      this.mesh.setColorAt(slot, this.colour);
      this.write(slot, s);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Integrates everything still moving. Sleeping pieces cost nothing. */
  advance(dt: number): void {
    if (this.used === 0) return;
    // A long frame (a tab coming back from the background) would otherwise
    // teleport debris through the road.
    const step = Math.min(dt, 0.05);

    let dirty = false;
    for (let i = 0; i < this.used; i++) {
      const s = this.shards[i];
      if (s.asleep || !s.live) continue;

      s.vy -= G * step;
      s.x += s.vx * step;
      s.y += s.vy * step;
      s.z += s.vz * step;

      // Tumbling, at a rate that falls off with how fast it is going, so a
      // piece stops spinning as it stops moving.
      const spin = step * 3.2;
      s.rx += s.vx * spin * 0.35;
      s.ry += s.vz * spin * 0.28;
      s.rz += s.vy * spin * 0.30;

      const floor = s.groundY + s.rest;
      if (s.y <= floor) {
        s.y = floor;
        s.vy = -s.vy * BOUNCE;
        s.vx *= SKID;
        s.vz *= SKID;

        const speed = Math.hypot(s.vx, s.vz) + Math.abs(s.vy);
        if (speed < SLEEP_SPEED) {
          // Settled. Lay it flat on the road and stop touching it for the rest
          // of the session — this is the whole reason a permanent debris field
          // is affordable.
          s.vx = s.vy = s.vz = 0;
          // Flat on the road, and the right way up. `faceUp` decides which of
          // the two faces the light gets: a half-turn about x puts the painted
          // +y face against the asphalt and the bare weave into the sky.
          s.rx = s.faceUp ? 0 : Math.PI;
          s.rz = 0;
          s.asleep = true;
        }
      }

      this.write(i, s);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private write(i: number, s: Shard): void {
    this.pos.set(s.x, s.y, s.z);
    this.e.set(s.rx, s.ry, s.rz);
    this.q.setFromEuler(this.e);
    this.scl.set(s.sx, s.sy, s.sz);
    this.m.compose(this.pos, this.q, this.scl);
    this.mesh.setMatrixAt(i, this.m);
  }

  /**
   * Retires one pile, because the marshals have collected it.
   *
   * Which pile, and when, is decided in `src/race/DebrisField.ts` and not here:
   * carbon on the racing line raises a yellow flag, a flag changes how the race
   * is driven, and anything that changes how the race is driven has to live
   * where a headless simulation can see it. This end of it is bookkeeping.
   *
   * A swept piece is retired to a zero scale rather than compacted out of the
   * buffer: the instance slots are a ring the spawner already recycles
   * oldest-first, so a dead slot costs one degenerate box until it is reused
   * and nothing at all after that — no reallocation, no re-upload of the whole
   * matrix buffer, and no change to the instance count the integrity probe
   * counts across load/unload cycles.
   */
  clearPile(pile: number): void {
    let dirty = false;
    for (let i = 0; i < this.used; i++) {
      const s = this.shards[i];
      if (!s.live || s.pile !== pile) continue;
      s.live = false;
      s.asleep = true;
      s.pile = -1;
      s.sx = 0; s.sy = 0; s.sz = 0;
      this.write(i, s);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** How many pieces are actually lying on the circuit right now. */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.used; i++) if (this.shards[i].live) n++;
    return n;
  }

  /** Empties the field. Called when a session is unloaded. */
  clear(): void {
    for (const s of this.shards) { s.live = false; s.asleep = true; s.pile = -1; }
    this.used = 0;
    this.next = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
