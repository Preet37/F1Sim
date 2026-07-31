import * as THREE from 'three';

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
  /** False for a slot that has never been used. */
  live: boolean;
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

    const material = new THREE.MeshStandardMaterial({
      // Vertex colours off; the tint is per instance, so one material paints
      // debris in every team's livery.
      roughness: 0.72,
      metalness: 0.08,
    });

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
        rest: 0.01, asleep: true, live: false,
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
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vz: number,
    sizeX: number, sizeY: number, sizeZ: number,
    colour: number,
    groundY: number,
    count: number,
  ): void {
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

      // Roughly panel-shaped: a fraction of the part in plan, and thin.
      const k = 0.28 + Math.random() * 0.42;
      s.sx = Math.max(0.06, sizeX * k * (0.5 + Math.random()));
      s.sz = Math.max(0.06, sizeZ * k * (0.5 + Math.random()));
      s.sy = 0.012 + Math.random() * 0.022;
      s.rest = s.sy * 0.5;

      s.asleep = false;
      s.live = true;

      this.mesh.setColorAt(slot, this.colour.setHex(colour));
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
          s.rx = 0;
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

  /** Empties the field. Called when a session is unloaded. */
  clear(): void {
    for (const s of this.shards) { s.live = false; s.asleep = true; }
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
