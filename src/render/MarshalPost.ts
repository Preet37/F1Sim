import * as THREE from 'three';
import type { FlagSignal, RaceControlManager } from '../race/RaceControlManager';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Trackside marshal posts: the FIA light panels, in the world.
 *
 * A flag state that only exists on a map in the corner of the screen is a flag
 * state the driver does not have while driving. Real circuits solve this by
 * putting a lit panel at every marshalling post, on the driver's side, angled
 * back down the road — so you see the panel for the sector you are ENTERING
 * before you get there, which is the entire purpose of the yellow flag system.
 * This is that, one post per marshalling sector boundary.
 *
 * Construction notes
 *
 * Two panels per post, stacked, because the double yellow is signalled by two
 * flags and modelling it as "the same panel, a bit oranger" throws away the
 * distinction the regulations spend two articles drawing (2025 Art. 26.1a vs
 * 26.1b / 2026 B1.8.4a vs B1.8.4b). One lit panel is a single waved yellow. Two
 * is a double.
 *
 * The panels are `MeshBasicMaterial` rather than a lit material. That is not a
 * shortcut, it is what they are: a light panel emits, it does not reflect, and
 * a Bahrain night race is the case that proves it — a shaded standard material
 * at the far side of the circuit at 2am is black, which is precisely when a
 * driver most needs to see it.
 *
 * Everything is instanced: two `InstancedMesh` draws for the whole circuit's
 * signalling, with per-instance colour. Twenty posts as separate meshes would be
 * sixty draw calls for something that is off-screen most of the time.
 */

/** Panel colours per signal. Green is dim; everything else is meant to shout. */
const SIGNAL_COLOUR: Record<FlagSignal, number> = {
  green: 0x1f9c3a,
  chequered: 0xdedede,
  // The FIA panels display "VSC" in white on blue; the boards are white.
  vsc: 0xd8e6ff,
  'safety-car': 0xff8c1a,
  yellow: 0xffd21f,
  'double-yellow': 0xffd21f,
  red: 0xd8102a,
};

/** How many of the two panels are lit for a given signal. */
function litPanels(sig: FlagSignal): number {
  if (sig === 'double-yellow' || sig === 'red') return 2;
  if (sig === 'safety-car' || sig === 'vsc' || sig === 'yellow') return 1;
  // Green and chequered: the post shows its steady green, which on a real
  // circuit is a single small green light rather than a dark post.
  return 1;
}

/** Colour a panel that is NOT lit — dark, but still visibly a panel. */
const UNLIT = 0x181c22;

const PANEL_W = 1.5;
const PANEL_H = 0.85;
const POST_H = 3.4;

export class MarshalPosts {
  readonly root = new THREE.Group();

  private readonly panels: THREE.InstancedMesh;
  private readonly posts: THREE.InstancedMesh;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  /** Signal each post is currently showing, so colours are written on change. */
  private readonly shown: FlagSignal[] = [];
  private readonly colour = new THREE.Color();

  readonly count: number;

  constructor(track: TrackSpline, sectorCount: number) {
    this.count = sectorCount;

    const panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    const postGeo = new THREE.BoxGeometry(0.16, POST_H, 0.16);
    this.geometries.push(panelGeo, postGeo);

    const panelMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x2a2f38, roughness: 0.85, metalness: 0.2,
    });
    this.materials.push(panelMat, postMat);

    // Two panels per post; one post structure per marshalling sector.
    this.panels = new THREE.InstancedMesh(panelGeo, panelMat, sectorCount * 2);
    this.posts = new THREE.InstancedMesh(postGeo, postMat, sectorCount);
    this.panels.frustumCulled = false;
    this.posts.frustumCulled = false;
    this.root.add(this.panels, this.posts);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const euler = new THREE.Euler();

    for (let i = 0; i < sectorCount; i++) {
      // The post stands at the START of the sector it signals, so a driver
      // reads it on the way in. A post at the exit would be telling you about
      // a hazard you have already hit.
      const s = (i / sectorCount) * track.length;
      const idx = track.indexAt(s);
      const half = track.width[idx] * 0.5;

      // Which side of the road? The outside of the corner, where the marshals
      // actually stand, because the inside is where the cars are. Sign of the
      // normal against the racing line offset gives that for free: the line
      // hugs the inside, so the far side from the line is the outside.
      const side = Math.sign(track.lineOffset[idx]) || 1;
      const off = (half + 4.2) * side;

      const x = track.px[idx] + track.nx[idx] * off;
      const z = track.pz[idx] + track.nz[idx] * off;
      const y = track.elevationAt(s);

      // Face back down the road, so the panel is square-on to an approaching
      // car rather than edge-on.
      const heading = Math.atan2(track.tx[idx], track.tz[idx]);
      euler.set(0, heading + Math.PI, 0);
      q.setFromEuler(euler);

      pos.set(x, y + POST_H * 0.5, z);
      m.compose(pos, q, scale);
      this.posts.setMatrixAt(i, m);

      for (let p = 0; p < 2; p++) {
        pos.set(x, y + POST_H - 0.15 - p * (PANEL_H + 0.12), z);
        m.compose(pos, q, scale);
        this.panels.setMatrixAt(i * 2 + p, m);
      }

      this.shown.push('green');
      this.setPanelColours(i, 'green');
    }

    this.posts.instanceMatrix.needsUpdate = true;
    this.panels.instanceMatrix.needsUpdate = true;
    if (this.panels.instanceColor) this.panels.instanceColor.needsUpdate = true;
  }

  private setPanelColours(post: number, sig: FlagSignal): void {
    const lit = litPanels(sig);
    for (let p = 0; p < 2; p++) {
      this.colour.setHex(p < lit ? SIGNAL_COLOUR[sig] : UNLIT);
      this.panels.setColorAt(post * 2 + p, this.colour);
    }
  }

  /**
   * Repaints the posts from race control.
   *
   * Called once per rendered frame, but the instance colour buffer is only
   * uploaded when a post actually changed — which across a whole green-flag lap
   * is never.
   */
  update(rc: RaceControlManager): void {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const sig = rc.signalForSector(i);
      if (sig === this.shown[i]) continue;
      this.shown[i] = sig;
      this.setPanelColours(i, sig);
      dirty = true;
    }
    if (dirty && this.panels.instanceColor) this.panels.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.panels.dispose();
    this.posts.dispose();
  }
}
