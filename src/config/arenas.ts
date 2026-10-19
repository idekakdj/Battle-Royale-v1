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

import type { ArenaId, SerpentTier } from '../core/types';
import { ARENA_IDS } from '../core/types';
import { ARENA, MATCH } from './balance';
import * as A from './arena';
import type { AabbObstacle, CircleObstacle, Obstacle, PickupPad, SegmentObstacle } from './arena';

/** What a solid collider IS, so the renderer can dress it (stone pillar vs tree trunk vs fallen log …). */
export type ObstacleKind = 'pillar' | 'tree' | 'column' | 'log' | 'crate' | 'coral' | 'rock' | 'arch';

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

/**
 * v1.9 ELEVATIONS (Ocean Dome). The ground height at (x, z) is the MAX over these pieces (0 where none applies; the colosseum's `dais`
 * keeps working as before). Vertical edges are CLIFFS: a grounded fighter cannot step up more than `STEP_UP` (0.6 m, like the dais)
 * — it is blocked there — while a fighter whose body is already above the higher surface (a jump, an eagle soar) lands on it;
 * ramps are the way up: `ramp` rises linearly from `h0` (at its low end) to `h1` (high end) along `dirDeg` over `length`, `width` wide.
 * Angle convention as `arena.ts` rings: direction vector (cos θ, sin θ) in (x, z).
 */
export type ElevationPiece =
  | { kind: 'plateau'; x: number; z: number; radius: number; height: number }
  | { kind: 'ring'; x: number; z: number; rInner: number; rOuter: number; height: number }
  /**
   * `ramp`: an oriented rectangle whose CENTRE is (x, z); direction vector (cos dirDeg, sin dirDeg) in (x, z) points from the
   * LOW end (height `h0`, at centre − dir·length/2) to the HIGH end (`h1`, at centre + dir·length/2); `width` is the lateral extent.
   * Height is linear along the axis and constant across; outside the rectangle the ramp contributes nothing.
   */
  | { kind: 'ramp'; x: number; z: number; dirDeg: number; length: number; width: number; h0: number; h1: number };

/**
 * v1.9 arena hazards. `serpent`: the Ocean Dome's sea-serpent event (docs/OCEAN-PLAN.md; numbers in config/serpent.ts).
 * v1.10 (docs/OCEAN-HEIGHTS-PLAN.md): `serpentSplitY` splits the arena into a LOW and a HIGH band by GROUND height under a fighter
 * (see {@link arenaSerpentBand}) and makes the event two independent serpents (a `low` and a `high` one); absent = the single v1.9
 * serpent that hurts everywhere. `fallDamage`: landing after a drop of at least `minDrop` m (from the height where the fighter
 * last stood) costs the fixed `damage` true damage; absent = no fall damage (every other arena).
 */
export interface ArenaHazards {
  serpent?: boolean;
  serpentSplitY?: number;
  fallDamage?: { minDrop: number; damage: number };
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

