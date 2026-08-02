import type { CareerState } from './CareerState';
import { decode, encode, type LoadResult } from './SaveCodec';
import {
  DEFAULT_AI_DIFFICULTY, toDifficultyId, type AIDifficultyId,
} from '../ai/AIVehicleController';
import {
  DEFAULT_GAMEPAD_SETTINGS, normaliseGamepadSettings, type GamepadSettings,
} from '../input/GamepadProfile';
import { DEFAULT_WEEKEND_OPTIONS, type WeekendOptions } from '../race/WeekendFormat';

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
/**
 * Re-exported so callers do not need to know that versioning lives in the codec.
 * See `src/career/SaveCodec.ts` for what a version actually means here.
 */
export { SAVE_VERSION as CURRENT_SAVE_VERSION } from './CareerState';

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
  /**
   * Controller bindings, calibration and tuning, keyed by device.
   *
   * Per-device rather than global because a calibration is a property of the
   * hardware, not of the player: the wheel's throttle rests at +1 and the pad's
   * rests at 0, and a single shared profile would mean plugging one in silently
   * destroyed the other's setup.
   */
  gamepad: GamepadSettings;
  /**
   * How long a race weekend runs.
   *
   * Kept in settings rather than in the career save because it is a preference
   * about the player's evening, not a fact about their championship — someone
   * who has half an hour tonight and three hours on Sunday wants the same career
   * at two different lengths, and re-picking it at every round would be the
   * thing they complain about next.
   */
  weekend: WeekendOptions;
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
  // Copied rather than shared: DEFAULT_SETTINGS is spread into a live settings
  // object, and a shared `profiles` map would let one career's controller
  // configuration leak into the defaults every other one starts from.
  gamepad: { ...DEFAULT_GAMEPAD_SETTINGS, profiles: {} },
  weekend: { ...DEFAULT_WEEKEND_OPTIONS },
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
    const ok = writeRaw(STORAGE_PREFIX + id, encode(state));

    const info: SaveSlotInfo = {
      id,
      driverName: state.player.firstName + ' ' + state.player.lastName,
      tier: state.tier,
      seasonYear: state.season?.year ?? 0,
      round: state.season?.tiers?.[state.tier]?.round ?? 0,
      savedAt: new Date().toISOString(),
    };

    const list = this.listSaves().filter((s) => s.id !== id);
    list.unshift(info);
    // Keep the index small; a handful of careers is plenty and the quota is not.
    this.writeIndex(list.slice(0, 12));
    return ok;
  }

  /**
   * Loads a career, with the reason attached when it cannot be loaded.
   *
   * The reason matters. "This save was written by a newer build" and "this file
   * is not a save at all" want completely different things said to the player,
   * and the previous version of this returned `null` for both — so the only
   * message the game could show was the unhelpful one.
   */
  loadResult(id: string): LoadResult {
    return decode(readRaw(STORAGE_PREFIX + id));
  }

  /** Loads a career, or null. The convenience form, for callers with nothing to say. */
  load(id: string): CareerState | null {
    const r = this.loadResult(id);
    return r.ok ? r.state : null;
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
    if (!raw) return { ...DEFAULT_SETTINGS, gamepad: { ...DEFAULT_GAMEPAD_SETTINGS, profiles: {} } };
    try {
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      // Merged over the defaults so a setting added in a later build gets a
      // sensible value instead of undefined.
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      // The difficulty used to be stored as a bare number. Coerce whatever is
      // on disk to a valid level rather than letting a stale 0.85 reach the AI
      // and index the difficulty table with a miss.
      merged.aiDifficulty = toDifficultyId(parsed.aiDifficulty as unknown);
      // The controller configuration is nested, so the shallow merge above
      // would hand back whatever shape happened to be on disk — including a
      // profile from an older build with a missing field, or a hand-edited one
      // with a NaN deadzone. A NaN reaching the steering maths produces a car
      // that will not turn and gives the player no way to find out why.
      merged.gamepad = normaliseGamepadSettings(parsed.gamepad);
      // Same reasoning for the weekend options: a save written before they
      // existed has no `weekend` key at all, and one written by a build with
      // fewer fields in it would leave the new ones undefined — which reaches
      // `raceLapsFor` as NaN and produces a race of NaN laps.
      merged.weekend = { ...DEFAULT_WEEKEND_OPTIONS, ...(parsed.weekend ?? {}) };
      return merged;
    } catch {
      return {
        ...DEFAULT_SETTINGS,
        gamepad: { ...DEFAULT_GAMEPAD_SETTINGS, profiles: {} },
        weekend: { ...DEFAULT_WEEKEND_OPTIONS },
      };
    }
  }

  saveSettings(settings: GameSettings): void {
    writeRaw(SETTINGS_KEY, JSON.stringify(settings));
  }

  /** Exports a career as a downloadable JSON string. */
  exportSave(state: CareerState): string {
    return JSON.stringify(JSON.parse(encode(state)), null, 2);
  }

  /** Imports a career from JSON text. */
  importSave(text: string): CareerState | null {
    const r = decode(text);
    return r.ok ? r.state : null;
  }
}
