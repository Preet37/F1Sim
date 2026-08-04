/**
 * The asset slot loader.
 *
 * WHAT PROBLEM THIS SOLVES. PROJECT.md §3 has asserted for months that every
 * branded slot on this car — the team badge, a sponsor decal, a driver portrait,
 * the livery itself — is an *asset slot* backed by a generated placeholder, so
 * that real artwork could be dropped into `public/brand/` and appear with no code
 * change, and so that deleting that directory would return the game to a
 * shippable state. None of it existed (issue #36). `MARK_DEVICES` in
 * `LiveryDesign.ts` and `SPONSORS` in `Livery.ts` are real and are what a slot
 * falls back TO; this module is the override half.
 *
 * THE CONTRACT, in full:
 *
 *   1. RESOLUTION. A team-scoped slot resolves, in this order:
 *          <root>/<team-id>/<slot>.png
 *          <root>/<team-id>/<slot>.webp
 *          <root>/<team-id>/<slot>.svg
 *      A shared slot — materials, LUTs, environment maps, anything not owned by
 *      one team — uses the same three extensions under `<root>/shared/`. `root`
 *      is `/brand/`, i.e. `public/brand/` on disk. First hit wins; the order is
 *      `png, webp, svg` because that is decreasing likelihood of a hand-exported
 *      file and increasing likelihood of a vector the painter would have to
 *      rasterise at an unknown size.
 *
 *   2. FALLBACK. Absent a file, `brandImage` returns null and every caller draws
 *      exactly what it drew before this module existed. No exception, no console
 *      output, no retry.
 *
 *   3. NO REQUEST STORM, AND THIS IS A HARD GUARANTEE RATHER THAN A HABIT. The
 *      loader issues exactly ONE request that can miss — `<root>/manifest.json` —
 *      for the whole page, ever. The Vite plugin in `vite.config.ts` answers it
 *      with 200 and an empty list when `public/brand/` does not exist, so the
 *      shipped game makes one request that succeeds and no request that fails.
 *      Every subsequent fetch is for a path the manifest has already said is
 *      there, so a slot with no file costs ZERO requests and produces ZERO
 *      console output. That is what makes "no console noise" a property of the
 *      design rather than of a filter.
 *
 *      The obvious alternative — probing `badge.png`, then `badge.webp`, then
 *      `badge.svg` and taking the 404s — was rejected for exactly this reason:
 *      Chrome logs every failed subresource load to the console, `scripts/` reads
 *      `page.on('console')` as a failure signal in five harnesses already, and 22
 *      teams x 4 slots x 3 extensions is 264 guaranteed 404s on a build carrying
 *      no artwork at all.
 *
 *   4. NO LAYOUT SHIFT. Nothing here measures, sizes or reflows anything. An
 *      image that arrives after the first paint is composited into the SAME
 *      canvas the livery was already painted into and the texture is re-uploaded
 *      (`Livery.ts` subscribes to `onBrandChange`), so the swap costs one texture
 *      upload and moves no geometry and no DOM.
 *
 *   5. DELETING `public/brand/` RETURNS THE GAME TO BYTE-IDENTICAL RENDERING.
 *      That is the shippability guarantee and it is the assertion worth probing —
 *      `npm run probe:assets` renders a team with and without a dropped-in file
 *      and sha256s all three arms. It holds by construction because every
 *      override is a branch that is not taken, never a different code path.
 *
 * WHY THERE IS NO three.js IMPORT AND NO DOM AT MODULE SCOPE. `probe:assets`
 * asserts the resolution order in Node, without a browser, for the same reason
 * `LiveryDesign.ts` is split out of `Livery.ts`: a rule a probe can only reach
 * through a GL context is a rule that gets checked once.
 */

// ===========================================================================
// The slots
// ===========================================================================

/** Slots that belong to one team. */
export type TeamSlot = 'badge' | 'sponsor' | 'portrait' | 'livery';

/**
 * Slots that belong to nobody: shared artwork.
 *
 * These are the CC0 PBR material sets, colour LUTs and environment maps the
 * user has been collecting. They are named rather than free-form so that a
 * typo resolves to nothing loudly (in the probe) instead of quietly.
 */
