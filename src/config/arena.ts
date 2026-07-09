/**
 * Arena layout (BLUEPRINT §9). Exact geometry for the sim's collision system
 * (WP-B) and the stadium renderer (WP-D). All positions are in world XZ metres.
 *
 * Angle convention for ring placement: `x = r·cos(θ)`, `z = r·sin(θ)` with θ in
 * degrees. This is a pure layout convention and is independent of the fighter
 * yaw convention used elsewhere.
 */

/** Collision shape tags (BLUEPRINT §7.8). */
export type ObstacleShape = 'circle' | 'segment' | 'aabb';

/** Upright cylinder collider (pillars) or walkable disc (dais). */
export interface CircleObstacle {
  shape: 'circle';
  x: number;
  z: number;
  radius: number;
  height: number;
  /** Walkable step-up surface rather than a blocker (the central dais). */
  walkable: boolean;
  /** Low enough to clear with a jump. */
  jumpable: boolean;
}

/** Capsule-like low wall between two endpoints (fallen columns). */
export interface SegmentObstacle {
  shape: 'segment';
  ax: number;
  az: number;
  bx: number;
  bz: number;
  thickness: number;
  height: number;
  jumpable: boolean;
}

/** Axis-aligned box collider (crates). */
export interface AabbObstacle {
  shape: 'aabb';
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  height: number;
  destructible: boolean;
  hp: number;
}

export type Obstacle = CircleObstacle | SegmentObstacle | AabbObstacle;

/** Round to 4 decimals so ring maths reads cleanly and stays deterministic. */
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

interface RingPoint {
  x: number;
  z: number;
}

/** `count` points evenly around a ring of radius `r`, first at `startDeg`. */
function ring(r: number, count: number, startDeg: number): RingPoint[] {
  const out: RingPoint[] = [];
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    const rad = ((startDeg + i * step) * Math.PI) / 180;
    out.push({ x: r4(r * Math.cos(rad)), z: r4(r * Math.sin(rad)) });
  }
  return out;
}

// ── Arena bounds & floor (§9) ────────────────────────────────────────────────
/** Sand floor / stone-wall radius (m); the wall is a hard circular clamp. */
export const WALL_RADIUS = 30;
/** Stone wall height (m). */
export const WALL_HEIGHT = 5;
/** Crowd stands inner/outer radius (cosmetic, WP-D). */
export const STANDS_INNER = 31;
export const STANDS_OUTER = 44;

// ── Pillars: 6 × (r=1.2, h=4) at radius 15, every 60° from 0° (§9) ────────────
export const PILLAR_RADIUS = 1.2;
export const PILLAR_HEIGHT = 4;
export const PILLARS: readonly CircleObstacle[] = ring(15, 6, 0).map((p) => ({
  shape: 'circle',
  x: p.x,
  z: p.z,
  radius: PILLAR_RADIUS,
  height: PILLAR_HEIGHT,
  walkable: false,
  jumpable: false,
}));

// ── Fallen columns: 2 low jumpable walls, thickness 1.0, h=0.9 (§9) ──────────
export const FALLEN_COLUMN_THICKNESS = 1.0;
export const FALLEN_COLUMN_HEIGHT = 0.9;
export const FALLEN_COLUMNS: readonly SegmentObstacle[] = [
  {
    shape: 'segment',
    ax: -8,
    az: 0,
    bx: -2,
    bz: 4,
    thickness: FALLEN_COLUMN_THICKNESS,
    height: FALLEN_COLUMN_HEIGHT,
    jumpable: true,
  },
  {
    shape: 'segment',
    ax: 3,
    az: -6,
    bx: 9,
    bz: -3,
    thickness: FALLEN_COLUMN_THICKNESS,
    height: FALLEN_COLUMN_HEIGHT,
    jumpable: true,
  },
];

// ── Crate clusters: 4 clusters near (±7, ±7); 3 crates of 1 m³, 150 HP (§9) ──
export const CRATE_HP = 150;
export const CRATE_SIZE = 1; // 1 m³ cube → half-extent 0.5
export const CRATE_HALF = CRATE_SIZE / 2;
/** Cluster anchor offsets. */
export const CRATE_CLUSTER_CENTERS: readonly RingPoint[] = [
  { x: 7, z: 7 },
  { x: -7, z: 7 },
  { x: -7, z: -7 },
  { x: 7, z: -7 },
];

/** Per-cluster crate offsets (an L-pile); spacing 1.05 m avoids AABB overlap. */
const CRATE_OFFSETS: readonly RingPoint[] = [
  { x: 0, z: 0 },
  { x: 1.05, z: 0 },
  { x: 0, z: 1.05 },
];

/** All 12 crates (4 clusters × 3), array order defines runtime crate id. */
export const CRATES: readonly AabbObstacle[] = CRATE_CLUSTER_CENTERS.flatMap((c) =>
  CRATE_OFFSETS.map<AabbObstacle>((o) => ({
    shape: 'aabb',
    x: r4(c.x + o.x),
    z: r4(c.z + o.z),
    halfX: CRATE_HALF,
    halfZ: CRATE_HALF,
    height: CRATE_SIZE,
    destructible: true,
    hp: CRATE_HP,
  })),
);

// ── Central dais: stone disc r=4, h=0.6, walkable step-up (§9) ────────────────
export const DAIS: CircleObstacle = {
  shape: 'circle',
  x: 0,
  z: 0,
  radius: 4,
  height: 0.6,
  walkable: true,
  jumpable: false,
};

// ── Pickup pads: 6 at radius 10, every 60°, offset 30° from pillars (§9) ──────
export interface PickupPad {
  id: number;
  x: number;
  z: number;
}
export const PICKUP_PAD_RING_RADIUS = 10;
export const PICKUP_PADS: readonly PickupPad[] = ring(10, 6, 30).map((p, i) => ({
  id: i,
  x: p.x,
  z: p.z,
}));

// ── Cosmetic gates at N/E/S/W (WP-D) ─────────────────────────────────────────
export const GATE_ANGLES_DEG: readonly number[] = [90, 0, 270, 180]; // N, E, S, W

/**
 * All SOLID colliders (pillars, fallen columns, crates). The dais is walkable
 * and excluded; the arena wall is a separate circular clamp at {@link WALL_RADIUS}.
 * Crates are included but the sim removes them from collision when destroyed.
 */
export const SOLID_OBSTACLES: readonly Obstacle[] = [...PILLARS, ...FALLEN_COLUMNS, ...CRATES];
