/**
 * Arena definitions (v1.8, docs/JUNGLE-PLAN.md). One {@link ArenaDef} per playable arena, looked up with
 * {@link getArena}; the sim (`World.arena`), the bots (`BotManager`) and — later — the renderer read ALL arena
 * geometry from the def instead of module-level constants, so adding an arena never touches global state.
 *
 *  - `colosseum` is the original Roman arena, built from the unchanged constants in `config/arena.ts` (which keeps
 *    exporting them for the renderer, tests and the data fingerprint). Its behaviour is byte-identical to v1.7.
 *  - `jungle` is the v1.8 Jungle Clearing: tall tree trunks, fallen logs, crate clusters, six pickup pads, ten spawn
 *    seats on a ring, and DATA-ONLY terrain zones (a shallow pool and moss patches; the mechanics live in the J1b
 *    terrain system, the scenery in the J3 renderer).
 *
 * Pure data + a few pure helpers: no three/DOM, no sim imports (so config, sim, ai, render and online can all use it).
 * Positions are world XZ metres; the angle convention of ring layouts is `x = r·cos θ, z = r·sin θ` (θ in degrees).
 */

import type { ArenaId } from '../core/types';
import { ARENA_IDS } from '../core/types';
import { ARENA, MATCH } from './balance';
import * as A from './arena';
import type { AabbObstacle, CircleObstacle, Obstacle, PickupPad, SegmentObstacle } from './arena';

/** What a solid collider IS, so the renderer can dress it (stone pillar vs tree trunk vs fallen log …). */
export type ObstacleKind = 'pillar' | 'tree' | 'column' | 'log' | 'crate';

/** A collider tagged with its {@link ObstacleKind} (the tag is the only addition to the `config/arena` shapes). */
export type ArenaCircle = CircleObstacle & { kind: ObstacleKind };
export type ArenaSegment = SegmentObstacle & { kind: ObstacleKind };
export type ArenaAabb = AabbObstacle & { kind: ObstacleKind };
export type ArenaObstacle = ArenaCircle | ArenaSegment | ArenaAabb;

/** v1.8 terrain zone — DATA ONLY here (J1b implements the mechanics). `depth` = visible water depth (m, water only). */
export type TerrainKind = 'moss' | 'water';
export interface TerrainZoneDef {
  kind: TerrainKind;
  shape: 'circle';
  x: number;
  z: number;
  radius: number;
  depth?: number;
}

/** A fighter spawn seat (the fighter faces the arena centre). */
export interface SpawnPoint {
  x: number;
  z: number;
}

/** Optional per-arena overrides of the `TRAP_PLACEMENT` numbers (config/traps.ts). */
export interface TrapPlacementOverrides {
  minRadius?: number;
  maxRadius?: number;
  obstacleClear?: number;
  pickupClear?: number;
  spawnClear?: number;
  trapClear?: number;
}

/** A disc nothing trap-like may overlap (centre + radius). */
export interface ExclusionDisc {
  x: number;
  z: number;
  radius: number;
}

/**
 * How trap placement adapts to this arena. The solids, pads, spawns and TERRAIN ZONES of the arena always count;
 * these are the extras: number overrides, extra exclusion discs, and the gap a trap disc keeps from a terrain zone.
 */
export interface ArenaTrapRules {
  overrides: TrapPlacementOverrides;
  exclusions: readonly ExclusionDisc[];
  /** Min gap (m) between a trap disc edge and any terrain zone edge (a trap is never inside water/moss). */
  terrainClear: number;
}

export interface ArenaDef {
  id: ArenaId;
  name: string;
  blurb: string;

  // ── Bounds (hard circular wall clamp) ──
  wallRadius: number;
  wallHeight: number;
  /** Stands / foliage ring radii (cosmetic; `standsOuter` is also where airborne projectiles expire). */
  standsInner: number;
  standsOuter: number;