  // ── v1.9: elevations + hazards (absent on the colosseum/jungle: flat ground, no events) ──
  heightfield?: readonly ElevationPiece[];
  hazards?: ArenaHazards;

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
// (`OCEAN_ARENA` and the `ARENAS` table live at the END of this file: the ocean layout is built with the elevation helpers below.)

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

// ── Elevations (v1.9): ground height, slope, step rule, cliff geometry ───────────────────────────────

/** A GROUNDED fighter can step up onto ground at most this much higher than its feet (m); the colosseum dais is this high. */
export const ARENA_STEP_UP = 0.6;
/** An AIRBORNE fighter enters terrain whose top is at most this far above its feet (m): a jump (apex ≈ 1.2 m) clears a ≤ 1.2 m step only. */
export const ARENA_AIR_CLEARANCE = 0.05;
/** A grounded fighter stays in contact (no fall) when the ground drops by at most this much in one tick (ramps, small seams). */
export const ARENA_SNAP_DOWN = 0.2;
/** Steepest allowed ramp (rise / run of 25 degrees). */
export const ARENA_MAX_RAMP_SLOPE = Math.tan((25 * Math.PI) / 180);

const DEG = Math.PI / 180;

/** Cached unit direction (cos, sin) of a ramp piece. */
const RAMP_DIR = new WeakMap<object, { c: number; s: number }>();
function rampDir(p: { dirDeg: number }): { c: number; s: number } {
  let d = RAMP_DIR.get(p);
  if (d === undefined) {
    d = { c: Math.cos(p.dirDeg * DEG), s: Math.sin(p.dirDeg * DEG) };
    RAMP_DIR.set(p, d);
  }
  return d;
}

/** Height a single elevation piece gives at (x, z); `-Infinity` where it does not apply. */
export function elevationPieceHeight(p: ElevationPiece, x: number, z: number): number {
  if (p.kind === 'plateau') {
    const dx = x - p.x;
    const dz = z - p.z;
    return Math.sqrt(dx * dx + dz * dz) <= p.radius ? p.height : -Infinity;
  }
  if (p.kind === 'ring') {
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    return d >= p.rInner && d <= p.rOuter ? p.height : -Infinity;
  }
  const { c, s } = rampDir(p);
  const dx = x - p.x;
  const dz = z - p.z;
  const along = dx * c + dz * s;
  const lat = -dx * s + dz * c;
  const half = p.length * 0.5;
  if (along < -half || along > half || Math.abs(lat) > p.width * 0.5) return -Infinity;
  return p.h0 + (p.h1 - p.h0) * ((along + half) / p.length);
}

/**
 * Ground height under (x,z): the max over the arena's `heightfield` pieces, the colosseum's dais top inside the dais disc, and 0.
 * Pure; the sim, the AI and the renderer all use it. Arenas without a heightfield behave exactly as in v1.8.
 */
export function arenaGroundHeight(arena: ArenaDef, x: number, z: number): number {
  const d = arena.dais;
  let h: number = ARENA.groundY;
  if (d !== undefined) {
    const dx = x - d.x;
    const dz = z - d.z;
    if (Math.sqrt(dx * dx + dz * dz) <= d.radius) h = d.height;
  }
  const hf = arena.heightfield;
  if (hf !== undefined) {
    for (let i = 0; i < hf.length; i++) {
      const e = elevationPieceHeight(hf[i], x, z);
      if (e > h) h = e;
    }
  }
  return h;
}

/** v1.10: does this arena run the second (HIGH) serpent? True iff `hazards.serpent` and a `serpentSplitY` is set. */
export function arenaHasHighSerpent(arena: ArenaDef): boolean {
  return arena.hazards?.serpent === true && arena.hazards.serpentSplitY !== undefined;
}

/**
 * v1.10: which serpent's band the spot (x, z) belongs to, by the GROUND height there (not the fighter's own height): `'high'`
 * when the ground is at least `hazards.serpentSplitY`, else `'low'` (always `'low'` on an arena without a split). A fighter in
 * mid-air, or an eagle, is in the band of the ground it is over.
 */
export function arenaSerpentBand(arena: ArenaDef, x: number, z: number): SerpentTier {
  const split = arena.hazards?.serpentSplitY;
  if (split === undefined) return 'low';
  return arenaGroundHeight(arena, x, z) >= split ? 'high' : 'low';
}

/**
 * Walking slope at (x, z) as rise / run (0 on flat ground, level edges and outside the heightfield): the grade of the ramp that
 * supplies the ground height there. Compare with {@link ARENA_MAX_RAMP_SLOPE}.
 */
export function arenaSlopeAt(arena: ArenaDef, x: number, z: number): number {
  const hf = arena.heightfield;
  if (hf === undefined) return 0;
  const g = arenaGroundHeight(arena, x, z);
  for (let i = 0; i < hf.length; i++) {
    const p = hf[i];
    if (p.kind !== 'ramp') continue;
    const e = elevationPieceHeight(p, x, z);
    if (e !== -Infinity && e >= g - 1e-9) return Math.abs(p.h1 - p.h0) / p.length;
  }
  return 0;
}

/**
 * Can a GROUNDED fighter walk from A to B under the step rule (centre-point test, sampled every ≤ 0.25 m: no sample's ground may
 * exceed the previous sample's by more than {@link ARENA_STEP_UP}; stepping down is free)? `fromHeight` = the feet height at A
 * (default the ground at A). The sim additionally keeps the fighter's body radius clear of cliffs (see {@link arenaCliffPush}).
 */
export function arenaWalkableStep(
  arena: ArenaDef,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  fromHeight?: number,
): boolean {
  let h = fromHeight ?? arenaGroundHeight(arena, x0, z0);
  const dx = x1 - x0;
  const dz = z1 - z0;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 0.25));
  for (let i = 1; i <= n; i++) {
    const g = arenaGroundHeight(arena, x0 + (dx * i) / n, z0 + (dz * i) / n);
    if (g > h + ARENA_STEP_UP + 1e-9) return false;
    h = g;
  }
  return true;
}

/** Nearest-cliff query result: signed distance `d` (negative inside) to the region of ground higher than the limit, and the unit normal pointing OUT of it. */
export interface CliffHit {
  d: number;
  nx: number;
  nz: number;
}

