/**
 * Python — COIL SNARE (v1.3 rework, lock-on tether).
 *
 *   Windup (spec.windup)  rear + hiss. `rt.lockId` is the locked victim; the aim TRACKS them (yaw turns toward
 *                         the victim at PYTHON.turnRate) until `commitFrac` of the windup, then the tether
 *                         direction is frozen (`ultimateStage` COMMIT, pos = tether end).
 *   LASH    a coil tether flies along the frozen line at `PYTHON.tetherSpeed` (~0.3 s across 9 m). It is a
 *           moving line, not a lunge: the first ground-targetable foe whose body touches it (and is not
 *           hopping above `hopClearance`) is SNARED; a foe that slipped sideways off the line, jumped it, or
 *           anyone behind a pillar/crate/wall is not. Nothing touched = WHIFF (tether retracts, then recovery).
 *   YANK    the snared victim is reeled in ALL the way to the python (eased, `yankMinT`..`yankMaxT`), stunned.
 *   BIND    `spec.duration` of squeeze: the victim is held + stunned, the python takes `spec.damageReduction`
 *           less damage; `PYTHON.pulses` (4) pulses, one `ultimateStage` (WRAP1..4) each, tighten the wrap.
 *           Damage is a continuous unblockable drain (`spec.damage` - snare - crush over the bind).
 *   CRUSH   final `crushDamage` (unblockable) + short stagger, victim released. Recovery `crushRecovery`.
 *
 * Interruption: the windup is interruptible (as before); from activation `rt.isGrab` makes the runtime
 * resist `Fighter.interrupt()`. Every exit path (victim dies, caster dies, victim freed) releases the victim.
 * Numbers: src/config/ultimates/python.ts. Deterministic (no rng).
 */

import { clamp, dirToYaw, rotateToward } from '../../core/math';
import { PYTHON, PYTHON_STAGE } from '../../config/ultimates/python';
import { dealDamage } from '../CombatSystem';
import { altitudeOf, isGroundTargetable } from '../hitbox';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import type { Fighter, Sim, AbilityRuntime } from '../Fighter';
import { emitCastEvents, emitUltimateStage, emitUltimateTarget, endAbility, toRecovery } from './common';
import type { UltimateImpl } from './types';

enum Sub {
  Lash = 0,
  Yank = 1,
  Bind = 2,
  Retract = 3,
}

/** Tether height above the ground (m), for jump-over and obstacle tests. */
const TETHER_Y = 0.6;

interface PyState {
  sub: Sub;
  timer: number;
  committed: boolean;
  /** Tether length (m) and how far it has flown along the line. */
  len: number;
  tip: number;
  /** Yank: victim start (x,z) and the hold point (x,z); duration. */
  sx: number;
  sz: number;
  hx: number;
  hz: number;
  yankT: number;
  /** Pulse beats emitted so far (0..pulses). */
  pulses: number;
  bindT: number;
}

const STATE = new WeakMap<AbilityRuntime, PyState>();

function st(rt: AbilityRuntime): PyState {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { sub: Sub.Lash, timer: 0, committed: false, len: 0, tip: 0, sx: 0, sz: 0, hx: 0, hz: 0, yankT: 0.3, pulses: 0, bindT: 0 };
    STATE.set(rt, s);
  }
  return s;
}

const ease = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

function setDur(f: Fighter, remaining: number): void {
  f.state.actionDur = f.state.actionT + Math.max(0.05, remaining);
}

function lockedVictim(sim: Sim, rt: AbilityRuntime): Fighter | null {
  const t = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
  if (t === undefined || !t.state.alive || t.untargetable) return null;
  return t;
}

/** Tether origin (world x,z): a little ahead of the python's centre. */
function originX(f: Fighter, rt: AbilityRuntime): number {
  return f.state.pos.x + rt.dirX * 0.5;
}
function originZ(f: Fighter, rt: AbilityRuntime): number {
  return f.state.pos.z + rt.dirZ * 0.5;
}

