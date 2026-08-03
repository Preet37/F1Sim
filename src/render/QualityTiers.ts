/**
 * WHAT THE RENDERER IS ALLOWED TO SPEND, AND WHO DECIDES.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS REPLACES (issue #29)
 * ---------------------------------------------------------------------------
 *
 * The tier was one expression:
 *
 *     quality = touchPrimary || cores <= 4 ? 'low' : 'high'
 *
 * and `low` meant, simultaneously and with no way to separate them: no
 * post-processing chain at all, no shadow map, no MSAA, and reduced geometry in
 * every mesh builder. `touchPrimary` is `matchMedia('(pointer: coarse)')`, so
 * **every phone ever made lands on `low`** — a 2015 phone and a 2026 phone get
 * the identical, cheapest image the renderer knows how to draw.
 *
 * That is the same defect that kept the mirrors dark on the reporting device
 * for months (PROJECT.md §6, "Cameras and mirrors"): a feature gated on
 * `quality === 'high'` had never once run on the machine the complaints were
 * being written from. There are a dozen such gates in `src/render/`. This
 * module is the one place that decides what any of them mean.
 *
 * ---------------------------------------------------------------------------
 * WHY DETECTION ALONE CANNOT WORK, AND WHAT IS DONE INSTEAD
 * ---------------------------------------------------------------------------
 *
 * The obvious repair is a better `detectTier`. It does not exist. The two
 * signals a browser will give us are both useless for separating a fast phone
 * from a slow one:
 *
 *   - `navigator.hardwareConcurrency` is CLAMPED on iOS Safari. Every iPhone
 *     from roughly the 8 onwards reports the same small number regardless of
 *     what silicon is behind it, so a core count cannot tell an A11 from an
 *     A18. Any rule written on it reproduces the bug it is meant to fix.
 *   - `navigator.deviceMemory` is not implemented in Safari at all, so on the
 *     reporting device it is `undefined`. A rule that demotes on missing
 *     memory demotes every iPhone; a rule that ignores it is blind.
 *
 * So `auto` does not try to be clever about the hardware. It picks a floor it
 * is confident about and then **measures the device it is actually on** —
 * `Renderer.updateAutoTier` promotes a tier once the frame-cost window says
 * there is room, and demotes and latches if there is not. That is the same
 * shape as the dynamic resolution scaler, which is already the only thing in
 * this renderer that has ever correctly described the machine it was running
 * on. See `AUTO_PROMOTE_MS` / `AUTO_DEMOTE_MS`.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE TIERS AND FOUR SEPARATE SWITCHES
 * ---------------------------------------------------------------------------
 *
 * The four expensive things are not one thing and do not scale together:
 *
 *   | thing       | what it costs                                            |
 *   |-------------|----------------------------------------------------------|
 *   | post chain  | four full-screen passes over the whole drawing buffer     |
 *   | shadows     | a second render of the scene into a 2048 square depth map |
 *   | MSAA        | four times the write bandwidth on every covered pixel     |
 *   | resolution  | everything above, quadratically                           |
 *
 * A device can easily afford one and not another, and the binary tier forced
 * an all-or-nothing choice for which "nothing" was always the answer on a
 * phone. `medium` exists to name the middle: the picture the post chain gives
 * (bloom, the grade, contact AO) without the shadow map or the multisample
 * resolve, which measured as the two most expensive individual items.
 *
 * Each switch can also be overridden on its own, because a tier is a guess and
 * the player is the one looking at the screen.
 */

/** What a tier is called. `auto` is a preference, not a tier. */
export type QualityTier = 'low' | 'medium' | 'high';

/** An individual override. `auto` means "whatever the tier says". */
export type GraphicsPref = 'auto' | 'on' | 'off';

export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

/** The player's stated preference. Persisted in `GameSettings.graphics`. */
export interface GraphicsSettings {
  /** Post-processing chain: bloom, grade, contact AO, tone map. */
  post: GraphicsPref;
  /** Real sun shadows from a 2048-square cascade following the car. */
  shadows: GraphicsPref;
  /** 4x multisampling. Cannot change without a new GL context. */
  msaa: GraphicsPref;
  /**
   * Ceiling on the dynamic resolution scaler, or `auto` for the tier's.
   *
   * A ceiling rather than a fixed scale: the scaler still owns the floor, and
   * a player who asks for full resolution on a device that cannot hold it
   * should get a frame rate, not a slideshow.
   */
  resolution: 'auto' | number;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  post: 'auto',
  shadows: 'auto',
  msaa: 'auto',
  resolution: 'auto',
};

/** The resolution ceilings offered on the Video tab. */
export const RESOLUTION_CHOICES: readonly number[] = [0.5, 0.75, 0.9, 1];

