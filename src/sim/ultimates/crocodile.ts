/**
 * Crocodile — DEATH ROLL (v1.3 rework, lock-on).
 *
 *   Windup (spec.windup)  crouch + hiss. `rt.lockId` is the locked victim; the lunge line TRACKS them
 *                         (yaw turns toward the victim at CROC.turnRate) until `commitFrac` of the windup,
 *                         then the direction is frozen (`ultimateStage` COMMIT, pos = lunge end).
 *   LUNGE   burst along the frozen line at `spec.moveSpeed` (30 m/s, ~0.25 s). The first ground-targetable
 *           foe whose body touches the croc (not hopping above `hopClearance`) is CLAMPED. Nothing
 *           touched by the end of the line (or a wall/pillar/crate) = WHIFF: a short slide, `spec.recovery` total.
 *   CLAMP   jaws shut: bite `biteDamage` (unblockable), victim seized (held + stunned), croc takes
 *           `spec.damageReduction` less damage until the toss.
 *   DRAG    the croc backs up `dragDist` with the victim in its jaws.
 *   ROLL    `spec.hits` (3) full revolutions over `spec.duration`; one `ultimateStage` per revolution.
 *           The victim is position-slaved to the jaws and orbits the croc's long axis with the roll;
 *           damage is a continuous unblockable drain (`spec.damage` - bite - toss over the roll).
 *   TOSS    victim released, `tossDamage` + `spec.knockback` m along the lunge line + short stagger.
 *   Recovery `tossRecovery` (hit) / `spec.recovery - slideT` (whiff).
 *
 * Interruption: the windup is interruptible (as before); from activation `rt.isGrab` makes the runtime
 * resist `Fighter.interrupt()` (grab resist, unchanged). Every exit path releases the victim.
 * Numbers: src/config/ultimates/crocodile.ts. All deterministic (no rng).
 */

import { clamp, dirToYaw, rotateToward } from '../../core/math';
import { CROC, CROC_STAGE, crocRollAngle } from '../../config/ultimates/crocodile';
import { dealDamage } from '../CombatSystem';
import { isGroundTargetable, altitudeOf } from '../hitbox';
import { chargeStep, clampToWall, groundHeightAt, resolveObstacles } from '../MovementSystem';
import { applyDirectionalKnockback } from '../StatusEffects';
import { CONTACT_PAD } from '../simTuning';
import type { Fighter, Sim, AbilityRuntime } from '../Fighter';
import { emitCastEvents, emitUltimateStage, emitUltimateTarget, endAbility, toRecovery } from './common';
import type { UltimateImpl } from './types';

enum Sub {
  Lunge = 0,
  Clamp = 1,
  Drag = 2,
  Roll = 3,
  Slide = 4,
}

interface CrocState {
  sub: Sub;
  /** Seconds in the current sub-phase. */
  timer: number;
  committed: boolean;
  /** Lunge line length (m) and distance flown so far. */
  lungeLen: number;
  travel: number;
  /** Victim offset (world, relative to the croc) at contact. */
  relX: number;
  relZ: number;
  /** Victim altitude above ground at contact. */
  relY: number;
  /** Drag progress already applied (0..1 eased). */
  dragDone: number;
  /** Highest revolution beat emitted (0..hits). */
  revs: number;
  /** Roll seconds elapsed. */
  rollT: number;
}

const STATE = new WeakMap<AbilityRuntime, CrocState>();

