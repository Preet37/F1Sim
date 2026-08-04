import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/**
 * A minimal PNG decoder, because this project has no image dependency and the
 * reference frames — and every shot the audit harnesses take — are PNGs on disk.
 *
 * Scope, stated honestly: 8-bit, non-interlaced, colour types 0 (grey), 2 (RGB),
 * 4 (grey+alpha) and 6 (RGBA). That covers every PNG this repository produces
 * (`page.screenshot`, `canvas.toDataURL`) and every frame in `reference/target/`.
 * Anything else throws by name rather than decoding to garbage — a decoder that
 * silently mis-read a 16-bit or palettised file would hand every measurement
 * built on it a plausible wrong number, which is exactly the failure mode
 * PROJECT.md §3.1 exists to prevent.
 */
export interface Raster {
  width: number;
  height: number;
  /** RGB triples, row-major, 8 bits per channel. Alpha is dropped. */
  rgb: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(path: string): Raster {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`${path}: bit depth ${bitDepth} unsupported (need 8)`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNG unsupported`);
  const channels =
    colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 4 ? 2 : colourType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`${path}: colour type ${colourType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: v = rawByte + paeth(a, b, c); break;
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
    p += stride;

    const rowOut = y * width * 3;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = rowOut + x * 3;
      if (channels >= 3) {
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
      }
    }

    const swap = prev;
    prev = cur;
    cur = swap;
  }

  return { width, height, rgb: out };
}

/** A PNG encoder, so a probe can write the side-by-side it is claiming. */
export function encodePng(r: Raster): Buffer {
  const { width, height, rgb } = r;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** Nearest-neighbour-free box resample. Used to put two frames at one scale. */
export function resize(src: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 3);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * src.width + xx) * 3;
          r += src.rgb[s]; g += src.rgb[s + 1]; b += src.rgb[s + 2];
          n++;
        }
      }
      const d = (y * width + x) * 3;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return { width, height, rgb: out };
}

/** Crop, in pixels. Clamped to the source. */
export function crop(src: Raster, x: number, y: number, w: number, h: number): Raster {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.round(y)));
  const w1 = Math.max(1, Math.min(src.width - x0, Math.round(w)));
  const h1 = Math.max(1, Math.min(src.height - y0, Math.round(h)));
  const out = new Uint8Array(w1 * h1 * 3);
  for (let yy = 0; yy < h1; yy++) {
    const s = ((y0 + yy) * src.width + x0) * 3;
    out.set(src.rgb.subarray(s, s + w1 * 3), yy * w1 * 3);
  }
  return { width: w1, height: h1, rgb: out };
}