/** What a tier means before any override is applied. */
export interface TierProfile {
  post: boolean;
  shadows: boolean;
  msaa: boolean;
  maxResolutionScale: number;
  /**
   * The binary level handed to the mesh builders.
   *
   * `CarMesh`, `TrackMesh`, `Signage`, `Rain`, `ParticleSystem`, `SkidMarks`
   * and `SafetyCarMesh` all take `'low' | 'high'` and use it to choose segment
   * counts, texture sizes and particle capacities. Those are CPU-and-memory
   * decisions taken once at build time, not per-frame GPU cost, and a 2026
   * phone has no trouble with them — so `medium` gets the full-detail meshes.
   * Widening those signatures would have touched eight files for no measurable
   * gain, so the mapping lives here instead.
   */
  detail: 'low' | 'high';
}

export const TIER_PROFILES: Record<QualityTier, TierProfile> = {
  /**
   * The cheapest image the renderer can draw. A device that cannot hold the
   * frame budget on `medium` lands here and stays.
   *
   * The resolution ceiling is 1.0, not something lower: the scaler drops on
   * its own when frames are slow, and pre-emptively softening the picture on a
   * device that turned out to be fine is exactly the mistake that made the
   * game look cheap for a year (PROJECT.md §6, "Rendering: the single biggest
   * fix").
   */
  low: { post: false, shadows: false, msaa: false, maxResolutionScale: 1, detail: 'low' },
  /**
   * The post chain, at full mesh detail, without the two passes that measured
   * most expensive.
   *
   * This is the tier that did not exist and is the entire point of the issue.
   * The post chain is what supplies bloom, the colour grade and the contact
   * occlusion that stops objects looking pasted on — it is most of the visible
   * difference between the two old tiers — and it costs one full-screen pass
   * per stage rather than a second render of the scene.
   */
  medium: { post: true, shadows: false, msaa: false, maxResolutionScale: 1, detail: 'high' },
  /** Everything. */
  high: { post: true, shadows: true, msaa: true, maxResolutionScale: 1, detail: 'high' },
};

/** Everything the renderer needs to know, after preferences are applied. */
export interface ResolvedGraphics extends TierProfile {
  tier: QualityTier;
  /** What `auto` would have picked. Equal to `tier` unless forced. */
  detectedTier: QualityTier;
  /** True when the tier is being measured rather than stated. */
  adaptive: boolean;
  /** Which of the four switches the player set by hand. For the readout. */
  overridden: readonly string[];
}

export interface DeviceSignals {
  cores: number;
  touchPrimary: boolean;
  /** GB, or 0 when the browser does not say — which includes all of Safari. */
  deviceMemoryGb: number;
  devicePixelRatio: number;
}

export function readDeviceSignals(): DeviceSignals {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    cores: nav.hardwareConcurrency ?? 4,
    touchPrimary: typeof matchMedia === 'function'
      ? matchMedia('(pointer: coarse)').matches
      : false,
    deviceMemoryGb: nav.deviceMemory ?? 0,
    devicePixelRatio: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
  };
}

/**
 * The tier `auto` STARTS from. Not the tier it ends on — see the module note.
 *
 * Deliberately timid on a touch-primary device and deliberately not timid
 * anywhere else. The cost of starting a phone one tier low is a few seconds of
 * a slightly plainer image before `updateAutoTier` promotes it; the cost of
 * starting it one tier high is the first ten seconds of the player's first
 * session at fifteen frames a second, which is the impression that sticks.
 *
 * Note what this is NOT allowed to do any more: it cannot pin a phone at
 * `low`. `low` is now only reachable by measurement or by the player asking
 * for it.
 */
export function detectTier(d: DeviceSignals): QualityTier {
  // A stated small machine is a small machine on every platform that reports
  // it, and this is the one signal that has never been a lie.
  if (d.deviceMemoryGb > 0 && d.deviceMemoryGb <= 2) return 'low';

  if (d.touchPrimary) {
    // `cores` is clamped on iOS, so it can only be trusted DOWNWARDS: a device
    // admitting to two cores really has two. Anything else starts at medium
    // and is measured from there.
    return d.cores <= 2 ? 'low' : 'medium';
  }

  // Desktop. Four cores or fewer used to mean `low`, which put a 2019 laptop
  // on the same image as a 2015 phone; it now means the middle tier and is
  // promoted if the frames are there.
  return d.cores <= 4 ? 'medium' : 'high';
}

/** Applies the player's overrides on top of a tier. */
export function resolveGraphics(
  tier: 'auto' | QualityTier,
  prefs: GraphicsSettings,
  signals: DeviceSignals,
): ResolvedGraphics {
  const detectedTier = detectTier(signals);
  const chosen: QualityTier = tier === 'auto' ? detectedTier : tier;
  return applyOverrides(chosen, detectedTier, tier === 'auto', prefs);
}