function st(rt: AbilityRuntime): CrocState {
  let s = STATE.get(rt);
  if (s === undefined) {
    s = { sub: Sub.Lunge, timer: 0, committed: false, lungeLen: 0, travel: 0, relX: 0, relZ: 0, relY: 0, dragDone: 0, revs: 0, rollT: 0 };
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

/** The lock victim if still a valid, free target. */
function lockedVictim(sim: Sim, rt: AbilityRuntime): Fighter | null {
  const t = rt.lockId >= 0 ? sim.fighters[rt.lockId] : undefined;
  if (t === undefined || !t.state.alive || t.untargetable) return null;
  return t;
}

export const crocodileUltimate: UltimateImpl = {
  start(sim, f, rt, target) {
    const spec = rt.spec;
    // Small warning ring at the croc; the lunge line / lock reticle come from the ultimateTarget VFX.
    emitCastEvents(sim, f, rt, f.state.pos.x, f.state.pos.z, 2, 360, spec.windup);
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
      f.state.yaw = rotateToward(f.state.yaw, want, CROC.turnRate * dt);
      rt.dirX = Math.sin(f.state.yaw);
      rt.dirZ = Math.cos(f.state.yaw);
    }
    if (rt.t + dt >= spec.windup * CROC.commitFrac) {
      s.committed = true;
      let len = (spec.range ?? 7) + CROC.overshoot;
      if (v !== null) {
        const d = Math.hypot(v.state.pos.x - f.state.pos.x, v.state.pos.z - f.state.pos.z);
        len = clamp(d + 1.6, 3, len);
      }
      s.lungeLen = len;
      emitUltimateStage(sim, f, rt, CROC_STAGE.COMMIT, {
        x: f.state.pos.x + rt.dirX * len,
        y: groundHeightAt(f.state.pos.x + rt.dirX * len, f.state.pos.z + rt.dirZ * len, sim.arena),
        z: f.state.pos.z + rt.dirZ * len,
      });
    }
  },

  activate(sim, f, rt) {
    const s = st(rt);
    // Grab resist from here on (Fighter.interrupt() leaves grab runtimes alone).
    rt.isGrab = true;
    rt.didHit = false;
    rt.targetId = -1;
    s.sub = Sub.Lunge;
    s.timer = 0;
    s.travel = 0;
    if (!s.committed) {
      // Windup shorter than the commit point (never with the shipped spec): freeze now.
      s.committed = true;
      s.lungeLen = (rt.spec.range ?? 7) + CROC.overshoot;
    }
    f.state.vel.x = rt.dirX * (rt.spec.moveSpeed ?? 30);
    f.state.vel.z = rt.dirZ * (rt.spec.moveSpeed ?? 30);
    setDur(f, s.lungeLen / (rt.spec.moveSpeed ?? 30) + 0.5);
    emitUltimateStage(sim, f, rt, CROC_STAGE.LUNGE, {
      x: f.state.pos.x + rt.dirX * s.lungeLen,
      y: f.state.pos.y,
      z: f.state.pos.z + rt.dirZ * s.lungeLen,
    });
  },

  activeTick(sim, f, rt, dt) {
    const s = st(rt);
    switch (s.sub) {
      case Sub.Lunge:
        lungeTick(sim, f, rt, s, dt);
        break;
      case Sub.Clamp:
        holdTick(sim, f, rt, s, dt, Sub.Clamp);
        break;
      case Sub.Drag:
        holdTick(sim, f, rt, s, dt, Sub.Drag);
        break;
      case Sub.Roll:
        holdTick(sim, f, rt, s, dt, Sub.Roll);
        break;
      case Sub.Slide:
        slideTick(sim, f, rt, s, dt);
        break;
    }
  },

  recoveryDuration(rt) {
    return rt.didHit ? CROC.tossRecovery : Math.max(0.1, (rt.spec.recovery ?? 1) - CROC.slideT);
  },

  abort(sim, f, rt) {
    releaseVictim(sim, f, rt);
  },
};

// ── Lunge ────────────────────────────────────────────────────────────────────

function lungeTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: CrocState, dt: number): void {
  const speed = rt.spec.moveSpeed ?? 30;
  const step = Math.min(speed * dt, s.lungeLen - s.travel);
  const res = step > 0 ? chargeStep(sim, f, step, false) : { stopped: false, hitCrate: null };
  s.travel += step;

  const hit = findContact(sim, f, rt);
  if (hit !== null) {
    beginClamp(sim, f, rt, s, hit);
    return;
  }
  if (res.stopped || res.hitCrate !== null || s.travel >= s.lungeLen - 1e-6) {
    // Whiff: slide out of it.
    s.sub = Sub.Slide;
    s.timer = 0;
    f.state.vel.x = 0;
    f.state.vel.z = 0;
    setDur(f, CROC.slideT + (rt.spec.recovery ?? 1));
    emitUltimateStage(sim, f, rt, CROC_STAGE.WHIFF, { x: f.state.pos.x, y: f.state.pos.y, z: f.state.pos.z });
  }
}

