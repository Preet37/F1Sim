/**
 * Generates the car's image textures into public/textures/.
 *
 * WHY THESE ARE FILES AND NOT CANVASES. Everything else this renderer draws is
 * painted into a canvas at startup, and for the livery — which is different for
 * every team and changes when a car is renumbered — that is the right answer.
 * These two are not like that. They are fine, high-frequency surface detail:
 * the carbon weave that every dark panel on the car is made of, and the moulded
 * relief of a tyre. Both are the SAME for all twenty cars for the whole life of
 * the program, both want to be sampled thousands of times across a frame, and
 * both are far too fine to draw with 2D canvas primitives at any sane cost —
 * the weave alone is a couple of hundred thousand shaded texels.
 *
 * Committing them as PNGs means they are built once, here, and thereafter cost
 * the GPU one upload and the download one file each.
 *
 * PROVENANCE. Every pixel below is computed from the code in this file. There
 * is no traced photograph, no scanned sample, no third-party asset and no mark
 * of any kind in either image. See public/textures/LICENSES.md.
 *
 * Run with: node scripts/generateTextures.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures');

// ---------------------------------------------------------------------------
// A minimal PNG writer
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Writes an 8-bit RGB PNG. `rgb` is size*size*3 bytes. */
function writePng(path, size, rgb) {
  const stride = size * 3;
  // One filter byte per scanline. Filter 1 (Sub) predicts each pixel from the
  // one to its left, which compresses a smooth gradient far better than none.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      raw[o + 1 + x] = (v - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return raw.length;
}

// ---------------------------------------------------------------------------
// Height field -> tangent-space normal map
// ---------------------------------------------------------------------------

/**
 * Converts a tileable height field to a normal map by central differences.
 *
 * Wrapping the sample indices is what keeps the result seamless: a normal map
 * whose edge gradients were computed against a clamped neighbour shows a hard
 * line down every tile boundary, which on a car covered in the same weave is a
 * grid of creases.
 */
