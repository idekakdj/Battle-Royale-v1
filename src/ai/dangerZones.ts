/**
 * Danger zones (v1.3 AI hook) — generic avoidance of enemy ultimates.
 *
 * Bots only know what a player could know, so zones are built from the
 * reaction-delayed event stream (`Perception.ready`): the `ultimateTarget` event
 * (and, as a provisional fallback, the ultimate `telegraph`) of ANOTHER fighter
 * whose ultimate spec opts in with `targeting.dodge` (see config `UltDodge`;
 * today's placeholder ultimates do not, so today's behaviour is unchanged).
 *
 *   ground  circle at `to`, radius width/2
 *   line    capsule `from`→`to`, half-width width/2
 *   lock    circle at the victim (`to`), radius `dodge.radius` (default 1.6 m)
 *   self    circle at the caster (`from`), radius width/2
 *
 * A zone lives `windup + activeS` seconds counted from when the event was EMITTED
 * (release time minus the bot's reaction latency). `mode: 'commit'` zones are a
 * tracking reticle: `ultimateStage` stage 0 = still tracking (not dodged), stage 1 =
 * committed at `pos` (dodge now), stage >= 2 = over. See docs/ultimates/ai-hooks.md.
 *
 * Difficulty policy (`BotProfile.ultDodge`): never (L1) / lazy (L2: only after one
 * more reaction time and only if an exit is < 2 m) / reliable (L3) / strict (L4: also
 * never walks into an active zone). Exits never lead into other zones, armed/active
 * traps, pillars or the wall. No RNG, no allocation on the per-tick paths.
 */

import type { AnimalId, GameEvent, TrapState } from '../core/types';
import { ANIMALS } from '../config/animals';
import { PILLARS, WALL_RADIUS } from '../config/arena';
import { setDir, type Move2 } from './Steering';

/** Default radius (m) of a lock-kind zone around its victim. */
export const LOCK_ZONE_RADIUS = 1.6;
/** Default seconds a zone stays after its windup. */
export const DEFAULT_ACTIVE_S = 0.3;
/** Default seconds a committed reticle stays dangerous. */
export const DEFAULT_COMMIT_S = 0.6;
/** `commit`-mode zones default to this generous cap (s after the windup) so the tracking phase is not pruned before the commit beat; a stage >= 2 beat removes them. */
export const DEFAULT_TRACK_CAP_S = 3;
/** `lazy` (L2) only dodges when the exit is closer than this (m). */
export const LAZY_MAX_EXIT_M = 2.0;

const EXIT_DIRS = 16;
const EXIT_STEP = 0.25;
const EXIT_MAX = 12;
const EXIT_MARGIN = 0.2;
const AVOID_PROBE = 3.0;
const AVOID_SAMPLES = 6;

export type ZoneShape = 'circle' | 'capsule';

/** One live danger zone. Circle: centre (ax,az); capsule: segment (ax,az)-(bx,bz); `r` = radius / half-width. */
export interface DangerZone {
  /** Unique per caster (one live ultimate at a time): registering the same key replaces. */
  key: number;
  /** Caster fighter id (-1 for a synthetic zone). */
  sourceId: number;
  shape: ZoneShape;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  /** Bot-time the bot learned of the zone (event release time). */
  knownAt: number;
  /** Bot-time the hazard is over. */
  expiresAt: number;
  /** false while a `commit`-mode reticle is still tracking its victim: not dodged yet. */
  committed: boolean;
  mode: 'fixed' | 'commit';
  /** Seconds a committed reticle stays dangerous after the commit beat. */
  commitS: number;
}

/** Fields needed to register a zone by hand (tests, ult modules, future hooks). */
export interface DangerZoneInit {
  key: number;
  sourceId?: number;
  shape: ZoneShape;
  ax: number;
  az: number;
  /** Capsule end (defaults to the start). */
  bx?: number;
  bz?: number;
  r: number;
  knownAt: number;
  expiresAt: number;
  committed?: boolean;
  mode?: 'fixed' | 'commit';
  commitS?: number;
}

/** Result of {@link DangerZones.nearestExit}. */
export interface ZoneExit {
  /** Unit heading toward the exit. */
  dx: number;
  dz: number;
  /** Distance (m) to travel to reach it. */
  dist: number;
  /** Landing point. */
  x: number;
  z: number;
}