export type SharedSlot = 'material' | 'lut' | 'envmap';

export const TEAM_SLOTS: readonly TeamSlot[] = ['badge', 'sponsor', 'portrait', 'livery'];
export const SHARED_SLOTS: readonly SharedSlot[] = ['material', 'lut', 'envmap'];

/**
 * Tried in this order, first hit wins.
 *
 * `svg` last because a vector has no natural pixel size and the painter has to
 * pick one; `png` first because it is what every one of the sources the user
 * named (Sketchfab, Poly Haven, community liveries) exports by default.
 */
export const SLOT_EXTENSIONS: readonly string[] = ['png', 'webp', 'svg'];

/** The directory shared assets live in, under the brand root. */
export const SHARED_DIR = 'shared';

/**
 * What a caller asks for: a team id, or the shared scope.
 *
 * Team ids are the ids in `src/data/roster/` — `ferrari`, `mclaren`, `red-bull`
 * — which is deliberate: that directory is already the project's swap boundary
 * for names, and this makes it the swap boundary for artwork too.
 */
export type BrandScope = string;

let root = '/brand/';

/**
 * Where the slots are read from. Ends with a slash.
 *
 * A setter exists for exactly two callers: a deployment under a sub-path, and
 * `probe:assets`, which points the loader at a directory with nothing in it to
 * prove its own override assertion can go red.
 */
export function brandRoot(): string {
  return root;
}

export function setBrandRoot(next: string): void {
  const cleaned = next.endsWith('/') ? next : next + '/';
  if (cleaned === root) return;
  root = cleaned;
  // A different root is a different world: everything already resolved against
  // the old one is wrong, including the "this is absent" answers.
  resolved.clear();
  inFlight.clear();
  manifest = null;
  manifestLoad = null;
  notify();
}

/** The one request this module makes that is allowed to miss. */
export function brandManifestUrl(): string {
  return root + 'manifest.json';
}

/**
 * The paths a slot resolves through, in order, relative to the brand root.
 *
 * Pure. This is the whole of rule 1 above and it is what `probe:assets` §1
 * asserts, in Node, with no browser and no network.
 */
export function slotCandidates(scope: BrandScope, slot: string): string[] {
  const dir = scope === SHARED_DIR ? SHARED_DIR : scope;
  return SLOT_EXTENSIONS.map((ext) => `${dir}/${slot}.${ext}`);
}

/** The absolute URL of a candidate path. */
export function slotUrl(path: string): string {
  return root + path;
}

// ===========================================================================
// The manifest
// ===========================================================================

/**
 * The set of files that exist under the brand root, or an empty set.
 *
 * `null` means "not asked yet". Once it is a Set it never becomes null again
 * except through `setBrandRoot`, and it is never re-fetched: a page that has
 * been told there is no artwork does not go back and ask a second time.
 */
let manifest: Set<string> | null = null;
let manifestLoad: Promise<void> | null = null;

function parseManifest(body: unknown): Set<string> {
  const files = Array.isArray(body)
    ? body
    : (body && typeof body === 'object' && Array.isArray((body as { files?: unknown }).files)
      ? (body as { files: unknown[] }).files
      : []);
  const out = new Set<string>();
  for (const f of files) {
    if (typeof f !== 'string') continue;
    // Normalise: the writer emits posix relative paths, but a hand-edited
    // manifest with a leading slash should still work.
    out.add(f.replace(/^\/+/, ''));
  }
  return out;
}

/**
 * Fetches the manifest once.
 *
 * EVERY failure mode lands in the same place — an empty set — deliberately: no
 * `public/brand/`, a 404, a truncated body, invalid JSON, a hostile response,
 * or no `fetch` at all (a Node import of this module for the resolution-order
 * checks) all mean "there is no artwork", which is the state the game ships in
 * and the state it must render correctly.
 */
