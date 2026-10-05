/**
 * Persisted UI preferences (WP-F). The core localStorage keys (BLUEPRINT §12):
 *  - `gk-settings`   → audio settings ({master, music, sfx, muted}, each 0..1)
 *  - `gk-animal`     → last-selected gladiator (lobby default)
 *  - `gk-difficulty` → last-selected difficulty tier
 *  - `gk-mode`       → last-chosen game mode on the PLAY mode-select screen (v1.5.1)
 *
 * All reads are defensive: corrupt/missing/blocked storage falls back to sane
 * defaults so the UI never throws on boot.
 */

import type { AnimalId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';
import { parseBrawlSetup, type BrawlSetupChoice } from '../brawl/ui/setup';

export const SETTINGS_KEY = 'gk-settings';
export const ANIMAL_KEY = 'gk-animal';
export const DIFFICULTY_KEY = 'gk-difficulty';
/** v1.4 Champions League: last setup (fighter, stage, opponents, bot level, stocks, time). */
export const BRAWL_KEY = 'gk-brawl';
/** v1.5.1: last game mode chosen on the mode-select screen (`battleRoyale` | `championsLeague`). */
export const MODE_KEY = 'gk-mode';

/** Audio settings, all volumes normalized to 0..1 (BLUEPRINT §12/§13). */
export interface GkSettings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** Desktop app only: notify-only GitHub update check at launch (WP-L, default on). */
  checkUpdates: boolean;
  /** Mouse look sensitivity in radians per pixel (WP-M; CameraRig's own default). */
  sensitivity: number;
  /** v1.2: faint ground sector showing the player's real basic-attack reach (default on). */
  rangeIndicator: boolean;
  /** v1.3: ready-state ultimate targeting preview (range ring / path / LOCK bracket; default on). */
  ultPreview: boolean;
  // ── v1.3 WP-Q: first-person mode ──
  /** Camera view: `'third'` (default orbit camera) or `'first'` (eye camera). Toggled with V. */
  view: ViewMode;
  /** First-person horizontal field of view in degrees (60–110, default 85). */
  fpFov: number;
  /** Centre crosshair dot in first person (default on). */
  crosshair: boolean;
  /** v1.3.1: FPS counter overlay at the top-right (default off). */
  showFps: boolean;
}

/** Camera view mode (v1.3). */
export type ViewMode = 'third' | 'first';
export const FP_FOV_DEFAULT_SETTING = 85;
export const FP_FOV_MIN_SETTING = 60;
export const FP_FOV_MAX_SETTING = 110;

function clampFpFovSetting(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return FP_FOV_DEFAULT_SETTING;
  return v < FP_FOV_MIN_SETTING ? FP_FOV_MIN_SETTING : v > FP_FOV_MAX_SETTING ? FP_FOV_MAX_SETTING : Math.round(v);
}

/** Matches `CameraRig`'s default `sensitivity` (0.0024 rad/px). */
export const DEFAULT_SENSITIVITY = 0.0024;
/** Settings-slider bounds for {@link GkSettings.sensitivity} (0.25× … 3×). */
export const MIN_SENSITIVITY = DEFAULT_SENSITIVITY * 0.25;
export const MAX_SENSITIVITY = DEFAULT_SENSITIVITY * 3;

export const DEFAULT_SETTINGS: GkSettings = {
  master: 0.8,
  music: 0.6,
  sfx: 0.9,
  muted: false,
  checkUpdates: true,
  sensitivity: DEFAULT_SENSITIVITY,
  rangeIndicator: true,
  ultPreview: true,
  view: 'third',
  fpFov: FP_FOV_DEFAULT_SETTING,
  crosshair: true,
  showFps: false,
};

function clampSensitivity(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SENSITIVITY;
  return v < MIN_SENSITIVITY ? MIN_SENSITIVITY : v > MAX_SENSITIVITY ? MAX_SENSITIVITY : v;
}