/** Signed distance from (x, z) to the part of `p` that is higher than `lim`; false if the piece never exceeds `lim`. */
function pieceCliff(p: ElevationPiece, x: number, z: number, lim: number, out: CliffHit): boolean {
  if (p.kind === 'plateau') {
    if (!(p.height > lim)) return false;
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    out.d = d - p.radius;
    if (d > 1e-9) {
      out.nx = dx / d;
      out.nz = dz / d;
    } else {
      out.nx = 1;
      out.nz = 0;
    }
    return true;
  }
  if (p.kind === 'ring') {
    if (!(p.height > lim)) return false;
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const ux = d > 1e-9 ? dx / d : 1;
    const uz = d > 1e-9 ? dz / d : 0;
    if (d >= (p.rInner + p.rOuter) * 0.5) {
      out.d = d - p.rOuter; // nearer the outer boundary
      out.nx = ux;
      out.nz = uz;
    } else {
      out.d = p.rInner - d; // nearer the inner boundary (the hole counts as outside the cliff)
      out.nx = -ux;
      out.nz = -uz;
    }
    return true;
  }
  // Ramp: the sub-rectangle whose height exceeds `lim`, in axis coordinates t ∈ [0, length] from the LOW end.
  const span = p.h1 - p.h0;
  let tA = 0;
  let tB = p.length;
  if (p.h0 > lim && p.h1 > lim) {
    // whole ramp
  } else if (p.h0 <= lim && p.h1 <= lim) {
    return false;
  } else {
    const ts = (p.length * (lim - p.h0)) / span;
    if (span > 0) tA = ts;
    else tB = ts;
  }
  const { c, s } = rampDir(p);
  const dx = x - p.x;
  const dz = z - p.z;
  const t = dx * c + dz * s + p.length * 0.5 - (tA + tB) * 0.5;
  const w = -dx * s + dz * c;
  const hl = (tB - tA) * 0.5;
  const hw = p.width * 0.5;
  const qt = Math.abs(t) - hl;
  const qw = Math.abs(w) - hw;
  let nt: number;
  let nw: number;
  if (qt > 0 || qw > 0) {
    const ot = Math.max(qt, 0);
    const ow = Math.max(qw, 0);
    const d = Math.sqrt(ot * ot + ow * ow);
    out.d = d;
    nt = t < 0 ? -ot / d : ot / d;
    nw = w < 0 ? -ow / d : ow / d;
  } else if (qt > qw) {
    out.d = qt;
    nt = t < 0 ? -1 : 1;
    nw = 0;
  } else {
    out.d = qw;
    nt = 0;
    nw = w < 0 ? -1 : 1;
  }
  out.nx = nt * c - nw * s;
  out.nz = nt * s + nw * c;
  return true;
}

const CLIFF_TMP: CliffHit = { d: 0, nx: 0, nz: 0 };
const PIECE_TMP: CliffHit = { d: 0, nx: 0, nz: 0 };

/**
 * The nearest part of the heightfield that is HIGHER than `limitY` (a fighter's step limit): fills `out` with the signed distance
 * (negative inside) and the outward normal, returns false if no piece exceeds `limitY` (or the arena has no heightfield).
 */
export function arenaNearestCliff(arena: ArenaDef, x: number, z: number, limitY: number, out: CliffHit): boolean {
  const hf = arena.heightfield;
  if (hf === undefined) return false;
  let found = false;
  out.d = Infinity;
  for (let i = 0; i < hf.length; i++) {
    if (!pieceCliff(hf[i], x, z, limitY, PIECE_TMP)) continue;
    if (PIECE_TMP.d < out.d) {
      out.d = PIECE_TMP.d;
      out.nx = PIECE_TMP.nx;
      out.nz = PIECE_TMP.nz;
      found = true;
    }
  }
  return found;
}

/**
 * Cliff distance (m) at (x, z) for a grounded fighter standing at (x, z) on the ground: the gap to ground higher than
 * `ground + ARENA_STEP_UP`. Infinity where nothing is higher. A walker of body radius r fits at (x, z) iff this is ≥ r.
 */
export function arenaCliffDistance(arena: ArenaDef, x: number, z: number, feetY?: number): number {
  const lim = (feetY ?? arenaGroundHeight(arena, x, z)) + ARENA_STEP_UP;
  return arenaNearestCliff(arena, x, z, lim, CLIFF_TMP) ? CLIFF_TMP.d : Infinity;
}

/**
 * Push a circle of `radius` at (x, z) out of every part of the heightfield higher than `limitY` (a cliff behaves like an obstacle:
 * the blocked component is removed, the rest slides). Two settling passes. Writes the result to `out`; returns true if it moved.
 */
export function arenaCliffPush(
  arena: ArenaDef,
  x: number,
  z: number,
  radius: number,
  limitY: number,
  out: { x: number; z: number },
): boolean {
  out.x = x;
  out.z = z;
  let moved = false;
  for (let pass = 0; pass < 2; pass++) {
    if (!arenaNearestCliff(arena, out.x, out.z, limitY, CLIFF_TMP) || CLIFF_TMP.d >= radius) break;
    const push = radius - CLIFF_TMP.d;
    out.x += CLIFF_TMP.nx * push;
    out.z += CLIFF_TMP.nz * push;
    moved = true;
  }
  return moved;
}

