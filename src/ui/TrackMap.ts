import type { CarEntry } from '../race/CarEntry';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Broadcast-style circuit map.
 *
 * The outline is drawn ONCE, as an SVG path built from the spline's own sampled
 * points, and thereafter only the `cx`/`cy` of one circle per car is written.
 * That distinction is the whole design: redrawing a 250-point path sixty times a
 * second to move twenty dots would cost more than the rest of the HUD put
 * together, and the circuit does not move.
 *
 * World coordinates are normalised into a fixed 0..100 viewBox so the SVG scales
 * to whatever box the layout gives it, and so stroke widths and dot radii can be
 * chosen once instead of per circuit — a 5.8km Monza and a 3.3km Monaco end up
 * the same size on screen, which is what a real trackside graphic does.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Every Nth spline node is enough for an outline at this size. */
const NODE_STRIDE = 3;

export class TrackMap {
  readonly root: SVGSVGElement;
  /** The spline this map was built for, so the HUD knows when to rebuild. */
  readonly track: TrackSpline;

  private readonly dots: SVGCircleElement[] = [];
  private readonly lastX: number[] = [];
  private readonly lastY: number[] = [];
  private readonly lastHidden: boolean[] = [];

  /** Cars in the order their dots were appended. */
  private readonly order: readonly CarEntry[];

  private readonly cx: number;
  private readonly cz: number;
  private readonly span: number;

  constructor(track: TrackSpline, cars: readonly CarEntry[]) {
    this.track = track;

    const b = track.bounds();
    this.cx = (b.minX + b.maxX) * 0.5;
    this.cz = (b.minZ + b.maxZ) * 0.5;
    // A little headroom so the outline's stroke and the dots never clip.
    this.span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.1;

    this.root = document.createElementNS(NS, 'svg');
    this.root.setAttribute('viewBox', '0 0 100 100');
    this.root.setAttribute('class', 'map-svg');

    // --- Outline ----------------------------------------------------------
    // Two strokes over the same path: a wide dark casing and a lighter ribbon
    // on top. That is what makes it read as a road rather than a wire.
    const d = this.pathData();
    for (const cls of ['map-road', 'map-line']) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', cls);
      this.root.appendChild(p);
    }

    // --- Start/finish -----------------------------------------------------
    {
      const i = 0;
      const hw = track.width[i] * 0.6;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', this.sx(track.px[i] + track.nx[i] * hw).toFixed(2));
      line.setAttribute('y1', this.sy(track.pz[i] + track.nz[i] * hw).toFixed(2));
      line.setAttribute('x2', this.sx(track.px[i] - track.nx[i] * hw).toFixed(2));
      line.setAttribute('y2', this.sy(track.pz[i] - track.nz[i] * hw).toFixed(2));
      line.setAttribute('class', 'map-start');
      this.root.appendChild(line);
    }

    // --- One dot per car --------------------------------------------------
    // Drawn in reverse so the player's dot, appended last, sits on top of the
    // field rather than being buried under whoever happens to be alongside.
    const ordered = [...cars].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer));
    for (const car of ordered) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', car.isPlayer ? '2.7' : '1.9');
      c.setAttribute('class', 'map-dot' + (car.isPlayer ? ' is-player' : ''));
      c.setAttribute('fill', '#' + car.team.colour.toString(16).padStart(6, '0'));
      this.root.appendChild(c);
      this.dots.push(c);
      // Not NaN: every comparison against NaN is false, so the dots would
      // never make their first move and the whole field would sit stacked in
      // the top-left corner of the viewBox.
      this.lastX.push(-1e9);
      this.lastY.push(-1e9);
      this.lastHidden.push(false);
    }
    this.order = ordered;
  }

  private sx(x: number): number {
    return ((x - this.cx) / this.span) * 100 + 50;
  }

  private sy(z: number): number {
    return ((z - this.cz) / this.span) * 100 + 50;
  }

  private pathData(): string {
    const t = this.track;
    let d = '';
    for (let i = 0; i < t.count; i += NODE_STRIDE) {
      d += (i === 0 ? 'M' : 'L') + this.sx(t.px[i]).toFixed(2) + ',' + this.sy(t.pz[i]).toFixed(2);
    }
    return d + 'Z';
  }

  /**
   * Moves the dots. Called once per rendered frame.
   *
   * Positions come from the physics rather than from `s`/`lateral` so a car
   * that has spun off into the gravel shows where it actually is. Writes are
   * skipped when a dot has not moved by a visible amount, which at a steady
   * speed is most of the field most of the time.
   */
  update(): void {
    for (let i = 0; i < this.order.length; i++) {
      const car = this.order[i];
      const dot = this.dots[i];

      const hidden = car.retired && car.recovered;
      if (hidden !== this.lastHidden[i]) {
        dot.style.display = hidden ? 'none' : '';
        this.lastHidden[i] = hidden;
      }
      if (hidden) continue;

      const x = this.sx(car.physics.position.x);
      const y = this.sy(car.physics.position.y);
      if (Math.abs(x - this.lastX[i]) > 0.02 || Math.abs(y - this.lastY[i]) > 0.02) {
        dot.setAttribute('cx', x.toFixed(2));
        dot.setAttribute('cy', y.toFixed(2));
        this.lastX[i] = x;
        this.lastY[i] = y;
      }
    }
  }
}