/** The default lobby gladiator when nothing is stored yet. */
export const DEFAULT_ANIMAL: AnimalId = 'lion';
/** The default difficulty when nothing is stored yet. */
export const DEFAULT_DIFFICULTY: Difficulty = 2;

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / quota) — preferences just won't persist */
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Load audio settings, clamped and defaulted. Never throws. */
export function loadSettings(): GkSettings {
  const raw = readRaw(SETTINGS_KEY);
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<GkSettings>;
    return {
      master: clamp01(typeof parsed.master === 'number' ? parsed.master : DEFAULT_SETTINGS.master),
      music: clamp01(typeof parsed.music === 'number' ? parsed.music : DEFAULT_SETTINGS.music),
      sfx: clamp01(typeof parsed.sfx === 'number' ? parsed.sfx : DEFAULT_SETTINGS.sfx),
      muted: parsed.muted === true,
      checkUpdates: parsed.checkUpdates !== false,
      sensitivity: clampSensitivity(parsed.sensitivity),
      rangeIndicator: parsed.rangeIndicator !== false,
      ultPreview: parsed.ultPreview !== false,
      view: parsed.view === 'first' ? 'first' : 'third',
      fpFov: clampFpFovSetting(parsed.fpFov),
      crosshair: parsed.crosshair !== false,
      showFps: parsed.showFps === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist audio settings under `gk-settings`. */
export function saveSettings(settings: GkSettings): void {
  writeRaw(SETTINGS_KEY, JSON.stringify(settings));
}

/** Load the last-selected gladiator, validated against the roster. */
export function loadAnimal(): AnimalId {
  const raw = readRaw(ANIMAL_KEY);
  if (raw !== null && (ANIMAL_IDS as readonly string[]).includes(raw)) return raw as AnimalId;
  return DEFAULT_ANIMAL;
}

/** Persist the selected gladiator under `gk-animal`. */
export function saveAnimal(animal: AnimalId): void {
  writeRaw(ANIMAL_KEY, animal);
}

/** Load the last-selected difficulty (1..4), defaulted. */
export function loadDifficulty(): Difficulty {
  const raw = readRaw(DIFFICULTY_KEY);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return DEFAULT_DIFFICULTY;
}

/** Persist the selected difficulty under `gk-difficulty`. */
export function saveDifficulty(difficulty: Difficulty): void {
  writeRaw(DIFFICULTY_KEY, String(difficulty));
}

// ── v1.5.1 mode select (PLAY → Battle Royale | Champions League) ─────────────────────────────────────────────────

/** The two game modes offered by PLAY. */
export type GameMode = 'battleRoyale' | 'championsLeague';
/** Every {@link GameMode}, in the order the mode-select screen shows them. */
export const GAME_MODES: readonly GameMode[] = ['battleRoyale', 'championsLeague'];
/** The pre-focused mode when nothing (valid) is stored yet. */
export const DEFAULT_MODE: GameMode = 'battleRoyale';

/** Validate a raw stored/received mode; anything unknown falls back to {@link DEFAULT_MODE}. */
export function parseMode(raw: unknown): GameMode {
  return raw === 'battleRoyale' || raw === 'championsLeague' ? raw : DEFAULT_MODE;
}

/** The last-chosen game mode (validated; {@link DEFAULT_MODE} when missing, corrupt or storage is blocked). Never throws. */
export function loadMode(): GameMode {
  return parseMode(readRaw(MODE_KEY));
}

/** Persist the chosen game mode under `gk-mode`. */
export function saveMode(mode: GameMode): void {
  writeRaw(MODE_KEY, parseMode(mode));
}

/** v1.4: the last Champions League setup; defensive parsing, `gk-animal` is the default fighter. */
export function loadBrawlSetup(): BrawlSetupChoice {
  return parseBrawlSetup(readRaw(BRAWL_KEY), loadAnimal());
}

/** v1.4: persist the Champions League setup under `gk-brawl`. */
export function saveBrawlSetup(setup: BrawlSetupChoice): void {
  writeRaw(BRAWL_KEY, JSON.stringify(setup));
}

// ── v1.5 online multiplayer: player name, last mode, last online fighter ─────────────────────────────────────────

/** v1.5 online: the display name shown to friends in a room. */
export const ONLINE_NAME_KEY = 'gk-online-name';
/** v1.5 online: the last room mode hosted (`battleRoyale` | `championsLeague`). */
export const ONLINE_MODE_KEY = 'gk-online-mode';
/** v1.5 online: the last fighter used in a room (defaults to the lobby fighter). */
export const ONLINE_ANIMAL_KEY = 'gk-online-animal';
/** Longest online display name (mirrors the room layer's limit, kept here so the main bundle stays free of room code). */
export const ONLINE_NAME_MAX = 16;

export type OnlineModeSetting = GameMode;
export const DEFAULT_ONLINE_MODE: OnlineModeSetting = 'championsLeague';

/** Clean a raw name: control characters dropped, whitespace collapsed and trimmed, at most {@link ONLINE_NAME_MAX} characters. */
export function parseOnlineName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, ONLINE_NAME_MAX).join('').trim();
}

/** Validate a stored online mode; anything unknown falls back to {@link DEFAULT_ONLINE_MODE}. */
export function parseOnlineMode(raw: unknown): OnlineModeSetting {
  return raw === 'battleRoyale' || raw === 'championsLeague' ? raw : DEFAULT_ONLINE_MODE;
}

/** The saved online name ('' when none). Never throws. */
export function loadOnlineName(): string {
  return parseOnlineName(readRaw(ONLINE_NAME_KEY));
}

export function saveOnlineName(name: string): void {
  writeRaw(ONLINE_NAME_KEY, parseOnlineName(name));
}

export function loadOnlineMode(): OnlineModeSetting {
  return parseOnlineMode(readRaw(ONLINE_MODE_KEY));
}

export function saveOnlineMode(mode: OnlineModeSetting): void {
  writeRaw(ONLINE_MODE_KEY, parseOnlineMode(mode));
}

/** The last online fighter, validated; falls back to the lobby fighter (`gk-animal`). */
export function loadOnlineAnimal(): AnimalId {
  const raw = readRaw(ONLINE_ANIMAL_KEY);
  if (raw !== null && (ANIMAL_IDS as readonly string[]).includes(raw)) return raw as AnimalId;
  return loadAnimal();
}

export function saveOnlineAnimal(animal: AnimalId): void {
  writeRaw(ONLINE_ANIMAL_KEY, animal);
}