/** The step limit a fighter with feet at `feetY` over ground `groundY` (at its centre) has: it may enter terrain up to this height. */
export function arenaStepLimit(feetY: number, groundY: number): number {
  return Math.max(feetY + ARENA_AIR_CLEARANCE, Math.min(groundY, feetY) + ARENA_STEP_UP);
}

/** Distance from (x, z) to a ramp's rectangle (0 inside). */
function rampRectDist(p: Extract<ElevationPiece, { kind: 'ramp' }>, x: number, z: number): number {
  const { c, s } = rampDir(p);
  const dx = x - p.x;
  const dz = z - p.z;
  const along = dx * c + dz * s;
  const lat = -dx * s + dz * c;
  return Math.hypot(Math.max(0, Math.abs(along) - p.length * 0.5), Math.max(0, Math.abs(lat) - p.width * 0.5));
}

/**
 * True when the whole disc of `radius` around (x, z) lies on ONE flat level: it straddles no level edge (plateau / ring / dais rim)
 * and touches no ramp. Exact (analytic) and conservative; used to keep traps, pads, spawns and cover off ramps and cliff edges.
 */
export function arenaIsLevel(arena: ArenaDef, x: number, z: number, radius: number): boolean {
  const dais = arena.dais;
  if (dais !== undefined) {
    const dd = Math.hypot(x - dais.x, z - dais.z);
    if (dd - radius < dais.radius && dd + radius > dais.radius) return false;
  }
  const hf = arena.heightfield;
  if (hf === undefined) return true;
  for (let i = 0; i < hf.length; i++) {
    const p = hf[i];
    if (p.kind === 'ramp') {
      if (rampRectDist(p, x, z) < radius) return false;
      continue;
    }
    const dd = Math.hypot(x - p.x, z - p.z);
    if (p.kind === 'plateau') {
      if (dd - radius < p.radius && dd + radius > p.radius) return false;
    } else {
      if (dd - radius < p.rOuter && dd + radius > p.rOuter) return false;
      if (dd - radius < p.rInner && dd + radius > p.rInner) return false;
    }
  }
  return true;
}

/** Signed distance from (x, z) to the surface of the nearest solid of `arena` (circles, segments, crates; negative inside); Infinity if none. */
export function arenaSolidDistance(arena: ArenaDef, x: number, z: number): number {
  let best = Infinity;
  const solids = arena.solids;
  for (let i = 0; i < solids.length; i++) {
    const ob = solids[i];
    let d: number;
    if (ob.shape === 'circle') {
      d = Math.hypot(x - ob.x, z - ob.z) - ob.radius;
    } else if (ob.shape === 'segment') {
      const abx = ob.bx - ob.ax;
      const abz = ob.bz - ob.az;
      const l2 = abx * abx + abz * abz;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ob.ax) * abx + (z - ob.az) * abz) / l2)) : 0;
      d = Math.hypot(x - (ob.ax + abx * t), z - (ob.az + abz * t)) - ob.thickness * 0.5;
    } else {
      d = Math.hypot(Math.max(0, Math.abs(x - ob.x) - ob.halfX), Math.max(0, Math.abs(z - ob.z) - ob.halfZ));
    }
    if (d < best) best = d;
  }
  return best;
}

/**
 * Walkability helper for bots / A*: can a body of `radius` STAND at (x, z)? Inside the wall (minus the radius), clear of every cliff
 * (the sim's push-out would not move it: `arenaCliffDistance ≥ radius`) and — unless `solids === false` — clear of every solid (crates
 * included; jumpable arches count as blocking, which is conservative).
 */
export function arenaStandable(arena: ArenaDef, x: number, z: number, radius: number, solids = true): boolean {
  if (Math.hypot(x, z) > arena.wallRadius - radius) return false;
  if (arenaCliffDistance(arena, x, z) < radius - 1e-9) return false;
  if (solids && arenaSolidDistance(arena, x, z) < radius) return false;
  return true;
}

/**
 * Can a GROUNDED body of `radius` walk the straight line A → B? Every sample (≤ 0.25 m apart) is {@link arenaStandable} and the steps obey
 * {@link arenaWalkableStep}. On a flat arena this is just "stays inside the wall (and clear of solids)".
 */
export function arenaCanWalk(arena: ArenaDef, x0: number, z0: number, x1: number, z1: number, radius: number, solids = true): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / 0.25));
  let px = x0;
  let pz = z0;
  for (let i = 1; i <= n; i++) {
    const x = x0 + (dx * i) / n;
    const z = z0 + (dz * i) / n;
    if (!arenaStandable(arena, x, z, radius, solids) || !arenaWalkableStep(arena, px, pz, x, z)) return false;
    px = x;
    pz = z;
  }
  return true;
}

/** Obstacles the sim treats as static colliders (round blockers + segments; crates are tracked separately). */
export function staticObstaclesOf(arena: ArenaDef): readonly Obstacle[] {
  return [...arena.circles, ...arena.segments];
}

