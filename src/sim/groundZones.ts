/**
 * Persistent ground zones (v1.3 hippo mud). A tiny, self-contained system for hazards that outlive the
 * ultimate that created them: World owns one {@link GroundZoneSystem} (`sim.groundZones`) and steps it once
 * per tick after movement. The only zone kind so far is the hippo's MUD POOL (Riverlord's Flood): an oriented
 * rectangle along a path that is laid as the wave passes (`growS`) and slows grounded fighters until it
 * expires (`lifeS`).
 *
 * Rules
 *  - Deterministic: zones tick in creation order, fighters in ascending id, ages advance by `dt` only.
 *  - A fighter is slowed while its body circle overlaps the part of the rectangle laid so far AND it is low
 *    enough (`groundedAlt`, default 0.6 m; flyers / high jumps are not slowed) and not untargetable (burrowed).
 *  - The slow is a normal `slow` buff refreshed to `slowLingerS` each tick (the mud clings to the legs for
 *    that long after leaving / expiry). A stronger slow already running (e.g. from another source) is kept.
 *  - `ownerSlow` is the slow fraction the zone's owner feels (the hippo wades through its own mud: 0).
 *  - No damage, no events: the renderer draws the pool from the ultimate's `ultimateTarget`/`ultimateStage`.
 */

import type { Fighter, Sim } from './Fighter';
import { altitudeOf } from './hitbox';
import { addBuff, getBuff } from './StatusEffects';

export type GroundZoneKind = 'mud';

/** Live zone (mutated in place by {@link GroundZoneSystem.update}). */
export interface GroundZone {
  id: number;
  kind: GroundZoneKind;
  ownerId: number;
  /** Start of the path (x, z) and unit direction. */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Full path length (m) and half width (m). */
  len: number;
  halfWidth: number;
  /** Seconds since the zone was laid. */
  age: number;
  /** Seconds the pool takes to be laid out to its full length (0 = instantly). */
  growS: number;
  /** Total lifetime (s); the zone is removed when `age >= lifeS`. */
  lifeS: number;
  /** Slow fraction for everybody else / for the owner. */
  slow: number;
  ownerSlow: number;
  /** Seconds a slow buff lingers once applied. */
  slowLingerS: number;
  /** Fighters at or below this altitude (m) are slowed. */
  groundedAlt: number;
}

export interface GroundZoneSpec {
  kind: GroundZoneKind;
  ownerId: number;
  ax: number;
  az: number;
  /** Direction (need not be normalised). */
  dx: number;
  dz: number;
  len: number;
  halfWidth: number;
  growS?: number;
  lifeS: number;
  slow: number;
  ownerSlow?: number;
  slowLingerS?: number;
  groundedAlt?: number;
}

/** Length (m) of the pool that has been laid so far. */
export function zoneExtent(z: GroundZone): number {
  if (z.growS <= 1e-9) return z.len;
  const u = z.age / z.growS;
  return z.len * (u >= 1 ? 1 : u <= 0 ? 0 : u);
}

/** Does a body circle (x, zc, radius r) overlap the laid part of the zone's rectangle? (XZ only.) */
export function zoneOverlaps(z: GroundZone, x: number, zc: number, r: number): boolean {
  const rx = x - z.ax;
  const rz = zc - z.az;
  const along = rx * z.dx + rz * z.dz;
  const lat = Math.abs(rx * z.dz - rz * z.dx);
  if (lat > z.halfWidth + r) return false;
  return along >= -r && along <= zoneExtent(z) + r;
}

export class GroundZoneSystem {
  /** Live zones in creation order (compacted in place each update). */
  readonly list: GroundZone[] = [];
  private nextId = 0;

  get count(): number {
    return this.list.length;
  }

  /** Lay a zone; returns its id. */
  spawn(spec: GroundZoneSpec): number {
    const id = this.nextId++;
    const n = Math.hypot(spec.dx, spec.dz);
    const inv = n > 1e-9 ? 1 / n : 0;
    this.list.push({
      id,
      kind: spec.kind,
      ownerId: spec.ownerId,
      ax: spec.ax,
      az: spec.az,
      dx: n > 1e-9 ? spec.dx * inv : 0,
      dz: n > 1e-9 ? spec.dz * inv : 1,
      len: spec.len,
      halfWidth: spec.halfWidth,
      age: 0,
      growS: spec.growS ?? 0,
      lifeS: spec.lifeS,
      slow: spec.slow,
      ownerSlow: spec.ownerSlow ?? 0,
      slowLingerS: spec.slowLingerS ?? 0.3,
      groundedAlt: spec.groundedAlt ?? 0.6,
    });
    return id;
  }

  /** Zones of `kind` that a body circle at (x, z) overlaps right now. Allocates (tests / AI / debug only). */
  zonesAt(x: number, z: number, r: number, kind?: GroundZoneKind): GroundZone[] {
    const out: GroundZone[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const g = this.list[i];
      if (kind !== undefined && g.kind !== kind) continue;
      if (zoneOverlaps(g, x, z, r)) out.push(g);
    }
    return out;
  }

  /** Advance every zone one tick: age, expire, slow the fighters standing in them. */
  update(sim: Sim, dt: number): void {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      z.age += dt;
      if (z.age >= z.lifeS) continue; // expired: dropped by the compaction below
      list[w++] = z;
      if (z.kind === 'mud') applyMud(sim, z);
    }
    list.length = w;
  }

  clear(): void {
    this.list.length = 0;
  }
}

function applyMud(sim: Sim, z: GroundZone): void {
  const fs = sim.fighters;
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i];
    if (!f.state.alive || f.untargetable) continue;
    if (altitudeOf(f) > z.groundedAlt) continue;
    if (!zoneOverlaps(z, f.state.pos.x, f.state.pos.z, f.def.radius)) continue;
    const mag = f.id === z.ownerId ? z.ownerSlow : z.slow;
    if (mag <= 0) continue;
    refreshSlow(f, mag, z.slowLingerS);
  }
}

/** Refresh a slow buff; a stronger slow from another source is left alone. */
function refreshSlow(f: Fighter, mag: number, dur: number): void {
  const cur = getBuff(f, 'slow');
  if (cur !== undefined && cur.mag > mag) return;
  addBuff(f, 'slow', mag, dur);
}

/** Lay a zone through `sim.groundZones`; a no-op (-1) for minimal test Sims without the system. */
export function spawnGroundZone(sim: Sim, spec: GroundZoneSpec): number {
  return sim.groundZones !== undefined ? sim.groundZones.spawn(spec) : -1;
}
