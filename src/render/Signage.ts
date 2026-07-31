import * as THREE from 'three';

/**
 * Trackside signage: advertising hoardings, the start/finish gantry, and distance
 * markers.
 *
 * This is the highest-value-per-triangle addition to the whole renderer. A real
 * circuit is lined, continuously, with brightly-coloured boards, and they do two
 * things at once: they tell you instantly that you are looking at a racing
 * circuit rather than a grey road, and they are the strongest speed cue in the
 * scene, because they stream past at a rate the eye can measure. An empty barrier
 * gives the eye nothing to clock progress against.
 *
 * All the artwork is generated into a canvas at runtime. Nothing is downloaded and
 * no third-party marks are used: the board designs are original, in the visual
 * language of racing signage (flat saturated colour fields, heavy condensed type),
 * with invented brand names.
 */

/**
 * Invented sponsor names, styled the way racing signage actually looks.
 *
 * The colours are deliberately a stop or two off full saturation. Trackside
 * boards are printed vinyl seen at a distance under sky light, and pure primary
 * fills — which is what the first version used — clear the bloom threshold on a
 * bright day and turn the whole barrier into a glowing rainbow strip. Muted,
 * they read as printed board, which is what they are.
 */
const BRANDS: { text: string; bg: string; fg: string; accent?: string }[] = [
  { text: 'VELOCITÀ', bg: '#a01527', fg: '#f2ecec' },
  { text: 'AXION FUELS', bg: '#122740', fg: '#d9b44a' },
  { text: 'KRONOS', bg: '#d5d7da', fg: '#141719' },
  { text: 'HYPERDRIVE', bg: '#14757a', fg: '#0a2226' },
  { text: 'NORDVEK', bg: '#20386f', fg: '#e6ecf5' },
  { text: 'TITAN TYRES', bg: '#16181c', fg: '#c9a92c' },
  { text: 'AERONOVA', bg: '#b85416', fg: '#1c1409' },
  { text: 'SPECTRA', bg: '#552b70', fg: '#d3bce0' },
  { text: 'MERIDIAN BANK', bg: '#14522f', fg: '#d3e8dc' },
  { text: 'PULSE ENERGY', bg: '#c9a92c', fg: '#1c1806' },
  { text: 'CARBIDE', bg: '#2b3038', fg: '#8db4d4' },
  { text: 'ORBITAL', bg: '#8f1826', fg: '#e6d2d5' },
];

/**
 * How many boards in a row carry the same brand.
 *
 * Real circuits sell a sponsor a RUN of barrier, not one panel — the reference
 * footage has "RAMINOX RAMINOX RAMINOX" marching past for fifty metres at a
 * time. Cycling a different brand every single board is what made the barrier
 * read as a strip of confetti rather than as advertising, and it also destroys
 * the effect the boards exist for: a repeating unit is a ruler the eye can
 * measure speed against, and a random sequence is not.
 */
const RUN = 2;

/** Boards in one repeat of the strip. */
export const HOARDING_BOARDS = BRANDS.length * RUN;

/**
 * How wide one board is, in metres.
 *
 * This is the number that was actually wrong. The strip's texture repeated
 * every 11 metres and held twelve boards, which made each board 0.92m wide
 * against its 1.05m height — very nearly square. A real trackside hoarding is
 * about three metres by one. Square boards are why the barrier read as a strip
 * of confetti: the eye was seeing thirteen sponsor changes per car length,
 * every name squeezed into a panel narrower than it is tall.
 */
export const BOARD_WIDTH_M = 2.8;

/**
 * Draws the repeating hoarding strip.
 *
 * One wide texture holding every board in sequence, tiled along the barrier. That
 * way the whole circuit's signage is a single draw call and successive boards
 * differ, instead of one board repeating identically.
 */
export function makeHoardingTexture(quality: 'low' | 'high' = 'high'): THREE.Texture {
  // The strip is one texture, so its total width is bounded by what the weakest
  // target can allocate — 4096 is the floor that is safe everywhere. Twenty
  // four boards at 256 comes to 6144, which is fine on desktop and on any
  // recent phone; the low tier halves it.
  const perBoard = quality === 'high' ? 256 : 128;
  const h = quality === 'high' ? 96 : 48;
  const boards = HOARDING_BOARDS;
  const canvas = document.createElement('canvas');
  canvas.width = perBoard * boards;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  for (let i = 0; i < boards; i++) {
    const brand = BRANDS[Math.floor(i / RUN) % BRANDS.length];
    const x = i * perBoard;
    ctx.fillStyle = brand.bg;
    ctx.fillRect(x, 0, perBoard, h);

    // A darker band along the bottom: real boards sit on a plinth, and the band
    // stops the colour field looking like a flat sticker.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x, h - h * 0.16, perBoard, h * 0.16);
    // A shadow gap between adjacent boards, so a run reads as separate panels
    // bolted up rather than as one long painted fence.
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(x, 0, Math.max(1, perBoard * 0.012), h);

    // Diagonal flash, a staple of racing signage.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, perBoard, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(x + perBoard * 0.62, 0);
    ctx.lineTo(x + perBoard * 0.82, 0);
    ctx.lineTo(x + perBoard * 0.62, h);
    ctx.lineTo(x + perBoard * 0.42, h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = brand.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Condense long names so they fit rather than clipping.
    const maxWidth = perBoard * 0.88;
    let size = Math.round(h * 0.44);
    ctx.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
    while (ctx.measureText(brand.text).width > maxWidth && size > h * 0.16) {
      size -= 1;
      ctx.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
    }
    ctx.fillText(brand.text, x + perBoard * 0.5, h * 0.44);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Texture for the start/finish gantry fascia. */
export function makeGantryTexture(circuitName: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#0d1017';
  ctx.fillRect(0, 0, 1024, 128);

  // Chequered bands at each end, as most start gantries carry.
  const sq = 16;
  for (let bx of [0, 1024 - sq * 6]) {
    for (let y = 0; y < 128; y += sq) {
      for (let x = 0; x < sq * 6; x += sq) {
        const on = ((x / sq) + (y / sq)) % 2 === 0;
        ctx.fillStyle = on ? '#f2f2f2' : '#15181e';
        ctx.fillRect(bx + x, y, sq, sq);
      }
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 56px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(circuitName.toUpperCase(), 512, 60);

  ctx.fillStyle = '#35d0e0';
  ctx.fillRect(sq * 6, 118, 1024 - sq * 12, 6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Distance-marker board: the 100/50 boards on the approach to a corner. */
export function makeMarkerTexture(): THREE.Texture {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  // Three boards stacked vertically: 150, 100, 50.
  canvas.width = w;
  canvas.height = h * 3;
  const ctx = canvas.getContext('2d')!;

  const labels = ['150', '100', '50'];
  const colours = ['#1b6ec8', '#e8a01c', '#c8102e'];
  labels.forEach((label, i) => {
    const y = i * h;
    ctx.fillStyle = colours[i];
    ctx.fillRect(0, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 72px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, y + h / 2);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
