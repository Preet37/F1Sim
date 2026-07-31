import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry primitives for trackside architecture.
 *
 * Everything built here exists to avoid one specific failure: the raw
 * BoxGeometry silhouette. A box has infinitely sharp edges, and an infinitely
 * sharp edge is the one thing that never happens in the real world — every
 * built structure has a rolled edge, a chamfer, a capping strip or a shadow
 * gap, and that edge is what the eye reads as "made of something". A cube of
 * concrete and a cube of steel lit identically are indistinguishable; give one
 * a 40mm chamfer and the highlight running along it tells you the size of the
 * object, the hardness of the material, and the direction of the sun, all at
 * once. That single line of specular is worth more than any texture.
 *
 * So the base primitive here is a chamfered box, and everything in the paddock
 * and the grandstands is built from it. The cost is real but small: a chamfered
 * box is ~100 triangles against a box's 12. The whole point of merging is that
 * those triangles are free at draw time — a hundred chamfered boxes merged into
 * one buffer is one draw call, exactly like a hundred plain boxes would be.
 *
 * All the builders here return geometry carrying `position`, `normal` and
 * `color` and nothing else, because `mergeGeometries` refuses to merge buffers
 * whose attribute sets differ, and a stray `uv` from ExtrudeGeometry is the
 * usual reason a merge silently returns null.
 */

/** Scratch objects, so building a few thousand pieces allocates almost nothing. */
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * A box with every edge chamfered.
 *
 * Built as an extruded rounded rectangle: the profile is chamfered in the
 * extrusion plane and the bevel chamfers the two end caps, so all twelve edges
 * come out cut. `bevelSegments: 1` and `curveSegments: 1` keep it a true flat
 * chamfer rather than a rounded fillet — cheaper, and correct for the extruded
 * aluminium and precast concrete this is standing in for.
 */
export function chamferBox(w: number, h: number, d: number, bevel = 0.06): THREE.BufferGeometry {
  // A chamfered box is ~60 triangles against a plain box's 12. That is the
  // right trade for anything with a lit edge in view, and the wrong one for a
  // seat back, a window mullion or a forearm — small parts read by their
  // colour and their silhouette, never by their edge highlight. Passing zero
  // asks for the cheap one, and half the paddock does.
  if (bevel <= 0) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.deleteAttribute('uv');
    return g;
  }
  const r = Math.max(0.005, Math.min(bevel, w * 0.45, h * 0.45, d * 0.45));
  const sw = w - 2 * r;
  const sh = h - 2 * r;
  const sd = d - 2 * r;

  const shape = new THREE.Shape();
  const x0 = -sw / 2, x1 = sw / 2, y0 = -sh / 2, y1 = sh / 2;
  const c = Math.min(r * 1.6, sw * 0.49, sh * 0.49);
  shape.moveTo(x0 + c, y0);
  shape.lineTo(x1 - c, y0); shape.quadraticCurveTo(x1, y0, x1, y0 + c);
  shape.lineTo(x1, y1 - c); shape.quadraticCurveTo(x1, y1, x1 - c, y1);
  shape.lineTo(x0 + c, y1); shape.quadraticCurveTo(x0, y1, x0, y1 - c);
  shape.lineTo(x0, y0 + c); shape.quadraticCurveTo(x0, y0, x0 + c, y0);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: sd,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
    steps: 1,
  });
  // Extrusion runs 0..sd with the bevel adding r at each end, so the solid
  // spans -r .. sd+r. Recentre it on the origin.
  geo.translate(0, 0, -sd / 2);
  geo.deleteAttribute('uv');
  // Non-indexed, so this gives flat per-face normals and the chamfers keep a
  // hard highlight instead of smearing into a rounded blob.
  geo.computeVertexNormals();
  return geo;
}

/** A flat quad in the XY plane facing +Z, centred on the origin. Two triangles. */
export function quadXY(w: number, h: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const x = w / 2, y = h / 2;
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -x, -y, 0, x, -y, 0, x, y, 0,
    -x, -y, 0, x, y, 0, -x, y, 0,
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ], 3));
  return g;
}

/**
 * A cylinder with its rim chamfered — a tyre, a bollard, a light pole.
 * `openEnded` cylinders show a paper-thin edge on end; the chamfer gives the
 * rim a real thickness.
 */
export function chamferCylinder(
  radius: number, height: number, segments: number, chamfer = 0.05,
): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0, -height / 2),
    new THREE.Vector2(radius - chamfer, -height / 2),
    new THREE.Vector2(radius, -height / 2 + chamfer),
    new THREE.Vector2(radius, height / 2 - chamfer),
    new THREE.Vector2(radius - chamfer, height / 2),
    new THREE.Vector2(0, height / 2),
  ];
  // Lathe geometry is indexed and everything else here is not; mergeGeometries
  // refuses a mixture, so flatten it now rather than at every call site.
  const g = new THREE.LatheGeometry(pts, segments).toNonIndexed();
  g.deleteAttribute('uv');
  // This used to call `computeVertexNormals`, which on a non-indexed buffer can
  // only produce per-face normals — so every cylinder in the paddock was
  // flat-shaded and an eight-sided tyre read as an octagonal prism rather than
  // as a coarse cylinder. Angle-based smoothing instead: the barrel becomes a
  // continuous curve and the chamfer, which meets it at 45 degrees, keeps its
  // hard highlight. That highlight was the entire point of the chamfer.
  return toCreasedNormals(g, (36 * Math.PI) / 180);
}