export const pythonUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, 1.8, 360, rt.spec.windup);
    emitUltimateTarget(sim, f, rt, target);
    st(rt);
  },

  windupTick(sim, f, rt, dt) {
    const s = st(rt);
    if (s.committed) return;
    const spec = rt.spec;
    const v = lockedVictim(sim, rt);
    if (v !== null) {
      const want = dirToYaw(v.state.pos.x - f.state.pos.x, v.state.pos.z - f.state.pos.z);
      f.state.yaw = rotateToward(f.state.yaw, want, PYTHON.turnRate * dt);
      rt.dirX = Math.sin(f.state.yaw);
      rt.dirZ = Math.cos(f.state.yaw);
    }
    if (rt.t + dt >= spec.windup * PYTHON.commitFrac) {
      s.committed = true;
      let len = (spec.range ?? 9) + PYTHON.overshoot;
      if (v !== null) {
        const d = Math.hypot(v.state.pos.x - originX(f, rt), v.state.pos.z - originZ(f, rt));
        len = clamp(d + 1.6, 3, len);
      }
      s.len = len;
      const ex = originX(f, rt) + rt.dirX * len;
      const ez = originZ(f, rt) + rt.dirZ * len;
      emitUltimateStage(sim, f, rt, PYTHON_STAGE.COMMIT, { x: ex, y: groundHeightAt(ex, ez, sim.arena), z: ez });
    }
  },

  activate(sim, f, rt) {
    const s = st(rt);
    rt.isGrab = true; // grab resist from here on
    rt.didHit = false;
    rt.targetId = -1;
    s.sub = Sub.Lash;
    s.timer = 0;
    s.tip = 0;
    if (!s.committed) {
      s.committed = true;
      s.len = (rt.spec.range ?? 9) + PYTHON.overshoot;
    }
    setDur(f, s.len / PYTHON.tetherSpeed + 0.4);
    const ex = originX(f, rt) + rt.dirX * s.len;
    const ez = originZ(f, rt) + rt.dirZ * s.len;
    emitUltimateStage(sim, f, rt, PYTHON_STAGE.LASH, { x: ex, y: groundHeightAt(ex, ez, sim.arena), z: ez });
  },

  activeTick(sim, f, rt, dt) {
    const s = st(rt);
    switch (s.sub) {
      case Sub.Lash:
        lashTick(sim, f, rt, s, dt);
        break;
      case Sub.Yank:
        yankTick(sim, f, rt, s, dt);
        break;
      case Sub.Bind:
        bindTick(sim, f, rt, s, dt);
        break;
      case Sub.Retract:
        s.timer += dt;
        if (s.timer >= PYTHON.retractT) toRecovery(rt);
        break;
    }
  },

  recoveryDuration(rt) {
    return rt.didHit ? PYTHON.crushRecovery : Math.max(0.1, (rt.spec.recovery ?? 0.85) - PYTHON.retractT);
  },

  abort(sim, f, rt) {
    releaseVictim(sim, f, rt);
  },
};

// ── Lash (the tether flies) ──────────────────────────────────────────────────

