import './career.css';
import './myteam.css';
import { CarStage } from '../render/CarStage';
import { disposeCarGeometryCache } from '../render/CarMesh';
import {
  BODY_PANEL_RECT, paintLiveryAtlas, registerLiveryDesign,
} from '../render/Livery';
import {
  FINISHES, LIVERY_FAMILIES, MARK_DEVICES, MARK_NAMES, PIGMENTS, drawMark,
  type LiveryDesign, type LiveryFamilyId, type LiveryFinish,
} from '../render/LiveryDesign';

/**
 * THE PAINT SHOP.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT TWO COLOUR PICKERS
 * ---------------------------------------------------------------------------
 *
 * The liveries this game generates have been its largest remaining visual gap
 * for a long time, and the reason is not that the painter was bad — it unwraps
 * three real panels, sweeps a nose flash, runs a spine down the deck, sets race
 * numbers and sponsor decals in the right places and paints occlusion into every
 * shut line. The reason is that it had ONE DESIGN. Twenty-two cars were the same
 * drawing in twenty-two colour pairs, which is exactly what "generated" looks
 * like. An editor with two colour pickers on top of that would have produced the
 * same grid with the player's hues in it, and it would have been worse than not
 * building one, because it would have made the sameness the player's own fault.
 *
 * So what varies here is the ARRANGEMENT — six pattern families — plus a third
 * colour, a finish and a mark. The third colour is the one that does the most
 * and would be missed by name least: real paint schemes almost always separate
 * two fields of colour with a thin line of a third, and that pinstripe is most
 * of the difference between a design and two colours meeting.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THIS SCREEN KEEPS
 * ---------------------------------------------------------------------------
 *
 * 1. WHAT IS PREVIEWED IS WHAT IS PAINTED. The car on the left is a real GL
 *    stage running `buildCar` — the same mesh, the same livery atlas and the
 *    same tyres the race renders. The family chips are the REAL PAINTER cropped
 *    to the monocoque, not a simplified drawing of what a family looks like.
 *    There is no second representation anywhere on this screen that could fall
 *    out of sync with the first.
 *
 * 2. IT COSTS NOTHING. There is no cap gauge on this screen and no price on any
 *    button, because paint is not a development cost and pretending otherwise
 *    would put a fake number in the one system whose whole claim is that its
 *    numbers are real.
 */

export interface LiveryChoice {
  colour: number;
  accent: number;
  design: LiveryDesign;
}

export interface LiveryEditorOptions {
  initial: LiveryChoice;
  /** Painted on the car, so the preview is this driver's car and not a demo. */
  number: number;
  code: string;
  quality?: 'low' | 'high';
  /** Fires on every change, already registered with the painter. */
  onChange?: (choice: LiveryChoice) => void;
}

export interface LiveryEditorHandle {
  choice(): LiveryChoice;
  /**
   * The right-hand column.
   *
   * Exposed so a screen that is ALSO a paint shop — team creation is one — can
   * append its own sections below the paint controls instead of building a
   * second two-column layout beside this one. The car on the left is then
   * shared, which is the point: on the creation screen it is the same live car
   * that is being named, engined and crewed.
   */
  panel: HTMLElement;
  /** Releases the GL context. The caller MUST call this before leaving. */
  dispose(): void;
}

/** Atlas size for the chips. Small: they are a hundred pixels wide. */
const CHIP_ATLAS = 256;
const CHIP_W = 208;
const CHIP_H = 62;

