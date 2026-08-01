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
  };
  return el;
}

/** Installs the stub as the global `document`. Safe to call more than once. */
export function installDomStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  g.document = { createElementNS: (_ns: string, tag: string) => createElement(tag) };
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