function ensureManifest(): Promise<void> {
  if (manifestLoad) return manifestLoad;
  const target = brandManifestUrl();
  manifestLoad = (async () => {
    if (typeof fetch !== 'function') { manifest = new Set(); return; }
    try {
      const res = await fetch(target, { cache: 'no-cache' });
      if (!res.ok) { manifest = new Set(); return; }
      manifest = parseManifest(await res.json());
    } catch {
      manifest = new Set();
    }
  })();
  return manifestLoad;
}

// ===========================================================================
// Slot resolution
// ===========================================================================

interface Resolved {
  /** The image, decoded and ready to draw. Null when the slot has no file. */
  image: HTMLImageElement | null;
  /** The path that won, relative to the root. Null when nothing did. */
  path: string | null;
}

const resolved = new Map<string, Resolved>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** URLs the manifest listed and the browser refused. See `decode`. */
const undecodable: string[] = [];

/** Bumped every time a slot settles. Cache keys downstream include it. */
let epoch = 0;

export function brandEpoch(): number {
  return epoch;
}

function notify(): void {
  epoch++;
  for (const cb of listeners) cb();
}

/**
 * Called when a slot settles, so a cached texture can be repainted in place.
 *
 * Returns an unsubscribe. `Livery.ts` holds exactly one of these for the whole
 * process; it is not a per-car subscription.
 */
export function onBrandChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function key(scope: BrandScope, slot: string): string {
  return scope + '/' + slot;
}

/**
 * Fetches a slot's file and decodes it.
 *
 * FETCH FIRST, THEN DECODE FROM A BLOB URL, rather than pointing an `<img>`
 * straight at the path — and that is not a style choice, it is what made the
 * loader work at all.
 *
 * An `<img>` whose `src` is the network hands you exactly one bit on failure,
 * `onerror`, for every one of "no such file", "not an image", "the connection
 * dropped" and "the decoder refused it". `probe:assets` spent its first run
 * looking at a **200 response, correct `image/png`, 6508 bytes, valid PNG
 * signature — and an `onerror`**, with a manual `new Image()` on the identical
 * URL a moment later succeeding. Nothing about that is diagnosable from one
 * bit. Going through `fetch` separates the two questions completely: the HTTP
 * status is observable, the bytes are in hand before the decoder is asked, and
 * a decode failure is then unambiguously a decode failure.
 *
 * It also keeps `.svg` working, which is the reason this is an object URL and
 * an `<img>` rather than `createImageBitmap`: an SVG with a viewBox and no
 * intrinsic size is what most icon exporters produce, `createImageBitmap`
 * rejects it, and `<img>` renders it.
 */
async function decode(url: string): Promise<HTMLImageElement | null> {
  if (typeof fetch !== 'function' || typeof Image !== 'function') return null;
  let objectUrl: string | null = null;
  try {
    // NO `crossOrigin`, and no CORS mode: everything here is same-origin, it
    // comes out of the app's own `public/`, so there is no canvas to taint and
    // nothing to ask permission for.
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) { undecodable.push(`${res.status} ${url}`); return null; }
    const blob = await res.blob();
    if (blob.size === 0) { undecodable.push(`empty ${url}`); return null; }
    objectUrl = URL.createObjectURL(blob);
    const src = objectUrl;
    const img = await new Promise<HTMLImageElement | null>((done) => {
      const el = new Image();
      el.onload = () => done(el);
      // The bytes arrived and the decoder refused them. Silent by policy —
      // but RECORDED, because "the file is right there and it is not showing"
      // is otherwise unanswerable, and `probe:assets` reads this list rather
      // than the console.
      el.onerror = () => done(null);
      el.src = src;
    });
    if (!img) { undecodable.push(`undecodable ${url}`); return null; }
    // THE OBJECT URL IS NEVER REVOKED, deliberately. A raster image holds its
    // decoded bitmap after load and would survive it — but an SVG does not: it
    // is rasterised lazily at whatever size it is drawn, and this atlas is
    // repainted every time another slot arrives, so revoking would work
    // perfectly until somebody dropped in a `.svg` and then produce a badge
    // that renders once and disappears. The cost of not revoking is bounded by
    // slots x teams and is a rounding error beside the decoded images
    // themselves.
    if (typeof img.decode === 'function') { try { await img.decode(); } catch { /* already loaded */ } }
    objectUrl = null;
    return img;
  } catch (e) {
    undecodable.push(`${String(e)} ${url}`);
    return null;
  } finally {
    // Only on a path that produced no usable image.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function start(scope: BrandScope, slot: string): Promise<void> {
  const k = key(scope, slot);
  const existing = inFlight.get(k);
  if (existing) return existing;
  const job = (async () => {
    await ensureManifest();
    const have = manifest ?? new Set<string>();
    let hit: Resolved = { image: null, path: null };
    for (const path of slotCandidates(scope, slot)) {
      if (!have.has(path)) continue;
      const img = await decode(slotUrl(path));
      if (img) hit = { image: img, path };
      break;
    }
    resolved.set(k, hit);
    inFlight.delete(k);
    // Only a slot that actually found something can change a picture. A slot
    // that resolved to nothing must not invalidate a livery cache, or every
    // car on the grid repaints four times at startup for no reason.
    if (hit.image) notify();
  })();
  inFlight.set(k, job);
  return job;
}