export function buildLiveryEditor(
  root: HTMLElement, opts: LiveryEditorOptions,
): LiveryEditorHandle {
  const state: LiveryChoice = {
    colour: opts.initial.colour,
    accent: opts.initial.accent,
    design: { ...opts.initial.design },
  };

  root.classList.add('paintshop');

  // =========================================================================
  // Left: the car, live
  // =========================================================================

  const stageHost = el('div', 'ps-stage', root);
  let stage: CarStage | null = null;
  try {
    stage = new CarStage({
      colour: state.colour,
      accent: state.accent,
      number: opts.number,
      code: opts.code,
      quality: opts.quality ?? 'high',
      still: matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    stage.mount(stageHost);
  } catch (err) {
    // The stage is a luxury and the editor is not. A machine that will not give
    // out a second GL context still gets to design a livery — the chips are the
    // real painter, so the design is still previewed, just not in three
    // dimensions.
    console.warn('Car stage unavailable; the paint shop continues without it.', err);
    stage = null;
    el('div', 'capgauge-note', stageHost,
      'This browser would not open a second 3D view. The chips below are still '
      + 'painted by the real livery, so the design is accurate.');
  }

  // =========================================================================
  // Right: the controls
  // =========================================================================

  const panel = el('div', 'ps-panel', root);

  section(panel, 'Pattern', 'Six arrangements of the same paint. Pick the shape first.');
  const familyRow = el('div', 'ps-families', panel);
  const familyChips = new Map<LiveryFamilyId, { button: HTMLElement; canvas: HTMLCanvasElement }>();
  for (const f of LIVERY_FAMILIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ps-family';
    b.title = f.note;
    b.setAttribute('aria-label', f.name + '. ' + f.note);
    const canvas = document.createElement('canvas');
    canvas.width = CHIP_W;
    canvas.height = CHIP_H;
    b.appendChild(canvas);
    el('span', 'ps-family-name', b, f.name);
    b.addEventListener('click', () => { state.design.family = f.id; repaint(); });
    familyRow.appendChild(b);
    familyChips.set(f.id, { button: b, canvas });
  }
  const familyNote = el('div', 'sg-note', panel);

  // --- The three colours ---------------------------------------------------
  section(panel, 'Paint',
    'Base, accent, and the trim line that separates them. The third one is what '
    + 'makes it look designed.');
  const paints = el('div', 'sg-paints', panel);
  const pigmentRows: { key: 'colour' | 'accent' | 'trim'; swatches: HTMLElement[] }[] = [];
  for (const [key, label] of [
    ['colour', 'Base'], ['accent', 'Accent'], ['trim', 'Trim'],
  ] as const) {
    const row = el('div', 'sg-paintrow', paints);
    el('div', 'sg-paintlabel', row, label);
    const strip = el('div', 'sg-pigments', row);
    const swatches: HTMLElement[] = [];
    for (const p of PIGMENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sg-pigment';
      b.style.setProperty('--pig', hex(p.hex));
      b.title = p.name;
      b.setAttribute('aria-label', label + ': ' + p.name);
      b.addEventListener('click', () => {
        if (key === 'trim') state.design.trim = p.hex;
        else state[key] = p.hex;
        repaint();
      });
      strip.appendChild(b);
      swatches.push(b);
    }
    pigmentRows.push({ key, swatches });
  }

  // --- The finish ----------------------------------------------------------
  const finishRow = el('div', 'sg-paintrow', paints);
  el('div', 'sg-paintlabel', finishRow, 'Finish');
  const finishStrip = el('div', 'sg-visors', finishRow);
  const finishButtons = new Map<LiveryFinish, HTMLElement>();
  for (const f of FINISHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sg-visor';
    b.textContent = f.name;
    b.title = f.note;
    b.addEventListener('click', () => { state.design.finish = f.id; repaint(); });
    finishStrip.appendChild(b);
    finishButtons.set(f.id, b);
  }
  const finishNote = el('div', 'sg-note', panel);

  // --- The mark ------------------------------------------------------------
  section(panel, 'Mark',
    'A device, not a badge. It goes on the engine cover and beside your name on '
    + 'the timing tower.');
  const markRow = el('div', 'ps-marks', panel);
  const markButtons: { index: number; button: HTMLElement; canvas: HTMLCanvasElement }[] = [];
  for (let i = -1; i < MARK_DEVICES.length; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ps-mark';
    b.title = i < 0 ? 'No mark' : MARK_NAMES[i];
    b.setAttribute('aria-label', i < 0 ? 'No mark' : 'Mark: ' + MARK_NAMES[i]);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    b.appendChild(canvas);
    b.addEventListener('click', () => { state.design.mark = i; repaint(); });
    markRow.appendChild(b);
    markButtons.push({ index: i, button: b, canvas });
  }

  // =========================================================================
  // Painting
  // =========================================================================

  /** Scratch atlas for the chips. One canvas, repainted six times a repaint. */
  const chipAtlas = document.createElement('canvas');
  chipAtlas.width = chipAtlas.height = CHIP_ATLAS;
  const chipCtx = chipAtlas.getContext('2d')!;

  function paintChip(canvas: HTMLCanvasElement, family: LiveryFamilyId): void {
    paintLiveryAtlas(
      chipCtx,
      { colour: state.colour, accent: state.accent, number: opts.number, code: opts.code },
      CHIP_ATLAS,
      { ...state.design, family },
    );
    // Crop to the monocoque panel, from just above the floor line to just below
    // it on the other side — so the chip shows the nose, the flank and the deck
    // along the whole length of the car, which is what a family actually is.
    const r = BODY_PANEL_RECT;
    const panelY = (1 - r.v1) * CHIP_ATLAS;
    const panelH = (r.v1 - r.v0) * CHIP_ATLAS;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      chipAtlas,
      r.u0 * CHIP_ATLAS, panelY + panelH * 0.12,
      (r.u1 - r.u0) * CHIP_ATLAS, panelH * 0.76,
      0, 0, canvas.width, canvas.height,
    );
  }

  function paintMarkChip(canvas: HTMLCanvasElement, index: number): void {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (index < 0) {
      ctx.strokeStyle = 'rgba(150,180,214,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(18, 46); ctx.lineTo(46, 18);
      ctx.stroke();
      return;
    }
    drawMark(ctx, 32, 32, 60, index, hex(state.colour), hex(state.accent));
  }

  let raf = 0;
  function repaint(): void {
    for (const [id, chip] of familyChips) {
      chip.button.classList.toggle('on', id === state.design.family);
      paintChip(chip.canvas, id);
    }
    familyNote.textContent =
      LIVERY_FAMILIES.find((f) => f.id === state.design.family)?.note ?? '';

    for (const row of pigmentRows) {
      const current = row.key === 'trim' ? state.design.trim : state[row.key];
      for (const [i, b] of row.swatches.entries()) {
        b.classList.toggle('on', PIGMENTS[i].hex === current);
      }
    }
    for (const [id, b] of finishButtons) b.classList.toggle('on', id === state.design.finish);
    finishNote.textContent = FINISHES.find((f) => f.id === state.design.finish)?.note ?? '';
    for (const m of markButtons) {
      m.button.classList.toggle('on', m.index === state.design.mark);
      paintMarkChip(m.canvas, m.index);
    }

    /**
     * THE 3D REBUILD IS DEFERRED BY A FRAME, AND HAS TO BE.
     *
     * Repainting the car means dropping `CarMesh`'s shared material and
     * geometry caches — its material key is the colour pair alone, so a design
     * change at fixed colours would otherwise be served the old texture and
     * nothing on screen would move. That is a full rebuild of the mesh, and
     * somebody dragging along a row of twenty-four pigment swatches would ask
     * for two dozen of them in half a second. Coalescing to one per frame keeps
     * the chips instant and the car a frame behind, which is the right way
     * round: the chips are what the eye is on while it is choosing.
     */
    if (stage && !raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!stage) return;
        registerLiveryDesign(state.colour, state.accent, state.design);
        disposeCarGeometryCache();
        stage.setLivery({
          colour: state.colour, accent: state.accent,
          number: opts.number, code: opts.code,
        });
      });
    } else if (!stage) {
      registerLiveryDesign(state.colour, state.accent, state.design);
    }

    opts.onChange?.(choice());
  }

  function choice(): LiveryChoice {
    return { colour: state.colour, accent: state.accent, design: { ...state.design } };
  }

  repaint();

  return {
    choice,
    panel,
    dispose(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stage?.dispose();
      stage = null;
    },
  };
}

// ===========================================================================
// Small builders
// ===========================================================================

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function section(parent: HTMLElement, title: string, note: string): void {
  const h = el('div', 'sg-section', parent);
  el('div', 'sg-section-title', h, title);
  el('div', 'sg-section-note', h, note);
}

export function hex(v: number): string {
  return '#' + (v & 0xffffff).toString(16).padStart(6, '0');
}
