import * as THREE from 'three';
import { TIRE_COMPOUNDS, type CompoundId } from '../data/tires';

/**
 * Tyres.
 *
 * An open-wheel car shows more tyre than bodywork from most angles. Four black
 * cylinders is therefore not a small omission — it is the single largest flat
 * area in almost every frame, and until it has structure in it nothing else on
 * the car matters much.
 *
 * A real Formula 1 tyre, in the order the eye picks the features out:
 *
 *  1. THE COMPOUND STRIPE. A coloured band around the outer sidewall — red for
 *     the soft, yellow medium, white hard, green intermediate, blue wet. It is
 *     the most saturated thing on an otherwise black object and it is what
 *     makes a wheel read as a racing tyre rather than as a wheel.
 *  2. SIDEWALL LETTERING, repeating four or five times around. Raised, so it
 *     catches light differently from the wall it sits on.
 *  3. THE SHOULDER. The tread does not meet the sidewall at a corner; it turns
 *     over a radius, and that turn is where the surface goes from the scuffed
 *     matte of the contact patch to the smoother, glossier moulded sidewall.
 *     Getting the roughness split right across that turn is most of what makes
 *     the tyre look like rubber.
 *  4. TREAD SURFACE. A slick is not smooth: it is faintly striated around its
 *     circumference from the moulding and from being dragged across asphalt,
 *     and it picks up a broad graining across the middle where it works.
 *
 * All four are graphics, so they are painted into a canvas, and the tyre's
 * surface of revolution is given a real parameterisation to carry them: u runs
 * once around the circumference, v runs across the profile from the inboard
 * bead to the outboard one.
 *
 * ONE TEXTURE PER COMPOUND, SHARED BY THE WHOLE FIELD. There are five
 * compounds, so five textures serve twenty cars — and because the wheels were
 * already separate meshes from the shell, moving them onto their own material
 * costs exactly zero additional draw calls.
 *
 * The atlas also carries the wheel's hard parts — rim face, spokes, brake disc,
 * caliper — as flat swatches, so a whole wheel stays a single draw call.
 */

/** Where the tyre profile lives in the atlas. v0 at the bottom, v1 at the top. */
export const TYRE_BAND = { v0: 0.46, v1: 1.0 };

export type WheelSwatch =
  | 'rimFace' | 'rimSpoke' | 'rimLip' | 'hub'
  | 'disc' | 'discFace' | 'caliper' | 'inner';

const SWATCHES: WheelSwatch[] = [
  'rimFace', 'rimSpoke', 'rimLip', 'hub',
  'disc', 'discFace', 'caliper', 'inner',
];

/** Base colour and [roughness, metalness] for each hard part. */
const SWATCH_LOOK: Record<WheelSwatch, { colour: string; rough: number; metal: number }> = {
  // The wheel face on a current car is a dark anodised cover, not chrome.
  rimFace: { colour: '#2a2d34', rough: 0.42, metal: 0.55 },
  rimSpoke: { colour: '#454b55', rough: 0.30, metal: 0.85 },
  rimLip: { colour: '#8d949e', rough: 0.22, metal: 0.95 },
  hub: { colour: '#3b3f47', rough: 0.35, metal: 0.80 },
  // Carbon-carbon brake discs are matte grey-black and not remotely metallic.
  disc: { colour: '#2e2b28', rough: 0.72, metal: 0.05 },
  discFace: { colour: '#3a3632', rough: 0.66, metal: 0.05 },
  caliper: { colour: '#57402c', rough: 0.45, metal: 0.55 },
  inner: { colour: '#101216', rough: 0.80, metal: 0.10 },
};

/** UV of the centre of a swatch cell, for `setFlatUV`. */
export function wheelSwatchUV(name: WheelSwatch): [number, number] {
  const i = SWATCHES.indexOf(name);
  const cols = 4;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const w = 1 / cols;
  const h = TYRE_BAND.v0 / 2;
  return [(col + 0.5) * w, (row + 0.5) * h];
}

function swatchRectPx(name: WheelSwatch, size: number): [number, number, number, number] {
  const i = SWATCHES.indexOf(name);
  const cols = 4;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const w = size / cols;
  const h = (TYRE_BAND.v0 / 2) * size;
  // Canvas y is measured from the top; atlas v from the bottom.
  return [col * w, size - (row + 1) * h, w, h];
}

/**
 * The tyre's cross-section, as v coordinates in the band.
 *
 * These are the stations the wheel geometry maps its profile rings onto, and
 * they have to match: `buildWheel` walks the same list. Kept here so the paint
 * and the geometry cannot drift apart.
 *
 * 0 is the inboard bead, 1 the outboard bead.
 */
export const PROFILE_V = [0.0, 0.10, 0.26, 0.5, 0.74, 0.90, 1.0];

/** Canvas y for a profile station, within the tyre band. */
function bandY(t: number, size: number): number {
  const y0 = size * (1 - TYRE_BAND.v1);
  const y1 = size * (1 - TYRE_BAND.v0);
  return y0 + t * (y1 - y0);
}