/**
 * The image for a slot, or null.
 *
 * SYNCHRONOUS, because every painter downstream of it is. The first call for a
 * slot returns null and starts the resolution; if that resolution finds
 * something, `onBrandChange` fires and the painter is asked to repaint. That is
 * the only shape that fits a canvas painter which allocates a texture at the end
 * of a straight-line function.
 */
export function brandImage(scope: BrandScope, slot: TeamSlot | SharedSlot | string): HTMLImageElement | null {
  const k = key(scope, slot);
  const hit = resolved.get(k);
  if (hit) return hit.image;
  void start(scope, slot);
  return null;
}

/** The URL that won for a slot, or null. For a caller that wants a URL. */
export function brandUrl(scope: BrandScope, slot: TeamSlot | SharedSlot | string): string | null {
  const k = key(scope, slot);
  const hit = resolved.get(k);
  if (hit) return hit.path ? slotUrl(hit.path) : null;
  void start(scope, slot);
  return null;
}

/** A shared asset — a material set, a LUT, an environment map. */
export function sharedImage(slot: SharedSlot | string): HTMLImageElement | null {
  return brandImage(SHARED_DIR, slot);
}

/**
 * Asks for a set of slots and settles.
 *
 * FOR PROBES AND FOR A LOADING SCREEN. Without it the first frame of a session
 * is drawn from the generated marks and the overrides arrive a moment later,
 * which is correct behaviour but makes a screenshot a race. `probe:assets` and
 * `audit/car.ts` both await this before shooting.
 */
export async function preloadBrand(
  scopes: readonly BrandScope[],
  slots: readonly string[] = TEAM_SLOTS,
): Promise<void> {
  await ensureManifest();
  for (const scope of scopes) for (const slot of slots) void start(scope, slot);
  await brandReady();
}

/** Settles when the manifest and everything asked for so far has resolved. */
export async function brandReady(): Promise<void> {
  await ensureManifest();
  // A slot that resolves can start nothing else, but draining is written as a
  // loop anyway so that a future caller which chains slots cannot race it.
  while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
}

/**
 * Forgets everything. Test seam only.
 *
 * Deliberately NOT called on session teardown: the whole point of the negative
 * cache is that it survives, and an image the browser has already decoded costs
 * nothing to keep.
 */
export function resetBrandAssets(): void {
  resolved.clear();
  inFlight.clear();
  manifest = null;
  manifestLoad = null;
  notify();
}

/** What the loader currently believes, for a probe to print. */
export function brandState(): {
  root: string;
  manifest: string[] | null;
  slots: { key: string; path: string | null }[];
  undecodable: string[];
} {
  return {
    root,
    manifest: manifest ? [...manifest].sort() : null,
    slots: [...resolved.entries()]
      .map(([k, v]) => ({ key: k, path: v.path }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    undecodable: [...undecodable],
  };
}
