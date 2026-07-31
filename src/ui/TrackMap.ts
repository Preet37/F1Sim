import type { CarEntry } from '../race/CarEntry';
import type { FlagSignal, RaceControlManager } from '../race/RaceControlManager';
import { worseSignal } from '../race/RaceControlManager';
import type { TrackSpline } from '../track/TrackSpline';

/**
 * Broadcast-style circuit map, coloured by flag.
 *
 * The outline is drawn ONCE, as a set of SVG paths built from the spline's own
 * sampled points, and thereafter only the `cx`/`cy` of one circle per car and a
 * class name per sector are written. That distinction is the whole design:
 * redrawing a 250-point path sixty times a second to move twenty dots would cost
 * more than the rest of the HUD put together, and the circuit does not move.
 *
 * World coordinates are normalised into a fixed 0..100 viewBox so the SVG scales
 * to whatever box the layout gives it, and so stroke widths and dot radii can be
 * chosen once instead of per circuit — a 5.8km Monza and a 3.3km Monaco end up
 * the same size on screen, which is what a real trackside graphic does.
 *
 * ---------------------------------------------------------------------------
 * Why the outline is cut into pieces
 *
 * "What sector has the yellow flag?" is not a question a single-coloured outline
 * can answer, and it is the question a driver most needs answered — a yellow at
 * turn 4 is a completely different instruction to a yellow in the last sector,
 * and the whole reason race control keeps twenty separate marshalling sectors is
 * that they are not the same event.
 *
 * So the road is drawn as one path per marshalling sector, each coloured
 * independently from `RaceControlManager.signalForSector`. That is the finest
 * resolution the simulation actually has, and it is what puts the colour on the
 * corner where the car is stopped rather than smeared across a third of the lap.
 *
 * On top of that, the three TIMING sectors are outlined and labelled, because
 * those are the divisions the player already knows by name from the timing
 * panel, and "sector 2 is yellow" is how the situation gets described out loud.
 * Each label chip takes the worst signal anywhere inside its timing sector, so
 * the two readings are consistent by construction: the chip cannot say green
 * while a piece of road inside it is yellow.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Every Nth spline node is enough for an outline at this size. */
const NODE_STRIDE = 3;

/** Timing sector labels, in order. */
const SECTOR_LABELS = ['S1', 'S2', 'S3'];

export class TrackMap {
  readonly root: SVGSVGElement;
  /** The spline this map was built for, so the HUD knows when to rebuild. */
  readonly track: TrackSpline;

  private readonly dots: SVGCircleElement[] = [];
  private readonly lastX: number[] = [];
  private readonly lastY: number[] = [];
  private readonly lastHidden: boolean[] = [];

  /** One path per marshalling sector, and the signal each is currently showing. */
  private readonly marshalPaths: SVGPathElement[] = [];
  private readonly marshalSignal: FlagSignal[] = [];

  /** The three timing-sector chips. */
  private readonly sectorChips: SVGGElement[] = [];
  private readonly sectorChipSignal: FlagSignal[] = ['green', 'green', 'green'];
  /** Start and end distance of each timing sector, metres. */
  private readonly sectorBounds: { from: number; to: number }[] = [];

  /** Cars in the order their dots were appended. */
  private readonly order: readonly CarEntry[];

  private readonly cx: number;
  private readonly cz: number;
  private readonly span: number;

