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
 * v1.10.1: in an ONLINE match the same watchdog also runs for a player who picked a fixed tier (average frame time > 22 ms for
 * 3 s): it lowers the effective tier by one level through a per-match ceiling (`lowerForSession`) that is never persisted and
 * ends with the match.
 *
 * Persistence: `localStorage['gk-quality']` = `'auto'|'low'|'medium'|'high'`.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export type QualitySetting = 'auto' | QualityTier;

export const QUALITY_STORAGE_KEY = 'gk-quality';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];

/**
 * Why the effective tier changed: `'user'` = the player picked a setting; `'auto'` = the game lowered it by itself (the 'auto'
 * setting's frame-rate watchdog, or the online-match watchdog; v1.10.1).
 */
export type QualityChangeReason = 'user' | 'auto';

/** Listener: receives the effective tier, the user-facing setting and (v1.10.1) why it changed. */
export type QualityListener = (tier: QualityTier, setting: QualitySetting, reason?: QualityChangeReason) => void;

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
/**
 * v1.10.1: per-MATCH ceiling set by the online-match watchdog (`lowerForSession`) for a player whose setting is a fixed tier.
 * It is never stored: it ends with the match (`clearSessionCap`) or as soon as the player picks a setting themselves.
 */
let sessionCap: QualityTier | null = null;
let version = 0;
const listeners = new Set<QualityListener>();

const TIER_RANK: Readonly<Record<QualityTier, number>> = { low: 0, medium: 1, high: 2 };

/** The lower of two tiers. */
export function minTier(a: QualityTier, b: QualityTier): QualityTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

function effective(): QualityTier {
  const base = setting === 'auto' ? autoTier : setting;
  return sessionCap === null ? base : minTier(base, sessionCap);
}

function notify(reason: QualityChangeReason = 'user'): void {
  version++;
  const t = effective();
  for (const fn of listeners) fn(t, setting, reason);
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
  if (next === setting && sessionCap === null) return;
  const before = effective();
  setting = next;
  sessionCap = null; // the player has chosen: their choice wins over the online watchdog's ceiling
  if (effective() !== before) notify('user');
  else version++;
}

/**
 * Auto-mode downgrade by one tier (SceneManager calls this). Returns true if
 * the effective tier changed. No-op when the setting is a fixed tier.
 */
export function autoDowngrade(): boolean {
  if (setting !== 'auto' || autoTier === 'low') return false;
  autoTier = autoTier === 'high' ? 'medium' : 'low';
  notify('auto');
  return true;
}

/**
 * v1.10.1: lower the EFFECTIVE tier by one level for the rest of the current match (online matches whose player picked a fixed
 * tier; the 'auto' setting uses {@link autoDowngrade}). Nothing is persisted and the setting itself is untouched. Returns true if
 * the tier changed (false when it is already 'low').
 */
export function lowerForSession(): boolean {
  const now = effective();
  if (now === 'low') return false;
  sessionCap = now === 'high' ? 'medium' : 'low';
  notify('auto');
  return true;
}

/** Drop the per-match ceiling (the match is over). Notifies only if the effective tier actually changes. */
export function clearSessionCap(): void {
  if (sessionCap === null) return;
  const before = effective();
  sessionCap = null;
  if (effective() !== before) notify('user');
  else version++;
}

/** The per-match ceiling set by {@link lowerForSession}, or null. */
export function getSessionCap(): QualityTier | null {
  return sessionCap;
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