function heightToNormal(size, height, strength, wrap = true) {
  const rgb = Buffer.alloc(size * size * 3);
  const at = (x, y) => {
    const xi = wrap ? ((x % size) + size) % size : Math.max(0, Math.min(size - 1, x));
    const yi = wrap ? ((y % size) + size) % size : Math.max(0, Math.min(size - 1, y));
    return height[yi * size + xi];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Tangent space: +x right, +y up in texture space, +z out of the surface.
      // Texture v runs downward, hence the sign on dy.
      let nx = -dx, ny = dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 3;
      rgb[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// 1. Carbon fibre, 2x2 twill
// ---------------------------------------------------------------------------

/**
 * The weave every dark part of the car is made of.
 *
 * A 2/2 twill is the cloth used for almost all visible structural carbon: each
 * tow passes over two and under two, and the crossing point shifts by one tow
 * per row, which is what produces the diagonal the eye actually recognises. Get
 * the diagonal wrong and it reads as a chequerboard, which is a plain weave and
 * looks like basketwork.
 *
 * Two frequencies of relief are in here and both matter. The tow itself is a
 * rounded ridge a few millimetres across — that is what catches the broad
 * highlight. Along each tow runs a much finer striation from the individual
 * filaments, and that is what stops the surface reading as moulded plastic when
 * a light source sweeps across it.
 */
function carbonWeave(size) {
  const TOWS = 16;              // tows across the tile: ~6mm each at a 0.10m tile
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TOWS;
      const v = (y / size) * TOWS;
      const i = Math.floor(u), j = Math.floor(v);
      const fu = u - i, fv = v - j;
      // 2/2 twill: the warp is on top where (i - j) mod 4 is 0 or 1.
      const warpOnTop = ((((i - j) % 4) + 4) % 4) < 2;
      // Across-tow profile: a cosine hump, so the tow is a rounded ridge.
      const across = warpOnTop ? fu : fv;
      const along = warpOnTop ? fv : fu;
      let z = Math.cos((across - 0.5) * Math.PI) * 0.5 + 0.5;
      z = Math.pow(z, 0.55);
      // The tow that is underneath still shows in the gap, a little lower.
      const base = warpOnTop ? 1.0 : 0.62;
      // Filament striation along the tow: fine, low amplitude, and phase-locked
      // to the tow so it travels with it rather than across it.
      const filaments = Math.sin(across * Math.PI * 2 * 4 + (warpOnTop ? 0 : 1.7)) * 0.035;
      // A slight dip where the tow dives under its neighbour.
      const crossfade = Math.sin(along * Math.PI) * 0.16 + 0.84;
      h[y * size + x] = (z * base + filaments) * crossfade;
    }
  }
  return heightToNormal(size, h, 4.2);
}

// ---------------------------------------------------------------------------
// 2. Tyre surface relief
// ---------------------------------------------------------------------------

/**
 * The moulded relief of a slick, laid out to match the tyre's own atlas.
 *
 * The wheel material samples ONE texture with u running once around the
 * circumference and v across the profile, and the bottom 46 per cent of that
 * atlas is taken up by flat swatches for the rim, disc and caliper. So the map
 * has to be flat there — a normal map that perturbed those would light the
 * brake disc with tyre tread — and carry relief only in the band above.
 *
 * A DRY FORMULA 1 TYRE IS A SLICK. There is no tread pattern on it of any kind
 * — no circumferential grooves, no blocks, no sipes, nothing. Only the
 * intermediate and the full wet carry moulded grooves, and this game does not
 * change the carcass when it changes compound. That single sentence is the
 * whole specification for the tread half of this map, and the previous version
 * violated it: it laid 36 cycles of sine down the tread at 0.11 amplitude,
 * which through a 0.42 normal scale came out as visible circumferential ribs
 * running right round both tyres. Every close shot of the car showed a tyre
 * that looked like it had been moulded for a road car. The complaint — "the
 * tires are clean and smooth, yours have lines on them and its wrong" — was
 * literally about this array.
 *
 * So the tread now carries NO periodic relief at all. What is left is the only
 * thing a real slick's surface actually has:
 *
 *  - GRAINING. Broad, irregular, low-amplitude mottling across the working part
 *    of the tread, from rubber being torn and laid back down. Aperiodic by
 *    construction, so it can never read as a pattern however close the camera
 *    gets.
 *  - THE SHOULDER. Left dead smooth: it is the part of the tyre the light
 *    actually rakes across, and any relief there turns straight into a ribbed
 *    highlight, which is the failure being fixed.
 *  - THE SIDEWALL. Radial ribs are real — they are the mould's own draft marks
 *    and they run from the bead outward on every moulded sidewall — but they
 *    are subtle, so the amplitude is now a third of what it was, and they stop
 *    well before the shoulder.
 *  - THE BEAD STEP, where the carcass turns down onto the rim.
 *
 * TYRE_BAND in TyreTexture.ts is the contract. If it moves, this moves.
 *
 * EVERY FREQUENCY IN HERE IS BOUNDED BY THE SAMPLING RATE, and the first version
 * was not. Its circumferential striation ran 110 cycles across a tread band that
 * occupies 133 of the map's 512 rows — 2.5 pixels per cycle, right on the
 * Nyquist limit, so the BASE level of the map was already aliased before a
 * single mip was generated. Its graining came from a hash indexed by
 * `Math.floor`, which is block noise: a hard step at every cell boundary, and a
 * normal map is the DERIVATIVE of its height field, so a hard step is an
 * impulse. Mipmapping cannot rescue either — averaging aliased content produces
 * noise, not smoothness.
 *
 * The symptom was measured rather than guessed: high-frequency energy on the
 * tyre went from 5.5 at 1.9 metres to 20.0 at 14 metres. Detail that gets
 * STRONGER as it gets smaller is aliasing by definition; a correctly band-
 * limited surface fades as the prefiltered mips take over. That is what "the
 * wheels look exceptionally grainy" was.
 *
 * The rule applied below: nothing finer than about eight pixels per cycle at the
 * 512-pixel base, which is the point at which trilinear filtering has something
 * real to average.
 */
function tyreSurface(size) {
  const BAND_V0 = 0.46;
  const h = new Float32Array(size * size);
  // Deterministic value noise, so the graining is identical on every build.
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  /**
   * Smoothly interpolated value noise on a lattice.
   *
   * The smoothstep is the entire point. Sampling `hash(floor(x), floor(y))`
   * gives every cell a hard border, and a height field made of hard borders
   * differentiates into a grid of bright lines — which is most of what the tyre
   * was covered in. Interpolating with a Hermite ease makes the field C1, so its
   * gradient is continuous and the graining reads as mottling rather than as
   * dirt on the lens. It also wraps in x, so the seam around the circumference
   * stays invisible.
   */
  const vnoise = (x, y, periodX) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const wrap = (a) => ((a % periodX) + periodX) % periodX;
    const a = hash(wrap(xi), yi), b = hash(wrap(xi + 1), yi);
    const c = hash(wrap(xi), yi + 1), d = hash(wrap(xi + 1), yi + 1);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  // Radial ribs around the sidewall. 48 over 512 columns is 10.7 pixels each; it
  // was 96, which is 5.3 and visibly crawled. The amplitude is a third of what
  // it was, for the same reason the tread striation is gone entirely: a
  // resolvable line is a visible line, and a sidewall that reads as corrugated
  // from ten metres is as wrong as a treaded slick.
  const RIBS = 48;
  const RIB_AMPLITUDE = 0.055;
  for (let y = 0; y < size; y++) {
    // Canvas y runs down; atlas v runs up.
    const v = 1 - y / (size - 1);
    if (v < BAND_V0) continue;                    // swatch region: dead flat
    // t: 0 at the inboard bead, 1 at the outboard bead.
    const t = (v - BAND_V0) / (1 - BAND_V0);
    const fromCrown = Math.abs(t - 0.5) * 2;      // 0 at the crown, 1 at a bead
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let z = 0;
      if (fromCrown < 0.62) {
        // TREAD AND SHOULDER: no periodic relief whatsoever. A slick is smooth.
        //
        // Graining only, in broad aperiodic patches across the part of the tread
        // that does the work, fading out completely before the shoulder turn so
        // the shoulder — the part light rakes across — stays dead flat.
        const g = vnoise(u * 22, t * 24, 22);
        const reach = Math.min(1, Math.max(0, (0.62 - fromCrown) / 0.30));
        z += (g - 0.5) * 0.34 * reach * reach;
      } else {
        // Sidewall: shallow radial ribs, and a moulded step at the bead. The
        // ribs fade IN away from the shoulder rather than starting at full
        // amplitude, so there is no discontinuity where the two regions meet —
        // a step here is an impulse in the derivative, which is a bright ring.
        const into = Math.min(1, (fromCrown - 0.62) / 0.10);
        z += Math.sin(u * Math.PI * 2 * RIBS) * RIB_AMPLITUDE * into * into * (3 - 2 * into);
        // Eased, not stepped. A bare `if` here put a one-pixel cliff right round
        // the tyre and the normal map turned it into a hard bright ring.
        const b = Math.min(1, Math.max(0, (fromCrown - 0.86) / 0.10));
        z += b * b * (3 - 2 * b) * 0.7;
      }
      h[y * size + x] = z;
    }
  }
  // Wraps around u (the circumference) but NOT across v, where the band meets
  // the swatch region and wrapping would bleed tread relief onto the rim.
  const rgb = Buffer.alloc(size * size * 3);
  const at = (x, y) => {
    const xi = ((x % size) + size) % size;
    const yi = Math.max(0, Math.min(size - 1, y));
    return h[yi * size + xi];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 1.1;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 1.1;
      let nx = -dx, ny = dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 3;
      rgb[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// 3. Driver's glove
// ---------------------------------------------------------------------------

/**
 * A Nomex racing glove, as relief.
 *
 * WHY THIS ONE EARNS A FILE. The driver's hands sit about 500mm from the
 * cockpit camera — closer than anything else in the scene except the wheel rim
 * they are wrapped around — and they are made of cloth, which is the one
 * material that cannot be faked with a roughness value. A flat dark surface at
 * that range reads as moulded rubber however well the fingers are shaped, and
 * the complaint that produced this file was about the hands specifically. Every
 * other argument for committing a texture applies too: it is identical for all
 * twenty cars, it never changes, and the knit is a hundred thousand shaded
 * texels that no 2D canvas primitive is going to draw cheaply.
 *
 * THE LAYOUT IS A CONTRACT. `GLOVE_PANEL` in src/render/CockpitMesh.ts holds
 * the same three bands and maps each part of the hand into one of them. If
 * either moves, both move.
 *
 *   v 0.00 - 0.46   FIELD   plain knit, tileable in u. Fingers, thumb, wrist.
 *   v 0.46 - 0.78   PALM    knit plus padded pads with stitched borders.
 *   v 0.78 - 1.00   CUFF    knit plus elastic ribbing and a double-stitched hem.
 *
 * WHAT IS IN THE KNIT. Nomex glove backs are a fine jersey: courses of
 * interlocking loops, roughly a millimetre across, leaning alternately left and
 * right row by row. That alternation is the whole recognisable signature — a
 * grid of identical bumps reads as golf-ball dimpling, and a single diagonal
 * reads as the carbon twill already on the car. The yarn is given a small
 * deterministic irregularity per loop so a light sweeping across it breaks up
 * rather than travelling as one clean band.
 *
 * No lettering, no logo, no maker's mark: a knit, a pad and a row of stitches
 * are generic objects. See public/textures/LICENSES.md.
 */
function gloveNomex(size) {
  const PALM_V0 = 0.46, CUFF_V0 = 0.78;
  const LOOPS = 30;              // knit loops across the tile
  const h = new Float32Array(size * size);
  const hash = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // A rounded rectangle's coverage, 1 inside, falling to 0 over `soft`.
  const pad = (u, v, cu, cv, w, hh, r, soft) => {
    const dx = Math.max(Math.abs(u - cu) - (w * 0.5 - r), 0);
    const dy = Math.max(Math.abs(v - cv) - (hh * 0.5 - r), 0);
    const d = Math.hypot(dx, dy) - r;
    return Math.max(0, Math.min(1, -d / soft));
  };

  for (let y = 0; y < size; y++) {
    // Canvas y runs down; atlas v runs up.
    const v = 1 - y / (size - 1);
    for (let x = 0; x < size; x++) {
      const u = x / size;

      // --- The knit, everywhere ------------------------------------------
      const cu = u * LOOPS, cv = v * LOOPS;
      const i = Math.floor(cu), j = Math.floor(cv);
      const fu = cu - i, fv = cv - j;
      // Courses lean alternately, which is what makes it a knit rather than a
      // weave. The lean shears the loop within its own cell.
      const lean = j % 2 === 0 ? 0.28 : -0.28;
      const su = fu + (fv - 0.5) * lean;
      const arc = Math.cos((su - 0.5) * Math.PI) * Math.cos((fv - 0.5) * Math.PI);
      let z = Math.pow(Math.max(0, arc), 0.65) * 0.42;
      // The interlock: a shallow groove where one course passes through the next.
      z -= Math.max(0, Math.cos((fv - 0.5) * Math.PI * 2)) * 0.10;
      // Yarn irregularity, deterministic per loop.
      z += (hash(i, j) - 0.5) * 0.06;

      if (v >= PALM_V0 && v < CUFF_V0) {
        // --- Palm: padding and stitching ---------------------------------
        // t runs 0..1 across the band, u along the part.
        const t = (v - PALM_V0) / (CUFF_V0 - PALM_V0);
        // Three pads: the heel of the hand, the base of the fingers, and a
        // narrow strip between them. Raised well proud of the knit, because a
        // pad is a separate layer of leather sewn on top of one.
        const pads =
          Math.max(
            pad(u, t, 0.22, 0.50, 0.28, 0.60, 0.10, 0.035),
            pad(u, t, 0.62, 0.52, 0.34, 0.52, 0.09, 0.035),
            pad(u, t, 0.90, 0.50, 0.14, 0.40, 0.07, 0.035),
          );
        z += pads * 0.85;
        // Stitching: a groove just outside each pad's edge with the thread
        // sitting in it. `pads` at a slightly larger radius minus `pads` is the
        // border ring, which is where the needle goes.
        const ring =
          Math.max(
            pad(u, t, 0.22, 0.50, 0.30, 0.62, 0.10, 0.020),
            pad(u, t, 0.62, 0.52, 0.36, 0.54, 0.09, 0.020),
            pad(u, t, 0.90, 0.50, 0.16, 0.42, 0.07, 0.020),
          ) - pads;
        if (ring > 0.35) {
          // Dashed, at roughly two stitches per millimetre of part.
          const dash = Math.sin(u * Math.PI * 2 * 46) * Math.sin(t * Math.PI * 2 * 22);
          z += 0.30 * ring * (dash > 0 ? 1 : -0.7);
        }
      } else if (v >= CUFF_V0) {
        // --- Cuff: elastic ribbing and a hem ------------------------------
        const t = (v - CUFF_V0) / (1 - CUFF_V0);
        // Ribs run AROUND the cuff, so they vary with t and not with u.
        z += Math.sin(t * Math.PI * 2 * 13) * 0.34;
        // Double row of stitches where the cuff is bound to the glove body.
        for (const at of [0.14, 0.22]) {
          const d = Math.abs(t - at);
          if (d < 0.012) z += 0.55 * (Math.sin(u * Math.PI * 2 * 58) > 0 ? 1 : -0.5);
        }
        // The bound edge itself: a raised hem.
        if (t < 0.06) z += 0.6;
      }

      h[y * size + x] = z;
    }
  }
  // Wraps in u — every part is lofted, so u goes once round a section and has
  // to close — but NOT in v, where the three bands meet and wrapping would
  // bleed cuff ribbing into the fingers.
  const rgb = Buffer.alloc(size * size * 3);
  const at = (x, yy) => h[Math.max(0, Math.min(size - 1, yy)) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3.4;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3.4;
      let nx = -dx, ny = dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 3;
      rgb[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const jobs = [
  ['carbon_weave_normal.png', 512, carbonWeave(512)],
  ['tyre_surface_normal.png', 512, tyreSurface(512)],
  ['glove_nomex_normal.png', 256, gloveNomex(256)],
];
for (const [name, size, rgb] of jobs) {
  writePng(join(OUT, name), size, rgb);
  console.log(name, 'written');
}
