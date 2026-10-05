/**
 * Snapshot interpolation / extrapolation (pure functions, WP-N3).
 *
 * `lerpSnapshots(a, b, alpha, teleported)` builds the "view" snapshot a renderer should draw between two host snapshots:
 *   - continuous fields (position, velocity, yaw — shortest arc —, hp, guard, ult charge, cooldowns, bars, clocks) are blended;
 *   - discrete fields (action, alive, combo, buffs, ult phase/stage/target, grab links, kill counters, pickups, crates,
 *     matchOver, winnerId …) come from the EARLIER snapshot `a`;
 *   - a fighter that teleported between the two snapshots (a `blink` event with a known host time, or a jump farther than a
 *     plausible stride) is NOT interpolated: it stays at its `a` pose until the jump instant (the blink's host time, else the end
 *     of the interval) and is at its `b` pose from then on, so a blink never slides across the arena.
 */

import type { FighterState, ProjectileState, TrapState, Vec3, WorldSnapshot } from '../../core/types';
import { lerpAngle } from './tables';

/** Distance (m) between two consecutive snapshots above which a move is treated as a teleport, scaled by elapsed time. */
export const TELEPORT_MIN_DIST = 2;
/** Fastest legitimate speed (m/s) used to scale the teleport threshold with the snapshot spacing. */
export const TELEPORT_SPEED = 45;

