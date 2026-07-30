import type { CareerState } from './CareerEngine';
import {
  DEFAULT_AI_DIFFICULTY, toDifficultyId, type AIDifficultyId,
} from '../ai/AIVehicleController';

/**
 * Local persistence.
 *
 * Careers are stored as JSON in localStorage. No server, no account, no network
 * call — the save is on the device, which is what the design asked for and also
 * means the game works offline on a phone in a tunnel.
 *
 * Two things this handles that a naive `JSON.stringify` into localStorage does not:
 *
 *  1. VERSIONING. A save written by an older build must either migrate or be
 *     rejected cleanly. Silently loading a save whose shape has changed produces
 *     undefined fields deep inside the career and corrupts it slowly.
 *
 *  2. QUOTA AND PRIVATE BROWSING. localStorage throws on write in Safari private
 *     mode and when the quota is exceeded. Every access is guarded, and the game
 *     degrades to an in-memory career rather than crashing mid-season.
 */

const STORAGE_PREFIX = 'f1sim.career.';
const INDEX_KEY = 'f1sim.saves';
const SETTINGS_KEY = 'f1sim.settings';
export const CURRENT_SAVE_VERSION = 1;

export interface SaveSlotInfo {
  id: string;
  driverName: string;
  tier: string;
  seasonYear: number;
  round: number;
  savedAt: string;
}

export interface GameSettings {
  masterVolume: number;
  cameraMode: string;
  speedSensitiveSteering: boolean;
  tractionAssist: boolean;
  brakingAssist: boolean;
  tiltSteering: boolean;
  quality: 'auto' | 'low' | 'high';
  /** Draw the optimal line on the track, coloured by approach speed. */
  racingLine: boolean;
  /**
   * How hard the AI field is to race against.
   *
   * Was a bare number that nothing read, so every field was the same field. It
   * is now a named level, and `toDifficultyId` maps an old numeric save onto
   * the nearest one so a career in progress keeps roughly the opposition it was
   * being played against.
   */
  aiDifficulty: AIDifficultyId;
}

export const DEFAULT_SETTINGS: GameSettings = {
  masterVolume: 0.7,
  cameraMode: 'chase',
  speedSensitiveSteering: true,
  tractionAssist: false,
  brakingAssist: false,
  tiltSteering: false,
  quality: 'auto',
  racingLine: true,
  aiDifficulty: DEFAULT_AI_DIFFICULTY,
};

/** True when localStorage is usable. Probed once. */
let storageAvailable: boolean | null = null;

function hasStorage(): boolean {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = '__f1sim_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    // Safari private browsing, a disabled-storage policy, or a full quota.
    storageAvailable = false;
  }
  return storageAvailable;
}

/** In-memory fallback so a career still works without storage. */
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  if (hasStorage()) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, value: string): boolean {
  memory.set(key, value);
  if (!hasStorage()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Quota exceeded. The in-memory copy above keeps this session working.
    return false;
  }
}

function removeRaw(key: string): void {
  memory.delete(key);
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing useful to do; the in-memory copy is already gone.
  }
}

export class SaveManager {
  /** True when saves are only in memory and will be lost on reload. */
  get isEphemeral(): boolean {
    return !hasStorage();
  }

  listSaves(): SaveSlotInfo[] {
    const raw = readRaw(INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as SaveSlotInfo[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: SaveSlotInfo[]): void {
    writeRaw(INDEX_KEY, JSON.stringify(list));
  }

  /** Writes a career and updates the index. Returns false if only in memory. */
  save(id: string, state: CareerState): boolean {
    state.saveVersion = CURRENT_SAVE_VERSION;
    const ok = writeRaw(STORAGE_PREFIX + id, JSON.stringify(state));

    const info: SaveSlotInfo = {
      id,
      driverName: state.player.firstName + ' ' + state.player.lastName,
      tier: state.tier,
      seasonYear: state.seasonYear,
      round: state.round,
      savedAt: new Date().toISOString(),
    };

    const list = this.listSaves().filter((s) => s.id !== id);
    list.unshift(info);
    // Keep the index small; a handful of careers is plenty and the quota is not.
    this.writeIndex(list.slice(0, 12));
    return ok;
  }

  /**
   * Loads a career.
   * Returns null when the slot is missing, unparseable, or from a future version.
   */
  load(id: string): CareerState | null {
    const raw = readRaw(STORAGE_PREFIX + id);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isCareerStateShape(parsed)) return null;
    const state = parsed as CareerState;

    if (state.saveVersion > CURRENT_SAVE_VERSION) {
      // A save from a newer build. Refusing is correct: loading it would
      // silently drop fields this build does not know about.
      return null;
    }
    if (state.saveVersion < CURRENT_SAVE_VERSION) {
      migrate(state);
    }

    return state;
  }

  deleteSave(id: string): void {
    removeRaw(STORAGE_PREFIX + id);
    this.writeIndex(this.listSaves().filter((s) => s.id !== id));
  }

  /** Most recently saved career, for a Continue button. */
  mostRecent(): SaveSlotInfo | null {
    const list = this.listSaves();
    return list.length > 0 ? list[0] : null;
  }

  loadSettings(): GameSettings {
    const raw = readRaw(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      // Merged over the defaults so a setting added in a later build gets a
      // sensible value instead of undefined.
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      // The difficulty used to be stored as a bare number. Coerce whatever is
      // on disk to a valid level rather than letting a stale 0.85 reach the AI
      // and index the difficulty table with a miss.
      merged.aiDifficulty = toDifficultyId(parsed.aiDifficulty as unknown);
      return merged;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(settings: GameSettings): void {
    writeRaw(SETTINGS_KEY, JSON.stringify(settings));
  }

  /** Exports a career as a downloadable JSON string. */
  exportSave(state: CareerState): string {
    return JSON.stringify(state, null, 2);
  }

  /** Imports a career from JSON text. Returns null if it is not valid. */
  importSave(text: string): CareerState | null {
    try {
      const parsed = JSON.parse(text);
      if (!isCareerStateShape(parsed)) return null;
      const state = parsed as CareerState;
      if (state.saveVersion > CURRENT_SAVE_VERSION) return null;
      if (state.saveVersion < CURRENT_SAVE_VERSION) migrate(state);
      return state;
    } catch {
      return null;
    }
  }
}

/**
 * Structural check on a parsed save.
 *
 * Deliberately checks the fields the game will immediately dereference rather than
 * validating everything: the goal is to reject a corrupt or foreign file before it
 * causes a crash deep in the UI, not to be a schema validator.
 */
function isCareerStateShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.saveVersion !== 'number') return false;
  if (typeof o.tier !== 'string') return false;
  if (typeof o.teamId !== 'string') return false;
  if (typeof o.round !== 'number') return false;
  if (typeof o.player !== 'object' || o.player === null) return false;
  const p = o.player as Record<string, unknown>;
  if (typeof p.firstName !== 'string' || typeof p.skill !== 'number') return false;
  if (!Array.isArray(o.standings)) return false;
  return true;
}

/**
 * Brings an older save up to the current version.
 * Each step is written to be idempotent so a very old save can walk forward.
 */
function migrate(state: CareerState): void {
  // No migrations yet — version 1 is the first shipped format. The hook exists so
  // that when the shape changes, old careers survive rather than being discarded.
  state.saveVersion = CURRENT_SAVE_VERSION;

  // Defensive backfills for fields that could be missing in a hand-edited save.
  state.flags ??= {};
  state.staff ??= [];
  state.rivalries ??= [];
  state.titles ??= [];
  state.firedEvents ??= [];
  state.results ??= [];
  state.constructorPoints ??= {};
}
