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

/** Invented sponsor names, styled the way racing signage actually looks. */
const BRANDS: { text: string; bg: string; fg: string; accent?: string }[] = [
  { text: 'VELOCITÀ', bg: '#c8102e', fg: '#ffffff' },
  { text: 'AXION FUELS', bg: '#0b1f3a', fg: '#f5c542' },
  { text: 'KRONOS', bg: '#f5f5f5', fg: '#111418' },
  { text: 'HYPERDRIVE', bg: '#00a3a3', fg: '#04252b' },
  { text: 'NORDVEK', bg: '#1b3a8f', fg: '#ffffff' },
  { text: 'TITAN TYRES', bg: '#121418', fg: '#ffd21f' },
  { text: 'AERONOVA', bg: '#e8620c', fg: '#1a1005' },
  { text: 'SPECTRA', bg: '#6b2d8f', fg: '#f0d8ff' },
  { text: 'MERIDIAN BANK', bg: '#0f5c34', fg: '#eafff2' },
  { text: 'PULSE ENERGY', bg: '#ffd21f', fg: '#1a1400' },
  { text: 'CARBIDE', bg: '#2b3038', fg: '#9fd4ff' },
  { text: 'ORBITAL', bg: '#b0142c', fg: '#ffe9ec' },
];

/**
 * Draws the repeating hoarding strip.
 *
 * One wide texture holding every board in sequence, tiled along the barrier. That
 * way the whole circuit's signage is a single draw call and successive boards
 * differ, instead of one board repeating identically.
 */
export function makeHoardingTexture(): THREE.Texture {
  const perBoard = 256;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = perBoard * BRANDS.length;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  BRANDS.forEach((brand, i) => {
    const x = i * perBoard;
    ctx.fillStyle = brand.bg;
    ctx.fillRect(x, 0, perBoard, h);

    // A darker band along the bottom: real boards sit on a plinth, and the band
    // stops the colour field looking like a flat sticker.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x, h - 10, perBoard, 10);

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
    ctx.font = '700 30px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Condense long names so they fit rather than clipping.
    const maxWidth = perBoard * 0.86;
    let size = 30;
    while (ctx.measureText(brand.text).width > maxWidth && size > 12) {
      size -= 1;
      ctx.font = '700 ' + size + 'px Helvetica, Arial, sans-serif';
    }
    ctx.fillText(brand.text, x + perBoard * 0.5, h * 0.46);
  });

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