  // ── Colliders ──
  /**
   * Every solid collider, in this fixed order: round blockers (pillars/trees), segments (columns/logs), crates
   * (aabb). Crates stay listed here but the sim removes a destroyed crate from collision. The walkable dais is NOT
   * a solid (see `dais`).
   */
  solids: readonly ArenaObstacle[];
  /** Derived views of `solids` (same objects, same order): non-walkable round blockers (pillars / tree trunks). */
  circles: readonly ArenaCircle[];
  /** Derived: low segments (fallen columns / logs). All are jumpable in the shipped arenas. */
  segments: readonly ArenaSegment[];
  /** Derived: destructible crates; array order = runtime crate id. */
  crates: readonly ArenaAabb[];
  /** Pickup pads; `id` = pickup id. */
  pickupPads: readonly PickupPad[];
  /** Walkable raised disc (colosseum only). Ground height inside it = `dais.height`, else 0. */
  dais?: CircleObstacle;
  /** Cosmetic gate angles (colosseum). */
  gateAnglesDeg?: readonly number[];

  // ── Spawns ──
  /** The canonical 10 spawn seats (seat index = roster index 0..9; seat 0 is the player's, due south). */
  spawns: readonly SpawnPoint[];
  /** Nominal spawn ring radius (m) and the angle of seat 0 (degrees). */
  spawnRing: number;
  spawnStartDeg: number;
  /**
   * `'ring'`: for a roster of n the seats are spread evenly around the ring (the colosseum's v1.0 rule — n = 10 gives
   * `spawns`). `'seats'`: n ≤ 10 fighters take evenly spaced seats of the hand-cleared `spawns` list.
   */
  spawnLayout: 'ring' | 'seats';

  // ── Terrain (data only; J1b) ──
  terrain: readonly TerrainZoneDef[];

  // ── Traps ──
  trapRules: ArenaTrapRules;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** `count` points evenly around a ring of radius `r`, first at `startDeg` (4-decimal rounded, hand-authored data). */
function ringPoints(r: number, count: number, startDeg: number): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    const rad = ((startDeg + i * step) * Math.PI) / 180;
    out.push({ x: r4(r * Math.cos(rad)), z: r4(r * Math.sin(rad)) });
  }
  return out;
}

/**
 * The v1.0 spawn-ring formula, UNROUNDED and in exactly the original operation order (the colosseum's spawn
 * positions feed the sim, so they must stay bit-identical): n fighters every 360/n degrees from `startDeg`.
 */
function exactRing(radius: number, n: number, startDeg: number): SpawnPoint[] {
  const stepDeg = n > 0 ? 360 / n : MATCH.spawnStepDeg;
  const out: SpawnPoint[] = [];
  for (let i = 0; i < n; i++) {
    const angle = ((startDeg + stepDeg * i) * Math.PI) / 180;
    out.push({ x: radius * Math.cos(angle), z: radius * Math.sin(angle) });
  }
  return out;
}

function tagCircle(o: CircleObstacle, kind: ObstacleKind): ArenaCircle {
  return { ...o, kind };
}
function tagSegment(o: SegmentObstacle, kind: ObstacleKind): ArenaSegment {
  return { ...o, kind };
}
function tagAabb(o: AabbObstacle, kind: ObstacleKind): ArenaAabb {
  return { ...o, kind };
}

type ArenaInput = Omit<ArenaDef, 'solids' | 'circles' | 'segments' | 'crates'> & {
  circles: readonly ArenaCircle[];
  segments: readonly ArenaSegment[];
  crates: readonly ArenaAabb[];
};

/** Assemble an ArenaDef: `solids` = circles, then segments, then crates (the order the sim has always used). */
function makeArena(input: ArenaInput): ArenaDef {
  const solids: ArenaObstacle[] = [...input.circles, ...input.segments, ...input.crates];
  return { ...input, solids };
}

// ── Colosseum (the original arena, from config/arena.ts constants) ───────────

const COLOSSEUM_SPAWNS = exactRing(MATCH.spawnRing, 10, 270);

