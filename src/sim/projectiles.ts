/**
 * Projectile system (v1.3): spawn / update / collide, deterministic and
 * allocation-light (no per-tick allocation except at impact/snapshot time).
 * World owns one {@link ProjectileSystem} (`sim.projectiles`), steps it once per
 * tick after movement, and exposes it as `snapshot.projectiles`. Nothing spawns
 * projectiles yet — gorilla's Boulder Hurl (v1.3 §3) will use {@link spawnProjectile}.
 *
 * A projectile flies ballistically (exact constant-gravity integration, sub-stepped
 * so a fast small body cannot tunnel) and stops at the FIRST thing it touches:
 *   1. a fighter (body circle overlap in XZ + vertical overlap; owner is always
 *      excluded; untargetable fighters — burrowed, mid-dive — are skipped, and a
 *      fighter that has jumped/flown clear of the flight height is missed);
 *   2. a live crate (broken outright when `breaksCrates`, the default);
 *   3. a static obstacle (pillars, fallen columns);
 *   4. the arena wall;
 *   5. the ground.
 * Or it `expired` (max life reached / left the arena bowl). On impact the spec's
 * `onImpact` callback runs (apply damage/splash there — this module deals none),
 * then a `projectileImpact` event is emitted (not for `expired`).
 */

import type { ProjectileState, Vec3 } from '../core/types';
import type { Fighter, Sim } from './Fighter';
import { isTargetable } from './hitbox';
import { groundHeightAt } from './MovementSystem';

export type ProjectileKind = ProjectileState['kind'];

/** What stopped a projectile. */
export type ProjectileHitKind = 'fighter' | 'crate' | 'obstacle' | 'wall' | 'ground' | 'expired';

/** Impact description handed to `onImpact` (allocated once per impact). */
export interface ProjectileHit {
  kind: ProjectileHitKind;
  /** Fighter struck (-1 for anything else). */
  fighterId: number;
  pos: Vec3;
}

/** Live projectile (mutated in place by {@link ProjectileSystem.update}). */
export interface ProjectileRuntime {
  id: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  ownerId: number;
  /** Downward acceleration (m/s²). */
  gravity: number;
  /** Seconds of flight left. */
  life: number;
  /** Radius reported in `projectileImpact` (VFX / splash), defaults to `radius`. */
  impactRadius: number;
  breaksCrates: boolean;
  alive: boolean;
  onImpact: ((sim: Sim, p: ProjectileRuntime, hit: ProjectileHit) => void) | null;
}

export interface ProjectileSpec {
  kind: ProjectileKind;
  ownerId: number;
  pos: Vec3;
  vel: Vec3;
  /** Collision radius (m). */
  radius: number;
  /** Downward acceleration (m/s²), default 0 (straight flight). */
  gravity?: number;
  /** Max flight time (s), default 6. */
  maxLife?: number;
  /** Radius reported in the impact event, default `radius`. */
  impactRadius?: number;
  /** Break crates on contact (default true). */
  breaksCrates?: boolean;
  /** Called once when the projectile stops (before the event). Apply damage here. */
  onImpact?: (sim: Sim, p: ProjectileRuntime, hit: ProjectileHit) => void;
}

/** Vertical extent (m) of a fighter's body above `pos.y` for projectile hits. */
export function bodyHeight(f: Fighter): number {
  return f.def.id === 'giraffe' ? 3.4 : 1.7;
}

const DEFAULT_LIFE = 6;
const MAX_SUBSTEPS = 16;
const MIN_SUBSTEP = 0.15;

export class ProjectileSystem {
  /** Live projectiles in spawn order (compacted in place each update). */
  readonly list: ProjectileRuntime[] = [];
  private nextId = 0;

  get count(): number {
    return this.list.length;
  }

  /** Add a projectile; returns its id. */
  spawn(spec: ProjectileSpec): number {
    const id = this.nextId++;
    this.list.push({
      id,
      kind: spec.kind,
      x: spec.pos.x,
      y: spec.pos.y,
      z: spec.pos.z,
      vx: spec.vel.x,
      vy: spec.vel.y,
      vz: spec.vel.z,
      radius: spec.radius,
      ownerId: spec.ownerId,
      gravity: spec.gravity ?? 0,
      life: spec.maxLife ?? DEFAULT_LIFE,
      impactRadius: spec.impactRadius ?? spec.radius,
      breaksCrates: spec.breaksCrates !== false,
      alive: true,
      onImpact: spec.onImpact ?? null,
    });
    return id;
  }

  /** Remove every projectile without impacting (round reset). */
  clear(): void {
    this.list.length = 0;
  }

