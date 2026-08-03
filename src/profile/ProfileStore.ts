import { coerceHelmet, defaultHelmet, driverCode, type HelmetDesign } from '../career/Identity';
import type { CareerState } from '../career/CareerState';
import { SaveManager, type SaveSlotInfo } from '../career/SaveManager';
import { sortedStandings } from '../career/Season';

/**
 * WHO IS PLAYING — the one module that answers it.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * The game greeted its player by name and had no idea who they were. "Preet
 * Karia" was a string typed into a career-creation form eighteen months of
 * play ago, written into a career save, and read back out onto the front page —
 * so the front page looked like a signed-in account and was nothing of the
 * kind. There was no way to be somebody else, no way to have two runs at the
 * ladder, and nothing to sign out of. The player's question was exactly right:
 *
 *   "rn it seems that i am logging in with Preet Karia somehow, but in the
 *    future how would we do that... do I need to logout someway or some form?"
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 *
 * A PROFILE is a driver: a name, a nationality, a race number and a helmet.
 * It is the thing the front end greets, and it is the thing you switch between.
 *
 * A CAREER is a run at the ladder made by a profile. A profile owns zero or
 * more of them; `SaveManager` still owns their bytes, because that class
 * already versions, migrates and quota-guards a career and none of that should
 * be reimplemented here. This module owns the INDEX: who exists, who is
 * playing, which careers are whose, and what each of those careers has
 * achieved.
 *
 * THERE IS NO ACCOUNT AND THIS MODULE DOES NOT PRETEND THERE IS. Nothing here
 * authenticates anything, nothing leaves the device, and the interface built on
 * top of it says so in those words. "Sign out" is a lie in a game with no
 * server; "switch driver" and "delete driver" are the true operations and they
 * are the ones offered.
 *
 * ---------------------------------------------------------------------------
 * ROOM FOR A SERVER LATER, WITHOUT A REWRITE
 * ---------------------------------------------------------------------------
 *
 * Everything the interface knows about identity comes through this class, and
 * the interface never touches `localStorage`. That is the whole design
 * requirement: the day there is an account behind this, `ProfileDriver` below
 * gets a second implementation that talks to it, the index gains a `remoteId`,
 * and not one screen changes.
 *
 * The API is deliberately SYNCHRONOUS. A remote store would sync in the
 * background and serve the last-known index immediately, which is what a game
 * front end needs anyway — a menu that cannot draw until the network answers is
 * a worse menu than one that draws instantly and reconciles.
 */

// ===========================================================================
// The shapes
// ===========================================================================

/** What a career has achieved, as the front end reports it. */
export interface CareerRecord {
  /** Championship rounds this career has actually classified in. */
  starts: number;
  wins: number;
  podiums: number;
  poles: number;
  /** Best finishing position, or 0 when nothing has been finished yet. */
  bestFinish: number;
  /** Championships won, across every season of this career. */
  titles: number;
}

const BLANK_RECORD: CareerRecord = {
  starts: 0, wins: 0, podiums: 0, poles: 0, bestFinish: 0, titles: 0,
};

/**
 * A career, as the front end lists it.
 *
 * A SUMMARY RATHER THAN THE CAREER. The menu needs a name, a tier and a round;
 * decoding eleven seasons of results to draw a button would be absurd, and
 * `SaveManager` already keeps an index for exactly this reason. What this adds
 * is the record, which the slot index does not carry.
 */
export interface CareerSummary {
  /** The `SaveManager` slot id. */
  id: string;
  tier: string;
  seasonYear: number;
  /** Round the career is on, zero-based, as the season counts it. */
  round: number;
  savedAt: string;
  record: CareerRecord;
}