// ── Ocean Dome (v1.9, docs/OCEAN-PLAN.md; v1.10 upper tier: docs/OCEAN-HEIGHTS-PLAN.md) ──────────────────
//
// The floor of a glass dome on the sea bed, wall radius 30, FOUR LEVELS joined by ramps; every other edge is a cliff
// (a grounded fighter can only step up ARENA_STEP_UP = 0.6 m, so the ramps are the way up):
//
//   level 0  the SEABED ring    r 19 … 30   height 0     the 10 spawn seats (r 24), 3 pads, cover, 2 crate piles
//   level 1  the TERRACE ring   r 8 … 19    height 1.5   2 pads, 2 arches, 2 crate piles
//   level 2  the PLATEAU        r < 8       height 3.0   the centre pad (where the serpent's strike ends), 3 coral pillars
//   level 3  the UPPER tier     3 SEA-STACKS at r 19 (angles 72°, 180°, 288°), radius 3.6, top 6.5 m: one pad on each (at its centre)
//
//   Level ramps: 5 seabed→terrace (0°, 108°, 216°, 252°, 324°) and 3 terrace→plateau (105°, 234°, 342°), 6 m long × 6 m wide, rising
//   1.5 m (grade 0.25 = 14°). The height field is single-valued, so a sea-stack is a SOLID round tower (a `plateau` piece, top 6.5 m)
//   standing on the terrace's outer edge (half over the terrace, half over the seabed), and the way up is a wedge-shaped ramp over the level
//   below: every tower has a CAUSEWAY that runs radially from the plateau rim (3.0 → 6.5, 9.25 m) and the towers at 72° and 180° have a CHORD
//   as well, which runs slantwise across the terrace (1.5 → 6.5, 13.25 m, leaning clockwise so its foot lands mid-pocket): two ways up from
//   two levels, from different directions. All are 3.8 m wide and made of two pieces (a long lower one, grade ≤ 0.40, and a short gentle
//   top one, see below). The causeways cut the terrace into three pockets (A 72°→180°, B 180°→288°, C 288°→72°); the plateau (inner ramps),
//   the seabed (outer ramps) and the tower tops (chords) connect them. Walking off a ramp's side or a tower's rim near the top is a real fall
//   (≥ 3.4 m: the Ocean's fall damage, see `OCEAN_FALL_*`); the lower ramps and the plateau rim are only 1.5 m drops.
//
// Serpent lanes (config/serpentLanes.ts): ground ≥ 4.5 m is the HIGH band (tower tops + the top of their ramps); the layout leaves 182 low and
// 96 high strike bins of 360 (the low serpent never runs over or alongside the upper tier).
//
// Solid cover: coral pillars (r ≈ 1, tall), rock outcrops (r ≈ 1.6), low coral arches (jumpable segments) and crate piles. Every solid carries
// `baseY` = the ground height under it (its top is baseY + height); none stands on a ramp, within 1 m of a level edge, in a ramp's approach, or
// so near a wall that a hippo could not pass between them. The tower tops carry only the pad (a 7.2 m disc: no room for cover).
// `scripts/ocean-layout.ts` prints the ASCII height map, the lane bins, every layout rule and the reachability proof; the rules are
// tests/config/oceanRules.ts (shared with tests/config/ocean.layout.test.ts).

/** Polar → world XZ (x = r·cos θ, z = r·sin θ), 4-decimal rounded like the other hand-authored rings. */
function pol(r: number, deg: number): SpawnPoint {
  const a = deg * DEG;
  return { x: r4(r * Math.cos(a)), z: r4(r * Math.sin(a)) };
}

export const OCEAN_TERRACE_HEIGHT = 1.5;
export const OCEAN_PLATEAU_HEIGHT = 3;
export const OCEAN_PLATEAU_RADIUS = 8;
export const OCEAN_TERRACE_OUTER_RADIUS = 19;
const OCEAN_TERRACE_INNER_RADIUS = 7.5;
/** v1.10: top of the sea-stacks (the UPPER tier), metres above the seabed. */
export const OCEAN_UPPER_HEIGHT = 6.5;
/** v1.10: ground at or above this height belongs to the HIGH serpent's band (`hazards.serpentSplitY`): stack tops + the top of their ramps. */
export const OCEAN_SERPENT_SPLIT_Y = 4.5;
/** v1.10 fall damage (`hazards.fallDamage`): a landing after a drop of at least this many metres hurts … */
export const OCEAN_FALL_MIN_DROP = 3.4;
/** … for exactly this much TRUE damage. (Stack top → plateau is 3.5 m: damage; plateau → seabed is 3.0 m: none.) */
export const OCEAN_FALL_DAMAGE = 50;
/** Level ramps: 6 m long, 6 m wide, rising 1.5 m (grade 0.25). */
const OCEAN_RAMP_LENGTH = 6;
const OCEAN_RAMP_WIDTH = 6;
const OCEAN_OUTER_RAMP_DEGS: readonly number[] = [0, 108, 216, 252, 324];
const OCEAN_INNER_RAMP_DEGS: readonly number[] = [105, 234, 342];

