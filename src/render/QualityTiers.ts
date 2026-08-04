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
 * `AutoTierPolicy` (below) promotes a tier once the frame-cost window says
 * there is room and demotes when there is sustained evidence there is not.
 * That is the same shape as the dynamic resolution scaler, which is already
 * the only thing in this renderer that has ever correctly described the
 * machine it was running on. See `AUTO_PROMOTE_MS` / `AUTO_DEMOTE_MS`.
 *
 * **It is reversible, and issue #73 is what that word cost.** The first
 * version latched the tier it was leaving out of the session on the FIRST
 * demotion, so a machine that was busy for three quarters of a second lost the
 * picture until the page was reloaded. See `AUTO_LATCH_AFTER_DEMOTIONS` and
 * `AUTO_VERDICT_S`.
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
 * gets first refusal: `updateAutoTier` will not demote until the scaler is at
 * `MIN_SCALE`. That ordering is MEASURED, not assumed, and it is the single
 * most important number in this file.
 *
 * Paired A/B on an Apple M5 at 390x844 @ dpr 2 — the pixel count a phone
 * actually draws — comparing the post chain at half scale against no chain at
 * full scale, which is exactly the choice this ordering makes:
 *
 *     Bahrain  3.63ms vs 4.99ms   27% CHEAPER with the chain
 *     Monaco   5.17ms vs 4.99ms    6% dearer
 *     Spa      3.90ms vs 5.51ms   29% CHEAPER with the chain
 *
 * and on `probe:sharpness`'s grain metric the same half-scale `medium` frame
 * measures 32.8 in the mid-distance against `low` at full scale's 63.6, and
 * 6.8 at the horizon against 20.3. **Giving up pixels to keep the chain is
 * cheaper AND cleaner than giving up the chain to keep the pixels.** Reversing
 * this ordering would make the picture worse at no saving, which is what the
 * binary tier did to every phone for a year.
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
 *
 * A NEAR MISS WORTH KNOWING ABOUT, and it is §6's oldest trap pointed the other
 * way. `audit:circuits` drives the renderer with a hard-coded `dt` of 1/60 —
 * 16.667ms, which is *under* this threshold — so an adaptive audit would
 * promote itself to `high` after eight seconds on every circuit and photograph
 * a tier no phone runs, exactly as the fixed `dt` once froze the resolution
 * scaler and made every audit PNG a picture no player had seen. It does not,
 * because `audit/audit.ts` passes an explicit `quality:` and a STATED tier sets
 * `adaptive: false`. **If anyone ever removes that argument to let the audit
 * "detect like the game does", this is what will happen.**
 */
export const AUTO_PROMOTE_MS = 16.9;
/** Seconds held at the ceiling and under budget before a promotion. */
export const AUTO_PROMOTE_AFTER_S = 8;
/**
 * Seconds of CONTINUOUS trouble at minimum resolution before a demotion, and
 * the window inside which a demotion is read as the verdict on the promotion
 * that preceded it.
 *
 * ISSUE #73 — THIS IS THE NUMBER THAT WAS MISSING. The pass used to demote on
 * a single window's frame cost: one `frameCostMs` reading above
 * `AUTO_DEMOTE_MS` while the scaler happened to be at `MIN_SCALE` and the tier
 * dropped, permanently. `frameCostMs` is a trimmed mean over 45 frames, i.e.
 * about three quarters of a second, so a background compile, another browser
 * tab or a thermal blip was enough. The reporting user lost `high` and then
 * `medium` to six headless Chromes running on the same machine at load average
 * 17-148, and finished the session on the tier #29 measured at 20.3 horizon /
 * 63.6 mid-distance grain against `high`'s 1.2 / 14.8.
 *
 * Six seconds of *unbroken* trouble is eight times the evidence, and it is the
 * same length as the settling window a promotion gets — so a promotion that
 * was a mistake is undone almost immediately, and a machine that is merely
 * busy for a moment is not judged at all. The resolution scaler continues to
 * absorb everything shorter than this, which is what it is for.
 */
export const AUTO_VERDICT_S = 6;
/**
 * How many demotions FROM a tier, in one page load, latch it out for good.
 *
 * ISSUE #73, THE OTHER HALF. The latch used to fire on the FIRST demotion:
 * `autoLatchedCeiling = this.features.tier` before the move, and the promotion
 * path then refused it forever. That makes `auto` a one-way ratchet — any
 * transient the scaler could not absorb cost the player the picture for the
 * rest of the session, silently and with no way back short of Settings.
 *
 * Deleting the latch is not the fix either, and the reason is written into
 * `Renderer.applyResolved`: promoting into `high` turns the shadow map on,
 * which changes the `#define` set every material in the scene was compiled
 * with, so every one of them has to recompile — a stall of a few hundred
 * milliseconds. A device that genuinely cannot hold a tier must not be made to
 * pay that every time it looks briefly comfortable.
 *
 * So the latch survives, and what changed is what it counts. A tier is retried
 * once. If it fails a SECOND time, that is no longer a transient, it is a
 * verdict about the device, and it is latched. The worst case for a genuinely
 * weak machine is therefore exactly one extra stall per tier per page load —
 * bounded, stated, and much cheaper than the sixteen-times-grainier image the
 * old rule handed a fast machine that had a bad three quarters of a second.
 */
