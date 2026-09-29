/**
 * Graphics quality tiers (v1.1 WP-K). Module-level so the Settings UI can read
 * and change it with no SceneManager alive (lobby), and every render system
 * (SceneManager, Stadium, Effects, animal rigs) reads the same effective tier.
 *
 *  - `'low'`    — renderer draws directly (no composer), 1× pixel ratio,
 *                 1024 shadow map, no point lights, no outlines, sparse ambience.
 *  - `'medium'` — composer: render → warm grade + vignette → ACES output (no
 *                 bloom), 2 torch point lights, outlines, 1× pixel ratio, 4× MSAA.
 *  - `'high'`   — everything: + UnrealBloom, 4 torch point lights, light
 *                 shafts, full dust motes, ≤1.5× pixel ratio, 4× MSAA target.
 *
 * Setting `'auto'` (default) starts at high; SceneManager samples frame time
 * and drops ONE tier whenever average fps stays < 45 for 3 s. Auto never raises
 * again during the same page session.
 *
 * Persistence: `localStorage['gk-quality']` = `'auto'|'low'|'medium'|'high'`.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type QualitySetting = 'auto' | QualityTier;

export const QUALITY_STORAGE_KEY = 'gk-quality';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];

/** Listener: receives the effective tier and the user-facing setting. */
export type QualityListener = (tier: QualityTier, setting: QualitySetting) => void;

function isSetting(v: unknown): v is QualitySetting {
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high';
}

function readStored(): QualitySetting {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(QUALITY_STORAGE_KEY) : null;
    return isSetting(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let setting: QualitySetting = readStored();
/** Session-scoped auto tier: starts high, only ever lowered. */
let autoTier: QualityTier = 'high';
let version = 0;
const listeners = new Set<QualityListener>();

function effective(): QualityTier {
  return setting === 'auto' ? autoTier : setting;
}

function notify(): void {
  version++;
  const t = effective();
  for (const fn of listeners) fn(t, setting);
}

/** The user-facing setting (`'auto'` or a fixed tier). */
export function getQualitySetting(): QualitySetting {
  return setting;
}

/** The tier actually rendered right now. */
export function getQualityTier(): QualityTier {
  return effective();
}

/** Monotonic counter bumped on every effective change (cheap per-frame polling). */
export function getQualityVersion(): number {
  return version;
}

/** Whether auto mode has already downgraded during this session. */
export function isAutoDowngraded(): boolean {
  return autoTier !== 'high';
}

/**
 * Change the setting (persists to localStorage) and apply it live to every
 * render system. Choosing `'auto'` resumes at the session's auto tier (high
 * unless auto already downgraded this session).
 */
export function setQualitySetting(next: QualitySetting): void {
  if (!isSetting(next)) return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(QUALITY_STORAGE_KEY, next);
  } catch {
    /* storage blocked — setting still applies for this session */
  }
  if (next === setting) return;
  const before = effective();
  setting = next;
  if (effective() !== before) notify();
  else version++;
}

/**
 * Auto-mode downgrade by one tier (SceneManager calls this). Returns true if
 * the effective tier changed. No-op when the setting is a fixed tier.
 */
export function autoDowngrade(): boolean {
  if (setting !== 'auto' || autoTier === 'low') return false;
  autoTier = autoTier === 'high' ? 'medium' : 'low';
  notify();
  return true;
}

/** Subscribe to effective-tier changes. Returns an unsubscribe function. */
export function onQualityChange(fn: QualityListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Per-tier numbers shared by the render systems. */
export interface TierProfile {
  composer: boolean;
  bloom: boolean;
  pixelRatioCap: number;
  msaaSamples: number;
  shadowMapSize: number;
  pointLights: number;
  outlines: boolean;
  lightShafts: boolean;
  dustMotes: number;
  crowdFlags: boolean;
  /** Multiplier on cosmetic particle spawn counts. */
  fxScale: number;
  skyClouds: boolean;
}

const PROFILES: Record<QualityTier, TierProfile> = {
  low: {
    composer: false,
    bloom: false,
    pixelRatioCap: 1,
    msaaSamples: 0,
    shadowMapSize: 1024,
    pointLights: 0,
    outlines: false,
    lightShafts: false,
    dustMotes: 60,
    crowdFlags: false,
    fxScale: 0.6,
    skyClouds: false,
  },
  medium: {
    composer: true,
    bloom: false,
    pixelRatioCap: 1,
    msaaSamples: 4,
    shadowMapSize: 2048,
    pointLights: 2,
    outlines: true,
    lightShafts: true,
    dustMotes: 160,
    crowdFlags: true,
    fxScale: 0.85,
    skyClouds: true,
  },
  high: {
    composer: true,
    bloom: true,
    pixelRatioCap: 1.5,
    msaaSamples: 4,
    shadowMapSize: 2048,
    pointLights: 4,
    outlines: true,
    lightShafts: true,
    dustMotes: 320,
    crowdFlags: true,
    fxScale: 1,
    skyClouds: true,
  },
};

export function tierProfile(tier: QualityTier = effective()): TierProfile {
  return PROFILES[tier];
}