export function teleportThreshold(dtS: number): number {
  return Math.max(TELEPORT_MIN_DIST, TELEPORT_SPEED * Math.max(0, dtS));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function cloneFighter(f: FighterState): FighterState {
  return { ...f, pos: { ...f.pos }, vel: { ...f.vel }, buffs: f.buffs.map((x) => ({ ...x })) };
}

/** Sentinel for "this fighter did not teleport" in the arrays below. */
export const NO_TELEPORT = -1;

/**
 * Per fighter: the fraction of the interval (0..1] at which it teleported, or {@link NO_TELEPORT}. `blinkMs` maps fighter id →
 * host sim time (ms) of its `blink` event inside (a.time, b.time]; otherwise a jump beyond the stride threshold counts as a
 * teleport at the END of the interval.
 */
export function detectTeleports(a: WorldSnapshot, b: WorldSnapshot, blinkMs?: ReadonlyMap<number, number>): number[] {
  const n = Math.min(a.fighters.length, b.fighters.length);
  const thr = teleportThreshold(b.time - a.time);
  const out = new Array<number>(b.fighters.length).fill(NO_TELEPORT);
  const span = (b.time - a.time) * 1000;
  for (let i = 0; i < n; i++) {
    const fa = a.fighters[i];
    const fb = b.fighters[i];
    const t = blinkMs?.get(fb.id);
    if (t !== undefined) {
      out[i] = span > 0 ? Math.max(0, Math.min(1, (t - a.time * 1000) / span)) : 1;
    } else if (dist3(fa.pos, fb.pos) > thr) {
      out[i] = 1;
    }
  }
  return out;
}

/**
 * The (prev, cur) pair a renderer should lerp at `alpha`: teleporting fighters are parked at their `a` pose before the jump
 * instant and at their `b` pose after it. Returns `a` / `b` themselves when nobody teleported.
 */
export function splitTeleports(a: WorldSnapshot, b: WorldSnapshot, fracs: readonly number[], alpha: number): { prev: WorldSnapshot; cur: WorldSnapshot } {
  let any = false;
  for (const f of fracs) if (f !== NO_TELEPORT) any = true;
  if (!any) return { prev: a, cur: b };
  const prevF = a.fighters.map((f, i) => {
    if (fracs[i] === NO_TELEPORT || alpha < fracs[i] || b.fighters[i] === undefined) return f;
    const c = cloneFighter(f);
    c.pos = { ...b.fighters[i].pos };
    c.yaw = b.fighters[i].yaw;
    return c;
  });
  const curF = b.fighters.map((f, i) => {
    if (fracs[i] === NO_TELEPORT || alpha >= fracs[i] || a.fighters[i] === undefined) return f;
    const c = cloneFighter(f);
    c.pos = { ...a.fighters[i].pos };
    c.yaw = a.fighters[i].yaw;
    return c;
  });
  return { prev: { ...a, fighters: prevF }, cur: { ...b, fighters: curF } };
}

export function lerpSnapshots(a: WorldSnapshot, b: WorldSnapshot, alphaIn: number, teleports: readonly number[]): WorldSnapshot {
  const alpha = alphaIn < 0 ? 0 : alphaIn > 1 ? 1 : alphaIn;
  const fighters: FighterState[] = new Array(a.fighters.length);
  for (let i = 0; i < a.fighters.length; i++) {
    const fa = a.fighters[i];
    const fb = b.fighters[i];
    if (fb === undefined || fb.id !== fa.id) {
      fighters[i] = cloneFighter(fa);
      continue;
    }
    const c = cloneFighter(fa);
    const tf = teleports[i] ?? NO_TELEPORT;
    if (tf !== NO_TELEPORT) {
      const src = alpha >= tf ? fb : fa;
      c.pos = { ...src.pos };
      c.yaw = src.yaw;
    } else {
      c.pos = lerpVec(fa.pos, fb.pos, alpha);
      c.yaw = lerpAngle(fa.yaw, fb.yaw, alpha);
    }
    c.vel = lerpVec(fa.vel, fb.vel, alpha);
    if (fa.alive && fb.alive) {
      c.hp = lerp(fa.hp, fb.hp, alpha);
      c.guard = lerp(fa.guard, fb.guard, alpha);
    }
    c.ultCharge = lerp(fa.ultCharge, fb.ultCharge, alpha);
    c.specialCd = lerp(fa.specialCd, fb.specialCd, alpha);
    c.guardRegenDelay = lerp(fa.guardRegenDelay, fb.guardRegenDelay, alpha);
    c.comboWindow = lerp(fa.comboWindow, fb.comboWindow, alpha);
    c.glideT = lerp(fa.glideT, fb.glideT, alpha);
    c.burrowT = lerp(fa.burrowT, fb.burrowT, alpha);
    if (fa.action === fb.action) {
      c.actionT = lerp(fa.actionT, fb.actionT, alpha);
      c.actionDur = lerp(fa.actionDur, fb.actionDur, alpha);
    } else {
      // The new action starts at b; keep the old one's clock running through the gap.
      c.actionT = Math.min(fa.actionDur > 0 ? fa.actionDur : Infinity, fa.actionT + (b.time - a.time) * alpha);
    }
    fighters[i] = c;
  }

  const traps: TrapState[] = a.traps.map((t, i) => {
    const tb = b.traps[i];
    const c: TrapState = { ...t, pos: { ...t.pos } };
    if (tb !== undefined && tb.phase === t.phase) c.timeLeft = lerp(t.timeLeft, tb.timeLeft, alpha);
    return c;
  });

  const out: WorldSnapshot = {
    time: lerp(a.time, b.time, alpha),
    fighters,
    pickups: a.pickups.map((p) => ({ ...p, pos: { ...p.pos } })),
    crates: a.crates.map((c) => ({ ...c, pos: { ...c.pos } })),
    traps,
    bloodlustMult: a.bloodlustMult,
    matchOver: a.matchOver,
    winnerId: a.winnerId,
  };
  if (a.projectiles !== undefined || b.projectiles !== undefined) {
    out.projectiles = lerpProjectiles(a.projectiles ?? [], b.projectiles ?? [], alpha, b.time - a.time);
  }
  return out;
}

function lerpProjectiles(pa: readonly ProjectileState[], pb: readonly ProjectileState[], alpha: number, spanS: number): ProjectileState[] {
  const out: ProjectileState[] = [];
  const byIdA = new Map<number, ProjectileState>();
  for (const p of pa) byIdA.set(p.id, p);
  const seen = new Set<number>();
  for (const q of pb) {
    const p = byIdA.get(q.id);
    seen.add(q.id);
    if (p !== undefined) {
      out.push({ ...q, pos: lerpVec(p.pos, q.pos, alpha), vel: lerpVec(p.vel, q.vel, alpha) });
    } else {
      // Spawned inside the interval: back-extrapolate along its velocity so it appears mid-flight, not at the end.
      const back = (1 - alpha) * spanS;
      out.push({
        ...q,
        pos: { x: q.pos.x - q.vel.x * back, y: q.pos.y - q.vel.y * back, z: q.pos.z - q.vel.z * back },
        vel: { ...q.vel },
      });
    }
  }
  for (const p of pa) {
    if (seen.has(p.id)) continue;
    // Ended inside the interval: keep it flying until the interval ends (its impact event fires in the same window).
    const fwd = alpha * spanS;
    out.push({ ...p, pos: { x: p.pos.x + p.vel.x * fwd, y: p.pos.y + p.vel.y * fwd, z: p.pos.z + p.vel.z * fwd }, vel: { ...p.vel } });
  }
  return out;
}

/** `s` advanced `dtS` seconds along its velocities (live fighters and projectiles only). Used when the buffer is starved. */
export function extrapolateSnapshot(s: WorldSnapshot, dtS: number): WorldSnapshot {
  const fighters = s.fighters.map((f) => {
    const c = cloneFighter(f);
    if (f.alive) {
      c.pos.x += f.vel.x * dtS;
      c.pos.z += f.vel.z * dtS;
      if (f.airborne) c.pos.y = Math.max(0, f.pos.y + f.vel.y * dtS);
    }
    return c;
  });
  const out: WorldSnapshot = {
    ...s,
    time: s.time + dtS,
    fighters,
    pickups: s.pickups.map((p) => ({ ...p, pos: { ...p.pos } })),
    crates: s.crates.map((c) => ({ ...c, pos: { ...c.pos } })),
    traps: s.traps.map((t) => ({ ...t, pos: { ...t.pos } })),
  };
  if (s.projectiles !== undefined) {
    out.projectiles = s.projectiles.map((p) => ({
      ...p,
      pos: { x: p.pos.x + p.vel.x * dtS, y: p.pos.y + p.vel.y * dtS, z: p.pos.z + p.vel.z * dtS },
      vel: { ...p.vel },
    }));
  }
  return out;
}
