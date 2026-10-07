/**
 * Shared ultimate/ability scaffolding (moved out of abilities2.ts in v1.3, behaviour
 * unchanged): aim helpers, begin/telegraph/end, the area-damage helper, plus the
 * v1.3 additions every per-animal ultimate can use — `emitUltimateTarget`,
 * `emitUltimateStage`, `blink`, `toRecovery` and the snapshot filler.
 *
 * Every ability flows its damage through CombatSystem.dealDamage so §7.1 holds;
 * telegraph + special/ultimate events fire at windup start (§7.5/6).
 */

import type { EffectSpec, AbilitySpec } from '../../config/animals';
import type { FighterState, Vec3 } from '../../core/types';
import type { Fighter, Sim, AbilityRuntime } from '../Fighter';
import { AbilityPhase } from '../Fighter';
import type { DamageOpts } from '../CombatSystem';
import { dealDamage } from '../CombatSystem';
import { applyEffect, applyKnockback, applyDirectionalKnockback } from '../StatusEffects';
import { isGroundTargetable, circleHit, coneHit, withinGroundReach } from '../hitbox';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { AIM_SNAP_LATERAL, AIM_SNAP_SLACK, AIM_SNAP_MIN } from '../simTuning';
import type { UltPreview } from './targeting';

// ── Shared scaffolding ───────────────────────────────────────────────────────

/** Aim ground point `dist` metres along the caster's aim yaw. */
export function aimX(f: Fighter, dist: number): number {
  return f.state.pos.x + Math.sin(f.intent.aimYaw) * dist;
}
export function aimZ(f: Fighter, dist: number): number {
  return f.state.pos.z + Math.cos(f.intent.aimYaw) * dist;
}

/**
 * v1.1 aimed-point rule. FighterIntent carries only a yaw (no aim distance),
 * so aimed ground-point abilities (lion Pounce, gorilla Leap, eagle Death From
 * Above, mole Sinkhole) used to land at their MAX range every time: a Pounce
 * thrown at a foe 4 m away sailed 8 m past them. Now the point lands on the
 * nearest targetable enemy lying on the aim line (within
 * {@link AIM_SNAP_LATERAL} m of the ray and at most `maxRange` +
 * {@link AIM_SNAP_SLACK} away); with nobody on the line it is max range as
 * before. Returns the distance along the aim yaw.
 * (Pure-state twin for the HUD/AI: targeting.resolveGroundPoint.)
 */
export function aimPointDist(sim: Sim, f: Fighter, maxRange: number): number {
  const dx = Math.sin(f.intent.aimYaw);
  const dz = Math.cos(f.intent.aimYaw);
  let best = maxRange;
  let found = false;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !isGroundTargetable(t)) continue; // v1.2: never snap onto a soaring eagle
    const rx = t.state.pos.x - f.state.pos.x;
    const rz = t.state.pos.z - f.state.pos.z;
    const along = rx * dx + rz * dz;
    if (along <= 0 || along > maxRange + AIM_SNAP_SLACK) continue;
    const lateral = Math.abs(rx * dz - rz * dx);
    if (lateral > AIM_SNAP_LATERAL + t.def.radius) continue;
    if (!found || along < best) {
      best = along;
      found = true;
    }
  }
  if (!found) return maxRange;
  return Math.min(maxRange, Math.max(AIM_SNAP_MIN, best));
}

/** Allocate + attach an ability runtime, snap yaw, reset combo (§7.2). */
export function beginAbility(f: Fighter, kind: 'special' | 'ultimate', spec: AbilitySpec): AbilityRuntime {
  f.state.yaw = f.intent.aimYaw;
  const rt: AbilityRuntime = {
    kind,
    spec,
    phase: AbilityPhase.Windup,
    t: 0,
    px: 0,
    pz: 0,
    sx: f.state.pos.x,
    sz: f.state.pos.z,
    dirX: Math.sin(f.state.yaw),
    dirZ: Math.cos(f.state.yaw),
    hitOnce: new Set<number>(),
    counter: 0,
    accum: 0,
    didHit: false,
    targetId: -1,
    isGrab: false,
    lockId: -1,
    stage: 0,
  };
  f.ability = rt;
  f.blocking = false; // casting drops block
  f.state.action = kind === 'special' ? 'special' : 'ultimate';
  f.state.actionT = 0;
  f.state.actionDur = spec.windup + (spec.duration ?? spec.maxTime ?? spec.recovery ?? 0.4);
  f.resetCombo();
  return rt;
}

