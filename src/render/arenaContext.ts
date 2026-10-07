/**
 * Render-side "which arena is on screen" context (v1.8 jungle, WP-J3).
 *
 * Exactly one match renders at a time (same assumption as `render/fxBus.ts`), so the arena the scene was built for lives in
 * one module-level slot. `SceneManager.setArena(def)` / `createArenaScene(...)` fill it; everything that used to read the
 * colosseum constants (CameraRig's wall + pillar pull-in, the first-person eye clamp, the rhino ultimate FX wall, Effects'
 * terrain-aware footsteps, the audio ambience switch) reads the CURRENT arena from here instead. The default is the colosseum,
 * so with nothing ever set every consumer behaves exactly as in v1.7 (same numbers: `COLOSSEUM_ARENA` is built from the
 * unchanged `config/arena.ts` constants).
 *
 * Also hosts the pure terrain helpers the renderer shares (point-in-zone tests, the pool's visual surface profile) and the
 * tiny "water activity" board the audio ambience polls (no import from render into audio is needed beyond this file).
 *
 * Pure data + helpers: no three / DOM imports, so it is node-safe.
 */

import { COLOSSEUM_ARENA, type ArenaDef, type TerrainZoneDef } from '../config/arenas';

// ── The current arena ────────────────────────────────────────────────────────

let current: ArenaDef = COLOSSEUM_ARENA;
let version = 0;

/** Make `def` (default: the colosseum) the arena every render system reads. Idempotent. */
export function setRenderArena(def?: ArenaDef): void {
  const next = def ?? COLOSSEUM_ARENA;
  if (next === current) return;
  current = next;
  version++;
  refreshTerrainCache();
}

/** The arena the scene is (being) built for; the colosseum when nothing was set. */
export function getRenderArena(): ArenaDef {
  return current;
}

/** Bumped whenever {@link setRenderArena} changes the arena (cheap per-frame polling). */
export function getRenderArenaVersion(): number {
  return version;
}

// ── Terrain helpers ──────────────────────────────────────────────────────────

/** Visual width (m) of the pool's sloping bank: the pool floor drops from the shoreline to full depth over this distance. */
export const POOL_BANK_WIDTH = 0.9;

/**
 * World height (m) of the pool's water surface: a hair BELOW the ground rim (y = 0), so the wet-stone lip stands proud of the
 * water. The sim's ground is flat (y = 0) everywhere, so the pool is a sunk basin: its floor lies up to `depth` (0.55 m) below
 * the rim and the swimming rigs lower themselves into it (`render/animals/swim.ts`, default `poolLevel.surfaceY` = 0).
 */
export const POOL_SURFACE_Y = -0.04;

let waterZones: TerrainZoneDef[] = [];
let mossZones: TerrainZoneDef[] = [];

function refreshTerrainCache(): void {
  waterZones = current.terrain.filter((z) => z.kind === 'water');
  mossZones = current.terrain.filter((z) => z.kind === 'moss');
}
refreshTerrainCache();

/** The arena's water discs (empty on the colosseum). */
export function renderWaterZones(): readonly TerrainZoneDef[] {
  return waterZones;
}

/** The arena's moss discs (empty on the colosseum). */
export function renderMossZones(): readonly TerrainZoneDef[] {
  return mossZones;
}

/** True when the current arena has any terrain zone (cheap early-out for the terrain-aware FX). */
export function renderArenaHasTerrain(): boolean {
  return current.terrain.length > 0;
}

function zoneAt(zones: readonly TerrainZoneDef[], x: number, z: number, grow: number): TerrainZoneDef | null {
  for (let i = 0; i < zones.length; i++) {
    const zn = zones[i];
    const dx = x - zn.x;
    const dz = z - zn.z;
    const r = zn.radius + grow;
    if (dx * dx + dz * dz <= r * r) return zn;
  }
  return null;
}

/** The water disc containing (x, z) (optionally grown by `grow` metres), or null. */
export function waterZoneAt(x: number, z: number, grow = 0): TerrainZoneDef | null {
  return zoneAt(waterZones, x, z, grow);
}

/** The moss disc containing (x, z) (optionally grown by `grow` metres), or null. */
export function mossZoneAt(x: number, z: number, grow = 0): TerrainZoneDef | null {
  return zoneAt(mossZones, x, z, grow);
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * How much of a water disc's full depth has built up at distance `dist` from its centre: 1 over the interior, easing to 0 at
 * the shoreline `radius` across `bank` metres (smoothstep). The pool floor height is `−depth × this`, and the water depth the
 * shader tints with is `depth × this` (0 at the shoreline, so no vertical wall of water).
 */
export function poolDepthFraction(dist: number, radius: number, bank = POOL_BANK_WIDTH): number {
  return smooth((radius - dist) / bank);
}

/** Height of the pool FLOOR (m, ≤ 0) at distance `dist` from the centre of a water disc: 0 at the shoreline, `−depth` inside. */
export function poolFloorHeight(dist: number, radius: number, depth: number, bank = POOL_BANK_WIDTH): number {
  return -depth * poolDepthFraction(dist, radius, bank);
}

/** Water-surface height at world (x, z): {@link POOL_SURFACE_Y} over a water disc, 0 (the ground) elsewhere. */
export function waterSurfaceAt(x: number, z: number): number {
  return waterZoneAt(x, z, 0.05) === null ? 0 : POOL_SURFACE_Y;
}

// ── Water activity board (render → audio) ────────────────────────────────────

/** Max swimmers tracked at once (the audio slosh voices are capped far below this). */
export const WATER_ACTIVITY_MAX = 12;

/**
 * Written each rendered frame by the water FX (from the rigs' `wake` reports + `splash` events), read by the audio ambience to
 * drive the soft slosh loops. `stamp` = `performance.now()` of the last write; entries older than ~0.4 s are stale.
 */
export const waterActivity = {
  count: 0,
  x: new Float32Array(WATER_ACTIVITY_MAX),
  z: new Float32Array(WATER_ACTIVITY_MAX),
  speed: new Float32Array(WATER_ACTIVITY_MAX),
  stamp: 0,
};

/**
 * Render → audio hooks for terrain sounds. The AudioEngine sets `mossStep` while the jungle ambience runs; Effects calls it for
 * every footstep / landing that lands on a moss patch (the audio throttles by rate and distance).
 */
export const terrainAudio: { mossStep: ((x: number, z: number) => void) | null } = { mossStep: null };

/** Reset the board (scene teardown / arena change). */
export function resetWaterActivity(): void {
  waterActivity.count = 0;
  waterActivity.stamp = 0;
}
