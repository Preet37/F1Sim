/**
 * Allocation-free math helpers.
 *
 * Rule for this file: nothing here may allocate on a hot path. Functions that
 * need to return a vector take an `out` parameter and return it, so callers can
 * hoist the target once and reuse it every tick. The physics step runs 120x per
 * second across 20 cars; a single `new Vec2()` in the wrong place is 2400
 * garbage objects per second on a phone.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

/** Metres per second -> kilometres per hour. */
export const MS_TO_KPH = 3.6;
export const KPH_TO_MS = 1 / 3.6;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. `rate` is per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Maps v from [inMin,inMax] to [outMin,outMax], clamped. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const t = clamp01((v - inMin) / (inMax - inMin));
  return outMin + (outMax - outMin) * t;
}

/** Smooth 0..1 ramp with zero derivative at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed value moved toward zero by `amount`. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= TWO_PI;
  while (x <= -Math.PI) x += TWO_PI;
  return x;
}

/** Wraps a distance-along-track value into [0, length). */
export function wrapDistance(s: number, length: number): number {
  let x = s % length;
  if (x < 0) x += length;
  return x;
}

/**
 * Shortest signed delta from `from` to `to` on a closed loop of `length`.
 * Positive means `to` is ahead. Used constantly for gap calculations.
 */
export function loopDelta(from: number, to: number, length: number): number {
  let d = to - from;
  const half = length * 0.5;
  while (d > half) d -= length;
  while (d < -half) d += length;
  return d;
}

/** Deterministic, seedable PRNG (mulberry32). Race results must be replayable. */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(loInclusive: number, hiExclusive: number): number {
    return loInclusive + Math.floor(this.next() * (hiExclusive - loInclusive));
  }

  /** Approximately normal via sum of uniforms; cheap and good enough for jitter. */
  gaussian(mean = 0, stdDev = 1): number {
    const u = this.next() + this.next() + this.next() + this.next() - 2;
    return mean + u * 0.8660254 * stdDev;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)];
  }

  reseed(seed: number): void {
    this.state = seed >>> 0;
  }
}

/** Mutable 2D vector. The sim is solved on the ground plane; height is cosmetic. */
export class Vec2 {
  constructor(public x = 0, public y = 0) {}

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  copy(v: Vec2): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  add(v: Vec2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  addScaled(v: Vec2, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  sub(v: Vec2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  get length(): number {
    return Math.hypot(this.x, this.y);
  }

  get lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): this {
    const l = Math.hypot(this.x, this.y);
    if (l > 1e-9) {
      this.x /= l;
      this.y /= l;
    }
    return this;
  }

  dot(v: Vec2): number {
    return this.x * v.x + this.y * v.y;
  }

  /** 2D cross product (z of the 3D cross). Sign tells you which side. */
  cross(v: Vec2): number {
    return this.x * v.y - this.y * v.x;
  }

  /** Rotates in place by `a` radians. */
  rotate(a: number): this {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = this.x * c - this.y * s;
    this.y = this.x * s + this.y * c;
    this.x = x;
    return this;
  }

  distanceTo(v: Vec2): number {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  distanceSqTo(v: Vec2): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }
}

/** Formats seconds as M:SS.mmm — lap times. Avoids template strings in loops. */
export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const sStr = s < 10 ? '0' + s.toFixed(3) : s.toFixed(3);
  return m + ':' + sStr;
}

/** Formats a gap as +S.mmm / -S.mmm. */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--.---';
  const sign = seconds >= 0 ? '+' : '-';
  return sign + Math.abs(seconds).toFixed(3);
}

/** Formats a delta to a reference lap, coloured by the caller. */
export function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--.--';
  const sign = seconds >= 0 ? '+' : '-';
  return sign + Math.abs(seconds).toFixed(2);
}