export interface DriverProfile {
  id: string;
  firstName: string;
  lastName: string;
  /** The three letters on the timing tower. Derived, kept for display. */
  code: string;
  nationality: string;
  raceNumber: number;
  helmet: HelmetDesign;
  createdAt: string;
  lastPlayedAt: string;
  /**
   * Whether this driver has been shown the opening titles.
   *
   * PER PROFILE rather than per browser, which is the change that made the
   * sequence reachable at all: the old flag was global and set once in 2026, so
   * every driver created afterwards — on a machine that had ever run the game —
   * was skipped past the one piece of cinema in it.
   */
  introSeen: boolean;
  /** Careers this driver has run, most recently played first. */
  careers: CareerSummary[];
}

/** Everything on disk, under one key. */
interface ProfileIndex {
  version: number;
  activeId: string | null;
  profiles: DriverProfile[];
}

const INDEX_VERSION = 1;
const INDEX_KEY = 'f1sim.profiles';

/**
 * The bytes underneath.
 *
 * Named and injectable so a test can run without a browser and so a remote
 * backend has an obvious seam to arrive at. `SaveManager` has its own copy of
 * this reasoning for career bytes; the duplication is two dozen lines and is
 * cheaper than coupling the two indexes together.
 */
export interface ProfileDriver {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  /** False when writes will not survive a reload — private browsing, no quota. */
  readonly durable: boolean;
}

class LocalStorageDriver implements ProfileDriver {
  private readonly memory = new Map<string, string>();
  private probed: boolean | null = null;

  get durable(): boolean {
    if (this.probed !== null) return this.probed;
    try {
      const probe = '__f1sim_profile_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      this.probed = true;
    } catch {
      // Safari private browsing, a storage policy, a full quota, or no `window`
      // at all — which is the case in the probes, and they must still run.
      this.probed = false;
    }
    return this.probed;
  }

  read(key: string): string | null {
    if (this.durable) {
      try { return window.localStorage.getItem(key); } catch { /* fall through */ }
    }
    return this.memory.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.memory.set(key, value);
    if (!this.durable) return;
    try { window.localStorage.setItem(key, value); } catch { /* memory holds it */ }
  }

  remove(key: string): void {
    this.memory.delete(key);
    if (!this.durable) return;
    try { window.localStorage.removeItem(key); } catch { /* already gone */ }
  }
}

/** An entirely in-memory driver, for probes and for `?fresh=1`. */
export class MemoryDriver implements ProfileDriver {
  private readonly map = new Map<string, string>();
  readonly durable = false;
  read(key: string): string | null { return this.map.get(key) ?? null; }
  write(key: string, value: string): void { this.map.set(key, value); }
  remove(key: string): void { this.map.delete(key); }
}

// ===========================================================================
// The store
// ===========================================================================

export interface ProfileStoreOptions {
  saves?: SaveManager;
  driver?: ProfileDriver;
  /** Clock, so a probe can make deterministic timestamps. */
  now?: () => Date;
}

export class ProfileStore {
  private readonly saves: SaveManager;
  private readonly driver: ProfileDriver;
  private readonly now: () => Date;
  private index: ProfileIndex;

  constructor(opts: ProfileStoreOptions = {}) {
    this.saves = opts.saves ?? new SaveManager();
    this.driver = opts.driver ?? new LocalStorageDriver();
    this.now = opts.now ?? (() => new Date());
    this.index = this.read();
  }

  /** True when nothing written here will survive a reload. */
  get isEphemeral(): boolean {
    return !this.driver.durable;
  }

  /** True on a genuinely first run: no driver has ever been made here. */
  get isFirstRun(): boolean {
    return this.index.profiles.length === 0;
  }

  list(): DriverProfile[] {
    // Most recently played first, which is the order a rack of drivers wants to
    // be in — the one you are using is the one you are looking for.
    return [...this.index.profiles].sort(
      (a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt));
  }

  get active(): DriverProfile | null {
    const id = this.index.activeId;
    if (!id) return null;
    return this.index.profiles.find((p) => p.id === id) ?? null;
  }

