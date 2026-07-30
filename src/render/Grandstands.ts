import * as THREE from 'three';
import { PartsBin, chamferBox, rand } from './ChamferKit';

/**
 * Grandstands.
 *
 * The version this replaces was a box for the seating deck, a flatter box for
 * the roof and two sticks holding it up. It read as exactly that: a grey slab
 * in a field. A grandstand is one of the few structures at a circuit that the
 * eye already knows the shape of, so getting it wrong is loud — and the shape
 * it knows is not a box, it is a *rake*. Rows stepping up and back at a fixed
 * rise, a roof cantilevered forward over them off a truss at the back, and the
 * whole thing packed with people.
 *
 * The rake is built as one extruded staircase profile rather than as stacked
 * slabs: one polygon, one extrusion, real steps, and the bevel puts a chamfer
 * on every nosing so each row catches a line of light. That stepped profile in
 * silhouette is what makes it a grandstand from 400 metres away, which is the
 * distance it is almost always seen at.
 *
 * The crowd is geometry, not a texture. Two quads per person — a body and a
 * head, both vertex-coloured — comes to four triangles, and a full stand of
 * three hundred people is 1200 triangles, which is less than one wheel of one
 * car. The advantage over a speckle texture is that the crowd sits *on* the
 * rows in three dimensions: it self-occludes down the rake, it thins out
 * correctly at the aisles, and it has a silhouette against the sky along the
 * back row. A texture on the rake gives none of that and always reads as
 * wallpaper.
 *
 * Local frame, chosen to match how the circuit's set dressing places its
 * instances: +X points away from the track (depth), +Z runs along the track
 * (width), the front barrier sits at x = 0 and the ground at y = 0.
 */

export interface GrandstandOptions {
  /** Length along the track, metres. */
  width: number;
  /** Number of seating rows. */
  rows: number;
  /** Depth of one row, metres. */
  tread: number;
  /** Height gained per row, metres. */
  rise: number;
  /** Draw the cantilever roof and its truss. */
  roof: boolean;
  /** Metres between people along a row. Larger means a thinner crowd. */
  crowdSpacing: number;
  /** Number of stair aisles cut through the seating. */
  aisles: number;
  /** Seat colour, so different stands are visibly different blocks. */
  seatColour: number;
  /** Seed, so two stands of the same size do not have identical crowds. */
  seed: number;
}

const CONCRETE = 0x9ea3a8;
const CONCRETE_DARK = 0x6c7075;
const STEEL = 0x9aa2ac;
const STEEL_DARK = 0x3d444c;
/**
 * Roof deck. Deliberately not white: with no shadow casting, the soffit's
 * downward normal is lit only by the hemisphere's ground colour, and a white
 * deck comes back as a glowing sheet hanging over the crowd.
 */
const ROOF_DECK = 0x9fa5ac;

/** Skin tones, deliberately spread. */
const SKIN = [0xf0c8a0, 0xd9a273, 0xa9744c, 0x7a4f30, 0xf7d9bb, 0x5c3a24];

/**
 * Shirt colours.
 *
 * Mostly neutral, with a minority of saturated colour. A crowd generated from
 * evenly-spread bright hues reads as confetti; a real crowd is grey and navy
 * and white with team colours punched through it, and that ratio is what makes
 * the bright ones register as people wearing something rather than as noise.
 */
const SHIRTS = [
  0xdfe3e8, 0xb9bec6, 0x8b929c, 0x4c525c, 0x2b3038, 0x1a1d22,
  0xe8eaed, 0xa7aebb, 0x6d747f, 0x3a4049,
  0xc8102e, 0x1b3a8f, 0xe8a01c, 0x1f7a4d, 0xd94f1a, 0x6b2d8f, 0x00a3a3, 0xf0d840,
];

/**
 * The seating rake: one extruded staircase.
 *
 * The profile runs anticlockwise in XY — along the ground, up the back, then
 * down the steps to the front — and is extruded along Z for the stand's width.
 */
function rakeGeometry(o: GrandstandOptions, front: number, backDepth: number): THREE.BufferGeometry {
  const { rows, tread, rise, width } = o;
  const deckDepth = rows * tread;
  const total = deckDepth + backDepth;
  const top = front + rows * rise;

  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(0, 0));
  pts.push(new THREE.Vector2(total, 0));
  pts.push(new THREE.Vector2(total, top));
  pts.push(new THREE.Vector2(deckDepth, top));
  for (let r = rows - 1; r >= 0; r--) {
    pts.push(new THREE.Vector2(r * tread, front + (r + 1) * rise));
    pts.push(new THREE.Vector2(r * tread, front + r * rise));
  }

  const shape = new THREE.Shape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -width / 2);
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return geo;
}

/**
 * The crowd: two vertex-coloured quads per person, all merged into one buffer.
 *
 * Every quad faces the track with a small random yaw, which is enough to stop
 * the rows reading as a printed pattern — people in a stand are all looking the
 * same way, but never at exactly the same angle.
 */
