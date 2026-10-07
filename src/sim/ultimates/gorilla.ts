/**
 * Gorilla — Boulder Hurl (v1.3): a thrown, dodgeable projectile.
 *
 *   cast    `line` targeting (18 m, lock-assisted by a 40° cone but NOT required: it can always be thrown down
 *           the aim line). Resolves a locked foe when there is one.
 *   Windup  1.0 s, uninterruptible (`ccImmuneChannel`): two chest beats, the slab tears out of the ground, the
 *           hoist. The gorilla keeps turning toward the locked foe / the aim while `ultimateStage` 0 reports the
 *           predicted landing point every 0.1 s (the dashed arc in the VFX follows it).
 *   Release (end of the windup): the landing point freezes (`ultimateStage` 1, a little predictive lead on a
 *           runner), a BOULDER is spawned at the hands and flies a true gravity arc at 18 m/s (horizontal).
 *           Anyone who moves out of the landing spot is missed; fighters in flight above it are missed.
 *   Impact  the FIRST fighter the boulder touches takes 200 (blockable, heavy) and 0.8 s of stagger when the hit is
 *           not blocked; everyone else within 2.5 m takes 60 splash; crates it meets are smashed (projectile
 *           system). `ultimateStage` 2 follows — possibly after the gorilla's own recovery has ended.
 *   Recovery 0.6 s, interruptible (the CC-immunity drops at the release).
 *
 * The boulder belongs to the projectile system (`src/sim/projectiles.ts`); the callback below applies all damage,
 * so nothing here depends on the gorilla still being alive or still casting when it lands.
 *
 * Config: src/config/ultimates/gorilla.ts · AI: src/ai/ultScripts/gorilla.ts · Rig: src/render/animals/Gorilla.ts
 */

import { clamp, dirToYaw, rotateToward } from '../../core/math';
import { GORILLA_HURL as K } from '../../config/ultimates/gorilla';
import type { AbilityRuntime, Fighter, Sim } from '../Fighter';
import { dealDamage } from '../CombatSystem';
import { withinGroundReach } from '../hitbox';
import { groundHeightAt } from '../MovementSystem';
import { applyEffect } from '../StatusEffects';
import { spawnProjectile } from '../projectiles';
import type { ProjectileHit, ProjectileRuntime } from '../projectiles';
import { AOE_HEIGHT, emitCastEvents, emitUltimateStage, emitUltimateTarget, hitArea, toRecovery, ultOpts } from './common';
import { clipRayToArena } from './targeting';
import type { UltimateImpl } from './types';

/** Per-cast scratch (kept off the shared AbilityRuntime shape). */
interface Hurl {
  /** Current predicted landing point (tracks while heaving, frozen at the release). */
  tx: number;
  tz: number;
  emitT: number;
  released: boolean;
}

const STATE = new WeakMap<AbilityRuntime, Hurl>();

function get(rt: AbilityRuntime): Hurl {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { tx: rt.px, tz: rt.pz, emitT: K.trackEmitS, released: false };
    STATE.set(rt, s);
  }
  return s;
}

/** Predicted / committed landing point of a running Boulder Hurl (test / debug hook). */
export function hurlLanding(rt: AbilityRuntime | null): { x: number; z: number; released: boolean } | null {
  if (rt === null) return null;
  const s = STATE.get(rt);
  return s === undefined ? null : { x: s.tx, z: s.tz, released: s.released };
}

/**
 * Where the boulder should land right now: the locked foe (with a bit of lead on a runner when `lead`) while they
 * are still alive, targetable, low enough and inside the throw reach; otherwise the aim line at full range.
 * Always inside the arena and between the minimum and maximum throw.
 */
function aimLanding(sim: Sim, f: Fighter, rt: AbilityRuntime, st: Hurl, lead: boolean): void {
  const s = f.state;
  const sx = s.pos.x;
  const sz = s.pos.z;
  const v = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
  let x: number;
  let z: number;
  if (
    v !== undefined &&
    v !== f &&
    v.state.alive &&
    !v.untargetable &&
    withinGroundReach(v) &&
    Math.hypot(v.state.pos.x - sx, v.state.pos.z - sz) <= K.maxThrow + K.lockSlack
  ) {
    x = v.state.pos.x;
    z = v.state.pos.z;
    if (lead) {
      const d0 = Math.hypot(x - sx, z - sz);
      const t = Math.max(K.minFlightS, d0 / K.speed);
      x += v.state.vel.x * t * K.lead;
      z += v.state.vel.z * t * K.lead;
    }
  } else {
    const dx = Math.sin(f.intent.aimYaw);
    const dz = Math.cos(f.intent.aimYaw);
    const len = clipRayToArena(sx, sz, dx, dz, K.maxThrow);
    x = sx + dx * len;
    z = sz + dz * len;
  }
  // Keep the throw inside [minThrow, maxThrow] along the direction to the point.
  let ddx = x - sx;
  let ddz = z - sz;
  let d = Math.hypot(ddx, ddz);
  if (d < 1e-6) {
    ddx = Math.sin(s.yaw);
    ddz = Math.cos(s.yaw);
    d = 1;
  }
  const dd = clamp(d, K.minThrow, K.maxThrow);
  const len = clipRayToArena(sx, sz, ddx / d, ddz / d, dd);
  st.tx = sx + (ddx / d) * len;
  st.tz = sz + (ddz / d) * len;
}

