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
 *
 * Every surface here carries UVs, because a livery is not a colour. It is graphics
 * — a flash down the sidepod, a contrasting nose, a race number — and graphics
 * need a parameterisation. A lofted surface has one for free: u runs around the
 * section, v runs along the car. That is the whole reason the body is lofted
 * rather than assembled, and it is what lets `Livery.ts` paint a car by drawing
 * into a canvas instead of by subdividing geometry.
 *
 * UV CONVENTION. u = 0 sits on the BOTTOM centreline and runs 0.25 left flank,
 * 0.5 top centreline, 0.75 right flank, 1.0 back to the bottom. The seam therefore
 * falls on the underside of the car, where nothing is ever drawn and nobody looks.
 * v = 0 is the first section (the front) and 1 the last, distributed by arc length
 * so a long taper does not squash the texture. `setPanelUV` turns that a quarter
 * turn on its way into the atlas; see the note there for why.
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
 * Builds a section from the two numbers that are actually easy to reason about
 * on a car: how high off the ground its underside and its upper surface sit.
 *
 * Every real constraint on this bodywork is expressed that way — the floor is at
 * 60mm, the cockpit rim at 550mm, the top of the airbox at 950mm — and converting
 * those to a centre and a height by hand at every station is how the first version
 * of this file ended up with a monocoque whose roof line wandered.
 */
export function section(
  z: number,
  halfWidth: number,
  bottom: number,
  top: number,
  round: number,
  extra?: { flatTop?: number; undercut?: number },
): Section {
  return {
    z,
    halfWidth,
    height: top - bottom,
    y: (top + bottom) * 0.5,
    round,
    flatTop: extra?.flatTop,
    undercut: extra?.undercut,
  };
}

/**
 * One point on a section's outline.
 *
 * Uses a superellipse rather than a blend of a rectangle and a circle: the
 * exponent gives direct control over how square the corners are, and it produces
 * evenly-distributed points, which matters because uneven spacing shows up as
 * banding in the shading.
 *
 * The parameter starts at the bottom of the section rather than the side, which
 * is what puts the UV seam under the car.
 */
function profilePoint(s: Section, t01: number): { x: number; y: number } {
  const flatTop = s.flatTop ?? 0;
  const undercut = s.undercut ?? 1;

  // Superellipse exponent: 2 is an ellipse, higher is squarer.
  const n = 2 + (1 - s.round) * 6;
  const halfHeight = s.height * 0.5;

  const t = t01 * Math.PI * 2 - Math.PI / 2;
  const c = Math.cos(t);
  const sn = Math.sin(t);

  const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * s.halfWidth;
  let py = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n) * halfHeight;

  // Flatten the upper surface toward a plane.
  if (flatTop > 0 && py > 0) {
    py = py * (1 - flatTop) + halfHeight * flatTop * (Math.abs(px) < s.halfWidth * 0.72 ? 1 : 0.35);
  }
  // Undercut narrows the lower half.
  const xScale = py < 0 ? 1 - (1 - undercut) * (-py / halfHeight) : 1;

  return { x: px * xScale, y: s.y + py };
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
  // One extra column duplicating the seam. Without it the last quad has to run
  // its u from (segments-1)/segments back to 0, so the whole texture is smeared
  // backwards across a single strip on the underside.
  const cols = segments + 1;
  const ringVerts = rings * cols;
  const capVerts = capEnds ? 2 * (segments + 1) : 0;
  const total = ringVerts + capVerts;

  const positions = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);

  // v by arc length along the loft axis, so a long slow taper does not get the
  // same slice of the texture as a short abrupt one.
  const vs = new Float32Array(rings);
  let run = 0;
  for (let r = 1; r < rings; r++) {
    run += Math.abs(sections[r].z - sections[r - 1].z);
    vs[r] = run;
  }
  if (run > 1e-6) for (let r = 0; r < rings; r++) vs[r] /= run;
  else for (let r = 0; r < rings; r++) vs[r] = r / Math.max(1, rings - 1);

  for (let r = 0; r < rings; r++) {
    const s = sections[r];
    for (let i = 0; i < cols; i++) {
      const t = (i % segments) / segments;
      const p = profilePoint(s, i === segments ? 1 : t);
      const o = (r * cols + i) * 3;
      positions[o] = p.x;
      positions[o + 1] = p.y;
      positions[o + 2] = s.z;
      const uo = (r * cols + i) * 2;
      // u runs the opposite way round the section to the vertex order. That is
      // not arbitrary: it makes the (u, v) frame right-handed against the
      // outward normal, and without it every graphic on the car — numbers
      // especially — comes out mirrored.
      uvs[uo] = 1 - i / segments;
      uvs[uo + 1] = vs[r];
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    const a = r * cols;
    const b = (r + 1) * cols;
    for (let i = 0; i < segments; i++) {
      // Two triangles per quad, wound so the outward face is front-facing.
      indices.push(a + i, b + i, b + i + 1);
      indices.push(a + i, b + i + 1, a + i + 1);
    }
  }

  if (capEnds) {
    // Cap with a fan to a centre point at each end. Without caps the body is
    // visibly hollow from any angle that sees into it.
    let base = ringVerts;
    for (const front of [true, false]) {
      const s = front ? sections[0] : sections[rings - 1];
      const v = front ? 0 : 1;
      positions[base * 3] = 0;
      positions[base * 3 + 1] = s.y;
      positions[base * 3 + 2] = s.z;
      uvs[base * 2] = 0.5;
      uvs[base * 2 + 1] = v;
      for (let i = 0; i < segments; i++) {
        const p = profilePoint(s, i / segments);
        const idx = base + 1 + i;
        positions[idx * 3] = p.x;
        positions[idx * 3 + 1] = p.y;
        positions[idx * 3 + 2] = s.z;
        uvs[idx * 2] = 1 - i / segments;
        uvs[idx * 2 + 1] = v;
      }
      for (let i = 0; i < segments; i++) {
        const a = base + 1 + i;
        const b = base + 1 + ((i + 1) % segments);
        if (front) indices.push(base, b, a);
        else indices.push(base, a, b);
      }
      base += segments + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  // Averaged normals across shared vertices: this is what turns a faceted hull
  // into a smoothly-shaded surface.
  geo.computeVertexNormals();

  // The seam column is a positional duplicate, so its averaged normal only saw
  // half the surface. Left alone it draws a visible crease down the car.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let r = 0; r < rings; r++) {
    const a = r * cols;
    const b = a + segments;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / len, ny / len, nz / len);
    nrm.setXYZ(b, nx / len, ny / len, nz / len);
  }
  nrm.needsUpdate = true;

  return geo;
}

