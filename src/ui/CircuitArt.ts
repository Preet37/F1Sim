import { REAL_GEOMETRY } from '../data/tracks/realGeometry';
import type { TrackDefinition } from '../data/tracks/TrackDefinition';

/**
 * Circuit outlines for the menus, drawn from the same surveyed centrelines the
 * simulation drives on.
 *
 * A circuit card that says "Suzuka · Japan · 5.807 km" is a row in a database.
 * A circuit card that shows the figure-of-eight is a circuit. The geometry is
 * already in the build — `realGeometry.ts` holds every track's real centreline,
 * resampled to uniform arclength — so the map costs nothing but the arithmetic
 * to fit it into a viewBox.
 *
 * Everything here returns an SVG *string*. These are built once when a screen is
 * constructed and never touched again, so string assembly is both the cheapest
 * and the clearest way to do it.
 *
 * The three sector ticks are the reason to prefer this over a plain silhouette:
 * they are the same sector boundaries the timing panel colours during a
 * session, so a player learns the shape of sector two here and recognises it on
 * the pit wall later.
 */

const NS = 'http://www.w3.org/2000/svg';

export interface CircuitArtOptions {
  /** Draw the three sector-boundary ticks. Off on the smallest sizes. */
  sectors?: boolean;
  /** Draw the start/finish bar. */
  startLine?: boolean;
  /** Extra classes on the root <svg>. */
  className?: string;
  /** Stroke weight of the racing ribbon, in viewBox units. */
  weight?: number;
}

interface Fitted {
  /** Points already mapped into the 0..100 viewBox. */
  xs: number[];
  ys: number[];
}

/** Maps a circuit's surveyed centreline into a square 0..100 viewBox. */
function fit(points: readonly number[]): Fitted {
  const n = points.length >> 1;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const z = points[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // 88 rather than 100 so the stroke, the start bar and the sector ticks all
  // have room to sit outside the centreline without being clipped.
  const span = Math.max(maxX - minX, maxZ - minZ) / 88 || 1;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push((points[i * 2] - cx) / span + 50);
    ys.push((points[i * 2 + 1] - cz) / span + 50);
  }
  return { xs, ys };
}

/** A closed path through every fitted point. */
function pathData(f: Fitted): string {
  let d = '';
  for (let i = 0; i < f.xs.length; i++) {
    d += (i === 0 ? 'M' : 'L') + f.xs[i].toFixed(1) + ',' + f.ys[i].toFixed(1);
  }
  return d + 'Z';
}

/**
 * A bar drawn across the track at one point, used for the start/finish line and
 * the sector boundaries.
 *
 * The direction comes from the neighbouring points, so the bar is genuinely
 * perpendicular to the racing direction rather than merely vertical.
 */
function crossBar(f: Fitted, index: number, half: number): string {
  const n = f.xs.length;
  const a = (index - 1 + n) % n;
  const b = (index + 1) % n;
  let dx = f.xs[b] - f.xs[a];
  let dy = f.ys[b] - f.ys[a];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  // Perpendicular.
  const px = -dy * half;
  const py = dx * half;
  const x = f.xs[index];
  const y = f.ys[index];
  return `${(x - px).toFixed(1)},${(y - py).toFixed(1)} ${(x + px).toFixed(1)},${(y + py).toFixed(1)}`;
}

/**
 * The circuit outline as a standalone SVG string.
 *
 * Three strokes over the same path: a dark casing, the ribbon, and a hairline
 * centre. That is what makes it read as a road seen from above rather than as a
 * wire diagram — the same trick the in-race track map uses.
 */
export function circuitSvg(def: TrackDefinition, opts: CircuitArtOptions = {}): string {
  const geo = REAL_GEOMETRY[def.id];
  const points = geo ? geo.points : def.controlPoints;
  const f = fit(points);
  const d = pathData(f);
  const n = f.xs.length;
  const weight = opts.weight ?? 5.2;

  let extra = '';

  if (opts.sectors !== false) {
    // The sector splits are stored as distances along the lap; the geometry is
    // uniform in arclength, so a fraction of the lap is a fraction of the array.
    for (const s of [def.sector1EndS, def.sector2EndS]) {
      const i = Math.max(1, Math.min(n - 2, Math.round((s / def.lengthM) * n) % n));
      extra += `<polyline class="ca-sector" points="${crossBar(f, i, weight * 0.95)}"/>`;
    }
  }

  if (opts.startLine !== false) {
    extra += `<polyline class="ca-start" points="${crossBar(f, 0, weight * 1.15)}"/>`;
  }

  return `<svg viewBox="0 0 100 100" class="circuit-art ${opts.className ?? ''}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
  <path class="ca-casing" d="${d}" style="stroke-width:${(weight + 2.6).toFixed(1)}"/>
  <path class="ca-road" d="${d}" style="stroke-width:${weight.toFixed(1)}"/>
  <path class="ca-trace" d="${d}"/>
  ${extra}
</svg>`;
}

/**
 * The same outline as a live SVG element, for the loading screen, where the
 * trace animates from nothing to a complete lap while the circuit is built.
 *
 * Returned as an element rather than a string because the caller needs to set
 * the dash length from the measured path, which only exists once it is in the
 * document.
 */
export function circuitLoadingArt(def: TrackDefinition): SVGSVGElement {
  const wrap = document.createElementNS(NS, 'svg');
  wrap.setAttribute('viewBox', '0 0 100 100');
  wrap.setAttribute('class', 'circuit-art loading-art');
  wrap.setAttribute('aria-hidden', 'true');

  const geo = REAL_GEOMETRY[def.id];
  const f = fit(geo ? geo.points : def.controlPoints);
  const d = pathData(f);

  const casing = document.createElementNS(NS, 'path');
  casing.setAttribute('class', 'ca-casing');
  casing.setAttribute('d', d);
  wrap.appendChild(casing);

  const trace = document.createElementNS(NS, 'path');
  trace.setAttribute('class', 'ca-draw');
  trace.setAttribute('d', d);
  wrap.appendChild(trace);

  const start = document.createElementNS(NS, 'polyline');
  start.setAttribute('class', 'ca-start');
  start.setAttribute('points', crossBar(f, 0, 6.5));
  wrap.appendChild(start);

  return wrap;
}