/** Is the tether blocked at (x,z)? Pillars, tall crates, tall walls, the arena wall. */
function tetherBlocked(sim: Sim, x: number, z: number): boolean {
  if (Math.hypot(x, z) > sim.arena.wallRadius - 0.3) return true;
  const obs = sim.staticObstacles;
  for (let i = 0; i < obs.length; i++) {
    const ob = obs[i];
    if (ob.shape === 'circle') {
      if (ob.walkable) continue;
      if (Math.hypot(x - ob.x, z - ob.z) <= ob.radius + 0.1) return true;
    } else if (ob.shape === 'segment') {
      if (ob.jumpable && ob.height < TETHER_Y) continue;
      if (distToSeg(x, z, ob.ax, ob.az, ob.bx, ob.bz) <= ob.thickness * 0.5 + 0.1) return true;
    }
  }
  for (let i = 0; i < sim.crates.length; i++) {
    const c = sim.crates[i];
    if (!c.alive || c.height < TETHER_Y) continue;
    if (Math.abs(x - c.x) <= c.halfX + 0.1 && Math.abs(z - c.z) <= c.halfZ + 0.1) return true;
  }
  return false;
}

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 1e-9 ? clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function lashTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: PyState, dt: number): void {
  const step = Math.min(PYTHON.tetherSpeed * dt, s.len - s.tip);
  const a = s.tip;
  const b = s.tip + step;
  const ox = originX(f, rt);
  const oz = originZ(f, rt);

  // First foe touched by the swept tether segment [a, b].
  let hit: Fighter | null = null;
  let hitAlong = Infinity;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isGroundTargetable(t) || t.state.grabbedById !== -1) continue;
    if (altitudeOf(t) > PYTHON.hopClearance) continue; // jumped the tether
    const rx = t.state.pos.x - ox;
    const rz = t.state.pos.z - oz;
    const along = rx * rt.dirX + rz * rt.dirZ;
    const lat = Math.abs(rx * rt.dirZ - rz * rt.dirX);
    const p = clamp(along, a, b);
    const d = Math.hypot(along - p, lat);
    if (d > t.def.radius + PYTHON.tetherRadius) continue;
    if (p < hitAlong) {
      hitAlong = p;
      hit = t;
    }
  }
  if (hit !== null) {
    beginSnare(sim, f, rt, s, hit);
    return;
  }

  s.tip = b;
  const bx = ox + rt.dirX * b;
  const bz = oz + rt.dirZ * b;
  if (tetherBlocked(sim, bx, bz) || s.tip >= s.len - 1e-6) {
    // Whiff: the tether snaps back.
    s.sub = Sub.Retract;
    s.timer = 0;
    setDur(f, PYTHON.retractT + (rt.spec.recovery ?? 0.85));
    emitUltimateStage(sim, f, rt, PYTHON_STAGE.WHIFF, { x: bx, y: groundHeightAt(bx, bz, sim.arena), z: bz });
  }
}

/** Take the victim out of whatever it was doing and put it in the hold. */
function seize(sim: Sim, f: Fighter, t: Fighter): void {
  t.state.grabbedById = f.id;
  f.state.grabTargetId = t.id;
  if (t.ability !== null) {
    // Whatever the victim was casting (even a CC-immune channel or another grab) is torn down properly.
    t.ccImmuneChannel = false;
    t.ccImmune = false;
    endAbility(sim, t);
  }
  t.interrupt();
  t.blocking = false;
  t.movementOwned = true;
  t.state.airborne = false;
  t.state.vel.x = 0;
  t.state.vel.y = 0;
  t.state.vel.z = 0;
  t.knockTimer = 0;
  t.knockVX = 0;
  t.knockVZ = 0;
  t.state.action = 'grabbed';
}