  constructor(track: TrackSpline, cars: readonly CarEntry[], marshalSectors: number) {
    this.track = track;

    const b = track.bounds();
    this.cx = (b.minX + b.maxX) * 0.5;
    this.cz = (b.minZ + b.maxZ) * 0.5;
    // A little headroom so the outline's stroke and the dots never clip.
    this.span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.1;

    this.root = document.createElementNS(NS, 'svg');
    this.root.setAttribute('viewBox', '0 0 100 100');
    this.root.setAttribute('class', 'map-svg');

    // --- Casing -----------------------------------------------------------
    // One dark stroke around the whole lap, under everything. It gives the road
    // its thickness and hides the hairline seams where two coloured sector
    // paths meet.
    {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', this.pathBetween(0, track.length, true));
      p.setAttribute('class', 'map-road');
      this.root.appendChild(p);
    }

    // --- One coloured ribbon per marshalling sector ------------------------
    for (let i = 0; i < marshalSectors; i++) {
      const from = (i / marshalSectors) * track.length;
      const to = ((i + 1) / marshalSectors) * track.length;
      const p = document.createElementNS(NS, 'path');
      // Each sector runs a touch past its own end so consecutive ribbons
      // overlap by a node. Butt-jointed strokes leave a visible gap on every
      // boundary at this scale, which reads as twenty holes in the circuit.
      p.setAttribute('d', this.pathBetween(from, to + track.length / marshalSectors * 0.06, false));
      p.setAttribute('class', 'map-line flag-green');
      this.root.appendChild(p);
      this.marshalPaths.push(p);
      this.marshalSignal.push('green');
    }

    // --- Timing sector boundaries and labels ------------------------------
    const s1 = track.def.sector1EndS;
    const s2 = track.def.sector2EndS;
    this.sectorBounds.push({ from: 0, to: s1 }, { from: s1, to: s2 }, { from: s2, to: track.length });

    for (const s of [s1, s2]) this.root.appendChild(this.boundaryTick(s));

    for (let i = 0; i < 3; i++) {
      const { from, to } = this.sectorBounds[i];
      const mid = (from + to) * 0.5;
      const idx = track.indexAt(mid);
      // Pushed OUTWARD from the racing surface along the track normal, so a
      // chip never sits on top of the road it is labelling.
      const off = track.width[idx] * 1.9 + 14;
      const x = this.sx(track.px[idx] + track.nx[idx] * off);
      const y = this.sy(track.pz[idx] + track.nz[idx] * off);

      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'map-chip flag-green');
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', (clamp(x, 6, 94) - 6).toFixed(2));
      rect.setAttribute('y', (clamp(y, 5, 95) - 4).toFixed(2));
      rect.setAttribute('width', '12');
      rect.setAttribute('height', '8');
      rect.setAttribute('rx', '2');
      g.appendChild(rect);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', clamp(x, 6, 94).toFixed(2));
      text.setAttribute('y', (clamp(y, 5, 95) + 2.2).toFixed(2));
      text.textContent = SECTOR_LABELS[i];
      g.appendChild(text);
      this.root.appendChild(g);
      this.sectorChips.push(g);
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

  /** A tick across the road marking a timing sector boundary. */
  private boundaryTick(s: number): SVGLineElement {
    const t = this.track;
    const i = t.indexAt(s);
    const hw = t.width[i] * 0.85;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', this.sx(t.px[i] + t.nx[i] * hw).toFixed(2));
    line.setAttribute('y1', this.sy(t.pz[i] + t.nz[i] * hw).toFixed(2));
    line.setAttribute('x2', this.sx(t.px[i] - t.nx[i] * hw).toFixed(2));
    line.setAttribute('y2', this.sy(t.pz[i] - t.nz[i] * hw).toFixed(2));
    line.setAttribute('class', 'map-sector-tick');
    return line;
  }

  /** Path data along the spline between two distances. */
  private pathBetween(fromS: number, toS: number, close: boolean): string {
    const t = this.track;
    const first = t.indexAt(fromS);
    const nodes = Math.max(2, Math.round(((toS - fromS) / t.length) * t.count / NODE_STRIDE));
    let d = '';
    for (let n = 0; n <= nodes; n++) {
      const i = (first + n * NODE_STRIDE) % t.count;
      d += (n === 0 ? 'M' : 'L') + this.sx(t.px[i]).toFixed(2) + ',' + this.sy(t.pz[i]).toFixed(2);
    }
    return close ? d + 'Z' : d;
  }

  /**
   * Repaints the sectors from race control, and moves the dots.
   *
   * Called once per rendered frame. Positions come from the physics rather than
   * from `s`/`lateral` so a car that has spun off into the gravel shows where it
   * actually is. Writes are skipped when nothing changed, which for the flags is
   * almost every frame of almost every session.
   */
  update(rc?: RaceControlManager): void {
    if (rc) this.updateFlags(rc);

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

  private updateFlags(rc: RaceControlManager): void {
    for (let i = 0; i < this.marshalPaths.length; i++) {
      const sig = rc.signalForSector(i);
      if (sig !== this.marshalSignal[i]) {
        this.marshalSignal[i] = sig;
        this.marshalPaths[i].setAttribute('class', 'map-line flag-' + sig);
      }
    }

    for (let i = 0; i < 3; i++) {
      const { from, to } = this.sectorBounds[i];
      // The chip takes the worst signal anywhere inside its timing sector, so
      // it can never read greener than the road it labels.
      let worst = rc.signalBetween(from, to);
      // signalBetween walks marshalling sectors, which do not line up with
      // timing sector boundaries; fold the boundary sectors in explicitly so a
      // flag raised right on a boundary is attributed to both.
      worst = worseSignal(worst, rc.signalAt(from));
      worst = worseSignal(worst, rc.signalAt(Math.max(0, to - 1)));
      if (worst !== this.sectorChipSignal[i]) {
        this.sectorChipSignal[i] = worst;
        this.sectorChips[i].setAttribute('class', 'map-chip flag-' + worst);
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