interface TyreLook {
  /** Base colour map. */
  map: THREE.CanvasTexture;
  /** Green = roughness, blue = metalness. */
  surface: THREE.CanvasTexture;
}

const cache = new Map<string, TyreLook>();

/**
 * Paints one compound's tyre and the shared wheel hardware.
 *
 * @param size texture edge in pixels
 */
function paint(compound: CompoundId, size: number): TyreLook {
  const colourCanvas = document.createElement('canvas');
  colourCanvas.width = colourCanvas.height = size;
  const c = colourCanvas.getContext('2d')!;

  const surfCanvas = document.createElement('canvas');
  surfCanvas.width = surfCanvas.height = size;
  const s = surfCanvas.getContext('2d')!;

  const set = (rough: number, metal: number) =>
    `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  // --- Backgrounds ---------------------------------------------------------
  c.fillStyle = '#0d0e10';
  c.fillRect(0, 0, size, size);
  s.fillStyle = set(0.9, 0.02);
  s.fillRect(0, 0, size, size);

  // --- Hard parts ----------------------------------------------------------
  for (const name of SWATCHES) {
    const look = SWATCH_LOOK[name];
    const [x, y, w, h] = swatchRectPx(name, size);
    c.fillStyle = look.colour;
    c.fillRect(x, y, w, h);
    s.fillStyle = set(look.rough, look.metal);
    s.fillRect(x, y, w, h);

    // The brake disc gets its drilled face drawn in rather than left flat: it
    // is the one hard part with a pattern the camera ever gets close enough to
    // resolve, and a plain grey circle behind a spoked wheel is conspicuous.
    if (name === 'discFace') {
      c.fillStyle = 'rgba(0,0,0,0.55)';
      for (let i = 0; i < 90; i++) {
        const px = x + ((i * 37) % 100) / 100 * w;
        const py = y + ((i * 61) % 100) / 100 * h;
        c.beginPath();
        c.arc(px, py, Math.max(1, size * 0.004), 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  // --- Tyre ---------------------------------------------------------------
  const yTop = bandY(0, size);
  const yBot = bandY(1, size);
  const bandH = yBot - yTop;

  /** Fills between two profile stations across the full circumference. */
  const across = (t0: number, t1: number, fill: string, ctx: CanvasRenderingContext2D) => {
    const a = bandY(t0, size);
    ctx.fillStyle = fill;
    ctx.fillRect(0, a, size, bandY(t1, size) - a);
  };

  // Sidewalls are a touch lighter and considerably glossier than the tread.
  // Moulded rubber has a sheen; a scrubbed contact patch does not. That
  // difference across the shoulder is the main thing that reads as "rubber".
  // Rubber is not black. Photographed under any real light a tyre sits around
  // an eight to ten per cent reflectance — sRGB 0x28 or so — and painting it at
  // 0x0d turns every wheel into a hole punched in the image with a coloured
  // ring round it. It only LOOKS black next to white bodywork.
  across(0.0, 1.0, '#232529', c);
  across(0.0, 1.0, set(0.52, 0.02), s);

  // Tread: darker, matte, and slightly warmer from laid-down rubber.
  const treadA = 0.30, treadB = 0.70;
  across(treadA, treadB, '#191a1d', c);
  across(treadA, treadB, set(0.88, 0.02), s);

  // Shoulders: the turn from tread to sidewall. Glossier than the tread
  // because it only touches the road under load.
  across(0.24, treadA, '#1e2023', c);
  across(0.24, treadA, set(0.70, 0.02), s);
  across(treadB, 0.76, '#1e2023', c);
  across(treadB, 0.76, set(0.70, 0.02), s);

  // Circumferential striation across the tread. Fine, low contrast, and the
  // reason a slick catches a moving highlight instead of sitting dead black.
  for (let i = 0; i < 70; i++) {
    const t = treadA + (i / 70) * (treadB - treadA);
    const y = bandY(t, size);
    const a = 0.035 + 0.03 * Math.sin(i * 2.3);
    c.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    c.fillRect(0, y, size, Math.max(1, bandH * 0.004));
  }

  // Graining: a broad, irregular mottling across the working part of the
  // tread. Real tyres are never uniform across the contact patch.
  for (let i = 0; i < 220; i++) {
    const t = treadA + (((i * 89) % 97) / 97) * (treadB - treadA);
    const x = (((i * 53) % 101) / 101) * size;
    const r = size * (0.006 + ((i * 29) % 17) / 17 * 0.02);
    c.fillStyle = `rgba(${i % 3 ? 200 : 40},${i % 3 ? 195 : 40},${i % 3 ? 190 : 40},0.045)`;
    c.beginPath();
    c.ellipse(x, bandY(t, size), r * 2.2, r * 0.5, 0, 0, Math.PI * 2);
    c.fill();
  }

  // --- Compound stripe -----------------------------------------------------
  // On the outer sidewall, just inboard of the shoulder, where it is visible
  // from the side and from three-quarters but not from directly above.
  //
  // The width is measured in PROFILE space, not in pixels, and it is narrow on
  // purpose. The band sits at the largest radius on the tyre, so a stripe that
  // looks reasonable in the texture wraps a very long way around the wheel and
  // turns into a solid coloured ring — which is what the first version did, and
  // it made every car look like it was running on toy wheels.
  const stripe = '#' + TIRE_COMPOUNDS[compound].colour.toString(16).padStart(6, '0');
  for (const [a, b] of [[0.150, 0.196], [0.804, 0.850]] as const) {
    const y = bandY(a, size);
    const h = bandY(b, size) - y;
    c.fillStyle = stripe;
    c.fillRect(0, y, size, h);
    // Knocked back toward the rubber under it. The compound colours are chosen
    // to be legible as HUD swatches, and used at full strength on a sidewall
    // they are brighter than any paint on the car — the band stops reading as
    // a marking on a tyre and starts reading as a glowing hoop.
    c.fillStyle = 'rgba(24,26,30,0.30)';
    c.fillRect(0, y, size, h);
    // Painted-on rubber: brighter than the wall, and glossier.
    s.fillStyle = set(0.38, 0.02);
    s.fillRect(0, y, size, h);
    // A dark edge on each side stops the band looking like a decal floating
    // above the tyre.
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, y, size, Math.max(1, h * 0.14));
    c.fillRect(0, y + h - Math.max(1, h * 0.14), size, Math.max(1, h * 0.14));
  }

  // --- Sidewall lettering --------------------------------------------------
  // Repeated five times round, which is roughly what a real tyre carries, and
  // enough that at least one instance is in view from any angle.
  //
  // SIZE. The cap height is a fraction of the whole cross-section band, and the
  // sidewall is only about a tenth of that band, so anything above five percent
  // is taller than the wall it is written on. The first version used thirteen
  // percent in near-white and produced a bright ring that read as a whitewall
  // tyre off a nineteen-fifties saloon. Real sidewall lettering is small, and
  // it is grey — moulded rubber that is slightly glossier than its
  // surroundings, not paint.
  const REPEATS = 5;
  const drawText = (
    t: number, str: string, heightFrac: number, colour: string, weight: number,
  ) => {
    const y = bandY(t, size);
    const fontPx = Math.max(5, bandH * heightFrac);
    c.save();
    c.font = `${weight} ${fontPx}px Helvetica, Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = colour;
    for (let i = 0; i < REPEATS; i++) {
      c.fillText(str, ((i + 0.5) / REPEATS) * size, y);
    }
    c.restore();
  };

  const name = TIRE_COMPOUNDS[compound].name.toUpperCase();
  // Outer sidewall: maker's name, with the compound in smaller type outboard
  // of it. Both in a mid grey that sits a couple of stops above the wall.
  drawText(0.945, 'PROTOTIPO', 0.042, '#8b9098', 700);
  drawText(0.045, 'PROTOTIPO', 0.042, '#8b9098', 700);
  drawText(0.895, name, 0.026, 'rgba(132,138,146,0.85)', 600);
  drawText(0.098, name, 0.026, 'rgba(132,138,146,0.85)', 600);

  // Raised lettering catches light: give the text rows a glossier surface so
  // the letters flare as the wheel turns past a floodlight.
  for (const t of [0.945, 0.045] as const) {
    const y = bandY(t, size) - bandH * 0.026;
    s.fillStyle = set(0.34, 0.02);
    s.fillRect(0, y, size, bandH * 0.052);
  }

  // --- Bead ---------------------------------------------------------------
  // The dark, hard rim where the tyre grips the wheel. Without it the tyre and
  // the rim merge into one object.
  across(0.0, 0.035, '#0c0d0f', c);
  across(0.965, 1.0, '#0c0d0f', c);

  const map = new THREE.CanvasTexture(colourCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  map.needsUpdate = true;

  const surface = new THREE.CanvasTexture(surfCanvas);
  surface.colorSpace = THREE.NoColorSpace;
  surface.wrapS = THREE.RepeatWrapping;
  surface.anisotropy = 4;
  surface.needsUpdate = true;

  return { map, surface };
}

/** Builds (or returns a cached) tyre look for one compound. */
export function buildTyreTexture(compound: CompoundId, size = 512): TyreLook {
  const key = `${compound}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = paint(compound, size);
  cache.set(key, built);
  return built;
}

const materials = new Map<string, THREE.MeshStandardMaterial>();

/**
 * The material for a whole wheel — tyre, rim and disc.
 *
 * Shared across every car running that compound, so twenty cars on two
 * compounds cost two materials.
 */
export function wheelMaterial(compound: CompoundId, size = 512): THREE.MeshStandardMaterial {
  const key = `${compound}:${size}`;
  const hit = materials.get(key);
  if (hit) return hit;
  const tex = buildTyreTexture(compound, size);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    roughnessMap: tex.surface,
    metalnessMap: tex.surface,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1.0,
  });
  materials.set(key, mat);
  return mat;
}

export function disposeTyreCache(): void {
  for (const t of cache.values()) {
    t.map.dispose();
    t.surface.dispose();
  }
  cache.clear();
  for (const m of materials.values()) m.dispose();
  materials.clear();
}