/**
 * Remaps a lofted surface's UVs into a panel of a texture atlas, turning them a
 * quarter turn on the way.
 *
 * The rotation is not cosmetic. A car is three times longer than it is round, so
 * mapping the length onto the texture's short axis leaves roughly forty pixels
 * per metre along the car against three hundred across it. Text drawn into that
 * comes out four characters wide and a metre long — which is exactly what the
 * first attempt produced. Turning the panel so the car's LENGTH runs along the
 * atlas's long axis brings the two densities within a factor of one and a half,
 * and everything drawn into it keeps its proportions.
 *
 * Texture u therefore carries the loft's v (front to back) and texture v carries
 * the loft's u (round the section), negated so the frame stays right-handed
 * against the outward normal and nothing comes out mirrored.
 */
export function setPanelUV(
  geo: THREE.BufferGeometry,
  u0: number, v0: number, u1: number, v1: number,
): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) {
    const around = uv.getX(i);
    const along = uv.getY(i);
    uv.setXY(i, u0 + along * (u1 - u0), v0 + (1 - around) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Points every vertex at one texel.
 *
 * Parts that are a single flat colour — a wishbone, an endplate, a tyre — do not
 * need a parameterisation, but they do have to live in the same material as the
 * painted bodywork or the car costs a draw call per colour. Pinning them to a
 * swatch in the atlas is what collapses the entire shell to one draw call.
 */
export function setFlatUV(geo: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
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
  geo.center();
  geo.computeVertexNormals();
  return geo;
}

/**
 * A straight round member between two points: a wishbone leg, a pushrod, a
 * mirror stalk.
 *
 * Suspension is worth more than it sounds. The gap between a wheel and the
 * bodywork is a large, obviously-empty void, and filling it with the right
 * linkage geometry is most of what makes an open-wheeler read as engineered
 * rather than as a toy.
 */
export function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number,
  radialSegments = 5,
  capped = false,
): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  // Open-ended by default: a suspension member's ends are buried in an upright
  // or a chassis pickup, and end caps on twenty-eight of them per car is a few
  // hundred triangles nobody will ever see.
  const g = new THREE.CylinderGeometry(r, r, len, radialSegments, 1, !capped);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  g.applyQuaternion(q);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/**
 * A swept tube through a smooth curve. Used for the halo, which is the one part
 * of the car that is genuinely a bent pipe and looks wrong as anything else.
 */
export function tube(
  points: readonly [number, number, number][],
  radius: number,
  tubularSegments = 24,
  radialSegments = 6,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    'catmullrom',
    0.5,
  );
  return new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
}