/** First foe the croc's body touches this tick (the locked victim wins a tie). */
function findContact(sim: Sim, f: Fighter, rt: AbilityRuntime): Fighter | null {
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (let i = 0; i < sim.fighters.length; i++) {
    const t = sim.fighters[i];
    if (t === f || !t.state.alive || !isGroundTargetable(t) || t.state.grabbedById !== -1) continue;
    if (altitudeOf(t) > CROC.hopClearance) continue; // jumped over the low lunge
    const d = Math.hypot(t.state.pos.x - f.state.pos.x, t.state.pos.z - f.state.pos.z);
    if (d > f.def.radius + t.def.radius + CONTACT_PAD + CROC.lungeReach) continue;
    const dd = t.id === rt.lockId ? d - 100 : d;
    if (dd < bestD) {
      bestD = dd;
      best = t;
    }
  }
  return best;
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

function beginClamp(sim: Sim, f: Fighter, rt: AbilityRuntime, s: CrocState, t: Fighter): void {
  seize(sim, f, t);
  rt.didHit = true;
  rt.targetId = t.id;
  rt.lockId = t.id;
  f.incomingDamageReduction = rt.spec.damageReduction ?? 0;
  s.sub = Sub.Clamp;
  s.timer = 0;
  s.relX = t.state.pos.x - f.state.pos.x;
  s.relZ = t.state.pos.z - f.state.pos.z;
  s.relY = Math.max(0, altitudeOf(t));
  f.state.vel.x = 0;
  f.state.vel.z = 0;
  setDur(f, CROC.clampT + CROC.dragT + (rt.spec.duration ?? 2.5) + CROC.tossRecovery);
  // The bite (unblockable, heavy), then the hold stun.
  dealDamage(sim, f, t, CROC.biteDamage, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
  t.staggerTimer = Math.max(t.staggerTimer, 0.3);
  emitUltimateStage(sim, f, rt, CROC_STAGE.CLAMP, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
}

// ── Hold: clamp -> drag -> roll -> toss ─────────────────────────────────────

function holdTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: CrocState, dt: number, sub: Sub): void {
  const t = rt.targetId >= 0 ? sim.fighters[rt.targetId] : undefined;
  if (t === undefined || !t.state.alive || t.state.grabbedById !== f.id) {
    // Victim died / was freed: let go and recover.
    releaseVictim(sim, f, rt);
    toRecovery(rt);
    return;
  }
  const spec = rt.spec;
  s.timer += dt;
  f.state.vel.x = 0;
  f.state.vel.z = 0;

  let blend = 1; // contact offset -> jaw point
  let lift = 0;
  let orbit = 0;
  let orbitOn = false;

  if (sub === Sub.Clamp) {
    const u = s.timer / CROC.clampT;
    blend = ease(u);
    lift = ease(u) * 0.35;
    if (s.timer >= CROC.clampT) {
      s.sub = Sub.Drag;
      s.timer = 0;
      s.dragDone = 0;
      emitUltimateStage(sim, f, rt, CROC_STAGE.DRAG, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
    }
  } else if (sub === Sub.Drag) {
    const u = clamp(s.timer / CROC.dragT, 0, 1);
    const e = ease(u);
    const delta = (e - s.dragDone) * CROC.dragDist;
    s.dragDone = e;
    f.state.pos.x -= rt.dirX * delta;
    f.state.pos.z -= rt.dirZ * delta;
    resolveObstacles(sim, f, false);
    clampToWall(f);
    f.state.vel.x = (-rt.dirX * delta) / Math.max(dt, 1e-6);
    f.state.vel.z = (-rt.dirZ * delta) / Math.max(dt, 1e-6);
    lift = 0.35;
    if (s.timer >= CROC.dragT) {
      s.sub = Sub.Roll;
      s.timer = 0;
      s.rollT = 0;
      s.revs = 1;
      f.state.vel.x = 0;
      f.state.vel.z = 0;
      emitUltimateStage(sim, f, rt, CROC_STAGE.ROLL1, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
    }
  } else {
    // Roll.
    const dur = spec.duration ?? 2.5;
    const hits = spec.hits ?? 3;
    s.rollT += dt;
    const u = clamp(s.rollT / dur, 0, 1);
    orbit = crocRollAngle(u, hits);
    orbitOn = true;
    lift = CROC.orbitLift;
    // Continuous unblockable drain over the roll.
    const drain = Math.max(0, (spec.damage ?? 300) - CROC.biteDamage - CROC.tossDamage);
    sim.applyBleedDamage(f, t, (drain / dur) * dt);
    // One beat per revolution.
    const rev = Math.min(hits, 1 + Math.floor(s.rollT / (dur / hits)));
    while (s.revs < rev && s.revs < hits) {
      s.revs += 1;
      emitUltimateStage(sim, f, rt, CROC_STAGE.ROLL1 + s.revs - 1, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
    }
  }

  slaveVictim(f, rt, s, t, blend, lift, orbit, orbitOn, dt);
  t.staggerTimer = Math.max(t.staggerTimer, 0.25);
  t.movementOwned = true;
  t.state.action = 'grabbed';

  if (t.state.alive && s.sub === Sub.Roll && s.rollT >= (spec.duration ?? 2.5)) toss(sim, f, rt, s, t);
}

/** Put the victim at the jaws (plus the roll orbit). */
function slaveVictim(f: Fighter, rt: AbilityRuntime, s: CrocState, t: Fighter, blend: number, lift: number, orbit: number, orbitOn: boolean, dt: number): void {
  const reach = f.def.radius + 0.75 + t.def.radius * 0.55; // snout tip + a bite into the body
  const jawX = rt.dirX * reach;
  const jawZ = rt.dirZ * reach;
  let ox = 0;
  let oz = 0;
  let oy = 0;
  if (orbitOn) {
    // Orbit the long axis: horizontal swing across the body, vertical heave.
    const px = rt.dirZ;
    const pz = -rt.dirX;
    ox = px * Math.cos(orbit) * CROC.orbitR;
    oz = pz * Math.cos(orbit) * CROC.orbitR;
    oy = Math.sin(orbit) * CROC.orbitR * 0.7;
  }
  const rx = s.relX + (jawX - s.relX) * blend + ox;
  const rz = s.relZ + (jawZ - s.relZ) * blend + oz;
  t.state.pos.x = f.state.pos.x + rx;
  t.state.pos.z = f.state.pos.z + rz;
  const gy = groundHeightAt(t.state.pos.x, t.state.pos.z, t.arena);
  const baseLift = s.relY * (1 - blend) + lift;
  t.state.pos.y = gy + Math.max(0, baseLift + oy);
  t.state.yaw = rotateToward(t.state.yaw, dirToYaw(-rt.dirX, -rt.dirZ), 9 * dt);
  clampToWall(t);
}

function toss(sim: Sim, f: Fighter, rt: AbilityRuntime, s: CrocState, t: Fighter): void {
  const spec = rt.spec;
  releaseVictim(sim, f, rt);
  // Drop to the ground first so the knockback slides along it.
  t.state.pos.y = groundHeightAt(t.state.pos.x, t.state.pos.z, sim.arena);
  t.staggerTimer = 0; // the toss hit is not amplified by the hold stun
  dealDamage(sim, f, t, CROC.tossDamage, { blockable: false, heavy: true, reaction: 'none', isBasic: false, allowBackstab: false });
  if (t.state.alive) {
    t.staggerTimer = Math.max(t.staggerTimer, CROC.tossStagger);
    applyDirectionalKnockback(t, rt.dirX, rt.dirZ, spec.knockback ?? 3);
  }
  emitUltimateStage(sim, f, rt, CROC_STAGE.TOSS, { x: t.state.pos.x, y: t.state.pos.y, z: t.state.pos.z });
  s.sub = Sub.Slide; // inert; the runtime goes to recovery now
  setDur(f, CROC.tossRecovery);
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
  f.state.vel.x = 0;
  f.state.vel.z = 0;
}

// ── Whiff slide ──────────────────────────────────────────────────────────────

function slideTick(sim: Sim, f: Fighter, rt: AbilityRuntime, s: CrocState, dt: number): void {
  s.timer += dt;
  const u = clamp(s.timer / CROC.slideT, 0, 1);
  const v = CROC.slideSpeed * (1 - u) * (1 - u);
  chargeStep(sim, f, v * dt, false);
  f.state.vel.x = rt.dirX * v;
  f.state.vel.z = rt.dirZ * v;
  if (s.timer >= CROC.slideT) {
    f.state.vel.x = 0;
    f.state.vel.z = 0;
    toRecovery(rt);
  }
}
