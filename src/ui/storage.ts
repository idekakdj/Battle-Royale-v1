/**
 * Persisted UI preferences (WP-F). Three localStorage keys (BLUEPRINT §12):
 *  - `gk-settings`   → audio settings ({master, music, sfx, muted}, each 0..1)
 *  - `gk-animal`     → last-selected gladiator (lobby default)
 *  - `gk-difficulty` → last-selected difficulty tier
 *
 * All reads are defensive: corrupt/missing/blocked storage falls back to sane
 * defaults so the UI never throws on boot.
 */

import type { AnimalId, Difficulty } from '../core/types';
import { ANIMAL_IDS } from '../config/animals';

export const SETTINGS_KEY = 'gk-settings';
export const ANIMAL_KEY = 'gk-animal';
export const DIFFICULTY_KEY = 'gk-difficulty';

/** Audio settings, all volumes normalized to 0..1 (BLUEPRINT §12/§13). */
export interface GkSettings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

export const DEFAULT_SETTINGS: GkSettings = { master: 0.8, music: 0.6, sfx: 0.9, muted: false };

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