function crowdGeometry(o: GrandstandOptions, seatY: number[]): THREE.BufferGeometry | null {
  const { width, rows, tread, crowdSpacing } = o;
  const perRow = Math.max(2, Math.floor(width / crowdSpacing));
  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];

  const c = new THREE.Color();
  // Aisle centres, as a fraction of the width.
  const aisleAt: number[] = [];
  for (let a = 0; a < o.aisles; a++) aisleAt.push((a + 1) / (o.aisles + 1));

  let seed = o.seed * 7.13;
  const rnd = () => rand(seed++);

  const pushQuad = (
    cx: number, cy: number, cz: number,
    halfW: number, halfH: number, yaw: number,
    colour: THREE.Color,
  ) => {
    // Facing -X (toward the track), rotated by `yaw` about Y.
    const s = Math.sin(yaw), co = Math.cos(yaw);
    // In-plane horizontal axis before yaw is +Z.
    const ax = -s * halfW, az = co * halfW;
    const nx = -co, nz = -s;
    const v = [
      [cx - ax, cy - halfH, cz - az],
      [cx + ax, cy - halfH, cz + az],
      [cx + ax, cy + halfH, cz + az],
      [cx - ax, cy - halfH, cz - az],
      [cx + ax, cy + halfH, cz + az],
      [cx - ax, cy + halfH, cz - az],
    ];
    for (const p of v) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx, 0, nz);
      colours.push(colour.r, colour.g, colour.b);
    }
  };

  for (let r = 0; r < rows; r++) {
    const y = seatY[r];
    // Sit people just behind the nosing of their row.
    const x = r * tread + tread * 0.55;
    for (let i = 0; i < perRow; i++) {
      const f = (i + 0.5) / perRow;
      // Aisles: a gap in every row at the same place, as a real stand has.
      let inAisle = false;
      for (const a of aisleAt) if (Math.abs(f - a) < 0.022) inAisle = true;
      if (inAisle) continue;
      // Empty seats, more of them at the extreme ends and the very back.
      const occupancy = 0.96 - Math.abs(f - 0.5) * 0.28 - (r / rows) * 0.1;
      if (rnd() > occupancy) continue;

      const z = (f - 0.5) * width + (rnd() - 0.5) * crowdSpacing * 0.35;
      const yaw = (rnd() - 0.5) * 0.7;
      const scale = 0.9 + rnd() * 0.25;

      c.setHex(SHIRTS[Math.floor(rnd() * SHIRTS.length) % SHIRTS.length]);
      pushQuad(x, y + 0.34 * scale, z, 0.27 * scale, 0.34 * scale, yaw, c);
      c.setHex(SKIN[Math.floor(rnd() * SKIN.length) % SKIN.length]);
      pushQuad(x, y + 0.78 * scale, z, 0.12 * scale, 0.13 * scale, yaw, c);
    }
  }

  if (positions.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return g;
}

/**
 * Builds one complete grandstand as a single merged, vertex-coloured geometry.
 *
 * Returned centred on z and sitting on y = 0, so it can be dropped straight
 * into an InstancedMesh.
 */