/** The sea-stacks: centre distance from the dome centre, top radius, and angles (degrees). */
export const OCEAN_STACK_RING = 19;
export const OCEAN_STACK_RADIUS = 3.6;
const OCEAN_STACK_DEGS: readonly number[] = [72, 180, 288];

/**
 * Ramps to the upper tier (width 3.8 m, two pieces each). A body of radius r walking up must never have the tower's rim (a cliff while the
 * ground is more than ARENA_STEP_UP below the top) closer than r, so the last stretch is GENTLE: a short "top" piece rises the final
 * 0.6 m (5.9 → 6.5) over 1.9 m (grade 0.32) — with the rim 0.55 m past its high end, the rim is still 1.35 m away when the ground gets
 * within a step of the top — and a long "lower" piece (grade ≤ 0.39) does the rest. The top piece's high end tucks 0.55 m under the
 * tower's edge, so the ramp's corners are inside the tower (no notch).
 */
export const OCEAN_UPPER_RAMP_WIDTH = 3.8;
const OCEAN_UPPER_RAMP_TUCK = 0.55;
export const OCEAN_UPPER_TOP_LENGTH = 1.9;
export const OCEAN_UPPER_LANDING_Y = 5.9;
/** The long lower piece overlaps the short top piece by this much (m) so the joint has no crack; its top is then 5.9 + grade × this, within 1.5 cm of 5.9. */
export const OCEAN_UPPER_JOIN_OVERLAP = 0.03;
/** A causeway's long piece (plateau 3.0 → 5.9) is this long: grade 0.395. */
export const OCEAN_CAUSEWAY_LOWER_LENGTH = 7.35;
/** A chord's long piece (terrace 1.5 → 5.9) is this long: grade 0.388. It leaves its tower this many degrees clockwise of the radial direction. */
export const OCEAN_CHORD_LOWER_LENGTH = 11.35;
const OCEAN_CHORD_BEARING_DEG = 128;

/** A sea-stack: where it stands (world XZ of its centre), its radius and its polar angle. */
export interface OceanStack {
  x: number;
  z: number;
  radius: number;
  deg: number;
}
export const OCEAN_STACKS: readonly OceanStack[] = OCEAN_STACK_DEGS.map((deg) => {
  const c = pol(OCEAN_STACK_RING, deg);
  return { x: c.x, z: c.z, radius: OCEAN_STACK_RADIUS, deg };
});

/** A level ramp along the radius at angle `deg`, its HIGH end `topR` from the dome centre, rising from `h0` (outer end) to `h1` (inner end). */
function oceanRamp(deg: number, topR: number, h0: number, h1: number): ElevationPiece {
  const c = pol(topR + OCEAN_RAMP_LENGTH / 2, deg);
  return { kind: 'ramp', x: c.x, z: c.z, dirDeg: deg + 180, length: OCEAN_RAMP_LENGTH, width: OCEAN_RAMP_WIDTH, h0, h1 };
}

/**
 * The ramp up to sea-stack `s` whose axis passes through the tower's centre and leaves it toward `bearingDeg`; its low end (height `h0`) is
 * `footDist` from the tower's centre. Two pieces (see above): the long lower piece `h0` → 5.9 and the gentle top piece 5.9 → 6.5.
 */
function oceanClimb(s: OceanStack, bearingDeg: number, footDist: number, h0: number): ElevationPiece[] {
  const d = bearingDeg * DEG;
  const piece = (dHigh: number, dLow: number, lo: number, hi: number): ElevationPiece => {
    const mid = (dHigh + dLow) / 2;
    return {
      kind: 'ramp',
      x: r4(s.x + Math.cos(d) * mid),
      z: r4(s.z + Math.sin(d) * mid),
      dirDeg: bearingDeg + 180,
      length: r4(dLow - dHigh),
      width: OCEAN_UPPER_RAMP_WIDTH,
      h0: lo,
      h1: hi,
    };
  };
  const topHigh = s.radius - OCEAN_UPPER_RAMP_TUCK;
  const topLow = topHigh + OCEAN_UPPER_TOP_LENGTH;
  // the lower piece runs OCEAN_UPPER_JOIN_OVERLAP m on into the top piece along its own plane (no hairline crack at the joint after rounding)
  const slope = (OCEAN_UPPER_LANDING_Y - h0) / (footDist - topLow);
  const lower = piece(topLow - OCEAN_UPPER_JOIN_OVERLAP, footDist, h0, r4(OCEAN_UPPER_LANDING_Y + slope * OCEAN_UPPER_JOIN_OVERLAP));
  return [lower, piece(topHigh, topLow, OCEAN_UPPER_LANDING_Y, OCEAN_UPPER_HEIGHT)];
}