/**
 * Re-applies overrides to a tier the adaptive pass has moved to.
 *
 * Split out from `resolveGraphics` so promotion does not re-run detection —
 * `detectedTier` is a fact about the device and must not change mid-session.
 */
export function applyOverrides(
  tier: QualityTier,
  detectedTier: QualityTier,
  adaptive: boolean,
  prefs: GraphicsSettings,
): ResolvedGraphics {
  const base = TIER_PROFILES[tier];
  const overridden: string[] = [];
  const pick = (p: GraphicsPref, fallback: boolean, name: string): boolean => {
    if (p === 'auto') return fallback;
    overridden.push(name);
    return p === 'on';
  };
  const post = pick(prefs.post, base.post, 'post');
  const shadows = pick(prefs.shadows, base.shadows, 'shadows');
  const msaa = pick(prefs.msaa, base.msaa, 'msaa');
  let maxResolutionScale = base.maxResolutionScale;
  if (prefs.resolution !== 'auto' && typeof prefs.resolution === 'number'
    && Number.isFinite(prefs.resolution)) {
    maxResolutionScale = clampScale(prefs.resolution);
    overridden.push('resolution');
  }
  return {
    tier,
    detectedTier,
    // An override on any of the four means the tier is no longer the whole
    // story, but it does not stop the adaptive pass: a player who forced the
    // post chain on still wants the resolution measured for them.
    adaptive,
    post,
    shadows,
    msaa,
    maxResolutionScale,
    detail: base.detail,
    overridden,
  };
}

function clampScale(v: number): number {
  return v < 0.5 ? 0.5 : v > 1 ? 1 : v;
}

/**
 * Normalises whatever is on disk.
 *
 * Settings go through `loadSettings`'s spread-over-defaults, which is SHALLOW,
 * so a `graphics` object written by an older build arrives with fields missing
 * and a hand-edited one can arrive with anything at all. A `NaN` resolution
 * reaching `setPixelRatio` gives a zero-by-zero drawing buffer and a black
 * screen with no error — the same class of failure the gamepad deadzone and
 * the weekend options are already normalised against.
 */
export function normaliseGraphics(raw: unknown): GraphicsSettings {
  const g = (raw ?? {}) as Partial<GraphicsSettings>;
  const pref = (v: unknown): GraphicsPref => (v === 'on' || v === 'off' ? v : 'auto');
  let resolution: 'auto' | number = 'auto';
  if (typeof g.resolution === 'number' && Number.isFinite(g.resolution)) {
    resolution = clampScale(g.resolution);
  }
  return {
    post: pref(g.post),
    shadows: pref(g.shadows),
    msaa: pref(g.msaa),
    resolution,
  };
}

/** Coerces a stored tier preference. Old saves hold only `auto`, `low`, `high`. */
export function normaliseTier(raw: unknown): 'auto' | QualityTier {
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'auto';
}

/**
 * Frame cost above which the adaptive pass gives a tier back, in ms.
 *
 * Above `DROP_MS` (20ms, 50fps) in `Renderer`, because the resolution scaler
 * gets first refusal. Losing a quarter of the pixels is cheaper to look at
 * than losing the whole post chain, so resolution moves first and the tier
 * only moves when resolution has run out of room.
 */
export const AUTO_DEMOTE_MS = 24;
/**
 * Frame cost below which the adaptive pass tries the next tier up, in ms.
 *
 * 16.9ms is 59.2fps, which is what a 60Hz panel reports when it is comfortable.
 * This deliberately does NOT ask for more than the refresh rate: `CLIMB_MS`
 * once did, and a threshold a vsync-limited display cannot reach is dead code
 * that ran in every session for a year (PROJECT.md §6). The other half of the
 * test is in `updateAutoTier`, which additionally requires the resolution
 * scaler to have been sitting at its ceiling — a machine that is short of
 * frames spends its time below the ceiling, not at it.
 */
export const AUTO_PROMOTE_MS = 16.9;
/** Seconds held at the ceiling and under budget before a promotion. */
export const AUTO_PROMOTE_AFTER_S = 8;
/** Seconds after a promotion during which a demotion blames the promotion. */
export const AUTO_VERDICT_S = 6;

export function tierAbove(t: QualityTier): QualityTier | null {
  return t === 'low' ? 'medium' : t === 'medium' ? 'high' : null;
}

export function tierBelow(t: QualityTier): QualityTier | null {
  return t === 'high' ? 'medium' : t === 'medium' ? 'low' : null;
}

/** Human wording for the readout on the Video tab. */
export const TIER_LABEL: Record<QualityTier, string> = {
  low: 'Low', medium: 'Medium', high: 'High',
};