/**
 * A capsule: a cylinder with hemispherical ends, smooth-shaded throughout.
 *
 * Exists for limbs. A forearm built as a box has four hard edges down its
 * length and two square ends, and no amount of anything else rescues a figure
 * whose arms are rectangular — the eye knows exactly what an arm looks like.
 */
export function limbGeometry(
  radius: number, length: number, segments: number, capRings = 3,
): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.001, length), capRings, segments)
    .toNonIndexed();
  g.deleteAttribute('uv');
  return g;
}

/**
 * Scales a geometry and corrects its normals for the scale.
 *
 * `BufferGeometry.scale` moves the positions and leaves the normal attribute
 * alone, so a sphere squashed into a head shape is still lit as a sphere. A
 * normal transforms by the INVERSE of a scale, not by the scale.
 */
export function scaleWithNormals(
  geo: THREE.BufferGeometry, sx: number, sy: number, sz: number,
): THREE.BufferGeometry {
  geo.scale(sx, sy, sz);
  const n = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!n) return geo;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i) / sx, y = n.getY(i) / sy, z = n.getZ(i) / sz;
    const len = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / len, y / len, z / len);
  }
  n.needsUpdate = true;
  return geo;
}

/** A smooth-shaded sphere with no UVs, ready to merge. A head, a helmet. */
export function ball(radius: number, segments: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, segments, Math.max(4, Math.round(segments * 0.65)))
    .toNonIndexed();
  g.deleteAttribute('uv');
  return g;
}

/**
 * Applies a flat colour to a geometry as a vertex-colour attribute.
 *
 * Also drops any index buffer, because `mergeGeometries` will not merge indexed
 * geometry with non-indexed geometry and quietly returns null when asked to —
 * which shows up as an entire building silently missing from the scene.
 */
export function paint(geo: THREE.BufferGeometry, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.copy(flat);
    flat.dispose();
  }
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _c.set(colour);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c.r;
    arr[i * 3 + 1] = _c.g;
    arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/**
 * Collects painted geometry, positions each piece, and merges the lot into one
 * buffer. This is the workhorse: a whole pit building goes in as fifty separate
 * chamfered boxes and comes out as a single draw call.
 */
export class PartsBin {
  private parts: THREE.BufferGeometry[] = [];

  /**
   * Adds a piece. `geo` is consumed — cloned internally when placed more than
   * once, disposed by `merge()`.
   */
  add(
    geo: THREE.BufferGeometry,
    colour: THREE.ColorRepresentation,
    x: number, y: number, z: number,
    rotY = 0,
    scale?: THREE.Vector3,
  ): void {
    const g = geo.clone();
    paint(g, colour);
    _m.makeRotationY(rotY);
    if (scale) _m.scale(scale);
    _m.setPosition(x, y, z);
    g.applyMatrix4(_m);
    this.parts.push(g);
  }

  /** Adds a piece under an arbitrary transform. `geo` is cloned. */
  addAt(geo: THREE.BufferGeometry, colour: THREE.ColorRepresentation, m: THREE.Matrix4): void {
    const g = geo.clone();
    paint(g, colour);
    g.applyMatrix4(m);
    this.parts.push(g);
  }

  /** Adds an already-positioned geometry, taking ownership of it. */
  addRaw(geo: THREE.BufferGeometry, colour: THREE.ColorRepresentation): void {
    paint(geo, colour);
    this.parts.push(geo);
  }

  /**
   * Adds geometry that already carries its own per-vertex colours — the crowd,
   * where every vertex is a different shirt.
   */
  addPrepared(geo: THREE.BufferGeometry): void {
    this.parts.push(geo);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** Merges and returns one geometry, or null if nothing was added. */
  merge(): THREE.BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (merged) merged.computeBoundingSphere();
    return merged;
  }
}

/**
 * Deterministic pseudo-random in 0..1.
 *
 * The scene must look identical on every load — a paddock that reshuffles its
 * crowd and its equipment each time you enter the session reads as noise, and
 * it makes screenshots useless for judging a change.
 */
export function rand(seed: number): number {
  const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Standard material for merged, vertex-coloured architecture. */
export function structureMaterial(opts: {
  roughness?: number; metalness?: number; side?: THREE.Side;
} = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.12,
    side: opts.side ?? THREE.FrontSide,
  });
}
