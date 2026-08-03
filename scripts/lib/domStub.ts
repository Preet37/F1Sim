/**
 * Just enough DOM for a HUD widget to be exercised from a probe.
 *
 * The point is to run the REAL `TrackMap`, not a copy of its logic. A probe
 * that reimplements what the map is supposed to draw can only ever test itself:
 * the whole class of bug worth catching here is the display and the simulation
 * drifting apart, and a reimplementation drifts with neither.
 *
 * `TrackMap` builds an SVG once and thereafter writes attributes — a class name
 * per marshalling sector, `cx`/`cy` per car — so the surface it needs is
 * `createElementNS`, `setAttribute`, `appendChild`, `textContent` and `style`.
 * That is all this provides. It is not a DOM implementation and should not grow
 * into one; if a widget needs more than this, it needs a real headless browser.
 */

export interface StubElement {
  tag: string;
  attrs: Record<string, string>;
  children: StubElement[];
  style: Record<string, string>;
  textContent: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: StubElement): StubElement;
  /**
   * No-op event plumbing.
   *
   * three.js's `ImageLoader` asks `document` for an `<img>` and then subscribes
   * to its `load` and `error` events. Without these two methods any probe that
   * builds a mesh carrying a texture map — which is every probe that builds the
   * CAR, because the bodywork samples a carbon normal map — dies inside
   * `TextureLoader.load` before it ever gets a vertex. The image never arrives,
   * which is exactly right: a probe measures geometry, and the texture that
   * would have been decoded here has no bearing on where a vertex is.
   */
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
}

function createElement(tag: string): StubElement {
  const el: StubElement = {
    tag,
    attrs: {},
    children: [],
    style: {},
    textContent: '',
    setAttribute(name: string, value: string): void { el.attrs[name] = String(value); },
    getAttribute(name: string): string | null { return el.attrs[name] ?? null; },
    appendChild(child: StubElement): StubElement { el.children.push(child); return child; },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  return el;
}

/** Installs the stub as the global `document`. Safe to call more than once. */
export function installDomStub(): void {
  const g = globalThis as unknown as {
    document?: { createElement?: unknown; createElementNS?: unknown };
  };
  if (g.document) return;
  // BOTH entry points. The type annotation used to name `createElement` while
  // the object only supplied `createElementNS`, so the mismatch was invisible
  // and the half that `src/main.ts` uses on every screen it builds was missing.
  g.document = {
    createElement: (tag: string) => createElement(tag),
    createElementNS: (_ns: string, tag: string) => createElement(tag),
  };
}

/**
 * A `<canvas>` that answers the 2D API without drawing anything.
 *
 * `buildTrackMeshes` paints its signage, hoardings and fence textures into
 * canvases at load. A probe that wants the circuit's GEOMETRY has no interest
 * in any of them, but it cannot get the geometry without the call succeeding —
 * so the calls succeed and produce a blank texture. Nothing here is measured;
 * the moment a probe wants to assert something about a texture's CONTENT it
 * needs a real headless browser, not this.
 */
export function installCanvasStub(): void {
  const ctx2d = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} });
      }
      if (prop === 'getImageData' || prop === 'createImageData') {
        return (_x: number, _y: number, w: number, h: number) =>
          ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
      }
      if (prop === 'canvas') return { width: 1, height: 1 };
      return () => {};
    },
    set() { return true; },
  });
  const makeCanvas = () => ({
    width: 1, height: 1,
    getContext: () => ctx2d,
    toDataURL: () => '',
  });

  const g = globalThis as unknown as {
    document?: { createElement?: (tag: string) => unknown };
    OffscreenCanvas?: unknown;
  };
  installDomStub();
  const doc = g.document!;
  if (!doc.createElement) {
    doc.createElement = (tag: string) =>
      (tag === 'canvas' ? makeCanvas() : createElement(tag));
  }
  if (!g.OffscreenCanvas) {
    g.OffscreenCanvas = class { constructor() { return makeCanvas(); } };
  }
}

/**
 * Every `class` attribute in the tree, in document order, filtered by prefix.
 *
 * Reading the rendered tree rather than the widget's private fields is
 * deliberate: it is the same thing a browser's style engine sees, so an
 * assertion made on it is an assertion about what the player is looking at.
 */
export function readClasses(root: StubElement, prefix: string): string[] {
  const out: string[] = [];
  const walk = (el: StubElement): void => {
    const cls = el.attrs['class'];
    if (cls !== undefined && cls.startsWith(prefix)) out.push(cls);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}