export function makeExit(): ZoneExit {
  return { dx: 0, dz: 0, dist: 0, x: 0, z: 0 };
}

/** Signed distance (m) from (x,z) to the zone's shape: negative inside. */
export function zoneDist(z: DangerZone, x: number, pz: number): number {
  if (z.shape === 'circle') return Math.hypot(x - z.ax, pz - z.az) - z.r;
  return distToSeg(x, pz, z.ax, z.az, z.bx, z.bz) - z.r;
}

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const lenSq = ex * ex + ez * ez;
  let t = lenSq > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + ex * t), pz - (az + ez * t));
}

/** Closest point of the zone's core (centre / segment) to (px,pz), written to `out`. */
function coreClosest(z: DangerZone, px: number, pz: number, out: Move2): void {
  if (z.shape === 'circle') {
    out.x = z.ax;
    out.z = z.az;
    return;
  }
  const ex = z.bx - z.ax;
  const ez = z.bz - z.az;
  const lenSq = ex * ex + ez * ez;
  let t = lenSq > 1e-9 ? ((px - z.ax) * ex + (pz - z.az) * ez) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  out.x = z.ax + ex * t;
  out.z = z.az + ez * t;
}

const SCRATCH: Move2 = { x: 0, z: 0 };

export class DangerZones {
  /** Live zones, registration order. */
  readonly list: DangerZone[] = [];

  get count(): number {
    return this.list.length;
  }