/**
 * The chord from tower `s` across the terrace: it leaves the tower clockwise (bearing = the tower's angle − 128°, i.e. leaning back toward
 * the dome centre), so its foot lands mid-pocket, on the terrace, 55-60° from the tower.
 */
function oceanChord(s: OceanStack): ElevationPiece[] {
  const footDist = s.radius - OCEAN_UPPER_RAMP_TUCK + OCEAN_UPPER_TOP_LENGTH + OCEAN_CHORD_LOWER_LENGTH;
  return oceanClimb(s, s.deg - OCEAN_CHORD_BEARING_DEG, footDist, OCEAN_TERRACE_HEIGHT);
}

/** The causeway from the plateau rim straight out to tower `s` (radial). */
function oceanCauseway(s: OceanStack): ElevationPiece[] {
  const footDist = s.radius - OCEAN_UPPER_RAMP_TUCK + OCEAN_UPPER_TOP_LENGTH + OCEAN_CAUSEWAY_LOWER_LENGTH;
  return oceanClimb(s, s.deg + 180, footDist, OCEAN_PLATEAU_HEIGHT);
}

/** The towers that have a chord as well as their causeway (indices into OCEAN_STACKS). */
const OCEAN_CHORD_STACKS: readonly number[] = [0, 1];

export const OCEAN_HEIGHTFIELD: readonly ElevationPiece[] = [
  { kind: 'ring', x: 0, z: 0, rInner: OCEAN_TERRACE_INNER_RADIUS, rOuter: OCEAN_TERRACE_OUTER_RADIUS, height: OCEAN_TERRACE_HEIGHT },
  { kind: 'plateau', x: 0, z: 0, radius: OCEAN_PLATEAU_RADIUS, height: OCEAN_PLATEAU_HEIGHT },
  // the upper tier: solid towers rising out of the terrace's outer edge
  ...OCEAN_STACKS.map((s): ElevationPiece => ({ kind: 'plateau', x: s.x, z: s.z, radius: s.radius, height: OCEAN_UPPER_HEIGHT })),
  // seabed → terrace: the high end tucks 0.5 m under the terrace edge, so the ramp's corners are inside the ring (no notch)
  ...OCEAN_OUTER_RAMP_DEGS.map((d) => oceanRamp(d, 18.5, 0, OCEAN_TERRACE_HEIGHT)),
  // terrace → plateau: the high end tucks 0.6 m under the plateau edge
  ...OCEAN_INNER_RAMP_DEGS.map((d) => oceanRamp(d, 7.4, OCEAN_TERRACE_HEIGHT, OCEAN_PLATEAU_HEIGHT)),
  // plateau → tower (causeways: radial, from the plateau rim outward) and terrace → tower (chords: slantwise across the terrace)
  ...OCEAN_STACKS.flatMap((s) => oceanCauseway(s)),
  ...OCEAN_CHORD_STACKS.flatMap((i) => oceanChord(OCEAN_STACKS[i])),
];

/** Ground height of the ocean heightfield alone (used to seat the ocean's solids; the sim reads `arenaGroundHeight`). */
function oceanBase(x: number, z: number): number {
  let h: number = ARENA.groundY;
  for (let i = 0; i < OCEAN_HEIGHTFIELD.length; i++) {
    const e = elevationPieceHeight(OCEAN_HEIGHTFIELD[i], x, z);
    if (e > h) h = e;
  }
  return h;
}

export const OCEAN_CORAL_RADIUS = 1;
export const OCEAN_CORAL_HEIGHT = 3.5;
export const OCEAN_ROCK_RADIUS = 1.6;
export const OCEAN_ROCK_HEIGHT = 2.4;
export const OCEAN_ARCH_LENGTH = 4.5;
export const OCEAN_ARCH_THICKNESS = 1.2;
export const OCEAN_ARCH_HEIGHT = 0.9;

/** Round blockers (r, θ, kind): coral pillars (`coral`, tall) and rock outcrops (`rock`, wider, shorter). */
const OCEAN_BLOCKER_DATA: readonly (readonly [number, number, 'coral' | 'rock'])[] = [
  // plateau
  [4, 0, 'coral'],
  [4, 126, 'coral'],
  [4, 234, 'coral'],
  // terrace: none (the strips between a pillar and the ramp walls would be too narrow for the big animals: dead pockets)
  // seabed
  [25.5, 42, 'rock'],
  [23.5, 148.5, 'rock'],
  [26.4, 171, 'coral'],
];

/** Low coral arches (jumpable segments, laid tangentially at radius r, angle θ). */
const OCEAN_ARCH_DATA: readonly (readonly [number, number])[] = [
  [15.5, 207],
  [10.5, 36],
  [26.5, 288],
];

