/**
 * Reading a drawn figure back out of its own markup.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROBE MEASURES THE DRAWING AND NOT THE RIG
 * ---------------------------------------------------------------------------
 *
 * `src/ui/people/Body.ts` publishes a skeleton — joints, bones, grips. A probe
 * that asserted on THAT would be asserting that the rig agrees with itself,
 * and would pass happily on a build where `Figure.ts` drew something else
 * entirely. That is PROJECT.md §3.2 in its purest form: a probe a broken
 * feature passes.
 *
 * So this reads the SVG string the browser is actually given, pulls out every
 * element carrying a `data-part`, converts it to a polygon, and hands back
 * geometry. Every shape below the neck is emitted as `M x y L x y ... Z` with
 * no curves in it precisely so that this conversion is EXACT rather than a
 * flattening approximation — what is measured here is what is filled.
 *
 * The one primitive everything else is built on is polygon overlap, because
 * "the hand is attached to the forearm" is not a distance between two declared
 * points. It is two drawn shapes sharing area, and two shapes either share
 * area or they do not.
 */

export interface Pt { x: number; y: number }

export interface Shape {
  part: string;
  /** 'path' | 'g' — a group is a held object, drawn about its own origin. */
  tag: string;
  attrs: Record<string, string>;
  /** Present for a path with a polygon `d`. */
  poly?: Pt[];
  /** For a group: every coordinate its contents reach, in its own frame. */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  /** The raw element text, for checks about how it is painted. */
  raw: string;
  /**
   * Where it sits in the markup — which is PAINT ORDER, and paint order is
   * half of whether a limb can be seen at all. An arm drawn before the torso,
   * in the torso's own colour, is invisible however well attached it is; that
   * is the entire mechanism behind "the garage crew are armless torsos".
   */
  at: number;
}

// ===========================================================================
// Parsing
// ===========================================================================

function readAttrs(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * A path's outline, as points.
 *
 * Absolute `M`, `L`, `C` and `Z`. Everything `Body.ts` emits below the neck is
 * M/L/Z and needs no flattening at all — the polygon IS the fill. `C` is
 * supported for one reason: the body that shipped before #22 drew its torso and
 * its arms as cubics, and the same instrument has to be able to measure the
 * old drawing or the "prove it goes red" step would be comparing two different
 * measurements. Sixteen samples a segment is well inside every bar below.
 */
export function parsePolygon(d: string): Pt[] | undefined {
  const pts: Pt[] = [];
  const tokens = d.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  const N = (k: number): number => Number(tokens[k]);
  let i = 0;
  let cur: Pt | undefined;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'M' || t === 'L') {
      const p = { x: N(i + 1), y: N(i + 2) };
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
      pts.push(p);
      cur = p;
      i += 3;
    } else if (t === 'C') {
      if (!cur) return undefined;
      const c1 = { x: N(i + 1), y: N(i + 2) };
      const c2 = { x: N(i + 3), y: N(i + 4) };
      const p = { x: N(i + 5), y: N(i + 6) };
      for (const q of [c1, c2, p]) if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return undefined;
      const SEG = 16;
      for (let k = 1; k <= SEG; k++) {
        const u = k / SEG;
        const v = 1 - u;
        pts.push({
          x: v * v * v * cur.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * p.x,
          y: v * v * v * cur.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * p.y,
        });
      }
      cur = p;
      i += 7;
    } else if (t === 'Z' || t === 'z') {
      i += 1;
    } else {
      // An arc, or a relative command. Nothing in this module emits either.
      return undefined;
    }
  }
  return pts.length >= 3 ? pts : undefined;
}

