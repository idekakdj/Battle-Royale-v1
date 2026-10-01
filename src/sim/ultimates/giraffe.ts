/**
 * Giraffe — Timber Fall (v1.3, was Guillotine Spin): a neck-hammer slam on a tracked-then-committed circle.
 *
 *   cast    lock a foe (7.5 m body range, 70° cone, `requireTarget`: no target = fizzle, nothing spent).
 *   Windup  1.1 s: the giraffe rears its neck far back and creeps toward the victim (it needs to bring the head in
 *           reach; up to ~5 m of approach).
 *           TRACK 0.6 s (`ultimateStage` 0, every 0.1 s): a ground circle follows the victim with lag. Interruptible.
 *           COMMIT 0.5 s (`ultimateStage` 1): the circle freezes — walking out of it dodges the hit. The giraffe is
 *           CC-immune from here on.
 *   Active  SLAM 0.14 s: the neck comes down. On landing everyone touching the committed circle (r 1.6, bodies padded)
 *           takes 230 (blockable) and a 1 s stun when the hit is not blocked; everyone else inside the 2.2 m shock
 *           ring takes 50 and staggers. `ultimateStage` 2 marks the impact (and the whole recovery).
 *   Recovery whiff (nobody hit) 0.9 s, hit 0.65 s.
 *
 * Config: src/config/ultimates/giraffe.ts · AI: src/ai/ultScripts/giraffe.ts · Rig: src/render/animals/Giraffe.ts
 */

import { clamp01, dirToYaw, rotateToward } from '../../core/math';
import { GIRAFFE_TIMBER as K } from '../../config/ultimates/giraffe';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { dealDamage } from '../CombatSystem';
import { circleHit, withinGroundReach } from '../hitbox';
import { clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { applyEffect } from '../StatusEffects';
import { AOE_HEIGHT, emitCastEvents, emitUltimateStage, emitUltimateTarget, hitArea, toRecovery, ultOpts } from './common';
import type { UltimateImpl } from './types';

type Beat = 'track' | 'commit' | 'slam' | 'done';

/** Per-cast scratch (kept off the shared AbilityRuntime shape). */
interface Timber {
  beat: Beat;
  /** Reticle centre (tracks while beat === 'track', then fixed). */
  rx: number;
  rz: number;
  emitT: number;
  slamT: number;
}

const STATE = new WeakMap<AbilityRuntime, Timber>();

function get(rt: AbilityRuntime): Timber {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { beat: 'track', rx: rt.px, rz: rt.pz, emitT: K.trackEmitS, slamT: 0 };
    STATE.set(rt, s);
  }
  return s;
}

/** Current beat of a running Timber Fall (test / debug hook). */
export function timberBeat(rt: AbilityRuntime | null): Beat | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : s.beat;
}

/** Tracked / committed circle centre of a running Timber Fall (test / debug hook). */
export function timberReticle(rt: AbilityRuntime | null): { x: number; z: number } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { x: s.rx, z: s.rz };
}

const smooth = (u: number): number => u * u * (3 - 2 * u);

/** Creep toward the circle centre (ramped, stopping once the head is in reach) and face it. */
function approach(sim: Sim, f: Fighter, st: Timber, tAbs: number, dt: number): void {
  const s = f.state;
  const dx = st.rx - s.pos.x;
  const dz = st.rz - s.pos.z;
  const dist = Math.hypot(dx, dz);
  s.yaw = rotateToward(s.yaw, dirToYaw(dx, dz), K.turnRate * dt);
  let speed = 0;
  if (dist > K.reach) speed = K.approachSpeed * smooth(clamp01(tAbs / K.approachRampS));
  const step = Math.min(speed * dt, Math.max(0, dist - K.reach));
  const ox = s.pos.x;
  const oz = s.pos.z;
  if (step > 0) {
    s.pos.x += (dx / dist) * step;
    s.pos.z += (dz / dist) * step;
    resolveObstacles(sim, f, false);
    clampToWall(f);
  }
  s.pos.y = groundHeightAt(s.pos.x, s.pos.z);
  const inv = dt > 1e-6 ? 1 / dt : 0;
  s.vel.x = (s.pos.x - ox) * inv;
  s.vel.y = 0;
  s.vel.z = (s.pos.z - oz) * inv;
}