export const COLOSSEUM_ARENA: ArenaDef = makeArena({
  id: 'colosseum',
  name: 'Colosseum',
  blurb: 'The classic sand arena: stone pillars, fallen columns, crates and a raised dais.',
  wallRadius: A.WALL_RADIUS,
  wallHeight: A.WALL_HEIGHT,
  standsInner: A.STANDS_INNER,
  standsOuter: A.STANDS_OUTER,
  circles: A.PILLARS.map((p) => tagCircle(p, 'pillar')),
  segments: A.FALLEN_COLUMNS.map((c) => tagSegment(c, 'column')),
  crates: A.CRATES.map((c) => tagAabb(c, 'crate')),
  pickupPads: A.PICKUP_PADS,
  dais: A.DAIS,
  gateAnglesDeg: A.GATE_ANGLES_DEG,
  spawns: COLOSSEUM_SPAWNS,
  spawnRing: MATCH.spawnRing,
  spawnStartDeg: 270,
  spawnLayout: 'ring',
  terrain: [],
  trapRules: { overrides: {}, exclusions: [], terrainClear: 0.5 },
});

// ── Jungle Clearing (v1.8) ───────────────────────────────────────────────────

/** Tree trunks (x, z, trunk radius): fixed hand-authored clearing, none within 3.5 m of a spawn / pad. */
const JUNGLE_TREE_DATA: readonly (readonly [number, number, number])[] = [
  [-16.2, 20.6, 1.5],
  [-9.5, -0.3, 1.5],
  [-25.6, 6.1, 1.4],
  [4.1, -15.9, 1.3],
  [14.2, 3.3, 1.3],
  [16.3, 20.4, 1.2],
  [-23.8, 11.8, 1.2],
  [22.3, -14.5, 1.1],
  [9.3, 12.1, 1],
  [-22.3, -14.6, 1],
  [26.8, -0.7, 0.9],
  [17.9, -11.6, 0.9],
  [-10.8, 24.4, 0.8],
  [-17.5, -19.5, 1.4],
];
export const JUNGLE_TREE_HEIGHT = 12;

/** Fallen logs (ax, az, bx, bz): jumpable, thickness 1.0, height 0.9. */
const JUNGLE_LOG_DATA: readonly (readonly [number, number, number, number])[] = [
  [-10, 9.7, -3.2, 9],
  [8, 17.9, 12, 22.1],
  [-7.3, -8.7, -3, -8.7],
  [12.9, -1.8, 9.2, 1.1],
];
export const JUNGLE_LOG_THICKNESS = 1.0;
export const JUNGLE_LOG_HEIGHT = 0.9;

/** Crate clusters (anchor of the L-pile, same pile shape as the colosseum): one per quadrant, rotated 90° apart. */
const JUNGLE_CRATE_ANCHORS: readonly SpawnPoint[] = [
  { x: 13, z: 8 },
  { x: -8, z: 13 },
  { x: -13, z: -8 },
  { x: 8, z: -13 },
];
const JUNGLE_CRATE_OFFSETS: readonly SpawnPoint[] = [
  { x: 0, z: 0 },
  { x: 1.05, z: 0 },
  { x: 0, z: 1.05 },
];

/** The central wading pool and the moss patches (x, z, radius). */
export const JUNGLE_POOL_RADIUS = 6.5;
export const JUNGLE_POOL_DEPTH = 0.55;
const JUNGLE_MOSS_DATA: readonly (readonly [number, number, number])[] = [
  [6.8, -22.4, 3.4],
  [-17.9, -14.1, 3],
  [18, -15.7, 2.8],
  [5.1, 8.6, 2.6],
  [-3.9, -24.2, 2.4],
  [-2.9, 15.1, 2.2],
  [5.4, -8.7, 2],
];

const JUNGLE_SPAWNS = ringPoints(20, 10, 270);