/** An ellipse, as the polygon it fills. */
export function ellipsePolygon(a: Record<string, string>): Pt[] | undefined {
  const cx = Number(a.cx);
  const cy = Number(a.cy);
  const rx = Number(a.rx);
  const ry = Number(a.ry);
  if (![cx, cy, rx, ry].every(Number.isFinite) || rx <= 0 || ry <= 0) return undefined;
  const out: Pt[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return out;
}

/** Every coordinate a fragment of markup mentions, as a bounding box. */
function contentBox(markup: string): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const eat = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  };
  for (const m of markup.matchAll(/\sd="([^"]*)"/g)) {
    const nums = m[1].match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) eat(Number(nums[i]), Number(nums[i + 1]));
  }
  for (const m of markup.matchAll(/<rect\b([^>]*)>/g)) {
    const a = readAttrs(m[1]);
    const x = Number(a.x);
    const y = Number(a.y);
    eat(x, y);
    eat(x + Number(a.width), y + Number(a.height));
  }
  for (const m of markup.matchAll(/<ellipse\b([^>]*)>/g)) {
    const a = readAttrs(m[1]);
    eat(Number(a.cx) - Number(a.rx), Number(a.cy) - Number(a.ry));
    eat(Number(a.cx) + Number(a.rx), Number(a.cy) + Number(a.ry));
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/**
 * Every `data-part` in a fragment of figure markup.
 *
 * Groups are scanned with a balanced counter rather than a regex, because a
 * held object is a `<g data-part>` with its own `<g>` inside it and the lazy
 * match would stop at the inner close tag.
 */
export function parts(markup: string): Map<string, Shape> {
  const out = new Map<string, Shape>();
  const re = /<(path|g|ellipse|rect)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    const [, tag, head, selfClose] = m;
    const attrs = readAttrs(head);
    const part = attrs['data-part'];
    if (!part) continue;

    let raw = m[0];
    if (tag === 'g' && selfClose !== '/') {
      // Walk forward, counting <g ...> and </g>.
      let depth = 1;
      let i = re.lastIndex;
      const inner = /<g\b|<\/g>/g;
      inner.lastIndex = i;
      let k: RegExpExecArray | null;
      while (depth > 0 && (k = inner.exec(markup)) !== null) {
        depth += k[0] === '</g>' ? -1 : 1;
        i = inner.lastIndex;
      }
      raw = markup.slice(m.index, i);
      re.lastIndex = i;
    }

    const shape: Shape = { part, tag, attrs, raw, at: m.index };
    if (tag === 'path' && attrs.d) shape.poly = parsePolygon(attrs.d);
    if (tag === 'ellipse') shape.poly = ellipsePolygon(attrs);
    if (tag === 'rect') {
      const x = Number(attrs.x);
      const y = Number(attrs.y);
      const w = Number(attrs.width);
      const h = Number(attrs.height);
      if ([x, y, w, h].every(Number.isFinite)) {
        shape.poly = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      }
    }
    if (tag === 'g') shape.bbox = contentBox(raw);
    out.set(part, shape);
  }
  return out;
}

/** `"12.4,88.1"` → a point. */
export function pt(v: string | undefined): Pt | undefined {
  if (!v) return undefined;
  const [a, b] = v.split(',').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? { x: a, y: b } : undefined;
}

// ===========================================================================
// Geometry
// ===========================================================================

export function area(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function bounds(poly: readonly Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * How much area two drawn polygons share.
 *
 * Rasterised over the intersection of their bounding boxes at a pitch chosen
 * to give a few thousand samples, which is two orders of magnitude more
 * precision than any bar below asks for and needs no clipping library. Returns
 * absolute area in figure units.
 */
export function overlap(a: readonly Pt[], b: readonly Pt[]): number {
  const ba = bounds(a);
  const bb = bounds(b);
  const x0 = Math.max(ba.x0, bb.x0);
  const y0 = Math.max(ba.y0, bb.y0);
  const x1 = Math.min(ba.x1, bb.x1);
  const y1 = Math.min(ba.y1, bb.y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  const n = 90;
  const dx = (x1 - x0) / n;
  const dy = (y1 - y0) / n;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = { x: x0 + (i + 0.5) * dx, y: y0 + (j + 0.5) * dy };
      if (inside(p, a) && inside(p, b)) hits += 1;
    }
  }
  return hits * dx * dy;
}

/**
 * The drawn width of a limb across its own axis, at `t` along it.
 *
 * This is the measurement that tells a limb from a stick. A stroked path has
 * one width for its whole length by definition; a drawn arm narrows from
 * shoulder to elbow. Casting a perpendicular through the polygon and taking
 * the spread of the crossings measures the SHAPE, not the declaration.
 */
export function widthAcross(poly: readonly Pt[], a: Pt, b: Pt, t: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const px = a.x + dx * t;
  const py = a.y + dy * t;
  // Perpendicular direction.
  const nx = -uy;
  const ny = ux;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    // Signed distance of each end from the cutting line (along u).
    const dp = (p.x - px) * ux + (p.y - py) * uy;
    const dq = (q.x - px) * ux + (q.y - py) * uy;
    if ((dp > 0) === (dq > 0) && dp !== 0 && dq !== 0) continue;
    const k = dp / (dp - dq);
    const ix = p.x + (q.x - p.x) * k;
    const iy = p.y + (q.y - p.y) * k;
    const s = (ix - px) * nx + (iy - py) * ny;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0;
}