/** Emit the windup telegraph + special/ultimate events (§7.5/§7.6). */
export function emitCastEvents(sim: Sim, f: Fighter, rt: AbilityRuntime, tx: number, tz: number, radius: number, arcDeg: number, windup: number): void {
  sim.emit({
    type: 'telegraph',
    fighterId: f.id,
    kind: rt.kind,
    pos: { x: tx, y: f.state.pos.y, z: tz },
    radius,
    yaw: f.state.yaw,
    arcDeg,
    windup,
  });
  if (rt.kind === 'special') sim.emit({ type: 'special', fighterId: f.id, animal: f.def.id });
  else sim.emit({ type: 'ultimate', fighterId: f.id, animal: f.def.id });
}

/** Tear down an ability: cooldown (specials), release grab, clear phase flags. */
export function endAbility(sim: Sim, f: Fighter): void {
  const rt = f.ability;
  if (rt === null) return;
  if (rt.kind === 'special') f.state.specialCd = rt.spec.cooldown;
  if (rt.isGrab && rt.targetId >= 0) {
    const t = sim.fighters[rt.targetId];
    if (t !== undefined) {
      t.state.grabbedById = -1;
      t.state.action = 'idle';
    }
  }
  f.state.grabTargetId = -1;
  f.incomingDamageReduction = 0;
  f.ccImmuneChannel = false;
  f.untargetable = false;
  f.state.burrowT = 0;
  f.ability = null;
  if (f.state.action === 'special' || f.state.action === 'ultimate' || f.state.action === 'grab' || f.state.action === 'burrowed') {
    f.state.action = 'idle';
  }
}

/** Switch a runtime to its Recovery phase. */
export function toRecovery(rt: AbilityRuntime): void {
  rt.phase = AbilityPhase.Recovery;
  rt.t = 0;
}

/** Area damage config for {@link hitArea}. */
export interface AreaCfg {
  shape: 'circle' | 'cone';
  cx: number;
  cz: number;
  cy: number;
  yaw: number;
  range: number;
  arcDeg: number;
  heightTol: number;
  base: number;
  opts: DamageOpts;
  effects?: readonly EffectSpec[];
  once?: Set<number>;
  /** Radial pushback distance from the centre (m). */
  pushDist?: number;
  /** Directional pushback along (pushDirX,pushDirZ) instead of radial. */
  pushDirX?: number;
  pushDirZ?: number;
  /** Extra damage fraction vs rooted targets (mole Sinkhole). */
  bonusVsRooted?: number;
}

/** Apply an area hit (circle or cone) to every valid fighter once. */
export function hitArea(sim: Sim, f: Fighter, cfg: AreaCfg): boolean {
  let any = false;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive) continue;
    if (cfg.once !== undefined && cfg.once.has(t.id)) continue;
    if (!withinGroundReach(t)) continue; // v1.2: ground AoEs miss high flyers
    const hit =
      cfg.shape === 'circle'
        ? circleHit(cfg.cx, cfg.cz, cfg.cy, cfg.range, t, cfg.heightTol)
        : coneHit(cfg.cx, cfg.cz, cfg.cy, cfg.yaw, cfg.range, cfg.arcDeg, t, cfg.heightTol);
    if (!hit) continue;
    if (cfg.once !== undefined) cfg.once.add(t.id);
    let mult = cfg.opts.dmgMult ?? 1;
    if (cfg.bonusVsRooted !== undefined && t.rootTimer > 0) mult *= 1 + cfg.bonusVsRooted;
    const opts: DamageOpts = { ...cfg.opts, dmgMult: mult };
    const res = dealDamage(sim, f, t, cfg.base, opts);
    if (!res.hit) continue;
    any = true;
    if (cfg.effects !== undefined) for (let k = 0; k < cfg.effects.length; k++) applyEffect(sim, f, t, cfg.effects[k]);
    if (cfg.pushDist !== undefined && cfg.pushDist > 0) {
      if (cfg.pushDirX !== undefined && cfg.pushDirZ !== undefined) applyDirectionalKnockback(t, cfg.pushDirX, cfg.pushDirZ, cfg.pushDist);
      else applyKnockback(t, cfg.cx, cfg.cz, cfg.pushDist);
    }
  }
  return any;
}

/** Vertical tolerance (m) for ultimate AoEs. */
export const AOE_HEIGHT = 3.0;

/** Damage options shared by ultimate hits. */
export function ultOpts(reaction: 'none' | 'stagger'): DamageOpts {
  return { blockable: true, heavy: true, reaction, isBasic: false };
}

// ── v1.3 helpers ─────────────────────────────────────────────────────────────