function oceanArch(r: number, deg: number): ArenaSegment {
  const c = pol(r, deg);
  const tx = -Math.sin(deg * DEG);
  const tz = Math.cos(deg * DEG);
  const h = OCEAN_ARCH_LENGTH / 2;
  return tagSegment(
    {
      shape: 'segment',
      ax: r4(c.x - tx * h),
      az: r4(c.z - tz * h),
      bx: r4(c.x + tx * h),
      bz: r4(c.z + tz * h),
      thickness: OCEAN_ARCH_THICKNESS,
      height: OCEAN_ARCH_HEIGHT,
      jumpable: true,
      baseY: oceanBase(c.x, c.z),
    },
    'arch',
  );
}

/** Anchor of an L-pile whose centre (anchor + 0.525 on both axes) lies at polar (r, deg). */
function crateAnchor(r: number, deg: number): SpawnPoint {
  const c = pol(r, deg);
  return { x: r4(c.x - 0.525), z: r4(c.z - 0.525) };
}

/** Crate clusters (anchor of the L-pile, same pile shape as the other arenas): two on the terrace, two on the seabed. */
const OCEAN_CRATE_ANCHORS: readonly SpawnPoint[] = [
  crateAnchor(12.5, 264),
  crateAnchor(13, 312),
  crateAnchor(26, 136.5),
  crateAnchor(26, 30),
];

const OCEAN_SPAWNS = ringPoints(24, 10, 270);

/** Pads: the centre plateau (id 0), the three stack tops, two on the terrace, three on the seabed. */
const OCEAN_PAD_DATA: readonly SpawnPoint[] = [
  { x: 0, z: 0 },
  ...OCEAN_STACKS.map((s): SpawnPoint => ({ x: s.x, z: s.z })),
  pol(16, 253.5),
  pol(15, 4.5),
  pol(21.9, 36),
  pol(25.5, 72),
  pol(25.5, 180),
];

export const OCEAN_ARENA: ArenaDef = makeArena({
  id: 'ocean',
  name: 'Ocean Dome',
  blurb: 'A glass dome on the sea floor: three levels, towers to climb, two serpents, and a long way down.',
  wallRadius: 30,
  wallHeight: 5,
  standsInner: 31,
  standsOuter: 44,
  circles: OCEAN_BLOCKER_DATA.map(([r, deg, kind]) => {
    const p = pol(r, deg);
    return tagCircle(
      {
        shape: 'circle',
        x: p.x,
        z: p.z,
        radius: kind === 'coral' ? OCEAN_CORAL_RADIUS : OCEAN_ROCK_RADIUS,
        height: kind === 'coral' ? OCEAN_CORAL_HEIGHT : OCEAN_ROCK_HEIGHT,
        walkable: false,
        jumpable: false,
        baseY: oceanBase(p.x, p.z),
      },
      kind,
    );
  }),
  segments: OCEAN_ARCH_DATA.map(([r, deg]) => oceanArch(r, deg)),
  crates: OCEAN_CRATE_ANCHORS.flatMap((c) =>
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
          baseY: oceanBase(c.x + o.x, c.z + o.z),
        },
        'crate',
      ),
    ),
  ),
  pickupPads: OCEAN_PAD_DATA.map((p, i): PickupPad => ({ id: i, x: p.x, z: p.z })),
  spawns: OCEAN_SPAWNS,
  spawnRing: 24,
  spawnStartDeg: 270,
  spawnLayout: 'seats',
  terrain: [],
  heightfield: OCEAN_HEIGHTFIELD,
  hazards: {
    serpent: true,
    serpentSplitY: OCEAN_SERPENT_SPLIT_Y,
    fallDamage: { minDrop: OCEAN_FALL_MIN_DROP, damage: OCEAN_FALL_DAMAGE },
  },
  // Tighter gaps than the colosseum (ramps, wedges, cliffs and cover leave little flat ground): a trap disc must also lie wholly on ONE flat
  // level (trapSiteValid → arenaIsLevel, +0.25 m margin), so none sits on a ramp or at a level edge. v1.10: the stacks' ramps took a big
  // bite out of the terrace, so the clearances shrank again (0.6/1.5/2.0/3.0 → 0.3/0.8/1.0/2.0). Valid sites remain on the terrace (a few) and
  // the seabed (most; never on a stack top: the disc test is conservative at the terrace rim); every difficulty places its full count for
  // every tested seed (1500 per difficulty measured).
  trapRules: {
    overrides: { obstacleClear: 0.3, pickupClear: 0.8, spawnClear: 1.0, trapClear: 2.0, maxRadius: 27.5 },
    exclusions: [],
    terrainClear: 0.5,
  },
});

/** Every arena by id. (Adding an arena: extend `ArenaId`/`ARENA_IDS` in core/types and add it here.) */
export const ARENAS: Record<ArenaId, ArenaDef> = {
  colosseum: COLOSSEUM_ARENA,
  jungle: JUNGLE_ARENA,
  ocean: OCEAN_ARENA,
};