export function buildGrandstandGeometry(o: GrandstandOptions): THREE.BufferGeometry {
  const bin = new PartsBin();
  const { width, rows, tread, rise } = o;

  // Height of the front row's floor above the ground. Real stands lift the
  // front row so the first row can see over the debris fence.
  const front = 1.35;
  const backDepth = 1.6;
  const deckDepth = rows * tread;
  const topY = front + rows * rise;

  // --- Seating rake ---------------------------------------------------------
  bin.addRaw(rakeGeometry(o, front, backDepth), CONCRETE);

  // --- Seat rows ------------------------------------------------------------
  // A coloured band along each tread. Mostly hidden by the crowd, which is the
  // point: the flashes of seat colour showing through the gaps are what makes
  // the crowd read as sitting in something.
  const seatY: number[] = [];
  const seatBand = chamferBox(0.52, 0.4, width - 0.4, 0);
  for (let r = 0; r < rows; r++) {
    const y = front + r * rise;
    seatY.push(y);
    bin.add(seatBand, o.seatColour, r * tread + tread * 0.7, y + 0.2, 0);
  }
  seatBand.dispose();

  // --- Front barrier and its advertising band ------------------------------
  const barrier = chamferBox(0.35, 1.15, width, 0.06);
  bin.add(barrier, CONCRETE_DARK, -0.2, 0.58, 0);
  barrier.dispose();
  const advert = chamferBox(0.12, 0.8, width - 0.6, 0.04);
  bin.add(advert, 0x14304f, -0.42, 0.66, 0);
  advert.dispose();

  // --- Stair aisles ---------------------------------------------------------
  //
  // A second, narrow rake at half the going, dropped into the gap the crowd
  // leaves. Twenty-odd step boxes per aisle would have cost more triangles
  // than the entire crowd; one extra extrusion costs a hundred and fifty.
  if (o.aisles > 0) {
    const stair: GrandstandOptions = { ...o, width: 1.15, rows: rows * 2, tread: tread / 2, rise: rise / 2 };
    for (let a = 0; a < o.aisles; a++) {
      const z = (((a + 1) / (o.aisles + 1)) - 0.5) * width;
      const g = rakeGeometry(stair, front, backDepth);
      g.translate(0, 0.03, z);
      bin.addRaw(g, 0xb4b8bd);
    }
  }

  // --- Crowd ---------------------------------------------------------------
  const crowd = crowdGeometry(o, seatY);
  if (crowd) bin.addPrepared(crowd);

  // --- Roof -----------------------------------------------------------------
  if (o.roof) {
    const roofY = topY + 4.4;
    const roofDepth = deckDepth + backDepth + 2.6;
    // The deck, cantilevered forward past the front row.
    const deck = chamferBox(roofDepth, 0.34, width + 0.8, 0.07);
    bin.add(deck, ROOF_DECK, roofDepth * 0.5 - 2.6, roofY, 0);
    deck.dispose();
    // A deeper fascia beam along the leading edge: the roof's own chamfered
    // edge is what stops it reading as a sheet of paper.
    const fascia = chamferBox(0.5, 0.95, width + 0.8, 0.08);
    bin.add(fascia, STEEL, -2.45, roofY - 0.3, 0);
    fascia.dispose();
    const trim = chamferBox(0.14, 0.3, width + 0.8, 0);
    bin.add(trim, o.seatColour, -2.75, roofY - 0.42, 0);
    trim.dispose();

    // Columns at the back, and a diagonal strut out to the roof: without the
    // strut the cantilever has nothing holding it and the eye notices.
    const bays = Math.max(2, Math.round(width / 9));
    const column = chamferBox(0.55, roofY, 0.55, 0.06);
    const strutLen = Math.hypot(deckDepth * 0.75, roofY - topY - 0.6);
    const strut = chamferBox(strutLen, 0.3, 0.3, 0);
    const angle = Math.atan2(roofY - topY - 0.6, deckDepth * 0.75);
    const m = new THREE.Matrix4();
    const tilt = new THREE.Matrix4();
    for (let b = 0; b <= bays; b++) {
      const z = (b / bays - 0.5) * (width - 0.6);
      bin.add(column, STEEL_DARK, deckDepth + backDepth - 0.4, roofY * 0.5, z);
      // Diagonal, rotated in the XY plane about Z.
      tilt.makeRotationZ(Math.PI - angle);
      m.makeTranslation(
        deckDepth + backDepth - 0.4 - Math.cos(angle) * strutLen * 0.5,
        topY + 0.6 + Math.sin(angle) * strutLen * 0.5,
        z,
      );
      m.multiply(tilt);
      bin.addAt(strut, STEEL, m);
    }
    column.dispose();
    strut.dispose();

    // Purlins across the underside, so the roof soffit is not a blank plane.
    const purlin = chamferBox(roofDepth - 0.6, 0.22, 0.22, 0);
    const purlins = Math.max(3, Math.round(width / 7));
    for (let p = 0; p <= purlins; p++) {
      const z = (p / purlins - 0.5) * (width - 0.4);
      bin.add(purlin, STEEL_DARK, roofDepth * 0.5 - 2.7, roofY - 0.28, z);
    }
    purlin.dispose();
  }

  // --- Back facade ----------------------------------------------------------
  // The back of a stand is scaffolding and cladding, and it is what you see
  // from most of the circuit, so it gets mullions rather than being a slab.
  const facadeH = topY;
  const facade = chamferBox(0.3, facadeH, width, 0.06);
  bin.add(facade, CONCRETE_DARK, deckDepth + backDepth + 0.1, facadeH * 0.5, 0);
  facade.dispose();
  const mullion = chamferBox(0.22, facadeH, 0.3, 0);
  const mullions = Math.max(3, Math.round(width / 5.5));
  for (let i = 0; i <= mullions; i++) {
    const z = (i / mullions - 0.5) * (width - 0.3);
    bin.add(mullion, STEEL, deckDepth + backDepth + 0.3, facadeH * 0.5, z);
  }
  mullion.dispose();
  // A coloured band around the top of the facade, as venues brand them.
  const band = chamferBox(0.24, 1.0, width, 0.05);
  bin.add(band, o.seatColour, deckDepth + backDepth + 0.32, facadeH - 0.8, 0);
  band.dispose();

  const merged = bin.merge();
  return merged ?? chamferBox(10, 8, 10, 0.2);
}

/** Sensible presets. */
export function grandstandPreset(
  kind: 'trackside' | 'main',
  quality: 'low' | 'high',
  seed: number,
): GrandstandOptions {
  const low = quality === 'low';
  if (kind === 'main') {
    return {
      width: 74,
      rows: low ? 9 : 16,
      tread: 0.95,
      rise: 0.48,
      roof: true,
      crowdSpacing: low ? 1.6 : 0.74,
      aisles: 3,
      seatColour: 0x1d4f8c,
      seed,
    };
  }
  return {
    width: 30,
    rows: low ? 6 : 9,
    tread: 0.95,
    rise: 0.46,
    roof: true,
    crowdSpacing: low ? 1.8 : 0.8,
    aisles: 1,
    seatColour: 0x2f6f5a,
    seed,
  };
}