  get(id: string): DriverProfile | null {
    return this.index.profiles.find((p) => p.id === id) ?? null;
  }

  /**
   * Makes a driver and switches to them.
   *
   * The code is derived here rather than taken from the caller so that there is
   * exactly one derivation of it in the game — `Identity.driverCode` — and the
   * profile can never disagree with the timing tower.
   */
  create(id: {
    firstName: string; lastName: string; nationality: string;
    raceNumber: number; helmet?: HelmetDesign;
  }): DriverProfile {
    const stamp = this.now().toISOString();
    const seed = (Math.random() * 0x7fffffff) | 0;
    const profile: DriverProfile = {
      id: 'driver-' + this.now().getTime().toString(36) + '-'
        + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0'),
      firstName: id.firstName.trim() || 'Alex',
      lastName: id.lastName.trim() || 'Carter',
      code: driverCode(id.lastName.trim() || 'Carter'),
      nationality: id.nationality,
      raceNumber: id.raceNumber,
      helmet: id.helmet ? { ...id.helmet } : defaultHelmet(seed),
      createdAt: stamp,
      lastPlayedAt: stamp,
      // A driver made on a machine that has already watched the titles does not
      // watch them again. A driver made on a fresh one does.
      introSeen: false,
      careers: [],
    };
    this.index.profiles.push(profile);
    this.index.activeId = profile.id;
    this.write();
    return profile;
  }

  /** Edits the active driver in place. Anything omitted is left alone. */
  update(id: string, patch: Partial<Omit<DriverProfile, 'id' | 'careers'>>): DriverProfile | null {
    const p = this.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    if (patch.lastName !== undefined) p.code = driverCode(patch.lastName || p.lastName);
    if (patch.helmet) p.helmet = { ...patch.helmet };
    this.write();
    return p;
  }

  /** Makes a driver the one who is playing. */
  setActive(id: string): DriverProfile | null {
    const p = this.get(id);
    if (!p) return null;
    this.index.activeId = id;
    p.lastPlayedAt = this.now().toISOString();
    this.write();
    return p;
  }

  /**
   * Removes a driver AND every career they ran.
   *
   * Deleting the profile and orphaning the saves would leave a career on the
   * device belonging to nobody, taking quota, and reachable by no screen. If
   * the player says delete, it is deleted.
   */
  remove(id: string): void {
    const p = this.get(id);
    if (!p) return;
    for (const c of p.careers) this.saves.deleteSave(c.id);
    this.index.profiles = this.index.profiles.filter((x) => x.id !== id);
    if (this.index.activeId === id) {
      this.index.activeId = this.list()[0]?.id ?? null;
    }
    this.write();
  }

  /** Wipes every driver and every career. The "start again" button. */
  removeAll(): void {
    for (const p of this.index.profiles) {
      for (const c of p.careers) this.saves.deleteSave(c.id);
    }
    this.index = { version: INDEX_VERSION, activeId: null, profiles: [] };
    this.write();
  }

  /** Marks the titles as watched by this driver. */
  noteIntroSeen(id: string): void {
    const p = this.get(id);
    if (!p || p.introSeen) return;
    p.introSeen = true;
    this.write();
  }

  // -----------------------------------------------------------------------
  // Careers
  // -----------------------------------------------------------------------

  /** The career the active driver was last playing, or null. */
  currentCareer(): CareerSummary | null {
    return this.active?.careers[0] ?? null;
  }