export const gorillaUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const st = get(rt);
    // `line` targeting does not set the lock itself (only `lock` kinds do): keep the assist's foe.
    rt.lockId = target.targetId;
    st.tx = rt.px = target.to.x;
    st.tz = rt.pz = target.to.z;
    // The landing marker is drawn by the VFX module; the ground telegraph ring is intentionally negligible.
    emitCastEvents(sim, f, rt, target.to.x, target.to.z, 0.05, 0, K.windupS);
    emitUltimateTarget(sim, f, rt, target, K.windupS);
    f.ccImmuneChannel = true;
    f.state.actionDur = K.windupS + K.recoveryS;
  },

  windupDuration() {
    return K.windupS;
  },

  windupTick(sim, f, rt, dt) {
    const st = get(rt);
    f.ccImmuneChannel = true;
    aimLanding(sim, f, rt, st, true);
    const s = f.state;
    s.yaw = rotateToward(s.yaw, dirToYaw(st.tx - s.pos.x, st.tz - s.pos.z), K.turnRate * dt);
    st.emitT -= dt;
    if (st.emitT <= 0) {
      st.emitT += K.trackEmitS;
      emitUltimateStage(sim, f, rt, 0, { x: st.tx, y: groundHeightAt(st.tx, st.tz, sim.arena), z: st.tz });
    }
  },

  activate(sim, f, rt) {
    const st = get(rt);
    const s = f.state;
    aimLanding(sim, f, rt, st, true);
    st.released = true;
    // Face the throw.
    s.yaw = dirToYaw(st.tx - s.pos.x, st.tz - s.pos.z);

    // Release point: out in front of the chest, overhead.
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    const x0 = s.pos.x + fx * K.releaseForward;
    const z0 = s.pos.z + fz * K.releaseForward;
    const y0 = s.pos.y + K.releaseHeight;

    // Ballistic solve: horizontal speed fixed, vertical speed chosen so the boulder arrives at chest height over the point.
    const dx = st.tx - x0;
    const dz = st.tz - z0;
    const dist = Math.max(1, Math.hypot(dx, dz));
    const flight = Math.max(K.minFlightS, dist / K.speed);
    const yt = groundHeightAt(st.tx, st.tz, sim.arena) + K.aimHeight;
    const vy = (yt - y0 + 0.5 * K.gravity * flight * flight) / flight;
    const ownerId = f.id;
    spawnProjectile(sim, {
      kind: 'boulder',
      ownerId,
      pos: { x: x0, y: y0, z: z0 },
      vel: { x: dx / flight, y: vy, z: dz / flight },
      radius: K.boulderRadius,
      gravity: K.gravity,
      maxLife: 4,
      impactRadius: K.impactRadius,
      breaksCrates: true,
      onImpact: (sm, p, hit) => land(sm, f, rt, p, hit),
    });

    emitUltimateStage(sim, f, rt, 1, { x: st.tx, y: groundHeightAt(st.tx, st.tz, sim.arena), z: st.tz });
    f.ccImmuneChannel = false; // the recovery can be punished
    toRecovery(rt);
  },

  recoveryDuration() {
    return K.recoveryS;
  },

  abort(_sim, f) {
    f.ccImmuneChannel = false;
  },
};

/** The boulder stopped: direct hit on the fighter it touched, splash on everyone else, then `ultimateStage` 2. */
function land(sim: Sim, f: Fighter, rt: AbilityRuntime, _p: ProjectileRuntime, hit: ProjectileHit): void {
  const once = new Set<number>();
  let any = false;
  // The shock spreads from the struck body when there is one, else from where the boulder stopped.
  let cx = hit.pos.x;
  let cz = hit.pos.z;
  if (hit.kind === 'fighter' && hit.fighterId >= 0) {
    const v = sim.fighters[hit.fighterId];
    if (v !== undefined) {
      cx = v.state.pos.x;
      cz = v.state.pos.z;
    }
    if (v !== undefined && v.state.alive) {
      once.add(v.id);
      const res = dealDamage(sim, f, v, K.damage, ultOpts('none'));
      if (res.hit) {
        any = true;
        if (!res.blocked) applyEffect(sim, f, v, { kind: 'stagger', mag: 0, dur: K.staggerS });
      }
    }
  }
  if (hit.kind !== 'expired') {
    const splash = hitArea(sim, f, {
      shape: 'circle',
      cx,
      cz,
      cy: groundHeightAt(cx, cz, sim.arena),
      yaw: f.state.yaw,
      range: K.impactRadius,
      arcDeg: 360,
      heightTol: AOE_HEIGHT,
      base: K.splashDamage,
      opts: ultOpts('none'),
      once,
    });
    any = any || splash;
  }
  rt.didHit = any;
  emitUltimateStage(sim, f, rt, 2, { x: hit.pos.x, y: hit.pos.y, z: hit.pos.z });
}