export const giraffeUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const st = get(rt);
    st.rx = rt.px = target.to.x;
    st.rz = rt.pz = target.to.z;
    // The reticle is drawn by the VFX module; the ground telegraph ring is intentionally negligible.
    emitCastEvents(sim, f, rt, target.to.x, target.to.z, 0.05, 0, K.windupS);
    emitUltimateTarget(sim, f, rt, target, K.windupS);
    f.state.actionDur = K.windupS + K.slamS + K.recoveryS;
  },

  windupDuration() {
    return K.windupS;
  },

  windupTick(sim, f, rt, dt) {
    const st = get(rt);
    const tNow = rt.t + dt;
    if (st.beat === 'track') {
      const v = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
      if (v !== undefined && v.state.alive) {
        const k = 1 - Math.exp(-dt / K.trackLagS);
        st.rx += (v.state.pos.x - st.rx) * k;
        st.rz += (v.state.pos.z - st.rz) * k;
      }
      st.emitT -= dt;
      if (st.emitT <= 0) {
        st.emitT += K.trackEmitS;
        emitUltimateStage(sim, f, rt, 0, { x: st.rx, y: groundHeightAt(st.rx, st.rz), z: st.rz });
      }
      if (tNow >= K.trackS) {
        // COMMIT: freeze the circle; from here the giraffe cannot be interrupted.
        st.beat = 'commit';
        rt.px = st.rx;
        rt.pz = st.rz;
        f.ccImmuneChannel = true;
        emitUltimateStage(sim, f, rt, 1, { x: st.rx, y: groundHeightAt(st.rx, st.rz), z: st.rz });
      }
    }
    approach(sim, f, st, tNow, dt);
  },

  activate(_sim, f, rt) {
    const st = get(rt);
    st.beat = 'slam';
    st.slamT = 0;
    f.ccImmuneChannel = true;
    rt.t = 0;
  },

  activeTick(sim, f, rt, dt) {
    const st = get(rt);
    f.ccImmuneChannel = true;
    st.slamT += dt;
    approach(sim, f, st, K.windupS + st.slamT, dt);
    if (st.slamT >= K.slamS) land(sim, f, rt, st);
  },

  recoveryDuration(rt) {
    return rt.didHit ? K.hitRecoveryS : K.recoveryS;
  },

  abort(_sim, f) {
    f.ccImmuneChannel = false;
  },
};

/** The neck lands on the committed circle: direct hit + stun, shock ring for everyone else, stage 2, recovery. */
function land(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Timber): void {
  const spec = rt.spec;
  const s = f.state;
  s.vel.x = 0;
  s.vel.z = 0;
  f.ccImmuneChannel = false;
  st.beat = 'done';

  const cx = st.rx;
  const cz = st.rz;
  const cy = groundHeightAt(cx, cz);
  const once = new Set<number>();
  let any = false;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !withinGroundReach(t)) continue;
    if (!circleHit(cx, cz, cy, spec.radius ?? K.directRadius, t, AOE_HEIGHT)) continue;
    once.add(t.id);
    const res = dealDamage(sim, f, t, spec.damage ?? K.damage, ultOpts('none'));
    if (!res.hit) continue;
    any = true;
    // The stun only lands on a victim who did not block the slam (a blocked hit still drains the guard).
    if (!res.blocked && spec.effects !== undefined) {
      for (let k = 0; k < spec.effects.length; k++) applyEffect(sim, f, t, spec.effects[k]);
    }
  }
  hitArea(sim, f, {
    shape: 'circle',
    cx,
    cz,
    cy,
    yaw: s.yaw,
    range: spec.splashRadius ?? K.shockRadius,
    arcDeg: 360,
    heightTol: AOE_HEIGHT,
    base: spec.splashDamage ?? K.shockDamage,
    opts: ultOpts('stagger'),
    once,
  });
  // Only a DIRECT hit earns the short recovery: a slam that merely clipped someone with the shock ring still counts as a whiff.
  rt.didHit = any;
  emitUltimateStage(sim, f, rt, 2, { x: cx, y: cy, z: cz });
  // The rig eases its recovery toward `actionDur`: tell it how long this one lasts (actionT keeps counting).
  s.actionDur = s.actionT + (any ? K.hitRecoveryS : K.recoveryS);
  toRecovery(rt);
}