  /** Advance all projectiles `dt` seconds. Callbacks may spawn more (they start flying next tick). */
  update(sim: Sim, dt: number): void {
    const L = this.list;
    const n = L.length;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const p = L[i];
      this.stepOne(sim, p, dt);
      if (p.alive) L[w++] = p;
    }
    // Keep anything spawned by an impact callback during this update.
    for (let j = n; j < L.length; j++) L[w++] = L[j];
    L.length = w;
  }

  /** Public snapshot form (fresh objects). */
  snapshot(): ProjectileState[] {
    const out: ProjectileState[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      if (!p.alive) continue;
      out.push({
        id: p.id,
        kind: p.kind,
        pos: { x: p.x, y: p.y, z: p.z },
        vel: { x: p.vx, y: p.vy, z: p.vz },
        radius: p.radius,
        ownerId: p.ownerId,
      });
    }
    return out;
  }

  private stepOne(sim: Sim, p: ProjectileRuntime, dt: number): void {
    p.life -= dt;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    const maxStep = Math.max(MIN_SUBSTEP, p.radius * 0.75);
    let n = Math.ceil((speed * dt) / maxStep);
    if (n < 1) n = 1;
    else if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      // Exact constant-gravity step (independent of the substep count).
      p.x += p.vx * h;
      p.z += p.vz * h;
      p.y += p.vy * h - 0.5 * p.gravity * h * h;
      p.vy -= p.gravity * h;
      if (this.collide(sim, p)) return;
    }
    if (p.life <= 0 || p.x * p.x + p.z * p.z > sim.arena.standsOuter * sim.arena.standsOuter) this.finish(sim, p, 'expired', -1);
  }

  /** Test one position against the world; on contact finishes the projectile and returns true. */
  private collide(sim: Sim, p: ProjectileRuntime): boolean {
    const r = p.radius;

    // 1. Fighters (nearest overlapping body wins; owner excluded).
    let hitIdx = -1;
    let hitD2 = Infinity;
    for (let i = 0; i < sim.fighters.length; i++) {
      const t = sim.fighters[i];
      if (t.id === p.ownerId || !isTargetable(t)) continue;
      const dx = t.state.pos.x - p.x;
      const dz = t.state.pos.z - p.z;
      const rr = r + t.def.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      const base = t.state.pos.y;
      if (p.y + r < base || p.y - r > base + bodyHeight(t)) continue;
      if (d2 < hitD2) {
        hitD2 = d2;
        hitIdx = i;
      }
    }
    if (hitIdx >= 0) {
      this.finish(sim, p, 'fighter', sim.fighters[hitIdx].id);
      return true;
    }

    // 2. Crates.
    for (let i = 0; i < sim.crates.length; i++) {
      const c = sim.crates[i];
      if (!c.alive || p.y - r > c.height) continue;
      if (circleOverlapsBox(p.x, p.z, r, c.x, c.z, c.halfX, c.halfZ)) {
        if (p.breaksCrates) sim.damageCrate(c, c.hp);
        this.finish(sim, p, 'crate', -1);
        return true;
      }
    }

    // 3. Static obstacles (pillars, fallen columns).
    for (let i = 0; i < sim.staticObstacles.length; i++) {
      const ob = sim.staticObstacles[i];
      if (p.y - r > ob.height) continue;
      let hit = false;
      if (ob.shape === 'circle') {
        if (ob.walkable) continue; // the dais is floor, not a blocker
        const dx = p.x - ob.x;
        const dz = p.z - ob.z;
        const rr = ob.radius + r;
        hit = dx * dx + dz * dz <= rr * rr;
      } else if (ob.shape === 'segment') {
        hit = distToSegment(p.x, p.z, ob.ax, ob.az, ob.bx, ob.bz) <= ob.thickness * 0.5 + r;
      } else {
        hit = circleOverlapsBox(p.x, p.z, r, ob.x, ob.z, ob.halfX, ob.halfZ);
      }
      if (hit) {
        this.finish(sim, p, 'obstacle', -1);
        return true;
      }
    }

    // 4. Arena wall.
    const d = Math.sqrt(p.x * p.x + p.z * p.z);
    if (d + r >= sim.arena.wallRadius && p.y - r <= sim.arena.wallHeight) {
      this.finish(sim, p, 'wall', -1);
      return true;
    }

    // 5. Ground.
    if (p.y - r <= groundHeightAt(p.x, p.z, sim.arena)) {
      p.y = groundHeightAt(p.x, p.z, sim.arena);
      this.finish(sim, p, 'ground', -1);
      return true;
    }
    return false;
  }

  private finish(sim: Sim, p: ProjectileRuntime, kind: ProjectileHitKind, fighterId: number): void {
    p.alive = false;
    const hit: ProjectileHit = { kind, fighterId, pos: { x: p.x, y: p.y, z: p.z } };
    if (p.onImpact !== null) p.onImpact(sim, p, hit);
    if (kind !== 'expired') {
      sim.emit({
        type: 'projectileImpact',
        kind: p.kind,
        pos: { x: p.x, y: p.y, z: p.z },
        radius: p.impactRadius,
        ownerId: p.ownerId,
        hitId: fighterId,
      });
    }
  }
}

/**
 * Spawn a projectile in the sim's projectile system. Returns its id, or -1 when
 * the sim has none (minimal test Sims).
 */
export function spawnProjectile(sim: Sim, spec: ProjectileSpec): number {
  return sim.projectiles !== undefined ? sim.projectiles.spawn(spec) : -1;
}

function circleOverlapsBox(px: number, pz: number, r: number, cx: number, cz: number, hx: number, hz: number): boolean {
  const qx = Math.max(cx - hx, Math.min(px, cx + hx));
  const qz = Math.max(cz - hz, Math.min(pz, cz + hz));
  const dx = px - qx;
  const dz = pz - qz;
  return dx * dx + dz * dz <= r * r;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}