export const AUTO_LATCH_AFTER_DEMOTIONS = 2;

export function tierAbove(t: QualityTier): QualityTier | null {
  return t === 'low' ? 'medium' : t === 'medium' ? 'high' : null;
}

export function tierBelow(t: QualityTier): QualityTier | null {
  return t === 'high' ? 'medium' : t === 'medium' ? 'low' : null;
}

/** 0, 1, 2. `low` < `medium` < `high`, so tiers can be compared. */
export function tierRank(t: QualityTier): number {
  return QUALITY_TIERS.indexOf(t);
}

/** Human wording for the readout on the Video tab. */
export const TIER_LABEL: Record<QualityTier, string> = {
  low: 'Low', medium: 'Medium', high: 'High',
};

// ===========================================================================
// THE ADAPTIVE TIER DECISION
// ===========================================================================

/** One frame, as the resolution scaler already measures it. */
export interface AutoTierFrame {
  /** Seconds since the previous frame. */
  dt: number;
  /** Trimmed-mean frame cost in ms — `Renderer.frameCostMs`. */
  costMs: number;
  /** The resolution scaler has no pixels left to give. */
  atMinScale: boolean;
  /** The resolution scaler is sitting at the ceiling it believes in. */
  atCeiling: boolean;
}

/** What the pass decided to do, and everything needed to explain it. */
export interface AutoTierMove {
  dir: 'down' | 'up';
  from: QualityTier;
  to: QualityTier;
  /** `from` will not be tried again this page load. Only ever set going down. */
  latched: boolean;
  /** Seconds of unbroken evidence behind the move. */
  evidenceS: number;
  /** This move puts the player back on the best tier they have had. */
  restored: boolean;
}

/** For the Video tab's readout and for `probe:autotier`. */
export interface AutoTierReport {
  latchedCeiling: QualityTier | null;
  demotionsFrom: Readonly<Record<QualityTier, number>>;
  troubleForS: number;
  comfortableForS: number;
  /** True while the player is below the best tier this page load has held. */
  reduced: boolean;
  peak: QualityTier;
}

/**
 * MEASURES THE DEVICE AND DECIDES THE TIER. `auto`'s second half.
 *
 * Detection is a dead end — `hardwareConcurrency` is clamped on iOS and
 * `deviceMemory` is absent from Safari entirely, so no static rule can tell a
 * 2026 phone from a 2015 one (see the module note above). What CAN be told
 * apart is a device holding its frame budget from one that is not, and the
 * renderer already computes that every frame for the resolution scaler.
 *
 * It lives here, as a pure object with no THREE and no DOM in it, for the same
 * reason `RenderPose.ts` exists: so a probe can drive **the real rule** instead
 * of a copy of it. `Renderer.updateAutoTier` is now glue — it reads the
 * scaler's state, calls `update`, and applies whatever comes back.
 *
 * THE ONE THING THIS HAS TO GET RIGHT (issue #73) is the difference between a
 * TRANSIENT and a VERDICT, because the two want opposite treatment and the
 * first version could not tell them apart at all:
 *
 *   - a transient — another tab, a compile, six headless Chromes, a thermal
 *     blip — must cost the player nothing permanent, and
 *   - a verdict — this device cannot hold this tier — must not be re-tested
 *     every twenty seconds, because finding out costs a shader recompile.
 *
 * Three things separate them, and none of them is a guess:
 *
 *   1. **Duration.** A demotion needs `AUTO_VERDICT_S` of UNBROKEN trouble at
 *      minimum resolution, not one window's median. Any comfortable frame
 *      resets the clock.
 *   2. **Repetition.** The first demotion from a tier is reversible; the
 *      second latches it out (`AUTO_LATCH_AFTER_DEMOTIONS`). Once is bad luck.
 *   3. **Escalating proof.** Retrying a tier that has already failed once
 *      costs twice the comfortable time the first attempt did, so a machine
 *      hovering on the boundary walks away from it rather than flapping.
 */
export class AutoTierPolicy {
  private comfortableFor = 0;
  private troubleFor = 0;
  private readonly demotions: Record<QualityTier, number> = { low: 0, medium: 0, high: 0 };
  /** The lowest tier auto has given up on. Nothing at or above it is retried. */
  private latched: QualityTier | null = null;
  /** The best tier this page load has held. What "restored" is measured against. */
  private peak: QualityTier;
  /** True once a demotion has taken the player below `peak`. */
  private reduced = false;

  constructor(startTier: QualityTier) {
    this.peak = startTier;
  }

  /**
   * Throws away the evidence, keeps the verdicts.
   *
   * Called when a session loads. The timers describe the last few seconds of a
   * session that has ended and mean nothing in the next one; the demotion
   * counts and the latch describe the DEVICE, which has not changed, and
   * forgetting them would hand a weak machine the promote/demote stall again
   * at every session load.
   */
  resetWindows(): void {
    this.comfortableFor = 0;
    this.troubleFor = 0;
  }