  /** Add (or replace, by `key`) a zone. */
  registerZone(init: DangerZoneInit): DangerZone {
    const zone: DangerZone = {
      key: init.key,
      sourceId: init.sourceId ?? -1,
      shape: init.shape,
      ax: init.ax,
      az: init.az,
      bx: init.bx ?? init.ax,
      bz: init.bz ?? init.az,
      r: init.r,
      knownAt: init.knownAt,
      expiresAt: init.expiresAt,
      committed: init.committed ?? true,
      mode: init.mode ?? 'fixed',
      commitS: init.commitS ?? DEFAULT_COMMIT_S,
    };
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].key === zone.key) {
        this.list[i] = zone;
        return zone;
      }
    }
    this.list.push(zone);
    return zone;
  }

  removeZone(key: number): void {
    for (let i = 0; i < this.list.length; i++) {
      if (this.list[i].key === key) {
        this.list.splice(i, 1);
        return;
      }
    }
  }

  removeBySource(sourceId: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].sourceId === sourceId) this.list.splice(i, 1);
  }

  find(key: number): DangerZone | undefined {
    for (let i = 0; i < this.list.length; i++) if (this.list[i].key === key) return this.list[i];
    return undefined;
  }

  /** Drop expired zones. */
  prune(now: number): void {
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const z = this.list[i];
      if (now < z.expiresAt) this.list[w++] = z;
    }
    this.list.length = w;
  }

  /** A zone counts (for dodging / avoidance) when it is committed and not over. */
  isLive(z: DangerZone, now: number): boolean {
    return z.committed && now < z.expiresAt;
  }

  /**
   * Live zones containing a body of radius `pad` at (x,z). Allocates (convenience
   * API); hot paths use {@link insideAny} / {@link earliestKnown}.
   */
  zonesAt(x: number, z: number, now: number, pad = 0): DangerZone[] {
    const out: DangerZone[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const zn = this.list[i];
      if (this.isLive(zn, now) && zoneDist(zn, x, z) <= pad) out.push(zn);
    }
    return out;
  }

  insideAny(x: number, z: number, pad: number, now: number): boolean {
    for (let i = 0; i < this.list.length; i++) {
      const zn = this.list[i];
      if (this.isLive(zn, now) && zoneDist(zn, x, z) <= pad) return true;
    }
    return false;
  }

  /** `knownAt` of the earliest-known live zone containing the body, or +Infinity when none. */
  earliestKnown(x: number, z: number, pad: number, now: number): number {
    let best = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const zn = this.list[i];
      if (this.isLive(zn, now) && zoneDist(zn, x, z) <= pad && zn.knownAt < best) best = zn.knownAt;
    }
    return best;
  }

  /**
   * Shortest way out. Marches 16 headings in fixed order until the body is clear of
   * EVERY live zone (+ a small margin) and keeps the shortest landing that is inside
   * the arena and not in a pillar or an armed/active trap (`traps`); ties keep the
   * earlier heading. Falls back to the shortest zone-free landing when every clean
   * one is blocked. Returns false when the body is not inside a zone (or no exit
   * within 12 m exists); otherwise fills `out`.
   */
  nearestExit(x: number, z: number, pad: number, now: number, out: ZoneExit, traps?: readonly TrapState[]): boolean {
    if (!this.insideAny(x, z, pad, now)) return false;
    let bestClean = Infinity;
    let bestAny = Infinity;
    let cleanI = -1;
    let anyI = -1;
    let cleanX = 0;
    let cleanZ = 0;
    let anyX = 0;
    let anyZ = 0;
    for (let i = 0; i < EXIT_DIRS; i++) {
      const ang = (i * 2 * Math.PI) / EXIT_DIRS;
      const ux = Math.sin(ang);
      const uz = Math.cos(ang);
      let d = 0;
      let px = x;
      let pz = z;
      let found = false;
      while (d < EXIT_MAX) {
        d += EXIT_STEP;
        px = x + ux * d;
        pz = z + uz * d;
        if (!this.insideAny(px, pz, pad + EXIT_MARGIN, now)) {
          found = true;
          break;
        }
      }
      if (!found) continue;
      // Refine the crossing between the last inside step and the first outside one.
      let lo = d - EXIT_STEP;
      let hi = d;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) * 0.5;
        if (this.insideAny(x + ux * mid, z + uz * mid, pad + EXIT_MARGIN, now)) lo = mid;
        else hi = mid;
      }
      d = hi;
      px = x + ux * d;
      pz = z + uz * d;
      if (d < bestAny - 1e-9) {
        bestAny = d;
        anyI = i;
        anyX = px;
        anyZ = pz;
      }
      if (d < bestClean - 1e-9 && landingClean(px, pz, pad, traps)) {
        bestClean = d;
        cleanI = i;
        cleanX = px;
        cleanZ = pz;
      }
    }
    const i = cleanI >= 0 ? cleanI : anyI;
    if (i < 0) return false;
    const ang = (i * 2 * Math.PI) / EXIT_DIRS;
    out.dx = Math.sin(ang);
    out.dz = Math.cos(ang);
    out.dist = cleanI >= 0 ? bestClean : bestAny;
    out.x = cleanI >= 0 ? cleanX : anyX;
    out.z = cleanI >= 0 ? cleanZ : anyZ;
    return true;
  }

  /**
   * Feed one reaction-delayed event (already released by Perception at bot-time
   * `now`). `reactionS` converts the release time back to the emission time.
   * Only OTHER fighters' ultimates whose spec sets `targeting.dodge` matter.
   */
  ingest(ev: GameEvent, now: number, reactionS: number, selfId: number, animalOf: (id: number) => AnimalId | undefined): void {
    switch (ev.type) {
      case 'ultimateTarget': {
        if (ev.fighterId === selfId) return;
        const dodge = ANIMALS[ev.animal].ultimate.targeting?.dodge;
        if (dodge === undefined) return;
        const t0 = now - reactionS;
        let shape: ZoneShape = 'circle';
        let ax = ev.to.x;
        let az = ev.to.z;
        let bx = ax;
        let bz = az;
        let r = ev.width * 0.5;
        if (ev.kind === 'line') {
          shape = 'capsule';
          ax = ev.from.x;
          az = ev.from.z;
          bx = ev.to.x;
          bz = ev.to.z;
        } else if (ev.kind === 'lock') {
          r = dodge.radius ?? LOCK_ZONE_RADIUS;
        } else if (ev.kind === 'self') {
          ax = ev.from.x;
          az = ev.from.z;
          bx = ax;
          bz = az;
        }
        this.registerZone({
          key: ev.fighterId,
          sourceId: ev.fighterId,
          shape,
          ax,
          az,
          bx,
          bz,
          r,
          knownAt: now,
          expiresAt: t0 + ev.windup + (dodge.activeS ?? (dodge.mode === 'commit' ? DEFAULT_TRACK_CAP_S : DEFAULT_ACTIVE_S)),
          committed: dodge.mode === 'fixed',
          mode: dodge.mode,
          commitS: dodge.commitS ?? DEFAULT_COMMIT_S,
        });
        return;
      }
      case 'ultimateStage': {
        const zn = this.find(ev.fighterId);
        if (zn === undefined || zn.mode !== 'commit' || ev.fighterId === selfId) return;
        if (ev.stage >= 2) {
          this.removeZone(zn.key);
          return;
        }
        zn.ax = ev.pos.x;
        zn.az = ev.pos.z;
        zn.bx = ev.pos.x;
        zn.bz = ev.pos.z;
        if (ev.stage === 1) {
          zn.committed = true;
          zn.knownAt = now;
          zn.expiresAt = now - reactionS + zn.commitS;
        }
        return;
      }
      case 'telegraph': {
        // Provisional circle for opted-in ultimates; the `ultimateTarget` that follows in
        // the same batch replaces it (same key).
        if (ev.kind !== 'ultimate' || ev.fighterId === selfId) return;
        const animal = animalOf(ev.fighterId);
        if (animal === undefined) return;
        const dodge = ANIMALS[animal].ultimate.targeting?.dodge;
        if (dodge === undefined) return;
        this.registerZone({
          key: ev.fighterId,
          sourceId: ev.fighterId,
          shape: 'circle',
          ax: ev.pos.x,
          az: ev.pos.z,
          r: ev.radius,
          knownAt: now,
          expiresAt: now - reactionS + ev.windup + (dodge.activeS ?? (dodge.mode === 'commit' ? DEFAULT_TRACK_CAP_S : DEFAULT_ACTIVE_S)),
          committed: dodge.mode === 'fixed',
          mode: dodge.mode,
          commitS: dodge.commitS ?? DEFAULT_COMMIT_S,
        });
        return;
      }
      case 'death':
        this.removeBySource(ev.targetId);
        return;
      default:
        return;
    }
  }
}