/**
 * The pre-v1.3 telegraph rule for ultimates without a bespoke one: a cone at the
 * caster when the spec has `arcDeg < 360` and a `range`, else a circle of
 * `radius ?? range ?? 8`. Emits the `telegraph` + `ultimate` events.
 */
export function emitDefaultUltTelegraph(sim: Sim, f: Fighter, rt: AbilityRuntime): void {
  const spec = rt.spec;
  if (spec.arcDeg !== undefined && spec.arcDeg < 360 && spec.range !== undefined) {
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.range, spec.arcDeg, spec.windup);
  } else {
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, spec.radius ?? spec.range ?? 8, spec.arcDeg ?? 360, spec.windup);
  }
}

/**
 * Emit the v1.3 `ultimateTarget` event at cast start from the resolved targeting.
 * `windup` defaults to `spec.windup` (pass the real lead time when the ult's
 * windup lives elsewhere, e.g. eagle's untargetable soar); `to` overrides the
 * resolved end point (aimed ground points such as eagle/mole).
 */
export function emitUltimateTarget(
  sim: Sim,
  f: Fighter,
  rt: AbilityRuntime,
  target: UltPreview,
  windup: number = rt.spec.windup,
  to?: { x: number; z: number },
): void {
  const tx = to !== undefined ? to.x : target.to.x;
  const tz = to !== undefined ? to.z : target.to.z;
  sim.emit({
    type: 'ultimateTarget',
    fighterId: f.id,
    animal: f.def.id,
    kind: target.kind,
    targetId: target.targetId,
    from: { x: target.from.x, y: target.from.y, z: target.from.z },
    to: { x: tx, y: to !== undefined ? groundHeightAt(tx, tz, sim.arena) : target.to.y, z: tz },
    range: target.range,
    width: target.width,
    windup,
  });
}

/** Victim currently associated with a running ultimate: the locked target, else the grabbed one, else -1. */
export function currentTargetId(rt: AbilityRuntime): number {
  return rt.lockId >= 0 ? rt.lockId : rt.targetId;
}

/**
 * Mark the start of beat `stage` (0-based) of a multi-stage ultimate: sets
 * `rt.stage` (mirrored into `FighterState.ultStage` by the snapshot) and emits
 * `ultimateStage`. `pos` defaults to the caster's position.
 */
export function emitUltimateStage(sim: Sim, f: Fighter, rt: AbilityRuntime, stage: number, pos?: Vec3): void {
  rt.stage = stage;
  const p = pos !== undefined ? pos : f.state.pos;
  sim.emit({
    type: 'ultimateStage',
    fighterId: f.id,
    animal: f.def.id,
    stage,
    targetId: currentTargetId(rt),
    pos: { x: p.x, y: p.y, z: p.z },
  });
}

/**
 * Instantly relocate `f` to (x, z) and emit `blink` (renderers must not
 * interpolate across it). The fighter is pushed out of pillars/crates and inside
 * the arena wall, keeps its altitude above ground, and its velocity/knockback are
 * cleared. `opts.yaw` also snaps the facing.
 */
export function blink(sim: Sim, f: Fighter, x: number, z: number, opts?: { yaw?: number }): void {
  const s = f.state;
  const from: Vec3 = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
  const alt = Math.max(0, s.pos.y - groundHeightAt(s.pos.x, s.pos.z, sim.arena));
  s.pos.x = x;
  s.pos.z = z;
  resolveObstacles(sim, f, false);
  clampToWall(f);
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z, sim.arena) + alt;
  s.vel.x = 0;
  s.vel.z = 0;
  f.knockVX = 0;
  f.knockVZ = 0;
  f.knockTimer = 0;
  if (opts !== undefined && opts.yaw !== undefined) s.yaw = opts.yaw;
  sim.emit({ type: 'blink', fighterId: f.id, from, to: { x: s.pos.x, y: s.pos.y, z: s.pos.z } });
}

/**
 * Fill the optional v1.3 ultimate fields of a snapshot state from the fighter's
 * running ultimate (`ultPhase` / `ultStage` / `ultTargetId`). Leaves them
 * undefined (absent) when the fighter is not casting an ultimate.
 */
export function fillUltSnapshot(st: FighterState, f: Fighter): void {
  const rt = f.ability;
  if (rt === null || rt.kind !== 'ultimate') return;
  st.ultPhase = rt.phase === AbilityPhase.Windup ? 'windup' : rt.phase === AbilityPhase.Active ? 'active' : 'recovery';
  st.ultStage = rt.stage;
  st.ultTargetId = currentTargetId(rt);
}
