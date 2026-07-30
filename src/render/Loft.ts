import * as THREE from 'three';

/**
 * Lofted surface generation.
 *
 * A modern Formula 1 car has almost no flat surfaces on it. Building one from box
 * primitives produces something that reads unmistakably as boxes no matter how
 * many you use, because the silhouette is made of hard 90-degree corners and the
 * shading is faceted.
 *
 * The fix is to loft: define a series of cross-sections along the car's length,
 * each a smooth closed profile, and skin a surface between them. That gives a
 * continuously curved body whose silhouette tapers the way a real car's does, and
 * whose normals can be averaged for smooth shading. It is also how the shape would
 * be modelled in a 3D package, so the result is not an approximation of the right
 * technique — it is the right technique.
 */

/** A closed cross-section at some distance along the loft axis. */
export interface Section {
  /** Position along the loft axis (the car's Z, positive forward). */
  z: number;
  /** Half-width of the section. */
  halfWidth: number;
  /** Total height of the section. */
  height: number;
  /** Vertical centre of the section. */
  y: number;
  /**
   * Corner rounding, 0..1. At 0 the section is a rectangle; at 1 it is an
   * ellipse. Intermediate values give the squared-off-oval shape an F1
   * monocoque actually has.
   */
  round: number;
  /**
   * Flattens the top of the section, 0..1. Used for the cockpit opening and the
   * floor, both of which are flat on top of an otherwise rounded body.
   */
  flatTop?: number;
  /** Scales the lower half only — an undercut, as under a sidepod. */
  undercut?: number;
}

/**
 * Builds one closed ring of vertices for a section.
 *
 * Uses a superellipse rather than a blend of a rectangle and a circle: the
 * exponent gives direct control over how square the corners are, and it produces
 * evenly-distributed points, which matters because uneven spacing shows up as
 * banding in the shading.
 */
function ringFor(section: Section, segments: number, out: Float32Array, offset: number): void {
  const { halfWidth, height, y, round } = section;
  const flatTop = section.flatTop ?? 0;
  const undercut = section.undercut ?? 1;

  // Superellipse exponent: 2 is an ellipse, higher is squarer.
  const n = 2 + (1 - round) * 6;
  const halfHeight = height * 0.5;

  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);

    // Superellipse: |x/a|^n + |y/b|^n = 1, parameterised.
    const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * halfWidth;
    let py = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * halfHeight;

    // Flatten the upper surface toward a plane.
    if (flatTop > 0 && py > 0) {
      py = py * (1 - flatTop) + halfHeight * flatTop * (Math.abs(px) < halfWidth * 0.72 ? 1 : 0.35);
    }
    // Undercut narrows the lower half.
    const xScale = py < 0 ? 1 - (1 - undercut) * (-py / halfHeight) : 1;

    out[offset + i * 3] = px * xScale;
    out[offset + i * 3 + 1] = y + py;
    out[offset + i * 3 + 2] = section.z;
  }
}

/**
 * Skins a surface through the given sections.
 *
 * @param sections    ordered front-to-back; at least two
 * @param segments    vertices per ring; 20 is smooth enough at racing distance
 * @param capEnds     closes the first and last ring with a fan
 */
export function loft(
  sections: readonly Section[],
  segments = 20,
  capEnds = true,
): THREE.BufferGeometry {
  const rings = sections.length;
  const vertexCount = rings * segments;
  const positions = new Float32Array(vertexCount * 3);

  for (let r = 0; r < rings; r++) {
    ringFor(sections[r], segments, positions, r * segments * 3);
  }

  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * segments;
    const b = (r + 1) * segments;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      // Two triangles per quad, wound so the outward face is front-facing.
      indices.push(a + i, b + i, b + j);
      indices.push(a + i, b + j, a + j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);

  if (capEnds) {
    // Cap with a fan to a centre point at each end. Without caps the body is
    // visibly hollow from any angle that sees into it.
    const capGeos: THREE.BufferGeometry[] = [geo];
    capGeos.push(capRing(sections[0], segments, true));
    capGeos.push(capRing(sections[rings - 1], segments, false));
    const merged = mergeSimple(capGeos);
    merged.computeVertexNormals();
    for (const g of capGeos) if (g !== geo) g.dispose();
    geo.dispose();
    return merged;
  }

  // Averaged normals across shared vertices: this is what turns a faceted hull
  // into a smoothly-shaded surface.
  geo.computeVertexNormals();
  return geo;
}

function capRing(section: Section, segments: number, front: boolean): THREE.BufferGeometry {
  const ring = new Float32Array(segments * 3);
  ringFor(section, segments, ring, 0);

  const positions = new Float32Array((segments + 1) * 3);
  // Centre vertex.
  positions[0] = 0;
  positions[1] = section.y;
  positions[2] = section.z;
  for (let i = 0; i < segments; i++) {
    positions[(i + 1) * 3] = ring[i * 3];
    positions[(i + 1) * 3 + 1] = ring[i * 3 + 1];
    positions[(i + 1) * 3 + 2] = ring[i * 3 + 2];
  }

  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i + 1;
    const b = ((i + 1) % segments) + 1;
    if (front) indices.push(0, b, a);
    else indices.push(0, a, b);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

/** Concatenates position-and-index geometries. Avoids a BufferGeometryUtils import. */
function mergeSimple(geos: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  let vOff = 0;
  let iOff = 0;

  for (const g of geos) {
    const pos = g.attributes.position.array as ArrayLike<number>;
    positions.set(pos as unknown as Float32Array, vOff * 3);
    const idx = g.index;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    }
    vOff += g.attributes.position.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  return out;
}

/**
 * Builds a wing element: a cambered aerofoil extruded across the car.
 *
 * Boxes are the single most obvious tell of a procedural car, and wings are the
 * part of an F1 car a viewer looks at most. A real aerofoil section — thick
 * leading edge, thin trailing edge, curved underside — costs a handful of extra
 * triangles and completely changes how the car reads.
 */
export function wingElement(
  span: number,
  chord: number,
  thickness: number,
  camber: number,
  segments = 12,
): THREE.BufferGeometry {
  // Aerofoil profile in the chord/thickness plane, traced upper then lower.
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Cosine spacing clusters points at the leading edge, where curvature is.
    const x = (1 - Math.cos(t * Math.PI)) * 0.5;
    // NACA-like thickness distribution.
    const yt =
      thickness *
      (1.4845 * Math.sqrt(x) - 0.63 * x - 1.758 * x * x + 1.4215 * x * x * x - 0.5075 * x * x * x * x);
    // Camber line, biased to the rear like a high-downforce wing.
    const yc = camber * Math.sin(Math.pow(x, 0.75) * Math.PI);
    upper.push([x * chord, yc + yt]);
    lower.push([x * chord, yc - yt]);
  }

  const shape = new THREE.Shape();
  shape.moveTo(upper[0][0], upper[0][1]);
  for (let i = 1; i < upper.length; i++) shape.lineTo(upper[i][0], upper[i][1]);
  for (let i = lower.length - 1; i >= 0; i--) shape.lineTo(lower[i][0], lower[i][1]);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: span,
    bevelEnabled: false,
    curveSegments: 4,
  });
  // Extruded along +Z by default; orient across the car and centre it.
  geo.rotateY(Math.PI / 2);
  geo.translate(-span * 0.5 + span * 0.5, 0, 0);
  geo.center();
  geo.computeVertexNormals();
  return geo;
}