export const JUNGLE_ARENA: ArenaDef = makeArena({
  id: 'jungle',
  name: 'Jungle Clearing',
  blurb: 'Giant trees, mossy ground and a shallow pool in the middle.',
  wallRadius: 30,
  wallHeight: 5,
  standsInner: 31,
  standsOuter: 44,
  circles: JUNGLE_TREE_DATA.map(([x, z, radius]) =>
    tagCircle({ shape: 'circle', x, z, radius, height: JUNGLE_TREE_HEIGHT, walkable: false, jumpable: false }, 'tree'),
  ),
  segments: JUNGLE_LOG_DATA.map(([ax, az, bx, bz]) =>
    tagSegment(
      { shape: 'segment', ax, az, bx, bz, thickness: JUNGLE_LOG_THICKNESS, height: JUNGLE_LOG_HEIGHT, jumpable: true },
      'log',
    ),
  ),
  crates: JUNGLE_CRATE_ANCHORS.flatMap((c) =>
    JUNGLE_CRATE_OFFSETS.map((o) =>
      tagAabb(
        {
          shape: 'aabb',
          x: r4(c.x + o.x),
          z: r4(c.z + o.z),
          halfX: A.CRATE_HALF,
          halfZ: A.CRATE_HALF,
          height: A.CRATE_SIZE,
          destructible: true,
          hp: A.CRATE_HP,
        },
        'crate',
      ),
    ),
  ),
  pickupPads: ringPoints(11, 6, 30).map((p, i): PickupPad => ({ id: i, x: p.x, z: p.z })),
  spawns: JUNGLE_SPAWNS,
  spawnRing: 20,
  spawnStartDeg: 270,
  spawnLayout: 'seats',
  terrain: [
    { kind: 'water', shape: 'circle', x: 0, z: 0, radius: JUNGLE_POOL_RADIUS, depth: JUNGLE_POOL_DEPTH },
    ...JUNGLE_MOSS_DATA.map(([x, z, radius]): TerrainZoneDef => ({ kind: 'moss', shape: 'circle', x, z, radius })),
  ],
  // The jungle is dense (trees, logs, moss, a pool) so the colosseum's clearances (1.5 / 2.5 / 3.5 m) would leave no room for
  // the difficulty's 2-7 traps; these tighter gaps still keep every trap disc wholly out of water/moss and off every solid
  // (~280 m2 of valid sites; all difficulties place their full count for every tested seed).
  trapRules: { overrides: { obstacleClear: 1.0, pickupClear: 2.0, spawnClear: 2.5 }, exclusions: [], terrainClear: 0.5 },
});

// ── Registry ─────────────────────────────────────────────────────────────────

/** Every arena by id. (Adding an arena: extend `ArenaId`/`ARENA_IDS` in core/types and add it here.) */
export const ARENAS: Record<ArenaId, ArenaDef> = {
  colosseum: COLOSSEUM_ARENA,
  jungle: JUNGLE_ARENA,
};

/** The arena for `id`; `undefined` (and any unknown id, e.g. a stale stored value) → the colosseum. */
export function getArena(id: ArenaId | undefined): ArenaDef {
  if (id === undefined) return COLOSSEUM_ARENA;
  return (ARENAS as Partial<Record<string, ArenaDef>>)[id] ?? COLOSSEUM_ARENA;
}

/** True when `v` is one of the registered arena ids. */
export function isArenaId(v: unknown): v is ArenaId {
  return typeof v === 'string' && (ARENA_IDS as readonly string[]).includes(v);
}

/**
 * Spawn positions for a roster of `n` (index = fighter id), deterministic. Colosseum: the original `spawnRing`/360÷n
 * rule (bit-identical to v1.7 for every n). Jungle: for n ≤ 10 evenly spaced seats of the cleared 10-seat ring (n = 10
 * → all seats; n = 2 → opposite seats), for n > 10 an even ring of radius `spawnRing`.
 */
export function spawnPositions(arena: ArenaDef, n: number): SpawnPoint[] {
  if (arena.spawnLayout === 'seats' && n >= 1 && n <= arena.spawns.length) {
    const out: SpawnPoint[] = [];
    for (let i = 0; i < n; i++) {
      const s = arena.spawns[Math.floor((i * arena.spawns.length) / n)];
      out.push({ x: s.x, z: s.z });
    }
    return out;
  }
  return exactRing(arena.spawnRing, n, arena.spawnStartDeg);
}

/** Ground height under (x,z): the dais top inside the dais disc, else 0. Pure; the sim and the AI both use it. */
export function arenaGroundHeight(arena: ArenaDef, x: number, z: number): number {
  const d = arena.dais;
  if (d === undefined) return ARENA.groundY;
  const dx = x - d.x;
  const dz = z - d.z;
  return Math.sqrt(dx * dx + dz * dz) <= d.radius ? d.height : ARENA.groundY;
}

/** Obstacles the sim treats as static colliders (round blockers + segments; crates are tracked separately). */
export function staticObstaclesOf(arena: ArenaDef): readonly Obstacle[] {
  return [...arena.circles, ...arena.segments];
}