/** Landing point sanity: inside the arena, clear of pillars and armed/active traps. */
function landingClean(px: number, pz: number, pad: number, traps: readonly TrapState[] | undefined): boolean {
  if (Math.hypot(px, pz) > WALL_RADIUS - pad - 0.3) return false;
  for (let i = 0; i < PILLARS.length; i++) {
    const p = PILLARS[i];
    if (Math.hypot(px - p.x, pz - p.z) < p.radius + pad + 0.2) return false;
  }
  if (traps !== undefined) {
    for (let i = 0; i < traps.length; i++) {
      const t = traps[i];
      if (t.phase === 'cooldown') continue; // spent plate: safe
      if (Math.hypot(px - t.pos.x, pz - t.pos.z) < t.radius + pad + 0.3) return false;
    }
  }
  return true;
}

/**
 * Apex: bend `out` away from live zones on the path ahead so the bot never walks
 * into an active zone (feelers like `avoidTraps`). Returns true when bent.
 */
export function avoidDangerZones(out: Move2, sx: number, sz: number, selfRadius: number, zones: DangerZones, now: number): boolean {
  if ((out.x === 0 && out.z === 0) || zones.count === 0) return false;
  const margin = selfRadius + 0.5;
  let ax = out.x;
  let az = out.z;
  let bent = false;
  for (let i = 0; i < zones.list.length; i++) {
    const zn = zones.list[i];
    if (!zones.isLive(zn, now)) continue;
    for (let k = 1; k <= AVOID_SAMPLES; k++) {
      const t = (AVOID_PROBE * k) / AVOID_SAMPLES;
      const px = sx + out.x * t;
      const pz = sz + out.z * t;
      const d = zoneDist(zn, px, pz);
      if (d >= margin) continue;
      coreClosest(zn, px, pz, SCRATCH);
      let dx = px - SCRATCH.x;
      let dz = pz - SCRATCH.z;
      let len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        // Heading dead-centre: sidestep perpendicular to the heading.
        dx = -out.z;
        dz = out.x;
        len = 1;
      }
      const push = ((margin - d) / margin) * 2.2;
      ax += (dx / len) * push;
      az += (dz / len) * push;
      bent = true;
    }
  }
  if (bent) setDir(out, ax, az);
  return bent;
}