function beginSnare(sim: Sim, f: Fighter, rt: AbilityRuntime, s: PyState, t: Fighter): void {
  seize(sim, f, t);
  rt.didHit = true;
  rt.targetId = t.id;
  rt.lockId = t.id;
  f.incomingDamageReduction = rt.spec.damageReduction ?? 0;

  // Face the victim; the yank runs along the python -> victim line.
  const dx = t.state.pos.x - f.state.pos.x;
  const dz = t.state.pos.z - f.state.pos.z;
  const dist = Math.hypot(dx, dz);
  const ux = dist > 1e-6 ? dx / dist : rt.dirX;
  const uz = dist > 1e-6 ? dz / dist : rt.dirZ;
  rt.dirX = ux;
  rt.dirZ = uz;
  f.state.yaw = dirToYaw(ux, uz);
  const hold = f.def.radius + t.def.radius + PYTHON.bindGap;
  s.sx = t.state.pos.x;
  s.sz = t.state.pos.z;
  s.hx = f.state.pos.x + ux * hold;
  s.hz = f.state.pos.z + uz * hold;
  const pull = Math.max(0, dist - hold);
  s.yankT = clamp(pull / PYTHON.yankSpeed, PYTHON.yankMinT, PYTHON.yankMaxT);
  if (pull < 0.5) s.yankT = 0.15;
  s.sub = Sub.Yank;
  s.timer = 0;
  setDur(f, s.yankT + (rt.spec.duration ?? 2.6) + PYTHON.crushRecovery);

  dealDamage(sim, f, t, PYTHON.snareDamage, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
  t.staggerTimer = Math.max(t.staggerTimer, 0.3);
  emitUltimateStage(sim, f, rt, PYTHON_STAGE.SNARE, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
}

// ── Yank ─────────────────────────────────────────────────────────────────────

function holdVictim(sim: Sim, f: Fighter, rt: AbilityRuntime): Fighter | null {
  const t = rt.targetId >= 0 ? sim.fighters[rt.targetId] : undefined;
  if (t === undefined || !t.state.alive || t.state.grabbedById !== f.id) {
    releaseVictim(sim, f, rt);
    toRecovery(rt);
    return null;
  }
  return t;
}

function yankTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: PyState, dt: number): void {
  const t = holdVictim(sim, f, rt);
  if (t === null) return;
  s.timer += dt;
  const u = clamp(s.timer / s.yankT, 0, 1);
  const e = ease(u);
  const px = t.state.pos.x;
  const pz = t.state.pos.z;
  t.state.pos.x = s.sx + (s.hx - s.sx) * e;
  t.state.pos.z = s.sz + (s.hz - s.sz) * e;
  t.state.pos.y = groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena);
  resolveObstacles(sim, t, false);
  clampToWall(t);
  t.state.vel.x = (t.state.pos.x - px) / Math.max(dt, 1e-6);
  t.state.vel.z = (t.state.pos.z - pz) / Math.max(dt, 1e-6);
  t.state.yaw = rotateToward(t.state.yaw, dirToYaw(-rt.dirX, -rt.dirZ), 12 * dt);
  t.staggerTimer = Math.max(t.staggerTimer, 0.25);
  t.movementOwned = true;
  t.state.action = 'grabbed';
  if (u >= 1) {
    t.state.vel.x = 0;
    t.state.vel.z = 0;
    s.sub = Sub.Bind;
    s.timer = 0;
    s.bindT = 0;
    s.pulses = 1;
    emitUltimateStage(sim, f, rt, PYTHON_STAGE.WRAP1, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
  }
}

// ── Bind + crush ─────────────────────────────────────────────────────────────

function bindTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: PyState, dt: number): void {
  const t = holdVictim(sim, f, rt);
  if (t === null) return;
  const spec = rt.spec;
  const dur = spec.duration ?? 2.6;
  const pulses = spec.hits ?? PYTHON.pulses;
  s.bindT += dt;

  const drain = Math.max(0, (spec.damage ?? 260) - PYTHON.snareDamage - PYTHON.crushDamage);
  sim.applyBleedDamage(f, t, (drain / dur) * dt);

  // Squeeze pulses tighten the wrap (one beat each).
  const want = Math.min(pulses, 1 + Math.floor(s.bindT / (dur / pulses)));
  while (s.pulses < want) {
    s.pulses += 1;
    emitUltimateStage(sim, f, rt, PYTHON_STAGE.WRAP1 + s.pulses - 1, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
  }

  // Held in the coils: slightly lifted, facing the python, going nowhere.
  t.state.pos.y = groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena) + 0.2 * ease(s.bindT / 0.3);
  t.state.yaw = rotateToward(t.state.yaw, dirToYaw(-rt.dirX, -rt.dirZ), 10 * dt);
  t.staggerTimer = Math.max(t.staggerTimer, 0.25);
  t.movementOwned = true;
  t.state.action = 'grabbed';

  if (s.bindT >= dur) crush(sim, f, rt, t);
}

function crush(sim: Sim, f: Fighter, rt: AbilityRuntime, t: Fighter): void {
  releaseVictim(sim, f, rt);
  t.staggerTimer = 0; // the crush is not amplified by the hold stun
  dealDamage(sim, f, t, PYTHON.crushDamage, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
  if (t.state.alive) t.staggerTimer = Math.max(t.staggerTimer, PYTHON.crushStagger);
  emitUltimateStage(sim, f, rt, PYTHON_STAGE.CRUSH, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
  setDur(f, PYTHON.crushRecovery);
  toRecovery(rt);
}

/** Let go of the victim (idempotent) and drop the caster-side hold flags. */
function releaseVictim(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const t = rt.targetId >= 0 ? sim.fighters[rt.targetId] : undefined;
  if (t !== undefined) {
    if (t.state.grabbedById === f.id) t.state.grabbedById = -1;
    t.movementOwned = false;
    t.state.pos.y = groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena);
    if (t.state.alive && t.state.action === 'grabbed') t.state.action = 'idle';
  }
  rt.targetId = -1;
  f.state.grabTargetId = -1;
  f.incomingDamageReduction = 0;
}