  /**
   * Writes a career to disk and files it under the driver who is playing.
   *
   * THE ONE PLACE A CAREER IS SAVED from the front end, so the profile index
   * and the save index cannot drift apart. `SaveManager.save` is still what
   * writes the bytes.
   */
  saveCareer(careerId: string, state: CareerState): boolean {
    const ok = this.saves.save(careerId, state);
    const p = this.active;
    if (p) {
      const summary = summarise(careerId, state, this.now().toISOString());
      p.careers = [summary, ...p.careers.filter((c) => c.id !== careerId)];
      p.lastPlayedAt = summary.savedAt;
      // The driver IS the career's driver. Renaming yourself in the signing
      // screen renames the profile, which is what makes the two one thing
      // rather than two names that happen to match.
      p.firstName = state.player.firstName;
      p.lastName = state.player.lastName;
      p.code = state.player.code || driverCode(state.player.lastName);
      p.nationality = state.player.nationality;
      p.raceNumber = state.player.raceNumber;
      if (state.player.helmet) p.helmet = coerceHelmet(state.player.helmet, state.seed);
      this.write();
    }
    return ok;
  }

  /** Notes that a career was opened, so Continue points at the right one. */
  touchCareer(careerId: string): void {
    const p = this.active;
    if (!p) return;
    const found = p.careers.find((c) => c.id === careerId);
    if (!found) return;
    found.savedAt = this.now().toISOString();
    p.careers = [found, ...p.careers.filter((c) => c.id !== careerId)];
    p.lastPlayedAt = found.savedAt;
    this.write();
  }

  removeCareer(careerId: string): void {
    this.saves.deleteSave(careerId);
    for (const p of this.index.profiles) {
      p.careers = p.careers.filter((c) => c.id !== careerId);
    }
    this.write();
  }

  /** The career bytes, with the reason attached when they will not load. */
  loadCareer(careerId: string): ReturnType<SaveManager['loadResult']> {
    return this.saves.loadResult(careerId);
  }

  /** Everything the active driver has done, summed over their careers. */
  record(id?: string): CareerRecord {
    const p = id ? this.get(id) : this.active;
    if (!p) return { ...BLANK_RECORD };
    const out: CareerRecord = { ...BLANK_RECORD };
    for (const c of p.careers) {
      out.starts += c.record.starts;
      out.wins += c.record.wins;
      out.podiums += c.record.podiums;
      out.poles += c.record.poles;
      out.titles += c.record.titles;
      if (c.record.bestFinish > 0) {
        out.bestFinish = out.bestFinish === 0
          ? c.record.bestFinish : Math.min(out.bestFinish, c.record.bestFinish);
      }
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // Disk
  // -----------------------------------------------------------------------

  private read(): ProfileIndex {
    const raw = this.driver.read(INDEX_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ProfileIndex>;
        if (Array.isArray(parsed.profiles)) {
          return {
            version: INDEX_VERSION,
            activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
            profiles: parsed.profiles.map(coerceProfile),
          };
        }
      } catch {
        // A corrupt index must not lock somebody out of a game whose careers
        // are all still perfectly readable. Fall through and rebuild it from
        // the saves, which is the same path a pre-profiles install takes.
      }
    }
    return this.adopt();
  }

  /**
   * Builds the index from careers that already exist.
   *
   * THE UPGRADE PATH, and the reason it is not a migration script: every
   * install before this module had careers and no profiles, and the person
   * playing them must open the game to find their driver already there rather
   * than to find an empty rack and a create form. One profile per career,
   * named by that career, holding that career.
   */
  private adopt(): ProfileIndex {
    const index: ProfileIndex = { version: INDEX_VERSION, activeId: null, profiles: [] };
    let slots: SaveSlotInfo[] = [];
    try {
      slots = this.saves.listSaves();
    } catch {
      slots = [];
    }
    for (const slot of slots) {
      const result = this.saves.loadResult(slot.id);
      if (!result.ok) continue;
      const state = result.state;
      const profile: DriverProfile = {
        id: 'driver-' + slot.id,
        firstName: state.player.firstName,
        lastName: state.player.lastName,
        code: state.player.code || driverCode(state.player.lastName),
        nationality: state.player.nationality,
        raceNumber: state.player.raceNumber,
        helmet: coerceHelmet(state.player.helmet, state.seed),
        createdAt: slot.savedAt,
        lastPlayedAt: slot.savedAt,
        // They have been playing for months; they are not owed a title card.
        introSeen: true,
        careers: [summarise(slot.id, state, slot.savedAt)],
      };
      index.profiles.push(profile);
    }
    // `listSaves` is already most-recent-first, so the first adopted driver is
    // the one who was playing.
    index.activeId = index.profiles[0]?.id ?? null;
    if (index.profiles.length > 0) {
      this.driver.write(INDEX_KEY, JSON.stringify(index));
    }
    return index;
  }