  /**
   * The player set a tier by hand on the Video tab.
   *
   * Everything is forgotten, including the latch: a tier auto gave up on is a
   * statement about auto's own measurements, and the player looking at the
   * screen outranks them. If they go back to `auto` afterwards it starts clean.
   */
  playerChose(tier: QualityTier): void {
    this.comfortableFor = 0;
    this.troubleFor = 0;
    this.demotions.low = 0;
    this.demotions.medium = 0;
    this.demotions.high = 0;
    this.latched = null;
    this.peak = tier;
    this.reduced = false;
  }

  report(): AutoTierReport {
    return {
      latchedCeiling: this.latched,
      demotionsFrom: { ...this.demotions },
      troubleForS: this.troubleFor,
      comfortableForS: this.comfortableFor,
      reduced: this.reduced,
      peak: this.peak,
    };
  }

  /** Seconds of comfort a promotion into `t` has to show. Doubles per failure. */
  promoteAfterS(t: QualityTier): number {
    return AUTO_PROMOTE_AFTER_S * (1 + this.demotions[t]);
  }

  /**
   * One frame. Returns the tier move to make, or null.
   *
   * `tier` is passed in rather than held, because the Video tab can change it
   * underneath this object at any moment and a second copy of "what tier are
   * we on" is exactly the kind of drift this file exists to stop.
   */
  update(tier: QualityTier, f: AutoTierFrame): AutoTierMove | null {
    const dt = f.dt > 0 && f.dt < 0.5 ? f.dt : 0;

    // Resolution moves first in BOTH directions, and that ordering is measured
    // rather than assumed: `AUTO_DEMOTE_MS` sits above the scaler's `DROP_MS`,
    // so a device in trouble gives up pixels before it gives up the picture.
    // See the note on `AUTO_DEMOTE_MS` for the paired A/B that settled it.
    const inTrouble = f.costMs > AUTO_DEMOTE_MS && f.atMinScale;
    // A device short of frames spends its time BELOW the scaler's ceiling, so
    // `atCeiling` is what stops a machine that only looks fast because it is
    // drawing a quarter of the pixels from asking for the post chain as well.
    const comfortable = f.costMs < AUTO_PROMOTE_MS && f.atCeiling;

    this.troubleFor = inTrouble ? this.troubleFor + dt : 0;
    this.comfortableFor = comfortable ? this.comfortableFor + dt : 0;

    if (this.troubleFor >= AUTO_VERDICT_S) {
      const to = tierBelow(tier);
      // Already at the floor. Clear the clock so the next six seconds of
      // trouble are measured fresh rather than firing on the same evidence.
      if (!to) { this.troubleFor = 0; return null; }
      const evidenceS = this.troubleFor;
      const n = ++this.demotions[tier];
      const latched = n >= AUTO_LATCH_AFTER_DEMOTIONS;
      if (latched && (this.latched === null || tierRank(tier) < tierRank(this.latched))) {
        this.latched = tier;
      }
      if (tierRank(to) < tierRank(this.peak)) this.reduced = true;
      this.comfortableFor = 0;
      this.troubleFor = 0;
      return { dir: 'down', from: tier, to, latched, evidenceS, restored: false };
    }

    const to = tierAbove(tier);
    if (!to) return null;
    if (this.latched !== null && tierRank(to) >= tierRank(this.latched)) return null;
    if (this.comfortableFor < this.promoteAfterS(to)) return null;

    const evidenceS = this.comfortableFor;
    this.comfortableFor = 0;
    this.troubleFor = 0;
    const restored = this.reduced && tierRank(to) >= tierRank(this.peak);
    if (restored) this.reduced = false;
    if (tierRank(to) > tierRank(this.peak)) this.peak = to;
    return { dir: 'up', from: tier, to, latched: false, evidenceS, restored };
  }
}

/** One line for the player, or null when the move is not worth interrupting for. */
export interface TierNotice { text: string; hint: string }

/**
 * WHAT THE PLAYER IS TOLD. Issue #73's third requirement.
 *
 * The half of this defect that made it read as the game being broken rather
 * than the game adapting is that **nothing said it had happened**. The picture
 * got worse mid-session, stayed worse, and the only evidence was on the Video
 * tab under a heading nobody had a reason to open.
 *
 * A promotion is announced only when it puts the player back where they were,
 * because "graphics increased" is not news and the first promotion of a
 * session is auto doing its job quietly, which is the whole design.
 */
export function tierNoticeFor(m: AutoTierMove): TierNotice | null {
  if (m.dir === 'down') {
    return {
      text: `Graphics reduced to ${TIER_LABEL[m.to]} to keep the frame rate`,
      hint: m.latched
        ? 'Set it yourself in Menu ▸ Settings ▸ Video.'
        : 'It will go back up on its own — or set it in Menu ▸ Settings ▸ Video.',
    };
  }
  return m.restored
    ? { text: `Graphics back to ${TIER_LABEL[m.to]}`, hint: '' }
    : null;
}