  private write(): void {
    this.index.version = INDEX_VERSION;
    this.driver.write(INDEX_KEY, JSON.stringify(this.index));
  }
}

// ===========================================================================
// Derivations
// ===========================================================================

/**
 * A career's record, computed from the career itself.
 *
 * DERIVED, NOT ACCUMULATED. A counter incremented at the moment a race finishes
 * drifts the first time a save is loaded twice, a race is replayed, or a season
 * is rolled back — and the front end would then be quietly lying about the one
 * thing it exists to be proud of. Recomputing costs a pass over one season's
 * standings and the history array, which is nothing, and it cannot drift.
 *
 * Wins, podiums and poles from seasons already finished are NOT in the save —
 * `SeasonSummary` keeps the champion, the player's position and their points,
 * and nothing else. So those three are this season's, `titles` is every
 * season's, and the interface says "this season" where that is what it means.
 */
function recordOf(state: CareerState): CareerRecord {
  const tier = state.tier;
  const season = state.season?.tiers?.[tier];
  const me = season
    ? sortedStandings(season).find((e) => e.driverId === state.playerDriverId)
    : undefined;
  const titles = (state.history ?? []).filter(
    (h) => h.playerTier !== null && h.championByTier?.[h.playerTier] === state.playerDriverId,
  ).length;
  const starts = (season?.results ?? []).filter(
    (r) => r.order.includes(state.playerDriverId)).length;
  return {
    starts,
    wins: me?.wins ?? 0,
    podiums: me?.podiums ?? 0,
    poles: me?.poles ?? 0,
    bestFinish: me && me.bestFinish < 99 ? me.bestFinish : 0,
    titles,
  };
}

function summarise(id: string, state: CareerState, savedAt: string): CareerSummary {
  return {
    id,
    tier: state.tier,
    seasonYear: state.season?.year ?? 0,
    round: state.season?.tiers?.[state.tier]?.round ?? 0,
    savedAt,
    record: recordOf(state),
  };
}

/** Normalises whatever came back off disk into a profile that can be drawn. */
function coerceProfile(raw: Partial<DriverProfile>, i: number): DriverProfile {
  const lastName = typeof raw.lastName === 'string' && raw.lastName ? raw.lastName : 'Carter';
  const stamp = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'driver-' + i,
    firstName: typeof raw.firstName === 'string' && raw.firstName ? raw.firstName : 'Alex',
    lastName,
    code: typeof raw.code === 'string' && raw.code.length === 3 ? raw.code : driverCode(lastName),
    nationality: typeof raw.nationality === 'string' ? raw.nationality : 'United Kingdom',
    raceNumber: Number.isFinite(raw.raceNumber) ? Number(raw.raceNumber) : 47,
    helmet: coerceHelmet(raw.helmet, i * 7919 + 13),
    createdAt: stamp,
    lastPlayedAt: typeof raw.lastPlayedAt === 'string' ? raw.lastPlayedAt : stamp,
    introSeen: raw.introSeen === true,
    careers: Array.isArray(raw.careers)
      ? raw.careers.filter((c): c is CareerSummary => !!c && typeof c.id === 'string')
        .map((c) => ({ ...c, record: { ...BLANK_RECORD, ...(c.record ?? {}) } }))
      : [],
  };
}

/** The name a screen prints. One derivation, so no screen invents its own. */
export function profileName(p: DriverProfile): string {
  return p.firstName + ' ' + p.lastName;
}
